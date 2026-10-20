import type { TestCase } from '../engine/sources/cases.js';

/**
 * The worked example on the help page. The same cases back the "Create the example suite" button and the sample sheet,
 * so what the guide describes is exactly what people run. They only open pages and read them; nothing in the store changes.
 * EX-4 fails on purpose (the button is really called 'Export page'), to show what a finding looks like and how to fix it.
 */
export const EXAMPLE_SUITE_NAME = 'Example: try SL QA';

const base = { scenario: 'Example', type: 'Example', preconditions: '', testData: '', automation: '', manual: true };

export const EXAMPLE_CASES: TestCase[] = [
  {
    ...base,
    id: 'EX-1',
    title: 'Orders page opens without errors',
    priority: 'High',
    url: '/dashboard/orders',
    steps: ['Open the orders page'],
    expected: ["The page title 'Orders' should be shown.", 'The page should load without errors.'],
  },
  {
    ...base,
    id: 'EX-2',
    title: 'Products page shows its main buttons',
    priority: 'High',
    url: '/dashboard/products',
    steps: ['Open the products page'],
    expected: ["The buttons 'Add Product' and 'Bulk Create' should be visible."],
  },
  {
    ...base,
    id: 'EX-3',
    title: 'Filter opens a panel with a Done button',
    priority: 'Medium',
    url: '/dashboard/products',
    steps: ['Open the products page', "Click 'Filter'"],
    expected: ["The 'Done' button should be visible."],
  },
  {
    ...base,
    id: 'EX-4',
    title: 'Customers page has a CSV export button',
    priority: 'Low',
    url: '/dashboard/customers',
    steps: ['Open the customers page'],
    expected: ["An 'Export Customers CSV' button should be visible."],
    reported: 'I could not find a button to export customers as CSV.',
  },
];

/** The example as a sheet, in the column layout the help page describes. */
export function exampleCsv(): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = EXAMPLE_CASES.map((c) => [
    c.id,
    c.url,
    c.title,
    c.priority,
    c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    c.expected.map((e) => `• ${e}`).join('\n'),
    c.reported ?? '',
  ]);
  return [['ID', 'URL', 'Title', 'Priority', 'Steps', 'Expected Result', 'Actual Result'], ...rows].map((r) => r.map(cell).join(',')).join('\n');
}
