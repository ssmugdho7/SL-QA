import path from 'path';
import type { CaseScript, CaseContext } from '../runner.js';
import { list, pickCategory, readCsv } from './util.js';

const BAR_BUTTONS = ['Clear selection', 'Export', 'Activate', 'Deactivate', 'Bulk edit', 'Change category / brand / labels', 'Copy SKUs', 'Print barcodes', 'Delete'];

async function threeFixtures(t: CaseContext, names = ['One', 'Two', 'Three']) {
  const items = [];
  for (const n of names) items.push(await t.fixtureProduct(`Bulk ${n}`, { current_stock: 5 }));
  await t.products.open();
  await t.products.search(t.prefix);
  for (const p of items) await t.products.selectRow(p.name);
  return items;
}

export const bulkCases: Record<string, CaseScript> = {
  // Selecting products shows the bulk action bar
  'PL-028': async (t) => {
    await t.products.open();
    await t.products.setRows(20);
    const first = (await t.products.rows())[0];
    await t.products.selectRow(first.name);
    await t.page.waitForTimeout(400);
    const buttons = await t.products.bulkBarButtons();
    await t.shot('one-selected');
    t.check("Ticking one product shows '1 selected'", (await t.products.selectedCount()) === 1, `${await t.products.selectedCount()} selected`);
    const missing = BAR_BUTTONS.filter((b) => !buttons.includes(b));
    t.check(`Bar has: ${BAR_BUTTONS.join(', ')}`, !missing.length, `found: ${list(buttons)}${missing.length ? `; missing: ${list(missing)}` : ''}`);

    await t.page.getByLabel('Select this page').filter({ visible: true }).first().check();
    await t.page.waitForTimeout(400);
    const all = await t.products.selectedCount();
    t.check("'Select this page' shows '20 selected'", all === 20, `${all} selected`);

    await t.products.bulkBar().getByRole('button', { name: 'Clear selection', exact: true }).click();
    await t.page.waitForTimeout(400);
    const checked = await t.products.main.locator('tbody input[type=checkbox]:checked').count();
    const barGone = !(await t.products.bulkBar().isVisible().catch(() => false));
    t.check("'Clear selection' unticks all and hides the bar", checked === 0 && barGone, `${checked} still ticked, bar ${barGone ? 'hidden' : 'visible'}`);
  },

  // Bulk activate, deactivate and change category
  'PL-029': async (t) => {
    const items = await threeFixtures(t);
    const ids = items.map((p) => p.id);
    const k0 = await t.products.kpis();

    await t.products.bulkBar().getByRole('button', { name: 'Deactivate', exact: true }).click();
    await t.products.confirm(/Deactivate|Confirm/);
    await t.page.waitForTimeout(1_000);
    const afterOff = await Promise.all(ids.map((id) => t.api.getProduct(id)));
    const k1 = await t.products.kpis();
    t.check('All 3 products become inactive', afterOff.every((p) => !p.is_active), afterOff.map((p) => `${p.name.replace(t.prefix + ' ', '')}: ${p.is_active ? 'active' : 'inactive'}`).join(', '));
    t.check('Active card drops by 3', k1.active === (k0.active ?? 0) - 3, `${k0.active} → ${k1.active}`, 'The Active card is not refreshed after a bulk action.');

    if (!(await t.products.bulkBar().isVisible().catch(() => false))) for (const p of items) await t.products.selectRow(p.name);
    await t.products.bulkBar().getByRole('button', { name: 'Activate', exact: true }).click();
    await t.products.confirm(/Activate|Confirm/);
    await t.page.waitForTimeout(1_000);
    const afterOn = await Promise.all(ids.map((id) => t.api.getProduct(id)));
    const k2 = await t.products.kpis();
    t.check('All 3 products become active again', afterOn.every((p) => p.is_active), afterOn.map((p) => (p.is_active ? 'active' : 'inactive')).join(', '));
    t.check('Active card rises by 3', k2.active === (k1.active ?? 0) + 3, `${k1.active} → ${k2.active}`);

    const category = await pickCategory(t, 'Fish');
    if (!(await t.products.bulkBar().isVisible().catch(() => false))) for (const p of items) await t.products.selectRow(p.name);
    await t.products.bulkBar().getByRole('button', { name: 'Change category / brand / labels', exact: true }).click();
    const dlg = t.products.dialog();
    await dlg.getByRole('combobox').first().click();
    await t.page.getByRole('option', { name: category.name, exact: true }).click();
    await dlg.getByRole('button', { name: 'Apply' }).click();
    await t.page.waitForTimeout(1_500);
    await t.shot('after-category-change');
    const moved = await Promise.all(ids.map((id) => t.api.getProduct(id)));
    t.check(`All 3 move to '${category.name}'`, moved.every((p) => p.category?.id === category.id), moved.map((p) => p.category?.name ?? '—').join(', '));
    const unchanged = moved.every((p, i) => p.name === items[i].name && p.sku === items[i].sku && Number(p.price) === Number(items[i].price));
    t.check('Their other details do not change', unchanged, unchanged ? 'name, SKU, price unchanged' : 'details changed');
  },

  // Bulk delete, export and copy SKUs
  'PL-030': async (t) => {
    const items = await threeFixtures(t, ['One', 'Two', 'ইলিশ মাছ']);
    await t.products.bulkBar().getByRole('button', { name: 'Copy SKUs', exact: true }).click();
    await t.products.dialog().getByRole('button', { name: 'Copy list' }).click();
    await t.page.waitForTimeout(600);
    const clip = await t.page.evaluate(() => navigator.clipboard.readText().catch(() => (window as any).__btbClipboard?.at(-1) ?? ''));
    const missingSkus = items.filter((p) => !clip.includes(p.sku)).map((p) => p.sku);
    t.check('The 3 SKUs are copied correctly', !missingSkus.length, `clipboard: ${JSON.stringify(clip.slice(0, 120))}`);
    await t.page.keyboard.press('Escape');
    await t.page.waitForTimeout(400);

    const file = await t.products.download(t.products.bulkBar().getByRole('button', { name: 'Export', exact: true }), 'CSV (.csv)', path.join(t.runDir, 'downloads'));
    if (!file) {
      t.check('Export downloads a file', false, 'no download started');
    } else {
      const rows = readCsv(file);
      const names = rows.map((r) => Object.values(r).join(' '));
      const exact = rows.length === 3 && items.every((p) => names.some((n) => n.includes(p.name)));
      t.check('Export file contains exactly the 3 selected products', exact, `${rows.length} rows in ${path.basename(file)}`);
      const fs = await import('fs');
      const raw = fs.readFileSync(file);
      const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      const banglaIntact = raw.toString('utf8').includes('ইলিশ মাছ');
      t.check('Bangla names are readable in the export', banglaIntact && bom,
        `${banglaIntact ? 'Bangla text intact in UTF-8' : 'Bangla text garbled'}, ${bom ? 'BOM present' : 'no UTF-8 BOM — Excel on Windows will show it as mojibake'}`,
        'Prepend \\uFEFF to CSV exports so Excel detects UTF-8.');
    }

    await t.page.keyboard.press('Escape');
    for (const p of items) {
      const box = t.products.row(p.name).getByLabel('Select row');
      if (await box.isChecked()) await box.uncheck();
    }
    await t.products.selectRow(items[0].name);
    await t.products.selectRow(items[1].name);
    await t.products.bulkBar().getByRole('button', { name: 'Delete', exact: true }).click();
    const text = await t.products.confirm(/Delete/);
    await t.shot('after-bulk-delete');
    t.check("Confirmation says '2 products'", /\b2 (products|item)/i.test(text), text || 'no confirmation',
      "The dialog says '2 item(s)'; use the entity name and proper plural ('2 products').");
    const left = await Promise.all(items.slice(0, 2).map((p) => t.findProduct(p.name)));
    t.check('Both products are deleted', left.every((x) => !x), left.filter(Boolean).length ? 'still listed' : 'both removed');
  },

  // Bulk delete where some products have orders
  'PL-031': async (t) => {
    const fresh = [await t.fixtureProduct('No Orders A'), await t.fixtureProduct('No Orders B')];
    const candidates = (await t.api.allProducts('status=active')).filter((p) => p.total_sold > 0).sort((a, b) => a.total_sold - b.total_sold);
    const ordered = candidates[0];
    if (!ordered) return t.block('No product with orders found.');
    t.note(`Mixed selection: 2 test products + real product '${ordered.name}' (sold ${ordered.total_sold}). The real product is restored and re-activated afterwards.`);
    t.onCleanup(async () => {
      await t.api.restoreProduct(ordered.id).catch(() => undefined);
      await t.api.bulk([ordered.id], 'activate');
    });

    // Selection is cleared when the search changes, so pick all three from one unfiltered page.
    await t.products.open();
    await t.products.setRows(100);
    for (const p of [...fresh, ordered]) await t.products.selectRow(p.name);
    const count = await t.products.selectedCount();
    if (count !== 3) return t.block(`Could not select the 3 products together (${count} selected).`);
    await t.products.bulkBar().getByRole('button', { name: 'Delete', exact: true }).click();
    const dlg = await t.products.confirm(/Delete/);
    const toast = await t.products.toasts();
    await t.shot('after-mixed-delete');

    const freshLeft = (await Promise.all(fresh.map((p) => t.findProduct(p.name)))).filter(Boolean);
    t.check('Products without orders are deleted', freshLeft.length === 0, `${fresh.length - freshLeft.length} of ${fresh.length} deleted`);
    const kept = await t.findProduct(ordered.name);
    const archived = await t.findProduct(ordered.name, 'status=archived');
    t.check('Product with orders is kept', !!kept || !!archived, kept ? 'still in list' : archived ? 'moved to Archived (soft delete)' : 'gone');
    t.check('Message says which product could not be deleted and why', toast.includes(ordered.name) || /order/i.test(toast),
      `dialog: "${dlg.slice(0, 100)}"; toast: "${toast}"`,
      'The bulk endpoint returns {ok:true} with no per-item result; return which ids were blocked/archived and why, and show it.');
  },

  // Export the current page
  'PL-032': async (t) => {
    const category = await pickCategory(t, 'Fresh Fish');
    await t.products.open();
    await t.products.filter({ category: category.name });
    const shown = await t.products.rows();
    const columns = (await t.products.columns()).filter((c) => !['', 'ACTIONS'].includes(c));
    const file = await t.products.download(t.products.button('Export page'), 'CSV (.csv)', path.join(t.runDir, 'downloads'));
    if (!file) return void t.check('File downloads', false, 'no download started');
    const rows = readCsv(file);
    const headers = Object.keys(rows[0] ?? {}).map((h) => h.toUpperCase());
    t.note(`Downloaded ${path.basename(file)} (${rows.length} rows; headers: ${list(headers)}).`);
    const names = rows.map((r) => Object.values(r).join(' '));
    const missing = shown.filter((s) => !names.some((n) => n.includes(s.name))).map((s) => s.name);
    t.check('File contains the same products shown on screen', rows.length === shown.length && !missing.length,
      `${rows.length} in file, ${shown.length} on screen${missing.length ? `; missing: ${list(missing)}` : ''}`);
    const missingCols = columns.filter((c) => c !== 'SL' && !headers.some((h) => h.includes(c)));
    t.check('File has the same columns', !missingCols.length, missingCols.length ? `missing: ${list(missingCols)}` : 'all columns present');
    const priceKey = Object.keys(rows[0] ?? {}).find((k) => /price/i.test(k));
    const stockKey = Object.keys(rows[0] ?? {}).find((k) => /stock/i.test(k));
    const nonNumeric = rows.filter((r) => (priceKey && !/^-?[\d.]+$/.test(r[priceKey].trim())) || (stockKey && !/^-?[\d.]+$/.test(r[stockKey].trim())));
    t.check('Prices and stock are numbers', !!priceKey && !!stockKey && !nonNumeric.length,
      `price column '${priceKey}', stock column '${stockKey}'${nonNumeric.length ? `; e.g. "${nonNumeric[0][priceKey!]}", "${nonNumeric[0][stockKey!]}"` : ''}`,
      "Export writes the display strings ('৳1,400.00', '16 pcs'); export raw numbers and put the unit/currency in the header.");
    const fs = await import('fs');
    const raw = fs.readFileSync(file);
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    t.check('Bangla text is readable (UTF-8 with BOM for Excel)', bom, bom ? 'UTF-8 BOM present' : 'no BOM — Excel will show Bangla as mojibake',
      'Prepend \\uFEFF to CSV exports so Excel detects UTF-8.');
  },
};
