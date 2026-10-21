import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';
import { finGroupKinds } from './finance-vouchers.js';

// The chart of accounts and the months: the seven write routes of spec §9.1 (groups, ledgers, years, month
// status). Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-masters.test.js
//
// One boot for the file, books CI and DP set up with the six logins of FIN_TEST_USERS. The tests share the
// database and run in order. The first five are the brief's, verbatim, and the months test is the last of
// them, so the others see January open. Everything after the "Beyond the brief" line is mine: it takes
// its own names and, where it moves a month, uses February, so it never depends on what the five left behind.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
let CI, DP;      // book ids
let G, GD;       // group name -> id, spaces and punctuation stripped from the name: CI, then DP
let CASH;        // the CI Cash ledger
let PERIOD;      // PERIOD[book code][start_date] -> period id

const strip = name => name.replace(/[^A-Za-z0-9]/g, '');
const groupMap = async book => Object.fromEntries((await h.call('GET', `/finance/books/${book}/groups`)).body.groups.map(g => [strip(g.name), g.id]));

before(async () => {
  if (!ON) return;
  h = await finBootPg('masters');
  const ids = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id]));
  ({ CI, DP } = ids);
  G = await groupMap(CI);
  GD = await groupMap(DP);
  CASH = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers.find(l => l.name === 'Cash').id;
  PERIOD = { CI: {}, DP: {} };
  for (const [code, id] of [['CI', CI], ['DP', DP]]) {
    for (const y of (await h.call('GET', `/finance/books/${id}/years`)).body.years) {
      for (const p of y.periods) PERIOD[code][p.start_date] = p.id;
    }
  }
});

after(async () => { await h?.close(); });

test('ledgers: the accountant adds, names are unique however they are typed, admin-only fields stay admin-only', gate, async () => {
  const add = (body, who = 'acct') => h.call('POST', '/finance/ledgers', { book_id: CI, ...body }, who);
  const pnb = await add({ name: 'Beta Bank', group_id: G.BankAccounts });
  assert.equal(pnb.status, 200);
  assert.equal((await add({ name: '  beta   bank ', group_id: G.BankAccounts })).body.code, 'FIN_DUPLICATE_NAME');
  assert.equal((await add({ name: 'Rent', group_id: G.IndirectExpenses }, 'viewer')).status, 403);
  const id = pnb.body.ledger.id;
  assert.equal((await h.call('PUT', `/finance/ledgers/${id}`, { active: false }, 'acct')).body.code, 'FIN_FORBIDDEN');
  assert.equal((await h.call('PUT', `/finance/ledgers/${id}`, { active: false }, 'md')).status, 200);
  assert.equal((await h.call('PUT', `/finance/ledgers/${CASH}`, { group_id: G.BankAccounts }, 'md')).body.code, 'FIN_BAD_INPUT');
});

test('party ledgers link to an existing customer, once per book', gate, async () => {
  const c = await h.db.one('SELECT id, name FROM customers ORDER BY id LIMIT 1');
  const add = name => h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.SundryDebtors, name, party_type: 'customer', party_id: c.id }, 'acct');
  assert.equal((await add('Tally Name For Customer')).status, 200);
  assert.equal((await add('Another Name')).body.code, 'FIN_PARTY_LINKED');
  const l = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers.find(x => x.party_id === c.id);
  assert.equal(l.party_name, c.name);
  assert.equal(l.name_differs, true);
  assert.equal(l.is_party, true, 'a ledger linked to a customer takes bill details');
  assert.equal((await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.SundryDebtors, name: 'Ghost', party_type: 'customer', party_id: 999999 }, 'acct')).body.code, 'FIN_BAD_INPUT');
});

test('groups: sub-groups inherit nature; system groups cannot be deleted; groups in use cannot be deleted', gate, async () => {
  const sg = await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'Packing Material' }, 'md');
  assert.equal(sg.body.group.nature, 'expense');
  assert.equal((await h.call('DELETE', `/finance/groups/${G.SundryDebtors}`, null, 'md')).body.code, 'FIN_BAD_INPUT');
  await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: sg.body.group.id, name: 'Corrugated Boxes' }, 'acct');
  assert.equal((await h.call('DELETE', `/finance/groups/${sg.body.group.id}`, null, 'md')).body.code, 'FIN_IN_USE');
  assert.equal((await h.call('PUT', `/finance/groups/${sg.body.group.id}`, { parent_id: G.SundryDebtors }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'X' }, 'acct')).status, 403);
});

test('years: an admin adds the next year once; months follow books_begin', gate, async () => {
  const y = await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md');
  assert.equal(y.status, 200);
  assert.ok(y.body.year.periods.every(p => p.status === 'open'));
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md')).body.code, 'FIN_EXISTS');
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2027-29' }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2028-29' }, 'acct')).status, 403);
});

