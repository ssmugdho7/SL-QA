import fs from 'fs';
import { fileURLToPath } from 'url';
import type { PageInfo, SiteMap } from './apps/slshop/crawl.js';

/** Dashboard pages by the names people use for them (sidebar labels and common synonyms). These win over the site map. */
export const PAGES: Record<string, string> = {
  'dashboard': '/dashboard',
  'home': '/dashboard',
  'create order/pos': '/dashboard/pos',
  'create order': '/dashboard/pos',
  'pos': '/dashboard/pos',
  'point of sale': '/dashboard/pos',
  'sell now': '/dashboard/pos',
  'orders': '/dashboard/orders',
  'order list': '/dashboard/orders',
  'products': '/dashboard/products',
  'product list': '/dashboard/products',
  'customers': '/dashboard/customers',
  'accounts': '/dashboard/accounting/cashbook',
  'cashbook': '/dashboard/accounting/cashbook',
  'stock': '/dashboard/inventory',
  'inventory': '/dashboard/inventory',
  'coupons': '/dashboard/coupons',
  'shipping labels': '/dashboard/orders/shipping-labels',
  'shipping label': '/dashboard/orders/shipping-labels',
  'fraud detection': '/dashboard/fraud',
  'barcode/qr': '/dashboard/inventory/barcodes',
  'barcodes': '/dashboard/inventory/barcodes',
  'money with courier': '/dashboard/accounting/courier-cod',
  'dues book': '/dashboard/accounting/parties',
  'customer dues': '/dashboard/customers/due',
  'partners money': '/dashboard/investors',
  'layout': '/dashboard/storefront/customize',
  'custom pages': '/dashboard/storefront/pages',
  'blog': '/dashboard/storefront/blog',
  'store settings': '/dashboard/storefront/configuration',
  'addons': '/dashboard/addons',
  'printing settings': '/dashboard/settings/printing',
  'ads pixel': '/dashboard/settings/tracking',
  'integrations': '/dashboard/integrations',
  'developers': '/dashboard/developers',
  'activity log': '/dashboard/activity',
  'layout settings': '/dashboard/settings/layout',
  'download app': '/dashboard/download-app',
  'refer & earn': '/dashboard/refer',
};

/** Lower case, no apostrophes, "a / b" → "a/b", "A › B" / "A > B" → "a > b". */
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/\s*\/\s*/g, '/').replace(/\s*[›»>]\s*/g, ' > ').replace(/\s+/g, ' ').trim();

const SITE_MAP_FILE = fileURLToPath(new URL('./apps/slshop/site-map.json', import.meta.url));

/** All names → path: PAGES first, then every crawled page by sidebar label, "Group › Label", "Label under Group", breadcrumb and heading. */
let names: Record<string, string> = {};
let byPath = new Map<string, PageInfo>();

/** Re-reads site-map.json (after a crawl). PAGE_NAMES, used in step patterns, only changes on restart. */
export function reloadPages(): void {
  let map: SiteMap | null = null;
  try {
    map = JSON.parse(fs.readFileSync(SITE_MAP_FILE, 'utf8')) as SiteMap;
  } catch { /* no crawl yet: PAGES only */ }
  const out: Record<string, string> = { ...PAGES };
  const add = (name: string | undefined, path: string) => {
    const n = name ? norm(name) : '';
    // Names must read like a page name: some letters, not a sentence.
    if (n.length > 1 && n.length <= 60 && /\p{L}/u.test(n) && !(n in out)) out[n] = path;
  };
  byPath = new Map();
  const pages = (map?.pages ?? []).filter((p) => !p.redirectsTo);
  for (const p of pages) byPath.set(p.path, p);
  // Sidebar labels and group forms first (they are what people read), then breadcrumbs and headings.
  for (const p of pages) {
    const groups = p.group ? p.group.split(' › ') : [];
    const parent = groups.at(-1);
    add(p.label, p.path);
    if (parent) {
      add(`${parent} > ${p.label}`, p.path);
      add(`${p.group} > ${p.label}`, p.path);
      add(`${p.label} under ${parent}`, p.path);
      add(`${p.label} in ${parent}`, p.path);
      add(`${parent} ${p.label}`, p.path);
    }
    if (p.section) add(`${p.section} > ${p.label}`, p.path);
  }
  for (const p of pages) {
    if (p.breadcrumb) {
      add(p.breadcrumb, p.path);
      add(p.breadcrumb.replace(/^home › /i, ''), p.path);
    }
    add(p.title, p.path);
  }
  names = out;
}
reloadPages();

/** Every page name known (PAGES and the site map), for prompts and pickers. */
export const pageNames = (): Record<string, string> => names;

/** "Create order/ POS" → /dashboard/pos; also tries each "/"-separated part ("Create order", "POS"), and "Products > Categories". */
export function pagePath(name: string): string | null {
  const n = norm(name).replace(/^the /, '').replace(/ (?:page|screen|section|tab)$/, '').replace(/^dashboard > (?=.)/, '');
  if (names[n]) return names[n];
  for (const part of n.split('/')) if (names[part.trim()]) return names[part.trim()];
  return null;
}

/** The crawled page for a path or URL ("/dashboard/categories", "https://…/dashboard/reports/view?slug=cash-flow&from=…"), or null. */
export function pageInfo(pathOrUrl: string): PageInfo | null {
  let u: URL;
  try {
    u = new URL(pathOrUrl, 'http://x');
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, '') || '/';
  // Only the query keys that pick a page (?slug=, ?stage=, ?tab=) are part of its identity.
  const keep = [...u.searchParams].filter(([k]) => ['slug', 'stage', 'tab', 'section'].includes(k));
  return byPath.get(path + (keep.length ? `?${new URLSearchParams(keep)}` : '')) ?? byPath.get(path) ?? null;
}

export const knownPage = (pathOrUrl: string): boolean => pageInfo(pathOrUrl) !== null;

/** Crawled pages, in sidebar order, for pickers (path, "Group › Label"). */
export const knownPages = (): PageInfo[] => [...byPath.values()];

/**
 * Regex source matching any known page name, for step patterns. Longest first so "Products > Categories" wins over "Products".
 * Every name is escaped; spaces, "/" and "›"/">" separators match loosely. Alternatives are plain text, so matching stays linear.
 */
export const PAGE_NAMES = Object.keys(names)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ > /g, '\u0000').replace(/\//g, '\\s*/\\s*').replace(/ /g, '\\s+').replace(/\u0000/g, '\\s*[>›»]\\s*'))
  .join('|');
