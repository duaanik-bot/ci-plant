// ─── HR & Payroll: loans, advances, adjustments, and the one-time load from the salary workbook ───
// Spec docs/superpowers/specs/2026-10-16-hr-payroll-design.md §7 (adjustments), §10 (advances), §11 (loans) and
// §15 (loading from the workbook). People, pay setups, settings and access are routes/hr.js; payroll runs,
// imports and payments are routes/hr-payroll.js. All of them sit under the same /api/hr.
//
// PRIVATE. Every route is behind r.use('/hr', hrGuard) (a row in hr.access, read fresh on every request, never
// from the JWT) and states its own minimum level with requireHr(...). Every response is no-store and every GET
// is marked uncacheable, so neither the browser nor the ERP's table-keyed cache can hold anyone's balances.
//
//   viewer    GET  /hr/loans · /hr/loans/:id · /hr/advances · /hr/advances/:personId · /hr/adjustments
//             GET  /hr/people/:id/ledger
//   operator  POST /hr/loans · /hr/loans/:id/prepay · /holiday · /cancel      PUT /hr/loans/:id/instalment
//             POST /hr/advances · /hr/adjustments · /hr/adjustments/:id/cancel · /hr/staff-payments
//   approver  POST /hr/advances/:personId/waive · /hr/adjustments/:id/approve
//   admin     POST /hr/loader/preview · /hr/loader/apply
//
// What a response carries
//   * Stored money (a loan's principal and instalment, an adjustment's amount) is the number pg gives for
//     NUMERIC, as routes/hr.js sends it. What a ledger works out (outstanding, due, a running balance, an
//     advance balance, every schedule figure) is an exact 2-dp string from hr/loans.js and hr/ledger.js, and a
//     ledger row's own amount is read as text. The client formats both with inr2.
//   * Dates are 'YYYY-MM-DD' text, months 'YYYY-MM' text (loans.js is strict about both).
//   * A loan carries outstanding, due_this_month and its next due month; a balance is never stored.
//
// Writes
//   * Each runs in tx() and leaves its row in hr.audit_log through hrAudit(qc, req, ...), in the same
//     transaction. Inside tx() only qc / oc are used: a pool call would wait on itself on Vercel's one-client
//     pool. Responses that re-read the row do so after the transaction has ended.
//   * Document numbers: a loan is CI-LN-0001, minted by nextNumber() as the FIRST statement of its
//     transaction, before any row lock (helpers.js document-number lock order). POST /hr/loans, POST
//     /hr/staff-payments (a loan) and POST /hr/loader/apply (opening loans) mint, so all three are in
//     client/src/lib/writeOnce.js MINTING_POSTS.
//   * Locks. A payroll finalise locks the run's people rows, then their loans (FOR UPDATE, ascending id), and
//     only then reads the balances it recovers from (hr/runs.js). Everything here that reduces a balance
//     (prepay, waive) or changes what a recovery takes (instalment, holiday, cancel) takes the same two locks
//     first, for the one person, so a finalise and one of these cannot both pass their checks against the same
//     balance. Giving an advance or creating a loan only adds, so it needs no lock beyond the foreign keys'.
//   * A refusal is thrown as an Error with .status and .body = {code}: app.js sends {error, ...body} and nothing
//     else. A plain 400 / 404 carries no code. Structured bodies are plain consts below.
//
// Loans (spec §11)
//   * Interest is stored but must be 0: anything else is 400 INTEREST_NOT_YET.
//   * Prepayment is at most what is outstanding, and one that brings it to 0 closes the loan (status 'closed').
//   * A repayment holiday is this plant month or later. Asking twice for the same month is the same holiday.
//   * An instalment change is audited with the old value. The schema keeps ONE instalment per loan, so the new
//     value is what every payroll not yet finalised takes: from_month is audited, and a warning comes back when
//     it is later than the first payroll that could use it.
//   * Cancel only while nothing has been taken back (no payroll recovery, no prepayment). The loan's balance is
//     reversed by an adjustment row so a cancelled loan reads 0.00 everywhere.
//
// Advances (spec §10). The app's "Give advance" posts 'given' with source 'manual' straight away (payroll's
// netting of the sheet's ADVANCE column counts exactly that source). A waiver is approver only, at most the
// balance, source 'waiver'. The loader's opening balances carry source 'loader'.
//
// Adjustments (spec §7). Recurring needs a start and an end month, one-time a single month in start_month.
// Approve and cancel are audited; neither is possible once payroll for every month the adjustment covers is
// finalised (the correction then belongs to the next open month).
//
// Loading from the workbook (spec §15, admin). Preview reads the file with parseSalaryWorkbook and answers what
// the load screen shows, plus a diff against the people already in HR (by code: new / changed / same). Nothing
// is written. The full account numbers stay on the server: a person carries bank_last4 only. Apply takes the
// same file and a `decisions` JSON field {skip:[code], edits:{code:{...}}}, refuses while the parse has an error
// issue (or no month), or while an opening loan has no instalment above 0 after the edits, and then does it all
// in ONE transaction: pay channels (a label becomes a channel through normName, so 'Cash' and 'CASH' are one),
// people by code, pay setups from the month after the workbook's, opening loans, opening advances, one audit
// row with the counts. The load is meant to run once. Run again, it never doubles a balance: a person who
// already has a loan gets no opening loan, one who already has any advance row gets no opening advance, and a
// pay setup that matches the one in force (or whose date is taken) is not added. The preview says so in the
// loan's review notes. Names are written under lockNames() and checked with assertNameFree() (hr/names.js).
import { Router } from 'express';
import multer from 'multer';
import { q, tx } from '../db.js';
import { markUncacheable } from '../data-tables.js';
import { lockDocNumber, nextNumber, optionalText } from '../helpers.js';
import { plantDateStr } from '../plant-calendar.js';
import { hrGuard, requireHr } from '../hr/access.js';
import { hrAudit } from '../hr/audit.js';
import { effectiveSetup } from '../hr/engine.js';
import { advanceBalances } from '../hr/ledger.js';
import { dueForMonth, loanOutstanding, nextMonth, projectSchedule } from '../hr/loans.js';
import { normCode, normName } from '../hr/match.js';
import { add, cmp, div, fmtPaise, isNeg, isZero, neg, rat, sub, toPaise } from '../hr/money.js';
import { assertNameFree, lockNames } from '../hr/names.js';
import { parseSalaryWorkbook } from '../hr/workbook-loader.js';

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
const LOAN_STATUSES = ['active', 'closed', 'cancelled'];
const ADJUSTMENT_KINDS = ['earning', 'deduction'];
const RECURRENCES = ['one_time', 'recurring'];
const ADJUSTMENT_STATUSES = ['pending', 'approved', 'cancelled'];
const WORKER_TYPES = ['employee', 'contractor'];
const PAY_BASES = ['monthly', 'daily', 'hourly', 'contract'];
const HOLIDAY_MODES = ['none', 'formula', 'fixed'];

// The advance ledger's sources. Payroll's netting counts 'given' rows with exactly MANUAL (hr/ledger.js).
const MANUAL = 'manual';
const WAIVER = 'waiver';
const LOADER = 'loader';

// How each advance row moves the balance (spec §10), as hr/ledger.js reads it. A Map, so a kind such as
// 'toString' is unknown rather than found on a prototype.
const ADVANCE_SIGN = new Map([['opening', 1], ['given', 1], ['adjustment', 1], ['recovered', -1], ['waived', -1]]);

// Structured refusal bodies. A refusal is { status, body }: app.js spreads body into the answer.
const INTEREST_NOT_YET = Object.freeze({ code: 'INTEREST_NOT_YET' });
const LOAN_NOT_ACTIVE = Object.freeze({ code: 'LOAN_NOT_ACTIVE' });
const LOAN_HAS_RECOVERIES = Object.freeze({ code: 'LOAN_HAS_RECOVERIES' });
const LOAN_NUMBER_TAKEN = Object.freeze({ code: 'LOAN_NUMBER_TAKEN' });
const ADJUSTMENT_STATE = Object.freeze({ code: 'ADJUSTMENT_STATE' });
const ADJUSTMENT_FINALISED = Object.freeze({ code: 'ADJUSTMENT_FINALISED' });
const WORKBOOK_ERRORS = Object.freeze({ code: 'WORKBOOK_ERRORS' });
const INSTALMENT_NEEDED = Object.freeze({ code: 'INSTALMENT_NEEDED' });
const CODE_EXISTS = Object.freeze({ code: 'CODE_EXISTS' });
const SETUP_EXISTS = Object.freeze({ code: 'SETUP_EXISTS' });
const UNKNOWN_PAY_CHANNEL = Object.freeze({ code: 'UNKNOWN_PAY_CHANNEL' });

const refuse = (status, message, body = {}) => Object.assign(new Error(message), { status, body });
const bad = (message) => refuse(400, message);
const missing = (what) => refuse(404, `${what} not found`);

