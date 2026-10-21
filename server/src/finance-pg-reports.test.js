import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg } from './finance-pg-harness.js';
import { setKnownTables } from './data-tables.js';
import { plantDateStr } from './plant-calendar.js';

// Reports: the trial balance, a ledger's statement, the journal register, the self-approved list and the activity
// log (spec §8, §9.1, §9.2). Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-reports.test.js
//
// One boot for the file; books CI and DP set up with the six logins of FIN_TEST_USERS. The tests share the database
// and run in order, and the order matters: the brief's six come first, on exactly the brief's four vouchers, and
// every test after them adds only what the ones before it can do without. The last three leave the books changed
// for good (600 audit rows; a loop in the group tree; a posted Opening voucher), so nothing comes after them.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100; // paise per rupee

let h;
let CI, DP;                                  // book ids
let G, GD;                                   // group ids by name with the punctuation taken out, CI's and DP's
let ALPHA, RENT, FREIGHT, CUST_A;            // CI's Alpha Bank, Rent, Freight and Customer A
let DP_RENT;                                 // DP's DP Rent
let STATIONERY;                              // made by the groups test, used by the tests after it
const V = {};                                // the brief's four vouchers: receipt, payment, journal, reversal

const strip = name => name.replace(/[^A-Za-z0-9]/g, '');
const groupMap = async book => Object.fromEntries((await h.call('GET', `/finance/books/${book}/groups`)).body.groups.map(g => [strip(g.name), g.id]));
const ledger = async (book, group, name, extra = {}) => {
  const r = await h.call('POST', '/finance/ledgers', { book_id: book, group_id: group, name, ...extra }, 'acct');
  assert.equal(r.status, 200, `ledger ${name}: ${JSON.stringify(r.body)}`);
  return r.body.ledger.id;
};

// A line is written [ledgerId, debit_paise, credit_paise]; L turns it into the line object the API takes.
const L = ([ledger_id, debit_paise, credit_paise]) => ({ ledger_id, debit_paise, credit_paise });
const draft = async (who, voucher_type, voucher_date, lines, narration, book_id = CI) => {
  const r = await h.call('POST', '/finance/vouchers', { book_id, voucher_type, voucher_date, client_key: randomUUID(), narration, lines: lines.map(L) }, who);
  assert.equal(r.status, 200, `${voucher_type} draft: ${JSON.stringify(r.body)}`);
  return r.body.voucher;
};
const send = async (id, who) => {
  const r = await h.call('POST', `/finance/vouchers/${id}/submit`, null, who);
  assert.equal(r.status, 200, `submit: ${JSON.stringify(r.body)}`);
  return r.body.voucher;
};
// A voucher made and sent on in one go. Resolves to the voucher as the submit left it.
const postAs = async (who, voucher_type, voucher_date, lines, narration) => send((await draft(who, voucher_type, voucher_date, lines, narration)).id, who);

before(async () => {
  if (!ON) return;
  h = await finBootPg('reports');
  ({ CI, DP } = Object.fromEntries((await h.db.q('SELECT id, code FROM fin_books')).map(b => [b.code, b.id])));
  G = await groupMap(CI);
  GD = await groupMap(DP);
  // The CI ledgers of Task 8.
  ALPHA = await ledger(CI, G.BankAccounts, 'Alpha Bank');
  RENT = await ledger(CI, G.IndirectExpenses, 'Rent');
  FREIGHT = await ledger(CI, G.DirectExpenses, 'Freight');
  const customer = await h.db.one('SELECT id FROM customers ORDER BY id LIMIT 1');
  CUST_A = await ledger(CI, G.SundryDebtors, 'Customer A', { party_type: 'customer', party_id: customer.id });
  // The one-book fixture: DP has ledgers of its own, and the DP-only login keeps one draft there, so what it
  // reads from the activity log is more than the rows setup wrote.
  DP_RENT = await ledger(DP, GD.IndirectExpenses, 'DP Rent');
  const dpFreight = await ledger(DP, GD.DirectExpenses, 'DP Freight');
  await draft('dpOnly', 'journal', '2027-01-12', [[DP_RENT, 700 * R, 0], [dpFreight, 0, 700 * R]], 'DP rent', DP);

  // The brief's fixture, posted by the MD. The MD is an Approver, so each posts the moment it is sent. The receipt
  // (rule never) and the payment (under the limit) need no approval; the journal (rule always) and its reversal do,
  // so those two are self-approved.
  V.receipt = await postAs('md', 'receipt', '2027-01-05', [[ALPHA, 100000 * R, 0], [CUST_A, 0, 100000 * R]], 'receipt from Customer A');
  V.payment = await postAs('md', 'payment', '2027-01-20', [[RENT, 25000 * R, 0], [ALPHA, 0, 25000 * R]], 'January rent');
  V.journal = await postAs('md', 'journal', '2027-02-03', [[FREIGHT, 5000 * R, 0], [RENT, 0, 5000 * R]], 'freight accrual');
  const back = await h.call('POST', `/finance/vouchers/${V.journal.id}/reverse`, { date: '2027-02-10', reason: 'accrued twice' }, 'md');
  assert.equal(back.status, 200, JSON.stringify(back.body));
  V.reversal = back.body.voucher;
  for (const [name, v] of Object.entries(V)) assert.equal(v.status, 'posted', `the ${name} is posted`);
  assert.deepEqual(Object.values(V).map(v => v.self_approved), [false, false, true, true], 'only the journal and its reversal were self-approved');
});

after(async () => { await h?.close(); });

// ── The brief's six ──────────────────────────────────────────────────────────────────────────

test('trial balance as at 31 Jan balances and shows each ledger signed Dr/Cr', gate, async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2027-01-31`, null, 'viewer')).body;
  const by = Object.fromEntries(tb.ledgers.map(l => [l.name, l.closing_paise]));
  assert.deepEqual([by['Alpha Bank'], by['Customer A'], by['Rent']], [75000 * R, -100000 * R, 25000 * R]);
  assert.equal(tb.totals.closing_dr, tb.totals.closing_cr);
  assert.equal(tb.totals.closing_dr, 100000 * R);
});

test('a February range carries January in its opening and nets the reversed journal to zero', gate, async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&from=2027-02-01&to=2027-02-28`)).body;
  const f = tb.ledgers.find(l => l.name === 'Freight');
  assert.deepEqual([f.opening_paise, f.debit_paise, f.credit_paise, f.closing_paise], [0, 5000 * R, 5000 * R, 0]);
  assert.equal(tb.ledgers.find(l => l.name === 'Rent').opening_paise, 25000 * R);
  assert.equal(tb.totals.opening_dr, tb.totals.opening_cr);
  assert.equal(tb.totals.debit, tb.totals.credit);
});

