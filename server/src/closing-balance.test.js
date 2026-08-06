import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stillToPaste } from '../../client/src/lib/pastingRows.js';

// "when i have entred day count as 5400, and now i want to complete the balance
// why do i see 10200 as balance" — the closing box must offer the BALANCE.
// This is pinned because the same rule has now been got wrong in both
// directions: first netting a SORTING log that was not pasted work, then not
// netting a day log that was.

test('THE CASE — 10,200 pool, 5,400 counted, the box offers 4,800', () => {
  assert.equal(stillToPaste({ pool: 10200, phase: 'paste', priorGood: 5400, priorScrap: 0 }), 4800);
});

test('Anik\'s original spec — 10,000 received, 5,000 day count, 5,000 left', () => {
  assert.equal(stillToPaste({ pool: 10000, phase: 'paste', priorGood: 5000, priorScrap: 0 }), 5000);
});

test('waste already logged counts as handled, not as still-to-do', () => {
  assert.equal(stillToPaste({ pool: 10000, phase: 'paste', priorGood: 5000, priorScrap: 200 }), 4800);
});

test('nothing counted yet — the box offers the whole pool', () => {
  assert.equal(stillToPaste({ pool: 18000, phase: 'paste', priorGood: 0, priorScrap: 0 }), 18000);
});

test('a log that already covers the pool leaves nothing, never a negative', () => {
  assert.equal(stillToPaste({ pool: 9000, phase: 'paste', priorGood: 9000, priorScrap: 0 }), 0);
  assert.equal(stillToPaste({ pool: 9000, phase: 'paste', priorGood: 12000, priorScrap: 0 }), 0);
});
