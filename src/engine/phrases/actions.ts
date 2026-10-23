import type { Locator } from 'playwright';
import type { CaseContext } from '../context.js';
import { pagePath } from '../pages.js';
import { escapeRe, Missing } from '../ui.js';
import type { ExpectRule } from './expects.js';
import type { StepRule } from './steps.js';

/**
 * Basic actions that work on any page, written in a fixed, exact form:
 *
 *   GO TO '/dashboard/orders'         CLICK 'Save Product'           TYPE '100' INTO 'Selling Price' [IN 'Pricing']
 *   SELECT 'kg' IN 'Unit'             TURN ON 'Track inventory'      PRESS 'Enter'
 *   WAIT 2                            CHECK 'Select all'             RELOAD · GO BACK · HOVER 'x' · SCROLL TO 'x'
 *   WAIT FOR TEXT 'Saved' 10          WAIT FOR URL '/orders'
 *   REMEMBER VALUE 'On Hand' AS stock REMEMBER COUNT AS n
 *
 *   EXPECT TEXT 'Product created' [IN 'dialog/row/section']      EXPECT NO TEXT 'Error'    EXPECT URL '/dashboard/orders'
 *   EXPECT BUTTON 'Save' ENABLED      EXPECT FIELD 'Selling Price' = '100'   EXPECT COUNT 'Showing 1–1 of 1'
 *   EXPECT VALUE 'On Hand' = stock + 5 · EXPECT VALUE 'Total' CHANGED      EXPECT COUNT = n - 1
 *   EXPECT ROW 'BTB X-1'              EXPECT NO ROW 'BTB X-1'
 *
 * Names are in 'single' or "double" quotes. The AI translator writes steps in this form, and people can too. Every
 * target is found by what a person sees: button and link text, field labels, placeholders, then any visible text.
 */

// One quoted value in 'single', "double" or curly quotes; the closing quote matches the opening one (one capture group).
const q = `['"‘“]((?<=')(?:[^']|'(?=[A-Za-z]))*(?=')|(?<=")[^"]*(?=")|(?<=‘)[^’]*(?=’)|(?<=“)[^”]*(?=”))['"’”]`;
const re = (s: string) => new RegExp(`^${s}$`, 'i');
/** A remembered name (REMEMBER … AS name) or a plain number, optionally ± a number: "stock + 5", "n", "12". */
const ref = `([A-Za-z_]\\w*|-?\\d+(?:\\.\\d+)?)(?:\\s*([+-])\\s*(\\d+(?:\\.\\d+)?))?`;
const OPS = `(=|>=|<=|>|<|!=)`;

function exactOrStarts(name: string): RegExp {
  return new RegExp(`^\\s*${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu');
}

/** The most likely element a person means by `name`: dialog first, then buttons, links, tabs, options, labels, text. */
async function target(t: CaseContext, name: string): Promise<Locator> {
  const page = t.page;
  const exact = new RegExp(`^\\s*${escapeRe(name)}\\s*$`, 'i');
  // Open dialog first, then the page's own content, then anywhere (the sidebar menu repeats many names: Stock, Orders…).
  const main = page.locator('main, body:not(:has(main))').first();
  const scopes = (await t.ui.dialog().count()) ? [t.ui.dialog(), main, page.locator('body')] : [main, page.locator('body')];
  const dialogOpen = (await t.ui.dialog().count()) > 0;
  for (const [si, scope] of scopes.entries()) {
    // With a dialog open, things on the page behind it cannot be clicked; only look there if nothing else matches.
    if (dialogOpen && si > 0 && si < scopes.length - 1) continue;
    for (const re of [exact, exactOrStarts(name)]) {
      for (const role of ['tab', 'button', 'link', 'menuitem', 'menuitemradio', 'option', 'checkbox', 'switch', 'radio'] as const) {
        const hit = scope.getByRole(role, { name: re }).filter({ visible: true }).first();
        if (await hit.count()) return hit;
      }
    }
    const byLabel = scope.getByLabel(exact).filter({ visible: true }).first();
    if (await byLabel.count()) return byLabel;
    const byText = scope.getByText(name, { exact: true }).filter({ visible: true }).first();
    if (await byText.count()) return byText;
  }
  const seen = await page.getByRole('button').filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  throw new Missing(`'${name}'`, [...new Set(seen.map((s) => s.trim()).filter(Boolean))]);
}

/** A text box by its label, placeholder or the <label> just before it (inside `scope` when given). */
async function field(t: CaseContext, name: string, scope?: Locator, expand = true): Promise<Locator> {
  const page = t.page;
  const root = scope ?? page;
  const exact = new RegExp(`^\\s*${escapeRe(name)}\\s*\\*?\\s*$`, 'i');
  const tries: Locator[] = [
    root.getByLabel(exact),
    root.getByPlaceholder(new RegExp(escapeRe(name), 'i')),
    root.getByRole('textbox', { name: new RegExp(escapeRe(name), 'i') }),
    root.getByRole('spinbutton', { name: new RegExp(escapeRe(name), 'i') }),
    root.getByRole('searchbox', { name: new RegExp(escapeRe(name), 'i') }),
    root.locator(`xpath=${scope ? '.' : ''}//label[translate(normalize-space(translate(., '*', '')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')=${JSON.stringify(name.toLowerCase())}]/following::*[self::input[not(@type='hidden') and not(@type='checkbox') and not(@type='file')] or self::textarea or @contenteditable='true'][1]`),
  ];
  for (const loc of tries) {
    const hit = loc.filter({ visible: true }).first();
    if (await hit.count()) return hit;
  }
  // A collapsed section may hide it: open closed section headers once and try again.
  const closed = (scope ?? page.locator('main')).locator('button[aria-expanded=false]');
  if (expand && (await closed.count())) {
    for (let i = 0; i < Math.min(await closed.count(), 6); i++) await closed.nth(0).click().catch(() => undefined);
    for (const loc of tries) {
      const hit = loc.filter({ visible: true }).first();
      if (await hit.count()) return hit;
    }
  }
  const labels = await root.locator('label').filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  throw new Missing(`a '${name}' field${scope ? ' there' : ''}`, labels.map((s) => s.trim()).filter(Boolean));
}

