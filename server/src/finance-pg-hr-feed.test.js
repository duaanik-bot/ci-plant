import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';
import { finHrFixtures } from './finance-hr-fixtures.js';

// The HR feed, part 1 (Cash & Bank spec §7.2, §7.3, §7.4, §7.6, §7.7; plan Task 10; rulings R18, R19, R20; part 2's in
// finance-pg-hr-payroll.test.js): each HR money event (an
// advance given, an advance sheet, a loan, a loan prepayment, a payment batch, a line paid on its own, a waiver) posts one Finance
// voucher, or waits as an exception, or is skipped before the books begin. Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-feed.test.js
//
// One boot for the file. The tests share it and run in order, each with HR rows of its own (finance-hr-fixtures.js: SQL as HR writes
// them, HR being read and never written by Finance). The CASH channel maps to Office cash, COLOUR to Bank – current and DARBI to DP's
// bank; SPARE is mapped only when the unmapped-channel test says so. The privacy test runs last, over everything the others posted.
// Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, feed, vouchers, fx, CI, DP, ACCT, MD, JAN;
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
const voucherRow = id => h.db.one(
  `SELECT id, book_id, voucher_type, voucher_date, narration, reference, status, number, total, source_type, source_id, created_by,
          created_by_id, submitted_by, approved_by, approved_by_id, self_approved, reversal_of_id, reversed_by_id
     FROM fin_vouchers WHERE id = $1`, [id]);
// A voucher's lines as [ledger name, debit paise, credit paise], in line order.
const linesOf = async id => (await h.db.q(
  `SELECT fl.name, l.debit, l.credit FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id WHERE l.voucher_id = $1 ORDER BY l.line_no`,
  [id])).map(l => [l.name, Math.round(l.debit * R), Math.round(l.credit * R)]);
// Every voucher a source has, whatever its status: one draft left behind would show here.
const vouchersOf = (sourceType, sourceId) => h.db.q(
  'SELECT id, status, reversed_by_id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 ORDER BY id', [sourceType, sourceId]);
const exceptionOf = (sourceType, sourceId) => h.db.one(
  `SELECT id, source_type, source_id, book_id, reason_code, reason, first_seen_at, last_tried_at, resolved_at, voucher_id
     FROM fin_hr_exceptions WHERE source_type = $1 AND source_id = $2`, [sourceType, sourceId]);
const count = async table => (await h.db.one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
// The `after` of a voucher's `post` row in the log: where an approval given in HR is recorded (ruling R26b).
const postRow = async id => (await h.db.one(`SELECT after FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 AND action = 'post'`, [id])).after;
// Everything HR keeps, row for row: the feed reads HR and never writes it.
const hrState = async () => {
  const out = {};
  for (const table of ['people', 'pay_channels', 'access_hidden', 'advance_txns', 'loans', 'loan_txns', 'runs', 'run_lines',
    'payment_batches', 'advance_sheets', 'advance_sheet_lines', 'audit_log']) {
    out[table] = await h.db.q(`SELECT * FROM hr.${table} ORDER BY 1, 2`);
  }
  return JSON.stringify(out);
};
const moveMonth = (status, reason = null) => ok(h.call('PUT', `/finance/periods/${JAN}/status`, { status, reason }, 'md'));

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-feed');
  feed = await import('./finance-hr-feed.js').catch(() => ({}));
  vouchers = await import('./finance-vouchers.js');
  fx = finHrFixtures(h.db);
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const book of [CI, DP]) GROUPS[book] = (await ok(h.call('GET', `/finance/books/${book}/groups`, null, 'md'))).groups;
  JAN = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2027-01-01'`, [CI])).id;
  ACCT = { id: h.users.acct.id, name: 'Test Accountant', hrLevel: 'accounts' };
  MD = { id: h.users.md.id, name: 'Test MD', hrLevel: 'admin' };

  await fx.channels();
  // HR's own levels (hr.access): the MD an admin, the accountant at the accounts level, a second approver, and an operator.
  for (const [user, level] of [[h.users.md.id, 'admin'], [h.users.acct.id, 'accounts'], [h.users.appr2.id, 'approver'], [h.users.viewer.id, 'operator']]) {
    await fx.access(user, level);
  }
  await makeLedger(CI, 'Cash-in-Hand', 'Office cash');
  await makeLedger(CI, 'Cash-in-Hand', 'Holder A Cash', { holder_name: 'Holder A' });
  await makeLedger(CI, 'Bank Accounts', 'Bank – current');
  await makeLedger(CI, 'Bank Accounts', 'Bank – spare');
  await makeLedger(CI, 'Indirect Expenses', 'Advance Waivers');
  await makeLedger(DP, 'Bank Accounts', 'DP Bank');
  for (const book of [CI, DP]) await ok(h.call('POST', '/finance/hr-setup/ledgers', { book_id: book }, 'md'));
  for (const l of await h.db.q('SELECT id, book_id, name FROM fin_ledgers')) (l.book_id === CI ? L : D)[l.name] = l.id;
  await saveSetup({ book_id: CI, channels: [
    { channel_code: 'CASH', ledger_id: L['Office cash'] },
    { channel_code: 'COLOUR', ledger_id: L['Bank – current'] },
    { channel_code: 'DARBI', ledger_id: D['DP Bank'] },
  ] });
});

after(async () => { await h?.close(); });

// ── The brief's twelve ───────────────────────────────────────────────────────────────────────

