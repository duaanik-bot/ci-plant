// runSheetParent is the Run Sheet's ONE rule for "did the parent change?" (the
// lit Lock sheet → button) and "what does Lock sheet → send?" — so the two can
// never disagree, and the flows the review walked through (19 Sep 2026) are
// held here, where node --test can reach them, instead of only in Planning.jsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSheetParent } from '../../client/src/lib/cutFit.js';

// Members as MEMBER_VIEW sends them; the board is Duplex WB 350 23x38 (#399).
const m = (parent_l, parent_w, extra = {}) => ({ parent_l, parent_w, sheet_l: 23, sheet_w: 38, ...extra });
const form = (parent_l, parent_w) => ({ parent_l, parent_w });
const merge = args => runSheetParent({ isMerge: true, coPrinted: false, ...args });
const NONE = { changed: false, error: null, parent: {} };

test('CI-MRG-0028: the one-click sends the board\'s own sheet', () => {
  assert.deepEqual(merge({ form: form('22', '28'), over: { parent_l: '23', parent_w: '38' }, members: [m(22, 28), m(22, 28)] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

test('untouched and agreeing: nothing lights, nothing is sent (a coating-only lock)', () => {
  assert.deepEqual(merge({ form: form('22', '28'), members: [m(22, 28), m(22, 28)] }), NONE);
});

test('a combined run whose orders already cut the same sheet does not light up', () => {
  // lead holds 23×38 as a job-only parent; a later order has no parent on the same 23×38 board
  assert.deepEqual(merge({ form: form('23', '38'), members: [m(23, 38), m(null, null)] }), NONE);
});

test('a later order still on an old parent lights up and gets the run\'s parent', () => {
  assert.deepEqual(merge({ form: form('23', '38'), members: [m(23, 38), m(22, 28)] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

test('both fields blanked over a parent on file: the board\'s own sheet, said explicitly', () => {
  assert.deepEqual(merge({ form: form('', ''), members: [m(22, 28)] }).parent, { parent_l: '23', parent_w: '38' });
});

test('…unless the board has no size: said instead of asked', () => {
  const d = merge({ form: form('', ''), members: [m(22, 28, { sheet_l: null, sheet_w: null })] });
  assert.match(d.error, /no sheet size/);
  assert.deepEqual(d.parent, {});
});

test('a half-typed or non-positive parent is said instead of asked', () => {
  assert.match(merge({ form: form('22', ''), members: [m(22, 28)] }).error, /both length and width/);
  assert.match(merge({ form: form('0', '28'), members: [m(22, 28)] }).error, /greater than zero/);
});

test('a half parent ON FILE, untouched, never blocks an unrelated lock', () => {
  assert.deepEqual(merge({ form: form('22', ''), members: [m(22, null)] }), NONE);
});

test('a half parent on file with a disagreeing order: the board\'s sheet is sent, never half', () => {
  assert.deepEqual(merge({ form: form('22', ''), members: [m(22, null), m(22, 28)] }).parent, { parent_l: '23', parent_w: '38' });
});

test('a typed parent the board cannot yield is sent as typed (the lock refuses it; the screen says so)', () => {
  assert.deepEqual(merge({ form: form('32', '38'), members: [m(null, null)] }).parent, { parent_l: '32', parent_w: '38' });
});

test('the same sheet written differently is no change', () => {
  assert.equal(merge({ form: form('23.0', '38'), members: [m(23, 38)] }).changed, false);
  assert.equal(merge({ form: form('38', '23'), members: [m(23, 38)] }).changed, false);
});

test('a gang compares its lead only; a co-printed run never sends a parent', () => {
  assert.equal(runSheetParent({ form: form('23', '38'), members: [m(23, 38), m(22, 28)], isMerge: false }).changed, false);
  assert.deepEqual(runSheetParent({ form: form('23', '38'), members: [m(22, 28)], coPrinted: true }), NONE);
});

test('null arguments never throw', () => {
  assert.deepEqual(runSheetParent(null), NONE);
  assert.deepEqual(runSheetParent({ form: null, over: null, members: [] }), NONE);
});

test('a parent on file its board cannot yield is compared as written', () => {
  // blanking it sends the board's sheet (the lock would refuse the parent as it stands)
  assert.deepEqual(merge({ form: form('', ''), members: [m(32, 38)] }).parent, { parent_l: '23', parent_w: '38' });
  // a later order carrying one lights the button on a combined run
  assert.equal(merge({ form: form('23', '38'), members: [m(23, 38), m(32, 38)] }).changed, true);
  // untouched on the lead: nothing lights — the red row and its one-click speak for it
  assert.deepEqual(merge({ form: form('32', '38'), members: [m(32, 38)] }), NONE);
});

// ── Review round 3 (19 Sep 2026) ────────────────────────────────────────────
// An unsized board: two cuts nobody can measure are the same cut, so an
// untouched parent never lights the button nor blocks a coating/child lock.
const u = (pl, pw) => ({ parent_l: pl, parent_w: pw, sheet_l: null, sheet_w: null });

test('untouched, unsized board, no parent: nothing lights, nothing blocks (gang)', () => {
  assert.deepEqual(runSheetParent({ form: { parent_l: '', parent_w: '' }, members: [u(null, null)], isMerge: false }), NONE);
});

test('untouched, unsized board, no parent: nothing lights, nothing blocks (merge)', () => {
  assert.deepEqual(runSheetParent({ form: { parent_l: '', parent_w: '' }, members: [u(null, null), u(null, null)], isMerge: true }), NONE);
});

test('untouched, unsized board: a blank lead and an order holding 22×28 never block an unrelated lock', () => {
  assert.deepEqual(merge({ form: form('', ''), members: [u(null, null), u(22, 28)] }), NONE);
});

// The one-click sends the PARENT only, to every order — so it must not stamp
// one board's sheet onto an order whose board is a different size.
test('the one-click refuses a run whose orders are on boards of different sizes', () => {
  const d = merge({ form: form('', ''), over: { parent_l: '25', parent_w: '38' },
                    members: [m(null, null, { sheet_l: 25, sheet_w: 38 }), m(22, 28)] });
  assert.match(d.error, /boards of different sizes/);
  assert.deepEqual(d.parent, {});
});

test('the one-click on two boards of the same size sends the sheet (compared by size, not id)', () => {
  assert.deepEqual(merge({ form: form('22', '28'), over: { parent_l: '23', parent_w: '38' },
                           members: [m(22, 28, { board_material_id: 399 }), m(22, 28, { board_material_id: 402 })] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

// SW-544's child on the 23×38 board: 22×28 cuts 1, the board's sheet cuts 3.
const sw544 = { child_l: 12.6, child_w: 23 };

test('a merge whose LEAD holds the flagged parent does not light untouched (a coating lock must not spread it)', () => {
  assert.deepEqual(merge({ form: form('22', '28'), members: [m(22, 28, sw544), m(23, 38, sw544)] }), NONE);
});

test('retyping the flagged lead\'s own parent as \'22.0\' is no edit: nothing lights, nothing spreads', () => {
  assert.deepEqual(merge({ form: form('22.0', '28'), members: [m(22, 28, sw544), m(23, 38, sw544)] }), NONE);
});

test('…the same run, touched to the board\'s 23×38, lights and sends it', () => {
  assert.deepEqual(merge({ form: form('23', '38'), members: [m(22, 28, sw544), m(23, 38, sw544)] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

// ── Task 10 (final whole-branch review, 19 Sep 2026): the one-click fixes the
// product it is clicked on ────────────────────────────────────────────────────
// A gang of different products. SW-258 keeps a deliberate 22×28 trim on its
// 26×30 board; SW-544's two orders carry the fossil 22×28 on the 23×38 board.
// The red row is SW-544's: its one-click sends ITS board's sheet to ITS orders
// (`scope`, the row's line ids), and nothing else on the run moves.
const sw258 = { id: 811, product_id: 258, parent_l: 22, parent_w: 28, sheet_l: 26, sheet_w: 30, child_l: 14, child_w: 22 };
const sw544a = { id: 812, product_id: 544, parent_l: 22, parent_w: 28, sheet_l: 23, sheet_w: 38, ...sw544 };
const sw544b = { ...sw544a, id: 813 };
const MIXED = [sw258, sw544a, sw544b];
const gangOf = args => runSheetParent({ isMerge: false, coPrinted: false, form: form('22', '28'), members: MIXED, ...args });
const ONE_CLICK_544 = { parent_l: '23', parent_w: '38' };

test('scoped to one product on a mixed gang, the one-click sends that product\'s board sheet', () => {
  assert.deepEqual(gangOf({ over: ONE_CLICK_544, scope: [812, 813] }),
    { changed: true, error: null, parent: { parent_l: '23', parent_w: '38' } });
});

test('the boards-differ guard compares within the scope: an out-of-scope member on another board is ignored', () => {
  assert.equal(gangOf({ over: ONE_CLICK_544, scope: [812] }).error, null);
  // …a scope that spans both boards is still said instead of asked
  const across = gangOf({ over: ONE_CLICK_544, scope: [811, 812] });
  assert.match(across.error, /boards of different sizes/);
  assert.deepEqual(across.parent, {});
});

test('the first scoped member is the lead for the call — a blank one-click sends ITS board\'s sheet', () => {
  // (the client always spells the sheet out; blanks prove whose board it reads)
  assert.deepEqual(gangOf({ over: { parent_l: '', parent_w: '' }, scope: [812, 813] }).parent, { parent_l: '23', parent_w: '38' });
});

test('unscoped is unchanged: the run-wide one-click on a mixed gang is still refused', () => {
  assert.match(gangOf({ over: ONE_CLICK_544 }).error, /boards of different sizes/);
  assert.match(gangOf({ over: ONE_CLICK_544, scope: null }).error, /boards of different sizes/);
});

test('a scope rides the one-click only: a typed parent stays run-wide', () => {
  const members = [m(22, 28, { id: 1 }), m(23, 38, { id: 2 })];
  for (const f of [form('23', '38'), form('22', '28'), form('', '')]) {
    assert.deepEqual(merge({ form: f, members, scope: [2] }), merge({ form: f, members }), JSON.stringify(f));
  }
});

test('a scope naming no member of the run changes nothing', () => {
  assert.deepEqual(gangOf({ over: ONE_CLICK_544, scope: [999] }), NONE);
  assert.deepEqual(gangOf({ over: ONE_CLICK_544, scope: [] }), NONE);
});
