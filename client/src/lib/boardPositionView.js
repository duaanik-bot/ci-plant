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
  heldOthers: heldOthersIn = null,
  need = 0,
  fresh = false,
  drawn = false,
  ownIncoming = 0,
  planParent = 0,
} = {}) {
  const avail = num(available);
  const ownHeld = Math.max(0, num(heldForMe));
  // Others' holds come from the SERVER (linePosition.held_others), because only
  // there are the per-line caps known. Deriving it as held − heldForMe subtracts
  // an UNCAPPED own hold from a CAPPED total, so a line holding more than its
  // need — every Commit before the first Save, when parent_sheets_required is
  // still NULL — erased a rival's hold by the overage and overstated Free.
  // The subtraction survives only as the fallback for a caller that has not
  // been taught the field.
  const heldOthers = heldOthersIn != null
    ? Math.max(0, num(heldOthersIn))
    : Math.max(0, num(held) - ownHeld);

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
    // A fresh_pr plan refuses the shelf, so the shelf is not what it is SHORT
    // of: its still-to-buy is the cut plan less its own PR on order and its own
    // holds. That is `short`, and it is untouched here.
    //
    // NET AFTER PLAN is a different question — what this pile reads once this
    // job has cut — and "the shelf it leaves alone" answered it only while the
    // board was still ON ORDER. The moment the PR LANDS the board arrives onto
    // THIS shelf as this job's own hold (a landed, covered PR becomes a hold),
    // and drawing it takes the pile down with it. ACEBROBID: 9,000 on the
    // shelf, 8,959 of it its own delivered board, cutting tomorrow — the tile
    // said Net After Plan 9,000 for a pile that will read 41, denying a
    // delivery that had already happened. It draws what it holds, capped at
    // the plan; with nothing landed yet that is zero and the shelf is left
    // alone exactly as before.
    const fromThisShelf = num(planParent) > 0 ? Math.min(ownHeld, num(planParent)) : ownHeld;
    return {
      available: avail, committed, free, free_for_others: freeForOthers,
      net: freeRaw - fromThisShelf,
      drawn: !!drawn, fresh: true, own_incoming: num(ownIncoming),
      short: drawn ? 0 : Math.max(0, num(planParent) - ownHeld - num(ownIncoming)),
    };
  }

  const net = freeRaw - num(need);
  return {
    available: avail, committed, free, free_for_others: freeForOthers, net,
    drawn: !!drawn, fresh: false,
    // `net` is measured off freeRaw and keeps its sign — an over-committed board
    // must say so. `short` is a different question with a different answer: it
    // is what THIS job puts on a purchase order, and no job is short of more
    // than it needs. Measuring it off freeRaw too charged this plan with every
    // other job's unmet need.
    //
    // GLYCOMET, 17 Aug 2026. Saffire · 290 GSM · 26x30, bare shelf. Line 487
    // wanted 2,475 and CI-PR-0066 was already buying them; line 490 was then
    // planned for 2,038 and the engine offered 4,513 — the two added together.
    // CI-VPO-0035 went to the mill carrying line 487's board twice, while
    // CI-PR-0066 sat in the register still waiting to be ordered. Three ganged
    // 5,000-sheet jobs on a bare shelf came out as 15,000 + 10,000 + 5,000:
    // 30,000 bought for 15,000 of work.
    //
    // The other job's shortfall is the other job's PR. Clamped at `free`, not
    // freeRaw, so contested stock still counts against this plan (someone
    // else's claim genuinely is not available to it) while their UNMET need
    // falls away.
    short: Math.max(0, num(need) - free),
  };
}
