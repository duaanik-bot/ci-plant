// The client half of GET /planning?scope= (server/src/planning-scope.js).
//
// Planning loads its QUEUE on open and on every realtime refresh, and the
// COMPLETED half (in_production lines — 72% of the old payload) only when the
// Completed or All tab, or a deep link to a pushed job, needs it. These helpers
// put the two halves back together so every list on the page — the tabs, All,
// the selection, the focus lookup — reads one array exactly as it did when the
// server sent everything at once.
//
// Pure, so server/src/planning-scope.test.js can pin them without a browser.

const PUSHED = 'in_production';

// LINE_VIEW's own ORDER BY: newest sales order first, lines in id order within
// it. The table re-sorts by order_id, but ties keep this order, so the merge has
// to rebuild it rather than just concatenating the halves.
const byServerOrder = (a, b) => (Number(b.order_id) - Number(a.order_id)) || (Number(a.id) - Number(b.id));

// `completed` null = not loaded yet: the queue alone. A line can turn up in
// both halves when it moved between the two fetches (a push, a rollback); it is
// listed once, and the QUEUE copy wins — the queue is refetched on every
// refresh, so it is never the older of the two for long.
export function mergePlanningScopes(queue, completed) {
  const q = queue || [];
  if (!completed || !completed.length) return q;
  const inQueue = new Set(q.map(l => l.id));
  return [...q, ...completed.filter(l => !inQueue.has(l.id))].sort(byServerOrder);
}

// A scoped response is `{ scope, lines, counts }`. A bare array means a server
// that predates the scope param (mid-deploy): it answered EVERYTHING, so there
// is no completed half left to fetch and no served counts to read.
export function readPlanningScope(res) {
  if (Array.isArray(res)) return { lines: res, counts: null, legacy: true };
  return { lines: res?.lines || [], counts: res?.counts || null, legacy: false };
}

// Which half holds a run's lines — the server's rule, mirrored: a run is
// completed only when every member still on /planning is pushed. A member past
// planning altogether (dispatched, cancelled) is not on /planning and does not
// vote. A loose line is a run of one.
export function planningScopeOfRun(members) {
  const live = (members || []).filter(m => ['pending', 'planned', 'ready', PUSHED].includes(m.status));
  return live.length && live.every(m => m.status === PUSHED) ? 'completed' : 'queue';
}

// Where a deep link (a bell, ?line=) stands against the halves on hand.
//   found  — the row is here and its tab can draw it: switch tabs and scroll.
//   wait   — not decidable yet: the job is missing from the queue half and the
//            completed half has not loaded (or is older than the last refresh),
//            OR it is a pushed job whose Completed tab lists nothing until that
//            half lands. The page fetches the completed half and asks again.
//   absent — looked in BOTH halves and it is not there: it really left planning,
//            and only now may the card say so.
// A stale half still counts as able to DRAW a found row (its rows are refreshed
// in place, not blanked); it only cannot prove a row is missing.
// `absentOnce` is the job this link already proved ABSENT. That answer stands
// through later refreshes: a dispatched job does not come back to planning by
// itself, and re-asking would send the whole completed half again on every
// refresh while the card is open, and blink its "left the queue" line off and on.
// Only a different job, or the job turning up in the rows (a rollback), reopens it.
export function planningFocusState(lines, lineId, { doneLoaded = false, doneStale = false, absentOnce = null } = {}) {
  const line = (lines || []).find(l => Number(l.id) === Number(lineId)) || null;
  const settled = absentOnce != null && Number(absentOnce) === Number(lineId);
  if (!line) return { state: settled || (doneLoaded && !doneStale) ? 'absent' : 'wait', line: null };
  if (line.status === PUSHED && !doneLoaded) return { state: 'wait', line };
  return { state: 'found', line };
}

// Is the completed half on hand older than the list? It is from the moment a
// refresh that SKIPS it starts (nobody was on Completed or All), because the
// change that fired that refresh — a push, a dispatch — may be exactly what
// Completed is missing. Deciding on the refresh's ANSWER instead left a window
// the width of one queue fetch: a planner who pushed a job and clicked Completed
// before the queue came back got the old half, flagged stale only after the tab
// had already chosen not to refetch, and it stayed old until some other change
// on the floor happened to fire a refresh.
//
// So every completed answer is judged by when it was ASKED for: each fetch takes
// a token at its start, and the answer is fresh only if no queue-only refresh
// started after that. An old slow answer landing after a newer refresh began is
// therefore stale, not "just fetched".
export function createDoneFreshness() {
  let refreshes = 0;   // queue-only refreshes started so far
  let held = null;     // `refreshes` as it stood when the answer on hand was asked for
  return {
    // Call synchronously, BEFORE the queue-only request goes out.
    queueOnlyRefreshStarting() { refreshes += 1; },
    // Call as a completed (or a whole-list) request goes out; hand the token back on landing.
    doneFetchStarting() { return refreshes; },
    doneFetchLanded(token) { held = token; },
    // Nothing held is "not loaded yet", which the caller checks on its own.
    isStale() { return held != null && held < refreshes; },
  };
}
