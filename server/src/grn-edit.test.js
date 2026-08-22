import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchIntact, grnEditPlan } from './grn-edit.js';

// Real plant fixtures off the GRN register, 2026-08-22.
// CI-GRN-0055 — 5,472 sheets of Duplex WB against CI-VPO-0035, accepted at QC
// and untouched since. The shape of the receipt Anik wants to correct.
const acceptedIntact = {
  grn_number: 'CI-GRN-0055', status: 'accepted', qty: 5472, unit: 'sheets',
  po_line_id: 35, purchase_order_id: 35, material_id: 12,
};
const intactBatch = { id: 55, qty: 5472, initial_qty: 5472 };

// CI-GRN-0002 was received at 23,000 and the floor has already drawn 3,600.
const acceptedUsed = {
  grn_number: 'CI-GRN-0002', status: 'accepted', qty: 23000, unit: 'sheets',
  po_line_id: 2, purchase_order_id: 2, material_id: 3,
};
const usedBatch = { id: 2, qty: 19400, initial_qty: 23000 };

const quarantined = { ...acceptedIntact, grn_number: 'CI-GRN-0060', status: 'quarantine' };
const rejected = { ...acceptedIntact, grn_number: 'CI-GRN-0061', status: 'rejected' };

// ── paperwork: the half that was locked for no reason ───────────────────────

// The bug this whole change exists to fix. 55 completed receipts carried
// invoice numbers nobody could correct because the record was sealed at QC.
test('paperwork is editable on an ACCEPTED receipt', () => {
  const p = grnEditPlan(acceptedIntact, intactBatch, 0, { supplier_invoice_no: '2709' });
  assert.equal(p.error, null);
  assert.equal(p.fields.supplier_invoice_no, '2709');
});

test('paperwork is editable even on a REJECTED receipt', () => {
  const p = grnEditPlan(rejected, intactBatch, 0, { remarks: 'short delivery, debit note raised' });
  assert.equal(p.error, null);
  assert.equal(p.fields.remarks, 'short delivery, debit note raised');
});

// Absent ≠ blank. A form that posts one field must not null the other five.
test('a field the form did not send is left alone, not blanked', () => {
  const p = grnEditPlan(acceptedIntact, intactBatch, 0, { vehicle_no: 'HR55 1234' });
  assert.deepEqual(Object.keys(p.fields), ['vehicle_no']);
  assert.equal('remarks' in p.fields, false);
});

// ── quantity: where the stock consequence lives ─────────────────────────────

test('quarantine qty OVERWRITES the batch — nothing downstream knows of it yet', () => {
  const p = grnEditPlan(quarantined, intactBatch, 0, { qty: 5000 });
  assert.equal(p.error, null);
  assert.equal(p.stock, 'set');
  assert.equal(p.creditsPoLine, false, 'QC has not credited the PO line yet');
  assert.equal(p.qty.to, 5000);
});

test('accepted + intact qty moves by DELTA and re-credits the PO line', () => {
  const p = grnEditPlan(acceptedIntact, intactBatch, 0, { qty: 5000 });
  assert.equal(p.error, null);
  assert.equal(p.stock, 'delta');
  assert.equal(p.qty.delta, -472);
  assert.equal(p.creditsPoLine, true, 'acceptance credited received_qty; the correction must too');
});

// The guard that keeps this from inventing board. Re-basing a batch the floor
// has drawn on would credit back sheets that are already on a job.
test('accepted + partly issued REFUSES a quantity change and names the sheets', () => {
  const p = grnEditPlan(acceptedUsed, usedBatch, 4, { qty: 20000 });
  assert.equal(p.qty.editable, false);
  assert.match(p.error, /3,600 of 23,000 sheets from CI-GRN-0002 is already issued/);
  assert.match(p.error, /Roll the receipt back/);
  assert.equal(p.stock, 'none', 'a refused change must move no stock');
});

// A consuming movement blocks even when the balance still looks whole.
test('a consuming movement alone is enough to block', () => {
  const p = grnEditPlan(acceptedIntact, intactBatch, 1, { qty: 5000 });
  assert.equal(p.qty.editable, false);
  assert.equal(p.stock, 'none');
});

test('a rejected receipt holds no live stock to re-base', () => {
  const p = grnEditPlan(rejected, intactBatch, 0, { qty: 5000 });
  assert.equal(p.qty.editable, false);
  assert.match(p.error, /rejected at QC/);
  assert.equal(p.stock, 'none');
});

test('quantity must stay positive', () => {
  const p = grnEditPlan(quarantined, intactBatch, 0, { qty: 0 });
  assert.match(p.error, /must be positive/);
  assert.equal(p.stock, 'none');
});

// The case that makes paperwork-only saves possible on a blocked receipt:
// posting the SAME number back is not a change, so it must not raise.
test('re-posting the unchanged quantity on a blocked receipt still saves paperwork', () => {
  const p = grnEditPlan(acceptedUsed, usedBatch, 4, { qty: 23000, vehicle_no: 'HR55 1234' });
  assert.equal(p.error, null, 'no change means no refusal');
  assert.equal(p.stock, 'none');
  assert.equal(p.fields.vehicle_no, 'HR55 1234');
});

// ── batchIntact ─────────────────────────────────────────────────────────────

test('batchIntact: both signals must agree', () => {
  assert.equal(batchIntact(intactBatch, 0), true);
  assert.equal(batchIntact(intactBatch, 2), false);
  assert.equal(batchIntact(usedBatch, 0), false);
  assert.equal(batchIntact(null, 0), false);
});
