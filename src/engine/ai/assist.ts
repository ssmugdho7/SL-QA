import type { CaseContext } from '../context.js';
import { ACTION_EXPECTS, ACTION_RULES } from '../phrases/actions.js';
import type { ExpectRule } from '../phrases/expects.js';
import type { StepRule } from '../phrases/steps.js';
import { aiProvider, keyOf, loadTranslations, saveTranslations, translate, type Kind, type Translation } from './translate.js';

/**
 * Live AI help while a case runs, used only when the rules could not do a step:
 *  - "understand": a sentence no rule reads → the AI rewrites it into the step language and the bot runs it at once;
 *  - "recover": a step that failed on the page → the AI sees what is on screen and suggests a corrected version, which
 *    the bot tries once.
 * Every AI decision is labelled in the report and saved as a suggestion, so a person can approve it for next time
 * (approved rewrites then run without the AI). The AI never decides whether a check passed.
 *
 * Turned off with AI_LIVE=off in .env (the review flow still works).
 */

export const liveEnabled = () => !!aiProvider() && !/^(off|0|false|no)$/i.test(process.env.AI_LIVE ?? '');

/** At most this many AI calls per case, so one confusing case cannot use up a free quota. */
const PER_CASE = Number(process.env.AI_MAX_CALLS_PER_CASE ?? 12);

export interface Resolved<T> { lines: { text: string; rule: T }[]; note: string; model: string }

/** Steps and expected results each have their own allowance, so a hard step cannot use up the checks' share. */
function budget(t: CaseContext, kind: Kind = 'step'): boolean {
  const key = kind === 'expect' ? '__aiCallsExpect' : '__aiCalls';
  const used = (t.noted.get(key) as number | undefined) ?? 0;
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
function remember(tr: Translation): void {
  const all = loadTranslations();
  const key = keyOf(tr.kind, tr.source);
  if (all[key] && all[key].status !== 'suggested') return;
  all[key] = tr;
  saveTranslations(all);
}

/** What a person would see right now: headings, buttons, field labels, open dialog. Kept short. */
export async function pageSummary(t: CaseContext): Promise<string> {
  return t.page.evaluate(() => {
    const v = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const uniq = (xs: string[], n: number) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 60))].slice(0, n);
    const dialog = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(v).at(-1) as HTMLElement | undefined;
    const root = (dialog ?? document.querySelector('main') ?? document.body) as HTMLElement;
    const text = (sel: string) => [...root.querySelectorAll(sel)].filter(v).map((e) => (e as HTMLElement).innerText || e.getAttribute('aria-label') || '');
    const fields = [...root.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea,select,[role=combobox]')].filter(v).map((el) => {
      const i = el as HTMLInputElement;
      let label = i.labels?.[0]?.innerText ?? i.getAttribute('aria-label') ?? i.placeholder ?? '';
      if (!label) { let c: HTMLElement | null = i.parentElement; for (let k = 0; k < 3 && c && !label; k++) { label = c.querySelector('label')?.innerText ?? ''; c = c.parentElement; } }
      return label;
    });
    // List/grid rows: the first few records and the buttons inside one of them (row actions are often icon buttons with labels).
    const rows = [...root.querySelectorAll('tbody tr, article')].filter(v).slice(0, 6) as HTMLElement[];
    const rowNames = rows.map((r) => (r.querySelector('a, h3, h4, [title]') as HTMLElement | null)?.innerText ?? r.innerText.split('\n').find((l) => l.trim().length > 3) ?? '').map((x) => x.trim()).filter(Boolean);
    const rowButtons = rows[0] ? uniq([...rows[0].querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || (b as HTMLElement).innerText), 14) : [];
    const sidebar = uniq([...document.querySelectorAll('nav a, aside a')].filter(v).map((a) => (a as HTMLElement).innerText), 40);
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
      `Fields: ${uniq(fields, 25).join(' | ')}`,
      rowNames.length ? `First records in the list: ${uniq(rowNames, 6).join(' | ')}` : '',
      rowButtons.length ? `Buttons inside each record row: ${rowButtons.join(' | ')}` : '',
      pairs.length ? `Labelled values: ${uniq(pairs, 30).join(' | ')}` : '',
      `Tabs on the page: ${uniq(text('[role=tab]'), 12).join(' | ')}`,
      `Sidebar menu (other pages): ${sidebar.slice(0, 30).join(' | ')}`,
    ].filter(Boolean).join('\n');
  }).catch(() => `URL: ${t.page.url()}`);
}

