import type { Product } from '../apps/slshop/api.js';
import type { SaveResult } from '../apps/slshop/product-form.js';
import type { CaseContext } from '../context.js';
import type { ExpectRule } from './expects.js';
import { quoted } from './text.js';

/**
 * Checks for expected results about the Add / Edit Product form. They read what the form steps recorded
 * (every Save: request, messages, blocked fields) and the saved product from the app's API.
 */

const saves = (t: CaseContext) => (t.noted.get('__saves') as SaveResult[] | undefined) ?? [];
const lastSave = (t: CaseContext) => saves(t).at(-1);
const slugOf = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
const why = (r: SaveResult) => [...r.messages, ...r.invalid.map((x) => `field: ${x}`), r.error ? `server: ${r.error}` : ''].filter(Boolean).join(' | ') || 'no message';
const saveLine = (r: SaveResult) => (r.saved ? `saved as '${r.name}' (/product/${r.slug})` : `not saved (${why(r)})`);

async function savedProduct(t: CaseContext): Promise<Product | null> {
  const cached = t.noted.get('__savedProduct') as Product | undefined;
  const id = saves(t).filter((r) => r.saved).at(-1)?.productId ?? (t.noted.get('__editing') as Product | undefined)?.id;
  if (cached && cached.id === id) return cached;
  if (!id) return null;
  const p = await t.api.getProduct(id).catch(() => null);
  if (p) t.noted.set('__savedProduct', p);
  return p;
}

/** The messages the person meant ("'Product Name is required' and 'Selling Price is required'"), checked loosely. */
/** Words that mean the same thing in the app's messages and the sheet's ("unique" ≈ "already in use"). */
const SAME_MEANING: [RegExp, RegExp][] = [
  [/\bunique\b|already exists|duplicate/i, /already (?:in use|exists|taken)|duplicate|not unique|combination already exists/i],
  [/\brequired\b/i, /required|needs|must (?:have|enter)|is missing|valid price/i],
  [/must be (?:0|zero) or more|not negative|≥\s*\d|greater than|lower than/i, /greater than or equal|must be (?:0|zero|at least|positive|lower|less|more)|cannot be negative|≥|≤/i],
  [/\binvalid\b/i, /invalid|not valid|valid (?:value|barcode)/i],
  [/overlap/i, /overlap/i],
];

function messageMatches(seen: string, wanted: string): boolean {
  const w = wanted.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((x) => x.length > 2 && !/^(the|and|must|should|be|is|are)$/.test(x));
  const s = seen.toLowerCase();
  if (w.length > 0 && w.filter((x) => s.includes(x)).length >= Math.ceil(w.length * 0.6)) return true;
  // Same subject (e.g. "SKU", "price", "variation") and the same meaning, in other words.
  const subject = w.filter((x) => !/^(required|unique|already|exists|duplicate|invalid|cannot|greater|than|must|more|less|not|least|one|add)$/.test(x));
  const sameSubject = !subject.length || subject.some((x) => s.includes(x.replace(/s$/, '')));
  return sameSubject && SAME_MEANING.some(([a, b]) => a.test(wanted) && b.test(seen));
}

