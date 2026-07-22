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
