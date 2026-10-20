import type { Locator, Page } from 'playwright';
import { config } from './config.js';

export interface Row {
  name: string; type: string; price: string; stock: string; sku: string;
  category: string; brand: string; sold: string; text: string;
  /** State of the row's status switch, if it has one. */
  active: boolean | null;
}

export interface Card { label: string; value: number | null; sub: string; pct: number | null }

/** Everything visible on the page at one moment. Taken after every step so expectations can look back. */
export interface Snap {
  path: string;
  cards: Card[];
  tabs: Record<string, { count: number; active: boolean }>;
  showing: { from: number; to: number; total: number; text: string } | null;
  rows: Row[];
  columns: string[];
  gridItems: number;
  view: 'list' | 'grid' | null;
  selected: number | null;
  bulkButtons: string[];
  pager: Record<string, boolean | null>;
  dialog: string;
  menu: string[];
  toast: string;
  empty: string | null;
  filterButton: string;
  checked: number;
  /** Texts of controls marked current/pressed/selected (highlighted tabs, active view…). */
  current: string[];
  /** Barcode/QR graphics (svg shapes, canvases) on the page. */
  graphics: number;
  text: string;
  /** textContent of main (includes text inside SVGs, e.g. barcode values). */
  raw: string;
}

const SHOWING = /Showing\s*(\d+)\s*[–-]\s*(\d+)\s*of\s*(\d+)/;

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactText = (s: string) => new RegExp(`^\\s*${escapeRe(s)}\\s*$`, 'i');

/** Thrown when a control named in a test step is not on the page. */
export class Missing extends Error {
  constructor(readonly what: string, readonly seen: string[] = []) {
    super(`Could not find ${what}${seen.length ? ` (found: ${seen.slice(0, 12).join(', ')})` : ''}`);
  }
}

function parseCard([label = '', value = '', ...rest]: string[]): Card {
  const sub = rest.join(' ');
  const pct = sub.match(/([\d.]+)%/);
  const n = value.replace(/[৳,]/g, '');
  return { label, value: /^-?[\d.]+$/.test(n) ? Number(n) : null, sub, pct: pct ? Number(pct[1]) : null };
}

/**
 * Driver for slshop dashboard pages. List pages (Products, Orders, Customers…) share the same parts:
 * summary cards, a search box, Sort/Filter, status tabs, Grid/List, a table, a pager with
 * "Showing x–y of z", a bulk bar and dialogs.
 */
export class Ui {
  constructor(readonly page: Page) {}

  /** The page's main area; pages without a <main> (POS) use the whole body. */
  get main(): Locator { return this.page.locator('main, body:not(:has(main))').first(); }

