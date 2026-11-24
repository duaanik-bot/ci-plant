import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';
import { plantDateStr } from './plant-calendar.js';
import { setKnownTables } from './data-tables.js';

// Cash & Bank on the server (spec §5, §6.3–§6.7): Receive, Pay and Transfer as ordinary receipts, payments and contras that settle
// a party's bills as they post and are never refused for not matching; the tiles, an account's book, the money on account, a
// preview that writes nothing, a redo, a party's statement, and the day the ERP's own doors hand over. Opt-in, because it boots
// its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-cash.test.js
//
// One boot for the file. CI's Opening is built through the import routes, as at 31 Dec 2026. Each test uses parties and accounts
// of its own, so no test reads another's leftovers. Three things later tasks build are set here by hand, with SQL: the ledger roles
// (Task 9's Setup: the staff ledgers and the TDS receivable ledger; the TDS payable role is left unset on purpose), the staff ledgers'
// system-only flag (Task 9), and the holders' names and floats (Task 7). Every name and figure is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h;
let cash;        // finance-cash.js, the module under test
let alloc;       // finance-allocations.js, for the invariant
let CI, DP;
let c1, c2, pid2;
let ACCT;        // the accountant, as the entry route hands it on
const LEDGER = {};   // CI ledger name -> id
const BILL = {};     // party name -> { lump | <bill ref> -> its Opening line id }
const DPL = {};      // DP: { cash, party, line }

const ACME = 'Acme Pharma';
const MOSS = 'Moss Test Pharma';          // the book: a receipt that settles three bills exactly
const NOVA = 'Nova Test Labs';            // the party report: 0104 left part-open
const ORBIT = 'Orbit Test Labs';          // the unadjusted list: ₹5,000 left on account
const ROOK = 'Rook Test Pharma';          // the warnings: a leftover
const SABLE = 'Sable Test Labs';          // a retried save key; nothing open
const QUARTZ = 'Quartz Test Pharma';      // open items, a preview, a redo
const TERN = 'Tern Test Labs';            // one read: a receipt posted between two statements
const UMBRA = 'Umbra Test Pharma';        // a rejected entry edited onto new lines: its first party
const VIREO = 'Vireo Test Labs';          // …and the party its new lines name
const WISP = 'Wisp Test Labs';            // a rejected entry edited without new lines
const YARROW = 'Yarrow Test Labs';        // a posted receipt retried with an edited amount (ruling R11)
const ZEPHYR = 'Zephyr Test Supplies';    // a waiting payment retried as it was and with edits (ruling R11)
const JUNO = 'Juno Test Packaging';       // a vendor with two bills
const KESTREL = 'Kestrel Test Supplies';  // a vendor with nothing open
const LUMEN = 'Lumen Test Supplies';      // another
const PIVOT = 'Pivot Test Supplies';      // the party's cash on a day, before an entry is saved (ruling R59): a vendor
const RIDGE = 'Ridge Test Labs';          // …and a customer
const LEAN = 'Lean Test Labs';            // the book's lean rows (ruling R65): a customer with nothing open, made by its test
const FREIGHT = 'Test Freight';
const BANK = 'Test Bank Current';
const BANK_CC = 'Test Bank CC';
const COUNTER = 'Counter Cash';
const PETTY = 'Petty Cash';
const HOLDER_A = 'Cash with Holder A';
const HOLDER_B = 'Cash with Holder B';
const HOLDER_C = 'Cash with Holder C';
const STAFF = ['Staff Advances', 'Staff Loans', 'Salary Payable', 'Salaries & Wages'];

// The Tally files, as at 31 Dec 2026, in rupees: Dr 15,16,000 and Cr 15,16,000.
const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });
const bill = (tally_ledger_name, bill_ref, bill_date, rupees) =>
  ({ tally_ledger_name, bill_ref, bill_date, due_date: null, amount_paise: rupees * R, side: rupees > 0 ? 'dr' : 'cr' });
const THREE_BILLS = [ACME, MOSS, NOVA];
const ACCOUNTS = [
  ...['Cash', COUNTER, PETTY, HOLDER_A, HOLDER_B, HOLDER_C].map(tally_name => ({ tally_name, tally_group: 'Cash-in-Hand' })),
  { tally_name: BANK, tally_group: 'Bank Accounts' },
  { tally_name: BANK_CC, tally_group: 'Bank OD A/c' },
  { tally_name: 'Test Capital A/c', tally_group: 'Capital Account' },
  ...[...THREE_BILLS, ORBIT, ROOK, SABLE, QUARTZ, TERN, UMBRA, VIREO, WISP, YARROW, RIDGE].map(tally_name => ({ tally_name, tally_group: 'Sundry Debtors' })),
  ...[JUNO, KESTREL, LUMEN, ZEPHYR, PIVOT].map(tally_name => ({ tally_name, tally_group: 'Sundry Creditors' })),
  { tally_name: FREIGHT, tally_group: 'Direct Expenses' },
  { tally_name: 'Staff Advances', tally_group: 'Loans & Advances (Asset)' },
  { tally_name: 'Staff Loans', tally_group: 'Loans & Advances (Asset)' },
  { tally_name: 'Salary Payable', tally_group: 'Current Liabilities' },
  { tally_name: 'Salaries & Wages', tally_group: 'Indirect Expenses' },
  { tally_name: 'TDS Receivable', tally_group: 'Loans & Advances (Asset)' },
  { tally_name: 'TDS Payable', tally_group: 'Duties & Taxes' },
];
const TB = [
  tb('Cash', 100000, 0), tb(COUNTER, 50000, 0), tb(PETTY, 1000, 0), tb(HOLDER_A, 0, 0), tb(HOLDER_B, 0, 0), tb(HOLDER_C, 0, 0),
  tb(BANK, 1000000, 0), tb(BANK_CC, 0, 320000), tb('Test Capital A/c', 0, 916000),
  ...THREE_BILLS.map(name => tb(name, 95000, 0)), tb(ORBIT, 10000, 0), tb(ROOK, 10000, 0), tb(SABLE, 0, 0), tb(QUARTZ, 20000, 0),
  tb(TERN, 10000, 0), tb(UMBRA, 10000, 0), tb(VIREO, 10000, 0), tb(WISP, 10000, 0), tb(YARROW, 0, 0), tb(ZEPHYR, 0, 100000),
  tb(JUNO, 0, 180000), tb(KESTREL, 0, 0), tb(LUMEN, 0, 0), tb(FREIGHT, 0, 0), tb(PIVOT, 0, 0), tb(RIDGE, 0, 0),
  ...STAFF.map(name => tb(name, 0, 0)), tb('TDS Receivable', 0, 0), tb('TDS Payable', 0, 0),
];
const BILLS = [
  ...THREE_BILLS.flatMap(name => [bill(name, null, null, 20000), bill(name, '0091', '2026-12-02', 35000), bill(name, '0104', '2026-12-18', 40000)]),
  bill(ORBIT, '0301', '2026-12-10', 10000),
  bill(ROOK, '0401', '2026-12-10', 10000),
  bill(QUARTZ, 'Q-1', '2026-12-05', 10000), bill(QUARTZ, 'Q-2', '2026-12-20', 10000),
  bill(TERN, 'T-1', '2026-12-10', 10000),
  bill(UMBRA, 'U-1', '2026-12-10', 10000), bill(VIREO, 'VR-1', '2026-12-12', 10000), bill(WISP, 'W-1', '2026-12-14', 10000),
  bill(ZEPHYR, 'Z-1', '2026-12-15', -100000),
  bill(JUNO, 'V-11', '2026-12-05', -100000), bill(JUNO, 'V-12', '2026-12-20', -80000),
];

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
// A refusal as the screen sees it: the status, the code, and the field it names (when the test names one).
function refused(r, status, code, field) {
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body?.code, code, JSON.stringify(r.body));
  if (field !== undefined) assert.equal(r.body?.field, field, JSON.stringify(r.body));
}
const idOf = (groups, name) => {
  const g = groups.find(x => x.name === name);
  assert.ok(g, `no group called ${name}`);
  return g.id;
};

// ── Raw clients: a route's transaction, held open where a test says so (finance-pg-allocations.test.js) ──────────────

