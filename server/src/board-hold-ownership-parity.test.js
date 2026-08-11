import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { issuableFor, stockHoldBudget, openNeed, heldFor } from './board-allocation.js';
import { claimableQty } from './helpers.js';

// OWNERSHIP PARITY — the guard the Omezyme refusal earned.
//
// A board hold is tagged to ONE order_line_id. The plant does not run lines,
// it runs RUNS (gang, combined, merge), and a run card carries no line id at
// all. So every reader of board_allocations has to answer "whose hold is
// this?" for itself, and there are five of them:
//
//   issuableFor      the gate that REFUSES a draw
//   claimableQty     the badge that PROMISES stock
//   stockHoldBudget  the cap on a new hold (Board Mix save)
//   openNeed         what a line still has to buy
//   claimsByBoard    who is holding what, for the warehouse strip
//
// They drifted, and the plant paid for it twice in four days:
//
//   8 Aug   a hold outlived its own draw       → 4,008 sheets billed twice,
//                                                GLYKIND read Short 1,100 for
//                                                board sitting in the racks
//   11 Aug  a run card owned none of its holds → OMEZYME (CI-JC-0048) refused
//                                                its own 5,250-sheet freeze,
//                                                "5,863 committed to other jobs"
//                                                when 5,250 of it was its own
//
// THE LAW, and it is one line: a hold owned by ANY member of my run is never
// foreign to me. issuableFor and claimableQty ask the identical question —
// "how much of this board may this job take" — so they must return the
// identical number, always. Before the fix they answered 37 and 5,287 on the
// same world. That disagreement IS the bug, and this file makes it fail loudly
// in CI instead of quietly on the floor.
//
// Adding a sixth reader? Add it here. If it cannot pass the parity law it is
// wrong, however reasonable it looks on its own.

// The live world at the moment OMEZYME was refused. Board 222,
// Saffire · 340 GSM · 20x38. Lines 156 and 162 are the two members of gang
// run 20; line 246 is a genuinely different job (CI-JC-0099).
const BOARD = 222;
const RUN = 20;
const MEMBERS = [156, 162];
const SHELF = 5900;
const HOLDS = [
  { order_line_id: 246, material_id: BOARD, qty: 613, status: 'active', source: 'stock', gang_run_id: null },
  { order_line_id: 156, material_id: BOARD, qty: 1500, status: 'active', source: 'stock', gang_run_id: RUN },
  { order_line_id: 162, material_id: BOARD, qty: 3750, status: 'active', source: 'stock', gang_run_id: RUN },
];
const FOREIGN = 613;          // only line 246 is somebody else's
const MINE = 5250;            // 1,500 + 3,750, the run's own freeze
const TAKEABLE = SHELF - FOREIGN;

test('THE LAW: the gate that refuses and the badge that promises agree', () => {
  // The run, as the issue gate sees it — every member line is an owner.
  const gate = issuableFor({
    available: SHELF, allocations: HOLDS, orderLineIds: MEMBERS, materialId: BOARD,
  });
  // The run, as the board badge sees it — any member line, since the badge
  // reads a line and widens to its run.
  const badge = claimableQty({
    available: SHELF, holds: HOLDS, line: { id: 156, gang_run_id: RUN },
  });
  assert.equal(gate.free, badge,
    `the gate and the badge must never disagree — they answer the same question `
    + `(gate ${gate.free}, badge ${badge}). This is exactly how OMEZYME was refused `
    + `board the badge beside it said was available.`);
  assert.equal(gate.free, TAKEABLE);
  assert.equal(gate.own, MINE);
  assert.equal(gate.heldByOthers, FOREIGN);
});

test('THE LAW holds for a plain line card too', () => {
  const holds = [
    { order_line_id: 99, material_id: BOARD, qty: 800, status: 'active', source: 'stock', gang_run_id: null },
    { order_line_id: 42, material_id: BOARD, qty: 500, status: 'active', source: 'stock', gang_run_id: null },
  ];
  const gate = issuableFor({ available: 2000, allocations: holds, orderLineIds: [42], materialId: BOARD });
  const badge = claimableQty({ available: 2000, holds, line: { id: 42, gang_run_id: null } });
  assert.equal(gate.free, badge);
  assert.equal(gate.free, 1200); // 2,000 less the 800 that is genuinely another job's
});

