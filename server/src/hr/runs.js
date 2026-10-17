// Payroll runs (spec §12): one run per month. A draft is recalculated from its inputs as often as
// wanted, and nothing a recalculation does touches a ledger. Finalising an approved run is the ONE place a
// payroll posts to the advance and loan ledgers: once, in the caller's transaction, all or nothing.
//
//   ensureRun(qc, month, userId)        the month's run; a new draft if there is none
//   recalcRun(qc, run, {personIds})     recompute a draft's lines (everyone, or the people named), store them
//   finaliseRun(qc, run, req)           approved → finalised: recompute, check nothing moved, post, stamp, audit
//   linesHash(line)                     sha256 over the engine inputs that decide a line's pay
//
// `qc` is the query function of the caller's transaction (db.js tx()); nothing here uses the pool, which
// on Vercel's one-client pool would wait on itself inside a transaction.
//
// One line per included person (run_inputs.include = true). Its engine input is built from:
//   person     status, joined_on, exited_on, pay channel kind, whether bank details are on file
//   setup      the pay setup in force for the month (effectiveSetup); a formula holiday with no divisor
//              takes the policy's holiday_divisor_default (Ruling T2-h)
//   inputs     run_inputs, with advance_given replaced by the month's NEW advance (spec §9 item 7):
//              'extra' → the sheet's figure; 'total' (default) → max(0, sheet − in-app advances of the
//              month), warning ADVANCE_BELOW_RECORDED when the sheet is below what the app recorded
//   balances   the posted advance balance; each active loan oldest first with its due and outstanding
//   adjustments  approved ones covering the month, by id
//   policy     runs.policy: refreshed from hr.settings by every draft recalculation, frozen from submit on
//              (Ruling T7-b)
//   previous   the person's line in the latest finalised run before this month (only for VARIANCE)
// inputs_hash is linesHash() of all of it but `previous`, plus the engine version: everything that decides
// pay. If computeLine throws for one person (input it refuses), that person's line is stored with zero
// amounts and the block flag ENGINE_ERROR carrying the message, and the rest of the run goes on (T2-d).
//
// Finalising locks, in this order: the run row (FOR UPDATE), then the run's people and their loans
// (FOR UPDATE, ascending id). Any insert into advance_txns or loan_txns for those people takes a KEY SHARE
// lock on the same rows, so the ledgers cannot move between the recompute and the postings. A writer that
// REDUCES a balance (waive, prepay) must take the same lock before it reads the balance it checks against.
//
// Postings are dated in plant time: an advance from the month's sheet on the month's last day (or today,
// if that is earlier), a recovery on the day it was finalised, because it was worked out from the balance
// as it stood that day. A payroll_recovery is found by its run, never its date (loans.js). In the same
// transaction, every loan those recoveries pay off (outstanding exactly 0) is closed, each with its own
// audit row (Ruling T7-d).
//
// Months go forward only (Ruling T7-c): once a month is finalised, no earlier month can be started
// (ensureRun) or finalised (finaliseRun): 409 MONTH_BEFORE_FINALISED. A correction to an old month goes
// into the next open month as an adjustment. A run left behind that way (made by hand, or created in a
// race with a later finalise) can never post, so it does not hold later months back: PREVIOUS_MONTH_OPEN
// looks only at runs after the latest finalised month.
//
// runs.totals carries its money as exact 2-dp decimal strings ('46758.00'), never JS numbers: the API
// passes them through and the client formats strings (Ruling T7-e).
//
// Refusals carry their code twice: err.code for callers in process, and err.body.code, because app.js's
// error handler sends `{ error: err.message, ...err.body }` and nothing else.

import { createHash } from 'node:crypto';
import { computeLine, effectiveSetup, daysInMonthOf, ENGINE_VERSION } from './engine.js';
import { rat, sub, neg, cmp, toPaise, fmtPaise, fmtDecimal } from './money.js';
import { advanceBalances, loanPositions, inAppAdvancesInMonth } from './ledger.js';
import { loanOutstanding } from './loans.js';
import { hrAudit } from './audit.js';
import { PLANT_TODAY_SQL } from '../plant-calendar.js';

const ZERO = rat(0);
const INT4_MAX = 2147483647;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// ── Small helpers ─────────────────────────────────────────────────────

function fail(status, code, message, more = {}) {
  return Object.assign(new Error(message), { status, code, body: { code, ...more } });
}

const given = (v) => v !== null && v !== undefined;
const money = (v) => (given(v) ? fmtPaise(toPaise(rat(v))) : null);       // exact, to paise: '1500.00'
const qty = (v) => (given(v) ? fmtDecimal(rat(v)) : null);                 // exact: '8', '71.5517'
const paise = (v) => (given(v) ? toPaise(rat(v)) : null);

