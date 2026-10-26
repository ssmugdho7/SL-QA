import type { CaseContext } from '../context.js';
import { pageInfo } from '../pages.js';
import { ACTION_EXPECTS, ACTION_RULES, remembered } from '../phrases/actions.js';
import type { ExpectRule } from '../phrases/expects.js';
import type { StepRule } from '../phrases/steps.js';
import { visionAvailable, type ChainOptions } from './providers.js';
import { aiProvider, keyOf, pageKeyOf, pageOf, loadTranslations, saveTranslations, translate, type Kind, type Translation } from './translate.js';

/**
 * Live AI help while a case runs, used only when the rules could not do a step:
 *  - "understand": a sentence no rule reads → the AI rewrites it into the step language and the bot runs it at once;
 *  - "recover": a step that failed on the page → the AI sees what is on screen and suggests a corrected version, which
 *    the bot tries (Claude 1–2 times, see repairTries, then once more with the fallback providers).
 * Every AI decision is labelled in the report and saved as a suggestion, so a person can approve it for next time
 * (approved rewrites then run without the AI). The AI never decides whether a check passed.
 *
 * Turned off with AI_LIVE=off in .env (the review flow still works).
 */

export const liveEnabled = () => !!aiProvider() && !/^(off|0|false|no)$/i.test(process.env.AI_LIVE ?? '');

/** At most this many AI calls per case, so one confusing case cannot use up a free quota. */
const PER_CASE = Number(process.env.AI_MAX_CALLS_PER_CASE ?? 12);
/**
 * At most this much time waiting for AI per case, so AI help can never run a case past CASE_TIMEOUT_SECONDS
 * (one call can take up to ~20 s per free provider, more when it falls through to a paid one).
 */
const AI_SECONDS = Number(process.env.AI_MAX_SECONDS_PER_CASE ?? Math.min(240, Math.max(30, Number(process.env.CASE_TIMEOUT_SECONDS ?? 600) * 0.4)));

export interface Resolved<T> { lines: { text: string; rule: T }[]; note: string; model: string; provider?: string }

/** Steps and expected results each have their own allowance, so a hard step cannot use up the checks' share. */
function budget(t: CaseContext, kind: Kind = 'step'): boolean {
  const key = kind === 'expect' ? '__aiCallsExpect' : '__aiCalls';
  const used = (t.noted.get(key) as number | undefined) ?? 0;
  const spent = (t.noted.get('__aiMs') as number | undefined) ?? 0;
  if (spent >= AI_SECONDS * 1000) {
    if (!t.noted.get('__aiTimeNoted')) {
      t.note(`AI help stopped after ${Math.round(spent / 1000)}s of AI time for this case (limit ${AI_SECONDS}s, AI_MAX_SECONDS_PER_CASE), so the case finishes in time.`);
      t.noted.set('__aiTimeNoted', true);
    }
    return false;
  }
  if (used >= PER_CASE) {
    if (!t.noted.get('__aiBudgetNoted')) {
      t.note(`AI help stopped after ${PER_CASE} calls for this case (AI_MAX_CALLS_PER_CASE).`);
      t.noted.set('__aiBudgetNoted', true);
    }
    return false;
  }
  t.noted.set(key, used + 1);
  return true;
}

/** Saves an AI answer as a suggestion (never overwriting one a person already reviewed). */
function remember(tr: Translation, page: string): void {
  const all = loadTranslations();
  // New live suggestions are kept per page ("Click 'Save'" means different things on different pages).
  const key = pageOf(page) ? pageKeyOf(tr.kind, page, tr.source) : keyOf(tr.kind, tr.source);
  // Never shadow what a person already reviewed, under either key.
  if ([key, keyOf(tr.kind, tr.source)].some((k) => all[k] && all[k].status !== 'suggested')) return;
  all[key] = tr;
  saveTranslations(all);
}

