import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { finBootPg, FIN_TEST_GRANTS } from './finance-pg-harness.js';
import { finHrFixtures } from './finance-hr-fixtures.js';
import { plantDateStr } from './plant-calendar.js';

// HR's money doors, wired to Finance (Cash & Bank spec §7.1, §7.3, §7.7, §11 items 2 and 3; plan Task 12). Each door takes where the
// money came from (or went into) as one code of Finance's "paid from" list, stores it on HR's own row, and after HR's commit names the
// rows it made to the HR feed (finHrAfter), which books them. HR answers its client as it always has, whatever Finance makes of it.
// Opt-in, because it boots its own Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-hr-wiring.test.js
//
// The doors are driven through the real app, by the logins HR knows (hr.access): the MD an HR admin, the accountant at HR's accounts
// level (a restricted login), a second approver, and an HR viewer. HR's routes date what they write by the plant's today and refuse a
// payment dated after it, so here the books begin on the first of the current month: the rows HR writes today fall inside the books, and
// Finance books them. (In production the books begin on 1 January 2027, and HR's earlier rows are the Tally opening's.) The tests share
// one boot and run in order. Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee
const TODAY = plantDateStr();
const MONTH = TODAY.slice(0, 7);
const nextMonth = m => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const NEXT = nextMonth(MONTH);
const BEGIN = `${MONTH}-01`;
const MONTH_WORDS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON = MONTH_WORDS[Number(MONTH.slice(5, 7)) - 1];
const MONTH_END = (() => { const [y, m] = MONTH.split('-').map(Number); return `${MONTH}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; })();
const WHY = 'Choose where it was paid from';

let h, feed, fx, CI, DP, noBooks, noAccounts, far, farRun;
const L = {};    // CI ledger name -> id
const D = {};    // DP ledger name -> id
const GROUPS = {};
let OFFICE, HOLDER_A, BANK, SPARE_BANK;   // paid-from codes, fin:<ledger id>

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
  const body = await ok(h.call('POST', '/finance/ledgers', { book_id: book, group_id: groupOf(book, group), name, ...extra }, 'md'));
  (book === CI ? L : D)[name] = body.ledger.id;
  return body.ledger;
};
const saveSetup = body => ok(h.call('PUT', '/finance/hr-setup', body, 'md'));
const voucherRow = id => h.db.one(
  `SELECT id, book_id, voucher_type, voucher_date, narration, reference, status, source_type, source_id, created_by, reversal_of_id,
          reversed_by_id FROM fin_vouchers WHERE id = $1`, [id]);
// A voucher's lines as [ledger name, debit paise, credit paise], in line order.
const linesOf = async id => (await h.db.q(
  `SELECT fl.name, l.debit, l.credit FROM fin_voucher_lines l JOIN fin_ledgers fl ON fl.id = l.ledger_id WHERE l.voucher_id = $1 ORDER BY l.line_no`,
  [id])).map(l => [l.name, Math.round(l.debit * R), Math.round(l.credit * R)]);
// Every voucher a source has, whatever its status.
const vouchersOf = (sourceType, sourceId) => h.db.q(
  'SELECT id, status, reversed_by_id FROM fin_vouchers WHERE source_type = $1 AND source_id = $2 ORDER BY id', [sourceType, sourceId]);
const exceptionOf = (sourceType, sourceId) => h.db.one(
  'SELECT reason_code, reason, resolved_at FROM fin_hr_exceptions WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId]);
const count = async (table, where = 'true', params = []) => (await h.db.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params)).n;
const hrAudits = () => count('hr.audit_log');
// What Finance holds, row for row: a request that books nothing leaves it as it was.
const financeState = async () => JSON.stringify({
  vouchers: await h.db.q('SELECT id, status, reversed_by_id FROM fin_vouchers ORDER BY id'),
  lines: await count('fin_voucher_lines'),
  audit: await count('fin_audit_log'),
  exceptions: await h.db.q('SELECT id, reason_code, resolved_at, last_tried_at FROM fin_hr_exceptions ORDER BY id'),
  covers: await count('fin_hr_covers'),
});
// What the feed logs while `fn` runs: its lines only ("[finance-hr] …"); anything else is passed on.
async function feedLog(fn) {
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => {
    const line = args.join(' ');
    if (line.startsWith('[finance-hr]')) logged.push(line); else warn(...args);
  };
  try { await fn(); } finally { console.warn = warn; }
  return logged;
}
// How many live entries book an HR row: one standing for its own event, plus each live entry whose cover list holds it (ruling R29).
const bookedTimes = async (sourceType, sourceId) => (await h.db.one(
  `SELECT ((SELECT count(*) FROM fin_vouchers v WHERE v.source_type IN ($1, $1 || ':DP') AND v.source_id = $2
              AND v.status IN ('submitted', 'posted') AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL)
         + (SELECT count(*) FROM fin_hr_covers c JOIN fin_vouchers v ON v.id = c.voucher_id
             WHERE c.source_type = $1 AND c.source_id = $2
               AND v.status IN ('submitted', 'posted') AND v.reversed_by_id IS NULL AND v.reversal_of_id IS NULL))::int AS n`,
  [sourceType, sourceId])).n;
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
// A payroll month far ahead, approved by fixture (hr.runs approved, its lines approved for payment), whose lines the R47 and R44a
// tests pay: an approved month is no open one (firstOpenMonth), so nothing else here sees it.
const FAR = shiftMonth(MONTH, 6);
const FAR_MON = MONTH_WORDS[Number(FAR.slice(5, 7)) - 1];
// The one voucher an HR row's event stands under (posted and not reversed).
async function bookedAs(sourceType, sourceId) {
  const live = (await vouchersOf(sourceType, sourceId)).filter(v => v.status === 'posted' && v.reversed_by_id == null);
  assert.equal(live.length, 1, `${sourceType} ${sourceId}: ${JSON.stringify(await vouchersOf(sourceType, sourceId))}`);
  return voucherRow(live[0].id);
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('hr-wiring', { setup: false });
  feed = await import('./finance-hr-feed.js');
  fx = finHrFixtures(h.db);
  await fx.channels();   // CASH, COLOUR, DARBI, SPARE
  for (const [user, level] of [[h.users.md.id, 'admin'], [h.users.acct.id, 'accounts'], [h.users.appr2.id, 'approver'], [h.users.viewer.id, 'viewer']]) {
    await fx.access(user, level);
  }
  // Before Finance has any book (its books are set up at go-live), an HR door: what it answered, and what Finance wrote and logged
  // (the first test reads it).
  const early = await fx.person({ name: 'Test Person Early' });
  let res;
  const logged = await feedLog(async () => { res = await h.call('POST', '/hr/advances', { person_id: early, amount: 500 }, 'acct'); });
  noBooks = { status: res.status, logged, exceptions: await count('fin_hr_exceptions'), vouchers: await count('fin_vouchers') };

  // Ruling R47: while Finance offers no account (here, before it has any book), a door sent no code takes cash. A new loan, a bulk
  // Mark paid of a cash line with a line of no pay channel, and the drawer's Mark paid of a line of no channel (the second test reads
  // what each stored). The other lines of the month far ahead wait for the R44a test.
  far = {
    c0: await fx.person({ name: 'Test Early Cash', channel: 'CASH' }),
    n0: await fx.person({ name: 'Test Early None', channel: null }),
    n1: await fx.person({ name: 'Test Early Drawer', channel: null }),
    b0: await fx.person({ name: 'Test Early Bank', channel: 'COLOUR' }),
    c1: await fx.person({ name: 'Test Far Cash', channel: 'CASH' }),
    n2: await fx.person({ name: 'Test Far None', channel: null }),
    b1: await fx.person({ name: 'Test Far Bank', channel: 'COLOUR' }),
  };
  farRun = await fx.payroll({ month: FAR, approvedBy: h.users.md.id,
    lines: Object.values(far).map((person, i) => ({ person, gross: 1000 + 100 * i })) });
  const lent = await h.call('POST', '/hr/loans', newLoan(early), 'acct');
  const bulk = await h.call('POST', `/hr/runs/${FAR}/lines/status`, { person_ids: [far.c0, far.n0], status: 'paid', paid_on: TODAY }, 'acct');
  const drawn = await h.call('PUT', `/hr/runs/${FAR}/lines/${far.n1}/payment`, { status: 'paid' }, 'acct');
  const banked = await h.call('PUT', `/hr/runs/${FAR}/lines/${far.b0}/payment`, { status: 'paid' }, 'acct');
  const farFrom = async person => Object.values(await h.db.one(
    'SELECT payment_status, payment_batch_id, paid_from FROM hr.run_lines WHERE run_id = $1 AND person_id = $2', [farRun.id, person]));
  noAccounts = {
    statuses: [lent.status, bulk.status, drawn.status, banked.status],
    loan: lent.status === 200 ? Object.values(await h.db.one(
      `SELECT l.paid_via, t.paid_via AS disbursed_via FROM hr.loans l JOIN hr.loan_txns t ON t.loan_id = l.id AND t.kind = 'disbursed'
        WHERE l.id = $1`, [lent.body.id])) : lent.body,
    batch: bulk.status === 200
      ? (await h.db.one('SELECT paid_from FROM hr.payment_batches WHERE id = $1', [bulk.body.batches[0].id])).paid_from : bulk.body,
    none: await farFrom(far.n0),
    drawer: await farFrom(far.n1),
    bank: await farFrom(far.b0),
    vouchers: await count('fin_vouchers'),
  };

  const { finSetupBooks } = await import('./finance-setup.js');
  await h.db.tx((qc, oc) => finSetupBooks(qc, oc, { grants: FIN_TEST_GRANTS, booksBegin: BEGIN }));
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  for (const book of [CI, DP]) GROUPS[book] = (await ok(h.call('GET', `/finance/books/${book}/groups`, null, 'md'))).groups;
  await makeLedger(CI, 'Cash-in-Hand', 'Office cash');
  await makeLedger(CI, 'Cash-in-Hand', 'Holder A Cash', { holder_name: 'Holder A' });
  await makeLedger(CI, 'Bank Accounts', 'Bank – current');
  await makeLedger(CI, 'Bank Accounts', 'Bank – spare');
  await makeLedger(CI, 'Indirect Expenses', 'Advance Waivers');
  await makeLedger(CI, 'Indirect Expenses', 'Rounding Off');
  await makeLedger(DP, 'Bank Accounts', 'DP Bank');
  for (const book of [CI, DP]) await ok(h.call('POST', '/finance/hr-setup/ledgers', { book_id: book }, 'md'));
  for (const l of await h.db.q('SELECT id, book_id, name FROM fin_ledgers')) (l.book_id === CI ? L : D)[l.name] = l.id;
  await saveSetup({
    book_id: CI,
    channels: [
      { channel_code: 'CASH', ledger_id: L['Office cash'] },
      { channel_code: 'COLOUR', ledger_id: L['Bank – current'] },
      { channel_code: 'DARBI', ledger_id: D['DP Bank'] },
    ],
    roles: { advance_waiver: L['Advance Waivers'], rounding: L['Rounding Off'] },
  });
  OFFICE = `fin:${L['Office cash']}`;
  HOLDER_A = `fin:${L['Holder A Cash']}`;
  BANK = `fin:${L['Bank – current']}`;
  SPARE_BANK = `fin:${L['Bank – spare']}`;
});

after(async () => { await h?.close(); });

test('while Finance has no book at all, an HR door answers as it always has, and Finance writes and logs nothing', gate, async () => {
  assert.deepEqual(noBooks, { status: 200, logged: [], exceptions: 0, vouchers: 0 },
    'no book has begun: nothing to post, and nothing to record as an exception (catch-up finds the row once the books exist)');
});

test('while Finance offers no account, a door sent no code takes cash: a new loan, a bulk Mark paid of a cash line and a line of no channel, the drawer\'s Mark paid of a line of no channel (ruling R47)', gate, async () => {
  assert.deepEqual(noAccounts, {
    statuses: [200, 200, 200, 200],
    loan: ['cash', 'cash'],                 // hr.loans.paid_via and its disbursal's
    batch: 'cash',                          // the cash channel's batch
    none: ['paid', null, 'cash'],           // the line of no channel: paid without a batch, its code on the line
    drawer: ['paid', null, 'cash'],
    bank: ['paid', null, null],             // a bank line's first Mark paid names none: the channel's own bank (§7.3), never cash
    vouchers: 0,
  }, 'HR is never held up by Finance\'s setup (§7.7); the code is resolved once Finance has its accounts');
});

// ── The list ─────────────────────────────────────────────────────────────────────────────────

test('GET /hr/paid-from-options answers the accounts level and refuses a viewer', gate, async () => {
  refused(await h.call('GET', '/hr/paid-from-options', null, 'viewer'), 403, 'HR_LEVEL');
  refused(await h.call('GET', '/hr/paid-from-options', null, 'plant'), 403, 'HR_NO_ACCESS');
  // The accounts level is HR's restricted one: the route is on its allow list, and its answer names accounts, never a person.
  const res = await fetch(`${h.base}/hr/paid-from-options`, { headers: { authorization: `Bearer ${h.users.acct.token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'never kept by a browser or the response cache');
  const body = await res.json();
  assert.deepEqual(body, { options: [
    { code: `fin:${L.Cash}`, label: 'Cash', channels: [] },
    { code: OFFICE, label: 'Office cash', channels: ['CASH', 'cash'] },
    { code: HOLDER_A, label: 'Holder · Holder A', channels: [] },
    { code: BANK, label: 'Bank – current', channels: ['COLOUR'] },
    { code: `fin:${D['DP Bank']}`, label: 'DP Bank · Darbi Print Pack', channels: ['DARBI'] },
  ] });
  // Finance's own list, each account with the HR pay channels that pay from it (and `cash`, the code HR has always stored for cash).
  const { finPaidFromOptions } = await import('./finance-hr-setup.js');
  assert.deepEqual(body.options.map(({ channels, ...o }) => o), await finPaidFromOptions(h.db.q));
  assert.deepEqual(await ok(h.call('GET', '/hr/paid-from-options', null, 'md')), body, 'an HR admin reads the same');
});

