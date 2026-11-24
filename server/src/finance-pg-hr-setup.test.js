import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';

// HR's money in the books, the setup (Cash & Bank spec §7.2, §7.3, §7.8, §7.9; ledger ruling R10): the account each HR pay channel
// pays from, the ledger of each role, the expense map, when the payroll month is booked, the staff ledgers, the "paid from" list HR's
// doors offer, and several Tally ledgers summed onto one staff ledger at the import. Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-setup.test.js
//
// One boot for the file; the tests share it and run in order: the staff ledgers made first are the ones the import tests match to,
// and the channels mapped early are the ones the paid-from list shows. The HR pay channels are invented rows put in with SQL (HR is
// read here, never written). Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, hrs, CI, DP;
const L = {};    // CI ledger name -> id
const D = {};    // DP ledger name -> id
const GROUPS = {};

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
function refused(r, status, code, field) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field !== undefined) assert.equal(r.body?.field, field, JSON.stringify(r.body));
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
const setup = (book, who = 'md') => h.call('GET', `/finance/hr-setup?book=${book}`, null, who);
const save = (body, who = 'md') => h.call('PUT', '/finance/hr-setup', body, who);
const ensure = (book, who = 'md') => h.call('POST', '/finance/hr-setup/ledgers', { book_id: book }, who);
const ledgerRow = id => h.db.one('SELECT id, book_id, name, group_id, manual_entry, active FROM fin_ledgers WHERE id = $1', [id]);
const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });
// Everything the setup can write, counted: a refused save leaves every figure as it was.
const written = async () => ({
  channels: (await h.db.one('SELECT COUNT(*)::int n FROM fin_hr_channels')).n,
  roles: (await h.db.one('SELECT COUNT(*)::int n FROM fin_ledger_roles')).n,
  expense: (await h.db.one('SELECT COUNT(*)::int n FROM fin_hr_expense_map')).n,
  settings: await h.db.q('SELECT book_id, payroll_booking, updated_by FROM fin_book_settings ORDER BY book_id'),
  ledgers: await h.db.q('SELECT id, manual_entry FROM fin_ledgers ORDER BY id'),
  audit: (await h.db.one('SELECT COUNT(*)::int n FROM fin_audit_log')).n,
});
async function refusedAndNothingWritten(call, status, code, field) {
  const was = await written();
  const r = refused(await call, status, code, field);
  assert.deepEqual(await written(), was, 'a refused request writes nothing');
  return r;
}
const hrAudit = book => h.db.q(
  `SELECT user_name, before, after FROM fin_audit_log WHERE book_id = $1 AND entity = 'book' AND action = 'hr_setup' ORDER BY id`, [book]);

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-setup');
  hrs = await import('./finance-hr-setup.js').catch(() => ({}));
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const book of [CI, DP]) GROUPS[book] = (await ok(h.call('GET', `/finance/books/${book}/groups`, null, 'md'))).groups;
  for (const l of await h.db.q('SELECT id, book_id, name FROM fin_ledgers')) (l.book_id === CI ? L : D)[l.name] = l.id;

  // HR's pay channels (invented): the cash channel, two banks, one bank switched off in HR, and one never mapped.
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind, active) VALUES
    ('CASH', 'Cash', 'cash', true), ('COLOUR', 'Colour bank', 'bank', true), ('DARBI', 'Darbi bank', 'bank', true),
    ('OLD BANK', 'Old bank', 'bank', false), ('SPARE', 'Spare bank', 'bank', true)`);

  await makeLedger(CI, 'Cash-in-Hand', 'Office cash');
  await makeLedger(CI, 'Cash-in-Hand', 'Holder A Cash', { holder_name: 'Holder A' });
  await makeLedger(CI, 'Cash-in-Hand', 'Closed Till');
  await makeLedger(CI, 'Bank Accounts', 'Bank – current');
  await makeLedger(CI, 'Bank Accounts', 'Bank – old');          // mapped, for a while, only by a channel HR has switched off
  await makeLedger(CI, 'Bank Accounts', 'Bank – unmapped');     // a CI bank no channel pays from
  await makeLedger(CI, 'Bank Accounts', 'Bank – later off');    // mapped, then switched off
  await makeLedger(CI, 'Indirect Expenses', 'Test Rent');
  await makeLedger(CI, 'Indirect Expenses', 'Cash Short & Excess');
  await makeLedger(CI, 'Indirect Expenses', 'Cash Short Two');
  await makeLedger(CI, 'Indirect Expenses', 'Contract Labour Test');
  await makeLedger(CI, 'Indirect Expenses', 'Old Rounding');          // switched off before anything points at it
  await makeLedger(CI, 'Indirect Expenses', 'Rounding – later off');  // pointed at, then switched off
  await makeLedger(CI, 'Loans & Advances (Asset)', 'Advances Test Two');   // an ordinary ledger the staff_advances role moves to (R20)
  await makeLedger(CI, 'Indirect Expenses', 'Wages Test Ledger');           // an ordinary ledger an expense key is pointed at (R20)
  await makeLedger(CI, 'Sundry Debtors', 'Customer Test Co');               // a party's ledger, no staff ledger's place (R20a)
  await ok(h.call('PUT', `/finance/ledgers/${L['Closed Till']}`, { active: false }, 'md'));
  await ok(h.call('PUT', `/finance/ledgers/${L['Old Rounding']}`, { active: false }, 'md'));
  await makeLedger(DP, 'Bank Accounts', 'DP Bank');
  await makeLedger(DP, 'Bank Accounts', 'DP Old Bank');
  await ok(h.call('PUT', `/finance/ledgers/${D['DP Old Bank']}`, { active: false }, 'md'));
  await makeLedger(DP, 'Indirect Expenses', 'DP Rent');
  await makeLedger(DP, 'Loans & Advances (Asset)', 'DP Advances Two');
  await makeLedger(DP, 'Current Liabilities', 'Wages Payable Test');
  // DP already has ledgers of two staff ledgers' names, as a Tally import makes them: Staff Advances, filed under Sundry Debtors (so a
  // party's, which no staff ledger may be until it is filed elsewhere: R20a), and Salaries & Wages, switched off (R20). And it has picked
  // its own Salary Payable ledger. Setting up the staff ledgers keeps the groups and that pick, and makes the ledgers it gives a staff
  // role system-only (R20).
  await makeLedger(DP, 'Sundry Debtors', 'Staff Advances');
  await makeLedger(DP, 'Indirect Expenses', 'Salaries & Wages');
  await makeLedger(DP, 'Sundry Creditors', "MD's Account");   // a party's ledger too, which md_account may be: no staff ledger (R20a)
  await ok(h.call('PUT', `/finance/ledgers/${D['Salaries & Wages']}`, { active: false }, 'md'));
  await h.db.q(`INSERT INTO fin_ledger_roles (book_id, role, ledger_id) VALUES ($1, 'salary_payable', $2)`, [DP, D['Wages Payable Test']]);
});

after(async () => { await h?.close(); });

// ── The brief's six, and the resolutions beside them ─────────────────────────────────────────

test('ensure staff ledgers creates the five once (a second call creates none), the four staff ledgers manual_entry false, MD\'s Account true, and sets the roles', gate, async () => {
  const first = await ok(ensure(CI));
  assert.deepEqual(first.created, ['Staff Advances', 'Staff Loans', 'Salary Payable', 'Salaries & Wages', "MD's Account"]);
  // Task 15 fix round, F1: the answer names what it found as well as what it made, and what now takes no typed entry
  assert.deepEqual([first.found, first.system_only], [[], ['Staff Advances', 'Staff Loans', 'Salary Payable', 'Salaries & Wages']]);
  const made = await h.db.q(
    `SELECT l.id, l.name, g.name AS group_name, l.manual_entry, l.active FROM fin_ledgers l JOIN fin_groups g ON g.id = l.group_id
      WHERE l.book_id = $1 AND l.name = ANY($2::text[]) ORDER BY l.id`, [CI, first.created]);
  assert.deepEqual(made.map(l => [l.name, l.group_name, l.manual_entry, l.active]), [
    ['Staff Advances', 'Loans & Advances (Asset)', false, true],
    ['Staff Loans', 'Loans & Advances (Asset)', false, true],
    ['Salary Payable', 'Current Liabilities', false, true],
    ['Salaries & Wages', 'Indirect Expenses', false, true],
    ["MD's Account", 'Unsecured Loans', true, true],
  ]);
  for (const l of made) L[l.name] = l.id;
  const roles = { staff_advances: L['Staff Advances'], staff_loans: L['Staff Loans'], salary_payable: L['Salary Payable'],
    salary_expense: L['Salaries & Wages'], md_account: L["MD's Account"] };
  assert.deepEqual(first.roles, roles, 'the answer carries the setup as it now stands');
  assert.deepEqual((await ok(setup(CI, 'viewer'))).roles, roles);
  // Each ledger writes its own rows, as it does wherever it is made: made, and (the four) made system-only.
  const ledgerAudit = await h.db.q(`SELECT entity_id, action, after FROM fin_audit_log WHERE entity = 'ledger' AND entity_id = ANY($1::int[]) ORDER BY id`,
    [made.map(l => l.id)]);
  assert.equal(ledgerAudit.filter(a => a.action === 'create').length, 5);
  assert.deepEqual(ledgerAudit.filter(a => a.action === 'edit').map(a => [a.entity_id, a.after.manual_entry]),
    made.filter(l => !l.manual_entry).map(l => [l.id, false]));
  const [row] = await hrAudit(CI);
  assert.equal(row.user_name, 'Test MD');
  assert.deepEqual(row.after.roles, roles);
  assert.deepEqual(row.after.created, first.created);

  // Again: nothing is missing, so nothing is made, nothing changes and nothing is written.
  const was = await written();
  const again = await ok(ensure(CI));
  assert.deepEqual([again.created, again.found, again.system_only], [[], [], []], 'nothing made, found or changed');
  assert.deepEqual(again.roles, roles);
  assert.deepEqual(await written(), was);

  // DP: a ledger of the name that is switched off is never given the role (R20). The whole call is refused, naming it, and nothing is
  // written, the other ledgers it would have made included.
  const off = await refusedAndNothingWritten(ensure(DP), 400, 'FIN_BAD_INPUT');
  assert.equal(off.body.error, "Switch 'Salaries & Wages' back on, or rename it, before creating the staff ledgers.");
  await ok(h.call('PUT', `/finance/ledgers/${D['Salaries & Wages']}`, { active: true }, 'md'));
  // ...and nor is one that is a bank, cash or party ledger (R20a): DP's Staff Advances is filed under Sundry Debtors. Refused the same
  // way, naming it, until the Admin files it elsewhere.
  const party = await refusedAndNothingWritten(ensure(DP), 400, 'FIN_BAD_INPUT');
  assert.equal(party.body.error, "A staff ledger can't be a bank, cash or party ledger, and 'Staff Advances' is one: file it elsewhere, "
    + 'or rename it, before creating the staff ledgers.');
  await ok(h.call('PUT', `/finance/ledgers/${D['Staff Advances']}`, { group_id: groupOf(DP, 'Loans & Advances (Asset)') }, 'md'));
  // Then: a ledger of the name is used where it is filed, and is made system-only (R20; Important 1), with its own edit row; a role
  // the accountant set stays where it is, its ledger's flags untouched.
  const dpAdvances = await ledgerRow(D['Staff Advances']);
  const dpWagesPayable = await ledgerRow(D['Wages Payable Test']);
  assert.equal(dpAdvances.manual_entry, true, 'made by hand, as a Tally import makes it');
  const dp = await ok(ensure(DP));
  assert.deepEqual(dp.created, ['Staff Loans']);
  // F1: found by their names and given their roles (Salary Payable kept the accountant's own pick, so it is neither); the three staff
  // ledgers among them now take no typed entry, MD's Account still does
  assert.deepEqual(dp.found, ['Staff Advances', 'Salaries & Wages', "MD's Account"]);
  assert.deepEqual(dp.system_only, ['Staff Advances', 'Staff Loans', 'Salaries & Wages']);
  assert.deepEqual(await ledgerRow(D['Staff Advances']), { ...dpAdvances, manual_entry: false }, 'its group kept, made system-only');
  assert.deepEqual([(await ledgerRow(D['Salaries & Wages'])).manual_entry, (await ledgerRow(D['Salaries & Wages'])).group_id],
    [false, groupOf(DP, 'Indirect Expenses')]);
  assert.deepEqual(await ledgerRow(D['Wages Payable Test']), dpWagesPayable, "the accountant's own pick keeps its flags");
  const flipped = await h.db.q(`SELECT entity_id, user_name, before, after FROM fin_audit_log WHERE entity = 'ledger' AND action = 'edit'
    AND entity_id = ANY($1::int[]) ORDER BY id`, [[D['Staff Advances'], D['Salaries & Wages']]]);
  assert.deepEqual(flipped.filter(a => a.before.manual_entry === true && a.after.manual_entry === false).map(a => [a.entity_id, a.user_name]).sort(),
    [[D['Staff Advances'], 'Test MD'], [D['Salaries & Wages'], 'Test MD']].sort());
  assert.deepEqual([dp.roles.staff_advances, dp.roles.salary_expense], [D['Staff Advances'], D['Salaries & Wages']]);
  assert.equal(dp.roles.salary_payable, D['Wages Payable Test'], "the accountant's own pick is kept");
  assert.equal((await h.db.one(`SELECT COUNT(*)::int n FROM fin_ledgers WHERE book_id = $1 AND lower(name) = 'salary payable'`, [DP])).n, 0,
    'no Salary Payable is made beside it');
  assert.ok(dp.roles.staff_loans, 'staff_loans');
  // MD's Account found by its name under Sundry Creditors: md_account has no R20a guard, and it keeps its flags (no staff ledger).
  assert.equal(dp.roles.md_account, D["MD's Account"]);
  const mdAccount = await ledgerRow(dp.roles.md_account);
  assert.deepEqual([mdAccount.manual_entry, mdAccount.group_id], [true, groupOf(DP, 'Sundry Creditors')], "MD's Account takes typed entries");
  assert.deepEqual((await ok(ensure(DP))).created, []);
});

test('a channel mapped to a non-bank ledger is refused FIN_BAD_INPUT', gate, async () => {
  const bad = await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'CASH', ledger_id: L['Test Rent'] }] }),
    400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');
  assert.match(bad.body.error, /^Test Rent isn't a bank or cash account/);
  // A role and a channel in one save: the whole save is refused, the good part included.
  await refusedAndNothingWritten(save({ book_id: CI, roles: { rounding: L['Test Rent'] },
    channels: [{ channel_code: 'COLOUR', ledger_id: L['Bank – current'] }, { channel_code: 'CASH', ledger_id: L["MD's Account"] }] }),
  400, 'FIN_BAD_INPUT', 'channels[1].ledger_id');

  // A bank or cash ledger, a holder's or an office's, is what a channel pays from.
  const saved = await ok(save({ book_id: CI, channels: [
    { channel_code: 'CASH', ledger_id: L['Office cash'] }, { channel_code: 'COLOUR', ledger_id: L['Bank – current'] },
    { channel_code: 'OLD BANK', ledger_id: L['Bank – current'] }] }));
  assert.deepEqual(saved.channels, [
    { channel_code: 'CASH', book_id: CI, ledger_id: L['Office cash'] },
    { channel_code: 'COLOUR', book_id: CI, ledger_id: L['Bank – current'] },
    { channel_code: 'OLD BANK', book_id: CI, ledger_id: L['Bank – current'] },
  ]);
  const [row] = (await hrAudit(CI)).slice(-1);
  assert.deepEqual(row.before.channels, { CASH: null, COLOUR: null, 'OLD BANK': null });
  assert.deepEqual(row.after.channels, { CASH: { book_id: CI, ledger_id: L['Office cash'] }, COLOUR: { book_id: CI, ledger_id: L['Bank – current'] },
    'OLD BANK': { book_id: CI, ledger_id: L['Bank – current'] } });
});

test('payroll_booking reads month_end and saves when_paid', gate, async () => {
  assert.equal((await ok(setup(CI))).payroll_booking, 'month_end');
  // A book with no settings row reads month_end too, and a save makes the row.
  await h.db.q('DELETE FROM fin_book_settings WHERE book_id = $1', [DP]);
  assert.equal((await ok(setup(DP))).payroll_booking, 'month_end');

  const saved = await ok(save({ book_id: CI, payroll_booking: 'when_paid' }));
  assert.equal(saved.payroll_booking, 'when_paid');
  assert.equal((await ok(setup(CI, 'viewer'))).payroll_booking, 'when_paid');
  const settings = await h.db.one('SELECT payroll_booking, updated_by, updated_at FROM fin_book_settings WHERE book_id = $1', [CI]);
  assert.deepEqual([settings.payroll_booking, settings.updated_by, settings.updated_at != null], ['when_paid', 'Test MD', true]);
  const [row] = (await hrAudit(CI)).slice(-1);
  assert.deepEqual([row.before, row.after], [{ name: 'Colour Impressions', payroll_booking: 'month_end' },
    { name: 'Colour Impressions', payroll_booking: 'when_paid' }]);
  assert.equal((await ok(setup(DP))).payroll_booking, 'month_end', 'one book\'s setting is its own');

  // A save that changes nothing writes nothing.
  const was = await written();
  assert.equal((await ok(save({ book_id: CI, payroll_booking: 'when_paid', channels: [{ channel_code: 'CASH', ledger_id: L['Office cash'] }] }))).payroll_booking,
    'when_paid');
  assert.deepEqual(await written(), was);

  await ok(save({ book_id: DP, payroll_booking: 'when_paid' }));
  assert.equal((await h.db.one('SELECT payroll_booking FROM fin_book_settings WHERE book_id = $1', [DP])).payroll_booking, 'when_paid');
  await ok(save({ book_id: DP, payroll_booking: 'month_end' }));
  await refusedAndNothingWritten(save({ book_id: CI, payroll_booking: 'weekly' }), 400, 'FIN_BAD_INPUT', 'payroll_booking');
  await refusedAndNothingWritten(save({ book_id: CI, payroll_booking: null }), 400, 'FIN_BAD_INPUT', 'payroll_booking');
});

test('paid-from options list office cash, Holder A and the mapped bank, and each resolves back to its ledger', gate, async () => {
  // Ruling R17: one entry per account, each a fin:<id> code: CI's cash ledgers (office cash, each holder), then every bank some HR pay
  // channel pays from. COLOUR and OLD BANK both pay from Bank – current (test 2), and DARBI now pays from DP's bank. SPARE is mapped
  // nowhere, Bank – unmapped is a CI bank no channel pays from, and Closed Till is switched off.
  await ok(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: D['DP Bank'] }] }));
  const options = await hrs.finPaidFromOptions(h.db.q);
  assert.deepEqual(options, [
    { code: `fin:${L.Cash}`, label: 'Cash' },
    { code: `fin:${L['Office cash']}`, label: 'Office cash' },
    { code: `fin:${L['Holder A Cash']}`, label: 'Holder · Holder A' },
    { code: `fin:${L['Bank – current']}`, label: 'Bank – current' },
    { code: `fin:${D['DP Bank']}`, label: 'DP Bank · Darbi Print Pack' },
  ]);
  // Names only, never a balance; `cash` and the channel codes are no options of their own (they name an account already listed).
  for (const o of options) assert.deepEqual(Object.keys(o).sort(), ['code', 'label']);
  assert.equal(new Set(options.map(o => o.code)).size, options.length, 'each account once');
  // A bank is offered because a channel pays from it, whether or not HR still uses that channel: OLD BANK, switched off in HR, alone
  // on Bank – old puts it in the list; back on Bank – current, the list is as it was.
  await ok(save({ book_id: CI, channels: [{ channel_code: 'OLD BANK', ledger_id: L['Bank – old'] }] }));
  assert.deepEqual((await hrs.finPaidFromOptions(h.db.q)).map(o => o.label),
    ['Cash', 'Office cash', 'Holder · Holder A', 'Bank – current', 'Bank – old', 'DP Bank · Darbi Print Pack']);
  await ok(save({ book_id: CI, channels: [{ channel_code: 'OLD BANK', ledger_id: L['Bank – current'] }] }));
  assert.deepEqual(await hrs.finPaidFromOptions(h.db.q), options);

  const resolves = async (code, channel) => hrs.finResolvePaidFrom(h.db.q, code, channel);
  const at = id => ({ book_id: CI, ledger_id: id });
  for (const o of options) {
    const id = Number(o.code.slice(4));
    assert.deepEqual(await resolves(o.code, null), { book_id: id === D['DP Bank'] ? DP : CI, ledger_id: id }, o.label);
  }
  // `cash` and a channel code are not offered any more, and still resolve: older HR rows store them (R17).
  assert.deepEqual(await resolves('cash', null), at(L['Office cash']));
  assert.deepEqual(await resolves('COLOUR', null), at(L['Bank – current']));
  assert.deepEqual(await resolves('DARBI', null), { book_id: DP, ledger_id: D['DP Bank'] });
  // No code: the channel's own account. A code: that code, whatever the channel.
  assert.deepEqual(await resolves(null, 'COLOUR'), at(L['Bank – current']));
  assert.deepEqual(await resolves(null, 'DARBI'), { book_id: DP, ledger_id: D['DP Bank'] });
  assert.deepEqual(await resolves('cash', 'COLOUR'), at(L['Office cash']));
  assert.deepEqual(await resolves(`fin:${L['Holder A Cash']}`, 'COLOUR'), at(L['Holder A Cash']));
  // Nothing to resolve: no code and no channel, a channel mapped nowhere, one HR doesn't have, and a code that names no account.
  for (const [code, channel] of [[null, null], [null, 'SPARE'], ['SPARE', null], ['NOPE', null], [`fin:${L['Test Rent']}`, null],
    ['fin:999999', null], ['fin:abc', null], ['fin:', null]]) {
    assert.equal(await resolves(code, channel), null, `${code} / ${channel}`);
  }

  // The CASH channel with no row of its own (ruling R19, spec §7.3 "CASH → office cash, by default"): office cash is still offered,
  // as the cash ledger it is (HR is never held up by Finance's setup, §7.7), and CASH, so `cash` and a CASH row with no code, resolve
  // to the CI book's office cash: its ONE switched-on cash ledger with no holder. CI has two here, Cash and Office cash, so nothing is
  // guessed: CASH stays unmapped, and the read says there is no default.
  await ok(save({ book_id: CI, channels: [{ channel_code: 'CASH', ledger_id: null }] }));
  assert.deepEqual(await hrs.finPaidFromOptions(h.db.q), options);
  const cashOf = async () => [await resolves('cash', null), await resolves(null, 'CASH'), await resolves('CASH', null)];
  assert.deepEqual(await cashOf(), [null, null, null], 'two tills: no default');
  let read = await ok(setup(CI));
  assert.equal(read.cash_default, null);
  assert.equal(read.channels.some(c => c.channel_code === 'CASH'), false);
  // One till (Office cash switched off): CASH is Cash, by default; the read shows it beside the channels, never among them.
  await ok(h.call('PUT', `/finance/ledgers/${L['Office cash']}`, { active: false }, 'md'));
  assert.deepEqual(await cashOf(), [at(L.Cash), at(L.Cash), at(L.Cash)], 'one till: the default');
  read = await ok(setup(CI));
  assert.deepEqual(read.cash_default, at(L.Cash));
  assert.equal(read.channels.some(c => c.channel_code === 'CASH'), false, 'a whole-state save never writes the default');
  assert.deepEqual((await ok(setup(DP))).cash_default, at(L.Cash), 'the same default whichever book is read');
  assert.equal((await ok(setup(DP, 'dpOnly'))).cash_default, null, 'told nothing of a book it cannot read');
  // An explicit CASH row wins over the default; taking it away lets the default apply again.
  await ok(save({ book_id: CI, channels: [{ channel_code: 'CASH', ledger_id: L['Holder A Cash'] }] }));
  assert.deepEqual(await cashOf(), [at(L['Holder A Cash']), at(L['Holder A Cash']), at(L['Holder A Cash'])]);
  assert.deepEqual((await ok(setup(CI))).cash_default, at(L.Cash), 'the default it overrides is still said');
  await ok(save({ book_id: CI, channels: [{ channel_code: 'CASH', ledger_id: null }] }));
  assert.deepEqual(await cashOf(), [at(L.Cash), at(L.Cash), at(L.Cash)]);
  // Office cash back on, and CASH explicitly on it, as the tests after this one expect.
  await ok(h.call('PUT', `/finance/ledgers/${L['Office cash']}`, { active: true }, 'md'));
  await ok(save({ book_id: CI, channels: [{ channel_code: 'CASH', ledger_id: L['Office cash'] }] }));
  assert.deepEqual(await cashOf(), [at(L['Office cash']), at(L['Office cash']), at(L['Office cash'])]);
  assert.deepEqual(await hrs.finPaidFromOptions(h.db.q), options);
});

test('an accountant or viewer saving HR setup gets 403 FIN_FORBIDDEN', gate, async () => {
  for (const who of ['acct', 'viewer']) {
    await refusedAndNothingWritten(save({ book_id: CI, payroll_booking: 'month_end' }, who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(save({ book_id: CI, roles: { rounding: L['Test Rent'] } }, who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(ensure(CI, who), 403, 'FIN_FORBIDDEN');
    assert.equal((await setup(CI, who)).status, 200, `${who} reads the setup: reading is view`);
  }
  // A login with no grant reads nothing; a book named by nobody is a 400.
  refused(await setup(CI, 'plant'), 403, 'FIN_FORBIDDEN');
  refused(await setup(DP, 'viewer'), 403, 'FIN_FORBIDDEN');
  refused(await h.call('GET', '/finance/hr-setup', null, 'md'), 400, 'FIN_BAD_INPUT', 'book');
  await refusedAndNothingWritten(save({ payroll_booking: 'month_end' }), 400, 'FIN_BAD_INPUT', 'book_id');
  await refusedAndNothingWritten(ensure(DP, 'dpOnly'), 403, 'FIN_FORBIDDEN');
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

test('FIN_LEDGER_ROLES is the twelve roles fin_ledger_roles takes, frozen', gate, async () => {
  const { def } = await h.db.one(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fin_ledger_roles_role_check'`);
  const inCheck = [...def.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]);
  assert.equal(inCheck.length, 12);
  assert.deepEqual([...hrs.FIN_LEDGER_ROLES].sort(), [...inCheck].sort());
  assert.ok(Object.isFrozen(hrs.FIN_LEDGER_ROLES));
});