test('months: approver-only transitions, reasons where the spec demands them, audited', gate, async () => {
  const jan = PERIOD.CI['2027-01-01'];
  const set = (status, reason, who = 'appr2') => h.call('PUT', `/finance/periods/${jan}/status`, { status, reason }, who);
  assert.equal((await set('closing', null, 'acct')).status, 403);
  assert.equal((await set('closing')).status, 200);
  assert.equal((await set('locked')).status, 200);
  assert.equal((await set('open')).body.code, 'FIN_BAD_TRANSITION');
  assert.equal((await set('closing')).body.code, 'FIN_REASON_REQUIRED');
  assert.equal((await set('closing', 'CA adjustment')).status, 200);
  assert.equal((await set('open', 'reopened by mistake')).status, 200);
  const a = await h.db.one(`SELECT reason FROM fin_audit_log WHERE entity='period' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [jan]);
  assert.equal(a.reason, 'reopened by mistake');
  assert.equal((await h.call('PUT', `/finance/periods/${PERIOD.DP['2027-01-01']}/status`, { status: 'closing' }, 'appr2')).status, 403);
  assert.equal((await h.call('PUT', `/finance/periods/${PERIOD.CI['2026-12-01']}/status`, { status: 'open', reason: 'x' }, 'md')).body.code, 'FIN_BAD_TRANSITION');
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

const auditOf = (entity, entityId) => h.db.q(
  'SELECT action, user_id, user_name, reason, before, after FROM fin_audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id', [entity, entityId]);
const auditCount = async () => (await h.db.one('SELECT COUNT(*)::int AS n FROM fin_audit_log')).n;

// A refusal: its status and code, and the field it names when the refusal is about one.
async function refused(call, status, code, field) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field) assert.equal(r.body.field, field, JSON.stringify(r.body));
  return r;
}

const ledgersOf = async book => (await h.call('GET', `/finance/books/${book}/ledgers?include_inactive=1`)).body.ledgers;
const groupsOf = async book => (await h.call('GET', `/finance/books/${book}/groups`)).body.groups;
const newGroup = async (parent, name, book = CI) => (await h.call('POST', '/finance/groups', { book_id: book, parent_id: parent, name }, 'md')).body.group;
const newLedger = async (group, name, extra = {}, book = CI) => (await h.call('POST', '/finance/ledgers', { book_id: book, group_id: group, name, ...extra }, 'acct')).body.ledger;

test('names are kept trimmed with inner spaces collapsed, ledgers and groups alike, and are unique per book however typed', gate, async () => {
  const l = await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.IndirectExpenses, name: '  Office \t  Tea\n Expenses ' }, 'acct');
  assert.equal(l.status, 200);
  assert.equal(l.body.ledger.name, 'Office Tea Expenses');
  const g = await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.IndirectExpenses, name: '  Staff   Welfare ' }, 'md');
  assert.equal(g.body.group.name, 'Staff Welfare');
  await refused(h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'STAFF welfare' }, 'md'), 409, 'FIN_DUPLICATE_NAME');
  const listed = (await ledgersOf(CI)).find(x => x.id === l.body.ledger.id);
  assert.equal(listed.name, 'Office Tea Expenses');
  // the other book keeps its own names
  const dp = await h.call('POST', '/finance/ledgers', { book_id: DP, group_id: GD.IndirectExpenses, name: 'Office Tea Expenses' }, 'md');
  assert.equal(dp.status, 200);
});

test('malformed input is a 400 that names the field, never a 500, and writes nothing', gate, async () => {
  const written = await auditCount();
  const ok = { book_id: CI, group_id: G.IndirectExpenses, name: 'Valid Name' };
  const bad = [
    ['/finance/ledgers', { ...ok, name: undefined }, 'name'],
    ['/finance/ledgers', { ...ok, name: '   ' }, 'name'],
    ['/finance/ledgers', { ...ok, name: 42 }, 'name'],
    ['/finance/ledgers', { ...ok, name: 'x'.repeat(256) }, 'name'],
    ['/finance/ledgers', { ...ok, name: 'bad\u0000name' }, 'name'],
    ['/finance/ledgers', { ...ok, group_id: undefined }, 'group_id'],
    ['/finance/ledgers', { ...ok, group_id: 'abc' }, 'group_id'],
    ['/finance/ledgers', { ...ok, group_id: 1.5 }, 'group_id'],
    ['/finance/ledgers', { ...ok, group_id: 99999999999 }, 'group_id'],
    ['/finance/ledgers', { ...ok, group_id: [G.IndirectExpenses] }, 'group_id'],
    ['/finance/ledgers', { ...ok, group_id: GD.IndirectExpenses }, 'group_id'],       // a group of the other book
    ['/finance/ledgers', { ...ok, book_id: undefined }, 'book_id'],
    ['/finance/ledgers', { ...ok, book_id: { id: CI } }, 'book_id'],
    ['/finance/ledgers', { ...ok, code: 123 }, 'code'],
    ['/finance/ledgers', { ...ok, notes: { a: 1 } }, 'notes'],
    ['/finance/ledgers', { ...ok, tally_name: 'y'.repeat(256) }, 'tally_name'],
    ['/finance/ledgers', { ...ok, party_type: 'customer' }],                            // a type without an id
    ['/finance/ledgers', { ...ok, party_id: 3 }],                                       // an id without a type
    ['/finance/ledgers', { ...ok, party_type: 'bank', party_id: 3 }],
    ['/finance/ledgers', { ...ok, party_type: 'vendor', party_id: 99999999999 }],
    ['/finance/groups', { book_id: CI, name: 'No Parent' }, 'parent_id'],
    ['/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: '' }, 'name'],
    ['/finance/groups', { book_id: CI, parent_id: 99999999999, name: 'Huge Parent' }, 'parent_id'],
    ['/finance/groups', { book_id: CI, parent_id: GD.DirectExpenses, name: 'Other Books Parent' }, 'parent_id'],
    ['/finance/groups', { parent_id: G.DirectExpenses, name: 'No Book' }, 'book_id'],
    ['/finance/years', { book_id: CI }, 'label'],
    ['/finance/years', { label: '2031-32' }, 'book_id'],
  ];
  for (const [path, body, field] of bad) {
    const who = path === '/finance/ledgers' ? 'acct' : 'md';
    await refused(h.call('POST', path, body, who), 400, 'FIN_BAD_INPUT', field);
  }
  await refused(h.call('POST', '/finance/groups', [1, 2], 'md'), 400, 'FIN_BAD_INPUT');
  assert.equal(await auditCount(), written, 'a refused write leaves no trace');
});

test('a ledger keeps its code, Tally name and notes; the ledgers read returns notes; blank optional text is stored as nothing', gate, async () => {
  const add = (name, extra = {}) => h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.DirectExpenses, name, ...extra }, 'acct');
  const a = await add('Gamma Stores', { code: ' GS-01 ', tally_name: ' Gamma Stores Pvt Ltd ', notes: ' Pays on the 10th ' });
  assert.equal(a.status, 200);
  assert.deepEqual([a.body.ledger.code, a.body.ledger.tally_name, a.body.ledger.notes], ['GS-01', 'Gamma Stores Pvt Ltd', 'Pays on the 10th']);
  assert.deepEqual(Object.keys(a.body.ledger).sort(), [
    'active', 'book_id', 'code', 'group_id', 'id', 'is_system', 'manual_entry', 'name', 'notes', 'party_id', 'party_type', 'tally_name']);
  const row = (await ledgersOf(CI)).find(x => x.id === a.body.ledger.id);
  assert.equal(row.notes, 'Pays on the 10th');
  await refused(add('Gamma Stores Two', { code: 'GS-01' }), 409, 'FIN_DUPLICATE_CODE');
  // '' is nothing, not a code: two ledgers without one must not collide on it
  const b = await add('Blank One', { code: '', tally_name: '  ', notes: '' });
  const c = await add('Blank Two', { code: '' });
  assert.deepEqual([b.status, c.status], [200, 200]);
  assert.deepEqual([b.body.ledger.code, c.body.ledger.code, b.body.ledger.tally_name, b.body.ledger.notes], [null, null, null, null]);
  // the system flags are not the caller's to set when a ledger is made
  const d = await add('Sneaky One', { manual_entry: false, active: false, is_system: true });
  assert.deepEqual([d.body.ledger.manual_entry, d.body.ledger.active, d.body.ledger.is_system], [true, true, false]);
  assert.equal((await ledgersOf(CI)).find(x => x.id === a.body.ledger.id).name, 'Gamma Stores');
});

test('ledger edits: the accountant changes the text fields; an admin-only field refuses a change but accepts the value it already has', gate, async () => {
  const l = await newLedger(G.DirectExpenses, 'Delta Freight');
  const put = (body, who = 'acct', id = l.id) => h.call('PUT', `/finance/ledgers/${id}`, body, who);

  const e = await put({ name: '  Delta   Freight Inward ', code: 'DF-1', tally_name: 'Delta Freight (Tally)', notes: 'Inward only' });
  assert.equal(e.status, 200);
  assert.deepEqual([e.body.ledger.name, e.body.ledger.code, e.body.ledger.tally_name, e.body.ledger.notes],
    ['Delta Freight Inward', 'DF-1', 'Delta Freight (Tally)', 'Inward only']);
  let rows = await auditOf('ledger', l.id);
  assert.deepEqual(rows.map(r => r.action), ['create', 'edit']);
  assert.deepEqual([rows[1].before.name, rows[1].after.name, rows[1].user_id, rows[1].user_name], ['Delta Freight', 'Delta Freight Inward', h.users.acct.id, 'Test Accountant']);
  assert.equal(rows[0].before, null);
  assert.equal(rows[0].after.name, 'Delta Freight');

  // A form sent back as it was read changes nothing, so it needs no admin and leaves no audit row
  const same = await put({ ...e.body.ledger });
  assert.equal(same.status, 200);
  assert.equal((await auditOf('ledger', l.id)).length, 2);
  // Text can be cleared
  const cleared = await put({ code: null, notes: '' });
  assert.deepEqual([cleared.body.ledger.code, cleared.body.ledger.notes], [null, null]);

  // …but a change to an admin-only field is the admin's
  const cust = (await h.db.q('SELECT id FROM customers ORDER BY id'))[1].id;
  for (const body of [{ group_id: G.IndirectExpenses }, { active: false }, { manual_entry: false }, { party_type: 'customer', party_id: cust }]) {
    await refused(put(body), 403, 'FIN_FORBIDDEN');
  }
  assert.equal((await auditOf('ledger', l.id)).length, 3, 'only the clearing edit was added');

  // The admin: a move within the book, the flags, and the field rules
  const moved = await put({ group_id: G.IndirectExpenses }, 'md');
  assert.equal(moved.body.ledger.group_id, G.IndirectExpenses);
  await refused(put({ group_id: GD.IndirectExpenses }, 'md'), 400, 'FIN_BAD_INPUT', 'group_id');
  await refused(put({ group_id: 'x' }, 'md'), 400, 'FIN_BAD_INPUT', 'group_id');
  await refused(put({ active: 'no' }, 'md'), 400, 'FIN_BAD_INPUT', 'active');
  await refused(put({ manual_entry: 0 }, 'md'), 400, 'FIN_BAD_INPUT', 'manual_entry');
  await refused(put({ name: '' }, 'md'), 400, 'FIN_BAD_INPUT', 'name');
  const flags = await put({ active: false, manual_entry: false }, 'md');
  assert.deepEqual([flags.body.ledger.active, flags.body.ledger.manual_entry], [false, false]);
  assert.equal((await put({ active: true, manual_entry: true }, 'md')).body.ledger.active, true);

  // A party link: both halves or neither; the party must exist; one ledger per party in a book
  await refused(put({ party_type: 'customer' }, 'md'), 400, 'FIN_BAD_INPUT');
  await refused(put({ party_type: 'customer', party_id: 999999 }, 'md'), 400, 'FIN_BAD_INPUT');
  await refused(put({ party_type: 'customer', party_id: (await h.db.one('SELECT id FROM customers ORDER BY id LIMIT 1')).id }, 'md'), 409, 'FIN_PARTY_LINKED');
  const linked = await put({ party_type: 'customer', party_id: cust }, 'md');
  assert.deepEqual([linked.body.ledger.party_type, linked.body.ledger.party_id], ['customer', cust]);
  await refused(put({ party_id: null }, 'md'), 400, 'FIN_BAD_INPUT');
  const unlinked = await put({ party_type: null, party_id: null }, 'md');
  assert.deepEqual([unlinked.body.ledger.party_type, unlinked.body.ledger.party_id], [null, null]);

  // A name or code that is taken
  const other = await newLedger(G.DirectExpenses, 'Delta Cartage', { code: 'DC-1' });
  await refused(put({ name: 'DELTA CARTAGE' }, 'acct'), 409, 'FIN_DUPLICATE_NAME');
  await refused(put({ code: 'DC-1' }, 'acct'), 409, 'FIN_DUPLICATE_CODE');
  assert.equal((await put({ name: 'delta freight inward' }, 'acct')).status, 200, 'a ledger may take its own name in other capitals');
  assert.ok(other.id);

  // A caller that says nothing about being an admin is not one
  const { finUpdateLedger } = await import('./finance-masters.js');
  await assert.rejects(h.db.tx((qc, oc) => finUpdateLedger(qc, oc, l.id, { active: false }, { id: h.users.acct.id, name: 'Test Accountant' })),
    e => e.status === 403 && e.body.code === 'FIN_FORBIDDEN');
});

// Final review M-7: a login that is not an admin saves only the fields it may change, and finUpdateLedger compares only the fields it
// is given. So the body the Ledger form really makes (finLedgerEditBody) saves the accountant's notes on a ledger an admin moved,
// switched off and linked since the form was opened, and changes none of what the admin did. The server's own rule still stands:
// a non-admin who does send a changed admin-only field is refused.
test('M-7: an accountant\'s save sends only the text, so a form opened before an admin changed the ledger saves, and undoes nothing', gate, async () => {
  const { finLedgerEditBody, finLedgerFormOf } = await import('../../client/src/lib/finance/setup.js');
  const l = await newLedger(G.DirectExpenses, 'Echo Freight');
  const read = async () => (await h.call('GET', `/finance/books/${CI}/ledgers?include_inactive=1`, null, 'acct')).body.ledgers.find(x => x.id === l.id);
  const opened = await read();                                     // what the accountant's form was opened on
  const echo = (await h.db.one(`INSERT INTO customers (name) VALUES ('Echo Traders') RETURNING id`)).id;
  const admin = await h.call('PUT', `/finance/ledgers/${l.id}`, { group_id: G.IndirectExpenses, active: false, party_type: 'customer', party_id: echo }, 'md');
  assert.equal(admin.status, 200, JSON.stringify(admin.body));

  const body = finLedgerEditBody({ ...finLedgerFormOf(opened), notes: 'Checked by accounts' }, { isAdmin: false });
  assert.deepEqual(Object.keys(body).sort(), ['code', 'name', 'notes', 'tally_name']);
  const saved = await h.call('PUT', `/finance/ledgers/${l.id}`, body, 'acct');
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const now = await read();
  assert.deepEqual([now.notes, now.group_id, now.active, now.party_type, now.party_id],
    ['Checked by accounts', G.IndirectExpenses, false, 'customer', echo], 'the notes, and every one of the admin\'s changes, stand');
  // …and a body that does carry a changed admin-only field is the admin's, as ever
  await refused(h.call('PUT', `/finance/ledgers/${l.id}`, { ...body, active: true }, 'acct'), 403, 'FIN_FORBIDDEN');
  await refused(h.call('PUT', `/finance/ledgers/${l.id}`, { ...body, group_id: G.DirectExpenses }, 'acct'), 403, 'FIN_FORBIDDEN');
  assert.equal((await read()).active, false);
});

test('a system ledger cannot be moved or switched off; it may be given notes', gate, async () => {
  const pl = (await ledgersOf(CI)).find(x => x.name === 'Profit & Loss A/c');
  const put = (id, body) => h.call('PUT', `/finance/ledgers/${id}`, body, 'md');
  await refused(put(pl.id, { active: false }), 400, 'FIN_BAD_INPUT');
  await refused(put(pl.id, { group_id: G.IndirectExpenses }), 400, 'FIN_BAD_INPUT');
  await refused(put(CASH, { active: false }), 400, 'FIN_BAD_INPUT');
  const ok = await put(CASH, { notes: 'The till', active: true, group_id: G.CashinHand });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ledger.notes, 'The till');
  const cash = (await ledgersOf(CI)).find(x => x.id === CASH);
  assert.deepEqual([cash.active, cash.group_id], [true, G.CashinHand]);
});

test('ledger and group ids in a path: a row nobody can see is the same 403 as a row in another book, and a bad id is 404', gate, async () => {
  const l = await newLedger(G.DirectExpenses, 'Epsilon Fuel');
  const g = await newGroup(G.DirectExpenses, 'Epsilon Group');
  const feb = PERIOD.CI['2027-02-01'];
  const calls = who => [
    h.call('PUT', `/finance/ledgers/${l.id}`, { notes: 'x' }, who),
    h.call('PUT', `/finance/groups/${g.id}`, { sort_order: 99 }, who),
    h.call('DELETE', `/finance/groups/${g.id}`, null, who),
    h.call('PUT', `/finance/periods/${feb}/status`, { status: 'closing' }, who),
  ];
  // a login with no Finance grant, and a login whose only grant is the other book
  for (const who of ['plant', 'dpOnly']) {
    for (const r of await Promise.all(calls(who))) assert.deepEqual([r.status, r.body.code], [403, 'FIN_FORBIDDEN'], who);
  }
  // rows that do not exist answer exactly as rows that are not yours
  for (const url of ['/finance/ledgers/999999', '/finance/groups/999999', '/finance/periods/999999/status']) {
    for (const who of ['md', 'plant']) {
      const r = await h.call('PUT', url, { status: 'closing', notes: 'x' }, who);
      assert.deepEqual([r.status, r.body.code], [403, 'FIN_FORBIDDEN'], `${who} ${url}`);
    }
  }
  assert.deepEqual((await h.call('DELETE', '/finance/groups/999999', null, 'md')).body.code, 'FIN_FORBIDDEN');
  // an id that cannot be one is 404, whoever asks
  for (const id of ['abc', '1.5', '0', '-3', '1e2', '0x1', '99999999999', '2147483648']) {
    for (const [method, url] of [['PUT', `/finance/ledgers/${id}`], ['PUT', `/finance/groups/${id}`], ['DELETE', `/finance/groups/${id}`], ['PUT', `/finance/periods/${id}/status`]]) {
      await refused(h.call(method, url, { status: 'closing' }, 'md'), 404, 'FIN_NOT_FOUND');
    }
  }
  // none of it changed anything
  const row = (await ledgersOf(CI)).find(x => x.id === l.id);
  assert.equal(row.notes, null);
  assert.equal((await groupsOf(CI)).find(x => x.id === g.id).sort_order > 0, true);
});

test('group edits: a rename, a move within the same side of the accounts, and the refusals', gate, async () => {
  const put = (id, body, who = 'md') => h.call('PUT', `/finance/groups/${id}`, body, who);
  const a = await newGroup(G.IndirectExpenses, 'Edit Alpha');
  const b = await newGroup(G.IndirectExpenses, 'Edit Beta');
  // a new group goes last in the book's order, so it never jumps ahead of Tally's own groups
  const order = (await groupsOf(CI)).filter(x => ![a.id, b.id].includes(x.id)).map(x => x.sort_order);
  assert.ok(a.sort_order > Math.max(...order) && b.sort_order > a.sort_order, `${a.sort_order}, ${b.sort_order} after ${Math.max(...order)}`);

  const renamed = await put(a.id, { name: '  Edit   Alpha Two ' });
  assert.equal(renamed.body.group.name, 'Edit Alpha Two');
  const rows = await auditOf('group', a.id);
  assert.deepEqual(rows.map(r => r.action), ['create', 'edit']);
  assert.deepEqual([rows[1].before.name, rows[1].after.name, rows[1].user_id], ['Edit Alpha', 'Edit Alpha Two', h.users.md.id]);
  await refused(put(a.id, { name: 'edit beta' }), 409, 'FIN_DUPLICATE_NAME');
  assert.equal((await put(a.id, { name: 'EDIT ALPHA TWO' })).status, 200, 'its own name in other capitals');
  await refused(put(a.id, { name: ' ' }), 400, 'FIN_BAD_INPUT', 'name');
  await refused(put(a.id, { name: 'Edit Alpha Two' }, 'acct'), 403, 'FIN_FORBIDDEN');

  // A move: under a sibling; never under itself or its own descendants
  const moved = await put(b.id, { parent_id: a.id });
  assert.equal(moved.body.group.parent_id, a.id);
  await refused(put(a.id, { parent_id: a.id }), 400, 'FIN_BAD_INPUT', 'parent_id');
  await refused(put(a.id, { parent_id: b.id }), 400, 'FIN_BAD_INPUT', 'parent_id');
  const c = await newGroup(b.id, 'Edit Gamma');
  await refused(put(a.id, { parent_id: c.id }), 400, 'FIN_BAD_INPUT', 'parent_id');
  // …the same side of the accounts: same nature, and the same treatment in gross profit
  const direct = await newGroup(G.DirectExpenses, 'Edit Direct');
  assert.equal((await put(direct.id, { parent_id: G.PurchaseAccounts })).status, 200);
  await refused(put(direct.id, { parent_id: G.IndirectExpenses }), 400, 'FIN_BAD_INPUT', 'parent_id');
  await refused(put(direct.id, { parent_id: G.SundryDebtors }), 400, 'FIN_BAD_INPUT', 'parent_id');
  await refused(put(direct.id, { parent_id: GD.PurchaseAccounts }), 400, 'FIN_BAD_INPUT', 'parent_id');
  await refused(put(direct.id, { parent_id: null }), 400, 'FIN_BAD_INPUT', 'parent_id');
  await refused(put(direct.id, { parent_id: 'x' }), 400, 'FIN_BAD_INPUT', 'parent_id');
  const kept = (await groupsOf(CI)).find(x => x.id === direct.id);
  assert.deepEqual([kept.parent_id, kept.nature, kept.affects_gross_profit], [G.PurchaseAccounts, 'expense', true]);

  // Nature alone: these parents are on the same side of gross profit as Edit Alpha (indirect), and differ only in what they are
  for (const [parent, nature] of [[G.FixedAssets, 'asset'], [G.CurrentLiabilities, 'liability'], [G.IndirectIncomes, 'income']]) {
    const r = await refused(put(a.id, { parent_id: parent }), 400, 'FIN_BAD_INPUT', 'parent_id');
    assert.match(r.body.error, new RegExp(`expense group can only sit under another expense group`), nature);
  }

  // The order among siblings
  assert.equal((await put(a.id, { sort_order: 500 })).body.group.sort_order, 500);
  for (const sort_order of [-1, 1.5, 'x', null, 2 ** 31]) await refused(put(a.id, { sort_order }), 400, 'FIN_BAD_INPUT', 'sort_order');

  // Ruling R19: a system group is neither renamed nor moved. Bank, cash, debtors, creditors and the Profit & Loss A/c are found by those names.
  await refused(put(G.SundryDebtors, { name: 'Debtors' }), 400, 'FIN_BAD_INPUT');
  await refused(put(G.SundryDebtors, { name: 'sundry debtors' }), 400, 'FIN_BAD_INPUT');
  await refused(put(G.BankAccounts, { parent_id: G.FixedAssets }), 400, 'FIN_BAD_INPUT');   // an otherwise legal move
  const sundry = (await groupsOf(CI)).find(x => x.id === G.SundryDebtors);
  const untouched = await put(G.SundryDebtors, { name: sundry.name, parent_id: sundry.parent_id, sort_order: sundry.sort_order });
  assert.equal(untouched.status, 200, 'saving a system group as it is, is not a rename');
  assert.equal((await auditOf('group', G.SundryDebtors)).length, 0);
  assert.equal((await put(G.SundryDebtors, { sort_order: sundry.sort_order + 1 })).body.group.sort_order, sundry.sort_order + 1);
  const after = (await groupsOf(CI)).find(x => x.id === G.SundryDebtors);
  assert.deepEqual([after.name, after.parent_id, after.is_system], [sundry.name, sundry.parent_id, true]);
});

test('deleting a group: an empty one goes and is audited; sub-groups, switched-off ledgers and a staged import each keep one', gate, async () => {
  const del = (id, who = 'md') => h.call('DELETE', `/finance/groups/${id}`, null, who);
  const lone = await newGroup(G.DirectExpenses, 'Delete Me');
  await refused(del(lone.id, 'acct'), 403, 'FIN_FORBIDDEN');
  const gone = await del(lone.id);
  assert.deepEqual([gone.status, gone.body], [200, { ok: true }]);
  assert.equal((await groupsOf(CI)).some(x => x.id === lone.id), false);
  const rows = await auditOf('group', lone.id);
  assert.deepEqual(rows.map(r => r.action), ['create', 'delete']);
  assert.deepEqual([rows[1].before.name, rows[1].after], ['Delete Me', null]);
  await refused(del(lone.id), 403, 'FIN_FORBIDDEN');     // gone, so it answers as a row nobody can see

  const parent = await newGroup(G.DirectExpenses, 'Delete Parent');
  const child = await newGroup(parent.id, 'Delete Child');
  const inUse = await refused(del(parent.id), 409, 'FIN_IN_USE');
  assert.match(inUse.body.error, /sub-group/);

  const ledger = await newLedger(child.id, 'Delete Ledger');
  assert.match((await refused(del(child.id), 409, 'FIN_IN_USE')).body.error, /ledger/);
  assert.equal((await h.call('PUT', `/finance/ledgers/${ledger.id}`, { active: false }, 'md')).status, 200);
  await refused(del(child.id), 409, 'FIN_IN_USE');      // a switched-off ledger still keeps its group

  // A group a staged Tally import proposes to put a new ledger under is held by that proposal's foreign key
  const staged = await newGroup(G.DirectExpenses, 'Delete Staged');
  const imp = await h.db.one(`INSERT INTO fin_imports (book_id, purpose, as_at) VALUES ($1, 'opening', '2026-12-31') RETURNING id`, [CI]);
  await h.db.q(`INSERT INTO fin_import_ledgers (import_id, tally_name, group_id, match_status) VALUES ($1, 'Staged Ledger', $2, 'create')`, [imp.id, staged.id]);
  await refused(del(staged.id), 409, 'FIN_IN_USE');
  assert.equal((await groupsOf(CI)).some(x => x.id === staged.id), true);
  assert.deepEqual((await auditOf('group', staged.id)).map(r => r.action), ['create'], 'a refused delete leaves no trace');
});

test('years: only a real YYYY-YY year of this century; one audit row; a year before the books begin is before_books', gate, async () => {
  const add = (label, who = 'md', book_id = CI) => h.call('POST', '/finance/years', { book_id, label }, who);
  for (const label of [undefined, null, 2027, '27-28', '2027-2028', '2027/28', '2027-29', '1999-00', '2100-01', '0001-02', '9999-00', 'abcd-ef', ' ', '']) {
    await refused(add(label), 400, 'FIN_BAD_INPUT', 'label');
  }
  const old = await add('2025-26');
  assert.equal(old.status, 200);
  assert.equal(old.body.year.periods.length, 12);
  assert.ok(old.body.year.periods.every(p => p.status === 'before_books'));
  const later = await add(' 2029-30 ');
  assert.equal(later.body.year.label, '2029-30');
  assert.ok(later.body.year.periods.every(p => p.status === 'open'));
  assert.deepEqual(later.body.year.periods.map(p => p.month_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const rows = await auditOf('year', later.body.year.id);
  assert.equal(rows.length, 1, 'the year is audited once, by the code that makes it');
  assert.deepEqual([rows[0].action, rows[0].user_id, rows[0].user_name], ['create', h.users.md.id, 'Test MD']);
  await refused(add('2029-30'), 409, 'FIN_EXISTS');
  assert.equal((await auditOf('year', later.body.year.id)).length, 1, 'a duplicate leaves no trace');
  // each book has its own years
  assert.equal((await add('2029-30', 'md', DP)).status, 200);
  await refused(add('2030-31', 'acct'), 403, 'FIN_FORBIDDEN');
  await refused(add('2030-31', 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refused(add('2030-31', 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(add('2030-31', 'md', 999999), 403, 'FIN_FORBIDDEN');
  // the read lists them oldest first, with their months
  const years = (await h.call('GET', `/finance/books/${CI}/years`)).body.years;
  const labels = years.map(y => y.label);
  assert.deepEqual(labels, [...labels].sort());
  assert.ok(labels.includes('2025-26') && labels.includes('2029-30'));
  assert.equal(years.find(y => y.label === '2029-30').periods.length, 12);
});

test('months: every move the spec allows, each refusal, who is recorded, and what the audit keeps', gate, async () => {
  const feb = PERIOD.CI['2027-02-01'];
  const set = (status, reason, who = 'appr2', id = feb) => h.call('PUT', `/finance/periods/${id}/status`, { status, reason }, who);
  const state = async () => (await h.call('GET', `/finance/books/${CI}/years`)).body.years.flatMap(y => y.periods).find(p => p.id === feb);
  const written = await auditCount();

  // From open: only closing
  await refused(set('locked'), 409, 'FIN_BAD_TRANSITION');
  await refused(set('open'), 409, 'FIN_BAD_TRANSITION');
  await refused(set('before_books', 'x'), 409, 'FIN_BAD_TRANSITION');
  await refused(set('bogus'), 400, 'FIN_BAD_INPUT', 'status');
  await refused(set(undefined), 400, 'FIN_BAD_INPUT', 'status');
  await refused(set(7), 400, 'FIN_BAD_INPUT', 'status');
  await refused(set('closing', { why: 'x' }), 400, 'FIN_BAD_INPUT', 'reason');
  await refused(set('closing', 'r'.repeat(501)), 400, 'FIN_BAD_INPUT', 'reason');
  assert.equal((await state()).status, 'open');
  assert.equal(await auditCount(), written, 'a refused move leaves no trace');

  const closing = await set('closing', 'Month-end review');
  assert.equal(closing.status, 200);
  assert.deepEqual([closing.body.period.id, closing.body.period.status, closing.body.period.status_changed_by], [feb, 'closing', 'Test Second Approver']);
  assert.ok(Date.now() - new Date(closing.body.period.status_changed_at).getTime() < 60_000);
  const seen = await state();
  assert.deepEqual([seen.status, seen.status_changed_by], ['closing', 'Test Second Approver']);

  // Reasons: a reason that is blank, whitespace or the word a client sends for "nothing" is no reason
  await refused(set('open'), 400, 'FIN_REASON_REQUIRED');
  await refused(set('open', ''), 400, 'FIN_REASON_REQUIRED');
  await refused(set('open', '   '), 400, 'FIN_REASON_REQUIRED');
  await refused(set('open', 'undefined'), 400, 'FIN_REASON_REQUIRED');
  await refused(set('open', 'null'), 400, 'FIN_REASON_REQUIRED');
  assert.equal((await state()).status, 'closing');

  assert.equal((await set('locked')).status, 200, 'closing to locked needs no reason');
  await refused(set('open', 'x'), 409, 'FIN_BAD_TRANSITION');
  await refused(set('locked', 'x'), 409, 'FIN_BAD_TRANSITION');
  await refused(set('closing', ' '), 400, 'FIN_REASON_REQUIRED');
  assert.equal((await set('closing', '  CA wants one more entry  ')).status, 200);
  assert.equal((await set('open', 'Nothing more to add', 'md')).status, 200);
  assert.equal((await state()).status, 'open');

  const rows = await auditOf('period', feb);
  assert.deepEqual(rows.map(r => [r.action, r.before.status, r.after.status, r.reason]), [
    ['status', 'open', 'closing', 'Month-end review'],
    ['status', 'closing', 'locked', null],
    ['status', 'locked', 'closing', 'CA wants one more entry'],
    ['status', 'closing', 'open', 'Nothing more to add'],
  ]);
  assert.deepEqual(rows.map(r => r.user_id), [h.users.appr2.id, h.users.appr2.id, h.users.appr2.id, h.users.md.id]);
  assert.equal(rows[0].after.label, 'Feb 2027');

  // Who: an approver of the book
  for (const who of ['viewer', 'acct', 'dpOnly', 'plant']) await refused(set('closing', null, who), 403, 'FIN_FORBIDDEN');
  assert.equal((await state()).status, 'open');
  // the other book's months are its own
  const dpFeb = PERIOD.DP['2027-02-01'];
  assert.equal((await set('closing', null, 'md', dpFeb)).status, 200);
  assert.equal((await state()).status, 'open');
  assert.equal((await set('open', 'put back', 'md', dpFeb)).status, 200);
});

test('a month before the books begin never moves, whoever asks and whatever reason they give', gate, async () => {
  const dec = PERIOD.CI['2026-12-01'];
  for (const status of ['open', 'closing', 'locked', 'before_books']) {
    const r = await refused(h.call('PUT', `/finance/periods/${dec}/status`, { status, reason: 'because' }, 'md'), 409, 'FIN_BAD_TRANSITION');
    assert.match(r.body.error, /before the books begin/i);
  }
  const month = (await h.call('GET', `/finance/books/${CI}/years`)).body.years.flatMap(y => y.periods).find(p => p.id === dec);
  assert.equal(month.status, 'before_books');
});

// ── Races: one transaction held open on a raw client while another arrives ──────────────────────

// A raw client on the throwaway database, with the qc / oc a route's tx() would hand a helper.
async function openClient() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const qc = async (text, params = []) => (await client.query(text, params)).rows;
  const oc = async (text, params = []) => (await qc(text, params))[0] ?? null;
  return { client, qc, oc };
}

// Wait until some backend is waiting for a lock, asked of Postgres and not of the clock.
async function lockWaiter(qc) {
  for (let i = 0; i < 200; i++) {
    const { n } = (await qc(`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0];
    if (n) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

test('two admins moving groups at once cannot tie the tree in a knot', gate, async () => {
  const { finUpdateGroup } = await import('./finance-masters.js');
  const MD = { id: h.users.md.id, name: 'Test MD' };
  const a = (await newGroup(G.DirectExpenses, 'Race Alpha')).id;
  const b = (await newGroup(G.DirectExpenses, 'Race Beta')).id;
  const first = await openClient();
  try {
    // The first admin puts Alpha under Beta and has not committed yet…
    await first.client.query('BEGIN');
    await finUpdateGroup(first.qc, first.oc, a, { parent_id: b }, MD);
    // The book is held in the kind of lock that a posting or a new ledger, which hold the book FOR KEY SHARE, do not wait for
    const probe = await openClient();
    try {
      await probe.client.query("SET lock_timeout = '1s'");
      await probe.client.query('BEGIN');
      await probe.qc('SELECT id FROM fin_books WHERE id = $1 FOR KEY SHARE', [CI]);   // times out (55P03) under FOR UPDATE
      await probe.client.query('ROLLBACK');
    } finally {
      await probe.client.end();
    }
    // …so the second, who would put Beta under Alpha, has to wait for the first
    const second = h.db.tx((qc, oc) => finUpdateGroup(qc, oc, b, { parent_id: a }, MD));
    second.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the second move waits for the first instead of reading the tree as it was');
    await first.client.query('COMMIT');
    await assert.rejects(second, e => e.status === 400 && e.body.code === 'FIN_BAD_INPUT');
  } finally {
    await first.client.end();
  }
  const rows = await h.db.q('SELECT id, parent_id FROM fin_groups WHERE id = ANY($1) ORDER BY id', [[a, b]]);
  assert.deepEqual(rows.map(r => [r.id, r.parent_id]), [[a, b], [b, G.DirectExpenses]]);
});

test('the same month moved twice at the same moment moves once; the second finds it already moved', gate, async () => {
  const { finSetPeriodStatus } = await import('./finance-masters.js');
  const mar = PERIOD.CI['2027-03-01'];
  const one = { id: h.users.appr2.id, name: 'Test Second Approver' };
  const two = { id: h.users.md.id, name: 'Test MD' };
  const first = await openClient();
  try {
    await first.client.query('BEGIN');
    await finSetPeriodStatus(first.qc, first.oc, mar, { status: 'closing' }, one);
    const second = h.db.tx((qc, oc) => finSetPeriodStatus(qc, oc, mar, { status: 'closing' }, two));
    second.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the second move waits for the first');
    await first.client.query('COMMIT');
    await assert.rejects(second, e => e.status === 409 && e.body.code === 'FIN_BAD_TRANSITION');
  } finally {
    await first.client.end();
  }
  const rows = await auditOf('period', mar);
  assert.deepEqual(rows.map(r => [r.before.status, r.after.status, r.user_id]), [['open', 'closing', one.id]], 'one move, one record');
  assert.equal((await h.call('PUT', `/finance/periods/${mar}/status`, { status: 'open', reason: 'put back after the race test' }, 'md')).status, 200);
});

test('two edits of one ledger at the same moment go one after the other, so each record starts where the last ended', gate, async () => {
  const { finUpdateLedger } = await import('./finance-masters.js');
  const who = { id: h.users.acct.id, name: 'Test Accountant' };
  const l = await newLedger(G.DirectExpenses, 'Zeta Stores');
  const first = await openClient();
  try {
    await first.client.query('BEGIN');
    await finUpdateLedger(first.qc, first.oc, l.id, { name: 'Zeta Stores Pvt' }, who);
    const second = h.db.tx((qc, oc) => finUpdateLedger(qc, oc, l.id, { notes: 'Second edit' }, who));
    second.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the second edit waits for the first');
    await first.client.query('COMMIT');
    const done = await second;
    assert.deepEqual([done.name, done.notes], ['Zeta Stores Pvt', 'Second edit']);
  } finally {
    await first.client.end();
  }
  const rows = await auditOf('ledger', l.id);
  assert.deepEqual(rows.map(r => [r.action, r.before?.name ?? null, r.after.name, r.after.notes]), [
    ['create', null, 'Zeta Stores', null],
    ['edit', 'Zeta Stores', 'Zeta Stores Pvt', null],
    ['edit', 'Zeta Stores Pvt', 'Zeta Stores Pvt', 'Second edit'],
  ]);
});

// ── Ruling R22 ───────────────────────────────────────────────────────────────────────────────

// Postgres refuses a NUL byte (\u0000) in TEXT, so a text field that let one through was a 500 with the
// database's own words in it. finOptionalText now turns it away (the voucher fields use the same helper), and
// finRequiredName always did, as a control character.
test('a NUL byte in any chart-of-accounts text is a 400 that names the field, never a 500 (ruling R22)', gate, async () => {
  const target = await newLedger(G.IndirectExpenses, 'Nul Target');
  const written = await auditCount();
  const ok = { book_id: CI, group_id: G.IndirectExpenses, name: 'Nul Probe' };
  const addLedger = extra => h.call('POST', '/finance/ledgers', { ...ok, ...extra }, 'acct');
  await refused(addLedger({ notes: 'a\u0000b' }), 400, 'FIN_BAD_INPUT', 'notes');
  await refused(addLedger({ code: 'A\u0000' }), 400, 'FIN_BAD_INPUT', 'code');
  await refused(addLedger({ tally_name: '\u0000' }), 400, 'FIN_BAD_INPUT', 'tally_name');
  await refused(addLedger({ name: 'Nul\u0000Probe' }), 400, 'FIN_BAD_INPUT', 'name');
  await refused(h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.DirectExpenses, name: 'Nul\u0000Group' }, 'md'), 400, 'FIN_BAD_INPUT', 'name');
  await refused(h.call('PUT', `/finance/ledgers/${target.id}`, { notes: 'x\u0000' }, 'acct'), 400, 'FIN_BAD_INPUT', 'notes');
  await refused(h.call('PUT', `/finance/ledgers/${target.id}`, { code: '\u0000x' }, 'acct'), 400, 'FIN_BAD_INPUT', 'code');
  await refused(h.call('PUT', `/finance/ledgers/${target.id}`, { tally_name: 'x\u0000' }, 'acct'), 400, 'FIN_BAD_INPUT', 'tally_name');
  await refused(h.call('PUT', `/finance/ledgers/${target.id}`, { name: 'x\u0000' }, 'acct'), 400, 'FIN_BAD_INPUT', 'name');
  await refused(h.call('PUT', `/finance/periods/${PERIOD.CI['2027-03-01']}/status`, { status: 'closing', reason: 'CA\u0000 adjustment' }, 'md'), 400, 'FIN_BAD_INPUT', 'reason');
  assert.equal(await auditCount(), written, 'nothing was written');
  assert.ok(!(await ledgersOf(CI)).some(l => /Nul Probe/.test(l.name)));
  assert.equal((await ledgersOf(CI)).find(l => l.id === target.id).notes, null);
  // a line break in a note is a line break, not a refusal
  const ok2 = await h.call('PUT', `/finance/ledgers/${target.id}`, { notes: 'first line\nsecond line' }, 'acct');
  assert.equal(ok2.status, 200);
  assert.equal(ok2.body.ledger.notes, 'first line\nsecond line');
});