const clientQ = client => {
  const qc = async (text, params = []) => (await client.query(text, params)).rows;
  return { qc, oc: async (text, params = []) => (await qc(text, params))[0] ?? null };
};
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
// A call on a raw client in a transaction of its own, run as a route runs it, with what it has come to kept: { value } or { error }.
function watched(client, fn) {
  const state = { settled: null };
  state.done = (async () => {
    const { qc, oc } = clientQ(client);
    await client.query('BEGIN');
    try {
      const value = await fn(qc, oc);
      await client.query('COMMIT');
      return value;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  })().then(value => { state.settled = { value }; return value; }, error => { state.settled = { error }; throw error; });
  state.done.catch(() => {});
  return state;
}
// Whether backend `pid` waits for another transaction to end (a row or a key it wants, held by a transaction still open), asked of
// Postgres and not of the clock. `settled()` is what the waiter's own call has come to: one that settled never waited.
async function waitsForTransaction(pid, settled = () => null) {
  for (let i = 0; i < 400; i++) {
    if (settled() !== null) return false;
    const row = await h.db.one(`SELECT 1 AS waiting FROM pg_locks WHERE pid = $1 AND locktype = 'transactionid' AND NOT granted`, [pid]);
    if (row) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('cash');
  // Loaded softly, so that before the module exists each test fails on its own assertion and not all of them on the import.
  cash = await import('./finance-cash.js').catch(() => ({}));
  alloc = await import('./finance-allocations.js');
  CI = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
  DP = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'DP'`)).id;

  // The Opening, through the import routes: uploaded and confirmed by the accountant, built (it waits: the opening rule is always),
  // and approved by the MD.
  const up = await ok(h.call('POST', '/finance/imports', {
    book_id: CI, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx', 'bills.xlsx'], accounts: ACCOUNTS, tb: TB, bills: BILLS,
  }, 'acct'));
  const matches = up.ledgers.map(r => ({ row_id: r.id, action: r.match_status === 'matched' ? 'match' : r.match_status,
    ledger_id: r.ledger_id, group_id: r.group_id, party_type: r.party_type, party_id: r.party_id }));
  await ok(h.call('PUT', `/finance/imports/${up.import.id}/matches`, { matches }, 'acct'));
  const built = (await ok(h.call('POST', `/finance/imports/${up.import.id}/build-opening`, null, 'acct'))).voucher;
  assert.equal(built.status, 'submitted');
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${built.id}/approve`, null, 'md'))).voucher.status, 'posted');

  // A cash ledger in a group of its own under Cash-in-Hand, and one switched off: for the tiles.
  const groups = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'md'))).groups;
  const sites = (await ok(h.call('POST', '/finance/groups', { book_id: CI, name: 'Cash at Sites', parent_id: idOf(groups, 'Cash-in-Hand') }, 'md'))).group;
  await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: sites.id, name: 'Site Cash' }, 'acct'));
  await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf(groups, 'Cash-in-Hand'), name: 'Old Cash' }, 'acct'));

  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [CI])) LEDGER[l.name] = l.id;
  const nameOf = Object.fromEntries(Object.entries(LEDGER).map(([name, id]) => [id, name]));
  for (const l of await h.db.q('SELECT id, ledger_id, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1', [built.id])) {
    (BILL[nameOf[l.ledger_id]] ??= {})[l.bill_ref ?? 'lump'] = l.id;
  }
  await h.db.q('UPDATE fin_ledgers SET active = false WHERE id = $1', [LEDGER['Old Cash']]);

  // What Task 9's Setup will hold: the staff ledgers, system-only, and the TDS receivable ledger. The TDS payable role stays unset.
  for (const [role, name] of [['staff_advances', 'Staff Advances'], ['staff_loans', 'Staff Loans'], ['salary_payable', 'Salary Payable'],
    ['salary_expense', 'Salaries & Wages'], ['tds_receivable', 'TDS Receivable']]) {
    await h.db.q('INSERT INTO fin_ledger_roles (book_id, ledger_id, role) VALUES ($1, $2, $3)', [CI, LEDGER[name], role]);
  }
  await h.db.q('UPDATE fin_ledgers SET manual_entry = false WHERE id = ANY($1::int[])', [STAFF.map(name => LEDGER[name])]);
  // What Task 7 will set: three holders, two of them with a float of ₹50,000.
  await h.db.q(`UPDATE fin_ledgers SET holder_name = 'Holder A', float_amount = 50000 WHERE id = $1`, [LEDGER[HOLDER_A]]);
  await h.db.q(`UPDATE fin_ledgers SET holder_name = 'Holder B' WHERE id = $1`, [LEDGER[HOLDER_B]]);
  await h.db.q(`UPDATE fin_ledgers SET holder_name = 'Holder C', float_amount = 50000 WHERE id = $1`, [LEDGER[HOLDER_C]]);

  // DP: a customer, its Cash, and a line of a draft receipt, which a CI-only login may not reach.
  const dpGroups = (await ok(h.call('GET', `/finance/books/${DP}/groups`, null, 'md'))).groups;
  DPL.party = (await ok(h.call('POST', '/finance/ledgers', { book_id: DP, group_id: idOf(dpGroups, 'Sundry Debtors'), name: 'Delta Test Traders' }, 'dpOnly'))).ledger.id;
  DPL.cash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [DP])).id;
  const dpDraft = (await ok(h.call('POST', '/finance/vouchers', {
    book_id: DP, voucher_type: 'receipt', voucher_date: '2027-01-05', client_key: randomUUID(),
    lines: [{ ledger_id: DPL.cash, debit_paise: 1000, credit_paise: 0 }, { ledger_id: DPL.party, debit_paise: 0, credit_paise: 1000 }],
  }, 'dpOnly'))).voucher;
  DPL.line = (await h.db.one('SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no LIMIT 1', [dpDraft.id])).id;

  ACCT = { id: h.users.acct.id, name: 'Test Accountant', roles: ['accountant'] };
  c1 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c1.connect();
  await c2.connect();
  pid2 = (await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
});

after(async () => {
  for (const client of [c1, c2]) await client?.end().catch(() => {});
  await h?.close();
});

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

// An entry as the form sends it: ledgers by name, amounts in rupees, a fresh save key unless one is given.
const entryBody = ({ entry_type, date, account, other, rupees, tds = 0, reference = null, narration = null, adjust = null,
  client_key = randomUUID() }) => ({
  book_id: CI, entry_type, voucher_date: date, account_ledger_id: LEDGER[account], other_ledger_id: LEDGER[other],
  amount_paise: Math.round(rupees * R), tds_paise: Math.round(tds * R), reference, narration, adjust, client_key,
});
const enter = (fields, who = 'acct') => h.call('POST', '/finance/cash/entries', entryBody(fields), who);
const AUTO = { mode: 'auto', picks: [] };
const codes = answer => answer.warnings.map(w => w.code);

// A voucher's lines, in order: [line_no, ledger, debit paise, credit paise].
const linesOf = async voucherId => (await h.db.q(
  'SELECT line_no, ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [voucherId]))
  .map(l => [l.line_no, l.ledger_id, Math.round(l.debit * R), Math.round(l.credit * R)]);
const lineOf = async (voucherId, lineNo) =>
  (await h.db.one('SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = $2', [voucherId, lineNo])).id;
const planOf = async voucherId => (await h.db.one('SELECT allocation_plan FROM fin_vouchers WHERE id = $1', [voucherId])).allocation_plan;
// The allocations a line takes part in, oldest first: [the other line, paise, mode].
const allocationsOf = async lineId => (await h.db.q(
  `SELECT CASE WHEN credit_line_id = $1 THEN debit_line_id ELSE credit_line_id END AS other, amount, mode
     FROM fin_allocations WHERE debit_line_id = $1 OR credit_line_id = $1 ORDER BY id`, [lineId]))
  .map(a => [a.other, Math.round(a.amount * R), a.mode]);
const counts = async () => h.db.one(`SELECT (SELECT COUNT(*)::int FROM fin_vouchers) vouchers, (SELECT COUNT(*)::int FROM fin_voucher_lines) lines,
  (SELECT COUNT(*)::int FROM fin_allocations) allocations, (SELECT COUNT(*)::int FROM fin_audit_log) audit`);
const partyCheck = name => alloc.finPartyCheck(h.db.q, LEDGER[name]);

// The last day of the month a day falls in.
const monthEnd = day => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10);
// Whole days from `from` to `today`, and nothing for a day after it.
const ageOn = today => date => Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000));

test('receipt with TDS: lines Dr Cash 80,000 · Dr TDS Receivable 1,600 · Cr Acme Pharma 81,600; Auto settles as Task 5', gate, async () => {
  const r = await ok(enter({ entry_type: 'receive', date: '2027-01-05', account: 'Cash', other: ACME, rupees: 80000, tds: 1600,
    reference: 'NEFT 4471', narration: 'Acme part payment', adjust: AUTO }));
  assert.equal(r.voucher.status, 'posted', 'a receipt needs no approval');
  assert.equal(r.voucher.voucher_type, 'receipt');
  assert.match(r.voucher.number, /^CI-RV-2627-\d{4}$/);
  assert.deepEqual([r.voucher.reference, r.voucher.narration, r.voucher.total_paise], ['NEFT 4471', 'Acme part payment', 8_160_000]);
  assert.deepEqual(await linesOf(r.voucher.id), [
    [1, LEDGER.Cash, 8_000_000, 0], [2, LEDGER['TDS Receivable'], 160_000, 0], [3, LEDGER[ACME], 0, 8_160_000],
  ]);
  assert.deepEqual(await planOf(r.voucher.id), { line_no: 3, mode: 'auto', picks: [] }, 'the plan names the party\'s line');
  // Auto, as Task 5 settles it: the lump, 0091, then ₹26,600 of 0104; the answer is what the posting settled, read back
  assert.deepEqual(r.allocations, [
    { line_id: BILL[ACME].lump, amount_paise: 2_000_000 }, { line_id: BILL[ACME]['0091'], amount_paise: 3_500_000 },
    { line_id: BILL[ACME]['0104'], amount_paise: 2_660_000 },
  ]);
  assert.equal(r.on_account_paise, 0);
  assert.deepEqual(r.warnings, [], '₹80,000 of cash is under ₹2,00,000, and nothing is left on account');
  const line = await lineOf(r.voucher.id, 3);
  assert.deepEqual(await allocationsOf(line), [
    [BILL[ACME].lump, 2_000_000, 'auto'], [BILL[ACME]['0091'], 3_500_000, 'auto'], [BILL[ACME]['0104'], 2_660_000, 'auto'],
  ]);
  assert.deepEqual(await partyCheck(ACME), { outstanding_paise: 1_340_000, on_account_paise: 0, balance_paise: 1_340_000, ok: true });
  // the create row of the log keeps what the maker asked for
  const created = await h.db.one(`SELECT after FROM fin_audit_log WHERE entity = 'voucher' AND entity_id = $1 AND action = 'create'`, [r.voucher.id]);
  assert.deepEqual(created.after.allocation_plan, { line_no: 3, mode: 'auto', picks: [] });
});

test('a payment of ₹1,50,000 by acct waits (submitted) with its plan; when md approves, the picked bills are settled', gate, async () => {
  const picks = [{ line_id: BILL[JUNO]['V-12'], amount_paise: null }, { line_id: BILL[JUNO]['V-11'], amount_paise: null }];
  const r = await ok(enter({ entry_type: 'pay', date: '2027-01-06', account: BANK, other: JUNO, rupees: 150000, reference: 'V-12',
    adjust: { mode: 'pick', picks } }));
  assert.equal(r.voucher.status, 'submitted', 'above the ₹1,00,000 payment limit, an accountant\'s payment waits for an Approver');
  assert.deepEqual([r.voucher.voucher_type, r.voucher.number], ['payment', null]);
  assert.deepEqual(await linesOf(r.voucher.id), [[1, LEDGER[JUNO], 15_000_000, 0], [2, LEDGER[BANK], 0, 15_000_000]]);
  assert.deepEqual(await planOf(r.voucher.id), { line_no: 1, mode: 'pick', picks }, 'the plan waits with it');
  assert.equal(r.allocations, null, 'nothing is settled while it waits');
  assert.equal(r.on_account_paise, 0, 'the plan, against the bills open now, leaves nothing on account');
  assert.deepEqual(r.warnings, [], 'by bank: no cash warning, and a bank may run below zero');
  const line = await lineOf(r.voucher.id, 1);
  assert.deepEqual(await allocationsOf(line), []);

  const approved = await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/approve`, null, 'md'));
  assert.equal(approved.voucher.status, 'posted');
  assert.deepEqual(await allocationsOf(line), [[BILL[JUNO]['V-12'], 8_000_000, 'pick'], [BILL[JUNO]['V-11'], 7_000_000, 'pick']],
    'the bills ticked, in the order ticked, settled when it posted');
  assert.deepEqual(await partyCheck(JUNO), { outstanding_paise: 3_000_000, on_account_paise: 0, balance_paise: 3_000_000, ok: true });
});

test('a transfer of ₹2,50,000 to Holder A by acct waits for md', gate, async () => {
  const r = await ok(enter({ entry_type: 'transfer', date: '2027-01-02', account: BANK, other: HOLDER_A, rupees: 250000, narration: 'float' }));
  assert.equal(r.voucher.status, 'submitted', 'above the ₹1,00,000 contra limit, it waits');
  assert.equal(r.voucher.voucher_type, 'contra');
  assert.deepEqual(await linesOf(r.voucher.id), [[1, LEDGER[HOLDER_A], 25_000_000, 0], [2, LEDGER[BANK], 0, 25_000_000]]);
  assert.equal(await planOf(r.voucher.id), null, 'no party, no plan');
  assert.deepEqual([r.allocations, r.on_account_paise, r.warnings], [null, null, []]);
  const approved = await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/approve`, null, 'md'));
  assert.equal(approved.voucher.status, 'posted');
  assert.match(approved.voucher.number, /^CI-CV-2627-\d{4}$/);
});

