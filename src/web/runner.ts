import { newRunDir } from '../engine/context.js';
import { runCase } from '../engine/phrases/index.js';
import { writeReport } from '../engine/report.js';
import { startSession } from '../engine/session.js';
import { runs, suites, type Run } from './store.js';

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
    cancelled.delete(id);
    await session?.close().catch(() => undefined);
    run.finishedAt = new Date().toISOString();
    if (run.results.length) writeReport(run.results, runDir, suite.source.kind === 'sheet' ? suite.source.url : suite.name, suite.pagePath, new Date(run.createdAt));
    runs.save(run);
  }
}
