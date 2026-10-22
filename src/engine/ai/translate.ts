import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { complete, configured, paidDailyLimit, usage } from './providers.js';

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
  createdAt: string;
  reviewedAt?: string;
}

const FILE = () => path.join(config.dataDir, 'translations.json');
export const keyOf = (kind: Kind, source: string) => `${kind}:${source.trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '').toLowerCase()}`;

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

export function approved(kind: Kind, source: string): Translation | undefined {
  const t = loadTranslations()[keyOf(kind, source)];
  return t?.status === 'approved' ? t : undefined;
}

export function setStatus(key: string, status: Translation['status'], lines?: string[]): Translation | undefined {
  const all = loadTranslations();
  const t = all[key];
  if (!t) return undefined;
  all[key] = { ...t, status, lines: lines ?? t.lines, reviewedAt: new Date().toISOString() };
  saveTranslations(all);
  return all[key];
}

/** The first provider that will be tried, for display; null when no key is set (SL QA then stays zero-AI). */
export function aiProvider(): { name: string; model: string; chain: string[]; paidLimit: number; paidUsed: number } | null {
  const list = configured();
  if (!list.length) return null;
  const free = list.filter((x) => x.provider.tier === 'free');
  const first = free[0] ?? list[0];
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
CLICK '<name>' IN '<dialog or section title>'
TYPE '<value>' INTO '<field label or placeholder>'
CLEAR '<field>'
SELECT '<option>' IN '<dropdown label>'
TURN ON '<switch label>'   /   TURN OFF '<switch label>'
CHECK '<checkbox label>'   /   UNCHECK '<checkbox label>'
PRESS 'Enter'   /   PRESS 'Escape'
WAIT <seconds>
UPLOAD '<what: e.g. square jpg | 5mb jpg | gif | pdf | webp | wide 16:9 jpg | fake exe>' TO '<upload area title>'

EXPECT lines (checks on the page after the steps):
EXPECT TEXT '<text>'          EXPECT NO TEXT '<text>'
EXPECT MESSAGE '<words in the pop-up message>'   (or EXPECT MESSAGE for any message)
EXPECT URL '<path>'
EXPECT BUTTON '<name>' ENABLED | DISABLED | VISIBLE | HIDDEN
EXPECT FIELD '<label>' = '<value>'   (also: contains, !=) — the value inside an input box
EXPECT VALUE '<label>' = '<value>'   (also: !=, >, <, >=, <=) — a number or text shown next to a label (cards, totals, detail rows, e.g. EXPECT VALUE 'On Hand' = '13')
EXPECT COUNT '<text such as Showing 1–1 of 1>'

Rules:
- Use only the line forms above. Use names a person would read on screen. When a list of what is on the page is given, use ONLY names from that list; never invent names.
- "a product" / "any product" / an example product (e.g. BASHPATA) means: use the FIRST record shown in the list (or the test product, if one is named below). To act on a record's own button, write CLICK '<button>' IN '<record name>' (for example CLICK 'Quick view' IN 'Cream Glide Lip Liner').
- After a step that saves inside a dialog, the dialog usually closes; to do another change in it, open it again first (e.g. CLICK 'Adjust Stock').
- Do the WHOLE sentence: every action it names, in order, until the place it describes is reached. "click 'More details' (or Quick view > 'View full details')" means: CLICK 'Quick view' IN '<record>' then CLICK 'View full details'. "Open a product" / "the detail page" means the product's detail page: CLICK '<record name>' opens it.
- When the case's later steps name tabs, sections or buttons of a page, the earlier steps must end on that page.
- Prefer short, likely labels ('Save Product', 'Selling Price').
- Use values from "Test data" when the sentence refers to them.
- Invent realistic test values when the sentence needs one; product names must start with 'BTB ' so test data can be cleaned up.
- Logging in is already done; skip it. Skip sentences that only say to look at something (return no lines, note "look only").
- If the sentence cannot be done by a browser robot on this dashboard (needs a second account, another device, a real customer, a human judgement), return no lines and explain why in "note".
- Prefer labels and texts listed under "Labelled values" when checking numbers; copy the label exactly.
- Copy text exactly as listed on the page; never join several items into one text (a breadcrumb "Dashboard > Products > X" is three texts: check each one separately).
- A value shown as text on a detail page (SKU, price) is checked with EXPECT VALUE or EXPECT TEXT, never EXPECT FIELD (FIELD is only for input boxes).
- Never use an example product name from the sheet (e.g. BASHPATA) in a check; use the record actually opened.
- Never invent a number you were not given. If an expected result is about a CHANGE ("should decrease by 2", "stays the same") and the starting value is not stated, return no lines and note "needs a before/after comparison".
- For an EXPECTED RESULT about a particular tab, section or dialog (e.g. "Stock: …", "Orders tab: …"), first write the STEP line that shows it (CLICK 'Stock'), then the EXPECT lines.
- For an EXPECTED RESULT, write checks that would pass if the app behaves as described (the robot reports a failure when it does not). Check the specific thing the sentence is about (a text, a button, a field value, a page), not just that "a message" appeared. A check needing another site or device (storefront, phone) cannot be done: return no lines and say why.
- Reply with JSON only: {"lines": ["..."], "note": "..."}`;

/** Asks the AI to translate one sentence. Returns null when no key is set. */
export async function translate(kind: Kind, source: string, ctx: { page: string; title: string; steps: string[]; expected: string[]; preconditions?: string; testData?: string }): Promise<Translation | null> {
  if (!aiProvider()) return null;
  const user = `Page: ${ctx.page || '(unknown)'}
Case title: ${ctx.title}${ctx.preconditions ? `\nPreconditions: ${ctx.preconditions}` : ''}${ctx.testData ? `\nTest data: ${ctx.testData}` : ''}
All steps of the case:
${ctx.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Expected results:
${ctx.expected.map((e) => `- ${e}`).join('\n')}

Translate this ${kind === 'step' ? 'STEP' : 'EXPECTED RESULT'} sentence into ${kind === 'step' ? 'STEP' : 'EXPECT'} lines:
"${source}"`;
  const parse = (text: string) => {
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('no JSON');
    const parsed = JSON.parse(json) as { lines?: unknown; note?: unknown };
    if (!Array.isArray(parsed.lines)) throw new Error('no lines');
    return parsed;
  };
  const { value, provider: used, model } = await complete(GUIDE, user, parse);
  const lines = (value.lines as unknown[]).map(String).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  return { source, kind, lines, note: String(value.note ?? ''), status: 'suggested', page: ctx.page, model: `${used.name} · ${model}`, createdAt: new Date().toISOString() };
}
