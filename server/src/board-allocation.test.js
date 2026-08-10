import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardPosition, lineNeed, openNeed, linePosition, planMove, movableFrom, holdableFor, gangIncoming, gangPosition, splitGangQty, mirrorTargets, gangPrShares, stockSurplus, claimsByBoard, canGiveUpBoard, issuableFor, stockHoldBudget } from './board-allocation.js';

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

// ── Board already DRAWN — the sheets are on the floor ────────────────────────
// boardDrawnLineIds() has always said "a job mid-production is not a job to
// chase board for", but only the status chips listened; this arithmetic — which
// decides the Short banner and the PR quantity — kept counting the full
// requirement as still-outstanding. Live incident, line 208 / CI-JC-0035:
// 600 parent sheets were consumed from batch OPEN-20260727 on 08-03 ("Issue to
// CI-JC-0035"), the job cut AND printed, and the 500 left on the shelf is what
// remains AFTER that draw. The engine still read 500 - 600 = short 100 and
// offered to buy 100 sheets the plant already has on the floor.
test('openNeed: a line whose board is drawn has nothing left to find', () => {
  const line = { id: 208, parent_sheets_required: 600, board_drawn: true };
  assert.equal(openNeed(line, []), 0);
  // Unflagged lines are untouched — the old behaviour is the default.
  assert.equal(openNeed({ id: 208, parent_sheets_required: 600 }, []), 600);
});

test('linePosition: a drawn job invents no shortage against the board it left behind', () => {
  const line = { id: 208, parent_sheets_required: 600, board_drawn: true };
  const p = linePosition({ line, others: [], available: 500, allocations: [] });
  assert.equal(p.my_open_need, 0, 'board already issued — nothing outstanding');
  assert.equal(p.short, 0, 'must NOT ask the plant to buy board it already cut');
  assert.equal(p.net, 500, 'the 500 left on the shelf is free, not overdrawn');
  assert.equal(p.need, 600, 'the requirement itself still reads 600 — only the OPEN need is nil');
});

test('linePosition: a drawn neighbour stops eating everyone else supply', () => {
  const me = { id: 1, parent_sheets_required: 400 };
  const drawn = { id: 208, parent_sheets_required: 600, board_drawn: true };
  const p = linePosition({ line: me, others: [drawn], available: 500, allocations: [] });
  assert.equal(p.others_open_need, 0);
  assert.equal(p.short, 0, 'a job already printing must not push a real job short');
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

// The invariant is NOT "the parts sum to the order" — it is "the parts plus the
// stock surplus sum to the order". A job takes what it needs and not one sheet
// more; whatever the buyer ordered on top of that belongs to stock.
const SPLIT_MEMBERS = [
  { id: 1, parent_sheets_required: 5000 },
  { id: 2, parent_sheets_required: 2500 },
];

test('splitGangQty: an order that exactly meets the need reaches every member', () => {
  const parts = splitGangQty(7500, SPLIT_MEMBERS);
  assert.deepEqual(parts, [{ order_line_id: 1, qty: 5000 }, { order_line_id: 2, qty: 2500 }]);
  assert.equal(stockSurplus(7500, SPLIT_MEMBERS), 0, 'nothing is left over');
});

test('splitGangQty: parts + surplus always account for the whole order', () => {
  for (const qty of [0, 1, 3749, 7499, 7500, 7501, 20000]) {
    const booked = splitGangQty(qty, SPLIT_MEMBERS).reduce((s, p) => s + p.qty, 0);
    assert.equal(booked + stockSurplus(qty, SPLIT_MEMBERS), qty,
      `no sheet may be invented or lost at qty ${qty}`);
  }
});

// The bug this replaces: CI-PR-0022 was raised for 150 sheets (42 + 108) and the
// buyer edited it up to 1,600. The old proration rewrote the members to 457 and
// 1,143 and booked all 1,600 against two jobs that between them needed 150.
test('splitGangQty: buying over the need caps each job and does NOT inflate its share', () => {
  const members = [
    { id: 1, parent_sheets_required: 42 },
    { id: 2, parent_sheets_required: 108 },
  ];
  const parts = splitGangQty(1600, members);
  assert.deepEqual(parts.map(p => p.qty), [42, 108], 'a job needs what it needs');
  assert.equal(stockSurplus(1600, members), 1450, 'the rest was bought for stock');
});

test('splitGangQty: under-buying still prorates, so no single job takes the whole shortfall', () => {
  const parts = splitGangQty(3750, SPLIT_MEMBERS);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 3750, 'a short buy is fully committed');
  assert.equal(stockSurplus(3750, SPLIT_MEMBERS), 0, 'a short buy leaves nothing for stock');
  assert.ok(parts[0].qty > parts[1].qty, 'the bigger job carries the bigger share');
});

test('splitGangQty: a rounding remainder lands on the largest member, never nowhere', () => {
  const members = [
    { id: 1, parent_sheets_required: 10 },
    { id: 2, parent_sheets_required: 10 },
    { id: 3, parent_sheets_required: 10 },
  ];
  const parts = splitGangQty(20, members);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 20);
  assert.equal(parts.length, 3);
});

