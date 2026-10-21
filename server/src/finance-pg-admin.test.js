import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';
import { finForgetAccess } from './finance-access.js';
import { finGrantAccess, finRevokeAccess } from './finance-admin.js';
import { setKnownTables } from './data-tables.js';

// Approval rules and Finance access (spec §6.8, §8): an admin changes when an Approver is needed, and who may do
// what in each book. Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-admin.test.js
//
// One boot for the file; books CI and DP set up with the six logins of FIN_TEST_USERS (md approver+admin on both,
// acct accountant on both, appr2 approver on CI, viewer viewer on CI, dpOnly accountant on DP, plant nothing). The
// tests share the database and run in order. The first four are the brief's, verbatim but for the file's gate.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
let CI, DP;          // book ids
let BANK, RENT;      // CI's Alpha Bank and Rent ledgers
let JAN;             // CI's January 2027 month
let c1, c2, pid1, pid2;   // two raw clients on the throwaway database, and their backends' pids (the race tests)

before(async () => {
  if (!ON) return;
  h = await finBootPg('admin');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  const groups = Object.fromEntries((await h.call('GET', `/finance/books/${CI}/groups`)).body.groups.map(g => [g.name, g.id]));
  const ledger = async (group, name) =>
    (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: groups[group], name }, 'acct')).body.ledger.id;
  BANK = await ledger('Bank Accounts', 'Alpha Bank');
  RENT = await ledger('Indirect Expenses', 'Rent');
  JAN = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2027-01-01'`, [CI])).id;
  c1 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c1.connect();
  await c2.connect();
  pid1 = (await c1.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  pid2 = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
});

after(async () => {
  for (const client of [c1, c2]) await client?.end().catch(() => {});
  await h?.close();
});

// A CI payment of `paise` out of Alpha Bank for rent, made by the accountant and submitted. The voucher the submit
// answers with: `posted` if the book's payment rule let it through, `submitted` if it waits for an Approver.
async function submitPayment(paise) {
  const made = await h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'payment', voucher_date: '2027-01-15', client_key: randomUUID(), narration: 'rent',
    lines: [{ ledger_id: RENT, debit_paise: paise, credit_paise: 0 }, { ledger_id: BANK, debit_paise: 0, credit_paise: paise }],
  }, 'acct');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const sent = await h.call('POST', `/finance/vouchers/${made.body.voucher.id}/submit`, null, 'acct');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body.voucher;
}

test('the MD lowers the payment limit and the next payment waits', gate, async () => {
  const rule = (await h.call('GET', `/finance/approval-rules?book=${CI}`)).body.rules.find(r => r.rule_key === 'payment');
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit', limit_paise: 5000000 }, 'acct')).status, 403);
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit' }, 'md')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('PUT', `/finance/approval-rules/${rule.id}`, { mode: 'above_limit', limit_paise: 5000000 }, 'md')).status, 200);
  assert.equal((await submitPayment(6000000)).status, 'submitted');
});

test('a grant takes effect at once and a revoke removes it at once', gate, async () => {
  const g = await h.call('POST', '/finance/access', { user_id: h.users.plant.id, book_id: CI, roles: ['viewer'] }, 'md');
  assert.equal(g.status, 200);
  assert.deepEqual((await h.call('GET', '/finance/me', null, 'plant')).body.books.map(b => b.code), ['CI']);
  await h.call('DELETE', `/finance/access/${g.body.grant.id}`, null, 'md');
  assert.deepEqual((await h.call('GET', '/finance/me', null, 'plant')).body.books, []);
  assert.equal((await h.call('GET', '/finance/access', null, 'acct')).status, 403);
  assert.equal((await h.call('POST', '/finance/access', { user_id: h.users.plant.id, book_id: CI, roles: ['owner'] }, 'md')).body.code, 'FIN_BAD_INPUT');
});

test('the last admin of a book cannot remove themself', gate, async () => {
  const mine = (await h.call('GET', '/finance/access', null, 'md')).body.grants.find(x => x.user_id === h.users.md.id && x.book_id === DP);
  assert.equal((await h.call('POST', '/finance/access', { user_id: h.users.md.id, book_id: DP, roles: ['approver'] }, 'md')).body.code, 'FIN_LAST_ADMIN');
  assert.equal((await h.call('DELETE', `/finance/access/${mine.id}`, null, 'md')).body.code, 'FIN_LAST_ADMIN');
});

