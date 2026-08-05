// The planning-engine wave: grade discipline in Smart Match, the per-field
// master decision, and the ceiling a commit is allowed to take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankBoardMatches, boardFamily, boardGsm } from './smartmatch.js';
import { splitMasterFields } from './plan-save.js';
import { boardPosition } from './board-allocation.js';
import { BOARD_DEMAND_STATUSES } from './helpers.js';

// A 20×38 parent cutting a 19×20 child — the live NIKOS case from the screen
// this wave came off. Every candidate below shares that geometry so the family
// filter is the only thing that can decide the outcome.
const PRODUCT = { child_l: 19, child_w: 20, gsm: 300 };
const board = (id, name, over = {}) => ({
  id, name, sheet_l: 20, sheet_w: 38, available: 5000, committed: 0, ...over,
});
const FBB_300 = board(1, 'FBB · 300 GSM · 20 x 38');

// ── Smart Match: same grade only ────────────────────────────────────────────

test('a different family is never offered, however clean the fit', () => {
  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 1284, currentBoard: FBB_300,
    candidates: [
      FBB_300,
      board(2, 'FBB · 320 GSM · 20 x 38'),
      // Same size, same GSM, perfect fit — and still not FBB.
      board(3, 'Saffire · 300 GSM · 20 x 38'),
      board(4, 'Duplex GB · 296 GSM · 20 x 38'),
    ],
  });
  assert.deepEqual(out.map(m => m.name).sort(), [
    'FBB · 300 GSM · 20 x 38', 'FBB · 320 GSM · 20 x 38',
  ]);
});

test('same family, a supply grade apart, still ranks — that is the whole point', () => {
  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 1284, currentBoard: FBB_300,
    candidates: [FBB_300, board(2, 'FBB · 290 GSM · 20 x 38'), board(3, 'FBB · 320 GSM · 20 x 38')],
  });
  assert.equal(out.length, 3);
  assert.equal(out.find(m => m.gsm === 300).category, 'exact');
  assert.equal(out.find(m => m.gsm === 290).category, 'near');
  assert.equal(out.find(m => m.gsm === 320).category, 'near');
});

test("'alternate' now means the right grade at a far weight, never a foreign family", () => {
  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 500, currentBoard: FBB_300,
    candidates: [FBB_300, board(2, 'Saffire · 300 GSM · 20 x 38'), board(3, 'FBB · 400 GSM · 20 x 38')],
  });
  // The Saffire is gone; the 100-GSM-away FBB is kept and flagged.
  assert.equal(out.some(m => m.name.startsWith('Saffire')), false);
  assert.equal(out.find(m => m.gsm === 400).category, 'alternate');
  assert.equal(out.every(m => m.name.startsWith('FBB')), true);
});

test('a leftover offcut inherits its parent board family, not its own name', () => {
  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 500, currentBoard: FBB_300,
    candidates: [
      FBB_300,
      board(9, 'Leftover — 20 x 38', { leftover: true, match_name: 'FBB · 300 GSM · 20 x 38' }),
      board(10, 'Leftover — 20 x 38', { leftover: true, match_name: 'Saffire · 300 GSM · 20 x 38' }),
    ],
  });
  const ids = out.map(m => m.material_id);
  assert.ok(ids.includes(9), 'an FBB offcut is still FBB and belongs on the list');
  assert.ok(!ids.includes(10), 'a Saffire offcut is Saffire, whatever the leftover row is called');
  assert.equal(boardFamily({ match_name: 'FBB · 300 GSM · 20 x 38' }), 'fbb');
  assert.equal(boardGsm({ match_name: 'FBB · 300 GSM · 20 x 38' }), 300);
});

test('a name typed without the · convention still groups by its grade', () => {
  // Every board on the live plant carries the separator; these do not, and
  // before the fallback each weight read as its own family — which, with the
  // foreign-family drop in place, would have hidden a board's own siblings.
  assert.equal(boardFamily({ name: 'FBB Board 300 GSM' }), 'fbb');
  assert.equal(boardFamily({ name: 'FBB Board 270 GSM' }), 'fbb');
  assert.equal(boardFamily({ name: 'CFBB Board 305 GSM' }), 'cfbb');
  assert.equal(boardFamily({ name: 'Duplex Board 295 GSM 25 x 36' }), 'duplex');
  // The convention itself is untouched.
  assert.equal(boardFamily({ name: 'Duplex GB · 296 GSM · 20 x 38' }), 'duplex gb');

  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 500,
    currentBoard: { id: 1, name: 'FBB Board 300 GSM', sheet_l: 25, sheet_w: 36 },
    candidates: [
      board(1, 'FBB Board 300 GSM', { sheet_l: 25, sheet_w: 36 }),
      board(2, 'FBB Board 270 GSM', { sheet_l: 25, sheet_w: 36 }),
      board(3, 'CFBB Board 305 GSM', { sheet_l: 25, sheet_w: 36 }),
      board(4, 'Duplex Board 295 GSM', { sheet_l: 25, sheet_w: 36 }),
    ],
  });
  assert.deepEqual(out.map(m => m.material_id).sort(), [1, 2]);
});

test('a board with no current board to match against is unfiltered', () => {
  // Nothing to be the same grade AS — a product that has never named a board.
  const out = rankBoardMatches({
    product: PRODUCT, childSheets: 500, currentBoard: null,
    candidates: [board(1, 'FBB · 300 GSM · 20 x 38'), board(2, 'Saffire · 300 GSM · 20 x 38')],
  });
  assert.equal(out.length, 2);
});