// The unique violations a race can still raise, as the refusals the checks give; and the few value errors a
// validator could not see, as a 400 instead of a 500. Anything else passes through.
const UNIQUE_REFUSALS = new Map([
  ['loans_loan_no_key', () => refuse(409, 'Another loan was saved with that number at the same moment. Try again', LOAN_NUMBER_TAKEN)],
  ['people_code_key', () => refuse(409, 'Another person already has this payroll code', CODE_EXISTS)],
  ['pay_setups_person_id_effective_from_key', () => refuse(409, 'This person already has a pay setup from that month', SETUP_EXISTS)],
]);
const VALUE_ERRORS = new Map([
  ['23514', 'One of the values is outside what is allowed'],
  ['23503', 'One of the values points at something that does not exist'],
  ['22003', 'A number is too large'],
  ['22P02', 'One of the values is not in the right form'],
  ['22007', 'One of the dates is not valid'],
  ['22008', 'One of the dates is not valid'],
]);
function refusal(e) {
  if (e?.code === '23505' && UNIQUE_REFUSALS.has(e.constraint)) return UNIQUE_REFUSALS.get(e.constraint)();
  if (VALUE_ERRORS.has(e?.code)) return bad(VALUE_ERRORS.get(e.code));
  return e;
}

function bodyOf(req) {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Send a JSON object');
  return body;
}

// A row id from a path: digits, within int4. Anything else cannot be a row.
function idOf(raw, what) {
  const id = typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id > INT4_MAX) throw missing(what);
  return id;
}

// A person id sent in a body or a query: a number or digits.
function personIdOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const id = typeof text === 'number' ? text : typeof text === 'string' && /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) throw bad('Choose the person');
  return id;
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();
const clip = (text, max = 160) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const plantMonth = () => plantDateStr().slice(0, 7);
const money = (value) => fmtPaise(toPaise(rat(value)));                  // an exact amount as '1500.00'
const blank = (raw) => raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');

// The last day of a 'YYYY-MM' month, as 'YYYY-MM-DD'.
function lastDayOf(month) {
  const [year, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// Optional text: null when absent or blank (optionalText also refuses the strings 'undefined' and 'null').
function textOf(raw, label, max, tidy = false) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(`${label} must be text`);
  const text = optionalText(tidy ? squash(raw) : raw);
  if (text !== null && text.length > max) throw bad(`${label} is too long (at most ${max} characters)`);
  return text;
}

// Required text.
function requiredText(raw, label, max) {
  const text = textOf(raw, label, max, true);
  if (text === null) throw bad(`${label} is required`);
  return text;
}

// A calendar date as typed, 'YYYY-MM-DD', or null when absent.
function dateOf(raw, label) {
  if (blank(raw)) return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const last = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!m || year < 1900 || day < 1 || day > last) throw bad(`${label} must be a date like 2026-07-15`);
  return text;
}

// A month, 'YYYY-MM'.
function monthOf(raw, label) {
  if (blank(raw)) throw bad(`${label} is required`);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!MONTH.test(text)) throw bad(`${label} must be a month like 2026-08`);
  return text;
}

// A plain non-negative decimal as exact text, or null when absent. Never a float: '20150.50' goes to the
// database as typed. More decimals than the column keeps are refused, not rounded. Money columns keep 2
// decimals, quantities 4; both fit 10 whole digits.
const PLAIN_NUMBER = /^(\d+)(?:\.(\d+))?$/;
function amountOf(raw, label, places) {
  if (blank(raw)) return null;
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

// An amount that must be there and be more than 0.
function positiveOf(raw, label) {
  const text = amountOf(raw, label, 2);
  if (text === null) throw bad(`${label} is required`);
  if (isZero(rat(text))) throw bad(`${label} must be more than 0`);
  return text;
}

function flagOf(raw, label, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  throw bad(`${label} must be true or false`);
}

// One of `allowed`; `fallback` stands in for a blank value where there is a default.
function choiceOf(raw, allowed, label, fallback) {
  if (blank(raw)) {
    if (fallback !== undefined) return fallback;
    throw bad(`Choose ${label}`);
  }
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  throw bad(`${label} must be one of ${allowed.join(', ')}`);
}

// ?status= : nothing means every status; otherwise one status or a comma list of them.
function listOf(raw, allowed, label) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw bad(`${label} must be one value or a comma list of them`);
  const wanted = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = wanted.filter((s) => !allowed.includes(s));
  if (unknown.length) throw bad(`Unknown ${label}: ${unknown.join(', ')}`);
  return wanted.length ? wanted : null;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row[key]);
    if (list) list.push(row);
    else out.set(row[key], [row]);
  }
  return out;
}

// ── The locks (finalise's order) ────────────────────────────────────────────

// The person's row, then the person's loans, ascending id: exactly what hr/runs.js finaliseRun takes, in that
// order, before it reads a balance. Taken before the balance is read, by everything that reduces one.
async function lockHolder(qc, personId) {
  await qc(`SELECT id FROM hr.people WHERE id = $1 FOR UPDATE`, [personId]);
  await qc(`SELECT id FROM hr.loans WHERE person_id = $1 ORDER BY id FOR UPDATE`, [personId]);
}

// ── Loans: reading ──────────────────────────────────────────────────────────

const LOAN_FROM = `FROM hr.loans l JOIN hr.people p ON p.id = l.person_id`;
const LOAN_COLS = `l.id, l.loan_no, l.person_id, p.code AS person_code, p.name AS person_name, l.principal,
  l.issued_on::text AS issued_on, l.purpose, l.interest_rate, l.instalment, l.first_due_month, l.paid_via, l.status,
  l.is_opening, l.approved_by, l.approved_at, l.note, l.created_by, l.created_at`;

// A loan's ledger, oldest first, with the month of the run behind a payroll recovery (loans.js needs run_month).
// Amounts are read as text: exact, never the JS number pg makes of NUMERIC.
const LOAN_TXNS = `SELECT t.id, t.loan_id, t.txn_date::text AS txn_date, t.kind, t.principal_amount::text AS principal_amount,
    t.interest_amount::text AS interest_amount, t.run_id, r.month AS run_month, t.note, t.created_by, t.created_at
  FROM hr.loan_txns t LEFT JOIN hr.runs r ON r.id = t.run_id
 WHERE t.loan_id = ANY($1::int[])
 ORDER BY t.loan_id, t.txn_date, t.id`;
const LOAN_HOLIDAYS = `SELECT loan_id, month FROM hr.loan_holidays WHERE loan_id = ANY($1::int[]) ORDER BY loan_id, month`;

// The month and amount of the next instalment: the first month of the loan's own timeline still to be taken.
// A row that makes loans.js throw must not take the register down, so it just has none.
function nextDue(loan, txns, holidays) {
  try {
    const row = projectSchedule(loan, txns, holidays, loan.first_due_month).find((s) => s.status === 'projected');
    return row ? { next_due_month: row.month, next_due: row.due } : { next_due_month: null, next_due: null };
  } catch {
    return { next_due_month: null, next_due: null };
  }
}

// Loan rows with what the ledger says of each: outstanding, what is due in the plant's current month, and the
// next due month. `read` is the pool's q, or a transaction's qc.
async function loanViews(read, rows) {
  if (!rows.length) return [];
  const ids = rows.map((l) => l.id);
  const txns = groupBy(await read(LOAN_TXNS, [ids]), 'loan_id');
  const holidays = groupBy(await read(LOAN_HOLIDAYS, [ids]), 'loan_id');
  const month = plantMonth();
  return rows.map((loan) => {
    const mine = txns.get(loan.id) ?? [];
    const skip = (holidays.get(loan.id) ?? []).map((h) => h.month);
    const now = dueForMonth(loan, mine, skip, month);
    return { ...loan, outstanding: now.outstanding, due_this_month: now.due, ...nextDue(loan, mine, skip) };
  });
}

async function loanView(id) {
  const [row] = await q(`SELECT ${LOAN_COLS} ${LOAN_FROM} WHERE l.id = $1`, [id]);
  return (await loanViews(q, [row]))[0];
}

// Each ledger row with the balance after it (an exact string), in the order they are listed.
function withBalances(loan, txns) {
  return txns.map((t, i) => ({ ...t, balance: loanOutstanding(loan, txns.slice(0, i + 1)) }));
}

// The loan locked in finalise's order (the person's row, the person's loans), then read fresh.
async function lockedLoan(qc, oc, id) {
  const peek = await oc(`SELECT person_id FROM hr.loans WHERE id = $1`, [id]);
  if (!peek) throw missing('Loan');
  await lockHolder(qc, peek.person_id);
  return oc(`SELECT ${LOAN_COLS} ${LOAN_FROM} WHERE l.id = $1`, [id]);
}

function mustBeActive(loan) {
  if (loan.status !== 'active') throw refuse(409, `${loan.loan_no} is ${loan.status}, so it cannot be changed`, LOAN_NOT_ACTIVE);
}

r.get('/hr/loans', requireHr('viewer'), async (req, res, next) => {
  try {
    const statuses = listOf(req.query.status, LOAN_STATUSES, 'status');
    const person = blank(req.query.person_id) ? null : personIdOf(req.query.person_id);
    const rows = await q(
      `SELECT ${LOAN_COLS} ${LOAN_FROM}
        WHERE ($1::text[] IS NULL OR l.status = ANY($1::text[])) AND ($2::int IS NULL OR l.person_id = $2::int)
        ORDER BY l.issued_on DESC, l.id DESC`,
      [statuses, person]);
    res.json(await loanViews(q, rows));
  } catch (e) { next(e); }
});

