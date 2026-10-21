import type { Product } from '../apps/slshop/api.js';
import type { CaseContext } from '../context.js';
import { lc, quoted } from './text.js';

/**
 * "Given" rules: read the case's Test Data, steps and expected results, and prepare the test data
 * they describe before the steps run. Real store data is only ever borrowed (and restored afterwards).
 */

export interface Plan {
  /** Products to create, in order; "subject" products are what "a product"/"its" in the steps refer to. */
  products: { suffix: string; fields: Record<string, unknown> }[];
  needsOrdered: boolean;
  needsEmptyStore: boolean;
  needsOtherStore: boolean;
  needsEmptyCategory: boolean;
  /** Quoted Test Data values, used in order by "type …" steps that don't quote their own text. */
  values: string[];
}

const all = (t: CaseContextLike) => [t.tc.testData, t.tc.preconditions, ...t.tc.steps, ...t.tc.expected].join('\n');

type CaseContextLike = Pick<CaseContext, 'tc'>;

const VARIANTS = [
  { name: '50g', attributes: { Weight: '50g' }, price: 70, stock: 3 },
  { name: '100g', attributes: { Weight: '100g' }, price: 112, stock: 4 },
  { name: '125g', attributes: { Weight: '125g' }, price: 140, stock: 2 },
  { name: '250g', attributes: { Weight: '250g' }, price: 280, stock: 1 },
];

