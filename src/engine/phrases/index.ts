import { Blocked, CaseContext, verdictFrom, type CaseResult } from '../context.js';
import type { Session } from '../session.js';
import type { TestCase } from '../sources/cases.js';
import { healthProblems, inspectPage } from '../inspect.js';
import { Missing } from '../ui.js';
import { EXPECT_RULES, type ExpectRule } from './expects.js';
import { BEHAVIOUR_RULES } from './behaviour.js';
import { FORM_EXPECT_RULES } from './form-expects.js';
import { ALL_STEP_RULES } from './natural.js';
import { ACTION_EXPECTS, ACTION_RULES } from './actions.js';
import { approved, type Kind } from '../ai/translate.js';
import { liveEnabled, prepareAiProduct, recoverStep, understandExpect, understandStep } from '../ai/assist.js';
import { fallbackCheck, fallbackKind } from './fallback.js';
import { applyFixtures, planFixtures } from './fixtures.js';
import { expectClauses, stepClauses } from './split.js';
import type { StepRule } from './steps.js';

/** How the engine reads one test case, without running it. Shown in the UI so testers can fix wording before a run. */
export interface Preview {
  steps: { sentence: string; clauses: { text: string; rule: string | null; via?: 'ai' | 'live' }[] }[];
  expects: { sentence: string; claims: { text: string; rule: string | null; via?: 'ai' }[] }[];
  understood: number;
  total: number;
  /** Sentences no rule and no approved rewrite understands; the AI translator can suggest rewrites for these. */
  unknown: { kind: Kind; text: string }[];
}

/** An approved AI rewrite for a sentence: its lines and the rule each line maps to. Lines no rule reads are dropped. */
function rewrite(kind: Kind, text: string): { lines: { text: string; step?: StepRule; expect?: ExpectRule }[]; note: string } | null {
  const a = approved(kind, text);
  if (!a) return null;
  const lines = a.lines.map((l) => ({ text: l, step: ACTION_RULES.find((r) => r.pattern.test(l)), expect: ACTION_EXPECTS.find((r) => r.pattern.test(l)) }));
  return { lines: lines.filter((l) => l.step || l.expect), note: a.note };
}

/** Exact sheet phrasings first, then the behaviour checks for plain-language expected results. */
function expectRule(claim: string, form = false): ExpectRule | undefined {
  const c = claim.trim();
  // On the product form, its own checks come first ("Options should be: …" means the dropdown, not the sort menu).
  // EXPECT … lines (upper-case, as the action language writes them) are exact checks; everything else uses the rules.
  if (/^EXPECT\b/.test(c)) return ACTION_EXPECTS.find((r) => r.pattern.test(c));
  return (form ? FORM_EXPECT_RULES.find((r) => r.pattern.test(c)) : undefined) ?? EXPECT_RULES.find((r) => r.pattern.test(c)) ?? BEHAVIOUR_RULES.find((r) => r.pattern.test(c)) ?? ACTION_EXPECTS.find((r) => r.pattern.test(c));
}

/** A case is about the product form when one of its steps opens it (Add Product / Edit / Save Product). */
export function aboutProductForm(tc: TestCase): boolean {
  return /'add product'|add product button|'save product'|click 'edit' on|edit page|^edit a (?:variable |simple )?product|products\/(?:new|.*edit)/im.test([...tc.steps, tc.url].join('\n'));
}