test('unknown channels, roles and expense keys, and a role or expense ledger of another book, are refused FIN_BAD_INPUT naming the field', gate, async () => {
  const nope = await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'NOPE', ledger_id: L['Bank – current'] }] }),
    400, 'FIN_BAD_INPUT', 'channels[0].channel_code');
  assert.match(nope.body.error, /HR has no pay channel called NOPE/);
  const twice = [{ channel_code: 'COLOUR', ledger_id: L['Bank – current'] }, { channel_code: 'COLOUR', ledger_id: null }];
  await refusedAndNothingWritten(save({ book_id: CI, channels: twice }), 400, 'FIN_BAD_INPUT', 'channels[1].channel_code');
  await refusedAndNothingWritten(save({ book_id: CI, channels: 'COLOUR' }), 400, 'FIN_BAD_INPUT', 'channels');
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: '', ledger_id: L['Bank – current'] }] }), 400, 'FIN_BAD_INPUT', 'channels[0].channel_code');
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'COLOUR', ledger_id: 'Bank' }] }), 400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');

  const role = await refusedAndNothingWritten(save({ book_id: CI, roles: { bonus: L['Test Rent'] } }), 400, 'FIN_BAD_INPUT', 'roles.bonus');
  assert.match(role.body.error, /^bonus isn't a ledger role/);
  await refusedAndNothingWritten(save({ book_id: CI, roles: [L['Test Rent']] }), 400, 'FIN_BAD_INPUT', 'roles');
  const other = await refusedAndNothingWritten(save({ book_id: CI, roles: { rounding: D['DP Rent'] } }), 400, 'FIN_BAD_INPUT', 'roles.rounding');
  assert.doesNotMatch(other.body.error, /DP Rent/, "another book's ledger is not named");
  await refusedAndNothingWritten(save({ book_id: CI, roles: { rounding: 999999 } }), 400, 'FIN_BAD_INPUT', 'roles.rounding');

  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'grade:A', ledger_id: L['Contract Labour Test'] }] }),
    400, 'FIN_BAD_INPUT', 'expense_map[0].hr_key');
  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'type:  ', ledger_id: L['Contract Labour Test'] }] }),
    400, 'FIN_BAD_INPUT', 'expense_map[0].hr_key');
  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'type:Contractor', ledger_id: D['DP Rent'] }] }),
    400, 'FIN_BAD_INPUT', 'expense_map[0].ledger_id');
  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] },
    { hr_key: ' type:Contractor ', ledger_id: L['Test Rent'] }] }), 400, 'FIN_BAD_INPUT', 'expense_map[1].hr_key');

  // What is right is kept, a role and a key at a time: a role or a key not sent is left as it is, and null takes one away.
  const kept = await ok(save({ book_id: CI, roles: { rounding: L['Test Rent'] },
    expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] }, { hr_key: 'dept: Pasting ', ledger_id: L['Salaries & Wages'] }] }));
  assert.equal(kept.roles.rounding, L['Test Rent']);
  assert.equal(kept.roles.staff_advances, L['Staff Advances'], 'the roles not sent are as they were');
  assert.deepEqual(kept.expense_map, [{ hr_key: 'dept:Pasting', ledger_id: L['Salaries & Wages'] }, { hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] }]);
  const gone = await ok(save({ book_id: CI, roles: { rounding: null }, expense_map: [{ hr_key: 'dept:Pasting', ledger_id: null }] }));
  assert.equal('rounding' in gone.roles, false);
  assert.deepEqual(gone.expense_map, [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] }]);
  const [row] = (await hrAudit(CI)).slice(-1);
  assert.deepEqual([row.before.roles, row.after.roles], [{ rounding: L['Test Rent'] }, { rounding: null }]);
  assert.deepEqual([row.before.expense_map, row.after.expense_map], [{ 'dept:Pasting': L['Salaries & Wages'] }, { 'dept:Pasting': null }]);
  // Keys that differ only in capitals are one key: twice in a save is refused, and a key sent in other capitals is that key, renamed.
  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] },
    { hr_key: 'type:CONTRACTOR', ledger_id: L['Test Rent'] }] }), 400, 'FIN_BAD_INPUT', 'expense_map[1].hr_key');
  const renamed = await ok(save({ book_id: CI, expense_map: [{ hr_key: 'type:contractor', ledger_id: L['Salaries & Wages'] }] }));
  assert.deepEqual(renamed.expense_map, [{ hr_key: 'type:contractor', ledger_id: L['Salaries & Wages'] }]);
  const [moved] = (await hrAudit(CI)).slice(-1);
  assert.deepEqual([moved.before.expense_map, moved.after.expense_map],
    [{ 'type:Contractor': L['Contract Labour Test'] }, { 'type:contractor': L['Salaries & Wages'] }]);
  const back = await ok(save({ book_id: CI, expense_map: [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] }] }));
  assert.deepEqual(back.expense_map, [{ hr_key: 'type:Contractor', ledger_id: L['Contract Labour Test'] }]);
  // DP's expense map is DP's own.
  assert.deepEqual((await ok(setup(DP))).expense_map, []);
});