// The loan with its ledger (a running balance on every row), its repayment holidays, and the whole schedule:
// past months from what payroll really took, future months projected from what is outstanding (loans.js).
r.get('/hr/loans/:id', requireHr('viewer'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Loan');
    const [row] = await q(`SELECT ${LOAN_COLS} ${LOAN_FROM} WHERE l.id = $1`, [id]);
    if (!row) throw missing('Loan');
    const txns = await q(LOAN_TXNS, [[id]]);
    const holidays = (await q(LOAN_HOLIDAYS, [[id]])).map((h) => h.month);
    const [loan] = await loanViews(q, [row]);
    res.json({
      loan,
      txns: withBalances(row, txns),
      holidays,
      schedule: projectSchedule(row, txns, holidays, row.first_due_month),
    });
  } catch (e) { next(e); }
});

// ── Loans: creating ─────────────────────────────────────────────────────────

// Interest is stored but must be 0 in Phase 1 (spec §11). The loan form has no field for it; anything but zero
// in `interest_rate` (or `interest`) is refused by name rather than dropped.
function rejectInterest(body) {
  for (const key of ['interest_rate', 'interest']) {
    const raw = body[key];
    if (blank(raw)) continue;
    const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) throw bad('The interest rate must be a number');
    if (!isZero(rat(text))) throw refuse(400, 'Loans are interest-free for now. Leave the interest rate at 0', INTEREST_NOT_YET);
  }
}

function readNewLoan(body) {
  rejectInterest(body);
  const personId = personIdOf(body.person_id);
  const principal = positiveOf(body.principal, 'The loan amount');
  const issuedOn = dateOf(body.issued_on, 'The issue date');
  if (issuedOn === null) throw bad('The issue date is required');
  const instalment = positiveOf(body.instalment, 'The instalment');
  const firstDue = monthOf(body.first_due_month, 'The first month an instalment is due');
  if (firstDue < issuedOn.slice(0, 7)) throw bad('The first instalment cannot fall due before the month the loan was issued');
  return {
    personId,
    principal,
    issuedOn,
    purpose: textOf(body.purpose, 'The purpose', 200, true),
    instalment,
    firstDue,
    paidVia: textOf(body.paid_via, 'How it was paid out', 80, true),
    isOpening: flagOf(body.is_opening, 'Opening loan', false),
    note: textOf(body.note, 'The note', 500),
  };
}

// Mints the next loan number and writes the loan with its first ledger row: the disbursement, or the opening
// balance. The number comes FIRST, before anything that could lock a row. The caller audits.
async function insertLoan(qc, oc, req, loan) {
  const loanNo = await nextNumber('CI-LN-', 'hr.loans', 'loan_no', oc);
  if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [loan.personId]))) throw bad('That person does not exist');
  const made = await oc(
    `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, purpose, interest_rate, instalment, first_due_month,
                           paid_via, is_opening, note, created_by)
     VALUES ($1, $2, $3, $4::date, $5, 0, $6, $7, $8, $9, $10, $11)
     RETURNING id, loan_no`,
    [loanNo, loan.personId, loan.principal, loan.issuedOn, loan.purpose, loan.instalment, loan.firstDue,
      loan.paidVia, loan.isOpening, loan.note, req.user.id]);
  const first = loan.isOpening ? 'opening' : 'disbursed';
  const why = loan.isOpening ? 'Opening balance' : loan.paidVia ? `Paid out via ${loan.paidVia}` : 'Loan issued';
  await qc(
    `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by)
     VALUES ($1, $2::date, $3, $4, $5, $6)`,
    [made.id, loan.issuedOn, first, loan.principal, why, req.user.id]);
  return made;
}

r.post('/hr/loans', requireHr('operator'), async (req, res, next) => {
  try {
    const loan = readNewLoan(bodyOf(req));
    const id = await tx(async (qc, oc) => {
      const made = await insertLoan(qc, oc, req, loan);
      await hrAudit(qc, req, 'loan', made.id, 'create', {
        loan_no: made.loan_no,
        person_id: loan.personId,
        principal: money(loan.principal),
        instalment: money(loan.instalment),
        first_due_month: loan.firstDue,
        issued_on: loan.issuedOn,
        is_opening: loan.isOpening,
      });
      return made.id;
    });
    res.json(await loanView(id));
  } catch (e) { next(refusal(e)); }
});

// ── Loans: changing ─────────────────────────────────────────────────────────

// Taking money back before payroll does: at most what is outstanding. A prepayment that brings the loan to 0
// closes it, as a finalise that pays it off does.
r.post('/hr/loans/:id/prepay', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Loan');
    const body = bodyOf(req);
    const amount = positiveOf(body.amount, 'The prepayment');
    const date = dateOf(body.date, 'The prepayment date') ?? plantDateStr();
    const note = textOf(body.note, 'The note', 500);
    await tx(async (qc, oc) => {
      const loan = await lockedLoan(qc, oc, id);
      mustBeActive(loan);
      const owed = loanOutstanding(loan, await qc(LOAN_TXNS, [[id]]));
      if (cmp(rat(amount), rat(owed)) > 0) {
        throw bad(`The prepayment (${money(amount)}) is more than the ${owed} still owed on ${loan.loan_no}`);
      }
      await qc(
        `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by)
         VALUES ($1, $2::date, 'prepayment', $3, $4, $5)`,
        [id, date, amount, note ?? 'Prepayment', req.user.id]);
      const left = loanOutstanding(loan, await qc(LOAN_TXNS, [[id]]));
      await hrAudit(qc, req, 'loan', id, 'prepay', {
        loan_no: loan.loan_no, amount: money(amount), date, outstanding_before: owed, outstanding_after: left,
      });
      if (isZero(rat(left))) {
        await qc(`UPDATE hr.loans SET status = 'closed' WHERE id = $1`, [id]);
        await hrAudit(qc, req, 'loan', id, 'close', { loan_no: loan.loan_no, reason: 'prepaid in full' });
      }
    });
    res.json(await loanView(id));
  } catch (e) { next(refusal(e)); }
});

// A month in which no instalment is due. This plant month or later.
r.post('/hr/loans/:id/holiday', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Loan');
    const body = bodyOf(req);
    const month = monthOf(body.month, 'The holiday month');
    const now = plantMonth();
    if (month < now) throw bad(`A repayment holiday must be ${now} or later: ${month} is in the past`);
    const note = textOf(body.note, 'The note', 200);
    await tx(async (qc, oc) => {
      const loan = await lockedLoan(qc, oc, id);
      mustBeActive(loan);
      const made = await oc(
        `INSERT INTO hr.loan_holidays (loan_id, month, note, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (loan_id, month) DO NOTHING RETURNING id`,
        [id, month, note, req.user.id]);
      if (made) await hrAudit(qc, req, 'loan', id, 'holiday', { loan_no: loan.loan_no, month });
    });
    res.json(await loanView(id));
  } catch (e) { next(refusal(e)); }
});

// One instalment per loan, so the new value is what every payroll not yet finalised takes. from_month is
// audited with the old value; a warning comes back when it is later than the first payroll that could use it.
r.put('/hr/loans/:id/instalment', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Loan');
    const body = bodyOf(req);
    const instalment = positiveOf(body.instalment, 'The instalment');
    const fromMonth = monthOf(body.from_month, 'The month the change starts from');
    let warning = null;
    await tx(async (qc, oc) => {
      const loan = await lockedLoan(qc, oc, id);
      mustBeActive(loan);
      const was = money(loan.instalment);
      if (cmp(rat(instalment), rat(was)) === 0) return;
      await qc(`UPDATE hr.loans SET instalment = $2 WHERE id = $1`, [id, instalment]);
      await hrAudit(qc, req, 'loan', id, 'instalment', {
        loan_no: loan.loan_no, field: 'instalment', from_month: fromMonth, from: was, to: money(instalment),
      });
      const latest = await oc(`SELECT max(month) AS month FROM hr.runs WHERE status = 'finalised'`);
      const open = latest?.month ? nextMonth(latest.month) : plantMonth();
      const first = open > loan.first_due_month ? open : loan.first_due_month;
      if (fromMonth > first) {
        warning = `The new instalment is taken by every payroll not yet finalised, starting with ${first}, `
          + `not only from ${fromMonth}. Change it again in ${fromMonth} if it should start then`;
      }
    });
    const view = await loanView(id);
    res.json(warning ? { ...view, warning } : view);
  } catch (e) { next(refusal(e)); }
});

// Only while nothing has been taken back: no payroll recovery and no prepayment. What was lent is then
// reversed by an adjustment row, so a cancelled loan reads 0.00 wherever it is summed.
r.post('/hr/loans/:id/cancel', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Loan');
    await tx(async (qc, oc) => {
      const loan = await lockedLoan(qc, oc, id);
      mustBeActive(loan);
      const txns = await qc(LOAN_TXNS, [[id]]);
      if (txns.some((t) => t.kind === 'payroll_recovery' || t.kind === 'prepayment')) {
        throw refuse(409, `${loan.loan_no} cannot be cancelled: money has already been taken back against it`, LOAN_HAS_RECOVERIES);
      }
      const owed = loanOutstanding(loan, txns);
      if (!isZero(rat(owed))) {
        await qc(
          `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by)
           VALUES ($1, $2::date, 'adjustment', $3, 'Loan cancelled', $4)`,
          [id, plantDateStr(), money(neg(rat(owed))), req.user.id]);
      }
      await qc(`UPDATE hr.loans SET status = 'cancelled' WHERE id = $1`, [id]);
      await hrAudit(qc, req, 'loan', id, 'cancel', { loan_no: loan.loan_no, reversed: owed });
    });
    res.json(await loanView(id));
  } catch (e) { next(refusal(e)); }
});