test('paying Staff Advances is refused FIN_STAFF_IN_HR', gate, async () => {
  const was = await counts();
  const r = await enter({ entry_type: 'pay', date: '2027-01-07', account: 'Cash', other: 'Staff Advances', rupees: 5000 });
  refused(r, 409, 'FIN_STAFF_IN_HR', 'other_ledger_id');
  assert.equal(r.body.error, 'Staff advances and salaries are paid in HR.');
  // every staff ledger, paid or received: staff money is HR's (spec §5.2, §7.1), and it is said before the ledger's system-only flag
  for (const other of STAFF.slice(1)) {
    refused(await enter({ entry_type: 'pay', date: '2027-01-07', account: BANK, other, rupees: 5000 }), 409, 'FIN_STAFF_IN_HR', 'other_ledger_id');
  }
  refused(await enter({ entry_type: 'receive', date: '2027-01-07', account: 'Cash', other: 'Staff Loans', rupees: 2000 }), 409, 'FIN_STAFF_IN_HR');
  assert.deepEqual(await counts(), was, 'nothing is written');
});

test('TDS without the role set is refused FIN_ROLE_MISSING', gate, async () => {
  const was = await counts();
  const r = await enter({ entry_type: 'pay', date: '2027-01-07', account: BANK, other: JUNO, rupees: 9800, tds: 200, adjust: AUTO });
  refused(r, 409, 'FIN_ROLE_MISSING', 'tds_paise');
  assert.match(r.body.error, /TDS payable/);
  // TDS only from a customer on a receipt, or to a vendor on a payment, and never on a transfer
  refused(await enter({ entry_type: 'pay', date: '2027-01-07', account: BANK, other: FREIGHT, rupees: 9800, tds: 200 }), 400, 'FIN_BAD_INPUT', 'tds_paise');
  refused(await enter({ entry_type: 'receive', date: '2027-01-07', account: 'Cash', other: JUNO, rupees: 9800, tds: 200 }), 400, 'FIN_BAD_INPUT', 'tds_paise');
  refused(await enter({ entry_type: 'transfer', date: '2027-01-07', account: BANK, other: 'Cash', rupees: 9800, tds: 200 }), 400, 'FIN_BAD_INPUT', 'tds_paise');
  assert.deepEqual(await counts(), was, 'nothing is written');
});

test('amount_paise 0, -1, 1.5 and "100" are refused FIN_BAD_INPUT (Review Focus 1)', gate, async () => {
  const was = await counts();
  const base = entryBody({ entry_type: 'receive', date: '2027-01-07', account: 'Cash', other: SABLE, rupees: 1 });
  const post = body => h.call('POST', '/finance/cash/entries', { ...base, client_key: randomUUID(), ...body }, 'acct');
  for (const amount_paise of [0, -1, 1.5, '100', null, 1e14]) refused(await post({ amount_paise }), 400, 'FIN_BAD_INPUT', 'amount_paise');
  const { amount_paise: _, ...noAmount } = base;
  refused(await h.call('POST', '/finance/cash/entries', noAmount, 'acct'), 400, 'FIN_BAD_INPUT', 'amount_paise');
  for (const tds_paise of [-1, 1.5, '100']) refused(await post({ tds_paise }), 400, 'FIN_BAD_INPUT', 'tds_paise');
  for (const entry_type of ['receipt', 'kind', '', null]) refused(await post({ entry_type }), 400, 'FIN_BAD_INPUT', 'entry_type');
  refused(await post({ adjust: { mode: 'oldest' } }), 400, 'FIN_BAD_INPUT', 'mode');
  refused(await post({ client_key: 'again' }), 400, 'FIN_BAD_INPUT', 'client_key');
  refused(await post({ voucher_date: '2027-02-30' }), 400, 'FIN_BAD_DATE', 'voucher_date');
  assert.deepEqual(await counts(), was, 'nothing is written');
});

test('the account must be bank or cash (FIN_BAD_INPUT); a transfer is between two of them, and a receipt or a payment never is', gate, async () => {
  const was = await counts();
  const day = '2027-01-07';
  refused(await enter({ entry_type: 'receive', date: day, account: FREIGHT, other: SABLE, rupees: 100 }), 400, 'FIN_BAD_INPUT', 'account_ledger_id');
  refused(await enter({ entry_type: 'pay', date: day, account: SABLE, other: FREIGHT, rupees: 100 }), 400, 'FIN_BAD_INPUT', 'account_ledger_id');
  refused(await enter({ entry_type: 'transfer', date: day, account: 'Cash', other: FREIGHT, rupees: 100 }), 400, 'FIN_BAD_INPUT', 'other_ledger_id');
  // money between two bank or cash accounts is a Transfer, so a receipt can never carry it past the contra rule
  refused(await enter({ entry_type: 'receive', date: day, account: 'Cash', other: BANK, rupees: 100 }), 400, 'FIN_BAD_INPUT', 'other_ledger_id');
  refused(await enter({ entry_type: 'pay', date: day, account: HOLDER_B, other: 'Cash', rupees: 100 }), 400, 'FIN_BAD_INPUT', 'other_ledger_id');
  refused(await enter({ entry_type: 'transfer', date: day, account: 'Cash', other: 'Cash', rupees: 100 }), 400, 'FIN_BAD_INPUT', 'other_ledger_id');
  // a switched-off account, a ledger of another book, and a login that may only read
  refused(await enter({ entry_type: 'receive', date: day, account: 'Old Cash', other: SABLE, rupees: 100 }), 409, 'FIN_LEDGER_INACTIVE', 'account_ledger_id');
  refused(await h.call('POST', '/finance/cash/entries',
    { ...entryBody({ entry_type: 'receive', date: day, account: 'Cash', other: SABLE, rupees: 100 }), other_ledger_id: DPL.party }, 'acct'),
  409, 'FIN_WRONG_BOOK', 'other_ledger_id');
  refused(await enter({ entry_type: 'receive', date: day, account: 'Cash', other: SABLE, rupees: 100 }, 'viewer'), 403, 'FIN_FORBIDDEN');
  // an entry the posting refuses leaves no draft behind: the draft and its submit are one transaction
  refused(await enter({ entry_type: 'receive', date: '2026-12-31', account: 'Cash', other: SABLE, rupees: 100, adjust: AUTO }), 409, 'FIN_BEFORE_BOOKS');
  assert.deepEqual(await counts(), was, 'nothing is written');
});

test('warnings: ₹2,00,000 cash from Acme in a day returns S269ST; ₹10,001 cash to a vendor returns S40A3; the same by bank returns neither; leftover returns ON_ACCOUNT', gate, async () => {
  const day = '2027-01-08';
  // Cash from Acme on one day, with no adjustment chosen, so all of it goes on account: ₹1,50,000, then ₹50,000 more
  const a = await ok(enter({ entry_type: 'receive', date: day, account: 'Cash', other: ACME, rupees: 150000 }));
  assert.equal(a.voucher.status, 'posted', 'a party with no adjustment chosen is no refusal');
  assert.deepEqual(a.warnings, [{ code: 'ON_ACCOUNT', sentence: '₹1,50,000.00 stays on account.' }], 'under ₹2,00,000 in the day');
  assert.deepEqual(await planOf(a.voucher.id), { line_no: 2 }, 'the plan names the party\'s line and chooses nothing');
  assert.deepEqual([a.allocations, a.on_account_paise], [[], 15_000_000]);
  const b = await ok(enter({ entry_type: 'receive', date: day, account: 'Cash', other: ACME, rupees: 50000 }));
  assert.deepEqual(b.warnings, [
    { code: 'ON_ACCOUNT', sentence: '₹50,000.00 stays on account.' },
    { code: 'S269ST', sentence: 'Cash received from this party today reaches ₹2,00,000 (Income-tax Act s.269ST).' },
  ]);
  // the same by bank, the same day: no cash, so no s.269ST
  const c = await ok(enter({ entry_type: 'receive', date: day, account: BANK, other: ACME, rupees: 250000 }));
  assert.deepEqual(codes(c), ['ON_ACCOUNT']);

  // Cash to a vendor: ₹10,001 is over ₹10,000 (s.40A(3)); by bank it is no cash; ₹10,000 exactly is not over
  const d = await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: 'Cash', other: KESTREL, rupees: 10001 }));
  assert.deepEqual(d.warnings, [
    { code: 'ON_ACCOUNT', sentence: '₹10,001.00 stays on account.' },
    { code: 'S40A3', sentence: 'Cash paid to this party today is over ₹10,000 (Income-tax Act s.40A(3)).' },
  ]);
  assert.deepEqual(codes(await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: BANK, other: KESTREL, rupees: 10001 }))), ['ON_ACCOUNT']);
  assert.deepEqual(codes(await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: 'Cash', other: LUMEN, rupees: 10000 }))), ['ON_ACCOUNT']);

  // Leftover: Auto against Rook's one bill of ₹10,000 with ₹12,500 leaves ₹2,500 on account
  const g = await ok(enter({ entry_type: 'receive', date: '2027-01-09', account: 'Cash', other: ROOK, rupees: 12500, adjust: AUTO }));
  assert.deepEqual([g.allocations, g.on_account_paise], [[{ line_id: BILL[ROOK]['0401'], amount_paise: 1_000_000 }], 250_000]);
  assert.deepEqual(g.warnings, [{ code: 'ON_ACCOUNT', sentence: '₹2,500.00 stays on account.' }]);

  // Cash going below zero, which posts all the same: a holder holding less than this, and a cash account taken below zero
  const short = await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: HOLDER_B, other: FREIGHT, rupees: 500 }));
  assert.equal(short.voucher.status, 'posted');
  assert.deepEqual(short.warnings, [{ code: 'HOLDER_SHORT', sentence: 'Holder B holds less than this.' }]);
  const below = await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: PETTY, other: FREIGHT, rupees: 1500 }));
  assert.deepEqual(below.warnings, [{ code: 'BELOW_ZERO', sentence: 'This takes Petty Cash below zero.' }]);
  assert.deepEqual([below.allocations, below.on_account_paise], [null, null], 'an expense has no bills');
  // a bank may run below zero: an overdraft account is no cash
  const overdraft = await ok(enter({ entry_type: 'pay', date: '2027-01-09', account: BANK_CC, other: FREIGHT, rupees: 5000 }));
  assert.deepEqual([overdraft.voucher.status, overdraft.warnings], ['posted', []]);
});

