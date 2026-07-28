// The floor's own queue order.
//
// queue_pos belongs to Print Planning: it lives on job_cards, so it is ONE
// number shared by every section, and dragging a press lane writes it
// (production.js:665). An operator reordering die cutting must not reshuffle a
// planner's press lane, so the floor gets its own per-stage floor_pos and never
// writes queue_pos.
//
// A LANE is one section's queue as the board draws it: the jobs pinned to one
// machine, or the section's unpinned pool. A move never crosses lanes.

// Board order, used by every floor board so the four cannot drift: the floor's
// own order first, then Print Planning's, then delivery date, then job card id.
export const boardSort = (a, b) =>
  (a.floor_pos ?? 1e9) - (b.floor_pos ?? 1e9)
  || (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)
  || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))
  || a.job_card_id - b.job_card_id;

// Number a lane 1..N in its current board order. Day one every floor_pos is
// NULL; without this the first move would swap two nulls and appear to do
// nothing. Returns copies — the caller's rows are left alone.
export const normalise = lane =>
  [...lane].sort(boardSort).map((j, i) => ({ ...j, floor_pos: i + 1 }));

// Move one job one place along its lane. Returns only the rows whose floor_pos
// actually changes, as { stage_id, floor_pos } — so the caller writes the
// minimum and can skip the audit entirely when nothing moved. Moving off either
// end returns [], which is a no-op and not an error: the operator pressed a
// button that had nowhere to go.
export function moveWithin(lane, stageId, dir) {
  const ordered = normalise(lane);
  const from = ordered.findIndex(j => j.stage_id === stageId);
  if (from === -1) return [];
  const to = dir === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const before = new Map(lane.map(j => [j.stage_id, j.floor_pos ?? null]));
  const changed = row => before.get(row.stage_id) !== row.floor_pos;

  // The mover and its neighbour trade floor_pos; everyone else keeps theirs,
  // unless normalise just gave it a first real value (day one, an all-null
  // lane) — that also counts as a write.
  const mover = { stage_id: ordered[from].stage_id, floor_pos: ordered[to].floor_pos };
  const displaced = { stage_id: ordered[to].stage_id, floor_pos: ordered[from].floor_pos };
  const rest = ordered
    .filter((_, idx) => idx !== from && idx !== to)
    .map(j => ({ stage_id: j.stage_id, floor_pos: j.floor_pos }));

  // Reported mover-first: "this job moved, swapping with that one" reads the
  // same regardless of whether the move was 'up' or 'down' — sorting by the
  // resulting floor_pos instead would flip the pair depending on direction.
  return [...rest, mover, displaced].filter(changed);
}

// Split a section's live work the way the board draws it: each machine's own
// pinned jobs, and the section's unpinned pool ONCE.
//
// /floor/machines used to rebuild the unpinned pool per machine (floor.js:351),
// so one unstarted die-cutting job was handed to all seven die-cutting cards —
// and because the top-3 slice ran after the merge, those duplicates pushed real
// pinned work off the card. A job pinned to a machine that is not on this board
// (a scoped-out press) falls into `unpinned` rather than vanishing; its row
// still prints its machine name.
export function splitByMachine(jobs, machineIds) {
  const pinned = new Map(machineIds.map(id => [id, []]));
  const unpinned = [];
  for (const j of jobs) {
    if (j.machine_id != null && pinned.has(j.machine_id)) pinned.get(j.machine_id).push(j);
    else unpinned.push(j);
  }
  for (const lane of pinned.values()) lane.sort(boardSort);
  unpinned.sort(boardSort);
  return { pinned, unpinned };
}