// ── Pay staff, Give advance, New loan ────────────────────────────────────────────────────────

const STAFF_PAYMENT_KEYS = ['advance', 'kind', 'ledger', 'loan', 'person_id', 'warnings'];

test('Pay staff with paid_via fin:<Holder A> stores it on hr.advance_txns.paid_via and Finance credits Holder A', gate, async () => {
  const a = await fx.person({ name: 'Test Person A' });
  const res = await ok(h.call('POST', '/hr/staff-payments',
    { person_id: a, kind: 'advance', amount: 3000, paid_on: TODAY, paid_via: HOLDER_A }, 'acct'));
  assert.deepEqual(Object.keys(res).sort(), STAFF_PAYMENT_KEYS, 'HR\'s answer is as it was: nothing of Finance\'s in it');
  const row = await h.db.one(`SELECT id, paid_via, note FROM hr.advance_txns WHERE person_id = $1`, [a]);
  assert.deepEqual([row.paid_via, row.note], [HOLDER_A, 'Paid via Holder · Holder A']);
  const v = await bookedAs('hr_advance', row.id);
  assert.deepEqual([v.book_id, v.voucher_type, v.voucher_date, v.narration, v.created_by],
    [CI, 'payment', TODAY, 'Advance · Pay staff · 1 person', 'Test Accountant (HR)']);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 3000 * R, 0], ['Holder A Cash', 0, 3000 * R]]);

  // A loan from the same form keeps its code on the loan and on its disbursal, and Finance books it from that account.
  const lent = await ok(h.call('POST', '/hr/staff-payments',
    { person_id: a, kind: 'loan', amount: 12000, instalments: 4, paid_on: TODAY, paid_via: BANK }, 'acct'));
  assert.deepEqual(Object.keys(lent).sort(), STAFF_PAYMENT_KEYS);
  const loan = await h.db.one(
    `SELECT l.id, l.loan_no, l.paid_via, t.paid_via AS disbursed_via, t.note FROM hr.loans l
       JOIN hr.loan_txns t ON t.loan_id = l.id AND t.kind = 'disbursed' WHERE l.id = $1`, [lent.loan.id]);
  assert.deepEqual([loan.paid_via, loan.disbursed_via, loan.note], [BANK, BANK, 'Paid out via Bank – current']);
  const lv = await bookedAs('hr_loan', loan.id);
  assert.deepEqual([lv.narration, lv.reference], [`Loan · ${loan.loan_no} · 1 person`, loan.loan_no]);
  assert.deepEqual(await linesOf(lv.id), [['Staff Loans', 12000 * R, 0], ['Bank – current', 0, 12000 * R]]);
});

