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
