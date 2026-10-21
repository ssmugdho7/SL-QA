import type { CaseContext } from '../context.js';
import type { ExpectRule } from './expects.js';
import { positionLabels, readTotal, sortDifferently, type SortResult } from './natural.js';

/**
 * Checks for expected results written as behaviour ("should block inputs that exceed the total", "titles should wrap",
 * "the panel should be collapsible", "numbers should follow the cards after sorting"). Each one measures the page
 * and reports the numbers it saw, so a person can judge the verdict.
 */

interface Typed { value: number; kept: string; totalBefore: number | null; totalAfter: number | null; messages: string[] }

function savedOrder(t: CaseContext): string {
  const o = t.noted.get('__order') as { reference: string; total: string; discount?: string } | undefined;
  return o ? `; the order was saved anyway as ${o.reference} with total ৳${o.total} and discount ৳${o.discount ?? '?'}` : '';
}

const taka = (n: number | null) => (n === null ? '?' : `৳${n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const NEGATED = /\b(?:no|without|not|never)\s+(?:any\s+)?(?:\w+\s+)?(?:errors?|alerts?|warnings?)\b/i;

async function visibleMessages(t: CaseContext): Promise<string[]> {
  const now = await t.page.evaluate(() => [...document.querySelectorAll('[data-sonner-toast], [role=alert]')].filter((e) => e.getClientRects().length).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
  return [...new Set([...t.toasts, ...now].filter(Boolean))];
}

export const BEHAVIOUR_RULES: ExpectRule[] = [
  {
    name: 'input limit',
    pattern: /\b(?:block|reject|prevent|refuse|limit|cap|restrict|validate|stop|disallow|not (?:accept|allow))\w*\b.*\b(?:exceed|more than|higher than|greater than|above|over|larger than|bigger than|beyond|max)/i,
    check: async (t, m, claim) => {
      const typed = t.noted.get('__typed') as Typed | undefined;
      if (!typed) return t.skip(claim, 'No value was typed in an earlier step, so there was nothing to block. Add a step like "Type a value that exceeds the total".');
      const keptNumber = Number(typed.kept.replace(/[^\d.-]/g, ''));
      const refused = typed.kept === '' || keptNumber < typed.value;
      const warned = typed.messages.length > 0;
      const limit = typed.totalBefore;
      const over = limit !== null && typed.value > limit;
      t.check(
        `A value above the total (${typed.value}${limit !== null ? ` > ${taka(limit)}` : ''}) is blocked or warned about`,
        refused || warned || !over,
        `${refused ? `the field kept "${typed.kept}" instead` : `the field accepted ${typed.value}`}; Total ${taka(typed.totalBefore)} → ${taka(typed.totalAfter)}; ${warned ? `message: ${typed.messages.join(' | ')}` : 'no message shown'}${savedOrder(t)}`,
        'The amount field has no upper limit: cap it at the subtotal (or reject the value) and show a message when the typed amount is larger.',
      );
    },
  },
  {
    name: 'alert message shown',
    pattern: /(?=^(?![^]*\b(?:no|without|not|never)\s+(?:any\s+)?(?:\w+\s+)?(?:errors?|alerts?|warnings?)\b))(?:[^]*\b(?:alert|error|warning|validation|toast|pop-?up)\b[^]*\b(?:should|must)\b[^]*\b(?:appear|show|shown|display|displayed|pop up|be seen)\b|[^]*\b(?:should|must)\b[^]*\b(?:show|display|give|raise|see|get|throw)\b[^]*\b(?:alert|error|warning|validation)\b)/i,
    check: async (t, m, claim) => {
      if (NEGATED.test(claim)) return t.skip(claim, 'Reads as "no error"; checked by page health instead.');
      const typed = t.noted.get('__typed') as Typed | undefined;
      const seen = typed ? typed.messages : await visibleMessages(t);
      t.check(
        typed ? `A message appears after typing ${typed.value}` : 'An alert or error message is shown',
        seen.length > 0,
        seen.length ? seen.join(' | ').slice(0, 200) : `no toast, alert, red helper text or invalid-field mark appeared${typed ? ` (Total became ${taka(typed.totalAfter)})` : ''}`,
        'Nothing tells the user the value is wrong; show an inline error or toast when validation fails.',
      );
    },
  },
  {
    name: 'receipt balance',
    pattern: /\b(?:receipt|invoice|saved order|order total|balance)\b.*\b(?:should|must)\b.*\b(?:correct|right|match|not (?:be )?(?:zero|negative|0|confusing))/i,
    check: async (t, m, claim) => {
      const o = t.noted.get('__order') as { reference: string; total: string; discount?: string } | undefined;
      if (!o) return t.skip(claim, 'No order was placed in the steps, so there is no receipt to read.');
      t.check(`Saved order ${o.reference} has a positive total`, Number(o.total) > 0, `total ৳${o.total}, discount ৳${o.discount ?? '?'}`);
    },
  },
  {
    name: 'total stays above zero',
    pattern: /\b(?:total|balance|amount due|rider collects|grand total|payable)\b.*\b(?:should|must)\b.*\b(?:not be ['‘]?৳?\s*0|not (?:be )?(?:zero|negative)|be (?:more|greater|higher) than ['‘]?(?:৳\s*)?0|stay (?:positive|above)|never (?:be )?(?:negative|zero|0))/i,
    check: async (t, m, claim) => {
      const typed = t.noted.get('__typed') as Typed | undefined;
      const total = typed?.totalAfter ?? (await readTotal(t));
      if (total === null) return t.skip(claim, 'No "Total" amount was found on the page.');
      t.check('Total stays above ৳0', total > 0, `Total is ${taka(total)}${typed ? ` after typing ${typed.value}` : ''}`, 'A discount larger than the subtotal brings the total to zero or below; cap the discount.');
    },
  },
  {
    name: 'text not clipped',
    pattern: /\b(?:titles?|names?|text|labels?|headings?)\b.*\b(?:should|must)\b.*\b(?:wrap|readable|fully (?:visible|shown)|in full|full (?:\w+ )?name|not (?:be )?(?:cut|clipped|truncated|hidden)|two lines|2 lines)/i,
    check: async (t, m, claim) => {
      const lines = Number(claim.match(/\b(?:up to |to )?(\d|two|three)\s+lines?\b/i)?.[1]?.replace('two', '2').replace('three', '3') ?? 0);
      const r = await t.page.evaluate(() => {
        const v = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < innerHeight * 3; };
        const out: { text: string; clamp: string }[] = [];
        let looked = 0;
        for (const e of document.querySelectorAll('main *, body:not(:has(main)) *')) {
          const el = e as HTMLElement;
          // Only text inside content (cards, rows), not toolbar buttons or pickers like 'Main Warehouse'.
          if (el.children.length > 1 || !v(el) || el.closest('button, [role=button], [role=combobox], header, nav, [role=dialog]')) continue;
          const text = (el.getAttribute('title') || el.innerText || '').trim();
          if (text.length < 12 || text.length > 200 || /৳|\d+\s*(?:in stock|pcs)/.test(text)) continue;
          const cs = getComputedStyle(el);
          const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' ? cs.webkitLineClamp : '';
          const nowrap = cs.whiteSpace === 'nowrap' && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis');
          if (!clamp && !nowrap) continue;
          looked++;
          if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) out.push({ text, clamp: clamp ? `${clamp} line${clamp === '1' ? '' : 's'}` : 'one line, cut with …' });
        }
        return { looked, cut: out };
      }).catch(() => ({ looked: 0, cut: [] as { text: string; clamp: string }[] }));
      if (!r.looked) return t.skip(claim, 'No shortened text was found on the page to judge.');
      const maxLines = r.cut.map((c) => Number(c.clamp.match(/^\d+/)?.[0] ?? 1));
      const ok = !r.cut.length || (lines > 0 && maxLines.every((n) => n >= lines));
      await t.shot('clipped text');
      t.check(
        lines ? `Names wrap up to ${lines} lines and stay readable` : 'Names are shown in full',
        ok,
        r.cut.length ? `${r.cut.length} of ${r.looked} names are cut off (limited to ${[...new Set(r.cut.map((c) => c.clamp))].join(', ')}), e.g. ${r.cut.slice(0, 3).map((c) => `'${c.text.slice(0, 60)}'`).join(', ')}` : `all ${r.looked} names fit`,
        'The name is limited to one line (line-clamp-1); allow 2 lines (line-clamp-2) or show the full name on hover.',
      );
    },
  },
  {
    name: 'panel uses space well',
    pattern: /\b(?:panel|sidebar|drawer|cart|column|section)\b.*\b(?:collaps|hid(?:e|den|able)|minimi[sz]|empty (?:screen )?space|wasted space|full[- ]width|expand)|\b(?:grid|catalog(?:ue)?|layout|list)\b.*\b(?:full[- ]width|expand|responsive|use the (?:full|whole))/i,
    check: async (t, m, claim) => {
      const r = await t.page.evaluate(() => {
        const vw = innerWidth;
        const v = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
        const side = [...document.querySelectorAll('aside, [role=complementary]')].filter(v).map((e) => e as HTMLElement)
          .filter((e) => e.getBoundingClientRect().left > vw * 0.4 && e.getBoundingClientRect().height > innerHeight * 0.5).at(-1);
        if (!side) return null;
        const b = side.getBoundingClientRect();
        const text = side.innerText.replace(/\s+/g, ' ').trim();
        const controls = [...document.querySelectorAll('button, [role=button]')].filter(v)
          .map((x) => `${x.getAttribute('aria-label') ?? ''} ${(x as HTMLElement).innerText}`.trim())
          .filter((s) => /collapse|expand|hide|minimi[sz]e|toggle (?:cart|panel)|close (?:cart|panel)/i.test(s) && !/sidebar|menu|dark mode|selection/i.test(s));
        return { width: Math.round(b.width), vw, share: Math.round((b.width / vw) * 100), empty: /start a new sale|no items|cart is empty|add products/i.test(text), heading: text.slice(0, 60), controls };
      }).catch(() => null);
      if (!r) return t.skip(claim, 'No side panel was found on this page.');
      await t.shot('side panel');
      const wasteful = r.empty && r.share > 25 && !r.controls.length;
      t.check(
        r.empty ? 'An empty side panel can be collapsed or leaves room for the main content' : 'The side panel can be collapsed',
        !wasteful && (r.empty || r.controls.length > 0),
        `the right panel is ${r.width}px wide (${r.share}% of a ${r.vw}px screen)${r.empty ? ` while empty ("${r.heading}…")` : ''}; ${r.controls.length ? `collapse control: ${r.controls.join(', ')}` : 'no collapse or hide control'}`,
        'The cart panel has a fixed width even when the cart is empty; let it collapse, or give the product grid the full width until something is added.',
      );
    },
  },
  {
    name: 'variable price shown',
    pattern: /\b(?:price|pricing)\s+range|\bvariants?\b.*\bprice|\bprice\b.*\bvariants?\b|instead of (?:falling back to |showing )?(?:zero|0|৳?\s*0\.00)|\bprice\b.*\bshould not (?:be|show|display) ['‘]?(?:৳\s*)?0|\bfrom ৳?\s*\d/i,
    check: async (t) => {
      const products = (await t.api.allProducts().catch(() => [])).filter((p) => p.product_type === 'variable');
      if (!products.length) return t.skip('Variable products show a price range', 'This store has no variable products.');
      const range = (p: (typeof products)[number]) => {
        const prices = (p.variants ?? []).map((v) => Number(v.price)).filter((n) => n > 0);
        return prices.length ? [Math.min(...prices), Math.max(...prices)] : null;
      };
      const rows = t.snaps.flatMap((s) => s.snap.rows).concat(t.now?.rows ?? []);
      const pageText = await t.page.evaluate(() => (document.querySelector('main') ?? document.body).innerText).catch(() => '');
      const problems: string[] = [];
      const fine: string[] = [];
      for (const p of products) {
        const row = rows.find((r) => r.name === p.name);
        const shown = row?.price ?? pageText.split(p.name)[1]?.match(/৳\s*[\d,]+(?:\.\d+)?(?:\s*[–-]\s*৳?\s*[\d,]+(?:\.\d+)?)?|from\s*৳\s*[\d,.]+/i)?.[0] ?? '';
        const r = range(p);
        const zero = Number(p.price ?? 0) === 0 || /^৳\s*0(?:\.00)?$/.test(shown.trim());
        const spread = r && r[0] !== r[1];
        const showsRange = /[–-]|from/i.test(shown);
        if (zero) problems.push(`'${p.name}' ${shown ? `shows ${shown}` : 'has no price of its own (shows ৳0.00)'}${r ? `, variants cost ${taka(r[0])}${spread ? `–${taka(r[1])}` : ''}` : ''}`);
        else if (spread && shown && !showsRange) problems.push(`'${p.name}' shows ${shown}, but its variants cost ${taka(r![0])}–${taka(r![1])}`);
        else fine.push(`'${p.name}' ${shown || taka(Number(p.price))}${r ? ` (variants ${taka(r[0])}${spread ? `–${taka(r[1])}` : ''})` : ''}`);
      }
      t.check(
        'Variable products show a real price (a range or "from …"), not ৳0.00',
        !problems.length,
        problems.length ? problems.slice(0, 4).join('; ') : `${products.length} variable product${products.length === 1 ? '' : 's'} checked: ${fine.slice(0, 3).join('; ')}`,
        "The card shows the product's own price field, which is empty for variable products; compute min–max from the variants.",
      );
    },
  },
  {
    name: 'labels follow cards after sorting',
    pattern: /\b(?:position|row|serial|card|order)?\s*(?:numbers?|labels?|badges?|#\s?\d)\b.*\b(?:follow|stick|stay with|move with|attached|belong|travel)/i,
    check: async (t) => {
      let sort = t.noted.get('__sort') as SortResult | undefined;
      if (!sort) {
        if (!(await positionLabels(t)).length && !(await t.page.getByRole('button', { name: /^\s*sort\b/i }).count())) return t.skip('Labels follow their cards after sorting', 'No numbered cards or Sort button on this page.');
        await sortDifferently(t);
        sort = t.noted.get('__sort') as SortResult;
      }
      if (!sort.before.length || !sort.after.length) return t.skip('Labels follow their cards after sorting', 'No #1, #2 … labels were found on the cards.');
      // If sorting left the first cards where they were, nothing moved, so the labels cannot be judged.
      const sameOrder = sort.after.slice(0, 6).every((a, i) => a.card === sort!.before[i]?.card);
      if (sameOrder) return t.skip('Labels follow their cards after sorting', `Sorting by '${sort.option}' did not change the order of the first cards (${sort.after.slice(0, 3).map((x) => x.card).join(', ')}), so there was nothing to compare. Try it when the list has orders of different totals.`);
      const moved = sort.after.slice(0, 8).map((a) => ({ a, b: sort!.before.find((x) => x.card === a.card) })).filter((x) => x.b);
      await t.shot('after sorting');
      if (!moved.length) {
        const same = sort.after.slice(0, 5).every((a, i) => a.label === i + 1);
        t.check(
          `Labels follow their cards after sorting by '${sort.option}'`,
          !same,
          `none of the first cards was on screen before; after sorting, the labels still count 1, 2, 3… from the top (#1 is now '${sort.after[0].card}', it was '${sort.before[0].card}')`,
          'The #N badge is the position on the page, not a number tied to the order.',
        );
        return;
      }
      const changed = moved.filter((x) => x.a.label !== x.b!.label);
      t.check(
        `Labels follow their cards after sorting by '${sort.option}'`,
        !changed.length,
        changed.length
          ? changed.slice(0, 3).map((x) => `'${x.a.card}' was #${x.b!.label}, now #${x.a.label}`).join('; ')
          : `${moved.length} cards kept their numbers (e.g. '${moved[0].a.card}' stays #${moved[0].a.label})`,
        'The #N badge is the card’s position in the list, recomputed after each sort; tie it to the order (e.g. its order number) instead.',
      );
    },
  },
];
