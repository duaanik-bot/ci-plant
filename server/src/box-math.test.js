import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBreakdown } from './box-math.js';

test('whole boxes + loose remainder', () => {
  assert.deepEqual(boxBreakdown(201000, 1990), { boxes: 101, loose: 10, per: 1990, total: 201000 });
});

test('exact multiple leaves no loose', () => {
  assert.deepEqual(boxBreakdown(200000, 2000), { boxes: 100, loose: 0, per: 2000, total: 200000 });
});

test('real OVERZYME case (2000/box)', () => {
  assert.deepEqual(boxBreakdown(201000, 2000), { boxes: 100, loose: 1000, per: 2000, total: 201000 });
});

test('zero qty', () => {
  assert.deepEqual(boxBreakdown(0, 1990), { boxes: 0, loose: 0, per: 1990, total: 0 });
});

test('no per-box size → all loose', () => {
  assert.deepEqual(boxBreakdown(3980, 0), { boxes: 0, loose: 3980, per: 0, total: 3980 });
});

test('negative / junk inputs floor to safe values', () => {
  assert.deepEqual(boxBreakdown(-5, 100), { boxes: 0, loose: 0, per: 100, total: 0 });
  assert.deepEqual(boxBreakdown(250.9, 100.7), { boxes: 2, loose: 50, per: 100, total: 250 });
});
