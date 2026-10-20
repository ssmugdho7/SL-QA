import type { Locator, Page } from 'playwright';
import { config } from './config.js';

export interface Row {
  name: string; type: string; price: string; stock: string; sku: string;
  category: string; brand: string; sold: string; text: string;
}

export interface Kpis {
  total: number | null; inStock: number | null;
  active: number | null; activePct: number | null;
  low: number | null; lowPct: number | null;
  out: number | null; outPct: number | null;
  raw: string;
}

const SHOWING = /Showing\s*(\d+)\s*[–-]\s*(\d+)\s*of\s*(\d+)/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactText = (s: string) => new RegExp(`^\\s*${escapeRe(s)}\\s*$`);

/** Everything the bot knows about driving Dashboard > Products. */
export class ProductsPage {
  constructor(readonly page: Page) {}

  get main(): Locator { return this.page.locator('main'); }

  async open(view: 'list' | 'grid' = 'list'): Promise<void> {
    await this.page.goto(`${config.baseUrl}/dashboard/products`, { waitUntil: 'networkidle' });
    await this.waitForList();
    await this.setView(view);
  }

  async waitForList(): Promise<void> {
    // The pagination text is split across several elements, so match on the combined text.
    await this.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('main')?.textContent ?? ''), SHOWING.source, { timeout: 30_000 });
  }

  /** Runs an action that makes the list refetch, and waits for that fetch to land. */
  async afterListReload(action: () => Promise<unknown>): Promise<void> {
    const response = this.page
      .waitForResponse((r) => r.url().startsWith(`${config.apiUrl}/catalog/products?`) && r.request().method() === 'GET', { timeout: 10_000 })
      .catch(() => null);
    await action();
    await response;
    await this.page.waitForTimeout(600);
  }

  /** A visible button or link anywhere on the page whose whole text is `name`. */
  button(name: string | RegExp): Locator {
    // Accessible name, not textContent: buttons carry hidden mobile-only labels alongside the visible one.
    const re = typeof name === 'string' ? exactText(name) : name;
    return this.page.getByRole('button', { name: re }).or(this.page.getByRole('link', { name: re })).filter({ visible: true }).first();
  }

  async isVisible(locator: Locator): Promise<boolean> {
    return (await locator.filter({ visible: true }).count()) > 0;
  }

  async setView(view: 'list' | 'grid'): Promise<void> {
    const btn = this.button(view === 'list' ? 'List' : 'Grid');
    if ((await btn.getAttribute('aria-pressed')) !== 'true') {
      await btn.click();
      await this.page.waitForTimeout(800);
    }
  }

  async currentView(): Promise<'list' | 'grid'> {
    return (await this.button('List').getAttribute('aria-pressed')) === 'true' ? 'list' : 'grid';
  }

  async text(): Promise<string> {
    return (await this.main.innerText()).replace(/\s+/g, ' ');
  }

  async kpis(): Promise<Kpis> {
    const text = await this.text();
    const raw = text.match(/Total Products.*?(?= Sort\b)/)?.[0] ?? '';
    const num = (re: RegExp) => {
      const m = raw.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      total: num(/Total Products (\d+)/),
      inStock: num(/(\d+) in stock/),
      active: num(/Active (\d+)/),
      activePct: num(/Active \d+ ([\d.]+)% of catalog/),
      low: num(/Low stock (\d+)/),
      lowPct: num(/Low stock \d+ ([\d.]+)% of catalog/),
      out: num(/Out of stock (\d+)/),
      outPct: num(/Out of stock \d+ ([\d.]+)% of catalog/),
      raw,
    };
  }

  async statusTabs(): Promise<Record<string, { count: number; active: boolean }>> {
    return this.main.locator('button').evaluateAll((els) => {
      const out: Record<string, { count: number; active: boolean }> = {};
      for (const el of els as HTMLElement[]) {
        const m = el.innerText.trim().match(/^(All|Active|Draft|Archived)\s+(\d+)$/);
        if (m) out[m[1]] = { count: Number(m[2]), active: el.getAttribute('aria-pressed') === 'true' };
      }
      return out;
    });
  }

  async clickStatusTab(name: 'All' | 'Active' | 'Draft' | 'Archived'): Promise<void> {
    const tab = this.main.locator('button').filter({ hasText: new RegExp(`^${name}\\s*\\d+$`) }).first();
    await this.afterListReload(() => tab.click());
  }

  async showing(): Promise<{ from: number; to: number; total: number; text: string } | null> {
    const m = ((await this.main.textContent()) ?? '').match(SHOWING);
    return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]), text: m[0].replace(/\s+/g, ' ') } : null;
  }

  async resultsText(): Promise<string | null> {
    return (await this.text()).match(/\b\d+ results?\b/)?.[0] ?? null;
  }

  async columns(): Promise<string[]> {
    return this.page.evaluate(() => {
      const table = document.querySelector('main table') as HTMLElement | null;
      if (!table || !table.offsetParent) return [];
      return [...table.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim().toUpperCase()).filter(Boolean);
    });
  }

  /** Rows of the list view (empty in grid view). */
  async rows(): Promise<Row[]> {
    return this.page.evaluate(() => {
      const table = document.querySelector('main table') as HTMLElement | null;
      if (!table || !table.offsetParent) return [];
      const heads = [...table.querySelectorAll('thead th')].map((th) => (th as HTMLElement).innerText.trim().toUpperCase());
      return [...table.querySelectorAll('tbody tr')]
        .map((tr) => {
          const cells = [...tr.children].map((td) => (td as HTMLElement).innerText.trim());
          const get = (h: string) => (heads.indexOf(h) >= 0 ? cells[heads.indexOf(h)] ?? '' : '');
          // The product cell holds an optional initials placeholder, the name, then the type.
          const lines = get('PRODUCT').split('\n').map((s) => s.trim()).filter(Boolean);
          const typeAt = lines.findIndex((l) => l === 'Simple' || l === 'Variable');
          return {
            name: typeAt > 0 ? lines[typeAt - 1] : lines[lines.length - 1] ?? '',
            type: typeAt >= 0 ? lines[typeAt] : '',
            price: get('PRICE').replace(/\s+/g, ' '),
            stock: get('STOCK').replace(/\s+/g, ' '),
            sku: get('SKU'),
            category: get('CATEGORY'),
            brand: get('BRAND'),
            sold: get('SOLD'),
            text: (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
          };
        })
        .filter((r) => r.name);
    });
  }

  row(name: string): Locator {
    return this.main.locator('tbody tr').filter({ hasText: name }).first();
  }

  /** The grid card that shows `name`. */
  card(name: string): Locator {
    return this.main.locator('article').filter({ hasText: name }).first();
  }

  async search(text: string): Promise<void> {
    await this.afterListReload(() => this.page.getByPlaceholder('Search products…').fill(text));
  }

  async openFilter(): Promise<Locator> {
    await this.main.locator('button').filter({ hasText: /^Filter/ }).first().click();
    const dialog = this.page.getByRole('dialog');
    await dialog.waitFor();
    return dialog;
  }

  async filter(opts: { stock?: string; category?: string }): Promise<void> {
    await this.afterListReload(async () => {
      const dialog = await this.openFilter();
      const combos = dialog.getByRole('combobox');
      if (opts.stock) {
        await combos.nth(0).click();
        await this.page.getByRole('option', { name: opts.stock, exact: true }).click();
      }
      if (opts.category) {
        await combos.nth(1).click();
        await this.page.getByRole('option', { name: opts.category, exact: true }).click();
      }
      await dialog.getByRole('button', { name: 'Done' }).click();
    });
  }

  async filterOptions(which: 'stock' | 'category'): Promise<string[]> {
    const dialog = await this.openFilter();
    await dialog.getByRole('combobox').nth(which === 'stock' ? 0 : 1).click();
    const options = (await this.page.getByRole('option').allInnerTexts()).map((s) => s.trim());
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(300);
    return options;
  }

  async filterButtonText(): Promise<string> {
    return ((await this.main.locator('button').filter({ hasText: /^Filter/ }).first().textContent()) ?? '').trim();
  }

  async sortOptions(): Promise<string[]> {
    await this.button('Sort').click();
    const menu = this.page.getByRole('menu');
    await menu.waitFor();
    let items = (await menu.locator('[role^="menuitem"]').allInnerTexts()).map((s) => s.trim());
    if (!items.length) items = (await menu.innerText()).split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Sort by');
    await this.page.keyboard.press('Escape');
    return items;
  }

  async sort(option: string): Promise<void> {
    await this.button('Sort').click();
    await this.afterListReload(() => this.page.getByRole('menu').getByText(option, { exact: true }).click());
  }

  async setRows(n: number): Promise<void> {
    await this.page.getByLabel('Rows').click();
    await this.afterListReload(() => this.page.getByRole('option', { name: String(n), exact: true }).click());
  }

  async pager(): Promise<Record<string, boolean | null>> {
    return this.page.evaluate(() => {
      const out: Record<string, boolean | null> = {};
      for (const label of ['First page', 'Previous page', 'Next page', 'Last page']) {
        const el = document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement | null;
        out[label] = el ? el.disabled : null;
      }
      return out;
    });
  }

  /** Clicks a pager button. Returns false if something else on the page sits on top of it (it is then clicked directly). */
  async clickPager(label: 'First page' | 'Previous page' | 'Next page' | 'Last page'): Promise<boolean> {
    const button = this.page.getByLabel(label, { exact: true });
    let reachable = true;
    await this.afterListReload(async () => {
      try {
        await button.click({ timeout: 5_000 });
      } catch {
        reachable = false;
        await button.dispatchEvent('click');
      }
    });
    return reachable;
  }

  /** What covers the centre of `locator`, if anything. */
  async coveredBy(locator: Locator): Promise<string | null> {
    return locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top || el.contains(top)) return null;
      const owner = top.closest('button, a, [role]') ?? top;
      return owner.getAttribute('aria-label') || (owner as HTMLElement).innerText?.trim().slice(0, 40) || owner.tagName.toLowerCase();
    });
  }

  async selectRow(name: string): Promise<void> {
    await this.row(name).getByLabel('Select row').check();
  }

  async selectedCount(): Promise<number | null> {
    const m = (await this.page.locator('body').innerText()).match(/(\d+) selected/);
    return m ? Number(m[1]) : null;
  }

  async rowAction(name: string, item: string): Promise<void> {
    await this.row(name).getByLabel('More actions').click();
    await this.page.getByRole('menuitem', { name: item }).click();
  }

  /** The topmost open dialog. */
  dialog(): Locator {
    return this.page.locator('[role=dialog], [role=alertdialog]').filter({ visible: true }).last();
  }

  async dialogText(): Promise<string> {
    const d = this.dialog();
    return (await d.count()) ? (await d.innerText()).replace(/\s+/g, ' ').trim() : '';
  }

  /** Waits briefly for a toast and returns all toast texts. */
  async toasts(): Promise<string> {
    await this.page.locator('[data-sonner-toast]').first().waitFor({ timeout: 6_000 }).catch(() => null);
    return (await this.page.locator('[data-sonner-toast]').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim()).join(' | ');
  }

  async switchStore(name: string): Promise<void> {
    await this.page.getByLabel('Store and account').filter({ visible: true }).first().click();
    await this.page.locator('[data-radix-popper-content-wrapper], [role=menu], [role=dialog]').getByText(name, { exact: true }).first().click();
    await this.page.waitForLoadState('networkidle');
    await this.waitForList();
    await this.page.waitForTimeout(800);
    await this.dismissOnboarding();
  }

  /** Switches store without the menu (the app keeps the active store in localStorage). Used to restore state after a test. */
  async useStore(id: number): Promise<void> {
    await this.page.evaluate((storeId) => localStorage.setItem('store_id', String(storeId)), id);
    await this.page.reload({ waitUntil: 'networkidle' });
    await this.waitForList();
  }

  /** New stores open a "Set up your shop" wizard over the page. Returns whether one was closed. */
  async dismissOnboarding(): Promise<boolean> {
    const wizard = this.page.getByRole('dialog').filter({ hasText: 'Set up your shop' });
    if (!(await wizard.isVisible().catch(() => false))) return false;
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(500);
    if (await wizard.isVisible().catch(() => false)) {
      await wizard.getByRole('button', { name: /close|skip|later/i }).first().click().catch(() => undefined);
    }
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
    await this.page.waitForTimeout(800);
  }

  /** The bar that appears when rows are selected. */
  bulkBar(): Locator {
    return this.page.getByRole('region', { name: /\d+ selected/ }).filter({ visible: true }).first();
  }

  async bulkBarButtons(): Promise<string[]> {
    return (await this.bulkBar().locator('button').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  }

  /** Clicks the confirm button of an open confirmation dialog, if one appears. Returns the dialog text. */
  async confirm(button: RegExp = /Delete|Confirm|Yes|Continue|Deactivate|Activate|Duplicate|Apply|OK/): Promise<string> {
    const dialog = this.page.locator('[role=dialog], [role=alertdialog]').filter({ visible: true }).last();
    if (!(await dialog.waitFor({ timeout: 3_000 }).then(() => true).catch(() => false))) return '';
    // Some confirmations look up linked data first ("Checking what this product is linked to…").
    await this.page.waitForFunction(() => !/Checking what/i.test(document.querySelector('[role=dialog],[role=alertdialog]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => undefined);
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    await dialog.getByRole('button', { name: button }).filter({ hasNotText: /Cancel|Close/ }).last().click();
    await this.page.waitForTimeout(1_200);
    return text;
  }

  /** Clicks something that opens the Export menu, picks a format and saves the file. */
  async download(open: Locator, format: string, saveTo: string): Promise<string | null> {
    await open.click();
    const [download] = await Promise.all([
      this.page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
      this.page.getByRole('menuitem', { name: format }).or(this.page.getByText(format, { exact: true })).first().click(),
    ]);
    if (!download) return null;
    const file = `${saveTo}/${download.suggestedFilename()}`;
    await download.saveAs(file);
    return file;
  }

  async emptyStateText(): Promise<string | null> {
    const marker = this.main.getByText(/Nothing found|No products/i).filter({ visible: true }).first();
    if (!(await marker.count())) return null;
    return (await marker.locator('xpath=../..').innerText()).replace(/\s+/g, ' ').trim();
  }
}
