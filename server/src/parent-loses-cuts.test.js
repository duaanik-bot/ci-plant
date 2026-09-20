// The server spelling of "the parent on file costs cuts", pinned against the
// client twin the planning screens use. Two spellings of one rule are only
// safe while a test holds them together (cut-sizing.test.js does the same for
// childFit/clientFit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parentLosesCuts, cuttingParent, parentFitsBoard } from './helpers.js';
import { parentLosesCuts as clientLoses, cutParentOf, parentTooBig } from '../../client/src/lib/cutFit.js';

const FIXTURES = [
  ['SW-544',  { parent_l: 22,   parent_w: 28, child_l: 12.6,  child_w: 23 },    { sheet_l: 23,   sheet_w: 38 }],
  ['GAL-072', { parent_l: 22,   parent_w: 28, child_l: 13.75, child_w: 17.75 }, { sheet_l: 31.5, sheet_w: 41.5 }],
  ['SW-586',  { parent_l: 23,   parent_w: 36, child_l: 18,    child_w: 25 },    { sheet_l: 25,   sheet_w: 36 }],
  ['FP-157',  { parent_l: 20,   parent_w: 38, child_l: 19,    child_w: 21 },    { sheet_l: 23,   sheet_w: 38 }],
  ['SW-258',  { parent_l: 22,   parent_w: 28, child_l: 14,    child_w: 22 },    { sheet_l: 26,   sheet_w: 30 }],
  ['SW-097',  { parent_l: 25.6, parent_w: 28, child_l: 14,    child_w: 25.6 },  { sheet_l: 26.7, sheet_w: 28 }],
  ['no parent', { parent_l: null, parent_w: null, child_l: 12.6, child_w: 23 }, { sheet_l: 23,   sheet_w: 38 }],
  ['oversize',  { parent_l: 25,   parent_w: 40, child_l: 12.6, child_w: 23 },   { sheet_l: 23,   sheet_w: 38 }],
  ['one edge over', { parent_l: 25, parent_w: 28, child_l: 12.6, child_w: 23 },  { sheet_l: 23,   sheet_w: 38 }],
  ['unsized board', { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 23 },  { sheet_l: null, sheet_w: null }],
  ['zero cuts',     { parent_l: 22, parent_w: 28, child_l: 12.6, child_w: 30 },  { sheet_l: 23,   sheet_w: 38 }],
];
const flat = (p, b) => ({ parentL: p.parent_l, parentW: p.parent_w, boardL: b.sheet_l, boardW: b.sheet_w,
                          childL: p.child_l, childW: p.child_w });

test('SW-544 on the server: 1 cut on 22×28, 3 on the board', () => {
  assert.deepEqual(parentLosesCuts(FIXTURES[0][1], FIXTURES[0][2]),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 1, cuts_board: 3 });
});

test('server rule and client twin agree on every fixture', () => {
  for (const [code, p, b] of FIXTURES) assert.deepEqual(parentLosesCuts(p, b), clientLoses(flat(p, b)), code);
});

test('cutParentOf agrees with cuttingParent on every fixture', () => {
  for (const [code, p, b] of FIXTURES) {
    const s = cuttingParent(p, b);
    assert.deepEqual(cutParentOf(p, b), { l: +s.sheet_l, w: +s.sheet_w }, code);
  }
});

test('parentTooBig agrees with !parentFitsBoard on every fixture that carries a parent', () => {
  for (const [code, p, b] of FIXTURES) {
    if (p.parent_l == null) continue;
    assert.equal(parentTooBig(flat(p, b)), !parentFitsBoard({ sheet_l: p.parent_l, sheet_w: p.parent_w }, b), code);
  }
});

// Absolute, not just parity: dropping the fits-the-board check on BOTH sides
// would keep the two twins agreeing while both became wrong.
test('a parent the board cannot yield is the 14-Sep refusal, not this rule, on both sides', () => {
  const [, p, b] = FIXTURES.find(([c]) => c === 'one edge over');
  assert.equal(parentLosesCuts(p, b), null);
  assert.equal(clientLoses(flat(p, b)), null);
});

test('a child the parent cannot hold at all reads 0 cuts, not "unsized"', () => {
  const [, p, b] = FIXTURES.find(([c]) => c === 'zero cuts');
  assert.deepEqual(parentLosesCuts(p, b),
    { declared: { l: 22, w: 28 }, board: { l: 23, w: 38 }, cuts_declared: 0, cuts_board: 1 });
});
