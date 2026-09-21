// Combined Run rules. PURE — plain rows in, verdicts out. No pg, no await,
// nothing to mock (same contract as board-allocation.js, and for the same
// reason: these decide what the plant is allowed to run as one job).
//
// A COMBINED RUN (CI-MRG-) is the SAME product on several sales orders,
// printed as ONE pile that runs the entire route on one job card and never
// splits. That is the opposite trade-off from a gang (different products, one
// shared sheet, split after die cutting) — so where gangCompat only ever
// WARNS, a merge has real CONFLICTS: it asserts a physical identity ("these
// cartons are indistinguishable") that either holds or does not.

// Mirror of helpers.js netProduceQty, kept local so this module (and its
// tests) never import through db.js.
const net = m => Math.max(0, (+m.qty || 0) - (+m.fg_consumed_qty || 0) - (+m.dispatched_qty || 0));

// ── Batch identity ──────────────────────────────────────────────────────────
// A pharma customer books ONE purchase order as several lines, one per BATCH,
// and the batch number is PRINTED AT PRESS — so it is part of what the carton
// physically is, not a note about it. Two lines of one product code with two
// batch numbers are therefore two different cartons, and belong in a gang
// (own slot on the shared sheet, split after die cutting), never in a combined
// pile that would print every carton with one batch number.
//
// The number rides in `line_remark`, free text the PO import writes, so READ
// it, do not trust it: only an explicit batch marker counts. A remark that is
// not a batch returns null and changes nothing — absent data must never fork
// a run. Both prefixes the plant actually types are accepted ("BATCH NO
// 54TCR008", "BATCH 54TBT065", "B.NO TCL031").
const BATCH_RE = /\b(?:BATCH|B\.?\s*N[O0]\.?)\s*(?:NO\.?|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]*)/i;

export function batchOf(member = {}) {
  const raw = String(member.line_remark ?? '').trim();
  if (!raw) return null;
  const m = BATCH_RE.exec(raw);
  return m ? m[1].toUpperCase() : null;
}

// The distinct batch numbers a selection names, in a stable order.
const batchesOf = members => [...new Set(members.map(batchOf).filter(Boolean))].sort();

// Is this selection ONE carton? Product code alone used to answer this, which
// is what made a batch split impossible to gang. One product AND at most one
// named batch. A single named batch beside unmarked lines stays one carton —
// only a genuine SECOND batch forks the run.
export function sameCarton(members = []) {
  if (new Set(members.map(m => m.product_id)).size > 1) return false;
  return batchesOf(members).length <= 1;
}

// Which build does this selection want? The ONE rule the planning queue and
// POST /gang-runs both read, so the button the planner sees and the run the
// server mints can never disagree.
export function runKindFor(members = []) {
  return sameCarton(members) ? 'merge' : 'gang';
}

// Does this run give ONE product more than one slot? THE DIE MEMORY is keyed
// on the product SET (dieFingerprint dedupes the ids), and its slots are found
// by product_id — so it cannot describe a run where one carton takes several
// slots at different ups. A batch gang is exactly that, and its split is
// driven by the ORDER QUANTITIES rather than by the die, so remembering it
// would be wrong even if the key could hold it. Recognition and remembering
// are skipped when this is true.
export function repeatsAProduct(members = []) {
  return new Set(members.map(m => Number(m.product_id))).size !== members.length;
}

