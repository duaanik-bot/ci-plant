// A master's parent when its BOARD moves (Task 10, round 2, 19 Sep 2026).
// "Lock sheet → Update Product Masters" moved a master's board and left its OLD
// parent behind: the CI-MRG-0028 fossil at master level (SW-251 kept #53's
// 22×28 on the 31.5×41.5 board), or an impossible master (SW-097 kept 25.6×28
// on a 23×38 board — the next order meets the 14-Sep refusal).
// masterParentCannotStay is the server twin of the client's board-change rule
// (cutFit.js parentFollowsBoard): a copy of the OLD board's sheet, or a size the
// NEW board cannot yield, cannot stay. The master write then clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterParentCannotStay, sameSheet } from './helpers.js';
import { parentFollowsBoard } from '../../client/src/lib/cutFit.js';

const sheet = ([l, w]) => ({ sheet_l: l, sheet_w: w });
const cannotStay = (parent, oldBoard, newBoard) =>
  masterParentCannotStay({ masterParent: sheet(parent), oldBoard: sheet(oldBoard), newBoard: sheet(newBoard) });

test('a copy of the OLD board\'s sheet cannot stay when the board moves (SW-544 / SW-251)', () => {
  assert.equal(cannotStay([22, 28], [22, 28], [23, 38]), true);
  assert.equal(cannotStay([22, 28], [22, 28], [31.5, 41.5]), true);
  assert.equal(cannotStay([28, 22], [22, 28], [23, 38]), true, 'orientation-free');
});

test('a parent the NEW board cannot yield cannot stay (SW-097: 25.6×28 onto 23×38)', () => {
  assert.equal(cannotStay([25.6, 28], [25.6, 28], [23, 38]), true);
  assert.equal(cannotStay([24, 30], [26, 30], [23, 38]), true, 'not a copy, one edge too long');
});

test('a genuine trim the new board can yield stays (SW-258: 22×28 off 26×30, onto 25×38)', () => {
  assert.equal(cannotStay([22, 28], [26, 30], [25, 38]), false);
  assert.equal(cannotStay([23, 38], [22, 28], [23, 38]), false, 'already the new board\'s own sheet');
});

test('no parent, or half a parent, is no parent: nothing to clear', () => {
  assert.equal(masterParentCannotStay({ masterParent: null, oldBoard: sheet([22, 28]), newBoard: sheet([23, 38]) }), false);
  assert.equal(cannotStay([null, null], [22, 28], [23, 38]), false);
  assert.equal(cannotStay([22, null], [22, 28], [23, 38]), false);
  assert.equal(cannotStay([null, 28], [22, 28], [23, 38]), false);
});

test('unsized is "cannot judge": never cleared on a guess', () => {
  assert.equal(cannotStay([22, 28], [22, 28], [null, null]), false, 'unsized new board, even over a copy');
  assert.equal(cannotStay([22, 28], [22, 28], [0, 38]), false);
  assert.equal(cannotStay([0, 28], [22, 28], [23, 38]), false, 'a zero-sided parent');
  assert.equal(cannotStay([22, 28], [null, null], [23, 38]), false, 'unsized old board, a parent the new one yields');
  assert.equal(cannotStay([25, 40], [null, null], [23, 38]), true, '…but one the new board cannot yield still goes');
});

test('boards of the same size are no board change: a copy stays', () => {
  assert.equal(cannotStay([23, 38], [23, 38], [23, 38]), false);
  assert.equal(cannotStay([23, 38], [23, 38], [38, 23]), false, 'the same sheet turned around');
});

test('null arguments never throw', () => {
  assert.equal(masterParentCannotStay(), false);
  assert.equal(masterParentCannotStay(null), false);
  assert.equal(masterParentCannotStay({ masterParent: sheet([22, 28]) }), false);
});

test('sameSheet (server): orientation-free, and unsized is never "same"', () => {
  assert.equal(sameSheet(sheet([23, 38]), sheet([38, 23])), true);
  assert.equal(sameSheet(sheet([23, 38]), sheet([23, 38])), true);
  assert.equal(sameSheet(sheet([22, 28]), sheet([23, 38])), false);
  assert.equal(sameSheet(sheet([null, null]), sheet([null, null])), false);
  assert.equal(sameSheet(null, sheet([23, 38])), false);
});

