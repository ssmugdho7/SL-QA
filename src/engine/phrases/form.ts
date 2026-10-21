import type { CaseContext } from '../context.js';
import { Missing } from '../ui.js';
import {
  trackCreated, cleanupSaved, describeSave, dropdown, ensureForm, field, formLabel, KNOWN_FIELDS, onForm, openSection, options, pick, save, sectionName, setSwitch, SWITCHES,
} from '../apps/slshop/product-form.js';
import { DEFAULTS, formValues, invalidValues, quotedValues } from './form-data.js';
import type { StepRule } from './steps.js';
import { makeFile } from '../fixtures/images.js';
import { addToCart } from './natural.js';
import path from 'path';

/**
 * Step rules for the Add / Edit Product form. Every pattern names something only the form has (a field label,
 * a section, a switch, Save Product), so sentences about the product list never reach them.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIELD = KNOWN_FIELDS.filter((f) => !/^(?:name|price|stock|cost|discount|status|tax|label|description|warning|threshold|channels|visibility|active)$/.test(f))
  .sort((a, b) => b.length - a.length).map(esc).join('|');
const SECTION = ['the basics', 'basic info', 'description & labels', 'description and labels', 'pricing details', 'pricing', 'stock options', 'additional data', 'variations', 'photos', 'gallery', 'product type'].map(esc).join('|');
const SWITCH = Object.keys(SWITCHES).sort((a, b) => b.length - a.length).map((k) => esc(k).replace(/ /g, '\\s+')).join('|');

/** Product names get the case prefix so cleanup can find them; the report shows the name as the sheet wrote it. */
function productName(t: CaseContext, name: string): string {
  return name.startsWith(t.prefix) ? name : `${t.prefix} ${name}`.slice(0, 250);
}

async function typeInto(t: CaseContext, label: string, value: string): Promise<string> {
  const f = await field(t, label);
  const real = formLabel(label) === 'Product Name' && value.trim() && !/^\s+$/.test(value) ? productName(t, value) : value;
  await f.fill('');
  if (real) await f.pressSequentially(real, { delay: real.length > 80 ? 0 : 15 });
  await t.page.waitForTimeout(200);
  const kept = await f.inputValue().catch(() => '');
  const note = kept !== real ? ` (the field shows "${kept.slice(0, 60)}")` : '';
  t.noted.set(`__typed:${formLabel(label)}`, { typed: real, kept });
  return `${formLabel(label)} = "${real.length > 60 ? `${real.slice(0, 57)}…` : real}"${note}`;
}

function valueFor(t: CaseContext, label: string): string {
  const want = formLabel(label);
  const data = formValues(t.tc.testData);
  return data[want] ?? DEFAULTS[want] ?? '';
}

/** "Selling Price 100 and Cost Price 150" → [[Selling Price, 100], [Cost Price, 150]]. */
function pairs(text: string): [string, string][] {
  const re = new RegExp(`(${FIELD}|name|price|stock|cost|discount|warning|min(?: qty)?|max(?: qty)?|per product price|fee)\\s*(?:=|:|to)?\\s*('[^']*'|-?৳?\\d[\\d,.]*)`, 'gi');
  return [...text.matchAll(re)].map((m) => [m[1], m[2].replace(/^'(.*)'$/, '$1').replace(/^৳/, '').replace(/[,.]+$/, '')]);
}

async function wholesale(t: CaseContext, label: string, value: string): Promise<string> {
  const map: Record<string, string> = { 'min': 'Min Qty', 'min qty': 'Min Qty', 'max': 'Max Qty', 'max qty': 'Max Qty', 'per product price': 'Per Product Price' };
  const aria = map[label.toLowerCase()] ?? label;
  const box = t.page.locator(`main input[aria-label="${aria}" i]`).first();
  if (!(await box.count())) {
    await setSwitch(t, 'wholesale program', true);
    await t.page.waitForTimeout(400);
  }
  const target = t.page.locator(`main input[aria-label="${aria}" i]`).last();
  if (!(await target.count())) throw new Missing(`'${aria}' in Wholesale Pricing`);
  await target.fill('');
  await target.pressSequentially(value, { delay: 10 });
  return `${aria} = ${value}`;
}