function resolveClauses(sentence: string, form = false): { text: string; rule: StepRule | null; via?: 'ai' | 'live' }[] {
  const out: { text: string; rule: StepRule | null; via?: 'ai' | 'live' }[] = [];
  // Specific rules know the app (fixtures, waits, confirmations); the generic actions come after them.
  const rules = [...(form ? ALL_STEP_RULES : ALL_STEP_RULES.filter((r) => !r.formOnly)), ...ACTION_RULES];
  // On the product form, a whole sentence a form rule understands ("Enter each invalid value … in A, B and C") stays one step.
  const whole = sentence.trim().replace(/\.$/, '');
  // A sentence written in the action language (an AI rewrite or typed that way) is one action as written.
  const exact = ACTION_RULES.find((r) => r.pattern.test(whole));
  if (exact && /^(GO TO|CLICK|DOUBLE CLICK|TYPE|ENTER|FILL|CLEAR|SELECT|CHOOSE|PICK|TURN (ON|OFF)|CHECK|UNCHECK|TICK|UNTICK|PRESS|WAIT|UPLOAD)\b/.test(whole) && !rules.slice(0, -ACTION_RULES.length).some((r) => r.pattern.test(whole))) return [{ text: whole, rule: exact }];
  if (form) {
    const rule = rules.find((r) => r.formOnly && r.pattern.test(whole));
    if (rule) return [{ text: whole, rule }];
    // "Go back to the Products page and search for the product" is one look-up of what was saved.
    if (/^go back to the products page and search for the product$/i.test(whole)) {
      const find = rules.find((r) => r.name === 'form: find saved product in the list');
      if (find) return [{ text: whole, rule: find }];
    }
  }
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
    const rule = rules.find((r) => r.pattern.test(text)) ?? null;
    if (!c.continuation && rule) lastVerb = text;
    out.push({ text, rule });
  }
  // Pieces no rule reads: use an approved rewrite of the whole sentence, else of the piece itself.
  if (out.some((c) => !c.rule)) {
    const all = rewrite('step', whole);
    if (all?.lines.length) return all.lines.filter((l) => l.step).map((l) => ({ text: l.text, rule: l.step!, via: 'ai' as const }));
    if (all && !all.lines.length) return [{ text: whole, rule: SKIPPED(all.note), via: 'ai' }];
    return out.flatMap((c) => {
      if (c.rule) return [c];
      const r = rewrite('step', c.text);
      if (!r) return [c];
      if (!r.lines.length) return [{ text: c.text, rule: SKIPPED(r.note), via: 'ai' as const }];
      return r.lines.filter((l) => l.step).map((l) => ({ text: l.text, rule: l.step!, via: 'ai' as const }));
    });
  }
  return out;
}

/** A step line inside an expected-result rewrite (open the tab the check is about); it records no check itself. */
function SHOW(step: StepRule): ExpectRule {
  return { name: 'show first', pattern: step.pattern, check: async (t, m, claim) => { await step.run(t, m, claim); } };
}

/** A reviewed "cannot be automated" answer: the step is noted, not failed. */
function SKIPPED(note: string): StepRule {
  return { name: 'not automated (reviewed)', pattern: /[\s\S]*/, run: async (t) => { t.note(note || 'Marked as not automatable when the AI suggestion was reviewed.'); return note || 'Not automated.'; } };
}

export function previewCase(tc: TestCase): Preview {
  const form = aboutProductForm(tc);
  const steps = tc.steps.map((s) => ({ sentence: s, clauses: resolveClauses(s, form).map((c) => ({ text: c.text, rule: c.rule?.name ?? null, via: c.via })) }));
  const expects = tc.expected.map((e) => ({ sentence: e, claims: resolveClaims(e, form).map((c) => ({ text: c.text, rule: c.rule, via: c.via })) }));
  const all = [...steps.flatMap((s) => s.clauses), ...expects.flatMap((e) => e.claims)];
  const unknown = [
    ...steps.filter((s) => s.clauses.some((c) => !c.rule)).map((s) => ({ kind: 'step' as const, text: s.sentence.trim().replace(/\.$/, '') })),
    ...expects.flatMap((e) => e.claims.filter((c) => !c.rule).map((c) => ({ kind: 'expect' as const, text: c.text }))),
  ];
  return { steps, expects, understood: all.filter((x) => x.rule).length, total: all.length, unknown };
}

