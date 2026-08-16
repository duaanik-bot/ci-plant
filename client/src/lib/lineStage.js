// Where a Status Sheet line IS right now — one answer per line.
//
// The sheet already showed the whole ROUTE ("Cut✓ Prt… Die"), which reads fine
// as a progress bar on screen and badly in a customer's workbook: they asked
// where the job is, and got a sequence to decode. This module answers the
// question directly, and answers it ONCE — the same value drives the "Where it
// is" chips, the Stages cell and the exported column, so the chip a planner
// clicks and the word the customer reads cannot drift apart.
//
// A CASCADE, not a set of independent tests, for the same reason LINE_STATUS_SQL
// is one (server/src/wip-scope.js): the chips count lines by this key, so a line
// that could answer two of them would double itself in the rail and again in the
// export. Exactly one key per line is the property the rail is built on, and it
// is asserted directly in status-sheet-line-stage.test.js.
//
// Pure, and deliberately a LEAF: no SECTION_META import, so the labels stay in
// one place (the page) and `node --test` can import this without pulling React
// and lucide-react in behind it.

// A stage the floor is actively on. `hold` is NOT here: a held stage has not
// moved the line past itself, and the fallback below already lands on it as the
// first stage not completed — so a hold reads as "still at printing", which is
// what it is.
const RUNNING = new Set(['in_progress', 'partially_completed']);

// Before a job card exists there is no route to stand on, so these come from
// the LINE's own status instead. `ready` sits with `planned`: both mean the
// planner has committed the line and nothing has reached the floor.
const PLANNED_STATUSES = new Set(['planned', 'ready']);

// The chips that are not plant stages. Split into what comes BEFORE the route
// and what comes after, so a rail can be composed as pre → stages → post and
// read as the flow it is.
export const PRE_STAGE_KEYS = ['unplanned', 'planned', 'queued'];
export const POST_STAGE_KEYS = ['done'];

// Labels for those four only — every real stage is named by SECTION_META, which
// stays the single source for stage names.
export const LINE_STAGE_LABEL = {
  unplanned: 'Unplanned',
  planned: 'Planned',
  queued: 'Queued',
  done: 'Done',
};

const state = (key, done, total) => ({ key, done, total });

// Where one line is. Returns { key, done, total } where `key` is a plant stage
// key (`printing`, `die_cutting`, …) or one of PRE_STAGE_KEYS/POST_STAGE_KEYS.
// `done`/`total` describe the route and are 0/0 before a job card exists.
export function lineStageOf(line) {
  const st = (line && line.stages) || [];
  const status = line && line.status;

  // No route yet — the job card has not been raised. Which of the two this is
  // comes from the line's own status, NOT from the empty array: an in_production
  // line whose stages failed to load is on the floor, and filing it under
  // Unplanned would tell the planner to go and plan a job that is already running.
  if (!st.length) {
    if (PLANNED_STATUSES.has(status)) return state('planned', 0, 0);
    return state(status === 'pending' || status == null ? 'unplanned' : 'queued', 0, 0);
  }

  const total = st.length;
  const done = st.filter(s => s.status === 'completed').length;
  if (done === total) return state('done', done, total);

  // The stage actually under someone's hands wins, wherever it sits — a gang
  // parent's stages ride ahead of the member's own, so the route is not
  // guaranteed to progress front-to-back.
  const running = st.find(s => RUNNING.has(s.status));
  if (running) return state(running.stage, done, total);

  // Nothing started and nothing finished: the card exists and the floor has not
  // picked it up. That is a state of its own, and the one the plant calls queued.
  if (done === 0) return state('queued', done, total);

  // Otherwise the line is WAITING at the first stage it has not completed —
  // counted by scanning for it, never by indexing on the completed count, which
  // would skip a waiting stage the moment a later one completed out of sequence.
  const next = st.find(s => s.status !== 'completed');
  return state(next.stage, done, total);
}

// The chip rail: every key in plant order with the lines standing on it.
//
// `stageOrder` is passed in (SECTION_ORDER, from the page) rather than copied
// here, so the rail cannot fall out of step with the plant's own stage list.
// Every stage keeps its chip at zero — a chip that vanished when empty would
// make the rail change width through the day, and "Printing 0" is worth reading.
// A stage present in the DATA but absent from `stageOrder` (a legacy `qc` card)
// is appended rather than dropped: a line nobody can filter to is a line nobody
// can find.
export function lineStageRail(rows, stageOrder = []) {
  const counts = new Map();
  for (const r of rows || []) {
    const { key } = lineStageOf(r);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const known = new Set([...PRE_STAGE_KEYS, ...stageOrder, ...POST_STAGE_KEYS]);
  const extra = [...counts.keys()].filter(k => !known.has(k));
  return [...PRE_STAGE_KEYS, ...stageOrder, ...extra, ...POST_STAGE_KEYS]
    .map(key => ({ key, count: counts.get(key) || 0 }));
}