// An int4 id, from a number or a numeric string; anything else is null.
function idOrNull(raw) {
  const id = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(id) && id > 0 && id <= INT4_MAX ? id : null;
}

function runIdOf(run) {
  const raw = run !== null && typeof run === 'object' ? run.id : run;
  const id = idOrNull(raw);
  if (id === null) throw new TypeError(`runs: not a run id: ${JSON.stringify(raw)}`);
  return id;
}

function idsOf(personIds) {
  if (!Array.isArray(personIds)) throw new TypeError('runs: personIds must be an array of person ids');
  const ids = personIds.map((raw) => {
    const id = idOrNull(raw);
    if (id === null) throw new TypeError(`runs: not a person id: ${JSON.stringify(raw)}`);
    return id;
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

const INDIAN = new Intl.NumberFormat('en-IN');
// '1234567.50' → '₹12,34,567.50' (the whole part through Intl as a BigInt, so it stays exact).
function inr(text) {
  const minus = text.startsWith('-');
  const [whole, fraction] = (minus ? text.slice(1) : text).split('.');
  return `${minus ? '-' : ''}₹${INDIAN.format(BigInt(whole))}.${fraction}`;
}

const LEVEL_RANK = { block: 0, warn: 1, info: 2 };
const byLevel = (flags) => [...flags].sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3));
const isBlocked = (flags) => (flags || []).some((f) => f?.level === 'block');

// ── linesHash ─────────────────────────────────────────────────────────

// Canonical JSON: object keys sorted at every depth, no spaces, a property whose value is undefined left
// out (as JSON.stringify does). Only plain objects, arrays, strings, finite numbers, booleans and null can
// be hashed: anything else (a Date, a BigInt, a Map, NaN) would have no single spelling, or would hash as
// {} and collide, so it throws.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`linesHash: ${value} has no JSON spelling`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    }
  }
  const kind = typeof value === 'object' ? Object.prototype.toString.call(value) : typeof value;
  throw new TypeError(`linesHash: cannot hash a ${kind}`);
}

export function linesHash(line) {
  return createHash('sha256').update(canonical(line)).digest('hex');
}

// ── Policy ────────────────────────────────────────────────────────────

const POLICY_KEYS = ['rounding', 'ot_high_hours', 'deduction_warn_pct', 'variance_warn_pct', 'holiday_divisor_default'];
const ENGINE_POLICY_KEYS = ['rounding', 'ot_high_hours', 'deduction_warn_pct', 'variance_warn_pct'];
const HOLIDAY_DIVISOR_DEFAULT = '30.5';             // the seeded setting, should its row ever be missing

// The policy keys from hr.settings, as stored (JSON values); a missing key stays missing.
async function currentPolicy(qc) {
  const rows = await qc(`SELECT key, value FROM hr.settings WHERE key = ANY($1::text[]) ORDER BY key`, [POLICY_KEYS]);
  const policy = {};
  for (const r of rows) if (given(r.value)) policy[r.key] = r.value;
  return policy;
}

const enginePolicy = (policy) => Object.fromEntries(
  ENGINE_POLICY_KEYS.filter((k) => given(policy[k])).map((k) => [k, policy[k]]),
);

// ── The engine input, person by person ────────────────────────────────

const INPUT_QTY = ['ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked'];
const INPUT_MONEY = ['misc_earning', 'misc_deduction', 'bonus', 'bill_amount', 'holiday_override', 'paid_separately',
  'advance_recovery_override', 'loan_recovery_override'];
const INPUT_SELECT = [...INPUT_QTY, ...INPUT_MONEY, 'advance_given'].map((c) => `${c}::text AS ${c}`).join(', ');

function engineSetup(row, policy) {
  const setup = {
    id: row.id,
    pay_basis: row.pay_basis,
    base: money(row.base),
    absence_basis: row.absence_basis,
    absence_divisor: qty(row.absence_divisor),
    ot_hours_per_day: qty(row.ot_hours_per_day),
    ot_multiplier: qty(row.ot_multiplier),
    ot_fixed_rate: money(row.ot_fixed_rate),
    holiday_mode: row.holiday_mode,
    holiday_divisor: qty(row.holiday_divisor),
    holiday_multiplier: qty(row.holiday_multiplier),
    holiday_fixed: money(row.holiday_fixed),
  };
  if (setup.holiday_mode === 'formula' && setup.holiday_divisor === null) {
    setup.holiday_divisor = qty(given(policy.holiday_divisor_default) ? policy.holiday_divisor_default : HOLIDAY_DIVISOR_DEFAULT);
  }
  return setup;
}

