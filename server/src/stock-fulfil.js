// Complete from Stock — an order that our own FG boxes fill, pushed straight
// from Planning to Dispatch & Invoice with no job card, and the undo back.
//
// Pure, so every refusal is testable without a database (stock-fulfil.test.js).
// The routes in routes/fg.js do the writing; this only decides.
//
// The identity of a stock-completed line is DERIVED, not stored: it is a line
// that reached 'produced' with no job card of its own, carrying the audit
// marker below. No new column, so no prod migration rides with this feature.

// The audit action that marks the hand-off. The From Stock list is read off it.
export const STOCK_FULFIL_ACTION = 'completed_from_stock';
export const STOCK_UNDO_ACTION = 'returned_to_planning_from_stock';

// Where a line may be completed from stock: still in the planner's hands.
// Once a job card exists the cartons are being made — FG against that is the
// job card's business (consume-fg refuses it the same way).
export const FULFIL_FROM = Object.freeze(['pending', 'planned', 'ready']);

// Why a line cannot take these boxes, or null. `completing` = the ticks cover
// the whole balance; a partial reserve is plain consume-fg, which a run member
// may do today, so the run refusal applies only to the hand-off to Dispatch.
export function fulfilBlock(line, { hasJobCard = false, completing = false } = {}) {
  if (!line) return 'Order line not found';
  if (!FULFIL_FROM.includes(line.status))
    return `This line is ${line.status} — only a line still in planning can be completed from stock`;
  if (hasJobCard) return 'A job card already exists for this line — adjust the job card instead';
  // A run member prints on a shared sheet with its mates. Completing ONE from
  // stock would leave its ups on the plate with nobody to own them.
  if (completing && line.gang_run_id != null)
    return 'This line prints in a gang / combined run — take it out of the run first, then complete it from stock';
  return null;
}

// The ticked boxes, cleaned: whole positive quantities, one entry per box,
// sorted by lot id so two planners ticking overlapping boxes lock them in the
// same order (no deadlock). Throws a 400 on anything a planner could not mean.
export function normalisePicks(picks) {
  if (!Array.isArray(picks) || !picks.length)
    throw Object.assign(new Error('Tick at least one box to despatch'), { status: 400 });
  const seen = new Set();
  const out = [];
  for (const p of picks) {
    const lotId = Number(p?.lot_id);
    const qty = Number(p?.qty);
    if (!Number.isInteger(lotId) || lotId <= 0)
      throw Object.assign(new Error('Every ticked box needs a stock reference'), { status: 400 });
    if (!Number.isInteger(qty) || qty <= 0)
      throw Object.assign(new Error('Every ticked box needs a whole, positive quantity'), { status: 400 });
    if (seen.has(lotId))
      throw Object.assign(new Error('The same box was ticked twice'), { status: 400 });
    seen.add(lotId);
    out.push({ lot_id: lotId, qty });
  }
  return out.sort((a, b) => a.lot_id - b.lot_id);
}

// Does this pick finish the order? `balance` is netProduceQty BEFORE the pick.
export function completesOrder(balance, picks) {
  const total = picks.reduce((s, p) => s + p.qty, 0);
  return balance > 0 && total >= balance;
}

// Why a stock-completed line cannot go back to planning, or null. Cartons that
// have left on a challan cannot be un-shipped — a partial despatch is final.
export function undoBlock(line, { hasJobCard = false, reservedQty = 0, markedFromStock = false } = {}) {
  if (!line) return 'Order line not found';
  if (line.status === 'dispatched' || (+line.dispatched_qty || 0) > 0)
    return `${+line.dispatched_qty || 0} pcs have already been despatched on this line — it cannot go back to planning`;
  if (line.status !== 'produced')
    return `This line is ${line.status} — only a line completed from stock and waiting in Dispatch can be undone`;
  if (hasJobCard || !markedFromStock)
    return 'This line was completed by production, not from stock — use the job card to change it';
  if (!(reservedQty > 0)) return 'No stock is reserved on this line';
  return null;
}
