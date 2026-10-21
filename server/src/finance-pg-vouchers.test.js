import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';

// Voucher drafts: make one, edit it, discard it, list the books' vouchers, open one (spec §6.6, §6.7, §7.1, §9.1).
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-vouchers.test.js
//
// One boot for the file; books CI and DP set up with the six logins of FIN_TEST_USERS. The tests share the
// database and run in order. The first three are the brief's, verbatim.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
let CI, DP;                                   // book ids
let ALPHA, RENT, FREIGHT, CUST_A, DP_RENT, PL; // ledger ids: CI's Alpha Bank, Rent, Freight, Customer A, DP's DP Rent, CI's Profit & Loss A/c
let OLD;                                       // a CI ledger that has been switched off
let PERIOD;                                    // month ids by book code and first day: PERIOD.CI['2027-02-01']

const strip = name => name.replace(/[^A-Za-z0-9]/g, '');
const groupMap = async book => Object.fromEntries((await h.call('GET', `/finance/books/${book}/groups`)).body.groups.map(g => [strip(g.name), g.id]));

// A line is written [ledgerId, debit_paise, credit_paise]; L turns it into the line object the API takes.
const L = ([ledger_id, debit_paise, credit_paise]) => ({ ledger_id, debit_paise, credit_paise });
// A journal dated 10 Jan 2027 in CI, with a save key of its own.
const jv = (lines, extra = {}) => ({
  book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-10', client_key: randomUUID(), narration: 'rent', lines: lines.map(L), ...extra,
});

before(async () => {
  if (!ON) return;
  h = await finBootPg('vouchers');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  const G = await groupMap(CI);
  const GD = await groupMap(DP);
  const ledger = async (book, group, name, extra = {}) =>
    (await h.call('POST', '/finance/ledgers', { book_id: book, group_id: group, name, ...extra }, 'acct')).body.ledger.id;
  ALPHA = await ledger(CI, G.BankAccounts, 'Alpha Bank');
  RENT = await ledger(CI, G.IndirectExpenses, 'Rent');
  FREIGHT = await ledger(CI, G.DirectExpenses, 'Freight');
  const customer = await h.db.one('SELECT id FROM customers ORDER BY id LIMIT 1');
  CUST_A = await ledger(CI, G.SundryDebtors, 'Customer A', { party_type: 'customer', party_id: customer.id });
  DP_RENT = await ledger(DP, GD.IndirectExpenses, 'DP Rent');
  PL = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers.find(l => l.name === 'Profit & Loss A/c').id;
  OLD = await ledger(CI, G.IndirectExpenses, 'Old Expense');
  await h.call('PUT', `/finance/ledgers/${OLD}`, { active: false }, 'md');
  PERIOD = {};
  for (const p of await h.db.q('SELECT p.id, p.start_date, b.code FROM fin_periods p JOIN fin_books b ON b.id = p.book_id')) {
    (PERIOD[p.code] ??= {})[p.start_date] = p.id;
  }
});

after(async () => { await h?.close(); });

test('the accountant saves a draft; the same save key twice is one draft', gate, async () => {
  const body = jv([[RENT, 500000, 0], [FREIGHT, 0, 400000]]);           // unbalanced is fine in a draft
  const a = await h.call('POST', '/finance/vouchers', body, 'acct');
  assert.equal(a.status, 200);
  assert.equal(a.body.voucher.status, 'draft');
  assert.equal(a.body.voucher.number, null);
  const b = await h.call('POST', '/finance/vouchers', body, 'acct');
  assert.equal(b.body.voucher.id, a.body.voucher.id);
  assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers WHERE client_key=$1', [body.client_key])).n, 1);
});

test('typed amounts arrive as whole paise or are refused', gate, async () => {
  const bad = async (lines, code) => assert.equal((await h.call('POST', '/finance/vouchers', jv(lines), 'acct')).body.code, code);
  await bad([[RENT, 12.5, 0], [FREIGHT, 0, 12.5]], 'FIN_BAD_AMOUNT');
  await bad([[RENT, -100, 0], [FREIGHT, 0, 100]], 'FIN_BAD_AMOUNT');
  await bad([[RENT, 100, 100], [FREIGHT, 0, 100]], 'FIN_BAD_LINE');
  await bad([[RENT, 100, 0], [DP_RENT, 0, 100]], 'FIN_WRONG_BOOK');
  await bad([[RENT, 100, 0], [PL, 0, 100]], 'FIN_SYSTEM_LEDGER');
  assert.equal((await h.call('POST', '/finance/vouchers', { ...jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), voucher_date: '2027-02-29' }, 'acct')).body.code, 'FIN_BAD_DATE');
  assert.equal((await h.call('POST', '/finance/vouchers', { ...jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), voucher_type: 'opening' }, 'acct')).body.code, 'FIN_BAD_INPUT');
  assert.equal((await h.call('POST', '/finance/vouchers', jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), 'viewer')).status, 403);
});

test('only the maker edits a draft; a one-book login cannot even see the voucher', gate, async () => {
  const v = (await h.call('POST', '/finance/vouchers', jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'acct')).body.voucher;
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { lines: [] }, 'appr2')).body.code, 'FIN_NOT_MAKER');
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { narration: 'June rent', lines: [[RENT, 200, 0], [FREIGHT, 0, 200]].map(L) }, 'acct')).status, 200);
  assert.equal((await h.call('GET', `/finance/vouchers/${v.id}`, null, 'dpOnly')).status, 404);
  const list = await h.call('GET', `/finance/vouchers?book=${CI}`, null, 'dpOnly');
  assert.equal(list.status, 403);
  const d = await h.call('POST', `/finance/vouchers/${v.id}/discard`, null, 'acct');
  assert.equal(d.body.voucher.status, 'discarded');
  const day = await h.call('GET', `/finance/vouchers?book=${CI}&view=daybook`, null, 'acct');
  assert.ok(!day.body.vouchers.some(x => x.id === v.id));
  const hist = (await h.call('GET', `/finance/vouchers/${v.id}`, null, 'acct')).body.history.map(x => x.action);
  assert.deepEqual(hist, ['create', 'edit', 'discard']);
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

const post = (body, who = 'acct') => h.call('POST', '/finance/vouchers', body, who);
const make = async (body, who = 'acct') => (await post(body, who)).body.voucher;
const open = (id, who = 'acct') => h.call('GET', `/finance/vouchers/${id}`, null, who);
const edit = (id, body, who = 'acct') => h.call('PUT', `/finance/vouchers/${id}`, body, who);
const discard = (id, who = 'acct') => h.call('POST', `/finance/vouchers/${id}/discard`, null, who);
const list = (query = '', who = 'acct') => h.call('GET', `/finance/vouchers${query}`, null, who);
const idsOf = r => r.body.vouchers.map(v => v.id);
// A raw body, lines and all, for the shapes the L helper would tidy away.
const raw = (lines, extra = {}) => ({ ...jv([]), lines, ...extra });

const written = async () => ({
  vouchers: (await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers')).n,
  lines: (await h.db.one('SELECT COUNT(*)::int n FROM fin_voucher_lines')).n,
  audit: (await h.db.one('SELECT COUNT(*)::int n FROM fin_audit_log')).n,
});
// A refusal: its status and code, and the field it names when the refusal is about one.
async function refused(call, status, code, field) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field) assert.equal(r.body.field, field, JSON.stringify(r.body));
  return r;
}
// A refusal that also leaves the books exactly as they were.
async function refusedAndNothingWritten(call, status, code, field) {
  const before = await written();
  const r = await refused(call, status, code, field);
  assert.deepEqual(await written(), before, 'a refused request writes nothing');
  return r;
}
const auditOf = id => h.db.q(
  `SELECT action, user_id, user_name, reason, before, after FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 ORDER BY id`, [id]);
