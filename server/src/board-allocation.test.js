import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPosition, lineNeed, openNeed, linePosition, planMove, movableFrom, holdableFor, gangIncoming, gangPosition, splitGangQty } from './board-allocation.js';

// A literal transcription of the formula running in production today
// (server/src/routes/orders.js, planning context). The property test below
// asserts the new engine agrees with it whenever nothing is allocated.
function legacyNet({ lineId, lines, available }) {
  const me = lines.find(l => l.id === lineId);
  const committedOther = lines
    .filter(l => l.id !== lineId)
    .reduce((s, l) => s + Number(l.parent_sheets_required ?? l.sheets_required ?? 0), 0);
  const need = Number(me.parent_sheets_required ?? me.sheets_required ?? 0);
  return available - committedOther - need;
}

const LINES = [
  { id: 1, parent_sheets_required: 41742 },
  { id: 2, parent_sheets_required: 20000 },
  { id: 3, parent_sheets_required: 6000 },
];

test('lineNeed: parent sheets win, child sheets are the fallback', () => {
  assert.equal(lineNeed({ parent_sheets_required: 500, sheets_required: 9000 }), 500);
  assert.equal(lineNeed({ parent_sheets_required: null, sheets_required: 9000 }), 9000);
  assert.equal(lineNeed({}), 0);
});

test('boardPosition: free is what is left after every active hold', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [
      { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
      { order_line_id: 2, qty: 5000, source: 'stock', status: 'released' },
      { order_line_id: 3, qty: 9000, source: 'requisition', status: 'active' },
    ],
  });
  assert.equal(p.available, 26000);
  assert.equal(p.held, 20000, 'released holds and incoming PRs must not count as held stock');
  assert.equal(p.free, 6000);
});

test('openNeed: what a job still has to find, after holds and incoming', () => {
  const line = { id: 1, parent_sheets_required: 41742 };
  const allocations = [
    { order_line_id: 1, qty: 20000, source: 'stock', status: 'active' },
    { order_line_id: 1, qty: 21742, source: 'requisition', status: 'active' },
  ];
  assert.equal(openNeed(line, allocations), 0);
  assert.equal(openNeed(line, []), 41742);
});

test('openNeed: never negative, even if over-held', () => {
  const line = { id: 1, parent_sheets_required: 1000 };
  const allocations = [{ order_line_id: 1, qty: 5000, source: 'stock', status: 'active' }];
  assert.equal(openNeed(line, allocations), 0);
});

// ── The property that makes this safe to ship ────────────────────────────────
test('PROPERTY: with no allocations, the new engine equals the old formula', () => {
  for (const available of [0, 1, 6000, 26000, 41742, 100000]) {
    for (const me of LINES) {
      const others = LINES.filter(l => l.id !== me.id);
      const fresh = linePosition({ line: me, others, available, allocations: [] });
      const old = legacyNet({ lineId: me.id, lines: LINES, available });
      assert.equal(fresh.net, old, `net disagreed for line ${me.id} at available=${available}`);
      assert.equal(fresh.short, Math.max(0, -old), `short disagreed for line ${me.id} at available=${available}`);
    }
  }
});

test('linePosition: a hold covers the holder and pushes everyone else short', () => {
  const allocations = [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }];

  const mine = linePosition({
    line: LINES[0],
    others: LINES.filter(l => l.id !== 1),
    available: 26000,
    allocations,
  });
  assert.equal(mine.held_for_me, 20000);
  assert.equal(mine.my_open_need, 21742);

  const theirs = linePosition({
    line: LINES[1],
    others: LINES.filter(l => l.id !== 2),
    available: 26000,
    allocations,
  });
  assert.equal(theirs.free, 6000, 'the held 20,000 is no longer free');
  assert.equal(theirs.held_for_me, 0);
  assert.equal(theirs.my_open_need, 20000);
});

test('linePosition: only planned/ready lines compete — callers pass the filtered set', () => {
  const p = linePosition({ line: LINES[0], others: [], available: 50000, allocations: [] });
  assert.equal(p.others_open_need, 0);
  assert.equal(p.short, 0);
});

