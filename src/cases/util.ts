import fs from 'fs';
import { parse } from 'csv-parse/sync';
import type { Row } from '../productsPage.js';
import type { CaseContext } from '../runner.js';

export const lc = (s: string) => s.toLocaleLowerCase();

/** "৳1,400.00" → 1400 (first amount in the text). */
export function money(text: string): number | null {
  const m = text.match(/৳\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export const list = (items: unknown[]) => (items.length ? items.join(', ') : '(none)');

export function rowMatches(row: Row, term: string): boolean {
  const t = lc(term.trim());
  return [row.name, row.sku, row.category, row.brand].some((v) => lc(v).includes(t));
}

/** Pct as the app should show it, allowing either rounding direction. */
export function pctOk(shown: number | null, part: number, total: number): boolean {
  if (shown === null) return false;
  if (total === 0) return shown === 0;
  const exact = (part / total) * 100;
  return Math.abs(shown - exact) < 1;
}

export function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true });
}

/** A real category in the store that has products, preferring `wanted` if it exists. */
export async function pickCategory(t: CaseContext, wanted: string): Promise<{ id: number; name: string }> {
  const categories = await t.api.categories();
  const exact = categories.find((c) => lc(c.name) === lc(wanted));
  if (exact) return exact;
  const withProducts = categories.filter((c) => c.products_count > 0).sort((a, b) => b.products_count - a.products_count);
  if (!withProducts.length) return t.block(`Category '${wanted}' does not exist and no category has products.`);
  t.note(`Sheet test data uses category '${wanted}', which does not exist in this store; used '${withProducts[0].name}' instead.`);
  return withProducts[0];
}

export const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** First index where `names` breaks the given order, or -1. */
export function orderBreak(names: string[], dir: 'asc' | 'desc'): number {
  for (let i = 1; i < names.length; i++) {
    const c = collator.compare(names[i - 1], names[i]);
    if (dir === 'asc' ? c > 0 : c < 0) return i;
  }
  return -1;
}