// The month's NEW advance and, when the sheet is below what the app already recorded, the warning.
function newAdvance(row, recorded) {
  if (row.advance_mode !== 'total' && row.advance_mode !== 'extra') {
    throw new TypeError(`advance_mode must be total or extra, got ${JSON.stringify(row.advance_mode)}`);
  }
  const sheet = money(row.advance_given);
  if (row.advance_mode === 'extra' || sheet === null) return { advance: sheet, flag: null };
  const rest = sub(rat(sheet), rat(recorded));
  if (cmp(rest, ZERO) >= 0) return { advance: money(rest), flag: null };
  return {
    advance: money(ZERO),
    flag: {
      level: 'warn',
      code: 'ADVANCE_BELOW_RECORDED',
      message: `The sheet's advance of ${inr(sheet)} is less than the ${inr(money(recorded))} already given in the app `
        + 'this month, so nothing more is added; the advances given in the app are still recovered',
    },
  };
}

function engineInputs(row, advance) {
  const inputs = {};
  for (const k of INPUT_QTY) inputs[k] = qty(row[k]);
  for (const k of INPUT_MONEY) inputs[k] = money(row[k]);
  inputs.advance_given = advance;
  return inputs;
}

const engineAdjustment = (a) => ({
  id: a.id,
  kind: a.kind,
  label: [a.description, a.category].find((v) => typeof v === 'string' && v.trim() !== '') ?? null,
  amount: money(a.amount),
});

const enginePrevious = (l) => ({
  gross: money(l.gross),
  components: { BASIC: money(l.basic), OT: money(l.ot_amount), HOLIDAY: money(l.holiday_amount), MISC: money(l.misc_earning) },
});

// ── Lines as stored ───────────────────────────────────────────────────

// Every amount of an engine result (engine.js MONEY_FIELDS), each a run_lines NUMERIC(12,2) column.
const LINE_MONEY = ['daily_rate', 'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings',
  'gross', 'misc_deduction', 'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions',
  'paid_separately', 'net_before_cap', 'net', 'payable', 'rounding', 'advance_given', 'carried_advance'];
const MONEY_CAP = rat('10000000000');               // NUMERIC(12,2) holds less than 10^10

const LINE_COLUMNS = [
  ['person_id', 'integer'], ['pay_setup_id', 'integer'], ['engine_version', 'text'], ['inputs_hash', 'text'],
  ['days', 'numeric'], ['present_days', 'numeric'], ['days_not_employed', 'numeric'],
  ...LINE_MONEY.map((c) => [c, 'numeric']),
  ['loan_recoveries', 'jsonb'], ['unrecovered', 'jsonb'], ['flags', 'jsonb'], ['breakdown', 'jsonb'],
  ['exact', 'jsonb'], ['pay_channel', 'text'],
];
const LINE_NAMES = LINE_COLUMNS.map(([c]) => c);

// Every line in one statement, in person order (so the people rows its foreign keys touch are locked in
// the same order finaliseRun locks them). Payment columns are never written here.
const UPSERT_LINES = `
  INSERT INTO hr.run_lines (run_id, ${LINE_NAMES.join(', ')})
  SELECT $1::integer, ${LINE_NAMES.map((c) => `x.${c}`).join(', ')}
    FROM jsonb_to_recordset($2::jsonb) AS x(${LINE_COLUMNS.map(([c, t]) => `${c} ${t}`).join(', ')})
   ORDER BY x.person_id
  ON CONFLICT (run_id, person_id) DO UPDATE SET
    ${LINE_NAMES.filter((c) => c !== 'person_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
    computed_at = now()
  RETURNING *`;

function lineRow(ctx, personId, setupId, hash, result, extraFlags) {
  const line = {
    person_id: personId,
    pay_setup_id: setupId,
    engine_version: result.engine_version,
    inputs_hash: hash,
    days: String(ctx.daysInMonth),
    present_days: result.present_days,
    days_not_employed: result.days_not_employed,
    ...Object.fromEntries(LINE_MONEY.map((k) => [k, result[k]])),
    loan_recoveries: result.loan_recoveries,
    unrecovered: result.unrecovered,
    flags: byLevel([...result.flags, ...extraFlags]),
    breakdown: result.components,
    exact: result.exact,
    pay_channel: ctx.people.get(personId)?.pay_channel ?? null,
  };
  for (const k of LINE_MONEY) {
    const v = rat(line[k]);
    if (cmp(v, MONEY_CAP) >= 0 || cmp(v, neg(MONEY_CAP)) <= 0) {
      throw new RangeError(`${k} of ${line[k]} is too large to store`);
    }
  }
  return line;
}

