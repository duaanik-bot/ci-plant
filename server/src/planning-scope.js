// GET /planning?scope= — which half of the Planning list a request is for.
//
// Pure, and kept out of the route so the split is testable without a database
// (planning-scope.test.js), the same way set-type.js carries the zone rules.
//
// Why a split at all: live /planning was 1,516 KB for 370 lines, and 269 of
// them were in_production — 72% of every load, and of every realtime refetch on
// every planner's screen, was the Completed tab. The planner opens on To Plan,
// which never renders one of those lines. So the page asks for the QUEUE first
// and for COMPLETED only when that tab (or All, or a deep link to a pushed job)
// needs it.
//
// No scope is the legacy request and answers the legacy bare array, byte for
// byte: plant tablets keep an old bundle open for days, and that bundle calls
// setLines() straight on the response.
//
// client/src/lib/planningScope.js mirrors the RUN rule (planningScopeOfRun) —
// change one, change both.

export const PLANNING_SCOPES = Object.freeze(['queue', 'completed']);

// A line that has left the planner's queue: pushed onward to a job card.
const PUSHED = 'in_production';

// null = no scope asked (legacy). An unknown value is refused rather than
// quietly answered with the whole 1.5 MB list — a misspelt scope in a new
// bundle should show up the first time it runs, not as a slow page.
export function planningScopeOf(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'string' && PLANNING_SCOPES.includes(raw)) return raw;
  const err = new Error(`Unknown planning scope — use one of: ${PLANNING_SCOPES.join(', ')}`);
  err.status = 400;
  throw err;
}

// Split BY RUN, never by line. stampBoardState and stampPlateState collapse a
// gang or combined run to its WEAKEST member, over the rows they are handed. A
// run with one member still planned and one already pushed would read Board OK
// in the queue half and Short in the completed half if its members were split
// between them. So a run goes to `completed` only when EVERY member in the list
// is pushed; otherwise the whole run stays in `queue`, pushed members included.
// The client filters tabs by status, so a pushed member riding in the queue
// half still lands on the Completed tab once both halves are merged.
//
// Order within each half is the input's (LINE_VIEW's ORDER BY), so merging the
// two halves on that same key rebuilds the legacy list exactly.
export function partitionPlanningLines(rows, { gangIdOf = l => l.gang_run_id } = {}) {
  const runStillQueued = new Set();
  for (const l of rows) {
    const g = gangIdOf(l);
    if (g != null && l.status !== PUSHED) runStillQueued.add(g);
  }
  const queue = [];
  const completed = [];
  for (const l of rows) {
    const g = gangIdOf(l);
    const done = l.status === PUSHED && (g == null || !runStillQueued.has(g));
    (done ? completed : queue).push(l);
  }
  return { queue, completed };
}

// The tab badges, served with EITHER half so To Plan can show "Completed 269"
// without fetching the 269. Line counts by status — exactly what the badges
// counted off the full list (Planning.jsx `pending/planned/completed.length`,
// `lines.length`), not run counts and not scope sizes.
export function planningCounts(rows) {
  const c = { pending: 0, planned: 0, completed: 0, all: rows.length };
  for (const l of rows) {
    if (l.status === 'pending') c.pending++;
    else if (l.status === 'planned' || l.status === 'ready') c.planned++;
    else if (l.status === PUSHED) c.completed++;
  }
  return c;
}

// The whole response. `build` is the route's per-row work (readiness, light,
// board and plate verdicts…) and is handed ONLY the rows of the asked scope —
// that is where the saving is. No scope hands it every row and returns what it
// returns, untouched.
export async function planningResponse(rawScope, rows, build) {
  const scope = planningScopeOf(rawScope);
  if (!scope) return build(rows);
  const part = partitionPlanningLines(rows);
  return { scope, lines: await build(part[scope]), counts: planningCounts(rows) };
}