test('an advance given in cash posts Dr Staff Advances / Cr Office cash, narrated "Advance · Pay staff · 1 person"', gate, async () => {
  const a = await fx.person({ name: 'Test Person A' });
  const adv = await fx.advance({ person: a, date: '2027-01-11', rupees: 5000, paidVia: 'cash', door: 'pay_staff', by: ACCT.id });
  const out = await post('advance', adv);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual(
    [v.book_id, v.voucher_type, v.voucher_date, v.narration, v.reference, v.status, v.source_type, v.source_id, v.created_by, v.created_by_id],
    [CI, 'payment', '2027-01-11', 'Advance · Pay staff · 1 person', null, 'posted', 'hr_advance', adv, 'Test Accountant (HR)', ACCT.id]);
  assert.match(v.number, /^CI-PV-2627-\d{4}$/);
  assert.equal(v.approved_by_id, null, 'a ₹5,000 payment needs no Approver');
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 5000 * R, 0], ['Office cash', 0, 5000 * R]]);
  // The posting's own log rows are the HR actor's, and the voucher's lines carry no words of their own.
  const logged = await h.db.q(`SELECT action, user_id, user_name FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [v.id]);
  assert.deepEqual(logged.map(r => [r.action, r.user_id, r.user_name]), [['create', ACCT.id, 'Test Accountant (HR)'], ['post', ACCT.id, 'Test Accountant (HR)']]);
  assert.deepEqual(await h.db.q('SELECT narration, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1 AND (narration IS NOT NULL OR bill_ref IS NOT NULL)', [v.id]), []);
  assert.equal((await postRow(v.id)).approved_in_hr_by, undefined, 'given by the accounts login: no approval in HR to record');
});

test('an advance paid from fin:<Holder A> credits Holder A', gate, async () => {
  const b = await fx.person({ name: 'Test Person B' });
  const adv = await fx.advance({ person: b, date: '2027-01-12', rupees: 3000, paidVia: `fin:${L['Holder A Cash']}`, by: ACCT.id });
  const out = await post('advance', adv);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  assert.deepEqual(await linesOf(out.voucher_id), [['Staff Advances', 3000 * R, 0], ['Holder A Cash', 0, 3000 * R]]);
});

test('a confirmed CASH batch of 9 lines posts Dr Salary Payable / Cr Office cash, narrated "Salary Jan · cash · CI-PAY-0001 · 9 people"', gate, async () => {
  const run = await fx.run('2027-01');
  const rupees = [8000, 8500, 9000, 7500, 10000, 6000, 9500, 7000, 8200];   // ₹73,700, under the ₹1,00,000 a payment may post without an Approver
  const lines = [];
  for (const [i, amount] of rupees.entries()) {
    // two of them belong to no firm, which books to CI (spec §7.2)
    lines.push({ person: await fx.person({ name: `Test Cash Person ${i + 1}`, firm: i < 2 ? null : 'COLOUR' }), rupees: amount, approvedBy: MD.id });
  }
  const batch = await fx.batch({ run, channel: 'CASH', batchNo: 'CI-PAY-0001', paidOn: '2027-02-05', reference: 'Cash handed over by Test Cash Person 1', lines, by: ACCT.id });

  // What it posts, worked out without writing anything.
  const before = await count('fin_vouchers');
  const built = await h.db.tx(qc => feed.finHrVoucherFor(qc, { type: 'batch', id: batch.id }));
  assert.deepEqual(built, {
    book_id: CI, voucher_type: 'payment', voucher_date: '2027-02-05', narration: 'Salary Jan · cash · CI-PAY-0001 · 9 people',
    reference: 'CI-PAY-0001', source_type: 'hr_batch', source_id: batch.id, hr_approved_by: { id: MD.id, name: 'Test MD' },
    lines: [{ ledger_id: L['Salary Payable'], debit_paise: 73700 * R, credit_paise: 0 }, { ledger_id: L['Office cash'], debit_paise: 0, credit_paise: 73700 * R }],
  });
  assert.equal(await count('fin_vouchers'), before, 'finHrVoucherFor writes nothing');

  const out = await post('batch', batch.id);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.reference, v.source_type, v.source_id],
    ['payment', '2027-02-05', 'Salary Jan · cash · CI-PAY-0001 · 9 people', 'CI-PAY-0001', 'hr_batch', batch.id]);
  assert.equal(v.approved_by_id, null, 'under ₹1,00,000 no Approver is needed, so the voucher records none, as SP1 sets it…');
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' },
    '…and its post row records that md approved it in HR (ruling R26b)');
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', 73700 * R, 0], ['Office cash', 0, 73700 * R]]);
});

test('a loan prepayment posts a receipt Dr Office cash / Cr Staff Loans', gate, async () => {
  const c = await fx.person({ name: 'Test Person C' });
  const loan = await fx.loan({ person: c, loanNo: 'CI-LN-0004', date: '2027-01-06', rupees: 20000, paidVia: 'cash', by: ACCT.id });
  const prepay = await fx.prepay({ loan: loan.id, date: '2027-01-25', rupees: 2000, paidVia: 'cash', by: ACCT.id });
  const out = await post('prepay', prepay);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.reference, v.source_type, v.source_id],
    ['receipt', '2027-01-25', 'Loan repaid · CI-LN-0004', 'CI-LN-0004', 'hr_prepay', prepay]);
  assert.match(v.number, /^CI-RV-2627-\d{4}$/);
  assert.deepEqual(await linesOf(v.id), [['Office cash', 2000 * R, 0], ['Staff Loans', 0, 2000 * R]]);
  // …and the loan itself, its disbursal: Dr Staff Loans / Cr the account it was paid from.
  const lent = await post('loan', loan.id);
  assert.equal(lent.result, 'posted', JSON.stringify(lent));
  const lv = await voucherRow(lent.voucher_id);
  assert.deepEqual([lv.voucher_type, lv.voucher_date, lv.narration, lv.reference, lv.source_type],
    ['payment', '2027-01-06', 'Loan · CI-LN-0004 · 1 person', 'CI-LN-0004', 'hr_loan']);
  assert.deepEqual(await linesOf(lv.id), [['Staff Loans', 20000 * R, 0], ['Office cash', 0, 20000 * R]]);
});

test('the same event posted twice leaves one live voucher (H8)', gate, async () => {
  const p = await fx.person({ name: 'Test Person Twice' });
  const adv = await fx.advance({ person: p, date: '2027-01-13', rupees: 1500, paidVia: 'cash', by: ACCT.id });
  const first = await post('advance', adv);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  const audit = await count('fin_audit_log');
  const again = await post('advance', adv);
  assert.deepEqual(again, { result: 'posted', voucher_id: first.voucher_id, already: true });
  const byMd = await post('advance', adv, MD);
  assert.deepEqual(byMd, { result: 'posted', voucher_id: first.voucher_id, already: true }, 'whoever asks');
  assert.deepEqual((await vouchersOf('hr_advance', adv)).map(v => [v.id, v.status]), [[first.voucher_id, 'posted']], 'one voucher, no draft left behind');
  assert.equal(await count('fin_audit_log'), audit, 'a second post writes nothing');
});

test('an unmapped channel makes an exception FIN_UNMAPPED_CHANNEL; after mapping, a second finHrPost posts it and marks it resolved', gate, async () => {
  const run = await fx.run('2027-01');
  const lines = [];
  for (const name of ['Test Spare Person 1', 'Test Spare Person 2']) {
    lines.push({ person: await fx.person({ name, channel: 'SPARE' }), rupees: 11000, approvedBy: MD.id });
  }
  const batch = await fx.batch({ run, channel: 'SPARE', batchNo: 'CI-PAY-0002', paidOn: '2027-02-06', lines, by: ACCT.id });
  const was = { vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') };

  const out = await post('batch', batch.id);
  assert.deepEqual(out, { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL' });
  const first = await exceptionOf('hr_batch', batch.id);
  assert.deepEqual([first.book_id, first.reason_code, first.reason, first.resolved_at, first.voucher_id],
    [CI, 'FIN_UNMAPPED_CHANNEL', 'Map this HR pay channel to an account in Finance Setup first.', null, null]);
  assert.ok(first.first_seen_at && first.last_tried_at, 'when it was first seen and last tried');
  assert.deepEqual({ vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') }, was, 'nothing posted, no draft left');

  // Tried again before the fix: the same exception, first seen when it was, tried again now.
  assert.deepEqual(await post('batch', batch.id), { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL' });
  const second = await exceptionOf('hr_batch', batch.id);
  assert.equal(second.id, first.id);
  assert.equal(second.first_seen_at.getTime(), first.first_seen_at.getTime());
  assert.ok(second.last_tried_at >= first.last_tried_at);
  assert.equal(await count('fin_hr_exceptions WHERE source_type = \'hr_batch\' AND source_id = ' + Number(batch.id)), 1);

  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – spare'] }] });
  const posted = await post('batch', batch.id);
  assert.equal(posted.result, 'posted', JSON.stringify(posted));
  assert.deepEqual(await linesOf(posted.voucher_id), [['Salary Payable', 22000 * R, 0], ['Bank – spare', 0, 22000 * R]]);
  assert.equal((await voucherRow(posted.voucher_id)).narration, 'Salary Jan · spare bank · CI-PAY-0002 · 2 people');
  const resolved = await exceptionOf('hr_batch', batch.id);
  assert.ok(resolved.resolved_at, 'resolved');
  assert.equal(resolved.voucher_id, posted.voucher_id);
  assert.deepEqual(await post('batch', batch.id), { result: 'posted', voucher_id: posted.voucher_id, already: true }, 'posted exactly once');
});

test('an event dated 2026-12-30 is skipped as before_books, with no exception', gate, async () => {
  const p = await fx.person({ name: 'Test Person December' });
  // paid through a channel nobody mapped: before the books begin that is no exception either
  const adv = await fx.advance({ person: p, date: '2026-12-30', rupees: 2500, paidVia: 'NO SUCH CHANNEL', by: ACCT.id });
  const was = await count('fin_vouchers');
  assert.deepEqual(await post('advance', adv), { result: 'skipped', reason_code: 'before_books' });
  assert.equal(await exceptionOf('hr_advance', adv), null);
  assert.equal(await count('fin_vouchers'), was);
  const built = await h.db.tx(qc => feed.finHrVoucherFor(qc, { type: 'advance', id: adv }, ACCT));
  assert.equal(built.skip, 'before_books');
});

test('a ₹1,50,000 advance by an accounts-level login waits for md; by md it posts', gate, async () => {
  const e = await fx.person({ name: 'Test Person Large' });
  const adv = await fx.advance({ person: e, date: '2027-01-14', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const out = await post('advance', adv);
  assert.equal(out.result, 'submitted', JSON.stringify(out));
  const waiting = await voucherRow(out.voucher_id);
  assert.deepEqual([waiting.status, waiting.number, waiting.submitted_by, waiting.approved_by_id], ['submitted', null, 'Test Accountant (HR)', null]);
  // The Approvers are told, as any entry that waits tells them (finSubmitVoucher), and the maker is not.
  const told = await h.db.q(`SELECT user_id FROM notifications WHERE kind = 'fin_approval' AND ref_table = 'fin_vouchers' AND ref_id = $1 ORDER BY user_id`,
    [waiting.id]);
  assert.deepEqual(told.map(n => n.user_id), [h.users.md.id, h.users.appr2.id].sort((x, y) => x - y));
  // While it waits, it is the event's voucher: a second post makes no other.
  assert.deepEqual(await post('advance', adv), { result: 'submitted', voucher_id: waiting.id, already: true });
  assert.equal((await vouchersOf('hr_advance', adv)).length, 1);
  // md approves it in Finance, and it posts in his name.
  const approved = await ok(h.call('POST', `/finance/vouchers/${waiting.id}/approve`, null, 'md'));
  assert.deepEqual([approved.voucher.status, approved.voucher.approved_by], ['posted', 'Test MD']);

  // The same advance given in HR by md, an HR approver, posts at once, approved in HR by him.
  const f = await fx.person({ name: 'Test Person Large Two' });
  const mine = await fx.advance({ person: f, date: '2027-01-14', rupees: 150000, paidVia: 'cash', by: MD.id });
  const byMd = await post('advance', mine, MD);
  assert.equal(byMd.result, 'posted', JSON.stringify(byMd));
  const v = await voucherRow(byMd.voucher_id);
  assert.deepEqual([v.status, v.approved_by_id, v.approved_by, v.self_approved, v.created_by], ['posted', MD.id, 'Test MD', true, 'Test MD (HR)']);
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });
});

test('R69: an HR entry\'s bells, and so its phone pushes, name its HR words and head-count, never an amount: on submit, on reject, and for an HR reversal', gate, async () => {
  const { pushPayload } = await import('./push.js');
  const bells = (kind, id) => h.db.q(
    `SELECT user_id, title, body FROM notifications WHERE kind = $1 AND ref_table = 'fin_vouchers' AND ref_id = $2 ORDER BY user_id`, [kind, id]);
  const noAmount = list => {
    assert.ok(list.length > 0, 'non-vacuous: a bell rang');
    for (const b of list) {
      assert.doesNotMatch(b.body, /₹|\d,\d\d,\d\d\d|\b\d{4,}\b/, `an amount in "${b.body}"`);
      assert.equal(JSON.parse(pushPayload({ kind: 'fin_approval', title: b.title, body: b.body })).body, b.body, 'the push says what the bell says');
    }
  };
  // A single person's ₹1,50,000 advance by the accounts login waits for an Approver: the bell names the entry as the feed narrates it.
  const p = await fx.person({ name: 'Test Person Bell' });
  const big = await fx.advance({ person: p, date: '2027-01-15', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const out = await post('advance', big);
  assert.equal(out.result, 'submitted', JSON.stringify(out));
  const waiting = await bells('fin_approval', out.voucher_id);
  assert.deepEqual(waiting.map(b => [b.user_id, b.body]), [h.users.md.id, h.users.appr2.id].sort((x, y) => x - y)
    .map(id => [id, 'CI Payment · Advance · Pay staff · 1 person — Test Accountant (HR)']));
  noAmount(waiting);
  // Sent back: its maker, the HR login, is told the same way, with the Approver's reason.
  await ok(h.call('POST', `/finance/vouchers/${out.voucher_id}/reject`, { reason: 'Test: check it in HR' }, 'md'));
  const back = await bells('fin_decision', out.voucher_id);
  assert.deepEqual(back.map(b => [b.user_id, b.title, b.body]),
    [[ACCT.id, 'Your Finance entry was rejected', 'CI Payment · Advance · Pay staff · 1 person — Test: check it in HR']]);
  noAmount(back);
  // An HR reversal that waits for an Approver: named by the HR entry it takes out.
  const small = await fx.advance({ person: p, date: '2027-01-16', rupees: 2400, paidVia: 'cash', by: ACCT.id });
  assert.equal((await post('advance', small)).result, 'posted');
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, '2027-01-17', 'recovered', 2400, 'manual', $2)`,
    [p, small]);
  const undone = await post('advance', small);
  assert.deepEqual([undone.reason_code, undone.reversal?.result], ['reversed', 'submitted'], JSON.stringify(undone));
  const reversal = await bells('fin_approval', undone.reversal.voucher_ids[0]);
  assert.deepEqual([...new Set(reversal.map(b => b.body))], ['CI Reversal · Advance · Pay staff · 1 person — Test Accountant (HR)']);
  noAmount(reversal);
});

