import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg } from './finance-pg-harness.js';
import { finAccessOf, finRequire, finBookIdsFor, finApproverIds, finForgetAccess } from './finance-access.js';
import { finCreateYear } from './finance-setup.js';
import { setKnownTables } from './data-tables.js';

// Who may see which book, and the five read routes of spec §9.1. Opt-in, because it boots its own
// throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-access.test.js
//
// One boot for the file: books CI and DP, set up with the six logins of FIN_TEST_USERS and their grants
// (md approver+admin on both, acct accountant on both, appr2 approver on CI, viewer viewer on CI with no
// export, dpOnly accountant on DP, plant nothing). The tests share the database and run in order; the
// first three are the brief's, on the books as setup leaves them, and what the later ones add to a book
// they add after those.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
let CI, DP;   // book ids

before(async () => {
  if (!ON) return;
  h = await finBootPg('access');
  const ids = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id]));
  ({ CI, DP } = ids);
});

after(async () => { await h?.close(); });

test('a plant admin with no Finance grant sees no books and is refused every book route', gate, async () => {
  const me = await h.call('GET', '/finance/me', null, 'plant');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.books, []);
  for (const url of [`/finance/books/${CI}/groups`, `/finance/books/${CI}/ledgers`, `/finance/books/${CI}/years`]) {
    const r = await h.call('GET', url, null, 'plant');
    assert.equal(r.status, 403, url);
    assert.equal(r.body.code, 'FIN_FORBIDDEN');
  }
});

test('one-book logins see only their book', gate, async () => {
  const v = await h.call('GET', '/finance/me', null, 'viewer');
  assert.deepEqual(v.body.books.map(b => [b.code, b.roles, b.can_export]), [['CI', ['viewer'], false]]);
  const d = await h.call('GET', '/finance/me', null, 'dpOnly');
  assert.deepEqual(d.body.books.map(b => b.code), ['DP']);
  assert.equal((await h.call('GET', `/finance/books/${DP}/ledgers`, null, 'viewer')).status, 403);
  assert.equal((await h.call('GET', `/finance/books/${CI}/ledgers`, null, 'dpOnly')).status, 403);
});

