import fs from 'fs';
import path from 'path';
import type { Locator } from 'playwright';
import { config } from '../config.js';
import type { CaseContext } from '../context.js';
import { pagePath, PAGE_NAMES } from '../pages.js';
import { escapeRe, exactText, Missing } from '../ui.js';
import { ACTION_RULES } from './actions.js';
import { acceptConfirmation, clickNamed, guard, nearPages, rowName, sidebarPath, STEP_RULES, type StepRule } from './steps.js';
import { isLabel, listItems, money, RECORD, when } from './text.js';
import { FORM_RULES } from './form.js';

/**
 * Step rules for plain-language bug reports ("Navigate to Create order/POS page", "Add a product to the cart",
 * "Click Checkout button to open the form", "Type a value that exceeds the total"). Zero AI: fixed patterns,
 * and each one says in the step log what it actually did.
 */

/** Test customer used when a form needs one (a test server; the same phone each time so it is reused). */
export const TEST_CUSTOMER = { name: 'BTB Test', phone: '01700000000', address: 'House 1, Road 1, Gulshan, Dhaka' };

const onPath = (t: CaseContext, re: RegExp) => re.test(new URL(t.page.url()).pathname);

async function openPage(t: CaseContext, path: string): Promise<void> {
  await t.ui.goto(path);
  t.state = { filters: {}, store: t.state.store, loggedOut: t.state.loggedOut };
}

/** "৳730.00" next to the "Total" label in the open dialog, or the cart panel / page. */
export async function readTotal(t: CaseContext, label = 'Total'): Promise<number | null> {
  const text = await t.page.evaluate(() => {
    const v = (e: Element) => e.getClientRects().length > 0;
    const d = [...document.querySelectorAll('[role=dialog]')].filter(v).filter((x) => /\bTotal\b/.test((x as HTMLElement).innerText)).at(-1) as HTMLElement | undefined;
    return (d ?? document.querySelector('aside') ?? document.body as HTMLElement as HTMLElement).innerText;
  }).catch(() => '');
  const m = text.match(new RegExp(`(?:^|\\n)\\s*${escapeRe(label)}\\s*\\n?\\s*(-?\\s*[−-]?৳\\s*-?[\\d,]+(?:\\.\\d+)?)`, 'i'));
  if (!m) return null;
  const n = money(m[1].replace(/[−-]\s*৳/, '৳-'));
  return n;
}