test('R26: an advance, a loan or a prepayment carries its doer\'s HR approval, not its poster\'s: an MD-given ₹1,50,000 advance brought in by the accounts login posts approved by the MD', gate, async () => {
  const p = await fx.person({ name: 'Test Person Doer' });
  // Given in HR by md, brought into Finance by the accounts login (Task 13's catch-up does so): approved in HR by md.
  const byMd = await fx.advance({ person: p, date: '2027-01-15', rupees: 150000, paidVia: 'cash', by: MD.id });
  const out = await post('advance', byMd, ACCT);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.created_by, v.approved_by_id, v.approved_by, v.self_approved], ['Test Accountant (HR)', MD.id, 'Test MD', false]);
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });
  // Given in HR by the accountant, brought in by md: not approved in HR, so the book's rules decide, with md as the actor only.
  const byAcct = await fx.advance({ person: p, date: '2027-01-16', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const waits = await post('advance', byAcct, MD);
  assert.equal(waits.result, 'submitted', JSON.stringify(waits));
  assert.deepEqual([(await voucherRow(waits.voucher_id)).created_by, (await voucherRow(waits.voucher_id)).approved_by_id], ['Test MD (HR)', null]);
  // An HR approver below admin counts the same; an operator does not; and the level is HR's own, as it stands.
  const ap = await post('advance', await fx.advance({ person: p, date: '2027-01-17', rupees: 150000, paidVia: 'cash', by: h.users.appr2.id }), ACCT);
  assert.equal(ap.result, 'posted', JSON.stringify(ap));
  assert.equal((await voucherRow(ap.voucher_id)).approved_by_id, h.users.appr2.id);
  const op = await post('advance', await fx.advance({ person: p, date: '2027-01-18', rupees: 150000, paidVia: 'cash', by: h.users.viewer.id }), MD);
  assert.equal(op.result, 'submitted', JSON.stringify(op));
  // A loan and a prepayment, the same: their doer's approval (hr.loans.created_by, hr.loan_txns.created_by).
  const loan = await fx.loan({ person: p, loanNo: 'CI-LN-0501', date: '2027-01-19', rupees: 120000, paidVia: 'cash', by: MD.id });
  const lent = await post('loan', loan.id, ACCT);
  assert.deepEqual([lent.result, (await voucherRow(lent.voucher_id)).approved_by_id], ['posted', MD.id]);
  const prepay = await fx.prepay({ loan: loan.id, date: '2027-01-29', rupees: 500, paidVia: 'cash', by: h.users.appr2.id });
  const back = await post('prepay', prepay, ACCT);
  assert.equal(back.result, 'posted', JSON.stringify(back));
  assert.deepEqual((await postRow(back.voucher_id)).approved_in_hr_by, { id: h.users.appr2.id, name: 'Test Second Approver' },
    'a receipt needs no Approver, and still records the approval HR gave');
});

test('a batch whose lines md approved posts with approved_by = md though it is over ₹1,00,000', gate, async () => {
  const run = await fx.run('2027-01');
  const lines = [];
  for (const name of ['Test Bank Person 1', 'Test Bank Person 2', 'Test Bank Person 3']) {
    lines.push({ person: await fx.person({ name, channel: 'COLOUR' }), rupees: 60000, approvedBy: MD.id });
  }
  const batch = await fx.batch({ run, channel: 'COLOUR', batchNo: 'CI-PAY-0003', paidOn: '2027-02-07', lines, by: ACCT.id });
  const out = await post('batch', batch.id);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.status, v.approved_by_id, v.approved_by, v.self_approved, v.created_by_id], ['posted', MD.id, 'Test MD', false, ACCT.id]);
  assert.equal(v.narration, 'Salary Jan · colour bank · CI-PAY-0003 · 3 people');
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', 180000 * R, 0], ['Bank – current', 0, 180000 * R]]);

  // One line with no approver of its own (paid before per-person approval existed): the batch has no HR approval, and waits, though
  // the latest approval of its lines is md's.
  const older = [];
  for (const [i, approvedBy] of [null, MD.id].entries()) {
    older.push({ person: await fx.person({ name: `Test Bank Person ${i + 4}`, channel: 'COLOUR' }), rupees: 70000, approvedBy });
  }
  const waits = await post('batch', (await fx.batch({ run, channel: 'COLOUR', batchNo: 'CI-PAY-0004', paidOn: '2027-02-07', lines: older, by: ACCT.id })).id);
  assert.equal(waits.result, 'submitted', JSON.stringify(waits));
});

