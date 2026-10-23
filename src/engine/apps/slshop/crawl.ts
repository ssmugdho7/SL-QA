import fs from 'fs';
import { fileURLToPath } from 'url';
import type { BrowserContext, Page } from 'playwright';
import { config } from '../../config.js';
import type { Session } from '../../session.js';
import type { TestCase } from '../../sources/cases.js';

/**
 * Site crawler: walks the logged-in dashboard (sidebar, in-page section links, settings sub-pages) and records what
 * each page offers — UI labels only, never row data — into site-map.json. pages.ts reads it to resolve page names,
 * and siteCases() turns it into read-only QA cases ("check the whole dashboard").
 *
 * Read-only: it only opens pages, expands sidebar groups and opens/closes the Filter panel. It never clicks anything else.
 */

export type PageKind = 'list' | 'form' | 'detail' | 'settings' | 'report' | 'other';

export interface PageInfo {
  /** Path plus the query keys that pick a page (slug, stage…): /dashboard/reports/view?slug=sales-trends. */
  path: string;
  /** Main heading (h1), else the breadcrumb end or sidebar label. */
  title: string;
  /** Sidebar label ("Categories"), or the title for pages found inside other pages. */
  label: string;
  /** Sidebar group chain ("Products", "Reports › Sales"); empty for top-level links. */
  group: string;
  /** Sidebar section heading ("Stock", "Money"). */
  section?: string;
  breadcrumb?: string;
  headings: string[];
  /** In-page tabs that do not change the URL (role=tab, status tabs). */
  tabs: string[];
  /** Sub-page links of the page's own section menu ("Order Links", "Exchanges"). */
  sections?: string[];
  buttons: string[];
  fields: string[];
  columns: string[];
  /** Headings inside the Filter panel ("Stock", "Category"). */
  filters: string[];
  /** Placeholder of the page's search box. */
  search?: string;
  /** Name of the button that opens the filter panel. */
  filterButton?: string;
  list: boolean;
  /** "Next page" was enabled when crawled. */
  pager?: boolean;
  kind: PageKind;
  /** 0 = /dashboard, 1 = sidebar or linked from it, 2 = one click further. */
  depth: number;
  /** Where the page sent the browser instead (an addon that is off, a moved page). */
  redirectsTo?: string;
}

export interface SiteMap { generatedAt: string; tookMs: number; pages: PageInfo[] }

export const SITE_MAP_FILE = fileURLToPath(new URL('./site-map.json', import.meta.url));

export function loadSiteMap(): SiteMap | null {
  try {
    return JSON.parse(fs.readFileSync(SITE_MAP_FILE, 'utf8')) as SiteMap;
  } catch {
    return null;
  }
}

export function saveSiteMap(map: SiteMap): void {
  fs.writeFileSync(`${SITE_MAP_FILE}.tmp`, `${JSON.stringify(map, null, 1)}\n`);
  fs.renameSync(`${SITE_MAP_FILE}.tmp`, SITE_MAP_FILE);
}

/** Days since the map was made (Infinity when there is none). */
export const siteMapAge = (map: SiteMap | null) => (map ? (Date.now() - Date.parse(map.generatedAt)) / 86_400_000 : Infinity);

// Paths never opened while crawling, and names never clicked by generated cases.
const DESTRUCTIVE_PATH = /log-?out|sign-?out|delete|destroy|remove|archive|cancel|refund|withdraw|recharge|checkout|\/pay\b|reset|disconnect|uninstall/i;
const DESTRUCTIVE_NAME = /^(?:delete|remove|archive|cancel|refund|log ?out|sign ?out|save|submit|send|pay|recharge|withdraw|import|generate|write with ai|place order|bulk|clear|reset|disconnect|confirm|publish|install|uninstall|duplicate|create|add|new)\b/i;
// Query keys that select a different page rather than a filtered view of the same one.
const PAGE_QUERY = new Set(['slug', 'stage', 'tab', 'section']);

