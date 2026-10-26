import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { complete, configured, paidDailyLimit, usage, type ChainOptions } from './providers.js';

/**
 * Optional AI translator. It only rewrites a sentence the rule engine did not understand into the fixed action
 * language (see phrases/actions.ts). It never clicks, never decides a verdict, and nothing it writes runs until a
 * person approves it. Approved rewrites are stored in data/translations.json, so the same sentence never needs the
 * AI again and runs stay repeatable.
 */

export type Kind = 'step' | 'expect';

export interface Translation {
  /** The sentence as written in the sheet. */
  source: string;
  kind: Kind;
  /** Lines in the action language, one action or check per line. Empty = "cannot be automated". */
  lines: string[];
  /** Why it cannot be automated, or a note for the reviewer. */
  note: string;
  status: 'suggested' | 'approved' | 'rejected';
  /** The page the case was about, given to the AI as context. */
  page: string;
  model: string;
  /** Name of the provider that answered. */
  provider?: string;
  createdAt: string;
  reviewedAt?: string;
}

const FILE = () => path.join(config.dataDir, 'translations.json');
const norm = (source: string) => source.trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '').toLowerCase();
/** The sentence-only key (older rewrites, and ones a person suggested without a page). */
export const keyOf = (kind: Kind, source: string) => `${kind}:${norm(source)}`;
/** "/dashboard/products/123/edit?x" → "/dashboard/products/:id/edit": record pages share their rewrites. */
export const pageOf = (page: string) => (page.match(/\/dashboard[^\s?#]*/)?.[0] ?? '').replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/$/, '');
/** Page-scoped key: the same words can mean different things on different pages ("Click 'Save'"). */
export const pageKeyOf = (kind: Kind, page: string, source: string) => `${kind}@${pageOf(page)}:${norm(source)}`;

/** The stored rewrite for a sentence: page-scoped first, then the sentence-only key. With no page, a single page-scoped one. */
export function lookup(all: Record<string, Translation>, kind: Kind, source: string, page?: string): { key: string; t: Translation } | undefined {
  const scoped = page && pageOf(page) ? pageKeyOf(kind, page, source) : '';
  if (scoped && all[scoped]) return { key: scoped, t: all[scoped] };
  const plain = keyOf(kind, source);
  if (all[plain]) return { key: plain, t: all[plain] };
  if (page) return undefined;
  const tail = `:${norm(source)}`;
  const hits = Object.keys(all).filter((k) => k.startsWith(`${kind}@`) && k.endsWith(tail));
  return hits.length === 1 ? { key: hits[0], t: all[hits[0]] } : undefined;
}

export function loadTranslations(): Record<string, Translation> {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return {};
  }
}

export function saveTranslations(all: Record<string, Translation>): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 1));
}

/** An approved rewrite for the sentence on this page (page-scoped first, then sentence-only). */
export function approved(kind: Kind, source: string, page?: string): Translation | undefined {
  const all = loadTranslations();
  const scoped = page && pageOf(page) ? all[pageKeyOf(kind, page, source)] : undefined;
  if (scoped?.status === 'approved') return scoped;
  const t = all[keyOf(kind, source)];
  if (t?.status === 'approved') return t;
  return page ? undefined : (() => { const l = lookup(all, kind, source); return l?.t.status === 'approved' ? l.t : undefined; })();
}

export function setStatus(key: string, status: Translation['status'], lines?: string[]): Translation | undefined {
  const all = loadTranslations();
  const t = all[key];
  if (!t) return undefined;
  all[key] = { ...t, status, lines: lines ?? t.lines, reviewedAt: new Date().toISOString() };
  saveTranslations(all);
  return all[key];
}

/** The first provider that will be tried (the primary one when set), for display; null when no key is set (SL QA then stays zero-AI). */
export function aiProvider(): { name: string; model: string; chain: string[]; paidLimit: number; paidUsed: number } | null {
  const list = configured();
  if (!list.length) return null;
  const first = list.find((x) => x.provider.tier === 'primary') ?? list.find((x) => x.provider.tier === 'free') ?? list[0];
  const u = usage();
  return {
    name: first.provider.name,
    model: first.model,
    chain: list.map((x) => `${x.provider.name}${x.keys > 1 ? ` ×${x.keys} keys` : ''}`),
    paidLimit: paidDailyLimit(),
    paidUsed: u.paidCalls,
  };
}

