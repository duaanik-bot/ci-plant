// PURE — batch rows in, a draw plan out. No pg, no await, nothing to mock.
//
// A sealed packet is indivisible: the card asks for 100 sheets, the operator
// opens a packet of 250 and is bound to cut the bundle. The extra sheets leave
// the warehouse whether or not the book says they exist. This module decides
// how much of a demand real stock can cover and how much has to be WRITTEN ON
// — admitted as a book correction — so the balance can land at nil instead of
// going negative. A board reading -150 sheets is not a fact about a warehouse.
//
// Batch order is the caller's responsibility: pass them FIFO and the draw is
// FIFO. Non-positive batches are skipped, never credited, so historic negative
// CUT-SHORT / ADJ-NEG rows cannot silently fund a new issue.

const num = v => Number(v) || 0;

export function planWriteOn(batches = [], demand = 0) {
  let remaining = Math.max(0, num(demand));
  const wanted = remaining;
  const takes = [];
  for (const b of batches || []) {
    if (remaining <= 0) break;
    const have = num(b?.qty);
    if (have <= 0) continue;
    const take = Math.min(have, remaining);
    takes.push({ batch_id: b.id, take, left: have - take });
    remaining -= take;
  }
  return { takes, covered: wanted - remaining, shortfall: remaining, writeOn: remaining > 0 };
}
