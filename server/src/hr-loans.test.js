// Loan positions and repayment schedules for the HR & Payroll module (hr/loans.js).
//
// Payroll asks dueForMonth() how much of a loan to take this month; the loans screen asks
// projectSchedule() to lay the repayment out. A balance is never stored: it is the sum over the loan's
// transactions. Expected values below are hand-derived literals, never copied from the module's output.
// Every figure is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loanOutstanding, dueForMonth, projectSchedule, nextMonth } from './hr/loans.js';

// ── The task brief's tests, verbatim ──────────────────────────────────
const loan = {principal:'20000', status:'active', instalment:'5000', first_due_month:'2026-08'};
const tx0 = [{kind:'disbursed', principal_amount:'20000'}];
const tx1 = [...tx0, {kind:'payroll_recovery', principal_amount:'5000', run_month:'2026-08'},
                     {kind:'payroll_recovery', principal_amount:'2000', run_month:'2026-09'}];

test('brief: nothing is due before the first due month, one instalment is due in it', () => {
  assert.deepEqual(dueForMonth(loan, tx0, [], '2026-07'), {due:'0.00', outstanding:'20000.00'});
  assert.equal(dueForMonth(loan, tx0, [], '2026-08').due, '5000.00');
});
test('brief: the balance is the disbursement less each recovery', () => {
  assert.equal(loanOutstanding(loan, tx1), '13000.00');
});
test('brief: recovered, partial, then projected instalments, the last one short', () => {
  const sch = projectSchedule(loan, tx1, [], '2026-08');
  assert.deepEqual(sch.map(r => [r.month, r.due, r.status]), [['2026-08','5000.00','recovered'],
    ['2026-09','5000.00','partial'], ['2026-10','5000.00','projected'], ['2026-11','5000.00','projected'],
    ['2026-12','3000.00','projected']]);
});
test('brief: a repayment holiday pushes the end out by a month', () => {
  const hol = projectSchedule(loan, tx1, ['2026-11'], '2026-10');
  assert.deepEqual(hol.map(r => [r.month, r.due]), [['2026-10','5000.00'], ['2026-11','0.00'], ['2026-12','5000.00'], ['2027-01','3000.00']]);
});
test('brief: a cleared balance owes nothing, and nor does a closed loan', () => {
  assert.equal(dueForMonth(loan, [...tx1, {kind:'prepayment', principal_amount:'13000'}], [], '2026-10').due, '0.00');
  assert.equal(dueForMonth({...loan, status:'closed'}, tx0, [], '2026-08').due, '0.00');
});
test('brief: nextMonth rolls the year', () => {
  assert.equal(nextMonth('2026-12'), '2027-01');
});

// ── Helpers ───────────────────────────────────────────────────────────

// A payroll recovery as the DB layer hands it over: the run's month rides along as run_month.
const rec = (principal_amount, run_month) => ({ kind: 'payroll_recovery', principal_amount, run_month });

// A schedule as plain rows: month, opening, due, recovered, closing, status.
const table = (rows) => rows.map((r) => [r.month, r.opening, r.due, r.recovered, r.closing, r.status]);

// Whatever the loan's history, a schedule is consecutive months, each opening where the last one closed,
// and every status is one of the brief's four.
function assertChain(rows) {
  for (const r of rows) {
    assert.ok(['recovered', 'partial', 'holiday', 'projected'].includes(r.status), `${r.month}: status ${r.status}`);
  }
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].month, nextMonth(rows[i - 1].month), `${rows[i].month} follows ${rows[i - 1].month}`);
    assert.equal(rows[i].opening, rows[i - 1].closing, `${rows[i].month} opens where ${rows[i - 1].month} closed`);
  }
}

// ── loanOutstanding: the balance is the sum over the transactions ─────
test('loanOutstanding: each kind moves the balance the way the spec says', () => {
  const base = { kind: 'disbursed', principal_amount: '1000' };
  const rows = [                                       // [kind, amount, balance after the 1000 disbursed and this row]
    ['disbursed', '100', '1100.00'], ['opening', '100', '1100.00'],
    ['payroll_recovery', '100', '900.00'], ['prepayment', '100', '900.00'], ['waiver', '100', '900.00'],
    ['adjustment', '100', '1100.00'], ['adjustment', '-100', '900.00'],
  ];
  for (const [kind, principal_amount, want] of rows) {
    assert.equal(loanOutstanding(loan, [base, { kind, principal_amount, run_month: '2026-08' }]), want, `${kind} ${principal_amount}`);
  }
});

