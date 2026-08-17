// Changing a quantity on a requisition that has ALREADY become a purchase order
// has to move the order too. Leaving the PO alone would let the two drift, and
// the PO's traceability is derived straight from these rows — the order would
// start reporting quantities nobody asked for.
//
// The move is a DELTA, never a set. Consolidation merges several requisitions
// onto one PO line, so a requisition going 20 → 25 adds 5 to whatever that line
// currently carries; setting the line to 25 would silently erase what the other
// requisitions contributed.

function sumByMaterial(lines) {
  const m = new Map();
  for (const l of lines || []) {
    if (!l.material_id) continue;
    const k = String(l.material_id);
    m.set(k, (m.get(k) || 0) + (+l.qty || 0));
  }
  return m;
}

// Once an order exists, the ITEMS are fixed and only the quantities move. Adding
// a board would mean a line the vendor was never asked for; removing one would
// orphan a line the order still carries. Either is a new requisition, not an
// edit of this one.
export function planPrQtyChange(oldLines, newLines) {
  const before = sumByMaterial(oldLines);
  const after = sumByMaterial(newLines);

  const added = [...after.keys()].filter(k => !before.has(k));
  const removed = [...before.keys()].filter(k => !after.has(k));
  if (added.length || removed.length) {
    return { deltas: [], error: 'Only quantities can be changed once a requisition has become a purchase order — raise a new requisition to add or drop an item.' };
  }
  for (const [, qty] of after) {
    if (!(qty > 0)) return { deltas: [], error: 'Each item needs a quantity above zero.' };
  }

  const deltas = [];
  for (const [k, from] of before) {
    const to = after.get(k);
    if (to !== from) deltas.push({ material_id: +k, from, to, delta: to - from });
  }
  return { deltas, error: null };
}