// An unlocked gang states no sheets at all. There is nothing to cap against, so
// capping would book zero and every member would read short against board that
// was genuinely bought for it. Unmeasurable need keeps the old equal split.
test('splitGangQty: members with no stated need still share the board equally', () => {
  const parts = splitGangQty(9, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(parts.reduce((s, p) => s + p.qty, 0), 9);
  assert.deepEqual(parts.map(p => p.qty), [3, 3, 3]);
  assert.equal(stockSurplus(9, [{ id: 1 }, { id: 2 }, { id: 3 }]), 0,
    'a need we cannot measure is not surplus');
});

test('stockSurplus: a requisition naming no job at all is bought entirely for stock', () => {
  assert.equal(stockSurplus(500, []), 500);
});

// Regression: CI-PR-0006 bought Duplex WB 300 GSM for CI-GANG-0007. The planner
// then re-anchored that gang to 296 GSM and ran it from stock. Mirroring the PR
// across the members on the strength of its own material_id books incoming board
// against jobs that no longer use it — a phantom that inflates the old board and
// starves the new one. Only lines actually ON this board may be mirrored.

const GANG_ON_363 = [
  { id: 182, parent_sheets_required: 575, eff_board: 363 },
  { id: 203, parent_sheets_required: 2000, eff_board: 363 },
];

test('mirrorTargets: a gang still on the PR board is split across every member', () => {
  const rows = mirrorTargets({ materialId: 329, qty: 7500 }, [
    { id: 182, parent_sheets_required: 5000, eff_board: 329 },
    { id: 203, parent_sheets_required: 2500, eff_board: 329 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + r.qty, 0), 7500);
});

// The ledger obeys the same cap as the panel: over-buying must not lock the
// surplus to a job. Board bought for stock has to reach the warehouse FREE,
// which is the whole point — an allocation row is what makes it unfree.
test('mirrorTargets: the surplus over the need is booked against no order line', () => {
  const rows = mirrorTargets({ materialId: 329, qty: 20000 }, [
    { id: 182, parent_sheets_required: 5000, eff_board: 329 },
    { id: 203, parent_sheets_required: 2500, eff_board: 329 },
  ]);
  assert.deepEqual(rows, [{ order_line_id: 182, qty: 5000 }, { order_line_id: 203, qty: 2500 }],
    'only the stated need may be locked to a job');
});

test('mirrorTargets: a lone job is capped at its need too, not handed the whole order', () => {
  assert.deepEqual(
    mirrorTargets({ materialId: 290, qty: 2000 }, [{ id: 155, parent_sheets_required: 802, eff_board: 290 }]),
    [{ order_line_id: 155, qty: 802 }],
    'the single-job path was the uncapped one — PR-0018 through 0021 on live');
});

test('mirrorTargets: a gang that has MOVED board gets no mirror at all', () => {
  assert.deepEqual(mirrorTargets({ materialId: 329, qty: 7525 }, GANG_ON_363), [],
    'booking board 329 against jobs running 363 is the phantom-shortage bug');
});

test('mirrorTargets: a lone line on the PR board still books the whole quantity', () => {
  assert.deepEqual(mirrorTargets({ materialId: 290, qty: 2100 }, [{ id: 155, eff_board: 290 }]),
    [{ order_line_id: 155, qty: 2100 }]);
});

test('mirrorTargets: only the members actually on this board share it', () => {
  const rows = mirrorTargets({ materialId: 329, qty: 1000 }, [
    { id: 1, parent_sheets_required: 100, eff_board: 329 },
    { id: 2, parent_sheets_required: 100, eff_board: 363 },
  ]);
  assert.deepEqual(rows, [{ order_line_id: 1, qty: 100 }],
    'the member that left the board must not be charged for it, and the one that '
    + 'stayed is charged its need — the other 900 sheets were bought for stock');
});

test('mirrorTargets: nothing in scope means nothing booked', () => {
  assert.deepEqual(mirrorTargets({ materialId: 329, qty: 500 }, []), []);
});

// The buyer approving a gang's combined PR must see WHICH jobs it buys for.
// The sheet column is the same split that books the allocations, so what the
// modal shows and what the ledger holds cannot drift.

test('gangPrShares: each job carries its share, and the shares sum to the PR', () => {
  const rows = gangPrShares(2575, [
    { id: 182, product_name: 'GLYCOMET TRIO 2', parent_sheets_required: 575 },
    { id: 203, product_name: 'GLYCOMET TRIO 1', parent_sheets_required: 2000 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + r.sheets, 0), 2575);
  assert.ok(rows[1].sheets > rows[0].sheets, 'the bigger job carries the bigger share');
  assert.equal(rows[0].product_name, 'GLYCOMET TRIO 2', 'the member row is carried through, not just the number');
});

// What the buyer reads must be what the ledger books. If the panel still showed
// a prorated 1,681/5,844 while board_allocations booked 575/2,000, the PR would
// justify itself with numbers no job ever asked for.
test('gangPrShares: an over-bought PR shows each job its real need, not a prorated one', () => {
  const members = [
    { id: 182, parent_sheets_required: 575 },
    { id: 203, parent_sheets_required: 2000 },
  ];
  assert.deepEqual(gangPrShares(7525, members).map(r => r.sheets), [575, 2000]);
  assert.equal(stockSurplus(7525, members), 4950);
});

test('gangPrShares: an unlocked gang with no stated need shares equally', () => {
  const rows = gangPrShares(7525, [{ id: 182 }, { id: 203 }]);
  assert.deepEqual(rows.map(r => r.sheets), [3763, 3762]);
  assert.equal(rows.reduce((s, r) => s + r.sheets, 0), 7525);
});

test('gangPrShares: no members means no table', () => {
  assert.deepEqual(gangPrShares(7525, []), []);
});

test('gangPrShares: a lone job carries the whole requisition when that is what it needs', () => {
  const rows = gangPrShares(2100, [
    { id: 155, product_name: 'BRUTAFLAM-CGII', parent_sheets_required: 2100 },
  ]);
  assert.deepEqual(rows.map(r => r.sheets), [2100],
    'a single-job PR buys entirely for that job — the panel must tie out to the board row above it');
  assert.equal(rows[0].product_name, 'BRUTAFLAM-CGII');
  assert.equal(stockSurplus(2100, rows), 0);
});

test('gangPrShares: a lone job with no stated need still carries the whole requisition', () => {
  assert.deepEqual(gangPrShares(409, [{ id: 9 }]).map(r => r.sheets), [409]);
});

// ── claimsByBoard — who is holding a board, and how much ────────────────────
//
// The live case this was written from. OYOPEG needed 1,225 parent sheets of
// Saffire 340 GSM 20x38 and Smart Match offered it as "4,850 free — covers
// plan". 4,850 was the shelf; 3,650 of it was owed to two OMEZYME jobs that had
// been pushed to job cards but had NOT yet drawn their board, so the committed
// query — filtered to planned/ready — reported the board as entirely free.
const OMEZYME = [
  { id: 156, board_material_id: 222, status: 'in_production', parent_sheets_required: 1500,
    product_name: 'OMEZYME SYRUP 200ML INNER CARTON', customer_name: 'Swiss Garnier', po_number: 'PMP/01476' },
  { id: 162, board_material_id: 222, status: 'in_production', parent_sheets_required: 3750,
    product_name: 'OMEZYME SYRUP 200ML INNER CARTON', customer_name: 'Swiss Garnier', po_number: 'PMP/01565' },
];
const ON_ORDER = [
  { material_id: 222, order_line_id: 156, source: 'requisition', qty: 457, status: 'active' },
  { material_id: 222, order_line_id: 162, source: 'requisition', qty: 1143, status: 'active' },
];

// COMMITTED is measured against the SHELF, so board that is on order but has
// not landed cannot reduce it. Netting it off reported 3,650 committed and
// 1,200 "free" out of 4,850 — the state the warehouse will be in AFTER the
// delivery, presented as though it were true now. Until those sheets arrive the
// two jobs are owed all 5,250 and every sheet on the shelf is spoken for.
// When the PR does land it lands in `available` too, so available − committed
// converges on the same 1,200 without the figure ever having lied.
test('claimsByBoard: committed is the whole claim on the shelf, not what is left to source', () => {
  const claims = claimsByBoard({ lines: OMEZYME, allocations: ON_ORDER });
  const board = claims.get(222);
  assert.equal(board.committed, 5250, 'both jobs, in full — on-order board is not on the shelf');
  assert.equal(board.on_order, 1600, 'carried separately, as the reason the shortfall is covered');
  assert.equal(4850 - board.committed, -400, 'the shelf is 400 short, not 1,200 free');
  assert.ok(4850 - board.committed < 1225, 'so the board does NOT cover a 1,225-sheet plan');
});

test('claimsByBoard: once the on-order board lands, free settles at the same figure', () => {
  // The delivery adds 1,600 to `available`; committed never moved.
  const board = claimsByBoard({ lines: OMEZYME, allocations: ON_ORDER }).get(222);
  assert.equal((4850 + 1600) - board.committed, 1200);
});

test('claimsByBoard: the claim names the product, biggest first', () => {
  const { claimants } = claimsByBoard({ lines: OMEZYME, allocations: ON_ORDER }).get(222);
  assert.deepEqual(claimants.map(c => c.need), [3750, 1500]);
  assert.deepEqual(claimants.map(c => c.open_need), [2607, 1043],
    'still-to-source stays on the claimant, for whoever needs that question answered');
  assert.equal(claimants[0].order_line_id, 162);
  assert.match(claimants[0].product_name, /OMEZYME/);
  assert.equal(claimants[0].po_number, 'PMP/01565');
  assert.equal(claimants[0].incoming, 1143, 'what is already bought for it, shown beside the claim');
});

test('claimsByBoard: board already DRAWN has left the shelf and stops competing', () => {
  const claims = claimsByBoard({
    lines: OMEZYME.map(l => ({ ...l, board_drawn: true })),
    allocations: ON_ORDER,
  });
  assert.equal(claims.has(222), false,
    'sheets issued at cutting came out of `available` already — counting them again bills them twice');
});

// A job whose PR covers it in full has nothing LEFT TO BUY, but it has not
// stopped needing sheets: until that PR is received it still takes its 1,500
// off the shelf, and dropping it made the board read free to a planner who
// would then plan over it.
test('claimsByBoard: a job fully covered by its PR still claims the shelf until the board lands', () => {
  const board = claimsByBoard({
    lines: [OMEZYME[0]],
    allocations: [{ material_id: 222, order_line_id: 156, source: 'requisition', qty: 1500, status: 'active' }],
  }).get(222);
  assert.equal(board.committed, 1500, 'the shelf still owes it');
  assert.equal(board.on_order, 1500);
  assert.equal(board.claimants[0].open_need, 0, 'but there is nothing further to buy for it');
});

test('claimsByBoard: allocations on OTHER boards never net a claim down', () => {
  const claims = claimsByBoard({
    lines: [OMEZYME[0]],
    allocations: [{ material_id: 999, order_line_id: 156, source: 'requisition', qty: 1500, status: 'active' }],
  });
  assert.equal(claims.get(222).committed, 1500);
});

test('claimsByBoard: nothing live means nothing committed', () => {
  assert.equal(claimsByBoard({ lines: [], allocations: [] }).size, 0);
});

test('stockHoldBudget: covered jobs plus draft holds reduce what another mix may take', () => {
  const budget = stockHoldBudget({
    materialId: 69,
    available: 800,
    claimLines: [
      { id: 188, board_material_id: 69, status: 'in_production', parent_sheets_required: 484,
        product_name: 'NICOROZ 5 INNER CARTON SALE-R1', po_number: 'PMP/01683' },
    ],
    allocations: [
      { material_id: 69, order_line_id: 250, source: 'stock', qty: 150, status: 'active' },
      { material_id: 69, order_line_id: 272, source: 'stock', qty: 246, status: 'active' },
    ],
    ownerLineIds: [272],
  });

  assert.equal(budget.committed, 484, 'the in-production job keeps first claim on the shelf');
  assert.equal(budget.held, 150, 'another pending draft hold also fences stock');
  assert.equal(budget.free, 166, '800 - 484 - 150, so line 272 cannot newly save 246');
});

test('stockHoldBudget: a holder can resave its own existing hold without double-counting it', () => {
  const budget = stockHoldBudget({
    materialId: 69,
    available: 800,
    claimLines: [
      { id: 188, board_material_id: 69, status: 'in_production', parent_sheets_required: 484 },
    ],
    allocations: [
      { material_id: 69, order_line_id: 188, source: 'stock', qty: 300, status: 'active' },
      { material_id: 69, order_line_id: 250, source: 'stock', qty: 150, status: 'active' },
    ],
    ownerLineIds: [250],
  });

  assert.equal(budget.committed, 484, 'a live claimant with its own hold is counted once, by need');
  assert.equal(budget.held, 0, 'the owner line can keep/resave its own 150-sheet hold');
  assert.equal(budget.free, 316);
});

// ── stock_booking = 'fresh_pr' — the plan that refuses the shelf ────────────
//
// The planner's choice: 500 sheets sit free but this job's 2,000 will be
// bought FRESH, leaving the 500 for another product. The claim is fenced to
// the job's own incoming PR — never simply dropped — so the arithmetic
// self-heals at both ends: before the PR exists the full need still presses
// (an opt-out can never hide demand), and when the PR lands the mirror is
// consumed at the same moment the sheets enter `available`, so the claim
// returns and covers the landed board.
const FRESH = { id: 300, board_material_id: 222, status: 'planned', parent_sheets_required: 2000,
  stock_booking: 'fresh_pr', product_name: 'NICODEMUS 5' };

test('fresh_pr: before its PR is raised, the line still claims the shelf in full', () => {
  const board = claimsByBoard({ lines: [FRESH], allocations: [] }).get(222);
  assert.equal(board.committed, 2000, 'the fence is its own PR — no PR, no fence');
});

test('fresh_pr: the full-quantity PR releases the shelf entirely', () => {
  const board = claimsByBoard({
    lines: [FRESH],
    allocations: [{ material_id: 222, order_line_id: 300, source: 'requisition', qty: 2000, status: 'active' }],
  }).get(222);
  assert.equal(board.committed, 0, 'the shelf owes this job nothing — its board is bought');
  assert.equal(board.on_order, 2000);
  assert.equal(board.claimants[0].stock_booking, 'fresh_pr', 'the claimant row says why');
});

test('fresh_pr: a partial PR fences only what it covers', () => {
  const board = claimsByBoard({
    lines: [FRESH],
    allocations: [{ material_id: 222, order_line_id: 300, source: 'requisition', qty: 1500, status: 'active' }],
  }).get(222);
  assert.equal(board.committed, 500, 'the un-bought remainder still presses on the shelf');
});

test('fresh_pr: as the PR lands, available rises exactly as the claim returns', () => {
  // 500 on the shelf. The job's 2,000-sheet PR is live: free = 500 − 0.
  const before = claimsByBoard({
    lines: [FRESH],
    allocations: [{ material_id: 222, order_line_id: 300, source: 'requisition', qty: 2000, status: 'active' }],
  }).get(222);
  assert.equal(500 - before.committed, 500, 'the 500 stays free for other products');
  // GRN accepts 2,000: the mirror is consumed, available is 2,500.
  const after = claimsByBoard({ lines: [FRESH], allocations: [] }).get(222);
  assert.equal(2500 - after.committed, 500, 'free settles at the same 500 — the landed board is spoken for');
});

test('fresh_pr: a mirror above need cannot drive committed negative', () => {
  const board = claimsByBoard({
    lines: [FRESH],
    allocations: [{ material_id: 222, order_line_id: 300, source: 'requisition', qty: 2600, status: 'active' }],
  }).get(222);
  assert.equal(board.committed, 0, 'clamped — a hand-edited PR must not mint free stock');
});

test('fresh_pr: a booked line beside it keeps the historic full claim', () => {
  const board = claimsByBoard({
    lines: [FRESH, OMEZYME[0]],
    allocations: [
      { material_id: 222, order_line_id: 300, source: 'requisition', qty: 2000, status: 'active' },
      { material_id: 222, order_line_id: 156, source: 'requisition', qty: 1500, status: 'active' },
    ],
  }).get(222);
  assert.equal(board.committed, 1500, "OMEZYME books the shelf, so its PR does not net it; NICODEMUS's does");
});

test('gangPosition: a fresh_pr run buys its full need net of its own PR and holds, shelf ignored', () => {
  const base = { needed: 4000, committedOther: 900, available: 3000, memberIds: [1, 2], materialId: 7 };
  const booked = gangPosition({ ...base, allocations: [] });
  assert.equal(booked.short, 1900, 'the booked run nets the shelf as before');
  const fresh = gangPosition({ ...base, allocations: [], stockBooking: 'fresh_pr' });
  assert.equal(fresh.short, 4000, 'the fresh_pr run wants its whole pile bought');
  const freshCovered = gangPosition({
    ...base, stockBooking: 'fresh_pr',
    allocations: [{ material_id: 7, order_line_id: 1, source: 'requisition', qty: 4000, status: 'active' }],
  });
  assert.equal(freshCovered.short, 0, 'its own full PR is the only thing that closes it');
  assert.equal(freshCovered.stock_booking, 'fresh_pr');
  // The PR lands and is covered onto the members: the mirror is consumed and
  // becomes stock holds. The run must NOT read short again — that exact
  // regression would re-buy a delivered pile.
  const freshLanded = gangPosition({
    ...base, stockBooking: 'fresh_pr',
    allocations: [
      { material_id: 7, order_line_id: 1, source: 'stock', qty: 2500, status: 'active' },
      { material_id: 7, order_line_id: 2, source: 'stock', qty: 1500, status: 'active' },
    ],
  });
  assert.equal(freshLanded.short, 0, 'held board is bought board — nothing left to order');
  assert.equal(freshLanded.held, 4000);
});

// ── A job on the floor is shown, never raided ──────────────────────────────
test('canGiveUpBoard: planned and ready may give board up, production may not', () => {
  assert.equal(canGiveUpBoard({ status: 'planned' }), true);
  assert.equal(canGiveUpBoard({ status: 'ready' }), true);
  assert.equal(canGiveUpBoard({ status: 'in_production' }), false);
  assert.equal(canGiveUpBoard({ id: 1 }), true, 'a row carrying no status behaves exactly as before');
});

test('planMove: refuses to take board off a job already in production', () => {
  const lines = [
    { id: 156, status: 'in_production', product_name: 'OMEZYME', parent_sheets_required: 1500 },
    { id: 117, status: 'planned', product_name: 'OYOPEG', parent_sheets_required: 1225 },
  ];
  const out = planMove({ materialId: 222, fromLineId: 156, toLineId: 117, qty: 100, available: 4850, lines });
  assert.equal(out.ok, false);
  assert.match(out.blockers.join(' '), /OMEZYME is already in production/);
});

test('planMove: a planned-to-planned move is untouched by the production guard', () => {
  const lines = [
    { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
    { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 1000 },
  ];
  const out = planMove({ materialId: 5, fromLineId: 1, toLineId: 2, qty: 100, available: 5000, lines });
  assert.equal(out.ok, true, out.blockers.join(' '));
});

// ── Issuable at cutting time ──────────────────────────────────────────────
// What a job may actually DRAW from the warehouse right now: its own hold
// plus whatever is genuinely free. Never another job's hold — that is how
// job B silently FIFO-eats job A's board and A fails later, far from cause.

test('issuable: with no allocations, free is the whole available position', () => {
  const r = issuableFor({ available: 120, allocations: [], orderLineId: 5 });
  assert.equal(r.heldByOthers, 0);
  assert.equal(r.free, 120);
});

test('issuable: another jobs hold is not yours to eat', () => {
  const r = issuableFor({
    available: 120,
    allocations: [{ status: 'active', source: 'stock', order_line_id: 9, qty: 80, material_id: 3 }],
    orderLineId: 5, materialId: 3,
  });
  assert.equal(r.heldByOthers, 80);
  assert.equal(r.free, 40);
});

test('issuable: your own hold does not block you', () => {
  const r = issuableFor({
    available: 120,
    allocations: [{ status: 'active', source: 'stock', order_line_id: 5, qty: 80, material_id: 3 }],
    orderLineId: 5, materialId: 3,
  });
  assert.equal(r.own, 80);
  assert.equal(r.heldByOthers, 0);
  assert.equal(r.free, 120);
});

test('issuable: released holds and requisition holds do not reserve stock', () => {
  const r = issuableFor({
    available: 120,
    allocations: [
      { status: 'released', source: 'stock', order_line_id: 9, qty: 80, material_id: 3 },
      { status: 'active', source: 'requisition', order_line_id: 9, qty: 50, material_id: 3 },
    ],
    orderLineId: 5, materialId: 3,
  });
  assert.equal(r.heldByOthers, 0);
  assert.equal(r.free, 120);
});

test('issuable: a hold on a different board is irrelevant', () => {
  const r = issuableFor({
    available: 120,
    allocations: [{ status: 'active', source: 'stock', order_line_id: 9, qty: 80, material_id: 99 }],
    orderLineId: 5, materialId: 3,
  });
  assert.equal(r.free, 120);
});

test('issuable: over-held board never reports negative free', () => {
  const r = issuableFor({
    available: 50,
    allocations: [{ status: 'active', source: 'stock', order_line_id: 9, qty: 80, material_id: 3 }],
    orderLineId: 5, materialId: 3,
  });
  assert.equal(r.free, 0);
});

test('planMove releases the giving line hold it actually spends', () => {
  // Line 1 holds 800 of board 9 and needs 1,000. Line 2 needs 500 and holds
  // nothing. Moving 300 from line 1 to line 2 must TAKE 300 off line 1's hold,
  // not merely add 300 to line 2's — otherwise the board is held twice.
  //
  // actorIsManagement: this test is about the RELEASE arithmetic, and taking
  // held board is now an approver decision (A2). Without it the move is refused
  // before any effect is built and the assertion below has nothing to read.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    actorIsManagement: true,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [
      { id: 1, order_line_id: 1, material_id: 9, qty: 800, source: 'stock', status: 'active' },
    ],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));

  const release = plan.effects.find(e => e.kind === 'release');
  assert.ok(release, 'no release effect — the giving line keeps a hold it just gave away');
  assert.equal(release.order_line_id, 1);
  assert.equal(release.qty, 300);
});

test('planMove releases nothing when the giver holds nothing', () => {
  // The giving line has no hold — its board is coming out of free stock, so
  // there is nothing to release and the effect must be absent entirely.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.equal(plan.effects.some(e => e.kind === 'release'), false,
    'a release effect was emitted for a line holding nothing');
});

