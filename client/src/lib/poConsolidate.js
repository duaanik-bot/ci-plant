// Twin of server/src/po-consolidate.js — the PO form shows the buyer exactly the
// lines the server is about to write. Keep the two identical; po-consolidate-parity
// fails the build if they drift.
//
// Several requisitions — or several lines of one requisition, or a buyer typing
// the same board twice — can name one material. The purchase order carries it
// once, with the quantities added up: one line to price, one line to ship.

// Lines in, one row per material out, in first-appearance order. Each row keeps
// `sources`: the lines that fed it, each with its position in the input, so a
// form can say "line 1 and line 3" and a PO can name its requisitions.
//
// `mergedRate(sources)` is asked for the rate of a row that actually merged.
// Return null (an unrated board) to leave the top-most line's rate standing.
export function consolidate(lines, { mergedRate } = {}) {
  const out = [];
  const byMaterial = new Map();

  (lines || []).forEach((line, index) => {
    const source = { ...line, index, qty: +line.qty || 0 };
    // A half-filled form has blank rows, and they all share a falsy material.
    // Grouping on that would fuse them into one, so they stay apart.
    const key = line.material_id ? String(line.material_id) : null;
    const row = key == null ? null : byMaterial.get(key);
    if (row) {
      row.qty += source.qty;
      row.sources.push(source);
      return;
    }
    const fresh = { ...line, qty: source.qty, sources: [source], merged: false };
    out.push(fresh);
    if (key != null) byMaterial.set(key, fresh);
  });

  for (const row of out) {
    row.merged = row.sources.length > 1;
    // Consolidation speaks about the rate only when it actually merges. A lone
    // line keeps whatever the caller already resolved for it — the requisition's
    // estimate on a conversion, the buyer's own number on a direct PO.
    if (!row.merged) continue;
    const resolved = mergedRate ? mergedRate(row.sources) : null;
    // Presence, not truthiness: a resolver returning 0 means a free line and is
    // honoured; null means nothing on file, and the top-most line stands in.
    if (resolved != null && resolved !== '') row.rate = +resolved;
  }

  return out;
}

// Editing a PO collapses duplicates too, but only among lines with nothing
// received. A settled line — anything accepted into stock or still sitting in a
// quarantine GRN — keeps its own row AND its own id, because that id is what
// every GRN points at; folding it into a neighbour would strand real receipts.
//
// So a board half-received and then re-ordered ends up on two lines, one settled
// and one open. That is not a failure to consolidate: it is what happened to the
// board, and the settled half has receipts to prove it.
//
// Returns the rows to write plus `mergedAway` — ids a merge folded into another
// row, which the caller deletes. They are zero-receipt by construction.
export function consolidateEdit(lines, isSettled = () => false) {
  const settled = [], open = [];
  // Position is the row number the user sees, kept across the partition so a
  // confirmation can say "lines 2 and 5" about the original form, not about the
  // filtered subset.
  (lines || []).forEach((l, i) => {
    const tagged = { ...l, position: i + 1 };
    (isSettled(l) ? settled : open).push(tagged);
  });
  // Each settled line goes through alone: same row shape as the rest, and no
  // chance of grouping with anything.
  const rows = [...settled.flatMap(l => consolidate([l])), ...consolidate(open)];
  const mergedAway = [];
  for (const row of rows) {
    // Keep the first contributing line that already exists, so the surviving row
    // holds a real id instead of being deleted and re-inserted.
    const survivor = row.sources.find(s => s.id);
    if (survivor) row.id = survivor.id;
    for (const s of row.sources) if (s.id && +s.id !== +row.id) mergedAway.push(+s.id);
  }
  return { rows, mergedAway };
}

// What the confirmation says before a PO goes through. One sentence per material
// that actually merged; nothing to say when nothing merged.
export function mergeSummary(rows, nameOf) {
  return rows.filter(r => r.merged).map(r => ({
    material_id: r.material_id,
    name: nameOf ? nameOf(r.material_id) : String(r.material_id),
    qty: r.qty,
    unit: r.unit || '',
    lineCount: r.sources.length,
    rate: r.rate,
    // Positions the buyer can see on screen, 1-based, and the rates that lost —
    // a merge that quietly picks one of two different numbers has to say so.
    // `position` wins when present: a PO edit partitions settled lines out before
    // grouping, so the index within the group is no longer the row on screen.
    positions: r.sources.map(s => s.position ?? s.index + 1),
    dropped: r.sources
      .filter(s => s.rate !== '' && s.rate != null && +s.rate !== +r.rate)
      .map(s => ({ position: s.index + 1, rate: +s.rate })),
    // Every rate the contributing lines asked for, winner included. The convert
    // form shows these rather than the resolved rate: picking a vendor reprices
    // the line afterwards, so any number quoted at open time would go stale.
    estimates: [...new Set(r.sources
      .filter(s => s.rate !== '' && s.rate != null)
      .map(s => +s.rate))],
  }));
}
