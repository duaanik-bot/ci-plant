// Extra sheets off a DIFFERENT board — the warehouse pick.
//
// PURE. Plain rows in, a decision out. No pg, no await, nothing to mock — the
// picker renders exactly what the approve route re-derives, so what the plant
// head reads on screen cannot drift from what the transaction does. Same
// contract grn-substitution.js and planMove() hold.
//
// ── Why this exists ────────────────────────────────────────────────────────
// A press running short of 50 sheets is a ten-minute problem. Until now the
// approval refused it outright whenever the PLANNED board had nothing
// uncommitted left — even with 1,711 sheets of the same grade and the same
// 31.5×41.5 sheet, one GSM lighter, sitting on the next rack. The plant then
// does it anyway, off the books, and the ERP's stock is wrong by evening.
// Refusing a decision the plant head is entitled to make does not prevent the
// substitution; it only stops the ERP from recording it.
//
// So the rule here is NOT "is this the same board" — it is:
//
//   CAN the guillotine cut this job's sheet out of it?   → physics. Refuse.
//   SHOULD it?                                            → the plant head's
//                                                           call, on a named
//                                                           reason, on the record.
//
// Everything the software can prove, it enforces. Everything else it puts in
// front of the one person authorised to decide, with the cost stated.
//
// ── The one number that must not lie ───────────────────────────────────────
// The operator asks for PARENT sheets because he is counting the pile he will
// carry. What he actually needs is PRINT sheets at the press. On the planned
// board those are locked together by children_per_parent. On a different SIZE
// they are not: 50 parents of 31.5×41.5 give 200 print sheets at 4-up; 50
// parents of 25×36 give 100 at 2-up. Approve 50 on the substitute and the
// press is still 100 sheets short, and nobody finds out until it stops again.
//
// So every candidate carries its OWN cuts and its OWN yield, and `parentsFor`
// exists so the approver can ask the opposite question — how many parents of
// THIS board buy me the print sheets I was actually short of.

import { childFit, cuttingParent, parentFitsBoard } from './helpers.js';

const num = v => Number(v || 0);
const dim = n => Math.round(num(n) * 100) / 100;
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const sheetOf = b => (num(b?.sheet_l) > 0 && num(b?.sheet_w) > 0)
  ? `${dim(b.sheet_l)}×${dim(b.sheet_w)}″`
  : 'size not on file';

// Cuts one parent sheet of `board` yields for this product.
//
// cuttingParent is the whole reason this is one line: it already answers "what
// sheet actually goes under the guillotine" — the declared parent when it fits
// the board, the board itself when it cannot. A 22×28 sheet cannot yield a
// 31.5×41.5 parent, but it still yields ONE 15.75×20.75 child, and on a night
// shift that is a real answer. Nothing here re-decides that; it just counts.
export function cutsOn(product, board) {
  return childFit(cuttingParent(product, board), product).count;
}

// How many parent sheets of `board` buy `printSheets` at the press.
// The inverse of qty × cuts, and the question the approver actually has once
// the cuts move under him.
export function parentsFor(printSheets, cuts) {
  const c = Math.max(0, Math.round(num(cuts)));
  const n = Math.max(0, Math.round(num(printSheets)));
  if (!c || !n) return null;
  return Math.ceil(n / c);
}