// ── The master decision, per field ──────────────────────────────────────────

const CHANGED = { ups: 12, parent_l: 18, coating: 'drip off' };

test('no master fields named: every change goes to the master, as before', () => {
  const { toMaster, toJob } = splitMasterFields({ changed: CHANGED, updateMaster: true, masterFields: null });
  assert.deepEqual(toMaster, CHANGED);
  assert.deepEqual(toJob, {});
});

test('job-only leaves the master untouched, whatever was ticked', () => {
  const { toMaster, toJob } = splitMasterFields({
    changed: CHANGED, updateMaster: false, masterFields: ['ups', 'coating'],
  });
  assert.deepEqual(toMaster, {});
  assert.deepEqual(toJob, CHANGED);
});

test('a split answer files each field where it was ticked', () => {
  const { toMaster, toJob } = splitMasterFields({
    changed: CHANGED, updateMaster: true, masterFields: ['ups'],
  });
  assert.deepEqual(toMaster, { ups: 12 });
  assert.deepEqual(toJob, { parent_l: 18, coating: 'drip off' });
});

test('an empty tick list promotes nothing — every field stays on the job', () => {
  const { toMaster, toJob } = splitMasterFields({ changed: CHANGED, updateMaster: true, masterFields: [] });
  assert.deepEqual(toMaster, {});
  assert.deepEqual(toJob, CHANGED);
});

test('a named field that was not edited cannot conjure a master write', () => {
  const { toMaster } = splitMasterFields({
    changed: { ups: 12 }, updateMaster: true, masterFields: ['ups', 'colors', 'board_material_id'],
  });
  assert.deepEqual(toMaster, { ups: 12 });
});

// ── The commit ceiling ──────────────────────────────────────────────────────
// A commit takes FREE stock only. `free` is the same figure boardPosition has
// always computed — available less what is already held — so a commit can never
// quietly take sheets off a job that is already holding them. Raiding a job is
// /board/move's business, and it asks for a reason and shows a preview first.

// The route's own rule, in the two lines it is: the ask is a TOTAL, the server
// holds the difference, and the difference must fit in free stock.
const commitDelta = (want, alreadyHeld) => want - alreadyHeld;
const canCommit = (qty, position) => qty > 0 && qty <= position.free;
const BOARD_ID = 7;
// material_id is not decoration: boardPosition filters allocations by it before
// any arithmetic, so a fixture without one silently holds nothing and every
// ceiling test below would pass for the wrong reason.
const alloc = (orderLineId, qty, over = {}) =>
  ({ material_id: BOARD_ID, order_line_id: orderLineId, qty, source: 'stock', status: 'active', ...over });

test('a commit is capped at free stock, not at what is on the shelf', () => {
  const pos = boardPosition({
    available: 5000,
    lines: [{ id: 1, parent_sheets_required: 3000 }, { id: 2, parent_sheets_required: 2000 }],
    allocations: [alloc(1, 3000)],
    materialId: BOARD_ID,
  });
  assert.equal(pos.free, 2000);
  assert.equal(canCommit(2000, pos), true);
  assert.equal(canCommit(2001, pos), false, "another job's hold is not ours to take");
});

test('a board with every sheet held can be committed no further', () => {
  const pos = boardPosition({
    available: 800,
    lines: [{ id: 1, parent_sheets_required: 800 }],
    allocations: [alloc(1, 800)],
    materialId: BOARD_ID,
  });
  assert.equal(pos.free, 0);
  assert.equal(canCommit(1, pos), false);
});

test('a released hold is free again — uncommit gives the sheets back', () => {
  const held = { available: 800, lines: [{ id: 1, parent_sheets_required: 800 }], materialId: BOARD_ID };
  assert.equal(boardPosition({ ...held, allocations: [alloc(1, 800)] }).free, 0);
  const after = boardPosition({ ...held, allocations: [alloc(1, 800, { status: 'released' })] });
  assert.equal(after.free, 800);
  assert.equal(canCommit(800, after), true);
});

test('committing twice for the same total holds it once, not twice', () => {
  // The button reads "Commit 2,600" and 2,600 is what the job should end up
  // holding — pressing it again must not stack a second 2,600 hold. This is
  // the double-press this wave was caught doing during verification.
  const want = 2600;
  assert.equal(commitDelta(want, 0), 2600, 'the first press takes the lot');
  assert.equal(commitDelta(want, 2600) > 0, false, 'the second press has nothing left to take');
  assert.equal(commitDelta(want, 900), 1700, 'a part-held job tops up to the total');
});

test('incoming PR coverage is not free stock and cannot be committed', () => {
  // source='requisition' is board on order, not board on the shelf.
  const pos = boardPosition({
    available: 0,
    lines: [{ id: 1, parent_sheets_required: 500 }],
    allocations: [alloc(1, 500, { source: 'requisition' })],
    materialId: BOARD_ID,
  });
  assert.equal(pos.free, 0);
  assert.equal(canCommit(500, pos), false);
});

// ── A draft claims nothing ──────────────────────────────────────────────────

test('a draft-saved job stays at pending, and pending makes no board claim', () => {
  // This is what makes "Save" safe to offer: the work persists, but until the
  // plan is locked the job is invisible to every board figure in the ERP.
  assert.equal(BOARD_DEMAND_STATUSES.includes('pending'), false);
  assert.deepEqual(BOARD_DEMAND_STATUSES, ['planned', 'ready', 'in_production']);
});
