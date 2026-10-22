import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import type { CaseResult, Check, Verdict } from './context.js';
import { healthProblems, type Inspection } from './inspect.js';

export const ICON: Record<Verdict, string> = {
  Pass: '✅', Fail: '❌', Review: '🔍', Partial: '🟡', Blocked: '⛔', Error: '💥',
};
const STATE_ICON = { pass: '✅', fail: '❌', skip: '⏭️', review: '🔍' } as const;

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** `startedAt`: when the run started (the heading shows this, not when the report was written). */
export function writeReport(results: CaseResult[], runDir: string, source: string, pagePath: string, startedAt = new Date()): string {
  pageForPrompt = pagePath;
  const counts = new Map<Verdict, number>();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

  const out: string[] = [];
  out.push(`# QA run — ${startedAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`, '');
  out.push(`- **Target:** ${config.baseUrl}${pagePath}`);
  out.push(`- **Test cases:** ${/^https?:/.test(source) ? `[Google Sheet](${source})` : source} (${results.length} run)`);
  out.push(`- **Result:** ${[...counts].map(([v, n]) => `${ICON[v]} ${n} ${v}`).join(' · ')}`, '');
  out.push('Verdicts: **Pass** every expectation met · **Fail** at least one expectation not met · **Review** a check written by AI did not hold, so a person should look (real bug or misread sentence) · **Partial** everything checked passed, some parts could not be checked · **Blocked** the setup it needs is missing · **Error** the bot itself broke (not a finding about the app).', '');

  out.push('## Summary', '');
  out.push('| ID | Test case | Priority | Verdict | Main finding |', '|---|---|---|---|---|');
  for (const r of results) {
    const firstFail = r.checks.find((c) => c.state === 'fail') ?? r.checks.find((c) => c.state === 'review');
    const finding = firstFail ? `${firstFail.label}: ${firstFail.actual}` : r.verdict === 'Blocked' ? r.notes.at(-1) ?? '' : r.error ?? '';
    out.push(`| [${r.tc.id}](#${anchor(r.tc.id)}) | ${esc(r.tc.title)} | ${r.tc.priority} | ${ICON[r.verdict]} ${r.verdict} | ${esc(finding).slice(0, 160)} |`);
  }
  out.push('');

  const failed = results.filter((r) => r.verdict === 'Fail');
  if (failed.length) {
    out.push('## Findings', '');
    out.push('What went wrong, row by row: what the sheet expected, what the page actually did, and where to look.', '');
    for (const r of failed) out.push(...finding(r));
  }

  const toReview = results.filter((r) => r.verdict === 'Review');
  if (toReview.length) {
    out.push('## To review', '');
    out.push('Checks the AI wrote from the sentence did not hold. Each could be a real bug or a misreading: look at the screenshot, then report the bug or correct the check under Review rewrites.', '');
    for (const r of toReview) {
      out.push(`- **[${r.tc.id}](#${anchor(r.tc.id)})** ${esc(r.tc.title)}`);
      for (const c of r.checks.filter((x) => x.state === 'review')) out.push(`  - ${esc(c.label)}: ${esc(c.actual)}`);
    }
    out.push('');
  }

  const problems = (r: CaseResult) => (r.inspection ? healthProblems(r.inspection, { appOnly: true }).filter((p) => !/slow request/.test(p)) : []);
  const unhealthy = results.filter((r) => r.verdict !== 'Fail' && problems(r).length);
  if (unhealthy.length) {
    out.push('## Other problems seen on the pages', '');
    out.push('These rows did not fail their expected results, but their page had errors worth a look.', '');
    for (const r of unhealthy) out.push(`- **[${r.tc.id}](#${anchor(r.tc.id)})** (${r.inspection!.finalUrl.replace(config.baseUrl, '')}): ${esc(problems(r).join('; '))}.`);
    out.push('');
  }

  out.push(...slowSection(results));

  out.push('## Details', '');
  for (const r of results) out.push(...caseSection(r));

  const file = path.join(runDir, 'report.md');
  fs.writeFileSync(file, out.join('\n'));
  // The latest report is also kept at ./report.md, with screenshot links pointing into the run folder.
  const rel = path.relative('.', runDir).split(path.sep).join('/');
  fs.writeFileSync('report.md', out.join('\n').replace(/\]\(shots\//g, `](${rel}/shots/`));
  return file;
}

/** A plain-English paragraph for one failed row. */
function finding(r: CaseResult): string[] {
  const fails = r.checks.filter((c) => c.state === 'fail');
  const i = r.inspection;
  const where = i ? i.finalUrl.replace(config.baseUrl, '') || '/' : r.tc.url || pageForPrompt;
  const out = [`### ${r.tc.id} — ${r.tc.title}`, ''];
  out.push(`**Page:** [${where}](${i?.finalUrl ?? config.baseUrl + where}) · **Priority:** ${r.tc.priority || '—'} · [details](#${anchor(r.tc.id)})`, '');
  if (r.tc.reported) out.push(`- **Reported by the tester:** ${r.tc.reported.replace(/\n+/g, ' ')}`);
  for (const c of fails) {
    out.push(`- **Expected:** ${esc(c.label)}  `);
    out.push(`  **Actual:** ${esc(c.actual)}${c.cause ? '  ' : ''}`);
    if (c.cause) out.push(`  **Likely cause:** ${c.cause}`);
  }
  // The inspection writes API requests as "500 GET API /x", the steps as "500 GET /x".
  const seenRequests = new Set((i?.failedRequests ?? []).map((x) => x.replace(' API /', ' /')));
  const evidence = [
    ...(i ? healthProblems(i, { appOnly: true }).filter((p) => !/slow request/.test(p)) : []),
    ...r.failedRequests.filter((x) => !seenRequests.has(x)).slice(0, 3).map((x) => `failed API request during the steps: \`${x}\``),
    ...r.consoleErrors.filter((x) => !i?.consoleErrors.includes(x)).slice(0, 2).map((x) => `console error during the steps: \`${esc(x).slice(0, 160)}\``),
  ];
  if (evidence.length) out.push(`- **Where it shows up:** ${evidence.join('; ')}.`);
  const shot = r.screenshots.find((s) => /step-failed|end|error/.test(s)) ?? r.screenshots.at(-1);
  if (shot) out.push('', `[![Screenshot of ${r.tc.id}](shots/${shot})](shots/${shot})`);
  out.push('');
  return out;
}

/** Slow requests, once per endpoint across all rows (they repeat on every visit to the same page). */
function slowSection(results: CaseResult[]): string[] {
  const by = new Map<string, { times: number[]; rows: Set<string> }>();
  for (const r of results) {
    for (const line of r.inspection?.slowRequests ?? []) {
      const [, secs, req] = line.match(/^([\d.]+)s (.+)$/) ?? [];
      if (!req) continue;
      const key = req.replace(/\?.*$/, '');
      const e = by.get(key) ?? { times: [], rows: new Set<string>() };
      e.times.push(Number(secs));
      e.rows.add(r.tc.id);
      by.set(key, e);
    }
  }
  if (!by.size) return [];
  const out = ['## Slow requests', '', 'Requests that took more than 3 seconds on a plain page visit. Not a failed check, but the page feels slow.', '', '| Request | Seen | Typical time | Slowest |', '|---|---|---|---|'];
  for (const [req, e] of [...by].sort((a, b) => b[1].times.length - a[1].times.length)) {
    const sorted = [...e.times].sort((a, b) => a - b);
    out.push(`| \`${req}\` | ${e.rows.size} row(s) | ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}s | ${sorted.at(-1)!.toFixed(1)}s |`);
  }
  out.push('');
  return out;
}

/** Heading anchor for a case ID: "PL-001" → "case-pl-001". */
const anchor = (id: string) => `case-${id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;

function healthSection(i: Inspection): string[] {
  const out = ['<details><summary>Page health (plain logged-in visit)</summary>', ''];
  out.push(`- **URL:** ${i.url}${i.finalUrl !== i.url ? ` → ended at ${i.finalUrl}` : ''}`);
  out.push(`- **HTTP status:** ${i.status ?? 'no response'} · **Load time:** ${(i.loadMs / 1000).toFixed(1)}s · **Title:** ${i.title || '—'}`);
  if (i.headings.length) out.push(`- **Headings:** ${i.headings.slice(0, 8).join(' · ')}`);
  if (i.buttons.length) out.push(`- **Buttons / tabs:** ${i.buttons.slice(0, 20).join(' · ')}`);
  const list = (label: string, items: string[]) => items.length && out.push(`- **${label} (${items.length}):**`, ...items.slice(0, 8).map((x) => `  - \`${esc(x).slice(0, 200)}\``));
  list('Console errors', i.consoleErrors);
  list('Console warnings', i.consoleWarnings);
  list('Failed requests', i.failedRequests);
  list('Slow requests', i.slowRequests);
  list('Broken images', i.brokenImages);
  list('Error text on the page', i.errorTexts);
  if (i.blank) out.push('- **The page is blank.**');
  if (!healthProblems(i).length) out.push('- No console errors, failed requests, broken images or error text.');
  if (i.screenshot) out.push(`- **Screenshot:** [page](shots/${i.screenshot})`);
  out.push('', '</details>', '');
  return out;
}