test('a channel may pay from a bank of either book; only an admin of that book may point it there or move it away', gate, async () => {
  // md is an admin of both books: DARBI pays from DP's bank (mapped in the test above), and the map says so.
  const both = await ok(setup(CI));
  assert.deepEqual(both.channels.find(c => c.channel_code === 'DARBI'), { channel_code: 'DARBI', book_id: DP, ledger_id: D['DP Bank'] });
  // A ledger of DP is judged in DP's own groups.
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: D['DP Rent'] }] }), 400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');

  // appr2 is made an admin of CI alone.
  await ok(h.call('POST', '/finance/access', { user_id: h.users.appr2.id, book_id: CI, roles: ['approver', 'admin'] }, 'md'));
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: D['DP Bank'] }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: L['Bank – current'] }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: null }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  // A ledger that is not there is the same answer as one out of reach: a refusal never says whether DP has a ledger of that id.
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: 999999 }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  // Its own book's banks are its to map, and what it reads leaves out the map into a book it cannot read.
  const own = await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – current'] }] }, 'appr2'));
  assert.deepEqual(own.channels.map(c => c.channel_code), ['CASH', 'COLOUR', 'OLD BANK', 'SPARE']);
  assert.deepEqual((await ok(setup(CI, 'appr2'))).channels.map(c => c.channel_code), ['CASH', 'COLOUR', 'OLD BANK', 'SPARE']);
  await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: null }] }, 'appr2'));
  assert.deepEqual((await ok(setup(CI))).channels.map(c => c.channel_code), ['CASH', 'COLOUR', 'DARBI', 'OLD BANK']);

  // A map into DP set from CI's setup is in DP's log too, so DP's admin sees what now pays from DP's bank.
  const dpRow = (await hrAudit(DP)).find(a => a.after?.channels?.DARBI);
  assert.deepEqual([dpRow.before.channels, dpRow.after.channels], [{ DARBI: null }, { DARBI: { book_id: DP, ledger_id: D['DP Bank'] } }]);
  assert.equal(dpRow.after.name, 'Darbi Print Pack');

  // A form sends its whole state back (Important 2). A map into a book the caller cannot read is never in what it reads, so one sent
  // as it stands is still refused, and the refusal says nothing of it.
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: D['DP Bank'] }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  // appr2 may now read DP too, as a viewer: its answer holds DARBI's map into DP, and sending that answer back, with only the payroll
  // setting changed, goes through. The maps it does not administer are left as they are.
  await ok(h.call('POST', '/finance/access', { user_id: h.users.appr2.id, book_id: DP, roles: ['viewer'] }, 'md'));
  const seen = await ok(setup(CI, 'appr2'));
  assert.deepEqual(seen.channels.find(c => c.channel_code === 'DARBI'), { channel_code: 'DARBI', book_id: DP, ledger_id: D['DP Bank'] });
  const booking = seen.payroll_booking === 'month_end' ? 'when_paid' : 'month_end';
  const back = await ok(save({ book_id: CI, channels: seen.channels, roles: seen.roles, expense_map: seen.expense_map, payroll_booking: booking },
    'appr2'));
  assert.equal(back.payroll_booking, booking);
  assert.deepEqual(back.channels, seen.channels);
  assert.deepEqual([back.roles, back.expense_map], [seen.roles, seen.expense_map]);
  // ...but changing a map into DP, or taking it away, is still DP's admin's.
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: L['Bank – current'] }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'DARBI', ledger_id: null }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  // An unchanged channel is left as it is even when its ledger would not be taken today (Important 2): a bank moved out of Bank
  // Accounts since SPARE was pointed at it may be sent back unchanged (here with the payroll setting put back as it was), but no
  // channel may be newly pointed at it.
  await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – old'] }] }, 'appr2'));
  await ok(h.call('PUT', `/finance/ledgers/${L['Bank – old']}`, { group_id: groupOf(CI, 'Indirect Expenses') }, 'md'));
  const resent = await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – old'] }],
    payroll_booking: seen.payroll_booking }, 'appr2'));
  assert.equal(resent.payroll_booking, seen.payroll_booking);
  assert.equal(resent.channels.find(c => c.channel_code === 'SPARE')?.ledger_id, L['Bank – old']);
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'OLD BANK', ledger_id: L['Bank – old'] }] }, 'appr2'),
    400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');
  await ok(h.call('PUT', `/finance/ledgers/${L['Bank – old']}`, { group_id: groupOf(CI, 'Bank Accounts') }, 'md'));
  await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: null }] }, 'appr2'));
});