// ── Parity with the client twin ─────────────────────────────────────────────
// The run engine's board pick (setGangBoard) and the single engine's
// (boardSwitch) carry a parent by cutFit.js parentFollowsBoard; the master
// write clears one by masterParentCannotStay. One rule, two spellings — held
// together here, as parent-loses-cuts.test.js holds parentLosesCuts.
// [name, parent, old board, new board, cannot stay]
const FIXTURES = [
  ['SW-544: a copy of #53, onto #399', [22, 28], [22, 28], [23, 38], true],
  ['SW-251: a copy of #53, onto #56', [22, 28], [22, 28], [31.5, 41.5], true],
  ['a copy turned around', [28, 22], [22, 28], [23, 38], true],
  ['SW-097: too big for the new board', [25.6, 28], [25.6, 28], [23, 38], true],
  ['too big in one edge, not a copy', [24, 30], [26, 30], [23, 38], true],
  ['SW-258: a genuine trim that fits', [22, 28], [26, 30], [25, 38], false],
  ['already the new board\'s sheet', [23, 38], [22, 28], [23, 38], false],
  ['same-size boards, a copy', [23, 38], [23, 38], [38, 23], false],
  ['no parent', [null, null], [22, 28], [23, 38], false],
  ['half a parent', [22, null], [22, 28], [23, 38], false],
  ['unsized new board over a copy', [22, 28], [22, 28], [null, null], false],
  ['unsized old board, fits the new', [22, 28], [null, null], [23, 38], false],
  ['unsized old board, too big for the new', [25, 40], [null, null], [23, 38], true],
  ['zero-sided parent', [0, 28], [22, 28], [23, 38], false],
];
const flat = ([l, w]) => ({ l, w });

test('server rule and client twin agree on every fixture', () => {
  for (const [name, parent, oldBoard, newBoard, expected] of FIXTURES) {
    const server = cannotStay(parent, oldBoard, newBoard);
    const client = !!parentFollowsBoard({ parent: flat(parent), oldBoard: flat(oldBoard), newBoard: flat(newBoard) });
    assert.equal(server, client, `${name}: parity`);
    assert.equal(server, expected, `${name}: absolute`);   // both wrong together would still agree
  }
});

// ── Plan-save (orders.js) applies it too ────────────────────────────────────
// lockSharedSheet is driven for real in lock-shared-sheet.test.js; plan-save's
// route is pinned here. A save that moves the master's board without carrying a
// parent judges the one the master keeps, and clears it on the same write.
import { readFileSync } from 'node:fs';
const ORDERS = readFileSync(new URL('./routes/orders.js', import.meta.url), 'utf8');
const planAt = ORDERS.indexOf("r.post('/order-lines/:id/plan'");
const planSave = ORDERS.slice(planAt, ORDERS.indexOf('\nr.', planAt + 1));

// Round 3: the decision lives in planSaveSpec (plan-save.js). Its behaviour is
// driven here and in plan-save-spec.test.js; its source and the route's wiring
// are pinned.
import { planSaveSpec } from './plan-save.js';
const PLAN_SAVE = readFileSync(new URL('./plan-save.js', import.meta.url), 'utf8');
const specFn = PLAN_SAVE.slice(PLAN_SAVE.indexOf('export async function planSaveSpec'));
const BOARD_SHEETS = { 53: sheet([22, 28]), 56: sheet([31.5, 41.5]), 60: sheet([25.6, 28]), 399: sheet([23, 38]) };
const sheetOf = async id => BOARD_SHEETS[id] ?? null;
const SW251 = { id: 251, board_material_id: 53, parent_l: 22, parent_w: 28 };