function errorRow(ctx, personId, setupId, hash, error) {
  return {
    person_id: personId,
    pay_setup_id: setupId,
    engine_version: ENGINE_VERSION,
    inputs_hash: hash,
    days: String(ctx.daysInMonth),
    present_days: '0',
    days_not_employed: '0',
    ...Object.fromEntries(LINE_MONEY.map((k) => [k, money(ZERO)])),
    loan_recoveries: [],
    unrecovered: { advance: money(ZERO), loans: [], other: money(ZERO) },
    flags: [{ level: 'block', code: 'ENGINE_ERROR', message: String(error?.message ?? error) }],
    breakdown: [],
    exact: null,
    pay_channel: ctx.people?.get(personId)?.pay_channel ?? null,
  };
}

// ── Loading a run's inputs, and computing its lines ───────────────────

const groupBy = (rows, key) => {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r[key])) by.set(r[key], []);
    by.get(r[key]).push(r);
  }
  return by;
};

// Everything the lines of `run` are computed from, for the included people (all, or those in `scope`).
// Rows stay as read (text); computeOne() turns them into engine input, inside its own try.
async function loadContext(qc, run, policy, scope) {
  const month = run.month;
  const inputs = await qc(
    `SELECT person_id, include, advance_mode, ${INPUT_SELECT}
       FROM hr.run_inputs
      WHERE run_id = $1${scope ? ' AND person_id = ANY($2::int[])' : ''}
      ORDER BY person_id`,
    scope ? [run.id, scope] : [run.id],
  );
  const included = inputs.filter((r) => r.include === true);
  const ids = included.map((r) => r.person_id);
  const ctx = {
    month, daysInMonth: run.days_in_month, policy, ids,
    inputs: new Map(included.map((r) => [r.person_id, r])),
    people: new Map(), setups: new Map(), adjustments: new Map(), previous: new Map(),
    advances: new Map(), loans: new Map(), inApp: new Map(),
  };
  if (!ids.length) return ctx;

  const people = await qc(
    `SELECT p.id, p.status, p.joined_on::text AS joined_on, p.exited_on::text AS exited_on, p.pay_channel,
            c.kind AS pay_channel_kind,
            (coalesce(btrim(p.bank_account), '') <> '' AND coalesce(btrim(p.bank_ifsc), '') <> '') AS has_bank_details
       FROM hr.people p
       LEFT JOIN hr.pay_channels c ON c.code = p.pay_channel
      WHERE p.id = ANY($1::int[])`,
    [ids],
  );
  ctx.people = new Map(people.map((p) => [p.id, p]));
  ctx.setups = groupBy(await qc(
    `SELECT id, person_id, effective_from::text AS effective_from, pay_basis, base::text AS base, absence_basis,
            absence_divisor::text AS absence_divisor, ot_hours_per_day::text AS ot_hours_per_day,
            ot_multiplier::text AS ot_multiplier, ot_fixed_rate::text AS ot_fixed_rate, holiday_mode,
            holiday_divisor::text AS holiday_divisor, holiday_multiplier::text AS holiday_multiplier,
            holiday_fixed::text AS holiday_fixed
       FROM hr.pay_setups
      WHERE person_id = ANY($1::int[]) AND effective_from <= $2::date
      ORDER BY person_id, effective_from, id`,
    [ids, `${month}-01`],
  ), 'person_id');
  // Balances as at the month's end: money handed over after it belongs to a later month (ledger.js).
  ctx.advances = await advanceBalances(qc, ids, month);
  ctx.loans = await loanPositions(qc, ids, month, month);
  ctx.inApp = await inAppAdvancesInMonth(qc, ids, month);
  ctx.adjustments = groupBy(await qc(
    `SELECT id, person_id, kind, amount::text AS amount, description, category
       FROM hr.adjustments
      WHERE person_id = ANY($1::int[]) AND status = 'approved'
        AND start_month <= $2 AND coalesce(end_month, start_month) >= $2
      ORDER BY person_id, id`,
    [ids, month],
  ), 'person_id');
  const previous = await qc(
    `SELECT l.person_id, l.gross::text AS gross, l.basic::text AS basic, l.ot_amount::text AS ot_amount,
            l.holiday_amount::text AS holiday_amount, l.misc_earning::text AS misc_earning
       FROM hr.run_lines l
      WHERE l.run_id = (SELECT r.id FROM hr.runs r WHERE r.status = 'finalised' AND r.month < $2
                         ORDER BY r.month DESC LIMIT 1)
        AND l.person_id = ANY($1::int[])`,
    [ids, month],
  );
  ctx.previous = new Map(previous.map((l) => [l.person_id, l]));
  return ctx;
}

