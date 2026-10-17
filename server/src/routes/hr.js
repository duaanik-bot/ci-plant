// ─── HR & Payroll: people, pay setups, aliases, settings, pay channels, access, audit, dashboard ───
// Spec docs/superpowers/specs/2026-10-16-hr-payroll-design.md §5-§7 (access, masking, tables) and §14
// (dashboard). The payroll runs, imports, loans and advances are other routers under the same /api/hr.
//
// PRIVATE. Salary, bank and loan data live in schema hr and nowhere else. Every route sits behind
// r.use('/hr', hrGuard) (a row in hr.access, read fresh from the database on every request, never from the
// JWT) and states its own minimum level with requireHr(...): viewer reads, operator keeps people / setups /
// aliases, approver reads the audit trail, admin owns settings, pay channels and access (hr/access.js).
// Every response is no-store, and every GET is marked uncacheable (markUncacheable), so neither the
// browser nor the ERP's table-keyed response cache can hold a copy of anyone's pay.
//
// What a response carries
//   * A bank account number never appears in a list. People lists carry bank_last4 (the last four digits,
//     worked out in SQL, so the full number never even leaves the database for a list); pay-channel lists
//     carry the account masked. The full number is in GET /hr/people/:id for operator and above only.
//   * Stored money and quantities (pay setups, loan principal) are the numbers pg gives for NUMERIC. What the
//     ledgers work out (advance_balance, a loan's outstanding and due) and the run totals are exact 2-dp
//     strings, as hr/ledger.js and hr/runs.js produce them (Ruling T7-e); the client formats both with inr2.
//   * Dates are 'YYYY-MM-DD' text, months 'YYYY-MM' text (the engine and the ledgers are strict about both).
//
// Writes, errors
//   * Each write runs in tx() and leaves its row in hr.audit_log through hrAudit(qc, req, ...), in the same
//     transaction. Never public.audit_log, which /timeline shows to every login. Audit details name the
//     fields that changed; the values of secrets (bank account, PAN, UAN, ESI number) are never written.
//   * Inside tx() only qc / oc are used (a pool call would wait on itself on Vercel's one-client pool).
//   * A refusal is thrown as an Error with .status and .body = {code}: app.js sends {error, ...body} and
//     nothing else. A plain 400 / 404 carries no code. A race the pre-checks cannot see (two creates at
//     once) ends in a unique violation, which refusal() turns into the same 409 the pre-check would give.
//
// Names and aliases (Ruling T3-e). An alias must never equal any person's name or display name
// (ALIAS_IS_A_NAME), and a person's name or display name must never equal another person's alias
// (NAME_IS_AN_ALIAS): the importer would otherwise meet a name that two people claim. Both guards, and the
// advisory lock that makes them hold under concurrent requests, live in hr/names.js so the importer and the
// workbook loader use the very same ones; every write here takes lockNames(qc) first in its transaction.
import { Router } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { q, one, tx } from '../db.js';
import { markUncacheable } from '../data-tables.js';
import { optionalText } from '../helpers.js';
import { plantDateStr } from '../plant-calendar.js';
import { HR_LEVELS, hrGuard, levelAtLeast, requireHr } from '../hr/access.js';
import { hrAudit } from '../hr/audit.js';
import { effectiveSetup } from '../hr/engine.js';
import { FIELDS } from '../hr/import-parse.js';
import { advanceBalances, loanPositions } from '../hr/ledger.js';
import { loanOutstanding } from '../hr/loans.js';
import { normCode, normName } from '../hr/match.js';
import { assertAliasFree, assertNameFree, lockNames } from '../hr/names.js';
import { add, cmp, fmtPaise, rat, toPaise } from '../hr/money.js';

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
const STATUSES = ['active', 'on_leave', 'exited'];
const WORKER_TYPES = ['employee', 'contractor'];
const PAY_BASES = ['monthly', 'daily', 'hourly', 'contract'];
const ABSENCE_BASES = ['calendar_days', 'fixed_divisor'];
const HOLIDAY_MODES = ['none', 'formula', 'fixed'];
const CHANNEL_TYPES = ['bank', 'cash'];

// Access changes run one at a time. (Name and alias writes have their own lock: hr/names.js.)
const ACCESS_LOCK = `SELECT pg_advisory_xact_lock(hashtext('hr.access'))`;

// A refusal. The code (when there is one) rides in body: app.js sends {error, ...body}.
const fail = (status, message, code) => Object.assign(new Error(message), { status, body: code ? { code } : {} });
const bad = (message) => fail(400, message);
const missing = (what) => fail(404, `${what} not found`);

// The unique violations a race can still raise, as the refusals the pre-checks give; and the few
// value errors a validator could not see, as a 400 instead of a 500. Anything else passes through.
const UNIQUE_REFUSALS = new Map([
  ['people_code_key', () => fail(409, 'Another person already has this payroll code', 'CODE_EXISTS')],
  ['people_employee_id_uq', () => fail(409, 'That ERP operator is already linked to another person', 'EMPLOYEE_LINKED')],
  ['pay_setups_person_id_effective_from_key', () => fail(409, 'This person already has a pay setup from that month', 'SETUP_EXISTS')],
  ['person_aliases_alias_norm_key', () => fail(409, 'That spelling is already an approved alias', 'ALIAS_EXISTS')],
  ['pay_channels_pkey', () => fail(409, 'A pay channel with this code already exists', 'CODE_EXISTS')],
]);
const VALUE_ERRORS = new Map([
  ['23514', 'One of the values is outside what is allowed'],
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

const squash = (text) => text.replace(/\s+/g, ' ').trim();

// Optional text: null when absent or blank (optionalText also refuses the strings 'undefined' and 'null').
function textOf(raw, label, max, tidy = false) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(`${label} must be text`);
  const text = optionalText(tidy ? squash(raw) : raw);
  if (text !== null && text.length > max) throw bad(`${label} is too long (at most ${max} characters)`);
  return text;
}

// Optional text with every space taken out (account numbers, IFSC, PAN): null when empty.
function compactOf(raw, label, max, upper = false) {
  const text = textOf(raw, label, 200);
  const packed = text === null ? '' : text.replace(/\s+/g, '');
  if (!packed) return null;
  if (packed.length > max) throw bad(`${label} is too long (at most ${max} characters)`);
  return upper ? packed.toUpperCase() : packed;
}

function dateOf(raw, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const last = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (!m || year < 1900 || day < 1 || day > last) throw bad(`${label} must be a date like 2026-07-15`);
  return text;
}

// A plain non-negative decimal as exact text, or null when absent. Never a float: '20150.50' goes to the
// database as typed. More decimals than the column keeps are refused, not rounded, so what was typed is
// what is stored. Money columns keep 2 decimals, quantities 4; both fit 10 whole digits.
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

function flagOf(raw, label, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  throw bad(`${label} must be true or false`);
}

// One of `allowed`. `fallback` stands in for a blank value where there is a default (creating).
function choiceOf(raw, allowed, label, fallback) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`Choose ${label}`);
  }
  if (typeof raw === 'string' && allowed.includes(raw)) return raw;
  throw bad(`${label} must be one of ${allowed.join(', ')}`);
}

