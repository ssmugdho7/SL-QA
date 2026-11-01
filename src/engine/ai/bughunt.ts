import fs from 'fs';
import path from 'path';
import type { CDPSession, Locator, Page } from 'playwright';
import type { PageInfo } from '../apps/slshop/crawl.js';
import { config } from '../config.js';
import { knownPages, pageInfo, pagePath } from '../pages.js';
import { startSession, type Session } from '../session.js';
import type { TestCase } from '../sources/cases.js';
import { redact, secrets } from './chat.js';
import { complete } from './providers.js';
import { screenshot, settle, superQaModel, UNSAFE } from './superqa.js';

/**
 * Bug hunt: drives a logged-in Chromium over one to four dashboard pages with a DevTools (CDP) session attached, records
 * console errors, uncaught exceptions, failed and slow requests, performance metrics, broken images, error text on
 * screen, basic accessibility and layout problems, then tries the page with the real mouse and keyboard (tabs, filter
 * and sort menus, search, next page, first record, dialogs, Tab key) and notes which action caused each new problem.
 * Read-only: nothing whose name matches UNSAFE is clicked, Enter is never pressed. An AI (OpenAI first) then triages the
 * raw findings into evidence-backed bugs. One hunt at a time; one browser, one page.
 */

export type Severity = 'critical' | 'major' | 'minor' | 'cosmetic';
export const SEVERITIES: Severity[] = ['critical', 'major', 'minor', 'cosmetic'];

export interface Bug {
  title: string;
  severity: Severity;
  page: string;
  steps: string[];
  expected: string;
  actual: string;
  evidence: string;
  /** File name of a screenshot in the chat's shots folder ("3.jpg"). */
  screenshot?: string;
  edited?: boolean;
}

export interface HuntResult { reply: string; bugs: Bug[]; checked: string[]; model?: string; seconds: number }

export type Stage = 'open' | 'devtools' | 'interact' | 'ai';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'open', label: 'Opening the page' },
  { id: 'devtools', label: 'DevTools capture (console, network, performance, layout)' },
  { id: 'interact', label: 'Trying tabs, filters, search, records, dialogs and the keyboard' },
  { id: 'ai', label: 'Asking the AI to triage the findings' },
];

/** The hunt now running (in memory; one at a time). */
export const hunting: { busy: boolean; chatId?: string; stage?: Stage; detail: string; startedAt: number } = { busy: false, detail: '', startedAt: 0 };

export class HuntError extends Error {}

const MAX_PAGES = 4;
const ACTION_MS = 8_000;
const PAGE_MS = 45_000;
const BUDGET_MS = 150_000;
const SLOW_S = 2;
const MAX_SHOTS = 6;
const MAX_IMAGES = 4;
const ERROR_TEXT = /something went wrong|went wrong|error occurred|failed to load|could not load|unable to load|page not found|access denied|forbidden|\bNaN\b|\bundefined\b|\[object Object\]|invalid date|\b(?:error|status|code)\s*:?\s*(?:4\d\d|5\d\d)\b/i;
const EMPTY_TEXT = /^(?:no (?:data|results?|records?|items?|entries|products?|orders?|customers?|transactions?)(?: found| yet| available| to show)?|nothing (?:here|found|to show)(?: yet)?|no .{1,30} (?:found|yet)|empty)[.!]?$/i;

// ── Where → pages ──────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/\s*[›»>]\s*/g, ' > ').replace(/\s+/g, ' ').trim();
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).map((w) => w.replace(/s$/, '')));
const nameOf = (p: PageInfo) => (p.group ? `${p.group} › ${p.label}` : p.label);

/** Suggestions for the Where field: pages ("Sales › Orders"), sidebar groups and sections, then paths. */
export function whereOptions(): string[] {
  const pages = knownPages();
  const out = new Set<string>();
  for (const p of pages) out.add(nameOf(p));
  for (const p of pages) {
    if (p.group) out.add(p.group.split(' › ')[0]).add(p.group);
    if (p.section) out.add(p.section);
  }
  for (const p of pages) out.add(p.path);
  return [...out];
}