test('groups roll up their ledgers', gate, async () => {
  const tb = (await h.call('GET', `/finance/reports/trial-balance?book=${CI}&to=2027-01-31`)).body;
  assert.equal(tb.groups.find(g => g.name === 'Current Assets').closing_paise, (75000 - 100000) * R);
});

test('a ledger statement runs its balance and closes on the trial balance figure', gate, async () => {
  const s = (await h.call('GET', `/finance/reports/ledger?ledger=${ALPHA}&from=2027-01-01&to=2027-01-31`)).body;
  assert.deepEqual(s.entries.map(e => e.balance_paise), [100000 * R, 75000 * R]);
  assert.equal(s.closing_paise, 75000 * R);
  assert.match(s.entries[0].against, /Customer A/);
});

test('journal register and self-approved list what was posted', gate, async () => {
  const j = (await h.call('GET', `/finance/reports/journal-register?book=${CI}&from=2027-02-01&to=2027-02-28&type=journal`)).body;
  assert.equal(j.vouchers.length, 2);
  const sa = (await h.call('GET', `/finance/reports/self-approved?book=${CI}&from=2027-01-01&to=2027-03-31`)).body;
  assert.equal(sa.vouchers.length, 2); // the journal (rule always) and its reversal; receipt and small payment need no approval
});

test('one-book logins never see the other book', gate, async () => {
  assert.equal((await h.call('GET', `/finance/reports/trial-balance?book=${DP}&to=2027-03-31`, null, 'viewer')).status, 403);
  assert.equal((await h.call('GET', `/finance/reports/ledger?ledger=${ALPHA}&from=2027-01-01&to=2027-01-31`, null, 'dpOnly')).status, 403);
  const act = (await h.call('GET', '/finance/activity', null, 'dpOnly')).body.rows;
  assert.ok(act.length > 0 && act.every(r => r.book_id === DP));
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────

const get = (url, who = 'md') => h.call('GET', url, null, who);
const ok = async (url, who = 'md') => {
  const r = await get(url, who);
  assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  return r.body;
};
const tbOf = (qs, who, book = CI) => ok(`/finance/reports/trial-balance?book=${book}&${qs}`, who);
const stmtOf = (ledgerId, qs, who) => ok(`/finance/reports/ledger?ledger=${ledgerId}&${qs}`, who);
const jrOf = (qs, who, book = CI) => ok(`/finance/reports/journal-register?book=${book}&${qs}`, who);
const saOf = (qs, who, book = CI) => ok(`/finance/reports/self-approved?book=${book}&${qs}`, who);
const actOf = (qs = '', who) => ok(`/finance/activity${qs ? `?${qs}` : ''}`, who);
const figures = l => [l.opening_paise, l.debit_paise, l.credit_paise, l.closing_paise];
const named = tb => Object.fromEntries(tb.ledgers.map(l => [l.name, l]));
// A refusal: its status and code, and the field it names when it is about one.
async function refused(url, who, status, code, field) {
  const r = await get(url, who);
  assert.equal(r.status, status, `${who} ${url}: ${JSON.stringify(r.body)}`);
  if (code) assert.equal(r.body?.code, code, `${who} ${url}: ${JSON.stringify(r.body)}`);
  if (field) assert.equal(r.body.field, field, `${who} ${url}: ${JSON.stringify(r.body)}`);
}

test('a date is inclusive at both ends: dated "to" counts, dated "from" is movement, the day before "from" is opening', gate, async () => {
  const none = await tbOf('to=2027-01-04');
  assert.deepEqual(none.ledgers, [], 'nothing was posted by then');
  assert.deepEqual(none.totals, { opening_dr: 0, opening_cr: 0, debit: 0, credit: 0, closing_dr: 0, closing_cr: 0 });
  const alpha = async qs => figures(named(await tbOf(qs))['Alpha Bank']);
  assert.deepEqual(await alpha('to=2027-01-05'), [0, 100000 * R, 0, 100000 * R]);
  assert.deepEqual(await alpha('from=2027-01-05&to=2027-01-05'), [0, 100000 * R, 0, 100000 * R]);
  assert.deepEqual(await alpha('from=2027-01-06&to=2027-01-31'), [100000 * R, 0, 25000 * R, 75000 * R]);
  assert.deepEqual(await alpha('from=2027-01-20&to=2027-01-20'), [100000 * R, 0, 25000 * R, 75000 * R]);
  assert.deepEqual(await alpha('from=2027-01-21&to=2027-01-31'), [75000 * R, 0, 0, 75000 * R], 'it moved nothing, but it still has a balance, so it is listed');
});

test('a ledger with no figures is left off the trial balance unless all=1, and nothing of the other book is on it', gate, async () => {
  const some = await tbOf('to=2027-01-31');
  assert.deepEqual(some.ledgers.map(l => l.name).sort(), ['Alpha Bank', 'Customer A', 'Rent']);
  const every = await tbOf('to=2027-01-31&all=1');
  const names = every.ledgers.map(l => l.name);
  for (const name of ['Alpha Bank', 'Customer A', 'Rent', 'Freight', 'Cash', 'Profit & Loss A/c']) assert.ok(names.includes(name), `${name} is listed`);
  assert.ok(!names.some(n => n.startsWith('DP ')), "DP's ledgers are not on CI's trial balance");
  for (const l of every.ledgers.filter(l => !some.ledgers.some(s => s.id === l.id))) assert.deepEqual(figures(l), [0, 0, 0, 0], l.name);
  assert.deepEqual(every.totals, some.totals, 'a ledger with no figures adds nothing');
  assert.deepEqual(await tbOf('to=2027-01-31&all=true'), every);
  assert.deepEqual(await tbOf('to=2027-01-31&all=0'), some, 'only 1 and true ask for them all');
  const dp = await tbOf('to=2027-01-31&all=1', 'md', DP);
  assert.ok(dp.ledgers.length > 0 && dp.ledgers.every(l => ['Cash', 'Profit & Loss A/c', 'DP Rent', 'DP Freight'].includes(l.name)), "DP's own ledgers, and only those");
  assert.equal(dp.book_id, DP);
});

test('the trial balance answers exactly what the brief names, and nothing in the groups is left out', gate, async () => {
  const tb = await tbOf('from=2027-02-01&to=2027-02-28');
  assert.deepEqual(Object.keys(tb).sort(), ['book_id', 'from', 'groups', 'ledgers', 'to', 'totals']);
  assert.deepEqual([tb.book_id, tb.from, tb.to], [CI, '2027-02-01', '2027-02-28']);
  assert.deepEqual(Object.keys(tb.totals).sort(), ['closing_cr', 'closing_dr', 'credit', 'debit', 'opening_cr', 'opening_dr']);
  assert.deepEqual(Object.keys(tb.ledgers[0]).sort(), ['closing_paise', 'credit_paise', 'debit_paise', 'group_id', 'id', 'name', 'opening_paise']);
  // ruling R4: the groups carry sort_order, for the screen that sorts the tree by it
  assert.deepEqual(Object.keys(tb.groups[0]).sort(),
    ['closing_paise', 'credit_paise', 'debit_paise', 'depth', 'id', 'name', 'nature', 'opening_paise', 'parent_id', 'sort_order']);
  assert.equal((await tbOf('to=2027-02-28')).from, null, 'no "from" is null');
  // every group of the book, the empty ones too: the screen needs the whole tree to show where a ledger can go
  const listed = (await ok(`/finance/books/${CI}/groups`)).groups;
  assert.equal(tb.groups.length, listed.length);
  const by = Object.fromEntries(tb.groups.map(g => [g.id, g]));
  for (const g of listed) {
    assert.deepEqual([by[g.id].name, by[g.id].parent_id, by[g.id].nature, by[g.id].sort_order], [g.name, g.parent_id, g.nature, g.sort_order]);
  }
  assert.equal(tb.groups.find(g => g.name === 'Investments').closing_paise, 0);
});

test('a ledger statement: opening before "from", each posted line with its voucher and the other side, a running balance', gate, async () => {
  const s = await stmtOf(ALPHA, 'from=2027-01-10&to=2027-01-31');
  assert.deepEqual(Object.keys(s).sort(), ['closing_paise', 'entries', 'ledger', 'opening_paise', 'total_credit_paise', 'total_debit_paise']);
  assert.deepEqual(s.ledger, { id: ALPHA, name: 'Alpha Bank', book_id: CI, group_name: 'Bank Accounts' });
  assert.equal(s.opening_paise, 100000 * R, 'the receipt of the 5th is before "from"');
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0], {
    voucher_id: V.payment.id, number: V.payment.number, voucher_date: '2027-01-20', voucher_type: 'payment', narration: 'January rent',
    against: 'Rent', debit_paise: 0, credit_paise: 25000 * R, balance_paise: 75000 * R,
  });
  assert.match(V.payment.number, /^CI-PV-2627-\d{4}$/);
  assert.deepEqual([s.total_debit_paise, s.total_credit_paise, s.closing_paise], [0, 25000 * R, 75000 * R]);

  const rent = await stmtOf(RENT, 'from=2027-01-01&to=2027-02-28');
  assert.deepEqual(rent.entries.map(e => [e.voucher_id, e.voucher_date, e.voucher_type, e.against, e.debit_paise, e.credit_paise, e.balance_paise]), [
    [V.payment.id, '2027-01-20', 'payment', 'Alpha Bank', 25000 * R, 0, 25000 * R],
    [V.journal.id, '2027-02-03', 'journal', 'Freight', 0, 5000 * R, 20000 * R],
    [V.reversal.id, '2027-02-10', 'journal', 'Freight', 5000 * R, 0, 25000 * R],
  ]);
  assert.deepEqual([rent.opening_paise, rent.total_debit_paise, rent.total_credit_paise, rent.closing_paise], [0, 30000 * R, 5000 * R, 25000 * R]);

  const cust = await stmtOf(CUST_A, 'to=2027-01-31');
  assert.equal(cust.opening_paise, 0, 'with no "from" the opening is nothing and every line is an entry');
  assert.deepEqual(cust.entries.map(e => [e.debit_paise, e.credit_paise, e.balance_paise]), [[0, 100000 * R, -100000 * R]]);
  assert.equal(cust.closing_paise, -100000 * R, 'a credit balance is negative');
});

