// The rack's "Contains" column: the build on screen, the roll-call in the export.
//
// The Plates Warehouse runs to hundreds of rows and every one of them spelled
// out "Cyan, Magenta, Yellow, Black" — four words saying what "CMYK" says in
// one. Same collapse as the PO and PR registers.
//
// It is collapsed PER STATE, not per set: a set with two plates issued and two
// still on the shelf has to say WHICH two, and the row's own Status column
// already collapses that to "mixed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inkSummaryByStatus } from '../../client/src/lib/plateInks.js';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

// EVERY column definition on that key — "Contains" exists twice, on the rack and
// on the return queue, and a helper that stopped at the first would have let the
// second keep spelling out four colours while the test went green.
function columns(source, key) {
  const found = [];
  let at = source.indexOf(`{ key: '${key}',`);
  while (at >= 0) {
    const next = source.indexOf("\n    { key: '", at + 1);
    found.push(source.slice(at, next < 0 ? source.length : next));
    at = source.indexOf(`{ key: '${key}',`, at + 1);
  }
  return found;
}
// The key `component_label` is used THREE times: "Contains" on the rack and on
// the return queue, both of which are a set's list — and "Component" on the
// movement ledger, which is one plate's own single colour and must stay plain.
const containsColumns = source =>
  columns(source, 'component_label').filter(col => /label: 'Contains'/.test(col));
const column = (source, key) => columns(source, key)[0] || null;

test('BOTH Contains columns show the build, not four words', () => {
  const cols = containsColumns(read('client/src/components/PlatesLifecycle.jsx'));
  assert.equal(cols.length, 2, 'expected a Contains column on the rack AND on the return queue');
  for (const col of cols) {
    assert.match(col, /InkStateSummary/,
      'a Contains column still spells out every colour on every row');
  }
});

test('the rack shows the build, not four words', () => {
  const col = column(read('client/src/components/PlatesLifecycle.jsx'), 'component_label');
  assert.ok(col, 'the Contains column is missing from the warehouse table');
  assert.match(col, /InkStateSummary/,
    'the rack still spells out every colour on every one of hundreds of rows');
});

test('the EXPORT keeps the colour names the screen stopped printing', () => {
  // exporter.js resolves col.export(row) → nodeText(col.render(row)) → row[key].
  // Without an explicit export the spreadsheet would inherit "CMYK" from the
  // rendered chip — a workbook is read away from the screen and cannot hover.
  const col = column(read('client/src/components/PlatesLifecycle.jsx'), 'component_label');
  assert.match(col, /export: row => row\.contains/,
    'collapsing the cell must not collapse the export — see the gang-cell blank-export trap');
  assert.match(col, /sortValue: row => row\.contains/,
    'and sorting must stay on the names, or the column orders by nothing');
});

test('a row with no component detail still says what it contains', () => {
  // Not every rack row is a grouped set; `contains` is the flat text fallback.
  const col = column(read('client/src/components/PlatesLifecycle.jsx'), 'component_label');
  assert.match(col, /row\.components\?\.length/, 'the fallback must be guarded on there being components');
  assert.match(col, /row\.contains \|\| row\.component_label/, 'and fall back to the plain text');
});

test('a rack set that is wholly one state is ONE chip', () => {
  // The live rack is uniform — 1,358 plates all available — so this is the
  // common case and the whole point of the collapse.
  const parts = inkSummaryByStatus([
    { component_type: 'cyan', component_label: 'Cyan', status: 'available' },
    { component_type: 'magenta', component_label: 'Magenta', status: 'available' },
    { component_type: 'yellow', component_label: 'Yellow', status: 'available' },
    { component_type: 'black', component_label: 'Black', status: 'available' },
  ]);
  assert.deepEqual(parts.map(p => [p.status, p.label]), [['available', 'CMYK']]);
});

test('a part-issued set still says which plates left the shelf', () => {
  // This is what a plain collapse would destroy, and it is the question a rack
  // row is asked: two of these are on a press, which two?
  const parts = inkSummaryByStatus([
    { component_type: 'cyan', component_label: 'Cyan', status: 'issued' },
    { component_type: 'magenta', component_label: 'Magenta', status: 'issued' },
    { component_type: 'yellow', component_label: 'Yellow', status: 'available' },
    { component_type: 'black', component_label: 'Black', status: 'available' },
  ]);
  assert.deepEqual(parts.map(p => [p.status, p.label]), [
    ['issued', 'CM'],
    ['available', 'YK'],
  ]);
});

