// Where a job card's board mix comes from — one reader for every screen that
// starts or completes cutting.
//
// Two kinds of card reach a guillotine and they answer differently:
//
//   line card   its mix belongs to its own order line, and is read from that
//               line's planning context.
//   run parent  a gang or combined run. `order_line_id` is NULL — the run
//               serves several sales orders, so no single line is "the" line —
//               and the mix belongs to the RUN: the planner enters it once in
//               the run's engine and it is stored SPLIT ACROSS THE MEMBERS
//               (gang-mix.js), read back and re-added as run-level rows.
//
// A SPLIT gang child has both a `gang_run_id` and an order line of its own. It
// reads as a LINE: its board was already consumed by the parent at cutting, and
// whatever mix it has is its line's. So the run id only ever wins when the card
// has no line — which is the whole rule, and the reason it is written here once.
//
// THE RUN ID HAS TWO SPELLINGS, and that is not a tidiness problem — it is the
// bug this module was extracted to end. STAGE_VIEW (`/floor`, `/floor/:section`)
// selects `jc.gang_run_id`; JC_VIEW (`/job-cards`) selects that AND a
// `line_gang_run_id` alias. The station workspace read `line_gang_run_id` off a
// STAGE_VIEW row, which has no such column — so it was `undefined` on every run
// parent, the page took the no-mix branch, and the operator started cutting a
// run without ever being shown the mix the planner had entered. The Live Floor,
// reading the identical payload with the other name, showed it correctly.
// Reading BOTH here means no screen has to know which endpoint fed it.

// The run whose mix this card shares, or null when the card has a line of its
// own (or has neither, which is a card anchored to nothing).
export const runIdOf = row =>
  (row && row.order_line_id == null ? (row.gang_run_id ?? row.line_gang_run_id ?? null) : null);

// The one answer: which source, which id, and the endpoint that serves it.
// `null` means the card can carry no mix at all, and the caller should resolve
// straight to "loaded, nothing to show" rather than fetching.
export function boardMixSource(row) {
  if (!row) return null;
  const runId = runIdOf(row);
  if (runId != null) return { kind: 'run', id: runId, path: `/gang-runs/${runId}` };
  if (row.order_line_id != null)
    return { kind: 'line', id: row.order_line_id, path: `/planning/${row.order_line_id}/context` };
  return null;
}

// Could this card carry a board mix? The guard for the as-planned breakup,
// which fetches the card itself (`/job-cards/:id`) rather than the mix source.
// A run parent DOES qualify: the server reads its rows back through the run's
// members (attachBoardMix). Answering "no" for it — as the station page did,
// on a comment that predated run mixes — shows the single-board fallback to an
// operator whose job card lists several boards.
export const canCarryBoardMix = row => boardMixSource(row) !== null;

// The mix rows as the confirm UI wants them, from either source.
// `covers ?? sheets`: a RUN-level row prices itself, because a differing cut is
// refused at plan-save and the server re-derives covers on confirm. An absent
// or empty mix normalises to empty arrays — never null, so a caller can render
// without a second existence check.
export function normaliseMixRows(detail) {
  const mix = detail?.mix;
  return {
    rows: (mix?.rows || []).map(x => ({
      material_id: x.material_id, stock_batch_id: x.stock_batch_id,
      sheets: x.sheets, ups: x.ups, covers: x.covers ?? x.sheets,
      role: x.role, reason: x.reason, board_name: x.board_name,
    })),
    lots: mix?.lots || [],
    plannedUps: mix?.planned_ups || 0,
  };
}
