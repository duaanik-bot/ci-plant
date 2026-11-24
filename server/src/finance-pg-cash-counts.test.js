import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg } from './finance-pg-harness.js';

// Cash holders, cash counts and clearing a difference (Cash & Bank spec §5.4, §5.5; ledger ruling R10). Opt-in, because it boots
// its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-cash-counts.test.js
//
// One boot for the file; every test uses accounts of its own. What Task 9's Setup will do is done here with SQL: the cash_difference
// role row, and the Cash Short & Excess ledger's manual_entry = false. Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h, cash, CI;
const L = {};    // ledger name -> id
let GROUPS;

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
function refused(r, status, code, field) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field !== undefined) assert.equal(r.body?.field, field, JSON.stringify(r.body));
}
const idOf = name => {
  const g = GROUPS.find(x => x.name === name);
  assert.ok(g, `no group called ${name}`);
  return g.id;
};
const makeLedger = async (group, name, extra = {}) => {
  const body = await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf(group), name, ...extra }, 'acct'));
  L[name] = body.ledger.id;
  return body.ledger;
};
const enter = (fields, who = 'acct') => h.call('POST', '/finance/cash/entries', {
  book_id: CI, voucher_date: fields.date, entry_type: fields.entry_type, account_ledger_id: L[fields.account], other_ledger_id: L[fields.other],
  amount_paise: fields.rupees * R, tds_paise: 0, client_key: randomUUID(),
}, who);
const count = (ledger, date, rupees, who = 'acct', note = null) =>
  h.call('POST', '/finance/cash/counts', { book_id: CI, ledger_id: L[ledger], count_date: date, counted_paise: Math.round(rupees * R), note }, who);
const clear = (countId, who = 'acct') => h.call('POST', `/finance/cash/counts/${countId}/clear`, null, who);
const countRow = async id => h.db.one('SELECT id, cleared_voucher_id FROM fin_cash_counts WHERE id = $1', [id]);
const linesOf = async voucherId => (await h.db.q(
  'SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [voucherId]))
  .map(l => [l.ledger_id, Math.round(l.debit * R), Math.round(l.credit * R)]);
const voucherCount = async () => (await h.db.one('SELECT COUNT(*)::int AS n FROM fin_vouchers')).n;

before(async () => {
  if (!ON) return;
  h = await finBootPg('cash-counts');
  cash = await import('./finance-cash.js').catch(() => ({}));
  CI = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
  GROUPS = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'md'))).groups;

  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [CI])) L[l.name] = l.id;
  await makeLedger('Sundry Debtors', 'Funder Test Co');
  await makeLedger('Cash-in-Hand', 'Holder A Cash');
  await makeLedger('Cash-in-Hand', 'Holder B Cash');
  await makeLedger('Cash-in-Hand', 'Counted Till');
  await makeLedger('Indirect Expenses', 'Cash Short & Excess');
  await makeLedger('Indirect Expenses', 'Test Rent');
  // What Task 9's Setup will do: the role, and the ledger kept for the system's entries.
  await h.db.q(`INSERT INTO fin_ledger_roles (book_id, ledger_id, role) VALUES ($1, $2, 'cash_difference')`, [CI, L['Cash Short & Excess']]);
  await h.db.q('UPDATE fin_ledgers SET manual_entry = false WHERE id = $1', [L['Cash Short & Excess']]);
  // Cash on hand: ₹2,00,000 received into Cash, then ₹60,000 into Counted Till.
  const r1 = await ok(enter({ entry_type: 'receive', date: '2027-01-04', account: 'Cash', other: 'Funder Test Co', rupees: 200000 }));
  assert.equal(r1.voucher.status, 'posted');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-04', account: 'Cash', other: 'Counted Till', rupees: 60000 }));
});

after(async () => { await h?.close(); });