// Can these order lines run as ONE combined pile?
// Members are MEMBER_VIEW-shaped rows: effective (override-aware) spec fields.
export function mergeCompat(members = []) {
  const conflicts = [];
  const warnings = [];
  const uniq = pick => [...new Set(members.map(pick).filter(v => v != null && v !== ''))];

  if (members.length < 2) {
    conflicts.push({ field: 'members', values: [], message: 'Pick at least two sales orders to combine' });
  }

  // One product — the whole point. Different products belong in a gang.
  const productIds = uniq(m => m.product_id);
  if (productIds.length > 1) {
    conflicts.push({
      field: 'product', values: uniq(m => m.product_code),
      message: `Combining is for repeat orders of the SAME carton — these are ${productIds.length} different products. Use Gang printing instead.`,
    });
  }

  // Still in planning, unclaimed, uncarded — same admission rules as a gang.
  for (const m of members) {
    if (!['pending', 'planned'].includes(m.status)) {
      conflicts.push({ field: 'status', values: [m.status], message: `${m.product_name} (${m.po_number}) is already ${String(m.status).replace('_', ' ')} — only lines still in planning can be combined` });
    }
    if (m.gang_run_id) {
      conflicts.push({ field: 'run', values: [], message: `${m.product_name} (${m.po_number}) is already in a run` });
    }
    if (m.job_card_id) {
      conflicts.push({ field: 'job_card', values: [m.jc_number].filter(Boolean), message: `${m.product_name} (${m.po_number}) already has job card ${m.jc_number}` });
    }
  }

  // One pile cannot be two boards or two die layouts. Same product normally
  // guarantees these, but a job-only spec_override can differ — and that is a
  // real fork in the physical run, so it blocks rather than warns.
  if (uniq(m => m.board_material_id).length > 1) {
    conflicts.push({ field: 'board', values: uniq(m => m.board_name), message: 'These orders resolve to different boards — one combined pile cuts from ONE board. Align the board overrides first.' });
  }
  if (uniq(m => m.ups).length > 1 || uniq(m => m.child_l).length > 1 || uniq(m => m.child_w).length > 1) {
    conflicts.push({ field: 'layout', values: uniq(m => `${m.ups} ups ${m.child_l}×${m.child_w}`), message: 'These orders carry different cut layouts (ups / child size) — one combined pile is cut ONE way. Align the overrides first.' });
  }

  // Judgement calls stay soft — same thresholds as gangCompat so the two
  // panels read alike.
  const days = members.map(m => Date.parse(m.delivery_date)).filter(Number.isFinite);
  if (days.length > 1 && (Math.max(...days) - Math.min(...days)) / 86400000 > 7) {
    warnings.push({ field: 'delivery dates', values: uniq(m => m.delivery_date) });
  }
  // Combining across batches is the planner's call — but never a silent one:
  // the pile prints ONE batch number whatever the order lines claim.
  const batches = batchesOf(members);
  if (batches.length > 1) {
    warnings.push({ field: 'batches', values: batches });
  }
  const customers = uniq(m => m.customer_name);
  if (customers.length > 1) {
    warnings.push({ field: 'customers', values: customers });
  }

  return { ok: conflicts.length === 0, conflicts, warnings };
}

// How a finished pile divides across the run's sales orders — the run panel's
// read model, NOT a stock ledger (dispatch owns the real allocation, in
// POST /fg/move).
//
// EARLIEST DELIVERY FIRST, each order filled IN FULL before the next starts —
// deliberately the same contract as cascadeAllocate/PRODUCED_LINES_SQL
// (dispatch.js orders by o.delivery_date NULLS LAST, ol.id), so this panel
// PREDICTS what dispatch will do. A proportional split would read fairer and
// be a lie: a short pile does not shave every order a little, it makes the
// earliest promises whole and leaves the latest waiting for the balance.
//
// Parts always sum to exactly `produced`; a pile larger than every order's
// need shows its overflow (the future leftover boxes) on the earliest member.
export function mergeShares(members = [], produced = 0) {
  if (!members.length) return [];
  const total = Math.max(0, Math.round(+produced || 0));
  const parts = members.map(m => ({ order_line_id: m.id, qty: 0 }));
  const byIndex = Object.fromEntries(parts.map((p, i) => [members[i].id, p]));

  const order = members
    .map(m => ({ m, t: Date.parse(m.delivery_date) }))
    .sort((a, b) =>
      ((Number.isFinite(a.t) ? a.t : Infinity) - (Number.isFinite(b.t) ? b.t : Infinity)) || (a.m.id - b.m.id));

  let left = total;
  for (const { m } of order) {
    const take = Math.min(net(m), left);
    byIndex[m.id].qty = take; left -= take;
    if (left <= 0) break;
  }
  if (left > 0) byIndex[order[0].m.id].qty += left;
  return parts;
}

// Who cannot be filled from what QC accepted — the amber list on the run panel.
export function membersAtRisk(members = [], produced = 0) {
  const parts = mergeShares(members, produced);
  const byId = Object.fromEntries(parts.map(p => [p.order_line_id, p.qty]));
  return members
    .filter(m => (byId[m.id] || 0) < net(m))
    .map(m => ({ order_line_id: m.id, po_number: m.po_number, short: net(m) - (byId[m.id] || 0), delivery_date: m.delivery_date }));
}
