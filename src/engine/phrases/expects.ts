import fs from 'fs';
import { parse } from 'csv-parse/sync';
import type { CaseContext, Shot } from '../context.js';
import type { Card, Snap } from '../ui.js';
import { lc, list, listItems, money, orderBreak, quoted, words } from './text.js';

/**
 * Expectation rules: one claim from the Expected Result column → one or more checks.
 * Rules read the snapshots the steps left behind (and, where the UI cannot tell, the app's API).
 * A claim no rule understands is recorded as "not checked" with the sentence — never guessed.
 */
export interface ExpectRule {
  name: string;
  pattern: RegExp;
  check: (t: CaseContext, m: RegExpMatchArray, claim: string) => Promise<unknown>;
}

const step = (t: CaseContext) => t.snaps.filter((s) => s.kind !== 'initial');
const first = (t: CaseContext) => t.snaps[0]?.snap;
const last = (t: CaseContext): Snap => t.snaps.at(-1)!.snap;
const shotAfter = (t: CaseContext, re: RegExp) => t.snaps.filter((s) => re.test(s.after));
const cardsText = (cards: Card[]) => cards.map((c) => `${c.label} ${c.value ?? '?'}${c.pct !== null ? ` (${c.pct}%)` : ''}`).join(', ');
const card = (snap: Snap | undefined, label: string) => snap?.cards.find((c) => lc(c.label) === lc(label));

/** Snapshot for the claim's moment: "after refresh" → the last snapshot after a reload, etc. */
function momentFor(t: CaseContext, claim: string): Shot[] {
  if (/after (?:a )?refresh|after reload/i.test(claim)) return shotAfter(t, /refresh|reload/i);
  if (/after cancel/i.test(claim)) return shotAfter(t, /cancel/i);
  if (/after confirming|after (?:the )?delet/i.test(claim)) return shotAfter(t, /confirm/i);
  if (/after ticking/i.test(claim)) return shotAfter(t, /tick/i);
  if (/after applying the filter/i.test(claim)) return shotAfter(t, /filter/i);
  return [];
}

function snapsWithTabs(t: CaseContext) {
  return step(t).filter((s) => /tab|click '(all|active|draft|archived)'|^'(all|active|draft|archived)'$/i.test(s.after));
}

function csvRows(file: string): Record<string, string>[] {
  return parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), { columns: true, skip_empty_lines: true, relax_column_count: true });
}

function hasBom(file: string): boolean {
  const raw = fs.readFileSync(file);
  return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
}

/** Visible text check that tolerates page chrome: the text is a whole heading/button/label on the page. */
function shown(snap: Snap, text: string): boolean {
  return new RegExp(`(^|[\\s|>(])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s|<).,:])`, 'i').test(snap.text);
}

async function fixtureNow(t: CaseContext, i = 0) {
  const f = t.fixtures[i];
  if (!f) return undefined;
  return (await t.findProduct(f.name)) ?? undefined;
}

