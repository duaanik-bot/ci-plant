// The client twins the planning screens count cuts with — so the screen and
// the lock measure ONE parent (CI-MRG-0028, 19 Sep 2026: the run screen said
// "Covered" at 3,550 off the 23×38 board; the lock wrote 10,650 off SW-544's
// 22×28 parent on file). Server spellings are pinned against these in
// parent-loses-cuts.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSheet, cutParentOf, parentLosesCuts, parentFollowsBoard, parentTooBig } from '../../client/src/lib/cutFit.js';

const flat = (p, b) => ({ parentL: p.parent_l, parentW: p.parent_w, boardL: b.sheet_l, boardW: b.sheet_w,
                          childL: p.child_l, childW: p.child_w });
const SW544 = { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23 };
const B399 = { sheet_l: 23, sheet_w: 38 };

test('SW-544: the parent on file cuts once where the board cuts three', () => {
  assert.deepEqual(parentLosesCuts(flat(SW544, B399)),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 1, cuts_board: 3 });
});

test('the other live cases the 19-Sep scan found are named too', () => {
  const gal = parentLosesCuts(flat({ parent_l: 22, parent_w: 28, child_l: 13.75, child_w: 17.75 }, { sheet_l: 31.5, sheet_w: 41.5 }));
  assert.equal(gal.cuts_declared, 2); assert.equal(gal.cuts_board, 5);
  const sw586 = parentLosesCuts(flat({ parent_l: 23, parent_w: 36, child_l: 18, child_w: 25 }, { sheet_l: 25, sheet_w: 36 }));
  assert.equal(sw586.cuts_declared, 1); assert.equal(sw586.cuts_board, 2);
});

test('a trim that keeps every cut is not flagged', () => {
  assert.equal(parentLosesCuts(flat({ parent_l: 22, parent_w: 28, child_l: 14, child_w: 22 }, { sheet_l: 26, sheet_w: 30 })), null);
  assert.equal(parentLosesCuts(flat({ parent_l: 25.6, parent_w: 28, child_l: 14, child_w: 25.6 }, { sheet_l: 26.7, sheet_w: 28 })), null);
});

test('no parent, a blank field, an unsized child, or a parent LARGER than the board is not this rule', () => {
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), parentL: null }), null);
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), parentL: '', parentW: '' }), null);
  assert.equal(parentLosesCuts({ ...flat(SW544, B399), childL: null }), null);
  assert.equal(parentLosesCuts(flat({ ...SW544, parent_l: 25, parent_w: 40 }, B399)), null);
});

test('cutParentOf: the parent on file when the board can yield it, else the board', () => {
  assert.deepEqual(cutParentOf(SW544, B399), { l: 22, w: 28 });
  assert.deepEqual(cutParentOf({ parent_l: null, parent_w: null }, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({}, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({ parent_l: 25, parent_w: 40 }, B399), { l: 23, w: 38 });
});

test('cutParentOf reads form strings: blank is the board (the one deliberate difference from the server), digits are numbers', () => {
  assert.deepEqual(cutParentOf({ parent_l: '', parent_w: '' }, B399), { l: 23, w: 38 });
  assert.deepEqual(cutParentOf({ parent_l: '22', parent_w: '28' }, B399), { l: 22, w: 28 });
});

test('unsized boards: cannot judge, so nothing is flagged and the parent on file stands', () => {
  const noBoard = { sheet_l: null, sheet_w: null };
  assert.equal(parentLosesCuts(flat(SW544, noBoard)), null);
  assert.equal(parentTooBig({ parentL: 22, parentW: 28, boardL: null, boardW: null }), false);
  assert.deepEqual(cutParentOf(SW544, noBoard), { l: 22, w: 28 });
});

test('parentTooBig: a parent the board cannot yield', () => {
  assert.equal(parentTooBig({ parentL: 25, parentW: 40, boardL: 23, boardW: 38 }), true);
  assert.equal(parentTooBig({ parentL: 25.6, parentW: 28, boardL: 23, boardW: 38 }), true);
  assert.equal(parentTooBig({ parentL: 22, parentW: 28, boardL: 23, boardW: 38 }), false);
  assert.equal(parentTooBig({ parentL: 38, parentW: 23, boardL: 23, boardW: 38 }), false);   // same sheet turned round
  assert.equal(parentTooBig({ parentL: '', parentW: '', boardL: 23, boardW: 38 }), false);
});

test('null arguments never throw — a render-time throw would blank the Planning page', () => {
  assert.deepEqual(cutParentOf(null, B399), { l: 23, w: 38 });
  assert.equal(parentLosesCuts(null), null);
  assert.equal(parentTooBig(null), false);
  assert.equal(parentFollowsBoard(null), null);
});

test('sameSheet is orientation-free', () => {
  assert.ok(sameSheet({ l: 22, w: 28 }, { l: 28, w: 22 }));
  assert.ok(!sameSheet({ l: 22, w: 28 }, { l: 23, w: 38 }));
  assert.ok(!sameSheet({ l: '', w: '' }, { l: 23, w: 38 }));
});

test('a board change carries a parent that only copied the old board\'s sheet', () => {
  assert.deepEqual(
    parentFollowsBoard({ parent: { l: '22', w: '28' }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 23, w: 38 } }),
    { l: 23, w: 38 });
});

test('a board change carries a parent the new board cannot yield — the lock would only refuse it', () => {
  assert.deepEqual(
    parentFollowsBoard({ parent: { l: 25.6, w: 28 }, oldBoard: { l: 26.7, w: 28 }, newBoard: { l: 23, w: 38 } }),
    { l: 23, w: 38 });
});

test('…and leaves a genuine trim that still fits, a blank parent, a same-size board and an unsized board alone', () => {
  assert.equal(parentFollowsBoard({ parent: { l: 25.6, w: 28 }, oldBoard: { l: 26.7, w: 28 }, newBoard: { l: 26, w: 40 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: '', w: '' }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 23, w: 38 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: 22, w: 28 }, oldBoard: { l: 22, w: 28 }, newBoard: { l: 28, w: 22 } }), null);
  assert.equal(parentFollowsBoard({ parent: { l: 22, w: 28 }, oldBoard: { l: 22, w: 28 }, newBoard: { l: null, w: null } }), null);
});

test('parentFollowsBoard: a pick that carried, undone, carries back; a trim that fits both stays both ways', () => {
  const A = { l: 22, w: 28 }, B = { l: 23, w: 38 };
  const picked = parentFollowsBoard({ parent: { l: '22', w: '28' }, oldBoard: A, newBoard: B });
  assert.deepEqual(picked, B);
  assert.deepEqual(parentFollowsBoard({ parent: { l: String(picked.l), w: String(picked.w) }, oldBoard: B, newBoard: A }), A);
  assert.equal(parentFollowsBoard({ parent: { l: '20', w: '28' }, oldBoard: A, newBoard: B }), null);
  assert.equal(parentFollowsBoard({ parent: { l: '20', w: '28' }, oldBoard: B, newBoard: A }), null);
});
