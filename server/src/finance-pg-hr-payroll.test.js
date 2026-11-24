import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';
import { finHrFixtures } from './finance-hr-fixtures.js';
import { FIN_SENTENCES } from './finance-errors.js';

// The HR feed, part 2 (Cash & Bank spec §7.2–§7.8; plan Task 11; rulings R18, R21, R24, R27): the payroll month's journal, the advances
// on its sheet, HR's reversals (un-finalise, a failed line, a cancelled loan, an advance taken back), hidden people's combined entries,
// and the inter-company pair. Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-payroll.test.js
//
// One boot for the file; the tests share it and run in order. Runs: January 2027 (52 lines, the brief's), February 2027 (when_paid),
// March 2027 (people of both books, one with no firm) and December 2026, whose lines are paid in January 2027 (hidden people's payouts
// and the inter-company batches). The CASH channel pays from Office cash, COLOUR from Bank – current and DARBI from DP's bank. Every
// name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, feed, fx, CI, DP, ACCT, MD;
const L = {};    // CI ledger name -> id
const D = {};    // DP ledger name -> id
const GROUPS = {};

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
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
const byName = lines => [...lines].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]);
const sides = lines => lines.reduce((t, [, d, c]) => [t[0] + d, t[1] + c], [0, 0]);
// Every voucher a source has, whatever its status.
const vouchersOf = (sourceType, sourceId) => h.db.q(
  'SELECT id, status, reversed_by_id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 ORDER BY id', [sourceType, sourceId]);
// The voucher that stands for a source (H8): posted or waiting, not reversed.
const standing = async (sourceType, sourceId) => (await h.db.q(
  `SELECT id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 AND status IN ('submitted', 'posted') AND reversed_by_id IS NULL
      AND reversal_of_id IS NULL`, [sourceType, sourceId])).map(v => v.id);
const reversalOf = id => h.db.one('SELECT id, status, voucher_date, narration, approved_by_id, self_approved FROM fin_vouchers WHERE reversal_of_id = $1 ORDER BY id DESC LIMIT 1', [id]);
const exceptionOf = (sourceType, sourceId) => h.db.one(
  `SELECT id, source_type, source_id, book_id, reason_code, reason, resolved_at, voucher_id FROM fin_hr_exceptions WHERE source_type = $1 AND source_id = $2`,
  [sourceType, sourceId]);
const coversOf = async id => (await h.db.q('SELECT source_type, source_id FROM fin_hr_covers WHERE voucher_id = $1 ORDER BY source_type, source_id', [id]))
  .map(c => [c.source_type, c.source_id]);
const count = async table => (await h.db.one(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
const postRow = async id => (await h.db.one(`SELECT after FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 AND action = 'post'`, [id])).after;
const approve = id => ok(h.call('POST', `/finance/vouchers/${id}/approve`, null, 'md'));
const hidden = (asOf, who = MD) => feed.finHrPostHidden(who, { asOf });
const lineOf = (runId, person) => h.db.one('SELECT id FROM hr.run_lines WHERE run_id = $1 AND person_id = $2', [runId, person]).then(r => r.id);
const lineOfAll = async (runId, people) => Promise.all(people.map(p => lineOf(runId, p)));

// HR's rupee rounding, as the engine and the fixtures do it: half away from zero, in paise.
const toRupee = p => Math.sign(p) * Math.round(Math.abs(p) / 100) * 100;

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-payroll');
  feed = await import('./finance-hr-feed.js').catch(() => ({}));
  fx = finHrFixtures(h.db);
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const book of [CI, DP]) GROUPS[book] = (await ok(h.call('GET', `/finance/books/${book}/groups`, null, 'md'))).groups;
  ACCT = { id: h.users.acct.id, name: 'Test Accountant', hrLevel: 'accounts' };
  MD = { id: h.users.md.id, name: 'Test MD', hrLevel: 'admin' };

  await fx.channels();
  for (const [user, level] of [[h.users.md.id, 'admin'], [h.users.acct.id, 'accounts'], [h.users.appr2.id, 'approver'], [h.users.viewer.id, 'operator']]) {
    await fx.access(user, level);
  }
  await makeLedger(CI, 'Cash-in-Hand', 'Office cash');
  await makeLedger(CI, 'Bank Accounts', 'Bank – current');
  await makeLedger(CI, 'Indirect Expenses', 'Advance Waivers');
  await makeLedger(CI, 'Direct Expenses', 'Contract Labour');
  await makeLedger(CI, 'Direct Expenses', 'Pasting Wages');
  await makeLedger(CI, 'Indirect Incomes', 'Staff Deductions');
  await makeLedger(CI, 'Indirect Expenses', 'Rounding Off');
  await makeLedger(CI, 'Current Liabilities', 'Darbi Print Pack');
  await makeLedger(DP, 'Bank Accounts', 'DP Bank');
  await makeLedger(DP, 'Loans & Advances (Asset)', 'Colour Impressions');
  await makeLedger(DP, 'Indirect Incomes', 'DP Staff Deductions');
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
    expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour'] }, { hr_key: 'dept:Pasting', ledger_id: L['Pasting Wages'] }],
  });
  // DP has no ledger for other deductions yet: the March run's DARBI line has one (the brief's FIN_ROLE_MISSING test).
  await saveSetup({ book_id: DP, roles: { rounding: D['DP Rounding Off'], intercompany: D['Colour Impressions'] } });
});

after(async () => { await h?.close(); });

// ── The payroll month ────────────────────────────────────────────────────────────────────────

// January 2027: 52 people, invented pay. Two have no firm (they book to CI), six are contractors (one of them in Pasting), six more
// work in Pasting; two are hidden from the accounts login (ruling R21: the payroll journal still counts them). Six had an advance
// written on the month's payroll sheet, one of them a hidden person. Person 22's pay covers a sub-account's advance, and person 44's a
// sub-account's loan instalment (ADJ:SUB… components, which finalise posts to the sub-account's ledgers).
const JAN = { people: [], lines: [] };
let janRun, janJournal, janSheetAdvances;
const janLine = i => ({
  type: i % 10 === 0 || i === 49 ? 'contractor' : 'employee',
  dept: i % 7 === 0 ? 'Pasting' : i % 3 === 0 ? 'Printing' : null,
  firm: i === 5 || i === 17 ? null : 'COLOUR',
  gross: Math.round((8000 + i * 173.37) * 100) / 100,
  advanceRecovery: i % 4 === 0 ? 400 + i * 5 : 0,
  loanRecovery: i % 6 === 0 ? 1250 : 0,
  misc: i % 5 === 0 ? 75.5 : 0,
  adj: i % 11 === 0 ? 300 : 0,
  paidSeparately: i % 8 === 0 ? 1500 : 0,
  advanceGiven: i % 9 === 1 ? 1000 + i * 10 : 0,
  hidden: i === 3 || i === 19,
});
// What the journal books, worked out here from the same figures, in paise.
function janExpected() {
  const p = r => Math.round(r * 100);
  const want = { wages: 0, contract: 0, pasting: 0, advances: 300 * R, loans: 300 * R, deductions: -600 * R, md: 0, payable: 0, rounding: 0 };
  for (const l of JAN.lines) {
    const target = l.type === 'contractor' ? 'contract' : l.dept === 'Pasting' ? 'pasting' : 'wages';
    want[target] += p(l.gross);
    want.advances += p(l.advanceRecovery);
    want.loans += p(l.loanRecovery);
    want.deductions += p(l.misc) + p(l.adj);
    want.md += p(l.paidSeparately);
    const before = p(l.gross) - p(l.advanceRecovery) - p(l.loanRecovery) - p(l.misc) - p(l.adj) - p(l.paidSeparately);
    want.payable += toRupee(before);
    want.rounding += toRupee(before) - before;
  }
  return want;
}

test('finalise posts "Payroll Jan 2027 · 52 people" dated 2027-01-31; debits = credits; MD\'s Account is credited with Σ paid_separately; Salary Payable with Σ payable', gate, async () => {
  for (let i = 1; i <= 52; i++) {
    const l = janLine(i);
    const person = await fx.person({ name: `Test Payroll Person ${i}`, firm: l.firm, type: l.type, dept: l.dept });
    if (l.hidden) await fx.hide(person, { user: ACCT.id, mode: i === 3 ? 'all' : 'pay' });
    JAN.people.push(person);
    JAN.lines.push({ ...l, person });
  }
  JAN.lines[21].breakdown = [{ code: `ADJ:SUB${JAN.people[22]}-ADV`, label: 'Sub-account: advance its pay did not cover', kind: 'deduction', amount: '300.00' }];
  JAN.lines[43].breakdown = [{ code: `ADJ:SUB${JAN.people[44]}-LN77`, label: 'Sub-account: loan instalment its pay did not cover', kind: 'deduction', amount: '300.00' }];
  janRun = await fx.payroll({ month: '2027-01', approvedBy: MD.id, lines: JAN.lines });
  // Before finalise there is nothing to book.
  assert.deepEqual(await post('run', janRun.id), { result: 'skipped', reason_code: 'not_finalised' });
  await fx.finalise(janRun.id, { at: '2027-02-03T11:00:00+05:30', by: ACCT.id });

  const out = await post('run', janRun.id);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  janJournal = out.voucher_id;
  const v = await voucherRow(janJournal);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.reference, v.source_type, v.source_id, v.status],
    [CI, 'journal', '2027-01-31', 'Payroll Jan 2027 · 52 people', null, 'hr_run', janRun.id, 'posted']);
  // The accounts login finalised it, but md approved the month in HR: the journal posts in his name, and its post row says so (§7.6).
  assert.deepEqual([v.created_by, v.approved_by_id, v.approved_by, v.self_approved], ['Test Accountant (HR)', MD.id, 'Test MD', false]);
  assert.deepEqual((await postRow(v.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });

  const lines = await linesOf(v.id);
  const [debits, credits] = sides(lines);
  assert.equal(debits, credits, 'the journal balances to the paisa');
  const want = janExpected();
  assert.ok(want.rounding !== 0, 'non-vacuous: HR\'s rupee rounding leaves a remainder');
  const credit = name => lines.filter(l => l[0] === name).reduce((t, l) => t + l[2], 0);
  assert.equal(credit("MD's Account"), want.md, 'MD\'s Account: Σ paid_separately');
  assert.equal(credit('Salary Payable'), want.payable, 'Salary Payable: Σ payable');
  assert.deepEqual(byName(lines), byName([
    ['Salaries & Wages', want.wages, 0], ['Contract Labour', want.contract, 0], ['Pasting Wages', want.pasting, 0],
    want.rounding > 0 ? ['Rounding Off', want.rounding, 0] : ['Rounding Off', 0, -want.rounding],
    ['Staff Advances', 0, want.advances], ['Staff Loans', 0, want.loans], ['Staff Deductions', 0, want.deductions],
    ["MD's Account", 0, want.md], ['Salary Payable', 0, want.payable],
  ]));
  // finHrRunLines is that journal's lines, worked out without writing anything.
  const built = await h.db.tx(qc => feed.finHrRunLines(qc, janRun.id, CI));
  assert.deepEqual(byName(built.map(l => [Object.entries({ ...L }).find(([, id]) => id === l.ledger_id)[0], l.debit_paise, l.credit_paise])), byName(lines));
  assert.equal(await count(`fin_vouchers WHERE source_type = 'hr_run:DP'`), 0, 'nobody of DP: no DP journal');
  // Posted again: the same voucher, nothing written.
  const audit = await count('fin_audit_log');
  assert.deepEqual(await post('run', janRun.id), { result: 'posted', voucher_id: janJournal, already: true });
  assert.equal(await count('fin_audit_log'), audit);
});

