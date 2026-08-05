// Pure cutting-variance math — no DB. Warehouse stock is held in parent
// (mother) sheets; cutting converts each parent into `children_per_parent`
// child print-sheets. The operator types the child sheets he produced; we
// derive how many parents were actually cut and how that differs from the
// job card, so the warehouse and the record can be trued-up.
//
// A cut parent yields `cpp` children whether or not all are kept, so the
// parents consumed are derived from (good + scrap) children.
export function cuttingVariance({ qty_out = 0, qty_scrap = 0, children_per_parent = 1, sheets_issued = 0 } = {}) {
  const cpp = Math.max(1, +children_per_parent || 1);
  const plannedParents = Math.max(0, Math.round(+sheets_issued || 0));
  const actualChildren = Math.max(0, (+qty_out || 0) + (+qty_scrap || 0));
  const plannedChildren = plannedParents * cpp;
  const actualParents = Math.round(actualChildren / cpp);
  const parentDelta = actualParents - plannedParents;
  return { cpp, plannedParents, actualParents, parentDelta, plannedChildren, actualChildren, isVariance: parentDelta !== 0 };
}

// Distribute one board's ACTUAL parents back across the member rows a merge
// run's mix is stored on, proportionally to each member's issued share.
//
// THE RULE (documented here because the write path in production.js applies it
// blind): every member except the last gets round-half-up(total × its share ÷
// sum of shares), clamped so the running total can never exceed the total
// being distributed; the LAST member takes the exact remainder, so the shares
// always sum to `total` to the sheet. The clamp is what keeps the remainder
// non-negative when several half-up roundings land in a row (total 2 across
// four equal shares is 1+1+0+0, never 1+1+1+(−1)). Zero shares everywhere —
// a degenerate mix — puts the whole total on the last member rather than
// dividing by zero.
//
// Pure, like everything in this file: integers out, Σ === round(total), no DB.
export function distributeActualAcrossMembers(total, shares = []) {
  const t = Math.max(0, Math.round(+total || 0));
  const s = shares.map(x => Math.max(0, Number(x) || 0));
  if (!s.length) return [];
  const sum = s.reduce((a, b) => a + b, 0);
  const out = [];
  let assigned = 0;
  for (let i = 0; i < s.length; i++) {
    if (i === s.length - 1) { out.push(t - assigned); break; }
    const share = Math.min(sum > 0 ? Math.round(t * s[i] / sum) : 0, t - assigned);
    out.push(share);
    assigned += share;
  }
  return out;
}

// Per-board cutting variance for mixed jobs. The operator reports children
// PER BOARD; each pile is judged against its own chosen cuts and trues up its
// own board's stock. cuttingVariance above stays byte-identical for the
// single-board path.
export function mixCuttingVariance({ rows = [] } = {}) {
  const out = rows.map(r => {
    const cpp = Math.max(1, +r.cuts || 1);
    const plannedParents = Math.max(0, Math.round(+r.issued || 0));
    const actualChildren = Math.max(0, Math.round(+r.children || 0));
    const actualParents = Math.round(actualChildren / cpp);
    return { material_id: r.material_id, cpp, plannedParents, actualParents,
             parentDelta: actualParents - plannedParents,
             plannedChildren: plannedParents * cpp, actualChildren };
  });
  const sum = k => out.reduce((s, r) => s + r[k], 0);
  return { rows: out,
           plannedParents: sum('plannedParents'), actualParents: sum('actualParents'),
           plannedChildren: sum('plannedChildren'), actualChildren: sum('actualChildren'),
           parentDelta: sum('actualParents') - sum('plannedParents'),
           isVariance: out.some(r => r.parentDelta !== 0) };
}
