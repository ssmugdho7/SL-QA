import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import type { CaseResult, Check, Verdict } from './runner.js';

const ICON: Record<Verdict, string> = {
  Pass: '✅', Fail: '❌', Partial: '🟡', Blocked: '⛔', 'Not automated': '⚪', Error: '💥',
};
const STATE_ICON = { pass: '✅', fail: '❌', skip: '⏭️' } as const;

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function writeReport(results: CaseResult[], runDir: string, sheetUrl: string): string {
  const counts = new Map<Verdict, number>();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);

  const out: string[] = [];
  out.push(`# QA run — ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`, '');
  out.push(`- **Target:** ${config.baseUrl}/dashboard/products`);
  out.push(`- **Test cases:** [Google Sheet](${sheetUrl}) (${results.length} run)`);
  out.push(`- **Result:** ${[...counts].map(([v, n]) => `${ICON[v]} ${n} ${v}`).join(' · ')}`, '');
  out.push('Verdicts: **Pass** every expectation met · **Fail** at least one expectation not met · **Partial** everything checked passed, some parts could not be checked · **Blocked** the setup it needs is missing · **Error** the bot itself broke (not a finding about the app).', '');

  out.push('## Summary', '');
  out.push('| ID | Test case | Priority | Verdict | Main finding |', '|---|---|---|---|---|');
  for (const r of results) {
    const firstFail = r.checks.find((c) => c.state === 'fail');
    const finding = firstFail ? `${firstFail.label}: ${firstFail.actual}` : r.verdict === 'Blocked' ? r.notes.at(-1) ?? '' : r.error ?? '';
    out.push(`| [${r.tc.id}](#${r.tc.id.toLowerCase()}) | ${esc(r.tc.title)} | ${r.tc.priority} | ${ICON[r.verdict]} ${r.verdict} | ${esc(finding).slice(0, 160)} |`);
  }
  out.push('');

  const failed = results.filter((r) => r.verdict === 'Fail');
  if (failed.length) {
    out.push('## Issues found', '');
    for (const r of failed) {
      for (const c of r.checks.filter((x) => x.state === 'fail')) {
        out.push(`- **${r.tc.id}** — ${c.label}. Actual: ${c.actual}.${c.cause ? ` *Likely cause:* ${c.cause}` : ''}`);
      }
    }
    out.push('');
  }

  out.push('## Details', '');
  for (const r of results) out.push(...caseSection(r));

  const file = path.join(runDir, 'report.md');
  fs.writeFileSync(file, out.join('\n'));
  return file;
}

function caseSection(r: CaseResult): string[] {
  const out: string[] = [];
  out.push(`### ${r.tc.id}`, '');
  out.push(`**${r.tc.title}** — ${r.tc.scenario} · ${r.tc.type} · ${r.tc.priority} priority · ${ICON[r.verdict]} **${r.verdict}** · ${(r.durationMs / 1000).toFixed(1)}s`, '');
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
  if (r.screenshots.length) out.push(`**Screenshots:** ${r.screenshots.map((s) => `[${s.replace(/^PL-\d+-/, '').replace('.png', '')}](shots/${s})`).join(' · ')}`, '');

  const fails = r.checks.filter((c) => c.state === 'fail');
  if (fails.length) out.push(...fixPrompt(r, fails));
  out.push('---', '');
  return out;
}

/** A ready-to-paste prompt for whoever fixes the bug, built from the evidence. */
function fixPrompt(r: CaseResult, fails: Check[]): string[] {
  const lines = [
    `Fix a bug in the store dashboard's Products page (${config.baseUrl}/dashboard/products).`,
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