function employeeIdOf(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) throw bad('The ERP operator is not valid');
  return id;
}

// The end of an account or identity number, for the masked displays: '••••' and its last four characters
// (null when there is nothing to show).
const maskAccount = (account) => {
  const packed = String(account ?? '').replace(/\s+/g, '');
  return packed ? `••••${packed.slice(-4)}` : null;
};

// ── Columns ─────────────────────────────────────────────────────────────────

// bank_last4 comes out of SQL: a list never selects the account itself.
const BANK_LAST4 = `NULLIF(right(regexp_replace(COALESCE(p.bank_account, ''), '[^0-9]', '', 'g'), 4), '')`;

const LIST_COLS = `p.id, p.code, p.name, p.display_name, p.department, p.designation, p.worker_type, p.status,
  p.pay_channel, p.joined_on::text AS joined_on, p.exited_on::text AS exited_on, ${BANK_LAST4} AS bank_last4,
  p.employee_id`;

// Every person column but the numbers that identify or pay someone: the bank account, PAN, PF UAN and ESI
// number. Operator and above are given those whole (SECRETS_FULL); a viewer is given only the end of the
// last three (SECRETS_ENDS), as it is given bank_last4 and never the account (T9-c). Phone and address stay
// visible to a viewer. No list selects any of them.
const PERSON_COLS = `p.id, p.code, p.name, p.display_name, p.father_name, p.firm, p.department, p.designation,
  p.worker_type, p.status, p.joined_on::text AS joined_on, p.exited_on::text AS exited_on, p.phone, p.address,
  p.emergency_contact, p.pay_channel, p.bank_holder, p.bank_name, p.bank_ifsc, p.esi_applicable,
  p.employee_id, p.legacy, p.notes, p.created_at, p.updated_at, ${BANK_LAST4} AS bank_last4`;

const ID_NUMBERS = ['pan', 'pf_uan', 'esi_no'];
const SECRETS_FULL = `p.bank_account, ${ID_NUMBERS.map((c) => `p.${c}`).join(', ')}`;
// Only the last four characters (spaces ignored) of each leave the database for a viewer.
const lastFour = (column) => `NULLIF(right(regexp_replace(COALESCE(p.${column}, ''), '\\s', '', 'g'), 4), '')`;
const SECRETS_ENDS = ID_NUMBERS.map((c) => `${lastFour(c)} AS ${c}`).join(', ');

const SETUP_COLS = `id, person_id, effective_from::text AS effective_from, pay_basis, base, absence_basis,
  absence_divisor, ot_hours_per_day, ot_multiplier, ot_fixed_rate, holiday_mode, holiday_divisor,
  holiday_multiplier, holiday_fixed, note, created_by, created_at`;

// ── People: reading ─────────────────────────────────────────────────────────

// The loans of one person with what each owes: active loans from the ledger (outstanding and what is due
// this month), the rest summed from their own transactions.
async function loansOf(personId, month) {
  const loans = await q(
    `SELECT id, loan_no, principal, issued_on::text AS issued_on, purpose, instalment, first_due_month, paid_via,
            status, is_opening, note
       FROM hr.loans WHERE person_id = $1 ORDER BY issued_on DESC, id DESC`,
    [personId],
  );
  if (!loans.length) return [];
  const active = (await loanPositions(q, [personId], month)).get(personId) ?? [];
  const position = new Map(active.map((p) => [p.loan_id, p]));
  const rest = loans.filter((l) => !position.has(l.id));
  const txns = rest.length
    ? await q(`SELECT loan_id, kind, principal_amount::text AS principal_amount FROM hr.loan_txns WHERE loan_id = ANY($1::int[])`,
      [rest.map((l) => l.id)])
    : [];
  return loans.map((l) => {
    const now = position.get(l.id);
    return {
      ...l,
      outstanding: now ? now.outstanding : loanOutstanding(l, txns.filter((t) => t.loan_id === l.id)),
      due_this_month: now ? now.due : '0.00',
    };
  });
}

// One person with everything the drawer shows, or null. Operator and above get the account number, PAN, PF
// UAN and ESI number whole. A viewer's row has bank_last4 and no bank_account key at all, and pan, pf_uan and
// esi_no as '••••' plus their last four characters (null where there is none).
async function personDetail(id, level) {
  const whole = levelAtLeast(level, 'operator');
  const person = await one(
    `SELECT ${PERSON_COLS}, ${whole ? SECRETS_FULL : SECRETS_ENDS} FROM hr.people p WHERE p.id = $1`, [id]);
  if (!person) return null;
  if (!whole) for (const column of ID_NUMBERS) person[column] = maskAccount(person[column]);
  const month = plantDateStr().slice(0, 7);
  const setups = await q(
    `SELECT ${SETUP_COLS} FROM hr.pay_setups WHERE person_id = $1 ORDER BY effective_from DESC, id DESC`, [id]);
  const aliases = await q(
    `SELECT id, person_id, alias_norm, source, approved_by, approved_at FROM hr.person_aliases
      WHERE person_id = $1 ORDER BY id`, [id]);
  const advance = (await advanceBalances(q, [id])).get(id);
  const recent = await q(
    `SELECT r.month, l.gross, l.payable, l.payment_status
       FROM hr.run_lines l JOIN hr.runs r ON r.id = l.run_id
      WHERE l.person_id = $1 AND r.status = 'finalised'
      ORDER BY r.month DESC LIMIT 6`, [id]);
  return {
    ...person,
    current_setup: effectiveSetup(setups, month),
    setups,
    aliases,
    advance_balance: advance,
    loans: await loansOf(id, month),
    recent_lines: recent,
  };
}