test('loanOutstanding: the txns alone make the balance, so the loan row\'s principal is never added on top', () => {
  assert.equal(loanOutstanding(loan, []), '0.00');
  assert.equal(loanOutstanding(loan, tx0), '20000.00');                      // not 40000: the disbursed row IS the principal
  assert.equal(loanOutstanding({ principal: '999' }, tx0), '20000.00');
  assert.equal(loanOutstanding({ principal: '8000' }, [{ kind: 'opening', principal_amount: '8000' }]), '8000.00');
});

test('loanOutstanding: exact arithmetic, shown to 2 places, rounded half away from zero', () => {
  assert.equal(loanOutstanding(loan, [{ kind: 'disbursed', principal_amount: '1.005' }]), '1.01');       // a float gives 1.00
  assert.equal(loanOutstanding(loan, [{ kind: 'adjustment', principal_amount: '-1.005' }]), '-1.01');
  assert.equal(loanOutstanding(loan, [{ kind: 'adjustment', principal_amount: '-0.004' }]), '0.00');     // never '-0.00'
  assert.equal(loanOutstanding(loan, [{ kind: 'disbursed', principal_amount: '0.1' }, { kind: 'adjustment', principal_amount: '0.2' }]), '0.30');
});

test('loanOutstanding: pg hands NUMERIC over as JS numbers, and those work too', () => {
  const asNumbers = [{ kind: 'disbursed', principal_amount: 20000 }, rec(1234.56, '2026-08')];
  assert.equal(loanOutstanding({ principal: 20000 }, asNumbers), '18765.44');
  assert.deepEqual(dueForMonth({ status: 'active', instalment: 5000, first_due_month: '2026-08' }, asNumbers, [], '2026-09'),
    { due: '5000.00', outstanding: '18765.44' });
});

test('loanOutstanding: an unknown kind or a bad amount is an error, never a silent zero', () => {
  assert.throws(() => loanOutstanding(loan, [{ kind: 'bonus', principal_amount: '5' }]), RangeError);
  assert.throws(() => loanOutstanding(loan, [{ kind: 'disbursed' }]), TypeError);
  assert.throws(() => loanOutstanding(loan, [{ kind: 'disbursed', principal_amount: null }]), TypeError);
  assert.throws(() => loanOutstanding(loan, [{ kind: 'disbursed', principal_amount: 'abc' }]), TypeError);
});

// ── dueForMonth ───────────────────────────────────────────────────────
test('dueForMonth: min(instalment, outstanding), with the balance reported alongside', () => {
  assert.deepEqual(dueForMonth(loan, tx0, [], '2026-08'), { due: '5000.00', outstanding: '20000.00' });
  assert.deepEqual(dueForMonth(loan, [...tx0, rec('15000', '2026-08')], [], '2026-09'), { due: '5000.00', outstanding: '5000.00' });
  assert.deepEqual(dueForMonth(loan, [...tx0, rec('17000', '2026-08')], [], '2026-09'), { due: '3000.00', outstanding: '3000.00' });
});

test('dueForMonth: the first due month is inclusive, and months compare across a year end', () => {
  assert.equal(dueForMonth(loan, tx0, [], '2027-01').due, '5000.00');
  const january = { ...loan, first_due_month: '2027-01' };
  assert.equal(dueForMonth(january, tx0, [], '2026-12').due, '0.00');         // the month before, in the year before
  assert.equal(dueForMonth(january, tx0, [], '2027-01').due, '5000.00');
});

test('dueForMonth: a repayment holiday skips that month only, and the balance still shows', () => {
  assert.deepEqual(dueForMonth(loan, tx0, ['2026-08'], '2026-08'), { due: '0.00', outstanding: '20000.00' });
  assert.equal(dueForMonth(loan, tx0, ['2026-08'], '2026-09').due, '5000.00');
  assert.equal(dueForMonth(loan, tx0, ['2026-08', '2026-09', '2026-10'], '2026-09').due, '0.00');
});

test('dueForMonth: only an active loan has anything due', () => {
  for (const status of ['closed', 'cancelled']) {
    assert.deepEqual(dueForMonth({ ...loan, status }, tx0, [], '2026-08'), { due: '0.00', outstanding: '20000.00' }, status);
  }
});