test('with Jan 2027 locked the event becomes an exception and the HR rows are unchanged (Review Focus 4)', gate, async () => {
  const p = await fx.person({ name: 'Test Person Locked' });
  const adv = await fx.advance({ person: p, date: '2027-01-20', rupees: 4000, paidVia: 'cash', by: ACCT.id });
  await moveMonth('closing');
  await moveMonth('locked');
  try {
    const hr = await hrState();
    const was = { vouchers: await count('fin_vouchers'), lines: await count('fin_voucher_lines'), audit: await count('fin_audit_log') };
    const out = await post('advance', adv);
    assert.deepEqual(out, { result: 'exception', reason_code: 'FIN_PERIOD_LOCKED' });
    const ex = await exceptionOf('hr_advance', adv);
    assert.deepEqual([ex.book_id, ex.reason_code, ex.resolved_at], [CI, 'FIN_PERIOD_LOCKED', null]);
    assert.equal(ex.reason, 'Jan 2027 is locked. Nothing more can be posted to it.');
    assert.equal(await hrState(), hr, 'HR is read, never written');
    assert.deepEqual({ vouchers: await count('fin_vouchers'), lines: await count('fin_voucher_lines'), audit: await count('fin_audit_log') }, was,
      'the attempt rolled back whole: no draft, no line, no log row');
  } finally {
    await moveMonth('closing', 'Unlocked to take the HR entries');
    await moveMonth('open', 'Open again');
  }
  const posted = await post('advance', adv);
  assert.equal(posted.result, 'posted', JSON.stringify(posted));
  assert.equal((await exceptionOf('hr_advance', adv)).voucher_id, posted.voucher_id);
  assert.equal((await vouchersOf('hr_advance', adv)).length, 1, 'retrying after the fix posts exactly once');
});

