// The ERP's older doors, pointed at Finance on and after the switch date (Cash & Bank spec §11 rows 4 to 6; plan Task 16). The pages are
// JSX, which node cannot load, so they are held to the spec by their source; the pure half (client/src/lib/finance/doors.js) is tested as
// code. One FINANCE_PG case holds the vendor payment number: CI-VP-, on a counter of its own beside HR's CI-PAY-:
//   cd server && FINANCE_PG=1 node --test src/finance-erp-doors.test.js
// Every name and figure is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { finBootPg } from './finance-pg-harness.js';
import { MINTING_POSTS } from '../../client/src/lib/writeOnce.js';
import { finDoorsOpen, finBookOfEntity, finMayReceive } from '../../client/src/lib/finance/doors.js';

const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };
const CLIENT = new URL('../../client/src/', import.meta.url);
const read = path => readFileSync(new URL(path, CLIENT), 'utf8');
const SERVER = new URL('./', import.meta.url);
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const INVOICES = read('pages/Invoices.jsx');
const BOOKS = read('components/AccountsBooks.jsx');

test('the doors open on the switch date and after, never before, and never on a bad answer', () => {
  assert.equal(finDoorsOpen('2027-01-01', '2026-12-31'), false);
  assert.equal(finDoorsOpen('2027-01-01', '2027-01-01'), true);
  assert.equal(finDoorsOpen('2027-01-01', '2027-03-15'), true);
  for (const bad of [null, undefined, '', 'soon', '1-Jan-27', 20270101]) assert.equal(finDoorsOpen(bad, '2030-01-01'), false);
  assert.equal(finDoorsOpen('2027-01-01', undefined), false);
});

test('an invoice\'s book is the book of its billing entity; Accountant or Approver may receive, a Viewer or Admin alone may not', () => {
  const books = [
    { id: 1, code: 'CI', billing_entity_id: 11, roles: ['accountant'] },
    { id: 2, code: 'DP', billing_entity_id: 12, roles: ['viewer'] },
    { id: 3, code: 'ZZ', billing_entity_id: 13, roles: ['admin'] },
    { id: 4, code: 'YY', billing_entity_id: 14, roles: ['approver', 'admin'] },
  ];
  assert.equal(finBookOfEntity(books, 12).code, 'DP');
  assert.equal(finBookOfEntity(books, '12').code, 'DP');
  assert.equal(finBookOfEntity(books, 99), null);
  assert.equal(finBookOfEntity(null, 11), null);
  assert.equal(finMayReceive(books, 11), true);
  assert.equal(finMayReceive(books, 12), false);
  assert.equal(finMayReceive(books, 13), false);
  assert.equal(finMayReceive(books, 14), true);
  assert.equal(finMayReceive(books, 99), false);
  assert.equal(finMayReceive([], null), false);
});

test('Invoices reads the switch date once and sends Record Payment to Finance on and after it', () => {
  const src = code(INVOICES);
  assert.equal(src.split("'/finance/cash/switch'").length - 1, 1, 'asked once');
  assert.match(src, /api\.get\('\/finance\/me'\)/);
  assert.match(src, /Receipts are recorded in Finance/);
  assert.match(src, /\/finance\/cash\?receive_customer=\$\{/);
  assert.match(src, /finDoorsOpen\(/);
  assert.match(src, /finMayReceive\(/);
  // Before the date the old form and its save stay as they were.
  assert.match(src, /api\.post\('\/payments'/);
  assert.match(src, /Save Receipt/);
});

test('Accounts books read the switch date once; the three tabs carry the notice and the vendor button goes to Finance', () => {
  const src = code(BOOKS);
  assert.equal(src.split("'/finance/cash/switch'").length - 1, 1, 'asked once');
  assert.match(src, /These books are kept in Finance from 1 January 2027/);
  assert.match(src, /to="\/finance\/cash"/);
  assert.match(src, /\/finance\/cash\?pay_vendor=\$\{/);
  for (const tab of ['cashbook', 'ledger', 'payables']) assert.match(src, new RegExp(`'${tab}'`));
  assert.match(src, /finDoorsOpen\(/);
  // Before the date the old vendor payment form and its save stay as they were.
  assert.match(src, /api\.post\('\/vendor-payments'/);
  // Ruling R63: the Record Receipt button is the same door as Invoices' Record Payment, through the same helper.
  assert.match(src, /api\.get\('\/finance\/me'\)/);
  assert.match(src, /finMayReceive\(/);
  assert.match(src, /Receipts are recorded in Finance/);
  assert.match(src, /\/finance\/cash\?receive_customer=\$\{/);
  assert.match(src, /api\.post\('\/payments'/, 'before the date the old receipt form stays');
});

test('the vendor payment series is CI-VP-, and the write-once guard still lists the route', () => {
  const accounts = code(readFileSync(new URL('./routes/accounts.js', SERVER), 'utf8'));
  assert.match(accounts, /const PAY_PREFIX = 'CI-VP-';/);
  assert.doesNotMatch(accounts, /CI-PAY-/);
  assert.ok(MINTING_POSTS.includes('/vendor-payments'));
});

test('POST /vendor-payments numbers the first one CI-VP-0001 while HR batches hold CI-PAY-0001…', gate, async () => {
  const h = await finBootPg('erp-doors');
  try {
    // HR's own counter: a confirmed batch already numbered CI-PAY-0001 and CI-PAY-0002.
    const run = (await h.db.one(`INSERT INTO hr.runs (month, status, days_in_month, finalised_at) VALUES ('2026-12', 'finalised', 31, now()) RETURNING id`)).id;
    for (const [n, ch] of [['CI-PAY-0001', 'BANK'], ['CI-PAY-0002', 'CASH']]) {
      await h.db.q(`INSERT INTO hr.payment_batches (run_id, pay_channel, count, total, status, paid_on, batch_no)
                    VALUES ($1, $2, 0, 0, 'confirmed', '2026-12-30', $3)`, [run, ch, n]);
    }
    const vendor = await h.db.one(`INSERT INTO vendors (name) VALUES ('Larch Test Supplies') RETURNING id`);
    const first = await h.call('POST', '/vendor-payments', { vendor_id: vendor.id, amount: 1500, mode: 'neft', paid_on: '2026-12-30' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.payment_number, 'CI-VP-0001');
    const second = await h.call('POST', '/vendor-payments', { vendor_id: vendor.id, amount: 700, mode: 'upi', paid_on: '2026-12-30' });
    assert.equal(second.body.payment_number, 'CI-VP-0002');
    const hr = await h.db.q(`SELECT batch_no FROM hr.payment_batches ORDER BY batch_no`);
    assert.deepEqual(hr.map(r => r.batch_no), ['CI-PAY-0001', 'CI-PAY-0002'], 'HR\'s counter is untouched');
  } finally { await h.close(); }
});
