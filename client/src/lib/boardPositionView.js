// The Planning Engine's BOARD POSITION strip, as arithmetic.
//
// Five tiles that must read as one sentence:
//
//   In Warehouse − Committed = Free,  and  Free − This Plan = Net After Plan
//
// Extracted from Planning.jsx so `node --test` can hold it to that sentence;
// a .jsx file cannot be imported by the test runner.
//
// WHAT WENT WRONG (Saffire · 300 GSM · 23x36, 11 Aug 2026)
//
// ACEBROBID (line 210, in production) had 8,959 sheets frozen on a 9,000-sheet
// shelf. HB-29 (line 295) then planned 700 parent sheets off the same board and
// the panel said:
//
//   In Warehouse 9,000 · Committed 0 · Free 41 · This Plan 700 · Net After 8,300
//   footer: "stock OK"        ← while the Planning list showed "Stock Short −659"
//
// Two separate faults, one cause — `committed` and `free` were measured off
// different things:
//
//   committed  came from committed_other = other jobs' OPEN need. A job whose
//              board is FULLY frozen has no open need left, so ACEBROBID's
//              8,959 vanished from the tile: Committed 0 on a board that is
//              99.5% spoken for, and 0 + 41 ≠ 9,000 — the row stopped adding up.
//
//   net        was available − committed − need, which never subtracted other
//              jobs' HOLDS at all. 9,000 − 0 − 700 = 8,300, a comfortable
//              surplus, so short was 0 and the footer said "stock OK" for a
//              plan with 41 sheets to run on. `free` DID subtract them (41,
//              correct), so the same panel carried both answers at once.
//
// The list was right all along: readiness() asks claimableQty, which counts
// other jobs' holds. Only the panel disagreed — the same "panel and badge
// disagree" family as the OMEZYME refusal, and the reason the sentence above
// is now enforced by test rather than by comment.
//
// A job's OWN hold is never "committed" against it: it is the whole point of a
// freeze that the sheets are waiting for you.

const num = v => Number(v) || 0;

// `committedOpen` — other jobs' unmet need (stock.committed_other)
// `held` / `heldForMe` — all active stock holds on this board, and this job's
// `need` — what this plan still wants from THIS board (0 once cutting drew it)
// `fresh` — the plan buys its board fresh and refuses the shelf
export function boardPositionView({
  available = 0,
  committedOpen = 0,
  held = 0,
  heldForMe = 0,
  need = 0,
  fresh = false,
  drawn = false,
  ownIncoming = 0,
  planParent = 0,
} = {}) {
  const avail = num(available);
  const ownHeld = Math.max(0, num(heldForMe));
  const heldOthers = Math.max(0, num(held) - ownHeld);

  // Other jobs' FULL claim: what they still have to find, plus what they have
  // already frozen. Either half alone is a half-truth — and it was the missing
  // half that let 8,959 reserved sheets read as "Committed 0".
  const committed = num(committedOpen) + heldOthers;

  // Unclamped, so an over-committed board keeps its sign for `net` instead of
  // silently flooring at zero and reporting a shortage one plan too late.
  const freeRaw = avail - committed;
  const free = Math.max(0, freeRaw);

  // What OTHER products may still promise themselves off this shelf. `free` is
  // THIS job's view — a job is never committed against itself, so its own
  // freeze sits inside its own `free`. Any sentence of the form "…stays free
  // for other products" must say THIS number, never `free`: the fresh-PR
  // caption printed position.free (9,000) as "free for other products" on a
  // shelf where 8,959 of the 9,000 was this very job's hold and the true
  // answer was 41 — off by exactly its own freeze, on screen, beside the
  // warehouse register saying 0.41 PKT.
  const freeForOthers = Math.max(0, freeRaw - ownHeld);

  if (fresh) {
    // A fresh_pr plan refuses the shelf, so the shelf is not what it is short
    // of: its still-to-buy is the cut plan less its own PR on order and its own
    // holds. Net is the shelf it leaves alone — unchanged by this plan.
    return {
      available: avail, committed, free, free_for_others: freeForOthers, net: freeRaw,
      drawn: !!drawn, fresh: true, own_incoming: num(ownIncoming),
      short: drawn ? 0 : Math.max(0, num(planParent) - ownHeld - num(ownIncoming)),
    };
  }

  const net = freeRaw - num(need);
  return {
    available: avail, committed, free, free_for_others: freeForOthers, net,
    drawn: !!drawn, fresh: false,
    short: Math.max(0, -net),
  };
}