/** What a person would see right now: headings, buttons, field labels, open dialog, errors, messages. Kept short. */
export async function pageSummary(t: CaseContext): Promise<string> {
  const live = await t.page.evaluate(() => {
    const v = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const uniq = (xs: string[], n: number) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 60))].slice(0, n);
    const dialog = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(v).at(-1) as HTMLElement | undefined;
    const root = (dialog ?? document.querySelector('main') ?? document.body) as HTMLElement;
    const name = (e: Element) => (e as HTMLElement).innerText || e.getAttribute('aria-label') || '';
    const text = (sel: string) => [...root.querySelectorAll(sel)].filter(v).map(name);
    const fields = [...root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea,select,[role=combobox]')].filter(v).map((el) => {
      const i = el as HTMLInputElement;
      let label = i.labels?.[0]?.innerText ?? i.getAttribute('aria-label') ?? i.placeholder ?? '';
      if (!label) { let c: HTMLElement | null = i.parentElement; for (let k = 0; k < 3 && c && !label; k++) { label = c.querySelector('label')?.innerText ?? ''; c = c.parentElement; } }
      return label;
    });
    // Disabled controls: the AI must not plan to click them, and "should be disabled" checks need them.
    const disabled = uniq([...root.querySelectorAll('button:disabled, [aria-disabled=true]')].filter(v).map(name), 15);
    // An open dropdown / menu: its choices are what SELECT and CLICK can pick.
    const options = uniq([...document.querySelectorAll('[role=listbox] [role=option], [role=menu] [role=menuitem], [role=menu] [role=menuitemradio], [cmdk-item]')].filter(v).map(name), 30);
    // Field errors shown next to inputs (red helper texts) and alerts.
    // Only texts tied to a field or announced as alerts (red badges in a list, e.g. "Out of stock", are not errors).
    const near = (e: Element) => !!e.closest('form, [role=dialog], fieldset') || !!e.parentElement?.querySelector('input, textarea, select, [role=combobox]');
    const errors = uniq([
      ...[...root.querySelectorAll('[role=alert], [aria-live=assertive], [id$=-form-item-message], [data-error]')].filter(v),
      ...[...root.querySelectorAll('p.text-destructive, p.text-red-500, p.text-red-600, span.text-destructive, small')].filter((e) => v(e) && near(e) && !e.closest('tbody, article')),
      ...[...root.querySelectorAll('[aria-invalid=true]')].filter(v).map((i) => document.getElementById(i.getAttribute('aria-describedby') ?? '') ?? i).filter((e) => e.tagName !== 'INPUT'),
    ].map(name), 10);
    // List/grid rows: the first few records and the buttons inside one of them (row actions are often icon buttons with labels).
    const rows = [...root.querySelectorAll('tbody tr, article')].filter(v).slice(0, 6) as HTMLElement[];
    const rowNames = rows.map((r) => (r.querySelector('a, h3, h4, [title]') as HTMLElement | null)?.innerText ?? r.innerText.split('\n').find((l) => l.trim().length > 3) ?? '').map((x) => x.trim()).filter(Boolean);
    const rowButtons = rows[0] ? uniq([...rows[0].querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || (b as HTMLElement).innerText), 14) : [];
    const sidebar = uniq([...document.querySelectorAll('nav a, aside a')].filter(v).map((a) => (a as HTMLElement).innerText), 40);
    const count = (document.querySelector('main')?.textContent ?? '').match(/Showing\s*\d+\s*[–-]\s*\d+\s*of\s*\d+/)?.[0];
    // "Label: value" pairs a person reads on screen (cards, detail rows), so checks use the real labels.
    const pairs: string[] = [];
    for (const el of [...root.querySelectorAll('*')].filter((e) => v(e) && e.children.length === 0)) {
      const label = (el as HTMLElement).innerText?.trim() ?? '';
      if (!label || label.length > 30 || /\d{3,}/.test(label)) continue;
      const next = (el.nextElementSibling as HTMLElement | null)?.innerText?.trim() ?? (el.parentElement?.nextElementSibling as HTMLElement | null)?.innerText?.trim() ?? '';
      if (next && next.length < 30 && /\d|—|yes|no/i.test(next) && next !== label) pairs.push(`${label}: ${next.split('\n')[0]}`);
      if (pairs.length > 30) break;
    }
    return [
      `URL: ${location.pathname}${location.search}`,
      dialog ? `Open dialog: ${(dialog.innerText.split('\n')[0] ?? '').slice(0, 60)}` : '',
      `Headings: ${uniq(text('h1,h2,h3'), 8).join(' | ')}`,
      `Buttons/links on the page: ${uniq([...text('button'), ...text('a[href]'), ...text('[role=tab]'), ...text('[role=menuitem]')].filter((x) => !sidebar.includes(x.trim())), 45).join(' | ')}`,
      disabled.length ? `Disabled (cannot be clicked now): ${disabled.join(' | ')}` : '',
      options.length ? `Open dropdown / menu choices: ${options.join(' | ')}` : '',
      `Fields: ${uniq(fields, 25).join(' | ')}`,
      errors.length ? `Error texts shown: ${errors.join(' | ')}` : '',
      count ? `List count: ${count}` : '',
      rowNames.length ? `First records in the list: ${uniq(rowNames, 6).join(' | ')}` : '',
      rowButtons.length ? `Buttons inside each record row: ${rowButtons.join(' | ')}` : '',
      pairs.length ? `Labelled values: ${uniq(pairs, 30).join(' | ')}` : '',
      `Tabs on the page: ${uniq(text('[role=tab]'), 12).join(' | ')}`,
      `Sidebar menu (other pages): ${sidebar.slice(0, 30).join(' | ')}`,
    ].filter(Boolean).join('\n');
  }).catch(() => `URL: ${t.page.url()}`);
  const toasts = t.toasts.slice(-4);
  return [live, toasts.length ? `Pop-up messages seen during the case (latest last): ${toasts.map((x) => x.slice(0, 100)).join(' | ')}` : '', siteKnowledge(t.page.url())].filter(Boolean).join('\n');
}