// One person's line. Whatever stops it (input the engine refuses, a figure too large to store) stops only
// this line: it is stored with zero amounts and the block flag ENGINE_ERROR.
function computeOne(ctx, personId) {
  let setupId = null;
  let hash = null;
  try {
    const row = ctx.inputs.get(personId);
    const person = ctx.people.get(personId);
    if (!person) throw new Error(`person ${personId} was not found`);
    const setupRow = effectiveSetup(ctx.setups.get(personId) ?? [], ctx.month);
    setupId = setupRow?.id ?? null;
    const { advance, flag } = newAdvance(row, ctx.inApp.get(personId) ?? money(ZERO));
    const engineInput = {
      month: ctx.month,
      daysInMonth: ctx.daysInMonth,
      person: {
        status: person.status,
        joined_on: person.joined_on,
        exited_on: person.exited_on,
        pay_channel_kind: person.pay_channel_kind,
        has_bank_details: person.has_bank_details === true,
      },
      setup: setupRow ? engineSetup(setupRow, ctx.policy) : null,
      inputs: engineInputs(row, advance),
      balances: { advance: ctx.advances.get(personId) ?? money(ZERO), loans: ctx.loans.get(personId) ?? [] },
      adjustments: (ctx.adjustments.get(personId) ?? []).map(engineAdjustment),
      policy: enginePolicy(ctx.policy),
    };
    hash = linesHash({ engine_version: ENGINE_VERSION, ...engineInput });
    const before = ctx.previous.get(personId);
    const result = computeLine({ ...engineInput, previous: before ? enginePrevious(before) : null });
    return lineRow(ctx, personId, setupId, hash, result, flag ? [flag] : []);
  } catch (error) {
    return errorRow(ctx, personId, setupId, hash, error);
  }
}

async function lockRun(qc, runId) {
  const [row] = await qc(`SELECT * FROM hr.runs WHERE id = $1 FOR UPDATE`, [runId]);
  if (!row) throw fail(404, 'RUN_NOT_FOUND', 'Payroll run not found');
  return row;
}

// runs.totals: every line of the run added up exactly, with counts and a split by pay channel.
// Amounts are 2-dp strings.
const TOTAL_MONEY = ['gross', 'total_deductions', 'net', 'paid_separately', 'payable', 'rounding',
  'advance_given', 'advance_recovery', 'loan_recovery', 'carried_advance'];

async function totalsOf(qc, runId) {
  const lines = await qc(
    `SELECT person_id, pay_channel, flags, ${TOTAL_MONEY.map((c) => `${c}::text AS ${c}`).join(', ')}
       FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id`,
    [runId],
  );
  const sum = Object.fromEntries(TOTAL_MONEY.map((c) => [c, 0n]));
  const channels = new Map();
  let blocked = 0;
  for (const l of lines) {
    for (const c of TOTAL_MONEY) sum[c] += paise(l[c]) ?? 0n;
    if (isBlocked(l.flags)) blocked += 1;
    const key = l.pay_channel ?? null;
    if (!channels.has(key)) channels.set(key, { pay_channel: key, lines: 0, payable: 0n, carried_advance: 0n });
    const ch = channels.get(key);
    ch.lines += 1;
    ch.payable += paise(l.payable) ?? 0n;
    ch.carried_advance += paise(l.carried_advance) ?? 0n;
  }
  const order = (a, b) => (a.pay_channel === null) - (b.pay_channel === null)
    || (a.pay_channel < b.pay_channel ? -1 : a.pay_channel > b.pay_channel ? 1 : 0);
  return {
    lines: lines.length,
    blocked,
    ...Object.fromEntries(TOTAL_MONEY.map((c) => [c, fmtPaise(sum[c])])),
    by_channel: [...channels.values()].sort(order).map((ch) => ({
      pay_channel: ch.pay_channel, lines: ch.lines, payable: fmtPaise(ch.payable), carried_advance: fmtPaise(ch.carried_advance),
    })),
  };
}

// ── Month order (Ruling T7-c) ─────────────────────────────────────────

// The latest finalised month after `month`, or null. While there is one, `month` is closed for good.
async function laterFinalised(qc, month) {
  const [row] = await qc(
    `SELECT month FROM hr.runs WHERE status = 'finalised' AND month > $1 ORDER BY month DESC LIMIT 1`,
    [month],
  );
  return row?.month ?? null;
}

