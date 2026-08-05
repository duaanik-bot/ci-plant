import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smartSeedRow } from '../../client/src/lib/boardMix.js';

test('converts the shortfall by cuts ratio and caps at available stock', () => {
  const s = smartSeedRow({ balanceParent: 1000, plannedUps: 2, cuts: 4, available: 800 });
  assert.equal(s.sheets, 500);
  assert.equal(s.coversParent, 1000);
  assert.equal(s.pendingAfter, 0);
});

test('thin stock covers partially and names the pending remainder', () => {
  const s = smartSeedRow({ balanceParent: 1000, plannedUps: 2, cuts: 2, available: 350 });
  assert.equal(s.sheets, 350);
  assert.equal(s.coversParent, 350);
  assert.equal(s.pendingAfter, 650);
});

test('rounds up the sheet need — a fractional sheet is a whole sheet', () => {
  const s = smartSeedRow({ balanceParent: 1001, plannedUps: 2, cuts: 4, available: 9999 });
  assert.equal(s.sheets, 501);
  assert.ok(s.pendingAfter === 0);
});

test('zero/absent availability seeds nothing rather than a phantom row', () => {
  const s = smartSeedRow({ balanceParent: 500, plannedUps: 2, cuts: 2, available: 0 });
  assert.equal(s.sheets, 0);
  assert.equal(s.pendingAfter, 500);
});

test('guards its preconditions like rowCovers does', () => {
  assert.throws(() => smartSeedRow({ balanceParent: 10, plannedUps: 0, cuts: 2, available: 5 }), /plannedUps/);
  assert.throws(() => smartSeedRow({ balanceParent: 10, plannedUps: 2, cuts: 0, available: 5 }), /cuts/);
});
