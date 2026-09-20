// Plan-save's spec decisions — where each edited field goes, and the parent this
// plan is cut on — are planSaveSpec (plan-save.js), driven here for real.
//
// Round 3 of Task 10 (final review, 19 Sep 2026): when a save moved the master's
// board and cleared the master's parent (masterParentCannotStay), the plan was
// cut on the board's full sheet while the engine had shown the old parent —
// 2,600 parent sheets on screen, 1,300 written, the toast saying 2,600. Two ways
// in: a board pick whose carry the planner re-typed (flow A), and a line on a
// JOB-ONLY board where the client carries nothing because it judges against
// that board while the server judges against the master's (flow B).
//
// The rule: existing plans keep the parent they were made on; only future orders
// follow the board. Each test runs the single engine's own client twins
// (cutFit.js boardSwitch, engineParent, and changedSpec's rule) over the same
// inputs and holds the plan-save parent to what the engine shows: screen = lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSaveSpec } from './plan-save.js';
import { childFit, planLockParent } from './helpers.js';
import { boardSwitch, engineParent, clientFit, parentTooBig } from '../../client/src/lib/cutFit.js';

const B53 = { id: 53, sheet_l: 22, sheet_w: 28 };
const B56 = { id: 56, sheet_l: 31.5, sheet_w: 41.5 };
const B399 = { id: 399, sheet_l: 23, sheet_w: 38 };
const B60 = { id: 60, sheet_l: 25.6, sheet_w: 28 };
const BOARDS = [B53, B56, B399, B60];
const sheetOf = async id => {
  const b = BOARDS.find(x => x.id === +id);
  return b ? { sheet_l: b.sheet_l, sheet_w: b.sheet_w } : null;
};
// SW-251: board #53 (22×28), and a parent that is #53's own sheet.
const SW251 = { id: 251, code: 'SW-251', ups: 2, child_l: 14, child_w: 20, parent_l: 22, parent_w: 28,
  board_material_id: 53, wastage_pct: 5 };
// SW-097: board #60 (25.6×28), parent #60's own sheet — 23×38 cannot yield it.
const SW097 = { id: 97, code: 'SW-097', ups: 2, child_l: 12, child_w: 13, parent_l: 25.6, parent_w: 28,
  board_material_id: 60, wastage_pct: 5 };

// The single engine end to end, as Planning.jsx runs it: openPlan seeds the
// Parent fields from the saved parent (LINE_VIEW: per side, the job's override,
// else the master's); a board pick asks boardSwitch; the planner may type;
// changedSpec sends a side only when it differs from the one on file, and the
// board only when it differs from the line's own. Then plan-save's diff of the
// spec against the MASTER (changed / cleared), exactly as orders.js makes it.
function engineSave({ product, prev = {}, from, to, typed = {}, updateMaster = true, masterFields }) {
  const saved = { l: prev.parent_l ?? product.parent_l, w: prev.parent_w ?? product.parent_w };
  let form = { parent_l: saved.l != null ? String(saved.l) : '', parent_w: saved.w != null ? String(saved.w) : '' };
  const sw = boardSwitch({ form, saved, from: { l: from.sheet_l, w: from.sheet_w }, to: { l: to.sheet_l, w: to.sheet_w } });
  if (sw.fill) form = { ...form, ...sw.fill };
  form = { ...form, ...typed };
  const shown = engineParent({ form, saved, board: { l: to.sheet_l, w: to.sheet_w } }).parent;
  const spec = {};
  for (const [f, s] of [['parent_l', saved.l], ['parent_w', saved.w]]) {
    if (form[f] !== '' && String(+form[f]) !== String(+s)) spec[f] = +form[f];
  }
  if (to.id !== from.id) spec.board_material_id = to.id;
  const changed = {}, cleared = [];
  for (const [f, v] of Object.entries(spec)) {
    if (String(v) !== String(product[f])) changed[f] = v; else cleared.push(f);
  }
  return {
    shown, spec, carried: !!sw.fill,
    args: { changed, cleared, product, prev, updateMaster, masterFields: masterFields ?? (updateMaster ? Object.keys(changed) : null), sheetOf },
  };
}
const parentOf = eff => ({ l: eff.parent_l, w: eff.parent_w });
// The cuts the engine counts (clientFit) and the lock writes (planLockParent → childFit).
const cutsShown = (s, product) => clientFit(s.shown.l, s.shown.w, product.child_l, product.child_w)?.cpp;
const cutsLocked = (d, board) => childFit(planLockParent(d.eff, board), d.eff).count;

test('flow A: the carry re-typed back to 22×28 — the plan is cut on 22×28, as the engine showed', async () => {
  const s = engineSave({ product: SW251, from: B53, to: B56, typed: { parent_l: '22', parent_w: '28' } });
  assert.equal(s.carried, true, 'the pick carried 31.5×41.5 into the fields');
  assert.deepEqual(s.spec, { board_material_id: 56 }, 'nothing about the parent is sent');
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, '22×28');
  assert.deepEqual(d.masterSets, { board_material_id: 56, parent_l: null, parent_w: null }, 'the master still lets go');
  assert.deepEqual(parentOf(d.eff), s.shown, 'screen = lock');
  assert.deepEqual(d.nextOverride, { parent_l: 22, parent_w: 28 });
  assert.equal(d.jobKeeps, '22×28');
  assert.equal(cutsLocked(d, B56), cutsShown(s, SW251));
  assert.equal(cutsLocked(d, B56), 2, '2 per sheet: 2,600 parent sheets, not 1,300');
});