test('a contractor mapped \'type:Contractor\' → Contract Labour has its gross there', gate, async () => {
  const lines = await linesOf(janJournal);
  const debit = name => lines.find(l => l[0] === name)?.[1];
  const p = r => Math.round(r * 100);
  const contractors = JAN.lines.filter(l => l.type === 'contractor');
  assert.equal(contractors.length, 6);
  assert.ok(contractors.some(l => l.dept === 'Pasting'), 'non-vacuous: a contractor of the Pasting department');
  assert.equal(debit('Contract Labour'), contractors.reduce((t, l) => t + p(l.gross), 0), 'the person type comes first, then the department');
  assert.equal(debit('Pasting Wages'), JAN.lines.filter(l => l.type !== 'contractor' && l.dept === 'Pasting').reduce((t, l) => t + p(l.gross), 0));
  assert.equal(debit('Salaries & Wages'), JAN.lines.filter(l => l.type !== 'contractor' && l.dept !== 'Pasting').reduce((t, l) => t + p(l.gross), 0),
    'the rest to the salary_expense role');
  // A sub-account's advance and loan instalment, covered by its main account's pay, are recoveries: Staff Advances and Staff Loans.
  const p300 = 300 * R;
  const credit = name => lines.find(l => l[0] === name)?.[2];
  assert.equal(credit('Staff Advances'), JAN.lines.reduce((t, l) => t + p(l.advanceRecovery), 0) + p300);
  assert.equal(credit('Staff Loans'), JAN.lines.reduce((t, l) => t + p(l.loanRecovery), 0) + p300);
});

test('R75: a hidden person alone in a mapped department books to salary_expense, never to that department\'s line; visible people keep their keys', gate, async () => {
  await makeLedger(CI, 'Direct Expenses', 'Binding Wages');
  await saveSetup({ book_id: CI, expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour'] }, { hr_key: 'dept:Pasting', ledger_id: L['Pasting Wages'] },
    { hr_key: 'dept:Binding', ledger_id: L['Binding Wages'] }] });
  // May 2027: one hidden person, alone in Binding, which has a ledger of its own; one hidden contractor; a visible contractor and a
  // visible person in Pasting.
  const binder = await fx.person({ name: 'Test Hidden Binder', dept: 'Binding' });
  const hiddenContractor = await fx.person({ name: 'Test Hidden Contractor', type: 'contractor' });
  const contractor = await fx.person({ name: 'Test Shown Contractor', type: 'contractor' });
  const paster = await fx.person({ name: 'Test Shown Paster', dept: 'Pasting' });
  for (const person of [binder, hiddenContractor]) await fx.hide(person, { user: ACCT.id });
  const run = await fx.payroll({ month: '2027-05', approvedBy: MD.id, lines: [
    { person: binder, gross: 13100 }, { person: hiddenContractor, gross: 9700 }, { person: contractor, gross: 8800 }, { person: paster, gross: 7600 }] });
  await fx.finalise(run.id, { at: '2027-06-03T10:00:00+05:30', by: MD.id });
  // What the month's journal posts (finHrVoucherFor builds it as finHrPost would, and writes nothing).
  const built = await h.db.tx(qc => feed.finHrVoucherFor(qc, { type: 'run', id: run.id }));
  const nameOf = id => Object.entries(L).find(([, l]) => l === id)?.[0];
  assert.deepEqual([built.voucher_type, built.voucher_date, built.narration], ['journal', '2027-05-31', 'Payroll May 2027 · 4 people']);
  assert.deepEqual(built.lines.filter(l => l.debit_paise > 0).map(l => [nameOf(l.ledger_id), l.debit_paise]).sort(), [
    ['Contract Labour', 8800 * R], ['Pasting Wages', 7600 * R], ['Salaries & Wages', (13100 + 9700) * R],
  ].sort(), 'Binding Wages takes nothing: its only person is hidden; the hidden contractor\'s gross is on salary_expense too');
  assert.ok(!built.lines.some(l => l.ledger_id === L['Binding Wages']));
});

test('advances on the payroll sheet post at finalise from the CASH account, narrated "Advances on the Jan payroll sheet · N people"', gate, async () => {
  const out = await post('sheetAdvances', janRun.id);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  janSheetAdvances = out.voucher_id;
  const v = await voucherRow(out.voucher_id);
  // Six people had one; person 19 is hidden, and goes into the CASH account's combined entry instead (ruling R21).
  const shown = JAN.lines.filter(l => l.advanceGiven > 0 && !l.hidden);
  assert.equal(shown.length, 5);
  const total = shown.reduce((t, l) => t + Math.round(l.advanceGiven * R), 0);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.source_type, v.source_id, v.status],
    [CI, 'payment', '2027-02-03', 'Advances on the Jan payroll sheet · 5 people', 'hr_sheet_adv', janRun.id, 'posted'], 'dated the day it was finalised');
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', total, 0], ['Office cash', 0, total]]);
  // It books the advance rows finalise made (ruling R27's cover list), and none of the hidden person's.
  const rows = await h.db.q(`SELECT id, person_id FROM hr.advance_txns WHERE run_id = $1 AND source = 'payroll' AND kind = 'given' ORDER BY id`, [janRun.id]);
  assert.deepEqual(await coversOf(v.id), rows.filter(r => r.person_id !== JAN.people[18]).map(r => ['hr_advance', r.id]));
});

test('with when_paid the journal is skipped until the first batch, then dated its paid_on', gate, async () => {
  await saveSetup({ book_id: CI, payroll_booking: 'when_paid' });
  try {
    const people = [];
    for (const i of [1, 2, 3]) people.push(await fx.person({ name: `Test Feb Person ${i}` }));
    const run = await fx.payroll({ month: '2027-02', approvedBy: MD.id, lines: people.map((person, i) => ({ person, gross: 11000 + i * 500 })) });
    await fx.finalise(run.id, { at: '2027-03-02T10:00:00+05:30', by: MD.id });
    assert.deepEqual(await post('run', run.id, MD), { result: 'skipped', reason_code: 'awaiting_first_payment' });
    assert.equal(await count(`fin_vouchers WHERE source_type LIKE 'hr\\_run%' AND source_id = ${Number(run.id)}`), 0);
    await fx.payBatch({ lineIds: run.lineIds.slice(0, 2), channel: 'CASH', batchNo: 'CI-PAY-0101', paidOn: '2027-03-05', by: MD.id });
    const out = await post('run', run.id, MD);
    assert.equal(out.result, 'posted', JSON.stringify(out));
    const v = await voucherRow(out.voucher_id);
    assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.source_type], ['journal', '2027-03-05', 'Payroll Feb 2027 · 3 people', 'hr_run'],
      'dated the first payment');
    await fx.payBatch({ lineIds: run.lineIds.slice(2), channel: 'CASH', batchNo: 'CI-PAY-0102', paidOn: '2027-03-08', by: MD.id });
    assert.deepEqual(await post('run', run.id, MD), { result: 'posted', voucher_id: v.id, already: true }, 'a later batch moves nothing');
  } finally {
    await saveSetup({ book_id: CI, payroll_booking: 'month_end' });
  }
});