// ── Advances ────────────────────────────────────────────────────────────────

const ADVANCE_TXNS = `SELECT t.id, t.person_id, t.txn_date::text AS txn_date, t.kind, t.amount::text AS amount, t.run_id,
    r.month AS run_month, t.source, t.note, t.created_by, t.created_at, t.reverses_id
  FROM hr.advance_txns t LEFT JOIN hr.runs r ON r.id = t.run_id
 WHERE t.person_id = $1
 ORDER BY t.txn_date, t.id`;

// Each row with the balance after it (an exact string).
function runningBalances(rows) {
  let sum = rat(0);
  return rows.map((row) => {
    const sign = ADVANCE_SIGN.get(row.kind);
    if (sign === undefined) throw new RangeError(`Unknown advance transaction kind ${JSON.stringify(row.kind)}`);
    sum = sign > 0 ? add(sum, rat(row.amount)) : sub(sum, rat(row.amount));
    return { ...row, balance: money(sum) };
  });
}

// One row in the advance ledger. `txnType` is the ledger's kind column: given, waived or opening here.
const postAdvance = (oc, req, personId, txnType, amount, date, source, note) => oc(
  `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note, created_by)
   VALUES ($1, $2::date, $3, $4, $5, $6, $7)
   RETURNING id, person_id, txn_date::text AS txn_date, kind, amount::text AS amount, source, note, created_by, created_at`,
  [personId, date, txnType, amount, source, note, req.user.id]);

// Everyone with an advance history, with what they owe now.
r.get('/hr/advances', requireHr('viewer'), async (_req, res, next) => {
  try {
    const people = await q(
      `SELECT p.id AS person_id, p.code AS person_code, p.name AS person_name, p.department, p.status,
              count(*)::int AS txn_count, max(t.txn_date)::text AS last_txn_date
         FROM hr.advance_txns t JOIN hr.people p ON p.id = t.person_id
        GROUP BY p.id
        ORDER BY lower(p.name), p.id`);
    const balances = await advanceBalances(q, people.map((p) => p.person_id));
    res.json(people.map((p) => ({ ...p, balance: balances.get(p.person_id) })));
  } catch (e) { next(e); }
});

// One person's statement: every row with a running balance.
r.get('/hr/advances/:personId', requireHr('viewer'), async (req, res, next) => {
  try {
    const personId = idOf(req.params.personId, 'Person');
    const [person] = await q(`SELECT id, code, name, department, status FROM hr.people WHERE id = $1`, [personId]);
    if (!person) throw missing('Person');
    const txns = await q(ADVANCE_TXNS, [personId]);
    res.json({ person, balance: (await advanceBalances(q, [personId])).get(personId), txns: runningBalances(txns) });
  } catch (e) { next(e); }
});

// "Give advance" in the app: a 'given' row with source 'manual', posted straight away.
r.post('/hr/advances', requireHr('operator'), async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const personId = personIdOf(body.person_id);
    const amount = positiveOf(body.amount, 'The advance');
    const date = dateOf(body.txn_date ?? body.date, 'The date') ?? plantDateStr();
    const note = textOf(body.note, 'The note', 500);
    const out = await tx(async (qc, oc) => {
      if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [personId]))) throw bad('That person does not exist');
      const row = await postAdvance(oc, req, personId, 'given', amount, date, MANUAL, note);
      const balance = (await advanceBalances(qc, [personId])).get(personId);
      await hrAudit(qc, req, 'advance', personId, 'give', { txn_id: row.id, amount: money(amount), date, balance_after: balance });
      return { ...row, balance };
    });
    res.json(out);
  } catch (e) { next(refusal(e)); }
});

// Writing off some or all of what a person owes. Approver only, at most the balance, read under the same
// locks a finalise takes so it cannot be recovered and waived from one balance.
r.post('/hr/advances/:personId/waive', requireHr('approver'), async (req, res, next) => {
  try {
    const personId = idOf(req.params.personId, 'Person');
    const body = bodyOf(req);
    const amount = positiveOf(body.amount, 'The amount to waive');
    const note = textOf(body.note, 'The note', 500);
    const out = await tx(async (qc, oc) => {
      if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [personId]))) throw missing('Person');
      await lockHolder(qc, personId);
      const owed = (await advanceBalances(qc, [personId])).get(personId);
      if (cmp(rat(amount), rat(owed)) > 0) {
        throw bad(`The waiver (${money(amount)}) is more than the advance balance (${owed})`);
      }
      const row = await postAdvance(oc, req, personId, 'waived', amount, plantDateStr(), WAIVER, note);
      const balance = (await advanceBalances(qc, [personId])).get(personId);
      await hrAudit(qc, req, 'advance', personId, 'waive', {
        txn_id: row.id, amount: money(amount), balance_before: owed, balance_after: balance,
      });
      return { ...row, balance };
    });
    res.json(out);
  } catch (e) { next(refusal(e)); }
});

// ── Staff payments: money handed to a person, as an advance or a loan ───────
//
// POST /hr/staff-payments (operator) is the Pay staff form's one door. body {person_id, kind (advance or loan), amount,
// paid_on, paid_via (a pay channel code, or 'cash'), instalments (loan), first_due_month (loan), note}.
//   * advance  one 'given' row with source 'manual' (exactly MANUAL: payroll nets the month's sheet ADVANCE against
//              that source), dated paid_on. It is recovered by the payroll of the month containing paid_on, or by
//              the next open month when that month is already finalised: a run reads balances as at its month end
//              (hr/ledger.js), so an earlier month's run never takes it, and is never changed by it.
//   * loan     CI-LN-#### (nextNumber FIRST in the transaction) with its 'disbursed' row. The instalment is the
//              amount over the instalments rounded UP to the rupee, so the loan is never under-recovered; the last
//              month takes whatever is left, because a month takes min(instalment, outstanding) (hr/loans.js).
//              first_due_month defaults to the month of paid_on, or to the next open payroll month when that month
//              (or a later one) is already finalised. A run before the month of paid_on never sees the loan.
// It takes the locks every ledger write takes (the person's row, then the person's loans, FOR UPDATE), after the
// number. Nothing here refuses on judgement: a person marked as left, or a first due month that payroll has already
// closed, comes back in `warnings`. The answer carries the person's ledger as GET /hr/people/:id/ledger reads it.
//
// GET /hr/people/:id/ledger (viewer): every advance and loan movement of the person on one dated list, newest first,
// each with the advance balance after it and, for a loan row, that loan's outstanding after it; plus the totals now.

const STAFF_KINDS = ['advance', 'loan'];
const MAX_INSTALMENTS = 360;
const CASH = 'cash';

const ADVANCE_WORDS = { opening: 'Opening advance', given: 'Advance given', recovered: 'Recovered from pay', waived: 'Waived', adjustment: 'Adjustment' };
const LOAN_WORDS = {
  disbursed: 'Loan given', opening: 'Opening loan', payroll_recovery: 'Instalment from pay', prepayment: 'Prepayment',
  adjustment: 'Adjustment', waiver: 'Waived',
};

// The amount over n months, rounded UP to the whole rupee, as '1234.00'.
function instalmentOf(amount, n) {
  const share = div(rat(amount), rat(BigInt(n)));
  const whole = share.n / share.d + (share.n % share.d === 0n ? 0n : 1n);    // both positive: a ceiling
  return `${whole}.00`;
}

function instalmentsOf(raw) {
  if (blank(raw)) throw bad('Say over how many monthly instalments the loan is repaid');
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^[0-9]{1,4}$/.test(text) || Number(text) < 1) throw bad('The instalments must be a whole number, 1 or more');
  const n = Number(text);
  if (n > MAX_INSTALMENTS) throw bad(`At most ${MAX_INSTALMENTS} instalments`);
  return n;
}

function readStaffPayment(body) {
  const kind = choiceOf(body.kind, STAFF_KINDS, 'advance or loan');
  const out = {
    personId: personIdOf(body.person_id),
    kind,
    amount: positiveOf(body.amount, 'The amount'),
    paidOn: dateOf(body.paid_on, 'The date it was given') ?? plantDateStr(),
    paidVia: textOf(body.paid_via, 'Paid via', 60, true) ?? CASH,
    note: textOf(body.note, 'The note', 500),
    instalments: null,
    firstDue: null,
  };
  if (out.paidVia.toLowerCase() === CASH) out.paidVia = CASH;
  if (kind === 'loan') {
    rejectInterest(body);
    out.instalments = instalmentsOf(body.instalments);
    out.firstDue = blank(body.first_due_month) ? null : monthOf(body.first_due_month, 'The first month an instalment is due');
    if (out.firstDue !== null && out.firstDue < out.paidOn.slice(0, 7)) {
      throw bad('The first instalment cannot fall due before the month the loan was given');
    }
  }
  return out;
}