test('rule and access changes are in the activity log with before and after', gate, async () => {
  const rows = (await h.call('GET', `/finance/activity?book=${CI}`)).body.rows;
  // the list is summaries (ruling R71); the record before and after is the row's, opened
  const rule = rows.find(r => r.entity === 'rule');
  assert.ok(rule, 'a rule change is in the log');
  const opened = (await h.call('GET', `/finance/activity/${rule.id}`)).body.row;
  assert.ok(opened.before && opened.after, 'with the rule before and after');
  assert.ok(rows.some(r => r.entity === 'access' && r.action === 'revoke'));
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

// Reads and writes as a login (md unless said). A rule is found by its book and key, a grant by its login and book.
const rulesOf = async (book, who = 'md') => (await h.call('GET', `/finance/approval-rules?book=${book}`, null, who)).body.rules;
const ruleOf = async (book, key) => (await rulesOf(book)).find(r => r.rule_key === key);
const put = (id, body, who = 'md') => h.call('PUT', `/finance/approval-rules/${id}`, body, who);
const grantsOf = async (who = 'md') => (await h.call('GET', '/finance/access', null, who)).body.grants;
const grantOf = async (user, book, who = 'md') => (await grantsOf(who)).find(g => g.user_id === h.users[user].id && g.book_id === book);
const grant = (user, book, roles, extra = {}, who = 'md') =>
  h.call('POST', '/finance/access', { user_id: h.users[user].id, book_id: book, roles, ...extra }, who);
const revoke = (id, who = 'md') => h.call('DELETE', `/finance/access/${id}`, null, who);
const adminsOf = async book => (await h.db.q(
  `SELECT user_id FROM fin_access WHERE book_id = $1 AND 'admin' = ANY (roles) ORDER BY user_id`, [book])).map(r => r.user_id);
const switchOff = id => h.db.q('UPDATE users SET active = 0 WHERE id = $1', [id]);
const switchOn = id => h.db.q('UPDATE users SET active = 1 WHERE id = $1', [id]);
const auditOf = (entity, id) => h.db.q(
  `SELECT book_id, action, user_id, user_name, reason, before, after FROM fin_audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id`, [entity, id]);

// Everything these routes can write, as it stands: the rules, the grants, and how many audit rows there are.
const state = async () => ({
  rules: await h.db.q('SELECT * FROM fin_approval_rules ORDER BY id'),
  access: await h.db.q('SELECT * FROM fin_access ORDER BY id'),
  audit: (await h.db.one('SELECT COUNT(*)::int AS n FROM fin_audit_log')).n,
});
// A refusal: its status and code, and the field it names when the refusal is about one.
async function refused(call, status, code, field) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field) assert.equal(r.body.field, field, JSON.stringify(r.body));
  return r;
}
// A refusal that also leaves the rules, the grants and the audit log exactly as they were. `call` is a function, so
// the request is not on its way before the "as they were" is read.
async function refusedAndNothingWritten(call, status, code, field) {
  const before = await state();
  const r = await refused(call(), status, code, field);
  assert.deepEqual(await state(), before, 'a refused request writes nothing');
  return r;
}

// ── The rules

test('the rules of a book: ten, in the spec\'s order, each with its limit in paise', gate, async () => {
  const dp = await h.call('GET', `/finance/approval-rules?book=${DP}`);
  assert.equal(dp.status, 200);
  assert.deepEqual(Object.keys(dp.body), ['rules']);
  assert.deepEqual(dp.body.rules.map(r => [r.rule_key, r.mode, r.limit_paise]), [
    ['journal', 'always', null], ['opening', 'always', null], ['reversal', 'always', null],
    ['credit_note', 'always', null], ['debit_note', 'always', null],
    ['payment', 'above_limit', 10000000], ['contra', 'above_limit', 10000000],
    ['receipt', 'never', null], ['sales', 'never', null], ['purchase', 'never', null],
  ]);
  for (const r of dp.body.rules) {
    assert.deepEqual(Object.keys(r).sort(), ['book_id', 'id', 'limit_paise', 'mode', 'rule_key', 'updated_at', 'updated_by']);
    assert.equal(r.book_id, DP);
    assert.equal(typeof r.updated_by, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.updated_at)), r.updated_at);
  }
  const ci = await rulesOf(CI);
  assert.equal(ci.length, 10);
  assert.ok(ci.every(r => r.book_id === CI));
  assert.equal(ci.find(r => r.rule_key === 'payment').limit_paise, 5000000, 'the first test\'s edit, and only in this book');
  assert.equal(ci.find(r => r.rule_key === 'contra').limit_paise, 10000000);
});

test('anyone who can read the book reads its rules; nobody else does', gate, async () => {
  for (const who of ['md', 'acct', 'appr2', 'viewer']) assert.equal((await h.call('GET', `/finance/approval-rules?book=${CI}`, null, who)).status, 200, who);
  assert.equal((await h.call('GET', `/finance/approval-rules?book=${DP}`, null, 'dpOnly')).status, 200);
  // a book you hold nothing on, and one that is not there, are the same answer
  for (const [who, book] of [['dpOnly', CI], ['viewer', DP], ['plant', CI], ['plant', DP], ['md', 999999]]) {
    await refused(h.call('GET', `/finance/approval-rules?book=${book}`, null, who), 403, 'FIN_FORBIDDEN');
  }
  await refused(h.call('GET', '/finance/approval-rules'), 400, 'FIN_BAD_INPUT', 'book');
  for (const book of ['abc', '1.5', '0', '-1', '99999999999']) {
    await refused(h.call('GET', `/finance/approval-rules?book=${book}`), 400, 'FIN_BAD_INPUT', 'book');
  }
});

