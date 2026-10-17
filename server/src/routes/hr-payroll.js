// ─── HR & Payroll: the monthly import, the payroll run, payments, payslips and variance ───────────────────
// Spec docs/superpowers/specs/2026-10-16-hr-payroll-design.md §9 (the monthly Excel import), §12 (the run's
// lifecycle) and §13 (outputs). People, settings and access are routes/hr.js; loans, advances, adjustments and
// the workbook loader are routes/hr-ledgers.js. All three sit under the same /api/hr wall.
//
// PRIVATE. Every route here sits behind r.use('/hr', hrGuard) (a row in hr.access, read fresh from the database
// and remembered on the request, so the three HR routers read it once) and states its minimum level with
// requireHr(): viewer reads imports, column maps, runs, payslips and variance; operator uploads, maps, decides
// rows, applies, edits inputs, recalculates, submits and records payments; approver sends back, approves,
// finalises and reverses a payment; admin deletes a remembered column map. Every response is no-store and every
// GET is marked uncacheable, so no browser or response cache keeps a copy of anyone's pay.
//
// The monthly import (spec §9)
//   * POST /hr/imports takes the sheet (multipart `file`, 4 MB, xlsx magic bytes) and a `month`. The same file
//     (sha256) for the same month is refused (409 DUPLICATE_FILE with the batch to reopen) unless that batch was
//     discarded, and so is a month whose run is no longer a draft (409 RUN_LOCKED). The workbook is read on the
//     server (hr/import-parse.js), the header row and sheet are found, the column map remembered for that header
//     signature is used (else the automatic one), rows are extracted exactly, and each row is matched strictly
//     (hr/match.js: code, exact name, approved alias; nothing on a guess). Nothing else is written: no run is
//     created and no input changes until the batch is applied.
//   * import_rows.issues keeps what the parser found (errors and warnings) plus, for a row that is not matched
//     with certainty, the matcher's note (info MATCH_NOTE). The issues a response shows ALSO carry what depends on
//     the live records, worked out at read time so they never go stale: PERSON_EXITED (the row's person is marked
//     as left), NO_SETUP (no pay setup for the month), ADVANCE_AFTER_MONTH_END (info: advances given in the app
//     after the month ended belong to the next payroll month — a run reads balances as at its month end, so this
//     month neither recovers them nor counts them; replaces Ruling T7-g's warning) and ADVANCE_BELOW_RECORDED
//     (the sheet's advance, read as the month's total, is below what the app already recorded, spec §9 item 7).
//     Every row also carries in_app_advance (manual 'given' advances dated in the month) and in_app_after (dated
//     after it). `missing` (people with a setup for the month who are active or whose exited_on falls inside the
//     month, so a last part-month pay is not forgotten, and no row that is not ignored) and
//     `duplicates` (people more than one live row resolves to) are worked out at read time too.
//   * PUT /hr/imports/:id/map re-extracts a parsed batch from the rows it stored (each keeps its whole raw row) under
//     a new map, refusing a column used for two fields, re-matches every row (decisions start again) and
//     remembers the map in hr.column_maps by the header signature.
//   * PUT /hr/imports/:id/rows/:rowId: picking a person makes the match 'manual' (person_id null takes the pick
//     back and matches the row again); save_alias stores the row's spelling for that person (lockNames first,
//     409 ALIAS_IS_A_NAME for a spelling that is somebody's name); decision 'ignore' drops a row.
//   * POST /hr/imports/:id/apply, in one transaction: the month's run (made a draft if there is none; anything
//     else is 409 RUN_LOCKED); 409 IMPORT_UNRESOLVED while a live row is unmatched, conflicting, ambiguous, has an
//     unknown code or an error, while two live rows name one person, or while a missing person has no include /
//     leave-out choice. Then every live row is written to run_inputs (source 'import', source_row_id, advance_mode),
//     each missing person as chosen (include: a row with nothing typed; leave out: include = false). A row typed by
//     hand (source 'manual') is kept, and listed in manual_edits_kept, unless its person is in overwrite_manual.
//     Import inputs the batch no longer gives (a person the corrected sheet dropped, a row now ignored) are removed,
//     so the month's imported inputs are exactly this batch. The month's earlier applied batch is superseded and
//     the run recalculated. Applying an applied batch again is how manual edits get overwritten after a first
//     apply listed them.
//   * POST /hr/imports/:id/discard sets a parsed upload of an open month aside (status 'discarded', audited): it is
//     no longer the month's pending upload, its undecided rows stop counting, and the same file can come again.
//   * GET /hr/runs/:month carries pending_import: the month's latest parsed upload {batch_id, file_name,
//     uploaded_at, uploaded_by, uploaded_by_name, unresolved, parsed_uploads}, or null.
//
// The run (spec §12; hr/runs.js does the work)
//   * A run is created only by a write that needs one (apply, or an input typed by hand): a GET for a month with no
//     run answers run: null, because an empty draft would hold back every later month (PREVIOUS_MONTH_OPEN).
//   * An input typed by hand needs a reason, becomes source 'manual' and is audited with what changed.
//   * Submit recalculates the whole run first, then refuses (409 RUN_BLOCKED) while a line carries a block flag or an
//     person due this month (active, or exited inside it) with a setup has no input row at all (a row with
//     include = false is the explicit leave-out).
//     Submit and approve refuse a month before the latest finalised one (409 MONTH_BEFORE_FINALISED). Approving a
//     run you submitted warns, or is 409 SAME_PERSON when settings.strict_separation is on. Send-back (from submitted
//     or approved) needs a reason and returns the run to draft. Finalise is finaliseRun() inside tx().
//   * Submit notifies every HR approver and admin; send-back notifies whoever prepared and submitted the run. The
//     words carry the month and who, never an amount, and never the free-text reason (it could hold one): push
//     shows the title on a locked phone.
//   * Payments are for a finalised run only: a batch per channel marks that channel's unpaid lines as paid
//     (paid_amount = payable, so 0.00 for a line with nothing to pay, which lets a channel be closed in full) with
//     the reference and date; a single line can be paid, failed or reversed (reversal needs approver). Finalised is
//     never treated as paid.
//   * A line can be put ON HOLD at any run status (with a reason) and released again; a held line is not payable:
//     the channel batch skips it and lists it in `held`, the per-line route refuses it. POST /hr/runs/:month/lines/
//     status sets paid / unpaid (pending) / on hold for many lines at once; GET /hr/runs/:month carries
//     payment_totals (paid / unpaid / on_hold, each {count, amount}, and the same per channel; hr/payment-status.js).
//
// What a response carries
//   * Lines and inputs (GET /hr/runs/:month) are the numbers pg gives for NUMERIC, as in routes/hr.js; runs.totals
//     are exact 2-dp strings (Ruling T7-e). Payslips and variance are worked-out documents: exact 2-dp strings.
//     Import fields are the exact decimal strings read from the sheet. Dates are 'YYYY-MM-DD' text, months 'YYYY-MM'.
//   * Payslips take the letterhead name and GSTIN from billingEntity(), the same source the tax invoice prints from.
//
// Writes, errors
//   * Each write runs in tx() and leaves its row in hr.audit_log through hrAudit(), in the same transaction; inside
//     tx() only qc / oc are used. A refusal is an Error with .status and .body = {code, ...}: app.js sends
//     {error, ...body} and nothing else. A plain 400 / 404 carries no code.
import { Router } from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { q, one, tx } from '../db.js';
import { markUncacheable } from '../data-tables.js';
import { notify, optionalText } from '../helpers.js';
import { plantDateStr } from '../plant-calendar.js';
import { billingEntity } from '../billing-entity.js';
import { hrGuard, levelAtLeast, requireHr } from '../hr/access.js';
import { hrAudit } from '../hr/audit.js';
import { daysInMonthOf } from '../hr/engine.js';
import { FIELDS, autoMap, extractRows, pickSheet, readWorkbook } from '../hr/import-parse.js';
import { inAppAdvancesInMonth } from '../hr/ledger.js';
import { loanOutstanding, nextMonth } from '../hr/loans.js';
import { buildIndex, findDuplicates, matchRow, normName } from '../hr/match.js';
import { cmp, div, fmtPaise, isZero, mul, rat, sub, toPaise } from '../hr/money.js';
import { assertAliasFree, lockNames } from './../hr/names.js';
import { STATUS_WORD, paymentTotals } from '../hr/payment-status.js';
import { ensureRun, finaliseRun, recalcRun } from '../hr/runs.js';

const r = Router();

r.use('/hr', hrGuard);
r.use('/hr', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method === 'GET') markUncacheable();
  next();
});

// ── Small pieces ────────────────────────────────────────────────────────────

const INT4_MAX = 2147483647;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const monthLabel = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 2000;               // a monthly sheet holds about 50 people; anything near this is not one
const MAX_IDS = 5000;                // person ids in one request
const UNRESOLVED = new Set(['conflict', 'unknown_code', 'ambiguous', 'unmatched']);
const FIELD_KEYS = new Set(FIELDS.map((f) => f.key));
const NUMBER_FIELDS = new Set(FIELDS.filter((f) => f.kind === 'number').map((f) => f.key));
// The fields a column can be mapped to, for the column picker.
const FIELD_LIST = FIELDS.map((f) => ({ key: f.key, kind: f.kind, blank_zero: f.blankZero === true, info: f.info === true }));

// The run_inputs columns (spec §7). Quantities keep 4 decimals, money 2.
const INPUT_QTY = ['ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked'];
const INPUT_MONEY = ['misc_earning', 'misc_deduction', 'bonus', 'bill_amount', 'holiday_override', 'paid_separately',
  'advance_given', 'advance_recovery_override', 'loan_recovery_override'];
const INPUT_NUMBERS = [...INPUT_QTY, ...INPUT_MONEY];
const INPUT_TEXT = { remarks: 1000, paid_separately_note: 300 };
const INPUT_LABELS = {
  ot_hours: 'OT hours', absent_days: 'Absent days', paid_leave_days: 'Paid leave days', hours_worked: 'Hours worked',
  misc_earning: 'Misc earning', misc_deduction: 'Misc deduction', bonus: 'Bonus', bill_amount: 'Bill amount',
  holiday_override: 'Holiday pay', paid_separately: 'Paid separately', advance_given: 'Advance given',
  advance_recovery_override: 'Advance to recover', loan_recovery_override: 'Loan instalments to recover',
  remarks: 'Remarks', paid_separately_note: 'Paid separately note',
};

// A refusal. The code (when there is one) and its data ride in body: app.js sends {error, ...body}.
const fail = (status, message, code, more = {}) =>
  Object.assign(new Error(message), { status, body: code ? { code, ...more } : { ...more } });
const bad = (message) => fail(400, message);
const notFound = (what) => fail(404, `${what} not found`);

function bodyOf(req) {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object');
  return body;
}
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// A row id from a path: digits within int4. Anything else cannot be a row.
function idOf(raw, what) {
  const id = typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id > INT4_MAX) throw notFound(what);
  return id;
}

// A person id from a body or a query: a whole number or a digit string, within int4.
function personIdOf(raw, label) {
  const id = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) throw bad(`${label} must be a list of person ids`);
  return id;
}

// A list of person ids: a JSON array, or a comma list (a query string). Null when not given.
function idListOf(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  const items = Array.isArray(raw) ? raw
    : typeof raw === 'string' ? raw.split(',').map((s) => s.trim()).filter((s) => s !== '') : null;
  if (!items) throw bad(`${label} must be a list of person ids`);
  if (items.length > MAX_IDS) throw bad(`${label} lists too many people`);
  return [...new Set(items.map((x) => personIdOf(x, label)))].sort((a, b) => a - b);
}

function monthOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!MONTH.test(text)) {
    throw fail(400, `A payroll month looks like 2026-08, got ${JSON.stringify(String(raw ?? '').slice(0, 20))}`, 'BAD_MONTH');
  }
  return text;
}

// Optional text: null when absent or blank (optionalText also refuses the strings 'undefined' and 'null').
function textOf(raw, label, max) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(`${label} must be text`);
  const text = optionalText(raw);
  if (text !== null && text.length > max) throw bad(`${label} is too long (at most ${max} characters)`);
  return text;
}

function dateOf(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const last = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!m || year < 2000 || day < 1 || day > last) throw bad(`${label} must be a date like 2026-08-05`);
  return text;
}