const linesOf = id => h.db.q('SELECT * FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [id]);
// What a test does to move a draft along when Task 9's submit does not exist yet.
const setStatus = (id, status) => h.db.q(
  `UPDATE fin_vouchers SET status = $2, submitted_by_id = created_by_id, submitted_by = created_by, submitted_at = now() WHERE id = $1`, [id, status]);

test('a refused save names its line and its reason, and writes nothing at all', gate, async () => {
  const L1 = [RENT, 100, 0];
  const bad = (lines, status, code, field) => refusedAndNothingWritten(post(raw(lines)), status, code, field);
  // amounts
  await bad([L(L1), { ledger_id: FREIGHT, debit_paise: '100', credit_paise: 0 }], 400, 'FIN_BAD_AMOUNT', 'lines[1].debit_paise');
  await bad([{ ledger_id: RENT, debit_paise: 0, credit_paise: 2 ** 53 }], 400, 'FIN_BAD_AMOUNT', 'lines[0].credit_paise');
  await bad([{ ledger_id: RENT, debit_paise: 1e14, credit_paise: 0 }], 400, 'FIN_BAD_AMOUNT', 'lines[0].debit_paise');
  await bad([{ ledger_id: RENT, debit_paise: null, credit_paise: null }], 409, 'FIN_BAD_LINE');
  await bad([L(L1), L([FREIGHT, 0, 0])], 409, 'FIN_BAD_LINE');
  await bad(Array.from({ length: 200 }, () => L([RENT, 99_999_999_999_999, 0])), 400, 'FIN_BAD_AMOUNT', 'lines');
  // the list itself
  await bad([L(L1), { debit_paise: 5, credit_paise: 0 }], 400, 'FIN_BAD_INPUT', 'lines[1].ledger_id');
  await bad([L(L1), 7], 400, 'FIN_BAD_INPUT', 'lines[1]');
  await bad(Array.from({ length: 201 }, () => L([RENT, 1, 0])), 400, 'FIN_BAD_INPUT', 'lines');
  await refusedAndNothingWritten(post({ ...jv([]), lines: 'not a list' }), 400, 'FIN_BAD_INPUT', 'lines');
  await refusedAndNothingWritten(post({ ...jv([]), lines: { 0: L(L1) } }), 400, 'FIN_BAD_INPUT', 'lines');
  // ledgers: the book's, switched on, open to hand-typed vouchers
  await bad([L(L1), L([OLD, 0, 100])], 409, 'FIN_LEDGER_INACTIVE');
  await bad([L(L1), L([999999, 0, 100])], 409, 'FIN_WRONG_BOOK');
  await bad([L(L1), L([DP_RENT, 0, 100])], 409, 'FIN_WRONG_BOOK');
  await bad([L(L1), L([PL, 0, 100])], 409, 'FIN_SYSTEM_LEDGER');
  // bill details go on a customer or vendor ledger
  await bad([{ ...L([RENT, 100, 0]), bill_ref: 'INV-1' }], 400, 'FIN_BAD_INPUT');
  await bad([{ ...L([RENT, 100, 0]), due_date: '2027-02-10' }], 400, 'FIN_BAD_INPUT');
  await bad([{ ...L([CUST_A, 100, 0]), bill_date: '2027-02-30' }], 400, 'FIN_BAD_DATE', 'lines[0].bill_date');
  await bad([{ ...L([CUST_A, 100, 0]), due_date: 'next week' }], 400, 'FIN_BAD_DATE', 'lines[0].due_date');
  // line text
  await bad([{ ...L(L1), narration: 'rent\u0000' }], 400, 'FIN_BAD_INPUT', 'lines[0].narration');
  await bad([{ ...L(L1), narration: 12 }], 400, 'FIN_BAD_INPUT', 'lines[0].narration');
  await bad([{ ...L([CUST_A, 100, 0]), bill_ref: 'INV\u0000' }], 400, 'FIN_BAD_INPUT', 'lines[0].bill_ref');
});

test('a draft is kept to the paisa: the total is the sum of the debits, unbalanced or not', gate, async () => {
  const v = await make(jv([[RENT, 1, 0], [FREIGHT, 0, 1], [RENT, 30, 0], [FREIGHT, 0, 10]]));
  assert.equal(v.total_paise, 31);
  assert.equal('total' in v, false, 'the API speaks paise only');
  const row = await h.db.one('SELECT total::text AS total FROM fin_vouchers WHERE id = $1', [v.id]);
  assert.equal(row.total, '0.31');
  const lines = await h.db.q('SELECT line_no, ledger_id, debit::text AS debit, credit::text AS credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [v.id]);
  assert.deepEqual(lines.map(l => [l.line_no, l.ledger_id, l.debit, l.credit]), [
    [1, RENT, '0.01', '0.00'], [2, FREIGHT, '0.00', '0.01'], [3, RENT, '0.30', '0.00'], [4, FREIGHT, '0.00', '0.10'],
  ]);
  // the biggest amount a line takes, and the sum of many
  const big = await make(jv([[RENT, 99_999_999_999_999, 0], [FREIGHT, 0, 99_999_999_999_999]]));
  assert.equal(big.total_paise, 99_999_999_999_999);
  assert.equal((await h.db.one('SELECT total::text AS t FROM fin_vouchers WHERE id = $1', [big.id])).t, '999999999999.99');
  const view = (await open(big.id)).body;
  assert.deepEqual(view.lines.map(l => [l.debit_paise, l.credit_paise]), [[99_999_999_999_999, 0], [0, 99_999_999_999_999]]);
  // an empty draft is a draft; so is a one-sided one
  const empty = await make(jv([]));
  assert.equal(empty.total_paise, 0);
  assert.deepEqual((await open(empty.id)).body.lines, []);
  assert.equal((await make({ ...jv([]), lines: undefined })).total_paise, 0, 'no lines key at all is no lines');
  assert.equal((await make(jv([[RENT, 700, 0]]))).total_paise, 700);
});

test('the header: the book, the type, the date and the save key are all checked', gate, async () => {
  const ok = () => jv([[RENT, 1, 0], [FREIGHT, 0, 1]]);
  await refusedAndNothingWritten(post({ ...ok(), book_id: undefined }), 400, 'FIN_BAD_INPUT', 'book_id');
  await refusedAndNothingWritten(post({ ...ok(), book_id: 'CI' }), 400, 'FIN_BAD_INPUT', 'book_id');
  await refusedAndNothingWritten(post({ ...ok(), book_id: 999999 }), 403, 'FIN_FORBIDDEN');
  await refusedAndNothingWritten(post({ ...ok(), book_id: DP }), 409, 'FIN_WRONG_BOOK');          // acct holds DP too, so CI's ledgers in a DP voucher are the wrong book's
  for (const type of ['opening', 'sales', 'purchase', 'credit_note', 'debit_note', 'reversal', 'JOURNAL', '', null, 7, 'constructor', '__proto__']) {
    await refusedAndNothingWritten(post({ ...ok(), voucher_type: type }), 400, 'FIN_BAD_INPUT', 'voucher_type');
  }
  await refusedAndNothingWritten(post({ ...ok(), voucher_type: undefined }), 400, 'FIN_BAD_INPUT', 'voucher_type');
  for (const date of ['2027-02-29', '2027-1-5', '10/01/2027', '', null, 20270110, '1999-12-31', '2100-01-01']) {
    await refusedAndNothingWritten(post({ ...ok(), voucher_date: date }), 400, 'FIN_BAD_DATE', 'voucher_date');
  }
  await refusedAndNothingWritten(post({ ...ok(), voucher_date: undefined }), 400, 'FIN_BAD_DATE', 'voucher_date');
  for (const key of ['', 'abc', 7, true, ['x'], '0f8fad5b-d9cb-469f-a165-70867728950']) {
    await refusedAndNothingWritten(post({ ...ok(), client_key: key }), 400, 'FIN_BAD_INPUT', 'client_key');
  }
  await refusedAndNothingWritten(post([]), 400, 'FIN_BAD_INPUT');                  // a list is not a form
  await refusedAndNothingWritten(post(null), 400, 'FIN_BAD_INPUT', 'book_id');      // no body at all names no book
  await refusedAndNothingWritten(post({ ...ok(), voucher_type: ['journal'] }), 400, 'FIN_BAD_INPUT', 'voucher_type');   // a list that spells a type is not one
  // The four hand-typed types are all drafts. A draft is not checked for its shape: that is for submit
  for (const type of ['journal', 'receipt', 'payment', 'contra']) {
    const v = await make({ ...ok(), voucher_type: type });
    assert.equal(v.voucher_type, type);
    assert.equal(v.status, 'draft');
  }
  // …and the date is kept exactly as written; a leap day is a day
  assert.equal((await make({ ...ok(), voucher_date: '2028-02-29' })).voucher_date, '2028-02-29');
  // a save key is optional: without one, each save is a new draft
  const noKey = { ...ok(), client_key: undefined };
  const [a, b] = [await make(noKey), await make(noKey)];
  assert.notEqual(a.id, b.id);
  // and a key may be written in capitals
  const key = randomUUID();
  const upper = await make({ ...ok(), client_key: key.toUpperCase() });
  assert.equal((await make({ ...ok(), client_key: key })).id, upper.id);
});

test('the maker is recorded, the number is not minted, and the response speaks paise', gate, async () => {
  const v = await make(jv([[RENT, 250000, 0], [FREIGHT, 0, 250000]], { narration: '  Office rent, January  ', reference: ' UTR 123 ' }));
  assert.equal(v.status, 'draft');
  assert.equal(v.number, null);
  assert.equal(v.period_id, null);
  assert.equal(v.book_id, CI);
  assert.equal(v.voucher_type, 'journal');
  assert.equal(v.voucher_date, '2027-01-10');
  assert.equal(v.narration, 'Office rent, January');
  assert.equal(v.reference, 'UTR 123');
  assert.equal(v.total_paise, 250000);
  assert.equal(v.created_by_id, h.users.acct.id);
  assert.equal(v.created_by, 'Test Accountant');
  assert.equal(v.self_approved, false);
  assert.equal(v.reversal_of_id, null);
  assert.equal(v.reversed_by_id, null);
  assert.ok(v.created_at && v.updated_at);
  assert.equal('client_key' in v, false);
  assert.equal('source_fingerprint' in v, false);
  const stored = await h.db.one('SELECT number, period_id, client_key FROM fin_vouchers WHERE id = $1', [v.id]);
  assert.equal(stored.number, null);
  assert.ok(stored.client_key);
  // an approver makes drafts too, in his own name
  const md = await make(jv([[RENT, 5, 0], [FREIGHT, 0, 5]]), 'md');
  assert.equal(md.created_by_id, h.users.md.id);
  assert.equal(md.created_by, 'Test MD');
});

test('free text: trimmed, blank is nothing, a NUL byte is a 400, and a number is not text', gate, async () => {
  const lines = [[RENT, 1, 0], [FREIGHT, 0, 1]];
  const v = await make(jv(lines, { narration: '   ', reference: '' }));
  assert.equal(v.narration, null);
  assert.equal(v.reference, null);
  const multi = await make(jv(lines, { narration: 'first line\nsecond line' }));
  assert.equal(multi.narration, 'first line\nsecond line');
  const withBill = await make({ ...jv([]), lines: [{ ...L([CUST_A, 100, 0]), narration: '  Invoice  ', bill_ref: ' INV-12 ', bill_date: '2027-01-05', due_date: '2027-02-04' }, L([FREIGHT, 0, 100])] });
  const [first] = (await open(withBill.id)).body.lines;
  assert.deepEqual([first.narration, first.bill_ref, first.bill_date, first.due_date], ['Invoice', 'INV-12', '2027-01-05', '2027-02-04']);
  // A NUL byte: Postgres refuses it in TEXT, which used to be a 500 (ruling R22)
  await refusedAndNothingWritten(post(jv(lines, { narration: 'rent\u0000 for January' })), 400, 'FIN_BAD_INPUT', 'narration');
  await refusedAndNothingWritten(post(jv(lines, { reference: '\u0000' })), 400, 'FIN_BAD_INPUT', 'reference');
  await refusedAndNothingWritten(post(jv(lines, { narration: 42 })), 400, 'FIN_BAD_INPUT', 'narration');
  await refusedAndNothingWritten(post(jv(lines, { narration: { text: 'x' } })), 400, 'FIN_BAD_INPUT', 'narration');
  await refusedAndNothingWritten(post(jv(lines, { narration: 'x'.repeat(2001) })), 400, 'FIN_BAD_INPUT', 'narration');
  await refusedAndNothingWritten(post(jv(lines, { reference: 'x'.repeat(256) })), 400, 'FIN_BAD_INPUT', 'reference');
  assert.equal((await make(jv(lines, { narration: 'x'.repeat(2000), reference: 'x'.repeat(255) }))).narration.length, 2000);
  // and the same on an edit
  await refusedAndNothingWritten(edit(v.id, { narration: 'a\u0000b' }), 400, 'FIN_BAD_INPUT', 'narration');
  await refusedAndNothingWritten(edit(v.id, { reference: 'a\u0000b' }), 400, 'FIN_BAD_INPUT', 'reference');
  await refusedAndNothingWritten(edit(v.id, { lines: [{ ...L([RENT, 1, 0]), narration: 'a\u0000b' }] }), 400, 'FIN_BAD_INPUT', 'lines[0].narration');
});

test('two hundred lines make a voucher, numbered from 1', gate, async () => {
  const two00 = [];
  for (let i = 0; i < 100; i++) two00.push([RENT, 100 + i, 0], [FREIGHT, 0, 100 + i]);
  const v = await make(jv(two00));
  assert.equal(v.total_paise, two00.filter(l => l[1]).reduce((n, l) => n + l[1], 0));
  const view = (await open(v.id)).body;
  assert.equal(view.lines.length, 200);
  assert.deepEqual(view.lines.map(l => l.line_no), Array.from({ length: 200 }, (_, i) => i + 1));
});

test('the same save key: yours again is the same draft, in whatever state it is now; another login or book is a conflict', gate, async () => {
  const body = jv([[RENT, 900, 0], [FREIGHT, 0, 900]]);
  const a = await make(body);
  assert.equal((await edit(a.id, { narration: 'changed after the first save' })).status, 200);
  const again = await post(body);                                         // the retry carries the first body
  assert.equal(again.status, 200);
  assert.equal(again.body.voucher.id, a.id);
  assert.equal(again.body.voucher.narration, 'changed after the first save', 'what is there now, not what was first sent');
  // another login with the same key
  await refusedAndNothingWritten(post(body, 'appr2'), 409, 'FIN_DUPLICATE_KEY');
  // the same login, in the other book
  await refusedAndNothingWritten(post({ ...body, book_id: DP, lines: [L([DP_RENT, 900, 0]), L([DP_RENT, 0, 900])] }), 409, 'FIN_DUPLICATE_KEY');
  // and after the draft is discarded the key still names it
  await discard(a.id);
  const gone = await post(body);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.voucher.id, a.id);
  assert.equal(gone.body.voucher.status, 'discarded');
  // the key is not a way past the checks on who may ask
  assert.equal((await post(body, 'viewer')).status, 403);
  assert.equal((await post(body, 'dpOnly')).status, 403);
});

// ── Edit ─────────────────────────────────────────────────────────────────────────────────────

test('an edit changes what it is given and leaves the rest', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]], { narration: 'before', reference: 'ref-1' }));
  const before = await linesOf(v.id);
  const then = new Date((await open(v.id)).body.voucher.updated_at);
  await new Promise(resolve => setTimeout(resolve, 15));

  // a narration alone leaves the lines alone, ids included
  const n = await edit(v.id, { narration: '  after  ' });
  assert.equal(n.status, 200);
  assert.equal(n.body.voucher.narration, 'after');
  assert.equal(n.body.voucher.reference, 'ref-1');
  assert.equal(n.body.voucher.voucher_date, '2027-01-10');
  assert.equal(n.body.voucher.total_paise, 100);
  assert.ok(new Date(n.body.voucher.updated_at) > then, 'updated_at moves');
  assert.deepEqual((await linesOf(v.id)).map(l => l.id), before.map(l => l.id));

  // a date alone
  assert.equal((await edit(v.id, { voucher_date: '2027-01-31' })).body.voucher.voucher_date, '2027-01-31');
  // null or blank clears a text field
  const cleared = (await edit(v.id, { narration: null, reference: '   ' })).body.voucher;
  assert.deepEqual([cleared.narration, cleared.reference], [null, null]);
  // an empty body is an edit that changes nothing
  assert.equal((await edit(v.id, {})).status, 200);

  // lines are replaced wholesale: three where there were two, a new total, line numbers from 1
  const w = await edit(v.id, { lines: [[RENT, 400, 0], [FREIGHT, 0, 150], [ALPHA, 0, 30]].map(L) });
  assert.equal(w.body.voucher.total_paise, 400);
  const now = await linesOf(v.id);
  assert.deepEqual(now.map(l => [l.line_no, l.ledger_id, l.debit, l.credit]), [[1, RENT, 4, 0], [2, FREIGHT, 0, 1.5], [3, ALPHA, 0, 0.3]]);
  assert.ok(now.every(l => !before.some(b => b.id === l.id)), 'new rows, not the old ones kept');
  // …down to none
  const none = await edit(v.id, { lines: [] });
  assert.equal(none.body.voucher.total_paise, 0);
  assert.equal((await linesOf(v.id)).length, 0);
  // …and a body that names a type or a book it cannot change leaves them be
  const same = await edit(v.id, { voucher_type: 'payment', book_id: DP, status: 'posted', number: 'CI-JV-2627-0001', total_paise: 5, created_by_id: 1 });
  assert.equal(same.status, 200);
  assert.deepEqual([same.body.voucher.voucher_type, same.body.voucher.book_id, same.body.voucher.status, same.body.voucher.number, same.body.voucher.total_paise, same.body.voucher.created_by_id],
    ['journal', CI, 'draft', null, 0, h.users.acct.id]);
});

test('a refused edit changes nothing: not the lines, not the header, not the log', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]], { narration: 'keep me' }));
  const kept = await h.db.one('SELECT narration, voucher_date, total::text AS total, updated_at FROM fin_vouchers WHERE id = $1', [v.id]);
  const keptLines = await linesOf(v.id);
  const nothingChanged = async () => {
    assert.deepEqual(await h.db.one('SELECT narration, voucher_date, total::text AS total, updated_at FROM fin_vouchers WHERE id = $1', [v.id]), kept);
    assert.deepEqual(await linesOf(v.id), keptLines);
  };
  // a good header with bad lines: the header must not slip in, and the old lines must not go
  await refusedAndNothingWritten(edit(v.id, { narration: 'new', voucher_date: '2027-01-20', lines: [L([RENT, 100, 0]), L([DP_RENT, 0, 100])] }), 409, 'FIN_WRONG_BOOK');
  await nothingChanged();
  await refusedAndNothingWritten(edit(v.id, { narration: 'new', lines: [L([RENT, 100, 0]), L([OLD, 0, 100])] }), 409, 'FIN_LEDGER_INACTIVE');
  await refusedAndNothingWritten(edit(v.id, { lines: [L([RENT, 100.5, 0])] }), 400, 'FIN_BAD_AMOUNT', 'lines[0].debit_paise');
  await refusedAndNothingWritten(edit(v.id, { lines: [L([RENT, 100, 100])] }), 409, 'FIN_BAD_LINE');
  await refusedAndNothingWritten(edit(v.id, { lines: [L([PL, 100, 0])] }), 409, 'FIN_SYSTEM_LEDGER');
  await refusedAndNothingWritten(edit(v.id, { lines: 'x' }), 400, 'FIN_BAD_INPUT', 'lines');
  await refusedAndNothingWritten(edit(v.id, { lines: null }), 400, 'FIN_BAD_INPUT', 'lines');
  await refusedAndNothingWritten(edit(v.id, { voucher_date: '2027-02-30' }), 400, 'FIN_BAD_DATE', 'voucher_date');
  await refusedAndNothingWritten(edit(v.id, { voucher_date: null }), 400, 'FIN_BAD_DATE', 'voucher_date');
  await refusedAndNothingWritten(edit(v.id, { narration: ['a'] }), 400, 'FIN_BAD_INPUT', 'narration');
  await nothingChanged();
  await refusedAndNothingWritten(h.call('PUT', `/finance/vouchers/${v.id}`, [1, 2], 'acct'), 400, 'FIN_BAD_INPUT');
});

test('who may edit: only the maker, only while it is a draft', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  // nobody else edits it, an approver and an admin included; nothing is written
  for (const who of ['appr2', 'md']) await refusedAndNothingWritten(edit(v.id, { narration: 'mine now' }, who), 403, 'FIN_NOT_MAKER');
  // a viewer can see it, and may not edit anything
  await refusedAndNothingWritten(edit(v.id, { narration: 'x' }, 'viewer'), 403, 'FIN_FORBIDDEN');
  // …and a login with no grant on its book cannot tell it is there
  for (const who of ['dpOnly', 'plant']) await refusedAndNothingWritten(edit(v.id, { narration: 'x' }, who), 404, 'FIN_NOT_FOUND');
  // not a draft any more: submitted, then discarded
  await setStatus(v.id, 'submitted');
  await refusedAndNothingWritten(edit(v.id, { narration: 'x' }), 409, 'FIN_NOT_DRAFT');
  await refusedAndNothingWritten(edit(v.id, {}), 409, 'FIN_NOT_DRAFT');
  await setStatus(v.id, 'draft');
  assert.equal((await edit(v.id, { narration: 'back to a draft' })).status, 200);
  assert.equal((await discard(v.id)).status, 200);
  await refusedAndNothingWritten(edit(v.id, { narration: 'x' }), 409, 'FIN_NOT_DRAFT');
  // a voucher that is not there, or an id that cannot be one
  for (const id of [999999, 0, -1, 'abc', '1e0', '0x1', '1.5', 2147483648]) {
    await refusedAndNothingWritten(edit(id, { narration: 'x' }), 404, 'FIN_NOT_FOUND');
  }
});

