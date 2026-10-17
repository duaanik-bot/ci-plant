// Ledger reads for HR & Payroll (spec §10 advances, §11 loans): a person's advance balance, their loan
// positions for a month, and the advances given in the app during a month.
//
// "As at month end" (asAtMonth, optional): a payroll run reads balances as they stood at the end of its month,
// so money handed over after that month cannot move the month's run (its inputs_hash, so its finalise).
// Left out: every MANUAL INCREASE dated after the month's last day — an advance row with no run_id of kind
// opening, given or adjustment (an advance adjustment is always positive), a loan issued after it (with all
// its txns), and a loan txn with no run_id of kind disbursed, opening or a positive adjustment. Every
// REDUCTION is kept whatever its date (recoveries posted by runs, waivers, prepayments, negative
// adjustments): dropping a later recovery would let a late-finalised earlier month recover it again.
// Without asAtMonth nothing is filtered: the balance as it stands now (person detail, dashboard, Pay staff).
//
// Reads only. Nothing here writes, so nothing here can move a balance: the one place a payroll posts to
// these ledgers is finaliseRun() in runs.js. A balance is never stored (spec §7); it is always the sum
// over its ledger, worked out here exactly:
//   advance balance   opening + given + adjustment − recovered − waived, over every posted row
//   loan position     loans.js dueForMonth() over the loan's txns and repayment holidays
//
// Every function takes `qc`, the query function of the caller's transaction (db.js tx()), and never the
// pool: inside a transaction a pool call on Vercel's one-client pool would wait on itself.
//
// Amounts are read as text (::text), never as the JS numbers pg makes of NUMERIC (db.js), and leave as
// 2-dp strings. Months are 'YYYY-MM' text and dates 'YYYY-MM-DD' text, as loans.js and engine.js require.
// Each Map has every person id asked for, in ascending order, so a person with no rows reads as owing
// nothing rather than being missing.

import { rat, add, sub, toPaise, fmtPaise } from './money.js';
import { dueForMonth, nextMonth } from './loans.js';

const ZERO = rat(0);
const INT4_MAX = 2147483647;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// How each advance kind moves the balance (spec §10). A Map, so a kind such as 'toString' is unknown
// rather than found on a prototype. An unknown kind throws: counting it as nothing would change what is
// taken from someone's pay.
const ADVANCE_SIGN = new Map([['opening', 1], ['given', 1], ['adjustment', 1], ['recovered', -1], ['waived', -1]]);

// Person ids as the int4 they are in the database, without duplicates, ascending. A numeric string (a
// route param) is accepted; anything else throws before a query is sent.
function idsOf(personIds) {
  if (!Array.isArray(personIds)) throw new TypeError('ledger: personIds must be an array of person ids');
  const ids = personIds.map((raw) => {
    const id = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
    if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) {
      throw new TypeError(`ledger: not a person id: ${JSON.stringify(raw)}`);
    }
    return id;
  });
  return [...new Set(ids)].sort((a, b) => a - b);
}

function monthOf(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) {
    throw new TypeError(`ledger: month must look like 2026-08, got ${JSON.stringify(month)}`);
  }
  return month;
}

const text = (r) => fmtPaise(toPaise(r));                // an exact amount as '1500.00'

// The first day after `asAtMonth` as 'YYYY-MM-01', or null (no filter) when it is absent.
function cutoffOf(asAtMonth) {
  if (asAtMonth === undefined || asAtMonth === null) return null;
  return `${nextMonth(monthOf(asAtMonth))}-01`;
}

// Map<person id, '2-dp balance'>: the posted advance balance — over every row whatever its date, or, given
// asAtMonth, as at the end of that month (manual increases dated after it left out, see the header).
export async function advanceBalances(qc, personIds, asAtMonth) {
  const ids = idsOf(personIds);
  const cutoff = cutoffOf(asAtMonth);
  const sums = new Map(ids.map((id) => [id, ZERO]));
  if (ids.length) {
    const rows = await qc(
      `SELECT person_id, kind, sum(amount)::text AS amount
         FROM hr.advance_txns
        WHERE person_id = ANY($1::int[])
          AND NOT ($2::date IS NOT NULL AND run_id IS NULL
                   AND kind IN ('opening', 'given', 'adjustment') AND txn_date >= $2::date)
        GROUP BY person_id, kind`,
      [ids, cutoff],
    );
    for (const r of rows) {
      const sign = ADVANCE_SIGN.get(r.kind);
      if (sign === undefined) throw new RangeError(`ledger: unknown advance transaction kind ${JSON.stringify(r.kind)}`);
      const was = sums.get(r.person_id) ?? ZERO;
      sums.set(r.person_id, sign > 0 ? add(was, rat(r.amount)) : sub(was, rat(r.amount)));
    }
  }
  return new Map([...sums].map(([id, sum]) => [id, text(sum)]));
}

