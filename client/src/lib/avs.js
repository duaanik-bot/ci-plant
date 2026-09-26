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

// ── The printing lock ────────────────────────────────────────────────────────
// Planning decides per job whether AVS is mandatory (off by default). When it
// is, the PRINTING stage of the job's card cannot be completed until QA has
// released the job in Artwork Verification: at least one AVS report carries the
// job card number, and the latest issue of EVERY such report is released. A
// gang prints several cartons on one sheet, so its card (CI-GANG-JC-…) may carry
// one report per carton — all of them must be released.
//
// `reports` rows: { report_no, report_rev, check_no, status, closed,
//   decision, decided_by, remark, decision_rev, decision_check } — the decision
//   being the last one that is not an artwork-alert sign-off.
export const AVS_NO_REPORT = 'No AVS report yet for this job card. Take photos of a printed sheet, '
  + 'upload them in Artwork Verification and press Verify.';

export function avsGateLine(r) {
  const label = reportLabel(r);
  const last = r.decision ? { decision: r.decision, report_rev: r.decision_rev, check_no: r.decision_check } : null;
  const state = caseState(r, last);
  const sameIssue = last && +last.report_rev === +(r.report_rev ?? 0) && +(last.check_no ?? 1) === +(r.check_no ?? 1);
  const by = r.decided_by ? ` by ${r.decided_by}` : '';
  const why = r.remark ? `: ${r.remark}` : '';
  let text;
  if (state === 'released') text = `${label} was released by QA${by}.`;
  else if (state === 'rejected') text = `QA rejected ${label}${why}. Correct the print and send new photos for the next check.`;
  else if (state === 'closed') text = `${label} was closed without a re-check. Send new photos, or ask Planning to switch AVS off with a reason.`;
  else if (sameIssue && r.decision === 'KEEP ON HOLD') text = `QA kept ${label} on hold${why}.`;
  else if (r.status === 'PASS') text = `${label} is PASS and waiting for QA to release it.`;
  else if (r.status === 'REJECT') text = `${label} is REJECT. Correct the print and send new photos for the next check.`;
  else text = `${label} is HOLD. QA must clear its points and release it.`;
  return { report_no: r.report_no, label, status: r.status, state, decision: r.decision ?? null, text };
}

export function avsGate(reports = []) {
  const lines = reports.map(avsGateLine);
  const released = lines.length > 0 && lines.every(l => l.state === 'released');
  const reason = released ? null
    : lines.length === 0 ? AVS_NO_REPORT
      : lines.filter(l => l.state !== 'released').map(l => l.text).join(' ');
  return { released, reports: lines, reason };
}

// Switching the lock. Only Planning (planner, admin) may switch it. Jobs already
// on the press are never disturbed (owner, 26 Sep 2026): once printing has
// started AVS can no longer be switched ON for that job — it goes through as it
// was planned. Switching it OFF after printing has started is the planned way
// out when the check cannot be done in time — it needs a reason, which is saved
// with the planner's name.
export const AVS_SWITCH_REASON_MIN = 5;
export const PRINTING_STARTED = ['in_progress', 'partially_completed', 'hold'];

// `printing` = the job card's printing stage status, or null when no card (or no
// printing stage) exists yet. Returns null, or { status, message, code? }.
export function avsSwitchProblem({ on, reason, printing = null }) {
  if (typeof on !== 'boolean') return { status: 400, message: 'Say whether AVS is mandatory for this job or not.' };
  const text = String(reason ?? '').trim();
  if (text.length > AVS_REMARK_MAX) return { status: 400, message: `Keep the reason under ${AVS_REMARK_MAX} characters.` };
  if (printing === 'completed') {
    return { status: 409, message: 'Printing is already completed for this job, so the AVS switch no longer applies.' };
  }
  if (on && PRINTING_STARTED.includes(printing)) {
    return { status: 409, message: 'Printing has already started on this job, so it goes through without AVS. Switch AVS on when a job is planned, before it reaches the press.' };
  }
  if (!on && PRINTING_STARTED.includes(printing) && text.length < AVS_SWITCH_REASON_MIN) {
    return { status: 409, code: 'AVS_REASON_REQUIRED',
      message: 'Printing has started on this job. Write why AVS is being switched off; it is saved with your name.' };
  }
  return null;
}

// ── Photo sets uploaded from CI Plant for Claude to check ───────────────────
// uploading → (Verify) queued → (Claude picks it up) checking → done | failed.
// A set can be cancelled while it is still uploading or queued.
export const AVS_SET_STATUS_LABEL = {
  uploading: 'Adding photos', queued: 'Waiting for Claude', checking: 'Claude is checking',
  done: 'Report ready', failed: 'Check failed', cancelled: 'Cancelled',
};
export const AVS_SET_ACTIVE = ['queued', 'checking'];
export const setLabel = id => `Set ${String(id).padStart(4, '0')}`;

// One photo per request: Vercel's function body limit is 4.5 MB, so the page
// shrinks anything larger before sending it (see AvsUpload.jsx).
export const AVS_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
export const AVS_SET_MAX_PHOTOS = 30;
export const AVS_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export function photoProblem({ size, type }) {
  if (!AVS_PHOTO_TYPES.includes(String(type || '').toLowerCase())) return 'Only photos (JPG, PNG, HEIC or WebP) can be checked.';
  if (!(size > 0)) return 'The photo is empty.';
  if (size > AVS_PHOTO_MAX_BYTES) return 'The photo is over 4 MB. Shrink it and try again.';
  return null;
}

// The Drive folder a set's photos go to, under the AVS folder:
// AVS CHECK/<DD-MM-YYYY>/Set 0012 CI-JC-0399. `day` is the IST date DD-MM-YYYY.
export function avsSetFolder({ id, day, jc_number }) {
  const jc = String(jc_number || '').replace(/[\\/]/g, '-').trim();
  return `AVS CHECK/${day}/${setLabel(id)}${jc ? ` ${jc}` : ''}`;
}

// ── The two links an admin sets up once (Artwork Verification → Setup) ─────
// The Drive link is a Google Apps Script web app deployed from the AVS folder's
// own Google account (client/src/lib/avsRobot.js holds its source). The Claude
// link is the API trigger of the AVS routine at claude.ai/code/routines.
export const DRIVE_BRIDGE_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const ROUTINE_FIRE_URL_RE = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/[A-Za-z0-9_]{6,}\/fire$/;

export function setupProblem({ drive_bridge_url, routine_fire_url, routine_token }) {
  if (drive_bridge_url != null && drive_bridge_url !== '' && !DRIVE_BRIDGE_URL_RE.test(drive_bridge_url)) {
    return 'The Drive link must be the Web app URL of the deployment, ending in /exec.';
  }
  if (routine_fire_url != null && routine_fire_url !== '' && !ROUTINE_FIRE_URL_RE.test(routine_fire_url)) {
    return 'The Claude link must be the routine\'s API URL: https://api.anthropic.com/v1/claude_code/routines/…/fire';
  }
  if (routine_token != null && routine_token !== '' && !/^sk-ant-[A-Za-z0-9_-]{8,}$/.test(routine_token)) {
    return 'The Claude token is the one shown once when you press Generate token (it starts with sk-ant-).';
  }
  return null;
}
