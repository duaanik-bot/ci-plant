// Multi-board consumption arithmetic. PURE — plain rows in, numbers out. No pg,
// no await, nothing to mock. Same contract as board-allocation.js, and for the
// same reason: these numbers decide whether a job may be released to the floor.
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
// everything — instead of being rejected at the point of entry.
export function rowCovers({ sheets, ups, planned_ups }) {
  const p = num(planned_ups);
  const u = num(ups);
  if (!(p > 0)) throw new Error('board-mix: planned_ups must be greater than zero');
  if (!(u > 0)) throw new Error('board-mix: row ups must be greater than zero');
  return num(sheets) * u / p;
}

// The whole job's position. `balanced` is an EPS comparison, never `=== 0`:
// sheets and covers are DOUBLE PRECISION and an exact-zero test on floats is
// the trap that already caught the replenishment code.
export function mixBalance({ line, rows = [] }) {
  const required = lineRequirement(line);
  const covered = rows.reduce((s, r) => s + num(r.covers), 0);
  const balance = required - covered;
  return {
    active: rows.length > 0,
    required,
    covered,
    balance,
    balanced: rows.length > 0 && Math.abs(balance) < EPS,
  };
}
