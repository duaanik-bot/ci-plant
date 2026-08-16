// Order edit form — which rows may be dropped from the PUT payload, and which
// must stop the save instead.
//
// PUT /orders/:id treats the submitted `lines` array as the COMPLETE set: every
// existing line whose id is absent from it is hard-deleted server-side. So
// filtering an incomplete row out of the payload does not "skip" that row — it
// DELETES it. On 2026-08-13 that quietly removed 13,500 nos of booked demand
// from two Fluence orders, and the only trace was a single order/update row.
//
// Hence the split below. A persisted line carries an id: blanking its quantity
// must refuse the save, never silently drop the line. A row the user just added
// has no id, so blank means "unfilled" and skipping it is right — until it
// names a product, at which point a missing quantity is lost input rather than
// an empty row, and that stops the save too.

const hasQty = qty => qty !== '' && qty != null && +qty > 0;

// True when this row must block the save rather than be filtered out.
export function incompleteOrderLine(line) {
  if (!line) return false;
  if (line.id) return !(line.product_id && hasQty(line.qty));
  return !!line.product_id && !hasQty(line.qty);
}

// The rows that are safe to leave out of the payload: blank rows the user added
// and never filled in. Only ever call this once incompleteOrderLine has cleared
// every row — otherwise it is the silent delete all over again.
export function payloadLines(lines = []) {
  return lines.filter(l => l.product_id && hasQty(l.qty));
}
