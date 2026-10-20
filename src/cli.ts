import { config } from './config.js';
import { loadTestCases } from './sheet.js';
import { startSession } from './session.js';
import { caseScripts } from './cases/index.js';
import { ensureRunDir, runCase, type CaseResult } from './runner.js';
import { writeReport } from './report.js';

const HELP = `Usage: npm start -- [options] [TC-ID ...]

Runs the test cases from the Google Sheet against the live app and writes runs/<time>/report.md.

  TC-ID ...        Only run these IDs (e.g. PL-001 PL-021). Default: all.
  --scenario TEXT  Only run cases whose scenario contains TEXT.
  --headed         Show the browser while it runs.
  --list           List the test cases and whether each has a script, then exit.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) return void console.log(HELP);
  const headed = args.includes('--headed');
  const scenarioAt = args.indexOf('--scenario');
  const scenario = scenarioAt >= 0 ? args[scenarioAt + 1]?.toLowerCase() : undefined;
  const ids = args.filter((a, i) => !a.startsWith('--') && (scenarioAt < 0 || i !== scenarioAt + 1)).map((a) => a.toUpperCase());

  const all = await loadTestCases();
  if (args.includes('--list')) {
    for (const tc of all) console.log(`${caseScripts[tc.id] ? '●' : '○'} ${tc.id}  ${tc.title}`);
    return;
  }
  const unknown = ids.filter((id) => !all.some((tc) => tc.id === id));
  if (unknown.length) throw new Error(`Not in the sheet: ${unknown.join(', ')}`);
  const selected = all.filter((tc) => (!ids.length || ids.includes(tc.id)) && (!scenario || tc.scenario.toLowerCase().includes(scenario)));

  const runDir = ensureRunDir();
  console.log(`Running ${selected.length} test case(s) → ${runDir}`);
  const session = await startSession(headed);
  const results: CaseResult[] = [];
  try {
    for (const tc of selected) {
      process.stdout.write(`  ${tc.id} ${tc.title.slice(0, 60).padEnd(60)} `);
      const result = await runCase(tc, caseScripts[tc.id], session, runDir);
      results.push(result);
      console.log(`${result.verdict}${result.error ? ` — ${result.error.slice(0, 80)}` : ''}`);
    }
  } finally {
    await session.close();
  }
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit#gid=${config.sheetGid}`;
  console.log(`\nReport: ${writeReport(results, runDir, sheetUrl)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
