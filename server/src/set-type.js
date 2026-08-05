// Planning set-type triage — the pure rules behind PATCH /planning/:id/set-type.
// Kept out of the route so the refusals are testable without a DB, the same way
// approvals.js carries the management-approval transitions.
//
// The stored tag is INTENT; two facts outrank it wherever the tag is read:
//   hold        — any member on hold parks the whole row (the run moves as one)
//   gang_run_id — the line physically shares a sheet, so it can never be single
// Planning.jsx carries the same three-line precedence for its zones (rowSetType)
// — change one, change both.

export const SET_TYPES = ['single', 'gang', 'new_output', 'hold'];
// The tags a line already sharing a sheet may NOT wear. Both describe a job
// printing on its own terms, so the gang fact would mask them the moment they
// were written — a stored value nothing can ever display is a lie, not a
// preference. Remove the line from the gang first.
const SOLO_ONLY = ['single', 'new_output'];

// Why this retag is refused, or null when it may proceed.
//   line    — the clicked order line ({ gang_run_id })
//   members — every line the write will touch (the whole gang, or just the line)
export function setTypeError({ line, members, set_type, reason }) {
  if (!SET_TYPES.includes(set_type)) return `Set type must be one of: ${SET_TYPES.join(', ')}`;
  if (set_type === 'hold' && !String(reason || '').trim())
    return 'Write why this job is on hold — that reason is the tag';
  if (line.gang_run_id && SOLO_ONLY.includes(set_type))
    return 'A ganged job cannot print on its own — remove it from the gang first';
  if (members.some(m => m.status !== 'pending'))
    return 'Only jobs still to plan can be retagged — this one already has a locked plan';
  return null;
}
