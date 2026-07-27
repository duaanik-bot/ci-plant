// Board allocation arithmetic. PURE — plain rows in, numbers out. No pg, no
// await, nothing to mock. The numbers here decide real purchase quantities, so
// they are unit-tested against a transcription of the formula they replace.
//
// A board's stock splits three ways:
//   available = what the warehouse physically has
//   held      = the part earmarked for named jobs (board_allocations),
//               capped at what each job can actually use
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

// Defensive: the module must not depend on the caller's WHERE clause being
// right. When materialId is given, every allocation not carrying that
// material_id is dropped before any arithmetic runs.
const byMaterial = (allocations, materialId) =>
  materialId == null ? allocations : allocations.filter(a => a.material_id === materialId);

// Board demand is counted in PARENT (mother) sheets — the unit the warehouse
// stocks and every Available column reports. sheets_required is the CHILD print
// sheet count, so using it raw over-states demand by children_per_parent.
export function lineNeed(line) {
  return num(line?.parent_sheets_required ?? line?.sheets_required);
}

export function heldFor(allocations = [], orderLineId, materialId = null) {
  return byMaterial(allocations, materialId)
    .filter(a => isActive(a) && a.source === 'stock' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

export function incomingFor(allocations = [], orderLineId, materialId = null) {
  return byMaterial(allocations, materialId)
    .filter(a => isActive(a) && a.source === 'requisition' && a.order_line_id === orderLineId)
    .reduce((s, a) => s + num(a.qty), 0);
}

// What this job still has to find. Clamped at zero: over-holding a job is a
// data state to tolerate, not a negative demand that would credit other jobs.
export function openNeed(line, allocations = []) {
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id) - incomingFor(allocations, line.id));
}

// `lines` is the known set of order lines a hold might point at (normally the
// line being planned plus the others competing for this board). For each
// active stock hold:
//   - if its order line is in `lines`, the hold counts toward `held` only up
//     to that line's need — the surplus is reported as `over_held` and stays
//     in `free`. Board physically in the warehouse beyond what a job can use
//     is not stranded.
//   - if the line is NOT in `lines` (cancelled, already consumed, or simply
//     unknown to this caller), the hold counts at face value. Conservative:
//     an unexplained hold reduces supply rather than freeing it up.
export function boardPosition({ available, allocations = [], lines = [], materialId = null }) {
  const avail = num(available);
  const filtered = byMaterial(allocations, materialId);

  const holdsByLine = new Map();
  for (const a of filtered) {
    if (!isActive(a) || a.source !== 'stock') continue;
    holdsByLine.set(a.order_line_id, (holdsByLine.get(a.order_line_id) || 0) + num(a.qty));
  }

  let held = 0;
  let overHeld = 0;
  for (const [orderLineId, qty] of holdsByLine) {
    const line = lines.find(l => l.id === orderLineId);
    if (line) {
      const need = lineNeed(line);
      const counted = Math.min(qty, need);
      held += counted;
      overHeld += qty - counted;
    } else {
      held += qty;
    }
  }

  return { available: avail, held, free: avail - held, over_held: overHeld };
}

// One line's full picture.
//
// `line` is the order line being planned — REQUIRED, and never guessed at.
// The line being planned is frequently still 'pending' in the DB (it only
// flips to 'planned' at the end of the plan-save transaction), so a caller
// that re-derived it from a status-filtered `lines` query would silently
// treat its own need as zero. Pass it explicitly instead.
//
// `others` are the OTHER planned/ready lines competing for this board,
// already excluding `line` — mirroring the `AND ol.id != $2` in the
// production query this replaces. The caller owns that query.
export function linePosition({ line, others = [], available, allocations = [], materialId = null }) {
  if (!line || line.id == null) {
    throw new Error('linePosition needs the line being planned');
  }

  const filtered = byMaterial(allocations, materialId);
  const lines = [line, ...others];
  const { held, free, over_held } = boardPosition({ available, allocations: filtered, lines });

  const myOpen = openNeed(line, filtered);
  const othersOpen = others.reduce((s, l) => s + openNeed(l, filtered), 0);
  const net = free - myOpen - othersOpen;

  return {
    available: num(available),
    held,
    free,
    need: lineNeed(line),
    held_for_me: heldFor(filtered, line.id),
    incoming_for_me: incomingFor(filtered, line.id),
    my_open_need: myOpen,
    others_open_need: othersOpen,
    net,
    short: Math.max(0, -net),
    over_held,
  };
}