test('dueForMonth: nothing at or below a zero balance, and never a negative amount', () => {
  const overPaid = [...tx0, { kind: 'prepayment', principal_amount: '21500' }];
  assert.deepEqual(dueForMonth(loan, overPaid, [], '2026-09'), { due: '0.00', outstanding: '-1500.00' });   // the balance is shown as it is
  assert.deepEqual(dueForMonth(loan, [], [], '2026-09'), { due: '0.00', outstanding: '0.00' });
  assert.equal(dueForMonth({ ...loan, instalment: '0' }, tx0, [], '2026-09').due, '0.00');
  assert.equal(dueForMonth({ ...loan, instalment: '-100' }, tx0, [], '2026-09').due, '0.00');              // a bad instalment takes nothing
});

// ── nextMonth, and the YYYY-MM contract ───────────────────────────────
test('nextMonth: adds one month, zero-pads, and rolls the year', () => {
  const rows = [['2026-01', '2026-02'], ['2026-08', '2026-09'], ['2026-09', '2026-10'], ['2026-11', '2026-12'],
    ['2026-12', '2027-01'], ['2099-12', '2100-01']];
  for (const [from, want] of rows) assert.equal(nextMonth(from), want, from);
});

test('nextMonth: anything that is not YYYY-MM is a TypeError', () => {
  const bad = ['2026-13', '2026-00', '2026-1', '2026-8', '2026-08-01', '26-08', '', ' 2026-08', null, undefined,
    202608, new Date(Date.UTC(2026, 7, 1)), ['2026-08']];
  for (const value of bad) assert.throws(() => nextMonth(value), TypeError, String(value));
});

test('months must be YYYY-MM everywhere, so a wrong shape cannot quietly shift a schedule', () => {
  // '2026-08' sorts before '2026-08-01': a first_due_month with a day on it would start a month late.
  assert.throws(() => dueForMonth({ ...loan, first_due_month: '2026-08-01' }, tx0, [], '2026-08'), TypeError);
  assert.throws(() => dueForMonth({ ...loan, first_due_month: null }, tx0, [], '2026-08'), TypeError);
  assert.throws(() => dueForMonth(loan, tx0, [], '2026-8'), TypeError);
  assert.throws(() => dueForMonth(loan, tx0, ['2026-11-01'], '2026-11'), TypeError);       // a holiday that could never match
  assert.throws(() => projectSchedule({ ...loan, first_due_month: '2026-08-01' }, tx0, [], '2026-08'), TypeError);
  assert.throws(() => projectSchedule(loan, tx0, [], '2026-8'), TypeError);
  assert.throws(() => projectSchedule(loan, tx0, ['Nov 2026'], '2026-08'), TypeError);
});

// ── projectSchedule ───────────────────────────────────────────────────
test('projectSchedule: each row is exactly {month, opening, due, recovered, closing, status}, and the rows chain', () => {
  const sch = projectSchedule(loan, tx1, [], '2026-08');
  assert.deepEqual(table(sch), [
    ['2026-08', '20000.00', '5000.00', '5000.00', '15000.00', 'recovered'],
    ['2026-09', '15000.00', '5000.00', '2000.00', '13000.00', 'partial'],
    ['2026-10', '13000.00', '5000.00', '0.00', '8000.00', 'projected'],
    ['2026-11', '8000.00', '5000.00', '0.00', '3000.00', 'projected'],
    ['2026-12', '3000.00', '3000.00', '0.00', '0.00', 'projected'],
  ]);
  assert.deepEqual(sch[0], { month: '2026-08', opening: '20000.00', due: '5000.00', recovered: '5000.00', closing: '15000.00', status: 'recovered' });
  assertChain(sch);
});

test('projectSchedule: it starts at the later of fromMonth and the first due month', () => {
  const sch = projectSchedule(loan, tx1, [], '2026-08');
  assert.deepEqual(projectSchedule(loan, tx1, [], '2026-01'), sch);          // earlier than the first due month: starts there
  assert.deepEqual(projectSchedule(loan, tx1, [], '2025-12'), sch);          // an earlier year, too
  assert.deepEqual(projectSchedule(loan, tx1, [], '2026-09'), sch.slice(1)); // Sep opens at 15000: its own 2000 goes back on
  assert.deepEqual(projectSchedule(loan, tx1, [], '2026-10'), sch.slice(2));
});