test('both Contains columns keep the names in the export', () => {
  for (const col of containsColumns(read('client/src/components/PlatesLifecycle.jsx'))) {
    assert.match(col, /export: row => row\.contains/,
      'collapsing the cell must not collapse the export — a workbook cannot be hovered');
    assert.match(col, /sortValue: row => row\.contains/,
      'and sorting must stay on the names, or the column orders by nothing');
  }
});

test('the movement ledger’s Component column is left ALONE', () => {
  // It is one plate's own colour, not a set's list. Collapsing a single value
  // would turn "Cyan" into "C" and gain nothing.
  const cols = columns(read('client/src/components/PlatesLifecycle.jsx'), 'component_label');
  const ledger = cols.find(col => /label: 'Component'/.test(col));
  assert.ok(ledger, 'the movement ledger lost its Component column');
  assert.doesNotMatch(ledger, /InkStateSummary|InkSummary/,
    'the ledger names one plate; there is no build to summarise');
});

// ── History is deliberately NOT collapsed ───────────────────────────────────
test('the movement ledger is one plate per row, so it has nothing to collapse', () => {
  const route = read('server/src/routes/plates.js');
  const at = route.indexOf("r.get('/plates/history'");
  const body = route.slice(at, route.indexOf('\nr.', at + 1));
  // plate_asset_movements JOIN plate_assets — pa.component_label is that ONE
  // plate's own colour, not a set's list. Collapsing it would be collapsing a
  // single value.
  assert.match(body, /FROM plate_asset_movements pam JOIN plate_assets pa/,
    'if history ever groups into sets, its Component column needs the same treatment as Contains');
  assert.match(body, /pa\.component_label/, 'the column is one plate’s own colour');
});

// The ledger renders ProductIdentity like every other plate register, and that
// is only safe because its query carries pa.product_id. The two must move
// together: productRecord() resolves `row.product_id ?? row.id`, and a movement
// row's own `id` is the MOVEMENT id — dropping the column would silently start
// looking cartons up by movement number and printing another product's party
// codes. Nothing would throw; the codes would just be wrong.
const historyQuery = () => {
  const route = read('server/src/routes/plates.js');
  const at = route.indexOf("r.get('/plates/history'");
  return route.slice(at, route.indexOf('\nr.', at + 1));
};
// The SELECT LIST only — everything between SELECT and FROM.
//
// Asserting `pa.product_id` against the whole query is a guard that cannot fail:
// the join reads `JOIN products p ON p.id=pa.product_id`, so the string is
// present whether or not the column is actually selected. Verified by deleting
// the column and watching the naive version stay green.
const historySelectList = () => {
  const body = historyQuery();
  const from = body.indexOf('FROM plate_asset_movements');
  return body.slice(body.indexOf('SELECT'), from);
};
const historyCols = () => {
  const page = read('client/src/components/PlatesLifecycle.jsx');
  const at = page.indexOf('const historyColumns = [');
  return page.slice(at, page.indexOf('\n  ];', at));
};

test('the history query SELECTS the plate’s own product id', () => {
  assert.match(historySelectList(), /pa\.product_id/,
    'without pa.product_id in the select list the ledger resolves `row.id` — a MOVEMENT id — '
    + 'as a product, and prints another carton’s party codes. Nothing throws; the codes are '
    + 'simply wrong. (Assert the SELECT LIST: the join mentions pa.product_id regardless.)');
});

test('the ledger renders the same product identity as every other register', () => {
  assert.match(historyCols(), /<PlateProductIdentity row=\{row\} compact \/>/,
    'a gang movement must say it is a gang and list its cartons, as the rack and PR registers do');
});

test('the ledger’s product EXPORT stays flat text, and does not say it twice', () => {
  // exporter.js walks the rendered node when there is no export:, so a chip-based
  // identity would put "Unified gang plate · 2 products" into a spreadsheet cell.
  // A ledger is exported to be filtered and pivoted.
  const cols = historyCols();
  assert.match(cols, /export: row =>/, 'the ledger export must stay flat text, not the rendered chips');
  // A gang names ITSELF: product_code === product_name, and the old
  // `code · name` wrote "CI-GANG-0011 · CI-GANG-0011" into every gang row.
  assert.match(cols, /new Set\(\[row\.product_code, row\.product_name\]/,
    'code and name are the same string on a gang and must not be printed twice');
});
