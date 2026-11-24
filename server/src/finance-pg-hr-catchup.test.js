import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';
import { finHrFixtures } from './finance-hr-fixtures.js';
import { FIN_SENTENCES } from './finance-errors.js';

// The safety net behind HR's feed (Cash & Bank spec §5's header line, §7.5, §7.7, §9.5; plan Task 13; rulings R36–R38, R45): what
// waits, "Bring in from HR", the exceptions and their retry, and the control check of Staff Advances, Staff Loans and Salary Payable
// against HR. Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-catchup.test.js
//
// One boot for the file. The tests share it and run in order; each makes HR rows of its own with SQL as HR writes them
// (finance-hr-fixtures.js) and never calls the feed for them, which is exactly what the after-commit call missing looks like, and each
// leaves the CI book with nothing waiting, so the next one starts clean. Runs: December 2026 (the cut-over), and January, February and
// April to October 2027, one each. The CASH channel pays from Office cash, COLOUR from Bank – current and DARBI from DP's bank; SPARE
// (and the two more spare banks the hidden-exception test adds) is mapped only when the exceptions tests say so. "Today" is given where
// it matters (the plant's real today is before the books begin). Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, feed, catchup, fx, CI, DP, ACCT, MD, APPR2;
const L = {};    // CI ledger name -> id
const D = {};    // DP ledger name -> id
const GROUPS = {};

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
function refused(r, status, code) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  return r;
}
const groupOf = (book, name) => {
  const g = GROUPS[book].find(x => x.name === name);
  assert.ok(g, `no group called ${name}`);
  return g.id;
};
const makeLedger = async (book, group, name, extra = {}) => {
  const body = await ok(h.call('POST', '/finance/ledgers', { book_id: book, group_id: groupOf(book, group), name, ...extra }, 'acct'));
  (book === CI ? L : D)[name] = body.ledger.id;
  return body.ledger;
};
const saveSetup = body => ok(h.call('PUT', '/finance/hr-setup', body, 'md'));
const post = (type, id, who = ACCT) => feed.finHrPost({ type, id }, who);
const pendingIn = (book, asOf) => catchup.finHrPending(h.db.q, book, { asOf });
const bringIn = (book, who, asOf) => catchup.finBringInFromHr(book, who, { asOf });
const statusOf = (book, today) => catchup.finHrStatus(book, { today });
const control = (book, asAt, today = asAt) => catchup.finHrControl(h.db.q, book, asAt, { today });
const voucherRow = id => h.db.one(
  `SELECT id, book_id, voucher_type, voucher_date, narration, status, source_type, source_id, reversed_by_id FROM fin_vouchers WHERE id = $1`, [id]);
const linesOf = async id => (await h.db.q(
  `SELECT fl.name, l.debit, l.credit FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id WHERE l.voucher_id = $1 ORDER BY l.line_no`,
  [id])).map(l => [l.name, Math.round(l.debit * R), Math.round(l.credit * R)]);
// The vouchers that stand for a source (H8): posted or waiting, not reversed, not a reversal.
const standing = async (sourceType, sourceId) => (await h.db.q(
  `SELECT id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 AND status IN ('submitted', 'posted') AND reversed_by_id IS NULL
      AND reversal_of_id IS NULL ORDER BY id`, [sourceType, sourceId])).map(v => v.id);
const vouchersOf = (sourceType, sourceId) => h.db.q(
  'SELECT id, status, reversed_by_id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 ORDER BY id', [sourceType, sourceId]);
const exceptionOf = (sourceType, sourceId) => h.db.one(
  `SELECT id, book_id, reason_code, reason, first_seen_at, last_tried_at, resolved_at, voucher_id FROM fin_hr_exceptions
    WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId]);
const count = async table => (await h.db.one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
const approve = id => ok(h.call('POST', `/finance/vouchers/${id}/approve`, null, 'md'));
const lineOf = (runId, person) => h.db.one('SELECT id FROM hr.run_lines WHERE run_id = $1 AND person_id = $2', [runId, person]).then(r => r.id);
// What Bring-in re-runs to repair what the call after commit missed (rulings R38, R38a): the HR events with a voucher posted, not
// reversed, in the book, in a month that is not locked, dated in the calendar month of `asOf` or the one before, hidden people's
// combined entries apart. Each answers as it stands (skipped) unless HR changed it since.
const monthStartBefore = day => {
  const [y, m] = day.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
};
const monthEndOf = day => {
  const [y, m] = day.split('-').map(Number);
  return `${day.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const driftIn = async (book, asOf) => (await h.db.one(
  `SELECT count(DISTINCT (regexp_replace(v.source_type, ':DP$', ''), v.source_id))::int AS n
     FROM fin_vouchers v JOIN fin_periods p ON p.id = v.period_id
    WHERE v.book_id = $1 AND v.status = 'posted' AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL
      AND v.source_type LIKE 'hr\\_%' AND v.source_type NOT LIKE 'hr\\_hidden:%' AND p.status <> 'locked'
      AND v.voucher_date >= $2 AND v.voucher_date <= $3`, [book, monthStartBefore(asOf), monthEndOf(asOf)])).n;
// A ledger's balance (debit − credit, paise) from its posted lines dated `asAt` or before.
const balance = async (ledgerId, asAt = '2028-03-31') => (await h.db.one(
  `SELECT COALESCE(round(sum(ln.debit - ln.credit) * 100), 0)::bigint AS n FROM fin_voucher_lines ln JOIN fin_vouchers v ON v.id = ln.voucher_id
    WHERE ln.ledger_id = $1 AND v.status = 'posted' AND v.voucher_date <= $2`, [ledgerId, asAt])).n;
const byName = lines => [...lines].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]);
// A payroll month made through HR's own doors, the engine working it out (inputs, submit, approve, the lines approved for payment,
// finalise), its journal booked by the call after the finalise commits; `leaveOut`, people with a pay setup left out of the month (HR
// submits a month only once everyone due is in it or left out). Answers the run.
async function hrMonth(month, people, { leaveOut = [] } = {}) {
  const rows = [...people.map(id => ({ person_id: id, absent_days: 0 })), ...leaveOut.map(id => ({ person_id: id, include: false }))];
  await ok(h.call('PUT', `/hr/runs/${month}/inputs`, { rows }, 'acct'));
  await ok(h.call('POST', `/hr/runs/${month}/submit`, {}, 'acct'));
  await ok(h.call('POST', `/hr/runs/${month}/approve`, {}, 'md'));
  await ok(h.call('POST', `/hr/runs/${month}/lines/approval`, { person_ids: people, action: 'approve' }, 'md'));
  await ok(h.call('POST', `/hr/runs/${month}/finalise`, {}, 'md'));
  return h.db.one('SELECT id, status FROM hr.runs WHERE month = $1', [month]);
}
const periodOf = (book, start) => h.db.one('SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = $2', [book, start]).then(p => p.id);
const moveMonth = (id, status, reason = null) => ok(h.call('PUT', `/finance/periods/${id}/status`, { status, reason }, 'md'));
// A line paid on its own by the drawer, as hr-payroll.js marks it: paid_amount = payable, the day and the account it was paid from.
const payAlone = (lineId, { paidOn, paidFrom }) => h.db.q(
  `UPDATE hr.run_lines SET payment_status = 'paid', paid_amount = payable, paid_on = $2::date, paid_at = now(), paid_from = $3 WHERE id = $1`,
  [lineId, paidOn, paidFrom]);
// The control check's three figures of one item, in paise (ruling R37b: there is no fourth, no figure of what is not due yet).
const figures = item => item && [item.finance_paise, item.hr_paise, item.gap_paise];
// Where Bring-in's drift repair goes on in a book (ruling R38b): the voucher id the last press stopped after, or null for the newest.
const cursorOf = book => h.db.one('SELECT hr_drift_cursor FROM fin_book_settings WHERE book_id = $1', [book]).then(r => r.hr_drift_cursor);

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-catchup');
  feed = await import('./finance-hr-feed.js');
  catchup = await import('./finance-hr-catchup.js').catch(() => ({}));
  fx = finHrFixtures(h.db);
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const book of [CI, DP]) GROUPS[book] = (await ok(h.call('GET', `/finance/books/${book}/groups`, null, 'md'))).groups;
  // The financial year after the one the books begin in, for the events of April 2027 on.
  for (const book of [CI, DP]) await ok(h.call('POST', '/finance/years', { book_id: book, label: '2027-28' }, 'md'));
  ACCT = { id: h.users.acct.id, name: 'Test Accountant' };
  MD = { id: h.users.md.id, name: 'Test MD' };
  APPR2 = { id: h.users.appr2.id, name: 'Test Second Approver' };

  await fx.channels();
  for (const [user, level] of [[h.users.md.id, 'admin'], [h.users.acct.id, 'accounts'], [h.users.appr2.id, 'approver'], [h.users.viewer.id, 'operator']]) {
    await fx.access(user, level);
  }
  await makeLedger(CI, 'Cash-in-Hand', 'Office cash');
  await makeLedger(CI, 'Bank Accounts', 'Bank – current');
  await makeLedger(CI, 'Bank Accounts', 'Bank – spare');
  await makeLedger(CI, 'Indirect Expenses', 'Advance Waivers');
  await makeLedger(CI, 'Indirect Incomes', 'Staff Deductions');
  await makeLedger(CI, 'Indirect Expenses', 'Rounding Off');
  await makeLedger(CI, 'Current Liabilities', 'Darbi Print Pack');
  await makeLedger(DP, 'Bank Accounts', 'DP Bank');
  await makeLedger(DP, 'Loans & Advances (Asset)', 'Colour Impressions');
  await makeLedger(DP, 'Indirect Expenses', 'DP Rounding Off');
  for (const book of [CI, DP]) await ok(h.call('POST', '/finance/hr-setup/ledgers', { book_id: book }, 'md'));
  for (const l of await h.db.q('SELECT id, book_id, name FROM fin_ledgers')) (l.book_id === CI ? L : D)[l.name] = l.id;
  await saveSetup({
    book_id: CI,
    channels: [
      { channel_code: 'CASH', ledger_id: L['Office cash'] },
      { channel_code: 'COLOUR', ledger_id: L['Bank – current'] },
      { channel_code: 'DARBI', ledger_id: D['DP Bank'] },
    ],
    roles: { advance_waiver: L['Advance Waivers'], other_deductions: L['Staff Deductions'], rounding: L['Rounding Off'], intercompany: L['Darbi Print Pack'] },
  });
  await saveSetup({ book_id: DP, roles: { rounding: D['DP Rounding Off'], intercompany: D['Colour Impressions'] } });
});

after(async () => { await h?.close(); });

// ── What waits, and Bring-in (spec §7.7; ruling R36) ─────────────────────────────────────────

