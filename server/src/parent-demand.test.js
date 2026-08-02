// memberParentSheets — how many PARENT (mother) sheets a job still needs.
//
// Regression, and an expensive one. Board is stocked, allocated and BOUGHT in
// parent sheets; sheets_required is the CHILD print-sheet count. Until this was
// fixed the unlocked-plan fallbacks returned child sheets under a parent name,
// so a gang whose plan was not yet locked sized its combined requisition in the
// wrong unit:
//
//   CI-GANG-0007, GLYCOMET TRIO 2 (SW-287), 23x38 board, 12.66x22 child = 3 up
//     really needed   575 + 2,000 = 2,575 parent sheets
//     CI-PR-0006 bought              7,525   — the CHILD total, 2.9x over
//
// The comment on the old code called it a "1 child : 1 parent fallback". On a
// 3-up board that is not an approximation, it is a 3x purchase order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberParentSheets } from './helpers.js';

// SW-287 as it stands on live: 23x38 parent, 12.66x22 child → 3 children/parent.
const SW287 = { ups: 4, wastage_pct: 0, sheet_l: 23, sheet_w: 38, child_l: 12.66, child_w: 22 };

test('memberParentSheets: a locked plan is trusted exactly as it stands', () => {
  assert.equal(memberParentSheets({ ...SW287, parent_sheets_required: 575, sheets_required: 1725 }), 575);
  assert.equal(memberParentSheets({ ...SW287, parent_sheets_required: 0, sheets_required: 6000 }), 0,
    'a genuine zero is a locked answer, not a missing one');
});

test('memberParentSheets: child sheets are CONVERTED, never passed through as parent', () => {
  // 6,000 child sheets at 3 children per parent is 2,000 parent sheets.
  assert.equal(memberParentSheets({ ...SW287, parent_sheets_required: null, sheets_required: 6000 }), 2000);
  assert.equal(memberParentSheets({ ...SW287, parent_sheets_required: null, sheets_required: 1725 }), 575);
});

test('memberParentSheets: the live estimate is in parent sheets too', () => {
  // qty 24,000 at 4 ups = 6,000 child sheets = 2,000 parent sheets.
  assert.equal(memberParentSheets({ ...SW287, qty: 24000, parent_sheets_required: null, sheets_required: null }), 2000);
});

test('memberParentSheets: the whole of CI-GANG-0007 sizes to 2,575, not 7,525', () => {
  const members = [
    { ...SW287, qty: 6100, wastage_sheets: 200, parent_sheets_required: null, sheets_required: null },
    { ...SW287, qty: 24000, wastage_sheets: 0, parent_sheets_required: null, sheets_required: null },
  ];
  const total = members.reduce((s, m) => s + memberParentSheets(m), 0);
  assert.ok(total < 3000, `a 3-up gang must not size like a 1-up one — got ${total}`);
  assert.equal(total, 575 + 2000);
});

test('memberParentSheets: an unsized child falls back to 1:1 rather than inventing a ratio', () => {
  // childFit returns count 1 when either dimension is missing, so the estimate
  // degrades to the old behaviour instead of dividing by a guess.
  assert.equal(memberParentSheets({ ups: 4, wastage_pct: 0, qty: 24000,
    parent_sheets_required: null, sheets_required: 6000 }), 6000);
});

test('memberParentSheets: a child too big for the board does not divide by zero', () => {
  const tooBig = { ups: 1, wastage_pct: 0, sheet_l: 20, sheet_w: 20, child_l: 30, child_w: 30 };
  const n = memberParentSheets({ ...tooBig, parent_sheets_required: null, sheets_required: 100 });
  assert.ok(Number.isFinite(n) && n > 0, `must stay a real number, got ${n}`);
});

test('memberParentSheets: a part parent sheet still costs a whole sheet', () => {
  // 7 child sheets at 3 up is 2.33 parents — you buy 3.
  assert.equal(memberParentSheets({ ...SW287, parent_sheets_required: null, sheets_required: 7 }), 3);
});