/**
 * Places a person means by "IN '<x>'", most specific first: the open dialog ('dialog', 'popup'), a dialog titled x,
 * a list row / card containing x (a record's own buttons), then a section or form containing x.
 */
async function scopeBoxes(t: CaseContext, name: string): Promise<Locator[]> {
  const kinds = /^(?:the )?(?:dialog|popup|pop-up|modal|drawer)$/i.test(name.trim())
    ? [t.ui.dialog()]
    : [
      t.page.getByRole('dialog', { name: new RegExp(escapeRe(name), 'i') }),
      t.page.locator('[role=dialog],[role=alertdialog]').filter({ hasText: name }),
      t.page.locator('tbody tr, article, li, [role=row]').filter({ hasText: name }),
      t.page.locator('section, form, aside, fieldset, [role=region], [role=tabpanel]').filter({ hasText: name }),
    ];
  const out: Locator[] = [];
  for (const k of kinds) {
    const box = k.filter({ visible: true }).first();
    if (await box.count()) out.push(box);
  }
  return out;
}

async function bodyText(t: CaseContext): Promise<string> {
  return (await t.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

/**
 * The value a person reads next to `label`: the next text in the same small group (a card, a definition row), or,
 * when the label is a table header, that column in the first body row. Null when no such label is visible.
 */
export async function readValue(t: CaseContext, label: string): Promise<string | null> {
  return t.page.evaluate((label) => {
    const v = (e: Element) => e.getClientRects().length > 0;
    const want = label.toLowerCase().replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('main *, [role=dialog] *')].filter((e) => v(e) && e.children.length === 0 && (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().toLowerCase() === want);
    for (const el of els) {
      // The value is the next text in the same small group (a card, a definition row, a table cell below the header).
      let box: HTMLElement | null = el.parentElement;
      for (let i = 0; i < 3 && box; i++) {
        const parts = box.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
        const at = parts.findIndex((x) => x.toLowerCase() === want);
        if (at >= 0 && parts[at + 1]) return parts[at + 1];
        box = box.parentElement;
      }
      const th = el.closest('th');
      if (th) {
        const col = [...(th.parentElement?.children ?? [])].indexOf(th);
        const cell = th.closest('table')?.querySelector('tbody tr')?.children[col] as HTMLElement | undefined;
        if (cell) return cell.innerText.trim();
      }
    }
    return null;
  }, label);
}

/** How many records the list shows: "Showing x–y of z" → z, else "N results", else the visible rows / cards. */
export async function countOf(t: CaseContext): Promise<{ n: number; how: string } | null> {
  const text = await bodyText(t);
  const showing = text.match(/Showing\s*\d+\s*[–-]\s*\d+\s*of\s*(\d[\d,]*)/i);
  if (showing) return { n: Number(showing[1].replace(/,/g, '')), how: showing[0] };
  const results = text.match(/\b(\d[\d,]*)\s+(?:results?|records?|items?|entries|orders|products|customers)\s+(?:found|shown)?/i);
  if (results) return { n: Number(results[1].replace(/,/g, '')), how: results[0].trim() };
  const rows = await t.page.locator('main tbody tr, main article, main [role=row]:not(:has([role=columnheader]))').filter({ visible: true }).count().catch(() => 0);
  if (rows || /nothing found|no [\w ]+ (?:yet|found)/i.test(text)) return { n: rows, how: `${rows} row(s) on the page` };
  return null;
}

/** A number in shown text, tolerant of ৳ / Tk, thousands commas, Bangla digits and units ("৳1,250.50", "13 pcs", "-৳20"). */
export function numberIn(x: string): number | null {
  const s = x.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6)).replace(/(\d),(?=\d{2,3}\b)/g, '$1');
  const m = s.match(/(-)?\s*(?:৳|tk\.?|bdt|\$)?\s*(-)?(\d+(?:\.\d+)?)/i);
  return m ? Number(`${m[1] || m[2] ? '-' : ''}${m[3]}`) : null;
}

