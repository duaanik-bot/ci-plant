import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { finBootPg } from './finance-pg-harness.js';

// The Tally import (spec §11): the accountant's Tally balances become Finance's Opening voucher, and Tally's month-end
// trial balances are compared with Finance during the parallel run. Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-import.test.js
//
// One boot for the file; books CI and DP set up with the six logins of FIN_TEST_USERS. The tests share the database and
// run in order, and the order matters. The brief's four come first: CI's Opening voucher is built and posted, a second
// one is refused, a tie-out problem stops a build, and the parallel run compares January. CI has its Opening voucher from
// the first test on, and a book with one refuses another before any tie-out (ruling R37), so whatever must reach a
// tie-out, or build, runs on DP, until the two races at the end, which reverse CI's Opening voucher and build again.
// Every name, figure and GSTIN here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100; // paise per rupee

let h;
let CI, DP;      // book ids
let ACME;        // the ERP customer Acme Pharma Ltd
let c1, c2;      // two raw clients for the races at the end of the file, made there
let pid2;        // c2's backend

const ACCOUNTS = [
  { tally_name: 'Proprietor Capital A/c', tally_group: 'Capital Account' },
  { tally_name: 'Alpha Bank', tally_group: 'Bank Accounts' },
  { tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors' },
  { tally_name: 'Sales @ 5%', tally_group: 'Sales Accounts' },
  { tally_name: 'Output IGST', tally_group: 'Duties & Taxes' },
  { tally_name: 'Profit & Loss A/c', tally_group: 'Profit & Loss' },
  { tally_name: 'Cash', tally_group: 'Cash-in-Hand' },
];
// A trial balance row, in rupees.
const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });
// As at 2026-12-31. 'Current Assets' is a group's subtotal, as Tally prints it among the ledgers; it is ignored.
const TB = [
  tb('Alpha Bank', 500000, 0),
  tb('Current Assets', 659000, 0),
  tb('Acme Pharma Ltd', 159000, 0),
  tb('Proprietor Capital A/c', 0, 300000),
  tb('Sales @ 5%', 0, 300000),
  tb('Output IGST', 0, 15000),
  tb('Profit & Loss A/c', 0, 44000),
];
const BILLS = [
  { tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-11', bill_date: '2026-11-14', due_date: '2026-12-14', amount_paise: 100000 * R, side: 'dr' },
  { tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-12', bill_date: '2026-12-01', due_date: '2026-12-31', amount_paise: 59000 * R, side: 'dr' },
];

before(async () => {
  if (!ON) return;
  h = await finBootPg('import');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  ACME = (await h.db.one(`INSERT INTO customers (name) VALUES ('Acme Pharma Ltd') RETURNING id`)).id;
});

after(async () => {
  for (const client of [c1, c2]) await client?.end().catch(() => {});
  await h?.close();
});

// What a confirmation sends back: every row of the import with the proposal it was given, as the brief's test spells it.
const confirmAll = ledgers => ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
  ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));

// ── The brief's four ─────────────────────────────────────────────────────────────────────────

test('opening: upload, confirm matches, tie out, build, MD posts — and the 31 Dec trial balance is Tally\'s', gate, async () => {
  const up = await h.call('POST', '/finance/imports', { book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts: ACCOUNTS, tb: TB, bills: BILLS }, 'acct');
  assert.equal(up.status, 200);
  assert.equal(up.body.import.summary.ignored_rows, 1);
  const galpha = up.body.ledgers.find(r => r.tally_name === 'Acme Pharma Ltd');
  assert.equal(galpha.match_status, 'create');
  await h.call('PUT', `/finance/imports/${up.body.import.id}/matches`, { matches: up.body.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status, ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id })) }, 'acct');
  const view = (await h.call('GET', `/finance/imports/${up.body.import.id}`)).body;
  assert.equal(view.tie_out.ok, true, JSON.stringify(view.tie_out.problems));
  const built = await h.call('POST', `/finance/imports/${up.body.import.id}/build-opening`, null, 'acct');
  assert.equal(built.body.voucher.status, 'submitted');
  assert.equal(built.body.voucher.voucher_type, 'opening');
  assert.equal(built.body.voucher.voucher_date, '2026-12-31');
  const posted = await h.call('POST', `/finance/vouchers/${built.body.voucher.id}/approve`, null, 'md');
  assert.equal(posted.body.voucher.number, 'CI-OB-2627-0001');
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`)).body;
  const by = Object.fromEntries(tb.ledgers.map(l => [l.name, l.closing_paise]));
  for (const r of TB.filter(r => r.tally_name !== 'Current Assets'))
    assert.equal(by[r.tally_name] ?? 0, r.debit_paise - r.credit_paise, r.tally_name);
  const lines = (await h.call('GET', `/finance/vouchers/${built.body.voucher.id}`)).body.lines.filter(l => l.bill_ref);
  assert.equal(lines.length, 2);
});

test('a second opening for the same book is refused', gate, async () => {
  // CI's Opening voucher was posted by the MD in the test above. A fresh upload of the same files is accepted, and its
  // rows now all match the ledgers that voucher's build made; the build is what the book refuses.
  const up = await h.call('POST', '/finance/imports', { book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts: ACCOUNTS, tb: TB, bills: BILLS }, 'acct');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual(up.body.ledgers.map(r => r.match_status), ACCOUNTS.map(() => 'matched'));
  const id = up.body.import.id;
  assert.equal((await h.call('PUT', `/finance/imports/${id}/matches`, { matches: confirmAll(up.body.ledgers) }, 'acct')).status, 200);
  const openings = () => h.db.one(`SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening'`, [CI]);
  const was = await openings();
  const built = await h.call('POST', `/finance/imports/${id}/build-opening`, null, 'acct');
  assert.equal(built.status, 409, JSON.stringify(built.body));
  assert.equal(built.body.code, 'FIN_OPENING_EXISTS');
  assert.deepEqual(await openings(), was, 'no second Opening voucher was made');
  assert.equal((await h.call('GET', `/finance/imports/${id}`)).body.import.status, 'matched', 'and the import is not used up');
});

