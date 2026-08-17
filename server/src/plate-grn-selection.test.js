// Taking a Plate GRN against the PURCHASE ORDER, not against whichever line the
// register row happened to pick first.
//
// The old form was opened with a line the CALLER chose:
//
//     const line = row.lines.find(item => received_qty < qty)
//     <Button onClick={() => setGrnModal({ po: row, line })}>GRN</Button>
//
// A plate PO carries several plate sets — the register's own Output column says
// so. So on a three-set PO the GRN button always opened set one, and the
// warehouse could not say "the Fluence set arrived, the NEO set did not". It
// received set one, reopened, received set two, reopened again, and at no point
// chose. This suite holds the selection arithmetic that replaced it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTSTANDING_STATUSES, outstandingOf, receivableLines, initialSelection,
  lineTickState, toggleLine, toggleComponent, selectedTotal, outstandingTotal,
  toBulkLines,
} from '../../client/src/lib/plateGrnSelection.js';

// Two plate sets on one PO: NEO is a 5-plate CMYK+spot set, Fluence a 4-plate
// CMYK set whose Black has already been received on an earlier partial GRN.
const PO = () => ({
  id: 31, po_number: 'CI-PL-PO-0031',
  lines: [
    { id: 88, qty: 5, received_qty: 0, product_name: 'NEO Cheese Carton 200g',
      request_number: 'CI-PL-PR-0042', jc_number: 'JC-1188', output_number: '18604', plate_size: '1030x800',
      components: [
        { id: 201, component_type: 'cyan', component_label: 'Cyan', status: 'po_created' },
        { id: 202, component_type: 'magenta', component_label: 'Magenta', status: 'po_created' },
        { id: 203, component_type: 'yellow', component_label: 'Yellow', status: 'po_created' },
        { id: 204, component_type: 'black', component_label: 'Black', status: 'ordered' },
        { id: 205, component_type: 'pantone', component_label: 'PMS 485C', pantone_code: '485C', status: 'po_created' },
      ] },
    { id: 89, qty: 4, received_qty: 1, product_name: 'Fluence Sleeve',
      request_number: 'CI-PL-PR-0043', jc_number: 'JC-1190', output_number: '18612', plate_size: '1030x800',
      components: [
        { id: 211, component_type: 'cyan', component_label: 'Cyan', status: 'po_created' },
        { id: 212, component_type: 'magenta', component_label: 'Magenta', status: 'po_created' },
        { id: 213, component_type: 'yellow', component_label: 'Yellow', status: 'po_created' },
        { id: 214, component_type: 'black', component_label: 'Black', status: 'available' },
      ] },
  ],
});

test('only a plate still on order can be received', () => {
  // 'available' is a plate already in the rack. Offering it again would book the
  // same physical plate twice and mint a second asset number for it.
  assert.deepEqual([...OUTSTANDING_STATUSES].sort(), ['ordered', 'po_created']);
  const [neo, fluence] = PO().lines;
  assert.deepEqual(outstandingOf(neo).map(row => row.id), [201, 202, 203, 204, 205]);
  assert.deepEqual(outstandingOf(fluence).map(row => row.id), [211, 212, 213]);
});

test('a fully received line is still SHOWN, and is not receivable', () => {
  // The form mirrors the PO. Hiding a finished line would leave a partly
  // received order looking like a smaller order than the one that was raised.
  const po = PO();
  po.lines[1].received_qty = 4;
  po.lines[1].components = po.lines[1].components.map(row => ({ ...row, status: 'available' }));
  const rows = receivableLines(po);
  assert.equal(rows.length, 2, 'both lines are rendered');
  assert.equal(rows[0].receivable, true);
  assert.equal(rows[1].receivable, false, 'a line with nothing outstanding cannot be ticked');
  assert.equal(rows[1].received, true, 'and it says so');
});

test('every outstanding plate opens ticked', () => {
  // The common case is that the whole delivery arrived; untick what did not.
  const po = PO();
  const selection = initialSelection(po);
  assert.deepEqual(selection[88], [201, 202, 203, 204, 205]);
  assert.deepEqual(selection[89], [211, 212, 213]);
  assert.equal(selectedTotal(selection), 8);
  assert.equal(outstandingTotal(po), 8, 'the count the header shows is the count that can be sent');
});

test('a line tick is tri-state', () => {
  const po = PO();
  const [neo] = po.lines;
  assert.equal(lineTickState([201, 202, 203, 204, 205], neo), 'all');
  assert.equal(lineTickState([], neo), 'none');
  assert.equal(lineTickState([201], neo), 'some');
});

test('ticking a line takes its outstanding plates and only those', () => {
  const po = PO();
  const fluence = po.lines[1];
  // Untick then re-tick: the received Black (214) must never come back in.
  const cleared = toggleLine({ 89: [211, 212, 213] }, fluence);
  assert.deepEqual(cleared[89], []);
  const restored = toggleLine(cleared, fluence);
  assert.deepEqual(restored[89], [211, 212, 213]);
  assert.ok(!restored[89].includes(214), 'a plate already in the rack is not re-received');
});

test('a part-delivered set can be received in part', () => {
  // Three of a four-plate set can arrive. Per-plate ticks are the whole point.
  const po = PO();
  const after = toggleComponent(initialSelection(po), po.lines[0], 203);
  assert.deepEqual(after[88], [201, 202, 204, 205]);
  assert.equal(selectedTotal(after), 7);
});

test('the payload carries only lines with something ticked', () => {
  // An empty line in the body would create a GRN for nothing — a numbered
  // document recording a delivery that did not happen.
  const lines = toBulkLines({ 88: [201, 202], 89: [] });
  assert.deepEqual(lines, [{ po_line_id: 88, component_ids: [201, 202] }]);
  assert.deepEqual(toBulkLines({ 88: [], 89: [] }), [], 'nothing ticked sends nothing');
});
