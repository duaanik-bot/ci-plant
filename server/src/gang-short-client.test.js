// The run engine's shortfall, measured against the mix ON SCREEN.
//
// THE SENTENCE these tests hold the panel to:
//
//   a run whose Board Mix says "Fully covered" is not short, and one whose
//   draft no longer covers it IS — the moment the rows change, not at save.
//
// CI-MRG-0014 on the live plant, 18 Aug 2026, is the fixture. Duplex WB · 350
// GSM · 22x28 (board 53) held 2,468 sheets with 100 committed elsewhere, so the
// run's 2,875 read 507 short. The planner clicked "Cover with another board",
// which seeds `planned = issue − short` and `substitute = short` — 2,368 + 507,
// covering the run exactly. The panel then said "Fully covered ✓" and totalled
// 2,875 against 2,875 while the footer and the Lock button both still said
// "short 507": the shortfall was read off the server's figure, which credits
// only the SAVED mix and knew nothing of the rows just typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gangShortView, pressingOnPlanned } from '../../client/src/lib/gangShort.js';

const PLANNED = 53;   // Duplex WB · 350 GSM · 22x28 — the run's planned board
const SUB = 43;       // Duplex WB · 320 GSM · 22x28 — the alternate, 954 free

// The live position BEFORE the mix was saved: needed_gross is the lead board's
// own requirement with no mix credited, which is what a draft must re-credit.
const PRE_MIX = {
  available: 2468, committed_other: 100, held_others: 0,
  needed: 2875, needed_gross: 2875, incoming: 0, held: 0,
};

test('CI-MRG-0014: a drafted mix that covers the run is NOT short', () => {
  const v = gangShortView({
    position: PRE_MIX,
    issueNow: 2875,
    plannedBoardId: PLANNED,
    mixRows: [{ material_id: PLANNED, sheets: 2368 }, { material_id: SUB, sheets: 507 }],
    mixCovered: 2875,
  });
  // 2,368 pressed on the planned board, 100 committed elsewhere, 2,468 on the
  // shelf — it fits exactly, which is what the seed was solving for.
  assert.equal(v.short, 0, 'the covered run must read stock OK');
  assert.equal(v.totalShort, 0, 'and the Lock button must not offer "507 short"');
});

test('CI-MRG-0014: the shortfall is real until the mix covers it', () => {
  const bare = gangShortView({ position: PRE_MIX, issueNow: 2875, plannedBoardId: PLANNED });
  assert.equal(bare.short, 507, 'no mix — 2,875 wanted, 2,368 free');
  // Which is exactly what the seed writes: planned = issue − short.
  assert.equal(2875 - bare.short, 2368);
});

test('a draft that STOPS covering goes short again on the spot', () => {
  // The saved mix covers it, so the server sends needed 2,368. The planner then
  // deletes the substitute row. Reading the server's figure would answer "stock
  // OK" about a run that no longer has a second board under it.
  const saved = { ...PRE_MIX, committed_other: 0, needed: 2368 };
  const v = gangShortView({
    position: saved,
    issueNow: 2875,
    plannedBoardId: PLANNED,
    mixRows: [{ material_id: PLANNED, sheets: 2368 }],
    mixCovered: 2368,
  });
  // 2,368 written on the planned board + 507 the mix no longer covers = 2,875
  // pressed, against 2,468 free.
  assert.equal(v.short, 407);
});

test('a run covered ENTIRELY off substitutes presses nothing on the planned board', () => {
  const v = gangShortView({
    position: { available: 0, committed_other: 0, held_others: 0, needed: 5000, needed_gross: 5000, incoming: 0, held: 0 },
    issueNow: 5000,
    plannedBoardId: PLANNED,
    mixRows: [{ material_id: SUB, sheets: 5000 }],
    mixCovered: 5000,
  });
  assert.equal(v.short, 0, 'an empty planned board is irrelevant when nothing is drawn off it');
});

test('no mix at all reads exactly as it always did', () => {
  const v = gangShortView({
    position: { available: 1000, committed_other: 200, held_others: 50, needed: 3000, needed_gross: 3000, incoming: 400, held: 0 },
    issueNow: 3000,
    plannedBoardId: PLANNED,
  });
  // 3,000 + 250 committed − 1,000 shelf − 400 on order
  assert.equal(v.short, 1850);
  assert.equal(v.free, 750);
});

test('a co-printed run measures the LIVE issue, override and all', () => {
  // One sheet prints every member, so the run figure IS the lead board's — and
  // a typed override must move the verdict before it is saved.
  const position = { available: 4000, committed_other: 0, held_others: 0, needed: 3000, needed_gross: 3000, incoming: 0, held: 0 };
  const v = gangShortView({ position, sharedMode: true, issueNow: 5000, plannedBoardId: PLANNED });
  assert.equal(v.short, 1000, 'the override, not the stored 3,000');
});

test('fresh_pr buys its own requirement and ignores the shelf', () => {
  const v = gangShortView({
    position: { available: 9999, committed_other: 0, held_others: 0, needed: 2000, needed_gross: 2000, incoming: 300, held: 500 },
    stockBooking: 'fresh_pr',
    issueNow: 2000,
    plannedBoardId: PLANNED,
  });
  assert.equal(v.short, 1200, '2,000 less 500 held and 300 on order');
  assert.equal(v.freshRun, true);
});

test('every other board keeps its own gap in the total', () => {
  const v = gangShortView({
    position: { available: 5000, committed_other: 0, held_others: 0, needed: 1000, needed_gross: 1000, incoming: 0, held: 0 },
    issueNow: 1000,
    plannedBoardId: PLANNED,
    otherBoardPositions: [
      { board_material_id: 77, board_name: 'FBB · 300 GSM', position: { short: 250 } },
      { board_material_id: 78, board_name: 'Saffire · 290 GSM', position: { short: 0 } },
    ],
  });
  assert.equal(v.short, 0, 'the lead board is fine');
  assert.equal(v.otherBoards.length, 1, 'and only the board with a real gap is listed');
  assert.equal(v.totalShort, 250, 'which the lead board must not hide');
});

test('pressingOnPlanned is the server twin, unchanged', () => {
  assert.equal(pressingOnPlanned({ required: 13250, active: false }), 13250);
  assert.equal(pressingOnPlanned({ required: 13250, active: true, covered: 13250, heldOnPlanned: 7950 }), 7950);
  assert.equal(pressingOnPlanned({ required: 13250, active: true, covered: 9000, heldOnPlanned: 7950 }), 7950 + 4250);
  assert.equal(pressingOnPlanned({ required: 5000, active: true, covered: 6000, heldOnPlanned: 4000 }), 4000);
});