// ── BUG 1 regression: the line being planned must never be guessed at ───────
test('linePosition throws when the line being planned is missing', () => {
  assert.throws(() => linePosition({ line: null, others: [], available: 100 }));
  assert.throws(() => linePosition({ line: undefined, others: [], available: 100 }));
  assert.throws(() => linePosition({ line: {}, others: [], available: 100 }));
});

test('linePosition: a pending line (not in others) still counts its own need', () => {
  const p = linePosition({
    line: { id: 501, parent_sheets_required: 41742 },
    others: [{ id: 2, parent_sheets_required: 20000 }],
    available: 26000,
    allocations: [],
  });
  assert.equal(p.need, 41742);
  assert.equal(p.my_open_need, 41742);
  assert.equal(p.net, -35742);
  assert.equal(p.short, 35742);
});

// ── BUG 2 regression: board held beyond what a job can use stays free ───────
test('boardPosition: a hold beyond the holder\'s need stays free, reported as over_held', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }],
    lines: [{ id: 1, parent_sheets_required: 1000 }],
  });
  assert.equal(p.held, 1000);
  assert.equal(p.over_held, 19000);
  assert.equal(p.free, 25000);
});

test('linePosition: over-held board is available to a competing line, not phantom-short', () => {
  const p = linePosition({
    line: { id: 2, parent_sheets_required: 10000 },
    others: [{ id: 1, parent_sheets_required: 1000 }],
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 20000, source: 'stock', status: 'active' }],
  });
  assert.equal(p.short, 0, 'not 4000 — the 19,000 surplus held for line 1 must free up for line 2');
});

test('boardPosition: an unknown line\'s hold counts at face value (conservative)', () => {
  const p = boardPosition({
    available: 26000,
    allocations: [{ order_line_id: 99, qty: 20000, source: 'stock', status: 'active' }],
    lines: [],
  });
  assert.equal(p.held, 20000);
  assert.equal(p.free, 6000);
  assert.equal(p.over_held, 0);
});

// ── materialId filtering ──────────────────────────────────────────────────
test('linePosition: materialId filters out allocations for a different material', () => {
  const p = linePosition({
    line: { id: 1, parent_sheets_required: 5000 },
    others: [],
    available: 6000,
    allocations: [{ order_line_id: 7, qty: 30000, source: 'stock', status: 'active', material_id: 999 }],
    materialId: 7,
  });
  assert.equal(p.short, 0);
  assert.equal(p.free, 6000);
});

test('linePosition: without materialId, no filtering happens (back-compat)', () => {
  const p = linePosition({
    line: { id: 1, parent_sheets_required: 5000 },
    others: [],
    available: 6000,
    allocations: [{ order_line_id: 7, qty: 30000, source: 'stock', status: 'active', material_id: 999 }],
  });
  assert.equal(p.free, -24000);
});

// ── Move planning ─────────────────────────────────────────────────────────
const MOVE_LINES = [
  { id: 1, parent_sheets_required: 41742, product_name: 'ACEBROBID AC TABLET' },
  { id: 2, parent_sheets_required: 20000, product_name: 'NICOSTAR 10 TAB' },
];
const ACEBROBID_PR = { id: 6, pr_number: 'CI-PR-0006', qty: 41742, status: 'pending', order_line_id: 1 };

function baseMove(over = {}) {
  return {
    materialId: 7,
    fromLineId: 2,
    toLineId: 1,
    qty: 20000,
    available: 26000,
    allocations: [{ order_line_id: 1, qty: 41742, source: 'requisition', status: 'active', requisition_id: 6, material_id: 7 }],
    lines: MOVE_LINES,
    openPrs: [ACEBROBID_PR],
    ...over,
  };
}

test('movableFrom: a job can give up what it holds plus its share of free stock', () => {
  assert.equal(movableFrom({ line: MOVE_LINES[1], available: 26000, allocations: [], lines: MOVE_LINES }), 20000);
});

test('movableFrom: capped by free stock when the board is not actually there', () => {
  assert.equal(movableFrom({ line: MOVE_LINES[1], available: 5000, allocations: [], lines: MOVE_LINES }), 5000);
});

test('holdableFor: a job cannot be held more board than it needs', () => {
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations: [] }), 41742);
});

