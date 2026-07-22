import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeAllocate } from './tolerance-cascade.js';

test('single order within tolerance: fills need then boxes the rest', () => {
  // 140 available, one order of 100 @ 10% tolerance, nothing dispatched.
  const { allocations, leftover, dispatched_total } = cascadeAllocate(140, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 10 },
  ]);
  assert.equal(allocations[0].allowed_max, 110);
  assert.equal(allocations[0].dispatch_qty, 110);   // up to tolerance ceiling
  assert.equal(dispatched_total, 110);
  assert.equal(leftover, 30);                        // 140 - 110 → box as leftover
});

test('cascade: order 1 tolerance is used, remainder spills to order 2', () => {
  // 300 available; two orders of 100 @ 10% each. Fill O1 to 110, O2 to 110, box 80.
  const { allocations, leftover } = cascadeAllocate(300, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 10 },
    { order_line_id: 2, order_id: 20, ordered: 100, dispatched: 0, tolerance_pct: 10 },
  ]);
  assert.equal(allocations[0].dispatch_qty, 110);
  assert.equal(allocations[1].dispatch_qty, 110);
  assert.equal(leftover, 80);
});

test('cascade stops when pool runs out mid-way', () => {
  const { allocations, leftover } = cascadeAllocate(150, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 10 }, // takes 110
    { order_line_id: 2, order_id: 20, ordered: 100, dispatched: 0, tolerance_pct: 10 }, // takes 40
  ]);
  assert.equal(allocations[0].dispatch_qty, 110);
  assert.equal(allocations[1].dispatch_qty, 40);
  assert.equal(leftover, 0);
});

test('already-partly-dispatched line only gets its remaining tolerance room', () => {
  // ordered 100 @ 10% (ceiling 110), 105 already dispatched → only 5 room left.
  const { allocations, leftover } = cascadeAllocate(50, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 105, tolerance_pct: 10 },
  ]);
  assert.equal(allocations[0].tolerance_room, 5);
  assert.equal(allocations[0].dispatch_qty, 5);
  assert.equal(leftover, 45);
});

test('zero tolerance: ceiling is exactly the ordered qty', () => {
  const { allocations, leftover } = cascadeAllocate(120, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 0 },
  ]);
  assert.equal(allocations[0].dispatch_qty, 100);
  assert.equal(leftover, 20);
});

test('flags: fills_order and uses_tolerance', () => {
  const { allocations } = cascadeAllocate(110, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 10 },
  ]);
  assert.equal(allocations[0].fills_order, true);
  assert.equal(allocations[0].uses_tolerance, true);   // 110 > 100 ordered
});

test('no orders: everything is leftover', () => {
  const { allocations, leftover, dispatched_total } = cascadeAllocate(75, []);
  assert.deepEqual(allocations, []);
  assert.equal(dispatched_total, 0);
  assert.equal(leftover, 75);
});