// A plain non-negative decimal as exact text, or null when not given. Never a float: what was typed is what is
// stored. More decimals than the column keeps are refused, not rounded. Both column kinds fit 10 whole digits.
const PLAIN_NUMBER = /^(\d+)(?:\.(\d+))?$/;
function amountOf(raw, label, places) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  let text;
  if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
  else if (typeof raw === 'string') text = raw.trim();
  else throw bad(`${label} must be a number`);
  if (text.startsWith('-')) throw bad(`${label} must not be negative`);
  const m = PLAIN_NUMBER.exec(text);
  if (!m) throw bad(`${label} must be a plain number`);
  if ((m[2] ?? '').length > places) throw bad(`${label} can have at most ${places} decimal places`);
  if (m[1].replace(/^0+(?=\d)/, '').length > 10) throw bad(`${label} is too large`);
  return text;
}

function choiceOf(raw, allowed, label) {
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  throw bad(`${label} must be one of ${allowed.join(', ')}`);
}

function userIdOf(req) {
  const raw = req?.user?.id;
  const id = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(id) && id > 0 && id <= INT4_MAX ? id : null;
}
const userNameOf = (req) => (typeof req?.user?.name === 'string' && req.user.name.trim() ? req.user.name.trim() : 'Someone');

const given = (v) => v !== null && v !== undefined;
const paiseOf = (v) => (given(v) ? toPaise(rat(v)) : 0n);
const money = (v) => fmtPaise(paiseOf(v));               // exact, to paise: '1500.00'
const INDIAN = new Intl.NumberFormat('en-IN');
// '1234567.50' → '₹12,34,567.50' (the whole part through Intl as a BigInt, so it stays exact).
function inr(text) {
  const minus = text.startsWith('-');
  const [whole, fraction = '00'] = (minus ? text.slice(1) : text).split('.');
  return `${minus ? '-' : ''}₹${INDIAN.format(BigInt(whole))}.${fraction}`;
}
const issue = (level, code, field, message) => ({ level, code, field, message });
const hasError = (issues) => (Array.isArray(issues) ? issues : []).some((i) => i?.level === 'error');
const isBlocked = (flags) => (Array.isArray(flags) ? flags : []).some((f) => f?.level === 'block');
const listText = (items) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const firstFew = (items, n = 15) => (items.length > n ? [...items.slice(0, n), `${items.length - n} more`] : items);

// JSON for a jsonb parameter, without the NUL character Postgres refuses in jsonb (a real NUL is always written
// by JSON.stringify as the escape \u0000; an escaped backslash before it is kept).
const jsonForPg = (value) => JSON.stringify(value).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1');

async function userNames(qx, ids) {
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  if (!wanted.length) return new Map();
  const rows = await qx(`SELECT id, name FROM public.users WHERE id = ANY($1::int[])`, [wanted]);
  return new Map(rows.map((u) => [u.id, u.name]));
}

// ── Runs: shared pieces ─────────────────────────────────────────────────────

const RUN_BY = ['prepared_by', 'submitted_by', 'approved_by', 'finalised_by', 'sent_back_by'];

function runWithNames(run, names) {
  if (!run) return null;
  const out = { ...run };
  for (const k of RUN_BY) out[`${k}_name`] = given(run[k]) ? names.get(run[k]) ?? null : null;
  return out;
}

async function runView(qx, run) {
  if (!run) return null;
  return runWithNames(run, await userNames(qx, RUN_BY.map((k) => run[k])));
}

function runLocked(month, status) {
  return fail(409, status === 'finalised'
    ? `Payroll for ${monthLabel(month)} is finalised and can no longer change: put corrections into the next month as adjustments`
    : `Payroll for ${monthLabel(month)} is ${status}: imports and input changes are refused until an approver sends it back`,
  'RUN_LOCKED');
}

const runState = (run, wanted, action) =>
  fail(409, `Only ${wanted} run can be ${action}; ${monthLabel(run.month)} is ${run.status}`, 'RUN_STATE');

async function lockRunOf(qc, month) {
  const [run] = await qc(`SELECT * FROM hr.runs WHERE month = $1 FOR UPDATE`, [month]);
  if (!run) {
    throw fail(404, `There is no payroll run for ${monthLabel(month)} yet: import the month's sheet or enter inputs first`,
      'RUN_NOT_FOUND');
  }
  return run;
}

// Months go forward only (Ruling T7-c): once a later month is finalised, this one is closed for good.
async function refuseClosedMonth(qx, month, what) {
  const [later] = await qx(
    `SELECT month FROM hr.runs WHERE status = 'finalised' AND month > $1 ORDER BY month DESC LIMIT 1`, [month]);
  if (later) {
    throw fail(409, `Payroll for ${monthLabel(month)} can no longer be ${what}: ${monthLabel(later.month)} is already `
      + 'finalised. Put corrections into the next open month as adjustments', 'MONTH_BEFORE_FINALISED', { month: later.month });
  }
}

// People who owe the month a decision: active, or whose last day (exited_on) falls inside the month, so a final
// part-month pay is never forgotten because the person was already marked as left.
const exitedIn = (exitedOn, month) => typeof exitedOn === 'string' && exitedOn.slice(0, 7) === month;
const dueThisMonth = (p, month) => p.status === 'active' || exitedIn(p.exited_on, month);

// People due this month (above) with a pay setup in force for the month and no run_inputs row at all (a row with
// include = false is the explicit leave-out). With no run, that is everyone due with a setup.
async function peopleWithoutInputs(qx, runId, month) {
  return qx(
    `SELECT p.id AS person_id, p.code, p.name, p.display_name, p.department, p.pay_channel, p.status,
            p.exited_on::text AS exited_on
       FROM hr.people p
      WHERE (p.status = 'active'
             OR (p.exited_on >= $2::date AND p.exited_on < ($2::date + interval '1 month')::date))
        AND EXISTS (SELECT 1 FROM hr.pay_setups s WHERE s.person_id = p.id AND s.effective_from <= $2::date)
        AND NOT EXISTS (SELECT 1 FROM hr.run_inputs i WHERE i.run_id = $1 AND i.person_id = p.id)
      ORDER BY p.id`,
    [runId, `${month}-01`]);
}

// ── The import: shared pieces ───────────────────────────────────────────────

const BATCH_COLS = `id, month, file_name, sheet, header_row, headers, signature, column_map, blank_zero, status, counts,
  uploaded_by, uploaded_at, applied_by, applied_at`;
const ROW_COLS = `id, batch_id, row_no, raw, fields, match, person_id, candidates, issues, advance_mode, decision,
  decided_by, decided_at`;

// Everyone, with what the import needs to know about them for the month.
const PEOPLE_FOR_IMPORT = `
  SELECT p.id, p.code, p.name, p.display_name, p.status, p.department, p.pay_channel, p.exited_on::text AS exited_on,
         EXISTS (SELECT 1 FROM hr.pay_setups s WHERE s.person_id = p.id AND s.effective_from <= $1::date) AS has_setup
    FROM hr.people p
   ORDER BY p.id`;

const INSERT_ROWS = `
  INSERT INTO hr.import_rows (batch_id, row_no, raw, fields, match, person_id, candidates, issues)
  SELECT $1::integer, x.row_no, x.raw, x.fields, x.match, x.person_id, x.candidates, x.issues
    FROM jsonb_to_recordset($2::jsonb)
      AS x(row_no integer, raw jsonb, fields jsonb, match text, person_id integer, candidates jsonb, issues jsonb)
   ORDER BY x.row_no`;

const UPSERT_COLUMN_MAP = `
  INSERT INTO hr.column_maps (signature, field_map, blank_zero, created_by, updated_by)
  VALUES ($1, $2::jsonb, $3::jsonb, $4, $4)
  ON CONFLICT (signature) DO UPDATE SET field_map = EXCLUDED.field_map, blank_zero = EXCLUDED.blank_zero,
                                        updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING id`;

async function lockBatch(qc, id) {
  const [batch] = await qc(`SELECT ${BATCH_COLS} FROM hr.import_batches WHERE id = $1 FOR UPDATE`, [id]);
  if (!batch) throw notFound('Import');
  return batch;
}

async function matchIndex(qx) {
  const people = await qx(`SELECT id, code, name, display_name FROM hr.people ORDER BY id`);
  const aliases = await qx(`SELECT person_id, alias_norm FROM hr.person_aliases ORDER BY id`);
  return buildIndex(people, aliases);
}

const matchOne = (fields, index) => matchRow({ code: fields?.code ?? null, name: fields?.name ?? null }, index);

// Extracted rows, matched, as import_rows wants them. A row that is not matched with certainty keeps the matcher's
// note as an info issue (a row with no name and no code already says so with its error).
function matchAll(extracted, index) {
  return extracted.map((row) => {
    const m = matchOne(row.fields, index);
    const issues = [...row.issues];
    if (UNRESOLVED.has(m.status) && !issues.some((i) => i.code === 'NO_NAME_OR_CODE')) {
      issues.push(issue('info', 'MATCH_NOTE', null, m.note));
    }
    return {
      row_no: row.row_no, raw: row.raw, fields: row.fields,
      match: m.status, person_id: m.person_id, candidates: m.candidates, issues,
    };
  });
}

function countsOf(rows) {
  return {
    rows: rows.length,
    matched: rows.filter((row) => given(row.person_id)).length,
    unresolved: rows.filter((row) => UNRESOLVED.has(row.match)).length,
    errors: rows.filter((row) => hasError(row.issues)).length,
  };
}

// A saved map, cleaned: known fields, whole column numbers inside the sheet, each column once (it was checked when
// it was saved; this only keeps an odd row from reading the wrong column).
function cleanMap(raw, width) {
  const map = {};
  const used = new Set();
  for (const [key, col] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (FIELD_KEYS.has(key) && Number.isInteger(col) && col >= 0 && col < width && !used.has(col)) {
      map[key] = col;
      used.add(col);
    }
  }
  return map;
}

function cleanBlankZero(raw) {
  const out = {};
  for (const [key, on] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (NUMBER_FIELDS.has(key) && on === true) out[key] = true;
  }
  return out;
}

// The "blank counts as 0" ticks for a sheet with no remembered map: hr.settings.blank_zero, else the defaults.
async function defaultBlankZero(qx) {
  const [row] = await qx(`SELECT value FROM hr.settings WHERE key = 'blank_zero'`);
  if (row?.value && typeof row.value === 'object' && !Array.isArray(row.value)) return cleanBlankZero(row.value);
  return Object.fromEntries(FIELDS.filter((f) => f.kind === 'number' && f.blankZero).map((f) => [f.key, true]));
}

const columnName = (headers, col) => {
  const text = String(headers[col] ?? '').trim();
  return text ? `Column ${col + 1} (${text})` : `Column ${col + 1}`;
};

// A column map from the client: { field: column number | null }. A column feeds one field only, and the name or
// the code must be mapped, or no row could ever be matched.
function mapOf(raw, headers) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('column_map must be an object: { field: column number }');
  }
  const width = headers.length;
  const map = {};
  const owner = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (!FIELD_KEYS.has(key)) throw bad(`${key} is not a field the import knows`);
    if (value === null || value === undefined || value === '') continue;              // not in this sheet
    const col = typeof value === 'number' ? value
      : typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN;
    if (!Number.isInteger(col) || col < 0 || col >= width) {
      throw bad(`${key}: ${JSON.stringify(value)} is not a column of this sheet`);
    }
    if (owner.has(col)) {
      throw bad(`${columnName(headers, col)} is mapped to both ${owner.get(col)} and ${key}; one column can feed one field only`);
    }
    owner.set(col, key);
    map[key] = col;
  }
  if (map.name === undefined && map.code === undefined) {
    throw bad('Map the name column or the code column: without one no row can be matched to a person');
  }
  return map;
}

// "Blank counts as 0" ticks from the client: { field: true|false } or a list of fields. Number fields only.
function blankZeroOf(raw) {
  const out = {};
  const tick = (key) => {
    if (!NUMBER_FIELDS.has(key)) throw bad(`blank_as_zero: ${key} is not a number field`);
    out[key] = true;
  };
  if (raw === null) return out;
  if (Array.isArray(raw)) {
    for (const key of raw) {
      if (typeof key !== 'string') throw bad('blank_as_zero lists field names');
      tick(key);
    }
    return out;
  }
  if (typeof raw !== 'object') throw bad('blank_as_zero must be { field: true or false } or a list of fields');
  for (const [key, on] of Object.entries(raw)) {
    if (typeof on !== 'boolean') throw bad(`blank_as_zero: ${key} must be true or false`);
    if (on) tick(key);
    else if (!NUMBER_FIELDS.has(key)) throw bad(`blank_as_zero: ${key} is not a number field`);
  }
  return out;
}

