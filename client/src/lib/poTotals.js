// Full-GST purchase-order line & total maths — the single source of truth shared
// by the PO forms (Direct / convert / bulk / edit) and the printable PO, so the
// number on screen always matches the number on paper.
const round2 = n => Math.round((+n || 0) * 100) / 100;

export const lineGross = l => (+l.qty || 0) * (+l.rate || 0);
export const lineDiscount = l => round2(lineGross(l) * (+l.discount_pct || 0) / 100);
export const lineTaxable = l => round2(lineGross(l) - lineDiscount(l));
export const lineTax = l => round2(lineTaxable(l) * (+l.gst_rate || 0) / 100);
export const lineAmount = l => round2(lineTaxable(l) + lineTax(l));

// Roll a set of lines up into document totals. taxKind decides the CGST/SGST
// (intra-state) vs IGST (inter-state) split; round_off auto-computes to the
// nearest rupee unless an explicit override is passed.
export function poTotals(lines = [], { freight = 0, taxKind = 'intra', round_off } = {}) {
  const clean = lines.filter(l => l.material_id && +l.qty > 0);
  const gross = round2(clean.reduce((s, l) => s + lineGross(l), 0));
  const discount = round2(clean.reduce((s, l) => s + lineDiscount(l), 0));
  const taxable = round2(clean.reduce((s, l) => s + lineTaxable(l), 0));
  const tax = round2(clean.reduce((s, l) => s + lineTax(l), 0));
  const cgst = taxKind === 'intra' ? round2(tax / 2) : 0;
  const sgst = taxKind === 'intra' ? round2(tax / 2) : 0;
  const igst = taxKind === 'inter' ? tax : 0;
  const beforeRound = round2(taxable + tax + (+freight || 0));
  const autoRound = round2(Math.round(beforeRound) - beforeRound);
  const ro = round_off != null && round_off !== '' ? +round_off : autoRound;
  const grand = round2(beforeRound + ro);
  // GST%-wise taxable/tax breakup for the tax-summary block on the print.
  const byRate = {};
  for (const l of clean) {
    const k = +l.gst_rate || 0;
    (byRate[k] ||= { rate: k, taxable: 0, tax: 0 });
    byRate[k].taxable = round2(byRate[k].taxable + lineTaxable(l));
    byRate[k].tax = round2(byRate[k].tax + lineTax(l));
  }
  return {
    lines: clean.length, gross, discount, taxable, tax, cgst, sgst, igst,
    freight: +freight || 0, round_off: ro, grand, taxKind,
    byRate: Object.values(byRate).sort((a, b) => a.rate - b.rate),
  };
}

// ── Rate variance ────────────────────────────────────────────────────────────
// What the supplier invoiced minus what the PO ordered. Null when there is
// nothing to compare or the gap is inside money tolerance — the same 0.005 the
// PO form's RateProvenance uses before it calls a rate overridden.
//
// TWIN of grn-receipt.rateVariance on the server. The receipt form recomputes
// it locally for the live variance chip, so the two must never disagree — a
// chip that appears on screen but not in the server's own view of the receipt
// would be worse than no chip at all. Parity is asserted in
// server/src/grn-receipt.test.js, the same precedent boardMath follows.
export function rateVariance(received, ordered) {
  if (received == null || received === '' || ordered == null || ordered === '') return null;
  const d = round2(+received - +ordered);
  return Math.abs(d) > 0.005 ? d : null;
}

// Decide intra vs inter-state from the buyer (company) and supplier (vendor).
// Falls back to intra when either state is unknown.
export function taxKindFor(company, vendor) {
  const a = (company?.state_code || company?.state || '').toString().trim().toLowerCase();
  const b = (vendor?.state_code || vendor?.state || '').toString().trim().toLowerCase();
  if (!a || !b) return 'intra';
  return a === b ? 'intra' : 'inter';
}
