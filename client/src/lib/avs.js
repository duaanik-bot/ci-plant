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
  { key: 'RELEASE', label: 'Approve / Release', done: 'Released',
    hint: 'Cartons may go on to the next stage or to dispatch.' },
  { key: 'KEEP ON HOLD', label: 'Keep on hold', done: 'Kept on hold',
    hint: 'Cartons stay on hold until the open points are cleared.' },
  { key: 'REJECT', label: 'Reject cartons', done: 'Rejected by QA',
    hint: 'Cartons go to the rejection area, counted and recorded.' },
  { key: 'ARTWORK ALERT OK', label: 'Artwork alert checked', done: 'Artwork alert checked',
    hint: 'Artwork / prepress confirmed the alert with the customer.' },
];
export const AVS_DECISION_KEYS = AVS_DECISIONS.map(d => d.key);
export const decisionLabel = key => (key === 'UNDO' ? 'Decision undone' : AVS_DECISIONS.find(d => d.key === key)?.done ?? key);

// Undo. A decision is never edited or deleted: undoing it adds an 'UNDO' row
// naming it (undoes_id), with who, when and why. The decision in force is the
// newest one that is neither an artwork-alert sign-off, nor an UNDO row, nor
// undone — so an undo brings back the decision before it, if any.
// No questions asked (owner, 28 Sep 2026): an undo needs no remark; who and
// when are kept on the UNDO row all the same.
export function undoProblem({ remark }) {
  if (String(remark ?? '').trim().length > AVS_REMARK_MAX) return `Keep the remark under ${AVS_REMARK_MAX} characters.`;
  return null;
}
// decisions: newest first. Marks each undone one, and gives the one in force.
export function decisionsInForce(decisions = []) {
  const undone = new Set(decisions.filter(d => d.decision === 'UNDO' && d.undoes_id != null).map(d => String(d.undoes_id)));
  const list = decisions.map(d => ({ ...d, undone: undone.has(String(d.id)) }));
  const last = list.find(d => d.decision !== 'ARTWORK ALERT OK' && d.decision !== 'UNDO' && !d.undone) || null;
  return { list, last };
}
// The SQL twin: decisions rows (alias) that count — used by the register, the
// report and the printing lock, so all three agree on the decision in force.
export const DECISION_IN_FORCE_SQL = (a = 'dd') => `${a}.decision NOT IN ('ARTWORK ALERT OK', 'UNDO')
  AND NOT EXISTS (SELECT 1 FROM avs.decisions avs_u WHERE avs_u.undoes_id = ${a}.id)`;

// Who records the final decision: the QA role, and every login given the AVS
// decision right (users.avs_approver, ticked in Masters → Users: on 28 Sep 2026
// the owner gave it to Administrator, Accounts, Planning and Plant, and the MD).
// A flag, not role=admin: CTP and other plant logins are admins too, and
// prepress must not release its own artwork. The server reads the flag from the
// database, never from the token.
export const AVS_DECISION_ROLES = ['qc'];
export function canDecideAvs(user) {
  if (!user) return false;
  return AVS_DECISION_ROLES.includes(user.role) || +user.avs_approver === 1;
}
export const AVS_WHO_DECIDES = 'Only QA and the logins given the AVS decision right (Masters › Users) can record the decision.';

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
  // Not a hard block (owner, 28 Sep 2026): QA may release even a REJECT report,
  // with a remark saying why — the remark is the record of that call.
  if (decision === 'ARTWORK ALERT OK' && !hasAlert) return 'This report has no artwork alert to confirm.';
  if (!text && !(decision === 'RELEASE' && status === 'PASS')) {
    return decision === 'RELEASE'
      ? status === 'REJECT' ? 'Pick or write why a REJECT report is released.' : 'Pick or write which HOLD points QA has cleared.'
      : 'Pick or write a remark.';
  }
  return null;
}

// Ready-made remarks, one tap each (owner, 28 Sep 2026). The person can still
// add words after picking one.
export const AVS_REMARK_PRESETS = {
  RELEASE: [
    'Checked by QA: OK to go ahead',
    'Corrected sheets checked: OK',
    'Customer approved the deviation',
    'Minor point, accepted by QA',
    'Board / GSM confirmed OK',
    'PO confirmed with the customer',
  ],
  'KEEP ON HOLD': [
    'Waiting for customer confirmation',
    'Waiting for corrected sheets',
    'PO to be confirmed',
    'Board / GSM to be confirmed',
    'Better photos needed',
  ],
  REJECT: [
    'Artwork does not match the approved master',
    'Old or wrong artwork printed',
    'Print defect (ink, register, voids)',
    'Wrong board / GSM',
    'Text, batch or barcode error',
  ],
  'ARTWORK ALERT OK': [
    'Artwork team confirmed with the customer',
    'Checked against the customer\'s earlier approved carton',
  ],
};

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