test('reversing an hr_ voucher by hand is refused FIN_HR_OWNED (Review Focus 5)', gate, async () => {
  const p = await fx.person({ name: 'Test Person Reversed' });
  const adv = await fx.advance({ person: p, date: '2027-01-16', rupees: 2200, paidVia: 'cash', by: ACCT.id });
  const { voucher_id: id } = await post('advance', adv);
  for (const who of ['md', 'acct']) {
    const r = refused(await h.call('POST', `/finance/vouchers/${id}/reverse`, { reason: 'Typed by mistake', date: '2027-01-31' }, who), 409, 'FIN_HR_OWNED');
    assert.equal(r.body.error, 'This entry comes from HR; correct it there.');
  }
  assert.equal(await count(`fin_vouchers WHERE reversal_of_id = ${Number(id)}`), 0, 'no reversal was made, not even a draft');
  assert.equal((await ok(h.call('GET', `/finance/vouchers/${id}`, null, 'md'))).can.reverse, false, 'and none is offered');

  // The HR feed reverses it from HR (fromHr), as an HR correction will (Task 11).
  const mdActor = { id: MD.id, name: 'Test MD', roles: ['approver', 'admin'] };
  const reversal = await h.db.tx((qc, oc) => vouchers.finReverseVoucher(qc, oc, id, mdActor,
    { date: '2027-01-31', reason: 'Corrected in HR', fromHr: true }));
  assert.equal(reversal.status, 'posted');
  // That reversal is HR's too: undoing it by hand would put the HR entry back beside its correction.
  refused(await h.call('POST', `/finance/vouchers/${reversal.id}/reverse`, { reason: 'Undo', date: '2027-01-31' }, 'md'), 409, 'FIN_HR_OWNED');
  assert.equal((await ok(h.call('GET', `/finance/vouchers/${reversal.id}`, null, 'md'))).can.reverse, false);
  // Why a reversal by hand is refused: once reversed, the event has no live voucher, and the next post of it posts it again.
  const again = await post('advance', adv);
  assert.equal(again.result, 'posted', JSON.stringify(again));
  assert.notEqual(again.voucher_id, id);
  // An ordinary voucher is reversed by hand as before.
  const typed = await ok(h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'payment', voucher_date: '2027-01-16', narration: 'Test office tea',
    lines: [{ ledger_id: L['Advance Waivers'], debit_paise: 100 * R }, { ledger_id: L['Office cash'], credit_paise: 100 * R }] }, 'md'));
  await ok(h.call('POST', `/finance/vouchers/${typed.voucher.id}/submit`, null, 'md'));
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${typed.voucher.id}/reverse`, { reason: 'Test', date: '2027-01-31' }, 'md'))).voucher.status, 'posted');
});

// ── The other events of this part, and the rulings beside them ──────────────────────────────

test('an HR entry an Approver sends back is never edited by hand: it is sent again as it is, or discarded (FIN_HR_OWNED)', gate, async () => {
  const p = await fx.person({ name: 'Test Person Sent Back' });
  const adv = await fx.advance({ person: p, date: '2027-01-21', rupees: 120000, paidVia: 'cash', by: ACCT.id });
  const { voucher_id: id, result } = await post('advance', adv);
  assert.equal(result, 'submitted');
  await ok(h.call('POST', `/finance/vouchers/${id}/reject`, { reason: 'Check the amount in HR' }, 'md'));
  const sentBack = await ok(h.call('GET', `/finance/vouchers/${id}`, null, 'acct'));
  assert.deepEqual([sentBack.voucher.status, sentBack.can.edit, sentBack.can.submit, sentBack.can.discard], ['draft', false, true, true]);
  const lines = await linesOf(id);
  const r = refused(await h.call('PUT', `/finance/vouchers/${id}`, {
    narration: 'Typed over', lines: [{ ledger_id: L['Advance Waivers'], debit_paise: 100 }, { ledger_id: L['Office cash'], credit_paise: 100 }] }, 'acct'),
  409, 'FIN_HR_OWNED');
  assert.equal(r.body.error, 'This entry comes from HR; correct it there.');
  assert.deepEqual([(await voucherRow(id)).narration, await linesOf(id)], ['Advance · Pay staff · 1 person', lines], 'nothing changed');
  // Sent again as it is, it waits for an Approver again, the HR event's one voucher.
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'acct'))).voucher.status, 'submitted');
  assert.deepEqual(await post('advance', adv), { result: 'submitted', voucher_id: id, already: true });
});

test('an advance sheet posts one payment: Dr Staff Advances and Dr Staff Loans, Cr the account, narrated "Advances · sheet CI-ADV-0001 · 4 people", approved by its decider', gate, async () => {
  const lines = [];
  for (const [i, rupees] of [30000, 40000, 35000].entries()) {
    lines.push({ person: await fx.person({ name: `Test Sheet Person ${i + 1}` }), rupees, decidedBy: MD.id });
  }
  lines.push({ person: await fx.person({ name: 'Test Sheet Person 4' }), rupees: 25000, loanNo: 'CI-LN-0101', decidedBy: MD.id });
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0001', month: '2027-01', paidOn: '2027-01-24', paidVia: 'cash', lines, by: ACCT.id });
  const round = await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });   // every line, in one round
  // Ruling R23: the event is the round, named by any of its line ids, and kept under the smallest.
  const out = await post('sheet', sheet.lineIds[2]);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.reference, v.source_type, v.source_id, v.approved_by_id, v.approved_by],
    ['payment', '2027-01-24', 'Advances · sheet CI-ADV-0001 · 4 people', 'CI-ADV-0001', 'hr_sheet', Math.min(...sheet.lineIds), MD.id, 'Test MD'],
    'over ₹1,00,000, and management approved every line in HR');
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 105000 * R, 0], ['Staff Loans', 25000 * R, 0], ['Office cash', 0, 130000 * R]]);
  // The advances and the loan the sheet became post with it, never on their own.
  assert.deepEqual(await post('advance', round.advances[0]), { result: 'skipped', reason_code: 'on_sheet' });
  assert.deepEqual(await post('loan', round.loans[0]), { result: 'skipped', reason_code: 'on_sheet' });
  // A line not posted yet posts nothing.
  const waiting = await fx.sheet({ sheetNo: 'CI-ADV-0002', month: '2027-01', paidOn: '2027-01-24',
    lines: [{ person: await fx.person({ name: 'Test Sheet Person 5' }), rupees: 1000, decidedBy: MD.id }], by: ACCT.id });
  assert.deepEqual(await post('sheet', waiting.lineIds[0]), { result: 'skipped', reason_code: 'not_posted' });
  assert.deepEqual(await post('sheet', 987654), { result: 'skipped', reason_code: 'not_found' });
});

test('R23: a sheet posted in two rounds gives two vouchers, each with its own round\'s count and total, both dated paid_on; a round posts once, whichever of its lines names it', gate, async () => {
  const people = [];
  for (let i = 1; i <= 5; i++) people.push(await fx.person({ name: `Test Round Person ${i}` }));
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0003', month: '2027-01', paidOn: '2027-01-26', paidVia: 'cash', by: ACCT.id, lines: [
    { person: people[0], rupees: 4000, decidedBy: MD.id }, { person: people[1], rupees: 5000, decidedBy: MD.id },
    { person: people[2], rupees: 6000 }, { person: people[3], rupees: 7000 }, { person: people[4], rupees: 8000, loanNo: 'CI-LN-0201' }] });
  const [one, two] = [sheet.lineIds.slice(0, 2), sheet.lineIds.slice(2)];
  await fx.postRound(sheet.id, one, { by: ACCT.id });                 // the lines approved so far
  await fx.decide(two, { by: MD.id });                               // the rest approved since…
  await fx.postRound(sheet.id, two, { by: ACCT.id });                // …and posted in a round of their own
  const stamps = await h.db.q('SELECT DISTINCT posted_at FROM hr.advance_sheet_lines WHERE sheet_id = $1', [sheet.id]);
  assert.equal(stamps.length, 2, 'two rounds: two posting moments');

  const first = await post('sheet', one[1]);
  const second = await post('sheet', two[2]);
  assert.deepEqual([first.result, second.result], ['posted', 'posted'], JSON.stringify([first, second]));
  assert.notEqual(first.voucher_id, second.voucher_id);
  const v1 = await voucherRow(first.voucher_id);
  const v2 = await voucherRow(second.voucher_id);
  assert.deepEqual([v1.source_type, v1.source_id, v1.voucher_date, v1.narration, v1.reference],
    ['hr_sheet', Math.min(...one), '2027-01-26', 'Advances · sheet CI-ADV-0003 · 2 people', 'CI-ADV-0003']);
  assert.deepEqual(await linesOf(v1.id), [['Staff Advances', 9000 * R, 0], ['Office cash', 0, 9000 * R]]);
  assert.deepEqual([v2.source_type, v2.source_id, v2.voucher_date, v2.narration, v2.reference],
    ['hr_sheet', Math.min(...two), '2027-01-26', 'Advances · sheet CI-ADV-0003 · 3 people', 'CI-ADV-0003']);
  assert.deepEqual(await linesOf(v2.id), [['Staff Advances', 13000 * R, 0], ['Staff Loans', 8000 * R, 0], ['Office cash', 0, 21000 * R]]);

  // A round's event posted again, by any of its lines, finds its one voucher (H8).
  for (const [lineId, voucherId] of [[one[0], v1.id], [one[1], v1.id], [two[0], v2.id], [two[1], v2.id], [two[2], v2.id]]) {
    assert.deepEqual(await post('sheet', lineId), { result: 'posted', voucher_id: voucherId, already: true }, `line ${lineId}`);
  }
  assert.equal((await vouchersOf('hr_sheet', Math.min(...one))).length, 1);
  assert.equal((await vouchersOf('hr_sheet', Math.min(...two))).length, 1);
  for (const lineId of [...one, ...two]) {
    if (lineId !== Math.min(...one) && lineId !== Math.min(...two)) assert.equal((await vouchersOf('hr_sheet', lineId)).length, 0);
  }
  // Worked out from any line of a round, it is the round's voucher.
  const built = await h.db.tx(qc => feed.finHrVoucherFor(qc, { type: 'sheet', id: two[1] }, ACCT));
  assert.deepEqual([built.source_type, built.source_id, built.narration], ['hr_sheet', Math.min(...two), 'Advances · sheet CI-ADV-0003 · 3 people']);
});

test('R21: a hidden person\'s advance, loan, prepayment and waiver are skipped as hidden, with nothing written to Finance; a sheet round leaves their lines out, and an event left with nobody is skipped as hidden', gate, async () => {
  const hidden = await fx.person({ name: 'Test Hidden Person Three' });
  const alsoHidden = await fx.person({ name: 'Test Hidden Person Four' });
  await fx.hide(hidden, { user: h.users.viewer.id, mode: 'all' });
  await fx.hide(alsoHidden, { user: h.users.acct.id, mode: 'pay' });
  const written = async () => ({
    vouchers: await count('fin_vouchers'), lines: await count('fin_voucher_lines'), audit: await count('fin_audit_log'),
    exceptions: await count('fin_hr_exceptions'), bells: await count('notifications'),
  });
  const was = await written();
  const skipped = { result: 'skipped', reason_code: 'hidden' };
  const adv = await fx.advance({ person: hidden, date: '2027-01-22', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  assert.deepEqual(await post('advance', adv), skipped, 'an advance');
  const loan = await fx.loan({ person: hidden, loanNo: 'CI-LN-0301', date: '2027-01-22', rupees: 30000, paidVia: 'cash', by: ACCT.id });
  assert.deepEqual(await post('loan', loan.id), skipped, 'a loan');
  const prepay = await fx.prepay({ loan: loan.id, date: '2027-01-28', rupees: 3000, paidVia: 'cash', by: ACCT.id });
  assert.deepEqual(await post('prepay', prepay), skipped, 'a prepayment');
  assert.deepEqual(await post('waiver', await fx.waiver({ person: alsoHidden, date: '2027-01-28', rupees: 500, by: MD.id }), MD), skipped, 'a waiver');
  const run = await fx.run('2027-01');
  const batch = await fx.batch({ run, channel: 'CASH', batchNo: 'CI-PAY-0009', paidOn: '2027-02-11', by: MD.id,
    lines: [{ person: hidden, rupees: 9000, approvedBy: MD.id }, { person: alsoHidden, rupees: 9500, approvedBy: MD.id }] });
  assert.deepEqual(await post('batch', batch.id, MD), skipped, 'a batch of hidden people only');
  const shown = [await fx.person({ name: 'Test Round Shown 1' }), await fx.person({ name: 'Test Round Shown 2' })];
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0004', month: '2027-01', paidOn: '2027-01-27', by: ACCT.id, lines: [
    { person: hidden, rupees: 2000, decidedBy: MD.id }, { person: shown[0], rupees: 2500, decidedBy: MD.id },
    { person: shown[1], rupees: 3500, decidedBy: MD.id }, { person: alsoHidden, rupees: 1500, decidedBy: MD.id }] });
  await fx.postRound(sheet.id, [sheet.lineIds[3]], { by: MD.id });
  assert.deepEqual(await post('sheet', sheet.lineIds[3], MD), skipped, 'a sheet round of a hidden person only');
  assert.deepEqual(await written(), was, 'nothing of theirs reached Finance: no voucher, line, log row, exception or bell');

  // A round with a hidden line posts the others, and counts only them.
  await fx.postRound(sheet.id, sheet.lineIds.slice(0, 3), { by: MD.id });
  const out = await post('sheet', sheet.lineIds[1], MD);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.source_id, v.narration], [sheet.lineIds[0], 'Advances · sheet CI-ADV-0004 · 2 people']);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 6000 * R, 0], ['Office cash', 0, 6000 * R]]);
});

test('R22: an event posted again while its HR voucher is sent back discards that draft, audited, and makes one new voucher from HR as it is now', gate, async () => {
  const p = await fx.person({ name: 'Test Person Sent Back Two' });
  const adv = await fx.advance({ person: p, date: '2027-01-23', rupees: 110000, paidVia: 'cash', by: ACCT.id });
  const first = await post('advance', adv);
  assert.equal(first.result, 'submitted', JSON.stringify(first));
  await ok(h.call('POST', `/finance/vouchers/${first.voucher_id}/reject`, { reason: 'Check it in HR' }, 'md'));
  // Posted again, by md this time: the draft is the accountant's, and gives way all the same. The advance is the accountant's doing in
  // HR, so it is not approved in HR (ruling R26): the new voucher goes through the book's rules with md as its actor, and waits.
  const again = await post('advance', adv, MD);
  assert.equal(again.result, 'submitted', JSON.stringify(again));
  assert.notEqual(again.voucher_id, first.voucher_id);
  assert.deepEqual((await vouchersOf('hr_advance', adv)).map(v => [v.id, v.status]),
    [[first.voucher_id, 'discarded'], [again.voucher_id, 'submitted']], 'one HR voucher stands for the event, the sent-back draft discarded');
  const trail = await h.db.q(`SELECT action, user_id, user_name FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`,
    [first.voucher_id]);
  assert.deepEqual(trail.map(a => a.action), ['create', 'submit', 'reject', 'discard']);
  assert.deepEqual([trail[3].user_id, trail[3].user_name], [MD.id, 'Test MD (HR)']);
  const v = await voucherRow(again.voucher_id);
  assert.deepEqual([v.narration, v.created_by, v.approved_by_id], ['Advance · Pay staff · 1 person', 'Test MD (HR)', null]);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 110000 * R, 0], ['Office cash', 0, 110000 * R]]);
  assert.deepEqual(await post('advance', adv), { result: 'submitted', voucher_id: again.voucher_id, already: true });
});

test('R25: a round is booked from the rows it made: edited afterwards (the sheet\'s paid_on and paid_via, a line\'s amount), it still books what was paid; a sheet-made loan or advance whose line is gone is skipped on_sheet', gate, async () => {
  const people = [];
  for (const name of ['Test Paid Person A', 'Test Paid Person B', 'Test Paid Person C', 'Test Paid Person D']) people.push(await fx.person({ name }));
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0005', month: '2027-01', paidOn: '2027-01-25', paidVia: 'cash', by: ACCT.id, lines: [
    { person: people[0], rupees: 10000, decidedBy: MD.id }, { person: people[1], rupees: 12000, decidedBy: MD.id },
    { person: people[2], rupees: 15000, loanNo: 'CI-LN-0401', decidedBy: MD.id }, { person: people[3], rupees: 5000 }] });
  const [lineA, lineB, lineC] = sheet.lineIds;
  // One round of the three approved lines: the advances and the loan are made, dated 2027-01-25 and paid from cash (the loan keeps
  // that on hr.loans, as HR writes it). The fourth line is pending, so the sheet stays submitted, which is all a send-back needs.
  const round = await fx.postRound(sheet.id, [lineA, lineB, lineC], { by: ACCT.id });
  await fx.sendBack(sheet.id);
  await fx.editSheet(sheet.id, { paidOn: '2027-01-29', paidVia: 'COLOUR' });
  await fx.rewriteLine(lineB, { rupees: 99999 });
  // Booked now (a retry after an exception, or Task 13's catch-up): what HR paid, from the round's own rows.
  const out = await post('sheet', lineB);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_date, v.narration, v.reference, v.source_id], ['2027-01-25', 'Advances · sheet CI-ADV-0005 · 3 people', 'CI-ADV-0005', lineA],
    'dated as HR paid it, not as the sheet now says');
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 22000 * R, 0], ['Staff Loans', 15000 * R, 0], ['Office cash', 0, 37000 * R]],
    'the amounts paid (not the line rewritten to ₹99,999), from the account paid (not the COLOUR bank the sheet now names)');
  // HR then drops the lines of an advance and of the loan: neither is linked from the sheet any more, and neither posts on its own,
  // as HR's own trail says they came from a sheet (via 'advance_sheet'). The round is still its one voucher.
  await fx.dropLine(lineB);
  await fx.dropLine(lineC);
  assert.deepEqual(await post('advance', round.advances[1]), { result: 'skipped', reason_code: 'on_sheet' });
  assert.deepEqual(await post('loan', round.loans[0]), { result: 'skipped', reason_code: 'on_sheet' });
  assert.deepEqual(await post('sheet', lineA), { result: 'posted', voucher_id: v.id, already: true });
});

test('R48: a round follows the loans it made: one HR cancels since takes the round out and posts it again without it, dated and paid as the round was; the sheet edited since posts nothing again; a round of nothing but that loan is taken out', gate, async () => {
  const [a, b, c] = [await fx.person({ name: 'Test Cancel Round A' }), await fx.person({ name: 'Test Cancel Round B' }),
    await fx.person({ name: 'Test Cancel Round C' })];
  // A round of an advance (its row keeps no account, as HR's older posts wrote it) and a loan (hr.loans keeps the sheet's cash).
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0048', month: '2027-01', paidOn: '2027-01-21', paidVia: 'cash', by: ACCT.id, lines: [
    { person: a, rupees: 3000, decidedBy: MD.id }, { person: b, rupees: 8000, loanNo: 'CI-LN-4801', decidedBy: MD.id }] });
  const round = await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });
  const [anchor, loanLine] = sheet.lineIds;
  const first = await post('sheet', loanLine, MD);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  assert.deepEqual(await linesOf(first.voucher_id), [['Staff Advances', 3000 * R, 0], ['Staff Loans', 8000 * R, 0], ['Office cash', 0, 11000 * R]]);
  // The sheet sent back and set to pay from another account since: the rows the round made are as they were, so it stands (R25).
  await fx.sendBack(sheet.id);
  await fx.editSheet(sheet.id, { paidOn: '2027-01-29', paidVia: 'COLOUR' });
  assert.deepEqual(await post('sheet', anchor, MD), { result: 'posted', voucher_id: first.voucher_id, already: true });

  // HR cancels the loan. The round's payment is reversed (the MD is an HR approver: at once), and the round posted again with the
  // advance alone, dated and paid as the round was: from cash, which the cancelled loan keeps, not the COLOUR bank the sheet names now.
  await fx.cancelLoan(round.loans[0], { date: '2027-01-28' });
  const again = await post('sheet', loanLine, MD);
  assert.equal(again.result, 'posted', JSON.stringify(again));
  assert.equal(again.reversal?.result, 'posted', JSON.stringify(again));
  assert.notEqual(again.voucher_id, first.voucher_id);
  assert.ok((await voucherRow(first.voucher_id)).reversed_by_id, 'the first payment is reversed');
  const v = await voucherRow(again.voucher_id);
  assert.deepEqual([v.voucher_date, v.narration, v.source_type, v.source_id], ['2027-01-21', 'Advances · sheet CI-ADV-0048 · 1 person', 'hr_sheet', anchor]);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 3000 * R, 0], ['Office cash', 0, 3000 * R]]);
  assert.deepEqual(await h.db.q('SELECT source_type, source_id FROM fin_hr_covers WHERE voucher_id = $1', [v.id]),
    [{ source_type: 'hr_advance', source_id: round.advances[0] }], 'it books the advance alone');
  assert.deepEqual(await post('sheet', anchor, MD), { result: 'posted', voucher_id: v.id, already: true }, 'posted again, it stands');
  assert.deepEqual(await post('loan', round.loans[0], MD), { result: 'skipped', reason_code: 'cancelled' }, 'the loan never posts on its own');

  // A round that made nothing but a loan: the loan cancelled, the round is taken out, and nothing is posted in its place.
  const only = await fx.sheet({ sheetNo: 'CI-ADV-0049', month: '2027-01', paidOn: '2027-01-22', paidVia: 'cash', by: ACCT.id, lines: [
    { person: c, rupees: 6000, loanNo: 'CI-LN-4901', decidedBy: MD.id }] });
  const made = await fx.postRound(only.id, only.lineIds, { by: ACCT.id });
  const lone = await post('sheet', only.lineIds[0], MD);
  assert.equal(lone.result, 'posted', JSON.stringify(lone));
  await fx.cancelLoan(made.loans[0], { date: '2027-01-28' });
  const gone = await post('sheet', only.lineIds[0], MD);
  assert.deepEqual([gone.result, gone.reason_code, gone.reversal?.result], ['skipped', 'nothing_paid', 'posted'], JSON.stringify(gone));
  assert.ok((await voucherRow(lone.voucher_id)).reversed_by_id, 'its payment is reversed');
  assert.deepEqual((await vouchersOf('hr_sheet', only.lineIds[0])).filter(x => x.status === 'posted' && x.reversed_by_id == null), []);
});

test('R28: a round\'s exception is kept under its anchor, whichever of its lines named it, and the round\'s posting closes every exception of its lines', gate, async () => {
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('LATE', 'Late bank', 'bank')`);
  const lines = [];
  for (const name of ['Test Late Person 1', 'Test Late Person 2', 'Test Late Person 3']) {
    lines.push({ person: await fx.person({ name }), rupees: 2000, decidedBy: MD.id });
  }
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0006', month: '2027-01', paidOn: '2027-01-26', paidVia: 'LATE', lines, by: ACCT.id });
  await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });
  const [anchor, second, third] = sheet.lineIds;
  const kept = async () => (await h.db.q(`SELECT source_id, reason_code FROM fin_hr_exceptions WHERE source_type = 'hr_sheet'
    AND source_id = ANY($1::int[]) ORDER BY source_id`, [sheet.lineIds])).map(x => [x.source_id, x.reason_code]);
  // Named by its last line, by a post with nobody to blame (a bug in the caller): the round's exception, kept under its anchor.
  assert.deepEqual(await post('sheet', third, { id: null, name: '' }), { result: 'exception', reason_code: 'FIN_SERVER_ERROR' });
  assert.deepEqual(await kept(), [[anchor, 'FIN_SERVER_ERROR']]);
  // Named by another line, the channel unmapped: still the one exception, saying why now.
  assert.deepEqual(await post('sheet', second), { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL' });
  assert.deepEqual(await kept(), [[anchor, 'FIN_UNMAPPED_CHANNEL']]);
  // One kept under another line of the round (as an exception is when its round could not be read at all): the round's posting
  // closes it with the anchor's.
  await h.db.q(`INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason)
                VALUES ('hr_sheet', $1, $2, 'FIN_SERVER_ERROR', 'Kept under a line of the round')`, [third, CI]);
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'LATE', ledger_id: L['Bank – spare'] }] });
  const posted = await post('sheet', second);
  assert.equal(posted.result, 'posted', JSON.stringify(posted));
  for (const lineId of [anchor, third]) {
    const closed = await exceptionOf('hr_sheet', lineId);
    assert.ok(closed.resolved_at, `the exception under line ${lineId} is resolved`);
    assert.equal(closed.voucher_id, posted.voucher_id);
  }
});

