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
export function enrichStockRow(m, {
  reserved = 0, incoming = 0,
  committed_qty = 0, committed_lines = 0, pr_qty = 0, pr_count = 0,
} = {}) {
  const row = {
    ...m,
    reserved: +reserved || 0, demand: +reserved || 0, incoming: +incoming || 0,
    // What the Planning Engine has locked, and what has been asked for to
    // cover it — the warehouse's own figures, independent of order-line status.
    committed_qty: +committed_qty || 0, committed_lines: +committed_lines || 0,
    pr_qty: +pr_qty || 0, pr_count: +pr_count || 0,
  };
  return {
    ...row,
    ...stockSplit(row),
    suggested: suggestedQty(row),
    short: (+m.reorder_level || 0) > (+m.available || 0) || (+reserved || 0) > (+m.available || 0),
  };
}

// COMMITTED BOARD DEMAND — the plant's single definition, as SQL.
//
// Anik's words: "the board which we have already covered for various products …
// and the planning locked which has been posted to artworks or whatever
// stations". So a board is committed once planning has FIXED it to a job —
// `planned` — and stays committed while that job moves down the floor —
// `in_production`. `pending` is not committed: nothing has been decided yet.
//
// It stops being committed as it is CONSUMED, not when the line changes state.
// Consumption writes a negative stock_movement AND drops the batch, so those
// sheets leave `available` at that moment; counting the full requirement
// afterwards would deduct the same sheets twice. Consumption arrives in
// SEVERAL partial movements (a 6,200-sheet job taking -2,600 then -3,600), so
// this nets the running total instead of treating consumed as all-or-nothing,
// and GREATEST(...,0) stops an over-draw lending demand back.
//
// NOT board_allocations. Those explicit holds are one mechanism inside this —
// on the live plant only 2 of 63 committed lines carry one (5,000 sheets
// against 75,771 of real commitment), so reading them alone would tell the
// warehouse almost everything was free. A line's own hold is already inside
// its requirement here, so the two must never be added together.
//
// A LINE CAN BE BOOKED ACROSS SEVERAL BOARDS. When the Planning Engine splits a
// job — 4,000 sheets off the 23×36 and 1,000 off the 25×36 of the same grade —
// the demand belongs to those boards in those amounts. Charging the whole
// requirement to the line's single nominal board over-states the one it names
// (a phantom "1,000 over") and leaves the other looking free when 1,000 of it is
// spoken for. So an active board_allocations row DIRECTS demand to its own
// board, and only what planning has NOT split lands on the nominal board.
//
// Allocation quantities are in parent sheets, the same unit as the requirement.
//
// PARENT (mother) sheets — the unit the warehouse stocks and `available`
// reports. A job-only spec_override board beats the product master, the same
// rule the board picker and the planning engine follow.
export const COMMITTED_DEMAND_SQL = `
  WITH ln AS (
    SELECT ol.id, ol.product_id,
           COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS nominal_id,
           COALESCE(ol.parent_sheets_required, ol.sheets_required) AS need
    FROM order_lines ol
    JOIN products p ON p.id = ol.product_id
    WHERE ol.status IN ('planned','ready','in_production')
      -- A GANG/MERGE run's board is consumed against the RUN's parent card,
      -- which carries no order_line_id of its own (the GANG_ANCHOR_LINE trap).
      -- The "used" LATERAL below matches a line to its card by order_line_id,
      -- so for a run member it matches NOTHING and the member keeps its whole
      -- requirement counted as still-owed board the warehouse must find —
      -- long after the run drew every sheet. On the live plant that inflated
      -- SIX boards by 18,082 sheets and put a red "+3,000 over" on a board the
      -- run had already emptied and paid for (CI-JC-0050 / CI-MRG-0001).
      --
      -- Same rule, same direction as BOARD_DRAWN_EXISTS in helpers.js: once a
      -- job has drawn its board the claim is CLOSED however little is left on
      -- the shelf. Applied only to run members — a single-line card still nets
      -- by quantity through "used", so partial draws keep their residue.
      AND NOT (ol.gang_run_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM stock_movements sm
            JOIN job_cards jc ON jc.id = sm.ref_id AND sm.ref_type='job_card'
            WHERE sm.type='consumption' AND jc.order_line_id IS NULL
              AND jc.gang_run_id = ol.gang_run_id))
  ),
  al AS (
    -- Only live holds. A consumed allocation has already left the shelf and a
    -- released one was given back; counting either would double-book.
    SELECT ba.order_line_id, ba.material_id, SUM(ba.qty) AS qty
    FROM board_allocations ba
    WHERE ba.status = 'active'
    GROUP BY 1, 2
  ),
  pair AS (
    SELECT l.id, l.product_id, a.material_id, a.qty
    FROM ln l JOIN al a ON a.order_line_id = l.id
    UNION ALL
    -- Whatever planning has not pinned to a board stays on the line's own.
    SELECT l.id, l.product_id, l.nominal_id,
           GREATEST(l.need - COALESCE(t.qty, 0), 0)
    FROM ln l
    LEFT JOIN (SELECT order_line_id, SUM(qty) AS qty FROM al GROUP BY 1) t
           ON t.order_line_id = l.id
    WHERE l.nominal_id IS NOT NULL
  ),
  book AS (
    -- Collapse first: a line can reach one board BOTH by allocation and as the
    -- remainder, and consumption must be netted off the pair once, not per row.
    SELECT id, product_id, material_id, SUM(qty) AS qty
    FROM pair WHERE material_id IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT b.material_id,
         SUM(GREATEST(b.qty - COALESCE(used.qty, 0), 0)) AS q,
         COUNT(*) FILTER (WHERE b.qty > COALESCE(used.qty, 0))::int AS n,
         ARRAY_AGG(DISTINCT b.id)         FILTER (WHERE b.qty > COALESCE(used.qty, 0)) AS line_ids,
         ARRAY_AGG(DISTINCT b.product_id) FILTER (WHERE b.qty > COALESCE(used.qty, 0)) AS product_ids
  FROM book b
  LEFT JOIN LATERAL (
    -- What this line has already drawn off the shelf for THIS board. Matched
    -- through its own job card; a gang parent carrying no order_line_id
    -- matches nothing and keeps its demand counted in full — the cautious
    -- direction for a warehouse.
    SELECT COALESCE(SUM(-sm.qty), 0) AS qty
    FROM stock_movements sm
    JOIN job_cards jc ON jc.id = sm.ref_id
    WHERE sm.ref_type = 'job_card' AND sm.type = 'consumption'
      AND jc.order_line_id = b.id
      AND sm.material_id = b.material_id
  ) used ON true
  GROUP BY 1
  UNION ALL
  SELECT x.board_material_id,
         SUM(x.qty) AS q,
         COUNT(*)::int AS n,
         NULL::int[] AS line_ids,
         NULL::int[] AS product_ids
  FROM extra_sheet_requests x
  WHERE x.status IN ('approved','sent_to_cutting','cutting_in_progress','cutting_completed','ready_for_printing')
    AND x.board_material_id IS NOT NULL
  GROUP BY x.board_material_id`;

// THE WAREHOUSE POSITION OF ONE BOARD.
//
// Gross is what is physically on the shelf right now. Committed is what the
// PLANNING ENGINE has locked against named jobs — a live row in
// board_allocations, not a requirement inferred from an order line's status.
// That distinction is the whole point: a plan that has been made and locked is
// a promise the warehouse must honour, and only that may be subtracted from
// the shelf. Net is what is genuinely still free to promise to anyone else.
//
//   committed = min(locked, gross)          the locks, never more than exists
//   net       = gross − committed           free to give
//   over      = locked − committed          locked beyond the shelf (a fault
//                                           to reconcile, never free stock)
//
// committed + net === gross exactly, per board and therefore for any sum of
// boards — so the strip's Gross = Committed + Net always holds. Every figure is
// per-board and none may be netted across boards: a surplus of Saffire cannot
// cover a shortage of Duplex, so summing raw (gross − locked) would report free
// stock the plant does not have.
//
// `gross` is clamped at zero: a count corrected below zero is a reconciliation
// job, not committable stock, and must never subtract from another board.
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
