import fs from 'fs';
import path from 'path';
import type { Locator } from 'playwright';
import { config } from '../config.js';
import { Blocked, type CaseContext } from '../context.js';
import { Missing, escapeRe, exactText } from '../ui.js';
import { emptyCategory, resolveCategory } from './fixtures.js';
import { pageNames, pagePath, PAGE_NAMES } from '../pages.js';
import { lc, quoted, words } from './text.js';

/**
 * Step rules: one sentence fragment → one browser action.
 * Rules are tried in order; the first whose pattern matches runs. A fragment no rule matches is reported
 * as "not understood" and the case stops there — nothing is guessed.
 */
export interface StepRule {
  name: string;
  pattern: RegExp;
  /** Only for cases about the Add/Edit Product form (see onProductForm); other cases skip this rule. */
  formOnly?: boolean;
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

export async function rowName(t: CaseContext, hint: string): Promise<string> {
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

export async function clickNamed(t: CaseContext, name: string, opts: { inRow?: string } = {}): Promise<void> {
  const ui = t.ui;
  const re = exactText(name);
  // "Open it again" / "click it again" repeat this click.
  t.noted.set('__lastClick', name);
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
  // A label with extra text after the name: 'Checkout' → "Checkout ৳650.00", 'Discount or coupon' field.
  const starts = new RegExp(`^\\s*${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu');
  for (const c of [ui.dialog().getByRole('button', { name: starts }), ui.page.getByRole('button', { name: starts }), ui.page.getByRole('link', { name: starts }), ui.page.getByRole('tab', { name: starts })]) {
    const visible = c.filter({ visible: true }).first();
    if (await visible.count().catch(() => 0)) {
      if (await visible.click({ timeout: 5_000 }).then(() => true).catch(() => false)) return;
    }
  }
  // Row-level controls ("More actions", "View variants", "Quick view", "Adjust stock") belong to a product row.
  const inRow = t.fixtures.length || (await ui.isListPage()) ? await rowName(t, '').catch(() => null) : null;
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
export async function acceptConfirmation(t: CaseContext, name: string): Promise<string | undefined> {
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

/** One quoted name in 'single', "double" or curly quotes (one capture group); an apostrophe inside a word (Don't) stays in it. */
export const Q = `['"‘“]((?<=')(?:[^']|'(?=[A-Za-z]))+(?=')|(?<=")[^"]+(?=")|(?<=‘)[^’]+(?=’)|(?<=“)[^”]+(?=”))['"’”]`;

/** A target that reads like a dashboard page: a known name, "… page/screen/section", or a breadcrumb "A > B". */
const PAGE_TARGET = `(?:dashboard\\s*[>›]\\s*)?(?:(${PAGE_NAMES})(?:\\s+(?:page|screen|section|module|menu))?|((?!(?:the\\s+)?(?:last|next|previous|first|\\d+|same|new|any|an?|one|some|this|that|its|their|downloaded)\\b)(?!(?:the\\s+)?(?:[\\w'-]+\\s+)?details?\\b)[\\w &'/-]+?)\\s+(?:page|screen|section|module)|([\\w &'/-]+?\\s*[>›]\\s*[\\w &'/>›-]+?))`;

export const STEP_RULES: StepRule[] = [
  // ── Session & navigation ─────────────────────────────────────────────
  {
    name: 'log in',
    pattern: /^(?:then\s+)?log ?in as (?:the |an? )?(?:store |shop )?(?:owner|admin(?:istrator)?|merchant)\b/i,
    run: async () => 'Already logged in as the store owner.',
  },
  {
    name: 'log in as other user',
    pattern: /^(?:then\s+)?log ?in as (?:a |an )?(.+)$/i,
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
  {
    name: 'press enter',
    pattern: /^(?:press|hit) (?:the )?enter(?: key)?$/i,
    run: async (t) => {
      // Search boxes filter as you type; Enter only matters (and is safe) in a focused search or text box.
      const focused = await t.page.evaluate(() => { const e = document.activeElement as HTMLInputElement | null; return !!e && e.tagName === 'INPUT' && /^(search|text|)$/.test(e.type); }).catch(() => false);
      if (!focused) return 'No text box had focus; nothing to submit.';
      await t.page.keyboard.press('Enter');
      await t.ui.settle();
    },
  },
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
    name: 'open quoted path',
    pattern: new RegExp(`^(?:open|go to|visit|navigate to) (?:the )?['"](/[^'"\\s]*)['"](?: page)?$`, 'i'),
    run: async (t, m) => {
      await t.ui.goto(m[1]);
      return `Opened ${m[1]}.`;
    },
  },
  {
    name: 'open dashboard page',
    // Only targets that read like a page: "open the Filter panel", "open a product", "Open the Stock tab" are not navigation.
    pattern: new RegExp(`^(?:open|go to|go back to|return to|navigate to|visit|switch to|move to|head to) (?:the )?${PAGE_TARGET}(?: (?:from|in|on|via|using) the (?:left )?(?:sidebar|side ?bar|menu|side menu|navigation(?: menu)?))?$`, 'i'),
    run: async (t, m) => {
      const page = (m[1] ?? m[2] ?? m[3]).trim();
      const target = lc(page) === lc(pageTitle(t.startPath)) ? t.startPath : pagePath(page) ?? (await sidebarPath(t, page));
      if (target) {
        await t.ui.goto(target);
        t.state = { filters: {}, store: t.state.store, loggedOut: t.state.loggedOut };
        return `Opened ${target}.`;
      }
      // "Products > Add Product": the page, then the control on it.
      const crumbs = page.split(/\s*[>›]\s*/).filter(Boolean);
      const parent = crumbs.length > 1 ? pagePath(crumbs.slice(0, -1).join(' > ')) : null;
      if (parent) {
        await t.ui.goto(parent);
        t.state = { filters: {}, store: t.state.store, loggedOut: t.state.loggedOut };
        await clickNamed(t, crumbs.at(-1)!);
        await t.ui.settle();
        return `Opened ${parent} and clicked '${crumbs.at(-1)}'.`;
      }
      throw new Missing(`a page named '${page}'`, nearPages(page));
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
    pattern: /^(?:reload|refresh)(?: the)?(?: (?:page|browser|screen|list|tab|browser tab))?(?: again)?$|^(?:press f5|hard refresh(?: the page)?)$/i,
    run: async (t) => {
      await t.page.reload({ waitUntil: t.state.offline ? 'domcontentloaded' : 'networkidle' }).catch(() => undefined);
      if (t.state.offline) await t.page.waitForTimeout(6_000);
      else await t.ui.waitForList().catch(() => undefined);
      t.state.search = undefined;
      t.state.tab = undefined;
    },
  },
  {
    name: 'scroll',
    pattern: /^scroll (?:(down|up)(?: the (?:page|list))?(?: a (?:bit|little))?(?: (?:more|again))?|(?:(down|up) )?to the (bottom|top|end|end of the (?:page|list))\b.*)$/i,
    run: async (t, m) => {
      const up = /up|top/i.test(`${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? ''}`);
      if (/top/i.test(m[3] ?? '')) await t.page.evaluate(() => window.scrollTo(0, 0));
      else await t.page.mouse.wheel(0, up ? -800 : m[3] ? 20_000 : 800);
      await t.page.waitForTimeout(400);
    },
  },
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
    // "Note the count" remembers; "note 'Test'" (a value in quotes) is text for a Note field, read by a later rule.
    pattern: /^note\b(?!\s*[:=]?\s*['"‘“][^'"’”]*['"’”]\s*$)(.*)$/i,
    run: async (t, m) => {
      t.noted.set(`note:${m[1].trim()}`, t.snaps.length);
    },
  },
  {
    name: 'look/check/compare',
    // Only looking: "Check the Stock History tab" opens a tab, "check the log after deleting a product" does something first.
    pattern: /^(?!(?:look at|check|look)\s+(?:the\s+)?[^,]*\btab$)(?!.*\b(?:after|before|while|once)\s+\w+ing\b)(?!check(?:\s+the)?\s+(?:check ?box|box)\b)(?:look at|check|compare|for each tab|find it|look\b)/i,
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
    pattern: new RegExp(`^(?:type|enter|input) ${Q} in(?:to)? (?:the )?(?:search|'search[^']*'|"search[^"]*")(?: (?:box|bar|field|input))?$`, 'i'),
    run: async (t, m) => typeInSearch(t, m[1]),
  },
  {
    name: 'search products by kind',
    pattern: /^search (?:for )?(?:an? |the |any )?products? (?:by|with|using) (?:its |their |the |an? )?(sku|name|english name|bangla name|part of (?:its |the |a )?name|partial name)$/i,
    run: async (t, m) => {
      if (!/\/dashboard\/products(?:[?#]|$)/.test(new URL(t.page.url()).pathname)) await t.ui.goto('/dashboard/products');
      const { value, target } = await valueFor(t, m[1]);
      await typeInSearch(t, value, lc(m[0]));
      t.state.searchTarget = target;
      return `Searched ${JSON.stringify(value)}.`;
    },
  },
  {
    name: 'type described value',
    // A description of what to type ("a Bangla product name", "a random word"); a quoted value is typed as written elsewhere.
    pattern: /^type (?!(?:an? |only )?['"‘“])(?=.*\b(?:random|not exist|no match|sql|script|spaces|bangla|english|sku|part(?:ial)?|name|word)\b)(?:an? |only )?(.+?)(?: in(?:to)? the '[^']+' box| in(?:to)? (?:the )?search(?: box| bar)?)?$/i,
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
    pattern: new RegExp(`^(?:click|open) the ${Q} tab$`, 'i'),
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
    pattern: /^(?:with a sort selected,? )?(?:go|navigate|move|switch|jump) to page (?:number |no\.? )?(\d+)(?: of the (?:list|results|table))?$|^(?:open|click(?: on)?) page (\d+)(?: (?:button|link))?$/i,
    run: async (t, m) => {
      const n = Number(m[1] ?? m[2]);
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
    pattern: /^(?:open|click(?: on)?) (?:the )?['"‘“]?filter['"’”]?(?: (?:panel|button|dialog|drawer|menu|icon|options))?(?: again)?$/i,
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
      const before = await t.ui.showingText();
      await t.ui.dialog().getByRole('button', { name: 'Done' }).click();
      await t.ui.settle();
      await t.ui.waitForListChange(before);
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
      const label = m[2];
      // On a record's own page (detail, edit) the button is the page's, not a row's.
      if (!m[1] && !m[3] && !(await t.ui.isListPage())) return clickNamed(t, label);
      const hint = `${m[1] ?? ''} ${m[3] ?? ''}`;
      const name = await rowName(t, hint || 'variable');
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
    pattern: /^open (?:the |any |a |one )?product'?s?(?: details?)? page|^open (?:the )?(?:product )?detail(?:s)? page of (?:a|any|the) product/i,
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
      if (!(await dialog.count())) {
        // A form on the page itself (settings, a category form): its Save button. None: an earlier step already saved.
        const onPage = t.ui.main.getByRole('button', { name: /^\s*(save( changes)?|update|save & (?:close|continue))\s*$/i }).filter({ visible: true });
        if (!(await onPage.count())) return 'Nothing open to save (no form with a Save button).';
        await onPage.last().click();
        await t.ui.settle();
        return 'Clicked Save on the page.';
      }
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
    pattern: /^select (?:the same )?(\d+)(?: test)? products?(?: with no orders and (\d+) products? that has orders)?(?: (?:using|with|by ticking|by clicking|via) (?:the |their )?(?:row )?check ?box(?:es)?| from the list)?$|^select (?:them|the same \d+) again$|^select the same (\d+)$|^with the same (\d+) selected$/i,
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
    pattern: new RegExp(`^(?:click|press|tap|open) (?:on )?(?:the )?${Q}(?: (?:button|tab|link|menu item|option))?(?: (?:at the (?:bottom|top)|on (?:a|the|any) product.*))?$`, 'i'),
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
    run: async (t, m, clause) => {
      // "Click Delete" with nothing selected or in use would delete whatever the page shows first.
      if (/delete/i.test(m[1]) && !(await t.ui.dialog().count())) guard(t, m[1], clause);
      return clickNamed(t, m[1]);
    },
  },
];

/** Clicks that change or lose real data; plain-language steps may do them only on test records ('BTB …'). */
const DANGER = /\b(?:delete|remove|archive|trash|cancel (?:the )?(?:order|subscription|plan|invoice|shipment|consignment)|refund|void|disconnect|uninstall|deactivate|log ?out|sign ?out|empty cart|clear cart)\b/i;
const HARMLESS = /\b(?:filters?|search|sort|selection|image preview|item from (?:the )?cart)\b/i;

/** Throws Blocked when `name` would delete, cancel, refund … something that is not a test record. */
export function guard(t: CaseContext, name: string, clause: string): void {
  if (!DANGER.test(name) || HARMLESS.test(name)) return;
  const btb = new RegExp(`\\b${config.fixturePrefix}\\b`);
  // The sentence names a test record, the rows ticked for a bulk action are all test products, or the record in use is one.
  const row = t.noted.get('__row') as string | undefined;
  if (btb.test(clause) || (t.selection.length && t.selection.every((n) => btb.test(n))) || (!t.selection.length && row && btb.test(row))) return;
  throw new Blocked(`"${clause}" would ${name.toLowerCase()} real store data, so the bot did not do it and stopped here. Write the step about a test record named '${config.fixturePrefix} …' to let it run.`, true);
}

/** Title of a dashboard path: "/dashboard/products" → "Products". */
export function pageTitle(p: string): string {
  const last = p.split('?')[0].split('/').filter(Boolean).pop() ?? 'dashboard';
  return last[0].toUpperCase() + last.slice(1);
}

/** Finds a sidebar link by its label ("Products", "Orders") and returns its path, or null when there is none. */
export async function sidebarPath(t: CaseContext, label: string): Promise<string | null> {
  return t.page.evaluate((l) => {
    const want = l.toLowerCase().replace(/\s+/g, ' ').trim();
    const links = [...document.querySelectorAll('nav a[href^="/dashboard"], aside a[href^="/dashboard"]')] as HTMLAnchorElement[];
    const hit = links.find((a) => a.innerText.split('\n').map((s) => s.trim().toLowerCase()).includes(want));
    return hit?.getAttribute('href') ?? null;
  }, label).catch(() => null);
}

/** Known page names sharing a word with `name` (else a sample), for a "no such page" message. */
export function nearPages(name: string): string[] {
  const all = Object.keys(pageNames()).filter((n) => n.length < 40 && !/ (?:under|in) /.test(n));
  const want = new Set(words(name).split(' ').filter((w) => w.length > 2 && !/^(?:page|the|and)$/.test(w)));
  const near = all.filter((n) => words(n).split(' ').some((w) => want.has(w) || [...want].some((x) => w.startsWith(x.slice(0, 5)))));
  return [...new Set(near.length ? near : all.filter((n) => !n.includes('>')))].slice(0, 12);
}
