import type { CaseScript } from '../runner.js';
import { list, orderBreak, pickCategory } from './util.js';

const SORT_OPTIONS = ['Newest first', 'Oldest first', 'Recently updated', 'Name (A–Z)', 'Name (Z–A)'];
const LIST_COLUMNS = ['SL', 'PRODUCT', 'PRICE', 'STOCK', 'SKU', 'CATEGORY', 'BRAND', 'SOLD', 'STATUS', 'ACTIONS'];

export const sortFilterViewCases: Record<string, CaseScript> = {
  // Sort options order the list correctly
  'PL-015': async (t) => {
    await t.products.open();
    const options = await t.products.sortOptions();
    t.check(`Sort options are: ${SORT_OPTIONS.join(', ')}`, SORT_OPTIONS.every((o, i) => options[i] === o) && options.length === SORT_OPTIONS.length,
      `found: ${list(options)}`);

    for (const [option, dir] of [['Name (A–Z)', 'asc'], ['Name (Z–A)', 'desc']] as const) {
      await t.products.sort(option);
      const names = (await t.products.rows()).map((r) => r.name);
      const at = orderBreak(names, dir);
      t.check(`'${option}' orders page 1 correctly`, at < 0, at < 0 ? `${names.length} rows in order` : `'${names[at - 1]}' comes before '${names[at]}'`,
        'Sorting is done in the database with a collation that differs from natural order (e.g. case-sensitive or byte order). Sort with a case-insensitive collation.');
    }
    await t.shot('name-z-a');

    // Date-based sorts: compare with the API's own order for the same sort key.
    for (const [option, key] of [['Newest first', 'created_at:desc'], ['Oldest first', 'created_at:asc'], ['Recently updated', 'updated_at:desc']] as const) {
      await t.products.sort(option);
      const ui = (await t.products.rows()).map((r) => r.name);
      const api = (await t.api.listProducts(`sort=${encodeURIComponent(key)}&per_page=20`)).data.map((p) => p.name);
      const same = ui.length === api.length && ui.every((n, i) => n === api[i]);
      t.check(`'${option}' re-orders the list`, same, same ? 'matches the server order' : `UI first 3: ${list(ui.slice(0, 3))}; server: ${list(api.slice(0, 3))}`);
    }

    await t.products.sort('Name (A–Z)');
    const page1 = (await t.products.rows()).map((r) => r.name);
    const pager = await t.products.pager();
    if (pager['Next page'] === false) {
      await t.products.clickPager('Next page');
      const page2 = (await t.products.rows()).map((r) => r.name);
      const joined = [...page1, ...page2];
      const at = orderBreak(joined, 'asc');
      t.check('Page 2 continues the same order', at < 0 && page2.length > 0,
        at < 0 ? `last on page 1 '${page1.at(-1)}', first on page 2 '${page2[0]}'` : `break at '${joined[at - 1]}' → '${joined[at]}'`,
        'Sort is applied per page on the client instead of in the server query.');
    } else {
      t.skip('Page 2 continues the same order', 'Only one page of products.');
    }
  },

  // Filter by stock and category
  'PL-016': async (t) => {
    const category = await pickCategory(t, 'Shutki (Dried Fish)');
    await t.products.open();
    const total = (await t.products.showing())?.total;
    const filterBefore = await t.products.filterButtonText();

    await t.products.filter({ stock: 'Low stock' });
    const lowApi = (await t.api.allProducts('stock=low')).map((p) => p.name);
    const lowUi = (await t.products.rows()).map((r) => r.name);
    const notLow = lowUi.filter((n) => !lowApi.includes(n));
    t.check('Stock = Low stock shows only low-stock products', !notLow.length && lowUi.length === lowApi.length,
      `${lowUi.length} shown${notLow.length ? `; not low: ${list(notLow)}` : ''}`);
    const filterAfter = await t.products.filterButtonText();
    t.check('Filter button shows that a filter is active', filterAfter !== filterBefore,
      `before "${filterBefore}", after "${filterAfter}"`,
      'The Filter button has no active indicator; show a badge or count when filters are applied.');

    await t.products.filter({ category: category.name });
    await t.shot('low-and-category');
    const rows = await t.products.rows();
    const wrong = rows.filter((r) => r.category !== category.name || !lowApi.includes(r.name)).map((r) => `${r.name} (${r.category})`);
    t.check(`Low stock + '${category.name}' shows only matching products`, !wrong.length, `${rows.length} shown${wrong.length ? `; wrong: ${list(wrong)}` : ''}`,
      'The second filter replaces the first instead of combining with it.');

    await t.products.filter({ stock: 'All Stock', category: 'All Categories' });
    const reset = (await t.products.showing())?.total;
    t.check('Resetting both filters brings back the full list', reset === total, `${reset} of ${total}`);
  },

  // Filter that returns no products
  'PL-017': async (t) => {
    const categories = await t.api.categories();
    let empty = categories.find((c) => c.products_count === 0);
    if (!empty) {
      empty = { ...(await t.fixtureCategory('Empty')), products_count: 0 };
      t.note(`No empty category existed; created '${empty.name}'.`);
    }
    await t.products.open();
    await t.page.reload({ waitUntil: 'networkidle' });
    await t.products.waitForList();
    await t.products.filter({ category: empty.name });
    await t.shot('empty-category');
    const showing = await t.products.showing();
    const message = await t.products.emptyStateText();
    t.check('Empty-state message is shown with no error', !!message && !t.failedRequests.some((r) => r.startsWith('5')), message ?? 'no message');
    t.check("Pagination shows 'Showing 0–0 of 0'", showing?.text === 'Showing 0–0 of 0', showing?.text ?? 'no pagination text');
  },

  // Switch between Grid and List view
  'PL-018': async (t) => {
    await t.products.open('grid');
    await t.products.setView('list');
    const columns = await t.products.columns();
    const missing = LIST_COLUMNS.filter((c) => !columns.includes(c));
    t.check(`List view shows columns ${LIST_COLUMNS.join(', ')}`, !missing.length,
      `found: ${list(columns)}${missing.length ? `; missing: ${list(missing)}` : ''}`);

    await t.products.setView('grid');
    const cards = await t.products.main.getByRole('button', { name: 'More details' }).filter({ visible: true }).count();
    await t.shot('grid');
    t.check('Grid view shows product cards', cards > 0 && (await t.products.columns()).length === 0, `${cards} cards`);

    await t.products.setView('list');
    await t.page.reload({ waitUntil: 'networkidle' });
    await t.products.waitForList();
    const view = await t.products.currentView();
    t.check('Chosen view stays the same after refresh', view === 'list', `after refresh: ${view}`,
      'View choice is not persisted (or is overwritten on load).');
  },

  // Rows per page and page navigation
  'PL-019': async (t) => {
    await t.products.open();
    const total = (await t.products.showing())?.total ?? 0;
    for (const n of [10, 50, 100]) {
      await t.products.setRows(n);
      const rows = (await t.products.rows()).length;
      t.check(`Rows = ${n} shows ${Math.min(n, total)} products`, rows === Math.min(n, total), `${rows} shown`);
    }
    await t.products.setRows(20);
    const onFirst = await t.products.pager();
    t.check('Previous/First are disabled on page 1', onFirst['First page'] === true && onFirst['Previous page'] === true,
      `First ${onFirst['First page'] ? 'disabled' : 'enabled'}, Previous ${onFirst['Previous page'] ? 'disabled' : 'enabled'}`);
    if (total <= 20) {
      t.skip('Next / Previous / Last / First navigation', `Only ${total} products — one page at 20 rows.`);
    } else {
      await t.products.clickPager('Next page');
      const p2 = await t.products.showing();
      t.check('Next goes to page 2', p2?.from === 21, p2?.text ?? 'n/a');
      await t.products.clickPager('Previous page');
      t.check('Previous goes back to page 1', (await t.products.showing())?.from === 1, (await t.products.showing())?.text ?? 'n/a');
      const lastButton = t.page.getByLabel('Last page', { exact: true });
      const cover = await t.products.coveredBy(lastButton);
      if (cover) await t.shot('last-page-covered');
      t.check("'Last page' button can be clicked", !cover, cover ? `covered by '${cover}'` : 'not covered',
        "A floating button sits on top of the pager at this window size; add bottom padding to the list or move the floating button.");
      await t.products.clickPager('Last page');
      const last = await t.products.showing();
      const onLast = await t.products.pager();
      t.check('Last goes to the last page; Next/Last disabled there', last?.to === total && onLast['Next page'] === true && onLast['Last page'] === true,
        `${last?.text}; Next ${onLast['Next page'] ? 'disabled' : 'enabled'}, Last ${onLast['Last page'] ? 'disabled' : 'enabled'}`);

      // Pick a stock filter with only a few products to see if the page resets.
      const low = await t.api.allProducts('stock=low');
      await t.products.filter({ stock: 'Low stock' });
      const afterFilter = await t.products.showing();
      const rows = (await t.products.rows()).length;
      await t.shot('filter-from-last-page');
      t.check(`Applying a filter on the last page returns to page 1 and shows the ${low.length} products`, afterFilter?.from === (low.length ? 1 : 0) && rows === low.length,
        `${afterFilter?.text}, ${rows} rows shown`,
        'The page number is kept when filters change, so the request asks for a page that no longer exists. Reset page to 1 on filter change.');
      await t.products.clickPager('First page').catch(() => undefined);
    }
  },
};
