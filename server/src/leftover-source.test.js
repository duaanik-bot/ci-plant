import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftoverSourceLabel } from '../../client/src/lib/leftoverSource.js';

// The Warehouse's From column, on every batch key the plant actually mints.

test('a RUN bank is named as a run, by its own number when known', () => {
  assert.equal(leftoverSourceLabel('LO-PLAN-RUN-8-1', 'CI-GANG-0006'), 'CI-GANG-0006');
  assert.equal(leftoverSourceLabel('LO-PLAN-RUN-12-89', 'CI-MRG-0002'), 'CI-MRG-0002');
});

test('and by its id when the number was not resolved — never as a "line"', () => {
  // The bug this replaces printed `line RUN-8-1`.
  assert.equal(leftoverSourceLabel('LO-PLAN-RUN-8-1'), 'run #8');
  assert.equal(leftoverSourceLabel('LO-PLAN-RUN-123-4'), 'run #123');
});

test('run 12 is never read as run 1 — the dash is the separator', () => {
  assert.equal(leftoverSourceLabel('LO-PLAN-RUN-12-1'), 'run #12');
  assert.notEqual(leftoverSourceLabel('LO-PLAN-RUN-12-1'), 'run #1');
});

test('a v1 line bank is the line', () => {
  assert.equal(leftoverSourceLabel('LO-PLAN-261'), 'line 261');
});

test('a v2 line bank names the LINE, not the board riding on the key', () => {
  assert.equal(leftoverSourceLabel('LO-PLAN-261-89'), 'line 261');
});

test('a confirmed lot is its job card, dashes and all', () => {
  assert.equal(leftoverSourceLabel('LO-CI-JC-0050'), 'CI-JC-0050');
  // A run card's number carries three dashes of its own before the board id —
  // splitting on dashes would truncate it to "CI".
  assert.equal(leftoverSourceLabel('LO-CI-GANG-JC-0003-1'), 'CI-GANG-JC-0003-1');
});

test('anything that is not a leftover key says nothing', () => {
  assert.equal(leftoverSourceLabel('GRN-2026-0012'), '—');
  assert.equal(leftoverSourceLabel(null), '—');
  assert.equal(leftoverSourceLabel(''), '—');
  assert.equal(leftoverSourceLabel(undefined), '—');
});
