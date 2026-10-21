import type { Locator } from 'playwright';
import type { CaseContext } from '../../context.js';
import { Missing } from '../../ui.js';

/**
 * Driver for the Add / Edit Product form (/dashboard/products/new, /dashboard/products/edit?id=…).
 * The form's inputs have no <label for>: each label is a <label> element just before the control.
 */

export const FORM_PATH = '/dashboard/products/new';

/** Sheet wording → the label on the form. */
const FIELD_ALIASES: Record<string, string> = {
  'name': 'Product Name',
  'product name': 'Product Name',
  'price': 'Selling Price',
  'selling price': 'Selling Price',
  'regular price': 'Selling Price',
  'sale price': 'Discount Price',
  'discount': 'Discount Price',
  'discount price': 'Discount Price',
  'cost': 'Cost Price',
  'cost price': 'Cost Price',
  'wholesale price': 'Base Wholesale Price',
  'stock': 'Opening Stock',
  'opening stock': 'Opening Stock',
  'warning': 'Low Stock Threshold',
  'low stock warning': 'Low Stock Threshold',
  'low stock threshold': 'Low Stock Threshold',
  'threshold': 'Low Stock Threshold',
  'sku': 'SKU',
  'barcode': 'Barcode',
  'weight': 'Weight (Kg)',
  'extra shipping fee': 'Extra Shipping Fee',
  'shipping fee': 'Extra Shipping Fee',
  'meta title': 'Meta Title',
  'meta description': 'Meta Description',
  'short description': 'Short Description',
  'full description': 'Full Description',
  'description': 'Short Description',
  'category': 'Category',
  'brand': 'Brand',
  'unit': 'Unit',
  'tax rate': 'Tax Rate',
  'tax': 'Tax Rate',
  'labels': 'Labels',
  'label': 'Labels',
  'supplier': 'Default Supplier',
  'warehouse': 'Default Warehouse',
  'visibility': 'Active status',
  'status': 'Active status',
  'sell on': 'Sell on',
  'channels': 'Sell on',
};

export const SWITCHES: Record<string, string> = {
  'track inventory': 'Track inventory',
  'track expiry': 'Track expiry and batches',
  'track expiry / batches': 'Track expiry and batches',
  'track expiry and batches': 'Track expiry and batches',
  'track serial': 'Track serial numbers',
  'track serial / imei': 'Track serial numbers',
  'track serial numbers': 'Track serial numbers',
  'allow pre-order': 'Allow pre-order',
  'pre-order': 'Allow pre-order',
  'wholesale pricing': 'Enable wholesale program',
  'wholesale program': 'Enable wholesale program',
  'enable wholesale program': 'Enable wholesale program',
  'tax included in price': 'Tax included in price',
  'active status': 'Active status',
  'active': 'Active status',
  'visibility': 'Active status',
};

/** Old or informal section names in the sheet → the section header on today's form. */
const SECTION_ALIASES: Record<string, string> = {
  'the basics': 'Basic Info',
  'basics': 'Basic Info',
  'basic info': 'Basic Info',
  'description & labels': 'Basic Info',
  'description and labels': 'Basic Info',
  'pricing': 'Pricing',
  'pricing details': 'Pricing',
  'price': 'Pricing',
  'stock': 'Stock',
  'stock options': 'Stock',
  'additional data': 'Additional data',
  'additional details': 'Additional data',
  'seo': 'Additional data',
  'product type': 'Product Type',
  'variations': 'Product Type',
  'photos': 'Gallery',
  'gallery': 'Gallery',
  'images': 'Gallery',
};

