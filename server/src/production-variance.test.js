import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuttingVariance } from './production-variance.js';

test('over-cut: 1400 planned, cpp 2, 3000 children out → 1500 parents, +100', () => {
  const v = cuttingVariance({ qty_out: 3000, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
  assert.equal(v.isVariance, true);
});

test('on-plan: 2800 children out at cpp 2 → 1400 parents, no variance', () => {
  const v = cuttingVariance({ qty_out: 2800, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1400);
  assert.equal(v.parentDelta, 0);
  assert.equal(v.isVariance, false);
});

test('under-cut: 2600 children out at cpp 2 → 1300 parents, -100', () => {
  const v = cuttingVariance({ qty_out: 2600, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1300);
  assert.equal(v.parentDelta, -100);
  assert.equal(v.isVariance, true);
});

test('scrap counts toward parents consumed: 2950 good + 50 scrap at cpp 2 → 1500', () => {
  const v = cuttingVariance({ qty_out: 2950, qty_scrap: 50, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualChildren, 3000);
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
});

test('cpp defaults to 1: 1500 children out → 1500 parents, +100 over 1400', () => {
  const v = cuttingVariance({ qty_out: 1500, qty_scrap: 0, children_per_parent: 1, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
});

test('null/undefined inputs do not throw and report no variance', () => {
  const v = cuttingVariance({ qty_out: 0, qty_scrap: 0, children_per_parent: undefined, sheets_issued: undefined });
  assert.equal(v.cpp, 1);
  assert.equal(v.plannedParents, 0);
  assert.equal(v.actualParents, 0);
  assert.equal(v.isVariance, false);
});
