import type { CaseScript, CaseContext } from '../runner.js';
import { pctOk } from './util.js';

async function cardsAndApi(t: CaseContext) {
  await t.products.open();
  const k = await t.products.kpis();
  const api = (await t.api.listProducts('per_page=1')).meta.kpis;
  return { k, api };
}

export const summaryCases: Record<string, CaseScript> = {
  // Card numbers match the product list
  'PL-006': async (t) => {
    const { k } = await cardsAndApi(t);
    await t.shot('cards');
    await t.products.clickStatusTab('All');
    const all = (await t.products.showing())?.total ?? null;
    t.check("Total Products equals the 'All' tab count", k.total === all, `card ${k.total}, All list ${all}`,
      'The card and the list use different queries (e.g. the card counts archived or draft products).');

    await t.products.filter({ stock: 'Low stock' });
    const low = (await t.products.showing())?.total ?? null;
    await t.products.filter({ stock: 'Out of stock' });
    const out = (await t.products.showing())?.total ?? null;
    await t.shot('out-of-stock-filter');
    t.check('Low stock card equals the Low stock filter count', k.low === low, `card ${k.low}, filter ${low}`,
      'The card and the filter use different low-stock rules (e.g. < vs ≤ threshold, or one ignores untracked products).');
    t.check('Out of stock card equals the Out of stock filter count', k.out === out, `card ${k.out}, filter ${out}`,
      'The card and the filter use different out-of-stock rules (e.g. stock = 0 vs stock ≤ 0).');

    const sum = (k.inStock ?? 0) + (k.low ?? 0) + (k.out ?? 0);
    const lowCountedInStock = (k.inStock ?? 0) + (k.out ?? 0) === k.total;
    t.check('In stock + Low stock + Out of stock = Total Products', sum === k.total,
      `${k.inStock} in stock + ${k.low} low + ${k.out} out = ${sum}, total ${k.total}` + (lowCountedInStock ? ' (low-stock items appear to be counted inside "in stock")' : ''),
      "'N in stock' includes low-stock products, so the three buckets overlap. Either exclude low stock from 'in stock' or label it 'available'.");
    t.skip('Coloured bar shows the same split', 'The bar has no readable values; compare the screenshot by eye.');
  },

  // Cards update after stock or status changes
  'PL-007': async (t) => {
    const a = await t.fixtureProduct('Low', { current_stock: 10, low_stock_threshold: 5 });
    const b = await t.fixtureProduct('Out', { current_stock: 10, low_stock_threshold: 5 });
    const c = await t.fixtureProduct('Inactive', { current_stock: 10, low_stock_threshold: 5 });
    t.note(`Created test products '${a.name}', '${b.name}', '${c.name}' (stock 10, threshold 5).`);

    const before = (await cardsAndApi(t)).k;
    await t.products.search(t.prefix);
    await t.products.adjustStock(a.name, 'Stock Out', 7); // 10 → 3, below threshold 5
    await t.products.adjustStock(b.name, 'Stock Out', 10); // 10 → 0
    await t.products.row(c.name).getByLabel('Toggle status').click();
    await t.page.waitForTimeout(1_500);
    await t.page.reload({ waitUntil: 'networkidle' });
    await t.products.waitForList();
    await t.page.getByPlaceholder('Search products…').fill('');
    await t.page.waitForTimeout(1_500);
    const after = await t.products.kpis();
    await t.shot('cards-after');

    t.check('Low stock increases by 1', after.low === (before.low ?? 0) + 1, `${before.low} → ${after.low}`,
      'Low-stock count is cached or not recalculated after a stock adjustment.');
    t.check('Out of stock increases by 1', after.out === (before.out ?? 0) + 1, `${before.out} → ${after.out}`,
      'Out-of-stock count is cached or not recalculated after a stock adjustment.');
    t.check('Active decreases by 1', after.active === (before.active ?? 0) - 1, `${before.active} → ${after.active}`,
      'Active count is cached or the status toggle did not save.');
    const total = after.total ?? 0;
    const pctFine = pctOk(after.activePct, after.active ?? 0, total) && pctOk(after.lowPct, after.low ?? 0, total) && pctOk(after.outPct, after.out ?? 0, total);
    t.check("'x% of catalog' percentages are recalculated correctly", pctFine,
      `active ${after.activePct}% (${after.active}/${total}), low ${after.lowPct}% (${after.low}/${total}), out ${after.outPct}% (${after.out}/${total})`,
      'Percentages are computed from a stale or different total.');
  },

  // Boundary: stock equal to the low-stock threshold
  'PL-008': async (t) => {
    const p = await t.fixtureProduct('Boundary', { current_stock: 5, low_stock_threshold: 5 });
    t.note(`Created '${p.name}' with stock 5 and Low Stock Warning 5.`);
    await t.products.open();
    const inFilter = !!(await t.findProduct(p.name, 'stock=low'));
    await t.products.search(p.name);
    await t.products.filter({ stock: 'Low stock' });
    const uiFilter = (await t.products.rows()).some((r) => r.name === p.name);
    await t.shot('low-stock-filter');
    const fromApi = await t.findProduct(p.name);
    t.note(`API flags for stock=threshold: is_low_stock=${fromApi?.is_low_stock}, filter includes it: ${inFilter}.`);
    t.check('Card and filter treat stock = threshold the same way', fromApi?.is_low_stock === uiFilter,
      `card rule (is_low_stock) = ${fromApi?.is_low_stock}, Low stock filter shows it = ${uiFilter}`,
      'The KPI query and the filter query use different comparisons (< vs ≤). Use one shared scope for "low stock".');
    t.check("Product counts as Low stock when stock ≤ threshold", uiFilter,
      uiFilter ? 'listed under Low stock' : 'not listed under Low stock',
      'Low stock is defined as stock < threshold; the sheet expects ≤.');
  },

  // Products without stock tracking are not counted as low/out of stock
  'PL-009': async (t) => {
    const p = await t.fixtureProduct('Untracked', { current_stock: 0, track_inventory: false, low_stock_threshold: 5 });
    t.note(`Created '${p.name}' with Track Inventory off and stock 0.`);
    const low = !!(await t.findProduct(p.name, 'stock=low'));
    const out = !!(await t.findProduct(p.name, 'stock=out'));
    await t.products.open();
    await t.products.search(p.name);
    await t.shot('untracked-row');
    const row = (await t.products.rows()).find((r) => r.name === p.name);
    t.check('Untracked product is not counted as Low stock', !low, low ? 'counted as low stock' : 'not counted',
      'The low-stock scope does not exclude track_inventory = false.');
    t.check('Untracked product is not counted as Out of stock', !out && !/Out of stock/i.test(row?.stock ?? ''),
      `filter ${out ? 'includes' : 'excludes'} it; row shows "${row?.stock}"`,
      'The out-of-stock scope or the row badge does not exclude track_inventory = false.');
  },
};
