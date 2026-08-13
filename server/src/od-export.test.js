// OD is a NUMBER in a report, never "47d".
import test from 'node:test';
import assert from 'node:assert/strict';
import { odExport } from '../../client/src/lib/odDays.js';

test('a measured age exports as a bare number, not a suffixed string', () => {
  assert.equal(odExport(47), 47);
  assert.equal(odExport(0), 0, 'a PO raised today is 0 days old, not blank');
  // The whole point: Excel sorts 5 before 47. As text, "47d" sorts before "5d".
  assert.equal(typeof odExport(47), 'number');
});

test('nothing to measure is an em dash, the same as every other empty cell', () => {
  assert.equal(odExport(null), '—');
  assert.equal(odExport(undefined), '—');
});

test('the "d" suffix is gone entirely', () => {
  for (const d of [0, 1, 6, 47, 365]) {
    assert.ok(!String(odExport(d)).includes('d'), `${d} must not carry a d`);
  }
});
