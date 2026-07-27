import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pressOverride } from './helpers.js';

test('pressOverride: starting on a press other than the planned one', () => {
  assert.equal(pressOverride('printing', 13, 8), true);
});
test('pressOverride: starting on the planned press is not an override', () => {
  assert.equal(pressOverride('printing', 13, 13), false);
});
test('pressOverride: ids compare numerically, not as strings', () => {
  assert.equal(pressOverride('printing', 13, '13'), false);
  assert.equal(pressOverride('printing', '13', 8), true);
});
test('pressOverride: nothing planned means nothing was overridden', () => {
  assert.equal(pressOverride('printing', null, 8), false);
});
test('pressOverride: no machine started means nothing was overridden', () => {
  assert.equal(pressOverride('printing', 13, null), false);
});
test('pressOverride: only printing has a planned press', () => {
  assert.equal(pressOverride('cutting', 13, 8), false);
  assert.equal(pressOverride('die_cutting', 13, 8), false);
});
