import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balanceWaste } from '../../client/src/lib/pasteBalance.js';

// Anik's two cases, verbatim. This module exists because the same arithmetic has
// been got wrong four times in two days by being re-derived at each call site.

test('CASE 1 — produced under what came in: the gap IS the waste', () => {
  // received 5,200, complete qty 5,000 → sorting waste auto-fills to 200.
  const r = balanceWaste({ received: 5200, produced: 5000 });
  assert.equal(r.sortWaste, 200);
  assert.equal(r.pasteWaste, 0);
  assert.equal(r.output, 5000);
  assert.equal(r.over, 0);
});

test('CASE 1 — filling pasting waste rebalances sorting, never the total', () => {
  // "once i fill pasting waste 100 u balance"
  const r = balanceWaste({ received: 5200, produced: 5000, pasteWaste: 100, edited: 'paste' });
  assert.equal(r.pasteWaste, 100);
  assert.equal(r.sortWaste, 100);
  assert.equal(r.totalWaste, 200, 'the pair still accounts for the whole gap');
});

test('CASE 1 — it balances from EITHER side', () => {
  const r = balanceWaste({ received: 5200, produced: 5000, sortWaste: 150, edited: 'sort' });
  assert.equal(r.sortWaste, 150);
  assert.equal(r.pasteWaste, 50);
  assert.equal(r.totalWaste, 200);
});

test('CASE 1 — a figure beyond the gap is clamped, never negative on the other side', () => {
  const r = balanceWaste({ received: 5200, produced: 5000, pasteWaste: 900, edited: 'paste' });
  assert.equal(r.pasteWaste, 200, 'cannot waste more than went missing');
  assert.equal(r.sortWaste, 0);
});

test('CASE 2 — produced OVER what came in: output stands, nothing is derived', () => {
  // received 5,200, complete qty 5,300 (allowed), both wastes typed freely.
  const r = balanceWaste({ received: 5200, produced: 5300, sortWaste: 200, pasteWaste: 100 });
  assert.equal(r.output, 5300, 'total output remains 5,300');
  assert.equal(r.sortWaste, 200);
  assert.equal(r.pasteWaste, 100);
  assert.equal(r.over, 100);
  assert.equal(r.overPct, 1.9, 'over-yield recorded as a percentage of what came in');
});

test('CASE 2 — over-production does not invent waste', () => {
  const r = balanceWaste({ received: 5200, produced: 5300 });
  assert.equal(r.sortWaste, 0);
  assert.equal(r.pasteWaste, 0);
  assert.equal(r.totalWaste, 0);
});

test('multi-day: the gap is measured on the STAGE total, not the closing entry', () => {
  // 10,000 received, 5,000 already counted, 4,800 closing → 200 short overall.
  const r = balanceWaste({ received: 10000, produced: 5000 + 4800 });
  assert.equal(r.sortWaste, 200);
  assert.equal(r.output, 9800);
});

test('exactly on target leaves nothing to account for', () => {
  const r = balanceWaste({ received: 5000, produced: 5000 });
  assert.equal(r.totalWaste, 0);
  assert.equal(r.over, 0);
  assert.equal(r.overPct, 0);
});

test('percentages are of everything handled, and TOTAL 100', () => {
  // Rounded independently these are 94.5 + 3.6 + 1.8 = 99.9, and a report adding
  // that column is short a tenth on every job. Yield carries the remainder.
  const r = balanceWaste({ received: 5500, produced: 5200, pasteWaste: 100, edited: 'paste' });
  assert.equal(r.sortWaste, 200);
  assert.equal(r.handled, 5500);
  assert.equal(r.sortPct, 3.6);
  assert.equal(r.pastePct, 1.8);
  assert.equal(r.yieldPct, 94.6, 'the remainder, not an independent rounding');
  // Compared at the precision we store: 94.6 + 3.6 + 1.8 is 99.99999999999999 in
  // binary floating point, which is a property of the language, not of the sum.
  assert.equal(Math.round((r.yieldPct + r.sortPct + r.pastePct) * 10) / 10, 100);
});

test('nonsense in, zeroes out — never NaN on a screen', () => {
  const r = balanceWaste({});
  assert.equal(r.output, 0); assert.equal(r.totalWaste, 0); assert.equal(r.yieldPct, 0);
  assert.equal(balanceWaste({ received: -5, produced: -5 }).output, 0);
});
