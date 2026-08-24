import { NO_LIMIT, isNoLimit, toleranceCeiling, ceilingForWire } from './tolerance.js';

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
//   allocations: [{ ...line, need, allowed_max, tolerance_room, tolerance_no_limit,
//                   dispatch_qty, fills_order, uses_tolerance }],
//   dispatched_total, leftover
// }
//
// `allowed_max` is null under a no-limit customer — there is no ceiling, and
// Infinity does not survive JSON. `tolerance_room` is the CASCADE room: how
// much this line will be offered, which under a finite tolerance is
// ceiling - dispatched and under no-limit is the outstanding need.
export function cascadeAllocate(available, lines = []) {
  let pool = Math.max(0, Math.floor(+available || 0));
  const allocations = lines.map(line => {
    const ordered = Math.max(0, +line.ordered || 0);
    const dispatched = Math.max(0, +line.dispatched || 0);
    const noLimit = isNoLimit(line.tolerance_pct);
    const tol = noLimit ? NO_LIMIT : Math.max(0, +line.tolerance_pct || 0);
    const need = Math.max(0, ordered - dispatched);          // still owed on the order
    // A no-limit customer has no ceiling — but the SUGGESTION still stops at
    // what the order actually wants. Otherwise the first line in cascade order
    // swallows the whole product pool and every later order reads as short.
    // No limit lifts the GATE; it does not redirect the stock.
    const room = noLimit ? need : Math.max(0, toleranceCeiling(ordered, tol) - dispatched);
    const give = Math.min(pool, room);
    pool -= give;
    return {
      ...line,
      ordered, dispatched, tolerance_pct: tol,
      tolerance_no_limit: noLimit,
      need, allowed_max: ceilingForWire(ordered, tol), tolerance_room: room,
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
      l.tolerance_no_limit = a?.tolerance_no_limit ?? false;
      l.allowed_max = a?.allowed_max ?? null;
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