/** A same-site dashboard link as a crawlable path, or null (other sites, record pages, filtered views, destructive). */
export function crawlPath(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, config.baseUrl);
  } catch {
    return null;
  }
  if (u.origin !== new URL(config.baseUrl).origin || !/^\/dashboard(?:\/|$)/.test(u.pathname)) return null;
  if (DESTRUCTIVE_PATH.test(u.pathname) || /\/\d+(?:\/|$)|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(u.pathname) || u.searchParams.has('id')) return null;
  const keep = [...u.searchParams].filter(([k]) => PAGE_QUERY.has(k));
  return u.pathname.replace(/\/+$/, '') + (keep.length ? `?${new URLSearchParams(keep)}` : '');
}

/** A UI label with counts removed, or '' when it looks like data (long numbers, money, emails, store or customer names). */
function redact(s: string, secrets: RegExp | null): string {
  // Trailing counts go ("Pending 20", "Delivery 99+"); leading small numbers are part of the label ("7 days", "30 days").
  const t = s.replace(/\s+/g, ' ').trim().replace(/(?:\s+[([]?[\d.,+%:/]+[)\]]?)+$/, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim().replace(/[\s:·•|-]+$/, '');
  if (!t || t.length > 60 || !/\p{L}/u.test(t)) return '';
  if (/@|৳|\$|€|£|https?:|www\.|\.(?:com|bd|net|org)\b|\d{4,}|\d[\d,.]*\d{3}|\+\d/.test(t)) return '';
  if (secrets?.test(t)) return '';
  return t;
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Names that belong to this store (owner, store, products, categories, brands, labels): never written to the map. */
async function secretWords(session: Session): Promise<RegExp | null> {
  const words: string[] = [];
  const me = await session.api.request<{ user?: Record<string, unknown>; store?: Record<string, unknown> }>('GET', '/auth/me').catch(() => ({} as { user?: Record<string, unknown>; store?: Record<string, unknown> }));
  for (const v of [me.user?.name, me.user?.first_name, me.user?.last_name, me.store?.name, me.store?.slug]) if (typeof v === 'string') words.push(v);
  const named = (xs: { name: string }[]) => xs.map((x) => x.name);
  words.push(...named(await session.api.allProducts().catch(() => [])));
  words.push(...named(await session.api.categories().catch(() => [])));
  words.push(...named(await session.api.brands().catch(() => [])));
  words.push(...named(await session.api.labels().catch(() => [])));
  // Customers can show up in cards and headings outside tables (reviews, fraud reports).
  for (let page = 1; page <= 5; page++) {
    const r = await session.api.request<{ data?: { name?: string }[] }>('GET', `/customers?per_page=100&page=${page}`).catch(() => ({ data: [] as { name?: string }[] }));
    words.push(...(r.data ?? []).map((c) => c.name ?? ''));
    if ((r.data ?? []).length < 100) break;
  }
  const list = uniq(words.map((w) => w.trim()).filter((w) => w.length >= 3)).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
}

interface SidebarLink { href: string; label: string; groups: string[]; section: string }

/** Opens every collapsed sidebar group, then lists its links with their group chain and section. */
async function readSidebar(page: Page): Promise<SidebarLink[]> {
  const nav = page.locator('aside nav').first();
  for (let round = 0; round < 5; round++) {
    const closed = nav.locator('button[aria-expanded=false]:not([aria-haspopup])');
    const n = await closed.count();
    if (!n) break;
    for (let i = 0; i < n; i++) await closed.nth(0).click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  return nav.evaluate((root) => {
    const out: { href: string; label: string; groups: string[]; section: string }[] = [];
    const first = (s: string) => s.split('\n').map((x) => x.trim()).find((x) => /\p{L}/u.test(x)) ?? '';
    const walk = (el: Element, groups: string[], section: string): string => {
      let cur = groups;
      let sec = section;
      for (const c of el.children) {
        const text = (c as HTMLElement).innerText ?? '';
        if (c.tagName === 'A') out.push({ href: c.getAttribute('href') ?? '', label: first(text), groups: cur, section: sec });
        else if (c.tagName === 'BUTTON') { if (c.hasAttribute('aria-expanded')) cur = [...groups, first(text)]; }
        else if (/^(?:P|H\d)$/.test(c.tagName) && !c.querySelector('a,button')) { sec = first(text); cur = groups; }
        else sec = walk(c, cur, sec);
      }
      return sec;
    };
    walk(root, [], '');
    return out;
  }).catch(() => []);
}

interface Raw {
  title: string; h1: string; headings: string[]; tabs: string[]; sections: { label: string; href: string }[]; buttons: string[];
  fields: string[]; columns: string[]; search: string; filterButton: string; list: boolean; pager: boolean; links: string[]; breadcrumb: string[];
}

/** Reads the page's UI labels. Rows, cards, dialogs, the top bar and the sidebar are skipped: they hold data or repeat on every page. */
function extract(): Raw {
  const root = document.querySelector('main') ?? document.body;
  const SKIP = 'header:has([aria-label="Account menu"]), aside, tbody, article, [role=dialog], [role=alertdialog], [data-sonner-toaster], .summary-card, [role=row], [role=listbox], [role=menu], svg, .recharts-wrapper, canvas';
  const vis = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const ok = (e: Element) => vis(e) && !e.closest(SKIP);
  const first = (s: string | null | undefined) => (s ?? '').split('\n').map((x) => x.trim()).find((x) => /\p{L}/u.test(x)) ?? '';
  const name = (e: Element) => first((e as HTMLElement).innerText) || e.getAttribute('aria-label') || '';
  const all = (sel: string) => [...root.querySelectorAll(sel)].filter(ok);
  const tabs = [...all('[role=tab]'), ...all('[role=group][aria-label=Status] button')].map(name);
  const sectionNav = all('nav[aria-label$="sections" i] a');
  const buttons = all('button, [role=button], a[data-slot=button]')
    .filter((b) => !b.closest('nav, [role=group], [role=tablist], thead') && b.getAttribute('role') !== 'tab' && b.getAttribute('role') !== 'switch')
    .map(name);
  const labelOf = (i: Element) => {
    const el = i as HTMLInputElement;
    return first(el.labels?.[0]?.innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  };
  const inputs = all('input, textarea, select, [role=combobox]').filter((i) => !/^(?:hidden|checkbox|radio|file|submit|search)$/.test(i.getAttribute('type') ?? ''));
  const search = all('input[type=search], input[placeholder^="Search" i]').map((i) => i.getAttribute('placeholder') ?? '').find(Boolean) ?? '';
  const table = all('table').find((t) => t.querySelector('tbody tr')) ?? all('table')[0];
  const filter = all('button').find((b) => /^Filter/i.test(first((b as HTMLElement).innerText)));
  const next = document.querySelector('[aria-label="Next page"]') as HTMLButtonElement | null;
  const h1 = all('h1').map(name)[0] ?? '';
  return {
    title: document.title,
    h1,
    headings: all('h1, h2, h3').map(name),
    tabs,
    sections: sectionNav.map((a) => ({ label: name(a), href: a.getAttribute('href') ?? '' })),
    buttons,
    fields: [...inputs.map(labelOf), ...all('label').map(name)],
    columns: table ? [...table.querySelectorAll('thead th')].map((th) => first((th as HTMLElement).innerText)) : [],
    search,
    filterButton: filter ? first((filter as HTMLElement).innerText) : '',
    list: !!root.querySelector('tbody tr') || /Showing\s*\d+\s*[–-]\s*\d+\s*of\s*\d+/.test(root.textContent ?? '') || !!next,
    pager: !!next && !next.disabled,
    links: [...root.querySelectorAll('a[href]')].filter((a) => !a.closest('tbody, article, table, [role=dialog], header:has([aria-label="Account menu"])')).map((a) => a.getAttribute('href') ?? ''),
    breadcrumb: [...document.querySelectorAll('nav[aria-label=breadcrumb] li')].map(name),
  };
}

function guessKind(path: string, r: { list: boolean; fields: string[]; buttons: string[] }): PageKind {
  const p = path.split('?')[0];
  if (/\/(?:reports?|analytics)(?:\/|$)|^\/dashboard$|\/dashboard\/[\w-]+\/dashboard$|\/overview$/.test(p)) return 'report';
  if (/\/(?:settings|configuration|integrations|developers)(?:\/|$)/.test(p)) return 'settings';
  if (/\/(?:new|create|edit)$/.test(p) || (!r.list && r.fields.length >= 3 && r.buttons.some((b) => /^(?:save|create|add|submit|update)\b/i.test(b)))) return 'form';
  if (/\/detail(?:\/|$)/.test(p)) return 'detail';
  return r.list ? 'list' : 'other';
}

const sleep = (page: Page, ms: number) => page.waitForTimeout(ms);

/** Opens one page and records it. Returns the page and the links found on it. */
async function visit(page: Page, path: string, secrets: RegExp | null): Promise<{ raw: Raw | null; finalPath: string | null; filters: string[] }> {
  await page.goto(`${config.baseUrl}${path}`, { waitUntil: 'load', timeout: 45_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('main .animate-pulse, main [aria-busy=true]'), null, { timeout: 8_000 }).catch(() => undefined);
  await sleep(page, 400);
  // New stores open a "Set up your shop" wizard over every page.
  if (await page.getByRole('dialog').filter({ hasText: 'Set up your shop' }).isVisible().catch(() => false)) await page.keyboard.press('Escape');
  const finalPath = crawlPath(page.url());
  const raw = await page.evaluate(extract).catch(() => null);
  const filters: string[] = [];
  // The Filter panel only opens and closes: reading its section names is safe.
  if (raw?.filterButton) {
    const btn = page.locator('main button').filter({ hasText: /^\s*Filter/ }).filter({ visible: true }).first();
    if (await btn.click({ timeout: 4_000 }).then(() => true, () => false)) {
      await sleep(page, 600);
      const dlg = page.locator('[role=dialog]').filter({ visible: true }).last();
      const heads = await dlg.locator('h2, h3, h4, legend, label, [role=heading]').allInnerTexts().catch(() => [] as string[]);
      filters.push(...heads.map((h) => h.split('\n')[0]).map((h) => redact(h, secrets)).filter((h) => h && !/^filters?$/i.test(h)));
      await page.keyboard.press('Escape');
      await sleep(page, 200);
    }
  }
  return { raw, finalPath, filters };
}

interface Job { path: string; depth: number; label?: string; groups?: string[]; section?: string; order: number }

/**
 * Crawls the dashboard breadth-first: /dashboard, every sidebar link, then links inside those pages, to `depth`.
 * Stops at `maxPages` pages or after `maxMs`. Several tabs work at once; nothing on the store is changed.
 */
export async function discoverPages(session: Session, opts: { maxPages?: number; maxMs?: number; depth?: number; workers?: number; onPage?: (p: PageInfo, n: number) => void } = {}): Promise<SiteMap> {
  const started = Date.now();
  const { maxPages = 200, maxMs = 15 * 60_000, depth: maxDepth = 2, workers = 3 } = opts;
  const secrets = await secretWords(session);
  const context: BrowserContext = await session.newContext();
  const pages: (PageInfo & { order: number })[] = [];
  try {
    const first = await context.newPage();
    first.on('dialog', (d) => void d.dismiss().catch(() => undefined));
    await first.goto(`${config.baseUrl}/dashboard`, { waitUntil: 'load', timeout: 45_000 }).catch(() => undefined);
    await first.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    if (/\/login/.test(new URL(first.url()).pathname)) throw new Error('The dashboard sent the crawler to the login page; sign in again (delete .auth/state.json).');
    const sidebar = await readSidebar(first);

    let order = 0;
    const queue: Job[] = [{ path: '/dashboard', depth: 0, label: 'Dashboard', order: order++ }];
    const queued = new Map<string, Job>([['/dashboard', queue[0]]]);
    for (const l of sidebar) {
      const path = crawlPath(l.href);
      if (!path) continue;
      const known = queued.get(path);
      const label = redact(l.label, secrets);
      // The same link can sit in "Quick access" and in its group: keep the first label, but the group it belongs to.
      if (known) {
        if (!known.groups?.length && l.groups.length) Object.assign(known, { groups: l.groups, section: l.section });
        continue;
      }
      const job = { path, depth: 1, label, groups: l.groups, section: l.section, order: order++ };
      queued.set(path, job);
      queue.push(job);
    }
    const seenFinal = new Set<string>();

    const worker = async (page: Page) => {
      page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
      for (;;) {
        if (pages.length + busy >= maxPages || Date.now() - started > maxMs) return;
        const job = queue.shift();
        if (!job) {
          // Other tabs may still add links; wait for them briefly.
          if (busy === 0) return;
          await sleep(page, 300);
          continue;
        }
        busy++;
        try {
          const { raw, finalPath, filters } = await visit(page, job.path, secrets);
          if (!raw) continue;
          const groups = (job.groups ?? []).map((g) => redact(g, secrets)).filter(Boolean);
          // Chart cells ("Mon 3pm: orders") are data points, not controls; long lists are cut to what a person scans.
          const clean = (xs: string[]) => uniq(xs.map((x) => redact(x, secrets))).filter((x) => !/\b\d{1,2}\s?(?:am|pm)\b|^(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d/i.test(x)).slice(0, 40);
          const fields = clean(raw.fields);
          const buttons = clean(raw.buttons).filter((b) => !/^(?:grid|list|columns|previous page|next page|first page|last page)$/i.test(b));
          const breadcrumb = uniq(raw.breadcrumb.map((x) => redact(x, secrets)));
          const h1 = redact(raw.h1, secrets);
          const tab = new URL(job.path, config.baseUrl).searchParams.get('tab');
          const named = job.label || h1 || breadcrumb.at(-1) || job.path.split(/[/?=]/).filter(Boolean).at(-1)!.replace(/[-_]/g, ' ');
          // Pages found inside others (?tab=queue, ?tab=settings) share the parent's heading: add the tab to tell them apart.
          const label = !job.label && tab ? `${named} › ${tab.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())}` : named;
          const list = raw.list;
          const info: PageInfo & { order: number } = {
            order: job.order,
            path: job.path,
            title: h1 || breadcrumb.at(-1) || label,
            label,
            group: groups.join(' › '),
            ...(job.section ? { section: redact(job.section, secrets) } : {}),
            ...(breadcrumb.length > 1 ? { breadcrumb: breadcrumb.join(' › ') } : {}),
            headings: clean(raw.headings),
            tabs: clean(raw.tabs),
            ...(raw.sections.length ? { sections: clean(raw.sections.map((s) => s.label)) } : {}),
            buttons,
            fields,
            columns: clean(raw.columns),
            filters: uniq(filters),
            ...(raw.search && redact(raw.search, secrets) ? { search: redact(raw.search, secrets) } : {}),
            ...(raw.filterButton && redact(raw.filterButton, secrets) ? { filterButton: redact(raw.filterButton, secrets) } : {}),
            list,
            ...(list ? { pager: raw.pager } : {}),
            kind: guessKind(job.path, { list, fields, buttons }),
            depth: job.depth,
            ...(finalPath && finalPath !== job.path ? { redirectsTo: finalPath } : {}),
          };
          // A page that only redirects to one already recorded adds nothing new.
          if (info.redirectsTo && seenFinal.has(info.redirectsTo)) continue;
          seenFinal.add(finalPath ?? job.path);
          pages.push(info);
          opts.onPage?.(info, pages.length);
          if (job.depth >= maxDepth) continue;
          for (const href of [...raw.sections.map((s) => s.href), ...raw.links]) {
            const path = crawlPath(href);
            if (!path || queued.has(path)) continue;
            // Found inside another page: it belongs to the sidebar group of the closest parent path (/purchase-orders/new → Purchase Orders).
            const owner = [...queued.values()].filter((j) => j.depth === 1 && j.groups && path.split('?')[0].startsWith(`${j.path.split('?')[0]}/`)).sort((a, b) => b.path.length - a.path.length)[0] ?? job;
            const next = { path, depth: job.depth + 1, groups: owner.groups, section: owner.section, order: order++ };
            queued.set(path, next);
            queue.push(next);
          }
        } finally {
          busy--;
        }
      }
    };
    let busy = 0;
    const tabs = [first, ...(await Promise.all(Array.from({ length: Math.max(0, workers - 1) }, () => context.newPage())))];
    await Promise.all(tabs.map(worker));
  } finally {
    await context.close().catch(() => undefined);
  }
  pages.sort((a, b) => a.order - b.order);
  return { generatedAt: new Date().toISOString(), tookMs: Date.now() - started, pages: pages.map(({ order: _, ...p }) => p) };
}

// ── Site QA: one read-only case per crawled page ────────────────────────

const quotable = (s: string) => !!s && !/['‘’]/.test(s);

/**
 * One read-only test case per page: it loads without errors or NaN/undefined, shows its heading, each main tab opens,
 * the Filter panel opens and closes, the search box takes text, and the next page of a list opens.
 * Only safe interactions: nothing is created, saved or deleted.
 */
export function siteCases(map: SiteMap, opts: { limit?: number; ids?: string[]; kinds?: PageKind[] } = {}): TestCase[] {
  const pages = map.pages.filter((p) => !p.redirectsTo && (!opts.kinds || opts.kinds.includes(p.kind)));
  let cases = pages.map((p, i): TestCase => {
    const steps: string[] = [];
    if (p.list && p.pager) steps.push(`CLICK 'Next page'`);
    for (const tab of p.tabs.filter((x) => quotable(x) && !DESTRUCTIVE_NAME.test(x)).slice(0, 4)) steps.push(`CLICK '${tab}'`);
    if (p.filterButton) steps.push(`CLICK '${p.filterButton}'`, `PRESS 'Escape'`);
    // After tab clicks the list is still re-fetching; typing into it then can lose a keystroke ("tes").
    if (p.search && quotable(p.search)) steps.push(...(steps.length ? ['WAIT 1'] : []), `TYPE 'test' INTO '${p.search}'`);
    const heading = p.headings.find((h) => h === p.title) ?? p.headings[0];
    const expected = [
      'The page should load without errors.',
      'The page should not show NaN or undefined values.',
      ...(heading && quotable(heading) ? [`EXPECT TEXT '${heading}'`] : []),
      ...(p.search && quotable(p.search) ? [`EXPECT FIELD '${p.search}' = 'test'`] : []),
    ];
    return {
      id: `SITE-${String(i + 1).padStart(3, '0')}`,
      scenario: p.group || p.section || 'Other pages',
      title: `${p.label} page`,
      type: 'Site check',
      priority: '',
      preconditions: '',
      steps,
      testData: '',
      expected,
      automation: '',
      url: p.path,
    };
  });
  if (opts.ids?.length) cases = cases.filter((c) => opts.ids!.includes(c.id));
  // A sample spread over the whole map (different groups and kinds), not the first N.
  if (opts.limit && opts.limit < cases.length) {
    const n = opts.limit;
    cases = Array.from({ length: n }, (_, i) => cases[Math.floor((i * cases.length) / n)]);
  }
  return cases;
}
