// Multi-order tolerance cascade allocation.
//
// Given a pool of available finished goods for ONE product and the open order
// lines that want it, distribute the pool across the lines respecting each
// line's customer tolerance. Fill each line up to its tolerance ceiling
// (ordered × (1 + tol%)) in priority order; the remainder that no order can
// absorb within tolerance is the leftover that gets boxed.
//
// Pure + deterministic — the caller decides the priority order of `lines`.
//
// line: { order_line_id, order_id, ordered, dispatched, tolerance_pct, ... }
// returns {
//   allocations: [{ ...line, need, allowed_max, tolerance_room, dispatch_qty, fills_order, uses_tolerance }],
//   dispatched_total, leftover
// }
export function cascadeAllocate(available, lines = []) {
  let pool = Math.max(0, Math.floor(+available || 0));
  const allocations = lines.map(line => {
    const ordered = Math.max(0, +line.ordered || 0);
    const dispatched = Math.max(0, +line.dispatched || 0);
    const tol = Math.max(0, +line.tolerance_pct || 0);
    const allowedMax = Math.floor(ordered * (1 + tol / 100));
    const need = Math.max(0, ordered - dispatched);          // still owed on the order
    const room = Math.max(0, allowedMax - dispatched);       // dispatchable within tolerance
    const give = Math.min(pool, room);
    pool -= give;
    return {
      ...line,
      ordered, dispatched, tolerance_pct: tol,
      need, allowed_max: allowedMax, tolerance_room: room,
      dispatch_qty: give,
      fills_order: give >= need && need > 0,
      uses_tolerance: dispatched + give > ordered,           // dipped into tolerance band
    };
  });
  const dispatched_total = allocations.reduce((s, a) => s + a.dispatch_qty, 0);
  return { allocations, dispatched_total, leftover: pool };
}

// Annotate the Ready-to-Dispatch rows with what the cascade would actually do.
//
// `fg_qty` is a PRODUCT pool, so this groups by product before allocating. A
// per-row `min(fg, tolerance room)` would promise the same cartons to every
// line that wants that product — two lines against one 10,000-carton pool would
// each advertise 10,000 and the totals would collapse on the first dispatch.
//
// The excess is likewise a property of the pool, not of a line: it is
// attributed to that product's LAST line in cascade order so summing the column
// gives the real excess, not one copy per row. Short is the opposite — it
// belongs to each order individually and is set on every line.
//
// Pure so the double-count is provable without a database. `perBox` maps
// product_id → pieces per carton (0 when nothing is on record).
export function annotateReadyLines(rows = [], perBox = new Map()) {
  const byProduct = new Map();
  for (const l of rows) {
    if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
    byProduct.get(l.product_id).push(l);
  }
  for (const [productId, lines] of byProduct) {
    const plan = cascadeAllocate(lines[0].fg_qty, lines.map(l => ({
      order_line_id: l.order_line_id, ordered: l.qty,
      dispatched: l.dispatched_qty, tolerance_pct: l.tolerance_pct,
    })));
    const per = perBox.get(productId) || 0;
    for (const l of lines) {
      const a = plan.allocations.find(x => x.order_line_id === l.order_line_id);
      l.suggested_dispatch = a?.dispatch_qty ?? 0;
      l.tolerance_room = a?.tolerance_room ?? 0;
      l.uses_tolerance = a?.uses_tolerance ?? false;
      l.leftover_qty = 0;
      l.qty_per_box = per;
      l.shares_pool_with = lines.length - 1;
      // SHORT is per LINE: what this order still lacks once the pool has given
      // it everything it can. Unlike excess it is never shared — each order is
      // short on its own account, so it is not attributed to a single row.
      l.short_qty = Math.max(0, (l.qty - l.dispatched_qty) - l.suggested_dispatch);
    }
    // EXCESS is the pool's, so it lands on the product's last line only.
    lines[lines.length - 1].leftover_qty = plan.leftover;
  }
  return rows;
}
