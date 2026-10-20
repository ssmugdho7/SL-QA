import { looksLikeBugText, parseBugText } from './bug-text.js';

export interface TestCase {
  id: string;
  scenario: string;
  title: string;
  type: string;
  priority: string;
  preconditions: string;
  steps: string[];
  testData: string;
  expected: string[];
  /** Optional strict instructions from an "Automation" column, one per line. */
  automation: string;
  /** Page the case starts on: a URL/Page/Link column, else a link in the row's text. Empty = the suite's start page. */
  url: string;
  /** What the tester saw ("Actual Result" column, or typed in when adding an issue by hand). */
  reported?: string;
  /** Added by hand in the app, not read from the sheet; kept when the sheet is re-read. */
  manual?: boolean;
  /** A sheet row changed in the app; re-reading the sheet keeps this version. */
  edited?: boolean;
}

export const REQUIRED_COLUMNS = ['Expected Result'];

/** Column names accepted for each field; QA test sheets and free-form bug sheets name them differently. */
const ALIASES: Record<string, string[]> = {
  id: ['TC ID', 'ID', 'Bug ID', 'Issue ID', 'Case ID', 'Key'],
  title: ['Test Case', 'Title', 'Summary', 'Issue', 'Bug'],
  description: ['Description', 'Bug Report', 'Details', 'Report'],
  steps: ['Test Steps', 'Steps', 'Steps to Reproduce', 'Steps To Reproduce', 'Repro Steps'],
  expected: ['Expected Result', 'Expected', 'Expected Behaviour', 'Expected Behavior', 'Expected Outcome'],
  actual: ['Actual Result', 'Actual', 'Actual Behaviour', 'Actual Behavior'],
};

/** Turns sheet rows (header → cell) into test cases. "Scenario N:" rows are section headers. */
export function casesFromRows(rows: Record<string, string>[]): TestCase[] {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const column = (field: string) => ALIASES[field].find((a) => headers.some((h) => h.trim().toLowerCase() === a.toLowerCase()));
  const key = (name: string | undefined) => (name ? headers.find((h) => h.trim().toLowerCase() === name.toLowerCase())! : '');
  const [idKey, titleKey, stepsKey, expectedKey, actualKey, descKey] = ['id', 'title', 'steps', 'expected', 'actual', 'description'].map((f) => key(column(f)));
  if (rows.length && !expectedKey && !descKey && !URL_COLUMNS.some((c) => c in rows[0])) throw new Error(`Sheet is missing columns: ${REQUIRED_COLUMNS.join(', ')} (or a URL or Description column)`);
  const cell = (r: Record<string, string>, k: string) => (k ? (r[k] ?? '').toString().trim() : '');

  return rows
    .map((r, i) => ({ r, n: i + 2 }))
    .filter(({ r }) => !/^Scenario\s+\d+/i.test(cell(r, idKey)))
    .filter(({ r }) => (idKey ? cell(r, idKey) : cell(r, expectedKey) || cell(r, descKey) || rowUrl(r)))
    .map(({ r, n }) => {
      const expected = cell(r, expectedKey);
      // A whole bug report pasted into one cell (Jira style): read its sections; filled-in columns still win.
      const desc = cell(r, descKey);
      const bug = desc && looksLikeBugText(desc) ? parseBugText(`${cell(r, titleKey)}\n${desc}`) : null;
      if (bug) {
        return {
          id: cell(r, idKey) || `ROW-${n}`,
          scenario: cell(r, 'Test Scenario'),
          title: cell(r, titleKey) || bug.title,
          type: cell(r, 'Type') || 'Bug',
          priority: cell(r, 'Priority'),
          preconditions: cell(r, 'Preconditions') || bug.preconditions,
          steps: cell(r, stepsKey) ? splitList(cell(r, stepsKey), /^\d+[.)]\s*/) : bug.steps,
          testData: cell(r, 'Test Data'),
          expected: expected ? splitList(expected, /^[•\-*]\s*/) : bug.expected,
          automation: cell(r, 'Automation'),
          url: URL_COLUMNS.some((k) => (r[k] ?? '').toString().trim()) ? rowUrl(r) : bug.url,
          reported: cell(r, actualKey) || bug.reported,
        };
      }
      return {
        id: cell(r, idKey) || `ROW-${n}`,
        scenario: cell(r, 'Test Scenario'),
        title: cell(r, titleKey) || expected.split('\n')[0].replace(/^[•\-*]\s*/, '').slice(0, 80) || `Row ${n}`,
        type: cell(r, 'Type'),
        priority: cell(r, 'Priority'),
        preconditions: cell(r, 'Preconditions'),
        steps: splitList(cell(r, stepsKey), /^\d+[.)]\s*/),
        testData: cell(r, 'Test Data'),
        expected: splitList(expected, /^[•\-*]\s*/),
        automation: cell(r, 'Automation'),
        url: rowUrl(r),
        reported: cell(r, actualKey),
      };
    });
}

const URL_COLUMNS = ['URL', 'Url', 'Page URL', 'Page', 'Link', 'Page Link'];

/** Dashboard path for a row, from a URL column or the first slshop link / dashboard path in its text. */
export function rowUrl(r: Record<string, string>): string {
  const column = URL_COLUMNS.map((k) => (r[k] ?? '').toString().trim()).find(Boolean);
  const text = column || Object.values(r).join('\n');
  // Outside a URL column, only links to the app count (a sheet often links docs or designs in its remarks).
  const link = column?.match(/^https?:\/\/\S+/)?.[0]
    ?? text.match(/https?:\/\/(?:www\.)?slshop\.cloud[^\s'"<>)]*/i)?.[0]
    ?? text.match(/(?:^|[\s'"(])(\/dashboard[^\s'"<>),]*)/)?.[1];
  if (!link) return '';
  // Paths on the app itself are kept relative so they open in the logged-in session.
  const m = link.match(/^https?:\/\/(?:www\.)?slshop\.cloud(\/[^\s]*)?$/i);
  return m ? m[1] || '/dashboard' : link.replace(/[.,;]+$/, '');
}

export function splitList(text: string, bullet: RegExp): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(bullet, ''));
}
