import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillToPaste } from '../../client/src/lib/pastingRows.js';

test('while SORTING, the pasting grid still covers the whole pool', () => {
  // 5,400 sorted so far — but nothing pasted, so the closing grid owes all
  // 10,200. Getting this wrong is what produced the 409 on CI-JC-0004.
  assert.equal(stillToPaste({ pool: 10200, phase: 'sort', priorGood: 5400 }), 10200);
});

test('while PASTING, only the balance is owed', () => {
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste', priorGood: 5400 }), 4800);
});

test('pasting waste already logged consumes the pool too', () => {
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste', priorGood: 5000, priorScrap: 400 }), 4800);
});

test('a fully-pasted stage owes nothing, and never goes negative', () => {
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste', priorGood: 10200 }), 0);
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste', priorGood: 99999 }), 0);
});

test('no log at all owes the whole pool, in either phase', () => {
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste' }), 10200);
  assert.equal(stillToPaste({ pool: 10200, phase: 'sort' }), 10200);
  assert.equal(stillToPaste({}), 0);
});
