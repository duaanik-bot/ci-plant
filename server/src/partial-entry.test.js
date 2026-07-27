import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntry, partialBlockers, ENTRY_BASES } from './partial-entry.js';

// ── the bug this module exists to kill ────────────────────────────────
// A 50,000 job. 20,000 counted on day one. On day two the operator types the
// 10,000 he actually ran. The old cumulative-only field read that as −10,000
// and went dead, so a stage could take exactly one partial.
test('a second partial of today\'s figure is accepted, not read as negative', () => {
  const e = resolveEntry({ basis: 'delta', entered: 10000, priorGood: 20000 });
  assert.equal(e.adding, 10000);
  assert.equal(e.total, 30000);
  assert.equal(e.belowLog, false);
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: 10000, priorGood: 20000 }), []);
});

test('the same figure on the cumulative basis still means the counter reading', () => {
  const e = resolveEntry({ basis: 'total', entered: 30000, priorGood: 20000 });
  assert.equal(e.adding, 10000);
  assert.equal(e.total, 30000);
  assert.equal(e.belowLog, false);
});

test('a third and fourth partial keep stacking — no entry limit', () => {
  let prior = 0;
  for (const day of [20000, 10000, 15000, 4999]) {
    const e = resolveEntry({ basis: 'delta', entered: day, priorGood: prior });
    assert.deepEqual(partialBlockers({ basis: 'delta', entered: day, priorGood: prior }), []);
    prior = e.total;
  }
  assert.equal(prior, 49999);
});

test('a single piece is a valid partial — the last one off the bundle', () => {
  const e = resolveEntry({ basis: 'delta', entered: 1, priorGood: 49999 });
  assert.equal(e.adding, 1);
  assert.equal(e.total, 50000);
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: 1, priorGood: 49999 }), []);
});

test('a partial that leaves the stage short is not a blocker — that is the point', () => {
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: 5, priorGood: 0 }), []);
});

// ── blank / zero / waste ──────────────────────────────────────────────
test('an untouched field is neutral, not zero', () => {
  for (const v of ['', null, undefined]) {
    const e = resolveEntry({ basis: 'delta', entered: v, priorGood: 20000 });
    assert.equal(e.typed, null);
    assert.equal(e.adding, 0);
    assert.equal(e.total, 20000, 'the stage still holds what it held');
  }
});

test('nothing typed and nothing wasted is the one empty-entry blocker', () => {
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: '', priorGood: 0 }), ['nothing_entered']);
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: 0, priorGood: 0 }), ['nothing_entered']);
});

test('a waste-only entry saves — a day that produced nothing but spoilt sheets', () => {
  assert.deepEqual(
    partialBlockers({ basis: 'delta', entered: '', priorGood: 20000, scrap: 40, scrapReason: 'Registration' }),
    []);
});

test('waste still needs a reason', () => {
  assert.deepEqual(
    partialBlockers({ basis: 'delta', entered: 500, priorGood: 0, scrap: 40, scrapReason: '  ' }),
    ['scrap_reason']);
});

// ── cumulative-basis typo guard ───────────────────────────────────────
test('a cumulative reading below the log is flagged, and only on that basis', () => {
  const total = resolveEntry({ basis: 'total', entered: 10000, priorGood: 20000 });
  assert.equal(total.belowLog, true);
  assert.deepEqual(partialBlockers({ basis: 'total', entered: 10000, priorGood: 20000 }), ['below_log']);

  // The very same keystrokes on the delta basis are exactly what the operator meant.
  const delta = resolveEntry({ basis: 'delta', entered: 10000, priorGood: 20000 });
  assert.equal(delta.belowLog, false);
  assert.deepEqual(partialBlockers({ basis: 'delta', entered: 10000, priorGood: 20000 }), []);
});

test('the two bases agree on the first entry, when there is no log yet', () => {
  for (const basis of ENTRY_BASES) {
    const e = resolveEntry({ basis, entered: 20000, priorGood: 0 });
    assert.equal(e.adding, 20000);
    assert.equal(e.total, 20000);
  }
});

test('negative and junk input never produce a negative run', () => {
  assert.equal(resolveEntry({ basis: 'delta', entered: -500, priorGood: 100 }).adding, 0);
  assert.equal(resolveEntry({ basis: 'delta', entered: 'abc', priorGood: 100 }).adding, 0);
  assert.equal(resolveEntry({ basis: 'delta', entered: 12.6, priorGood: 0 }).adding, 13);
});

// ── client twin parity ────────────────────────────────────────────────
// Both counter doors are React, so the client owns a copy. A drift between the
// twins would let the form show one figure and the server record another.
import * as client from '../../client/src/lib/partialEntry.js';

test('client twin: exported surface matches the server module', async () => {
  const server = await import('./partial-entry.js');
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort());
  assert.deepEqual(client.ENTRY_BASES, ENTRY_BASES);
});

test('client twin: identical output across every realistic entry', () => {
  const cases = [];
  for (const basis of ENTRY_BASES)
    for (const priorGood of [0, 1, 20000, 49999])
      for (const entered of ['', 0, 1, 10000, 30000, 50000, -5])
        for (const scrap of [0, 40])
          cases.push({ basis, priorGood, entered, scrap, scrapReason: scrap ? 'Registration' : '' });

  for (const c of cases) {
    assert.deepEqual(client.resolveEntry(c), resolveEntry(c), `resolveEntry ${JSON.stringify(c)}`);
    assert.deepEqual(client.partialBlockers(c), partialBlockers(c), `partialBlockers ${JSON.stringify(c)}`);
  }
});
