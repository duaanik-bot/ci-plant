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

// One column definition out of the warehouse table.
function column(source, key) {
  const at = source.indexOf(`{ key: '${key}',`);
  if (at < 0) return null;
  const next = source.indexOf("\n    { key: '", at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

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
