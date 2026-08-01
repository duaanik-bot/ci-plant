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

// The warehouse position of ONE board. Twin of stockSplit in
// server/src/replenishment.js — keep them identical.
//
// Gross is what is physically on the shelf. Committed is what the PLANNING
// ENGINE has locked against named jobs (a live board_allocations row), not a
// requirement inferred from an order line's status — only a made-and-locked
// plan may be subtracted from the shelf. Net is what is still free to promise.
//
//   committed = min(locked, gross)     the locks, never more than exists
//   net       = gross − committed      free to give
//   over      = locked − committed     locked beyond the shelf, to reconcile
//
// committed + net === gross exactly, per board and for any sum of boards, so
// Gross = Committed + Net always holds. Never netted across boards: a surplus
// of Saffire cannot cover a shortage of Duplex.
export function stockSplit(m) {
  const EPS = 1e-6; // qty columns are DOUBLE PRECISION — see suggestedQty above
  const gross = Math.max(0, +m?.available || 0);
  const locked = Math.max(0, +m?.committed_qty || 0);
  const committed = Math.min(locked, gross);
  const net = gross - committed;
  const over = locked - committed;
  return {
    committed,
    net,
    over_committed: over > EPS ? over : 0,
  };
}

// A master field left at 0 means "not set" — the UI shows "—", never a
// confident zero. Same rule boardMath follows for an incomplete board.
export const unset = v => !(+v > 0);
