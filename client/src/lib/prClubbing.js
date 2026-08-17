// Requisitions are raised independently — different people, different jobs,
// different days — so the same board ends up spread across several open PRs, or
// named twice inside one. Nothing is wrong with that; it is what independent
// raising looks like.
//
// The cost lands later. A buyer who converts them one at a time gets one
// purchase order per requisition, and the vendor gets the same board on three
// separate orders the same day. PO consolidation cannot fix that — it merges
// lines WITHIN an order, and these are different orders. The only place the
// merge is still possible is before the order exists, which is why these
// suggestions live on the requisition register.

const OPEN = ['pending', 'approved'];

const key = id => (id == null || id === '' ? null : String(id));

// Every line of a requisition, flattened. Older rows carry the material on the
// header instead of a lines array, and those still count.
function linesOf(pr) {
  if (pr.lines?.length) return pr.lines;
  return pr.material_id ? [{ material_id: pr.material_id, material_name: pr.material_name, qty: pr.qty, unit: pr.unit }] : [];
}

// Two shapes worth offering, both keyed on the material:
//
//   acrossPrs — one board wanted by several open requisitions. Selecting them
//               together makes ONE order, which is where PO consolidation can
//               finally do its job.
//   withinPr  — one requisition naming the same board on more than one line.
//               Clubbing those is a straight edit of that requisition.
//
// A PR raised against an order line is included in both. The PR form treats a
// different product's PR on the same board as "information, not a duplicate",
// and that is right for warning about a re-raise — but it is the wrong test
// here. Two jobs needing the same board is exactly the case worth buying once.
export function clubSuggestions(prs, { statuses = OPEN } = {}) {
  const open = (prs || []).filter(p => statuses.includes(p.status));

  const byMaterial = new Map();
  const withinPr = [];

  for (const pr of open) {
    const mine = new Map();
    for (const l of linesOf(pr)) {
      const k = key(l.material_id);
      if (k == null) continue;
      if (!mine.has(k)) mine.set(k, { material_id: l.material_id, material_name: l.material_name, unit: l.unit, qty: 0, lines: 0 });
      const m = mine.get(k);
      m.qty += +l.qty || 0;
      m.lines += 1;
    }
    for (const [k, m] of mine) {
      if (m.lines > 1) {
        withinPr.push({
          kind: 'within-pr',
          requisition_id: pr.id, pr_number: pr.pr_number, status: pr.status,
          material_id: m.material_id, material_name: m.material_name, unit: m.unit,
          lineCount: m.lines, total_qty: m.qty,
        });
      }
      // The PR contributes ONE demand for this board however many lines it used.
      if (!byMaterial.has(k)) byMaterial.set(k, { material_id: m.material_id, material_name: m.material_name, unit: m.unit, prs: [] });
      byMaterial.get(k).prs.push({ id: pr.id, pr_number: pr.pr_number, status: pr.status, qty: m.qty });
    }
  }

  const acrossPrs = [];
  for (const m of byMaterial.values()) {
    if (m.prs.length < 2) continue;
    acrossPrs.push({
      kind: 'across-prs',
      material_id: m.material_id, material_name: m.material_name, unit: m.unit,
      prs: m.prs.slice().sort((a, b) => String(a.pr_number).localeCompare(String(b.pr_number))),
      prCount: m.prs.length,
      total_qty: m.prs.reduce((s, p) => s + p.qty, 0),
      // Only a set of PRs that are ALL approved can go onto an order right now.
      // A pending one has to be approved first, and saying so up front beats a
      // refusal after the buyer has clicked.
      readyToOrder: m.prs.every(p => p.status === 'approved'),
    });
  }
  // Biggest club first, then the largest quantity — the order a buyer would
  // work down.
  acrossPrs.sort((a, b) => b.prCount - a.prCount || b.total_qty - a.total_qty
    || String(a.material_name || '').localeCompare(String(b.material_name || '')));
  withinPr.sort((a, b) => b.total_qty - a.total_qty || String(a.pr_number).localeCompare(String(b.pr_number)));

  return { acrossPrs, withinPr };
}
