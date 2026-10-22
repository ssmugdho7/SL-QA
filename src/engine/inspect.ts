import type { Page } from 'playwright';
import { config } from './config.js';
import type { CaseContext } from './context.js';

/** What a page looks like on a plain logged-in visit: the UI, console and network health, before any test step runs. */
export interface Inspection {
  url: string;
  finalUrl: string;
  /** HTTP status of the page document itself. */
  status: number | null;
  loadMs: number;
  title: string;
  headings: string[];
  buttons: string[];
  /** Visible text of the page (main area, or body when there is no main), trimmed. */
  text: string;
  blank: boolean;
  /** Visible text that looks like an error ("Something went wrong", "NaN", "404"…). */
  errorTexts: string[];
  brokenImages: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  /** Requests on any origin that failed (status ≥ 400 or network error). */
  failedRequests: string[];
  slowRequests: string[];
  screenshot?: string;
}

const SLOW_MS = 3000;
const ERROR_TEXT = /something went wrong|went wrong|error occurred|failed to load|could not load|page not found|not found\b.*\b(?:page|product|order)|access denied|forbidden|\bNaN\b|\bundefined\b|\[object Object\]|\b(?:error|status|code)\s*:?\s*(?:404|500|502|503)\b/i;

export const absoluteUrl = (url: string) => (/^https?:/i.test(url) ? url : `${config.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`);
const shortUrl = (url: string) => url.replace(config.apiUrl, 'API ').replace(config.baseUrl, '');

/** Opens the URL in a fresh logged-in tab and records everything that is wrong with it. */
export async function inspectPage(t: CaseContext, url: string): Promise<Inspection> {
  const page = await t.newPage();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const failedRequests: string[] = [];
  const slowRequests: string[] = [];
  const started = new Map<object, number>();

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    if (m.type() === 'warning') consoleWarnings.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => consoleErrors.push(`Uncaught: ${e.message.slice(0, 300)}`));
  page.on('request', (r) => started.set(r, Date.now()));
  page.on('requestfinished', (r) => {
    const ms = Date.now() - (started.get(r) ?? Date.now());
    if (ms > SLOW_MS && !['image', 'font', 'media'].includes(r.resourceType())) slowRequests.push(`${(ms / 1000).toFixed(1)}s ${r.method()} ${shortUrl(r.url())}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${shortUrl(r.url())}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    // Navigations and polling cancelled by the page itself are not failures.
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) failedRequests.push(`network error (${why}) ${r.method()} ${shortUrl(r.url())}`);
  });

  const target = absoluteUrl(url);
  const t0 = Date.now();
  // Wait for the page to load, then give its network up to 15s to go quiet (live updates may never stop).
  const response = await page.goto(target, { waitUntil: 'load', timeout: 45_000 }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  const loadMs = Date.now() - t0;
  // Client-rendered pages often show their data a moment after the network goes quiet.
  await page.waitForTimeout(1500);

  const dom = await read(page).catch(() => ({ title: '', headings: [], buttons: [], text: '', brokenImages: [] as string[] }));
  const errorTexts = [...new Set(dom.text.split('\n').map((l) => l.trim()).filter((l) => l.length < 160 && ERROR_TEXT.test(l)))].slice(0, 8);

  const inspection: Inspection = {
    url: target,
    finalUrl: page.url(),
    status: response?.status() ?? null,
    loadMs,
    title: dom.title,
    headings: dom.headings,
    buttons: dom.buttons,
    text: dom.text.slice(0, 20_000),
    blank: dom.text.replace(/\s+/g, '').length < 20,
    errorTexts,
    brokenImages: dom.brokenImages,
    consoleErrors: [...new Set(consoleErrors)],
    consoleWarnings: [...new Set(consoleWarnings)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)],
    slowRequests: [...new Set(slowRequests)],
  };
  await t.shot('page inspection', page);
  inspection.screenshot = t.screenshots.at(-1);
  await page.close().catch(() => undefined);
  return inspection;
}

async function read(page: Page) {
  return page.evaluate(() => {
    const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const root = (document.querySelector('main') ?? document.body) as HTMLElement;
    const texts = (sel: string) => [...new Set([...document.querySelectorAll(sel)].filter(visible).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 80))];
    return {
      title: document.title,
      headings: texts('h1, h2, h3').slice(0, 20),
      buttons: texts('button, [role=button], [role=tab], a.button').slice(0, 60),
      text: root?.innerText ?? '',
      brokenImages: [...document.images].filter((i) => visible(i) && i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src).slice(0, 10),
    };
  });
}

/** One line per problem the inspection found, in plain words. Empty when the page looks healthy. */
export function healthProblems(i: Inspection, opts: { appOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  // Third-party requests (analytics, fonts, chat widgets) failing are noise for a verdict, but still listed in Page health.
  const failed = opts.appOnly ? i.failedRequests.filter((r) => / (?:API )?\//.test(r)) : i.failedRequests;
  if (i.status && i.status >= 400) out.push(`the page itself returned HTTP ${i.status}`);
  if (!i.status) out.push('the page did not finish loading within 45s');
  if (/\/login/.test(new URL(i.finalUrl).pathname) && !/\/login/.test(new URL(i.url).pathname)) out.push('the page redirected to the login screen');
  if (i.blank) out.push('the page is blank');
  if (i.errorTexts.length) out.push(`the page shows error text: ${i.errorTexts.map((x) => `"${x}"`).join(', ')}`);
  if (i.consoleErrors.length) out.push(`${i.consoleErrors.length} console error(s), first: ${i.consoleErrors[0].slice(0, 160)}`);
  if (failed.length) out.push(`${failed.length} failed request(s): ${failed.slice(0, 3).join('; ')}`);
  if (i.brokenImages.length) out.push(`${i.brokenImages.length} broken image(s)`);
  if (i.slowRequests.length) out.push(`${i.slowRequests.length} slow request(s) (>3s): ${i.slowRequests.slice(0, 2).join('; ')}`);
  return out;
}