test('a statement is inclusive at both ends too, and a ledger nobody posted to is an empty statement', gate, async () => {
  const from = async day => stmtOf(ALPHA, `from=${day}&to=2027-01-31`);
  assert.deepEqual([(await from('2027-01-05')).opening_paise, (await from('2027-01-05')).entries.length], [0, 2]);
  assert.deepEqual([(await from('2027-01-06')).opening_paise, (await from('2027-01-06')).entries.length], [100000 * R, 1]);
  const early = await stmtOf(ALPHA, 'to=2027-01-04');
  assert.deepEqual([early.entries, early.closing_paise], [[], 0]);
  assert.equal((await stmtOf(ALPHA, 'from=2027-01-05&to=2027-01-05')).entries.length, 1, 'dated "to" counts');
  const cash = (await ok(`/finance/books/${CI}/ledgers`)).ledgers.find(l => l.name === 'Cash').id;
  assert.deepEqual(await stmtOf(cash, 'from=2027-01-01&to=2027-03-31'), {
    ledger: { id: cash, name: 'Cash', book_id: CI, group_name: 'Cash-in-Hand' },
    opening_paise: 0, entries: [], total_debit_paise: 0, total_credit_paise: 0, closing_paise: 0,
  });
});

test('the journal register lists each posted voucher with its lines, in date order, and the type narrows it', gate, async () => {
  const feb = await jrOf('from=2027-02-01&to=2027-02-28&type=journal');
  assert.deepEqual(feb.vouchers.map(v => [v.id, v.voucher_date, v.voucher_type, v.total_paise]), [
    [V.journal.id, '2027-02-03', 'journal', 5000 * R],
    [V.reversal.id, '2027-02-10', 'journal', 5000 * R],
  ]);
  assert.deepEqual(Object.keys(feb.vouchers[0]).sort(), ['id', 'lines', 'narration', 'number', 'total_paise', 'voucher_date', 'voucher_type']);
  assert.deepEqual(feb.vouchers[0].lines, [
    { ledger_name: 'Freight', debit_paise: 5000 * R, credit_paise: 0 },
    { ledger_name: 'Rent', debit_paise: 0, credit_paise: 5000 * R },
  ]);
  assert.deepEqual(feb.vouchers[1].lines, [
    { ledger_name: 'Freight', debit_paise: 0, credit_paise: 5000 * R },
    { ledger_name: 'Rent', debit_paise: 5000 * R, credit_paise: 0 },
  ], 'the reversal mirrors the journal, line for line');
  assert.deepEqual([feb.vouchers[0].number, feb.vouchers[0].narration], [V.journal.number, 'freight accrual']);
  assert.match(feb.vouchers[1].narration, /^Reversal of /);

  const jan = await jrOf('from=2027-01-01&to=2027-01-31');
  assert.deepEqual(jan.vouchers.map(v => [v.voucher_type, v.number, v.total_paise]), [
    ['receipt', V.receipt.number, 100000 * R],
    ['payment', V.payment.number, 25000 * R],
  ], 'no type: every type');
  assert.deepEqual((await jrOf('from=2027-01-01&to=2027-01-31&type=payment')).vouchers.map(v => v.id), [V.payment.id]);
  assert.deepEqual((await jrOf('from=2027-01-01&to=2027-01-31&type=contra')).vouchers, []);
  assert.deepEqual((await jrOf('from=2027-01-05&to=2027-01-05')).vouchers.map(v => v.id), [V.receipt.id], 'a one-day range');
  assert.deepEqual((await jrOf('to=2027-01-31', 'md', DP)).vouchers, [], "DP posted nothing, and CI's vouchers are not DP's");
});

