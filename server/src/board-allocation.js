// Board allocation arithmetic. PURE — plain rows in, numbers out. No pg, no
// await, nothing to mock. The numbers here decide real purchase quantities, so
// they are unit-tested against a transcription of the formula they replace.
//
// A board's stock splits three ways:
//   available = what the warehouse physically has
//   held      = the part earmarked for named jobs (board_allocations)
//   free      = available - held, the part still up for grabs
//
// A job's requirement splits the same way: some held for it from stock, some
// already on order for it, and an OPEN NEED that still has to come from free
// stock or a new purchase. Only open needs compete.
//
// With an empty allocations table every hold is zero, so free == available and
// every open need == the full requirement — which reduces exactly to the
// pre-allocation formula. See the PROPERTY test in board-allocation.test.js.

const num = v => Number(v || 0);
const isActive = a => a.status === 'active';

// Board demand is counted in PARENT (mother) sheets — the unit the warehouse
// stocks and every Available column reports. sheets_required is the CHILD print
// sheet count, so using it raw over-states demand by children_per_parent.
export function lineNeed(line) {
  return num(line?.parent_sheets_required ?? line?.sheets_required);
}

export function heldFor(allocations = [], orderLineId) {
  return allocations
    .filter(a => isActive(a) && a.source === 'stock' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

export function incomingFor(allocations = [], orderLineId) {
  return allocations
    .filter(a => isActive(a) && a.source === 'requisition' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

export function boardPosition({ available, allocations = [] }) {
  const avail = num(available);
  const held = allocations
    .filter(a => isActive(a) && a.source === 'stock')
    .reduce((s, a) => s + num(a.qty), 0);
  return { available: avail, held, free: avail - held };
}

// What this job still has to find. Clamped at zero: over-holding a job is a
// data state to tolerate, not a negative demand that would credit other jobs.
export function openNeed(line, allocations = []) {
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id) - incomingFor(allocations, line.id));
}

// One line's full picture. `lines` must already be filtered to the planned/ready
// lines competing for THIS board — the caller owns that query.
export function linePosition({ lineId, lines = [], available, allocations = [] }) {
  const me = lines.find(l => l.id === lineId) || { id: lineId };
  const { held, free } = boardPosition({ available, allocations });
  const myOpen = openNeed(me, allocations);
  const othersOpen = lines
    .filter(l => l.id !== lineId)
    .reduce((s, l) => s + openNeed(l, allocations), 0);
  const net = free - myOpen - othersOpen;
  return {
    available: num(available),
    held,
    free,
    need: lineNeed(me),
    held_for_me: heldFor(allocations, lineId),
    incoming_for_me: incomingFor(allocations, lineId),
    my_open_need: myOpen,
    others_open_need: othersOpen,
    net,
    short: Math.max(0, -net),
  };
}
