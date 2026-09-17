// GET /products/picker — the product master as a dropdown.
//
// The plate, die and block hubs and the FG stock panel each pulled the WHOLE
// master (GET /products: 54 columns × 1,656 products, 1,847 KB) to fill one
// "name · code" picker. The shade hub pulled it too, on every realtime refresh,
// and never rendered it at all. The picker list is the same rows in the same
// order carrying only what those pickers draw and search.
//
// GET /products itself is what the Product Master screen, the order form and
// every plant tablet still running an old bundle read — it must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const masters = read('./routes/masters.js');
const pickerSql = masters.split("r.get('/products/picker'")[1]?.split('});')[0] ?? '';
const listSql = masters.split("if (table === 'products') {")[1]?.split('} else if')[0] ?? '';
const squash = s => s.replace(/\s+/g, ' ').trim();

// ToolingProcurement InventoryModal: `${p.name} · ${p.code}` keyed by p.id.
// FgStockPanel: p.id, name · code on the option, addProduct.code /
// party_artwork_code / size, and productSearchText() on data-search, which
// reads name, code, internal_carton_code, party_artwork_code, party_item_code,
// output_number, size and customer_name.
const PICKER = ['id', 'name', 'code', 'customer_id', 'customer_name', 'active',
  'internal_carton_code', 'party_item_code', 'party_artwork_code', 'output_number', 'size'];

test('the picker route exists and selects everything its pickers draw and search', () => {
  assert.ok(pickerSql.includes('FROM products p'), 'GET /products/picker must be registered');
  const missing = PICKER.filter(f => !new RegExp(`\\b${f}\\b`).test(pickerSql));
  assert.deepEqual(missing, [], `the pickers read these: ${missing.join(', ')}`);
  assert.equal(/p\.\*/.test(pickerSql), false, 'p.* is the 1.8 MB master by another name');
});

test('the picker is registered before any /products/:id-shaped route', () => {
  const picker = masters.indexOf("r.get('/products/picker'");
  const loop = masters.indexOf('for (const [table, cols] of Object.entries(MASTERS))');
  const param = masters.search(/r\.\w+\(['`]\/(products|\$\{table\})\/:/);
  assert.ok(picker > 0 && loop > 0, 'both the picker and the masters loop must be found');
  assert.ok(picker < loop, 'the picker must come before the loop that registers /products/:id');
  assert.ok(param < 0 || picker < param, 'the picker must come before every /products/:param route');
});

test('the picker lists the same rows in the same order as GET /products', () => {
  // Same inner joins: a product without a customer or a board drops out of
  // /products, so it must drop out of the picker too. The two LEFT JOINs that
  // /products adds (tools by primary key, gst_rates by its unique product_type)
  // can never add or remove a row, so the picker leaves them out.
  for (const join of ['FROM products p', 'JOIN customers c ON c.id=p.customer_id',
    'JOIN materials m ON m.id=p.board_material_id']) {
    assert.ok(squash(listSql).includes(join), `/products: ${join}`);
    assert.ok(squash(pickerSql).includes(join), `/products/picker: ${join}`);
  }
  assert.equal(/\bWHERE\b/.test(listSql), false, '/products lists every product');
  assert.equal(/\bWHERE\b/.test(pickerSql), false, 'so does the picker');
  // Names repeat, so ORDER BY p.name alone is not a total order — two lists
  // built from it can disagree on which twin comes first.
  assert.match(listSql, /ORDER BY p\.name, p\.id`/);
  assert.match(pickerSql, /ORDER BY p\.name, p\.id`/);
});

test('GET /products keeps its full row — old bundles read every column', () => {
  assert.equal(squash(listSql.split('FROM')[0]),
    "rows = await q(` SELECT p.*, c.name AS customer_name, m.name AS board_material_name, m.sheet_l, m.sheet_w, d.code AS linked_die_code, d.condition AS die_condition, COALESCE(p.gst_pct, gr.rate, 12) AS effective_gst");
  assert.ok(squash(listSql).includes('LEFT JOIN tools d ON d.id=p.tool_id LEFT JOIN gst_rates gr ON gr.product_type = p.product_type'));
  assert.match(masters, /r\.get\(`\/\$\{table\}`, async \(_req, res, next\)/,
    'the list route reads no query parameter — its response cannot vary by one');
});

test('the tooling hubs and the FG panel read the picker, not the whole master', () => {
  for (const file of ['../../client/src/components/ToolingProcurement.jsx',
    '../../client/src/components/FgStockPanel.jsx']) {
    const src = read(file);
    assert.ok(src.includes("api.get('/products/picker')"), `${file} must fetch /products/picker`);
    assert.equal(src.includes("api.get('/products')"), false, `${file} must not fetch the 1.8 MB master`);
  }
});

test('the shade hub stops downloading a product list it never renders', () => {
  const tooling = read('../../client/src/pages/Tooling.jsx');
  const ops = tooling.split('function ToolingOperations(')[1] ?? '';
  assert.ok(ops, 'ToolingOperations must be found');
  assert.equal(/api\.get\('\/products/.test(ops), false,
    'ToolingOperations mounts only for shade cards, where nothing reads products');
  assert.equal(/\[products, setProducts\]/.test(ops), false, 'and it keeps no products state');
});
