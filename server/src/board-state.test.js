// The one board vocabulary Planning, Print Planning and the floor share.
// These cases ARE the chips' behaviour: three states that partition a queue,
// ordered so a job reads covered the moment its board is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardStateOf, worstBoardState, claimableQty, stampBoardState } from './helpers.js';

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

// ── stampBoardState ─────────────────────────────────────────────────────────
// The rule four endpoints now share (Print Planning, Job Cards, the cutting
// queue, and Planning's own queue through the same helpers). A fake `qc`
// stands in for the two batched queries so the logic is testable without a DB:
// openPrLineIds and boardDrawnLineIds both return `SELECT ol.id` shapes, and
// they are told apart by the text of the SQL.
const fakeQc = ({ onOrder = [], drawn = [] }) => async sql =>
  (sql.includes('stock_movements') ? drawn : onOrder).map(id => ({ id }));

const stamp = (rows, { onOrder = [], drawn = [], gates = {} } = {}) =>
  stampBoardState(rows, {
    lineIdOf: r => r.line,
    gangIdOf: r => r.gang ?? null,
    gatesOf: r => gates[r.line] ?? { material: false },
    qc: fakeQc({ onOrder, drawn }),
  });

test('stock decides first, then an open PR, then short', async () => {
  const rows = [{ line: 1 }, { line: 2 }, { line: 3 }];
  await stamp(rows, { onOrder: [2], gates: { 1: { material: true } } });
  assert.deepEqual(rows.map(r => r.board_state), ['covered', 'on_order', 'short']);
});

test('a job that already DREW its board is covered whatever the shelf says', async () => {
  const rows = [{ line: 4 }];
  await stamp(rows, { drawn: [4], gates: { 4: { material: false } } });
  assert.equal(rows[0].board_state, 'covered');
});

test('drawn beats an open PR too — the sheets are already on the machine', async () => {
  const rows = [{ line: 5 }];
  await stamp(rows, { drawn: [5], onOrder: [5] });
  assert.equal(rows[0].board_state, 'covered');
});

test('every member of a gang wears the run’s WEAKEST verdict', async () => {
  const rows = [{ line: 1, gang: 9 }, { line: 2, gang: 9 }, { line: 3, gang: 9 }];
  // 1 covered, 2 on_order, 3 short → the whole run reads short.
  await stamp(rows, { onOrder: [2], gates: { 1: { material: true } } });
  assert.deepEqual(rows.map(r => r.board_state), ['short', 'short', 'short']);
});

test('a gang with no short member settles on its worst, not on covered', async () => {
  const rows = [{ line: 1, gang: 9 }, { line: 2, gang: 9 }];
  await stamp(rows, { onOrder: [2], gates: { 1: { material: true } } });
  assert.deepEqual(rows.map(r => r.board_state), ['on_order', 'on_order']);
});

test('a plain job is never dragged down by someone else’s gang', async () => {
  const rows = [{ line: 1, gang: 9 }, { line: 2, gang: 9 }, { line: 3 }];
  await stamp(rows, { gates: { 1: { material: true }, 3: { material: true } } });
  assert.deepEqual(rows.map(r => r.board_state), ['short', 'short', 'covered']);
});

test('a row with no gates is left UNSTAMPED rather than guessed at', async () => {
  const rows = [{ line: 1 }, { line: 2 }];
  await stampBoardState(rows, {
    lineIdOf: r => r.line,
    gatesOf: r => (r.line === 1 ? { material: true } : null),
    qc: fakeQc({}),
  });
  assert.equal(rows[0].board_state, 'covered');
  assert.equal(rows[1].board_state, undefined);
});

test('rows with no order line at all short-circuit without a query', async () => {
  const rows = [{ line: null }];
  let called = false;
  await stampBoardState(rows, {
    lineIdOf: r => r.line,
    gatesOf: () => ({ material: true }),
    qc: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.equal(rows[0].board_state, undefined);
});
