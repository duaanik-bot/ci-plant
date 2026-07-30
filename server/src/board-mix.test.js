import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCovers, mixBalance } from './board-mix.js';

test('a same-ups row covers its own sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 6, planned_ups: 6 }), 1500);
});

test('a higher-ups row covers more than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1500, ups: 8, planned_ups: 6 }), 2000);
});

test('a lower-ups row covers less than its sheet count', () => {
  assert.equal(rowCovers({ sheets: 1200, ups: 4, planned_ups: 6 }), 800);
});

test('planned_ups of zero throws rather than dividing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 6, planned_ups: 0 }), /planned_ups/);
});

test('row ups of zero throws — a board that fits nothing covers nothing', () => {
  assert.throws(() => rowCovers({ sheets: 100, ups: 0, planned_ups: 6 }), /ups/);
});

test('a two-board mix that sums to the requirement is balanced', () => {
  const line = { parent_sheets_required: 4000 };
  const rows = [{ covers: 2500 }, { covers: 1500 }];
  const b = mixBalance({ line, rows });
  assert.equal(b.active, true);
  assert.equal(b.required, 4000);
  assert.equal(b.covered, 4000);
  assert.equal(b.balance, 0);
  assert.equal(b.balanced, true);
});

test('an under-allocated mix reports the remaining balance', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [{ covers: 2500 }] });
  assert.equal(b.balance, 1500);
  assert.equal(b.balanced, false);
});

test('an over-allocated mix reports a negative balance and is not balanced', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [{ covers: 2500 }, { covers: 2000 }] });
  assert.equal(b.balance, -500);
  assert.equal(b.balanced, false);
});

// These are DOUBLE PRECISION columns. `covered === required` is the trap that
// already caught the replenishment code — 0.1+0.2 style drift must still read
// as balanced.
test('float drift under EPS still counts as balanced', () => {
  const rows = [{ covers: 0.1 }, { covers: 0.2 }];
  const b = mixBalance({ line: { parent_sheets_required: 0.3 }, rows });
  assert.notEqual(b.covered, 0.3, 'precondition: this sum really is inexact');
  assert.equal(b.balanced, true);
});

test('no rows means the mix is not in play at all', () => {
  const b = mixBalance({ line: { parent_sheets_required: 4000 }, rows: [] });
  assert.equal(b.active, false);
  assert.equal(b.balanced, false);
});

test('requirement falls back to sheets_required when parent_sheets_required is absent', () => {
  const b = mixBalance({ line: { sheets_required: 900 }, rows: [{ covers: 900 }] });
  assert.equal(b.required, 900);
  assert.equal(b.balanced, true);
});
