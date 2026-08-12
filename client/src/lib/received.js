// What a station has RECEIVED — one reader, used by every station surface.
//
// The server derives this live in stageReceipt() / rowReceipt(): whatever the
// previous station has counted SO FAR (converted into this stage's unit) plus
// any CI-XS extra sheets issued straight to this stage. It is the same figure
// the server caps a save against, which is the whole point of reading it here
// rather than assembling a second opinion on the client.
//
// Never reach for `qty_in` directly on an open stage. qty_in is a snapshot
// taken when the stage started: printing began while cutting was at 100,
// cutting counted on to 27,000, and the snapshot stayed at 100 — so the press
// was shown "Received: 100 sheets" under a run log holding 25,000. Issuing
// extra sheets used to overwrite it outright, which is how that 100 got there.
//
// The `qty_in` / `upstream_available` / `expected_qty` tail is a fallback for
// rows from surfaces that don't carry a receipt yet, so an older payload still
// renders a sane number instead of a zero.
export function receivedQty(row) {
  return row?.received ?? row?.qty_in ?? row?.upstream_available ?? row?.expected_qty ?? 0;
}

// The good output that receipt should yield. Cutting is the one stage that
// multiplies — it turns parent sheets into `children_per_parent` print sheets —
// so measuring its output against its raw input reads as a wild overrun
// ("27,000 of 25,075") when the run is exactly on plan. Every other stage
// carries its input forward 1:1.
//
// `cpp` is passed separately because it lives on the job card, not the stage
// row, and different screens hold one or the other.
//
// `mixCuts` is the payload's per-board mix — [{material_id, board_name,
// issued, cuts}] — carried by every station row since the board-mix wave. A
// mixed job cuts each board at ITS OWN chosen count, so its expected cutting
// output is Σ issued × cuts across the piles; one legacy cpp over the whole
// receipt is simply the wrong number there. Empty/absent mixCuts (or any
// non-cutting stage) falls through to the legacy arm byte-identically, so
// every existing 3-arg caller computes exactly what it always did. (CI-XS
// extras issued straight to a cutting stage are not mix rows — the server
// folds them into the planned board's pile at completion; the completion gate
// itself is actuals-vs-actuals, so the hint being XS-blind never blocks.)
export function expectedOutputQty(row, stage = row?.stage, cpp = row?.children_per_parent, mixCuts = null) {
  if (stage === 'cutting' && Array.isArray(mixCuts) && mixCuts.length) {
    return mixCuts.reduce(
      (s, m) => s + Math.max(0, Math.round(+m.issued || 0)) * Math.max(1, +m.cuts || 1), 0);
  }
  return receivedQty(row) * (stage === 'cutting' ? Math.max(1, cpp || 1) : 1);
}

// The print sheets a job's issued board should yield — the "expected" figure
// the press boards measure printing progress against. Single board:
// sheets_issued × children_per_parent, exactly as those boards always
// computed it. Mixed job: Σ issued × chosen cuts across the piles — the same
// per-board rule as expectedOutputQty above, off the same `mix_cuts` payload.
export function plannedChildSheets(row, mixCuts = row?.mix_cuts) {
  if (Array.isArray(mixCuts) && mixCuts.length) {
    return mixCuts.reduce(
      (s, m) => s + Math.max(0, Math.round(+m.issued || 0)) * Math.max(1, +m.cuts || 1), 0);
  }
  return (+row?.sheets_issued || 0) * Math.max(1, +row?.children_per_parent || 1);
}

// The same question asked of a row that may not have STARTED — what the
// station queue's Expected column shows. Once a stage has been fed this IS
// expectedOutputQty; before that it falls back to the plan, and only where the
// row carries a plan in this stage's own output unit.
//
// That restriction is the point. Cutting knows its plan up front — the very
// arithmetic plannedChildSheets already spells, and the same figure the Cut
// Plan cell prints two columns to the left — so a queued cutting row shows 800
// rather than a 0 that reads as "this run produces nothing". Downstream, the
// plan is held in CARTONS (`qty_planned`) while the stage counts SHEETS, so
// there is no honest figure until cutting has counted: those rows return null
// and the column shows an em dash. A number in the wrong unit is worse than no
// number at all.
//
// Both arms are the existing readers, so a mixed job is mix-aware here for
// free and this can never become a third opinion about expected output.
export function plannedOutputQty(row, stage = row?.stage, cpp = row?.children_per_parent, mixCuts = row?.mix_cuts) {
  const fromReceipt = expectedOutputQty(row, stage, cpp, mixCuts);
  if (fromReceipt > 0) return fromReceipt;
  if (stage !== 'cutting') return null;
  const planned = plannedChildSheets(row, mixCuts);
  return planned > 0 ? planned : null;
}

// What the counter box reads when a completion form opens. Three situations,
// and the middle one is the whole reason this is a function and not a ternary:
//
//   nothing counted yet   → the full expected output. The straightforward
//                           close stays one click, as it always has.
//   part-counted          → BLANK. The counter reads whatever it reads, and
//                           pre-filling a guess there is how a wrong figure
//                           gets confirmed by reflex.
//   counted to the issue  → the counted total. There is nothing left to run,
//                           so there is nothing left to ask.
//
// That third case used to fall into the second: every partially-counted row
// was blanked on open, whether or not anything was still to come. A cutting
// stage holding 2,766 of 2,766 print sheets opened with an empty box and a
// dead Complete Stage button, and the operator had to key the same figure the
// log was already showing him one line above.
//
// `hasRuns` is asked for separately rather than inferred from priorGood: a run
// that recorded only wastage leaves the log at zero good, and that stage has
// genuinely counted nothing yet — it must stay blank, not jump to the plan.
export function openingCounter({ expected = 0, priorGood = 0, hasRuns = false } = {}) {
  const exp = Math.max(0, Math.round(+expected || 0));
  const counted = Math.max(0, Math.round(+priorGood || 0));
  if (exp <= 0) return '';
  if (!hasRuns) return String(exp);
  return counted >= exp ? String(counted) : '';
}
