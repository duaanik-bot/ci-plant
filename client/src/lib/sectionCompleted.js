// The station workspace's finished runs — what a tablet on the QUEUE tab
// actually needs of them, and when it asks for the rest.
//
// GET /floor/:section ships 200 finished runs, ~290 KB of a ~400 KB payload at
// cutting and printing on live prod, and every tablet re-reads it on every
// realtime tick. The Completed tab is the only screen that draws those rows. The
// queue tab still COUNTS them, though: once an operator is picked the KPI strip
// is kpisFor(queue, runs) and the Completed tab's label is the length of
// runsForOperator(runs, pick) (operatorScope.js). So the queue tab asks for
// `?completed=kpi` and gets every run as exactly those fields — the numbers on
// screen cannot move — and the full rows come only while the Completed tab is
// open.
//
// Pure, no React: the server builds the projection from this same list
// (routes/floor.js), so the two cannot disagree about which fields survive, and
// section-completed-lazy.test.js runs kpisFor over both shapes.

// id (the row key), what kpisFor sums and dates, and what runsForOperator /
// rowMachineId match a chip on.
export const COMPLETED_KPI_FIELDS = Object.freeze([
  'id', 'completed_at', 'qty_in', 'qty_out', 'qty_scrap',
  'operator', 'machine_id', 'press_machine_id',
]);

export const completedKpiRow = row =>
  Object.fromEntries(COMPLETED_KPI_FIELDS.map(k => [k, row[k]]));

// Full rows only while the Completed tab is on screen. Every other tab reads
// the finished runs for their count and the KPI strip alone.
export const sectionFloorPath = (section, tab) =>
  (tab === 'completed' ? `/floor/${section}` : `/floor/${section}?completed=kpi`);

// True when `completed` holds real rows a table can draw. An older server that
// ignores the param answers with full rows and no marker, which counts as
// ready — a new bundle against an old deploy draws exactly what it did.
export const hasCompletedRows = data => Boolean(data) && data.completed_rows !== 'kpi';

// A tab switch sends a second request while the first is still in flight, and
// the two can land in either order. A lean answer landing after the full one
// would empty the Completed tab under the operator's finger, so an answer
// OLDER than the one on screen is dropped. A newer one always paints, even if
// an older request is still out — a floor refetching faster than the server
// answers must keep moving, never freeze waiting for the last request.
export function latestOnly() {
  let issued = 0;
  let shown = 0;
  return {
    begin: () => ++issued,
    accept: n => {
      if (n < shown) return false;
      shown = n;
      return true;
    },
  };
}
