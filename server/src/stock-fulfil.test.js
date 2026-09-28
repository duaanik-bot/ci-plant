import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fulfilBlock, normalisePicks, completesOrder, undoBlock } from './stock-fulfil.js';

test('fulfilBlock: a planning line with no card and no run may be completed', () => {
  for (const status of ['pending', 'planned', 'ready'])
    assert.equal(fulfilBlock({ status, gang_run_id: null }), null);
});

test('fulfilBlock: refuses production, a job card, and a run member', () => {
  assert.match(fulfilBlock({ status: 'in_production' }), /only a line still in planning/);
  assert.match(fulfilBlock({ status: 'produced' }), /only a line still in planning/);
  assert.match(fulfilBlock({ status: 'pending' }, { hasJobCard: true }), /job card already exists/);
  assert.match(fulfilBlock({ status: 'planned', gang_run_id: 7 }, { completing: true }), /gang \/ combined run/);
  // A partial reserve on a run member is ordinary consume-fg — allowed.
  assert.equal(fulfilBlock({ status: 'planned', gang_run_id: 7 }), null);
});

test('normalisePicks: sorts by lot id and keeps whole positive quantities', () => {
  assert.deepEqual(normalisePicks([{ lot_id: 9, qty: 200 }, { lot_id: '3', qty: '50' }]),
    [{ lot_id: 3, qty: 50 }, { lot_id: 9, qty: 200 }]);
});

test('normalisePicks: refuses empty, duplicates, fractions and zero', () => {
  assert.throws(() => normalisePicks([]), /Tick at least one box/);
  assert.throws(() => normalisePicks(null), /Tick at least one box/);
  assert.throws(() => normalisePicks([{ lot_id: 1, qty: 5 }, { lot_id: 1, qty: 5 }]), /ticked twice/);
  assert.throws(() => normalisePicks([{ lot_id: 1, qty: 2.5 }]), /whole, positive/);
  assert.throws(() => normalisePicks([{ lot_id: 1, qty: 0 }]), /whole, positive/);
  assert.throws(() => normalisePicks([{ qty: 10 }]), /stock reference/);
});

test('completesOrder: only when the ticked boxes reach the balance', () => {
  assert.equal(completesOrder(1000, [{ qty: 600 }, { qty: 400 }]), true);
  assert.equal(completesOrder(1000, [{ qty: 999 }]), false);
  // Nothing left to make is not "completing" — there is no order to finish.
  assert.equal(completesOrder(0, [{ qty: 5 }]), false);
});

test('undoBlock: a stock-completed line waiting in Dispatch can go back', () => {
  assert.equal(undoBlock({ status: 'produced', dispatched_qty: 0 },
    { reservedQty: 500, markedFromStock: true }), null);
});

test('undoBlock: anything despatched is final', () => {
  assert.match(undoBlock({ status: 'produced', dispatched_qty: 100 },
    { reservedQty: 500, markedFromStock: true }), /already been despatched/);
  assert.match(undoBlock({ status: 'dispatched', dispatched_qty: 500 },
    { reservedQty: 500, markedFromStock: true }), /already been despatched/);
});

test('undoBlock: a produced line from a job card is not a stock completion', () => {
  assert.match(undoBlock({ status: 'produced', dispatched_qty: 0 },
    { hasJobCard: true, reservedQty: 500, markedFromStock: true }), /completed by production/);
  assert.match(undoBlock({ status: 'produced', dispatched_qty: 0 },
    { reservedQty: 500, markedFromStock: false }), /completed by production/);
  assert.match(undoBlock({ status: 'pending', dispatched_qty: 0 },
    { reservedQty: 500, markedFromStock: true }), /only a line completed from stock/);
});