const monthClosed = (month, latest, what) => fail(409, 'MONTH_BEFORE_FINALISED',
  `Payroll for ${month} can no longer be ${what}: ${latest} is already finalised. `
  + 'Put corrections into the next open month as adjustments', { month: latest });

// ── ensureRun ─────────────────────────────────────────────────────────

// The month's run, as it is; when there is none, a new draft with the month's length, the engine version
// and the policy from hr.settings. A month before the latest finalised one is not started (409
// MONTH_BEFORE_FINALISED). Creating a run from a GET would leave an empty draft that blocks finalising
// every later month (PREVIOUS_MONTH_OPEN), so call it on writes only.
export async function ensureRun(qc, month, userId) {
  if (typeof month !== 'string' || !MONTH.test(month)) {
    throw fail(400, 'BAD_MONTH', `A payroll month looks like 2026-08, got ${JSON.stringify(month)}`);
  }
  const [existing] = await qc(`SELECT * FROM hr.runs WHERE month = $1`, [month]);
  if (existing) return existing;
  const latest = await laterFinalised(qc, month);
  if (latest) throw monthClosed(month, latest, 'started');
  const policy = await currentPolicy(qc);
  const [created] = await qc(
    `INSERT INTO hr.runs (month, status, days_in_month, engine_version, policy, prepared_by, prepared_at)
     VALUES ($1, 'draft', $2, $3, $4::jsonb, $5::integer, now())
     ON CONFLICT (month) DO NOTHING
     RETURNING *`,
    [month, daysInMonthOf(month), ENGINE_VERSION, JSON.stringify(policy), idOrNull(userId)],
  );
  if (created) return created;
  const [raced] = await qc(`SELECT * FROM hr.runs WHERE month = $1`, [month]);   // created meanwhile by another call
  return raced;
}

// ── recalcRun ─────────────────────────────────────────────────────────

// Recompute a draft's lines and store them; posts nothing. With personIds, only those people are
// recomputed (the totals still cover every line), unless the policy or the engine changed since the last
// recalculation: then every line is, so a run's lines are always computed under runs.policy. A person left
// out (include = false, or no inputs row) loses their line.
export async function recalcRun(qc, run, { personIds } = {}) {
  const runId = runIdOf(run);
  let scope = personIds === undefined || personIds === null ? null : idsOf(personIds);
  const locked = await lockRun(qc, runId);
  if (locked.status !== 'draft') throw fail(409, 'RUN_LOCKED', 'Run is not a draft');

  const policy = await currentPolicy(qc);
  if (canonical(policy) !== canonical(locked.policy ?? {}) || locked.engine_version !== ENGINE_VERSION) scope = null;
  const ctx = await loadContext(qc, locked, policy, scope);
  const lines = ctx.ids.map((id) => computeOne(ctx, id));

  await qc(
    `DELETE FROM hr.run_lines
      WHERE run_id = $1 AND person_id <> ALL($2::int[])${scope ? ' AND person_id = ANY($3::int[])' : ''}`,
    scope ? [locked.id, ctx.ids, scope] : [locked.id, ctx.ids],
  );
  const stored = lines.length ? await qc(UPSERT_LINES, [locked.id, JSON.stringify(lines)]) : [];
  const totals = await totalsOf(qc, locked.id);
  const [updated] = await qc(
    `UPDATE hr.runs SET policy = $2::jsonb, engine_version = $3, totals = $4::jsonb WHERE id = $1 RETURNING *`,
    [locked.id, JSON.stringify(policy), ENGINE_VERSION, JSON.stringify(totals)],
  );
  return { lines: stored.sort((a, b) => a.person_id - b.person_id), totals, run: updated };
}

// ── finaliseRun ───────────────────────────────────────────────────────

const recoveriesKey = (list) => (Array.isArray(list) ? list : [])
  .map((r) => `${r.loan_id}:${paise(r.amount)}`).join('|');

const sameLine = (stored, fresh) => stored.inputs_hash === fresh.inputs_hash
  && paise(stored.payable) === paise(fresh.payable)
  && paise(stored.advance_given) === paise(fresh.advance_given)
  && paise(stored.advance_recovery) === paise(fresh.advance_recovery)
  && recoveriesKey(stored.loan_recoveries) === recoveriesKey(fresh.loan_recoveries);

const POSTED_ONCE = new Set(['advance_txns_run_once_uq', 'loan_txns_recovery_once_uq']);

