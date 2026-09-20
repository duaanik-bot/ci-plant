// The run engine's per-member cut. gangCalc (Planning.jsx) counts each member
// through runMemberCut (client/src/lib/cutFit.js), and its cuts must be the
// server's own arithmetic — memberParentSheets: childFit(cuttingParent(m, m's
// board), m).count, which parentSheetsRequired clamps to at least 1 — or the
// run screen quotes one figure and the lock writes another (CI-MRG-0028).
// A co-printed run's lock cuts the board's own sheet: childFit(board, child).
//
// Task 10 (final whole-branch review, 19 Sep 2026): gangCalc measured an
// unsized member on the LEAD's board, counting a sheet that member is never cut
// from. Each member now cuts on its OWN board; unsized is 1:1, as the server
// clamps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childFit, cuttingParent, memberParentSheets, parentSheetsRequired } from './helpers.js';
import { runMemberCut } from '../../client/src/lib/cutFit.js';

// Members as MEMBER_VIEW sends them: the effective parent, its OWN board's sheet
// (sheet_l/_w), the effective child. [name, member, cuts, the sheet cut on]
const FIXTURES = [
  ['SW-544 fossil: 22×28 on the 23×38 board',
    { parent_l: 22, parent_w: 28, sheet_l: 23, sheet_w: 38, child_l: 12.6, child_w: 23 }, 1, { l: 22, w: 28 }],
  ['SW-258 trim: 22×28 on 26×30',
    { parent_l: 22, parent_w: 28, sheet_l: 26, sheet_w: 30, child_l: 14, child_w: 22 }, 2, { l: 22, w: 28 }],
  ['an oversize parent is cut as the board',
    { parent_l: 25, parent_w: 40, sheet_l: 23, sheet_w: 38, child_l: 12.6, child_w: 23 }, 3, { l: 23, w: 38 }],
  ['no parent on file: the board',
    { parent_l: null, parent_w: null, sheet_l: 23, sheet_w: 38, child_l: 12.6, child_w: 23 }, 3, { l: 23, w: 38 }],
  ['an unsized board, no parent: 1:1',
    { parent_l: null, parent_w: null, sheet_l: null, sheet_w: null, child_l: 12.6, child_w: 23 }, 1, null],
  ['an unsized board, a parent on file: the parent (cannot judge, never refused)',
    { parent_l: 22, parent_w: 28, sheet_l: null, sheet_w: null, child_l: 12.6, child_w: 23 }, 1, { l: 22, w: 28 }],
  ['a child the sheet cannot hold: 1:1, not 0',
    { parent_l: null, parent_w: null, sheet_l: 23, sheet_w: 38, child_l: 30, child_w: 40 }, 1, { l: 23, w: 38 }],
  ['no child of its own: 1:1 — the lead\'s child is not its child',
    { parent_l: null, parent_w: null, sheet_l: 23, sheet_w: 38, child_l: null, child_w: null }, 1, { l: 23, w: 38 }],
];
// The run's lead, as gangCalc passes it: off a co-printed run it must change nothing.
const LEAD_CHILD = { child_l: 12.6, child_w: 23 };
const boardOf = m => ({ sheet_l: m.sheet_l, sheet_w: m.sheet_w });
const serverCuts = m => Math.max(1, childFit(cuttingParent(m, boardOf(m)), m).count || 1);

test('each member\'s cuts are the server\'s own: childFit(cuttingParent(m, its board), m), clamped to 1', () => {
  for (const [name, m, cuts] of FIXTURES) {
    const { cpp } = runMemberCut({ member: m, coPrinted: false, childFallback: LEAD_CHILD });
    assert.equal(cpp, serverCuts(m), `${name}: parity`);
    assert.equal(cpp, cuts, `${name}: absolute`);   // both sides wrong together would still agree
  }
});

test('…so the run screen\'s parent sheets equal the server\'s pre-lock estimate (memberParentSheets)', () => {
  for (const [name, m] of FIXTURES) {
    const { cpp } = runMemberCut({ member: m, coPrinted: false, childFallback: LEAD_CHILD });
    assert.equal(parentSheetsRequired(1000, cpp), memberParentSheets({ ...m, sheets_required: 1000 }), name);
  }
});

test('it names the sheet it cut on: the parent on file its board can yield, else its own board', () => {
  for (const [name, m, , sheet] of FIXTURES) {
    if (!sheet) continue;
    const { l, w } = runMemberCut({ member: m, coPrinted: false });
    assert.deepEqual({ l, w }, sheet, name);
  }
});

test('a co-printed member cuts the board\'s own sheet, whatever parent is on file', () => {
  // CI-GANG-0019's FP-157: 20×38 on file, board 23×38, shared child 19×21.
  const m = { parent_l: 20, parent_w: 38, sheet_l: 23, sheet_w: 38, child_l: 19, child_w: 21 };
  const co = runMemberCut({ member: m, coPrinted: true });
  assert.equal(co.cpp, Math.max(1, childFit(boardOf(m), m).count));
  assert.equal(co.cpp, 2);
  assert.deepEqual({ l: co.l, w: co.w }, { l: 23, w: 38 });
  // …the server's co-printed estimate nulls the parent (gangDetail) — the same figure
  assert.equal(parentSheetsRequired(1000, co.cpp), memberParentSheets({ ...m, parent_l: null, parent_w: null, sheets_required: 1000 }));
  // the same member off a co-printed run cuts its 20×38 parent
  assert.equal(runMemberCut({ member: m, coPrinted: false }).cpp, 1);
});

test('an unsized member board is 1:1 — never the lead\'s board, co-printed or not', () => {
  const m = { parent_l: null, parent_w: null, sheet_l: null, sheet_w: null, child_l: 12.6, child_w: 23 };
  const lead = { child_l: 12.6, child_w: 23 };
  assert.equal(runMemberCut({ member: m, coPrinted: false, childFallback: lead }).cpp, 1);
  assert.equal(runMemberCut({ member: m, coPrinted: true, childFallback: lead }).cpp, 1);
});

// Task 10, round 2: off a co-printed run a member cuts its OWN child — the
// server's estimate and lock count one with no child 1:1 (childFit, unsized) —
// so the lead's child never stands in for it there. A co-printed run prints
// ONE shared child, so there the fallback stays.
test('a member without a child of its own counts 1:1 like the server; only a co-printed run lends it the shared child', () => {
  const m = { parent_l: null, parent_w: null, sheet_l: 23, sheet_w: 38, child_l: null, child_w: null };
  assert.equal(runMemberCut({ member: m, coPrinted: false, childFallback: LEAD_CHILD }).cpp, 1);
  assert.equal(runMemberCut({ member: m, coPrinted: false, childFallback: LEAD_CHILD }).cpp, serverCuts(m), 'parity');
  assert.equal(runMemberCut({ member: m, coPrinted: true, childFallback: LEAD_CHILD }).cpp, 3, 'the shared child on the board');
  assert.equal(runMemberCut({ member: m, coPrinted: true }).cpp, 1, 'no child anywhere: 1:1');
  // its own child wins over the fallback
  assert.equal(runMemberCut({ member: { ...m, child_l: 30, child_w: 40 }, coPrinted: true, childFallback: LEAD_CHILD }).cpp, 1);
});

test('null arguments never throw', () => {
  assert.equal(runMemberCut(null).cpp, 1);
  assert.equal(runMemberCut({ member: null, coPrinted: true }).cpp, 1);
});
