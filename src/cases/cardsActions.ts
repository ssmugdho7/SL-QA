import { config } from '../config.js';
import type { Product } from '../api.js';
import type { CaseScript, CaseContext } from '../runner.js';
import { list, money } from './util.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A real product that has past orders, plus a cleanup that puts it back exactly as it was. */
async function productWithOrders(t: CaseContext): Promise<Product> {
  const candidates = (await t.api.allProducts('status=active')).filter((p) => p.total_sold > 0).sort((a, b) => a.total_sold - b.total_sold);
  for (const p of candidates) {
    const preview = await t.api.deletionPreview(p.id);
    if (preview.in_orders) {
      t.note(`Used real product '${p.name}' (${preview.order_count} past orders). It is restored and re-activated after the test.`);
      t.onCleanup(async () => {
        await t.api.restoreProduct(p.id).catch(() => undefined);
        await t.api.bulk([p.id], 'activate');
      });
      return p;
    }
  }
  return t.block('No product with past orders found.');
}

async function variableFixture(t: CaseContext, suffix: string) {
  return t.fixtureProduct(suffix, {
    product_type: 'variable',
    price: null,
    variant_axes: ['Weight'],
    variants: [
      { name: '50g', attributes: { Weight: '50g' }, price: 70, stock: 3 },
      { name: '100g', attributes: { Weight: '100g' }, price: 112, stock: 4 },
      { name: '125g', attributes: { Weight: '125g' }, price: 140, stock: 2 },
      { name: '250g', attributes: { Weight: '250g' }, price: 280, stock: 1 },
    ],
  });
}

