// Which plates on a purchase order are being received right now.
//
// A plate PO carries several plate SETS, and a vendor delivers them when they
// are ready — the NEO set today, the Fluence set on Thursday, and sometimes
// three plates of a four-plate set because the fourth came off the CTP wrong.
// So the receipt is a selection over the whole order, at two levels: a set, and
// a plate within it.
//
// This lives in lib/ rather than in the modal because .jsx cannot be
// node --test'd, and the arithmetic below is the part that can quietly go wrong
// — an off-by-one here books a physical plate twice.

// A plate is receivable while it is still on order. 'available' means it is
// already in the rack with an asset number against it; offering it again would
// mint a second asset for one physical plate.
export const OUTSTANDING_STATUSES = ['po_created', 'ordered'];

export const outstandingOf = line =>
  (line?.components || []).filter(row => OUTSTANDING_STATUSES.includes(row.status));

// Every line on the PO, each carrying whether it can still be received. A
// finished line is kept — the form mirrors the order that was raised, and
// hiding it would make a partly received PO look like a smaller one.
export function receivableLines(po) {
  return (po?.lines || []).map(line => {
    const outstanding = outstandingOf(line);
    return {
      ...line,
      outstanding,
      receivable: outstanding.length > 0,
      received: outstanding.length === 0,
      pending: Math.max(0, Number(line.qty || 0) - Number(line.received_qty || 0)),
    };
  });
}

export const outstandingTotal = po =>
  (po?.lines || []).reduce((sum, line) => sum + outstandingOf(line).length, 0);

// Everything outstanding opens ticked: the common case is that the whole
// delivery arrived, so the work is to untick what did not.
export function initialSelection(po) {
  const selection = {};
  for (const line of po?.lines || []) selection[line.id] = outstandingOf(line).map(row => row.id);
  return selection;
}

export const selectedOf = (selection, line) => selection?.[line?.id] || [];

export const selectedTotal = selection =>
  Object.values(selection || {}).reduce((sum, ids) => sum + (ids?.length || 0), 0);

// Tri-state, so the line box can show a dash rather than lying in either
// direction about a partial selection.
export function lineTickState(selectedIds, line) {
  const outstanding = outstandingOf(line);
  const picked = (selectedIds || []).length;
  if (!outstanding.length || !picked) return 'none';
  return picked >= outstanding.length ? 'all' : 'some';
}

// Ticking a line takes its OUTSTANDING plates, never every component it has —
// otherwise re-ticking a partly received set would try to receive the plates
// already in the rack.
export function toggleLine(selection, line) {
  const outstanding = outstandingOf(line).map(row => row.id);
  const current = selectedOf(selection, line);
  return { ...selection, [line.id]: current.length >= outstanding.length && outstanding.length ? [] : outstanding };
}

export function toggleComponent(selection, line, componentId) {
  const current = selectedOf(selection, line);
  const next = current.includes(componentId)
    ? current.filter(id => id !== componentId)
    : [...outstandingOf(line).map(row => row.id).filter(id => current.includes(id) || id === componentId)];
  return { ...selection, [line.id]: next };
}

export const selectAll = po => initialSelection(po);

export const deselectAll = po => {
  const selection = {};
  for (const line of po?.lines || []) selection[line.id] = [];
  return selection;
};

// Only lines with something ticked reach the server. An empty line in the body
// would create a GRN for nothing — a numbered document recording a delivery
// that did not happen.
export function toBulkLines(selection) {
  return Object.entries(selection || {})
    .filter(([, ids]) => (ids?.length || 0) > 0)
    .map(([lineId, ids]) => ({ po_line_id: Number(lineId), component_ids: [...ids] }));
}
