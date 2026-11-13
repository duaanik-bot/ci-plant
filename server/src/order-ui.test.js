import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownLine, shownTotals, canOrder, ORDER_STAGES } from '../../client/src/lib/orderUi.js';

// The Order finalised panel's own sums (client/src/lib/orderUi.js): the rate and quantity as typed, the margin or loss
// against the server's cost a carton, and the totals tiles. Invented figures.
const LINE = { enquiry_id: 1, qty: 5000, rate: 3.75, cost: 3.2, new_die: true };

test('a typed rate below our cost shows as a loss a carton and on the order', () => {
  const l = shownLine(LINE, { rate: '3.00' });
  assert.equal(l.rate, 3);
  assert.ok(Math.abs(l.margin - -0.2) < 1e-9);
  assert.ok(Math.abs(l.margin_total - -1000) < 1e-6);
  assert.equal(l.value, 15000);
  assert.equal(l.bad, null);
});

test('a line with no rate or quantity is marked, and a quantity may be typed with commas', () => {
  assert.equal(shownLine(LINE, { rate: '' }).bad, 'rate');
  assert.equal(shownLine(LINE, { qty: '0' }).bad, 'quantity');
  assert.equal(shownLine(LINE, { qty: '6,000' }).qty, 6000);
  assert.equal(shownLine(LINE, { new_die: false }).new_die, false);
  assert.equal(shownLine({ ...LINE, cost: null }).margin, null, 'no cost, no margin claimed');
});

test('totals: value, the loss on the order (only the lines below cost) and new dies', () => {
  const lines = [shownLine(LINE, { rate: '3.00' }), shownLine({ ...LINE, enquiry_id: 2, new_die: false }, {})];
  assert.deepEqual(shownTotals(lines), { total: 15000 + 18750, loss: 1000, atLoss: 1, newDies: 1 });
});

test('the button shows from Final price on, on a row with a complete costing not already on an order', () => {
  assert.deepEqual([...ORDER_STAGES].sort(), ['costed', 'countered', 'price_pending', 'quote_ready', 'sent']);
  assert.equal(canOrder({ stage: 'sent', costing_complete: true }), true);
  assert.equal(canOrder({ stage: 'sent', costing_complete: false }), false);
  assert.equal(canOrder({ stage: 'new', costing_complete: true }), false);
  assert.equal(canOrder({ stage: 'sent', costing_complete: true, order_id: 4 }), false);
});
