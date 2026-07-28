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
export function notificationRecipients(users, flag, excludeId = null) {
  return (users || [])
    .filter(u => +(u?.[flag] ?? 0) === 1 && +(u?.active ?? 0) === 1 && u.id !== excludeId)
    .map(u => u.id);
}