test('holder fields only on a Cash-in-Hand ledger (else FIN_HOLDER_NOT_CASH); a float needs a holder name', gate, async () => {
  // set by the accountant on a Cash-in-Hand ledger, on create and on edit; the float is paise in the API
  const made = await ok(h.call('POST', '/finance/ledgers', {
    book_id: CI, group_id: idOf('Cash-in-Hand'), name: 'Holder Z Cash', holder_name: 'Holder Z', float_paise: 5_000_000 }, 'acct'));
  assert.equal(made.ledger.holder_name, 'Holder Z');
  assert.equal(made.ledger.float_paise, 5_000_000);
  assert.equal('float_amount' in made.ledger, false, 'the table\'s NUMERIC is not the API\'s');
  assert.equal(Number((await h.db.one('SELECT float_amount FROM fin_ledgers WHERE id = $1', [made.ledger.id])).float_amount), 50000);
  const edited = await ok(h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { holder_name: 'Holder A', float_paise: 4_000_000 }, 'acct'));
  assert.deepEqual([edited.ledger.holder_name, edited.ledger.float_paise], ['Holder A', 4_000_000]);
  const cleared = await ok(h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { float_paise: null }, 'acct'));
  assert.equal(cleared.ledger.float_paise, null);
  await ok(h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { float_paise: 4_000_000 }, 'acct'));
  // the ledger list carries them, for the chart of accounts and the ledger form; a ledger with no holder has null
  const listed = (await ok(h.call('GET', `/finance/books/${CI}/ledgers`, null, 'acct'))).ledgers;
  const row = id => listed.find(x => x.id === id);
  assert.deepEqual([row(made.ledger.id).holder_name, row(made.ledger.id).float_paise], ['Holder Z', 5_000_000]);
  assert.deepEqual([row(L['Test Rent']).holder_name, row(L['Test Rent']).float_paise], [null, null]);
  assert.equal('float_amount' in row(made.ledger.id), false);
  // the audit row keeps the change
  const logged = await h.db.one(`SELECT after FROM fin_audit_log WHERE entity = 'ledger' AND entity_id = $1 AND action = 'create'`, [made.ledger.id]);
  assert.equal(logged.after.holder_name, 'Holder Z');

  // not under Cash-in-Hand: refused on create and on edit, naming the field
  refused(await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf('Indirect Expenses'), name: 'Not Cash A', holder_name: 'Someone' }, 'acct'),
    409, 'FIN_HOLDER_NOT_CASH', 'holder_name');
  refused(await h.call('PUT', `/finance/ledgers/${L['Test Rent']}`, { holder_name: 'Someone' }, 'acct'), 409, 'FIN_HOLDER_NOT_CASH', 'holder_name');
  refused(await h.call('PUT', `/finance/ledgers/${L['Test Rent']}`, { holder_name: 'Someone', float_paise: 100 }, 'acct'), 409, 'FIN_HOLDER_NOT_CASH');
  // a bank is not cash either
  refused(await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf('Bank Accounts'), name: 'Not Cash B', holder_name: 'Someone' }, 'acct'),
    409, 'FIN_HOLDER_NOT_CASH');
  // a ledger with no holder takes a blank one without trouble anywhere
  await ok(h.call('PUT', `/finance/ledgers/${L['Test Rent']}`, { holder_name: null }, 'acct'));
  // a float needs a holder name
  refused(await h.call('PUT', `/finance/ledgers/${L['Counted Till']}`, { float_paise: 100_000 }, 'acct'), 400, 'FIN_BAD_INPUT', 'float_paise');
  refused(await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf('Cash-in-Hand'), name: 'Float Alone', float_paise: 100 }, 'acct'),
    400, 'FIN_BAD_INPUT', 'float_paise');
  // …and a holder cannot be dropped from under a float; and a float is whole paise
  refused(await h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { holder_name: null }, 'acct'), 400, 'FIN_BAD_INPUT', 'float_paise');
  refused(await h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { float_paise: 1.5 }, 'acct'), 400, 'FIN_BAD_INPUT', 'float_paise');
  refused(await h.call('PUT', `/finance/ledgers/${L['Holder A Cash']}`, { float_paise: '100' }, 'acct'), 400, 'FIN_BAD_INPUT', 'float_paise');
  assert.equal((await h.db.one('SELECT holder_name FROM fin_ledgers WHERE id = $1', [L['Test Rent']])).holder_name, null);
});

