// The counter-offer maths (client/src/lib/counterMath.js). Invented products and figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterLines, counterTotals, FILLS, keyOf, gap } from '../../client/src/lib/counterMath.js';

const E = [
  { id: 1, enquiry_no: 'CI-ENQ-9001', product_name: 'TEST A', prices: [{ qty: 1000, final: 10, ours: 10, theirs: 8, cost: 9, proposed: 9.4 }] },
  { id: 2, enquiry_no: 'CI-ENQ-9002', product_name: 'TEST B', prices: [{ qty: 2000, final: 5, ours: 5, theirs: 4.5, cost: 4, proposed: 4.4 }] },
  { id: 3, enquiry_no: 'CI-ENQ-9003', product_name: 'TEST C', prices: [{ qty: 500, final: 2, ours: 2, theirs: null, cost: 1.5, proposed: 1.8 }] },
];
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

test('per row: discount asked, profit or loss at their price, below-cost flag', () => {
  const [a, b, c] = counterLines(E);
  close(a.disc_asked, 0.2, 'A asks 20% off');
  close(a.at_theirs_unit, -1, 'A loses ₹1 a carton at their price');
  close(a.at_theirs, -1000, 'A loses ₹1,000 on the line');
  assert.equal(a.theirs_below_cost, true);
  close(b.at_theirs, 1000, 'B still earns ₹0.50 × 2,000');
  assert.equal(b.theirs_below_cost, false);
  assert.equal(c.disc_asked, null, 'no counter on C');
  assert.equal(c.revised, 2, 'revised starts at our price');
});

test('totals: the discount asked is of the order value (not an average), loss nets profit', () => {
  const t = counterTotals(counterLines(E));
  // ours on the countered rows = 10,000 + 10,000 = 20,000; theirs = 8,000 + 9,000 = 17,000 → 15%
  close(t.disc_asked_pct, 15, 'discount asked');
  close(t.disc_asked_value, 3000, 'discount asked in ₹');
  close(t.at_theirs, 0, '−1,000 + 1,000');
  close(t.value_ours, 21000, 'whole order at our prices');
  close(t.cost, 9000 + 8000 + 750, 'cost of the whole order');
  assert.equal(t.countered, 2);
  assert.equal(t.below_cost_theirs, 1);
});

test('the revised box drives the margin and the discount given; quick fills', () => {
  const boxes = { [keyOf(1, 1000)]: '9.5', [keyOf(2, 2000)]: '4.75' };
  const lines = counterLines(E, boxes);
  close(lines[0].at_revised, 500, 'A at 9.50 earns ₹0.50 × 1,000');
  const t = counterTotals(lines);
  // revised value 9,500 + 9,500 + 1,000 = 20,000 vs ours 21,000 → 4.7619%
  close(t.disc_given_pct, (1000 / 21000) * 100, 'discount given');
  close(t.at_revised, 500 + 1500 + 250, 'result at our revised prices');
  assert.equal(FILLS.theirs(lines[0]), 8);
  assert.equal(FILLS.halfway(lines[0]), 9);
  assert.equal(FILLS.costPlus(lines[0], 0.25), 9.25);
  assert.equal(FILLS.halfway(lines[2]), null, 'no counter, no halfway');
  assert.equal(counterLines(E, { [keyOf(1, 1000)]: '' })[0].revised, null, 'an emptied box is empty, not our price');
});

test('every comparison: their price and our revised against our quote, the should-cost and the actual cost', () => {
  const lines = counterLines(E, { [keyOf(1, 1000)]: '9.5' });
  const a = lines[0];
  close(a.theirs_vs.ours.unit, -2, 'A: ₹2 a carton under our quote');
  close(a.theirs_vs.ours.pct, -20, 'A: 20% under our quote');
  close(a.theirs_vs.costed.line, -1400, 'A: (8 − 9.40) × 1,000 under the should-cost');
  close(a.theirs_vs.cost.line, -1000, 'A: the loss on actual cost');
  close(a.revised_vs.costed.unit, 0.1, 'A revised 9.50 is ₹0.10 over the should-cost');
  assert.equal(a.theirs_below_costed, true);
  assert.equal(lines[2].theirs_vs.ours, null, 'no counter → no comparison');
  const t = counterTotals(lines);
  // theirs vs quoted over the countered lines: 17,000 − 20,000
  close(t.matrix.theirs.ours.line, -3000, 'order: their counter vs our quote');
  close(t.matrix.theirs.ours.pct, -15, 'order: −15% = the discount asked');
  close(t.matrix.theirs.costed.line, 17000 - (9400 + 8800), 'order: their counter vs the should-cost');
  close(t.matrix.theirs.cost.line, 0, 'order: their counter vs actual cost');
  assert.equal(t.matrix.theirs.cost.below, 1, 'one line under cost');
  close(t.value_costed, 9400 + 8800 + 900, 'the should-cost of the whole order');
  close(t.model_margin, (9400 + 8800 + 900) - (9000 + 8000 + 750), 'the margin the model builds in');
  close(t.quote_over_model, 21000 - 19100, 'what our quote added over the model');
  close(t.matrix.revised.cost.line, 500 + 2000 + 250, 'order: our revised vs actual cost');
  assert.equal(gap(null, 1, 10), null);
  assert.equal(FILLS.costed(a), 9.4);
});