/** Visible messages that could be a warning about the value just typed: toasts, alerts, red helper text, invalid fields. */
export async function messages(t: CaseContext): Promise<string[]> {
  return t.page.evaluate(() => {
    const v = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const out = new Set<string>();
    for (const e of document.querySelectorAll('[data-sonner-toast], [role=alert], [aria-live=assertive]')) if (v(e)) out.add((e as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
    for (const e of document.querySelectorAll('[aria-invalid=true]')) if (v(e)) out.add(`field marked invalid${(e as HTMLInputElement).value ? ` (value ${(e as HTMLInputElement).value})` : ''}`);
    for (const e of document.querySelectorAll('[class*=destructive], [class*=text-red], [class*=text-danger], [class*=error]')) {
      const s = (e as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
      if (v(e) && s && s.length < 160 && e.children.length < 3) out.add(s);
    }
    return [...out].filter(Boolean);
  }).catch(() => []);
}

/** Opens the amount editor next to "Discount" (the pencil showing "−৳0.00"), closing the coupon list if it is open. */
async function openDiscountEditor(t: CaseContext): Promise<Locator | null> {
  const coupons = t.page.getByRole('dialog').filter({ hasText: /Available coupons/i }).filter({ visible: true });
  if (await coupons.count()) {
    // Its Close button and Escape also close the checkout form underneath; a click outside closes only the list.
    await t.page.mouse.click(5, 5);
    await t.page.waitForTimeout(600);
    t.note("'Discount or coupon' opens a list of coupons; the bot closed it and used the discount amount editor (the pencil next to the discount) instead.");
  }
  const scope = (await t.ui.dialog().count()) ? t.ui.dialog() : t.page;
  const pencil = scope.getByRole('button', { name: /^\s*[−-]\s*৳/ }).filter({ visible: true }).first();
  if (!(await pencil.count())) return null;
  await pencil.click();
  await t.page.waitForTimeout(600);
  const field = t.page.locator('input[placeholder="0.00"], input[inputmode=decimal], input[type=number]').filter({ visible: true }).last();
  return (await field.count()) ? field : null;
}

/** The field a "type …" step means: one it names, the focused one, the discount editor, or the last empty field in the open form. */
async function targetField(t: CaseContext, named: string, hint: string): Promise<Locator> {
  const notSearch = ':not([type=search]):not([type=checkbox]):not([type=radio]):not([type=hidden])';
  if (named && !/^(?:it|this|that|the field|the box)$/i.test(named)) {
    const re = new RegExp(escapeRe(named.replace(/\s+(?:box|field|input)$/i, '')), 'i');
    const byLabel = t.page.getByLabel(re).or(t.page.getByPlaceholder(re)).filter({ visible: true }).first();
    if (await byLabel.count()) return byLabel;
  }
  if (/discount/i.test(`${named} ${hint}`)) {
    const f = await openDiscountEditor(t);
    if (f) return f;
  }
  const focused = t.page.locator(`input${notSearch}:focus, textarea:focus`);
  if (await focused.count()) return focused.first();
  const scope = (await t.ui.dialog().count()) ? t.ui.dialog() : t.ui.main;
  const any = scope.locator(`input${notSearch}`).filter({ visible: true });
  if (await any.count()) return any.last();
  throw new Missing(`a field to type into${named ? ` ('${named}')` : ''}`);
}

/** Types a value and records what the page did with it, for "should block / should show an alert" checks. */
async function typeAndObserve(t: CaseContext, field: Locator, value: string): Promise<string> {
  const totalBefore = await readTotal(t);
  const before = new Set(await messages(t));
  const toastsBefore = t.toasts.length;
  const dialogsBefore = t.dialogsFired;
  await field.fill('');
  await field.pressSequentially(value, { delay: 30 });
  await t.page.waitForTimeout(900);
  const kept = await field.inputValue().catch(() => '');
  const totalAfter = await readTotal(t);
  const shown = [...(await messages(t)).filter((m) => !before.has(m)), ...t.toasts.slice(toastsBefore)];
  if (t.dialogsFired > dialogsBefore) shown.push('a browser pop-up appeared');
  await t.shot('after typing');
  const obs = { value: Number(value.replace(/,/g, '')), kept, totalBefore, totalAfter, messages: [...new Set(shown)] };
  t.noted.set('__typed', obs);
  entered(t, '', value);
  // Finish editing the way a person would, so the next steps see the value applied.
  const done = t.page.getByRole('button', { name: /^\s*(done editing|done|apply|save)\s*$/i }).filter({ visible: true });
  if (await done.count()) {
    await done.last().click().catch(() => undefined);
    await t.page.waitForTimeout(600);
    obs.totalAfter = (await readTotal(t)) ?? obs.totalAfter;
  }
  const money = (n: number | null) => (n === null ? '?' : `৳${n.toFixed(2)}`);
  return `Typed ${value}; the field shows "${kept}", Total ${money(totalBefore)} → ${money(obs.totalAfter)}${obs.messages.length ? `; message: ${obs.messages.join(' | ')}` : '; no message shown'}.`;
}

/** Clicks "Add" on a POS product card (the named one when it exists), and remembers to empty the cart afterwards. */
export async function addToCart(t: CaseContext, hint: string): Promise<string> {
  if (!onPath(t, /\/dashboard\/pos/)) await openPage(t, '/dashboard/pos');
  const addButtons = () => t.page.getByRole('button', { name: /^\s*\+?\s*Add\s*$/ }).filter({ visible: true });
  const search = t.page.getByPlaceholder(/search products/i).filter({ visible: true }).first();
  let note = '';
  const wanted = hint.replace(/\(.*$/, '').split(/\s+/).slice(0, 4).join(' ').trim();
  if (wanted && (await search.count())) {
    await search.fill(wanted);
    await t.page.waitForTimeout(1500);
    // An exact product the case made itself: its card is the only match.
    if (!(await addButtons().count())) {
      note = ` '${hint.slice(0, 60)}' is not in this store, so the first product in stock was used.`;
      await search.fill('');
      await t.page.waitForTimeout(1200);
    }
  }
  let button: Locator | null = null;
  for (let i = 0; i < Math.min(await addButtons().count(), 24); i++) {
    if (await addButtons().nth(i).isEnabled()) { button = addButtons().nth(i); break; }
  }
  if (!button) throw new Missing("an 'Add' button on a product in stock");
  const name = await button.evaluate((b) => {
    const card = b.closest('.group, article, li') as HTMLElement | null;
    return card?.querySelector('[title]')?.getAttribute('title') ?? card?.innerText.split('\n').find((l) => l.length > 6 && !/stock|৳|off/i.test(l)) ?? '';
  }).catch(() => '');
  await button.click();
  await t.page.getByRole('button', { name: /^\s*Checkout\b/ }).filter({ visible: true }).first().waitFor({ timeout: 8_000 }).catch(() => undefined);
  t.onCleanup(() => emptyCart(t));
  return `Added '${name}' to the cart.${note}`;
}

async function emptyCart(t: CaseContext): Promise<void> {
  const p = t.page;
  if (!onPath(t, /\/dashboard\/pos/)) await t.ui.goto('/dashboard/pos', { waitForList: false });
  await p.waitForTimeout(1000);
  for (let i = 0; i < 3 && (await t.ui.dialog().count()); i++) {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  }
  const clear = p.getByRole('button', { name: /^\s*Clear cart\s*$/ }).filter({ visible: true }).first();
  if (!(await clear.count())) return;
  await clear.click();
  await p.waitForTimeout(500);
  const yes = p.getByRole('button', { name: /^\s*(clear|yes|confirm)/i }).filter({ visible: true }).first();
  if (await yes.count()) await yes.click();
}

/** Fills the open form's required fields with test data; on POS checkout it pastes a test customer and saves it. */
async function fillRequired(t: CaseContext): Promise<string> {
  const scope = (await t.ui.dialog().count()) ? t.ui.dialog() : t.ui.main;
  const done: string[] = [];
  const paste = scope.locator('textarea').filter({ visible: true }).filter({ has: t.page.locator(':scope') });
  for (let i = 0; i < (await paste.count()); i++) {
    const ph = (await paste.nth(i).getAttribute('placeholder')) ?? '';
    if (!/name:[\s\S]*phone:/i.test(ph)) continue;
    await paste.nth(i).fill(`Name: ${TEST_CUSTOMER.name}\nPhone: ${TEST_CUSTOMER.phone}\nAddress: ${TEST_CUSTOMER.address}`);
    const fill = scope.getByRole('button', { name: /^\s*Fill\s*$/ }).filter({ visible: true }).first();
    if (await fill.count()) await fill.click();
    await t.page.waitForTimeout(1800);
    const save = t.page.getByRole('button', { name: /^\s*save customer\s*$/i }).filter({ visible: true });
    if (await save.count()) {
      await save.first().click();
      await t.page.waitForTimeout(2200);
    }
    // Saving the customer closes the checkout form on POS; open it again so the next steps continue in it.
    if (!(await t.ui.dialog().count())) {
      const checkout = t.page.getByRole('button', { name: /^\s*Checkout\b/ }).filter({ visible: true }).first();
      if (await checkout.count()) {
        await checkout.click();
        await t.ui.dialog().waitFor({ timeout: 8_000 }).catch(() => undefined);
        await t.page.waitForTimeout(800);
      }
    }
    done.push(`customer ${TEST_CUSTOMER.name} (${TEST_CUSTOMER.phone}), ${TEST_CUSTOMER.address}`);
    break;
  }
  const form = (await t.ui.dialog().count()) ? t.ui.dialog() : t.ui.main;
  const required = form.locator('input[required], textarea[required], [aria-required=true]').filter({ visible: true });
  for (let i = 0; i < (await required.count()); i++) {
    const f = required.nth(i);
    if ((await f.inputValue().catch(() => 'x')) !== '') continue;
    const type = (await f.getAttribute('type')) ?? 'text';
    const value = type === 'email' ? 'btb.test@example.com' : type === 'tel' ? TEST_CUSTOMER.phone : type === 'number' ? '1' : 'BTB test';
    await f.fill(value).catch(() => undefined);
    done.push(`${(await f.getAttribute('name')) || (await f.getAttribute('placeholder')) || type} = ${value}`);
  }
  const still = await form.innerText().then((s) => s.match(/Still needed:[^\n]*/i)?.[0]).catch(() => undefined);
  if (still) t.note(`After filling the required fields the form still says: "${still}".`);
  return `${done.length ? `Filled ${done.join('; ')}` : 'No empty required fields found'}.${still ? ` The form still says "${still}".` : ''}`;
}

/** "#1 → card" pairs on the visible cards (the position badges on grid cards). */
export async function positionLabels(t: CaseContext): Promise<{ label: number; card: string }[]> {
  return t.page.evaluate(() => {
    const v = (e: Element) => e.getClientRects().length > 0;
    const root = document.querySelector('main') ?? document.body;
    return [...root.querySelectorAll('*')].filter((e) => v(e) && e.children.length === 0 && /^#\s?\d+$/.test((e as HTMLElement).innerText?.trim() ?? '')).map((e) => {
      let c = e as HTMLElement;
      for (let i = 0; i < 10 && c.parentElement; i++) {
        c = c.parentElement;
        if (c.innerText.split('\n').filter(Boolean).length > 5) break;
      }
      const label = Number((e as HTMLElement).innerText.replace(/\D/g, ''));
      return { label, card: c.innerText.split('\n').map((l) => l.trim()).find((l) => l && !/^#\s?\d+$/.test(l)) ?? '' };
    });
  }).catch(() => []);
}

export interface SortResult { option: string; before: { label: number; card: string }[]; after: { label: number; card: string }[] }

/** Switches to a different sort option and records the position labels before and after (grid view if the list has none). */
export async function sortDifferently(t: CaseContext): Promise<string> {
  const p = t.page;
  // An earlier "Click the Sort button" step leaves the menu open; close it so the view can be switched first.
  if (await p.getByRole('menu').filter({ visible: true }).count()) {
    await p.keyboard.press('Escape');
    await p.getByRole('menu').filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
  }
  let before = await positionLabels(t);
  let switched = false;
  if (!before.length && (await p.getByRole('group', { name: 'Layout' }).count())) {
    await t.ui.setView('grid');
    switched = true;
    before = await positionLabels(t);
  }
  await t.ui.main.getByRole('button', { name: /^\s*sort\b/i }).filter({ visible: true }).first().click();
  const items = p.getByRole('menuitemradio').or(p.getByRole('menuitem')).filter({ visible: true });
  await items.first().waitFor({ timeout: 5_000 });
  const all = (await items.allInnerTexts()).map((s) => s.trim());
  const checked = await items.evaluateAll((xs) => xs.findIndex((x) => x.getAttribute('aria-checked') === 'true' || x.getAttribute('data-state') === 'checked'));
  const current = checked >= 0 ? checked : 0;
  // Prefer an order that keeps the same records on screen but reshuffles them (a value sort), so labels can be compared.
  const pick = all.findIndex((x, i) => i !== current && /high|low|total|price|amount|name/i.test(x));
  const choice = pick >= 0 ? pick : current === 0 ? 1 : 0;
  await items.nth(choice).click();
  await p.waitForFunction(() => {
    const root = document.querySelector('main') ?? document.body;
    return !/\b0 results\b/.test((root as HTMLElement).innerText) && !root.querySelector('.animate-pulse');
  }, null, { timeout: 15_000 }).catch(() => undefined);
  await t.ui.settle();
  const after = await positionLabels(t);
  const result = { option: all[choice], before, after };
  t.noted.set('__sort', result);
  t.onCleanup(async () => {
    await t.ui.main.getByRole('button', { name: /^\s*sort\b/i }).filter({ visible: true }).first().click().catch(() => undefined);
    await p.getByRole('menuitemradio').or(p.getByRole('menuitem')).filter({ visible: true }).nth(current).click().catch(() => undefined);
    if (switched) await t.ui.setView('list').catch(() => undefined);
  });
  return `Sorted by '${all[choice]}'${switched ? ' (in Grid view, where the cards show #1, #2 …)' : ''}.`;
}

const NOUN = '(?:action\\s+)?(?:button|field|link|tab|icon|option|toggle|checkbox|menu|box|input|area|control|card|item|dropdown|drop-down)';

/** Tried before the regular rules: these phrasings would otherwise be read by a broader rule the wrong way. */
const FIRST: StepRule[] = [
  {
    name: 'open the site',
    pattern: /^(?:go to|open|visit|navigate to|log ?in to)\s+(?:the\s+)?(?:(https?:\/\/\S+|\/dashboard\S*)|shoplagbe\b.*|slshop\b.*|merchant dashboard\b.*|(?:the\s+)?(?:website|site|app))\s*$/i,
    run: async (t, m) => {
      const url = m[1]?.replace(/[.,;]+$/, '');
      const local = url?.match(/^https?:\/\/(?:www\.)?slshop\.cloud(\/\S*)?$/i);
      await openPage(t, url ? (local ? local[1] || '/dashboard' : url) : '/dashboard');
      return `Opened ${new URL(t.page.url()).pathname}.`;
    },
  },
  {
    name: 'add product to cart',
    pattern: /^add (?:a|an|any|one|the|some|1)?\s*(?:product|item)s?\b(?:\s+to (?:the )?(?:cart|order|sale|basket))?(?:\s*\((?:e\.?g\.?|eg|for example|like|such as)[;:,.]?\s*(.+)\))?\s*$|^add (?:it|this|that)(?: (?:product|item))? to (?:the )?(?:cart|order|sale|basket)$/i,
    run: async (t, m) => addToCart(t, (m[1] ?? '').trim()),
  },
  {
    name: 'fill required fields',
    pattern: /^(?:fill(?:\s+(?:up|in|out))?|complete|enter)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:required|mandatory|necessary|needed)\s+(?:fields?|details|information|info|data)\b.*$/i,
    run: async (t) => fillRequired(t),
  },
  {
    name: 'type a value into a field',
    pattern: /^(?:type|enter|input|put)\s+(?:in\s+)?(?:a|an|the|any|some)?\s*(?:(?:higher|larger|bigger|big|large|excessive|invalid|negative)\s+)?(?:value|number|amount|discount(?:\s+(?:amount|value))?|price|quantity)\b(.*)$/i,
    run: async (t, m, clause) => {
      const rest = m[1] ?? '';
      const example = rest.match(/(?:type|enter|e\.g\.?,?|like|such as)\s*'?৳?\s*(\d[\d,]*(?:\.\d+)?)/i)?.[1] ?? rest.match(/\b(\d[\d,]*(?:\.\d+)?)\b/)?.[1];
      const named = rest.match(/\b(?:in|into)\s+(?:the\s+)?'?([\w\s]+?)'?\s+(?:box|field|input)\b/i)?.[1] ?? '';
      const hint = `${clause} ${(t.noted.get('__lastClick') as string | undefined) ?? ''}`;
      const field = await targetField(t, named, hint);
      let value = example?.replace(/,/g, '') ?? '';
      if (/exceed|more than|higher than|greater than|above|over|larger than|bigger than/i.test(rest)) {
        const total = await readTotal(t);
        if (total !== null && (!value || Number(value) <= total)) {
          const used = String(Math.ceil(total + 100));
          if (value) t.note(`The example value ${value} is not more than the real total here (৳${total.toFixed(2)}), so the bot typed ${used}.`);
          value = used;
        }
      }
      if (!value) value = '99999';
      return typeAndObserve(t, field, value);
    },
  },
  {
    name: 'type a value into a named field',
    pattern: /^(?:type|enter|input|put)\s+'?(-?\d[\d,]*(?:\.\d+)?|[^']+)'?\s+(?:in|into)\s+(?:the\s+)?(?!search\b|'search)'?([^']+?)'?\s*(?:box|field|input)?$/i,
    run: async (t, m, clause) => {
      const field = await targetField(t, m[2], `${clause} ${(t.noted.get('__lastClick') as string | undefined) ?? ''}`);
      return typeAndObserve(t, field, m[1]);
    },
  },
];