test('an event the after-commit call missed shows as waiting 1; Bring in posts it once; waiting 0', gate, async () => {
  const status = who => ok(h.call('GET', `/finance/hr/status?book=${CI}`, null, who));
  assert.deepEqual([(await status('acct')).waiting, (await status('acct')).exceptions], [0, 0], 'a clean start');
  const a = await fx.person({ name: 'Test Person A' });
  // Given in HR, and the call after HR's commit never ran (the process stopped between the two): no voucher, and no exception.
  const adv = await fx.advance({ person: a, date: '2027-01-11', rupees: 5000, paidVia: 'cash', by: ACCT.id });
  const waiting = await status('viewer');   // a view-only login reads the count
  assert.deepEqual([waiting.waiting, waiting.exceptions], [1, 0]);
  assert.deepEqual(await pendingIn(CI), [{ type: 'advance', id: adv }]);
  assert.equal((await ok(h.call('GET', `/finance/hr/status?book=${DP}`, null, 'acct'))).waiting, 0, 'a Colour person\'s cash advance waits in CI only');
  refused(await h.call('POST', '/finance/hr/bring-in', { book_id: CI }, 'viewer'), 403, 'FIN_FORBIDDEN');

  const brought = await ok(h.call('POST', '/finance/hr/bring-in', { book_id: CI }, 'acct'));
  assert.deepEqual(brought, { posted: 1, submitted: 0, skipped: 0, exceptions: [], more: false });
  const [id] = await standing('hr_advance', adv);
  const v = await voucherRow(id);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.status], [CI, 'payment', '2027-01-11', 'Advance · Pay staff · 1 person', 'posted']);
  assert.deepEqual(await linesOf(id), [['Staff Advances', 5000 * R, 0], ['Office cash', 0, 5000 * R]]);
  assert.equal((await status('acct')).waiting, 0);

  // Brought in again: nothing waits, and the advance is no repair of the plant's month or the one before (R38a), so nothing is tried
  // and nothing is written.
  const was = { vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') };
  assert.deepEqual(await ok(h.call('POST', '/finance/hr/bring-in', { book_id: CI }, 'acct')),
    { posted: 0, submitted: 0, skipped: 0, exceptions: [], more: false });
  assert.deepEqual({ vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') }, was);
  assert.deepEqual((await vouchersOf('hr_advance', adv)).map(x => x.id), [id], 'posted once');
});

// ── The control check (spec §7.5, §9.5; ruling R37) ─────────────────────────────────────────

let janRun;
test('control matches after a month of advances and recoveries; an HR adjustment made with the feed switched off shows gap_paise equal to it', gate, async () => {
  const a = await fx.person({ name: 'Test Control A' });
  const b = await fx.person({ name: 'Test Control B' });
  const c = await fx.person({ name: 'Test Control C' });
  await fx.advance({ person: a, date: '2027-01-05', rupees: 6000, paidVia: 'cash', by: ACCT.id });
  const loan = await fx.loan({ person: b, loanNo: 'CI-LN-0701', date: '2027-01-06', rupees: 20000, paidVia: 'cash', by: ACCT.id });
  janRun = await fx.payroll({ month: '2027-01', approvedBy: MD.id, lines: [
    { person: a, gross: 15000, advanceRecovery: 2000 }, { person: b, gross: 18000, loanRecovery: 2500 }, { person: c, gross: 12000, advanceGiven: 1000 }] });
  await fx.finalise(janRun.id, { at: '2027-02-03T11:00:00+05:30', by: ACCT.id });
  // …and the loan's instalment finalise takes, as hr/runs.js posts it (the fixture posts the advance rows): dated the finalise day.
  await h.db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, run_id, note, created_by)
                VALUES ($1, '2027-02-03', 'payroll_recovery', 2500, $2, 'Payroll 2027-01: instalment recovered from pay', $3)`,
  [loan.id, janRun.id, ACCT.id]);

  // None of it reached Finance: before Bring-in, HR holds what Finance does not.
  const missed = await control(CI, '2027-02-15');
  assert.equal(missed.matches, false);
  assert.deepEqual(figures(missed.advances), [5000 * R, 10000 * R, 5000 * R], 'Finance holds only the first test\'s advance');
  // The advance, the loan, the payroll journal and the sheet's advances; the first test's advance stands (skipped).
  assert.deepEqual(await bringIn(CI, ACCT, '2027-02-15'), { posted: 4, submitted: 0, skipped: 1, exceptions: [], more: false });
  assert.deepEqual(await pendingIn(CI, '2027-02-15'), []);

  // HR: 5,000 + 6,000 given, 1,000 on the payroll sheet, 2,000 recovered = 10,000; 20,000 lent, 2,500 recovered = 17,500; January's
  // payable 13,000 + 15,500 + 12,000 = 40,500, none paid yet. Finance the same, every way round.
  const now = await control(CI, '2027-02-15');
  assert.deepEqual(now, {
    as_at: '2027-02-15',
    advances: { finance_paise: 10000 * R, hr_paise: 10000 * R, gap_paise: 0 },
    loans: { finance_paise: 17500 * R, hr_paise: 17500 * R, gap_paise: 0 },
    salary_payable: { finance_paise: 40500 * R, hr_paise: 40500 * R, gap_paise: 0 },
    matches: true,
  });
  // R52: HR dates the recoveries the day it finalised (3 Feb) and the sheet's advance the month end; Finance books the recoveries in
  // the journal at the month end and the sheet's advance on the finalise day. Each payroll-made row counts when Finance books it, so
  // the check holds at the month end and on the days before the finalise as well.
  for (const day of ['2027-01-31', '2027-02-02', '2027-02-03']) {
    const then = await control(CI, day, '2027-02-15');
    assert.deepEqual([then.advances.gap_paise, then.loans.gap_paise, then.matches], [0, 0, true], `as at ${day}: ${JSON.stringify(then)}`);
  }
  assert.deepEqual(figures((await control(CI, '2027-01-31', '2027-02-15')).advances), [9000 * R, 9000 * R, 0],
    'as at 31 Jan: 11,000 given less the 2,000 the January journal recovered; the sheet\'s 1,000 is booked on 3 Feb');

  // An adjustment typed into HR's advance ledger, that no HR door tells Finance of: a real gap, of exactly its amount, from its day on.
  const adj = await h.db.one(
    `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note, created_by)
     VALUES ($1, '2027-02-10', 'adjustment', 750, 'manual', 'Test adjustment typed into HR', $2) RETURNING id`, [a, MD.id]);
  try {
    const gap = await control(CI, '2027-02-15');
    assert.deepEqual(figures(gap.advances), [10000 * R, 10750 * R, 750 * R]);
    assert.deepEqual([gap.loans.gap_paise, gap.salary_payable.gap_paise, gap.matches], [0, 0, false]);
    assert.equal((await control(CI, '2027-02-09')).matches, true, 'as at the day before it, nothing is out');
    assert.deepEqual(await pendingIn(CI, '2027-02-15'), [], 'an adjustment is no event: nothing waits, and Bring-in has nothing to post');
  } finally {
    await h.db.q('DELETE FROM hr.advance_txns WHERE id = $1', [adj.id]);
  }
  assert.equal((await control(CI, '2027-02-15')).matches, true);
});

test('R37, R37b: hidden people\'s money of a month that has not ended is not yet due: left out of hr_paise, and no figure moves by one hidden event; once the month ends it is a gap until Bring-in posts it', gate, async () => {
  const hid = await fx.person({ name: 'Test Control Hidden', channel: 'COLOUR' });
  const shown = await fx.person({ name: 'Test Control Shown' });
  await fx.hide(hid, { user: ACCT.id });
  const run = await fx.payroll({ month: '2027-02', approvedBy: MD.id, lines: [{ person: hid, gross: 9000 }, { person: shown, gross: 8000 }] });
  await fx.finalise(run.id, { at: '2027-03-02T10:00:00+05:30', by: MD.id });
  await fx.payBatch({ lineIds: [await lineOf(run.id, hid)], channel: 'COLOUR', batchNo: 'CI-PAY-0301', paidOn: '2027-03-12', by: MD.id });
  await fx.advance({ person: hid, date: '2027-03-10', rupees: 3000, paidVia: 'cash', by: MD.id });
  // The February journal waits; the hidden person's payout and advance do not (their combined entries come once March has ended).
  assert.deepEqual(await pendingIn(CI, '2027-03-20'), [{ type: 'run', id: run.id }]);
  // The journal posts; of what stands, only the sheet's advances (3 Feb) are dated in February or March (R38a).
  assert.deepEqual(await bringIn(CI, MD, '2027-03-20'), { posted: 1, submitted: 0, skipped: 1, exceptions: [], more: false });

  // Mid-March: the 3,000 advance and the 9,000 payout are HR's, and not Finance's yet, and that is no gap. Neither shows anywhere.
  const mid = await control(CI, '2027-03-20');
  assert.deepEqual(figures(mid.advances), [10000 * R, 10000 * R, 0]);
  assert.deepEqual(figures(mid.salary_payable), [57500 * R, 57500 * R, 0],
    'HR has 48,500 unpaid; Finance still holds the 9,000 paid to the hidden person until March\'s combined entry');
  assert.equal(mid.matches, true);
  assert.deepEqual(Object.keys(mid.advances).sort(), ['finance_paise', 'gap_paise', 'hr_paise'], 'R37b: no figure of what is not due yet');
  // R37b: one more hidden event before the month ends moves nothing in the answer, so no two readings of it tell one person's money.
  const extra = await fx.advance({ person: hid, date: '2027-03-18', rupees: 450, paidVia: 'cash', by: MD.id });
  try {
    assert.deepEqual(await control(CI, '2027-03-20'), mid);
    assert.deepEqual((await statusOf(CI, '2027-03-20')).control, mid);
  } finally {
    await h.db.q('DELETE FROM hr.advance_txns WHERE id = $1', [extra]);
  }
  assert.deepEqual(await pendingIn(CI, '2027-03-31'), [], 'March has not ended');

  // April: March has ended, so its combined entries are due, and waiting (one month, though two accounts paid); not posted, a real gap.
  assert.deepEqual(await pendingIn(CI, '2027-04-05'), [{ type: 'hidden', id: 202703 }]);
  const late = await control(CI, '2027-04-05');
  assert.deepEqual(figures(late.advances), [10000 * R, 13000 * R, 3000 * R]);
  assert.deepEqual(figures(late.salary_payable), [57500 * R, 48500 * R, -9000 * R]);
  assert.equal(late.matches, false);
  assert.deepEqual(await bringIn(CI, MD, '2027-04-05'), { posted: 2, submitted: 0, skipped: 0, exceptions: [], more: false },
    'the two combined entries; nothing that stands is dated in March or April');
  assert.deepEqual(await pendingIn(CI, '2027-04-05'), []);
  const after = await control(CI, '2027-04-05');
  assert.deepEqual([figures(after.advances), figures(after.salary_payable), after.matches],
    [[13000 * R, 13000 * R, 0], [48500 * R, 48500 * R, 0], true]);
});

test('as at 2026-12-31 with month_end, salary_payable\'s gap is December\'s payable still unpaid when the opening lacks it (§9.5); with when_paid it is null', gate, async () => {
  const d1 = await fx.person({ name: 'Test December One' });
  const d2 = await fx.person({ name: 'Test December Two' });
  const run = await fx.payroll({ month: '2026-12', approvedBy: MD.id, lines: [{ person: d1, gross: 10000 }, { person: d2, gross: 12000 }] });
  await fx.finalise(run.id, { at: '2027-01-03T10:00:00+05:30', by: MD.id });
  await fx.payBatch({ lineIds: [await lineOf(run.id, d1)], channel: 'CASH', batchNo: 'CI-PAY-0401', paidOn: '2026-12-31', by: MD.id });
  await fx.payBatch({ lineIds: [await lineOf(run.id, d2)], channel: 'CASH', batchNo: 'CI-PAY-0402', paidOn: '2027-01-05', by: MD.id });

  // On 31 December HR still owes Test December Two's 12,000 (paid on 5 January); this book has no Opening, so Finance holds nothing.
  const cut = await control(CI, '2026-12-31', '2027-01-10');
  assert.deepEqual(cut, {
    as_at: '2026-12-31',
    advances: { finance_paise: 0, hr_paise: 0, gap_paise: 0 },
    loans: { finance_paise: 0, hr_paise: 0, gap_paise: 0 },
    salary_payable: { finance_paise: 0, hr_paise: 12000 * R, gap_paise: 12000 * R },
    matches: false,
  });
  // No day before the opening is kept: a check asked as at one is the cut-over check.
  assert.deepEqual(await control(CI, '2026-11-30', '2027-01-10'), cut);
  await saveSetup({ book_id: CI, payroll_booking: 'when_paid' });
  try {
    const paid = await control(CI, '2026-12-31', '2027-01-10');
    assert.deepEqual([paid.salary_payable, paid.matches], [null, true], 'with when_paid there is nothing to check here');
  } finally {
    await saveSetup({ book_id: CI, payroll_booking: 'month_end' });
  }
  // December's journal is in the opening (before the books); only its January payout waits.
  assert.deepEqual(await pendingIn(CI, '2027-01-10'), [{ type: 'batch', id: await h.db.one(`SELECT id FROM hr.payment_batches WHERE batch_no = 'CI-PAY-0402'`).then(x => x.id) }]);
  assert.deepEqual(await bringIn(CI, MD, '2027-01-10'), { posted: 1, submitted: 0, skipped: 4, exceptions: [], more: false },
    'the January payout; what stands of December and January (the three January events and January\'s journal) is skipped');
});

test('R52, R52a: with when_paid, the status matches between the finalise and the first payment, the recoveries not due yet left out; paid but not booked, a real gap; booked, they count; switched to month_end, Salary Payable dates the run by its journal', gate, async () => {
  const a = await fx.person({ name: 'Test Paid Later A' });
  const b = await fx.person({ name: 'Test Paid Later B' });
  await fx.advance({ person: a, date: '2027-03-04', rupees: 3000, paidVia: 'cash', by: MD.id });
  const loan = await fx.loan({ person: b, loanNo: 'CI-LN-0705', date: '2027-03-05', rupees: 9000, paidVia: 'cash', by: MD.id });
  const run = await fx.payroll({ month: '2027-03', approvedBy: MD.id,
    lines: [{ person: a, gross: 10000, advanceRecovery: 1000 }, { person: b, gross: 11000, loanRecovery: 1500 }] });
  await saveSetup({ book_id: CI, payroll_booking: 'when_paid' });
  try {
    await fx.finalise(run.id, { at: '2027-04-02T10:00:00+05:30', by: MD.id });
    await h.db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, run_id, note, created_by)
                  VALUES ($1, '2027-04-02', 'payroll_recovery', 1500, $2, 'Payroll 2027-03: instalment recovered from pay', $3)`,
    [loan.id, run.id, MD.id]);
    // The advance and the loan post; the journal waits for its first payment.
    const first = await bringIn(CI, MD, '2027-04-04');
    assert.deepEqual([first.posted, first.submitted, first.exceptions], [2, 0, []], JSON.stringify(first));
    assert.deepEqual(await standing('hr_run', run.id), []);
    // Between the finalise and the first payment, HR has recovered 1,000 and 1,500 that Finance books only once the month is paid:
    // not due yet, so left out of HR's figure, silently (R37b: no figure says what is not due).
    const between = (await statusOf(CI, '2027-04-04')).control;
    assert.equal(between.salary_payable, null);
    assert.deepEqual([between.advances.gap_paise, between.loans.gap_paise, Object.keys(between.loans).sort()],
      [0, 0, ['finance_paise', 'gap_paise', 'hr_paise']]);
    assert.equal(between.matches, true, JSON.stringify(between));
    // Paid on 6 April, which dates the journal: until Bring-in books it, the recoveries are a real gap.
    await fx.payBatch({ lineIds: run.lineIds, channel: 'CASH', batchNo: 'CI-PAY-0305', paidOn: '2027-04-06', by: MD.id });
    const unbooked = (await statusOf(CI, '2027-04-07')).control;
    assert.deepEqual([unbooked.advances.gap_paise, unbooked.loans.gap_paise, unbooked.matches], [-1000 * R, -1500 * R, false]);
    assert.equal((await bringIn(CI, MD, '2027-04-07')).posted, 2, 'the journal, dated its first payment, and the batch');
    assert.equal((await voucherRow((await standing('hr_run', run.id))[0])).voucher_date, '2027-04-06');
    const booked = (await statusOf(CI, '2027-04-07')).control;
    assert.deepEqual([booked.advances.gap_paise, booked.loans.gap_paise, booked.matches], [0, 0, true]);
    // The book switched back to month_end while the journal stands on 6 April: the recoveries count on the day the journal stands at,
    // as Finance has booked them, not on the month end the new setting would give a journal not booked yet.
    await saveSetup({ book_id: CI, payroll_booking: 'month_end' });
    const switched = await control(CI, '2027-04-05', '2027-04-07');
    assert.deepEqual([switched.advances.gap_paise, switched.loans.gap_paise], [0, 0], JSON.stringify(switched));
    // R52a: and Salary Payable, now checked, dates the run by the journal that stands, 6 April: between the month end and that first
    // payment HR's figure leaves the run out, as Finance's does, so the run makes no gap; paid and booked, both hold it and its payment.
    // The gap both days is the cut-over test's: December 2026's payable, which the opening lacks (§9.5).
    const paidBy = await control(CI, '2027-04-07', '2027-04-07');
    assert.deepEqual([switched.salary_payable.gap_paise, paidBy.salary_payable.gap_paise], [12000 * R, 12000 * R],
      JSON.stringify([switched.salary_payable, paidBy.salary_payable]));
  } finally {
    await saveSetup({ book_id: CI, payroll_booking: 'month_end' });
  }
});

