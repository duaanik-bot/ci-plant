// Several requisitions — or several lines of one requisition, or a buyer typing
// the same board twice — can name one material. The purchase order carries it
// once, with the quantities added up: one line to price, one line to ship.
//
// The requisitions themselves are never touched. This collapses the lines only
// on their way onto the order, which is why it lives here and not in the PR
// module. Its twin is client/src/lib/poConsolidate.js — po-consolidate-parity
// holds the two together.

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