test('Give advance now stores paid_via', gate, async () => {
  const b = await fx.person({ name: 'Test Person B' });
  const given = await ok(h.call('POST', '/hr/advances', { person_id: b, amount: 1500, paid_via: OFFICE }, 'acct'));
  assert.equal((await h.db.one('SELECT paid_via FROM hr.advance_txns WHERE id = $1', [given.id])).paid_via, OFFICE);
  assert.equal(given.balance, '1500.00', 'HR\'s answer: the row and the balance after it, as before');
  const v = await bookedAs('hr_advance', given.id);
  assert.equal(v.narration, 'Advance · Loans & Advances · 1 person');
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 1500 * R, 0], ['Office cash', 0, 1500 * R]]);
  // Sent no choice, an advance is cash, as Pay staff has always taken it: Finance books it from the CASH channel's account.
  const plain = await ok(h.call('POST', '/hr/advances', { person_id: b, amount: 700 }, 'acct'));
  assert.equal((await h.db.one('SELECT paid_via FROM hr.advance_txns WHERE id = $1', [plain.id])).paid_via, 'cash');
  assert.deepEqual(await linesOf((await bookedAs('hr_advance', plain.id)).id), [['Staff Advances', 700 * R, 0], ['Office cash', 0, 700 * R]]);
});

const newLoan = (person, over = {}) => ({
  person_id: person, principal: 6000, issued_on: TODAY, purpose: 'Test purpose', instalment: 2000, first_due_month: MONTH,
  is_opening: false, ...over,
});

test('New loan with free text is refused 400 "Choose where it was paid from"', gate, async () => {
  const c = await fx.person({ name: 'Test Person C' });
  const [loans, audits, before] = [await count('hr.loans'), await hrAudits(), await financeState()];
  const res = await h.call('POST', '/hr/loans', newLoan(c, { paid_via: 'HDFC transfer' }), 'acct');
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error, WHY);
  assert.equal(res.body.code, 'UNKNOWN_PAY_CHANNEL');
  assert.deepEqual([await count('hr.loans'), await hrAudits(), await financeState()], [loans, audits, before], 'nothing written, nothing minted');

  // A choice from the list is taken: kept on the loan and its disbursal, and booked from that account.
  const made = await ok(h.call('POST', '/hr/loans', newLoan(c, { paid_via: BANK }), 'acct'));
  const loan = await h.db.one(
    `SELECT l.paid_via, t.paid_via AS disbursed_via FROM hr.loans l JOIN hr.loan_txns t ON t.loan_id = l.id AND t.kind = 'disbursed'
      WHERE l.id = $1`, [made.id]);
  assert.deepEqual([loan.paid_via, loan.disbursed_via], [BANK, BANK]);
  assert.equal(made.paid_via, BANK, 'HR\'s answer is the loan, as before');
  assert.deepEqual(await linesOf((await bookedAs('hr_loan', made.id)).id), [['Staff Loans', 6000 * R, 0], ['Bank – current', 0, 6000 * R]]);
  // Its detail says the account by its name.
  assert.equal((await ok(h.call('GET', `/hr/loans/${made.id}`, null, 'acct'))).loan.paid_via_label, 'Bank – current');

  // The door's field was optional, and still is: an opening balance names no account, and Finance books none (it is the Tally opening).
  const opening = await ok(h.call('POST', '/hr/loans', newLoan(c, { paid_via: undefined, is_opening: true }), 'acct'));
  assert.equal(opening.paid_via, null);
  assert.deepEqual(await vouchersOf('hr_loan', opening.id), []);
});

test('a door takes cash, a pay channel or an account on the list, and refuses anything else with the same sentence', gate, async () => {
  const p = await fx.person({ name: 'Test Person V' });
  const body = paid_via => ({ person_id: p, kind: 'advance', amount: 100, paid_on: TODAY, paid_via });
  // A bank no channel pays from, a ledger that is no account to pay from, no ledger at all, text: none is on the list.
  for (const code of [SPARE_BANK, `fin:${L['Staff Advances']}`, 'fin:999999', 'fin:', 'fin:x', 'NOPE', 'Office cash', 'HDFC transfer']) {
    const [audits, before] = [await hrAudits(), await financeState()];
    const res = await h.call('POST', '/hr/staff-payments', body(code), 'acct');
    assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
    assert.deepEqual([res.body.error, res.body.code], [WHY, 'UNKNOWN_PAY_CHANNEL'], code);
    assert.deepEqual([await hrAudits(), await financeState()], [audits, before], `${code}: nothing written`);
  }
  for (const [code, stored] of [['cash', 'cash'], ['Cash', 'cash'], ['COLOUR', 'COLOUR'], [OFFICE, OFFICE], [HOLDER_A, HOLDER_A]]) {
    const res = await ok(h.call('POST', '/hr/staff-payments', body(code), 'acct'));
    assert.equal((await h.db.one(`SELECT paid_via FROM hr.advance_txns WHERE id = $1`, [Number(res.advance.key.slice(1))])).paid_via, stored, code);
  }
  // Give advance, New loan and Prepay refuse the same way.
  refused(await h.call('POST', '/hr/advances', { person_id: p, amount: 100, paid_via: SPARE_BANK }, 'acct'), 400, 'UNKNOWN_PAY_CHANNEL');
  refused(await h.call('POST', '/hr/loans', newLoan(p, { paid_via: SPARE_BANK }), 'acct'), 400, 'UNKNOWN_PAY_CHANNEL');
  const loan = await ok(h.call('POST', '/hr/loans', newLoan(p, { paid_via: OFFICE }), 'acct'));
  refused(await h.call('POST', `/hr/loans/${loan.id}/prepay`, { amount: 100, paid_via: 'fin:999999' }, 'acct'), 400, 'UNKNOWN_PAY_CHANNEL');
  // An advance sheet keeps its paid_via, chosen from the same list.
  refused(await h.call('POST', '/hr/advance-sheets', { month: MONTH, paid_on: TODAY, paid_via: SPARE_BANK }, 'acct'), 400, 'UNKNOWN_PAY_CHANNEL');
});

test('an HR request still answers 200 when the feed records an exception (unmapped channel)', gate, async () => {
  const d = await fx.person({ name: 'Test Person D', channel: 'SPARE' });
  let res;
  const logged = await feedLog(async () => {
    res = await h.call('POST', '/hr/staff-payments', { person_id: d, kind: 'advance', amount: 900, paid_on: TODAY, paid_via: 'SPARE' }, 'acct');
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), STAFF_PAYMENT_KEYS);
  const row = await h.db.one('SELECT id, paid_via FROM hr.advance_txns WHERE person_id = $1', [d]);
  assert.equal(row.paid_via, 'SPARE', 'HR kept what it was told: the SPARE channel, which Finance has not mapped yet');
  assert.deepEqual(await vouchersOf('hr_advance', row.id), []);
  const { FIN_SENTENCES } = await import('./finance-errors.js');
  const ex = await exceptionOf('hr_advance', row.id);
  assert.deepEqual([ex.reason_code, ex.reason, ex.resolved_at], ['FIN_UNMAPPED_CHANNEL', FIN_SENTENCES.FIN_UNMAPPED_CHANNEL, null]);
  assert.deepEqual(logged, ['[finance-hr] FIN_UNMAPPED_CHANNEL'], 'the code alone: nothing of the event or its person');
});