test('the ledgers read says where the bill fields go: is_party by the one party rule (ruling R39), beside is_bank_cash by the one ancestry', gate, async () => {
  const vendor = await h.db.one('SELECT id FROM vendors ORDER BY id LIMIT 1');
  const exportDebtors = await newGroup(G.SundryDebtors, 'Export Debtors');
  const localCreditors = await newGroup(G.SundryCreditors, 'Local Creditors');
  // a link makes a party wherever the ledger is filed; the group makes one without a link; neither makes none
  await newLedger(G.IndirectExpenses, 'Linked But Filed Elsewhere', { party_type: 'vendor', party_id: vendor.id });
  await newLedger(G.SundryDebtors, 'Unlinked Debtor');
  await newLedger(exportDebtors.id, 'Unlinked Export Debtor');
  await newLedger(localCreditors.id, 'Unlinked Local Creditor');
  await newLedger(G.IndirectExpenses, 'Plain Expense');
  await newLedger(G.BankAccounts, 'Plain Bank');

  const by = Object.fromEntries((await ledgersOf(CI)).map(x => [x.name, x]));
  const flags = name => [by[name].is_party, by[name].is_bank_cash];
  assert.deepEqual(flags('Linked But Filed Elsewhere'), [true, false]);
  assert.deepEqual(flags('Unlinked Debtor'), [true, false], 'unlinked, but filed under Sundry Debtors');
  assert.deepEqual(flags('Unlinked Export Debtor'), [true, false], 'unlinked, filed beneath Sundry Debtors');
  assert.deepEqual(flags('Unlinked Local Creditor'), [true, false], 'unlinked, filed beneath Sundry Creditors');
  assert.deepEqual(flags('Plain Expense'), [false, false]);
  assert.deepEqual(flags('Plain Bank'), [false, true]);
  assert.deepEqual(flags('Cash'), [false, true]);
  assert.ok(Object.values(by).every(x => typeof x.is_party === 'boolean' && typeof x.is_bank_cash === 'boolean'), 'both flags on every ledger, always a boolean');
  // the other book answers for itself
  assert.ok((await ledgersOf(DP)).every(x => x.is_party === false || x.is_party === true));
});