async function enterPairs(t: CaseContext, text: string): Promise<string> {
  await ensureForm(t);
  cleanupSaved(t);
  const done: string[] = [];
  for (const [label, value] of pairs(text)) {
    if (/^(min|max|per product price)/i.test(label)) done.push(await wholesale(t, label, value));
    else done.push(await typeInto(t, /^price$/i.test(label) ? 'Selling Price' : label, value));
  }
  // "Profit per unit" updates as prices are typed; remember what it showed right after.
  const profit = (await t.page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').match(/Profit per unit\s*(\S+(?:\s*·\s*[^A-Z]+?margin)?)/)?.[1];
  if (profit && /\d/.test(profit)) t.noted.set('__profitSeen', profit);
  return `${done.join('; ')}.`;
}

async function doSave(t: CaseContext, opts: { twice?: boolean; button?: string; keepEmpty?: boolean } = {}): Promise<string> {
  cleanupSaved(t);
  if (!onForm(t)) return 'No product form is open; nothing to save.';
  // A step that does not mention the name still needs one, or every save fails with "Product name is required"
  // and the thing the step is testing is never reached. Steps that test empty fields pass keepEmpty.
  if (!opts.keepEmpty) {
    const name = await field(t, 'Product Name').catch(() => null);
    if (name && !(await name.inputValue()).trim() && !t.noted.get('__typed:Product Name')) await typeInto(t, 'Product Name', 'Item');
    const price = await field(t, 'Selling Price').catch(() => null);
    const variable = (await variationRows(t)).length > 0;
    if (price && !variable && !(await price.inputValue()).trim() && !t.noted.get('__typed:Selling Price')) await typeInto(t, 'Selling Price', '100');
    // A product the case will sell in POS needs stock, or its card shows "Out of stock".
    if (!variable && /\bpos\b|\bsell\b/i.test(t.tc.steps.join(' ')) && !t.noted.get('__typed:Opening Stock')) {
      const stock = await field(t, 'Opening Stock').catch(() => null);
      if (stock && !Number(await stock.inputValue())) await typeInto(t, 'Opening Stock', /add\s+(\d+)\s+units/i.exec(t.tc.steps.join(' '))?.[1] ? String(Number(/add\s+(\d+)\s+units/i.exec(t.tc.steps.join(' '))![1]) + 10) : '20');
    }
  }
  const r = await save(t, opts.button, opts);
  await t.shot(r.saved ? 'saved' : 'not saved');
  return describeSave(r);
}

/** Opens a fresh Add Product form for "Create another product …" and other second-product steps. */
async function freshForm(t: CaseContext): Promise<void> {
  // Reload the page itself: an unsaved form would otherwise keep its state (or ask to leave).
  if (onForm(t) && /\/new$/.test(new URL(t.page.url()).pathname)) {
    await t.page.reload({ waitUntil: 'networkidle' }).catch(() => undefined);
    const stay = t.ui.dialog();
    if (await stay.count()) await stay.getByRole('button', { name: /leave|discard|continue/i }).first().click().catch(() => undefined);
  } else await t.ui.goto('/dashboard/products/new', { waitForList: false });
  await t.page.getByRole('button', { name: /^\s*Save Product\s*$/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
}

const SAVE_WORDS = '(?:click\\s+)?(?:\'save product\'|save product|save|\'save\')';
const AND_SAVE = `(?:,?\\s*(?:and|then)\\s+${SAVE_WORDS}(?:\\s+again)?)?`;

const RULES: StepRule[] = [
  {
    name: 'form: open section',
    pattern: new RegExp(`^(?:open|expand|go to|click)\\s+(?:the\\s+)?'?(${SECTION})'?(?:\\s+section)?$`, 'i'),
    run: async (t, m) => {
      await ensureForm(t);
      const s = await openSection(t, m[1]);
      return s.toLowerCase() !== m[1].toLowerCase() ? `'${m[1]}' is called '${s}' on today's form; opened it.` : undefined;
    },
  },
  {
    name: 'form: open dropdown',
    pattern: /^(?:open|click)\s+(?:the\s+)?'?(category|brand|unit|tax rate|labels?)'?\s+(?:dropdown|list|menu)$/i,
    run: async (t, m) => {
      await ensureForm(t);
      const list = await options(t, m[1]);
      t.noted.set(`__options:${formLabel(m[1])}`, list);
      (await dropdown(t, m[1])).click();
      await t.page.waitForTimeout(300);
      return `${formLabel(m[1])} options: ${list.join(', ')}.`;
    },
  },
  {
    name: 'form: type field from test data',
    pattern: new RegExp(`^(?:type|enter|fill(?:\\s+in)?)\\s+(?:the|a|an)?\\s*(?:valid\\s+|product\\s+)?(product name|name|${FIELD})(?:\\s+'([^']*)')?${AND_SAVE}$`, 'i'),
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const v = m[2] ?? (valueFor(t, m[1]) || DEFAULTS[formLabel(m[1])] || sample(t, formLabel(m[1])));
      const out = ['Category', 'Brand', 'Unit', 'Tax Rate', 'Labels', 'Default Supplier', 'Default Warehouse'].includes(formLabel(m[1]))
        ? await pick(t, m[1], v, { create: true })
        : await typeInto(t, m[1], v);
      return /save/i.test(m[0].slice(m[1].length + 5)) ? `${out}. ${await doSave(t)}` : `${out}.`;
    },
  },
  {
    name: 'form: price and save',
    pattern: /^(?:enter|type)\s+(?:a\s+)?(?:very\s+large\s+)?price\s*\(?\s*(-?\d[\d.,]*)\)?(?:\s+and\s+save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      await freshForm(t);
      await typeInto(t, 'Product Name', `Price ${m[1]}`);
      const out = await typeInto(t, 'Selling Price', m[1]);
      const r = await save(t);
      t.noted.set(`__price:${m[1]}`, r);
      const msg = `${out}. ${describeSave(r)}`;
      if (r.saved) await freshForm(t);
      return msg;
    },
  },
  {
    name: 'form: enter values',
    pattern: new RegExp(`^(?:enter|type|set|fill)\\s+(?:in\\s+)?(?:(?:${FIELD}|price|stock|cost|discount|min(?:\\s+qty)?|max(?:\\s+qty)?)\\s*(?:=|:)?\\s*-?৳?\\d[\\d,.]*(?:\\s*(?:,|and)\\s*)?)+(?:\\s+and\\s+(?:per product price|max(?:\\s+qty)?)\\s+\\d+)?${AND_SAVE}$`, 'i'),
    run: async (t, m) => {
      const out = await enterPairs(t, m[0]);
      return /\bsave\b/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: enter values',
    pattern: /^(?:enter|type)\s+(min(?:\s+qty)?|max(?:\s+qty)?|per product price)\s+-?\d+(?:\s*,?\s*(?:and\s+)?(?:max(?:\s+qty)?|per product price)\s+-?\d+)*(?:,?\s*(?:and|then)\s+save)?$/i,
    run: async (t, m) => {
      const out = await enterPairs(t, m[0]);
      return /\bsave\b/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: fill name and price',
    pattern: /^(?:fill(?:\s+in)?|enter)\s+(?:the\s+)?(?:name\s+and\s+price|required\s+fields|the\s+form|the\s+basics(?::.*)?)(?:,?\s*(?:and|then)\s+save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const data = formValues(t.tc.testData);
      const wanted = /basics:/i.test(m[0])
        ? m[0].replace(/^.*?basics:\s*/i, '').split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => formLabel(x.trim())).filter((x) => !/upload|image/i.test(x))
        : /the form/i.test(m[0]) ? ['Product Name', 'Selling Price', 'Cost Price', 'Opening Stock'] : ['Product Name', 'Selling Price'];
      const done: string[] = [];
      for (const label of wanted) {
        const v = data[label] ?? DEFAULTS[label];
        if (!v) continue;
        if (['Category', 'Brand', 'Unit', 'Tax Rate', 'Labels'].includes(label)) done.push(await pick(t, label, v, { create: true }).catch((e) => `${label}: ${(e as Error).message.split('\n')[0]}`));
        else done.push(await typeInto(t, label, v));
      }
      const out = done.join('; ');
      return /save/i.test(m[0]) ? `${out}. ${await doSave(t)}` : `${out}.`;
    },
  },
  {
    name: 'form: wholesale tiers',
    pattern: /^add\s+two\s+tiers\s+(\d+)\s*[–-]\s*(\d+)\s+and\s+(\d+)\s*[–-]\s*(\d+)(?:\s+and\s+save)?$|^leave\s+per\s+product\s+price\s+empty(?:\s+and\s+save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      await setSwitch(t, 'wholesale program', true);
      const add = t.page.getByRole('button', { name: /add wholesale price/i }).first();
      const box = (label: string) => t.page.locator(`main input[aria-label="${label}" i]`);
      if (m[1]) {
        if ((await box('Min Qty').count()) < 2) await add.click();
        await t.page.waitForTimeout(300);
        const vals = [[m[1], m[2]], [m[3], m[4]]];
        for (const [i, [min, max]] of vals.entries()) {
          await box('Min Qty').nth(i).fill(min);
          await box('Max Qty').nth(i).fill(max);
          await box('Per Product Price').nth(i).fill('90');
        }
      } else {
        await box('Min Qty').first().fill('10');
        await box('Per Product Price').first().fill('');
      }
      if (!(await (await field(t, 'Product Name')).inputValue())) await typeInto(t, 'Product Name', 'Wholesale item');
      if (!(await (await field(t, 'Selling Price')).inputValue())) await typeInto(t, 'Selling Price', '100');
      return /save/i.test(m[0]) ? doSave(t) : 'Tiers entered.';
    },
  },
  {
    name: 'form: leave fields empty',
    pattern: /^leave\s+(?:the\s+)?(.+?)\s+empty(?:,?\s*(?:and|then)\s+(?:click\s+)?'?save(?: product)?'?)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      for (const label of m[1].split(/\s*,\s*|\s+and\s+/)) {
        const f = await field(t, label);
        await f.fill('');
      }
      return /save/i.test(m[0]) ? `Left ${m[1]} empty. ${await doSave(t, { keepEmpty: true })}` : `Left ${m[1]} empty.`;
    },
  },
  {
    name: 'form: type only spaces',
    pattern: /^type\s+only\s+spaces\s+in\s+(?:the\s+)?(.+?)(?:\s+and\s+(?:click\s+)?'?save(?: product)?'?(?:\s+again)?)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const out = await typeInto(t, m[1], '   ');
      return /save/i.test(m[0]) ? `${out}. ${await doSave(t, { keepEmpty: true })}` : `${out}.`;
    },
  },
  {
    name: 'form: each invalid value',
    pattern: /^enter\s+each\s+invalid\s+value\s+one\s+by\s+one\s+in\s+(.+)$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const labels = m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
      const values = invalidValues(t.tc.testData);
      if (!values.length) return t.block('Test Data lists no invalid values to try.');
      const results: { field: string; value: string; kept: string; saved: boolean; why: string }[] = [];
      for (const label of labels) {
        for (const value of values) {
          if (!onForm(t)) await freshForm(t);
          await typeInto(t, 'Product Name', valueFor(t, 'Product Name') || 'Invalid value check');
          if (formLabel(label) !== 'Selling Price') await typeInto(t, 'Selling Price', '100');
          const f = await field(t, label);
          await f.fill('');
          await f.pressSequentially(value, { delay: 15 });
          const kept = await f.inputValue().catch(() => '');
          const r = await save(t);
          results.push({ field: formLabel(label), value, kept, saved: r.saved, why: [...r.messages, ...r.invalid].join(' | ') });
          if (r.saved) await freshForm(t);
        }
      }
      t.noted.set('__invalidTries', results);
      await t.shot('invalid values');
      const saved = results.filter((r) => r.saved);
      return `Tried ${values.length} values in ${labels.length} fields: ${saved.length ? `${saved.length} were saved (${saved.slice(0, 4).map((r) => `${r.field} "${r.value}" kept as "${r.kept}"`).join(', ')})` : 'none were saved'}.`;
    },
  },
  {
    name: 'form: save after each',
    pattern: /^click\s+'?save product'?\s+after\s+each$/i,
    run: async () => 'Done in the previous step (saved after each value).',
  },
  {
    name: 'form: long name',
    pattern: /^(?:enter|type)\s+an?\s+(\d+)-character\s+name(?:\s+and\s+save)?(?:;?\s*then\s+try\s+(\d+)(?:\s+characters)?)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const out: string[] = [];
      for (const n of [Number(m[1]), m[2] ? Number(m[2]) : 0].filter(Boolean)) {
        if (!onForm(t)) await freshForm(t);
        const name = `${t.prefix} ${'Long name '.repeat(40)}`.slice(0, n);
        const f = await field(t, 'Product Name');
        await f.fill(name);
        const kept = await f.inputValue();
        await typeInto(t, 'Selling Price', '100');
        const r = await save(t);
        t.noted.set(`__long:${n}`, { kept: kept.length, saved: r.saved, why: [...r.messages, ...r.invalid].join(' | ') });
        out.push(`${n} characters: field kept ${kept.length}, ${describeSave(r)}`);
        if (r.saved) await freshForm(t);
      }
      return out.join(' ');
    },
  },
  {
    name: 'form: try characters',
    pattern: /^try\s+(?:typing\s+)?(\d+)\s+characters$/i,
    run: async (t, m) => {
      const last = (t.noted.get('__lengthField') as string | undefined) ?? 'Product Name';
      return typeLength(t, last, Number(m[1]));
    },
  },
  {
    name: 'form: type in field and watch counter',
    pattern: /^type\s+in\s+(meta title|meta description|short description)(?:\s+and\s+(?:watch\s+the\s+counter|try\s+(\d+)\s+characters))?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      t.noted.set('__lengthField', formLabel(m[1]));
      return typeLength(t, m[1], m[2] ? Number(m[2]) : 10);
    },
  },
  {
    name: 'form: special name',
    pattern: /^(?:enter|create\s+(?:another\s+)?(?:a\s+)?product\s+with)\s+an?\s+(bangla name with an emoji|script tag as the name)(?:\s+and\s+save)?$/i,
    run: async (t, m) => {
      if (/another/i.test(m[0]) || !onForm(t)) await freshForm(t);
      cleanupSaved(t);
      const values = quotedValues(t.tc.testData);
      const v = /bangla/i.test(m[1]) ? values.find((x) => /[\u0980-\u09FF]/.test(x)) ?? 'ঝোলা খেজুরের গুড় 🍯' : values.find((x) => /</.test(x)) ?? '<img src=x onerror=alert(1)>';
      const out = await typeInto(t, 'Product Name', v);
      await typeInto(t, 'Selling Price', '100');
      const r = await save(t);
      t.noted.set(/bangla/i.test(m[1]) ? '__bangla' : '__script', { typed: productName(t, v), save: r });
      return `${out}. ${describeSave(r)}`;
    },
  },
  {
    name: 'form: existing name',
    pattern: /^enter\s+a\s+name\s+that\s+already\s+exists.*$/i,
    run: async (t) => {
      await ensureForm(t);
      cleanupSaved(t);
      const base = formValues(t.tc.testData)['Product Name'] ?? 'Duplicate';
      // A real product with that name is never touched: the bot makes its own "existing" one first.
      const first = await t.fixtureProduct(base, { price: 100 });
      t.noted.set('__existing', first);
      await typeInto(t, 'Product Name', base);
      await typeInto(t, 'Selling Price', '100');
      return `Created '${first.name}' (link /product/${(first as unknown as { slug?: string }).slug ?? '?'}) first, then typed the same name.`;
    },
  },
  {
    name: 'form: choose type',
    pattern: /^(?:click\s+'variations'\s+and\s+)?(?:choose|select|click|switch\s+(?:from\s+'?(?:variable|simple)'?\s+)?to)\s+'?(variable|simple)'?(?:\s+but\s+do\s+not\s+add\s+any\s+variation(?:,?\s*then\s+save)?)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const before = (await variationRows(t)).length > 0;
      t.noted.set('__rowsBeforeSwitch', (await variationRows(t)).length);
      const dialogsBefore = t.dialogsFired;
      await t.page.getByRole('button', { name: new RegExp(`^\\s*${m[1]}\\b`, 'i') }).first().click();
      await t.page.waitForTimeout(800);
      const confirm = t.ui.dialog();
      const asked = t.dialogsFired > dialogsBefore || (await confirm.count()) > 0;
      if (await confirm.count()) {
        t.noted.set('__typeSwitchDialog', await t.ui.dialogText());
        // Confirm the switch the step asked for ("Remove & switch"), not "Keep variations".
        const go = confirm.getByRole('button', { name: /remove|switch|confirm|continue|yes/i }).filter({ hasNotText: /keep|cancel|close/i }).last();
        await (await go.count() ? go : confirm.getByRole('button').filter({ hasNotText: /^(Cancel|Close|Keep.*)$/i }).last()).click().catch(() => undefined);
        await t.page.waitForTimeout(600);
      }
      t.noted.set('__typeSwitch', { to: m[1], hadVariations: before, asked });
      const out = `Chose '${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}'.${before ? asked ? ' A confirmation was shown.' : ' No confirmation was shown before removing the variations.' : ''}`;
      if (/save/i.test(m[0]) && !(await (await field(t, 'Product Name')).inputValue())) await typeInto(t, 'Product Name', 'No variations');
      return /save/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: price mode',
    pattern: /^choose\s+'(one price for all|price per variation)'(?:\s+and\s+enter\s+(?:one\s+selling\s+price|price,\s*sku\s+and\s+stock\s+for\s+each\s+row))?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      await t.page.getByRole('button', { name: new RegExp(`^\\s*${m[1]}`, 'i') }).first().click();
      await t.page.waitForTimeout(500);
      if (/one selling price/i.test(m[0])) return `Chose '${m[1]}'. ${await typeInto(t, 'Selling Price', valueFor(t, 'Selling Price') || '150')}.`;
      if (/each row/i.test(m[0])) return `Chose '${m[1]}'. ${await fillVariationRows(t)}`;
      return `Chose '${m[1]}'.`;
    },
  },
  {
    name: 'form: attribute values',
    pattern: /^(?:click\s+'choose attribute',\s*choose\s+'([^']+)'\s+and\s+pick\s+(.+)|choose\s+attribute\s+(.+)|create\s+(?:a\s+)?(\w+)?\s*variable\s+product\s+with\s+(.+?)(?:,?\s*leaving\s+skus?\s+blank)?|create\s+(\d+)\s+variations|create\s+variations\s+as\s+above)$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      if (!(await t.page.locator('main').innerText()).includes('Choose Attribute')) await t.page.getByRole('button', { name: /^\s*Variable\b/ }).first().click();
      await t.page.waitForTimeout(500);
      let groups: [string, string[]][] = [];
      if (m[1]) groups = [[m[1], m[2].split(/\s*,\s*|\s+and\s+/)]];
      else if (m[3]) groups = [...m[3].matchAll(/(\w+)\s*\(([^)]+)\)/g)].map((x) => [x[1], x[2].split(/\s*,\s*|\s+and\s+/)]);
      else if (m[5]) groups = [[m[4] ?? 'Weight', m[5].split(/\s*,\s*|\s+and\s+/)]];
      else {
        const n = Number(m[6] ?? 0) || 2;
        groups = n === 4 ? [['Color', ['Red', 'Blue']], ['Size', ['S', 'M']]] : [['Weight', ['50g', '100g', '125g', '250g'].slice(0, Math.min(n, 4))]];
      }
      const done: string[] = [];
      for (const [attr, values] of groups) done.push(await addAttribute(t, attr.trim(), values.map((v) => v.trim()).filter(Boolean)));
      if (!(await (await field(t, 'Product Name')).inputValue())) await typeInto(t, 'Product Name', 'Variable item');
      if (!(await (await field(t, 'Selling Price')).inputValue().catch(() => 'x'))) await typeInto(t, 'Selling Price', '100').catch(() => undefined);
      const rows = await variationRows(t);
      t.noted.set('__variations', rows);
      return `${done.join(' ')} ${rows.length} variation row${rows.length === 1 ? '' : 's'}: ${rows.map((r) => `${r.name} (SKU ${r.sku || '—'})`).join(', ')}.`;
    },
  },
  {
    name: 'form: set switch',
    pattern: new RegExp(`^(?:turn\\s+(on|off)|keep|set|try\\s+to\\s+turn\\s+on|open\\s+'?stock options'?\\s+and\\s+try\\s+to\\s+turn\\s+on)\\s+'?(${SWITCH})'?(?:\\s+(on|off|to\\s+(?:exclusive|inclusive|inactive|active)))?(?:\\s+and\\s+save)?$`, 'i'),
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const word = (m[1] ?? m[3] ?? '').toLowerCase();
      const on = /exclusive|inactive|off/.test(word) ? false : /inclusive|active|on/.test(word) ? true : !/^keep/i.test(m[0]) || true;
      const out = await setSwitch(t, m[2], on);
      return /and save$/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: set visibility',
    pattern: /^(?:fill\s+name\s+and\s+price,\s*)?set\s+visibility\s+to\s+(inactive|active)(?:\s+and\s+save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      if (/fill name/i.test(m[0])) {
        await typeInto(t, 'Product Name', valueFor(t, 'Product Name') || 'Hidden item');
        await typeInto(t, 'Selling Price', '100');
      }
      const out = await setSwitch(t, 'Active status', /^active$/i.test(m[1]));
      return /save/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: choose option',
    pattern: /^(?:in\s+additional\s+data,\s*)?choose\s+(?:a\s+)?(?:'([^']+)'|(tax rate))(?:,?\s*(?:fill\s+required\s+fields)?\s*(?:and\s+save)?)?$/i,
    run: async (t, m) => {
      if (!onForm(t)) return 'No product form is open.';
      const value = m[1];
      let out: string;
      if (m[2]) {
        const list = await options(t, 'Tax Rate');
        const real = list.find((o) => !/create new/i.test(o));
        out = real ? await pick(t, 'Tax Rate', real) : 'There is no tax rate to choose (the list only offers "Create new tax rate").';
        t.noted.set('__taxRates', list);
      } else {
        const open = t.page.getByRole('option').filter({ visible: true });
        if (await open.count()) {
          await t.page.getByRole('option', { name: new RegExp(`^\\s*${esc(value)}\\s*$`, 'i') }).first().click();
          out = `Chose '${value}'.`;
        } else out = await pick(t, 'Unit', value);
      }
      if (/fill required/i.test(m[0])) {
        await typeInto(t, 'Product Name', valueFor(t, 'Product Name') || `${value} item`);
        await typeInto(t, 'Selling Price', '100');
        await typeInto(t, 'Opening Stock', '5');
      }
      return /save/i.test(m[0]) ? `${out} ${await doSave(t)}` : out;
    },
  },
  {
    name: 'form: create inline',
    pattern: /^(?:(?:open\s+the\s+category\s+dropdown|in\s+[\w &]+,\s*open\s+(brand|labels?)),\s*)?click\s+'create new (category|brand|label)'\s+and\s+enter\s+(?:a|an existing)\s+name$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      const kind = m[2].toLowerCase();
      const data = formValues(t.tc.testData);
      const existing = /existing/i.test(m[0]);
      const label = kind === 'label' ? 'Labels' : kind[0].toUpperCase() + kind.slice(1);
      let name = data[label] ?? `${kind} ${t.tc.id}`;
      if (existing) {
        const list = (await options(t, label)).filter((o) => !/create new/i.test(o));
        name = list.find((o) => o.toLowerCase() === name.toLowerCase()) ?? list[0] ?? name;
      } else name = `${t.prefix} ${name}`;
      const before = (await options(t, label)).filter((o) => !/create new/i.test(o));
      const toasts = t.toasts.length;
      const btn = await dropdown(t, label);
      await btn.click();
      await t.page.waitForTimeout(400);
      await t.page.getByRole('option', { name: new RegExp(`create new ${kind}`, 'i') }).first().click();
      await t.page.waitForTimeout(600);
      const dlg = t.ui.dialog();
      await dlg.locator('input').first().fill(name);
      await dlg.getByRole('button', { name: /^\s*Create(?:\s+(?:label|brand|category))?\s*$/i }).last().click();
      await t.page.waitForTimeout(1500);
      const stillOpen = (await dlg.count()) > 0 && (await dlg.innerText().catch(() => '')).includes(name);
      const said = t.toasts.slice(toasts);
      if (stillOpen) await dlg.getByRole('button', { name: /^\s*Cancel\s*$/ }).click().catch(() => t.page.keyboard.press('Escape'));
      const after = (await options(t, label)).filter((o) => !/create new/i.test(o));
      const selected = (await (await dropdown(t, label)).innerText()).trim();
      const result = { kind, name, existing, before, after, selected, messages: said, dialogStayed: stillOpen };
      t.noted.set(`__created:${kind}`, result);
      if (!existing) trackCreated(t, kind, name);
      else if (after.filter((o) => o.toLowerCase() === name.toLowerCase()).length > before.filter((o) => o.toLowerCase() === name.toLowerCase()).length) {
        // The app made a second one with the same name: remove the copy, keep the original.
        t.onCleanup(async () => {
          if (kind === 'category') {
            const same = (await t.api.categories()).filter((x) => x.name.toLowerCase() === name.toLowerCase()).sort((a, b) => a.id - b.id);
            for (const c of same.slice(1).filter((c) => !c.products_count)) await t.api.deleteCategory(c.id);
          } else if (kind === 'brand') {
            const same = (await t.api.brands()).filter((x) => x.name.toLowerCase() === name.toLowerCase()).sort((a, b) => a.id - b.id);
            for (const b of same.slice(1)) await t.api.request('DELETE', `/catalog/brands/${b.id}`).catch(() => undefined);
          }
        });
      }
      return `${existing ? 'Tried to create an existing' : 'Created'} ${kind} '${name}': ${said.length ? `message "${said.join(' | ')}"` : 'no message'}; the list has ${after.filter((o) => o.toLowerCase() === name.toLowerCase()).length} '${name}'; selected: '${selected}'.`;
    },
  },
  {
    name: 'form: edit slug',
    pattern: /^click\s+'edit slug'\s+and\s+(?:change\s+it\s+to\s+'([^']+)'|enter\s+text\s+with\s+spaces\s+and\s+symbols)(?:;?\s*save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      cleanupSaved(t);
      if (!(await (await field(t, 'Product Name')).inputValue())) await typeInto(t, 'Product Name', valueFor(t, 'Product Name') || 'Slug item');
      if (!(await (await field(t, 'Selling Price')).inputValue())) await typeInto(t, 'Selling Price', '100');
      const slug = m[1] ?? quotedValues(t.tc.testData)[0] ?? 'my soap!!';
      return setSlug(t, slug, /save/i.test(m[0]));
    },
  },
  {
    name: 'form: duplicate slug',
    pattern: /^enter\s+a\s+slug\s+that\s+another\s+product\s+already\s+uses(?:;?\s*save)?$/i,
    run: async (t) => {
      if (!onForm(t)) await freshForm(t);
      const other = await t.fixtureProduct('Slug owner', { price: 100 });
      const slug = (other as unknown as { slug?: string }).slug ?? '';
      await typeInto(t, 'Product Name', 'Slug copy');
      await typeInto(t, 'Selling Price', '100');
      return `${await setSlug(t, slug, true)} (that slug belongs to '${other.name}').`;
    },
  },
  {
    name: 'form: look at storefront link',
    pattern: /^(?:type\s+the\s+name\s+'([^']+)'\s+and\s+)?look\s+at\s+'storefront link'$/i,
    run: async (t, m) => {
      await ensureForm(t);
      if (m[1]) await typeInto(t, 'Product Name', m[1]);
      const link = await storefrontLink(t);
      t.noted.set('__storefrontLink', link);
      return `Storefront link: ${link}`;
    },
  },
  {
    name: 'form: specification',
    pattern: /^(?:click\s+'add specification'\s+and\s+enter\s+'([^']+)'\s*=\s*'([^']+)'|add\s+one\s+empty\s+specification\s+row)$/i,
    run: async (t, m) => {
      await ensureForm(t);
      return addPair(t, 'Add specification', m[1] ?? '', m[2] ?? '');
    },
  },
  {
    name: 'form: question',
    pattern: /^click\s+'add question'\s+and\s+enter\s+a\s+question\s+and\s+answer$/i,
    run: async (t) => {
      await ensureForm(t);
      const q = t.tc.testData.match(/Q:\s*'([^']+)'/)?.[1] ?? 'Is it organic?';
      const a = t.tc.testData.match(/A:\s*'([^']+)'/)?.[1] ?? 'Yes';
      return addPair(t, 'Add question', q, a);
    },
  },
  {
    name: 'form: save',
    pattern: /^(?:click\s+)?'?(save product|save & add another|save)'?(?:\s+(?:the\s+product|again))?(?:\s+(twice\s+very\s+quickly))?(?:\s+and\s+open\s+(?:the\s+)?(?:storefront\s+link|product\s+on\s+the\s+storefront|storefront\s+page|'view variants'))?$/i,
    run: async (t, m) => {
      if (!onForm(t)) return undefined;
      let out = await doSave(t, { twice: !!m[2], button: /add another/i.test(m[1]) ? 'Save & add another' : 'Save Product' });
      const pending = t.noted.get('__stockAfterSave') as { id: number; qty: number } | undefined;
      if (pending) {
        t.noted.delete('__stockAfterSave');
        await t.api.adjustStock(pending.id, 'in', pending.qty).catch(() => undefined);
        out += ` Stock adjusted by +${pending.qty}.`;
      }
      if (/storefront/i.test(m[0])) return `${out} ${await openStorefront(t)}`;
      if (/view variants/i.test(m[0])) return `${out} ${await readVariants(t)}`;
      return out;
    },
  },
  {
    name: 'form: create another product',
    pattern: /^create\s+another\s+product(?:\s+with\s+sku\s+left\s+empty|\s+and\s+click\s+'draft')?$|^create\s+a\s+product\s+with\s+sku\s+'([^']+)'$/i,
    run: async (t, m) => {
      if (/another/i.test(m[0]) || !onForm(t)) await freshForm(t);
      cleanupSaved(t);
      await typeInto(t, 'Product Name', m[1] ? `SKU ${m[1]}` : /sku left empty/i.test(m[0]) ? 'Auto SKU' : 'Second item');
      await typeInto(t, 'Selling Price', '100');
      if (m[1]) await typeInto(t, 'SKU', m[1]);
      if (/draft/i.test(m[0])) {
        const draft = t.page.getByRole('button', { name: /^\s*(save as )?draft\s*$/i });
        if (!(await draft.count())) throw new Missing("a 'Draft' button", (await t.page.getByRole('button').filter({ visible: true }).allInnerTexts()).map((x) => x.trim()).filter((x) => /save|draft|publish/i.test(x)));
        await draft.first().click();
      }
      const r = await save(t);
      const key = m[1] ? '__skuCustom' : /sku left empty/i.test(m[0]) ? '__skuAuto' : '__second';
      t.noted.set(key, r);
      return describeSave(r);
    },
  },
  {
    name: 'form: change name and price',
    pattern: /^change\s+the\s+name\s+and\s+price$/i,
    run: async (t) => {
      if (!onForm(t)) return 'No product form is open.';
      const data = formValues(t.tc.testData);
      return `${await typeInto(t, 'Product Name', data['Product Name'] ?? 'Updated item')}; ${await typeInto(t, 'Selling Price', data['Selling Price'] ?? '130')}.`;
    },
  },
  {
    name: 'form: edit a test product',
    pattern: /^click\s+'edit'\s+on\s+(?:a\s+test\s+product|a\s+product(?:\s+\(e\.g\.\s+([^)]+)\))?)$/i,
    run: async (t, m) => {
      const named = m[1]?.trim();
      const real = named ? (await t.api.allProducts(`q=${encodeURIComponent(named)}`)).find((p) => p.name.toLowerCase() === named.toLowerCase()) : undefined;
      const product = real ?? (await t.fixtureProduct('Edit me', { price: 120, current_stock: 5 }));
      t.noted.set('__editing', product);
      await t.ui.goto(`/dashboard/products/detail/edit?id=${product.id}`, { waitForList: false });
      await t.page.getByRole('button', { name: /^\s*Save (?:Product|Changes)\s*$/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      // The saved values arrive a moment after the form appears.
      await t.page.waitForFunction((n) => [...document.querySelectorAll('main input')].some((i) => (i as HTMLInputElement).value === n), product.name, { timeout: 15_000 }).catch(() => undefined);
      // Record what the edit form shows, to compare with the saved product later.
      t.noted.set('__editForm', await t.page.evaluate(() => {
        const out: Record<string, string> = {};
        for (const l of document.querySelectorAll('main label')) {
          const label = (l as HTMLElement).innerText.replace(/\s*\*\s*$/, '').trim();
          let c: Element | null = l;
          let v = '';
          for (let i = 0; i < 4 && c && !v; i++) {
            c = c.nextElementSibling ?? c.parentElement?.nextElementSibling ?? null;
            const el = c?.matches?.('input,textarea,button[role=combobox]') ? c : c?.querySelector?.('input:not([type=checkbox]),textarea,button[role=combobox]');
            if (el) v = (el as HTMLInputElement).value ?? (el as HTMLElement).innerText;
          }
          if (label && !(label in out)) out[label] = (v ?? '').trim();
        }
        out.__text = (document.querySelector('main') as HTMLElement).innerText.replace(/\s+/g, ' ');
        out.__name = (document.querySelector('main input') as HTMLInputElement | null)?.value ?? '';
        return out;
      }));
      return `Opened the edit form of '${product.name}'${named && !real ? ` ('${named}' is not in this store, so a test product was used)` : ''}.`;
    },
  },
  {
    name: 'form: duplicate sku or barcode',
    pattern: /^enter\s+(?:an?\s+)?(existing\s+sku|existing\s+barcode|barcode\s+with\s+spaces\/symbols)(?:\s+and\s+save)?$/i,
    run: async (t, m) => {
      if (!onForm(t)) await freshForm(t);
      cleanupSaved(t);
      const data = formValues(t.tc.testData);
      let label = 'SKU';
      let value = data.SKU ?? '';
      if (/existing\s+sku/i.test(m[1])) {
        const owner = (await t.api.allProducts()).find((p) => p.sku && !p.name.startsWith('BTB')) ;
        value = (value && (await t.api.allProducts(`q=${encodeURIComponent(value)}`)).some((p) => p.sku === value)) ? value : owner?.sku ?? value;
      } else if (/existing\s+barcode/i.test(m[1])) {
        label = 'Barcode';
        const owner = await t.fixtureProduct('Barcode owner', { price: 100, barcode: `59${Date.now().toString().slice(-11)}` });
        value = (owner as unknown as { barcode?: string }).barcode ?? '';
      } else {
        label = 'Barcode';
        value = data.Barcode ?? 'ab c#';
      }
      await freshForm(t);
      await typeInto(t, 'Product Name', `${label} check`);
      await typeInto(t, 'Selling Price', '100');
      await typeInto(t, label, value);
      const r = await save(t);
      t.noted.set(`__dup:${m[1].toLowerCase().replace(/\W+/g, '-')}`, r);
      const out = `${label} = "${value}". ${describeSave(r)}`;
      if (r.saved) await freshForm(t);
      return out;
    },
  },
  {
    name: 'form: look at a value',
    pattern: /^(?:open\s+'?pricing details'?\s+and\s+)?look\s+at\s+'(profit per unit|storefront link)'$|^check\s+for\s+the\s+'unsaved'\s+badge$|^watch\s+the\s+counter$/i,
    run: async (t) => {
      if (!onForm(t)) return 'No product form is open.';
      const text = (await t.page.locator('main').innerText()).replace(/\s+/g, ' ');
      const profit = text.match(/Profit per unit\s*(\S+)(?:\s*·\s*([^A-Z]+?margin))?/)?.slice(1).filter(Boolean).join(' · ') ?? '';
      const unsaved = /Unsaved changes|Unsaved/.test(text);
      t.noted.set('__formLook', { profit, unsaved, text });
      await t.shot('form');
      return [profit && `Profit per unit: ${profit}`, unsaved ? "'Unsaved changes' badge is shown" : 'no Unsaved badge'].filter(Boolean).join('; ') + '.';
    },
  },
  {
    name: 'form: find saved product in the list',
    pattern: /^(?:go\s+back\s+to\s+the\s+products\s+page\s+and\s+)?search\s+(?:for\s+the\s+product|both\s+skus\s+on\s+the\s+products\s+page)$|^check\s+the\s+(?:stock\s+on\s+the\s+)?products\s+page(?:\s+\(sort\s+by\s+'recently updated'\))?$|^view\s+both\s+on\s+the\s+products\s+page$/i,
    run: async (t, m) => {
      await t.ui.goto('/dashboard/products');
      const saves = ((t.noted.get('__saves') as { saved: boolean; name: string | null }[] | undefined) ?? []).filter((r) => r.saved);
      const rows: string[] = [];
      for (const r of saves) {
        if (!r.name) continue;
        await t.ui.search(r.name.slice(0, 60));
        const snap = await t.ui.snapshot();
        const row = snap.rows.find((x) => x.name === r.name) ?? snap.rows[0];
        if (row) rows.push(`${row.name} | ${row.type} | ${row.price} | ${row.stock} | SKU ${row.sku} | ${row.active === false ? 'Inactive' : 'Active'}`);
      }
      t.noted.set('__listRows', rows);
      if (/recently updated/i.test(m[0])) {
        await t.ui.search('');
        await t.page.getByRole('button', { name: /^\s*sort\b/i }).first().click();
        await t.page.getByRole('menuitemradio', { name: /recently updated/i }).first().click();
        await t.ui.settle();
        t.noted.set('__recentFirst', (await t.ui.snapshot()).rows[0]?.name ?? '');
      }
      await t.shot('products list');
      return rows.length ? `Found: ${rows.join(' · ')}.` : 'No saved product to look for.';
    },
  },
  {
    name: 'form: open detail and storefront',
    pattern: /^(?:open|view)\s+(?:the\s+)?(?:product\s+)?detail\s+page\s+and\s+(?:the\s+)?storefront(?:\s+page)?$|^check\s+the\s+detail\s+page\s+and\s+storefront$|^open\s+the\s+(?:product\s+on\s+the\s+)?storefront(?:\s+page|\s+link)?$|^compare\s+all\s+fields\s+with\s+the\s+detail\s+page$/i,
    run: async (t) => {
      const saved = ((t.noted.get('__saves') as { saved: boolean; productId: number | null }[] | undefined) ?? []).filter((r) => r.saved).at(-1);
      const id = saved?.productId ?? (t.noted.get('__editing') as { id: number } | undefined)?.id;
      if (!id) return 'Nothing was saved, so there is no detail page to open.';
      const p = await t.api.getProduct(id);
      t.noted.set('__savedProduct', p);
      await t.ui.goto(`/dashboard/products/detail?id=${id}`, { waitForList: false });
      await t.page.waitForTimeout(1500);
      t.noted.set('__detailText', (await t.page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' '));
      await t.shot('detail page');
      if (!t.noted.get('__storefrontLink')) t.noted.set('__storefrontLink', 'https://ezina.bd/');
      t.noted.set('__save', { ...(t.noted.get('__save') as object), slug: p.slug, productId: id });
      return `Detail page of '${p.name}' opened. ${await openStorefront(t)}`;
    },
  },
  {
    name: 'form: upload images',
    pattern: /^(?:open\s+'?photos'?\s+and\s+)?(?:upload|try(?:\s+uploading)?)\s+(?:a|an|the)?\s*(\d+\s+(?:more\s+)?(?:valid\s+)?images?|(?:\d+(?:st|nd|rd|th)\s+image)|(?:main\s+image)|(?:image\s+of\s+exactly\s+\d+(?:\.\d+)?\s*mb)|(?:\d+(?:\.\d+)?\s*mb\s+image)|(?:16:9\s+\(wide\)\s+image)|(?:\.webp\s+image(?:\s+in\s+photos)?)|(?:\.gif)|(?:\.pdf\s+and\s+an\s+\.exe\s+renamed\s+to\s+\.jpg)|(?:\.pdf)|(?:\.exe\s+renamed\s+to\s+\.jpg))(?:\s+\(total\s+\d+\))?$|^(?:then\s+)?in\s+the\s+seo\s+image\s+field$/i,
    run: async (t, m) => {
      await ensureForm(t);
      const what = (m[1] ?? 'webp seo').toLowerCase();
      const target = /seo/.test(what) ? 'seo' : /main image/.test(what) ? 'thumbnail' : 'gallery';
      const specs: string[] = [];
      const n = Number(what.match(/^(\d+)\s/)?.[1] ?? 0);
      if (n) for (let i = 0; i < n; i++) specs.push('square jpg');
      else if (/\d+(?:st|nd|rd|th)\s+image/.test(what)) {
        const k = Number(what.match(/\d+/)![0]);
        const have = await galleryCount(t);
        for (let i = have; i < k; i++) specs.push('square jpg');
      } else if (/pdf\s+and/.test(what)) specs.push('pdf', 'fake exe');
      else specs.push(what);
      const results: string[] = [];
      for (const spec of specs) results.push(await uploadOne(t, target, spec));
      return results.length > 3 ? `${results.length} uploads: ${[...new Set(results)].join('; ')}` : results.join(' ');
    },
  },
  {
    name: 'form: reorder and remove image',
    pattern: /^drag\s+to\s+reorder$|^remove\s+one$/i,
    run: async (t, m) => {
      await ensureForm(t);
      if (/remove/i.test(m[0])) {
        const before = await galleryCount(t);
        const btn = t.page.locator('main').getByRole('button', { name: /^\s*(remove|delete)\b.*(image|photo)?/i }).filter({ visible: true }).last();
        if (!(await btn.count())) throw new Missing('a remove button on a gallery image');
        await btn.click();
        await t.page.waitForTimeout(600);
        const after = await galleryCount(t);
        t.noted.set('__galleryRemoved', { before, after });
        return `Removed one image: gallery ${before} → ${after}.`;
      }
      const why = 'Dragging images to reorder is not something the bot does reliably; the order is checked by hand.';
      t.note(why);
      return why;
    },
  },
  {
    name: 'form: sell through pos',
    pattern: /^(?:sell|place\s+a\s+test\s+order\s+(?:for|of))\s+(\d+)\s+units?(?:\s+(?:through|in)\s+pos)?$|^in\s+pos,\s*add\s+(\d+)\s+units\s+of\s+this\s+product$|^place\s+a\s+test\s+order$/i,
    run: async (t, m) => sellSaved(t, Number(m[1] ?? m[2] ?? 1), /add\s+\d+\s+units/i.test(m[0])),
  },
  {
    name: 'form: stock in',
    pattern: /^use\s+adjust\s+stock\s+to\s+stock\s+in\s+(\d+)\s+units$/i,
    run: async (t, m) => {
      const r = ((t.noted.get('__saves') as { saved: boolean; productId: number | null; name: string | null }[] | undefined) ?? []).filter((x) => x.saved).at(-1);
      if (!r?.productId || !r.name) return t.block('No product was saved in an earlier step.');
      return stockInDialog(t, r.productId, r.name, Number(m[1]), 'first');
    },
  },
  {
    name: 'form: another product with switch',
    pattern: /^create\s+another\s+product\s+with\s+'(track inventory|track serial \/ imei|track expiry \/ batches)'\s+(on|off)(?:\s+and\s+(?:stock\s+in\s+(\d+)\s+units|sell\s+(\d+)\s+units?))?$/i,
    run: async (t, m) => {
      await freshForm(t);
      cleanupSaved(t);
      await typeInto(t, 'Product Name', 'Second item');
      await typeInto(t, 'Selling Price', '100');
      if (/track inventory/i.test(m[1])) await typeInto(t, 'Opening Stock', '5');
      await setSwitch(t, m[1], /on/i.test(m[2]));
      const r = await save(t);
      t.noted.set('__secondProduct', r);
      if (!r.saved || !r.productId) return describeSave(r);
      if (m[3]) return `${describeSave(r)} ${await stockInDialog(t, r.productId, r.name!, Number(m[3]), 'second')}`;
      if (m[4]) return `${describeSave(r)} ${await sellSaved(t, Number(m[4]), false)}`;
      return describeSave(r);
    },
  },
  {
    name: 'form: search on storefront and pos',
    pattern: /^search\s+for\s+both\s+on\s+the\s+storefront\s+and\s+in\s+pos$/i,
    run: async (t) => {
      const saved = ((t.noted.get('__saves') as { saved: boolean; name: string | null; slug: string | null }[] | undefined) ?? []).filter((x) => x.saved && x.name);
      if (!saved.length) return t.block('No product was saved in the steps.');
      const found: { name: string; storefront: boolean; pos: boolean }[] = [];
      const page = await t.newPage();
      for (const p of saved) {
        const res = await page.goto(`https://ezina.bd/product/${p.slug}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
        await page.waitForTimeout(1500);
        const body = await page.locator('body').innerText().catch(() => '');
        const storefront = (res?.status() ?? 404) < 400 && body.includes(p.name!.slice(0, 20));
        await t.ui.goto('/dashboard/pos', { waitForList: false });
        const search = t.page.getByPlaceholder(/search products/i).first();
        await search.fill(p.name!.slice(0, 40));
        await t.page.waitForTimeout(1800);
        const pos = (await t.page.locator('body').innerText()).includes(p.name!.slice(0, 20));
        found.push({ name: p.name!, storefront, pos });
      }
      t.noted.set('__visibility', found);
      await t.shot('pos search');
      return found.map((f) => `'${f.name}': storefront ${f.storefront ? 'shows it' : 'does not'}, POS ${f.pos ? 'shows it' : 'does not'}`).join('; ') + '.';
    },
  },
  {
    name: 'form: variation errors',
    pattern: /^add\s+2\s+variations\s+with\s+the\s+same\s+sku(?:,?\s*then\s+save)?$|^add\s+2\s+blank\s+variations\s+with\s+the\s+same\s+value.*$|^leave\s+one\s+variant'?s\s+price\s+empty\s+with\s+'price\s+per\s+variation'(?:,?\s*then\s+save)?$/i,
    run: async (t, m) => {
      await freshForm(t);
      cleanupSaved(t);
      // A blocked save can leave a "leave this page?" prompt or toast; make sure the new form is really empty and ready.
      await t.page.getByRole('button', { name: /^\s*Save Product\s*$/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      await t.page.waitForTimeout(600);
      await typeInto(t, 'Product Name', 'Variant check');
      await t.page.getByRole('button', { name: /^\s*Variable\b/ }).first().click();
      await t.page.locator('main').getByText('Choose Attribute', { exact: true }).first().waitFor({ timeout: 8_000 }).catch(() => undefined);
      const c = m[0].toLowerCase();
      if (/blank variations/.test(c)) {
        await addAttribute(t, 'Weight', ['50g']);
        await t.page.getByRole('button', { name: /^\s*Add (?:a blank )?variation\s*$/ }).filter({ visible: true }).last().click();
        await t.page.waitForTimeout(500);
        await typeInto(t, 'Selling Price', '100');
        // Give the added row the same Weight value as the first one.
        const second = t.page.locator('main button[aria-label^="Weight of "]').nth(1);
        if (await second.count()) {
          await second.click();
          await t.page.waitForTimeout(300);
          await t.page.getByRole('option', { name: /^\s*50g\s*$/ }).first().click().catch(() => t.page.keyboard.press('Escape'));
        }
        const names = t.page.locator('main input[aria-label^="Name for"]');
        for (let i = 0; i < Math.min(2, await names.count()); i++) await names.nth(i).fill('50g').catch(() => undefined);
        t.noted.set('__dupRows', (await variationRows(t)).map((r) => r.name));
      } else {
        await addAttribute(t, 'Weight', ['50g', '100g']);
        if (/price empty/.test(c)) {
          await t.page.getByRole('button', { name: /^\s*Price per variation/ }).click();
          await t.page.waitForTimeout(400);
          await fillVariationRows(t);
          const first = (await variationRows(t))[0];
          if (first) await t.page.locator(`main input[aria-label="Name for ${first.name}"]`).locator('xpath=ancestor::*[count(.//input)>=6][1]').locator('label').filter({ hasText: /Selling Price/ }).locator('input').fill('');
        } else {
          await typeInto(t, 'Selling Price', '100');
          const same = `${t.prefix.replace(/\s+/g, '-')}-VAR-01`;
          for (const r of await variationRows(t)) await t.page.locator(`main input[aria-label="Name for ${r.name}"]`).locator('xpath=ancestor::*[count(.//input)>=4][1]').locator('label').filter({ hasText: /^SKU/ }).locator('input').fill(same).catch(() => undefined);
        }
      }
      const r = await save(t);
      t.noted.set(`__varerr:${/same sku/.test(c) ? 'sku' : /blank/.test(c) ? 'dup' : 'price'}`, r);
      return describeSave(r);
    },
  },
  {
    name: 'form: fill listed fields',
    pattern: /^fill\s+((?:short description|full description|labels|unit|meta title|meta description|brand|sku|barcode|weight)(?:\s*(?:,|and|\/)\s*(?:short description|full description|description|labels|unit|meta title|meta description|brand|sku|barcode|weight))*)$/i,
    run: async (t, m) => {
      await ensureForm(t);
      const data = formValues(t.tc.testData);
      const names = m[1].split(/\s*,\s*|\s+and\s+|\s*\/\s*/).map((x) => x.trim()).map((x, i, all) => (/^description$/i.test(x) && /meta/i.test(all[i - 1] ?? '') ? 'Meta Description' : x));
      const done: string[] = [];
      for (const n of names) {
        const label = formLabel(n);
        if (['Unit', 'Brand', 'Labels', 'Category'].includes(label)) {
          const v = data[label] ?? (label === 'Unit' ? 'pcs' : `${t.tc.id} ${label}`);
          done.push(await pick(t, label, v, { create: true }).catch((e) => `${label}: ${(e as Error).message.split('\n')[0]}`));
        } else if (label === 'Full Description') {
          const ed = t.page.locator('main [contenteditable=true]').first();
          await ed.click();
          await ed.pressSequentially('BTB full description for testing.', { delay: 5 });
          done.push('Full Description typed');
        } else done.push(await typeInto(t, label, data[label] ?? sample(t, label)).catch((e) => `${label}: ${(e as Error).message.split('\n')[0]}`));
      }
      return `${done.join('; ')}.`;
    },
  },
  {
    name: 'form: add specification and question',
    pattern: /^add\s+one\s+specification\s+and\s+one\s+question\s*(?:&|and)\s*answer$/i,
    run: async (t) => {
      await ensureForm(t);
      return `${await addPair(t, 'Add specification', 'Material', 'Cotton')} ${await addPair(t, 'Add question', 'Is it organic?', 'Yes')}`;
    },
  },
  {
    name: 'form: variation grid',
    pattern: /^click\s+'select\s+all',\s*enter\s+stock\s+(\d+)\s+and\s+click\s+'apply\s+to\s+selected'$|^click\s+'add\s+a\s+blank\s+variation'$|^select\s+the\s+blank\s+row\s+and\s+click\s+'delete'$/i,
    run: async (t, m) => {
      await ensureForm(t);
      const before = (await variationRows(t)).length;
      const c = m[0].toLowerCase();
      if (m[1]) {
        const all = t.page.locator('main label').filter({ hasText: /^\s*(Select all|\d+ selected)\s*$/ }).locator('input[type=checkbox]').first();
        if (!(await all.isChecked().catch(() => false))) await all.check({ force: true }).catch(() => undefined);
        await t.page.waitForTimeout(300);
        const what = t.page.locator('main select').filter({ has: t.page.locator('option', { hasText: /^Stock$/ }) }).first();
        if (await what.count()) await what.selectOption({ label: 'Stock' }).catch(() => undefined);
        await t.page.getByPlaceholder('Value', { exact: true }).first().fill(m[1]);
        const apply = t.page.getByRole('button', { name: /^\s*Apply to selected\s*$/ });
        if (await apply.isDisabled().catch(() => true)) {
          const n = await t.page.locator('main input[aria-label^="Select "]').count();
          for (let i = 0; i < n; i++) await t.page.locator('main input[aria-label^="Select "]').nth(i).check({ force: true }).catch(() => undefined);
        }
        await apply.click({ timeout: 8_000 });
        await t.page.waitForTimeout(500);
        const rows = await t.page.locator('main label').filter({ hasText: /^Current Stock$/ }).locator('input').evaluateAll((xs) => xs.map((x) => (x as HTMLInputElement).value));
        t.noted.set('__bulkStock', { want: m[1], rows });
        return `Applied stock ${m[1]} to all rows: ${rows.join(', ') || 'no rows'}.`;
      }
      if (/blank variation/.test(c)) {
        const btn = t.page.getByRole('button', { name: /^\s*Add (?:a blank )?variation\s*$/ }).filter({ visible: true }).last();
        t.noted.set('__addVariationLabel', (await btn.innerText()).trim());
        await btn.click();
        await t.page.waitForTimeout(500);
        const after = (await variationRows(t)).length;
        t.noted.set('__rowCounts', [...((t.noted.get('__rowCounts') as number[] | undefined) ?? [before]), after]);
        return `Rows ${before} → ${after}.`;
      }
      const boxes = t.page.locator('main input[type=checkbox][aria-label^="Select "]');
      const n = await boxes.count();
      for (let i = 0; i < n; i++) await boxes.nth(i).setChecked(i === n - 1, { force: true }).catch(() => undefined);
      await t.page.getByRole('button', { name: /^\s*Delete\s*$/ }).first().click();
      await t.page.waitForTimeout(400);
      const confirm = t.ui.dialog();
      if (await confirm.count()) await confirm.getByRole('button').filter({ hasNotText: /^(Cancel|Close|Keep.*)$/i }).last().click().catch(() => undefined);
      await t.page.waitForTimeout(500);
      const after = (await variationRows(t)).length;
      t.noted.set('__rowCounts', [...((t.noted.get('__rowCounts') as number[] | undefined) ?? [before]), after]);
      return `Deleted the last row: ${before} → ${after}.`;
    },
  },
  {
    name: 'form: write with ai',
    pattern: /^click\s+'write\s+with\s+ai'\s+for\s+short\s+description(?:\s+and\s+then\s+full\s+description)?$|^try\s+'write\s+with\s+ai'\s+on\s+a\s+new\s+product\s+with\s+no\s+name$/i,
    run: async (t, m) => {
      const empty = /no name/i.test(m[0]);
      if (empty) await freshForm(t);
      else await ensureForm(t);
      if (!empty && !(await (await field(t, 'Product Name')).inputValue())) await typeInto(t, 'Product Name', valueFor(t, 'Product Name') || 'Ajwa Dates 500g');
      // "Write with AI" opens a box that charges the store's wallet on Generate; the bot opens it and reads it, but never generates.
      const toasts = t.toasts.length;
      await t.page.getByRole('button', { name: /^\s*Write with AI\s*$/ }).first().click().catch(() => undefined);
      await t.page.waitForTimeout(800);
      const dlg = t.page.getByRole('dialog').filter({ hasText: /Write with AI/ });
      const text = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const prompt = await dlg.locator('textarea').first().inputValue().catch(() => '');
      const generate = dlg.getByRole('button', { name: /^\s*Generate\s*$/ });
      const canGenerate = (await generate.count()) > 0 && (await generate.isEnabled().catch(() => false));
      await t.shot(empty ? 'write with ai no name' : 'write with ai');
      await dlg.getByRole('button', { name: /^\s*Cancel\s*$/ }).click().catch(() => t.page.keyboard.press('Escape'));
      const said = t.toasts.slice(toasts);
      t.noted.set(empty ? '__aiNoName' : '__aiBox', { opened: !!text, prompt, canGenerate, cost: text.match(/Charged to your wallet[^.]*\./)?.[0] ?? '', messages: said });
      t.note('Write with AI was not run: each Generate is charged to the store wallet. The bot only opened the box to check it.');
      return text
        ? `The Write with AI box opened${prompt ? ` with "${prompt.slice(0, 60)}"` : ' empty'}; Generate is ${canGenerate ? 'enabled' : 'disabled'}${said.length ? `; message: ${said.join(' | ')}` : ''}. Not generated (it costs wallet credit).`
        : `No Write with AI box opened${said.length ? `; message: ${said.join(' | ')}` : ''}.`;
    },
  },
  {
    name: 'form: edit text formatting',
    pattern: /^edit\s+the\s+text,\s*add\s+bold\s+and\s+a\s+list(?:,?\s*and\s+save)?$/i,
    run: async (t, m) => {
      await ensureForm(t);
      const ed = t.page.locator('[contenteditable=true]').first();
      await ed.scrollIntoViewIfNeeded().catch(() => undefined);
      await ed.click();
      await t.page.keyboard.press('End');
      await t.page.keyboard.press('Enter');
      await t.page.getByRole('button', { name: /^\s*Bold\s*$/ }).first().click();
      await t.page.keyboard.type('BTB bold line');
      await t.page.getByRole('button', { name: /^\s*Bold\s*$/ }).first().click();
      await t.page.keyboard.press('Enter');
      await t.page.getByRole('button', { name: /^\s*Bullet list\s*$/ }).first().click();
      await t.page.keyboard.type('BTB list item');
      const html = await ed.innerHTML();
      t.noted.set('__aiEdited', { bold: /<(strong|b)\b/.test(html), list: /<li\b/.test(html) });
      return /save/i.test(m[0]) ? doSave(t) : 'Added a bold line and a list item.';
    },
  },
  {
    name: 'form: change variant stock',
    pattern: /^change\s+one\s+variant'?s\s+stock$/i,
    run: async (t) => {
      const rows = await variationRows(t);
      if (!rows.length) {
        const f = await field(t, 'Opening Stock').catch(() => null);
        if (!f) {
          // Simple products change stock through Adjust Stock, not the edit form.
          const p = t.noted.get('__editing') as { id: number; name: string } | undefined;
          if (!p) return 'This product has no variants and no stock field on the edit form.';
          const before = (await t.api.stockLevels(p.id).catch(() => null))?.quantity ?? 0;
          t.noted.set('__stockEdit', { from: before, to: before + 3 });
          t.noted.set('__stockAfterSave', { id: p.id, qty: 3 });
          return 'This is a simple product: its stock is changed with Adjust Stock after saving (+3).';
        }
        const now = Number(await f.inputValue()) || 0;
        await f.fill(String(now + 3));
        t.noted.set('__stockEdit', { from: now, to: now + 3 });
        return `Changed stock ${now} → ${now + 3}.`;
      }
      const stock = t.page.locator(`main input[aria-label="Name for ${rows[0].name}"]`).locator('xpath=ancestor::*[count(.//input)>=4][1]').locator('label').filter({ hasText: /Current Stock/ }).locator('input');
      const now = Number(await stock.inputValue()) || 0;
      await stock.fill(String(now + 3));
      t.noted.set('__stockEdit', { variant: rows[0].name, from: now, to: now + 3 });
      return `Changed ${rows[0].name} stock ${now} → ${now + 3}.`;
    },
  },
  {
    name: 'form: not automatable',
    pattern: /^(?:open\s+the\s+same\s+product'?s\s+edit\s+page\s+in\s+two\s+tabs|click\s+save\s+in\s+tab\s+2|change|save\s+in\s+tab\s+[12]|delete\s+the\s+product\s+in\s+tab\s+1|edit\s+a\s+variable\s+product\s+whose\s+variant\s+has\s+been\s+sold|delete\s+that\s+variant|change\s+it\s+to\s+inclusive|repeat|upload\s+\d+\s+more\s+\(total\s+\d+\))$/i,
    run: async (t, m) => {
      const c = m[0].toLowerCase();
      if (/^upload/.test(c)) {
        const n = Number(c.match(/total\s+(\d+)/)?.[1] ?? 8);
        const have = await galleryCount(t);
        const out: string[] = [];
        for (let i = have; i < n; i++) out.push(await uploadOne(t, 'gallery', 'square jpg'));
        const now = await galleryCount(t);
        if (now >= 8) t.noted.set('__galleryFullUpload', (await t.page.locator('main input[type=file][accept=".jpeg,.jpg,.png"]').count()) > 0);
        return `${out.length} more image(s); gallery now ${now} of 8${now >= 8 ? ((t.noted.get('__galleryFullUpload') as boolean) ? ', and it still offers an upload box' : ', and the upload box is gone') : ''}.`;
      }
      // Skipped on purpose, but the rest of the case still runs (a soft stop is noted, not a failure).
      const why = /inclusive|repeat/.test(c) ? 'No tax rate exists in this store to test inclusive tax with; this step was skipped.'
        : /tab/.test(c) || c === 'change' ? 'Editing the same product in two tabs at once is not something the bot does; the conflict check was skipped.'
        : 'Finding a variant that has already been sold and deleting it would change a real product; this was skipped.';
      t.note(why);
      return why;
    },
  },
  {
    name: 'form: leave with unsaved changes',
    pattern: /^click\s+'(orders|products|dashboard|customers)'\s+in\s+the\s+sidebar$/i,
    run: async (t, m) => {
      const prompts = t.leavePrompts + t.dialogsFired;
      await t.page.getByRole('link', { name: new RegExp(`^\\W*${m[1]}\\b`, 'i') }).filter({ visible: true }).first().click();
      await t.page.waitForTimeout(1500);
      const inPage = await t.ui.dialog().count();
      const text = inPage ? await t.ui.dialogText() : '';
      const native = t.leavePrompts + t.dialogsFired - prompts;
      t.noted.set('__leave', { native, dialog: text, url: new URL(t.page.url()).pathname });
      if (inPage) await t.shot('leave prompt');
      return `${native ? 'The browser asked to confirm leaving. ' : ''}${text ? `A box appeared: "${text.slice(0, 120)}". ` : ''}Now on ${new URL(t.page.url()).pathname}.`;
    },
  },
];

/** Sells (or only adds to the cart) the last product this case saved, at the POS counter. */
async function sellSaved(t: CaseContext, qty: number, onlyAdd: boolean): Promise<string> {
  const r = ((t.noted.get('__saves') as { saved: boolean; productId: number | null; name: string | null }[] | undefined) ?? []).filter((x) => x.saved).at(-1);
  if (!r?.productId || !r.name) return t.block('No product was saved in an earlier step, so there is nothing to sell.');
  let before = await t.api.stockLevels(r.productId).catch(() => null);
  const tracked = (await t.api.getProduct(r.productId).catch(() => null))?.track_inventory !== false;
  // POS will not sell a tracked product with no stock; give it some first (recorded in the report).
  if (tracked && before && before.available < qty) {
    await t.api.adjustStock(r.productId, 'in', qty + 5).catch(() => undefined);
    t.note(`'${r.name}' had no stock, so the bot added ${qty + 5} before selling it.`);
    before = await t.api.stockLevels(r.productId).catch(() => before);
  }
  const added = await addToCart(t, r.name);
  if (/is not in this store/.test(added)) return t.block(`'${r.name}' could not be found in POS, so it was not sold.`);
  const cart = t.page.locator('aside').filter({ hasText: /Clear cart|Checkout/ }).first();
  const qtyBox = cart.locator('input').filter({ hasNot: t.page.locator('[type=search]') }).first();
  // Set the quantity directly when the cart has a number box; otherwise press + until it matches.
  if (qty > 1 && (await qtyBox.count()) && (await qtyBox.isEditable().catch(() => false))) {
    await qtyBox.fill(String(qty));
    await qtyBox.press('Enter').catch(() => undefined);
  } else for (let i = 1; i < qty; i++) {
    await cart.getByRole('button', { name: /increase quantity/i }).first().click().catch(() => undefined);
    await t.page.waitForTimeout(150);
  }
  await t.page.waitForTimeout(1000);
  const aside = (await cart.innerText().catch(() => '')).replace(/\s+/g, ' ');
  const unit = aside.match(/([\d,]+(?:\.\d+)?)\s*\/\s*pcs/)?.[1] ?? '';
  const shownQty = Number(aside.match(/\/pcs\s+(\d+)/)?.[1] ?? 0);
  t.noted.set('__posCart', { qty: shownQty || qty, unit: Number(unit.replace(/,/g, '')), text: aside });
  if (onlyAdd) {
    await t.shot('pos cart');
    return `Added ${qty} × '${r.name}' to the POS cart; unit price shown: ৳${unit || '?'}.`;
  }
  // Sell over the counter (Store tab needs no customer), then read the stock again.
  await t.page.getByRole('button', { name: /^\s*Checkout\b/ }).filter({ visible: true }).first().click();
  await t.page.waitForTimeout(1200);
  const dlg = t.ui.dialog();
  await dlg.getByRole('button', { name: /^\s*Store\s*$/ }).click().catch(() => undefined);
  await t.page.waitForTimeout(600);
  const totalText = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ');
  await dlg.getByRole('button', { name: /^\s*Complete sale\s*$/ }).click();
  await t.page.waitForTimeout(3500);
  await t.shot('pos sale');
  const after = await t.api.stockLevels(r.productId).catch(() => null);
  const sale = { before: before?.quantity ?? null, after: after?.quantity ?? null, qty, total: totalText.match(/Total\s*৳\s*([\d,.]+)/)?.[1] ?? '', tax: totalText.match(/Tax\s*\+?৳\s*([\d,.]+)/)?.[1] ?? '' };
  t.noted.set(`__sale:${r.productId}`, sale);
  t.noted.set('__sales', [...((t.noted.get('__sales') as unknown[] | undefined) ?? []), { product: r.name, ...sale }]);
  return `Sold ${qty} × '${r.name}' at the counter (total ৳${sale.total || '?'}${sale.tax ? `, tax ৳${sale.tax}` : ''}); stock ${sale.before ?? '?'} → ${sale.after ?? '?'}.`;
}

/** Stock In through the product's Adjust Stock dialog; records whether batch/expiry or serial numbers were demanded. */
async function stockInDialog(t: CaseContext, id: number, name: string, qty: number, which: string): Promise<string> {
  await t.ui.goto('/dashboard/products');
  await t.ui.search(name.slice(0, 60));
  const row = t.ui.row(name);
  await row.getByLabel('Adjust stock').click();
  const dlg = t.ui.dialog();
  await dlg.waitFor({ timeout: 8_000 });
  await dlg.getByText('Stock In', { exact: true }).click().catch(() => undefined);
  await dlg.getByRole('spinbutton', { name: 'Quantity' }).fill(String(qty)).catch(() => undefined);
  await t.page.waitForTimeout(500);
  const text = (await dlg.innerText()).replace(/\s+/g, ' ');
  const asks = { batch: /batch/i.test(text), expiry: /expir/i.test(text), serial: /serial|imei/i.test(text) };
  const toasts = t.toasts.length;
  await dlg.getByText('Save Changes', { exact: true }).click().catch(() => undefined);
  await t.page.waitForTimeout(1800);
  const blocked = (await dlg.count()) > 0;
  const said = t.toasts.slice(toasts);
  if (blocked) await t.page.keyboard.press('Escape');
  const after = await t.api.stockLevels(id).catch(() => null);
  const rec = { which, qty, asks, blocked, messages: said, stock: after?.quantity ?? null, text: text.slice(0, 300) };
  t.noted.set(`__stockIn:${which}`, rec);
  await t.shot(`stock in ${which}`);
  return `Stock In ${qty}: the dialog ${asks.batch || asks.expiry ? 'asks for batch/expiry' : asks.serial ? 'asks for serial numbers' : 'asks only for the quantity'}; ${blocked ? `saving was blocked${said.length ? ` ("${said.join(' | ')}")` : ''}` : `saved, stock now ${after?.quantity ?? '?'}`}.`;
}

/** A believable value for a field the sheet does not give one for. */
function sample(t: CaseContext, label: string): string {
  const n = Date.now().toString().slice(-6);
  return ({
    'SKU': `${t.prefix.replace(/\s+/g, '-')}-${n}`,
    'Barcode': `59${n}${n}`.slice(0, 13),
    'Weight (Kg)': '0.5',
    'Extra Shipping Fee': '20',
    'Short Description': 'BTB short description for testing.',
    'Meta Title': 'BTB meta title',
    'Meta Description': 'BTB meta description for testing.',
  } as Record<string, string>)[label] ?? `BTB ${label.toLowerCase()}`;
}

/** The attribute/value pickers stay open after a pick; clicking the Variations heading closes them without undoing it. */
async function closeAttrPopover(t: CaseContext): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).count())) return;
    // A click on plain text inside the section (not its header, which would collapse it).
    const hint = t.page.locator('main').getByText('Choose Attribute', { exact: true }).first();
    const box = await hint.boundingBox().catch(() => null);
    if (box) await t.page.mouse.click(box.x + box.width + 300, box.y + box.height / 2);
    else await t.page.mouse.click(5, 300);
    await t.page.waitForTimeout(300);
  }
}

async function galleryCount(t: CaseContext): Promise<number> {
  const text = await t.page.locator('main').innerText().catch(() => '');
  return Number(text.match(/Gallery\s*(\d+)\s*of\s*\d+/)?.[1] ?? 0);
}

/** Uploads one generated file and records what the form did: preview added, cropper, message, upload request. */
async function uploadOne(t: CaseContext, target: 'gallery' | 'thumbnail' | 'seo', spec: string): Promise<string> {
  const seed = ((t.noted.get('__uploadSeed') as number | undefined) ?? 0) + 1;
  t.noted.set('__uploadSeed', seed);
  const file = await makeFile(t.page, path.join(t.runDir, 'uploads'), spec, seed);
  // Bad-file checks need a gallery with room; a full gallery hides its upload box.
  if (target === 'gallery' && /5mb|gif|pdf|exe|webp/.test(spec) && (await galleryCount(t)) >= 8) {
    const remove = t.page.locator('main').getByRole('button', { name: /^\s*(remove|delete)\b/i }).filter({ visible: true }).last();
    if (await remove.count()) { await remove.click(); await t.page.waitForTimeout(500); }
  }
  const accept = target === 'gallery' ? '.jpeg,.jpg,.png' : '.jpeg,.jpg,.png,.webp';
  const inputs = t.page.locator(`main input[type=file][accept="${accept}"]`);
  const input = target === 'seo' ? inputs.first() : target === 'thumbnail' ? inputs.nth(1) : inputs.last();
  const before = await galleryCount(t);
  if (target === 'gallery' && before >= 8 && !(await inputs.count())) {
    const rec = { spec, file: file.name, kind: file.kind, bytes: file.bytes, target, accepted: false, before, after: before, cropper: '', messages: [] as string[], disabled: true };
    t.noted.set('__uploads', [...((t.noted.get('__uploads') as (typeof rec)[] | undefined) ?? []), rec]);
    return `${file.kind}: the gallery is full (8 of 8) and no longer offers an upload.`;
  }
  const toasts = t.toasts.length;
  let uploaded = 0;
  const onResp = (r: import('playwright').Response) => { if (r.request().method() === 'POST' && /\/media\b/.test(r.url()) && r.status() < 300) uploaded++; };
  t.page.on('response', onResp);
  const disabled = await input.isDisabled().catch(() => false);
  if (!disabled) await input.setInputFiles(file.path).catch(() => undefined);
  await t.page.waitForTimeout(1200);
  const crop = t.page.getByRole('dialog').filter({ hasText: /Image\s*·/ });
  let cropper = '';
  if (await crop.count()) {
    const size = await crop.locator('img').first().evaluate((i) => `${(i as HTMLImageElement).naturalWidth}x${(i as HTMLImageElement).naturalHeight}`).catch(() => '0x0');
    cropper = size === '0x0' ? 'the cropper could not show it' : `a cropper opened (${size})`;
    // The cropper's Upload button is briefly disabled while the image loads.
    const up = crop.getByRole('button', { name: /^\s*Upload\s*$/ });
    await t.page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] button')].some((b) => /^\s*Upload\s*$/.test(b.textContent ?? '') && !(b as HTMLButtonElement).disabled), null, { timeout: 8_000 }).catch(() => undefined);
    await up.click({ timeout: 5_000 }).catch(() => undefined);
    await t.page.waitForTimeout(3500);
    if (await crop.count()) {
      cropper += ' and Upload did nothing';
      await crop.getByRole('button', { name: /^\s*Cancel\s*$/ }).click().catch(() => t.page.keyboard.press('Escape'));
    }
  }
  t.page.off('response', onResp);
  const after = await galleryCount(t);
  const said = t.toasts.slice(toasts);
  const rec = { spec, file: file.name, kind: file.kind, bytes: file.bytes, target, accepted: uploaded > 0 || after > before, before, after, cropper, messages: said, disabled };
  t.noted.set('__uploads', [...((t.noted.get('__uploads') as (typeof rec)[] | undefined) ?? []), rec]);
  return `${file.kind} (${(file.bytes / 1024 / 1024).toFixed(2)} MB) → ${disabled ? 'upload is disabled' : rec.accepted ? 'accepted' : 'refused'}${cropper ? `, ${cropper}` : ''}${said.length ? `, message "${said.join(' | ')}"` : ''}${target === 'gallery' ? `; gallery ${before} → ${after} of 8` : ''}.`;
}

async function typeLength(t: CaseContext, label: string, n: number): Promise<string> {
  const f = await field(t, label);
  await f.fill('');
  await f.pressSequentially('x'.repeat(n), { delay: 0 });
  await t.page.waitForTimeout(200);
  const kept = (await f.inputValue()).length;
  const counter = await t.page.evaluate((l) => {
    const lab = [...document.querySelectorAll('main label')].find((x) => (x as HTMLElement).innerText.trim().toLowerCase().startsWith(l.toLowerCase()));
    const box = lab?.parentElement?.parentElement as HTMLElement | undefined;
    return box?.innerText.match(/\d+\s*\/\s*\d+/)?.[0] ?? '';
  }, formLabel(label));
  const rec = { label: formLabel(label), typed: n, kept, counter };
  t.noted.set(`__length:${formLabel(label)}:${n}`, rec);
  t.noted.set('__lengths', [...((t.noted.get('__lengths') as typeof rec[] | undefined) ?? []), rec]);
  return `Typed ${n} characters in ${formLabel(label)}: the field kept ${kept}${counter ? `, counter shows ${counter}` : ''}.`;
}

async function storefrontLink(t: CaseContext): Promise<string> {
  return t.page.evaluate(() => {
    const el = [...document.querySelectorAll('main *')].find((e) => e.children.length < 4 && /^Storefront link/.test((e as HTMLElement).innerText?.trim() ?? ''));
    return (el as HTMLElement | undefined)?.innerText.match(/https?:\/\/\S+/)?.[0] ?? '';
  });
}

async function setSlug(t: CaseContext, slug: string, andSave: boolean): Promise<string> {
  await t.page.getByRole('button', { name: /^\s*Edit slug\s*$/ }).first().click();
  const input = t.page.getByPlaceholder('auto-generated-from-name');
  await input.fill(slug);
  await t.page.getByRole('button', { name: /^\s*Done\s*$/ }).first().click().catch(() => input.press('Enter'));
  await t.page.waitForTimeout(300);
  const link = await storefrontLink(t);
  t.noted.set('__slugTyped', { typed: slug, link });
  let out = `Typed slug "${slug}"; the link shows ${link}.`;
  if (andSave) out += ` ${await doSave(t)}`;
  return out;
}

async function openStorefront(t: CaseContext): Promise<string> {
  const r = t.noted.get('__save') as { slug: string | null } | undefined;
  if (!r?.slug) return 'Nothing was saved, so there is no storefront page to open.';
  const base = (await storefrontBase(t)) ?? 'https://ezina.bd';
  const page = await t.newPage();
  let res: import('playwright').Response | null = null;
  let found = false;
  for (let i = 0; i < 3 && !found; i++) {
    res = await page.goto(`${base}/product/${r.slug}`, { waitUntil: 'networkidle' }).catch(() => null);
    found = await page.waitForFunction(() => /৳|Tk|BDT/.test(document.body.innerText) && !/could not find that page/i.test(document.body.innerText), null, { timeout: 6_000 }).then(() => true).catch(() => false);
    if (!found) await page.waitForTimeout(4_000);
  }
  await page.waitForTimeout(500);
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  t.noted.set('__storefront', { url: page.url(), status: res?.status() ?? null, text, missing: !found });
  await t.shot('storefront', page);
  return found ? `Storefront ${base}/product/${r.slug} shows the product.` : `Storefront ${base}/product/${r.slug} says "We could not find that page" (new products do not appear on this storefront right away).`;
}

async function storefrontBase(t: CaseContext): Promise<string | null> {
  const link = (t.noted.get('__storefrontLink') as string | undefined) ?? '';
  return link.match(/^https?:\/\/[^/]+/)?.[0] ?? null;
}

async function readVariants(t: CaseContext): Promise<string> {
  const r = t.noted.get('__save') as { productId: number | null } | undefined;
  if (!r?.productId) return 'Nothing was saved, so there are no variants to read.';
  const p = await t.api.getProduct(r.productId);
  t.noted.set('__savedProduct', p);
  return `Saved variants: ${p.variants.map((v) => `${v.name} SKU ${v.sku}`).join(', ')}.`;
}

/** Adds an attribute in "Choose Attribute" and ticks the wanted values (typing new ones when missing). */
async function addAttribute(t: CaseContext, attr: string, values: string[]): Promise<string> {
  // The attribute box loses its placeholder once one attribute is chosen; find it by its heading.
  const heading = t.page.locator('main').getByText('Choose Attribute', { exact: true }).first();
  await heading.waitFor({ timeout: 8_000 }).catch(() => undefined);
  await heading.scrollIntoViewIfNeeded().catch(() => undefined);
  const input = heading.locator('xpath=..').locator('input').first();
  await closeAttrPopover(t);
  await input.click({ timeout: 10_000 }).catch(async () => input.click({ force: true }));
  await input.fill(attr);
  // The store's attributes load a moment after the form opens; wait for the matching entry instead of pressing Enter,
  // which would open "New attribute" and create a duplicate.
  const pop = t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).last();
  const hit = pop.getByText(new RegExp(`^\\s*${esc(attr)}\\s*$`, 'i')).first();
  for (let i = 0; i < 10 && !(await hit.count()); i++) {
    await t.page.waitForTimeout(500);
    if (i === 4) { await input.fill(''); await input.fill(attr); }
  }
  if (await hit.count()) await hit.click();
  else {
    const exists = (await t.api.attributes().catch(() => [])).some((a) => a.name.toLowerCase() === attr.toLowerCase());
    if (exists) throw new Missing(`attribute '${attr}' in the Choose Attribute list (it exists in the store but the list did not show it)`);
    await input.press('Enter');
  }
  await t.page.waitForTimeout(600);
  // If a "New attribute" panel opened by mistake, close it without saving.
  const panel = t.page.getByRole('dialog').filter({ hasText: /^\s*New attribute/ });
  if (await panel.count()) await panel.getByRole('button', { name: /^\s*Cancel\s*$/ }).click().catch(() => t.page.keyboard.press('Escape'));
  // Close the attribute list by clicking the section heading (Escape can undo the pick).
  await closeAttrPopover(t);
  // The value box of this attribute: in its row (headed by the attribute name and "Select all · N"); it loses its placeholder after a pick.
  const row = t.page.locator('main').getByText(/^Select all · \d+$/).filter({ visible: true }).last().locator('xpath=ancestor::div[.//input][1]');
  const valueBox = row.locator('input').last();
  await valueBox.waitFor({ timeout: 5_000 }).catch(() => undefined);
  const missing: string[] = [];
  const known = (await t.api.attributes().catch(() => [])).find((a) => a.name.toLowerCase() === attr.toLowerCase());
  const storeValues = new Set((known?.values ?? []).map((v) => v.toLowerCase()));
  const original = known ? [...known.values] : null;
  for (const v of values) {
    if (!(await t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).count())) await valueBox.click();
    await t.page.waitForTimeout(400);
    const list = t.page.locator('[role=dialog], [data-radix-popper-content-wrapper]').filter({ visible: true }).last();
    const item = list.getByText(new RegExp(`^\\s*${esc(v)}\\s*$`, 'i')).first();
    if (await item.count()) await item.click();
    else if (storeValues.has(v.toLowerCase())) {
      // Already chosen (or briefly not listed): type it to filter, then pick it; never re-create a value the store has.
      await valueBox.fill(v);
      await t.page.waitForTimeout(500);
      const again = t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).last().getByText(new RegExp(`^\\s*${esc(v)}\\s*$`, 'i')).first();
      if (await again.count()) await again.click();
      await valueBox.fill('').catch(() => undefined);
    } else {
      // A value the store does not have yet: type it, then pick the "create" entry the list offers for it.
      missing.push(v);
      await valueBox.fill(v);
      await t.page.waitForTimeout(600);
      const offer = t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).last().getByRole('button').or(t.page.locator('[data-radix-popper-content-wrapper]').filter({ visible: true }).last().getByRole('option')).filter({ hasText: new RegExp(esc(v), 'i') }).first();
      if (await offer.count()) await offer.click();
      else await valueBox.press('Enter');
    }
    await t.page.waitForTimeout(300);
  }
  await closeAttrPopover(t);
  await t.page.waitForTimeout(400);
  if (missing.length && original) {
    // The form adds new values to the store's shared attribute list; put the list back exactly as it was.
    t.onCleanup(async () => {
      const now = (await t.api.attributes()).find((a) => a.name.toLowerCase() === attr.toLowerCase());
      if (now && now.values.join('|') !== original.join('|')) await t.api.request('PUT', `/catalog/attributes/${now.id}`, { name: now.name, values: original, swatches: now.swatches, codes: now.codes, is_active: now.is_active });
    });
  }
  return `${attr}: ${values.join(', ')}${missing.length ? ` (typed new: ${missing.join(', ')})` : ''}.`;
}

export async function variationRows(t: CaseContext): Promise<{ name: string; sku: string; price: string; stock: string }[]> {
  return t.page.evaluate(() => {
    const names = [...document.querySelectorAll('main input[aria-label^="Name for"]')] as HTMLInputElement[];
    return names.map((n) => {
      let row: HTMLElement | null = n;
      for (let i = 0; i < 8 && row && row.querySelectorAll('input').length < 4; i++) row = row.parentElement;
      const inputs = [...(row?.querySelectorAll('input') ?? [])] as HTMLInputElement[];
      const byLabel = (re: RegExp) => inputs.find((i) => re.test((i.closest('label') as HTMLElement | null)?.innerText ?? ''));
      return {
        name: n.value || n.getAttribute('aria-label')!.replace(/^Name for\s*/, '') || '(blank)',
        sku: byLabel(/^SKU/)?.value || byLabel(/^SKU/)?.placeholder || '',
        price: byLabel(/Selling Price/)?.value ?? '',
        stock: byLabel(/Current Stock/)?.value ?? '',
      };
    });
  }).catch(() => []);
}

async function fillVariationRows(t: CaseContext): Promise<string> {
  const lines = t.tc.testData.split('\n');
  const rows = await variationRows(t);
  const filled: string[] = [];
  for (const [i, r] of rows.entries()) {
    const line = lines.find((l) => l.toLowerCase().includes(r.name.toLowerCase())) ?? '';
    const price = line.match(/৳\s*(\d+)/)?.[1] ?? String(100 + i * 10);
    const stock = line.match(/stock\s+(\d+)/i)?.[1] ?? '5';
    const row = t.page.locator(`main input[aria-label="Name for ${r.name}"]`).locator('xpath=ancestor::*[count(.//input)>=6][1]');
    await row.locator('label').filter({ hasText: /Selling Price/ }).locator('input').fill(price).catch(() => undefined);
    await row.locator('label').filter({ hasText: /Current Stock/ }).locator('input').fill(stock).catch(() => undefined);
    const sku = `${t.prefix.replace(/\s+/g, '-')}-${r.name}`.toUpperCase();
    await row.locator('label').filter({ hasText: /^SKU/ }).locator('input').fill(sku).catch(() => undefined);
    filled.push(`${r.name}: ৳${price}, stock ${stock}, SKU ${sku}`);
  }
  return filled.length ? `Filled ${filled.join('; ')}.` : 'No variation rows to fill.';
}

async function addPair(t: CaseContext, button: string, a: string, b: string): Promise<string> {
  const spec = /specification/i.test(button);
  const names = t.page.locator(spec ? 'main input[aria-label^="Specification "][aria-label$=" name"]' : 'main [aria-label^="Question "], main input[placeholder*="question" i], main textarea[placeholder*="question" i]');
  const before = await names.count();
  await t.page.getByRole('button', { name: new RegExp(`^\\s*${esc(button)}\\s*$`, 'i') }).first().evaluate((x) => (x as HTMLElement).click());
  await t.page.waitForTimeout(400);
  const n = await names.count();
  if (n <= before) {
    // Fall back to "the inputs that appeared" when the new row has no names.
    const all = t.page.locator('main input:visible, main textarea:visible');
    const count = await all.count();
    if (a) await all.nth(count - 2).fill(a);
    if (b) await all.nth(count - 1).fill(b);
  } else {
    const i = n - 1;
    if (spec) {
      if (a) await t.page.locator(`main input[aria-label="Specification ${i + 1} name"]`).fill(a);
      if (b) await t.page.locator(`main input[aria-label="Specification ${i + 1} value"]`).fill(b);
    } else {
      if (a) await names.nth(i).fill(a);
      const answer = t.page.locator('main [aria-label^="Answer "], main textarea[placeholder*="answer" i], main input[placeholder*="answer" i]').last();
      if (b && (await answer.count())) await answer.fill(b);
    }
  }
  const key = spec ? '__spec' : '__qa';
  t.noted.set(key, [...((t.noted.get(key) as [string, string][] | undefined) ?? []), [a, b]]);
  return a || b ? `Added "${a}" = "${b}".` : 'Added an empty row.';
}

export { sectionName };

export const FORM_RULES: StepRule[] = RULES.map((r) => ({ ...r, formOnly: true }));