test('a new loan that is not an opening balance names its account: none is refused 400 "Choose where it was paid from" (ruling R46)', gate, async () => {
  const n = await fx.person({ name: 'Test Person N' });
  for (const over of [{}, { paid_via: '' }, { paid_via: '   ' }, { paid_via: null }]) {
    const [loans, audits, before] = [await count('hr.loans'), await hrAudits(), await financeState()];
    const res = await h.call('POST', '/hr/loans', newLoan(n, over), 'acct');
    assert.equal(res.status, 400, `${JSON.stringify(over)}: ${JSON.stringify(res.body)}`);
    assert.deepEqual([res.body.error, res.body.code], [WHY, 'UNKNOWN_PAY_CHANNEL']);
    assert.deepEqual([await count('hr.loans'), await hrAudits(), await financeState()], [loans, audits, before], 'nothing written, nothing minted');
  }
  // An opening balance is as it was: it names no account.
  const opening = await ok(h.call('POST', '/hr/loans', newLoan(n, { is_opening: true }), 'acct'));
  assert.equal(opening.paid_via, null);
});

test('HR\'s monthly schedule reads a paid-from code by the account it names: office cash and a holder are cash, a bank is bank (ruling R43)', gate, async () => {
  // Two months back, where no other HR row of this file falls (and before the books here, so Finance books none of it).
  const M0 = shiftMonth(MONTH, -2);
  const p = await fx.person({ name: 'Test Person R' });
  for (const [code, rupees] of [[OFFICE, 1000], [HOLDER_A, 2000], [BANK, 4000]]) {
    await ok(h.call('POST', '/hr/loans', newLoan(p, { paid_via: code, principal: rupees, instalment: 500, issued_on: `${M0}-10`, first_due_month: M0 }), 'md'));
    await ok(h.call('POST', '/hr/staff-payments', { person_id: p, kind: 'advance', amount: rupees / 10, paid_on: `${M0}-12`, paid_via: code }, 'md'));
  }
  // A pay channel's code is read by the channel's own kind: a cash channel is cash, a bank channel bank. (Not the CASH channel itself:
  // every door stores 'CASH', in any capitals, as `cash`.)
  await h.db.q(`INSERT INTO hr.pay_channels (code, label, kind) VALUES ('TILL', 'Test till', 'cash')`);
  await ok(h.call('POST', '/hr/loans', newLoan(p, { paid_via: 'COLOUR', principal: 500, instalment: 500, issued_on: `${M0}-10`, first_due_month: M0 }), 'md'));
  await ok(h.call('POST', '/hr/staff-payments', { person_id: p, kind: 'advance', amount: 50, paid_on: `${M0}-12`, paid_via: 'TILL' }, 'md'));
  // A Pay-staff advance from before HR kept the code on the row is read by its note, as it always was.
  await h.db.q(`INSERT INTO hr.advance_txns (person_id, txn_date, kind, amount, source, note) VALUES ($1, $2::date, 'given', 800, 'manual', 'Paid via COLOUR')`,
    [p, `${M0}-14`]);
  const months = await ok(h.call('GET', '/hr/reports/monthly', null, 'md'));
  const row = months.find(m => m.month === M0);
  assert.ok(row, `the schedule has ${M0}`);
  assert.deepEqual(row.loans_issued, { count: 4, amount: '7500.00', cash: '3000.00', bank: '4500.00' });
  assert.deepEqual(row.advances_pay_staff, { count: 5, amount: '1550.00', cash: '350.00', bank: '1200.00' });
});

// ── Loans: prepay, cancel; advances: waive ───────────────────────────────────────────────────

test('Prepay keeps where it was received into, and Finance books the receipt into that account', gate, async () => {
  const e = await fx.person({ name: 'Test Person E' });
  const loan = await ok(h.call('POST', '/hr/loans', newLoan(e, { paid_via: BANK, principal: 8000 }), 'acct'));
  const res = await ok(h.call('POST', `/hr/loans/${loan.id}/prepay`, { amount: 1000, date: TODAY, paid_via: OFFICE }, 'acct'));
  assert.equal(res.outstanding, '7000.00', 'HR\'s answer is the loan, as before');
  const txn = await h.db.one(`SELECT id, paid_via FROM hr.loan_txns WHERE loan_id = $1 AND kind = 'prepayment'`, [loan.id]);
  assert.equal(txn.paid_via, OFFICE);
  const v = await bookedAs('hr_prepay', txn.id);
  assert.deepEqual([v.voucher_type, v.narration], ['receipt', `Loan repaid · ${loan.loan_no}`]);
  assert.deepEqual(await linesOf(v.id), [['Office cash', 1000 * R, 0], ['Staff Loans', 0, 1000 * R]]);
  // Sent no choice, the money came back as cash.
  await ok(h.call('POST', `/hr/loans/${loan.id}/prepay`, { amount: 500, date: TODAY }, 'acct'));
  const plain = await h.db.one(`SELECT id, paid_via FROM hr.loan_txns WHERE loan_id = $1 AND kind = 'prepayment' ORDER BY id DESC LIMIT 1`, [loan.id]);
  assert.equal(plain.paid_via, 'cash');
  assert.deepEqual(await linesOf((await bookedAs('hr_prepay', plain.id)).id), [['Office cash', 500 * R, 0], ['Staff Loans', 0, 500 * R]]);
});

test('Cancelling a loan takes its entry out of the books', gate, async () => {
  const f = await fx.person({ name: 'Test Person F' });
  const loan = await ok(h.call('POST', '/hr/loans', newLoan(f, { paid_via: BANK, principal: 4000 }), 'acct'));
  const v = await bookedAs('hr_loan', loan.id);
  // The MD cancels it: an HR approver, so the reversal is approved in HR and posts at once.
  const res = await ok(h.call('POST', `/hr/loans/${loan.id}/cancel`, {}, 'md'));
  assert.equal(res.status, 'cancelled', 'HR\'s answer is the loan, as before');
  const after = await voucherRow(v.id);
  assert.ok(after.reversed_by_id, 'the loan\'s payment is reversed');
  const reversal = await voucherRow(after.reversed_by_id);
  assert.deepEqual([reversal.status, reversal.reversal_of_id], ['posted', v.id]);
  assert.deepEqual(await linesOf(reversal.id), [['Staff Loans', 0, 4000 * R], ['Bank – current', 4000 * R, 0]]);
});

test('Waiving an advance posts its journal', gate, async () => {
  const g = await fx.person({ name: 'Test Person G' });
  await ok(h.call('POST', '/hr/advances', { person_id: g, amount: 2000, paid_via: OFFICE }, 'acct'));
  const res = await ok(h.call('POST', `/hr/advances/${g}/waive`, { amount: 500, note: 'Test waiver' }, 'appr2'));
  assert.equal(res.balance, '1500.00', 'HR\'s answer: the waiver row and the balance after it, as before');
  const v = await bookedAs('hr_waiver', res.id);
  assert.deepEqual([v.voucher_type, v.narration], ['journal', 'Advance waived · 1 person']);
  assert.deepEqual(await linesOf(v.id), [['Advance Waivers', 500 * R, 0], ['Staff Advances', 0, 500 * R]]);
});

// ── Advance sheets ───────────────────────────────────────────────────────────────────────────

