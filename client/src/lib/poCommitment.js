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

// What one job is CALLED in a cell: its code, which is what the plant says out
// loud ("SW-368"), falling back to the carton name and then to the line id, so
// a job is never nameless.
const nameOf = job =>
  job?.product_code || job?.product_name || `Line ${job?.order_line_id}`;

// Every product a purchase is committed to, named. This deliberately does NOT
// collapse to "N products": a count tells the buyer that an answer exists
// without telling them the answer, so the cell has to be opened to learn the one
// thing it was added to say. Codes are short — the live worst case is six on a
// line — so the whole list fits and the row stays readable.
//
// Live claims lead; a claim whose job has since moved to another board sorts
// last and carries `on_board:false` so the cell can mute it. `label` is the same
// list as one string, for a title attribute.
export function commitmentSummary(commitments = []) {
  const jobs = Array.isArray(commitments) ? commitments.filter(Boolean) : [];
  if (!jobs.length) return { kind: 'open', count: 0, moved: 0, names: [], label: OPEN_ORDER, jobs: [] };

  const live = jobs.filter(isLiveClaim);
  const moved = jobs.length - live.length;
  const names = [...live, ...jobs.filter(j => !isLiveClaim(j))].map(j => ({
    key: j.order_line_id,
    name: nameOf(j),
    product_name: j.product_name || null,
    on_board: j.on_board !== false,
  }));

  return {
    kind: live.length ? 'committed' : 'moved',
    count: jobs.length,
    moved,
    names,
    label: names.map(n => n.name).join(' · '),
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
