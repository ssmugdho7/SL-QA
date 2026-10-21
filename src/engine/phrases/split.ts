import { splitKeep } from './text.js';

/** Verbs that start a new action inside a step sentence ("Open Filter, set Stock = 'Low stock', click Done and note the count"). */
const ACTION_VERBS = [
  'apply', 'change', 'check', 'choose', 'clear', 'click', 'close', 'compare', 'confirm', 'create', 'enter', 'find', 'go', 'log', 'look',
  'note', 'open', 'paste', 'pick', 'press', 'refresh', 'reload', 'repeat', 'return', 'save', 'scroll', 'select', 'set', 'switch',
  'tick', 'turn', 'type', 'use', 'wait', 'add', 'fill', 'navigate', 'observe', 'view', 'locate', 'tap', 'visit', 'verify',
  'upload', 'leave', 'try', 'drag', 'remove', 'keep', 'edit', 'delete', 'sell', 'place', 'pick', 'watch', 'search', 'switch',
].join('|');

const STEP_SEPARATOR = new RegExp(
  `\\s*,\\s*(?:and\\s+)?(?:then\\s+)?|\\s+and\\s+then\\s+|\\s+then\\s+|\\s+and\\s+(?=(?:${ACTION_VERBS})\\b)`,
  'gi',
);

export interface Clause {
  text: string;
  /** True for a bare continuation like "'Active'" in "Click the 'All' tab, then 'Active'", which reuses the previous action. */
  continuation: boolean;
}

/** One step sentence → the actions in it, in order. */
export function stepClauses(step: string): Clause[] {
  const text = step.trim().replace(/\.$/, '');
  const parts = splitKeep(text, STEP_SEPARATOR);
  // A leading context phrase ("On a Variable product, click …", "In Quick view, click …") belongs to the action after it.
  if (parts.length > 1 && /^(on|in|with|for) (a|an|any|the) [^,]+$|^(on|in|with) [^,]+$/i.test(parts[0].text) && !/^for each/i.test(parts[0].text)) {
    parts[1] = { text: `${parts[0].text}, ${parts[1].text}`, sep: parts[0].sep };
    parts.shift();
  }
  return parts.map((p) => ({
    text: p.text,
    continuation: !new RegExp(`^(?:${ACTION_VERBS}|in|on|with|for|after|then|and|this|again|now)\\b`, 'i').test(p.text),
  }));
}

const HAS_VERB = /\b(should|must)\b/i;
// Also splits sentences ("… total. If …") and "A should X or the layout should Y" (two separate claims).
const EXPECT_SEPARATOR = /\s*;\s*|\s*,\s*(?:and\s+)?|\s+and\s+|\s+—\s+|(?<=[\p{Ll}\d)'"])\.\s+(?=\p{Lu})|\s+or\s+(?=the\s+(?:layout|page|panel|grid|screen|design)\b[\w\s-]{0,30}?\s+should\b)/gu;

/**
 * One expected-result sentence → its separate claims.
 * "Low stock should increase by 1, Out of stock should increase by 1 and Active should decrease by 1" → three claims.
 * Pieces without "should" belong to a neighbour: "A, B and C should be visible" stays one claim.
 */
export function expectClauses(sentence: string): string[] {
  const text = sentence.trim().replace(/\.$/, '');
  const pieces = splitKeep(text, EXPECT_SEPARATOR);
  const out: string[] = [];
  let pending = '';
  for (const p of pieces) {
    if (HAS_VERB.test(p.text)) {
      out.push(pending ? `${pending}${p.sep}${p.text}` : p.text);
      pending = '';
    } else if (out.length && !pending) {
      out[out.length - 1] += `${p.sep}${p.text}`;
    } else {
      pending = pending ? `${pending}${p.sep}${p.text}` : p.text;
    }
  }
  if (pending) out.push(pending);
  return out.map((s) => s.trim()).filter(Boolean);
}
