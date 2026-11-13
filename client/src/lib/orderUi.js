// The Order finalised panel's sums (owner, 12 Nov 2026: "the price … pre-filled but still editable … it needs to be
// mentioned what the loss is where we have booked this order"). The server pre-fills each line and costs it
// (server/src/order-finalise.js); here the rate and quantity as the person types them are set against that cost a
// carton, so the margin or loss shows at once. Finalising sends the typed figures and the server works them out again.

// From Final price on, a row with a complete costing can be finalised as an order (server: routes/enquiries.js ORDER_FROM).
export const ORDER_STAGES = new Set(['costed', 'price_pending', 'quote_ready', 'sent', 'countered']);
export const canOrder = e => !!e && !!e.costing_complete && ORDER_STAGES.has(e.stage) && !e.order_id;

const num = v => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

// One line as shown: the server's line with the person's edits ({ qty, rate, new_die } as typed).
export function shownLine(l, ed = {}) {
  const qty = ed.qty !== undefined ? num(ed.qty) : l.qty;
  const rate = ed.rate !== undefined ? num(ed.rate) : l.rate;
  const margin = l.cost != null && rate != null ? rate - l.cost : null;
  return {
    ...l,
    qty,
    rate,
    new_die: typeof ed.new_die === 'boolean' ? ed.new_die : !!l.new_die,
    value: rate != null && qty ? rate * qty : null,
    margin,
    margin_total: margin != null && qty ? margin * qty : null,
    bad: !(qty > 0) ? 'quantity' : !(rate > 0) ? 'rate' : null,
  };
}

export function shownTotals(lines) {
  let total = 0, loss = 0, atLoss = 0, newDies = 0;
  for (const l of lines) {
    total += l.value || 0;
    if (l.margin_total != null && l.margin_total < 0) { loss += -l.margin_total; atLoss++; }
    if (l.new_die) newDies++;
  }
  // money, to the paisa
  const r2 = x => Math.round(x * 100) / 100;
  return { total: r2(total), loss: r2(loss), atLoss, newDies };
}