function mapLines<T>(lines: string[], table: T extends StepRule ? StepRule[] : ExpectRule[]): { text: string; rule: T }[] {
  return lines.map((l) => ({ text: l, rule: (table as { pattern: RegExp }[]).find((r) => r.pattern.test(l)) as T | undefined })).filter((x): x is { text: string; rule: T } => !!x.rule);
}

async function ask(t: CaseContext, kind: Kind, source: string, extra: string, save = true): Promise<Translation | null> {
  if (!liveEnabled() || !budget(t, kind)) return null;
  const tc = t.tc;
  try {
    const tr = await translate(kind, source, {
      page: `${new URL(t.page.url()).pathname}\n${extra}`,
      title: tc.title,
      steps: tc.steps,
      expected: tc.expected,
      preconditions: tc.preconditions,
      testData: tc.testData,
    });
    // A rewrite naming this run's test product is specific to this run; keep it out of the reusable list.
    if (tr && save && !tr.lines.some((l) => /BTB [A-Z]+-\d+/.test(l))) remember(tr);
    return tr;
  } catch (e) {
    t.note(`AI help was not available: ${(e as Error).message.slice(0, 180)}`);
    return null;
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
  const tr = await ask(t, 'step', sentence, `What is on the page now:\n${await pageSummary(t)}${await productHint(t)}`);
  if (!tr) return null;
  return { lines: mapLines<StepRule>(tr.lines, ACTION_RULES as never), note: tr.note, model: tr.model };
}

/** A step that failed on the page → corrected lines to try once, or null. */
export async function recoverStep(t: CaseContext, action: string, error: string, ctx: { sentence: string; later: string[] }): Promise<Resolved<StepRule> | null> {
  const tr = await ask(t, 'step', action, `This action comes from the test step "${ctx.sentence}".
The robot tried it and it FAILED: ${error.slice(0, 400)}
(When the error lists what was found, pick the closest real choice from that list; test data from the sheet may not exist in this store, e.g. a variant '80g' or a second warehouse. If nothing fits, return no lines and say what is missing.)
Rewrite ONLY this one action so it works on the page as it is now, using the names actually shown below. If it needs something first (open a dialog, switch a tab, open a section), include that. Do not repeat earlier actions${ctx.later.length ? ` and do not include the actions that come after it (${ctx.later.join(' · ')})` : ''}.
What is on the page now:\n${await pageSummary(t)}${await productHint(t)}`, false);
  if (!tr) return null;
  // Not stored as the sentence's general rewrite: it is specific to this failure.
  return { lines: mapLines<StepRule>(tr.lines, ACTION_RULES as never), note: tr.note, model: tr.model };
}

/** An expected result no rule or page check understands → lines to show the right place (optional) and EXPECT checks. */
export async function understandExpect(t: CaseContext, claim: string): Promise<{ lines: ({ text: string; check: ExpectRule } | { text: string; step: StepRule })[]; note: string; model: string } | null> {
  const tr = await ask(t, 'expect', claim, `What is on the page now (after the steps):\n${await pageSummary(t)}`);
  if (!tr) return null;
  const lines = tr.lines.map((l) => {
    const check = ACTION_EXPECTS.find((r) => r.pattern.test(l));
    if (check) return { text: l, check };
    const step = ACTION_RULES.find((r) => r.pattern.test(l));
    return step ? { text: l, step } : null;
  }).filter((x): x is { text: string; check: ExpectRule } | { text: string; step: StepRule } => !!x);
  return { lines, note: tr.note, model: tr.model };
}