// ── Discard ──────────────────────────────────────────────────────────────────────────────────

test('discard: the maker or an admin, a draft only, and the entry stays for the trail', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]], { narration: 'to discard' }));
  // an approver who is not the maker, and not an admin, cannot
  await refusedAndNothingWritten(discard(v.id, 'appr2'), 403, 'FIN_NOT_MAKER');
  await refusedAndNothingWritten(discard(v.id, 'viewer'), 403, 'FIN_FORBIDDEN');
  for (const who of ['dpOnly', 'plant']) await refusedAndNothingWritten(discard(v.id, who), 404, 'FIN_NOT_FOUND');
  // the MD is an admin: his word is enough on anyone's draft
  const d = await discard(v.id, 'md');
  assert.equal(d.status, 200);
  assert.equal(d.body.voucher.status, 'discarded');
  assert.equal(d.body.voucher.number, null, 'a discarded draft never gets a number');
  assert.equal(d.body.voucher.created_by_id, h.users.acct.id, 'it is still the maker\'s entry');
  // it is kept, lines and all
  const view = (await open(v.id)).body;
  assert.equal(view.voucher.status, 'discarded');
  assert.equal(view.lines.length, 2);
  assert.deepEqual(view.can, { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false });
  assert.equal((await linesOf(v.id)).length, 2);
  // a discarded entry is neither a draft nor in the day book, and cannot be discarded twice
  assert.ok(!idsOf(await list(`?book=${CI}`)).includes(v.id));
  assert.ok(!idsOf(await list(`?book=${CI}&view=drafts`)).includes(v.id));
  await refusedAndNothingWritten(discard(v.id), 409, 'FIN_NOT_DRAFT');
  await refusedAndNothingWritten(discard(v.id, 'md'), 409, 'FIN_NOT_DRAFT');
  // the audit row names the admin, and carries the entry with its lines before and after
  const rows = await auditOf(v.id);
  assert.deepEqual(rows.map(r => [r.action, r.user_id, r.user_name]), [['create', h.users.acct.id, 'Test Accountant'], ['discard', h.users.md.id, 'Test MD']]);
  assert.equal(rows[1].before.status, 'draft');
  assert.equal(rows[1].after.status, 'discarded');
  assert.equal(rows[1].before.lines.length, 2);
  assert.equal(rows[1].after.lines.length, 2);
  // submitted entries are not discarded either
  const s = await make(jv([[RENT, 1, 0], [FREIGHT, 0, 1]]));
  await setStatus(s.id, 'submitted');
  await refusedAndNothingWritten(discard(s.id), 409, 'FIN_NOT_DRAFT');
  await refusedAndNothingWritten(discard(s.id, 'md'), 409, 'FIN_NOT_DRAFT');
  for (const id of [999999, 0, 'abc', -1, '1e0']) await refusedAndNothingWritten(discard(id), 404, 'FIN_NOT_FOUND');
});

// ── Open ─────────────────────────────────────────────────────────────────────────────────────

test('open: the voucher, its lines with their ledgers, its history, and what this login may do', gate, async () => {
  const v = await make(jv([[RENT, 250000, 0], [CUST_A, 0, 250000]], { narration: 'open me', reference: 'REF-9' }));
  await edit(v.id, { narration: 'open me, edited' });
  const r = await open(v.id);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['can', 'history', 'lines', 'voucher']);
  assert.equal(r.body.voucher.id, v.id);
  assert.equal(r.body.voucher.narration, 'open me, edited');
  assert.equal(r.body.voucher.total_paise, 250000);
  assert.equal(r.body.voucher.reversal_of_number, null);
  assert.equal(r.body.voucher.reversed_by_number, null);
  assert.deepEqual(r.body.lines.map(l => [l.line_no, l.ledger_id, l.ledger_name, l.debit_paise, l.credit_paise]),
    [[1, RENT, 'Rent', 250000, 0], [2, CUST_A, 'Customer A', 0, 250000]]);
  for (const l of r.body.lines) assert.deepEqual(Object.keys(l).sort(), ['bill_date', 'bill_ref', 'credit_paise', 'debit_paise', 'due_date', 'id', 'ledger_code', 'ledger_id', 'ledger_name', 'line_no', 'narration']);
  // history: oldest first, who and when, no bulk
  assert.deepEqual(r.body.history.map(x => [x.action, x.user_name, x.user_id]), [['create', 'Test Accountant', h.users.acct.id], ['edit', 'Test Accountant', h.users.acct.id]]);
  assert.ok(r.body.history.every(x => x.at && x.id && 'reason' in x));
  assert.ok(r.body.history[0].id < r.body.history[1].id);
  assert.ok(r.body.history.every(x => !('before' in x) && !('after' in x)), 'the log screen has the before and after; this is the timeline');

  // what each login may do with it
  const can = async who => (await open(v.id, who)).body.can;
  assert.deepEqual(await can('acct'), { edit: true, submit: true, discard: true, approve: false, reject: false, reverse: false });
  assert.deepEqual(await can('md'), { edit: false, submit: false, discard: true, approve: false, reject: false, reverse: false });
  assert.deepEqual(await can('appr2'), { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false });
  assert.deepEqual(await can('viewer'), { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false });
  // submitted: the approvers other than the maker may approve
  await setStatus(v.id, 'submitted');
  assert.deepEqual(await can('appr2'), { edit: false, submit: false, discard: false, approve: true, reject: true, reverse: false });
  assert.deepEqual(await can('md'), { edit: false, submit: false, discard: false, approve: true, reject: true, reverse: false });
  assert.deepEqual(await can('acct'), { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false });
  await setStatus(v.id, 'draft');

  // a login that cannot see the book, an id that is not there, and an id that cannot be one: all the same answer
  for (const who of ['dpOnly', 'plant']) await refused(open(v.id, who), 404, 'FIN_NOT_FOUND');
  const same = (await open(v.id, 'dpOnly')).body;
  assert.deepEqual(same, (await open(999999, 'dpOnly')).body, 'no clue whether the voucher is there');
  for (const id of [999999, 0, -1, 'abc', '1e0', '0x1', '1.5', 2147483648]) await refused(open(id), 404, 'FIN_NOT_FOUND');
});

