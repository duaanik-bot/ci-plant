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

// ── S/E: Short and Excess ────────────────────────────────────────────────────
// The column is one signed figure. A line is short OR in excess, never both:
// short means the pool cannot fill what is still ordered, excess means finished
// goods no order can absorb within tolerance.

test('S/E: not enough stock to fill the order is SHORT, and short is never excess', () => {
  const rows = [line({ id: 1, pid: 9, qty: 10000, fg: 4000 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].suggested_dispatch, 4000);
  assert.equal(rows[0].short_qty, 6000);     // 10000 wanted − 4000 the pool can give
  assert.equal(rows[0].leftover_qty, 0);
});

test('S/E: stock beyond the tolerance ceiling is EXCESS, and excess is never short', () => {
  const rows = [line({ id: 1, pid: 9, qty: 5000, fg: 6480 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].short_qty, 0);
  assert.equal(rows[0].leftover_qty, 980);
});

test('S/E: a line is never short AND in excess at once', () => {
  const specs = [
    { id: 1, pid: 1, qty: 5000, fg: 100 }, { id: 2, pid: 2, qty: 5000, fg: 5000 },
    { id: 3, pid: 3, qty: 5000, fg: 5500 }, { id: 4, pid: 4, qty: 5000, fg: 99999 },
  ];
  for (const sp of specs) {
    const rows = [line(sp)];
    annotateReadyLines(rows, new Map([[sp.pid, 100]]));
    assert.ok(!(rows[0].short_qty > 0 && rows[0].leftover_qty > 0),
      `line ${sp.id} reported short ${rows[0].short_qty} AND excess ${rows[0].leftover_qty}`);
  }
});

test('S/E: on a shared pool the starved line is short, the last line carries the excess', () => {
  // 12,000 pool, two 5,000 orders at ±10% → ceilings 5,500 each = 11,000
  // dispatchable, so 1,000 is excess and neither order is short.
  const rows = [line({ id: 1, pid: 9, qty: 5000, fg: 12000 }), line({ id: 2, pid: 9, qty: 5000, fg: 12000 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].short_qty, 0);
  assert.equal(rows[1].short_qty, 0);
  assert.equal(rows[1].leftover_qty, 1000);

  // Same two orders against a 6,000 pool: the first fills, the second starves.
  const tight = [line({ id: 1, pid: 9, qty: 5000, fg: 6000 }), line({ id: 2, pid: 9, qty: 5000, fg: 6000 })];
  annotateReadyLines(tight, new Map([[9, 100]]));
  assert.equal(tight[0].suggested_dispatch, 5500);
  assert.equal(tight[1].suggested_dispatch, 500);
  assert.equal(tight[1].short_qty, 4500);
  assert.equal(tight[1].leftover_qty, 0);
});

test('S/E: already-dispatched quantity counts against the shortfall', () => {
  const rows = [line({ id: 1, pid: 9, qty: 10000, done: 7000, fg: 1000 })];
  annotateReadyLines(rows, new Map([[9, 100]]));
  assert.equal(rows[0].suggested_dispatch, 1000);
  assert.equal(rows[0].short_qty, 2000);    // 3000 still owed − 1000 available
});