test('THE LAW is not satisfied by simply trusting everyone', () => {
  // The fix must not have over-corrected into "nothing is foreign". A job
  // still may never eat board frozen for someone else — that is the whole
  // reason the gate exists.
  const gate = issuableFor({
    available: SHELF, allocations: HOLDS, orderLineIds: MEMBERS, materialId: BOARD,
  });
  assert.equal(gate.heldByOthers, FOREIGN, 'line 246 stays protected');
  assert.ok(gate.free < SHELF, 'the run cannot reach the whole shelf');

  // And a run may not claim a hold belonging to a DIFFERENT run.
  const otherRun = issuableFor({
    available: SHELF, allocations: HOLDS, orderLineIds: [999], materialId: BOARD,
  });
  assert.equal(otherRun.own, 0);
  assert.equal(otherRun.heldByOthers, FOREIGN + MINE);
});

test('the hold cap does not count a run-mate as a stranger', () => {
  // stockHoldBudget gates a Board Mix save. Its `held` is board frozen by
  // people who are NOT me; my run's own freeze must not appear there.
  const budget = stockHoldBudget({
    materialId: BOARD, available: SHELF, allocations: HOLDS,
    claimLines: [], ownerLineIds: MEMBERS,
  });
  assert.equal(budget.held, FOREIGN,
    'only line 246 is held by another job — the run\'s own 5,250 is not "outside" it');
  assert.equal(budget.free, TAKEABLE);
});

test('a member line still finds its OWN hold when asked line-wise', () => {
  // openNeed is asked per line, never per run, so a member asks about itself.
  // Its own hold must retire its own need, or Planning chases board it has.
  const member = { id: 162, parent_sheets_required: 3750, gang_run_id: RUN };
  assert.equal(heldFor(HOLDS, 162, BOARD), 3750);
  assert.equal(openNeed(member, HOLDS), 0, 'fully held — nothing left to find');
  // and it must not be credited with its run-mate's hold
  const short = { id: 156, parent_sheets_required: 4000, gang_run_id: RUN };
  assert.equal(openNeed(short, HOLDS), 2500, '4,000 needed less its OWN 1,500');
});

// The badge's run rule reads `h.gang_run_id`, which is NOT a column on
// board_allocations — it arrives only because the context query LEFT JOINs
// order_lines to fetch it. Drop that join and claimableQty silently stops
// recognising run-mates: every gang job starts reading short, with no error
// anywhere. Cheap to break, invisible when broken, so it is pinned here.
test('the holds context must carry gang_run_id or the badge goes blind', () => {
  const src = readFileSync(new URL('./helpers.js', import.meta.url), 'utf8');
  const q = src.slice(src.indexOf('const holdRows'), src.indexOf('const holdRows') + 600);
  assert.match(q, /ol\.gang_run_id/,
    'the holds query must select ol.gang_run_id — claimableQty\'s run rule is dead without it');
  assert.match(q, /LEFT JOIN order_lines/,
    'and it must LEFT JOIN order_lines, not INNER — a hold on a deleted line must not vanish');

  // Proof of what breaking it costs: the same world, gang_run_id stripped.
  // Line 156 still matches on its own id, so only the RUN-MATE's 3,750 is
  // mis-read as a stranger's — the badge drops 5,287 → 1,537 and the job
  // reads short by exactly its own partner's freeze.
  const blind = HOLDS.map(({ gang_run_id, ...rest }) => rest);
  const badge = claimableQty({ available: SHELF, holds: blind, line: { id: 156, gang_run_id: RUN } });
  assert.equal(badge, TAKEABLE - 3750, 'without gang_run_id the badge under-reads by the run-mate\'s hold');
  assert.equal(badge, 1537);
  assert.notEqual(badge, TAKEABLE);
});

// The law is not only JavaScript. Ownership is asked in SQL too, and a run
// card's jc.order_line_id is NULL there as well — where `IS DISTINCT FROM
// NULL` is TRUE for every row, so a bare comparison silently calls the run's
// own freeze somebody else's. The extra-sheets view did exactly that, and its
// comment argued the result was correct ("a run parent owns no line of its own
// to net out"). It read CI-GANG-JC-0039's 963 and CI-GANG-JC-0041's 650 as
// board committed elsewhere when both were the run's own.
test('the SQL ownership predicate nets a run out through its RUN', () => {
  const src = readFileSync(new URL('./routes/extrasheets.js', import.meta.url), 'utf8');
  const lateral = src.slice(src.indexOf('FROM board_allocations ba'));
  const pred = lateral.slice(0, lateral.indexOf(') oth ON true'));
  assert.match(pred, /IS DISTINCT FROM jc\.order_line_id/, 'still nets out its own line');
  assert.match(pred, /jc\.gang_run_id IS NULL\s*\n?\s*OR ba\.order_line_id NOT IN/,
    'and must net out its run-mates too — a run card has no line of its own, '
    + 'which makes it ownerless only if you forget where its holds live');
  assert.match(pred, /rol\.gang_run_id = jc\.gang_run_id/);
});

