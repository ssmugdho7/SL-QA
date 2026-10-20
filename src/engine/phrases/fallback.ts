import type { CaseContext } from '../context.js';
import { healthProblems } from '../inspect.js';
import { lc, quoted, words } from './text.js';

const LOGIN_REDIRECT = /redirect(?:ed|s)? to (?:the )?(?:login|sign[- ]?in)/i;
const HEALTH = /\b(no|without|not show) (?:any )?(?:errors?|console errors?|crash)|should not (?:go blank|freeze|crash|break)|\b(?:load|open)s? (?:normally|correctly|successfully|fine|without)|should (?:load|open)\b(?! .*['‘"])/i;
const BROKEN_VALUES = /\b(?:NaN|undefined|blank values?|empty values?)\b/i;

/** Name of the fallback check that would handle this claim, or null. Used by the preview. */
export function fallbackKind(claim: string): string | null {
  if (LOGIN_REDIRECT.test(claim)) return 'page check: login redirect';
  if (HEALTH.test(claim)) return 'page check: no errors';
  if (BROKEN_VALUES.test(claim) && /\bno\b|\bnot\b/i.test(claim)) return 'page check: no broken values';
  if (quoted(claim).some((q) => q.trim().length > 1)) return 'page check: quoted text';
  return null;
}

/**
 * Checks for expected-result claims no rule understands. They only check what plain page evidence can settle:
 * quoted text that should (or should not) be on the page, "no errors / loads normally", and "redirects to login".
 * Anything else stays "not checked", with what the page showed, so a person can compare.
 */
export async function fallbackCheck(t: CaseContext, claim: string): Promise<boolean> {
  const negative = /\b(?:should|must|does|do|will)\s*(?:not|n't)\b|\bno\s+['‘"]|\bnever\b|\bwithout\b/i.test(claim);
  const page = await pageText(t);
  let handled = false;

  if (LOGIN_REDIRECT.test(claim)) {
    const at = t.page.url();
    t.check(claim, /\/(login|signin|sign-in)\b/i.test(new URL(at).pathname), `page is at ${new URL(at).pathname}`, 'The page is shown without checking the session; redirect to /login when there is no valid token.');
    handled = true;
  }

  if (HEALTH.test(claim) && t.inspection) {
    const problems = healthProblems(t.inspection, { appOnly: true }).filter((p) => !/slow request/.test(p));
    t.check(claim, !problems.length, problems.length ? problems.join('; ') : 'page loaded with no errors, failed requests or blank areas', 'See Page health for the failing request or console error behind this.');
    handled = true;
  }

  if (BROKEN_VALUES.test(claim) && /\bno\b|\bnot\b/i.test(claim)) {
    const bad = page.split('\n').filter((l) => /\bNaN\b|\bundefined\b|\bnull\b|\[object Object\]/.test(l)).slice(0, 4);
    t.check(claim, !bad.length, bad.length ? `page shows: ${bad.map((l) => `"${l.trim().slice(0, 80)}"`).join(', ')}` : 'no NaN / undefined / null values on the page', 'A value is rendered before it is computed or when the API returns null; format missing values as 0 or "—".');
    handled = true;
  }

  for (const text of quoted(claim).filter((q) => q.trim().length > 1)) {
    const found = present(page, text);
    if (negative) {
      t.check(`'${text}' is not shown`, !found, found ? `'${text}' is on the page` : 'not on the page');
    } else {
      t.check(`'${text}' is shown`, found, found ? 'found on the page' : `not on the page${nearest(page, text)}`, 'The text or control the sheet names is missing, renamed or hidden on this page.');
    }
    handled = true;
  }
  return handled;
}

async function pageText(t: CaseContext): Promise<string> {
  const live = await t.page.evaluate(() => document.body.innerText).catch(() => '');
  return [live, t.now?.text ?? ''].join('\n');
}

function present(page: string, text: string): boolean {
  if (lc(page).includes(lc(text))) return true;
  // Tolerate punctuation and spacing differences ("Sizes & colours" vs "Sizes &colours").
  return words(page).includes(words(text));
}

/** " (closest on the page: 'A', 'B')" — page lines sharing the most words with the wanted text. */
function nearest(page: string, text: string): string {
  const want = new Set(words(text).split(' ').filter((w) => w.length > 2));
  if (!want.size) return '';
  const lines = [...new Set(page.split('\n').map((l) => l.trim()).filter((l) => l && l.length < 80))];
  const scored = lines
    .map((l) => ({ l, n: words(l).split(' ').filter((w) => want.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.l.length - b.l.length)
    .slice(0, 3);
  return scored.length ? ` (closest on the page: ${scored.map((x) => `'${x.l}'`).join(', ')})` : '';
}