// The person's ledger: one dated list of every advance and loan row, newest first, with running balances, and the
// totals as they stand. `read` is the pool's q (after a transaction has ended). Null when there is no such person.
async function personLedger(read, personId) {
  const [person] = await read(`SELECT id, code, name, display_name, department, status, pay_channel, exited_on::text AS exited_on
                                 FROM hr.people WHERE id = $1`, [personId]);
  if (!person) return null;
  const advances = runningBalances(await read(ADVANCE_TXNS, [personId]));
  const loanRows = await read(`SELECT ${LOAN_COLS} ${LOAN_FROM} WHERE l.person_id = $1 ORDER BY l.issued_on, l.id`, [personId]);
  const loanTxns = loanRows.length ? groupBy(await read(LOAN_TXNS, [loanRows.map((l) => l.id)]), 'loan_id') : new Map();
  const loans = await loanViews(read, loanRows);

  const rows = [];
  for (const t of advances) {
    rows.push({
      key: `a${t.id}`, date: t.txn_date, ledger: 'advance', kind: t.kind, label: ADVANCE_WORDS[t.kind] ?? t.kind,
      amount: money(t.amount), effect: ADVANCE_SIGN.get(t.kind) > 0 ? 'owes_more' : 'owes_less',
      advance_balance: t.balance, loan_id: null, loan_no: null, loan_outstanding: null,
      source: t.source, note: t.note, run_month: t.run_month, created_by: t.created_by, created_at: t.created_at,
    });
  }
  for (const loan of loanRows) {
    for (const t of withBalances(loan, loanTxns.get(loan.id) ?? [])) {
      const value = rat(t.principal_amount);
      const up = ['disbursed', 'opening'].includes(t.kind) || (t.kind === 'adjustment' && !isNeg(value));
      rows.push({
        key: `l${t.id}`, date: t.txn_date, ledger: 'loan', kind: t.kind, label: LOAN_WORDS[t.kind] ?? t.kind,
        amount: money(isNeg(value) ? neg(value) : value), effect: up ? 'owes_more' : 'owes_less',
        advance_balance: null, loan_id: loan.id, loan_no: loan.loan_no, loan_outstanding: t.balance,
        source: null, note: t.note, run_month: t.run_month, created_by: t.created_by, created_at: t.created_at,
      });
    }
  }
  // Oldest first to carry the advance balance onto the loan rows, then newest first for the answer.
  const stamp = (x) => (x.created_at ? new Date(x.created_at).getTime() : 0);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || stamp(a) - stamp(b)
    || (a.ledger === b.ledger ? 0 : a.ledger === 'advance' ? -1 : 1) || Number(a.key.slice(1)) - Number(b.key.slice(1)));
  let carried = '0.00';
  for (const row of rows) {
    if (row.ledger === 'advance') carried = row.advance_balance;
    else row.advance_balance = carried;
  }
  const names = new Map();
  const userIds = [...new Set(rows.map((x) => x.created_by).filter((id) => Number.isInteger(id)))];
  if (userIds.length) {
    for (const u of await read(`SELECT id, name FROM public.users WHERE id = ANY($1::int[])`, [userIds])) names.set(u.id, u.name);
  }
  for (const row of rows) row.created_by_name = names.get(row.created_by) ?? null;
  rows.reverse();

  const advanceBalance = (await advanceBalances(read, [personId])).get(personId);
  let loansOut = rat(0);
  for (const l of loans) loansOut = add(loansOut, rat(l.outstanding));
  return {
    person,
    totals: {
      advance_balance: advanceBalance,
      loans_outstanding: money(loansOut),
      owed: money(add(rat(advanceBalance), loansOut)),
      loans: loans.map((l) => ({
        id: l.id, loan_no: l.loan_no, status: l.status, issued_on: l.issued_on, principal: money(l.principal),
        instalment: money(l.instalment), first_due_month: l.first_due_month, outstanding: l.outstanding,
        due_this_month: l.due_this_month, next_due_month: l.next_due_month, next_due: l.next_due, paid_via: l.paid_via,
      })),
    },
    rows,
  };
}

r.get('/hr/people/:id/ledger', requireHr('viewer'), async (req, res, next) => {
  try {
    const ledger = await personLedger(q, idOf(req.params.id, 'Person'));
    if (!ledger) throw missing('Person');
    res.json(ledger);
  } catch (e) { next(e); }
});

r.post('/hr/staff-payments', requireHr('operator'), async (req, res, next) => {
  try {
    const pay = readStaffPayment(bodyOf(req));
    const out = await tx(async (qc, oc) => {
      // The loan number FIRST, before any row lock (helpers.js document-number lock order).
      const loanNo = pay.kind === 'loan' ? await nextNumber('CI-LN-', 'hr.loans', 'loan_no', oc) : null;
      // Then the locks every ledger write takes, in finalise's order: the person's row, then the person's loans.
      const person = await oc(`SELECT id, code, name, status, exited_on::text AS exited_on FROM hr.people WHERE id = $1 FOR UPDATE`,
        [pay.personId]);
      if (!person) throw bad('That person does not exist');
      await qc(`SELECT id FROM hr.loans WHERE person_id = $1 ORDER BY id FOR UPDATE`, [pay.personId]);

      let via = 'Cash';
      if (pay.paidVia !== CASH) {
        const channel = await oc(`SELECT code, label FROM hr.pay_channels WHERE code = $1`, [pay.paidVia]);
        if (!channel) {
          throw refuse(400, `${pay.paidVia} is not a pay channel: choose one from the list, or cash`, UNKNOWN_PAY_CHANNEL);
        }
        via = channel.label || channel.code;
      }

      const warnings = [];
      if (person.status === 'exited') {
        warnings.push(`${person.name} (${person.code}) is marked as left${person.exited_on ? ` (last day ${person.exited_on})` : ''}`);
      }
      const latest = await oc(`SELECT max(month) AS month FROM hr.runs WHERE status = 'finalised'`);
      const closed = latest?.month ?? null;
      const paidMonth = pay.paidOn.slice(0, 7);
      const open = closed && paidMonth <= closed ? nextMonth(closed) : paidMonth;

      if (pay.kind === 'advance') {
        const note = pay.note ? `Paid via ${via} · ${pay.note}` : `Paid via ${via}`;
        const row = await postAdvance(oc, req, pay.personId, 'given', pay.amount, pay.paidOn, MANUAL, note);
        const balance = (await advanceBalances(qc, [pay.personId])).get(pay.personId);
        if (open !== paidMonth) {
          warnings.push(`Payroll for ${paidMonth}, the month this advance was given in, is already finalised, so it is `
            + `recovered from ${open}, the next open payroll month`);
        }
        await hrAudit(qc, req, 'advance', pay.personId, 'give', {
          via: 'staff_payment', txn_id: row.id, amount: money(pay.amount), date: pay.paidOn, paid_via: pay.paidVia,
          balance_after: balance,
        });
        return { type: 'advance', advanceId: row.id, loanId: null, warnings };
      }

      const instalment = instalmentOf(pay.amount, pay.instalments);
      const firstDue = pay.firstDue ?? open;
      if (closed && firstDue <= closed) {
        warnings.push(`Payroll for ${firstDue} is already finalised: the first instalment is taken from ${nextMonth(closed)}, `
          + 'the next open payroll month');
      }
      const made = await oc(
        `INSERT INTO hr.loans (loan_no, person_id, principal, issued_on, purpose, interest_rate, instalment, first_due_month,
                               paid_via, is_opening, note, created_by)
         VALUES ($1, $2, $3, $4::date, NULL, 0, $5, $6, $7, false, $8, $9)
         RETURNING id, loan_no`,
        [loanNo, pay.personId, pay.amount, pay.paidOn, instalment, firstDue, pay.paidVia, pay.note, req.user.id]);
      await qc(
        `INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by)
         VALUES ($1, $2::date, 'disbursed', $3, $4, $5)`,
        [made.id, pay.paidOn, pay.amount, `Paid out via ${via}`, req.user.id]);
      await hrAudit(qc, req, 'loan', made.id, 'create', {
        via: 'staff_payment', loan_no: made.loan_no, person_id: pay.personId, principal: money(pay.amount),
        instalments: pay.instalments, instalment, first_due_month: firstDue, issued_on: pay.paidOn, paid_via: pay.paidVia,
        is_opening: false,
      });
      return { type: 'loan', advanceId: null, loanId: made.id, warnings };
    });

    const ledger = await personLedger(q, pay.personId);
    res.json({
      kind: out.type,
      person_id: pay.personId,
      advance: out.advanceId ? ledger.rows.find((x) => x.key === `a${out.advanceId}`) ?? null : null,
      loan: out.loanId ? await loanView(out.loanId) : null,
      warnings: out.warnings,
      ledger,
    });
  } catch (e) { next(refusal(e)); }
});

// ── Adjustments ─────────────────────────────────────────────────────────────

const ADJUSTMENT_FROM = `FROM hr.adjustments a JOIN hr.people p ON p.id = a.person_id`;
const ADJUSTMENT_COLS = `a.id, a.person_id, p.code AS person_code, p.name AS person_name, a.kind, a.category, a.amount,
  a.description, a.reference, a.recurrence, a.start_month, a.end_month, a.status, a.approved_by, a.approved_at,
  a.created_by, a.created_at`;

