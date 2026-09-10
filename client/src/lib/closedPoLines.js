// Closed-short PO lines, read one way by every surface that shows them.
//
// A line the buyer closed short owes nothing — its unreceived balance was
// waived (poCompletion on the server counts it done). So it leaves the PO card,
// which is for lines still in play, and lives in Purchase Orders → Closed
// lines, where it can be read and, through the reopen form, brought back.

const num = value => Number(value) || 0;

/** The lines a PO card lists: everything not closed short. */
export const openLinesOf = po => (po?.lines || []).filter(line => !line.closed_short);

/** The lines the buyer closed short on this order. */
export const closedLinesOf = po => (po?.lines || []).filter(line => line.closed_short);

/** What the vendor still owed when the line closed — the waived balance. */
export const waivedOf = line => Math.max(0, num(line?.qty) - num(line?.received_qty));

// Still owing and nobody waived it: the mark of a line an order-level Close PO
// gave up on. An order its own waivers finished has none of these.
const owingUnwaived = line => !line.closed_short && num(line.received_qty) < num(line.qty);

/** Closed with Close PO while lines were still owing — not finished by its waivers. */
export const closedAsWhole = po => po?.status === 'closed' && (po.lines || []).some(owingUnwaived);

/**
 * The Closed lines register: one row per closed line, carrying its order's
 * identity, the waived balance, and whether reopening it revives an order that
 * was closed as a whole (with how many of that order's other lines stay closed).
 *
 * Newest closure first, and the line id breaks ties so the order is TOTAL: one
 * close stamps every line it waives with the same instant, and DataTable's
 * stable sort keeps whatever order it is handed.
 */
export function closedLineRows(pos = []) {
  const rows = [];
  for (const po of pos) {
    const whole = closedAsWhole(po);
    const othersOwing = whole ? (po.lines || []).filter(owingUnwaived).length : 0;
    for (const line of closedLinesOf(po)) {
      rows.push({
        ...line,
        po_id: po.id, po_number: po.po_number, vendor_name: po.vendor_name,
        po_status: po.status, expected_date: po.expected_date,
        waived: waivedOf(line), whole_closed: whole, others_owing: othersOwing,
      });
    }
  }
  const at = row => (row.closed_at ? Date.parse(row.closed_at) : -Infinity);
  return rows.sort((a, b) => (at(b) - at(a)) || (b.id - a.id));
}

/** What the reopen dock says about a selection: lines, orders, balance returning. */
export function reopenSummary(rows = []) {
  return {
    lines: rows.length,
    orders: new Set(rows.map(row => row.po_id)).size,
    waived: rows.reduce((sum, row) => sum + num(row.waived), 0),
  };
}