let sheet, sheetPeople;
test('the sheet post stores the sheet\'s paid_via on every row it makes, and names its round by the smallest line it posted', gate, async () => {
  sheetPeople = [await fx.person({ name: 'Test Sheet One' }), await fx.person({ name: 'Test Sheet Two' }), await fx.person({ name: 'Test Sheet Three' })];
  const [s1, s2, s3] = sheetPeople;
  sheet = (await ok(h.call('POST', '/hr/advance-sheets', { month: MONTH, paid_on: TODAY, paid_via: HOLDER_A }, 'acct'))).sheet;
  assert.equal(sheet.paid_via, HOLDER_A);
  assert.equal(sheet.paid_via_label, 'Holder · Holder A');
  await ok(h.call('PUT', `/hr/advance-sheets/${sheet.id}/lines`, { lines: [
    { person_id: s1, kind: 'advance', amount: 1000 },
    { person_id: s2, kind: 'loan', amount: 4000, instalments: 4, purpose: 'Test purpose' },
    { person_id: s3, kind: 'advance', amount: 600 },
  ] }, 'acct'));
  await ok(h.call('POST', `/hr/advance-sheets/${sheet.id}/submit`, {}, 'acct'));
  await ok(h.call('POST', `/hr/advance-sheets/${sheet.id}/decide`, { person_ids: [s1, s2], decision: 'approved' }, 'appr2'));
  const posted = await ok(h.call('POST', `/hr/advance-sheets/${sheet.id}/post`, {}, 'acct'));
  assert.deepEqual([posted.posted, posted.closed], [2, false], 'Test Sheet Three waits for a decision');
  const lines = await h.db.q(`SELECT id, person_id, advance_txn_id, loan_id FROM hr.advance_sheet_lines WHERE sheet_id = $1 ORDER BY id`, [sheet.id]);
  const done = lines.filter(l => l.advance_txn_id != null || l.loan_id != null);
  assert.deepEqual(done.map(l => l.person_id).sort((x, y) => x - y), [s1, s2].sort((x, y) => x - y));
  const adv = await h.db.one('SELECT paid_via, source FROM hr.advance_txns WHERE id = $1', [done.find(l => l.person_id === s1).advance_txn_id]);
  assert.deepEqual([adv.paid_via, adv.source], [HOLDER_A, 'manual'], 'the advance row keeps the sheet\'s account');
  const loanId = done.find(l => l.person_id === s2).loan_id;
  const loan = await h.db.one(
    `SELECT l.paid_via, t.paid_via AS disbursed_via FROM hr.loans l JOIN hr.loan_txns t ON t.loan_id = l.id AND t.kind = 'disbursed' WHERE l.id = $1`, [loanId]);
  assert.deepEqual([loan.paid_via, loan.disbursed_via], [HOLDER_A, HOLDER_A]);
  // One payment for the round, under its anchor: the smallest id of the lines this post made.
  const anchor = Math.min(...done.map(l => l.id));
  const v = await bookedAs('hr_sheet', anchor);
  assert.equal(v.narration, `Advances · sheet ${sheet.sheet_no} · 2 people`);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 1000 * R, 0], ['Staff Loans', 4000 * R, 0], ['Holder A Cash', 0, 5000 * R]]);
  assert.deepEqual(await vouchersOf('hr_loan', loanId), [], 'the loan posts with its round, never on its own');
});

test('a posted sheet line is frozen: PUT …/lines refuses to drop or change it with 409, and an unposted line still edits', gate, async () => {
  const [s1, s2, s3] = sheetPeople;
  await ok(h.call('POST', `/hr/advance-sheets/${sheet.id}/send-back`, { reason: 'Test: one more look' }, 'appr2'));
  const linesNow = () => h.db.q(`SELECT person_id, kind, amount::text AS amount, decision, posted_at FROM hr.advance_sheet_lines WHERE sheet_id = $1 ORDER BY id`, [sheet.id]);
  const was = await linesNow();
  for (const change of [
    { person_id: s1, kind: 'advance', amount: 0 },                                         // dropped
    { person_id: s2, kind: 'loan', amount: 5000, instalments: 4, purpose: 'Test purpose' }, // its amount rewritten
    { person_id: s1, kind: 'loan', amount: 1000, instalments: 2, purpose: 'Test purpose' }, // made a loan
  ]) {
    const audits = await hrAudits();
    const res = await h.call('PUT', `/hr/advance-sheets/${sheet.id}/lines`, { lines: [change] }, 'acct');
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual([res.body.error, res.body.code], ['Lines already paid out can\'t be changed.', 'SHEET_LINE_POSTED']);
    assert.deepEqual([await linesNow(), await hrAudits()], [was, audits], 'nothing changed');
  }
  // A posted line sent again as it stands is no change; the unposted one edits as before.
  const edited = await ok(h.call('PUT', `/hr/advance-sheets/${sheet.id}/lines`, { lines: [
    { person_id: s1, kind: 'advance', amount: 1000 },
    { person_id: s3, kind: 'advance', amount: 800 },
  ] }, 'acct'));
  assert.equal(edited.lines.find(l => l.person_id === s3).amount, '800.00');
  assert.deepEqual((await linesNow()).filter(l => l.person_id !== s3), was.filter(l => l.person_id !== s3));
});

test('cancelling a loan an advance sheet made takes it out of the sheet\'s round: the round is reversed and posted again without it (ruling R48)', gate, async () => {
  const [s1, s2] = sheetPeople;
  const posted = await h.db.q(
    'SELECT id, person_id, advance_txn_id, loan_id FROM hr.advance_sheet_lines WHERE sheet_id = $1 AND posted_at IS NOT NULL ORDER BY id', [sheet.id]);
  const anchor = posted[0].id;
  const loanId = posted.find(l => l.person_id === s2).loan_id;
  const advance = posted.find(l => l.person_id === s1).advance_txn_id;
  const first = await bookedAs('hr_sheet', anchor);
  // The MD cancels the loan: an HR approver, so the round's reversal is approved in HR and posts at once.
  const res = await ok(h.call('POST', `/hr/loans/${loanId}/cancel`, {}, 'md'));
  assert.equal(res.status, 'cancelled', 'HR\'s answer is the loan, as before');
  const was = await voucherRow(first.id);
  assert.ok(was.reversed_by_id, 'the round\'s payment is reversed');
  assert.deepEqual(await linesOf(was.reversed_by_id), [['Staff Advances', 0, 1000 * R], ['Staff Loans', 0, 4000 * R], ['Holder A Cash', 5000 * R, 0]]);
  // …and the round posted again with the advance alone, from the account the round was paid from.
  const again = await bookedAs('hr_sheet', anchor);
  assert.deepEqual([again.narration, await linesOf(again.id)],
    [`Advances · sheet ${sheet.sheet_no} · 1 person`, [['Staff Advances', 1000 * R, 0], ['Holder A Cash', 0, 1000 * R]]]);
  // The loan is booked by nothing now, and never on its own; the advance by the round alone.
  assert.deepEqual([await bookedTimes('hr_loan', loanId), await vouchersOf('hr_loan', loanId)], [0, []]);
  assert.equal(await bookedTimes('hr_advance', advance), 1);
  // Posted again (a retry, or Bring-in), by any line of the round, it stands as it is.
  const before = await financeState();
  assert.deepEqual(await feed.finHrPost({ type: 'sheet', id: posted[1].id }, { id: h.users.md.id, name: 'Test MD', hrLevel: 'admin' }),
    { result: 'posted', voucher_id: again.id, already: true });
  assert.equal(await financeState(), before);
});

// ── The payroll month ────────────────────────────────────────────────────────────────────────

