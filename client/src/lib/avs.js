// AVS — Artwork Approval & Verification System, the rules both halves share.
//
// A printed carton is photographed, checked by Claude (in Cowork) against the
// approved artwork, the customer's PO and our own order book, and the report is
// written to the Supabase schema `avs` (never to the plant tables in public).
// This module is the ERP's side of it: the reports are read here, and QA's
// final decision — Release, Keep on hold, Reject — is recorded here, in
// avs.decisions, where the next check reads it back.
//
// ONE spelling of the rules. The server refuses exactly what the page greys out,
// so a button can never offer what the save will refuse.

// Only three results exist anywhere in AVS. AVS verifies; it never approves.
export const AVS_STATUSES = ['PASS', 'HOLD', 'REJECT'];

export const AVS_DECISIONS = [
  { key: 'RELEASE', label: 'Release', done: 'Released',
    hint: 'Cartons may go on to the next stage or to dispatch.' },
  { key: 'KEEP ON HOLD', label: 'Keep on hold', done: 'Kept on hold',
    hint: 'Cartons stay on hold until the open points are cleared.' },
  { key: 'REJECT', label: 'Reject cartons', done: 'Rejected by QA',
    hint: 'Cartons go to the rejection area, counted and recorded.' },
  { key: 'ARTWORK ALERT OK', label: 'Artwork alert checked', done: 'Artwork alert checked',
    hint: 'Artwork / prepress confirmed the alert with the customer.' },
];
export const AVS_DECISION_KEYS = AVS_DECISIONS.map(d => d.key);
export const decisionLabel = key => AVS_DECISIONS.find(d => d.key === key)?.done ?? key;

// Who records the final decision: QA, and admin (requireRole lets admin through).
// A management login (is_management) may also decide — checked on the server
// from the database, never from the token.
export const AVS_DECISION_ROLES = ['qc'];
export function canDecideAvs(user) {
  if (!user) return false;
  return user.role === 'admin' || AVS_DECISION_ROLES.includes(user.role) || +user.is_management === 1;
}

export const AVS_REMARK_MAX = 600;

// Why a decision cannot be saved, or null when it can.
//   • REJECT reports are never released: the cartons need a new check
//     (Check n+1) of corrected print that comes back PASS.
//   • Releasing a HOLD report means QA cleared the HOLD points by hand — say which.
//   • Keeping on hold and rejecting always say why and what happens to the cartons.
//   • The artwork-alert sign-off exists only when the report carries an A- alert.
export function decisionProblem({ decision, remark, status, hasAlert = false }) {
  if (!AVS_DECISION_KEYS.includes(decision)) return 'Choose Release, Keep on hold or Reject.';
  if (!AVS_STATUSES.includes(status)) return 'This report has no PASS / HOLD / REJECT result.';
  const text = String(remark ?? '').trim();
  if (text.length > AVS_REMARK_MAX) return `Keep the remark under ${AVS_REMARK_MAX} characters.`;
  if (decision === 'RELEASE' && status === 'REJECT') {
    return 'A REJECT report cannot be released. Correct the cartons and send new photos for the next check.';
  }
  if (decision === 'ARTWORK ALERT OK' && !hasAlert) return 'This report has no artwork alert to confirm.';
  if (!text && !(decision === 'RELEASE' && status === 'PASS')) {
    return decision === 'RELEASE'
      ? 'Write which HOLD points QA has cleared, and how.'
      : 'Write a remark: what was checked and what happens to the cartons.';
  }
  return null;
}

// Where a case stands, from its latest report, its latest decision and whether
// the owner closed it (a CLOSE row in avs.reports).
//   open      REJECT or HOLD, nobody has decided on this issue yet (or kept it on hold)
//   waiting   PASS, waiting for QA to release
//   released  QA released this issue
//   rejected  QA rejected the cartons
//   closed    closed by the owner without a re-check
export function caseState({ status, report_rev = 0, check_no = 1, closed = false }, lastDecision) {
  if (closed) return 'closed';
  const d = lastDecision && lastDecision.decision !== 'ARTWORK ALERT OK' ? lastDecision : null;
  const sameIssue = d && +d.report_rev === +report_rev && +(d.check_no ?? 1) === +check_no;
  if (sameIssue && d.decision === 'RELEASE') return 'released';
  if (sameIssue && d.decision === 'REJECT') return 'rejected';
  return status === 'PASS' ? 'waiting' : 'open';
}

export const CASE_STATE_LABEL = {
  open: 'Open', waiting: 'Waiting for QA', released: 'Released', rejected: 'Rejected by QA', closed: 'Closed',
};

// Report number as the plant says it: AVS-2026-0005 Check 2 Rev 1.
export function reportLabel({ report_no, check_no = 1, report_rev = 0 }) {
  return `${report_no}${+check_no > 1 ? ` Check ${check_no}` : ''}${+report_rev > 0 ? ` Rev ${report_rev}` : ''}`;
}

export const AVS_REPORT_NO = /^AVS-\d{4}-\d{4}$/;