// ?status= : nothing means every status; otherwise one status or a comma list of them.
function statusFilter(raw) {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw bad('status must be one status or a comma list of them');
  const wanted = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  const unknown = wanted.filter((s) => !STATUSES.includes(s));
  if (unknown.length) throw bad(`Unknown status: ${unknown.join(', ')}`);
  return wanted.length ? wanted : null;
}

r.get('/hr/me', requireHr('viewer'), (req, res) => {
  res.json({ level: req.hr.level, user: { id: req.user.id, name: req.user.name ?? null } });
});

r.get('/hr/people', requireHr('viewer'), async (req, res, next) => {
  try {
    const statuses = statusFilter(req.query.status);
    const people = await q(
      `SELECT ${LIST_COLS} FROM hr.people p ${statuses ? 'WHERE p.status = ANY($1::text[])' : ''}
        ORDER BY lower(p.name), p.id`,
      statuses ? [statuses] : [],
    );
    const setups = people.length
      ? await q(`SELECT ${SETUP_COLS} FROM hr.pay_setups WHERE person_id = ANY($1::int[]) ORDER BY person_id, effective_from DESC`,
        [people.map((p) => p.id)])
      : [];
    const byPerson = new Map();
    for (const s of setups) {
      if (!byPerson.has(s.person_id)) byPerson.set(s.person_id, []);
      byPerson.get(s.person_id).push(s);
    }
    const month = plantDateStr().slice(0, 7);
    res.json(people.map((p) => ({ ...p, current_setup: effectiveSetup(byPerson.get(p.id) ?? [], month) })));
  } catch (e) { next(e); }
});

r.get('/hr/people/:id', requireHr('viewer'), async (req, res, next) => {
  try {
    const person = await personDetail(idOf(req.params.id, 'Person'), req.hr.level);
    if (!person) throw missing('Person');
    res.json(person);
  } catch (e) { next(e); }
});

// ── People: writing ─────────────────────────────────────────────────────────

// [column, label, longest, tidy (inner spaces squashed)]
const PERSON_TEXT = [
  ['display_name', 'Display name', 120, true], ['father_name', "Father's name", 120, true],
  ['firm', 'Firm', 120, true], ['department', 'Department', 120, true], ['designation', 'Designation', 120, true],
  ['phone', 'Phone', 40, false], ['address', 'Address', 500, false],
  ['emergency_contact', 'Emergency contact', 200, false],
  ['bank_holder', 'Account holder', 120, true], ['bank_name', 'Bank name', 120, true],
  ['esi_no', 'ESI number', 40, false], ['notes', 'Notes', 2000, false],
];

// What a save may change, validated and tidied. Creating takes every field (an absent one is blank or its
// default); updating takes only the keys sent, so a client may send the whole record back or one field.
// Read-only keys a client echoes from a GET (id, legacy, bank_last4, setups ...) are simply not read.
function readPerson(body, creating) {
  const has = (key) => creating || Object.hasOwn(body, key);
  const out = {};
  if (has('code')) {
    const code = typeof body.code === 'string' || typeof body.code === 'number' ? normCode(body.code) : null;
    if (code === null) throw bad('Enter the payroll code');
    if (code.length > 40) throw bad('The payroll code is too long (at most 40 characters)');
    out.code = code;
  }
  if (has('name')) {
    const name = typeof body.name === 'string' ? squash(body.name) : '';
    if (!name) throw bad('Enter the name');
    if (name.length > 120) throw bad('The name is too long (at most 120 characters)');
    out.name = name;
  }
  for (const [column, label, longest, tidy] of PERSON_TEXT) {
    if (has(column)) out[column] = textOf(body[column], label, longest, tidy);
  }
  if (has('worker_type')) out.worker_type = choiceOf(body.worker_type, WORKER_TYPES, 'the worker type', creating ? 'employee' : undefined);
  if (has('status')) out.status = choiceOf(body.status, STATUSES, 'the status', creating ? 'active' : undefined);
  if (has('joined_on')) out.joined_on = dateOf(body.joined_on, 'The joining date');
  if (has('exited_on')) out.exited_on = dateOf(body.exited_on, 'The exit date');
  if (has('pay_channel')) out.pay_channel = textOf(body.pay_channel, 'The pay channel', 40);
  if (has('bank_account')) out.bank_account = compactOf(body.bank_account, 'The account number', 40);
  if (has('bank_ifsc')) out.bank_ifsc = compactOf(body.bank_ifsc, 'The IFSC', 20, true);
  if (has('esi_applicable')) out.esi_applicable = flagOf(body.esi_applicable, 'ESI applicable', false);
  if (has('pf_uan')) out.pf_uan = compactOf(body.pf_uan, 'The PF UAN', 40);
  if (has('pan')) out.pan = compactOf(body.pan, 'The PAN', 20, true);
  if (has('employee_id')) out.employee_id = employeeIdOf(body.employee_id);
  return out;
}

// The columns whose values never go into the audit trail.
const SECRET_COLUMNS = new Set(['bank_account', 'pan', 'pf_uan', 'esi_no']);

