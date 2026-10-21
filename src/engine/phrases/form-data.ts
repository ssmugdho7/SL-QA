import { formLabel } from '../apps/slshop/product-form.js';

/**
 * Test Data → values per form field.
 * "Name: 'Test Soap'\nSelling Price: 120" · "Name 'Full Test Shampoo', Category 'Hair Care', Price 500, Cost 350"
 * · "Selling 100, Cost 150" · "Min 10, Max 50, Price 90" · "Unit: kg".
 */
const KEY_WORDS: Record<string, string> = {
  selling: 'Selling Price',
  price: 'Selling Price',
  name: 'Product Name',
  'new name': 'Product Name',
  cost: 'Cost Price',
  stock: 'Opening Stock',
  'opening stock': 'Opening Stock',
  warning: 'Low Stock Threshold',
  discount: 'Discount Price',
  min: 'Min Qty',
  'min qty': 'Min Qty',
  max: 'Max Qty',
  'max qty': 'Max Qty',
  fee: 'Extra Shipping Fee',
  weight: 'Weight (Kg)',
  tax: 'Tax Rate',
  slug: 'slug',
};

export function formValues(testData: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!testData || testData.trim() === '-') return out;
  for (const piece of testData.split(/\n|;|,(?![^']*'(?:[^']*'[^']*')*[^']*$)/)) {
    const m = piece.trim().match(/^([A-Za-z][A-Za-z /&-]*?)\s*(?::|=)?\s*'([^']*)'\s*$|^([A-Za-z][A-Za-z /&-]*?)\s*(?::|=)\s*(.+)$|^([A-Za-z][A-Za-z /&-]*?)\s+(-?৳?\d[\d,.]*%?)\s*$/);
    if (!m) continue;
    const key = (m[1] ?? m[3] ?? m[5]).trim();
    const value = (m[2] ?? m[4] ?? m[6]).trim().replace(/^'(.*)'$/, '$1').replace(/^৳/, '');
    const k = key.toLowerCase();
    // "Weight 50g: ৳70, stock 10" describes a variation, not the Weight (Kg) field.
    if (/^weight$/.test(k) && /[a-z]/i.test(value) && !/^-?\d/.test(value)) continue;
    const label = KEY_WORDS[k] ?? formLabel(key);
    if (!(label in out)) out[label] = value;
  }
  return out;
}

/** Quoted or bare values listed in Test Data, in order ("'my soap!!'; existing slug" → ["my soap!!"]). */
export function quotedValues(testData: string): string[] {
  return [...testData.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

/** "Negative: -10\nText: abc\nWrong format: 12..5\nDecimal stock for 'pcs': 2.5" → ["-10", "abc", "12..5", "2.5"]. */
export function invalidValues(testData: string): string[] {
  const out: string[] = [];
  for (const line of testData.split(/\n|;/)) {
    const v = line.split(':').slice(1).join(':').trim();
    if (v) out.push(v.replace(/^'(.*)'$/, '$1'));
  }
  return out;
}

/** Sensible values for required fields when the sheet gives none. */
export const DEFAULTS: Record<string, string> = {
  'Product Name': 'Item',
  'Selling Price': '100',
  'Cost Price': '60',
  'Discount Price': '90',
  'Opening Stock': '10',
  'Low Stock Threshold': '5',
};
