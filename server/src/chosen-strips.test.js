import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chosenStrips, chosenCutsValid, leftoverStrips, childFit } from './helpers.js';
import * as client from '../../client/src/lib/cutFit.js';

// Anik's own case: child 12.66×23 from a 24×38 board. Grid = 3×1 (three
// across the 38, one across the 24). Take 1, bank the tail.
const board = { sheet_l: 38, sheet_w: 24 };
const child = { child_l: 12.66, child_w: 23 };

test('k = max on a plain grid banks exactly what leftoverStrips banks', () => {
  assert.deepEqual(chosenStrips(board, child, 3), leftoverStrips(board, child));
});

test('take 1 of 3 — the un-cut tail plus the under-row strip', () => {
  const s = chosenStrips(board, child, 1);
  // tail: (38 − 1×12.66) × 24 = 25.34×24 (usable); under-row: 12.66×(24−23) = 12.66×1
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { l: 25.34, w: 24, usable: true, strips_per_parent: 1 });
  assert.equal(s[1].usable, false); // 12.66×1 — under 3", waste not stock
});

test('take 2 of 3 — smaller tail, still clean', () => {
  const s = chosenStrips(board, child, 2);
  assert.deepEqual(s[0], { l: 24, w: 12.68, usable: true, strips_per_parent: 1 });
});

test('multi-row grid: k must sit on a whole-column boundary', () => {
  const b2 = { sheet_l: 40, sheet_w: 30 }, c2 = { child_l: 10, child_w: 14 };
  // grid: 4 along 40 (10s) × 2 along 30 (14s) = 8
  assert.equal(chosenCutsValid(b2, c2, 8).ok, true);
  assert.equal(chosenCutsValid(b2, c2, 6).ok, true);   // 3 columns × 2
  assert.equal(chosenCutsValid(b2, c2, 5).ok, false);  // ragged — not clean rectangles
  const s = chosenStrips(b2, c2, 6);
  // tail: (40 − 3×10) × 30 = 30×10; bottom: 30 × (30 − 2×14) = 30×2 (waste)
  assert.deepEqual(s[0], { l: 30, w: 10, usable: true, strips_per_parent: 1 });
});

test('k above max is invalid, k below 1 is invalid', () => {
  assert.equal(chosenCutsValid(board, child, 4).ok, false);
  assert.equal(chosenCutsValid(board, child, 0).ok, false);
  assert.equal(chosenCutsValid(board, child, 3).max, 3);
});

// Task 5 (routes/orders.js's plan-save) 409s a chosen-cuts rejection with
// `${mat.name}: ${why}` — the planner only sees `why`, so it must name the
// real ceiling rather than just failing silently. This is the plain
// over-max case (k past fit.count entirely); the gap-fixture tests further
// down already pin the OTHER message, for k strictly between the grid cap
// and fit.count.
test('over-max rejection names the real max in its message', () => {
  const fit = childFit(board, child);
  const v = chosenCutsValid(board, child, fit.count + 1);
  assert.equal(v.ok, false);
  assert.equal(v.max, fit.count);
  assert.match(v.why, new RegExp(String(fit.count)));
});

// Regression guard for bestGridOrientation: a plain-grid fit where ROTATED
// beats normal. Every other grid fixture in this file (board/child above,
// b2/c2 below) happens to be normal-winning, so a revert of
// bestGridOrientation back to the plan-literal `fit.orientation === 'rotated'
// ? swap : noswap` would still pass them all — childFit only ever disagrees
// with that naive pick on a mixed/area-basis fit (see the gap fixture
// further down), never on a genuine grid-basis one, where fit.orientation
// IS already 'rotated'/'normal' correctly. This fixture instead pins that
// bestGridOrientation's OWN normal-vs-rotated arithmetic agrees with
// childFit's — hand-verified: childFit({sheet_l:30,sheet_w:40},
// {child_l:10,child_w:14}) → normal = floor(30/10)*floor(40/14) = 3×2 = 6;
// rotated = floor(30/14)*floor(40/10) = 2×4 = 8; rotated wins, so the grid
// runs 2 columns (along the 30) of 4 (along the 40), each child laid
// child_w-along-30 / child_l-along-40. Taking k=4 (2 rows worth = half the
// 2×4 grid, c=1 of 2 columns) leaves: tail (30 − 1×14)×40 = 16×40, and an
// under-row strip 14×(40 − 4×10) = 14×0, filtered — a single clean strip.
test('rotated-winning plain grid: sub-max k banks the strip on the ROTATED grid', () => {
  const P = { sheet_l: 30, sheet_w: 40 }, c4 = { child_l: 10, child_w: 14 };
  const fit = childFit(P, c4);
  assert.equal(fit.basis, 'grid');
  assert.equal(fit.orientation, 'rotated'); // precondition: rotated must win here
  assert.equal(chosenCutsValid(P, c4, 4).ok, true);
  assert.deepEqual(chosenStrips(P, c4, 4),
    [{ l: 40, w: 16, usable: true, strips_per_parent: 1 }]);
});

