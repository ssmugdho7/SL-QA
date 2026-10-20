import fs from 'fs';
import path from 'path';
import type { Locator } from 'playwright';
import { config } from '../config.js';
import { Blocked, type CaseContext } from '../context.js';
import { Missing, exactText } from '../ui.js';
import { emptyCategory, resolveCategory } from './fixtures.js';
import { lc, quoted } from './text.js';

/**
 * Step rules: one sentence fragment → one browser action.
 * Rules are tried in order; the first whose pattern matches runs. A fragment no rule matches is reported
 * as "not understood" and the case stops there — nothing is guessed.
 */
export interface StepRule {
  name: string;
  pattern: RegExp;
  run: (t: CaseContext, m: RegExpMatchArray, clause: string) => Promise<void | string>;
}

/** The product a step refers to when it says "a product", "its", "another product"… */
function subject(t: CaseContext, which: 'first' | 'next' = 'first') {
  if (which === 'next') {
    const i = Math.min(t.fixtures.length - 1, (t.noted.get('__subjectIndex') as number | undefined ?? 0) + 1);
    t.noted.set('__subjectIndex', i);
    return t.fixtures[i];
  }
  return t.fixtures[(t.noted.get('__subjectIndex') as number | undefined) ?? 0] ?? t.fixtures[0];
}

/** Undoes the bot's own narrowing search, so list-wide steps see the whole list. */
async function clearFixtureSearch(t: CaseContext): Promise<void> {
  if (t.state.search && t.state.search === t.prefix) {
    await t.ui.search('');
    t.state.search = undefined;
  }
}

/** Narrows the list to the case's own test products so row actions hit them. */
async function showFixtures(t: CaseContext): Promise<void> {
  if (!t.fixtures.length) return;
  if (!(await t.ui.isListPage())) await t.ui.goto(t.startPath);
  await t.ui.setView('list');
  if (t.state.search !== t.prefix) {
    await t.ui.search(t.prefix);
    t.state.search = t.prefix;
  }
}

async function rowName(t: CaseContext, hint: string): Promise<string> {
  if (/ordered|has orders|with orders/i.test(hint) && t.orderedProduct) {
    if (!(await t.ui.isListPage())) await t.ui.goto(t.startPath);
    await t.ui.setView('list');
    await t.ui.search(t.orderedProduct.name);
    t.state.search = t.orderedProduct.name;
    return t.orderedProduct.name;
  }
  if (/variable/i.test(hint)) {
    const variable = t.fixtures.find((f) => f.product_type === 'variable');
    if (variable) {
      await showFixtures(t);
      return variable.name;
    }
  }
  const p = subject(t, /another|other|second|next/i.test(hint) ? 'next' : 'first');
  if (p) {
    await showFixtures(t);
    return p.name;
  }
  const first = (await t.ui.snapshot()).rows[0];
  if (!first) return t.block('There are no products in the list to act on.');
  return first.name;
}

/** Clicks a named control: a dialog button first, then the bulk bar, menu, status tab, page button/link, then any text. */
/** Waits (up to a few seconds) for the app to drop the selection after a bulk action, then for the list to settle. */
async function waitForSelectionReset(t: CaseContext): Promise<void> {
  const cleared = await t.page
    .waitForFunction(() => !document.querySelector('[role=region][aria-label$="selected"]'), null, { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  await t.ui.settle();
  if (cleared) t.noted.set('__selectionCleared', true);
}

const BULK_ACTIONS = /^(activate|deactivate|delete|export|bulk edit|change category.*|copy skus|print barcodes|regenerate skus)$/i;

/** The app clears ticks when the list re-renders (e.g. a moment after a bulk action); tick the intended rows again. */
async function ensureSelection(t: CaseContext): Promise<void> {
  if (!t.selection.length) return;
  await t.ui.settle();
  const bar = t.ui.bulkBar();
  if ((await bar.count()) && (await t.ui.snapshot()).selected === t.selection.length) return;
  for (const name of t.selection) {
    const box = t.ui.row(name).getByLabel('Select row');
    if ((await box.count()) && !(await box.isChecked())) await box.check();
  }
  await bar.waitFor({ timeout: 5_000 }).catch(() => undefined);
}

async function clickNamed(t: CaseContext, name: string, opts: { inRow?: string } = {}): Promise<void> {
  const ui = t.ui;
  const re = exactText(name);
  if (BULK_ACTIONS.test(name) && !(await ui.dialog().count())) await ensureSelection(t);
  if (opts.inRow) {
    const row = ui.row(opts.inRow);
    const target = row.getByRole('button', { name: re }).or(row.getByLabel(re)).or(row.getByRole('link', { name: re })).first();
    if (await target.count()) return void (await target.click());
  }
  const candidates: Locator[] = [
    ui.page.getByRole('menuitem', { name: re }),
    ui.dialog().getByRole('button', { name: re }),
    ui.bulkBar().getByRole('button', { name: re }),
    ui.statusTab(name),
    ui.page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: re }),
    ui.main.getByRole('button', { name: re }),
    ui.main.getByRole('link', { name: re }),
    ui.page.getByRole('button', { name: re }),
    ui.page.getByRole('link', { name: re }),
    ui.page.getByLabel(re),
    ui.main.getByText(name, { exact: true }),
  ];
  for (const c of candidates) {
    const visible = c.filter({ visible: true }).first();
    if (await visible.count().catch(() => 0)) {
      // Short timeout: if this candidate can't be clicked (detached, covered), try the next instead of hanging.
      const clicked = await visible.click({ timeout: 5_000 }).then(() => true).catch(() => false);
      if (clicked) return;
    }
  }
  // Row-level controls ("More actions", "View variants", "Quick view", "Adjust stock") belong to a product row.
  const inRow = await rowName(t, '').catch(() => null);
  if (inRow) {
    const row = ui.row(inRow);
    const target = row.getByLabel(re).or(row.getByRole('button', { name: re })).first();
    if (await target.count()) return void (await target.click());
  }
  const seen = await ui.page.getByRole('button').filter({ visible: true }).allInnerTexts().catch(() => []);
  throw new Missing(`'${name}'`, [...new Set(seen.map((s) => s.trim()).filter(Boolean))]);
}

