import fs from 'fs';
import http from 'http';
import path from 'path';
import { marked } from 'marked';
import { config } from '../engine/config.js';
import { casesFromSheet } from '../engine/sources/google-sheet.js';
import { casesFromUpload } from '../engine/sources/upload.js';
import { rowUrl, splitList, type TestCase } from '../engine/sources/cases.js';
import { parseBugText } from '../engine/sources/bug-text.js';
import { EXAMPLE_CASES, EXAMPLE_SUITE_NAME, exampleCsv } from './example.js';
import { cancel, crawlState, enqueue, recover, startCrawl, syncSiteSuite } from './runner.js';
import { loadSiteMap, siteCases, siteMapAge } from '../engine/apps/slshop/crawl.js';
import { knownPages } from '../engine/pages.js';
import { handleChat } from './chat.js';
import { guidePage } from './guide.js';
import { newId, runs, suites, uploadsDir, type Run, type Suite } from './store.js';
import { aiKeysPage, examplePage, helpPage, homePage, issueFormPage, layout, notFound, reportPage, rewritesPage, runPage, runsPage, SAMPLE_CSV, suitePage, type RewriteRow, type SiteInfo } from './views.js';
import { previewCase } from '../engine/phrases/index.js';
import { expectClauses, stepClauses } from '../engine/phrases/split.js';

const stepPieces = (sentence: string) => stepClauses(sentence).map((c) => c.text);
import { status as aiStatus, resetCoolDowns, paidDailyLimit, usage as aiUsage } from '../engine/ai/providers.js';
import { aiProvider, keyOf, lookup, pageKeyOf, loadTranslations, saveTranslations, setStatus, translate, type Kind } from '../engine/ai/translate.js';

type Form = { fields: Record<string, string[]>; files: Record<string, { name: string; data: Buffer }> };

const field = (f: Form, k: string) => (f.fields[k]?.[0] ?? '').trim();

async function body(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new Error('Upload is too large (20 MB max).');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses url-encoded and multipart/form-data bodies. */
async function parseForm(req: http.IncomingMessage): Promise<Form> {
  const raw = await body(req);
  const type = req.headers['content-type'] ?? '';
  const form: Form = { fields: {}, files: {} };
  const add = (k: string, v: string) => (form.fields[k] ??= []).push(v);
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) add(k, v);
    return form;
  }
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
  if (!boundary) return form;
  const sep = Buffer.from(`--${boundary}`);
  let pos = raw.indexOf(sep);
  while (pos >= 0) {
    const next = raw.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = raw.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const content = part.subarray(headEnd + 4);
    const name = head.match(/name="([^"]*)"/)?.[1];
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    if (name && filename !== undefined) {
      if (filename) form.files[name] = { name: path.basename(filename), data: content };
    } else if (name) add(name, content.toString('utf8'));
    pos = next;
  }
  return form;
}

function send(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res: http.ServerResponse, to: string): void {
  res.writeHead(303, { Location: to });
  res.end();
}

function sendFile(res: http.ServerResponse, file: string, type: string, download?: string): void {
  if (!fs.existsSync(file)) return send(res, 404, notFound());
  res.writeHead(200, { 'Content-Type': type, ...(download ? { 'Content-Disposition': `attachment; filename="${download}"` } : {}) });
  fs.createReadStream(file).pipe(res);
}

/** Optional shared password (HTTP basic auth), set with APP_PASSWORD. */
function authorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!config.appPassword) return true;
  const [, encoded = ''] = (req.headers.authorization ?? '').split(' ');
  const password = Buffer.from(encoded, 'base64').toString('utf8').split(':').slice(1).join(':');
  if (password === config.appPassword) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SL QA"' });
  res.end('Login required');
  return false;
}

function lastRunBySuite(): Map<string, Run> {
  const last = new Map<string, Run>();
  for (const r of runs.all()) if (!last.has(r.suiteId)) last.set(r.suiteId, r);
  return last;
}