// FIXTURE: taken from cut-sizing.test.js's own worked example off the
// plant's 31.5×41.5 parent — "31.5×41.5: 13.75×17.75 is 5 cuts, won by a
// real one-cut mixed layout" (that file's line ~31). Verified directly
// before use: childFit({sheet_l:31.5,sheet_w:41.5}, {child_l:13.75,
// child_w:17.75}) → { count: 5, basis: 'mixed', orientation: 'mixed' }, and
// leftoverStrips for the same pair is already asserted [] in cut-sizing.
// test.js's "a denser layout banks nothing" test.
const FIXTURE = {
  board: { sheet_l: 31.5, sheet_w: 41.5 },
  child: { child_l: 13.75, child_w: 17.75 },
};

test('a non-grid fit at its own max banks exactly what leftoverStrips banks: nothing', () => {
  const { board: b3, child: c3 } = FIXTURE;
  const fit = childFit(b3, c3);
  assert.notEqual(fit.basis, 'grid');
  assert.deepEqual(chosenStrips(b3, c3, fit.count), leftoverStrips(b3, c3)); // both empty
  assert.equal(chosenStrips(b3, c3, fit.count).length, 0);
});

test('unsized board answers empty/invalid rather than throwing', () => {
  assert.deepEqual(chosenStrips({}, child, 1), []);
  assert.equal(chosenCutsValid({}, child, 1).ok, false);
});

// Regression guard for the gap branch: a k strictly between the plain-grid
// cap and fit.count is invalid, and the message must name the real boundary
// numbers rather than the misleading "between 1 and max" — a value in that
// range too. Board/child chosen so the gap is two wide (grid cap 24 vs
// count 26), unlike FIXTURE above (cap 4 vs count 5, adjacent — no integer
// k can ever land strictly between them, so that fixture cannot exercise
// this branch at all). Verified directly: childFit({sheet_l:38,sheet_w:24},
// {child_l:4,child_w:8.5}) → { count: 26, basis: 'mixed', orientation:
// 'mixed' }; the naive `fit.orientation === 'rotated'` pick would compute a
// grid cap of 18 here (wrong orientation) and wrongly reject k=24 — see
// bestGridOrientation's own comment in helpers.js for the full derivation.
const gapBoard = { sheet_l: 38, sheet_w: 24 };
const gapChild = { child_l: 4, child_w: 8.5 };

test('gap fixture sanity: mixed basis, count 26, true rotated grid cap 24', () => {
  const fit = childFit(gapBoard, gapChild);
  assert.equal(fit.basis, 'mixed');
  assert.equal(fit.count, 26);
});

test('k at the true (rotated) grid cap is valid even though childFit never names that orientation', () => {
  assert.equal(chosenCutsValid(gapBoard, gapChild, 24).ok, true);
  assert.deepEqual(chosenStrips(gapBoard, gapChild, 24),
    [{ l: 24, w: 4, usable: true, strips_per_parent: 1 }]);
});

test('k in the gap between the grid cap and count is invalid, and why names both boundaries', () => {
  const v = chosenCutsValid(gapBoard, gapChild, 25);
  assert.equal(v.ok, false);
  assert.match(v.why, /24/); // the grid cap it must not exceed
  assert.match(v.why, /26/); // the full count, reachable only by taking all of it
});

test('client twin produces identical output', () => {
  for (const k of [1, 2, 3]) {
    assert.deepEqual(
      client.chosenStrips(38, 24, 12.66, 23, k),
      chosenStrips(board, child, k));
  }
  assert.deepEqual(client.chosenCutsValid(38, 24, 12.66, 23, 2),
    chosenCutsValid(board, child, 2));

  // Mirror the gap-branch banking case (k at the true rotated grid cap) and
  // the gap-rejection case.
  assert.deepEqual(
    client.chosenStrips(38, 24, 4, 8.5, 24),
    chosenStrips(gapBoard, gapChild, 24));
  assert.deepEqual(
    client.chosenCutsValid(38, 24, 4, 8.5, 25),
    chosenCutsValid(gapBoard, gapChild, 25));

  // Mirror the rotated-winning plain-grid case.
  assert.deepEqual(
    client.chosenStrips(30, 40, 10, 14, 4),
    chosenStrips({ sheet_l: 30, sheet_w: 40 }, { child_l: 10, child_w: 14 }, 4));
});
