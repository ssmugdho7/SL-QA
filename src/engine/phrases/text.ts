/** Text helpers for reading test-case sentences. */

const OPENS_QUOTE = /[\s(=/[]/;
const CLOSES_QUOTE = /[\s.,;:)!?/\]]/;
const HIDDEN = '\u0001';

/**
 * Hides quoted text ('…') and bracketed text ((…)) so separators inside them are ignored.
 * Apostrophes inside words ("store's") are not treated as quotes.
 */
export function mask(text: string): string {
  let out = '';
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i === 0 ? ' ' : text[i - 1];
    const next = i === text.length - 1 ? ' ' : text[i + 1];
    if (depth === 0 && !inQuote && (ch === "'" || ch === '‘') && OPENS_QUOTE.test(prev)) {
      inQuote = true;
      out += HIDDEN;
    } else if (inQuote && (ch === "'" || ch === '’') && CLOSES_QUOTE.test(next)) {
      inQuote = false;
      out += HIDDEN;
    } else if (inQuote) {
      out += HIDDEN;
    } else if (ch === '(') {
      depth++;
      out += HIDDEN;
    } else if (ch === ')' && depth > 0) {
      depth--;
      out += HIDDEN;
    } else {
      out += depth > 0 ? HIDDEN : ch;
    }
  }
  return out;
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

/** Quoted values in a sentence: "Click 'Add Product'" → ["Add Product"]. */
export function quoted(text: string): string[] {
  const masked = mask(text);
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const hidden = masked[i] === HIDDEN && (text[i] === "'" || text[i] === '‘' || text[i] === '’');
    if (!hidden) continue;
    if (start < 0 && (i === 0 || masked[i - 1] !== HIDDEN || text[i - 1] === ' ')) start = i;
    else if (start >= 0) {
      out.push(text.slice(start + 1, i));
      start = -1;
    }
  }
  return out;
}

/** "A, B, C and D" → ["A", "B", "C", "D"] (quotes removed). */
export function listItems(text: string): string[] {
  return splitAt(text.replace(/\.$/, ''), /\s*,\s*(?:and\s+)?|\s+and\s+/g)
    .map((s) => s.replace(/^['‘]|['’]$/g, '').trim())
    .filter(Boolean);
}

export const lc = (s: string) => s.toLocaleLowerCase();

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
