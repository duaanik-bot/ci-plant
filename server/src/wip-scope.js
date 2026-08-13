// What the Status Sheet holds, and what a WIP row may match against.
//
// ONE spelling, because two routes have to agree. /status-sheet paints the
// sheet and /status-sheet/wip-match decides which products an uploaded row can
// map onto. If those drift, the sheet shows a line the matcher cannot find and
// the customer's re-imported list reports it "unrecognised" — the exact failure
// this module exists to make impossible. An inline copy in either route would
// be invisible to a name-grep, so neither route spells it out.
//
// The scope is: still owed to the customer, OR carrying a WIP record.
//
// The second half is what makes an imported list CUMULATIVE. A customer chases
// a product until they receive it; we stop calling it pending the moment we
// dispatch it. Without `wip IS NOT NULL` a product would silently leave both
// the sheet and the candidate set at exactly the point the customer is most
// likely to still be asking about it.

// Owed: the order is live, the line is neither cancelled nor dispatched, some
// quantity is still outstanding and production has not signed it off. This is
// the predicate the sheet has always used, unchanged.
export const PENDING_SQL = `(
  o.status IN ('pending','hold') AND ol.status NOT IN ('cancelled','dispatched')
  AND ol.qty > ol.dispatched_qty AND ol.completed_at IS NULL
)`;

// A WIP RECORD, not a WIP flag: `wip IS NOT NULL` is true for both `true`
// (the customer is waiting) and `false` (the customer has said it is not in
// progress). Both are things they told us, and both belong on the list.
// "Remove from WIP" writes NULL, which drops the line back to PENDING_SQL
// alone — an explicit removal is the only way off the sheet.
export const HAS_WIP_RECORD_SQL = `ol.wip IS NOT NULL`;

// A cancelled line is out under every reading: it is not owed, and a WIP
// record against it is a claim about work nobody is going to do.
export const STATUS_SHEET_SCOPE_SQL =
  `ol.status <> 'cancelled' AND (${PENDING_SQL} OR ${HAS_WIP_RECORD_SQL})`;

// The line's own status, as the filter chips read it. A CASCADE, not three
// independent tests: a dispatched line is usually also completed, and reporting
// it as both would let one line answer two chips and double itself in a
// customer's export.
//
// `dispatched_qty >= qty` sits beside the status check on purpose — the plant
// dispatches in parts, and a line that has had its full quantity shipped is out
// of the door whether or not anything got around to restatusing it.
export const LINE_STATUS_SQL = `CASE
  WHEN ol.status = 'dispatched' OR ol.dispatched_qty >= ol.qty THEN 'dispatched'
  WHEN ol.completed_at IS NOT NULL THEN 'completed'
  ELSE 'pending'
END`;

// The EDD a LINE actually answers for.
//
// orders.delivery_date is one date for the whole PO, but 79% of the lines on
// this sheet share a PO with other products (one PO carries 26), and the
// customer's WIP list names a date per ITEM. So a line may carry its own, and
// the order's date is the fallback — an OVERRIDE, exactly like printed_override.
//
// ONE spelling, because three things have to agree about it: the column the
// sheet shows, the ORDER BY that sorts on it, and the overdue clamp below. A
// line resolving its EDD one way and sorting by another is a sheet that cannot
// be read.
export const LINE_EDD_SQL = `COALESCE(ol.delivery_date, o.delivery_date)`;

// Days past the delivery date — but only while the line is still owed.
//
// Widening the sheet to finished lines would otherwise walk straight into the
// Overdue KPI: a line dispatched three weeks after its EDD is not overdue, it
// is DONE, and counting it would report a worse plant than the one that exists.
// The clamp lives here rather than in the route so it cannot be widened without
// the scope that made it necessary. Reads the RESOLVED edd, so a line that has
// been given its own date is judged against that one and not the PO's.
export const overdueDaysSql = plantToday => `CASE
  WHEN ${LINE_EDD_SQL} IS NOT NULL
   AND ${LINE_EDD_SQL}::date < ${plantToday}
   AND ${LINE_STATUS_SQL} = 'pending'
  THEN (${plantToday} - ${LINE_EDD_SQL}::date)::int
  ELSE 0
END`;

// The three states a WIP record can be in, as the API spells them.
export const WIP_STATES = [true, false, null];
export const isWipState = v => v === true || v === false || v === null;

// The date that rides a WIP record.
//
//   • an explicit date always wins — the uploaded sheet's own date is the
//     customer's word for when they raised it, and it is not ours to round
//   • marking WIP or Non-WIP with no date stamps today: both are things the
//     customer said, on a day
//   • REMOVING the record clears the date. A date with no record is a stale
//     claim — the rule the single-flag code already carried, extended to the
//     third state rather than reinvented for it.
//
// `today` is passed in (never read from the clock here) so a caller stamps with
// plantDateStr() and a test can assert the rule without owning the date.
export function wipDateFor(wip, explicit, today) {
  if (wip == null) return null;
  return explicit || today;
}
