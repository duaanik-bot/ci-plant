// ─── Approval rules — pure logic, no DB ─────────────────────────────────────
// Two approval flows share these rules:
//   · Extra sheets: ONLY users carrying users.xs_approver may approve/reject
//     (the plant head — Dharminder on the Plant login). Deliberately a flag,
//     not a role: several plant logins are role=admin, and the usual
//     "admin always passes" bypass would hand the decision back to everyone.
//   · Management approval (Planning): users carrying users.is_management
//     receive the ask and decide it. Advisory only — a pending or rejected
//     request never blocks planning or production.

export function canApproveExtraSheets(user) {
  return +(user?.xs_approver ?? 0) === 1;
}

export function canDecideManagement(user) {
  return +(user?.is_management ?? 0) === 1;
}

// Transition guard for approval_requests. action: approve | reject | cancel.
// Returns null when allowed, else the message for the 409.
export function mgtDecisionError(status, action) {
  const past = { approve: 'approved', reject: 'rejected', cancel: 'withdrawn' }[action];
  if (!past) return `Unknown action "${action}"`;
  if (status === 'pending') return null;
  return `Only a pending request can be ${past} (this one is ${status})`;
}

// Notification fan-out targets: every active user carrying the flag, minus the
// user who caused the event (nobody needs a bell for their own action).
// Who hears that a plate died on the press. Four constituencies, one list:
// management (the MD carries is_management), planning, the press floor, and CTP —
// which is not a role but a `production` login with printing access, so the same
// filter reaches it. Nobody gets a bell for their own action.
export function plateReplacementRecipients(users = [], excludeId = null) {
  return (users || [])
    .filter(u => +(u?.active ?? 1) !== 0)
    .filter(u => +(u?.is_management ?? 0) === 1
      || u?.role === 'admin'
      || u?.role === 'planner'
      || (u?.role === 'production'
        && (u.sections == null || (Array.isArray(u.sections) && u.sections.includes('printing')))))
    .map(u => u.id)
    .filter(id => Number(id) !== Number(excludeId));
}

export function notificationRecipients(users, flag, excludeId = null) {
  return (users || [])
    .filter(u => +(u?.[flag] ?? 0) === 1 && +(u?.active ?? 0) === 1 && u.id !== excludeId)
    .map(u => u.id);
}
