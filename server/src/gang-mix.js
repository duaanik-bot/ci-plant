// Splitting ONE run's board mix across the member lines it is made of. PURE —
// plain rows in, plain rows out. Same contract as board-mix.js and
// board-allocation.js, and for the same reason: these numbers decide what a job
// may draw from the warehouse.
//
// ── Why a split at all ─────────────────────────────────────────────────────
// A gang or Combined Run is planned as ONE pile — one board, one press run, one
// PR — and that is how the planner enters its mix: "5,100 sheets, 4,850 off the
// 340 GSM and 250 off the 350". But job_board_mix is keyed on order_line_id
// (NOT NULL, and a gang PARENT job card has no order line at all), and every
// downstream reader — readiness()'s release gate, mixPosition, consumeMixHolds,
// the job card print — asks its question one LINE at a time.
//
// So the run's mix is stored the way the run's ISSUE already is: distributed
// across the members, summing to exactly what the planner typed. Nothing
// downstream learns a new key, no migration, and a gang member's mix balances
// against its own requirement exactly as a solo line's always has.
//
// ── Why a waterfall and not proportional rounding ──────────────────────────
// The obvious split — round each row proportionally per member, as the plan
// route already does for issue_parent_sheets — is WRONG here, because there are
// two marginals to satisfy at once, not one. Each member's rows must sum to that
// member's requirement AND each board's shares must sum to the sheets written
// against it. Rounding each row independently satisfies only the second:
//
//   run 100 = member A 50 + member B 50, mix = board X 33 + board Y 67
//   round X → 17/16, round Y → 34/33   ⇒ A gets 51, B gets 49
//
// A is now over-covered and B is short, so B's plan-save balance throws on
// arithmetic the planner never typed. A waterfall — walk the members in order,
// filling each from the boards in order until its requirement is met — hits both
// marginals exactly, in integers, with no rounding step to get wrong.
const num = v => Number(v || 0);

// members: [{ id, required }] in parent sheets · rows: [{ material_id, sheets, … }]
// Returns [{ member_id, rows: [...] }] — each row a shallow copy of the input
// row carrying only THIS member's share, zero shares dropped (job_board_mix
// CHECKs sheets > 0, and a member that draws nothing off a board should not
// carry an empty row for it).
//
// Throws on a total mismatch rather than silently short-changing the last
// member: the route validates the balance against the planner first and shows a
// sentence, so anything reaching here with mismatched totals is a bug, and a
// bug that quietly writes an unbalanced mix is exactly the kind the release gate
// would then wave through.
export function splitMixAcrossMembers({ members = [], rows = [] }) {
  const need = members.map(m => ({ id: m.id, left: Math.round(num(m.required)) }));
  const pool = rows.map(r => ({ row: r, left: Math.round(num(r.sheets)) }));
  const totalNeed = need.reduce((s, m) => s + m.left, 0);
  const totalPool = pool.reduce((s, p) => s + p.left, 0);
  if (totalNeed !== totalPool) {
    throw new Error(
      `gang-mix: the mix holds ${totalPool} sheets against ${totalNeed} required — split them equal first`);
  }
  const out = [];
  let cursor = 0;
  for (const m of need) {
    const mine = [];
    while (m.left > 0 && cursor < pool.length) {
      const p = pool[cursor];
      if (p.left <= 0) { cursor++; continue; }
      const take = Math.min(m.left, p.left);
      mine.push({ ...p.row, sheets: take });
      p.left -= take;
      m.left -= take;
    }
    out.push({ member_id: m.id, rows: mine });
  }
  return out;
}

// The run's mix as the planner typed it, read back out of the members it was
// split across — one row per board, sheets summed. The split is an internal
// storage detail; a planner reopening a locked run must see the same two lines
// they entered, not one per member per board.
//
// `covers` is deliberately NOT summed back: it is per-member arithmetic against
// per-member requirements, and the run panel recomputes its own balance from
// sheets and ups exactly as the line panel does. Carrying a stale sum would give
// the client a second, disagreeing source of truth for the same number.
export function runMixFromMembers(memberRows = []) {
  const byBoard = new Map();
  for (const r of memberRows) {
    const key = r.material_id;
    const hit = byBoard.get(key);
    if (hit) { hit.sheets += num(r.sheets); continue; }
    byBoard.set(key, {
      material_id: r.material_id,
      board_name: r.board_name ?? null,
      sheet_l: r.sheet_l ?? null,
      sheet_w: r.sheet_w ?? null,
      sheets_per_packet: r.sheets_per_packet ?? null,
      ups: num(r.ups),
      role: r.role,
      reason: r.reason ?? null,
      // A lot is picked per board, and the split hands the same lot to every
      // member drawing off that board, so the first row's is the run's.
      stock_batch_id: r.stock_batch_id ?? null,
      sheets: num(r.sheets),
    });
  }
  // Planned board first, then insertion order — the same ordering mixFor()
  // returns per line, so the run panel and the line panel read alike.
  return [...byBoard.values()].sort((a, b) => (b.role === 'planned') - (a.role === 'planned'));
}

// What a run's issue actually presses on its PLANNED board.
//
// Without a mix that is the whole requirement, and every caller reads exactly
// what it read before this module existed. With one it is the sheets written
// against the planned board plus whatever the mix has NOT covered — the rule
// board-mix.js's mixPosition applies line by line: a substitute board is never
// "needed" beyond what is explicitly written against it, and only the planned
// board carries the unmet remainder.
//
// Without this a run covered off a second board still reads "Short — cutting
// waits for stock" and still offers a PR for board the planner has just
// finished sourcing, which is the whole reason they opened the mix.
// Planning.jsx mirrors this inline off the LIVE draft (both the Board Position
// card and the dialog footer derive `short` themselves, so a server-only fix
// would show nothing on screen) — keep the two in step.
export function pressingOnPlanned({ required, active, covered = 0, heldOnPlanned = 0 }) {
  const req = num(required);
  if (!active) return req;
  return num(heldOnPlanned) + Math.max(0, req - num(covered));
}