/** Up to 4 page paths for a page, module or feature name (or a path). Throws a HuntError listing close matches. */
export function resolveWhere(where: string, focus = ''): string[] {
  const w = where.trim();
  if (/^(?:\/|https?:)/i.test(w)) {
    let u: URL | null = null;
    try { u = new URL(w, config.baseUrl); } catch { /* not a URL */ }
    if (u && u.pathname.startsWith('/dashboard')) return [pageInfo(u.pathname + u.search)?.path ?? (u.pathname.replace(/\/+$/, '') + u.search)];
    throw new HuntError(`"${w}" is not a dashboard path. Use a path that starts with /dashboard, or a page name such as 'Products'.`);
  }
  const n = norm(w).replace(/^the /, '').replace(/ (?:page|screen|module|section|feature|menu)$/, '');
  const pages = knownPages();
  // One page by its name (sidebar label, "Group › Label", heading, breadcrumb, or a common synonym).
  const exact = pages.find((p) => [p.label, p.title, p.group ? `${p.group} > ${p.label}` : '', p.breadcrumb ?? ''].some((x) => x && norm(x) === n));
  if (exact) return [exact.path];
  const synonym = pagePath(w);
  if (synonym) return [synonym];
  // A module: the pages of a sidebar group or section, the ones that share words with the focus first.
  const rank = (xs: PageInfo[]) => {
    const q = words(`${focus} ${w}`);
    return xs.map((p, i) => ({ p, i, s: [...words(`${p.label} ${p.title}`)].filter((x) => q.has(x)).length }))
      .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, MAX_PAGES).map((x) => x.p.path);
  };
  const group = pages.filter((p) => p.group && (norm(p.group) === n || norm(p.group).startsWith(`${n} > `) || norm(p.group.split(' › ').at(-1)!) === n));
  if (group.length) return rank(group);
  const section = pages.filter((p) => p.section && norm(p.section) === n);
  if (section.length) return rank(section);
  // A feature: pages whose name contains the words.
  const partial = pages.filter((p) => norm(`${nameOf(p)} ${p.title}`).includes(n));
  if (partial.length) return rank(partial);
  const q = words(w);
  const close = whereOptions().filter((o) => !o.startsWith('/') && ([...words(o)].some((x) => q.has(x) || [...q].some((y) => x.startsWith(y.slice(0, 3))))));
  throw new HuntError(`No dashboard page, module or feature matches "${w}".${close.length ? ` Close matches: ${close.slice(0, 8).map((c) => `'${c}'`).join(', ')}.` : ' Pick one from the list, or type a path such as /dashboard/products.'}`);
}

// ── Recording ──────────────────────────────────────────────────────────

type Kind = 'exception' | 'console-error' | 'console-warning' | 'failed-request' | 'slow-request' | 'screen' | 'broken-image' | 'a11y' | 'layout' | 'performance' | 'interaction';
interface Problem { kind: Kind; text: string; page: string; action: string; count: number; shot?: number }

const shortUrl = (url = '') => {
  let u = url.replace(config.apiUrl, 'API ').replace(config.baseUrl, '');
  // Tokens and signatures in query strings never reach the AI or the report.
  u = u.replace(/([?&](?:token|key|auth|sig|signature|access_token|apikey)[^=&]*=)[^&\s]+/gi, '$1…');
  return u.length > 180 ? `${u.slice(0, 180)}…` : u;
};
const thirdParty = (url = '') => !url.startsWith(config.baseUrl) && !url.startsWith(config.apiUrl) && /^https?:/.test(url);

interface Scan {
  errorTexts: string[];
  empty: string[];
  brokenImages: string[];
  unnamed: string[];
  unlabeled: string[];
  noAlt: string[];
  overflow: { scrollWidth: number; width: number; culprits: string[] } | null;
  rows: number;
}

