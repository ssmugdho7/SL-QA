import type { Locator } from 'playwright';
import type { CaseContext } from '../context.js';
import { pagePath } from '../pages.js';
import { escapeRe, Missing } from '../ui.js';
import type { ExpectRule } from './expects.js';
import type { StepRule } from './steps.js';

/**
 * Basic actions that work on any page, written in a fixed, exact form:
 *
 *   GO TO '/dashboard/orders'         CLICK 'Save Product'           TYPE '100' INTO 'Selling Price'
 *   SELECT 'kg' IN 'Unit'             TURN ON 'Track inventory'      PRESS 'Enter'
 *   WAIT 2                            CHECK 'Select all'
 *
 *   EXPECT TEXT 'Product created'     EXPECT NO TEXT 'Error'          EXPECT URL '/dashboard/orders'
 *   EXPECT BUTTON 'Save' ENABLED      EXPECT FIELD 'Selling Price' = '100'   EXPECT COUNT 'Showing 1–1 of 1'
 *
 * The AI translator writes steps in this form, and people can too. Every target is found by what a person sees:
 * button and link text, field labels, placeholders, then any visible text.
 */

const q = `'([^']*)'`;
const re = (s: string) => new RegExp(`^${s}$`, 'i');

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

/** A text box by its label, placeholder or the <label> just before it. */
async function field(t: CaseContext, name: string): Promise<Locator> {
  const page = t.page;
  const exact = new RegExp(`^\\s*${escapeRe(name)}\\s*\\*?\\s*$`, 'i');
  const tries: Locator[] = [
    page.getByLabel(exact),
    page.getByPlaceholder(new RegExp(escapeRe(name), 'i')),
    page.getByRole('textbox', { name: new RegExp(escapeRe(name), 'i') }),
    page.getByRole('spinbutton', { name: new RegExp(escapeRe(name), 'i') }),
    page.getByRole('searchbox', { name: new RegExp(escapeRe(name), 'i') }),
    page.locator(`xpath=//label[translate(normalize-space(translate(., '*', '')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')=${JSON.stringify(name.toLowerCase())}]/following::*[self::input[not(@type='hidden') and not(@type='checkbox') and not(@type='file')] or self::textarea or @contenteditable='true'][1]`),
  ];
  for (const loc of tries) {
    const hit = loc.filter({ visible: true }).first();
    if (await hit.count()) return hit;
  }
  // A collapsed section may hide it: open closed section headers once and try again.
  const closed = page.locator('main button[aria-expanded=false]');
  if (await closed.count()) {
    for (let i = 0; i < Math.min(await closed.count(), 6); i++) await closed.nth(0).click().catch(() => undefined);
    for (const loc of tries) {
      const hit = loc.filter({ visible: true }).first();
      if (await hit.count()) return hit;
    }
  }
  const labels = await page.locator('label').filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  throw new Missing(`a '${name}' field`, labels.map((s) => s.trim()).filter(Boolean));
}

async function bodyText(t: CaseContext): Promise<string> {
  return (await t.page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

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
        const scopes = [
          t.page.getByRole('dialog', { name: new RegExp(escapeRe(m[3]), 'i') }),
          t.page.locator('tbody tr, article, li').filter({ hasText: m[3] }),
          t.page.locator('section, form, aside, [role=region]').filter({ hasText: m[3] }),
        ];
        for (const sc of scopes) {
          const box = sc.filter({ visible: true }).first();
          if (!(await box.count())) continue;
          const hit = box.getByRole('button', { name: exactOrStarts(m[2]) }).or(box.getByRole('link', { name: exactOrStarts(m[2]) })).or(box.getByLabel(new RegExp(`^\\s*${escapeRe(m[2])}\\s*$`, 'i'))).or(box.getByText(m[2], { exact: true })).filter({ visible: true }).first();
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
    pattern: re(`(?:type|enter|fill) ${q} (?:into|in) ${q}`),
    run: async (t, m) => {
      const f = await field(t, m[2]);
      await f.fill('');
      if (m[1]) await f.pressSequentially(m[1], { delay: 10 });
      await t.page.waitForTimeout(200);
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
];

/** Exact checks in the same fixed form. */
export const ACTION_EXPECTS: ExpectRule[] = [
  {
    name: 'expect text',
    pattern: re(`expect (no )?text ${q}`),
    check: async (t, m) => {
      const text = await bodyText(t);
      const toasts = t.toasts.join(' | ');
      const found = text.toLowerCase().includes(m[2].toLowerCase()) || toasts.toLowerCase().includes(m[2].toLowerCase());
      if (m[1]) t.check(`'${m[2]}' is not shown`, !found, found ? 'it is on the page' : 'not on the page');
      else t.check(`'${m[2]}' is shown`, found, found ? 'shown' : `not on the page${toasts ? `; messages seen: ${toasts.slice(0, 160)}` : ''}`);
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
    pattern: re(`expect value ${q} (=|>=|<=|>|<|!=) ${q}`),
    check: async (t, m) => {
      const read = await t.page.evaluate((label) => {
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
      }, m[1]);
      if (read === null) return void t.check(`'${m[1]}' ${m[2]} ${m[3]}`, false, `no value labelled '${m[1]}' on the page`);
      const num = (x: string) => Number(x.replace(/[^\d.-]/g, ''));
      const [a, b] = [num(read), num(m[3])];
      const numeric = /\d/.test(read) && /\d/.test(m[3]) && !Number.isNaN(a) && !Number.isNaN(b);
      const ok = numeric
        ? { '=': a === b, '!=': a !== b, '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b }[m[2] as '=']
        : m[2] === '!=' ? read.toLowerCase() !== m[3].toLowerCase() : read.toLowerCase() === m[3].toLowerCase();
      t.check(`'${m[1]}' ${m[2]} ${m[3]}`, !!ok, `shows ${read}`);
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
    name: 'expect message',
    pattern: re(`expect (?:a |an )?(?:message|toast|alert)(?: ${q})?`),
    check: async (t, m) => {
      const seen = [...t.toasts, ...(await t.page.locator('[role=alert], [data-sonner-toast]').allInnerTexts().catch(() => []))].map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const ok = m[1] ? seen.some((s) => s.toLowerCase().includes(m[1].toLowerCase())) : seen.length > 0;
      t.check(m[1] ? `A message '${m[1]}' appears` : 'A message appears', ok, seen.length ? [...new Set(seen)].join(' | ').slice(0, 200) : 'no message appeared');
    },
  },
];
