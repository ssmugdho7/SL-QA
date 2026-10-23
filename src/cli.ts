import fs from 'fs';
import { casesFromSheet } from './engine/sources/google-sheet.js';
import { casesFromUpload } from './engine/sources/upload.js';
import type { TestCase } from './engine/sources/cases.js';
import { startSession } from './engine/session.js';
import { newRunDir, type CaseResult } from './engine/context.js';
import { previewCase, runCase } from './engine/phrases/index.js';
import { writeReport } from './engine/report.js';
import { discoverPages, loadSiteMap, saveSiteMap, SITE_MAP_FILE, siteCases, siteMapAge } from './engine/apps/slshop/crawl.js';

const HELP = `Usage: npx tsx src/cli.ts <sheet-url | file.csv | file.xlsx> [options] [TC-ID ...]

Reads the test cases, runs them against the dashboard and writes runs/<time>/report.md.

  TC-ID ...        Only run these IDs (e.g. PL-001 PL-021). Default: all.
  --page PATH      Dashboard page the cases start on (default /dashboard/products).
  --preview        Only show how each sentence is understood; do not run.
  --headed         Show the browser while it runs.

Or check single pages without a sheet:
  npx tsx src/cli.ts --url /dashboard/orders [--expect "'Orders' should be shown"] [--url …]

Or check the whole dashboard (read-only: opens pages, tabs, the filter panel, search and the next page):
  npx tsx src/cli.ts --crawl [--max N]               Walk the dashboard and write the site map (UI labels only).
  npx tsx src/cli.ts --site [--preview] [--limit N] [SITE-001 …]
                                                     One case per page in the site map (crawls first if it is missing).
`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) return void console.log(HELP);
  const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const urls = args.filter((a, i) => args[i - 1] === '--url');
  const site = args.includes('--site');
  if (args.includes('--crawl') || (site && !loadSiteMap())) await crawl(Number(value('--max') ?? 200), args.includes('--headed'));
  if (args.includes('--crawl') && !site) return;
  const source = site ? 'whole dashboard' : urls.length ? 'command line' : args[0];
  const page = value('--page') ?? '/dashboard/products';
  const ids = urls.length ? [] : args.slice(site ? 0 : 1).filter((a, i, all) => !a.startsWith('--') && !['--page', '--url', '--expect', '--limit', '--max'].includes(all[i - 1])).map((a) => a.toUpperCase());

  const map = site ? loadSiteMap()! : null;
  if (map && siteMapAge(map) > 7) console.log(`The site map is ${Math.floor(siteMapAge(map))} days old; run --crawl to refresh it.`);
  const all: TestCase[] = map ? siteCases(map, { limit: Number(value('--limit') ?? 0) || undefined, ids })
    : urls.length
    ? urls.map((url, i) => ({
      id: `URL-${i + 1}`, scenario: '', title: url, type: '', priority: '', preconditions: '', steps: [], testData: '', automation: '', url,
      expected: args.filter((a, j) => args[j - 1] === '--expect'),
    }))
    : /^https?:/.test(source) ? await casesFromSheet(source) : await casesFromUpload(source, fs.readFileSync(source));
  const selected = all.filter((tc) => map || !ids.length || ids.includes(tc.id));

  if (args.includes('--preview')) {
    for (const tc of selected) {
      const p = previewCase(tc);
      console.log(`\n${tc.id}  ${tc.title}  (${p.understood}/${p.total} understood)${tc.url ? `  → ${tc.url}` : ''}`);
      for (const s of p.steps) for (const c of s.clauses) console.log(`  ${c.rule ? '✓' : '?'} step   ${c.text}${c.rule ? `  [${c.rule}]` : ''}`);
      for (const e of p.expects) for (const c of e.claims) console.log(`  ${c.rule ? '✓' : '?'} expect ${c.text}${c.rule ? `  [${c.rule}]` : ''}`);
    }
    return;
  }

  // Site checks are read-only: no live AI, which could pick a different (unsafe) control when a step fails.
  if (map) process.env.AI_LIVE = 'off';
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

/** Walks the dashboard and writes the site map, printing one line per page. */
async function crawl(maxPages: number, headed: boolean): Promise<void> {
  console.log(`Crawling the dashboard (up to ${maxPages} pages, read-only)…`);
  const session = await startSession(headed);
  try {
    const map = await discoverPages(session, { maxPages, onPage: (p, n) => console.log(`  ${String(n).padStart(3)} ${p.kind.padEnd(8)} ${p.path}  ${[p.group, p.label].filter(Boolean).join(' › ')}`) });
    saveSiteMap(map);
    const kinds = map.pages.reduce<Record<string, number>>((a, p) => ({ ...a, [p.kind]: (a[p.kind] ?? 0) + 1 }), {});
    console.log(`\n${map.pages.length} pages in ${Math.round(map.tookMs / 1000)}s (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}) → ${SITE_MAP_FILE}`);
  } finally {
    await session.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
