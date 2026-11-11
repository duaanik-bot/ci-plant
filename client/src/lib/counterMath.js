// The customer's counter-offer, worked out (owner, 11 Nov 2026: "the amount of loss we have in the whole order, in the
// whole batch; the total percentage of the discount which the party is asking for … one field in which we will be
// setting our final price"). Pure: the server suite tests it (server/src/counter-math.test.js).
//
// Per quantity of each enquiry: ours (our price the counter answered) · theirs (the customer's) · cost (our costing's
// cost a carton, before margin) · revised (the box the person types in).
//   discount asked  = (ours − theirs) ÷ ours           at their price  = (theirs − cost) × qty   (negative = a loss)
//   discount given  = (ours − revised) ÷ ours          at our revised  = (revised − cost) × qty
// Totals add the order up (a mail, a bulk batch); a percentage is of the order value, not an average of rows.

const n = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const r2 = x => Math.round(x * 100) / 100;
export const keyOf = (id, qty) => `${id}|${qty}`;

// enquiries: rows as the desk gives them (each with prices: [{ qty, final, suggested, cost, theirs, ours }]).
// boxes: keyOf(id, qty) → the typed revised price (text). Missing box → the saved final, else our price.
export function counterLines(enquiries = [], boxes = {}) {
  const out = [];
  for (const e of enquiries) {
    for (const p of e.prices || []) {
      const ours = n(p.ours) ?? n(p.final);
      const theirs = n(p.theirs);
      const cost = n(p.cost);
      const typed = boxes[keyOf(e.id, p.qty)];
      const revised = typed !== undefined ? n(typed) : n(p.final) ?? ours;
      const qty = Number(p.qty) || 0;
      out.push({
        id: e.id, enquiry_no: e.enquiry_no, product: e.product_name, qty, ours, theirs, cost, revised,
        disc_asked: ours && theirs != null ? (ours - theirs) / ours : null,
        at_theirs_unit: theirs != null && cost != null ? theirs - cost : null,
        at_theirs: theirs != null && cost != null ? (theirs - cost) * qty : null,
        at_revised_unit: revised != null && cost != null ? revised - cost : null,
        at_revised: revised != null && cost != null ? (revised - cost) * qty : null,
        disc_given: ours && revised != null ? (ours - revised) / ours : null,
        theirs_below_cost: theirs != null && cost != null && theirs < cost,
        revised_below_cost: revised != null && cost != null && revised < cost,
      });
    }
  }
  return out;
}

export function counterTotals(lines = []) {
  const sum = f => lines.reduce((s, l) => s + (f(l) ?? 0), 0);
  const withTheirs = lines.filter(l => l.theirs != null && l.ours != null);
  const withRevised = lines.filter(l => l.revised != null && l.ours != null);
  const oursOf = ls => ls.reduce((s, l) => s + l.ours * l.qty, 0);
  const ours = oursOf(lines.filter(l => l.ours != null));
  const theirs = withTheirs.reduce((s, l) => s + l.theirs * l.qty, 0);
  const revised = withRevised.reduce((s, l) => s + l.revised * l.qty, 0);
  const askedBase = oursOf(withTheirs);
  const givenBase = oursOf(withRevised);
  return {
    items: lines.length, countered: withTheirs.length,
    value_ours: ours, value_theirs: theirs, value_revised: revised,
    cost: sum(l => (l.cost != null ? l.cost * l.qty : null)),
    disc_asked_pct: askedBase ? ((askedBase - theirs) / askedBase) * 100 : null,
    disc_asked_value: askedBase ? askedBase - theirs : null,
    at_theirs: sum(l => l.at_theirs),
    at_revised: sum(l => l.at_revised),
    disc_given_pct: givenBase ? ((givenBase - revised) / givenBase) * 100 : null,
    below_cost_theirs: lines.filter(l => l.theirs_below_cost).length,
    below_cost_revised: lines.filter(l => l.revised_below_cost).length,
    missing_cost: lines.filter(l => l.cost == null).length,
  };
}

// Quick fills for the revised box: their price · halfway between · our cost plus ₹x (to the paisa, up).
export const FILLS = {
  theirs: l => (l.theirs != null ? r2(l.theirs) : null),
  halfway: l => (l.theirs != null && l.ours != null ? Math.ceil(((l.ours + l.theirs) / 2) * 100) / 100 : null),
  costPlus: (l, plus = 0) => (l.cost != null ? Math.ceil((l.cost + Number(plus || 0)) * 100) / 100 : null),
  ours: l => (l.ours != null ? r2(l.ours) : null),
};
