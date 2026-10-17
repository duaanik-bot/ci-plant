// Employee-loan positions and repayment schedules (spec §11). Pure: no I/O, no database.
//
// Payroll asks dueForMonth() how much of a loan to take this month; the loans screen asks
// projectSchedule() to lay the whole repayment out. Nothing is stored: a balance is always the sum over the
// loan's transactions (spec §7), so every function is handed the loan row and its txns.
//
//   disbursed, opening                      add principal_amount
//   payroll_recovery, prepayment, waiver    subtract it
//   adjustment                              adds it, and may be negative
//
// The loan row's own `principal` plays no part in the balance: the disbursed (or opening) row is that money
// reaching the books, so adding the principal as well would count it twice. A loan with no txns owes nothing.
// Phase 1 loans are interest-free, so interest_amount is ignored. Money is exact (money.js rationals), and
// leaves here as 2-dp text rounded half away from zero; a raw value from pg is wrapped with rat() first.
//
// Months are 'YYYY-MM' text and compare as text. Any other shape throws a TypeError instead of comparing
// wrongly in silence: '2026-08' sorts before '2026-08-01', so a first_due_month with a day on it would start
// a month late, and a holiday written that way would never match.
//
// A transaction of a kind not listed above, or without a numeric principal_amount, throws too. Quietly
// counting it as zero would change what is taken from someone's pay.

import { rat, add, sub, neg, cmp, min as minRat, max as maxRat, toPaise, fmtPaise } from './money.js';

const ZERO = rat(0);
const text = (r) => fmtPaise(toPaise(r));              // an exact amount as '5000.00'

// ── Months ───────────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthOf(value, name) {
  if (typeof value !== 'string' || !MONTH.test(value)) {
    throw new TypeError(`loans: ${name} must look like 2026-08, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function nextMonth(month) {
  const [, year, m] = MONTH.exec(monthOf(month, 'month'));
  if (m === '12') return `${String(Number(year) + 1).padStart(4, '0')}-01`;
  return `${year}-${String(Number(m) + 1).padStart(2, '0')}`;
}

// ── The balance ──────────────────────────────────────────────────────

// What one transaction does to the balance.
function signed(txn) {
  const value = rat(txn.principal_amount);             // a TypeError when it is missing or not a number
  switch (txn.kind) {
    case 'disbursed':
    case 'opening':
    case 'adjustment':
      return value;
    case 'payroll_recovery':
    case 'prepayment':
    case 'waiver':
      return neg(value);
    default:
      throw new RangeError(`loans: unknown transaction kind ${JSON.stringify(txn.kind)}`);
  }
}

function balanceOf(txns) {
  let sum = ZERO;
  for (const txn of txns) sum = add(sum, signed(txn));
  return sum;
}

// The balance as it stands: negative when more has been taken than was lent, shown as it is. `loan` is
// here so the three functions share a shape; its principal is deliberately unused (see the header).
export function loanOutstanding(loan, txns) {
  return text(balanceOf(txns));
}

// ── What is due ──────────────────────────────────────────────────────

// min(instalment, outstanding), never below zero: a cleared or over-paid balance owes nothing, and an
// instalment of zero or less takes nothing.
const instalmentDue = (instalment, outstanding) => maxRat(ZERO, minRat(instalment, outstanding));

const holidaySet = (holidays) => new Set([...holidays].map((h) => monthOf(h, 'holiday month')));

// What payroll takes from this loan in `month`, and the balance it is worked out from. Nothing is due
// unless the loan is active, its first due month has come, and the month is not a repayment holiday.
export function dueForMonth(loan, txns, holidays, month) {
  const when = monthOf(month, 'month');
  const first = monthOf(loan.first_due_month, 'first_due_month');
  const skip = holidaySet(holidays);
  const outstanding = balanceOf(txns);
  const owing = loan.status === 'active' && when >= first && !skip.has(when);
  return {
    due: text(owing ? instalmentDue(rat(loan.instalment), outstanding) : ZERO),
    outstanding: text(outstanding),
  };
}

// ── The schedule ─────────────────────────────────────────────────────

// One row a month from max(fromMonth, first_due_month), at most `max` of them:
// {month, opening, due, recovered, closing, status}. Every row opens where the one before it closed.
//
// A month's status is the first of these that fits:
//   recovered / partial   payroll took something that month (payroll_recovery rows, by their run_month):
//                         'recovered' when that covers the month's due, otherwise 'partial'. A holiday
//                         month's due is 0.00, so money really taken in one still reads 'recovered'.
//   holiday               no recovery, and the month is a repayment holiday: due 0.00.
//   partial               no recovery, but a later month has one (a shortfall): recovered 0.00.
//   projected             a month still to come: due is min(instalment, balance), and the closing balance
//                         is the opening one less that due, so early repayment, shortfalls and holidays
//                         move the end by themselves. `recovered` is 0.00 until payroll has really taken it.
//
// The rows run on through the latest recovery whatever the balance, then stop once it reaches zero, or
// when the loan is not active (a closed or cancelled loan keeps its history and has no future).
//
// The first row opens with the balance as it stands plus whatever the rows from that month on show as
// recovered, so the figures add up row to row. A fromMonth beyond the next unrecovered month therefore
// opens at today's balance: the months skipped over are not assumed paid. Prepayments, waivers and
// adjustments carry no month, so they count in full from the first row. A past row's due uses the loan's
// current instalment.
export function projectSchedule(loan, txns, holidays, fromMonth, max = 120) {
  const first = monthOf(loan.first_due_month, 'first_due_month');
  const from = monthOf(fromMonth, 'fromMonth');
  const skip = holidaySet(holidays);
  const instalment = rat(loan.instalment);
  const active = loan.status === 'active';

  // What payroll took, by the month of the run that took it. Several rows in one month add up.
  const taken = new Map();
  for (const txn of txns) {
    if (txn.kind !== 'payroll_recovery') continue;
    const run = monthOf(txn.run_month, 'run_month of a payroll_recovery');
    taken.set(run, add(taken.get(run) ?? ZERO, rat(txn.principal_amount)));
  }
  let latest = '';                                     // the last month with a recovery; '' sorts before every month
  for (const run of taken.keys()) if (run > latest) latest = run;

  let month = from > first ? from : first;
  let opening = balanceOf(txns);
  for (const [run, got] of taken) if (run >= month) opening = add(opening, got);

  const rows = [];
  while (rows.length < max) {
    const history = month <= latest;                   // a month the recorded recoveries already reach
    if (!history && !(active && cmp(opening, ZERO) > 0)) break;

    const holiday = skip.has(month);
    const due = holiday ? ZERO : instalmentDue(instalment, opening);
    const got = taken.get(month);                      // undefined: no payroll_recovery in this month
    let status;
    let moved;                                         // what comes off the balance in this row
    if (got !== undefined) {
      status = cmp(got, due) >= 0 ? 'recovered' : 'partial';
      moved = got;
    } else if (holiday) {
      status = 'holiday';
      moved = ZERO;
    } else if (history) {
      status = 'partial';
      moved = ZERO;
    } else {
      status = 'projected';
      moved = due;
    }

    const closing = sub(opening, moved);
    rows.push({
      month, opening: text(opening), due: text(due), recovered: text(got ?? ZERO), closing: text(closing), status,
    });
    opening = closing;
    month = nextMonth(month);
  }
  return rows;
}