// The payroll code is unique as normCode() sees it, so '007' and '7' are one code. Everyone's code is
// read (a few dozen rows) and compared in JS, exactly as the importer compares them.
async function assertCodeFree(qc, code, selfId) {
  const people = await qc(`SELECT id, code FROM hr.people`);
  if (people.some((p) => p.id !== selfId && normCode(p.code) === code)) {
    throw fail(409, `Payroll code ${code} is already used by another person`, 'CODE_EXISTS');
  }
}

// The channel a person points at, by its exact code or (typed loosely) its normalised one. Returns the
// stored code. Nobody is paid through a channel that does not exist.
async function resolveChannel(oc, raw) {
  const found = await oc(
    `SELECT code FROM hr.pay_channels WHERE code = $1 OR code = $2 ORDER BY (code = $1) DESC LIMIT 1`,
    [raw, normName(raw)]);
  if (!found) throw bad(`There is no pay channel ${raw}. Add it in Settings first`);
  return found.code;
}

// The ERP operator a person is: it must exist (soft link, checked here) and be linked to one person only.
async function assertOperatorFree(oc, employeeId, selfId) {
  if (!(await oc(`SELECT id FROM public.employees WHERE id = $1`, [employeeId]))) {
    throw bad('That ERP operator does not exist');
  }
  const taken = await oc(
    `SELECT code, name FROM hr.people WHERE employee_id = $1 AND id IS DISTINCT FROM $2::int`, [employeeId, selfId]);
  if (taken) throw fail(409, `That ERP operator is already linked to ${taken.name} (${taken.code})`, 'EMPLOYEE_LINKED');
}

r.post('/hr/people', requireHr('operator'), async (req, res, next) => {
  try {
    const p = readPerson(bodyOf(req), true);
    if (p.joined_on && p.exited_on && p.exited_on < p.joined_on) throw bad('The exit date is before the joining date');
    const id = await tx(async (qc, oc) => {
      await lockNames(qc);
      await assertCodeFree(qc, p.code, null);
      await assertNameFree(qc, { personId: null, name: p.name, displayName: p.display_name });
      if (p.pay_channel) p.pay_channel = await resolveChannel(oc, p.pay_channel);
      if (p.employee_id !== null) await assertOperatorFree(oc, p.employee_id, null);
      const columns = Object.keys(p);
      const made = await oc(
        `INSERT INTO hr.people (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        columns.map((c) => p[c]));
      await hrAudit(qc, req, 'person', made.id, 'create', {
        code: p.code, name: p.name, worker_type: p.worker_type, status: p.status, pay_channel: p.pay_channel ?? null,
      });
      return made.id;
    });
    res.json(await personDetail(id, req.hr.level));
  } catch (e) { next(refusal(e)); }
});

r.put('/hr/people/:id', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Person');
    const incoming = readPerson(bodyOf(req), false);
    await tx(async (qc, oc) => {
      await lockNames(qc);
      const was = await oc(`SELECT ${PERSON_COLS}, ${SECRETS_FULL} FROM hr.people p WHERE p.id = $1 FOR UPDATE OF p`, [id]);
      if (!was) throw missing('Person');
      // A stored code that reads the same through normCode is the same code: saving a record back does
      // not re-case or re-zero a code the loader stored its own way.
      if ('code' in incoming && normCode(was.code) === incoming.code) delete incoming.code;
      if (incoming.pay_channel) incoming.pay_channel = await resolveChannel(oc, incoming.pay_channel);
      const changes = {};
      for (const [column, value] of Object.entries(incoming)) {
        if ((was[column] ?? null) !== (value ?? null)) changes[column] = value;
      }
      const columns = Object.keys(changes);
      if (!columns.length) return;
      const joined = 'joined_on' in changes ? changes.joined_on : was.joined_on;
      const exited = 'exited_on' in changes ? changes.exited_on : was.exited_on;
      if (joined && exited && exited < joined) throw bad('The exit date is before the joining date');
      if ('code' in changes) await assertCodeFree(qc, changes.code, id);
      if ('name' in changes || 'display_name' in changes) {
        await assertNameFree(qc, {
          personId: id,
          name: changes.name ?? was.name,
          displayName: 'display_name' in changes ? changes.display_name : was.display_name,
        });
      }
      if (changes.employee_id != null) await assertOperatorFree(oc, changes.employee_id, id);
      await oc(
        `UPDATE hr.people SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, ...columns.map((c) => changes[c])]);
      const shown = {};
      for (const c of columns) if (!SECRET_COLUMNS.has(c)) shown[c] = { from: was[c] ?? null, to: changes[c] ?? null };
      await hrAudit(qc, req, 'person', id, 'update', { fields: columns, changes: shown });
    });
    res.json(await personDetail(id, req.hr.level));
  } catch (e) { next(refusal(e)); }
});

// ── Pay setups ──────────────────────────────────────────────────────────────

