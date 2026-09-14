// GET /products/identity — the product master as identity.
//
// Nearly every screen renders a product name, and a name that arrives without
// its codes sends ProductIdentity to its one app-wide cache of the master. That
// cache was pulling all 54 columns of all 1,649 products — 1,854 KB — to print
// three code chips and to have something for the history panel to open with.
//
// The identity list carries exactly what those two render. This test pins the
// column list against both readers, because a missing column here is a blank
// chip or a missing line in the history panel on every screen at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./routes/masters.js', import.meta.url), 'utf8')
  .split("r.get('/products/identity'")[1]?.split('});')[0] ?? '';

// ProductIdentity.jsx: the map key, the name, and the three code chips
// (productCodeParts → internal / artwork / party).
const IDENTITY = ['id', 'name', 'code', 'internal_carton_code',
  'party_item_code', 'party_artwork_code'];

// MasterHistory.jsx → ProductBrief: every line it prints for kind="products".
const PRODUCT_BRIEF = ['output_number', 'shade_card_number', 'board_material_name',
  'board_grade', 'gsm', 'size', 'child_l', 'child_w', 'parent_l', 'parent_w', 'ups',
  'colors', 'colour_type', 'print_process', 'coating', 'special', 'pasting_type',
  'emboss', 'leafing', 'leafing_colour', 'die_number', 'block_number', 'product_type',
  'effective_gst', 'rate', 'mrp'];

test('the identity route exists and selects every code a chip prints', () => {
  assert.ok(sql.includes('FROM products p'), 'GET /products/identity must be registered');
  for (const f of IDENTITY) {
    assert.match(sql, new RegExp(`\\b${f}\\b`), `identity chip reads ${f}`);
  }
});

test('it also selects every line the product history panel prints', () => {
  const missing = PRODUCT_BRIEF.filter(f => !new RegExp(`\\b${f}\\b`).test(sql));
  assert.deepEqual(missing, [], `ProductBrief renders these: ${missing.join(', ')}`);
});

test('the app-wide identity cache reads the identity route, not the whole master', () => {
  const client = readFileSync(
    new URL('../../client/src/components/ProductIdentity.jsx', import.meta.url), 'utf8');
  assert.ok(client.includes("api.get('/products/identity')"),
    'loadProductMasterCache must fetch /products/identity');
  assert.equal(client.includes("api.get('/products')"), false,
    'the 1.8 MB master must not come back by the side door');
});