// ── finHrPending agrees with finHrPost (ruling R36) ──────────────────────────────────────────

test('R36: finHrPending agrees with finHrPost over a varied fixture: what it lists posts or waits, what it leaves out finHrPost skips for good, and after Bring-in it lists only entries waiting for an Approver', gate, async () => {
  const person = name => fx.person({ name });
  const ev = (type, id) => ({ type, id });
  // Listed: each posts (or waits for an Approver) when brought in.
  const a1 = await fx.advance({ person: await person('Test Mixed P1'), date: '2027-04-06', rupees: 4000, paidVia: 'cash', by: ACCT.id });
  const a2 = await fx.advance({ person: await person('Test Mixed P2'), date: '2027-04-07', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const sheetPeople = [await person('Test Mixed P4'), await person('Test Mixed P5')];
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0901', month: '2027-04', paidOn: '2027-04-08', paidVia: 'cash', by: ACCT.id, lines: [
    { person: sheetPeople[0], rupees: 3000, decidedBy: MD.id }, { person: sheetPeople[1], rupees: 10000, loanNo: 'CI-LN-0901', decidedBy: MD.id }] });
  const round = await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });
  const p9 = await person('Test Mixed P9');
  const l9 = await fx.loan({ person: p9, loanNo: 'CI-LN-0904', date: '2027-04-10', rupees: 12000, paidVia: 'cash', by: ACCT.id });
  const pp = await fx.prepay({ loan: l9.id, date: '2027-04-25', rupees: 1000, paidVia: 'cash', by: ACCT.id });
  const w = await fx.waiver({ person: await person('Test Mixed P10'), date: '2027-04-26', rupees: 500, by: MD.id });
  const runPeople = [await person('Test Mixed P11'), await person('Test Mixed P12'), await person('Test Mixed P13'), await person('Test Mixed P15')];
  const apr = await fx.payroll({ month: '2027-04', approvedBy: MD.id, lines: runPeople.map((p, i) => ({ person: p, gross: [10000, 11000, 12000, 9500][i] })) });
  await fx.finalise(apr.id, { at: '2027-05-03T10:00:00+05:30', by: ACCT.id });
  const [p11, p12, p13, p15] = await Promise.all(runPeople.map(p => lineOf(apr.id, p)));
  const b1 = await fx.payBatch({ lineIds: [p11, p12], channel: 'CASH', batchNo: 'CI-PAY-0501', paidOn: '2027-05-05', by: MD.id });
  await payAlone(p13, { paidOn: '2027-05-06', paidFrom: 'cash' });
  // Two hidden people's advances: no event of their own, but April's hidden money waits as one month once April has ended. P16's,
  // given by the accounts login from the bank, is a combined entry of its own that waits for md.
  const p6 = await person('Test Mixed P6');
  await fx.hide(p6, { user: ACCT.id });
  const a6 = await fx.advance({ person: p6, date: '2027-04-09', rupees: 2000, paidVia: 'cash', by: MD.id });
  const p16 = await person('Test Mixed P16');
  await fx.hide(p16, { user: ACCT.id });
  await fx.advance({ person: p16, date: '2027-04-12', rupees: 120000, paidVia: 'COLOUR', by: ACCT.id });
  // Left out: each is skipped by finHrPost for good, and nothing of it is written.
  const a3 = await fx.advance({ person: await person('Test Mixed P3'), date: '2026-12-20', rupees: 2500, paidVia: 'cash', by: ACCT.id });
  const l7 = await fx.loan({ person: await person('Test Mixed P7'), loanNo: 'CI-LN-0902', date: '2026-12-01', rupees: 8000, paidVia: 'cash', opening: true });
  const l8 = await fx.loan({ person: await person('Test Mixed P8'), loanNo: 'CI-LN-0903', date: '2027-04-10', rupees: 5000, paidVia: 'cash', by: ACCT.id });
  await fx.cancelLoan(l8.id, { date: '2027-04-11' });
  const b2 = await fx.payBatch({ lineIds: [p15], channel: 'CASH', batchNo: 'CI-PAY-0502', paidOn: '2027-05-05', by: MD.id });
  await fx.markLine(p15, 'failed');
  const may = await fx.payroll({ month: '2027-05', approvedBy: MD.id, lines: [{ person: await person('Test Mixed P14'), gross: 7000 }] });

  const listed = [ev('run', apr.id), ev('batch', b1), ev('sheet', Math.min(...sheet.lineIds)), ev('line', p13), ev('advance', a1), ev('advance', a2),
    ev('loan', l9.id), ev('prepay', pp), ev('waiver', w), ev('hidden', 202704)];
  const leftOut = [
    [ev('advance', a3), 'before_books'], [ev('advance', round.advances[0]), 'on_sheet'], [ev('loan', round.loans[0]), 'on_sheet'],
    [ev('advance', a6), 'hidden'], [ev('loan', l7.id), 'opening_balance'], [ev('loan', l8.id), 'cancelled'], [ev('batch', b2), 'nothing_paid'],
    [ev('line', p15), 'not_paid'], [ev('line', p11), 'in_batch'], [ev('run', may.id), 'not_finalised'], [ev('sheetAdvances', apr.id), 'nothing_paid'],
  ];
  assert.deepEqual(await pendingIn(CI, '2027-05-10'), listed);
  assert.deepEqual(await pendingIn(DP, '2027-05-10'), [], 'all of it is Colour\'s');
  assert.deepEqual(await pendingIn(CI, '2027-04-30'), listed.filter(e => e.type !== 'hidden'), 'April\'s hidden money waits once April has ended');
  assert.equal((await statusOf(CI, '2027-05-10')).waiting, listed.length);
  // What it leaves out, finHrPost skips, and writes nothing for.
  const was = { vouchers: await count('fin_vouchers'), exceptions: await count('fin_hr_exceptions'), audit: await count('fin_audit_log') };
  for (const [event, reason] of leftOut) {
    assert.deepEqual(await post(event.type, event.id), { result: 'skipped', reason_code: reason }, `${event.type} ${event.id}`);
  }
  assert.deepEqual({ vouchers: await count('fin_vouchers'), exceptions: await count('fin_hr_exceptions'), audit: await count('fin_audit_log') }, was);

  const stood = await driftIn(CI, '2027-05-10');
  assert.deepEqual(await bringIn(CI, ACCT, '2027-05-10'), { posted: 9, submitted: 2, skipped: stood, exceptions: [], more: false },
    'eight events and April\'s cash combined entry posted; the ₹1,50,000 advance and the ₹1,20,000 bank combined entry, both the accounts login\'s, wait for md');
  // What it listed stands now, each once…
  for (const event of listed.filter(e => e.type !== 'hidden')) {
    const out = await post(event.type, event.id);
    assert.equal(out.already, true, `${event.type} ${event.id}: ${JSON.stringify(out)}`);
  }
  assert.equal((await standing(`hr_hidden:${L['Office cash']}`, 202704)).length, 1, 'April\'s cash combined entry');
  // …and what is left waiting is the entries an Approver has to approve: the advance, and April's bank combined entry.
  const [waits] = await standing('hr_advance', a2);
  const [bankApril] = await standing(`hr_hidden:${L['Bank – current']}`, 202704);
  assert.deepEqual([(await voucherRow(waits)).status, (await voucherRow(bankApril)).status], ['submitted', 'submitted']);
  assert.deepEqual(await pendingIn(CI, '2027-05-10'), [ev('advance', a2), ev('hidden', 202704)]);
  assert.equal((await statusOf(CI, '2027-05-10')).waiting, 2);
  await approve(waits);
  await approve(bankApril);
  assert.deepEqual(await pendingIn(CI, '2027-05-10'), []);
});