test('open: a book\'s own accountant sees its vouchers, the other book\'s do not leak either way', gate, async () => {
  const dp = await make({ book_id: DP, voucher_type: 'journal', voucher_date: '2027-01-12', client_key: randomUUID(), lines: [L([DP_RENT, 5, 0])] }, 'dpOnly');
  assert.equal(dp.book_id, DP);
  assert.equal((await open(dp.id, 'dpOnly')).status, 200);
  assert.equal((await open(dp.id, 'acct')).status, 200, 'acct holds both books');
  assert.equal((await open(dp.id, 'md')).status, 200);
  await refused(open(dp.id, 'appr2'), 404, 'FIN_NOT_FOUND');      // appr2 holds CI only
  await refused(open(dp.id, 'viewer'), 404, 'FIN_NOT_FOUND');
  // a DP accountant cannot make a CI voucher, or a CI ledger in a DP one
  await refused(post(jv([[RENT, 1, 0], [FREIGHT, 0, 1]]), 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refused(post({ book_id: DP, voucher_type: 'journal', voucher_date: '2027-01-12', client_key: randomUUID(), lines: [L([RENT, 5, 0])] }, 'dpOnly'), 409, 'FIN_WRONG_BOOK');
});

// ── The lists ────────────────────────────────────────────────────────────────────────────────

test('list: the day book, the drafts and the approvals are three views of the same vouchers', gate, async () => {
  const mk = (extra, who = 'acct') => make(jv([[RENT, 1, 0], [FREIGHT, 0, 1]], extra), who);
  const a = await mk({ narration: 'LISTVIEW alpha', voucher_date: '2027-01-11' });
  const b = await mk({ narration: 'LISTVIEW beta', voucher_date: '2027-01-12' });
  const c = await mk({ narration: 'LISTVIEW gamma', voucher_date: '2027-01-13' });
  const d = await mk({ narration: 'LISTVIEW delta', voucher_date: '2027-01-14' });
  const md1 = await mk({ narration: 'LISTVIEW md-draft', voucher_date: '2027-01-15' }, 'md');
  const md2 = await mk({ narration: 'LISTVIEW md-waiting', voucher_date: '2027-01-16' }, 'md');
  await setStatus(b.id, 'submitted');
  await setStatus(c.id, 'submitted');
  await setStatus(md2.id, 'submitted');
  await discard(d.id);
  const mine = ids => ids.filter(id => [a, b, c, d, md1, md2].some(v => v.id === id));
  const q = '&q=LISTVIEW';

  // the day book: every status but discarded; the default view
  const day = await list(`?book=${CI}${q}`);
  assert.equal(day.status, 200);
  assert.deepEqual(mine(idsOf(day)).sort(), [a.id, b.id, c.id, md1.id, md2.id].sort());
  assert.deepEqual(idsOf(await list(`?book=${CI}&view=daybook${q}`)), idsOf(day));
  // newest date first
  assert.deepEqual(idsOf(day), [md2.id, md1.id, c.id, b.id, a.id]);
  assert.equal(day.body.truncated, false);

  // drafts: your own drafts and no one else's
  const drafts = await list(`?book=${CI}&view=drafts${q}`);
  assert.deepEqual(mine(idsOf(drafts)), [a.id]);
  assert.deepEqual(mine(idsOf(await list(`?book=${CI}&view=drafts${q}`, 'md'))), [md1.id]);
  assert.deepEqual(idsOf(await list(`?book=${CI}&view=drafts${q}`, 'appr2')), []);
  assert.ok(idsOf(await list(`?book=${CI}&view=drafts`)).every(id => id !== c.id));
  for (const who of ['acct', 'md']) {
    const all = (await list('?view=drafts', who)).body.vouchers;
    assert.ok(all.length && all.every(v => v.status === 'draft' && v.created_by === (who === 'md' ? 'Test MD' : 'Test Accountant')), who);
  }

  // approvals: submitted, in a book you approve, made by someone else
  assert.deepEqual(mine(idsOf(await list(`?book=${CI}&view=approvals${q}`, 'appr2'))).sort(), [b.id, c.id, md2.id].sort());
  assert.deepEqual(mine(idsOf(await list(`?book=${CI}&view=approvals${q}`, 'md'))).sort(), [b.id, c.id].sort(), 'not the MD\'s own');
  assert.deepEqual(idsOf(await list(`?book=${CI}&view=approvals${q}`, 'appr2')), [b.id, c.id, md2.id], 'longest waiting first');
  // …a login that sees the book but approves nothing in it has nothing waiting on it: an empty list, not a refusal
  // (ruling R25: the route's capability is view, and the Vouchers page counts approvals for every login)
  for (const who of ['acct', 'viewer']) {
    const none = await list(`?book=${CI}&view=approvals`, who);
    assert.deepEqual([none.status, none.body], [200, { vouchers: [], truncated: false }], who);
  }
  // …while a login with no grant on the book is refused, as on every view that names one
  await refused(list(`?book=${CI}&view=approvals`, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refused(list(`?book=${CI}&view=approvals`, 'plant'), 403, 'FIN_FORBIDDEN');
  // …without a book it is every book you approve, and for a login that approves none, nothing at all
  assert.deepEqual(mine(idsOf(await list(`?view=approvals${q}`, 'appr2'))).sort(), [b.id, c.id, md2.id].sort());
  assert.deepEqual((await list('?view=approvals', 'acct')).body.vouchers, []);
  assert.deepEqual((await list('?view=approvals', 'dpOnly')).body.vouchers, []);

  // a status filter narrows a view; it never widens it
  assert.deepEqual(mine(idsOf(await list(`?book=${CI}&status=submitted${q}`))).sort(), [b.id, c.id, md2.id].sort());
  assert.deepEqual(mine(idsOf(await list(`?book=${CI}&status=draft${q}`))).sort(), [a.id, md1.id].sort());
  assert.deepEqual(idsOf(await list(`?book=${CI}&status=discarded${q}`)), [], 'the day book never lists a discarded entry');
  assert.deepEqual(idsOf(await list(`?book=${CI}&view=drafts&status=submitted${q}`)), []);
  assert.deepEqual(idsOf(await list(`?book=${CI}&view=approvals&status=draft${q}`, 'appr2')), []);
});

test('list: the row, and the books it covers', gate, async () => {
  const dp = await make({ book_id: DP, voucher_type: 'journal', voucher_date: '2027-01-12', client_key: randomUUID(), narration: 'LISTBOOK dp', lines: [L([DP_RENT, 5, 0])] }, 'dpOnly');
  const ci = await make(jv([[RENT, 7, 0], [FREIGHT, 0, 7]], { narration: 'LISTBOOK ci' }));
  const q = '&q=LISTBOOK';
  // one book, named
  assert.deepEqual(idsOf(await list(`?book=${CI}${q}`)), [ci.id]);
  assert.deepEqual(idsOf(await list(`?book=${DP}${q}`)), [dp.id]);
  // no book: every book the login holds
  assert.deepEqual(idsOf(await list(`?${q.slice(1)}`, 'acct')).sort(), [ci.id, dp.id].sort());
  assert.deepEqual(idsOf(await list(`?${q.slice(1)}`, 'md')).sort(), [ci.id, dp.id].sort());
  assert.deepEqual(idsOf(await list(`?${q.slice(1)}`, 'dpOnly')), [dp.id]);
  assert.deepEqual(idsOf(await list(`?${q.slice(1)}`, 'appr2')), [ci.id]);
  assert.deepEqual(idsOf(await list(`?${q.slice(1)}`, 'viewer')), [ci.id]);
  // a login with no grant at all is refused, with a book named or without (spec §14: every route refuses a login with no grant)
  await refused(list(`?${q.slice(1)}`, 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(list('?view=approvals', 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(list(`?book=${CI}`, 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(list(`?book=${DP}`, 'appr2'), 403, 'FIN_FORBIDDEN');
  await refused(list(`?book=${CI}`, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refused(list('?book=999999', 'md'), 403, 'FIN_FORBIDDEN');
  // the row is exactly this
  const row = (await list(`?book=${CI}${q}`)).body.vouchers[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'book_id', 'created_at', 'created_by', 'id', 'last_reject_reason', 'narration', 'number', 'posted_at', 'reference', 'reversal_of_id',
    'reversed_by_id', 'self_approved', 'status', 'submitted_at', 'total_paise', 'voucher_date', 'voucher_type',
  ]);
  assert.deepEqual([row.book_id, row.number, row.voucher_date, row.voucher_type, row.status, row.narration, row.reference, row.total_paise, row.created_by,
    row.submitted_at, row.posted_at, row.reversal_of_id, row.reversed_by_id, row.self_approved, row.last_reject_reason],
  [CI, null, '2027-01-10', 'journal', 'draft', 'LISTBOOK ci', null, 7, 'Test Accountant', null, null, null, null, false, null]);
});

test('list: dates, type, search; every filter is checked and none is SQL', gate, async () => {
  const mk = (extra, who = 'acct') => make(jv([[RENT, 1, 0], [FREIGHT, 0, 1]], extra), who);
  const tag = 'LISTFILTER';
  const a = await mk({ narration: `${tag} 100% sure`, voucher_date: '2027-02-01', reference: 'CHQ-0042' });
  const b = await mk({ narration: `${tag} one_two`, voucher_date: '2027-02-10', voucher_type: 'payment' });
  const c = await mk({ narration: `${tag} onextwo`, voucher_date: '2027-02-20', voucher_type: 'receipt' }, 'md');
  const d = await mk({ narration: `${tag} lower case: Rent for February`, voucher_date: '2027-03-05', voucher_type: 'contra' });
  const ids = async (query, who) => (await list(`?book=${CI}&q=${tag}${query}`, who)).body.vouchers.map(v => v.id);

  // dates, inclusive at both ends
  assert.deepEqual((await ids('&from=2027-02-10&to=2027-02-20')).sort(), [b.id, c.id].sort());
  assert.deepEqual(await ids('&from=2027-02-20'), [d.id, c.id]);
  assert.deepEqual(await ids('&to=2027-02-01'), [a.id]);
  assert.deepEqual(await ids('&from=2027-02-02&to=2027-02-09'), []);
  // type
  assert.deepEqual(await ids('&type=payment'), [b.id]);
  assert.deepEqual(await ids('&type=contra'), [d.id]);
  assert.deepEqual((await ids('&type=journal')), [a.id]);
  // search: the narration whatever the capitals, the reference, the maker, and a wildcard is just a character
  const bySearch = async text => (await list(`?book=${CI}&q=${encodeURIComponent(text)}`)).body.vouchers.map(v => v.id);
  assert.deepEqual(await bySearch('RENT FOR february'), [d.id]);
  assert.deepEqual(await bySearch('chq-0042'), [a.id]);
  assert.deepEqual(await bySearch('100%'), [a.id]);
  assert.deepEqual(await bySearch(`${tag} one_two`), [b.id]);
  assert.deepEqual((await bySearch(`${tag} one`)).sort(), [b.id, c.id].sort());
  assert.deepEqual(await bySearch(`${tag} one_`), [b.id], 'an underscore is an underscore, not any character');
  assert.deepEqual(await bySearch('%'), [a.id], 'a lone percent sign is a percent sign');
  assert.deepEqual(await bySearch("x' OR '1'='1"), []);
  const byMaker = await bySearch('test md');                        // the maker's name, whatever the capitals
  assert.ok(byMaker.includes(c.id) && !byMaker.includes(a.id), 'by maker');
  // a blank search is no search
  assert.ok((await bySearch('   ')).includes(a.id));
  assert.ok((await list(`?book=${CI}&q=`)).body.vouchers.length > 4);

  // refusals, each a 400 that names the thing
  const bad = (query, code, field) => refused(list(`?book=${CI}${query}`), 400, code, field);
  await bad('&view=everything', 'FIN_BAD_INPUT', 'view');
  await bad('&status=posted;DROP', 'FIN_BAD_INPUT', 'status');
  await bad('&status=Draft', 'FIN_BAD_INPUT', 'status');
  await bad('&type=sales%27', 'FIN_BAD_INPUT', 'type');
  await bad('&type=constructor', 'FIN_BAD_INPUT', 'type');
  await bad('&from=2027-02-30', 'FIN_BAD_DATE', 'from');
  await bad('&to=tomorrow', 'FIN_BAD_DATE', 'to');
  await bad('&q=a&q=b', 'FIN_BAD_INPUT', 'q');
  await bad('&q[x]=1', 'FIN_BAD_INPUT', 'q');
  await bad('&q=%00', 'FIN_BAD_INPUT', 'q');
  await bad(`&q=${'x'.repeat(101)}`, 'FIN_BAD_INPUT', 'q');
  await bad('&view=drafts&view=approvals', 'FIN_BAD_INPUT', 'view');
  for (const book of ['abc', '0', '-1', '1.5', '', '2147483648', '1e0']) await refused(list(`?book=${book}`), 400, 'FIN_BAD_INPUT', 'book');
  await refused(list('?book=1&book=2'), 400, 'FIN_BAD_INPUT', 'book');
  // a filter left empty is no filter, as a form that sends all its boxes will have it; the book is never guessed
  const empty = await list(`?book=${CI}&view=&status=&type=&from=&to=&q=`);
  assert.equal(empty.status, 200);
  assert.ok(empty.body.vouchers.some(v => v.id === a.id));
});

// Ruling R72: the Day Book's figures and tab counts come from the list route itself, asked to count (count=1). The ERP runs on
// Vercel's Hobby plan, where an overrun pauses every project, and the page refreshed four lists of up to 5,000 rows on every
// realtime tick to count them. A count is the list's own query: every filter, the books, R25 (no approvals for a login that
// approves nothing) and the refusals are the rows' exactly, so the two always agree.
test('R72: count=1 answers how many the same list holds, for every view, filter, book and login; and nothing else', gate, async () => {
  const ok = async call => {
    const r = await call;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const counted = async (query, who) => {
    const rows = await list(query, who);
    const count = await list(`${query}${query ? '&' : '?'}count=1`, who);
    return { rows, count };
  };
  const QUERIES = [
    '', `?book=${CI}`, `?book=${DP}`, '?view=drafts', `?book=${CI}&view=drafts`, '?view=approvals', `?book=${CI}&view=approvals`,
    `?book=${CI}&status=submitted`, `?book=${CI}&status=posted&from=2027-01-01&to=2027-01-31`, `?book=${CI}&status=posted&from=2027-01-12&to=2027-01-12`,
    `?book=${CI}&type=payment`, `?book=${CI}&q=LISTFILTER`, `?book=${CI}&view=drafts&status=submitted`, '?status=draft',
  ];
  let compared = 0;
  for (const who of ['md', 'acct', 'appr2', 'viewer', 'dpOnly']) {
    for (const query of QUERIES) {
      const { rows, count } = await counted(query, who);
      assert.equal(count.status, rows.status, `${who} ${query}: the same answer, rows or count`);
      if (rows.status !== 200) {
        assert.deepEqual(count.body, rows.body, `${who} ${query}: the same refusal`);
        continue;
      }
      assert.equal(rows.body.truncated, false, `${who} ${query}: a list short of the cap, so its length is its count`);
      assert.deepEqual(count.body, { count: rows.body.vouchers.length }, `${who} ${query}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 50, `non-vacuous: ${compared} lists compared`);
  // R25: a login that approves nothing has nothing waiting on it, counted or listed, with a book or without
  for (const query of [`?book=${CI}&view=approvals&count=1`, '?view=approvals&count=1']) {
    for (const who of ['acct', 'viewer']) assert.deepEqual(await ok(list(query, who)), { count: 0 }, `${who} ${query}`);
  }
  assert.ok((await ok(list(`?book=${CI}&view=approvals&count=1`, 'appr2'))).count > 0, 'and the Approver has some');
  // the refusals are the list's: a book the login does not hold, and no grant at all
  await refused(list(`?book=${DP}&count=1`, 'viewer'), 403, 'FIN_FORBIDDEN');
  await refused(list('?count=1', 'plant'), 403, 'FIN_FORBIDDEN');
  await refused(list(`?book=${CI}&count=1`, 'plant'), 403, 'FIN_FORBIDDEN');
  // count is a yes or nothing; anything else is a 400 that names it, and the other filters are checked as ever
  for (const bad of ['0', 'true', 'yes', '2']) await refused(list(`?book=${CI}&count=${bad}`), 400, 'FIN_BAD_INPUT', 'count');
  await refused(list(`?book=${CI}&count=1&count=1`), 400, 'FIN_BAD_INPUT', 'count');
  await refused(list(`?book=${CI}&count=1&from=2027-02-30`), 400, 'FIN_BAD_DATE', 'from');
  assert.ok(Array.isArray((await ok(list(`?book=${CI}&count=`))).vouchers), 'an empty count is no count: the rows');
});

// ── The log ──────────────────────────────────────────────────────────────────────────────────

test('every write is in the log, with the entry and its lines before and after, in the maker\'s name', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 60]], { narration: 'first' }));
  await edit(v.id, { narration: 'second', lines: [[RENT, 300, 0], [FREIGHT, 0, 300]].map(L) });
  await discard(v.id);
  const rows = await auditOf(v.id);
  assert.deepEqual(rows.map(r => r.action), ['create', 'edit', 'discard']);
  assert.ok(rows.every(r => r.user_id === h.users.acct.id && r.user_name === 'Test Accountant'));
  const book = await h.db.one(`SELECT book_id FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 LIMIT 1`, [v.id]);
  assert.equal(book.book_id, CI);

  const [create, change, drop] = rows;
  assert.equal(create.before, null);
  assert.equal(create.after.narration, 'first');
  assert.equal(create.after.status, 'draft');
  assert.equal(create.after.total_paise, 100);
  assert.deepEqual(create.after.lines.map(l => [l.line_no, l.ledger_id, l.debit_paise, l.credit_paise]), [[1, RENT, 100, 0], [2, FREIGHT, 0, 60]]);

  assert.equal(change.before.narration, 'first');
  assert.equal(change.before.total_paise, 100);
  assert.deepEqual(change.before.lines.map(l => [l.debit_paise, l.credit_paise]), [[100, 0], [0, 60]]);
  assert.equal(change.after.narration, 'second');
  assert.equal(change.after.total_paise, 300);
  assert.deepEqual(change.after.lines.map(l => [l.debit_paise, l.credit_paise]), [[300, 0], [0, 300]]);

  assert.equal(drop.before.status, 'draft');
  assert.equal(drop.after.status, 'discarded');
  assert.deepEqual(drop.after.lines.map(l => [l.debit_paise, l.credit_paise]), [[300, 0], [0, 300]]);
  // money in the log is paise too
  assert.ok(rows.every(r => !('total' in (r.after ?? {}))));
});

// ── Races: one transaction held open on a raw client while another arrives ───────────────────────

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

const actor = (key, roles) => ({ id: h.users[key].id, name: { acct: 'Test Accountant', md: 'Test MD', appr2: 'Test Second Approver' }[key], roles });

test('two creates with the same save key at the same moment make one draft; the second is handed it, never a 500', gate, async () => {
  const { finCreateDraft } = await import('./finance-vouchers.js');
  const ACCT = actor('acct', ['accountant']);
  const body = jv([[RENT, 700, 0], [FREIGHT, 0, 700]]);
  let made, again;
  const first = await openClient();
  try {
    await first.client.query('BEGIN');
    made = await finCreateDraft(first.qc, first.oc, body, ACCT);                // the first save, not yet committed
    const second = h.db.tx((qc, oc) => finCreateDraft(qc, oc, body, ACCT));   // …and the second arrives with the same key
    second.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the second save waits for the first to settle');
    await first.client.query('COMMIT');
    again = await second;
  } finally {
    await first.client.end();
  }
  assert.equal(again.id, made.id);
  assert.equal(again.status, 'draft');
  assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers WHERE client_key = $1', [body.client_key])).n, 1);
  assert.equal((await linesOf(made.id)).length, 2, 'one set of lines, not two');
  assert.deepEqual((await auditOf(made.id)).map(r => r.action), ['create'], 'one create in the log');
});

test('the same save key from another login, at the same moment, is a conflict, and writes nothing', gate, async () => {
  const { finCreateDraft } = await import('./finance-vouchers.js');
  const body = jv([[RENT, 710, 0], [FREIGHT, 0, 710]]);
  const first = await openClient();
  let made;
  try {
    await first.client.query('BEGIN');
    made = await finCreateDraft(first.qc, first.oc, body, actor('acct', ['accountant']));
    const second = h.db.tx((qc, oc) => finCreateDraft(qc, oc, body, actor('appr2', ['approver'])));
    second.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the second save waits for the first to settle');
    await first.client.query('COMMIT');
    await assert.rejects(second, e => e.status === 409 && e.body.code === 'FIN_DUPLICATE_KEY');
  } finally {
    await first.client.end();
  }
  assert.equal((await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers WHERE client_key = $1', [body.client_key])).n, 1);
  assert.equal((await h.db.one('SELECT created_by_id FROM fin_vouchers WHERE id = $1', [made.id])).created_by_id, h.users.acct.id);
  assert.equal((await auditOf(made.id)).length, 1);
});

// The line trigger fin_line_guard takes FOR SHARE on a line's voucher (ruling R15). An edit that wrote its lines
// before it locked the voucher FOR UPDATE would, with a second edit doing the same, hold a share lock the other
// needs gone before it can update the voucher, and Postgres would end one of them: "40P01 deadlock detected".
// That needs both edits to INSERT lines at once, which they do on a draft that has none yet; on a draft that has
// lines the two collide on (voucher_id, line_no) instead. Both starts are tried.
for (const [start, startLines] of [['no lines yet', () => []], ['two lines', () => [[RENT, 100, 0], [FREIGHT, 0, 100]]]]) {
  test(`edits of one draft (${start}) at the same moment go one after the other: none deadlocks, and each record starts where the last ended`, gate, async () => {
    const { finUpdateDraft } = await import('./finance-vouchers.js');
    const ACCT = actor('acct', ['accountant']);
    const v = await make(jv(startLines(), { narration: 'edit start' }));
    const clients = await Promise.all(Array.from({ length: 6 }, () => openClient()));
    try {
      const runs = clients.map(async (c, i) => {
        await c.client.query('BEGIN');
        try {
          const done = await finUpdateDraft(c.qc, c.oc, v.id, { narration: `edit ${i}`, lines: [[RENT, 200 + i, 0], [FREIGHT, 0, 200 + i]].map(L) }, ACCT);
          await c.client.query('COMMIT');
          return done;
        } catch (e) {
          await c.client.query('ROLLBACK');
          throw e;
        }
      });
      const results = await Promise.allSettled(runs);
      assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => r.reason?.message), [], 'no edit was lost to a deadlock');
    } finally {
      await Promise.all(clients.map(c => c.client.end()));
    }
    const rows = (await auditOf(v.id)).filter(r => r.action === 'edit');
    assert.equal(rows.length, 6);
    // one after the other: each edit's "before" is the one before it's "after"
    assert.equal(rows[0].before.narration, 'edit start');
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].before.narration, rows[i - 1].after.narration, `edit ${i} began where edit ${i - 1} ended`);
    // and what stands is the last of them, whole: its narration, its total and both its lines
    const last = rows.at(-1).after;
    const now = (await open(v.id)).body;
    assert.equal(now.voucher.narration, last.narration);
    const k = Number(last.narration.slice('edit '.length));
    assert.deepEqual(now.lines.map(l => [l.debit_paise, l.credit_paise]), [[200 + k, 0], [0, 200 + k]]);
    assert.equal(now.voucher.total_paise, 200 + k);
  });
}

test('an edit and a discard at the same moment: whichever is second finds the draft as the first left it', gate, async () => {
  const { finUpdateDraft, finDiscardDraft } = await import('./finance-vouchers.js');
  const ACCT = actor('acct', ['accountant']);
  const MD = actor('md', ['approver', 'admin']);

  // the discard first: the edit then finds a voucher that is no draft, and changes nothing
  const a = await make(jv([[RENT, 10, 0], [FREIGHT, 0, 10]], { narration: 'discard wins' }));
  let first = await openClient();
  try {
    await first.client.query('BEGIN');
    await finDiscardDraft(first.qc, first.oc, a.id, MD, { isAdmin: true });
    const edit2 = h.db.tx((qc, oc) => finUpdateDraft(qc, oc, a.id, { narration: 'too late', lines: [L([RENT, 99, 0]), L([FREIGHT, 0, 99])] }, ACCT));
    edit2.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the edit waits for the discard');
    await first.client.query('COMMIT');
    await assert.rejects(edit2, e => e.status === 409 && e.body.code === 'FIN_NOT_DRAFT');
  } finally {
    await first.client.end();
  }
  const kept = (await open(a.id)).body;
  assert.deepEqual([kept.voucher.status, kept.voucher.narration, kept.voucher.total_paise, kept.lines.length], ['discarded', 'discard wins', 10, 2]);

  // the edit first: the discard waits, then discards the entry as it was edited
  const b = await make(jv([[RENT, 10, 0], [FREIGHT, 0, 10]], { narration: 'edit wins' }));
  first = await openClient();
  try {
    await first.client.query('BEGIN');
    await finUpdateDraft(first.qc, first.oc, b.id, { narration: 'edited first' }, ACCT);
    const drop = h.db.tx((qc, oc) => finDiscardDraft(qc, oc, b.id, MD, { isAdmin: true }));
    drop.catch(() => {});
    assert.ok(await lockWaiter(first.qc), 'the discard waits for the edit');
    await first.client.query('COMMIT');
    assert.equal((await drop).status, 'discarded');
  } finally {
    await first.client.end();
  }
  const rows = await auditOf(b.id);
  assert.deepEqual(rows.map(r => r.action), ['create', 'edit', 'discard']);
  assert.equal(rows[2].before.narration, 'edited first', 'the discard saw the edit');
});

// ── Submit, approve, reject (Task 9) ─────────────────────────────────────────────────────────
// The first seven tests are the brief's, verbatim but for the file's FINANCE_PG gate. They run in this order on the
// one database: the fifth locks February, and the sixth adds the 2027-28 year that the race test further down needs.

const submit = (id, who = 'acct') => h.call('POST', `/finance/vouchers/${id}/submit`, null, who);
const pay = (paise, date = '2027-01-12') => ({ book_id: CI, voucher_type: 'payment', voucher_date: date, client_key: randomUUID(),
  narration: 'rent', lines: [L([RENT, paise, 0]), L([ALPHA, 0, paise])] });
const rcpt = (paise, date) => ({ ...pay(paise, date), voucher_type: 'receipt', lines: [L([ALPHA, paise, 0]), L([CUST_A, 0, paise])] });

test('a journal from the accountant waits for the MD, who is told', gate, async () => {
  const v = await make(jv([[RENT, 250000, 0], [FREIGHT, 0, 250000]]));
  const s = await submit(v.id);
  assert.equal(s.body.voucher.status, 'submitted');
  assert.equal(s.body.voucher.number, null);
  const bell = await h.db.q(`SELECT user_id FROM notifications WHERE kind='fin_approval' AND ref_id=$1`, [v.id]);
  assert.deepEqual(bell.map(r => r.user_id).sort(), [h.users.md.id, h.users.appr2.id].sort());
  assert.equal((await h.call('PUT', `/finance/vouchers/${v.id}`, { narration: 'x' }, 'acct')).body.code, 'FIN_NOT_DRAFT');
  const a = await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md');
  assert.equal(a.body.voucher.status, 'posted');
  assert.match(a.body.voucher.number, /^CI-JV-2627-\d{4}$/);
  assert.equal(a.body.voucher.approved_by_id, h.users.md.id);
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md')).body.code, 'FIN_NOT_SUBMITTED');
  assert.equal((await h.db.one(`SELECT COUNT(*)::int n FROM notifications WHERE kind='fin_decision' AND ref_id=$1 AND user_id=$2`, [v.id, h.users.acct.id])).n, 1);
});

test('payments post directly up to the limit and wait above it', gate, async () => {
  const small = await make(pay(5000000));
  const s1 = await submit(small.id);
  assert.equal(s1.body.voucher.status, 'posted');
  assert.equal(s1.body.voucher.self_approved, false);
  assert.match(s1.body.voucher.number, /^CI-PV-2627-\d{4}$/);
  const big = await make(pay(10000001));
  assert.equal((await submit(big.id)).body.voucher.status, 'submitted');
});

test('reject needs a reason, returns the entry to its maker, and an approval after that is refused', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  await submit(v.id);
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/reject`, {}, 'md')).body.code, 'FIN_REASON_REQUIRED');
  const r = await h.call('POST', `/finance/vouchers/${v.id}/reject`, { reason: 'wrong ledger' }, 'md');
  assert.equal(r.body.voucher.status, 'draft');
  assert.equal(r.body.voucher.last_reject_reason, 'wrong ledger');
  assert.equal((await h.call('POST', `/finance/vouchers/${v.id}/approve`, null, 'md')).body.code, 'FIN_NOT_SUBMITTED');
});

test('an approver\'s own entry posts as self-approved; nobody approves their own submitted entry', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'md');
  const s = await submit(v.id, 'md');
  assert.equal(s.body.voucher.status, 'posted');
  assert.equal(s.body.voucher.self_approved, true);
  const own = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]), 'md');
  await h.db.q(`UPDATE fin_vouchers SET status='submitted' WHERE id=$1`, [own.id]);
  assert.equal((await h.call('POST', `/finance/vouchers/${own.id}/approve`, null, 'md')).body.code, 'FIN_OWN_VOUCHER');
});

test('closing months force approval; locked months refuse; no year means a sentence, not a 500', gate, async () => {
  const month = (status, reason) => h.call('PUT', `/finance/periods/${PERIOD.CI['2027-02-01']}/status`, { status, reason }, 'md');
  try {
    await month('closing');
    const feb = await make(rcpt(1000, '2027-02-10'));
    assert.equal((await submit(feb.id)).body.voucher.status, 'submitted');
    assert.equal((await h.call('POST', `/finance/vouchers/${feb.id}/approve`, null, 'md')).body.voucher.status, 'posted');
    await month('locked');
    const late = await make(rcpt(1000, '2027-02-11'));
    assert.equal((await submit(late.id)).body.code, 'FIN_PERIOD_LOCKED');
    const april = await make(rcpt(1000, '2027-04-05'));
    const n = await submit(april.id);
    assert.equal(n.status, 409);
    assert.equal(n.body.code, 'FIN_NO_PERIOD');
    assert.match(n.body.error, /Setup/);
  } finally {
    // February is open again for the tests after this one: the Opening voucher, posted and reversed below, carries into it, and a
    // locked February would refuse both (ruling R70).
    const { status } = await h.db.one('SELECT status FROM fin_periods WHERE id = $1', [PERIOD.CI['2027-02-01']]);
    if (status === 'locked') await month('closing', 'reopened after the test');
    if (status !== 'open') assert.equal((await month('open', 'reopened after the test')).status, 200);
  }
});

test('31 March and 1 April number in different series', gate, async () => {
  await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md');
  const mar = await submit((await make(rcpt(1000, '2027-03-31'))).id);
  const apr = await submit((await make(rcpt(1000, '2027-04-01'))).id);
  assert.match(mar.body.voucher.number, /^CI-RV-2627-\d{4}$/);
  assert.equal(apr.body.voucher.number, 'CI-RV-2728-0001');
});

test('the database sentence reaches the user: unbalanced and wrong-shape entries', gate, async () => {
  const u = await submit((await make(jv([[RENT, 12000000, 0], [FREIGHT, 0, 11800000]]))).id);
  assert.equal(u.body.code, 'FIN_UNBALANCED');
  assert.equal(u.body.error, "Debits ₹1,20,000.00 and credits ₹1,18,000.00 don't match — difference ₹2,000.00.");
  const s = await submit((await make(jv([[ALPHA, 100, 0], [FREIGHT, 0, 100]]))).id);
  assert.equal(s.body.code, 'FIN_SHAPE');
});

// ── Task 9, beyond the brief ─────────────────────────────────────────────────────────────────

const approve = (id, who = 'md') => h.call('POST', `/finance/vouchers/${id}/approve`, null, who);
const reject = (id, reason, who = 'md') => h.call('POST', `/finance/vouchers/${id}/reject`, reason === undefined ? {} : { reason }, who);
const bells = (kind, id) => h.db.q(
  'SELECT user_id, title, body, link, ref_table FROM notifications WHERE kind = $1 AND ref_id = $2 ORDER BY id', [kind, id]);

test('bill details go on any party ledger: one linked to a customer or vendor, or one under Sundry Debtors or Sundry Creditors (ruling R23)', gate, async () => {
  const G = await groupMap(CI);
  const vendorB = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.SundryCreditors, name: 'Vendor B' }, 'acct')).body.ledger.id;
  const exportDebtors = (await h.call('POST', '/finance/groups', { book_id: CI, parent_id: G.SundryDebtors, name: 'Export Debtors' }, 'md')).body.group.id;
  const buyer = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: exportDebtors, name: 'Overseas Buyer' }, 'acct')).body.ledger.id;
  const bill = { bill_ref: 'BILL-77', bill_date: '2027-01-05', due_date: '2027-02-04' };
  // an unlinked ledger under Sundry Creditors takes a bill reference…
  const v = await make({ ...jv([]), lines: [L([RENT, 500, 0]), { ...L([vendorB, 0, 500]), ...bill }] });
  assert.ok(v?.id, 'saved');
  assert.deepEqual((await open(v.id)).body.lines.map(l => [l.bill_ref, l.bill_date, l.due_date]), [[null, null, null], ['BILL-77', '2027-01-05', '2027-02-04']]);
  // …and so does one in a group of its own beneath Sundry Debtors, on an edit as on a create
  assert.equal((await edit(v.id, { lines: [{ ...L([buyer, 500, 0]), ...bill }, { ...L([vendorB, 0, 500]), bill_ref: 'BILL-78' }] })).status, 200);
  assert.deepEqual((await open(v.id)).body.lines.map(l => l.bill_ref), ['BILL-77', 'BILL-78']);
  // …while a ledger that is neither still does not
  await refusedAndNothingWritten(post({ ...jv([]), lines: [{ ...L([FREIGHT, 500, 0]), ...bill }] }), 400, 'FIN_BAD_INPUT', 'lines[0].bill_ref');
});

test('an opening draft and a reversal draft are built by the app, and nobody edits them (ruling R24)', gate, async () => {
  const base = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  const opening = await h.db.one(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, created_by_id, created_by)
     VALUES ($1, 'opening', '2026-12-31', $2, 'Test Accountant') RETURNING id`, [CI, h.users.acct.id]);
  const reversal = await h.db.one(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, reversal_of_id, created_by_id, created_by)
     VALUES ($1, 'journal', '2027-01-20', $2, $3, 'Test Accountant') RETURNING id`, [CI, base.id, h.users.acct.id]);
  const o = await refusedAndNothingWritten(edit(opening.id, { narration: 'x' }), 409, 'FIN_BAD_INPUT');
  assert.equal(o.body.error, 'An opening voucher is rebuilt from the Tally import, not edited.');
  const r = await refusedAndNothingWritten(edit(reversal.id, { lines: [] }), 409, 'FIN_BAD_INPUT');
  assert.equal(r.body.error, "A reversal can't be edited — discard it and reverse again.");
  // …someone else's is still someone else's, and the maker may still throw either away
  await refusedAndNothingWritten(edit(opening.id, { narration: 'x' }, 'md'), 403, 'FIN_NOT_MAKER');
  assert.equal((await discard(opening.id)).body.voucher.status, 'discarded');
  assert.equal((await discard(reversal.id)).body.voucher.status, 'discarded');
});

