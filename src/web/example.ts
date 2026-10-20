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

/** A bug as testers write it in Jira, for the "paste a bug report" part of the guide. Read-only: no order is placed. */
export const EXAMPLE_JIRA = `Create Order/POS: Product titles are clipped on sales cards and the right-hand panel wastes space
Pre-condition: User should Create store or Sign-in to ShopLagbe
Steps to reproduce:
1. Go to https://slshop.cloud/dashboard
2. Navigate to Create order/ POS page
3. View the product inventory grid on the left-hand side
4. Observe items with long names
5. Observe the right-hand "Start a new sale" cart panel when no items are active
Actual result: Product titles are clipped on sales cards and the right-hand panel creates excessive empty screen space. Please see [^ShopLagbe_bug 2.png]
Expected result: Product titles should dynamically wrap up to 2 lines so the full item name is readable or the layout should either allow the right-hand panel to be collapsible or utilize a responsive grid that expands the inventory catalog to full width until an item is added to the cart.`;

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