test('un-finalise by the accounts login submits the reversal for md, and the re-finalised journal waits behind it; by md it reverses at once', gate, async () => {
  const journal = janJournal;
  await fx.unfinalise(janRun.id);
  const bells = await count(`notifications WHERE kind = 'fin_approval'`);
  const undo = await post('run', janRun.id);
  assert.equal(undo.result, 'skipped', JSON.stringify(undo));
  assert.equal(undo.reason_code, 'not_finalised');
  assert.equal(undo.reversal.result, 'submitted', JSON.stringify(undo));
  const rev = await reversalOf(journal);
  assert.deepEqual(undo.reversal.voucher_ids, [rev.id]);
  assert.deepEqual([rev.status, rev.voucher_date], ['submitted', '2027-01-31'],
    'dated at the journal it reverses, never today (ruling R67; finance-pg-hr-dating.test.js stands after the month end)');
  assert.match(rev.narration, /^Reversal of CI-JV-2627-\d{4} — Undone in HR$/);
  assert.ok(await count(`notifications WHERE kind = 'fin_approval'`) > bells, 'the Approvers are told');
  assert.deepEqual(await standing('hr_run', janRun.id), [journal], 'while the reversal waits, the journal stands (H8)');
  // The sheet's advances, the same.
  const undoAdv = await post('sheetAdvances', janRun.id);
  assert.deepEqual([undoAdv.result, undoAdv.reason_code, undoAdv.reversal.result], ['skipped', 'not_finalised', 'submitted']);
  const revAdv = await reversalOf(janSheetAdvances);

  // Finalised again: the corrected journal waits behind the reversal, and nothing new is made.
  await fx.finalise(janRun.id, { at: '2027-02-04T10:00:00+05:30', by: ACCT.id });
  const waits = await post('run', janRun.id);
  assert.deepEqual(waits, { result: 'skipped', reason_code: 'reversal_waiting', reversal: { result: 'submitted', voucher_ids: [rev.id] } });
  assert.deepEqual((await post('sheetAdvances', janRun.id)).reason_code, 'reversal_waiting');
  assert.equal((await vouchersOf('hr_run', janRun.id)).length, 1, 'no second journal');

  // md approves the reversal in Finance; the next post makes the corrected journal.
  await approve(rev.id);
  assert.equal((await voucherRow(journal)).reversed_by_id, rev.id);
  const again = await post('run', janRun.id);
  assert.equal(again.result, 'posted', JSON.stringify(again));
  assert.notEqual(again.voucher_id, journal);
  assert.deepEqual(await linesOf(again.voucher_id), await linesOf(journal), 'the same month, the same figures');
  await approve(revAdv.id);
  const adv = await post('sheetAdvances', janRun.id);
  assert.equal(adv.result, 'posted', JSON.stringify(adv));
  assert.equal((await voucherRow(adv.voucher_id)).voucher_date, '2027-02-04', 'the day it was finalised again');

  // By md, an HR approver, the reversal posts at once, approved in HR in his name (finHrReverse).
  await fx.unfinalise(janRun.id);
  const byMd = await h.db.tx((qc, oc) => feed.finHrReverse(qc, oc, 'hr_run', janRun.id, MD));
  assert.equal(byMd.result, 'posted', JSON.stringify(byMd));
  const mdRev = await voucherRow(byMd.voucher_ids[0]);
  assert.deepEqual([mdRev.status, mdRev.reversal_of_id, mdRev.approved_by_id, mdRev.self_approved, mdRev.created_by],
    ['posted', again.voucher_id, MD.id, true, 'Test MD (HR)']);
  assert.deepEqual((await postRow(mdRev.id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' });
  // Never a reversal of a reversal: with nothing standing there is nothing to take back.
  assert.deepEqual(await h.db.tx((qc, oc) => feed.finHrReverse(qc, oc, 'hr_run', janRun.id, MD)), { result: 'none', voucher_ids: [] });
  assert.deepEqual(await post('run', janRun.id, MD), { result: 'skipped', reason_code: 'not_finalised' });
  const advByMd = await post('sheetAdvances', janRun.id, MD);
  assert.deepEqual([advByMd.reason_code, advByMd.reversal.result], ['not_finalised', 'posted']);
  await fx.finalise(janRun.id, { at: '2027-02-05T10:00:00+05:30', by: MD.id });
  const last = await post('run', janRun.id, MD);
  assert.equal(last.result, 'posted', JSON.stringify(last));
  janJournal = last.voucher_id;
  assert.equal((await post('sheetAdvances', janRun.id, MD)).result, 'posted');
  assert.equal((await standing('hr_run', janRun.id)).length, 1, 'one journal stands for the month');
});

test('a line marked failed in a batch reverses the batch voucher and posts it again for the remaining people', gate, async () => {
  const pay = async (people, batchNo) => {
    const lineIds = await lineOfAll(janRun.id, people);
    return { lineIds, id: await fx.payBatch({ lineIds, channel: 'CASH', batchNo, paidOn: '2027-02-06', by: MD.id }) };
  };
  const paise = i => toRupee(Math.round(JAN.lines[i - 1].gross * R) - Math.round(JAN.lines[i - 1].advanceRecovery * R)
    - Math.round(JAN.lines[i - 1].loanRecovery * R) - Math.round(JAN.lines[i - 1].misc * R) - Math.round(JAN.lines[i - 1].adj * R)
    - Math.round(JAN.lines[i - 1].paidSeparately * R));
  const batch = await pay([JAN.people[1], JAN.people[3], JAN.people[5]], 'CI-PAY-0103');   // persons 2, 4 and 6
  const first = await post('batch', batch.id, MD);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  assert.equal((await voucherRow(first.voucher_id)).narration, 'Salary Jan · cash · CI-PAY-0103 · 3 people');
  await fx.markLine(batch.lineIds[1], 'failed');
  const redo = await post('batch', batch.id, MD);
  assert.equal(redo.result, 'posted', JSON.stringify(redo));
  assert.equal(redo.reversal.result, 'posted');
  const rev = await voucherRow(redo.reversal.voucher_ids[0]);
  assert.deepEqual([rev.reversal_of_id, rev.status, rev.approved_by_id], [first.voucher_id, 'posted', MD.id], 'md: reversed at once');
  const v = await voucherRow(redo.voucher_id);
  assert.deepEqual([v.narration, v.source_type, v.source_id, v.voucher_date], ['Salary Jan · cash · CI-PAY-0103 · 2 people', 'hr_batch', batch.id, '2027-02-06']);
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', paise(2) + paise(6), 0], ['Office cash', 0, paise(2) + paise(6)]]);
  assert.deepEqual(await standing('hr_batch', batch.id), [v.id]);
  assert.deepEqual(await post('batch', batch.id, MD), { result: 'posted', voucher_id: v.id, already: true }, 'posted again, nothing moves');

  // The accounts login marking a line reversed: the reversal waits for md, and the batch's new voucher waits behind it.
  const other = await pay([JAN.people[7], JAN.people[8], JAN.people[10]], 'CI-PAY-0104');
  const posted = await post('batch', other.id, MD);
  await fx.markLine(other.lineIds[1], 'reversed');
  const waits = await post('batch', other.id, ACCT);
  assert.deepEqual([waits.result, waits.reason_code, waits.reversal.result], ['skipped', 'reversal_waiting', 'submitted'], JSON.stringify(waits));
  assert.deepEqual(await standing('hr_batch', other.id), [posted.voucher_id]);
  await approve(waits.reversal.voucher_ids[0]);
  const now = await post('batch', other.id, ACCT);
  assert.equal(now.result, 'posted', JSON.stringify(now));
  assert.equal((await voucherRow(now.voucher_id)).narration, 'Salary Jan · cash · CI-PAY-0104 · 2 people');
});

test('a cancelled loan and an advance HR takes back are reversed; an entry still waiting for an Approver is withdrawn instead', gate, async () => {
  const p = await fx.person({ name: 'Test Undo Person' });
  const loan = await fx.loan({ person: p, loanNo: 'CI-LN-0801', date: '2027-01-07', rupees: 25000, paidVia: 'cash', by: MD.id });
  const lent = await post('loan', loan.id, MD);
  assert.equal(lent.result, 'posted', JSON.stringify(lent));
  await h.db.q(`UPDATE hr.loans SET status = 'cancelled' WHERE id = $1`, [loan.id]);
  await h.db.q(`INSERT INTO hr.loan_txns (loan_id, txn_date, kind, principal_amount, note, created_by) VALUES ($1, '2027-01-09', 'adjustment', -25000, 'Loan cancelled', $2)`,
    [loan.id, MD.id]);
  const cancelled = await post('loan', loan.id, MD);
  assert.deepEqual([cancelled.result, cancelled.reason_code, cancelled.reversal.result], ['skipped', 'cancelled', 'posted'], JSON.stringify(cancelled));
  assert.equal((await voucherRow(lent.voucher_id)).reversed_by_id, cancelled.reversal.voucher_ids[0]);
  assert.deepEqual(await post('loan', loan.id, MD), { result: 'skipped', reason_code: 'cancelled' }, 'nothing stands any more');

  const adv = await fx.advance({ person: p, date: '2027-01-10', rupees: 2500, paidVia: 'cash', by: ACCT.id });
  const given = await post('advance', adv);
  assert.equal(given.result, 'posted', JSON.stringify(given));
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, '2027-01-11', 'recovered', 2500, 'manual', $2)`, [p, adv]);
  const back = await post('advance', adv);
  assert.deepEqual([back.result, back.reason_code, back.reversal.result], ['skipped', 'reversed', 'submitted'], 'by the accounts login: the reversal waits');

  // A ₹1,50,000 advance by the accounts login waits for md; taken back in HR before he decides, it is withdrawn, never posted.
  const big = await fx.advance({ person: p, date: '2027-01-12', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const waiting = await post('advance', big);
  assert.equal(waiting.result, 'submitted');
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, '2027-01-13', 'recovered', 150000, 'manual', $2)`, [p, big]);
  const withdrawn = await post('advance', big);
  assert.deepEqual(withdrawn, { result: 'skipped', reason_code: 'reversed', reversal: { result: 'withdrawn', voucher_ids: [], withdrawn_ids: [waiting.voucher_id] } });
  assert.equal((await voucherRow(waiting.voucher_id)).status, 'discarded');
  assert.equal(await count(`notifications WHERE kind = 'fin_approval' AND ref_id = ${Number(waiting.voucher_id)} AND read_at IS NULL`), 0, 'its bells answered');
  const trail = await h.db.q(`SELECT action, reason FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [waiting.voucher_id]);
  assert.deepEqual(trail.map(a => [a.action, a.reason]), [['create', null], ['submit', null], ['discard', 'Undone in HR']]);
});

test('R39: HR taking back an advance whose voucher an Approver sent back discards that draft, audited: nothing of any status stays for it', gate, async () => {
  const p = await fx.person({ name: 'Test Sent Back Undo Person' });
  const big = await fx.advance({ person: p, date: '2027-01-14', rupees: 150000, paidVia: 'cash', by: ACCT.id });
  const waiting = await post('advance', big);
  assert.equal(waiting.result, 'submitted', JSON.stringify(waiting));
  await ok(h.call('POST', `/finance/vouchers/${waiting.voucher_id}/reject`, { reason: 'Check the advance in HR' }, 'md'));
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, '2027-01-15', 'recovered', 150000, 'manual', $2)`, [p, big]);
  assert.deepEqual(await post('advance', big), { result: 'skipped', reason_code: 'reversed' });
  assert.equal((await voucherRow(waiting.voucher_id)).status, 'discarded', 'the sent-back draft can no longer be sent on');
  const trail = await h.db.q(`SELECT action, user_name FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [waiting.voucher_id]);
  assert.deepEqual(trail.map(a => a.action), ['create', 'submit', 'reject', 'discard']);
  assert.equal(trail[3].user_name, 'Test Accountant (HR)');
  assert.equal(await count(`fin_vouchers WHERE source_type IN ('hr_advance', 'hr_advance:DP') AND source_id = ${Number(big)} AND status <> 'discarded'`), 0,
    'nothing of any status stays for money HR took back');
  assert.deepEqual(await post('advance', big), { result: 'skipped', reason_code: 'reversed' }, 'posted again, nothing more');
});

test('a reversal that cannot post (its month locked) is an exception, and the retry once it is open takes the voucher out', gate, async () => {
  const p = await fx.person({ name: 'Test Locked Undo Person' });
  const loan = await fx.loan({ person: p, loanNo: 'CI-LN-0802', date: '2027-03-02', rupees: 9000, paidVia: 'cash', by: MD.id });
  const lent = await post('loan', loan.id, MD);
  assert.equal(lent.result, 'posted', JSON.stringify(lent));
  await h.db.q(`UPDATE hr.loans SET status = 'cancelled' WHERE id = $1`, [loan.id]);
  const MAR = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2027-03-01'`, [CI])).id;
  const moveMarch = (status, reason = null) => ok(h.call('PUT', `/finance/periods/${MAR}/status`, { status, reason }, 'md'));
  await moveMarch('closing');
  await moveMarch('locked');
  try {
    assert.deepEqual(await post('loan', loan.id, MD), { result: 'exception', reason_code: 'FIN_PERIOD_LOCKED' },
      'the voucher that stands is the one being taken out, so it is no answer: the failure is the exception');
    const ex = await exceptionOf('hr_loan', loan.id);
    assert.deepEqual([ex.book_id, ex.reason_code, ex.resolved_at], [CI, 'FIN_PERIOD_LOCKED', null]);
    assert.deepEqual(await standing('hr_loan', loan.id), [lent.voucher_id], 'nothing moved');
  } finally {
    await moveMarch('closing', 'Unlocked to take the HR entries');
    await moveMarch('open', 'Open again');
  }
  const retried = await post('loan', loan.id, MD);
  assert.deepEqual([retried.reason_code, retried.reversal.result], ['cancelled', 'posted'], JSON.stringify(retried));
  assert.ok((await exceptionOf('hr_loan', loan.id)).resolved_at);
  assert.deepEqual(await standing('hr_loan', loan.id), []);
});