// A pay revision, validated. Every numeric field is checked for sign and size whatever the pay basis or
// holiday mode (a negative multiplier is refused even where it would go unused); then the fields each
// basis and mode need must be there. What a mode does not use is stored as null.
function readSetup(body) {
  const from = typeof body.effective_from === 'string' ? body.effective_from.trim() : '';
  if (!/^\d{4}-\d{2}-01$/.test(from) || !MONTH.test(from.slice(0, 7))) {
    throw bad('effective_from must be the 1st of a month, like 2026-08-01');
  }
  const payBasis = choiceOf(body.pay_basis, PAY_BASES, 'the pay basis');
  const base = amountOf(body.base, 'The base pay', 2);
  const absenceBasis = choiceOf(body.absence_basis, ABSENCE_BASES, 'the absence basis', 'calendar_days');
  const absenceDivisor = amountOf(body.absence_divisor, 'The absence divisor', 4);
  const otHours = amountOf(body.ot_hours_per_day, 'OT hours per day', 4) ?? '0';
  const otMultiplier = amountOf(body.ot_multiplier, 'The OT multiplier', 4) ?? '1';
  const otFixedRate = amountOf(body.ot_fixed_rate, 'The OT fixed rate', 2);
  const holidayMode = choiceOf(body.holiday_mode, HOLIDAY_MODES, 'the holiday mode', 'none');
  const holidayDivisor = amountOf(body.holiday_divisor, 'The holiday divisor', 4);
  const holidayMultiplier = amountOf(body.holiday_multiplier, 'The holiday multiplier', 4);
  const holidayFixed = amountOf(body.holiday_fixed, 'The holiday amount', 2);
  const note = textOf(body.note, 'The note', 500);

  if (absenceDivisor !== null && Number(absenceDivisor) <= 0) throw bad('The absence divisor must be more than 0');
  if (holidayDivisor !== null && Number(holidayDivisor) <= 0) throw bad('The holiday divisor must be more than 0');
  if (Number(otHours) > 24) throw bad('OT hours per day cannot be more than 24');
  if (payBasis !== 'contract' && base === null) throw bad('Enter the base pay for this pay basis');
  if (absenceBasis === 'fixed_divisor' && absenceDivisor === null) throw bad('A fixed-divisor absence rule needs the divisor');
  if (holidayMode === 'formula' && (holidayDivisor === null || holidayMultiplier === null)) {
    throw bad('A holiday formula needs a divisor and a multiplier');
  }
  if (holidayMode === 'fixed' && holidayFixed === null) throw bad('A fixed holiday pay needs the amount');
  return {
    effective_from: from,
    pay_basis: payBasis,
    base,
    absence_basis: absenceBasis,
    absence_divisor: absenceBasis === 'fixed_divisor' ? absenceDivisor : null,
    ot_hours_per_day: otHours,
    ot_multiplier: otMultiplier,
    ot_fixed_rate: otFixedRate,
    holiday_mode: holidayMode,
    holiday_divisor: holidayMode === 'formula' ? holidayDivisor : null,
    holiday_multiplier: holidayMode === 'formula' ? holidayMultiplier : null,
    holiday_fixed: holidayMode === 'fixed' ? holidayFixed : null,
    note,
  };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
// '2026-08' -> 'August 2026'
const monthName = (month) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

// There is no PUT for a setup: a revision is a new setup from a later month, and a setup a finalised run
// used is never edited. A revision may still be dated on or before the latest FINALISED month (T9-d): it is
// saved, and the answer carries a `warning`, because that month is locked and the revision can never change
// it. The way to put the difference right is an arrears adjustment in an open month.
r.post('/hr/people/:id/setups', requireHr('operator'), async (req, res, next) => {
  try {
    const personId = idOf(req.params.id, 'Person');
    const s = readSetup(bodyOf(req));
    const { row, warning } = await tx(async (qc, oc) => {
      if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [personId]))) throw missing('Person');
      if (await oc(`SELECT id FROM hr.pay_setups WHERE person_id = $1 AND effective_from = $2::date`, [personId, s.effective_from])) {
        throw fail(409, `This person already has a pay setup from ${s.effective_from.slice(0, 7)}. Add a revision from another month`, 'SETUP_EXISTS');
      }
      const columns = Object.keys(s);
      const made = await oc(
        `INSERT INTO hr.pay_setups (person_id, created_by, ${columns.join(', ')})
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING ${SETUP_COLS}`,
        [personId, req.user.id, ...columns.map((c) => s[c])]);
      const locked = await oc(`SELECT month FROM hr.runs WHERE status = 'finalised' ORDER BY month DESC LIMIT 1`);
      const behind = locked !== null && s.effective_from.slice(0, 7) <= locked.month;
      await hrAudit(qc, req, 'pay_setup', made.id, 'create', {
        person_id: personId, ...s, ...(behind ? { locked_through: locked.month } : {}),
      });
      return {
        row: made,
        warning: behind
          ? `This revision starts on or before ${monthName(locked.month)}, which is locked; locked months are not changed — add an arrears adjustment if needed.`
          : null,
      };
    });
    res.json(warning ? { ...row, warning } : row);
  } catch (e) { next(refusal(e)); }
});

// ── Aliases ─────────────────────────────────────────────────────────────────

r.post('/hr/people/:id/aliases', requireHr('operator'), async (req, res, next) => {
  try {
    const personId = idOf(req.params.id, 'Person');
    const body = bodyOf(req);
    if (typeof body.alias !== 'string') throw bad('Send the spelling as { "alias": "..." }');
    const spelling = normName(body.alias);
    if (!spelling) throw bad('Enter the spelling');
    if (spelling.length > 120) throw bad('That spelling is too long (at most 120 characters)');
    const row = await tx(async (qc, oc) => {
      await lockNames(qc);
      if (!(await oc(`SELECT id FROM hr.people WHERE id = $1`, [personId]))) throw missing('Person');
      await assertAliasFree(qc, spelling);
      const held = await oc(
        `SELECT a.person_id, p.code, p.name FROM hr.person_aliases a JOIN hr.people p ON p.id = a.person_id WHERE a.alias_norm = $1`,
        [spelling]);
      if (held) {
        throw fail(409, `${spelling} is already an approved spelling of ${held.name} (${held.code})`, 'ALIAS_EXISTS');
      }
      const made = await oc(
        `INSERT INTO hr.person_aliases (person_id, alias_norm, source, approved_by)
         VALUES ($1, $2, 'manual', $3) RETURNING id, person_id, alias_norm, source, approved_by, approved_at`,
        [personId, spelling, req.user.id]);
      await hrAudit(qc, req, 'alias', made.id, 'create', { person_id: personId, alias: spelling });
      return made;
    });
    res.json(row);
  } catch (e) { next(refusal(e)); }
});

r.delete('/hr/aliases/:id', requireHr('operator'), async (req, res, next) => {
  try {
    const id = idOf(req.params.id, 'Alias');
    await tx(async (qc, oc) => {
      await lockNames(qc);
      const gone = await oc(`DELETE FROM hr.person_aliases WHERE id = $1 RETURNING person_id, alias_norm`, [id]);
      if (!gone) throw missing('Alias');
      await hrAudit(qc, req, 'alias', id, 'delete', { person_id: gone.person_id, alias: gone.alias_norm });
    });
    res.json({ ok: true });
  } catch (e) { next(refusal(e)); }
});

