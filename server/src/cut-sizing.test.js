// Cut sizing — the numbers the floor actually gets off a parent sheet.
//
// childFit tries three layouts and reports which one won in `basis`:
//   grid   one orientation across the whole parent (the original math)
//   mixed  one guillotine cut, each block gridded its own way — ordinary
//          combination cutting, always a layout you can draw
//   area   the quarter-sheet reach, caged to a single family of sizes
//
// This file is the contract for all three. The `basis: 'area'` cases are the
// plant's own numbers, not geometry — see helpers.childFit for why they are
// fenced as tightly as they are. The must-not-inflate block below is the more
// important half of this file: it pins the sizes whose area ceiling is one
// higher than anything you can physically cut, and which must therefore stay
// exactly where they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childFit, cutLayout, leftoverStrips } from './helpers.js';
import { clientFit } from '../../client/src/lib/cutFit.js';

const P = { sheet_l: 31.5, sheet_w: 41.5 };          // the plant's parent sheet
const c = (l, w) => ({ child_l: l, child_w: w });

// ── the plant's worked sizes off 31.5×41.5 ─────────────────────────────────
test('31.5×41.5: 10.5×20.75 is 6 cuts — an exact grid at 100%', () => {
  const fit = childFit(P, c(10.5, 20.75));
  assert.equal(fit.count, 6);
  assert.equal(fit.basis, 'grid');
  assert.equal(fit.utilization, 100);
});

test('31.5×41.5: 13.75×17.75 is 5 cuts, won by a real one-cut mixed layout', () => {
  const fit = childFit(P, c(13.75, 17.75));
  assert.equal(fit.count, 5);
  assert.equal(fit.basis, 'mixed');
  // The layout: a 13.75" column takes 2 upright, the remaining 17.75" column
  // takes 3 on their side. Grid alone only ever found 4.
  assert.equal(Math.floor(31.5 / 13.75) * Math.floor(41.5 / 17.75), 4);
});

test('31.5×41.5: 12.5×19.5 and 13×19 are 5 cuts by the quarter-sheet reach', () => {
  for (const [l, w] of [[12.5, 19.5], [13, 19]]) {
    const fit = childFit(P, c(l, w));
    assert.equal(fit.count, 5, `${l}×${w}`);
    assert.equal(fit.basis, 'area', `${l}×${w} must be flagged as the plant rule, not geometry`);
  }
});

test('the reach carries the neighbouring sizes too — "or nearby", not a lookup table', () => {
  for (const [l, w, want] of [
    [13.5, 17.5, 5], [12.75, 19.25, 5], [13.25, 18.75, 5], [12, 20, 5], [13.5, 18, 5],
  ]) {
    assert.equal(childFit(P, c(l, w)).count, want, `${l}×${w}`);
  }
});

// ── the half that matters more: sizes that must NOT move ───────────────────
// Every one of these has an area ceiling one above its true cut. An earlier
// draft of the reach keyed off utilization alone and inflated all of them.
test('a higher area ceiling alone never buys a cut', () => {
  for (const [l, w, want, why] of [
    [18, 23, 2, 'the classic child sheet — area says 3, two rotated fill it'],
    [16, 21, 2, 'area says 3'],
    [8, 10, 15, 'area says 16'],
    [7, 36, 4, 'long strip, area says 5 — but it is not a quarter shape'],
    [7.5, 38, 4, 'long strip'],
  ]) {
    const fit = childFit(P, c(l, w));
    assert.equal(fit.count, want, `${l}×${w}: ${why}`);
    assert.equal(fit.basis, 'grid', `${l}×${w} must stay a plain grid`);
  }
});

test('exact grids are left alone — no reach when the area ceiling already agrees', () => {
  for (const [l, w, want] of [[15.75, 20.75, 4], [10.5, 13.83, 9], [20, 30, 2], [14, 20, 4]]) {
    assert.equal(childFit(P, c(l, w)).count, want, `${l}×${w}`);
  }
});

test('a child that does not fit at all stays 0 — the reach can never resurrect it', () => {
  const fit = childFit(P, c(40, 50));
  assert.equal(fit.count, 0);
  assert.equal(fit.basis, 'grid');
});

