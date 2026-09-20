// LINE_VIEW's sheet_l/_w are the FOLDED parent — COALESCE(job parent, master
// parent, board sheet) — the sheet a plan cuts on, not a board. The single
// planning engine seeded its BOARD from them, and the planning context's
// same-board branch handed them back as `board`, so until a pick the engine's
// "board" was the saved parent itself: SW-544's fossil 22×28 was judged against
// 22×28 and never warned (Task 7, review round 2, 19 Sep 2026). The view now
// carries the board's own sheet as well, and the context returns that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const O = readFileSync(new URL('./routes/orders.js', import.meta.url), 'utf8');
const slice = (a, b) => {
  const i = O.indexOf(a); assert.ok(i >= 0, `missing: ${a}`);
  const j = O.indexOf(b, i); assert.ok(j > i, `missing after ${a}: ${b}`);
  return O.slice(i, j);
};
const view = slice('const LINE_VIEW = `', 'LEFT JOIN tools dc ON');
const context = slice("r.get('/planning/:lineId/context'", "r.get('/planning/:lineId/smart-match'");

test('LINE_VIEW carries the effective board\'s own sheet beside the folded parent', () => {
  assert.match(view, /bm\.sheet_l AS board_sheet_l, bm\.sheet_w AS board_sheet_w,/);
  // bm is the EFFECTIVE board — the one board_name names.
  assert.match(view, /JOIN materials bm ON bm\.id = \$\{EFF_BOARD_ID\}/);
  assert.match(view, /bm\.name AS board_name,/);
  // …and sheet_l/_w keep meaning the folded parent.
  assert.match(view, /COALESCE\(\(ol\.spec_override->>'parent_l'\)::float, p\.parent_l, bm\.sheet_l\) AS sheet_l,/);
  assert.match(view, /COALESCE\(\(ol\.spec_override->>'parent_w'\)::float, p\.parent_w, bm\.sheet_w\) AS sheet_w,/);
});

test('the planning context\'s same-board branch returns the board\'s own sheet, not the folded parent', () => {
  assert.match(context,
    /\? \{ id: matId, name: line\.board_name, sheet_l: line\.board_sheet_l, sheet_w: line\.board_sheet_w \}/);
  assert.doesNotMatch(context, /\? \{ id: matId, name: line\.board_name, sheet_l: line\.sheet_l/);
});

test('…while the mix block\'s planned board stays on the parent the plan cuts on', () => {
  assert.match(context,
    /const plannedBoardRow = \{\s*id: line\.board_material_id, name: line\.board_name,\s*sheet_l: line\.sheet_l, sheet_w: line\.sheet_w,\s*\};/);
});