// Map<person id, [{loan_id, loan_no, due, outstanding}]>: each ACTIVE loan, oldest first (issued_on, then
// id; the engine trims loans newest first when pay is short), with what is due in `month` and the balance
// it is worked out from. A closed or cancelled loan is left out, so a typed loan_recovery_override can
// never be allocated to it. A payroll_recovery txn carries its run's month as run_month (Ruling P4).
// Given asAtMonth (a payroll run passes its own month), a loan issued after that month is left out with all
// its txns, and manual increases dated after it are not counted (see the header); without it, every txn.
export async function loanPositions(qc, personIds, month, asAtMonth) {
  const ids = idsOf(personIds);
  const when = monthOf(month);
  const cutoff = cutoffOf(asAtMonth);
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;

  const loans = await qc(
    `SELECT id, loan_no, person_id, instalment::text AS instalment, first_due_month, status
       FROM hr.loans
      WHERE person_id = ANY($1::int[]) AND status = 'active'
        AND ($2::date IS NULL OR issued_on < $2::date)
      ORDER BY person_id, issued_on, id`,
    [ids, cutoff],
  );
  if (!loans.length) return out;
  const loanIds = loans.map((l) => l.id);
  const txns = await qc(
    `SELECT t.loan_id, t.kind, t.principal_amount::text AS principal_amount, r.month AS run_month
       FROM hr.loan_txns t
       LEFT JOIN hr.runs r ON r.id = t.run_id
      WHERE t.loan_id = ANY($1::int[])
        AND NOT ($2::date IS NOT NULL AND t.run_id IS NULL AND t.txn_date >= $2::date
                 AND (t.kind IN ('disbursed', 'opening') OR (t.kind = 'adjustment' AND t.principal_amount > 0)))
      ORDER BY t.loan_id, t.id`,
    [loanIds, cutoff],
  );
  const holidays = await qc(
    `SELECT loan_id, month FROM hr.loan_holidays WHERE loan_id = ANY($1::int[]) ORDER BY loan_id, month`,
    [loanIds],
  );

  const group = (rows, pick) => {
    const by = new Map(loanIds.map((id) => [id, []]));
    for (const r of rows) by.get(r.loan_id)?.push(pick(r));
    return by;
  };
  const txnsOf = group(txns, (t) => t);
  const holidaysOf = group(holidays, (h) => h.month);
  for (const loan of loans) {
    const { due, outstanding } = dueForMonth(loan, txnsOf.get(loan.id), holidaysOf.get(loan.id), when);
    out.get(loan.person_id).push({ loan_id: loan.id, loan_no: loan.loan_no, due, outstanding });
  }
  return out;
}

// Map<person id, '2-dp sum'>: advances given in the app ('given', source 'manual') dated inside `month`.
// The month's sheet figure is by default the month's total including these (spec §9 item 7), so payroll
// adds only the difference. Payroll's own rows (source 'payroll') are never counted here.
export async function inAppAdvancesInMonth(qc, personIds, month) {
  const ids = idsOf(personIds);
  const when = monthOf(month);
  const out = new Map(ids.map((id) => [id, text(ZERO)]));
  if (!ids.length) return out;
  const rows = await qc(
    `SELECT person_id, sum(amount)::text AS amount
       FROM hr.advance_txns
      WHERE person_id = ANY($1::int[])
        AND kind = 'given' AND source = 'manual'
        AND txn_date >= $2::date AND txn_date < $3::date
      GROUP BY person_id`,
    [ids, `${when}-01`, `${nextMonth(when)}-01`],
  );
  for (const r of rows) out.set(r.person_id, text(rat(r.amount)));
  return out;
}