/**
 * "Click 'Duplicate'" means duplicate: if the click opens a confirmation and the next step does not deal with
 * that dialog itself (confirm / cancel / "in the confirmation box…"), accept it.
 */
async function acceptConfirmation(t: CaseContext, name: string): Promise<string | undefined> {
  const next = (t.noted.get('__next') as string | undefined) ?? '';
  if (/\b(confirm|cancel|confirmation|dialog)\b/i.test(next)) return undefined;
  const dialog = t.ui.dialog();
  if (!(await dialog.waitFor({ timeout: 1_500 }).then(() => true).catch(() => false))) return undefined;
  // Only two-button confirmations; forms like Quick view or Change category are left open.
  if (!(await dialog.getByRole('button', { name: /^cancel$/i }).count()) || (await dialog.locator('input, [role=combobox]').filter({ visible: true }).count())) return undefined;
  const text = await t.ui.dialogText();
  const same = dialog.getByRole('button', { name: exactText(name) });
  const button = (await same.count()) ? same.first() : dialog.getByRole('button').filter({ hasNotText: /^(Cancel|Close)$/i }).filter({ visible: true }).last();
  await t.snap(`'${name}' confirmation`, 'dialog');
  t.noted.set('__confirmText', text);
  await button.click();
  await waitForDialogClose(t);
  return `Accepted the confirmation: "${text.slice(0, 90)}"`;
}

