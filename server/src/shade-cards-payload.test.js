// What the shade card register carries — opt-in, so an old bundle keeps the lot.
//
// GET /shade-cards?all=1 hands the register every sc.* column: 599 cards,
// 1,334 KB, a third of it the approval/signature/custody detail the drawer shows
// — and the drawer never reads it off the list row, it refetches
// /shade-cards/:id. The Tooling shade hub pulls the same 1.3 MB on every
// realtime refresh to draw seven columns.
//
// ?view=list sheds the drawer-only columns; ?view=hub carries the hub's columns.
// No view is the response every tablet already running an old bundle reads, and
// it stays byte-for-byte what it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SHADE_CARD_LIST_DROPS, SHADE_CARD_HUB_FIELDS, shapeCardList,
} from './routes/shadecards.js';
import { productIdentitySql } from './product-identity.js';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const word = f => new RegExp(`\\b${f}\\b`);

// Every screen that holds a LIST row (not the drawer's own /:id fetch).
const LIST_READERS = [
  '../../client/src/pages/ShadeCards.jsx',
  '../../client/src/pages/shade-cards/ToIssue.jsx',
  '../../client/src/pages/shade-cards/lifecycle.js',
  '../../client/src/pages/Tooling.jsx',
];

const card = () => ({
  id: 7, sc_number: 'CI0007', status: 'approved', active: 1, title: 'Carton shade card',
  customer_name: 'Swiss Garniers', product_name: 'REJOINT', product_code: 'SGB-267',
  party_artwork_code: 'AC22494', party_item_code: 'P-1', artwork_no: 'AC22494', output_no: 'O-9',
  po_number: 'PO-12', location: 'Cabinet A', updated_at: '2026-09-16T10:00:00.000Z',
  orders: [{ id: 1, po_number: 'PO-12' }], issued_to: null, department: null,
  age_days: 20, expired_by_age: false, age_unknown: false, to_issue: true, work_tier: 1,
  created_by: 'import', approval_received_by: 'Anik Dua (MD)', print_process: null,
  customer_contact_name: null, customer_designation: null, issued_job_card_id: null,
  internal_signatory: null, issued_machine_id: null, customer_company: 'Swiss Garniers',
  approval_remarks: null, approval_method: 'email', customer_signature: 1,
  print_reference: null, issued_operator: null, internal_qc_stamp: 0, legacy_tool_id: null,
  colour_details: null, superseded_by: null, colour_system: null, artwork_rev: null,
  verified_at: null, customer_stamp: 1, num_colours: null, internal_approval_date: null,
});

test('no view: the rows go out exactly as they came in', () => {
  const rows = [card(), { ...card(), id: 8 }];
  const out = shapeCardList(rows, undefined);
  assert.equal(JSON.stringify(out), JSON.stringify([card(), { ...card(), id: 8 }]));
  assert.equal(JSON.stringify(shapeCardList([card()], 'nonsense')), JSON.stringify([card()]),
    'an unknown view is the default, never an empty or partial row');
});

test('view=list drops exactly the drop-list and nothing else', () => {
  const [lean] = shapeCardList([card()], 'list');
  const expected = Object.keys(card()).filter(k => !SHADE_CARD_LIST_DROPS.includes(k));
  assert.deepEqual(Object.keys(lean), expected);
  for (const k of expected) assert.deepEqual(lean[k], card()[k], `${k} travels unchanged`);
});

test('the drop-list is pinned', () => {
  assert.deepEqual([...SHADE_CARD_LIST_DROPS].sort(), [
    'approval_method', 'approval_remarks', 'artwork_rev', 'colour_details', 'colour_system',
    'customer_company', 'customer_contact_name', 'customer_designation', 'customer_signature',
    'customer_stamp', 'internal_approval_date', 'internal_qc_stamp', 'internal_signatory',
    'issued_job_card_id', 'issued_machine_id', 'issued_operator', 'legacy_tool_id',
    'num_colours', 'print_reference', 'superseded_by', 'verified_at',
  ]);
  assert.equal(new Set(SHADE_CARD_LIST_DROPS).size, SHADE_CARD_LIST_DROPS.length);
});

test('no list reader touches a dropped column', () => {
  for (const file of LIST_READERS) {
    const src = read(file);
    const hits = SHADE_CARD_LIST_DROPS.filter(f => word(f).test(src));
    assert.deepEqual(hits, [], `${file} reads ${hits.join(', ')}`);
  }
  assert.ok(read('../../client/src/pages/shade-cards/ShadeCardDrawer.jsx')
    .includes('api.get(`/shade-cards/${id}`)'), 'the drawer loads its own card, never the list row');
});

test('the register search still finds a card by who made it or who took the approval', () => {
  // DataTable search stringifies every value on the row, so a dropped column is
  // a search that silently stops matching. These two carry people's names.
  for (const kept of ['created_by', 'approval_received_by']) {
    assert.equal(SHADE_CARD_LIST_DROPS.includes(kept), false, `${kept} must stay searchable`);
  }
});

test('a column ProductIdentity overlays onto the master is never dropped', () => {
  // ToIssue renders <ProductIdentity row={card}>, which spreads the row OVER the
  // cached product master — so a null card column hides the master's value in
  // the history panel. Dropping one would change what that panel prints.
  // The identity SELECT lives in product-identity.js (one source for the bare and
  // the ?ids= forms); read it from there, both forms.
  const identity = productIdentitySql(false) + '\n' + productIdentitySql(true);
  assert.ok(identity.includes('FROM products p'));
  const overlaid = SHADE_CARD_LIST_DROPS.filter(f => word(`p\\.${f}`).test(identity));
  assert.deepEqual(overlaid, []);
});

test('view=hub carries what the Tooling shade hub draws, sorts, opens and searches by', () => {
  const tooling = read('../../client/src/pages/Tooling.jsx');
  const cols = tooling.split('const cardColumns = [')[1]?.split('];')[0] ?? '';
  const keys = [...cols.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 6, 'cardColumns must be found');
  const read_ = [...new Set([...keys, ...[...cols.matchAll(/r\.(\w+)/g)].map(m => m[1])])];
  const missing = [...read_, 'id', 'sc_number'].filter(f => !SHADE_CARD_HUB_FIELDS.includes(f));
  assert.deepEqual(missing, [], `the hub reads ${missing.join(', ')}`);
  const [hub] = shapeCardList([card()], 'hub');
  assert.deepEqual(Object.keys(hub), SHADE_CARD_HUB_FIELDS.filter(f => f in card()));
});

test('the list route shapes by ?view=, and only the list route', () => {
  const src = read('./routes/shadecards.js');
  const list = src.split("r.get('/shade-cards', ")[1]?.split('});')[0] ?? '';
  assert.match(list, /shapeCardList\(rows\.map\(decorate\), req\.query\.view\)/);
  for (const route of ["r.get('/shade-cards/alerts'", "r.get('/shade-cards/reports'", "r.get('/shade-cards/:id"]) {
    const body = src.split(route)[1]?.split('});')[0] ?? '';
    assert.ok(body, `${route} must be found`);
    assert.equal(body.includes('shapeCardList'), false, `${route} keeps the full card`);
  }
});

test('the register asks for the list view and the hub for the hub view', () => {
  assert.ok(read('../../client/src/pages/ShadeCards.jsx').includes("api.get('/shade-cards?all=1&view=list')"));
  const tooling = read('../../client/src/pages/Tooling.jsx');
  assert.ok(tooling.includes("api.get('/shade-cards?all=1&view=hub')"));
  assert.equal(tooling.includes("api.get('/shade-cards?all=1')"), false);
});