async function scan(page: Page): Promise<Scan> {
  return page.evaluate(({ err, empty }) => {
    const ERR = new RegExp(err, 'i');
    const EMPTY = new RegExp(empty, 'i');
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const desc = (e: Element) => {
      const el = e as HTMLElement;
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('') : '';
      const hint = el.getAttribute('href') || el.getAttribute('name') || el.getAttribute('placeholder') || el.querySelector('svg')?.getAttribute('class') || '';
      return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>${hint ? ` ${String(hint).slice(0, 50)}` : ''}`;
    };
    const byIds = (ids: string | null) => (ids ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const accName = (e: Element) => (e.getAttribute('aria-label') ?? '').trim() || byIds(e.getAttribute('aria-labelledby')) || ((e as HTMLElement).innerText ?? '').trim() || (e.getAttribute('title') ?? '').trim()
      || [...e.querySelectorAll('img[alt]')].map((i) => (i as HTMLImageElement).alt).join('').trim() || (e.querySelector('svg title')?.textContent ?? '').trim();
    const root = (document.querySelector('main') ?? document.body) as HTMLElement;
    const lines = (root.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const uniq = (xs: string[], n: number) => [...new Set(xs)].slice(0, n);
    const w = window.innerWidth;
    const sw = document.documentElement.scrollWidth;
    const culprits = sw > w + 2 ? uniq([...document.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return vis(e) && r.right > w + 2 && r.left < w && e.children.length < 8; }).map(desc), 4) : [];
    return {
      errorTexts: uniq(lines.filter((l) => l.length < 160 && ERR.test(l)), 8),
      empty: uniq(lines.filter((l) => l.length < 60 && EMPTY.test(l)), 4),
      brokenImages: uniq([...document.images].filter((i) => vis(i) && i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src), 8),
      unnamed: uniq([...document.querySelectorAll('button, a[href], [role=button]')].filter(vis).filter((e) => !accName(e)).map(desc), 40),
      unlabeled: uniq([...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter(vis).filter((e) => {
        const i = e as HTMLInputElement;
        return !i.labels?.length && !i.getAttribute('aria-label') && !byIds(i.getAttribute('aria-labelledby')) && !i.getAttribute('title');
      }).map((e) => `${desc(e)}${(e as HTMLInputElement).placeholder ? ' (placeholder only)' : ''}`), 40),
      noAlt: uniq([...document.images].filter((i) => vis(i) && !i.hasAttribute('alt')).map((i) => i.src.slice(0, 120)), 40),
      overflow: sw > w + 2 ? { scrollWidth: sw, width: w, culprits } : null,
      rows: root.querySelectorAll('tbody tr, [role=row], article').length,
    };
  }, { err: ERROR_TEXT.source, empty: EMPTY_TEXT.source }).catch(() => ({ errorTexts: [], empty: [], brokenImages: [], unnamed: [], unlabeled: [], noAlt: [], overflow: null, rows: 0 }));
}

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`timed out after ${ms / 1000}s`)), ms))]);

class Hunt {
  problems: Problem[] = [];
  actions: string[] = [];
  notes: string[] = [];
  timings: string[] = [];
  shots: { file: string; b64: string }[] = [];
  page!: Page;
  cdp?: CDPSession;
  url = '';
  action = 'page load';
  private seen = new Map<string, Problem>();
  private reqs = new Map<string, { method: string; url: string; t: number; type?: string }>();
  private screenSeen = new Set<string>();
  readonly deadline = Date.now() + BUDGET_MS;
  pageDeadline = 0;

  constructor(private shotsDir: string, private nextShot: number) {}

  left = () => Math.min(this.deadline, this.pageDeadline) - Date.now();

  add(kind: Kind, text: string): void {
    const key = `${kind} ${text.replace(/\d{3,}/g, '#')}`;
    const had = this.seen.get(key);
    if (had) return void had.count++;
    const p: Problem = { kind, text: text.replace(/\s+/g, ' ').trim().slice(0, 400), page: this.url, action: this.action, count: 1 };
    this.seen.set(key, p);
    this.problems.push(p);
  }

  async attach(page: Page): Promise<void> {
    this.page = page;
    const cdp = (this.cdp = await page.context().newCDPSession(page));
    await Promise.all(['Runtime.enable', 'Log.enable', 'Network.enable', 'Performance.enable'].map((m) => cdp.send(m as 'Runtime.enable')));
    cdp.on('Runtime.consoleAPICalled', (e) => {
      if (e.type !== 'error' && e.type !== 'warning') return;
      const text = e.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ');
      const where = e.stackTrace?.callFrames[0]?.url;
      this.add(e.type === 'error' ? 'console-error' : 'console-warning', `${text}${where && thirdParty(where) ? ` (from ${shortUrl(where)})` : ''}`);
    });
    cdp.on('Runtime.exceptionThrown', (e) => {
      const d = e.exceptionDetails;
      this.add('exception', `${(d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' ')}${d.url ? ` (at ${shortUrl(d.url)}:${d.lineNumber})` : ''}`);
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      // Network entries ("Failed to load resource") are recorded from the Network domain, with the method.
      if (entry.source === 'network' || (entry.level !== 'error' && entry.level !== 'warning')) return;
      this.add(entry.level === 'error' ? 'console-error' : 'console-warning', `[${entry.source}] ${entry.text}${entry.url ? ` (${shortUrl(entry.url)})` : ''}`);
    });
    cdp.on('Network.requestWillBeSent', (e) => this.reqs.set(e.requestId, { method: e.request.method, url: e.request.url, t: e.timestamp, type: e.type }));
    cdp.on('Network.responseReceived', (e) => {
      const r = this.reqs.get(e.requestId);
      if (e.response.status >= 400) this.add('failed-request', `${e.response.status} ${r?.method ?? 'GET'} ${shortUrl(e.response.url)}${thirdParty(e.response.url) ? ' (third-party)' : ''}`);
    });
    cdp.on('Network.loadingFailed', (e) => {
      const r = this.reqs.get(e.requestId);
      this.reqs.delete(e.requestId);
      if (e.canceled || /ERR_ABORTED/.test(e.errorText) || !r) return;
      this.add('failed-request', `network error (${e.errorText}) ${r.type ?? ''} ${r.method} ${shortUrl(r.url)}${r.type !== 'Image' && thirdParty(r.url) ? ' (third-party)' : ''}`.replace(/\s+/g, ' '));
    });
    cdp.on('Network.loadingFinished', (e) => {
      const r = this.reqs.get(e.requestId);
      this.reqs.delete(e.requestId);
      const s = r ? e.timestamp - r.t : 0;
      if (r && s > SLOW_S && !['Image', 'Font', 'Media', 'EventSource', 'WebSocket'].includes(r.type ?? '')) this.add('slow-request', `${s.toFixed(1)}s ${r.method} ${shortUrl(r.url)}${thirdParty(r.url) ? ' (third-party)' : ''}`);
    });
  }

  /** Waits for the page to go quiet after an action (short: live updates may never stop). */
  async quiet(ms = 2_000): Promise<void> {
    await this.page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
    await this.page.waitForTimeout(400);
  }

  /** New error text on screen since the page first loaded. */
  async checkScreen(): Promise<Scan> {
    const s = await scan(this.page);
    for (const t of s.errorTexts) if (!this.screenSeen.has(t)) { this.screenSeen.add(t); this.add('screen', `Text on screen: "${t}"`); }
    // Images of the shop's own content often come from a storage host (S3, CDN): not third-party noise.
    for (const src of s.brokenImages) this.add('broken-image', `Broken image (did not load): ${shortUrl(src)}`);
    return s;
  }

  async shoot(): Promise<number | undefined> {
    if (this.shots.length >= MAX_SHOTS) return undefined;
    const b64 = await screenshot(this.page);
    if (!b64) return undefined;
    const file = `${this.nextShot++}.jpg`;
    fs.mkdirSync(this.shotsDir, { recursive: true });
    fs.writeFileSync(path.join(this.shotsDir, file), Buffer.from(b64, 'base64'));
    this.shots.push({ file, b64 });
    return this.shots.length - 1;
  }

  /** Runs one interaction, then records what it caused (new problems, a screenshot when there are any). */
  async act(name: string, fn: () => Promise<string | void>): Promise<void> {
    if (this.left() < 3_000) return void this.notes.push(`Skipped "${name}" on ${this.url}: time budget used.`);
    this.action = name;
    const before = this.problems.length;
    const t = Date.now();
    let note = '';
    try {
      note = (await timeout(fn(), Math.min(ACTION_MS, this.left()))) ?? '';
    } catch (e) {
      note = `stopped: ${(e as Error).message.split('\n')[0].slice(0, 100)}`;
    }
    await this.quiet();
    await this.checkScreen();
    // Stay on the dashboard: a click that left it goes back to the page being hunted.
    const now = new URL(this.page.url());
    if (now.origin !== new URL(config.baseUrl).origin || !now.pathname.startsWith('/dashboard')) await this.page.goto(`${config.baseUrl}${this.url}`, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
    const fresh = this.problems.slice(before);
    if (fresh.some((p) => p.kind !== 'console-warning' && p.kind !== 'slow-request')) {
      const shot = await this.shoot();
      for (const p of fresh) p.shot ??= shot;
    }
    this.actions.push(`${this.url}: ${name}${note ? ` — ${note}` : ''} (${((Date.now() - t) / 1000).toFixed(1)}s${fresh.length ? `, ${fresh.length} new problem${fresh.length === 1 ? '' : 's'}` : ''})`);
    this.action = 'after the actions';
  }
}

/** Marks the visible elements matching `selector` whose name is safe to click, returns their names (data-bh=<i>). */
async function candidates(page: Page, selector: string, name: RegExp | null, max: number): Promise<string[]> {
  const names = await page.evaluate(({ selector, name, max }) => {
    document.querySelectorAll('[data-bh]').forEach((e) => e.removeAttribute('data-bh'));
    const re = name ? new RegExp(name, 'i') : null;
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const out: string[] = [];
    for (const e of document.querySelectorAll(selector)) {
      if (out.length >= max || !vis(e) || e.matches('[disabled], [aria-disabled=true]')) continue;
      const n = ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (re && !re.test(n)) continue;
      e.setAttribute('data-bh', String(out.length));
      out.push(n.slice(0, 60));
    }
    return out;
  }, { selector, name: name?.source ?? null, max }).catch(() => [] as string[]);
  return names;
}

/** A real mouse click in the middle of the element (moves the pointer there first). */
async function mouseClick(page: Page, el: Locator): Promise<void> {
  await el.scrollIntoViewIfNeeded({ timeout: 3_000 });
  const box = await el.boundingBox({ timeout: 3_000 });
  if (!box) throw new Error('not on screen');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const OPTIONS = '[role=menu] [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=listbox] [role=option], [data-radix-popper-content-wrapper] [role=checkbox], [data-radix-popper-content-wrapper] label, [role=dialog] [role=checkbox], [role=dialog] input[type=checkbox]';

async function interact(h: Hunt, info: PageInfo | null, focus: string): Promise<void> {
  const page = h.page;
  const home = `${config.baseUrl}${h.url}`;
  const back = () => page.goto(home, { waitUntil: 'domcontentloaded', timeout: 10_000 }).then(() => settle(page, 3_000), () => {});
  const at = (k: number) => page.locator(`[data-bh="${k}"]`).first();

  // Tabs: each one in turn, then back to the first.
  const tabs = (await candidates(page, '[role=tab]', null, 8)).filter((n) => n && !UNSAFE.test(n));
  for (const [k, name] of tabs.entries()) {
    if (k === 0) continue;
    await h.act(`click tab '${name}'`, async () => {
      await candidates(page, '[role=tab]', null, 8);
      await mouseClick(page, at(k));
      await page.waitForTimeout(600);
    });
  }
  if (tabs.length > 1) await h.act(`back to tab '${tabs[0]}'`, async () => { await candidates(page, '[role=tab]', null, 8); await mouseClick(page, at(0)); });

  // Filter and sort menus: open, pick the first option, then reset (reload the page as it was).
  const menuName = new RegExp(`^(?:${['filters?', 'sort(?: by)?', info?.filterButton?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')].filter(Boolean).join('|')})\\b`);
  for (const name of (await candidates(page, 'main button, main [role=button], main [role=combobox]', menuName, 2)).filter((n) => !UNSAFE.test(n))) {
    await h.act(`open '${name}' and pick its first option`, async () => {
      const k = (await candidates(page, 'main button, main [role=button], main [role=combobox]', menuName, 2)).indexOf(name);
      if (k < 0) return 'gone';
      await mouseClick(page, at(k));
      await page.waitForTimeout(700);
      const opts = (await candidates(page, OPTIONS, null, 12)).map((n, i) => ({ n, i })).filter((o) => o.n && !UNSAFE.test(o.n));
      if (!opts.length) { await page.keyboard.press('Escape'); return 'no options found'; }
      await mouseClick(page, at(opts[0].i));
      await page.waitForTimeout(1_000);
      await page.keyboard.press('Escape');
      return `picked '${opts[0].n}'${page.url() !== home ? `, URL now ${shortUrl(page.url())}` : ''}`;
    });
    await h.act(`reset '${name}'`, async () => { await back(); });
  }

  // Search: a letter, a nonsense word (expect an empty state), then clear.
  const search = page.locator('main input[type=search], main [role=searchbox], main input[placeholder*="earch" i]').first();
  if (await search.isVisible().catch(() => false)) {
    const rows = async () => (await scan(page)).rows;
    const before = await rows();
    await h.act(`type 'a' in the search box`, async () => {
      await mouseClick(page, search);
      await page.keyboard.type('a', { delay: 60 });
      await page.waitForTimeout(1_500);
      return `${await rows()} rows (was ${before})`;
    });
    await h.act(`type a nonsense word ('zqxjv9') in the search box`, async () => {
      await search.click({ timeout: 3_000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.type('zqxjv9', { delay: 50 });
      await page.waitForTimeout(1_800);
      const s = await scan(page);
      if (s.rows > 0 && !s.empty.length && before > 0 && s.rows >= before) h.add('interaction', `Searching for the nonsense word 'zqxjv9' still shows ${s.rows} rows (as many as before) and no empty-state message`);
      return s.empty.length ? `empty state: "${s.empty[0]}"` : `${s.rows} rows, no empty-state message`;
    });
    await h.act('clear the search box', async () => {
      await search.click({ timeout: 3_000 });
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(1_500);
      const after = await rows();
      if (before > 0 && after === 0) h.add('interaction', `After clearing the search box the list stays empty (${before} rows before searching)`);
      return `${after} rows`;
    });
  }

  // Next page of a list.
  const next = /^(?:next|next page|›|»|>|→)$/;
  const nexts = await candidates(page, 'main button, main a[href], main [role=button]', next, 1);
  if (nexts.length) {
    await h.act('go to the next page of the list', async () => {
      await candidates(page, 'main button, main a[href], main [role=button]', next, 1);
      await mouseClick(page, at(0));
      await page.waitForTimeout(1_200);
      const s = await scan(page);
      return `${s.rows} rows${s.empty.length ? `, "${s.empty[0]}"` : ''}`;
    });
    await h.act('back to the first page', back);
  }

  // The first record's own page (a link in the first table row), then back.
  const rowLink = await candidates(page, 'main tbody tr:first-child a[href]', null, 1);
  if (rowLink.length && !UNSAFE.test(rowLink[0])) {
    await h.act(`open the first record ('${rowLink[0] || 'row link'}') and go back`, async () => {
      await mouseClick(page, at(0));
      await page.waitForURL((u) => u.toString() !== home, { timeout: 5_000 }).catch(() => {});
      if (page.url() === home) return 'the link did not open a page';
      await settle(page, 3_000);
      await h.checkScreen();
      const opened = shortUrl(page.url());
      await page.goBack({ timeout: 5_000 }).catch(() => back());
      return `opened ${opened}`;
    });
  }

  // Dialogs and menus opened by safe buttons: open, then close with Escape.
  const popup = 'main button[aria-haspopup], main [role=button][aria-haspopup]';
  const pops = (await candidates(page, popup, null, 6)).map((n, i) => ({ n, i })).filter((o) => o.n && !UNSAFE.test(o.n) && !menuName.test(o.n)).slice(0, 2);
  for (const o of pops) {
    await h.act(`open '${o.n}' and close it with Escape`, async () => {
      await candidates(page, popup, null, 6);
      await mouseClick(page, at(o.i));
      await page.waitForTimeout(700);
      const open = page.locator('[role=dialog], [role=menu], [role=listbox]').first();
      const opened = await open.isVisible().catch(() => false);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      if (opened && (await open.isVisible().catch(() => false))) h.add('interaction', `The popup opened by '${o.n}' does not close with Escape`);
      return opened ? 'opened and closed' : 'nothing opened';
    });
  }

  // Keyboard: Tab through the first 15 focusable elements; note ones without a name or a visible focus ring.
  await h.act('press Tab 15 times', async () => {
    // Start in the page's own content (not the sidebar): focus <main>, then Tab from there.
    await page.evaluate(() => { const m = document.querySelector('main') as HTMLElement | null; if (m) { m.setAttribute('tabindex', '-1'); m.focus(); } }).catch(() => {});
    const seen: string[] = [];
    let noRing = 0;
    let noName = 0;
    for (let k = 0; k < 15; k++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        if (!e || e === document.body) return null;
        const cs = getComputedStyle(e);
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
        const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || (e as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return { tag: e.tagName.toLowerCase(), name, ring };
      }).catch(() => null);
      if (!f) continue;
      seen.push(f.name || `<${f.tag}>`);
      if (!f.ring) noRing++;
      if (!f.name) noName++;
    }
    if (noRing >= 5) h.add('a11y', `${noRing} of the first ${seen.length} elements reached with Tab show no visible focus outline`);
    if (noName >= 3) h.add('a11y', `${noName} of the first ${seen.length} elements reached with Tab have no accessible name`);
    return `focus went through: ${seen.slice(0, 15).join(' → ')}`;
  });
  void focus;
}

async function huntPage(h: Hunt, url: string, focus: string, stage: (s: Stage, d: string) => void): Promise<void> {
  const page = h.page;
  h.url = url;
  h.action = 'page load';
  h.pageDeadline = Date.now() + PAGE_MS;
  const t0 = Date.now();
  stage('open', `Opening ${url}`);
  const res = await page.goto(`${config.baseUrl}${url}`, { waitUntil: 'load', timeout: Math.min(30_000, h.left()) }).catch((e: Error) => (h.notes.push(`Could not open ${url}: ${e.message.split('\n')[0].slice(0, 120)}`), null));
  if (!res) return;
  const loadMs = Date.now() - t0;
  if (res.status() >= 400) h.add('failed-request', `${res.status()} GET ${url} (the page itself)`);
  await settle(page, Math.min(8_000, h.left() - 20_000));
  if (/\/login/.test(new URL(page.url()).pathname)) h.add('screen', `${url} redirected to the login screen`);

  stage('devtools', `DevTools capture on ${url}`);
  const s = await h.checkScreen();
  const metrics = await h.cdp!.send('Performance.getMetrics').then((m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value])), () => ({} as Record<string, number>));
  const mb = (metrics.JSHeapUsedSize ?? 0) / 1048576;
  h.timings.push(`${url}: loaded in ${(loadMs / 1000).toFixed(1)}s; JS heap ${mb.toFixed(0)} MB, ${metrics.Nodes ?? '?'} DOM nodes, layout ${(metrics.LayoutDuration ?? 0).toFixed(2)}s, script ${(metrics.ScriptDuration ?? 0).toFixed(2)}s${s.empty.length ? `; empty state: "${s.empty[0]}"` : ''}`);
  if (loadMs > 8_000) h.add('performance', `The page took ${(loadMs / 1000).toFixed(1)}s to load`);
  if (mb > 150) h.add('performance', `JS heap is ${mb.toFixed(0)} MB after loading`);
  if ((metrics.Nodes ?? 0) > 15_000) h.add('performance', `${metrics.Nodes} DOM nodes after loading`);
  if (s.unnamed.length) h.add('a11y', `${s.unnamed.length} button(s)/link(s) without an accessible name, e.g. ${s.unnamed.slice(0, 4).join(', ')}`);
  if (s.unlabeled.length) h.add('a11y', `${s.unlabeled.length} input(s) without a label, e.g. ${s.unlabeled.slice(0, 4).join(', ')}`);
  if (s.noAlt.length) h.add('a11y', `${s.noAlt.length} image(s) without an alt attribute, e.g. ${s.noAlt.slice(0, 2).map((x) => shortUrl(x)).join(', ')}`);
  if (s.overflow) h.add('layout', `At 1440px the page scrolls sideways (content ${s.overflow.scrollWidth}px wide), caused by ${s.overflow.culprits.join(', ') || 'unknown elements'}`);
  if (h.problems.some((p) => p.page === url && p.kind !== 'console-warning' && p.kind !== 'a11y')) {
    const shot = await h.shoot();
    for (const p of h.problems) if (p.page === url) p.shot ??= shot;
  }
  await h.act('resize to a 390px phone screen', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_200);
    const m = await scan(page);
    if (m.overflow) h.add('layout', `At 390px (phone) the page scrolls sideways (content ${m.overflow.scrollWidth}px wide), caused by ${m.overflow.culprits.join(', ') || 'unknown elements'}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(600);
    return m.overflow ? `overflows to ${m.overflow.scrollWidth}px` : 'fits';
  });

  stage('interact', `Trying ${url} with the mouse and keyboard`);
  await interact(h, pageInfo(url), focus);
  h.timings.push(`${url}: ${((Date.now() - t0) / 1000).toFixed(0)}s in all`);
}

// ── AI triage ──────────────────────────────────────────────────────────

const RULES = `You are a senior QA engineer triaging the raw findings of an automated, read-only bug hunt on the slshop.cloud shop admin dashboard. A logged-in Chromium with DevTools attached opened the pages, then tried tabs, filters, search, the next page, the first record, dialogs and the Tab key. Each finding says which page and which action it came after; [shot N] refers to the attached screenshots (N starts at 1).
Rules:
- Report ONLY bugs backed by the evidence below (a console line, a failed request with its status, text on screen, a measured value or a screenshot). Never invent bugs, pages, buttons or behaviour.
- A failed request to "API …" (the app's own backend) is ALWAYS an app bug, even when nothing on screen shows it: 5xx = major (a feature's data is missing), 4xx = major or minor by what it is for. Never exclude it as noise.
- A broken image of the shop's own content (product photo, logo, avatar, banner) is an app bug even when it is served from a storage host such as S3 or a CDN (ERR_BLOCKED_BY_ORB means the host did not return an image). Only images from ad/analytics/tracking hosts are noise.
- Mark third-party noise as excluded, not as bugs: analytics/tracking/pixels, ads, chat widgets, browser extensions, fonts and CDN hiccups, React/dev warnings that do not affect users. Separate real app bugs from test-environment noise (e.g. the robot's own clicks, a slow sandbox).
- Group findings with the same cause into one bug. Several failed requests to the same endpoint = one bug.
- severity: critical (page unusable / data at risk), major (a feature or data does not load or work), minor (works, but wrong in a visible way, accessibility barriers), cosmetic (layout/polish).
- steps: how a person reproduces it, starting on the bug's page (do not include opening it or logging in), one action each, on-screen names in single quotes, e.g. "Click 'Filter'", "Type 'a' in 'Search'", "Click the 'Paid' tab". Empty when it shows on page load.
- expected = the correct behaviour; actual = what happens; evidence = the exact console line / "503 GET API /…" / text seen.
- page = the dashboard path (e.g. /dashboard/pos). screenshot = the number of a screenshot that shows it, if any.
- In "reply": short Markdown — what was checked in one line, the bugs in a sentence each by severity, and a short "Excluded as noise" list. If no real bug was found, say "No bugs found" plainly and what was checked. No HTML.
Reply with JSON only: {"reply": "<markdown>", "bugs": [{"title": "…", "severity": "critical|major|minor|cosmetic", "page": "/dashboard/…", "steps": ["…"], "expected": "…", "actual": "…", "evidence": "…", "screenshot": 1}]}`;

function findingsText(h: Hunt, paths: string[]): string {
  const order: Kind[] = ['exception', 'failed-request', 'console-error', 'screen', 'broken-image', 'interaction', 'layout', 'performance', 'a11y', 'slow-request', 'console-warning'];
  const sorted = [...h.problems].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const lines = sorted.slice(0, 80).map((p) => `- [${p.kind}] ${p.page} after "${p.action}"${p.count > 1 ? ` (×${p.count})` : ''}${p.shot !== undefined && p.shot < MAX_IMAGES ? ` [shot ${p.shot + 1}]` : ''}: ${p.text}`);
  const info = paths.map((u) => pageInfo(u)).filter(Boolean).map((p) => `${p!.path} — ${nameOf(p!)}; tabs: ${p!.tabs.slice(0, 8).join(', ')}; buttons: ${p!.buttons.slice(0, 12).join(', ')}`);
  return [
    `PAGES (from the site map):\n${info.join('\n') || paths.join('\n')}`,
    `TIMINGS AND METRICS:\n${h.timings.join('\n')}`,
    `ACTIONS DONE:\n${h.actions.map((a) => `- ${a}`).join('\n')}`,
    `FINDINGS (${h.problems.length}):\n${lines.join('\n') || '(none)'}`,
    h.notes.length ? `NOTES: ${h.notes.join(' ')}` : '',
  ].filter(Boolean).join('\n\n').slice(0, 16_000);
}

function toBugs(raw: unknown, shots: string[], paths: string[]): Bug[] {
  if (!Array.isArray(raw)) return [];
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
  return raw.slice(0, 25).filter((b) => b && typeof b === 'object').map((b: Record<string, unknown>) => {
    const sev = s(b.severity).toLowerCase() as Severity;
    const n = Number(b.screenshot);
    return {
      title: s(b.title).slice(0, 200) || 'Untitled bug',
      severity: SEVERITIES.includes(sev) ? sev : 'minor',
      page: s(b.page).match(/\/dashboard[^\s'"<>]*/)?.[0] ?? paths[0],
      steps: (Array.isArray(b.steps) ? b.steps.map(s) : s(b.steps).split(/\n+/)).map((x) => x.replace(/^\s*(\d+[.)]|[•\-*])\s*/, '').trim()).filter(Boolean).slice(0, 20),
      expected: s(b.expected).slice(0, 600),
      actual: s(b.actual).slice(0, 600),
      evidence: s(b.evidence).slice(0, 600),
      screenshot: Number.isInteger(n) && n >= 1 && n <= shots.length ? shots[n - 1] : undefined,
    };
  }).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

/** Hunts for bugs on the pages `where` names; screenshots go to `shotsDir`. Throws a HuntError for a bad Where. */
export async function bugHunt(where: string, focus: string, shotsDir: string): Promise<HuntResult> {
  const paths = resolveWhere(where, focus);
  const started = Date.now();
  const stage = (s: Stage, d: string) => Object.assign(hunting, { stage: s, detail: d });
  const existing = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).map((f) => parseInt(f, 10)).filter((n) => n > 0) : [];
  const h = new Hunt(shotsDir, Math.max(0, ...existing) + 1);
  let session: Session | undefined;
  let rssPeak = process.memoryUsage().rss;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 1_000);
  try {
    stage('open', 'Starting the browser');
    session = await startSession();
    const context = await session.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await h.attach(page);
    for (const url of paths) {
      if (h.deadline - Date.now() < 15_000) { h.notes.push(`Stopped before ${url}: the 150s budget was used.`); break; }
      await huntPage(h, url, focus, stage);
    }
    await context.close().catch(() => {});
  } catch (e) {
    h.notes.push(`The browser stopped: ${(e as Error).message.split('\n')[0].slice(0, 160)}`);
  } finally {
    clearInterval(sampler);
    await session?.close().catch(() => {});
  }
  const browserSeconds = Math.round((Date.now() - started) / 1000);
  const checked = [
    `Pages: ${paths.join(', ')} (from "${where}")`,
    ...h.timings,
    ...h.actions,
    ...h.notes,
    `Browser time ${browserSeconds}s; ${h.problems.length} raw finding(s); ${h.shots.length} screenshot(s); server memory peak ${Math.round(rssPeak / 1048576)} MB.`,
  ];
  stage('ai', 'Asking the AI to triage the findings');
  const hidden = secrets();
  const user = `WHERE: ${where}${focus ? `\nFOCUS: ${focus}` : ''}\n\n${findingsText(h, paths)}`;
  const images = h.shots.slice(0, MAX_IMAGES);
  const parse = (text: string) => {
    const v = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '') as { reply?: unknown; bugs?: unknown };
    if (typeof v.reply !== 'string') throw new Error('no reply');
    return v;
  };
  try {
    const { value, provider, model } = await complete(redact(RULES, hidden), redact(user, hidden), parse, images.map((x) => x.b64), {
      only: ['openai', 'anthropic', 'gemini'], maxTokens: 5000, ignorePaidCap: true, models: { openai: superQaModel() },
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    checked.push(`AI triage ${seconds - browserSeconds}s; ${seconds}s in all.`);
    return { reply: value.reply as string, bugs: toBugs(value.bugs, images.map((x) => x.file), paths), checked, model: `${provider.name} · ${model}`, seconds };
  } catch (e) {
    const raw = h.problems.filter((p) => p.kind !== 'console-warning').slice(0, 25).map((p) => `- **${p.kind}** on \`${p.page}\` after _${p.action}_: ${p.text.replace(/[<>]/g, '')}`).join('\n');
    return { reply: `The AI could not triage the findings (${(e as Error).message.slice(0, 200)}). Raw findings:\n\n${raw || '_None._'}`, bugs: [], checked, seconds: Math.round((Date.now() - started) / 1000) };
  }
}

/** Each bug as a runnable test case: the steps reproduce it, the expected result is the correct behaviour. */
export function bugsToCases(bugs: Bug[]): TestCase[] {
  const priority: Record<Severity, string> = { critical: 'High', major: 'High', minor: 'Medium', cosmetic: 'Low' };
  return bugs.map((b, i) => ({
    id: `BUG-${i + 1}`, scenario: 'Bug hunt', title: b.title, type: 'Bug', priority: priority[b.severity],
    preconditions: `Found by the Assistant's bug hunt (${b.severity}). Evidence: ${b.evidence}`.slice(0, 1000),
    steps: b.steps, testData: '', expected: [b.expected || 'The page should load without errors.'], automation: '',
    url: /^\/dashboard/.test(b.page) ? b.page : '', reported: b.actual, manual: true,
  }));
}

/** The bugs as CSV (sheet columns plus Severity, Actual Result and Evidence). */
export function bugsCsv(bugs: Bug[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['TC ID', 'URL', 'Test Case', 'Severity', 'Test Steps', 'Expected Result', 'Actual Result', 'Evidence'];
  const rows = bugs.map((b, i) => [`BUG-${i + 1}`, b.page, b.title, b.severity, b.steps.map((s, k) => `${k + 1}. ${s}`).join('\n'), b.expected, b.actual, b.evidence]);
  return [head, ...rows].map((r) => r.map((v) => cell(v ?? '')).join(',')).join('\r\n');
}
