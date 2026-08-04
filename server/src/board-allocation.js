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

// The statuses a job's board may still be taken away from. A job that has
// reached the floor is listed as a holder wherever board is shown — the planner
// must be able to see who has the sheets — but its claim is not up for grabs,
// so every "take board from another job" path refuses it. Physics hard.
export const MOVABLE_STATUSES = ['planned', 'ready'];
export const canGiveUpBoard = line => !line?.status || MOVABLE_STATUSES.includes(line.status);

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
//
// `board_drawn` closes the question outright. Once cutting has issued the
// sheets they are on the floor, not on the shelf — the requirement was met by
// a draw that already came OUT of `available`, so counting it again bills the
// same 600 sheets twice and manufactures a shortage out of the remainder. The
// caller sets the flag from boardDrawnLineIds(), which is the same rule the
// board-status chips have always used ("a job mid-production is not a job to
// chase board for"); this arithmetic simply never listened to it.
//
// Absent flag = the old behaviour, so every caller that does not know about a
// draw is unaffected — see the PROPERTY test.
export function openNeed(line, allocations = []) {
  if (line?.board_drawn) return 0;
  return Math.max(0, lineNeed(line) - heldFor(allocations, line.id) - incomingFor(allocations, line.id));
}

// Who is holding each board, and how much of it. PURE — the caller supplies the
// live claims (helpers.boardClaimLines) and the active allocations.
//
// COMMITTED is measured against the SHELF: the full requirement of every live
// claim, minus only the ones already DRAWN — those sheets have physically left
// and are out of `available`, so counting them again bills the same board twice.
//
// It is deliberately NOT netted by what is held or on order, which is a
// different question ("what is still to buy", openNeed). Board on order has not
// arrived; subtracting it described the warehouse as it will be AFTER the
// delivery. On Saffire 340 20x38 that read 3,650 committed and 1,200 free out of
// 4,850 while a combined run was about to issue 5,250 — the run sheet said TO
// ISSUE 5,250 · ON ORDER 1,600 and the register said the board had 1,200 going
// spare. Every sheet on that shelf was spoken for.
//
// The identity has to hold at all times: available − committed = free. When the
// on-order board is received it enters `available`, committed does not move, and
// free settles at the same number it would have shown — without the figure ever
// having promised sheets that were not there.
//
// Returns a Map keyed by material_id, largest claim first. `on_order` rides
// alongside as the reason a shortfall is already handled, and each claimant
// keeps its own `open_need` for whoever needs the still-to-buy figure.
export function claimsByBoard({ lines = [], allocations = [] }) {
  const allocByBoard = new Map();
  for (const a of allocations) {
    if (!allocByBoard.has(a.material_id)) allocByBoard.set(a.material_id, []);
    allocByBoard.get(a.material_id).push(a);
  }

  const out = new Map();
  for (const line of lines) {
    const mid = line.board_material_id;
    if (mid == null) continue;
    const mine = allocByBoard.get(mid) || [];
    const open = openNeed(line, mine);
    const need = lineNeed(line);
    // A drawn line has taken its sheets off the shelf and out of `available`
    // already; counting it again bills the same board twice.
    if (line.board_drawn || need <= 0) continue;
    if (!out.has(mid)) out.set(mid, { committed: 0, on_order: 0, claimants: [] });
    const entry = out.get(mid);
    entry.committed += need;
    entry.on_order += incomingFor(mine, line.id);
    entry.claimants.push({
      order_line_id: line.id,
      product_name: line.product_name,
      product_code: line.product_code,
      customer_name: line.customer_name,
      po_number: line.po_number,
      gang_number: line.gang_number,
      status: line.status,
      need: lineNeed(line),
      held: heldFor(mine, line.id),
      incoming: incomingFor(mine, line.id),
      open_need: open,
    });
  }
  for (const entry of out.values()) {
    entry.claimants.sort((a, b) =>
      b.need - a.need || b.open_need - a.open_need || a.order_line_id - b.order_line_id);
  }
  return out;
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

  // Board panels now list jobs already in production, so that a planner can see
  // who is holding stock rather than reading "nobody". Seeing is not taking: a
  // job on the floor keeps its sheets. Silent on a line carrying no status at
  // all, so callers that pass bare {id, need} rows behave exactly as before.
  if (!canGiveUpBoard(from))
    blockers.push(`${from.product_name} is already in production — its board cannot be moved.`);
  if (!canGiveUpBoard(to))
    blockers.push(`${to.product_name} is already in production — it cannot take board here.`);

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

// What each member of a requisition is actually owed, and what is left over.
//
// The gang buys as one, but the planning engine reads one job at a time. Mirror
// the combined PR onto every member so a member opened on its own nets off its
// share instead of reading "short" against board that is already bought.
//
// The share is a CAP, not a ratio. A job needs what it needs: 108 sheets is 108
// sheets whether the buyer orders 150 or 1,600. Prorating the whole order across
// the members — the old rule — meant that editing a PR up (a minimum order
// quantity, a better rate, a deliberate top-up) silently rewrote every job's
// share upward and booked the surplus against jobs that never asked for it. That
// locks board to a job it will never be cut for, and the extra never reads free
// in the warehouse. So: cap at the stated need and hand the rest back as stock.
//
// Under-buying still prorates. When there is not enough to go round, every member
// takes a share of the shortfall rather than the first job in the queue taking
// all of it. Whole sheets; the largest member absorbs the rounding remainder.
//
// The one case that cannot be capped is a member stating no need at all — an
// unlocked gang. There is nothing to cap against, and capping to zero would make
// every member read short against board genuinely bought for it, so an
// unmeasurable need still shares the whole order equally.
export function splitGangQty(qty, members = []) {
  if (!members.length) return [];
  const total = num(qty);
  const weights = members.map(m => lineNeed(m));
  const sum = weights.reduce((s, w) => s + w, 0);

  // Ordered at or above the stated need → every job takes exactly its need and
  // not one sheet more. The remainder belongs to stock, so it is booked here
  // against nothing: see stockSurplus().
  if (sum > 0 && total >= sum)
    return members.map((m, i) => ({ order_line_id: m.id, qty: weights[i] }));

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

// The part of a requisition no job asked for — bought for stock.
//
// splitGangQty() and this function partition the order between them: what the
// jobs are owed plus what is left over is always exactly what was ordered. A
// requisition naming no job at all is a plain top-up, so all of it is stock.
export function stockSurplus(qty, members = []) {
  const total = Math.max(0, num(qty));
  if (!members.length) return total;
  const sum = members.reduce((s, m) => s + lineNeed(m), 0);
  if (sum <= 0) return 0;  // a need we cannot measure is not surplus
  return Math.max(0, total - sum);
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
// A lone job used to be handed the whole quantity outright, which is where the
// uncapped booking lived for every single-job PR on the register. It goes
// through the same split as a gang now: one member, capped at its own need.
export function mirrorTargets({ materialId, qty }, lines = []) {
  const onThisBoard = lines.filter(l => l.eff_board === materialId);
  if (!onThisBoard.length) return [];
  return splitGangQty(qty, onThisBoard);
}

// A fresh receipt's suggested split across the jobs that ordered it — the
// numbers the Cover Board dialog opens with. Walk in the caller's order (PR
// age: the queue procurement promised), each job takes what it can still
// hold, and the budget is the smaller of free stock and what actually landed:
// suggesting more than either would just be refused at commit. Suggestions
// only — every figure stays editable in the dialog.
export function coverSuggestions(candidates = [], free, landed) {
  let budget = Math.max(0, Math.min(num(free), num(landed)));
  return candidates.map(c => {
    const take = Math.min(Math.max(0, num(c.coverable)), budget);
    budget -= take;
    return { ...c, suggested: take };
  });
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