export function planFixtures(t: CaseContextLike): Plan {
  const text = all(t);
  const data = t.tc.testData;
  const steps = t.tc.steps.join('\n');
  const plan: Plan = {
    products: [],
    needsOrdered: /ordered before|has orders|with orders|used in (past )?orders|that has been ordered/i.test(text),
    needsEmptyStore: /store (that )?(has|with) (no|0) products|new store with 0 products/i.test(text),
    needsOtherStore: /different store|other store|two stores/i.test(text),
    needsEmptyCategory: /(empty category|category that has no products)/i.test(text),
    values: testDataValues(data),
  };

  const add = (suffix: string, fields: Record<string, unknown> = {}) => plan.products.push({ suffix, fields });

  // Several named products ("Product A: stock 3, threshold 5 ; Product B: stock 0 ; Product C: inactive").
  const named = [...data.matchAll(/Product ([A-Z])\s*:\s*([^;\n]+)/g)];
  if (named.length) {
    for (const [, letter, desc] of named) add(`Product ${letter}`, { current_stock: 10, low_stock_threshold: 5, ...(/inactive/i.test(desc) ? {} : {}) });
    return plan;
  }

  // Counts of test products ("3 test products", "Select 3 products", "2 products with no orders").
  const counts = [...text.matchAll(/\b(\d+) (?:test )?products?\b(?! per page)/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n <= 10);
  const selectCount = Math.max(0, ...[...steps.matchAll(/select (?:the same )?(\d+)/gi)].map((m) => Number(m[1])), /mixed selection/i.test(data) ? 2 : 0);
  const many = Math.max(selectCount, /test products?|products? (that has |with )no orders/i.test(text) ? Math.max(1, ...counts.filter((n) => n <= 5)) : 0);

  // "Locate a product marked Variable" in a bug report looks at the store's own products; only test cases that act on one get a fixture.
  // A bug report that only says "Locate a product marked with the Variable tag" looks at the store's own products;
  // test cases that act on one ("Find a Variable product … click 'View variants'") get their own.
  const onlyLooks = /\blocate\b[^.\n]*\bmarked\b[^.\n]*\bvariable\b/i.test(steps) && !/view variants|variants?:/i.test(text);
  if (/variable product|variants?:|view variants/i.test(text) && !onlyLooks) {
    add('Variable', { product_type: 'variable', price: null, variant_axes: ['Weight'], variants: VARIANTS });
  }
  if (/\b(\d+)-character name/i.test(text)) {
    const n = Number(text.match(/\b(\d+)-character name/i)![1]);
    add('Long', { current_stock: 1, __nameLength: n });
  }
  if (/one (product )?with barcode, one without|barcode is empty/i.test(text)) {
    add('With Barcode', { barcode: '5901234123457', price: 250 });
    add('No Barcode', { price: 150 });
  }
  const threshold = data.match(/Stock\s*=\s*(\d+)\s*,\s*Low Stock Warning\s*=\s*(\d+)/i);
  if (threshold) add('Boundary', { current_stock: Number(threshold[1]), low_stock_threshold: Number(threshold[2]) });
  if (/track(ing)? inventory\s*=?\s*off|turn off 'track inventory'/i.test(text)) add('Untracked', { current_stock: 0, track_inventory: false });

  // A Bangla search or Bangla export needs a product with a Bangla name; the store may not have one.
  const bangla = /\bbangla\b(?!desh)/i.test(text) ? `${plan.values.find((v) => /[\u0980-\u09FF]/.test(v)) ?? 'ইলিশ'} মাছ` : null;
  for (let i = plan.products.length; i < many; i++) add(i === many - 1 && bangla ? bangla : `Item ${i + 1}`, { current_stock: 5 });
  if (bangla && !plan.products.some((p) => p.suffix === bangla)) add(bangla, { current_stock: 5 });
  // Any case that changes a product (duplicate, delete, stock, status, edit) gets one of its own.
  if (!plan.products.length && /\b(duplicate|delete|adjust stock|status to inactive)\b|on any product/i.test(steps)) add('Item', { current_stock: /delete/i.test(steps) ? 0 : 5 });
  return plan;
}

/** "'tuna' / 'ইলিশ' / 'SHU-FRI-0100' / 'chap'" → the quoted values; "Rows: 10 / 20" → []. */
function testDataValues(data: string): string[] {
  // Slash-separated alternatives: "'zzqxx123' / ' OR 1=1 -- / <script>alert(1)</script> / '   '".
  // Values may themselves contain quotes (SQL text), so split on " / " first and strip one pair of outer quotes.
  if (/\s\/\s/.test(data) && !/^[A-Z][\w ]*:/.test(data)) {
    const parts = data.split(/\s+\/\s+/).map((p) => p.trim());
    if (parts.some((p) => /^'/.test(p))) return parts.map((p) => (/^'.*'$/s.test(p) && p.length > 1 ? p.slice(1, -1) : p));
  }
  return quoted(data);
}

export async function applyFixtures(t: CaseContext, plan: Plan): Promise<void> {
  for (const p of plan.products) {
    const { __nameLength, ...fields } = p.fields as Record<string, unknown> & { __nameLength?: number };
    const suffix = __nameLength ? ('Long name ' as string).repeat(40).slice(0, Number(__nameLength) - t.prefix.length - 1) : p.suffix;
    await t.fixtureProduct(suffix, fields);
  }
  if (t.fixtures.length) t.note(`Created test product(s): ${t.fixtures.map((f) => `'${f.name}'`).join(', ')}. They are removed (archived) afterwards.`);
  if (plan.needsOrdered) t.orderedProduct = await borrowOrderedProduct(t);
}

/** A real product that has past orders. Restored and re-activated after the case. */
async function borrowOrderedProduct(t: CaseContext): Promise<Product> {
  const candidates = (await t.api.allProducts('status=active')).filter((p) => p.total_sold > 0).sort((a, b) => a.total_sold - b.total_sold);
  for (const p of candidates.slice(0, 10)) {
    const preview = await t.api.deletionPreview(p.id).catch(() => null);
    if (preview?.in_orders) {
      t.note(`Used real product '${p.name}' (${preview.order_count} past orders). It is restored and re-activated afterwards.`);
      t.orderedSample = (await t.api.productOrders(p.id).catch(() => ({ orders: [] }))).orders[0];
      t.onCleanup(async () => {
        await t.api.restoreProduct(p.id).catch(() => undefined);
        await t.api.bulk([p.id], 'activate');
      });
      return p;
    }
  }
  return t.block('No product with past orders found in the store.');
}

/** A real category, preferring `wanted`; falls back to the biggest one and notes it. */
export async function resolveCategory(t: CaseContext, wanted: string): Promise<string> {
  const categories = await t.api.categories();
  const exact = categories.find((c) => lc(c.name) === lc(wanted));
  if (exact) return exact.name;
  const fallback = categories.filter((c) => c.products_count > 0).sort((a, b) => b.products_count - a.products_count)[0];
  if (!fallback) return t.block(`Category '${wanted}' does not exist and the store has no categories with products.`);
  t.note(`Category '${wanted}' from the sheet does not exist in this store; used '${fallback.name}' instead.`);
  return fallback.name;
}

export async function emptyCategory(t: CaseContext): Promise<string> {
  const existing = (await t.api.categories()).find((c) => c.products_count === 0);
  if (existing) return existing.name;
  const created = await t.fixtureCategory('Empty');
  t.note(`No empty category existed; created '${created.name}'.`);
  return created.name;
}
