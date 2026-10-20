import { parse } from 'csv-parse/sync';
import { config } from './config.js';

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
}

const SHEET_COLUMNS = ['TC ID', 'Test Scenario', 'Test Case', 'Type', 'Priority', 'Preconditions', 'Test Steps', 'Test Data', 'Expected Result'];

export async function loadTestCases(): Promise<TestCase[]> {
  const url = `https://docs.google.com/spreadsheets/d/${config.sheetId}/export?format=csv&gid=${config.sheetGid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the sheet (HTTP ${res.status}). Is it shared as "anyone with the link"?`);
  return parseSheet(await res.text());
}

export function parseSheet(csv: string): TestCase[] {
  const rows: Record<string, string>[] = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
  const missing = SHEET_COLUMNS.filter((c) => rows.length && !(c in rows[0]));
  if (missing.length) throw new Error(`Sheet is missing columns: ${missing.join(', ')}`);

  return rows
    // "Scenario N: ..." rows are section headers, not test cases.
    .filter((r) => r['TC ID']?.trim() && !/^Scenario\s+\d+/i.test(r['TC ID']))
    .map((r) => ({
      id: r['TC ID'].trim(),
      scenario: r['Test Scenario'].trim(),
      title: r['Test Case'].trim(),
      type: r['Type'].trim(),
      priority: r['Priority'].trim(),
      preconditions: r['Preconditions'].trim(),
      steps: splitList(r['Test Steps'], /^\d+\.\s*/),
      testData: r['Test Data'].trim(),
      expected: splitList(r['Expected Result'], /^[•\-*]\s*/),
    }));
}

function splitList(text: string, bullet: RegExp): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(bullet, ''));
}
