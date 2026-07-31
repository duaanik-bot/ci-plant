import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASTERS } from './routes/masters.js';

// The generic master CRUD only ever touches the columns named in MASTERS. A
// column that exists on the table but is absent from this map is not "written
// as NULL" — it is not written at all, and the form field that collects it
// silently loses whatever was typed.
//
// That is not hypothetical: materials.min_stock and materials.max_stock exist
// (db.js), the Boards master collects them as Minimum Stock and Maximum Stock,
// and neither was in this map — so every value the plant typed into those two
// fields was discarded on save. These tests are the guard.
//
// See also the sibling rule in ci-erp-masters-post-null-columns: a column that
// IS listed but absent from the request body inserts NULL, never the column
// default. Both failure modes come from the same generic INSERT.

test('materials writes the whole stock band the Boards master collects', () => {
  for (const col of ['reorder_level', 'min_stock', 'max_stock']) {
    assert.ok(MASTERS.materials.includes(col),
      `materials is missing ${col} — the Boards form collects it and it would be discarded on save`);
  }
});

test('materials still writes the identity and pricing columns', () => {
  for (const col of ['name', 'category', 'spec', 'unit', 'grade', 'gsm',
                     'sheet_l', 'sheet_w', 'sheets_per_packet', 'hsn_code', 'gst_rate', 'active']) {
    assert.ok(MASTERS.materials.includes(col), `materials is missing ${col}`);
  }
});

test('products writes every column the master form can set', () => {
  for (const col of ['customer_id', 'name', 'code', 'board_material_id', 'board_grade', 'gsm',
                     'child_l', 'child_w', 'parent_l', 'parent_w', 'ups', 'colors', 'colour_type',
                     'coating', 'special', 'pasting_type', 'emboss', 'leafing', 'leafing_colour',
                     'die_number', 'block_number', 'tool_id', 'product_type', 'rate', 'mrp',
                     'spec_incomplete', 'active']) {
    assert.ok(MASTERS.products.includes(col), `products is missing ${col}`);
  }
});

// products.gst_pct is the per-product GST override. It is read on the way out
// (COALESCE(p.gst_pct, gr.rate, 12) AS effective_gst) and consumed by the sales
// order's gstOf(), but was never written — so the override could be typed and
// never took. Safe to list: the column is nullable with no default, and NULL is
// its meaningful value ("no override, use the product type's rate").
test('products writes the GST override it already reads back', () => {
  assert.ok(MASTERS.products.includes('gst_pct'),
    'products is missing gst_pct — the GST override would be discarded on save');
});

// products.wastage_pct must NOT be listed, and this test is the guard.
//
// It is DOUBLE PRECISION **NOT NULL** DEFAULT 0. The generic INSERT builds its
// values with `req.body[c] ?? null`, so a listed column that the request does
// not carry is inserted as NULL — never as the column default (the same rule
// that makes every master want the full row). The Masters product form has no
// Wastage field, so listing this column would send NULL into a NOT NULL column
// and fail every single product create.
//
// The plant plans wastage in absolute child sheets now; the percentage on the
// master is only the fallback in sheetsFor() and defaults to 0. There is
// nothing to gain here and a broken master form to lose.
test('products does NOT write wastage_pct — it is NOT NULL and no form sends it', () => {
  assert.ok(!MASTERS.products.includes('wastage_pct'),
    'wastage_pct is NOT NULL with no form field behind it — listing it makes every product create insert NULL and fail');
});

// No duplicates: the INSERT builds its placeholder list straight off this
// array, so a repeated column would produce "INSERT … (name, …, name)" and
// fail at the database rather than anywhere readable.
test('no master lists the same column twice', () => {
  for (const [table, cols] of Object.entries(MASTERS)) {
    assert.equal(new Set(cols).size, cols.length, `${table} lists a column twice`);
  }
});
