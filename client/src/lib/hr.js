// HR & Payroll — the client's side of /api/hr: the API wrappers, the money and month
// formatters, the access levels and the tab list. Spec: docs/superpowers/specs/
// 2026-10-16-hr-payroll-design.md §5–§6; the routes are server/src/routes/hr*.js.
//
// This whole section is private. Every /api/hr route answers 403 to a login that is not
// on the HR access list (server/src/hr/access.js), and there is deliberately no module key
// for it in modules.js: a module tick cannot hide anything from an admin, so a key would
// only suggest a protection that is not there. The gate is the HR level `me()` reports.
//
// Money is NUMERIC(12,2) on the server and arrives as a JSON number with at most two
// decimals. This file only ever FORMATS it. It never adds, rounds or compares amounts —
// the engine on the server does that arithmetic, exactly — and it logs nothing: an
// amount must never reach a console.
import { api, auth } from '../api.js';

// ── Access levels ───────────────────────────────────────────────────────────
// Each level includes the ones before it (spec §6) and mirrors HR_LEVELS in
// server/src/hr/access.js. The UI only decides what to OFFER with these; the server
// refuses what a level may not do.
export const HR_LEVELS = Object.freeze(['viewer', 'operator', 'approver', 'admin']);
export const HR_LEVEL_LABELS = Object.freeze({
  viewer: 'Viewer', operator: 'Operator', approver: 'Approver', admin: 'Admin',
});

// Does `level` reach `min`? An unknown level, or an unknown `min`, is a no — a typo
// must close a door, never open it.
export function levelAtLeast(level, min) {
  const have = HR_LEVELS.indexOf(level);
  const need = HR_LEVELS.indexOf(min);
  return have !== -1 && need !== -1 && have >= need;
}

// ── Formatting ──────────────────────────────────────────────────────────────
// Built on first use, not at import: AppLayout imports this file for the nav probe, so
// it is in the entry chunk of every screen — a plant tablet should not pay for a formatter
// that only the HR page ever calls.
let INR2;

// ₹ with Indian grouping and two decimals: 1234567.5 → '₹12,34,567.50'.
// Nothing to show (null, undefined, blank or whitespace-only, not a number) is '—', never
// '₹0.00': a blank pay figure and a zero one mean different things (Number('  ') is 0, so a
// string of spaces has to be caught before it is converted). A negative reads '-₹1,234.50'.
export function inr2(v) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  INR2 ??= new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const body = INR2.format(Math.abs(n));
  return `${n < 0 && body !== '0.00' ? '-' : ''}₹${body}`;
}

const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']);

// 'YYYY-MM' → 'July 2026'. A full 'YYYY-MM-DD' (a pay setup's effective_from) reads the
// same way. No Date is involved, so no time zone can move the month. Blank is '—';
// anything that is not a month is handed back as it came rather than guessed at.
export function monthLabel(month) {
  if (month == null || month === '') return '—';
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(month));
  const i = m ? Number(m[2]) - 1 : -1;
  return i >= 0 && i < 12 ? `${MONTH_NAMES[i]} ${m[1]}` : String(month);
}

// ── Tabs ────────────────────────────────────────────────────────────────────
// The page's tabs in rail order. `group` is the caption over a cluster of pills
// (GroupedTabs); `min` is the lowest HR level that sees the tab — Settings is the
// admin's. A tab's body is pages/hr/<Name>.jsx and takes { level }.
export const HR_TABS = [
  { key: 'overview', label: 'Overview', group: 'Month', min: 'viewer' },
  { key: 'payroll', label: 'Payroll', group: 'Month', min: 'viewer' },
  { key: 'people', label: 'People', group: 'Records', min: 'viewer' },
  { key: 'loans', label: 'Loans & Advances', group: 'Records', min: 'viewer' },
  { key: 'reports', label: 'Reports', group: 'Output', min: 'viewer' },
  { key: 'settings', label: 'Settings', group: 'Admin', min: 'admin' },
];

