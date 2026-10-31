import { layout, esc } from './views.js';

interface Step { icon: string; title: string; text: string; href: string; go: string; tips: string[]; }

const STEPS: Step[] = [
  { icon: '💬', title: 'Ask the Assistant', text: 'Describe what to test on slshop.cloud. The Assistant proposes test cases for you.', href: '/chat', go: 'Open Assistant',
    tips: ['Name a real category or page, e.g. “Eye Lens”.', 'Optionally add a GitHub repo for code context.', 'Ask follow-ups to get more or different cases.'] },
  { icon: '✏️', title: 'Fix the cases', text: 'Read the proposed cases. Edit wrong ones, delete junk, add anything missing.', href: '/chat', go: 'Review cases',
    tips: ['Use Edit, Delete and Add case on each proposal.', 'Each step should say exactly what to do and expect.', 'Short, single-purpose cases run best.'] },
  { icon: '🔍', title: 'Use Super QA (optional)', text: 'A stronger model re-checks the cases against the real pages.', href: '/chat', go: 'Open Assistant',
    tips: ['Catches cases that do not match the live site.', 'Slower, so use it once the list looks right.'] },
  { icon: '💾', title: 'Save as a suite', text: 'Save the cases as a suite, or skip the Assistant and import your own Sheet or CSV.', href: '/#add', go: 'Add a suite',
    tips: ['“Save as new suite” in the Assistant, or “Download CSV”.', 'Import a Google Sheet, upload CSV/XLSX, or type cases by hand.', 'Use “Check the whole dashboard” to auto-build a suite.'] },
  { icon: '🧐', title: 'Check the bot understood', text: 'Open the suite and look at coverage. Approve AI rewrites of unclear steps.', href: '/', go: 'Open Suites',
    tips: ['Coverage shows which cases the bot can actually run.', 'Review rewrites lets you accept or reject each AI rewrite.', 'Fix cases it could not understand before running.'] },
  { icon: '▶️', title: 'Run', text: 'Start a run. The bot walks through every case in a real browser.', href: '/runs', go: 'See Runs',
    tips: ['Press Run on the suite page.', 'The page refreshes while it works.', 'You can leave and come back later.'] },
  { icon: '📊', title: 'Read the report', text: 'Each case gets a verdict and a screenshot as evidence.', href: '/runs', go: 'Open reports',
    tips: ['Pass: worked as expected. Fail: behaved differently.', 'Review: a human should look. Blocked: could not be tried.', 'Open the screenshot before filing a bug.'] },
  { icon: '🔁', title: 'Repeat', text: 'Fix cases or approve rewrites, then run again until the report is clean.', href: '/', go: 'Back to Suites',
    tips: ['Approved rewrites make the next run more accurate.', 'Re-run after the site changes to catch regressions.'] },
];

export function guidePage(): string {
  const items = STEPS.map((s, i) => `<li class="g-step" style="--d:${i * 60}ms">
    <span class="g-node" aria-hidden="true">${i + 1}</span>
    <div class="g-card"><h2><span aria-hidden="true">${s.icon}</span> ${esc(s.title)}</h2><p>${esc(s.text)}</p>
      <a class="button primary" href="${s.href}">${esc(s.go)} →</a>
      <details><summary>More</summary><ul>${s.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details></div></li>`).join('');
  return layout('Guide', `<article class="guide"><style>${CSS}</style>
  <h1>Guide</h1><p class="sub">From idea to a test report in eight steps.</p>
  <div class="g-fork" role="group" aria-label="Two ways to start">
    <a href="#g1"><b>A · Ask the Assistant</b><span>Steps 1–4</span></a>
    <a href="/#add"><b>B · Use your own sheet</b><span>Import, then jump to step 5</span></a>
  </div>
  <div class="g-join" aria-hidden="true"></div>
  <ol class="g-line" id="g1">${items}</ol>
  <p class="sub">Need every detail? <a href="/help">Full reference</a></p></article>`, { section: 'guide' });
}

const CSS = `
.guide { max-width:760px; }
.g-fork { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.g-fork a { display:grid; gap:2px; padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--card); text-decoration:none; color:var(--text); position:relative; }
.g-fork a:hover, .g-fork a:focus-visible { border-color:var(--brand); outline:2px solid transparent; box-shadow:0 0 0 2px var(--focus); }
.g-fork span { color:var(--muted); font-size:13px; }
.g-join { height:22px; margin:0 0 4px 23px; border-left:2px solid var(--line); }
.g-join::before { content:''; display:block; height:22px; width:50%; margin-left:-2px; border-bottom:2px solid var(--line); border-left:2px solid var(--line); }
.g-line { list-style:none; margin:0; padding:0; position:relative; }
.g-line::before { content:''; position:absolute; left:15px; top:8px; bottom:8px; width:2px; background:var(--line); }
.g-step { position:relative; padding:0 0 18px 48px; animation:g-in .4s ease both; animation-delay:var(--d); }
.g-node { position:absolute; left:0; top:4px; width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:var(--brand); color:#fff; font-weight:700; box-shadow:0 0 0 4px var(--bg); }
.g-step:nth-child(5) .g-node { box-shadow:0 0 0 4px var(--bg), 0 0 0 6px var(--pass); }
.g-card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.g-card h2 { margin:0 0 4px; font-size:16px; } .g-card p { margin:0 0 10px; color:var(--muted); }
.g-card details { margin-top:8px; } .g-card summary { cursor:pointer; color:var(--muted); font-size:13px; border-radius:4px; }
.g-card summary:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
.g-card ul { margin:6px 0 0; padding-left:20px; font-size:14px; }
@keyframes g-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) { .g-step { animation:none; } }
@media (max-width:700px) { .g-fork { grid-template-columns:1fr; } .g-join { display:none; } }
`;
