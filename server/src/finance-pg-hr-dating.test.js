import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg, FIN_TEST_GRANTS } from './finance-pg-harness.js';
import { finHrFixtures } from './finance-hr-fixtures.js';

// HR's dates in the books when today is after the books begin and after a month's end (Cash & Bank spec §7.2, §7.7, §7.8, §9.5; final
// review C1 and I1, rulings R67 and R68). Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-dating.test.js
//
// Every other HR feed file keeps the books beginning on 1 January 2027, so the plant's real today comes before every entry the feed
// makes, and an entry dated "today, or the original's own date when that is later" is always dated the original's own date. Here the
// books begin on 1 June 2026, and the months they hold (June to September 2026) ended before this file was written (21 Nov 2026): the
// real today is after the books begin and after each month's end, as it will be in production, and it only moves on. So an HR reversal
// dated by the clock would land in a later month than the entry it takes out, beside a corrected entry HR dates back in that month:
// the double count of ruling R67. Nothing here is dated by today, or needs to be: every date is HR's own, or given. The tests share one
// boot and run in order. Every name and figure is invented.
//   • R68: the run of May 2026, the month before the books, finalised on 3 June: the advances on its payroll sheet are the Tally
//     opening's, so the books take none of them, and the control check matches on the 1st, the 2nd and the 3rd.
//   • R67: July 2026's run, finalised on 3 August, un-finalised and finalised again the next day, and a batch of it paid on 30 July whose
//     line fails on 2 August; August's run corrected in September; September's, locked under a correction and an undo. Each reversal
//     is dated at the entry it reverses, and no later month holds any of the month's money.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee
const BEGIN = '2026-06-01';

let h, feed, catchup, fx, CI, ACCT, MD;
const L = {};    // CI ledger name -> id
let groups;

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const groupOf = name => {
  const g = groups.find(x => x.name === name);
  assert.ok(g, `no group called ${name}`);
  return g.id;
};
const saveSetup = body => ok(h.call('PUT', '/finance/hr-setup', body, 'md'));
const post = (type, id, who = ACCT) => feed.finHrPost({ type, id }, who);
const control = (asAt, today = asAt) => catchup.finHrControl(h.db.q, CI, asAt, { today });
const voucherRow = id => h.db.one(
  `SELECT id, voucher_type, voucher_date, narration, status, number, source_type, source_id, reversal_of_id, reversed_by_id
     FROM fin_vouchers WHERE id = $1`, [id]);
const linesOf = async id => (await h.db.q(
  `SELECT fl.name, l.debit, l.credit FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id WHERE l.voucher_id = $1 ORDER BY l.line_no`,
  [id])).map(l => [l.name, Math.round(l.debit * R), Math.round(l.credit * R)]);
const standing = async (sourceType, sourceId) => (await h.db.q(
  `SELECT id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 AND status IN ('submitted', 'posted') AND reversed_by_id IS NULL
      AND reversal_of_id IS NULL ORDER BY id`, [sourceType, sourceId])).map(v => v.id);