async function loadCases(source: Suite['source'], upload?: { name: string; data: Buffer }): Promise<TestCase[]> {
  if (source.kind === 'manual') return [];
  if (source.kind === 'site') {
    const map = loadSiteMap();
    if (!map) throw new Error('There is no site map yet. Use "Check the whole dashboard" on the Suites page to crawl it.');
    return siteCases(map);
  }
  if (source.kind === 'sheet') return casesFromSheet(source.url);
  const data = upload?.data ?? fs.readFileSync(path.join(uploadsDir(), source.file));
  return casesFromUpload(source.file, data);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Health check for hosts like Render; stays open even when APP_PASSWORD is set.
  if (req.url?.split('?')[0] === '/healthz') return void res.end('ok');
  if (!authorized(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://local');
  const p = url.pathname;
  const post = req.method === 'POST';
  let m: RegExpMatchArray | null;

  if (p === '/chat' || p.startsWith('/chat/')) {
    if (await handleChat(req, res, p, { send: (status, html) => send(res, status, html), redirect: (to) => redirect(res, to), form: () => parseForm(req) })) return;
  }

  if (p === '/' && !post) return send(res, 200, homePage(suites.all(), lastRunBySuite(), undefined, undefined, siteInfo(url.searchParams.get('msg') ?? undefined)));

  // "Check the whole dashboard": crawl when the site map is missing, over 7 days old or on request, else (re)build the suite from it.
  if (p === '/site' && post) {
    const form = await parseForm(req);
    const map = loadSiteMap();
    if (crawlState.running) return redirect(res, `/?msg=${encodeURIComponent('The dashboard is being crawled; the suite is updated when it ends.')}#site`);
    if (field(form, 'recrawl') === '1' || !map || siteMapAge(map) > 7) {
      startCrawl();
      return redirect(res, `/?msg=${encodeURIComponent('Crawling the dashboard (read-only). It takes about 5 minutes; this page refreshes itself.')}#site`);
    }
    const s = syncSiteSuite()!;
    return redirect(res, `/suites/${s.id}?msg=${encodeURIComponent(`${plural(s.cases.length, 'page')} from the site map of ${new Date(map.generatedAt).toLocaleDateString('en-GB', { dateStyle: 'medium' })}. Tick the ones to check and press Run.`)}`);
  }

  if (p === '/suites' && post) {
    const form = await parseForm(req);
    const name = field(form, 'name') || 'Untitled suite';
    const kind = field(form, 'kind') || (form.files.file ? 'upload' : field(form, 'manual') === '1' ? 'manual' : 'sheet');
    const sheet = field(form, 'url');
    const file = form.files.file;
    const pagePath = field(form, 'pagePath') || '/dashboard/products';
    try {
      if (kind === 'sheet' && !sheet) throw new Error('Paste the Google Sheet link.');
      if (kind === 'sheet' && !/docs\.google\.com\/spreadsheets\/d\//.test(sheet)) throw new Error('That is not a Google Sheets link. Open the sheet in your browser and copy the address bar (it starts with https://docs.google.com/spreadsheets/d/…).');
      if (kind === 'upload' && !file) throw new Error('Choose a .csv or .xlsx file to upload.');
      if (!/^\/\S*$/.test(pagePath)) throw new Error('The start page should begin with a slash, for example /dashboard/products.');
      const id = newId();
      let source: Suite['source'];
      if (kind === 'manual') source = { kind: 'manual' };
      else if (kind === 'upload') {
        const stored = `${id}-${file!.name.replace(/[^\w.-]+/g, '_')}`;
        fs.writeFileSync(path.join(uploadsDir(), stored), file!.data);
        source = { kind: 'upload', file: stored };
      } else source = { kind: 'sheet', url: sheet };
      const cases = await loadCases(source, file);
      if (!cases.length && kind !== 'manual') throw new Error('The sheet was read, but no rows with an Expected Result (or URL) were found. Check the first row holds the column names.');
      const now = new Date().toISOString();
      suites.save({ id, name, source, pagePath, cases, syncedAt: now, createdAt: now });
      return redirect(res, kind === 'manual' ? `/suites/${id}/issues/new` : `/suites/${id}`);
    } catch (e) {
      // Show the form again with what was typed (a chosen file can't be kept by the browser).
      return send(res, 400, homePage(suites.all(), lastRunBySuite(), (e as Error).message, { kind, name: field(form, 'name'), url: sheet, pagePath }, siteInfo()));
    }
  }

  if ((m = p.match(/^\/suites\/([\w-]+)$/)) && !post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const { unknown, pending } = rewriteState(s);
    return send(res, 200, suitePage(s, runs.forSuite(s.id), url.searchParams.get('msg') ?? undefined, { unknown: unknown.length, pending: pending.length, provider: aiProvider() }));
  }

  // AI rewrites for sentences the rules do not understand: list, suggest, review.
  if ((m = p.match(/^\/suites\/([\w-]+)\/rewrites$/)) && !post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const { unknown, rows } = rewriteState(s);
    return send(res, 200, rewritesPage(s, rows, unknown, aiProvider(), url.searchParams.get('msg') ?? undefined));
  }

  if ((m = p.match(/^\/suites\/([\w-]+)\/rewrites\/suggest$/)) && post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    if (!aiProvider()) return redirect(res, `/suites/${s.id}/rewrites?msg=${encodeURIComponent('No AI key is set. Add a free key such as GEMINI_API_KEY or GROQ_API_KEY to .env and restart SL QA (see Full reference → AI keys).')}`);
    const { unknown } = rewriteState(s);
    const all = loadTranslations();
    let made = 0;
    const errors: string[] = [];
    // A handful at a time keeps the page responsive and the cost visible; press again for more.
    for (const u of unknown.slice(0, 25)) {
      const tc = s.cases.find((c) => c.id === u.cases[0])!;
      try {
        const t = await translate(u.kind as Kind, u.text, { page: tc.url || s.pagePath, title: tc.title, steps: tc.steps, expected: tc.expected });
        if (t) {
          all[pageKeyOf(u.kind as Kind, tc.url || s.pagePath, u.text)] = t;
          made++;
        }
      } catch (e) {
        errors.push((e as Error).message);
        // Every provider failed (bad keys, quotas, paid cap): later sentences would fail the same way.
        if (/Every AI provider failed|No AI key/.test((e as Error).message)) break;
      }
    }
    saveTranslations(all);
    const more = unknown.length > 25 ? ` ${unknown.length - 25} more are left; press Suggest again.` : '';
    const msg = errors.length ? `Made ${made} suggestion(s); ${errors.length} failed: ${errors[0].slice(0, 160)}` : `Made ${made} suggestion(s). Review them below.${more}`;
    return redirect(res, `/suites/${s.id}/rewrites?msg=${encodeURIComponent(msg)}`);
  }

  if ((m = p.match(/^\/suites\/([\w-]+)\/rewrites$/)) && post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const form = await parseForm(req);
    const action = field(form, 'action');
    if (action === 'approve-all') {
      const { pending } = rewriteState(s);
      for (const r of pending) setStatus(r.key, 'approved');
      return redirect(res, `/suites/${s.id}/rewrites?msg=${encodeURIComponent(`Approved ${pending.length} rewrite(s).`)}`);
    }
    const key = field(form, 'key');
    const lines = (form.fields.lines?.[0] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'suggested';
    const t = setStatus(key, status, lines);
    return redirect(res, `/suites/${s.id}/rewrites?msg=${encodeURIComponent(t ? `${status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Moved back to review'}: “${t.source.slice(0, 60)}”` : 'That rewrite no longer exists.')}`);
  }

  if ((m = p.match(/^\/suites\/([\w-]+)\/issues\/(new|[^/]+\/edit)$/)) && !post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const editing = m[2] === 'new' ? undefined : s.cases.find((c) => c.id === decodeURIComponent(m![2].replace(/\/edit$/, '')));
    if (m[2] !== 'new' && !editing) return send(res, 404, notFound());
    return send(res, 200, issueFormPage(s, editing, url.searchParams.get('msg') ?? undefined, undefined, pageOptions()));
  }

  if ((m = p.match(/^\/suites\/([\w-]+)\/issues(?:\/([^/]+))?(?:\/(delete))?$/)) && post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const form = await parseForm(req);
    const back = (msg: string) => redirect(res, `/suites/${s.id}?msg=${encodeURIComponent(msg)}`);
    const targetId = m[2] ? decodeURIComponent(m[2]) : undefined;

    // Delete one, the ticked ones, or all.
    if (m[3] === 'delete' || field(form, 'action') === 'delete') {
      const all = field(form, 'scope') === 'all';
      const ids = new Set(all ? s.cases.map((c) => c.id) : targetId ? [targetId] : form.fields.case ?? []);
      if (!ids.size) return back('Tick the cases to delete first.');
      const gone = s.cases.filter((c) => ids.has(c.id));
      // Sheet rows would come back on the next re-read, so remember them as removed.
      const removed = [...new Set([...(s.removed ?? []), ...gone.filter((c) => !c.manual).map((c) => c.id)])];
      suites.save({ ...s, cases: s.cases.filter((c) => !ids.has(c.id)), removed });
      return back(`Deleted ${gone.length} case${gone.length === 1 ? '' : 's'}.`);
    }

    // "Fill the form from it": read a pasted bug report into the fields, and show them for checking before saving.
    if (field(form, 'then') === 'parse') {
      const text = field(form, 'paste');
      const editing = targetId ? s.cases.find((c) => c.id === targetId) : undefined;
      if (!text) return send(res, 422, issueFormPage(s, editing, 'Paste a bug report first.', undefined, pageOptions()));
      const bug = parseBugText(text);
      const filled = { ...(editing ?? {}), id: field(form, 'id') || editing?.id || '', title: bug.title, url: bug.url, reported: bug.reported, preconditions: bug.preconditions, priority: field(form, 'priority'), scenario: field(form, 'scenario'),
        steps: [bug.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')], expected: [bug.expected.map((x) => `• ${x}`).join('\n')] } as TestCase;
      const found = [bug.steps.length && `${bug.steps.length} steps`, bug.expected.length && `${bug.expected.length} expected result${bug.expected.length === 1 ? '' : 's'}`, bug.url && `page ${bug.url}`].filter(Boolean).join(', ');
      const msg = found ? `Read the report: ${found}. Check the fields below, then save.` : 'Could not find the sections in that text. Look for "Steps to reproduce:" and "Expected result:" headings, or fill the fields by hand.';
      return send(res, 200, issueFormPage(s, editing, msg, filled, pageOptions()));
    }

    // Add or edit one issue.
    if (targetId && !s.cases.some((c) => c.id === targetId)) return back(`${targetId} no longer exists.`);
    const tc = issueFromForm(form, s, targetId);
    if (typeof tc === 'string') {
      // Show the form again with what was typed, so nothing is lost.
      const typed = { ...s.cases.find((c) => c.id === targetId), title: field(form, 'title'), url: field(form, 'url'), reported: field(form, 'actual'),
        expected: [field(form, 'expected')], steps: [field(form, 'steps')], priority: field(form, 'priority'), scenario: field(form, 'scenario'), preconditions: field(form, 'preconditions') };
      return send(res, 422, issueFormPage(s, targetId ? (typed as TestCase) : undefined, tc, { ...typed, id: field(form, 'id') } as TestCase, pageOptions()));
    }
    const cases = targetId ? s.cases.map((c) => (c.id === targetId ? tc : c)) : [...s.cases, tc];
    suites.save({ ...s, cases, removed: (s.removed ?? []).filter((id) => id !== tc.id) });
    if (field(form, 'then') === 'another') return redirect(res, `/suites/${s.id}/issues/new?msg=${encodeURIComponent(`Added ${tc.id}. Add the next one.`)}`);
    if (field(form, 'then') === 'run') {
      const run: Run = { id: newId(), suiteId: s.id, suiteName: s.name, caseIds: [tc.id], status: 'queued', results: [], createdAt: new Date().toISOString() };
      enqueue(run);
      return redirect(res, `/runs/${run.id}`);
    }
    return back(targetId ? `Saved ${tc.id}.` : `Added ${tc.id}.`);
  }

  if ((m = p.match(/^\/suites\/([\w-]+)\/(run|sync|settings|delete)$/)) && post) {
    const s = suites.get(m[1]);
    if (!s) return send(res, 404, notFound('suite'));
    const form = await parseForm(req);
    if (m[2] === 'run') {
      // Run exactly what is ticked; a chosen scenario narrows the ticked cases further.
      const scenario = field(form, 'scenario');
      let ids = form.fields.case ?? [];
      if (scenario) ids = ids.filter((id) => s.cases.find((c) => c.id === id)?.scenario === scenario);
      if (!ids.length) return redirect(res, `/suites/${s.id}?msg=${encodeURIComponent(scenario ? `None of the ticked cases are in "${scenario}". Tick some, or choose "All scenarios".` : 'Tick at least one case to run.')}`);
      const run: Run = { id: newId(), suiteId: s.id, suiteName: s.name, caseIds: ids, status: 'queued', results: [], createdAt: new Date().toISOString() };
      enqueue(run);
      return redirect(res, `/runs/${run.id}`);
    }
    if (m[2] === 'sync' && s.source.kind === 'site') {
      const fresh = syncSiteSuite();
      return redirect(res, `/suites/${s.id}?msg=${encodeURIComponent(fresh ? `Rebuilt ${plural(fresh.cases.length, 'case')} from the site map.` : 'There is no site map yet.')}`);
    }
    if (m[2] === 'sync') {
      try {
        const removed = new Set(s.removed ?? []);
        const fromSheet = (await loadCases(s.source)).filter((c) => !removed.has(c.id));
        // Issues added or edited in the app win over the sheet.
        const kept = new Map(s.cases.filter((c) => c.manual || c.edited).map((c) => [c.id, c]));
        const merged = fromSheet.map((c) => kept.get(c.id) ?? c);
        const manual = [...kept.values()].filter((c) => !fromSheet.some((x) => x.id === c.id));
        suites.save({ ...s, cases: [...merged, ...manual], syncedAt: new Date().toISOString() });
        const skipped = removed.size ? ` (${removed.size} deleted here stay hidden)` : '';
        return redirect(res, `/suites/${s.id}?msg=${encodeURIComponent(`Re-read ${fromSheet.length} rows from the sheet${skipped}; kept ${kept.size} added or edited here.`)}`);
      } catch (e) {
        return redirect(res, `/suites/${s.id}?msg=${encodeURIComponent((e as Error).message)}`);
      }
    }
    if (m[2] === 'settings') {
      suites.save({ ...s, pagePath: field(form, 'pagePath') || s.pagePath });
      return redirect(res, `/suites/${s.id}?msg=Saved.`);
    }
    suites.remove(s.id);
    return redirect(res, '/');
  }

  if (p === '/settings/ai' && !post) {
    return send(res, 200, aiKeysPage(aiStatus(), { used: aiUsage().paidCalls, limit: paidDailyLimit() }, url.searchParams.get('msg') ?? undefined));
  }

  if (p === '/settings/ai/reset' && post) {
    resetCoolDowns();
    return redirect(res, `/settings/ai?msg=${encodeURIComponent('Skipped providers will be tried again on the next request.')}`);
  }

  if (p === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  if (p === '/guide' && !post) return send(res, 200, guidePage());
  if (p === '/help' && !post) return send(res, 200, helpPage());

  if (p === '/help/sample.csv' || p === '/help/example.csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sl-qa-${p.includes('example') ? 'example' : 'sample'}.csv"` });
    return void res.end(`\uFEFF${p.includes('example') ? exampleCsv() : SAMPLE_CSV}`);
  }

  if (p === '/example' && !post) return send(res, 200, examplePage(suites.all().find((s) => s.name === EXAMPLE_SUITE_NAME)?.id));

  // The help page's worked example: one click makes a suite with the example cases (or reopens it).
  if (p === '/help/example' && post) {
    const existing = suites.all().find((s) => s.name === EXAMPLE_SUITE_NAME);
    if (existing) {
      // Put back any example case that was deleted; cases the person changed or added themselves are kept.
      const missing = EXAMPLE_CASES.filter((x) => !existing.cases.some((c) => c.id === x.id));
      suites.save({ ...existing, cases: [...structuredClone(missing), ...existing.cases] });
      const msg = missing.length ? `Put back ${missing.length} example case${missing.length === 1 ? '' : 's'} you had deleted.` : 'You already have the example suite; here it is.';
      return redirect(res, `/suites/${existing.id}?msg=${encodeURIComponent(`${msg} Your own changes are kept.`)}`);
    }
    const id = newId();
    const now = new Date().toISOString();
    suites.save({ id, name: EXAMPLE_SUITE_NAME, source: { kind: 'manual' }, pagePath: '/dashboard', cases: structuredClone(EXAMPLE_CASES), syncedAt: now, createdAt: now });
    return redirect(res, `/suites/${id}?msg=${encodeURIComponent('Example suite created with 4 cases. Click ▶ Run all 4, then follow the guide.')}`);
  }

  if (p === '/runs' && !post) return send(res, 200, runsPage(runs.all()));

  if ((m = p.match(/^\/runs\/([\w-]+)$/)) && !post) {
    const run = runs.get(m[1]);
    if (!run) return send(res, 404, notFound('run'));
    // Earlier finished runs of the suite, newest first: each case is compared with its own most recent earlier result.
    const earlier = runs.forSuite(run.suiteId).filter((r) => r.createdAt < run.createdAt && r.status === 'done');
    return send(res, 200, runPage(run, earlier));
  }

  if ((m = p.match(/^\/runs\/([\w-]+)\/delete$/)) && post) {
    const run = runs.get(m[1]);
    if (run && (run.status === 'running' || run.status === 'queued')) return redirect(res, `/runs/${m[1]}`);
    runs.remove(m[1]);
    return redirect(res, run ? `/suites/${run.suiteId}?msg=${encodeURIComponent('Run and its report deleted.')}` : '/runs');
  }

  if ((m = p.match(/^\/runs\/([\w-]+)\/cancel$/)) && post) {
    cancel(m[1]);
    return redirect(res, `/runs/${m[1]}`);
  }

  if ((m = p.match(/^\/runs\/([\w-]+)\/report$/))) {
    const file = path.join(config.runsDir, m[1], 'report.md');
    if (!fs.existsSync(file)) return send(res, 404, notFound('report'));
    // Screenshot links in the Markdown are relative to the run folder.
    const html = (await marked.parse(fs.readFileSync(file, 'utf8'))).replace(/(href|src)="shots\//g, `$1="/runs/${m[1]}/shots/`);
    const run = runs.get(m[1]);
    return send(res, 200, reportPage(m[1], html, run));
  }

  if ((m = p.match(/^\/runs\/([\w-]+)\/report\.md$/))) {
    return sendFile(res, path.join(config.runsDir, m[1], 'report.md'), 'text/markdown; charset=utf-8', `qa-report-${m[1]}.md`);
  }

  if ((m = p.match(/^\/runs\/([\w-]+)\/shots\/([\w.-]+\.png)$/))) {
    return sendFile(res, path.join(config.runsDir, m[1], 'shots', m[2]), 'image/png');
  }

  return send(res, 404, notFound());
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the Suites page shows about the whole-dashboard check: the site map, a crawl in progress, the suite. */
function siteInfo(msg?: string): SiteInfo {
  const map = loadSiteMap();
  return {
    generatedAt: map?.generatedAt, pages: map?.pages.filter((x) => !x.redirectsTo).length ?? 0, stale: siteMapAge(map) > 7,
    crawling: crawlState.running ? { pages: crawlState.pages, startedAt: crawlState.startedAt! } : undefined,
    error: crawlState.error, suiteId: suites.all().find((x) => x.source.kind === 'site')?.id, msg,
  };
}

/** Known dashboard pages for the Page link picker: path and "Group › Label". */
const pageOptions = () => knownPages().map((x) => ({ path: x.path, name: [x.group, x.label].filter(Boolean).join(' › ') }));

/** Sentences in a suite no rule understands, and the AI rewrites that exist for this suite's sentences. */
function rewriteState(s: Suite): { unknown: { kind: string; text: string; cases: string[] }[]; rows: RewriteRow[]; pending: RewriteRow[] } {
  const all = loadTranslations();
  const unknownMap = new Map<string, { kind: string; text: string; cases: string[] }>();
  const rowMap = new Map<string, RewriteRow>();
  for (const c of s.cases) {
    const p = previewCase(c);
    // The original wording of every sentence and claim (a claim shown as its rewrite is looked up by its source).
    const sentences = [
      ...c.steps.map((x) => ({ kind: 'step' as const, text: x.trim().replace(/\.$/, '') })),
      ...c.steps.flatMap((x) => stepPieces(x)).map((x) => ({ kind: 'step' as const, text: x })),
      ...c.expected.flatMap((e) => expectClauses(e)).map((x) => ({ kind: 'expect' as const, text: x })),
    ];
    // Rewrites are saved per page (newer) or per sentence (older); the case's page picks the right one.
    const page = c.url || s.pagePath;
    for (const u of [...p.unknown, ...sentences]) {
      const hit = lookup(all, u.kind, u.text, page);
      if (hit) {
        const key = hit.key;
        const row = rowMap.get(key) ?? { key, t: hit.t, cases: [] };
        if (!row.cases.includes(c.id)) row.cases.push(c.id);
        rowMap.set(key, row);
      }
    }
    for (const u of p.unknown) {
      if (lookup(all, u.kind, u.text, page)) continue;
      const key = keyOf(u.kind, u.text);
      const e = unknownMap.get(key) ?? { kind: u.kind, text: u.text, cases: [] };
      if (!e.cases.includes(c.id)) e.cases.push(c.id);
      unknownMap.set(key, e);
    }
  }
  const rows = [...rowMap.values()];
  return { unknown: [...unknownMap.values()], rows, pending: rows.filter((r) => r.t.status === 'suggested') };
}

/** Builds a test case from the add/edit issue form, or returns what is missing. */
function issueFromForm(form: Form, s: Suite, editingId?: string): TestCase | string {
  const title = field(form, 'title');
  const url = field(form, 'url');
  const expected = field(form, 'expected');
  if (!title) return 'Give the case a short title.';
  if (!url && s.source.kind === 'manual') return 'Enter the page link where the problem happens.';
  if (url && !/^(https?:\/\/|\/)/.test(url)) return 'The page link should start with https:// or /dashboard/…';
  if (!expected) return 'Describe what should happen (Expected result).';
  const wanted = field(form, 'id').toUpperCase().replace(/\s+/g, '-');
  const taken = new Set(s.cases.map((c) => c.id).filter((id) => id !== editingId));
  if (wanted && taken.has(wanted)) return `ID ${wanted} is already used in this suite. Pick another, or leave it empty.`;
  let id = wanted || editingId || '';
  for (let n = s.cases.length + 1; !id || taken.has(id); n++) id = `ISSUE-${n}`;
  const lines = (text: string) => text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const existing = s.cases.find((c) => c.id === editingId);
  return {
    id,
    scenario: field(form, 'scenario'),
    title,
    type: existing?.type ?? 'Bug',
    priority: field(form, 'priority'),
    preconditions: field(form, 'preconditions'),
    // Accept "1. step" or plain lines; store bullets the same way the sheet reader does.
    steps: splitList(lines(field(form, 'steps')).join('\n'), /^\d+[.)]\s*/),
    testData: existing?.testData ?? '',
    expected: splitList(lines(field(form, 'expected')).join('\n'), /^[•\-*]\s*/),
    automation: existing?.automation ?? '',
    url: url ? rowUrl({ URL: url }) || url : '',
    reported: field(form, 'actual'),
    manual: existing ? existing.manual : true,
    edited: existing && !existing.manual ? true : undefined,
  };
}

recover();
http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, layout('Error', `<h1>Something went wrong</h1><pre>${String((e as Error).message)}</pre>`));
    });
  })
  // Bind IPv4 explicitly: hosts like Render scan 0.0.0.0 for the open port.
  .listen(config.port, '0.0.0.0', () => console.log(`SL QA running on http://localhost:${config.port}${config.appPassword ? ' (password protected)' : ''}`));
