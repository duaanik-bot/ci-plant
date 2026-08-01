// cutLayout — the printable arrangement (across × down, rotated?) behind
// childFit's own count. The plant calls childFit's count "cuts", never "ups"
// (that word means something else entirely — products.ups, the printed
// images per print sheet). cutLayout must never re-decide normal-vs-rotated
// itself: it is derived FROM childFit's result, so the two can never quote a
// different count for the same parent/child pair. See helpers.js's own
// comment on both functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childFit, cutLayout } from './helpers.js';

// A spread of real-shaped boards/children, deliberately including:
//  - a plain normal-wins case
//  - a rotated-wins case
//  - an exact tie (normal must win)
//  - a zero-fit case (child bigger than parent on both axes)
//  - unsized inputs (missing dims on either side)
const CASES = [
  // normal wins outright
  { parent: { sheet_l: 36, sheet_w: 24 }, child: { child_l: 12, child_w: 8 } },
  // rotated wins outright — 2×2=4 rotated beats 3×1=3 normal
  { parent: { sheet_l: 30, sheet_w: 20 }, child: { child_l: 9, child_w: 14 } },
  // exact tie — a square parent and a square child: normal === rotated
  { parent: { sheet_l: 20, sheet_w: 20 }, child: { child_l: 10, child_w: 10 } },
  // a non-square tie: normal and rotated land on the identical count
  { parent: { sheet_l: 24, sheet_w: 12 }, child: { child_l: 12, child_w: 6 } },
  // zero fit — child bigger than the parent on both axes in both orientations
  { parent: { sheet_l: 10, sheet_w: 10 }, child: { child_l: 20, child_w: 20 } },
  // a real plant pair (from board-math.test.js's golden values)
  { parent: { sheet_l: 23, sheet_w: 36 }, child: { child_l: 11.5, child_w: 9 } },
  { parent: { sheet_l: 24.6, sheet_w: 31.2 }, child: { child_l: 12.3, child_w: 7.8 } },
  // unsized: parent has no dimensions at all
  { parent: {}, child: { child_l: 12, child_w: 8 } },
  // unsized: child has no dimensions at all
  { parent: { sheet_l: 36, sheet_w: 24 }, child: {} },
  // unsized: both null
  { parent: { sheet_l: null, sheet_w: null }, child: { child_l: null, child_w: null } },
];

test('cutLayout: count always matches childFit — the property that must never break', () => {
  for (const { parent, child } of CASES) {
    const fit = childFit(parent, child);
    const cut = cutLayout(parent, child);
    assert.equal(cut.count, fit.count, `count mismatch for ${JSON.stringify({ parent, child })}`);
  }
});

test('cutLayout: sized, positive-fit rows carry an across×down that reproduces the count', () => {
  for (const { parent, child } of CASES) {
    const fit = childFit(parent, child);
    const cut = cutLayout(parent, child);
    if (!fit.sized || fit.count <= 0) continue;
    assert.ok(Number.isInteger(cut.across) && cut.across >= 0);
    assert.ok(Number.isInteger(cut.down) && cut.down >= 0);
    assert.equal(cut.across * cut.down, cut.count);
    assert.equal(cut.rotated, fit.orientation === 'rotated');
  }
});

test('cutLayout: rotated-wins case reports rotated:true and the rotated arrangement', () => {
  const parent = { sheet_l: 30, sheet_w: 20 };
  const child = { child_l: 9, child_w: 14 };
  const fit = childFit(parent, child);
  assert.equal(fit.orientation, 'rotated'); // rotated 2×2=4 beats normal 3×1=3
  const cut = cutLayout(parent, child);
  assert.equal(cut.rotated, true);
  assert.equal(cut.count, fit.count);
  // Rotated orientation cuts on child_w along the parent's length, child_l down.
  assert.equal(cut.across, Math.floor(30 / 14 + 1e-6));
  assert.equal(cut.down, Math.floor(20 / 9 + 1e-6));
});

test('cutLayout: an exact tie resolves to normal (never rotated), matching childFit', () => {
  const parent = { sheet_l: 24, sheet_w: 12 };
  const child = { child_l: 12, child_w: 6 };
  const fit = childFit(parent, child);
  assert.equal(fit.orientation, 'normal');
  const cut = cutLayout(parent, child);
  assert.equal(cut.rotated, false);
  assert.equal(cut.across, Math.floor(24 / 12 + 1e-6));
  assert.equal(cut.down, Math.floor(12 / 6 + 1e-6));
});

test('cutLayout: zero-fit case returns count 0 and never throws', () => {
  const parent = { sheet_l: 10, sheet_w: 10 };
  const child = { child_l: 20, child_w: 20 };
  const fit = childFit(parent, child);
  assert.equal(fit.count, 0);
  const cut = cutLayout(parent, child);
  assert.equal(cut.count, 0);
  assert.equal(cut.across * cut.down, 0);
});

test('cutLayout: unsized parent or child returns null across/down, count 1 — never throws', () => {
  for (const { parent, child } of [
    { parent: {}, child: { child_l: 12, child_w: 8 } },
    { parent: { sheet_l: 36, sheet_w: 24 }, child: {} },
    { parent: { sheet_l: null, sheet_w: null }, child: { child_l: null, child_w: null } },
  ]) {
    const cut = cutLayout(parent, child);
    assert.equal(cut.count, 1);
    assert.equal(cut.across, null);
    assert.equal(cut.down, null);
    assert.equal(cut.rotated, false);
  }
});