// ── API ─────────────────────────────────────────────────────────────────────
// One entry per row of the API contract (paths are under /api). A path segment goes
// through encodeURIComponent: an id is a no-op, a pay-channel code or a month is not
// trusted to be URL-safe. Every POST / PUT sends a JSON object (at least {}).
const seg = v => encodeURIComponent(String(v));

// '?a=1&b=2' from the entries that carry a value, '' when none does. An array becomes
// a comma list (the convention of /threads/summary?ids= and the plate asset ids).
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    const text = Array.isArray(v) ? v.join(',') : v == null ? '' : String(v);
    if (text !== '') q.set(k, text);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// GET /hr/me — the one call that says whether this login may open HR at all.
//
// It does NOT go through api.get, and that is the point. A login with no HR access gets
// a 403 here, and for that login the 403 is the ANSWER, not a fault. api.js hands every
// refusal whose code is not in HANDLED_BY to the app's red error toast — and the nav asks
// this once on every page load, for every login, so every admin who is not on the HR list
// would be greeted with an error toast on every screen. This reads the status itself:
// it resolves { level, user:{id,name} }, or throws an Error whose .status is the HTTP
// status (403 = not on the list; a network failure has no status).
async function me() {
  const token = auth.token;
  const res = await fetch('/api/hr/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  });
  // A signed-out session is the shell's business: ask the normal way, so it signs out.
  if (res.status === 401) return api.get('/hr/me');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const hrApi = {
  // GET /hr/me — viewer. See above.
  me,

  // ── People, pay setups, aliases ──
  // GET /hr/people?status= — viewer. Bank numbers arrive as bank_last4 only.
  people: status => api.get(`/hr/people${qs({ status })}`),
  // GET /hr/people/:id — viewer. The full bank number comes only to operator and above.
  person: id => api.get(`/hr/people/${seg(id)}`),
  // POST /hr/people (no id) · PUT /hr/people/:id (person.id) — operator. The id rides in the path.
  savePerson: ({ id, ...fields }) => (id != null
    ? api.put(`/hr/people/${seg(id)}`, fields)
    : api.post('/hr/people', fields)),
  // POST /hr/people/:id/setups — operator. effective_from is 'YYYY-MM-01'; 409 SETUP_EXISTS if that month has one.
  addSetup: (personId, setup) => api.post(`/hr/people/${seg(personId)}/setups`, setup),
  // POST /hr/people/:id/aliases — operator. `alias` is the spelling to remember.
  addAlias: (personId, alias) => api.post(`/hr/people/${seg(personId)}/aliases`, { alias }),
  // DELETE /hr/aliases/:id — operator.
  removeAlias: aliasId => api.del(`/hr/aliases/${seg(aliasId)}`),

  // ── Settings, pay channels, access, audit ──
  // GET /hr/settings — viewer.
  settings: () => api.get('/hr/settings'),
  // PUT /hr/settings — admin. { key: value }.
  saveSettings: values => api.put('/hr/settings', values),
  // GET /hr/pay-channels — viewer.
  payChannels: () => api.get('/hr/pay-channels'),
  // POST /hr/pay-channels — admin. { code, label, kind, bank_name, account }.
  addPayChannel: channel => api.post('/hr/pay-channels', channel),
  // PUT /hr/pay-channels/:code — admin.
  savePayChannel: (code, channel) => api.put(`/hr/pay-channels/${seg(code)}`, channel),
  // GET /hr/access — admin. [{ user_id, name, email, role, level }].
  accessList: () => api.get('/hr/access'),
  // PUT /hr/access/:userId — admin. A level, or null / '' to take the access away; 409 LAST_ADMIN.
  setAccess: (userId, level) => api.put(`/hr/access/${seg(userId)}`, { level: level || null }),
  // GET /hr/audit?entity=&entity_id= — approver.
  audit: (entity, entityId) => api.get(`/hr/audit${qs({ entity, entity_id: entityId })}`),

  // ── Overview, ERP link ──
  // GET /hr/dashboard?month= — viewer. Without a month the server uses the current plant month.
  dashboard: month => api.get(`/hr/dashboard${qs({ month })}`),
  // GET /hr/erp-operators — operator. [{ id, name, section, active }] from public.employees.
  erpOperators: () => api.get('/hr/erp-operators'),

  // ── Monthly import ──
  // POST /hr/imports — operator. Multipart: the file, plus the month ('YYYY-MM'). 409 DUPLICATE_FILE carries batch_id.
  uploadImport: (file, month) => api.upload('/hr/imports', file, { month }),
  // GET /hr/column-maps — viewer. The column maps the import remembers by header signature:
  // [{ id, signature, map, blank_zero, last_used }].
  columnMaps: () => api.get('/hr/column-maps'),
  // DELETE /hr/column-maps/:id — admin. { ok: true }. The next sheet with those headers is mapped afresh.
  removeColumnMap: id => api.del(`/hr/column-maps/${seg(id)}`),
  // GET /hr/imports/:id — viewer. { batch, rows, missing, duplicates }.
  importBatch: id => api.get(`/hr/imports/${seg(id)}`),
  // PUT /hr/imports/:id/map — operator. { column_map, blank_as_zero }; answers the re-extracted batch.
  saveImportMap: (id, map) => api.put(`/hr/imports/${seg(id)}/map`, map),
  // PUT /hr/imports/:id/rows/:rowId — operator. { person_id?, decision?, save_alias?, advance_mode? }.
  saveImportRow: (id, rowId, decision) => api.put(`/hr/imports/${seg(id)}/rows/${seg(rowId)}`, decision),
  // POST /hr/imports/:id/apply — operator. { missing:[{ person_id, choice:'include'|'exclude' }], overwrite_manual:[person_id] }.
  applyImport: (id, choices = {}) => api.post(`/hr/imports/${seg(id)}/apply`, choices),
  // POST /hr/imports/:id/discard — operator, open months only. Sets a parsed upload aside; answers the batch.
  discardImport: (id, reason) => api.post(`/hr/imports/${seg(id)}/discard`, reason ? { reason } : {}),

  // ── Payroll runs ──
  // GET /hr/runs — viewer.
  runs: () => api.get('/hr/runs'),
  // GET /hr/runs/:month — viewer. { run, lines, inputs, flags_summary }.
  run: month => api.get(`/hr/runs/${seg(month)}`),
  // PUT /hr/runs/:month/inputs/:personId — operator. The input fields plus a `reason`.
  saveRunInput: (month, personId, input) => api.put(`/hr/runs/${seg(month)}/inputs/${seg(personId)}`, input),
  // POST /hr/runs/:month/recalc — operator.
  recalcRun: month => api.post(`/hr/runs/${seg(month)}/recalc`, {}),
  // POST /hr/runs/:month/submit — operator.
  submitRun: month => api.post(`/hr/runs/${seg(month)}/submit`, {}),
  // POST /hr/runs/:month/send-back — approver. The reason is required.
  sendBackRun: (month, reason) => api.post(`/hr/runs/${seg(month)}/send-back`, { reason }),
  // POST /hr/runs/:month/approve — approver.
  approveRun: month => api.post(`/hr/runs/${seg(month)}/approve`, {}),
  // POST /hr/runs/:month/finalise — approver.
  finaliseRun: month => api.post(`/hr/runs/${seg(month)}/finalise`, {}),
  // POST /hr/runs/:month/payments — operator. { pay_channel, reference, paid_on, person_ids? } marks a channel's lines paid.
  recordPayments: (month, batch) => api.post(`/hr/runs/${seg(month)}/payments`, batch),
  // PUT /hr/runs/:month/lines/:personId/payment — operator (approver for 'reversed'). { status, reference }.
  setLinePayment: (month, personId, payment) => api.put(`/hr/runs/${seg(month)}/lines/${seg(personId)}/payment`, payment),
  // POST /hr/runs/:month/lines/status — operator (approver to move a PAID line back to unpaid). Many lines at once:
  // { person_ids, status:'paid'|'pending'|'on_hold', reference?, paid_on?, reason? } ('pending' is Unpaid; on_hold
  // needs a reason; paid needs a finalised run, 409 RUN_NOT_FINAL). Answers { changed, unchanged, skipped:[{ person_id,
  // reason }], batches }.
  setLineStatuses: (month, change) => api.post(`/hr/runs/${seg(month)}/lines/status`, change),
  // GET /hr/runs/:month/payslips?person_ids=&channel= — viewer. person_ids is an array (sent as a comma list).
  payslips: (month, { person_ids, channel } = {}) => api.get(`/hr/runs/${seg(month)}/payslips${qs({ person_ids, channel })}`),
  // GET /hr/runs/:month/variance — viewer.
  variance: month => api.get(`/hr/runs/${seg(month)}/variance`),

  // ── Loans ──
  // GET /hr/loans — viewer.
  loans: () => api.get('/hr/loans'),
  // GET /hr/loans/:id — viewer. { loan, txns, schedule }.
  loan: id => api.get(`/hr/loans/${seg(id)}`),
  // POST /hr/loans — operator. { person_id, principal, issued_on, purpose, instalment, first_due_month, paid_via, is_opening }; mints CI-LN-####.
  createLoan: loan => api.post('/hr/loans', loan),
  // POST /hr/loans/:id/prepay — operator. { amount, date }.
  prepayLoan: (id, prepayment) => api.post(`/hr/loans/${seg(id)}/prepay`, prepayment),
  // POST /hr/loans/:id/holiday — operator. Skips the instalment of one month ('YYYY-MM').
  loanHoliday: (id, month) => api.post(`/hr/loans/${seg(id)}/holiday`, { month }),
  // POST /hr/loans/:id/cancel — operator. Only while nothing has been recovered.
  cancelLoan: id => api.post(`/hr/loans/${seg(id)}/cancel`, {}),
  // PUT /hr/loans/:id/instalment — operator. { instalment, from_month }.
  setLoanInstalment: (id, change) => api.put(`/hr/loans/${seg(id)}/instalment`, change),

  // ── Advances ──
  // GET /hr/advances — viewer. A balance per person.
  advances: () => api.get('/hr/advances'),
  // GET /hr/advances/:personId — viewer. One person's statement.
  advanceStatement: personId => api.get(`/hr/advances/${seg(personId)}`),
  // POST /hr/advances — operator. { person_id, amount, txn_date, note }.
  giveAdvance: advance => api.post('/hr/advances', advance),
  // POST /hr/advances/:personId/waive — approver. { amount, note }.
  waiveAdvance: (personId, waiver) => api.post(`/hr/advances/${seg(personId)}/waive`, waiver),

  // ── Pay staff ──
  // POST /hr/staff-payments — operator. { person_id, kind:'advance'|'loan', amount, paid_on, paid_via, instalments?,
  // first_due_month?, note }; a loan mints CI-LN-####. Answers { kind, advance, loan, warnings, ledger }.
  staffPayment: payment => api.post('/hr/staff-payments', payment),
  // GET /hr/people/:id/ledger — viewer. { person, totals, rows } — every advance and loan movement, newest first.
  personLedger: personId => api.get(`/hr/people/${seg(personId)}/ledger`),

  // ── Adjustments ──
  // GET /hr/adjustments?month= — viewer.
  adjustments: month => api.get(`/hr/adjustments${qs({ month })}`),
  // POST /hr/adjustments — operator. The spec §7 adjustment fields.
  createAdjustment: adjustment => api.post('/hr/adjustments', adjustment),
  // POST /hr/adjustments/:id/approve — approver.
  approveAdjustment: id => api.post(`/hr/adjustments/${seg(id)}/approve`, {}),
  // POST /hr/adjustments/:id/cancel — operator.
  cancelAdjustment: id => api.post(`/hr/adjustments/${seg(id)}/cancel`, {}),

  // ── Salary-workbook loader (admin) ──
  // POST /hr/loader/preview — multipart: the workbook. Writes nothing.
  loaderPreview: file => api.upload('/hr/loader/preview', file),
  // POST /hr/loader/apply — multipart: the same workbook plus `decisions` ({ skip:[code], edits:{ code:{…} } }).
  loaderApply: (file, decisions) => api.upload('/hr/loader/apply', file,
    decisions ? { decisions: JSON.stringify(decisions) } : {}),
};
