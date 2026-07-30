// Multi-board consumption arithmetic. PURE — plain rows in, numbers out. No pg,
// no await, nothing to mock. Same contract as board-allocation.js, and for the
// same reason: these numbers decide whether a job may be released to the floor.
//
// Client twin of server/src/board-mix.js — the Board Mix panel must show the
// same balance the release gate computes, so a planner can never see a green
// zero balance while the gate stays shut. board-mix.test.js asserts the two
// twins export the same surface and produce identical output — keep them in
// sync.
//
// A job is PLANNED against one board and that never changes. What changes is
// what it actually eats. A mix row says "N parent sheets of THIS board", and
// `covers` converts that into the planned board's units so a balance can be
// struck against a single requirement.
//
// With no rows the mix is inactive and every caller falls through to the
// single-board path it ran before this module existed. See the PROPERTY test in
// board-mix.test.js.

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
  if (!(p > 0)) throw new Error(`board-mix: plannedUps must be greater than zero (got ${p})`);
  if (!(u > 0)) throw new Error(`board-mix: row ups must be greater than zero (got ${u})`);
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
