import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { config } from './config.js';
import type { Api, Product } from './apps/slshop/api.js';
import type { Session } from './session.js';
import type { TestCase } from './sources/cases.js';
import type { Inspection } from './inspect.js';
import { Ui, type Snap } from './ui.js';

/** 'review': an AI-written check that did not pass. It may be a real bug or a wrong reading by the AI, so a person decides. */
export type CheckState = 'pass' | 'fail' | 'skip' | 'review';
export type Verdict = 'Pass' | 'Fail' | 'Review' | 'Partial' | 'Blocked' | 'Error';

export interface Check {
  label: string;
  state: CheckState;
  actual: string;
  /** Hand-written likely cause, shown when the check fails. */
  cause?: string;
  /** 'ai': written by live AI during the run (not by a rule or an approved rewrite), so a pass is not trusted alone. */
  by?: 'ai';
}

/** Page state that steps set and expectations look back at. */
export interface State {
  tab?: string;
  sort?: string;
  search?: string;
  /** What kind of text was searched ("random word", "sku"…), from the step wording. */
  searchKind?: string;
  /** Product a typed search is meant to find. */
  searchTarget?: { name?: string; sku?: string };
  rows?: number;
  filters: Record<string, string>;
  store?: string;
  offline?: boolean;
  loggedOut?: boolean;
}

export interface Shot { after: string; kind: string; state: State; snap: Snap; extra?: Record<string, unknown> }

export interface StepLog { text: string; status: 'done' | 'failed' | 'unmatched' | 'skipped'; detail?: string; /** How the bot understood it: its own rules, an approved rewrite, or live AI help. */ via?: 'rules' | 'approved' | 'ai' }

export interface CaseResult {
  tc: TestCase;
  verdict: Verdict;
  checks: Check[];
  steps: StepLog[];
  notes: string[];
  screenshots: string[];
  consoleErrors: string[];
  failedRequests: string[];
  /** The case's page on a plain logged-in visit: console, network and visible errors. */
  inspection?: Inspection;
  error?: string;
  durationMs: number;
}

/** A thrown Blocked stops the case and reports why it could not be tested. */
export class Blocked extends Error {
  /** Soft: stop the remaining steps but still check the expected results against what already happened. */
  constructor(message: string, readonly soft = false) {
    super(message);
  }
}

/** State shared by the steps and expectations of one test case. */
export class CaseContext {
  readonly checks: Check[] = [];
  readonly steps: StepLog[] = [];
  readonly notes: string[] = [];
  readonly screenshots: string[] = [];
  readonly consoleErrors: string[] = [];
  readonly failedRequests: string[] = [];
  /** Snapshot taken before the first step and after every step, with what the page state was at the time. */
  readonly snaps: Shot[] = [];
  /** Values noted by "note the …" steps, by name. */
  readonly noted = new Map<string, unknown>();
  /** Products this case created, in creation order. The first is the "subject" product. */
  readonly fixtures: Product[] = [];
  /** Names of products the current selection refers to. */
  selection: string[] = [];
  /** Real product used when a step needs "a product that has orders", and one of its orders read before the test. */
  orderedProduct?: Product;
  orderedSample?: { order_id: number; reference: string };
  dialogsFired = 0;
  /** Browser "Leave this page?" prompts seen when the bot navigated away from unsaved changes. */
  leavePrompts = 0;
  /** Every toast message shown during the case (toasts vanish after a few seconds, so snapshots can miss them). */
  readonly toasts: string[] = [];
  lastDownload: string | null = null;
  clipboard = '';
  inspection?: Inspection;
  ui!: Ui;

  private contexts: BrowserContext[] = [];
  private cleanups: (() => Promise<unknown>)[] = [];
  private shotCount = 0;
  private createdCategoryIds: number[] = [];

  constructor(readonly tc: TestCase, readonly session: Session, readonly runDir: string, readonly startPath: string) {}

  get api(): Api { return this.session.api; }
  get page(): Page { return this.ui.page; }

  /** Name prefix for anything this case creates. */
  get prefix(): string { return `${config.fixturePrefix} ${this.tc.id}`; }

