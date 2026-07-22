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