const personSummary = (p) => (p ? {
  id: p.id, code: p.code, name: p.name, display_name: p.display_name, status: p.status,
  department: p.department, pay_channel: p.pay_channel, exited_on: p.exited_on,
} : null);

const sumMoney = (rows) => fmtPaise(rows.reduce((t, row) => t + paiseOf(row.amount), 0n));

// What the rows of a batch need from the live records: everyone (with whether they have a setup for the month),
// and the advances given in the app in the month and after it, for the people the rows name.
async function rowContext(qx, month, rows) {
  const people = await qx(PEOPLE_FOR_IMPORT, [`${month}-01`]);
  const ids = [...new Set(rows.map((row) => row.person_id).filter(given))].sort((a, b) => a - b);
  const inMonth = ids.length ? await inAppAdvancesInMonth(qx, ids, month) : new Map();
  const after = new Map();
  if (ids.length) {
    const later = await qx(
      `SELECT person_id, amount::text AS amount, txn_date::text AS txn_date
         FROM hr.advance_txns
        WHERE person_id = ANY($1::int[]) AND kind = 'given' AND source = 'manual' AND txn_date >= $2::date
        ORDER BY person_id, txn_date, id`,
      [ids, `${nextMonth(month)}-01`]);
    for (const t of later) {
      if (!after.has(t.person_id)) after.set(t.person_id, []);
      after.get(t.person_id).push(t);
    }
  }
  return { month, people, byId: new Map(people.map((p) => [p.id, p])), inMonth, after };
}

// The issues that depend on the live records, never stored (see the header).
function liveIssues(row, person, ctx) {
  if (!person) return [];
  const out = [];
  if (person.status === 'exited') {
    out.push(issue('warn', 'PERSON_EXITED', null, `${person.name} (${person.code}) is marked as left`
      + `${person.exited_on ? ` (last day ${person.exited_on})` : ''}: check that this row is meant to be paid`));
  }
  if (!person.has_setup) {
    out.push(issue('warn', 'NO_SETUP', null, `${person.name} (${person.code}) has no pay setup for `
      + `${monthLabel(ctx.month)}: the line will be blocked until one is added`));
  }
  const later = ctx.after.get(person.id) ?? [];
  if (later.length) {
    const each = firstFew(later.map((t) => `${inr(money(t.amount))} on ${t.txn_date}`));
    out.push(issue('info', 'ADVANCE_AFTER_MONTH_END', 'advance_given',
      `Given in the app after ${monthLabel(ctx.month)} ended: ${listText(each)}. `
      + `${later.length === 1 ? 'It belongs' : 'They belong'} to the next payroll month, so ${monthLabel(ctx.month)} `
      + `neither recovers ${later.length === 1 ? 'it' : 'them'} nor counts ${later.length === 1 ? 'it' : 'them'} `
      + 'against this sheet\'s advance'));
  }
  const sheet = row.fields?.advance_given;
  const recorded = ctx.inMonth.get(person.id) ?? '0.00';
  if (row.advance_mode !== 'extra' && given(sheet)) {
    let below = false;
    try { below = cmp(rat(sheet), rat(recorded)) < 0; } catch { below = false; }
    if (below) {
      out.push(issue('warn', 'ADVANCE_BELOW_RECORDED', 'advance_given',
        `The sheet's advance of ${inr(money(sheet))} is less than the ${inr(money(recorded))} already given in the app `
        + 'this month, so nothing more is added; the advances given in the app are still recovered'));
    }
  }
  return out;
}

const needsDecision = (row) => row.decision !== 'ignore' && (UNRESOLVED.has(row.match) || hasError(row.issues));

function rowView(row, ctx) {
  const person = given(row.person_id) ? ctx.byId.get(row.person_id) ?? null : null;
  const stored = Array.isArray(row.issues) ? row.issues : [];
  return {
    id: row.id,
    row_no: row.row_no,
    raw: row.raw,
    fields: row.fields,
    match: row.match,
    person_id: row.person_id,
    person: personSummary(person),
    candidates: (Array.isArray(row.candidates) ? row.candidates : [])
      .map((id) => personSummary(ctx.byId.get(id))).filter(Boolean),
    issues: [...stored, ...liveIssues(row, person, ctx)],
    advance_mode: row.advance_mode,
    decision: row.decision,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    needs_decision: needsDecision(row),
    in_app_advance: person ? ctx.inMonth.get(person.id) ?? '0.00' : null,
    in_app_after: person ? sumMoney(ctx.after.get(person.id) ?? []) : null,
  };
}

// Rows that are not ignored.
const liveRows = (rows) => rows.filter((row) => row.decision !== 'ignore');

function duplicatesOf(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return findDuplicates(liveRows(rows).map((row) => ({ row_id: row.id, person_id: row.person_id })))
    .map((ids) => ({ person_id: byId.get(ids[0]).person_id, row_ids: ids, row_nos: ids.map((id) => byId.get(id).row_no) }));
}

// People due this month (active, or leaving inside it) with a setup for the month whom no live row names.
function missingOf(rows, people, month) {
  const covered = new Set(liveRows(rows).map((row) => row.person_id).filter(given));
  return people.filter((p) => dueThisMonth(p, month) && p.has_setup && !covered.has(p.id));
}
const missingView = (p) => ({
  person_id: p.id, code: p.code, name: p.name, display_name: p.display_name, department: p.department, pay_channel: p.pay_channel,
  status: p.status, exited_on: p.exited_on,
});

function batchView(batch, names, run) {
  const headers = Array.isArray(batch.headers) ? batch.headers : [];
  const fieldAt = new Map(Object.entries(batch.column_map ?? {})
    .filter(([, col]) => Number.isInteger(col)).map(([key, col]) => [col, key]));
  return {
    id: batch.id,
    month: batch.month,
    file_name: batch.file_name,
    sheet: batch.sheet,
    header_row_no: given(batch.header_row) ? batch.header_row + 1 : null,
    headers: headers.map((text, index) => ({ index, text: text ?? '', field: fieldAt.get(index) ?? null })),
    signature: batch.signature,
    column_map: batch.column_map ?? {},
    blank_zero: batch.blank_zero ?? {},
    status: batch.status,
    uploaded_by: batch.uploaded_by,
    uploaded_by_name: given(batch.uploaded_by) ? names.get(batch.uploaded_by) ?? null : null,
    uploaded_at: batch.uploaded_at,
    applied_by: batch.applied_by,
    applied_by_name: given(batch.applied_by) ? names.get(batch.applied_by) ?? null : null,
    applied_at: batch.applied_at,
    run: run ? { id: run.id, status: run.status } : null,
  };
}

// {batch, rows, missing, duplicates, counts, fields}: the whole batch as the review screen needs it.
async function importPayload(qx, id) {
  const [batch] = await qx(`SELECT ${BATCH_COLS} FROM hr.import_batches WHERE id = $1`, [id]);
  if (!batch) throw notFound('Import');
  const rows = await qx(`SELECT ${ROW_COLS} FROM hr.import_rows WHERE batch_id = $1 ORDER BY row_no`, [id]);
  const ctx = await rowContext(qx, batch.month, rows);
  const [run] = await qx(`SELECT id, status FROM hr.runs WHERE month = $1`, [batch.month]);
  const names = await userNames(qx, [batch.uploaded_by, batch.applied_by]);
  const views = rows.map((row) => rowView(row, ctx));
  const duplicates = duplicatesOf(rows);
  const missing = missingOf(rows, ctx.people, batch.month).map(missingView);
  const live = liveRows(rows);
  return {
    batch: batchView(batch, names, run),
    rows: views,
    missing,
    duplicates,
    counts: {
      rows: rows.length,
      matched: live.filter((row) => given(row.person_id)).length,
      needs_decision: rows.filter(needsDecision).length,
      errors: live.filter((row) => hasError(row.issues)).length,
      warnings: views.filter((v) => v.decision !== 'ignore' && v.issues.some((i) => i.level === 'warn')).length,
      ignored: rows.length - live.length,
      duplicates: duplicates.length,
      missing: missing.length,
    },
    fields: FIELD_LIST,
  };
}

// ── POST /hr/imports — upload the month's sheet ─────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  // 4 MB is the real ceiling: Vercel refuses a body past about 4.5 MB before Express runs.
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});
const uploadOne = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) {
    return res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'Files are capped at 4 MB: save the month\'s sheet on its own and upload that'
        : err.message,
    });
  }
  return next();
});

// An .xlsx file is a zip: it starts PK\x03\x04.
const isXlsx = (buf) => Buffer.isBuffer(buf) && buf.length >= 4
  && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

function duplicateFile(month, dup) {
  return fail(409, `This file was already uploaded for ${monthLabel(month)} on ${plantDateStr(new Date(dup.uploaded_at))}: `
    + 'open that upload instead', 'DUPLICATE_FILE', { batch_id: dup.id, uploaded_at: dup.uploaded_at, status: dup.status });
}

const sameFile = (qx, month, sha) => qx(
  `SELECT id, uploaded_at, status FROM hr.import_batches
    WHERE month = $1 AND file_sha256 = $2 AND status <> 'discarded' ORDER BY id LIMIT 1`, [month, sha]);

r.post('/hr/imports', requireHr('operator'), uploadOne, async (req, res, next) => {
  try {
    if (!req.file) throw bad('No file received: attach the month\'s Excel sheet as "file"');
    const month = monthOf(optionalText(req.body?.month) ?? '');
    const buf = req.file.buffer;
    if (!isXlsx(buf)) throw bad('This is not an Excel workbook (.xlsx): save the sheet as .xlsx and upload that');
    const sha = createHash('sha256').update(buf).digest('hex');
    const fileName = (optionalText(req.file.originalname) ?? '').slice(0, 255) || null;

    const [run] = await q(`SELECT id, status FROM hr.runs WHERE month = $1`, [month]);
    if (run && run.status !== 'draft') throw runLocked(month, run.status);
    await refuseClosedMonth(q, month, 'imported');
    const [dup] = await sameFile(q, month, sha);
    if (dup) throw duplicateFile(month, dup);

    let sheets;
    try {
      ({ sheets } = await readWorkbook(buf));
    } catch (e) {
      throw bad(/too large to read/.test(String(e?.message))
        ? `${e.message} Delete the stray cells far from the data, or copy the month's table to a new workbook.`
        : 'This file could not be read as an Excel workbook (.xlsx). Open it in Excel, save it again as .xlsx and retry.');
    }
    const picked = pickSheet(sheets);
    if (!picked) {
      throw bad('No sheet in this workbook has a header row: one of its first 15 rows must name at least three '
        + 'known columns, such as NAME, CODE NO, OT, AB, MISC or ADVANCE');
    }
    const grid = sheets.find((s) => s.name === picked.name)?.grid ?? [];
    const auto = autoMap(picked.headers);
    const [saved] = await q(`SELECT field_map, blank_zero FROM hr.column_maps WHERE signature = $1`, [auto.signature]);
    const map = saved ? cleanMap(saved.field_map, picked.headers.length) : auto.map;
    const blankZero = saved ? cleanBlankZero(saved.blank_zero) : await defaultBlankZero(q);
    const extracted = extractRows(grid, picked.headerRow, map, { blankZero, daysInMonth: daysInMonthOf(month) });
    if (extracted.length > MAX_ROWS) {
      throw bad(`This sheet has ${extracted.length} rows below its header; a monthly payroll sheet has far fewer. `
        + 'Check that the right sheet was picked, or remove the rows that are not people');
    }

    const userId = userIdOf(req);
    let batchId;
    try {
      batchId = await tx(async (qc) => {
        const rows = matchAll(extracted, await matchIndex(qc));
        const [batch] = await qc(
          `INSERT INTO hr.import_batches (month, file_name, file_sha256, sheet, header_row, headers, signature,
                                          column_map, blank_zero, counts, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
           RETURNING id`,
          [month, fileName, sha, picked.name, picked.headerRow, jsonForPg(picked.headers), auto.signature,
            JSON.stringify(map), JSON.stringify(blankZero), JSON.stringify(countsOf(rows)), userId]);
        if (rows.length) await qc(INSERT_ROWS, [batch.id, jsonForPg(rows)]);
        await hrAudit(qc, req, 'import', batch.id, 'upload', {
          month, file_name: fileName, sheet: picked.name, rows: rows.length, map: saved ? 'saved' : 'automatic',
        });
        return batch.id;
      });
    } catch (e) {
      // Two uploads of one file at once: the unique index stops the second, which reads as the pre-check would.
      if (e?.code === '23505' && e.constraint === 'import_batches_month_file_uq') {
        const [raced] = await sameFile(q, month, sha);
        if (raced) throw duplicateFile(month, raced);
      }
      throw e;
    }
    res.json(await importPayload(q, batchId));
  } catch (e) { next(e); }
});

