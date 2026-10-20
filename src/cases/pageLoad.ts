import { config } from '../config.js';
import type { CaseScript } from '../runner.js';
import { list } from './util.js';

export const pageLoadCases: Record<string, CaseScript> = {
  // Products page opens with all main elements
  'PL-001': async (t) => {
    await t.products.open();
    await t.shot('products-page');
    const p = t.products;
    const main = p.main;

    const titleOk = await p.isVisible(main.getByRole('heading', { name: 'Products', exact: true }).or(main.getByText('Products', { exact: true })));
    const subOk = await p.isVisible(main.getByText('Manage your product catalog', { exact: true }));
    t.check("Title 'Products' and text 'Manage your product catalog' are shown", titleOk && subOk,
      `title ${titleOk ? 'shown' : 'missing'}, subtitle ${subOk ? 'shown' : 'missing'}`,
      'Page header component did not render; check the products page layout.');

    const wanted = ['Bulk Create', 'Breakdown', 'Add Product'];
    const missing: string[] = [];
    for (const name of wanted) if (!(await p.isVisible(p.button(name)))) missing.push(name);
    t.check(`Buttons ${wanted.map((w) => `'${w}'`).join(', ')} are visible`, !missing.length,
      missing.length ? `missing: ${list(missing)}` : 'all visible',
      'Header actions are hidden — usually a permission or feature-flag check, or a breakpoint-specific class (e.g. md:hidden) hiding it at this width.');

    const tabs = ['Products', 'Pre-orders', 'Sizes & colours', 'Media', 'Reviews'];
    const tabState = await t.page.evaluate((names) => names.map((n) => {
      const el = [...document.querySelectorAll('main a, main button')].find((e) => (e as HTMLElement).innerText.trim() === n && (e as HTMLElement).offsetParent) as HTMLElement | undefined;
      return { n, found: !!el, current: el?.getAttribute('aria-current') === 'page' || el?.getAttribute('aria-selected') === 'true' };
    }), tabs);
    const missingTabs = tabState.filter((x) => !x.found).map((x) => x.n);
    t.check(`Tabs ${tabs.join(', ')} are visible`, !missingTabs.length, missingTabs.length ? `missing: ${list(missingTabs)}` : 'all visible');
    const highlighted = tabState.filter((x) => x.current).map((x) => x.n);
    t.check("'Products' tab is highlighted", highlighted.length === 1 && highlighted[0] === 'Products', `highlighted: ${list(highlighted)}`,
      'Active-tab logic compares the wrong path; it should match /dashboard/products exactly.');
  },

  // Empty store shows a proper empty state
  'PL-002': async (t) => {
    const stores = await t.api.request<{ stores: { id: number; name: string }[] }>('GET', '/auth/me');
    let empty: { id: number; name: string } | undefined;
    for (const s of stores.stores) {
      const r = await fetch(`${config.apiUrl}/catalog/products?per_page=1`, { headers: { Authorization: `Bearer ${t.session.token}`, 'X-Store-Id': String(s.id), Accept: 'application/json' } });
      if (r.ok && (await r.json()).meta?.total === 0) { empty = s; break; }
    }
    if (!empty) return t.block('None of this account\'s stores has 0 products. Create an empty store to run this case.');
    t.note(`Used store '${empty.name}', which has 0 products.`);

    await t.products.open();
    await t.products.open();
    await t.products.page.getByLabel('Store and account').filter({ visible: true }).first().click();
    await t.page.locator('[data-radix-popper-content-wrapper], [role=menu]').getByText(empty.name, { exact: true }).first().click();
    await t.page.waitForLoadState('networkidle');
    await t.products.waitForList();
    await t.page.waitForTimeout(800);
    await t.shot('empty-store-first-view');
    if (await t.products.dismissOnboarding()) t.note("The empty store opens a 'Set up your shop' wizard over the page; it was closed to check the page behind it.");
    await t.shot('empty-store');
    const k = await t.products.kpis();
    const nums = [k.total, k.active, k.low, k.out];
    const pcts = [k.activePct, k.lowPct, k.outPct];
    t.check('Summary cards show 0 with no NaN or blank values',
      nums.every((n) => n === 0) && !/NaN|undefined|Infinity/.test(k.raw), `cards: "${k.raw}"`,
      'A card is computed as count/total without guarding total = 0.');
    t.check("Cards show '0%' under each count", pcts.every((n) => n === 0),
      pcts.every((n) => n === null) ? "no '% of catalog' line is shown when the store is empty" : `percentages: ${pcts.join(', ')}`,
      "The '% of catalog' line is hidden when total is 0; render '0% of catalog' instead, as the spec expects.");
    const emptyText = await t.products.emptyStateText();
    const addVisible = await t.products.isVisible(t.products.main.getByText(/Add Product/i));
    t.check("Empty-state message with an 'Add Product' option replaces the grid", !!emptyText && addVisible,
      `empty state: ${emptyText ?? 'none'}; Add Product option ${addVisible ? 'present' : 'missing'}`,
      'The list renders the generic "no results" state instead of a first-run empty state with a call to action.');

    await t.products.useStore(t.session.storeId);
  },

  // Page cannot be opened without permission
  'PL-003': async (t) => {
    const page = await t.newPage({ loggedOut: true });
    await page.goto(`${config.baseUrl}/dashboard/products`, { waitUntil: 'networkidle' });
    await t.shot('logged-out', page);
    const url = new URL(page.url());
    const leaked = await page.locator('main').innerText().then((s) => /SKU-|৳\d/.test(s)).catch(() => false);
    t.check('Logged-out user is redirected to the login page', url.pathname.startsWith('/login') && !leaked,
      `landed on ${url.pathname}${leaked ? ' and product data was visible' : ''}`,
      'The dashboard route guard is missing or runs after data is fetched.');
    t.skip('Staff user without Products permission sees Access denied / hidden menu',
      'No staff account without Products permission was provided; add its credentials to run this part.');
  },

  // Page handles a network/server failure
  'PL-004': async (t) => {
    await t.products.open();
    await t.page.route(/\/catalog\/products\?/, (route) => route.abort('internetdisconnected'));
    await t.page.reload({ waitUntil: 'domcontentloaded' });
    await t.page.waitForTimeout(6_000);
    await t.shot('products-request-blocked');
    const text = await t.products.text();
    const errorShown = /error|failed|couldn.?t|could not|try again|offline|connection/i.test(text);
    const retry = t.products.main.getByRole('button', { name: /retry|try again|reload/i });
    const retryVisible = await t.products.isVisible(retry);
    const misleading = /\b0 results\b|Nothing found|Showing 0–0 of 0/.test(text);
    t.check("A clear error message with a 'Retry' option is shown", errorShown && retryVisible,
      `error text ${errorShown ? 'present' : 'absent'}, retry button ${retryVisible ? 'present' : 'absent'}${misleading ? '; page shows an empty "0 results" list instead' : ''}`,
      'The products query error state is not handled: the list falls back to an empty state, so a failure looks like "no products". Render the query error with a retry button.');
    const blank = text.trim().length < 50;
    t.check('Page does not go blank or freeze', !blank, blank ? 'page is blank' : 'page still rendered');

    await t.page.unroute(/\/catalog\/products\?/);
    if (retryVisible) await t.products.afterListReload(() => retry.first().click());
    else await t.page.reload({ waitUntil: 'networkidle' });
    const showing = await t.products.showing();
    t.check('Page loads normally after the connection is back', !!showing && showing.total > 0,
      showing ? showing.text : 'list did not load', 'The page does not recover after a failed load.');
  },

  // Only the selected store's products are shown
  'PL-005': async (t) => {
    const me = await t.api.request<{ stores: { id: number; name: string }[] }>('GET', '/auth/me');
    const other = me.stores.find((s) => s.id !== t.session.storeId);
    const current = me.stores.find((s) => s.id === t.session.storeId)!;
    if (!other) return t.block('The account has only one store.');

    await t.products.open();
    const before = await t.products.rows();
    const kBefore = await t.products.kpis();
    await t.products.switchStore(other.name);
    await t.shot('other-store');
    const after = await t.products.rows();
    const kAfter = await t.products.kpis();

    const theirs = await fetch(`${config.apiUrl}/catalog/products?per_page=100`, { headers: { Authorization: `Bearer ${t.session.token}`, 'X-Store-Id': String(other.id), Accept: 'application/json' } }).then((r) => r.json());
    const theirNames = new Set<string>(theirs.data.map((p: { name: string }) => p.name));
    const leaked = after.filter((r) => !theirNames.has(r.name)).map((r) => r.name);
    t.check(`Only '${other.name}' products are shown after switching`, !leaked.length,
      leaked.length ? `products not belonging to '${other.name}': ${list(leaked.slice(0, 5))}` : `${after.length} rows, all belong to '${other.name}'`,
      'The list query is cached without the store id in its key, so the previous store\'s rows survive the switch.');
    t.check('Summary cards change to the selected store', kAfter.total === theirs.meta.total,
      `${current.name}: ${kBefore.total} total → ${other.name}: ${kAfter.total} (API says ${theirs.meta.total})`,
      'Summary cards are cached per page rather than per store.');
    const overlap = before.filter((r) => after.some((a) => a.name === r.name)).map((r) => r.name);
    t.check(`No product from '${current.name}' appears`, !overlap.length || overlap.every((n) => theirNames.has(n)),
      overlap.length ? `shared names: ${list(overlap.slice(0, 5))}` : 'no overlap');

    await t.products.useStore(current.id);
  },
};