export const cardsActionsCases: Record<string, CaseScript> = {
  // Product card shows correct information
  'PL-020': async (t) => {
    const all = await t.api.allProducts('status=active');
    const product = all.find((p) => p.category && p.product_type === 'simple') ?? all[0];
    t.note(`Sheet example BASHPATA is not in this store; used '${product.name}'.`);
    await t.products.open('grid');
    await t.products.search(product.name);
    const card = t.products.card(product.name);
    await card.getByRole('button', { name: 'More details' }).click().catch(() => undefined);
    await t.page.waitForTimeout(500);
    const cardText = norm(await card.innerText());
    await t.shot('card-expanded');

    await t.page.goto(`${config.baseUrl}/dashboard/products/detail?id=${product.id}`, { waitUntil: 'networkidle' });
    await t.page.locator('main').getByText(product.sku).first().waitFor();
    const detail = norm(await t.page.locator('main').innerText());
    await t.shot('detail-page');

    const pairs: [string, string, boolean][] = [
      ['Name', product.name, cardText.includes(product.name) && detail.includes(product.name)],
      ['Type', product.product_type === 'simple' ? 'Simple' : 'Variable', cardText.includes(product.product_type === 'simple' ? 'Simple' : 'Variable') && detail.includes(product.product_type === 'simple' ? 'Simple' : 'Variable')],
      ['SKU', product.sku, cardText.includes(product.sku) && detail.includes(product.sku)],
      ['Category', product.category?.name ?? '—', cardText.includes(product.category?.name ?? '—') && detail.includes(product.category?.name ?? '—')],
    ];
    // The card shows the selling price (and the regular price struck through when discounted).
    const cardPrices = [...(cardText.split(/\bPrice\b/)[1] ?? '').split(/\bStock\b/)[0].matchAll(/৳\s*([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    const field = (label: string) => money(detail.match(new RegExp(`(?:^|[^A-Za-z])${label} (৳[\\d,.]+|—)`))?.[1] ?? '');
    const detailPrices = [field('Price'), field('Discount Price')].filter((n): n is number => n !== null);
    const samePrices = cardPrices.length > 0 && cardPrices.every((n) => detailPrices.includes(n));
    pairs.push(['Price', `card ${cardPrices.map((n) => `৳${n}`).join(' / ')}, detail ${detailPrices.map((n) => `৳${n}`).join(' / ')}`, samePrices]);
    const stockOnCard = cardText.match(/Stock (-?\d+) (\w+)/);
    pairs.push(['Stock with unit', stockOnCard ? `${stockOnCard[1]} ${stockOnCard[2]} (API ${product.stock} ${'pcs'})` : 'not on card', !!stockOnCard && Number(stockOnCard[1]) === product.stock]);
    for (const [label, value, ok] of pairs) {
      t.check(`${label} on the card matches the detail page`, ok, value, `The card and detail page read ${label.toLowerCase()} from different fields.`);
    }
  },

  // Variable product shows its real price (KNOWN ISSUE)
  'PL-021': async (t) => {
    const p = await variableFixture(t, 'Variable Price');
    t.note(`Created variable product '${p.name}' with variants ৳70, ৳112, ৳140, ৳280 and no base price (as the Add Product form does).`);
    await t.products.open('grid');
    await t.products.search(p.name);
    const cardText = norm(await t.products.card(p.name).innerText());
    await t.shot('variable-card');
    await t.products.setView('list');
    const row = (await t.products.rows()).find((r) => r.name === p.name);
    const shown = `card: "${cardText.match(/Price ([^A-Z]*)/)?.[1]?.trim() ?? '?'}", list: "${row?.price}"`;
    const zero = /৳0\.00/.test(cardText) || /৳0\.00/.test(row?.price ?? '');
    t.check('Price is not ৳0.00', !zero, shown,
      "The card shows the product's own price column, which is empty/0 for variable products. Compute min/max over variants.");
    const rangeOk = /৳70(\.00)?\s*[–-]\s*৳280/.test(cardText) || /from\s*৳70/i.test(cardText);
    t.check("Card shows the range (৳70 – ৳280) or 'from ৳70'", rangeOk, shown,
      "The card prints a single price; for variable products render 'min – max' or 'from min' from the variants.");
  },

  // View variants and Quick view
  'PL-022': async (t) => {
    const p = await variableFixture(t, 'Variants View');
    await t.products.open();
    await t.products.search(p.name);
    const row = t.products.row(p.name);
    await row.getByLabel('View variants').click();
    await t.page.waitForTimeout(1_000);
    const dlg = await t.products.dialogText();
    await t.shot('variants-dialog');
    const variants = p.variants.length ? p.variants : (await t.api.getProduct(p.id)).variants;
    const missing = variants.filter((v) => !(dlg.includes(v.name) && dlg.includes(v.sku) && dlg.includes(`৳${Number(v.price).toFixed(2)}`))).map((v) => v.name);
    t.check('View variants lists every variant with price, SKU and stock', !missing.length, missing.length ? `missing details for: ${list(missing)}` : `${variants.length} variants listed`);
    t.check("Each variant shows its attribute (e.g. 'Weight: 50g')", /Weight:?\s*50g/.test(dlg), `dialog: "${dlg.slice(0, 160)}"`,
      'The dialog shows only the variant name, not the attribute label from variant_axes.');
    const cardStock = Number((await t.products.rows()).find((r) => r.name === p.name)?.stock.match(/-?\d+/)?.[0]);
    const sum = variants.reduce((s, v) => s + v.stock, 0);
    t.check('Variant stocks add up to the stock on the card', cardStock === sum, `variants ${sum}, card ${cardStock}`);
    await t.page.keyboard.press('Escape');
    await t.page.waitForTimeout(400);

    await row.getByLabel('Quick view').click();
    await t.page.waitForTimeout(1_000);
    const quick = await t.products.dialogText();
    await t.shot('quick-view');
    const fields = ['SKU', 'Category', 'Brand', 'Price', 'Stock', 'Barcode', 'Status'];
    const absent = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(quick));
    t.check(`Quick view shows ${fields.join(', ')}`, !absent.length, absent.length ? `missing: ${list(absent)}` : 'all shown');
    await t.page.getByRole('button', { name: 'View full details' }).click();
    await t.page.waitForURL(/\/dashboard\/products\/detail/, { timeout: 10_000 }).catch(() => undefined);
    t.check("'View full details' opens the product detail page", t.page.url().includes(`detail?id=${p.id}`), t.page.url());
  },

  // Card with long name or no image
  'PL-023': async (t) => {
    const name = `${t.prefix} ` + 'Long name '.repeat(30).slice(0, 200 - t.prefix.length - 1);
    const p = await t.api.createProduct({ name, current_stock: 1 });
    t.onCleanup(() => t.api.deleteProducts([p.id]));
    await t.products.open('grid');
    await t.products.search(t.prefix);
    const nameEl = t.products.main.getByText(name, { exact: true }).filter({ visible: true }).first();
    const style = await nameEl.evaluate((el) => {
      const cs = getComputedStyle(el);
      const card = el.closest('[class]')?.parentElement as HTMLElement;
      return {
        truncated: cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' || el.scrollHeight > el.clientHeight + 2,
        clamp: `${cs.textOverflow}/${cs.webkitLineClamp}`,
        title: el.getAttribute('title') ?? el.closest('[title]')?.getAttribute('title') ?? '',
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        cardWider: card ? card.scrollWidth > card.clientWidth + 2 : false,
      };
    });
    await t.shot('long-name-card');
    t.check("Long name is cut with '…'", style.truncated, `text-overflow/line-clamp: ${style.clamp}`, 'Name has no line-clamp/ellipsis.');
    t.check('Full name is available on hover', style.title === name, style.title ? 'title attribute present' : 'no title attribute',
      'Add title={name} (or a tooltip) on the truncated name.');
    t.check('Card layout does not break', !style.overflowX && !style.cardWider, style.overflowX || style.cardWider ? 'card overflows horizontally' : 'no overflow');
    const images = await t.products.card(name).locator('img').evaluateAll((imgs) => imgs.map((i) => ({ ok: (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0 })));
    const broken = images.some((i) => !i.ok);
    t.check('Placeholder is shown instead of a broken image', !broken, images.length ? `${images.length} img, ${broken ? 'broken' : 'ok'}` : 'placeholder (no <img>)');
  },

  // Duplicate a product
  'PL-024': async (t) => {
    const p = await t.fixtureProduct('Original', { current_stock: 4 });
    await t.products.open();
    const before = await t.products.kpis();
    await t.products.search(p.name);
    await t.products.rowAction(p.name, 'Duplicate');
    const confirmText = await t.products.confirm(/Duplicate/);
    const toast = await t.products.toasts();
    await t.shot('after-duplicate');
    const copies = (await t.api.allProducts(`q=${encodeURIComponent(t.prefix)}`)).filter((x) => x.id !== p.id);
    const copy = copies[0];
    t.check('A copy of the product is created', !!copy, copy ? `'${copy.name}' (confirm: "${confirmText.slice(0, 80)}", toast: "${toast}")` : `no copy found (toast: "${toast}")`);
    if (copy) {
      t.check('Copy has a new SKU and URL', copy.sku !== p.sku && copy.slug !== p.slug, `SKU ${p.sku} → ${copy.sku}, slug ${p.slug} → ${copy.slug}`);
      t.check("Copy name marks it as a copy (e.g. '(copy)')", /copy/i.test(copy.name), copy.name);
    }
    const original = await t.api.getProduct(p.id);
    t.check('Original product does not change', original.name === p.name && original.sku === p.sku && Number(original.price) === Number(p.price), `${original.name}, ${original.sku}, ৳${original.price}`);
    await t.page.reload({ waitUntil: 'networkidle' });
    await t.products.waitForList();
    await t.page.getByPlaceholder('Search products…').fill('');
    await t.page.waitForTimeout(1_500);
    const after = await t.products.kpis();
    t.check('Total Products increases by 1', after.total === (before.total ?? 0) + 1, `${before.total} → ${after.total}${copy && !copy.is_active ? ' (copy is a draft)' : ''}`,
      'The copy is created as a draft and Total Products only counts active products, or the card is not refreshed.');
  },

  // Delete a product (confirm and cancel)
  'PL-025': async (t) => {
    // No stock on hand: with stock, the app deactivates instead of deleting (covered by PL-026).
    const p = await t.fixtureProduct('Delete Me', { current_stock: 0 });
    await t.products.open();
    const before = await t.products.kpis();
    await t.products.search(p.name);
    await t.products.rowAction(p.name, 'Delete');
    await t.page.waitForTimeout(600);
    const dlg = await t.products.dialogText();
    await t.shot('delete-confirm');
    t.check('A confirmation box appears before deleting', /delete/i.test(dlg), dlg || 'no dialog');
    await t.products.dialog().getByRole('button', { name: 'Cancel' }).click();
    await t.page.waitForTimeout(800);
    t.check('After Cancel, the product is still there', (await t.products.rows()).some((r) => r.name === p.name), 'still listed');

    await t.products.rowAction(p.name, 'Delete');
    await t.products.confirm(/Delete/);
    const toast = await t.products.toasts();
    const gone = !(await t.products.rows()).some((r) => r.name === p.name);
    t.check('After confirming, the product is removed', gone, gone ? 'removed from the list' : 'still listed');
    t.check('A success message appears', /delet/i.test(toast), toast || 'no toast');
    await t.page.getByPlaceholder('Search products…').fill('');
    await t.page.waitForTimeout(1_500);
    const after = await t.products.kpis();
    const live = after.total === (before.total ?? 0) - 1;
    let detail = `${before.total} → ${after.total}`;
    if (!live) {
      await t.page.reload({ waitUntil: 'networkidle' });
      await t.products.waitForList();
      detail += `; after a page reload: ${(await t.products.kpis()).total}`;
    }
    t.check('Summary cards update', live, detail,
      'The delete mutation invalidates the product list query but not the KPI/summary query; invalidate both.');
  },

  // Delete a product that already has orders
  'PL-026': async (t) => {
    const p = await productWithOrders(t);
    const ordersBefore = await t.api.productOrders(p.id);
    const sampleOrder = ordersBefore.orders[0] as unknown as { order_id: number; reference: string } | undefined;
    await t.products.open();
    await t.products.search(p.name);
    await t.products.rowAction(p.name, 'Delete');
    await t.page.waitForTimeout(800);
    const dlg = await t.products.dialogText();
    await t.shot('delete-ordered-confirm');
    await t.products.confirm(/Delete|Archive|Deactivate/);
    const toast = await t.products.toasts();
    await t.shot('after-delete-ordered');
    const explained = /order|archiv|deactivat|cannot|can.?t/i.test(`${dlg} ${toast}`);
    t.check('Delete is blocked or the product archived, with a clear reason', explained,
      `dialog: "${dlg.slice(0, 160)}"; toast: "${toast}"`,
      'Deleting a product with orders shows the generic confirm/toast; surface the deletion-preview result (in orders → will be archived) in the dialog.');
    if (!sampleOrder) return t.skip('Old orders still show the product', 'Could not read an order for this product.');
    const order = await t.api.request<{ data: unknown }>('GET', `/sales/orders/${sampleOrder.order_id}`);
    const stillNamed = JSON.stringify(order.data).includes(p.name);
    t.check('Old orders still show the product', stillNamed,
      `order ${sampleOrder.reference} ${stillNamed ? 'still lists' : 'no longer lists'} '${p.name}'`,
      'Order lines load the product through a relation that excludes deactivated/soft-deleted products; snapshot the name on the line or use withTrashed().');
    const history = await t.api.productOrders(p.id).catch(() => ({ orders: [] }));
    if (history.orders.length !== ordersBefore.orders.length) {
      t.note(`The product's own Orders tab went from ${ordersBefore.orders.length} to ${history.orders.length} order(s) after the delete.`);
    }
  },

  // Print barcode from the list
  'PL-027': async (t) => {
    const withCode = await t.fixtureProduct('With Barcode', { barcode: '5901234123457', price: 250 });
    const without = await t.fixtureProduct('No Barcode', { price: 150 });
    await t.products.open();
    await t.products.search(t.prefix);
    for (const [p, label] of [[withCode, 'with barcode'], [without, 'without barcode']] as const) {
      await t.products.rowAction(p.name, 'Print barcode');
      await t.page.waitForURL(/barcodes/, { timeout: 10_000 }).catch(() => undefined);
      await t.page.locator('main').getByText(p.name).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await t.page.waitForTimeout(800);
      // textContent includes the text inside the barcode SVG (the encoded value).
      const text = norm((await t.page.locator('main').textContent()) ?? '');
      const graphic = await t.page.locator('main svg rect, main canvas, main img[src*="barcode"]').count();
      await t.shot(`print-${label.replace(' ', '-')}`);
      const code = p.barcode ?? p.sku;
      t.check(`Print preview ${label} shows name, price and ${p.barcode ? 'barcode' : 'SKU as code'}`,
        text.includes(p.name) && text.includes(`৳${Number(p.price).toFixed(2)}`) && text.includes(code) && graphic > 0,
        `page ${t.page.url().replace(config.baseUrl, '')}; name ${text.includes(p.name) ? '✓' : '✗'}, price ${text.includes(`৳${Number(p.price).toFixed(2)}`) ? '✓' : '✗'}, code '${code}' ${text.includes(code) ? '✓' : '✗'}, barcode graphic ${graphic > 0 ? '✓' : '✗'}`);
      await t.products.open();
      await t.products.search(t.prefix);
    }
  },
};