/** What the site crawl knows about this page (tabs, buttons, fields, columns), including parts not on screen right now. */
function siteKnowledge(url: string): string {
  const p = (() => { try { return pageInfo(url); } catch { return null; } })();
  if (!p) return '';
  const list = (label: string, xs: string[] | undefined, n = 20) => (xs?.length ? `${label}: ${xs.slice(0, n).join(' | ')}` : '');
  return [
    `From the site map of this page (${p.group ? `${p.group} › ` : ''}${p.label || p.title}; may differ from now):`,
    list('  tabs', p.tabs), list('  sections', p.sections), list('  buttons', p.buttons, 25), list('  fields', p.fields), list('  columns', p.columns), list('  filters', p.filters),
    p.search ? `  search box: ${p.search}` : '',
  ].filter(Boolean).join('\n');
}

/** A small JPEG of the page (max 1280 px wide, quality 50) for providers that read images; undefined otherwise. */
async function screenshot(t: CaseContext): Promise<string | undefined> {
  if (!visionAvailable()) return undefined;
  const buf = await t.page.screenshot({ type: 'jpeg', quality: 50, timeout: 5_000 }).catch(() => null);
  if (!buf) return undefined;
  // The dashboard viewport is 1440 px: scale down in the page itself (no image library needed).
  const small = await t.page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${b64}`;
    await img.decode();
    if (img.width <= 1280) return b64;
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = Math.round((img.height * 1280) / img.width);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.5).split(',')[1];
  }, buf.toString('base64')).catch(() => buf.toString('base64'));
  return small;
}

function mapLines<T>(lines: string[], table: T extends StepRule ? StepRule[] : ExpectRule[]): { text: string; rule: T }[] {
  return lines.map((l) => ({ text: l, rule: (table as { pattern: RegExp }[]).find((r) => r.pattern.test(l)) as T | undefined })).filter((x): x is { text: string; rule: T } => !!x.rule);
}

async function ask(t: CaseContext, kind: Kind, source: string, extra: string, opts: { save?: boolean; image?: boolean; ask?: string; chain?: ChainOptions } = {}): Promise<Translation | null> {
  if (!liveEnabled() || !budget(t, kind)) return null;
  const tc = t.tc;
  const started = Date.now();
  try {
    const tr = await translate(kind, source, {
      page: `${new URL(t.page.url()).pathname}\n${extra}`,
      title: tc.title,
      steps: tc.steps,
      expected: tc.expected,
      preconditions: tc.preconditions,
      testData: tc.testData,
      image: opts.image === false ? undefined : await screenshot(t),
      ask: opts.ask,
      chain: opts.chain,
    });
    // Only lines this kind can run are kept (a step answer sometimes adds EXPECT lines, which steps never run).
    const usable = (l: string) => ACTION_RULES.some((r) => r.pattern.test(l)) || (kind === 'expect' && ACTION_EXPECTS.some((r) => r.pattern.test(l)));
    let keepLines = tr?.lines.filter(usable) ?? [];
    // A check comparing with a REMEMBERed name is saved with the REMEMBER line that made it, so an approved rewrite
    // reads the value before the steps by itself (no AI needed next time).
    const used = remembered(t).filter((v) => keepLines.some((l) => new RegExp(`(?:=|>|<)\\s*${v.name}\\b`, 'i').test(l)));
    if (kind === 'expect') keepLines = [...used.map((v) => (v.label === '__count' ? `REMEMBER COUNT AS ${v.name}` : `REMEMBER VALUE '${v.label}' AS ${v.name}`)), ...keepLines];
    // A rewrite naming this run's test product is specific to this run; keep it out of the reusable list.
    // Keyed by the case's start page: the page a preview looks it up by (tc.url).
    if (tr && opts.save !== false && !keepLines.some((l) => /BTB [A-Z]+-\d+/.test(l)) && (keepLines.length || !tr.lines.length)) remember({ ...tr, lines: keepLines }, t.startPath);
    return tr;
  } catch (e) {
    t.note(`AI help was not available: ${(e as Error).message.slice(0, 180)}`);
    return null;
  } finally {
    t.noted.set('__aiMs', ((t.noted.get('__aiMs') as number | undefined) ?? 0) + Date.now() - started);
  }
}

/**
 * Cases that change products (status, price, stock, channels, edit, delete) get a test product of their own, named
 * BTB <case>, so AI-driven steps never touch real products. The AI is told to use it.
 */
async function testProduct(t: CaseContext): Promise<string | null> {
  const cached = t.noted.get('__aiTestProduct') as string | undefined;
  if (cached !== undefined) return cached || null;
  const text = [t.tc.title, t.tc.preconditions, ...t.tc.steps, ...t.tc.expected].join(' ');
  const changes = /\b(turn|switch|toggle|status|price|stock|adjust|channel|edit|update|change|delete|archive|duplicate|save|stock in|stock out|barcode)\b/i.test(text)
    && /\bproduct\b/i.test(text) && !/\b(add product|create (?:a |another )?product|new product)\b/i.test(t.tc.steps.join(' '));
  if (!changes) {
    t.noted.set('__aiTestProduct', '');
    return null;
  }
  const variable = /variant|variable|weight/i.test(text);
  const p = await t.fixtureProduct('AI test item', variable
    ? { product_type: 'variable', price: null, variant_axes: ['Weight'], variants: [{ name: '50g', attributes: { Weight: '50g' }, price: 70, stock: 6 }, { name: '100g', attributes: { Weight: '100g' }, price: 140, stock: 4 }] }
    : { price: 120, current_stock: 6 }).catch(() => null);
  t.noted.set('__aiTestProduct', p?.name ?? '');
  if (p) t.note(`AI-driven steps use the test product '${p.name}' (archived afterwards), so no real product is changed.`);
  return p?.name ?? null;
}

export async function prepareAiProduct(t: CaseContext): Promise<void> {
  await testProduct(t);
}

async function productHint(t: CaseContext): Promise<string> {
  const name = await testProduct(t);
  return name ? `\nIMPORTANT: when the case says "a product", "any product" or names an example product, use the test product '${name}' (search for it if it is not visible; it can be opened from its row). Never change any other product.` : '';
}

/** A step sentence no rule understands → runnable lines, or null. */
export async function understandStep(t: CaseContext, sentence: string): Promise<Resolved<StepRule> | null> {
  const tr = await ask(t, 'step', sentence, `What is on the page now:\n${await pageSummary(t)}${await productHint(t)}${namesHint(t)}`);
  if (!tr) return null;
  return { lines: mapLines<StepRule>(tr.lines, ACTION_RULES as never), note: tr.note, model: tr.model };
}

/**
 * A step that failed on the page → corrected lines to try, or null. `tried` holds earlier corrections for the same
 * action and how each failed, so the next try does not repeat them.
 */
export async function recoverStep(t: CaseContext, action: string, error: string, ctx: { sentence: string; later: string[]; tried?: { lines: string[]; error: string }[]; chain?: ChainOptions }): Promise<Resolved<StepRule> | null> {
  const before = (ctx.tried ?? []).map((x, i) => `\nCorrection ${i + 1} you gave: ${x.lines.join(' → ')}\nIt also FAILED: ${x.error.slice(0, 300)}`).join('');
  const tr = await ask(t, 'step', action, `This action comes from the test step "${ctx.sentence}".
The robot tried it and it FAILED: ${error.slice(0, 400)}${before}${before ? '\nDo NOT repeat a correction that failed; try a different way, or return no lines if it cannot work.' : ''}
(When the error lists what was found, pick the closest real choice from that list; test data from the sheet may not exist in this store, e.g. a variant '80g' or a second warehouse. If nothing fits, return no lines and say what is missing.)
Rewrite ONLY this one action so it works on the page as it is now, using the names actually shown below. If it needs something first (open a dialog, switch a tab, open a section), include that. Do not repeat earlier actions${ctx.later.length ? ` and do not include the actions that come after it (${ctx.later.join(' · ')})` : ''}.
What is on the page now:\n${await pageSummary(t)}${await productHint(t)}${namesHint(t)}`, { save: false, chain: ctx.chain });
  if (!tr) return null;
  // Not stored as the sentence's general rewrite: it is specific to this failure.
  return { lines: mapLines<StepRule>(tr.lines, ACTION_RULES as never), note: tr.note, model: tr.model, provider: tr.provider };
}

/**
 * How many corrections Claude gets for a failed action: 2 when it is complex (its sentence has several clauses, it
 * works inside a section/dialog, selects or uploads, or the error lists several found elements), else 1.
 * AI_REPAIR_TRIES, when set, caps it (0 = fallback try only).
 */
export function repairTries(action: string, error = '', clauses = 1): number {
  const complex = clauses > 1 || /\bIN\s+'|\bdialog\b|^\s*(?:SELECT|UPLOAD)\b/i.test(action) || /resolved to|found:/i.test(error);
  const cap = Number(process.env.AI_REPAIR_TRIES);
  return Math.min(complex ? 2 : 1, process.env.AI_REPAIR_TRIES?.trim() && cap >= 0 ? cap : 2);
}

/** The fallback chain for the last repair try: every provider except Claude. */
export const FALLBACK_CHAIN: ChainOptions = { exclude: ['anthropic'] };
/** Claude only, for the first repair tries. */
export const PRIMARY_CHAIN: ChainOptions = { only: ['anthropic'] };

/** "Remembered values: stock = 13 (On Hand), n = 57 (list count)" for the AI, so before/after checks use them. */
function namesHint(t: CaseContext): string {
  const vars = remembered(t);
  return vars.length ? `\nRemembered values (from before the steps; compare with these names): ${vars.map((v) => `${v.name} = ${v.raw} (${v.label === '__count' ? 'list count' : `'${v.label}'`})`).join(', ')}` : '';
}

/** A claim about a change ("should increase by 2", "goes down", "stays the same") needs a value read before the steps. */
export const CHANGE_CLAIM = /\b(?:increase[sd]?|decrease[sd]?|go(?:es)? (?:up|down)|went (?:up|down)|reduc(?:e[sd]?|ing)|deduct(?:ed)?|add(?:ed)? to|subtract(?:ed)?|grow|drops?|rises?|(?:should|must|will) (?:be )?(?:change|update)[sd]?|(?:stays?|remains?) (?:the same|unchanged)|(?:not|n't) change|by \d+|fewer|more than before|less than before|(?:one|1) (?:more|less))\b/i;

/**
 * Before the steps run: which values must be read now so the change claims can be checked after them.
 * Returns REMEMBER lines (with an optional STEP line that shows the value first), or null.
 */
export async function planRemember(t: CaseContext, claims: string[]): Promise<{ lines: { text: string; rule: StepRule }[]; note: string; model: string } | null> {
  const list = claims.map((c) => `- ${c}`).join('\n');
  const tr = await ask(t, 'expect', claims.join(' / '), `What is on the page now (BEFORE the steps run):\n${await pageSummary(t)}`, {
    save: false,
    ask: `These EXPECTED RESULTS are about a change, so their starting values must be read now, before the steps run:
${list}
Reply with REMEMBER lines only (REMEMBER VALUE '<label exactly as shown>' AS <short_name> or REMEMBER COUNT AS <short_name>), one per value that will change; use labels from "Labelled values" or "List count". If a value is on another tab or section of this page, put the CLICK line that shows it first. Do not write the steps of the case. If nothing on this page can be read for them, return no lines and say why.`,
  });
  if (!tr) return null;
  const lines = mapLines<StepRule>(tr.lines, ACTION_RULES as never).filter((l) => /^(?:REMEMBER|CLICK|SCROLL TO)\b/i.test(l.text));
  return { lines, note: tr.note, model: tr.model };
}

/** An expected result no rule or page check understands → lines to show the right place (optional) and EXPECT checks. */
export async function understandExpect(t: CaseContext, claim: string): Promise<{ lines: ({ text: string; check: ExpectRule } | { text: string; step: StepRule })[]; note: string; model: string } | null> {
  const tr = await ask(t, 'expect', claim, `What is on the page now (after the steps):\n${await pageSummary(t)}${namesHint(t)}`);
  if (!tr) return null;
  const lines = tr.lines.map((l) => {
    const check = ACTION_EXPECTS.find((r) => r.pattern.test(l));
    if (check) return { text: l, check };
    const step = ACTION_RULES.find((r) => r.pattern.test(l));
    return step ? { text: l, step } : null;
  }).filter((x): x is { text: string; check: ExpectRule } | { text: string; step: StepRule } => !!x);
  return { lines, note: tr.note, model: tr.model };
}