export const EXPECT_RULES: ExpectRule[] = [
  // ── Things shown on the page ─────────────────────────────────────────
  {
    name: 'title and text shown',
    pattern: /^the page title '(.+?)' and the text '(.+?)' should be shown$/i,
    check: async (t, m) => {
      const s = step(t)[0]?.snap ?? last(t);
      const title = shown(s, m[1]);
      const sub = shown(s, m[2]);
      t.check(`Title '${m[1]}' and text '${m[2]}' are shown`, title && sub, `title ${title ? 'shown' : 'missing'}, text ${sub ? 'shown' : 'missing'}`,
        'The page header did not render these texts.');
    },
  },
  {
    name: 'named buttons/tabs visible',
    pattern: /^the (buttons|tabs|links|options) (.+?) should be visible(?:, with '(.+)' highlighted)?$/i,
    check: async (t, m) => {
      const names = quoted(m[2]).length ? quoted(m[2]) : listItems(m[2]);
      const s = step(t)[0]?.snap ?? last(t);
      const missing: string[] = [];
      for (const n of names) {
        const visible = (await t.ui.exists(t.ui.button(n))) || shown(s, n);
        if (!visible) missing.push(n);
      }
      t.check(`${m[1][0].toUpperCase()}${m[1].slice(1)} ${names.map((n) => `'${n}'`).join(', ')} are visible`, !missing.length,
        missing.length ? `missing: ${list(missing)}` : 'all visible',
        'These controls are hidden — usually a permission or feature-flag check, or a class that hides them at this screen width.');
      if (m[3]) {
        const hit = s.current.some((c) => lc(c) === lc(m[3]));
        t.check(`'${m[3]}' is highlighted`, hit, `highlighted: ${list(s.current.filter((c) => names.some((n) => lc(c) === lc(n))))}`,
          'The active-tab logic does not match this route.');
      }
    },
  },
  {
    name: 'summary cards zero',
    pattern: /^all summary cards should show 0(?: and 0%)?/i,
    check: async (t) => {
      const s = last(t);
      const nums = s.cards.map((c) => c.value);
      t.check('Summary cards show 0 with no NaN or blank values', s.cards.length > 0 && nums.every((n) => n === 0) && !/NaN|undefined|Infinity/.test(s.text),
        s.cards.length ? cardsText(s.cards) : 'no summary cards found', 'A card is computed as count/total without guarding total = 0.');
      const withPct = s.cards.slice(1);
      t.check("Cards show '0%' under each count", withPct.length > 0 && withPct.every((c) => c.pct === 0),
        withPct.every((c) => c.pct === null) ? "no '% of catalog' line is shown when the store is empty" : withPct.map((c) => `${c.label}: ${c.pct ?? '—'}%`).join(', '),
        "The '% of catalog' line is hidden when the total is 0; render '0% of catalog' instead.");
    },
  },
  {
    name: 'empty state with option',
    pattern: /^an empty-state message(?: with an? '(.+?)' option)? should be shown(?: instead of the .+| with no error)?$/i,
    check: async (t, m) => {
      const s = last(t);
      const option = m[1] ? shown(s, m[1]) : true;
      const serverError = t.failedRequests.some((r) => /^5\d\d/.test(r));
      t.check(`An empty-state message${m[1] ? ` with an '${m[1]}' option` : ''} is shown`, !!s.empty && option && !serverError,
        `${s.empty ?? 'no empty-state message'}${m[1] ? `; '${m[1]}' ${option ? 'present' : 'missing'}` : ''}${serverError ? '; server error' : ''}`,
        'The list shows a blank area instead of an empty state.');
    },
  },
  {
    name: 'pagination text',
    pattern: /^pagination should show '(.+)'$/i,
    check: async (t, m) => {
      const s = last(t);
      t.check(`Pagination shows '${m[1]}'`, s.showing?.text === m[1].replace(/-/g, '–'), s.showing?.text ?? 'no pagination text');
    },
  },
  {
    name: 'redirected to login',
    pattern: /^a logged-out user should be redirected to the login page$/i,
    check: async (t) => {
      const s = last(t);
      const leaked = /SKU-|৳\d/.test(s.text) && !s.path.startsWith('/login');
      t.check('Logged-out user is redirected to the login page', s.path.startsWith('/login') && !leaked, `landed on ${s.path}${leaked ? ' with product data visible' : ''}`,
        'The dashboard route guard is missing or runs after data is fetched.');
    },
  },
  {
    name: 'error with retry',
    pattern: /^a clear error message with a '(.+)' option should be shown$/i,
    check: async (t, m) => {
      const s = last(t);
      const error = /error|failed|couldn.?t|could not|try again|offline|connection/i.test(s.text);
      const retry = await t.ui.exists(t.ui.button(new RegExp(`${m[1]}|try again|reload`, 'i')));
      const misleading = /\b0 results\b|Nothing found|Showing 0–0 of 0/.test(s.text);
      t.check(`A clear error message with a '${m[1]}' option is shown`, error && retry,
        `error text ${error ? 'present' : 'absent'}, '${m[1]}' button ${retry ? 'present' : 'absent'}${misleading ? '; the page shows an empty "0 results" list instead' : ''}`,
        'The data request failure is not handled: the list falls back to an empty state, so a failure looks like "no products". Show the error with a retry button.');
    },
  },
  {
    name: 'not blank',
    pattern: /^the page should not go blank or freeze$/i,
    check: async (t) => {
      const s = last(t);
      t.check('Page does not go blank or freeze', s.text.trim().length > 50, s.text.trim().length > 50 ? 'page still rendered' : 'page is blank');
    },
  },
  {
    name: 'recovers after connection',
    pattern: /^it should load normally after the connection is back(?: and (.+) is clicked)?$/i,
    check: async (t, m) => {
      await t.page.unrouteAll({ behavior: 'ignoreErrors' });
      t.state.offline = false;
      const retry = t.ui.button(new RegExp(`${m[1] ?? 'retry'}|try again`, 'i'));
      if (await t.ui.exists(retry)) await retry.click();
      else await t.page.reload({ waitUntil: 'networkidle' });
      await t.ui.waitForList().catch(() => undefined);
      await t.ui.settle();
      let s = await t.snap('connection back');
      // Without a Retry button the only way back is a reload; give the list one more chance to fill in.
      if (!s.showing?.total) {
        await t.page.reload({ waitUntil: 'networkidle' });
        await t.ui.settle();
        s = await t.snap('connection back (reload)');
      }
      t.check('Page loads normally after the connection is back', !!s.showing && s.showing.total > 0, s.showing?.text ?? 'list did not load',
        'The page does not recover after a failed load.');
    },
  },

  // ── Stores ───────────────────────────────────────────────────────────
  {
    name: 'only selected store',
    pattern: /^only the selected store's (.+) should be shown$/i,
    check: async (t) => {
      const s = last(t);
      const stores = await t.api.stores();
      const other = stores.find((x) => lc(x.name) === lc(t.state.store ?? ''));
      if (!other) return t.skip("Only the selected store's data is shown", 'The test did not switch store.');
      const theirs = await t.api.forStore(other.id).listProducts();
      const names = new Set(theirs.data.map((p) => p.name));
      const leaked = s.rows.filter((r) => !names.has(r.name)).map((r) => r.name);
      t.check(`Only '${other.name}' products are shown`, !leaked.length, leaked.length ? `not in '${other.name}': ${list(leaked.slice(0, 5))}` : `${s.rows.length} rows, all from '${other.name}'`,
        "The list is cached without the store in its key, so the previous store's rows survive the switch.");
      const total = card(s, 'Total Products')?.value ?? s.cards[0]?.value;
      t.check('Summary numbers change to the selected store', total === theirs.meta.total, `card ${total}, store has ${theirs.meta.total}`, 'Summary cards are cached per page rather than per store.');
    },
  },
  {
    name: 'no product from other store',
    pattern: /^no product from the other store should appear$/i,
    check: async (t) => {
      const before = first(t);
      const s = last(t);
      const overlap = (before?.rows ?? []).filter((r) => s.rows.some((a) => a.name === r.name)).map((r) => r.name);
      t.check('No product from the other store appears', !overlap.length, overlap.length ? `still shown: ${list(overlap.slice(0, 5))}` : 'no overlap');
    },
  },

  // ── Numbers on cards vs lists ────────────────────────────────────────
  {
    name: 'card equals tab count',
    pattern: /^(.+?) should equal the '(.+)' tab count$/i,
    check: async (t, m) => {
      const s = first(t)!;
      const cardValue = card(s, m[1])?.value ?? null;
      const tab = s.tabs[m[2]]?.count ?? null;
      const shot = shotAfter(t, new RegExp(`'${m[2]}' tab`, 'i')).at(-1)?.snap;
      const listed = shot?.showing?.total ?? null;
      t.check(`${m[1]} equals the '${m[2]}' tab count`, cardValue !== null && cardValue === tab && (listed === null || listed === tab),
        `card ${cardValue}, tab ${tab}${listed !== null ? `, list ${listed}` : ''}`, 'The card and the list use different queries (e.g. the card counts archived or draft products).');
    },
  },
  {
    name: 'card equals filter count',
    pattern: /^the (.+?) card should equal the (.+?) filter count$/i,
    check: async (t, m) => {
      const cardValue = card(first(t), m[1])?.value ?? null;
      const shot = t.snaps.filter((s) => lc(s.state.filters.stock ?? '') === lc(m[2])).at(-1)?.snap;
      const filtered = shot?.showing?.total ?? null;
      t.check(`${m[1]} card equals the ${m[2]} filter count`, cardValue !== null && cardValue === filtered, `card ${cardValue}, filter ${filtered ?? 'not applied'}`,
        'The card and the filter use different rules (e.g. < vs ≤ threshold, or one ignores untracked products).');
    },
  },
  {
    name: 'cards add up',
    pattern: /^(.+?) \+ (.+?) \+ (.+?) should add up to (.+)$/i,
    check: async (t, m) => {
      const s = first(t)!;
      const get = (label: string) => {
        const l = lc(label.trim());
        if (l === 'in stock') return Number(s.cards.find((c) => /in stock/i.test(c.sub))?.sub.match(/(\d+) in stock/)?.[1] ?? NaN);
        return card(s, label.trim())?.value ?? NaN;
      };
      const [a, b, c, total] = [get(m[1]), get(m[2]), get(m[3]), get(m[4])];
      t.check(`${m[1]} + ${m[2]} + ${m[3]} = ${m[4]}`, a + b + c === total,
        `${a} + ${b} + ${c} = ${a + b + c}, ${m[4]} ${total}${a + c === total ? ' (low-stock items appear to be counted inside "in stock")' : ''}`,
        "'N in stock' includes low-stock products, so the three buckets overlap. Exclude low stock from 'in stock' or label it 'available'.");
    },
  },
  {
    name: 'coloured bar',
    pattern: /^the coloured bar should show the same split$/i,
    check: async (t, m, claim) => t.skip(claim, 'The bar has no readable values; compare the screenshot by eye.'),
  },
  {
    name: 'card increases/decreases',
    pattern: /^(.+?) should (increase|decrease) by (\d+)$/i,
    check: async (t, m) => {
      const label = m[1].replace(/^the /i, '').replace(/ (tab )?count$/i, '').trim();
      const before = first(t);
      const after = last(t);
      const fromTab = (s?: Snap) => s?.tabs[label[0].toUpperCase() + label.slice(1)]?.count ?? null;
      const b = card(before, label)?.value ?? fromTab(before);
      const a = card(after, label)?.value ?? fromTab(after);
      const want = (b ?? 0) + (lc(m[2]) === 'increase' ? 1 : -1) * Number(m[3]);
      t.check(`${label} ${m[2]}s by ${m[3]}`, a === want && b !== null, `${b} → ${a}`, `${label} is not recalculated after the change (cached, or not invalidated).`);
    },
  },
  {
    name: 'percentages',
    pattern: /^the percentage under each card .* should be recalculated correctly$/i,
    check: async (t) => {
      const s = last(t);
      const total = s.cards[0]?.value ?? 0;
      const bad = s.cards.slice(1).filter((c) => c.pct !== null && c.value !== null && total > 0 && Math.abs(c.pct - (c.value / total) * 100) >= 1);
      t.check("'x% of catalog' percentages are correct", !bad.length, s.cards.slice(1).map((c) => `${c.label} ${c.pct}% (${c.value}/${total})`).join(', '),
        'Percentages are computed from a stale or different total.');
    },
  },
  {
    name: 'card and filter agree',
    pattern: /^the (?:product should be treated the same way in both the card and the filter.*|card and the filter should never disagree)$/i,
    check: async (t, m, claim) => {
      const p = await fixtureNow(t);
      if (!p) return t.skip(claim, 'No test product to compare.');
      const inFilter = !!(await t.findProduct(p.name, 'stock=low'));
      t.check(/never disagree/i.test(claim) ? 'Card and filter never disagree' : 'Card and filter treat the product the same way', p.is_low_stock === inFilter,
        `card rule says low stock = ${p.is_low_stock}, Low stock filter includes it = ${inFilter} (stock ${p.stock}, threshold ${p.low_stock_threshold})`,
        'The card query and the filter query use different comparisons (< vs ≤). Use one shared rule for "low stock".');
    },
  },
  {
    name: 'not counted low/out',
    pattern: /^the product should not be counted in low stock or out of stock$/i,
    check: async (t) => {
      const p = await fixtureNow(t);
      if (!p) return t.skip('Not counted as low/out of stock', 'No test product.');
      const low = !!(await t.findProduct(p.name, 'stock=low'));
      const out = !!(await t.findProduct(p.name, 'stock=out'));
      t.check('Not counted as Low stock', !low, low ? 'counted as low stock' : 'not counted', 'The low-stock rule does not exclude products with Track Inventory off.');
      t.check('Not counted as Out of stock', !out, out ? 'counted as out of stock' : 'not counted', 'The out-of-stock rule does not exclude products with Track Inventory off.');
    },
  },

  // ── Status tabs ──────────────────────────────────────────────────────
  {
    name: 'tab shows only that status',
    pattern: /^each tab should only show products with that status$/i,
    check: async (t) => {
      for (const s of snapsWithTabs(t)) {
        const tab = Object.entries(s.snap.tabs).find(([, v]) => v.active)?.[0];
        if (!tab || tab === 'All') continue;
        const api = await t.api.allProducts(`status=${lc(tab)}`);
        const wrong = s.snap.rows.filter((r) => !api.some((p) => p.name === r.name)).map((r) => r.name);
        t.check(`'${tab}' tab shows only ${lc(tab)} products`, !wrong.length, wrong.length ? `not ${lc(tab)}: ${list(wrong.slice(0, 5))}` : `${s.snap.rows.length} rows`);
      }
    },
  },
  {
    name: 'tab number matches results',
    pattern: /^the number on the tab should match the .+ text$/i,
    check: async (t) => {
      for (const s of snapsWithTabs(t)) {
        const [tab, info] = Object.entries(s.snap.tabs).find(([, v]) => v.active) ?? [];
        if (!tab || !info) continue;
        t.check(`'${tab}' tab number matches the result count`, info.count === s.snap.showing?.total, `tab ${info.count}, list ${s.snap.showing?.text ?? 'n/a'}`,
          'Tab counts come from a different query than the list.');
      }
    },
  },
  {
    name: 'empty tab message',
    pattern: /^a tab with 0 products should show an empty-state message$/i,
    check: async (t) => {
      const empties = snapsWithTabs(t).filter((s) => s.snap.showing?.total === 0);
      if (!empties.length) return t.skip('A tab with 0 products shows an empty state', 'No tab had 0 products.');
      for (const s of empties) {
        const tab = Object.entries(s.snap.tabs).find(([, v]) => v.active)?.[0];
        t.check(`'${tab}' tab with 0 products shows an empty-state message`, !!s.snap.empty, s.snap.empty ?? 'no message');
      }
    },
  },
  {
    name: 'appears under tab',
    pattern: /^the product should appear under the (\w+) tab(?: and not under (\w+))?$/i,
    check: async (t, m) => {
      const name = t.noted.get('__enteredName') as string | undefined;
      const s = last(t);
      const there = !!name && s.rows.some((r) => r.name === name);
      t.check(`Product appears under ${m[1]}`, there, there ? 'listed' : name ? `'${name}' not listed` : 'the product was not created');
    },
  },

  // ── Search ───────────────────────────────────────────────────────────
  {
    name: 'search shows only matching',
    pattern: /^each search should show only the matching products$/i,
    check: async (t) => {
      const searches = t.snaps.filter((s) => s.state.search && /type/i.test(s.after) && s.state.search !== t.prefix);
      for (const s of searches) {
        const term = s.state.search!;
        const rows = s.snap.rows;
        const want = s.state.searchTarget;
        const target = want?.name ?? want?.sku;
        const found = want ? rows.some((r) => (want.name && r.name === want.name) || (want.sku && r.sku === want.sku)) : rows.length > 0;
        const unrelated = rows.filter((r) => ![r.name, r.sku, r.category, r.brand].some((v) => lc(v).includes(lc(term.trim())))).map((r) => r.name);
        t.check(`Search '${term}' finds the product`, found, `${rows.length} result(s)${found ? '' : `, '${target}' missing`}`,
          /[ঀ-৿]/.test(term) ? 'Unicode search is broken — check the database collation for Bangla.' : 'Search does not cover this field.');
        t.check(`Search '${term}' shows only matching products`, !unrelated.length, unrelated.length ? `non-matching: ${list(unrelated.slice(0, 5))}` : 'all match',
          'Search also matches hidden fields (description, variant names).');
      }
    },
  },
  {
    name: 'case and partial',
    pattern: /^search should not depend on upper\/lower case$|^partial words should also match/i,
    check: async (t, m, claim) => {
      const searches = t.snaps.filter((s) => s.state.search && /type/i.test(s.after));
      const relevant = /partial/i.test(claim) ? searches.filter((s) => /part/i.test(s.state.searchKind ?? '')) : searches.filter((s) => s.state.search !== lc(s.state.search!) || s.state.search !== s.state.search!.toUpperCase());
      if (!relevant.length) return t.skip(claim, 'No matching search step ran.');
      for (const s of relevant) t.check(`${/partial/i.test(claim) ? 'Partial' : 'Upper-case'} search '${s.state.search}' finds results`, s.snap.rows.length > 0, `${s.snap.rows.length} result(s)`,
        /partial/i.test(claim) ? 'Search matches whole words or prefixes only; use a contains match.' : 'Search is case-sensitive.');
    },
  },
  {
    name: 'zero results for no match',
    pattern: /^a '0 results' empty state should be shown for no match$/i,
    check: async (t) => {
      const s = t.snaps.find((x) => /random|does not exist/i.test(x.state.searchKind ?? ''))?.snap ?? last(t);
      t.check("No-match search shows a '0 results' empty state", !!s.empty && (s.showing?.total === 0), `${s.showing?.text ?? 'no count'}; ${s.empty ?? 'no empty-state message'}`);
    },
  },
  {
    name: 'special text normal',
    pattern: /^special text should be treated as normal text$/i,
    check: async (t) => {
      for (const s of t.snaps.filter((x) => /sql|script/i.test(x.state.searchKind ?? ''))) {
        t.check(`'${s.state.search}' is treated as normal text`, s.snap.showing !== null && !s.snap.rows.length, `${s.snap.showing?.text ?? 'list missing'}`,
          'Search input reaches the query unescaped — use parameter binding.');
      }
    },
  },
  {
    name: 'no popup',
    pattern: /^no pop-up should run$/i,
    check: async (t) => t.check('No pop-up runs', t.dialogsFired === 0, t.dialogsFired ? `${t.dialogsFired} alert(s) ran — XSS` : 'no pop-up', 'Search text is rendered as HTML. Render it as text.'),
  },
  {
    name: 'no server error',
    pattern: /^no server error should appear$/i,
    check: async (t) => {
      const errors = t.failedRequests.filter((r) => /^5\d\d/.test(r));
      t.check('No server error', !errors.length, errors.length ? list(errors) : 'none');
    },
  },
  {
    name: 'spaces = empty search',
    pattern: /^only spaces should behave like an empty search/i,
    check: async (t) => {
      const total = first(t)?.showing?.total;
      const s = t.snaps.find((x) => /spaces/i.test(x.state.searchKind ?? ''))?.snap;
      t.check('Only spaces behaves like an empty search', s?.showing?.total === total, `${s?.showing?.total} of ${total}`, 'The search term is not trimmed before it is sent.');
    },
  },
  {
    name: 'all conditions',
    pattern: /^only products that match all (?:\w+ )?conditions \((.+)\) should be shown$/i,
    check: async (t) => {
      const s = last(t);
      const st = t.snaps.at(-1)!.state;
      const category = st.filters.category;
      const term = st.search ?? '';
      const status = lc(st.tab ?? 'all');
      const api = await t.api.allProducts(status === 'all' ? '' : `status=${status}`);
      const expected = api.filter((p) => (!category || p.category?.name === category) && (lc(p.name).includes(lc(term)) || lc(p.sku).includes(lc(term)))).map((p) => p.name);
      const wrong = s.rows.filter((r) => !expected.includes(r.name)).map((r) => `${r.name} (${r.category})`);
      const missing = expected.filter((n) => !s.rows.some((r) => r.name === n));
      t.check(`Only ${[st.tab, category, term && `'${term}'`].filter(Boolean).join(' + ')} products are shown`, !wrong.length && !missing.length,
        `${s.rows.length} shown${wrong.length ? `; outside: ${list(wrong)}` : ''}${missing.length ? `; missing: ${list(missing)}` : ''}`,
        'One of the conditions is dropped when combined.');
    },
  },

  // ── Sort ─────────────────────────────────────────────────────────────
  {
    name: 'sort options',
    pattern: /^options should be:? (.+)$/i,
    check: async (t, m) => {
      const want = listItems(m[1]);
      const s = shotAfter(t, /sort/i).find((x) => x.snap.menu.length)?.snap;
      const got = (s?.menu ?? []).filter((x) => !/^sort by$/i.test(x));
      t.check(`Options are: ${want.join(', ')}`, want.length === got.length && want.every((w, i) => lc(w) === lc(got[i])), `found: ${list(got)}`);
    },
  },
  {
    name: 'reordered correctly',
    pattern: /^the list should be re-ordered correctly for each option$/i,
    check: async (t) => {
      const byName = t.snaps.filter((s) => s.state.sort && /choose/i.test(s.after));
      for (const s of byName) {
        const names = s.snap.rows.map((r) => r.name);
        const sort = s.state.sort!;
        if (/name/i.test(sort)) {
          const at = orderBreak(names, /\(z/i.test(sort) ? 'desc' : 'asc');
          t.check(`'${sort}' orders the list correctly`, at < 0, at < 0 ? `${names.length} rows in order` : `'${names[at - 1]}' comes before '${names[at]}'`,
            'Sorting uses a collation that differs from natural order (e.g. byte order puts "Solution" before "in"). Sort case-insensitively.');
        } else {
          const key = /newest/i.test(sort) ? 'created_at:desc' : /oldest/i.test(sort) ? 'created_at:asc' : 'updated_at:desc';
          const api = (await t.api.listProducts(`sort=${encodeURIComponent(key)}`)).data.map((p) => p.name);
          const same = names.length > 0 && names.every((n, i) => n === api[i]);
          t.check(`'${sort}' re-orders the list`, same, same ? 'matches the server order' : `shown: ${list(names.slice(0, 3))}; server: ${list(api.slice(0, 3))}`);
        }
      }
    },
  },
  {
    name: 'page 2 continues order',
    pattern: /^page 2 should continue the same order/i,
    check: async (t) => {
      const p2 = shotAfter(t, /page 2/i).at(-1);
      const p1 = t.snaps[t.snaps.indexOf(p2!) - 1];
      if (!p2 || !p1) return t.skip('Page 2 continues the same order', 'Page 2 was not opened.');
      if (!p2.snap.rows.length) return t.skip('Page 2 continues the same order', 'Only one page of products.');
      const sort = p2.state.sort ?? '';
      const names2 = [...p1.snap.rows, ...p2.snap.rows].map((r) => r.name);
      if (!/name/i.test(sort)) {
        // Date sorts: page 1 + page 2 must equal the server's first 2 pages in that order.
        const key = /newest/i.test(sort) ? 'created_at:desc' : /oldest/i.test(sort) ? 'created_at:asc' : 'updated_at:desc';
        // The API only allows fixed page sizes, so ask for 100 and compare the first rows.
        const api = (await t.api.listProducts(`sort=${encodeURIComponent(key)}`)).data.map((p) => p.name);
        const same = names2.every((n, i) => n === api[i]);
        return t.check(`Page 2 continues the '${sort}' order`, same, same ? `${names2.length} rows match the server order` : `page 2 starts with '${p2.snap.rows[0]?.name}', server has '${api[p1.snap.rows.length]}'`,
          'Sort is applied per page instead of in the server query.');
      }
      const joined = names2;
      const at = orderBreak(joined, /\(z/i.test(sort) ? 'desc' : 'asc');
      t.check('Page 2 continues the same order', at < 0, at < 0 ? `last on page 1 '${p1.snap.rows.at(-1)?.name}', first on page 2 '${p2.snap.rows[0]?.name}'` : `break at '${joined[at - 1]}' → '${joined[at]}'`,
        'Sort is applied per page instead of in the server query, or the collation is wrong.');
    },
  },

  // ── Filter ───────────────────────────────────────────────────────────
  {
    name: 'only matching filters',
    pattern: /^only products matching the selected (.+) should be shown$/i,
    check: async (t) => {
      const s = t.snaps.filter((x) => Object.keys(x.state.filters).length).at(-1);
      if (!s) return t.skip('Only matching products are shown', 'No filter was applied.');
      const f = s.state.filters;
      const query = [f.stock && `stock=${/low/i.test(f.stock) ? 'low' : 'out'}`].filter(Boolean).join('&');
      const api = (await t.api.allProducts(query)).filter((p) => !f.category || p.category?.name === f.category).map((p) => p.name);
      const wrong = s.snap.rows.filter((r) => !api.includes(r.name)).map((r) => r.name);
      t.check(`Only products matching ${Object.entries(f).map(([k, v]) => `${k} = '${v}'`).join(' + ')} are shown`, !wrong.length && s.snap.rows.length === Math.min(api.length, s.snap.rows.length || api.length),
        `${s.snap.rows.length} shown${wrong.length ? `; not matching: ${list(wrong)}` : ''}`, 'A filter is dropped when combined.');
    },
  },
  {
    name: 'filter button active',
    pattern: /^the filter button should show that a filter is active$/i,
    check: async (t) => {
      const before = first(t)?.filterButton ?? '';
      const s = t.snaps.find((x) => Object.keys(x.state.filters).length)?.snap;
      t.check('Filter button shows a filter is active', !!s && s.filterButton !== before, `before "${before}", after "${s?.filterButton}"`, 'The Filter button has no active indicator.');
    },
  },
  {
    name: 'reset brings full list',
    pattern: /^resetting (?:both |the |all )?filters should bring back the full list$/i,
    check: async (t) => {
      const total = first(t)?.showing?.total;
      const now = last(t).showing?.total;
      t.check('Resetting filters brings back the full list', now === total, `${now} of ${total}`);
    },
  },

  // ── View & paging ────────────────────────────────────────────────────
  {
    name: 'list columns',
    pattern: /^list view should show the columns:? (.+)$/i,
    check: async (t, m) => {
      const want = listItems(m[1]).map((c) => c.toUpperCase());
      const s = t.snaps.find((x) => x.snap.view === 'list' && x.snap.columns.length)?.snap;
      const missing = want.filter((c) => !s?.columns.includes(c));
      t.check(`List view shows columns ${want.join(', ')}`, !missing.length, `found: ${list(s?.columns ?? [])}${missing.length ? `; missing: ${list(missing)}` : ''}`);
    },
  },
  {
    name: 'grid shows cards',
    pattern: /^grid view should show product cards$/i,
    check: async (t) => {
      const s = t.snaps.find((x) => x.snap.view === 'grid')?.snap;
      t.check('Grid view shows product cards', !!s && s.gridItems > 0 && !s.columns.length, s ? `${s.gridItems} cards` : 'grid view never shown');
    },
  },
  {
    name: 'view persists',
    pattern: /^the chosen view should stay the same after refresh$/i,
    check: async (t) => {
      const after = momentFor(t, 'after refresh').at(-1);
      const chosen = after ? t.snaps[t.snaps.indexOf(after) - 1]?.snap.view : null;
      t.check('Chosen view stays the same after refresh', !!after && after.snap.view === chosen, `chosen ${chosen}, after refresh ${after?.snap.view}`, 'View choice is not saved.');
    },
  },
  {
    name: 'rows per page',
    pattern: /^the number of products per page should match the selected rows value$/i,
    check: async (t) => {
      for (const s of t.snaps.filter((x) => x.state.rows && /rows|^\+?\d+$/i.test(x.after))) {
        const total = s.snap.showing?.total ?? 0;
        const want = Math.min(s.state.rows!, total);
        t.check(`Rows = ${s.state.rows} shows ${want} products`, s.snap.rows.length === want, `${s.snap.rows.length} shown`);
      }
    },
  },
  {
    name: 'page buttons work',
    pattern: /^page buttons should work$/i,
    check: async (t) => {
      const moves = t.snaps.filter((s) => s.kind === 'pager' || /next|previous|last|first/i.test(s.after));
      if (!moves.length) return t.skip('Page buttons work', 'No page button was clicked.');
      for (const s of moves) {
        const label = s.after.match(/(next|previous|last|first)/i)?.[1] ?? s.after;
        const sh = s.snap.showing;
        const ok = !!sh && (/next/i.test(label) ? sh.from > 1 : /previous|first/i.test(label) ? sh.from === 1 : /last/i.test(label) ? sh.to === sh.total : true);
        t.check(`'${label}' page button works`, ok, sh?.text ?? 'no pagination');
      }
      for (const [label, cover] of [...t.noted].filter(([k]) => k.startsWith('covered:'))) {
        t.check(`'${label.slice(8)}' button can be clicked`, false, `covered by '${cover}'`, 'A floating button sits on top of the pager at this window size; add bottom padding to the list or move the floating button.');
      }
    },
  },
  {
    name: 'pager disabled states',
    pattern: /^previous\/first should be disabled on page 1, next\/last on the last page$/i,
    check: async (t) => {
      const p1 = t.snaps.find((s) => s.snap.showing?.from === 1 && s.snap.pager['First page'] !== null)?.snap;
      const lastPage = t.snaps.find((s) => s.snap.showing && s.snap.showing.to === s.snap.showing.total && s.snap.showing.from > 1)?.snap;
      if (p1) t.check('Previous/First disabled on page 1', !!p1.pager['First page'] && !!p1.pager['Previous page'], `First ${p1.pager['First page'] ? 'disabled' : 'enabled'}, Previous ${p1.pager['Previous page'] ? 'disabled' : 'enabled'}`);
      if (lastPage) t.check('Next/Last disabled on the last page', !!lastPage.pager['Next page'] && !!lastPage.pager['Last page'], `Next ${lastPage.pager['Next page'] ? 'disabled' : 'enabled'}, Last ${lastPage.pager['Last page'] ? 'disabled' : 'enabled'}`);
      else t.skip('Next/Last disabled on the last page', 'Only one page of products.');
    },
  },
  {
    name: 'filter resets page',
    pattern: /^after applying the filter, the list should go back to page 1 and show the (\d+) products/i,
    check: async (t) => {
      const s = shotAfter(t, /apply a filter/i).at(-1)?.snap;
      const expected = (t.noted.get('__filterExpected') as number | undefined) ?? Number.NaN;
      t.check(`After filtering, the list is on page 1 with ${expected} products`, !!s && s.showing?.from === (expected ? 1 : 0) && s.rows.length === expected,
        `${s?.showing?.text}, ${s?.rows.length} rows`, 'The page number is kept when filters change. Reset to page 1 on filter change.');
    },
  },

  // ── Product cards, variants, quick view ──────────────────────────────
  {
    name: 'card matches detail',
    pattern: /^name, type .* on the card should match the detail page$/i,
    check: async (t) => {
      const name = t.noted.get('__row') as string;
      const product = t.fixtures.find((f) => f.name === name) ?? (await t.findProduct(name));
      if (!product) return t.skip('Card matches the detail page', 'No product was picked.');
      const cardShot = t.snaps.find((s) => s.snap.view === 'grid' && s.snap.text.includes(name))?.snap ?? t.snaps.find((s) => s.snap.rows.some((r) => r.name === name))?.snap;
      const detail = last(t).text;
      const cardText = cardShot?.text ?? '';
      const type = product.product_type === 'simple' ? 'Simple' : 'Variable';
      for (const [label, value] of [['Name', product.name], ['Type', type], ['SKU', product.sku], ['Category', product.category?.name ?? '—']] as const) {
        t.check(`${label} matches (card vs detail)`, cardText.includes(value) && detail.includes(value), `'${value}': card ${cardText.includes(value) ? '✓' : '✗'}, detail ${detail.includes(value) ? '✓' : '✗'}`);
      }
      const row = cardShot?.rows.find((r) => r.name === name);
      const cardPrice = money(row?.price ?? cardText.split(name)[1] ?? '');
      const detailPrices = [...detail.matchAll(/(?:^|[^A-Za-z])(?:Price|Discount Price) (৳[\d,.]+)/g)].map((x) => money(x[1]));
      t.check('Price matches (card vs detail)', cardPrice !== null && detailPrices.includes(cardPrice), `card ৳${cardPrice}, detail ${detailPrices.map((p) => `৳${p}`).join(' / ')}`);
    },
  },
  {
    name: 'variable price range',
    pattern: /^the card should show the price range \((.+?)\) or the lowest price/i,
    check: async (t, m) => {
      const v = t.fixtures.find((f) => f.product_type === 'variable');
      const s = t.snaps.find((x) => x.snap.rows.some((r) => r.name === v?.name))?.snap;
      const row = s?.rows.find((r) => r.name === v?.name);
      const prices = (v?.variants ?? []).map((x) => Number(x.price));
      const min = Math.min(...prices);
      const ok = !!row && (new RegExp(`৳${min}(\\.00)?\\s*[–-]`).test(row.price) || new RegExp(`from\\s*৳${min}`, 'i').test(row.price));
      t.check(`Card shows the price range or 'from ৳${min}'`, ok, `shows "${row?.price ?? '?'}"`, "For variable products, show 'min – max' (or 'from min') computed from the variants.");
    },
  },
  {
    name: 'not zero price',
    pattern: /^it should not show ৳0\.00$/i,
    check: async (t) => {
      const v = t.fixtures.find((f) => f.product_type === 'variable');
      const row = t.snaps.flatMap((x) => x.snap.rows).find((r) => r.name === v?.name);
      t.check('Price is not ৳0.00', !!row && !/৳0\.00/.test(row.price), `shows "${row?.price ?? '?'}"`, "The card shows the product's own price, which is empty/0 for variable products.");
    },
  },
  { name: 'observation note', pattern: /^\[observed.*\]$/i, check: async (t, m, claim) => t.note(`Sheet note: ${claim}`) },
  {
    name: 'variants listed',
    pattern: /^view variants should list every variant/i,
    check: async (t) => {
      const v = t.fixtures.find((f) => f.product_type === 'variable');
      const dlg = t.snaps.find((s) => /variants/i.test(s.snap.dialog))?.snap.dialog ?? '';
      if (!v) return t.skip('Variants are listed', 'No variable product.');
      const fresh = await t.api.getProduct(v.id);
      const missing = fresh.variants.filter((x) => !(dlg.includes(x.sku) && dlg.includes(`৳${Number(x.price).toFixed(2)}`))).map((x) => x.name);
      t.check('Every variant is listed with price, SKU and stock', !missing.length, missing.length ? `missing: ${list(missing)}` : `${fresh.variants.length} variants listed`);
      t.check("Each variant shows its attribute (e.g. 'Weight: 50g')", /Weight:?\s*50g/i.test(dlg), `dialog: "${dlg.slice(0, 140)}"`, 'The dialog shows only the variant name, not the attribute label.');
    },
  },
  {
    name: 'variant stock sum',
    pattern: /^the stocks should add up to the stock on the card$/i,
    check: async (t) => {
      const v = t.fixtures.find((f) => f.product_type === 'variable');
      if (!v) return t.skip('Variant stocks add up', 'No variable product.');
      const fresh = await t.api.getProduct(v.id);
      const sum = fresh.variants.reduce((n, x) => n + x.stock, 0);
      const row = t.snaps.flatMap((x) => x.snap.rows).find((r) => r.name === v.name);
      const shownStock = Number(row?.stock.match(/-?\d+/)?.[0]);
      t.check('Variant stocks add up to the card stock', shownStock === sum, `variants ${sum}, card ${shownStock}`);
    },
  },
  {
    name: 'dialog shows fields',
    pattern: /^(quick view|the dialog|the popup) should show (.+)$/i,
    check: async (t, m) => {
      const fields = listItems(m[2]);
      const dlg = t.snaps.filter((s) => s.snap.dialog).find((s) => fields.every((f) => new RegExp(`\\b${f}\\b`).test(s.snap.dialog)))?.snap.dialog
        ?? t.snaps.filter((s) => /quick view/i.test(s.after)).at(-1)?.snap.dialog ?? '';
      const absent = fields.filter((f) => !new RegExp(`\\b${f}\\b`).test(dlg));
      t.check(`${m[1]} shows ${fields.join(', ')}`, !absent.length, absent.length ? `missing: ${list(absent)}` : 'all shown');
    },
  },
  {
    name: 'opens detail page',
    pattern: /^'(.+)' should open the product detail page$/i,
    check: async (t, m) => {
      const s = last(t);
      t.check(`'${m[1]}' opens the product detail page`, /\/dashboard\/products\/detail/.test(s.path), s.path);
    },
  },
  {
    name: 'long name truncated',
    pattern: /^the long name should be cut with/i,
    check: async (t) => {
      const p = t.fixtures[0];
      await t.ui.goto(t.startPath);
      await t.ui.setView('grid');
      await t.ui.search(t.prefix);
      const el = t.ui.main.getByText(p.name, { exact: true }).filter({ visible: true }).first();
      const st = await el.evaluate((e) => {
        const cs = getComputedStyle(e);
        return {
          truncated: cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none' || e.scrollHeight > e.clientHeight + 2,
          clamp: `${cs.textOverflow}/${cs.webkitLineClamp}`,
          title: e.getAttribute('title') ?? e.closest('[title]')?.getAttribute('title') ?? '',
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      }).catch(() => null);
      await t.shot('long name');
      if (!st) return t.skip('Long name is cut', 'Card not found.');
      t.check("Long name is cut with '…'", st.truncated, `text-overflow/line-clamp: ${st.clamp}`, 'Name has no line-clamp/ellipsis.');
      t.check('Full name is available on hover', st.title === p.name, st.title ? 'title attribute present' : 'no title attribute', 'Add a title attribute (or tooltip) on the truncated name.');
      t.check('Card layout does not break', !st.overflow, st.overflow ? 'page scrolls sideways' : 'no overflow');
    },
  },
  {
    name: 'placeholder image',
    pattern: /^a placeholder image should be shown instead of a broken image$/i,
    check: async (t) => {
      const imgs = await t.ui.gridCard(t.fixtures[0].name).locator('img').evaluateAll((xs) => xs.map((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).catch(() => []);
      t.check('Placeholder instead of a broken image', imgs.every(Boolean), imgs.length ? `${imgs.length} image(s), ${imgs.every(Boolean) ? 'all load' : 'broken'}` : 'placeholder (no image)');
    },
  },

  // ── Row actions ──────────────────────────────────────────────────────
  {
    name: 'copy created',
    pattern: /^a copy of the product should be created/i,
    check: async (t) => {
      const p = t.fixtures[0];
      const copies = (await t.api.allProducts(`q=${encodeURIComponent(t.prefix)}`)).concat(await t.api.allProducts(`q=${encodeURIComponent(t.prefix)}&status=draft`)).filter((x) => x.id !== p.id);
      const copy = copies[0];
      t.check('A copy of the product is created', !!copy, copy ? `'${copy.name}'` : 'no copy found');
      if (copy) {
        t.check('Copy has a new SKU and URL', copy.sku !== p.sku && copy.slug !== p.slug, `SKU ${p.sku} → ${copy.sku}, URL ${p.slug} → ${copy.slug}`);
        t.check("Copy's name marks it as a copy", /copy/i.test(copy.name), copy.name);
      }
    },
  },
  {
    name: 'original unchanged',
    pattern: /^the original product should not change$/i,
    check: async (t) => {
      const p = t.fixtures[0];
      const now = await t.api.getProduct(p.id);
      t.check('Original product does not change', now.name === p.name && now.sku === p.sku && Number(now.price) === Number(p.price), `${now.name}, ${now.sku}, ৳${now.price}`);
    },
  },
  {
    name: 'total increases',
    pattern: /^total products should increase by (\d+)$/i,
    check: async (t, m) => {
      const before = card(first(t), 'Total Products')?.value ?? 0;
      await t.ui.goto(t.startPath);
      let after = card(await t.snap('reopen list'), 'Total Products')?.value;
      // The cards can lag behind the list for a moment; give them one reload before judging.
      if (after === before) {
        await t.page.waitForTimeout(1_500);
        await t.ui.goto(t.startPath);
        after = card(await t.snap('reopen list again'), 'Total Products')?.value;
      }
      t.check(`Total Products increases by ${m[1]}`, after === before + Number(m[1]), `${before} → ${after}`, 'The copy is a draft and Total Products only counts active products, or the card is not refreshed.');
    },
  },
  {
    name: 'confirmation appears',
    pattern: /^a confirmation box should appear before deleting$/i,
    check: async (t) => {
      const text = t.snaps.map((s) => s.snap.dialog).find((d) => /delete/i.test(d)) ?? '';
      t.check('A confirmation box appears before deleting', !!text, text || 'no dialog');
    },
  },
  {
    name: 'still there after cancel',
    pattern: /^after cancel, the product should still be there$/i,
    check: async (t) => {
      const s = momentFor(t, 'after cancel').at(-1)?.snap;
      const name = t.noted.get('__row') as string;
      t.check('After Cancel, the product is still there', !!s?.rows.some((r) => r.name === name), s?.rows.some((r) => r.name === name) ? 'still listed' : 'gone');
    },
  },
  {
    name: 'removed after confirm',
    pattern: /^after confirming, the product should be removed$|^both should be deleted$|^the products without orders should be deleted$/i,
    check: async (t, m, claim) => {
      const names = /both|without orders/i.test(claim) ? t.selection.filter((n) => n !== t.orderedProduct?.name) : [t.noted.get('__row') as string];
      const left = (await Promise.all(names.map((n) => t.findProduct(n)))).filter(Boolean).map((p) => p!.name);
      t.check(`${names.length > 1 ? `The ${names.length} products are` : 'The product is'} removed`, !left.length, left.length ? `still listed: ${list(left)}` : 'removed');
    },
  },
  {
    name: 'success message',
    pattern: /^a success message should appear$/i,
    check: async (t) => {
      const toast = [...t.toasts, ...t.snaps.map((s) => s.snap.toast)].filter(Boolean).join(' | ');
      t.check('A success message appears', /delet|success|done|removed|deactivat|archiv/i.test(toast), toast || 'no message');
    },
  },
  {
    name: 'cards update',
    pattern: /^the summary cards should update$/i,
    check: async (t) => {
      const before = card(first(t), 'Total Products')?.value;
      const live = card(last(t), 'Total Products')?.value;
      await t.page.reload({ waitUntil: 'networkidle' });
      await t.ui.waitForList().catch(() => undefined);
      const reloaded = card(await t.ui.snapshot(), 'Total Products')?.value;
      t.check('Summary cards update', live !== before, `${before} → ${live}${live === before ? `; after a page reload: ${reloaded}` : ''}`,
        'The delete invalidates the product list but not the summary cards; refresh both.');
    },
  },
  {
    name: 'blocked with reason',
    pattern: /^the system should block the delete .* and show a clear reason$/i,
    check: async (t) => {
      const dialog = (t.noted.get('__confirmText') as string | undefined) ?? '';
      const toast = [...t.toasts, ...t.snaps.map((s) => s.snap.toast)].filter(Boolean).join(' | ');
      t.check('Delete is blocked or archived, with a clear reason', /order|archiv|deactivat|cannot|can.?t|history/i.test(`${dialog} ${toast}`), `dialog: "${dialog.slice(0, 140)}"; message: "${toast}"`,
        'Surface why the product cannot be deleted (it is in orders) in the dialog.');
    },
  },
  {
    name: 'old orders show product',
    pattern: /^old orders should still show the product correctly$/i,
    check: async (t) => {
      const p = t.orderedProduct;
      if (!p) return t.skip('Old orders still show the product', 'No ordered product was used.');
      const order = t.orderedSample;
      if (!order) return t.skip('Old orders still show the product', 'Could not read an order for this product before the test.');
      const data = await t.api.request('GET', `/sales/orders/${order.order_id}`);
      const ok = JSON.stringify(data).includes(p.name);
      t.check('Old orders still show the product', ok, `order ${order.reference} ${ok ? 'still lists' : 'no longer lists'} '${p.name}'`);
    },
  },
  {
    name: 'print preview',
    pattern: /^a print preview with the correct product name, price and barcode should open$|^for a product with no barcode, the sku should be used/i,
    check: async (t, m, claim) => {
      const noBarcode = /no barcode/i.test(claim);
      const p = t.fixtures.find((f) => (noBarcode ? !f.barcode : !!f.barcode)) ?? t.fixtures[0];
      const s = t.snaps.filter((x) => /barcode/i.test(x.snap.path) && x.snap.raw.includes(p?.name ?? '§')).at(-1)?.snap;
      if (!p || !s) return t.check(claim, false, 'print preview did not open');
      const code = p.barcode ?? p.sku;
      const price = `৳${Number(p.price).toFixed(2)}`;
      t.check(`Print preview ${noBarcode ? 'without barcode uses the SKU' : 'shows name, price and barcode'}`, s.raw.includes(p.name) && s.raw.includes(price) && s.raw.includes(code) && s.graphics > 0,
        `name ${s.raw.includes(p.name) ? '✓' : '✗'}, price ${s.raw.includes(price) ? '✓' : '✗'}, code '${code}' ${s.raw.includes(code) ? '✓' : '✗'}, barcode graphic ${s.graphics > 0 ? '✓' : '✗'}`);
    },
  },

  // ── Selection & bulk ─────────────────────────────────────────────────
  {
    name: 'bulk bar contents',
    pattern: /^after ticking one product, a bar should show '(\d+) selected' with:? (.+)$/i,
    check: async (t, m) => {
      const s = shotAfter(t, /tick/i).at(-1)?.snap ?? last(t);
      const want = listItems(m[2].replace(/ \/ /g, '§')).map((x) => x.replace(/§/g, ' / '));
      const missing = want.filter((b) => !s.bulkButtons.includes(b));
      t.check(`Bar shows '${m[1]} selected'`, s.selected === Number(m[1]), `${s.selected ?? 0} selected`);
      t.check(`Bar has ${want.join(', ')}`, !missing.length, missing.length ? `missing: ${list(missing)}` : 'all present');
    },
  },
  {
    name: 'select page count',
    pattern: /^'select this page' should show '(\d+) selected'$/i,
    check: async (t, m) => {
      const s = shotAfter(t, /select this page/i).at(-1)?.snap;
      t.check(`'Select this page' shows '${m[1]} selected'`, s?.selected === Number(m[1]), `${s?.selected ?? 0} selected`);
    },
  },
  {
    name: 'clear selection',
    pattern: /^'clear selection' should untick all and hide the bar$/i,
    check: async (t) => {
      const s = shotAfter(t, /clear selection/i).at(-1)?.snap;
      t.check("'Clear selection' unticks all and hides the bar", !!s && s.checked === 0 && !s.bulkButtons.length, `${s?.checked ?? '?'} ticked, bar ${s?.bulkButtons.length ? 'visible' : 'hidden'}`);
    },
  },
  {
    name: 'inactive then active',
    pattern: /^all (\d+) products should become inactive, then active again$/i,
    check: async (t, m) => {
      const off = shotAfter(t, /deactivate/i).at(-1)?.snap;
      const on = shotAfter(t, /'activate'/i).at(-1)?.snap;
      const names = t.selection;
      const stateIn = (s: Snap | undefined) => names.map((n) => s?.rows.find((r) => r.name === n)?.active);
      t.check(`All ${m[1]} become inactive`, stateIn(off).every((a) => a === false), stateIn(off).map((a) => (a ? 'active' : a === false ? 'inactive' : '?')).join(', '));
      t.check(`All ${m[1]} become active again`, stateIn(on).every((a) => a === true), stateIn(on).map((a) => (a ? 'active' : a === false ? 'inactive' : '?')).join(', '));
    },
  },
  {
    name: 'active card changes by',
    pattern: /^the active card should change by (\d+) each time$/i,
    check: async (t, m) => {
      const n = Number(m[1]);
      const before = card(first(t), 'Active')?.value ?? 0;
      const off = card(shotAfter(t, /deactivate/i).at(-1)?.snap, 'Active')?.value;
      const on = card(shotAfter(t, /'activate'/i).at(-1)?.snap, 'Active')?.value;
      t.check(`Active card changes by ${n} each time`, off === before - n && on === before, `${before} → ${off} → ${on}`, 'The Active card is not refreshed after a bulk action.');
    },
  },
  {
    name: 'moved to category',
    pattern: /^all (\d+) should move to the '(.+)' category$/i,
    check: async (t, m) => {
      const category = await (await import('./fixtures.js')).resolveCategory(t, m[2]);
      const products = await Promise.all(t.fixtures.slice(0, Number(m[1])).map((f) => t.api.getProduct(f.id)));
      t.check(`All ${m[1]} move to '${category}'`, products.every((p) => p.category?.name === category), products.map((p) => p.category?.name ?? '—').join(', '));
    },
  },
  {
    name: 'other details unchanged',
    pattern: /^their other details should not change$/i,
    check: async (t) => {
      const now = await Promise.all(t.fixtures.map((f) => t.api.getProduct(f.id)));
      const same = now.every((p, i) => p.name === t.fixtures[i].name && p.sku === t.fixtures[i].sku && Number(p.price) === Number(t.fixtures[i].price));
      t.check('Other details do not change', same, same ? 'name, SKU, price unchanged' : 'details changed');
    },
  },
  {
    name: 'skus pasted',
    pattern: /^the (\d+) skus should be (?:pasted|copied) correctly$/i,
    check: async (t, m) => {
      const skus = t.fixtures.slice(0, Number(m[1])).map((f) => f.sku);
      const missing = skus.filter((s) => !t.clipboard.includes(s));
      t.check(`The ${m[1]} SKUs are copied correctly`, !missing.length, `clipboard: ${JSON.stringify(t.clipboard.slice(0, 120))}`);
    },
  },
  {
    name: 'export contains selected',
    pattern: /^the export file should contain exactly the (\d+) selected products$/i,
    check: async (t, m) => {
      if (!t.lastDownload) return t.check('Export downloads a file', false, 'no file downloaded');
      const rows = csvRows(t.lastDownload);
      const text = rows.map((r) => Object.values(r).join(' '));
      const names = ((t.noted.get('__exportSelection') as string[] | undefined) ?? t.selection).slice(0, Number(m[1]));
      const missing = names.filter((n) => !text.some((x) => x.includes(n)));
      t.check(`Export contains exactly the ${m[1]} selected products`, rows.length === names.length && !missing.length,
        `${rows.length} rows in the file${missing.length ? `; missing: ${list(missing)}` : ''}`);
    },
  },
  {
    name: 'bangla readable',
    pattern: /^bangla (?:names|text) should be readable$/i,
    check: async (t) => {
      if (!t.lastDownload) return t.skip('Bangla text is readable', 'No file was downloaded.');
      const text = fs.readFileSync(t.lastDownload, 'utf8');
      const bangla = /[ঀ-৿]/.test(text);
      const bom = hasBom(t.lastDownload);
      const expectBangla = t.fixtures.some((f) => /[\u0980-\u09FF]/.test(f.name)) && t.selection.some((n) => /[\u0980-\u09FF]/.test(n));
      if (!bangla && !expectBangla) {
        t.check('File is UTF-8 with a BOM (so Excel reads Bangla correctly)', bom, bom ? 'BOM present; this file has no Bangla names to check' : 'no UTF-8 BOM');
        return;
      }
      t.check('Bangla text is readable in the file (UTF-8 with BOM for Excel)', bom && bangla,
        `${bangla ? 'Bangla text intact' : 'no Bangla text in the file'}, ${bom ? 'BOM present' : 'no UTF-8 BOM — Excel will show Bangla as garbled text'}`,
        'Start CSV exports with a UTF-8 BOM so Excel reads Bangla correctly.');
    },
  },
  {
    name: 'confirmation says N products',
    pattern: /^the confirmation should say '(.+)'$/i,
    check: async (t, m) => {
      const text = (t.noted.get('__confirmText') as string | undefined) ?? '';
      t.check(`Confirmation says '${m[1]}'`, lc(text).includes(lc(m[1])), text || 'no confirmation', "Use the item name and a proper plural ('2 products', not '2 item(s)').");
    },
  },
  {
    name: 'ordered product kept',
    pattern: /^the product with orders should be kept$/i,
    check: async (t) => {
      const p = t.orderedProduct;
      if (!p) return t.skip('The product with orders is kept', 'No ordered product was used.');
      const kept = (await t.findProduct(p.name)) ?? (await t.findProduct(p.name, 'status=archived'));
      t.check('The product with orders is kept', !!kept, kept ? (kept.is_active ? 'still active' : 'kept, deactivated/archived') : 'gone');
    },
  },
  {
    name: 'message says which and why',
    pattern: /^a message should clearly say which product could not be deleted and why$/i,
    check: async (t) => {
      const toast = [...t.toasts, ...t.snaps.map((s) => s.snap.toast)].filter(Boolean).join(' | ');
      const dialog = (t.noted.get('__confirmText') as string | undefined) ?? '';
      const name = t.orderedProduct?.name ?? '§';
      t.check('Message says which product could not be deleted and why', toast.includes(name) || /order/i.test(toast), `dialog: "${dialog.slice(0, 100)}"; message: "${toast}"`,
        'The bulk delete reports success for all items; return which ones were kept and why, and show it.');
    },
  },
  {
    name: 'file matches screen',
    pattern: /^the file should download and contain the same products shown on screen, with the same columns$/i,
    check: async (t) => {
      if (!t.lastDownload) return t.check('The file downloads', false, 'no file downloaded');
      const rows = csvRows(t.lastDownload);
      const shot = t.snaps.filter((s) => s.snap.rows.length && !/export|download/i.test(s.after)).at(-1)?.snap;
      const onScreen = shot?.rows ?? [];
      const text = rows.map((r) => Object.values(r).join(' '));
      const missing = onScreen.filter((r) => !text.some((x) => x.includes(r.name))).map((r) => r.name);
      t.check('File has the same products as the screen', rows.length === onScreen.length && !missing.length, `${rows.length} in file, ${onScreen.length} on screen${missing.length ? `; missing: ${list(missing)}` : ''}`);
      const headers = Object.keys(rows[0] ?? {}).map((h) => h.toUpperCase());
      const missingCols = (shot?.columns ?? []).filter((c) => !['SL', 'ACTIONS', ''].includes(c) && !headers.some((h) => h.includes(c)));
      t.check('File has the same columns', !missingCols.length, missingCols.length ? `missing: ${list(missingCols)}` : 'all columns present');
    },
  },
  {
    name: 'numbers in file',
    pattern: /^prices and stock should be numbers$/i,
    check: async (t) => {
      if (!t.lastDownload) return t.skip('Prices and stock are numbers', 'No file was downloaded.');
      const rows = csvRows(t.lastDownload);
      const priceKey = Object.keys(rows[0] ?? {}).find((k) => /price/i.test(k));
      const stockKey = Object.keys(rows[0] ?? {}).find((k) => /stock/i.test(k));
      const bad = rows.filter((r) => (priceKey && !/^-?[\d.]+$/.test(r[priceKey].trim())) || (stockKey && !/^-?[\d.]+$/.test(r[stockKey].trim())));
      t.check('Prices and stock are numbers', !!priceKey && !!stockKey && !bad.length, bad.length ? `e.g. "${bad[0][priceKey!]}", "${bad[0][stockKey!]}"` : `columns '${priceKey}', '${stockKey}'`,
        "Export the raw numbers ('1400', '16'), not display text ('৳1,400.00', '16 pcs').");
    },
  },

  // ── Needs a second account / known limits ────────────────────────────
  {
    name: 'staff without permission',
    pattern: /^a staff user without permission/i,
    check: async (t, m, claim) => t.skip(claim, 'Needs a staff account without Products permission. Add it in project settings to check this.'),
  },
  {
    name: 'no product data for staff',
    pattern: /^no product data should be shown$/i,
    check: async (t, m, claim) => t.skip(claim, 'Needs a staff account without Products permission.'),
  },
];

/** Exposed for the preview: does any rule understand this claim? */
export function matchExpect(claim: string): ExpectRule | undefined {
  return EXPECT_RULES.find((r) => r.pattern.test(claim.trim()));
}

export { words };
