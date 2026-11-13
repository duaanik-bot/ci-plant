import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityBreaks } from './costing-engine.js';
import { orderLine, orderTotals, orderMail, newDieFromInputs, NEW_DIE_PROCESS } from './order-finalise.js';

// Order finalised (owner, 12 Nov 2026): the lines of an order the customer agreed, the loss where it was booked below
// cost, and the order sheet for the team. Invented figures and names, not a customer's.
const COSTING = {
  qty: 10000, sheet_l: 16, sheet_w: 25, ups: 10, gsm: 300, board_rate: 98.7654, wastage: 250, colours: 4,
  print_rate: 437, print_min: 1600, coat_factor: 3, dp_rate: 0.3141, emb_rate: 0, process: 2000, pf_pct: 5, misc_pct: 2, margin: 0.0567,
};
const ENQ = {
  id: 7, enquiry_no: 'CI-ENQ-0007', customer_name: 'Example Pharma', product_name: 'TESTOCAL 10 TAB CARTON', size_text: '120x40x90',
  style: 'LOCK', board: 'Test Board XL', gsm: 300, colours: 4, coating: 'Aqueous varnish', specs: 'Embossed logo; AW code T1',
  quantities: [10000, 25000], final_prices: [{ qty: 10000, final: 1.95, proposed: 1.9 }], counter: [{ qty: 10000, theirs: 1.5, ours: 1.95 }],
};
const at = qty => quantityBreaks(COSTING, [qty])[0];

test('the rate is pre-filled from the quotation, else the final price, else the costing\'s proposal', () => {
  assert.equal(orderLine(ENQ, { inputs: COSTING, quotationLine: { qty: 10000, rate: 2.05 } }).rate, 2.05);
  assert.equal(orderLine(ENQ, { inputs: COSTING }).rate, 1.95);
  const proposed = at(25000).quote_per_unit;
  const noFinal = orderLine({ ...ENQ, final_prices: [], quantities: [25000] }, { inputs: COSTING });
  assert.equal(noFinal.qty, 25000);
  assert.ok(noFinal.rate >= proposed && noFinal.rate - proposed < 0.01, `${noFinal.rate} vs ${proposed}`);
  // the quantity: the quotation's, else the first asked
  assert.equal(orderLine(ENQ, { inputs: COSTING, quotationLine: { qty: 25000, rate: 1.8 } }).qty, 25000);
  assert.equal(orderLine(ENQ, { inputs: COSTING }).qty, 10000);
  // the customer's counter for that quantity rides along, as a one-press choice
  assert.equal(orderLine(ENQ, { inputs: COSTING }).counter, 1.5);
});

test('a rate under our cost is a loss a carton and on the order', () => {
  const cost = at(10000).cost_per_unit;
  const rate = Math.floor((cost - 0.25) * 100) / 100;
  const l = orderLine(ENQ, { inputs: COSTING, edits: { rate } });
  assert.equal(l.rate, rate);
  assert.ok(Math.abs(l.cost - cost) < 1e-4);
  assert.ok(l.margin < 0);
  assert.ok(Math.abs(l.margin_total - Math.round((rate - cost) * 10000 * 100) / 100) < 0.02, `${l.margin_total}`);
  assert.equal(l.value, Math.round(rate * 10000 * 100) / 100);
  // a new quantity is costed at that quantity
  const more = orderLine(ENQ, { inputs: COSTING, edits: { qty: 25000, rate } });
  assert.ok(Math.abs(more.cost - at(25000).cost_per_unit) < 1e-4);
});

test('new die is read from the process charge: the new-die rate means a new die', () => {
  assert.equal(NEW_DIE_PROCESS, 3000);
  assert.equal(newDieFromInputs({ process: 3000 }), true);
  assert.equal(newDieFromInputs({ process: 2000 }), false);
  assert.equal(newDieFromInputs(null), false);
  assert.equal(orderLine(ENQ, { inputs: { ...COSTING, process: 3000 } }).new_die, true);
  assert.equal(orderLine(ENQ, { inputs: COSTING, edits: { new_die: true } }).new_die, true);
});

test('the line carries what the team needs: output sheet, ups, board, art details and the KLD', () => {
  const l = orderLine(ENQ, { inputs: COSTING, kld: { rev: 2, size_id: 41 } });
  assert.deepEqual(l.sheet, { l: 16, w: 25 });
  assert.equal(l.ups, 10);
  assert.equal(l.board, 'Test Board XL');
  assert.equal(l.gsm, 300);
  assert.equal(l.art, '4 colours, Aqueous varnish, Embossed logo; AW code T1');
  assert.equal(l.size, '120 × 40 × 90');
  assert.deepEqual(l.kld, { rev: 2, size_id: 41 });
});

test('an edit with no rate or no quantity is refused with a reason', () => {
  assert.throws(() => orderLine(ENQ, { inputs: COSTING, edits: { rate: 0 } }), e => e.why === 'a rate a carton is needed');
  assert.throws(() => orderLine(ENQ, { inputs: COSTING, edits: { rate: 'abc' } }), e => e.why === 'a rate a carton is needed');
  assert.throws(() => orderLine(ENQ, { inputs: COSTING, edits: { qty: -5, rate: 2 } }), e => e.why === 'a quantity is needed');
});

test('totals: the order value, the loss on the order and the items below cost', () => {
  const lines = [
    { value: 20000, margin_total: -1230, new_die: true },
    { value: 5000, margin_total: 400, new_die: false },
    { value: 3000, margin_total: null, new_die: true },
  ];
  assert.deepEqual(orderTotals(lines), { total: 28000, loss: 1230, items_at_loss: 1, new_dies: 2 });
});

test('the mail to the team is one table of what the team needs, and never shows a cost or a loss', () => {
  const cost = at(10000).cost_per_unit;
  const line = orderLine(ENQ, { inputs: { ...COSTING, process: 3000 }, kld: { rev: 2, size_id: 41 }, edits: { rate: 1.23 } });
  const m = orderMail({ order_no: 'CI-OF-0001', customer: 'Example Pharma', quotation_no: 'CI-QTN-0009', lines: [line], by: 'Test Planner', at: '2026-11-13T07:00:00Z' });
  assert.equal(m.subject, 'Order finalised — Example Pharma — 1 item, 1 new die — CI-OF-0001');
  for (const s of ['TESTOCAL 10 TAB CARTON', '10,000', '₹1.23', '16 × 25 in', '>10<', 'Test Board XL', '300 GSM', 'NEW DIE', 'KLD rev 2 attached',
    'Aqueous varnish', 'CI-QTN-0009', 'Test Planner']) {
    assert.ok(m.html.includes(s), `html has ${s}`);
  }
  for (const s of ['TESTOCAL 10 TAB CARTON', '10,000', '₹1.23', '16 × 25 in', 'NEW DIE']) assert.ok(m.text.includes(s), `text has ${s}`);
  for (const body of [m.html, m.text]) {
    assert.doesNotMatch(body, /loss|margin|cost/i);
    assert.ok(!body.includes(cost.toFixed(2)), 'no cost figure');
  }
  // escaped: a product name cannot break the table
  const evil = orderMail({ order_no: 'CI-OF-0002', customer: 'A <b>', lines: [{ ...line, product: '<script>x</script>' }], by: 'T', at: '2026-11-13T07:00:00Z' });
  assert.ok(!evil.html.includes('<script>') && evil.html.includes('&lt;script&gt;'));
});
