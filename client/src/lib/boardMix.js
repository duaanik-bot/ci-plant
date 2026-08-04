// Multi-board consumption arithmetic. PURE — plain rows in, numbers out. No pg,
// no await, nothing to mock. Same contract as board-allocation.js, and for the
// same reason: these numbers decide whether a job may be released to the floor.
//
// Client twin of server/src/board-mix.js — the Board Mix panel must show the
// same balance the release gate computes, so a planner can never see a green
// zero balance while the gate stays shut. One necessary exception to the
// verbatim rule: the import below reaches this file's own boardCode.js, while
// the server copy reaches board-code.js instead. board-mix.test.js asserts the
// two twins export the same surface and produce identical output — keep them
// in sync.
//
// A job is PLANNED against one board and that never changes. What changes is
// what it actually eats. A mix row says "N parent sheets of THIS board", and
// `covers` converts that into the planned board's units so a balance can be
// struck against a single requirement.
//
// With no rows the mix is inactive and every caller falls through to the
// single-board path it ran before this module existed. See the PROPERTY test in
// board-mix.test.js.
import { parseBoardName } from './boardCode.js';

const EPS = 1e-6;
const num = v => Number(v || 0);

// The planned requirement, in PARENT (mother) sheets — the unit the warehouse
// stocks and the planning engine already stores on the line.
//
// This is a deliberate COPY of board-allocation.js's lineNeed, not an import of
// it. Board Position reads lineNeed and the mix panel reads lineRequirement
// against the very same line object in the same request, so the two must move
// in lockstep by hand whenever the parent/child fallback rule changes.
// board-allocation.js is not imported here because it has no client twin —
// pulling it in would drag an untwinned module into boardMix.js's browser copy.
export function lineRequirement(line) {
  return num(line?.parent_sheets_required ?? line?.sheets_required);
}

// How much of the planned requirement one row satisfies, in planned-board
// parent sheets. A board that cuts more children per sheet covers more than its
// own sheet count; one that cuts fewer covers less.
//
// Both ups values are hard preconditions rather than defaults. childFit()
// returns `{ count: 1, sized: false }` for a board with no dimensions, so a
// silent zero here would mean an unsized board quietly covered nothing — or
// everything — instead of being rejected at the point of entry. `sheets` gets
// no such guard: a bad sheet count is already caught by the route and by the
// DB's own CHECK (sheets > 0) on job_board_mix, so it is left to arithmetic
// here rather than validated a third time.
export function rowCovers({ sheets, ups, plannedUps }) {
  const p = num(plannedUps);
  const u = num(ups);
  if (!(p > 0)) throw new Error(`board-mix: plannedUps must be greater than zero (got ${plannedUps})`);
  if (!(u > 0)) throw new Error(`board-mix: row ups must be greater than zero (got ${ups})`);
  return num(sheets) * u / p;
}

// The whole job's position. Takes `required` as a plain number rather than a
// line: most callers already have it on hand (readiness()'s parentNeeded, a
// confirm step's already-resolved total) and would otherwise fake a
// `{ parent_sheets_required }` object just to satisfy this function. A caller
// holding a line instead calls `mixBalance({ required: lineRequirement(line), rows })`.
//
// `balanced` is an EPS comparison, never `=== 0`: sheets and covers are DOUBLE
// PRECISION and an exact-zero test on floats is the trap that already caught
// the replenishment code.
export function mixBalance({ required, rows = [] }) {
  const req = num(required);
  const covered = rows.reduce((s, r) => s + num(r.covers), 0);
  const balance = req - covered;
  return {
    active: rows.length > 0,
    required: req,
    covered,
    balance,
    // Meaningless without `active`: with no mix, `balance` equals the WHOLE
    // requirement, which would render as "4,000 to allocate" on a job that was
    // never put on a mix at all. Always check `active` before reading either.
    balanced: rows.length > 0 && Math.abs(balance) < EPS,
  };
}

// Which rows name a board that is not actually holding their sheets.
//
// mixBalance answers only the ARITHMETIC half of "is this job covered" — do the
// rows sum to the requirement. readiness() has always asked the other half too
// (its `mixStocked` loop: every row's own board must still hold what is written
// against it, "or the gate would open on a plan whose substitute stock has since
// been eaten by another job"). This is that loop, in one place, so the planner's
// panel and the release gate cannot disagree.
//
// It exists because they DID disagree, on live line 128: a mix of 700 + 200
// against a 900 requirement balanced perfectly and showed 'Fully covered ✓',
// while the 700-sheet board had been emptied to zero. The planner was told the
// job was covered by a screen that had never asked whether the board was there.
//
// `available` is OPTIONAL per row. A caller that never fetched it gets an empty
// answer rather than a false alarm — absence of evidence is not a shortage, and
// several callers (the job card print path, a half-typed row) legitimately have
// no availability to hand.
export function mixUnstockedRows(rows = []) {
  return rows.filter(r => r?.available != null && num(r.sheets) > num(r.available));
}

