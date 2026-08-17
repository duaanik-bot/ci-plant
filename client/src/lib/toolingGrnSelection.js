// Which Die / Block PO lines a delivery covers.
//
// The plate form ticks NAMED components — a set's Cyan either arrived or it did
// not. A die or block line is a QUANTITY, so the same gesture has to mean
// something slightly different here: a tick fills the line's whole outstanding
// balance, and the box stays editable underneath for the part delivery. Same
// intent as the boards module's Fill Full Balance, per line instead of per PO.
//
// This lives in lib/ rather than in the modal because .jsx cannot be
// node --test'd, and an off-by-one in the balance arithmetic over-receives a PO.

const num = value => Number(value) || 0;

export const pendingOf = line => Math.max(0, num(line?.qty) - num(line?.received_qty));

// Every line on the PO, each saying whether it can still take a receipt. A
// finished line is KEPT — it used to be filtered out of the form, so a
// part-received PO rendered as a smaller order than the one that was raised.
export function toolingGrnLines(po) {
  return (po?.lines || []).map(line => {
    const pending = pendingOf(line);
    return { ...line, order_qty: line.qty, pending, receivable: pending > 0, received: pending === 0 };
  });
}

// Everything outstanding opens filled: the common case is that the whole
// delivery arrived, so the work is to correct what did not.
export function initialReceipt(po) {
  return toolingGrnLines(po).map(line => ({
    ...line,
    receive_qty: line.receivable ? String(line.pending) : '',
    batch_no: '',
  }));
}

// A typed 0 or a negative is not a receipt. The box is free text, and either
// would otherwise be sent as a line the server has to refuse.
export const lineTicked = line => num(line?.receive_qty) > 0;

export const receiptTotals = lines => ({
  lines: (lines || []).filter(lineTicked).length,
  qty: (lines || []).reduce((sum, line) => sum + (lineTicked(line) ? num(line.receive_qty) : 0), 0),
});

const fillLine = line => ({ ...line, receive_qty: line.receivable ? String(line.pending) : '' });
const clearLine = line => ({ ...line, receive_qty: '' });

export function toggleToolingLine(lines, index) {
  return (lines || []).map((line, i) => {
    if (i !== index) return line;
    return lineTicked(line) ? clearLine(line) : fillLine(line);
  });
}

export const fillAll = lines => (lines || []).map(fillLine);
export const clearAll = lines => (lines || []).map(clearLine);

// Where one PO line stands, in one chip.
//
// The die and block register showed only the FIRST item and "+3", so a four-line
// order could not say what the other three were, let alone which of them had
// arrived. A plate set says its colour build here; a die is a quantity, so what
// it has to say is how much of it has landed.
export function lineReceipt(line) {
  const ordered = num(line?.qty);
  const received = num(line?.received_qty);
  const unit = line?.unit || 'nos';
  if (received <= 0) return { state: 'open', label: `${ordered} ${unit}` };
  // Partial reads as a fraction: "2 nos" on a half-received line is the same
  // text as an untouched one, which is exactly the confusion to avoid.
  if (received < ordered) return { state: 'partial', label: `${received}/${ordered} ${unit}` };
  return { state: 'received', label: `${ordered} ${unit}` };
}

// Only lines with a positive quantity reach the server — an empty or zero line
// in the body would mint a GRN number for a delivery that did not happen.
export function toReceiptPayload(lines) {
  return (lines || []).filter(lineTicked).map(line => ({
    po_line_id: line.id,
    qty: num(line.receive_qty),
    batch_no: line.batch_no || undefined,
  }));
}
