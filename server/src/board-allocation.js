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

const fmt = n => Math.round(n).toLocaleString('en-IN');

// The most a job can give up: what it explicitly holds, plus however much of
// the free pool it is currently relying on. Never more than it actually claims —
// otherwise you would be taking a THIRD job's share while blaming this one.
export function movableFrom({ line, available, allocations = [], lines = [], materialId = null }) {
  const { free } = boardPosition({ available, allocations, lines, materialId });
  const held = heldFor(allocations, line.id, materialId);
  const claim = Math.max(0, lineNeed(line) - incomingFor(allocations, line.id, materialId));
  return Math.max(0, Math.min(held + free, claim));
}

// The most a job can be held. Deliberately does NOT subtract incoming PR
// quantity: cancelling that PR is the entire point of moving stock to this job.
export function holdableFor({ line, allocations = [], materialId = null }) {
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id, materialId));
}

// Work out every consequence of a proposed move. Returns the exact list the
// confirm dialog renders, so the preview cannot drift from the commit.
//
// `lines` must contain BOTH the giving and receiving line. The caller owns that:
// the receiving job is often still 'pending' (orders.js:1005 only flips a line to
// 'planned' at the end of the plan-save), so a caller that only passes the
// planned/ready set must union the target line in explicitly. A line that is
// genuinely absent is a blocker here, never a guess.
export function planMove({ materialId = null, fromLineId, toLineId, qty, available, allocations = [], lines = [], openPrs = [] }) {
  const blockers = [];
  const from = lines.find(l => l.id === fromLineId);
  const to = lines.find(l => l.id === toLineId);
  const q = Number(qty);

  if (!from) blockers.push('The job giving up the board is no longer planned.');
  if (!to) blockers.push('The job receiving the board is no longer planned.');
  if (!(q > 0)) blockers.push('Enter a number of sheets greater than zero.');
  if (fromLineId === toLineId) blockers.push('That is the same job — pick a different one.');

  // A gang shares one board across several jobs and buys it with a single
  // combined PR. Unpicking one member mid-move is out of scope; say so plainly.
  for (const l of [from, to]) {
    if (l?.gang_run_id)
      blockers.push(`${l.product_name} prints in gang ${l.gang_number || `#${l.gang_run_id}`} — move the gang's board from Planning.`);
  }

  if (blockers.length) return { ok: false, blockers, effects: [], net_purchase_delta: 0, qty: q };

  const canGive = movableFrom({ line: from, available, allocations, lines, materialId });
  const canTake = holdableFor({ line: to, allocations, materialId });
  if (q > canGive) blockers.push(`${from.product_name} only has ${fmt(canGive)} sheets to give.`);
  if (q > canTake) blockers.push(`${to.product_name} only needs ${fmt(canTake)} more sheets.`);

  if (blockers.length) return { ok: false, blockers, effects: [], net_purchase_delta: 0, qty: q };

  const effects = [{
    kind: 'hold',
    order_line_id: to.id,
    qty: q,
    text: `${to.product_name} takes ${fmt(q)} sheets from the warehouse`,
  }];

  // Reduce the receiving job's open PRs, oldest first. holdableFor guarantees
  // the mirrored PRs total at least q, so the loop always absorbs the full
  // quantity and net purchase lands on exactly zero.
  let toAbsorb = q;
  let reduced = 0;
  for (const pr of [...openPrs].filter(p => p.order_line_id === to.id).sort((a, b) => a.id - b.id)) {
    if (toAbsorb <= 0) break;
    const cut = Math.min(num(pr.qty), toAbsorb);
    const newQty = num(pr.qty) - cut;
    effects.push({
      kind: 'pr_down',
      requisition_id: pr.id,
      pr_number: pr.pr_number,
      new_qty: newQty,
      close: newQty === 0,
      text: newQty === 0
        ? `${pr.pr_number} is fully covered from stock and closes`
        : `${pr.pr_number} drops ${fmt(pr.qty)} → ${fmt(newQty)}`,
    });
    toAbsorb -= cut;
    reduced += cut;
  }

  effects.push({
    kind: 'pr_new',
    order_line_id: from.id,
    material_id: materialId,
    qty: q,
    text: `${from.product_name} gets a new PR for ${fmt(q)} sheets`,
  });

  return { ok: true, blockers: [], effects, qty: q, net_purchase_delta: q - reduced };
}

// ── Gangs ────────────────────────────────────────────────────────────────
// A gang prints several jobs on ONE shared board and buys its shortfall with
// ONE combined requisition. Its position is the single-line picture widened to
// the whole run: board already on order for ANY member is coverage for the run.
//
// This is not decoration. Before it existed the gang's "Short" was a bare
// need - available and knew nothing about requisitions, so a successful raise
// left the red Raise-ONE-PR banner byte-identical. CI-GANG-0007 collected four
// full-size PRs in 67 seconds that way.

export function gangIncoming(allocations = [], memberIds = [], materialId = null) {
  const ids = new Set(memberIds);
  return byMaterial(allocations, materialId)
    .filter(a => isActive(a) && a.source === 'requisition' && ids.has(a.order_line_id))
    .reduce((s, a) => s + num(a.qty), 0);
}

export function gangPosition({ needed, committedOther = 0, available, allocations = [], memberIds = [], materialId = null }) {
  const incoming = gangIncoming(allocations, memberIds, materialId);
  return {
    available: num(available),
    committed_other: num(committedOther),
    needed: num(needed),
    incoming,
    short: Math.max(0, num(needed) + num(committedOther) - num(available) - incoming),
  };
}

// The gang buys as one, but the planning engine reads one job at a time. Mirror
// the combined PR onto every member in proportion to the sheets it needs, so a
// member opened on its own nets off its share instead of reading "short" against
// board that is already bought. Whole sheets; the largest member absorbs the
// rounding remainder so the parts always sum to exactly what was ordered.
export function splitGangQty(qty, members = []) {
  if (!members.length) return [];
  const total = num(qty);
  const weights = members.map(m => lineNeed(m));
  const sum = weights.reduce((s, w) => s + w, 0);
  const share = sum > 0 ? weights : members.map(() => 1);
  const shareSum = share.reduce((s, w) => s + w, 0);

  const parts = members.map((m, i) => ({
    order_line_id: m.id,
    qty: Math.floor(total * share[i] / shareSum),
  }));
  let biggest = 0;
  for (let i = 1; i < share.length; i++) if (share[i] > share[biggest]) biggest = i;
  parts[biggest].qty += total - parts.reduce((s, p) => s + p.qty, 0);
  return parts;
}

// Which order lines a requisition's board may actually be booked against.
//
// A PR's material_id is a SNAPSHOT of the board that was short when it was
// raised — not a live pointer. A planner who re-anchors a job (or a whole gang)
// afterwards leaves the PR sitting on the old board. Mirroring it onto those
// lines regardless books incoming stock against jobs that no longer use it,
// which inflates the abandoned board and starves the real one.
//
// So the rule is the narrow one: only lines whose EFFECTIVE board is the board
// being bought. A gang still on it shares the quantity by need; a gang that has
// moved gets nothing, and the mismatch stays visible instead of being papered
// over with a wrong number.
export function mirrorTargets({ materialId, qty }, lines = []) {
  const onThisBoard = lines.filter(l => l.eff_board === materialId);
  if (!onThisBoard.length) return [];
  if (onThisBoard.length === 1) return [{ order_line_id: onThisBoard[0].id, qty: num(qty) }];
  return splitGangQty(qty, onThisBoard);
}

// The gang's members, each carrying its share of one combined requisition —
// what the buyer sees in the PR modal beside the board they are committing to.
//
// The share is splitGangQty(), the same rule syncPrAllocation books into
// board_allocations, so the panel and the ledger cannot drift apart.
export function gangPrShares(qty, members = []) {
  const parts = splitGangQty(qty, members);
  return members.map((m, i) => ({ ...m, sheets: parts[i].qty }));
}
