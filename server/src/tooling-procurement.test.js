import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolingMasterShape,
  toolingPoStatus,
  toolingRequirementQty,
  toolingRequirementReady,
} from './tooling-procurement.js';

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

test('requirement is ready only when allocation covers demand', () => {
  assert.equal(toolingRequirementReady(5, 4), false);
  assert.equal(toolingRequirementReady(5, 5), true);
});