// The ledger form offers a holder's name and float only under Cash-in-Hand (plan Task 15), and asks the groups read where that is: its
// is_cash, finGroupKinds' account_kind (ruling R23: a screen never works a group's kind out from names of its own).
test('the groups read says is_cash for Cash-in-Hand and every group beneath it, and for no other group', gate, async () => {
  const { finGroupKinds } = await import('./finance-vouchers.js');
  const sub = (await ok(h.call('POST', '/finance/groups', { book_id: CI, parent_id: idOf('Cash-in-Hand'), name: 'Holders Test Group' }, 'md'))).group;
  const groups = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'viewer'))).groups;
  const by = Object.fromEntries(groups.map(g => [g.name, g]));
  assert.deepEqual(['Cash-in-Hand', 'Holders Test Group', 'Bank Accounts', 'Sundry Debtors', 'Indirect Expenses', 'Current Assets'].map(n => by[n].is_cash),
    [true, true, false, false, false, false], 'Cash-in-Hand and beneath it; not a bank, a party, an expense, nor the group above');
  assert.ok(groups.every(g => typeof g.is_cash === 'boolean'), 'always a boolean');
  const kinds = await finGroupKinds(h.db.q, CI);
  assert.ok(groups.length > 20, `non-vacuous: ${groups.length} groups`);
  for (const g of groups) assert.equal(g.is_cash, kinds.get(g.id)?.account_kind === 'cash', g.name);
  // …and the server takes a holder there, as the form offers one there
  const held = await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: sub.id, name: 'Holder Y Cash', holder_name: 'Holder Y' }, 'acct'));
  assert.equal(held.ledger.holder_name, 'Holder Y');
});

test('tile top_up_paise is float − holds, and 0 at or above the float', gate, async () => {
  // Holder A: float ₹40,000, given ₹15,000 → tops up ₹25,000. Holder B: float ₹10,000, given ₹10,000 then ₹5,000 more → 0.
  await ok(h.call('PUT', `/finance/ledgers/${L['Holder B Cash']}`, { holder_name: 'Holder B', float_paise: 1_000_000 }, 'acct'));
  await ok(enter({ entry_type: 'transfer', date: '2027-01-05', account: 'Cash', other: 'Holder A Cash', rupees: 15000 }));
  await ok(enter({ entry_type: 'transfer', date: '2027-01-05', account: 'Cash', other: 'Holder B Cash', rupees: 10000 }));
  let tiles = (await cash.finCashAccounts(CI, { today: '2027-01-10' })).accounts;
  const tile = name => tiles.find(a => a.ledger_id === L[name]);
  assert.deepEqual([tile('Holder A Cash').account_kind, tile('Holder A Cash').balance_paise, tile('Holder A Cash').float_paise, tile('Holder A Cash').top_up_paise],
    ['holder', 1_500_000, 4_000_000, 2_500_000]);
  assert.equal(tile('Holder B Cash').top_up_paise, 0, 'holding exactly the float');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-06', account: 'Cash', other: 'Holder B Cash', rupees: 5000 }));
  tiles = (await cash.finCashAccounts(CI, { today: '2027-01-10' })).accounts;
  assert.equal(tile('Holder B Cash').balance_paise, 1_500_000);
  assert.equal(tile('Holder B Cash').top_up_paise, 0, 'above the float');
  assert.equal(tile('Counted Till').float_paise, null);
  assert.equal(tile('Counted Till').top_up_paise, 0, 'no float, no top-up');
});

