/** Dashboard pages by the names people use for them (sidebar labels and common synonyms). */
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

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();

/** "Create order/ POS" → /dashboard/pos; also tries each "/"-separated part ("Create order", "POS"). */
export function pagePath(name: string): string | null {
  const n = norm(name).replace(/^the /, '').replace(/ (?:page|screen|section|tab)$/, '');
  if (PAGES[n]) return PAGES[n];
  for (const part of n.split('/')) if (PAGES[part.trim()]) return PAGES[part.trim()];
  return null;
}

/** Regex source matching any known page name, for step patterns. */
export const PAGE_NAMES = Object.keys(PAGES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\s*/\\s*').replace(/ /g, '\\s+'))
  .join('|');