test('R36 × R39: what HR has taken back waits only while Finance still holds an entry of it waiting for an Approver or sent back; Bring-in withdraws or discards it, and an entry sent back that HR still holds is made again', gate, async () => {
  const p = await fx.person({ name: 'Test Taken Back' });
  const give = async (date, rupees) => {
    const id = await fx.advance({ person: p, date, rupees, paidVia: 'cash', by: ACCT.id });
    const out = await post('advance', id);
    assert.equal(out.result, 'submitted', JSON.stringify(out));
    return { id, voucher: out.voucher_id };
  };
  const takeBack = (adv, date, rupees) => h.db.q(
    `INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, $2::date, 'recovered', $3, 'manual', $4)`,
    [p, date, rupees, adv]);
  const waiting = await give('2027-09-10', 150000);                 // waits for md; then HR takes it back
  const sentBack = await give('2027-09-11', 140000);                // md sends it back; then HR takes it back
  const kept = await give('2027-09-12', 130000);                    // md sends it back; HR keeps it
  for (const v of [sentBack, kept]) await ok(h.call('POST', `/finance/vouchers/${v.voucher}/reject`, { reason: 'Check it in HR' }, 'md'));
  assert.deepEqual(await pendingIn(CI, '2027-09-15'), [{ type: 'advance', id: waiting.id }, { type: 'advance', id: sentBack.id }, { type: 'advance', id: kept.id }],
    'waiting for md, or sent back: none is posted');
  assert.deepEqual(await pendingIn(DP, '2027-09-15'), [], 'in CI alone, where they wait');
  // HR takes two of them back, and the calls after its commits never run.
  await takeBack(waiting.id, '2027-09-13', 150000);
  await takeBack(sentBack.id, '2027-09-13', 140000);
  assert.deepEqual(await pendingIn(CI, '2027-09-15'), [{ type: 'advance', id: waiting.id }, { type: 'advance', id: sentBack.id }, { type: 'advance', id: kept.id }],
    'what HR took back still waits: Finance holds an entry of it');
  const out = await bringIn(CI, ACCT, '2027-09-15');
  assert.deepEqual([out.posted, out.submitted, out.exceptions], [0, 1, []], JSON.stringify(out));
  assert.deepEqual([(await voucherRow(waiting.voucher)).status, (await voucherRow(sentBack.voucher)).status], ['discarded', 'discarded'],
    'withdrawn, and discarded (R39): nothing of any status stays for money HR took back');
  assert.deepEqual((await vouchersOf('hr_advance', kept.id)).map(v => v.status), ['discarded', 'submitted'], 'made again for md (R22)');
  assert.deepEqual(await pendingIn(CI, '2027-09-15'), [{ type: 'advance', id: kept.id }]);
  await approve((await standing('hr_advance', kept.id))[0]);
  assert.deepEqual(await pendingIn(CI, '2027-09-15'), []);
});

test('R36 × R34: a run whose books post their journals apart (one books when paid) waits in the book whose journal is not posted, though the other\'s is', gate, async () => {
  const ci = await fx.person({ name: 'Test Apart Colour' });
  const dp = await fx.person({ name: 'Test Apart Darbi', firm: 'DARBI', channel: 'DARBI' });
  await saveSetup({ book_id: DP, payroll_booking: 'when_paid' });
  try {
    const run = await fx.payroll({ month: '2027-09', approvedBy: MD.id, lines: [{ person: ci, gross: 9000 }, { person: dp, gross: 9500 }] });
    await fx.finalise(run.id, { at: '2027-10-02T10:00:00+05:30', by: MD.id });
    assert.deepEqual(await pendingIn(CI, '2027-10-03'), [{ type: 'run', id: run.id }]);
    assert.deepEqual(await pendingIn(DP, '2027-10-03'), [], 'DP\'s journal waits for its first payment, which is no entry missing');
    assert.equal((await bringIn(CI, MD, '2027-10-03')).posted, 1);
    // DP's person is paid from DP's bank, and the call after commit never runs: DP's journal, now dated, and the batch wait in DP,
    // though CI's journal of the same run is posted.
    const batch = await fx.payBatch({ lineIds: [await lineOf(run.id, dp)], channel: 'DARBI', batchNo: 'CI-PAY-0903', paidOn: '2027-10-06', by: MD.id });
    assert.deepEqual(await pendingIn(DP, '2027-10-07'), [{ type: 'run', id: run.id }, { type: 'batch', id: batch }]);
    assert.deepEqual(await pendingIn(CI, '2027-10-07'), []);
    assert.equal((await bringIn(DP, MD, '2027-10-07')).posted, 2);
    const [journal] = await standing('hr_run:DP', run.id);
    assert.deepEqual([(await voucherRow(journal)).book_id, (await voucherRow(journal)).voucher_date], [DP, '2027-10-06']);
    assert.deepEqual([await pendingIn(CI, '2027-10-07'), await pendingIn(DP, '2027-10-07')], [[], []]);
  } finally {
    await saveSetup({ book_id: DP, payroll_booking: 'month_end' });
  }
  // DP's check is of DP's people alone: its one person's pay came in and went out, and CI's people's figures are not DP's.
  const zero = { finance_paise: 0, hr_paise: 0, gap_paise: 0 };
  assert.deepEqual(await control(DP, '2027-10-07'), { as_at: '2027-10-07', advances: zero, loans: zero, salary_payable: zero, matches: true });
  // R52a: DP booked September on 6 October, when it was paid, and is on month_end again: as at the day before, HR's figure dates the run
  // by that journal too, and leaves it out, as Finance's does. No gap.
  assert.deepEqual(figures((await control(DP, '2027-10-05')).salary_payable), [0, 0, 0], 'as at the day before it was paid, neither holds it');
});

test('R36: an entry whose reversal waits for the MD counts as waiting, once, with the corrected entry behind it (§7.6 "Both show"); approved, the corrected entry waits until Bring-in', gate, async () => {
  const q1 = await fx.person({ name: 'Test Reversal Q1' });
  const run = await fx.payroll({ month: '2027-06', approvedBy: MD.id, lines: [{ person: q1, gross: 9000 }] });
  await fx.finalise(run.id, { at: '2027-07-02T10:00:00+05:30', by: ACCT.id });
  assert.equal((await bringIn(CI, ACCT, '2027-07-05')).posted, 1);
  const [journal] = await standing('hr_run', run.id);
  // Un-finalised by the accounts login: its reversal waits for md, and the journal stands meanwhile (H8).
  await fx.unfinalise(run.id);
  const undo = await post('run', run.id);
  assert.deepEqual([undo.reason_code, undo.reversal?.result], ['not_finalised', 'submitted'], JSON.stringify(undo));
  assert.deepEqual(await pendingIn(CI, '2027-07-05'), [], 'its journal stands: no entry of it is missing');
  assert.equal((await statusOf(CI, '2027-07-05')).waiting, 1, '…but its reversal waits for an Approver');
  // Finalised again: the corrected journal waits behind the reversal, and the event still counts once.
  await fx.finalise(run.id, { at: '2027-07-04T10:00:00+05:30', by: ACCT.id });
  assert.equal((await post('run', run.id)).reason_code, 'reversal_waiting');
  assert.equal((await statusOf(CI, '2027-07-05')).waiting, 1);
  // md approves the reversal: the journal is out of the books, and the corrected one is what waits now, until Bring-in.
  await approve((await h.db.one('SELECT id FROM fin_vouchers WHERE reversal_of_id = $1', [journal])).id);
  assert.deepEqual(await pendingIn(CI, '2027-07-05'), [{ type: 'run', id: run.id }]);
  assert.equal((await statusOf(CI, '2027-07-05')).waiting, 1);
  assert.equal((await bringIn(CI, ACCT, '2027-07-05')).posted, 1);
  assert.equal((await statusOf(CI, '2027-07-05')).waiting, 0);
});