// A posting that would be the run's second: the unique keys refuse it, and the whole finalise with it.
async function post(qc, sql, params) {
  try {
    return await qc(sql, params);
  } catch (e) {
    if (e?.code === '23505' && POSTED_ONCE.has(e.constraint)) {
      throw Object.assign(fail(409, 'ALREADY_POSTED', 'This run has already posted to the advance or loan ledger, so nothing was posted'), { cause: e });
    }
    throw e;
  }
}

const INSERT_ADVANCES = `
  INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, run_id, source, note, created_by)
  SELECT x.person_id,
         CASE WHEN x.kind = 'given' THEN LEAST($2::date, ${PLANT_TODAY_SQL}) ELSE ${PLANT_TODAY_SQL} END,
         x.kind, x.amount, $1::integer, 'payroll', x.note, $3::integer
    FROM jsonb_to_recordset($4::jsonb) AS x(person_id integer, kind text, amount numeric, note text)
   ORDER BY x.person_id, x.kind
  RETURNING id, person_id, kind, amount::text AS amount`;

const INSERT_LOAN_RECOVERIES = `
  INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, interest_amount, run_id, note, created_by)
  SELECT x.loan_id, ${PLANT_TODAY_SQL}, 'payroll_recovery', x.amount, 0, $1::integer, x.note, $2::integer
    FROM jsonb_to_recordset($3::jsonb) AS x(loan_id integer, amount numeric, note text)
   ORDER BY x.loan_id
  RETURNING id, loan_id, principal_amount::text AS amount`;

// Every loan in `recoveries` (the payroll_recovery rows just posted) whose outstanding is now exactly 0,
// worked out by loans.js over all its txns, is closed (Ruling T7-d). Its row is already locked.
async function closePaidOffLoans(qc, recoveries) {
  const ids = [...new Set(recoveries.map((r) => r.loan_id))].sort((a, b) => a - b);
  if (!ids.length) return [];
  const txns = groupBy(await qc(
    `SELECT loan_id, kind, principal_amount::text AS principal_amount
       FROM hr.loan_txns WHERE loan_id = ANY($1::int[]) ORDER BY loan_id, id`,
    [ids],
  ), 'loan_id');
  const paidOff = ids.filter((id) => loanOutstanding({ id }, txns.get(id) ?? []) === money(ZERO));
  if (!paidOff.length) return [];
  const closed = await qc(
    `UPDATE hr.loans SET status = 'closed' WHERE id = ANY($1::int[]) AND status = 'active' RETURNING id, loan_no`,
    [paidOff],
  );
  return closed.sort((a, b) => a.id - b.id);
}