test('the book: opening, entries in order with running balance, the receipt\'s "Auto: 3 bills, ₹0 on account", a pending payment listed apart and outside the balance; with no dates it is the current month', gate, async () => {
  const receipt = await ok(enter({ entry_type: 'receive', date: '2027-01-05', account: COUNTER, other: MOSS, rupees: 80000, tds: 1600, adjust: AUTO }));
  const waiting = await ok(enter({ entry_type: 'pay', date: '2027-01-06', account: COUNTER, other: FREIGHT, rupees: 120000, narration: 'freight for January' }));
  assert.equal(waiting.voucher.status, 'submitted');
  const small = await ok(enter({ entry_type: 'pay', date: '2027-01-07', account: COUNTER, other: FREIGHT, rupees: 3000 }));
  const moved = await ok(enter({ entry_type: 'transfer', date: '2027-01-10', account: COUNTER, other: 'Cash', rupees: 7000 }));

  const book = await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-01-01&to=2027-01-31`, null, 'viewer'));
  assert.deepEqual(book.ledger, {
    id: LEDGER[COUNTER], name: COUNTER, book_id: CI, group_name: 'Cash-in-Hand', account_kind: 'cash', holder_name: null,
  });
  assert.deepEqual([book.from, book.to], ['2027-01-01', '2027-01-31']);
  assert.equal(book.opening_paise, 5_000_000, 'the Tally opening, as at 31 Dec');
  assert.deepEqual(book.entries.map(e => [e.date, e.voucher_id, e.number, e.particulars, e.adjustment, e.in_paise, e.out_paise, e.balance_paise]), [
    ['2027-01-05', receipt.voucher.id, receipt.voucher.number, MOSS, 'Auto: 3 bills, ₹0 on account', 8_000_000, 0, 13_000_000],
    ['2027-01-07', small.voucher.id, small.voucher.number, FREIGHT, null, 0, 300_000, 12_700_000],
    ['2027-01-10', moved.voucher.id, moved.voucher.number, 'Cash', null, 0, 700_000, 12_000_000],
  ], 'the other side of each entry, never the TDS beside the cash');
  assert.deepEqual([book.total_in_paise, book.total_out_paise, book.closing_paise], [8_000_000, 1_000_000, 12_000_000],
    'the payment that waits is in no balance');
  assert.deepEqual(book.pending.map(p => [p.date, p.voucher_id, p.voucher_type, p.particulars, p.narration, p.in_paise, p.out_paise, p.submitted_by]),
    [['2027-01-06', waiting.voucher.id, 'payment', FREIGHT, 'freight for January', 0, 12_000_000, 'Test Accountant']]);

  // with no dates, the current month, as the plant's today has it
  const today = plantDateStr();
  const month = await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}`, null, 'viewer'));
  assert.deepEqual([month.from, month.to], [`${today.slice(0, 7)}-01`, monthEnd(today)]);
  assert.ok([...month.entries, ...month.pending].every(e => e.date >= month.from && e.date <= month.to), 'only that month');
  // one end given: its month, from it or to it
  const from = await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-01-01`, null, 'viewer'));
  assert.deepEqual([from.from, from.to, from.entries], ['2027-01-01', '2027-01-31', book.entries]);
  const to = await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&to=2027-01-06`, null, 'viewer'));
  assert.deepEqual([to.from, to.to, to.entries.length, to.pending.length, to.closing_paise], ['2027-01-01', '2027-01-06', 1, 1, 13_000_000]);
  // a window, never the whole history: a year at most
  refused(await h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-01-01&to=2028-01-02`, null, 'viewer'), 400, 'FIN_BAD_INPUT', 'to');
  await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-01-01&to=2028-01-01`, null, 'viewer'));
  refused(await h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-01-31&to=2027-01-01`, null, 'viewer'), 400, 'FIN_BAD_INPUT', 'from');
  refused(await h.call('GET', `/finance/cash/book?ledger=${LEDGER[COUNTER]}&from=2027-13-01`, null, 'viewer'), 400, 'FIN_BAD_DATE', 'from');
  // and only a bank or cash account has one
  refused(await h.call('GET', `/finance/cash/book?ledger=${LEDGER[MOSS]}`, null, 'viewer'), 400, 'FIN_BAD_INPUT', 'ledger');
});

test('R65: asked for lean rows, the book sends its column names once and one array per line; put back, they are the plain answer\'s rows exactly', gate, async () => {
  const lib = await import('../../client/src/lib/finance/cash.js');
  assert.equal(typeof lib.finRehydrateBook, 'function', 'lib/finance/cash.js exports finRehydrateBook');
  // Its own account, party and month: Site Cash in March, a customer's cash by Auto with nothing open, a payment, and one that waits.
  const groups = (await ok(h.call('GET', `/finance/books/${CI}/groups`, null, 'md'))).groups;
  LEDGER[LEAN] = (await ok(h.call('POST', '/finance/ledgers', { book_id: CI, group_id: idOf(groups, 'Sundry Debtors'), name: LEAN }, 'acct'))).ledger.id;
  await ok(enter({ entry_type: 'receive', date: '2027-03-03', account: 'Site Cash', other: LEAN, rupees: 4000, adjust: AUTO }));
  await ok(enter({ entry_type: 'pay', date: '2027-03-04', account: 'Site Cash', other: FREIGHT, rupees: 1200, narration: 'freight to site' }));
  assert.equal((await ok(enter({ entry_type: 'pay', date: '2027-03-05', account: 'Site Cash', other: FREIGHT, rupees: 150000 }))).voucher.status,
    'submitted');
  const url = `/finance/cash/book?ledger=${LEDGER['Site Cash']}&from=2027-03-01&to=2027-03-31`;
  const plain = await ok(h.call('GET', url, null, 'viewer'));
  assert.deepEqual([plain.entries.map(e => [e.adjustment, e.narration]), plain.pending.length],
    [[['₹4,000 on account', null], [null, 'freight to site']], 1], 'non-vacuous: what a party line settled, a narration, and what waits');

  const lean = await ok(h.call('GET', `${url}&rows=lean`, null, 'viewer'));
  assert.deepEqual(Object.keys(lean), Object.keys(plain), 'the rest of the book as it was, in its place');
  assert.deepEqual(lean.entries.columns, [...lib.FIN_BOOK_ENTRY_COLUMNS]);
  assert.deepEqual(lean.pending.columns, [...lib.FIN_BOOK_PENDING_COLUMNS]);
  assert.deepEqual([lean.entries.rows.length, lean.pending.rows.length], [plain.entries.length, plain.pending.length]);
  assert.ok([...lean.entries.rows, ...lean.pending.rows].every(row => Array.isArray(row)), 'one array per line, and no line as an object');
  assert.ok(JSON.stringify(lean).length < JSON.stringify(plain).length, 'no key spelled out on every line');
  assert.equal(JSON.stringify(lib.finRehydrateBook(lean)), JSON.stringify(plain), 'put back: key for key, in order, every value');

  // Asked for exactly that: anything else is answered with the objects.
  for (const other of ['&rows=LEAN', '&rows=lean&rows=lean', '&rows=', '&fields=lean']) {
    assert.equal(JSON.stringify(await ok(h.call('GET', `${url}${other}`, null, 'viewer'))), JSON.stringify(plain), other);
  }
});

test('a retried client_key returns the same voucher', gate, async () => {
  const body = entryBody({ entry_type: 'receive', date: '2027-01-11', account: 'Cash', other: SABLE, rupees: 1000, adjust: AUTO });
  const first = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  assert.equal(first.voucher.status, 'posted');
  assert.deepEqual([first.allocations, first.on_account_paise, codes(first)], [[], 100_000, ['ON_ACCOUNT']], 'nothing of Sable\'s is open');
  assert.equal(first.replayed, false, 'a first save says it is one');
  assert.ok(!Object.hasOwn(first, 'replay_differs'));
  const was = await counts();
  const again = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  assert.deepEqual(again, { ...first, replayed: true }, 'the same voucher and the same answer, said to be a retry; the body is the same entry');
  assert.deepEqual(await counts(), was, 'the retry writes nothing');
  assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE client_key = $1', [body.client_key])).n, 1);
  // a key someone else's save took is no retry
  refused(await h.call('POST', '/finance/cash/entries', body, 'md'), 409, 'FIN_DUPLICATE_KEY');
  assert.deepEqual(await counts(), was);
});

// The double-click the client's join does not catch (two tabs, a retry while the first is still on the wire): two saves of one key
// at the very same moment. The second waits at the key for the first to settle, finds it taken, and answers with the first's voucher.
test('two saves of one client_key at once make one voucher: the second waits for the first and answers with it', gate, async () => {
  const body = entryBody({ entry_type: 'receive', date: '2027-01-11', account: 'Cash', other: SABLE, rupees: 700, adjust: AUTO });
  const first = await opened(c1);
  try {
    const made = await cash.finEnterCash(first.qc, first.oc, body, ACCT);
    assert.equal(made.voucher.status, 'posted');
    const second = watched(c2, (qc, oc) => cash.finEnterCash(qc, oc, body, ACCT));
    assert.equal(await waitsForTransaction(pid2, () => second.settled), true, 'the second save waits for the first');
    await first.commit();
    const answer = await second.done;
    assert.equal(answer.voucher.id, made.voucher.id);
    assert.equal(answer.voucher.number, made.voucher.number);
    assert.deepEqual([made.replayed, answer.replayed, Object.hasOwn(answer, 'replay_differs')], [false, true, false]);
    assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE client_key = $1', [body.client_key])).n, 1);
  } finally {
    await first.close();
  }
});

// Ruling R11. SP1's form makes one key per opened form and sends it again after a lost answer, with whatever is on screen then. So a
// retry may carry edits. It is never refused: it answers the voucher the key saved, as it stands, with the warnings and the money on
// account of THAT entry, rebuilt from the voucher itself, and says it is a retry; and, when the body asks for another entry, that too.
test('a posted cash receipt retried with an edited amount answers the voucher its key saved, with that entry\'s own warnings, and says the retry differs (ruling R11)', gate, async () => {
  const body = entryBody({ entry_type: 'receive', date: '2027-01-17', account: 'Cash', other: YARROW, rupees: 50000 });
  const first = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  assert.deepEqual([first.voucher.status, first.warnings], ['posted', [{ code: 'ON_ACCOUNT', sentence: '₹50,000.00 stays on account.' }]]);
  const was = await counts();
  // the answer was lost, and the form, sent again, now says ₹2,50,000: cash from one party that would reach s.269ST
  const again = await ok(h.call('POST', '/finance/cash/entries', { ...body, amount_paise: 25_000_000 }, 'acct'));
  assert.deepEqual(again.warnings, first.warnings, 'the entry that was saved, with its own warnings: no s.269ST for an entry that was never made');
  assert.deepEqual([first.replayed, again.replayed, again.replay_differs], [false, true, true],
    'the first save says it is one; the retry says it is a retry, and that its body asked for another entry');
  assert.deepEqual(again, { ...first, replayed: true, replay_differs: true }, 'and the rest of the answer is the stored entry\'s');
  assert.equal(again.voucher.total_paise, 5_000_000);
  assert.deepEqual(await counts(), was, 'nothing new was written');
});

test('an entry left waiting, retried as it was and with edits, answers the voucher its key saved, with its plan\'s on-account figure and its own warnings (ruling R11)', gate, async () => {
  const body = entryBody({ entry_type: 'pay', date: '2027-01-18', account: 'Cash', other: ZEPHYR, rupees: 120000, adjust: AUTO });
  const first = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  assert.equal(first.voucher.status, 'submitted', 'a payment above ₹1,00,000 waits for an Approver');
  assert.deepEqual([first.allocations, first.on_account_paise, codes(first)], [null, 2_000_000, ['ON_ACCOUNT', 'S40A3']],
    'Auto would settle Z-1 and leave ₹20,000 on account; ₹1,20,000 of cash to one party is over ₹10,000');
  const was = await counts();
  const same = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  // re-saved for ₹9,000, under the s.40A(3) limit: the answer is still the ₹1,20,000 that waits, with its warnings and its figure
  const edited = await ok(h.call('POST', '/finance/cash/entries', { ...body, amount_paise: 900_000 }, 'acct'));
  assert.deepEqual([edited.warnings, edited.on_account_paise], [first.warnings, first.on_account_paise],
    'the entry that waits, with its own warnings and its plan\'s figure, not those of an entry that was never made');
  assert.deepEqual([first.replayed, same.replayed, Object.hasOwn(same, 'replay_differs'), edited.replayed, edited.replay_differs],
    [false, true, false, true, true]);
  assert.deepEqual(same, { ...first, replayed: true });
  assert.deepEqual(edited, { ...first, replayed: true, replay_differs: true });
  // another adjustment chosen is another entry too, and the figure is still the stored plan's: Auto
  const repicked = await ok(h.call('POST', '/finance/cash/entries', { ...body, adjust: { mode: 'pick', picks: [] } }, 'acct'));
  assert.deepEqual([repicked.voucher.id, repicked.on_account_paise, repicked.replayed, repicked.replay_differs], [first.voucher.id, 2_000_000, true, true]);
  assert.deepEqual(await counts(), was, 'nothing new was written');
  // what waits is the stored entry, and its plan settles its bill when the MD approves it
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${first.voucher.id}/approve`, null, 'md'))).voucher.status, 'posted');
  assert.deepEqual(await allocationsOf(await lineOf(first.voucher.id, 1)), [[BILL[ZEPHYR]['Z-1'], 10_000_000, 'auto']]);
});

