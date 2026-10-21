import type { Locator } from 'playwright';
import type { CaseContext } from '../context.js';
import { pagePath, PAGE_NAMES } from '../pages.js';
import { escapeRe, Missing } from '../ui.js';
import { clickNamed, sidebarPath, STEP_RULES, type StepRule } from './steps.js';
import { money } from './text.js';
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
async function messages(t: CaseContext): Promise<string[]> {
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

const NOUN = '(?:action\\s+)?(?:button|field|link|tab|icon|option|toggle|checkbox|menu|box|input|area|control|card|item)';

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
    pattern: /^add (?:a|an|any|one|the|some|1)?\s*(?:product|item)s?\b(?:\s+to (?:the )?(?:cart|order|sale|basket))?(?:\s*\((?:e\.?g\.?|eg|for example|like|such as)[;:,.]?\s*(.+)\))?\s*$/i,
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

/** Tried after the regular rules: plain wording the regular rules don't cover. */
const LAST: StepRule[] = [
  {
    name: 'open page by name',
    pattern: new RegExp(`^(?:go to|open|visit|navigate to|switch to)\\s+(?:the\\s+)?(?:dashboard\\s*>\\s*)?(${PAGE_NAMES})(?:\\s+(?:page|screen|section))?(?:\\s+(?:from|in|on) the (?:left )?(?:sidebar|menu))?\\s*$`, 'i'),
    run: async (t, m) => {
      const path = pagePath(m[1]) ?? (await sidebarPath(t, m[1]));
      await openPage(t, path);
      return `Opened ${path}.`;
    },
  },
  {
    name: 'select a different sort',
    pattern: /^(?:select|choose|pick|apply)\s+(?:a\s+|another\s+)?(?:different|other|new|another)?\s*sort(?:ing)?(?:\s+(?:rule|option|order|method))?\b.*$/i,
    run: async (t) => sortDifferently(t),
  },
  {
    name: 'click (plain wording)',
    pattern: new RegExp(`^(?:(?:in|on|inside|within)\\s+(?:the\\s+)?[\\w\\s/-]+?,?\\s+)?(?:click|tap|press|hit|select)\\s+(?:on\\s+)?(?:the\\s+)?([^'"]+?)\\s+${NOUN}(?:\\s+(?:to|in order to|at|on|from|in|of|that|which)\\b.*)?$`, 'i'),
    run: async (t, m) => plainClick(t, m[1]),
  },
  {
    name: 'click (plain wording)',
    pattern: /^(?:click|tap|press)\s+(?:on\s+)?(?:the\s+)?"?([A-Z][^'"]{1,40}?)"?(?:\s+(?:to|in order to)\b.*)?$/,
    run: async (t, m) => plainClick(t, m[1]),
  },
  {
    name: 'observe',
    pattern: /^(?:view|observe|locate|look|see|notice|watch|inspect|verify|review|examine|find|note|check|scroll|hover)\b.*$/i,
    run: async (t) => {
      if (await t.ui.dialog().count()) await t.shot('observe');
      return undefined;
    },
  },
];

const ORDER_BUTTONS = /^(place order|complete sale|confirm order|create order|submit order)$/i;

async function plainClick(t: CaseContext, raw: string): Promise<string | void> {
  const name = raw.replace(/^(?:the|a|an)\s+/i, '').trim();
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
export const ALL_STEP_RULES: StepRule[] = [...FORM_RULES, ...FIRST, ...STEP_RULES, ...LAST];