test('flow B: a JOB-ONLY board, a pick the client carries nothing for — the plan cuts what the engine showed', async () => {
  const s = engineSave({ product: SW251, prev: { board_material_id: 399 }, from: B399, to: B56 });
  assert.equal(s.carried, false, '22×28 is no copy of 23×38 and fits 31.5×41.5: nothing to carry');
  assert.deepEqual(s.spec, { board_material_id: 56 });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, '22×28', 'judged against the MASTER\'s board #53: a copy of it');
  assert.deepEqual(d.masterSets, { board_material_id: 56, parent_l: null, parent_w: null });
  assert.deepEqual(parentOf(d.eff), s.shown, 'screen = lock');
  assert.deepEqual(d.nextOverride, { parent_l: 22, parent_w: 28 }, 'the board override went with the board to the master');
  assert.equal(cutsLocked(d, B56), cutsShown(s, SW251));
});

test('a side the planner typed keeps the typed value; the other keeps the one on file', async () => {
  const s = engineSave({ product: SW251, from: B53, to: B56, typed: { parent_l: '30', parent_w: '28' }, masterFields: ['board_material_id'] });
  assert.deepEqual(s.spec, { board_material_id: 56, parent_l: 30 });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, '22×28');
  assert.deepEqual(parentOf(d.eff), s.shown);
  assert.deepEqual(parentOf(d.eff), { l: 30, w: 28 });
  assert.equal(d.jobKeeps, '30×28');
});

test('a kept parent the new board cannot yield meets the 14-Sep refusal — the engine\'s "larger than board" pill said so', async () => {
  const s = engineSave({ product: SW097, from: B60, to: B399, typed: { parent_l: '25.6', parent_w: '28' } });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, '25.6×28');
  assert.deepEqual(parentOf(d.eff), s.shown, 'screen = lock');
  assert.equal(parentTooBig({ parentL: s.shown.l, parentW: s.shown.w, boardL: 23, boardW: 38 }), true);
  assert.throws(() => planLockParent(d.eff, B399), /cannot be trimmed/);
});

test('the carry accepted and sent to the master: the master takes both, nothing is cleared or kept', async () => {
  const s = engineSave({ product: SW251, from: B53, to: B56 });
  assert.deepEqual(s.spec, { board_material_id: 56, parent_l: 31.5, parent_w: 41.5 });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, null);
  assert.deepEqual(d.masterSets, { board_material_id: 56, parent_l: 31.5, parent_w: 41.5 });
  assert.deepEqual(d.nextOverride, {});
  assert.deepEqual(parentOf(d.eff), s.shown);
  assert.equal(d.jobKeeps, null);
});

test('a board change for this job only touches no master: the plan cuts what the engine showed', async () => {
  const s = engineSave({ product: SW251, prev: { board_material_id: 399 }, from: B399, to: B56, updateMaster: false });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, null);
  assert.deepEqual(d.masterSets, {});
  assert.deepEqual(d.nextOverride, { board_material_id: 56 });
  assert.deepEqual(parentOf(d.eff), s.shown);
});

test('a parent the master\'s own board cannot yield still stays on the job (keepParentOffImpossibleMaster)', async () => {
  // The one-click on the job-only board #399 fills its sheet; the board itself is unchanged.
  const d = await planSaveSpec({ changed: { parent_l: 23, parent_w: 38 }, cleared: [], product: SW251,
    prev: { board_material_id: 399 }, updateMaster: true, masterFields: ['parent_l', 'parent_w'], sheetOf });
  assert.equal(d.keptJobOnly, true);
  assert.deepEqual(d.masterSets, {});
  assert.deepEqual(d.nextOverride, { board_material_id: 399, parent_l: 23, parent_w: 38 });
  assert.deepEqual(parentOf(d.eff), { l: 23, w: 38 });
});

test('a parent typed equal to the master\'s own, onto a board that yields it, stays on the master', async () => {
  const s = engineSave({ product: SW251, prev: { parent_l: 23, parent_w: 38 }, from: B53, to: B56, typed: { parent_l: '22', parent_w: '28' } });
  const d = await planSaveSpec(s.args);
  assert.equal(d.masterParentCleared, null);
  assert.deepEqual(d.masterSets, { board_material_id: 56 });
  assert.deepEqual(d.nextOverride, {}, 'the typed parent IS the master\'s');
  assert.deepEqual(parentOf(d.eff), s.shown);
});

test('screen = lock across every flow above', async () => {
  const flows = [
    engineSave({ product: SW251, from: B53, to: B56, typed: { parent_l: '22', parent_w: '28' } }),
    engineSave({ product: SW251, prev: { board_material_id: 399 }, from: B399, to: B56 }),
    engineSave({ product: SW251, from: B53, to: B56, typed: { parent_l: '30', parent_w: '28' }, masterFields: ['board_material_id'] }),
    engineSave({ product: SW251, from: B53, to: B56 }),
    engineSave({ product: SW251, prev: { board_material_id: 399 }, from: B399, to: B56, updateMaster: false }),
    engineSave({ product: SW251, prev: { parent_l: 23, parent_w: 38 }, from: B53, to: B56, typed: { parent_l: '22', parent_w: '28' } }),
    engineSave({ product: SW251, from: B53, to: B399 }),
    engineSave({ product: SW251, from: B53, to: B399, masterFields: ['board_material_id'] }),
  ];
  for (const [i, s] of flows.entries()) {
    const d = await planSaveSpec(s.args);
    assert.deepEqual(parentOf(d.eff), s.shown, `flow ${i}: ${JSON.stringify(s.spec)}`);
  }
});
