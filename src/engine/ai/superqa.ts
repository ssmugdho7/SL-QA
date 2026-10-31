import type { Page } from 'playwright';
import { config } from '../config.js';
import { startSession, type Session } from '../session.js';
import type { TestCase } from '../sources/cases.js';
import type { ChatTurn } from './chat.js';
import { redact, secrets, siteContext, SYSTEM, toCases } from './chat.js';
import { complete } from './providers.js';

/**
 * Super QA: a second, stronger look at a set of proposed cases. It opens the cases' pages in a logged-in browser
 * (read-only: it opens pages, records and dropdowns, and never clicks anything that saves or deletes), collects what
 * is really on screen, and asks OpenAI (then Claude) to correct the cases against it. Free providers are not used.
 * Started by a person from the Assistant, so it is not held back by AI_PAID_DAILY_LIMIT (but it is counted).
 */

export interface SuperQaResult { reply: string; cases: TestCase[]; model: string; checked: string[]; seconds: number }

const MAX_PAGES = 3;
const PAGE_MS = 20_000;
const BUDGET_MS = 60_000;
const MAX_IMAGES = 5;
/** Anything that changes data. Exploration never clicks a control whose name matches. */
const UNSAFE = /\b(save|delete|remove|submit|confirm|archive|update|create|add|pay|refund|publish|apply|send|import|upload|duplicate|sync|logout|sign out|disable|enable|cancel order)\b/i;

const keyOf = (env: string) => !!process.env[env]?.trim();
/** The model Super QA asks OpenAI for. */
export const superQaModel = () => process.env.SUPERQA_OPENAI_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || 'gpt-5.4-mini';
/** Why Super QA cannot run, or '' when it can. */
export function superQaMissing(): string {
  return keyOf('OPENAI_API_KEY') || keyOf('ANTHROPIC_API_KEY') ? '' : 'Super QA needs OPENAI_API_KEY (or ANTHROPIC_API_KEY) in .env. Free providers are not used for it. Add a key on AI keys and restart SL QA.';
}

interface Finding { label: string; url: string; summary: string; dropdowns: { name: string; options: string[] }[]; image?: string }

