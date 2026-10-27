// Idle job cards — live cards nobody has touched for a fortnight.
//
// Job Cards (`/job-cards?scope=live`) and the Live Floor (`/floor`) each carried
// EVERY live card on every load and every realtime refetch. On live prod the
// live cards doubled in a month (129 on 20 Sep → 277 on 17 Oct), and 111 of the
// 277 had not moved for 14 days or more — so both screens slowed 2–3× with work
// nobody was looking at. A screen that sends `?idle=hide` now gets the active
// cards only, plus a count of the idle ones; it asks for the full list again
// when someone clicks "Show". No param is the legacy answer, byte for byte:
// plant tablets keep an old bundle open for days.
//
// A live card (open / in_progress) is IDLE when ALL of:
//   1. its last activity is IDLE_DAYS or more ago — the latest of the card's
//      created_at and finalised_at, every stage's started_at, completed_at and
//      inspected_at, and every day-wise count (stage_runs.created_at);
//   2. no stage of it is in_progress, partially_completed or on hold — work on a
//      machine or on hold stays on screen however old it is;
//   3. every OTHER live card of its gang / combined run is idle too.
//      stampBoardState / stampPlateState collapse a run to its weakest member
//      over the set they are handed, so a run split between the two halves would
//      read two different verdicts (the same reason planning-scope.js splits by
//      run).
import { q } from './db.js';

export const IDLE_DAYS = 14;

// Only the new bundles ask, two ways:
//   idle=hide — leave the idle cards out, and say how many and which;
//   idle=mark — the full list, plus the same count, so the screen that is
//               showing them can still offer to hide them again.
// Anything else — no param, a typo, a repeated param — is the legacy request
// and gets the legacy answer.
export const IDLE_MODES = Object.freeze(['hide', 'mark']);
export const idleModeOf = query => (IDLE_MODES.includes(query?.idle) ? query.idle : null);

// One row per live card, the facts the rule needs and nothing else.
export const IDLE_FACTS_SQL = `
  SELECT jc.id, jc.gang_run_id,
         GREATEST(jc.created_at, jc.finalised_at,
                  MAX(js.started_at), MAX(js.completed_at), MAX(js.inspected_at),
                  MAX(sr.created_at)) AS last_at,
         COALESCE(BOOL_OR(js.status IN ('in_progress', 'partially_completed', 'hold')), false) AS working
  FROM job_cards jc
  LEFT JOIN job_stages js ON js.job_card_id = jc.id
  LEFT JOIN stage_runs sr ON sr.job_stage_id = js.id
  WHERE jc.status IN ('open', 'in_progress')
  GROUP BY jc.id, jc.gang_run_id, jc.created_at, jc.finalised_at`;

// Pure: rows of IDLE_FACTS_SQL → the Set of idle card ids.
export function idleCardIds(rows, now = new Date(), days = IDLE_DAYS) {
  const cutoff = now.getTime() - days * 86400000;
  // A missing stamp is never read as quiet: show the card.
  const quiet = r => !r.working && r.last_at != null && new Date(r.last_at).getTime() <= cutoff;
  const runAwake = new Set();
  for (const r of rows) if (r.gang_run_id != null && !quiet(r)) runAwake.add(r.gang_run_id);
  const ids = new Set();
  for (const r of rows) {
    if (quiet(r) && (r.gang_run_id == null || !runAwake.has(r.gang_run_id))) ids.add(r.id);
  }
  return ids;
}

export async function loadIdleCardIds(qc = q, now = new Date()) {
  return idleCardIds(await qc(IDLE_FACTS_SQL), now);
}

// What the Live Floor left out, per section: every unfinished stage of an idle
// card is a row that would have sat in that section's band (an idle card has no
// running or held stage, so these are queued and incoming rows). `machineIds` is
// a press-scoped login's presses — /floor keeps only printing rows pinned to one
// of them, so the count does too. Rows: { job_card_id, stage, status, machine_id }
// where machine_id is the stage's machine, else the card's (the board's pin).
export function idleBySection(rows, sections, machineIds = null) {
  const keep = machineIds ? new Set(machineIds) : null;
  const counts = Object.fromEntries(sections.map(s => [s, 0]));
  const cards = new Set();
  for (const r of rows) {
    if (r.status === 'completed' || !(r.stage in counts)) continue;
    if (keep && r.stage === 'printing' && (r.machine_id == null || !keep.has(r.machine_id))) continue;
    counts[r.stage] += 1;
    cards.add(r.job_card_id);
  }
  return { cards: cards.size, sections: counts };
}
