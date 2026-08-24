// "No limit" dispatch tolerance — the -1 sentinel.
//
// Galpha, Fluence and Pureflix take whatever comes off the press, over or
// short. Before this, the nearest the master could say was a big percentage:
// Fluence and Pureflix both sat at 100%, which caps at TWICE the order. This
// file pins the difference, and pins that a real percentage still blocks —
// a tolerance gate that has stopped stopping anything is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_LIMIT, isNoLimit, toleranceCeiling, ceilingForWire,
  toleranceRoom, exceedsTolerance, toleranceLabel, hasTolerance,
} from './tolerance.js';
import * as client from '../../client/src/lib/tolerance.js';
import { cascadeAllocate, annotateReadyLines } from './tolerance-cascade.js';

// ── the sentinel ──────────────────────────────────────────────────────────
test('NO_LIMIT is -1, and only negatives read as no-limit', () => {
  assert.equal(NO_LIMIT, -1);
  assert.equal(isNoLimit(-1), true);
  assert.equal(isNoLimit(0), false);
  assert.equal(isNoLimit(10), false);
  assert.equal(isNoLimit(100), false, '100% is a real ceiling — twice the order, not no limit');
});

test('a stray negative reads as no-limit rather than a ceiling BELOW the order', () => {
  // -5 would arithmetically give floor(qty * 0.95) — a gate that refuses
  // dispatches the order plainly allows. The DB CHECK forbids it; this is the
  // belt to that braces.
  assert.equal(isNoLimit(-5), true);
  assert.equal(toleranceCeiling(1000, -5), Infinity);
});

test('junk is not no-limit', () => {
  for (const v of [null, undefined, '', 'abc', NaN, Infinity, -Infinity]) {
    assert.equal(isNoLimit(v), false, `${String(v)} must not open the gate`);
  }
});

// ── the gate, which must FAIL before it may pass ──────────────────────────
test('a 10% customer is still blocked past the ceiling', () => {
  assert.equal(toleranceCeiling(1000, 10), 1100);
  assert.equal(exceedsTolerance(1100, 1000, 10), false, 'exactly at the ceiling is allowed');
  assert.equal(exceedsTolerance(1101, 1000, 10), true, 'one over is refused');
  assert.equal(toleranceRoom(1000, 950, 10), 150);
});

test('a 0% customer is held to the ordered quantity exactly', () => {
  assert.equal(toleranceCeiling(1000, 0), 1000);
  assert.equal(exceedsTolerance(1001, 1000, 0), true);
});

test('100% still caps at twice the order — the old workaround was never no-limit', () => {
  assert.equal(toleranceCeiling(1000, 100), 2000);
  assert.equal(exceedsTolerance(2001, 1000, 100), true);
});

test('no limit never blocks, at any quantity', () => {
  assert.equal(toleranceCeiling(1000, NO_LIMIT), Infinity);
  assert.equal(toleranceRoom(1000, 5000, NO_LIMIT), Infinity);
  for (const total of [0, 1000, 1001, 2001, 1e9]) {
    assert.equal(exceedsTolerance(total, 1000, NO_LIMIT), false, `total ${total}`);
  }
});

test('the ceiling never rounds up into a carton that was not ordered', () => {
  // 333 × 1.05 = 349.65 — the plant may ship 349, not 350.
  assert.equal(toleranceCeiling(333, 5), 349);
});

// ── the wire ──────────────────────────────────────────────────────────────
test('Infinity never reaches a response body', () => {
  // JSON.stringify(Infinity) is the string "null", so an Infinity ceiling on
  // the wire arrives as null anyway — but silently, and only for SOME rows.
  // ceilingForWire makes that explicit and testable.
  assert.equal(ceilingForWire(1000, 10), 1100);
  assert.equal(ceilingForWire(1000, NO_LIMIT), null);
  assert.equal(JSON.stringify({ m: ceilingForWire(1000, NO_LIMIT) }), '{"m":null}');
});

// ── labels ────────────────────────────────────────────────────────────────
test('labels: no screen ever prints ±-1%', () => {
  assert.equal(toleranceLabel(NO_LIMIT), 'No limit');
  assert.equal(toleranceLabel(10), '±10%');
  assert.equal(toleranceLabel(0), '±0%');
  assert.equal(hasTolerance(0), false, '0 is the default — not worth a chip');
  assert.equal(hasTolerance(10), true);
  assert.equal(hasTolerance(NO_LIMIT), true, 'no-limit is the loudest case of all');
});

