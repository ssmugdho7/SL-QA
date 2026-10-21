import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

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

export function aiProvider(): { name: string; model: string } | null {
  if (config.ai.anthropicKey) return { name: 'Anthropic Claude', model: config.ai.model || 'claude-sonnet-5-5' };
  if (config.ai.openaiKey) return { name: 'OpenAI', model: config.ai.model || 'gpt-4.1-mini' };
  return null;
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
  const provider = aiProvider();
  if (!provider) return null;
  const user = `Page the case starts on: ${ctx.page || '(unknown)'}
Case title: ${ctx.title}
All steps of the case:
${ctx.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
Expected results:
${ctx.expected.map((e) => `- ${e}`).join('\n')}

Translate this ${kind === 'step' ? 'STEP' : 'EXPECTED RESULT'} sentence into ${kind === 'step' ? 'STEP' : 'EXPECT'} lines:
"${source}"`;
  const text = provider.name.startsWith('Anthropic') ? await callAnthropic(provider.model, user) : await callOpenAI(provider.model, user);
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
  let parsed: { lines?: unknown; note?: unknown } = {};
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = { lines: [], note: `The AI answer could not be read: ${text.slice(0, 120)}` };
  }
  const lines = (Array.isArray(parsed.lines) ? parsed.lines : []).map(String).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  return { source, kind, lines, note: String(parsed.note ?? ''), status: 'suggested', page: ctx.page, model: provider.model, createdAt: new Date().toISOString() };
}

async function callAnthropic(model: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': config.ai.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 600, temperature: 0, system: GUIDE, messages: [{ role: 'user', content: user }] }),
  });
  const body = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body.error?.message ?? 'request failed'}`);
  return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

async function callOpenAI(model: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.ai.openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: GUIDE }, { role: 'user', content: user }] }),
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${body.error?.message ?? 'request failed'}`);
  return body.choices?.[0]?.message?.content ?? '';
}