// ── Column maps ─────────────────────────────────────────────────────────────

// The maps the import remembers, by header signature. last_used is the latest upload with those headers.
r.get('/hr/column-maps', requireHr('viewer'), async (_req, res, next) => {
  try {
    res.json(await q(
      `SELECT m.id, m.signature, m.field_map AS map, m.blank_zero,
              coalesce((SELECT max(b.uploaded_at) FROM hr.import_batches b WHERE b.signature = m.signature), m.updated_at) AS last_used
         FROM hr.column_maps m
        ORDER BY last_used DESC, m.id`));
  } catch (e) { next(e); }
});

r.delete('/hr/column-maps/:id', requireHr('admin'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Column map');
    await tx(async (qc, oc) => {
      const gone = await oc(`DELETE FROM hr.column_maps WHERE id = $1 RETURNING id, signature`, [id]);
      if (!gone) throw notFound('Column map');
      await hrAudit(qc, req, 'column_map', id, 'delete', { signature: gone.signature });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── GET /hr/imports/:id ─────────────────────────────────────────────────────

r.get('/hr/imports/:id', requireHr('viewer'), async (req, res, next) => {
  try {
    res.json(await importPayload(q, idOf(req.params.id, 'Import')));
  } catch (e) { next(e); }
});

// ── PUT /hr/imports/:id/map — map the columns again ─────────────────────────

r.put('/hr/imports/:id/map', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Import');
    const body = bodyOf(req);
    if (!has(body, 'column_map')) throw bad('Send { column_map, blank_as_zero }');
    const userId = userIdOf(req);
    await tx(async (qc) => {
      const batch = await lockBatch(qc, id);
      if (batch.status !== 'parsed') {
        throw fail(409, batch.status === 'applied'
          ? 'This sheet has already been applied, so its columns can no longer be changed: upload a corrected file instead'
          : `This upload is ${batch.status}, so its columns can no longer be changed`, 'IMPORT_STATE');
      }
      const headers = Array.isArray(batch.headers) ? batch.headers : [];
      const map = mapOf(body.column_map, headers);
      const blankZero = has(body, 'blank_as_zero') ? blankZeroOf(body.blank_as_zero) : cleanBlankZero(batch.blank_zero);
      // The sheet again, from the rows the batch kept: each holds its whole raw row at its Excel row number.
      const stored = await qc(`SELECT row_no, raw FROM hr.import_rows WHERE batch_id = $1 ORDER BY row_no`, [id]);
      const grid = [];
      grid[batch.header_row] = headers;
      for (const s of stored) grid[s.row_no - 1] = Array.isArray(s.raw) ? s.raw : [];
      const extracted = extractRows(grid, batch.header_row, map, { blankZero, daysInMonth: daysInMonthOf(batch.month) });
      const rows = matchAll(extracted, await matchIndex(qc));
      // A parsed batch was never applied, so no run input points at its rows.
      await qc(`DELETE FROM hr.import_rows WHERE batch_id = $1`, [id]);
      if (rows.length) await qc(INSERT_ROWS, [id, jsonForPg(rows)]);
      await qc(
        `UPDATE hr.import_batches SET column_map = $2::jsonb, blank_zero = $3::jsonb, counts = $4::jsonb WHERE id = $1`,
        [id, JSON.stringify(map), JSON.stringify(blankZero), JSON.stringify(countsOf(rows))]);
      const [remembered] = await qc(UPSERT_COLUMN_MAP, [batch.signature, JSON.stringify(map), JSON.stringify(blankZero), userId]);
      await hrAudit(qc, req, 'import', id, 'map', {
        column_map: map, blank_zero: blankZero, rows: rows.length, column_map_id: remembered.id,
      });
    });
    res.json(await importPayload(q, id));
  } catch (e) { next(e); }
});

// ── PUT /hr/imports/:id/rows/:rowId — decide one row ────────────────────────

r.put('/hr/imports/:id/rows/:rowId', requireHr('operator'), async (req, res, next) => {
  try {
    const batchId = idOf(req.params.id, 'Import');
    const rowId = idOf(req.params.rowId, 'Import row');
    const body = bodyOf(req);
    const pick = has(body, 'person_id') ? (body.person_id === null ? null : personIdOf(body.person_id, 'person_id')) : undefined;
    const decision = has(body, 'decision') ? (body.decision === null ? null : choiceOf(body.decision, ['include', 'ignore'], 'decision'))
      : undefined;
    const advanceMode = has(body, 'advance_mode') ? choiceOf(body.advance_mode, ['total', 'extra'], 'advance_mode') : undefined;
    if (has(body, 'save_alias') && typeof body.save_alias !== 'boolean') throw bad('save_alias must be true or false');
    const saveAlias = body.save_alias === true;
    if (pick === undefined && decision === undefined && advanceMode === undefined && !saveAlias) {
      throw bad('Send person_id, decision, save_alias or advance_mode');
    }
    if (typeof pick === 'number' && decision === 'ignore') throw bad('Pick a person or ignore the row, not both');
    const userId = userIdOf(req);

    await tx(async (qc) => {
      if (saveAlias) await lockNames(qc);              // first, as every write of a spelling does (hr/names.js)
      await lockBatch(qc, batchId);
      const [row] = await qc(`SELECT ${ROW_COLS} FROM hr.import_rows WHERE id = $1 AND batch_id = $2 FOR UPDATE`, [rowId, batchId]);
      if (!row) throw notFound('Import row');
      const next = {
        match: row.match, person_id: row.person_id, candidates: row.candidates, decision: row.decision,
        advance_mode: row.advance_mode,
      };
      if (typeof pick === 'number') {
        const [person] = await qc(`SELECT id FROM hr.people WHERE id = $1`, [pick]);
        if (!person) throw bad('That person does not exist');
        Object.assign(next, { match: 'manual', person_id: pick, decision: 'include' });
      } else if (pick === null) {
        // The pick taken back: the row is matched again, as the upload would match it now.
        const m = matchOne(row.fields, await matchIndex(qc));
        Object.assign(next, { match: m.status, person_id: m.person_id, candidates: m.candidates, decision: null });
      }
      if (decision !== undefined) {
        if (decision === 'include' && !given(next.person_id)) throw bad('Pick the person this row is for first');
        next.decision = decision;
      }
      if (advanceMode !== undefined) next.advance_mode = advanceMode;

      let alias = null;
      if (saveAlias) {
        if (!given(next.person_id)) throw bad('Pick the person this spelling belongs to first');
        const spelling = normName(row.fields?.name);
        if (!spelling) throw bad('This row has no name to remember');
        if (spelling.length > 120) throw bad('That spelling is too long to remember (at most 120 characters)');
        await assertAliasFree(qc, spelling);
        const [held] = await qc(
          `SELECT a.person_id, p.code, p.name FROM hr.person_aliases a JOIN hr.people p ON p.id = a.person_id
            WHERE a.alias_norm = $1`, [spelling]);
        if (held && held.person_id !== next.person_id) {
          throw fail(409, `${spelling} is already an approved spelling of ${held.name} (${held.code})`, 'ALIAS_EXISTS');
        }
        if (!held) {
          const [made] = await qc(
            `INSERT INTO hr.person_aliases (person_id, alias_norm, source, approved_by)
             VALUES ($1, $2, 'import', $3) RETURNING id`, [next.person_id, spelling, userId]);
          await hrAudit(qc, req, 'alias', made.id, 'create', {
            person_id: next.person_id, alias: spelling, batch_id: batchId, row_no: row.row_no,
          });
          alias = spelling;
        }
      }

      const decided = next.decision !== row.decision || next.person_id !== row.person_id;
      await qc(
        `UPDATE hr.import_rows
            SET match = $2, person_id = $3, candidates = $4::jsonb, decision = $5, advance_mode = $6,
                decided_by = CASE WHEN $7 THEN $8::integer ELSE decided_by END,
                decided_at = CASE WHEN $7 THEN now() ELSE decided_at END
          WHERE id = $1`,
        [rowId, next.match, next.person_id, JSON.stringify(next.candidates ?? []), next.decision, next.advance_mode,
          decided, userId]);
      await hrAudit(qc, req, 'import_row', rowId, 'decide', {
        batch_id: batchId, row_no: row.row_no,
        from: { match: row.match, person_id: row.person_id, decision: row.decision, advance_mode: row.advance_mode },
        to: { match: next.match, person_id: next.person_id, decision: next.decision, advance_mode: next.advance_mode },
        alias_saved: alias,
      });
    });

    const [batch] = await q(`SELECT month FROM hr.import_batches WHERE id = $1`, [batchId]);
    const [row] = await q(`SELECT ${ROW_COLS} FROM hr.import_rows WHERE id = $1`, [rowId]);
    res.json(rowView(row, await rowContext(q, batch.month, [row])));
  } catch (e) { next(e); }
});

// ── POST /hr/imports/:id/discard — an upload that will not be used ──────────

// A parsed upload of a month that is still open (no run, or a draft run) is set aside: status 'discarded', audited.
// It then no longer counts as the month's pending upload, its undecided rows stop counting, and the same file can be
// uploaded again (the duplicate-file index skips discarded batches). An applied or superseded upload is history and
// stays. Discarding a discarded upload again changes nothing.
r.post('/hr/imports/:id/discard', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Import');
    const body = bodyOf(req);
    const reason = textOf(body.reason, 'The reason', 500);

    await tx(async (qc) => {
      const [first] = await qc(`SELECT id, month FROM hr.import_batches WHERE id = $1`, [id]);
      if (!first) throw notFound('Import');
      // The run first (the lock order every run write keeps), then the batch.
      const [run] = await qc(`SELECT id, status FROM hr.runs WHERE month = $1 FOR UPDATE`, [first.month]);
      if (run && run.status !== 'draft') throw runLocked(first.month, run.status);
      const batch = await lockBatch(qc, id);
      if (batch.status === 'discarded') return;
      if (batch.status !== 'parsed') {
        throw fail(409, batch.status === 'applied'
          ? 'This sheet is already the month\'s inputs, so it cannot be discarded: upload a corrected file instead'
          : `This upload is ${batch.status}, so there is nothing to discard`, 'IMPORT_STATE');
      }
      await qc(`UPDATE hr.import_batches SET status = 'discarded' WHERE id = $1`, [id]);
      await hrAudit(qc, req, 'import', id, 'discard', { month: batch.month, file_name: batch.file_name, reason });
    });
    res.json(await importPayload(q, id));
  } catch (e) { next(e); }
});

// ── POST /hr/imports/:id/apply — the batch becomes the month's inputs ───────

const INPUT_COLUMNS = [
  ...INPUT_NUMBERS.map((c) => [c, 'numeric']),
  ['remarks', 'text'], ['paid_separately_note', 'text'], ['advance_mode', 'text'], ['include', 'boolean'],
  ['source_row_id', 'integer'],
];
// One statement for every person, in person order (so the people rows its foreign keys touch are locked in the
// order finaliseRun locks them).
const UPSERT_INPUTS = `
  INSERT INTO hr.run_inputs (run_id, person_id, ${INPUT_COLUMNS.map(([c]) => c).join(', ')}, source, updated_by, updated_at)
  SELECT $1::integer, x.person_id, ${INPUT_COLUMNS.map(([c]) => `x.${c}`).join(', ')}, $2::text, $3::integer, now()
    FROM jsonb_to_recordset($4::jsonb) AS x(person_id integer, ${INPUT_COLUMNS.map(([c, t]) => `${c} ${t}`).join(', ')})
   ORDER BY x.person_id
  ON CONFLICT (run_id, person_id) DO UPDATE SET
    ${INPUT_COLUMNS.map(([c]) => `${c} = EXCLUDED.${c}`).join(', ')},
    source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING id, person_id`;

// What a sheet row gives run_inputs. A field the sheet does not have stays null: not given.
function inputFromRow(row) {
  const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
  const input = {
    include: true,
    advance_mode: row.advance_mode === 'extra' ? 'extra' : 'total',
    source_row_id: row.id,
    remarks: typeof f.remarks === 'string' ? optionalText(f.remarks) : null,
    paid_separately_note: null,
  };
  for (const c of INPUT_NUMBERS) input[c] = typeof f[c] === 'string' && f[c] !== '' ? f[c] : null;
  return input;
}