test('a tie-out problem blocks the build and says why', gate, async () => {
  // CI has its Opening voucher, which is refused before any tie-out (ruling R37), so this is DP's, with Alpha Bank ₹1 out.
  const off = TB.map(r => (r.tally_name === 'Alpha Bank' ? { ...r, debit_paise: r.debit_paise + 1 * R } : r));
  const up = await h.call('POST', '/finance/imports', { book_id: DP, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts: ACCOUNTS, tb: off, bills: BILLS }, 'acct');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = up.body.import.id;
  assert.equal((await h.call('PUT', `/finance/imports/${id}/matches`, { matches: confirmAll(up.body.ledgers) }, 'acct')).status, 200);
  const dpLedgers = () => h.db.one('SELECT COUNT(*)::int AS n FROM fin_ledgers WHERE book_id = $1', [DP]);
  const was = await dpLedgers();
  const built = await h.call('POST', `/finance/imports/${id}/build-opening`, null, 'acct');
  assert.equal(built.status, 409, JSON.stringify(built.body));
  assert.equal(built.body.code, 'FIN_TIE_OUT');
  assert.equal(built.body.problems[0].code, 'TB_UNBALANCED');
  assert.match(built.body.problems[0].message, /debits ₹6,59,001\.00, credits ₹6,59,000\.00 — a difference of ₹1\.00/);
  assert.deepEqual(await dpLedgers(), was, 'no ledger was made');
  assert.equal((await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE book_id = $1`, [DP])).n, 0, 'and no voucher');
});

test('the parallel run shows the one ledger that differs from Tally', gate, async () => {
  const ledgers = (await h.call('GET', `/finance/books/${CI}/ledgers`)).body.ledgers;
  const id = name => ledgers.find(l => l.name === name).id;
  // The MD posts a ₹10,000 receipt from Acme into Alpha Bank on 10 Jan.
  const draft = await h.call('POST', '/finance/vouchers', { book_id: CI, voucher_type: 'receipt', voucher_date: '2027-01-10', client_key: randomUUID(),
    narration: 'Acme pays on account', lines: [{ ledger_id: id('Alpha Bank'), debit_paise: 10000 * R }, { ledger_id: id('Acme Pharma Ltd'), credit_paise: 10000 * R }] }, 'md');
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const receipt = await h.call('POST', `/finance/vouchers/${draft.body.voucher.id}/submit`, null, 'md');
  assert.equal(receipt.body.voucher.status, 'posted', JSON.stringify(receipt.body));
  // Tally's January trial balance: Alpha Bank ₹1,000 higher than Finance's ₹5,10,000; every other ledger as Finance has it.
  const january = [
    tb('Alpha Bank', 511000, 0), tb('Current Assets', 660000, 0), tb('Acme Pharma Ltd', 149000, 0), tb('Proprietor Capital A/c', 0, 300000),
    tb('Sales @ 5%', 0, 300000), tb('Output IGST', 0, 15000), tb('Profit & Loss A/c', 0, 44000),
  ];
  const up = await h.call('POST', '/finance/imports', { book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', file_names: ['tb-jan.xlsx'], tb: january }, 'acct');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  // A month end is compared, never built from: no tie-out (M6). The group row is left out, and named with its figure (ruling R43).
  assert.equal(up.body.tie_out, null);
  assert.deepEqual(up.body.import.summary.ignored_with_amounts, [{ tally_name: 'Current Assets', debit_paise: 660000 * R, credit_paise: 0 }]);
  const report = await h.call('GET', `/finance/reports/parallel-run?import=${up.body.import.id}`, null, 'viewer');
  assert.equal(report.status, 200, JSON.stringify(report.body));
  const { rows, unmatched, totals } = report.body;
  const alpha = rows.find(r => r.ledger_name === 'Alpha Bank');
  assert.deepEqual([alpha.tally_closing_paise, alpha.finance_closing_paise, alpha.difference_paise], [511000 * R, 510000 * R, 100000]);
  assert.deepEqual(rows.filter(r => r !== alpha).map(r => [r.ledger_name, r.difference_paise]).sort(),
    [['Acme Pharma Ltd', 0], ['Output IGST', 0], ['Profit & Loss A/c', 0], ['Proprietor Capital A/c', 0], ['Sales @ 5%', 0]]);
  assert.equal(totals.differing, 1);
  assert.ok(!rows.some(r => r.tally_name === 'Current Assets' || r.ledger_name === 'Current Assets'), 'the group row is not a ledger');
  assert.ok(!unmatched.some(r => r.tally_name === 'Current Assets'), 'nor an unmatched Tally ledger');
  assert.deepEqual(unmatched, []);
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

const upload = (body, who = 'acct') => h.call('POST', '/finance/imports', body, who);
const opening = (book_id, extra = {}) => ({ book_id, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], accounts: ACCOUNTS, tb: TB, bills: BILLS, ...extra });
const view = (id, who = 'md') => h.call('GET', `/finance/imports/${id}`, null, who);
const putMatches = (id, matches, who = 'acct') => h.call('PUT', `/finance/imports/${id}/matches`, { matches }, who);
const build = (id, who = 'acct') => h.call('POST', `/finance/imports/${id}/build-opening`, null, who);
const listOf = (book, purpose = '') => h.call('GET', `/finance/imports?book=${book}${purpose ? `&purpose=${purpose}` : ''}`);
const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
// A refusal: its status and code, and the field it names when the refusal is about one.
async function refused(call, status, code, field) {
  const r = await call;
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field) assert.equal(r.body.field, field, JSON.stringify(r.body));
  return r;
}
// Everything an import can write, counted. A refused request leaves every figure as it was.
const written = async () => ({
  imports: (await h.db.one('SELECT COUNT(*)::int n FROM fin_imports')).n,
  rows: (await h.db.one('SELECT COUNT(*)::int n FROM fin_import_ledgers')).n,
  bills: (await h.db.one('SELECT COUNT(*)::int n FROM fin_import_bills')).n,
  matched: (await h.db.one(`SELECT COUNT(*)::int n FROM fin_imports WHERE status <> 'draft'`)).n,
  ledgers: (await h.db.one('SELECT COUNT(*)::int n FROM fin_ledgers')).n,
  vouchers: (await h.db.one('SELECT COUNT(*)::int n FROM fin_vouchers')).n,
  audit: (await h.db.one('SELECT COUNT(*)::int n FROM fin_audit_log')).n,
});
async function refusedAndNothingWritten(call, status, code, field) {
  const was = await written();
  const r = await refused(call, status, code, field);
  assert.deepEqual(await written(), was, 'a refused request writes nothing');
  return r;
}
const importAudit = id => h.db.q(`SELECT action, user_name FROM fin_audit_log WHERE entity = 'import' AND entity_id = $1 ORDER BY id`, [id]);
// CI's first opening import, the one the brief's first test built from.
const firstCiOpening = async () => (await ok(listOf(CI, 'opening'))).imports.at(-1);

test('every account row is kept, a zero balance too; the Opening voucher carries the bills and links the party (ruling R36)', gate, async () => {
  const imp = await firstCiOpening();
  assert.deepEqual([imp.status, imp.purpose, imp.as_at], ['used', 'opening', '2026-12-31']);
  const v = await ok(view(imp.id));
  assert.deepEqual(v.ledgers.map(r => r.tally_name), ACCOUNTS.map(a => a.tally_name), 'every row of the List of Accounts, in its order');
  const cash = v.ledgers.find(r => r.tally_name === 'Cash');
  assert.deepEqual([cash.debit_paise, cash.credit_paise, cash.match_status, cash.ledger_name], [0, 0, 'matched', 'Cash'], 'no TB row, still kept');
  assert.equal(v.ledgers.find(r => r.tally_name === 'Profit & Loss A/c').ledger_name, 'Profit & Loss A/c', 'the system ledger, by name');
  assert.deepEqual([v.import.summary.unknown_rows, v.import.summary.unknown], [0, []]);
  assert.deepEqual(v.import.summary.ignored_with_amounts, [{ tally_name: 'Current Assets', debit_paise: 659000 * R, credit_paise: 0 }],
    'the group row is left out, and named with its figure (ruling R43)');

  const { voucher, lines, history } = await ok(h.call('GET', `/finance/vouchers/${imp.opening_voucher_id}`));
  assert.deepEqual([voucher.status, voucher.number, voucher.created_by, voucher.approved_by], ['posted', 'CI-OB-2627-0001', 'Test Accountant', 'Test MD']);
  assert.deepEqual([voucher.narration, voucher.reference, voucher.total_paise], ['Opening balances brought over from Tally, as at 2026-12-31', `Tally import ${imp.id}`, 659000 * R]);
  assert.deepEqual(history.map(e => [e.action, e.user_name]),
    [['create', 'Test Accountant'], ['submit', 'Test Accountant'], ['approve', 'Test MD'], ['post', 'Test MD']], 'the voucher\'s own trail, as any entry\'s');
  assert.deepEqual(lines.map(l => [l.ledger_name, l.debit_paise, l.credit_paise, l.bill_ref, l.bill_date, l.due_date]), [
    ['Proprietor Capital A/c', 0, 300000 * R, null, null, null],
    ['Alpha Bank', 500000 * R, 0, null, null, null],
    ['Acme Pharma Ltd', 100000 * R, 0, 'INV-11', '2026-11-14', '2026-12-14'],
    ['Acme Pharma Ltd', 59000 * R, 0, 'INV-12', '2026-12-01', '2026-12-31'],
    ['Sales @ 5%', 0, 300000 * R, null, null, null],
    ['Output IGST', 0, 15000 * R, null, null, null],
    ['Profit & Loss A/c', 0, 44000 * R, null, null, null],
  ], 'one line per ledger, a line per bill for the party, nothing for a zero balance');
  const made = await h.db.q(
    `SELECT l.name, l.tally_name, l.party_type, l.party_id, g.name AS group_name FROM fin_ledgers l JOIN fin_groups g ON g.id = l.group_id
      WHERE l.book_id = $1 AND l.name IN ('Acme Pharma Ltd', 'Alpha Bank') ORDER BY l.name`, [CI]);
  assert.deepEqual(made.map(l => [l.name, l.tally_name, l.party_type, l.party_id, l.group_name]), [
    ['Acme Pharma Ltd', 'Acme Pharma Ltd', 'customer', ACME, 'Sundry Debtors'],
    ['Alpha Bank', 'Alpha Bank', null, null, 'Bank Accounts'],
  ]);
});

test('upload, match and build each write one audit row for the import, and a refused build writes none', gate, async () => {
  const [first, second] = [await firstCiOpening(), (await ok(listOf(CI, 'opening'))).imports.at(-2)];
  assert.deepEqual((await importAudit(first.id)).map(a => [a.action, a.user_name]),
    [['upload', 'Test Accountant'], ['match', 'Test Accountant'], ['build', 'Test Accountant']]);
  assert.deepEqual((await importAudit(second.id)).map(a => a.action), ['upload', 'match'], 'the second opening was refused');
  const build = await h.db.one(`SELECT before, after FROM fin_audit_log WHERE entity = 'import' AND entity_id = $1 AND action = 'build'`, [first.id]);
  assert.deepEqual([build.before.status, build.after.status, build.after.opening_voucher_id], ['matched', 'used', first.opening_voucher_id]);
  assert.equal(build.after.created_ledgers.length, 5, 'Proprietor Capital, Alpha Bank, Acme, Sales and Output IGST were made');
  // A confirmation that changes nothing is no event: it writes nothing.
  const again = await ok(view(second.id));
  const was = await written();
  await ok(putMatches(second.id, confirmAll(again.ledgers)));
  assert.deepEqual(await written(), was);
});

test('who may: anyone who reads the book reads its imports; the accountant and the admin import; an import out of sight is not there', gate, async () => {
  const imp = await firstCiOpening();
  await ok(view(imp.id, 'viewer'));
  await ok(view(imp.id, 'appr2'));
  for (const who of ['dpOnly', 'plant']) {
    await refused(view(imp.id, who), 404, 'FIN_NOT_FOUND');
    await refused(putMatches(imp.id, [], who), 404, 'FIN_NOT_FOUND');
    await refused(build(imp.id, who), 404, 'FIN_NOT_FOUND');
  }
  for (const missing of ['999999', 'abc', '0', '1e3']) await refused(view(missing), 404, 'FIN_NOT_FOUND');
  for (const who of ['viewer', 'appr2']) {
    await refusedAndNothingWritten(upload(opening(CI), who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(putMatches(imp.id, [], who), 403, 'FIN_FORBIDDEN');
    await refusedAndNothingWritten(build(imp.id, who), 403, 'FIN_FORBIDDEN');
  }
  await refusedAndNothingWritten(upload(opening(CI), 'dpOnly'), 403, 'FIN_FORBIDDEN');
  // The list is the book's: a viewer reads it; a login without the book is refused, like every list that names a book.
  const listed = (await ok(listOf(CI))).imports;
  assert.ok(listed.every(i => i.book_id === CI));
  // It is slim (M7): each import's counts, and none of the names behind them, which one import's own view has.
  for (const i of listed) assert.ok(Object.values(i.summary).every(v => typeof v === 'number'), JSON.stringify(i.summary));
  assert.deepEqual(Object.keys(listed.at(-1).summary).sort(),
    ['accounts_rows', 'bill_rows', 'bills_rows', 'ignored_rows', 'ledger_rows', 'tb_rows', 'unknown_rows', 'zero_bills']);
  assert.ok(Array.isArray((await ok(view(listed.at(-1).id))).import.summary.ignored_with_amounts));
  await refused(h.call('GET', `/finance/imports?book=${CI}`, null, 'dpOnly'), 403, 'FIN_FORBIDDEN');
  await refused(h.call('GET', '/finance/imports'), 400, 'FIN_BAD_INPUT', 'book');
  await refused(h.call('GET', `/finance/imports?book=${CI}&purpose=everything`), 400, 'FIN_BAD_INPUT', 'purpose');
  // The parallel run: a month-end import, seen; nothing else.
  const parallel = (await ok(listOf(CI, 'parallel_tb'))).imports[0];
  await refused(h.call('GET', `/finance/reports/parallel-run?import=${parallel.id}`, null, 'dpOnly'), 404, 'FIN_NOT_FOUND');
  await refused(h.call('GET', '/finance/reports/parallel-run'), 400, 'FIN_BAD_INPUT', 'import');
  await refused(h.call('GET', `/finance/reports/parallel-run?import=${imp.id}`), 400, 'FIN_BAD_INPUT', 'import');
});

test('the date an import is as at: the day before the books begin for an opening, from the books\' first day for a month end (ruling R34)', gate, async () => {
  const early = await refusedAndNothingWritten(upload(opening(DP, { as_at: '2026-12-30' })), 400, 'FIN_BAD_DATE', 'as_at');
  assert.match(early.body.error, /2026-12-31/);
  await refusedAndNothingWritten(upload(opening(DP, { as_at: '2027-01-31' })), 400, 'FIN_BAD_DATE', 'as_at');
  const parallel = as_at => upload({ book_id: CI, purpose: 'parallel_tb', as_at, tb: [tb('Alpha Bank', 1, 0)] });
  const before = await refusedAndNothingWritten(parallel('2026-12-31'), 400, 'FIN_BAD_DATE', 'as_at');
  assert.match(before.body.error, /2027-01-01/);
  // The first day the books keep is a month end's earliest date; the last day of the book's last financial year its latest.
  assert.equal((await ok(parallel('2027-01-01'))).import.as_at, '2027-01-01');
  assert.equal((await ok(parallel('2027-03-31'))).import.as_at, '2027-03-31');
  const beyond = await refusedAndNothingWritten(parallel('2027-04-30'), 409, 'FIN_NO_PERIOD', 'as_at');
  assert.match(beyond.body.error, /No financial year covers 2027-04-30/);
  for (const bad of ['2027-02-30', '31-01-2027', '', null]) await refusedAndNothingWritten(parallel(bad), 400, 'FIN_BAD_DATE', 'as_at');
  await refusedAndNothingWritten(upload({ ...opening(DP), purpose: 'closing' }), 400, 'FIN_BAD_INPUT', 'purpose');
});

test('what an upload refuses, before it writes anything', gate, async () => {
  const bad = (body, status, code, field) => refusedAndNothingWritten(upload(body), status, code, field);
  // the same name twice in one list (ruling R36), in any capitals or spacing
  const twice = await bad(opening(DP, { accounts: [...ACCOUNTS, { tally_name: 'alpha  bank.', tally_group: 'Bank Accounts' }] }), 400, 'FIN_BAD_INPUT', 'accounts[7].tally_name');
  assert.match(twice.body.error, /alpha bank\./);
  await bad(opening(DP, { tb: [...TB, tb('ALPHA BANK', 1, 0)] }), 400, 'FIN_BAD_INPUT', 'tb[7].tally_name');
  // a bill whose side says the other thing than its amount (ruling R38)
  await bad(opening(DP, { bills: [{ ...BILLS[0], side: 'cr' }] }), 400, 'FIN_BAD_INPUT', 'bills[0].side');
  await bad(opening(DP, { bills: [{ ...BILLS[0], amount_paise: -BILLS[0].amount_paise }] }), 400, 'FIN_BAD_INPUT', 'bills[0].side');
  await bad(opening(DP, { bills: [{ ...BILLS[0], bill_date: '2026-02-30' }] }), 400, 'FIN_BAD_DATE', 'bills[0].bill_date');
  // amounts are whole paise
  await bad(opening(DP, { tb: [tb('Alpha Bank', 0.005, 0)] }), 400, 'FIN_BAD_AMOUNT', 'tb[0].debit_paise');
  await bad(opening(DP, { tb: [{ tally_name: 'Alpha Bank', debit_paise: -100, credit_paise: 0 }] }), 400, 'FIN_BAD_AMOUNT', 'tb[0].debit_paise');
  await bad(opening(DP, { tb: [{ tally_name: 'Alpha Bank', debit_paise: '100', credit_paise: 0 }] }), 400, 'FIN_BAD_AMOUNT', 'tb[0].debit_paise');
  await bad(opening(DP, { bills: [{ ...BILLS[0], amount_paise: 1e14 }] }), 400, 'FIN_BAD_AMOUNT', 'bills[0].amount_paise');
  // names
  await bad(opening(DP, { accounts: [{ tally_name: '   ', tally_group: 'Bank Accounts' }] }), 400, 'FIN_BAD_INPUT', 'accounts[0].tally_name');
  await bad(opening(DP, { accounts: [{ tally_name: 'Alpha\u0000Bank', tally_group: 'Bank Accounts' }] }), 400, 'FIN_BAD_INPUT', 'accounts[0].tally_name');
  await bad(opening(DP, { accounts: [{ tally_name: 'x'.repeat(256), tally_group: 'Bank Accounts' }] }), 400, 'FIN_BAD_INPUT', 'accounts[0].tally_name');
  // what each kind of import is made of
  await bad(opening(DP, { accounts: [] }), 400, 'FIN_BAD_INPUT', 'accounts');
  await bad(opening(DP, { tb: 'all of it' }), 400, 'FIN_BAD_INPUT', 'tb');
  await bad({ book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', tb: TB, bills: BILLS }, 400, 'FIN_BAD_INPUT', 'bills');
  await bad({ book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', tb: TB, accounts: ACCOUNTS }, 400, 'FIN_BAD_INPUT', 'accounts');
  await bad(opening(DP, { file_names: 'tb.xlsx' }), 400, 'FIN_BAD_INPUT', 'file_names');
  await bad(opening(DP, { book_id: undefined }), 400, 'FIN_BAD_INPUT', 'book_id');
  // each row under ₹1 lakh crore, and together past what a double adds exactly (2^53 paise): the totals would drift
  const huge = Array.from({ length: 91 }, (_, i) => ({ tally_name: `Big ${i}`, debit_paise: 1e14 - 1, credit_paise: 0 }));
  await bad(opening(DP, { tb: huge }), 400, 'FIN_BAD_AMOUNT', 'tb');
});

test('a Tally upload far past the usual 100KB of JSON is read, and so is its confirmation; the row counts are the guard (rulings R35, R41)', gate, async () => {
  const many = n => Array.from({ length: n }, (_, i) => tb(`Ledger ${String(i).padStart(5, '0')}`, i % 2 ? 0 : 1, i % 2 ? 1 : 0));
  const big = { book_id: CI, purpose: 'parallel_tb', as_at: '2027-02-28', file_names: ['tb-feb.xlsx'], tb: many(4000) };
  assert.ok(JSON.stringify(big).length > 200 * 1024, 'non-vacuous: the body is past the default ceiling');
  const up = await ok(upload(big));
  assert.deepEqual([up.ledgers.length, up.import.summary.ledger_rows], [4000, 4000]);
  assert.deepEqual(up.ledgers.map(r => r.match_status).filter(s => s !== 'unmatched'), [], 'none of them is a Finance ledger');
  // The confirmation lists every row again (ruling R33), so it is as far past the ceiling, and it goes through the same app.
  const matches = up.ledgers.map(r => ({ row_id: r.id, action: 'unmatched' }));
  assert.ok(JSON.stringify({ matches }).length > 100 * 1024, 'non-vacuous: the confirmation is past the default ceiling too');
  assert.equal((await ok(putMatches(up.import.id, matches))).import.status, 'matched');
  await refusedAndNothingWritten(upload({ ...big, tb: many(10001) }), 400, 'FIN_BAD_INPUT', 'tb');
  await refusedAndNothingWritten(upload({ ...opening(DP), accounts: Array.from({ length: 5001 }, (_, i) => ({ tally_name: `A${i}`, tally_group: 'Bank Accounts' })) }), 400, 'FIN_BAD_INPUT', 'accounts');
  await refusedAndNothingWritten(upload({ ...opening(DP), bills: Array.from({ length: 5001 }, () => BILLS[0]) }), 400, 'FIN_BAD_INPUT', 'bills');
});

test('matches: every row confirmed once, ids of the import\'s own book, one Finance ledger for one Tally row (ruling R33)', gate, async () => {
  const up = await ok(upload(opening(DP, { file_names: ['tb.xlsx', 'accounts.xlsx', 'bills.xlsx'] })));
  const id = up.import.id;
  assert.deepEqual(up.import.file_names, ['tb.xlsx', 'accounts.xlsx', 'bills.xlsx']);
  assert.equal(up.import.status, 'draft');
  // Nothing is matched silently: no build until the accountant has confirmed the matches.
  const early = await refusedAndNothingWritten(build(id), 409, 'FIN_BAD_INPUT');
  assert.match(early.body.error, /confirm/i);

  const all = confirmAll(up.ledgers);
  const at = name => all.findIndex(m => up.ledgers.find(r => r.id === m.row_id).tally_name === name);
  const cash = all[at('Cash')];
  const ciCash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [CI])).id;
  const ciBank = (await h.db.one(`SELECT group_id FROM fin_ledgers WHERE book_id = $1 AND name = 'Alpha Bank'`, [CI])).group_id;
  const swap = (name, m) => all.map((x, i) => (i === at(name) ? { row_id: x.row_id, ...m } : x));
  const bad = (matches, status, code, field) => refusedAndNothingWritten(putMatches(id, matches), status, code, field);

  await bad(all.slice(1), 400, 'FIN_BAD_INPUT', 'matches');
  await bad([...all, all[0]], 400, 'FIN_BAD_INPUT', 'matches[7].row_id');
  await bad(swap('Alpha Bank', { row_id: 999999, action: 'unmatched' }), 400, 'FIN_BAD_INPUT', 'matches[1].row_id');
  await bad('all of them', 400, 'FIN_BAD_INPUT', 'matches');
  await bad(swap('Alpha Bank', { action: 'ignore' }), 400, 'FIN_BAD_INPUT', `matches[${at('Alpha Bank')}].action`);
  await bad(swap('Alpha Bank', { action: 'match' }), 400, 'FIN_BAD_INPUT', `matches[${at('Alpha Bank')}].ledger_id`);
  await bad(swap('Alpha Bank', { action: 'match', ledger_id: ciCash }), 400, 'FIN_BAD_INPUT', `matches[${at('Alpha Bank')}].ledger_id`);
  await bad(swap('Alpha Bank', { action: 'create', group_id: ciBank }), 400, 'FIN_BAD_INPUT', `matches[${at('Alpha Bank')}].group_id`);
  await bad(swap('Cash', { ...cash, group_id: all[at('Alpha Bank')].group_id }), 400, 'FIN_BAD_INPUT', `matches[${at('Cash')}].group_id`);
  await bad(swap('Acme Pharma Ltd', { ...all[at('Acme Pharma Ltd')], party_id: null }), 400, 'FIN_BAD_INPUT', `matches[${at('Acme Pharma Ltd')}].party_id`);
  await bad(swap('Acme Pharma Ltd', { ...all[at('Acme Pharma Ltd')], party_id: 999999 }), 400, 'FIN_BAD_INPUT', `matches[${at('Acme Pharma Ltd')}].party_id`);
  // Two Tally rows on one Finance ledger, and the refusal says which.
  const two = await bad(swap('Alpha Bank', { action: 'match', ledger_id: cash.ledger_id }), 400, 'FIN_BAD_INPUT', 'matches');
  assert.match(two.body.error, /Alpha Bank and Cash both point at Cash/);
  // A new ledger of a name the book has, as names are compared (capitals, spaces and a closing dot aside), would fail at
  // the build or sit beside the other as its near twin (M13): it is refused now, naming both.
  assert.equal(cash.ledger_id, (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [DP])).id, 'DP\'s own Cash');
  const named = await bad(swap('Cash', { action: 'create', group_id: all[at('Alpha Bank')].group_id }), 400, 'FIN_BAD_INPUT', `matches[${at('Cash')}].action`);
  assert.match(named.body.error, /^Cash would make a ledger of the same name as Cash, which this book has/);
  const cashGroup = (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Cash-in-Hand'`, [DP])).id;
  const near = await ok(upload(opening(DP, { bills: [],
    accounts: [{ tally_name: 'Cash.', tally_group: 'Cash-in-Hand' }, { tally_name: 'Proprietor Capital A/c', tally_group: 'Capital Account' }],
    tb: [tb('Cash.', 100, 0), tb('Proprietor Capital A/c', 0, 100)] })));
  const dotted = near.ledgers.find(r => r.tally_name === 'Cash.');
  assert.deepEqual([dotted.match_status, dotted.ledger_name], ['matched', 'Cash'], 'a closing dot makes no difference to a match');
  const twin = await refusedAndNothingWritten(putMatches(near.import.id, confirmAll(near.ledgers).map(m => (m.row_id === dotted.id
    ? { row_id: m.row_id, action: 'create', group_id: cashGroup } : m))), 400, 'FIN_BAD_INPUT', 'matches[0].action');
  assert.match(twin.body.error, /^Cash\. would make a ledger of the same name as Cash, which this book has/);

  const confirmed = await ok(putMatches(id, all));
  assert.equal(confirmed.import.status, 'matched');
  assert.deepEqual(confirmed.ledgers.map(r => r.match_status), up.ledgers.map(r => r.match_status));
  // A month-end comparison makes no ledgers.
  const jan = await ok(upload({ book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', tb: [tb('Petty Cash Box', 1, 0), tb('Cash', 0, 1)] }));
  const petty = jan.ledgers.find(r => r.tally_name === 'Petty Cash Box');
  await refusedAndNothingWritten(putMatches(jan.import.id, jan.ledgers.map(r => (r === petty
    ? { row_id: r.id, action: 'create', group_id: ciBank } : { row_id: r.id, action: 'match', ledger_id: r.ledger_id }))), 400, 'FIN_BAD_INPUT', 'matches[0].action');
});

test('bills: a zero bill is counted and left, a bill naming no ledger is a problem, bills on a non-party ledger a warning (ruling R38)', gate, async () => {
  const bills = [...BILLS,
    { tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-0', bill_date: null, due_date: null, amount_paise: 0, side: null },
    { tally_ledger_name: 'Ghost Traders', bill_ref: 'GT-1', bill_date: '2026-12-02', due_date: null, amount_paise: 7000 * R, side: 'dr' },
    { tally_ledger_name: 'Alpha Bank', bill_ref: 'CHQ-1', bill_date: null, due_date: null, amount_paise: 500000 * R, side: 'dr' }];
  const up = await ok(upload(opening(DP, { bills })));
  assert.equal(up.import.summary.zero_bills, 1);
  assert.deepEqual(up.bills.map(b => [b.tally_ledger_name, b.bill_ref, b.amount_paise, b.side]), [
    ['Acme Pharma Ltd', 'INV-11', 100000 * R, 'dr'], ['Acme Pharma Ltd', 'INV-12', 59000 * R, 'dr'],
    ['Ghost Traders', 'GT-1', 7000 * R, 'dr'], ['Alpha Bank', 'CHQ-1', 500000 * R, 'dr']]);
  assert.deepEqual(up.tie_out.problems.map(p => p.code), ['BILLS_NO_LEDGER']);
  assert.match(up.tie_out.problems[0].message, /^Ghost Traders: 1 bill of ₹7,000\.00 Dr/);
  assert.ok(up.tie_out.warnings.some(w => /^Alpha Bank isn't a party's ledger, so its 1 bill is left out/.test(w)), JSON.stringify(up.tie_out.warnings));
  assert.equal(up.tie_out.ok, false);
});

test('a trial balance row that names no account and no group is listed by name, never dropped (ruling R36)', gate, async () => {
  const up = await ok(upload(opening(DP, { tb: [...TB, tb('Old Suspense', 0, 2500), tb('Grand Total', 659000, 661500)] })));
  assert.deepEqual(up.import.summary.unknown, [{ tally_name: 'Old Suspense', debit_paise: 0, credit_paise: 2500 * R }]);
  assert.equal(up.import.summary.unknown_rows, 1);
  assert.equal(up.import.summary.ignored_rows, 2, 'the group and the grand total');
  assert.deepEqual(up.tie_out.problems.map(p => p.code), ['TB_NOT_IN_ACCOUNTS']);
  assert.ok(!up.ledgers.some(r => r.tally_name === 'Old Suspense'));
});

// Ruling R43: a row is read as a group's total, and left out, when its name is one of the book's groups. When the trial
// balance then fails to balance, the rows left out that carried an amount are named, so the gap can be traced.
test('rows read as groups\' totals are listed with their figures, and named when the trial balance does not balance (ruling R43)', gate, async () => {
  const rows = [...TB.map(r => (r.tally_name === 'Alpha Bank' ? { ...r, debit_paise: r.debit_paise + 1 * R } : r)), tb('Grand Total', 659001, 659000)];
  const up = await ok(upload(opening(DP, { accounts: [...ACCOUNTS, { tally_name: 'Duties & Taxes', tally_group: 'Current Liabilities' }], tb: rows })));
  assert.equal(up.import.summary.ignored_rows, 3, 'the accounts row that is a group, and the two total rows');
  assert.deepEqual(up.import.summary.ignored_with_amounts, [
    { tally_name: 'Current Assets', debit_paise: 659000 * R, credit_paise: 0 },
    { tally_name: 'Grand Total', debit_paise: 659001 * R, credit_paise: 659000 * R },
  ]);
  assert.deepEqual(up.tie_out.problems.map(p => p.code), ['TB_UNBALANCED']);
  assert.ok(up.tie_out.warnings.includes("These rows were read as groups' totals and left out of the trial balance: Current Assets ₹6,59,000.00 Dr; "
    + 'Grand Total debits ₹6,59,001.00, credits ₹6,59,000.00. If one of them is a ledger, its figure is what is missing.'), JSON.stringify(up.tie_out.warnings));
});

// M6: the tie-out a screen shows is the one the build will meet. Whether a row's ledger is a party's is worked out each
// time from the book as it stands, so a group moved since the upload changes both alike.
test('the tie-out is worked out afresh each time: a ledger whose group has moved under Sundry Debtors since the upload is a party\'s now', gate, async () => {
  const groups = Object.fromEntries((await ok(h.call('GET', `/finance/books/${DP}/groups`))).groups.map(g => [g.name, g.id]));
  const sub = (await ok(h.call('POST', '/finance/groups', { book_id: DP, parent_id: groups['Bank Accounts'], name: 'Collection Accounts' }, 'md'))).group;
  await ok(h.call('POST', '/finance/ledgers', { book_id: DP, group_id: sub.id, name: 'Gamma Collections' }, 'acct'));
  const up = await ok(upload(opening(DP, {
    accounts: [...ACCOUNTS, { tally_name: 'Gamma Collections', tally_group: 'Bank Accounts' }],
    tb: [...TB.map(r => (r.tally_name === 'Proprietor Capital A/c' ? tb(r.tally_name, 0, 301000) : r)), tb('Gamma Collections', 1000, 0)],
    bills: [...BILLS, { tally_ledger_name: 'Gamma Collections', bill_ref: 'GC-1', bill_date: null, due_date: null, amount_paise: 600 * R, side: 'dr' }],
  })));
  const gamma = v => v.ledgers.find(r => r.tally_name === 'Gamma Collections');
  assert.deepEqual([gamma(up).match_status, gamma(up).is_party, up.tie_out.ok], ['matched', false, true]);
  assert.ok(up.tie_out.warnings.some(w => w.startsWith("Gamma Collections isn't a party's ledger")), JSON.stringify(up.tie_out.warnings));
  await ok(h.call('PUT', `/finance/groups/${sub.id}`, { parent_id: groups['Sundry Debtors'] }, 'md'));
  const now = await ok(view(up.import.id));
  assert.equal(gamma(now).is_party, true);
  assert.deepEqual(now.tie_out.problems, [{ code: 'BILLS_MISMATCH', message: 'Gamma Collections: bills ₹600.00 Dr, trial balance ₹1,000.00 Dr.' }]);
  await ok(putMatches(up.import.id, confirmAll(now.ledgers)));
  const refusedBuild = await refusedAndNothingWritten(build(up.import.id), 409, 'FIN_TIE_OUT');
  assert.deepEqual(refusedBuild.body.problems, now.tie_out.problems, 'the build meets the very problems the screen shows');
});

test('a build that fails after it made ledgers leaves nothing behind, and the import as it was', gate, async () => {
  // DP gets a bank ledger by hand; the import matches it, then it is switched off before the build. The build makes
  // the other ledgers, writes the voucher and submits it, and the submit refuses: every ledger it made goes too.
  const bank = await ok(h.call('POST', '/finance/ledgers', { book_id: DP, group_id: (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Bank Accounts'`, [DP])).id, name: 'Beta Bank' }, 'acct'));
  const accounts = [...ACCOUNTS.filter(a => a.tally_name !== 'Alpha Bank'), { tally_name: 'Beta Bank', tally_group: 'Bank Accounts' }];
  const rows = TB.map(r => (r.tally_name === 'Alpha Bank' ? { ...r, tally_name: 'Beta Bank' } : r));
  const up = await ok(upload(opening(DP, { accounts, tb: rows })));
  assert.equal(up.ledgers.find(r => r.tally_name === 'Beta Bank').ledger_id, bank.ledger.id);
  await ok(putMatches(up.import.id, confirmAll(up.ledgers)));
  await ok(h.call('PUT', `/finance/ledgers/${bank.ledger.id}`, { active: false }, 'md'));
  const off = await refusedAndNothingWritten(build(up.import.id), 409, 'FIN_LEDGER_INACTIVE');
  assert.match(off.body.error, /Beta Bank/);
  assert.equal((await ok(view(up.import.id))).import.status, 'matched');
  assert.deepEqual((await importAudit(up.import.id)).map(a => a.action), ['upload', 'match']);
  // And while it is off, a confirmation that matches a balance to it is refused there and then.
  await refusedAndNothingWritten(putMatches(up.import.id, confirmAll(up.ledgers)), 409, 'FIN_LEDGER_INACTIVE');
});

test('an Opening voucher waiting for approval holds the book; after a rejection the import stays used, and a new upload builds (ruling R37)', gate, async () => {
  const first = await ok(upload(opening(DP)));
  await ok(putMatches(first.import.id, confirmAll(first.ledgers)));
  const waiting = (await ok(build(first.import.id))).voucher;
  assert.deepEqual([waiting.status, waiting.number, waiting.voucher_date, waiting.book_id], ['submitted', null, '2026-12-31', DP]);
  const bells = await h.db.q(`SELECT user_id FROM notifications WHERE kind = 'fin_approval' AND ref_id = $1 ORDER BY user_id`, [waiting.id]);
  assert.deepEqual(bells.map(b => b.user_id), [h.users.md.id], 'DP\'s approver is told');
  assert.deepEqual((await ok(view(first.import.id))).import.status, 'used');
  await refusedAndNothingWritten(build(first.import.id), 409, 'FIN_BAD_INPUT');
  await refusedAndNothingWritten(putMatches(first.import.id, confirmAll(first.ledgers)), 409, 'FIN_BAD_INPUT');

  const second = await ok(upload(opening(DP)));
  assert.deepEqual(second.ledgers.map(r => r.match_status), ACCOUNTS.map(() => 'matched'), 'the first build made the ledgers');
  await ok(putMatches(second.import.id, confirmAll(second.ledgers)));
  const held = await refusedAndNothingWritten(build(second.import.id), 409, 'FIN_OPENING_EXISTS');
  assert.match(held.body.error, /waiting for approval/);

  // The MD sends the waiting one back. The import that built it stays used; the accountant uploads again.
  await ok(h.call('POST', `/finance/vouchers/${waiting.id}/reject`, { reason: 'figures to be rechecked' }, 'md'));
  await refusedAndNothingWritten(build(first.import.id), 409, 'FIN_BAD_INPUT');
  const rebuilt = (await ok(build(second.import.id))).voucher;
  assert.deepEqual([rebuilt.status, rebuilt.voucher_type], ['submitted', 'opening']);
  assert.notEqual(rebuilt.id, waiting.id);
  // …and the one sent back cannot be sent again beside it (final review M-5): a submit asks what a build asks, through one helper
  const resent = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${waiting.id}/submit`, null, 'acct'), 409, 'FIN_OPENING_EXISTS');
  assert.match(resent.body.error, /waiting for approval/);
  assert.equal((await ok(h.call('GET', `/finance/vouchers/${waiting.id}`))).voucher.status, 'draft', 'it stays a draft, its maker\'s to discard');
});

test('the parallel run lists a Tally ledger Finance lacks as unmatched, and a Finance balance Tally lacks as a row (ruling R36)', gate, async () => {
  // Tally's January without Output IGST, and with a Petty Cash Box that Finance has no ledger for.
  const january = [tb('Alpha Bank', 510000, 0), tb('Petty Cash Box', 1000, 0), tb('Acme Pharma Ltd', 149000, 0),
    tb('Proprietor Capital A/c', 0, 300000), tb('Sales @ 5%', 0, 300000), tb('Profit & Loss A/c', 0, 44000)];
  const up = await ok(upload({ book_id: CI, purpose: 'parallel_tb', as_at: '2027-01-31', tb: january }));
  assert.deepEqual(up.ledgers.map(r => [r.tally_name, r.match_status]).filter(([, s]) => s !== 'matched'), [['Petty Cash Box', 'unmatched']]);
  let report = await ok(h.call('GET', `/finance/reports/parallel-run?import=${up.import.id}`));
  assert.deepEqual(report.import, { id: up.import.id, book_id: CI, as_at: '2027-01-31' });
  assert.deepEqual(report.unmatched, [{ tally_name: 'Petty Cash Box', tally_closing_paise: 1000 * R }]);
  const igst = report.rows.find(r => r.ledger_name === 'Output IGST');
  assert.deepEqual([igst.tally_name, igst.tally_closing_paise, igst.finance_closing_paise, igst.difference_paise], [null, 0, -15000 * R, 15000 * R]);
  assert.equal(report.totals.differing, 1);
  assert.ok(!report.rows.some(r => r.ledger_name === 'Cash'), 'a Finance ledger with nothing on it and no Tally row is not listed');
  // The accountant matches the Petty Cash Box row to Cash, and the report compares it.
  const cash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [CI])).id;
  await ok(putMatches(up.import.id, up.ledgers.map(r => (r.tally_name === 'Petty Cash Box'
    ? { row_id: r.id, action: 'match', ledger_id: cash } : { row_id: r.id, action: 'match', ledger_id: r.ledger_id }))));
  report = await ok(h.call('GET', `/finance/reports/parallel-run?import=${up.import.id}`));
  assert.deepEqual(report.unmatched, []);
  const box = report.rows.find(r => r.ledger_id === cash);
  assert.deepEqual([box.ledger_name, box.tally_name, box.tally_closing_paise, box.finance_closing_paise, box.difference_paise], ['Cash', 'Petty Cash Box', 1000 * R, 0, 1000 * R]);
  assert.equal(report.totals.differing, 2);
});

test('party proposals read the GSTIN first, and never offer a customer the book has already linked (ruling R32)', gate, async () => {
  const vendor = (await h.db.one(`INSERT INTO vendors (name, gstin) VALUES ('Zeta Traders', '27AAAAA0000A1Z5') RETURNING id`)).id;
  const customer = (await h.db.one(`INSERT INTO customers (name) VALUES ('Zeta Traders') RETURNING id`)).id;
  await h.db.q(`UPDATE customers SET gstin = '06AAAAA1111A1Z1' WHERE id = $1`, [ACME]);
  // A closed twin of each, by GSTIN and by name: only an active customer or vendor is proposed (M2), so neither makes
  // the proposals below ambiguous.
  await h.db.q(`INSERT INTO vendors (name, gstin, active) VALUES ('Zeta Traders (closed)', '27AAAAA0000A1Z5', 0)`);
  await h.db.q(`INSERT INTO customers (name, active) VALUES ('Zeta Traders', 0)`);
  const accounts = [
    { tally_name: 'Zeta Traders Pvt Ltd', tally_group: 'Sundry Creditors', gstin: '27 aaaaa 0000 a1z5' },
    { tally_name: 'Zeta Traders', tally_group: 'Sundry Debtors', gstin: null },
    { tally_name: 'Acme Second Unit', tally_group: 'Sundry Debtors', gstin: '06AAAAA1111A1Z1' },
  ];
  const up = await ok(upload({ book_id: CI, purpose: 'opening', as_at: '2026-12-31', accounts, tb: [tb('Zeta Traders', 0, 0)] }));
  const of = name => up.ledgers.find(r => r.tally_name === name);
  assert.deepEqual([of('Zeta Traders Pvt Ltd').party_type, of('Zeta Traders Pvt Ltd').party_id, of('Zeta Traders Pvt Ltd').party_name], ['vendor', vendor, 'Zeta Traders']);
  assert.deepEqual([of('Zeta Traders').party_type, of('Zeta Traders').party_id], ['customer', customer]);
  assert.deepEqual([of('Acme Second Unit').match_status, of('Acme Second Unit').party_id], ['create', null], 'Acme is linked to CI\'s Acme Pharma Ltd already');
  // A confirmation that links a party the book has linked would only fail at the build: it is refused now.
  const all = confirmAll(up.ledgers).map(m => (m.row_id === of('Acme Second Unit').id ? { ...m, party_type: 'customer', party_id: ACME } : m));
  const linked = await refusedAndNothingWritten(putMatches(up.import.id, all), 409, 'FIN_PARTY_LINKED');
  assert.match(linked.body.error, /Acme Pharma Ltd/);
  const twice = confirmAll(up.ledgers).map(m => (m.row_id === of('Zeta Traders').id ? { ...m, party_type: 'vendor', party_id: vendor } : m));
  await refusedAndNothingWritten(putMatches(up.import.id, twice), 400, 'FIN_BAD_INPUT', 'matches');
});

test('the staging tables refuse NaN for an amount, as the voucher lines do', gate, async () => {
  const imp = (await h.db.one(`INSERT INTO fin_imports (book_id, purpose, as_at) VALUES ($1, 'parallel_tb', '2027-01-31') RETURNING id`, [CI])).id;
  await assert.rejects(h.db.q(`INSERT INTO fin_import_ledgers (import_id, tally_name, debit) VALUES ($1, 'X', 'NaN')`, [imp]), { constraint: 'fin_import_ledgers_debit_check' });
  await assert.rejects(h.db.q(`INSERT INTO fin_import_ledgers (import_id, tally_name, credit) VALUES ($1, 'X', 'NaN')`, [imp]), { constraint: 'fin_import_ledgers_credit_check' });
  await assert.rejects(h.db.q(`INSERT INTO fin_import_bills (import_id, tally_ledger_name, amount, side) VALUES ($1, 'X', 'NaN', 'dr')`, [imp]), { constraint: 'fin_import_bills_amount_check' });
});

// ── Two people at once ───────────────────────────────────────────────────────────────────────
// Each side is a transaction of its own on a raw client, run the way a route's tx() runs one; where one side waits for
// the other, Postgres says so (pg_stat_activity), never the clock. These come last: they first reverse CI's Opening
// voucher, so that CI can build again.

// qc / oc on a raw client, as db.js tx() hands them over; a transaction run whole; and one left open but for its COMMIT.
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
// What a backend waits on once it waits for a lock ('advisory' is a number series; 'transactionid' or 'tuple' a row
// another transaction holds), or null if it never does. Asked through the pool, outside any transaction.
async function lockWaitOf(pid) {
  for (let i = 0; i < 400; i++) {
    const row = await h.db.one('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (row?.wait_event_type === 'Lock') return row.wait_event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}

// A CI opening import, uploaded and confirmed through the API. Its id.
async function confirmedCiOpening() {
  const up = await ok(upload(opening(CI)));
  await ok(putMatches(up.import.id, confirmAll(up.ledgers)));
  return up.import.id;
}

// Ruling R42. An Opening voucher reversed later than its own date would stay in the books until then, beside the one
// rebuilt in its place, and every balance as at 31 Dec would count the opening twice (spec §11.2 step 5).
test('an Opening voucher is reversed as at its own date: none is given, it is that date; any other is refused (ruling R42)', gate, async () => {
  const posted = (await firstCiOpening()).opening_voucher_id;
  const reverse = body => h.call('POST', `/finance/vouchers/${posted}/reverse`, body, 'md');
  for (const date of ['2027-02-10', '2027-01-01', '2026-12-30']) {
    const late = await refusedAndNothingWritten(reverse({ date, reason: 'rebuilt from Tally' }), 409, 'FIN_BAD_DATE', 'date');
    assert.match(late.body.error, /^The Opening voucher is reversed as at its own date, 2026-12-31/, date);
  }
  const back = (await ok(reverse({ reason: 'rebuilt from Tally' }))).voucher;
  assert.deepEqual([back.status, back.voucher_date, back.reversal_of_id, back.self_approved], ['posted', '2026-12-31', posted, true]);
  // …and that reversal is never reversed itself (ruling R45): a new opening is built instead, as the races below do.
  const undo = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${back.id}/reverse`, { reason: 'put it back' }, 'md'), 409, 'FIN_BAD_REVERSAL');
  assert.match(undo.body.error, /Build a new opening from the Tally import instead\.$/);
  const tb = await ok(h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`));
  assert.deepEqual([tb.totals.closing_dr, tb.totals.closing_cr], [0, 0], 'as at its date, the books hold no opening at all');
});

// Before ruling R42 the books would take a reversal of the Opening voucher dated later. Such a pair can no longer be
// made (the posting check refuses it at COMMIT), so it is planted here with the hard stops off, as one made before the
// rule would stand. The build must not read it as gone: until its reversal's date it is still the books' opening.
test('an Opening voucher reversed only from a later date still holds its book: no second one is built (ruling R42)', gate, async () => {
  const waiting = await h.db.one(`SELECT id FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'submitted'`, [DP]);
  const ob = (await ok(h.call('POST', `/finance/vouchers/${waiting.id}/approve`, null, 'md'))).voucher;
  assert.equal(ob.number, 'DP-OB-2627-0001');
  await h.db.tx(async (qc, oc) => {
    await qc('SET LOCAL session_replication_role = replica');
    const late = await oc(
      `INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, period_id, status, number, total, reversal_of_id, posted_at, narration)
       SELECT o.book_id, 'journal', '2027-02-10', p.id, 'posted', 'DP-JV-2627-0900', o.total, o.id, now(), 'reversed late, before ruling R42'
         FROM fin_vouchers o JOIN fin_periods p ON p.book_id = o.book_id AND p.start_date = '2027-02-01'
        WHERE o.id = $1 RETURNING id`, [ob.id]);
    await qc(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit)
              SELECT $1, book_id, line_no, ledger_id, credit, debit FROM fin_voucher_lines WHERE voucher_id = $2`, [late.id, ob.id]);
    await qc('UPDATE fin_vouchers SET reversed_by_id = $1 WHERE id = $2', [late.id, ob.id]);
  });
  const up = await ok(upload(opening(DP)));
  await ok(putMatches(up.import.id, confirmAll(up.ledgers)));
  const held = await refusedAndNothingWritten(build(up.import.id), 409, 'FIN_OPENING_EXISTS');
  assert.match(held.body.error, /DP-OB-2627-0001/);
  // the opening sent back earlier (the test above) cannot go in beside it either, and is told the same
  const old = await h.db.one(`SELECT id FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'draft' ORDER BY id LIMIT 1`, [DP]);
  const resent = await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${old.id}/submit`, null, 'acct'), 409, 'FIN_OPENING_EXISTS');
  assert.match(resent.body.error, /DP-OB-2627-0001/);
  // an Approver's own resubmit is no exception: it would post a second opening at once
  await h.db.q('UPDATE fin_vouchers SET created_by_id = $2 WHERE id = $1', [old.id, h.users.md.id]);
  await refusedAndNothingWritten(h.call('POST', `/finance/vouchers/${old.id}/submit`, null, 'md'), 409, 'FIN_OPENING_EXISTS');
  await h.db.q('UPDATE fin_vouchers SET created_by_id = $2 WHERE id = $1', [old.id, h.users.acct.id]);
});

// Final review M-5: the ONE check for "a live or pending opening" is finLiveOpeningProblem, and both doors use it.
test('a build and a submit ask the one helper whether the book already holds an opening', () => {
  const code = rel => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const imports = code('./finance-import.js');
  const vouchers = code('./finance-vouchers.js');
  assert.match(vouchers, /export async function finLiveOpeningProblem\(/);
  assert.match(imports, /await finLiveOpeningProblem\(oc, imp\.book_id, day, \{ doing: 'build' \}\)/);
  assert.match(vouchers, /if \(v\.voucher_type === 'opening'\) \{\s*const held = await finLiveOpeningProblem\(oc, v\.book_id, v\.voucher_date, \{ except: v\.id, doing: 'submit' \}\);/);
  for (const src of [imports, vouchers]) assert.equal((src.match(/reversed_by_id AND r\.status = 'posted' AND r\.voucher_date = o\.voucher_date/g) || []).length, src === vouchers ? 1 : 0);
});

test('two builds of one import at once: the second waits at the number series, then finds the import used', gate, async () => {
  const { finBuildOpening } = await import('./finance-import.js');
  c1 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c1.connect();
  await c2.connect();
  pid2 = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  // CI's Opening voucher was reversed, as at its own date, by the test above: the book may build one again.
  const id = await confirmedCiOpening();
  const ACCT = { id: h.users.acct.id, name: 'Test Accountant', roles: ['accountant'] };
  const first = await opened(c1);
  let second;
  try {
    const mine = await finBuildOpening(first.qc, first.oc, id, ACCT);   // all but the COMMIT
    assert.equal(mine.status, 'submitted');
    second = inTx(c2, (qc, oc) => finBuildOpening(qc, oc, id, ACCT));
    second.catch(() => {});
    assert.equal(await lockWaitOf(pid2), 'advisory', 'the second waits at the number series, holding nothing');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_BAD_INPUT' && /already/.test(e.message));
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  const built = await h.db.q(`SELECT id FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'submitted'`, [CI]);
  assert.equal(built.length, 1, 'one Opening voucher');
  assert.deepEqual((await importAudit(id)).map(a => a.action), ['upload', 'match', 'build']);
  // Sent back, so that the race below can build once more.
  await ok(h.call('POST', `/finance/vouchers/${built[0].id}/reject`, { reason: 'one more race to run' }, 'md'));
});

test('a confirmation that comes while a build holds the import waits for it, then is refused: the import is used', gate, async () => {
  const { finBuildOpening, finSaveMatches } = await import('./finance-import.js');
  const id = await confirmedCiOpening();
  const rows = (await ok(view(id))).ledgers;
  const ACCT = { id: h.users.acct.id, name: 'Test Accountant', roles: ['accountant'] };
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await finBuildOpening(first.qc, first.oc, id, ACCT)).status, 'submitted');
    second = inTx(c2, (qc, oc) => finSaveMatches(qc, oc, id, confirmAll(rows), ACCT));
    second.catch(() => {});
    assert.ok(['transactionid', 'tuple'].includes(await lockWaitOf(pid2)), 'the confirmation waits on the import the build holds');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_BAD_INPUT' && /upload the files again/i.test(e.message));
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  assert.deepEqual((await importAudit(id)).map(a => a.action), ['upload', 'match', 'build'], 'the refused confirmation wrote nothing');
});

// M11. The MD imports as the book's admin and approves as its Approver, so the Opening voucher the MD builds needs nobody
// else: it posts the moment it is submitted, approved by its maker, as any entry an Approver submits (spec §7.3).
test('an Approver who builds the Opening voucher posts it at once, self-approved', gate, async () => {
  const waiting = await h.db.one(`SELECT id FROM fin_vouchers WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'submitted'`, [CI]);
  await ok(h.call('POST', `/finance/vouchers/${waiting.id}/reject`, { reason: 'the MD builds it' }, 'md'));
  const up = await ok(upload(opening(CI), 'md'));
  await ok(putMatches(up.import.id, confirmAll(up.ledgers), 'md'));
  const v = (await ok(build(up.import.id, 'md'))).voucher;
  assert.deepEqual([v.status, v.number, v.self_approved, v.created_by, v.approved_by, v.posted_by],
    ['posted', 'CI-OB-2627-0002', true, 'Test MD', 'Test MD', 'Test MD']);
  assert.equal((await ok(view(up.import.id))).import.status, 'used');
  const tb = await ok(h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2026-12-31`));
  assert.deepEqual([tb.totals.closing_dr, tb.totals.closing_cr], [659000 * R, 659000 * R], 'one opening in the books as at its date');
});