test('R36a: an entry whose reversal an Approver sent back waits: finHrPending lists it, and Bring-in discards that reversal and makes it afresh', gate, async () => {
  const p = await fx.person({ name: 'Test Sent Back Reversal' });
  const adv = await fx.advance({ person: p, date: '2028-03-10', rupees: 2200, paidVia: 'cash', by: MD.id });
  assert.equal((await post('advance', adv, MD)).result, 'posted');
  const [stood] = await standing('hr_advance', adv);
  const takeBack = () => h.db.one(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id)
                                   VALUES ($1, '2028-03-12', 'recovered', 2200, 'manual', $2) RETURNING id`, [p, adv]).then(r => r.id);
  // HR takes it back; the call after its commit, by the accounts login, takes the entry out by a reversal that waits for md, and md
  // sends that reversal back.
  const back = await takeBack();
  const undone = await post('advance', adv, ACCT);
  assert.equal(undone.reversal?.result, 'submitted', JSON.stringify(undone));
  const [first] = undone.reversal.voucher_ids;
  await ok(h.call('POST', `/finance/vouchers/${first}/reject`, { reason: 'Check it in HR' }, 'md'));
  assert.equal((await voucherRow(first)).status, 'draft');
  // HR puts the advance back after all: Bring-in would leave the entry as it stands, so it is not listed; the reversal sent back still
  // waits, for a person to discard. (In June, far outside drift's window: only what waits is brought in.)
  await h.db.q('DELETE FROM hr.advance_txns WHERE id = $1', [back]);
  assert.deepEqual([(await statusOf(CI, '2028-06-10')).waiting, await pendingIn(CI, '2028-06-10')], [1, []]);
  // Taken back again, and the call missed: the entry waits, as what HR took back with Finance still holding it.
  await takeBack();
  assert.equal((await statusOf(CI, '2028-06-10')).waiting, 1, 'a sent-back reversal waits');
  assert.deepEqual(await pendingIn(CI, '2028-06-10'), [{ type: 'advance', id: adv }]);
  const out = await bringIn(CI, ACCT, '2028-06-10');
  assert.deepEqual([out.posted, out.submitted, out.exceptions], [0, 1, []], JSON.stringify(out));
  assert.equal((await voucherRow(first)).status, 'discarded', 'the reversal sent back is discarded…');
  const [again] = await h.db.q('SELECT id, status FROM fin_vouchers WHERE reversal_of_id = $1 AND id <> $2', [stood, first]);
  assert.equal(again?.status, 'submitted', '…and made afresh, for md');
  assert.deepEqual([(await statusOf(CI, '2028-06-10')).waiting, await pendingIn(CI, '2028-06-10')], [1, []], 'it waits for md now');
  await approve(again.id);
  assert.ok((await voucherRow(stood)).reversed_by_id);
  assert.equal((await statusOf(CI, '2028-06-10')).waiting, 0);
});

test('R36: an event that writes to both books waits in each; Bring-in on one book, by a login of that book alone, writes both (R24)', gate, async () => {
  const r1 = await fx.person({ name: 'Test Pair R1' });
  // A Colour person's advance paid from Darbi's bank: a journal in CI, a payment in DP.
  const adv = await fx.advance({ person: r1, date: '2027-06-10', rupees: 4000, paidVia: 'DARBI', by: MD.id });
  assert.deepEqual(await pendingIn(CI, '2027-06-15'), [{ type: 'advance', id: adv }]);
  assert.deepEqual(await pendingIn(DP, '2027-06-15'), [{ type: 'advance', id: adv }]);
  refused(await h.call('POST', '/finance/hr/bring-in', { book_id: CI }, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  const brought = await ok(h.call('POST', '/finance/hr/bring-in', { book_id: CI }, 'appr2'));
  assert.deepEqual([brought.posted, brought.submitted, brought.exceptions], [1, 0, []]);
  const [ci] = await standing('hr_advance', adv);
  const [dp] = await standing('hr_advance:DP', adv);
  assert.deepEqual([(await voucherRow(ci)).book_id, (await voucherRow(ci)).status], [CI, 'posted']);
  assert.deepEqual(await linesOf(dp), [['Colour Impressions', 4000 * R, 0], ['DP Bank', 0, 4000 * R]]);
  assert.deepEqual([await pendingIn(CI, '2027-06-15'), await pendingIn(DP, '2027-06-15')], [[], []]);
});

test('R45: a line paid again on its own from another account than its batch\'s waits as a line event, never with its batch; Bring-in books the batch without it and the line from its own account', gate, async () => {
  const s1 = await fx.person({ name: 'Test Left S1', channel: 'COLOUR' });
  const s2 = await fx.person({ name: 'Test Left S2', channel: 'COLOUR' });
  const run = await fx.payroll({ month: '2027-07', approvedBy: MD.id, lines: [{ person: s1, gross: 20000 }, { person: s2, gross: 22000 }] });
  await fx.finalise(run.id, { at: '2027-08-02T10:00:00+05:30', by: MD.id });
  const [l1, l2] = [await lineOf(run.id, s1), await lineOf(run.id, s2)];
  const batch = await fx.payBatch({ lineIds: [l1, l2], channel: 'COLOUR', batchNo: 'CI-PAY-0801', paidOn: '2027-08-05', by: MD.id });
  assert.equal((await bringIn(CI, MD, '2027-08-06')).posted, 2, 'the journal and the batch');
  const [stale] = await standing('hr_batch', batch);
  // The bank transfer to S1 failed and S1 was paid again in cash; the drawer's call after commit never ran.
  await fx.markLine(l1, 'failed');
  await payAlone(l1, { paidOn: '2027-08-07', paidFrom: 'cash' });
  assert.deepEqual(await pendingIn(CI, '2027-08-08'), [{ type: 'line', id: l1 }], 'the line, never the batch (whose entry is repaired, not counted)');
  assert.deepEqual(await pendingIn(DP, '2027-08-08'), [], 'a Colour person paid from CI\'s cash: CI\'s alone');
  // The line waits; its batch, whose old entry still holds it, is posted again first, without it (R45), and the line after it.
  const stood = await driftIn(CI, '2027-08-08');
  assert.deepEqual(await bringIn(CI, MD, '2027-08-08'), { posted: 2, submitted: 0, skipped: stood - 1, exceptions: [], more: false });
  assert.ok((await voucherRow(stale)).reversed_by_id, 'the batch\'s old entry is reversed');
  const [batchNow] = await standing('hr_batch', batch);
  assert.deepEqual(await linesOf(batchNow), [['Salary Payable', 22000 * R, 0], ['Bank – current', 0, 22000 * R]]);
  const [line] = await standing('hr_line_pay', l1);
  assert.deepEqual(await linesOf(line), [['Salary Payable', 20000 * R, 0], ['Office cash', 0, 20000 * R]]);
  assert.deepEqual(await pendingIn(CI, '2027-08-08'), []);
});

// ── Bring-in repairs what the call after commit missed (ruling R38) ─────────────────────────

test('R38, R38a: Bring-in repairs an undo the after-commit call missed and counts what stands as skipped; the status leaves drift out; drift outside the month and the one before, and a locked month, are left as they are', gate, async () => {
  const t = [await fx.person({ name: 'Test Drift T1' }), await fx.person({ name: 'Test Drift T2' }), await fx.person({ name: 'Test Drift T3' }),
    await fx.person({ name: 'Test Drift T4' })];
  const run = await fx.payroll({ month: '2027-08', approvedBy: MD.id, lines: t.map((person, i) => ({ person, gross: [7000, 7500, 8000, 6500][i] })) });
  await fx.finalise(run.id, { at: '2027-09-01T10:00:00+05:30', by: MD.id });
  const [l1, l2, l3, l4] = await Promise.all(t.map(p => lineOf(run.id, p)));
  const aug = await fx.payBatch({ lineIds: [l4], channel: 'CASH', batchNo: 'CI-PAY-0904', paidOn: '2027-08-31', by: MD.id });
  const sept = await fx.payBatch({ lineIds: [l1, l2], channel: 'CASH', batchNo: 'CI-PAY-0901', paidOn: '2027-09-03', by: MD.id });
  const oct = await fx.payBatch({ lineIds: [l3], channel: 'CASH', batchNo: 'CI-PAY-0902', paidOn: '2027-10-04', by: MD.id });
  assert.equal((await bringIn(CI, MD, '2027-10-05')).posted, 4, 'the journal and the three batches: what waits is never bounded by its date');
  const [septWas] = await standing('hr_batch', sept);

  // T2's cash was handed back (marked failed); the call after commit never ran: no exception, and nothing is missing either.
  await fx.markLine(l2, 'failed');
  assert.deepEqual(await pendingIn(CI, '2027-10-05'), []);
  assert.equal((await statusOf(CI, '2027-10-05')).waiting, 0, 'drift is no count');
  // Brought in by the accounts login: the batch's entry is taken out by a reversal that waits for md (counted submitted), and then
  // it waits, its corrected entry behind it.
  const stood = await driftIn(CI, '2027-10-05');
  assert.deepEqual(await bringIn(CI, ACCT, '2027-10-05'), { posted: 0, submitted: 1, skipped: stood - 1, exceptions: [], more: false });
  assert.equal((await statusOf(CI, '2027-10-05')).waiting, 1);
  await approve((await h.db.one('SELECT id FROM fin_vouchers WHERE reversal_of_id = $1', [septWas])).id);
  assert.deepEqual(await pendingIn(CI, '2027-10-05'), [{ type: 'batch', id: sept }]);
  assert.deepEqual(await bringIn(CI, ACCT, '2027-10-05'), { posted: 1, submitted: 0, skipped: stood - 1, exceptions: [], more: false });
  assert.ok((await voucherRow(septWas)).reversed_by_id);
  const [septNow] = await standing('hr_batch', sept);
  assert.deepEqual(await linesOf(septNow), [['Salary Payable', 7000 * R, 0], ['Office cash', 0, 7000 * R]]);
  assert.deepEqual(await bringIn(CI, MD, '2027-10-05'), { posted: 0, submitted: 0, skipped: await driftIn(CI, '2027-10-05'), exceptions: [], more: false },
    'brought in again, everything stands');
  // R38a: T4's cash handed back, the call missed; its batch is dated in August, outside October and September, so a Bring-in in
  // October leaves it as it stands; one in September (its month and the one before) repairs it.
  await fx.markLine(l4, 'failed');
  const [augWas] = await standing('hr_batch', aug);
  await bringIn(CI, MD, '2027-10-05');
  assert.deepEqual([await standing('hr_batch', aug), (await voucherRow(augWas)).reversed_by_id], [[augWas], null], 'left alone');
  await bringIn(CI, MD, '2027-09-20');
  assert.ok((await voucherRow(augWas)).reversed_by_id, 'repaired');
  assert.deepEqual(await standing('hr_batch', aug), []);
  // T1's line as well, the call missed again, brought in by md: an HR approver's reversal posts at once, and the batch is booked
  // again with nobody (it has nobody still paid), so its entry is simply taken out.
  await fx.markLine(l1, 'failed');
  const out = await bringIn(CI, MD, '2027-10-05');
  assert.deepEqual([out.posted, out.submitted, out.exceptions], [0, 0, []], JSON.stringify(out));
  assert.ok((await voucherRow(septNow)).reversed_by_id, 'reversed at once, by md\'s HR approval');
  assert.deepEqual(await standing('hr_batch', sept), []);
  assert.deepEqual(await bringIn(CI, MD, '2027-10-05'), { posted: 0, submitted: 0, skipped: await driftIn(CI, '2027-10-05'), exceptions: [], more: false },
    'brought in again: what stands is skipped, and the batch\'s entries taken out are no drift (only live vouchers are)');

  // October locked, then T3's cash handed back, the call missed: Bring-in leaves the locked month's entry as it is.
  const october = await periodOf(CI, '2027-10-01');
  await moveMonth(october, 'closing');
  await moveMonth(october, 'locked');
  try {
    await fx.markLine(l3, 'failed');
    const [octWas] = await standing('hr_batch', oct);
    const out = await bringIn(CI, MD, '2027-10-05');
    assert.deepEqual([out.posted, out.submitted, out.exceptions], [0, 0, []]);
    assert.deepEqual(await standing('hr_batch', oct), [octWas]);
    assert.equal((await voucherRow(octWas)).reversed_by_id, null);
    assert.equal(await exceptionOf('hr_batch', oct), null, 'not tried, so no exception');
  } finally {
    await moveMonth(october, 'closing', 'Opened again for the HR entries');
    await moveMonth(october, 'open', 'Open again');
  }
  // Open again: the next Bring-in takes it out.
  const [octWas] = await standing('hr_batch', oct);
  await bringIn(CI, MD, '2027-10-05');
  assert.ok((await voucherRow(octWas)).reversed_by_id);
  assert.deepEqual(await standing('hr_batch', oct), []);
});

test('R38a: Bring-in works within its budget: given none, it does one thing and answers more; asked again, it goes on', gate, async () => {
  const p = await fx.person({ name: 'Test Budget Person' });
  const first = await fx.advance({ person: p, date: '2027-10-20', rupees: 700, paidVia: 'cash', by: MD.id });
  const second = await fx.advance({ person: p, date: '2027-10-21', rupees: 800, paidVia: 'cash', by: MD.id });
  assert.deepEqual(await pendingIn(CI, '2027-10-22'), [{ type: 'advance', id: first }, { type: 'advance', id: second }]);
  const once = await catchup.finBringInFromHr(CI, MD, { asOf: '2027-10-22', budgetMs: 0 });
  assert.deepEqual(once, { posted: 1, submitted: 0, skipped: 0, exceptions: [], more: true });
  assert.deepEqual(await pendingIn(CI, '2027-10-22'), [{ type: 'advance', id: second }]);
  const rest = await bringIn(CI, MD, '2027-10-22');
  assert.deepEqual([rest.posted, rest.exceptions, rest.more], [1, [], false]);
  assert.deepEqual(await pendingIn(CI, '2027-10-22'), []);
});

// ── Exceptions (spec §7.7) ───────────────────────────────────────────────────────────────────

let spareBatch;
test('retry after mapping the channel posts the exception\'s event and sets resolved_at and voucher_id', gate, async () => {
  const u = [await fx.person({ name: 'Test Spare U1', channel: 'SPARE' }), await fx.person({ name: 'Test Spare U2', channel: 'SPARE' })];
  const run = await fx.payroll({ month: '2027-10', approvedBy: MD.id, lines: u.map(person => ({ person, gross: 10000 })) });
  await fx.finalise(run.id, { at: '2027-11-02T10:00:00+05:30', by: MD.id });
  spareBatch = await fx.payBatch({ lineIds: await Promise.all(u.map(p => lineOf(run.id, p))), channel: 'SPARE', batchNo: 'CI-PAY-1001', paidOn: '2027-11-05', by: MD.id });
  // Before Bring-in it waits, in the book its exception will name: Finance cannot post it, which only trying it finds out.
  assert.deepEqual(await pendingIn(CI, '2027-11-06'), [{ type: 'run', id: run.id }, { type: 'batch', id: spareBatch }]);
  assert.deepEqual(await pendingIn(DP, '2027-11-06'), []);
  const brought = await bringIn(CI, ACCT, '2027-11-06');
  assert.deepEqual([brought.posted, brought.exceptions], [1, ['FIN_UNMAPPED_CHANNEL']], JSON.stringify(brought));
  const status = await ok(h.call('GET', `/finance/hr/status?book=${CI}`, null, 'acct'));
  assert.deepEqual([status.waiting, status.exceptions], [0, 1], 'an exception is counted as one, and not as waiting');

  const listed = (await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'viewer'))).exceptions;
  assert.equal(listed.length, 1);
  const [ex] = listed;
  assert.deepEqual(
    [ex.type, ex.hr_id, ex.document_no, ex.reason_code, ex.reason, ex.fix, ex.resolved_at, ex.voucher_id],
    ['batch', spareBatch, 'CI-PAY-1001', 'FIN_UNMAPPED_CHANNEL', FIN_SENTENCES.FIN_UNMAPPED_CHANNEL, 'map_channel', null, null]);
  assert.ok(ex.first_seen_at && ex.last_tried_at);
  refused(await h.call('POST', `/finance/hr/exceptions/${ex.id}/retry`, null, 'viewer'), 403, 'FIN_FORBIDDEN');

  // Retried before the fix: still open, first seen when it was, tried again now.
  const again = (await ok(h.call('POST', `/finance/hr/exceptions/${ex.id}/retry`, null, 'acct'))).exception;
  assert.deepEqual([again.id, again.reason_code, again.resolved_at, again.voucher_id, again.first_seen_at], [ex.id, 'FIN_UNMAPPED_CHANNEL', null, null, ex.first_seen_at]);
  assert.ok(new Date(again.last_tried_at) > new Date(ex.last_tried_at), 'last_tried_at moves on');

  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – spare'] }] });
  const fixed = (await ok(h.call('POST', `/finance/hr/exceptions/${ex.id}/retry`, null, 'acct'))).exception;
  const [batchVoucher] = await standing('hr_batch', spareBatch);
  assert.ok(batchVoucher, 'the batch is booked');
  assert.deepEqual([fixed.id, fixed.voucher_id, Boolean(fixed.resolved_at)], [ex.id, batchVoucher, true]);
  assert.deepEqual(await linesOf(batchVoucher), [['Salary Payable', 20000 * R, 0], ['Bank – spare', 0, 20000 * R]]);
  assert.deepEqual((await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions, [], 'only open ones are listed');
  assert.equal((await ok(h.call('GET', `/finance/hr/status?book=${CI}`, null, 'acct'))).exceptions, 0);
});

test('the exceptions list is the book\'s open ones, newest first, each with its event, reason and fix; one with no book lists under CI', gate, async () => {
  const someAdvance = (await h.db.one(`SELECT id FROM hr.advance_txns WHERE kind = 'given' AND source = 'manual' ORDER BY id LIMIT 1`)).id;
  const someLoan = await h.db.one(`SELECT id, loan_no FROM hr.loans WHERE loan_no = 'CI-LN-0701'`);
  const made = [];
  for (const [type, id, book, code, reason, ago] of [
    ['hr_advance', someAdvance, null, 'FIN_SERVER_ERROR', FIN_SENTENCES.FIN_SERVER_ERROR, '2 days'],
    ['hr_loan', someLoan.id, CI, 'FIN_PERIOD_LOCKED', 'Jan 2027 is locked. Nothing more can be posted to it.', '1 day'],
  ]) {
    made.push((await h.db.one(
      `INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, first_seen_at, last_tried_at)
       VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval) RETURNING id`, [type, id, book, code, reason, ago])).id);
  }
  const listed = (await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions;
  assert.deepEqual(listed.map(x => [x.id, x.type, x.hr_id, x.document_no, x.reason_code, x.fix]), [
    [made[1], 'loan', someLoan.id, 'CI-LN-0701', 'FIN_PERIOD_LOCKED', 'reopen_month'],
    [made[0], 'advance', someAdvance, null, 'FIN_SERVER_ERROR', 'ask_md'],
  ]);
  assert.deepEqual((await ok(h.call('GET', `/finance/hr/exceptions?book=${DP}`, null, 'acct'))).exceptions, [], 'none of them is DP\'s');
  for (const row of listed) {
    assert.deepEqual(Object.keys(row).sort(), ['document_no', 'first_seen_at', 'fix', 'hr_id', 'id', 'last_tried_at', 'reason', 'reason_code',
      'resolved_at', 'type', 'voucher_id'], 'the event, the reason, the times and the fix: no person');
  }
  // Each event stands in the books, so its retry closes it with the voucher that stands.
  for (const [id, [type, source]] of [[made[0], ['hr_advance', someAdvance]], [made[1], ['hr_loan', someLoan.id]]]) {
    const out = (await ok(h.call('POST', `/finance/hr/exceptions/${id}/retry`, null, 'acct'))).exception;
    assert.deepEqual([Boolean(out.resolved_at), out.voucher_id], [true, (await standing(type, source))[0]]);
  }
  assert.deepEqual((await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions, []);

  // A Darbi person's advance through a channel nobody mapped waits in DP, and its exception lists under DP.
  const darbi = await fx.person({ name: 'Test Darbi Unmapped', firm: 'DARBI', channel: 'DARBI' });
  const lost = await fx.advance({ person: darbi, date: '2027-11-15', rupees: 600, paidVia: 'NO SUCH CHANNEL', by: ACCT.id });
  assert.deepEqual([await pendingIn(CI, '2027-11-20'), await pendingIn(DP, '2027-11-20')], [[], [{ type: 'advance', id: lost }]]);
  assert.deepEqual((await bringIn(DP, ACCT, '2027-11-20')).exceptions, ['FIN_UNMAPPED_CHANNEL']);
  assert.deepEqual((await ok(h.call('GET', `/finance/hr/exceptions?book=${DP}`, null, 'acct'))).exceptions.map(x => [x.type, x.hr_id, x.fix]),
    [['advance', lost, 'map_channel']]);
  assert.deepEqual((await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions, []);

  // A round's exception kept under one of its later lines (ruling R28, when the round could not be read): the round does not wait,
  // and the exception's retry posts the round and closes it.
  const people = [await fx.person({ name: 'Test Round Kept 1' }), await fx.person({ name: 'Test Round Kept 2' })];
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0902', month: '2027-11', paidOn: '2027-11-16', paidVia: 'cash', by: ACCT.id,
    lines: people.map(person => ({ person, rupees: 1500, decidedBy: MD.id })) });
  await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });
  const [anchor, later] = [...sheet.lineIds].sort((x, y) => x - y);
  const kept = await h.db.one(
    `INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, last_tried_at)
     VALUES ('hr_sheet', $1, NULL, 'FIN_SERVER_ERROR', $2, now()) RETURNING id`, [later, FIN_SENTENCES.FIN_SERVER_ERROR]);
  assert.deepEqual(await pendingIn(CI, '2027-11-20'), [], 'an open exception of the round, under any of its lines: not waiting');
  const listedRound = (await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions;
  assert.deepEqual(listedRound.map(x => [x.type, x.hr_id, x.document_no]), [['sheet', later, 'CI-ADV-0902']]);
  const roundOut = (await ok(h.call('POST', `/finance/hr/exceptions/${kept.id}/retry`, null, 'acct'))).exception;
  const [roundVoucher] = await standing('hr_sheet', anchor);
  assert.ok(roundVoucher, 'the round is booked, under its anchor');
  assert.deepEqual([Boolean(roundOut.resolved_at), roundOut.voucher_id], [true, roundVoucher]);
});

test('a hidden people\'s exception is retried through their combined entries (finHrPostHidden), any other through finHrPost of its own event', gate, async () => {
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('SPARE2', 'Second spare bank', 'bank')`);
  const wp = await fx.person({ name: 'Test Hidden W', channel: 'SPARE2' });
  await fx.hide(wp, { user: ACCT.id });
  await fx.advance({ person: wp, date: '2027-11-10', rupees: 1200, paidVia: 'SPARE2', by: MD.id });
  // November's hidden money has no account to post to: it waits under CI, where its exception will list.
  assert.deepEqual(await pendingIn(CI, '2027-12-01'), [{ type: 'hidden', id: 202711 }]);
  assert.deepEqual(await pendingIn(DP, '2027-12-01'), []);
  assert.deepEqual((await feed.finHrPostHidden(MD, { asOf: '2027-12-01' })).exceptions, ['FIN_UNMAPPED_CHANNEL']);
  assert.deepEqual(await pendingIn(CI, '2027-12-01'), [], 'an exception now, and no longer waiting');
  const listed = (await ok(h.call('GET', `/finance/hr/exceptions?book=${CI}`, null, 'acct'))).exceptions;
  assert.deepEqual(listed.map(x => [x.type, x.hr_id, x.document_no, x.reason_code, x.fix]), [['hidden', 202711, null, 'FIN_UNMAPPED_CHANNEL', 'map_channel']]);
  const [ex] = listed;
  const tried = await catchup.finHrRetryException(ex.id, ACCT, { asOf: '2027-12-01' });
  assert.deepEqual([tried.exception.resolved_at, tried.exception.reason_code], [null, 'FIN_UNMAPPED_CHANNEL']);
  assert.ok(new Date(tried.exception.last_tried_at) > new Date(ex.last_tried_at), 'tried again');
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE2', ledger_id: L['Bank – spare'] }] });
  const fixed = await catchup.finHrRetryException(ex.id, MD, { asOf: '2027-12-01' });
  assert.ok(fixed.exception.resolved_at, 'resolved: nothing of November is left without an account');
  const [entry] = await standing(`hr_hidden:${L['Bank – spare']}`, 202711);
  assert.deepEqual(await linesOf(entry), [['Staff Advances', 1200 * R, 0], ['Bank – spare', 0, 1200 * R]]);
  assert.deepEqual(await pendingIn(CI, '2027-12-01'), []);

  // Bring-in tries hidden people's exceptions again too (finHrPostHidden with retry): December's, once its channel is mapped.
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('SPARE3', 'Third spare bank', 'bank')`);
  await fx.advance({ person: wp, date: '2027-12-03', rupees: 900, paidVia: 'SPARE3', by: MD.id });
  assert.deepEqual((await feed.finHrPostHidden(MD, { asOf: '2028-01-01' })).exceptions, ['FIN_UNMAPPED_CHANNEL']);
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE3', ledger_id: L['Bank – spare'] }] });
  const brought = await bringIn(CI, MD, '2028-01-01');
  assert.deepEqual([brought.posted, brought.exceptions], [1, []], JSON.stringify(brought));
  assert.ok((await exceptionOf('hr_hidden:unmapped', 202712)).resolved_at);
  assert.equal((await standing(`hr_hidden:${L['Bank – spare']}`, 202712)).length, 1);
});

test('R53: Bring-in tries every open exception of the book again: two of an unmapped channel fail again, keeping their rows; once it is mapped, one Bring-in posts both', gate, async () => {
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('SPARE4', 'Fourth spare bank', 'bank')`);
  const p = await fx.person({ name: 'Test Retried Twice', channel: 'SPARE4' });
  const one = await fx.advance({ person: p, date: '2027-12-10', rupees: 1100, paidVia: 'SPARE4', by: MD.id });
  const two = await fx.advance({ person: p, date: '2027-12-11', rupees: 1300, paidVia: 'SPARE4', by: MD.id });
  const failed = await bringIn(CI, MD, '2027-12-12');
  assert.deepEqual([failed.posted, failed.exceptions], [0, ['FIN_UNMAPPED_CHANNEL', 'FIN_UNMAPPED_CHANNEL']], JSON.stringify(failed));
  const was = [await exceptionOf('hr_advance', one), await exceptionOf('hr_advance', two)];
  assert.deepEqual(await pendingIn(CI, '2027-12-12'), [], 'exceptions now, and not waiting');
  // Brought in again before the fix: each is tried again, keeps its row and when it was first seen, and is tried now.
  const again = await bringIn(CI, MD, '2027-12-12');
  assert.deepEqual([again.posted, again.exceptions], [0, ['FIN_UNMAPPED_CHANNEL', 'FIN_UNMAPPED_CHANNEL']], JSON.stringify(again));
  for (const [i, id] of [one, two].entries()) {
    const now = await exceptionOf('hr_advance', id);
    assert.deepEqual([now.id, now.resolved_at, now.first_seen_at.getTime()], [was[i].id, null, was[i].first_seen_at.getTime()]);
    assert.ok(now.last_tried_at > was[i].last_tried_at, 'tried again');
  }
  // R38a's order: nothing waits, so the exceptions come first. With no budget, Bring-in tries the first of them and stops: the second,
  // hidden people's months and the drift are left for the next.
  const twoTried = (await exceptionOf('hr_advance', two)).last_tried_at;
  assert.deepEqual(await catchup.finBringInFromHr(CI, MD, { asOf: '2027-12-12', budgetMs: 0 }),
    { posted: 0, submitted: 0, skipped: 0, exceptions: ['FIN_UNMAPPED_CHANNEL'], more: true });
  assert.equal((await exceptionOf('hr_advance', two)).last_tried_at.getTime(), twoTried.getTime(), 'the second is not tried yet');
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE4', ledger_id: L['Bank – spare'] }] });
  const fixed = await bringIn(CI, MD, '2027-12-12');
  assert.deepEqual([fixed.posted, fixed.exceptions], [2, []], JSON.stringify(fixed));
  for (const id of [one, two]) {
    const ex = await exceptionOf('hr_advance', id);
    assert.deepEqual([Boolean(ex.resolved_at), ex.voucher_id], [true, (await standing('hr_advance', id))[0]]);
  }
  // Nothing waits or fails now: hidden people's months come before the drift. None is due, so the first piece does nothing, and the
  // two advances just posted (December's drift, which stands) are left for the next.
  assert.deepEqual(await catchup.finBringInFromHr(CI, MD, { asOf: '2027-12-12', budgetMs: 0 }),
    { posted: 0, submitted: 0, skipped: 0, exceptions: [], more: true });
});

