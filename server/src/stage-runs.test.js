import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupRuns, runCapacity, availableCeiling } from './stage-runs.js';

test('rollupRuns sums good and scrap across days', () => {
  const r = rollupRuns([
    { qty_good: 100000, qty_scrap: 500, run_date: '2026-07-14' },
    { qty_good: 100000, qty_scrap: 300, run_date: '2026-07-15' },
  ]);
  assert.equal(r.qty_good, 200000);
  assert.equal(r.qty_scrap, 800);
  assert.equal(r.run_count, 2);
  assert.equal(r.last_run_date, '2026-07-15');
});

test('rollupRuns on an empty log is all zeroes, not NaN', () => {
  const r = rollupRuns([]);
  assert.equal(r.qty_good, 0);
  assert.equal(r.qty_scrap, 0);
  assert.equal(r.run_count, 0);
  assert.equal(r.last_run_date, null);
});

test('rollupRuns ignores null/undefined quantities', () => {
  const r = rollupRuns([{ qty_good: null, qty_scrap: undefined, run_date: '2026-07-14' }]);
  assert.equal(r.qty_good, 0);
  assert.equal(r.qty_scrap, 0);
});

test('rollupRuns picks the latest date even when runs arrive out of order', () => {
  const r = rollupRuns([
    { qty_good: 10, qty_scrap: 0, run_date: '2026-07-16' },
    { qty_good: 10, qty_scrap: 0, run_date: '2026-07-14' },
  ]);
  assert.equal(r.last_run_date, '2026-07-16');
});

test('runCapacity allows a run that fits under the upstream ceiling', () => {
  const c = runCapacity({ upstreamAvailable: 500000, priorGood: 200000, priorScrap: 800, thisGood: 100000, thisScrap: 200 });
  assert.equal(c.consumed, 301000);
  assert.equal(c.ceiling, 500000);
  assert.equal(c.ok, true);
  assert.equal(c.overBy, 0);
});

test('runCapacity rejects a run that exceeds what upstream has produced', () => {
  const c = runCapacity({ upstreamAvailable: 250000, priorGood: 200000, priorScrap: 0, thisGood: 100000, thisScrap: 0 });
  assert.equal(c.ok, false);
  assert.equal(c.overBy, 50000);
});

test('runCapacity treats a null ceiling as uncapped (cutting)', () => {
  const c = runCapacity({ upstreamAvailable: null, priorGood: 0, priorScrap: 0, thisGood: 999999, thisScrap: 0 });
  assert.equal(c.ok, true);
  assert.equal(c.ceiling, Infinity);
});

test('runCapacity counts scrap against the ceiling, not just good output', () => {
  const c = runCapacity({ upstreamAvailable: 1000, priorGood: 0, priorScrap: 0, thisGood: 900, thisScrap: 200 });
  assert.equal(c.consumed, 1100);
  assert.equal(c.ok, false);
  assert.equal(c.overBy, 100);
});

test('runCapacity exactly at the ceiling is allowed', () => {
  const c = runCapacity({ upstreamAvailable: 1000, priorGood: 800, priorScrap: 100, thisGood: 100, thisScrap: 0 });
  assert.equal(c.ok, true);
  assert.equal(c.overBy, 0);
});

test('availableCeiling: cutting is uncapped regardless of anything else', () => {
  assert.equal(availableCeiling({ isCutting: true, prevQtyOut: 500, ownQtyIn: 100, extraIssued: 50 }), null);
});

test('availableCeiling: normal stage uses the previous stage output', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: 700, ownQtyIn: 700, extraIssued: 0 }), 700);
});

test('availableCeiling: CI-XS extra sheets raise the ceiling', () => {
  // 700 from upstream + 200 issued as extra sheets = 900 legitimately available.
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: 700, ownQtyIn: 900, extraIssued: 200 }), 900);
});

test('availableCeiling: previous stage that has produced nothing yet is a real zero', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: null, ownQtyIn: null, extraIssued: 0 }), 0);
});

test('availableCeiling: zero upstream plus extras is the extras', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: null, ownQtyIn: 300, extraIssued: 300 }), 300);
});

test('availableCeiling: first stage with no previous falls back to its own qty_in', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: 4000, extraIssued: 0 }), 4000);
});

test('availableCeiling: first stage with unset qty_in is uncapped, not zero', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: null, extraIssued: 0 }), null);
});

test('availableCeiling: first stage with unset qty_in but extras issued is capped at the extras', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: 150, extraIssued: 150 }), 150);
});