test('self-approved lists only the vouchers an Approver passed on their own authority, without their lines', gate, async () => {
  const sa = await saOf('from=2027-01-01&to=2027-03-31');
  assert.deepEqual(sa.vouchers.map(v => [v.id, v.voucher_date, v.voucher_type, v.total_paise]), [
    [V.journal.id, '2027-02-03', 'journal', 5000 * R],
    [V.reversal.id, '2027-02-10', 'journal', 5000 * R],
  ]);
  assert.deepEqual(Object.keys(sa.vouchers[0]).sort(), ['id', 'narration', 'number', 'total_paise', 'voucher_date', 'voucher_type']);
  assert.deepEqual((await saOf('from=2027-02-05&to=2027-02-28')).vouchers.map(v => v.id), [V.reversal.id]);
  assert.deepEqual((await saOf('to=2027-02-09')).vouchers.map(v => v.id), [V.journal.id]);
  assert.deepEqual((await saOf('to=2027-02-28', 'md', DP)).vouchers, []);
});

test('only posted vouchers count: a draft, an entry waiting for approval and a discarded one change nothing', gate, async () => {
  const snapshot = async () => ({
    tb: await tbOf('to=2027-03-31&all=1'),
    ledger: await stmtOf(RENT, 'to=2027-03-31'),
    register: await jrOf('from=2027-03-01&to=2027-03-31'),
    selfApproved: await saOf('from=2027-03-01&to=2027-03-31'),
  });
  const before = await snapshot();
  await draft('acct', 'journal', '2027-03-15', [[RENT, 111 * R, 0], [FREIGHT, 0, 111 * R]], 'left as a draft');
  const waiting = await send((await draft('acct', 'journal', '2027-03-15', [[RENT, 222 * R, 0], [FREIGHT, 0, 222 * R]], 'waits for the MD')).id, 'acct');
  assert.equal(waiting.status, 'submitted');
  const gone = await draft('acct', 'journal', '2027-03-15', [[RENT, 333 * R, 0], [FREIGHT, 0, 333 * R]], 'thrown away');
  assert.equal((await h.call('POST', `/finance/vouchers/${gone.id}/discard`, null, 'acct')).body.voucher.status, 'discarded');
  assert.deepEqual(await snapshot(), before);
});

test('groups roll up through the tree in tree order, with their depth; a sub-group added later sits under its parent', gate, async () => {
  const group = async (parent_id, name) => {
    const r = await h.call('POST', '/finance/groups', { book_id: CI, parent_id, name }, 'md');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.group.id;
  };
  const admin = await group(G.IndirectExpenses, 'Admin Expenses');
  const supplies = await group(admin, 'Office Supplies');
  STATIONERY = await ledger(CI, supplies, 'Stationery');
  await postAs('md', 'journal', '2027-03-08', [[STATIONERY, 1200 * R, 0], [CUST_A, 0, 1200 * R]], 'stationery on account');

  const tb = await tbOf('to=2027-03-10');
  const g = Object.fromEntries(tb.groups.map(x => [x.name, x]));
  const names = tb.groups.map(x => x.name);
  const at = names.indexOf('Indirect Expenses');
  assert.deepEqual(names.slice(at, at + 4), ['Indirect Expenses', 'Admin Expenses', 'Office Supplies', 'Profit & Loss'],
    'a group is followed by its own sub-groups, not by whatever sort_order says');
  assert.ok(g['Office Supplies'].sort_order > g['Profit & Loss'].sort_order, 'sort_order alone would have put it last');
  assert.deepEqual(['Current Assets', 'Bank Accounts', 'Indirect Expenses', 'Admin Expenses', 'Office Supplies'].map(n => g[n].depth), [0, 1, 0, 1, 2]);
  assert.deepEqual(['Indirect Expenses', 'Admin Expenses', 'Office Supplies'].map(n => g[n].parent_id), [null, G.IndirectExpenses, admin]);
  assert.equal(new Set(names).size, names.length, 'each group once');
  assert.deepEqual(figures(g['Office Supplies']), [0, 1200 * R, 0, 1200 * R]);
  assert.deepEqual(figures(g['Admin Expenses']), [0, 1200 * R, 0, 1200 * R]);
  assert.deepEqual(figures(g['Indirect Expenses']), [0, 31200 * R, 5000 * R, 26200 * R], "Rent's 25,000 and 5,000 back, less its 5,000, and the stationery");
  assert.equal(g['Sundry Debtors'].closing_paise, -101200 * R);
  assert.equal(g['Current Assets'].closing_paise, (75000 - 101200) * R);

  // The same figures worked out the long way: a group is its own ledgers and every ledger under its sub-groups.
  const under = id => [id, ...tb.groups.filter(x => x.parent_id === id).flatMap(x => under(x.id))];
  for (const grp of tb.groups) {
    const ids = new Set(under(grp.id));
    const own = tb.ledgers.filter(l => ids.has(l.group_id));
    for (const f of ['opening_paise', 'debit_paise', 'credit_paise', 'closing_paise']) {
      assert.equal(grp[f], own.reduce((sum, l) => sum + l[f], 0), `${grp.name} ${f}`);
    }
  }
  const total = pick => tb.ledgers.reduce((sum, l) => sum + pick(l), 0);
  assert.deepEqual(tb.totals, {
    opening_dr: total(l => Math.max(l.opening_paise, 0)), opening_cr: total(l => Math.max(-l.opening_paise, 0)),
    debit: total(l => l.debit_paise), credit: total(l => l.credit_paise),
    closing_dr: total(l => Math.max(l.closing_paise, 0)), closing_cr: total(l => Math.max(-l.closing_paise, 0)),
  });
  assert.equal(tb.totals.closing_dr, 101200 * R);
  assert.equal(tb.totals.closing_dr, tb.totals.closing_cr);
  assert.equal(tb.totals.debit, tb.totals.credit);
});

