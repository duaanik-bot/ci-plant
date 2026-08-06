// A parent sheet that cannot be trimmed from the board is not this job's parent.
//
// LIVE INCIDENT (CI-JC-0050, 04–06 Aug 2026). Product SW-419 carried a stale
// 22×28 parent — a fossil of the FBB 250 GSM 22x28 board the run was first
// created on — while the run's board was 20×39. effectiveParent honours an
// explicit master parent, so childFit measured 19×20 children against 22×28
// and returned ONE up where the board gives TWO. That single wrong number rode
// the whole way to the guillotine: the card was stamped children_per_parent=1,
// the cutter's honest 6,000 CHILD sheets were read as 6,000 PARENTS, the
// completion rewrote sheets_issued from the 3,000 Planning had locked to 6,000,
// and a phantom 3,000-sheet stock write-on was raised against the warehouse.
//
// orders.js's single-line plan-save already refuses this shape with a 409. The
// gang/run path and readiness() never asked, so nothing stopped it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cuttingParent, effectiveParent, parentFitsBoard, childFit } from './helpers.js';

// The live rows, exactly as they stood.
const SW419 = { parent_l: 22, parent_w: 28, child_l: 19, child_w: 20 };
const BOARD_20x39 = { id: 358, sheet_l: 20, sheet_w: 39 };

test('an explicit parent that FITS its board is still honoured — cuts stay frozen', () => {
  const product = { parent_l: 20, parent_w: 38, child_l: 19, child_w: 20 };
  const board = { sheet_l: 20, sheet_w: 39 };
  const p = cuttingParent(product, board);
  assert.equal(p.sheet_l, 20);
  assert.equal(p.sheet_w, 38);
});

test('a parent that cannot be trimmed from the board falls back to the board', () => {
  const p = cuttingParent(SW419, BOARD_20x39);
  assert.equal(p.sheet_l, 20);
  assert.equal(p.sheet_w, 39);
});

test('the live shape yields 2 up, not 1 — the number that caused the doubling', () => {
  // What actually ran:
  assert.equal(childFit(effectiveParent(SW419, BOARD_20x39), SW419).count, 1);
  // What the board physically gives, and what the fix returns:
  assert.equal(childFit(cuttingParent(SW419, BOARD_20x39), SW419).count, 2);
});

test('effectiveParent is UNCHANGED, so the parentFitsBoard guard still fires', () => {
  // orders.js:1341 and grn-substitution.js:143 both detect the impossible shape
  // by asking parentFitsBoard(effectiveParent(...), board). If the fallback had
  // been folded into effectiveParent, that check would go vacuously true and
  // both guards would silently stop working.
  const raw = effectiveParent(SW419, BOARD_20x39);
  assert.equal(raw.sheet_l, 22);
  assert.equal(raw.sheet_w, 28);
  assert.equal(parentFitsBoard(raw, BOARD_20x39), false);
});

test('no board, or an unsized board, leaves the master parent alone', () => {
  assert.equal(cuttingParent(SW419, null).sheet_l, 22);
  assert.equal(cuttingParent(SW419, { sheet_l: null, sheet_w: null }).sheet_l, 22);
});

test('a product with no parent of its own keeps reading the board', () => {
  const p = cuttingParent({ child_l: 19, child_w: 20 }, BOARD_20x39);
  assert.equal(p.sheet_l, 20);
  assert.equal(p.sheet_w, 39);
});
