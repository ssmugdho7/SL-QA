import { parse } from 'csv-parse/sync';
import { casesFromRows, type TestCase } from './cases.js';

/** "https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>" → its CSV export URL. */
export function sheetCsvUrl(url: string): string {
  const id = url.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];
  if (!id) throw new Error('That does not look like a Google Sheets link.');
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export async function casesFromSheet(url: string): Promise<TestCase[]> {
  // Google occasionally drops the first connection; retry a couple of times before giving up.
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 3 && !res; attempt++) {
    res = await fetch(sheetCsvUrl(url)).catch((e) => {
      if (attempt === 3) throw new Error('Could not reach Google Sheets. Check the internet connection and try again.');
      return undefined;
    });
  }
  if (!res!.ok) {
    throw new Error(res!.status === 404
      ? 'That sheet could not be found. Check the link is complete and the sheet has not been deleted.'
      : 'SL QA could not open the sheet. In Google Sheets click Share → General access → "Anyone with the link" → Viewer, then try again.');
  }
  const text = await res!.text();
  if (/^\s*<!DOCTYPE html/i.test(text)) throw new Error('The sheet is private, so SL QA cannot read it. In Google Sheets click Share → General access → "Anyone with the link" → Viewer, then try again.');
  return casesFromCsv(text);
}

export function casesFromCsv(csv: string): TestCase[] {
  const rows: Record<string, string>[] = parse(csv.replace(/^\uFEFF/, ''), { columns: true, skip_empty_lines: true, relax_column_count: true });
  return casesFromRows(rows);
}