// ── The verdict ────────────────────────────────────────────────────────────
//
// `blocked` is physics and is never overridable. `cautions` are consequences —
// each one a thing that changes on the floor, stated in the floor's own words,
// and each one the plant head's to accept. `short` is stock: free is what is
// genuinely unpromised, shelf is what is physically there, and the gap between
// them is board already booked to someone else's job.
//
// Note what is NOT a caution: trim waste on a board of the same size, or a
// price difference. Both are real and neither changes whether the job runs.
export function judge(candidate, {
  planned, product, needed, plannedCuts, stage = 'printing',
} = {}) {
  const c = candidate || {};
  const isPlanned = planned && Number(c.id) === Number(planned.id);
  const free = Math.max(0, Math.round(num(c.free)));
  const shelf = Math.max(0, Math.round(num(c.shelf)));
  const want = Math.max(0, Math.round(num(needed)));

  // ── Physics: refusals no reason can buy out of ──────────────────────────
  if (!c.id) return blocked(c, 'That board is not on the material master.');
  if (c.category && c.category !== 'board')
    return blocked(c, `${c.name || 'That material'} is not a board.`);
  if (c.active != null && Number(c.active) === 0 && !isPlanned)
    return blocked(c, `${c.name || 'That board'} is retired from the master.`);
  if (!shelf) return blocked(c, 'Nothing on the shelf — this board has no available stock.');

  const cuts = cutsOn(product, c);
  if (!(cuts > 0)) {
    return blocked(c, `A ${dim(product?.child_l)}×${dim(product?.child_w)}″ print sheet cannot be cut `
      + `from a ${sheetOf(c)} sheet — no guillotine enlarges board.`);
  }

  // ── Consequences: the plant head's to accept, one named reason each ─────
  const cautions = [];
  const parentFits = parentFitsBoard(
    { sheet_l: product?.parent_l, sheet_w: product?.parent_w }, c);
  const gradeMoved = planned && !same(planned.grade, c.grade);
  const gsmMoved = planned && num(planned.gsm) !== num(c.gsm);
  const sizeMoved = planned && (num(planned.sheet_l) !== num(c.sheet_l) || num(planned.sheet_w) !== num(c.sheet_w));

  if (gradeMoved) {
    cautions.push({
      axis: 'grade',
      text: `${c.grade || 'Unstated grade'} is not ${planned.grade || 'the planned grade'} — ink lay-down, `
        + `shade and stiffness all move. The carton will not match the rest of the run.`,
    });
  }
  if (gsmMoved) {
    const lighter = num(c.gsm) < num(planned.gsm);
    cautions.push({
      axis: 'gsm',
      text: `${c.gsm || '?'} GSM against the planned ${planned.gsm || '?'} GSM — ${lighter ? 'lighter' : 'heavier'} `
        + `caliper. ${lighter ? 'Creasing and stacking change' : 'Feed and creasing change'} on the press.`,
    });
  }
  if (sizeMoved) {
    cautions.push({
      axis: 'size',
      text: `${sheetOf(c)} against the planned ${sheetOf(planned)}`
        + (parentFits
          ? ` — the ${dim(product?.parent_l)}×${dim(product?.parent_w)}″ parent still trims out of it.`
          : ` — the ${dim(product?.parent_l)}×${dim(product?.parent_w)}″ parent does NOT trim out of it, so the `
            + `sheet itself goes under the guillotine and the cut is re-planned at the table.`),
    });
  }
  if (plannedCuts != null && cuts !== Math.max(1, Math.round(num(plannedCuts)))) {
    // The loudest one. Everything above changes how the job looks; this
    // changes how many sheets the press actually gets.
    cautions.push({
      axis: 'cuts',
      text: `${cuts} print sheets per parent, not ${Math.max(1, Math.round(num(plannedCuts)))} — `
        + `${want} parents of this board yield ${want * cuts} print sheets, not ${want * Math.max(1, Math.round(num(plannedCuts)))}. `
        + `Re-check the quantity before approving.`,
    });
  }

  const short = want > 0 && free < want;
  const beyondShelf = want > 0 && shelf < want;

  return {
    id: Number(c.id),
    name: c.name || c.code || `Material #${c.id}`,
    code: c.code || null,
    grade: c.grade || null,
    gsm: c.gsm ?? null,
    sheet_l: c.sheet_l ?? null,
    sheet_w: c.sheet_w ?? null,
    sheets_per_packet: c.sheets_per_packet ?? null,
    leftover: Number(c.leftover) === 1,
    size_label: sheetOf(c),
    planned: !!isPlanned,
    free, shelf,
    committed_elsewhere: Math.max(0, shelf - free),
    cuts,
    // Cutting takes parent sheets away as parent sheets; every other stage is
    // fed the children. Same conditional the route and issue path already use.
    yield_sheets: stage === 'cutting' ? want : want * cuts,
    parent_fits: parentFits,
    same_grade: !gradeMoved,
    same_gsm: !gsmMoved,
    same_size: !sizeMoved,
    // exact  — indistinguishable from the planned board on every axis
    // grade  — same grade, sheet or caliper moved
    // cross  — a different grade of board entirely
    kind: isPlanned ? 'planned' : (!gradeMoved && !gsmMoved && !sizeMoved) ? 'exact' : gradeMoved ? 'cross' : 'grade',
    blocked: false,
    block_reason: null,
    cautions,
    short,
    beyond_shelf: beyondShelf,
    short_reason: beyondShelf
      ? `Only ${shelf} sheets physically on the shelf; ${want} are needed.`
      : short
        ? `${free} free, ${Math.max(0, shelf - free)} of the ${shelf} on the shelf are already booked to other jobs.`
        : null,
  };
}

