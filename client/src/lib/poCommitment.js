// "What was this board bought FOR?" — the one spelling of that answer, shared by
// the Purchase Order queue, the Pendency register and both of their exports.
//
// The server hands every PO line a `commitments` array: the jobs whose shortage
// put the board on the order, resolved through the requisition that named them
// (see poLineCommitments in routes/procurement.js). An EMPTY array is not
// missing data — it is a real and ordinary purchase decision: board bought to
// the shelf against nobody's job. The plant calls that an **open order**, and it
// gets that word rather than a dash, because a blank cell reads as "not loaded
// yet" and this is a finished answer.
//
// Pure and dependency-free so a test can drive it and both screens can agree.

export const OPEN_ORDER = 'Open Order';

// A job whose line has since been re-anchored to a DIFFERENT board is still
// named — the order really was raised for it — but it no longer draws on this
// purchase, so it must not be counted as covering anything. `on_board` is false
// only when the server could prove the move; anything unknown counts as on.
export const isLiveClaim = job => job?.on_board !== false;

// The short label a cell shows without opening anything. One product names
// itself; several are counted, because a cell that lists five carton names is a
// cell nobody reads. `moved` is surfaced in the label only when EVERY claim has
// moved off — a purchase now committed to nothing in practice, which is the one
// case where the headline would otherwise lie.
export function commitmentSummary(commitments = []) {
  const jobs = Array.isArray(commitments) ? commitments.filter(Boolean) : [];
  if (!jobs.length) return { kind: 'open', count: 0, moved: 0, label: OPEN_ORDER, jobs: [] };

  const live = jobs.filter(isLiveClaim);
  const moved = jobs.length - live.length;
  const named = live.length ? live : jobs;
  const label = named.length === 1
    ? (named[0].product_code || named[0].product_name || `Line ${named[0].order_line_id}`)
    : `${named.length} products`;

  return {
    kind: live.length ? 'committed' : 'moved',
    count: jobs.length,
    moved,
    label,
    jobs,
  };
}

// The same answer as one flat string — what an export cell and a search haystack
// both need. Products first (that is what a buyer scans for), then the customer
// and the sales PO, so "swiss" or "01879" finds the purchase raised for it.
export function commitmentText(commitments = []) {
  const s = commitmentSummary(commitments);
  if (s.kind === 'open') return OPEN_ORDER;
  return s.jobs
    .map(j => [j.product_code, j.product_name, j.customer_name, j.sales_po]
      .filter(Boolean).join(' '))
    .join(' · ');
}

// Distinct customers behind a purchase — the second thing a buyer asks after
// "which product", and short enough to sit under the label.
export function commitmentCustomers(commitments = []) {
  return [...new Set((commitments || []).map(j => j?.customer_name).filter(Boolean))];
}