test('R40: an undo that fails before its reversal is made is an exception, never already: the voucher it takes out is no answer', gate, async () => {
  const p = await fx.person({ name: 'Test Undo Lookup Person' });
  const adv = await fx.advance({ person: p, date: '2027-01-15', rupees: 1900, paidVia: 'cash', by: MD.id });
  const given = await post('advance', adv, MD);
  assert.equal(given.result, 'posted', JSON.stringify(given));
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, reverses_id) VALUES ($1, '2027-01-16', 'recovered', 1900, 'manual', $2)`, [p, adv]);
  // The doer lookup (is the HR login an HR approver now?) fails, before any voucher is touched: HR's access table is out of reach.
  await h.db.q('ALTER TABLE hr.access RENAME TO access_away');
  try {
    assert.deepEqual(await post('advance', adv, MD), { result: 'exception', reason_code: 'FIN_SERVER_ERROR' });
  } finally {
    await h.db.q('ALTER TABLE hr.access_away RENAME TO access');
  }
  const ex = await exceptionOf('hr_advance', adv);
  assert.deepEqual([ex.reason_code, ex.book_id, ex.resolved_at], ['FIN_SERVER_ERROR', CI, null], 'open, under the book the voucher stands in');
  assert.deepEqual(await standing('hr_advance', adv), [given.voucher_id], 'nothing moved');
  const retried = await post('advance', adv, MD);
  assert.deepEqual([retried.result, retried.reason_code, retried.reversal?.result], ['skipped', 'reversed', 'posted'], JSON.stringify(retried));
  assert.ok((await exceptionOf('hr_advance', adv)).resolved_at, 'the retry resolves it');
});

test('a correction HR makes that Finance cannot book yet is an exception, not the voucher it was taking out; the retry books it', gate, async () => {
  const lineIds = await lineOfAll(janRun.id, [JAN.people[13], JAN.people[14]]);   // persons 14 and 15
  const batch = await fx.payBatch({ lineIds, channel: 'COLOUR', batchNo: 'CI-PAY-0105', paidOn: '2027-02-07', by: MD.id });
  const first = await post('batch', batch, MD);
  assert.equal(first.result, 'posted', JSON.stringify(first));
  const other = await fx.payBatch({ lineIds: await lineOfAll(janRun.id, [JAN.people[15], JAN.people[16]]), channel: 'COLOUR', batchNo: 'CI-PAY-0106',
    paidOn: '2027-02-07', by: MD.id });   // persons 16 and 17
  const second = await post('batch', other, MD);
  assert.equal(second.result, 'posted', JSON.stringify(second));
  await fx.markLine(lineIds[1], 'failed');
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'COLOUR', ledger_id: null }] });
  try {
    assert.deepEqual(await post('batch', batch, MD), { result: 'exception', reason_code: 'FIN_UNMAPPED_CHANNEL' },
      'the voucher that stands is the one HR\'s correction takes out, so it is no answer: the failure is the exception');
    assert.deepEqual([(await exceptionOf('hr_batch', batch)).book_id, await standing('hr_batch', batch)], [CI, [first.voucher_id]], 'nothing moved');
    // A batch HR has not changed stands as it is: a change of Finance's setup never posts it again, and looking at which books it
    // touches (ruling R34) is no exception of it.
    assert.deepEqual(await post('batch', other, MD), { result: 'posted', voucher_id: second.voucher_id, already: true });
    assert.equal(await exceptionOf('hr_batch', other), null, 'no exception of it');
  } finally {
    await saveSetup({ book_id: CI, channels: [{ channel_code: 'COLOUR', ledger_id: L['Bank – current'] }] });
  }
  const retried = await post('batch', batch, MD);
  assert.deepEqual([retried.result, retried.reversal?.result], ['posted', 'posted'], JSON.stringify(retried));
  assert.equal((await voucherRow(first.voucher_id)).reversed_by_id, retried.reversal.voucher_ids[0]);
  assert.equal((await voucherRow(retried.voucher_id)).narration, 'Salary Jan · colour bank · CI-PAY-0105 · 1 person');
  assert.ok((await exceptionOf('hr_batch', batch)).resolved_at, 'the retry resolves it');
});

test('an HR correction of a finalised month reverses the journal and posts the corrected one', gate, async () => {
  // As hr/correction.js corrects a finalised line: a deduction changes, and the payable with it.
  const line = JAN.lines[0];
  await h.db.q(`UPDATE hr.run_lines SET misc_deduction = misc_deduction + 100, total_deductions = total_deductions + 100, payable = payable - 100
                 WHERE run_id = $1 AND person_id = $2`, [janRun.id, line.person]);
  const out = await post('run', janRun.id, MD);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  assert.equal(out.reversal.result, 'posted');
  assert.equal((await voucherRow(janJournal)).reversed_by_id, out.reversal.voucher_ids[0]);
  const credit = async (id, name) => (await linesOf(id)).find(l => l[0] === name)[2];
  assert.equal(await credit(out.voucher_id, 'Staff Deductions'), await credit(janJournal, 'Staff Deductions') + 100 * R);
  assert.equal(await credit(out.voucher_id, 'Salary Payable'), await credit(janJournal, 'Salary Payable') - 100 * R);
  assert.match((await reversalOf(janJournal)).narration, / — Corrected in HR$/);
  janJournal = out.voucher_id;
});

test('a missing other_deductions role with non-zero deductions makes an exception FIN_ROLE_MISSING', gate, async () => {
  const [nofirm, darbi, colour] = [
    await fx.person({ name: 'Test March No Firm', firm: null }),
    await fx.person({ name: 'Test March Darbi', firm: 'DARBI', channel: 'DARBI' }),
    await fx.person({ name: 'Test March Colour' }),
  ];
  const run = await fx.payroll({ month: '2027-03', approvedBy: MD.id, lines: [
    { person: nofirm, gross: 15000 }, { person: darbi, gross: 18000, misc: 250 }, { person: colour, gross: 16000 }] });
  await fx.finalise(run.id, { at: '2027-04-02T10:00:00+05:30', by: MD.id });
  const was = await count('fin_vouchers');
  assert.deepEqual(await post('run', run.id, MD), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
  const ex = await exceptionOf('hr_run', run.id);
  assert.deepEqual([ex.book_id, ex.reason, ex.resolved_at], [DP, 'Set this ledger in Finance Setup → HR & payroll first.', null]);
  assert.equal(await count('fin_vouchers'), was, 'neither book\'s journal was made');
  JAN.march = run;
  JAN.marchPeople = { nofirm, darbi, colour };
});

test('a person with no firm books to CI', gate, async () => {
  await saveSetup({ book_id: DP, roles: { other_deductions: D['DP Staff Deductions'] } });
  const run = JAN.march;
  const out = await post('run', run.id, MD);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  assert.equal(out.voucher_ids.length, 2, 'a run with people of both books: one journal per book');
  const [ci, dp] = await Promise.all(out.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.narration, ci.voucher_date, ci.source_type, dp.book_id, dp.narration, dp.source_type],
    [CI, 'Payroll Mar 2027 · 2 people', '2027-03-31', 'hr_run', DP, 'Payroll Mar 2027 · 1 person', 'hr_run:DP']);
  assert.deepEqual(byName(await linesOf(ci.id)), byName([['Salaries & Wages', 31000 * R, 0], ['Salary Payable', 0, 31000 * R]]),
    'the person with no firm is in CI\'s journal');
  assert.deepEqual(byName(await linesOf(dp.id)), byName([['Salaries & Wages', 18000 * R, 0], ['DP Staff Deductions', 0, 250 * R], ['Salary Payable', 0, 17750 * R]]));
  const ex = await exceptionOf('hr_run', run.id);
  assert.ok(ex.resolved_at, 'the exception is resolved by the retry');
  assert.equal(ex.voucher_id, ci.id);
});

// ── The inter-company pair (rulings R18, R24) ─────────────────────────────────────────────────

let DEC;   // December 2026's run: its lines are paid in January 2027
const decPeople = {};
const decLine = async name => lineOf(DEC.id, decPeople[name]);

test('a DARBI batch for Colour staff posts the pair: CI Dr Salary Payable / Cr Darbi Print Pack; DP Dr Colour Impressions / Cr the DP bank', gate, async () => {
  const people = [
    ['H1', { firm: 'COLOUR', channel: 'COLOUR' }, 45000], ['H2', { firm: 'COLOUR', channel: 'COLOUR' }, 38000],
    ['H3', { firm: 'COLOUR', channel: 'CASH' }, 9000], ['H5', { firm: 'COLOUR', channel: 'COLOUR' }, 12000],
    ['P', { firm: 'COLOUR', channel: 'COLOUR' }, 20000],
    ['CD1', { firm: 'COLOUR', channel: 'DARBI' }, 30000], ['CD2', { firm: 'COLOUR', channel: 'DARBI' }, 32000],
    ['DD1', { firm: 'DARBI', channel: 'DARBI' }, 25000], ['CD3', { firm: 'COLOUR', channel: 'DARBI' }, 26000],
  ];
  for (const [name, at] of people) decPeople[name] = await fx.person({ name: `Test December ${name}`, ...at });
  DEC = await fx.payroll({ month: '2026-12', approvedBy: MD.id, lines: people.map(([name, , gross]) => ({ person: decPeople[name], gross })) });

  const batch = await fx.payBatch({ lineIds: [await decLine('CD1'), await decLine('CD2')], channel: 'DARBI', batchNo: 'CI-PAY-0041', paidOn: '2027-01-12', by: ACCT.id });
  const out = await post('batch', batch);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  assert.equal(out.voucher_ids.length, 2);
  const [ci, dp] = await Promise.all(out.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.voucher_type, ci.voucher_date, ci.narration, ci.reference, ci.source_type, ci.source_id, ci.status],
    [CI, 'journal', '2027-01-12', 'Salary Dec · paid by Darbi Print Pack · CI-PAY-0041', 'CI-PAY-0041', 'hr_batch', batch, 'posted']);
  assert.deepEqual(await linesOf(ci.id), [['Salary Payable', 62000 * R, 0], ['Darbi Print Pack', 0, 62000 * R]]);
  assert.deepEqual([dp.book_id, dp.voucher_type, dp.voucher_date, dp.narration, dp.reference, dp.source_type, dp.source_id, dp.status],
    [DP, 'payment', '2027-01-12', 'Salary Dec · paid for Colour Impressions · CI-PAY-0041', 'CI-PAY-0041', 'hr_batch:DP', batch, 'posted']);
  assert.deepEqual(await linesOf(dp.id), [['Colour Impressions', 62000 * R, 0], ['DP Bank', 0, 62000 * R]]);
  // md approved the two lines in HR: the CI journal posts in his name (a journal always needs an Approver).
  assert.equal(ci.approved_by_id, MD.id);
  assert.deepEqual(await coversOf(ci.id), [['hr_line_pay', await decLine('CD1')], ['hr_line_pay', await decLine('CD2')]], 'the lines it books');
  assert.deepEqual(await post('batch', batch), { result: 'posted', voucher_id: ci.id, voucher_ids: [ci.id, dp.id], already: true });
  // Worked out without writing: both vouchers.
  const built = await h.db.tx(qc => feed.finHrVoucherFor(qc, { type: 'batch', id: batch }));
  assert.deepEqual(built.vouchers.map(b => [b.book_id, b.source_type, b.narration]),
    [[CI, 'hr_batch', ci.narration], [DP, 'hr_batch:DP', dp.narration]]);

  // A batch of both firms from DP's bank: DP's voucher carries the bank line for the whole amount, its own person's pay and
  // Colour's share on the inter-company ledger, under the batch's own narration; CI's journal carries its person's pay.
  const mixed = await fx.payBatch({ lineIds: [await decLine('DD1'), await decLine('CD3')], channel: 'DARBI', batchNo: 'CI-PAY-0042', paidOn: '2027-01-13', by: ACCT.id });
  const both = await post('batch', mixed);
  assert.equal(both.result, 'posted', JSON.stringify(both));
  const [mci, mdp] = await Promise.all(both.voucher_ids.map(voucherRow));
  assert.deepEqual([mci.narration, mdp.narration], ['Salary Dec · paid by Darbi Print Pack · CI-PAY-0042', 'Salary Dec · darbi bank · CI-PAY-0042 · 2 people']);
  assert.deepEqual(await linesOf(mci.id), [['Salary Payable', 26000 * R, 0], ['Darbi Print Pack', 0, 26000 * R]]);
  assert.deepEqual(await linesOf(mdp.id), [['Salary Payable', 25000 * R, 0], ['Colour Impressions', 26000 * R, 0], ['DP Bank', 0, 51000 * R]]);
});

test('R24: an advance paid from another company\'s account posts one voucher in each book, each in its own words', gate, async () => {
  const colour = await fx.person({ name: 'Test Pair Colour' });
  // Given by the accounts login from DP's bank: DP's payment needs no Approver and posts; CI's journal waits for md.
  const adv = await fx.advance({ person: colour, date: '2027-01-18', rupees: 6000, paidVia: 'DARBI', by: ACCT.id });
  const out = await post('advance', adv);
  assert.equal(out.result, 'submitted', JSON.stringify(out));
  const [ci, dp] = await Promise.all(out.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.voucher_type, ci.narration, ci.source_type, ci.status],
    [CI, 'journal', 'Advance · Pay staff · 1 person · paid by Darbi Print Pack', 'hr_advance', 'submitted']);
  assert.deepEqual(await linesOf(ci.id), [['Staff Advances', 6000 * R, 0], ['Darbi Print Pack', 0, 6000 * R]]);
  assert.deepEqual([dp.book_id, dp.voucher_type, dp.narration, dp.source_type, dp.status],
    [DP, 'payment', 'Advance · Pay staff · 1 person · paid for Colour Impressions', 'hr_advance:DP', 'posted']);
  assert.deepEqual(await linesOf(dp.id), [['Colour Impressions', 6000 * R, 0], ['DP Bank', 0, 6000 * R]]);

  // A Darbi person's advance from Colour's cash, given by md: both post.
  const darbi = await fx.person({ name: 'Test Pair Darbi', firm: 'DARBI', channel: 'DARBI' });
  const cash = await post('advance', await fx.advance({ person: darbi, date: '2027-01-19', rupees: 500, paidVia: 'cash', by: MD.id }), MD);
  assert.equal(cash.result, 'posted', JSON.stringify(cash));
  const [cci, cdp] = await Promise.all(cash.voucher_ids.map(voucherRow));
  assert.deepEqual([cci.voucher_type, cci.narration, cdp.voucher_type, cdp.narration],
    ['payment', 'Advance · Pay staff · 1 person · paid for Darbi Print Pack', 'journal', 'Advance · Pay staff · 1 person · paid by Colour Impressions']);
  assert.deepEqual(await linesOf(cci.id), [['Darbi Print Pack', 500 * R, 0], ['Office cash', 0, 500 * R]]);
  assert.deepEqual(await linesOf(cdp.id), [['Staff Advances', 500 * R, 0], ['Colour Impressions', 0, 500 * R]]);

  // Money coming back the other way: a Darbi person's loan prepaid into Colour's cash is a receipt in CI and a journal in DP.
  const loan = await fx.loan({ person: darbi, loanNo: 'CI-LN-0811', date: '2027-01-20', rupees: 8000, paidVia: 'cash', by: MD.id });
  assert.equal((await post('loan', loan.id, MD)).result, 'posted');
  const back = await post('prepay', await fx.prepay({ loan: loan.id, date: '2027-01-27', rupees: 1000, paidVia: 'cash', by: MD.id }), MD);
  const [rci, rdp] = await Promise.all(back.voucher_ids.map(voucherRow));
  assert.deepEqual([rci.voucher_type, rci.narration, rdp.voucher_type, rdp.narration],
    ['receipt', 'Loan repaid · CI-LN-0811 · paid for Darbi Print Pack', 'journal', 'Loan repaid · CI-LN-0811 · paid by Colour Impressions']);
  assert.deepEqual(await linesOf(rci.id), [['Office cash', 1000 * R, 0], ['Darbi Print Pack', 0, 1000 * R]]);
  assert.deepEqual(await linesOf(rdp.id), [['Colour Impressions', 1000 * R, 0], ['Staff Loans', 0, 1000 * R]]);

  // With no inter-company ledger set in a book, the event waits as FIN_ROLE_MISSING, and posts once it is set.
  await saveSetup({ book_id: DP, roles: { intercompany: null } });
  const later = await fx.advance({ person: colour, date: '2027-01-21', rupees: 700, paidVia: 'DARBI', by: MD.id });
  assert.deepEqual(await post('advance', later, MD), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
  assert.equal((await exceptionOf('hr_advance', later)).book_id, DP);
  await saveSetup({ book_id: DP, roles: { intercompany: D['Colour Impressions'] } });
  assert.equal((await post('advance', later, MD)).result, 'posted');
});

test('R24: a sheet round and a line paid on its own pay across books the same way', gate, async () => {
  // A round paid from Colour's cash, for a Darbi person and a Colour one: CI's payment carries its own person's advance and Darbi's share
  // on the inter-company ledger, under the round's own narration; DP's journal its person's advance.
  const darbi = await fx.person({ name: 'Test Round Darbi', firm: 'DARBI', channel: 'DARBI' });
  const colour = await fx.person({ name: 'Test Round Colour' });
  const sheet = await fx.sheet({ sheetNo: 'CI-ADV-0011', month: '2027-01', paidOn: '2027-01-28', paidVia: 'cash', by: ACCT.id, lines: [
    { person: darbi, rupees: 3000, decidedBy: MD.id }, { person: colour, rupees: 2000, decidedBy: MD.id }] });
  await fx.postRound(sheet.id, sheet.lineIds, { by: ACCT.id });
  const round = await post('sheet', sheet.lineIds[1]);
  assert.equal(round.result, 'posted', JSON.stringify(round));
  const [rci, rdp] = await Promise.all(round.voucher_ids.map(voucherRow));
  assert.deepEqual([rci.book_id, rci.voucher_type, rci.narration, rci.source_type, rci.source_id],
    [CI, 'payment', 'Advances · sheet CI-ADV-0011 · 2 people', 'hr_sheet', Math.min(...sheet.lineIds)]);
  assert.deepEqual(await linesOf(rci.id), [['Staff Advances', 2000 * R, 0], ['Darbi Print Pack', 3000 * R, 0], ['Office cash', 0, 5000 * R]]);
  assert.deepEqual([rdp.book_id, rdp.voucher_type, rdp.narration, rdp.source_type],
    [DP, 'journal', 'Advances · sheet CI-ADV-0011 · 1 person · paid by Colour Impressions', 'hr_sheet:DP']);
  assert.deepEqual(await linesOf(rdp.id), [['Staff Advances', 3000 * R, 0], ['Colour Impressions', 0, 3000 * R]]);

  // A Colour line of March paid on its own from DP's bank.
  const line = await lineOf(JAN.march.id, JAN.marchPeople.colour);
  await h.db.q(`UPDATE hr.run_lines SET payment_status = 'paid', paid_amount = payable, paid_on = '2027-03-30', paid_at = now(), paid_from = 'DARBI'
                 WHERE id = $1`, [line]);
  const paid = await post('line', line, MD);
  assert.equal(paid.result, 'posted', JSON.stringify(paid));
  const [lci, ldp] = await Promise.all(paid.voucher_ids.map(voucherRow));
  assert.deepEqual([lci.voucher_type, lci.narration, ldp.voucher_type, ldp.narration],
    ['journal', 'Salary Mar · cash · 1 person · paid by Darbi Print Pack', 'payment', 'Salary Mar · cash · 1 person · paid for Colour Impressions']);
  assert.deepEqual(await linesOf(lci.id), [['Salary Payable', 16000 * R, 0], ['Darbi Print Pack', 0, 16000 * R]]);
  assert.deepEqual(await linesOf(ldp.id), [['Colour Impressions', 16000 * R, 0], ['DP Bank', 0, 16000 * R]]);
});

test('R34: a pair\'s standing is judged book by book: the half an Approver sent back is discarded and made again, the half that stands is kept, and the answer names both', gate, async () => {
  // A DARBI-paid batch of Colour people, over ₹1,00,000, with no approval given in HR: both halves wait for an Approver.
  const people = [await fx.person({ name: 'Test Wait Pair 1', channel: 'DARBI' }), await fx.person({ name: 'Test Wait Pair 2', channel: 'DARBI' })];
  const run = await fx.payroll({ month: '2026-11', approvedBy: null, lines: [{ person: people[0], gross: 60000 }, { person: people[1], gross: 55000 }] });
  const batch = await fx.payBatch({ lineIds: run.lineIds, channel: 'DARBI', batchNo: 'CI-PAY-0401', paidOn: '2027-01-14', by: ACCT.id });
  const first = await post('batch', batch);
  assert.equal(first.result, 'submitted', JSON.stringify(first));
  const [ci, dp] = await Promise.all(first.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.status, dp.book_id, dp.status], [CI, 'submitted', DP, 'submitted']);
  const ciLines = await linesOf(ci.id);
  // md approves DP's half and sends CI's back.
  await approve(dp.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the batch in HR' }, 'md'));
  const dpTrail = await count(`fin_audit_log WHERE entity = 'voucher' AND entity_id = ${Number(dp.id)}`);

  const again = await post('batch', batch);
  assert.equal(again.result, 'submitted', JSON.stringify(again));
  const [remadeId, keptId] = again.voucher_ids;
  assert.deepEqual(again, { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id] }, 'both books, CI first');
  assert.equal(keptId, dp.id, 'the standing half is kept');
  const remade = await voucherRow(remadeId);
  assert.notEqual(remade.id, ci.id);
  assert.deepEqual([remade.book_id, remade.status, remade.narration, remade.source_type, remade.source_id],
    [CI, 'submitted', ci.narration, 'hr_batch', batch]);
  assert.deepEqual(await linesOf(remade.id), ciLines);
  assert.deepEqual(await coversOf(remade.id), run.lineIds.map(id => ['hr_line_pay', id]).sort((a, b) => a[1] - b[1]));
  // The sent-back half went through R22's discard, audited, in its own book alone; the standing half is untouched.
  assert.equal((await voucherRow(ci.id)).status, 'discarded');
  const trail = await h.db.q(`SELECT action, user_name FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [ci.id]);
  assert.deepEqual(trail.map(a => a.action), ['create', 'submit', 'reject', 'discard']);
  assert.equal(trail[3].user_name, 'Test Accountant (HR)');
  const kept = await voucherRow(dp.id);
  assert.deepEqual([kept.status, kept.reversed_by_id], ['posted', null]);
  assert.equal(await count(`fin_vouchers WHERE reversal_of_id = ${Number(dp.id)}`), 0, 'no reversal of the half that stands');
  assert.equal(await count(`fin_audit_log WHERE entity = 'voucher' AND entity_id = ${Number(dp.id)}`), dpTrail, 'nothing written on it');
  // Every book it touches stands now: a further post answers already, with both.
  assert.deepEqual(await post('batch', batch), { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id], already: true });
});