test('holdableFor: already-ordered board does NOT reduce the cap — cancelling that PR is the point', () => {
  const allocations = [{ order_line_id: 1, qty: 41742, source: 'requisition', status: 'active' }];
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations }), 41742);
});

test('holdableFor: existing holds DO reduce the cap', () => {
  const allocations = [{ order_line_id: 1, qty: 36742, source: 'stock', status: 'active' }];
  assert.equal(holdableFor({ line: MOVE_LINES[0], allocations }), 5000);
});

test('planMove: the happy path spells out all three consequences', () => {
  const plan = planMove(baseMove());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.net_purchase_delta, 0);

  assert.deepEqual(plan.effects.map(e => e.kind), ['hold', 'pr_down', 'pr_new']);
  assert.match(plan.effects[0].text, /ACEBROBID AC TABLET takes 20,000 sheets/);
  assert.match(plan.effects[1].text, /CI-PR-0006 drops 41,742 → 21,742/);
  assert.equal(plan.effects[1].requisition_id, 6);
  assert.equal(plan.effects[1].new_qty, 21742);
  assert.match(plan.effects[2].text, /NICOSTAR 10 TAB gets a new PR for 20,000/);
  assert.equal(plan.effects[2].qty, 20000);
});

test('planMove: a PR reduced to zero is closed, not left at zero', () => {
  const plan = planMove(baseMove({
    qty: 41742,
    available: 60000,
    lines: [MOVE_LINES[0], { id: 2, parent_sheets_required: 41742, product_name: 'NICOSTAR 10 TAB' }],
  }));
  assert.equal(plan.ok, true);
  const down = plan.effects.find(e => e.kind === 'pr_down');
  assert.equal(down.new_qty, 0);
  assert.equal(down.close, true);
  assert.match(down.text, /CI-PR-0006 is fully covered from stock and closes/);
});

test('planMove: conservation holds for every legal quantity', () => {
  for (const qty of [1, 500, 10000, 19999, 20000]) {
    const plan = planMove(baseMove({ qty }));
    assert.equal(plan.ok, true, `qty ${qty} should be legal`);
    assert.equal(plan.net_purchase_delta, 0, `qty ${qty} changed net purchase`);
  }
});

