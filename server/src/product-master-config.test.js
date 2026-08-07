import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_MASTER_FIELDS,
  productMasterBody,
  productMasterRequiredMissing,
  validateProductMaster,
} from '../../client/src/lib/productMasterConfig.js';

test('product master form carries the complete identity and production spec', () => {
  const keys = new Set(PRODUCT_MASTER_FIELDS.map(field => field.key));
  for (const key of [
    'name', 'customer_id', 'code', 'party_item_code', 'party_artwork_code',
    'board_material_id', 'child_l', 'parent_l', 'colour_type', 'coating',
    'pasting_type', 'die_number', 'product_type', 'rate', 'active',
  ]) assert.equal(keys.has(key), true, `${key} should stay on both product editors`);
});

test('product master body normalises numeric references and derives special finish', () => {
  const body = productMasterBody({
    id: 41,
    name: 'Carton',
    customer_id: '7',
    board_material_id: '12',
    gsm: '330',
    rate: '5.25',
    emboss: '1',
    leafing: '1',
    leafing_colour: 'gold',
  });
  assert.equal(body.customer_id, 7);
  assert.equal(body.board_material_id, 12);
  assert.equal(body.gsm, 330);
  assert.equal(body.rate, 5.25);
  assert.equal(body.special, 'foil_emboss');
  assert.equal(body.leafing_colour, 'gold');
});

test('turning leafing off clears its colour before save', () => {
  const body = productMasterBody({ leafing: '0', leafing_colour: 'gold' });
  assert.equal(body.leafing_colour, null);
  assert.equal(body.special, 'none');
});

test('duplicate internal code guard ignores the row being edited', () => {
  const rows = [
    { id: 1, code: 'SW-100', name: 'One' },
    { id: 2, code: 'SW-200', name: 'Two' },
  ];
  assert.equal(validateProductMaster({ code: 'SW-100' }, { rows, editing: rows[0] }), null);
  assert.match(validateProductMaster({ code: 'sw-200' }, { rows, editing: rows[0] }), /already belongs to Two/);
});

test('save stays disabled until the three required master fields are present', () => {
  assert.equal(productMasterRequiredMissing({ name: 'Carton', customer_id: 1 }), true);
  assert.equal(productMasterRequiredMissing({ name: 'Carton', customer_id: 1, board_material_id: 2 }), false);
});
