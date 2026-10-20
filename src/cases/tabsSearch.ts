import type { CaseScript } from '../runner.js';
import { list, rowMatches } from './util.js';

const TAB_STATUS = { Active: 'active', Draft: 'draft', Archived: 'archived' } as const;

export const tabsSearchCases: Record<string, CaseScript> = {
  // Each tab shows only products of that status
  'PL-010': async (t) => {
    await t.products.open();
    for (const tab of ['All', 'Active', 'Draft', 'Archived'] as const) {
      await t.products.clickStatusTab(tab);
      const tabs = await t.products.statusTabs();
      const showing = await t.products.showing();
      const results = await t.products.resultsText();
      const shownCount = showing?.total ?? null;
      t.check(`'${tab}' tab number matches the result count`, tabs[tab]?.count === shownCount,
        `tab says ${tabs[tab]?.count}, list ${showing?.text ?? 'n/a'}${results ? `, "${results}"` : ''}`,
        'Tab counts come from a different query than the list (e.g. counts ignore archived/soft-deleted rules).');
      if (tab !== 'All') {
        const status = TAB_STATUS[tab];
        const apiRows = await t.api.allProducts(`status=${status}`);
        const uiRows = await t.products.rows();
        const wrong = uiRows.filter((r) => !apiRows.some((p) => p.name === r.name)).map((r) => r.name);
        t.check(`'${tab}' tab shows only ${status} products`, !wrong.length,
          wrong.length ? `not ${status}: ${list(wrong)}` : `${uiRows.length} rows, all ${status}`);
      }
      if (shownCount === 0) {
        const empty = await t.products.emptyStateText();
        t.check(`'${tab}' tab with 0 products shows an empty-state message`, !!empty, empty ?? 'no message');
      }
    }
    await t.shot('archived-tab');
  },

  // A newly saved draft appears under the Draft tab
  'PL-011': async (t) => {
    const { config } = await import('../config.js');
    await t.page.goto(`${config.baseUrl}/dashboard/products/new`, { waitUntil: 'networkidle' });
    const draftBtn = t.page.getByRole('button', { name: /^(Save as )?Draft$/i }).filter({ visible: true });
    await t.shot('add-product-form');
    if (!(await draftBtn.count())) {
      const buttons = (await t.page.getByRole('button').filter({ hasText: /Save/ }).allInnerTexts()).map((s) => s.trim());
      t.check("Add Product form has a 'Draft' button", false, `only these save buttons exist: ${list(buttons)}`,
        "There is no way to save a draft from the form; the 'Draft' button from the spec is not implemented (only an Active status switch).");
      return;
    }
    await t.products.open();
    const before = (await t.products.statusTabs()).Draft?.count ?? 0;
    await t.page.goto(`${config.baseUrl}/dashboard/products/new`, { waitUntil: 'networkidle' });
    await t.page.getByPlaceholder('Ex: Samsung Galaxy A54').fill(`${t.prefix} Draft Test Soap`);
    await draftBtn.first().click();
    await t.page.waitForTimeout(2_500);
    await t.products.open();
    const after = (await t.products.statusTabs()).Draft?.count ?? 0;
    await t.products.clickStatusTab('Draft');
    const inDraft = (await t.products.rows()).some((r) => r.name.includes('Draft Test Soap'));
    t.check('Product appears under Draft', inDraft, inDraft ? 'listed' : 'not listed');
    t.check('Draft tab count increases by 1', after === before + 1, `${before} → ${after}`);
  },

  // Search finds products by name, Bangla name and SKU
  'PL-012': async (t) => {
    const banglaFixture = await t.fixtureProduct('ইলিশ মাছ');
    t.note(`Created '${banglaFixture.name}' to test Bangla search (the store has no Bangla product names).`);
    const all = (await t.api.allProducts()).filter((p) => !p.name.startsWith(t.prefix));
    const sample = all.find((p) => p.name.split(' ')[0].length >= 4 && p.sku) ?? all[0];
    const word = sample.name.split(' ')[0];
    const partial = word.slice(1, 4);
    const terms: [string, string][] = [
      ['English name', sample.name.toUpperCase()],
      ['SKU', sample.sku],
      ['Part of a name', partial.toLowerCase()],
    ];
    await t.products.open();
    for (const [label, term] of terms) {
      await t.products.search(term);
      const rows = await t.products.rows();
      const shownIt = label === 'SKU' ? rows.some((r) => r.sku === sample.sku) : rows.some((r) => r.name === sample.name);
      const extra = rows.filter((r) => !rowMatches(r, term)).map((r) => r.name);
      t.check(`Search by ${label} ('${term}') finds the product`, shownIt, `${rows.length} result(s)${shownIt ? '' : `, '${sample.name}' missing`}`,
        label === 'Part of a name' ? 'Search matches whole words or prefixes only; use a contains match (ILIKE %term%).' : 'Search does not cover this field or is case-sensitive.');
      t.check(`Search by ${label} shows only matching products`, !extra.length, extra.length ? `non-matching: ${list(extra.slice(0, 5))}` : 'all match',
        'Search also matches hidden fields (description, variant names); if intended, highlight why each row matched.');
    }
    await t.shot('search-partial');
    await t.products.search('ইলিশ');
    const foundBangla = (await t.products.rows()).some((r) => r.name === banglaFixture.name);
    t.check("Search by Bangla name ('ইলিশ') finds the product", foundBangla, foundBangla ? 'found' : 'not found',
      'Unicode search is broken — check DB collation / lower() handling for Bangla.');
  },

  // Search with no match or with invalid/special text
  'PL-013': async (t) => {
    await t.products.open();
    const total = (await t.products.showing())?.total ?? 0;
    let dialogFired = false;
    t.page.on('dialog', async (d) => { dialogFired = true; await d.dismiss(); });

    await t.products.search('zzqxx123');
    const empty = await t.products.emptyStateText();
    const results = await t.products.resultsText();
    const showing = (await t.products.showing())?.text;
    t.check("No-match search shows a '0 results' empty state", !!empty && (results === '0 results' || showing === 'Showing 0–0 of 0'),
      `${results ?? showing ?? 'no count'}; ${empty ?? 'no empty-state message'}`);

    for (const term of ["' OR 1=1 --", '<script>alert(1)</script>']) {
      const failedBefore = t.failedRequests.length;
      await t.products.search(term);
      const serverError = t.failedRequests.slice(failedBefore).some((r) => r.startsWith('5'));
      const rows = await t.products.rows();
      t.check(`'${term}' is treated as normal text (no server error)`, !serverError && rows.length < total,
        `${rows.length} result(s)${serverError ? ', server error' : ''}`,
        'Search input reaches the query unescaped — use parameter binding.');
    }
    t.check('No pop-up runs for the script tag', !dialogFired, dialogFired ? 'alert() ran — XSS' : 'no pop-up',
      'Search text is rendered as HTML (dangerouslySetInnerHTML / v-html). Render as text.');

    await t.products.search('   ');
    const spaces = (await t.products.showing())?.total;
    await t.shot('spaces-search');
    t.check('Only spaces behaves like an empty search (full list)', spaces === total, `${spaces} of ${total}`,
      'The search term is not trimmed before being sent.');
  },

  // Search works together with tabs and filters
  'PL-014': async (t) => {
    const { pickCategory } = await import('./util.js');
    const category = await pickCategory(t, 'Fresh Fish');
    const inCat = (await t.api.allProducts(`category_id=${category.id}&status=active`));
    if (!inCat.length) return t.block(`No active products in '${category.name}'.`);
    const term = inCat[0].name.split(' ')[0].toUpperCase();
    t.note(`Search term '${term}' (taken from '${inCat[0].name}').`);

    await t.products.open();
    await t.products.clickStatusTab('Active');
    await t.products.filter({ category: category.name });
    await t.products.search(term);
    await t.shot('combined');
    const rows = await t.products.rows();
    const expected = inCat.filter((p) => p.name.toUpperCase().includes(term) || p.sku.toUpperCase().includes(term)).map((p) => p.name);
    const wrong = rows.filter((r) => r.category !== category.name || !rowMatches(r, term)).map((r) => `${r.name} (${r.category})`);
    const missing = expected.filter((n) => !rows.some((r) => r.name === n));
    t.check(`Only Active + '${category.name}' + '${term}' products are shown`, !wrong.length && !missing.length,
      `${rows.length} shown${wrong.length ? `; outside the filters: ${list(wrong)}` : ''}${missing.length ? `; missing: ${list(missing)}` : ''}`,
      'One of the conditions is dropped when combined — check the query builds all of status, category_id and q together.');
    const tabs = await t.products.statusTabs();
    t.check("'Active' tab stays selected", tabs.Active?.active === true, `selected tab: ${Object.entries(tabs).find(([, v]) => v.active)?.[0]}`);
  },
};