test('a count stores the book balance and the difference, and no voucher appears', gate, async () => {
  const was = await voucherCount();
  const lines = (await h.db.one('SELECT COUNT(*)::int AS n FROM fin_voucher_lines')).n;
  // Counted Till holds ₹60,000 after 2027-01-04; a count on 2027-01-07 finds ₹59,700
  const r = await ok(count('Counted Till', '2027-01-07', 59700, 'acct', 'Friday count'));
  assert.deepEqual([r.count.counted_paise, r.count.book_balance_paise, r.count.difference_paise, r.count.note, r.count.cleared_voucher_id],
    [5_970_000, 6_000_000, -30_000, 'Friday count', null]);
  assert.equal(r.count.counted_by, 'Test Accountant');
  assert.equal(await voucherCount(), was, 'it posts nothing');
  assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_voucher_lines')).n, lines);
  // a count dated before the cash came in sees the book as it then was
  const early = await ok(count('Counted Till', '2027-01-03', 0));
  assert.deepEqual([early.count.book_balance_paise, early.count.difference_paise], [0, 0]);
  // the list, newest first, and the tile's last count
  const list = await ok(h.call('GET', `/finance/cash/counts?ledger=${L['Counted Till']}`, null, 'viewer'));
  assert.deepEqual(list.counts.map(c => c.count_date), ['2027-01-07', '2027-01-03']);
  const tile = (await cash.finCashAccounts(CI, { today: '2027-01-10' })).accounts.find(a => a.ledger_id === L['Counted Till']);
  assert.deepEqual(tile.last_count, { count_date: '2027-01-07', difference_paise: -30_000, cleared_voucher_id: null, clearing_waiting: false });
  // a bank is not counted, a bad amount and a bad date are refused, a viewer may not count
  await makeLedger('Bank Accounts', 'Count Bank');
  refused(await count('Count Bank', '2027-01-07', 1), 400, 'FIN_BAD_INPUT', 'ledger_id');
  refused(await h.call('POST', '/finance/cash/counts', { book_id: CI, ledger_id: L['Counted Till'], count_date: '2027-01-07', counted_paise: 1.5 }, 'acct'),
    400, 'FIN_BAD_INPUT', 'counted_paise');
  refused(await h.call('POST', '/finance/cash/counts', { book_id: CI, ledger_id: L['Counted Till'], count_date: '2027-13-07', counted_paise: 1 }, 'acct'),
    400, 'FIN_BAD_DATE', 'count_date');
  refused(await count('Counted Till', '2027-01-07', 1, 'viewer'), 403, 'FIN_FORBIDDEN');
  refused(await h.call('POST', '/finance/cash/counts', { book_id: CI, ledger_id: L['Test Rent'], count_date: '2027-01-07', counted_paise: 1 }, 'acct'),
    400, 'FIN_BAD_INPUT', 'ledger_id');
});

test('clearing a ₹300 shortage by acct makes a payment against Cash Short & Excess that waits for md, though it is under ₹1,00,000', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Short Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Short Till', rupees: 5000 }));
  const c = (await ok(count('Short Till', '2027-01-09', 4700))).count;
  assert.equal(c.difference_paise, -30_000);
  const r = await ok(clear(c.id, 'acct'));
  assert.equal(r.voucher.status, 'submitted', 'cash_difference is always: an Accountant\'s clearing waits');
  assert.equal(r.voucher.voucher_type, 'payment');
  assert.deepEqual(await linesOf(r.voucher.id), [[L['Cash Short & Excess'], 30_000, 0], [L['Short Till'], 0, 30_000]], 'Dr Short & Excess · Cr the till');
  const stored = await h.db.one('SELECT source_type, source_id, voucher_date FROM fin_vouchers WHERE id = $1', [r.voucher.id]);
  assert.deepEqual([stored.source_type, stored.source_id, stored.voucher_date], ['cash_count', c.id, '2027-01-09']);
  assert.equal((await countRow(c.id)).cleared_voucher_id, null, 'not cleared while it waits');
  const lastOf = async () => (await cash.finCashAccounts(CI, { today: '2027-01-10' })).accounts.find(a => a.ledger_id === L['Short Till']).last_count;
  assert.deepEqual(await lastOf(), { count_date: '2027-01-09', difference_paise: -30_000, cleared_voucher_id: null, clearing_waiting: true },
    'the tile says a clearing waits');
  // md approves: it posts, and the count is cleared
  const approved = await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/approve`, null, 'md'));
  assert.equal(approved.voucher.status, 'posted');
  assert.equal((await countRow(c.id)).cleared_voucher_id, r.voucher.id, 'cleared when it posts, on the approval path');
  assert.deepEqual(await lastOf(), { count_date: '2027-01-09', difference_paise: -30_000, cleared_voucher_id: r.voucher.id, clearing_waiting: false },
    'the tile says it is cleared');
  const tile = (await cash.finCashAccounts(CI, { today: '2027-01-10' })).accounts.find(a => a.ledger_id === L['Short Till']);
  assert.equal(tile.balance_paise, 470_000);
  // md reverses the clearing: the count is uncleared, and can be cleared again
  const rev = await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/reverse`, { date: '2027-01-09', reason: 'counted wrong' }, 'md'));
  assert.equal(rev.voucher.status, 'posted');
  assert.equal((await countRow(c.id)).cleared_voucher_id, null, 'a reversed clearing leaves the count uncleared');
  assert.deepEqual(await lastOf(), { count_date: '2027-01-09', difference_paise: -30_000, cleared_voucher_id: null, clearing_waiting: false },
    'the tile says it is uncleared again');
  const again = await ok(clear(c.id, 'md'));
  assert.equal(again.voucher.status, 'posted', 'the one clearing was reversed, so another is allowed');
  assert.equal((await countRow(c.id)).cleared_voucher_id, again.voucher.id);
});

