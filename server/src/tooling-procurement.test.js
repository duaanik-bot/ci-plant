import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toolingMasterShape,
  toolingPoStatus,
  toolingRequirementQty,
  toolingRequirementReady,
} from './tooling-procurement.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('plate demand follows the Job Card printing colour total', () => {
  assert.equal(toolingRequirementQty('plate', { colour_type: 'CMYK', colors: 4 }), 4);
  assert.equal(toolingRequirementQty('plate', { colour_type: 'CMYK + Pantone', colors: 5 }), 5);
  assert.equal(toolingRequirementQty('plate', { colour_type: 'CMYK + Pantone', colors: 6 }), 6);
  assert.equal(toolingRequirementQty('plate', { colour_type: 'Pantone', colors: 2 }), 2);
  assert.equal(toolingRequirementQty('plate', { colour_type: 'Pantone', colors: 1 }), 1);
  assert.equal(toolingRequirementQty('plate', { colour_type: 'CMYK + Pantone' }), 4);
});

test('dies and blocks remain one requirement per Job Card product', () => {
  assert.equal(toolingRequirementQty('die', { colors: 6 }), 1);
  assert.equal(toolingRequirementQty('block', { colors: 6 }), 1);
});

test('tooling master identity is stable for the same product and output', () => {
  const first = toolingMasterShape('plate', {
    productId: 42,
    productName: 'Carton A',
    specification: { output_number: 'SW-782', colour_type: 'CMYK + Pantone', colors: 5 },
  });
  const again = toolingMasterShape('plate', {
    productId: 42,
    productName: 'Renamed Carton A',
    specification: { output_number: 'SW-782', colour_type: 'CMYK + Pantone', colors: 5 },
  });
  assert.equal(first.masterKey, again.masterKey);
  assert.match(first.specification, /5 colours/);
});

test('purchase order status follows receipt totals', () => {
  assert.equal(toolingPoStatus([{ qty: 4, received_qty: 0 }]), 'open');
  assert.equal(toolingPoStatus([{ qty: 4, received_qty: 2 }]), 'partially_received');
  assert.equal(toolingPoStatus([{ qty: 4, received_qty: 4 }]), 'received');
});

test('a line closed short is DONE, and the finished order reads closed, never received', () => {
  // The waived balance is not owed, so the other line completing finishes the
  // order — but "received" would claim a delivery that never happened.
  assert.equal(toolingPoStatus([
    { qty: 4, received_qty: 4 },
    { qty: 3, received_qty: 1, closed_short: true },
  ]), 'closed');
  // Everything waived with nothing received is still a finished order.
  assert.equal(toolingPoStatus([{ qty: 3, received_qty: 0, closed_short: true }]), 'closed');
  // A fully received order stays 'received' — closing nothing changes nothing.
  assert.equal(toolingPoStatus([{ qty: 4, received_qty: 4, closed_short: false }]), 'received');
  // A closed line must not hold an order OPEN either: the sibling still owing
  // keeps it partial on its own receipts.
  assert.equal(toolingPoStatus([
    { qty: 4, received_qty: 2 },
    { qty: 3, received_qty: 0, closed_short: true },
  ]), 'partially_received');
});

test('requirement is ready only when allocation covers demand', () => {
  assert.equal(toolingRequirementReady(5, 4), false);
  assert.equal(toolingRequirementReady(5, 5), true);
});

test('Die requirements expose guarded bulk PO and bulk PR actions', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  const page = read('client/src/components/ToolingProcurement.jsx');
  assert.match(route, /r\.delete\('\/tooling\/procurement\/:family\/requirements\/bulk', canBuy/);
  assert.match(route, /approval_status !== 'pending'/);
  assert.match(route, /WHERE id=ANY\(\$1::int\[\]\) AND family=\$2 ORDER BY id FOR UPDATE/);
  assert.match(page, /deleteSelectable/);
  assert.match(page, /<DataTable searchable selectable rows=\{reqGroups\[reqView\]\}/);
  for (const label of ['Select all','Deselect all','Create Bulk PO','Delete PRs']) {
    assert.ok(page.includes(label), `${label} is missing`);
  }
});

test('Die converted PRs follow Procurement queue movement', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  const page = read('client/src/components/ToolingProcurement.jsx');
  assert.match(route, /UPDATE tooling_requests SET approval_status='converted'/);
  assert.match(page, /open: requests\.filter\(row => \['pending','approved'\]\.includes\(row\.approval_status\)\)/);
  assert.match(page, /converted: requests\.filter\(row => row\.approval_status === 'converted'\)/);
  assert.match(page, /\{ key: 'converted', label: 'Converted', count: reqGroups\.converted\.length \}/);
});
