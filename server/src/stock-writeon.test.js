import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWriteOn } from './stock-writeon.js';

test('full cover: book 400, issue 150 → no write-on, nothing extra', () => {
  const p = planWriteOn([{ id: 1, qty: 400 }], 150);
  assert.equal(p.covered, 150);
  assert.equal(p.shortfall, 0);
  assert.equal(p.writeOn, false);
  assert.deepEqual(p.takes, [{ batch_id: 1, take: 150, left: 250 }]);
});

test('partial cover: book 40, issue 150 → write-on of exactly 110', () => {
  const p = planWriteOn([{ id: 7, qty: 40 }], 150);
  assert.equal(p.covered, 40);
  assert.equal(p.shortfall, 110);
  assert.equal(p.writeOn, true);
  assert.deepEqual(p.takes, [{ batch_id: 7, take: 40, left: 0 }]);
});

test('nil stock: book 0, issue 150 → the whole issue is written on', () => {
  const p = planWriteOn([], 150);
  assert.equal(p.covered, 0);
  assert.equal(p.shortfall, 150);
  assert.deepEqual(p.takes, []);
});

test('exact cover leaves the batch empty and writes nothing on', () => {
  const p = planWriteOn([{ id: 3, qty: 40 }], 40);
  assert.equal(p.shortfall, 0);
  assert.deepEqual(p.takes, [{ batch_id: 3, take: 40, left: 0 }]);
});

test('draws batches in the order given — FIFO is the callers query, not ours', () => {
  const p = planWriteOn([{ id: 1, qty: 30 }, { id: 2, qty: 30 }, { id: 3, qty: 30 }], 70);
  assert.deepEqual(p.takes, [
    { batch_id: 1, take: 30, left: 0 },
    { batch_id: 2, take: 30, left: 0 },
    { batch_id: 3, take: 10, left: 20 },
  ]);
  assert.equal(p.shortfall, 0);
});

test('zero demand is a no-op', () => {
  const p = planWriteOn([{ id: 1, qty: 400 }], 0);
  assert.deepEqual(p.takes, []);
  assert.equal(p.writeOn, false);
});

test('a negative batch already in the data is skipped, never credited', () => {
  const p = planWriteOn([{ id: 1, qty: -150 }, { id: 2, qty: 40 }], 100);
  assert.deepEqual(p.takes, [{ batch_id: 2, take: 40, left: 0 }]);
  assert.equal(p.shortfall, 60);
});