test('plan-save judges the master\'s own parent when the master\'s board moves without one', async () => {
  const i = s => specFn.indexOf(s);
  assert.ok(i('keepParentOffImpossibleMaster({') >= 0 && i('masterParentCannotStay({ masterParent: current, oldBoard, newBoard })') > i('keepParentOffImpossibleMaster({'));
  assert.match(specFn, /if \(toMaster\.board_material_id != null && !\('parent_l' in toMaster\) && !\('parent_w' in toMaster\)\) \{/);
  assert.match(specFn, /const oldBoard = product\.board_material_id != null \? await sheetOf\(product\.board_material_id\) : null;/);
  assert.match(specFn, /const newBoard = await sheetOf\(toMaster\.board_material_id\);/);
  // a copy of the old board's sheet goes with the board move…
  const copy = await planSaveSpec({ changed: { board_material_id: 399 }, cleared: [], product: SW251, prev: {}, updateMaster: true, sheetOf });
  assert.equal(copy.masterParentCleared, '22×28');
  // …a parent TYPED equal to the master's own is a written parent: it stays while the new board yields it…
  const typedFits = await planSaveSpec({ changed: { board_material_id: 56 }, cleared: ['parent_l', 'parent_w'], product: SW251,
    prev: { parent_l: 23, parent_w: 38 }, updateMaster: true, sheetOf });
  assert.equal(typedFits.masterParentCleared, null);
  // …and goes only when it cannot
  const typedTooBig = await planSaveSpec({ changed: { board_material_id: 399 }, cleared: ['parent_l', 'parent_w'],
    product: { id: 97, board_material_id: 60, parent_l: 25.6, parent_w: 28 }, prev: { parent_l: 23, parent_w: 38 }, updateMaster: true, sheetOf });
  assert.equal(typedTooBig.masterParentCleared, '25.6×28');
});

test('plan-save clears it on the SAME master write, and the plan keeps the parent it was made on', async () => {
  const d = await planSaveSpec({ changed: { board_material_id: 399 }, cleared: [], product: SW251, prev: {}, updateMaster: true, sheetOf });
  assert.deepEqual(d.masterSets, { board_material_id: 399, parent_l: null, parent_w: null }, 'the master lets go');
  assert.deepEqual([d.eff.parent_l, d.eff.parent_w], [22, 28], 'this plan does not: it cuts what the engine showed');
  assert.deepEqual(d.nextOverride, { parent_l: 22, parent_w: 28 });
  assert.deepEqual(d.keptSides, ['parent_l', 'parent_w']);
  assert.equal(d.jobKeeps, '22×28');
  // the keep: per side, what the job already holds, else the master's OLD value
  assert.match(specFn, /const held = f in toJob \|\| \(prev\[f\] != null && !cleared\.includes\(f\)\);/);
  assert.match(specFn, /if \(!held\) \{ toJob\[f\] = product\[f\]; keptSides\.push\(f\); \}/);
  // the route writes the decision: the null parent rides the master write, and the audit says it
  assert.match(planSave, /const masterChanged = \{ \.\.\.decided\.masterSets \};/);
  assert.match(planSave, /parent_l, parent_w: \$\{masterParentCleared\} → none \(follows the board\)/);
  assert.match(planSave, /const \{ toMaster, toJob, nextOverride, eff \} = decided;/);
});

test('plan-save pins the old parent on the product\'s OTHER open plans, before its master write, and says what this plan keeps', () => {
  const at = s => planSave.indexOf(s);
  const pinAt = at('pinParentOnMasterClear({');
  assert.ok(pinAt > at('await planSaveSpec({') && at('UPDATE products SET') > pinAt, 'decide → pin → write');
  assert.match(planSave, /if \(masterParentCleared\) \{\s*parentPinnedLines = await pinParentOnMasterClear\(\{\s*productId: product\.id, oldParent: \{ parent_l: product\.parent_l, parent_w: product\.parent_w \},\s*excludeLineIds: \[line\.id\], user: req\.user\.name, why: 'from planning' \}, qc\);/);
  assert.match(planSave, /jobParentKept = decided\.jobKeeps;/);
  // the plan's own kept sides are audited as a pin, not listed as the planner's job-only edits
  assert.match(planSave, /const ownJob = Object\.entries\(toJob\)\.filter\(\(\[f\]\) => !decided\.keptSides\.includes\(f\)\);/);
  assert.match(planSave, /if \(decided\.keptSides\.length\) \{\s*await audit\('order_line', line\.id, 'parent_pinned',\s*`parent \$\{jobParentKept\} kept — the product master's parent was cleared; this plan keeps the sheet it was made on \(from planning\)`/);
  assert.match(planSave, /let parentPinnedLines = \[\];/);
  assert.match(planSave, /let jobParentKept = null;/);
});

test('plan-save answers master_parent_cleared (L×W or null) and what the master actually took', () => {
  assert.match(planSave, /let masterParentCleared = null;/);
  assert.match(planSave, /master_parent_cleared: masterParentCleared, master_written: masterWritten, parent_pinned_lines: parentPinnedLines, job_parent_kept: jobParentKept \}\);/);
  assert.match(planSave, /masterWritten = Object\.keys\(toMaster\);/);
});