test('R38b: drift that outruns the budget is covered by two presses: the second goes on after where the first stopped, then wraps to the newest', gate, async () => {
  const asOf = '2027-12-12';
  assert.equal(await cursorOf(CI), null, 'every Bring-in before this one went through the window, or stopped before the drift');
  const p = await fx.person({ name: 'Test Drift Cursor' });
  const advs = [];
  for (const day of ['2027-12-01', '2027-12-02', '2027-12-03']) {
    const id = await fx.advance({ person: p, date: day, rupees: 600, paidVia: 'cash', by: MD.id });
    assert.equal((await post('advance', id, MD)).result, 'posted');
    advs.push(id);
  }
  // HR takes the oldest back, and the call after its commit never runs: drift, behind the two newest vouchers of the window.
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id)
                VALUES ($1, '2027-12-04', 'recovered', 600, 'manual', $2)`, [p, advs[0]]);
  const [oldest] = await standing('hr_advance', advs[0]);
  const window = await driftIn(CI, asOf);
  assert.ok(window > 3, `non-vacuous: ${window} in the window`);
  // A clock that moves on a millisecond each time it is read, and a budget of 3: the hidden months, then the two newest vouchers.
  let t = 0;
  const first = await catchup.finBringInFromHr(CI, MD, { asOf, budgetMs: 3, clock: () => t++ });
  assert.deepEqual(first, { posted: 0, submitted: 0, skipped: 2, exceptions: [], more: true });
  assert.equal((await voucherRow(oldest)).reversed_by_id, null, 'not reached');
  assert.equal(await cursorOf(CI), (await standing('hr_advance', advs[1]))[0], 'it stopped after the second newest');
  // A press that stops before the drift (no budget: the hidden months alone) keeps where the drift is to go on.
  assert.deepEqual(await catchup.finBringInFromHr(CI, MD, { asOf, budgetMs: 0 }), { posted: 0, submitted: 0, skipped: 0, exceptions: [], more: true });
  assert.equal(await cursorOf(CI), (await standing('hr_advance', advs[1]))[0], 'kept');
  // Pressed again with time to spare: on after the cursor, the advance taken back repaired, to the end of the window, each once.
  const second = await bringIn(CI, MD, asOf);
  assert.ok((await voucherRow(oldest)).reversed_by_id, 'repaired by the second press');
  assert.deepEqual([second.posted + second.submitted + second.skipped, second.exceptions, second.more], [window - 2, [], false],
    JSON.stringify(second));
  assert.equal(await cursorOf(CI), null, 'through to the end: the next starts at the newest');
  const third = await bringIn(CI, MD, asOf);
  assert.deepEqual(third, { posted: 0, submitted: 0, skipped: await driftIn(CI, asOf), exceptions: [], more: false });
});

test('R38b: the open exceptions are tried least recently tried first: those that fail again go to the back, so a hidden people\'s one behind them is reached', gate, async () => {
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('SPARE5', 'Fifth spare bank', 'bank'), ('SPARE6', 'Sixth spare bank', 'bank')`);
  const shown = await fx.person({ name: 'Test Rotation Shown', channel: 'SPARE5' });
  const hid = await fx.person({ name: 'Test Rotation Hidden', channel: 'SPARE6' });
  await fx.hide(hid, { user: ACCT.id });
  const e1 = await fx.advance({ person: shown, date: '2028-03-20', rupees: 500, paidVia: 'SPARE5', by: MD.id });
  const e2 = await fx.advance({ person: shown, date: '2028-03-21', rupees: 700, paidVia: 'SPARE5', by: MD.id });
  await fx.advance({ person: hid, date: '2028-03-15', rupees: 900, paidVia: 'SPARE6', by: MD.id });
  const asOf = '2028-04-02';
  // One Bring-in: neither advance has an account, nor has March's hidden money, tried after them.
  const failed = await bringIn(CI, MD, asOf);
  assert.deepEqual([failed.posted, failed.exceptions], [0, ['FIN_UNMAPPED_CHANNEL', 'FIN_UNMAPPED_CHANNEL', 'FIN_UNMAPPED_CHANNEL']],
    JSON.stringify(failed));
  assert.deepEqual(await pendingIn(CI, asOf), [], 'exceptions now, all three');
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE6', ledger_id: L['Bank – spare'] }] });
  // With no budget, one piece a press: the two that fail again are tried first, each going to the back; then March's is reached.
  const tried = async id => (await exceptionOf('hr_advance', id)).last_tried_at.getTime();
  const press = () => catchup.finBringInFromHr(CI, MD, { asOf, budgetMs: 0 });
  const was = [await tried(e1), await tried(e2)];
  assert.deepEqual(await press(), { posted: 0, submitted: 0, skipped: 0, exceptions: ['FIN_UNMAPPED_CHANNEL'], more: true });
  assert.deepEqual([await tried(e1) > was[0], await tried(e2) === was[1]], [true, true], 'the first, and only the first');
  assert.deepEqual(await press(), { posted: 0, submitted: 0, skipped: 0, exceptions: ['FIN_UNMAPPED_CHANNEL'], more: true });
  assert.ok(await tried(e2) > was[1], 'then the second');
  const third = await press();
  assert.deepEqual([third.posted, third.exceptions, third.more], [1, [], true], JSON.stringify(third));
  assert.ok((await exceptionOf('hr_hidden:unmapped', 202803)).resolved_at, 'March\'s hidden money reached, and posted');
  assert.equal((await standing(`hr_hidden:${L['Bank – spare']}`, 202803)).length, 1);
  // Its account mapped too, the other two post at the next press.
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE5', ledger_id: L['Bank – spare'] }] });
  const rest = await bringIn(CI, MD, asOf);
  assert.deepEqual([rest.posted, rest.exceptions, rest.more], [2, [], false], JSON.stringify(rest));
});