let run, people, rLoan;
test('a payroll month made through HR, approved for payment', gate, async () => {
  people = {
    r1: await fx.person({ name: 'Test Payroll One', channel: 'CASH' }),
    r2: await fx.person({ name: 'Test Payroll Two', channel: 'CASH' }),
    r3: await fx.person({ name: 'Test Payroll Three', channel: 'COLOUR' }),
    r4: await fx.person({ name: 'Test Payroll Four', channel: 'COLOUR' }),
    r5: await fx.person({ name: 'Test Payroll Five', channel: 'CASH' }),
    r6: await fx.person({ name: 'Test Payroll Six', channel: 'COLOUR' }),
  };
  for (const [person, base] of [[people.r1, 20000], [people.r2, 16000], [people.r3, 18000], [people.r4, 17000], [people.r5, 15000],
    [people.r6, 14000]]) {
    await h.db.q(`INSERT INTO hr.pay_setups (person_id, effective_from, pay_basis, base) VALUES ($1, $2, 'monthly', $3)`, [person, BEGIN, base]);
  }
  // Test Payroll One has a loan, recovered from this month's pay.
  rLoan = await ok(h.call('POST', '/hr/loans', newLoan(people.r1, { paid_via: BANK, principal: 6000, instalment: 2000 }), 'acct'));
  await ok(h.call('PUT', `/hr/runs/${MONTH}/inputs`, { rows: Object.values(people).map(id => ({ person_id: id, absent_days: 0 })) }, 'acct'));
  await ok(h.call('POST', `/hr/runs/${MONTH}/submit`, {}, 'acct'));
  await ok(h.call('POST', `/hr/runs/${MONTH}/approve`, {}, 'md'));
  await ok(h.call('POST', `/hr/runs/${MONTH}/lines/approval`, { person_ids: Object.values(people), action: 'approve' }, 'md'));
  run = await h.db.one('SELECT id, status FROM hr.runs WHERE month = $1', [MONTH]);
  assert.equal(run.status, 'approved');
  const line = await h.db.one(`SELECT loan_recovery::text AS loan FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`, [run.id, people.r1]);
  assert.equal(line.loan, '2000.00');
});

const lineOf = person => h.db.one(
  `SELECT id, payment_status, payment_batch_id, paid_from, round(payable * 100)::bigint AS payable FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`,
  [run.id, person]);

test('Mark paid (cash channel) with paid_from fin:<Holder A> stores it on the batch', gate, async () => {
  // A code that is not on the list is refused, and no batch number is used.
  const [batches, before] = [await count('hr.payment_batches'), await financeState()];
  const bad = await h.call('POST', `/hr/runs/${MONTH}/payments`, { pay_channel: 'CASH', paid_on: TODAY, person_ids: [people.r1], paid_from: SPARE_BANK }, 'acct');
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.deepEqual([bad.body.error, bad.body.code], [WHY, 'UNKNOWN_PAY_CHANNEL']);
  assert.deepEqual([await count('hr.payment_batches'), await financeState()], [batches, before]);

  const res = await ok(h.call('POST', `/hr/runs/${MONTH}/payments`,
    { pay_channel: 'CASH', paid_on: TODAY, person_ids: [people.r1], paid_from: HOLDER_A }, 'acct'));
  assert.deepEqual(res.person_ids, [people.r1], 'HR\'s answer is the batch, as before');
  const batch = await h.db.one('SELECT id, batch_no, paid_from FROM hr.payment_batches WHERE id = $1', [res.id]);
  assert.equal(batch.paid_from, HOLDER_A);
  const v = await bookedAs('hr_batch', batch.id);
  const payable = Number((await lineOf(people.r1)).payable);
  assert.deepEqual([v.voucher_type, v.voucher_date, v.narration], ['payment', TODAY, `Salary ${MON} · cash · ${batch.batch_no} · 1 person`]);
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', payable, 0], ['Holder A Cash', 0, payable]]);
  assert.deepEqual(await vouchersOf('hr_run', run.id), [], 'the month is not finalised: no payroll journal yet');
});

let bankBatch;
test('a bank channel\'s batch names no account and pays from the channel\'s own; a line of it marked failed in the drawer leaves its entry', gate, async () => {
  const res = await ok(h.call('POST', `/hr/runs/${MONTH}/payments`,
    { pay_channel: 'COLOUR', paid_on: TODAY, person_ids: [people.r4, people.r6], reference: 'TESTUTR1' }, 'acct'));
  bankBatch = await h.db.one('SELECT id, paid_from FROM hr.payment_batches WHERE id = $1', [res.id]);
  assert.equal(bankBatch.paid_from, null, 'none named: the channel\'s own account');
  const v = await bookedAs('hr_batch', bankBatch.id);
  const [p4, p6] = [Number((await lineOf(people.r4)).payable), Number((await lineOf(people.r6)).payable)];
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', p4 + p6, 0], ['Bank – current', 0, p4 + p6]]);
  // The money did not reach Test Payroll Four: the drawer marks the line failed. HR keeps the line's batch; the batch's entry is
  // taken out and posted again with the line still paid.
  await ok(h.call('PUT', `/hr/runs/${MONTH}/lines/${people.r4}/payment`, { status: 'failed', reference: 'Test: bounced' }, 'md'));
  assert.equal((await lineOf(people.r4)).payment_batch_id, bankBatch.id);
  const after = await voucherRow(v.id);
  assert.ok(after.reversed_by_id, 'the first entry is reversed');
  assert.equal((await voucherRow(after.reversed_by_id)).status, 'posted');
  assert.deepEqual(await linesOf((await bookedAs('hr_batch', bankBatch.id)).id), [['Salary Payable', p6, 0], ['Bank – current', 0, p6]]);
});

test('a line of a batch paid again in the drawer from another account is booked on its own from that account, and once (ruling R45)', gate, async () => {
  const l4 = await lineOf(people.r4);
  const p6 = Number((await lineOf(people.r6)).payable);
  const bankOnly = [['Salary Payable', p6, 0], ['Bank – current', 0, p6]];
  // The line as the drawer is handed it (GET /hr/runs/:month): a bank channel's, failed out of the batch HR keeps it in. So the drawer
  // asks where it was paid from this time, starting at the channel's own account (ruling R49), and sends what is chosen, as here.
  const shown = (await ok(h.call('GET', `/hr/runs/${MONTH}`, null, 'acct'))).lines.find(l => l.person_id === people.r4);
  assert.deepEqual([shown.pay_channel, shown.payment_status, shown.payment_batch_id], ['COLOUR', 'failed', bankBatch.id]);
  // Paid again, from office cash: HR keeps the line's batch link, but the money left office cash, not the batch's bank.
  await ok(h.call('PUT', `/hr/runs/${MONTH}/lines/${people.r4}/payment`, { status: 'paid', paid_from: OFFICE }, 'acct'));
  const repaid = await lineOf(people.r4);
  assert.deepEqual([repaid.payment_batch_id, repaid.paid_from], [bankBatch.id, OFFICE]);
  // The batch's entry leaves the line out (it still holds Test Payroll Six alone, from the bank) …
  const batchV = await bookedAs('hr_batch', bankBatch.id);
  assert.deepEqual(await linesOf(batchV.id), bankOnly);
  // … and the line is booked on its own, from office cash, by that one entry.
  const lineV = await bookedAs('hr_line_pay', l4.id);
  assert.deepEqual(await linesOf(lineV.id), [['Salary Payable', Number(l4.payable), 0], ['Office cash', 0, Number(l4.payable)]]);
  assert.equal(await bookedTimes('hr_line_pay', l4.id), 1, 'the row is booked once');
  assert.equal(await bookedTimes('hr_line_pay', (await lineOf(people.r6)).id), 1);

  // Failed again, then paid from the batch's own bank: the line goes back with its batch, and still only one entry books it. (The
  // MD does it: the batch's entry is reversed and posted again with the line, and an HR approver's reversal posts at once.)
  await ok(h.call('PUT', `/hr/runs/${MONTH}/lines/${people.r4}/payment`, { status: 'failed', reference: 'Test: bounced again' }, 'md'));
  assert.ok((await voucherRow(lineV.id)).reversed_by_id, 'its own entry is reversed');
  await ok(h.call('PUT', `/hr/runs/${MONTH}/lines/${people.r4}/payment`, { status: 'paid', paid_from: BANK }, 'md'));
  const back = await bookedAs('hr_batch', bankBatch.id);
  assert.deepEqual(await linesOf(back.id),
    [['Salary Payable', Number(l4.payable) + p6, 0], ['Bank – current', 0, Number(l4.payable) + p6]]);
  assert.equal(await bookedTimes('hr_line_pay', l4.id), 1, 'booked once, by its batch');
  assert.deepEqual((await vouchersOf('hr_line_pay', l4.id)).filter(v => v.status === 'posted' && v.reversed_by_id == null), []);
});