  async init(): Promise<void> {
    this.ui = new Ui(await this.newPage());
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
    await page.exposeFunction('__btbToast', (text: string) => {
      if (text && !this.toasts.includes(text)) this.toasts.push(text);
    }).catch(() => undefined);
    await page.addInitScript(() => {
      const seen = new WeakSet<Element>();
      const report = () => {
        for (const el of document.querySelectorAll('[data-sonner-toast]')) {
          const text = (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
          if (!text || seen.has(el)) continue;
          seen.add(el);
          (window as unknown as { __btbToast: (t: string) => void }).__btbToast(text);
        }
      };
      new MutationObserver(() => setTimeout(report, 50)).observe(document, { childList: true, subtree: true });
    });
    page.on('dialog', async (d) => {
      // "Leave this page?" only appears when the bot itself navigates away: count it, then leave as intended.
      if (d.type() === 'beforeunload') {
        this.leavePrompts++;
        await d.accept().catch(() => undefined);
        return;
      }
      this.dialogsFired++;
      await d.dismiss().catch(() => undefined);
    });
    return page;
  }

  /** Swaps the active page (e.g. to a logged-out browser) for the following steps. */
  async usePage(page: Page): Promise<void> {
    this.ui = new Ui(page);
  }

  state: State = { filters: {} };

  async snap(after: string, kind = 'step', extra?: Record<string, unknown>): Promise<Snap> {
    const snap = await this.ui.snapshot();
    this.snaps.push({ after, kind, state: structuredClone(this.state), snap, extra });
    return snap;
  }

  /** Most recent snapshot. */
  get now(): Snap | undefined { return this.snaps.at(-1)?.snap; }

  check(label: string, ok: boolean, actual: string, cause?: string): boolean {
    this.checks.push({ label, state: ok ? 'pass' : 'fail', actual, cause });
    return ok;
  }

  /** Records an expectation the bot could not verify, with the reason. */
  skip(label: string, reason: string): void {
    this.checks.push({ label, state: 'skip', actual: reason });
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  block(reason: string): never {
    throw new Blocked(reason);
  }

  async shot(label: string, page: Page = this.page): Promise<void> {
    const file = `${this.tc.id}-${++this.shotCount}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.png`;
    await page.screenshot({ path: path.join(this.runDir, 'shots', file) }).catch(() => undefined);
    this.screenshots.push(file);
  }

  /** Creates a throwaway product that is archived when the case ends. */
  async fixtureProduct(suffix: string, fields: Record<string, unknown> = {}): Promise<Product> {
    const created = await this.api.createProduct({ name: `${this.prefix} ${suffix}`.slice(0, 200), ...fields });
    const product = (await this.findProduct(created.name)) ?? created;
    this.fixtures.push(product);
    return product;
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

  async refreshFixture(i = 0): Promise<Product | undefined> {
    const f = this.fixtures[i];
    if (!f) return undefined;
    const fresh = (await this.findProduct(f.name)) ?? (await this.findProduct(f.name, 'status=archived'));
    if (fresh) this.fixtures[i] = fresh;
    return fresh;
  }

  async cleanup(): Promise<void> {
    for (const fn of this.cleanups.reverse()) await fn().catch((e) => this.note(`Cleanup step failed: ${e.message}`));
    // Also catch copies the case made through the UI (e.g. duplicates), which carry the same prefix.
    const leftovers = await this.api.allProducts(`q=${encodeURIComponent(this.prefix)}`).catch(() => []);
    const ids = [...new Set([...this.fixtures.map((p) => p.id), ...leftovers.filter((p) => p.name.startsWith(this.prefix)).map((p) => p.id)])];
    await this.api.deleteProducts(ids).catch(() => undefined);
    for (const id of this.createdCategoryIds) await this.api.deleteCategory(id).catch(() => undefined);
    for (const c of this.contexts) await c.close().catch(() => undefined);
  }

  result(verdict: Verdict, started: number, error?: string): CaseResult {
    return {
      tc: this.tc,
      verdict,
      checks: this.checks,
      steps: this.steps,
      notes: this.notes,
      screenshots: this.screenshots,
      consoleErrors: [...new Set(this.consoleErrors)],
      failedRequests: [...new Set(this.failedRequests)],
      inspection: this.inspection,
      error,
      durationMs: Date.now() - started,
    };
  }
}

export function verdictFrom(checks: Check[]): Verdict {
  if (checks.some((c) => c.state === 'fail')) return 'Fail';
  // Only AI-written checks disagreed with the page: a person should look before calling it a bug.
  if (checks.some((c) => c.state === 'review')) return 'Review';
  if (!checks.some((c) => c.state === 'pass')) return 'Blocked';
  // Every pass came from a check the AI wrote live: it may have checked the wrong thing, so a person confirms.
  if (aiChecked(checks)) return 'Review';
  return checks.some((c) => c.state === 'skip') ? 'Partial' : 'Pass';
}

/** True when the case has passing checks and all of them were written by live AI (no rule or approved check passed). */
export function aiChecked(checks: Check[]): boolean {
  const passes = checks.filter((c) => c.state === 'pass');
  return passes.length > 0 && passes.every((c) => c.by === 'ai') && !checks.some((c) => c.state === 'fail');
}

export function newRunDir(id: string): string {
  const dir = path.join(config.runsDir, id);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
  return dir;
}