test('who may: only its maker submits; only an Approver of its book approves or rejects; nobody else learns it is there', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  for (const who of ['md', 'appr2']) await refusedAndNothingWritten(submit(v.id, who), 403, 'FIN_NOT_MAKER');
  await refusedAndNothingWritten(submit(v.id, 'viewer'), 403, 'FIN_FORBIDDEN');
  for (const who of ['dpOnly', 'plant']) await refusedAndNothingWritten(submit(v.id, who), 404, 'FIN_NOT_FOUND');
  for (const id of [999999, 0, -1, 'abc', '1e0']) await refusedAndNothingWritten(submit(id), 404, 'FIN_NOT_FOUND');
  // a draft is nobody's to approve or reject yet
  await refusedAndNothingWritten(approve(v.id), 409, 'FIN_NOT_SUBMITTED');
  await refusedAndNothingWritten(reject(v.id, 'no'), 409, 'FIN_NOT_SUBMITTED');
  assert.equal((await submit(v.id)).body.voucher.status, 'submitted');
  await refusedAndNothingWritten(submit(v.id), 409, 'FIN_NOT_DRAFT');
  for (const who of ['acct', 'viewer']) {
    await refusedAndNothingWritten(approve(v.id, who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(reject(v.id, 'no', who), 403, 'FIN_FORBIDDEN');
  }
  for (const who of ['dpOnly', 'plant']) {
    await refusedAndNothingWritten(approve(v.id, who), 404, 'FIN_NOT_FOUND');
    await refusedAndNothingWritten(reject(v.id, 'no', who), 404, 'FIN_NOT_FOUND');
  }
  for (const id of [999999, 'abc']) {
    await refusedAndNothingWritten(approve(id), 404, 'FIN_NOT_FOUND');
    await refusedAndNothingWritten(reject(id, 'no'), 404, 'FIN_NOT_FOUND');
  }
  // any Approver of the book but its maker: the second approver will do, and he is the one who posts it
  const a = await approve(v.id, 'appr2');
  assert.equal(a.status, 200);
  const p = a.body.voucher;
  assert.deepEqual([p.status, p.approved_by_id, p.approved_by, p.posted_by_id, p.posted_by, p.self_approved, p.period_id],
    ['posted', h.users.appr2.id, 'Test Second Approver', h.users.appr2.id, 'Test Second Approver', false, PERIOD.CI['2027-01-01']]);
  assert.ok(p.posted_at && p.approved_at);
  assert.equal('total' in p, false, 'the API speaks paise only');
  assert.equal(p.total_paise, 100);
  // posted is final
  await refusedAndNothingWritten(reject(v.id, 'too late'), 409, 'FIN_NOT_SUBMITTED');
  await refusedAndNothingWritten(submit(v.id), 409, 'FIN_NOT_DRAFT');
  await refusedAndNothingWritten(edit(v.id, { narration: 'x' }), 409, 'FIN_NOT_DRAFT');
  await refusedAndNothingWritten(discard(v.id), 409, 'FIN_NOT_DRAFT');
});

test('the whole round: submitted, rejected with a reason, mended, sent again, approved; every step logged, every bell rung', gate, async () => {
  const v = await make(jv([[RENT, 400, 0], [FREIGHT, 0, 400]], { narration: 'round trip' }));
  await submit(v.id);
  const r = await reject(v.id, '  use the freight ledger  ', 'appr2');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.voucher.status, r.body.voucher.last_reject_reason, r.body.voucher.last_rejected_by, r.body.voucher.number],
    ['draft', 'use the freight ledger', 'Test Second Approver', null]);
  assert.ok(r.body.voucher.last_rejected_at);
  // back with its maker, who mends it and sends it again; the reason stays on the row until the next one
  assert.equal((await edit(v.id, { narration: 'round trip, mended' })).status, 200);
  const again = (await submit(v.id)).body.voucher;
  assert.deepEqual([again.status, again.last_reject_reason, again.submitted_by_id], ['submitted', 'use the freight ledger', h.users.acct.id]);
  const p = (await approve(v.id)).body.voucher;
  assert.equal(p.status, 'posted');

  const rows = await auditOf(v.id);
  assert.deepEqual(rows.map(x => [x.action, x.user_name]), [
    ['create', 'Test Accountant'], ['submit', 'Test Accountant'], ['reject', 'Test Second Approver'], ['edit', 'Test Accountant'],
    ['submit', 'Test Accountant'], ['approve', 'Test MD'], ['post', 'Test MD'],
  ]);
  const [, sent, rejected, , , approved, posted] = rows;
  assert.deepEqual([sent.before.status, sent.after.status, sent.after.lines.length], ['draft', 'submitted', 2]);
  assert.deepEqual([rejected.reason, rejected.before.status, rejected.after.status, rejected.after.last_reject_reason],
    ['use the freight ledger', 'submitted', 'draft', 'use the freight ledger']);
  assert.equal(approved.user_id, h.users.md.id);
  assert.deepEqual([posted.before.status, posted.before.number, posted.after.status, posted.after.number, posted.after.approved_by_id],
    ['submitted', null, 'posted', p.number, h.users.md.id]);
  assert.deepEqual(posted.after.lines.map(l => [l.ledger_id, l.debit_paise, l.credit_paise]), [[RENT, 400, 0], [FREIGHT, 0, 400]]);
  assert.deepEqual((await open(v.id)).body.history.map(x => x.action), rows.map(x => x.action));

  // each submit tells both Approvers; each decision tells the maker, with the reason or the number
  const asked = await bells('fin_approval', v.id);
  assert.deepEqual(asked.map(b => b.user_id).sort(), [h.users.md.id, h.users.md.id, h.users.appr2.id, h.users.appr2.id].sort());
  for (const b of asked) {
    assert.deepEqual([b.title, b.body, b.link, b.ref_table],
      ['Finance entry waiting for approval', 'CI Journal ₹4.00 — Test Accountant', `/finance?tab=approvals&voucher=${v.id}`, 'fin_vouchers']);
  }
  assert.deepEqual((await bells('fin_decision', v.id)).map(b => [b.user_id, b.title, b.body, b.link]), [
    [h.users.acct.id, 'Your Finance entry was rejected', 'CI Journal ₹4.00 — use the freight ledger', `/finance?tab=drafts&voucher=${v.id}`],
    [h.users.acct.id, 'Your Finance entry was approved', p.number, `/finance?voucher=${v.id}`],
  ]);
});