// A voucher sent back and edited in the voucher form may no longer be the shape of any cash entry: then there is no entry to say
// warnings of, and the retry is no retry of the body, whatever it says. Still no refusal: the voucher as it stands.
test('a retry of an entry edited past a cash entry\'s shape answers that voucher with no warnings, and says the retry differs (ruling R11)', gate, async () => {
  const body = entryBody({ entry_type: 'receive', date: '2027-01-19', account: 'Cash', other: YARROW, rupees: 5000, adjust: AUTO });
  const id = await whileReceiptsWait(async () => {
    const r = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
    assert.equal(r.voucher.status, 'submitted');
    await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/reject`, { reason: 'two customers paid' }, 'md'));
    await ok(h.call('PUT', `/finance/vouchers/${r.voucher.id}`, { lines: [
      { ledger_id: LEDGER.Cash, debit_paise: 500_000, credit_paise: 0 },
      { ledger_id: LEDGER[YARROW], debit_paise: 0, credit_paise: 300_000 }, { ledger_id: LEDGER[SABLE], debit_paise: 0, credit_paise: 200_000 },
    ] }, 'acct'));
    return r.voucher.id;
  });
  const was = await counts();
  const again = await ok(h.call('POST', '/finance/cash/entries', body, 'acct'));
  assert.deepEqual([again.voucher.id, again.voucher.status, again.allocations, again.on_account_paise, again.warnings, again.replayed, again.replay_differs],
    [id, 'draft', null, null, [], true, true]);
  assert.deepEqual(await counts(), was, 'nothing new was written');
});

test('the unadjusted list holds the ₹5,000 left on account; the party report shows 0104 part-open with its age in days, and ok: true', gate, async () => {
  const left = await ok(enter({ entry_type: 'receive', date: '2027-01-12', account: 'Cash', other: ORBIT, rupees: 15000, adjust: AUTO }));
  assert.deepEqual([left.allocations, left.on_account_paise], [[{ line_id: BILL[ORBIT]['0301'], amount_paise: 1_000_000 }], 500_000]);
  const list = await ok(h.call('GET', `/finance/cash/unadjusted?book=${CI}`, null, 'viewer'));
  assert.deepEqual(list.items.filter(i => i.ledger_id === LEDGER[ORBIT]).map(i => [i.line_id, i.party, i.number, i.date, i.amount_paise, i.open_paise]),
    [[await lineOf(left.voucher.id, 2), ORBIT, left.voucher.number, '2027-01-12', 1_500_000, 500_000]]);
  assert.equal(list.truncated, false);
  assert.ok(list.items.length >= 5, `non-vacuous: ${list.items.length} items on account`);
  assert.ok(list.items.every(i => i.open_paise > 0), 'only money still on account');
  assert.ok(!list.items.some(i => [ACME, NOVA, MOSS].includes(i.party) && i.label === 'Opening balance'), 'a customer\'s bill is not money on account');
  // a vendor's money on account is a payment ahead: Kestrel's
  assert.ok(list.items.some(i => i.ledger_id === LEDGER[KESTREL] && i.open_paise === 1_000_100));
  // the tiles count the very same money, in SQL
  const tiles = await cash.finCashAccounts(CI, { today: '2027-01-31' });
  assert.deepEqual(tiles.unadjusted, { count: list.items.length, amount_paise: list.items.reduce((sum, i) => sum + i.open_paise, 0) });

  // a customer who paid 0091 and part of 0104
  const part = await ok(enter({ entry_type: 'receive', date: '2027-01-12', account: 'Cash', other: NOVA, rupees: 60000,
    adjust: { mode: 'pick', picks: [{ line_id: BILL[NOVA]['0091'], amount_paise: null }, { line_id: BILL[NOVA]['0104'], amount_paise: null }] } }));
  assert.deepEqual(part.allocations, [{ line_id: BILL[NOVA]['0091'], amount_paise: 3_500_000 }, { line_id: BILL[NOVA]['0104'], amount_paise: 2_500_000 }]);
  const today = plantDateStr();
  const age = ageOn(today);
  const report = await ok(h.call('GET', `/finance/reports/party?ledger=${LEDGER[NOVA]}`, null, 'viewer'));
  assert.deepEqual(report.ledger, { id: LEDGER[NOVA], name: NOVA, book_id: CI, side: 'customer' });
  assert.equal(report.as_at, today);
  assert.deepEqual(report.open_items.map(i => [i.line_id, i.label, i.date, i.amount_paise, i.open_paise, i.age_days]), [
    [BILL[NOVA].lump, 'Opening balance', '2026-12-31', 2_000_000, 2_000_000, age('2026-12-31')],
    [BILL[NOVA]['0104'], '0104', '2026-12-18', 4_000_000, 1_500_000, age('2026-12-18')],
  ], 'what is outstanding: the lump, and ₹15,000 of 0104');
  assert.deepEqual(report.on_account, []);
  assert.deepEqual(report.check, { outstanding_paise: 3_500_000, on_account_paise: 0, balance_paise: 3_500_000, ok: true });
  // as at a day of the books, the age is the days since the bill's date
  const atMonthEnd = await cash.finPartyReport(LEDGER[NOVA], { today: '2027-01-31' });
  assert.deepEqual(atMonthEnd.open_items.map(i => [i.label, i.age_days]), [['Opening balance', 31], ['0104', 44]]);
  // a vendor's statement is the mirror image, and money on account shows on its own side
  const kestrel = await ok(h.call('GET', `/finance/reports/party?ledger=${LEDGER[KESTREL]}`, null, 'viewer'));
  assert.deepEqual([kestrel.ledger.side, kestrel.open_items, kestrel.on_account.map(i => i.open_paise)], ['vendor', [], [1_000_100, 1_000_100]]);
  assert.equal(kestrel.check.ok, true);
  // Ruling R58: the open items read says the party's standing too, the statement's own two figures (the entry form shows them beside
  // Auto and I'll pick): what is outstanding, and the money already on account
  for (const [name, statement, figures] of [[NOVA, report, [3_500_000, 0]], [KESTREL, kestrel, [0, 2_000_200]]]) {
    const open = await ok(h.call('GET', `/finance/ledgers/${LEDGER[name]}/open-items`, null, 'viewer'));
    assert.deepEqual([open.outstanding_paise, open.on_account_paise], figures, name);
    assert.deepEqual([open.outstanding_paise, open.on_account_paise], [statement.check.outstanding_paise, statement.check.on_account_paise], name);
  }
  // a ledger that is no party's has no statement
  refused(await h.call('GET', `/finance/reports/party?ledger=${LEDGER.Cash}`, null, 'viewer'), 409, 'FIN_NOT_PARTY_LINE');
  refused(await h.call('GET', '/finance/reports/party', null, 'viewer'), 400, 'FIN_BAD_INPUT', 'ledger');
});

// The party report and the open-items route read through the pool, where another login's posting can commit between any two
// statements. finOpenItems reads a party's items and its balance in ONE statement, so they always come from one snapshot. The proof
// commits a receipt for the party right after the first statement that reads its lines: read in one, the answer is the party as it
// stood before that receipt, whole; read in two, the balance would carry the receipt and the items would not, and ok would be false.
test('a party\'s open items and its balance come from one read: a receipt that posts mid-read is in neither or in both', gate, async () => {
  let injected = null;
  const midway = async (text, params) => {
    const rows = await h.db.q(text, params);
    if (!injected && /fin_voucher_lines/.test(text)) {
      injected = await ok(enter({ entry_type: 'receive', date: '2027-01-12', account: 'Cash', other: TERN, rupees: 4000, adjust: AUTO }));
    }
    return rows;
  };
  const seen = await alloc.finOpenItems(midway, LEDGER[TERN]);
  assert.ok(injected?.voucher?.status === 'posted', 'non-vacuous: a receipt posted while the items were being read');
  assert.deepEqual([seen.balance_paise, seen.debits.map(i => [i.label, i.open_paise]), seen.credits], [1_000_000, [['T-1', 1_000_000]], []],
    'the party as it stood before the receipt, items and balance alike');
  assert.equal(alloc.finPartyFigures(seen).ok, true);
  const now = await ok(h.call('GET', `/finance/reports/party?ledger=${LEDGER[TERN]}`, null, 'viewer'));
  assert.deepEqual([now.open_items.map(i => [i.label, i.open_paise]), now.check], [[['T-1', 600_000]],
    { outstanding_paise: 600_000, on_account_paise: 0, balance_paise: 600_000, ok: true }], 'and, read again, as it stands after it');
});

// ── An entry sent back, and edited (finUpdateDraft) ──────────────────────────────────────────

// A receipt needs no Approver (the seeded rule is never); for these tests the MD makes CI's receipts wait, through the rules
// route, and puts the rule back after, whatever happens.
async function whileReceiptsWait(fn) {
  const rule = (await h.db.one(`SELECT id FROM fin_approval_rules WHERE book_id = $1 AND rule_key = 'receipt'`, [CI])).id;
  await ok(h.call('PUT', `/finance/approval-rules/${rule}`, { mode: 'always' }, 'md'));
  try {
    return await fn();
  } finally {
    await ok(h.call('PUT', `/finance/approval-rules/${rule}`, { mode: 'never' }, 'md'));
  }
}
// The plan as the log's edit row of a voucher kept it: [before, after].
const editedPlans = async voucherId => (await h.db.q(
  `SELECT before -> 'allocation_plan' AS before, after -> 'allocation_plan' AS after, before ? 'allocation_plan' AS shown
     FROM fin_audit_log WHERE entity = 'voucher' AND action = 'edit' AND entity_id = $1 ORDER BY id`, [voucherId]))
  .map(row => [row.shown, row.before, row.after]);
const applied = async voucherId => (await h.db.one(
  `SELECT COUNT(*)::int AS n FROM fin_audit_log WHERE entity = 'allocation' AND action = 'apply' AND entity_id = $1`, [voucherId])).n;

// An entry an Approver sends back is a draft like any other, and its maker may edit it. Its plan named the party's line by number,
// so an edit that replaces the lines clears the plan: the money goes on account when it posts, and an old plan never settles a bill
// through a line that is no longer its party's, or another party's.
test('a cash receipt that waited, was rejected and was edited with new lines keeps no plan: once posted it settles nothing, and its money is on account', gate, async () => {
  const id = await whileReceiptsWait(async () => {
    const r = await ok(enter({ entry_type: 'receive', date: '2027-01-15', account: 'Cash', other: UMBRA, rupees: 6000, adjust: AUTO }));
    assert.equal(r.voucher.status, 'submitted', 'receipts wait for an Approver for now');
    assert.deepEqual(await planOf(r.voucher.id), { line_no: 2, mode: 'auto', picks: [] });
    const back = await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/reject`, { reason: 'the money came from Vireo' }, 'md'));
    assert.equal(back.voucher.status, 'draft');
    assert.deepEqual(await planOf(r.voucher.id), { line_no: 2, mode: 'auto', picks: [] }, 'sent back, it keeps its plan');
    // its maker puts it on the right customer, for the right amount: new lines, the party's still line 2
    const edited = await ok(h.call('PUT', `/finance/vouchers/${r.voucher.id}`, {
      narration: 'from Vireo, not Umbra',
      lines: [{ ledger_id: LEDGER.Cash, debit_paise: 700_000, credit_paise: 0 }, { ledger_id: LEDGER[VIREO], debit_paise: 0, credit_paise: 700_000 }],
    }, 'acct'));
    assert.equal(edited.voucher.total_paise, 700_000);
    assert.ok(!Object.hasOwn(edited.voucher, 'allocation_plan'), 'the plan is no part of what the API says of a voucher');
    assert.equal(await planOf(r.voucher.id), null, 'the lines it named are gone, and so is the plan');
    assert.deepEqual(await editedPlans(r.voucher.id), [[true, { line_no: 2, mode: 'auto', picks: [] }, null]],
      'the edit row of the log shows the plan it had, and that it has none now');
    return r.voucher.id;
  });

  // sent again, with receipts back to needing no Approver, it posts, and settles nothing by itself
  const posted = await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'acct'));
  assert.equal(posted.voucher.status, 'posted');
  const line = await lineOf(id, 2);
  assert.deepEqual(await allocationsOf(line), [], 'no bill is settled: there was no plan to settle it by');
  assert.equal(await applied(id), 0);
  const vireo = await alloc.finOpenItems(h.db.q, LEDGER[VIREO]);
  assert.deepEqual(vireo.debits.map(i => [i.label, i.open_paise]), [['VR-1', 1_000_000]], "the new party's bill is still open");
  assert.deepEqual(vireo.credits.map(i => [i.line_id, i.open_paise]), [[line, 700_000]], 'and the money waits on account, for a redo');
  assert.equal((await partyCheck(VIREO)).ok, true);
  assert.deepEqual((await alloc.finOpenItems(h.db.q, LEDGER[UMBRA])).debits.map(i => [i.label, i.open_paise]), [['U-1', 1_000_000]],
    'the first party is untouched: the entry was never posted to it');
  // the money on account is adjusted afterwards, as any is: a redo, Auto
  const redone = await ok(h.call('PUT', `/finance/lines/${line}/allocations`, { mode: 'auto' }, 'acct'));
  assert.deepEqual(redone, { allocations: [{ line_id: BILL[VIREO]['VR-1'], amount_paise: 700_000 }], on_account_paise: 0 });
});