test('planMove releases only what the giver holds, never more', () => {
  // Giver holds 100 but is giving 300 — the other 200 comes from free stock.
  // Releasing 300 would drive the hold negative.
  // actorIsManagement: as above — 100 of this move is frozen board, so the
  // approver gate would refuse it before the release arithmetic runs.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    actorIsManagement: true,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [
      { id: 1, order_line_id: 1, material_id: 9, qty: 100, source: 'stock', status: 'active' },
    ],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.equal(plan.effects.find(e => e.kind === 'release').qty, 100);
});

// ── A2: only management may carve frozen board off another job ──────────────
//
// The freeze (main@1358658) writes a hold on every locked line and every saved
// draft, so there is far more frozen board about than before — while the only
// guard on taking it was "is a planner". This is the approver gate that was
// designed to land with the freeze and did not.
//
// It lives in planMove, NOT on the route, and that is the whole point: Planning
// and the PR module are two doors onto ONE act, and a third door built later
// must not bypass the gate by forgetting to call it. Everything that moves
// board between jobs goes through this function.
//
// It keys on `givenFromHold` — the sheets that come out of the giver's own
// board_allocations row — because that is exactly "frozen board being carved
// out". Board the giver was merely RELYING on from the free pool was never
// anyone's, and moving that stays an ordinary planner action.
//
// `actorIsManagement` defaults to FALSE: fail closed. A caller that forgets the
// flag is refused, not waved through — the opposite default would reproduce the
// exact hole this gate exists to close, silently, in whatever door comes next.
const FROZEN_SCENE = extra => ({
  materialId: 9,
  fromLineId: 1,
  toLineId: 2,
  qty: 300,
  available: 800,
  lines: [
    { id: 1, status: 'planned', product_name: 'FOLEE-1 CARTON', parent_sheets_required: 1000 },
    { id: 2, status: 'planned', product_name: 'GLYKIND-MP CARTON', parent_sheets_required: 500 },
  ],
  allocations: [
    { id: 1, order_line_id: 1, material_id: 9, qty: 400, source: 'stock', status: 'active' },
  ],
  openPrs: [],
  ...extra,
});

