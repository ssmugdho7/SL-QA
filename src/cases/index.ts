import type { CaseScript } from '../runner.js';
import { pageLoadCases } from './pageLoad.js';
import { summaryCases } from './summary.js';
import { tabsSearchCases } from './tabsSearch.js';
import { sortFilterViewCases } from './sortFilterView.js';
import { cardsActionsCases } from './cardsActions.js';
import { bulkCases } from './bulk.js';

/** Test case ID (from the sheet) → script that runs it. */
export const caseScripts: Record<string, CaseScript> = {
  ...pageLoadCases,
  ...summaryCases,
  ...tabsSearchCases,
  ...sortFilterViewCases,
  ...cardsActionsCases,
  ...bulkCases,
};