// Final wave item 7: once one Approver decides, the entry waits for nobody, so the "waiting for approval" bell is answered for every
// Approver who was told, the plant's way (routes/notifications.js clears every bell an answered ask carries). The maker's own bells,
// and any other entry's, are left as they are.
test('an approval or a rejection answers every Approver\'s bell for that entry, and only that entry\'s', gate, async () => {
  const unread = id => h.db.q(`SELECT user_id FROM notifications WHERE kind = 'fin_approval' AND ref_table = 'fin_vouchers' AND ref_id = $1
                                 AND read_at IS NULL ORDER BY user_id`, [id]);
  const approvers = [h.users.md.id, h.users.appr2.id].sort((a, b) => a - b);
  const [one, two, other] = [await make(jv([[RENT, 210, 0], [FREIGHT, 0, 210]])), await make(jv([[RENT, 220, 0], [FREIGHT, 0, 220]])),
    await make(jv([[RENT, 230, 0], [FREIGHT, 0, 230]]))];
  for (const v of [one, two, other]) assert.equal((await submit(v.id)).body.voucher.status, 'submitted');
  for (const v of [one, two, other]) assert.deepEqual((await unread(v.id)).map(b => b.user_id), approvers, 'both Approvers are told');

  // the second Approver approves the first: the MD's bell for it is answered too
  assert.equal((await approve(one.id, 'appr2')).body.voucher.status, 'posted');
  assert.deepEqual(await unread(one.id), [], 'no Approver is left told that it waits');
  // the MD rejects the second: the second Approver's bell for it is answered too
  assert.equal((await reject(two.id, 'wrong ledger')).body.voucher.status, 'draft');
  assert.deepEqual(await unread(two.id), []);
  // the third still waits, and both are still told
  assert.deepEqual((await unread(other.id)).map(b => b.user_id), approvers);
  // the maker's own bells (the decisions) are new, and unread
  const decisions = await h.db.q(`SELECT ref_id FROM notifications WHERE kind = 'fin_decision' AND user_id = $1 AND read_at IS NULL
                                    AND ref_id = ANY($2::int[]) ORDER BY ref_id`, [h.users.acct.id, [one.id, two.id]]);
  assert.deepEqual(decisions.map(d => d.ref_id), [one.id, two.id].sort((a, b) => a - b));
  await reject(other.id, 'tidying up after the test');
});