// A DARBI-paid batch of two Colour people, over ₹1,00,000, posted by the accounts login with no approval in HR: both halves wait.
const waitingPair = async (month, batchNo, paidOn, names) => {
  const people = [];
  for (const name of names) people.push(await fx.person({ name, channel: 'DARBI' }));
  const run = await fx.payroll({ month, approvedBy: null, lines: [{ person: people[0], gross: 61000 }, { person: people[1], gross: 54000 }] });
  const batch = await fx.payBatch({ lineIds: run.lineIds, channel: 'DARBI', batchNo, paidOn, by: ACCT.id });
  const first = await post('batch', batch);
  assert.equal(first.result, 'submitted', JSON.stringify(first));
  const [ci, dp] = await Promise.all(first.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.status, dp.book_id, dp.status], [CI, 'submitted', DP, 'submitted']);
  return { batch, ci, dp, people, run };
};

test('R34: a half a Finance Admin discarded by hand is made again on the next post; the half that stands is kept', gate, async () => {
  const { batch, ci, dp } = await waitingPair('2026-10', 'CI-PAY-0402', '2027-01-15', ['Test Wait Pair 3', 'Test Wait Pair 4']);
  await approve(dp.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the batch in HR' }, 'md'));
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/discard`, null, 'md'));
  assert.equal((await voucherRow(ci.id)).status, 'discarded', 'nothing is left of CI\'s half: no draft marks its book');
  const again = await post('batch', batch);
  assert.equal(again.result, 'submitted', JSON.stringify(again));
  const [remadeId] = again.voucher_ids;
  assert.deepEqual(again, { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id] });
  const remade = await voucherRow(remadeId);
  assert.deepEqual([remade.book_id, remade.status, remade.narration, remade.source_type], [CI, 'submitted', ci.narration, 'hr_batch']);
  assert.deepEqual(await linesOf(remadeId), await linesOf(ci.id));
  assert.deepEqual([(await voucherRow(dp.id)).status, (await voucherRow(dp.id)).reversed_by_id], ['posted', null], 'the half that stands is kept');
  assert.deepEqual(await post('batch', batch), { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id], already: true });
});

test('R34: a half sent back after Finance\'s setup changed under the half that stands is not made alone: the event is made again whole', gate, async () => {
  await makeLedger(DP, 'Loans & Advances (Asset)', 'Colour Impressions (new)');
  const { batch, ci, dp } = await waitingPair('2026-09', 'CI-PAY-0403', '2027-01-16', ['Test Wait Pair 5', 'Test Wait Pair 6']);
  const ciLines = await linesOf(ci.id);
  await approve(dp.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the batch in HR' }, 'md'));
  // DP's inter-company ledger is another since: the batch's DP half is not what stands any more, so CI's half made alone would not
  // pair with it. The standing half is taken out first (by the accounts login, its reversal waits for md), and nothing is made meanwhile.
  await saveSetup({ book_id: DP, roles: { intercompany: D['Colour Impressions (new)'] } });
  try {
    const redo = await post('batch', batch);
    assert.equal(redo.result, 'skipped', JSON.stringify(redo));
    const rev = await reversalOf(dp.id);
    assert.deepEqual(redo, { result: 'skipped', reason_code: 'reversal_waiting', reversal: { result: 'submitted', voucher_ids: [rev.id] } });
    assert.equal((await voucherRow(ci.id)).status, 'draft', 'nothing discarded while the reversal waits');
    await approve(rev.id);
    const made = await post('batch', batch);
    assert.equal(made.result, 'submitted', JSON.stringify(made));
    const [ci2, dp2] = await Promise.all(made.voucher_ids.map(voucherRow));
    assert.deepEqual([ci2.book_id, dp2.book_id, (await voucherRow(ci.id)).status, (await voucherRow(dp.id)).reversed_by_id],
      [CI, DP, 'discarded', rev.id]);
    assert.deepEqual(await linesOf(ci2.id), ciLines);
    assert.deepEqual(await linesOf(dp2.id), [['Colour Impressions (new)', 115000 * R, 0], ['DP Bank', 0, 115000 * R]]);
  } finally {
    await saveSetup({ book_id: DP, roles: { intercompany: D['Colour Impressions'] } });
  }
});

test('R34: a sent-back half that cannot be made again is the event\'s exception; the half that stands is no answer for it', gate, async () => {
  const { batch, ci, dp } = await waitingPair('2026-08', 'CI-PAY-0404', '2027-01-18', ['Test Wait Pair 7', 'Test Wait Pair 8']);
  await approve(dp.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the batch in HR' }, 'md'));
  await saveSetup({ book_id: CI, roles: { intercompany: null } });
  try {
    assert.deepEqual(await post('batch', batch), { result: 'exception', reason_code: 'FIN_ROLE_MISSING' });
    const ex = await exceptionOf('hr_batch', batch);
    assert.deepEqual([ex.book_id, ex.resolved_at], [CI, null]);
    assert.equal((await voucherRow(ci.id)).status, 'draft', 'nothing moved');
  } finally {
    await saveSetup({ book_id: CI, roles: { intercompany: L['Darbi Print Pack'] } });
  }
  const again = await post('batch', batch);
  assert.deepEqual([again.result, again.voucher_ids?.length, again.voucher_ids?.[1]], ['submitted', 2, dp.id], JSON.stringify(again));
  assert.ok((await exceptionOf('hr_batch', batch)).resolved_at, 'made again, the exception is resolved');
});

test('an event left waiting as FIN_INTERCOMPANY_PENDING (Task 10) posts its pair when it is tried again, and the code is gone', gate, async () => {
  assert.equal(Object.hasOwn(FIN_SENTENCES, 'FIN_INTERCOMPANY_PENDING'), false, 'ruling R18: the placeholder is removed');
  const colour = await fx.person({ name: 'Test Pending Colour' });
  const adv = await fx.advance({ person: colour, date: '2027-01-22', rupees: 4200, paidVia: 'DARBI', by: MD.id });
  await h.db.q(`INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, last_tried_at)
                VALUES ('hr_advance', $1, $2, 'FIN_INTERCOMPANY_PENDING', 'Paid from another company''s account: this posts as an inter-company pair.', now())`,
  [adv, CI]);
  const out = await post('advance', adv, MD);
  assert.equal(out.result, 'posted', JSON.stringify(out));
  assert.deepEqual((await Promise.all(out.voucher_ids.map(voucherRow))).map(v => [v.book_id, v.source_type]), [[CI, 'hr_advance'], [DP, 'hr_advance:DP']]);
  const ex = await exceptionOf('hr_advance', adv);
  assert.ok(ex.resolved_at, 'resolved');
  assert.equal(ex.voucher_id, out.voucher_id);
});

// ── Hidden people (rulings R21, R27) ──────────────────────────────────────────────────────────

const hiddenOf = (ledgerKey, month) => standing(`hr_hidden:${ledgerKey}`, month);
let bankJan;

test('payouts to two hidden people in January post nothing until February; then one "Salary · combined · 2 people" dated the last of those payouts', gate, async () => {
  for (const name of ['H1', 'H2', 'H3', 'H5']) await fx.hide(decPeople[name], { user: ACCT.id });
  const b1 = await fx.payBatch({ lineIds: [await decLine('H1')], channel: 'COLOUR', batchNo: 'CI-PAY-0201', paidOn: '2027-01-10', by: MD.id });
  const b2 = await fx.payBatch({ lineIds: [await decLine('H2')], channel: 'COLOUR', batchNo: 'CI-PAY-0202', paidOn: '2027-01-20', by: MD.id });
  const was = { vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') };
  assert.deepEqual(await post('batch', b1, MD), { result: 'skipped', reason_code: 'hidden' });
  assert.deepEqual(await post('batch', b2, MD), { result: 'skipped', reason_code: 'hidden' });
  const inJanuary = await hidden('2027-01-31');
  assert.deepEqual([inJanuary.posted, inJanuary.submitted], [0, 0], JSON.stringify(inJanuary));
  assert.deepEqual({ vouchers: await count('fin_vouchers'), audit: await count('fin_audit_log') }, was, 'nothing until the month has ended');

  const inFebruary = await hidden('2027-02-01');
  assert.equal(inFebruary.posted, 1, JSON.stringify(inFebruary));
  const [id] = await hiddenOf(L['Bank – current'], 202701);
  bankJan = id;
  const v = await voucherRow(id);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.reference, v.source_type, v.source_id, v.status],
    [CI, 'payment', '2027-01-20', 'Salary · combined · 2 people', null, `hr_hidden:${L['Bank – current']}`, 202701, 'posted']);
  assert.deepEqual(await linesOf(id), [['Salary Payable', 83000 * R, 0], ['Bank – current', 0, 83000 * R]]);
  assert.deepEqual(await coversOf(id), [['hr_line_pay', await decLine('H1')], ['hr_line_pay', await decLine('H2')]].sort((a, b) => a[1] - b[1]));
  assert.deepEqual((await postRow(id)).approved_in_hr_by, { id: MD.id, name: 'Test MD' }, 'md approved both payouts in HR');
  const again = await hidden('2027-02-01');
  assert.deepEqual([again.posted, again.submitted], [0, 0], 'swept again: nothing new');
});

test('R21: a hidden person\'s advance, loan, prepayment and payout through one account in a month are one combined entry, netted on the account', gate, async () => {
  const h4 = await fx.person({ name: 'Test December H4' });
  await fx.hide(h4, { user: ACCT.id, mode: 'all' });
  decPeople.H4 = h4;
  const adv = await fx.advance({ person: decPeople.H3, date: '2027-01-05', rupees: 3000, paidVia: 'cash', by: MD.id });
  const loan = await fx.loan({ person: h4, loanNo: 'CI-LN-0901', date: '2027-01-08', rupees: 10000, paidVia: 'cash', by: MD.id });
  const prepay = await fx.prepay({ loan: loan.id, date: '2027-01-26', rupees: 1000, paidVia: 'cash', by: MD.id });
  await h.db.q(`UPDATE hr.run_lines SET payment_status = 'paid', paid_amount = payable, paid_on = '2027-01-25', paid_at = now(), paid_from = 'cash'
                 WHERE id = $1`, [await decLine('H3')]);
  for (const [type, id] of [['advance', adv], ['loan', loan.id], ['prepay', prepay], ['line', await decLine('H3')]]) {
    assert.deepEqual(await post(type, id, MD), { result: 'skipped', reason_code: 'hidden' }, type);
  }
  DEC.h3Advance = adv;
  const swept = await hidden('2027-02-01');
  assert.equal(swept.posted, 1, JSON.stringify(swept));
  const [id] = await hiddenOf(L['Office cash'], 202701);
  const v = await voucherRow(id);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration, v.source_type], ['payment', '2027-01-26', 'Staff money · combined · 2 people',
    `hr_hidden:${L['Office cash']}`]);
  assert.deepEqual(await linesOf(id), [['Salary Payable', 9000 * R, 0], ['Staff Advances', 3000 * R, 0], ['Staff Loans', 10000 * R, 0],
    ['Staff Loans', 0, 1000 * R], ['Office cash', 0, 21000 * R]]);
  assert.deepEqual(await coversOf(id), [['hr_advance', adv], ['hr_line_pay', await decLine('H3')], ['hr_loan', loan.id], ['hr_prepay', prepay]]);

  // More coming in than going out is a receipt: a prepayment alone, in March, into the bank.
  await fx.prepay({ loan: loan.id, date: '2027-03-03', rupees: 2000, paidVia: 'COLOUR', by: MD.id });
  await hidden('2027-04-01');
  const [inMarch] = await hiddenOf(L['Bank – current'], 202703);
  const r = await voucherRow(inMarch);
  assert.deepEqual([r.voucher_type, r.voucher_date, r.narration], ['receipt', '2027-03-03', 'Staff money · combined · 1 person']);
  assert.deepEqual(await linesOf(inMarch), [['Bank – current', 2000 * R, 0], ['Staff Loans', 0, 2000 * R]]);
  // …and the hidden person's advance on January's payroll sheet, paid from cash on the day the month was finalised.
  const [sheetFeb] = await hiddenOf(L['Office cash'], 202702);
  const s = await voucherRow(sheetFeb);
  const given = Math.round(JAN.lines[18].advanceGiven * R);
  assert.deepEqual([s.voucher_type, s.voucher_date, s.narration], ['payment', '2027-02-05', 'Staff money · combined · 1 person']);
  assert.deepEqual(await linesOf(sheetFeb), [['Staff Advances', given, 0], ['Office cash', 0, given]]);
});

test('R21: hidden people\'s waivers in a month are one journal, "Advance waived · combined · 1 person"', gate, async () => {
  const waiver = await fx.waiver({ person: decPeople.H3, date: '2027-01-27', rupees: 500, by: MD.id });
  assert.deepEqual(await post('waiver', waiver, MD), { result: 'skipped', reason_code: 'hidden' });
  const swept = await hidden('2027-02-01');
  assert.equal(swept.posted, 1, JSON.stringify(swept));
  const [id] = await standing('hr_hidden:waiver', 202701);
  const v = await voucherRow(id);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.status, v.approved_by_id],
    [CI, 'journal', '2027-01-27', 'Advance waived · combined · 1 person', 'posted', MD.id], 'a journal: posted on the waiver\'s own approval in HR');
  assert.deepEqual(await linesOf(id), [['Advance Waivers', 500 * R, 0], ['Staff Advances', 0, 500 * R]]);
  assert.deepEqual(await coversOf(id), [['hr_waiver', waiver]]);
});

test('R21: a change to an ended month\'s hidden money reverses its combined entry and posts it again', gate, async () => {
  // A third hidden payout of January, entered late: swept by md, the old entry is reversed at once and the new one holds three.
  await fx.payBatch({ lineIds: [await decLine('H5')], channel: 'COLOUR', batchNo: 'CI-PAY-0203', paidOn: '2027-01-15', by: MD.id });
  const swept = await hidden('2027-02-05');
  assert.equal(swept.posted, 1, JSON.stringify(swept));
  const rev = await reversalOf(bankJan);
  assert.deepEqual([rev.status, rev.approved_by_id, rev.self_approved], ['posted', MD.id, true]);
  const [now] = await hiddenOf(L['Bank – current'], 202701);
  assert.notEqual(now, bankJan);
  const v = await voucherRow(now);
  assert.deepEqual([v.narration, v.voucher_date], ['Salary · combined · 3 people', '2027-01-20']);
  assert.deepEqual(await linesOf(now), [['Salary Payable', 95000 * R, 0], ['Bank – current', 0, 95000 * R]]);

  // H2's payout failed since: swept by the accounts login, the reversal waits for md, and the new entry waits behind it.
  await fx.markLine(await decLine('H2'), 'failed');
  const waits = await hidden('2027-02-06', ACCT);
  assert.deepEqual([waits.posted, waits.submitted], [0, 1], JSON.stringify(waits));
  assert.deepEqual(await hiddenOf(L['Bank – current'], 202701), [now], 'the old entry stands while its reversal waits');
  await approve((await reversalOf(now)).id);
  await hidden('2027-02-06', ACCT);
  const [last] = await hiddenOf(L['Bank – current'], 202701);
  const lv = await voucherRow(last);
  assert.deepEqual([lv.narration, lv.voucher_date], ['Salary · combined · 2 people', '2027-01-15']);
  assert.deepEqual(await linesOf(last), [['Salary Payable', 57000 * R, 0], ['Bank – current', 0, 57000 * R]]);
  bankJan = last;
});

test('R27: un-hide a person whose January advance sits in January\'s posted combined entry; a later post of that advance posts nothing', gate, async () => {
  const [cashJan] = await hiddenOf(L['Office cash'], 202701);
  await fx.unhide(decPeople.H3);
  assert.deepEqual(await post('advance', DEC.h3Advance, MD), { result: 'skipped', reason_code: 'in_combined' });
  assert.equal(await count(`fin_vouchers WHERE source_type LIKE 'hr\\_advance%' AND source_id = ${Number(DEC.h3Advance)}`), 0);
  // The combined entry keeps what it booked: swept again, nothing moves.
  await hidden('2027-02-07');
  assert.deepEqual(await hiddenOf(L['Office cash'], 202701), [cashJan]);
  // What was never booked follows the hidden list as it is now: the un-hidden person's next advance posts on its own.
  const next = await post('advance', await fx.advance({ person: decPeople.H3, date: '2027-02-09', rupees: 800, paidVia: 'cash', by: MD.id }), MD);
  assert.equal(next.result, 'posted', JSON.stringify(next));
  // The other way round: a person hidden after their payout was booked in a batch keeps that booking, and no combined entry
  // takes it again.
  const batch = await fx.payBatch({ lineIds: [await decLine('P')], channel: 'COLOUR', batchNo: 'CI-PAY-0301', paidOn: '2027-01-11', by: MD.id });
  const booked = await post('batch', batch, MD);
  assert.equal(booked.result, 'posted', JSON.stringify(booked));
  await fx.hide(decPeople.P, { user: ACCT.id });
  await hidden('2027-02-07');
  assert.deepEqual(await hiddenOf(L['Bank – current'], 202701), [bankJan], 'January\'s bank entry is as it was');
  assert.deepEqual(await post('batch', batch, MD), { result: 'posted', voucher_id: booked.voucher_id, already: true });
  // …and a batch of two whose one person is hidden since keeps both: posted again, nothing moves, and no combined entry takes the line.
  const pair = await lineOfAll(janRun.id, [JAN.people[11], JAN.people[12]]);   // persons 12 and 13
  const two = await fx.payBatch({ lineIds: pair, channel: 'CASH', batchNo: 'CI-PAY-0302', paidOn: '2027-02-08', by: MD.id });
  const both = await post('batch', two, MD);
  assert.equal((await voucherRow(both.voucher_id)).narration, 'Salary Jan · cash · CI-PAY-0302 · 2 people');
  await fx.hide(JAN.people[11], { user: ACCT.id });
  const [cashFeb] = await hiddenOf(L['Office cash'], 202702);
  await hidden('2027-03-01');
  assert.deepEqual(await hiddenOf(L['Office cash'], 202702), [cashFeb], 'February\'s cash entry does not take the line the batch booked');
  assert.deepEqual(await post('batch', two, MD), { result: 'posted', voucher_id: both.voucher_id, already: true }, 'the batch keeps its booking');
});

test('R21 × R24: a hidden person\'s money that crosses books posts its combined entry as the pair', gate, async () => {
  const h6 = await fx.person({ name: 'Test December H6', firm: 'DARBI', channel: 'DARBI' });
  await fx.hide(h6, { user: ACCT.id });
  decPeople.H6 = h6;
  const adv = await fx.advance({ person: h6, date: '2027-03-10', rupees: 4500, paidVia: 'cash', by: MD.id });
  assert.deepEqual(await post('advance', adv, MD), { result: 'skipped', reason_code: 'hidden' });
  const swept = await hidden('2027-04-01');
  assert.equal(swept.posted, 1, JSON.stringify(swept));
  const [ciId] = await hiddenOf(L['Office cash'], 202703);
  const [dpId] = await standing(`hr_hidden:${L['Office cash']}:DP`, 202703);
  const [ci, dp] = [await voucherRow(ciId), await voucherRow(dpId)];
  assert.deepEqual([ci.book_id, ci.voucher_type, ci.voucher_date, ci.narration],
    [CI, 'payment', '2027-03-10', 'Staff money · combined · 1 person · paid for Darbi Print Pack']);
  assert.deepEqual(await linesOf(ci.id), [['Darbi Print Pack', 4500 * R, 0], ['Office cash', 0, 4500 * R]]);
  assert.deepEqual([dp.book_id, dp.voucher_type, dp.voucher_date, dp.narration, dp.status],
    [DP, 'journal', '2027-03-10', 'Staff money · combined · 1 person · paid by Colour Impressions', 'posted']);
  assert.deepEqual(await linesOf(dp.id), [['Staff Advances', 4500 * R, 0], ['Colour Impressions', 0, 4500 * R]]);
  assert.deepEqual(await coversOf(dp.id), [['hr_advance', adv]], 'the DP person\'s row, on DP\'s voucher');
  assert.deepEqual(await coversOf(ci.id), [['hr_advance', adv]], '…and on CI\'s: each voucher of a pair lists every row the pair books');
});

test('R34 × R21: a combined pair whose half an Approver sent back is made again at the next sweep; the half that stands is kept', gate, async () => {
  // A hidden Colour person's advance from DP's bank, given by the accounts login with no HR approval: DP's payment needs no Approver
  // and posts; CI's journal waits for md.
  const h9 = await fx.person({ name: 'Test December H9', channel: 'DARBI' });
  await fx.hide(h9, { user: ACCT.id });
  decPeople.H9 = h9;
  await fx.advance({ person: h9, date: '2027-03-14', rupees: 3000, paidVia: 'DARBI', by: ACCT.id });
  const swept = await hidden('2027-04-01', ACCT);
  assert.deepEqual([swept.posted, swept.submitted, swept.exceptions], [0, 1, []], JSON.stringify(swept));
  const key = `hr_hidden:${D['DP Bank']}`;
  const [ciId] = await standing(key, 202703);
  const [dpId] = await standing(`${key}:DP`, 202703);
  const [ci, dp] = [await voucherRow(ciId), await voucherRow(dpId)];
  assert.deepEqual([ci.voucher_type, ci.status, dp.voucher_type, dp.status], ['journal', 'submitted', 'payment', 'posted']);
  const ciLines = await linesOf(ci.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the March advance in HR' }, 'md'));
  const dpTrail = await count(`fin_audit_log WHERE entity = 'voucher' AND entity_id = ${Number(dp.id)}`);

  const again = await hidden('2027-04-01', ACCT);
  assert.deepEqual(again, { posted: 0, submitted: 1, skipped: 0, exceptions: [] }, 'the entry is due again: a book of it does not stand');
  const [remade] = await standing(key, 202703);
  assert.ok(remade && remade !== ci.id, 'CI\'s half made again');
  assert.deepEqual([(await voucherRow(remade)).status, (await voucherRow(ci.id)).status], ['submitted', 'discarded']);
  assert.deepEqual(await linesOf(remade), ciLines);
  assert.deepEqual(await standing(`${key}:DP`, 202703), [dp.id], 'the half that stands is kept');
  assert.equal(await count(`fin_audit_log WHERE entity = 'voucher' AND entity_id = ${Number(dp.id)}`), dpTrail, 'nothing written on it');
  assert.deepEqual(await hidden('2027-04-01', ACCT), { posted: 0, submitted: 0, skipped: 0, exceptions: [] }, 'both books stand: nothing is due');
});

// ── Who is hidden changes while half of a pair is sent back (rulings R27, R34) ───────────────

test('R27 × R34: a person hidden while CI\'s half of their DARBI batch is sent back stays booked by the batch: no combined entry takes the line, and the half is made again', gate, async () => {
  const { batch, ci, dp, people, run } = await waitingPair('2026-07', 'CI-PAY-0405', '2027-02-17', ['Test Wait Pair 9', 'Test Wait Pair 10']);
  await approve(dp.id);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the batch in HR' }, 'md'));
  await fx.hide(people[0], { user: ACCT.id });
  // The sweep after February: the line is booked by the batch's DP half, which stands, so DP's bank is not credited for it twice.
  assert.deepEqual(await hidden('2027-04-01'), { posted: 0, submitted: 0, skipped: 0, exceptions: [] });
  assert.deepEqual(await standing(`hr_hidden:${D['DP Bank']}:DP`, 202702), [], 'no combined entry of DP\'s bank for February');
  const lines = run.lineIds.map(id => ['hr_line_pay', id]).sort((x, y) => x[1] - y[1]);
  assert.deepEqual(await coversOf(dp.id), lines, 'DP\'s half lists the lines it pays');
  // The batch keeps its booking, the hidden person's line included: CI's half is made again (R34).
  const again = await post('batch', batch);
  assert.equal(again.result, 'submitted', JSON.stringify(again));
  const [remadeId] = again.voucher_ids;
  assert.deepEqual(again, { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id] });
  assert.deepEqual(await linesOf(remadeId), await linesOf(ci.id));
  assert.deepEqual(await coversOf(remadeId), lines);
  assert.deepEqual(await hidden('2027-04-01'), { posted: 0, submitted: 0, skipped: 0, exceptions: [] }, 'and still nothing for a combined entry');
});

test('R27 × R34: a person shown again while the people\'s half of their combined pair is sent back stays in the combined entry: the advance posts nothing of its own, and the sweep makes the half again', gate, async () => {
  const h10 = await fx.person({ name: 'Test December H10', channel: 'DARBI' });
  await fx.hide(h10, { user: ACCT.id });
  const adv = await fx.advance({ person: h10, date: '2027-01-24', rupees: 2700, paidVia: 'DARBI', by: ACCT.id });
  const swept = await hidden('2027-04-01', ACCT);
  assert.deepEqual([swept.posted, swept.submitted, swept.exceptions], [0, 1, []], JSON.stringify(swept));
  const key = `hr_hidden:${D['DP Bank']}`;
  const [ciId] = await standing(key, 202701);
  const [dpId] = await standing(`${key}:DP`, 202701);
  await ok(h.call('POST', `/finance/vouchers/${ciId}/reject`, { reason: 'Check the January advance in HR' }, 'md'));
  await fx.unhide(h10);
  // Shown again, the advance is still the combined entry's: its DP half stands and books it, so DP's bank pays it once.
  assert.deepEqual(await post('advance', adv), { result: 'skipped', reason_code: 'in_combined' });
  assert.equal(await count(`fin_vouchers WHERE source_type IN ('hr_advance', 'hr_advance:DP') AND source_id = ${Number(adv)}`), 0);
  assert.deepEqual(await coversOf(dpId), [['hr_advance', adv]], 'the account\'s half lists the row');
  // The sweep makes the sent-back half again (R34), the row still the entry's.
  assert.deepEqual(await hidden('2027-04-01', ACCT), { posted: 0, submitted: 1, skipped: 0, exceptions: [] });
  const [remade] = await standing(key, 202701);
  assert.ok(remade && remade !== ciId, 'CI\'s half made again');
  assert.deepEqual(await standing(`${key}:DP`, 202701), [dpId], 'the half that stands is kept');
  assert.deepEqual(await coversOf(remade), [['hr_advance', adv]]);
  assert.deepEqual(await hidden('2027-04-01', ACCT), { posted: 0, submitted: 0, skipped: 0, exceptions: [] });
});

test('R27 × R34: a person hidden while CI\'s half of their advance from DP\'s bank is sent back keeps the advance\'s own booking: the half is made again', gate, async () => {
  const p = await fx.person({ name: 'Test Hidden Later', channel: 'DARBI' });
  const adv = await fx.advance({ person: p, date: '2027-02-18', rupees: 5200, paidVia: 'DARBI', by: ACCT.id });
  const first = await post('advance', adv);
  assert.equal(first.result, 'submitted', JSON.stringify(first));
  const [ci, dp] = await Promise.all(first.voucher_ids.map(voucherRow));
  assert.deepEqual([ci.book_id, ci.status, dp.book_id, dp.status], [CI, 'submitted', DP, 'posted']);
  await ok(h.call('POST', `/finance/vouchers/${ci.id}/reject`, { reason: 'Check the advance in HR' }, 'md'));
  await fx.hide(p, { user: ACCT.id });
  // Its own pair books it (DP's half stands), so it is no hidden person's skip: CI's Staff Advances gets its half again (R34).
  const again = await post('advance', adv);
  assert.equal(again.result, 'submitted', JSON.stringify(again));
  const [remadeId] = again.voucher_ids;
  assert.deepEqual(again, { result: 'submitted', voucher_id: remadeId, voucher_ids: [remadeId, dp.id] });
  assert.deepEqual([(await voucherRow(remadeId)).narration, await linesOf(remadeId)], [ci.narration, await linesOf(ci.id)]);
  assert.equal((await voucherRow(ci.id)).status, 'discarded');
  assert.deepEqual(await hidden('2027-04-01'), { posted: 0, submitted: 0, skipped: 0, exceptions: [] }, 'no combined entry takes the row');
});

test('a combined entry that cannot post waits as an exception of its own; an HR request leaves it to Bring-in, which posts it once its account is mapped', gate, async () => {
  await makeLedger(CI, 'Bank Accounts', 'Bank – spare');
  const h7 = await fx.person({ name: 'Test December H7', channel: 'SPARE' });
  await fx.hide(h7, { user: ACCT.id });
  decPeople.H7 = h7;
  await fx.advance({ person: h7, date: '2027-03-12', rupees: 2600, paidVia: 'SPARE', by: MD.id });
  const swept = await hidden('2027-04-01');
  assert.deepEqual([swept.posted, swept.exceptions], [0, ['FIN_UNMAPPED_CHANNEL']], JSON.stringify(swept));
  const ex = await exceptionOf('hr_hidden:unmapped', 202703);
  assert.deepEqual([ex.reason_code, ex.reason, ex.resolved_at], ['FIN_UNMAPPED_CHANNEL', FIN_SENTENCES.FIN_UNMAPPED_CHANNEL, null]);
  const tried = async () => (await h.db.one(`SELECT last_tried_at FROM fin_hr_exceptions WHERE id = $1`, [ex.id])).last_tried_at.getTime();
  const was = await tried();
  // After an HR request (finHrAfter sweeps with retry false), an entry with an open exception is not tried again.
  assert.deepEqual(await feed.finHrPostHidden(MD, { asOf: '2027-04-01', retry: false }), { posted: 0, submitted: 0, skipped: 0, exceptions: [] });
  assert.equal(await tried(), was, 'not tried again');
  // Mapped, the next Bring-in posts it under its account, and resolves the month's unmapped exception.
  await saveSetup({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – spare'] }] });
  const now = await hidden('2027-04-01');
  assert.deepEqual([now.posted, now.exceptions], [1, []], JSON.stringify(now));
  const [id] = await hiddenOf(L['Bank – spare'], 202703);
  assert.deepEqual([(await voucherRow(id)).narration, await linesOf(id)],
    ['Staff money · combined · 1 person', [['Staff Advances', 2600 * R, 0], ['Bank – spare', 0, 2600 * R]]]);
  assert.ok((await exceptionOf('hr_hidden:unmapped', 202703)).resolved_at, 'the unmapped month is resolved');
  // An entry tried again that stands as it should (here a stale exception names it) posts nothing, is counted so, and closes the exception.
  await h.db.q(`INSERT INTO fin_hr_exceptions (source_type, source_id, book_id, reason_code, reason, last_tried_at)
                VALUES ($1, 202703, $2, 'FIN_PERIOD_LOCKED', 'Mar 2027 is locked. Nothing more can be posted to it.', now())`,
  [`hr_hidden:${L['Bank – spare']}`, CI]);
  const again = await hidden('2027-04-01');
  assert.deepEqual(again, { posted: 0, submitted: 0, skipped: 1, exceptions: [] });
  const stale = await exceptionOf(`hr_hidden:${L['Bank – spare']}`, 202703);
  assert.deepEqual([Boolean(stale.resolved_at), stale.voucher_id], [true, id]);
});

// ── One feed at a time (ruling R33) ──────────────────────────────────────────────────────────

test('R33: every feed transaction that books takes the one feed lock first: a post, a combined entry and finHrReverse each wait for another holder of it', gate, async () => {
  // Made first, through the pool: while a feed transaction waits it holds the pool's one client.
  const p = await fx.person({ name: 'Test Lock Person' });
  const adv = await fx.advance({ person: p, date: '2027-02-15', rupees: 1800, paidVia: 'cash', by: MD.id });
  const h8 = await fx.person({ name: 'Test December H8' });
  await fx.hide(h8, { user: ACCT.id });
  decPeople.H8 = h8;
  await fx.advance({ person: h8, date: '2027-02-16', rupees: 2200, paidVia: 'COLOUR', by: MD.id });
  const connect = async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; };
  const holder = await connect();
  const watcher = await connect();
  let pending = null;
  // Resolves once some backend waits for the feed lock, 7303/0, and has still settled nothing 300 ms later.
  const waitsForTheFeedLock = async settled => {
    for (let i = 0; ; i++) {
      assert.equal(settled(), null, `it did not wait: ${JSON.stringify(settled())}`);
      const { rows: [w] } = await watcher.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = 7303 AND objid = 0`);
      if (w.n > 0) break;
      assert.ok(i < 200, 'nothing ever waited for the feed lock');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(settled(), null, 'still waiting 300 ms later');
  };
  const held = async work => {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(7303, 0)');
    let settled = null;
    pending = work().then(value => { settled = { value }; }, error => { settled = { error }; });
    await waitsForTheFeedLock(() => settled);
    await holder.query('COMMIT');
    await pending;
    pending = null;
    assert.equal(settled.error, undefined, settled.error?.stack);
    return settled.value;
  };
  try {
    const posted = await held(() => post('advance', adv, MD));
    assert.equal(posted.result, 'posted', JSON.stringify(posted));
    const swept = await held(() => hidden('2027-04-01'));
    assert.deepEqual([swept.posted, swept.exceptions], [1, []], JSON.stringify(swept));
    const reversed = await held(() => h.db.tx((qc, oc) => feed.finHrReverse(qc, oc, 'hr_advance', adv, MD)));
    assert.deepEqual([reversed.result, reversed.voucher_ids.length], ['posted', 1], JSON.stringify(reversed));
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await pending?.catch(() => {});
    await Promise.allSettled([holder.end(), watcher.end()]);
  }
  const [entry] = await hiddenOf(L['Bank – current'], 202702);
  assert.deepEqual([(await voucherRow(entry)).narration, await linesOf(entry)],
    ['Staff money · combined · 1 person', [['Staff Advances', 2200 * R, 0], ['Bank – current', 0, 2200 * R]]]);
});

