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
