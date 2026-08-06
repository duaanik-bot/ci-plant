// The Ready-to-Dispatch columns. `fg_qty` is a PRODUCT pool, so the danger is
// promising the same cartons to every line that wants that product.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateReadyLines } from './tolerance-cascade.js';

const line = (o) => ({ order_line_id: o.id, product_id: o.pid, qty: o.qty,
  dispatched_qty: o.done || 0, tolerance_pct: o.tol ?? 10, fg_qty: o.fg });

test('one line, stock under the tolerance ceiling: all of it is suggested, nothing left', () => {
  const rows = [line({ id: 1, pid: 9, qty: 5000, fg: 5000 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].suggested_dispatch, 5000);
  assert.equal(rows[0].leftover_qty, 0);
});

test('over-run beyond tolerance becomes leftover, not dispatch', () => {
  // 5,000 ordered at ±10% → ceiling 5,500. 6,480 on hand ⇒ 980 cannot go out.
  const rows = [line({ id: 1, pid: 9, qty: 5000, fg: 6480 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].suggested_dispatch, 5500);
  assert.equal(rows[0].leftover_qty, 980);
  assert.equal(rows[0].uses_tolerance, true);
});

test('TWO lines sharing one product never promise the same cartons twice', () => {
  // The whole reason this is not a per-row min(): one 10,000 pool, two lines.
  const rows = [
    line({ id: 1, pid: 9, qty: 6000, fg: 10000 }),
    line({ id: 2, pid: 9, qty: 6000, fg: 10000 }),
  ];
  annotateReadyLines(rows, new Map([[9, 100]]));
  const total = rows[0].suggested_dispatch + rows[1].suggested_dispatch;
  assert.ok(total <= 10000, `suggested ${total} exceeds the 10000 pool`);
  assert.equal(rows[0].suggested_dispatch, 6600);  // first line fills to its ceiling
  assert.equal(rows[1].suggested_dispatch, 3400);  // second gets only what is left
  assert.equal(total, 10000);
});

test('leftover is counted ONCE per product, on its last line', () => {
  const rows = [
    line({ id: 1, pid: 9, qty: 1000, fg: 5000 }),
    line({ id: 2, pid: 9, qty: 1000, fg: 5000 }),
  ];
  annotateReadyLines(rows, new Map([[9, 100]]));
  // ceilings 1100 each = 2200 dispatchable, so 2800 is stranded — ONCE.
  assert.equal(rows[0].leftover_qty, 0);
  assert.equal(rows[1].leftover_qty, 2800);
  assert.equal(rows.reduce((t, r) => t + r.leftover_qty, 0), 2800);
  assert.equal(rows[0].shares_pool_with, 1);
});

test('already-dispatched quantity eats the tolerance room', () => {
  const rows = [line({ id: 1, pid: 9, qty: 5000, done: 5200, fg: 1000 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].tolerance_room, 300);       // 5500 ceiling − 5200 gone
  assert.equal(rows[0].suggested_dispatch, 300);
  assert.equal(rows[0].leftover_qty, 700);
});

test('two DIFFERENT products keep their own pools', () => {
  const rows = [
    line({ id: 1, pid: 9, qty: 1000, fg: 1500 }),
    line({ id: 2, pid: 7, qty: 1000, fg: 4000 }),
  ];
  annotateReadyLines(rows, new Map([[9, 0], [7, 50]]));
  assert.equal(rows[0].leftover_qty, 400);   // 1500 − 1100
  assert.equal(rows[1].leftover_qty, 2900);  // 4000 − 1100
  assert.equal(rows[0].qty_per_box, 0);
  assert.equal(rows[1].qty_per_box, 50);
});
