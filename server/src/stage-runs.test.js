import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupRuns, runCapacity, availableCeiling, stageReceived, receiptFor, previousOf } from './stage-runs.js';

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
  // qty_in stays out of it — extras are counted from extra_sheet_requests only,
  // so a stage started ahead of its upstream keeps its deferred (null) qty_in.
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: 700, ownQtyIn: null, extraIssued: 200 }), 900);
});

test('availableCeiling: previous stage that has produced nothing yet is a real zero', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: null, ownQtyIn: null, extraIssued: 0 }), 0);
});

test('availableCeiling: zero upstream plus extras is the extras', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: true, prevQtyOut: null, ownQtyIn: null, extraIssued: 300 }), 300);
});

test('availableCeiling: first stage with no previous falls back to its own qty_in', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: 4000, extraIssued: 0 }), 4000);
});

test('availableCeiling: first stage with unset qty_in is uncapped, not zero', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: null, extraIssued: 0 }), null);
});

test('availableCeiling: first stage with unset qty_in but extras issued is capped at the extras', () => {
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: null, extraIssued: 150 }), 150);
});

test('availableCeiling: a first stage counts its own input AND its extras', () => {
  // Extras no longer get folded into qty_in, so the two add up rather than the
  // larger of the pair standing in for both.
  assert.equal(availableCeiling({ isCutting: false, prevExists: false, prevQtyOut: null, ownQtyIn: 4000, extraIssued: 150 }), 4150);
});

// ── stageReceived — the ONE definition of "what this station received" ───────
// The bug this closes: the cap read live upstream output while the station
// header read a frozen qty_in, so a press could be cleared to run 25,000 while
// being told it had received 100. Both now come from here.

test('stageReceived: a running stage tracks upstream live, not a start-time snapshot', () => {
  // Cutting was at 100 when printing started; it has since counted 27,000.
  assert.equal(stageReceived({ prevExists: true, prevQtyOut: 27000, ownQtyIn: 100, extraIssued: 0 }), 27000);
});

test('stageReceived: CI-XS extras issued straight to the stage are added on top', () => {
  // CI-JC-0001: cutting at 27,000 child sheets + 50 parents (×2) issued at printing.
  assert.equal(stageReceived({ prevExists: true, prevQtyOut: 27000, ownQtyIn: null, extraIssued: 100 }), 27100);
});

test('stageReceived: extras alone never masquerade as the whole receipt', () => {
  // The regression itself — a deferred qty_in plus an extra-sheet issue used to
  // read as 100 received. Upstream output is still the body of the receipt.
  assert.notEqual(stageReceived({ prevExists: true, prevQtyOut: 27000, ownQtyIn: 100, extraIssued: 100 }), 100);
});

test('stageReceived: an upstream that has counted nothing yet is zero received', () => {
  assert.equal(stageReceived({ prevExists: true, prevQtyOut: null, ownQtyIn: null, extraIssued: 0 }), 0);
});

test('stageReceived: the first stage is what the warehouse issued, plus extras', () => {
  assert.equal(stageReceived({ prevExists: false, prevQtyOut: null, ownQtyIn: 25075, extraIssued: 0 }), 25075);
  assert.equal(stageReceived({ prevExists: false, prevQtyOut: null, ownQtyIn: 25075, extraIssued: 50 }), 25125);
});

test('stageReceived: cutting is uncapped for recording but still has a receipt', () => {
  // availableCeiling returns null for cutting; the figure the operator is shown
  // must not go null with it.
  assert.equal(availableCeiling({ isCutting: true, prevExists: false, ownQtyIn: 25075, extraIssued: 0 }), null);
  assert.equal(stageReceived({ prevExists: false, prevQtyOut: null, ownQtyIn: 25075, extraIssued: 0 }), 25075);
});

// ── receiptFor / previousOf — the shape every non-DB caller uses ─────────────
// One conversion rule for the floor boards, the job card and the QC list, so a
// station and its job card can never quote different receipts.

const CI_JC_0001 = [
  { seq: 1, stage: 'cutting',     unit: 'sheets',  status: 'partially_completed', qty_in: 25075, qty_out: 27000, extra_issued_parents: 0 },
  { seq: 2, stage: 'printing',    unit: 'sheets',  status: 'partially_completed', qty_in: null,  qty_out: 25000, extra_issued_parents: 50 },
  { seq: 3, stage: 'die_cutting', unit: 'sheets',  status: 'pending',             qty_in: null,  qty_out: null,  extra_issued_parents: 0 },
  { seq: 4, stage: 'sorting',     unit: 'cartons', status: 'pending',             qty_in: null,  qty_out: null,  extra_issued_parents: 0 },
  { seq: 5, stage: 'qc',          unit: 'cartons', status: 'pending',             qty_in: null,  qty_out: null,  extra_issued_parents: 0 },
];
const receiptOn = (seq, opts = {}) => {
  const stage = CI_JC_0001.find(s => s.seq === seq);
  return receiptFor({
    stage, prev: previousOf(CI_JC_0001, stage),
    ups: 4, childrenPerParent: 2, extraParents: stage.extra_issued_parents, ...opts,
  });
};

test('receiptFor: the reported bug — printing reads upstream + its extras, not the extras alone', () => {
  const r = receiptOn(2);
  assert.equal(r.upstream_available, 27000);   // cutting's counted-so-far
  assert.equal(r.extra_issued, 100);           // 50 parent sheets x 2 cuts
  assert.equal(r.received, 27100);
  assert.equal(r.ceiling, 27100);              // shown figure === enforced cap
});

test('receiptFor: the first stage reads the board issued, and stays uncapped for cutting', () => {
  const r = receiptOn(1);
  assert.equal(r.upstream_available, null);
  assert.equal(r.received, 25075);
  assert.equal(r.ceiling, null);               // cutting has its own variance flow
});

test('receiptFor: a sheets stage feeding a cartons stage multiplies by ups', () => {
  CI_JC_0001.find(s => s.seq === 3).qty_out = 24000;
  assert.equal(receiptOn(4).received, 96000);  // 24,000 sheets x 4 up
  CI_JC_0001.find(s => s.seq === 3).qty_out = null;
});

test('receiptFor: a completed stage keeps the input it closed against', () => {
  const stage = { seq: 2, stage: 'printing', unit: 'sheets', status: 'completed', qty_in: 26800, qty_out: 26500 };
  const prev = { seq: 1, stage: 'cutting', unit: 'sheets', status: 'completed', qty_out: 99999 };
  assert.equal(receiptFor({ stage, prev, ups: 4, childrenPerParent: 2, extraParents: 0 }).received, 26800);
});

test('previousOf: skips QC and tolerates a gap in seq', () => {
  const qc = CI_JC_0001.find(s => s.seq === 5);
  assert.equal(previousOf(CI_JC_0001, qc).stage, 'sorting');
  const gapped = [{ seq: 1, stage: 'cutting' }, { seq: 4, stage: 'printing' }, { seq: 9, stage: 'die_cutting' }];
  assert.equal(previousOf(gapped, gapped[2]).stage, 'printing');
  assert.equal(previousOf(gapped, gapped[0]), null);
});
