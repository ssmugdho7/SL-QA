# SL QA: A Plain-English Overview

*For managers, QA testers and anyone who wants to know what the bot does, without the technical detail.*

---

## What is SL QA?

SL QA is a testing assistant for the slshop.cloud merchant dashboard. You give it a list of test cases or bug reports written in everyday English. It opens the dashboard, does what each case says, checks whether the result matches what you expected, and writes up a report.

**The problem it solves:** checking the same screens by hand after every change is slow and repetitive. SL QA does that repeat work, so testers can spend their time on new and tricky problems.

---

## What you give it, and what you get back

| You give it | You get back |
|---|---|
| A Google Sheet of test cases (shared as "anyone with the link") | A result for every case: Pass, Fail, Review, Partial, Blocked or Error |
| Or an uploaded spreadsheet (CSV or Excel) | A written report with what was expected and what actually happened |
| Or a test case typed into the web page | Screenshots of the screens it checked |
| Or a Jira bug copied and pasted in as text | A ready-to-paste "fix prompt" for developers on every case with a failed check |

---

## How it works, step by step

Think of SL QA as **a careful junior tester following your checklist**. It does exactly what is written, writes down what it sees, and flags anything it is unsure of.

1. **Read the checklist.** It reads each test case: the page to open, the steps, and the expected result.
2. **Work out each sentence.** It matches every sentence against a built-in list of phrases it knows, such as "click 'Save'" or "the total should show".
3. **Get the test data ready.** Where a case needs one, it creates a throwaway test product named with the letters **BTB**, so real products are left alone. (One exception: a few cases need a product that has past orders. For those it borrows a real one and puts it back afterwards.)
4. **Open the dashboard and do the steps.** It uses a real web browser, logged in as the store owner, and clicks and types just as a person would. (This is called *browser automation*: a program driving a web browser for you.)
5. **Check the result.** It compares what is on the screen, and sometimes the store's own data, with what you said should happen.
6. **Tidy up.** It removes or archives the BTB test items it created.
7. **Write the report.** Each case gets a result, notes and screenshots.

---

## Where AI fits in, and what it never does

Most of the work is done by **fixed rules** that SL QA has been taught. AI (services similar to ChatGPT) is only a helper:

