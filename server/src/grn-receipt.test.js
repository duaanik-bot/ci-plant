import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grnHeaderStatus, grnBatchNo, grnEditBlockers, grnDeleteBlockers,
  grnRollbackBlockers, grnRegisterValue, rateVariance,
} from './grn-receipt.js';

const line = (status, extra = {}) => ({ status, qty: 100, rate: 10, ...extra });

// ── Derived header status ─────────────────────────────────────────────
// Never stored. "Part QC'd" (work still owed) and "Partly Accepted"
// (settled, some refused) must stay distinct or an outstanding QC
// decision hides behind a finished-looking chip.
test('header status: all quarantine reads In QC', () => {
  assert.equal(grnHeaderStatus([line('quarantine'), line('quarantine')]), 'in_qc');
});

test('header status: all accepted reads accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('accepted')]), 'accepted');
});

test('header status: all rejected reads rejected', () => {
  assert.equal(grnHeaderStatus([line('rejected'), line('rejected')]), 'rejected');
});

test('header status: some decided, some pending is part_qc not partly_accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('quarantine')]), 'part_qc');
  assert.equal(grnHeaderStatus([line('rejected'), line('quarantine')]), 'part_qc');
});

test('header status: all decided but mixed is partly_accepted', () => {
  assert.equal(grnHeaderStatus([line('accepted'), line('rejected')]), 'partly_accepted');
});

test('header status: an empty receipt is still in QC, never accepted', () => {
  assert.equal(grnHeaderStatus([]), 'in_qc');
});

// ── Batch numbering ───────────────────────────────────────────────────
// The old single-line code always produced "-B1". Two lines of one GRN
// must not collide on it.
test('batch no: lines of one GRN get distinct suffixes', () => {
  assert.equal(grnBatchNo('CI-GRN-0007', 0), 'CI-GRN-0007-B1');
  assert.equal(grnBatchNo('CI-GRN-0007', 1), 'CI-GRN-0007-B2');
  assert.equal(grnBatchNo('CI-GRN-0007', 2), 'CI-GRN-0007-B3');
});

test('batch no: a supplied supplier batch wins, blank/whitespace does not', () => {
  assert.equal(grnBatchNo('CI-GRN-0007', 0, 'SUP-99'), 'SUP-99');
  assert.equal(grnBatchNo('CI-GRN-0007', 1, '   '), 'CI-GRN-0007-B2');
  assert.equal(grnBatchNo('CI-GRN-0007', 1, null), 'CI-GRN-0007-B2');
});

// ── Guards ────────────────────────────────────────────────────────────
test('edit: allowed only while every line is still in quarantine', () => {
  assert.deepEqual(grnEditBlockers({ lines: [line('quarantine'), line('quarantine')] }), []);
  assert.match(grnEditBlockers({ lines: [line('accepted'), line('quarantine')] })[0], /QC-decided/i);
});

test('delete: refused once any line is accepted, and points at rollback', () => {
  assert.deepEqual(grnDeleteBlockers({ lines: [line('quarantine'), line('rejected')] }), []);
  assert.match(grnDeleteBlockers({ lines: [line('accepted')] })[0], /roll it back/i);
});

test('delete: refused when stock from a line has been used', () => {
  const out = grnDeleteBlockers({ lines: [line('quarantine', { batchConsumed: true })] });
  assert.match(out[0], /already been used/i);
});

test('rollback: refused while any line is still in QC', () => {
  const out = grnRollbackBlockers({ lines: [line('accepted'), line('quarantine')] });
  assert.match(out[0], /finish QC/i);
});

test('rollback: refused when nothing was accepted', () => {
  const out = grnRollbackBlockers({ lines: [line('rejected'), line('rejected')] });
  assert.match(out[0], /delete it instead/i);
});

test('rollback: allowed when every line is decided and one was accepted', () => {
  assert.deepEqual(grnRollbackBlockers({ lines: [line('accepted'), line('rejected')] }), []);
});

test('rollback: refused when accepted stock has been touched', () => {
  const out = grnRollbackBlockers({ lines: [line('accepted', { batchTouched: true, material_name: 'Duplex GB 230' })] });
  assert.match(out[0], /Duplex GB 230/);
  assert.match(out[0], /already been used/i);
});

// ── Purchase-register value ───────────────────────────────────────────
// Rejected board went back to the supplier and is not a purchase.
// Quarantine board HAS arrived and been invoiced, so it counts.
test('register value: excludes rejected lines, counts quarantine ones', () => {
  const lines = [
    line('accepted', { qty: 100, rate: 10 }),    // 1000
    line('quarantine', { qty: 50, rate: 20 }),   // 1000
    line('rejected', { qty: 999, rate: 999 }),   // excluded
  ];
  assert.equal(grnRegisterValue(lines), 2000);
});

test('register value: gross of discount and tax, matching the PO convention', () => {
  // discount_pct / gst_rate present but deliberately ignored — the PO half of
  // the register is SUM(pl.qty * pl.rate), so this half must match.
  assert.equal(grnRegisterValue([line('accepted', { qty: 10, rate: 3.5, discount_pct: 50, gst_rate: 18 })]), 35);
});

test('register value: an empty or all-rejected receipt is worth nothing', () => {
  assert.equal(grnRegisterValue([]), 0);
  assert.equal(grnRegisterValue([line('rejected')]), 0);
});

// ── Rate variance ─────────────────────────────────────────────────────
test('rate variance: null inside money tolerance, signed outside it', () => {
  assert.equal(rateVariance(10, 10), null);
  assert.equal(rateVariance(10.004, 10), null);
  assert.equal(rateVariance(10.5, 10), 0.5);
  assert.equal(rateVariance(9.5, 10), -0.5);
});

test('rate variance: null when there is nothing to compare', () => {
  assert.equal(rateVariance(10, null), null);
  assert.equal(rateVariance('', 10), null);
  assert.equal(rateVariance(null, null), null);
});

// ── client twin parity ────────────────────────────────────────────────
// The form recomputes rate variance locally for the live chip, so the two
// implementations must never diverge. Same precedent as boardMath.
import { rateVariance as clientRateVariance } from '../../client/src/lib/poTotals.js';

test('client twin: rate variance identical across a spread of real rates', () => {
  const cases = [[10, 10], [10.004, 10], [10.5, 10], [9.5, 10], [6.85, 7.1],
                 [0, 10], [10, 0], [null, 10], [10, null], ['', 10], [10, ''],
                 [null, null], [0.001, 0], [1e6, 999999.5]];
  for (const [a, b] of cases) {
    assert.equal(clientRateVariance(a, b), rateVariance(a, b), `rateVariance(${a}, ${b})`);
  }
});