test('a rule edit needs a mode and, for above_limit only, a limit in whole paise; anything else is refused and writes nothing', gate, async () => {
  const contra = await ruleOf(CI, 'contra');
  const bad = (body, field) => refusedAndNothingWritten(() => put(contra.id, body), 400, 'FIN_BAD_INPUT', field);
  for (const mode of [undefined, null, '', 'sometimes', 'ALWAYS', 7, true, ['always'], { mode: 'always' }, '__proto__']) await bad({ mode }, 'mode');
  await bad({ limit_paise: 5000000 }, 'mode');
  for (const limit_paise of [undefined, null, NaN]) await bad({ mode: 'above_limit', limit_paise }, 'limit_paise');     // no limit given
  for (const limit_paise of [-1, 1.5, 0.1 + 0.2, '5000000', '', true, [], {}, 2 ** 53, 1e14, 1e300]) {
    await bad({ mode: 'above_limit', limit_paise }, 'limit_paise');                                                    // not whole paise, or out of reach
  }
  for (const mode of ['always', 'never']) for (const limit_paise of [0, 5000000]) await bad({ mode, limit_paise }, 'limit_paise');
  await refusedAndNothingWritten(() => put(contra.id, ['above_limit']), 400, 'FIN_BAD_INPUT');                        // not a form

  // only an admin of the rule's book; a rule nobody holds is the same 403 as a rule that is not there
  for (const who of ['acct', 'appr2', 'viewer', 'dpOnly', 'plant']) {
    await refusedAndNothingWritten(() => put(contra.id, { mode: 'never' }, who), 403, 'FIN_FORBIDDEN');
  }
  await refused(put(999999, { mode: 'always' }), 403, 'FIN_FORBIDDEN');
  for (const id of ['abc', '1.5', '0', '-1']) await refused(put(id, { mode: 'always' }), 404, 'FIN_NOT_FOUND');
});

test('a rule edit keeps the limit in rupees and answers in paise; always and never keep none; nothing is a limit too', gate, async () => {
  const contra = await ruleOf(CI, 'contra');
  const others = async () => [...(await rulesOf(CI)).filter(r => r.id !== contra.id), ...(await rulesOf(DP))];
  const untouched = await others();
  const stored = () => h.db.one('SELECT mode, limit_amount::text AS limit_amount, updated_by FROM fin_approval_rules WHERE id = $1', [contra.id]);
  const edit = async (body, mode, limit_paise, rupees) => {
    const r = await put(contra.id, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body), ['rule']);
    assert.deepEqual(Object.keys(r.body.rule).sort(), ['book_id', 'id', 'limit_paise', 'mode', 'rule_key', 'updated_at', 'updated_by']);
    assert.deepEqual([r.body.rule.id, r.body.rule.book_id, r.body.rule.rule_key, r.body.rule.updated_by], [contra.id, CI, 'contra', 'Test MD']);
    assert.deepEqual([r.body.rule.mode, r.body.rule.limit_paise], [mode, limit_paise]);
    assert.deepEqual(await stored(), { mode, limit_amount: rupees, updated_by: 'Test MD' });
    assert.deepEqual(await ruleOf(CI, 'contra'), r.body.rule, 'the list reads back what the edit answered');
  };
  await edit({ mode: 'above_limit', limit_paise: 12345678 }, 'above_limit', 12345678, '123456.78');
  await edit({ mode: 'above_limit', limit_paise: 0 }, 'above_limit', 0, '0.00');
  await edit({ mode: 'above_limit', limit_paise: 99999999999999 }, 'above_limit', 99999999999999, '999999999999.99');   // the highest, and it reads back exactly
  await edit({ mode: 'always' }, 'always', null, null);
  await edit({ mode: 'never', limit_paise: null }, 'never', null, null);
  await edit({ mode: 'above_limit', limit_paise: 10000000 }, 'above_limit', 10000000, '100000.00');                       // the default again
  assert.deepEqual(await others(), untouched, 'no other rule moved, in either book');
});

test('saving a rule as it already is writes nothing: no audit row, and its stamp does not move', gate, async () => {
  const contra = await ruleOf(CI, 'contra');
  const before = await state();
  const same = await put(contra.id, { mode: contra.mode, limit_paise: contra.limit_paise });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.rule, contra);
  assert.deepEqual(await state(), before);
});

test('a rule edit is logged once, as the rule was and as it is; a refused one is not logged', gate, async () => {
  const journal = await ruleOf(CI, 'journal');
  assert.deepEqual([journal.mode, journal.limit_paise], ['always', null]);
  assert.deepEqual(await auditOf('rule', journal.id), []);
  await refusedAndNothingWritten(() => put(journal.id, { mode: 'above_limit' }), 400, 'FIN_BAD_INPUT', 'limit_paise');
  assert.equal((await put(journal.id, { mode: 'above_limit', limit_paise: 250000 })).status, 200);
  assert.deepEqual(await auditOf('rule', journal.id), [{
    book_id: CI, action: 'edit', user_id: h.users.md.id, user_name: 'Test MD', reason: null,
    before: { rule_key: 'journal', mode: 'always', limit_paise: null },
    after: { rule_key: 'journal', mode: 'above_limit', limit_paise: 250000 },
  }]);
  assert.equal((await put(journal.id, { mode: 'always' })).status, 200);                        // the default again
  const rows = await auditOf('rule', journal.id);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1].before, rows[1].after], [rows[0].after, rows[0].before], 'the second edit undoes the first');
});

test('the payment rule decides the next payment, both ways: under the limit it posts, "always" makes it wait, "never" lets a large one through', gate, async () => {
  const payment = await ruleOf(CI, 'payment');
  assert.equal(payment.limit_paise, 5000000);                                                   // the first test's edit
  assert.equal((await submitPayment(4000000)).status, 'posted');
  assert.equal((await submitPayment(5000000)).status, 'posted', 'the limit itself is not above it');
  assert.equal((await submitPayment(5000001)).status, 'submitted');
  await put(payment.id, { mode: 'always' });
  assert.equal((await submitPayment(100)).status, 'submitted');
  await put(payment.id, { mode: 'never' });
  assert.equal((await submitPayment(990000000)).status, 'posted');
  await put(payment.id, { mode: 'above_limit', limit_paise: 0 });
  assert.equal((await submitPayment(1)).status, 'submitted', 'a limit of nothing: every payment is above it');
  await put(payment.id, { mode: 'above_limit', limit_paise: 10000000 });                       // back to the default
  assert.equal((await submitPayment(10000000)).status, 'posted');
  assert.equal((await submitPayment(10000001)).status, 'submitted');
});

