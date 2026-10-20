# bug-triage-bot

A QA runner that uses no AI. It reads test cases from a Google Sheet, runs each one against the live app in a real browser (Playwright), and writes a Markdown report. For each case the report gives a verdict, what was actually seen, screenshots, a likely cause, and a ready-to-paste fix prompt.

## Setup

```sh
npm install
npx playwright install chromium
cp .env.example .env   # fill in the sheet id/gid and login
```

The sheet must be shared as "anyone with the link can view". The bot reads it through the CSV export URL.

## Run

```sh
npx tsx src/cli.ts                      # all test cases
npx tsx src/cli.ts PL-021 PL-030        # selected IDs
npx tsx src/cli.ts --scenario search    # cases whose scenario contains "search"
npx tsx src/cli.ts --headed PL-007      # watch the browser
npx tsx src/cli.ts --list               # which IDs have a script
```

Output goes to `runs/<timestamp>/report.md`, with screenshots in `shots/` and exported files in `downloads/`.

## How it works

- `src/sheet.ts` downloads the sheet and turns each row into steps and expected results. "Scenario N:" header rows are skipped.
- `src/session.ts` logs in once by phone and password, saves the session to `.auth/`, and reuses it until the token expires.
- `src/productsPage.ts` handles every interaction with Dashboard > Products (cards, tabs, filters, rows, bulk bar, dialogs).
- `src/cases/*.ts` contains one script per test case ID. Each script turns the sheet's expected results into `t.check(...)` calls, and each check carries a hand-written likely cause.
- `src/runner.ts` runs a case and collects evidence: console errors, failed API requests and screenshots.
- `src/report.ts` writes the Markdown report.

### Test data

Cases that change data (delete, duplicate, stock, status, bulk actions) create their own products named `BTB <case id> …` through the app's API, and remove them afterwards. The app has no permanent delete, so removed products end up in the **Archived** tab. When a case needs a real product with past orders (PL-026, PL-031), the bot restores and re-activates that product when the case finishes.

### Verdicts

| Verdict | Meaning |
|---|---|
| Pass | Every expectation was checked and met |
| Fail | At least one expectation was not met. These are the findings |
| Partial | Everything that could be checked passed, and some parts were skipped (the reason is given) |
| Blocked | The setup the case needs doesn't exist (e.g. a staff account without permission) |
| Error | The bot itself broke. This is a bot problem, not a finding about the app |

## Adding test cases

Add a row to the sheet, then add a script under the same ID in `src/cases/` and register it in `src/cases/index.ts`. A row without a script shows up in the report as **Not automated**.