const adjustmentView = async (id) => (await q(`SELECT ${ADJUSTMENT_COLS} ${ADJUSTMENT_FROM} WHERE a.id = $1`, [id]))[0];

// Recurring: a start and an end month, in order. One-time: a single month, in start_month (an end month, if
// sent, must be that same month). Stored with no end month, as "never repeats".
function readAdjustment(body) {
  const personId = personIdOf(body.person_id);
  const type = choiceOf(body.kind, ADJUSTMENT_KINDS, 'earning or deduction');
  const amount = positiveOf(body.amount, 'The amount');
  const recurrence = choiceOf(body.recurrence, RECURRENCES, 'one_time or recurring', 'one_time');
  const start = monthOf(body.start_month, 'The start month');
  let end = null;
  if (recurrence === 'recurring') {
    end = monthOf(body.end_month, 'The end month of a recurring adjustment');
    if (end < start) throw bad('The end month is before the start month');
  } else if (!blank(body.end_month) && monthOf(body.end_month, 'The end month') !== start) {
    throw bad('A one-time adjustment is for a single month: leave the end month empty, or make it the start month');
  }
  return {
    personId,
    type,
    amount,
    recurrence,
    start,
    end,
    category: textOf(body.category, 'The category', 60, true),
    description: textOf(body.description, 'The description', 500),
    reference: textOf(body.reference, 'The reference', 200),
  };
}

// Payroll for every month the adjustment covers is already finalised: nothing can use it any more.
async function assertOpenMonths(oc, a, doing) {
  const last = a.end_month ?? a.start_month;
  const closed = await oc(`SELECT month FROM hr.runs WHERE status = 'finalised' AND month >= $1 ORDER BY month LIMIT 1`, [last]);
  if (closed) {
    throw refuse(409, `Payroll for ${last} is already finalised, so this adjustment can no longer be ${doing}. `
      + 'Put the correction in the next open month as a new adjustment', ADJUSTMENT_FINALISED);
  }
}

r.get('/hr/adjustments', requireHr('viewer'), async (req, res, next) => {
  try {
    const asked = req.query.month;
    if (asked !== undefined && !(typeof asked === 'string' && MONTH.test(asked))) throw bad('month must look like 2026-08');
    const statuses = listOf(req.query.status, ADJUSTMENT_STATUSES, 'status');
    const person = blank(req.query.person_id) ? null : personIdOf(req.query.person_id);
    res.json(await q(
      `SELECT ${ADJUSTMENT_COLS} ${ADJUSTMENT_FROM}
        WHERE ($1::text IS NULL OR (a.start_month <= $1 AND coalesce(a.end_month, a.start_month) >= $1))
          AND ($2::text[] IS NULL OR a.status = ANY($2::text[]))
          AND ($3::int IS NULL OR a.person_id = $3::int)
        ORDER BY a.start_month DESC, a.id DESC
        LIMIT 1000`,
      [asked ?? null, statuses, person]));
  } catch (e) { next(e); }
});

r.post('/hr/adjustments', requireHr('operator'), async (req, res, next) => {
  try {
    const a = readAdjustment(bodyOf(req));
    const id = await tx(async (qc, oc) => {
      if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [a.personId]))) throw bad('That person does not exist');
      const made = await oc(
        `INSERT INTO hr.adjustments (person_id, kind, category, amount, description, reference, recurrence, start_month,
                                     end_month, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [a.personId, a.type, a.category, a.amount, a.description, a.reference, a.recurrence, a.start, a.end, req.user.id]);
      await hrAudit(qc, req, 'adjustment', made.id, 'create', {
        person_id: a.personId, type: a.type, category: a.category, amount: money(a.amount),
        recurrence: a.recurrence, start_month: a.start, end_month: a.end,
      });
      return made.id;
    });
    res.json(await adjustmentView(id));
  } catch (e) { next(refusal(e)); }
});

r.post('/hr/adjustments/:id/approve', requireHr('approver'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Adjustment');
    await tx(async (qc, oc) => {
      const a = await oc(
        `SELECT id, person_id, status, start_month, end_month FROM hr.adjustments WHERE id = $1 FOR UPDATE`, [id]);
      if (!a) throw missing('Adjustment');
      if (a.status !== 'pending') throw refuse(409, `This adjustment is ${a.status}, so it cannot be approved`, ADJUSTMENT_STATE);
      await assertOpenMonths(oc, a, 'approved');
      await qc(`UPDATE hr.adjustments SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, req.user.id]);
      await hrAudit(qc, req, 'adjustment', id, 'approve', {
        person_id: a.person_id, start_month: a.start_month, end_month: a.end_month,
      });
    });
    res.json(await adjustmentView(id));
  } catch (e) { next(refusal(e)); }
});

r.post('/hr/adjustments/:id/cancel', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Adjustment');
    await tx(async (qc, oc) => {
      const a = await oc(
        `SELECT id, person_id, status, start_month, end_month FROM hr.adjustments WHERE id = $1 FOR UPDATE`, [id]);
      if (!a) throw missing('Adjustment');
      if (a.status === 'cancelled') throw refuse(409, 'This adjustment is already cancelled', ADJUSTMENT_STATE);
      if (a.status === 'approved') await assertOpenMonths(oc, a, 'cancelled');
      await qc(`UPDATE hr.adjustments SET status = 'cancelled' WHERE id = $1`, [id]);
      await hrAudit(qc, req, 'adjustment', id, 'cancel', {
        person_id: a.person_id, was: a.status, start_month: a.start_month, end_month: a.end_month,
      });
    });
    res.json(await adjustmentView(id));
  } catch (e) { next(refusal(e)); }
});

// ── Loading from the salary workbook: the upload ────────────────────────────

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);                // an .xlsx is a zip: 'PK\x03\x04'

// 4 MB is the real ceiling (Vercel refuses bodies past ~4.5 MB before Express runs); the decisions field is
// JSON text and, like every JSON body here, stays under 100 KB.
const DECISIONS_MAX = 100 * 1024;
const loaderFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 4, fieldSize: DECISIONS_MAX, parts: 8 },
});
const loaderUpload = (req, res, next) => loaderFiles.single('file')(req, res, (err) => {
  if (!err) return next();
  return next(bad(err.code === 'LIMIT_FILE_SIZE'
    ? 'The workbook is over 4 MB. Save a smaller copy of it and try again'
    : `The upload could not be read: ${err.message}`));
});

// The uploaded workbook, parsed. Everything about its CONTENT comes back in `issues`; only a file that is not
// a workbook at all fails to read.
async function parsedUpload(req) {
  const buffer = req.file?.buffer;
  if (!buffer?.length) throw bad('Choose the salary workbook (.xlsx) to read');
  if (!buffer.subarray(0, 4).equals(XLSX_MAGIC)) throw bad('That file is not an .xlsx workbook');
  try {
    return await parseSalaryWorkbook(buffer);
  } catch (e) {
    throw bad(`The workbook could not be read: ${clip(String(e?.message ?? e), 120)}`);
  }
}

// ── Loading from the salary workbook: what is already in HR ─────────────────

// A pay channel's code is the label as normName() reads it ('Cash' and 'CASH' are one channel); a channel with
// CASH as a word of its name is cash, any other is a bank.
const channelKind = (code) => (/(^|[^A-Z])CASH([^A-Z]|$)/.test(code) ? 'cash' : 'bank');

// Everything the load compares with, read once: people by their normalised code, the channel codes, each
// person's pay setups, and who already has a loan or any advance row. `read` is q (preview) or qc (apply).
async function readLoadState(read) {
  const people = new Map();
  for (const p of await read(
    `SELECT id, code, name, display_name, firm, department, worker_type, pay_channel, bank_holder, bank_account,
            bank_ifsc, esi_applicable, legacy
       FROM hr.people ORDER BY id`)) {
    const key = normCode(p.code);
    if (!people.has(key)) people.set(key, p);
  }
  const channels = new Set((await read(`SELECT code FROM hr.pay_channels`)).map((c) => c.code));
  const setups = groupBy(await read(
    `SELECT person_id, effective_from::text AS effective_from, pay_basis, base::text AS base,
            ot_hours_per_day::text AS ot_hours_per_day, holiday_mode, holiday_divisor::text AS holiday_divisor,
            holiday_multiplier::text AS holiday_multiplier, holiday_fixed::text AS holiday_fixed
       FROM hr.pay_setups ORDER BY person_id, effective_from`), 'person_id');
  const loaned = new Set((await read(`SELECT DISTINCT person_id FROM hr.loans WHERE status <> 'cancelled'`)).map((l) => l.person_id));
  const advanced = new Set((await read(`SELECT DISTINCT person_id FROM hr.advance_txns`)).map((a) => a.person_id));
  return { people, channels, setups, loaned, advanced };
}

// The person columns the workbook has something to say about. A blank is no evidence: it never blanks a column
// that HR already holds. The bank columns come only from a matched BANK DETAILS row, and ESI only with one
// (or when the workbook says yes).
function personColumns(p, channel) {
  const cols = {
    name: p.name,
    display_name: p.display_name,
    firm: p.firm,
    department: p.department,
    worker_type: p.worker_type,
    pay_channel: channel,
  };
  if (p.bank) {
    cols.bank_holder = p.bank.holder;
    cols.bank_account = p.bank.account;
    cols.bank_ifsc = p.bank.ifsc;
  }
  if (p.bank || p.esi_applicable) cols.esi_applicable = p.esi_applicable;
  for (const key of Object.keys(cols)) if (cols[key] === null || cols[key] === undefined) delete cols[key];
  return cols;
}