// ── Settings ────────────────────────────────────────────────────────────────

// The keys Settings may change, each with its rule. An unknown key is refused (a typo must not look saved).
// blank_zero is keyed by the monthly sheet's number columns (import-parse FIELDS), one true / false each.
const BLANK_ZERO_KEYS = new Set(FIELDS.filter((f) => f.kind === 'number').map((f) => f.key));

function settingNumber(raw, label, { positive = false, max = 1_000_000 } = {}) {
  const text = amountOf(typeof raw === 'number' || typeof raw === 'string' ? raw : null, label, 4);
  if (text === null) throw bad(`${label} must be a number`);
  const value = Number(text);
  if (positive && value <= 0) throw bad(`${label} must be more than 0`);
  if (value > max) throw bad(`${label} must be at most ${max}`);
  return value;
}

const SETTING_RULES = new Map([
  ['rounding', (v) => {
    if (v !== 'rupee' && v !== 'paise') throw bad('Rounding must be rupee or paise');
    return v;
  }],
  ['ot_high_hours', (v) => settingNumber(v, 'The high-OT warning')],
  ['deduction_warn_pct', (v) => settingNumber(v, 'The deductions warning', { max: 100 })],
  ['variance_warn_pct', (v) => settingNumber(v, 'The change-on-last-month warning')],
  ['holiday_divisor_default', (v) => settingNumber(v, 'The default holiday divisor', { positive: true })],
  ['strict_separation', (v) => {
    if (typeof v !== 'boolean') throw bad('Strict separation must be true or false');
    return v;
  }],
  ['blank_zero', (v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('blank_zero must be an object of true / false values');
    for (const [key, on] of Object.entries(v)) {
      if (!BLANK_ZERO_KEYS.has(key)) throw bad(`blank_zero has no column ${key}`);
      if (typeof on !== 'boolean') throw bad(`blank_zero.${key} must be true or false`);
    }
    return { ...v };
  }],
]);

