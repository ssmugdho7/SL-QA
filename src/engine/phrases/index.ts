import { Blocked, CaseContext, verdictFrom, type CaseResult } from '../context.js';
import type { Session } from '../session.js';
import type { TestCase } from '../sources/cases.js';
import { healthProblems, inspectPage } from '../inspect.js';
import { Missing } from '../ui.js';
import { EXPECT_RULES, type ExpectRule } from './expects.js';
import { BEHAVIOUR_RULES } from './behaviour.js';
import { ALL_STEP_RULES } from './natural.js';
import { fallbackCheck, fallbackKind } from './fallback.js';
import { applyFixtures, planFixtures } from './fixtures.js';
import { expectClauses, stepClauses } from './split.js';
import type { StepRule } from './steps.js';

/** How the engine reads one test case, without running it. Shown in the UI so testers can fix wording before a run. */
export interface Preview {
  steps: { sentence: string; clauses: { text: string; rule: string | null }[] }[];
  expects: { sentence: string; claims: { text: string; rule: string | null }[] }[];
  understood: number;
  total: number;
}

/** Exact sheet phrasings first, then the behaviour checks for plain-language expected results. */
function expectRule(claim: string): ExpectRule | undefined {
  const c = claim.trim();
  return EXPECT_RULES.find((r) => r.pattern.test(c)) ?? BEHAVIOUR_RULES.find((r) => r.pattern.test(c));
}

function resolveClauses(sentence: string): { text: string; rule: StepRule | null }[] {
  const out: { text: string; rule: StepRule | null }[] = [];
  let lastVerb = '';
  for (const c of stepClauses(sentence)) {
    // "Click the 'All' tab, then 'Active'" → "Click the 'Active' tab": reuse the previous action's wording.
    let text = c.text;
    // "Find a Variable product, e.g. BASHPATA": an example, not another action.
    if (c.continuation && /^(?:e\.g\.|i\.e\.|for example|such as)\s/i.test(c.text)) continue;
    if (c.continuation && lastVerb) {
      const own = text.replace(/^(?:and\s+)?/i, '');
      const slot = /'[^']*'|\b\d+\b|\b(next|previous|last|first)\b/i;
      // "Click the 'All' tab, then 'Active'" → swap the quoted part; "Look at the header, the buttons" → "Look at the buttons".
      text = slot.test(lastVerb) && /^'[^']*'$|^\d+$|^(next|previous|last|first)$/i.test(own) ? lastVerb.replace(slot, own) : `${lastVerb.split(/\s+/).slice(0, /^(look|check|compare)\b/i.test(lastVerb) ? 2 : 1).join(' ')} ${own}`;
    }
    const rule = ALL_STEP_RULES.find((r) => r.pattern.test(text)) ?? null;
    if (!c.continuation && rule) lastVerb = text;
    out.push({ text, rule });
  }
  return out;
}

export function previewCase(tc: TestCase): Preview {
  const steps = tc.steps.map((s) => ({ sentence: s, clauses: resolveClauses(s).map((c) => ({ text: c.text, rule: c.rule?.name ?? null })) }));
  const expects = tc.expected.map((e) => ({ sentence: e, claims: expectClauses(e).map((c) => ({ text: c, rule: expectRule(c)?.name ?? fallbackKind(c) })) }));
  const all = [...steps.flatMap((s) => s.clauses), ...expects.flatMap((e) => e.claims)];
  return { steps, expects, understood: all.filter((x) => x.rule).length, total: all.length };
}