// A missing person as chosen: included with nothing typed (no OT, no absences), or left out this month.
function blankInput(include) {
  const input = { include, advance_mode: 'total', source_row_id: null, remarks: null, paid_separately_note: null };
  for (const c of INPUT_NUMBERS) input[c] = null;
  return input;
}

function choicesOf(raw) {
  const out = new Map();
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) throw bad('missing must be a list of { person_id, choice }');
  if (raw.length > MAX_IDS) throw bad('missing lists too many people');
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw bad('Each missing entry is { person_id, choice }');
    out.set(personIdOf(item.person_id, 'missing'), choiceOf(item.choice, ['include', 'exclude'], 'choice'));
  }
  return out;
}

function unresolvedRefusal(open, groups, rowsById, unchosen) {
  const duplicateRows = groups.map((ids) => ids.map((id) => rowsById.get(id).row_no));
  const rowNos = [...new Set([...open.map((row) => row.row_no), ...duplicateRows.flat()])].sort((a, b) => a - b);
  const parts = [];
  if (open.length) {
    parts.push(`${open.length === 1 ? 'row' : 'rows'} ${listText(firstFew(open.map((row) => String(row.row_no))))} `
      + `${open.length === 1 ? 'needs' : 'need'} a decision`);
  }
  if (groups.length) {
    parts.push(`${groups.length === 1 ? 'one person has' : `${groups.length} people have`} more than one row `
      + `(rows ${duplicateRows.map((g) => g.join(' & ')).join(', ')}): keep one and ignore the rest`);
  }
  if (unchosen.length) {
    parts.push(`${listText(firstFew(unchosen.map((p) => `${p.name} (${p.code})`)))} `
      + `${unchosen.length === 1 ? 'is' : 'are'} missing from the sheet: include or leave out`);
  }
  return fail(409, `The sheet cannot be applied yet: ${parts.join('; ')}`, 'IMPORT_UNRESOLVED', {
    rows: rowNos, duplicate_rows: duplicateRows, missing: unchosen.map((p) => p.id),
  });
}

r.post('/hr/imports/:id/apply', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Import');
    const body = bodyOf(req);
    const choices = choicesOf(body.missing);
    const overwrite = new Set(idListOf(body.overwrite_manual, 'overwrite_manual') ?? []);
    const userId = userIdOf(req);

    const out = await tx(async (qc) => {
      const [first] = await qc(`SELECT id, month FROM hr.import_batches WHERE id = $1`, [id]);
      if (!first) throw notFound('Import');
      const { month } = first;
      // The run first (the lock order every run write keeps), then the batch.
      await ensureRun(qc, month, userId);
      const run = await lockRunOf(qc, month);
      if (run.status !== 'draft') throw runLocked(month, run.status);
      const batch = await lockBatch(qc, id);
      if (batch.status === 'discarded') throw fail(409, 'This upload was discarded', 'IMPORT_STATE');

      const rows = await qc(`SELECT ${ROW_COLS} FROM hr.import_rows WHERE batch_id = $1 ORDER BY row_no`, [id]);
      const people = await qc(PEOPLE_FOR_IMPORT, [`${month}-01`]);
      const live = liveRows(rows);
      const open = live.filter(needsDecision);
      const groups = findDuplicates(live.map((row) => ({ row_id: row.id, person_id: row.person_id })));
      const absent = missingOf(rows, people, month);
      const unchosen = absent.filter((p) => !choices.has(p.id));
      if (open.length || groups.length || unchosen.length) {
        throw unresolvedRefusal(open, groups, new Map(rows.map((row) => [row.id, row])), unchosen);
      }

      // What this batch says each person's inputs are.
      const wanted = new Map();
      for (const row of live) if (given(row.person_id)) wanted.set(row.person_id, inputFromRow(row));
      for (const p of absent) wanted.set(p.id, blankInput(choices.get(p.id) === 'include'));

      const existing = await qc(
        `SELECT i.person_id, i.source, i.updated_at, p.code, p.name
           FROM hr.run_inputs i JOIN hr.people p ON p.id = i.person_id
          WHERE i.run_id = $1
          ORDER BY i.person_id
            FOR UPDATE OF i`, [run.id]);
      const kept = existing.filter((e) => e.source === 'manual' && wanted.has(e.person_id) && !overwrite.has(e.person_id));
      const keptIds = new Set(kept.map((e) => e.person_id));
      const overwritten = existing.filter((e) => e.source === 'manual' && wanted.has(e.person_id) && overwrite.has(e.person_id))
        .map((e) => e.person_id);
      // Imported inputs this batch no longer gives: a person the corrected sheet dropped, a row now ignored.
      const stale = existing.filter((e) => e.source === 'import' && !wanted.has(e.person_id)).map((e) => e.person_id);
      const write = [...wanted].filter(([personId]) => !keptIds.has(personId))
        .map(([personId, input]) => ({ person_id: personId, ...input }));

      if (stale.length) await qc(`DELETE FROM hr.run_inputs WHERE run_id = $1 AND person_id = ANY($2::int[])`, [run.id, stale]);
      if (write.length) await qc(UPSERT_INPUTS, [run.id, 'import', userId, jsonForPg(write)]);
      const superseded = await qc(
        `UPDATE hr.import_batches SET status = 'superseded'
          WHERE month = $1 AND status = 'applied' AND id <> $2 RETURNING id`, [month, id]);
      await qc(`UPDATE hr.import_batches SET status = 'applied', applied_by = $2, applied_at = now() WHERE id = $1`, [id, userId]);
      const { run: recalced, lines } = await recalcRun(qc, run);

      const included = write.filter((w) => w.include).length;
      await hrAudit(qc, req, 'import', id, 'apply', {
        month, run_id: run.id, applied: included, left_out: write.length - included, removed: stale,
        manual_kept: [...keptIds], manual_overwritten: overwritten, superseded: superseded.map((b) => b.id),
        lines: lines.length,
      });
      return { run: recalced, applied: included, excluded: write.length - included, removed: stale.length, kept };
    });

    res.json({
      run: await runView(q, out.run),
      applied: out.applied,
      excluded: out.excluded,
      removed: out.removed,
      manual_edits_kept: out.kept.map((e) => ({ person_id: e.person_id, code: e.code, name: e.name, updated_at: e.updated_at })),
    });
  } catch (e) { next(e); }
});

// ── GET /hr/runs, GET /hr/runs/:month ───────────────────────────────────────

r.get('/hr/runs', requireHr('viewer'), async (_req, res, next) => {
  try {
    const runs = await q(
      `SELECT r.*,
              (SELECT count(*)::int FROM hr.run_lines l WHERE l.run_id = r.id) AS line_count,
              (SELECT count(*)::int FROM hr.run_lines l WHERE l.run_id = r.id AND l.payment_status = 'paid') AS paid_count
         FROM hr.runs r
        ORDER BY r.month DESC`);
    const names = await userNames(q, runs.flatMap((run) => RUN_BY.map((k) => run[k])));
    res.json(runs.map((run) => runWithNames(run, names)));
  } catch (e) { next(e); }
});

// Counts of the run's flags: lines with at least one flag of each level, and each code with its level and count.
function flagsSummary(lines) {
  const out = { lines: lines.length, block: 0, warn: 0, info: 0, codes: [] };
  const codes = new Map();
  for (const line of lines) {
    const flags = Array.isArray(line.flags) ? line.flags : [];
    for (const level of ['block', 'warn', 'info']) if (flags.some((f) => f?.level === level)) out[level] += 1;
    for (const f of flags) {
      if (!f?.code) continue;
      if (!codes.has(f.code)) codes.set(f.code, { code: f.code, level: f.level, count: 0 });
      codes.get(f.code).count += 1;
    }
  }
  const rank = { block: 0, warn: 1, info: 2 };
  out.codes = [...codes.values()].sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || (a.code < b.code ? -1 : 1));
  return out;
}

const LINE_SELECT = `
  SELECT l.*, l.paid_on::text AS paid_on, p.code, p.name, p.display_name, p.department, p.designation, p.status AS person_status,
         c.label AS pay_channel_label
    FROM hr.run_lines l
    JOIN hr.people p ON p.id = l.person_id
    LEFT JOIN hr.pay_channels c ON c.code = l.pay_channel`;
const INPUT_SELECT = `
  SELECT i.*, p.code, p.name, p.display_name
    FROM hr.run_inputs i
    JOIN hr.people p ON p.id = i.person_id`;

// The month's latest upload that is parsed but not applied (nor discarded), with how many of its rows still need a
// decision (the rows the review screen counts as needs_decision), or null. `parsed_uploads` says how many such
// uploads the month has in all, so an older forgotten one is not hidden behind the latest.
async function pendingImportOf(qx, imports) {
  const parsed = imports.filter((b) => b.status === 'parsed');
  const latest = parsed[0];                                   // imports are newest first
  if (!latest) return null;
  const [{ unresolved }] = await qx(
    `SELECT count(*)::int AS unresolved
       FROM hr.import_rows ir
      WHERE ir.batch_id = $1
        AND ir.decision IS DISTINCT FROM 'ignore'
        AND (ir.match = ANY($2::text[])
             OR (jsonb_typeof(ir.issues) = 'array'
                 AND EXISTS (SELECT 1 FROM jsonb_array_elements(ir.issues) e WHERE e->>'level' = 'error')))`,
    [latest.id, [...UNRESOLVED]]);
  return {
    batch_id: latest.id,
    file_name: latest.file_name,
    uploaded_at: latest.uploaded_at,
    uploaded_by: latest.uploaded_by,
    uploaded_by_name: latest.uploaded_by_name,
    unresolved,
    parsed_uploads: parsed.length,
  };
}

r.get('/hr/runs/:month', requireHr('viewer'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const [run] = await q(`SELECT * FROM hr.runs WHERE month = $1`, [month]);
    const imports = await q(
      `SELECT id, file_name, status, uploaded_by, uploaded_at, applied_by, applied_at, counts
         FROM hr.import_batches WHERE month = $1 ORDER BY id DESC`, [month]);
    const importNames = await userNames(q, imports.flatMap((b) => [b.uploaded_by, b.applied_by]));
    const importViews = imports.map((b) => ({
      ...b,
      uploaded_by_name: given(b.uploaded_by) ? importNames.get(b.uploaded_by) ?? null : null,
      applied_by_name: given(b.applied_by) ? importNames.get(b.applied_by) ?? null : null,
    }));
    const pendingImport = await pendingImportOf(q, importViews);
    if (!run) {
      return res.json({
        run: null, lines: [], inputs: [], payment_totals: paymentTotals([]), flags_summary: flagsSummary([]),
        missing: await peopleWithoutInputs(q, null, month), imports: importViews, pending_import: pendingImport,
      });
    }
    const found = await q(`${LINE_SELECT} WHERE l.run_id = $1 ORDER BY l.person_id`, [run.id]);
    const heldBy = await userNames(q, found.map((l) => l.held_by));
    const lines = found.map((l) => ({ ...l, held_by_name: given(l.held_by) ? heldBy.get(l.held_by) ?? null : null }));
    const inputs = await q(`${INPUT_SELECT} WHERE i.run_id = $1 ORDER BY i.person_id`, [run.id]);
    res.json({
      run: await runView(q, run),
      lines,
      inputs,
      payment_totals: paymentTotals(await q(
        `SELECT payment_status, pay_channel, payable::text AS payable, paid_amount::text AS paid_amount
           FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id`, [run.id])),
      flags_summary: flagsSummary(lines),
      missing: await peopleWithoutInputs(q, run.id, month),
      imports: importViews,
      pending_import: pendingImport,
    });
  } catch (e) { next(e); }
});

// ── PUT /hr/runs/:month/inputs/:personId — inputs typed by hand ─────────────

// Only the fields sent change; null clears one. At least one must be sent.
function inputPatchOf(body) {
  const patch = {};
  for (const c of INPUT_QTY) if (has(body, c)) patch[c] = amountOf(body[c], INPUT_LABELS[c], 4);
  for (const c of INPUT_MONEY) if (has(body, c)) patch[c] = amountOf(body[c], INPUT_LABELS[c], 2);
  for (const [c, max] of Object.entries(INPUT_TEXT)) if (has(body, c)) patch[c] = textOf(body[c], INPUT_LABELS[c], max);
  if (has(body, 'advance_mode') && body.advance_mode !== null) {
    patch.advance_mode = choiceOf(body.advance_mode, ['total', 'extra'], 'advance_mode');
  }
  if (has(body, 'include') && body.include !== null) {
    if (typeof body.include !== 'boolean') throw bad('include must be true or false');
    patch.include = body.include;
  }
  if (!Object.keys(patch).length) throw bad('Send at least one input to change');
  return patch;
}