/** After confirming, the app shows a spinner on the button until the request finishes; wait for the dialog to go away. */
async function waitForDialogClose(t: CaseContext): Promise<void> {
  const hadSelection = (await t.ui.snapshot()).selected;
  await t.page
    .waitForFunction(() => ![...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some((d) => d.getClientRects().length), null, { timeout: 15_000 })
    .catch(() => undefined);
  await t.ui.settle();
  // After a bulk action the app clears the selection a moment later; wait for that so the next step's ticks aren't wiped.
  if (hadSelection) await waitForSelectionReset(t);
}

/** Opens a product's detail page (used by "open the product's detail page"). */
async function openDetail(t: CaseContext, name: string): Promise<void> {
  const product = t.fixtures.find((f) => f.name === name) ?? (await t.findProduct(name));
  if (!product) throw new Missing(`product '${name}'`);
  await t.ui.goto(`/dashboard/products/detail?id=${product.id}`, { waitForList: false });
  await t.page.locator('main').getByText(product.sku).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
}

async function typeInSearch(t: CaseContext, text: string, kind = 'text'): Promise<void> {
  if (!(await t.ui.isListPage())) await t.ui.goto(t.startPath);
  await clearFixtureSearch(t);
  await t.ui.search(text);
  t.state.search = text;
  t.state.searchKind = kind;
  t.state.searchTarget = undefined;
}

/** What to type for "type an English product name", "type a product SKU", "type part of a name"… plus what it should find. */
async function valueFor(t: CaseContext, kind: string): Promise<{ value: string; target?: { name?: string; sku?: string } }> {
  const k = lc(kind);
  const values = t.noted.get('__values') as string[] | undefined;
  const next = () => {
    const i = (t.noted.get('__valueIndex') as number | undefined) ?? 0;
    t.noted.set('__valueIndex', i + 1);
    return values?.[i];
  };
  if (/random word|does not exist|no match/.test(k)) return { value: next() ?? 'zzqxx123' };
  if (/sql/.test(k)) return { value: next() ?? "' OR 1=1 --" };
  if (/script/.test(k)) return { value: next() ?? '<script>alert(1)</script>' };
  if (/only spaces|spaces/.test(k)) return { value: next() ?? '   ' };
  next();
  const real = (await t.api.allProducts()).filter((p) => !p.name.startsWith(config.fixturePrefix));
  const sample = real.find((p) => p.name.split(' ')[0].length >= 4 && p.sku) ?? real[0];
  if (!sample) return t.block('The store has no products to search for.');
  if (/bangla/.test(k)) {
    const bangla = real.find((p) => /[\u0980-\u09FF]/.test(p.name)) ?? t.fixtures.find((f) => /[\u0980-\u09FF]/.test(f.name));
    if (!bangla) return t.block('No product with a Bangla name to search for.');
    return { value: bangla.name.match(/[\u0980-\u09FF]+/)![0], target: { name: bangla.name } };
  }
  if (/sku/.test(k)) return { value: sample.sku, target: { sku: sample.sku } };
  if (/part|partial/.test(k)) return { value: sample.name.split(' ')[0].slice(1, 4).toLowerCase(), target: { name: sample.name } };
  return { value: sample.name.toUpperCase(), target: { name: sample.name } };
}

async function readClipboard(t: CaseContext): Promise<string> {
  return t.page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
}

export const STEP_RULES: StepRule[] = [
  // ── Session & navigation ─────────────────────────────────────────────
  {
    name: 'log in',
    pattern: /^(?:then\s+)?log in as (?:the store owner|owner|an? (?:store )?owner)\b/i,
    run: async () => 'Already logged in as the store owner.',
  },
  {
    name: 'log in as other user',
    pattern: /^(?:then\s+)?log in as (?:a |an )?(.+)$/i,
    run: async (t, m) => {
      throw new Blocked(`Needs a second account (${m[1]}); the remaining steps were skipped. Expectations about it are marked as not checked.`, true);
    },
  },
  {
    name: 'log in to empty store',
    pattern: /^log in to a store that has no products/i,
    run: async (t) => {
      const stores = await t.api.stores();
      for (const s of stores) {
        const total = (await t.api.forStore(s.id).listProducts('per_page=1')).meta.total;
        if (total === 0) {
          await t.ui.goto(t.startPath);
          await t.ui.switchStore(s.name);
          t.state.store = s.name;
          return `Switched to store '${s.name}' (0 products).`;
        }
      }
      return t.block("None of this account's stores has 0 products. Create an empty store to run this case.");
    },
  },
  {
    name: 'log out',
    pattern: /^log out\b/i,
    run: async (t) => {
      await t.usePage(await t.newPage({ loggedOut: true }));
      t.state.loggedOut = true;
      return 'Using a logged-out browser.';
    },
  },
  {
    name: 'open page link',
    pattern: /^(?:paste|open|enter|type) the (.+?) (?:page )?(?:link|url)(?: in the browser)?|^open the same link/i,
    run: async (t) => {
      await t.ui.goto(t.startPath, { waitForList: !t.state.loggedOut });
    },
  },
  { name: 'press enter', pattern: /^press enter$/i, run: async () => undefined },
  {
    name: 'open a product',
    pattern: /^open (one|another|a|the) product$/i,
    run: async (t, m) => {
      if (/another/i.test(m[1])) {
        const p = subject(t, 'next');
        return p ? `Using '${p.name}'.` : undefined;
      }
    },
  },
  {
    name: 'open dashboard page',
    pattern: /^(?:open|go to|go back to|return to|navigate to|visit) (?:the )?(?:dashboard\s*>\s*)?([\w &'-]+?)(?: page)?(?: from the left sidebar| from the sidebar)?$/i,
    run: async (t, m) => {
      const page = m[1].trim();
      if (/^(another|one|a|the)\b.*\bproduct\b/i.test(page) || /^product$/i.test(page)) return;
      if (/detail/i.test(page)) return;
      if (lc(page) === lc(pageTitle(t.startPath)) || /^dashboard$/i.test(page) === false) {
        const target = lc(page) === lc(pageTitle(t.startPath)) ? t.startPath : await sidebarPath(t, page);
        await t.ui.goto(target);
        t.state = { filters: {}, store: t.state.store, loggedOut: t.state.loggedOut };
        return;
      }
      await t.ui.goto('/dashboard', { waitForList: false });
    },
  },
  {
    name: 'wait for load',
    pattern: /^wait (?:for (?:the )?(?:page|results?|list)(?: to (?:finish )?load(?:ing)?)?|until)/i,
    run: async (t) => {
      await t.ui.settle();
    },
  },
  {
    name: 'reload',
    pattern: /^(?:reload|refresh)(?: the page)?$/i,
    run: async (t) => {
      await t.page.reload({ waitUntil: t.state.offline ? 'domcontentloaded' : 'networkidle' }).catch(() => undefined);
      if (t.state.offline) await t.page.waitForTimeout(6_000);
      else await t.ui.waitForList().catch(() => undefined);
      t.state.search = undefined;
      t.state.tab = undefined;
    },
  },
  { name: 'scroll', pattern: /^scroll to the (?:bottom|top)/i, run: async (t) => void (await t.page.mouse.wheel(0, 5000)) },
  {
    name: 'go offline',
    pattern: /^turn off the internet|^(?:go|work) offline|^block the (.+?) request/i,
    run: async (t) => {
      await t.page.route(new RegExp(`${config.apiUrl.replace(/[.]/g, '\\.')}/.*\\?`), (route) => route.abort('internetdisconnected'));
      t.state.offline = true;
      return "Blocked the page's data requests (simulated offline).";
    },
  },
  {
    name: 'go online',
    pattern: /^turn (?:the internet|the connection) back on|^(?:go|come) back online|^restore the connection/i,
    run: async (t) => {
      await t.page.unrouteAll();
      t.state.offline = false;
    },
  },
  {
    name: 'switch store',
    pattern: /^switch to (?:a |the )?(?:different|other|another|second) store/i,
    run: async (t) => {
      const stores = await t.api.stores();
      const other = stores.find((s) => s.id !== t.session.storeId);
      if (!other) return t.block('This account has only one store.');
      if (!(await t.ui.isListPage())) await t.ui.goto(t.startPath);
      await t.ui.switchStore(other.name);
      t.state.store = other.name;
      return `Switched to store '${other.name}'.`;
    },
  },

  // ── Looking & noting (they only snapshot; expectations read the snapshots) ──
  {
    name: 'note',
    pattern: /^note\b(.*)$/i,
    run: async (t, m) => {
      t.noted.set(`note:${m[1].trim()}`, t.snaps.length);
    },
  },
  {
    name: 'look/check/compare',
    pattern: /^(?:look at|check|compare|for each tab|find it|look\b)/i,
    run: async () => undefined,
  },
  {
    name: 'open the downloaded file',
    pattern: /^open the downloaded file/i,
    run: async (t) => (t.lastDownload ? `Opened ${path.basename(t.lastDownload)}.` : t.block('No file was downloaded in an earlier step.')),
  },
  {
    name: 'paste',
    pattern: /^paste (?:into|in) (?:a |the )?(?:notepad|text editor|editor)/i,
    run: async (t) => {
      t.clipboard = await readClipboard(t);
      return `Clipboard: ${JSON.stringify(t.clipboard.slice(0, 120))}`;
    },
  },

  // ── Search ───────────────────────────────────────────────────────────
  {
    name: 'clear search',
    pattern: /^clear the (?:search )?box$/i,
    run: async (t) => {
      await t.ui.searchBox().fill('');
    },
  },
  {
    name: 'type quoted in search',
    pattern: /^type '(.+)' in(?:to)? (?:the )?(?:search|'search[^']*')(?: box)?$/i,
    run: async (t, m) => typeInSearch(t, m[1]),
  },
  {
    name: 'type described value',
    pattern: /^type (?:an? |only )?(.+?)(?: in(?:to)? the '[^']+' box| in search)?$/i,
    run: async (t, m) => {
      const { value, target } = await valueFor(t, m[1]);
      await typeInSearch(t, value, lc(m[0]));
      t.state.searchTarget = target;
      return `Typed ${JSON.stringify(value)}.`;
    },
  },

  // ── Tabs, view, sort, rows, pager ────────────────────────────────────
  {
    name: 'click status tab',
    pattern: /^(?:click|open) the '(.+)' tab$/i,
    run: async (t, m) => {
      await clearFixtureSearch(t);
      if (!(await t.ui.exists(t.ui.statusTab(m[1])))) return clickNamed(t, m[1]);
      await t.ui.statusTab(m[1]).click();
      await t.ui.settle();
      t.state.tab = m[1];
    },
  },
  {
    name: 'switch view',
    pattern: /^(?:switch to|click|choose) '?(list|grid)'?(?: view)?(?: again)?$/i,
    run: async (t, m) => {
      await t.ui.setView(lc(m[1]) as 'list' | 'grid');
    },
  },
  {
    name: 'choose sort/menu option',
    pattern: /^choose '(.+)'$/i,
    run: async (t, m) => {
      const menuItem = t.page.getByRole('menuitem', { name: exactText(m[1]) }).or(t.page.getByRole('menuitemradio', { name: exactText(m[1]) }));
      if (!(await menuItem.count())) await t.ui.button('Sort').click().catch(() => undefined);
      const option = t.page.getByRole('menu').getByText(m[1], { exact: true });
      if (!(await option.count())) throw new Missing(`option '${m[1]}'`, (await t.page.getByRole('menu').innerText().catch(() => '')).split('\n'));
      await option.first().click();
      await t.ui.settle();
      t.state.sort = m[1];
    },
  },
  {
    name: 'set rows',
    pattern: /^(?:change|set) rows(?: per page)? to (\d+)$/i,
    run: async (t, m) => {
      await t.ui.setRows(Number(m[1]));
      t.state.rows = Number(m[1]);
    },
  },
  {
    name: 'pager',
    pattern: /^(?:click |go to )?(?:the )?(next|previous|last|first)(?: and (first|last))?(?: page)?(?: button)?$/i,
    run: async (t, m) => {
      const labels = [m[1], m[2]].filter(Boolean).map((x) => `${x[0].toUpperCase()}${x.slice(1).toLowerCase()} page`);
      const notes: string[] = [];
      for (const label of labels) {
        const button = t.page.getByLabel(label, { exact: true });
        const cover = await t.ui.coveredBy(button);
        if (cover) {
          notes.push(`'${label}' is covered by '${cover}'`);
          await t.shot(`${label} covered`);
          t.noted.set(`covered:${label}`, cover);
        }
        await button.click({ timeout: 4_000 }).catch(() => button.dispatchEvent('click'));
        await t.ui.settle();
        if (labels.length > 1) await t.snap(`click ${label}`, 'pager');
      }
      return notes.join('; ') || undefined;
    },
  },
  {
    name: 'go to page N',
    pattern: /^(?:with a sort selected,? )?go to page (\d+)$/i,
    run: async (t, m) => {
      const n = Number(m[1]);
      const button = t.ui.main.getByRole('button', { name: exactText(String(n)) }).filter({ visible: true }).first();
      if (await button.count()) await button.click();
      else for (let i = 1; i < n; i++) await t.page.getByLabel('Next page', { exact: true }).click();
      await t.ui.settle();
    },
  },
  {
    name: 'go to last page',
    pattern: /^go to the last page$/i,
    run: async (t) => {
      const button = t.page.getByLabel('Last page', { exact: true });
      const cover = await t.ui.coveredBy(button);
      if (cover) t.noted.set('covered:Last page', cover);
      await button.click({ timeout: 4_000 }).catch(() => button.dispatchEvent('click'));
      await t.ui.settle();
    },
  },

  // ── Filter dialog ────────────────────────────────────────────────────
  {
    name: 'open filter',
    pattern: /^(?:open|click) '?filter'?(?: again)?$/i,
    run: async (t) => {
      await t.ui.openFilter();
    },
  },
  {
    name: 'set filter field',
    pattern: /^(?:set|choose|select) (stock|category|status|brand|label|[a-z ]+?) = '(.+)'$/i,
    run: async (t, m) => {
      let value = m[2];
      if (/categor/i.test(m[1]) && !/^All /i.test(value)) value = await resolveCategory(t, value);
      const bulkEdit = (await t.ui.dialog().filter({ hasText: /Change category/i }).count()) > 0;
      await t.ui.pickOption(m[1], value);
      if (bulkEdit) return;
      t.state.filters[lc(m[1])] = value;
    },
  },
  {
    name: 'reset filters',
    pattern: /^set (?:both|all|them|the filters?) back to (.+)$/i,
    run: async (t, m) => {
      for (const v of quoted(m[1])) await t.ui.pickOption(null, v);
      t.state.filters = {};
    },
  },
  {
    name: 'choose empty category',
    pattern: /^choose a category that has no products$/i,
    run: async (t) => {
      const name = await emptyCategory(t);
      await t.page.reload({ waitUntil: 'networkidle' });
      await t.ui.waitForList();
      await t.ui.pickOption('category', name);
      t.state.filters.category = name;
    },
  },
  {
    name: 'apply filter (any)',
    pattern: /^apply (?:any|a) filter(?: \(e\.g\. (\w+) = ([^)]+)\))?$/i,
    run: async (t, m) => {
      const field = m[1] ?? 'category';
      const value = /categor/i.test(field) ? await resolveCategory(t, (m[2] ?? '').trim()) : (m[2] ?? '').trim();
      await t.ui.pickOption(field, value);
      await t.ui.dialog().getByRole('button', { name: 'Done' }).click();
      await t.ui.settle();
      t.state.filters[lc(field)] = value;
    },
  },
  {
    name: 'apply filter returning N',
    pattern: /^apply a filter that returns only (\d+) products?$/i,
    run: async (t, m) => {
      const want = Number(m[1]);
      for (const option of ['Low stock', 'Out of stock']) {
        const n = (await t.api.allProducts(option === 'Low stock' ? 'stock=low' : 'stock=out')).length;
        if (n > 0 && n <= Math.max(want, 10)) {
          await t.ui.pickOption('stock', option);
          await t.ui.dialog().getByRole('button', { name: 'Done' }).click();
          await t.ui.settle();
          t.state.filters.stock = option;
          t.noted.set('__filterExpected', n);
          return n === want ? undefined : `No filter returns exactly ${want}; used Stock = '${option}' (${n} products).`;
        }
      }
      return t.block(`No filter returns about ${want} products.`);
    },
  },
  {
    name: 'click done',
    pattern: /^click done$/i,
    run: async (t) => {
      await t.ui.dialog().getByRole('button', { name: 'Done' }).click();
      await t.ui.settle();
    },
  },

  // ── Row actions on products ──────────────────────────────────────────
  {
    name: 'row menu',
    pattern: /^(?:on (?:a|an|any|the) (.*?)products?,? )?click (?:the )?'more actions'(?: \(⋮\))?(?: button)?(?: on (?:a |an |the )?(.*))?$/i,
    run: async (t, m) => {
      const hint = `${m[1] ?? ''} ${m[2] ?? ''}`;
      const name = await rowName(t, hint);
      t.noted.set('__row', name);
      await t.ui.row(name).getByLabel('More actions').click();
      await t.page.getByRole('menu').waitFor({ timeout: 5_000 });
    },
  },
  {
    name: 'row button on a product',
    pattern: /^(?:on (?:a|an|any|the) (variable |simple )?product,? )?click '(view variants|quick view|more details|edit|price|stock)'(?: on (?:a |an |the )?(.*?))?(?: to .*)?$/i,
    run: async (t, m) => {
      const hint = `${m[1] ?? ''} ${m[3] ?? ''}`;
      const name = await rowName(t, hint || 'variable');
      const label = m[2];
      if (/more details/i.test(label)) {
        await t.ui.setView('grid');
        await t.ui.gridCard(name).getByRole('button', { name: /more details/i }).click();
        return;
      }
      await t.ui.row(name).getByLabel(exactText(label)).or(t.ui.row(name).getByRole('button', { name: exactText(label) })).first().click();
      await t.page.waitForTimeout(800);
    },
  },
  {
    name: 'pick a product card',
    pattern: /^(?:pick|find) a (variable |simple )?product(?: card)?/i,
    run: async (t, m) => {
      const name = await rowName(t, m[1] ?? '');
      t.noted.set('__row', name);
      return `Using '${name}'.`;
    },
  },
  {
    name: 'note product fields',
    pattern: /^note its (.+)$/i,
    run: async () => undefined,
  },
  {
    name: 'open product detail',
    pattern: /^open the product'?s? detail page/i,
    run: async (t) => {
      const name = (t.noted.get('__row') as string | undefined) ?? (await rowName(t, ''));
      await openDetail(t, name);
    },
  },
  {
    name: 'close dialog',
    pattern: /^close the (?:dialog|popup|modal)$/i,
    run: async (t) => {
      await t.page.keyboard.press('Escape');
      await t.page.waitForTimeout(400);
    },
  },
  {
    name: 'in X, click Y',
    pattern: /^in (?:the )?(?!confirmation)(.+?),? click '(.+)'$/i,
    run: async (t, m) => {
      const scope = t.ui.dialog();
      const target = scope.getByRole('button', { name: exactText(m[2]) }).or(scope.getByRole('link', { name: exactText(m[2]) })).first();
      if (await target.count()) {
        await target.click();
        await t.ui.settle();
        return;
      }
      await clickNamed(t, m[2]);
    },
  },
  {
    name: 'repeat for another product',
    pattern: /^repeat for (?:a |another )?product/i,
    run: async (t) => {
      const name = await rowName(t, 'another');
      await t.ui.goto(t.startPath);
      t.state.search = undefined;
      await showFixtures(t);
      await t.ui.row(name).getByLabel('More actions').click();
      const last = t.noted.get('__lastMenuItem') as string | undefined;
      if (last) await t.page.getByRole('menuitem', { name: exactText(last) }).click();
      await t.ui.settle();
      if (last) await acceptConfirmation(t, last);
      return `Repeated '${last}' for '${name}'.`;
    },
  },

  // ── Stock / status / product edits (done through the app's API, like the form would) ──
  {
    name: 'adjust stock',
    pattern: /^use 'adjust stock' to (?:bring|set) its stock (?:to (?:exactly )?(\d+)|below its low stock warning)$/i,
    run: async (t, m) => {
      const p = subject(t);
      if (!p) return t.block('No product to adjust.');
      await showFixtures(t);
      const fresh = (await t.refreshFixture(t.fixtures.indexOf(p))) ?? p;
      const target = m[1] !== undefined ? Number(m[1]) : Math.max(0, (fresh.low_stock_threshold || 5) - 2);
      const diff = target - fresh.stock;
      if (diff !== 0) await t.ui.adjustStock(fresh.name, diff > 0 ? 'Stock In' : 'Stock Out', Math.abs(diff));
      return `Stock of '${fresh.name}': ${fresh.stock} → ${target}.`;
    },
  },
  {
    name: 'set low stock warning',
    pattern: /^set its low stock (?:warning|threshold) to (\d+)$/i,
    run: async (t, m) => {
      const p = subject(t);
      await t.api.updateProduct(p.id, { low_stock_threshold: Number(m[1]) });
    },
  },
  {
    name: 'set its stock',
    pattern: /^set its stock to (\d+)$/i,
    run: async (t, m) => {
      const p = (await t.refreshFixture()) ?? subject(t);
      const diff = Number(m[1]) - p.stock;
      if (diff) await t.api.adjustStock(p.id, diff > 0 ? 'in' : 'out', Math.abs(diff)).catch(() => undefined);
    },
  },
  {
    name: 'turn off track inventory',
    pattern: /^turn off 'track inventory'$/i,
    run: async (t) => {
      await t.api.updateProduct(subject(t).id, { track_inventory: false });
    },
  },
  {
    name: 'status inactive',
    pattern: /^turn (?:one|a|the) product'?s? status to (inactive|active)$/i,
    run: async (t, m) => {
      const p = t.fixtures.at(-1)!;
      await showFixtures(t);
      const toggle = t.ui.row(p.name).getByLabel('Toggle status');
      const on = (await toggle.getAttribute('aria-checked')) === 'true';
      if (on === (lc(m[1]) === 'inactive')) await toggle.click();
      await t.ui.settle();
    },
  },
  {
    name: 'save',
    pattern: /^(?:save|and save|click save)$/i,
    run: async (t) => {
      // In an open form dialog, "save" means its submit button (Save / Apply / Update / Done).
      const dialog = t.ui.dialog();
      if (!(await dialog.count())) return;
      const submit = dialog.getByRole('button', { name: /^(save( changes)?|apply|update|done|confirm)$/i }).filter({ visible: true });
      if (!(await submit.count())) return;
      await submit.last().click();
      await waitForDialogClose(t);
      return 'Saved the open dialog.';
    },
  },

  // ── Selection & bulk ─────────────────────────────────────────────────
  {
    name: 'tick one',
    pattern: /^tick the checkbox on (?:one|a) product$/i,
    run: async (t) => {
      await t.ui.goto(t.startPath);
      await t.ui.setView('list');
      await t.ui.main.locator('tbody').getByLabel('Select row').first().check();
      t.selection = [(await t.ui.snapshot()).rows[0]?.name].filter(Boolean);
    },
  },
  {
    name: 'select N products',
    pattern: /^select (?:the same )?(\d+)(?: test)? products?(?: with no orders and (\d+) products? that has orders)?$|^select (?:them|the same \d+) again$|^select the same (\d+)$|^with the same (\d+) selected$/i,
    run: async (t, m) => {
      const n = Number(m[1] ?? m[3] ?? m[4] ?? t.selection.length);
      const ordered = m[2] ? Number(m[2]) : 0;
      let names = t.selection.length && /same|them|with the same/i.test(m[0]) ? t.selection : t.fixtures.slice(0, n).map((f) => f.name);
      if (/same/i.test(m[0]) && t.selection.length > n) names = t.selection.slice(0, n);
      if (!/same|them/i.test(m[0]) && names.length < n) return t.block(`Needs ${n} test products, only ${names.length} were prepared.`);
      if (ordered && t.orderedProduct) names = [...names, t.orderedProduct.name];
      // Selection is cleared when the search changes, so pick from one unfiltered page when real products are involved.
      if (ordered) {
        await t.ui.goto(t.startPath);
        await t.ui.setView('list');
        await t.ui.setRows(100);
        t.state.search = undefined;
      } else {
        await showFixtures(t);
      }
      // "With the same 3 selected" keeps the current selection if those rows are still ticked.
      const ticked = await t.ui.main.locator('tbody tr').filter({ has: t.page.locator('input[type=checkbox]:checked') }).allInnerTexts().catch(() => []);
      if (/with the same/i.test(m[0]) && names.every((n) => ticked.some((x) => x.includes(n)))) return;
      if (ticked.length) {
        const clear = t.ui.bulkBar().getByRole('button', { name: 'Clear selection' });
        if (await clear.count()) await clear.click();
      }
      // A list that is still refreshing (e.g. after a bulk action) re-renders and drops ticks, so let it settle first.
      await t.ui.settle();
      for (const name of names) {
        const box = t.ui.row(name).getByLabel('Select row');
        if (!(await box.count())) {
          // The row left the current view (status tab, page); show all the case's products again.
          await t.ui.goto(t.startPath);
          t.state = { ...t.state, search: undefined, tab: undefined };
          await showFixtures(t);
        }
        await t.ui.row(name).getByLabel('Select row').check();
      }
      // Verify the selection took; tick again once if the list re-rendered underneath.
      if ((await t.ui.snapshot()).selected !== names.length) {
        await t.ui.settle();
        for (const name of names) await t.ui.row(name).getByLabel('Select row').check();
      }
      await t.ui.bulkBar().waitFor({ timeout: 5_000 }).catch(() => undefined);
      t.selection = names;
    },
  },
  {
    name: 'select this page',
    pattern: /^click 'select this page'$/i,
    run: async (t) => {
      await t.page.getByLabel('Select this page').filter({ visible: true }).first().check();
    },
  },
  {
    name: 'copy skus',
    pattern: /^click 'copy skus'$/i,
    run: async (t) => {
      await t.ui.bulkBar().getByRole('button', { name: 'Copy SKUs' }).click();
      const copy = t.ui.dialog().getByRole('button', { name: /copy list/i });
      if (await copy.count()) await copy.click();
      await t.page.waitForTimeout(500);
      await t.page.keyboard.press('Escape');
    },
  },
  {
    name: 'export',
    pattern: /^click '(export page|export)'$/i,
    run: async (t, m) => {
      if (!/page/i.test(m[1])) t.noted.set('__exportSelection', [...t.selection]);
      const opener = /page/i.test(m[1]) ? t.ui.button('Export page') : t.ui.bulkBar().getByRole('button', { name: 'Export', exact: true });
      await opener.click();
      const [download] = await Promise.all([
        t.page.waitForEvent('download', { timeout: 20_000 }).catch(() => null),
        t.page.getByRole('menuitem', { name: /csv/i }).or(t.page.getByText('CSV (.csv)', { exact: true })).first().click(),
      ]);
      if (!download) return t.block('Export did not start a download.');
      const file = path.join(t.runDir, 'downloads', `${t.tc.id}-${download.suggestedFilename()}`);
      await download.saveAs(file);
      t.lastDownload = file;
      return `Downloaded ${path.basename(file)} (${fs.statSync(file).size} bytes).`;
    },
  },

  {
    name: 'with selection, click',
    pattern: /^with the same \d+ selected, (click '.+')$/i,
    run: async (t, m) => {
      const rule = STEP_RULES.find((r) => r.name !== 'with selection, click' && r.pattern.test(m[1]))!;
      return rule.run(t, m[1].match(rule.pattern)!, m[1]);
    },
  },

  // ── Confirmations ────────────────────────────────────────────────────
  {
    name: 'confirm',
    pattern: /^(?:and )?(?:this time )?confirm$/i,
    run: async (t) => {
      const text = await t.ui.dialogText();
      t.noted.set('__confirmText', text);
      if (!text) return;
      const dialog = t.ui.dialog();
      await dialog.getByRole('button').filter({ hasNotText: /^(Cancel|Close)$/i }).filter({ visible: true }).last().click();
      await waitForDialogClose(t);
      return `Confirmed: "${text.slice(0, 100)}"`;
    },
  },
  {
    name: 'cancel',
    pattern: /^(?:in the confirmation box )?click 'cancel'$/i,
    run: async (t) => {
      t.noted.set('__confirmText', await t.ui.dialogText());
      await t.ui.dialog().getByRole('button', { name: /^cancel$/i }).click();
      await t.page.waitForTimeout(600);
    },
  },
  {
    name: 'click X again and confirm',
    pattern: /^click '(.+)' again(?: and)?(?: this time)? confirm$/i,
    run: async (t, m) => {
      const row = t.noted.get('__row') as string | undefined;
      if (row) {
        await t.ui.row(row).getByLabel('More actions').click();
        await t.page.getByRole('menuitem', { name: exactText(m[1]) }).click();
      } else await clickNamed(t, m[1]);
      const text = await t.ui.dialogText();
      t.noted.set('__confirmText', text);
      await t.ui.dialog().getByRole('button').filter({ hasNotText: /^(Cancel|Close)$/i }).filter({ visible: true }).last().click();
      await waitForDialogClose(t);
    },
  },

  // ── Forms ────────────────────────────────────────────────────────────
  {
    name: 'enter product name',
    pattern: /^enter a product name$/i,
    run: async (t) => {
      const name = `${t.prefix} ${t.tc.testData.match(/'([^']+)'/)?.[1] ?? 'Item'}`;
      const input = t.page.getByLabel(/product name/i).or(t.page.getByPlaceholder(/samsung|product name/i)).first();
      await input.fill(name);
      t.noted.set('__enteredName', name);
    },
  },
  {
    name: 'create product',
    pattern: /^create a product with (?:a )?(\d+)-character name/i,
    run: async () => undefined,
  },

  // ── Generic click (last, so the specific rules above win) ────────────
  {
    name: 'click named control',
    pattern: /^(?:click|press|tap|open) (?:the )?'([^']+)'(?: (?:button|tab|link|menu item|option))?(?: (?:at the (?:bottom|top)|on (?:a|the|any) product.*))?$/i,
    run: async (t, m) => {
      const name = m[1];
      const inMenu = t.page.getByRole('menuitem', { name: exactText(name) });
      if (await inMenu.count()) {
        t.noted.set('__lastMenuItem', name);
        await inMenu.first().click();
        await t.ui.settle();
        return acceptConfirmation(t, name);
      }
      if (!(await t.ui.isListPage()) && /^(sort|filter|list|grid|select this page)$/i.test(name)) await t.ui.goto(t.startPath);
      const bulk = BULK_ACTIONS.test(name) && t.selection.length > 0 && !/^(export|copy skus|print barcodes)$/i.test(name);
      await clickNamed(t, name);
      await t.ui.settle();
      const accepted = await acceptConfirmation(t, name);
      // Activate/Deactivate without a dialog: the selection is reset a moment later, as with confirmed actions.
      if (bulk && !accepted && !(await t.ui.dialog().count())) await waitForSelectionReset(t);
      return accepted;
    },
  },
  {
    name: 'click bare word',
    pattern: /^click (sort|filter|done|next|previous|cancel|delete|save)$/i,
    run: async (t, m) => clickNamed(t, m[1]),
  },
];

/** Title of a dashboard path: "/dashboard/products" → "Products". */
export function pageTitle(p: string): string {
  const last = p.split('?')[0].split('/').filter(Boolean).pop() ?? 'dashboard';
  return last[0].toUpperCase() + last.slice(1);
}

/** Finds a sidebar link by its label ("Products", "Orders") and returns its path. */
async function sidebarPath(t: CaseContext, label: string): Promise<string> {
  const href = await t.page.evaluate((l) => {
    const want = l.toLowerCase();
    const links = [...document.querySelectorAll('nav a[href^="/dashboard"]')] as HTMLAnchorElement[];
    const hit = links.find((a) => a.innerText.split('\n').map((s) => s.trim().toLowerCase()).includes(want));
    return hit?.getAttribute('href') ?? null;
  }, label).catch(() => null);
  return href ?? t.startPath;
}