test('the bulk Mark paid names the cash batch\'s account: the cash batch is booked to Holder A, a bank batch to its channel\'s own (ruling R44)', gate, async () => {
  const ticked = [people.r3, people.r5];
  // No code, while Finance offers accounts (ruling R47), and a code not on the list, are refused, and nothing is paid or minted.
  for (const paidFrom of [{}, { paid_from: SPARE_BANK }]) {
    const [batches, before] = [await count('hr.payment_batches'), await financeState()];
    const bad = await h.call('POST', `/hr/runs/${MONTH}/lines/status`, { person_ids: ticked, status: 'paid', paid_on: TODAY, ...paidFrom }, 'acct');
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.deepEqual([bad.body.error, bad.body.code], [WHY, 'UNKNOWN_PAY_CHANNEL']);
    assert.deepEqual([await count('hr.payment_batches'), await financeState(), (await lineOf(people.r5)).payment_status], [batches, before, 'pending']);
  }

  const res = await ok(h.call('POST', `/hr/runs/${MONTH}/lines/status`, { person_ids: ticked, status: 'paid', paid_on: TODAY, paid_from: HOLDER_A }, 'acct'));
  assert.equal(res.batches.length, 2, 'HR\'s answer, as before: one batch per channel');
  const made = Object.fromEntries(res.batches.map(b => [b.pay_channel, b.id]));
  const fromOf = async id => (await h.db.one('SELECT paid_from FROM hr.payment_batches WHERE id = $1', [id])).paid_from;
  assert.deepEqual([await fromOf(made.CASH), await fromOf(made.COLOUR)], [HOLDER_A, null], 'the cash batch names the holder; the bank batch, none');
  const [p3, p5] = [Number((await lineOf(people.r3)).payable), Number((await lineOf(people.r5)).payable)];
  assert.deepEqual(await linesOf((await bookedAs('hr_batch', made.CASH)).id), [['Salary Payable', p5, 0], ['Holder A Cash', 0, p5]]);
  const v = await bookedAs('hr_batch', made.COLOUR);
  assert.deepEqual(await linesOf(v.id), [['Salary Payable', p3, 0], ['Bank – current', 0, p3]]);
  // Marked unpaid (an approver), the batch a line left books nothing any more: its payment is reversed.
  await ok(h.call('POST', `/hr/runs/${MONTH}/lines/status`, { person_ids: [people.r3], status: 'pending', reason: 'Test: bounced' }, 'md'));
  const after = await voucherRow(v.id);
  assert.ok(after.reversed_by_id, 'the batch\'s payment is reversed');
  assert.equal((await voucherRow(after.reversed_by_id)).status, 'posted', 'approved in HR by the MD');
  assert.equal((await lineOf(people.r3)).payment_batch_id, null);
});

test('the bulk Mark paid asks for a line of no pay channel too: with accounts offered it needs a code, kept on that line and booked from that account; a bank line alone needs none (ruling R44a)', gate, async () => {
  const farLine = person => h.db.one(
    `SELECT id, payment_status, payment_batch_id, paid_from, round(payable * 100)::bigint AS payable FROM hr.run_lines WHERE run_id = $1 AND person_id = $2`,
    [farRun.id, person]);
  const url = `/hr/runs/${FAR}/lines/status`;
  // A cash line, a line of no channel, or both with a bank line, sent no code: refused, nothing paid or minted.
  for (const ids of [[far.c1], [far.n2], [far.b1, far.c1, far.n2]]) {
    const [batches, before] = [await count('hr.payment_batches'), await financeState()];
    const res = await h.call('POST', url, { person_ids: ids, status: 'paid', paid_on: TODAY }, 'acct');
    assert.equal(res.status, 400, `${ids}: ${JSON.stringify(res.body)}`);
    assert.deepEqual([res.body.error, res.body.code], [WHY, 'UNKNOWN_PAY_CHANNEL']);
    assert.deepEqual([await count('hr.payment_batches'), await financeState(), (await farLine(ids[0])).payment_status], [batches, before, 'pending']);
  }
  // A bank line alone needs no code: its batch pays from the bank its channel is mapped to (§7.3).
  const banked = await ok(h.call('POST', url, { person_ids: [far.b1], status: 'paid', paid_on: TODAY }, 'acct'));
  const b1 = await farLine(far.b1);
  assert.equal((await h.db.one('SELECT paid_from FROM hr.payment_batches WHERE id = $1', [banked.batches[0].id])).paid_from, null);
  assert.deepEqual(await linesOf((await bookedAs('hr_batch', banked.batches[0].id)).id), [['Salary Payable', Number(b1.payable), 0], ['Bank – current', 0, Number(b1.payable)]]);
  // Named, the code is kept on the cash batch and on the line of no channel (paid without a batch, as before), and each is booked from it.
  const res = await ok(h.call('POST', url, { person_ids: [far.c1, far.n2], status: 'paid', paid_on: TODAY, paid_from: HOLDER_A }, 'acct'));
  assert.deepEqual(res.batches.map(b => b.pay_channel), ['CASH'], 'HR\'s answer, as before: one batch, of the cash channel');
  assert.equal((await h.db.one('SELECT paid_from FROM hr.payment_batches WHERE id = $1', [res.batches[0].id])).paid_from, HOLDER_A);
  const [c1, n2] = [await farLine(far.c1), await farLine(far.n2)];
  assert.deepEqual([n2.payment_status, n2.payment_batch_id, n2.paid_from], ['paid', null, HOLDER_A]);
  assert.deepEqual(await linesOf((await bookedAs('hr_batch', res.batches[0].id)).id), [['Salary Payable', Number(c1.payable), 0], ['Holder A Cash', 0, Number(c1.payable)]]);
  const v = await bookedAs('hr_line_pay', n2.id);
  assert.deepEqual([v.narration, await linesOf(v.id)],
    [`Salary ${FAR_MON} · 1 person`, [['Salary Payable', Number(n2.payable), 0], ['Holder A Cash', 0, Number(n2.payable)]]]);
});

test('the line drawer\'s Mark paid keeps paid_from on the line and books it; a second copy books nothing; failed takes it out', gate, async () => {
  const url = `/hr/runs/${MONTH}/lines/${people.r2}/payment`;
  refused(await h.call('PUT', url, { status: 'paid', paid_from: 'NOPE' }, 'acct'), 400, 'UNKNOWN_PAY_CHANNEL');
  const res = await ok(h.call('PUT', url, { status: 'paid', paid_from: OFFICE, reference: 'Test cash page 4' }, 'acct'));
  assert.equal(res.payment_status, 'paid', 'HR\'s answer is the line, as before');
  const line = await lineOf(people.r2);
  assert.deepEqual([line.paid_from, line.payment_batch_id], [OFFICE, null]);
  const v = await bookedAs('hr_line_pay', line.id);
  assert.deepEqual([v.narration, await linesOf(v.id)],
    [`Salary ${MON} · cash · 1 person`, [['Salary Payable', Number(line.payable), 0], ['Office cash', 0, Number(line.payable)]]]);
  // The same Mark paid again (a second press): HR refuses it, and Finance is told nothing new.
  const before = await financeState();
  refused(await h.call('PUT', url, { status: 'paid', paid_from: OFFICE, reference: 'Test cash page 4' }, 'acct'), 409, 'PAYMENT_STATE');
  assert.equal(await financeState(), before);
  // Marked failed: the money did not go, and its payment comes out of the books.
  await ok(h.call('PUT', url, { status: 'failed', reference: 'Test: not collected' }, 'md'));
  assert.equal((await lineOf(people.r2)).paid_from, null, 'a line not paid names no account');
  const after = await voucherRow(v.id);
  assert.ok(after.reversed_by_id);
  assert.equal((await voucherRow(after.reversed_by_id)).status, 'posted');
  // Paid again, by a holder this time; then marked unpaid in bulk (an approver): the line's own entry comes out, and it names no account.
  await ok(h.call('PUT', url, { status: 'paid', paid_from: HOLDER_A }, 'acct'));
  const again = await bookedAs('hr_line_pay', line.id);
  assert.deepEqual(await linesOf(again.id), [['Salary Payable', Number(line.payable), 0], ['Holder A Cash', 0, Number(line.payable)]]);
  await ok(h.call('POST', `/hr/runs/${MONTH}/lines/status`, { person_ids: [people.r2], status: 'pending', reason: 'Test: paid by mistake' }, 'md'));
  assert.equal((await lineOf(people.r2)).paid_from, null);
  assert.ok((await voucherRow(again.id)).reversed_by_id, 'the line\'s payment is reversed');
});