const INPUT_EXACT = `${INPUT_NUMBERS.map((c) => `${c}::text AS ${c}`).join(', ')}, remarks, paid_separately_note,
  advance_mode, include, source, source_row_id`;

// The fields that differ, before → after (numbers compared exactly: '10' and '10.0000' are the same).
function inputChanges(before, after) {
  const changes = {};
  const same = (a, b, numeric) => {
    if (!given(a) || !given(b)) return !given(a) && !given(b);
    return numeric ? cmp(rat(a), rat(b)) === 0 : a === b;
  };
  for (const c of INPUT_NUMBERS) {
    if (!same(before?.[c] ?? null, after[c] ?? null, true)) changes[c] = { from: before?.[c] ?? null, to: after[c] ?? null };
  }
  for (const c of ['remarks', 'paid_separately_note', 'advance_mode', 'include']) {
    const from = before ? before[c] ?? null : null;
    if (!same(from, after[c] ?? null, false)) changes[c] = { from, to: after[c] ?? null };
  }
  return changes;
}

r.put('/hr/runs/:month/inputs/:personId', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const personId = idOf(req.params.personId, 'Person');
    const body = bodyOf(req);
    const reason = textOf(body.reason, 'The reason', 500);
    if (!reason) throw bad('Say why the inputs are being changed: the reason is kept with the change');
    const patch = inputPatchOf(body);
    const userId = userIdOf(req);

    const runId = await tx(async (qc) => {
      const [person] = await qc(`SELECT id FROM hr.people WHERE id = $1`, [personId]);
      if (!person) throw notFound('Person');
      await ensureRun(qc, month, userId);
      const run = await lockRunOf(qc, month);
      if (run.status !== 'draft') throw runLocked(month, run.status);
      const [before] = await qc(
        `SELECT id, ${INPUT_EXACT} FROM hr.run_inputs WHERE run_id = $1 AND person_id = $2 FOR UPDATE`, [run.id, personId]);
      const start = before ?? { ...blankInput(true) };
      const after = { ...start, ...patch };
      const row = { person_id: personId, source_row_id: before?.source_row_id ?? null, advance_mode: after.advance_mode ?? 'total',
        include: after.include !== false, remarks: after.remarks ?? null, paid_separately_note: after.paid_separately_note ?? null };
      for (const c of INPUT_NUMBERS) row[c] = after[c] ?? null;
      const [saved] = await qc(UPSERT_INPUTS, [run.id, 'manual', userId, jsonForPg([row])]);
      await recalcRun(qc, run, { personIds: [personId] });
      await hrAudit(qc, req, 'run_input', saved.id, before ? 'edit' : 'create', {
        month, run_id: run.id, person_id: personId, reason, was: before ? before.source : null, changes: inputChanges(before, row),
      });
      return run.id;
    });

    const [line] = await q(`${LINE_SELECT} WHERE l.run_id = $1 AND l.person_id = $2`, [runId, personId]);
    const [input] = await q(`${INPUT_SELECT} WHERE i.run_id = $1 AND i.person_id = $2`, [runId, personId]);
    res.json({ line: line ?? null, input: input ?? null });
  } catch (e) { next(e); }
});

// ── POST /hr/runs/:month/recalc ─────────────────────────────────────────────

r.post('/hr/runs/:month/recalc', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const run = await tx(async (qc) => {
      const locked = await lockRunOf(qc, month);
      if (locked.status !== 'draft') throw runLocked(month, locked.status);
      const { run: updated, lines } = await recalcRun(qc, locked);
      await hrAudit(qc, req, 'run', locked.id, 'recalc', { month, lines: lines.length });
      return updated;
    });
    res.json(await runView(q, run));
  } catch (e) { next(e); }
});

// ── Transitions: submit, send back, approve, finalise ───────────────────────

const payrollLink = (month) => `/hr?tab=payroll&month=${month}`;

r.post('/hr/runs/:month/submit', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const userId = userIdOf(req);
    const run = await tx(async (qc) => {
      const locked = await lockRunOf(qc, month);
      if (locked.status !== 'draft') throw runState(locked, 'a draft', 'submitted');
      await refuseClosedMonth(qc, month, 'submitted');
      // The whole run worked out again first, so what is submitted is what the records say now.
      const { lines } = await recalcRun(qc, locked);
      const blocked = lines.filter((l) => isBlocked(l.flags)).map((l) => l.person_id);
      const without = await peopleWithoutInputs(qc, locked.id, month);
      if (blocked.length || without.length) {
        const parts = [];
        if (blocked.length) parts.push(`${blocked.length} ${blocked.length === 1 ? 'line is' : 'lines are'} blocked`);
        if (without.length) {
          parts.push(`${listText(firstFew(without.map((p) => `${p.name} (${p.code})`)))} `
            + `${without.length === 1 ? 'has' : 'have'} no inputs and no leave-out for the month`);
        }
        throw fail(409, `${monthLabel(month)} cannot be submitted yet: ${parts.join('; ')}`, 'RUN_BLOCKED', {
          person_ids: [...new Set([...blocked, ...without.map((p) => p.person_id)])].sort((a, b) => a - b),
          blocked, missing: without.map((p) => p.person_id),
        });
      }
      const [done] = await qc(
        `UPDATE hr.runs SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE id = $1 RETURNING *`,
        [locked.id, userId]);
      await hrAudit(qc, req, 'run', locked.id, 'submit', { month, lines: lines.length });
      const approvers = await qc(
        `SELECT a.user_id FROM hr.access a JOIN public.users u ON u.id = a.user_id
          WHERE a.level IN ('approver', 'admin') AND u.active = 1 ORDER BY a.user_id`);
      await notify(approvers.map((a) => a.user_id), {
        kind: 'hr_run_submitted',
        title: `Payroll ${monthLabel(month)} submitted for approval`,
        body: `${userNameOf(req)} submitted it. Open HR & Payroll to review and approve it.`,
        link: payrollLink(month),
        refTable: 'hr.runs',
        refId: locked.id,
      }, qc);
      return done;
    });
    res.json(await runView(q, run));
  } catch (e) { next(e); }
});

r.post('/hr/runs/:month/send-back', requireHr('approver'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const body = bodyOf(req);
    const reason = textOf(body.reason, 'The reason', 1000);
    if (!reason) throw bad('Say why the run is being sent back: the preparer sees the reason');
    const userId = userIdOf(req);
    const run = await tx(async (qc) => {
      const locked = await lockRunOf(qc, month);
      if (locked.status !== 'submitted' && locked.status !== 'approved') {
        throw runState(locked, 'a submitted or approved', 'sent back');
      }
      const [done] = await qc(
        `UPDATE hr.runs
            SET status = 'draft', sent_back_by = $2, sent_back_at = now(), sent_back_reason = $3,
                submitted_by = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL
          WHERE id = $1
          RETURNING *`, [locked.id, userId, reason]);
      await hrAudit(qc, req, 'run', locked.id, 'send_back', { month, from: locked.status, reason });
      // The words name the month and who; the reason stays in the app (free text could carry an amount).
      await notify([locked.prepared_by, locked.submitted_by].filter(given), {
        kind: 'hr_run_sent_back',
        title: `Payroll ${monthLabel(month)} sent back`,
        body: `${userNameOf(req)} sent it back with a reason. Open HR & Payroll to see it.`,
        link: payrollLink(month),
        refTable: 'hr.runs',
        refId: locked.id,
      }, qc);
      return done;
    });
    res.json(await runView(q, run));
  } catch (e) { next(e); }
});

r.post('/hr/runs/:month/approve', requireHr('approver'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const userId = userIdOf(req);
    const out = await tx(async (qc) => {
      const locked = await lockRunOf(qc, month);
      if (locked.status !== 'submitted') throw runState(locked, 'a submitted', 'approved');
      await refuseClosedMonth(qc, month, 'approved');
      const samePerson = given(userId) && locked.submitted_by === userId;
      if (samePerson) {
        const [strict] = await qc(`SELECT value FROM hr.settings WHERE key = 'strict_separation'`);
        if (strict?.value === true) {
          throw fail(409, 'You submitted this run, and strict separation is on: someone else must approve it', 'SAME_PERSON');
        }
      }
      const [done] = await qc(
        `UPDATE hr.runs SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`,
        [locked.id, userId]);
      await hrAudit(qc, req, 'run', locked.id, 'approve', { month, same_person: samePerson });
      return { run: done, samePerson };
    });
    const view = await runView(q, out.run);
    res.json(out.samePerson ? { ...view, warning: 'approved by the person who submitted' } : view);
  } catch (e) { next(e); }
});

r.post('/hr/runs/:month/finalise', requireHr('approver'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const run = await tx(async (qc) => {
      const [found] = await qc(`SELECT id FROM hr.runs WHERE month = $1`, [month]);
      if (!found) {
        throw fail(404, `There is no payroll run for ${monthLabel(month)} yet`, 'RUN_NOT_FOUND');
      }
      return finaliseRun(qc, found, req);           // locks, checks, posts once and audits (hr/runs.js)
    });
    res.json(await runView(q, run));
  } catch (e) { next(e); }
});

// ── Payments (a finalised run only; finalised is never proof of payment) ────

r.post('/hr/runs/:month/payments', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const body = bodyOf(req);
    const channel = textOf(body.pay_channel, 'The pay channel', 60);
    if (!channel) throw bad('Choose the pay channel being paid');
    const reference = textOf(body.reference, 'The reference', 120);
    const paidOn = dateOf(body.paid_on, 'The payment date') ?? plantDateStr();
    if (paidOn > plantDateStr()) throw bad('The payment date cannot be in the future');
    const only = idListOf(body.person_ids, 'person_ids');
    const userId = userIdOf(req);

    const batch = await tx(async (qc) => {
      const run = await lockRunOf(qc, month);
      if (run.status !== 'finalised') throw runState(run, 'a finalised', 'paid');
      const unpaid = await qc(
        `SELECT id, person_id, payment_status, hold_reason FROM hr.run_lines
          WHERE run_id = $1 AND pay_channel = $2 AND payment_status <> 'paid' AND payable IS NOT NULL AND payable >= 0
            ${only ? 'AND person_id = ANY($3::int[])' : ''}
          ORDER BY person_id
            FOR UPDATE`, only ? [run.id, channel, only] : [run.id, channel]);
      if (only) {
        const found = new Set(unpaid.map((l) => l.person_id));
        const absent = only.filter((id) => !found.has(id));
        if (absent.length) {
          throw bad(`No unpaid line in ${channel} for person ${listText(firstFew(absent.map(String)))}`);
        }
      }
      // A line on hold is not payable: the batch leaves it as it is and says so.
      const held = unpaid.filter((l) => l.payment_status === 'on_hold')
        .map((l) => ({ person_id: l.person_id, reason: l.hold_reason ?? null }));
      const lines = unpaid.filter((l) => l.payment_status !== 'on_hold');
      if (!lines.length) {
        const [any] = await qc(`SELECT 1 FROM hr.run_lines WHERE run_id = $1 AND pay_channel = $2 LIMIT 1`, [run.id, channel]);
        if (!any) throw bad(`No line of ${monthLabel(month)} is paid through ${channel}`);
        if (held.length) {
          throw fail(409, `Nothing to pay through ${channel}: ${held.length === 1 ? 'the one unpaid line is' : `all ${held.length} unpaid lines are`} `
            + 'on hold. Release a hold (mark the line unpaid) to pay it', 'NOTHING_TO_PAY', { held });
        }
        throw fail(409, `Every line of ${monthLabel(month)} paid through ${channel} is already paid`, 'NOTHING_TO_PAY');
      }
      const ids = lines.map((l) => l.id);
      const [made] = await qc(
        `INSERT INTO hr.payment_batches (run_id, pay_channel, count, total, status, reference, paid_on,
                                         confirmed_by, confirmed_at, created_by)
         SELECT $1, $2, count(*), coalesce(sum(payable), 0), 'confirmed', $3, $4::date, $5, now(), $5
           FROM hr.run_lines WHERE id = ANY($6::int[])
         RETURNING *`, [run.id, channel, reference, paidOn, userId, ids]);
      await qc(
        `UPDATE hr.run_lines
            SET payment_status = 'paid', payment_batch_id = $2, paid_amount = payable, paid_on = $3::date,
                paid_at = now(), paid_ref = $4
          WHERE id = ANY($1::int[])`, [ids, made.id, paidOn, reference]);
      await hrAudit(qc, req, 'payment_batch', made.id, 'create', {
        month, run_id: run.id, pay_channel: channel, count: made.count, total: money(made.total), reference, paid_on: paidOn,
        person_ids: lines.map((l) => l.person_id), held: held.map((h) => h.person_id),
      });
      return { ...made, paid_on: paidOn, person_ids: lines.map((l) => l.person_id), held };
    });
    res.json(batch);
  } catch (e) { next(e); }
});