test('a loan and a Loans & Advances advance post as their door says; an opening or cancelled loan posts nothing', gate, async () => {
  const x = await fx.person({ name: 'Test Person Loan' });
  const loan = await fx.loan({ person: x, loanNo: 'CI-LN-0005', date: '2027-01-08', rupees: 45000, paidVia: 'COLOUR', by: ACCT.id });
  const lent = await post('loan', loan.id);
  assert.equal(lent.result, 'posted', JSON.stringify(lent));
  assert.equal((await voucherRow(lent.voucher_id)).narration, 'Loan · CI-LN-0005 · 1 person');
  assert.deepEqual(await linesOf(lent.voucher_id), [['Staff Loans', 45000 * R, 0], ['Bank – current', 0, 45000 * R]]);
  const given = await post('advance', await fx.advance({ person: x, date: '2027-01-09', rupees: 700, paidVia: 'cash', door: 'loans', by: ACCT.id }));
  assert.equal((await voucherRow(given.voucher_id)).narration, 'Advance · Loans & Advances · 1 person');
  const opening = await fx.loan({ person: x, loanNo: 'CI-LN-0006', date: '2027-01-02', rupees: 9000, opening: true, by: ACCT.id });
  assert.deepEqual(await post('loan', opening.id), { result: 'skipped', reason_code: 'opening_balance' });
  const cancelled = await fx.loan({ person: x, loanNo: 'CI-LN-0007', date: '2027-01-03', rupees: 8000, paidVia: 'cash', status: 'cancelled', by: ACCT.id });
  assert.deepEqual(await post('loan', cancelled.id), { result: 'skipped', reason_code: 'cancelled' });
  // An advance HR has taken back with a row that reverses it (reverses_id) stands no more: a later post of it posts nothing, and the
  // reversing row is no advance given. (HR's own reversal reverses the voucher, if one stood: Task 11.)
  const takenBack = await fx.advance({ person: x, date: '2027-01-09', rupees: 650, paidVia: 'cash', by: ACCT.id });
  const reversing = (await h.db.one(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id)
    VALUES ($1, '2027-01-10', 'recovered', 650, 'manual', $2) RETURNING id`, [x, takenBack])).id;
  assert.deepEqual(await post('advance', takenBack), { result: 'skipped', reason_code: 'reversed' });
  assert.deepEqual(await post('advance', reversing), { result: 'skipped', reason_code: 'not_this_event' });
  // A row that is not the event asked for posts nothing either.
  assert.deepEqual(await post('prepay', loan.txnId), { result: 'skipped', reason_code: 'not_this_event' }, 'a disbursal is no prepayment');
  assert.deepEqual(await post('advance', 987654), { result: 'skipped', reason_code: 'not_found' });
  assert.deepEqual(await post('payroll', 1), { result: 'skipped', reason_code: 'unknown_event' });
});

test('a line paid without a batch posts "Salary Jan · cash · 1 person"; a hidden person\'s line is skipped, and a batch leaves hidden people out', gate, async () => {
  const run = await fx.run('2027-01');
  const p = await fx.person({ name: 'Test Line Person' });
  const line = await fx.line({ run, person: p, rupees: 12000, paidOn: '2027-02-08', paidFrom: `fin:${L['Holder A Cash']}`, approvedBy: MD.id,
    reference: 'Handed to Test Line Person' });
  const out = await post('line', line);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_date, v.narration, v.reference, v.source_type], ['2027-02-08', 'Salary Jan · cash · 1 person', null, 'hr_line_pay']);
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', 12000 * R, 0], ['Holder A Cash', 0, 12000 * R]]);

  // Hidden from any login (Task 11 posts them, combined): left out of a line and of a batch, with no exception.
  const q = await fx.person({ name: 'Test Hidden Person' });
  await fx.hide(q, { user: h.users.acct.id, mode: 'pay' });
  const hiddenLine = await fx.line({ run, person: q, rupees: 9000, paidOn: '2027-02-08', approvedBy: MD.id });
  assert.deepEqual(await post('line', hiddenLine), { result: 'skipped', reason_code: 'hidden' });
  assert.equal(await exceptionOf('hr_line_pay', hiddenLine), null);
  const s3 = await fx.person({ name: 'Test Hidden Person Two' });
  await fx.hide(s3, { user: h.users.viewer.id, mode: 'all' });
  const shown = [await fx.person({ name: 'Test Shown Person 1' }), await fx.person({ name: 'Test Shown Person 2' })];
  const batch = await fx.batch({ run, channel: 'CASH', batchNo: 'CI-PAY-0005', paidOn: '2027-02-09', by: ACCT.id, lines: [
    { person: shown[0], rupees: 5000, approvedBy: MD.id }, { person: shown[1], rupees: 6000, approvedBy: MD.id }, { person: s3, rupees: 7000, approvedBy: MD.id }] });
  const paid = await post('batch', batch.id);
  assert.equal((await voucherRow(paid.voucher_id)).narration, 'Salary Jan · cash · CI-PAY-0005 · 2 people');
  assert.deepEqual(await linesOf(paid.voucher_id), [['Salary Payable', 11000 * R, 0], ['Office cash', 0, 11000 * R]]);
  // A line paid in a batch posts with its batch; a line not paid posts nothing.
  assert.deepEqual(await post('line', batch.lineIds[0]), { result: 'skipped', reason_code: 'in_batch' });
  const unpaid = await fx.line({ run, person: await fx.person({ name: 'Test Unpaid Person' }), rupees: 4000, status: 'pending' });
  assert.deepEqual(await post('line', unpaid), { result: 'skipped', reason_code: 'not_paid' });
  // A batch whose line failed since posts the lines still paid.
  const failed = await fx.batch({ run, channel: 'CASH', batchNo: 'CI-PAY-0006', paidOn: '2027-02-09', by: ACCT.id, lines: [
    { person: await fx.person({ name: 'Test Paid Person' }), rupees: 3000, approvedBy: MD.id },
    { person: await fx.person({ name: 'Test Failed Person' }), rupees: 3500, approvedBy: MD.id, paid: false }] });
  const rest = await post('batch', failed.id);
  assert.equal((await voucherRow(rest.voucher_id)).narration, 'Salary Jan · cash · CI-PAY-0006 · 1 person');
  assert.deepEqual(await linesOf(rest.voucher_id), [['Salary Payable', 3000 * R, 0], ['Office cash', 0, 3000 * R]]);
});

test('a waiver posts a journal Dr the waiver ledger / Cr Staff Advances, approved by its approver; with no waiver ledger set it is an exception FIN_ROLE_MISSING', gate, async () => {
  const p = await fx.person({ name: 'Test Person Waived' });
  const waiver = await fx.waiver({ person: p, date: '2027-01-27', rupees: 1200, by: MD.id });
  assert.deepEqual(await post('waiver', waiver), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
  assert.equal((await exceptionOf('hr_waiver', waiver)).reason, 'Set this ledger in Finance Setup → HR & payroll first.');
  await saveSetup({ book_id: CI, roles: { advance_waiver: L['Advance Waivers'] } });
  const out = await post('waiver', waiver);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.source_type, v.approved_by_id, v.approved_by],
    ['journal', '2027-01-27', 'Advance waived · 1 person', 'hr_waiver', MD.id, 'Test MD'], 'a journal always needs an Approver: the waiver\'s own');
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });
  assert.deepEqual(await linesOf(v.id), [['Advance Waivers', 1200 * R, 0], ['Staff Advances', 0, 1200 * R]]);
  assert.ok((await exceptionOf('hr_waiver', waiver)).resolved_at);
});

test('money that left another company\'s account posts as the inter-company pair (rulings R18, R24), which needs each book\'s inter-company ledger: without it, an exception FIN_ROLE_MISSING; a Darbi batch from Darbi\'s bank posts in DP as hr_batch:DP', gate, async () => {
  // The pair itself is finance-pg-hr-payroll.test.js's (Task 11). This file sets no `intercompany` role, so every pair waits for it.
  const colour = await fx.person({ name: 'Test Colour Person' });
  const adv = await fx.advance({ person: colour, date: '2027-01-18', rupees: 6000, paidVia: 'DARBI', by: ACCT.id });
  const was = await count('fin_vouchers');
  assert.deepEqual(await post('advance', adv), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
  const ex = await exceptionOf('hr_advance', adv);
  assert.deepEqual([ex.book_id, ex.reason], [CI, 'Set this ledger in Finance Setup → HR & payroll first.']);
  const darbi = await fx.person({ name: 'Test Darbi Person', firm: 'DARBI', channel: 'DARBI' });
  assert.deepEqual(await post('advance', await fx.advance({ person: darbi, date: '2027-01-18', rupees: 500, paidVia: 'cash', by: ACCT.id })),
    { result: 'exception', reason_code: 'FIN_ROLE_MISSING' }, 'a Darbi person paid from Colour\'s cash');
  assert.equal(await count('fin_vouchers'), was, 'in neither book');

  const run = await fx.run('2027-01');
  const batch = await fx.batch({ run, channel: 'DARBI', batchNo: 'CI-PAY-0007', paidOn: '2027-02-10', by: ACCT.id,
    lines: [{ person: darbi, rupees: 15000, approvedBy: MD.id }] });
  const out = await post('batch', batch.id);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  const v = await voucherRow(out.voucher_id);
  assert.deepEqual([v.book_id, v.source_type, v.source_id, v.narration], [DP, 'hr_batch:DP', batch.id, 'Salary Jan · darbi bank · CI-PAY-0007 · 1 person']);
  assert.match(v.number, /^DP-PV-2627-\d{4}$/);
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', 15000 * R, 0], ['DP Bank', 0, 15000 * R]]);
  assert.equal((await linesOf(v.id)).length, 2);
  assert.deepEqual(await post('batch', batch.id), { result: 'posted', voucher_id: v.id, already: true });
  // A batch of people of both firms, from one bank: one of its groups is always paid from another company's account.
  const mixed = await fx.batch({ run, channel: 'DARBI', batchNo: 'CI-PAY-0008', paidOn: '2027-02-10', by: ACCT.id, lines: [
    { person: await fx.person({ name: 'Test Darbi Person Two', firm: 'DARBI', channel: 'DARBI' }), rupees: 4000, approvedBy: MD.id },
    { person: await fx.person({ name: 'Test Colour Person Two', channel: 'DARBI' }), rupees: 4500, approvedBy: MD.id }] });
  assert.deepEqual(await post('batch', mixed.id), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
});

test('finHrAfter runs each event in turn after HR\'s commit, swallows everything and logs the code only', gate, async () => {
  const p = await fx.person({ name: 'Test After Person' });
  const good = await fx.advance({ person: p, date: '2027-01-19', rupees: 800, paidVia: 'cash', by: ACCT.id });
  const lost = await fx.advance({ person: p, date: '2027-01-19', rupees: 900, paidVia: 'NOWHERE', by: ACCT.id });
  const logged = [];
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  console.log = (...args) => logged.push(args.join(' '));
  let answers;
  try {
    const req = { user: { id: ACCT.id, name: 'Test Accountant' }, hr: { level: 'accounts' } };
    answers = [
      await feed.finHrAfter(req, [{ type: 'advance', id: good }, { type: 'nonsense', id: 'x' }, { type: 'advance', id: lost }]),
      await feed.finHrAfter(req, 'not a list'),
      await feed.finHrAfter(undefined, undefined),
    ];
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(answers, [undefined, undefined, undefined]);
  assert.equal((await vouchersOf('hr_advance', good)).length, 1, 'the first event posted');
  assert.equal((await exceptionOf('hr_advance', lost)).reason_code, 'FIN_UNMAPPED_CHANNEL', 'the third is an exception, the second ignored');
  // The second, an event the feed does not know, books nothing and leaves a trace (Task 10's M7: a wiring slip in an HR route).
  assert.deepEqual(logged, ['[finance-hr] unknown_event', '[finance-hr] FIN_UNMAPPED_CHANNEL'], 'the codes, and nothing of the events or their people');
});

// ── Last: over everything the feed posted above ──────────────────────────────────────────────

test('privacy: no hr.people name appears in any fin_vouchers narration, fin_voucher_lines narration, or fin_audit_log before/after written by the feed', gate, async () => {
  const people = await h.db.q('SELECT name, code FROM hr.people');
  assert.ok(people.length > 40, `non-vacuous: ${people.length} people`);
  const fed = await h.db.q(`SELECT id FROM fin_vouchers WHERE source_type LIKE 'hr\\_%'`);
  assert.ok(fed.length > 20, `non-vacuous: the feed posted ${fed.length} vouchers`);
  const texts = [
    ...(await h.db.q('SELECT narration, reference, created_by, submitted_by, approved_by, posted_by, source_type FROM fin_vouchers'))
      .flatMap(v => Object.values(v)),
    ...(await h.db.q('SELECT narration, bill_ref FROM fin_voucher_lines')).flatMap(l => Object.values(l)),
    ...(await h.db.q('SELECT user_name, reason, before::text AS before, after::text AS after FROM fin_audit_log')).flatMap(a => Object.values(a)),
    ...(await h.db.q('SELECT reason FROM fin_hr_exceptions')).map(x => x.reason),
    // …and the bells an HR entry rang when it waited for an Approver
    ...(await h.db.q(`SELECT title, body FROM notifications WHERE ref_table = 'fin_vouchers'`)).flatMap(n => Object.values(n)),
  ].filter(t => typeof t === 'string');
  assert.ok(texts.some(t => t.includes('(HR)')), 'non-vacuous: the HR entries\' own rows and bells are among them');
  assert.ok(texts.some(t => t.includes('people')), 'non-vacuous: the narrations count people');
  for (const { name, code } of people) {
    for (const word of [name, code]) {
      const found = texts.find(t => t.includes(word));
      assert.equal(found, undefined, `${word} reached Finance: ${found}`);
    }
  }
});
