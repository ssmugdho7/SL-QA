/** Text helpers for reading test-case sentences. */

const OPENS_QUOTE = /[\s(=/[]/;
const CLOSES_QUOTE = /[\s.,;:)!?/\]]/;
const HIDDEN = '\u0001';

/** Quote pairs: a quote opens after a space or bracket and closes with its partner before a space or punctuation. */
const PAIRS: Record<string, string> = { "'": "'’", '‘': "’'", '"': '"', '“': '”"' };

/** [open, close] index pairs of the quoted parts ('…', "…", ‘…’, “…”); an apostrophe inside a word ("Don't") does not close one. */
function quoteSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    if (depth > 0 || !PAIRS[ch] || !OPENS_QUOTE.test(i === 0 ? ' ' : text[i - 1])) continue;
    let end = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (PAIRS[ch].includes(text[j]) && CLOSES_QUOTE.test(j === text.length - 1 ? ' ' : text[j + 1])) { end = j; break; }
    }
    // A quote that never closes is plain text (an inch mark, a stray apostrophe), not the start of a hidden span.
    if (end < 0) continue;
    spans.push([i, end]);
    i = end;
  }
  return spans;
}

/**
 * Hides quoted text ('…', "…", curly quotes) and bracketed text ((…)) so separators inside them are ignored.
 * Apostrophes inside words ("store's", 'Don't show') are not treated as quotes.
 */
export function mask(text: string): string {
  const out = text.split('');
  for (const [a, b] of quoteSpans(text)) for (let i = a; i <= b; i++) out[i] = HIDDEN;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (out[i] === HIDDEN) continue;
    if (text[i] === '(') { depth++; out[i] = HIDDEN; } else if (text[i] === ')' && depth > 0) { depth--; out[i] = HIDDEN; } else if (depth > 0) out[i] = HIDDEN;
  }
  return out.join('');
}

/** Splits at `sep` (a global regex), ignoring separators inside quotes or brackets. Keeps each piece's leading separator. */
export function splitKeep(text: string, sep: RegExp): { text: string; sep: string }[] {
  const masked = mask(text);
  const parts: { text: string; sep: string }[] = [];
  let last = 0;
  let lastSep = '';
  for (const m of masked.matchAll(sep)) {
    if (m.index === 0) continue;
    parts.push({ text: text.slice(last, m.index).trim(), sep: lastSep });
    last = m.index! + m[0].length;
    lastSep = text.slice(m.index, last);
  }
  parts.push({ text: text.slice(last).trim(), sep: lastSep });
  return parts.filter((p) => p.text);
}

export function splitAt(text: string, sep: RegExp): string[] {
  return splitKeep(text, sep).map((p) => p.text);
}

/** Quoted values in a sentence: "Click 'Add Product'" → ["Add Product"]; double and curly quotes too ('Error "Name is required"'). */
export function quoted(text: string): string[] {
  return quoteSpans(text).map(([a, b]) => text.slice(a + 1, b));
}

/** "A, B, C and D" → ["A", "B", "C", "D"] (quotes removed). */
export function listItems(text: string): string[] {
  return splitAt(text.replace(/\.$/, ''), /\s*,\s*(?:and\s+)?|\s+and\s+/g)
    .map((s) => s.replace(/^['‘"“]|['’"”]$/g, '').trim())
    .filter(Boolean);
}

export const lc = (s: string) => s.toLocaleLowerCase();

/** Words after "on/for" that mean "a record in a list" ("Click Edit on any product", "Open a pending order"). */
export const RECORD = '(?:product|order|customer|row|record|item|entry|category|brand|label|coupon|user|staff(?: member)?|supplier|post|review|shipment|invoice|transaction|expense|party|warehouse|campaign|page|role)';

type Accept = (m: RegExpExecArray) => boolean;

/** A RegExp that matches only when `ok` also accepts the match (Title Case names, word lists a pattern cannot say). Nests. */
export function when(re: RegExp, ok: Accept): RegExp {
  const prev = (re as RegExp & { accept?: Accept }).accept;
  const accept: Accept = prev ? (m) => prev(m) && ok(m) : ok;
  return Object.assign(new (class extends RegExp {
    exec(s: string): RegExpExecArray | null {
      const m = super.exec(s);
      return m && accept(m) ? m : null;
    }
  })(re.source, re.flags), { accept });
}

const SMALL_WORD = /^(?:of|and|or|to|with|for|the|a|an|in|on|by|per|vs|&|\/|-|\+)$/i;

/** "Save Changes", "Send to Courier", "SSLCommerz", "A5": words a person reads on a button or label (Title Case, up to 6 words). */
export function isLabel(s: string): boolean {
  const w = s.trim().split(/\s+/);
  return w.length <= 6 && w.every((x, i) => /^[\p{Lu}\d৳#][\p{L}\p{N}'’&./%+-]*$/u.test(x) || (i > 0 && i < w.length - 1 && SMALL_WORD.test(x)));
}

/**
 * "Total Sales, Total Orders and Total Customers" → the names, when each reads like a label on screen: quoted, or
 * Title Case words ("Save Changes", "Money with Courier"). Plain descriptions ("the new store name") → null.
 */
export function uiNames(text: string): string[] | null {
  const t = text.trim().replace(/^(?:the|all|both)\s+/i, '');
  const whole = quoted(t);
  if (whole.length && whole.join('').length >= t.length - 2 * whole.length - 8 && /^['"‘“]/.test(t)) return whole.filter((q) => q.trim());
  const items = listItems(t);
  if (!items.length) return null;
  return items.every(isLabel) ? items : null;
}

export const words = (s: string) => lc(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** "৳1,400.00" → 1400 (first amount in the text). */
export function money(text: string): number | null {
  const m = text.match(/৳\s*(-?[\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export const list = (items: unknown[]) => (items.length ? items.join(', ') : '(none)');

export const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** First index where `names` breaks the given order, or -1. */
export function orderBreak(names: string[], dir: 'asc' | 'desc'): number {
  for (let i = 1; i < names.length; i++) {
    const c = collator.compare(names[i - 1], names[i]);
    if (dir === 'asc' ? c > 0 : c < 0) return i;
  }
  return -1;
}
