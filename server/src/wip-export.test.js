// The customer-wise Status Sheet workbook. Lives in server/src because
// node --test cannot import the .jsx page these rules used to be buried in.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWipExportSpec, groupRowsByCustomer, wipExportColumns, customersOf,
  EXPORT_EXCLUDED_KEYS,
} from '../../client/src/lib/wipExport.js';

const COLS = [
  { key: 'po_number', label: 'Order #' },
  { key: 'customer_name', label: 'Company' },
  { key: 'delivery_date', label: 'EDD' },
  { key: 'wip', label: 'WIP' },
  { key: 'line_status', label: 'Status' },
  { key: 'remarks', label: 'Remarks' },
];
const line = (id, customer, extra = {}) =>
  ({ line_id: id, customer_name: customer, po_number: `PO-${id}`, ...extra });

// ── Columns ──────────────────────────────────────────────────────────────────

test('the status column is dropped from the export', () => {
  const keys = wipExportColumns(COLS).map(c => c.key);
  assert.ok(!keys.includes('line_status'));
});

test('EDD and Remarks survive — they are the two the export was asked to add', () => {
  const keys = wipExportColumns(COLS).map(c => c.key);
  assert.ok(keys.includes('delivery_date'));
  assert.ok(keys.includes('remarks'));
});

test('exclusion is keyed, not labelled', () => {
  // Renaming the column heading must not put it back in a customer's workbook.
  assert.deepEqual(EXPORT_EXCLUDED_KEYS, ['line_status']);
  const renamed = COLS.map(c => (c.key === 'line_status' ? { ...c, label: 'Where' } : c));
  assert.ok(!wipExportColumns(renamed).some(c => c.key === 'line_status'));
});

test('nothing else is dropped', () => {
  assert.equal(wipExportColumns(COLS).length, COLS.length - 1);
});

// ── Grouping ─────────────────────────────────────────────────────────────────

test('one bucket per customer, alphabetical', () => {
  const groups = groupRowsByCustomer([
    line(1, 'Zydus'), line(2, 'Alkem'), line(3, 'Zydus'),
  ]);
  assert.deepEqual(groups.map(g => g.customer), ['Alkem', 'Zydus']);
  assert.equal(groups[1].rows.length, 2);
});

test('row order inside a bucket is the order the table handed over', () => {
  const groups = groupRowsByCustomer([line(3, 'Alkem'), line(1, 'Alkem'), line(2, 'Alkem')]);
  assert.deepEqual(groups[0].rows.map(r => r.line_id), [3, 1, 2]);
});

test('a single-customer gang stays collapsed — the sheet and screen agree', () => {
  const gang = { line_id: 'gang-7', customer_name: 'Alkem', _gang: [line(1, 'Alkem'), line(2, 'Alkem')] };
  const groups = groupRowsByCustomer([gang]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[0].rows[0].line_id, 'gang-7');
});

test('a gang shared by two customers is SPLIT — neither sheet carries the other', () => {
  // The leak this function exists to prevent: collapsed, this row would have to
  // be duplicated onto both worksheets, and each copy would show the other
  // company's carton.
  const gang = { line_id: 'gang-9', customer_name: 'Alkem', _gang: [line(1, 'Alkem'), line(2, 'Cipla')] };
  const groups = groupRowsByCustomer([gang]);
  assert.deepEqual(groups.map(g => g.customer), ['Alkem', 'Cipla']);
  for (const g of groups) {
    assert.equal(g.rows.length, 1);
    assert.equal(g.rows[0].customer_name, g.customer);
    assert.ok(!g.rows[0]._gang, 'the split row must be a plain line');
  }
});

test('customersOf reads through a gang', () => {
  assert.deepEqual(customersOf(line(1, 'Alkem')), ['Alkem']);
  assert.deepEqual(
    customersOf({ _gang: [line(1, 'Alkem'), line(2, 'Cipla'), line(3, 'Alkem')] }),
    ['Alkem', 'Cipla']);
});

test('a nameless customer is bucketed, never dropped', () => {
  const groups = groupRowsByCustomer([line(1, null)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].customer, 'Unassigned');
  assert.equal(groups[0].rows.length, 1);
});

// ── The spec ─────────────────────────────────────────────────────────────────

test('several customers → one worksheet each', () => {
  const spec = buildWipExportSpec({
    rows: [line(1, 'Alkem'), line(2, 'Cipla'), line(3, 'Alkem')],
    columns: COLS,
  });
  assert.equal(spec.sheetPerSection, true);
  assert.deepEqual(spec.sections.map(s => s.heading), ['Alkem', 'Cipla']);
  assert.equal(spec.sections[0].rows.length, 2);
  assert.equal(spec.sections[1].rows.length, 1);
});

test('the worksheet tab is the customer and nothing else', () => {
  // writeSectionSheets names the tab from `heading`, and Excel truncates at 31
  // characters — a decorated heading would spend them on decoration.
  const spec = buildWipExportSpec({ rows: [line(1, 'Alkem'), line(2, 'Cipla')], columns: COLS });
  for (const s of spec.sections) assert.match(s.heading, /^(Alkem|Cipla)$/);
});

test('every worksheet carries the same columns, status still absent', () => {
  const spec = buildWipExportSpec({ rows: [line(1, 'Alkem'), line(2, 'Cipla')], columns: COLS });
  for (const s of spec.sections) {
    assert.ok(!s.columns.some(c => c.key === 'line_status'));
    assert.ok(s.columns.some(c => c.key === 'remarks'));
  }
});

test('one customer → a plain single-table report titled with whose it is', () => {
  const spec = buildWipExportSpec({ rows: [line(1, 'Alkem'), line(2, 'Alkem')], columns: COLS });
  assert.ok(!spec.sheetPerSection);
  assert.ok(!spec.sections);
  assert.equal(spec.rows.length, 2);
  assert.match(spec.title, /Alkem/);
});

test('an empty sheet still exports a valid spec', () => {
  const spec = buildWipExportSpec({ rows: [], columns: COLS });
  assert.deepEqual(spec.rows, []);
  assert.ok(!spec.sheetPerSection);
  assert.ok(Array.isArray(spec.columns));
});

test('caller meta survives, and the multi-customer note is added', () => {
  const spec = buildWipExportSpec({
    rows: [line(1, 'Alkem'), line(2, 'Cipla')],
    columns: COLS,
    meta: ['Search: "carton"', null],
  });
  assert.ok(spec.meta.includes('Search: "carton"'));
  assert.ok(!spec.meta.includes(null), 'blank meta entries are dropped');
  assert.ok(spec.meta.some(m => /2 customers/.test(m)));
});