test('projectSchedule: a fromMonth past the next unrecovered month opens at the balance as it stands', () => {
  // Decision: the months skipped over are not assumed paid, so the first row opens with what is owed now.
  assert.deepEqual(table(projectSchedule(loan, tx1, [], '2026-12')), [
    ['2026-12', '13000.00', '5000.00', '0.00', '8000.00', 'projected'],
    ['2027-01', '8000.00', '5000.00', '0.00', '3000.00', 'projected'],
    ['2027-02', '3000.00', '3000.00', '0.00', '0.00', 'projected'],
  ]);
});

test('projectSchedule: recovered means recovered >= due; one paisa short is partial; more is still recovered', () => {
  const more = projectSchedule(loan, [...tx0, rec('8000', '2026-08')], [], '2026-08');
  assert.deepEqual(table(more), [
    ['2026-08', '20000.00', '5000.00', '8000.00', '12000.00', 'recovered'],
    ['2026-09', '12000.00', '5000.00', '0.00', '7000.00', 'projected'],
    ['2026-10', '7000.00', '5000.00', '0.00', '2000.00', 'projected'],
    ['2026-11', '2000.00', '2000.00', '0.00', '0.00', 'projected'],
  ]);
  const less = projectSchedule(loan, [...tx0, rec('4999.99', '2026-08')], [], '2026-08');
  assert.deepEqual(less[0], { month: '2026-08', opening: '20000.00', due: '5000.00', recovered: '4999.99', closing: '15000.01', status: 'partial' });
  assert.equal(less[1].status, 'projected');
});

test('projectSchedule: several recoveries in one month add up', () => {
  const split = projectSchedule(loan, [...tx0, rec('3000', '2026-08'), rec('2000', '2026-08')], [], '2026-08');
  assert.deepEqual(table(split), [
    ['2026-08', '20000.00', '5000.00', '5000.00', '15000.00', 'recovered'],
    ['2026-09', '15000.00', '5000.00', '0.00', '10000.00', 'projected'],
    ['2026-10', '10000.00', '5000.00', '0.00', '5000.00', 'projected'],
    ['2026-11', '5000.00', '5000.00', '0.00', '0.00', 'projected'],
  ]);
});

test('projectSchedule: a missed month before the latest recovery is partial, with nothing recovered', () => {
  const missed = projectSchedule(loan, [...tx0, rec('5000', '2026-08'), rec('5000', '2026-10')], [], '2026-08');
  assert.deepEqual(table(missed), [                                          // the shortfall pushes the end from November to December
    ['2026-08', '20000.00', '5000.00', '5000.00', '15000.00', 'recovered'],
    ['2026-09', '15000.00', '5000.00', '0.00', '15000.00', 'partial'],
    ['2026-10', '15000.00', '5000.00', '5000.00', '10000.00', 'recovered'],
    ['2026-11', '10000.00', '5000.00', '0.00', '5000.00', 'projected'],
    ['2026-12', '5000.00', '5000.00', '0.00', '0.00', 'projected'],
  ]);
  assertChain(missed);
});

test('projectSchedule: a holiday row is due nothing and leaves the balance where it was', () => {
  const hol = projectSchedule(loan, tx1, ['2026-11'], '2026-10');
  assert.deepEqual(table(hol), [
    ['2026-10', '13000.00', '5000.00', '0.00', '8000.00', 'projected'],
    ['2026-11', '8000.00', '0.00', '0.00', '8000.00', 'holiday'],
    ['2026-12', '8000.00', '5000.00', '0.00', '3000.00', 'projected'],
    ['2027-01', '3000.00', '3000.00', '0.00', '0.00', 'projected'],
  ]);
  assertChain(hol);
});

test('projectSchedule: a holiday explains a missed month; money really taken in one still shows as recovered', () => {
  const missed = [...tx0, rec('5000', '2026-08'), rec('5000', '2026-10')];
  assert.deepEqual(table(projectSchedule(loan, missed, ['2026-09'], '2026-08')).slice(0, 3), [
    ['2026-08', '20000.00', '5000.00', '5000.00', '15000.00', 'recovered'],
    ['2026-09', '15000.00', '0.00', '0.00', '15000.00', 'holiday'],          // holiday, not 'partial'
    ['2026-10', '15000.00', '5000.00', '5000.00', '10000.00', 'recovered'],
  ]);
  // Decision: what payroll actually took is fact, so a typed override in a holiday month reads 'recovered'.
  const sep = projectSchedule(loan, tx1, ['2026-09'], '2026-08')[1];
  assert.deepEqual(sep, { month: '2026-09', opening: '15000.00', due: '0.00', recovered: '2000.00', closing: '13000.00', status: 'recovered' });
});

