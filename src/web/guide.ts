import { layout, esc } from './views.js';

interface Step { icon: string; title: string; text: string; href: string; go: string; tips: string[]; }

/** The Assistant's three jobs: pick one to start. */
const START: { title: string; text: string; example: string }[] = [
  { title: 'Ask about slshop.cloud', text: 'Questions about any dashboard page, answered from the site map.', example: 'What can I filter on the Orders page?' },
  { title: 'Find a bug', text: 'It opens the page in a real browser and reports bugs it can prove.', example: 'Find bugs on the Eye Lens category' },
  { title: 'Generate test cases', text: 'Cases written for a page, checked by Super QA, saved as a suite.', example: 'Generate test cases for the POS page' },
];

const STEPS: Step[] = [
  { icon: '💬', title: 'Open the Assistant', text: 'Pick one of the three jobs above and type it in plain words.', href: '/chat', go: 'Open Assistant',
    tips: ['Name a real page or category, e.g. “Eye Lens”.', 'Optionally add a GitHub repo for code context.', 'Ask follow-ups to dig deeper.'] },
  { icon: '🐞', title: 'Find a bug', text: 'Name a page, module or feature. It drives a real browser with DevTools capture, tries tabs, filters and search (read-only), and reports only evidence-backed bugs with screenshots.', href: '/chat', go: 'Hunt for bugs',
    tips: ['It never saves, deletes or sends anything.', 'Each bug shows what it did, what happened, console errors and failed requests.', '“Save as new suite” turns the bugs into cases you can re-run after a fix.'] },
  { icon: '📝', title: 'Generate test cases', text: 'Ask for cases for a page. Edit, delete or add any, then run Super QA so a stronger model checks them against the real pages.', href: '/chat', go: 'Write cases',
    tips: ['Super QA takes 30–90 seconds and only looks.', 'Save as a suite, or Download CSV for a sheet.', 'Have your own sheet? Import it on Suites instead.'] },
  { icon: '▶️', title: 'Run the suite', text: 'Open the suite, check the bot understood each case, and press Run.', href: '/', go: 'Open Suites',
    tips: ['The Understood column shows what the bot can run.', 'Approve AI rewrites for unclear steps.', 'You can leave and come back; the run keeps going.'] },
  { icon: '📊', title: 'Read the report', text: 'Every case gets a verdict with a screenshot. Fix the case or report the bug, then run again.', href: '/runs', go: 'See Runs',
    tips: ['Pass: worked. Fail: the site is wrong. Review: a person should look.', '“Since the previous run” shows what a fix changed.'] },
];

export function guidePage(): string {
  const start = START.map((s) => `<a class="g-pick" href="/chat"><b>${esc(s.title)}</b><span>${esc(s.text)}</span><i>“${esc(s.example)}”</i></a>`).join('');
  const items = STEPS.map((s, i) => `<li class="g-step" style="--d:${i * 60}ms">
    <span class="g-node" aria-hidden="true">${i + 1}</span>
    <div class="g-card"><h2><span aria-hidden="true">${s.icon}</span> ${esc(s.title)}</h2><p>${esc(s.text)}</p>
      <a class="button sm" href="${s.href}">${esc(s.go)} →</a>
      <details><summary>Tips</summary><ul>${s.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details></div></li>`).join('');
  return layout('Guide', `<article class="guide"><style>${CSS}</style>
  <div class="page-head"><div><h1>Guide</h1><p class="sub">SL QA in under a minute. The Assistant is where most work starts.</p></div>
    <div class="toolbar"><a class="button primary" href="/chat">Open Assistant</a></div></div>
  <div class="g-picks" role="group" aria-label="What the Assistant does">${start}</div>
  <ol class="g-line">${items}</ol>
  <p class="sub">Need every detail? <a href="/help">Full reference</a> · Prefer your own sheet? <a href="/#add">Add a suite</a></p></article>`, { section: 'guide' });
}

const CSS = `
.guide { max-width:780px; }
.g-picks { display:grid; grid-template-columns:repeat(3, 1fr); gap:var(--s3); margin:0 0 var(--s6); }
.g-pick { display:grid; gap:4px; align-content:start; padding:var(--s4); border:1px solid var(--line); border-radius:var(--r); background:var(--card); box-shadow:var(--shadow); text-decoration:none; color:var(--text); transition:border-color .12s, box-shadow .12s; }
.g-pick:hover { border-color:var(--brand); box-shadow:var(--shadow-lg); }
.g-pick span { color:var(--muted); font-size:13px; } .g-pick i { color:var(--link); font-size:12.5px; margin-top:4px; }
.g-line { list-style:none; margin:0; padding:0; position:relative; }
.g-line::before { content:''; position:absolute; left:15px; top:8px; bottom:24px; width:2px; background:var(--line); }
.g-step { position:relative; padding:0 0 var(--s4) 52px; animation:g-in .4s ease both; animation-delay:var(--d); }
.g-node { position:absolute; left:0; top:var(--s4); width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:var(--brand-solid); color:#fff; font-weight:700; font-size:14px; box-shadow:0 0 0 4px var(--bg); }
.g-card { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:var(--s4) var(--s5); box-shadow:var(--shadow); }
.g-card h2 { margin:0 0 4px; font-size:16px; } .g-card p { margin:0 0 var(--s3); color:var(--muted); }
.g-card details { margin-top:var(--s2); }
.g-card ul { margin:6px 0 0; padding-left:20px; font-size:13.5px; }
@keyframes g-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) { .g-step { animation:none; } }
@media (max-width:700px) { .g-picks { grid-template-columns:1fr; } .g-card { padding:var(--s3) var(--s4); } }
`;