test('"against" names the other ledgers of the voucher once each, three at most, then an ellipsis', gate, async () => {
  const insurance = await ledger(CI, G.IndirectExpenses, 'Insurance');
  const repairs = await ledger(CI, G.IndirectExpenses, 'Repairs');
  const power = await ledger(CI, G.IndirectExpenses, 'Electricity');
  // Four ledgers on five lines (Repairs twice): three others for each of Insurance, Repairs and Customer A, so no ellipsis.
  await postAs('md', 'journal', '2027-03-12',
    [[insurance, 100 * R, 0], [repairs, 60 * R, 0], [repairs, 40 * R, 0], [power, 50 * R, 0], [CUST_A, 0, 250 * R]], 'four ledgers');
  // Five ledgers: four others for Customer A and for Insurance, so the fourth is cut.
  await postAs('md', 'journal', '2027-03-13',
    [[insurance, 10 * R, 0], [repairs, 10 * R, 0], [power, 10 * R, 0], [STATIONERY, 10 * R, 0], [CUST_A, 0, 40 * R]], 'five ledgers');

  const cust = await stmtOf(CUST_A, 'from=2027-03-12&to=2027-03-13');
  assert.deepEqual(cust.entries.map(e => e.against), ['Insurance, Repairs, Electricity', 'Insurance, Repairs, Electricity…']);
  const ins = await stmtOf(insurance, 'from=2027-03-12&to=2027-03-13');
  assert.deepEqual(ins.entries.map(e => e.against), ['Repairs, Electricity, Customer A', 'Repairs, Electricity, Stationery…']);
  const rep = await stmtOf(repairs, 'from=2027-03-12&to=2027-03-13');
  assert.deepEqual(rep.entries.map(e => [e.debit_paise, e.credit_paise, e.balance_paise]), [
    [60 * R, 0, 60 * R], [40 * R, 0, 100 * R], [10 * R, 0, 110 * R],
  ], 'a ledger on two lines of one voucher has an entry for each line');
  assert.equal(rep.entries[0].voucher_id, rep.entries[1].voucher_id);
});

test('entries come in voucher date order, then the order they were posted in, not the order they were made in', gate, async () => {
  const make = (date, rupees) => draft('md', 'journal', date, [[RENT, rupees * R, 0], [FREIGHT, 0, rupees * R]], `ordering ${rupees}`);
  const x = await make('2027-03-20', 71);                      // made first
  const y = await make('2027-03-20', 72);
  const z = await make('2027-03-19', 73);                      // made last, but dated the day before
  assert.ok(x.id < y.id && y.id < z.id);
  for (const v of [y, x, z]) await send(v.id, 'md');           // posted in this order: y, x, z
  const want = [z.id, y.id, x.id];                             // by date, and on the 20th by posting
  assert.deepEqual((await stmtOf(FREIGHT, 'from=2027-03-19&to=2027-03-20')).entries.map(e => e.voucher_id), want);
  assert.deepEqual((await jrOf('from=2027-03-19&to=2027-03-20')).vouchers.map(v => v.id), want);
  assert.deepEqual((await saOf('from=2027-03-19&to=2027-03-20')).vouchers.map(v => v.id), want);
  assert.deepEqual((await stmtOf(FREIGHT, 'from=2027-03-19&to=2027-03-20')).entries.map(e => e.balance_paise), [-73 * R, -145 * R, -216 * R],
    'the running balance follows that order');
});

test('a ledger statement closes on the trial balance figure for every ledger and every range', gate, async () => {
  const inTheBook = (await ok(`/finance/books/${CI}/ledgers`)).ledgers.length;
  assert.ok(inTheBook >= 10, `${inTheBook} ledgers`);
  for (const qs of ['to=2027-03-31', 'from=2027-02-01&to=2027-03-31', 'from=2027-01-20&to=2027-02-10', 'from=2027-03-13&to=2027-03-13']) {
    const tb = await tbOf(`${qs}&all=1`);
    assert.equal(tb.ledgers.length, inTheBook, 'all=1 lists every ledger of the book');
    for (const l of tb.ledgers) {
      const s = await stmtOf(l.id, qs);
      assert.deepEqual([s.opening_paise, s.total_debit_paise, s.total_credit_paise, s.closing_paise], figures(l), `${l.name} over ${qs}`);
      assert.equal(s.opening_paise + s.total_debit_paise - s.total_credit_paise, s.closing_paise, `${l.name} adds up`);
      assert.equal(s.entries.at(-1)?.balance_paise ?? s.opening_paise, s.closing_paise, `${l.name} runs to its closing`);
      let run = s.opening_paise;
      for (const e of s.entries) { run += e.debit_paise - e.credit_paise; assert.equal(e.balance_paise, run, `${l.name} ${e.number}`); }
    }
  }
});

