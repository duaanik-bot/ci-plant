// A parent WRITTEN to a Product Master must be one its OWN board can yield
// (Task 10, final whole-branch review, 19 Sep 2026). "Use the board's full
// sheet" + "Update Product Master(s)" wrote the RUN's board sheet as the
// master's parent — and when the run sat on a JOB-ONLY board (a Smart Match or
// Manual pick, or a GRN substitution) while the master kept its own smaller
// board, the master ended up with a pair the 14-Sep lock refuses on its next
// order. keepParentOffImpossibleMaster keeps such a parent on the job instead
// — never a refusal. It guards parent WRITES; a write that moves the master's
// BOARD under its parent is masterParentCannotStay's
// (master-parent-cannot-stay.test.js, lock-shared-sheet.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepParentOffImpossibleMaster, planLockParent } from './helpers.js';

// SW-544's master after the 18-Sep move: board #399 23×38, no parent on file.
const BOARD_23x38 = { sheet_l: 23, sheet_w: 38 };
// A master that kept its own smaller board (#53, 22×28) while the run moved on.
const BOARD_22x28 = { sheet_l: 22, sheet_w: 28 };

test('a parent the master\'s own board can yield stays on the master', () => {
  const toMaster = { parent_l: 22, parent_w: 28 };
  const toJob = {};
  const out = keepParentOffImpossibleMaster({ toMaster, toJob, master: { board_material_id: 399 }, masterBoard: BOARD_23x38 });
  assert.deepEqual(out, { toMaster: { parent_l: 22, parent_w: 28 }, toJob: {}, keptJobOnly: false });
});

test('the run\'s board sheet on a master whose own board is smaller moves to the job, flagged', () => {
  const out = keepParentOffImpossibleMaster({
    toMaster: { parent_l: 23, parent_w: 38, coating: 'Aqueous Varnish' },
    toJob: { board_material_id: 399 },
    master: { board_material_id: 53, parent_l: null, parent_w: null },
    masterBoard: BOARD_22x28,
  });
  assert.deepEqual(out, {
    toMaster: { coating: 'Aqueous Varnish' },            // everything else still goes to the master
    toJob: { board_material_id: 399, parent_l: 23, parent_w: 38 },
    keptJobOnly: true,
  });
  // …which is exactly the pair the next order's lock would have refused.
  assert.throws(() => planLockParent({ parent_l: 23, parent_w: 38 }, BOARD_22x28), /cannot be trimmed/);
});

test('a board written in the SAME save is the board the parent is judged against', () => {
  // The caller resolves toMaster.board_material_id ?? master.board_material_id
  // and hands over THAT board's sheet — here the new 23×38, not the old 22×28.
  const out = keepParentOffImpossibleMaster({
    toMaster: { board_material_id: 399, parent_l: 23, parent_w: 38 },
    toJob: {},
    master: { board_material_id: 53, parent_l: 22, parent_w: 28 },
    masterBoard: BOARD_23x38,
  });
  assert.deepEqual(out, { toMaster: { board_material_id: 399, parent_l: 23, parent_w: 38 }, toJob: {}, keptJobOnly: false });
});

test('an unsized master board cannot be judged, so the parent stays on the master', () => {
  for (const masterBoard of [null, undefined, {}, { sheet_l: null, sheet_w: null }, { sheet_l: 0, sheet_w: 38 }]) {
    const out = keepParentOffImpossibleMaster({ toMaster: { parent_l: 23, parent_w: 38 }, toJob: {}, master: {}, masterBoard });
    assert.deepEqual(out, { toMaster: { parent_l: 23, parent_w: 38 }, toJob: {}, keptJobOnly: false }, JSON.stringify(masterBoard));
  }
});