// ── The access list

test('the access list: grants on the books the caller administers, each with its login, and the logins that can be given one', gate, async () => {
  const r = await h.call('GET', '/finance/access');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['grants', 'users']);
  const at = (user, book) => r.body.grants.find(g => g.user_id === h.users[user].id && g.book_id === book);
  assert.equal(r.body.grants.length, 7, 'md and acct on both books, appr2 and viewer on CI, dpOnly on DP; plant none');
  assert.deepEqual(Object.keys(at('md', CI)).sort(), ['book_id', 'can_export', 'email', 'id', 'roles', 'user_id', 'user_name']);
  assert.deepEqual(at('md', CI), {
    id: at('md', CI).id, user_id: h.users.md.id, user_name: 'Test MD', email: 'md@fin.test', book_id: CI, roles: ['approver', 'admin'], can_export: true,
  });
  assert.deepEqual([at('viewer', CI).roles, at('viewer', CI).can_export], [['viewer'], false]);
  assert.deepEqual([at('dpOnly', DP).roles, at('dpOnly', DP).user_name], [['accountant'], 'Test DP Accountant']);
  assert.equal(at('plant', CI), undefined);
  assert.equal(at('plant', DP), undefined);
  const order = r.body.grants.map(g => [g.book_id, g.user_name.toLowerCase()]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)), 'by book, then by name');

  // the logins: active ones, with their plant role
  assert.deepEqual(Object.keys(r.body.users[0]).sort(), ['email', 'id', 'name', 'role']);
  const user = key => r.body.users.find(u => u.id === h.users[key].id);
  assert.deepEqual(user('plant'), { id: h.users.plant.id, name: 'Test Plant Admin', email: 'plant@fin.test', role: 'admin' });
  assert.equal(user('appr2').role, 'planner');
  const names = r.body.users.map(u => u.name.toLowerCase());
  assert.deepEqual(names, [...names].sort(), 'by name');

  // a login switched off is not offered, but its grant stays listed, so that it can be revoked
  await switchOff(h.users.viewer.id);
  try {
    const off = (await h.call('GET', '/finance/access')).body;
    assert.equal(off.users.some(u => u.id === h.users.viewer.id), false);
    assert.equal(off.users.some(u => u.id === h.users.plant.id), true);
    assert.deepEqual(off.grants.find(g => g.user_id === h.users.viewer.id && g.book_id === CI), at('viewer', CI));
  } finally { await switchOn(h.users.viewer.id); }

  // a grant whose login is gone still lists, without a name, and can be revoked
  const orphan = await h.db.one(`INSERT INTO fin_access (user_id, book_id, roles) VALUES (987654, $1, '{viewer}') RETURNING id`, [DP]);
  try {
    const listed = (await h.call('GET', '/finance/access')).body.grants.find(g => g.id === orphan.id);
    assert.deepEqual(listed, { id: orphan.id, user_id: 987654, user_name: null, email: null, book_id: DP, roles: ['viewer'], can_export: true });
    assert.deepEqual((await revoke(orphan.id)).body, { ok: true });
  } finally { await h.db.q('DELETE FROM fin_access WHERE id = $1', [orphan.id]); }

  // only an admin of some book is told who holds what
  for (const who of ['acct', 'appr2', 'viewer', 'dpOnly', 'plant']) await refused(h.call('GET', '/finance/access', null, who), 403, 'FIN_FORBIDDEN');
});

