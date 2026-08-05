import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuttingVariance, mixCuttingVariance } from './production-variance.js';

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

test('two boards, one over-cut: variance lands on the right board only', () => {
  const v = mixCuttingVariance({ rows: [
    { material_id: 1, issued: 900, cuts: 3, children: 2700 },
    { material_id: 2, issued: 417, cuts: 1, children: 420 },
  ]});
  assert.equal(v.rows[0].parentDelta, 0);
  assert.equal(v.rows[1].actualParents, 420);
  assert.equal(v.rows[1].parentDelta, 3);
  assert.equal(v.isVariance, true);
  assert.equal(v.parentDelta, 3);
  assert.equal(v.actualChildren, 3120);
});

test('clean cut on every board is no variance', () => {
  const v = mixCuttingVariance({ rows: [
    { material_id: 1, issued: 10, cuts: 3, children: 30 },
    { material_id: 2, issued: 5, cuts: 2, children: 10 },
  ]});
  assert.equal(v.isVariance, false);
});

test('empty rows answer zeros rather than throwing', () => {
  const v = mixCuttingVariance({});
  assert.equal(v.isVariance, false);
  assert.equal(v.rows.length, 0);
});

test('single-row parity: mixCuttingVariance agrees with cuttingVariance on the same board', () => {
  // Same scenario as the "over-cut" cuttingVariance test above, expressed as
  // one board through the mixed-job math. children = qty_out + qty_scrap,
  // issued = sheets_issued, cuts = children_per_parent.
  const single = cuttingVariance({ qty_out: 3000, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  const mixed = mixCuttingVariance({ rows: [
    { material_id: 1, issued: 1400, cuts: 2, children: 3000 },
  ]});
  assert.equal(mixed.rows[0].cpp, single.cpp);
  assert.equal(mixed.rows[0].plannedParents, single.plannedParents);
  assert.equal(mixed.rows[0].actualParents, single.actualParents);
  assert.equal(mixed.rows[0].parentDelta, single.parentDelta);
  assert.equal(mixed.rows[0].plannedChildren, single.plannedChildren);
  assert.equal(mixed.rows[0].actualChildren, single.actualChildren);
  assert.equal(mixed.plannedParents, single.plannedParents);
  assert.equal(mixed.actualParents, single.actualParents);
  assert.equal(mixed.parentDelta, single.parentDelta);
  assert.equal(mixed.plannedChildren, single.plannedChildren);
  assert.equal(mixed.actualChildren, single.actualChildren);
  assert.equal(mixed.isVariance, single.isVariance);
});

// ── distributing a board's ACTUAL parents back across a merge run's members ─
// The rule under test is the one production.js applies blind at cutting
// completion: round half-up per member proportional to issued shares, clamped
// so the running total never overshoots, last member takes the exact
// remainder — Σ always equals the total, to the sheet.
import { distributeActualAcrossMembers } from './production-variance.js';

test('distribute: proportional shares land proportionally', () => {
  assert.deepEqual(distributeActualAcrossMembers(100, [25, 75]), [25, 75]);
  assert.deepEqual(distributeActualAcrossMembers(90, [30, 60]), [30, 60]);
});

test('distribute: round half-up, last member takes the remainder', () => {
  // 10 across 3 equal shares: 3.33→3, 3.33→3, last takes 4.
  assert.deepEqual(distributeActualAcrossMembers(10, [1, 1, 1]), [3, 3, 4]);
  // Half exactly rounds UP for the non-last members: 5 across [1,1] → 2.5→3, last 2.
  assert.deepEqual(distributeActualAcrossMembers(5, [1, 1]), [3, 2]);
});

test('distribute: the clamp keeps the remainder non-negative when half-ups stack', () => {
  // 2 across four equal shares: 0.5 rounds up per member — unclamped that is
  // 1+1+1 and a last member at −1, which job_board_mix could never store.
  assert.deepEqual(distributeActualAcrossMembers(2, [1, 1, 1, 1]), [1, 1, 0, 0]);
});

test('distribute: Σ === total across many shapes (the invariant the rewrite relies on)', () => {
  let seed = 987654;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 500; iter++) {
    const memberCount = 1 + rand(6);
    const shares = Array.from({ length: memberCount }, () => rand(3000));
    const total = rand(6000);
    const out = distributeActualAcrossMembers(total, shares);
    assert.equal(out.length, memberCount);
    assert.equal(out.reduce((s, x) => s + x, 0), total, `Σ must be ${total}`);
    assert.ok(out.every(x => Number.isInteger(x) && x >= 0), 'integers, none negative');
  }
});

test('distribute: fractional member shares (the covers-space split) still integerise cleanly', () => {
  // A chosen-cut merge stores 12.5 + 12.5 — the trued 26 splits 13/13.
  assert.deepEqual(distributeActualAcrossMembers(26, [12.5, 12.5]), [13, 13]);
  // And an uneven true-up leans on the larger issuer.
  assert.deepEqual(distributeActualAcrossMembers(27, [12.5, 12.5]), [14, 13]);
});

test('distribute: degenerate shapes — zero shares, empty members, zero total', () => {
  // No basis at all → the whole total lands on the last member.
  assert.deepEqual(distributeActualAcrossMembers(9, [0, 0, 0]), [0, 0, 9]);
  assert.deepEqual(distributeActualAcrossMembers(9, []), []);
  assert.deepEqual(distributeActualAcrossMembers(0, [5, 5]), [0, 0]);
});