test('a rejection\'s reason is text, and is checked before anything is written', gate, async () => {
  const v = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  await submit(v.id);
  for (const reason of [undefined, null, '', '   ', 'undefined']) await refusedAndNothingWritten(reject(v.id, reason), 400, 'FIN_REASON_REQUIRED');
  await refusedAndNothingWritten(reject(v.id, 'bad\u0000reason'), 400, 'FIN_BAD_INPUT', 'reason');
  await refusedAndNothingWritten(reject(v.id, 42), 400, 'FIN_BAD_INPUT', 'reason');
  await refusedAndNothingWritten(reject(v.id, 'x'.repeat(501)), 400, 'FIN_BAD_INPUT', 'reason');
  await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${v.id}/reject`, ['wrong ledger'], 'md'), 400, 'FIN_BAD_INPUT');
  assert.equal((await reject(v.id, 'x'.repeat(500))).body.voucher.status, 'draft');
});

test('the limit is the book\'s own rule, read in paise: at the limit posts, a paisa over waits; an Approver\'s own posts either way', gate, async () => {
  assert.equal((await submit((await make(pay(10000000))).id)).body.voucher.status, 'posted', 'exactly ₹1,00,000 is not above it');
  const rule = `UPDATE fin_approval_rules SET mode = $2, limit_amount = $3 WHERE book_id = $1 AND rule_key = 'payment'`;
  try {
    await h.db.q(rule, [CI, 'above_limit', '0.10']);
    assert.equal((await submit((await make(pay(10))).id)).body.voucher.status, 'posted');
    assert.equal((await submit((await make(pay(11))).id)).body.voucher.status, 'submitted');
    await h.db.q(rule, [CI, 'always', null]);
    assert.equal((await submit((await make(pay(1))).id)).body.voucher.status, 'submitted');
    const big = (await submit((await make(pay(10000001), 'md')).id, 'md')).body.voucher;
    assert.deepEqual([big.status, big.self_approved, big.approved_by_id], ['posted', true, h.users.md.id]);
    await h.db.q(rule, [CI, 'never', null]);
    const plain = (await submit((await make(pay(10000001), 'md')).id, 'md')).body.voucher;
    assert.deepEqual([plain.status, plain.self_approved, plain.approved_by_id], ['posted', false, null], 'no approval needed is not self-approval');
  } finally {
    await h.db.q(rule, [CI, 'above_limit', '100000.00']);
  }
});

test('each book has its own Approvers and its own number series', gate, async () => {
  const DP_FREIGHT = (await h.call('POST', '/finance/ledgers', { book_id: DP, group_id: (await groupMap(DP)).DirectExpenses, name: 'DP Freight' }, 'dpOnly')).body.ledger.id;
  const v = await make({ book_id: DP, voucher_type: 'journal', voucher_date: '2027-01-14', client_key: randomUUID(),
    lines: [L([DP_RENT, 300, 0]), L([DP_FREIGHT, 0, 300])] }, 'dpOnly');
  assert.equal((await submit(v.id, 'dpOnly')).body.voucher.status, 'submitted');
  assert.deepEqual((await bells('fin_approval', v.id)).map(b => [b.user_id, b.body]), [[h.users.md.id, 'DP Journal ₹3.00 — Test DP Accountant']], 'appr2 approves CI only');
  assert.ok(idsOf(await list(`?book=${DP}&view=approvals`, 'md')).includes(v.id));
  await refused(approve(v.id, 'appr2'), 404, 'FIN_NOT_FOUND');
  assert.equal((await approve(v.id)).body.voucher.number, 'DP-JV-2627-0001');
  assert.deepEqual((await bells('fin_decision', v.id)).map(b => [b.user_id, b.body]), [[h.users.dpOnly.id, 'DP-JV-2627-0001']]);
});

test('the Opening voucher is dated the day before the books begin, or it is refused; nothing else is dated before them', gate, async () => {
  const CASH = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers.find(l => l.name === 'Cash').id;
  const draft = await h.db.one(
    `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, created_by_id, created_by)
     VALUES ($1, 'opening', '2026-12-30', 5, $2, 'Test Accountant') RETURNING id`, [CI, h.users.acct.id]);
  await h.db.q(
    `INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, 1, $3, 5, 0), ($1, $2, 2, $4, 0, 5)`,
    [draft.id, CI, CASH, PL]);
  const early = await refusedAndNothingWritten(submit(draft.id), 409, 'FIN_BAD_DATE');
  assert.match(early.body.error, /2026-12-31/);
  await h.db.q(`UPDATE fin_vouchers SET voucher_date = '2026-12-31' WHERE id = $1`, [draft.id]);
  assert.equal((await submit(draft.id)).body.voucher.status, 'submitted', 'the opening rule is always');
  // the MD posts it into a month before the books begin, with the system-only Profit & Loss ledger on it
  const p = (await approve(draft.id)).body.voucher;
  assert.deepEqual([p.status, p.number, p.period_id], ['posted', 'CI-OB-2627-0001', PERIOD.CI['2026-12-01']]);
  const dec = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]], { voucher_date: '2026-12-15' }), 'md');
  const before = await refusedAndNothingWritten(submit(dec.id, 'md'), 409, 'FIN_BEFORE_BOOKS');
  assert.match(before.body.error, /^Dec 2026 /);
});

test('a reversal posts, and marks the entry it reverses, in one transaction: at once for an Approver, on approval for an accountant', gate, async () => {
  // Task 10 builds reversals; until then one is written here the way it will be: a journal mirroring every line
  const reversalOf = async (orig, who, date) => {
    const rev = await h.db.one(
      `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, reversal_of_id, total, created_by_id, created_by)
       VALUES ($1, 'journal', $2, $3, $4, $5, $6) RETURNING id`,
      [CI, date, orig.id, (orig.total_paise / 100).toFixed(2), h.users[who].id, who === 'md' ? 'Test MD' : 'Test Accountant']);
    await h.db.q(
      `INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit)
       SELECT $1, book_id, line_no, ledger_id, credit, debit FROM fin_voucher_lines WHERE voucher_id = $2`, [rev.id, orig.id]);
    return rev.id;
  };
  const a = (await submit((await make(pay(2000, '2027-01-18'))).id)).body.voucher;
  const ra = await reversalOf(a, 'md', '2027-01-19');
  const pa = (await submit(ra, 'md')).body.voucher;
  assert.deepEqual([pa.status, pa.self_approved, pa.reversal_of_id, pa.approved_by_id], ['posted', true, a.id, h.users.md.id], 'the reversal rule is always');
  assert.match(pa.number, /^CI-JV-2627-\d{4}$/);
  const ao = (await open(a.id)).body.voucher;
  assert.deepEqual([ao.reversed_by_id, ao.reversed_by_number], [ra, pa.number]);

  const b = (await submit((await make(pay(3000, '2027-01-18'))).id)).body.voucher;
  const rb = await reversalOf(b, 'acct', '2027-01-19');
  assert.equal((await submit(rb)).body.voucher.status, 'submitted');
  assert.equal((await open(b.id)).body.voucher.reversed_by_id, null, 'marked only when the reversal posts');
  assert.deepEqual((await bells('fin_approval', rb)).map(x => x.body), ['CI Reversal ₹30.00 — Test Accountant', 'CI Reversal ₹30.00 — Test Accountant']);
  assert.equal((await approve(rb)).body.voucher.status, 'posted');
  assert.equal((await open(b.id)).body.voucher.reversed_by_id, rb);
  const net = await h.db.q('SELECT ledger_id, SUM(debit - credit)::float s FROM fin_voucher_lines WHERE voucher_id = ANY($1) GROUP BY 1', [[a.id, ra, b.id, rb]]);
  assert.ok(net.length && net.every(x => Math.round(x.s * 100) === 0), 'every ledger nets to zero');
});

test('an entry waiting in a month that is locked meanwhile is refused, stays waiting, and posts once the month reopens', gate, async () => {
  const MAR = PERIOD.CI['2027-03-01'];
  const month = (status, reason) => h.call('PUT', `/finance/periods/${MAR}/status`, { status, reason }, 'md');
  try {
    const v = await make(jv([[RENT, 600, 0], [FREIGHT, 0, 600]], { voucher_date: '2027-03-10' }));
    await submit(v.id);
    assert.equal((await month('closing')).status, 200);
    assert.equal((await month('locked')).status, 200);
    const locked = await refusedAndNothingWritten(approve(v.id), 409, 'FIN_PERIOD_LOCKED');
    assert.match(locked.body.error, /^Mar 2027 /);
    const still = (await open(v.id)).body.voucher;
    assert.deepEqual([still.status, still.number, still.approved_by_id], ['submitted', null, null]);
    assert.equal((await month('closing', 'CA adjustments')).status, 200);
    // in a closing month the MD's own entry posts at once, approved by him; an accountant's receipt, which needs nobody
    // in an open month, waits
    const own = (await submit((await make(rcpt(900, '2027-03-11'), 'md')).id, 'md')).body.voucher;
    assert.deepEqual([own.status, own.self_approved, own.approved_by_id], ['posted', true, h.users.md.id]);
    assert.equal((await submit((await make(rcpt(900, '2027-03-12'))).id)).body.voucher.status, 'submitted');
    const p = (await approve(v.id)).body.voucher;
    assert.deepEqual([p.status, p.period_id], ['posted', MAR]);
  } finally {
    // March is open again for the tests after this one, however this one ended
    const { status } = await h.db.one('SELECT status FROM fin_periods WHERE id = $1', [MAR]);
    if (status === 'locked') await month('closing', 'reopened after the test');
    if (status !== 'open') assert.equal((await month('open', 'reopened after the test')).status, 200);
  }
});

test('a submit that meets an edit moving the entry: to another month, it posts in that month; to another year, it is refused', gate, async () => {
  const { finSubmitVoucher, finUpdateDraft } = await import('./finance-vouchers.js');
  const ACCT = actor('acct', ['accountant']);
  // The edit holds the voucher while the submit reads where it falls, picks its number series and locks it, then
  // waits on the voucher; the edit commits, and the submit finds the voucher dated elsewhere.
  const raceEdit = async (id, voucher_date) => {
    const first = await openClient();
    try {
      await first.client.query('BEGIN');
      await finUpdateDraft(first.qc, first.oc, id, { voucher_date }, ACCT);
      const sub = h.db.tx((qc, oc) => finSubmitVoucher(qc, oc, id, ACCT));
      sub.catch(() => {});
      assert.ok(await lockWaiter(first.qc), 'the submit waits for the edit');
      await first.client.query('COMMIT');
      return await sub.then(v => ({ v }), e => ({ e }));
    } finally {
      await first.client.end();
    }
  };
  const a = await make(rcpt(1100, '2027-01-22'));
  const moved = await raceEdit(a.id, '2027-03-22');
  assert.equal(moved.e, undefined, moved.e?.message);
  assert.deepEqual([moved.v.status, moved.v.voucher_date, moved.v.period_id], ['posted', '2027-03-22', PERIOD.CI['2027-03-01']]);
  assert.match(moved.v.number, /^CI-RV-2627-\d{4}$/);
  const b = await make(rcpt(1200, '2027-03-23'));
  const away = await raceEdit(b.id, '2027-04-03');
  assert.deepEqual([away.e?.status, away.e?.body?.code], [409, 'FIN_CHANGED']);
  const kept = (await open(b.id)).body.voucher;
  assert.deepEqual([kept.status, kept.voucher_date, kept.number], ['draft', '2027-04-03', null]);
  assert.match((await submit(b.id)).body.voucher.number, /^CI-RV-2728-\d{4}$/);
});

test('a draft that could never post is refused at submit, by its line, and never waits in the queue', gate, async () => {
  const G = await groupMap(CI);
  const temp = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: G.IndirectExpenses, name: 'Temp Expense' }, 'acct')).body.ledger.id;
  const v = await make(jv([[FREIGHT, 100, 0], [temp, 0, 100]]));
  await h.call('PUT', `/finance/ledgers/${temp}`, { active: false }, 'md');
  const off = await refusedAndNothingWritten(submit(v.id), 409, 'FIN_LEDGER_INACTIVE');
  assert.equal(off.body.error, 'Line 2 uses Temp Expense, which is switched off and takes no new postings.');
  await refusedAndNothingWritten(submit((await make(jv([]))).id), 409, 'FIN_TOO_FEW_LINES');
  await refusedAndNothingWritten(submit((await make(jv([[RENT, 100, 0]]))).id), 409, 'FIN_TOO_FEW_LINES');
  const shapes = [
    ['payment', [[RENT, 100, 0], [FREIGHT, 0, 100]], 'A payment needs money going out of a bank or cash ledger.'],
    ['receipt', [[RENT, 100, 0], [ALPHA, 0, 100]], 'A receipt needs money coming into a bank or cash ledger.'],
    ['contra', [[ALPHA, 100, 0], [RENT, 0, 100]], 'A contra moves money between bank and cash ledgers only.'],
  ];
  for (const [voucher_type, lines, says] of shapes) {
    const r = await refusedAndNothingWritten(submit((await make(jv(lines, { voucher_type }))).id), 409, 'FIN_SHAPE');
    assert.equal(r.body.error, says);
  }
  assert.ok(!idsOf(await list(`?book=${CI}&view=approvals`, 'md')).includes(v.id));
  assert.equal((await open(v.id)).body.voucher.status, 'draft');
});

test('what only the database sees still stops a posting at COMMIT, in its words, and the number goes to the next entry', gate, async () => {
  const a = (await submit((await make(rcpt(700, '2027-01-21'))).id)).body.voucher;
  const b = await make(rcpt(800, '2027-01-21'));
  await h.db.q('UPDATE fin_vouchers SET total = 9 WHERE id = $1', [b.id]);   // a total out of step with the lines: no app path writes one
  await refusedAndNothingWritten(submit(b.id), 409, 'FIN_UNBALANCED');
  assert.equal((await open(b.id)).body.voucher.status, 'draft');
  await h.db.q('UPDATE fin_vouchers SET total = 8 WHERE id = $1', [b.id]);
  const c = (await submit(b.id)).body.voucher;
  assert.equal(Number(c.number.slice(-4)), Number(a.number.slice(-4)) + 1, 'the refused posting gave its number back');
});

// ── Ruling R27: a posting holds the ledgers it posts to ─────────────────────────────────────────
// The database checks a posted voucher's ledgers again at COMMIT (H6). A ledger switched off between the posting's own
// check and that COMMIT would refuse the COMMIT after the maker's phone was told "approved" and the number named. So
// a posting takes its lines' ledgers FOR SHARE: a switch-off waits for the posting, or the posting waits for the
// switch-off and then refuses in its own words, before anything is minted or rung. Each ordering is driven on two
// clients, and each wait is asked of Postgres (lockWaiter), not of the clock.

test('a ledger switched off while an approval is posting waits for it: the entry posts, then the ledger goes off (ruling R27)', gate, async () => {
  const { finApproveVoucher } = await import('./finance-vouchers.js');
  const race = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: (await groupMap(CI)).IndirectExpenses, name: 'Race Expense A' }, 'acct')).body.ledger.id;
  const v = await make(jv([[race, 500, 0], [FREIGHT, 0, 500]]));
  assert.equal((await submit(v.id)).body.voucher.status, 'submitted');
  const a = await openClient();
  let off;
  let settled = false;
  try {
    await a.client.query('BEGIN');
    const posted = await finApproveVoucher(a.qc, a.oc, v.id, actor('md', ['approver', 'admin']));   // all of it but the COMMIT
    assert.equal(posted.status, 'posted');
    off = h.call('PUT', `/finance/ledgers/${race}`, { active: false }, 'md').finally(() => { settled = true; });
    assert.ok(await lockWaiter(a.qc), 'the switch-off waits for the posting');
    assert.equal(settled, false, 'and has not answered yet');
    await a.client.query('COMMIT');
  } finally {
    await a.client.end();
  }
  const r = await off;
  assert.deepEqual([r.status, r.body.ledger?.active], [200, false], 'then the switch-off goes through');
  const now = (await open(v.id)).body.voucher;
  assert.equal(now.status, 'posted');
  assert.match(now.number, /^CI-JV-2627-\d{4}$/);
  assert.equal((await bells('fin_decision', v.id)).length, 1, 'the maker was told once, and it is true');
});

test('a ledger switched off first holds the approval back, which then refuses in its own words: nothing minted, nobody told (ruling R27)', gate, async () => {
  const { finUpdateLedger } = await import('./finance-masters.js');
  const race = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: (await groupMap(CI)).IndirectExpenses, name: 'Race Expense B' }, 'acct')).body.ledger.id;
  const v = await make(jv([[FREIGHT, 600, 0], [race, 0, 600]]));
  assert.equal((await submit(v.id)).body.voucher.status, 'submitted');
  const lastJournal = async () => (await h.db.one(`SELECT max(number) AS n FROM fin_vouchers WHERE number LIKE 'CI-JV-2627-%'`)).n;
  const taken = await lastJournal();
  const b = await openClient();
  let approval;
  let settled = false;
  try {
    await b.client.query('BEGIN');
    await finUpdateLedger(b.qc, b.oc, race, { active: false }, actor('md', ['approver', 'admin']), { isAdmin: true });
    approval = approve(v.id).finally(() => { settled = true; });
    assert.ok(await lockWaiter(b.qc), 'the approval waits for the switch-off');
    assert.equal(settled, false, 'and has not answered yet');
    await b.client.query('COMMIT');
  } finally {
    await b.client.end();
  }
  const r = await approval;
  assert.deepEqual([r.status, r.body.code], [409, 'FIN_LEDGER_INACTIVE']);
  assert.equal(r.body.error, 'Line 2 uses Race Expense B, which is switched off and takes no new postings.',
    'the posting\'s own check said it, before the number and the bell; the database at COMMIT would have said less');
  const still = (await open(v.id)).body.voucher;
  assert.deepEqual([still.status, still.number, still.approved_by_id], ['submitted', null, null]);
  assert.deepEqual(await bells('fin_decision', v.id), [], 'nobody was told it was approved');
  assert.equal(await lastJournal(), taken, 'no number was taken');
  // switched on again, the same entry posts, with the number the refused approval never took
  assert.equal((await h.call('PUT', `/finance/ledgers/${race}`, { active: true }, 'md')).status, 200);
  const p = (await approve(v.id)).body.voucher;
  assert.equal(p.number, `CI-JV-2627-${String(Number(taken.slice(-4)) + 1).padStart(4, '0')}`);
});

// ── Reversal (Task 10) ───────────────────────────────────────────────────────────────────────
// The brief's three tests are verbatim but for the file's FINANCE_PG gate. The third locks January, so it is the last
// test in the file (Task 9's tests above locked February); every test between them keeps to months that stay open.

test('an approver reverses at once; both entries stay; every ledger nets to zero', gate, async () => {
  const p = (await submit((await make(pay(300000, '2027-01-15'))).id)).body.voucher;
  const r = await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16', reason: 'duplicate' }, 'md');
  assert.equal(r.body.voucher.status, 'posted');
  assert.equal(r.body.voucher.self_approved, true);
  assert.match(r.body.voucher.number, /^CI-JV-2627-\d{4}$/);
  const o = (await h.call('GET', `/finance/vouchers/${p.id}`, null, 'md')).body;
  assert.equal(o.voucher.reversed_by_id, r.body.voucher.id);
  assert.equal(o.can.reverse, false);
  const net = await h.db.q(`SELECT ledger_id, SUM(debit - credit)::float s FROM fin_voucher_lines WHERE voucher_id = ANY($1) GROUP BY 1`, [[p.id, r.body.voucher.id]]);
  assert.ok(net.every(x => Math.round(x.s * 100) === 0));
  assert.equal((await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-17', reason: 'again' }, 'md')).body.code, 'FIN_ALREADY_REVERSED');
});

test('an accountant asks; the MD approves; drafts and reasonless reversals are refused', gate, async () => {
  const p = (await submit((await make(pay(1000, '2027-01-15'))).id)).body.voucher;
  assert.equal((await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16' }, 'acct')).body.code, 'FIN_REASON_REQUIRED');
  const r = await h.call('POST', `/finance/vouchers/${p.id}/reverse`, { date: '2027-01-16', reason: 'wrong vendor' }, 'acct');
  assert.equal(r.body.voucher.status, 'submitted');
  await h.call('POST', `/finance/vouchers/${r.body.voucher.id}/approve`, null, 'md');
  assert.equal((await h.call('GET', `/finance/vouchers/${p.id}`, null, 'md')).body.voucher.reversed_by_id, r.body.voucher.id);
  const d = await make(pay(1000, '2027-01-15'));
  assert.equal((await h.call('POST', `/finance/vouchers/${d.id}/reverse`, { date: '2027-01-16', reason: 'x' }, 'md')).body.code, 'FIN_NOT_POSTED');
});

// ── Task 10, beyond the brief ────────────────────────────────────────────────────────────────

const reverse = (id, body, who = 'md') => h.call('POST', `/finance/vouchers/${id}/reverse`, body, who);
// A payment from the accountant, under the ₹1,00,000 limit, so it posts the moment it is submitted.
const postedPay = async (paise, date) => (await submit((await make(pay(paise, date))).id)).body.voucher;

test('a reversal mirrors its entry line for line, says why in its narration, and both keep their place in the log', gate, async () => {
  const bill = { bill_ref: 'INV-77', bill_date: '2027-01-05', due_date: '2027-02-04' };
  const orig = (await submit((await make({ ...rcpt(7000, '2027-01-18'), lines: [
    { ...L([ALPHA, 7000, 0]), narration: 'cheque 000123' },
    { ...L([CUST_A, 0, 4000]), narration: 'against INV-77', ...bill },
    { ...L([CUST_A, 0, 3000]), narration: 'on account' },
  ] })).id)).body.voucher;
  assert.equal(orig.status, 'posted');
  const r = await reverse(orig.id, { date: '2027-01-20', reason: '  the cheque bounced  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rev = r.body.voucher;
  assert.deepEqual(
    [rev.book_id, rev.voucher_type, rev.reversal_of_id, rev.voucher_date, rev.status, rev.total_paise, rev.reference, rev.period_id],
    [CI, 'journal', orig.id, '2027-01-20', 'posted', 7000, null, PERIOD.CI['2027-01-01']]);
  assert.deepEqual([rev.created_by_id, rev.approved_by_id, rev.posted_by_id, rev.self_approved], [h.users.md.id, h.users.md.id, h.users.md.id, true]);
  assert.equal(rev.narration, `Reversal of ${orig.number} — the cheque bounced`);
  assert.match(rev.number, /^CI-JV-2627-\d{4}$/);
  assert.equal('total' in rev, false, 'the API speaks paise only');
  // every line mirrored: the same ledgers in the same order, debit and credit swapped, the same narration and bill details
  const pick = l => [l.line_no, l.ledger_id, l.debit_paise, l.credit_paise, l.narration, l.bill_ref, l.bill_date, l.due_date];
  const was = (await open(orig.id)).body.lines.map(pick);
  const now = (await open(rev.id)).body;
  assert.deepEqual(now.lines.map(pick), was.map(([n, ledger, dr, cr, ...rest]) => [n, ledger, cr, dr, ...rest]));
  assert.deepEqual([now.voucher.reversal_of_number, now.voucher.reversed_by_number], [orig.number, null]);
  // both stand: the entry, marked reversed by it, is offered for nothing more
  const o = (await open(orig.id, 'md')).body;
  assert.deepEqual([o.voucher.status, o.voucher.reversed_by_id, o.voucher.reversed_by_number, o.voucher.pending_reversal_id], ['posted', rev.id, rev.number, null]);
  assert.deepEqual(o.can, { edit: false, submit: false, discard: false, approve: false, reject: false, reverse: false });
  // the log: the reversal was made and posted by the MD; the entry carries his request, with the reason
  assert.deepEqual(now.history.map(x => [x.action, x.user_name]), [['create', 'Test MD'], ['post', 'Test MD']]);
  const [made] = await auditOf(rev.id);
  assert.deepEqual([made.after.status, made.after.reversal_of_id, made.after.lines.length], ['draft', orig.id, 3]);
  const asked = (await auditOf(orig.id)).at(-1);
  assert.deepEqual([asked.action, asked.user_id, asked.user_name, asked.reason], ['reverse', h.users.md.id, 'Test MD', 'the cheque bounced']);
  assert.deepEqual([asked.before.reversed_by_id, asked.after.reversed_by_id, asked.after.lines.length], [null, rev.id, 3]);
});

test('who may reverse: anyone who may enter in the entry\'s book; a viewer may not; nobody else learns the entry is there', gate, async () => {
  const p = await postedPay(1100, '2027-01-19');
  const ask = (id, who) => reverse(id, { date: '2027-01-20', reason: 'x' }, who);
  await refusedAndNothingWritten(ask(p.id, 'viewer'), 403, 'FIN_FORBIDDEN');
  for (const who of ['dpOnly', 'plant']) await refusedAndNothingWritten(ask(p.id, who), 404, 'FIN_NOT_FOUND');
  for (const id of [999999, 0, -1, 'abc', '1e0']) await refusedAndNothingWritten(ask(id, 'md'), 404, 'FIN_NOT_FOUND');
  // any Approver of the book posts it at once, in his own name
  const r = (await reverse(p.id, { date: '2027-01-20', reason: 'paid from the wrong account' }, 'appr2')).body.voucher;
  assert.deepEqual([r.status, r.self_approved, r.approved_by_id, r.posted_by_id, r.created_by], ['posted', true, h.users.appr2.id, h.users.appr2.id, 'Test Second Approver']);
  // each book reverses into its own number series
  const cartage = (await h.call('POST', '/finance/ledgers', { book_id: DP, group_id: (await groupMap(DP)).DirectExpenses, name: 'DP Cartage' }, 'md')).body.ledger.id;
  const dp = await make({ book_id: DP, voucher_type: 'journal', voucher_date: '2027-01-19', client_key: randomUUID(), lines: [L([DP_RENT, 250, 0]), L([cartage, 0, 250])] }, 'md');
  assert.equal((await submit(dp.id, 'md')).body.voucher.status, 'posted');
  assert.match((await reverse(dp.id, { date: '2027-01-21', reason: 'booked in the wrong book' })).body.voucher.number, /^DP-JV-2627-\d{4}$/);
});

test('a reversal refused for its date or its reason writes nothing, and leaves the entry as it was', gate, async () => {
  const p = await postedPay(1200, '2027-01-19');
  const at = (date, reason) => reverse(p.id, { date, reason });
  for (const date of ['2027-02-30', '2027-1-20', '20/01/2027', 20270120, true, ['2027-01-20'], '2100-01-01']) {
    await refusedAndNothingWritten(at(date, 'x'), 400, 'FIN_BAD_DATE', 'date');
  }
  // never dated before the entry it reverses
  const early = await refusedAndNothingWritten(at('2027-01-18', 'x'), 409, 'FIN_BAD_DATE', 'date');
  assert.match(early.body.error, new RegExp(`${p.number} is dated 2027-01-19`));
  // …nor on a day no financial year covers
  const none = await refusedAndNothingWritten(at('2028-04-05', 'x'), 409, 'FIN_NO_PERIOD');
  assert.match(none.body.error, /2028-04-05/);
  // the reason is text, and it is there
  for (const reason of [undefined, null, '', '   ', 'undefined']) await refusedAndNothingWritten(at('2027-01-20', reason), 400, 'FIN_REASON_REQUIRED');
  for (const reason of [42, ['a'], { why: 'x' }, 'bad\u0000reason', 'x'.repeat(501)]) await refusedAndNothingWritten(at('2027-01-20', reason), 400, 'FIN_BAD_INPUT', 'reason');
  await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${p.id}/reverse`, ['2027-01-20', 'x'], 'md'), 400, 'FIN_BAD_INPUT');
  const still = (await open(p.id, 'md')).body;
  assert.deepEqual([still.voucher.reversed_by_id, still.can.reverse], [null, true]);
  // …and it is reversed on the day it was made, with as long a reason as a reason may be
  assert.equal((await at('2027-01-19', 'y'.repeat(500))).body.voucher.status, 'posted');
});

