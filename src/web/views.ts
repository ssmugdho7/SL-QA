import { aiChecked, type CaseResult, type Check, type Verdict } from '../engine/context.js';
import { previewCase } from '../engine/phrases/index.js';
import type { TestCase } from '../engine/sources/cases.js';
import { EXAMPLE_CASES, EXAMPLE_JIRA, EXAMPLE_SUITE_NAME } from './example.js';
import type { Translation } from '../engine/ai/translate.js';
import type { Run, Suite } from './store.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A JS string literal safe inside an HTML attribute: onsubmit="return confirm(${jsq(text)})". */
const jsq = (s: string) => esc(JSON.stringify(s));

const VERDICT_CLASS: Record<Verdict, string> = { Pass: 'pass', Fail: 'fail', Review: 'review', Partial: 'partial', Blocked: 'blocked', Error: 'error' };
const STATE_ICON: Record<Check['state'], string> = { pass: '✓', fail: '✗', skip: '–', review: '?' };

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const duration = (a?: string, b?: string) => {
  if (!a) return '';
  const s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

type Section = 'suites' | 'runs' | 'chat' | 'help' | 'guide' | 'ai';

const FAVICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#d6243a"/><path d="M9 16.5l4.5 4.5L23 11.5" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

/** Inline 24×24 stroke icons (no icon library, CSP-friendly). */
const ICON: Record<string, string> = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  suites: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>',
  ai: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  guide: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6M9 11h6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
export const icon = (name: keyof typeof ICON | string, cls = 'ico') =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[name] ?? ''}</svg>`;

const NAV: [group: string, items: [key: Section, href: string, label: string][]][] = [
  ['Work', [['chat', '/chat', 'Assistant'], ['suites', '/', 'Suites'], ['runs', '/runs', 'Runs']]],
  ['Setup', [['ai', '/settings/ai', 'AI keys']]],
  ['Help', [['guide', '/guide', 'Guide'], ['help', '/help', 'Full reference']]],
];

export function layout(title: string, body: string, opts: { refresh?: boolean; section?: Section } = {}): string {
  const nav = NAV.map(([group, items]) => `<div class="nav-group"><p class="nav-label">${group}</p>${items
    .map(([key, href, label]) => `<a href="${href}"${opts.section === key ? ' aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`)
    .join('')}</div>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · SL QA</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
${opts.refresh ? '<script>setTimeout(() => location.reload(), 2000)</script>' : ''}
</head><body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="sidebar">
  <div class="side-top">
    <a class="brand" href="/chat"><img class="logo" src="${FAVICON}" alt="" width="26" height="26"><span>SL QA</span></a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Show menu" aria-controls="side-nav">
    <label for="nav-toggle" class="nav-burger" aria-hidden="true">${icon('menu')}</label>
  </div>
  <nav id="side-nav" class="side-nav" aria-label="Main">${nav}
    <div class="side-foot"><span class="nav-label">Target site</span><a href="https://slshop.cloud/dashboard" target="_blank" rel="noreferrer">slshop.cloud ${icon('ext', 'ico sm')}</a></div>
  </nav>
