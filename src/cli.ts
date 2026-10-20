import fs from 'fs';
import { casesFromSheet } from './engine/sources/google-sheet.js';
import { casesFromUpload } from './engine/sources/upload.js';
import type { TestCase } from './engine/sources/cases.js';
import { startSession } from './engine/session.js';
import { newRunDir, type CaseResult } from './engine/context.js';
import { previewCase, runCase } from './engine/phrases/index.js';
import { writeReport } from './engine/report.js';

const HELP = `Usage: npx tsx src/cli.ts <sheet-url | file.csv | file.xlsx> [options] [TC-ID ...]

Reads the test cases, runs them against the dashboard and writes runs/<time>/report.md.

  TC-ID ...        Only run these IDs (e.g. PL-001 PL-021). Default: all.
  --page PATH      Dashboard page the cases start on (default /dashboard/products).
  --preview        Only show how each sentence is understood; do not run.
  --headed         Show the browser while it runs.

Or check single pages without a sheet:
  npx tsx src/cli.ts --url /dashboard/orders [--expect "'Orders' should be shown"] [--url …]
`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) return void console.log(HELP);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const urls = args.filter((a, i) => args[i - 1] === '--url');
  const source = urls.length ? 'command line' : args[0];
  const page = value('--page') ?? '/dashboard/products';
  const ids = urls.length ? [] : args.slice(1).filter((a, i, all) => !a.startsWith('--') && !['--page', '--url', '--expect'].includes(all[i - 1])).map((a) => a.toUpperCase());

  const all: TestCase[] = urls.length
    ? urls.map((url, i) => ({
      id: `URL-${i + 1}`, scenario: '', title: url, type: '', priority: '', preconditions: '', steps: [], testData: '', automation: '', url,
      expected: args.filter((a, j) => args[j - 1] === '--expect'),
    }))
    : /^https?:/.test(source) ? await casesFromSheet(source) : await casesFromUpload(source, fs.readFileSync(source));
  const selected = all.filter((tc) => !ids.length || ids.includes(tc.id));

  if (args.includes('--preview')) {
    for (const tc of selected) {
      const p = previewCase(tc);
      console.log(`\n${tc.id}  ${tc.title}  (${p.understood}/${p.total} understood)${tc.url ? `  → ${tc.url}` : ''}`);
      for (const s of p.steps) for (const c of s.clauses) console.log(`  ${c.rule ? '✓' : '?'} step   ${c.text}${c.rule ? `  [${c.rule}]` : ''}`);
      for (const e of p.expects) for (const c of e.claims) console.log(`  ${c.rule ? '✓' : '?'} expect ${c.text}${c.rule ? `  [${c.rule}]` : ''}`);
    }
    return;
  }

  const runDir = newRunDir(new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  console.log(`Running ${selected.length} test case(s) → ${runDir}`);
  const session = await startSession(args.includes('--headed'));
  const results: CaseResult[] = [];
  try {
    for (const tc of selected) {
      process.stdout.write(`  ${tc.id} ${tc.title.slice(0, 60).padEnd(60)} `);
      const result = await runCase(tc, session, runDir, page);
      results.push(result);
      console.log(`${result.verdict}${result.error ? ` — ${result.error.slice(0, 100)}` : ''}`);
    }
  } finally {
    await session.close();
  }
  console.log(`\nReport: ${writeReport(results, runDir, source, page)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