test('an edit that leaves the lines be keeps the plan, which settles bills when the entry posts', gate, async () => {
  const id = await whileReceiptsWait(async () => {
    const r = await ok(enter({ entry_type: 'receive', date: '2027-01-15', account: 'Cash', other: WISP, rupees: 4000, adjust: AUTO }));
    assert.equal(r.voucher.status, 'submitted');
    await ok(h.call('POST', `/finance/vouchers/${r.voucher.id}/reject`, { reason: 'date it the 16th' }, 'md'));
    const edited = await ok(h.call('PUT', `/finance/vouchers/${r.voucher.id}`, { voucher_date: '2027-01-16', narration: 'Wisp, part of W-1' }, 'acct'));
    assert.equal(edited.voucher.voucher_date, '2027-01-16');
    assert.deepEqual(await planOf(r.voucher.id), { line_no: 2, mode: 'auto', picks: [] }, 'the lines are as they were, so the plan still names its line');
    assert.deepEqual(await editedPlans(r.voucher.id), [[true, { line_no: 2, mode: 'auto', picks: [] }, { line_no: 2, mode: 'auto', picks: [] }]]);
    return r.voucher.id;
  });
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'acct'))).voucher.status, 'posted');
  assert.deepEqual(await allocationsOf(await lineOf(id, 2)), [[BILL[WISP]['W-1'], 400_000, 'auto']], 'Auto, as the plan said');
  assert.equal(await applied(id), 1);

  // a voucher with no plan (one typed in the voucher form) keeps the edit row it always had: no plan in it
  const typed = (await ok(h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'journal', voucher_date: '2027-01-16', client_key: randomUUID(),
    lines: [{ ledger_id: LEDGER[FREIGHT], debit_paise: 100, credit_paise: 0 }, { ledger_id: LEDGER['Test Capital A/c'], debit_paise: 0, credit_paise: 100 }],
  }, 'acct'))).voucher;
  await ok(h.call('PUT', `/finance/vouchers/${typed.id}`, {
    lines: [{ ledger_id: LEDGER[FREIGHT], debit_paise: 200, credit_paise: 0 }, { ledger_id: LEDGER['Test Capital A/c'], debit_paise: 0, credit_paise: 200 }],
  }, 'acct'));
  assert.deepEqual(await editedPlans(typed.id), [[false, null, null]]);
});

test("GET /finance/cash/switch answers a login with no Finance grant: { date: '2027-01-01' }", gate, async () => {
  const r = await h.call('GET', '/finance/cash/switch', null, 'plant');
  assert.deepEqual([r.status, r.body], [200, { date: '2027-01-01' }]);
  assert.deepEqual((await ok(h.call('GET', '/finance/cash/switch', null, 'md'))), { date: '2027-01-01' });
});

test('a CI-only login sees no DP account, book, open item or preview', gate, async () => {
  const dp = [
    ['GET', `/finance/cash/accounts?book=${DP}`],
    ['GET', `/finance/cash/book?ledger=${DPL.cash}`],
    ['GET', `/finance/ledgers/${DPL.party}/open-items`],
    ['POST', '/finance/allocations/preview', { ledger_id: DPL.party, side: 'credit', amount_paise: 1000, mode: 'auto' }],
    ['GET', `/finance/cash/unadjusted?book=${DP}`],
    ['GET', `/finance/reports/party?ledger=${DPL.party}`],
  ];
  // the control: the MD holds DP, and each of these answers it
  for (const [method, url, body = null] of dp) assert.equal((await h.call(method, url, body, 'md')).status, 200, `md: ${method} ${url}`);
  for (const who of ['viewer', 'appr2']) {
    for (const [method, url, body = null] of dp) refused(await h.call(method, url, body, who), 403, 'FIN_FORBIDDEN');
    refused(await h.call('PUT', `/finance/lines/${DPL.line}/allocations`, { mode: 'auto' }, who), 403, 'FIN_FORBIDDEN');
    refused(await h.call('POST', '/finance/cash/entries', {
      book_id: DP, entry_type: 'receive', voucher_date: '2027-01-07', account_ledger_id: DPL.cash, other_ledger_id: DPL.party,
      amount_paise: 1000, client_key: randomUUID(),
    }, who), 403, 'FIN_FORBIDDEN');
    // the gate refuses the book, not the login: its own book answers
    assert.equal((await h.call('GET', `/finance/cash/accounts?book=${CI}`, null, who)).status, 200);
  }
  // a ledger, or a line, that is not there is refused the same way as another book's
  refused(await h.call('GET', '/finance/cash/book?ledger=99999999', null, 'viewer'), 403, 'FIN_FORBIDDEN');
  refused(await h.call('GET', '/finance/ledgers/99999999/open-items', null, 'viewer'), 403, 'FIN_FORBIDDEN');
  refused(await h.call('PUT', '/finance/lines/99999999/allocations', { mode: 'auto' }, 'acct'), 403, 'FIN_FORBIDDEN');
});