test('saving the cash_difference role makes its ledger system-only, audited as a ledger edit; moving the role leaves the old one as it is (ruling R10)', gate, async () => {
  const cse = L['Cash Short & Excess'];
  const two = L['Cash Short Two'];
  assert.equal((await ledgerRow(cse)).manual_entry, true);
  const saved = await ok(save({ book_id: CI, roles: { cash_difference: cse } }));
  assert.equal(saved.roles.cash_difference, cse);
  assert.equal((await ledgerRow(cse)).manual_entry, false);
  const edit = await h.db.one(`SELECT user_name, before, after FROM fin_audit_log WHERE entity = 'ledger' AND action = 'edit' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [cse]);
  assert.deepEqual([edit.user_name, edit.before.manual_entry, edit.after.manual_entry, edit.after.name], ['Test MD', true, false, 'Cash Short & Excess']);
  // A voucher typed in SP1's form can no longer use it: it is kept for system entries (H6).
  const typed = await h.call('POST', '/finance/vouchers', { book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-10',
    lines: [{ ledger_id: cse, debit_paise: 100 }, { ledger_id: L['Test Rent'], credit_paise: 100 }] }, 'acct');
  refused(typed, 409, 'FIN_SYSTEM_LEDGER');

  // The Admin may switch it back in the chart of accounts, and a save that leaves the role where it is does not undo that, even
  // one that changes something else (the payroll setting here) and so is written.
  await ok(h.call('PUT', `/finance/ledgers/${cse}`, { manual_entry: true }, 'md'));
  const audits = (await hrAudit(CI)).length;
  await ok(save({ book_id: CI, roles: { cash_difference: cse }, payroll_booking: 'month_end' }));
  assert.equal((await hrAudit(CI)).length, audits + 1, 'the save was written');
  assert.equal((await ledgerRow(cse)).manual_entry, true);
  await ok(h.call('PUT', `/finance/ledgers/${cse}`, { manual_entry: false }, 'md'));

  // Moved to another ledger: that one becomes system-only, and the old one keeps the flag it has.
  const moved = await ok(save({ book_id: CI, roles: { cash_difference: two } }));
  assert.equal(moved.roles.cash_difference, two);
  assert.deepEqual([(await ledgerRow(cse)).manual_entry, (await ledgerRow(two)).manual_entry], [false, false]);
  await ok(h.call('PUT', `/finance/ledgers/${cse}`, { manual_entry: true }, 'md'));
  await ok(save({ book_id: CI, roles: { cash_difference: cse } }));
  assert.deepEqual([(await ledgerRow(cse)).manual_entry, (await ledgerRow(two)).manual_entry], [false, false], 'and back again');

  // A cash or bank account is never the cash-difference ledger: making it system-only would shut the till to every typed entry.
  await refusedAndNothingWritten(save({ book_id: CI, roles: { cash_difference: L['Office cash'] } }), 400, 'FIN_BAD_INPUT', 'roles.cash_difference');
  assert.equal((await ledgerRow(L['Office cash'])).manual_entry, true);
});

test('a ledger newly given a staff role, or newly pointed at by an expense key, is made system-only; the Admin\'s switch-back survives later saves, and the ledger a role leaves keeps its flag (ruling R20)', gate, async () => {
  const sa = L['Staff Advances'];
  const two = L['Advances Test Two'];
  const wages = L['Wages Test Ledger'];
  const flag = async id => (await ledgerRow(id)).manual_entry;
  const flips = async id => (await h.db.q(
    `SELECT user_name, before, after FROM fin_audit_log WHERE entity = 'ledger' AND action = 'edit' AND entity_id = $1 ORDER BY id`, [id]))
    .filter(a => a.before.manual_entry !== a.after.manual_entry).map(a => [a.user_name, a.after.manual_entry]);
  assert.deepEqual([await flag(sa), await flag(two), await flag(wages)], [false, true, true]);

  // staff_advances given to an ordinary ledger: it is made system-only, with its own edit row, and the ledger the role left keeps its
  // flag (the Admin switched Staff Advances back to typed entries first, so that "keeps" can be seen).
  await ok(h.call('PUT', `/finance/ledgers/${sa}`, { manual_entry: true }, 'md'));
  const moved = await ok(save({ book_id: CI, roles: { staff_advances: two } }));
  assert.equal(moved.roles.staff_advances, two);
  assert.deepEqual([await flag(two), await flag(sa)], [false, true]);
  assert.deepEqual(await flips(two), [['Test MD', false]]);
  // The Admin's switch-back survives a later save that leaves the role where it is (one written for a change of its own).
  await ok(h.call('PUT', `/finance/ledgers/${two}`, { manual_entry: true }, 'md'));
  const audits = (await hrAudit(CI)).length;
  await ok(save({ book_id: CI, roles: { staff_advances: two, staff_loans: L['Staff Loans'] }, payroll_booking: 'when_paid' }));
  assert.equal((await hrAudit(CI)).length, audits + 1, 'the save was written');
  assert.equal(await flag(two), true);
  // Back on Staff Advances, which newly takes the role again: made system-only again; Advances Test Two keeps its flag.
  await ok(save({ book_id: CI, roles: { staff_advances: sa } }));
  assert.deepEqual([await flag(sa), await flag(two)], [false, true]);

  // An expense key newly pointed at a ledger makes it system-only too (§7.2: "the salary expense ledger or ledgers").
  const mapped = await ok(save({ book_id: CI, expense_map: [{ hr_key: 'dept:Wages Test', ledger_id: wages }] }));
  assert.deepEqual(mapped.expense_map.find(x => x.hr_key === 'dept:Wages Test'), { hr_key: 'dept:Wages Test', ledger_id: wages });
  assert.equal(await flag(wages), false);
  await ok(h.call('PUT', `/finance/ledgers/${wages}`, { manual_entry: true }, 'md'));
  await ok(save({ book_id: CI, expense_map: [{ hr_key: 'dept:Wages Test', ledger_id: wages }], payroll_booking: 'month_end' }));
  assert.equal(await flag(wages), true, 'a key left where it is does not undo the switch-back');
  await ok(save({ book_id: CI, expense_map: [{ hr_key: 'dept:wages test', ledger_id: wages }] }));
  assert.equal(await flag(wages), true, 'nor does the key spelt again in other capitals');
  await ok(save({ book_id: CI, expense_map: [{ hr_key: 'dept:Wages Test', ledger_id: null }] }));
  assert.equal(await flag(wages), true, 'a key taken away leaves its ledger as it is');

  // Every other role keeps its ledger's flags: rounding, MD's Account and the like are no staff money of HR's.
  await ok(save({ book_id: CI, roles: { rounding: L['Test Rent'] } }));
  assert.equal(await flag(L['Test Rent']), true);
  await ok(save({ book_id: CI, roles: { rounding: null } }));
});

test('a staff role or an expense key refuses a bank, cash or party ledger with nothing written; a Loans & Advances ledger is taken, other roles are as they were, and an older mapping may be sent back (ruling R20a)', gate, async () => {
  const refusedFor = async (body, field, sentence) => {
    const r = await refusedAndNothingWritten(save({ book_id: CI, ...body }), 400, 'FIN_BAD_INPUT', field);
    if (sentence) assert.equal(r.body.error, sentence);
  };
  // staff_advances on a bank ledger, and on a customer's ledger; each of the other staff roles on a cash ledger.
  await refusedFor({ roles: { staff_advances: L['Bank – unmapped'] } }, 'roles.staff_advances',
    "A staff ledger can't be a bank, cash or party ledger, and Bank – unmapped is one.");
  await refusedFor({ roles: { staff_advances: L['Customer Test Co'] } }, 'roles.staff_advances',
    "A staff ledger can't be a bank, cash or party ledger, and Customer Test Co is one.");
  for (const role of ['staff_loans', 'salary_payable', 'salary_expense']) await refusedFor({ roles: { [role]: L['Office cash'] } }, `roles.${role}`);
  // An expense key on a cash ledger, and on a customer's ledger.
  await refusedFor({ expense_map: [{ hr_key: 'dept:Till Test', ledger_id: L['Office cash'] }] }, 'expense_map[0].ledger_id',
    "A salary expense ledger can't be a bank, cash or party ledger, and Office cash is one.");
  await refusedFor({ expense_map: [{ hr_key: 'dept:Till Test', ledger_id: L['Customer Test Co'] }] }, 'expense_map[0].ledger_id');
  assert.deepEqual([(await ledgerRow(L['Office cash'])).manual_entry, (await ledgerRow(L['Bank – unmapped'])).manual_entry], [true, true],
    'no till or bank was made system-only');

  // A Loans & Advances ledger is a staff ledger's place: taken (and made system-only, R20); Staff Loans then takes the role back.
  const taken = await ok(save({ book_id: CI, roles: { staff_loans: L['Advances Test Two'] } }));
  assert.equal(taken.roles.staff_loans, L['Advances Test Two']);
  await ok(save({ book_id: CI, roles: { staff_loans: L['Staff Loans'] } }));
  // Every other role is as it was: the inter-company ledger is the other firm's party ledger, as it often is in Tally.
  const other = await ok(save({ book_id: CI, roles: { intercompany: L['Customer Test Co'] } }));
  assert.equal(other.roles.intercompany, L['Customer Test Co']);
  assert.equal((await ledgerRow(L['Customer Test Co'])).manual_entry, true, 'no staff role, no flag');
  await ok(save({ book_id: CI, roles: { intercompany: null } }));

  // A mapping made before this rule (put in with SQL here: a staff role on a bank, an expense key on a till) may be sent back as it
  // stands, with the rest of what the read gave (Important 2), and nothing is written; it may also be taken away.
  await h.db.q(`UPDATE fin_ledger_roles SET ledger_id = $2 WHERE book_id = $1 AND role = 'staff_loans'`, [CI, L['Bank – unmapped']]);
  await h.db.q(`INSERT INTO fin_hr_expense_map (book_id, hr_key, ledger_id) VALUES ($1, 'dept:Old Till', $2)`, [CI, L.Cash]);
  const older = await ok(setup(CI));
  const was = await written();
  await ok(save({ book_id: CI, channels: older.channels, roles: older.roles, expense_map: older.expense_map, payroll_booking: older.payroll_booking }));
  assert.deepEqual(await written(), was, 'sent back as it stands: nothing written');
  // ...but pointing another key at that till, or the role at another bank, is refused.
  await refusedFor({ expense_map: [{ hr_key: 'dept:New Till', ledger_id: L.Cash }] }, 'expense_map[0].ledger_id');
  await refusedFor({ roles: { staff_loans: L['Bank – current'] } }, 'roles.staff_loans');
  const back = await ok(save({ book_id: CI, roles: { staff_loans: L['Staff Loans'] }, expense_map: [{ hr_key: 'dept:Old Till', ledger_id: null }] }));
  assert.equal(back.roles.staff_loans, L['Staff Loans']);
  assert.equal(back.expense_map.some(x => x.hr_key === 'dept:Old Till'), false);
  assert.deepEqual([(await ledgerRow(L.Cash)).manual_entry, (await ledgerRow(L['Bank – unmapped'])).manual_entry], [true, true]);
});

test('a switched-off ledger is refused for a channel, a role or an expense key; one switched off after it was mapped stays, and may be sent back or taken away', gate, async () => {
  // Never pointed at: Closed Till (cash), Old Rounding (an expense ledger) and DP Old Bank, each switched off in before().
  const till = await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: L['Closed Till'] }] }),
    400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');
  assert.match(till.body.error, /^Closed Till is switched off/);
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: D['DP Old Bank'] }] }),
    400, 'FIN_BAD_INPUT', 'channels[0].ledger_id');
  // To an admin of CI alone (appr2, since the cross-book test) that bank is out of reach first, so nothing about it is said.
  await refusedAndNothingWritten(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: D['DP Old Bank'] }] }, 'appr2'), 403, 'FIN_FORBIDDEN');
  for (const role of ['rounding', 'cash_difference']) {
    await refusedAndNothingWritten(save({ book_id: CI, roles: { [role]: L['Old Rounding'] } }), 400, 'FIN_BAD_INPUT', `roles.${role}`);
  }
  await refusedAndNothingWritten(save({ book_id: CI, expense_map: [{ hr_key: 'dept:Stores', ledger_id: L['Old Rounding'] }] }),
    400, 'FIN_BAD_INPUT', 'expense_map[0].ledger_id');

  // Pointed at while switched on, then switched off: the maps stay, the bank leaves the paid-from list, and a save that sends them
  // back unchanged (with a change of its own, so that it is written) goes through.
  const state = {
    channels: [{ channel_code: 'SPARE', ledger_id: L['Bank – later off'] }],
    roles: { rounding: L['Rounding – later off'] },
    expense_map: [{ hr_key: 'dept:Stores', ledger_id: L['Rounding – later off'] }],
  };
  await ok(save({ book_id: CI, ...state }));
  const offered = async () => (await hrs.finPaidFromOptions(h.db.q)).some(o => o.code === `fin:${L['Bank – later off']}`);
  assert.equal(await offered(), true, 'a mapped bank is offered');
  for (const name of ['Bank – later off', 'Rounding – later off']) await ok(h.call('PUT', `/finance/ledgers/${L[name]}`, { active: false }, 'md'));
  assert.equal(await offered(), false, 'a switched-off bank is not');
  const kept = await ok(save({ book_id: CI, ...state, payroll_booking: 'when_paid' }));
  assert.equal(kept.payroll_booking, 'when_paid');
  assert.deepEqual([kept.channels.find(c => c.channel_code === 'SPARE')?.ledger_id, kept.roles.rounding,
    kept.expense_map.find(x => x.hr_key === 'dept:Stores')?.ledger_id], [L['Bank – later off'], L['Rounding – later off'], L['Rounding – later off']]);
  // A key only spelt again in other capitals keeps its ledger, switched off or not: that is no new mapping either.
  const respelt = await ok(save({ book_id: CI, expense_map: [{ hr_key: 'dept:STORES', ledger_id: L['Rounding – later off'] }] }));
  assert.deepEqual(respelt.expense_map.find(x => x.hr_key.toLowerCase() === 'dept:stores'), { hr_key: 'dept:STORES', ledger_id: L['Rounding – later off'] });
  // Taking a map away from a switched-off ledger is no new mapping to it.
  const gone = await ok(save({ book_id: CI, channels: [{ channel_code: 'SPARE', ledger_id: null }], roles: { rounding: null },
    expense_map: [{ hr_key: 'dept:Stores', ledger_id: null }] }));
  assert.deepEqual([gone.channels.some(c => c.channel_code === 'SPARE'), 'rounding' in gone.roles,
    gone.expense_map.some(x => x.hr_key.toLowerCase() === 'dept:stores')], [false, false, false]);
});

// ── Several Tally ledgers onto one staff ledger (spec §7.9) ──────────────────────────────────

test('two Tally rows matched to Staff Advances build one opening line with their sum, and the parallel run shows one row with that sum; two rows on any other ledger are still refused', gate, async () => {
  const ADV = L['Staff Advances'];
  const LOANS = L['Staff Loans'];
  const accounts = [
    { tally_name: 'Advance - Test Person A', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'Advance - Test Person B', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'Loan - Test Person C', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'Loan - Test Person D', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'Test Capital A/c', tally_group: 'Capital Account' },
  ];
  const opening = [tb('Advance - Test Person A', 3000, 0), tb('Advance - Test Person B', 2000, 0), tb('Loan - Test Person C', 10000, 0),
    tb('Loan - Test Person D', 1000, 0), tb('Test Capital A/c', 0, 16000)];
  // Tally keeps Test Person A's advance bill by bill: a staff ledger takes no bills, so the bill is left out and said so.
  const bills = [{ tally_ledger_name: 'Advance - Test Person A', bill_ref: 'ADV-1', bill_date: '2026-12-05', due_date: null, amount_paise: 3000 * R, side: 'dr' }];
  const up = await ok(h.call('POST', '/finance/imports', { book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts, tb: opening, bills }, 'acct'));
  const id = up.import.id;
  const rowOf = (view, name) => view.ledgers.find(r => r.tally_name === name);
  const confirm = (view, advances, loans) => view.ledgers.map(r => (r.tally_name.startsWith('Advance') ? { row_id: r.id, action: 'match', ledger_id: advances }
    : r.tally_name.startsWith('Loan') ? { row_id: r.id, action: 'match', ledger_id: loans }
      : { row_id: r.id, action: 'create', group_id: rowOf(view, 'Test Capital A/c').group_id }));

  // Two rows on a ledger with no staff role are refused, as SP1 refuses them, naming both.
  const shared = await h.call('PUT', `/finance/imports/${id}/matches`, { matches: confirm(up, L['Test Rent'], LOANS) }, 'acct');
  refused(shared, 400, 'FIN_BAD_INPUT', 'matches');
  assert.match(shared.body.error, /^Advance - Test Person A and Advance - Test Person B both point at Test Rent\. One Finance ledger takes one Tally row/);
  assert.equal((await h.call('PUT', `/finance/imports/${id}/matches`, { matches: confirm(up, L['Salary Payable'], LOANS) }, 'acct')).status, 400,
    'Salary Payable is a staff ledger, but not one that takes a Tally ledger per person');

  // On Staff Advances and Staff Loans: accepted, and the tie-out says what the build will do with them.
  const matched = await ok(h.call('PUT', `/finance/imports/${id}/matches`, { matches: confirm(up, ADV, LOANS) }, 'acct'));
  assert.equal(matched.import.status, 'matched');
  assert.equal(matched.tie_out.ok, true, JSON.stringify(matched.tie_out.problems));
  assert.deepEqual(matched.tie_out.warnings, [
    'Advance - Test Person A is summed into Staff Advances, a staff ledger, which takes no bills: its 1 bill is left out.',
    'Advance - Test Person A and Advance - Test Person B go into Staff Advances as one line of ₹5,000.00 Dr.',
    'Loan - Test Person C and Loan - Test Person D go into Staff Loans as one line of ₹11,000.00 Dr.',
  ]);

  // The Opening voucher: one line for each staff ledger, the sum of its rows, and no bill; md builds it, so it posts.
  const built = await ok(h.call('POST', `/finance/imports/${id}/build-opening`, null, 'md'));
  assert.equal(built.voucher.status, 'posted');
  const lines = await h.db.q('SELECT ledger_id, debit, credit, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [built.voucher.id]);
  const capital = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Test Capital A/c'`, [CI])).id;
  assert.deepEqual(lines.map(l => [l.ledger_id, Math.round(l.debit * R), Math.round(l.credit * R), l.bill_ref]), [
    [ADV, 5000 * R, 0, null], [LOANS, 11000 * R, 0, null], [capital, 0, 16000 * R, null],
  ]);
  const dec31 = Object.fromEntries((await ok(h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`, null, 'md'))).ledgers
    .map(l => [l.id, l.closing_paise]));
  assert.deepEqual([dec31[ADV], dec31[LOANS], dec31[capital]], [5000 * R, 11000 * R, -16000 * R]);

  // The parallel run at 31 January: Tally has Test Person B's advance ₹500 higher than at the opening.
  const january = [tb('Advance - Test Person A', 3000, 0), tb('Advance - Test Person B', 2500, 0), tb('Loan - Test Person C', 10000, 0),
    tb('Loan - Test Person D', 1000, 0), tb('Test Capital A/c', 0, 16000)];
  const jan = await ok(h.call('POST', '/finance/imports', { book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', tb: january }, 'acct'));
  assert.deepEqual(jan.ledgers.map(r => [r.tally_name, r.match_status]), [
    ['Advance - Test Person A', 'unmatched'], ['Advance - Test Person B', 'unmatched'], ['Loan - Test Person C', 'unmatched'],
    ['Loan - Test Person D', 'unmatched'], ['Test Capital A/c', 'matched']]);
  const monthEnd = advances => jan.ledgers.map(r => (r.match_status === 'matched' ? { row_id: r.id, action: 'match', ledger_id: r.ledger_id }
    : { row_id: r.id, action: 'match', ledger_id: r.tally_name.startsWith('Advance') ? advances : LOANS }));
  refused(await h.call('PUT', `/finance/imports/${jan.import.id}/matches`, { matches: monthEnd(L['Test Rent']) }, 'acct'), 400, 'FIN_BAD_INPUT', 'matches');
  await ok(h.call('PUT', `/finance/imports/${jan.import.id}/matches`, { matches: monthEnd(ADV) }, 'acct'));
  const run = await ok(h.call('GET', `/finance/reports/parallel-run?import=${jan.import.id}`, null, 'viewer'));
  assert.deepEqual(run.rows.filter(r => r.ledger_id === ADV), [{ ledger_id: ADV, ledger_name: 'Staff Advances',
    tally_name: 'Advance - Test Person A and Advance - Test Person B', tally_closing_paise: 5500 * R, finance_closing_paise: 5000 * R, difference_paise: 500 * R }]);
  assert.deepEqual(run.rows.filter(r => r.ledger_id === LOANS).map(r => [r.tally_closing_paise, r.finance_closing_paise, r.difference_paise]),
    [[11000 * R, 11000 * R, 0]]);
  assert.equal(run.rows.length, 3);
  assert.equal(run.totals.differing, 1);
  assert.deepEqual(run.unmatched, []);
});

test('a staff ledger that is also a party\'s takes one summed line and no bills; with its role moved away, two rows on it stop the build', gate, async () => {
  // DP's Staff Advances took its role filed under Loans & Advances (test 1: R20a refuses a party's ledger the role). It is filed under
  // Sundry Debtors again, so a party's ledger, before the build below: R20a guards the role being given, not where the ledger is filed
  // later, and the import must still read such a ledger right.
  const ADV = D['Staff Advances'];
  const accounts = [
    { tally_name: 'Advance - Test Person E', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'Advance - Test Person F', tally_group: 'Loans & Advances (Asset)' },
    { tally_name: 'DP Capital Test', tally_group: 'Capital Account' },
  ];
  const opening = [tb('Advance - Test Person E', 4000, 0), tb('Advance - Test Person F', 0, 1000), tb('DP Capital Test', 0, 3000)];
  const bills = [
    { tally_ledger_name: 'Advance - Test Person E', bill_ref: 'E-1', bill_date: '2026-11-10', due_date: null, amount_paise: 2500 * R, side: 'dr' },
    { tally_ledger_name: 'Advance - Test Person E', bill_ref: 'E-2', bill_date: '2026-12-10', due_date: null, amount_paise: 1500 * R, side: 'dr' },
  ];
  const up = await ok(h.call('POST', '/finance/imports', { book_id: DP, purpose: 'opening', as_at: '2026-12-31', accounts, tb: opening, bills }, 'acct'));
  const capitalGroup = up.ledgers.find(r => r.tally_name === 'DP Capital Test').group_id;
  const matches = up.ledgers.map(r => (r.tally_name.startsWith('Advance') ? { row_id: r.id, action: 'match', ledger_id: ADV }
    : { row_id: r.id, action: 'create', group_id: capitalGroup }));
  const matched = await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  assert.equal(matched.tie_out.ok, true, JSON.stringify(matched.tie_out.problems));
  assert.deepEqual(matched.tie_out.warnings, [
    'Advance - Test Person E is summed into Staff Advances, a staff ledger, which takes no bills: its 2 bills are left out.',
    'Advance - Test Person E and Advance - Test Person F go into Staff Advances as one line of ₹3,000.00 Dr.',
  ]);

  // The role moves to another ledger after the matches were confirmed: the two rows now share a ledger that takes one, and the
  // tie-out the screen shows and the build both stop there.
  await ok(save({ book_id: DP, roles: { staff_advances: D['DP Advances Two'] } }));
  const view = await ok(h.call('GET', `/finance/imports/${up.import.id}`, null, 'acct'));
  assert.deepEqual(view.tie_out.problems.map(p => p.code), ['SHARED_LEDGER']);
  assert.equal(view.tie_out.problems[0].message, 'Advance - Test Person E and Advance - Test Person F both point at Staff Advances, and only a '
    + 'staff advances or staff loans ledger takes several Tally rows (Finance Setup → HR & payroll). Confirm the matches again.');
  const vouchers = async () => (await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers WHERE book_id = $1', [DP])).n;
  const was = await vouchers();
  const stopped = await h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'md');
  refused(stopped, 409, 'FIN_TIE_OUT');
  assert.equal(stopped.body.problems[0].code, 'SHARED_LEDGER');
  assert.equal(await vouchers(), was, 'nothing was built');

  // The role back where it was, and the ledger then filed under Sundry Debtors, a party's: the tie-out reads its rows as before, and
  // the build writes one line of the rows' sum on the party's ledger, with no bill on it.
  await ok(save({ book_id: DP, roles: { staff_advances: ADV } }));
  await ok(h.call('PUT', `/finance/ledgers/${ADV}`, { group_id: groupOf(DP, 'Sundry Debtors') }, 'md'));
  const asParty = await ok(h.call('GET', `/finance/imports/${up.import.id}`, null, 'acct'));
  assert.equal(asParty.ledgers.find(r => r.tally_name === 'Advance - Test Person E').is_party, true, "a party's ledger now");
  assert.equal(asParty.tie_out.ok, true, JSON.stringify(asParty.tie_out.problems));
  assert.deepEqual(asParty.tie_out.warnings, matched.tie_out.warnings);
  const built = await ok(h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'md'));
  assert.equal(built.voucher.status, 'posted');
  const lines = await h.db.q('SELECT ledger_id, debit, credit, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [built.voucher.id]);
  assert.deepEqual(lines.filter(l => l.ledger_id === ADV).map(l => [Math.round(l.debit * R), Math.round(l.credit * R), l.bill_ref]), [[3000 * R, 0, null]]);
  assert.equal(lines.length, 2);
});

// ── What the HR & payroll form chooses from (ruling R55) ─────────────────────────────────────

test('the read also answers HR\'s pay channels and the keys the expense map can take, with no name, code, count or amount (ruling R55)', gate, async () => {
  // Invented people, of both person types and of departments spelt as HR spells them: one with spaces and other capitals, one with
  // none, one blank, one that no expense key could hold (a tab in it), and one hidden from the accountant and the viewer (ruling R55:
  // a hidden person's department may be a key; it shows no person). None of their names or codes may reach Finance.
  const people = [
    ['HRS-001', 'Test Person P', 'employee', 'Pasting'],
    ['HRS-002', 'Test Person Q', 'contractor', '  pasting '],
    ['HRS-003', 'Test Person R', 'employee', 'Stores'],
    ['HRS-004', 'Test Person S', 'employee', null],
    ['HRS-005', 'Test Person T', 'contractor', '   '],
    ['HRS-006', 'Test Person U', 'employee', 'Bad\tDept'],
    ['HRS-007', 'Test Person V', 'contractor', 'Quality Lab'],
  ];
  const ids = {};
  for (const [code, name, type, dept] of people) {
    ids[code] = (await h.db.one(
      `INSERT INTO hr.people (code, name, worker_type, department, pay_channel) VALUES ($1, $2, $3, $4, 'CASH') RETURNING id`,
      [code, name, type, dept])).id;
  }
  for (const who of ['acct', 'viewer']) {
    await h.db.q(`INSERT INTO hr.access_hidden (user_id, person_id, mode, set_by) VALUES ($1, $2, 'all', $3)`,
      [h.users[who].id, ids['HRS-007'], h.users.md.id]);
  }
  // A channel's bank details are HR's: never in Finance's answer.
  await h.db.q(`UPDATE hr.pay_channels SET bank_name = 'Test Bank Ltd', account = '000111222333' WHERE code = 'COLOUR'`);

  // Every channel HR has, by code, whether or not it is mapped (SPARE) or switched off in HR (OLD BANK): the form has a row for each.
  const channels = [
    { code: 'CASH', name: 'Cash', kind: 'cash' }, { code: 'COLOUR', name: 'Colour bank', kind: 'bank' },
    { code: 'DARBI', name: 'Darbi bank', kind: 'bank' }, { code: 'OLD BANK', name: 'Old bank', kind: 'bank' },
    { code: 'SPARE', name: 'Spare bank', kind: 'bank' },
  ];
  // The person types, then the departments, each once, lower-cased and trimmed as the payroll journal matches them (finHrRunLines),
  // labelled in HR's own spelling; no key for no department or a blank one, nor for one the expense map would refuse.
  const keys = [
    { key: 'type:contractor', label: 'Person type · Contractor' },
    { key: 'type:employee', label: 'Person type · Employee' },
    { key: 'dept:pasting', label: 'Department · Pasting' },
    { key: 'dept:quality lab', label: 'Department · Quality Lab' },
    { key: 'dept:stores', label: 'Department · Stores' },
  ];
  // A view-capability read, of either book: the lists are HR's, the same whichever book is read and whoever reads it.
  for (const [who, book] of [['md', CI], ['viewer', CI], ['acct', CI], ['acct', DP], ['dpOnly', DP]]) {
    const read = await ok(setup(book, who));
    assert.deepEqual(read.hr_channels, channels, `${who} on ${book}: hr_channels`);
    assert.deepEqual(read.expense_keys, keys, `${who} on ${book}: expense_keys`);
    for (const c of read.hr_channels) assert.deepEqual(Object.keys(c).sort(), ['code', 'kind', 'name'], 'a channel is its code, name and kind, and nothing else');
    for (const k of read.expense_keys) assert.deepEqual(Object.keys(k).sort(), ['key', 'label'], 'a key is its key and label: no count of people');
    const said = JSON.stringify({ hr_channels: read.hr_channels, expense_keys: read.expense_keys });
    for (const [code, name] of people) {
      assert.ok(!said.includes(code) && !said.includes(name), `${who}: ${name} (${code}) is not in the answer`);
    }
    for (const secret of ['Test Bank Ltd', '000111222333']) assert.ok(!said.includes(secret), `${who}: the channel's bank details stay in HR`);
  }
  // The two lists are the only fields the read gained: what it said before is as it was.
  const read = await ok(setup(CI));
  assert.deepEqual(Object.keys(read).sort(), ['cash_default', 'channels', 'expense_keys', 'expense_map', 'hr_channels', 'payroll_booking', 'roles']);

  // Each key is one the expense map takes as it is: saved, it is stored as offered; and the save's answer carries the same lists.
  const ledger = L['Contract Labour Test'];
  const saved = await ok(save({ book_id: CI, expense_map: keys.map(k => ({ hr_key: k.key, ledger_id: ledger })) }));
  assert.deepEqual(saved.expense_map.map(x => x.hr_key).sort(), keys.map(k => k.key).sort());
  assert.deepEqual([saved.hr_channels, saved.expense_keys], [channels, keys]);
  const cleared = await ok(save({ book_id: CI, expense_map: keys.map(k => ({ hr_key: k.key, ledger_id: null })) }));
  assert.deepEqual(cleared.expense_map, []);

  // A department no one has any more is no key; a new one is, at once (the read is HR's people as they stand).
  await h.db.q(`UPDATE hr.people SET department = 'Dispatch' WHERE code = 'HRS-003'`);
  assert.deepEqual((await ok(setup(CI, 'viewer'))).expense_keys.map(k => k.key),
    ['type:contractor', 'type:employee', 'dept:dispatch', 'dept:pasting', 'dept:quality lab']);

  // …and so no browser keeps a copy of the read: HR's rows change with no announcement to Finance's screens, and the response cache sees
  // only public tables (data-tables.js), so a kept copy could miss a new channel or department (as GET /finance/hr/status). A plain
  // Finance read beside it still says what it was built from, so the check is not vacuous.
  const { setKnownTables } = await import('./data-tables.js');
  setKnownTables((await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(r => r.tablename));
  const headersOf = async url => {
    const res = await fetch(h.base + url, { headers: { authorization: `Bearer ${h.users.md.token}` } });
    assert.equal(res.status, 200, url);
    await res.json();
    return res.headers;
  };
  assert.ok((await headersOf(`/finance/books/${CI}/groups`)).get('x-data-tables'), 'a Finance read is cacheable');
  assert.equal((await headersOf(`/finance/hr-setup?book=${CI}`)).get('x-data-tables'), null, 'the setup read is not');
});

// ── Task 15 fix round, F1: every staff ledger found by its name ──────────────────────────────

test('every staff ledger found by its name: none is made, each is named as found and given its role, and the four are kept for the system\'s entries (F1)', gate, async () => {
  // The roles taken away (as an Admin may, or as a book a Tally import filled with ledgers of these names starts), Staff Advances switched
  // back to typed entries by the Admin: the five ledgers are in the book under their names, and none plays its role.
  const five = ['staff_advances', 'staff_loans', 'salary_payable', 'salary_expense', 'md_account'];
  const names = ['Staff Advances', 'Staff Loans', 'Salary Payable', 'Salaries & Wages', "MD's Account"];
  const ids = names.map(name => L[name]);
  assert.ok(ids.every(Number.isInteger), 'non-vacuous: the five ledgers are there');
  await ok(save({ book_id: CI, roles: Object.fromEntries(five.map(role => [role, null])) }));
  await ok(h.call('PUT', `/finance/ledgers/${L['Staff Advances']}`, { manual_entry: true }, 'md'));
  const ledgersBefore = (await h.db.one('SELECT COUNT(*)::int n FROM fin_ledgers WHERE book_id = $1', [CI])).n;

  const answer = await ok(ensure(CI));
  assert.deepEqual(answer.created, [], 'nothing is made');
  assert.deepEqual(answer.found, names, 'each is named as found, in the order the roles are given');
  assert.deepEqual(answer.system_only, names.slice(0, 4), 'and the four staff ledgers take no typed entry from now on');
  assert.deepEqual(five.map(role => answer.roles[role]), ids, 'each found ledger plays its role again');
  assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_ledgers WHERE book_id = $1', [CI])).n, ledgersBefore);
  assert.equal((await ledgerRow(L['Staff Advances'])).manual_entry, false, 'the switched-back ledger is system-only again');
  assert.equal((await ledgerRow(L["MD's Account"])).manual_entry, true, "MD's Account keeps its typed entries");
  const [row] = (await hrAudit(CI)).slice(-1);
  assert.deepEqual([row.after.created, row.after.found], [[], names], 'the log says what was found');
});