test('finRecordException that cannot write the exception says so: recorded false, and the log names the code alone', gate, async () => {
  const p = await fx.person({ name: 'Test Unrecorded Person' });
  const adv = await fx.advance({ person: p, date: '2027-12-02', rupees: 700, paidVia: 'NO SUCH CHANNEL', by: ACCT.id });
  await h.db.q('ALTER TABLE fin_hr_exceptions ADD CONSTRAINT test_refuses_every_row CHECK (false) NOT VALID');
  const logged = [];
  const saved = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  let out;
  try {
    out = await post('advance', adv);
  } finally {
    console.warn = saved;
    await h.db.q('ALTER TABLE fin_hr_exceptions DROP CONSTRAINT test_refuses_every_row');
  }
  assert.deepEqual(out, { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL', recorded: false });
  assert.deepEqual(logged, ['[finance-hr] FIN_UNMAPPED_CHANNEL not recorded']);
  assert.equal(await exceptionOf('hr_advance', adv), null);
  // Written, the answer is as it always was.
  assert.deepEqual(await post('advance', adv), { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL' });
  assert.equal((await exceptionOf('hr_advance', adv)).reason_code, 'FIN_UNMAPPED_CHANNEL');
});

// ── A correction's carried difference (ruling R54) ──────────────────────────────────────────
// A finalised month's PAID line corrected in HR (PUT /hr/loans/:id/month-instalment with confirm_finalised): HR settles the difference
// in the first open month as an approved arrears adjustment, which the engine puts in that month's line. The months are made through
// HR's own doors, the engine working them out; their payouts are written as Mark paid writes them (HR's doors refuse a payment date
// after the plant's real today, before these books begin) and booked.
const loanOwed = async loanId => Math.round(Number((await h.db.one(
  `SELECT sum(CASE WHEN kind IN ('disbursed', 'opening', 'adjustment') THEN principal_amount ELSE -principal_amount END) AS n
     FROM hr.loan_txns WHERE loan_id = $1`, [loanId])).n) * R);
const runLine = (runId, person) => h.db.one(
  `SELECT id, round(gross * 100)::bigint AS gross, round(adj_deductions * 100)::bigint AS adj, round(payable * 100)::bigint AS payable
     FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [runId, person]);
// An adjustment typed and approved in HR for a month, not a correction's (no audit row of one names it): the engine pays or deducts it as
// it does every adjustment, and it stays the month's expense or deduction (ruling R54 goes by the correction's own record, never by words).
const typedAdjustment = (person, { kind, rupees, month }) => h.db.q(
  `INSERT INTO hr.adjustments (person_id, kind, category, amount, description, reference, recurrence, start_month, status, approved_by, approved_at, created_by)
   VALUES ($1, $2, 'arrears', $3, 'Test arrears typed in HR', 'Test', 'one_time', $4, 'approved', $5, now(), $5)`, [person, kind, rupees, month, MD.id]);
const payLine = async (lineId, batchNo, paidOn) => {
  const out = await post('batch', await fx.payBatch({ lineIds: [lineId], channel: 'CASH', batchNo, paidOn, by: MD.id }), MD);
  assert.equal(out.result, 'posted', JSON.stringify(out));
};

let arrearsEarner;
test('R54: a paid month\'s instalment corrected down carries arrears into the next month, booked against Salary Payable: Salary Payable comes back to where it was, the expense is the two months\' gross less the arrears, and Staff Loans follows HR', gate, async () => {
  const p = await fx.person({ name: 'Test Arrears Earning' });
  arrearsEarner = p;
  await h.db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2027-11-01', 'monthly', 20000)`, [p]);
  const loan = await fx.loan({ person: p, loanNo: 'CI-LN-1101', date: '2027-11-01', rupees: 10000, paidVia: 'cash', by: MD.id });
  await h.db.q('UPDATE hr.loans SET instalment = 2000 WHERE id = $1', [loan.id]);
  const loansBefore = await balance(L['Staff Loans']);
  assert.equal((await post('loan', loan.id, MD)).result, 'posted');
  const expenseBefore = await balance(L['Salaries & Wages']);
  // November: 20,000, the instalment 2,000, 18,000 paid on 3 December.
  const nov = await hrMonth('2027-11', [p]);
  assert.equal(nov.status, 'finalised');
  const novLine = await runLine(nov.id, p);
  assert.equal(novLine.payable, 18000 * R);
  await payLine(novLine.id, 'CI-PAY-1101', '2027-12-03');
  const payableBefore = await balance(L['Salary Payable']);
  // The control check's Salary Payable gap, as at a day (R52a): it must not move by the correction.
  const spGap = async asAt => (await control(CI, asAt, '2028-01-10')).salary_payable.gap_paise;
  const gapsBefore = [await spGap('2027-11-30'), await spGap('2027-12-10')];
  // Corrected after it was paid: November's instalment 1,000, so HR owes 1,000 more, paid as arrears in December.
  const corrected = await ok(h.call('PUT', `/hr/loans/${loan.id}/month-instalment`,
    { month: '2027-11', amount: 1000, scope: 'month', confirm_finalised: true, note: 'Test correction' }, 'md'));
  assert.deepEqual(corrected.change.arrears, { month: '2027-12', kind: 'earning', amount: '1000.00' });
  const [novJournal] = await standing('hr_run', nov.id);
  assert.deepEqual(byName(await linesOf(novJournal)), byName([['Salaries & Wages', 20000 * R, 0], ['Staff Loans', 0, 1000 * R], ['Salary Payable', 0, 19000 * R]]),
    'the corrected month is posted again as HR has it now (R30)');
  // R52a: until December's journal books the arrears, Finance's Salary Payable holds the 1,000 November now owes, and HR's figure
  // carries the arrears it will pay: they match, as at the month end before the payment and after it.
  assert.deepEqual([await spGap('2027-11-30'), await spGap('2027-12-10')], gapsBefore);
  // December: 20,000, the 1,000 arrears, and 500 of arrears typed in HR (no correction's), the instalment 2,000, 19,500 to pay. The
  // carried 1,000 settles November's Salary Payable: it comes out of the expense and goes to Salary Payable's debit; the typed 500 is
  // December's expense like any pay.
  await typedAdjustment(p, { kind: 'earning', rupees: 500, month: '2027-12' });
  const dec = await hrMonth('2027-12', [p]);
  const decLine = await runLine(dec.id, p);
  assert.deepEqual([decLine.gross, decLine.payable], [21500 * R, 19500 * R]);
  const [decJournal] = await standing('hr_run', dec.id);
  assert.deepEqual(byName(await linesOf(decJournal)), byName([
    ['Salaries & Wages', 20500 * R, 0], ['Salary Payable', 1000 * R, 0], ['Staff Loans', 0, 2000 * R], ['Salary Payable', 0, 19500 * R]]));
  assert.equal(await spGap('2027-12-31'), gapsBefore[1], 'December\'s journal books the arrears: HR\'s figure no longer carries them');
  assert.equal(await spGap('2027-12-10'), gapsBefore[1], 'as at a day before that journal is dated, HR\'s figure still carries them');
  await payLine(decLine.id, 'CI-PAY-1201', '2028-01-04');
  assert.equal(await balance(L['Salary Payable']), payableBefore, 'Salary Payable is back where it was before the correction');
  assert.equal(await balance(L['Salaries & Wages']) - expenseBefore, (20000 + 21500 - 1000) * R, 'the two months\' gross less the carried arrears');
  assert.equal(await loanOwed(loan.id), 7000 * R);
  assert.equal(await balance(L['Staff Loans']) - loansBefore, await loanOwed(loan.id), 'Staff Loans follows HR');
});

test('R54: a paid month\'s instalment corrected up carries a deduction into the next month, booked against Salary Payable and not as another deduction', gate, async () => {
  const p = await fx.person({ name: 'Test Arrears Deduction' });
  await h.db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, '2028-01-01', 'monthly', 20000)`, [p]);
  const loan = await fx.loan({ person: p, loanNo: 'CI-LN-1102', date: '2028-01-02', rupees: 10000, paidVia: 'cash', by: MD.id });   // 1,000 a month
  const loansBefore = await balance(L['Staff Loans']);
  assert.equal((await post('loan', loan.id, MD)).result, 'posted');
  const [expenseBefore, deductionsBefore] = [await balance(L['Salaries & Wages']), await balance(L['Staff Deductions'])];
  // January: 20,000, the instalment 1,000, 19,000 paid on 3 February.
  const jan = await hrMonth('2028-01', [p], { leaveOut: [arrearsEarner] });
  const janLine = await runLine(jan.id, p);
  assert.equal(janLine.payable, 19000 * R);
  await payLine(janLine.id, 'CI-PAY-1301', '2028-02-03');
  const payableBefore = await balance(L['Salary Payable']);
  const spGap = async asAt => (await control(CI, asAt, '2028-03-10')).salary_payable.gap_paise;
  const gapsBefore = [await spGap('2028-01-31'), await spGap('2028-02-10')];
  // Corrected after it was paid: January's instalment 3,000, so 2,000 too much was paid, taken back in February.
  const corrected = await ok(h.call('PUT', `/hr/loans/${loan.id}/month-instalment`,
    { month: '2028-01', amount: 3000, scope: 'month', confirm_finalised: true, note: 'Test correction up' }, 'md'));
  assert.deepEqual(corrected.change.arrears, { month: '2028-02', kind: 'deduction', amount: '2000.00' });
  const [janJournal] = await standing('hr_run', jan.id);
  assert.deepEqual(byName(await linesOf(janJournal)), byName([['Salaries & Wages', 20000 * R, 0], ['Staff Loans', 0, 3000 * R], ['Salary Payable', 0, 17000 * R]]));
  // R52a: Finance's Salary Payable is 2,000 overpaid now, and HR's figure takes off the deduction it will make in February: they match.
  assert.deepEqual([await spGap('2028-01-31'), await spGap('2028-02-10')], gapsBefore);
  // February: 20,000, the instalment 1,000, the 2,000 taken back and 300 deducted as typed in HR (no correction's), 16,700 to pay. The
  // 2,000 settles January's overpaid Salary Payable: it goes to Salary Payable's credit, not to the other deductions; the typed 300 is
  // one of them, as any deduction is.
  await typedAdjustment(p, { kind: 'deduction', rupees: 300, month: '2028-02' });
  const feb = await hrMonth('2028-02', [p], { leaveOut: [arrearsEarner] });
  const febLine = await runLine(feb.id, p);
  assert.deepEqual([febLine.gross, febLine.adj, febLine.payable], [20000 * R, 2300 * R, 16700 * R]);
  const [febJournal] = await standing('hr_run', feb.id);
  assert.deepEqual(byName(await linesOf(febJournal)), byName([
    ['Salaries & Wages', 20000 * R, 0], ['Staff Loans', 0, 1000 * R], ['Staff Deductions', 0, 300 * R], ['Salary Payable', 0, 18700 * R]]));
  assert.equal(await spGap('2028-02-29'), gapsBefore[1], 'February\'s journal books the deduction');
  await payLine(febLine.id, 'CI-PAY-1302', '2028-03-03');
  assert.equal(await balance(L['Salary Payable']), payableBefore, 'Salary Payable is back where it was before the correction');
  assert.equal(await balance(L['Salaries & Wages']) - expenseBefore, (20000 + 20000) * R, 'the two months\' gross');
  assert.equal(await balance(L['Staff Deductions']) - deductionsBefore, -300 * R, 'only the typed deduction: the money taken back is no deduction of its own');
  assert.equal(await loanOwed(loan.id), 6000 * R);
  assert.equal(await balance(L['Staff Loans']) - loansBefore, await loanOwed(loan.id), 'Staff Loans follows HR');
});

test('R36a: a batch whose reversal an Approver sent back waits while HR still has it changed; put back as it stood, Bring-in would leave it, so it is not listed', gate, async () => {
  const pa = await fx.person({ name: 'Test Sent Back Batch A' });
  const pb = await fx.person({ name: 'Test Sent Back Batch B' });
  const run = await fx.payroll({ month: '2028-03', approvedBy: MD.id, lines: [{ person: pa, gross: 5000 }, { person: pb, gross: 6000 }] });
  await fx.finalise(run.id, { at: '2028-04-02T10:00:00+05:30', by: MD.id });
  const [la, lb] = [await lineOf(run.id, pa), await lineOf(run.id, pb)];
  const batch = await fx.payBatch({ lineIds: [la, lb], channel: 'CASH', batchNo: 'CI-PAY-1401', paidOn: '2028-03-31', by: MD.id });
  assert.equal((await bringIn(CI, MD, '2028-04-05')).posted, 2, 'the journal and the batch');
  const [stood] = await standing('hr_batch', batch);
  // A's cash handed back: the accounts login's post takes the batch's entry out by a reversal that waits for md, who sends it back.
  await fx.markLine(la, 'failed');
  const changed = await post('batch', batch, ACCT);
  assert.equal(changed.reversal?.result, 'submitted', JSON.stringify(changed));
  await ok(h.call('POST', `/finance/vouchers/${changed.reversal.voucher_ids[0]}/reject`, { reason: 'Check it in HR' }, 'md'));
  assert.deepEqual(await pendingIn(CI, '2028-06-10'), [{ type: 'batch', id: batch }], 'HR has it changed: Bring-in makes the reversal again');
  // A paid after all, as before: what HR posts is what stands, so Bring-in would leave it; the reversal sent back still waits.
  await h.db.q(`UPDATE hr.run_lines SET payment_status = 'paid', paid_amount = payable, paid_on = '2028-03-31', paid_at = now() WHERE id = $1`, [la]);
  assert.deepEqual([await pendingIn(CI, '2028-06-10'), (await statusOf(CI, '2028-06-10')).waiting], [[], 1]);
  assert.equal((await post('batch', batch, ACCT)).already, true, 'finHrPost agrees: it stands');
  // The reversal discarded by hand, nothing waits.
  await ok(h.call('POST', `/finance/vouchers/${changed.reversal.voucher_ids[0]}/discard`, {}, 'acct'));
  assert.deepEqual([(await statusOf(CI, '2028-06-10')).waiting, await standing('hr_batch', batch)], [0, [stood]]);
});

// ── The header line (spec §5) ───────────────────────────────────────────────────────────────

test('GET /finance/hr/status answers in under 2 KB', gate, async () => {
  for (const [book, who] of [[CI, 'acct'], [CI, 'viewer'], [DP, 'dpOnly']]) {
    const res = await fetch(`${h.base}/finance/hr/status?book=${book}`, { headers: { authorization: `Bearer ${h.users[who].token}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(Buffer.byteLength(text) < 2048, `${Buffer.byteLength(text)} bytes`);
    const body = JSON.parse(text);
    assert.deepEqual(Object.keys(body).sort(), ['control', 'exceptions', 'waiting']);
    assert.ok(Number.isInteger(body.waiting) && Number.isInteger(body.exceptions));
    assert.deepEqual(Object.keys(body.control).sort(), ['advances', 'as_at', 'loans', 'matches', 'salary_payable']);
    for (const item of [body.control.advances, body.control.loans, body.control.salary_payable]) {
      assert.deepEqual(Object.keys(item).sort(), ['finance_paise', 'gap_paise', 'hr_paise'], 'R37b: no figure of what is not due yet');
      assert.ok(Object.values(item).every(Number.isInteger));
    }
  }
  refused(await h.call('GET', `/finance/hr/status?book=${DP}`, null, 'viewer'), 403, 'FIN_FORBIDDEN');
});

// ── Last: over everything above ──────────────────────────────────────────────────────────────

test('privacy: the status, the exceptions and Bring-in carry counts, totals, HR document numbers and sentences, never a person', gate, async () => {
  const people = await h.db.q('SELECT name, code FROM hr.people');
  assert.ok(people.length > 30, `non-vacuous: ${people.length} people`);
  const answers = [];
  for (const [book, who] of [[CI, 'acct'], [DP, 'acct']]) {
    answers.push(await ok(h.call('GET', `/finance/hr/status?book=${book}`, null, who)));
    answers.push(await ok(h.call('GET', `/finance/hr/exceptions?book=${book}`, null, who)));
    answers.push(await ok(h.call('POST', '/finance/hr/bring-in', { book_id: book }, who)));
  }
  answers.push(await bringIn(CI, MD, '2028-01-05'));
  const text = JSON.stringify(answers);
  assert.ok(text.includes('FIN_UNMAPPED_CHANNEL'), 'non-vacuous: an exception is among them');
  for (const { name, code } of people) {
    for (const word of [name, code]) assert.equal(text.includes(word), false, `${word} reached an answer`);
  }
});
