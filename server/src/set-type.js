// Planning set-type triage — the pure rules behind PATCH /planning/:id/set-type.
// Kept out of the route so the refusals are testable without a DB, the same way
// approvals.js carries the management-approval transitions.
//
// The stored tag is INTENT; two facts outrank it wherever the tag is read:
//   hold                — any member on hold parks the whole row (the run
//                         moves as one)
//   run_kind === 'gang' — the line shares its sheet with OTHER PRODUCTS, so it
//                         can never print on its own terms
// A COMBINED RUN ('merge') is not in that list: one product, one plate, several
// sales orders — physically a Single, and the one run that never splits.
// client/src/lib/setType.js carries the same precedence for the queue's zones
// (rowSetType) — change one, change both.

export const SET_TYPES = ['single', 'gang', 'new_output', 'hold'];
// A stored value nothing can ever display is a lie, not a preference — so each
// run KIND refuses exactly the tags its own fact would mask. Both kinds share
// the gang_run_id column (a merge reuses it so every "which card is this line
// riding?" lateral keeps working), so the column alone can decide nothing here.
//
// SOLO_ONLY  a GANG shares its sheet with other products and splits after die
//            cutting, so it can never print on its own terms.
// 'gang'     a COMBINED RUN is one product on one plate across several sales
//            orders. It is physically a Single and never splits, so the Gang
//            tag could never be shown even if it were written.
const SOLO_ONLY = ['single', 'new_output'];

// Why this retag is refused, or null when it may proceed.
//   line    — the clicked order line ({ gang_run_id, run_kind }); the route
//              must LEFT JOIN gang_runs for the kind, or every refusal here
//              silently stops firing
//   members — every line the write will touch (the whole gang, or just the line)
export function setTypeError({ line, members, set_type, reason }) {
  if (!SET_TYPES.includes(set_type)) return `Set type must be one of: ${SET_TYPES.join(', ')}`;
  if (set_type === 'hold' && !String(reason || '').trim())
    return 'Write why this job is on hold — that reason is the tag';
  if (line.run_kind === 'gang' && SOLO_ONLY.includes(set_type))
    return 'A ganged job cannot print on its own — remove it from the gang first';
  if (line.run_kind === 'merge' && set_type === 'gang')
    return 'A combined run is one product on one plate — split the combined run before ganging it';
  if (members.some(m => m.status !== 'pending'))
    return 'Only jobs still to plan can be retagged — this one already has a locked plan';
  return null;
}
