import { config } from './config.js';

export interface Product {
  id: number;
  name: string;
  slug: string;
  product_type: 'simple' | 'variable';
  sku: string;
  barcode: string | null;
  price: string;
  stock: number;
  low_stock_threshold: number;
  track_inventory: boolean;
  is_active: boolean;
  is_low_stock: boolean;
  is_out_of_stock: boolean;
  total_sold: number;
  category: { id: number; name: string } | null;
  brand: { id: number; name: string } | null;
  variants: { id: number; name: string; sku: string; price: string; stock: number }[];
}

export interface Kpis { total: number; active: number; low_stock: number; out_of_stock: number }
export interface StatusCounts { all: number; active: number; draft: number; archived: number }

/** Thin client for the app's own REST API. Used to build and clean up test data and to cross-check what the UI shows. */
export class Api {
  constructor(private token: string, public storeId: number) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(config.apiUrl + path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Store-Id': String(this.storeId),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : (undefined as T);
  }

  async listProducts(query = ''): Promise<{ data: Product[]; meta: { total: number; kpis: Kpis; status_counts: StatusCounts } }> {
    return this.request('GET', `/catalog/products?per_page=100${query ? '&' + query : ''}`);
  }

  async allProducts(query = ''): Promise<Product[]> {
    const first = await this.listProducts(query);
    const all = [...first.data];
    for (let page = 2; all.length < first.meta.total; page++) {
      const next = await this.listProducts(`${query ? query + '&' : ''}page=${page}`);
      if (!next.data.length) break;
      all.push(...next.data);
    }
    return all;
  }

  async getProduct(id: number): Promise<Product> {
    return (await this.request('GET', `/catalog/products/${id}`)).data;
  }

  async createProduct(fields: Partial<Product> & { name: string; price?: number; current_stock?: number; [k: string]: unknown }): Promise<Product> {
    const body = {
      product_type: 'simple', category_id: null, brand_id: null, tax_rate_id: null, tax_inclusive: false,
      supplier_id: null, warehouse_id: null, unit: 'pcs', channels: 'both', wholesale_enabled: false,
      track_inventory: true, stock_status: 'in_stock', preorder_enabled: false, preorder_available_at: null,
      low_stock_threshold: 5, is_active: true, label_ids: [], media_ids: [], variants: [], variant_axes: [],
      wholesale_price_tiers: [], specifications: [], faqs: [], current_stock: 10, price: 100,
      ...fields,
    };
    return (await this.request('POST', '/catalog/products', body)).data;
  }

  /** The app has no hard delete: deleted products move to the Archived tab. */
  async deleteProducts(ids: number[]): Promise<void> {
    if (ids.length) await this.request('POST', '/catalog/products/bulk', { ids, action: 'delete' });
  }

  async restoreProduct(id: number): Promise<void> {
    await this.request('POST', `/catalog/products/${id}/restore`);
  }

  async bulk(ids: number[], action: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.request('POST', '/catalog/products/bulk', { ids, action, ...extra });
  }

  async categories(): Promise<{ id: number; name: string; products_count: number }[]> {
    return (await this.request('GET', '/catalog/categories')).data;
  }

  async createCategory(name: string): Promise<{ id: number; name: string }> {
    return (await this.request('POST', '/catalog/categories', { name, is_active: true })).data;
  }

  async deleteCategory(id: number): Promise<void> {
    await this.request('DELETE', `/catalog/categories/${id}`);
  }

  async deletionPreview(id: number): Promise<{ order_count: number; in_orders: boolean; will_deactivate: boolean }> {
    return this.request('GET', `/catalog/products/${id}/deletion-preview`);
  }

  async productOrders(id: number): Promise<{ orders: { reference: string }[] }> {
    return this.request('GET', `/catalog/products/${id}/orders`);
  }
}