test('finalise posts the payroll journal; a correction of the finalised month posts it again, once; un-finalise takes it out', gate, async () => {
  const sums = async () => h.db.one(
    `SELECT round(sum(gross) * 100)::bigint AS gross, round(sum(loan_recovery) * 100)::bigint AS loan, round(sum(payable) * 100)::bigint AS payable
       FROM hr.run_lines WHERE run_id = $1`, [run.id]);
  const journal = s => [['Salaries & Wages', Number(s.gross), 0], ['Staff Loans', 0, Number(s.loan)], ['Salary Payable', 0, Number(s.payable)]];
  const fin = await ok(h.call('POST', `/hr/runs/${MONTH}/finalise`, {}, 'md'));
  assert.deepEqual([fin.id, fin.status], [run.id, 'finalised'], 'HR\'s answer is the run, as before');
  const first = await bookedAs('hr_run', run.id);
  assert.deepEqual([first.voucher_type, first.voucher_date, first.narration], ['journal', MONTH_END, `Payroll ${MON} ${MONTH.slice(0, 4)} · 6 people`]);
  assert.deepEqual(await linesOf(first.id), journal(await sums()));
  assert.deepEqual(await vouchersOf('hr_sheet_adv', run.id), [], 'no advance was written on the month\'s payroll sheet');

  // The loan's instalment for the finalised month, corrected (the MD confirms it): the journal is reversed and posted again as HR has it now.
  const batchBefore = await bookedAs('hr_batch', (await lineOf(people.r1)).payment_batch_id);
  const correct = { month: MONTH, amount: 1000, scope: 'month', confirm_finalised: true, note: 'Test correction' };
  const res = await ok(h.call('PUT', `/hr/loans/${rLoan.id}/month-instalment`, correct, 'md'));
  assert.equal(res.change.loan.to, '1000.00', 'HR\'s answer, as before');
  const corrected = await bookedAs('hr_run', run.id);
  assert.notEqual(corrected.id, first.id);
  assert.ok((await voucherRow(first.id)).reversed_by_id, 'the first journal is reversed');
  assert.deepEqual(await linesOf(corrected.id), journal(await sums()));
  // The line was paid already: HR settles the difference in the next open month, and the money that left (the batch) is as it was.
  assert.deepEqual(await bookedAs('hr_batch', (await lineOf(people.r1)).payment_batch_id), batchBefore);
  // The same correction again changes nothing, and Finance books nothing new.
  const before = await financeState();
  await ok(h.call('PUT', `/hr/loans/${rLoan.id}/month-instalment`, correct, 'md'));
  assert.equal(await financeState(), before);

  // Un-finalised: the journal comes out of the books.
  await ok(h.call('POST', `/hr/runs/${MONTH}/unfinalise`, { reason: 'Test: unlock the month' }, 'md'));
  assert.ok((await voucherRow(corrected.id)).reversed_by_id, 'the journal is reversed');
  assert.deepEqual((await vouchersOf('hr_run', run.id)).filter(v => v.status === 'posted' && v.reversed_by_id == null), []);
});

// ── Hidden people: the sweep after a month end ───────────────────────────────────────────────

test('after a month that has ended, an HR request posts the hidden people\'s combined entry; a second request writes nothing', gate, async () => {
  const hp = await fx.person({ name: 'Test Hidden Person' });
  await fx.hide(hp, { user: h.users.acct.id });
  // The MD pays the hidden person (an HR admin sees everyone); Finance keeps it for the month's combined entry.
  await ok(h.call('POST', '/hr/staff-payments', { person_id: hp, kind: 'advance', amount: 2500, paid_on: TODAY, paid_via: OFFICE }, 'md'));
  const row = await h.db.one('SELECT id FROM hr.advance_txns WHERE person_id = $1', [hp]);
  assert.deepEqual(await vouchersOf('hr_advance', row.id), [], 'a hidden person\'s money never posts on its own');
  const yyyymm = Number(MONTH.replace('-', ''));
  const combined = () => vouchersOf(`hr_hidden:${L['Office cash']}`, yyyymm);
  assert.deepEqual(await combined(), [], 'the month has not ended: nothing combined yet');

  // An HR request after the month's end (finHrAfter with the day it runs on) posts the month's combined entry …
  const req = { user: { id: h.users.md.id, name: 'Test MD' }, hr: { level: 'admin' } };
  await feed.finHrAfter(req, [], { asOf: `${NEXT}-01` });
  const [entry] = await combined();
  assert.ok(entry, 'the combined entry is posted');
  const v = await voucherRow(entry.id);
  assert.deepEqual([v.status, v.voucher_date, v.narration], ['posted', TODAY, 'Staff money · combined · 1 person']);
  assert.deepEqual(await linesOf(v.id), [['Staff Advances', 2500 * R, 0], ['Office cash', 0, 2500 * R]]);
  // … and the next one writes nothing.
  const before = await financeState();
  await feed.finHrAfter(req, [], { asOf: `${NEXT}-01` });
  assert.equal(await financeState(), before);
});

test('finHrAfter logs an event it does not know (a wiring slip leaves a trace), by its code alone', gate, async () => {
  const req = { user: { id: h.users.acct.id, name: 'Test Accountant' }, hr: { level: 'accounts' } };
  const before = await financeState();
  const logged = await feedLog(() => feed.finHrAfter(req, [{ type: 'nonsense', id: 1 }, { type: 'advance' }]));
  assert.deepEqual(logged, ['[finance-hr] unknown_event', '[finance-hr] unknown_event']);
  assert.equal(await financeState(), before);
});

// ── Last: over everything the doors booked ───────────────────────────────────────────────────

test('privacy: no person\'s name or code reaches Finance from HR\'s doors', gate, async () => {
  const persons = await h.db.q('SELECT name, code FROM hr.people');
  assert.ok(persons.length >= 15, `non-vacuous: ${persons.length} people`);
  assert.ok((await count('fin_vouchers', `source_type LIKE 'hr\\_%'`)) >= 15, 'non-vacuous: the doors booked their money');
  const texts = [
    ...(await h.db.q('SELECT narration, reference, created_by, submitted_by, approved_by, posted_by FROM fin_vouchers')).flatMap(v => Object.values(v)),
    ...(await h.db.q('SELECT narration, bill_ref FROM fin_voucher_lines')).flatMap(l => Object.values(l)),
    ...(await h.db.q('SELECT user_name, reason, before::text AS before, after::text AS after FROM fin_audit_log')).flatMap(a => Object.values(a)),
    ...(await h.db.q('SELECT reason FROM fin_hr_exceptions')).map(x => x.reason),
  ].filter(t => typeof t === 'string');
  for (const { name, code } of persons) {
    for (const word of [name, code]) assert.equal(texts.find(t => t.includes(word)), undefined, `${word} reached Finance`);
  }
});