// ── A feed transaction waits five seconds at most (ruling R73) ─────────────────────────────────

test('R73: a held feed lock makes a post, a combined entry and finHrReverse each give up within about 5 s, the post and the entry waiting as exceptions; never a hang', gate, async () => {
  const { finMapDbError } = await import('./finance-errors.js');
  // Made first, through the pool: while a feed transaction waits it holds the pool's one client.
  const p = await fx.person({ name: 'Test Busy Person' });
  const adv = await fx.advance({ person: p, date: '2027-02-17', rupees: 1300, paidVia: 'cash', by: MD.id });
  const taken = await fx.advance({ person: p, date: '2027-02-18', rupees: 700, paidVia: 'cash', by: MD.id });
  assert.equal((await post('advance', taken, MD)).result, 'posted');
  const h10 = await fx.person({ name: 'Test December H10' });
  await fx.hide(h10, { user: ACCT.id });
  decPeople.H10 = h10;
  await fx.advance({ person: h10, date: '2027-02-19', rupees: 1100, paidVia: 'SPARE', by: MD.id });
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  // `work` settled, or null if it has not within 15 s: a feed transaction with no lock timeout would wait as long as the holder holds on.
  const within = async work => {
    const started = Date.now();
    const running = work().then(value => ({ value }), error => ({ error }));
    const settled = await Promise.race([running, new Promise(resolve => setTimeout(() => resolve(null), 15000))]);
    return { settled, waited: Date.now() - started, running };
  };
  const pending = [];
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(7303, 0)');   // the feed's lock, held as a long Bring-in would hold it
    const gaveUp = (attempt, what) => {
      pending.push(attempt.running);
      assert.ok(attempt.settled, `${what} was still waiting after 15 s: it would hang behind the lock`);
      assert.ok(attempt.waited >= 4500 && attempt.waited < 10000, `${what} gave up after ${attempt.waited} ms`);
      return attempt.settled;
    };
    const posted = gaveUp(await within(() => post('advance', adv, MD)), 'a post');
    assert.deepEqual(posted.value, { result: 'exception', reason_code: 'FIN_BUSY' });
    const swept = gaveUp(await within(() => hidden('2027-03-01')), 'a combined entry');
    assert.deepEqual(swept.value, { posted: 0, submitted: 0, skipped: 0, exceptions: ['FIN_BUSY'] });
    const reversed = gaveUp(await within(() => h.db.tx((qc, oc) => feed.finHrReverse(qc, oc, 'hr_advance', taken, MD))), 'finHrReverse');
    assert.equal(reversed.error?.code, '55P03', 'it throws, and its caller\'s transaction is rolled back');
    assert.equal(finMapDbError(reversed.error).body.code, 'FIN_BUSY');
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
    await Promise.allSettled(pending);
  }
  // Nothing moved meanwhile, and the timeout stayed in those transactions: the pool's connection has none.
  assert.equal((await exceptionOf('hr_advance', adv)).reason_code, 'FIN_BUSY');
  assert.equal(FIN_SENTENCES.FIN_BUSY, (await exceptionOf('hr_advance', adv)).reason);
  assert.equal((await exceptionOf(`hr_hidden:${L['Bank – spare']}`, 202702)).reason_code, 'FIN_BUSY');
  assert.deepEqual([await standing('hr_advance', adv), (await standing('hr_advance', taken)).length], [[], 1]);
  assert.equal((await h.db.one('SHOW lock_timeout')).lock_timeout, '0');
  // The lock let go: each posts on its next try (a retry, or Bring-in), and its exception is resolved.
  const again = await post('advance', adv, MD);
  assert.equal(again.result, 'posted', JSON.stringify(again));
  assert.ok((await exceptionOf('hr_advance', adv)).resolved_at);
  assert.deepEqual((await hidden('2027-03-01')).posted, 1);
  assert.ok((await exceptionOf(`hr_hidden:${L['Bank – spare']}`, 202702)).resolved_at);
});