export interface Remembered { name: string; label: string; raw: string; num: number | null }

/** Values kept by REMEMBER lines in this case, by lower-case name. */
export function remembered(t: CaseContext): Remembered[] {
  return [...t.noted].filter(([k]) => k.startsWith('var:')).map(([, v]) => v as Remembered);
}

function keep(t: CaseContext, name: string, label: string, raw: string): string {
  const r: Remembered = { name, label, raw, num: numberIn(raw) };
  t.noted.set(`var:${name.toLowerCase()}`, r);
  t.noted.set(`varlabel:${label.toLowerCase()}`, r);
  return `Remembered ${name} = ${raw}.`;
}

/**
 * "stock + 5", "n", "12" → the number it stands for, using remembered values. A string explains what is missing.
 */
function resolveRef(t: CaseContext, base: string, sign?: string, delta?: string): { n: number; text: string } | string {
  let n: number | null;
  let text = base;
  if (/^-?\d/.test(base)) n = Number(base);
  else {
    const r = t.noted.get(`var:${base.toLowerCase()}`) as Remembered | undefined;
    if (!r) return `nothing was remembered as '${base}' (REMEMBER … AS ${base} must run before the steps)`;
    if (r.num === null) return `'${base}' was "${r.raw}", not a number`;
    n = r.num;
    text = `${base} (${r.raw})`;
  }
  if (sign && delta) {
    n = sign === '+' ? n + Number(delta) : n - Number(delta);
    text += ` ${sign} ${delta}`;
  }
  return { n, text };
}

