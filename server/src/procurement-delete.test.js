import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grnReversal, planProcurementDelete } from './procurement-delete.js';

// Real plant fixtures, taken from prod on 2026-07-31.
// CI-GRN-0005 is a clean Kalra Paper board receipt nothing has touched.
const cleanGrn = {
  grn_number: 'CI-GRN-0005', qty: 3480, unit: 'sheets', po_line_id: null,
  batch: { qty: 3480, initial_qty: 3480 }, consuming_movements: 0,
};
// CI-GRN-0002 was received at 23,000 and the floor has already drawn 3,600.
const partlyUsedGrn = {
  grn_number: 'CI-GRN-0002', qty: 23000, unit: 'sheets', po_line_id: 2,
  batch: { qty: 19400, initial_qty: 23000 }, consuming_movements: 4,
};
// CI-GRN-0001 is fully spent — the batch reads 0 and is marked exhausted.
const exhaustedGrn = {
  grn_number: 'CI-GRN-0001', qty: 2600, unit: 'sheets', po_line_id: 1,
  batch: { qty: 0, initial_qty: 2600 }, consuming_movements: 5,
};

// ── grnReversal ─────────────────────────────────────────────────────────────

test('grnReversal: an untouched batch reverses cleanly', () => {
  const r = grnReversal(cleanGrn, cleanGrn.batch, 0);
  assert.equal(r.reversible, true);
  assert.equal(r.consumed, 0);
});

// The whole point of the feature: say how much is pinned, not just "no".
test('grnReversal: a partly-issued batch blocks and names the quantity', () => {
  const r = grnReversal(partlyUsedGrn, partlyUsedGrn.batch, 4);
  assert.equal(r.reversible, false);
  assert.equal(r.consumed, 3600);
  assert.match(r.reason, /3,600 of 23,000 sheets already issued/);
});

test('grnReversal: a fully exhausted batch blocks', () => {
  const r = grnReversal(exhaustedGrn, exhaustedGrn.batch, 5);
  assert.equal(r.reversible, false);
  assert.equal(r.consumed, 2600);
});

// A GRN that never produced a batch (rejected at QC) has nothing to give back.
test('grnReversal: no batch means nothing to reverse', () => {
  const r = grnReversal({ grn_number: 'CI-GRN-0011', unit: 'sheets' }, null, 0);
  assert.equal(r.reversible, true);
});

// Balance intact but a consuming ledger row exists — still blocked. This is the
// case a pure quantity check would wave through.
test('grnReversal: an intact balance with a consuming movement still blocks', () => {
  const r = grnReversal(cleanGrn, cleanGrn.batch, 1);
  assert.equal(r.reversible, false);
  assert.equal(r.consumed, 0);
  assert.match(r.reason, /already been used by a job/);
});

// ── planProcurementDelete ───────────────────────────────────────────────────

test('plan: deleting a clean GRN reverses it and reopens the PO balance', () => {
  const p = planProcurementDelete({
    entity: 'grn', po: { po_number: 'CI-VPO-0003' }, grns: [cleanGrn],
  });
  assert.deepEqual(p.hard_blockers, []);
  assert.match(p.cascade[0], /Reverses receipt CI-GRN-0005 — returns 3,480 sheets/);
  assert.match(p.cascade[1], /Reopens the balance on CI-VPO-0003/);
});

test('plan: deleting a PO with an untouched receipt lists the full cascade', () => {
  const p = planProcurementDelete({
    entity: 'purchase_order', po: { po_number: 'CI-VPO-0003' },
    poLines: [{ qty: 2410 }, { qty: 2410 }], grns: [cleanGrn],
    sourcePrs: [{ pr_number: 'CI-PR-0006' }],
  });
  assert.deepEqual(p.hard_blockers, []);
  assert.ok(p.cascade.some(c => /Removes CI-VPO-0003 and its 2 lines/.test(c)));
  assert.ok(p.cascade.some(c => /Returns CI-PR-0006 to the approved queue/.test(c)));
});

// The case that protects the plant: CI-VPO-0002's receipt is partly on the floor.
test('plan: a PO whose receipt is partly issued is hard-blocked', () => {
  const p = planProcurementDelete({
    entity: 'purchase_order', po: { po_number: 'CI-VPO-0002' },
    poLines: [{ qty: 22475 }], grns: [partlyUsedGrn],
    sourcePrs: [{ pr_number: 'CI-PR-0002' }],
  });
  assert.equal(p.hard_blockers.length, 1);
  assert.match(p.hard_blockers[0], /CI-GRN-0002 — 3,600 of 23,000 sheets already issued/);
});

test('plan: deleting a converted PR unwinds its PO and removes the PR', () => {
  const p = planProcurementDelete({
    entity: 'requisition', pr: { pr_number: 'CI-PR-0006' },
    po: { po_number: 'CI-VPO-0003' }, poLines: [{ qty: 2410 }],
    grns: [], sourcePrs: [{ pr_number: 'CI-PR-0006' }],
  });
  assert.deepEqual(p.hard_blockers, []);
  assert.ok(p.cascade.some(c => /Removes CI-VPO-0003/.test(c)));
  assert.ok(p.cascade.some(c => /Removes requisition CI-PR-0006 and its lines/.test(c)));
});

// A sibling PR sharing the PO must survive as demand — never a silent casualty.
test('plan: a co-raised PR returns to approved instead of being deleted', () => {
  const p = planProcurementDelete({
    entity: 'requisition', pr: { pr_number: 'CI-PR-0006' },
    po: { po_number: 'CI-VPO-0003' }, poLines: [{ qty: 2410 }], grns: [],
    sourcePrs: [{ pr_number: 'CI-PR-0006' }, { pr_number: 'CI-PR-0007' }],
  });
  assert.ok(p.cascade.some(c => /Returns CI-PR-0007 to the approved queue/.test(c)));
  assert.ok(!p.cascade.some(c => /Returns CI-PR-0006 to the approved queue/.test(c)));
});

// Several receipts on one PO: every blocker is reported, not just the first.
test('plan: every pinned receipt is reported', () => {
  const p = planProcurementDelete({
    entity: 'purchase_order', po: { po_number: 'CI-VPO-0001' },
    poLines: [{ qty: 2575 }], grns: [exhaustedGrn, partlyUsedGrn],
  });
  assert.equal(p.hard_blockers.length, 2);
});