FIRST.push({
  name: 'open the receipt',
  pattern: /^(?:check|view|open|look at|see|print|observe)\s+(?:the\s+)?(?:order\s+)?(?:receipt|invoice|order summary|order details)\b.*$/i,
  run: async (t) => {
    const o = t.noted.get('__order') as { id: number; reference: string; total: string; discount?: string } | undefined;
    if (!o) return 'No order was placed, so there is no receipt to open.';
    await t.ui.goto(`/dashboard/orders/detail?id=${o.id}`, { waitForList: false });
    await t.page.waitForTimeout(1500);
    await t.shot('receipt');
    return `Opened order ${o.reference}: total ৳${o.total}, discount ৳${o.discount ?? '?'}.`;
  },
});


// ── Generic page-agnostic steps (after the specific rules, before the plain clicks and the step language) ──

/** Runs one line of the step language (CLICK '…', SELECT '…' IN '…'), quoting names the way they need. */
async function act(t: CaseContext, line: string): Promise<string | void> {
  const rule = ACTION_RULES.find((r) => r.pattern.test(line));
  if (!rule) throw new Error(`No action reads "${line}"`);
  return rule.run(t, line.match(rule.pattern)!, line);
}
const qv = (s: string) => (s.includes('"') ? `'${s}'` : `"${s}"`);
const unq = (s: string) => s.trim().replace(/^['"‘“]|['"’”]$/g, '').trim();

/** Values typed by plain-language steps, newest last ("the new category should appear in the list" reads them). */
export function entered(t: CaseContext, label: string, value: string): void {
  const all = (t.noted.get('__entered') as { label: string; value: string }[] | undefined) ?? [];
  all.push({ label, value });
  t.noted.set('__entered', all);
}

const ROWS = 'tbody tr, [role=row]:not(:has([role=columnheader])), article';

/** A text box, by label or placeholder ("category name" also tries "name"), in the open dialog first. */
async function namedField(t: CaseContext, label: string): Promise<Locator> {
  const scopes = (await t.ui.dialog().count()) ? [t.ui.dialog(), t.page] : [t.page];
  const names = [label, label.replace(/^(?:the\s+)?(?:\w+\s+)(?=name|title|code|amount|number|price|phone|email|address|note)/i, '')].filter((x, i, a) => x && a.indexOf(x) === i);
  for (const scope of scopes) {
    for (const n of names) {
      const re = new RegExp(`^\\s*${escapeRe(n)}\\s*\\*?\\s*$`, 'i');
      const loose = new RegExp(escapeRe(n), 'i');
      for (const loc of [scope.getByLabel(re), scope.getByPlaceholder(loose), scope.getByRole('textbox', { name: loose }), scope.getByRole('spinbutton', { name: loose }), scope.getByLabel(loose)]) {
        const hit = loc.filter({ visible: true }).first();
        if (await hit.count().catch(() => 0)) return hit;
      }
    }
  }
  const labels = await scopes[0].locator('label').filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  throw new Missing(`a '${label}' field`, labels.map((s) => s.trim()).filter(Boolean));
}

/** "Status" = "Delivered", "Selling price" = "1200", "date filter" = "Last 7 days": a select, a text box, a dropdown, or a choice already on screen. */
async function setField(t: CaseContext, label: string, value: string): Promise<string> {
  entered(t, label, value);
  const native = t.page.getByLabel(new RegExp(escapeRe(label), 'i')).and(t.page.locator('select')).filter({ visible: true }).first();
  if (await native.count()) {
    await native.selectOption({ label: value });
    return `Chose '${value}' in '${label}'.`;
  }
  const box = await namedField(t, label).catch(() => null);
  if (box && (await box.evaluate((e) => /^(input|textarea)$/i.test(e.tagName) && !/^(checkbox|radio|file)$/i.test((e as HTMLInputElement).type) && e.getAttribute('role') !== 'combobox').catch(() => false))) {
    await box.fill(value);
    await t.page.waitForTimeout(300);
    return `Typed '${value}' in '${label}'.`;
  }
  // A choice already on screen ('Last 7 days' next to a date filter, a status button).
  const choice = t.ui.main.getByRole('button', { name: exactText(value) }).or(t.ui.main.getByRole('tab', { name: exactText(value) })).or(t.ui.main.getByRole('radio', { name: exactText(value) })).filter({ visible: true }).first();
  if (!box && (await choice.count())) {
    await choice.click();
    await t.ui.settle();
    return `Clicked '${value}'.`;
  }
  await act(t, `SELECT ${qv(value)} IN ${qv(label)}`);
  return `Chose '${value}' in '${label}'.`;
}

/** A row of the list for "on any product", "the first customer", "a pending order". Products use the case's own test products. */
async function recordRow(t: CaseContext, kind: string, hint: string): Promise<{ row: Locator; name: string }> {
  const h = /^(?:a|an|any|one|the|first|some|test|new|same)$/i.test(hint) ? '' : hint;
  // On the Products list, "a product" is one of the case's own test products (made now if needed).
  if (/product|item/i.test(kind) && !h && /^\/dashboard\/products\/?$/.test(new URL(t.page.url()).pathname)) {
    if (!t.fixtures.length) await t.fixtureProduct('Item 1', { current_stock: 5, price: 100 });
    const name = await rowName(t, '');
    return { row: t.ui.row(name), name };
  }
  await t.ui.settle();
  const rows = t.ui.main.locator(ROWS).filter({ visible: true });
  const want = h ? rows.filter({ hasText: new RegExp(`\\b${escapeRe(h)}\\b`, 'i') }) : rows;
  if (!(await want.count())) {
    const seen = (await rows.allInnerTexts().catch(() => [] as string[])).slice(0, 6).map((r) => r.replace(/\s+/g, ' ').slice(0, 50));
    throw new Missing(`a${h ? ` '${h}'` : ''} ${kind} in the list`, seen);
  }
  const row = /last/i.test(hint) ? want.last() : want.first();
  const name = ((await row.innerText().catch(() => '')).split('\n').map((x) => x.trim()).find((x) => x.length > 1) ?? '').slice(0, 80);
  t.noted.set('__row', name);
  return { row, name };
}

/** Clicks a control named `name` inside a row (its own button, link, or the row's "More actions" menu). */
async function clickInRow(t: CaseContext, row: Locator, name: string): Promise<boolean> {
  const re = new RegExp(`^\\s*${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'iu');
  const own = row.getByRole('button', { name: re }).or(row.getByRole('link', { name: re })).or(row.getByLabel(re)).filter({ visible: true }).first();
  if (await own.count()) {
    await own.click();
    return true;
  }
  const more = row.getByRole('button', { name: /more|actions|⋮|options/i }).filter({ visible: true }).last();
  if (!(await more.count())) return false;
  await more.click();
  const item = t.page.getByRole('menuitem', { name: re }).filter({ visible: true }).first();
  if (await item.count()) {
    await item.click();
    return true;
  }
  await t.page.keyboard.press('Escape');
  return false;
}

/** The page's own search box: type, wait for the list, and remember the term for the result checks. */
async function searchFor(t: CaseContext, value: string): Promise<string> {
  const box = t.ui.main.locator('input[type=search], input[placeholder*="earch" i]').filter({ visible: true }).first();
  if (!(await box.count())) throw new Missing('a search box on this page');
  const before = await t.ui.showingText();
  await box.fill(value);
  await t.page.waitForTimeout(500);
  await t.ui.settle();
  await t.ui.waitForListChange(before);
  t.state.search = value;
  t.state.searchKind = 'text';
  t.state.searchTarget = undefined;
  return `Searched '${value}'.`;
}

/** Picks a filter: a status tab of that name, else a dropdown / switch / choice in the Filter panel, then Done. */
async function applyFilter(t: CaseContext, field: string | null, value: string): Promise<string> {
  const tab = t.ui.statusTab(value).or(t.ui.main.getByRole('tab', { name: exactText(value) })).filter({ visible: true }).first();
  if (!field && (await tab.count())) {
    await tab.click();
    await t.ui.settle();
    t.state.tab = value;
    return `Clicked the '${value}' tab.`;
  }
  if (!(await t.ui.main.locator('button').filter({ hasText: /^\s*Filter/ }).filter({ visible: true }).count()) && !(await t.ui.dialog().count())) throw new Missing('a Filter button on this page');
  const dialog = await t.ui.openFilter();
  const picked = await t.ui.pickOption(field, value).then(() => true).catch(() => false);
  if (!picked) {
    const re = new RegExp(`^\\s*${escapeRe(value)}`, 'i');
    const choice = dialog.getByRole('switch', { name: re }).or(dialog.getByRole('checkbox', { name: re })).or(dialog.getByRole('radio', { name: re })).or(dialog.getByRole('button', { name: re })).or(dialog.getByText(re)).filter({ visible: true }).first();
    if (!(await choice.count())) throw new Missing(`'${value}' in the Filter panel`, (await dialog.innerText().catch(() => '')).split('\n').map((x) => x.trim()).filter((x) => x && x.length < 40).slice(0, 15));
    await choice.click();
  }
  const before = await t.ui.showingText();
  const done = t.ui.dialog().getByRole('button', { name: /^\s*(done|apply|show results|ok)\b/i }).filter({ visible: true }).first();
  if (await done.count()) await done.click();
  await t.ui.settle();
  await t.ui.waitForListChange(before);
  t.state.filters[lc(field ?? 'filter')] = value;
  return `Filtered ${field ? `${field} = ` : ''}'${value}'.`;
}

/** Test values for fields named in a step ("Fill in name, phone and address"). */
function testValue(t: CaseContext, field: string): string {
  const f = lc(field);
  if (/phone|mobile/.test(f)) return TEST_CUSTOMER.phone;
  if (/address/.test(f)) return TEST_CUSTOMER.address;
  if (/email/.test(f)) return 'btb.test@example.com';
  if (/code/.test(f)) return `BTB${Date.now() % 10_000}`;
  return `${config.fixturePrefix} ${t.tc.id} Test`;
}

const lc = (s: string) => s.toLowerCase();
const NOT_A_NAME = /^(?:it|its|them|this|that|these|those|here|there|again|everything|anything|something|one|another|other|each|every|all|both|some|any|a|an|the|which|where|when|if|after|before|then|until|while|so)$/i;
const KEYS = /^(?:enter|esc(?:ape)?|tab|space|backspace|f\d{1,2}|arrow ?(?:up|down|left|right)|ctrl.*|cmd.*)$/i;

/** A control name a person would read on screen: Title Case words ("Place Order"), or a short lower-case one ("variants"). */
function controlName(raw: string): boolean {
  const name = raw.trim();
  const w = name.split(/\s+/);
  if (!name || KEYS.test(name) || /['"‘’“”]/.test(name) || w.length > 5 || /[,;:.!?()]/.test(name) || w.some((x) => NOT_A_NAME.test(x)) || new RegExp(`\\b${RECORD}s?\\b`, 'i').test(name) && /\b(?:on|in|for|of)\b/i.test(name)) return false;
  return isLabel(name) || (/^\p{Lu}/u.test(name) && !w.slice(1).some((x) => /^(?:on|in|into|from|for|to|with|by|of|at|and|or)$/i.test(x))) || (w.length <= 2 && !w.some((x) => /^(?:on|in|into|from|for|to|with|by|of|at|and|or)$/i.test(x)));
}

const GENERIC: StepRule[] = [
  {
    name: 'delete a record',
    pattern: new RegExp(`^(?:delete|remove|archive|trash) (?:a|an|any|the|one|some|this|that|\\d+) (?:[\\w-]+ )?${RECORD}s?\\b(.*)$`, 'i'),
    run: async (t, m, clause) => {
      guard(t, 'delete', clause);
      const row = t.ui.main.locator(ROWS).filter({ hasText: new RegExp(`\\b${config.fixturePrefix}\\b`) }).filter({ visible: true }).first();
      if (!(await row.count())) throw new Missing(`a '${config.fixturePrefix} …' record in the list`);
      const verb = clause.match(/^\w+/)![0];
      if (!(await clickInRow(t, row, verb))) throw new Missing(`'${verb}' on the test record`);
      return acceptConfirmation(t, verb);
    },
  },
  {
    name: 'click a button on a record',
    // "Click Edit on any product", "Click 'Collect Due' on the first customer", "Click Adjust Stock on a pending order".
    pattern: when(new RegExp(`^(?:click|tap|press|use)(?: on)? (?:the )?(.+?)(?: (?:button|icon|link|action|option))? (?:on|for|of|next to|in) (?:the )?(?:(a|an|any|one|first|last|same|test|some|[a-z]+) )?(?:\\w+ )?(${RECORD})(?: (?:in|from) the (?:list|table))?$`, 'i'), (m) => controlName(unq(m[1]))),
    run: async (t, m, clause) => {
      const name = unq(m[1]);
      const { row, name: record } = await recordRow(t, m[3], m[2] ?? '');
      // Products are the case's own test products; any other record must be named 'BTB …' for a delete or cancel.
      guard(t, name, `${clause} (${record})`);
      if (!(await clickInRow(t, row, name))) throw new Missing(`'${name}' on ${record}`);
      t.noted.set('__lastClick', name);
      await t.ui.settle();
      return `Clicked '${name}' on ${record}.`;
    },
  },
  {
    name: 'tick N records',
    // "Select 3 orders": ticks the first N rows (ticking changes nothing by itself).
    pattern: new RegExp(`^(?:select|tick|check) (?:the first )?(\\d+) (${RECORD})s?(?: (?:from|in) the (?:list|table))?$`, 'i'),
    run: async (t, m) => {
      await t.ui.settle();
      const boxes = t.ui.main.locator('tbody tr').locator('input[type=checkbox], [role=checkbox]').filter({ visible: true });
      const n = Number(m[1]);
      if ((await boxes.count()) < n) throw new Missing(`${n} ${m[2]}s with a checkbox in the list`);
      for (let i = 0; i < n; i++) await boxes.nth(i).check().catch(() => boxes.nth(i).click());
      return `Ticked ${n} ${m[2]}s.`;
    },
  },
  {
    name: 'open a record',
    // "Open any pending order", "Open an order", "Select a product" (ticks it when the row has a checkbox).
    pattern: new RegExp(`^(open|view|click(?: on)?|select) (?:a|an|any|one|the first|the last|some)(?: ([a-z]+))? (${RECORD})(?: (?:from|in) the (?:list|table))?$`, 'i'),
    run: async (t, m) => {
      const { row, name } = await recordRow(t, m[3], m[2] ?? '');
      const box = row.locator('input[type=checkbox], [role=checkbox]').first();
      if (/^(?:select|pick|choose)/i.test(m[1]) && (await box.count())) {
        await box.check().catch(() => box.click());
        t.selection = [name];
        return `Ticked '${name}'.`;
      }
      const link = row.locator('a[href]').filter({ visible: true }).first();
      await ((await link.count()) ? link : row).click();
      await t.ui.settle();
      return `Opened '${name}' (${new URL(t.page.url()).pathname}).`;
    },
  },
  {
    name: 'click a button in a named place',
    // "Click Connect on SSLCommerz", "Click 'Edit' in the 'Shipping' card".
    pattern: when(/^(?:click|tap|press)(?: on)? (?:the )?(.+?)(?: (?:button|link|icon))? (?:on|in|for|inside|next to) (?:the )?(.+?)(?: (?:card|row|section|panel|box|integration|dialog|tile))?$/i, (m) => controlName(unq(m[1])) && isLabel(unq(m[2])) && !new RegExp(`^${RECORD}$`, 'i').test(unq(m[2]))),
    run: async (t, m, clause) => {
      guard(t, unq(m[1]), clause);
      return act(t, `CLICK ${qv(unq(m[1]))} IN ${qv(unq(m[2]))}`);
    },
  },
  {
    name: 'open tab',
    pattern: when(/^(?:open|click(?: on)?|go to|switch to|select|choose|check|view) (?:the )?(.+?) tab$/i, (m) => unq(m[1]).split(/\s+/).length <= 4 && !NOT_A_NAME.test(unq(m[1]))),
    run: async (t, m, text) => {
      // "Click On Hand tab": "On" may be part of the name, not "click on".
      const withOn = /^click on /i.test(text ?? '') ? `On ${unq(m[1])}` : '';
      const name = withOn && (await t.page.getByRole('tab', { name: new RegExp(`^\\s*${escapeRe(withOn)}`, 'i') }).or(t.ui.statusTab(withOn)).filter({ visible: true }).count()) ? withOn : unq(m[1]);
      const re = new RegExp(`^\\s*${escapeRe(name)}(?![\\p{L}])`, 'iu');
      const tab = t.ui.statusTab(name).or(t.page.getByRole('tab', { name: re })).filter({ visible: true }).first();
      if (await tab.count()) await tab.click();
      else await clickNamed(t, name);
      await t.ui.settle();
      t.state.tab = name;
      return `Opened the '${name}' tab.`;
    },
  },
  {
    name: 'open a named dropdown',
    // "Open the Status dropdown", "open the Bulk Actions menu" (a bare "open the dropdown" names nothing: no rule).
    pattern: when(/^(?:open|expand|click(?: on)?) (?:the )?(.+?) (?:dropdown|drop-down|menu|select|picker|list)$/i, (m) => controlName(unq(m[1])) && !/^(?:sidebar|side|left|main|navigation)$/i.test(unq(m[1]))),
    run: async (t, m, clause) => plainClick(t, unq(m[1]), clause),
  },
  {
    name: 'hover',
    pattern: when(/^(?:hover|mouse ?over|move the mouse over)(?: over| on)? (?:the )?(.+?)(?: (?:button|icon|label|link|badge|card))?$/i, (m) => controlName(unq(m[1]))),
    run: async (t, m) => act(t, `HOVER ${qv(unq(m[1]))}`),
  },
  {
    name: 'select from dropdown',
    // "Select Pending from the Status dropdown", "choose 'kg' in the Unit field".
    pattern: when(/^(?:select|choose|pick) (?:the )?(?:option )?(.+?) (?:from|in) (?:the )?(.+?)(?: (?:dropdown|drop-down|list|menu|select|selector|field|filter|options|picker))?$/i, (m) => !/^(?:a|an|any|one|some|\d+)\b/i.test(unq(m[1])) && unq(m[2]).split(/\s+/).length <= 4 && unq(m[1]).split(/\s+/).length <= 6),
    run: async (t, m, clause) => {
      guard(t, unq(m[1]), clause);
      entered(t, unq(m[2]), unq(m[1]));
      return act(t, `SELECT ${qv(unq(m[1]))} IN ${qv(unq(m[2]))}`);
    },
  },
  {
    name: 'set a field to a value',
    // "select role Manager", "choose status 'Pending'", "Change the status to Delivered", "change invoice size to A5 & save".
    pattern: when(/^(?:(?:select|choose|pick|set) (?:the )?(role|status|type|category|brand|unit|courier|warehouse|size|payment method|method|gateway|zone|tax(?: rate)?|supplier|country|city|district|area|language|currency|theme|template|plan|channel|source) (?:as |to |= ?|: ?)?|(?:change|set|update|switch|make) (?:the )?(?!it\b|its\b|them\b|rows\b)([a-z][\w ]{1,30}?) (?:to|=|as) )(.+?)(\s*(?:&|and|,)\s*(?:click )?save)?$/i, (m) => unq(m[3]).length <= 40 && !/^(?:inactive|active)$/i.test(unq(m[3])) || !!m[1]),
    run: async (t, m, clause) => {
      const label = (m[1] ?? m[2]).trim();
      const value = unq(m[3]);
      guard(t, value, clause);
      const said = await setField(t, label, value);
      if (!m[4]) return said;
      await plainClick(t, (await t.page.getByRole('button', { name: /^\s*save changes\s*$/i }).filter({ visible: true }).count()) ? 'Save changes' : 'Save', clause);
      return `${said} Saved.`;
    },
  },
  {
    name: 'type into a named field',
    // "Enter category name "Winter Collection"", "Enter code SAVE10", "Enter phone number 01712345678", "note "Test"".
    pattern: when(/^(?:(?:enter|type|input|fill in|put|write|set|add)\s+(?:the\s+|a\s+|an\s+)?([a-z][\w ]{1,30}?)\s*(?:as|=|:|to)?\s*|(note|remarks?|comment|description)\s*[:=]?\s*)(?:(['"‘“])(.+)['"’”]|([\w-]*\d[\w-]*|[A-Z]{2,}))$/i, (m) => !/^(?:value|number|amount|price|quantity|discount|search(?: box)?)$/i.test((m[1] ?? '').trim()) && (!!m[4] || /\d|^[A-Z]{2,}$/.test(m[5] ?? ''))),
    run: async (t, m) => {
      const label = (m[1] ?? m[2]).trim();
      const value = m[4] ?? m[5];
      const field = await namedField(t, label);
      await field.fill(value);
      entered(t, label, value);
      return `Typed '${value}' in '${label}'.`;
    },
  },
  {
    name: 'fill named fields with test data',
    // "Fill in name, phone and address", "Enter phone number", "Enter the customer's email".
    pattern: /^(?:fill(?: in| up| out)?|enter|type|input|add|provide|give) (?:the |a |an |valid |customer'?s? |your |their )*((?:full name|name|phone(?: number)?|mobile(?: number)?|address|email(?: address)?|title|description|code)(?:\s*(?:,|and|&)\s*(?:the |a |an )?(?:full name|name|phone(?: number)?|mobile(?: number)?|address|email(?: address)?|title|description|code))*)$/i,
    run: async (t, m) => {
      const done: string[] = [];
      for (const f of listItems(m[1].replace(/&/g, ','))) {
        const value = testValue(t, f);
        await (await namedField(t, f)).fill(value);
        entered(t, f, value);
        done.push(`${f} = ${value}`);
      }
      return `Filled ${done.join('; ')}.`;
    },
  },
  {
    name: 'leave a field empty',
    pattern: /^leave (?:the )?(.+?)(?: field| box| input)? (?:empty|blank)$/i,
    run: async (t, m) => {
      await (await namedField(t, unq(m[1]))).fill('');
      return `Left '${unq(m[1])}' empty.`;
    },
  },
  {
    name: 'change quantity by',
    // In an Adjust stock dialog: "Increase quantity by 10" → Stock in, 10.
    pattern: /^(increase|decrease|reduce|raise|lower) (?:the )?(?:quantity|qty|stock|on hand) by (\d+)$/i,
    run: async (t, m) => {
      const scope = (await t.ui.dialog().count()) ? t.ui.dialog() : t.ui.main;
      const kind = /increase|raise/i.test(m[1]) ? /stock in|add|increase|\bin\b/i : /stock out|remove|decrease|reduce|\bout\b/i;
      const choice = scope.getByRole('radio', { name: kind }).or(scope.getByRole('tab', { name: kind })).or(scope.getByRole('button', { name: kind })).filter({ visible: true }).first();
      if (await choice.count()) await choice.click();
      const qty = scope.getByLabel(/quantity|qty|amount|units/i).or(scope.getByPlaceholder(/quantity|qty|0/i)).or(scope.locator('input[type=number], input[inputmode=numeric], input[inputmode=decimal]')).filter({ visible: true }).first();
      if (!(await qty.count())) throw new Missing('a quantity field');
      await qty.fill(m[2]);
      entered(t, 'quantity', m[2]);
      return `${m[1]} by ${m[2]}: typed ${m[2]}${(await choice.count()) ? ` with '${(await choice.innerText().catch(() => '')).trim()}' chosen` : ''}.`;
    },
  },
  {
    name: 'upload a file',
    pattern: /^(?:upload|attach|add|choose) (?:an? |the |one )?(?:[\w-]+ ){0,2}(image|photo|picture|logo|banner|icon|thumbnail|file|pdf|csv)$/i,
    run: async (t, m, clause) => {
      const { makeFile } = await import('../fixtures/images.js');
      const file = await makeFile(t.page, path.join(t.runDir, 'uploads'), clause, Date.now() % 1000);
      const scope = (await t.ui.dialog().count()) ? t.ui.dialog() : t.page;
      const input = scope.locator('input[type=file]').first();
      if (!(await input.count())) throw new Missing(`a place to upload ${m[1]}`);
      await input.setInputFiles(file.path);
      await t.page.waitForTimeout(1200);
      return `Uploaded ${file.kind}.`;
    },
  },
  {
    name: 'search for',
    // "Search a phone number 01712345678", "search for 'Winter'", "Search SAVE10".
    pattern: when(/^search (?:for |by )?(?:a |an |the )?(?:product |order |customer |phone(?: number)? |number |sku |name |code |keyword |term )?(?:by )?(['"‘“].+['"’”]|[^\s]*\d[^\s]*|[A-Z][\w-]*(?: [A-Z][\w-]*){0,3})(?: in (?:the )?search(?: box| bar| field)?)?$/i, (m) => !!unq(m[1]) && !NOT_A_NAME.test(unq(m[1])) && (/^['"‘“]|\d/.test(m[1]) || /^\p{Lu}/u.test(m[1]))),
    run: async (t, m) => searchFor(t, unq(m[1])),
  },
  {
    name: 'filter by',
    // "filter low stock", "Filter orders by status Pending", "apply filter Status = 'Paid'".
    pattern: /^(?:apply (?:a |the )?filter|filter(?: (?:the )?(?:list|products|orders|customers|items|results|entries))?(?: by| on| for)?|show only) (?:(?:the )?([a-z][\w ]{1,20}?)\s*(?:=|:|is)\s*(.+?)|(?:status |stock )?(['"‘“]?(?:low stock|out of stock|in stock|active|inactive|draft|archived|pending|processing|confirmed|completed|delivered|returned|paid|unpaid|partially paid|due|overdue)['"’”]?))(?: (?:only|products|orders|items|entries))?$/i,
    run: async (t, m) => applyFilter(t, m[1]?.trim() ?? null, unq(m[2] ?? m[3])),
  },
  {
    name: 'export list',
    // "export orders csv", "Export the list", "Download the CSV".
    pattern: /^(?:export|download)(?: (?:all|the|this|orders|products|customers|list|data|report|results|page|entries|records|items|transactions))*(?: (?:as|to|in))?(?: (?:an? )?(csv|excel|xlsx|pdf))?(?: file)?$/i,
    run: async (t, m) => {
      const opener = t.ui.main.getByRole('button', { name: /^\s*(?:export|csv|download)/i }).filter({ visible: true }).first();
      if (!(await opener.count())) throw new Missing('an Export button on this page');
      const format = new RegExp(m[1] ?? 'csv', 'i');
      const download = t.page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
      await opener.click();
      await t.page.waitForTimeout(600);
      const item = t.page.getByRole('menuitem', { name: format }).or(t.page.getByRole('button', { name: format })).or(t.page.getByRole('option', { name: format })).filter({ visible: true }).first();
      if (await item.count()) await item.click();
      const file = await download;
      if (!file) throw new Missing('a file download after clicking Export');
      const saved = path.join(t.runDir, 'downloads', `${t.tc.id}-${file.suggestedFilename()}`);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      await file.saveAs(saved);
      t.lastDownload = saved;
      return `Downloaded ${path.basename(saved)} (${fs.statSync(saved).size} bytes).`;
    },
  },
  {
    name: 'toggle',
    // "Enable Cash on Delivery", "turn on the SMS toggle", "Disable 'Show stock'".
    pattern: when(/^(?:turn (on|off)|switch (on|off)|(enable|disable)|toggle) (?:the )?(.+?)(?: (?:toggle|switch|option|setting|checkbox|check ?box))?$/i, (m) => { const n = unq(m[4]); return n.split(/\s+/).length <= 5 && !NOT_A_NAME.test(n.split(/\s+/)[0]) && !/\b(?:internet|connection|wifi|network)\b/i.test(n); }),
    run: async (t, m, clause) => {
      const name = unq(m[4]);
      guard(t, name, clause);
      const on = (m[1] ?? m[2] ?? m[3] ?? '').toLowerCase();
      if (!on) {
        const sw = t.page.getByRole('switch', { name: new RegExp(escapeRe(name), 'i') }).or(t.page.getByRole('checkbox', { name: new RegExp(escapeRe(name), 'i') })).filter({ visible: true }).first();
        if (!(await sw.count())) throw new Missing(`a '${name}' switch`);
        await sw.click();
        return `Toggled '${name}'.`;
      }
      return act(t, `TURN ${/on|enable/.test(on) ? 'ON' : 'OFF'} ${qv(name)}`);
    },
  },
  {
    name: 'complete the sale',
    // On POS: "Complete sale" / "Place order" are its own buttons (a real test order, as "Click Place Order").
    pattern: /^(?:complete|finish) (?:the )?(sale)$|^place (?:the |an |a )?order$/i,
    run: async (t, m, clause) => plainClick(t, m[1] ? 'Complete sale' : 'Place order', clause),
  },
  {
    name: 'choose a named option',
    // "Select Cash In", "choose Steadfast", "Choose Delete" (after opening a menu).
    pattern: when(/^(?:select|choose|pick|tick)\s+(?:the\s+)?(['"‘“]?[\p{Lu}\d].*?['"’”]?)(?:\s+(?:option|radio|item|type|method|courier))?$/iu, (m) => isLabel(unq(m[1]))),
    run: async (t, m, clause) => {
      const name = unq(m[1]);
      guard(t, name, clause);
      const choice = t.page.getByRole('menuitem', { name: exactText(name) }).or(t.page.getByRole('option', { name: exactText(name) })).or(t.page.getByRole('radio', { name: exactText(name) })).filter({ visible: true }).first();
      if (await choice.count()) {
        await choice.click();
        await t.ui.settle();
        return acceptConfirmation(t, name);
      }
      return plainClick(t, name, clause);
    },
  },
];

/** Tried after the regular rules: plain wording the regular rules don't cover. */
const LAST: StepRule[] = [
  {
    name: 'open page by name',
    pattern: new RegExp(`^(?:go to|open|visit|navigate to|switch to)\\s+(?:the\\s+)?(?:dashboard\\s*>\\s*)?(${PAGE_NAMES})(?:\\s+(?:page|screen|section))?(?:\\s+(?:from|in|on) the (?:left )?(?:sidebar|menu))?\\s*$`, 'i'),
    run: async (t, m) => {
      const path = pagePath(m[1]) ?? (await sidebarPath(t, m[1]));
      if (!path) throw new Missing(`a page named '${m[1]}'`, nearPages(m[1]));
      await openPage(t, path);
      return `Opened ${path}.`;
    },
  },
  {
    name: 'select a different sort',
    pattern: /^(?:select|choose|pick|apply)\s+(?:a\s+|another\s+)?(?:different|other|new|another)?\s*sort(?:ing)?(?:\s+(?:rule|option|order|method))?\b.*$/i,
    run: async (t) => sortDifferently(t),
  },
];

/** Plain clicks and looking: after the generic rules, so "click Edit on any product" is read as a row action first. */
const PLAIN: StepRule[] = [
  {
    name: 'click (plain wording)',
    pattern: new RegExp(`^(?:(?:in|on|inside|within)\\s+(?:the\\s+)?[\\w\\s/-]+?,?\\s+)?(?:click|tap|press|hit|select)\\s+(?:on\\s+)?(?:the\\s+)?([^'"]+?)\\s+${NOUN}(?:\\s+(?:to|in order to|at|on|from|in|of|that|which)\\b.*)?$`, 'i'),
    run: async (t, m, clause) => plainClick(t, m[1], clause),
  },
  {
    name: 'click (plain wording)',
    // "Click Place Order", "click Place Order", "click on variants": a name read on screen, not a sentence ("click it again").
    pattern: when(/^(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?["“]?([^'"‘’“”]{1,40}?)["”]?(?:\s+(?:to|in order to|so that)\b.*)?$/i, (m) => controlName(m[1])),
    run: async (t, m, clause) => plainClick(t, m[1], clause),
  },
  {
    name: 'observe',
    // Only looking at something already on screen. "Check the log after deleting a product" or "find X and open it" do
    // something first, and "verify …" is a claim: no rule, so live AI help reads them.
    pattern: /^(?!.*\b(?:after|before|while|once|when)\s+\w+ing\b)(?!.*\b(?:and|then)\s+(?:click|open|select|enter|type|save|delete|add|change|create|go)\b)(?:view|observe|locate|look(?: at)?|see|notice|watch|inspect|examine|find|note)\b.*$/i,
    run: async (t) => {
      if (await t.ui.dialog().count()) await t.shot('observe');
      return undefined;
    },
  },
];

const ORDER_BUTTONS = /^(place order|complete sale|confirm order|create order|submit order)$/i;

async function plainClick(t: CaseContext, raw: string, clause = raw): Promise<string | void> {
  const name = raw.replace(/^(?:the|a|an)\s+/i, '').trim();
  guard(t, name, clause);
  t.noted.set('__lastClick', name);
  const toastsBefore = t.toasts.length;
  await clickNamed(t, name);
  await t.ui.settle();
  if (!ORDER_BUTTONS.test(name)) return;
  // Placing an order is real: wait for the app to finish, say so, and record what it answered.
  await t.page.waitForResponse((r) => r.request().method() === 'POST' && /\/orders\b|\/pos\b/.test(r.url()), { timeout: 20_000 })
    .then(async (r) => t.noted.set('__orderResponse', { status: r.status(), body: (await r.text().catch(() => '')).slice(0, 4000) }))
    .catch(() => undefined);
  await t.page.waitForTimeout(2500);
  await t.shot('after placing order');
  const said = [...t.toasts.slice(toastsBefore), ...(await messages(t))].join(' | ');
  const resp = t.noted.get('__orderResponse') as { status: number; body: string } | undefined;
  if (resp && resp.status >= 400) t.note(`Placing the order was refused (HTTP ${resp.status}): ${resp.body.slice(0, 160)}`);
  // The saved order is the "receipt": what the store really recorded.
  const order = (await t.api.recentOrders(5).catch(() => [])).find((o) => o.customer?.name === TEST_CUSTOMER.name && Date.parse(o.created_at) > Date.now() - 120_000);
  if (order) t.noted.set('__order', order);
  const ref = order?.reference ?? `${resp?.body ?? ''} ${said}`.match(/\b[A-Z][\w]*-\d{8,}\b/)?.[0];
  t.note(`The bot placed a real test order${ref ? ` (${ref})` : ''} for ${TEST_CUSTOMER.name}, as the steps asked.`);
  return `Clicked '${name}'.${order ? ` Saved order ${order.reference}: total ৳${order.total}, discount ৳${order.discount ?? '?'}.` : ref ? ` Order ${ref}.` : ' No new order was found afterwards.'}`;
}

/** All step rules, in the order they are tried. */
/** An upper-case step-language line (CLICK 'X' IN 'Y', SELECT … IN …): its exact action reads it, not plain wording. */
const STEP_LANGUAGE = /^(?:GO TO|CLICK|DOUBLE CLICK|TYPE|ENTER|FILL|CLEAR|SELECT|CHOOSE|PICK|TURN (?:ON|OFF)|CHECK|UNCHECK|TICK|UNTICK|PRESS|WAIT|UPLOAD|REMEMBER|RELOAD|REFRESH|GO BACK|HOVER|SCROLL TO)\b/;
const plainOnly = (rules: StepRule[]) => rules.map((r) => ({ ...r, pattern: when(r.pattern, (m) => !(STEP_LANGUAGE.test(m.input) && ACTION_RULES.some((a) => a.pattern.test(m.input)))) }));

export const ALL_STEP_RULES: StepRule[] = [...FORM_RULES, ...FIRST, ...STEP_RULES, ...LAST, ...plainOnly([...GENERIC, ...PLAIN])];
