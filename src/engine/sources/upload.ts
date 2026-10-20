import ExcelJS from 'exceljs';
import { casesFromCsv } from './google-sheet.js';
import { casesFromRows, type TestCase } from './cases.js';

/** Test cases from an uploaded .csv or .xlsx file (first worksheet). */
export async function casesFromUpload(fileName: string, data: Buffer): Promise<TestCase[]> {
  if (/\.csv$/i.test(fileName)) return casesFromCsv(data.toString('utf8'));
  if (!/\.xlsx$/i.test(fileName)) throw new Error('Upload a .csv or .xlsx file.');

  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data as unknown as ArrayBuffer);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error('The workbook has no sheets.');
  const text = (v: ExcelJS.CellValue): string => {
    if (v == null) return '';
    if (typeof v === 'object' && 'richText' in v) return v.richText.map((r) => r.text).join('');
    if (typeof v === 'object' && 'text' in v) return String(v.text);
    if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
    return String(v);
  };
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (c, i) => (headers[i] = text(c.value).trim()));
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => h && (rec[h] = text(row.getCell(i).value)));
    rows.push(rec);
  });
  return casesFromRows(rows);
}