test('every report answers a login with no grant on the book 403, and a malformed request 400', gate, async () => {
  const day = '&from=2027-01-01&to=2027-01-31';
  const tbUrl = book => `/finance/reports/trial-balance?book=${book}${day}`;
  const jrUrl = book => `/finance/reports/journal-register?book=${book}${day}`;
  const saUrl = book => `/finance/reports/self-approved?book=${book}${day}`;
  const stUrl = (ledgerId, extra = '') => `/finance/reports/ledger?ledger=${ledgerId}${extra}${day}`;
  // plant is a plant admin with no Finance grant at all; dpOnly holds DP only; viewer holds CI only
  for (const who of ['plant', 'dpOnly']) {
    for (const url of [tbUrl(CI), jrUrl(CI), saUrl(CI), stUrl(ALPHA), stUrl(ALPHA, `&book=${DP}`), `/finance/activity?book=${CI}`]) await refused(url, who, 403, 'FIN_FORBIDDEN');
  }
  for (const url of [tbUrl(DP), jrUrl(DP), saUrl(DP), stUrl(DP_RENT), `/finance/activity?book=${DP}`]) await refused(url, 'viewer', 403, 'FIN_FORBIDDEN');
  await refused(`/finance/activity?book=${DP}`, 'plant', 403, 'FIN_FORBIDDEN');
  await refused(tbUrl(999999), 'md', 403, 'FIN_FORBIDDEN');
  await refused(stUrl(999999), 'md', 403, 'FIN_FORBIDDEN');
  // a login with no grant at all is refused the log with no book named too (spec §14), as the vouchers list refuses it
  await refused('/finance/activity', 'plant', 403, 'FIN_FORBIDDEN');
  await refused('/finance/activity?entity=voucher', 'plant', 403, 'FIN_FORBIDDEN');
  // the logins that do hold the book read it
  for (const url of [tbUrl(CI), jrUrl(CI), saUrl(CI), stUrl(ALPHA), `/finance/activity?book=${CI}`]) await ok(url, 'viewer');
  for (const url of [tbUrl(DP), jrUrl(DP), saUrl(DP), stUrl(DP_RENT), `/finance/activity?book=${DP}`]) await ok(url, 'acct');
  await ok(stUrl(DP_RENT), 'dpOnly');

  // malformed
  for (const [path, query] of [['trial-balance', 'to=2027-01-31'], ['journal-register', ''], ['self-approved', '']]) {
    await refused(`/finance/reports/${path}?${query}`, 'md', 400, 'FIN_BAD_INPUT', 'book');
    await refused(`/finance/reports/${path}?book=abc&${query}`, 'md', 400, 'FIN_BAD_INPUT', 'book');
    await refused(`/finance/reports/${path}?book=0&${query}`, 'md', 400, 'FIN_BAD_INPUT', 'book');
    await refused(`/finance/reports/${path}?book[]=${CI}&${query}`, 'md', 400, 'FIN_BAD_INPUT', 'book');
  }
  await refused(`/finance/reports/trial-balance?book=${CI}`, 'md', 400, 'FIN_BAD_INPUT', 'to');
  await refused(`/finance/reports/trial-balance?book=${CI}&to=`, 'md', 400, 'FIN_BAD_INPUT', 'to');
  await refused(`/finance/reports/ledger?ledger=${ALPHA}`, 'md', 400, 'FIN_BAD_INPUT', 'to');
  await refused('/finance/reports/ledger?to=2027-01-31', 'md', 400, 'FIN_BAD_INPUT', 'ledger');
  await refused('/finance/reports/ledger?ledger=abc&to=2027-01-31', 'md', 400, 'FIN_BAD_INPUT', 'ledger');
  await refused('/finance/reports/ledger?ledger=0&to=2027-01-31', 'md', 400, 'FIN_BAD_INPUT', 'ledger');
  for (const bad of ['2027-02-30', '2027-1-5', 'today', '31/01/2027', '20270131']) {
    await refused(`/finance/reports/trial-balance?book=${CI}&to=${bad}`, 'md', 400, 'FIN_BAD_DATE', 'to');
    await refused(`/finance/reports/trial-balance?book=${CI}&from=${bad}&to=2027-01-31`, 'md', 400, 'FIN_BAD_DATE', 'from');
    await refused(`/finance/reports/ledger?ledger=${ALPHA}&from=${bad}&to=2027-01-31`, 'md', 400, 'FIN_BAD_DATE', 'from');
    await refused(`/finance/reports/journal-register?book=${CI}&to=${bad}`, 'md', 400, 'FIN_BAD_DATE', 'to');
    await refused(`/finance/reports/self-approved?book=${CI}&from=${bad}`, 'md', 400, 'FIN_BAD_DATE', 'from');
    await refused(`/finance/activity?from=${bad}`, 'md', 400, 'FIN_BAD_DATE', 'from');
  }
  for (const url of [
    `/finance/reports/trial-balance?book=${CI}&from=2027-02-01&to=2027-01-31`,
    `/finance/reports/ledger?ledger=${ALPHA}&from=2027-02-01&to=2027-01-31`,
    `/finance/reports/journal-register?book=${CI}&from=2027-02-01&to=2027-01-31`,
    `/finance/reports/self-approved?book=${CI}&from=2027-02-01&to=2027-01-31`,
    '/finance/activity?from=2027-02-01&to=2027-01-31',
  ]) await refused(url, 'md', 400, 'FIN_BAD_INPUT', 'from');
  await refused(`/finance/reports/journal-register?book=${CI}&type=bogus`, 'md', 400, 'FIN_BAD_INPUT', 'type');
  await refused(`/finance/reports/journal-register?book=${CI}&type=constructor`, 'md', 400, 'FIN_BAD_INPUT', 'type');
  await refused('/finance/activity?book=abc', 'md', 400, 'FIN_BAD_INPUT', 'book');
  await refused('/finance/activity?book=', 'md', 400, 'FIN_BAD_INPUT', 'book');
  await refused('/finance/activity?user=a&user=b', 'md', 400, 'FIN_BAD_INPUT', 'user');
  await refused(`/finance/activity?entity=${'x'.repeat(41)}`, 'md', 400, 'FIN_BAD_INPUT', 'entity');
  // a refusal is the same wherever it comes from: nothing about the book leaks to a login that has no grant on it
  const missing = await get(tbUrl(999999), 'md');
  const forbidden = await get(tbUrl(DP), 'viewer');
  assert.deepEqual(missing.body, forbidden.body);
});