const GUIDE = `You turn one sentence from a QA test case for an online-shop admin dashboard (slshop.cloud) into exact lines in a small action language. A browser robot runs the lines. You only translate; you never judge whether the app is right.

STEP lines (one action per line, names in single quotes, exactly as a person sees them on screen):
GO TO '/dashboard/<page>'            (pages: dashboard, orders, products, products/new, customers, pos, inventory, coupons, accounting/cashbook, storefront/pages, …)
CLICK '<visible button, link, tab or text>'
CLICK '<name>' IN '<dialog title, section title, or text of the list row / card>'
TYPE '<value>' INTO '<field label or placeholder>'   (add IN '<dialog or section>' when two places have that field)
CLEAR '<field>'
SELECT '<option>' IN '<dropdown label>'
TURN ON '<switch label>'   /   TURN OFF '<switch label>'
CHECK '<checkbox label>'   /   UNCHECK '<checkbox label>'
PRESS 'Enter'   /   PRESS 'Escape'
HOVER '<text>'   /   SCROLL TO '<text>'   /   RELOAD   /   GO BACK
WAIT <seconds>   /   WAIT FOR TEXT '<text>' <max seconds>   /   WAIT FOR URL '<path part>'
UPLOAD '<what: e.g. square jpg | 5mb jpg | gif | pdf | webp | wide 16:9 jpg | fake exe>' TO '<upload area title>'
REMEMBER VALUE '<label>' AS <name>   — keeps the number/text shown next to a label (card, total, detail row) for a later check
REMEMBER COUNT AS <name>             — keeps the list total ("Showing 1–20 of 57" → 57, else the rows shown)

EXPECT lines (checks on the page after the steps):
EXPECT TEXT '<text>'          EXPECT NO TEXT '<text>'          EXPECT TEXT '<text>' IN '<dialog, section or row text>'
EXPECT ROW '<text>'           EXPECT NO ROW '<text>'           (a list row or card containing that text)
EXPECT MESSAGE '<words in the pop-up message>'   (or EXPECT MESSAGE for any message)
EXPECT URL '<path>'
EXPECT BUTTON '<name>' ENABLED | DISABLED | VISIBLE | HIDDEN
EXPECT FIELD '<label>' = '<value>'   (also: contains, !=) — the value inside an input box
EXPECT VALUE '<label>' = '<value>'   (also: !=, >, <, >=, <=) — a number or text shown next to a label (cards, totals, detail rows, e.g. EXPECT VALUE 'On Hand' = '13')
EXPECT VALUE '<label>' = <name> + 5  (also: = <name> - 2, > <name>, < <name>, = <name>) — compared with a REMEMBERed value
EXPECT VALUE '<label>' CHANGED   /   EXPECT VALUE '<label>' UNCHANGED   — compared with REMEMBER VALUE '<same label>' AS …
EXPECT COUNT '<text such as Showing 1–1 of 1>'
EXPECT COUNT = <name> + 1   (also: = <name> - 1, < <name>, > <name>, = 0)   /   EXPECT COUNT CHANGED | UNCHANGED

BEFORE / AFTER: when something should increase, decrease, change or stay the same, REMEMBER it BEFORE the steps that change it, then compare after:
  REMEMBER COUNT AS n  →  (the steps)  →  EXPECT COUNT < n
  REMEMBER VALUE 'On Hand' AS stock  →  (stock in 5)  →  EXPECT VALUE 'On Hand' = stock + 5
When asked for the REMEMBER lines of a case, return only REMEMBER lines (and the STEP line that shows the value first, if it is on another tab). When asked for an EXPECTED RESULT and remembered names are listed, compare with those names.

Rules:
- Use only the line forms above. Use names a person would read on screen. When a list of what is on the page is given, use ONLY names from that list; never invent names.
- "a product" / "any product" / an example product (e.g. BASHPATA) means: use the FIRST record shown in the list (or the test product, if one is named below). To act on a record's own button, write CLICK '<button>' IN '<record name>' (for example CLICK 'Quick view' IN 'Cream Glide Lip Liner').
- After a step that saves inside a dialog, the dialog usually closes; to do another change in it, open it again first (e.g. CLICK 'Adjust Stock').
- Do the WHOLE sentence: every action it names, in order, until the place it describes is reached. "click 'More details' (or Quick view > 'View full details')" means: CLICK 'Quick view' IN '<record>' then CLICK 'View full details'. "Open a product" / "the detail page" means the product's detail page: CLICK '<record name>' opens it.
- When the case's later steps name tabs, sections or buttons of a page, the earlier steps must end on that page.
- Prefer short, likely labels ('Save Product', 'Selling Price').
- Use values from "Test data" when the sentence refers to them.
- Invent realistic test values when the sentence needs one; product names must start with 'BTB ' so test data can be cleaned up.
- A STEP sentence gets STEP lines only (never EXPECT lines; the expected results are checked separately).
- Logging in is already done; skip it. Skip sentences that only say to look at something (return no lines, note "look only").
- If the sentence cannot be done by a browser robot on this dashboard (needs a second account, another device, a real customer, a human judgement), return no lines and explain why in "note".
- Prefer labels and texts listed under "Labelled values" when checking numbers; copy the label exactly.
- Copy text exactly as listed on the page; never join several items into one text (a breadcrumb "Dashboard > Products > X" is three texts: check each one separately).
- A value shown as text on a detail page (SKU, price) is checked with EXPECT VALUE or EXPECT TEXT, never EXPECT FIELD (FIELD is only for input boxes).
- Never use an example product name from the sheet (e.g. BASHPATA) in a check; use the record actually opened.
- Never invent a number you were not given. For a CHANGE ("should decrease by 2", "stays the same", "should go up") use a remembered name from the list given; if none fits, return no lines and note "needs a before/after comparison".
- Never delete, remove, archive, cancel, refund, log out, place an order, confirm a payment, withdraw, recharge or press 'Generate' / 'Write with AI' on real data: only on records whose name starts with 'BTB ' (write CLICK 'Delete' IN 'BTB …'). The robot refuses other such clicks.
- For an EXPECTED RESULT about a particular tab, section or dialog (e.g. "Stock: …", "Orders tab: …"), first write the STEP line that shows it (CLICK 'Stock'), then the EXPECT lines.
- For an EXPECTED RESULT, write checks that would pass if the app behaves as described (the robot reports a failure when it does not). Check the specific thing the sentence is about (a text, a button, a field value, a page), not just that "a message" appeared. A check needing another site or device (storefront, phone) cannot be done: return no lines and say why.
- Reply with JSON only: {"lines": ["..."], "note": "..."}`;