</aside>
<main id="main">${body}</main>
</div>
<script>${JS}</script>
</body></html>`;
}

export function verdictBadge(v: Verdict | string): string {
  return `<span class="badge ${VERDICT_CLASS[v as Verdict] ?? 'muted'}">${esc(v)}</span>`;
}

function counts(results: CaseResult[]): string {
  const by = new Map<string, number>();
  for (const r of results) by.set(r.verdict, (by.get(r.verdict) ?? 0) + 1);
  return ['Pass', 'Fail', 'Review', 'Partial', 'Blocked', 'Error']
    .filter((v) => by.get(v))
    .map((v) => `<span class="count ${VERDICT_CLASS[v as Verdict]}">${by.get(v)} ${v}</span>`)
    .join(' ');
}

function statusBadge(run: Run): string {
  const failing = run.results.some((r) => r.verdict === 'Fail');
  const toReview = run.results.some((r) => r.verdict === 'Review');
  const [cls, label] = {
    queued: ['muted', 'Waiting'],
    running: ['running', 'Running'],
    done: failing ? ['fail', 'Finished · issues found'] : toReview ? ['review', 'Finished · some to review'] : ['pass', 'Finished'],
    failed: ['error', 'Stopped by an error'],
    cancelled: ['muted', 'Cancelled'],
  }[run.status];
  return `<span class="badge ${cls}">${run.status === 'running' ? '<i class="spin"></i>' : ''}${label}</span>`;
}

const wrap = (table: string) => `<div class="table-wrap">${table}</div>`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── Home: suites + add form ────────────────────────────────────────────

export interface SuiteForm { kind: string; name: string; url: string; pagePath: string }

/** The whole-dashboard check: when the site map was made, a crawl in progress, the suite built from it. */
export interface SiteInfo { generatedAt?: string; pages: number; stale: boolean; crawling?: { pages: number; startedAt: string }; error?: string; suiteId?: string; msg?: string }

export function homePage(all: Suite[], lastRuns: Map<string, Run>, error?: string, typed?: SuiteForm, site?: SiteInfo): string {
  const f: SuiteForm = typed ?? { kind: 'sheet', name: '', url: '', pagePath: '/dashboard/products' };
  const rows = all
    .map((s) => {
      const last = lastRuns.get(s.id);
      const understood = s.cases.reduce((n, c) => n + previewCase(c).understood, 0);
      const total = s.cases.reduce((n, c) => n + previewCase(c).total, 0);
      return `<tr>
        <td><a href="/suites/${s.id}"><b>${esc(s.name)}</b></a><div class="sub">${sourceLabel(s)} · ${esc(s.pagePath)}</div></td>
        <td class="num">${s.cases.length}</td>
        <td class="nowrap">${coverage(understood, total)}</td>
        <td>${last ? `<a href="/runs/${last.id}">${statusBadge(last)}</a><div class="counts">${counts(last.results)}</div><div class="sub nowrap">${when(last.createdAt)}</div>` : '<span class="sub">Never run</span>'}</td>
        <td class="row-actions"><form method="post" action="/suites/${s.id}/delete" class="inline" onsubmit="return confirm('Delete the suite &quot;${esc(s.name).replace(/'/g, '')}&quot; and its cases? Past runs stay under Runs.')"><button class="danger" aria-label="Delete ${esc(s.name)}">Delete</button></form></td>
      </tr>`;
    })
    .join('');
  const radio = (kind: string, label: string, hint: string) =>
    `<label class="choice"><input type="radio" name="kind" value="${kind}"${f.kind === kind ? ' checked' : ''}><span><b>${label}</b><span class="hint">${hint}</span></span></label>`;
  return layout(
    'Suites',
    `<section class="card home-assistant" id="assistant">
      <h2>${icon('chat')} Start with the Assistant</h2>
      <p class="hint">Ask about slshop.cloud, have it hunt for bugs on a page in a real browser, or get test cases written for you. Bugs and cases save as a suite in one click.</p>
      <ul class="purposes"><li>Ask about slshop.cloud</li><li>Find a bug</li><li>Generate test cases</li></ul>
      <form method="post" action="/chat" class="toolbar">
        <input name="message" required maxlength="4000" placeholder="Find bugs on the Orders page" aria-label="Message for the Assistant" style="flex:1;min-width:220px">
        <button class="primary">Ask</button><a class="button" href="/chat">Open chats</a>
      </form>
    </section>
    <div class="page-head" style="margin-top:32px"><div><h1>Test suites</h1><p class="sub">A suite is one list of cases (test cases or bugs) for the bot to check on slshop.cloud.</p></div>
      <div class="toolbar"><a class="button primary" href="#add">＋ New suite</a></div></div>
    ${all.length ? wrap(`<table><thead><tr><th>Suite</th><th class="num">Cases</th><th>Understood by the bot</th><th>Last run</th><th></th></tr></thead><tbody>${rows}</tbody></table>`)
      : `<div class="empty"><b>No suites yet.</b><br>Add your first list of cases below: a Google Sheet, a file, or type them in by hand.<br><a href="/guide">New here? Read the Guide</a> · <a href="/example">Try the example suite</a> · <a href="/help/sample.csv">Download a sample sheet</a></div>`}
    <details class="card" id="add"${error || typed ? ' open' : ''}>
      <summary><h2 style="display:inline">Add a test suite</h2></summary>
      ${error ? `<div class="alert" role="alert">${esc(error)}</div>` : ''}
      <form method="post" action="/suites" enctype="multipart/form-data" class="stack" id="add-suite">
        <label>Name <input name="name" value="${esc(f.name)}" placeholder="Products page" required maxlength="120"></label>
        <fieldset class="choices"><legend>Where are the cases?</legend>
          ${radio('sheet', 'Google Sheet', 'Paste the link. The sheet must be shared as "Anyone with the link".')}
          ${radio('upload', 'Upload a file', '.csv or .xlsx, first worksheet.')}
          ${radio('manual', 'Type them in by hand', 'Start with an empty list; you add cases one by one.')}
        </fieldset>
        <label data-kind="sheet">Google Sheet link <input name="url" value="${esc(f.url)}" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…" inputmode="url"></label>
        <label data-kind="upload">File <input type="file" name="file" accept=".csv,.xlsx"></label>
        <label>Start page <input name="pagePath" value="${esc(f.pagePath)}" required pattern="/.*" title="Starts with /, for example /dashboard/products">
          <span class="hint">The dashboard page used for cases that don't name their own page.</span></label>
        <p class="hint">The sheet needs an <b>Expected Result</b> column, or a <b>Description</b> column holding a whole bug report pasted from Jira. A <b>URL</b> column tells the bot which page each row is about. <a href="/help#sheet">Sheet format</a> · <a href="/help/sample.csv">Sample sheet</a></p>
        <div><button class="primary">Add suite</button></div>
      </form>
    </details>
    <script>
      (function () {
        if (location.hash === '#add') document.getElementById('add').open = true;
        window.addEventListener('hashchange', () => { if (location.hash === '#add') document.getElementById('add').open = true; });
        const form = document.getElementById('add-suite');
        const sync = () => {
          const kind = form.querySelector('input[name=kind]:checked').value;
          form.querySelectorAll('[data-kind]').forEach((el) => {
            const on = el.dataset.kind === kind;
            el.hidden = !on;
            el.querySelector('input').required = on;
          });
        };
        form.addEventListener('change', sync);
        sync();
      })();
    </script>`,
    { section: 'suites' },
  );
}

function sourceLabel(s: Suite): string {
  return s.source.kind === 'sheet' ? 'Google Sheet' : s.source.kind === 'upload' ? 'Uploaded file' : s.source.kind === 'site' ? 'Whole dashboard (site map)' : 'Typed in by hand';
}

function coverage(understood: number, total: number): string {
  const pct = total ? Math.round((understood / total) * 100) : 0;
  return `<div class="meter" title="${understood} of ${total} sentence parts"><span style="width:${pct}%"></span></div><span class="sub">${pct}% (${understood}/${total})</span>`;
}

// ── Suite: cases, preview, run ─────────────────────────────────────────

export function suitePage(s: Suite, recent: Run[], flash?: string, ai?: { unknown: number; pending: number; provider: AiInfo }): string {
  const scenarios = [...new Set(s.cases.map((c) => c.scenario).filter(Boolean))];
  const rows = s.cases
    .map((c) => {
      const p = previewCase(c);
      const last = recent.flatMap((r) => r.results).find((r) => r.tc.id === c.id);
      return `<tr data-scenario="${esc(c.scenario)}">
        <td><input type="checkbox" name="case" value="${esc(c.id)}" form="run" checked aria-label="Select ${esc(c.id)}"></td>
        <td class="nowrap"><b>${esc(c.id)}</b>${c.manual ? '<div><span class="tag">added here</span></div>' : c.edited ? '<div><span class="tag" title="Changed in SL QA; re-reading the sheet keeps this version">edited here</span></div>' : ''}</td>
        <td>${esc(c.title)}<div class="sub">${esc([c.scenario, c.url].filter(Boolean).join(' · '))}</div>
          <details><summary>How the bot reads it</summary>${previewHtml(c)}</details></td>
        <td>${esc(c.priority) || '<span class="sub">—</span>'}</td>
        <td class="nowrap">${p.understood === p.total ? `<span class="ok">✓ all ${p.total}</span>` : `<span class="warn">${p.total - p.understood} of ${p.total} not understood</span>`}</td>
        <td>${last ? verdictBadge(last.verdict) : '<span class="sub">—</span>'}</td>
        <td class="row-actions"><a href="/suites/${s.id}/issues/${encodeURIComponent(c.id)}/edit" aria-label="Edit ${esc(c.id)}">Edit</a>
          <form method="post" action="/suites/${s.id}/issues/${encodeURIComponent(c.id)}/delete" class="inline" onsubmit="return confirm(${jsq(`Delete ${c.id}? ${c.manual ? 'This cannot be undone.' : 'It will stay hidden when the sheet is re-read.'}`)})"><button class="link danger" aria-label="Delete ${esc(c.id)}">Delete</button></form></td>
      </tr>`;
    })
    .join('');
  const source = s.source.kind === 'sheet' ? `<a href="${esc(s.source.url)}" target="_blank" rel="noreferrer">Google Sheet ↗</a>` : s.source.kind === 'upload' ? `Uploaded file <code>${esc(s.source.file.replace(/^\w+-/, ''))}</code>` : s.source.kind === 'site' ? `One read-only case per dashboard page, crawled ${when(s.syncedAt)} (<a href="/#site">re-crawl</a>)` : 'Typed in by hand';
  const manualCount = s.cases.filter((c) => c.manual).length;
  const n = s.cases.length;
  return layout(
    s.name,
    `<p class="crumbs"><a href="/">Suites</a> /</p>
    <div class="page-head"><div><h1>${esc(s.name)}</h1>
      <p class="sub">${[source, s.source.kind === 'site' ? '' : `starts on <code>${esc(s.pagePath)}</code>`, plural(n, 'case'), s.source.kind === 'sheet' ? `read ${when(s.syncedAt)}` : ''].filter(Boolean).join(' · ')}</p></div></div>
    ${flash ? `<div class="alert info" role="status">${esc(flash)}</div>` : ''}
    ${ai ? rewriteBanner(s, ai.unknown, ai.pending, ai.provider) : ''}
    ${n ? `<div class="toolbar">
      <form id="run" method="post" action="/suites/${s.id}/run" class="inline">
        <button class="primary" id="run-btn">▶ Run selected</button>
        ${scenarios.length > 1 ? `<label class="inline-label">Scenario <select name="scenario" id="scenario"><option value="">All scenarios</option>${scenarios.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>` : ''}
      </form>
      <a class="button" href="/suites/${s.id}/issues/new">＋ Add case</a>
      ${s.source.kind === 'sheet' ? `<form method="post" action="/suites/${s.id}/sync" class="inline"><button title="Download the sheet again and pick up changes">↻ Re-read sheet</button></form>` : ''}
      ${s.source.kind === 'site' ? `<form method="post" action="/suites/${s.id}/sync" class="inline"><button title="Rebuild the cases from the latest site map">↻ Rebuild from site map</button></form>` : ''}
    </div>
    <div class="selection-bar">
      <span id="sel-count" class="sub" aria-live="polite"></span>
      <button form="run" class="link danger" name="action" value="delete" formaction="/suites/${s.id}/issues" formnovalidate id="delete-ticked">Delete selected</button>
      ${s.removed?.length ? `<span class="sub">· ${plural(s.removed.length, 'sheet row')} hidden here</span>` : ''}
    </div>
    ${wrap(`<table class="cases"><thead><tr><th><input type="checkbox" checked id="all" aria-label="Select all cases"></th><th>ID</th><th>Case</th><th>Priority</th><th>Understood</th><th>Last result</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`)}`
      : `<div class="empty"><b>No cases in this suite yet.</b><br>${s.source.kind === 'sheet' ? 'Re-read the sheet, or add a case by hand.' : 'Add the first case: a page link and what should happen there.'}
          <div class="toolbar center"><a class="button primary" href="/suites/${s.id}/issues/new">＋ Add case</a>${s.source.kind === 'sheet' ? `<form method="post" action="/suites/${s.id}/sync" class="inline"><button>↻ Re-read sheet</button></form>` : ''}</div></div>`}
    ${recent.length ? `<h2>Recent runs</h2>${runsTable(recent.slice(0, 10))}` : ''}
    <details class="card settings"><summary><b>Suite settings</b></summary>
      <form method="post" action="/suites/${s.id}/settings" class="stack">
        <label>Start page <input name="pagePath" value="${esc(s.pagePath)}" required pattern="/.*" title="Starts with /, for example /dashboard/products">
          <span class="hint">Used for cases that don't name their own page.</span></label>
        <div><button>Save</button></div>
      </form>
      <div class="danger-zone">
        <h3>Danger zone</h3>
        ${n ? `<form method="post" action="/suites/${s.id}/issues" class="inline" onsubmit="return confirm(${jsq(`Delete all ${plural(n, 'case')} in this suite? ${manualCount ? `The ${plural(manualCount, 'case')} added by hand cannot be recovered. ` : ''}${s.source.kind === 'sheet' ? 'Sheet rows stay hidden when the sheet is re-read.' : ''}`)})">
          <input type="hidden" name="action" value="delete"><input type="hidden" name="scope" value="all"><button class="danger">Delete all cases</button></form>
          <span class="hint">Empties the suite but keeps it and its runs.</span><br>` : ''}
        <form method="post" action="/suites/${s.id}/delete" class="inline" onsubmit="return confirm(${jsq(`Delete the suite '${s.name}'? Its past runs stay under Runs.`)})"><button class="danger">Delete suite</button></form>
        <span class="hint">Removes the suite. Past runs and reports stay under Runs.</span>
      </div>
    </details>
    <script>
      (function () {
        const boxes = () => [...document.querySelectorAll('input[name=case]')];
        const all = document.getElementById('all'), runBtn = document.getElementById('run-btn'), count = document.getElementById('sel-count'), del = document.getElementById('delete-ticked'), scenario = document.getElementById('scenario');
        if (!runBtn) return;
        const update = () => {
          const n = boxes().filter((b) => b.checked).length, total = boxes().length;
          runBtn.textContent = n === total ? '▶ Run all ' + total : '▶ Run ' + n + ' selected';
          runBtn.disabled = n === 0;
          del.disabled = n === 0;
          count.textContent = n + ' of ' + total + ' selected';
          all.checked = n === total; all.indeterminate = n > 0 && n < total;
        };
        all.addEventListener('change', () => { boxes().forEach((b) => (b.checked = all.checked)); update(); });
        document.addEventListener('change', (e) => { if (e.target.name === 'case') update(); });
        // Picking a scenario ticks exactly its cases, so what you see is what runs.
        scenario && scenario.addEventListener('change', () => {
          boxes().forEach((b) => (b.checked = !scenario.value || b.closest('tr').dataset.scenario === scenario.value));
          update();
        });
        del.addEventListener('click', (e) => {
          const n = boxes().filter((b) => b.checked).length, total = boxes().length;
          const msg = n === total ? 'This deletes EVERY case in the suite (' + total + '). Continue?' : 'Delete ' + n + ' selected case' + (n === 1 ? '' : 's') + '?';
          if (!confirm(msg)) e.preventDefault();
        });
        update();
      })();
    </script>`,
    { section: 'suites' },
  );
}

function previewHtml(c: TestCase): string {
  const p = previewCase(c);
  const item = (text: string, rule: string | null, via?: 'ai' | 'live') =>
    `<li class="${rule ? 'ok' : 'warn'}">${rule ? '✓' : '?'} ${esc(text)}${rule ? ` <span class="rule">${esc(rule)}${via ? ' · <span class="tag ai">AI rewrite, approved</span>' : ''}</span>` : ' <span class="rule">not understood by the rules: with an AI key, the AI works it out during the run; or reword it (<a href="/help#writing">tips</a>)</span>'}</li>`;
  return `<div class="preview"><b>Steps</b><ol>${p.steps.map((s) => `<li>${esc(s.sentence)}<ul>${s.clauses.map((x) => item(x.text, x.rule, x.via)).join('')}</ul></li>`).join('')}</ol>
    <b>Expected</b><ul>${p.expects.map((e) => e.claims.map((x) => item(x.text, x.rule, x.via)).join('')).join('')}</ul></div>`;
}

// ── AI rewrites: suggest, review, approve ─────────────────────────────

export interface RewriteRow { key: string; t: Translation; cases: string[] }

/** Banner on the suite page: how many sentences are not understood, and what to do about it. */
type AiInfo = { name: string; model: string; chain: string[]; paidLimit: number; paidUsed: number } | null;

export function rewriteBanner(s: Suite, unknownCount: number, pending: number, provider: AiInfo): string {
  if (!unknownCount && !pending) return '';
  const action = provider
    ? `<form method="post" action="/suites/${s.id}/rewrites/suggest" class="inline"><button class="primary">✨ Ask AI to suggest rewrites</button></form>`
    : '<span class="sub">Without an AI key these sentences are skipped. To get AI help, add a free key such as <code>GEMINI_API_KEY</code> or <code>GROQ_API_KEY</code> to <code>.env</code> and restart. See <a href="/help#ai-keys">Full reference → AI keys</a>.</span>';
  return `<div class="card ai-banner"><div><b>${plural(unknownCount, 'sentence')} the bot does not understand yet.</b>
    ${pending ? `${plural(pending, 'AI suggestion')} waiting for review.` : ''}
    <div class="sub">During a run, the AI turns them into simple steps (CLICK, TYPE, EXPECT TEXT…) on the spot; those steps are marked AI in the results. You can also get suggestions now and check them first. Approved rewrites are reused without calling the AI, so each sentence needs it only once.${provider ? ` Tries, in order: ${esc(provider.chain.join(' → '))}. Paid calls today: ${provider.paidUsed} of ${provider.paidLimit}.` : ''}</div></div>
    <div class="toolbar">${action}${pending || unknownCount ? `<a class="button" href="/suites/${s.id}/rewrites">Review rewrites${pending ? ` (${pending})` : ''}</a>` : ''}</div></div>`;
}

export function rewritesPage(s: Suite, rows: RewriteRow[], unknown: { kind: string; text: string; cases: string[] }[], provider: AiInfo, flash?: string): string {
  const status = (t: Translation) => (t.status === 'approved' ? '<span class="ok">✓ approved</span>' : t.status === 'rejected' ? '<span class="sub">rejected</span>' : '<span class="warn">waiting for review</span>');
  const card = ({ key, t, cases }: RewriteRow) => `<form method="post" action="/suites/${s.id}/rewrites" class="card rewrite stack">
      <input type="hidden" name="key" value="${esc(key)}">
      <div class="rewrite-head"><span class="tag">${t.kind === 'step' ? 'Step' : 'Expected'}</span> ${status(t)} <span class="sub">used in ${esc(cases.join(', ') || '—')}</span></div>
      <p class="source">“${esc(t.source)}”</p>
      <label><span>Rewrite <span class="sub">one action per line; edit freely</span></span>
        <textarea name="lines" rows="${Math.max(2, t.lines.length + 1)}" spellcheck="false">${esc(t.lines.join('\n'))}</textarea></label>
      ${t.note ? `<p class="sub">AI note: ${esc(t.note)}</p>` : ''}
      ${!t.lines.length ? '<p class="sub">No lines: approving marks this sentence as “cannot be automated”; it is reported as not checked with the note above.</p>' : ''}
      <div class="toolbar">
        <button class="primary" name="action" value="approve">✓ Approve${t.status === 'approved' ? ' changes' : ''}</button>
        <button name="action" value="reject">Reject</button>
        ${t.status !== 'suggested' ? '<button name="action" value="reset" class="link">Back to review</button>' : ''}
      </div></form>`;
  const waiting = rows.filter((r) => r.t.status === 'suggested');
  const done = rows.filter((r) => r.t.status !== 'suggested');
  return layout(
    'AI rewrites',
    `<p class="crumbs"><a href="/">Suites</a> / <a href="/suites/${s.id}">${esc(s.name)}</a> /</p>
    <h1>AI rewrites</h1>
    <p class="sub">Sentences the bot's rules do not understand, rewritten by AI into simple actions it can run. Suggestions also come in automatically from runs, where the AI helped live. Check each one, edit it if needed, then approve: approved rewrites are saved, reused by every suite, and run without calling the AI. Rejected ones are not used again, and the AI is asked afresh next run.</p>
    ${flash ? `<div class="alert info" role="status">${esc(flash)}</div>` : ''}
    ${provider ? `<p class="sub">AI providers, tried in this order: <b>${esc(provider.chain.join(' → '))}</b>. Paid calls today: ${provider.paidUsed} of ${provider.paidLimit} · <a href="/settings/ai">AI keys</a></p>` : ''}
    <div class="toolbar">
      ${provider ? `<form method="post" action="/suites/${s.id}/rewrites/suggest" class="inline"><button class="primary"${unknown.length ? '' : ' disabled'}>✨ Suggest rewrites for ${plural(unknown.length, 'sentence')}</button></form>` : '<span class="warn">No AI key set. Add a free key such as <code>GEMINI_API_KEY</code> or <code>GROQ_API_KEY</code> to <code>.env</code> and restart (<a href="/settings/ai">AI keys</a>).</span>'}
      ${waiting.length ? `<form method="post" action="/suites/${s.id}/rewrites" class="inline" onsubmit="return confirm(${jsq(`Approve all ${waiting.length} suggestions without editing?`)})"><input type="hidden" name="action" value="approve-all"><button>Approve all ${waiting.length}</button></form>` : ''}
      <a class="button" href="/suites/${s.id}">Back to suite</a>
    </div>
    ${unknown.length ? `<details class="card"><summary><b>${plural(unknown.length, 'sentence')} without a rewrite yet</b></summary><ul>${unknown.map((u) => `<li><span class="tag">${u.kind === 'step' ? 'Step' : 'Expected'}</span> ${esc(u.text)} <span class="sub">(${esc(u.cases.join(', '))})</span></li>`).join('')}</ul></details>` : ''}
    ${waiting.length ? `<h2>Waiting for review (${waiting.length})</h2>${waiting.map(card).join('')}` : ''}
    ${done.length ? `<h2>Reviewed (${done.length})</h2>${done.map(card).join('')}` : ''}
    ${!rows.length && !unknown.length ? '<div class="empty"><b>Every sentence in this suite is understood.</b></div>' : ''}
    <details class="card"><summary><b>The action language</b></summary>${ACTION_HELP}</details>`,
    { section: 'suites' },
  );
}

export function aiKeysPage(rows: ReturnType<typeof import('../engine/ai/providers.js').status>, paid: { used: number; limit: number }, flash?: string): string {
  const row = (r: (typeof rows)[number]) => `<tr>
    <td><b>${esc(r.provider.name)}</b><div class="sub">${r.provider.tier}</div></td>
    <td><code>${esc(r.provider.keyEnv)}</code>${r.keys > 1 ? `<div class="sub">${r.keys} keys</div>` : ''}</td>
    <td class="nowrap">${r.set ? '<span class="ok">✓ set</span>' : '<span class="sub">not set</span>'}</td>
    <td><code>${esc(r.model)}</code><div class="sub">change with <code>${esc(r.provider.modelEnv)}</code></div></td>
    <td>${r.ok || r.failed ? `${r.ok} ok · ${r.failed} failed` : '<span class="sub">—</span>'}${r.coolingUntil ? `<div class="warn">skipped until ${esc(r.coolingUntil)} (${esc(r.coolReason ?? '')})</div>` : ''}${r.lastError ? `<div class="sub" title="${esc(r.lastError)}">last error: ${esc(r.lastError.slice(25, 120))}</div>` : ''}</td>
    <td class="nowrap"><a href="${esc(r.provider.signup)}" target="_blank" rel="noreferrer">Get a key ↗</a></td></tr>`;
  return layout(
    'AI keys',
    `<div class="page-head"><div><h1>AI keys</h1><p class="sub">Which AI providers SL QA can use, and how they are doing today. Pass and Fail are always decided by the bot's own checks; the AI only helps.</p></div></div>
    <div class="card"><ul style="margin:0;padding-left:20px">
      <li><b>Gemini</b> (free): the default. One free key is enough for the Assistant, AI rewrites and live help during runs.</li>
      <li><b>OpenAI</b> (paid): used by <b>Super QA</b> and by the Assistant's <b>Find a bug</b> triage, which need a stronger model.</li>
      <li><b>Claude</b> (optional): a strong model for live help and Super QA when it is set.</li>
    </ul>
    <p class="hint" style="margin-top:12px">Providers are tried top to bottom in the table. One that fails (bad key, quota used up, error) is skipped for a while and the next one is tried. Paid fallbacks are used at most <b>${paid.limit}</b> times a day.</p></div>
    ${flash ? `<div class="alert info" role="status">${esc(flash)}</div>` : ''}
    <p>Paid calls today: <b>${paid.used} of ${paid.limit}</b> <span class="sub">(change with <code>AI_PAID_DAILY_LIMIT</code>; 0 = never use paid keys)</span></p>
    ${wrap(`<table><thead><tr><th>Provider</th><th>.env name</th><th>Key</th><th>Model</th><th>Today</th><th></th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`)}
    <form method="post" action="/settings/ai/reset" class="inline"><button>Try skipped providers again now</button></form>
    <p class="sub">Keys are read from the <code>.env</code> file when SL QA starts; after changing it, restart SL QA. Several keys for one provider can be separated by commas. See <a href="/help#ai-keys">Full reference → AI keys</a>.</p>`,
    { section: 'ai' },
  );
}

export const ACTION_HELP = `<table class="stack-sm"><thead><tr><th>Line</th><th>What the bot does</th></tr></thead><tbody>
  <tr><td><code>GO TO '/dashboard/orders'</code></td><td>Opens that page.</td></tr>
  <tr><td><code>CLICK 'Save Product'</code> · <code>CLICK 'Delete' IN 'Confirm'</code></td><td>Clicks the button, link, tab or text with that name (inside a dialog or section when given).</td></tr>
  <tr><td><code>TYPE '100' INTO 'Selling Price'</code> · <code>CLEAR 'Search'</code></td><td>Types into the field with that label or placeholder.</td></tr>
  <tr><td><code>SELECT 'kg' IN 'Unit'</code></td><td>Opens the dropdown and picks the option.</td></tr>
  <tr><td><code>TURN ON 'Track inventory'</code> · <code>CHECK 'Select all'</code></td><td>Switches and checkboxes.</td></tr>
  <tr><td><code>PRESS 'Enter'</code> · <code>WAIT 2</code> · <code>UPLOAD 'square jpg' TO 'Gallery'</code></td><td>Keys, pauses, and test files the bot makes itself.</td></tr>
  <tr><td><code>EXPECT TEXT 'Product created'</code> · <code>EXPECT NO TEXT 'Error'</code></td><td>Text on the page or in a pop-up message.</td></tr>
  <tr><td><code>EXPECT MESSAGE 'required'</code> · <code>EXPECT URL '/dashboard/products'</code></td><td>A pop-up message; the page address.</td></tr>
  <tr><td><code>EXPECT BUTTON 'Save' DISABLED</code> · <code>EXPECT FIELD 'Price' = '100'</code> · <code>EXPECT COUNT 'Showing 1–1 of 1'</code></td><td>Button state, a field's value, a count.</td></tr>
  <tr><td><code>EXPECT VALUE 'On Hand' = '13'</code> · <code>EXPECT VALUE 'Total' &gt; '0'</code></td><td>The number or text shown next to a label (cards, detail rows, totals). Also <code>!=</code>, <code>&lt;</code>, <code>&gt;=</code>, <code>&lt;=</code>.</td></tr>
  <tr><td><code>REMEMBER VALUE 'On Hand' AS stock</code> · <code>REMEMBER COUNT AS n</code></td><td>Reads a value (or the list total) before the steps, for a before/after check.</td></tr>
  <tr><td><code>EXPECT VALUE 'On Hand' = stock + 5</code> · <code>EXPECT VALUE 'Total' &gt; sales</code> · <code>EXPECT VALUE 'Total' CHANGED</code></td><td>Compares with a remembered value. Also <code>- 2</code>, <code>UNCHANGED</code>.</td></tr>
  <tr><td><code>EXPECT COUNT = n + 1</code> · <code>EXPECT COUNT &lt; n</code> · <code>EXPECT COUNT UNCHANGED</code></td><td>The list total ("Showing x–y of z") compared with a remembered count.</td></tr>
  <tr><td><code>EXPECT ROW 'BTB Shirt'</code> · <code>EXPECT NO ROW 'BTB Shirt'</code> · <code>EXPECT TEXT 'Paid' IN 'ORD-1001'</code></td><td>A list row or card with that text; text inside one row, dialog or section.</td></tr>
  <tr><td><code>WAIT FOR TEXT 'Saved' 10</code> · <code>WAIT FOR URL '/dashboard/orders'</code> · <code>RELOAD</code> · <code>GO BACK</code></td><td>Waits up to N seconds (default 10); reloads; goes back.</td></tr>
  <tr><td><code>HOVER 'Info'</code> · <code>SCROLL TO 'Footer'</code> · <code>TYPE 'Red' INTO 'Name' IN 'Add Category'</code></td><td>Hover, scroll, and typing into a field inside one dialog or section.</td></tr>
</tbody></table><p class="sub">Names can be in 'single' or "double" quotes. You can also type these lines straight into a sheet or the Add case form; the bot understands them without AI.</p>`;

// ── Runs ───────────────────────────────────────────────────────────────

export function runsTable(list: Run[]): string {
  return wrap(`<table><thead><tr><th>Started</th><th>Suite</th><th>Status</th><th>Results</th><th>Took</th></tr></thead><tbody>${list
    .map(
      (r) => `<tr><td class="nowrap"><a href="/runs/${r.id}">${when(r.createdAt)}</a></td><td>${esc(r.suiteName)}</td><td>${statusBadge(r)}</td>
      <td><div class="counts">${counts(r.results) || '<span class="sub">—</span>'}</div><span class="sub">${r.results.length} of ${r.caseIds.length} checked</span></td><td class="nowrap">${duration(r.startedAt, r.finishedAt)}</td></tr>`,
    )
    .join('')}</tbody></table>`);
}

export function runsPage(list: Run[]): string {
  return layout('Runs', `<div class="page-head"><div><h1>Runs</h1><p class="sub">Every time you press Run, the results land here. Newest first.</p></div></div>
    ${list.length ? runsTable(list) : '<div class="empty"><b>No runs yet.</b><br>Open a <a href="/">suite</a>, tick the cases and click Run.</div>'}`, { section: 'runs' });
}

export function runPage(run: Run, earlier: Run[] = []): string {
  const live = run.status === 'running' || run.status === 'queued';
  const pct = run.caseIds.length ? Math.round((run.results.length / run.caseIds.length) * 100) : 0;
  const issues = run.results.flatMap((r) => r.checks.filter((c) => c.state === 'fail').map((c) => ({ r, c })));
  const reviews = run.results.flatMap((r) => r.checks.filter((c) => c.state === 'review' || (aiOnly(r) && c.by === 'ai' && c.state === 'pass')).map((c) => ({ r, c })));
  const rerun = [...new Set([...issues, ...reviews].map((i) => i.r.tc.id))];
  const changes = diff(run, earlier);
  const has = run.results.length > 0;
  return layout(
    `${run.suiteName} run · ${when(run.createdAt)}`,
    `<p class="crumbs"><a href="/">Suites</a> / <a href="/suites/${run.suiteId}">${esc(run.suiteName)}</a> /</p>
    <h1>Run · ${esc(run.suiteName)} ${statusBadge(run)}</h1>
    <p class="sub">${[when(run.createdAt), duration(run.startedAt, run.finishedAt), `${run.results.length} of ${plural(run.caseIds.length, 'case')} checked`].filter(Boolean).join(' · ')}</p>
    ${has ? `<div class="counts big">${counts(run.results)}</div>` : ''}
    ${run.error ? `<div class="alert" role="alert">${esc(run.error)}</div>` : ''}
    ${
      live
        ? `<section class="card live"><div class="progress"><span style="width:${pct}%"></span></div>
          <p><b>${run.results.length} of ${run.caseIds.length}</b> done${run.current ? ` · now <b>${esc(run.current.caseId)}</b>: ${esc(run.current.step)}` : ' · waiting for a free runner'}</p>
          <form method="post" action="/runs/${run.id}/cancel"><button class="danger">Cancel run</button></form></section>`
        : `<div class="toolbar">
           ${has ? `<a class="button primary" href="/runs/${run.id}/report">View report</a><a class="button" href="/runs/${run.id}/report.md" download>⬇ Download report (.md)</a>` : ''}
           <form method="post" action="/suites/${run.suiteId}/run" class="inline">${run.caseIds.map((id) => `<input type="hidden" name="case" value="${esc(id)}">`).join('')}<button>↻ Run again</button></form>
           ${rerun.length ? `<form method="post" action="/suites/${run.suiteId}/run" class="inline">${rerun.map((id) => `<input type="hidden" name="case" value="${esc(id)}">`).join('')}<button>↻ Re-run failed only</button></form>` : ''}
           <span class="spacer"></span>
           <form method="post" action="/runs/${run.id}/delete" class="inline" onsubmit="return confirm('Delete this run, its report and screenshots? This cannot be undone.')"><button class="danger">Delete run</button></form></div>`
    }
    ${changes}
    ${issues.length ? `<h2>Problems found (${issues.length})</h2><ul class="issues">${issues.map(({ r, c }) => `<li><a href="#${esc(r.tc.id)}"><b>${esc(r.tc.id)}</b></a> ${esc(c.label)} — <span class="actual">${esc(c.actual)}</span>${c.cause ? `<div class="cause">Likely cause: ${esc(c.cause)}</div>` : ''}</li>`).join('')}</ul>` : ''}
    ${reviews.length ? `<h2>To review (${reviews.length})</h2><p class="sub">Checks the AI wrote from the sheet's sentence: ones that did not hold, and cases that passed only on AI-written checks (marked AI-checked). Each could be a real bug, a misread sentence, or a check too weak to prove the point: look at the screenshot, then report the bug or correct the check under <a href="/suites/${esc(run.suiteId)}/rewrites">Review rewrites</a>.</p><ul class="issues">${reviews.map(({ r, c }) => `<li><a href="#${esc(r.tc.id)}"><b>${esc(r.tc.id)}</b></a> ${esc(c.label)} — <span class="actual">${esc(c.actual)}</span></li>`).join('')}</ul>` : ''}
    ${has ? '' : live ? '' : '<div class="empty"><b>No cases were checked in this run.</b><br>It stopped before the first case finished. Click Run again to retry.</div>'}
    ${has ? `<h2>Results</h2>` : ''}
    ${has ? wrap(`<table><thead><tr><th>ID</th><th>Case</th><th>Result</th><th>Main finding</th></tr></thead><tbody>${run.results
      .map((r) => {
        const f = r.checks.find((c) => c.state === 'fail') ?? r.checks.find((c) => c.state === 'review');
        const finding = f ? `${f.label}: ${f.actual}` : r.verdict === 'Blocked' ? r.notes.at(-1) ?? '' : r.error ?? '';
        return `<tr><td class="nowrap"><a href="#${esc(r.tc.id)}">${esc(r.tc.id)}</a></td><td>${esc(r.tc.title)}</td><td>${verdictBadge(r.verdict)}${aiOnly(r) ? ' <span class="tag ai">AI-checked</span>' : ''}</td><td class="sub">${esc(finding.slice(0, 180))}</td></tr>`;
      })
      .join('')}</tbody></table>`) : ''}
    ${run.results.map((r) => caseDetail(run, r)).join('')}`,
    { refresh: live, section: 'runs' },
  );
}

function diff(run: Run, earlier: Run[]): string {
  // Each case's most recent earlier result, wherever it ran (a full run, a re-run of failed cases, or a single check).
  const before = new Map<string, { verdict: string; run: Run }>();
  for (const r of earlier) for (const res of r.results) if (!before.has(res.tc.id)) before.set(res.tc.id, { verdict: res.verdict, run: r });
  const newlyFailing = run.results.filter((r) => r.verdict === 'Fail' && before.has(r.tc.id) && before.get(r.tc.id)!.verdict !== 'Fail');
  const fixed = run.results.filter((r) => r.verdict !== 'Fail' && before.get(r.tc.id)?.verdict === 'Fail');
  if (!newlyFailing.length && !fixed.length) return '';
  const link = (r: CaseResult) => `<a href="#${esc(r.tc.id)}">${esc(r.tc.id)}</a> <span class="sub">(was ${esc(before.get(r.tc.id)!.verdict)} on <a href="/runs/${before.get(r.tc.id)!.run.id}">${when(before.get(r.tc.id)!.run.createdAt)}</a>)</span>`;
  return `<section class="card"><h2>Since the previous run</h2>
    ${newlyFailing.length ? `<p>❌ Newly failing: ${newlyFailing.map(link).join(', ')}</p>` : ''}
    ${fixed.length ? `<p>✅ No longer failing: ${fixed.map(link).join(', ')}</p>` : ''}</section>`;
}

/** Review only because every passing check was written by AI (no check itself failed or is in review). */
const aiOnly = (r: CaseResult) => r.verdict === 'Review' && aiChecked(r.checks) && !r.checks.some((c) => c.state === 'review');

function caseDetail(run: Run, r: CaseResult): string {
  const fails = r.checks.filter((c) => c.state === 'fail');
  const aiSteps = r.steps.filter((s) => s.via === 'ai').length;
  const aiNotes = r.notes.filter((n) => /^AI read |the AI's corrected version|AI says /.test(n));
  return `<section class="case" id="${esc(r.tc.id)}">
    <h3>${esc(r.tc.id)} · ${esc(r.tc.title)} ${verdictBadge(r.verdict)}${aiOnly(r) ? ' <span class="tag ai" title="Every check that passed was written by AI, so a person should confirm it">AI-checked</span>' : ''} <span class="sub">${(r.durationMs / 1000).toFixed(1)}s</span>${aiSteps || aiNotes.length ? ` <span class="tag ai" title="Some steps or checks were worked out by AI because the bot's rules did not cover them">AI helped</span>` : ''}</h3>
    ${aiSteps || aiNotes.length ? `<div class="ai-box"><b>AI helped with ${aiSteps ? `${aiSteps} step${aiSteps === 1 ? '' : 's'}` : 'the checks'}.</b> <span class="sub">Its readings are saved as suggestions: approve them under <a href="/suites/${esc(run.suiteId)}/rewrites">Review rewrites</a> so the next run uses them directly, without AI.</span></div>` : ''}
    ${r.checks.length ? `<table class="checks"><thead><tr><th></th><th>Expected</th><th>Actual</th></tr></thead><tbody>${r.checks
      .map((c) => `<tr class="${c.state}"><td>${STATE_ICON[c.state]}</td><td>${esc(c.label)}${c.by === 'ai' ? ' <span class="tag ai">AI</span>' : ''}</td><td>${esc(c.actual)}${c.state === 'fail' && c.cause ? `<div class="cause">Likely cause: ${esc(c.cause)}</div>` : c.state === 'review' && c.cause ? `<div class="cause">${esc(c.cause)}</div>` : ''}</td></tr>`)
      .join('')}</tbody></table>` : ''}
    ${r.tc.reported ? `<p class="note"><b>Reported by the tester:</b> ${esc(r.tc.reported)}</p>` : ''}
    ${r.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
    ${r.error ? `<p class="alert">Bot error (not a finding about the app): ${esc(r.error)}</p>` : ''}
    <details><summary>Steps the bot ran (${r.steps.length})</summary><ol class="steps">${r.steps
      .map((s) => `<li class="${s.status}">${esc(s.text)}${s.via === 'ai' ? ' <span class="tag ai">AI</span>' : s.via === 'approved' ? ' <span class="tag ai">approved rewrite</span>' : ''}${s.detail ? ` <span class="sub">— ${esc(s.detail)}</span>` : ''}</li>`)
      .join('')}</ol></details>
    ${r.inspection ? `<details><summary>Page health${r.inspection.consoleErrors.length + r.inspection.failedRequests.length ? ` — ${r.inspection.consoleErrors.length} console error(s), ${r.inspection.failedRequests.length} failed request(s)` : ' — no errors'}</summary><pre>${esc([
      `${r.inspection.url} → ${r.inspection.finalUrl} · HTTP ${r.inspection.status ?? '—'} · ${(r.inspection.loadMs / 1000).toFixed(1)}s`,
      ...r.inspection.consoleErrors.map((x) => `console: ${x}`),
      ...r.inspection.failedRequests.map((x) => `request: ${x}`),
      ...r.inspection.slowRequests.map((x) => `slow: ${x}`),
      ...r.inspection.errorTexts.map((x) => `page text: ${x}`),
    ].join('\n'))}</pre></details>` : ''}
    ${r.failedRequests.length ? `<details><summary>Failed API requests (${r.failedRequests.length})</summary><pre>${esc(r.failedRequests.join('\n'))}</pre></details>` : ''}
    ${r.consoleErrors.length ? `<details><summary>Console errors (${r.consoleErrors.length})</summary><pre>${esc(r.consoleErrors.join('\n'))}</pre></details>` : ''}
    ${r.screenshots.length ? `<div class="shots">${r.screenshots.map((s) => `<a href="/runs/${run.id}/shots/${esc(s)}" target="_blank"><img loading="lazy" src="/runs/${run.id}/shots/${esc(s)}" alt="${esc(s)}"><span>${esc(s.replace(/^[\w-]+?-\d+-/, '').replace('.png', ''))}</span></a>`).join('')}</div>` : ''}
    ${fails.length ? `<details><summary>Fix prompt</summary><div class="prompt"><button type="button" onclick="copyNext(this)">Copy</button><pre>${esc(fixPrompt(r, fails))}</pre></div></details>` : ''}
  </section>`;
}

function fixPrompt(r: CaseResult, fails: Check[]): string {
  const lines = [
    `Fix a bug in the slshop.cloud store dashboard.`,
    '',
    `Test case ${r.tc.id}: ${r.tc.title}`,
    r.tc.preconditions ? `Preconditions: ${r.tc.preconditions}` : '',
    'Steps:',
    ...r.tc.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'What fails:',
    ...fails.map((c) => `- Expected: ${c.label}\n  Actual: ${c.actual}${c.cause ? `\n  Likely cause: ${c.cause}` : ''}`),
  ];
  if (r.failedRequests.length) lines.push('', `Failed API requests: ${r.failedRequests.slice(0, 6).join('; ')}`);
  if (r.consoleErrors.length) lines.push('', `Console errors: ${r.consoleErrors.slice(0, 3).join('; ')}`);
  lines.push('', 'Find where this behaviour is implemented (frontend component and the API endpoint it calls), fix the root cause, and add a test that covers the expected result above.');
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

// ── Add / edit one issue by hand ───────────────────────────────────────

/** `typed`: values from a submit that failed validation, shown back as typed (multi-line fields are one raw string). */
export function issueFormPage(s: Suite, editing?: TestCase, flash?: string, typed?: TestCase, pages: { path: string; name: string }[] = []): string {
  const c = typed ?? editing;
  const v = (x?: string | string[]) => esc(Array.isArray(x) ? x.join('\n') : x ?? '');
  const raw = typed !== undefined;
  const scenarios = [...new Set(s.cases.map((x) => x.scenario).filter(Boolean))];
  return layout(
    editing ? `Edit ${editing.id}` : 'Add case',
    `<p class="crumbs"><a href="/">Suites</a> / <a href="/suites/${s.id}">${esc(s.name)}</a> /</p>
    <h1>${editing ? `Edit ${esc(editing.id)}` : 'Add a case'}</h1>
    <p class="sub">A case is one bug, or one thing to check. The bot will open the page, follow the steps, and compare what <b>should</b> happen with what the page really does.</p>
    ${flash ? `<div class="alert${/^(Added|Read the report)/.test(flash) ? ' info' : ''}" role="${/^(Added|Read the report)/.test(flash) ? 'status' : 'alert'}">${esc(flash)}</div>` : ''}
    <form method="post" action="/suites/${s.id}/issues${editing ? `/${encodeURIComponent(editing.id)}` : ''}" class="card stack issue-form">
      <details class="paste"${editing || raw ? '' : ' open'}><summary><b>Paste a bug report</b> <span class="sub">from Jira, email or chat; the form fills itself</span></summary>
        <div class="stack" style="margin-top:10px">
          <textarea name="paste" rows="7" placeholder="Products: Variable products show &quot;Price 0.00&quot;\nPre-condition: User is signed in.\nSteps to reproduce:\n1. Navigate to Products page\n2. Locate a product marked &quot;Variable&quot;\nActual result: The card shows ৳0.00.\nExpected result: The card should show the price range from the variants."></textarea>
          <span class="hint">Paste the whole report as it is: title on the first line, then <b>Pre-condition</b>, <b>Steps to reproduce</b> (numbered), <b>Actual result</b> and <b>Expected result</b>. Image and video references are ignored. <a href="/help#paste" target="_blank">What the bot understands</a></span>
          <div><button name="then" value="parse" formnovalidate>Fill the form from it ↓</button></div>
        </div></details>
      <label><span>Title <span class="req">required</span></span>
        <input name="title" value="${v(c?.title)}" placeholder="Export button missing on Customers page" required maxlength="200">
        <span class="hint">A short name for the problem.</span></label>
      <label><span>Page link ${s.source.kind === 'manual' ? '<span class="req">required</span>' : '<span class="opt">optional</span>'}</span>
        <input name="url" value="${v(c?.url)}" placeholder="https://slshop.cloud/dashboard/customers"${s.source.kind === 'manual' ? ' required' : ''}${pages.length ? ' list="known-pages" autocomplete="off"' : ''}>
        ${pages.length ? `<datalist id="known-pages">${pages.map((x) => `<option value="${esc(x.path)}" label="${esc(x.name)}">${esc(x.name)}</option>`).join('')}</datalist>` : ''}
        <span class="hint">Where the problem happens. A full link, or just the part starting with <code>/dashboard/</code>.${pages.length ? ` Start typing a path to pick one of the ${pages.length} known pages.` : ''}${s.source.kind === 'manual' ? '' : ` Empty = the suite's start page (<code>${esc(s.pagePath)}</code>).`}</span></label>
      <label><span>Expected result <span class="req">required</span></span>
        <textarea name="expected" rows="4" required placeholder="• The 'Export page' button should be visible.\n• The page should load without errors.">${raw ? v(c?.expected) : v(c?.expected.map((e) => `• ${e}`))}</textarea>
        <span class="hint">What <b>should</b> happen, one point per line (a paragraph also works). Names in 'single quotes' are checked exactly as written. <a href="/help#writing" target="_blank">Tips</a></span></label>
      <label><span>What actually happens <span class="opt">optional</span></span>
        <textarea name="actual" rows="2" placeholder="There is no Export button; only 'Add Customer' is shown.">${v(c?.reported)}</textarea>
        <span class="hint">What you saw. Shown in the report next to what the bot finds.</span></label>
      <label><span>Steps to reproduce <span class="opt">optional</span></span>
        <textarea name="steps" rows="4" placeholder="1. Open the customers page\n2. Click 'Filter'">${raw ? v(c?.steps) : v(c?.steps.map((x, i) => `${i + 1}. ${x}`))}</textarea>
        <span class="hint">Leave empty if the problem is visible as soon as the page opens. One step per line, in plain words, as you would write them in Jira: <i>Navigate to Orders page</i>, <i>Click the Sort button</i>, <i>Add a product to the cart</i>.</span></label>
      <div class="grid2">
        <label>Priority <select name="priority">${['', 'High', 'Medium', 'Low'].map((p) => `<option ${c?.priority === p ? 'selected' : ''} value="${p}">${p || '—'}</option>`).join('')}</select></label>
        <label><span>ID <span class="opt">optional</span></span><input name="id" value="${v(c?.id)}" placeholder="Leave empty to get ISSUE-${s.cases.length + 1}" maxlength="40"></label>
      </div>
      <details${c?.preconditions || c?.scenario ? ' open' : ''}><summary>More fields</summary><div class="stack" style="margin-top:10px">
        <label>Group / scenario <input name="scenario" value="${v(c?.scenario)}" list="scenarios" placeholder="Customers page"><datalist id="scenarios">${scenarios.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
        <label>Preconditions <input name="preconditions" value="${v(c?.preconditions)}" placeholder="Store has at least one customer"></label>
      </div></details>
      <div class="toolbar">
        <button class="primary" name="then" value="save">${editing ? 'Save changes' : 'Add case'}</button>
        <button name="then" value="run">${editing ? 'Save' : 'Add'} and check it now</button>
        ${editing ? '' : '<button name="then" value="another">Add and add another</button>'}
        <a class="button" href="/suites/${s.id}">Cancel</a>
      </div>
    </form>
    ${editing ? `<div class="danger-zone"><form method="post" action="/suites/${s.id}/issues/${encodeURIComponent(editing.id)}/delete" class="inline" onsubmit="return confirm(${jsq(`Delete ${editing.id}? ${editing.manual ? 'This cannot be undone.' : 'It will stay hidden when the sheet is re-read.'}`)})"><button class="danger">Delete this case</button></form></div>` : ''}
    <script>
      // Point at the field the error is about.
      (function () {
        const msg = document.querySelector('.alert[role=alert]');
        if (!msg) return;
        const t = msg.textContent;
        const name = /title/i.test(t) ? 'title' : /page link|https/i.test(t) ? 'url' : /should happen|Expected/i.test(t) ? 'expected' : /\bID\b/.test(t) ? 'id' : '';
        const el = name && document.querySelector('[name=' + name + ']');
        if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
      })();
    </script>`,
    { section: 'suites' },
  );
}

// ── Help: a guide for people who have never used the tool ─────────────

/** A small example sheet people can copy. */
export const SAMPLE_CSV = [
  'TC ID,URL,Test Case,Priority,Test Steps,Expected Result',
  `TC-1,/dashboard/products,Products page opens,High,"1. Open the products page
2. Wait for the page to finish loading","• The page title 'Products' should be shown.
• The buttons 'Add Product' and 'Bulk Create' should be visible.
• The page should load without errors."`,
  `TC-2,/dashboard/orders,Orders page has no broken numbers,Medium,1. Open the orders page,"• The page title 'Orders' should be shown.
• The page should not show NaN or undefined values."`,
  `TC-3,https://slshop.cloud/dashboard/customers,Customers can be exported,Low,1. Open the customers page,• An 'Export page' button should be visible.`,
].join('\n');

/** The worked example's 4 cases, as shown on the help page and the example suite page. */
function exampleTable(): string {
  return `<table class="stack-sm example-cases"><thead><tr><th>ID</th><th>Page</th><th>Steps</th><th>Expected result</th></tr></thead><tbody>
        ${EXAMPLE_CASES.map((c) => `<tr><td><b>${esc(c.id)}</b><div class="sub">${esc(c.title)}</div></td><td><code>${esc(c.url)}</code></td><td>${c.steps.map((x) => esc(x)).join('<br>')}</td><td>${c.expected.map((x) => `• ${esc(x)}`).join('<br>')}${c.reported ? `<div class="sub">What the tester saw: ${esc(c.reported)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
}

/** The example suite, filled in and ready: one click on Add suite creates it. */
export function examplePage(existingId?: string): string {
  return layout(
    'Example suite',
    `<p class="crumbs"><a href="/">Suites</a> /</p>
    <div class="page-head"><div><h1>${esc(EXAMPLE_SUITE_NAME)}</h1>
      <p class="sub">Typed in by hand · start page <code>/dashboard</code> · ${EXAMPLE_CASES.length} cases. They only open pages and read them; nothing in the store changes. EX-4 fails on purpose.</p></div></div>
    ${existingId ? `<div class="alert info" role="status">You already have this suite. Adding it again puts back any example case you deleted and keeps your own changes. <a href="/suites/${existingId}">Open it</a></div>` : ''}
    <section class="card example">
      ${exampleTable()}
      <form method="post" action="/help/example" class="toolbar"><button class="primary">＋ Add suite</button><a class="button" href="/help#example">Read the guide</a></form>
    </section>`,
    { section: 'suites' },
  );
}

export function helpPage(): string {
  return layout(
    'How to use',
    `<article class="help">
    <div class="page-head"><div><h1>Full reference</h1><p class="sub">Everything SL QA does, in detail. For a one-minute overview, see the <a href="/guide">Guide</a>.</p></div></div>
    <p class="lead">SL QA is a robot tester for the slshop.cloud dashboard. You give it a list of things that <b>should</b> be true, such as <i>"the Add Product button is visible"</i>. It opens each page in a real browser, logged in as the store owner, and checks them one by one. Then it writes a report: what works, what doesn't, and where the problem is.</p>
    <p>You don't need to write any code. If you can fill in a spreadsheet, you can use it. It follows fixed rules first, so the same list gives the same answer every time. Only when a sentence is outside its rules, or a step fails on the page, does it ask an AI for help (if an AI key is set; see <a href="#ai">AI help</a>). Pass and Fail always come from the bot's own checks.</p>

    <section id="example" class="example"><h2><span class="num">★</span> Try it: a worked example</h2>
      <p>The quickest way to learn SL QA is to run something small and look at the result. This example has <b>4 cases</b> about real slshop.cloud pages. Three pass, and one <b>fails on purpose</b> so you can see what a problem looks like and how to fix it. It only opens pages and reads them; nothing in the store changes.</p>

      <h3>Step 1: Create the example suite</h3>
      <p><a class="button primary" href="/example">＋ Open the example suite</a> <span class="sub">It opens the suite already filled in; click <b>Add suite</b> there. Or <a href="/help/example.csv" download>download it as a sheet</a> and add it yourself, as in steps 1–2 below.</span></p>
      <p>It holds these 4 cases. Each row is one case: <i>go to this page, do these steps, this should be true</i>.</p>
      ${exampleTable()}
      <p class="sub">Notice the <b>'single quotes'</b> around button and title names. That tells the bot exactly what to look for on the page.</p>

      <h3>Step 2: Run it</h3>
      <ol>
        <li>On the suite page, all 4 cases are ticked. The <b>Understood</b> column says <span class="ok">✓ all</span> for each, so the bot can read every sentence.</li>
        <li>Click <b>▶ Run all 4</b>. The run page opens and shows which case is being checked.</li>
        <li>Wait about <b>1–2 minutes</b> (around 20 seconds per case).</li>
      </ol>

      <h3>Step 3: Read the result</h3>
      <p>When it finishes, you should see <span class="count pass">3 Pass</span> <span class="count fail">1 Fail</span>, and the status <b>Finished · issues found</b>.</p>
      <table class="stack-sm"><thead><tr><th>Case</th><th>Result</th><th>What it means</th></tr></thead><tbody>
        <tr><td><b>EX-1</b> Orders page</td><td>${verdictBadge('Pass')}</td><td>The title 'Orders' was on the page, and the page loaded with no errors and no failed requests.</td></tr>
        <tr><td><b>EX-2</b> Products buttons</td><td>${verdictBadge('Pass')}</td><td>Both buttons were found.</td></tr>
        <tr><td><b>EX-3</b> Filter panel</td><td>${verdictBadge('Pass')}</td><td>The bot clicked <i>Filter</i> (a <b>step</b>), then found the <i>Done</i> button in the panel that opened.</td></tr>
        <tr><td><b>EX-4</b> Customers export</td><td>${verdictBadge('Fail')}</td><td>There is no button called 'Export Customers CSV' on that page.</td></tr>
      </tbody></table>
      <p>Click <b>View report</b>. Under <b>Findings</b>, EX-4 reads like this:</p>
      <div class="finding-demo">
        <p><b>EX-4: Customers page has a CSV export button</b></p>
        <ul>
          <li><b>Reported by the tester:</b> I could not find a button to export customers as CSV.</li>
          <li><b>Expected:</b> 'Export Customers CSV' is shown<br>
            <b>Actual:</b> not on the page (closest on the page: 'Customers', 'Export page', 'Customers List')<br>
            <b>Likely cause:</b> The text or control the sheet names is missing, renamed or hidden on this page.</li>
        </ul>
        <p class="sub">…followed by a screenshot of the page.</p>
      </div>
      <p>The useful part is <b>"closest on the page"</b>. The bot didn't just say "missing"; it lists what it <i>did</i> find. Here, <b>'Export page'</b> is the real name of the button. So you now know one of two things: the button was named differently than you thought, or it was renamed and that's the bug to report.</p>
      <p class="sub">Your numbers may differ slightly if the site has changed since this guide was written. That's what the tool is for.</p>

      <h3>Step 4: Fix the case and run it again</h3>
      <ol>
        <li>Go back to the suite and click <b>Edit</b> on <b>EX-4</b>.</li>
        <li>In <b>Expected result</b>, change <code>'Export Customers CSV'</code> to <code>'Export page'</code>, then click <b>Save and check it now</b>.</li>
        <li>The new run shows EX-4 as ${verdictBadge('Pass')}. This is the normal loop: run, read the finding, then either fix the case (if your wording was off) or report the bug (if the site is wrong).</li>
      </ol>
      <p>That new run also shows a <b>Since the previous run</b> box at the top: ✅ <i>No longer failing: EX-4 (was Fail …)</i>. SL QA compares each case with its last result, so you can see at a glance what a fix changed.</p>

      <h3>Step 5: Paste a bug straight from Jira</h3>
      <p>Most bugs are already written up in Jira. Here is one about the POS page, exactly as a tester wrote it:</p>
      <pre class="jira">${esc(EXAMPLE_JIRA)}</pre>
      <ol>
        <li>In the example suite, click <b>＋ Add case</b>.</li>
        <li>Copy the text above into <b>Paste a bug report</b> and click <b>Fill the form from it</b>. The page becomes <code>/dashboard/pos</code>, with 5 steps and 2 expected results.</li>
        <li>Click <b>Add and check it now</b>.</li>
      </ol>
      <p>It comes back ${verdictBadge('Fail')} with two findings that read like this:</p>
      <div class="finding-demo"><ul>
        <li><b>Expected:</b> Names wrap up to 2 lines and stay readable<br><b>Actual:</b> 12 of 17 names are cut off (limited to 1 line), e.g. 'De'Amira Vacation Lashes - Pre-Glued' …</li>
        <li><b>Expected:</b> An empty side panel can be collapsed or leaves room for the main content<br><b>Actual:</b> the right panel is 480px wide (33% of a 1440px screen) while empty; no collapse or hide control</li>
      </ul></div>
      <p>Nothing was rewritten: the bot read the steps and expected result as the tester wrote them, and measured the page. See <a href="#paste">Paste a bug report from Jira</a> for every kind of step and expected result it understands.</p>

      <h3>Step 6: Now write your own</h3>
      <p>In the same suite, click <b>＋ Add case</b> and copy this pattern for a page you know:</p>
      <div class="pattern">
        <p><b>Title:</b> <span class="fill">What you're checking, in a few words</span></p>
        <p><b>Page link:</b> <span class="fill">/dashboard/…</span> <span class="sub">(open the page in slshop.cloud and copy the address)</span></p>
        <p><b>Steps</b> <span class="sub">(optional)</span>: <span class="fill">1. Click 'Some button'</span></p>
        <p><b>Expected result:</b> <span class="fill">• The 'Exact text on screen' button should be visible.</span></p>
      </div>
      <p>Then click <b>Add and check it now</b>. Some good first ideas:</p>
      <ul>
        <li><code>/dashboard</code>: <code>• The page should load without errors.</code></li>
        <li><code>/dashboard/orders</code>: <code>• The page should not show NaN or undefined values.</code></li>
        <li>Any page with a search box: <code>1. Type 'tuna' in search</code> → <code>• The page should load without errors.</code></li>
      </ul>
      <p>If the <b>Understood</b> column shows a <b>?</b>, open <b>How the bot reads it</b> and reword that sentence (see <a href="#writing">Writing sentences the bot understands</a>). When you're comfortable, move your real cases into a Google Sheet and add it as a suite (<a href="#sheet">steps 1–2</a>).</p>
      <p class="sub">Done with the example? Open the suite, then <b>Suite settings</b> → <b>Delete suite</b>. You can create it again from here at any time.</p>
    </section>

    <section class="glance"><h2>The whole thing in 30 seconds</h2>
      <ol class="flow">
        <li><b>Make a list</b><span>A Google Sheet, an Excel/CSV file, typed into the app, or a bug report pasted from Jira. One row = one case.</span></li>
        <li><b>Add it as a suite</b><span>On <a href="/">Suites</a>, under <i>Add a test suite</i>.</span></li>
        <li><b>Press Run</b><span>The robot visits each page and checks it. About 10–60 seconds per case.</span></li>
        <li><b>Read the report</b><span>Pass, Fail and the reason, with screenshots.</span></li>
      </ol>
    </section>

    <nav class="toc" aria-label="On this page"><b>On this page</b>
      <a href="#example"><b>Try it: a worked example</b></a><a href="#sheet">1. Prepare your list</a><a href="#add">2. Add a suite</a><a href="#check">3. Check the bot understood it</a>
      <a href="#run">4. Run the checks</a><a href="#report">5. Read the results</a><a href="#manage">Add, edit or delete cases</a><a href="#paste"><b>Paste a bug report from Jira</b></a><a href="#form">Testing the Add Product form</a><a href="#assistant"><b>The Assistant</b></a><a href="#ai"><b>AI help for anything else</b></a><a href="#writing">Writing sentences the bot understands</a><a href="#faq">Questions and problems</a><a href="#words">Words used in the app</a>
    </nav>

    <section id="sheet"><h2><span class="num">1</span> Prepare your list</h2>
      <p>Use Google Sheets or Excel. Each <b>row</b> is one <b>case</b>: one test case or one bug report. The first row holds the column names. Column names are not case-sensitive, and the alternatives in brackets work too.</p>
      <table class="stack-sm"><thead><tr><th>Column</th><th>Needed?</th><th>What to put in it</th></tr></thead><tbody>
        <tr><td><b>Expected Result</b> <span class="sub">(Expected, Expected Behaviour)</span></td><td>Yes*</td><td>What <i>should</i> happen. One point per line, starting with <code>•</code>. Example: <code>• The 'Add Product' button should be visible.</code></td></tr>
        <tr><td><b>URL</b> <span class="sub">(Page, Link, Page URL)</span></td><td>Recommended</td><td>The dashboard page to check: the full link (<code>https://slshop.cloud/dashboard/orders</code>) or just the end of it (<code>/dashboard/orders</code>). If it's empty, the bot looks for a slshop.cloud link in the rest of the row, and otherwise uses the suite's <b>start page</b>.</td></tr>
        <tr><td><b>TC ID</b> <span class="sub">(ID, Bug ID, Issue ID)</span></td><td>No</td><td>A short name, such as <code>TC-1</code> or <code>BUG-12</code>. If it's empty, the row is called <code>ROW-5</code> (its row number in the sheet).</td></tr>
        <tr><td><b>Test Case</b> <span class="sub">(Title, Summary, Issue)</span></td><td>No</td><td>A one-line title.</td></tr>
        <tr><td><b>Test Steps</b> <span class="sub">(Steps, Steps to Reproduce)</span></td><td>No</td><td>What to do on the page before checking, one step per line: <code>1. Click 'Filter'</code>.</td></tr>
        <tr><td><b>Actual Result</b> <span class="sub">(Actual)</span></td><td>No</td><td>What a person saw. It's shown in the report next to what the bot found.</td></tr>
        <tr><td><b>Description</b> <span class="sub">(Bug Report, Details)</span></td><td>No</td><td>A whole bug report in one cell, copied from Jira: <i>Pre-condition</i>, <i>Steps to reproduce</i>, <i>Actual result</i>, <i>Expected result</i>. The bot reads the sections out of it (see <a href="#paste">Paste a bug report</a>). A sheet with only <b>Title</b> and <b>Description</b> columns works.</td></tr>
        <tr><td>Priority, Test Scenario, Preconditions, Test Data</td><td>No</td><td>Shown in the report. <i>Test Scenario</i> groups cases so you can run one group. <i>Test Data</i> values in quotes are used by "type …" steps.</td></tr>
      </tbody></table>
      <p class="sub">* A row needs an Expected Result, a Description with an expected result in it, <b>or</b> a URL. A row with only a URL still gets a page-health check (see step 5).</p>
      <p><a class="button" href="/help/sample.csv" download>⬇ Download a sample sheet</a> <span class="sub">Open it in Google Sheets or Excel and replace the rows with your own.</span></p>
      <div class="tip"><b>Using Google Sheets?</b> Click <b>Share</b> → <b>General access</b> → <b>Anyone with the link</b> → <b>Viewer</b>. Otherwise SL QA can't read it.</div>
    </section>

    <section id="add"><h2><span class="num">2</span> Add a suite</h2>
      <p>A <b>suite</b> is one list of cases, such as "Products page" or "Bugs from QA round 3".</p>
      <ol>
        <li>Go to <a href="/">Suites</a> and click <b>＋ New suite</b>, or scroll to <b>Add a test suite</b>.</li>
        <li>Give it a <b>Name</b>.</li>
        <li>Under <b>Where are the cases?</b>, choose one:
          <ul>
            <li><b>Google Sheet</b>: paste the link. Copy it from the browser's address bar while the right tab of the sheet is open.</li>
            <li><b>Upload a file</b>: choose a <code>.csv</code> or <code>.xlsx</code> file. Only the first worksheet is read.</li>
            <li><b>Type them in by hand</b>: starts an empty suite and opens the <b>Add a case</b> form straight away.</li>
          </ul></li>
        <li><b>Start page</b>: leave <code>/dashboard/products</code> unless most of your cases have no URL. In that case, enter the page they're about, such as <code>/dashboard/orders</code>. You can change it later under <b>Suite settings</b>.</li>
        <li>Click <b>Add suite</b>. If something is wrong, such as a private sheet, a message explains how to fix it and what you typed is kept.</li>
      </ol>
    </section>

    <section id="check"><h2><span class="num">3</span> Check the bot understood it</h2>
      <p>The suite page lists every case. The <b>Understood</b> column shows how much of each case the bot can read:</p>
      <ul>
        <li><span class="ok">✓ all 8</span>: the bot understands every sentence.</li>
        <li><span class="warn">2 of 8 not understood</span>: open <b>How the bot reads it</b> under the case title to see which sentences are marked <b>?</b>.</li>
      </ul>
      <p>Each understood sentence shows how the bot will check it. Labels starting with <b>page check:</b> mean the bot checks the page directly: is the quoted text there, are there errors, does it redirect to login.</p>
      <p>Cases with <b>?</b> sentences still run. With an AI key set, the AI works those sentences out during the run (see <a href="#ai">AI help</a>); without one, the bot skips them and says so in the results. To make them exact, reword them (see <a href="#writing">tips</a>) in the sheet and click <b>↻ Re-read sheet</b>, or click <b>Edit</b> on the case.</p>
    </section>

    <section id="run"><h2><span class="num">4</span> Run the checks</h2>
      <ol>
        <li>Tick the cases to check. All are ticked at first, and the button says <b>▶ Run all 32</b>. Untick some and it changes to <b>▶ Run 5 selected</b>.</li>
        <li>Optional: if the cases have more than one <b>Scenario</b>, pick one from the list to tick just that group.</li>
        <li>Click the <b>Run</b> button. The run page opens and updates by itself, showing which case is being checked. You can <b>Cancel run</b> at any time.</li>
      </ol>
      <div class="tip">Only one run happens at a time, because the checks change shared store data. If someone else is running checks, yours shows <b>Waiting</b> until it's their turn. You can close the page; the run keeps going. Find it again under <a href="/runs">Runs</a>.</div>
    </section>

    <section id="report"><h2><span class="num">5</span> Read the results</h2>
      <p>When the run finishes, the run page shows a count of each result and a <b>Problems found</b> list. Click <b>View report</b> for the full, readable report. Every case gets one result:</p>
      <table><tbody>
        <tr><td>${verdictBadge('Pass')}</td><td>Everything in Expected Result was checked and is correct.</td></tr>
        <tr><td>${verdictBadge('Fail')}</td><td><b>Something is wrong on the site.</b> These are the problems to fix.</td></tr>
        <tr><td>${verdictBadge('Review')}</td><td><b>Look at this one.</b> A check the AI wrote did not hold, or the case passed only on checks the AI wrote (<span class="tag ai">AI-checked</span>). It may be a real bug, the AI may have misread the sentence, or its check may be too weak. Open the screenshot, then either report the bug or correct the check under <i>Review rewrites</i>.</td></tr>
        <tr><td>${verdictBadge('Partial')}</td><td>Everything the bot could check was correct, but some points couldn't be checked. The reason is shown; check those yourself.</td></tr>
        <tr><td>${verdictBadge('Blocked')}</td><td>The check needs something that doesn't exist, such as a staff account or an empty store.</td></tr>
        <tr><td>${verdictBadge('Error')}</td><td>The robot itself had a problem. This is not a problem with the site; try again.</td></tr>
      </tbody></table>
      <p>The report has these parts, in this order:</p>
      <ol>
        <li><b>Summary</b>: one line per case with its result and the main problem.</li>
        <li><b>Findings</b>: for each failed case, the <b>Expected</b> result, the <b>Actual</b> result (if a button or text is missing, the closest things it found, which often means it was renamed), the <b>Likely cause</b>, <b>Where it shows up</b> (clues for developers, such as a request that failed: <code>500 GET /orders</code>), and a screenshot.</li>
        <li><b>Other problems seen on the pages</b>: cases that passed, but whose page had errors anyway.</li>
        <li><b>Slow requests</b>: parts of the site that took more than 3 seconds to load. It's not a failure, but the page feels slow.</li>
        <li><b>Details</b>: for every case, the <b>Page health</b> check, the steps the robot took, every check with its result, and screenshots.</li>
      </ol>
      <p><b>Page health</b> runs on every case, even if your list didn't ask for it. The robot opens the page and records how long it took, any errors in the browser, any part that failed to load, broken images, and error messages on screen such as "Something went wrong" or "NaN".</p>
      <p>On the run page you can also:</p>
      <ul>
        <li><b>⬇ Download report (.md)</b>: save or share the report as a file. <b>Print / save as PDF</b> on the report page makes a PDF.</li>
        <li><b>↻ Run again</b>: check the same cases again, for example after a fix. If you run a suite again, the run page shows <b>Since the previous run</b>: what newly fails and what's fixed.</li>
        <li><b>↻ Re-run failed only</b>: check just the cases that failed or are marked Review.</li>
        <li><b>Fix prompt</b> (under each failed case): text a developer can paste straight into their tools.</li>
      </ul>
    </section>

    <section id="site"><h2>The site map</h2>
      <p>SL QA keeps a <b>site map</b> of the dashboard, made by a read-only crawler (labels only, no store data). The Assistant answers from it, and steps can use any page name from it, such as <code>Open Products › Categories</code> or <code>Go to Settings &gt; Tax</code>. It is crawled again when it is over 7 days old. To look for bugs on a page without writing cases, ask the Assistant to <b>Find a bug</b> (see <a href="#assistant">The Assistant</a>).</p>
    </section>

    <section id="manage"><h2>Add, edit or delete cases</h2>
      <p>You don't need a sheet for every bug. You can type cases straight into SL QA.</p>
      <ul>
        <li><b>Add a case:</b> open a suite and click <b>＋ Add case</b>. Already have the bug in Jira? Paste it into <b>Paste a bug report</b> at the top and click <b>Fill the form from it</b> (see <a href="#paste">below</a>). Otherwise fill in a <b>Title</b> and the <b>Expected result</b> (what should happen). The <b>Page link</b> is required in a suite typed by hand; in a sheet suite, an empty link means the suite's start page. You can also add what actually happens, the steps, a priority and an ID. Then:
          <ul>
            <li><b>Add case</b>: save it.</li>
            <li><b>Add and check it now</b>: save it and run it straight away.</li>
            <li><b>Add and add another</b>: save it and open an empty form for the next one.</li>
          </ul>
          If something is missing, the form says what and highlights the field; nothing you typed is lost.</li>
        <li><b>Edit:</b> click <b>Edit</b> on the case's row. If it came from a sheet, your version is kept when the sheet is re-read, and the row is marked <span class="tag">edited here</span>.</li>
        <li><b>Delete one:</b> click <b>Delete</b> on its row, or <b>Delete this case</b> at the bottom of its edit page.</li>
        <li><b>Delete several:</b> tick them and click <b>Delete selected</b> (above the list). If everything is ticked, it warns you that this is the whole suite.</li>
        <li><b>Delete everything:</b> open <b>Suite settings</b> at the bottom of the suite page. <b>Delete all cases</b> empties the suite but keeps it. <b>Delete suite</b> removes the suite; its past runs stay under <a href="/runs">Runs</a>.</li>
        <li><b>Delete a run</b>, with its report and screenshots: open the run and click <b>Delete run</b>.</li>
      </ul>
      <div class="tip">Rows deleted from a Google Sheet suite stay hidden when you click <b>Re-read sheet</b>, and the suite page shows how many are hidden. To get one back, click <b>＋ Add case</b> and enter it again with the same ID. Cases you deleted that were typed in by hand can't be recovered.</div>
    </section>

    <section id="paste"><h2>Paste a bug report from Jira</h2>
      <p>You don't have to rewrite bugs for the bot. Copy the description from Jira (or an email or chat) and paste it as it is:</p>
      <ol>
        <li>Open a suite, click <b>＋ Add case</b>.</li>
        <li>In <b>Paste a bug report</b> at the top, paste the whole text, title included.</li>
        <li>Click <b>Fill the form from it</b>. The title, page, steps, actual and expected results are filled in for you. Check them, then click <b>Add and check it now</b>.</li>
      </ol>
      <p>The bot looks for these headings (upper or lower case, with or without the colon):</p>
      <table class="stack-sm"><thead><tr><th>Heading</th><th>What it becomes</th></tr></thead><tbody>
        <tr><td>First line, or <code>Summary:</code></td><td>The title.</td></tr>
        <tr><td><code>Pre-condition:</code></td><td>Preconditions. "Sign in to ShopLagbe" needs nothing: the bot is always logged in.</td></tr>
        <tr><td><code>Steps to reproduce:</code></td><td>The steps, one per numbered line. Repeated numbers (two "5.") are fine.</td></tr>
        <tr><td><code>Actual result:</code></td><td>What the tester saw, shown in the report.</td></tr>
        <tr><td><code>Expected result:</code></td><td>What the bot checks. A paragraph is split into its separate points.</td></tr>
      </tbody></table>
      <p>The <b>page</b> comes from the step that says where to go (<i>Navigate to Create order/POS page</i> → <code>/dashboard/pos</code>), or from a slshop.cloud link. References like <code>Please see [^bug 2.png]</code> are ignored.</p>

      <h3>Steps the bot can follow</h3>
      <table class="stack-sm"><thead><tr><th>You write</th><th>The bot does</th></tr></thead><tbody>
        <tr><td><code>Go to https://slshop.cloud/dashboard</code>, <code>Go to ShopLagbe: merchant dashboard</code></td><td>Opens the dashboard.</td></tr>
        <tr><td><code>Navigate to Create order/POS page</code>, <code>Navigate to Orders page</code></td><td>Opens that page (any name from the left menu works).</td></tr>
        <tr><td><code>Add a product to the cart (e.g; Stun Gun …)</code></td><td>On POS, clicks <b>Add</b> on that product, or on the first product in stock if it isn't in the store (the report says so).</td></tr>
        <tr><td><code>Click Checkout button to open the form</code>, <code>Click the Sort button at the top</code></td><td>Clicks the button with that name. Extra words after the name ("Checkout ৳650.00") are fine.</td></tr>
        <tr><td><code>Fill up all the required fields</code></td><td>Fills the form with a test customer: <b>BTB Test</b>, 01700000000, House 1, Road 1, Gulshan, Dhaka.</td></tr>
        <tr><td><code>Type a value that exceeds the total (e.g., type 900 …)</code></td><td>Types 900 into the field just opened (or the discount field). If 900 isn't more than the real total, it types total + 100 and says so. It records what the field kept, the total before and after, and any message.</td></tr>
        <tr><td><code>Click the Place order button</code></td><td><b>Places a real order</b> on the test store and records its number, total and discount.</td></tr>
        <tr><td><code>Check the receipt</code></td><td>Opens that order and takes a screenshot.</td></tr>
        <tr><td><code>Click the Sort button … and select a different sorting rule</code></td><td>Picks another sort option and remembers which card was #1, #2 … before and after.</td></tr>
        <tr><td><code>View …</code>, <code>Observe …</code>, <code>Locate …</code>, <code>Look at …</code>, <code>Note …</code></td><td>Looks only. The check happens in the expected result.</td></tr>
      </tbody></table>

      <h3>Expected results the bot can judge</h3>
      <table class="stack-sm"><thead><tr><th>Kind of expected result</th><th>What the bot measures</th></tr></thead><tbody>
        <tr><td>"The field should <b>block</b> inputs that <b>exceed</b> the total"</td><td>After the typing step: did the field refuse or cap the value, or show a message? Includes the saved order if one was placed.</td></tr>
        <tr><td>"The system should show an <b>alert</b> / error message"</td><td>Pop-up messages, alerts, red helper text and fields marked invalid that appeared after the last typing.</td></tr>
        <tr><td>"The <b>total</b> should not be ৳0 / negative"</td><td>The amount next to <i>Total</i>.</td></tr>
        <tr><td>"Titles should <b>wrap</b> up to 2 lines / be readable"</td><td>Every shortened name on the page: how many are cut off, and to how many lines.</td></tr>
        <tr><td>"The panel should be <b>collapsible</b> / the grid should use the <b>full width</b>"</td><td>The width of the right-hand panel, whether it is empty, and whether it has a collapse button.</td></tr>
        <tr><td>"Show the <b>price range</b> from the variants instead of 0.00"</td><td>Every variable product in the store: its card price against its variants' prices.</td></tr>
        <tr><td>"The position <b>numbers</b> should <b>follow</b> the cards after sorting"</td><td>Each card's #N before and after the sort.</td></tr>
        <tr><td>Anything with <b>'quoted text'</b>, "no errors", "no NaN", "redirect to login"</td><td>Checked on the page directly (see <a href="#writing">Writing sentences</a>).</td></tr>
      </tbody></table>
      <p>Open <b>How the bot reads it</b> under a case to see which rule each sentence got. A <b>?</b> means the rules don't cover it: the AI handles it during the run if a key is set, otherwise it is skipped and the report says so. Every check in the report shows the numbers it measured, so you can judge it yourself.</p>
      <div class="tip"><b>Heads-up:</b> a step like <i>Click the Place order button</i> really places an order on the test store, for the customer <b>BTB Test</b>. The report gives the order number. The cart is emptied when the case ends.</div>
    </section>

    <section id="form"><h2>Testing the Add Product form</h2>
      <p>Cases whose steps open the product form (<i>click the 'Add Product' button</i>, <i>Click 'Edit' on a product</i>, <i>Click 'Save Product'</i>) are read with the form's own rules. They work with the wording QA sheets already use:</p>
      <table class="stack-sm"><thead><tr><th>You write</th><th>The bot does</th></tr></thead><tbody>
        <tr><td><code>Type the Product Name</code>, <code>Type the Selling Price</code>, <code>Fill name and price</code></td><td>Types the values from the <b>Test Data</b> column (<code>Name: 'Test Soap'</code>, <code>Price 500, Cost 350</code>), or a sensible value when there is none.</td></tr>
        <tr><td><code>Enter Selling Price 100 and Cost Price 150</code>, <code>Enter Min Qty 10, Max Qty 50 …</code></td><td>Types the numbers given in the sentence.</td></tr>
        <tr><td><code>Open 'Pricing details'</code>, <code>Open 'Additional data'</code></td><td>Opens that part of the form. Old names still work: <i>Description &amp; labels</i> → Basic Info, <i>Photos</i> → Gallery, <i>Pricing details</i> → Pricing.</td></tr>
        <tr><td><code>Leave Product Name … empty and click 'Save Product'</code>, <code>Enter each invalid value one by one in …</code></td><td>Tries each value from Test Data (<code>Negative: -10 / Text: abc</code>) in each field, saving after each, and records what was kept, what was saved and the message shown.</td></tr>
        <tr><td><code>Choose Variable</code>, <code>Choose attribute Color (Red, Blue) and Size (S, M)</code>, <code>Choose 'Price per variation' …</code></td><td>Builds the variations and fills each row's price, SKU and stock.</td></tr>
        <tr><td><code>Upload 3 valid images</code>, <code>Try a 5MB image</code>, <code>Try a .gif</code></td><td>Uploads test images the bot makes itself (right size and type), and notes whether each was accepted and why not.</td></tr>
        <tr><td><code>Click 'Create new category' and enter a name</code></td><td>Creates it from the dropdown, named <code>BTB &lt;case&gt; …</code>, and deletes it afterwards.</td></tr>
        <tr><td><code>Sell 1 unit through POS</code>, <code>In POS, add 10 units of this product</code></td><td>Sells the saved product at the counter (Store tab, no customer) and reads the stock before and after.</td></tr>
      </tbody></table>
      <p>Expected results it checks include: <i>should (not) be saved</i>, <i>a message should say '…'</i> (it accepts the same meaning in other words, such as "already in use" for "must be unique"), <i>listed as Active and Simple with price ৳120.00</i>, <i>a storefront URL should be created from the name</i>, <i>Options should be: pcs, kg, …</i>, <i>counters x/60</i>, <i>Profit per unit should show −৳50 with a warning</i>, <i>only one product should be created</i>, and the variation, stock, wholesale and image checks.</p>
      <div class="tip"><b>What it creates, and cleans up.</b> Every product it saves is named <code>BTB &lt;case id&gt; …</code> (for example <code>BTB AP-001 Test Soap</code>) and archived when the case ends. Categories, brands, labels and attribute values it creates are removed too. POS sales made by a case are real orders on the test store; their numbers are in the report.</div>
      <p><b>Checked by hand, on purpose.</b> The bot never presses <b>Generate</b> in <i>Write with AI</i>, because each use is charged to the store wallet. It doesn't test two browser tabs editing the same product, or logging out mid-save. New products take a while to appear on the storefront, so storefront checks on a just-saved product are marked <b>not checked</b>, not failed.</p>
    </section>

    <section id="ai"><h2>AI help for anything else</h2>
      <p>The bot has built-in rules for the pages it knows well. For everything else it gets help from an AI, <b>automatically, during the run</b>:</p>
      <ol>
        <li><b>A sentence it doesn't understand:</b> the AI reads it together with the case's title, preconditions, test data and <i>what is on the screen right now</i>, and turns it into simple steps. The bot does them straight away.</li>
        <li><b>A step that fails on the page</b> (button not found, dialog not open, renamed label): the AI looks at the page (and a screenshot, when the provider can read images) and suggests a corrected step, and the bot tries it. The first provider gets 1 try for a simple step and 2 for a complex one (inside a row or dialog, a dropdown, an upload, or several matching buttons). If those fail, one more try goes to the next provider. The report keeps the original problem visible as "not checked", so a renamed button is never hidden.</li>
        <li><b>An expected result it doesn't understand:</b> the AI turns it into checks the bot can measure (text shown, button visible, a number next to a label). It opens the tab the check is about first. For "should increase by 5" or "should change", it remembers the value <i>before</i> the steps and compares afterwards.</li>
      </ol>
      <p>In the results, these steps carry an <span class="tag ai">AI</span> badge, and the case says <span class="tag ai">AI helped</span>. Pass and Fail are always decided by the bot's own checks, never by the AI.</p>
      <div class="tip"><b>Make it faster and repeatable.</b> Everything the AI worked out is saved as a suggestion. Open <b>Review rewrites</b> on the suite, check it, and click <b>Approve</b>. From then on the bot uses it directly, with no AI call, and gets the same result every time.</div>
      <p><b>Safety.</b> When AI-driven steps would change a product (price, stock, status, channels), the bot first makes its own test product, <code>BTB &lt;case&gt; AI test item</code>, uses only that, and archives it afterwards. Real products are not touched. The code itself also refuses risky clicks from AI steps (Delete, Archive, Refund, Place order, Log out, Generate, Bulk actions…) unless they are on a <code>BTB</code> test record; refused steps show as skipped. The AI is not used at all when no AI key is set.</p>
      <p class="sub">Limits per case: at most 12 AI calls for steps and 12 for checks (<code>AI_MAX_CALLS_PER_CASE</code>), and at most 240 seconds of AI time (<code>AI_MAX_SECONDS_PER_CASE</code>). <code>AI_REPAIR_TRIES</code> caps the repair tries (0 = fallback try only) and <code>AI_VISION=off</code> stops sending screenshots. To switch live help off but keep the review page, set <code>AI_LIVE=off</code>.</p>
      <h3>The step language</h3>
      ${ACTION_HELP}
      <h3 id="ai-keys">AI keys: Gemini free by default, OpenAI for Super QA and bug triage, Claude optional</h3>
      <p>Put the keys in the <code>.env</code> file (next to <code>package.json</code>), then restart SL QA. The <a href="/settings/ai">AI keys</a> page shows which are set and how they are doing. SL QA tries the providers in this order and moves on when one fails (bad key, quota used up, server error):</p>
      <table class="stack-sm"><thead><tr><th>Key</th><th>.env line</th><th>Where to get it</th><th>Used for</th></tr></thead><tbody>
        <tr><td>Gemini · free · default</td><td><code>GEMINI_API_KEY=…</code></td><td>Google AI Studio → <b>Get API key</b> (aistudio.google.com/apikey)</td><td>The Assistant, AI rewrites and live help. ~15 requests/min, ~500/day.</td></tr>
        <tr><td>OpenAI · paid</td><td><code>OPENAI_API_KEY=…</code></td><td>platform.openai.com → <b>API keys</b> (needs billing)</td><td><b>Super QA</b> and <b>Find a bug</b> triage (model: <code>SUPERQA_OPENAI_MODEL</code>).</td></tr>
        <tr><td>Claude · optional</td><td><code>ANTHROPIC_API_KEY=…</code></td><td>console.anthropic.com → <b>API Keys</b> (needs billing)</td><td>A strong model for live help, and Super QA when OpenAI is not set.</td></tr>
        <tr><td>Other fallbacks</td><td><code>GROQ_API_KEY</code>, <code>OPENROUTER_API_KEY</code>, <code>MISTRAL_API_KEY</code> (free); <code>XAI_API_KEY</code>, <code>CEREBRAS_API_KEY</code> (paid)</td><td>Each provider's console → <b>API Keys</b></td><td>Tried when the ones above fail or hit their limits.</td></tr>
      </tbody></table>
      <ul>
        <li><b>Start with a free Gemini key.</b> Add an OpenAI key when you want Super QA and bug triage. The <a href="/settings/ai">AI keys</a> page shows the exact order SL QA tries them in.</li>
        <li><b>Paid fallbacks are capped.</b> They are used at most <code>AI_PAID_DAILY_LIMIT</code> times a day for live help (default 20; set 0 to never use them). Super QA is not counted.</li>
        <li><b>Change a model:</b> <code>GEMINI_MODEL</code>, <code>OPENAI_MODEL</code>, <code>ANTHROPIC_MODEL</code>, <code>GROQ_MODEL</code>, <code>OPENROUTER_MODEL</code>, <code>MISTRAL_MODEL</code>, <code>XAI_MODEL</code>, <code>CEREBRAS_MODEL</code>.</li>
        <li><b>Several keys for one provider:</b> separate them with commas. Note that Gemini limits are per Google Cloud project, so two keys from the same project don't add more.</li>
      </ul>
      <p class="sub">Without any key, everything else works as before (no AI). The sentences, the case title and the page path are sent to the provider; logins and store data are not. Free tiers may use prompts to improve their models (Google, and Mistral unless you opt out in its Admin → Privacy).</p>
    </section>

    <section id="writing"><h2>Writing sentences the bot understands</h2>
      <p>Plain sentences like the ones in a Jira report work (see the tables <a href="#paste">above</a>). When you want to be exact, these habits help most:</p>
      <table class="stack-sm"><thead><tr><th>Do</th><th>Avoid</th></tr></thead><tbody>
        <tr><td>One action per step, in the order you'd do it, including how to open hidden panels: <code>Add a product to the cart</code> → <code>Click Checkout</code> → <code>Click the Discount or coupon field</code></td><td><code>Apply a big discount at checkout</code><br><span class="sub">The bot can't fill in the clicks in between.</span></td></tr>
        <tr><td>Put exact button and text names <b>in single quotes</b> when the check is about that text:<br><code>The 'Add Product' button should be visible.</code></td><td><code>There should be a button to add products.</code></td></tr>
        <tr><td>Say what you would see: <code>An alert message should be shown</code>, <code>The total should not be ৳0.00</code></td><td><code>It should behave properly</code></td></tr>
        <tr><td><code>The page should load without errors.</code></td><td><code>Page works fine</code></td></tr>
        <tr><td>Exact steps on any page: <code>CLICK 'Save Product'</code>, <code>TYPE '100' INTO 'Selling Price'</code>, <code>EXPECT TEXT 'Product created'</code> (see <a href="#ai">the step language</a>)</td><td>Vague steps on a page the bot was never taught</td></tr>
        <tr><td><code>The page should not show NaN or undefined values.</code></td><td><code>Numbers look right</code></td></tr>
        <tr><td><code>A logged-out user should be redirected to the login page.</code></td><td><code>Login is required</code></td></tr>
      </tbody></table>
      <p>For "should not" points, quote the text: <code>The 'Delete' button should not be shown.</code></p>
    </section>

    <section id="assistant"><h2>The Assistant</h2>
      <p><a href="/chat">Assistant</a> is the main way in. It is a chat about the slshop.cloud dashboard with three jobs. It answers from what SL QA already knows: the crawled site map (pages, tabs, buttons, fields, columns), your suites and, if you give it, the app's GitHub repo. When the answer isn't there, it says so instead of guessing. It needs an AI key (see <a href="/settings/ai">AI keys</a>).</p>
      <ol>
        <li><b>Ask about slshop.cloud:</b> <i>What can I filter on the Orders page?</i></li>
        <li><b>Find a bug:</b> pick a page, module or feature (<i>Find bugs on the Eye Lens category</i>). SL QA opens it in a real, logged-in browser with DevTools capture (console errors, failed requests, slow calls), and tries its tabs, filters, sorting, search and paging. It only looks: it never saves, deletes or sends anything. Then it reports only the bugs it has evidence for, each with what it did, what happened, the captured errors and a screenshot. Click <b>Save as new suite</b> to turn the bugs into cases you can re-run after a fix.</li>
        <li><b>Generate test cases:</b> <i>Generate test cases for the POS page.</i> The answer includes a table with the sheet's columns (TC ID, URL, Test Case, Priority, Preconditions, Test Steps, Test Data, Expected Result). Edit, delete or add cases, run <b>Super QA</b>, then <b>Save as new suite</b> or <b>Download CSV</b>. Check <b>How the bot reads it</b> before running them.</li>
      </ol>
      <p><b>Super QA</b> is under any proposed cases (also after you edit them). SL QA opens their pages in a logged-in browser, looks at a real record and its Edit page when the steps need one, opens the dropdowns the cases name, and gives that (with screenshots) to a stronger model (OpenAI, then Claude). The corrected cases appear as a new answer with a <b>Super QA</b> badge and a list of what it checked; the original cases stay as they were. It takes 30–90 seconds, runs one at a time, only looks (never saves or deletes), and needs <code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>.</p>
      <p><b>Code context:</b> paste a GitHub link (<code>https://github.com/owner/repo</code>, or <code>…/tree/&lt;branch&gt;/&lt;folder&gt;</code>) and it also reads the most relevant source files: routes, pages, components, validation, tests. The files it used are listed under the answer. A private repo, or many questions an hour, needs <code>GITHUB_TOKEN</code> in <code>.env</code>. Only github.com links are accepted.</p>
      <p class="sub">The Assistant never sees your login or keys. Chats are kept under <code>data/chats/</code>; delete them from the chat list.</p>
    </section>

    <section id="faq"><h2>Questions and problems</h2>
      <dl>
        <dt>"The sheet is private" or "SL QA could not open the sheet"</dt>
        <dd>The sheet isn't shared publicly. Set it to <b>Anyone with the link → Viewer</b> (see step 1), then try again.</dd>
        <dt>"That is not a Google Sheets link"</dt>
        <dd>Copy the link from the browser's address bar while the sheet is open. It starts with <code>https://docs.google.com/spreadsheets/d/</code>.</dd>
        <dt>"No rows with an Expected Result (or URL) were found"</dt>
        <dd>Make sure the <b>first row</b> holds the column names, with no empty rows above it, and that one column is called <b>Expected Result</b> or <b>URL</b> (see the list of accepted names in step 1).</dd>
        <dt>I changed my sheet but SL QA shows the old version</dt>
        <dd>Open the suite and click <b>↻ Re-read sheet</b>. Cases you edited or added in the app are kept. For uploaded files, add a new suite with the new file.</dd>
        <dt>The Run button is greyed out</dt>
        <dd>No case is ticked, or the suite is empty. Tick at least one case, or click <b>＋ Add case</b>.</dd>
        <dt>Does it change anything on the site?</dt>
        <dd>Some checks create, edit or delete products. Everything the robot creates is named <code>BTB …</code> and archived afterwards, so you may see these in the <b>Archived</b> tab. Steps that say <i>Place order</i> create a real order for the customer <b>BTB Test</b>; the report gives its number. When AI-driven steps change a product, they use the bot's own <code>BTB &lt;case&gt; AI test item</code>. Sales through POS in a case are real orders on the test store. Just opening a page and checking it changes nothing.</dd>
        <dt>Which account does it use?</dt>
        <dd>The store owner account set up for SL QA. You don't need to log in yourself.</dd>
        <dt>A case failed, but the page looks fine to me</dt>
        <dd>Look at its screenshot and the <b>Actual</b> text. Often the list uses slightly different wording from the screen (for example 'Export CSV' vs 'Export page'). Update the list to match what the site <i>should</i> say.</dd>
        <dt>A run says "Stopped by an error"</dt>
        <dd>Something outside the site went wrong, such as a login problem or a lost connection. Click <b>↻ Run again</b>. If it keeps happening, tell whoever looks after SL QA.</dd>
      </dl>
    </section>

    <section id="words"><h2>Words used in the app</h2>
      <dl>
        <dt>Suite</dt><dd>One list of cases, from a sheet, a file, or typed in by hand.</dd>
        <dt>Case</dt><dd>One row: one test case or one bug. It has a page, optional steps, and what should happen.</dd>
        <dt>Run</dt><dd>One go of the robot through the cases you ticked. Each run has its own report.</dd>
        <dt>Start page</dt><dd>The page used for cases that don't name their own page.</dd>
        <dt>Page health</dt><dd>The automatic check of a page's errors, failed loads and speed, done for every case.</dd>
        <dt>Step language</dt><dd>Exact lines such as <code>CLICK 'Save Product'</code> or <code>EXPECT TEXT 'Saved'</code> that the bot always understands (see <a href="#ai">AI help</a>).</dd>
        <dt>AI rewrite</dt><dd>A sentence turned into step-language lines by AI. Approve it under <b>Review rewrites</b> and the bot reuses it without AI.</dd>
        <dt>Review</dt><dd>A result that needs a person: a check the AI wrote did not hold.</dd>
      </dl>
    </section>

    </article>`,
    { section: 'help' },
  );
}

export function reportPage(id: string, html: string, run?: Run): string {
  const title = run ? `Report · ${run.suiteName} · ${when(run.createdAt)}` : 'Report';
  return layout(
    title,
    `<p class="crumbs"><a href="/">Suites</a> / ${run ? `<a href="/suites/${run.suiteId}">${esc(run.suiteName)}</a> / ` : ''}<a href="/runs/${id}">Run</a> /</p>
    <div class="toolbar"><a class="button" href="/runs/${id}">← Back to run</a><a class="button" href="/runs/${id}/report.md" download>⬇ Download report (.md)</a><button type="button" onclick="print()">Print / save as PDF</button></div>
    <article class="report">${html}</article>`,
    { section: 'runs' },
  );
}

export function notFound(what = 'page'): string {
  const hint: Record<string, string> = {
    suite: 'It may have been deleted. Past runs of a deleted suite are still under Runs.',
    run: 'It may have been deleted.',
    report: 'This run has no report: it stopped before any case finished, or it was deleted.',
    case: 'It may have been deleted, or the sheet was re-read without it.',
  };
  return layout('Not found', `<div class="empty"><h1>That ${esc(what)} doesn't exist</h1><p>${hint[what] ?? 'The link may be mistyped or out of date.'}</p>
    <div class="toolbar center"><a class="button primary" href="/chat">Open Assistant</a><a class="button" href="/">Suites</a><a class="button" href="/runs">Runs</a><a class="button" href="/guide">Guide</a></div></div>`);
}

const JS = `
function copyNext(btn) {
  navigator.clipboard.writeText(btn.nextElementSibling.textContent).then(() => { btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy', 1500); });
}`;

const CSS = `
:root { color-scheme:light dark;
  --font:"Inter", "Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px; --r:12px; --r-sm:8px; --side-w:232px;
  --bg:#f5f6f8; --card:#fff; --side:#fbfbfc; --raised:#f0f1f4; --text:#14161b; --muted:#585e6c; --line:#e2e4e9; --line-strong:#cdd1d9;
  --brand:#c81e33; --brand-solid:#c81e33; --brand-soft:#fdecee; --link:#1d4fd7; --focus:#2f6bff;
  --pass:#157240; --fail:#c11f33; --review:#9a4a07; --partial:#8a5a00; --blocked:#5d6170; --error:#6b2bd4; --running:#1d58cf;
  --shadow:0 1px 2px rgba(16,20,30,.05), 0 1px 3px rgba(16,20,30,.06); --shadow-lg:0 8px 24px rgba(16,20,30,.10); }
@media (prefers-color-scheme: dark) { :root {
  --bg:#0d0f13; --card:#15181e; --side:#111318; --raised:#1c2028; --text:#e7e9ee; --muted:#a2a8b5; --line:#262a33; --line-strong:#353a46;
  --brand:#ff6378; --brand-solid:#c81e33; --brand-soft:#3a1a20; --link:#8db1ff; --focus:#8db1ff;
  --pass:#4fcb8a; --fail:#ff7a88; --review:#f0a35a; --partial:#e5b450; --blocked:#a2a8b5; --error:#b99bff; --running:#7aa5ff;
  --shadow:0 1px 2px rgba(0,0,0,.4); --shadow-lg:0 10px 30px rgba(0,0,0,.5); } }
* { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:14px/1.55 var(--font); font-feature-settings:"cv11","ss01"; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }
a { color:var(--link); text-underline-offset:2px; }
:focus-visible { outline:2px solid var(--focus); outline-offset:2px; border-radius:4px; }
.skip { position:absolute; left:-9999px; } .skip:focus { left:12px; top:8px; z-index:50; background:var(--card); padding:8px 12px; border-radius:var(--r-sm); box-shadow:var(--shadow-lg); }

/* ── Shell: left sidebar, top bar under 900px ── */
.shell { display:grid; grid-template-columns:var(--side-w) minmax(0,1fr); min-height:100vh; }
.sidebar { position:sticky; top:0; height:100vh; overflow-y:auto; background:var(--side); border-right:1px solid var(--line); display:flex; flex-direction:column; z-index:20; }
.side-top { display:flex; align-items:center; justify-content:space-between; padding:var(--s4) var(--s4) var(--s3); position:relative; }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:16px; letter-spacing:-.01em; color:var(--text); text-decoration:none; padding:2px; }
.brand .logo { border-radius:8px; box-shadow:var(--shadow); }
.nav-toggle, .nav-burger { display:none; }
.side-nav { display:flex; flex-direction:column; gap:var(--s2); padding:0 var(--s3) var(--s4); flex:1; }
.nav-group { display:grid; gap:2px; }
.nav-label { margin:var(--s3) var(--s2) var(--s1); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
.side-nav a { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:var(--r-sm); color:var(--text); text-decoration:none; font-weight:500; }
.side-nav a .ico { color:var(--muted); flex:none; }
.side-nav a:hover { background:var(--raised); }
.side-nav a[aria-current] { background:var(--brand-soft); color:var(--brand); font-weight:600; box-shadow:inset 3px 0 0 var(--brand-solid); }
.side-nav a[aria-current] .ico { color:var(--brand); }
.side-foot { margin-top:auto; padding-top:var(--s4); border-top:1px solid var(--line); display:grid; gap:2px; }
.side-foot .nav-label { margin-top:0; }
.side-foot a { font-weight:500; color:var(--muted); } .ico.sm { width:14px; height:14px; }
main { width:100%; max-width:1200px; margin:0 auto; padding:var(--s6) var(--s6) var(--s7); min-width:0; }
@media (max-width:900px) {
  .shell { display:block; }
  .sidebar { height:auto; flex-direction:column; border-right:0; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--side) 92%, transparent); backdrop-filter:blur(8px); overflow:visible; }
  .side-top { padding:var(--s2) var(--s4); min-height:56px; }
  .nav-burger { display:grid; place-items:center; width:40px; height:40px; border-radius:var(--r-sm); border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; }
  .nav-toggle { display:block; position:absolute; right:var(--s4); top:50%; transform:translateY(-50%); width:40px; height:40px; margin:0; opacity:0; cursor:pointer; z-index:1; }
  .nav-toggle:focus-visible + .nav-burger { outline:2px solid var(--focus); outline-offset:2px; }
  .nav-toggle:checked + .nav-burger { background:var(--raised); }
  .side-nav { display:none; padding:0 var(--s4) var(--s4); max-height:calc(100vh - 56px); overflow-y:auto; }
  .sidebar:has(.nav-toggle:checked) .side-nav { display:flex; }
  .side-nav a { padding:10px 12px; }
  main { padding:var(--s5) var(--s4) var(--s6); }
}

/* ── Type ── */
h1 { font-size:24px; line-height:1.25; letter-spacing:-.02em; font-weight:700; margin:0 0 var(--s1); display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
h2 { font-size:17px; letter-spacing:-.01em; font-weight:650; margin:var(--s6) 0 var(--s3); }
h3 { font-size:15px; font-weight:600; margin:0 0 10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.card > h2:first-child, .card > summary h2 { margin-top:0; }
.sub { color:var(--muted); font-size:13px; } .hint { color:var(--muted); font-size:13px; margin:0; font-weight:400; }
.crumbs { margin:0 0 var(--s2); color:var(--muted); font-size:13px; } .crumbs a { color:var(--muted); text-decoration:none; } .crumbs a:hover { color:var(--text); text-decoration:underline; }
code { font-family:var(--mono); background:var(--raised); padding:1px 6px; border-radius:6px; font-size:12.5px; }
pre { font-family:var(--mono); white-space:pre-wrap; font-size:12px; background:var(--raised); padding:var(--s3); border-radius:var(--r-sm); margin:6px 0; border:1px solid var(--line); }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; } th:has(> .visually-hidden) { position:relative; }
[hidden] { display:none !important; }
.nowrap { white-space:nowrap; } td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
.spacer { flex:1; }

/* ── Page header ── */
.page-head { display:flex; justify-content:space-between; align-items:flex-end; gap:var(--s4); flex-wrap:wrap; margin-bottom:var(--s5); }
.page-head h1 + .sub, .page-head .sub { margin:0; max-width:720px; font-size:14px; }
.page-head .toolbar { margin:0; }
main > h1 + .sub { margin:0 0 var(--s5); font-size:14px; max-width:760px; }

/* ── Cards ── */
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s5); margin:var(--s5) 0; box-shadow:var(--shadow); }
details.card > summary { list-style:none; } details.card > summary::-webkit-details-marker { display:none; }
details.card > summary::before { content:''; display:inline-block; width:8px; height:8px; border-right:2px solid var(--muted); border-bottom:2px solid var(--muted); transform:rotate(-45deg); margin:0 10px 2px 0; transition:transform .15s; }
details.card[open] > summary::before { transform:rotate(45deg); }
details.card[open] > summary { margin-bottom:var(--s4); }

/* ── Buttons: default = secondary; .primary .ghost .danger .link; .sm .lg ── */
button, .button { font:inherit; font-weight:550; font-size:14px; line-height:20px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:7px 14px; min-height:36px;
  border:1px solid var(--line-strong); border-radius:var(--r-sm); background:var(--card); color:var(--text); cursor:pointer; text-decoration:none; white-space:nowrap; box-shadow:var(--shadow);
  transition:background .12s, border-color .12s, box-shadow .12s; }
button:hover, .button:hover { background:var(--raised); border-color:var(--muted); }
button.primary, .button.primary { background:var(--brand-solid); border-color:var(--brand-solid); color:#fff; }
button.primary:hover, .button.primary:hover { background:color-mix(in srgb, var(--brand-solid) 86%, #000); border-color:color-mix(in srgb, var(--brand-solid) 86%, #000); }
button.ghost, .button.ghost { background:transparent; border-color:transparent; box-shadow:none; }
button.ghost:hover, .button.ghost:hover { background:var(--raised); }
button.danger, .button.danger { color:var(--fail); }
button.danger:hover, .button.danger:hover { background:color-mix(in srgb, var(--fail) 10%, var(--card)); border-color:color-mix(in srgb, var(--fail) 50%, var(--line)); }
button.sm, .button.sm { min-height:28px; padding:3px 10px; font-size:13px; } button.lg, .button.lg { min-height:44px; padding:10px 20px; font-size:15px; }
button.link { border:0; background:none; box-shadow:none; padding:0 0 0 10px; min-height:0; color:var(--fail); font-size:13px; font-weight:500; }
button.link:hover { background:none; text-decoration:underline; }
button:disabled, button:disabled:hover { opacity:.5; cursor:not-allowed; background:var(--card); }
button.primary:disabled { background:var(--brand-solid); }
button:focus-visible, .button:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }

/* ── Forms ── */
input, select, textarea { font:inherit; font-size:14px; font-weight:400; padding:8px 12px; min-height:38px; border:1px solid var(--line-strong); border-radius:var(--r-sm); background:var(--card); color:var(--text); transition:border-color .12s, box-shadow .12s; }
textarea { resize:vertical; line-height:1.5; }
input[type=checkbox], input[type=radio] { min-height:0; width:16px; height:16px; padding:0; accent-color:var(--brand-solid); }
input[type=file] { padding:6px; }
input:hover, select:hover, textarea:hover { border-color:var(--muted); }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline:none; border-color:var(--focus); box-shadow:0 0 0 3px color-mix(in srgb, var(--focus) 30%, transparent); }
input[type=checkbox]:focus-visible, input[type=radio]:focus-visible { outline:2px solid var(--focus); outline-offset:2px; box-shadow:none; }
input::placeholder, textarea::placeholder { color:color-mix(in srgb, var(--muted) 80%, transparent); }
input[aria-invalid=true], textarea[aria-invalid=true] { border-color:var(--fail); box-shadow:0 0 0 3px color-mix(in srgb, var(--fail) 22%, transparent); }
.stack { display:grid; gap:var(--s4); max-width:640px; } .stack label { display:grid; gap:6px; font-weight:550; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:var(--s4); } @media (max-width:640px) { .grid2 { grid-template-columns:1fr; } }
fieldset.choices { border:0; padding:0; margin:0; display:grid; gap:var(--s2); } fieldset.choices legend { font-weight:550; margin-bottom:6px; padding:0; }
fieldset.choices label.choice { display:flex; gap:12px; align-items:flex-start; padding:var(--s3) var(--s4); border:1px solid var(--line); border-radius:var(--r-sm); cursor:pointer; font-weight:400; transition:border-color .12s, background .12s; }
label.choice:hover { border-color:var(--line-strong); }
label.choice:has(input:checked) { border-color:var(--brand); background:var(--brand-soft); } label.choice span { display:grid; gap:2px; } label.choice input { margin-top:3px; }
.inline-label { display:flex; gap:8px; align-items:center; color:var(--muted); font-size:13px; min-width:0; } .inline-label select { max-width:min(320px, 60vw); }
.req { color:var(--fail); font-size:11px; font-weight:500; } .opt { color:var(--muted); font-size:11px; font-weight:400; }
label.check { display:flex; gap:8px; align-items:center; font-weight:400; }

.toolbar { display:flex; gap:var(--s2); flex-wrap:wrap; align-items:center; margin:var(--s4) 0; } form.inline { display:flex; gap:var(--s2); align-items:center; margin:0; flex-wrap:wrap; }
.toolbar.center { justify-content:center; margin-top:var(--s4); } .toolbar.bulk { margin:4px 0 10px; }
#run { flex-wrap:wrap; max-width:100%; }
.selection-bar { display:flex; gap:var(--s3); align-items:center; margin:0 0 var(--s2); min-height:24px; }

/* ── Tables: sticky header, zebra, hover ── */
.table-wrap { position:relative; overflow:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--line); border-radius:var(--r); background:var(--card); box-shadow:var(--shadow); max-height:78vh; }
.table-wrap > table { min-width:560px; border:0; border-radius:0; box-shadow:none; }
table { width:100%; border-collapse:separate; border-spacing:0; background:var(--card); border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
.table-wrap table { overflow:visible; }
th, td { text-align:left; padding:10px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); background:var(--raised); white-space:nowrap; }
.table-wrap th { position:sticky; top:0; z-index:1; }
tbody tr:nth-child(even) td { background:color-mix(in srgb, var(--raised) 40%, var(--card)); }
tbody tr:hover td { background:color-mix(in srgb, var(--raised) 90%, var(--card)); }
tr:last-child td { border-bottom:0; }
.row-actions { white-space:nowrap; font-size:13px; } .row-actions form { display:inline; }
.row-actions button.danger:not(.link) { min-height:28px; padding:3px 10px; font-size:13px; }

/* ── Badges: soft pills ── */
.badge { --c:var(--muted); display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600; line-height:18px; white-space:nowrap;
  color:var(--c); background:color-mix(in srgb, var(--c) 13%, transparent); border:1px solid color-mix(in srgb, var(--c) 28%, transparent); }
.badge::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; }
.badge:has(.spin)::before { display:none; }
.badge.pass { --c:var(--pass); } .badge.fail { --c:var(--fail); } .badge.review { --c:var(--review); } .badge.partial { --c:var(--partial); } .badge.blocked { --c:var(--blocked); } .badge.error { --c:var(--error); } .badge.running { --c:var(--running); } .badge.muted { --c:var(--muted); }
a:has(> .badge) { text-decoration:none; }
.count { font-size:12.5px; font-weight:600; margin-right:6px; font-variant-numeric:tabular-nums; } .count.pass { color:var(--pass); } .count.fail { color:var(--fail); } .count.review { color:var(--review); } .count.partial { color:var(--partial); } .count.blocked { color:var(--blocked); } .count.error { color:var(--error); }
tr.review td { color:var(--review); }
.counts { display:flex; gap:2px 8px; flex-wrap:wrap; margin-top:2px; } .counts .count { white-space:nowrap; margin:0; }
.counts.big { gap:var(--s2); margin:var(--s3) 0; } .counts.big .count { font-size:13px; padding:4px 12px; border-radius:999px; background:color-mix(in srgb, currentColor 11%, transparent); }
.tag { display:inline-block; font-size:11px; font-weight:500; padding:1px 8px; border-radius:999px; background:var(--raised); color:var(--muted); border:1px solid var(--line); margin-top:2px; }
.tag.ai { background:color-mix(in srgb, var(--link) 13%, transparent); color:var(--link); border-color:color-mix(in srgb, var(--link) 28%, transparent); }
.ok { color:var(--pass); } .warn { color:var(--partial); }

/* ── Feedback ── */
.alert { background:color-mix(in srgb, var(--fail) 9%, var(--card)); border:1px solid color-mix(in srgb, var(--fail) 35%, var(--line)); padding:var(--s3) var(--s4); border-radius:var(--r-sm); margin:var(--s3) 0; }
.alert.info { background:color-mix(in srgb, var(--running) 9%, var(--card)); border-color:color-mix(in srgb, var(--running) 32%, var(--line)); }
.tip { background:color-mix(in srgb, var(--running) 7%, var(--card)); border:1px solid color-mix(in srgb, var(--running) 22%, var(--line)); border-left:3px solid var(--running); padding:var(--s3) var(--s4); border-radius:var(--r-sm); margin:var(--s3) 0; }
.empty { color:var(--muted); padding:var(--s6) var(--s5); text-align:center; background:var(--card); border:1px dashed var(--line-strong); border-radius:var(--r); margin:var(--s4) 0; }
.empty::before { content:''; display:block; width:44px; height:44px; margin:0 auto var(--s3); border-radius:12px; background:var(--raised) no-repeat center/22px url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a90a0' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 7l9-4 9 4-9 4-9-4z'/%3E%3Cpath d='M3 7v10l9 4 9-4V7'/%3E%3Cpath d='M12 11v10'/%3E%3C/svg%3E"); }
.empty b { color:var(--text); font-size:15px; } .empty h1 { justify-content:center; }
.meter { width:110px; height:6px; background:var(--line); border-radius:999px; overflow:hidden; display:inline-block; vertical-align:middle; margin-right:8px; } .meter span { display:block; height:100%; background:var(--pass); border-radius:999px; }
.progress { height:8px; background:var(--line); border-radius:999px; overflow:hidden; } .progress span { display:block; height:100%; background:var(--running); border-radius:999px; transition:width .4s; }
.live p { margin:10px 0; }
.spin { width:10px; height:10px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; display:inline-block; animation:spin .8s linear infinite; } @keyframes spin { to { transform:rotate(360deg); } }
button.primary .spin { border-color:#fff; border-right-color:transparent; }
details { margin:6px 0; } summary { cursor:pointer; color:var(--muted); font-size:13px; border-radius:4px; } summary:hover { color:var(--text); }
details.settings > summary { color:var(--text); font-size:14px; }
.danger-zone { margin-top:var(--s4); padding:var(--s4); border:1px solid color-mix(in srgb, var(--fail) 35%, var(--line)); border-radius:var(--r-sm); display:grid; gap:var(--s2); background:color-mix(in srgb, var(--fail) 4%, var(--card)); }
.danger-zone h3 { margin:0 0 4px; color:var(--fail); } .danger-zone .hint { margin:0 0 6px; }

/* ── Suites, runs, cases ── */
.preview { font-size:13px; padding:8px 0; } .preview ol, .preview ul { margin:4px 0 8px; padding-left:18px; } .rule { color:var(--muted); font-size:11.5px; margin-left:4px; }
.issues { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s3) var(--s4) var(--s3) var(--s6); box-shadow:var(--shadow); } .issues li { margin:6px 0; }
.actual { color:var(--fail); } .cause { color:var(--muted); font-size:13px; margin-top:2px; }
.case { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4) var(--s5); margin:var(--s4) 0; scroll-margin-top:72px; box-shadow:var(--shadow); }
.checks { table-layout:fixed; width:100%; } .checks td { overflow-wrap:anywhere; } .checks td:first-child, .checks th:first-child { width:36px; font-weight:700; } .checks tr.pass td:first-child { color:var(--pass); } .checks tr.fail td:first-child { color:var(--fail); } .checks tr.skip td:first-child { color:var(--muted); } .checks tr.skip { color:var(--muted); }
.note { color:var(--muted); font-size:13px; margin:6px 0; border-left:3px solid var(--line-strong); padding-left:10px; }
.steps { font-size:13px; } .steps li.failed, .steps li.unmatched { color:var(--fail); } .steps li.skipped { color:var(--muted); }
.shots { display:flex; gap:var(--s3); flex-wrap:wrap; margin-top:var(--s3); } .shots a { display:grid; gap:4px; width:200px; text-decoration:none; color:var(--muted); font-size:12px; } .shots img { width:200px; border:1px solid var(--line); border-radius:var(--r-sm); transition:box-shadow .15s; } .shots a:hover img { box-shadow:var(--shadow-lg); }
.prompt { position:relative; } .prompt button { position:absolute; right:8px; top:8px; font-size:12px; padding:3px 10px; min-height:0; }
pre.jira { background:var(--raised); border:1px solid var(--line); border-radius:var(--r-sm); padding:var(--s3) var(--s4); font-size:12.5px; max-width:100%; overflow-wrap:anywhere; }
.ai-banner { display:flex; gap:var(--s4); align-items:center; justify-content:space-between; flex-wrap:wrap; border-color:color-mix(in srgb, var(--link) 32%, var(--line)); background:color-mix(in srgb, var(--link) 4%, var(--card)); }
.ai-box { margin:6px 0 10px; padding:var(--s2) var(--s3); border-radius:var(--r-sm); background:color-mix(in srgb, var(--link) 8%, transparent); border:1px solid color-mix(in srgb, var(--link) 25%, var(--line)); }
.rewrite { max-width:860px; } .rewrite .source { font-size:15px; margin:4px 0; } .rewrite textarea { font-family:var(--mono); font-size:13px; }
.rewrite-head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.issue-form { max-width:760px; } .issue-form details.paste { border:1px dashed var(--line-strong); border-radius:var(--r-sm); padding:var(--s3) var(--s4); background:var(--raised); }
.home-assistant { background:linear-gradient(135deg, color-mix(in srgb, var(--brand-solid) 7%, var(--card)), var(--card) 60%); border-color:color-mix(in srgb, var(--brand) 25%, var(--line)); }
.home-assistant h2 { display:flex; gap:10px; align-items:center; } .home-assistant h2 .ico { color:var(--brand); }
.purposes { display:flex; gap:var(--s2); flex-wrap:wrap; margin:var(--s3) 0 0; padding:0; list-style:none; }
.purposes li { font-size:13px; padding:4px 12px; border-radius:999px; background:var(--raised); border:1px solid var(--line); color:var(--text); }

/* ── Report ── */
.report { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s2) var(--s6) var(--s5); overflow-wrap:anywhere; box-shadow:var(--shadow); }
.report [id] { scroll-margin-top:72px; }
.report th { white-space:nowrap; } .report td:first-child { white-space:nowrap; } .report td:nth-child(3), .report td:nth-child(4) { white-space:nowrap; } .report td:last-child { white-space:normal; min-width:240px; } .report img { max-width:100%; height:auto; border:1px solid var(--line); border-radius:var(--r-sm); margin:6px 0; }
.report table { display:block; overflow-x:auto; margin:8px 0 16px; } .report td code, .report li code { white-space:normal; }
.report details { border:1px solid var(--line); border-radius:var(--r-sm); padding:6px 10px; margin:8px 0; } .report details summary { color:var(--text); }
.report .finding { border-left:3px solid var(--fail); padding:2px 0 2px 14px; margin:14px 0; }
.report h3 { display:block; margin-top:22px; } .report li { margin:3px 0; } .report blockquote { color:var(--muted); border-left:3px solid var(--line); margin:6px 0; padding-left:10px; }

/* ── Help ── */
.help { max-width:880px; } .help .lead { font-size:16px; line-height:1.6; } .help section { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s1) var(--s5) var(--s4); margin:var(--s4) 0; scroll-margin-top:72px; box-shadow:var(--shadow); }
.help h2 { display:flex; align-items:center; gap:10px; margin-top:var(--s5); } .help .num { display:inline-grid; place-items:center; width:26px; height:26px; border-radius:50%; background:var(--brand-solid); color:#fff; font-size:13px; flex:none; }
.help li { margin:5px 0; } .help table { margin:10px 0; } .help dt { font-weight:600; margin-top:12px; } .help dd { margin:4px 0 0 0; color:var(--text); }
.help code { overflow-wrap:anywhere; }
.toc { display:flex; flex-wrap:wrap; gap:6px 16px; background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4) var(--s5); font-size:13px; box-shadow:var(--shadow); } .toc b { width:100%; }
.glance { background:var(--card); }
.flow { list-style:none; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:var(--s3); counter-reset:f; }
.flow li { counter-increment:f; border:1px solid var(--line); border-radius:var(--r-sm); padding:var(--s3); display:grid; gap:4px; margin:0; background:var(--raised); }
.flow li b::before { content:counter(f) '. '; color:var(--brand); } .flow li span { color:var(--muted); font-size:13px; }
.example { border-color:color-mix(in srgb, var(--brand) 40%, var(--line)) !important; } .example h3 { margin:22px 0 8px; font-size:15px; }
.example form.inline { display:inline-flex; margin:4px 10px 4px 0; }
.finding-demo { border-left:3px solid var(--fail); background:color-mix(in srgb, var(--fail) 5%, var(--card)); padding:4px 14px; border-radius:var(--r-sm); margin:10px 0; }
.finding-demo ul { padding-left:18px; } .pattern { border:1px dashed var(--line-strong); border-radius:var(--r-sm); padding:4px 14px; margin:10px 0; } .pattern p { margin:6px 0; }
.fill { color:var(--muted); font-style:italic; }
.example-cases td { vertical-align:top; } .example-cases code { white-space:nowrap; }

@media (max-width:640px) {
  h1 { font-size:21px; } .card { padding:var(--s4); } .case { padding:var(--s3) var(--s4); }
  .help section { padding:4px var(--s4) var(--s3); } .report { padding:4px var(--s4) var(--s4); }
  .help table.stack-sm, .help table.stack-sm tbody, .help table.stack-sm tr, .help table.stack-sm td { display:block; width:100%; } .help table.stack-sm thead { display:none; }
  .help table.stack-sm tr { border-bottom:1px solid var(--line); padding:6px 0; } .help table.stack-sm td { border:0; padding:3px 10px; background:none; }
  .help table.stack-sm td:first-child { font-weight:600; }
  .shots a, .shots img { width:calc(50vw - 30px); }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; scroll-behavior:auto !important; } }
@media print { .sidebar, .toolbar, .crumbs, .skip { display:none !important; } .shell { display:block; } main { padding:0; max-width:none; } .report { border:0; padding:0; box-shadow:none; } body { background:#fff; } }
`;