test('planMove: taking more than the source job has is blocked, not clamped', () => {
  const plan = planMove(baseMove({ qty: 25000 }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /NICOSTAR 10 TAB only has 20,000/);
});

test('planMove: holding a job more than it needs is blocked', () => {
  const plan = planMove(baseMove({
    qty: 20000,
    lines: [{ id: 1, parent_sheets_required: 5000, product_name: 'ACEBROBID AC TABLET' }, MOVE_LINES[1]],
    allocations: [],
    openPrs: [{ ...ACEBROBID_PR, qty: 5000 }],
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /ACEBROBID AC TABLET only needs 5,000/);
});

test('planMove: zero, negative and same-job moves are rejected', () => {
  assert.match(planMove(baseMove({ qty: 0 })).blockers[0], /greater than zero/);
  assert.match(planMove(baseMove({ qty: -5 })).blockers[0], /greater than zero/);
  assert.match(planMove(baseMove({ toLineId: 2 })).blockers[0], /same job/);
});

test('planMove: a missing line is a blocker, never a guess', () => {
  const p = planMove(baseMove({ fromLineId: 999 }));
  assert.equal(p.ok, false);
  assert.match(p.blockers[0], /no longer planned/);
});

test('planMove: a gang member cannot be moved', () => {
  const plan = planMove(baseMove({
    lines: [MOVE_LINES[0], { ...MOVE_LINES[1], gang_run_id: 12, gang_number: 'CI-G-0012' }],
  }));
  assert.equal(plan.ok, false);
  assert.match(plan.blockers[0], /CI-G-0012/);
});

test('planMove: oldest PR is reduced first when the target has several', () => {
  const plan = planMove(baseMove({
    qty: 20000,
    openPrs: [
      { id: 6, pr_number: 'CI-PR-0006', qty: 15000, status: 'pending', order_line_id: 1 },
      { id: 9, pr_number: 'CI-PR-0009', qty: 26742, status: 'approved', order_line_id: 1 },
    ],
  }));
  assert.equal(plan.ok, true);
  const downs = plan.effects.filter(e => e.kind === 'pr_down');
  assert.equal(downs.length, 2);
  assert.equal(downs[0].requisition_id, 6);
  assert.equal(downs[0].new_qty, 0);
  assert.equal(downs[0].close, true);
  assert.equal(downs[1].requisition_id, 9);
  assert.equal(downs[1].new_qty, 21742);
  assert.equal(plan.net_purchase_delta, 0);
});

// ── Gangs ────────────────────────────────────────────────────────────────
// Regression: CI-GANG-0007 collected FOUR identical 7,525-sheet requisitions
// (CI-PR-0006..0009) in 67 seconds. Nothing about a raised PR moved the gang's
// "Short" figure, so the red Raise-ONE-PR banner was byte-identical after a
// successful raise and the planner clicked it again. These tests pin the two
// halves of that: board on order for the gang is coverage, and the combined
// PR reaches every member so each member's own view nets it off too.

test('gangIncoming: board on order for ANY member is coverage for the run', () => {
  const allocations = [
    { order_line_id: 1, qty: 4000, source: 'requisition', status: 'active', material_id: 329 },
    { order_line_id: 2, qty: 3525, source: 'requisition', status: 'active', material_id: 329 },
    { order_line_id: 9, qty: 9999, source: 'requisition', status: 'active', material_id: 329 },
    { order_line_id: 1, qty: 5000, source: 'stock', status: 'active', material_id: 329 },
    { order_line_id: 2, qty: 1000, source: 'requisition', status: 'released', material_id: 329 },
    { order_line_id: 1, qty: 2000, source: 'requisition', status: 'active', material_id: 77 },
  ];
  assert.equal(gangIncoming(allocations, [1, 2], 329), 7525,
    'only ACTIVE requisition holds, only this gang\'s members, only this board');
  assert.equal(gangIncoming(allocations, [], 329), 0);
});

test('gangPosition: a raised PR pulls the gang out of shortage', () => {
  const before = gangPosition({
    needed: 7525, committedOther: 0, available: 0, memberIds: [1, 2], materialId: 329,
  });
  assert.equal(before.short, 7525);
  assert.equal(before.incoming, 0);

  const after = gangPosition({
    needed: 7525, committedOther: 0, available: 0, memberIds: [1, 2], materialId: 329,
    allocations: [{ order_line_id: 1, qty: 7525, source: 'requisition', status: 'active', material_id: 329 }],
  });
  assert.equal(after.incoming, 7525);
  assert.equal(after.short, 0, 'the second click must not find a shortage to raise against');
});

test('gangPosition: partial cover leaves only the balance short', () => {
  const p = gangPosition({
    needed: 10000, committedOther: 2000, available: 1000, memberIds: [1, 2], materialId: 238,
    allocations: [{ order_line_id: 2, qty: 4000, source: 'requisition', status: 'active', material_id: 238 }],
  });
  assert.equal(p.short, 7000);
});

test('gangPosition: with nothing allocated it reduces to the old formula', () => {
  const p = gangPosition({ needed: 7525, committedOther: 300, available: 500, memberIds: [1, 2] });
  assert.equal(p.short, Math.max(0, 7525 + 300 - 500));
  assert.equal(p.incoming, 0);
});

test('splitGangQty: the combined PR reaches every member, and the parts sum to the whole', () => {
  const parts = splitGangQty(7525, [
    { id: 1, parent_sheets_required: 5000 },
    { id: 2, parent_sheets_required: 2500 },
  ]);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 7525, 'no sheet may be invented or lost');
  assert.deepEqual(parts.map(p => p.order_line_id), [1, 2]);
  assert.ok(parts[0].qty > parts[1].qty, 'the bigger job carries the bigger share');
});

test('splitGangQty: a rounding remainder lands on the largest member, never nowhere', () => {
  const parts = splitGangQty(100, [
    { id: 1, parent_sheets_required: 1 },
    { id: 2, parent_sheets_required: 1 },
    { id: 3, parent_sheets_required: 1 },
  ]);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 100);
  assert.equal(parts.length, 3);
});

test('splitGangQty: members with no stated need still share the board equally', () => {
  const parts = splitGangQty(9, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 9);
  assert.deepEqual(parts.map(p => p.qty), [3, 3, 3]);
});