const compare = (a: number, op: string, b: number) => ({ '=': a === b, '!=': a !== b, '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b } as Record<string, boolean>)[op] ?? false;

/** Polls `test` until it holds or `seconds` pass. */
async function poll(t: CaseContext, seconds: number, test: () => Promise<boolean>): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    if (await test().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await t.page.waitForTimeout(400);
  }
}

const ROWS = 'tbody tr, article, [role=row], [role=listitem], [data-slot=card], li';

export const ACTION_RULES: StepRule[] = [
  {
    name: 'go to',
    pattern: re(`go to ${q}`),
    run: async (t, m) => {
      const path = /^https?:|^\//.test(m[1]) ? m[1] : pagePath(m[1]) ?? m[1];
      await t.ui.goto(path);
      return `Opened ${new URL(t.page.url()).pathname}.`;
    },
  },
  {
    name: 'click',
    pattern: re(`(double )?click ${q}(?: (?:in|inside) ${q})?`),
    run: async (t, m) => {
      let el: Locator | null = null;
      if (m[3]) {
        // "IN '<x>'": a dialog or section titled x, or a list row / card that contains x (a product's own buttons).
        for (const box of await scopeBoxes(t, m[3])) {
          const hit = box.getByRole('button', { name: exactOrStarts(m[2]) }).or(box.getByRole('link', { name: exactOrStarts(m[2]) })).or(box.getByRole('tab', { name: exactOrStarts(m[2]) })).or(box.getByLabel(new RegExp(`^\\s*${escapeRe(m[2])}\\s*$`, 'i'))).or(box.getByText(m[2], { exact: true })).filter({ visible: true }).first();
          if (await hit.count()) { el = hit; break; }
        }
      }
      el ??= await target(t, m[2]);
      const go = (force = false) => (m[1] ? el!.dblclick({ timeout: 8_000, force }) : el!.click({ timeout: 8_000, force }));
      // Something may still cover it (a closing dialog, a toast): wait, close stray popups, then try once more.
      await go().catch(async () => {
        await t.page.waitForTimeout(800);
        const dlg = t.ui.dialog();
        if ((await dlg.count()) && !(await dlg.locator(':scope').filter({ has: el! }).count())) await t.page.keyboard.press('Escape');
        await t.page.waitForTimeout(400);
        await go().catch(() => go(true));
      });
      await t.ui.settle();
      return undefined;
    },
  },
  {
    name: 'type into',
    pattern: re(`(?:type|enter|fill) ${q} (?:into|in) ${q}(?: (?:in|inside) ${q})?`),
    run: async (t, m) => {
      let f: Locator | null = null;
      // "IN '<dialog/section>'": the field inside that place (two dialogs or forms can both have a 'Name' field).
      if (m[3]) for (const box of await scopeBoxes(t, m[3])) if ((f = await field(t, m[2], box, false).catch(() => null))) break;
      f ??= await field(t, m[2]);
      // A search box re-fetches the list as you type: wait for the new results, so a following check sees them.
      const search = await f.evaluate((e) => (e as HTMLInputElement).type === 'search' || e.getAttribute('role') === 'searchbox' || /search/i.test(`${(e as HTMLInputElement).placeholder} ${e.getAttribute('aria-label') ?? ''}`)).catch(() => false);
      const before = search ? await t.ui.showingText() : '';
      await f.fill('');
      if (m[1]) await f.pressSequentially(m[1], { delay: 10 });
      await t.page.waitForTimeout(200);
      if (search) {
        await t.page.waitForTimeout(400);
        await t.ui.waitForListChange(before);
      }
      const kept = await f.inputValue().catch(() => m[1]);
      return kept !== m[1] ? `'${m[2]}' shows "${kept}" after typing "${m[1]}".` : undefined;
    },
  },
  {
    name: 'clear',
    pattern: re(`clear ${q}`),
    run: async (t, m) => void (await (await field(t, m[1])).fill('')),
  },
  {
    name: 'select option',
    pattern: re(`(?:select|choose|pick) ${q} (?:in|from) ${q}`),
    run: async (t, m) => {
      const native = t.page.getByLabel(new RegExp(escapeRe(m[2]), 'i')).and(t.page.locator('select')).first();
      if (await native.count()) return void (await native.selectOption({ label: m[1] }));
      // "IN '<dialog title>'": the choice is a button / radio / tab inside that open dialog.
      const dlg = t.page.locator('[role=dialog],[role=alertdialog]').filter({ visible: true }).filter({ hasText: m[2] }).last();
      if (await dlg.count()) {
        const choice = dlg.getByRole('radio', { name: exactOrStarts(m[1]) }).or(dlg.getByRole('button', { name: exactOrStarts(m[1]) })).or(dlg.getByRole('tab', { name: exactOrStarts(m[1]) })).or(dlg.getByText(m[1], { exact: true })).filter({ visible: true }).first();
        if (await choice.count()) {
          await choice.click({ timeout: 8_000 });
          await t.page.waitForTimeout(300);
          return undefined;
        }
      }
      // A choice already on screen (radio, tab, chip, button) needs no dropdown.
      const onScreen = t.page.getByRole('radio', { name: exactOrStarts(m[1]) }).or(t.page.getByRole('tab', { name: exactOrStarts(m[1]) })).filter({ visible: true }).first();
      if (await onScreen.count()) {
        await onScreen.click({ timeout: 8_000 });
        await t.page.waitForTimeout(300);
        return undefined;
      }
      const opener = await target(t, m[2]).catch(async () => field(t, m[2]));
      await opener.click({ timeout: 8_000 }).catch(() => opener.click({ timeout: 8_000, force: true }));
      await t.page.waitForTimeout(400);
      const search = t.page.locator('[cmdk-input], [role=listbox] input, [data-radix-popper-content-wrapper] input').filter({ visible: true }).first();
      if (await search.count()) await search.fill(m[1]);
      const option = t.page.getByRole('option', { name: new RegExp(`^\\s*${escapeRe(m[1])}\\s*$`, 'i') }).or(t.page.getByRole('menuitem', { name: new RegExp(`^\\s*${escapeRe(m[1])}\\s*$`, 'i') })).filter({ visible: true }).first();
      if (!(await option.count())) {
        const seen = (await t.page.getByRole('option').or(t.page.getByRole('menuitem')).filter({ visible: true }).allInnerTexts()).map((x) => x.trim()).filter(Boolean);
        await t.page.keyboard.press('Escape');
        throw new Missing(`option '${m[1]}' in '${m[2]}'`, seen);
      }
      await option.click({ timeout: 8_000 });
      await t.ui.settle();
      return undefined;
    },
  },
  {
    name: 'turn on/off',
    pattern: re(`turn (on|off) ${q}`),
    run: async (t, m) => {
      const sw = t.page.getByRole('switch', { name: new RegExp(escapeRe(m[2]), 'i') }).or(t.page.getByRole('checkbox', { name: new RegExp(escapeRe(m[2]), 'i') })).filter({ visible: true }).first();
      const el = (await sw.count()) ? sw : await target(t, m[2]);
      const state = await el.evaluate((e) => e.getAttribute('aria-checked') ?? e.getAttribute('aria-pressed') ?? String((e as HTMLInputElement).checked));
      if ((state === 'true') !== (m[1].toLowerCase() === 'on')) await el.click();
      await t.page.waitForTimeout(300);
      return undefined;
    },
  },
  {
    name: 'check/uncheck',
    pattern: re(`(check|uncheck|tick|untick) ${q}`),
    run: async (t, m) => {
      const box = t.page.getByRole('checkbox', { name: new RegExp(escapeRe(m[2]), 'i') }).filter({ visible: true }).first();
      const el = (await box.count()) ? box : await target(t, m[2]);
      await el.setChecked(/^(check|tick)$/i.test(m[1]), { force: true });
      return undefined;
    },
  },
  {
    name: 'press key',
    pattern: re(`press ${q}`),
    run: async (t, m) => void (await t.page.keyboard.press(m[1].replace(/^esc$/i, 'Escape'))),
  },
  {
    name: 'wait',
    pattern: re(`wait (\\d+(?:\\.\\d+)?)(?: ?s(?:ec(?:ond)?s?)?)?`),
    run: async (t, m) => void (await t.page.waitForTimeout(Math.min(30, Number(m[1])) * 1000)),
  },
  {
    name: 'upload file',
    pattern: re(`upload ${q} (?:to|into|in) ${q}`),
    run: async (t, m) => {
      const { makeFile } = await import('../fixtures/images.js');
      const file = await makeFile(t.page, `${t.runDir}/uploads`, m[1], Date.now() % 1000);
      const input = t.page.locator('input[type=file]').filter({ has: t.page.locator(':scope') });
      const near = t.page.locator(`xpath=//*[normalize-space(.)=${JSON.stringify(m[2])}]/following::input[@type='file'][1]`).first();
      await ((await near.count()) ? near : input.first()).setInputFiles(file.path);
      await t.page.waitForTimeout(1200);
      return `Uploaded ${file.kind}.`;
    },
  },
  {
    name: 'wait for text',
    pattern: re(`wait for (no )?text ${q}(?: (\\d+)(?: ?s(?:ec(?:ond)?s?)?)?)?`),
    run: async (t, m) => {
      const secs = Math.min(60, Number(m[3] ?? 10));
      const want = m[2].toLowerCase();
      const ok = await poll(t, secs, async () => ((await bodyText(t)).toLowerCase().includes(want) || t.toasts.some((x) => x.toLowerCase().includes(want))) === !m[1]);
      // Not a check: a later EXPECT decides. Say what happened so the report explains a following failure.
      return ok ? undefined : `'${m[2]}' ${m[1] ? 'was still shown' : 'did not appear'} within ${secs}s.`;
    },
  },
  {
    name: 'wait for url',
    pattern: re(`wait for url ${q}(?: (\\d+)(?: ?s(?:ec(?:ond)?s?)?)?)?`),
    run: async (t, m) => {
      const secs = Math.min(60, Number(m[2] ?? 10));
      const ok = await poll(t, secs, async () => { const u = new URL(t.page.url()); return `${u.pathname}${u.search}`.includes(m[1]); });
      if (ok) await t.ui.settle();
      return ok ? undefined : `The page stayed at ${new URL(t.page.url()).pathname} for ${secs}s.`;
    },
  },
  {
    name: 'reload',
    pattern: re(`(?:reload|refresh)(?: the page)?`),
    run: async (t) => {
      await t.page.reload({ waitUntil: 'load', timeout: 45_000 }).catch(() => undefined);
      await t.ui.waitForList(5_000).catch(() => undefined);
      await t.ui.settle();
      return undefined;
    },
  },
  {
    name: 'go back',
    pattern: re(`go back`),
    run: async (t) => {
      await t.page.goBack({ waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
      await t.ui.settle();
      return `Back at ${new URL(t.page.url()).pathname}.`;
    },
  },
  {
    name: 'hover',
    pattern: re(`hover(?: over)? ${q}(?: (?:in|inside) ${q})?`),
    run: async (t, m) => {
      let el: Locator | null = null;
      if (m[2]) for (const box of await scopeBoxes(t, m[2])) {
        const hit = box.getByText(m[1], { exact: true }).or(box.getByRole('button', { name: exactOrStarts(m[1]) })).or(box.getByLabel(new RegExp(`^\\s*${escapeRe(m[1])}\\s*$`, 'i'))).filter({ visible: true }).first();
        if (await hit.count()) { el = hit; break; }
      }
      el ??= await target(t, m[1]);
      await el.hover({ timeout: 8_000 });
      await t.page.waitForTimeout(500);
      return undefined;
    },
  },
  {
    name: 'scroll to',
    pattern: re(`scroll to ${q}`),
    run: async (t, m) => {
      if (/^(?:bottom|end)$/i.test(m[1])) return void (await t.page.mouse.wheel(0, 20_000));
      if (/^(?:top|start)$/i.test(m[1])) return void (await t.page.evaluate(() => window.scrollTo(0, 0)));
      const el = await target(t, m[1]).catch(() => null) ?? t.page.getByText(m[1]).filter({ visible: true }).first();
      if (!(await el.count())) throw new Missing(`'${m[1]}' to scroll to`);
      await el.scrollIntoViewIfNeeded({ timeout: 8_000 });
      return undefined;
    },
  },
  {
    name: 'remember value',
    // "REMEMBER VALUE 'On Hand' AS stock": keeps the shown value for a later EXPECT VALUE … = stock + 5.
    pattern: re(`remember (?:value )?${q} as ([A-Za-z_]\\w*)`),
    run: async (t, m) => {
      const raw = await readValue(t, m[1]);
      if (raw === null) throw new Missing(`a value labelled '${m[1]}'`, await shownLabels(t));
      return keep(t, m[2], m[1], raw);
    },
  },
  {
    name: 'remember count',
    pattern: re(`remember count as ([A-Za-z_]\\w*)`),
    run: async (t, m) => {
      const c = await countOf(t);
      if (!c) throw new Missing('a list count ("Showing x–y of z" or rows) to remember');
      return keep(t, m[1], '__count', String(c.n)) + ` (${c.how})`;
    },
  },
];

/** Short texts on screen that look like labels, for a "could not find" message. */
async function shownLabels(t: CaseContext): Promise<string[]> {
  return t.page.evaluate(() => [...new Set([...document.querySelectorAll('main *')].filter((e) => e.children.length === 0 && e.getClientRects().length > 0)
    .map((e) => (e as HTMLElement).innerText?.trim() ?? '').filter((x) => x && x.length < 30 && !/\d{2,}/.test(x)))].slice(0, 30)).catch(() => []);
}

/** Exact checks in the same fixed form. */
export const ACTION_EXPECTS: ExpectRule[] = [
  {
    name: 'expect text',
    pattern: re(`expect (no )?text ${q}(?: (?:in|inside) ${q})?`),
    check: async (t, m) => {
      if (m[3]) {
        // "IN '<row/dialog/section>'": the text inside that place only (a row's status, a dialog's message).
        const boxes = await scopeBoxes(t, m[3]);
        if (!boxes.length) return void t.check(`'${m[2]}' ${m[1] ? 'is not shown' : 'is shown'} in '${m[3]}'`, false, `no dialog, row or section with '${m[3]}' on the page`);
        const texts = await Promise.all(boxes.map(async (b) => (await b.innerText().catch(() => '')).replace(/\s+/g, ' ')));
        const found = texts.some((x) => x.toLowerCase().includes(m[2].toLowerCase()));
        const shown = texts[0].slice(0, 160);
        if (m[1]) t.check(`'${m[2]}' is not shown in '${m[3]}'`, !found, found ? 'it is there' : `not there; it shows: ${shown}`);
        else t.check(`'${m[2]}' is shown in '${m[3]}'`, found, found ? 'shown' : `it shows: ${shown}`);
        return;
      }
      const text = await bodyText(t);
      const toasts = t.toasts.join(' | ');
      const found = text.toLowerCase().includes(m[2].toLowerCase()) || toasts.toLowerCase().includes(m[2].toLowerCase());
      if (m[1]) t.check(`'${m[2]}' is not shown`, !found, found ? 'it is on the page' : 'not on the page');
      else t.check(`'${m[2]}' is shown`, found, found ? 'shown' : `not on the page${toasts ? `; messages seen: ${toasts.slice(0, 160)}` : ''}`);
    },
  },
  {
    name: 'expect row',
    // "EXPECT ROW 'BTB X-1'": a list row or card containing that text is on the page (or, with NO, is not).
    pattern: re(`expect (no )?(?:row|record|card) ${q}`),
    check: async (t, m) => {
      const rows = t.page.locator(ROWS).filter({ hasText: m[2] }).filter({ visible: true });
      const n = await rows.count().catch(() => 0);
      const first = n ? (await rows.first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 140) : '';
      if (m[1]) t.check(`No row with '${m[2]}'`, n === 0, n ? `a row shows: ${first}` : 'no such row');
      else t.check(`A row with '${m[2]}' is listed`, n > 0, n ? first : `no row contains '${m[2]}'${(await countOf(t))?.how ? ` (${(await countOf(t))!.how})` : ''}`);
    },
  },
  {
    name: 'expect url',
    pattern: re(`expect url ${q}`),
    check: async (t, m) => {
      const at = new URL(t.page.url());
      t.check(`The page is ${m[1]}`, `${at.pathname}${at.search}`.includes(m[1]), `the page is ${at.pathname}${at.search}`);
    },
  },
  {
    name: 'expect button state',
    pattern: re(`expect (?:button|control) ${q}(?: (enabled|disabled|visible|hidden))?`),
    check: async (t, m) => {
      const el = t.page.getByRole('button', { name: exactOrStarts(m[1]) }).or(t.page.getByRole('link', { name: exactOrStarts(m[1]) })).or(t.page.getByRole('switch', { name: exactOrStarts(m[1]) })).first();
      const visible = await el.isVisible().catch(() => false);
      const want = (m[2] ?? 'visible').toLowerCase();
      if (want === 'hidden') return void t.check(`'${m[1]}' is hidden`, !visible, visible ? 'it is visible' : 'not shown');
      if (!visible) return void t.check(`'${m[1]}' is ${want}`, false, 'not on the page');
      if (want === 'visible') return void t.check(`'${m[1]}' is visible`, true, 'visible');
      const disabled = await el.isDisabled().catch(() => false);
      t.check(`'${m[1]}' is ${want}`, want === 'disabled' ? disabled : !disabled, disabled ? 'disabled' : 'enabled');
    },
  },
  {
    name: 'expect field value',
    pattern: re(`expect field ${q} (=|contains|!=) ${q}`),
    check: async (t, m) => {
      const f = await field(t, m[1]).catch(() => null);
      if (!f) return void t.check(`'${m[1]}' field`, false, 'no such field on the page');
      const v = await f.inputValue().catch(async () => (await f.innerText()).trim());
      const ok = m[2] === '=' ? v === m[3] : m[2] === '!=' ? v !== m[3] : v.includes(m[3]);
      t.check(`'${m[1]}' ${m[2]} '${m[3]}'`, ok, `the field shows "${v}"`);
    },
  },
  {
    name: 'expect value',
    // "EXPECT VALUE 'On Hand' = '13'" — the number or text shown next to a label (cards, detail lists, totals).
    pattern: re(`expect value ${q} ${OPS} ${q}`),
    check: async (t, m) => {
      const read = await readValue(t, m[1]);
      if (read === null) return void t.check(`'${m[1]}' ${m[2]} ${m[3]}`, false, `no value labelled '${m[1]}' on the page`);
      const [a, b] = [numberIn(read), numberIn(m[3])];
      const ok = a !== null && b !== null && /\d/.test(m[3])
        ? compare(a, m[2], b)
        : m[2] === '!=' ? read.toLowerCase() !== m[3].toLowerCase() : read.toLowerCase() === m[3].toLowerCase();
      t.check(`'${m[1]}' ${m[2]} ${m[3]}`, !!ok, `shows ${read}`);
    },
  },
  {
    name: 'expect value vs remembered',
    // "EXPECT VALUE 'On Hand' = stock + 5" / "> stock" — compared with a value kept by REMEMBER before the steps.
    pattern: re(`expect value ${q} ${OPS} ${ref}`),
    check: async (t, m) => {
      const want = resolveRef(t, m[3], m[4], m[5]);
      const label = `'${m[1]}' ${m[2]} ${typeof want === 'string' ? m.slice(3).filter(Boolean).join(' ') : want.text}`;
      if (typeof want === 'string') return void t.skip(label, `Cannot compare: ${want}.`);
      const read = await readValue(t, m[1]);
      if (read === null) return void t.check(label, false, `no value labelled '${m[1]}' on the page`);
      const a = numberIn(read);
      t.check(label, a !== null && compare(a, m[2], want.n), `shows ${read}`);
    },
  },
  {
    name: 'expect value changed',
    // "EXPECT VALUE 'Total' CHANGED / UNCHANGED" — against what REMEMBER VALUE 'Total' AS … read before.
    pattern: re(`expect value ${q} (changed|unchanged|is unchanged|stays the same|is the same)`),
    check: async (t, m) => {
      const same = !/^changed$/i.test(m[2]);
      const before = t.noted.get(`varlabel:${m[1].toLowerCase()}`) as Remembered | undefined;
      const label = `'${m[1]}' ${same ? 'stays the same' : 'changes'}`;
      if (!before) return void t.skip(label, `Cannot compare: '${m[1]}' was not remembered before the steps (REMEMBER VALUE '${m[1]}' AS name).`);
      const now = await readValue(t, m[1]);
      if (now === null) return void t.check(label, false, `no value labelled '${m[1]}' on the page (before: ${before.raw})`);
      const eq = before.num !== null && numberIn(now) !== null ? before.num === numberIn(now) : before.raw.trim() === now.trim();
      t.check(label, same ? eq : !eq, `before ${before.raw}, now ${now}`);
    },
  },
  {
    name: 'expect count',
    pattern: re(`expect count ${q}`),
    check: async (t, m) => {
      const text = await bodyText(t);
      t.check(`'${m[1]}' is shown`, text.includes(m[1]), text.match(/Showing\s*\d+\s*[–-]\s*\d+\s*of\s*\d+|\d+ results?/)?.[0] ?? 'no count on the page');
    },
  },
  {
    name: 'expect count vs remembered',
    // "EXPECT COUNT = n - 1" / "EXPECT COUNT < n" / "EXPECT COUNT = 0": the list total compared with a number.
    pattern: re(`expect count ${OPS} ${ref}`),
    check: async (t, m) => {
      const want = resolveRef(t, m[2], m[3], m[4]);
      const label = `The list count ${m[1]} ${typeof want === 'string' ? m.slice(2).filter(Boolean).join(' ') : want.text}`;
      if (typeof want === 'string') return void t.skip(label, `Cannot compare: ${want}.`);
      const c = await countOf(t);
      if (!c) return void t.check(label, false, 'no count or list on the page');
      t.check(label, compare(c.n, m[1], want.n), `${c.n} (${c.how})`);
    },
  },
  {
    name: 'expect count changed',
    pattern: re(`expect count (changed|unchanged|is unchanged|stays the same)`),
    check: async (t, m) => {
      const same = !/^changed$/i.test(m[1]);
      const before = t.noted.get('varlabel:__count') as Remembered | undefined;
      const label = `The list count ${same ? 'stays the same' : 'changes'}`;
      if (!before) return void t.skip(label, 'Cannot compare: no REMEMBER COUNT AS name ran before the steps.');
      const c = await countOf(t);
      if (!c) return void t.check(label, false, `no count or list on the page (before: ${before.raw})`);
      t.check(label, same ? c.n === before.num : c.n !== before.num, `before ${before.raw}, now ${c.n} (${c.how})`);
    },
  },
  {
    name: 'expect message',
    pattern: re(`expect (?:a |an )?(?:message|toast|alert)(?: ${q})?`),
    check: async (t, m) => {
      const seen = [...t.toasts, ...(await t.page.locator('[role=alert], [data-sonner-toast]').allInnerTexts().catch(() => []))].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const ok = m[1] ? seen.some((s) => s.toLowerCase().includes(m[1].toLowerCase())) : seen.length > 0;
      t.check(m[1] ? `A message '${m[1]}' appears` : 'A message appears', ok, seen.length ? [...new Set(seen)].join(' | ').slice(0, 200) : 'no message appeared');
    },
  },
];
