import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuableFor } from './board-allocation.js';
import { assertFreeToIssue } from './helpers.js';

// A RUN card — gang parent or combined run — carries NO order_line_id. Its
// board holds live on the MEMBER lines, because that is where planning writes
// them. The issue gate asked "which holds carry my order_line_id?" and a run
// card's answer is NULL, so its own freeze read as another job's claim and the
// run was refused its own board.
//
// Live case, CI-JC-0048 (OMEZYME SYRUP, run 20, board 222 Saffire 340 20x38):
//   on the shelf                                 5,900
//   active stock holds                           5,863  = 613 (line 246, a
//                                                         genuinely different
//                                                         job) + 1,500 (line
//                                                         156) + 3,750 (line
//                                                         162) — the last two
//                                                         ARE this run
//   the run needs                                5,250
//   free, counting its own hold against it          37  → refused, "5,863 is
//                                                         committed to other
//                                                         jobs"
//   free, once the run owns its own holds        5,287  → starts, 37 to spare
//
// The holds that broke it were written by the board-freeze back-fill of
// 2026-08-10; before that no stock hold existed on these lines and the gate
// passed by having nothing to count. The bug was always there — the back-fill
// only gave it something to bite.
//
// claimableQty in helpers.js has always had the right rule ("mine = my line,
// or any line sharing my gang run"). This is that same rule, applied to the
// gate that refuses.

const OMEZYME_HOLDS = [
  { order_line_id: 246, material_id: 222, qty: 613, status: 'active', source: 'stock' },
  { order_line_id: 156, material_id: 222, qty: 1500, status: 'active', source: 'stock' },
  { order_line_id: 162, material_id: 222, qty: 3750, status: 'active', source: 'stock' },
];

test('issuableFor: a run owns every hold on its member lines', () => {
  const r = issuableFor({
    available: 5900, allocations: OMEZYME_HOLDS,
    orderLineIds: [156, 162], materialId: 222,
  });
  assert.equal(r.own, 5250, 'both member holds are the run\'s own');
  assert.equal(r.heldByOthers, 613, 'only the unrelated job still reserves');
  assert.equal(r.free, 5287);
});

test('issuableFor: a single line id still works, unchanged', () => {
  const r = issuableFor({
    available: 5900, allocations: OMEZYME_HOLDS,
    orderLineId: 156, materialId: 222,
  });
  assert.equal(r.own, 1500);
  assert.equal(r.heldByOthers, 4363);
  assert.equal(r.free, 1537);
});

// The gate itself, with the database stubbed. `oc` returns one row, `qc` rows.
function stubDb({ available, holds, runLines }) {
  const seen = { runLookups: 0 };
  const oc = async (sql) => {
    if (/FROM stock_batches/.test(sql)) return { q: available };
    if (/FROM materials/.test(sql)) return { name: 'Saffire · 340 GSM · 20x38' };
    return null;
  };
  const qc = async (sql) => {
    if (/FROM board_allocations/.test(sql)) return holds;
    if (/FROM order_lines/.test(sql)) { seen.runLookups++; return runLines.map(id => ({ id })); }
    return [];
  };
  return { qc, oc, seen };
}

test('the gate does not refuse a run card its own board', async () => {
  const { qc, oc } = stubDb({ available: 5900, holds: OMEZYME_HOLDS, runLines: [156, 162] });
  await assertFreeToIssue(222, 5250, { orderLineId: null, gangRunId: 20 }, qc, oc);
});

test('the gate still refuses board genuinely held by another job', async () => {
  // The run wants 5,250 but a different job holds 1,000 and the shelf has
  // 5,900 — 4,900 free. Physics is physics.
  const holds = [
    { order_line_id: 999, material_id: 222, qty: 1000, status: 'active', source: 'stock' },
    { order_line_id: 156, material_id: 222, qty: 1500, status: 'active', source: 'stock' },
  ];
  const { qc, oc } = stubDb({ available: 5900, holds, runLines: [156, 162] });
  await assert.rejects(
    () => assertFreeToIssue(222, 5250, { orderLineId: null, gangRunId: 20 }, qc, oc),
    e => e.status === 409 && /committed to other jobs/.test(e.message));
});

test('a plain card is unaffected — no run lookup, same answer as before', async () => {
  const { qc, oc, seen } = stubDb({ available: 5900, holds: OMEZYME_HOLDS, runLines: [] });
  // Line 156 alone may draw 1,537: the shelf less the 4,363 held by others.
  await assertFreeToIssue(222, 1537, 156, qc, oc);
  await assert.rejects(() => assertFreeToIssue(222, 1538, 156, qc, oc),
    e => e.status === 409);
  assert.equal(seen.runLookups, 0, 'a card with no run never queries for members');
});

test('the gate refuses a run whose own hold does not cover it and the rest is spoken for', async () => {
  // Own hold 650, another job holds the remaining 350 of a 1,000 shelf, and
  // the run asks for 800. Own 650 + free 0 = 650 < 800.
  const holds = [
    { order_line_id: 300, material_id: 176, qty: 350, status: 'active', source: 'stock' },
    { order_line_id: 301, material_id: 176, qty: 650, status: 'active', source: 'stock' },
  ];
  const { qc, oc } = stubDb({ available: 1000, holds, runLines: [301] });
  await assert.rejects(
    () => assertFreeToIssue(176, 800, { orderLineId: null, gangRunId: 39 }, qc, oc),
    e => e.status === 409);
});