const norm = (s: string) => s.toLowerCase().replace(/[‘’'"]/g, '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();

export function formLabel(name: string): string {
  const n = norm(name).replace(/^(?:the|a|an)\s+/, '').replace(/\s+(?:field|box|input)$/, '');
  return FIELD_ALIASES[n] ?? SWITCHES[n] ?? name.replace(/\s*\*\s*$/, '').trim();
}

export function sectionName(name: string): string | null {
  const n = norm(name).replace(/^(?:the|a|an)\s+/, '').replace(/\s+section$/, '');
  return SECTION_ALIASES[n] ?? null;
}

export const KNOWN_FIELDS = [...new Set([...Object.keys(FIELD_ALIASES), ...Object.values(FIELD_ALIASES).map((x) => x.toLowerCase())])];

export const onForm = (t: CaseContext) => /\/dashboard\/products\/(?:new|create|(?:detail\/)?edit)\b/.test(new URL(t.page.url()).pathname);

/** Opens the add-product form unless an add/edit form is already open. */
export async function ensureForm(t: CaseContext): Promise<void> {
  if (onForm(t)) return;
  await t.ui.goto(FORM_PATH, { waitForList: false });
  await t.page.getByRole('button', { name: /^\s*Save (?:Product|Changes)\s*$/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
}

/** XPath literal for any string (quotes included). */
function xq(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.replace(/'/g, `', "'", '`)}')`;
}

const labelX = (label: string) => `//main//label[translate(normalize-space(translate(., '*', '')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')=${xq(label.toLowerCase())}]`;

/** Closes a dropdown or popover left open by an earlier step (they cover the controls below them). */
export async function closePopovers(t: CaseContext): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const open = t.page.locator('[data-radix-popper-content-wrapper], [role=listbox]').filter({ visible: true });
    if (!(await open.count())) return;
    await t.page.keyboard.press('Escape');
    await t.page.waitForTimeout(250);
  }
}

/** Opens the section a control lives in (Additional data starts closed). */
export async function openSection(t: CaseContext, name: string): Promise<string> {
  await closePopovers(t);
  const section = sectionName(name) ?? name;
  if (section === 'Gallery') return 'Gallery';
  const header = t.page.locator('main button[aria-expanded]').filter({ hasText: new RegExp(`^\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }).first();
  if (!(await header.count())) throw new Missing(`section '${name}'`, await sectionNames(t));
  if ((await header.getAttribute('aria-expanded')) === 'false') {
    await header.click();
    await t.page.waitForTimeout(400);
  }
  return section;
}

async function sectionNames(t: CaseContext): Promise<string[]> {
  return t.page.locator('main button[aria-expanded]').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).innerText.split('\n')[0].trim()).filter((x) => x.length > 2));
}

/** Opens the collapsed section around a control (collapsed sections keep their controls in a 0-height box). */
async function revealSection(t: CaseContext, loc: Locator): Promise<void> {
  const collapsed = await loc.evaluate((el) => {
    for (let c = el.parentElement; c; c = c.parentElement) {
      const cs = getComputedStyle(c);
      if ((cs.height === '0px' || c.getBoundingClientRect().height < 2) && /hidden|clip/.test(cs.overflow + cs.overflowY)) return true;
    }
    return false;
  }).catch(() => false);
  if (collapsed) await openAllSections(t);
}

async function openAllSections(t: CaseContext): Promise<void> {
  await closePopovers(t);
  const closed = t.page.locator('main button[aria-expanded=false]').filter({ hasText: /^\s*(Additional data|Basic Info|Pricing|Stock|Product Type|Variations)/ });
  for (let i = 0; i < 6 && (await closed.count()); i++) {
    await closed.first().click().catch(() => undefined);
    await t.page.waitForTimeout(250);
  }
}

/** The text input / textarea / number box for a label ("Selling Price", "Product Name"). */
export async function field(t: CaseContext, name: string): Promise<Locator> {
  const label = formLabel(name);
  let loc = t.page.locator(`xpath=${labelX(label)}/following::*[self::input[not(@type='file') and not(@type='checkbox')] or self::textarea or @contenteditable='true'][1]`).first();
  if (!(await loc.count())) {
    await openAllSections(t);
    loc = t.page.locator(`xpath=${labelX(label)}/following::*[self::input[not(@type='file') and not(@type='checkbox')] or self::textarea or @contenteditable='true'][1]`).first();
  }
  if (await loc.count()) {
    await revealSection(t, loc);
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    return loc;
  }
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const fallback = t.page.getByLabel(re).or(t.page.getByPlaceholder(re)).filter({ visible: true }).first();
  if (await fallback.count()) return fallback;
  throw new Missing(`a '${label}' field`, await labels(t));
}

/** The button that opens a dropdown (Category, Brand, Unit, Tax Rate, Labels, Sell on). */
export async function dropdown(t: CaseContext, name: string): Promise<Locator> {
  await closePopovers(t);
  const label = formLabel(name);
  const find = () => t.page.locator(`xpath=${labelX(label)}/following::*[@role='combobox' or self::button][1]`).filter({ visible: true }).first();
  let loc = find();
  if (!(await loc.count())) {
    await openAllSections(t);
    await t.page.waitForTimeout(400);
    loc = find();
  }
  if (!(await loc.count())) throw new Missing(`a '${label}' dropdown`, await labels(t));
  await revealSection(t, loc);
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  return loc;
}

export async function labels(t: CaseContext): Promise<string[]> {
  return t.page.locator('main label').evaluateAll((ls) => [...new Set(ls.map((l) => (l as HTMLElement).innerText.replace(/\s*\*\s*$/, '').trim()).filter(Boolean))]);
}

/** Switch buttons ("Track inventory", "Active status") carry their name as aria-label or text, with aria-checked/aria-pressed or data-state. */
export async function switchButton(t: CaseContext, name: string): Promise<Locator> {
  const label = SWITCHES[norm(name)] ?? formLabel(name);
  const re = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  let loc = t.page.locator('main').getByRole('switch', { name: re }).or(t.page.locator('main').getByRole('button', { name: re })).first();
  if (!(await loc.count())) {
    await openAllSections(t);
    loc = t.page.locator('main').getByRole('switch', { name: re }).or(t.page.locator('main').getByRole('button', { name: re })).first();
  }
  if (!(await loc.count())) throw new Missing(`a '${label}' switch`);
  await revealSection(t, loc);
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  return loc;
}

export async function switchState(sw: Locator): Promise<boolean | null> {
  return sw.evaluate((el) => {
    const v = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed') ?? el.getAttribute('data-state');
    return v === 'true' || v === 'checked' || v === 'on' ? true : v === 'false' || v === 'unchecked' || v === 'off' ? false : null;
  });
}

export async function setSwitch(t: CaseContext, name: string, on: boolean): Promise<string> {
  const sw = await switchButton(t, name);
  if (await sw.isDisabled()) {
    const why = await sw.evaluate((el) => (el.closest('div')?.parentElement as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '');
    t.noted.set('__switchDisabled', { name, why });
    return `'${name}' is disabled${why ? `: "${why}"` : ''}.`;
  }
  const now = await switchState(sw);
  if (now !== on) await sw.click();
  await t.page.waitForTimeout(300);
  return `'${name}' turned ${on ? 'on' : 'off'}.`;
}

/** Picks an option in a dropdown; with `create`, uses its "Create new …" entry when the option is missing. */
export async function pick(t: CaseContext, name: string, value: string, opts: { create?: boolean } = {}): Promise<string> {
  const btn = await dropdown(t, name);
  await btn.click();
  await t.page.waitForTimeout(400);
  const search = t.page.locator('[cmdk-input], [role=dialog] input, [data-radix-popper-content-wrapper] input').filter({ visible: true }).first();
  if (await search.count()) {
    await search.fill(value);
    await t.page.waitForTimeout(500);
  }
  const option = t.page.getByRole('option', { name: new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).filter({ visible: true }).first();
  if (await option.count()) {
    await option.click();
    await t.page.waitForTimeout(300);
    return `${formLabel(name)} = '${value}'.`;
  }
  const seen = (await t.page.getByRole('option').filter({ visible: true }).allInnerTexts()).map((s) => s.trim());
  if (opts.create) {
    if (await search.count()) {
      await search.fill('');
      await t.page.waitForTimeout(300);
    }
    const create = t.page.getByRole('option', { name: /create new|add new/i }).filter({ visible: true }).first();
    if (await create.count()) {
      const real = value.startsWith('BTB') ? value : `${t.prefix} ${value}`;
      await create.click();
      await t.page.waitForTimeout(600);
      const dlg = t.ui.dialog();
      await dlg.locator('input').first().fill(real);
      await dlg.getByRole('button', { name: /^\s*(create|save|add)(?:\s+(?:label|brand|category|tax rate))?\s*$/i }).last().click();
      await t.page.waitForTimeout(1500);
      trackCreated(t, formLabel(name), real);
      return `${formLabel(name)} '${value}' did not exist; created '${real}' from the dropdown.`;
    }
  }
  await t.page.keyboard.press('Escape');
  throw new Missing(`option '${value}' in ${formLabel(name)}`, seen);
}

/** Remembers categories/brands/labels the bot created inline, so cleanup can remove them. */
export function trackCreated(t: CaseContext, kind: string, name: string): void {
  const list = (t.noted.get('__inlineCreated') as { kind: string; name: string }[] | undefined) ?? [];
  if (!list.length) {
    t.onCleanup(async () => {
      for (const c of (t.noted.get('__inlineCreated') as { kind: string; name: string }[] | undefined) ?? []) {
        if (/categor/i.test(c.kind)) {
          const hit = (await t.api.categories()).find((x) => x.name === c.name);
          if (hit) await t.api.deleteCategory(hit.id);
        } else if (/brand/i.test(c.kind)) {
          const hit = (await t.api.brands()).find((x) => x.name === c.name);
          if (hit) await t.api.request('DELETE', `/catalog/brands/${hit.id}`).catch(() => t.note(`Could not delete the test brand '${c.name}'.`));
        } else if (/label/i.test(c.kind)) {
          const hit = (await t.api.labels()).find((x) => x.name === c.name);
          if (hit) await t.api.request('DELETE', `/catalog/labels/${hit.id}`).catch(() => t.note(`Could not delete the test label '${c.name}'.`));
        }
      }
    });
  }
  t.noted.set('__inlineCreated', [...list, { kind, name }]);
}

/** All options of a dropdown, then closes it. */
export async function options(t: CaseContext, name: string): Promise<string[]> {
  const btn = await dropdown(t, name);
  await btn.click();
  await t.page.waitForTimeout(500);
  const out = (await t.page.getByRole('option').filter({ visible: true }).allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  await t.page.keyboard.press('Escape');
  await t.page.waitForTimeout(200);
  return out;
}

export interface SaveResult {
  button: string;
  saved: boolean;
  status: number | null;
  productId: number | null;
  slug: string | null;
  name: string | null;
  url: string;
  messages: string[];
  /** Browser-blocked fields: the field's own message, e.g. "Value must be greater than or equal to 0". */
  invalid: string[];
  error: string | null;
}

/** Clicks Save (or "Save & add another") and records what happened: request, page, toasts, blocked fields. */
export async function save(t: CaseContext, button = 'Save Product', opts: { twice?: boolean } = {}): Promise<SaveResult> {
  // The edit page says "Save Changes" where the add page says "Save Product".
  const names = button === 'Save Product' ? 'Save Product|Save Changes' : button.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const btn = t.page.getByRole('button', { name: new RegExp(`^\\s*(?:${names})\\s*$`, 'i') }).filter({ visible: true }).first();
  if (!(await btn.count())) throw new Missing(`'${button}'`, (await t.page.getByRole('button').filter({ visible: true }).allInnerTexts()).map((s) => s.trim()).filter(Boolean).slice(0, 14));
  const toastsBefore = t.toasts.length;
  const posts: { status: number; body: any }[] = [];
  const onResponse = async (r: import('playwright').Response) => {
    const path = new URL(r.url()).pathname;
    if (!['POST', 'PUT', 'PATCH'].includes(r.request().method()) || !/\/catalog\/products(?:\/\d+)?$/.test(path)) return;
    if (r.request().method() !== 'POST') t.noted.set('__updated', true);
    posts.push({ status: r.status(), body: await r.json().catch(() => null) });
  };
  t.page.on('response', onResponse);
  const before = t.page.url();
  if (opts.twice) {
    await btn.dblclick({ delay: 40 }).catch(() => undefined);
    await btn.click({ timeout: 300, force: true }).catch(() => undefined);
  } else await btn.click();
  // Wait until the request finished and the button is usable again, or the page moved on.
  await t.page.waitForTimeout(800);
  await t.page.waitForFunction((b) => location.href !== b || ![...document.querySelectorAll('button')].some((x) => /Save Product|Save Changes|Saving/.test(x.textContent ?? '') && (x as HTMLButtonElement).disabled), before, { timeout: 20_000 }).catch(() => undefined);
  await t.page.waitForTimeout(1200);
  t.page.off('response', onResponse);
  const invalid = await t.page.evaluate(() => [...document.querySelectorAll('main input, main textarea')].filter((i) => !(i as HTMLInputElement).checkValidity()).map((i) => {
    let label = '';
    let c: HTMLElement | null = i.parentElement;
    for (let k = 0; k < 4 && c && !label; k++) { const l = c.querySelector('label'); if (l) label = l.innerText.replace(/\s*\*\s*$/, '').trim(); c = c.parentElement; }
    return `${label || (i as HTMLInputElement).placeholder}: ${(i as HTMLInputElement).validationMessage}`;
  })).catch(() => [] as string[]);
  const ok = posts.filter((p) => p.status < 300 && p.body?.data?.id);
  for (const p of ok) if (!t.noted.get('__updated')) t.noted.set('__createdIds', [...((t.noted.get('__createdIds') as number[] | undefined) ?? []), p.body.data.id]);
  const last = ok.at(-1)?.body?.data;
  const failed = posts.find((p) => p.status >= 400);
  const messages = [...new Set(t.toasts.slice(toastsBefore))];
  const result: SaveResult = {
    button,
    saved: ok.length > 0,
    status: posts.at(-1)?.status ?? null,
    productId: last?.id ?? null,
    slug: last?.slug ?? null,
    name: last?.name ?? null,
    url: new URL(t.page.url()).pathname,
    messages,
    invalid,
    error: failed ? serverError(failed.status, failed.body) : null,
  };
  const saves = [...((t.noted.get('__saves') as SaveResult[] | undefined) ?? []), result];
  t.noted.set('__saves', saves);
  t.noted.set('__save', result);
  t.noted.set('__saveCount', ok.length + ((t.noted.get('__saveCount') as number | undefined) ?? 0));
  return result;
}

/** A short, readable reason from the server's answer (validation messages, or the gist of a database error). */
function serverError(status: number, body: any): string {
  const errors = body?.errors && typeof body.errors === 'object' ? Object.values(body.errors).flat().map(String) : [];
  if (errors.length) return errors.join('; ').slice(0, 200);
  const msg = String(body?.message ?? JSON.stringify(body ?? '')).replace(/\s+/g, ' ');
  const db = msg.match(/ERROR:\s*([^(]+?)(?:\s*\(Connection|$)/)?.[1]?.trim();
  return `HTTP ${status}: ${(db ? `database error "${db}"` : msg).slice(0, 160)}`;
}

export function describeSave(r: SaveResult): string {
  if (r.saved) return `Saved: product #${r.productId} '${r.name}' (link /product/${r.slug})${r.messages.length ? `; message: ${r.messages.join(' | ')}` : ''}.`;
  const why = [...r.messages, ...r.invalid.map((x) => `field says "${x}"`), r.error ? `server said ${r.error}` : ''].filter(Boolean);
  return `Not saved${why.length ? `: ${why.join('; ')}` : ' (no message shown)'}.`;
}

/** Archives every product this case saved through the form. */
export function cleanupSaved(t: CaseContext): void {
  if (t.noted.get('__formCleanup')) return;
  t.noted.set('__formCleanup', true);
  t.onCleanup(async () => {
    const ids = [...new Set((t.noted.get('__createdIds') as number[] | undefined) ?? [])];
    if (ids.length) await t.api.deleteProducts(ids);
  });
}