test('md clearing an excess posts it self-approved and sets cleared_voucher_id', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Excess Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Excess Till', rupees: 2000 }));
  const c = (await ok(count('Excess Till', '2027-01-09', 2150.5))).count;
  assert.equal(c.difference_paise, 15_050);
  const r = await ok(clear(c.id, 'md'));
  assert.equal(r.voucher.status, 'posted');
  assert.equal(r.voucher.voucher_type, 'receipt');
  assert.match(r.voucher.number, /^CI-RV-2627-\d{4}$/);
  assert.equal((await h.db.one('SELECT self_approved FROM fin_vouchers WHERE id = $1', [r.voucher.id])).self_approved, true);
  assert.deepEqual(await linesOf(r.voucher.id), [[L['Excess Till'], 15_050, 0], [L['Cash Short & Excess'], 0, 15_050]], 'Dr the till · Cr Short & Excess');
  assert.equal((await countRow(c.id)).cleared_voucher_id, r.voucher.id);
  assert.equal(r.count.cleared_voucher_id, r.voucher.id);
});

test('clearing the same count twice is refused FIN_SOURCE_POSTED', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Twice Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Twice Till', rupees: 1000 }));
  const c = (await ok(count('Twice Till', '2027-01-09', 900))).count;
  await ok(clear(c.id, 'md'));
  const was = await voucherCount();
  refused(await clear(c.id, 'md'), 409, 'FIN_SOURCE_POSTED');
  refused(await clear(c.id, 'acct'), 409, 'FIN_SOURCE_POSTED');
  assert.equal(await voucherCount(), was, 'nothing was left behind');
  // a clearing that waits holds the count too
  await makeLedger('Cash-in-Hand', 'Waiting Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Waiting Till', rupees: 1000 }));
  const w = (await ok(count('Waiting Till', '2027-01-09', 1100))).count;
  assert.equal((await ok(clear(w.id, 'acct'))).voucher.status, 'submitted');
  refused(await clear(w.id, 'md'), 409, 'FIN_SOURCE_POSTED');
});