test('only a posted entry is reversed, and a reversal on its way holds it: no second one until the first is decided or discarded', gate, async () => {
  // not posted: waiting for approval, or discarded (a draft is the brief's)
  const waiting = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]], { voucher_date: '2027-01-21' }));
  await submit(waiting.id);
  const w = await refusedAndNothingWritten(reverse(waiting.id, { date: '2027-01-22', reason: 'x' }), 409, 'FIN_NOT_POSTED');
  assert.match(w.body.error, /waiting for approval/);
  const gone = await make(jv([[RENT, 100, 0], [FREIGHT, 0, 100]]));
  await discard(gone.id);
  await refusedAndNothingWritten(reverse(gone.id, { date: '2027-01-22', reason: 'x' }), 409, 'FIN_NOT_POSTED');

  // the accountant asks; the Approvers are told; while it waits nobody reverses the entry again, and it is not offered
  const p = await postedPay(1400, '2027-01-21');
  const asked = (await reverse(p.id, { date: '2027-01-22', reason: 'wrong ledger' }, 'acct')).body.voucher;
  assert.deepEqual([asked.status, asked.number, asked.reversal_of_id, asked.created_by_id], ['submitted', null, p.id, h.users.acct.id]);
  assert.deepEqual((await bells('fin_approval', asked.id)).map(b => [b.user_id, b.body]).sort(), [
    [h.users.md.id, 'CI Reversal ₹14.00 — Test Accountant'], [h.users.appr2.id, 'CI Reversal ₹14.00 — Test Accountant']].sort());
  assert.deepEqual((await open(asked.id)).body.history.map(x => x.action), ['create', 'submit']);
  for (const who of ['md', 'acct']) {
    const again = await refusedAndNothingWritten(reverse(p.id, { date: '2027-01-23', reason: 'again' }, who), 409, 'FIN_ALREADY_REVERSED');
    assert.match(again.body.error, /waiting for approval/);
    const seen = (await open(p.id, who)).body;
    assert.deepEqual([seen.can.reverse, seen.voucher.pending_reversal_id, seen.voucher.reversed_by_id], [false, asked.id, null], who);
  }
  // sent back as a draft it still holds the entry; discarded, it lets go
  assert.equal((await reject(asked.id, 'date it the 25th')).body.voucher.status, 'draft');
  const held = await refusedAndNothingWritten(reverse(p.id, { date: '2027-01-23', reason: 'again' }), 409, 'FIN_ALREADY_REVERSED');
  assert.match(held.body.error, /draft/);
  assert.equal((await discard(asked.id)).body.voucher.status, 'discarded');
  const free = (await open(p.id, 'md')).body;
  assert.deepEqual([free.can.reverse, free.voucher.pending_reversal_id], [true, null]);
  const done = (await reverse(p.id, { date: '2027-01-25', reason: 'wrong ledger' })).body.voucher;
  assert.equal(done.status, 'posted');
  assert.equal((await open(p.id)).body.voucher.reversed_by_id, done.id);
  assert.equal((await open(asked.id)).body.voucher.status, 'discarded', 'the request it replaced stays in the trail');
});

test('the reversal date is today when none is given', gate, async () => {
  const { plantDateStr } = await import('./plant-calendar.js');
  const p = await postedPay(1500, '2027-01-22');
  const today = plantDateStr();
  // Whatever today is: the reversal is posted on today's date, or refused exactly as a request dated today is
  const asked = await reverse(p.id, { reason: 'no date given' });
  if (asked.status === 200) {
    assert.equal(asked.body.voucher.voucher_date, today);
  } else {
    // a day a reversal of this January entry can't take: before it, before the books begin, a locked month, no year
    assert.equal(asked.status, 409, JSON.stringify(asked.body));
    assert.ok(['FIN_BAD_DATE', 'FIN_BEFORE_BOOKS', 'FIN_PERIOD_LOCKED', 'FIN_NO_PERIOD'].includes(asked.body.code), JSON.stringify(asked.body));
    for (const date of [null, '', '   ', today]) assert.deepEqual(await reverse(p.id, { date, reason: 'no date given' }), asked, JSON.stringify(date));
  }
});

test('the Opening voucher is reversed on its own date, before the books begin; no other entry is dated there', gate, async () => {
  const live = () => h.db.one(`SELECT id, number FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'posted' AND reversed_by_id IS NULL`, [CI]);
  const ob = await live();
  assert.ok(ob, 'the Opening voucher posted by the test above');
  await refusedAndNothingWritten(reverse(ob.id, { date: '2026-12-30', reason: 'rebuilt from Tally' }), 409, 'FIN_BAD_DATE', 'date');
  const r = (await reverse(ob.id, { date: '2026-12-31', reason: 'rebuilt from Tally' })).body.voucher;
  assert.deepEqual([r.status, r.voucher_date, r.period_id, r.self_approved], ['posted', '2026-12-31', PERIOD.CI['2026-12-01'], true]);
  assert.match(r.number, /^CI-JV-2627-\d{4}$/);
  // its lines mirror the Opening's, the system-only Profit & Loss A/c included
  const sides = async id => (await open(id)).body.lines.map(l => [l.ledger_id, l.debit_paise, l.credit_paise]);
  assert.deepEqual(await sides(r.id), (await sides(ob.id)).map(([ledger, dr, cr]) => [ledger, cr, dr]));
  assert.ok((await sides(r.id)).some(([ledger]) => ledger === PL));
  assert.equal(await live(), null, 'the book has no live Opening voucher now');
  // Ruling R45: the reversal of the Opening voucher is never reversed itself, on any date. That would put the opening
  // back in the books beside whatever was built in its place; a new opening is built instead. Nobody is offered it.
  for (const date of ['2026-12-31', '2027-01-15', undefined]) {
    const undo = await refusedAndNothingWritten(reverse(r.id, { date, reason: 'undo the undo' }), 409, 'FIN_BAD_REVERSAL');
    assert.match(undo.body.error, /^This reversed the Opening voucher, and it is never reversed itself/, String(date));
  }
  assert.equal((await open(r.id)).body.can.reverse, false);
});

test('a reversal mirrors history: a ledger switched off since the entry posted is no bar', gate, async () => {
  const retired = (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: (await groupMap(CI)).IndirectExpenses, name: 'Retired Expense' }, 'acct')).body.ledger.id;
  const v = await make(jv([[retired, 800, 0], [FREIGHT, 0, 800]], { voucher_date: '2027-01-23' }), 'md');
  assert.equal((await submit(v.id, 'md')).body.voucher.status, 'posted');
  assert.equal((await h.call('PUT', `/finance/ledgers/${retired}`, { active: false }, 'md')).body.ledger.active, false);
  await refused(post(jv([[retired, 1, 0], [FREIGHT, 0, 1]])), 409, 'FIN_LEDGER_INACTIVE');   // a typed entry no longer may
  const asked = (await reverse(v.id, { date: '2027-01-24', reason: 'expense withdrawn' }, 'acct')).body.voucher;
  assert.equal(asked.status, 'submitted');
  assert.equal((await approve(asked.id)).body.voucher.status, 'posted');
});

test('the book\'s reversal rule decides, as it does for any entry: set to never, the accountant\'s reversal posts at once', gate, async () => {
  const rule = `UPDATE fin_approval_rules SET mode = $2, limit_amount = $3 WHERE book_id = $1 AND rule_key = 'reversal'`;
  try {
    await h.db.q(rule, [CI, 'never', null]);
    const p = await postedPay(1600, '2027-01-24');
    const r = (await reverse(p.id, { date: '2027-01-24', reason: 'no approval needed' }, 'acct')).body.voucher;
    assert.deepEqual([r.status, r.self_approved, r.approved_by_id, r.posted_by_id], ['posted', false, null, h.users.acct.id]);
  } finally {
    await h.db.q(rule, [CI, 'always', null]);
  }
});

// The brief's third test. It locks January, so it stays the last test in the file.
test('a voucher in a locked month is reversed into an open one, never into a locked one', gate, async () => {
  const jan = (await submit((await make(pay(1000, '2027-01-25'))).id)).body.voucher;
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-01-01']}/status`, { status: 'closing' }, 'md');
  await h.call('PUT', `/finance/periods/${PERIOD.CI['2027-01-01']}/status`, { status: 'locked' }, 'md');
  assert.equal((await h.call('POST', `/finance/vouchers/${jan.id}/reverse`, { date: '2027-01-26', reason: 'x' }, 'md')).body.code, 'FIN_PERIOD_LOCKED');
  assert.equal((await h.call('POST', `/finance/vouchers/${jan.id}/reverse`, { date: '2027-03-02', reason: 'x' }, 'md')).body.voucher.status, 'posted');
});