test('projectSchedule: it stops when the balance reaches zero', () => {
  const small = { ...loan, principal: '10000' };
  const paid = [{ kind: 'disbursed', principal_amount: '10000' }, rec('5000', '2026-08'), rec('5000', '2026-09')];
  assert.deepEqual(table(projectSchedule(small, paid, [], '2026-08')), [
    ['2026-08', '10000.00', '5000.00', '5000.00', '5000.00', 'recovered'],
    ['2026-09', '5000.00', '5000.00', '5000.00', '0.00', 'recovered'],
  ]);
  assert.deepEqual(projectSchedule(loan, [], [], '2026-08'), []);            // nothing on the books, nothing to lay out
});

test('projectSchedule: a loan that is not active has no future rows, but its history keeps what was due', () => {
  for (const status of ['closed', 'cancelled']) {
    assert.deepEqual(table(projectSchedule({ ...loan, status }, tx1, [], '2026-08')), [
      ['2026-08', '20000.00', '5000.00', '5000.00', '15000.00', 'recovered'],
      ['2026-09', '15000.00', '5000.00', '2000.00', '13000.00', 'partial'],
    ], status);
    assert.deepEqual(projectSchedule({ ...loan, status }, tx0, [], '2026-08'), [], status);
  }
});

test('projectSchedule: a prepayment brings the end forward', () => {
  const prepaid = [...tx1, { kind: 'prepayment', principal_amount: '8000' }];  // 5000 left after it
  assert.deepEqual(table(projectSchedule(loan, prepaid, [], '2026-10')), [
    ['2026-10', '5000.00', '5000.00', '0.00', '0.00', 'projected'],
  ]);
  // A prepayment has no month of its own, so the first row opens as if it had already been made.
  const full = projectSchedule(loan, prepaid, [], '2026-08');
  assert.deepEqual(table(full), [
    ['2026-08', '12000.00', '5000.00', '5000.00', '7000.00', 'recovered'],
    ['2026-09', '7000.00', '5000.00', '2000.00', '5000.00', 'partial'],
    ['2026-10', '5000.00', '5000.00', '0.00', '0.00', 'projected'],
  ]);
  assertChain(full);
});

test('projectSchedule: max caps the rows (120 unless told otherwise), counting months across the years', () => {
  assert.deepEqual(table(projectSchedule(loan, tx0, [], '2026-08', 3)), [
    ['2026-08', '20000.00', '5000.00', '0.00', '15000.00', 'projected'],
    ['2026-09', '15000.00', '5000.00', '0.00', '10000.00', 'projected'],
    ['2026-10', '10000.00', '5000.00', '0.00', '5000.00', 'projected'],
  ]);
  const slow = projectSchedule({ ...loan, instalment: '1' }, tx0, [], '2026-08');   // 20000 months of 1 would never end
  assert.equal(slow.length, 120);
  assert.equal(slow[0].month, '2026-08');
  assert.equal(slow[119].month, '2036-07');                                  // 119 months after 2026-08
  assert.equal(slow[119].closing, '19880.00');
  assertChain(slow);
});

test('projectSchedule: only payroll_recovery rows need a run_month; the others may have none or null', () => {
  const mixed = [{ kind: 'disbursed', principal_amount: '20000', run_month: null },
    { kind: 'prepayment', principal_amount: '1000' }, rec('5000', '2026-08')];
  assert.equal(projectSchedule(loan, mixed, [], '2026-08')[0].status, 'recovered');
  assert.throws(() => projectSchedule(loan, [...tx0, { kind: 'payroll_recovery', principal_amount: '5000' }], [], '2026-08'), TypeError);
  assert.throws(() => projectSchedule(loan, [...tx0, rec('5000', null)], [], '2026-08'), TypeError);
});

test('nothing the caller passes in is changed', () => {
  const frozenLoan = Object.freeze({ ...loan });
  const frozenTxns = Object.freeze(tx1.map((t) => Object.freeze({ ...t })));
  const frozenHolidays = Object.freeze(['2026-11', '2026-10']);
  assert.equal(loanOutstanding(frozenLoan, frozenTxns), '13000.00');
  assert.equal(dueForMonth(frozenLoan, frozenTxns, frozenHolidays, '2026-12').due, '5000.00');
  assert.equal(projectSchedule(frozenLoan, frozenTxns, frozenHolidays, '2026-08').length, 7);   // Aug, Sep, two holidays, Dec, Jan, Feb
});