/** Runs one test case: prepare data → run each step (snapshot after each) → check each expected result. */
export async function runCase(tc: TestCase, session: Session, runDir: string, startPath: string, onStep?: (text: string) => void): Promise<CaseResult> {
  const started = Date.now();
  // A row's own URL wins over the suite's start page.
  startPath = tc.url || startPath;
  const t = new CaseContext(tc, session, runDir, startPath);
  let error: string | undefined;
  try {
    await t.init();
    onStep?.(`Inspecting ${startPath}`);
    t.inspection = await inspectPage(t, startPath).catch((e) => {
      t.note(`Could not inspect the page: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    });
    const plan = planFixtures(t);
    t.noted.set('__values', plan.values);
    await applyFixtures(t, plan);
    await t.ui.goto(startPath);
    await t.snap('start', 'initial');

    const clauses = tc.steps.flatMap((sentence) => resolveClauses(sentence));
    for (const [i, clause] of clauses.entries()) {
      {
        onStep?.(clause.text);
        t.noted.set('__next', clauses[i + 1]?.text ?? '');
        const rule = clause.rule;
        if (!rule) {
          // Keep going: the remaining steps and the expected results are still checked against the page.
          t.steps.push({ text: clause.text, status: 'unmatched', detail: 'not understood, skipped' });
          t.note(`Step not understood and skipped: "${clause.text}". Results after it may not reflect that step.`);
          continue;
        }
        try {
          const detail = await rule.run(t, clause.text.match(rule.pattern)!, clause.text);
          t.steps.push({ text: clause.text, status: 'done', detail: detail || undefined });
        } catch (e) {
          if (e instanceof Blocked) {
            t.steps.push({ text: clause.text, status: 'skipped', detail: e.message });
            if (!e.soft) throw e;
            t.note(e.message);
            break;
          }
          const msg = e instanceof Missing ? e.message : (e as Error).message.split('\n')[0];
          t.steps.push({ text: clause.text, status: 'failed', detail: msg });
          await t.shot('step failed');
          // A control named in the sheet that is missing from the page is a finding, not a bot error.
          if (e instanceof Missing) {
            t.check(`Step "${clause.text}" can be done`, false, msg, 'The control the test case names is not on the page (renamed, removed or hidden).');
            throw new StepStop();
          }
          throw e;
        }
        await t.snap(clause.text);
      }
    }
    await t.shot('end');

    for (const sentence of tc.expected) {
      for (const claim of expectClauses(sentence)) {
        const rule = expectRule(claim);
        if (!rule) {
          if (!(await fallbackCheck(t, claim).catch(() => false))) t.skip(claim, `Not understood by the bot — compare with the page by hand.${pageGist(t)}`);
          continue;
        }
        const before = t.checks.length;
        try {
          await rule.check(t, claim.match(rule.pattern)!, claim);
        } catch (e) {
          if (e instanceof Blocked) t.skip(claim, e.message);
          else t.skip(claim, `Could not check: ${(e as Error).message.split('\n')[0]}`);
        }
        if (t.checks.length === before && rule.name !== 'observation note') t.skip(claim, 'Nothing to compare (the steps did not produce what this needs).');
      }
    }
    // Nothing could be compared: the page's own health (errors, failed requests, blank page) is the finding.
    if (t.inspection && !t.checks.some((c) => c.state !== 'skip')) {
      const problems = healthProblems(t.inspection, { appOnly: true }).filter((p) => !/slow request/.test(p));
      t.check('Page loads without errors', !problems.length, problems.join('; ') || 'no console errors, failed app requests, error text or blank page', 'See Page health for the request or console error behind this.');
    }
  } catch (e) {
    if (e instanceof Blocked) {
      t.note(e.message);
      await t.cleanup();
      return t.result(t.checks.some((c) => c.state === 'fail') ? 'Fail' : 'Blocked', started);
    }
    if (!(e instanceof StepStop)) {
      error = (e as Error).message.split('\n').slice(0, 3).join(' ');
      await t.shot('error').catch(() => undefined);
    }
  }
  await t.cleanup();
  const verdict = error && !t.checks.some((c) => c.state === 'fail') ? 'Error' : verdictFrom(t.checks);
  return t.result(verdict, started, error);
}

class StepStop extends Error {}

/** " Page shows: heading · heading · …" to help a person judge a claim the bot could not. */
function pageGist(t: CaseContext): string {
  const i = t.inspection;
  if (!i) return '';
  const bits = [...i.headings.slice(0, 4), ...i.buttons.slice(0, 6)];
  return bits.length ? ` Page shows: ${bits.join(' · ').slice(0, 220)}.` : '';
}
