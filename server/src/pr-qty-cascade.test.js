import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrQtyChange } from './pr-qty-cascade.js';

const l = (material_id, qty) => ({ material_id, qty });

test('a raised quantity becomes a positive delta', () => {
  const { deltas, error } = planPrQtyChange([l(7, 20)], [l(7, 25)]);
  assert.equal(error, null);
  assert.deepEqual(deltas, [{ material_id: 7, from: 20, to: 25, delta: 5 }]);
});

test('a lowered quantity becomes a negative delta', () => {
  const { deltas } = planPrQtyChange([l(7, 20)], [l(7, 12)]);
  assert.deepEqual(deltas, [{ material_id: 7, from: 20, to: 12, delta: -8 }]);
});

test('an unchanged quantity produces no work at all', () => {
  const { deltas } = planPrQtyChange([l(7, 20), l(9, 5)], [l(7, 20), l(9, 5)]);
  assert.deepEqual(deltas, []);
});

test('only the changed board moves', () => {
  const { deltas } = planPrQtyChange([l(7, 20), l(9, 5)], [l(7, 20), l(9, 8)]);
  assert.deepEqual(deltas, [{ material_id: 9, from: 5, to: 8, delta: 3 }]);
});

// The delta is the whole point: the PO line may be shared with other
// requisitions, and setting it would erase what they contributed.
test('the delta is what moves, not the new total', () => {
  const { deltas } = planPrQtyChange([l(7, 20)], [l(7, 30)]);
  assert.equal(deltas[0].delta, 10, 'a PO line at 50 fed by two PRs must become 60, not 30');
});

test('a requisition repeating a board is summed before comparing', () => {
  const { deltas } = planPrQtyChange([l(7, 20), l(7, 10)], [l(7, 20), l(7, 15)]);
  assert.deepEqual(deltas, [{ material_id: 7, from: 30, to: 35, delta: 5 }]);
});

test('adding a board to an ordered requisition is refused', () => {
  const { deltas, error } = planPrQtyChange([l(7, 20)], [l(7, 20), l(9, 5)]);
  assert.match(error, /raise a new requisition/);
  assert.deepEqual(deltas, [], 'nothing to apply when it is refused');
});

test('dropping a board from an ordered requisition is refused', () => {
  const { error } = planPrQtyChange([l(7, 20), l(9, 5)], [l(7, 20)]);
  assert.match(error, /raise a new requisition/);
});

test('swapping the board is refused — that is an add and a drop', () => {
  const { error } = planPrQtyChange([l(7, 20)], [l(9, 20)]);
  assert.match(error, /raise a new requisition/);
});

test('a zero or negative quantity is refused', () => {
  assert.match(planPrQtyChange([l(7, 20)], [l(7, 0)]).error, /above zero/);
  assert.match(planPrQtyChange([l(7, 20)], [l(7, -5)]).error, /above zero/);
});

test('string quantities compare numerically', () => {
  const { deltas } = planPrQtyChange([l(7, 20)], [l('7', '25')]);
  assert.deepEqual(deltas, [{ material_id: 7, from: 20, to: 25, delta: 5 }]);
});
