// Board Stock Verification arithmetic. PURE — plain rows in, numbers out. No
// pg, no await, nothing to mock, same contract as board-allocation.js.
//
// The report answers one question for the warehouse: "before the cutter walks
// to the rack, is the board this queue is about to eat REALLY on the shelf?"
// It never reserves stock, never adjusts stock, and never blocks Cutting —
// physics stays with the existing issue paths; this is paperwork, soft by
// design (see the soft-gates rule).

const num = v => Number(v || 0);

// ── Cutting status ──────────────────────────────────────────────────────────
// The four words the floor reads. Only the first three belong on the
// verification report; 'started' is the moment a job leaves it.
export const CUTTING_STATUSES = ['not_sent', 'waiting', 'planned', 'started'];
export const CUTTING_LABEL = {
  not_sent: 'Not Sent to Cutting',
  waiting: 'Waiting for Cutting',
  planned: 'Cutting Planned',
  started: 'Cutting Started',
};

// A job has STARTED cutting when its board has physically been drawn
// (board_drawn — the same rule every board figure in this ERP nets by), or
// when its first cutting-bearing stage has moved off 'pending' — started_at
// stamped, in_progress, partially completed, held mid-run, or completed. A
// held stage HAS started: its sheets are already at the machine.
//
// Before that: no job card yet → 'not_sent'; a card with a planning date →
// 'planned'; a card still waiting for its date → 'waiting'.
export function cuttingStatusOf({ board_drawn, has_card, stage_status, started_at, planned_date } = {}) {
  if (board_drawn) return 'started';
  if (started_at) return 'started';
  if (stage_status && stage_status !== 'pending') return 'started';
  if (!has_card) return 'not_sent';
  return planned_date ? 'planned' : 'waiting';
}

// ── Physical verification ───────────────────────────────────────────────────
export const VERIFICATION_STATUSES = ['pending', 'verified', 'mismatch', 'not_found', 'partial'];
export const VERIFICATION_LABEL = {
  pending: 'Pending Verification',
  verified: 'Physically Verified',
  mismatch: 'Quantity Mismatch',
  not_found: 'Material Not Found',
  partial: 'Partially Available',
};

// These statuses assert a counted figure, so they must carry one.
export const COUNTED_STATUSES = ['verified', 'mismatch', 'partial'];

// The variance block a verification saves and the report shows. Shortage and
// excess are measured against the CUMULATIVE REQUIREMENT of the jobs still
// awaiting cutting (that is what the warehouse must physically find);
// variance_vs_book is the counted figure against the ledger, which is the
// number that says whether the BOOK is wrong. Null physical (a 'pending' or
// 'not_found' event with no count) produces nulls, never fake zeros.
export function verificationComputed({ physical_qty = null, required_qty = 0, available_qty = 0 } = {}) {
  if (physical_qty == null || physical_qty === '') {
    return { shortage_qty: null, excess_qty: null, variance_vs_book: null };
  }
  const physical = num(physical_qty);
  const required = num(required_qty);
  return {
    shortage_qty: Math.max(0, required - physical),
    excess_qty: Math.max(0, physical - required),
    variance_vs_book: physical - num(available_qty),
  };
}

// A verification is STALE when the job set has moved since it was taken — the
// count was honest, but it answered yesterday's requirement. Rounded compare:
// sheet requirements are integers everywhere they are set.
export function verificationStale(verification, requiredNow) {
  if (!verification || verification.status === 'pending') return false;
  if (verification.required_qty == null) return false;
  return Math.round(num(verification.required_qty)) !== Math.round(num(requiredNow));
}

// ── The board pool's verdict ────────────────────────────────────────────────
// Same three-state partition as BoardStatus everywhere else (covered /
// on_order / short), applied to the POOL: the cumulative requirement of every
// live claim on this board against the shelf. `incoming` is board on order
// (open PRs + undelivered PO balances); it never hides the shortfall — it is
// the reason a shortfall is already handled, so `uncovered` is what nobody
// has yet acted on.
export function poolVerdict({ available = 0, required = 0, incoming = 0 } = {}) {
  const shortage = Math.max(0, num(required) - num(available));
  const uncovered = Math.max(0, shortage - num(incoming));
  const state = shortage <= 0 ? 'covered' : num(incoming) > 0 ? 'on_order' : 'short';
  return { shortage, uncovered, state };
}