let pageForPrompt = '/dashboard';

function caseSection(r: CaseResult): string[] {
  const out: string[] = [];
  out.push(`<a id="${anchor(r.tc.id)}"></a>`, '', `### ${r.tc.id}`, '');
  const meta = [r.tc.scenario, r.tc.type, r.tc.priority && `${r.tc.priority} priority`].filter(Boolean);
  out.push(`**${r.tc.title}** — ${[...meta, `${ICON[r.verdict]} **${r.verdict}**`, `${(r.durationMs / 1000).toFixed(1)}s`].join(' · ')}`, '');
  if (r.tc.url) out.push(`**Page:** ${r.tc.url}`, '');
  if (r.tc.reported) out.push(`**Reported by the tester:** ${r.tc.reported.replace(/\n+/g, ' ')}`, '');
  if (r.inspection) out.push(...healthSection(r.inspection));
  if (r.steps.length) {
    out.push('<details><summary>Steps the bot ran</summary>', '');
    for (const s of r.steps) out.push(`- ${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'unmatched' ? '?' : '–'} ${s.text}${s.via === 'ai' ? ' *(AI)*' : ''}${s.detail ? ` — ${s.detail}` : ''}`);
    out.push('', '</details>', '');
  }
  if (r.checks.length) {
    out.push('| | Expected | Actual |', '|---|---|---|');
    for (const c of r.checks) out.push(`| ${STATE_ICON[c.state]} | ${esc(c.label)} | ${esc(c.actual)} |`);
    out.push('');
  }
  for (const n of r.notes) out.push(`> ${n}`);
  if (r.notes.length) out.push('');
  if (r.error) out.push(`**Bot error:** \`${r.error}\``, '');
  if (r.failedRequests.length) out.push(`**Failed API requests:** ${r.failedRequests.slice(0, 6).map((x) => `\`${x}\``).join(', ')}`, '');
  if (r.consoleErrors.length) out.push(`**Console errors:** ${r.consoleErrors.slice(0, 4).map((x) => `\`${esc(x).slice(0, 140)}\``).join(', ')}`, '');
  if (r.screenshots.length) out.push(`**Screenshots:** ${r.screenshots.map((s) => `[${s.replace(/^[\w-]+?-(\d+-)/, '$1').replace('.png', '')}](shots/${s})`).join(' · ')}`, '');

  const fails = r.checks.filter((c) => c.state === 'fail');
  if (fails.length) out.push(...fixPrompt(r, fails));
  out.push('---', '');
  return out;
}

/** A ready-to-paste prompt for whoever fixes the bug, built from the evidence. */
function fixPrompt(r: CaseResult, fails: Check[]): string[] {
  const lines = [
    `Fix a bug in the store dashboard (${config.baseUrl}${pageForPrompt}).`,
    '',
    `Test case ${r.tc.id}: ${r.tc.title}`,
    `Preconditions: ${r.tc.preconditions}`,
    'Steps:',
    ...r.tc.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'What fails:',
    ...fails.map((c) => `- Expected: ${c.label}\n  Actual: ${c.actual}${c.cause ? `\n  Likely cause: ${c.cause}` : ''}`),
  ];
  if (r.failedRequests.length) lines.push('', `Failed API requests: ${r.failedRequests.slice(0, 6).join('; ')}`);
  if (r.consoleErrors.length) lines.push('', `Console errors: ${r.consoleErrors.slice(0, 3).join('; ')}`);
  lines.push('', 'Find where this behaviour is implemented (frontend component and the API endpoint it calls), fix the root cause, and add a test that covers the expected result above.');
  return ['<details><summary>Fix prompt</summary>', '', '```text', ...lines, '```', '', '</details>', ''];
}