// ── the cascade ───────────────────────────────────────────────────────────
test('a no-limit line does NOT swallow the whole product pool', () => {
  // 300 available, two orders of 100 each. Under a ceiling-driven suggestion an
  // unbounded first line would take all 300 and the second would read as short.
  const { allocations, leftover } = cascadeAllocate(300, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: NO_LIMIT },
    { order_line_id: 2, order_id: 20, ordered: 100, dispatched: 0, tolerance_pct: NO_LIMIT },
  ]);
  assert.equal(allocations[0].dispatch_qty, 100, 'suggestion stops at what the order wants');
  assert.equal(allocations[1].dispatch_qty, 100);
  assert.equal(leftover, 100, 'the rest is left to box, not dumped on order 1');
});

test('a no-limit allocation reports no ceiling and never flags the tolerance band', () => {
  const { allocations } = cascadeAllocate(500, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: NO_LIMIT },
  ]);
  const a = allocations[0];
  assert.equal(a.allowed_max, null, 'null = no ceiling; Infinity would not survive JSON');
  assert.equal(a.tolerance_no_limit, true);
  assert.equal(a.tolerance_pct, NO_LIMIT, 'the sentinel survives the round trip');
  assert.equal(a.tolerance_room, 100, 'cascade room is the outstanding need');
  assert.equal(a.uses_tolerance, false, 'the suggestion never dips into a band that does not exist');
  assert.equal(a.fills_order, true);
  // The whole allocation must survive a response body intact.
  assert.deepEqual(JSON.parse(JSON.stringify(a)).allowed_max, null);
});

test('a finite tolerance still fills into its band ahead of the next order', () => {
  const { allocations, leftover } = cascadeAllocate(300, [
    { order_line_id: 1, order_id: 10, ordered: 100, dispatched: 0, tolerance_pct: 10 },
    { order_line_id: 2, order_id: 20, ordered: 100, dispatched: 0, tolerance_pct: NO_LIMIT },
  ]);
  assert.equal(allocations[0].dispatch_qty, 110, '10% line takes its ceiling');
  assert.equal(allocations[0].allowed_max, 110, 'floored — 100 * 1.1 is 110.00000000000001 in float');
  assert.equal(allocations[1].dispatch_qty, 100, 'no-limit line takes only its need');
  assert.equal(leftover, 90);
});

test('annotateReadyLines carries the no-limit flag onto the dispatch row', () => {
  const rows = [
    { order_line_id: 1, product_id: 7, qty: 100, dispatched_qty: 0, fg_qty: 250, tolerance_pct: NO_LIMIT },
  ];
  annotateReadyLines(rows, new Map([[7, 0]]));
  assert.equal(rows[0].tolerance_no_limit, true);
  assert.equal(rows[0].allowed_max, null);
  assert.equal(rows[0].suggested_dispatch, 100);
  assert.equal(rows[0].short_qty, 0);
  assert.equal(rows[0].leftover_qty, 150, 'the surplus is the pool\'s, to be boxed');
});

// ── the twin ──────────────────────────────────────────────────────────────
// client/src/lib/tolerance.js is a copy, because the browser cannot import from
// server/. A copy that drifts is how a screen ends up clamping an input the API
// would have accepted, so every exported function is compared case for case.
test('the client twin agrees with the server, function for function', () => {
  const pcts = [NO_LIMIT, -5, 0, 5, 10, 100, '10', null, undefined, ''];
  const qtys = [0, 1, 333, 1000];
  assert.equal(client.NO_LIMIT, NO_LIMIT);
  for (const pct of pcts) {
    assert.equal(client.isNoLimit(pct), isNoLimit(pct), `isNoLimit(${String(pct)})`);
    assert.equal(client.toleranceLabel(pct), toleranceLabel(pct), `toleranceLabel(${String(pct)})`);
    assert.equal(client.hasTolerance(pct), hasTolerance(pct), `hasTolerance(${String(pct)})`);
    for (const qty of qtys) {
      assert.equal(client.toleranceCeiling(qty, pct), toleranceCeiling(qty, pct), `ceiling(${qty},${String(pct)})`);
      assert.equal(client.ceilingForWire(qty, pct), ceilingForWire(qty, pct), `wire(${qty},${String(pct)})`);
      assert.equal(client.toleranceRoom(qty, 50, pct), toleranceRoom(qty, 50, pct), `room(${qty},${String(pct)})`);
      assert.equal(client.exceedsTolerance(qty, 500, pct), exceedsTolerance(qty, 500, pct), `exceeds(${qty},${String(pct)})`);
    }
  }
});

test('both copies export the same surface', () => {
  const names = Object.keys(client).sort();
  assert.deepEqual(names, [
    'NO_LIMIT', 'ceilingForWire', 'exceedsTolerance', 'hasTolerance',
    'isNoLimit', 'toleranceCeiling', 'toleranceLabel', 'toleranceRoom',
  ]);
});
