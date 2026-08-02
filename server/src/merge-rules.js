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
const net = m => Math.max(0, (+m.qty || 0) - (+m.fg_consumed_qty || 0));

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