r.put('/hr/runs/:month/lines/:personId/payment', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const personId = idOf(req.params.personId, 'Line');
    const body = bodyOf(req);
    const status = choiceOf(body.status, ['paid', 'failed', 'reversed'], 'status');
    if (status === 'reversed' && !levelAtLeast(req.hr?.level, 'approver')) {
      return res.status(403).json({ error: 'Needs HR approver access to reverse a payment', code: 'HR_LEVEL' });
    }
    const reference = textOf(body.reference, 'The reference', 120);
    const paidOn = status === 'paid' ? dateOf(body.paid_on, 'The payment date') ?? plantDateStr() : null;
    if (paidOn && paidOn > plantDateStr()) throw bad('The payment date cannot be in the future');

    await tx(async (qc) => {
      const run = await lockRunOf(qc, month);
      if (run.status !== 'finalised') throw runState(run, 'a finalised', 'paid');
      const [line] = await qc(
        `SELECT id, payment_status, payable::text AS payable, paid_ref FROM hr.run_lines
          WHERE run_id = $1 AND person_id = $2 FOR UPDATE`, [run.id, personId]);
      if (!line) throw notFound('Line');
      const from = line.payment_status;
      const allowed = { paid: ['pending', 'failed', 'reversed'], failed: ['pending', 'paid'], reversed: ['paid'] }[status];
      if (from === 'on_hold') {
        throw fail(409, 'This line is on hold, so it is not payable: release the hold (mark it unpaid) first', 'PAYMENT_STATE');
      }
      if (!allowed.includes(from)) {
        throw fail(409, `This line is ${STATUS_WORD[from] ?? from}, so it cannot be marked ${STATUS_WORD[status] ?? status}`, 'PAYMENT_STATE');
      }
      if (status === 'paid') {
        // A zero-payable line can be marked paid (paid_amount 0.00), as the batch does; only a line whose pay is
        // below zero (the person owes) or not worked out is refused.
        const due = line.payable === null ? null : paiseOf(line.payable);
        if (due === null || due < 0n) throw fail(409, 'This line has nothing to pay', 'NOTHING_TO_PAY');
        await qc(
          `UPDATE hr.run_lines
              SET payment_status = 'paid', paid_amount = payable, paid_on = $2::date, paid_at = now(), paid_ref = $3
            WHERE id = $1`, [line.id, paidOn, reference]);
      } else {
        await qc(
          `UPDATE hr.run_lines
              SET payment_status = $2, paid_amount = NULL, paid_on = NULL, paid_at = NULL, paid_ref = coalesce($3, paid_ref)
            WHERE id = $1`, [line.id, status, reference]);
      }
      await hrAudit(qc, req, 'run_line', line.id, 'payment', {
        month, run_id: run.id, person_id: personId, from, to: status, reference, paid_on: paidOn,
      });
    });

    const [line] = await q(`${LINE_SELECT} WHERE l.run_id = (SELECT id FROM hr.runs WHERE month = $1) AND l.person_id = $2`,
      [month, personId]);
    res.json(line ?? null);
  } catch (e) { next(e); }
});

// ── POST /hr/runs/:month/lines/status — paid / unpaid / on hold, many lines at once ──
//
// { person_ids:[…], status:'paid'|'pending'|'on_hold', reference?, paid_on?, reason? }, one transaction, one audit row
// per line that changes. 'pending' is what the screen calls Unpaid.
//   paid      a finalised run only (the payable is fixed only then): 409 RUN_NOT_FINAL otherwise. paid_amount =
//             payable, paid_on defaults to today at the plant, the reference is optional. The lines are grouped into
//             one payment_batches row per pay channel (a line with no channel is paid without a batch, as the per-line
//             route does). A line on hold, or with nothing to pay (payable below zero or not worked out), is skipped.
//   on_hold   any run status; the reason is required (400). Records held_by / held_at. A paid line is skipped: it must
//             be marked unpaid first. A line already on hold with a different reason takes the new reason (and held_by /
//             held_at), audited with the old one; with the same reason it is unchanged.
//   pending   releases a hold (and moves a failed or reversed line back to unpaid). Moving a PAID line back is for an
//             approver, with a reason: it clears paid_amount, paid_on, paid_ref and the batch link, and the audit row
//             keeps the old values. An operator asking for that gets 403 HR_LEVEL (and nothing changes).
// A line already in the target status is `unchanged`, not an error; a person with no line, or a line that cannot take
// the status, is in `skipped` with the reason. Nothing else refuses: warn, don't block.
const STATUS_TARGETS = ['paid', 'pending', 'on_hold'];