- **When the rules don't recognise a sentence**, the AI suggests how to carry it out in the bot's simple step language.
- **When a step fails** (for example, a button can't be found), the AI gets one try at suggesting a fix.
- **Ahead of time**, the AI can suggest rewrites of sentences the bot doesn't understand. A person approves or rejects each one before it is used again.

Free AI services are tried first. Paid ones are only a backup and have a daily limit.

**What AI never does: it never decides whether a test passed or failed.** The result always comes from fixed rules. The AI may *write* a check (in the step language), but the bot's own rules carry it out. If a check written by the AI fails, the case is marked **Review** for a person to look at, not Fail. Be aware that a check written by the AI that *passes* counts as a normal pass, and the result page doesn't mark it differently. So it's worth reading the AI's notes on passed cases too.

---

## What the results mean

| Result | What it means |
|---|---|
| **Pass** | Everything that could be checked matched what was expected. |
| **Fail** | At least one thing did not match. This may be a real bug, so look at the report. |
| **Review** | A check written by the AI failed, and no ordinary check failed. A person should look before calling it a bug. |
| **Partial** | Some checks passed, but some sentences could not be checked. |
| **Blocked** | Nothing could actually be checked. For example, a step needed something the bot can't do. |
| **Error** | Something went wrong in the bot itself, or the case took too long (over 10 minutes by default). |

---

## How good is it today? An honest picture

We wrote 49 sample test issues by hand, covering 30 areas of the dashboard, and checked how many of their sentences SL QA's rules understand without any AI. This test reads the sentences only. It does not open the store. **How you write the issue matters most.**

| How the issue is written | How much the bot understands |
|---|---|
| Button and text names in single quotes, e.g. Click 'Save Product' | Almost everything (about 97%) |
| A normal, formal test case | Less than half (about 44%) |
| A pasted Jira bug | About 39% |
| A quick, informal one-liner | About 29% |

Overall it understood about half of all sentences without AI, and only 7 of the 49 issues were understood completely. AI can fill in a lot of the gaps, but so far cases that needed AI help have rarely passed (only a handful in the stored runs). We can't yet tell how many of those failures were real bugs and how many were the bot misreading the step.

**Good at today:**
- The **products list** (tabs, search, filters, sorting, pages, bulk actions, export)
- The **Add Product form**, and editing a product when the case is worded the way its built-in phrases expect

**Partly works:** **POS** (point of sale) discount, total and receipt checks (they work when written the way the bot's phrases expect, but only about half of the sample POS sentences were understood), orders, customers, customer dues, cashbook, inventory, the dashboard home page and shipping labels. Opening these pages works, but actions on a single row, filters, and "before and after" comparisons usually don't.

**Mostly depends on AI:** coupons, categories, brands, staff, delivery and courier, theme, fraud, barcodes, payments, settings, blog and reports. The bot now knows all of these pages by name (for example "Products › Categories" or "Settings > Tax"), but what to do on them is still mostly worked out by the AI or written in the step language.

**It can check every page of the dashboard.** One button, **🔎 Check the whole dashboard** on the Suites page, makes a list of about 140 checks, one for each page in the menu (reports, settings and sub-pages included). The bot finds the pages itself by walking the dashboard's menus, which takes about five minutes and is repeated every week or when you ask. For each page it checks that the page opens without errors, shows no broken values such as "NaN" and shows its title, and then gently tries the page's tabs, filter panel, search box and next page. It only looks and clicks harmless things: it never creates, saves or deletes anything. You don't have to write these cases; you tick the pages you want and press Run, as with any other list.

**Can't do yet:**
- The customer-facing storefront or checkout (the only exception: after saving a product, it can open that product's own storefront page)
- Logging in as a second account or a staff role
- Print previews, new tabs, or checking what is inside a downloaded file, beyond a few built-in checks (for example, the products export and barcode print preview)
- Charts, and anything happening in other services (such as courier or payment providers)
- "Before and after" sums tied to an action on another page, such as "Today's Sales should increase by 500 after the order is placed". A simple "Balance should increase by 1000" is understood.
- Phone-sized screens, barcode scanners and printers

**Known weak spots to be aware of:**
- Some ordinary wordings are misread. For example, "Click Place Order" with a capital C is not recognised, but "click Place Order" is.
- If you ask it to open a page it doesn't know, it can quietly stay on the starting page and carry on. (It now knows every page in the dashboard menu, so this mostly happens with misspelt names.)
- Text in "double quotes" is not picked up in most sentences (clicks and expected results). Use 'single quotes'.

---

## Safety

SL QA works on the **real, live store**, so it is built to be careful, but it is not risk-free.

- **Test items are named BTB.** Test products and categories it creates start with "BTB" so they are easy to spot.
- **Cleanup after every case.** BTB products are archived (the store has no permanent delete, so they pile up in the Archived tab). Test categories, brands and labels are deleted. A borrowed real product is restored and made active again.
- **Real orders can be placed.** POS tests place real orders using one fixed test customer. Orders, customers and coupons created during a test are **not** cleaned up automatically.
- **AI is told to touch only test items**, but that is an instruction to the AI and nothing in the code enforces it.
- **The web page has no password unless one is set.** Anyone who can open it could start runs, including ones that place real orders, so make sure a password is turned on.
- **Privacy:** when AI helps, the case text and some on-screen details (such as customer names or totals) are sent to outside AI services, including free ones.

---

## How to use it day to day

1. **Add your test cases:** link a Google Sheet, upload a spreadsheet, type a case in, or paste a Jira bug and check the fields it fills in.
2. **Write steps clearly:** put button and on-screen text in 'single quotes', give the page link where you can, and keep one action per step.
3. **Open the rewrites page** for your suite. It lists the sentences the bot didn't understand and the AI's suggested rewrites. Approve only the ones that make sense for that page, and avoid "Approve all".
4. **Run** the cases you have ticked. Runs happen one at a time.
5. **Read the report:** start with Fail and Review, look at the screenshots, and send the "fix prompt" to developers for real bugs.
6. **Re-run after a fix** to confirm. The run page compares each case with its last result.

---

## Does it use Python or scraping?

**No Python at all.** It is built in TypeScript, a common language for web apps. **It is not a scraper** either: it doesn't collect content from websites. It drives a real web browser through the dashboard like a tester would, and only reads the screen to check results.

---

## What's next?

For the full technical picture, see [How SL QA works (technical)](how-it-works-technical.md). The [improvements and integrations plan](improvements-and-integrations.md) lists the quick fixes, medium projects and bigger upgrades proposed to help SL QA understand more pages and more writing styles, and to make it safer.
