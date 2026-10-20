# SL QA

An in-house QA tool for the slshop.cloud dashboard. It uses no AI.

Add a test sheet: a Google Sheet link, or a CSV/XLSX upload. The tool reads each test case's steps and expected results as plain sentences, runs them in a real browser against the live dashboard, and shows what passed and what failed. Each failure comes with screenshots, the likely cause and a ready-to-paste fix prompt.

## Run it

```sh
npm install
npx playwright install chromium
cp .env.example .env      # fill in LOGIN_PHONE / LOGIN_PASSWORD (the dashboard account the tests use)
npm start                 # → http://localhost:4100
```

To protect the app with a password, set `APP_PASSWORD` in `.env`. The browser will then ask for it; any username works.

## Using it

1. **Add a suite.** Paste a Google Sheet link (shared as "anyone with the link can view") or upload a `.csv` or `.xlsx` file. Choose the dashboard page the tests start on, for example `/dashboard/products`.
2. **Check how the bot reads it.** On the suite page, every test case shows how many of its sentences the bot understood. Open **How the bot reads it** to see each sentence marked ✓ (understood) or ? (not understood). Reword the ? sentences in the sheet, then click **Re-read sheet**.
3. **Run.** Tick the cases, or pick one scenario, and click **Run selected**. The run page updates live. Only one run happens at a time, because tests change shared store data.
4. **Read the results.** You get a verdict per case, the issues found with their likely causes, screenshots, the steps the bot took, failed API requests, console errors, a copyable fix prompt, and **Download report (.md)**. If the suite has run before, the page also shows what changed since that run.

A step-by-step guide for non-technical users is built into the app at **/help** (**How to use** in the top menu). It ends with a worked example: one click creates a 4-case suite (`src/web/example.ts`; three pass, one fails on purpose), and the guide walks through running it, reading the finding, fixing the case and writing your own.

### Adding and deleting issues by hand

- **No sheet:** on the home page, tick *Start with an empty list…* to create a suite you fill in by hand.
- **＋ Add issue** (on any suite) asks for a title, a page link and the expected result. What actually happens, steps, priority and an ID are optional. **Add and check it now** runs it straight away.
- **Edit** / **Delete** on each row, **Delete ticked**, and **Delete all issues** on the suite page. **Delete run** on a run page removes its report and screenshots.
- On a Google Sheet suite, rows deleted here stay hidden when the sheet is re-read, and rows edited here keep your version.

### Sheet format

| Column | Required | Notes |
|---|---|---|
| TC ID | yes | e.g. `PL-001`. Rows starting with "Scenario N:" are treated as section headers. |
| Test Case | yes | The title. |
| Test Steps | yes | One step per line (`1. …`). A line can contain several actions: "Open Filter, set Stock = 'Low stock', click Done". |
| Expected Result | yes | One claim per line (`• …`). |
| URL (or Page / Link) | no | Page the row is tested on. Without it, the first slshop.cloud link or `/dashboard/…` path in the row is used, else the suite's start page. |
| Test Scenario, Type, Priority, Preconditions, Test Data | no | Test Data values in quotes (`'tuna' / 'ইলিশ'`) are used by the "type …" steps, in order. |

Free-form bug sheets work too: only an **Expected Result** (or a URL) column is required. `ID`, `Title`/`Summary`/`Issue` and `Steps`/`Steps to Reproduce` are also accepted. Rows without an ID get `ROW-<n>`.

### What happens per row

1. **Page inspection.** The bot opens the row's page in a logged-in browser and records the HTTP status, load time, console errors and warnings, every failed or slow (>3 s) request, broken images, error text such as "Something went wrong" or "NaN", and a screenshot.
2. **Steps.** Each step it understands is carried out. A step it doesn't understand is skipped and noted, and the row continues.
3. **Expected vs actual.** Each expected claim is checked by a rule. If no rule matches, the bot checks what plain page evidence can settle: quoted text or buttons that should (or shouldn't) be on the page, "loads without errors", "redirects to login", and "no NaN/undefined". If nothing can be compared, the page's own health becomes the verdict.

The report, `runs/<id>/report.md` (the latest is also copied to `./report.md`), starts with **Findings**: per failed row, what was expected, what the page did, where it shows up (failed request, console error) and a screenshot. In the web app, open a run and click **View report**.

### Verdicts

| Verdict | Meaning |
|---|---|
| Pass | Every expectation was checked and met. |
| Fail | At least one expectation was not met, or a control named in a step is missing from the page. These are the findings. |
| Partial | Everything checked passed, but some expectations could not be checked (the reason is shown). |
| Blocked | The case needs something that doesn't exist (a staff account, an empty store), or a step was not understood. |
| Error | The bot itself broke. This is a bot problem, not a finding about the app. |

### Test data

Cases that change data create their own products, named `BTB <case id> …`, and remove them afterwards. The app has no permanent delete, so these end up in the **Archived** tab. When a case needs a real product with past orders, the bot borrows one and restores and re-activates it at the end.

## How it works

```
src/engine/
  sources/      Google Sheet / CSV / XLSX → test cases
  phrases/
    split.ts    sentence → separate actions / claims
    steps.ts    step rules: wording → browser action
    expects.ts  expectation rules: wording → checks (reads page snapshots taken after every step)
    fallback.ts checks for claims no rule matches (quoted text on the page, no errors, login redirect)
    fixtures.ts Test Data / preconditions → test products to create
    index.ts    runs a case: data → steps → checks
  inspect.ts    plain visit of a row's page: console, network, visible errors
  ui.ts         driver for slshop dashboard list pages (cards, tabs, filter, table, pager, dialogs)
  session.ts    logs in once, reuses the session
  report.ts     Markdown report
src/web/        the web app (server, pages, run queue, file storage in data/)
src/cli.ts      same engine from the terminal
```

When a sentence isn't understood, the bot says so and doesn't guess. To support new wording, add a rule to `steps.ts` or `expects.ts`. Each rule is a regular expression plus a small function.

Command line (optional):

```sh
npm run cli -- "<sheet link or file>" --preview          # how each sentence is read
npm run cli -- "<sheet link or file>" PL-001 PL-021      # run cases, write runs/<time>/report.md and ./report.md
npm run cli -- --url /dashboard/orders --expect "'Orders' should be shown"   # check one page without a sheet
```