export const FORM_EXPECT_RULES: ExpectRule[] = [
  {
    name: 'scroll to first error',
    pattern: /^the\s+page\s+should\s+scroll\s+to\s+the\s+first\s+error$/i,
    check: async (t) => {
      const r = saves(t).find((x) => !x.saved);
      if (!r) return t.skip('The page scrolls to the first error', 'No save was blocked.');
      const at = await t.page.evaluate(() => {
        const f = document.activeElement as HTMLElement | null;
        const box = f?.getBoundingClientRect();
        return { focused: f && f !== document.body ? (f.getAttribute('placeholder') ?? f.tagName) : '', visible: !!box && box.top >= 0 && box.bottom <= innerHeight, y: Math.round(scrollY) };
      });
      t.check('The page moves to the first error', !!at.focused && at.visible, at.focused ? `focus is on '${at.focused}' (${at.visible ? 'on screen' : 'off screen'})` : `nothing is focused; page scrolled to ${at.y}px`, 'The error is only a pop-up; the field with the problem is not focused or scrolled to.');
    },
  },
  {
    name: 'product saved',
    pattern: /^(?:the\s+)?(?:product|tier|changes?)\s+should\s+be\s+(?:added|saved|created)(?:\s+successfully)?(?:\s+and\s+shown\s+everywhere)?$/i,
    check: async (t) => {
      const all = saves(t);
      if (!all.length) return t.skip('The product is saved', 'No Save was clicked in the steps.');
      const ok = all.filter((r) => r.saved);
      t.check('The product is saved', ok.length > 0, all.map(saveLine).join('; '), 'Saving failed; see the message the form showed.');
    },
  },
  {
    name: 'product not saved',
    pattern: /^(?:the\s+)?(?:product|price)\s+should\s+not\s+be\s+saved(?:\s+(?:in\s+any\s+case|for\s+any\s+of\s+these\s+values))?$|^none\s+of\s+these\s+rows\s+should\s+be\s+created$/i,
    check: async (t, m, claim) => {
      const tries = (t.noted.get('__invalidTries') as { field: string; value: string; kept: string; saved: boolean; why: string }[] | undefined) ?? [];
      if (tries.length) {
        const bad = tries.filter((x) => x.saved);
        t.check('None of the invalid values is saved', !bad.length,
          bad.length ? `saved anyway: ${bad.map((x) => `${x.field} "${x.value}" (kept as "${x.kept}")`).join(', ')}; blocked: ${tries.filter((x) => !x.saved).map((x) => `${x.field} "${x.value}"`).join(', ') || 'none'}` : `all ${tries.length} tries were blocked`,
          'The field silently changes the value (e.g. drops the minus sign or the second dot) instead of rejecting it, so an invalid number is saved.');
        return;
      }
      const all = saves(t);
      if (!all.length) return t.skip(claim, 'No Save was clicked in the steps.');
      const saved = all.filter((r) => r.saved);
      t.check('The product is not saved', !saved.length, all.map(saveLine).join('; '), 'The form accepted values it should reject; validate them before saving.');
    },
  },
  {
    name: 'validation messages',
    pattern: /^(?!a\s+success\b)(?:.*\b(?:messages?|errors?)\b.*\b(?:should|must)\b.*\b(?:appear|say|be\s+shown|explain|show)\b|(?:a\s+)?clear\s+messages?\s+should|(?:both\s+)?fields?\s+should\s+show\s+an\s+error|'[^']+'(?:,\s*'[^']+')*.*—\s*on\s+the\s+correct\s+row|'[^']+'(?:,\s*'[^']+')+$)/i,
    check: async (t, m, claim) => {
      if (/\bno\b|\bwithout\b/i.test(claim.split(/should/i)[0])) return t.skip(claim, 'Reads as "no error"; checked by page health.');
      const all = saves(t);
      if (!all.length) return t.skip(claim, 'No Save was clicked, so no message could appear.');
      const seen = [...new Set(all.flatMap((r) => [...r.messages, ...r.invalid]))];
      const wanted = quoted(claim).filter((q) => q.length > 3 && !/^e\.g/i.test(q));
      if (wanted.length && !/e\.g\./i.test(claim)) {
        const missing = wanted.filter((w) => !seen.some((s) => messageMatches(s, w)));
        t.check(`Messages shown: ${wanted.map((w) => `'${w}'`).join(', ')}`, !missing.length,
          missing.length ? `missing ${missing.map((w) => `'${w}'`).join(', ')}; the form showed: ${seen.join(' | ') || 'nothing'}` : `shown: ${seen.join(' | ')}`,
          'The form shows only one message at a time (as a pop-up), not one under each wrong field.');
        return;
      }
      const blocked = all.filter((r) => !r.saved);
      const silent = blocked.filter((r) => !r.messages.length && !r.invalid.length);
      t.check('A clear message explains why it was not saved', blocked.length > 0 && !silent.length,
        blocked.length ? `${blocked.length - silent.length} of ${blocked.length} blocked saves showed a message: ${seen.join(' | ') || 'none'}` : 'every save went through, so no message was shown',
        'The save is blocked (or the value is changed) without telling the user why.');
    },
  },
  {
    name: 'listed as saved',
    pattern: /^it\s+should\s+be\s+listed\s+on\s+the\s+products\s+page\s+as\s+(active|inactive)\s+and\s+(simple|variable),\s+with\s+price\s+(৳[\d,.]+)$/i,
    check: async (t, m) => {
      const p = await savedProduct(t);
      if (!p) return t.skip('Listed on the Products page', 'Nothing was saved.');
      const rows = (t.noted.get('__listRows') as string[] | undefined) ?? [];
      const row = rows.find((r) => r.startsWith(p.name)) ?? '';
      const want = { active: /^active$/i.test(m[1]), type: m[2].toLowerCase(), price: Number(m[3].replace(/[৳,]/g, '')) };
      const ok = p.is_active === want.active && p.product_type === want.type && Number(p.price) === want.price && (!rows.length || !!row);
      t.check(`Listed as ${m[1]} and ${m[2]}, ৳${want.price.toFixed(2)}`, ok,
        `${p.is_active ? 'Active' : 'Inactive'}, ${p.product_type}, ৳${Number(p.price).toFixed(2)}${row ? `; list row: ${row}` : rows.length ? '; not found in the list' : ''}`);
    },
  },
  {
    name: 'storefront url from name',
    pattern: /storefront\s+(?:url|link)\s+should\s+be\s+created\s+from\s+the\s+name|^the\s+link\s+should\s+first\s+show\s+…?\/product\/(\S+)$|should\s+be\s+saved\s+with\s+a\s+unique\s+url/i,
    check: async (t, m, claim) => {
      const want = claim.match(/\/product\/([\w-]+)/)?.[1] ?? '';
      const link = (t.noted.get('__storefrontLink') as string | undefined) ?? '';
      const r = saves(t).filter((x) => x.saved).at(-1);
      if (/unique url/i.test(claim)) {
        const first = t.noted.get('__existing') as { slug?: string; name: string } | undefined;
        if (!first || !r) return t.skip(claim, 'The second product with the same name was not saved.');
        t.check('The second product gets its own link', !!r.slug && r.slug !== first.slug, `first /product/${first.slug}, second ${r.slug ? `/product/${r.slug}` : 'not saved'}`);
        return;
      }
      // "first show": the link read from the form before the slug was edited.
      const shown = /first show/i.test(claim) && link ? link.split('/product/')[1] ?? '' : r?.slug ?? link.split('/product/')[1] ?? '';
      if (!shown) return t.skip(claim, 'No storefront link was read.');
      const typed = r?.name ?? (t.noted.get('__typed:Product Name') as { typed: string } | undefined)?.typed ?? '';
      const expected = typed ? slugOf(typed) : `${slugOf(t.prefix)}-${want}`;
      t.check(`The link is made from the name (…/product/${want || expected})`, shown === expected || shown.endsWith(want), `link is /product/${shown}${typed ? ` for the name '${typed}'` : ''}`,
        'The slug is not derived from the product name.');
    },
  },
  {
    name: 'storefront link after edit',
    pattern: /storefront\s+page\s+should\s+open\s+at\s+…?\/product\/([\w-]+)|spaces\s+and\s+symbols\s+should\s+be\s+cleaned|duplicate\s+slug\s+should\s+not\s+be\s+allowed/i,
    check: async (t, m, claim) => {
      const typed = t.noted.get('__slugTyped') as { typed: string; link: string } | undefined;
      const r = lastSave(t);
      if (!typed) return t.skip(claim, 'The slug was not edited in the steps.');
      if (/duplicate/i.test(claim)) {
        t.check('A slug already used by another product is refused', !r?.saved || r.slug !== typed.typed, r?.saved ? `saved with /product/${r.slug} (typed "${typed.typed}")` : `not saved (${r ? why(r) : 'no save'})`);
        return;
      }
      if (/cleaned/i.test(claim)) {
        const clean = /^[a-z0-9-]+$/.test(r?.slug ?? typed.link.split('/product/')[1] ?? '');
        t.check('Spaces and symbols are cleaned or refused', clean || !r?.saved, `typed "${typed.typed}"; the link showed ${typed.link}; ${r ? saveLine(r) : 'not saved'}`,
          'The slug field keeps spaces and symbols as typed; clean them (my-soap) or refuse them.');
        return;
      }
      const sf = t.noted.get('__storefront') as { url: string; status: number | null; missing?: boolean } | undefined;
      t.check(`The saved link is …/product/${m[1]}`, (r?.slug ?? '').endsWith(m[1]), `saved slug ${r?.slug ?? '—'}${sf?.missing ? '; the storefront does not show new products right away, so the page itself was not checked' : ''}`);
    },
  },
  {
    name: 'long name limits',
    pattern: /^a\s+(\d+)-character\s+name\s+should\s+be\s+accepted$|^(\d+)\s+should\s+be\s+blocked\s+with\s+a\s+message$/i,
    check: async (t, m) => {
      const n = Number(m[1] ?? m[2]);
      const r = t.noted.get(`__long:${n}`) as { kept: number; saved: boolean; why: string } | undefined;
      if (!r) return t.skip(`${n}-character name`, 'That length was not tried in the steps.');
      if (m[1]) t.check(`A ${n}-character name is accepted`, r.saved && r.kept === n, `field kept ${r.kept} characters; ${r.saved ? 'saved' : `not saved (${r.why || 'no message'})`}`);
      else t.check(`A ${n}-character name is blocked with a message`, !r.saved && (!!r.why || r.kept < n), `field kept ${r.kept} characters; ${r.saved ? 'saved anyway' : `not saved (${r.why || 'no message'})`}`, 'Names longer than the limit are accepted.');
    },
  },
  {
    name: 'price edge values',
    pattern: /^price\s+0\s+should\s+be\s+blocked|^99\.999\s+should\s+be\s+rounded|^a\s+very\s+large\s+price\s+should/i,
    check: async (t, m, claim) => {
      const key = /^price 0/i.test(claim) ? '0' : /99\.999/.test(claim) ? '99.999' : '9999999999';
      const r = t.noted.get(`__price:${key}`) as SaveResult | undefined;
      if (!r) return t.skip(claim, `Price ${key} was not tried in the steps.`);
      const p = r.productId ? await t.api.getProduct(r.productId).catch(() => null) : null;
      const stored = p ? Number(p.price) : null;
      if (key === '0') t.check('Price 0 is blocked or warned about', !r.saved || r.messages.some((x) => /price|zero|0/i.test(x) && !/created/i.test(x)), r.saved ? `saved with price ৳${stored?.toFixed(2)}; message: ${r.messages.join(' | ') || 'none'}` : `not saved (${why(r)})`, 'A free product can be saved without any warning.');
      else if (key === '99.999') t.check('99.999 is rounded to 2 decimals', !r.saved || (stored !== null && Math.abs(stored * 100 - Math.round(stored * 100)) < 1e-6), r.saved ? `saved as ৳${p?.price}` : `not saved (${why(r)})`);
      else t.check('A very large price is limited or saved without breaking', !r.error || !r.saved, r.saved ? `saved as ৳${p?.price}` : `not saved (${why(r)})`);
    },
  },
  {
    name: 'name shown correctly',
    pattern: /^the\s+bangla\/emoji\s+name\s+should\s+be\s+saved\s+and\s+shown\s+correctly$|^the\s+script\s+text\s+should\s+be\s+shown\s+as\s+plain\s+text$/i,
    check: async (t, m, claim) => {
      const rec = t.noted.get(/bangla/i.test(claim) ? '__bangla' : '__script') as { typed: string; save: SaveResult } | undefined;
      if (!rec) return t.skip(claim, 'That name was not tried in the steps.');
      if (!rec.save.saved) return void t.check(claim.replace(/ should .*/, ' is saved'), false, `not saved (${why(rec.save)})`);
      const p = await t.api.getProduct(rec.save.productId!).catch(() => null);
      const rows = (t.noted.get('__listRows') as string[] | undefined) ?? [];
      const inList = rows.some((r) => r.startsWith(rec.typed));
      t.check(/bangla/i.test(claim) ? 'The Bangla/emoji name is saved unchanged' : 'The script text is saved as plain text', p?.name === rec.typed,
        `typed '${rec.typed}', saved '${p?.name ?? '?'}'${rows.length ? `; in the list: ${inList ? 'yes' : 'no'}` : ''}`);
    },
  },
  {
    name: 'no pop-up',
    pattern: /^no\s+pop-?up\s+should\s+run(?:\s+anywhere|\s+in\s+the\s+dashboard.*)?$/i,
    check: async (t) => {
      t.check('No pop-up ran', t.dialogsFired === 0, t.dialogsFired ? `${t.dialogsFired} browser pop-up(s) appeared` : 'no browser pop-up appeared on any page the bot opened', 'Text from the product name is run as code; escape it when showing it.');
    },
  },
  {
    name: 'profit per unit',
    pattern: /^profit\s+per\s+unit\s+should\s+(?:show\s+(−|-)?৳?(\d+)(?:\s+with\s+a\s+warning)?|update\s+instantly\s+while\s+typing)$/i,
    check: async (t, m, claim) => {
      const look = t.noted.get('__formLook') as { profit: string } | undefined;
      let profit = look?.profit ?? '';
      if (!profit) profit = (t.noted.get('__profitSeen') as string | undefined) ?? '';
      if (!profit) {
        const text = (await t.page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
        profit = text.match(/Profit per unit\s*(\S+(?:\s*·\s*[^A-Z]+?margin)?)/)?.[1] ?? '';
      }
      if (!profit) return t.skip(claim, 'No "Profit per unit" was found on the form.');
      if (/instantly/i.test(claim)) return void t.check('Profit per unit updates while typing', /\d/.test(profit), `shows ${profit}`);
      const want = `${m[1] ? '-' : ''}${m[2]}`;
      const shown = Number(profit.replace(/[^\d.-]/g, ' ').trim().split(/\s+/)[0]);
      const color = await t.page.evaluate(() => {
        const e = [...document.querySelectorAll('main *')].find((x) => x.children.length === 0 && /Profit per unit/.test((x as HTMLElement).innerText ?? ''));
        const v = e?.parentElement?.lastElementChild as HTMLElement | undefined;
        return v ? getComputedStyle(v).color : '';
      }).catch(() => '');
      const rgb = color.match(/\d+/g)?.map(Number) ?? [];
      const red = rgb.length >= 3 && rgb[0] > rgb[1] + 40;
      t.check(`Profit per unit shows ৳${want}`, Math.round(shown) === Number(want), `shows ${profit}`);
      if (/warning/i.test(claim)) t.check('A loss is shown as a warning', red || /loss|warning/i.test(profit), `shown in ${color || 'normal colour'}${red ? '' : ' (green, like a profit)'} with no warning text`, 'A negative profit is shown in green with no warning.');
    },
  },
  {
    name: 'saving still allowed',
    pattern: /^saving\s+should\s+still\s+be\s+allowed$/i,
    check: async (t, m, claim) => {
      const r = lastSave(t);
      if (!r) {
        const btn = t.page.getByRole('button', { name: /^\s*Save Product\s*$/ }).first();
        if (!(await btn.count())) return t.skip(claim, 'The form is no longer open.');
        return void t.check('Save stays available', await btn.isEnabled(), (await btn.isEnabled()) ? "'Save Product' is enabled" : "'Save Product' is disabled");
      }
      t.check('Saving is allowed', r.saved, saveLine(r));
    },
  },
  {
    name: 'dropdown options',
    pattern: /^options\s+should\s+be:?\s+(.+)$/i,
    check: async (t, m, claim) => {
      const list = [...t.noted.entries()].find(([k]) => k.startsWith('__options:'))?.[1] as string[] | undefined;
      if (!list) return t.skip(claim, 'No dropdown was opened in the steps.');
      const want = m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.replace(/\.$/, '').trim().toLowerCase());
      const got = list.map((x) => x.toLowerCase()).filter((x) => !/create new/.test(x));
      const missing = want.filter((w) => !got.includes(w));
      const extra = got.filter((g) => !want.includes(g));
      t.check(`Options: ${want.join(', ')}`, !missing.length && !extra.length, `shows ${list.join(', ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}`);
    },
  },
  {
    name: 'stock shown with unit',
    pattern: /^the\s+stock\s+should\s+be\s+shown\s+with\s+'(\w+)'\s+on\s+the\s+product\s+card$/i,
    check: async (t, m) => {
      const rows = (t.noted.get('__listRows') as string[] | undefined) ?? [];
      const p = await savedProduct(t);
      if (!p) return t.skip(`Stock shown in '${m[1]}'`, 'Nothing was saved.');
      const row = rows.find((r) => r.startsWith(p.name)) ?? '';
      t.check(`Stock is shown in '${m[1]}'`, new RegExp(`\\d\\s*${m[1]}\\b`, 'i').test(row), row ? `list shows: ${row}` : 'the product was not found in the list');
    },
  },
  {
    name: 'length counter',
    pattern: /^the\s+counters\s+should\s+update\s+\(x\/(\d+)\s+and\s+x\/(\d+)\)$|^typing\s+should\s+stop\s+at\s+(\d+)\s+and\s+(\d+)\s+characters$/i,
    check: async (t, m) => {
      const lengths = (t.noted.get('__lengths') as { label: string; typed: number; kept: number; counter: string }[] | undefined) ?? [];
      if (!lengths.length) return t.skip('Character counters', 'Nothing was typed in the counted fields.');
      const limits = [Number(m[1] ?? m[3]), Number(m[2] ?? m[4])];
      if (m[1]) {
        const ok = lengths.every((l) => /\d+\s*\/\s*\d+/.test(l.counter));
        t.check(`Counters show x/${limits[0]} and x/${limits[1]}`, ok && limits.every((n) => lengths.some((l) => l.counter.endsWith(`/${n}`))), lengths.map((l) => `${l.label}: ${l.counter || 'no counter'}`).join('; '));
      } else {
        const over = lengths.filter((l) => l.typed > (l.label === 'Meta Title' ? limits[0] : limits[1]));
        const bad = over.filter((l) => l.kept > (l.label === 'Meta Title' ? limits[0] : limits[1]));
        if (!over.length) return t.skip('Typing stops at the limit', 'No text longer than the limit was typed.');
        t.check(`Typing stops at ${limits[0]} and ${limits[1]} characters`, !bad.length, over.map((l) => `${l.label}: typed ${l.typed}, kept ${l.kept}`).join('; '));
      }
    },
  },
  {
    name: 'unsaved warning',
    pattern: /^an\s+'unsaved'\s+badge\s+should\s+appear|confirmation\s+box\s+\(stay\s*\/\s*leave\)\s+should\s+appear/i,
    check: async (t, m, claim) => {
      if (/badge/i.test(claim)) {
        const look = t.noted.get('__formLook') as { unsaved: boolean } | undefined;
        if (!look) return t.skip(claim, 'The form was not looked at after typing.');
        return void t.check("An 'Unsaved' badge appears", look.unsaved, look.unsaved ? "'Unsaved changes' is shown" : 'no badge');
      }
      const leave = t.noted.get('__leave') as { native: number; dialog: string; url: string } | undefined;
      if (!leave) return t.skip(claim, 'The bot did not leave the form in the steps.');
      t.check('A Stay / Leave box appears before leaving', leave.native > 0 || !!leave.dialog, leave.native || leave.dialog ? `asked: ${leave.dialog || 'browser confirm'}` : `no box; the page went straight to ${leave.url}`, 'Unsaved changes are lost without asking.');
    },
  },
  {
    name: 'one product only',
    pattern: /^only\s+one\s+product\s+should\s+be\s+created$|^the\s+button\s+should\s+be\s+disabled\s+while\s+saving$/i,
    check: async (t, m, claim) => {
      const n = (t.noted.get('__saveCount') as number | undefined) ?? 0;
      const all = saves(t);
      if (!all.length) return t.skip(claim, 'Save was not clicked.');
      if (/only one/i.test(claim)) return void t.check('Only one product is created', n === 1, `${n} product${n === 1 ? ' was' : 's were'} created`, 'A double click sends two create requests.');
      t.check('The button is disabled while saving', n <= 1, n <= 1 ? 'the second click did not create another product' : `${n} products were created, so the button was not disabled`);
    },
  },
  {
    name: 'sku saved',
    pattern: /^the\s+first\s+product\s+should\s+keep\s+sku\s+'([^']+)'$|^the\s+second\s+product\s+should\s+get\s+a\s+unique\s+sku\s+automatically$|^both\s+should\s+be\s+found\s+by\s+sku\s+search$/i,
    check: async (t, m, claim) => {
      const custom = t.noted.get('__skuCustom') as SaveResult | undefined;
      const auto = t.noted.get('__skuAuto') as SaveResult | undefined;
      if (m[1]) {
        if (!custom?.productId) return t.skip(claim, 'The product with that SKU was not saved.');
        const p = await t.api.getProduct(custom.productId);
        return void t.check(`SKU stays '${m[1]}'`, p.sku === m[1], `saved SKU ${p.sku}`);
      }
      if (/unique sku/i.test(claim)) {
        if (!auto?.productId) return t.skip(claim, 'The product without SKU was not saved.');
        const p = await t.api.getProduct(auto.productId);
        const clash = (await t.api.allProducts(`q=${encodeURIComponent(p.sku)}`)).filter((x) => x.sku === p.sku && x.id !== p.id);
        return void t.check('A unique SKU is given automatically', !!p.sku && !clash.length, `got SKU ${p.sku || '(empty)'}${clash.length ? `, also used by ${clash.map((x) => x.name).join(', ')}` : ''}`);
      }
      const found: string[] = [];
      for (const r of [custom, auto].filter(Boolean) as SaveResult[]) {
        const p = await t.api.getProduct(r.productId!);
        if ((await t.api.allProducts(`q=${encodeURIComponent(p.sku)}`)).some((x) => x.id === p.id)) found.push(p.sku);
      }
      t.check('Both are found by SKU search', found.length === [custom, auto].filter(Boolean).length && found.length > 0, `found by SKU: ${found.join(', ') || 'none'}`);
    },
  },
  {
    name: 'switch disabled with reason',
    pattern: /^the\s+switch\s+should\s+be\s+disabled$|^a\s+message\s+should\s+say\s+the\s+pre-order\s+addon\s+must\s+be\s+installed$/i,
    check: async (t, m, claim) => {
      const disabled = t.noted.get('__switchDisabled') as { name: string; why: string } | undefined;
      const text = (await t.page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (/disabled/i.test(claim)) return void t.check('The Pre-order switch is disabled', !!disabled, disabled ? `disabled: ${disabled.why}` : 'the switch could be turned on', 'The switch works even without the Pre-order addon.');
      const said = /addon|add-on|install/i.test(`${disabled?.why ?? ''} ${t.toasts.join(' ')} ${text.match(/Allow Pre-order.{0,200}/)?.[0] ?? ''}`);
      t.check('A message says the Pre-order addon is needed', said, said ? 'the form mentions the addon' : `no mention of the addon; near the switch: "${text.match(/Allow Pre-order.{0,140}/)?.[0] ?? ''}"`);
    },
  },
  {
    name: 'warning or unique url',
    pattern: /^or\s+a\s+warning\s+should\s+be\s+shown(?:\s+as\s+per\s+business\s+rule)?$|^(?:the\s+)?empty\s+specification\s+row\s+should\s+be\s+ignored\s+or\s+show\s+an\s+error$|^each\s+variant\s+should\s+keep\s+its\s+own\s+price,\s+sku\s+and\s+stock$|^'view\s+variants'\s+should\s+show\s+both$|^the\s+product\s+should\s+appear\s+first\s+when\s+sorted\s+by\s+'recently\s+updated'$/i,
    check: async (t, m, claim) => {
      const c = claim.toLowerCase();
      if (/^or a warning/.test(c)) {
        const r = lastSave(t);
        if (!r) return t.skip(claim, 'Nothing was saved.');
        const warn = r.messages.filter((x) => !/created|saved|updated/i.test(x));
        return t.note(warn.length ? `Warning shown: ${warn.join(' | ')}` : 'No warning was shown (this is the "or" part of the previous point).');
      }
      if (/empty specification/.test(c)) {
        const r = lastSave(t);
        const p = await savedProduct(t) as (Product & { specifications?: { label?: string; name?: string; value?: string }[] }) | null;
        if (!r) return t.skip(claim, 'Nothing was saved.');
        const empties = (p?.specifications ?? []).filter((x) => !(x.label ?? x.name) && !x.value).length;
        return void t.check('The empty specification row is ignored or refused', !r.saved || empties === 0, r.saved ? `saved with ${p?.specifications?.length ?? '?'} specification(s), ${empties} empty` : `not saved (${why(r)})`);
      }
      if (/recently updated/.test(c)) {
        const first = (t.noted.get('__recentFirst') as string | undefined) ?? '';
        const p = await savedProduct(t) ?? (t.noted.get('__editing') as Product | undefined) ?? null;
        if (!first || !p) return t.skip(claim, 'The list was not sorted by Recently updated.');
        const fresh = await t.api.getProduct(p.id);
        return void t.check("The product is first under 'Recently updated'", first === fresh.name, `first row: '${first}'`);
      }
      const p = await savedProduct(t);
      if (!p) return t.skip(claim, 'Nothing was saved.');
      const rows = (t.noted.get('__variations') as { name: string; sku: string; price: string; stock: string }[] | undefined) ?? [];
      if (/view variants/.test(c)) return void t.check('Both variants are saved', p.variants.length === 2, p.variants.map((v) => v.name).join(', ') || 'no variants');
      const off = p.variants.filter((v) => { const r = rows.find((x) => x.name === v.name); return r && r.price && Number(r.price) !== Number(v.price); });
      t.check('Each variant keeps its own price, SKU and stock', p.variants.length > 0 && !off.length, p.variants.map((v) => `${v.name}: ৳${v.price}, SKU ${v.sku}, stock ${v.stock}`).join('; '));
    },
  },
  {
    name: 'variations saved',
    pattern: /^the\s+product\s+should\s+be\s+saved\s+as\s+a\s+variable\s+product\s+with\s+(\d+)\s+variants$|^(\d+)\s+variations\s+should\s+be\s+generated:?\s+(.+)$|^all\s+skus\s+should\s+follow\s+the\s+same\s+pattern/i,
    check: async (t, m, claim) => {
      const rows = (t.noted.get('__variations') as { name: string; sku: string }[] | undefined) ?? [];
      if (m[2]) {
        const want = m[3].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.replace(/\.$/, '').trim().toLowerCase());
        const got = rows.map((r) => r.name.toLowerCase().replace(/\s*[/·,]\s*/g, '-').replace(/\s+/g, '-'));
        const missing = want.filter((w) => !got.some((g) => g.includes(w.toLowerCase()) || w.split('-').every((p) => g.includes(p))));
        return void t.check(`${m[2]} variations: ${want.join(', ')}`, rows.length === Number(m[2]) && !missing.length, `generated ${rows.length}: ${rows.map((r) => r.name).join(', ') || 'none'}`);
      }
      const p = await savedProduct(t);
      if (/same pattern/i.test(claim)) {
        const skus = p?.variants.map((v) => `${v.name}: ${v.sku}`) ?? rows.map((r) => `${r.name}: ${r.sku}`);
        const keepUnit = (p?.variants ?? rows.map((r) => ({ name: r.name, sku: r.sku }))).every((v) => v.sku.toUpperCase().includes(v.name.toUpperCase().replace(/\s+/g, '')));
        return void t.check('Every variant SKU keeps its unit', keepUnit && skus.length > 0, skus.join(', ') || 'no variants', "The SKU builder drops the unit from some values (e.g. '100' instead of '100G').");
      }
      if (!p) return t.skip(claim, 'Nothing was saved.');
      t.check(`Saved as a variable product with ${m[1]} variants`, p.product_type === 'variable' && p.variants.length === Number(m[1]), `${p.product_type}, ${p.variants.length} variants: ${p.variants.map((v) => `${v.name} ৳${v.price} stock ${v.stock}`).join(', ')}`);
    },
  },
  {
    name: 'one price for all',
    pattern: /^all\s+variations\s+should\s+be\s+saved\s+with\s+price\s+৳(\d+)$/i,
    check: async (t, m) => {
      const p = await savedProduct(t);
      if (!p) return t.skip(`All variations cost ৳${m[1]}`, 'Nothing was saved.');
      const prices = p.variants.map((v) => Number(v.price));
      t.check(`All variations cost ৳${m[1]}`, prices.length > 0 && prices.every((x) => x === Number(m[1])), prices.length ? p.variants.map((v) => `${v.name} ৳${v.price}`).join(', ') : 'no variants were saved');
    },
  },
  {
    name: 'switch back to simple',
    pattern: /^a\s+warning\s+should\s+ask\s+before\s+removing\s+the\s+variations$|^after\s+saving,\s+the\s+product\s+should\s+be\s+simple\s+with\s+no\s+hidden\s+variants\s+left$/i,
    check: async (t, m, claim) => {
      const sw = t.noted.get('__typeSwitch') as { hadVariations: boolean; asked: boolean } | undefined;
      if (/warning/i.test(claim)) {
        if (!sw) return t.skip(claim, 'The type was not switched in the steps.');
        return void t.check('A warning asks before removing the variations', sw.asked, sw.asked ? `asked: ${(t.noted.get('__typeSwitchDialog') as string | undefined) ?? 'browser confirm'}` : 'the variations were removed without asking', 'Switching to Simple drops the variations silently.');
      }
      const p = await savedProduct(t);
      if (!p) return t.skip(claim, 'Nothing was saved.');
      t.check('Saved as Simple with no variants', p.product_type === 'simple' && p.variants.length === 0, `${p.product_type}, ${p.variants.length} variant(s) stored`);
    },
  },
  {
    name: 'inline create',
    pattern: /^each\s+new\s+item\s+should\s+be\s+created\s+and\s+selected\s+automatically$|^a\s+duplicate\s+should\s+not\s+be\s+created$/i,
    check: async (t, m, claim) => {
      const made = [...t.noted.entries()].filter(([k]) => k.startsWith('__created:')).map(([, v]) => v as { kind: string; name: string; existing: boolean; before: string[]; after: string[]; selected: string; messages: string[] });
      if (!made.length) return t.skip(claim, 'Nothing was created from a dropdown in the steps.');
      if (/duplicate/i.test(claim)) {
        for (const c of made.filter((x) => x.existing)) {
          const count = c.after.filter((o) => o.toLowerCase() === c.name.toLowerCase()).length;
          t.check(`No duplicate ${c.kind} '${c.name}'`, count <= 1, `${count} '${c.name}' in the list afterwards${c.messages.length ? `; message: ${c.messages.join(' | ')}` : ''}`, 'Creating an existing name adds a second entry.');
        }
        return;
      }
      for (const c of made.filter((x) => !x.existing)) {
        const created = c.after.some((o) => o === c.name);
        // Labels is a multi-select: it shows "1 selected" instead of the name.
        const selected = c.selected.includes(c.name) || (c.kind === 'label' && /^\s*[1-9]\d* selected\s*$/i.test(c.selected));
        t.check(`New ${c.kind} '${c.name}' is created and selected`, created && selected, `${created ? 'created' : 'not in the list'}; selected: '${c.selected}'`);
      }
    },
  },
  {
    name: 'uploads',
    pattern: /^previews\s+should\s+appear$|^the\s+counter\s+should\s+show\s+the\s+correct\s+number$|^at\s+8\s+images\s+the\s+upload\s+button\s+should\s+be\s+disabled$|^each\s+upload\s+should\s+be\s+rejected|^no\s+broken\s+image\s+should\s+be\s+added$|^the\s+\d+(?:\.\d+)?mb\s+image\s+should\s+be\s+accepted$|^the\s+wide\s+image\s+should\s+open\s+a\s+cropper|^should\s+not\s+look\s+stretched$|^webp\s+should\s+be\s+accepted\s+the\s+same\s+way\s+everywhere$|^the\s+order\s+and\s+removal\s+should\s+be\s+saved$/i,
    check: async (t, m, claim) => {
      type Up = { spec: string; kind: string; target: string; accepted: boolean; before: number; after: number; cropper: string; messages: string[]; disabled: boolean };
      const ups = (t.noted.get('__uploads') as Up[] | undefined) ?? [];
      if (!ups.length) return t.skip(claim, 'No file was uploaded in the steps.');
      const c = claim.toLowerCase();
      const good = ups.filter((u) => /square|wide|mb/.test(u.spec) && !/5mb/.test(u.spec));
      if (/previews/.test(c)) return void t.check('A preview appears for each valid image', good.every((u) => u.accepted), good.map((u) => `${u.kind}: ${u.accepted ? 'added' : 'not added'}`).join('; '));
      if (/counter/.test(c)) {
        const last = ups.filter((u) => u.target === 'gallery').at(-1);
        const accepted = ups.filter((u) => u.target === 'gallery' && u.accepted).length;
        return void t.check('The gallery counter matches the images added', !!last && last.after === Math.min(8, accepted), `counter shows ${last?.after ?? '?'} of 8 after ${accepted} accepted upload(s)`);
      }
      if (/at 8/.test(c)) {
        const full = ups.some((u) => u.target === 'gallery' && u.after >= 8);
        if (!full) return t.skip(claim, 'The gallery never reached 8 images.');
        const extra = ups.find((u) => u.target === 'gallery' && u.before >= 8);
        const offered = t.noted.get('__galleryFullUpload') as boolean | undefined;
        const blocked = extra ? !extra.accepted : offered === false;
        return void t.check('Upload is not possible at 8 images', blocked, extra ? `a 9th image: ${extra.disabled ? 'no upload offered' : extra.accepted ? 'ADDED' : 'refused'}${extra.messages.length ? ` ("${extra.messages.join(' | ')}")` : ''}` : offered === false ? 'at 8 of 8 the gallery shows no upload box' : 'at 8 of 8 the upload box is still there');
      }
      if (/rejected with a clear reason/.test(c)) {
        // The bad files themselves, plus a 9th image when the gallery was already full.
        const bad = ups.filter((u) => /5mb|gif|pdf|exe/.test(u.spec) || (u.target === 'gallery' && u.before >= 8));
        // A full gallery that no longer offers an upload counts as a clear limit.
        const silent = bad.filter((u) => u.accepted || (!u.messages.length && !u.disabled));
        return void t.check('Each bad file is refused with a reason', bad.length > 0 && !silent.length, bad.map((u) => `${u.kind}: ${u.accepted ? 'ACCEPTED' : u.disabled ? 'upload not offered (gallery full)' : 'refused'}${u.messages.length ? ` ("${u.messages.join(' | ')}")` : u.disabled ? '' : u.cropper ? ` (${u.cropper}, no message)` : ' (no message)'}`).join('; '), 'Some bad files are refused without saying why (or are accepted).');
      }
      if (/broken/.test(c)) {
        const broken = await t.page.evaluate(() => [...document.querySelectorAll('main img')].filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 0 && i.getClientRects().length).length).catch(() => 0);
        return void t.check('No broken image is added', broken === 0, broken ? `${broken} broken image(s) on the form` : 'no broken images');
      }
      if (/mb image should be accepted/.test(c)) {
        const u = ups.find((x) => /\dmb/.test(x.spec));
        if (!u) return t.skip(claim, 'That size was not uploaded.');
        return void t.check(`${u.kind} is accepted`, u.accepted, `${u.accepted ? 'accepted' : 'refused'}${u.messages.length ? ` ("${u.messages.join(' | ')}")` : ''}`);
      }
      if (/cropper|stretched/.test(c)) {
        const u = ups.find((x) => /wide|16:9/.test(x.spec));
        if (!u) return t.skip(claim, 'No wide image was uploaded.');
        return void t.check('A wide image opens a cropper or a warning', /cropper opened/.test(u.cropper) || u.messages.length > 0, u.cropper || u.messages.join(' | ') || 'no cropper, no warning');
      }
      if (/webp/.test(c)) {
        const w = ups.filter((x) => /webp/.test(x.spec));
        if (w.length < 2) return t.skip(claim, 'WEBP was not uploaded in both places.');
        return void t.check('WEBP is accepted the same way everywhere', w.every((x) => x.accepted) || w.every((x) => !x.accepted), w.map((x) => `${x.target}: ${x.accepted ? 'accepted' : `refused${x.messages.length ? ` ("${x.messages.join(' | ')}")` : ''}`}`).join('; '), 'The Gallery refuses WEBP while the SEO image and Thumbnail accept it.');
      }
      const removed = t.noted.get('__galleryRemoved') as { before: number; after: number } | undefined;
      const p = saves(t).filter((r) => r.saved).at(-1);
      if (!removed || !p?.productId) return t.skip(claim, 'Images were not removed and saved in the steps (reordering cannot be checked).');
      const prod = await t.api.getProduct(p.productId) as unknown as { gallery?: unknown[] };
      t.check('The removal is saved', (prod.gallery?.length ?? -1) === removed.after, `form had ${removed.after} images after removing one; saved product has ${prod.gallery?.length ?? '?'}`);
    },
  },
  {
    name: 'stock after sale',
    pattern: /^the\s+first\s+product\s+should\s+start\s+with\s+(\d+)\s+in\s+main\s+warehouse\s+and\s+go\s+down\s+to\s+(\d+)\s+after\s+the\s+sale$|^the\s+second\s+product'?s\s+stock\s+should\s+not\s+change$|^it\s+should\s+not\s+appear\s+in\s+low-stock\s+alerts$/i,
    check: async (t, m, claim) => {
      const sales = (t.noted.get('__sales') as { product: string; before: number | null; after: number | null }[] | undefined) ?? [];
      if (m[1]) {
        const s0 = sales[0];
        if (!s0) return t.skip(claim, 'No sale was made in the steps.');
        return void t.check(`Stock goes ${m[1]} → ${m[2]} after selling 1`, s0.before === Number(m[1]) && s0.after === Number(m[2]), `stock ${s0.before} → ${s0.after}`);
      }
      const second = t.noted.get('__secondProduct') as SaveResult | undefined;
      if (!second?.productId) return t.skip(claim, 'The second product was not saved.');
      const p = await t.api.getProduct(second.productId);
      if (/not change/i.test(claim)) {
        const sale = sales.find((x) => x.product === second.name);
        return void t.check("The untracked product's stock does not change", !sale || sale.before === sale.after, sale ? `stock ${sale.before} → ${sale.after}` : `stock ${p.stock}`);
      }
      t.check('The untracked product is not a low-stock alert', !p.is_low_stock && !p.is_out_of_stock, `low stock: ${p.is_low_stock}, out of stock: ${p.is_out_of_stock}`);
    },
  },
  {
    name: 'tracking required',
    pattern: /^batch\s+number\s+and\s+expiry\s+date\s+should\s+be\s+required|^one\s+serial\s+number\s+per\s+unit\s+\((\d+)\)\s+should\s+be\s+required/i,
    check: async (t, m, claim) => {
      const which = /batch/i.test(claim) ? 'first' : 'second';
      const r = t.noted.get(`__stockIn:${which}`) as { asks: { batch: boolean; expiry: boolean; serial: boolean }; blocked: boolean; messages: string[]; stock: number | null; text: string } | undefined;
      if (!r) return t.skip(claim, 'Stock was not added in the steps.');
      const asked = which === 'first' ? r.asks.batch && r.asks.expiry : r.asks.serial;
      t.check(which === 'first' ? 'Batch and expiry are asked for when stocking in' : 'A serial number per unit is asked for', asked,
        `the Stock In dialog ${asked ? 'asks for them' : 'does not ask'}; ${r.blocked ? 'saving was blocked' : `saved, stock now ${r.stock}`}`, 'Tracking is turned on but the stock-in dialog does not collect batch/expiry or serial numbers.');
    },
  },
  {
    name: 'hidden from storefront and pos',
    pattern: /^neither\s+product\s+should\s+appear\s+on\s+the\s+storefront\s+or\s+in\s+pos$|^the\s+draft\s+should\s+appear\s+under\s+the\s+draft\s+tab/i,
    check: async (t, m, claim) => {
      const vis = (t.noted.get('__visibility') as { name: string; storefront: boolean; pos: boolean }[] | undefined) ?? [];
      if (/draft tab/i.test(claim)) {
        const second = t.noted.get('__second') as SaveResult | undefined;
        if (!second?.saved) return t.skip(claim, "The draft product was not saved (the form has no 'Draft' button).");
        const p = await t.api.getProduct(second.productId!);
        return void t.check('The draft is under the Draft tab', !p.is_active, p.is_active ? 'saved as Active' : 'saved as not active');
      }
      if (!vis.length) return t.skip(claim, 'The products were not looked up in the steps.');
      const shown = vis.filter((v) => v.storefront || v.pos);
      t.check('Hidden products are not on the storefront or in POS', !shown.length, vis.map((v) => `'${v.name}': storefront ${v.storefront ? 'SHOWS it' : 'hidden'}, POS ${v.pos ? 'SHOWS it' : 'hidden'}`).join('; '), 'Inactive products are still offered to customers or at the counter.');
    },
  },
  {
    name: 'wholesale price in pos',
    pattern: /^in\s+pos,\s+the\s+unit\s+price\s+should\s+change\s+to\s+৳(\d+)/i,
    check: async (t, m, claim) => {
      const cart = t.noted.get('__posCart') as { qty: number; unit: number } | undefined;
      if (!cart) return t.skip(claim, 'The product was not added in POS.');
      t.check(`At ${cart.qty} units the POS price is ৳${m[1]}`, cart.unit === Number(m[1]), `POS shows ৳${cart.unit || '?'} per unit for ${cart.qty} units`, 'The wholesale tier is saved but POS keeps the normal price.');
    },
  },
  {
    name: 'saved fields shown',
    pattern: /^the\s+saved\s+product\s+should\s+show\s+the\s+new\s+category,\s+brand\s+and\s+label$|^every\s+value\s+entered\s+should\s+be\s+shown\s+correctly|^all\s+fields,\s+variants\s+and\s+images\s+should\s+be\s+filled\s+in\s+with\s+the\s+saved\s+values$|^the\s+specification\s+and\s+the\s+q&a\s+should\s+be\s+shown\s+on\s+the\s+product\s+page$|^the\s+storefront\s+should\s+show\s+৳(\d+)\s+crossed\s+out\s+and\s+৳(\d+)/i,
    check: async (t, m, claim) => {
      const p = await savedProduct(t) as (Product & Record<string, unknown>) | null;
      const editing = t.noted.get('__editing') as Product | undefined;
      if (/filled in with the saved values/i.test(claim)) {
        if (!editing) return t.skip(claim, 'No edit form was opened.');
        const full = await t.api.getProduct(editing.id);
        const ef = (t.noted.get('__editForm') as Record<string, string> | undefined) ?? {};
        const form = ef.__text ?? '';
        const nameVal = ef['Product Name'] || ef.__name || '';
        const price = Number(String(ef['Selling Price'] ?? '').replace(/,/g, ''));
        const missing = [
          nameVal === full.name ? '' : `name (form "${nameVal}", saved "${full.name}")`,
          !full.price || price === Number(full.price) ? '' : `price (form ${ef['Selling Price']}, saved ${full.price})`,
          !full.sku || form.includes(full.sku) || ef.SKU === full.sku ? '' : `SKU ${full.sku}`,
          ...full.variants.filter((v) => !form.includes(v.name)).map((v) => `variant ${v.name}`),
        ].filter(Boolean);
        return void t.check('The edit form shows the saved values', !missing.length, missing.length ? `not filled: ${missing.join(', ')}` : `name, SKU${full.variants.length ? ` and ${full.variants.length} variants` : ''} match`);
      }
      if (!p) return t.skip(claim, 'Nothing was saved.');
      const sf = t.noted.get('__storefront') as { text: string; status: number | null; missing?: boolean } | undefined;
      const notYet = 'The storefront did not show the new product yet ("We could not find that page"); new products take a while to appear there, so check it by hand.';
      if (m[1]) {
        if (!sf) return t.skip(claim, 'The storefront page was not opened.');
        if (sf.missing) return t.skip(claim, notYet);
        // Only the product's own block (before "You May Also Like"), so other products' prices don't count.
        const own = sf.text.split(/You May Also Like|Related products/i)[0];
        const prices = own.match(/৳\s*[\d,]+(?:\.\d+)?/g)?.map((x) => Number(x.replace(/[৳,\s]/g, ''))) ?? [];
        const both = prices.includes(Number(m[1])) && prices.includes(Number(m[2]));
        return void t.check(`Storefront shows ৳${m[1]} crossed out and ৳${m[2]}`, both, `the product page shows ${prices.length ? prices.map((x) => `৳${x}`).join(', ') : 'no prices'}${sf.status && sf.status >= 400 ? ` (page answered ${sf.status})` : ''}`, 'The storefront does not show the discount price next to the regular price.');
      }
      if (/category, brand and label/i.test(claim)) {
        const made = [...t.noted.entries()].filter(([k]) => k.startsWith('__created:')).map(([, v]) => v as { kind: string; name: string });
        const got = { category: p.category?.name ?? '—', brand: p.brand?.name ?? '—', label: ((p.labels as { name: string }[] | undefined) ?? []).map((l) => l.name).join(', ') || '—' };
        const wrong = made.filter((c) => !(got[c.kind as keyof typeof got] ?? '').includes(c.name));
        return void t.check('The saved product has the new category, brand and label', made.length > 0 && !wrong.length, `category ${got.category}, brand ${got.brand}, labels ${got.label}`);
      }
      if (/specification/i.test(claim)) {
        const spec = (t.noted.get('__spec') as [string, string][] | undefined)?.filter(([a]) => a) ?? [];
        const qa = (t.noted.get('__qa') as [string, string][] | undefined) ?? [];
        const text = sf?.text ?? '';
        const missing = [...spec.map(([a, b]) => `${a}: ${b}`), ...qa.map(([q]) => q)].filter((x) => !text.toLowerCase().includes(x.split(':')[0].toLowerCase()));
        if (!sf) return t.skip(claim, 'The storefront page was not opened.');
        if (sf.missing) return t.skip(claim, notYet);
        return void t.check('Specification and Q&A show on the product page', !missing.length, missing.length ? `not on the page: ${missing.join(', ')}` : 'both are shown');
      }
      const data = (await import('./form-data.js')).formValues(t.tc.testData);
      const checks: [string, string, string][] = [
        ['price', data['Selling Price'] ?? '', String(Number(p.price))],
        ['category', data.Category ?? '', p.category?.name ?? ''],
        ['brand', data.Brand ?? '', p.brand?.name ?? ''],
        ['SKU', data.SKU ?? '', p.sku],
        ['unit', data.Unit ?? '', String(p.unit ?? '')],
      ].filter(([, want]) => want) as [string, string, string][];
      // Values the store did not have were created with the case prefix (e.g. 'BTB AP-002 Hair Care').
      const wrong = checks.filter(([, want, got]) => String(Number(want)) !== got && want.toLowerCase() !== got.toLowerCase() && got.toLowerCase() !== `${t.prefix} ${want}`.toLowerCase());
      t.check('The saved values match what was entered', !wrong.length, wrong.length ? wrong.map(([k, w, g]) => `${k}: entered "${w}", saved "${g || '—'}"`).join('; ') : checks.map(([k, , g]) => `${k} ${g}`).join(', '));
    },
  },
  {
    name: 'number field rejects text',
    pattern: /^text\s+should\s+not\s+be\s+allowed\s+in\s+number\s+fields$/i,
    check: async (t) => {
      const tries = ((t.noted.get('__invalidTries') as { field: string; value: string; kept: string }[] | undefined) ?? []).filter((x) => /[a-z]/i.test(x.value));
      if (!tries.length) return t.skip('Text is not allowed in number fields', 'No text was typed in a number field.');
      const let_ = tries.filter((x) => /[a-z]/i.test(x.kept));
      t.check('Text is not allowed in number fields', !let_.length, tries.map((x) => `${x.field}: typed "${x.value}", kept "${x.kept}"`).join('; '));
    },
  },
  {
    name: 'tax on the order',
    pattern: /^(exclusive|inclusive):\s+customer\s+should\s+pay\s+৳([\d.]+)/i,
    check: async (t, m, claim) => {
      const rates = (t.noted.get('__taxRates') as string[] | undefined) ?? [];
      const sales = (t.noted.get('__sales') as { total: string; tax: string }[] | undefined) ?? [];
      if (rates.length && rates.every((r) => /create new/i.test(r))) return t.skip(claim, 'This store has no tax rate to choose (the list only offers "Create new tax rate"), so tax could not be tested. Add a 5% tax rate and run it again.');
      if (!sales.length) return t.skip(claim, 'No test order was placed.');
      const sale = /inclusive/i.test(m[1]) ? sales.at(-1)! : sales[0];
      t.check(`${m[1]}: the customer pays ৳${m[2]}`, Number(sale.total.replace(/,/g, '')) === Number(m[2]), `order total ৳${sale.total}${sale.tax ? `, tax ৳${sale.tax}` : ''}`);
    },
  },
  {
    name: 'variation grid',
    pattern: /^all\s+(\d+)\s+rows\s+should\s+get\s+stock\s+(\d+)$|^a\s+new\s+empty\s+row\s+should\s+be\s+added\s+and\s+then\s+removed$|^the\s+variation\s+count\s+should\s+update\s+each\s+time$/i,
    check: async (t, m, claim) => {
      if (m[1]) {
        const b = t.noted.get('__bulkStock') as { want: string; rows: string[] } | undefined;
        if (!b) return t.skip(claim, 'Bulk stock was not applied.');
        return void t.check(`All ${m[1]} rows get stock ${m[2]}`, b.rows.length === Number(m[1]) && b.rows.every((r) => r === m[2]), `rows show: ${b.rows.join(', ') || 'none'}`);
      }
      const counts = (t.noted.get('__rowCounts') as number[] | undefined) ?? [];
      if (counts.length < 3) return t.skip(claim, 'A row was not added and removed.');
      t.check('A row is added and then removed', counts[1] === counts[0] + 1 && counts[2] === counts[0], `rows ${counts.join(' → ')}`);
    },
  },
  {
    name: 'write with ai',
    pattern: /^relevant\s+text\s+should\s+be\s+generated$|^should\s+be\s+editable$|^the\s+formatting\s+should\s+show\s+on\s+the\s+storefront$|^without\s+a\s+name,\s+a\s+message\s+should\s+ask\s+to\s+enter\s+the\s+name\s+first$/i,
    check: async (t, m, claim) => {
      const c = claim.toLowerCase();
      if (/relevant/.test(c)) return t.skip(claim, 'Not generated: each Write with AI run is charged to the store wallet, and whether text is "relevant" is a judgement call. Try it once by hand.');
      if (/editable/.test(c)) {
        const e = t.noted.get('__aiEdited') as { bold: boolean; list: boolean } | undefined;
        if (!e) return t.skip(claim, 'The text was not edited.');
        return void t.check('The generated text can be edited (bold and list)', e.bold && e.list, `bold ${e.bold ? 'applied' : 'not applied'}, list ${e.list ? 'added' : 'not added'}`);
      }
      if (/storefront/.test(c)) {
        const sf = t.noted.get('__storefront') as { text: string; missing?: boolean } | undefined;
        if (!sf) return t.skip(claim, 'The storefront page was not opened.');
        if (sf.missing) return t.skip(claim, 'The storefront did not show the new product yet; check the formatting there by hand.');
        return void t.check('The formatting shows on the storefront', /BTB bold line/.test(sf.text) && /BTB list item/.test(sf.text), /BTB bold line/.test(sf.text) ? 'the edited text is on the page' : 'the edited text is not on the page');
      }
      const box = t.noted.get('__aiNoName') as { opened: boolean; prompt: string; canGenerate: boolean; messages: string[] } | undefined;
      if (!box) return t.skip(claim, 'Write with AI was not tried without a name.');
      t.check('Without a name, it asks for the name first', box.messages.some((x) => /name/i.test(x)) || (box.opened && !box.canGenerate),
        box.messages.length ? `message: ${box.messages.join(' | ')}` : box.opened ? `the box opened ${box.prompt ? `with "${box.prompt}"` : 'empty'} and Generate is ${box.canGenerate ? 'enabled' : 'disabled'}; no message about the name` : 'nothing happened');
    },
  },
  {
    name: 'stock history',
    pattern: /^the\s+stock\s+change\s+should\s+be\s+recorded\s+in\s+the\s+stock\s+history$/i,
    check: async (t, m, claim) => {
      const edit = t.noted.get('__stockEdit') as { from: number; to: number } | undefined;
      const r = saves(t).filter((x) => x.saved).at(-1);
      const id = r?.productId ?? (t.noted.get('__editing') as Product | undefined)?.id;
      if (!edit || !id) return t.skip(claim, 'Stock was not changed and saved.');
      const moves = await t.api.stockMovements(id).catch(() => []);
      const hit = moves.find((x) => Math.abs(x.quantity) === Math.abs(edit.to - edit.from));
      t.check('The stock change is in the stock history', !!hit, hit ? `history: ${hit.type} ${hit.quantity} (${hit.reason ?? '—'})` : `no movement of ${edit.to - edit.from}; latest: ${moves.slice(0, 3).map((x) => `${x.type} ${x.quantity}`).join(', ') || 'none'}`);
    },
  },
  {
    name: 'not automatable',
    pattern: /^the\s+user\s+should\s+be\s+taken\s+to\s+login\s+with\s+a\s+clear\s+message$|^the\s+product\s+should\s+not\s+be\s+half-saved$|^the\s+second\s+save\s+should\s+warn|^the\s+system\s+should\s+block\s+it\s+or\s+archive\s+the\s+variant$|^old\s+orders\s+should\s+still\s+show\s+it$|^saving\s+a\s+deleted\s+product\s+should\s+show\s+'product\s+not\s+found'$/i,
    check: async (t, m, claim) => {
      const why = /login|half-saved/i.test(claim)
        ? 'Logging out in another tab would also log the bot out for the rest of the run, so session expiry is checked by hand.'
        : /second save|deleted product/i.test(claim) ? 'Saving the same product from two tabs at once is checked by hand.' : 'Deleting a variant that real orders use would change store data; checked by hand.';
      t.skip(claim, why);
    },
  },
];

function formName(t: CaseContext): string | null {
  const typed = t.noted.get('__typed:Product Name') as { typed: string } | undefined;
  return typed?.typed ?? null;
}