test('the MD holds approver + admin on both books; the books read the template', gate, async () => {
  const m = await h.call('GET', '/finance/me', null, 'md');
  assert.deepEqual(m.body.books.map(b => [b.code, [...b.roles].sort()]), [['CI', ['admin', 'approver']], ['DP', ['admin', 'approver']]]);
  const g = await h.call('GET', `/finance/books/${CI}/groups`);
  assert.equal(g.body.groups.length, 29);
  const l = await h.call('GET', `/finance/books/${CI}/ledgers`);
  const cash = l.body.ledgers.find(x => x.name === 'Cash');
  assert.equal(cash.is_bank_cash, true);
  assert.equal(l.body.ledgers.find(x => x.name === 'Profit & Loss A/c').manual_entry, false);
  const y = await h.call('GET', `/finance/books/${CI}/years`);
  assert.deepEqual(y.body.years.map(x => [x.label, x.periods.length]), [['2026-27', 12]]);
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

test('/finance/me names the caller and each book as the screen needs it; /finance/books is the same list', gate, async () => {
  const me = await h.call('GET', '/finance/me', null, 'md');
  assert.deepEqual(me.body.user, { id: h.users.md.id, name: 'Test MD' });
  const entity = await h.db.one(`SELECT id FROM billing_entities WHERE name = 'Colour Impressions'`);
  const [ci, dp] = me.body.books;
  assert.deepEqual(Object.keys(ci).sort(), ['billing_entity_id', 'books_begin', 'can_export', 'code', 'id', 'name', 'roles']);
  assert.deepEqual(ci, { id: CI, code: 'CI', name: 'Colour Impressions', billing_entity_id: entity.id, books_begin: '2027-01-01', roles: ci.roles, can_export: true });
  assert.deepEqual([dp.id, dp.code, dp.name], [DP, 'DP', 'Darbi Print Pack']);
  for (const who of ['md', 'acct', 'appr2', 'viewer', 'dpOnly', 'plant']) {
    const same = await h.call('GET', '/finance/books', null, who);
    assert.equal(same.status, 200, who);
    assert.deepEqual(same.body, { books: (await h.call('GET', '/finance/me', null, who)).body.books }, who);
  }
});

test('a book id that is not a whole number is 404; a whole number nobody granted is 403, existing or not', gate, async () => {
  for (const tail of ['groups', 'ledgers', 'years']) {
    for (const id of ['abc', '1.5', 'NaN', '1e999']) {
      const r = await h.call('GET', `/finance/books/${id}/${tail}`);
      assert.equal(r.status, 404, `${id}/${tail}`);
      assert.equal(r.body.code, 'FIN_NOT_FOUND', `${id}/${tail}`);
    }
    const missing = await h.call('GET', `/finance/books/999999/${tail}`);
    const notYours = await h.call('GET', `/finance/books/${DP}/${tail}`, null, 'viewer');
    assert.deepEqual([missing.status, missing.body.code], [403, 'FIN_FORBIDDEN'], tail);
    assert.deepEqual(missing.body, notYours.body, `${tail}: nothing tells a book that is not there from one that is not yours`);
  }
});

test('groups: the tree in its own order, with the ledgers sitting directly in each', gate, async () => {
  const { groups } = (await h.call('GET', `/finance/books/${CI}/groups`)).body;
  assert.deepEqual(Object.keys(groups[0]).sort(),
    ['affects_gross_profit', 'id', 'is_bank_cash', 'is_party', 'is_system', 'ledger_count', 'name', 'nature', 'parent_id', 'sort_order']);
  const orders = groups.map(g => g.sort_order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'in sort_order');
  const by = Object.fromEntries(groups.map(g => [g.name, g]));
  assert.equal(by['Current Assets'].parent_id, null);
  assert.equal(by['Cash-in-Hand'].parent_id, by['Current Assets'].id);
  assert.deepEqual([by['Cash-in-Hand'].ledger_count, by['Profit & Loss'].ledger_count], [1, 1]);
  assert.equal(by['Current Assets'].ledger_count, 0, 'only the ledgers directly in the group');
  assert.deepEqual([by['Sales Accounts'].nature, by['Sales Accounts'].affects_gross_profit, by['Sales Accounts'].is_system], ['income', true, true]);
  assert.equal(groups.reduce((n, g) => n + g.ledger_count, 0), 2, 'Cash and Profit & Loss A/c, nothing else yet');
  // Fix round, M5 (ruling R23): the two flags the ledgers read has carried since R39, on the groups too, from the same walk (finGroupKinds):
  // the screens do not work out what a party group is for themselves. (finance-pg-masters.test.js holds the deep tree and the look-alikes.)
  assert.ok(groups.every(g => typeof g.is_party === 'boolean' && typeof g.is_bank_cash === 'boolean'), 'both flags on every group, always a boolean');
  const flags = name => [by[name].is_party, by[name].is_bank_cash];
  assert.deepEqual(flags('Sundry Debtors'), [true, false]);
  assert.deepEqual(flags('Sundry Creditors'), [true, false]);
  assert.deepEqual(flags('Bank Accounts'), [false, true]);
  assert.deepEqual(flags('Cash-in-Hand'), [false, true]);
  assert.deepEqual(flags('Bank OD A/c'), [false, true], 'a bank group beneath Loans (Liability): the name decides, not the parent');
  for (const plain of ['Current Assets', 'Current Liabilities', 'Loans (Liability)', 'Profit & Loss', 'Sales Accounts']) assert.deepEqual(flags(plain), [false, false], plain);
});

test('ledgers: bank/cash by ancestry, party names loosely compared, switched-off ones only when asked for', gate, async () => {
  const group = async name => (await h.db.one('SELECT id FROM fin_groups WHERE book_id = $1 AND name = $2', [CI, name])).id;
  const addGroup = async (name, parent) =>
    (await h.db.one(`INSERT INTO fin_groups (book_id, parent_id, name, nature) VALUES ($1, $2, $3, 'asset') RETURNING id`, [CI, await group(parent), name])).id;
  const addLedger = async (name, groupId, extra = {}) => (await h.db.one(
    `INSERT INTO fin_ledgers (book_id, group_id, name, party_type, party_id, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [CI, groupId, name, extra.party_type ?? null, extra.party_id ?? null, extra.active ?? true])).id;

  // Bank and cash: the three named groups, and anything beneath them at any depth, and nothing else.
  await addGroup('Savings Banks', 'Bank Accounts');
  await addGroup('Fixed Deposits', 'Savings Banks');
  await addLedger('Alpha Bank', await group('Bank Accounts'));
  await addLedger('Beta Bank', await group('Savings Banks'));
  await addLedger('Gamma FD', await group('Fixed Deposits'));
  await addLedger('Overdraft Alpha', await group('Bank OD A/c'));
  await addLedger('Office Rent', await group('Indirect Expenses'));
  await addLedger('Petty Debtors', await group('Sundry Debtors'));         // a sibling of Bank Accounts, not beneath it
  await addLedger('Old Rent', await group('Indirect Expenses'), { active: false });

  // Party ledgers: a customer under another name, one under the same name typed differently, a vendor, and a
  // link to a customer that no longer exists.
  const [c1, c2] = await h.db.q('SELECT id, name FROM customers ORDER BY id LIMIT 2');
  const [v1] = await h.db.q('SELECT id, name FROM vendors ORDER BY id LIMIT 1');
  const loose = name => name.toUpperCase().split('').join(' ');            // same letters, other capitals, spaces everywhere
  await addLedger('Tally Debtor One', await group('Sundry Debtors'), { party_type: 'customer', party_id: c1.id });
  await addLedger(loose(c2.name), await group('Sundry Debtors'), { party_type: 'customer', party_id: c2.id });
  await addLedger('Tally Creditor One', await group('Sundry Creditors'), { party_type: 'vendor', party_id: v1.id });
  await addLedger('Orphan Debtor', await group('Sundry Debtors'), { party_type: 'customer', party_id: 999999 });

  const list = async (query = '') => (await h.call('GET', `/finance/books/${CI}/ledgers${query}`)).body.ledgers;
  const active = await list();
  const by = Object.fromEntries(active.map(l => [l.name, l]));
  assert.deepEqual(Object.keys(active[0]).sort(), [
    'active', 'book_id', 'code', 'group_id', 'group_name', 'id', 'is_bank_cash', 'is_party', 'is_system', 'manual_entry', 'name',
    'name_differs', 'notes', 'party_id', 'party_name', 'party_type', 'tally_name']);

  assert.equal(by['Old Rent'], undefined, 'a switched-off ledger is not listed unless asked for');
  const all = await list('?include_inactive=1');
  assert.equal(all.length, active.length + 1);
  assert.deepEqual(all.filter(l => !l.active).map(l => l.name), ['Old Rent']);
  assert.equal((await list('?include_inactive=true')).length, all.length);
  assert.equal((await list('?include_inactive=0')).length, active.length);

  assert.deepEqual(
    Object.fromEntries(['Cash', 'Alpha Bank', 'Beta Bank', 'Gamma FD', 'Overdraft Alpha', 'Office Rent', 'Petty Debtors', 'Profit & Loss A/c']
      .map(n => [n, by[n].is_bank_cash])),
    { 'Cash': true, 'Alpha Bank': true, 'Beta Bank': true, 'Gamma FD': true, 'Overdraft Alpha': true, 'Office Rent': false, 'Petty Debtors': false, 'Profit & Loss A/c': false });
  assert.equal(by['Gamma FD'].group_name, 'Fixed Deposits');

  // is_party (ruling R39) is the same walk down the same tree: a party link, or a group at or beneath Sundry Debtors / Creditors.
  assert.deepEqual(
    Object.fromEntries(['Tally Debtor One', 'Tally Creditor One', 'Orphan Debtor', 'Petty Debtors', 'Cash', 'Alpha Bank', 'Gamma FD', 'Office Rent', 'Profit & Loss A/c']
      .map(n => [n, by[n].is_party])),
    { 'Tally Debtor One': true, 'Tally Creditor One': true, 'Orphan Debtor': true, 'Petty Debtors': true, 'Cash': false, 'Alpha Bank': false, 'Gamma FD': false, 'Office Rent': false, 'Profit & Loss A/c': false });

  assert.deepEqual([by['Tally Debtor One'].party_type, by['Tally Debtor One'].party_id, by['Tally Debtor One'].party_name, by['Tally Debtor One'].name_differs],
    ['customer', c1.id, c1.name, true]);
  const retyped = by[loose(c2.name)];
  assert.deepEqual([retyped.party_name, retyped.name_differs], [c2.name, false], 'capitals and spaces do not make a name differ');
  assert.deepEqual([by['Tally Creditor One'].party_type, by['Tally Creditor One'].party_name, by['Tally Creditor One'].name_differs], ['vendor', v1.name, true]);
  assert.deepEqual([by['Orphan Debtor'].party_id, by['Orphan Debtor'].party_name, by['Orphan Debtor'].name_differs], [999999, null, false]);
  assert.deepEqual([by['Cash'].party_type, by['Cash'].party_name, by['Cash'].name_differs], [null, null, false]);

  // The groups route counts them all, the switched-off one too, in the group they sit in.
  const groups = Object.fromEntries((await h.call('GET', `/finance/books/${CI}/groups`)).body.groups.map(g => [g.name, g]));
  assert.equal(groups['Indirect Expenses'].ledger_count, 2);
  assert.equal(groups['Sundry Debtors'].ledger_count, 4);
  assert.equal(groups['Bank Accounts'].ledger_count, 1, 'the sub-group\'s ledger is the sub-group\'s');
});

test('years: oldest first, each with its months in calendar order and their lock state', gate, async () => {
  // DP gets its next year behind the app's back, so there is something to put in order.
  await h.db.tx((qc, oc) => finCreateYear(qc, oc, { bookId: DP, label: '2027-28', booksBegin: '2027-01-01', actor: 'test' }));
  const { years } = (await h.call('GET', `/finance/books/${DP}/years`)).body;
  assert.deepEqual(years.map(y => [y.label, y.short, y.start_date, y.end_date]),
    [['2026-27', '2627', '2026-04-01', '2027-03-31'], ['2027-28', '2728', '2027-04-01', '2028-03-31']]);
  assert.deepEqual(Object.keys(years[0]).sort(), ['end_date', 'id', 'label', 'periods', 'short', 'start_date']);
  const [first, second] = years.map(y => y.periods);
  assert.deepEqual(first.map(p => p.month_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(first.map(p => p.label.slice(0, 3)), ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']);
  assert.deepEqual(first.map(p => p.status), [...Array(9).fill('before_books'), 'open', 'open', 'open']);
  assert.deepEqual(Object.keys(first[0]).sort(),
    ['end_date', 'id', 'label', 'month_no', 'start_date', 'status', 'status_changed_at', 'status_changed_by']);
  assert.deepEqual([first[9].start_date, first[9].end_date, first[9].status_changed_by, first[9].status_changed_at], ['2027-01-01', '2027-01-31', null, null]);
  assert.equal(second.length, 12);
  assert.ok(second.every(p => p.status === 'open'));
  // another book's months never leak in
  const ci = (await h.call('GET', `/finance/books/${CI}/years`)).body.years;
  assert.deepEqual(ci.map(y => y.label), ['2026-27']);
  assert.ok(ci[0].periods.every(p => !second.some(s => s.id === p.id)));
});

test('finRequire: the grant on a book, or a 403 that does not say whether the book exists', gate, async () => {
  const as = who => ({ user: { id: h.users[who].id } });
  assert.deepEqual(await finRequire(as('viewer'), 'view', CI), { roles: ['viewer'], can_export: false });
  assert.deepEqual([...(await finRequire(as('md'), 'approve', DP)).roles].sort(), ['admin', 'approver']);
  assert.deepEqual((await finRequire(as('acct'), 'ledger', `${CI}`)).roles, ['accountant'], 'a book id may arrive as text');
  const refused = [
    ['viewer', 'enter', CI], ['acct', 'approve', CI], ['acct', 'admin', DP], ['appr2', 'ledger', CI], ['appr2', 'view', DP],
    ['dpOnly', 'view', CI], ['plant', 'view', CI], ['md', 'view', 999999], ['md', 'export', CI], ['md', 'view', NaN], ['md', 'view', undefined],
  ];
  for (const [who, cap, book] of refused) {
    await assert.rejects(finRequire(as(who), cap, book), e => e.status === 403 && e.body.code === 'FIN_FORBIDDEN' && e.message.length > 0, `${who} ${cap} ${book}`);
  }
  // A request that carries no usable id at all is held to nothing.
  for (const req of [{ user: {} }, { user: { id: 'abc' } }, {}]) {
    await assert.rejects(finRequire(req, 'view', CI), e => e.body.code === 'FIN_FORBIDDEN');
  }
});

test('finAccessOf: a Map of the caller\'s grants by book, and nothing a caller does to it changes what the next request is told', gate, async () => {
  const md = await finAccessOf(h.users.md.id);
  assert.ok(md instanceof Map);
  assert.deepEqual([...md.keys()].sort((a, b) => a - b), [CI, DP]);
  assert.deepEqual([...md.get(DP).roles].sort(), ['admin', 'approver']);
  for (const nobody of [h.users.plant.id, undefined, null, 'abc', 0, -3]) assert.equal((await finAccessOf(nobody)).size, 0, String(nobody));

  const id = h.users.viewer.id;
  (await finAccessOf(id)).clear();                      // a caller helping itself to the Map it was given
  const grant = (await finAccessOf(id)).get(CI);
  assert.deepEqual(grant, { roles: ['viewer'], can_export: false });
  assert.throws(() => grant.roles.push('admin'), TypeError);
  assert.throws(() => { grant.can_export = true; }, TypeError);
  assert.deepEqual((await finAccessOf(id)).get(CI), { roles: ['viewer'], can_export: false });
});

test('finBookIdsFor: the books a login holds a capability on, in id order', gate, async () => {
  const ids = (who, cap) => finBookIdsFor({ user: { id: h.users[who].id } }, cap);
  assert.deepEqual(await ids('md'), [CI, DP]);
  assert.deepEqual(await ids('md', 'admin'), [CI, DP]);
  assert.deepEqual(await ids('acct', 'enter'), [CI, DP]);
  assert.deepEqual(await ids('acct', 'approve'), []);
  assert.deepEqual(await ids('appr2', 'approve'), [CI]);
  assert.deepEqual(await ids('viewer'), [CI]);
  assert.deepEqual(await ids('viewer', 'enter'), []);
  assert.deepEqual(await ids('dpOnly', 'ledger'), [DP]);
  assert.deepEqual(await ids('plant'), []);
  assert.deepEqual(await finBookIdsFor({}), []);
});

test('finApproverIds: the active approvers of a book, read on the transaction client', gate, async () => {
  const approvers = book => h.db.tx(qc => finApproverIds(book, qc));
  const sorted = (...who) => who.map(w => h.users[w].id).sort((a, b) => a - b);
  assert.deepEqual(await approvers(CI), sorted('md', 'appr2'));
  assert.deepEqual(await approvers(DP), sorted('md'));
  await h.db.q('UPDATE users SET active = 0 WHERE id = $1', [h.users.appr2.id]);
  try { assert.deepEqual(await approvers(CI), sorted('md'), 'a login switched off is not asked'); }
  finally { await h.db.q('UPDATE users SET active = 1 WHERE id = $1', [h.users.appr2.id]); }
  // Called without the transaction's client it refuses, rather than reach for the pool a transaction is holding.
  await assert.rejects(finApproverIds(CI), /needs the transaction/);
});

test('who may do what is held for 10 s on an instance, and forgotten the moment a grant changes', gate, async () => {
  const url = `/finance/books/${CI}/groups`;
  const status = who => h.call('GET', url, null, who).then(r => r.status);
  const books = who => h.call('GET', '/finance/me', null, who).then(r => r.body.books.map(b => b.code));
  // The revoke happens behind the app's back, as another instance's would.
  const revoke = () => h.db.one('DELETE FROM fin_access WHERE user_id = $1 AND book_id = $2 RETURNING roles, can_export, granted_by', [h.users.appr2.id, CI]);
  const restore = row => h.db.q('INSERT INTO fin_access (user_id, book_id, roles, can_export, granted_by) VALUES ($1, $2, $3::text[], $4, $5)',
    [h.users.appr2.id, CI, row.roles, row.can_export, row.granted_by]);

  assert.equal(await status('appr2'), 200);                                // loads and holds appr2's grants
  let row = await revoke();
  try {
    assert.equal(await status('appr2'), 200, 'held: the revoke is not seen yet');
    assert.deepEqual(await books('appr2'), [], '/finance/me reads the grants themselves, so it is never behind');
    finForgetAccess(h.users.md.id);
    assert.equal(await status('appr2'), 200, 'forgetting someone else leaves this login held');
    finForgetAccess();
    assert.equal(await status('appr2'), 403, 'forgetting everyone is seen at once');
    await restore(row);
    finForgetAccess(h.users.appr2.id);
    assert.equal(await status('appr2'), 200);                              // held again
    row = await revoke();
    finForgetAccess(h.users.appr2.id);
    assert.equal(await status('appr2'), 403, 'forgetting this login is seen at once');
  } finally {
    if (await h.db.one('SELECT 1 AS x FROM fin_access WHERE user_id = $1 AND book_id = $2', [h.users.appr2.id, CI]) == null) await restore(row);
    finForgetAccess();
  }
  assert.equal(await status('appr2'), 200);
});

// X-Data-Tables tells a browser which tables an answer was built from, so it can keep the answer until one of
// them changes (data-tables.js). Who may ask is not part of an answer, so a book's reads must not list
// fin_access; /finance/me IS the grants, so it must.
test('the tables each read is built from: the book reads never list fin_access, /finance/me does', gate, async () => {
  const names = (await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(r => r.tablename);
  setKnownTables(names);                    // the harness connects before init(), so nothing is known until now
  const tablesOf = async url => {
    finForgetAccess();                      // a held answer would read nothing at all, and prove nothing
    const res = await fetch(h.base + url, { headers: { authorization: `Bearer ${h.users.md.token}` } });
    assert.equal(res.status, 200, url);
    return (res.headers.get('x-data-tables') ?? '').split(',').filter(Boolean);
  };
  const groups = await tablesOf(`/finance/books/${CI}/groups`);
  assert.ok(groups.includes('fin_groups') && groups.includes('fin_ledgers'), groups.join());
  const ledgers = await tablesOf(`/finance/books/${CI}/ledgers`);
  for (const t of ['fin_ledgers', 'fin_groups', 'customers', 'vendors']) assert.ok(ledgers.includes(t), `${t} in ${ledgers.join()}`);
  const years = await tablesOf(`/finance/books/${CI}/years`);
  assert.ok(years.includes('fin_years') && years.includes('fin_periods'), years.join());
  for (const [url, tables] of [['groups', groups], ['ledgers', ledgers], ['years', years]]) {
    assert.ok(!tables.includes('fin_access'), `${url} reads fin_access inside the request's ledger: ${tables.join()}`);
  }
  const me = await tablesOf('/finance/me');
  assert.ok(me.includes('fin_access') && me.includes('fin_books'), me.join());
  assert.deepEqual(await tablesOf('/finance/books'), me);
});