test('the tiles: one per active bank or cash ledger, as at today, with a holder\'s float, top-up and last count', gate, async () => {
  // Holder C is given ₹20,000 on 14 Jan and ₹5,000 more on 20 Jan, and counted on 15 Jan at ₹19,500 (Task 7 records counts)
  await ok(enter({ entry_type: 'transfer', date: '2027-01-14', account: 'Cash', other: HOLDER_C, rupees: 20000 }));
  await ok(enter({ entry_type: 'transfer', date: '2027-01-20', account: 'Cash', other: HOLDER_C, rupees: 5000 }));
  await h.db.q(`INSERT INTO fin_cash_counts (book_id, ledger_id, count_date, counted, book_balance, counted_by)
                VALUES ($1, $2, '2027-01-15', 19500, 20000, 'Test Accountant')`, [CI, LEDGER[HOLDER_C]]);
  const by = tiles => Object.fromEntries(tiles.accounts.map(a => [a.name, a]));

  const mid = await cash.finCashAccounts(CI, { today: '2027-01-15' });
  assert.equal(mid.as_at, '2027-01-15');
  assert.deepEqual(by(mid)[HOLDER_C], {
    ledger_id: LEDGER[HOLDER_C], name: HOLDER_C, account_kind: 'holder', balance_paise: 2_000_000, holder_name: 'Holder C',
    float_paise: 5_000_000, top_up_paise: 3_000_000, last_count: { count_date: '2027-01-15', difference_paise: -50_000, cleared_voucher_id: null, clearing_waiting: false },
  }, 'as at 15 Jan: what was given by then, and the top-up back to the float');
  const later = by(await cash.finCashAccounts(CI, { today: '2027-01-20' }))[HOLDER_C];
  assert.deepEqual([later.balance_paise, later.top_up_paise], [2_500_000, 2_500_000], 'as at 20 Jan the second transfer is in it');
  const before = by(await cash.finCashAccounts(CI, { today: '2027-01-14' }))[HOLDER_C];
  assert.equal(before.last_count, null, 'a count made later is not yet the last count');

  // every active bank and cash ledger, office cash first, then the holders, then the banks, each by name; nothing else
  assert.deepEqual(mid.accounts.map(a => [a.name, a.account_kind]), [
    ['Cash', 'cash'], [COUNTER, 'cash'], [PETTY, 'cash'], ['Site Cash', 'cash'],
    [HOLDER_A, 'holder'], [HOLDER_B, 'holder'], [HOLDER_C, 'holder'],
    [BANK_CC, 'bank'], [BANK, 'bank'],
  ], 'Site Cash is filed under a group beneath Cash-in-Hand; Old Cash is switched off');
  const opening = by(await cash.finCashAccounts(CI, { today: '2026-12-31' }));
  assert.deepEqual([opening.Cash.balance_paise, opening[BANK].balance_paise, opening[BANK_CC].balance_paise, opening[HOLDER_A].balance_paise],
    [10_000_000, 100_000_000, -32_000_000, 0], 'as at the opening day: the Tally balances, the overdraft below zero');
  assert.deepEqual([opening[HOLDER_A].float_paise, opening[HOLDER_A].top_up_paise, opening[HOLDER_B].float_paise, opening[HOLDER_B].top_up_paise],
    [5_000_000, 5_000_000, null, 0], 'a holder with no float has nothing to top up');
  assert.deepEqual([opening.Cash.holder_name, opening.Cash.float_paise, opening.Cash.top_up_paise, opening.Cash.last_count], [null, null, 0, null]);

  // the route answers as at the plant's today, and a login with no grant on the book is refused
  const viaRoute = await ok(h.call('GET', `/finance/cash/accounts?book=${CI}`, null, 'viewer'));
  assert.deepEqual(viaRoute, await cash.finCashAccounts(CI, { today: plantDateStr() }));
  refused(await h.call('GET', `/finance/cash/accounts?book=${DP}`, null, 'viewer'), 403, 'FIN_FORBIDDEN');
  refused(await h.call('GET', '/finance/cash/accounts', null, 'viewer'), 400, 'FIN_BAD_INPUT', 'book');
});

test('open items, and a preview that writes nothing; a redo through the route', gate, async () => {
  const [Q1, Q2] = [BILL[QUARTZ]['Q-1'], BILL[QUARTZ]['Q-2']];
  const open = await ok(h.call('GET', `/finance/ledgers/${LEDGER[QUARTZ]}/open-items`, null, 'viewer'));
  assert.deepEqual([open.ledger_id, open.side, open.balance_paise, open.credits], [LEDGER[QUARTZ], 'customer', 2_000_000, []]);
  assert.deepEqual(open.debits.map(i => [i.line_id, i.label, i.open_paise]), [[Q1, 'Q-1', 1_000_000], [Q2, 'Q-2', 1_000_000]]);
  refused(await h.call('GET', `/finance/ledgers/${LEDGER.Cash}/open-items`, null, 'viewer'), 409, 'FIN_NOT_PARTY_LINE');

  const was = await counts();
  const preview = body => h.call('POST', '/finance/allocations/preview', { ledger_id: LEDGER[QUARTZ], ...body }, 'viewer');
  const auto = await ok(preview({ side: 'credit', amount_paise: 1_500_000, mode: 'auto', reference: 'q-2' }));
  assert.deepEqual([auto.allocations, auto.on_account_paise], [[{ line_id: Q1, amount_paise: 1_000_000 }, { line_id: Q2, amount_paise: 500_000 }], 0],
    'Auto settles oldest first, whatever the list\'s order');
  const age = ageOn(plantDateStr());
  assert.deepEqual(auto.items.map(i => [i.line_id, i.label, i.open_paise, i.age_days]),
    [[Q2, 'Q-2', 1_000_000, age('2026-12-20')], [Q1, 'Q-1', 1_000_000, age('2026-12-05')]], 'the bill the typed reference names comes first');
  const picked = await ok(preview({ side: 'credit', amount_paise: 1_500_000, mode: 'pick', picks: [{ line_id: Q2, amount_paise: null }] }));
  assert.deepEqual([picked.allocations, picked.on_account_paise], [[{ line_id: Q2, amount_paise: 1_000_000 }], 500_000]);
  const unchosen = await ok(preview({ side: 'credit', amount_paise: 1_500_000 }));
  assert.deepEqual([unchosen.allocations, unchosen.on_account_paise, unchosen.items.length], [[], 1_500_000, 2], 'no choice yet: the list, and all on account');
  const refund = await ok(preview({ side: 'debit', amount_paise: 100_000, mode: 'auto' }));
  assert.deepEqual([refund.allocations, refund.on_account_paise, refund.items], [[], 100_000, []], 'money paid to a customer meets no open credit');
  refused(await preview({ side: 'sideways', amount_paise: 1 }), 400, 'FIN_BAD_INPUT', 'side');
  refused(await preview({ side: 'credit', amount_paise: -1 }), 400, 'FIN_BAD_INPUT', 'amount_paise');
  refused(await preview({ side: 'credit', amount_paise: 100, mode: 'oldest' }), 400, 'FIN_BAD_INPUT', 'mode');
  refused(await h.call('POST', '/finance/allocations/preview', { side: 'credit', amount_paise: 100 }, 'viewer'), 400, 'FIN_BAD_INPUT', 'ledger_id');
  assert.deepEqual(await counts(), was, 'a preview writes nothing');

  // a receipt settles Q-1 by Auto; a redo through the route moves it onto Q-2, and the book says so
  const r = await ok(enter({ entry_type: 'receive', date: '2027-01-13', account: 'Cash', other: QUARTZ, rupees: 10000, adjust: AUTO }));
  assert.deepEqual(r.allocations, [{ line_id: Q1, amount_paise: 1_000_000 }]);
  const line = await lineOf(r.voucher.id, 2);
  refused(await h.call('PUT', `/finance/lines/${line}/allocations`, { mode: 'auto' }, 'viewer'), 403, 'FIN_FORBIDDEN');
  const redone = await ok(h.call('PUT', `/finance/lines/${line}/allocations`, { mode: 'pick', picks: [{ line_id: Q2, amount_paise: null }] }, 'acct'));
  assert.deepEqual(redone, { allocations: [{ line_id: Q2, amount_paise: 1_000_000 }], on_account_paise: 0 });
  assert.deepEqual(await allocationsOf(line), [[Q2, 1_000_000, 'pick']]);
  refused(await h.call('PUT', `/finance/lines/${line}/allocations`, { mode: 'oldest' }, 'acct'), 400, 'FIN_BAD_INPUT', 'mode');
  const book = await ok(h.call('GET', `/finance/cash/book?ledger=${LEDGER.Cash}&from=2027-01-13&to=2027-01-13`, null, 'viewer'));
  assert.deepEqual(book.entries.filter(e => e.voucher_id === r.voucher.id).map(e => [e.particulars, e.adjustment]), [[QUARTZ, 'Pick: 1 bill, ₹0 on account']]);
  assert.deepEqual(await partyCheck(QUARTZ), { outstanding_paise: 1_000_000, on_account_paise: 0, balance_paise: 1_000_000, ok: true });

  // A redo's own preview (the Cash & Bank screen's Redo and Adjust, line_id): a redo deletes the line's allocations before it settles
  // again, so the bill the line settles now (Q-2) is open again in it, and all of the line is the money. The side and the amount are
  // the line's own; the body sends neither.
  const still = await counts();
  const repick = await ok(preview({ line_id: line, mode: 'pick', picks: [{ line_id: Q2, amount_paise: 400_000 }] }));
  assert.deepEqual([repick.side, repick.amount_paise, repick.allocations, repick.on_account_paise],
    ['credit', 1_000_000, [{ line_id: Q2, amount_paise: 400_000 }], 600_000]);
  assert.deepEqual(repick.items.map(i => [i.line_id, i.label, i.open_paise, i.age_days]),
    [[Q1, 'Q-1', 1_000_000, age('2026-12-05')], [Q2, 'Q-2', 1_000_000, age('2026-12-20')]], 'Q-2, which the line settles now, is offered again');
  const reauto = await ok(preview({ line_id: line, mode: 'auto', reference: 'q-2' }));
  assert.deepEqual([reauto.allocations, reauto.on_account_paise], [[{ line_id: Q1, amount_paise: 1_000_000 }], 0], 'Auto, oldest first, as a redo would');
  assert.deepEqual(reauto.items.map(i => i.line_id), [Q2, Q1], 'the typed reference still orders the list');
  const unpicked = await ok(preview({ line_id: line }));
  assert.deepEqual([unpicked.allocations, unpicked.on_account_paise, unpicked.items.length], [[], 1_000_000, 2], 'no choice yet: all on account');
  // a bill's own redo works the other side: the receipt line it pairs with is open again, less what it settles elsewhere
  const bills = await ok(preview({ line_id: Q2, mode: 'auto' }));
  assert.deepEqual([bills.side, bills.amount_paise, bills.allocations, bills.on_account_paise],
    ['debit', 1_000_000, [{ line_id: line, amount_paise: 1_000_000 }], 0]);
  // anything that is not a live party line of THIS ledger is refused alike, whether it is there or not
  for (const other of [await lineOf(r.voucher.id, 1), BILL[NOVA]['0104'], 99_999_999]) {
    refused(await preview({ line_id: other, mode: 'auto' }), 409, 'FIN_NOT_PARTY_LINE');
  }
  refused(await preview({ line_id: 'two', mode: 'auto' }), 400, 'FIN_BAD_INPUT', 'line_id');
  refused(await preview({ line_id: line, mode: 'oldest' }), 400, 'FIN_BAD_INPUT', 'mode');
  assert.deepEqual(await counts(), still, 'a redo\'s preview writes nothing either');
  assert.deepEqual(await allocationsOf(line), [[Q2, 1_000_000, 'pick']], 'and the line still settles what it settled');
});