// ── Last: over everything posted above ──────────────────────────────────────────────────────

test('privacy: no hr.people name or code reaches Finance, and hidden people\'s rows are booked only by combined entries', gate, async () => {
  const people = await h.db.q('SELECT name, code FROM hr.people');
  assert.ok(people.length > 60, `non-vacuous: ${people.length} people`);
  const texts = [
    ...(await h.db.q('SELECT narration, reference, created_by, submitted_by, approved_by, posted_by, source_type FROM fin_vouchers')).flatMap(v => Object.values(v)),
    ...(await h.db.q('SELECT narration, bill_ref FROM fin_voucher_lines')).flatMap(l => Object.values(l)),
    ...(await h.db.q('SELECT user_name, reason, before::text AS before, after::text AS after FROM fin_audit_log')).flatMap(a => Object.values(a)),
    ...(await h.db.q('SELECT reason FROM fin_hr_exceptions')).map(x => x.reason),
    ...(await h.db.q(`SELECT title, body FROM notifications WHERE ref_table = 'fin_vouchers'`)).flatMap(n => Object.values(n)),
  ].filter(t => typeof t === 'string');
  assert.ok(texts.some(t => t.includes('combined')), 'non-vacuous: the combined entries are among them');
  for (const { name, code } of people) {
    for (const word of [name, code]) assert.equal(texts.find(t => t.includes(word)), undefined, `${word} reached Finance`);
  }
  // H1, H2, H4, H5, H6, H7, H8 and H9 were hidden throughout: none of their rows is any voucher's own source, and only combined entries book them.
  const rows = [
    ...(await h.db.q(`SELECT 'hr_line_pay' AS t, l.id FROM hr.run_lines l WHERE l.person_id = ANY($1::int[])`, [[decPeople.H1, decPeople.H2, decPeople.H5]])),
    ...(await h.db.q(`SELECT 'hr_loan' AS t, id FROM hr.loans WHERE person_id = $1`, [decPeople.H4])),
    ...(await h.db.q(`SELECT 'hr_prepay' AS t, x.id FROM hr.loan_txns x JOIN hr.loans l ON l.id = x.loan_id WHERE l.person_id = $1 AND x.kind = 'prepayment'`,
      [decPeople.H4])),
    ...(await h.db.q(`SELECT 'hr_advance' AS t, id FROM hr.advance_txns WHERE person_id = ANY($1::int[])`, [[decPeople.H6, decPeople.H7, decPeople.H8, decPeople.H9]])),
  ];
  assert.ok(rows.length >= 8, `non-vacuous: ${rows.length} rows`);
  for (const r of rows) {
    assert.equal(await count(`fin_vouchers WHERE source_type IN ('${r.t}', '${r.t}:DP') AND source_id = ${Number(r.id)}`), 0, `${r.t} ${r.id} has a voucher of its own`);
    const by = await h.db.q(`SELECT v.source_type FROM fin_hr_covers c JOIN fin_vouchers v ON v.id = c.voucher_id WHERE c.source_type = $1 AND c.source_id = $2`, [r.t, r.id]);
    assert.ok(by.length && by.every(b => b.source_type.startsWith('hr_hidden:')), `${r.t} ${r.id} booked by ${by.map(b => b.source_type)}`);
  }
});