  /** Opens a dashboard path. List pages are switched to List view so rows can be read. */
  async goto(path: string, opts: { waitForList?: boolean } = {}): Promise<void> {
    await this.page.goto(/^https?:/i.test(path) ? path : `${config.baseUrl}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined);
    if (opts.waitForList === false) return;
    // Pages without a list (POS, dashboard home) never show "Showing x–y of z"; don't wait long for it there.
    const listPage = /\/dashboard\/(?:products|orders|customers|coupons|inventory)(?:[/?#]|$)/.test(path) && !/\/(?:detail|new|edit)\b/.test(path);
    await this.waitForList(listPage ? 20_000 : 3_000).catch(() => undefined);
    await this.settle();
    await this.dismissOnboarding();
    await this.setView('list');
  }

  async isListPage(): Promise<boolean> {
    return SHOWING.test((await this.main.textContent().catch(() => '')) ?? '');
  }

  async waitForList(timeout = 20_000): Promise<void> {
    // The pagination text is split across several elements, so match on the combined text.
    await this.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('main')?.textContent ?? ''), SHOWING.source, { timeout });
  }

  /** Waits until the page has finished loading data: network quiet and no loading placeholders left. */
  async settle(): Promise<void> {
    await this.page.waitForTimeout(300);
    await this.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    await this.page
      .waitForFunction(() => !document.querySelector('main .animate-pulse, main [aria-busy=true]'), null, { timeout: 15_000 })
      .catch(() => undefined);
    await this.page.waitForTimeout(300);
  }

  async snapshot(): Promise<Snap> {
    const raw = await this.page.evaluate(() => {
      const main = document.querySelector('main') as HTMLElement | null;
      // offsetParent is null for position:fixed elements (dialogs, menus, toasts), so check boxes and styles instead.
      const visible = (e: Element | null) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const lines = (e: Element) => (e as HTMLElement).innerText.split('\n').map((x) => x.trim()).filter(Boolean);
      const cards = main ? [...main.querySelectorAll('.summary-card')].map(lines) : [];
      const tabs: Record<string, { count: number; active: boolean }> = {};
      for (const el of main ? [...main.querySelectorAll('[role=group][aria-label=Status] button')] : []) {
        const m = (el as HTMLElement).innerText.trim().match(/^([\s\S]+?)\s+(\d+)$/);
        if (m) tabs[m[1].trim()] = { count: Number(m[2]), active: el.getAttribute('aria-pressed') === 'true' };
      }
      const table = main?.querySelector('table') ?? null;
      const listVisible = visible(table);
      const heads = listVisible ? [...table!.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim().toUpperCase()) : [];
      const nameCol = heads.findIndex((h) => h === 'PRODUCT' || h === 'NAME' || h === 'CUSTOMER');
      const rows = listVisible
        ? [...table!.querySelectorAll('tbody tr')].map((tr) => {
            const cells = [...tr.children].map((td) => (td as HTMLElement).innerText.trim());
            const get = (h: string) => (heads.indexOf(h) >= 0 ? cells[heads.indexOf(h)] ?? '' : '');
            const nameCell = tr.children[nameCol] as HTMLElement | undefined;
            const link = nameCell?.querySelector('a') as HTMLElement | null;
            const parts = nameCell ? lines(nameCell) : [];
            const type = parts.find((l) => l === 'Simple' || l === 'Variable') ?? '';
            return {
              name: link?.innerText.trim() || parts.find((l) => l !== type && l.length > 2) || '',
              type,
              price: get('PRICE').replace(/\s+/g, ' '),
              stock: get('STOCK').replace(/\s+/g, ' '),
              sku: get('SKU'),
              category: get('CATEGORY'),
              brand: get('BRAND'),
              sold: get('SOLD'),
              text: (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
              active: (() => {
                const sw = tr.querySelector('[role=switch]');
                return sw ? sw.getAttribute('aria-checked') === 'true' : null;
              })(),
            };
          }).filter((r) => r.name)
        : [];
      const layout = main?.querySelector('[role=group][aria-label=Layout] [aria-pressed=true]') as HTMLElement | null;
      const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(visible);
      const menu = document.querySelector('[role=menu]');
      const bulk = [...document.querySelectorAll('[role=region]')].find((r) => /\d+ selected/.test(r.getAttribute('aria-label') ?? '') && visible(r));
      const filter = main ? [...main.querySelectorAll('button')].find((b) => /^Filter/.test((b as HTMLElement).innerText.trim()) && visible(b)) : undefined;
      const pager: Record<string, boolean | null> = {};
      for (const label of ['First page', 'Previous page', 'Next page', 'Last page']) {
        const el = document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;
        pager[label] = el ? el.disabled : null;
      }
      const emptyEl = main ? [...main.querySelectorAll('p, h2, h3, div, span')].find((e) => /^(Nothing found|No [\w ]+ yet)$/i.test((e as HTMLElement).innerText?.trim() ?? '') && visible(e)) : undefined;
      return {
        path: location.pathname + location.search,
        cards,
        tabs,
        allText: main?.textContent ?? '',
        rows,
        columns: heads.filter(Boolean),
        gridItems: main ? [...main.querySelectorAll('article')].filter(visible).length : 0,
        view: layout ? layout.innerText.trim().toLowerCase() : null,
        selected: (document.body.innerText.match(/(\d+) selected/) ?? [])[1] ?? null,
        bulkButtons: bulk ? [...bulk.querySelectorAll('button')].map((b) => (b as HTMLElement).innerText.trim()).filter(Boolean) : [],
        pager,
        dialog: dialogs.length ? (dialogs[dialogs.length - 1] as HTMLElement).innerText.replace(/\s+/g, ' ').trim() : '',
        menu: menu && visible(menu) ? lines(menu) : [],
        toast: [...document.querySelectorAll('[data-sonner-toast]')].map((t) => (t as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).join(' | '),
        empty: emptyEl ? ((emptyEl.parentElement?.parentElement as HTMLElement | null)?.innerText ?? (emptyEl as HTMLElement).innerText).replace(/\s+/g, ' ').trim() : null,
        filterButton: filter ? (filter.textContent ?? '').trim() : '',
        checked: main ? main.querySelectorAll('tbody input[type=checkbox]:checked').length : 0,
        graphics: main ? main.querySelectorAll('svg rect, svg path[d*="M0"], canvas, img[src*="barcode"]').length : 0,
        current: main ? [...main.querySelectorAll('[aria-current=page],[aria-pressed=true],[aria-selected=true]')].filter(visible).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()) : [],
        text: (main?.innerText ?? document.body.innerText).replace(/\s+/g, ' '),
      };
    }).catch(() => null);
    if (!raw) return emptySnap(this.page.url());
    const m = raw.allText.match(SHOWING);
    return {
      path: raw.path,
      cards: raw.cards.map(parseCard),
      tabs: raw.tabs,
      showing: m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]), text: `Showing ${m[1]}–${m[2]} of ${m[3]}` } : null,
      rows: raw.rows,
      columns: raw.columns,
      gridItems: raw.gridItems,
      view: raw.view === 'list' || raw.view === 'grid' ? raw.view : null,
      selected: raw.selected === null ? null : Number(raw.selected),
      bulkButtons: raw.bulkButtons,
      pager: raw.pager,
      dialog: raw.dialog,
      menu: raw.menu,
      toast: raw.toast,
      empty: raw.empty,
      filterButton: raw.filterButton,
      checked: raw.checked,
      current: raw.current,
      graphics: raw.graphics,
      text: raw.text,
      raw: raw.allText.replace(/\s+/g, ' '),
    };
  }

  /** A visible button or link whose accessible name is `name` (case-insensitive). */
  button(name: string | RegExp, scope: Locator | Page = this.page): Locator {
    // Accessible name, not textContent: buttons carry hidden mobile-only labels alongside the visible one.
    const re = typeof name === 'string' ? exactText(name) : name;
    return scope.getByRole('button', { name: re }).or(scope.getByRole('link', { name: re })).filter({ visible: true }).first();
  }

  async exists(locator: Locator): Promise<boolean> {
    return (await locator.filter({ visible: true }).count().catch(() => 0)) > 0;
  }

  async setView(view: 'list' | 'grid'): Promise<void> {
    const btn = this.page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: exactText(view) });
    if (!(await btn.count())) return;
    if ((await btn.getAttribute('aria-pressed')) !== 'true') {
      await btn.click();
      await this.settle();
    }
  }

  statusTab(name: string): Locator {
    return this.main.getByRole('group', { name: 'Status' }).locator('button').filter({ hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*\\d+\\s*$`, 'i') }).first();
  }

  searchBox(): Locator {
    return this.main.locator('input[type=search]').filter({ visible: true }).first();
  }

  async search(text: string): Promise<void> {
    await this.searchBox().fill(text);
    await this.page.waitForTimeout(400);
    await this.settle();
  }

  row(name: string): Locator {
    return this.main.locator('tbody tr').filter({ hasText: name }).first();
  }

  gridCard(name: string): Locator {
    return this.main.locator('article').filter({ hasText: name }).first();
  }

  /** The topmost open dialog. */
  dialog(): Locator {
    return this.page.locator('[role=dialog], [role=alertdialog]').filter({ visible: true }).last();
  }

  async dialogText(): Promise<string> {
    const d = this.dialog();
    if (!(await d.count())) return '';
    // Some confirmations look up linked data first ("Checking what this product is linked to…").
    await this.page.waitForFunction(() => !/Checking what/i.test([...document.querySelectorAll('[role=dialog],[role=alertdialog]')].at(-1)?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => undefined);
    return (await d.innerText()).replace(/\s+/g, ' ').trim();
  }

  async openFilter(): Promise<Locator> {
    const open = this.dialog();
    if (await open.count()) return open;
    await this.main.locator('button').filter({ hasText: /^Filter/ }).filter({ visible: true }).first().click();
    await this.dialog().waitFor();
    return this.dialog();
  }

  /** Labels of the dropdowns in the open dialog, e.g. ["stock", "category"]. */
  async comboLabels(dialog: Locator): Promise<string[]> {
    return dialog.getByRole('combobox').evaluateAll((cs) =>
      cs.map((c) => {
        const own = c.getAttribute('aria-label');
        if (own) return own.trim().toLowerCase();
        let el: Element | null = c;
        for (let i = 0; i < 4 && el; i++) {
          el = el.parentElement;
          const text = ((el as HTMLElement | null)?.innerText ?? '').replace((c as HTMLElement).innerText, '').trim();
          if (text) return text.split('\n')[0].trim().toLowerCase();
        }
        return '';
      }),
    );
  }

  /** Picks `value` in a dropdown of the open (or Filter) dialog. With no field, tries each dropdown until one has the option. */
  async pickOption(field: string | null, value: string): Promise<void> {
    const dialog = await this.openFilter();
    const combos = dialog.getByRole('combobox');
    const labels = await this.comboLabels(dialog);
    const order = field
      ? labels.map((l, i) => (l === field.toLowerCase() || l.startsWith(field.toLowerCase()) ? i : -1)).filter((i) => i >= 0)
      : labels.map((_, i) => i);
    if (field && !order.length) throw new Missing(`a '${field}' field`, labels);
    const seen: string[] = [];
    for (const i of order) {
      await combos.nth(i).click();
      const option = this.page.getByRole('option', { name: exactText(value) });
      if (await option.count()) {
        await option.first().click();
        await this.page.waitForTimeout(300);
        return;
      }
      seen.push(...(await this.page.getByRole('option').allInnerTexts()).map((s) => s.trim()));
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(200);
    }
    throw new Missing(`option '${value}'${field ? ` in ${field}` : ''}`, seen);
  }

  async options(field: string): Promise<string[]> {
    const dialog = await this.openFilter();
    const labels = await this.comboLabels(dialog);
    const at = labels.findIndex((l) => l.startsWith(field.toLowerCase()));
    if (at < 0) return [];
    await dialog.getByRole('combobox').nth(at).click();
    const options = (await this.page.getByRole('option').allInnerTexts()).map((s) => s.trim());
    await this.page.keyboard.press('Escape');
    return options;
  }

  async setRows(n: number): Promise<void> {
    await this.page.getByLabel('Rows').click();
    await this.page.getByRole('option', { name: String(n), exact: true }).click();
    await this.settle();
  }

  /** What covers the centre of `locator`, if anything. */
  async coveredBy(locator: Locator): Promise<string | null> {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    return locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top || el.contains(top)) return null;
      const owner = top.closest('button, a, [role]') ?? top;
      return owner.getAttribute('aria-label') || (owner as HTMLElement).innerText?.trim().slice(0, 40) || owner.tagName.toLowerCase();
    }).catch(() => null);
  }

  bulkBar(): Locator {
    return this.page.getByRole('region', { name: /\d+ selected/ }).filter({ visible: true }).first();
  }

  async switchStore(name: string): Promise<void> {
    await this.page.getByLabel('Store and account').filter({ visible: true }).first().click();
    await this.page.locator('[data-radix-popper-content-wrapper], [role=menu], [role=dialog]').getByText(name, { exact: true }).first().click();
    await this.page.waitForLoadState('networkidle');
    await this.waitForList().catch(() => undefined);
    await this.page.waitForTimeout(800);
    await this.dismissOnboarding();
  }

  /** New stores open a "Set up your shop" wizard over the page. Returns whether one was closed. */
  async dismissOnboarding(): Promise<boolean> {
    const wizard = this.page.getByRole('dialog').filter({ hasText: 'Set up your shop' });
    if (!(await wizard.isVisible().catch(() => false))) return false;
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);
    return true;
  }

  /** Quick Stock Adjust dialog on a list row. */
  async adjustStock(name: string, type: 'Stock In' | 'Stock Out', quantity: number): Promise<void> {
    await this.row(name).getByLabel('Adjust stock').click();
    const dialog = this.dialog();
    await dialog.getByText(type, { exact: true }).click();
    await dialog.getByRole('spinbutton', { name: 'Quantity' }).fill(String(quantity));
    const saved = this.page.waitForResponse((r) => r.url().includes('/adjust-stock'), { timeout: 15_000 });
    await dialog.getByText('Save Changes', { exact: true }).click();
    const res = await saved;
    if (!res.ok()) throw new Error(`Adjust stock failed: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
    await this.settle();
  }
}

function emptySnap(url: string): Snap {
  return {
    path: url.replace(/^https?:\/\/[^/]+/, ''), cards: [], tabs: {}, showing: null, rows: [], columns: [], gridItems: 0, view: null,
    selected: null, bulkButtons: [], pager: {}, dialog: '', menu: [], toast: '', empty: null, filterButton: '', checked: 0, current: [], graphics: 0, text: '', raw: '',
  };
}
