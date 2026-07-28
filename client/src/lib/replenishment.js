// Replenishment maths — how much of a board to buy, and why a PR was raised.
//
// Client twin of server/src/replenishment.js — used so the PR form can show a
// live suggestion as the buyer edits, before anything hits the server.
// replenishment.test.js asserts the two twins produce identical output — keep
// them in sync.

export const PR_PURPOSES = ['production', 'stock_replenishment', 'reorder_level', 'general_inventory'];

export function normalisePurpose(v) {
  const s = String(v ?? '');
  return PR_PURPOSES.includes(s) ? s : 'production';
}

// How many units to buy:
//   need = committed demand + reorder buffer − on hand − already on order
// then capped so the resulting POSITION never exceeds max_stock (when set),
// then rounded UP to a whole packet, because board is bought by the packet.
//
// The round-up runs last and can overshoot max_stock by less than one packet.
// That is deliberate: half a packet is not purchasable.
export function suggestedQty(m) {
  const available = +m?.available || 0;
  const reserved = +m?.reserved || 0;
  const incoming = +m?.incoming || 0;
  const reorder = +m?.reorder_level || 0;
  const max = +m?.max_stock || 0;

  const EPS = 1e-6; // sheet counts are conceptually whole numbers; guard against
                    // SUM()-accumulated float noise (see helpers.js childFit).

  let need = reserved + reorder - available - incoming;
  if (!(need > EPS)) return 0;

  if (max > 0) need = Math.min(need, Math.max(0, max - available - incoming));
  if (!(need > EPS)) return 0;

  const per = +m?.sheets_per_packet || 0;
  return per > 0 ? Math.ceil(need / per - EPS) * per : need;
}

// A master field left at 0 means "not set" — the UI shows "—", never a
// confident zero. Same rule boardMath follows for an incomplete board.
export const unset = v => !(+v > 0);