test('a clearing is refused with no difference, no Cash Short & Excess role, or an unknown count', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Even Till');
  const c = (await ok(count('Even Till', '2027-01-09', 0))).count;
  refused(await clear(c.id, 'md'), 400, 'FIN_BAD_INPUT');
  refused(await clear(999_999, 'md'), 403, 'FIN_FORBIDDEN');   // a row that is not there answers as one the caller cannot reach
  refused(await clear(c.id, 'viewer'), 403, 'FIN_FORBIDDEN');
  // DP has no Cash Short & Excess ledger set: its cash is counted but there is nowhere to clear it
  const dp = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'DP'`)).id;
  const dpCash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [dp])).id;
  const dpCount = await ok(h.call('POST', '/finance/cash/counts', { book_id: dp, ledger_id: dpCash, count_date: '2027-01-09', counted_paise: 500 }, 'md'));
  assert.equal(dpCount.count.difference_paise, 500);
  refused(await clear(dpCount.count.id, 'md'), 409, 'FIN_ROLE_MISSING');
});

test('Receive/Pay naming Cash Short & Excess is FIN_DIFFERENCE_VIA_COUNT; the ordinary voucher form cannot touch it either', gate, async () => {
  const want = 'Cash differences are cleared from a cash count: Count cash → Clear.';
  for (const entry_type of ['receive', 'pay']) {
    const r = await enter({ entry_type, date: '2027-01-12', account: 'Cash', other: 'Cash Short & Excess', rupees: 100 }, 'md');
    refused(r, 409, 'FIN_DIFFERENCE_VIA_COUNT', 'other_ledger_id');
    assert.equal(r.body.error, want);
  }
  // SP1's own form: H6 says the ledger is kept for system entries
  const draft = await h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'payment', voucher_date: '2027-01-12', client_key: randomUUID(),
    lines: [{ ledger_id: L['Cash Short & Excess'], debit_paise: 10_000, credit_paise: 0 }, { ledger_id: L.Cash, debit_paise: 0, credit_paise: 10_000 }],
  }, 'md');
  refused(draft, 409, 'FIN_SYSTEM_LEDGER');
  // …and a journal may not either
  refused(await h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-12', client_key: randomUUID(),
    lines: [{ ledger_id: L['Cash Short & Excess'], debit_paise: 10_000, credit_paise: 0 }, { ledger_id: L['Test Rent'], debit_paise: 0, credit_paise: 10_000 }],
  }, 'md'), 409, 'FIN_SYSTEM_LEDGER');
});

test('the reversal of a clearing is never reversed itself (R12); the count is cleared again instead', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Reverse Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Reverse Till', rupees: 1000 }));
  const c = (await ok(count('Reverse Till', '2027-01-09', 970))).count;
  const v1 = (await ok(clear(c.id, 'md'))).voucher;
  const r1 = (await ok(h.call('POST', `/finance/vouchers/${v1.id}/reverse`, { date: '2027-01-09', reason: 'wrong' }, 'md'))).voucher;
  assert.equal((await countRow(c.id)).cleared_voucher_id, null);
  const view = await ok(h.call('GET', `/finance/vouchers/${r1.id}`, null, 'md'));
  assert.equal(view.can.reverse, false, 'the screen does not offer it');
  const was = await voucherCount();
  const r = await h.call('POST', `/finance/vouchers/${r1.id}/reverse`, { date: '2027-01-09', reason: 'again' }, 'md');
  refused(r, 409, 'FIN_BAD_REVERSAL');
  assert.match(r.body.error, /Clear the count again instead\.$/);
  assert.equal(await voucherCount(), was);
  // cleared again, once, as a new clearing
  const v2 = (await ok(clear(c.id, 'md'))).voucher;
  assert.equal(v2.status, 'posted');
  assert.equal((await countRow(c.id)).cleared_voucher_id, v2.id);
  const net = await h.db.one(`SELECT COALESCE(sum(l.debit - l.credit), 0) AS n FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id
    WHERE l.ledger_id = $1 AND v.status = 'posted'`, [L['Cash Short & Excess']]);
  assert.ok(Number.isFinite(Number(net.n)));
});

test('a rejected clearing is not edited, only discarded (R13); the count can be cleared again', gate, async () => {
  await makeLedger('Cash-in-Hand', 'Reject Till');
  await ok(enter({ entry_type: 'transfer', date: '2027-01-08', account: 'Cash', other: 'Reject Till', rupees: 1000 }));
  const c = (await ok(count('Reject Till', '2027-01-09', 970))).count;
  const v = (await ok(clear(c.id, 'acct'))).voucher;
  assert.equal(v.status, 'submitted');
  await ok(h.call('POST', `/finance/vouchers/${v.id}/reject`, { reason: 'check it' }, 'md'));
  const view = await ok(h.call('GET', `/finance/vouchers/${v.id}`, null, 'acct'));
  assert.equal(view.voucher.status, 'draft');
  assert.deepEqual([view.can.edit, view.can.discard], [false, true], 'the screen offers Discard, never Edit');
  const edit = await h.call('PUT', `/finance/vouchers/${v.id}`, {
    lines: [{ ledger_id: L['Test Rent'], debit_paise: 3_000, credit_paise: 0 }, { ledger_id: L['Reject Till'], debit_paise: 0, credit_paise: 3_000 }],
  }, 'acct');
  refused(edit, 409, 'FIN_BAD_INPUT');
  assert.equal(edit.body.error, 'A clearing is made from its count: discard it and clear again.');
  assert.deepEqual(await linesOf(v.id), [[L['Cash Short & Excess'], 3_000, 0], [L['Reject Till'], 0, 3_000]], 'the lines are as they were');
  await ok(h.call('POST', `/finance/vouchers/${v.id}/discard`, null, 'acct'));
  const again = (await ok(clear(c.id, 'md'))).voucher;
  assert.equal(again.status, 'posted');
  assert.equal((await countRow(c.id)).cleared_voucher_id, again.id);
});