/** Headings, buttons, fields, rows and labelled values on the page as it is now (like assist.ts pageSummary, without a case). */
async function summarize(page: Page): Promise<string> {
  return page.evaluate(() => {
    const v = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const uniq = (xs: string[], n: number) => [...new Set(xs.map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 60))].slice(0, n);
    const root = (document.querySelector('main') ?? document.body) as HTMLElement;
    const name = (e: Element) => (e as HTMLElement).innerText || e.getAttribute('aria-label') || '';
    const text = (sel: string) => [...root.querySelectorAll(sel)].filter(v).map(name);
    const fields = [...root.querySelectorAll('input:not([type=hidden]),textarea,select,[role=combobox]')].filter(v).map((el) => {
      const i = el as HTMLInputElement;
      let label = i.labels?.[0]?.innerText ?? i.getAttribute('aria-label') ?? i.placeholder ?? '';
      if (!label) { let c: HTMLElement | null = i.parentElement; for (let k = 0; k < 3 && c && !label; k++) { label = c.querySelector('label')?.innerText ?? ''; c = c.parentElement; } }
      return `${label}${i.type === 'checkbox' ? ' (checkbox)' : el.matches('select,[role=combobox]') ? ' (dropdown)' : ''}`;
    });
    const rows = [...root.querySelectorAll('tbody tr, article')].filter(v).slice(0, 6) as HTMLElement[];
    const rowNames = rows.map((r) => (r.querySelector('a, h3, h4, [title]') as HTMLElement | null)?.innerText ?? r.innerText.split('\n').find((l) => l.trim().length > 3) ?? '').map((x) => x.trim()).filter(Boolean);
    const rowButtons = rows[0] ? uniq([...rows[0].querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || (b as HTMLElement).innerText), 14) : [];
    const sidebar = uniq([...document.querySelectorAll('nav a, aside a')].filter(v).map((a) => (a as HTMLElement).innerText), 40);
    const pairs: string[] = [];
    for (const el of [...root.querySelectorAll('*')].filter((e) => v(e) && e.children.length === 0)) {
      const label = (el as HTMLElement).innerText?.trim() ?? '';
      if (!label || label.length > 30 || /\d{3,}/.test(label)) continue;
      const next = (el.nextElementSibling as HTMLElement | null)?.innerText?.trim() ?? '';
      if (next && next.length < 40 && next !== label) pairs.push(`${label}: ${next.split('\n')[0]}`);
      if (pairs.length > 25) break;
    }
    return [
      `URL: ${location.pathname}${location.search}`,
      `Headings: ${uniq(text('h1,h2,h3'), 10).join(' | ')}`,
      `Buttons/links: ${uniq([...text('button'), ...text('a[href]')].filter((x) => !sidebar.includes(x.trim())), 50).join(' | ')}`,
      `Fields: ${uniq(fields, 30).join(' | ')}`,
      `Tabs: ${uniq(text('[role=tab]'), 12).join(' | ')}`,
      rowNames.length ? `First records in the list: ${uniq(rowNames, 6).join(' | ')}` : '',
      rowButtons.length ? `Buttons inside each record row: ${rowButtons.join(' | ')}` : '',
      pairs.length ? `Labelled values: ${uniq(pairs, 25).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
  }).catch(() => `URL: ${page.url()}`);
}

/** A JPEG of the page, at most 1280 px wide (scaled in the page itself, as in assist.ts). */
async function screenshot(page: Page): Promise<string | undefined> {
  const buf = await page.screenshot({ type: 'jpeg', quality: 50, timeout: 5_000 }).catch(() => null);
  if (!buf) return undefined;
  return page.evaluate(async (b64) => {
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
}

/** Names the cases treat as dropdowns: "Select 'x' in 'Category'", "Click 'Category'" when that is a field. */
function dropdownNames(cases: TestCase[]): string[] {
  const all = cases.flatMap((c) => [...c.steps, ...c.expected]).join('\n');
  const named = [...all.matchAll(/\b(?:select|choose|pick)\b[^\n]*?\b(?:in|from)\s+(?:the\s+)?'([^']{2,40})'/gi), ...all.matchAll(/'([^']{2,40})'\s+(?:dropdown|select|combobox|field)/gi), ...all.matchAll(/\bclick\s+'([^']{2,40})'/gi)].map((m) => m[1].trim());
  return [...new Set(named)].filter((n) => !UNSAFE.test(n)).slice(0, 6);
}

/** Opens the dropdown labelled `label` (if the page has one), reads its options, closes it with Escape. */
async function readDropdown(page: Page, label: string, tries = 3): Promise<string[] | null> {
  const kind = await page.evaluate((want) => {
    document.querySelectorAll('[data-sq-open]').forEach((e) => e.removeAttribute('data-sq-open'));
    const norm = (s: string) => s.replace(/[*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const v = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const controls = 'select,[role=combobox],button[aria-haspopup],[aria-haspopup=listbox],input';
    let el: Element | null = null;
    for (const l of [...document.querySelectorAll('label, legend, [id$=-label]')].filter(v)) {
      if (norm((l as HTMLElement).innerText) !== norm(want)) continue;
      const f = (l as HTMLLabelElement).control;
      el = f && f.matches(controls) ? f : null;
      for (let c: Element | null = l.parentElement, k = 0; !el && c && k < 3; c = c.parentElement, k++) el = [...c.querySelectorAll(controls)].find(v) ?? null;
      if (el) break;
    }
    el ??= [...document.querySelectorAll('[role=combobox],select')].filter(v).find((e) => norm(e.getAttribute('aria-label') ?? '') === norm(want)) ?? null;
    if (!el) return null;
    if (el.tagName === 'SELECT') return [...(el as HTMLSelectElement).options].map((o) => o.text.trim()).filter(Boolean);
    el.setAttribute('data-sq-open', '1');
    return 'open';
  }, label).catch(() => null);
  // Forms can still be rendering: try again for a couple of seconds before deciding there is no such dropdown.
  if (kind === null && tries > 1) return page.waitForTimeout(1_000).then(() => readDropdown(page, label, tries - 1));
  if (kind === null || Array.isArray(kind)) return kind;
  await page.locator('[data-sq-open]').first().click({ timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const options = await page.evaluate(() => {
    const v = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...new Set([...document.querySelectorAll('[role=listbox] [role=option], [role=option], [cmdk-item], [role=menu] [role=menuitem], [role=menuitemcheckbox], [data-radix-popper-content-wrapper] label')].filter(v).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 60))].slice(0, 40);
  }).catch(() => [] as string[]);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return options;
}

/** Waits until the page has content and stops changing (forms often render seconds after the network goes quiet). */
async function settle(page: Page, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  await page.waitForLoadState('networkidle', { timeout: Math.max(500, maxMs / 2) }).catch(() => {});
  let last = -1;
  let same = 0;
  while (Date.now() < until && same < 2) {
    const n = await page.evaluate(() => document.querySelector('main')?.querySelectorAll('label, button, input, tr, h1, h2').length ?? 0).catch(() => 0);
    same = n > 3 && n === last ? same + 1 : 0;
    last = n;
    await page.waitForTimeout(500);
  }
}

async function look(page: Page, label: string, names: string[], left: () => number): Promise<Finding> {
  await settle(page, Math.min(10_000, Math.max(1_000, left() - 5_000)));
  const f: Finding = { label, url: new URL(page.url()).pathname + new URL(page.url()).search, summary: await summarize(page), dropdowns: [], image: await screenshot(page) };
  for (const n of names) {
    if (left() < 3_000) break;
    const options = await readDropdown(page, n);
    if (options) f.dropdowns.push({ name: n, options });
  }
  return f;
}

/** From a list page: opens the first real record, then its Edit page, by links/buttons that only navigate. */
async function openFirstRecord(page: Page): Promise<string | null> {
  const name = await page.evaluate(() => {
    const row = [...document.querySelectorAll('main tbody tr, main article')].find((r) => (r as HTMLElement).innerText.trim()) as HTMLElement | undefined;
    if (!row) return null;
    const link = (row.querySelector('a[href*="detail"], a[href*="?id="], a[href]') ?? row.querySelector('h3, h4, td:nth-child(2), td')) as HTMLElement | null;
    if (!link) return null;
    link.setAttribute('data-sq-row', '1');
    return (link.innerText || row.innerText).split('\n').map((x) => x.trim()).find((x) => x.length > 1) ?? null;
  }).catch(() => null);
  if (!name) return null;
  const before = page.url();
  await page.locator('[data-sq-row]').first().click({ timeout: 4_000 }).catch(() => {});
  await page.waitForURL((u) => u.toString() !== before, { timeout: 8_000 }).catch(() => {});
  return page.url() !== before ? name : null;
}

async function openEdit(page: Page): Promise<boolean> {
  const before = page.url();
  // A link to an edit page ("Full Edit" on a product) first; an "Edit" button may open an inline editor instead.
  const name = /^\s*(?:✎\s*)?(?:full\s+)?edit(?: product)?\s*$/i;
  const link = page.locator('main a[href*="/edit"]').first();
  // The record page renders after its URL changes: give the link a moment to appear.
  const edit = (await link.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)) ? link : page.getByRole('link', { name }).or(page.getByRole('button', { name })).first();
  if (!(await edit.isVisible().catch(() => false))) return false;
  await edit.click({ timeout: 4_000 }).catch(() => {});
  await page.waitForURL((u) => u.toString() !== before, { timeout: 8_000 }).catch(() => {});
  return page.url() !== before;
}

/** Visits the cases' pages (at most 3, ~60 s in all) and records what is really there. Read-only. */
export async function explore(cases: TestCase[]): Promise<{ findings: Finding[]; record?: string; notes: string[] }> {
  const deadline = Date.now() + BUDGET_MS;
  const left = () => deadline - Date.now();
  const urls = [...new Set(cases.map((c) => c.url || '/dashboard'))].slice(0, MAX_PAGES);
  const names = dropdownNames(cases);
  const findings: Finding[] = [];
  const notes: string[] = [];
  let record: string | undefined;
  let session: Session | undefined;
  try {
    session = await startSession();
    const context = await session.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_MS);
    for (const url of urls) {
      if (left() < 5_000) { notes.push(`Stopped before ${url}: time budget used.`); break; }
      const ok = await page.goto(`${config.baseUrl}${url}`, { waitUntil: 'domcontentloaded', timeout: Math.min(PAGE_MS, left()) }).then(() => true, (e: Error) => (notes.push(`Could not open ${url}: ${e.message.split('\n')[0].slice(0, 120)}`), false));
      if (!ok) continue;
      findings.push(await look(page, url, names, left));
      // A case that starts on a list and opens a record (then Edit): look at a real record and its edit page too.
      const opens = cases.some((c) => (c.url || '/dashboard') === url && /\bedit\b|\bopen\b|\bdetail/i.test(c.steps.join(' ')));
      if (opens && !/[?]id=/.test(url) && !record && left() > 10_000) {
        record = (await openFirstRecord(page)) ?? undefined;
        if (!record) { notes.push(`No record could be opened from ${url}.`); continue; }
        findings.push(await look(page, `first record '${record}'`, names, left));
        if (/\bedit\b/i.test(cases.map((c) => c.steps.join(' ')).join(' ')) && left() > 8_000 && (await openEdit(page))) findings.push(await look(page, `edit page of '${record}'`, names, left));
      }
    }
    await context.close().catch(() => {});
  } catch (e) {
    notes.push(`The browser could not look at the pages: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
  } finally {
    await session?.close().catch(() => {});
  }
  return { findings, record, notes };
}

const RULES = `
SUPER QA: you are reviewing test cases another assistant proposed, against what is REALLY on the pages (findings and screenshots below, taken just now in a logged-in browser). Return a corrected set:
- Use ONLY page names, buttons, fields, tabs, records and dropdown options actually seen in the FINDINGS (or the site map when the findings do not cover a page). Replace invented or placeholder names (e.g. 'Test Product', 'Electronics') with real ones from the findings; when a real record was opened, use its exact name.
- Dropdown lists may also hold controls such as 'Create new …' or 'Select all N'; those are not options to pick unless the request is about them.
- Name dropdown choices exactly as found, one step each (e.g. "Select '<real option>' in 'Category'").
- The url and the first steps must agree: if url is a record's own page (…?id=…), do not add steps that open that record again; if url is a list, open the record by its real name first.
- Fix wrong URLs and wrong or missing steps (for example a dropdown that must be opened first, a tab to switch to, an Edit button on the detail page).
- Steps are actions only; every check ("… should …") goes to expected. Each case must have at least one expected result that can be seen on screen.
- Expected results must be checkable in the robot's forms (quoted names, URL parts, messages, selected options). Rewrite vague ones such as "The list should be filtered to Draft orders" into what you saw (e.g. "The URL should contain 'status=draft'."). Do not add a step that opens the case's own url.
- Keep cases runnable by the robot's step language (examples in the rules above). Keep the user's intent and the same number of cases unless one is wrong or duplicated.
- Do not change real data unless the user's request needs it; never delete, refund or pay. If a case must save, say so in preconditions.
- In "reply": a short Markdown list of what was wrong and what you changed (or that the cases were already right). No HTML.
Reply with JSON only: {"reply": "<markdown>", "cases": [ … ]} with "cases" in the same shape as above.`;

/** Corrects `cases` (from the chat at `request`) against the real pages. Throws an Error with a readable message. */
export async function superQa(request: string, history: ChatTurn[], cases: TestCase[]): Promise<SuperQaResult> {
  const missing = superQaMissing();
  if (missing) throw new Error(missing);
  const started = Date.now();
  const { findings, record, notes } = await explore(cases);
  const images = findings.filter((f) => f.image).slice(0, MAX_IMAGES);
  const findingText = findings.length
    ? findings.map((f, i) => `### Page ${i + 1}: ${f.label} (${f.url})${f.image && images.includes(f) ? ` [screenshot ${images.indexOf(f) + 1}]` : ''}\n${f.summary}${f.dropdowns.map((d) => `\nDropdown '${d.name}' options when opened: ${d.options.length ? d.options.join(' | ') : '(none found: it may not be a dropdown, or it needs something first)'}`).join('')}`).join('\n\n')
    : '(The pages could not be opened; rely on the site map and say so in the reply.)';
  const hidden = secrets();
  const system = `${SYSTEM}\n${RULES}\n\nSITE MAP (crawled dashboard pages):\n${siteContext(request)}`;
  const convo = history.slice(-6).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.slice(0, 400)}`).join('\n');
  const user = `${convo ? `Earlier in the chat (brief):\n${convo}\n\n` : ''}THE USER'S REQUEST:\n${request}

CURRENT CASES (JSON; a person may have edited them):
${JSON.stringify(cases.map(({ id, url, title, priority, preconditions, steps, testData, expected }) => ({ id, url, title, priority, preconditions, steps, testData, expected })), null, 1)}

FINDINGS from the real dashboard:
${record ? `A real record on the list is '${record}'.\n` : ''}${findingText}${notes.length ? `\nNotes: ${notes.join(' ')}` : ''}`;
  const parse = (text: string) => {
    const v = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '') as { reply?: unknown; cases?: unknown };
    const out = toCases(v.cases);
    if (typeof v.reply !== 'string' || !out.length) throw new Error('no cases');
    return { reply: v.reply, cases: out };
  };
  const { value, provider, model } = await complete(redact(system, hidden), redact(user, hidden), parse, images.map((f) => f.image!), {
    only: ['openai', 'anthropic'], maxTokens: 6000, ignorePaidCap: true, models: { openai: superQaModel() },
  });
  const checked = [
    ...findings.map((f) => `${f.label === f.url ? '' : `${f.label}: `}${f.url}${f.dropdowns.length ? ` — ${f.dropdowns.map((d) => `'${d.name}': ${d.options.length ? d.options.slice(0, 8).join(', ') + (d.options.length > 8 ? ` (+${d.options.length - 8})` : '') : 'no options found'}`).join('; ')}` : ''}`),
    ...notes,
  ];
  return { ...value, model: `${provider.name} · ${model}`, checked, seconds: Math.round((Date.now() - started) / 1000) };
}