const reversalOf = id => h.db.one('SELECT id, status, voucher_date, narration FROM fin_vouchers WHERE reversal_of_id = $1 ORDER BY id DESC LIMIT 1', [id]);
const exceptionOf = (sourceType, sourceId) => h.db.one(
  'SELECT reason_code, resolved_at FROM fin_hr_exceptions WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId]);
const approve = id => ok(h.call('POST', `/finance/vouchers/${id}/approve`, null, 'md'));
const lineOf = (runId, person) => h.db.one('SELECT id FROM hr.run_lines WHERE run_id = $1 AND person_id = $2', [runId, person]).then(r => r.id);
// A ledger's balance (debit − credit, paise) from its posted lines dated `asAt` or before.
const balance = async (name, asAt) => (await h.db.one(
  `SELECT COALESCE(round(sum(ln.debit - ln.credit) * 100), 0)::bigint AS n FROM fin_voucher_lines ln JOIN fin_vouchers v ON v.id = ln.voucher_id
    WHERE ln.ledger_id = $1 AND v.status = 'posted' AND v.voucher_date <= $2`, [L[name], asAt])).n;
const periodOf = start => h.db.one('SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = $2', [CI, start]).then(p => p.id);
const moveMonth = (id, status, reason = null) => ok(h.call('PUT', `/finance/periods/${id}/status`, { status, reason }, 'md'));
const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-dating', { setup: false });
  feed = await import('./finance-hr-feed.js');
  catchup = await import('./finance-hr-catchup.js');
  fx = finHrFixtures(h.db);
  await fx.channels();
  for (const [user, level] of [[h.users.md.id, 'admin'], [h.users.acct.id, 'accounts']]) await fx.access(user, level);
  ACCT = { id: h.users.acct.id, name: 'Test Accountant', hrLevel: 'accounts' };
  MD = { id: h.users.md.id, name: 'Test MD', hrLevel: 'admin' };

  const { finSetupBooks } = await import('./finance-setup.js');
  await h.db.tx((qc, oc) => finSetupBooks(qc, oc, { grants: FIN_TEST_GRANTS, booksBegin: BEGIN }));
  CI = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
  groups = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'md'))).groups;
  for (const [group, name] of [['Bank Accounts', 'Bank – current'], ['Indirect Incomes', 'Staff Deductions'], ['Indirect Expenses', 'Rounding Off']]) {
    await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: groupOf(group), name }, 'md'));
  }
  const DP = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'DP'`)).id;
  for (const book of [CI, DP]) await ok(h.call('POST', '/finance/hr-setup/ledgers', { book_id: book }, 'md'));
  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [CI])) L[l.name] = l.id;
  await saveSetup({
    book_id: CI,
    channels: [{ channel_code: 'CASH', ledger_id: L.Cash }, { channel_code: 'COLOUR', ledger_id: L['Bank – current'] }],
    roles: { other_deductions: L['Staff Deductions'], rounding: L['Rounding Off'] },
  });
});

after(async () => { await h?.close(); });

// ── The cut-over (ruling R68) ──────────────────────────────────────────────────────────────

let may;
test('R68: the run of the month before the books, finalised on the 3rd, posts no sheet advances; the control check matches on the 1st, the 2nd and the 3rd', gate, async () => {
  const paid = await fx.person({ name: 'Test Cutover Paid' });
  const owed = await fx.person({ name: 'Test Cutover Owed' });
  const hidden = await fx.person({ name: 'Test Cutover Hidden' });
  await fx.hide(hidden, { user: ACCT.id });
  may = await fx.payroll({ month: '2026-05', approvedBy: MD.id, lines: [
    { person: paid, gross: 9000, advanceGiven: 1000 }, { person: owed, gross: 11000 }, { person: hidden, gross: 8000, advanceGiven: 500 }] });
  await fx.finalise(may.id, { at: '2026-06-03T11:00:00+05:30', by: ACCT.id });
  // HR dates the sheet's advances LEAST(the month end, the finalise day): 31 May, before the books begin.
  assert.deepEqual((await h.db.q(`SELECT DISTINCT txn_date::text AS d FROM hr.advance_txns WHERE run_id = $1`, [may.id])).map(r => r.d), ['2026-05-31']);

  // The Opening, as Tally holds 31 May: the sheet's advances in Staff Advances, May's pay still owed in Salary Payable.
  const up = await ok(h.call('POST', '/finance/imports', {
    book_id: CI, purpose: 'opening', as_at: '2026-05-31', file_names: ['tb.xlsx'],
    accounts: [{ tally_name: 'Cash', tally_group: 'Cash-in-Hand' }, { tally_name: 'Staff Advances', tally_group: 'Loans & Advances (Asset)' },
      { tally_name: 'Salary Payable', tally_group: 'Current Liabilities' }, { tally_name: 'Test Capital A/c', tally_group: 'Capital Account' }],
    tb: [tb('Cash', 100000, 0), tb('Staff Advances', 1500, 0), tb('Salary Payable', 0, 28000), tb('Test Capital A/c', 0, 73500)],
    bills: [],
  }, 'acct'));
  const matches = up.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
    ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
  await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  assert.equal((await ok(h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'md'))).voucher.status, 'posted');
  const batch = await fx.payBatch({ lineIds: [await lineOf(may.id, paid)], channel: 'CASH', batchNo: 'CI-PAY-0501', paidOn: '2026-06-02', by: MD.id });

  // The sheet's advances are the opening's: skipped as before the books, like the month's own journal; the June payout posts.
  assert.deepEqual(await post('sheetAdvances', may.id, MD), { result: 'skipped', reason_code: 'before_books' });
  assert.deepEqual(await post('run', may.id, MD), { result: 'skipped', reason_code: 'before_books' });
  assert.deepEqual(await catchup.finHrPending(h.db.q, CI, { asOf: '2026-06-03' }), [{ type: 'batch', id: batch }], 'nothing else waits');
  assert.deepEqual(await catchup.finBringInFromHr(CI, MD, { asOf: '2026-06-03' }), { posted: 1, submitted: 0, skipped: 0, exceptions: [], more: false });
  const [payout] = await standing('hr_batch', batch);
  assert.deepEqual([(await voucherRow(payout)).voucher_date, await linesOf(payout)], ['2026-06-02', [['Salary Payable', 9000 * R, 0], ['Cash', 0, 9000 * R]]]);
  assert.equal(await balance('Staff Advances', '2026-12-31'), 1500 * R, 'the books hold the opening\'s advances once');

  for (const [day, owing] of [['2026-06-01', 28000], ['2026-06-02', 19000], ['2026-06-03', 19000]]) {
    const check = await control(day);
    assert.deepEqual(check, {
      as_at: day,
      advances: { finance_paise: 1500 * R, hr_paise: 1500 * R, gap_paise: 0 },
      loans: { finance_paise: 0, hr_paise: 0, gap_paise: 0 },
      salary_payable: { finance_paise: owing * R, hr_paise: owing * R, gap_paise: 0 },
      matches: true,
    }, `as at ${day}`);
  }
  // The hidden person's sheet advance is the opening's too: June's sweep finds nothing of theirs to combine.
  assert.deepEqual(await feed.finHrPostHidden(MD, { asOf: '2026-07-01' }), { posted: 0, submitted: 0, skipped: 0, exceptions: [] });
  assert.equal((await h.db.one(`SELECT count(*)::int AS n FROM fin_vouchers WHERE source_type LIKE 'hr\\_hidden:%'`)).n, 0);
});

// ── HR's reversals, dated at the entry they take out (ruling R67) ─────────────────────────────────
//
// Each test has a month of its own, so each stands or falls by itself: July 2026 (un-finalised and finalised again; a batch whose line
// fails), August (a correction) and September (locked under a correction and an undo). Each checks the books by the month's own
// movement: what the month holds, and that no later month holds any of it.

const dayBefore = day => new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
// A ledger's movement from `from` to `to`, both days included (paise, debit − credit).
const movement = async (name, from, to) => (await balance(name, to)) - (await balance(name, dayBefore(from)));
// What a month moved on the ledgers the payroll touches, and what every month after it, up to the books' last day here, moved.
const moved = async (from, to) => Object.fromEntries(await Promise.all(
  ['Salaries & Wages', 'Salary Payable', 'Staff Deductions', 'Cash'].map(async name => [name, await movement(name, from, to)])));
const LATER = '2027-03-31';
const nothing = { 'Salaries & Wages': 0, 'Salary Payable': 0, 'Staff Deductions': 0, Cash: 0 };
const correct = (runId, person, rupees) => h.db.q(
  `UPDATE hr.run_lines SET misc_deduction = misc_deduction + $3, total_deductions = total_deductions + $3, net = net - $3, payable = payable - $3
    WHERE run_id = $1 AND person_id = $2`, [runId, person, rupees]);

let july, jul;
test('R67: un-finalised and finalised again the next month, July\'s journal is reversed on 31 July, and July holds one month\'s pay', gate, async () => {
  jul = {
    a: await fx.person({ name: 'Test Dating A' }), b: await fx.person({ name: 'Test Dating B' }),
    e: await fx.person({ name: 'Test Dating E' }), f: await fx.person({ name: 'Test Dating F' }),
  };
  july = await fx.payroll({ month: '2026-07', approvedBy: MD.id, lines: [
    { person: jul.a, gross: 20000 }, { person: jul.b, gross: 15000 }, { person: jul.e, gross: 12000 }, { person: jul.f, gross: 10000 }] });
  await fx.finalise(july.id, { at: '2026-08-03T11:00:00+05:30', by: ACCT.id });
  const first = await post('run', july.id);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  assert.deepEqual([(await voucherRow(first.voucher_id)).voucher_date, await linesOf(first.voucher_id)],
    ['2026-07-31', [['Salaries & Wages', 57000 * R, 0], ['Salary Payable', 0, 57000 * R]]]);

  // Un-finalised on 4 August by the accounts login: the reversal waits for the MD, dated 31 July, the journal's own day.
  await fx.unfinalise(july.id);
  const undo = await post('run', july.id);
  assert.deepEqual([undo.result, undo.reason_code, undo.reversal?.result], ['skipped', 'not_finalised', 'submitted'], JSON.stringify(undo));
  const rev = await reversalOf(first.voucher_id);
  assert.deepEqual([rev.status, rev.voucher_date], ['submitted', '2026-07-31'], 'dated at the journal it reverses, never today');
  await approve(rev.id);
  assert.deepEqual([(await voucherRow(rev.id)).status, (await voucherRow(rev.id)).voucher_date], ['posted', '2026-07-31']);

  // Finalised again the same day: the journal goes back to 31 July, and July holds one month's pay; no later month takes the reversal.
  await fx.finalise(july.id, { at: '2026-08-04T10:00:00+05:30', by: ACCT.id });
  const again = await post('run', july.id);
  assert.equal(again.result, 'posted', JSON.stringify(again));
  assert.equal((await voucherRow(again.voucher_id)).voucher_date, '2026-07-31');
  assert.deepEqual(await moved('2026-07-01', '2026-07-31'), { ...nothing, 'Salaries & Wages': 57000 * R, 'Salary Payable': -57000 * R });
  assert.deepEqual(await moved('2026-08-01', LATER), nothing, 'August on: nothing of July');
});

test('R67: a correction of the finalised month reverses its journal on 31 August and books the corrected one there, once', gate, async () => {
  const c = await fx.person({ name: 'Test Dating C' });
  const d = await fx.person({ name: 'Test Dating D' });
  const august = await fx.payroll({ month: '2026-08', approvedBy: MD.id, lines: [{ person: c, gross: 18000 }, { person: d, gross: 14000 }] });
  await fx.finalise(august.id, { at: '2026-09-03T11:00:00+05:30', by: ACCT.id });
  const first = await post('run', august.id);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  // As hr/correction.js corrects a finalised line, on 10 September: a ₹500 deduction, and the payable with it.
  await correct(august.id, c, 500);
  const out = await post('run', august.id, MD);
  assert.deepEqual([out.result, out.reversal?.result], ['posted', 'posted'], JSON.stringify(out));
  assert.equal((await reversalOf(first.voucher_id)).voucher_date, '2026-08-31', 'dated at the journal it reverses, never today');
  assert.equal((await voucherRow(out.voucher_id)).voucher_date, '2026-08-31');
  assert.deepEqual(await moved('2026-08-01', '2026-08-31'),
    { ...nothing, 'Salaries & Wages': 32000 * R, 'Salary Payable': -31500 * R, 'Staff Deductions': -500 * R }, 'one journal\'s worth, as corrected');
  assert.deepEqual(await moved('2026-09-01', LATER), nothing, 'September on: nothing of August');
});

test('R67: a batch paid on 30 July whose line fails on 2 August is reversed on 30 July; the cash July ends with is what was paid', gate, async () => {
  const lineIds = [await lineOf(july.id, jul.e), await lineOf(july.id, jul.f)];
  const before = { july: await moved('2026-07-01', '2026-07-31'), later: await moved('2026-08-01', LATER) };
  const batch = await fx.payBatch({ lineIds, channel: 'CASH', batchNo: 'CI-PAY-0701', paidOn: '2026-07-30', by: MD.id });
  const first = await post('batch', batch, MD);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  assert.deepEqual(await linesOf(first.voucher_id), [['Salary Payable', 22000 * R, 0], ['Cash', 0, 22000 * R]]);
  await fx.markLine(lineIds[1], 'failed');
  const redo = await post('batch', batch, MD);
  assert.deepEqual([redo.result, redo.reversal?.result], ['posted', 'posted'], JSON.stringify(redo));
  assert.equal((await voucherRow(redo.reversal.voucher_ids[0])).voucher_date, '2026-07-30', 'dated at the batch it reverses, never today');
  assert.deepEqual([(await voucherRow(redo.voucher_id)).voucher_date, await linesOf(redo.voucher_id)],
    ['2026-07-30', [['Salary Payable', 12000 * R, 0], ['Cash', 0, 12000 * R]]]);
  const now = { july: await moved('2026-07-01', '2026-07-31'), later: await moved('2026-08-01', LATER) };
  assert.equal(now.july.Cash - before.july.Cash, -12000 * R, 'July\'s cash: the one line still paid');
  assert.equal(now.july['Salary Payable'] - before.july['Salary Payable'], 12000 * R);
  assert.deepEqual(now.later, before.later, 'August on: nothing of the batch');
});

test('R67: with September locked, a correction and an undo of its journal are exceptions, "reopen the month"; reopened, each reverses on 30 September', gate, async () => {
  const g = await fx.person({ name: 'Test Dating G' });
  const k = await fx.person({ name: 'Test Dating K' });
  const september = await fx.payroll({ month: '2026-09', approvedBy: MD.id, lines: [{ person: g, gross: 16000 }, { person: k, gross: 13000 }] });
  await fx.finalise(september.id, { at: '2026-10-03T11:00:00+05:30', by: MD.id });
  let journal = (await post('run', september.id, MD)).voucher_id;
  assert.equal((await voucherRow(journal)).voucher_date, '2026-09-30');
  const SEP = await periodOf('2026-09-01');
  const lock = async () => { await moveMonth(SEP, 'closing'); await moveMonth(SEP, 'locked'); };
  const reopen = async () => { await moveMonth(SEP, 'closing', 'Reopened for the HR entries'); await moveMonth(SEP, 'open', 'Open again'); };
  const listed = async () => (await catchup.finHrExceptionsOf(CI)).exceptions.find(x => x.type === 'run' && x.hr_id === september.id);

  // A correction while September is locked: nothing moves, and the event waits as an exception.
  await lock();
  try {
    await correct(september.id, g, 300);
    assert.deepEqual(await post('run', september.id, MD), { result: 'exception', reason_code: 'FIN_PERIOD_LOCKED' });
    assert.deepEqual(await standing('hr_run', september.id), [journal], 'the journal stands as it was');
    const ex = await listed();
    assert.deepEqual([ex?.reason_code, ex?.fix], ['FIN_PERIOD_LOCKED', 'reopen_month']);
  } finally {
    await reopen();
  }
  const corrected = await post('run', september.id, MD);
  assert.deepEqual([corrected.result, corrected.reversal?.result], ['posted', 'posted'], JSON.stringify(corrected));
  assert.equal((await reversalOf(journal)).voucher_date, '2026-09-30');
  assert.ok((await exceptionOf('hr_run', september.id)).resolved_at, 'the retry resolves it');
  journal = corrected.voucher_id;

  // An undo while September is locked: not a reversal in a later month, which would leave September's journal standing, but an exception.
  await lock();
  try {
    await fx.unfinalise(september.id);
    assert.deepEqual(await post('run', september.id, MD), { result: 'exception', reason_code: 'FIN_PERIOD_LOCKED' });
    assert.deepEqual(await standing('hr_run', september.id), [journal]);
    assert.equal((await listed())?.fix, 'reopen_month');
  } finally {
    await reopen();
  }
  const undone = await post('run', september.id, MD);
  assert.deepEqual([undone.result, undone.reason_code, undone.reversal?.result], ['skipped', 'not_finalised', 'posted'], JSON.stringify(undone));
  assert.equal((await reversalOf(journal)).voucher_date, '2026-09-30');
  await fx.finalise(september.id, { at: '2026-10-12T10:00:00+05:30', by: MD.id });
  const last = await post('run', september.id, MD);
  assert.equal(last.result, 'posted', JSON.stringify(last));
  assert.equal((await voucherRow(last.voucher_id)).voucher_date, '2026-09-30');

  // September, as at its end: one month's pay, as corrected; and nothing of it later.
  assert.deepEqual(await moved('2026-09-01', '2026-09-30'),
    { ...nothing, 'Salaries & Wages': 29000 * R, 'Salary Payable': -28700 * R, 'Staff Deductions': -300 * R });
  assert.deepEqual(await moved('2026-10-01', LATER), nothing, 'October on: nothing of September');
});

test('R67: every reversal the feed made here is dated at the entry it reverses', gate, async () => {
  const reversals = await h.db.q(
    `SELECT r.id, r.voucher_date AS reversed_on, o.voucher_date AS dated FROM fin_vouchers r JOIN fin_vouchers o ON o.id = r.reversal_of_id
      WHERE o.source_type LIKE 'hr\\_%' ORDER BY r.id`);
  assert.equal(reversals.length, 5, 'non-vacuous: July\'s undo, August\'s correction, the batch, September\'s correction and undo');
  assert.deepEqual(reversals.filter(r => r.reversed_on !== r.dated), []);
});