/** Asks the AI to translate one sentence. Returns null when no key is set. */
export async function translate(kind: Kind, source: string, ctx: { page: string; title: string; steps: string[]; expected: string[]; preconditions?: string; testData?: string; /** Base64 JPEG of the page, for providers that read images. */ image?: string; /** Replaces the closing "Translate this … sentence" request. */ ask?: string; /** Narrows the provider chain. */ chain?: ChainOptions }): Promise<Translation | null> {
  if (!aiProvider()) return null;
  const user = `Page: ${ctx.page || '(unknown)'}
Case title: ${ctx.title}${ctx.preconditions ? `\nPreconditions: ${ctx.preconditions}` : ''}${ctx.testData ? `\nTest data: ${ctx.testData}` : ''}
All steps of the case:
${ctx.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Expected results:
${ctx.expected.map((e) => `- ${e}`).join('\n')}

${ctx.ask ?? `Translate this ${kind === 'step' ? 'STEP' : 'EXPECTED RESULT'} sentence into ${kind === 'step' ? 'STEP' : 'EXPECT'} lines:
"${source}"`}`;
  const parse = (text: string) => {
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('no JSON');
    const parsed = JSON.parse(json) as { lines?: unknown; note?: unknown };
    if (!Array.isArray(parsed.lines)) throw new Error('no lines');
    return parsed;
  };
  const { value, provider: used, model } = await complete(GUIDE, user, parse, ctx.image, ctx.chain);
  const lines = (value.lines as unknown[]).map(String).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  return { source, kind, lines, note: String(value.note ?? ''), status: 'suggested', page: ctx.page, model: `${used.name} · ${model}`, provider: used.name, createdAt: new Date().toISOString() };
}