// Approved → finalised, in the caller's transaction (all or nothing):
//   1. lock the run; it must be approved (409 RUN_STATE)
//   2. no later month may be finalised already (409 MONTH_BEFORE_FINALISED, Ruling T7-c), and no earlier
//      run after the latest finalised month may be unfinalised (409 PREVIOUS_MONTH_OPEN)
//   3. lock the run's people and their loans, recompute every line in memory under the frozen policy, and
//      refuse if any line's pay, postings or inputs_hash differ from the stored, approved line (409
//      RUN_CHANGED_SINCE_APPROVAL), or if a line is still blocked (409 RUN_BLOCKED)
//   4. post advance_txns: 'given' (the month's new advance) and 'recovered', each only when above 0
//   5. post a loan_txns 'payroll_recovery' for each loan recovery above 0, then close every loan those
//      recoveries paid off (Ruling T7-d)
//   6. stamp finalised_by/at and write the audit rows (the run's, and one per loan closed)
// The unique keys stop a second posting (409 ALREADY_POSTED) even if every check above were bypassed.
export async function finaliseRun(qc, run, req) {
  const runId = runIdOf(run);
  const locked = await lockRun(qc, runId);
  if (locked.status !== 'approved') {
    throw fail(409, 'RUN_STATE', `Only an approved run can be finalised; ${locked.month} is ${locked.status}`);
  }
  const latest = await laterFinalised(qc, locked.month);
  if (latest) throw monthClosed(locked.month, latest, 'finalised');
  // An unfinalised run from before the latest finalised month can never post (MONTH_BEFORE_FINALISED), so
  // it cannot make this month's balances wrong and does not hold it back.
  const [open] = await qc(
    `SELECT month, status FROM hr.runs
      WHERE month < $1 AND status <> 'finalised'
        AND month > coalesce((SELECT max(f.month) FROM hr.runs f WHERE f.status = 'finalised' AND f.month < $1), '')
      ORDER BY month LIMIT 1`,
    [locked.month],
  );
  if (open) {
    throw fail(409, 'PREVIOUS_MONTH_OPEN', `Finalise ${open.month} first: it is still ${open.status}`, { month: open.month });
  }

  const people = (await qc(
    `SELECT person_id FROM hr.run_inputs WHERE run_id = $1 AND include
     UNION
     SELECT person_id FROM hr.run_lines WHERE run_id = $1
     ORDER BY person_id`,
    [locked.id],
  )).map((r) => r.person_id);
  if (people.length) {
    await qc(`SELECT id FROM hr.people WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [people]);
    await qc(`SELECT id FROM hr.loans WHERE person_id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [people]);
  }

  const ctx = await loadContext(qc, locked, locked.policy ?? {}, null);
  const fresh = new Map(ctx.ids.map((id) => [id, computeOne(ctx, id)]));
  const stored = await qc(
    `SELECT person_id, inputs_hash, payable::text AS payable, advance_given::text AS advance_given,
            advance_recovery::text AS advance_recovery, loan_recoveries
       FROM hr.run_lines WHERE run_id = $1 ORDER BY person_id`,
    [locked.id],
  );
  const changed = new Set([...fresh.keys()].filter((id) => !stored.some((s) => s.person_id === id)));
  for (const s of stored) if (!fresh.has(s.person_id) || !sameLine(s, fresh.get(s.person_id))) changed.add(s.person_id);
  if (changed.size) {
    const ids = [...changed].sort((a, b) => a - b);
    throw fail(409, 'RUN_CHANGED_SINCE_APPROVAL',
      `${ids.length} line${ids.length === 1 ? ' has' : 's have'} changed since approval (inputs, pay setups or balances `
      + 'moved): send the run back, recalculate it and approve it again', { person_ids: ids });
  }
  const blocked = [...fresh.values()].filter((l) => isBlocked(l.flags)).map((l) => l.person_id);
  if (blocked.length) {
    throw fail(409, 'RUN_BLOCKED',
      `${blocked.length} line${blocked.length === 1 ? ' is' : 's are'} still blocked: resolve ${blocked.length === 1 ? 'it' : 'them'} before finalising`,
      { person_ids: blocked });
  }

  // The approved lines, which the recompute has just matched, are what is posted.
  const advanceRows = [];
  const loanRows = [];
  for (const l of stored) {
    if (paise(l.advance_given) > 0n) {
      advanceRows.push({ person_id: l.person_id, kind: 'given', amount: money(l.advance_given),
        note: `Payroll ${locked.month}: advance from the month's sheet` });
    }
    if (paise(l.advance_recovery) > 0n) {
      advanceRows.push({ person_id: l.person_id, kind: 'recovered', amount: money(l.advance_recovery),
        note: `Payroll ${locked.month}: recovered from pay` });
    }
    for (const r of l.loan_recoveries ?? []) {
      if (paise(r.amount) > 0n) {
        loanRows.push({ loan_id: r.loan_id, amount: money(r.amount), note: `Payroll ${locked.month}: instalment recovered from pay` });
      }
    }
  }
  const userId = idOrNull(req?.user?.id);
  const monthEnd = `${locked.month}-${String(daysInMonthOf(locked.month)).padStart(2, '0')}`;
  const advances = advanceRows.length
    ? await post(qc, INSERT_ADVANCES, [locked.id, monthEnd, userId, JSON.stringify(advanceRows)]) : [];
  const recoveries = loanRows.length
    ? await post(qc, INSERT_LOAN_RECOVERIES, [locked.id, userId, JSON.stringify(loanRows)]) : [];
  const closed = await closePaidOffLoans(qc, recoveries);

  const [done] = await qc(
    `UPDATE hr.runs SET status = 'finalised', finalised_by = $2, finalised_at = now()
      WHERE id = $1 AND status = 'approved'
      RETURNING *`,
    [locked.id, userId],
  );
  if (!done) throw new Error(`finaliseRun: run ${locked.id} changed under its own lock`);

  const total = (rows) => fmtPaise(rows.reduce((t, r) => t + paise(r.amount), 0n));
  await hrAudit(qc, req, 'run', locked.id, 'finalise', {
    month: locked.month,
    lines: stored.length,
    advance_given: total(advances.filter((r) => r.kind === 'given')),
    advance_recovered: total(advances.filter((r) => r.kind === 'recovered')),
    loan_recovered: total(recoveries),
    advance_txns: advances.length,
    loan_txns: recoveries.length,
    loans_closed: closed.map((l) => l.loan_no),
  });
  for (const l of closed) {
    await hrAudit(qc, req, 'loan', l.id, 'close', {
      loan_no: l.loan_no, run_id: locked.id, month: locked.month, reason: 'paid off by payroll recovery',
    });
  }
  return done;
}