/** Expected-result claims with their check: a rule, the page fallback, or an approved rewrite into EXPECT lines. */
function resolveClaims(sentence: string, form: boolean): { text: string; rule: string | null; check?: ExpectRule; via?: 'ai'; reviewedNote?: string }[] {
  return expectClauses(sentence).flatMap((c) => {
    const rule = expectRule(c, form);
    if (rule) return [{ text: c, rule: rule.name, check: rule }];
    const r = rewrite('expect', c);
    if (r?.lines.length) return r.lines.map((l) => (l.expect
      ? { text: l.text, rule: l.expect.name, check: l.expect, via: 'ai' as const }
      : { text: l.text, rule: 'show first', check: SHOW(l.step!), via: 'ai' as const }));
    if (r) return [{ text: c, rule: 'not automated (reviewed)', via: 'ai' as const, reviewedNote: r.note }];
    return [{ text: c, rule: fallbackKind(c) }];
  });
}

/** A case that runs longer than this is stopped and reported as a bot error, so one stuck page cannot hold up a run. */
const CASE_TIMEOUT_MS = Number(process.env.CASE_TIMEOUT_SECONDS ?? 600) * 1000;

/** Runs one test case with a time limit (see CASE_TIMEOUT_MS). */
export async function runCase(tc: TestCase, session: Session, runDir: string, startPath: string, onStep?: (text: string) => void): Promise<CaseResult> {
  const started = Date.now();
  let lastStep = '';
  const work = runCaseInner(tc, session, runDir, startPath, (x) => { lastStep = x; onStep?.(x); });
  return withTimeout(work, CASE_TIMEOUT_MS, 'case').catch((e) => ({
    tc, verdict: 'Error' as const, checks: [], steps: [], notes: [`Stopped after ${Math.round(CASE_TIMEOUT_MS / 1000)}s at: ${lastStep}`], screenshots: [],
    consoleErrors: [], failedRequests: [], error: (e as Error).message, durationMs: Date.now() - started,
  }));
}