test('A2: a planner cannot carve board frozen to another job', () => {
  const plan = planMove(FROZEN_SCENE({ actorIsManagement: false }));
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal?.code, 'FROZEN_TO_ANOTHER_JOB');
});

test('A2: the refusal NAMES the job holding the sheets, or nobody can go and ask', () => {
  const plan = planMove(FROZEN_SCENE({ actorIsManagement: false }));
  assert.equal(plan.refusal.owner_line_id, 1);
  assert.equal(plan.refusal.owner_job, 'FOLEE-1 CARTON');
  assert.equal(plan.refusal.frozen_qty, 300);
  assert.match(plan.blockers[0], /FOLEE-1 CARTON/,
    'the human sentence must name the owning job too — it is what reaches the planner as a toast');
});

test('A2: management may take it', () => {
  const plan = planMove(FROZEN_SCENE({ actorIsManagement: true }));
  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.equal(plan.effects.find(e => e.kind === 'release').qty, 300);
});

test('A2: the gate FAILS CLOSED — a caller that forgets the flag is refused', () => {
  const plan = planMove(FROZEN_SCENE());
  assert.equal(plan.ok, false,
    'omitting actorIsManagement must DENY. Defaulting to permissive would let the next door '
    + 'built on planMove bypass the gate by simply not knowing about it — the exact failure A2 names.');
  assert.equal(plan.refusal?.code, 'FROZEN_TO_ANOTHER_JOB');
});

test('A2: board the giver merely RELIED on is not frozen, so a planner may still move it', () => {
  // Line 1 holds nothing; it was just counting on free stock. Nothing is being
  // carved off anyone, so the ordinary planner move is untouched by the gate.
  const plan = planMove(FROZEN_SCENE({ allocations: [], actorIsManagement: false }));
  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.ok(!plan.effects.some(e => e.kind === 'release'),
    'nothing was held, so nothing is released — and the gate must not fire');
});

test('A2: a partial bite into a hold is still a bite', () => {
  // 300 moved, only 120 of it frozen. Still another job's sheets.
  const plan = planMove(FROZEN_SCENE({
    actorIsManagement: false,
    allocations: [{ id: 1, order_line_id: 1, material_id: 9, qty: 120, source: 'stock', status: 'active' }],
  }));
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal.frozen_qty, 120, 'the refusal reports the FROZEN part, not the whole move');
});