test('other mill sheets get the mixed gain, and nothing they cannot cut', () => {
  const mill = { sheet_l: 25, sheet_w: 36 };
  // Two upright across the top band, one on its side in the band below.
  assert.equal(childFit(mill, c(12.5, 19.5)).count, 3);
  assert.equal(childFit(mill, c(12.5, 19.5)).basis, 'mixed');
  // Area ceilings of 7 and 9 respectively — both impossible, both untouched.
  assert.equal(childFit(mill, c(10, 12)).count, 6);
  assert.equal(childFit(mill, c(8.5, 11)).count, 8);
  assert.equal(childFit(mill, c(12.5, 18)).count, 4);   // exact quarter
});

// ── the invariants the rest of the engine leans on ─────────────────────────
test('cutLayout: a grid still multiplies out; mixed and reached report no grid', () => {
  for (const [l, w] of [[10.5, 20.75], [18, 23], [8, 10], [15.75, 20.75]]) {
    const cut = cutLayout(P, c(l, w));
    assert.equal(cut.basis, 'grid', `${l}×${w}`);
    assert.equal(cut.across * cut.down, cut.count, `${l}×${w}`);
  }
  for (const [l, w] of [[13.75, 17.75], [12.5, 19.5], [13, 19]]) {
    const cut = cutLayout(P, c(l, w));
    assert.notEqual(cut.basis, 'grid', `${l}×${w}`);
    assert.equal(cut.across, null, `${l}×${w} has no single across×down`);
    assert.equal(cut.down, null, `${l}×${w} has no single across×down`);
    assert.equal(cut.count, childFit(P, c(l, w)).count, `${l}×${w}`);
  }
});

test('leftoverStrips: a denser layout banks nothing — the extra cut ate the strip', () => {
  // Grid layout with a real remainder still banks it.
  assert.ok(leftoverStrips(P, c(18, 23)).length > 0);
  // The mixed and reached layouts won their fifth cut out of that remainder,
  // so banking a strip as well would book the same board twice.
  for (const [l, w] of [[13.75, 17.75], [12.5, 19.5], [13, 19]]) {
    assert.deepEqual(leftoverStrips(P, c(l, w)), [], `${l}×${w}`);
  }
});

test('a fit never claims more than the parent physically holds', () => {
  for (let l = 4; l <= 31; l += 0.25) {
    for (let w = 4; w <= 41; w += 0.25) {
      const fit = childFit(P, c(l, w));
      assert.ok(fit.count * l * w <= 31.5 * 41.5 + 1e-6, `${l}×${w} claims more area than the sheet has`);
      assert.ok(fit.utilization <= 100 + 1e-9, `${l}×${w} over 100% utilisation`);
    }
  }
});

// ── client twin parity ─────────────────────────────────────────────────────
// Planning.jsx and the Warehouse Picker recompute the cut locally for live
// previews. A twin that drifts shows a Board Mix green here against a
// requirement the server computes higher, and 409s on save.
test('client twin: identical cut and basis across a full size sweep', () => {
  for (const parent of [P, { sheet_l: 25, sheet_w: 36 }, { sheet_l: 20, sheet_w: 30 }]) {
    for (let l = 4; l <= 30; l += 0.25) {
      for (let w = 4; w <= 40; w += 0.25) {
        const s = childFit(parent, c(l, w));
        const cl = clientFit(parent.sheet_l, parent.sheet_w, l, w);
        assert.equal(cl.cpp, s.count, `${parent.sheet_l}×${parent.sheet_w} / ${l}×${w} count`);
        assert.equal(cl.basis, s.basis, `${parent.sheet_l}×${parent.sheet_w} / ${l}×${w} basis`);
        assert.equal(cl.util, s.utilization, `${parent.sheet_l}×${parent.sheet_w} / ${l}×${w} util`);
        assert.equal(cl.waste, s.waste_pct, `${parent.sheet_l}×${parent.sheet_w} / ${l}×${w} waste`);
      }
    }
  }
});

test('client twin: unsized input returns null on both sides', () => {
  assert.equal(clientFit(null, null, 12, 8), null);
  assert.equal(childFit({}, c(12, 8)).sized, false);
  assert.equal(childFit({}, c(12, 8)).basis, null);
});