// The workbook's legacy markers that are not blank.
function legacyOf(p) {
  return Object.fromEntries(Object.entries(p.legacy ?? {}).filter(([, v]) => v !== null && v !== undefined));
}

// The names of the fields on which the stored person differs from the workbook.
function changedFields(existing, cols, p) {
  const changed = Object.keys(cols).filter((key) => (existing[key] ?? null) !== cols[key]);
  if (Object.entries(legacyOf(p)).some(([key, value]) => existing.legacy?.[key] !== value)) changed.push('legacy');
  return changed;
}

// What the load would do, person by person, against what HR already holds. Nothing is read or written here.
function planLoad(parsed, state, skip) {
  const loanBy = new Map(parsed.openingLoans.map((l) => [l.code, l]));
  const setupBy = new Map(parsed.setups.map((s) => [s.code, s]));
  const advanceBy = new Map(parsed.openingAdvances.map((a) => [a.code, a]));
  return parsed.people.map((person) => {
    const existing = state.people.get(person.code) ?? null;
    const channel = person.pay_channel_label ? normName(person.pay_channel_label) : null;
    const columns = personColumns(person, channel);
    const changed = existing ? changedFields(existing, columns, person) : [];
    return {
      code: person.code,
      person,
      existing,
      channel,
      columns,
      changed,
      status: !existing ? 'new' : changed.length ? 'changed' : 'same',
      skipped: skip.has(person.code),
      setup: setupBy.get(person.code) ?? null,
      loan: loanBy.get(person.code) ?? null,
      advance: advanceBy.get(person.code) ?? null,
      hasLoan: existing ? state.loaned.has(existing.id) : false,
      hasAdvance: existing ? state.advanced.has(existing.id) : false,
    };
  });
}

// The last four digits of an account number: all a browser is ever given of it.
function last4(account) {
  const digits = String(account ?? '').replace(/[^0-9]/g, '');
  return digits ? digits.slice(-4) : null;
}

const HAS_LOAN_NOTE = 'this person already has a loan in HR, so the opening loan will not be loaded';
const HAS_ADVANCE_NOTE = 'this person already has advance entries in HR, so the opening advance will not be loaded';

// Preview: what parseSalaryWorkbook read (the parts the load screen shows), and the diff against the people
// already in HR by code. The workbook's bank numbers and pay figures stay here: a person carries bank_last4.
r.post('/hr/loader/preview', requireHr('admin'), loaderUpload, async (req, res, next) => {
  try {
    const parsed = await parsedUpload(req);
    const items = planLoad(parsed, await readLoadState(q), new Set());
    const diff = { new: [], changed: [], same: [] };
    for (const it of items) {
      if (it.status === 'changed') diff.changed.push({ code: it.code, fields: it.changed });
      else diff[it.status].push(it.code);
    }
    const loansKept = new Set(items.filter((it) => it.loan && it.hasLoan).map((it) => it.code));
    const advancesKept = new Set(items.filter((it) => it.advance && it.hasAdvance).map((it) => it.code));
    res.json({
      month: parsed.month,
      daysInMonth: parsed.daysInMonth,
      people: parsed.people.map((p) => ({
        code: p.code,
        name: p.name,
        display_name: p.display_name,
        firm: p.firm,
        department: p.department,
        worker_type: p.worker_type,
        pay_channel_label: p.pay_channel_label,
        bank_last4: last4(p.bank?.account),
        esi_applicable: p.esi_applicable,
      })),
      setups: parsed.setups,
      openingLoans: parsed.openingLoans.map((l) => (loansKept.has(l.code) ? { ...l, review: [...l.review, HAS_LOAN_NOTE] } : l)),
      openingAdvances: parsed.openingAdvances.map((a) => (advancesKept.has(a.code) ? { ...a, review: [HAS_ADVANCE_NOTE] } : a)),
      issues: parsed.issues,
      diff,
    });
  } catch (e) { next(refusal(e)); }
});

// ── Loading from the salary workbook: the decisions ─────────────────────────

// The fields an edit may set, by the name the preview shows them under; `on` is the row of the workbook's read
// that holds it. Anything else is refused by name rather than ignored.
const EDITABLE = new Map([
  ['name', { on: 'person', read: (v) => requiredText(v, 'The name', 120) }],
  ['display_name', { on: 'person', read: (v) => textOf(v, 'The display name', 120, true) }],
  ['firm', { on: 'person', read: (v) => textOf(v, 'The firm', 120, true) }],
  ['department', { on: 'person', read: (v) => textOf(v, 'The department', 120, true) }],
  ['worker_type', { on: 'person', read: (v) => choiceOf(v, WORKER_TYPES, 'the worker type') }],
  ['pay_channel_label', { on: 'person', read: (v) => textOf(v, 'The pay channel', 40, true) }],
  ['pay_basis', { on: 'setup', read: (v) => choiceOf(v, PAY_BASES, 'the pay basis') }],
  ['base', { on: 'setup', read: (v) => amountOf(v, 'The base pay', 2) }],
  ['ot_hours_per_day', { on: 'setup', read: (v) => {
    const hours = amountOf(v, 'OT hours per day', 4) ?? '0';
    if (Number(hours) > 24) throw bad('OT hours per day cannot be more than 24');
    return hours;
  } }],
  ['holiday_mode', { on: 'setup', read: (v) => choiceOf(v, HOLIDAY_MODES, 'the holiday mode') }],
  ['holiday_divisor', { on: 'setup', read: (v) => amountOf(v, 'The holiday divisor', 4) }],
  ['holiday_multiplier', { on: 'setup', read: (v) => amountOf(v, 'The holiday multiplier', 4) }],
  ['holiday_fixed', { on: 'setup', read: (v) => amountOf(v, 'The holiday amount', 2) }],
  ['instalment', { on: 'loan', read: (v) => amountOf(v, 'The instalment', 2) }],
  ['outstanding', { on: 'loan', read: (v) => positiveOf(v, 'The outstanding balance') }],
  ['amount', { on: 'advance', read: (v) => positiveOf(v, 'The advance') }],
]);
const EDIT_TARGET = { person: 'a person', setup: 'a pay setup', loan: 'an opening loan', advance: 'an opening advance' };

// The `decisions` field: JSON text {skip:[code], edits:{code:{field:value}}}. A missing field is no decisions.
function readDecisions(raw) {
  const none = { skip: new Set(), edits: new Map() };
  if (raw === undefined || raw === null || raw === '') return none;
  if (typeof raw !== 'string') throw bad('decisions must be JSON text');
  if (raw.length > DECISIONS_MAX) throw bad('decisions is too long');
  let json;
  try { json = JSON.parse(raw); } catch { throw bad('decisions is not valid JSON'); }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw bad('decisions must look like {"skip": [], "edits": {}}');
  }
  const unknown = Object.keys(json).filter((key) => key !== 'skip' && key !== 'edits');
  if (unknown.length) throw bad(`decisions has no field ${unknown.join(', ')}`);

  const codeOf = (value, where) => {
    const code = typeof value === 'string' || typeof value === 'number' ? normCode(value) : null;
    if (code === null) throw bad(`${where} must hold payroll codes`);
    return code;
  };
  const skip = new Set();
  if (json.skip !== undefined) {
    if (!Array.isArray(json.skip)) throw bad('decisions.skip must be a list of payroll codes');
    for (const value of json.skip) skip.add(codeOf(value, 'decisions.skip'));
  }
  const edits = new Map();
  if (json.edits !== undefined) {
    if (json.edits === null || typeof json.edits !== 'object' || Array.isArray(json.edits)) {
      throw bad('decisions.edits must be an object of edits by payroll code');
    }
    for (const [key, fields] of Object.entries(json.edits)) {
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw bad(`The edits for ${key} must be an object`);
      if (Object.keys(fields).length) edits.set(codeOf(key, 'decisions.edits'), fields);
    }
  }
  return { skip, edits };
}

// A pay setup has to be able to be stored: what its basis and holiday rule need is there.
function checkSetup(s, who) {
  if (s.pay_basis !== 'contract' && blank(s.base)) throw bad(`${who}: the pay setup needs a base pay`);
  if (s.holiday_mode === 'formula' && (blank(s.holiday_divisor) || blank(s.holiday_multiplier))) {
    throw bad(`${who}: a holiday formula needs a divisor and a multiplier`);
  }
  if (s.holiday_mode === 'formula' && isZero(rat(s.holiday_divisor))) throw bad(`${who}: the holiday divisor must be more than 0`);
  if (s.holiday_mode === 'fixed' && blank(s.holiday_fixed)) throw bad(`${who}: a fixed holiday pay needs the amount`);
}

const whoIs = (p) => `${p.display_name ?? p.name} (${p.code})`;

