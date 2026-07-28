// Replenishment maths — how much of a board to buy, and why a PR was raised.
//
// Mirrored verbatim in client/src/lib/replenishment.js. replenishment.test.js
// asserts the two twins produce identical output — keep them in sync.
//
// Nothing here touches the database. The route supplies the two aggregates
// (committed demand, open-PO quantity) and this decides the number, so the RM
// Stock table, the Material 360° drawer and the PR form can never disagree
// about what a board needs.

// Why a requisition was raised. A closed vocabulary so the register always has
// something to render; unknown input falls back to the job-driven default.
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
//
// `available` is NOT clamped before the arithmetic. A count corrected below zero
// is a real position in this plant, and the suggestion should refill the hole.
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

  // max_stock of 0 means "not set", never "hold no stock".
  if (max > 0) need = Math.min(need, Math.max(0, max - available - incoming));
  if (!(need > EPS)) return 0;

  const per = +m?.sheets_per_packet || 0;
  return per > 0 ? Math.ceil(need / per - EPS) * per : need;
}

// Attach the derived fields to one raw stock row. `demand` is kept alongside the
// new `reserved` key because existing callers (dashboard, exports, the 360°
// drawer) already read it — renaming it outright would break them silently.
//
// `short` and `suggested` answer different questions and can legitimately
// disagree. `short` is a current-shelf alarm — is physical stock below
// reorder_level right now — and deliberately ignores `incoming`. `suggested`
// is forward-looking order sizing and nets `incoming` out. A line with a large
// open PO can show short=true (the shelf is bare today) alongside suggested=0
// (the PO already covers it) — that is correct, not a bug. Do not "fix" short
// to net out incoming: routes/inventory.js and other screens depend on its
// current-shelf meaning.
export function enrichStockRow(m, { reserved = 0, incoming = 0 } = {}) {
  const row = { ...m, reserved: +reserved || 0, demand: +reserved || 0, incoming: +incoming || 0 };
  return {
    ...row,
    suggested: suggestedQty(row),
    short: (+m.reorder_level || 0) > (+m.available || 0) || (+reserved || 0) > (+m.available || 0),
  };
}