async function settingsObject() {
  const rows = await q(`SELECT key, value FROM hr.settings ORDER BY key`);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

r.get('/hr/settings', requireHr('viewer'), async (_req, res, next) => {
  try { res.json(await settingsObject()); } catch (e) { next(e); }
});

r.put('/hr/settings', requireHr('admin'), async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const keys = Object.keys(body);
    if (!keys.length) throw bad('Nothing to save');
    const unknown = keys.filter((k) => !SETTING_RULES.has(k));
    if (unknown.length) throw bad(`Unknown setting: ${unknown.join(', ')}`);
    const values = Object.fromEntries(keys.map((k) => [k, SETTING_RULES.get(k)(body[k])]));
    await tx(async (qc) => {
      const stored = await qc(`SELECT key, value FROM hr.settings WHERE key = ANY($1::text[]) FOR UPDATE`, [keys]);
      const was = new Map(stored.map((row) => [row.key, row.value]));
      for (const key of keys) {
        if (was.has(key) && isDeepStrictEqual(was.get(key), values[key])) continue;
        await qc(
          `INSERT INTO hr.settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(values[key]), req.user.id]);
        await hrAudit(qc, req, 'setting', key, 'update', { from: was.get(key) ?? null, to: values[key] });
      }
    });
    res.json(await settingsObject());
  } catch (e) { next(refusal(e)); }
});

// ── Pay channels ────────────────────────────────────────────────────────────

const CHANNEL_COLS = `code, label, kind, bank_name, account, active, created_at`;

// A channel as it leaves the server: the account masked.
const channelOut = ({ account, ...channel }) => ({ ...channel, account: maskAccount(account) });

const findChannel = (oc, raw, lock = false) => oc(
  `SELECT ${CHANNEL_COLS} FROM hr.pay_channels WHERE code = $1 OR code = $2 ORDER BY (code = $1) DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
  [raw, normName(raw)]);

function readChannelCode(raw) {
  const code = typeof raw === 'string' ? normName(raw) : '';
  if (!code) throw bad('Enter the channel code');
  if (code.length > 40) throw bad('The channel code is too long (at most 40 characters)');
  return code;
}

function readChannelLabel(raw) {
  const label = textOf(raw, 'The channel name', 80, true);
  if (label === null) throw bad('Enter the channel name');
  return label;
}

r.get('/hr/pay-channels', requireHr('viewer'), async (_req, res, next) => {
  try {
    res.json((await q(`SELECT ${CHANNEL_COLS} FROM hr.pay_channels ORDER BY code`)).map(channelOut));
  } catch (e) { next(e); }
});

r.post('/hr/pay-channels', requireHr('admin'), async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const code = readChannelCode(body.code);
    const label = readChannelLabel(body.label);
    const channelType = choiceOf(body.kind, CHANNEL_TYPES, 'the channel type');
    const bankName = textOf(body.bank_name, 'The bank name', 80, true);
    const account = compactOf(body.account, 'The account number', 40);
    const active = flagOf(body.active, 'Active', true);
    if (channelType === 'cash' && account !== null) throw bad('A cash channel has no bank account');
    const row = await tx(async (qc, oc) => {
      if (await findChannel(oc, code)) throw fail(409, `A pay channel with code ${code} already exists`, 'CODE_EXISTS');
      const made = await oc(
        `INSERT INTO hr.pay_channels (code, label, kind, bank_name, account, active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${CHANNEL_COLS}`,
        [code, label, channelType, channelType === 'cash' ? null : bankName, account, active]);
      await hrAudit(qc, req, 'pay_channel', code, 'create', {
        label, channel_type: channelType, bank_name: made.bank_name, active, has_account: account !== null,
      });
      return made;
    });
    res.json(channelOut(row));
  } catch (e) { next(refusal(e)); }
});

// The stored account is kept when `account` is left out (or sent blank): the list only ever shows it
// masked, so a client cannot send it back. `account: null` clears it. A code is permanent.
r.put('/hr/pay-channels/:code', requireHr('admin'), async (req, res, next) => {
  try {
    const body = bodyOf(req);
    const has = (key) => Object.hasOwn(body, key);
    const row = await tx(async (qc, oc) => {
      const was = await findChannel(oc, req.params.code, true);
      if (!was) throw missing('Pay channel');
      const now = { ...was };
      if (has('label')) now.label = readChannelLabel(body.label);
      if (has('kind')) now.kind = choiceOf(body.kind, CHANNEL_TYPES, 'the channel type');
      if (has('bank_name')) now.bank_name = textOf(body.bank_name, 'The bank name', 80, true);
      if (has('active')) now.active = flagOf(body.active, 'Active', was.active);
      if (has('account')) {
        const account = compactOf(body.account, 'The account number', 40);
        if (account !== null) now.account = account;
        else if (body.account === null) now.account = null;
      }
      if (now.kind === 'cash') {
        if (has('account') && compactOf(body.account, 'The account number', 40) !== null) throw bad('A cash channel has no bank account');
        now.bank_name = null;
        now.account = null;
      }
      const changed = ['label', 'kind', 'bank_name', 'account', 'active'].filter((c) => now[c] !== was[c]);
      if (!changed.length) return was;
      const saved = await oc(
        `UPDATE hr.pay_channels SET label = $2, kind = $3, bank_name = $4, account = $5, active = $6
          WHERE code = $1 RETURNING ${CHANNEL_COLS}`,
        [was.code, now.label, now.kind, now.bank_name, now.account, now.active]);
      const shown = {};
      for (const c of changed) if (c !== 'account') shown[c] = { from: was[c], to: now[c] };
      await hrAudit(qc, req, 'pay_channel', was.code, 'update', { fields: changed, changes: shown });
      return saved;
    });
    res.json(channelOut(row));
  } catch (e) { next(refusal(e)); }
});

// ── Access ──────────────────────────────────────────────────────────────────

// Every ERP login with its HR level (null: none). Switched-off logins are listed too, so a level can be
// cleared from one; the guard itself ignores them (hrAccessFor needs users.active = 1).
const accessList = () => q(
  `SELECT u.id AS user_id, u.id, u.name, u.email, u.role, u.active, a.level
     FROM public.users u LEFT JOIN hr.access a ON a.user_id = u.id
    ORDER BY lower(u.name), u.id`);

r.get('/hr/access', requireHr('admin'), async (_req, res, next) => {
  try { res.json(await accessList()); } catch (e) { next(e); }
});

// {level} sets it, {level: null} takes the access away. HR must never be left without an admin who can sign
// in: removing or demoting an admin is refused (409 LAST_ADMIN) unless another admin has an active ERP
// login. Changes run one at a time (ACCESS_LOCK), so two admins cannot demote each other at once.
r.put('/hr/access/:userId', requireHr('admin'), async (req, res, next) => {
  try {
    const userId = idOf(req.params.userId, 'User');
    const body = bodyOf(req);
    if (!Object.hasOwn(body, 'level')) throw bad('Send { "level": "viewer" | "operator" | "approver" | "admin" | null }');
    const level = body.level === null || body.level === '' ? null : body.level;
    if (level !== null && !HR_LEVELS.includes(level)) throw bad(`level must be one of ${HR_LEVELS.join(', ')}, or null to remove access`);
    const note = textOf(body.note, 'The note', 200);
    await tx(async (qc, oc) => {
      await qc(ACCESS_LOCK);
      const user = await oc(`SELECT id, name FROM public.users WHERE id = $1`, [userId]);
      if (!user) throw missing('User');
      const was = (await oc(`SELECT level FROM hr.access WHERE user_id = $1 FOR UPDATE`, [userId]))?.level ?? null;
      if (was === level) return;
      if (was === 'admin') {
        const others = await oc(
          `SELECT count(*)::int AS n FROM hr.access a JOIN public.users u ON u.id = a.user_id
            WHERE a.level = 'admin' AND u.active = 1 AND a.user_id <> $1`, [userId]);
        if (others.n === 0) {
          throw fail(409, 'HR needs at least one admin who can sign in. Make someone else an admin first', 'LAST_ADMIN');
        }
      }
      if (level === null) {
        await qc(`DELETE FROM hr.access WHERE user_id = $1`, [userId]);
      } else {
        await qc(
          `INSERT INTO hr.access (user_id, level, granted_by, granted_at, note) VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (user_id) DO UPDATE SET level = EXCLUDED.level, granted_by = EXCLUDED.granted_by,
             granted_at = now(), note = COALESCE(EXCLUDED.note, hr.access.note)`,
          [userId, level, req.user.id, note]);
      }
      await hrAudit(qc, req, 'access', userId, level === null ? 'revoke' : was === null ? 'grant' : 'change',
        { user: user.name, from: was, to: level });
    });
    res.json(await accessList());
  } catch (e) { next(refusal(e)); }
});

// ── Audit ───────────────────────────────────────────────────────────────────

// Newest first. Filter by entity (person, pay_setup, alias, setting, pay_channel, access, run ...) and its id.
r.get('/hr/audit', requireHr('approver'), async (req, res, next) => {
  try {
    const wanted = (value, label) => {
      if (value !== undefined && typeof value !== 'string') throw bad(`${label} must be text`);
      return optionalText(value);
    };
    const entity = wanted(req.query.entity, 'entity');
    const entityId = wanted(req.query.entity_id, 'entity_id');
    const asked = req.query.limit;
    if (asked !== undefined && !(typeof asked === 'string' && /^[1-9][0-9]{0,3}$/.test(asked))) throw bad('limit must be a number from 1 to 1000');
    const limit = Math.min(asked === undefined ? 200 : Number(asked), 1000);
    res.json(await q(
      `SELECT id, at, user_id, user_name, entity, entity_id, action, detail
         FROM hr.audit_log
        WHERE ($1::text IS NULL OR entity = $1) AND ($2::text IS NULL OR entity_id = $2)
        ORDER BY id DESC LIMIT $3`,
      [entity, entityId, limit]));
  } catch (e) { next(e); }
});

// ── Dashboard (spec §14) ────────────────────────────────────────────────────

const ZERO = rat(0);
const exact = (value) => fmtPaise(toPaise(value));
const LEVEL_ORDER = { block: 0, warn: 1, info: 2 };

// What is still owed in the ledgers: the count of loans and of people with a balance above zero, and the
// totals, worked out exactly by the ledger code (never summed as floats).
async function owedLoans(month) {
  const holders = await q(`SELECT DISTINCT person_id FROM hr.loans WHERE status = 'active'`);
  const positions = await loanPositions(q, holders.map((h) => h.person_id), month);
  let count = 0;
  let total = ZERO;
  for (const list of positions.values()) {
    for (const loan of list) {
      const owed = rat(loan.outstanding);
      if (cmp(owed, ZERO) > 0) { count += 1; total = add(total, owed); }
    }
  }
  return { count, outstanding: exact(total) };
}

async function owedAdvances() {
  const holders = await q(`SELECT DISTINCT person_id FROM hr.advance_txns`);
  const balances = await advanceBalances(q, holders.map((h) => h.person_id));
  let count = 0;
  let total = ZERO;
  for (const balance of balances.values()) {
    const owed = rat(balance);
    if (cmp(owed, ZERO) > 0) { count += 1; total = add(total, owed); }
  }
  return { count, outstanding: exact(total) };
}

// Headcount is as people stand now (status), except joined / exited this month, which count dates inside the
// month asked for. The run is the month's own, with its stored totals (exact strings, a split by channel).
// Payments are read only for a finalised run: before that nothing is waiting to be paid. Exceptions count
// people by the flags on the run's lines, plus those with no pay setup in force and the import rows still
// waiting for a decision. Read only; nothing here writes.
r.get('/hr/dashboard', requireHr('viewer'), async (req, res, next) => {
  try {
    const asked = req.query.month;
    if (asked !== undefined && !(typeof asked === 'string' && MONTH.test(asked))) throw bad('month must look like 2026-08');
    const month = asked ?? plantDateStr().slice(0, 7);
    const first = `${month}-01`;

    const headcount = await one(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'on_leave')::int AS on_leave,
              count(*) FILTER (WHERE status = 'exited')::int AS exited,
              count(*) FILTER (WHERE joined_on >= $1::date AND joined_on < ($1::date + interval '1 month')::date)::int AS joined_this_month,
              count(*) FILTER (WHERE exited_on >= $1::date AND exited_on < ($1::date + interval '1 month')::date)::int AS exited_this_month
         FROM hr.people`, [first]);
    const run = await one(
      `SELECT id, month, status, days_in_month, engine_version, prepared_at, submitted_at, approved_at, finalised_at,
              sent_back_at, sent_back_reason, totals
         FROM hr.runs WHERE month = $1`, [month]);

    const exceptions = { lines: 0, blocked: 0, warned: 0, by_code: [], people_without_setup: 0, unresolved_import_rows: 0 };
    let payments = null;
    if (run) {
      const counts = await one(
        `SELECT count(*)::int AS lines,
                count(*) FILTER (WHERE flags @> '[{"level":"block"}]'::jsonb)::int AS blocked,
                count(*) FILTER (WHERE flags @> '[{"level":"warn"}]'::jsonb AND NOT flags @> '[{"level":"block"}]'::jsonb)::int AS warned
           FROM hr.run_lines WHERE run_id = $1`, [run.id]);
      const byCode = await q(
        `SELECT f.flag->>'level' AS level, f.flag->>'code' AS code, count(DISTINCT l.person_id)::int AS people
           FROM hr.run_lines l
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.flags) = 'array' THEN l.flags ELSE '[]'::jsonb END) AS f(flag)
          WHERE l.run_id = $1 AND f.flag->>'code' IS NOT NULL
          GROUP BY 1, 2`, [run.id]);
      Object.assign(exceptions, counts, {
        by_code: byCode.sort((a, b) => (LEVEL_ORDER[a.level] ?? 3) - (LEVEL_ORDER[b.level] ?? 3)
          || b.people - a.people || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
      });
      if (run.status === 'finalised') {
        payments = await one(
          `SELECT count(*) FILTER (WHERE payment_status = 'paid')::int AS paid_lines,
                  COALESCE(sum(payable) FILTER (WHERE payment_status = 'paid'), 0)::text AS paid_amount,
                  count(*) FILTER (WHERE payment_status <> 'paid' AND payable > 0)::int AS pending_lines,
                  COALESCE(sum(payable) FILTER (WHERE payment_status <> 'paid' AND payable > 0), 0)::text AS pending_amount
             FROM hr.run_lines WHERE run_id = $1`, [run.id]);
      }
    }
    exceptions.people_without_setup = (await one(
      `SELECT count(*)::int AS n FROM hr.people p
        WHERE p.status <> 'exited'
          AND NOT EXISTS (SELECT 1 FROM hr.pay_setups s WHERE s.person_id = p.id AND s.effective_from <= $1::date)`,
      [first])).n;
    exceptions.unresolved_import_rows = (await one(
      `SELECT count(*)::int AS n
         FROM hr.import_rows ir JOIN hr.import_batches b ON b.id = ir.batch_id
        WHERE b.month = $1 AND b.status = 'parsed' AND ir.decision IS NULL
          AND ir.match IN ('conflict', 'unknown_code', 'ambiguous', 'unmatched')`, [month])).n;

    res.json({
      month,
      headcount,
      run,
      payments,
      loans: await owedLoans(month),
      advances: await owedAdvances(),
      exceptions,
    });
  } catch (e) { next(e); }
});

// ── The ERP operator list ───────────────────────────────────────────────────

// The employees the plant floor knows, for linking a person to an ERP operator. Reads public.employees and
// changes nothing there. Inactive operators are listed (with active = 0) so an existing link still shows.
r.get('/hr/erp-operators', requireHr('operator'), async (_req, res, next) => {
  try {
    res.json(await q(`SELECT id, name, section, active FROM public.employees ORDER BY lower(name), id`));
  } catch (e) { next(e); }
});

export default r;
