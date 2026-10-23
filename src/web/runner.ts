import { discoverPages, loadSiteMap, saveSiteMap, siteCases } from '../engine/apps/slshop/crawl.js';
import { newRunDir } from '../engine/context.js';
import { reloadPages } from '../engine/pages.js';
import { runCase } from '../engine/phrases/index.js';
import { writeReport } from '../engine/report.js';
import { startSession } from '../engine/session.js';
import { newId, runs, suites, type Run, type Suite } from './store.js';

/**
 * Runs one test run at a time (tests change shared store data, so they must not overlap).
 * Queued runs wait their turn; the run file is updated after every case so the page can show progress.
 */
const queue: string[] = [];
let busy = false;
const cancelled = new Set<string>();

export function enqueue(run: Run): void {
  runs.save(run);
  queue.push(run.id);
  void pump();
}

export function cancel(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  if (run.status === 'queued') {
    queue.splice(queue.indexOf(id), 1);
    runs.save({ ...run, status: 'cancelled', finishedAt: new Date().toISOString() });
  } else if (run.status === 'running') cancelled.add(id);
}

/** Runs left "running" by a server restart can never finish; mark them so. */
export function recover(): void {
  for (const r of runs.all()) {
    if (r.status === 'running' || r.status === 'queued') runs.save({ ...r, status: 'failed', error: 'The server restarted while this run was in progress.', finishedAt: r.finishedAt ?? new Date().toISOString() });
  }
}

async function pump(): Promise<void> {
  if (busy) return;
  const id = queue.shift();
  if (!id) return;
  busy = true;
  try {
    await execute(id);
  } finally {
    busy = false;
    void pump();
  }
}

async function execute(id: string): Promise<void> {
  let run = runs.get(id)!;
  const suite = suites.get(run.suiteId);
  if (!suite) {
    runs.save({ ...run, status: 'failed', error: 'The suite was deleted.' });
    return;
  }
  run = { ...run, status: 'running', startedAt: new Date().toISOString(), results: [] };
  runs.save(run);
  const runDir = newRunDir(id);
  const selected = suite.cases.filter((c) => run.caseIds.includes(c.id));

  let session;
  // Whole-dashboard checks are read-only: live AI stays off for them, since a repair could pick an unsafe control.
  // Runs never overlap (see pump), so switching the setting for this run's duration is safe.
  const aiLive = process.env.AI_LIVE;
  if (suite.source.kind === 'site') process.env.AI_LIVE = 'off';
  try {
    session = await startSession();
    for (const tc of selected) {
      if (cancelled.has(id)) break;
      run.current = { caseId: tc.id, step: 'Preparing test data…' };
      runs.save(run);
      let lastWrite = 0;
      const result = await runCase(tc, session, runDir, suite.pagePath, (step) => {
        run.current = { caseId: tc.id, step };
        // Throttle progress writes; the page polls every second or so.
        if (Date.now() - lastWrite > 700) {
          lastWrite = Date.now();
          runs.save(run);
        }
      });
      run.results.push(result);
      runs.save(run);
    }
    run.current = undefined;
    run.status = cancelled.has(id) ? 'cancelled' : 'done';
  } catch (e) {
    run.status = 'failed';
    run.error = (e as Error).message.split('\n')[0];
  } finally {
    if (suite.source.kind === 'site') aiLive === undefined ? delete process.env.AI_LIVE : (process.env.AI_LIVE = aiLive);
    cancelled.delete(id);
    await session?.close().catch(() => undefined);
    run.finishedAt = new Date().toISOString();
    if (run.results.length) writeReport(run.results, runDir, suite.source.kind === 'sheet' ? suite.source.url : suite.name, suite.pagePath, new Date(run.createdAt));
    runs.save(run);
  }
}

// ── Whole-dashboard check: crawl in the background, then build the suite ──

export const SITE_SUITE_NAME = 'Whole dashboard (auto)';

/** The crawl in progress (one at a time), or how the last one ended. Kept in memory: a restart forgets it. */
export const crawlState: { running: boolean; startedAt?: string; pages: number; last?: string; error?: string } = { running: false, pages: 0 };

/** Creates the whole-dashboard suite, or refreshes its cases from the site map. Cases added or edited here and rows deleted here are kept. */
export function syncSiteSuite(): Suite | null {
  const map = loadSiteMap();
  if (!map) return null;
  const now = new Date().toISOString();
  const existing = suites.all().find((s) => s.source.kind === 'site');
  if (!existing) {
    const s: Suite = { id: newId(), name: SITE_SUITE_NAME, source: { kind: 'site' }, pagePath: '/dashboard', cases: siteCases(map), syncedAt: map.generatedAt, createdAt: now };
    suites.save(s);
    return s;
  }
  const removed = new Set(existing.removed ?? []);
  const fresh = siteCases(map).filter((c) => !removed.has(c.id));
  const kept = new Map(existing.cases.filter((c) => c.manual || c.edited).map((c) => [c.id, c]));
  const s = { ...existing, cases: [...fresh.map((c) => kept.get(c.id) ?? c), ...[...kept.values()].filter((c) => !fresh.some((x) => x.id === c.id))], syncedAt: map.generatedAt };
  suites.save(s);
  return s;
}

/** Starts a read-only crawl of the dashboard unless one is running; the suite is refreshed when it ends. */
export function startCrawl(): boolean {
  if (crawlState.running) return false;
  Object.assign(crawlState, { running: true, startedAt: new Date().toISOString(), pages: 0, error: undefined });
  void (async () => {
    let session;
    try {
      session = await startSession();
      const map = await discoverPages(session, { onPage: (_, n) => (crawlState.pages = n) });
      saveSiteMap(map);
      reloadPages();
      syncSiteSuite();
    } catch (e) {
      crawlState.error = (e as Error).message.split('\n')[0];
    } finally {
      await session?.close().catch(() => undefined);
      Object.assign(crawlState, { running: false, last: new Date().toISOString() });
    }
  })();
  return true;
}
