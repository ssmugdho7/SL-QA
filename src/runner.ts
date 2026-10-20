import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { config } from './config.js';
import type { Api, Product } from './api.js';
import type { Session } from './session.js';
import type { TestCase } from './sheet.js';
import { ProductsPage } from './productsPage.js';

export type CheckState = 'pass' | 'fail' | 'skip';
export type Verdict = 'Pass' | 'Fail' | 'Partial' | 'Blocked' | 'Not automated' | 'Error';

export interface Check {
  label: string;
  state: CheckState;
  actual: string;
  /** Hand-written likely cause, shown when the check fails. */
  cause?: string;
}

export interface CaseResult {
  tc: TestCase;
  verdict: Verdict;
  checks: Check[];
  notes: string[];
  screenshots: string[];
  consoleErrors: string[];
  failedRequests: string[];
  error?: string;
  durationMs: number;
}

/** A thrown Blocked stops the case and reports why it could not be tested. */
export class Blocked extends Error {}

export type CaseScript = (t: CaseContext) => Promise<void>;

export class CaseContext {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];
  readonly screenshots: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly failedRequests: string[] = [];
  private contexts: BrowserContext[] = [];
  private createdProductIds: number[] = [];
  private createdCategoryIds: number[] = [];
  private cleanups: (() => Promise<unknown>)[] = [];
  private shotCount = 0;
  products!: ProductsPage;

  constructor(readonly tc: TestCase, readonly session: Session, readonly runDir: string) {}

  get api(): Api { return this.session.api; }
  get page(): Page { return this.products.page; }

  /** Name prefix for anything this case creates. */
  get prefix(): string { return `${config.fixturePrefix} ${this.tc.id}`; }

  async init(): Promise<void> {
    this.products = new ProductsPage(await this.newPage());
  }

  async newPage(opts: { loggedOut?: boolean } = {}): Promise<Page> {
    const context = await this.session.newContext(opts);
    this.contexts.push(context);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => this.consoleErrors.push(`Uncaught: ${e.message.slice(0, 300)}`));
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().startsWith(config.apiUrl)) this.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().replace(config.apiUrl, '')}`);
    });
    page.on('requestfailed', (r) => {
      if (r.url().startsWith(config.apiUrl)) this.failedRequests.push(`network error (${r.failure()?.errorText}) ${r.method()} ${r.url().replace(config.apiUrl, '')}`);
    });
    return page;
  }

  check(label: string, ok: boolean, actual: string, cause?: string): boolean {
    this.checks.push({ label, state: ok ? 'pass' : 'fail', actual, cause });
    return ok;
  }

  /** Records an expectation the bot could not verify, with the reason. */
  skip(label: string, reason: string): void {
    this.checks.push({ label, state: 'skip', actual: reason });
  }

  note(text: string): void {
    this.notes.push(text);
  }

  block(reason: string): never {
    throw new Blocked(reason);
  }

  async shot(label: string, page: Page = this.page): Promise<void> {
    const file = `${this.tc.id}-${++this.shotCount}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    await page.screenshot({ path: path.join(this.runDir, 'shots', file), fullPage: false }).catch(() => undefined);
    this.screenshots.push(file);
  }

  /** Creates a throwaway product that is removed when the case ends. */
  async fixtureProduct(suffix: string, fields: Record<string, unknown> = {}): Promise<Product> {
    const product = await this.api.createProduct({ name: `${this.prefix} ${suffix}`, ...fields });
    this.createdProductIds.push(product.id);
    return (await this.findProduct(product.name)) ?? product;
  }

  async fixtureCategory(name: string): Promise<{ id: number; name: string }> {
    const category = await this.api.createCategory(`${this.prefix} ${name}`);
    this.createdCategoryIds.push(category.id);
    return category;
  }

  /** Registers work to undo at the end of the case, such as restoring a real product. */
  onCleanup(fn: () => Promise<unknown>): void {
    this.cleanups.push(fn);
  }

  /** Product as the list endpoint reports it (includes stock and low/out flags). */
  async findProduct(name: string, query = ''): Promise<Product | undefined> {
    const list = await this.api.allProducts(`q=${encodeURIComponent(name)}${query ? '&' + query : ''}`);
    return list.find((p) => p.name === name);
  }

  async cleanup(): Promise<void> {
    for (const fn of this.cleanups.reverse()) await fn().catch((e) => this.note(`Cleanup step failed: ${e.message}`));
    // Also catch copies the case made through the UI (e.g. duplicates), which carry the same prefix.
    const leftovers = await this.api.allProducts(`q=${encodeURIComponent(this.prefix)}`).catch(() => []);
    const ids = [...new Set([...this.createdProductIds, ...leftovers.filter((p) => p.name.startsWith(this.prefix)).map((p) => p.id)])];
    await this.api.deleteProducts(ids).catch(() => undefined);
    for (const id of this.createdCategoryIds) await this.api.deleteCategory(id).catch(() => undefined);
    for (const c of this.contexts) await c.close().catch(() => undefined);
  }
}

export async function runCase(tc: TestCase, script: CaseScript | undefined, session: Session, runDir: string): Promise<CaseResult> {
  const started = Date.now();
  const t = new CaseContext(tc, session, runDir);
  let verdict: Verdict;
  let error: string | undefined;

  if (!script) {
    verdict = 'Not automated';
    t.note('No script for this test case ID yet. Add one in src/cases/.');
  } else {
    try {
      await t.init();
      await script(t);
      verdict = verdictFrom(t.checks);
    } catch (e) {
      const err = e as Error;
      if (err instanceof Blocked) {
        verdict = 'Blocked';
        t.note(err.message);
      } else {
        // Checks recorded before the crash still count; the crash itself is evidence.
        verdict = t.checks.some((c) => c.state === 'fail') ? 'Fail' : 'Error';
        error = err.message.split('\n').slice(0, 4).join(' ');
      }
      await t.shot('at-stop').catch(() => undefined);
    } finally {
      await t.cleanup();
    }
  }

  return {
    tc,
    verdict,
    checks: t.checks,
    notes: t.notes,
    screenshots: t.screenshots,
    consoleErrors: [...new Set(t.consoleErrors)],
    failedRequests: [...new Set(t.failedRequests)],
    error,
    durationMs: Date.now() - started,
  };
}

function verdictFrom(checks: Check[]): Verdict {
  if (checks.some((c) => c.state === 'fail')) return 'Fail';
  if (!checks.some((c) => c.state === 'pass')) return 'Blocked';
  return checks.some((c) => c.state === 'skip') ? 'Partial' : 'Pass';
}

export function ensureRunDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(config.runsDir, stamp);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  return dir;
}
