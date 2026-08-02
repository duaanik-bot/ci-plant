// The one board vocabulary Planning, Print Planning and the floor share.
// These cases ARE the chips' behaviour: three states that partition a queue,
// ordered so a job reads covered the moment its board is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardStateOf, worstBoardState, claimableQty } from './helpers.js';

test('covered wins over an open PR — a landed GRN flips the job by itself', () => {
  // The whole point of the ordering: procurement receives the board, stock
  // makes material true, and the job leaves the chase list with no re-planning.
  assert.equal(boardStateOf({ material: true, prRaised: true }), 'covered');
  assert.equal(boardStateOf({ material: true, prRaised: false }), 'covered');
});

test('on_order only when uncovered AND something is on order', () => {
  assert.equal(boardStateOf({ material: false, prRaised: true }), 'on_order');
});

test('short is uncovered with nothing bought — the real buy list', () => {
  assert.equal(boardStateOf({ material: false, prRaised: false }), 'short');
});

test('the three states partition a queue — never two, never none', () => {
  const seen = new Set();
  for (const material of [true, false]) {
    for (const prRaised of [true, false]) seen.add(boardStateOf({ material, prRaised }));
  }
  assert.deepEqual([...seen].sort(), ['covered', 'on_order', 'short']);
});

test('a gang takes its weakest member — one missing board stops the run', () => {
  assert.equal(worstBoardState(['covered', 'covered']), 'covered');
  assert.equal(worstBoardState(['covered', 'on_order']), 'on_order');
  assert.equal(worstBoardState(['covered', 'on_order', 'short']), 'short');
  assert.equal(worstBoardState(['on_order', 'short']), 'short');
});

test('an empty set is covered — nothing outstanding is not a shortage', () => {
  assert.equal(worstBoardState([]), 'covered');
  assert.equal(worstBoardState(), 'covered');
});

// claimableQty — the reason one delivery no longer marks every job on that
// board as covered.
const LINE = { id: 7, gang_run_id: null };

test('unclaimed stock is claimable in full', () => {
  assert.equal(claimableQty({ available: 5000, holds: [], line: LINE }), 5000);
});

test("another job's earmark is not this job's board", () => {
  const holds = [{ order_line_id: 9, qty: 2000 }];
  assert.equal(claimableQty({ available: 5000, holds, line: LINE }), 3000);
});

test('my own hold never subtracts from what I can claim', () => {
  const holds = [{ order_line_id: 7, qty: 2000 }];
  assert.equal(claimableQty({ available: 5000, holds, line: LINE }), 5000);
});

test('a gang sibling holds for the whole run, so it counts as mine', () => {
  const member = { id: 7, gang_run_id: 3 };
  const holds = [{ order_line_id: 8, gang_run_id: 3, qty: 2000 },   // sibling — mine
                 { order_line_id: 9, gang_run_id: null, qty: 1000 }]; // stranger — not
  assert.equal(claimableQty({ available: 5000, holds, line: member }), 4000);
});

test('over-held stock floors at zero, never negative', () => {
  const holds = [{ order_line_id: 9, qty: 9000 }];
  assert.equal(claimableQty({ available: 5000, holds, line: LINE }), 0);
});

test('string quantities from pg and missing args are tolerated', () => {
  assert.equal(claimableQty({ available: '5000', holds: [{ order_line_id: 9, qty: '1500' }], line: LINE }), 3500);
  assert.equal(claimableQty({ available: 100, line: LINE }), 100);
  assert.equal(claimableQty({ available: 100, holds: [{ order_line_id: 9, qty: 40 }] }), 60);
});
