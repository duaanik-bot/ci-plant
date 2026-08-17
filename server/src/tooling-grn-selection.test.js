// Picking which Die / Block PO lines a delivery covers.
//
// The die and block GRN form already opened against the whole PO — what it had
// no way to say was WHICH of its lines arrived. Every outstanding line rendered
// with an empty quantity box, so receiving a six-line delivery in full meant
// typing six numbers, each of which had to be read off the line beside it.
//
// A die is a QUANTITY, not a named component the way a plate's Cyan is. So a
// tick here means "fill this line's whole outstanding balance" and the box stays
// editable underneath it for the part-delivery case. That is the same gesture as
// the plate form's tick and the boards module's Fill Full Balance, in the shape
// this family's data actually has.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolingGrnLines, initialReceipt, lineTicked, lineReceipt, receiptTotals,
  toggleToolingLine, fillAll, clearAll, toReceiptPayload,
} from '../../client/src/lib/toolingGrnSelection.js';

// A three-line die PO: one untouched, one part-received, one finished.
const PO = () => ({
  id: 7, po_number: 'CI-DIE-PO-0004',
  lines: [
    { id: 41, material_name: 'Die 3245 — NEO Cheese 200g', unit: 'nos', qty: 2, received_qty: 0,
      request_number: 'CI-TR-0201', jc_number: 'CI-JC-0301' },
    { id: 42, material_name: 'Die 3246 — Fluence Sleeve', unit: 'nos', qty: 4, received_qty: 1,
      request_number: 'CI-TR-0202', jc_number: 'CI-JC-0302' },
    { id: 43, material_name: 'Die 3247 — Lipophage outer', unit: 'nos', qty: 1, received_qty: 1,
      request_number: 'CI-TR-0203', jc_number: 'CI-JC-0303' },
  ],
});

test('a line knows how much of it is still outstanding', () => {
  const rows = toolingGrnLines(PO());
  assert.deepEqual(rows.map(r => r.pending), [2, 3, 0]);
  assert.deepEqual(rows.map(r => r.receivable), [true, true, false]);
  assert.deepEqual(rows.map(r => r.received), [false, false, true]);
});

test('a finished line is still SHOWN, and cannot be received again', () => {
  // It used to be filtered out of the form entirely, so a part-received PO
  // rendered as a smaller order than the one that was raised.
  const rows = toolingGrnLines(PO());
  assert.equal(rows.length, 3, 'every line on the PO is rendered');
  assert.equal(rows[2].receivable, false);
});

test('every outstanding balance opens filled', () => {
  const rows = initialReceipt(PO());
  assert.deepEqual(rows.map(r => r.receive_qty), ['2', '3', '']);
  assert.deepEqual(receiptTotals(rows), { lines: 2, qty: 5 });
});

test('a tick is "the whole balance", untick is "none of it"', () => {
  let rows = initialReceipt(PO());
  assert.equal(lineTicked(rows[1]), true);
  rows = toggleToolingLine(rows, 1);
  assert.equal(rows[1].receive_qty, '', 'unticking clears the box');
  assert.equal(lineTicked(rows[1]), false);
  rows = toggleToolingLine(rows, 1);
  assert.equal(rows[1].receive_qty, '3', 'reticking fills the BALANCE, not the ordered quantity');
});

test('a finished line cannot be ticked', () => {
  // Its balance is zero; filling it would post a receipt for nothing and the
  // server would refuse the whole transaction.
  const rows = toggleToolingLine(initialReceipt(PO()), 2);
  assert.equal(rows[2].receive_qty, '');
  assert.equal(lineTicked(rows[2]), false);
});

test('a part delivery keeps its typed quantity', () => {
  // Two of four dies arrived. The tick is a shortcut, never a floor.
  const rows = initialReceipt(PO()).map((r, i) => i === 1 ? { ...r, receive_qty: '2' } : r);
  assert.equal(lineTicked(rows[1]), true, 'a partial quantity still counts as selected');
  assert.deepEqual(receiptTotals(rows), { lines: 2, qty: 4 });
});

test('select all and deselect all move every receivable line', () => {
  const cleared = clearAll(initialReceipt(PO()));
  assert.deepEqual(cleared.map(r => r.receive_qty), ['', '', '']);
  assert.deepEqual(receiptTotals(cleared), { lines: 0, qty: 0 });
  const filled = fillAll(cleared);
  assert.deepEqual(filled.map(r => r.receive_qty), ['2', '3', ''],
    'the finished line stays empty — select all means every line that CAN be received');
});

test('the payload carries only lines with a positive quantity', () => {
  const rows = clearAll(initialReceipt(PO())).map((r, i) => i === 0 ? { ...r, receive_qty: '2' } : r);
  assert.deepEqual(toReceiptPayload(rows), [{ po_line_id: 41, qty: 2, batch_no: undefined }]);
  assert.deepEqual(toReceiptPayload(clearAll(rows)), [], 'nothing ticked sends nothing');
});

test('a zero or negative typed quantity is not a receipt', () => {
  // The box is free text. '0' and '-1' must not reach the server as lines.
  let rows = clearAll(initialReceipt(PO()));
  rows = rows.map((r, i) => i === 0 ? { ...r, receive_qty: '0' } : i === 1 ? { ...r, receive_qty: '-1' } : r);
  assert.equal(lineTicked(rows[0]), false);
  assert.equal(lineTicked(rows[1]), false);
  assert.deepEqual(toReceiptPayload(rows), []);
});

// ── What one PO line says about itself on the register ──────────────────────
//
// The die and block register showed only the FIRST item and "+3", so a
// four-line order could not say what the other three were, let alone which of
// them had arrived. A plate set says its colour build there; a die is a
// quantity, so what it has to say is how much of it has landed.

test('an untouched line states what was ordered', () => {
  assert.deepEqual(lineReceipt({ qty: 2, received_qty: 0, unit: 'nos' }),
    { state: 'open', label: '2 nos' });
});

test('a part-received line reads as a FRACTION, never as the order', () => {
  // "2 nos" on a half-received line is the same text as an untouched one, which
  // is exactly the confusion this chip exists to remove.
  assert.deepEqual(lineReceipt({ qty: 4, received_qty: 1, unit: 'nos' }),
    { state: 'partial', label: '1/4 nos' });
});

test('a finished line is not still asking to be received', () => {
  assert.deepEqual(lineReceipt({ qty: 1, received_qty: 1, unit: 'nos' }),
    { state: 'received', label: '1 nos' });
  // Over-received (a correction elsewhere) is still done, not still partial.
  assert.equal(lineReceipt({ qty: 2, received_qty: 3, unit: 'nos' }).state, 'received');
});

test('the unit travels with the number', () => {
  // A block is counted in its own unit; hard-coding "nos" would misstate it.
  assert.equal(lineReceipt({ qty: 5, received_qty: 0, unit: 'sets' }).label, '5 sets');
  assert.equal(lineReceipt({ qty: 5, received_qty: 0 }).label, '5 nos', 'a missing unit falls back');
});

test('the three states are exactly the three the register paints', () => {
  // A fourth state would render with no tone at all — an invisible chip.
  const states = new Set([
    lineReceipt({ qty: 2, received_qty: 0 }).state,
    lineReceipt({ qty: 2, received_qty: 1 }).state,
    lineReceipt({ qty: 2, received_qty: 2 }).state,
  ]);
  assert.deepEqual([...states].sort(), ['open', 'partial', 'received']);
});
