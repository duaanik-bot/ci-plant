// The three figures the station queue now carries in their own columns:
// FROZEN (board reserved for this job), EXPECTED (what the run should yield)
// and ACTUAL (what it has counted). Each one has exactly ONE spelling, and
// each spelling is pinned here.
//
// THE VIEWER RULE applies to all three: the viewer is THIS job card at THIS
// station. Frozen is the card's own freeze — never the board's total, never
// another job's. Expected is measured in this stage's own output unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimableQty, ownHoldQty } from './helpers.js';
import { expectedOutputQty, plannedOutputQty } from '../../client/src/lib/received.js';

// ── FROZEN ──────────────────────────────────────────────────────────────────
// claimableQty subtracts every hold ownsHold() rejects; ownHoldQty adds every
// hold it accepts. They read the SAME rows through the SAME predicate, so the
// Frozen column and the free-stock figure beside it partition one set and can
// never draw the boundary differently.

const LINE = { id: 10, gang_run_id: null };
const RUN = { id: 20, gang_run_id: 7 };

test('a job\'s own hold is frozen FOR it, and never subtracts from what it may claim', () => {
  const holds = [{ order_line_id: 10, qty: 4000, gang_run_id: null }];
  assert.equal(ownHoldQty({ holds, line: LINE }), 4000);
  // Its own freeze is not another job's claim — the whole shelf stays claimable.
  assert.equal(claimableQty({ available: 9000, holds, line: LINE }), 9000);
});

test("another job's hold is NOT this job's frozen, and does subtract", () => {
  const holds = [{ order_line_id: 99, qty: 4000, gang_run_id: null }];
  assert.equal(ownHoldQty({ holds, line: LINE }), 0);
  assert.equal(claimableQty({ available: 9000, holds, line: LINE }), 5000);
});

test('a gang sibling\'s hold is the RUN\'s own freeze — a run buys and cuts as one', () => {
  // Holds are written per MEMBER line; the run card carries no order line of
  // its own. Asking by line id alone would report a run's own freeze as zero.
  const holds = [
    { order_line_id: 21, qty: 3000, gang_run_id: 7 },
    { order_line_id: 22, qty: 2250, gang_run_id: 7 },
    { order_line_id: 99, qty: 1000, gang_run_id: null },
  ];
  assert.equal(ownHoldQty({ holds, line: RUN }), 5250);
  assert.equal(claimableQty({ available: 9000, holds, line: RUN }), 8000);
});

test('frozen and claimable partition one hold set — nothing counted twice, nothing dropped', () => {
  const holds = [
    { order_line_id: 10, qty: 4000, gang_run_id: null },   // mine
    { order_line_id: 99, qty: 1500, gang_run_id: null },   // someone else's
    { order_line_id: 98, qty: 500, gang_run_id: 3 },       // another gang's
  ];
  const total = holds.reduce((s, h) => s + h.qty, 0);
  const available = 20000;
  const others = available - claimableQty({ available, holds, line: LINE });
  assert.equal(ownHoldQty({ holds, line: LINE }) + others, total);
});

test('frozen sums a MIXED job across every board it is frozen on', () => {
  // The planning engine splits one job over two boards; it is frozen on each
  // for only its own share, so the job's freeze is the sum.
  const holds = [
    { material_id: 280, order_line_id: 10, qty: 3000, gang_run_id: null },
    { material_id: 373, order_line_id: 10, qty: 1200, gang_run_id: null },
  ];
  assert.equal(ownHoldQty({ holds, line: LINE }), 4200);
});

test('frozen is zero, not NaN, when nothing is held and when the line is unknown', () => {
  assert.equal(ownHoldQty({ holds: [], line: LINE }), 0);
  assert.equal(ownHoldQty({ holds: [{ order_line_id: 1, qty: 5 }], line: null }), 0);
  assert.equal(ownHoldQty({}), 0);
});

// ── EXPECTED ────────────────────────────────────────────────────────────────
// expectedOutputQty answers "what should the stage yield from what it HAS".
// plannedOutputQty answers the queue's question — which is the same one once
// the stage has been fed, and the PLAN before that. It must never invent a
// figure: a stage with no input and no plan in its own unit reads null, and
// the column shows an em dash rather than a confident zero.

test('cutting multiplies its receipt by the cuts per parent', () => {
  const row = { received: 567, children_per_parent: 2 };
  assert.equal(expectedOutputQty(row, 'cutting', 2), 1134);
  assert.equal(plannedOutputQty(row, 'cutting', 2), 1134);
});

test('a cutting row nobody has started yet reads its PLAN — the figure the Cut Plan cell already prints', () => {
  // CI-JC-0023 in the queue: 400 parent · 2/parent → 800. Received is 0
  // because no board has been issued, so the receipt-based figure is 0 — and
  // 0 under "Expected" beside a cut plan promising 800 is the bug.
  const queued = { received: 0, sheets_issued: 400, children_per_parent: 2, qty_planned: 1000 };
  assert.equal(expectedOutputQty(queued, 'cutting', 2), 0);
  assert.equal(plannedOutputQty(queued, 'cutting', 2), 800);
});

test('the receipt wins over the plan once the stage has been fed', () => {
  // Extra sheets were issued, so the stage holds more than the plan said.
  const row = { received: 650, sheets_issued: 400, children_per_parent: 2 };
  assert.equal(plannedOutputQty(row, 'cutting', 2), 1300);
});

test('every stage but cutting carries its input forward 1:1', () => {
  assert.equal(plannedOutputQty({ received: 1134 }, 'printing', 2), 1134);
  assert.equal(plannedOutputQty({ received: 900 }, 'pasting', 1), 900);
});

test('a downstream stage with nothing received yet reads null, never a fabricated zero', () => {
  // Nobody knows how many sheets the press will get until cutting has counted.
  // qty_planned is CARTONS and would be a number in the wrong unit.
  assert.equal(plannedOutputQty({ received: 0, qty_planned: 1000 }, 'printing', 2), null);
  assert.equal(plannedOutputQty({}, 'coating'), null);
});

test('a cutting row with no plan and no receipt reads null too', () => {
  assert.equal(plannedOutputQty({ received: 0, sheets_issued: 0 }, 'cutting', 2), null);
});

test('a missing or zero children_per_parent is treated as one cut per parent', () => {
  assert.equal(plannedOutputQty({ received: 0, sheets_issued: 500 }, 'cutting', null), 500);
  assert.equal(plannedOutputQty({ received: 0, sheets_issued: 500 }, 'cutting', 0), 500);
});

test('a MIXED cutting job is expected to yield each pile at its OWN chosen cuts', () => {
  // One legacy cpp over the whole receipt is simply the wrong number here, so
  // both arms read mix_cuts — the queue column cannot become a third opinion.
  const mix_cuts = [
    { material_id: 280, issued: 400, cuts: 2 },
    { material_id: 373, issued: 150, cuts: 4 },
  ];
  const queued = { received: 0, sheets_issued: 550, children_per_parent: 2, mix_cuts };
  assert.equal(plannedOutputQty(queued, 'cutting', 2), 1400);
  // and not the single-board figure the legacy arm would have given
  assert.notEqual(plannedOutputQty(queued, 'cutting', 2), 1100);
});
