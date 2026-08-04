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
export function expectedOutputQty(row, stage = row?.stage, cpp = row?.children_per_parent) {
  return receivedQty(row) * (stage === 'cutting' ? Math.max(1, cpp || 1) : 1);
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