test('one axis alone is paired with the master\'s other axis', () => {
  // 30 against the master's 22: the resulting 22×30 does not fit 22×28 — moved.
  const moved = keepParentOffImpossibleMaster({
    toMaster: { parent_w: 30 }, toJob: {},
    master: { parent_l: 22, parent_w: 26 }, masterBoard: BOARD_22x28,
  });
  assert.deepEqual(moved, { toMaster: {}, toJob: { parent_w: 30 }, keptJobOnly: true });
  // 27 against the master's 22: 22×27 fits 22×28 — stays.
  const kept = keepParentOffImpossibleMaster({
    toMaster: { parent_w: 27 }, toJob: {},
    master: { parent_l: 22, parent_w: 26 }, masterBoard: BOARD_22x28,
  });
  assert.deepEqual(kept, { toMaster: { parent_w: 27 }, toJob: {}, keptJobOnly: false });
});

test('half a pair (the master has no other axis) is no pair: left alone', () => {
  const out = keepParentOffImpossibleMaster({
    toMaster: { parent_l: 40 }, toJob: {},
    master: { parent_l: null, parent_w: null }, masterBoard: BOARD_22x28,
  });
  assert.deepEqual(out, { toMaster: { parent_l: 40 }, toJob: {}, keptJobOnly: false });
});

test('a write without a parent is untouched', () => {
  const toMaster = { coating: 'UV', child_l: 12.6, child_w: 23 };
  const toJob = { ups: 4 };
  const out = keepParentOffImpossibleMaster({ toMaster, toJob, master: { parent_l: 40, parent_w: 40 }, masterBoard: BOARD_22x28 });
  assert.deepEqual(out, { toMaster: { coating: 'UV', child_l: 12.6, child_w: 23 }, toJob: { ups: 4 }, keptJobOnly: false });
});

test('the inputs are never mutated', () => {
  const args = {
    toMaster: { parent_l: 23, parent_w: 38, coating: 'UV' },
    toJob: { board_material_id: 399 },
    master: { board_material_id: 53, parent_l: 22, parent_w: 28 },
    masterBoard: { ...BOARD_22x28 },
  };
  const before = structuredClone(args);
  const out = keepParentOffImpossibleMaster(args);
  assert.equal(out.keptJobOnly, true);
  assert.deepEqual(args, before);
  assert.notEqual(out.toMaster, args.toMaster);
  assert.notEqual(out.toJob, args.toJob);
});

test('orientation-free: a parent that is the master board turned around stays', () => {
  const out = keepParentOffImpossibleMaster({ toMaster: { parent_l: 28, parent_w: 22 }, toJob: {}, master: {}, masterBoard: BOARD_22x28 });
  assert.equal(out.keptJobOnly, false);
});

test('null arguments never throw', () => {
  assert.deepEqual(keepParentOffImpossibleMaster(), { toMaster: {}, toJob: {}, keptJobOnly: false });
  assert.deepEqual(keepParentOffImpossibleMaster(null), { toMaster: {}, toJob: {}, keptJobOnly: false });
  assert.deepEqual(keepParentOffImpossibleMaster({ toMaster: null, toJob: null, master: null, masterBoard: null }),
    { toMaster: {}, toJob: {}, keptJobOnly: false });
  assert.deepEqual(keepParentOffImpossibleMaster({ toMaster: { parent_l: 23, parent_w: 38 } }),
    { toMaster: { parent_l: 23, parent_w: 38 }, toJob: {}, keptJobOnly: false });
});

// ── The two master-write doors ──────────────────────────────────────────────
// The run's Lock sheet (gangs.js /shared) is pinned in
// run-sheet-parent-route.test.js; the single engine's plan-save is here. Both
// ask BEFORE their products UPDATE, so the pair never reaches the master.
const ORDERS = readFileSync(new URL('./routes/orders.js', import.meta.url), 'utf8');
const planAt = ORDERS.indexOf("r.post('/order-lines/:id/plan'");
const planSave = ORDERS.slice(planAt, ORDERS.indexOf('\nr.', planAt + 1));