/** Runs one test case: prepare data → run each step (snapshot after each) → check each expected result. */
async function runCaseInner(tc: TestCase, session: Session, runDir: string, startPath: string, onStep?: (text: string) => void): Promise<CaseResult> {
  const started = Date.now();
  // A row's own URL wins over the suite's start page.
  startPath = tc.url || startPath;
  const t = new CaseContext(tc, session, runDir, startPath);
  let error: string | undefined;
  try {
    await t.init();
    onStep?.(`Inspecting ${startPath}`);
    // The page check is evidence, not the test: never let a slow page hold the case up for long.
    t.inspection = await withTimeout(inspectPage(t, startPath), 90_000, 'page check').catch((e) => {
      t.note(`Could not inspect the page: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    });
    const plan = planFixtures(t);
    t.noted.set('__values', plan.values);
    await applyFixtures(t, plan);
    // When AI help may drive steps that change a product, create its test product now, before the page loads.
    const form = aboutProductForm(tc);
    if (liveEnabled() && tc.steps.some((s) => resolveClauses(s, form).some((c) => !c.rule))) await prepareAiProduct(t);
    await t.ui.goto(startPath);
    await t.snap('start', 'initial');

    // Steps are grouped by sentence, so live AI help can read a whole sentence it does not understand.
    const groups = tc.steps.map((sentence) => ({ sentence: sentence.trim().replace(/\.$/, ''), clauses: resolveClauses(sentence, form) }));
    let stop = false;
    for (const [gi, g] of groups.entries()) {
      if (stop) break;
      // Rules missed part of the sentence: ask the AI for the whole sentence once, and run its lines instead.
      if (g.clauses.some((c) => !c.rule) && liveEnabled()) {
        onStep?.(`Asking AI: ${g.sentence}`);
        const ai = await understandStep(t, g.sentence);
        if (ai?.lines.length) {
          g.clauses = ai.lines.map((l) => ({ text: l.text, rule: l.rule, via: 'live' as const }));
          t.note(`AI read "${g.sentence}" as: ${ai.lines.map((l) => l.text).join(' → ')} (${ai.model}). Approve it under Review rewrites to reuse it without AI.`);
        } else if (ai && !ai.lines.length) {
          t.steps.push({ text: g.sentence, status: 'skipped', detail: `AI: ${ai.note || 'cannot be done by the robot'}`, via: 'ai' });
          t.note(`AI says "${g.sentence}" cannot be done by the robot: ${ai.note || 'no reason given'}.`);
          continue;
        }
      }
      for (const [ci, clause] of g.clauses.entries()) {
        onStep?.(clause.text);
        const next = g.clauses[ci + 1]?.text ?? groups[gi + 1]?.clauses[0]?.text ?? '';
        t.noted.set('__next', next);
        const rule = clause.rule;
        const via = clause.via === 'ai' ? 'approved' : clause.via === 'live' ? 'ai' : 'rules';
        const label = clause.via === 'ai' ? `${clause.text} (AI rewrite, approved)` : clause.via === 'live' ? `${clause.text} (AI)` : clause.text;
        if (!rule) {
          // Keep going: the remaining steps and the expected results are still checked against the page.
          t.steps.push({ text: clause.text, status: 'unmatched', detail: 'not understood, skipped' });
          t.note(`Step not understood and skipped: "${clause.text}". Results after it may not reflect that step.`);
          continue;
        }
        try {
          const detail = await rule.run(t, clause.text.match(rule.pattern)!, clause.text);
          t.steps.push({ text: label, status: 'done', detail: detail || undefined, via });
        } catch (e) {
          if (e instanceof Blocked) {
            t.steps.push({ text: label, status: 'skipped', detail: e.message, via });
            if (!e.soft) throw e;
            t.note(e.message);
            stop = true;
            break;
          }
          const msg = e instanceof Missing ? e.message : (e as Error).message.split('\n')[0];
          // The step failed on the page: let the AI look at what is there and try a corrected version.
          // The same wrong name can recur in later AI lines ("open the dialog again"); reuse the fix that worked.
          const learned = (t.noted.get('__aiFixes') as Map<string, { text: string; rule: StepRule }[]> | undefined)?.get(clause.text);
          if (learned) {
            let ok = true;
            for (const l of learned) await l.rule.run(t, l.text.match(l.rule.pattern)!, l.text).catch(() => { ok = false; });
            if (ok) {
              t.steps.push({ text: label, status: 'done', detail: `Same fix as earlier: ${learned.map((l) => l.text).join(' → ')}`, via: 'ai' });
              await t.snap(clause.text);
              continue;
            }
          }
          if (liveEnabled() && !t.noted.get(`__recovered:${clause.text}`)) {
            t.noted.set(`__recovered:${clause.text}`, true);
            onStep?.(`Step failed, asking AI: ${clause.text}`);
            // Repair just this action (with the sentence it came from as context), not the whole sentence again.
            const rest = g.clauses.slice(ci + 1).map((c) => c.text);
            const fix = await recoverStep(t, clause.text, msg, { sentence: g.sentence, later: rest });
            if (fix?.lines.length) {
              const done: string[] = [];
              let fixed = true;
              for (const l of fix.lines) {
                try {
                  await l.rule.run(t, l.text.match(l.rule.pattern)!, l.text);
                  done.push(l.text);
                } catch (e2) {
                  fixed = false;
                  t.note(`AI's corrected step "${l.text}" also failed: ${(e2 as Error).message.split('\n')[0].slice(0, 140)}`);
                  break;
                }
              }
              if (fixed) {
                const fixes = (t.noted.get('__aiFixes') as Map<string, { text: string; rule: StepRule }[]> | undefined) ?? new Map();
                fixes.set(clause.text, fix.lines);
                t.noted.set('__aiFixes', fixes);
                const why = msg.split('(found:')[0].trim();
                t.steps.push({ text: label, status: 'done', detail: `As written it failed (${why.slice(0, 120)}); the AI did instead: ${done.join(' → ')}`, via: 'ai' });
                t.note(`"${clause.text}" failed as written; the AI's corrected version worked: ${done.join(' → ')} (${fix.model}).`);
                // Not a pass for the step as written: a person decides whether the sheet's wording or the app is wrong.
                t.skip(`Step as written: "${clause.text}"`, `${why}. The AI continued with: ${done.join(' → ')}. If the sheet is right, this is a finding (for example a renamed or missing button); otherwise update the step.`);
                await t.snap(clause.text);
                continue;
              }
            }
          }
          t.steps.push({ text: label, status: 'failed', detail: msg, via });
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
      for (const resolved of resolveClaims(sentence, aboutProductForm(tc))) {
        const claim = resolved.text;
        const rule = resolved.check;
        if (resolved.reviewedNote !== undefined) {
          t.skip(claim, resolved.reviewedNote || 'Marked as not automatable when the AI suggestion was reviewed; check it by hand.');
          continue;
        }
        if (!rule) {
          if (await fallbackCheck(t, claim).catch(() => false)) continue;
          const ai = liveEnabled() ? await understandExpect(t, claim) : null;
          if (ai?.lines.length) {
            t.note(`AI read the expected result "${claim}" as: ${ai.lines.map((l) => l.text).join(' · ')} (${ai.model}).`);
            for (const l of ai.lines) {
              if ('step' in l) {
                // Show the tab / section the check is about first.
                await l.step.run(t, l.text.match(l.step.pattern)!, l.text).catch((e) => t.note(`Could not open what "${claim}" is about (${l.text}): ${(e as Error).message.split('\n')[0].slice(0, 120)}`));
                continue;
              }
              const before = t.checks.length;
              await l.check.check(t, l.text.match(l.check.pattern)!, l.text).catch((e) => t.skip(l.text, `Could not check: ${(e as Error).message.split('\n')[0]}`));
              for (const c of t.checks.slice(before)) {
                c.label = `${claim} → AI checked: ${l.text.replace(/^EXPECT /, '').toLowerCase()}`;
                // An AI-written check that does not hold may be a real bug or a misreading; a person decides.
                if (c.state === 'fail') {
                  c.state = 'review';
                  c.cause = 'This check was written by AI from the sentence. Look at the screenshot: if the page is wrong, it is a bug; if the check is wrong, correct it under Review rewrites.';
                }
              }
            }
            continue;
          }
          t.skip(claim, ai ? `AI says this cannot be checked by the robot: ${ai.note || 'no reason given'}` : `Not understood by the bot — compare with the page by hand.${pageGist(t)}`);
          continue;
        }
        const before = t.checks.length;
        try {
          await rule.check(t, claim.match(rule.pattern)!, claim);
        } catch (e) {
          if (e instanceof Blocked) t.skip(claim, e.message);
          else t.skip(claim, `Could not check: ${(e as Error).message.split('\n')[0]}`);
        }
        if (t.checks.length === before && rule.name !== 'observation note' && rule.name !== 'show first') t.skip(claim, 'Nothing to compare (the steps did not produce what this needs).');
      }
    }
    // Nothing could be compared: the page's own health (errors, failed requests, blank page) is the finding.
    if (t.inspection && !t.checks.some((c) => c.state === 'pass' || c.state === 'fail' || c.state === 'review')) {
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

/** Rejects if `work` takes longer than `ms` (the work itself keeps running in the background and is ignored). */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** " Page shows: heading · heading · …" to help a person judge a claim the bot could not. */
function pageGist(t: CaseContext): string {
  const i = t.inspection;
  if (!i) return '';
  const bits = [...i.headings.slice(0, 4), ...i.buttons.slice(0, 6)];
  return bits.length ? ` Page shows: ${bits.join(' · ').slice(0, 220)}.` : '';
}
