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
EXPECT FIELD '<label>' = '<value>'   (also: contains, !=)
EXPECT COUNT '<text such as Showing 1–1 of 1>'

Rules:
- Use only the line forms above. Use names a person would read on screen. Prefer short, likely labels ('Save Product', 'Selling Price').
- Invent realistic test values when the sentence needs one; product names must start with 'BTB ' so test data can be cleaned up.
- Logging in is already done; skip it. Skip sentences that only say to look at something (return no lines, note "look only").
- If the sentence cannot be done by a browser robot on this dashboard (needs a second account, another device, a real customer, a human judgement), return no lines and explain why in "note".
- Reply with JSON only: {"lines": ["..."], "note": "..."}`;

/** Asks the AI to translate one sentence. Returns null when no key is set. */
export async function translate(kind: Kind, source: string, ctx: { page: string; title: string; steps: string[]; expected: string[] }): Promise<Translation | null> {
  if (!aiProvider()) return null;
  const user = `Page the case starts on: ${ctx.page || '(unknown)'}
Case title: ${ctx.title}
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
