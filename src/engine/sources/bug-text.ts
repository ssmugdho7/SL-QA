import { pagePath } from '../pages.js';
import { rowUrl, splitList } from './cases.js';

/** What a pasted bug report (Jira, email, chat) holds, in test-case terms. */
export interface BugText {
  title: string;
  preconditions: string;
  steps: string[];
  expected: string[];
  reported: string;
  url: string;
}

const SECTIONS: [keyof BugText | 'skip', RegExp][] = [
  ['preconditions', /^pre-?\s?conditions?/i],
  ['steps', /^(?:steps?\s+to\s+reproduce|repro(?:duction)?\s+steps|steps)/i],
  ['reported', /^actual(?:\s+(?:result|behaviou?r|outcome))?/i],
  ['expected', /^expected(?:\s+(?:result|behaviou?r|outcome))?/i],
  ['title', /^(?:summary|title)/i],
  ['skip', /^(?:description|attachments?|environment|notes?)\b/i],
];

/** True when the text looks like a bug report with named sections (not a plain list of steps). */
export function looksLikeBugText(text: string): boolean {
  return /steps\s+to\s+reproduce|expected\s+result\s*:|actual\s+result\s*:/i.test(text);
}

/**
 * Reads a bug report pasted as plain text: "Pre-condition:", "Steps to reproduce:" (numbered lines),
 * "Actual result:", "Expected result:". Sections may sit on their own line or start a line ("Actual result: …").
 * Attachment references ("Please see [^bug 2.png]") are dropped.
 */
export function parseBugText(text: string): BugText {
  const out: BugText = { title: '', preconditions: '', steps: [], expected: [], reported: '', url: '' };
  const buckets: Record<string, string[]> = { title: [], preconditions: [], steps: [], reported: [], expected: [], skip: [] };
  let current: string | null = null;
  const lead: string[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const head = SECTIONS.find(([, re]) => re.test(line) && /^[^:]{0,40}:|^[\w\s-]{0,40}$/.test(line));
    if (head) {
      current = head[0];
      const rest = line.replace(/^[^:]*:\s*/, line.includes(':') ? '' : line);
      if (rest && rest !== line) buckets[current].push(rest);
      continue;
    }
    (current ? buckets[current] : lead).push(line);
  }
  out.title = clean(buckets.title.join(' ') || lead[0] || '');
  out.preconditions = clean(buckets.preconditions.join(' '));
  out.steps = splitList(buckets.steps.join('\n'), /^(?:step\s*)?\d+\s*[.):-]\s*|^[•\-*]\s*/i).map(clean).filter(Boolean);
  out.reported = clean(buckets.reported.join(' '));
  out.expected = sentences(clean(buckets.expected.join(' ')));
  // The page the steps navigate to is where the bug is; a link to the dashboard home is only the way in.
  const named = out.steps.map((st) => st.match(/^(?:navigate|go|open|visit|switch)\s+(?:to\s+)?(?:the\s+)?(.+?)\s+(?:page|screen)\b/i)?.[1]).map((n) => (n ? pagePath(n) : null)).find(Boolean);
  const linked = rowUrl({ text });
  out.url = named && (!linked || linked === '/dashboard') ? named : linked;
  if (!out.title) out.title = (out.reported || out.expected[0] || 'Pasted bug').slice(0, 100);
  return out;
}

/** Drops attachment references and Jira markup. */
function clean(s: string): string {
  return s
    .replace(/(?:please\s+)?see\s*\[\^?[^\]]*\]\.?/gi, '')
    .replace(/\[\^?[^\]]*\.(?:png|jpe?g|gif|mp4|mov|webm)\]/gi, '')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.]+$/, (m) => (m.includes('.') ? '.' : ''));
}

/** A paragraph → its sentences, keeping "e.g." / "i.e." and amounts like "70.00" intact. */
export function sentences(paragraph: string): string[] {
  if (!paragraph) return [];
  const safe = paragraph.replace(/\b(e\.g|i\.e|etc|approx|vs)\./gi, (m) => m.replace(/\./g, '\u0002'));
  return safe
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.replace(/\u0002/g, '.').trim().replace(/\.$/, ''))
    .filter((s) => s.length > 2);
}
