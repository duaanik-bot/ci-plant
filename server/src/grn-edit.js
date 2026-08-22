// What may be corrected on a goods receipt, and what that correction costs the
// ledger. One rule, read by the route before it writes and by the client before
// it offers the field, so the form never shows a box whose save would 403.
//
// A GRN used to be editable only while it sat in quarantine. That is the right
// rule for the QUANTITY and the wrong rule for everything else: a lorry number
// keyed wrong, or a supplier invoice that arrives a week after the board, is
// paperwork, and paperwork has no stock consequence at any status. Locking the
// whole record behind QC meant the register carried known-wrong invoice numbers
// on 55 completed receipts with no way to fix them short of deleting the GRN.
//
// So the axes are split:
//
//   paperwork  — batch/vehicle/invoice/received-by/remarks. Always editable.
//   quantity   — moves stock, and how it moves depends on where the receipt is:
//
//     quarantine  the batch is booked but credited to nobody. Overwrite it.
//     accepted    QC already pushed the sheets into `available`, credited the
//                 PO line and retired the job's incoming coverage. A correction
//                 has to move all four by the DELTA — and may only do so while
//                 the receipt is still intact, because a batch the floor has
//                 drawn on cannot be re-based without inventing board.
//     rejected    its stock is dead. Nothing to move, nothing to correct.
//
// The intactness test is deliberately the same pair of signals `reverseGrnRow`
// uses — balance never moved off what landed, and no consuming movement was
// ever written. Two spellings of "untouched" would drift.

const PAPERWORK = ['batch_no', 'vehicle_no', 'supplier_invoice_no',
  'supplier_invoice_date', 'received_by', 'remarks'];

const num = v => Number(v || 0);

// Has the floor drawn on this batch? Both halves must agree it is untouched.
export function batchIntact(batch, consumingMovements = 0) {
  if (!batch) return false;
  return num(batch.qty) === num(batch.initial_qty) && num(consumingMovements) === 0;
}

// The whole decision. `patch` is the request body; anything absent is left
// alone rather than nulled, so a form that posts one field cannot blank five.
export function grnEditPlan(grn, batch, consumingMovements = 0, patch = {}) {
  const fields = {};
  for (const k of PAPERWORK) if (patch[k] !== undefined) fields[k] = patch[k];

  const from = num(grn.qty);
  const asked = patch.qty !== undefined && patch.qty !== null && patch.qty !== ''
    ? Number(patch.qty) : null;

  // How this receipt's stock would have to move, and whether it may.
  let stock = 'none';
  let creditsPoLine = false;
  let editable = false;
  let reason = null;

  if (grn.status === 'quarantine') {
    // Nothing downstream has been told about this board yet, so the batch is
    // simply re-stated. No PO credit exists to adjust — QC does that later.
    if (!batch) reason = 'This receipt has no stock batch to correct.';
    else { editable = true; stock = 'set'; }
  } else if (grn.status === 'accepted') {
    if (!batch) reason = 'This receipt has no stock batch to correct.';
    else if (!batchIntact(batch, consumingMovements)) {
      const used = num(batch.initial_qty) - num(batch.qty);
      const drawn = Math.max(used, 0);
      reason = drawn > 0
        ? `${fmtNum(drawn)} of ${fmtNum(batch.initial_qty)} ${grn.unit || 'units'} from `
          + `${grn.grn_number} is already issued — the received quantity can no longer be `
          + `re-based. Roll the receipt back to the PO and receive it again.`
        : `Stock from ${grn.grn_number} has already been used — the received quantity can no `
          + `longer be re-based. Roll the receipt back to the PO and receive it again.`;
    } else { editable = true; stock = 'delta'; creditsPoLine = !!grn.po_line_id; }
  } else if (grn.status === 'rejected') {
    reason = `${grn.grn_number} was rejected at QC — it holds no live stock to correct. `
      + `Delete it and receive the board again.`;
  } else {
    reason = 'This receipt is not in a state that can be corrected.';
  }

  // Only now is a refused quantity an ERROR rather than a closed door: a form
  // that posts the unchanged number must still be able to save its paperwork.
  const changed = asked !== null && asked !== from;
  let error = null;
  if (changed && !editable) error = reason;
  else if (changed && !(asked > 0)) error = 'Received quantity must be positive';

  // A refused change moves NOTHING. Without this the plan still carried a
  // live stock instruction alongside its own error — `qty: 0` on a quarantine
  // receipt came back as { error: 'must be positive', stock: 'set', to: 0 },
  // one missing early-return in the route away from booking a nil batch.
  const applies = changed && editable && !error;
  const to = applies ? asked : from;
  return {
    fields,
    qty: { editable, reason, from, to, delta: to - from, changed: applies },
    stock: applies ? stock : 'none',
    creditsPoLine: applies ? creditsPoLine : false,
    error,
  };
}

function fmtNum(n) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(num(n));
}

export { PAPERWORK };