// ── How serious each point is (owner's request, 1 Oct 2026; runbook rule 24) ─
// Every HOLD / REJECT point of a report is CRITICAL, MAJOR or MINOR:
//   CRITICAL  could put a wrong or unsafe pack on the market: wrong or old
//             artwork, wrong product, strength or composition, missing or wrong
//             mandatory text, wrong barcode, another product mixed in. REJECT.
//   MAJOR     the print or the material does not meet the PO or the approved
//             artwork, or a key fact could not be verified: board / GSM /
//             varnish differs, a print defect touching text, MRP or batch area,
//             extra print, quantity over the PO, PO expired or unread, approval
//             or master not on file. HOLD.
//   MINOR     records and housekeeping, nothing wrong on the carton itself: job
//             card or printing log, rates, item master entries, duplicates,
//             photo coverage or glare, prepress numbers. HOLD.
// Claude writes avs.problems.severity; a point written before the column
// existed (or without it) counts as REJECT → CRITICAL, D- → MAJOR, R- → MINOR.
export const AVS_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'];
export const AVS_SEVERITY_LABEL = { CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' };
export function problemSeverity(p) {
  const s = String(p?.severity || '').toUpperCase();
  if (AVS_SEVERITIES.includes(s)) return s;
  if (p?.result === 'REJECT') return 'CRITICAL';
  if (p?.result === 'HOLD') return /^D-/.test(String(p?.ref || '')) ? 'MAJOR' : 'MINOR';
  return null;
}
export const SEVERITY_SQL = a => `COALESCE(${a}.severity, CASE WHEN ${a}.result = 'REJECT' THEN 'CRITICAL'
  WHEN ${a}.ref LIKE 'D-%' THEN 'MAJOR' ELSE 'MINOR' END)`;

// Time taken for a report (owner's request, 1 Oct 2026): the photo set behind
// this issue, from Verify to the report. Null for a report made in Cowork.
export function reportTime(r) {
  const q = Date.parse(r?.set_queued_at), f = Date.parse(r?.set_finished_at), c = Date.parse(r?.set_claimed_at);
  if (!Number.isFinite(q) || !Number.isFinite(f)) return null;
  return { totalMs: Math.max(0, f - q), waitMs: Number.isFinite(c) ? Math.max(0, c - q) : null,
    checkMs: Number.isFinite(c) ? Math.max(0, f - c) : null };
}

// The stamp on the report PDF once QA has decided this issue (owner's request,
// 1 Oct 2026): RELEASED, REJECTED or ON HOLD, with who, when and the remark.
// Nothing for an issue no decision is in force on.
export function pdfStamp(state, d) {
  const when = d?.decided_at ? istStamp(d.decided_at) : '';
  const by = d?.decided_by || '';
  const words = state === 'released' ? 'RELEASED BY QA'
    : state === 'rejected' ? 'REJECTED BY QA'
      : d?.decision === 'KEEP ON HOLD' ? 'KEPT ON HOLD BY QA' : null;
  if (!words) return null;
  return { words, tone: state === 'released' ? 'green' : state === 'rejected' ? 'red' : 'amber',
    line: [by, when ? `${when} IST` : ''].filter(Boolean).join(' · '), remark: String(d?.remark || '').trim() };
}

// ── The register: filters and search ────────────────────────────────────────
export const AVS_REGISTER_FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'open', label: 'Open', match: r => r.case_state === 'open' || r.case_state === 'waiting' },
  { key: 'released', label: 'Released', match: r => r.case_state === 'released' },
  { key: 'rejected', label: 'Rejected', match: r => r.case_state === 'rejected' },
];
// Search by any text on the row: letters and digits only, so "0006", "avs 6",
// "jc0446" or "levexx" all find what they should.
const squash = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export function rowMatches(values, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).map(squash).filter(Boolean);
  if (!words.length) return true;
  const hay = values.map(squash).join('|');
  return words.every(w => hay.includes(w));
}

