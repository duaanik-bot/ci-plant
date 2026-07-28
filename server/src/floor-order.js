// The floor's own queue order.
//
// queue_pos belongs to Print Planning: it lives on job_cards, so it is ONE
// number shared by every section, and dragging a press lane writes it
// (production.js:665). An operator reordering die cutting must not reshuffle a
// planner's press lane, so the floor gets its own per-stage floor_pos and never
// writes queue_pos.
//
// A LANE is one section's queue as the board draws it: the jobs pinned to one
// machine, or the section's unpinned pool. A move never crosses lanes, and
// floor_pos is only ever meaningful WITHIN one lane — position 1 of the die
// cutter's lane says nothing about position 1 of the unpinned pool.

// The plant's own order, before anyone touches the floor board: Print
// Planning's queue, then delivery date, then job card id. This is the order the
// floor had before floor_pos existed, and it stays the tiebreaker everywhere.
export const naturalSort = (a, b) =>
  (a.queue_pos ?? 1e9) - (b.queue_pos ?? 1e9)
  || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))
  || a.job_card_id - b.job_card_id;

// A row's identity within a lane. Stage rows arrive from several queries under
// two different names for the same id, so read both.
const rowId = r => r.stage_id ?? r.id;

// Which lane a row belongs to: its stage, plus the machine it is pinned to (a
// stage is on the machine it started on; an unstarted printing stage is on the
// press Print Planning pinned it to). Rows in different lanes must never be
// ordered against each other by floor_pos.
export const laneKey = r =>
  `${r.stage}#${r.machine_id ?? (r.stage === 'printing' ? (r.press_machine_id ?? '') : '')}`;

// Order ONE lane.
//
// floor_pos is an override, not an absolute rank, so an unstamped row is ranked
// where the plant's own order would have put it — NOT after every stamped row.
// That distinction is the whole point: one arrow press stamps the entire lane
// 1..N, and every job created afterwards arrives with floor_pos NULL. Treating
// NULL as "last" would silently sink each new job below a frozen cohort — a
// rush order booked this morning would sort beneath twelve jobs from last week
// and fall outside the board's top-3 slice entirely.
export function orderLane(lane) {
  const natural = [...lane].sort(naturalSort);
  const naturalRank = new Map(natural.map((j, i) => [rowId(j), i + 1]));
  const rank = j => j.floor_pos ?? naturalRank.get(rowId(j));
  return [...lane].sort((a, b) => rank(a) - rank(b) || naturalSort(a, b));
}

// Order a flat list that spans SEVERAL lanes — the section page and the Sort &
// Paste station, which pour every machine lane and the unpinned pool into one
// list (and, at Sort & Paste, mix sorting rows with pasting rows).
//
// Cross-lane comparison of floor_pos is meaningless, so the list keeps the
// plant's natural order and each lane's manual order is applied only to the
// slots that lane already occupies. Reordering the sorting lane therefore
// reshuffles sorting rows among themselves and leaves the pasting rows exactly
// where the delivery dates put them.
export function orderBoard(rows) {
  const base = [...rows].sort(naturalSort);
  const lanes = new Map();
  base.forEach((r, i) => {
    const k = laneKey(r);
    if (!lanes.has(k)) lanes.set(k, { slots: [], members: [] });
    lanes.get(k).slots.push(i);
    lanes.get(k).members.push(r);
  });
  const out = base.slice();
  for (const { slots, members } of lanes.values()) {
    const ordered = orderLane(members);
    slots.forEach((slot, i) => { out[slot] = ordered[i]; });
  }
  return out;
}

// How the board stacks a lane for display: live work first, then what is
// waiting. Without this a machine card sorted purely by queue order could push
// the job actually ON the press out of the visible top three, taking its
// Complete / Hold / extra-sheets controls off the board with it.
const STATE_RANK = { running: 0, partial: 0, hold: 1, queued: 2, incoming: 3 };
export const byState = (a, b) =>
  (STATE_RANK[a.state] ?? 2) - (STATE_RANK[b.state] ?? 2);

// A lane as the board draws it: running work on top, then the lane's own order.
export const orderForBoard = lane => orderLane(lane).sort((a, b) => byState(a, b));

// Number a lane 1..N in its current board order. Day one every floor_pos is
// NULL; without this the first move would swap two nulls and appear to do
// nothing. Returns copies — the caller's rows are left alone.
export const normalise = lane =>
  orderLane(lane).map((j, i) => ({ ...j, floor_pos: i + 1 }));

// Move one job one place along its lane. Returns only the rows whose floor_pos
// actually changes, as { stage_id, floor_pos } — so the caller writes the
// minimum and can skip the audit entirely when nothing moved. Moving off either
// end returns [], which is a no-op and not an error: the operator pressed a
// button that had nowhere to go.
export function moveWithin(lane, stageId, dir) {
  const ordered = normalise(lane);
  const from = ordered.findIndex(j => rowId(j) === stageId);
  if (from === -1) return [];
  const to = dir === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= ordered.length) return [];

  const before = new Map(lane.map(j => [rowId(j), j.floor_pos ?? null]));
  const changed = row => before.get(row.stage_id) !== row.floor_pos;

  // The mover and its neighbour trade floor_pos; everyone else keeps theirs,
  // unless normalise just gave it a first real value (day one, an all-null
  // lane) — that also counts as a write.
  const mover = { stage_id: rowId(ordered[from]), floor_pos: ordered[to].floor_pos };
  const displaced = { stage_id: rowId(ordered[to]), floor_pos: ordered[from].floor_pos };
  const rest = ordered
    .filter((_, idx) => idx !== from && idx !== to)
    .map(j => ({ stage_id: rowId(j), floor_pos: j.floor_pos }));

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
  const out = new Map();
  for (const [id, lane] of pinned) out.set(id, orderForBoard(lane));
  return { pinned: out, unpinned: orderForBoard(unpinned) };
}