// The workbook with the decisions applied: skipped codes, and edits laid over copies of its rows. Refuses a
// code the workbook does not have, a field that cannot be edited, an edit with nothing to land on, a pay setup
// that could not be stored, and an opening loan with no instalment above 0 (naming whose it is).
function withDecisions(parsed, raw) {
  const { skip, edits } = readDecisions(raw);
  const known = new Set(parsed.people.map((p) => p.code));
  for (const code of [...skip, ...edits.keys()]) {
    if (!known.has(code)) throw bad(`The workbook has no person with the code ${code}`);
  }
  const copy = {
    ...parsed,
    people: parsed.people.map((p) => ({ ...p })),
    setups: parsed.setups.map((s) => ({ ...s })),
    openingLoans: parsed.openingLoans.map((l) => ({ ...l })),
    openingAdvances: parsed.openingAdvances.map((a) => ({ ...a })),
  };
  const rows = {
    person: new Map(copy.people.map((row) => [row.code, row])),
    setup: new Map(copy.setups.map((row) => [row.code, row])),
    loan: new Map(copy.openingLoans.map((row) => [row.code, row])),
    advance: new Map(copy.openingAdvances.map((row) => [row.code, row])),
  };
  for (const [code, fields] of edits) {
    for (const [field, value] of Object.entries(fields)) {
      const spec = EDITABLE.get(field);
      if (!spec) throw bad(`${code}: ${field} cannot be edited. These can: ${[...EDITABLE.keys()].join(', ')}`);
      const row = rows[spec.on].get(code);
      if (!row) throw bad(`${code}: the workbook has no ${EDIT_TARGET[spec.on]} for this person to edit`);
      row[field] = spec.read(value);
    }
  }
  const people = new Map(copy.people.map((p) => [p.code, p]));
  for (const s of copy.setups) if (!skip.has(s.code)) checkSetup(s, whoIs(people.get(s.code)));
  for (const loan of copy.openingLoans) {
    if (skip.has(loan.code)) continue;
    if (blank(loan.instalment) || cmp(rat(loan.instalment), rat(0)) <= 0) {
      throw refuse(400, `${whoIs(people.get(loan.code))} has an opening loan but no instalment above 0. `
        + 'Enter the instalment, or skip this person', INSTALMENT_NEEDED);
    }
  }
  return { parsed: copy, skip, edited: edits.size };
}

// ── Loading from the salary workbook: apply ─────────────────────────────────

const numEq = (a, b) => cmp(rat(a ?? 0), rat(b ?? 0)) === 0;
const sameSetup = (a, b) => a.pay_basis === b.pay_basis && numEq(a.base, b.base)
  && numEq(a.ot_hours_per_day, b.ot_hours_per_day) && a.holiday_mode === b.holiday_mode
  && numEq(a.holiday_divisor, b.holiday_divisor) && numEq(a.holiday_multiplier, b.holiday_multiplier)
  && numEq(a.holiday_fixed, b.holiday_fixed);

// The whole load, in the caller's transaction (all or nothing). The loan-number lock and the names lock come
// before any row is touched; then the people the load changes and their loans are locked in finalise's order,
// and the state is read again under those locks, so the plan is made against what is really there.
async function applyLoad(qc, oc, req, load) {
  const { parsed, skip, edited } = load;
  const month = parsed.month;
  const effective = `${nextMonth(month)}-01`;
  const monthEnd = lastDayOf(month);
  const why = `Loaded from the salary workbook for ${month}`;

  await lockDocNumber('CI-LN-', oc);
  await lockNames(qc);
  const peek = await readLoadState(qc);
  const ids = parsed.people.filter((p) => !skip.has(p.code)).map((p) => peek.people.get(p.code)?.id)
    .filter((id) => id !== undefined).sort((a, b) => a - b);
  if (ids.length) {
    await qc(`SELECT id FROM hr.people WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
    await qc(`SELECT id FROM hr.loans WHERE person_id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
  }
  const state = await readLoadState(qc);
  const items = planLoad(parsed, state, skip);

  const n = {
    created: 0, updated: 0, unchanged: 0, skipped: 0, channels: 0,
    setups: 0, setups_same: 0, setups_kept: 0, loans: 0, loans_kept: 0, advances: 0, advances_kept: 0,
  };

  // Pay channels first: a person points at one (foreign key). The label as first typed names it.
  const made = new Set();
  for (const it of items) {
    if (it.skipped || !it.channel || state.channels.has(it.channel) || made.has(it.channel)) continue;
    await qc(
      `INSERT INTO hr.pay_channels (code, label, kind) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
      [it.channel, it.person.pay_channel_label, channelKind(it.channel)]);
    made.add(it.channel);
    n.channels += 1;
  }

  for (const it of items) {
    if (it.skipped) { n.skipped += 1; continue; }

    let personId;
    if (!it.existing) {
      await assertNameFree(qc, { personId: null, name: it.columns.name, displayName: it.columns.display_name ?? null });
      const columns = Object.keys(it.columns);
      const row = await oc(
        `INSERT INTO hr.people (code, ${columns.join(', ')}, legacy)
         VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}, $${columns.length + 2}::jsonb) RETURNING id`,
        [it.code, ...columns.map((c) => it.columns[c]), JSON.stringify(legacyOf(it.person))]);
      personId = row.id;
      n.created += 1;
    } else {
      personId = it.existing.id;
      if (it.changed.length) {
        if (it.changed.includes('name') || it.changed.includes('display_name')) {
          await assertNameFree(qc, {
            personId,
            name: it.columns.name ?? it.existing.name,
            displayName: it.columns.display_name ?? it.existing.display_name,
          });
        }
        const columns = it.changed.filter((c) => c !== 'legacy');
        const sets = columns.map((c, i) => `${c} = $${i + 2}`);
        const values = columns.map((c) => it.columns[c]);
        if (it.changed.includes('legacy')) {
          sets.push(`legacy = legacy || $${values.length + 2}::jsonb`);
          values.push(JSON.stringify(legacyOf(it.person)));
        }
        await qc(`UPDATE hr.people SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [personId, ...values]);
        n.updated += 1;
      } else {
        n.unchanged += 1;
      }
    }

    if (it.setup) {
      const current = effectiveSetup(state.setups.get(personId) ?? [], nextMonth(month));
      if (current && sameSetup(current, it.setup)) {
        n.setups_same += 1;
      } else if (current && current.effective_from === effective) {
        n.setups_kept += 1;                                          // a different setup already holds that date
      } else {
        const s = it.setup;
        await qc(
          `INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base, ot_hours_per_day, holiday_mode,
                                      holiday_divisor, holiday_multiplier, holiday_fixed, note, created_by)
           VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [personId, effective, s.pay_basis, s.base, s.ot_hours_per_day, s.holiday_mode,
            s.holiday_mode === 'formula' ? s.holiday_divisor : null,
            s.holiday_mode === 'formula' ? s.holiday_multiplier : null,
            s.holiday_mode === 'fixed' ? s.holiday_fixed : null,
            why, req.user.id]);
        n.setups += 1;
      }
    }

    if (it.loan) {
      if (it.hasLoan) {
        n.loans_kept += 1;
      } else {
        await insertLoan(qc, oc, req, {
          personId,
          principal: it.loan.outstanding,
          issuedOn: monthEnd,
          purpose: 'Opening balance',
          instalment: it.loan.instalment,
          firstDue: nextMonth(month),
          paidVia: null,
          isOpening: true,
          note: `${why}, as at ${monthEnd}`,
        });
        n.loans += 1;
      }
    }

    if (it.advance) {
      if (it.hasAdvance) {
        n.advances_kept += 1;
      } else {
        await postAdvance(oc, req, personId, 'opening', it.advance.amount, monthEnd, LOADER, `${why}, as at ${monthEnd}`);
        n.advances += 1;
      }
    }
  }

  await hrAudit(qc, req, 'loader', month, 'apply', {
    month,
    effective_from: effective,
    people_created: n.created,
    people_updated: n.updated,
    people_unchanged: n.unchanged,
    people_skipped: n.skipped,
    people_edited: edited,
    pay_channels_created: n.channels,
    pay_setups_created: n.setups,
    pay_setups_unchanged: n.setups_same,
    pay_setups_kept: n.setups_kept,
    opening_loans: n.loans,
    opening_loans_kept: n.loans_kept,
    opening_advances: n.advances,
    opening_advances_kept: n.advances_kept,
  });
  return { created: n.created, updated: n.updated, opening_loans: n.loans, opening_advances: n.advances };
}

// Refused while the workbook cannot be trusted as it is: an error issue, or no month to date anything by.
function refuseWhenBroken(parsed) {
  const errors = parsed.issues.filter((i) => i.level === 'error');
  if (parsed.month !== null && !errors.length) return;
  const shown = clip(errors.slice(0, 3).map((i) => i.message).join(' | '), 500);
  throw refuse(400, `The workbook has ${errors.length || 1} problem${errors.length > 1 ? 's' : ''} to fix first: ${shown}`, WORKBOOK_ERRORS);
}

r.post('/hr/loader/apply', requireHr('admin'), loaderUpload, async (req, res, next) => {
  try {
    const parsed = await parsedUpload(req);
    refuseWhenBroken(parsed);
    const load = withDecisions(parsed, req.body?.decisions);
    res.json(await tx((qc, oc) => applyLoad(qc, oc, req, load)));
  } catch (e) { next(refusal(e)); }
});

export default r;
