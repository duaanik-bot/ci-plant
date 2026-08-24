import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── THE THING YOU JUST PUSHED IS AT THE TOP ───────────────────────────────
//
// Firing tooling and then hunting for it is the complaint this fixes. Two
// separate causes, and fixing either alone changes nothing on screen:
//
//   1. The QUEUES ordered by status bucket, then delivery date, then id — so a
//      new requirement landed wherever its status and EDD put it, which from
//      the floor reads as random.
//
//   2. DataTable ALWAYS sorts. Given no defaultSort it takes the first sortable
//      column ASCENDING (ui.jsx), so the plate queue re-sorted itself by
//      request number ascending and threw the server's order away entirely —
//      the oldest CI-TR at the top, the one just fired at the bottom.
//
// So both ends are pinned: the API returns newest-first, and every requirement
// table asks for newest-first rather than inheriting the alphabetical default.

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

const sliceOf = (source, anchor, length = 900) => {
  const at = source.indexOf(anchor);
  assert.ok(at >= 0, `anchor "${anchor}" is missing`);
  const body = source.slice(at, at + length);
  assert.ok(body.length > 120, `slice at "${anchor}" proves nothing`);
  return body;
};

test('the PLATE queue returns newest first', () => {
  const sql = sliceOf(read('./routes/plates.js'), "WHERE tr.family='plate' ${idWhere}");
  const order = sql.slice(sql.indexOf('ORDER BY'), sql.indexOf('`', sql.indexOf('ORDER BY')));
  assert.match(order, /ORDER BY\s+tr\.id DESC/,
    'the plate requirement queue must lead with tr.id DESC — a PR just raised belongs at the top');
});

test('the TOOLING HUB queue returns newest first', () => {
  const sql = sliceOf(read('./routes/tooling.js'), 'const rows = await q(`${REQUEST_VIEW}');
  const order = sql.slice(sql.indexOf('ORDER BY'), sql.indexOf('`', sql.indexOf('ORDER BY')));
  assert.match(order, /ORDER BY\s+tr\.id DESC/,
    'the die/block/shade-card requirement queue must lead with tr.id DESC');
});

// The client half. `.jsx` cannot run under node --test, so the rule is pinned in
// the source: each requirement table must DECLARE its sort. Without the
// declaration DataTable silently falls back to first-column-ascending, which is
// the whole defect — and that fallback is invisible in review.
const REQUIREMENT_TABLES = [
  ['../../client/src/components/PlatesLifecycle.jsx', 'rows={reqRows}', 'the Plate PR queue'],
  ['../../client/src/components/ToolingProcurement.jsx', 'rows={reqGroups[reqView]}', 'the Tooling Hub requirement queue'],
  ['../../client/src/pages/Tooling.jsx', 'rows={filtered}', 'the Tooling queue'],
];

for (const [file, anchor, what] of REQUIREMENT_TABLES) {
  test(`${what} asks for newest-first instead of inheriting alphabetical order`, () => {
    const table = sliceOf(read(file), anchor, 700);
    assert.match(table, /defaultSort=\{\{\s*key:\s*'id',\s*dir:\s*'desc'\s*\}\}/,
      `${what} declares no newest-first defaultSort, so DataTable sorts it by its first `
      + 'column ascending and the requirement just raised is not at the top');
  });
}

test('DataTable really does fall back to first-column-ascending — the reason the above matters', () => {
  // Pinning the fallback itself: if it ever became "keep the given order", the
  // defaultSort declarations would be belt-and-braces rather than load-bearing,
  // and someone would reasonably delete them.
  const ui = sliceOf(read('../../client/src/components/ui.jsx'), 'const [sort, setSort] = useState(', 500);
  assert.match(ui, /if \(defaultSort\) return defaultSort;/);
  assert.match(ui, /dir: 'asc'/,
    'DataTable no longer defaults to ascending — re-check every requirement table');
});

// ── EVERY tooling table declares its order ────────────────────────────────
//
// The registers had the same defect as the queues, and in places a worse one:
// the plate Movement History and the tooling Movement Ledger both lead with a
// date column, so first-column-ascending showed the OLDEST movement first — a
// ledger opened to page one of ancient history.
//
// The durable rule is not "these particular tables are desc". It is that an
// undeclared sort is a latent bug: DataTable silently invents one, the call
// site reads as if it were deferring to the server, and nobody can see the
// difference in review. So every table in the tooling surfaces must SAY what
// it sorts by — including the catalogues, whose alphabetical order is right
// but was equally accidental.
const TABLE_FILES = [
  '../../client/src/components/PlatesLifecycle.jsx',
  '../../client/src/components/ToolingProcurement.jsx',
  '../../client/src/pages/Tooling.jsx',
];

function dataTableBlocks(source) {
  const blocks = [];
  let at = source.indexOf('<DataTable');
  while (at >= 0) {
    const end = source.indexOf('/>', at);
    blocks.push(source.slice(at, end < 0 ? at + 900 : end + 2));
    at = source.indexOf('<DataTable', at + 1);
  }
  return blocks;
}

for (const file of TABLE_FILES) {
  test(`every DataTable in ${file.split('/').pop()} declares a defaultSort`, () => {
    const blocks = dataTableBlocks(read(file));
    assert.ok(blocks.length >= 4, `expected several tables in ${file}, found ${blocks.length}`);
    const undeclared = blocks
      .filter(block => !/defaultSort=/.test(block))
      .map(block => (block.match(/rows=\{[^}]*\}?/) || ['<unknown rows>'])[0]);
    assert.deepEqual(undeclared, [],
      `these tables declare no defaultSort, so DataTable sorts them by their first column `
      + `ascending — which for a dated ledger means oldest-first: ${undeclared.join(', ')}`);
  });
}

test('the chronological registers are newest-first, not oldest-first', () => {
  // Named individually because "has a defaultSort" would be satisfied by an
  // ascending one, and ascending is precisely the bug on these.
  const CHRONOLOGICAL = [
    ['../../client/src/components/PlatesLifecycle.jsx', 'rows={pos}', 'Plate PO register'],
    ['../../client/src/components/PlatesLifecycle.jsx', 'rows={grns}', 'Plate GRN register'],
    ['../../client/src/components/PlatesLifecycle.jsx', 'rows={warehouseRows}', 'Plates Warehouse'],
    ['../../client/src/components/PlatesLifecycle.jsx', 'rows={returns}', 'Plate Returns'],
    ['../../client/src/components/PlatesLifecycle.jsx', 'rows={history}', 'Plate Movement History'],
    ['../../client/src/components/ToolingProcurement.jsx', 'rows={poRows}', 'Tooling PO register'],
    ['../../client/src/components/ToolingProcurement.jsx', 'rows={grnRows}', 'Tooling GRN register'],
    ['../../client/src/components/ToolingProcurement.jsx', 'rows={movements}', 'Tooling Movement Ledger'],
    ['../../client/src/components/ToolingProcurement.jsx', 'rows={history}', 'Tooling Purchase History'],
    ['../../client/src/pages/Tooling.jsx', 'rows={shadeCards}', 'Shade Card register'],
  ];
  for (const [file, anchor, what] of CHRONOLOGICAL) {
    const block = sliceOf(read(file), anchor, 700);
    const sort = (block.match(/defaultSort=\{\{[^}]*\}\}/) || [''])[0];
    assert.match(sort, /dir:\s*'desc'/,
      `${what} must open newest-first — it reads "${sort || 'no defaultSort'}"`);
  }
});