// What goes on a substitute row the planner did not write a reason for.
//
// Blank used to be impossible — plan-save 400'd on it. Now it saves, and the
// owner asked for "a by default reason like covering the alternate" rather than
// a NULL: the job card, the allocation note and the audit trail all read one
// plain sentence instead of an empty cell, and a planner with something better
// to say still types straight over it.
//
// It lives in the twin modules, not in the route, so the CLIENT can pre-fill
// exactly what the server would otherwise fall back to — the planner reads the
// sentence before it is recorded, never after.
export const DEFAULT_MIX_REASON = 'Covering with the alternate board';

// Is this candidate an acceptable substitute for the planned board, and how
// much does the difference cost the plant?
//
// GRADE IS FIXED — a Saffire job is never offered Duplex GB. This is enforced,
// not warned: grade is the customer's specification, GSM and size are the
// plant's problem. A name that does not parse is blocked too, because the
// alternative is guessing at a grade.
//
// `plannedUps` / `candidateUps` are childFit(board, child).count, computed by
// the caller — childFit lives in helpers.js, which reaches the database, and
// this module stays pure.
//
// severity: 'none'    the planned board itself
//           'warn'    different GSM, or a different size cutting the same ups
//           'heavy'   the ups change — a different imposition and so its own plate
//           'blocked' different grade, an unreadable board name, or no usable ups
export function substitutionFlags({ plannedBoard, candidateBoard, plannedUps, candidateUps }) {
  const planned = parseBoardName(plannedBoard?.name);
  const cand = parseBoardName(candidateBoard?.name);
  const blocked = () => ({
    ok: false, grade_ok: false, gsm_delta: null, size_differs: null,
    ups_differ: null, severity: 'blocked', reason_required: false,
  });
  if (!planned || !cand) return blocked();

  const gradeOk = planned.grade.trim().toLowerCase() === cand.grade.trim().toLowerCase();
  if (!gradeOk) return blocked();

  // A board that cuts nothing is not a substitute, and a caller that supplied
  // no cut plan has not asked a meaningful question. num() maps undefined to 0,
  // so without this an omitted argument reads as "same ups" and the row saves.
  // childFit returns count 0 for a sized board the child does not fit at all
  // (helpers.js:104) — those must never reach the planner's candidate list.
  if (!(num(plannedUps) > 0) || !(num(candidateUps) > 0)) return blocked();

  const samePlanned = plannedBoard?.id != null && plannedBoard.id === candidateBoard?.id;
  const gsmDelta = cand.gsm - planned.gsm;
  const sizeDiffers = cand.sheet_l !== planned.sheet_l || cand.sheet_w !== planned.sheet_w;
  const upsDiffer = num(candidateUps) !== num(plannedUps);

  const severity = samePlanned ? 'none' : upsDiffer ? 'heavy' : 'warn';
  return {
    ok: true,
    grade_ok: true,
    gsm_delta: gsmDelta,
    size_differs: sizeDiffers,
    ups_differ: upsDiffer,
    severity,
    reason_required: severity !== 'none',
  };
}

// What one mixed job contributes to a single board's position.
//
// Returns null when the job has no mix at all — the caller then runs exactly
// the single-board maths it ran before this module existed, which is the whole
// safety contract of this feature.
//
// The rule that matters: only the PLANNED board carries the unmet remainder. A
// substitute board is never "needed" beyond the sheets explicitly written
// against it. Without that, a job planned on 300 GSM and taking 1,500 sheets of
// 290 GSM would count its entire 4,000-sheet requirement against the 290 GSM
// stock too — which reads as over-committed and raises a purchase request for
// board nobody intends to buy.
export function mixPosition({ line, rows = [], materialId, plannedBoardId }) {
  if (!rows.length) return null;
  const mine = rows.filter(r => r.material_id === materialId);
  const held = mine.reduce((s, r) => s + num(r.sheets), 0);
  const { balance } = mixBalance({ required: lineRequirement(line), rows });
  const open_need = materialId === plannedBoardId ? Math.max(0, balance) : 0;
  return { held, open_need };
}
