// Where an edited master-driven field is filed when the plan saves.
//
// The planning engine has always asked one question — "job only, or update the
// Product Master?" — and applied the answer to every field edited in that save.
// A planner who retunes ups for good and trims the parent for this run only had
// to answer for both at once, and either answer filed one of the two changes in
// the wrong place: the master learning a one-off trim, or a permanent ups
// correction living on as a job override nobody else inherits.
//
// The answer is now per FIELD. `masterFields` is the subset the planner ticked;
// everything else in the same save falls through to the job override. Passing
// null (or omitting it) keeps the old all-or-nothing behaviour exactly, which
// is what the mix confirm and "Save for this Job Only" still send.
//
// Pure and separate from the route so the rule can be pinned without standing a
// database up — same reason board-mix.js and board-allocation.js live apart
// from the handlers that call them.
import { keepParentOffImpossibleMaster, masterParentCannotStay, parentFitsBoard } from './helpers.js';

export function splitMasterFields({ changed = {}, updateMaster = false, masterFields = null } = {}) {
  const toMaster = {};
  const toJob = {};
  for (const [field, value] of Object.entries(changed)) {
    // A field is promoted only when the planner said yes AND (they said yes to
    // everything, or named this one). Anything else stays on the job — the
    // safe direction: a job override affects one job, a master write affects
    // every job this product ever runs again.
    if (updateMaster && (!Array.isArray(masterFields) || masterFields.includes(field))) toMaster[field] = value;
    else toJob[field] = value;
  }
  return { toMaster, toJob };
}

// ── The spec half of plan-save ───────────────────────────────────────────────
// Where each edited field goes (master or job), what the master write carries,
// and the spec this plan is cut on — one async function with no database of its
// own (the board sheets it needs come through `sheetOf`), so the decision is
// driven for real by plan-save-spec.test.js, the way lockSharedSheet is for the
// run engine (Task 10, round 3). orders.js's plan route calls it, then writes.
//   changed, cleared  plan-save's diff of the sent spec against the product
//                     master: fields that differ, and fields set BACK to it
//   product           the product master row as the save found it
//   prev              the line's job override before this save ({} for none)
//   updateMaster, masterFields  the master question's answer (splitMasterFields)
//   sheetOf           async board id → { sheet_l, sheet_w }
// Returns:
//   toMaster, toJob       where each changed field goes
//   masterSets            what the products UPDATE writes (before the board's
//                         derived name/grade/GSM, which the route adds)
//   nextOverride          the line's job override after this save
//   eff                   the spec this plan is cut on
//   keptJobOnly           a parent meant for the master stayed on this job
//   masterParentCleared   'L×W' of the master parent this save clears, or null
//   keptSides             the parent sides this plan keeps from the cleared master
//   jobKeeps              'L×W' of the parent this plan keeps when the master's
//                         is cleared, or null
export async function planSaveSpec({ changed = {}, cleared = [], product, prev = {}, updateMaster = false, masterFields = null, sheetOf }) {
  let { toMaster, toJob } = splitMasterFields({ changed, updateMaster, masterFields });
  let keptJobOnly = false;
  // A parent this save carries to the master must be one the master's own
  // board can yield (keepParentOffImpossibleMaster, helpers.js): "Use the
  // board's full sheet" on a job-only board, answered "Update Product Master",
  // stays on this job instead. Judged against the board the master will HAVE —
  // this save's, else its own.
  if ('parent_l' in toMaster || 'parent_w' in toMaster) {
    const boardId = toMaster.board_material_id ?? product.board_material_id;
    const masterBoard = boardId != null ? await sheetOf(boardId) : null;
    ({ toMaster, toJob, keptJobOnly } = keepParentOffImpossibleMaster({ toMaster, toJob, master: product, masterBoard }));
  }
  // …and a save that moves the master's BOARD without carrying a parent leaves
  // it the one it already has, which must be able to stay on the new board
  // (masterParentCannotStay — the same judgement lockSharedSheet makes,
  // gangs.js). One that cannot is cleared on the same master write.
  let masterParentCleared = null;
  if (toMaster.board_material_id != null && !('parent_l' in toMaster) && !('parent_w' in toMaster)) {
    const current = { sheet_l: product.parent_l, sheet_w: product.parent_w };
    const oldBoard = product.board_material_id != null ? await sheetOf(product.board_material_id) : null;
    const newBoard = await sheetOf(toMaster.board_material_id);
    // A parent TYPED equal to the master's own (filed as "set back to the
    // master") is one this save carries: it stays while the new board can
    // yield it, like any written parent.
    const typed = cleared.includes('parent_l') && cleared.includes('parent_w');
    const cannotStay = typed
      ? current.sheet_l != null && current.sheet_w != null && !parentFitsBoard(current, newBoard)
      : masterParentCannotStay({ masterParent: current, oldBoard, newBoard });
    if (cannotStay) masterParentCleared = `${current.sheet_l}×${current.sheet_w}`;
  }
  toJob = { ...toJob };
  // The plan being saved keeps the parent it was made on — the one the engine
  // SHOWED (cutFit.js engineParent: per side, the typed value, else the one on
  // file) — and only future orders follow the board (final review, round 3:
  // the lock cut 31.5×41.5 and wrote 1,300 parent sheets under a screen that
  // showed 2,600 on 22×28). Per side: what this job already holds — a typed
  // value, or its own override — else the master's OLD value. A kept parent
  // the new board cannot yield meets the 14-Sep refusal at lock, as the
  // engine's "larger than board" pill said it would.
  const keptSides = [];
  if (masterParentCleared) {
    for (const f of ['parent_l', 'parent_w']) {
      const held = f in toJob || (prev[f] != null && !cleared.includes(f));
      if (!held) { toJob[f] = product[f]; keptSides.push(f); }
    }
  }
  const noParent = masterParentCleared ? { parent_l: null, parent_w: null } : {};
  const masterSets = Object.keys(toMaster).length ? { ...toMaster, ...noParent } : {};
  // The job override after this save: what was there, less the fields set back
  // to the master and the ones the master now carries, plus this save's own.
  const nextOverride = { ...prev };
  for (const f of cleared) delete nextOverride[f];
  for (const f of Object.keys(toMaster)) delete nextOverride[f];
  Object.assign(nextOverride, toJob);
  // Effective spec = master as this save leaves it + the job override + this save's changes.
  const eff = { ...product, ...noParent, ...nextOverride, ...changed };
  const jobKeeps = masterParentCleared ? `${eff.parent_l}×${eff.parent_w}` : null;
  return { toMaster, toJob, masterSets, nextOverride, eff, keptJobOnly, masterParentCleared, keptSides, jobKeeps };
}
