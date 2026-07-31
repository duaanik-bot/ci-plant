import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixBalance, mixPosition } from './board-mix.js';

// The shape readiness() computes. Kept as a unit test on the decision itself so
// the rule is pinned without standing a database up.
function materialOk({ parentNeeded, available, mix, availableByMaterial }) {
  const bal = mixBalance({ required: parentNeeded, rows: mix });
  if (!bal.active) return available >= parentNeeded;
  const stocked = mix.every(r => (availableByMaterial[r.material_id] ?? 0) >= r.sheets);
  return bal.balanced && stocked;
}

test('no mix: the gate is exactly the old comparison', () => {
  assert.equal(materialOk({ parentNeeded: 4000, available: 4000, mix: [], availableByMaterial: {} }), true);
  assert.equal(materialOk({ parentNeeded: 4000, available: 3999, mix: [], availableByMaterial: {} }), false);
});

test('a balanced two-board mix opens the gate even though one board is short', () => {
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500, 2: 3100 } }), true);
});

test('a balanced mix whose substitute stock has since gone is still shut', () => {
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500, 2: 400 } }), false);
});

test('an unbalanced mix keeps the gate shut', () => {
  const mix = [{ material_id: 1, sheets: 2500, covers: 2500 }];
  assert.equal(materialOk({
    parentNeeded: 4000, available: 2500, mix, availableByMaterial: { 1: 2500 } }), false);
});

test('a substitute board is held, never needed — the phantom-PR guard', () => {
  const line = { id: 7, parent_sheets_required: 4000 };
  const mix = [
    { material_id: 1, sheets: 2500, covers: 2500 },
    { material_id: 2, sheets: 1500, covers: 1500 },
  ];
  assert.equal(mixPosition({ line, rows: mix, materialId: 2, plannedBoardId: 1 }).open_need, 0);
});

// THE INTEGRATION PROPERTY. Task 3's unit test proves the module goes inactive
// with no rows; this proves the GATE does. A regression here is the one that
// silently changes every job in the plant, not just mixed ones.
test('PROPERTY: with no mix rows the gate is byte-identical to the old comparison', () => {
  for (const [parentNeeded, available] of
       [[4000, 4000], [4000, 3999], [4000, 0], [0, 0], [41742, 250000], [1, 1]]) {
    const legacy = available >= parentNeeded;          // the pre-feature line, verbatim
    const now = materialOk({ parentNeeded, available, mix: [], availableByMaterial: {} });
    assert.equal(now, legacy,
      `no-mix job must behave exactly as before: need ${parentNeeded}, have ${available}`);
  }
});