// Round 3: the spec decision itself is planSaveSpec (plan-save.js), driven for
// real here and in plan-save-spec.test.js; the route is pinned to calling it
// before its master UPDATE, with the board sheets and the master question's answer.
import { planSaveSpec } from './plan-save.js';
const PLAN_SAVE = readFileSync(new URL('./plan-save.js', import.meta.url), 'utf8');
const sheets = { 53: { sheet_l: 22, sheet_w: 28 }, 399: { sheet_l: 23, sheet_w: 38 } };
const sheetOf = async id => sheets[id] ?? null;

test('plan-save decides the spec in planSaveSpec — split, then keepParentOffImpossibleMaster, then the override — before its master UPDATE', () => {
  const at = s => planSave.indexOf(s);
  assert.ok(at('await planSaveSpec({') >= 0 && at('UPDATE products SET') > at('await planSaveSpec({'),
    JSON.stringify({ decide: at('await planSaveSpec({'), write: at('UPDATE products SET') }));
  assert.match(ORDERS, /import \{ planSaveSpec \} from '\.\.\/plan-save\.js';/);
  const fn = PLAN_SAVE.slice(PLAN_SAVE.indexOf('export async function planSaveSpec'));
  const i = s => fn.indexOf(s);
  assert.ok(i('splitMasterFields({') >= 0 && i('keepParentOffImpossibleMaster({') > i('splitMasterFields({')
    && i('Object.assign(nextOverride, toJob);') > i('keepParentOffImpossibleMaster({'));
  assert.match(PLAN_SAVE, /import \{[^}]*\bkeepParentOffImpossibleMaster\b[^}]*\} from '\.\/helpers\.js';/);
});

test('plan-save judges a parent bound for the master against the board the master will have', async () => {
  const product = { id: 544, board_material_id: 53, parent_l: 22, parent_w: 28 };
  // the same save moves the board: judged on the NEW board, and the master takes both
  const both = await planSaveSpec({ changed: { board_material_id: 399, parent_l: 23, parent_w: 38 }, cleared: [], product,
    prev: {}, updateMaster: true, masterFields: null, sheetOf });
  assert.equal(both.keptJobOnly, false);
  assert.deepEqual(both.masterSets, { board_material_id: 399, parent_l: 23, parent_w: 38 });
  // the master keeps its own 22×28 board: 23×38 stays on the job
  const kept = await planSaveSpec({ changed: { parent_l: 23, parent_w: 38 }, cleared: [], product,
    prev: { board_material_id: 399 }, updateMaster: true, masterFields: null, sheetOf });
  assert.equal(kept.keptJobOnly, true);
  assert.deepEqual(kept.masterSets, {});
  assert.deepEqual(kept.nextOverride, { board_material_id: 399, parent_l: 23, parent_w: 38 });
  // the route hands it the board sheets and the master question's answer, and reads its verdict
  assert.match(planSave, /changed, cleared, product, prev, updateMaster: !!update_master, masterFields: req\.body\.master_fields,/);
  assert.match(planSave, /sheetOf: id => oc\('SELECT sheet_l, sheet_w FROM materials WHERE id=\$1', \[id\]\),/);
  assert.match(planSave, /parentKeptJobOnly = decided\.keptJobOnly;/);
});

test('plan-save answers parent_kept_job_only: true|false beside its existing shape', () => {
  assert.match(planSave, /let parentKeptJobOnly = false;/);
  assert.match(planSave,
    /res\.json\(\{ \.\.\.out, readiness: await readiness\(out\), board_shortfalls: boardShortfalls, parent_kept_job_only: parentKeptJobOnly,\s*master_parent_cleared: masterParentCleared, master_written: masterWritten, parent_pinned_lines: parentPinnedLines, job_parent_kept: jobParentKept \}\);/);
});

test('plan-save\'s job-only audit says why a parent meant for the master stayed on the job', () => {
  assert.match(planSave, /parentKeptJobOnly \? ' · parent kept job-only — the master\\'s own board cannot yield it' : ''/);
});