// Fix round, M5. The Opening Match step and every screen that asks "is this group a party's?" read the answer off the group: the flag is
// finGroupKinds' (ruling R23), not a second walk down the names in the browser. The groups read carries both flags beside the ledgers'.
test('the groups read says which groups are a party\'s and which are bank or cash, by the walk the ledgers read and the voucher drafts use', gate, async () => {
  const exportDebtors = await newGroup(G.SundryDebtors, 'Overseas Debtors');
  const exportNorth = await newGroup(exportDebtors.id, 'Overseas Debtors - North');
  const localCreditors = await newGroup(G.SundryCreditors, 'Regional Creditors');
  const savings = await newGroup(G.BankAccounts, 'Savings Accounts');
  const lookAlike = await newGroup(G.CurrentAssets, 'Debtors');                      // not the name
  const reserve = await newGroup(G.CurrentAssets, 'Sundry Debtors Reserve');         // and not the name either
  const groups = await groupsOf(CI);
  const by = Object.fromEntries(groups.map(g => [g.id, g]));
  const flags = group => [by[group.id ?? group].is_party, by[group.id ?? group].is_bank_cash];
  assert.deepEqual(flags(G.SundryDebtors), [true, false]);
  assert.deepEqual(flags(exportDebtors), [true, false], 'beneath Sundry Debtors');
  assert.deepEqual(flags(exportNorth), [true, false], 'however deep');
  assert.deepEqual(flags(localCreditors), [true, false], 'beneath Sundry Creditors');
  assert.deepEqual(flags(G.BankAccounts), [false, true]);
  assert.deepEqual(flags(savings), [false, true], 'beneath Bank Accounts');
  assert.deepEqual(flags(lookAlike), [false, false], 'a name that merely looks like one');
  assert.deepEqual(flags(reserve), [false, false]);
  assert.deepEqual(flags(G.IndirectExpenses), [false, false]);
  // and it is finGroupKinds' answer for every group of the book, not a walk of its own
  const kinds = await finGroupKinds(h.db.q, CI);
  assert.ok(groups.length > 30, `non-vacuous: ${groups.length} groups`);
  for (const g of groups) assert.deepEqual([g.is_party, g.is_bank_cash], [kinds.get(g.id).is_party, kinds.get(g.id).is_bank_cash], g.name);
  // the ledgers read agrees with it: a ledger filed under a party group is a party's
  await newLedger(exportNorth.id, 'Unlinked North Debtor');
  assert.equal((await ledgersOf(CI)).find(l => l.name === 'Unlinked North Debtor').is_party, true);
  // the other book answers for itself
  const other = await groupsOf(DP);
  assert.ok(other.every(g => typeof g.is_party === 'boolean' && typeof g.is_bank_cash === 'boolean'));
  assert.equal(other.some(g => g.id === exportDebtors.id), false, 'and holds none of this book\'s groups');
});
