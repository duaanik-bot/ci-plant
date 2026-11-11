// The customer's counter-offer, worked out (owner, 11 Nov 2026: "the amount of loss we have in the whole order, in the
// whole batch; the total percentage of the discount which the party is asking for … one field in which we will be
// setting our final price" — and later the same day: "what our actual costing was and, based upon the should-cost
// model, what we costed; this is what we gave, and this is now what they are asking … all sorts of comparisons").
// Pure: the server suite tests it (server/src/counter-math.test.js).
//
// Four prices per quantity of each enquiry, lowest to highest as a rule:
//   cost     our actual cost a carton (the costing, before margin)
//   costed   the should-cost price the costing works out (cost + margin) — what the model says to quote
//   ours     what we quoted (the price their counter answered)
//   theirs   what they ask
// and the one the person types: revised.
// Each of theirs and revised is compared with each of quoted / should-cost / cost: per carton, × quantity, and as a %
// of that base. Negative = below it (a cut from our quote, short of the model, a loss on cost).
// Totals add the order up (a mail, a bulk batch); a percentage is of the order's value, never an average of rows.

const n = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = x => Math.round(x * 100) / 100;
// Up to the paisa, ignoring float noise (9 × 1.05 = 9.450000000000001 must stay 9.45).
const ceilP = x => Math.ceil(Math.round(x * 1e6) / 1e4) / 100;
export const keyOf = (id, qty) => `${id}|${qty}`;
export const BASES = Object.freeze([
  { key: 'ours', label: 'our quote' },
  { key: 'costed', label: 'should-cost' },
  { key: 'cost', label: 'actual cost' },
]);

// One comparison: price p against base b for qty → { unit, line, pct } (null when either is missing).
export function gap(p, b, qty) {
  if (p == null || b == null) return null;
  return { unit: p - b, line: (p - b) * qty, pct: b ? ((p - b) / b) * 100 : null };
}

// enquiries: rows as the desk gives them (each with prices: [{ qty, final, suggested, proposed, cost, theirs, ours }]).
// boxes: keyOf(id, qty) → the typed revised price (text). Missing box → the saved final, else our quote.
export function counterLines(enquiries = [], boxes = {}) {
  const out = [];
  for (const e of enquiries) {
    for (const p of e.prices || []) {
      const ours = n(p.ours) ?? n(p.final);
      const theirs = n(p.theirs);
      const cost = n(p.cost);
      const costed = n(p.proposed);
      const typed = boxes[keyOf(e.id, p.qty)];
      const revised = typed !== undefined ? n(typed) : n(p.final) ?? ours;
      const qty = Number(p.qty) || 0;
      const base = { ours, costed, cost };
      const vs = price => Object.fromEntries(BASES.map(b => [b.key, gap(price, base[b.key], qty)]));
      const t = vs(theirs);
      const r = vs(revised);
      out.push({
        id: e.id, enquiry_no: e.enquiry_no, product: e.product_name, qty, ours, theirs, cost, costed, revised,
        theirs_vs: t, revised_vs: r,
        // the first measures, kept by name
        disc_asked: ours && theirs != null ? (ours - theirs) / ours : null,
        at_theirs_unit: t.cost?.unit ?? null, at_theirs: t.cost?.line ?? null,
        at_revised_unit: r.cost?.unit ?? null, at_revised: r.cost?.line ?? null,
        disc_given: ours && revised != null ? (ours - revised) / ours : null,
        theirs_below_cost: theirs != null && cost != null && theirs < cost,
        revised_below_cost: revised != null && cost != null && revised < cost,
        theirs_below_costed: theirs != null && costed != null && theirs < costed,
      });
    }
  }
  return out;
}

// Order totals of one price against one base, over the lines that have both.
function totalGap(lines, priceKey, baseKey) {
  const ls = lines.filter(l => l[priceKey] != null && l[baseKey] != null);
  if (!ls.length) return null;
  const price = ls.reduce((s, l) => s + l[priceKey] * l.qty, 0);
  const base = ls.reduce((s, l) => s + l[baseKey] * l.qty, 0);
  return { price, base, line: price - base, pct: base ? ((price - base) / base) * 100 : null, lines: ls.length,
    below: ls.filter(l => l[priceKey] < l[baseKey]).length };
}

export function counterTotals(lines = []) {
  const value = key => lines.reduce((s, l) => s + (l[key] != null ? l[key] * l.qty : 0), 0);
  const sumOf = f => lines.reduce((s, l) => s + (f(l) ?? 0), 0);
  const withTheirs = lines.filter(l => l.theirs != null && l.ours != null);
  const withRevised = lines.filter(l => l.revised != null && l.ours != null);
  const oursOf = ls => ls.reduce((s, l) => s + l.ours * l.qty, 0);
  const theirs = withTheirs.reduce((s, l) => s + l.theirs * l.qty, 0);
  const revised = withRevised.reduce((s, l) => s + l.revised * l.qty, 0);
  const askedBase = oursOf(withTheirs);
  const givenBase = oursOf(withRevised);
  const matrix = Object.fromEntries(['theirs', 'revised'].map(p => [p, Object.fromEntries(BASES.map(b => [b.key, totalGap(lines, p, b.key)]))]));
  return {
    items: lines.length, countered: withTheirs.length,
    value_cost: value('cost'), value_costed: value('costed'), value_ours: value('ours'), value_theirs: theirs, value_revised: revised,
    cost: value('cost'),
    // margin the model builds in, and what our quote added on top of it
    model_margin: lines.every(l => l.costed != null && l.cost != null) ? value('costed') - value('cost') : null,
    quote_over_model: lines.every(l => l.costed != null && l.ours != null) ? value('ours') - value('costed') : null,
    matrix,
    disc_asked_pct: askedBase ? ((askedBase - theirs) / askedBase) * 100 : null,
    disc_asked_value: askedBase ? askedBase - theirs : null,
    at_theirs: sumOf(l => l.at_theirs),
    at_revised: sumOf(l => l.at_revised),
    disc_given_pct: givenBase ? ((givenBase - revised) / givenBase) * 100 : null,
    below_cost_theirs: lines.filter(l => l.theirs_below_cost).length,
    below_cost_revised: lines.filter(l => l.revised_below_cost).length,
    missing_cost: lines.filter(l => l.cost == null).length,
  };
}

// Quick fills for the revised box: their price · halfway between · our cost plus ₹x or plus x% · the should-cost · our quote.
export const FILLS = {
  theirs: l => (l.theirs != null ? r2(l.theirs) : null),
  halfway: l => (l.theirs != null && l.ours != null ? ceilP((l.ours + l.theirs) / 2) : null),
  costPlus: (l, plus = 0) => (l.cost != null ? ceilP(l.cost + Number(plus || 0)) : null),
  // cost plus a percentage of it (owner, 11 Nov 2026: "cost plus this much paisa or this much percentage")
  costPct: (l, pct = 0) => (l.cost != null ? ceilP(l.cost * (1 + Number(pct || 0) / 100)) : null),
  costed: l => (l.costed != null ? ceilP(l.costed) : null),
  ours: l => (l.ours != null ? r2(l.ours) : null),
};