const blocked = (c, reason) => ({
  id: c.id != null ? Number(c.id) : null,
  name: c.name || c.code || (c.id != null ? `Material #${c.id}` : 'Unknown material'),
  code: c.code || null,
  grade: c.grade || null,
  gsm: c.gsm ?? null,
  sheet_l: c.sheet_l ?? null,
  sheet_w: c.sheet_w ?? null,
  size_label: sheetOf(c),
  planned: false,
  free: Math.max(0, Math.round(num(c.free))),
  shelf: Math.max(0, Math.round(num(c.shelf))),
  committed_elsewhere: 0,
  cuts: 0,
  yield_sheets: 0,
  parent_fits: false,
  kind: 'blocked',
  blocked: true,
  block_reason: reason,
  cautions: [],
  short: true,
  beyond_shelf: true,
  short_reason: reason,
});

// Rank: what a storeman would reach for, in order.
//
// The planned board is always first even when it is empty — the approver must
// see WHY he is being offered alternatives before he sees the alternatives.
// After that, closeness beats abundance: an identical board with 60 free sheets
// is a better answer than a different grade with 9,550, because the second one
// changes the carton. Only within the same closeness does stock decide.
const RANK = { planned: 0, exact: 1, grade: 2, cross: 3, blocked: 9 };

export function rankOptions(options, needed) {
  const want = Math.max(0, Math.round(num(needed)));
  return [...options].sort((a, b) => {
    if (a.planned !== b.planned) return a.planned ? -1 : 1;
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    // Covers the requirement outright, before anything that does not.
    const ca = a.free >= want, cb = b.free >= want;
    if (ca !== cb) return ca ? -1 : 1;
    const ra = RANK[a.kind] ?? 8, rb = RANK[b.kind] ?? 8;
    if (ra !== rb) return ra - rb;
    // Same closeness, same coverage → fewest consequences, then most stock.
    if (a.cautions.length !== b.cautions.length) return a.cautions.length - b.cautions.length;
    if (a.free !== b.free) return b.free - a.free;
    return String(a.name).localeCompare(String(b.name));
  });
}

// The one gate the approve route calls. Returns the blockers that must stop the
// transaction, so the route cannot forget one the dialog showed.
//
// `override` is the plant head saying, in as many words, "take it off a board
// that is booked to another job". It is never inferable and never a default —
// the caller has to pass it, and a reason has to come with it, because the job
// it is taken from will go short and someone has to own that.
export function gateSubstitution({
  candidate, planned, product, needed, plannedCuts, stage,
  reason = '', override = false,
} = {}) {
  const v = judge(candidate, { planned, product, needed, plannedCuts, stage });
  const blockers = [];

  if (v.blocked) blockers.push(v.block_reason);
  if (!v.planned && !String(reason || '').trim())
    blockers.push('Say why the planned board is not being used — it goes on the job card and the audit trail.');
  if (!v.blocked && v.beyond_shelf)
    blockers.push(v.short_reason);
  else if (!v.blocked && v.short && !override)
    blockers.push(v.short_reason);
  if (!v.blocked && v.short && override && !String(reason || '').trim())
    blockers.push('Taking board that is booked to another job needs a reason on the record.');

  return { ok: blockers.length === 0, blockers, verdict: v };
}