// The entry form lists the customers first on Receive and the vendors first on Pay, and offers TDS on that side only (spec §5.1,
// §5.2), so the ledgers read says which side a party ledger is on: finPartySide's answer, the one the entries and the engine ask. These
// parties came in from Tally under Sundry Debtors and Sundry Creditors with no ERP customer or vendor linked: the group decides.
test('the ledgers read says which side a party ledger is on, by the one definition', gate, async () => {
  const listed = (await ok(h.call('GET', `/finance/books/${CI}/ledgers`, null, 'viewer'))).ledgers;
  const of = name => listed.find(l => l.name === name);
  assert.deepEqual([QUARTZ, JUNO, 'Cash', FREIGHT, 'Staff Advances'].map(name => [name, of(name).party_type, of(name).party_side]), [
    [QUARTZ, null, 'customer'], [JUNO, null, 'vendor'], ['Cash', null, null], [FREIGHT, null, null], ['Staff Advances', null, null],
  ]);
  assert.ok(listed.every(l => l.party_side === null || l.is_party), 'only a party ledger has a side');
});

// A browser keeps a GET's answer until one of the tables it was built from changes (data-tables.js), so every Cash & Bank read must
// be a plain read that names its tables, and name no function of the schema's own (the app counts those as hiding their tables).
test('the Cash & Bank reads write nothing and tell the response cache which tables they read', gate, async () => {
  const catalogue = await h.db.q(`
    SELECT tablename AS name, 'table' AS kind FROM pg_tables WHERE schemaname = 'public'
    UNION ALL SELECT viewname, 'opaque' FROM pg_views WHERE schemaname = 'public'
    UNION ALL SELECT matviewname, 'opaque' FROM pg_matviews WHERE schemaname = 'public'
    UNION ALL SELECT p.proname, 'opaque' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
  setKnownTables(catalogue.filter(r => r.kind === 'table').map(r => r.name), catalogue.filter(r => r.kind === 'opaque').map(r => r.name));
  const raw = async path => {
    const res = await fetch(h.base + path, { headers: { authorization: `Bearer ${h.users.md.token}` } });
    assert.equal(res.status, 200, path);
    await res.json();
    return res.headers;
  };
  const tables = headers => (headers.get('x-data-tables') ?? '').split(',').filter(Boolean);
  const cases = [
    ['/finance/cash/switch', ['fin_books']],
    [`/finance/cash/accounts?book=${CI}`, ['fin_allocations', 'fin_cash_counts', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/cash/book?ledger=${LEDGER.Cash}&from=2027-01-01&to=2027-01-31`, ['fin_allocations', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/cash/unadjusted?book=${CI}`, ['fin_allocations', 'fin_ledgers', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/ledgers/${LEDGER[ACME]}/open-items`, ['fin_allocations', 'fin_voucher_lines', 'fin_vouchers']],
    [`/finance/reports/party?ledger=${LEDGER[ACME]}`, ['fin_allocations', 'fin_voucher_lines', 'fin_vouchers']],
  ];
  for (const [path, expected] of cases) {
    const headers = await raw(path);
    assert.ok(headers.get('x-data-tables'), `${path} is cacheable`);
    assert.equal(headers.get('x-data-wrote'), null, `${path} writes nothing`);
    for (const t of expected) assert.ok(tables(headers).includes(t), `${path} lists ${t}: ${headers.get('x-data-tables')}`);
    assert.ok(!tables(headers).includes('fin_access'), `${path}: who may ask is not part of the answer`);
  }
});

// Ruling R59 (spec §5.6): before an entry is saved, the form asks the preview for the party's cash that day, for s.269ST and s.40A(3),
// and adds the entry it is typing. Posted entries count, and so do entries waiting for an Approver; a bank is no cash, and neither is
// another day, another ledger or the other side of the party's ledger; a reversed entry and its reversal stand for nothing; and the entry
// the form's save key saved already (its answer was lost, and the form is saving it again) is left out, as the form adds it itself.
test('the preview answers the party\'s cash that day: posted and waiting, cash only, the entry being typed left out (ruling R59)', gate, async () => {
  const day = '2027-01-21';
  const ask = (name, side, body) => h.call('POST', '/finance/allocations/preview', { ledger_id: LEDGER[name], side, amount_paise: 100, ...body }, 'viewer');
  // Paid to Pivot: ₹3,000 cash, posted; ₹1,50,000 cash, waiting for the MD (over the payment rule's limit); ₹5,000 by bank; ₹2,000 cash
  // the day after; and, that day, ₹4,000 cash to Test Freight, another ledger
  const posted = await ok(enter({ entry_type: 'pay', date: day, account: 'Cash', other: PIVOT, rupees: 3000 }));
  const key = randomUUID();
  const waiting = await ok(enter({ entry_type: 'pay', date: day, account: COUNTER, other: PIVOT, rupees: 150000, client_key: key }));
  assert.deepEqual([posted.voucher.status, waiting.voucher.status], ['posted', 'submitted']);
  await ok(enter({ entry_type: 'pay', date: day, account: BANK, other: PIVOT, rupees: 5000 }));
  await ok(enter({ entry_type: 'pay', date: '2027-01-22', account: 'Cash', other: PIVOT, rupees: 2000 }));
  await ok(enter({ entry_type: 'pay', date: day, account: 'Cash', other: FREIGHT, rupees: 4000 }));
  // Received from Ridge that day: ₹1,50,000 cash, ₹40,000 into a holder's cash, ₹90,000 by bank; and ₹10,000 cash that the MD reversed
  await ok(enter({ entry_type: 'receive', date: day, account: 'Cash', other: RIDGE, rupees: 150000 }));
  await ok(enter({ entry_type: 'receive', date: day, account: HOLDER_A, other: RIDGE, rupees: 40000 }));
  await ok(enter({ entry_type: 'receive', date: day, account: BANK, other: RIDGE, rupees: 90000 }));
  const undone = await ok(enter({ entry_type: 'receive', date: day, account: 'Cash', other: RIDGE, rupees: 10000 }));
  const reversal = (await ok(h.call('POST', `/finance/vouchers/${undone.voucher.id}/reverse`, { date: day, reason: 'entered twice' }, 'md'))).voucher;
  assert.equal(reversal.status, 'posted');
  const still = await counts();

  const paid = await ok(ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: LEDGER.Cash }));
  assert.equal(paid.party_cash_day_paise, 15_300_000, 'the ₹3,000 posted and the ₹1,50,000 waiting; not the bank, the next day or Freight');
  assert.deepEqual([paid.allocations, paid.on_account_paise], [[], 100], 'and the preview\'s own answer is as it was');
  // every cash ledger counts the day, a holder's included, whichever cash account the form names
  assert.equal((await ok(ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: LEDGER[HOLDER_A] }))).party_cash_day_paise, 15_300_000);
  // the entry the form's key saved already is the form's to add: a retry's preview leaves it out
  assert.equal((await ok(ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: LEDGER.Cash, client_key: key }))).party_cash_day_paise, 300_000);
  assert.equal((await ok(ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: LEDGER.Cash, client_key: randomUUID() }))).party_cash_day_paise,
    15_300_000, 'a key that saved nothing leaves nothing out');
  // paid to the vendor is not received from it
  assert.equal((await ok(ask(PIVOT, 'credit', { voucher_date: day, account_ledger_id: LEDGER.Cash }))).party_cash_day_paise, 0);
  // a bank has no cash limit, and another book's account is no account of this book: no figure for either
  for (const account of [LEDGER[BANK], DPL.cash]) {
    assert.equal((await ok(ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: account }))).party_cash_day_paise, null);
  }
  // asked without the day and the account, the preview is what it was, with no figure at all
  assert.equal('party_cash_day_paise' in (await ok(ask(PIVOT, 'debit', {}))), false);
  // received from Ridge: its cash receipts, wherever the cash went, and nothing of the bank or the reversed receipt and its reversal
  const received = await ok(ask(RIDGE, 'credit', { voucher_date: day, account_ledger_id: LEDGER.Cash }));
  assert.equal(received.party_cash_day_paise, 19_000_000, '₹1,50,000 and ₹40,000 in cash');

  // what the preview is asked is checked: a day that is no day, an account that is none, a save key that is no key
  refused(await ask(PIVOT, 'debit', { voucher_date: '2027-13-40', account_ledger_id: LEDGER.Cash }), 400, 'FIN_BAD_DATE', 'voucher_date');
  refused(await ask(PIVOT, 'debit', { voucher_date: day }), 400, 'FIN_BAD_INPUT', 'account_ledger_id');
  refused(await ask(PIVOT, 'debit', { account_ledger_id: LEDGER.Cash }), 400, 'FIN_BAD_DATE', 'voucher_date');
  refused(await ask(PIVOT, 'debit', { voucher_date: day, account_ledger_id: LEDGER.Cash, client_key: 'nope' }), 400, 'FIN_BAD_INPUT', 'client_key');
  // a redo's preview has no entry being typed, so no day's cash
  const redo = await ok(ask(PIVOT, 'debit', { line_id: await lineOf(posted.voucher.id, 1), voucher_date: day, account_ledger_id: LEDGER.Cash }));
  assert.deepEqual(['party_cash_day_paise' in redo, redo.amount_paise], [false, 300_000]);
  assert.deepEqual(await counts(), still, 'a preview writes nothing');
});
