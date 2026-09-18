// The station workspace's rows, as lean as a station can take them.
//
// GET /floor/:section?completed=kpi was 590 KB decoded at die cutting on live
// prod (2026-09-18): 137 queue rows of ~104 keys each, re-read by every tablet
// on every realtime wave. 190 KB of it was the readiness light written out once
// per row though only 11 distinct lights existed; much of the rest was ids,
// positions and stamps the server had already consumed.
//
// A new bundle adds `fields=lean&lights=ref` on every tab (withLeanRows):
//   lights=ref  each queue row's `light` becomes `light_ref`, an index into a
//               top-level `lights` table, in the same key position
//               (lib/floorLights.js — the Live Floor's own interning).
//   fields=lean queue rows shed QUEUE_LEAN_DROPS; full finished runs shed
//               COMPLETED_LEAN_DROPS.
// rehydrateSection() undoes the refs in load(), before setData. Search is
// rowMatches over JSON.stringify(Object.values(row)), so the light has to be
// back, in place, before anything filters — and the fields dropped below are
// only ones whose values add nothing a person would search for. Human-typed
// text and quantities (line_clearance, inspector, remarks, qty_accepted…)
// stay even where nothing draws them, because search can still reach them.
//
// Old bundles send neither param and get today's bytes. Pure, no React: the
// server (routes/floor.js) builds the lean shape from these same lists, and
// section-lean-rows.test.js pins them and scans every file a station loads.
import { internRowLights, rehydrateRowLights } from './floorLights.js';

// Traced to no reader on a queue row (Section.jsx and everything it imports).
export const QUEUE_LEAN_DROPS = Object.freeze([
  // server-side inputs to the light, the lane order and the receipt, already
  // consumed before the row is sent (the override's by/reason, when it is on,
  // travel inside the light — still searchable there)
  'seq', 'floor_pos', 'queue_pos', 'anchor_line_id', 'card_machine_id',
  'finalised_at', 'ready_override', 'ready_override_by', 'ready_override_at', 'ready_override_reason',
  'extra_issued_parents', 'extra_issued_units',
  // stamps with no reader on a queue row
  'started_at', 'inspected_at', 'po_date',
]);

// A finished run's stamps the Completed tab has no cell for. Everything
// floor-section-payload.test.js pins as read by that tab stays.
export const COMPLETED_LEAN_DROPS = Object.freeze(['finalised_at', 'inspected_at']);

export const LEAN_ROWS_QUERY = 'fields=lean&lights=ref';
export const withLeanRows = p => `${p}${p.includes('?') ? '&' : '?'}${LEAN_ROWS_QUERY}`;

// Exactly the string — an array (`?fields=lean&fields=lean`) or any other value
// gets today's response, like every opt-in mode on this route.
export const leanRowsAsked = query => query?.fields === 'lean';
export const lightRefsAsked = query => query?.lights === 'ref';

// A row without the named keys, every other key in its original order.
function dropKeys(row, keys) {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}
export const leanQueueRow = row => dropKeys(row, QUEUE_LEAN_DROPS);
export const leanFinishedRun = row => dropKeys(row, COMPLETED_LEAN_DROPS);

// The server side: queue (and full finished runs) for the params asked.
export function leanSectionRows({ queue, completed, kpiOnly }, query) {
  const lean = leanRowsAsked(query);
  let rows = lean ? queue.map(leanQueueRow) : queue;
  const runs = lean && !kpiOnly ? completed.map(leanFinishedRun) : completed;
  let lights;
  if (lightRefsAsked(query)) ({ rows, lights } = internRowLights(rows));
  return { queue: rows, completed: runs, lights };
}

// The client side. A response without a lights table (an older server, or a
// request that did not ask) is handed back as the same object.
export function rehydrateSection(res) {
  if (!res || !Array.isArray(res.lights) || !Array.isArray(res.queue)) return res;
  const { lights, ...rest } = res;
  return { ...rest, queue: rehydrateRowLights(res.queue, lights) };
}
