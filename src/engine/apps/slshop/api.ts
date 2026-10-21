import { config } from '../../config.js';

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
  category_id: number | null;
  category: { id: number; name: string } | null;
  brand: { id: number; name: string } | null;
  variants: { id: number; name: string; sku: string; price: string; stock: number }[];
}

export interface Category { id: number; name: string; products_count: number }
export interface Store { id: number; name: string }

/** Thin client for the slshop REST API. Used to build and clean up test data and to cross-check what the UI shows. */
export class Api {
  constructor(private token: string, public storeId: number) {}

  forStore(storeId: number): Api {
    return new Api(this.token, storeId);
  }

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

  /** Newest orders first (reference, customer, totals). */
  async recentOrders(n = 5): Promise<{ id: number; reference: string; customer?: { name?: string }; subtotal?: string; total: string; discount?: string; status: string; created_at: string }[]> {
    const r = await this.request<{ data: any[] }>('GET', `/sales/orders?per_page=${n}`);
    return (r.data ?? []).map((o) => ({ ...o, reference: o.reference ?? o.order_number ?? `#${o.id}` }));
  }

  async stockLevels(id: number): Promise<{ quantity: number; reserved: number; available: number; warehouses: { name: string; quantity: number }[] }> {
    const r = await this.request<{ warehouses: { name: string; quantity: number }[]; totals: { quantity: number; reserved: number; available: number } }>('GET', `/catalog/products/${id}/stocks`);
    return { ...r.totals, warehouses: r.warehouses };
  }

  async stockMovements(id: number): Promise<{ type: string; quantity: number; reason: string | null; reference: string | null; created_at?: string }[]> {
    return (await this.request<{ data: any[] }>('GET', `/inventory/movements?product_id=${id}`)).data ?? [];
  }

  async brands(): Promise<{ id: number; name: string }[]> {
    return (await this.request<{ data: { id: number; name: string }[] }>('GET', '/catalog/brands')).data;
  }

  async labels(): Promise<{ id: number; name: string }[]> {
    return (await this.request<{ data: { id: number; name: string }[] }>('GET', '/catalog/labels')).data;
  }

  async attributes(): Promise<{ id: number; name: string; values: string[]; swatches: Record<string, string>; codes: Record<string, string>; is_active: boolean }[]> {
    return (await this.request<{ data: any[] }>('GET', '/catalog/attributes')).data;
  }

  /** Removes attribute values a test added (the form saves new values to the shared attribute). */
  async removeAttributeValues(name: string, values: string[]): Promise<void> {
    const a = (await this.attributes()).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!a) return;
    const keep = a.values.filter((v) => !values.includes(v));
    if (keep.length === a.values.length) return;
    await this.request('PUT', `/catalog/attributes/${a.id}`, { name: a.name, values: keep, swatches: a.swatches, codes: a.codes, is_active: a.is_active });
  }

  async stores(): Promise<Store[]> {
    return (await this.request<{ stores: Store[] }>('GET', '/auth/me')).stores;
  }

  async listProducts(query = ''): Promise<{ data: Product[]; meta: { total: number } }> {
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

  async createProduct(fields: { name: string; [k: string]: unknown }): Promise<Product> {
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

  /** The update endpoint wants the whole product, so read it, change the fields and send it back. */
  async updateProduct(id: number, fields: Record<string, unknown>): Promise<Product> {
    const p = await this.getProduct(id);
    const body = { ...p, price: p.price === null ? null : Number(p.price), category_id: p.category?.id ?? null, brand_id: p.brand?.id ?? null, label_ids: [], media_ids: [], ...fields };
    return (await this.request('PUT', `/catalog/products/${id}`, body)).data;
  }

  async adjustStock(id: number, type: 'in' | 'out', quantity: number): Promise<void> {
    const stocks = await this.request<{ warehouses?: { warehouse_id: number }[] }>('GET', `/catalog/products/${id}/stocks`);
    const warehouseId = stocks.warehouses?.[0]?.warehouse_id;
    await this.request('POST', `/catalog/products/${id}/adjust-stock`, { warehouse_id: warehouseId, type, quantity, sync_to_accounts: false });
  }

  /** The app has no hard delete: deleted products move to the Archived tab. */
  async deleteProducts(ids: number[]): Promise<void> {
    if (ids.length) await this.request('POST', '/catalog/products/bulk', { ids, action: 'delete' });
  }

  async restoreProduct(id: number): Promise<void> {
    await this.request('POST', `/catalog/products/${id}/restore`);
  }

  async bulk(ids: number[], action: string): Promise<void> {
    await this.request('POST', '/catalog/products/bulk', { ids, action });
  }

  async categories(): Promise<Category[]> {
    return (await this.request('GET', '/catalog/categories')).data;
  }

  async createCategory(name: string): Promise<Category> {
    return (await this.request('POST', '/catalog/categories', { name, is_active: true })).data;
  }

  async deleteCategory(id: number): Promise<void> {
    await this.request('DELETE', `/catalog/categories/${id}`);
  }

  async deletionPreview(id: number): Promise<{ order_count: number; in_orders: boolean; will_deactivate: boolean }> {
    return this.request('GET', `/catalog/products/${id}/deletion-preview`);
  }

  async productOrders(id: number): Promise<{ orders: { order_id: number; reference: string }[] }> {
    return this.request('GET', `/catalog/products/${id}/orders`);
  }
}