r.post('/hr/runs/:month/lines/status', requireHr('operator'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const body = bodyOf(req);
    const target = choiceOf(body.status, STATUS_TARGETS, 'status');
    const personIds = idListOf(body.person_ids, 'person_ids');
    if (!personIds || !personIds.length) throw bad('Choose at least one person');
    const reference = textOf(body.reference, 'The reference', 120);
    const reason = textOf(body.reason, 'The reason', 500);
    let paidOn = null;
    if (target === 'paid') {
      paidOn = dateOf(body.paid_on, 'The payment date') ?? plantDateStr();
      if (paidOn > plantDateStr()) throw bad('The payment date cannot be in the future');
    }
    if (target === 'on_hold' && !reason) throw bad('Say why the payment is on hold');
    const approver = levelAtLeast(req.hr?.level, 'approver');
    const userId = userIdOf(req);

    const out = await tx(async (qc) => {
      const run = await lockRunOf(qc, month);
      if (target === 'paid' && run.status !== 'finalised') {
        throw fail(409, `${monthLabel(month)} is ${run.status}: a line can be marked paid only once the month is finalised, `
          + 'because the amount payable is fixed only then. A line can be put on hold at any time', 'RUN_NOT_FINAL');
      }
      const lines = await qc(
        `SELECT id, person_id, pay_channel, payment_status, payable::text AS payable, paid_amount::text AS paid_amount,
                paid_on::text AS paid_on, paid_ref, payment_batch_id, hold_reason
           FROM hr.run_lines WHERE run_id = $1 AND person_id = ANY($2::int[])
          ORDER BY person_id
            FOR UPDATE`, [run.id, personIds]);
      const byPerson = new Map(lines.map((l) => [l.person_id, l]));
      const unchanged = [];
      const skipped = [];
      const moving = [];
      for (const id of personIds) {
        const line = byPerson.get(id);
        if (!line) { skipped.push({ person_id: id, reason: `No line for this person in ${monthLabel(month)}` }); continue; }
        // Holding a held line again with a different reason re-holds it (new reason, held_by, held_at; the old
        // reason is in the audit row); the same reason leaves it unchanged.
        if (line.payment_status === target && !(target === 'on_hold' && line.hold_reason !== reason)) {
          unchanged.push(id);
          continue;
        }
        if (target === 'paid') {
          if (line.payment_status === 'on_hold') {
            skipped.push({ person_id: id, reason: 'On hold: release the hold (mark it unpaid) before marking it paid' });
            continue;
          }
          const due = line.payable === null ? null : paiseOf(line.payable);
          if (due === null || due < 0n) { skipped.push({ person_id: id, reason: 'Nothing to pay on this line' }); continue; }
        }
        if (target === 'on_hold' && line.payment_status === 'paid') {
          skipped.push({ person_id: id, reason: 'Already paid: mark it unpaid first to put it on hold' });
          continue;
        }
        moving.push(line);
      }
      const undoPaid = target === 'pending' ? moving.filter((l) => l.payment_status === 'paid') : [];
      if (undoPaid.length && !approver) {
        throw fail(403, `Needs HR approver access to mark a paid line unpaid (${undoPaid.length === 1 ? '1 selected line is' : `${undoPaid.length} selected lines are`} `
          + 'already paid)', 'HR_LEVEL', { person_ids: undoPaid.map((l) => l.person_id) });
      }
      if (undoPaid.length && !reason) throw bad('Say why a paid line is being marked unpaid');

      const batches = [];
      if (target === 'paid' && moving.length) {
        const groups = new Map();
        for (const l of moving) {
          const k = l.pay_channel ?? null;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(l);
        }
        const keys = [...groups.keys()].sort((a, b) => (a === null) - (b === null) || (a < b ? -1 : a > b ? 1 : 0));
        for (const channel of keys) {
          const ids = groups.get(channel).map((l) => l.id);
          let batchId = null;
          if (channel !== null) {
            const [made] = await qc(
              `INSERT INTO hr.payment_batches (run_id, pay_channel, count, total, status, reference, paid_on,
                                               confirmed_by, confirmed_at, created_by)
               SELECT $1, $2, count(*), coalesce(sum(payable), 0), 'confirmed', $3, $4::date, $5, now(), $5
                 FROM hr.run_lines WHERE id = ANY($6::int[])
               RETURNING id, pay_channel, count, total::text AS total`, [run.id, channel, reference, paidOn, userId, ids]);
            batchId = made.id;
            const people = groups.get(channel).map((l) => l.person_id);
            batches.push({ id: made.id, pay_channel: channel, count: made.count, total: money(made.total), person_ids: people });
            await hrAudit(qc, req, 'payment_batch', made.id, 'create', {
              month, run_id: run.id, pay_channel: channel, count: made.count, total: money(made.total), reference, paid_on: paidOn,
              person_ids: people, via: 'lines/status',
            });
          }
          await qc(
            `UPDATE hr.run_lines
                SET payment_status = 'paid', payment_batch_id = $2, paid_amount = payable, paid_on = $3::date,
                    paid_at = now(), paid_ref = $4, status_note = $5
              WHERE id = ANY($1::int[])`, [ids, batchId, paidOn, reference, reason]);
        }
      } else if (target === 'on_hold' && moving.length) {
        await qc(
          `UPDATE hr.run_lines
              SET payment_status = 'on_hold', hold_reason = $2, held_by = $3, held_at = now(), status_note = $2
            WHERE id = ANY($1::int[])`, [moving.map((l) => l.id), reason, userId]);
      } else if (target === 'pending' && moving.length) {
        await qc(
          `UPDATE hr.run_lines
              SET payment_status = 'pending', paid_amount = NULL, paid_on = NULL, paid_at = NULL, paid_ref = NULL,
                  payment_batch_id = NULL, hold_reason = NULL, held_by = NULL, held_at = NULL, status_note = $2
            WHERE id = ANY($1::int[])`, [moving.map((l) => l.id), reason]);
      }

      for (const l of moving) {
        const detail = { month, run_id: run.id, person_id: l.person_id, from: l.payment_status, to: target, reason };
        if (target === 'paid') Object.assign(detail, { reference, paid_on: paidOn, paid_amount: money(l.payable) });
        if (l.payment_status === 'paid') {
          detail.was = {
            paid_amount: given(l.paid_amount) ? money(l.paid_amount) : null, paid_on: l.paid_on, paid_ref: l.paid_ref,
            payment_batch_id: l.payment_batch_id,
          };
        }
        if (l.payment_status === 'on_hold') detail.was_hold_reason = l.hold_reason;
        await hrAudit(qc, req, 'run_line', l.id, 'payment_status', detail);
      }
      return { changed: moving.map((l) => l.person_id), unchanged, skipped, batches };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── GET /hr/runs/:month/payslips?person_ids=1,2&channel=X ───────────────────

// Each loan's outstanding after the run. A finalised run is read as of its finalising: its own and earlier months'
// payroll recoveries, and every other txn entered before it was finalised, so a reprint months later shows what the
// slip showed then. A run not yet finalised has posted nothing, so it is today's balance less what the line
// recovers. A loan with nothing outstanding and nothing recovered this month is left off, and so is a loan issued
// after the run's month: the run reads balances as at its month end (hr/ledger.js), so that loan is not its business.
async function slipLoans(qx, run, lines) {
  const ids = lines.map((l) => l.person_id);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const loans = await qx(
    `SELECT id, loan_no, person_id, principal::text AS principal, instalment::text AS instalment, status
       FROM hr.loans WHERE person_id = ANY($1::int[]) AND status <> 'cancelled'
        AND issued_on < $2::date
      ORDER BY person_id, issued_on, id`, [ids, `${nextMonth(run.month)}-01`]);
  if (!loans.length) return out;
  const txns = await qx(
    `SELECT t.loan_id, t.kind, t.principal_amount::text AS principal_amount, t.run_id, r.month AS run_month, t.created_at
       FROM hr.loan_txns t LEFT JOIN hr.runs r ON r.id = t.run_id
      WHERE t.loan_id = ANY($1::int[])
      ORDER BY t.loan_id, t.id`, [loans.map((l) => l.id)]);
  const lineOf = new Map(lines.map((l) => [l.person_id, l]));
  const finalised = run.status === 'finalised' && run.finalised_at;
  const cutoff = finalised ? new Date(run.finalised_at).getTime() : null;
  for (const loan of loans) {
    const all = txns.filter((t) => t.loan_id === loan.id);
    let recovered;
    let outstanding;
    if (finalised) {
      const asOf = all.filter((t) => (t.kind === 'payroll_recovery'
        ? t.run_month <= run.month : new Date(t.created_at).getTime() <= cutoff));
      recovered = all.filter((t) => t.kind === 'payroll_recovery' && t.run_id === run.id)
        .reduce((sum, t) => sum + paiseOf(t.principal_amount), 0n);
      outstanding = paiseOf(loanOutstanding(loan, asOf));
    } else {
      const planned = (lineOf.get(loan.person_id)?.loan_recoveries ?? []).find((x) => x?.loan_id === loan.id);
      recovered = paiseOf(planned?.amount);
      outstanding = paiseOf(loanOutstanding(loan, all)) - recovered;
    }
    if (outstanding <= 0n && recovered === 0n) continue;
    out.get(loan.person_id).push({
      loan_id: loan.id, loan_no: loan.loan_no, principal: money(loan.principal), instalment: money(loan.instalment),
      recovered: fmtPaise(recovered), outstanding_after: fmtPaise(outstanding), status: loan.status,
    });
  }
  return out;
}

const SLIP_MONEY = ['daily_rate', 'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'gross',
  'misc_deduction', 'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions', 'paid_separately',
  'net_before_cap', 'net', 'rounding', 'payable', 'advance_given', 'carried_advance', 'paid_amount'];

r.get('/hr/runs/:month/payslips', requireHr('viewer'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const only = idListOf(req.query.person_ids, 'person_ids');
    if (req.query.channel !== undefined && typeof req.query.channel !== 'string') throw bad('channel must be one pay channel');
    const channel = typeof req.query.channel === 'string' ? optionalText(req.query.channel) : null;
    // The letterhead the tax invoice prints from: the house billing entity, else its fallback constants.
    const house = await billingEntity({}, one);
    const company = { name: house?.name ?? null, gstin: house?.gstin ?? null, address: house?.address ?? null };
    const [run] = await q(`SELECT * FROM hr.runs WHERE month = $1`, [month]);
    if (!run) return res.json({ company, run: null, slips: [] });

    const params = [run.id];
    let filter = '';
    if (only) { params.push(only); filter += ` AND l.person_id = ANY($${params.length}::int[])`; }
    if (channel) { params.push(channel); filter += ` AND l.pay_channel = $${params.length}`; }
    const lines = await q(
      `SELECT l.person_id, l.pay_channel, l.days::text AS days, l.present_days::text AS present_days,
              l.days_not_employed::text AS days_not_employed, ${SLIP_MONEY.map((c) => `l.${c}::text AS ${c}`).join(', ')},
              l.breakdown, l.flags, l.unrecovered, l.loan_recoveries, l.payment_status, l.paid_on::text AS paid_on, l.paid_ref,
              p.code, p.name, p.display_name, p.father_name, p.department, p.designation, p.joined_on::text AS joined_on,
              p.bank_name, NULLIF(right(regexp_replace(COALESCE(p.bank_account, ''), '[^0-9]', '', 'g'), 4), '') AS bank_last4,
              c.label AS pay_channel_label, c.kind AS pay_channel_kind
         FROM hr.run_lines l
         JOIN hr.people p ON p.id = l.person_id
         LEFT JOIN hr.pay_channels c ON c.code = l.pay_channel
        WHERE l.run_id = $1${filter}
        ORDER BY lower(coalesce(p.department, '')), lower(p.name), p.id`, params);
    const loans = await slipLoans(q, run, lines);
    const m = (v) => (given(v) ? money(v) : null);
    const slips = lines.map((l) => {
      const unrecovered = l.unrecovered && typeof l.unrecovered === 'object' ? l.unrecovered : {};
      const loansShort = (Array.isArray(unrecovered.loans) ? unrecovered.loans : []).reduce((t, x) => t + paiseOf(x?.amount), 0n);
      const short = paiseOf(unrecovered.advance) + loansShort + paiseOf(unrecovered.other);
      return {
        person: {
          id: l.person_id, code: l.code, name: l.name, display_name: l.display_name, father_name: l.father_name,
          department: l.department, designation: l.designation, joined_on: l.joined_on,
          pay_channel: l.pay_channel, pay_channel_label: l.pay_channel_label, pay_channel_kind: l.pay_channel_kind,
          bank_name: l.bank_name, bank_last4: l.pay_channel_kind === 'bank' ? l.bank_last4 : null,
        },
        days: { days: l.days, present_days: l.present_days, days_not_employed: l.days_not_employed },
        components: Array.isArray(l.breakdown) ? l.breakdown : [],
        totals: {
          daily_rate: m(l.daily_rate), gross: m(l.gross), total_deductions: m(l.total_deductions), net: m(l.net),
          paid_separately: m(l.paid_separately), rounding: m(l.rounding), payable: m(l.payable),
          net_before_cap: m(l.net_before_cap),
        },
        loans: loans.get(l.person_id) ?? [],
        advance: { given: m(l.advance_given), recovered: m(l.advance_recovery), balance_after: m(l.carried_advance) },
        insufficient_pay: short > 0n ? {
          advance: money(unrecovered.advance), loans: fmtPaise(loansShort), other: money(unrecovered.other), total: fmtPaise(short),
        } : null,
        flags: Array.isArray(l.flags) ? l.flags : [],
        payment: {
          status: l.payment_status, paid_on: l.paid_on, paid_ref: l.paid_ref, reference: l.paid_ref, paid_amount: m(l.paid_amount),
        },
      };
    });
    res.json({ company, run: await runView(q, run), slips });
  } catch (e) { next(e); }
});

// ── GET /hr/runs/:month/variance (spec §12) ─────────────────────────────────

// Each line of the month against the same person's line in their latest finalised month before it. The change in
// payable is split into parts, each signed as it moves pay (a bigger recovery is a negative part):
//   revision    a new pay setup's base: Δbase × (this month's basic ÷ its base); all of Δbasic when the basis changed
//   attendance  the rest of Δbasic, when days moved (paid days or hours, days in the month, days not employed) or
//               the setup changed; with neither, a basic that moved is left unexplained
//   ot, holiday, misc       the change in that earning
//   advance, loan           minus the change in that recovery
//   other       bonus, earning adjustments, a contractor's bill, less misc and adjustment deductions, paid
//               separately and the rounding line
// unexplained is whatever of the change the parts do not cover (a basic that moved for no reason, the floor of a
// payable that paid separately took below 0, stored figures that do not add up). A person with no earlier finalised
// line has nothing to compare with: previous_month, change, parts and unexplained are null.
const VARIANCE_COLS = ['basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'misc_deduction',
  'adj_deductions', 'loan_recovery', 'advance_recovery', 'paid_separately', 'rounding', 'payable'];
const VARIANCE_SELECT = `l.person_id, l.pay_setup_id, l.days::text AS days, l.days_not_employed::text AS days_not_employed,
  l.breakdown, ${VARIANCE_COLS.map((c) => `l.${c}::text AS ${c}`).join(', ')}`;

const basicQty = (line) => {
  const c = (Array.isArray(line.breakdown) ? line.breakdown : []).find((x) => x?.code === 'BASIC' || x?.code === 'BILL');
  return given(c?.qty) ? String(c.qty) : null;
};
const sameQty = (a, b) => {
  if (!given(a) || !given(b)) return !given(a) && !given(b);
  try { return cmp(rat(a), rat(b)) === 0; } catch { return a === b; }
};

function varianceOf(now, prev, setups) {
  const d = (c) => paiseOf(now[c]) - paiseOf(prev[c]);
  const dBasic = d('basic');
  const sNow = setups.get(now.pay_setup_id) ?? null;
  const sPrev = setups.get(prev.pay_setup_id) ?? null;
  const setupChanged = now.pay_setup_id !== prev.pay_setup_id;
  const contract = sNow?.pay_basis === 'contract' && sPrev?.pay_basis === 'contract';
  let revision = 0n;
  let attendance = 0n;
  let bill = 0n;
  if (contract) {
    bill = dBasic;                                   // a contractor's basic is the month's bill
  } else {
    if (setupChanged) {
      const baseNow = given(sNow?.base) ? rat(sNow.base) : null;
      const basePrev = given(sPrev?.base) ? rat(sPrev.base) : null;
      if (!sNow || !sPrev || sNow.pay_basis !== sPrev.pay_basis || !baseNow || !basePrev || isZero(baseNow)) {
        revision = dBasic;
      } else {
        revision = toPaise(mul(sub(baseNow, basePrev), div(rat(now.basic ?? '0'), baseNow)));
      }
    }
    const daysMoved = !sameQty(basicQty(now), basicQty(prev)) || !sameQty(now.days, prev.days)
      || !sameQty(now.days_not_employed, prev.days_not_employed);
    if (setupChanged || daysMoved) attendance = dBasic - revision;
  }
  const parts = {
    revision,
    attendance,
    ot: d('ot_amount'),
    holiday: d('holiday_amount'),
    misc: d('misc_earning'),
    advance: -d('advance_recovery'),
    loan: -d('loan_recovery'),
    other: bill + d('bonus') + d('adj_earnings') - d('misc_deduction') - d('adj_deductions') - d('paid_separately') + d('rounding'),
  };
  const change = d('payable');
  const explained = Object.values(parts).reduce((t, v) => t + v, 0n);
  return {
    change: fmtPaise(change),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, fmtPaise(v)])),
    unexplained: fmtPaise(change - explained),
  };
}

r.get('/hr/runs/:month/variance', requireHr('viewer'), async (req, res, next) => {
  try {
    const month = monthOf(req.params.month);
    const [run] = await q(`SELECT id FROM hr.runs WHERE month = $1`, [month]);
    if (!run) return res.json([]);
    const lines = await q(
      `SELECT ${VARIANCE_SELECT}, p.code, p.name
         FROM hr.run_lines l JOIN hr.people p ON p.id = l.person_id
        WHERE l.run_id = $1 ORDER BY l.person_id`, [run.id]);
    if (!lines.length) return res.json([]);
    const previous = await q(
      `SELECT DISTINCT ON (l.person_id) ${VARIANCE_SELECT}, r.month
         FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id
        WHERE r.status = 'finalised' AND r.month < $1 AND l.person_id = ANY($2::int[])
        ORDER BY l.person_id, r.month DESC`, [month, lines.map((l) => l.person_id)]);
    const prevOf = new Map(previous.map((l) => [l.person_id, l]));
    const setupIds = [...new Set([...lines, ...previous].map((l) => l.pay_setup_id).filter(given))];
    const setups = new Map(setupIds.length ? (await q(
      `SELECT id, pay_basis, base::text AS base FROM hr.pay_setups WHERE id = ANY($1::int[])`, [setupIds]))
      .map((s) => [s.id, s]) : []);
    res.json(lines.map((now) => {
      const prev = prevOf.get(now.person_id);
      const base = {
        person_id: now.person_id, code: now.code, name: now.name, month,
        payable: money(now.payable), previous_month: prev?.month ?? null, previous_payable: prev ? money(prev.payable) : null,
      };
      if (!prev) return { ...base, change: null, parts: null, unexplained: null };
      return { ...base, ...varianceOf(now, prev, setups) };
    }));
  } catch (e) { next(e); }
});

export default r;
