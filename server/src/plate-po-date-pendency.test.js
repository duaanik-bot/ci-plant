import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── The Plate buying registers answer WHEN and WHAT-IS-STILL-OWED ─────────
//
// The Plate PO register showed only the Expected date — the one date the
// vendor promised, never the one the order was raised on. And the plates
// module had no Pendency at all: dies, blocks and board Procurement each
// have one, so "which plates have not landed" was the only outstanding-PO
// question in the plant with no register to answer it.

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

const columnAt = (source, anchor, length = 400) => {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `"${anchor}" is missing`);
  return source.slice(at, at + length);
};

test('the Plate PO register carries a dedicated PO Date column', () => {
  const src = read('client/src/components/PlatesLifecycle.jsx');
  const poColumns = columnAt(src, 'const poColumns', 6000);
  const col = columnAt(poColumns, "label: 'PO Date'");
  // created_at IS the PO date — a plate PO is born in this screen, and the
  // Procurement pendency prints the same field under the same name.
  assert.match(col, /created_at/,
    'the PO Date column must render created_at, the date the PO was raised');
  // A JSX cell exports blank unless the column says how to flatten itself.
  assert.match(col, /export:/,
    'the PO Date column needs an export fn or the Excel column is empty');
  assert.match(col, /card:\s*'detail'/,
    "a new date column must not become the phone card's subtitle — see classifyColumns");
});

test('the plates module has a Pendency register on the family endpoint', () => {
  const src = read('client/src/components/PlatesLifecycle.jsx');
  assert.match(src, /\/tooling\/procurement\/plate\/pendency/,
    'the pendency endpoint already answers for family=plate; the module must call it');
  assert.match(src, /key:'pendency',label:'Pendency'/,
    'Pendency must be offered as a step of the buying stage');
  assert.match(src, /'requirements', 'pos', 'grns', 'pendency'/,
    'the pendency tab must live inside PROCUREMENT_TABS or the stage rail drops it');
  assert.match(src, /exportName="Plate Pendency"/);
});

test('the pendency list opens on the oldest promise, and an undated one cannot lead', () => {
  const src = read('client/src/components/PlatesLifecycle.jsx');
  const table = columnAt(src, "rows={pendency[pendencyView] || []}", 700);
  assert.match(table, /key:\s*'expected_date',\s*dir:\s*'asc'/,
    'pendency answers "what is overdue", so the oldest promise leads');
  // expected_date is nullable, and normalizeSortValue turns null into '', which
  // compares BELOW every date — ascending, that floats an undated line to the
  // head where it reads as the most overdue. Infinity sends it last instead.
  // (Anchored past the PO register's own Expected column, which sorts by id
  // desc by default and does not need the guard.)
  const pendencyColumns = columnAt(src, 'const pendencyColumns', 4000);
  const expected = columnAt(pendencyColumns, "{ key: 'expected_date', label: 'Expected'");
  assert.match(expected, /sortValue:.*Infinity/s,
    'an expected_date column sorted ascending needs the Infinity guard for null dates');
});

test('a plate pendency line names the job it is waiting for', () => {
  const route = read('server/src/routes/tooling-procurement.js');
  const sql = columnAt(route, '/tooling/procurement/:family/pendency', 1600);
  // The same product spelling platePoRows uses: the name frozen on the request
  // wins, the master fills in behind it.
  assert.match(sql, /COALESCE\(NULLIF\(tr\.specification->>'product_name',''\),p\.name\) AS product_name/,
    'the pendency line must carry the product the plates are for');
  assert.match(sql, /tr\.request_number, jc\.jc_number/);
  // LEFT joins, not plain: a direct PO has no requisition behind it and must
  // still appear — losing it here would understate what is on order.
  assert.match(sql, /LEFT JOIN tooling_requests tr ON tr\.id=pl\.tooling_request_id/);
});

test('a built-in table search can say what it sweeps', () => {
  // DataTable's uncontrolled `searchable` box dropped the caller's
  // searchPlaceholder on the floor in BOTH tiers — every table that passed one
  // alongside `searchable` rendered a bare "Search…", which names nothing.
  const ui = read('client/src/components/ui.jsx');
  const uncontrolled = ui.match(/searchable \? <SearchInput[^/]*\/>|searchable && <SearchInput[^/]*\/>/g) || [];
  assert.ok(uncontrolled.length >= 2, `expected both tiers' uncontrolled boxes, found ${uncontrolled.length}`);
  for (const box of uncontrolled) {
    assert.match(box, /placeholder=\{searchPlaceholder\}/,
      `an uncontrolled search box ignores the caller's placeholder: ${box}`);
  }
  // And the two plate buying registers actually say something.
  const src = read('client/src/components/PlatesLifecycle.jsx');
  const po = columnAt(src, 'rows={pos} columns={poColumns}', 400);
  assert.match(po, /searchPlaceholder="Search PO/,
    'the Plate PO register search must name what it reaches');
  const pendency = columnAt(src, 'rows={pendency[pendencyView] || []}', 700);
  assert.match(pendency, /searchPlaceholder="Search PO/,
    'the Plate Pendency search must name what it reaches');
});
