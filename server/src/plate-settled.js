// Settled Plate PRs — history the Plates list stops shipping by default.
//
// 417 PRs made /plates/requirements 3.9 MB and 1.3 s of server time (20 Nov 2026),
// and a third of them were long finished. A PR is settled when ALL hold:
//   • its plates are back on the rack (status returned_to_rack);
//   • it was converted to a PO — a PR never converted is still on the Open list
//     (the screen's to-do view), and that list must never lose a row;
//   • its job card is closed or split — the job it was made for is over;
//   • nothing has touched it for 14 days;
//   • no plate of it is waiting on anyone (verification, a PR to raise, a
//     replacement) or unaccounted for (still in the return queue, not found) —
//     returned_to_rack is stamped when plates come OFF the press, so each plate's
//     own status is what says it is really back. A PR that still asks for action
//     is never hidden.
// A `ready` PR on a closed card stays visible on purpose: its plates may never
// have come back to the rack, which stores want to see.
//
// Opt-in, like ?idle=hide on job cards: no parameter is the legacy answer, so an
// older bundle on a plant tablet keeps working. Aliases: tr = tooling_requests,
// jc = job_cards.
export const SETTLED_PR_SQL = `tr.status = 'returned_to_rack'
  AND (tr.approval_status = 'converted' OR tr.po_number IS NOT NULL)
  AND jc.status IN ('closed','split')
  AND tr.updated_at < now() - interval '14 days'
  AND NOT EXISTS (SELECT 1 FROM plate_request_components sprc
    WHERE sprc.tooling_request_id = tr.id
      AND sprc.status IN ('verification_required','pr_required','replacement_required',
        'returned_pending_verification','not_found'))`;

// ?settled= → 'hide' | 'only' | 'all'. Anything else (absent, mis-cased, repeated)
// is the legacy answer.
export function settledMode(value) {
  return value === 'hide' || value === 'only' ? value : 'all';
}

export function settledClause(mode) {
  if (mode === 'hide') return `AND NOT (${SETTLED_PR_SQL})`;
  if (mode === 'only') return `AND (${SETTLED_PR_SQL})`;
  return '';
}