test('an admin of one book sees and changes that book\'s grants and rules, and nothing of the other\'s', gate, async () => {
  assert.equal((await h.call('GET', '/finance/access', null, 'dpOnly')).status, 403);          // dpOnly's grants (accountant) are held now
  const made = await grant('dpOnly', DP, ['accountant', 'admin']);                              // md makes dpOnly an admin of DP
  assert.equal(made.status, 200);
  const list = await h.call('GET', '/finance/access', null, 'dpOnly');
  assert.equal(list.status, 200, 'felt at once, though accountant was what was held');
  assert.deepEqual([...new Set(list.body.grants.map(g => g.book_id))], [DP], 'the grants of DP and none of CI\'s');
  assert.equal(list.body.grants.length, 3);

  const dpPayment = await ruleOf(DP, 'payment');
  const ciPayment = await ruleOf(CI, 'payment');
  assert.equal((await put(dpPayment.id, { mode: 'always' }, 'dpOnly')).status, 200);
  await refusedAndNothingWritten(() => put(ciPayment.id, { mode: 'always' }, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(() => grant('plant', CI, ['viewer'], {}, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(async () => revoke((await grantOf('acct', CI)).id, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  const theirs = await grant('plant', DP, ['viewer'], {}, 'dpOnly');
  assert.equal(theirs.status, 200);
  assert.equal((await revoke(theirs.body.grant.id, 'dpOnly')).status, 200);

  // put it back: the rule as it was, and dpOnly an accountant only, which dpOnly feels at once
  assert.equal((await put(dpPayment.id, { mode: 'above_limit', limit_paise: 10000000 })).status, 200);
  assert.equal((await grant('dpOnly', DP, ['accountant'])).status, 200);
  await refused(h.call('GET', '/finance/access', null, 'dpOnly'), 403, 'FIN_FORBIDDEN');
});

test('a grant or a revoke is seen by the very next request, even from a login whose old grants were being held', gate, async () => {
  const groups = () => h.call('GET', `/finance/books/${CI}/groups`, null, 'plant').then(r => r.status);
  // 403 where the login is not an Approver of the month, 400 where it is (it got as far as the body)
  const asApprover = () => h.call('PUT', `/finance/periods/${JAN}/status`, { status: 'nonsense' }, 'plant').then(r => r.status);
  assert.deepEqual([await groups(), await asApprover()], [403, 403]);                           // plant holds nothing, and that is now held

  const first = await grant('plant', CI, ['viewer']);
  assert.equal(first.status, 200);
  assert.deepEqual([await groups(), await asApprover()], [200, 403], 'a grant is felt at once');
  const edited = await grant('plant', CI, ['viewer', 'approver']);
  assert.equal(edited.body.grant.id, first.body.grant.id);
  assert.deepEqual([await groups(), await asApprover()], [200, 400], 'so is a change of role');
  assert.equal((await revoke(first.body.grant.id)).status, 200);
  assert.deepEqual([await groups(), await asApprover()], [403, 403], 'and a revoke');
});

// ── Giving access

test('a grant names a login that is switched on, a book, a list of known roles, and true or false for export; anything else is a 400 that writes nothing', gate, async () => {
  const plant = h.users.plant.id;
  const ok = { user_id: plant, book_id: CI, roles: ['viewer'] };
  const bad = (body, field) => refusedAndNothingWritten(() => h.call('POST', '/finance/access', body), 400, 'FIN_BAD_INPUT', field);
  for (const user_id of [undefined, null, 0, -1, 1.5, 'abc', '', [], {}, true, 2 ** 31]) await bad({ ...ok, user_id }, 'user_id');
  await bad({ ...ok, user_id: 999999 }, 'user_id');                                             // no such login
  await switchOff(plant);
  try { await bad(ok, 'user_id'); } finally { await switchOn(plant); }                          // one that is switched off
  for (const book_id of [undefined, null, 0, 'abc', 1.5, 2 ** 31]) await bad({ ...ok, book_id }, 'book_id');
  for (const roles of [undefined, null, [], 'viewer', {}, ['owner'], ['viewer', 'owner'], [1], [null], ['Viewer'], ['__proto__'], [['viewer']]]) {
    await bad({ ...ok, roles }, 'roles');
  }
  for (const can_export of [null, 'yes', 'true', 0, 1, []]) await bad({ ...ok, can_export }, 'can_export');
  await refusedAndNothingWritten(() => h.call('POST', '/finance/access', [ok]), 400, 'FIN_BAD_INPUT');

  // only an admin of that book; and a non-admin learns nothing of whether the body was any good
  for (const who of ['acct', 'appr2', 'viewer', 'dpOnly', 'plant']) {
    await refusedAndNothingWritten(() => h.call('POST', '/finance/access', ok, who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(() => h.call('POST', '/finance/access', { ...ok, roles: ['owner'] }, who), 403, 'FIN_FORBIDDEN');
  }
  await refusedAndNothingWritten(() => h.call('POST', '/finance/access', { ...ok, book_id: 999999 }), 403, 'FIN_FORBIDDEN');
});

test('a grant is an upsert on login and book: its roles written whole, once each in a fixed order, the same row every time', gate, async () => {
  const plant = h.users.plant.id;
  const first = await grant('plant', DP, ['viewer']);
  assert.equal(first.status, 200);
  const g = first.body.grant;
  assert.deepEqual(g, { id: g.id, user_id: plant, user_name: 'Test Plant Admin', email: 'plant@fin.test', book_id: DP, roles: ['viewer'], can_export: true });
  assert.deepEqual(await grantOf('plant', DP), g, 'the list says what the grant answered');
  assert.equal((await h.db.one('SELECT granted_by FROM fin_access WHERE id = $1', [g.id])).granted_by, 'Test MD');

  // roles are a set: each once, in the order of FIN_ROLES; and a change is the same row, not a second one
  const second = await grant('plant', DP, ['admin', 'viewer', 'viewer', 'approver'], { can_export: false });
  assert.deepEqual(second.body.grant, { ...g, roles: ['viewer', 'approver', 'admin'], can_export: false });
  // …the roles are written whole, replaced and not added to; the body says nothing of export, so it is left as it was (ruling R31)
  const third = await grant('plant', DP, ['accountant']);
  assert.deepEqual(third.body.grant, { ...g, roles: ['accountant'], can_export: false });
  assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_access WHERE user_id = $1 AND book_id = $2', [plant, DP])).n, 1);

  // the same again changes nothing, whether export is left out or said as it is: no audit row, and the stamp does not move
  const before = await state();
  assert.deepEqual((await grant('plant', DP, ['accountant'])).body.grant, third.body.grant);
  assert.deepEqual((await grant('plant', DP, ['accountant'], { can_export: false })).body.grant, third.body.grant);
  assert.deepEqual(await state(), before);

  const snap = (roles, can_export) => ({ user_id: plant, user_name: 'Test Plant Admin', email: 'plant@fin.test', roles, can_export });
  assert.deepEqual(await auditOf('access', g.id), [
    { book_id: DP, action: 'grant', user_id: h.users.md.id, user_name: 'Test MD', reason: null, before: null, after: snap(['viewer'], true) },
    { book_id: DP, action: 'grant', user_id: h.users.md.id, user_name: 'Test MD', reason: null, before: snap(['viewer'], true), after: snap(['viewer', 'approver', 'admin'], false) },
    { book_id: DP, action: 'grant', user_id: h.users.md.id, user_name: 'Test MD', reason: null, before: snap(['viewer', 'approver', 'admin'], false), after: snap(['accountant'], false) },
  ]);

  // the grants on two books are two rows, and a revoke of one leaves the other
  const onCi = await grant('plant', CI, ['viewer']);
  assert.notEqual(onCi.body.grant.id, g.id);
  assert.equal((await revoke(onCi.body.grant.id)).status, 200);
  assert.deepEqual(await grantOf('plant', DP), third.body.grant);
  assert.equal((await revoke(g.id)).status, 200);
});

// Ruling R31. Export is the one field a body may leave out. A grant that is new exports (the table's own default); a grant that
// exists keeps what it has, so widening someone's roles can never switch back on an export an admin turned off (finance-setup.js
// never does either). Only an explicit true does, and it is a change like any other: written, and logged.
test('export is kept unless the body says: a grant that cannot export still cannot when its roles change; only an explicit true turns it on, and that is logged', gate, async () => {
  const viewer = await grantOf('viewer', CI);                                    // the harness's viewer: viewer on CI, export off
  assert.deepEqual([viewer.roles, viewer.can_export], [['viewer'], false]);
  const exportOf = async () => (await h.call('GET', '/finance/me', null, 'viewer')).body.books.map(b => [b.code, b.can_export]);
  const trail = async () => (await auditOf('access', viewer.id)).map(r => [r.action, r.user_name, r.before?.roles, r.before?.can_export, r.after.roles, r.after.can_export]);
  assert.deepEqual(await exportOf(), [['CI', false]]);
  const logged = (await trail()).length;
  const before = await state();
  try {
    // the body says nothing of export: the same roles change nothing at all…
    const same = await grant('viewer', CI, ['viewer']);
    assert.deepEqual([same.status, same.body.grant], [200, viewer]);
    assert.deepEqual(await state(), before, 'a repeat writes nothing');
    // …and wider roles change the roles and leave export off, as the grant itself and /finance/me both say
    const wider = await grant('viewer', CI, ['viewer', 'accountant']);
    assert.deepEqual(wider.body.grant, { ...viewer, roles: ['viewer', 'accountant'], can_export: false });
    assert.deepEqual(await grantOf('viewer', CI), wider.body.grant);
    assert.deepEqual(await exportOf(), [['CI', false]]);

    // an explicit true turns it on, as a change: written, felt by /finance/me, and logged with the flag going false to true
    const on = await grant('viewer', CI, ['viewer', 'accountant'], { can_export: true });
    assert.deepEqual(on.body.grant, { ...viewer, roles: ['viewer', 'accountant'], can_export: true });
    assert.deepEqual(await exportOf(), [['CI', true]]);
    // …and from then on left out means kept: still on, and a repeat writes nothing
    const kept = await state();
    assert.deepEqual((await grant('viewer', CI, ['viewer', 'accountant'])).body.grant, on.body.grant);
    assert.deepEqual(await state(), kept);

    // an explicit false turns it off again
    const off = await grant('viewer', CI, ['viewer', 'accountant'], { can_export: false });
    assert.equal(off.body.grant.can_export, false);
    assert.deepEqual((await trail()).slice(logged), [
      ['grant', 'Test MD', ['viewer'], false, ['viewer', 'accountant'], false],
      ['grant', 'Test MD', ['viewer', 'accountant'], false, ['viewer', 'accountant'], true],
      ['grant', 'Test MD', ['viewer', 'accountant'], true, ['viewer', 'accountant'], false],
    ]);
  } finally {
    await grant('viewer', CI, ['viewer'], { can_export: false });                // the harness's grant again
  }
  assert.deepEqual(await grantOf('viewer', CI), viewer);

  // a grant that is new exports unless it says not to, and keeps that when its roles change
  const plant = h.users.plant.id;
  const fresh = await grant('plant', CI, ['viewer']);
  assert.equal(fresh.body.grant.can_export, true);
  assert.equal((await revoke(fresh.body.grant.id)).status, 200);
  const closed = await grant('plant', CI, ['viewer'], { can_export: false });
  assert.deepEqual(closed.body.grant, { ...fresh.body.grant, id: closed.body.grant.id, can_export: false });
  assert.equal((await grant('plant', CI, ['viewer', 'accountant'])).body.grant.can_export, false);
  assert.deepEqual((await h.db.one('SELECT can_export FROM fin_access WHERE user_id = $1 AND book_id = $2', [plant, CI])), { can_export: false });
  assert.equal((await revoke(closed.body.grant.id)).status, 200);
});

// ── Taking access away

test('a revoke takes the grant away and says what it took; one already gone is refused like any row nobody holds', gate, async () => {
  const g = (await grant('plant', DP, ['viewer', 'accountant'], { can_export: false })).body.grant;
  const gone = await revoke(g.id);
  assert.deepEqual([gone.status, gone.body], [200, { ok: true }]);
  assert.equal(await h.db.one('SELECT id FROM fin_access WHERE id = $1', [g.id]), null);
  assert.equal(await grantOf('plant', DP), undefined);
  const rows = await auditOf('access', g.id);
  assert.deepEqual(rows.at(-1), {
    book_id: DP, action: 'revoke', user_id: h.users.md.id, user_name: 'Test MD', reason: null,
    before: { user_id: h.users.plant.id, user_name: 'Test Plant Admin', email: 'plant@fin.test', roles: ['viewer', 'accountant'], can_export: false },
    after: null,
  });

  // a second revoke (a double-click, a screen that has not caught up) is the answer for a row that is not there
  await refusedAndNothingWritten(() => revoke(g.id), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(() => revoke(999999), 403, 'FIN_FORBIDDEN');
  for (const id of ['abc', '1.5', '0', '-1']) await refused(revoke(id), 404, 'FIN_NOT_FOUND');

  // only an admin of the grant's book
  const acctOnCi = await grantOf('acct', CI);
  for (const who of ['acct', 'appr2', 'viewer', 'plant', 'dpOnly']) {
    await refusedAndNothingWritten(() => revoke(acctOnCi.id, who), 403, 'FIN_FORBIDDEN');
  }
  assert.ok(await grantOf('acct', CI), 'still there');
});

test('the last admin: an admin may go only while another admin, with a login that is switched on, stays', gate, async () => {
  const md = h.users.md.id;
  const dp = h.users.dpOnly.id;
  const mdOnDp = await grantOf('md', DP);
  assert.deepEqual(await adminsOf(DP), [md]);

  // alone, every way of letting the admin role go is refused, and nothing changes
  for (const roles of [['approver'], ['viewer'], ['accountant', 'approver']]) {
    await refusedAndNothingWritten(() => grant('md', DP, roles), 409, 'FIN_LAST_ADMIN');
  }
  await refusedAndNothingWritten(() => revoke(mdOnDp.id), 409, 'FIN_LAST_ADMIN');
  await refusedAndNothingWritten(async () => revoke((await grantOf('md', CI)).id), 409, 'FIN_LAST_ADMIN');   // and CI is the same
  // …but an edit that keeps it is nobody's last-admin business
  assert.equal((await grant('md', DP, ['admin'], { can_export: false })).status, 200);
  assert.equal((await grant('md', DP, ['approver', 'admin'])).status, 200);

  // a second admin whose login is switched off, or gone, is no admin
  assert.equal((await grant('dpOnly', DP, ['accountant', 'admin'])).status, 200);
  await switchOff(dp);
  try { await refusedAndNothingWritten(() => grant('md', DP, ['approver']), 409, 'FIN_LAST_ADMIN'); } finally { await switchOn(dp); }
  const ghost = await h.db.one(`INSERT INTO fin_access (user_id, book_id, roles) VALUES (987654, $1, '{admin}') RETURNING id`, [CI]);
  try { await refusedAndNothingWritten(() => grant('md', CI, ['approver']), 409, 'FIN_LAST_ADMIN'); } finally { await h.db.q('DELETE FROM fin_access WHERE id = $1', [ghost.id]); }

  // with a second admin on DP, either may go
  assert.deepEqual(await adminsOf(DP), [md, dp].sort((a, b) => a - b));
  assert.equal((await grant('md', DP, ['approver'])).status, 200);
  assert.deepEqual(await adminsOf(DP), [dp]);
  await refused(grant('plant', DP, ['viewer']), 403, 'FIN_FORBIDDEN');                          // md is no longer an admin of DP, and feels it at once
  // dpOnly is the last now
  await refusedAndNothingWritten(() => grant('dpOnly', DP, ['accountant'], {}, 'dpOnly'), 409, 'FIN_LAST_ADMIN');
  await refusedAndNothingWritten(async () => revoke((await grantOf('dpOnly', DP, 'dpOnly')).id, 'dpOnly'), 409, 'FIN_LAST_ADMIN');
  // dpOnly makes md an admin again, and then dpOnly may go
  assert.equal((await grant('md', DP, ['approver', 'admin'], {}, 'dpOnly')).status, 200);
  assert.equal((await grant('dpOnly', DP, ['accountant'], {}, 'dpOnly')).status, 200);
  assert.deepEqual(await adminsOf(DP), [md], 'as it began');
  // and an admin who is not the last can be revoked outright
  assert.equal((await grant('plant', DP, ['admin'])).status, 200);
  assert.equal((await revoke((await grantOf('md', DP)).id, 'plant')).status, 200);
  assert.deepEqual(await adminsOf(DP), [h.users.plant.id]);
  assert.equal((await grant('md', DP, ['approver', 'admin'], {}, 'plant')).status, 200);
  assert.equal((await revoke((await grantOf('plant', DP)).id)).status, 200);
  assert.deepEqual(await adminsOf(DP), [md]);
});

// ── Two admins at the same moment (spec §8.2)
// Each side is a transaction of its own on a raw client, run the way a route's tx() runs one. Where a test says one side
// waits for the other, it asks Postgres (pg_stat_activity), never the clock.

// qc / oc on a raw client, the way db.js tx() hands them to a helper.
const clientQ = client => {
  const qc = async (text, params = []) => (await client.query(text, params)).rows;
  return { qc, oc: async (text, params = []) => (await qc(text, params))[0] ?? null };
};
async function inTx(client, fn) {
  const { qc, oc } = clientQ(client);
  await client.query('BEGIN');
  try {
    const result = await fn(qc, oc);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
// A transaction left open on a raw client: a request that has done everything but COMMIT.
async function opened(client) {
  const { qc, oc } = clientQ(client);
  await client.query('BEGIN');
  let live = true;
  return {
    qc, oc,
    commit: async () => { live = false; await client.query('COMMIT'); },
    close: async () => { if (live) { live = false; await client.query('ROLLBACK').catch(() => {}); } },
  };
}
// What a backend waits on, once it waits for a lock: 'transactionid' or 'tuple' for a row another transaction holds.
async function lockWaitOf(pid) {
  for (let i = 0; i < 400; i++) {
    const row = await h.db.one('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (row?.wait_event_type === 'Lock') return row.wait_event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}
const ROW_WAITS = ['transactionid', 'tuple'];

test('two admins revoke each other at the same moment: the second waits for the first, then finds it is the last', gate, async () => {
  const MD = { id: h.users.md.id, name: 'Test MD' };
  const DPONLY = { id: h.users.dpOnly.id, name: 'Test DP Accountant' };
  assert.equal((await grant('dpOnly', DP, ['accountant', 'admin'])).status, 200);               // DP has two admins: md and dpOnly
  const mdGrant = await grantOf('md', DP);
  const dpGrant = await grantOf('dpOnly', DP);
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await finRevokeAccess(first.qc, first.oc, mdGrant.id, MD)).id, mdGrant.id);   // all but the COMMIT
    second = inTx(c2, (qc, oc) => finRevokeAccess(qc, oc, dpGrant.id, DPONLY));
    second.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'the second waits for the first\'s grants');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_LAST_ADMIN');
  } finally {
    await first.close();
    await second?.catch(() => {});
    finForgetAccess();                                                                          // these did not go through a route
  }
  assert.deepEqual(await adminsOf(DP), [DPONLY.id], 'one admin is left, not none');
  // put it back: dpOnly makes md an admin again, and then goes back to being an accountant
  assert.equal((await grant('md', DP, ['approver', 'admin'], {}, 'dpOnly')).status, 200);
  assert.equal((await grant('dpOnly', DP, ['accountant'], {}, 'dpOnly')).status, 200);
  assert.deepEqual(await adminsOf(DP), [MD.id]);
});

// The other side of the next two tests: dpOnly's admin role taken away on c1 and not yet committed. md then takes its own
// admin role away. Counting the admins that are left without first holding the book's grants would still see dpOnly's
// (c1 has not committed), let md go, and leave DP with none. Holding them first, md waits for c1 and counts after it.
async function mdLeavesWhileTheOtherAdminIs(leave) {
  const MD = { id: h.users.md.id, name: 'Test MD' };
  assert.equal((await grant('dpOnly', DP, ['accountant', 'admin'])).status, 200);
  const mdGrant = await grantOf('md', DP);
  const dpGrant = await grantOf('dpOnly', DP);
  const first = await opened(c1);
  let second;
  try {
    await first.qc(`UPDATE fin_access SET roles = '{accountant}' WHERE id = $1`, [dpGrant.id]);   // all but the COMMIT
    second = inTx(c2, (qc, oc) => leave(qc, oc, MD, mdGrant));
    second.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'md waits for the grants c1 holds');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_LAST_ADMIN');
  } finally {
    await first.close();
    await second?.catch(() => {});
    finForgetAccess();
  }
  assert.deepEqual(await adminsOf(DP), [MD.id], 'md is still the admin: nothing was lost');
  assert.deepEqual((await grantOf('dpOnly', DP)).roles, ['accountant']);
}

test('a revoke holds the book\'s grants before it counts the admins left: it waits for another admin\'s change, then counts after it', gate, async () => {
  await mdLeavesWhileTheOtherAdminIs((qc, oc, MD, mdGrant) => finRevokeAccess(qc, oc, mdGrant.id, MD));
});

test('a grant that drops the admin role holds the book\'s grants before it counts the admins left: it waits for another admin\'s change, then counts after it', gate, async () => {
  await mdLeavesWhileTheOtherAdminIs((qc, oc, MD) => finGrantAccess(qc, oc, { user_id: MD.id, book_id: DP, roles: ['approver'] }, MD));
});

// ── What the screens rely on

test('the tables each list is built from: the rules list fin_approval_rules, the access list fin_access and users', gate, async () => {
  const names = (await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(r => r.tablename);
  setKnownTables(names);                    // the harness connects before init(), so nothing is known until now
  const tablesOf = async url => {
    finForgetAccess();                      // a held answer would read nothing at all, and prove nothing
    const res = await fetch(h.base + url, { headers: { authorization: `Bearer ${h.users.md.token}` } });
    assert.equal(res.status, 200, url);
    return (res.headers.get('x-data-tables') ?? '').split(',').filter(Boolean);
  };
  assert.deepEqual(await tablesOf(`/finance/approval-rules?book=${CI}`), ['fin_approval_rules']);
  const access = await tablesOf('/finance/access');
  assert.ok(access.includes('fin_access') && access.includes('users'), access.join());
  assert.ok(!access.includes('fin_approval_rules'), access.join());
});