test('the reports are read-only and tell the response cache which tables they read', gate, async () => {
  setKnownTables(['fin_audit_log', 'fin_groups', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers', 'fin_access']);
  const raw = async path => {
    const res = await fetch(h.base + path, { headers: { authorization: `Bearer ${h.users.md.token}` } });
    assert.equal(res.status, 200, path);
    await res.json();
    return res.headers;
  };
  const tables = headers => (headers.get('x-data-tables') ?? '').split(',').filter(Boolean);
  const cases = [
    [`/finance/reports/trial-balance?book=${CI}&to=2027-03-31`, ['fin_groups', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/reports/ledger?ledger=${ALPHA}&to=2027-03-31`, ['fin_groups', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/reports/journal-register?book=${CI}`, ['fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/reports/self-approved?book=${CI}`, ['fin_vouchers']],
    ['/finance/activity', ['fin_audit_log']],
    [`/finance/activity/${(await h.db.one('SELECT MIN(id)::int AS id FROM fin_audit_log WHERE book_id = $1', [CI])).id}`, ['fin_audit_log']],
  ];
  for (const [path, expected] of cases) {
    const headers = await raw(path);
    assert.ok(headers.get('x-data-tables'), `${path} is cacheable`);
    assert.equal(headers.get('x-data-wrote'), null, `${path} writes nothing`);
    for (const t of expected) assert.ok(tables(headers).includes(t), `${path} lists ${t}: ${headers.get('x-data-tables')}`);
    assert.ok(!tables(headers).includes('fin_access'), `${path}: who may ask is not part of the answer`);
  }
});

test('activity: newest first, only the books the login may read, and every filter narrows it', gate, async () => {
  const everything = (await actOf()).rows;                                   // the MD holds both books
  assert.ok(everything.length > 40 && everything.length < 500, `${everything.length} rows`);
  // Summaries only (ruling R71): the record before and after is one row's, opened (GET /finance/activity/:id).
  assert.deepEqual(Object.keys(everything[0]).sort(), ['action', 'at', 'book_id', 'entity', 'entity_id', 'id', 'label', 'reason', 'user_name']);
  const newest = await h.db.q('SELECT id FROM fin_audit_log ORDER BY at DESC, id DESC LIMIT 500');
  assert.deepEqual(everything.map(r => r.id), newest.map(r => r.id), 'newest first');
  assert.ok(everything.every((r, i) => i === 0 || everything[i - 1].at >= r.at), 'by time');
  assert.deepEqual([...new Set(everything.map(r => r.book_id))].sort(), [CI, DP].sort());

  // books
  const of = async (book, who) => (await actOf(`book=${book}`, who)).rows;
  assert.ok((await of(CI)).length > 0 && (await of(CI)).every(r => r.book_id === CI));
  assert.ok((await of(DP)).length > 0 && (await of(DP)).every(r => r.book_id === DP));
  assert.equal((await of(CI)).length + (await of(DP)).length, everything.length);
  const asViewer = (await actOf('', 'viewer')).rows;
  assert.ok(asViewer.length > 0 && asViewer.every(r => r.book_id === CI), 'a CI-only login reads CI only');
  const asDp = (await actOf('', 'dpOnly')).rows;
  assert.ok(asDp.length > 0 && asDp.every(r => r.book_id === DP), 'a DP-only login reads DP only');
  assert.deepEqual((await of(DP, 'dpOnly')).map(r => r.id), asDp.map(r => r.id));
  assert.deepEqual(asDp.map(r => r.user_name).filter(n => n === 'Test DP Accountant').length > 0, true, "its own draft is in it");

  // the voucher rows name the voucher; opened, they carry it before and after
  const created = everything.find(r => r.entity === 'voucher' && r.action === 'create' && r.entity_id === V.receipt.id);
  assert.deepEqual([created.user_name, created.label], ['Test MD', `Draft #${V.receipt.id}`]);
  const createdOpen = (await ok(`/finance/activity/${created.id}`)).row;
  assert.deepEqual([createdOpen.before, createdOpen.after.status, createdOpen.after.lines.length], [null, 'draft', 2]);
  const posted = everything.find(r => r.entity === 'voucher' && r.action === 'post' && r.entity_id === V.receipt.id);
  assert.equal(posted.label, V.receipt.number);
  const postedOpen = (await ok(`/finance/activity/${posted.id}`)).row;
  assert.deepEqual([postedOpen.after.status, postedOpen.after.number], ['posted', V.receipt.number]);
  assert.match(everything.find(r => r.action === 'reverse').reason, /accrued twice/);

  // entity
  const ledgers = (await actOf('entity=ledger')).rows;
  const inDb = await h.db.q(`SELECT id FROM fin_audit_log WHERE entity = 'ledger' ORDER BY at DESC, id DESC`);
  assert.ok(ledgers.length > 5 && ledgers.every(r => r.entity === 'ledger'));
  assert.deepEqual(ledgers.map(r => r.id), inDb.map(r => r.id));
  assert.deepEqual((await actOf('entity=nothing-like-this')).rows, []);
  assert.deepEqual((await actOf(`entity=voucher&book=${DP}`)).rows.map(r => r.action), ['create']);

  // user: the name, whatever its capitals, any part of it, and % and _ are only themselves
  const accountants = (await actOf('user=ACCOUNTANT')).rows;
  const accountantsInDb = await h.db.q(`SELECT id FROM fin_audit_log WHERE user_name ILIKE '%accountant%' ORDER BY at DESC, id DESC`);
  assert.deepEqual(accountants.map(r => r.id), accountantsInDb.map(r => r.id));
  assert.deepEqual([...new Set(accountants.map(r => r.user_name))].sort(), ['Test Accountant', 'Test DP Accountant']);
  assert.deepEqual([...new Set((await actOf('user=test%20accountant')).rows.map(r => r.user_name))], ['Test Accountant']);
  assert.deepEqual((await actOf('user=%25')).rows, []);
  assert.deepEqual((await actOf('user=_')).rows, []);
  assert.deepEqual((await actOf('user=')).rows.map(r => r.id), everything.map(r => r.id), 'an empty filter is no filter');

  // dates: the plant's calendar, which is IST
  const day = n => plantDateStr(new Date(), n);
  assert.deepEqual((await actOf(`from=${day(-1)}&to=${day(1)}`)).rows.map(r => r.id), everything.map(r => r.id));
  assert.deepEqual((await actOf(`from=${day(1)}`)).rows, []);
  assert.deepEqual((await actOf(`to=${day(-2)}`)).rows, []);
  await h.db.q(`INSERT INTO fin_audit_log (book_id, entity, action, user_name, at) VALUES
    ($1, 'tzprobe', 'last second', 'Probe', '2020-01-10T18:29:59Z'), ($1, 'tzprobe', 'first second', 'Probe', '2020-01-10T18:30:00Z')`, [CI]);
  const probe = async qs => (await actOf(`entity=tzprobe&${qs}`)).rows.map(r => r.action);
  assert.deepEqual(await probe('from=2020-01-10&to=2020-01-10'), ['last second'], '18:29:59 UTC is the last second of the 10th in India');
  assert.deepEqual(await probe('from=2020-01-11&to=2020-01-11'), ['first second'], '18:30:00 UTC is the first second of the 11th');
  assert.deepEqual(await probe('from=2020-01-10&to=2020-01-11'), ['first second', 'last second'], 'both ends inclusive, newest first');
  assert.deepEqual(await probe('to=2020-01-10'), ['last second']);
  assert.deepEqual(await probe('from=2020-01-11'), ['first second']);
});

test('finActivity keeps to the books it is handed, whatever it is asked for', gate, async () => {
  // The route refuses a book the login cannot read before it gets here, so this is the function's own guard.
  const { finActivity } = await import('./finance-reports.js');
  assert.deepEqual(await finActivity([DP], { book: CI }), { rows: [] }, 'a book that is not one of them gives nothing');
  assert.deepEqual(await finActivity([], {}), { rows: [] });
  assert.deepEqual(await finActivity([], { book: CI }), { rows: [] });
  const only = await finActivity([DP], {});
  assert.ok(only.rows.length > 0 && only.rows.every(r => r.book_id === DP));
  const both = await finActivity([CI, DP], {});
  assert.deepEqual([...new Set(both.rows.map(r => r.book_id))].sort(), [CI, DP].sort());
  const narrowed = await finActivity([CI, DP], { book: DP });
  assert.ok(narrowed.rows.length > 0 && narrowed.rows.every(r => r.book_id === DP));
});

test('activity sends at most 500 rows, the newest, and never a row outside the books asked for', gate, async () => {
  await h.db.q(`INSERT INTO fin_audit_log (book_id, entity, entity_id, action, user_name) SELECT $1, 'bulk', n, 'ping', 'Probe' FROM generate_series(1, 600) n`, [CI]);
  const rows = (await actOf('')).rows;
  assert.equal(rows.length, 500);
  const newest = await h.db.one('SELECT MAX(id)::int AS id FROM fin_audit_log');
  assert.equal(rows[0].id, newest.id, 'the newest row leads');
  assert.equal((await actOf(`book=${CI}&entity=bulk`)).rows.length, 500);
  const inDp = await actOf(`book=${DP}`);
  assert.ok(inDp.rows.length > 0 && inDp.rows.length < 500 && inDp.rows.every(r => r.book_id === DP), 'the other book is not crowded out, and not mixed in');
  assert.equal((await actOf('', 'dpOnly')).rows.some(r => r.entity === 'bulk'), false);
  const viewer = (await actOf('', 'viewer')).rows;
  assert.equal(viewer.length, 500);
  assert.ok(viewer.every(r => r.book_id === CI));
});

test('a loop in the group tree, which the app never makes, neither hangs the trial balance nor loses a group', gate, async () => {
  const group = async (name, parent, order) => (await h.db.one(
    `INSERT INTO fin_groups (book_id, parent_id, name, nature, sort_order) VALUES ($1, $2, $3, 'asset', $4) RETURNING id`, [CI, parent, name, order])).id;
  const a = await group('Loop A', null, 900);
  const b = await group('Loop B', a, 901);
  await h.db.q('UPDATE fin_groups SET parent_id = $2 WHERE id = $1', [a, b]);                // A under B, and B under A
  const foreign = (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Capital Account'`, [DP])).id;
  await group('Stray', foreign, 902);                                                         // its parent is the other book's group
  const tb = await tbOf('to=2027-12-31');
  const names = tb.groups.map(g => g.name);
  assert.equal(new Set(names).size, names.length, 'each group once');
  assert.equal(names.length, (await ok(`/finance/books/${CI}/groups`)).groups.length, 'none lost');
  assert.deepEqual(names.slice(-3), ['Stray', 'Loop A', 'Loop B'], 'a group with no parent in the book is a top group; a loop is listed last');
  const g = Object.fromEntries(tb.groups.map(x => [x.name, x]));
  assert.deepEqual([g['Stray'].depth, g['Loop A'].depth, g['Loop B'].depth], [0, 0, 1]);
  assert.equal(tb.totals.closing_dr, tb.totals.closing_cr, 'the totals come from the ledgers and never depended on the tree');
});

test('"as at" has no lower bound: the Opening voucher, dated 31 Dec 2026, is in every balance after it', gate, async () => {
  // The import that builds an Opening voucher comes later, so this one is made the way the database tests make a posted
  // voucher: a draft with its lines, then the status change, in one transaction so the checks at COMMIT run.
  const capital = await ledger(CI, G.CapitalAccount, 'Proprietor Capital A/c');
  const cash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [CI])).id;
  const december = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2026-12-01'`, [CI])).id;
  const opening = await h.db.tx(async (qc, oc) => {
    const v = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, narration)
                        VALUES ($1, 'opening', '2026-12-31', 50000, 'Opening balances') RETURNING id`, [CI]);
    await qc(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit)
              VALUES ($1, $2, 1, $3, 50000, 0), ($1, $2, 2, $4, 0, 50000)`, [v.id, CI, cash, capital]);
    await qc(`UPDATE fin_vouchers SET status = 'posted', number = 'CI-OB-2627-0001', period_id = $2, posted_at = now() WHERE id = $1`, [v.id, december]);
    return v.id;
  });

  const onTheDay = await tbOf('to=2026-12-31');
  assert.deepEqual(onTheDay.ledgers.map(l => [l.name, l.closing_paise]).sort(), [['Cash', 50000 * R], ['Proprietor Capital A/c', -50000 * R]]);
  assert.deepEqual([onTheDay.totals.closing_dr, onTheDay.totals.closing_cr], [50000 * R, 50000 * R]);
  assert.equal(onTheDay.groups.find(g => g.name === 'Capital Account').closing_paise, -50000 * R);
  assert.equal(onTheDay.groups.find(g => g.name === 'Cash-in-Hand').closing_paise, 50000 * R);

  const jan = await tbOf('to=2027-01-31');
  assert.equal(named(jan)['Cash'].closing_paise, 50000 * R, 'the opening balance is in every later balance');
  assert.equal(jan.totals.closing_dr, 150000 * R);
  assert.equal(jan.totals.closing_dr, jan.totals.closing_cr);

  const range = await tbOf('from=2027-01-01&to=2027-01-31');
  assert.deepEqual(figures(named(range)['Cash']), [50000 * R, 0, 0, 50000 * R], 'and it is the opening of a range that starts after it');
  assert.equal(range.totals.opening_dr, 50000 * R);
  assert.equal(range.totals.opening_dr, range.totals.opening_cr);

  const s = await stmtOf(cash, 'from=2026-12-01&to=2027-03-31');
  assert.deepEqual(s.entries.map(e => [e.voucher_id, e.number, e.voucher_type, e.against, e.balance_paise]), [[opening, 'CI-OB-2627-0001', 'opening', 'Proprietor Capital A/c', 50000 * R]]);
  const later = await stmtOf(capital, 'from=2027-01-01&to=2027-03-31');
  assert.deepEqual([later.opening_paise, later.entries, later.closing_paise], [-50000 * R, [], -50000 * R]);

  const reg = await jrOf('from=2026-12-01&to=2026-12-31&type=opening');
  assert.deepEqual(reg.vouchers.map(v => [v.id, v.total_paise]), [[opening, 50000 * R]]);
  assert.deepEqual((await jrOf('from=2027-01-01&type=opening')).vouchers, []);
});
