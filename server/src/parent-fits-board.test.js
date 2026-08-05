// parentFitsBoard — the rule behind plan-save's "Parent L×W″ cannot be
// trimmed from board l×w″" 409. Born from a live screenshot: a product master
// carrying parent 25×38 against a 23×26.5" board sailed through plan-save and
// rendered "trimmed from board" over a cut no guillotine can make.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentFitsBoard, effectiveParent } from './helpers.js';

test('the screenshot case: a parent larger than the board cannot be trimmed from it', () => {
  assert.equal(parentFitsBoard({ sheet_l: 25, sheet_w: 38 }, { sheet_l: 23, sheet_w: 26.5 }), false);
});

test('orientation does not matter — 25×38 out of a 38×25 board is the same cut turned around', () => {
  assert.equal(parentFitsBoard({ sheet_l: 25, sheet_w: 38 }, { sheet_l: 38, sheet_w: 25 }), true);
  assert.equal(parentFitsBoard({ sheet_l: 38, sheet_w: 25 }, { sheet_l: 25, sheet_w: 38 }), true);
});

test('equal dims are simply no trim, never a refusal', () => {
  assert.equal(parentFitsBoard({ sheet_l: 23, sheet_w: 36 }, { sheet_l: 23, sheet_w: 36 }), true);
});

test('a genuine trim passes; exceeding on either sorted axis fails', () => {
  assert.equal(parentFitsBoard({ sheet_l: 20, sheet_w: 24.5 }, { sheet_l: 20, sheet_w: 38 }), true);
  // Long edge fits, short edge does not: sorted parent [36, 25] vs board [36, 23].
  assert.equal(parentFitsBoard({ sheet_l: 25, sheet_w: 36 }, { sheet_l: 23, sheet_w: 36 }), false);
  // Short edge fits, long edge does not.
  assert.equal(parentFitsBoard({ sheet_l: 22, sheet_w: 40 }, { sheet_l: 23, sheet_w: 36 }), false);
});

test('unsized data on either side cannot be judged and must not refuse', () => {
  assert.equal(parentFitsBoard({ sheet_l: 25, sheet_w: 38 }, {}), true);
  assert.equal(parentFitsBoard({}, { sheet_l: 23, sheet_w: 26.5 }), true);
  assert.equal(parentFitsBoard({ sheet_l: 25, sheet_w: null }, { sheet_l: 23, sheet_w: 26.5 }), true);
  assert.equal(parentFitsBoard(undefined, undefined), true);
});

test('effectiveParent with no override trivially fits its own board', () => {
  const board = { sheet_l: 23, sheet_w: 26.5 };
  assert.equal(parentFitsBoard(effectiveParent({}, board), board), true);
});

test('float-equal dims survive the epsilon — 26.5 is not "larger" than 26.5', () => {
  assert.equal(parentFitsBoard(
    { sheet_l: 26.5, sheet_w: 23 },
    { sheet_l: 23, sheet_w: 26.499999999999996 }), true);
});
