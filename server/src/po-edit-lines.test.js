import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPoLineEdit } from './routes/procurement.js';

// Editing a PO now collapses duplicate boards, and that is the dangerous half of
// the feature: every GRN row carries a `po_line_id`, so a merge that deletes the
// wrong po_line strands a real receipt — goods physically in the building with
// nothing on the order pointing at them. The rule is that a line with anything
// received against it is never merged and never deleted.
//
// These drive the real function with a stub `qc`, so no pool is ever connected:
// an escape to the module-level `q`/`one` would throw rather than pass quietly.

function stubQc() {
  const deleted = [], updated = [], inserted = [];
  const qc = async (sql, params = []) => {
    if (/^\s*DELETE FROM po_lines/.test(sql)) { deleted.push(params[0]); return []; }
    if (/^\s*UPDATE po_lines/.test(sql)) { updated.push({ material_id: params[0], qty: params[1], rate: params[2], id: params[7] }); return []; }
    if (/^\s*INSERT INTO po_lines/.test(sql)) { inserted.push({ po: params[0], material_id: params[1], qty: params[2], rate: params[3] }); return []; }
    if (/UPDATE materials SET last_rate/.test(sql)) return [];
    throw new Error(`stub qc got an unexpected statement: ${sql}`);
  };
  return { qc, deleted, updated, inserted };
}

// received_qty is what QC accepted; grn_qty is what is still sitting in
// quarantine. Either one settles a line — the route folds both into committedQty.
const line = (id, material_id, qty, committed = 0) => ({ id, material_id, qty, received_qty: committed });
const committedQty = l => +l.received_qty || 0;

test('two untouched lines for one board become one, and only the folded id is deleted', async () => {
  const { qc, deleted, updated, inserted } = stubQc();
  const existing = [line(11, 7, 20), line(12, 7, 10)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { id: 12, material_id: 7, qty: 10, rate: 45 },
  ], existing, committedQty);

  assert.deepEqual(deleted, [12], 'the folded-away line, and nothing else');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, 11, 'the survivor is updated in place');
  assert.equal(updated[0].qty, 30, 'quantities added up');
  assert.equal(inserted.length, 0, 'no churn — nothing was re-inserted');
});

test('a line with goods received is never merged away and never deleted', async () => {
  const { qc, deleted, updated } = stubQc();
  // Line 11 has 5 received. A GRN row points at po_line_id 11.
  const existing = [line(11, 7, 20, 5), line(12, 7, 10)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { id: 12, material_id: 7, qty: 10, rate: 45 },
  ], existing, committedQty);

  assert.deepEqual(deleted, [], 'THE GUARANTEE: no po_line a GRN points at was deleted');
  assert.deepEqual(updated.map(u => u.id).sort(), [11, 12], 'both rows survive, separately');
  assert.equal(updated.find(u => u.id === 11).qty, 20, 'the received line keeps its own quantity');
  assert.equal(updated.find(u => u.id === 12).qty, 10);
});

test('open lines still merge around a received line for the same board', async () => {
  const { qc, deleted, updated } = stubQc();
  const existing = [line(11, 7, 5, 5), line(12, 7, 20), line(13, 7, 10)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 5, rate: 45 },
    { id: 12, material_id: 7, qty: 20, rate: 45 },
    { id: 13, material_id: 7, qty: 10, rate: 45 },
  ], existing, committedQty);

  assert.deepEqual(deleted, [13], 'only the open duplicate folded away');
  assert.equal(updated.find(u => u.id === 11).qty, 5, 'the received line is untouched');
  assert.equal(updated.find(u => u.id === 12).qty, 30, 'the two open lines added up');
});

test('a quarantined receipt settles a line just as an accepted one does', async () => {
  // received_qty is still 0 here — the goods are in QC, not yet accepted. The
  // GRN row exists and points at the line, so it must be treated as settled.
  const { qc, deleted } = stubQc();
  const existing = [line(11, 7, 20), line(12, 7, 10)];
  const grnByLine = { 11: 8 };
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { id: 12, material_id: 7, qty: 10, rate: 45 },
  ], existing, l => Math.max(+l.received_qty, grnByLine[l.id] || 0));

  assert.deepEqual(deleted, [], 'a line with goods in quarantine is not folded away either');
});

test('dropping a received line is still refused, and nothing is deleted first', async () => {
  const { qc, deleted } = stubQc();
  const existing = [line(11, 7, 20, 5), line(12, 9, 10)];
  await assert.rejects(
    () => applyPoLineEdit(qc, 500, [{ id: 12, material_id: 9, qty: 10, rate: 30 }], existing, committedQty),
    /goods received against it cannot be removed/);
  assert.deepEqual(deleted, [], 'the refusal came before any delete ran');
});

test('a new row typed for a board already on the order joins it instead of adding a line', async () => {
  const { qc, deleted, updated, inserted } = stubQc();
  const existing = [line(11, 7, 20)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 45 },
  ], existing, committedQty);

  assert.deepEqual(deleted, []);
  assert.equal(inserted.length, 0, 'the new row did not become a second line');
  assert.equal(updated[0].id, 11);
  assert.equal(updated[0].qty, 30);
});

test('a new row for a board that is on the order but already received becomes its own line', async () => {
  // Nothing may touch line 11, so the new quantity has to land somewhere else.
  const { qc, deleted, inserted } = stubQc();
  const existing = [line(11, 7, 20, 20)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { material_id: 7, qty: 10, rate: 45 },
  ], existing, committedQty);

  assert.deepEqual(deleted, []);
  assert.equal(inserted.length, 1, 'the re-order is a new line, not an edit of the received one');
  assert.equal(inserted[0].qty, 10);
});

test('different boards are left alone', async () => {
  const { qc, deleted, updated } = stubQc();
  const existing = [line(11, 7, 20), line(12, 9, 10)];
  await applyPoLineEdit(qc, 500, [
    { id: 11, material_id: 7, qty: 20, rate: 45 },
    { id: 12, material_id: 9, qty: 10, rate: 30 },
  ], existing, committedQty);

  assert.deepEqual(deleted, []);
  assert.equal(updated.length, 2);
});

test('a genuinely dropped line is still removed', async () => {
  const { qc, deleted } = stubQc();
  const existing = [line(11, 7, 20), line(12, 9, 10)];
  await applyPoLineEdit(qc, 500, [{ id: 11, material_id: 7, qty: 20, rate: 45 }], existing, committedQty);
  assert.deepEqual(deleted, [12], 'consolidation did not break ordinary removal');
});

test('a merged line below what has already arrived is still refused', async () => {
  // Two open lines merge to 8, but the surviving row has 10 in QC against it.
  const { qc } = stubQc();
  const existing = [line(11, 7, 20), line(12, 7, 10)];
  const grnByLine = { 11: 10 };
  const committed = l => Math.max(+l.received_qty, grnByLine[l.id] || 0);
  // Line 11 is settled by its GRN, so 12 stays separate — dropping 12 to below
  // nothing is fine, but reducing 11 under its receipts must still fail.
  await assert.rejects(
    () => applyPoLineEdit(qc, 500, [
      { id: 11, material_id: 7, qty: 4, rate: 45 },
      { id: 12, material_id: 7, qty: 4, rate: 45 },
    ], existing, committed),
    /cannot be below the 10 already received/);
});