// Same law, third form: the board-mix position (bmp) a card shows. Three views
// carried this body INLINE. Two were taught that a run keeps its mix on its
// members; floor.js was not, and still said "verbatim from JC_VIEW" while
// having drifted — so the floor board would call a run card unmixed while the
// job card beside it read the mix in full. A comment cannot hold two files in
// step, so there is now one constant and no inline copies.
test('the board-mix position has ONE spelling, and it knows about runs', async () => {
  const { BOARD_MIX_POSITION_LATERAL } = await import('./helpers.js');
  assert.match(BOARD_MIX_POSITION_LATERAL, /mol\.gang_run_id = jc\.gang_run_id/,
    'a run finds its mix through its members');
  assert.match(BOARD_MIX_POSITION_LATERAL, /GROUP BY x\.material_id/,
    'and sums per board first — a run holds one row per member per board, so '
    + 'judging each against the full shelf counts the same stock twice');

  // No view may carry its own copy. `x.sheets` un-grouped is the old body's
  // fingerprint: the shared one compares g.sheets, the per-board sum.
  for (const f of ['routes/production.js', 'routes/floor.js']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes('${BOARD_MIX_POSITION_LATERAL}'), `${f} must use the shared lateral`);
    assert.doesNotMatch(src, /GREATEST\(0, x\.sheets - COALESCE\(sa\.q,0\)\)/,
      `${f} still has an inline board-mix position — that is how floor.js drifted`);
  }
});

// Fourth form: the same position asked from the ORDER LINE side, for the
// plant-wide shortage alert. Keyed on ol.id alone, a member saw only its SHARE
// of the run's mix against the WHOLE shelf — 1,500 of a 5,250 run against a
// full pile reads comfortable — so a genuinely short run raised no alert at
// all. The missed kind, not the false kind. Fixed by letting the run's ANCHOR
// answer for the whole run, which also stops one run raising one alert per
// member.
test('the by-line position judges the RUN, and raises ONE alert for it', async () => {
  const { BOARD_MIX_POSITION_BY_LINE_LATERAL: byLine } = await import('./helpers.js');
  assert.match(byLine, /mol\.gang_run_id = ol\.gang_run_id/, 'a ganged line reaches its run');
  assert.match(byLine, /MIN\(a\.id\)/,
    'and only the anchor answers — otherwise a two-member run raises two alerts '
    + 'and crowds the LIMIT 5 list with the same shortage twice');
  assert.match(byLine, /GROUP BY x\.material_id/, 'summed per board before the stock comparison');
  assert.match(byLine, /WHEN ol\.gang_run_id IS NULL THEN x\.order_line_id = ol\.id/,
    'an unganged line keeps exactly its old predicate');

  const src = readFileSync(new URL('./routes/dashboard.js', import.meta.url), 'utf8');
  assert.ok(src.includes('${BOARD_MIX_POSITION_BY_LINE_LATERAL}'), 'dashboard uses the shared spelling');
  assert.doesNotMatch(src, /GREATEST\(0, x\.sheets - COALESCE\(sa\.q,0\)\)/,
    'no inline copy left in dashboard.js');
});

// The two spellings differ ONLY in the unit they are keyed on. Anything else
// drifting apart means one of the two screens is lying about the same job.
test('the card and line spellings stay the same arithmetic', async () => {
  const { BOARD_MIX_POSITION_LATERAL: byCard, BOARD_MIX_POSITION_BY_LINE_LATERAL: byLine } =
    await import('./helpers.js');
  for (const s of [byCard, byLine]) {
    assert.match(s, /COUNT\(\*\)::int AS n/);
    assert.match(s, /COALESCE\(SUM\(GREATEST\(0, g\.sheets - COALESCE\(sa\.q,0\)\)\), 0\) AS short/,
      'both compare the PER-BOARD sum (g.sheets) against stock, never a raw row');
    assert.match(s, /FROM stock_batches\s*\n?\s*WHERE status='available' GROUP BY material_id/);
    assert.match(s, /\) bmp ON true/);
  }
});

// The gate is reached from a job card, and a RUN card's order_line_id is NULL.
// Passing that NULL as the owner is the original bug; pin the call shape so it
// cannot silently return.
test('the issue gate is called with the run identity, not a bare line id', () => {
  const src = readFileSync(new URL('./routes/production.js', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/assertFreeToIssue\(([^;]*?)\);/gs)].map(m => m[1]);
  assert.ok(calls.length >= 2, 'both draw sites still call the gate');
  for (const call of calls) {
    assert.match(call, /gangRunId:\s*jc\.gang_run_id/,
      'every assertFreeToIssue call must pass gangRunId — a run card\'s order_line_id '
      + 'is NULL and on its own identifies nobody');
  }
});
