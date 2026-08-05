// Planning set-type triage — the pure rules behind PATCH /planning/:id/set-type.
// Kept out of the route so the refusals are testable without a DB, the same way
// approvals.js carries the management-approval transitions.
//
// The stored tag is INTENT; two facts outrank it wherever the tag is read:
//   hold        — any member on hold parks the whole row (the run moves as one)
//   gang_run_id — the line physically shares a sheet, so it can never be single
// Planning.jsx carries the same three-line precedence for its zones (rowSetType)
// — change one, change both.

export const SET_TYPES = ['single', 'gang', 'hold'];

// Why this retag is refused, or null when it may proceed.
//   line    — the clicked order line ({ gang_run_id })
//   members — every line the write will touch (the whole gang, or just the line)
export function setTypeError({ line, members, set_type, reason }) {
  if (!SET_TYPES.includes(set_type)) return 'Set type must be single, gang or hold';
  if (set_type === 'hold' && !String(reason || '').trim())
    return 'Write why this job is on hold — that reason is the tag';
  if (line.gang_run_id && set_type === 'single')
    return 'A ganged job cannot print alone — remove it from the gang first';
  if (members.some(m => m.status !== 'pending'))
    return 'Only jobs still to plan can be retagged — this one already has a locked plan';
  return null;
}