// ── Job card numbers in a report ────────────────────────────────────────────
// A report may name several job cards ("CI-JC-0446, CI-JC-0447"): the same
// product in several orders or batches, checked from one photo set.
export const jobCardNumbers = text => String(text ?? '').split(/[,;+&\s]+/).map(x => x.trim().toUpperCase())
  .filter(x => /^CI-/.test(x));
// The SQL twin: does the report's job_card name this card number ($n)?
export const JOB_CARD_MATCH_SQL = (col, param) => `upper(btrim(${param})) = ANY (
  regexp_split_to_array(upper(coalesce(${col}, '')), '[,;+&[:space:]]+'))`;

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

// The QA stamp at the press: approved when every report on the card is
// released; otherwise how it stands. null when the card has no report.
export function qaStamp(reports = []) {
  if (!reports.length) return null;
  const lines = reports.map(avsGateLine);
  const waiting = lines.filter(l => l.state !== 'released');
  if (!waiting.length) return { state: 'approved', text: 'QA Approved', lines };
  if (waiting.some(l => l.state === 'rejected' || l.status === 'REJECT')) return { state: 'rejected', text: 'QA Rejected', lines };
  if (waiting.some(l => l.decision === 'KEEP ON HOLD' || l.status === 'HOLD')) return { state: 'hold', text: 'QA Hold', lines };
  return { state: 'pending', text: 'QA Pending', lines };
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

// The list of photo sets shows one group at a time, picked with chips: the
// sets still in progress, and the finished ones by how they ended.
export const AVS_SET_GROUPS = [
  { key: 'active', label: 'In progress', statuses: ['uploading', 'queued', 'checking'] },
  { key: 'done', label: 'Report ready', statuses: ['done'] },
  { key: 'failed', label: 'Check failed', statuses: ['failed'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];
export const setGroupOf = status => AVS_SET_GROUPS.find(g => g.statuses.includes(status))?.key ?? 'active';

// The steps of a check, in order, as Claude writes them into
// avs.check_requests.progress at the start of each (runbook 2C.1 step 4): the
// step's words, then any detail after a colon ("Finding the approved master:
// PCS-G305-R0"). "Filing the photos" happens only when CI Plant kept some.
export const AVS_CHECK_STEPS = [
  { words: 'Claude started', pct: 15 },
  { words: 'Filing the photos', pct: 20 },
  { words: 'Reading the photos', pct: 25 },
  { words: 'Finding the approved master', pct: 35 },
  { words: 'Reading the PO', pct: 50 },
  { words: 'Checking the order book', pct: 60 },
  { words: 'Comparing the panels', pct: 70 },
  { words: 'Writing the report', pct: 85 },
  { words: 'Filing the report', pct: 95 },
];

// "45 s", "4 min 05 s", "1 h 5 min", "2 d 3 h".
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// The clock on a set: how long it has waited for Claude, how long Claude has
// been checking it (both run live), or how long the check took.
export function setClock(set, now = Date.now()) {
  const at = v => (v ? Date.parse(v) : NaN);
  const queued = at(set?.queued_at);
  const claimed = at(set?.claimed_at);
  const finished = at(set?.finished_at);
  if (set?.status === 'queued' && Number.isFinite(queued)) return { label: 'waiting', text: elapsedText(now - queued), live: true };
  if (set?.status === 'checking' && Number.isFinite(claimed)) return { label: 'checking', text: elapsedText(now - claimed), live: true };
  if (['done', 'failed'].includes(set?.status) && Number.isFinite(claimed) && Number.isFinite(finished)) {
    return { label: 'checked in', text: elapsedText(finished - claimed), live: false };
  }
  return null;
}

// Where a check's time went: each step Claude wrote (progress_log, stamped by
// the database) until the next one, or until the check finished. The words
// are the step's own, without the detail after the colon.
export function stepTimes(set) {
  const log = Array.isArray(set?.progress_log) ? set.progress_log : [];
  const end = Date.parse(set?.finished_at) || null;
  return log.map((x, i) => {
    const from = Date.parse(x.at);
    const to = i + 1 < log.length ? Date.parse(log[i + 1].at) : end;
    const step = String(x.p || '').split(':')[0].trim();
    return { step, ms: Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null };
  }).filter(x => x.ms != null && x.step && !/^report ready$|^not checked$/i.test(x.step));
}

// Total time to process a verification (owner's request, 1 Oct 2026): from the
// moment Verify sent the set (queued_at) to the report (finished_at), split into
// the wait for Claude to start (queued → claimed) and the check itself
// (claimed → finished). While a set is in progress the total runs live.
export function totalTime(set, now = Date.now()) {
  const at = v => (v ? Date.parse(v) : NaN);
  const queued = at(set?.queued_at);
  const claimed = at(set?.claimed_at);
  const finished = at(set?.finished_at);
  if (!Number.isFinite(queued)) return null;
  const ended = ['done', 'failed'].includes(set?.status);
  if (!ended && !AVS_SET_ACTIVE.includes(set?.status)) return null;
  if (ended && !Number.isFinite(finished)) return null;
  const end = ended ? finished : now;
  const waitEnd = Number.isFinite(claimed) ? claimed : end;
  return {
    live: !ended,
    totalMs: Math.max(0, end - queued),
    waitMs: Math.max(0, waitEnd - queued),
    checkMs: Number.isFinite(claimed) ? Math.max(0, end - claimed) : null,
  };
}

// Every step of a set as a checklist (owner's request, 1 Oct 2026): photos
// uploaded → waiting for Claude → each step of the check (AVS_CHECK_STEPS) →
// report ready. Each step is 'done' (green tick), 'current' (running now),
// 'failed', or 'pending', with how long it took (from progress_log, stamped by
// the database) or has been running. "Filing the photos" is listed only when
// the check did it (CI Plant kept some photos).
export function stepChecklist(set, now = Date.now()) {
  const at = v => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  const status = set?.status;
  const log = (Array.isArray(set?.progress_log) ? set.progress_log : [])
    .map(x => ({ low: String(x?.p || '').toLowerCase(), t: at(x?.at) }));
  const idxOf = low => AVS_CHECK_STEPS.findIndex(s => low.startsWith(s.words.toLowerCase()));
  const finished = at(set?.finished_at);
  const endOfCheck = finished ?? (AVS_SET_ACTIVE.includes(status) ? now : null);
  // When each check step started (first stamp), and when the next stamp came.
  const started = AVS_CHECK_STEPS.map(() => null);
  log.forEach(x => { const i = idxOf(x.low); if (i >= 0 && started[i] == null) started[i] = x.t; });
  const nextStamp = t => {
    const later = log.map(x => x.t).filter(v => v != null && t != null && v > t);
    return later.length ? Math.min(...later) : endOfCheck;
  };
  const curText = String(set?.progress || '').toLowerCase();
  const reachedIdx = status === 'checking'
    ? idxOf(curText)
    : Math.max(-1, ...log.map(x => idxOf(x.low)));
  const claimed = at(set?.claimed_at);
  const queued = at(set?.queued_at);
  const created = at(set?.created_at);
  const span = (a, b) => (a != null && b != null ? Math.max(0, b - a) : null);

  const rows = [];
  // 1 Photos uploaded
  rows.push({
    key: 'photos', label: 'Photos uploaded',
    state: status === 'uploading' ? 'current' : 'done',
    ms: status === 'uploading' ? span(created, now) : span(created, queued),
  });
  // 2 Waiting for Claude to start
  const queueState = status === 'uploading' ? 'pending'
    : status === 'queued' ? 'current'
      : claimed != null || status === 'checking' || status === 'done' ? 'done'
        : status === 'failed' ? 'failed' : 'pending';
  rows.push({
    key: 'queue', label: 'Waiting for Claude to start', state: queueState,
    ms: queueState === 'current' ? span(queued, now) : span(queued, claimed),
  });
  // 3 The check's own steps
  const checkStarted = claimed != null || status === 'checking';
  AVS_CHECK_STEPS.forEach((s, i) => {
    const optional = s.words === 'Filing the photos';
    const seen = started[i] != null || (status === 'checking' && i === reachedIdx);
    if (optional && !seen) return;
    let state = 'pending';
    if (checkStarted) {
      if (status === 'done') state = 'done';
      else if (status === 'checking') state = reachedIdx < 0 ? (i === 0 ? 'current' : 'pending') : i < reachedIdx ? 'done' : i === reachedIdx ? 'current' : 'pending';
      else if (status === 'failed') state = i < reachedIdx ? 'done' : i === reachedIdx ? 'failed' : 'pending';
    }
    const from = started[i];
    rows.push({
      key: `step${i}`, label: s.words, state,
      ms: from != null && state !== 'pending' ? span(from, state === 'current' ? now : nextStamp(from)) : null,
    });
  });
  // 4 The end
  rows.push({
    key: 'ready', label: status === 'failed' ? 'Check failed' : status === 'cancelled' ? 'Cancelled' : 'Report ready',
    state: status === 'done' ? 'done' : status === 'failed' || status === 'cancelled' ? 'failed' : 'pending', ms: null,
  });
  return rows;
}

// Where a set stands, as one bar: adding photos 5% → waiting for Claude 10% →
// the check's steps 15–95% → report ready 100%.
export function setProgress(set) {
  const text = String(set?.progress || '').trim();
  switch (set?.status) {
    case 'uploading': return { pct: 5, label: 'Adding photos', tone: 'slate' };
    case 'queued': return set.fire_status === 'not_linked'
      ? { pct: 10, label: 'Waiting: start the check from Cowork (/avs)', tone: 'amber' }
      : { pct: 10, label: 'Waiting for Claude', tone: 'sky' };
    case 'checking': {
      const low = text.toLowerCase();
      const at = AVS_CHECK_STEPS.findIndex(s => low.startsWith(s.words.toLowerCase()));
      if (at < 0) return { pct: 15, label: text || 'Claude is checking', detail: '', tone: 'violet', live: true };
      const step = AVS_CHECK_STEPS[at];
      return {
        pct: step.pct, label: step.words, detail: text.slice(step.words.length).replace(/^[\s:–—-]+/, ''),
        tone: 'violet', live: true, step: at + 1, steps: AVS_CHECK_STEPS.length,
      };
    }
    case 'done': return { pct: 100, label: 'Report ready', tone: 'emerald' };
    case 'failed': return { pct: 100, label: 'Check failed', tone: 'red' };
    default: return { pct: 0, label: AVS_SET_STATUS_LABEL[set?.status] || String(set?.status || ''), tone: 'slate' };
  }
}

// ── Finished sets: a time window and a short list ───────────────────────────
// Report ready, Check failed and Cancelled grow every day, so the page shows
// one time window at a time (by when the set ended) and only the first few
// rows until asked for the rest.
export const AVS_PERIODS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
];
export const AVS_PERIOD_DEFAULT = '7d';
export const AVS_SETS_SHOWN = 5;
const IST_MS = 330 * 60 * 1000;
// When a finished set ended: checked, cancelled, or (failing both) last touched.
export const setEndedAt = s => s?.finished_at || s?.cancelled_at || s?.updated_at || s?.created_at || null;
export function inPeriod(when, key, now = Date.now()) {
  if (key === 'all') return true;
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return false;
  if (key === 'today') {
    const startIst = Math.floor((now + IST_MS) / 86400000) * 86400000 - IST_MS; // midnight in India
    return t >= startIst;
  }
  const days = key === '30d' ? 30 : 7;
  return t >= now - days * 86400000;
}
// "28 Sep 2026, 4:05 pm" in India time.
export function istStamp(when) {
  const t = Date.parse(when);
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(t));
}

// ── Redo verification ────────────────────────────────────────────────────────
// A report that is ready can be verified again with new photos. The redo is a
// new photo set checked as the next check of the SAME report number (Check 2,
// Check 3 ...): the register shows the latest check, and every earlier check —
// its photos, its PDF, QA's decisions on it — stays on record. Why it is redone
// is asked every time, and kept with the set.
export const AVS_REDO_REASON_MIN = 5;
export function redoProblem({ reason }) {
  const t = String(reason ?? '').trim();
  if (t.length < AVS_REDO_REASON_MIN) return 'Write why the check is being redone (at least a few words).';
  if (t.length > AVS_REMARK_MAX) return `Keep the reason under ${AVS_REMARK_MAX} characters.`;
  return null;
}

// The Report ready list shows one row per report: the newest set that checked
// it. The sets of its earlier checks fold into that row as `earlier` (newest
// first), so the face shows only the latest check and the trail stays one tap
// away. Sets without a report number are left as they are.
export function foldEarlierChecks(sets = []) {
  const newest = new Map();
  for (const s of sets) {
    if (!s.report_no) continue;
    const cur = newest.get(s.report_no);
    if (!cur || +s.id > +cur.id) newest.set(s.report_no, s);
  }
  return sets
    .filter(s => !s.report_no || newest.get(s.report_no) === s)
    .map(s => (s.report_no
      ? { ...s, earlier: sets.filter(x => x.report_no === s.report_no && x !== s).sort((a, b) => b.id - a.id) }
      : s));
}

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
