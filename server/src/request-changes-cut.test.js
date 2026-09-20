// requestChangesCut replaces round 2's cutPlanInputs as the gate reDeriveMemberSheets'
// three callers use to decide whether a request actually touches a member's
// cut. cutPlanInputs keyed the EFFECTIVE child (override over master) — wrong
// for a CO-PRINTED run, whose child reDeriveMemberSheets (and sharedLayoutState,
// routes/gangs.js ~179) reads from the OVERRIDE alone. A layout still pending
// has no override, so its "effective" child is just whatever the master
// happens to carry — and a patch that matched that master value read as
// unchanged, so the re-derive that settles the layout never ran. This is the
// two-click heal case (test 5) that cutPlanInputs silently ate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestChangesCut } from './helpers.js';

const master = (extra = {}) => ({ ups: 4, child_l: 10, child_w: 13,
  parent_l: 22, parent_w: 28, board_material_id: 544, ...extra });
const oline = (id, product_id, extra = {}) => ({ id, product_id, spec_override: null, ...extra });

test('1. a coating-only patch is not a cut change', () => {
  const gang = { kind: 'gang', layout_mode: 'separate' };
  const masters = new Map([[157, master()]]);
  const lines = [oline(1, 157)];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { coating: 'Gloss' } }), false);
});

test('2. the same board every member already cuts on is not a change; a different one is', () => {
  const gang = { kind: 'gang', layout_mode: 'separate' };
  const masters = new Map([[157, master({ board_material_id: 544 })]]);
  const lines = [oline(1, 157), oline(2, 157)];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { board_material_id: 544 } }), false);
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { board_material_id: 999 } }), true);
});

test('3. a merge with two orders of one product: a parent change on the shared master is seen', () => {
  const gang = { kind: 'merge', layout_mode: 'separate' };
  const masters = new Map([[157, master({ parent_l: 22, parent_w: 28 })]]);
  const lines = [oline(1, 157), oline(2, 157)];   // two sales orders of the SAME product
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { parent_l: 23, parent_w: 38 } }), true);
});

test('4. co-printed, a settled layout: the SAME child is not a change; a different one is', () => {
  const gang = { kind: 'gang', layout_mode: 'shared' };
  const masters = new Map([[157, master()]]);   // the master's own 10x13 is irrelevant here
  const ov = JSON.stringify({ child_l: 19, child_w: 21 });
  const lines = [oline(1, 157, { spec_override: ov }), oline(2, 157, { spec_override: ov })];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { child_l: 19, child_w: 21 } }), false);
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { child_l: 12, child_w: 19 } }), true);
});

test("5. co-printed, a PENDING layout: settling it at the master's own size is still a change — the two-click heal", () => {
  const gang = { kind: 'gang', layout_mode: 'shared' };
  const masters = new Map([[157, master({ child_l: 12, child_w: 19 })]]);
  const lines = [oline(1, 157, { spec_override: null }), oline(2, 157, { spec_override: null })];
  // The EFFECTIVE child (override-over-master) is already 12x19 — cutPlanInputs
  // would have called this "unchanged". requestChangesCut compares the co-printed
  // child against the OVERRIDE alone (there is none), so it is seen as a change.
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { child_l: 12, child_w: 19 } }), true);
});

test('6. co-printed: a parent in the patch is ignored — a co-printed run never reads one', () => {
  const gang = { kind: 'gang', layout_mode: 'shared' };
  const masters = new Map([[157, master()]]);
  const ov = JSON.stringify({ child_l: 19, child_w: 21 });
  const lines = [oline(1, 157, { spec_override: ov })];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { parent_l: 23, parent_w: 38 } }), false);
});

test("7. a numeric value normalises regardless of how it arrived — '12.60' equals 12.6", () => {
  const gang = { kind: 'gang', layout_mode: 'separate' };
  const masters = new Map([[157, master({ child_l: 12.6 })]]);
  const lines = [oline(1, 157)];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { child_l: '12.60' } }), false);
});

test('8. an ups change is seen', () => {
  const gang = { kind: 'gang', layout_mode: 'separate' };
  const masters = new Map([[157, master({ ups: 4 })]]);
  const lines = [oline(1, 157)];
  assert.equal(requestChangesCut({ gang, lines, masters, patch: { ups: 5 } }), true);
});

test('9. null or empty inputs never throw', () => {
  assert.doesNotThrow(() => requestChangesCut({ gang: null, lines: [], masters: new Map(), patch: {} }));
  assert.doesNotThrow(() => requestChangesCut({ gang: undefined, lines: undefined, masters: undefined, patch: undefined }));
  assert.doesNotThrow(() => requestChangesCut({
    gang: { kind: 'gang', layout_mode: 'separate' },
    lines: [oline(1, 157, { spec_override: null })],
    masters: new Map(),   // no entry for product_id 157 at all
    patch: { board_material_id: 999 },
  }));
  assert.equal(requestChangesCut({ gang: null, lines: [], masters: new Map(), patch: {} }), false);
});
