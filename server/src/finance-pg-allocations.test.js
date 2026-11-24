import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';

// Bill-wise adjustment (Cash & Bank spec §6): a receipt or a payment settles a party's bills when it posts, Auto or Pick, and is
// never refused for not matching; a redo changes no balance, in any month; a reversal releases what the entry it reverses
// settled; and two postings for one party at once never settle a bill twice (the party lock, ruling R7).
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-allocations.test.js
//
// One boot for the file. CI's Opening is built through the import routes, as at 31 Dec 2026. Six customers have the same three
// opening items: a lump of ₹20,000 with no bill behind it (the "Opening balance"), bill 0091 of 2 Dec for ₹35,000 and bill 0104
// of 18 Dec for ₹40,000, ₹95,000 in all. Each test settles bills of its own customer, so no test finds another's leftovers.
// The receipts are made as the brief says (ruling R1): a draft through the API, its allocation_plan set on the draft by hand
// (Task 6 adds the entry route that writes it), then submitted through the API by the accountant. A receipt needs no approval,
// so it posts. Every name and figure here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const R = 100;   // paise per rupee

let h;
let alloc;       // finance-allocations.js, the module under test
let vouchers;    // finance-vouchers.js, for the transactions held open on raw clients
let CI;
const LEDGER = {};   // ledger name -> id
const BILL = {};     // party name -> { lump | <bill ref> -> its Opening line id }
const PERIOD = {};   // CI month start_date -> period id
let c1, c2, pid1, pid2;
let MD, ACCT;        // actors, as a route hands them on

const ACME = 'Acme Pharma';
const BOLT = 'Bolt Labs';
const COBALT = 'Cobalt Test Labs';
const DUNE = 'Dune Test Pharma';
const EMBER = 'Ember Test Labs';
const GALE = 'Gale Test Pharma';
const HALE = 'Hale Test Labs';
const IRIS = 'Iris Test Pharma';
const KITE = 'Kite Test Labs';            // a customer whose opening is one lump, with no bills
const LARK = 'Lark Test Pharma';          // a customer in credit: an advance carried in from Tally
const JUNO = 'Juno Test Packaging';       // a vendor with nothing outstanding
const QUILL = 'Quill Test Labs';          // R9: a bill reversed, and the reversal reversed
const REED = 'Reed Test Pharma';          // R9: …and reversed once more
const SAGE = 'Sage Test Labs';            // a redo racing a receipt, the redo first
const TEAL = 'Teal Test Pharma';          // …the receipt first
const UMBER = 'Umber Test Labs';          // a redo racing the reversal of its own receipt, the reversal first
const OCHRE = 'Ochre Test Pharma';        // …the redo first
const VALE = 'Vale Test Pharma';          // the generated walk: two opening bills
const WREN = 'Wren Test Labs';            // …an opening lump
const YEW = 'Yew Test Health';            // …nothing
const FERN = 'Fern Test Labs';            // R71: Adjust spends only the money on account; Redo works the whole line again
const GORSE = 'Gorse Test Labs';          // R76: Adjust onto a bill the line part-settles already tops that allocation up
const SALES = 'Test Sales';
const THREE_BILLS = [ACME, BOLT, COBALT, DUNE, EMBER, GALE];

// The Tally files, as at 31 Dec 2026, in rupees: Dr 9,05,000 and Cr 9,05,000.
const tb = (tally_name, dr, cr) => ({ tally_name, debit_paise: dr * R, credit_paise: cr * R });
const bill = (tally_ledger_name, bill_ref, bill_date, rupees) =>
  ({ tally_ledger_name, bill_ref, bill_date, due_date: null, amount_paise: rupees * R, side: 'dr' });
const ACCOUNTS = [
  { tally_name: 'Cash', tally_group: 'Cash-in-Hand' },
  { tally_name: 'Test Capital A/c', tally_group: 'Capital Account' },
  ...[...THREE_BILLS, HALE, IRIS, KITE, LARK, QUILL, REED, SAGE, TEAL, UMBER, OCHRE, VALE, WREN, YEW, FERN, GORSE]
    .map(tally_name => ({ tally_name, tally_group: 'Sundry Debtors' })),
  { tally_name: JUNO, tally_group: 'Sundry Creditors' },
  { tally_name: SALES, tally_group: 'Sales Accounts' },
];
const TB = [
  tb('Cash', 100000, 0), tb('Test Capital A/c', 0, 890000),
  ...THREE_BILLS.map(name => tb(name, 95000, 0)),
  tb(HALE, 10000, 0), tb(IRIS, 10000, 0), tb(KITE, 20000, 0), tb(LARK, 0, 15000),
  tb(QUILL, 0, 0), tb(REED, 0, 0), tb(SAGE, 20000, 0), tb(TEAL, 20000, 0), tb(UMBER, 10000, 0), tb(OCHRE, 10000, 0),
  tb(VALE, 20000, 0), tb(WREN, 15000, 0), tb(YEW, 0, 0), tb(FERN, 60000, 0), tb(GORSE, 40000, 0),
  tb(JUNO, 0, 0), tb(SALES, 0, 0),
];
const BILLS = [
  ...THREE_BILLS.flatMap(name => [bill(name, null, null, 20000), bill(name, '0091', '2026-12-02', 35000), bill(name, '0104', '2026-12-18', 40000)]),
  bill(HALE, '0201', '2026-12-10', 10000),
  bill(IRIS, '0202', '2026-12-10', 10000),
  bill(SAGE, 'S-1', '2026-12-05', 10000), bill(SAGE, 'S-2', '2026-12-20', 10000),
  bill(TEAL, 'T-1', '2026-12-05', 10000), bill(TEAL, 'T-2', '2026-12-20', 10000),
  bill(UMBER, 'U-1', '2026-12-05', 10000),
  bill(OCHRE, 'O-1', '2026-12-05', 10000),
  bill(VALE, 'V-01', '2026-12-03', 12000), bill(VALE, 'V-02', '2026-12-15', 8000),
  bill(FERN, 'F-1', '2026-12-04', 30000), bill(FERN, 'F-2', '2026-12-16', 20000), bill(FERN, 'F-3', '2026-12-22', 10000),
  bill(GORSE, 'G-1', '2026-12-06', 30000), bill(GORSE, 'G-2', '2026-12-19', 10000),
];

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

// ── Raw clients: a route's transaction, held open where a test says so (finance-pg-race.test.js) ──────────────

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
// Whether backend `pid` waits for the party lock of `ledgerId`, asked of Postgres and not of the clock, through the pool and
// outside any transaction: pg_locks shows it as an advisory lock not granted, keyed (7300, ledger id), which a two-key advisory
// lock reports as classid and objid with objsubid 2. A number series' lock is keyed (764002, …), so it is never mistaken for
// one. `settled()` is what the waiter's own call has come to: one that settled never waited, and false comes back at once.
async function waitsForPartyLock(pid, ledgerId, settled = () => null) {
  for (let i = 0; i < 400; i++) {
    if (settled() !== null) return false;
    const row = await h.db.one(`SELECT 1 AS waiting FROM pg_locks
      WHERE pid = $1 AND locktype = 'advisory' AND NOT granted AND classid::bigint = $2 AND objid::bigint = $3 AND objsubid = 2`,
    [pid, alloc.FIN_ALLOC_LOCK_NS ?? 7300, ledgerId]);
    if (row) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}
// A call on a raw client, run as a route runs it, with what it has come to kept for waitsForPartyLock: { value } or { error }.
function watched(client, fn) {
  const state = { settled: null };
  state.done = inTx(client, fn).then(value => { state.settled = { value }; return value; }, error => { state.settled = { error }; throw error; });
  state.done.catch(() => {});
  return state;
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('allocations');
  // Loaded softly, so that before the module exists each test fails on its own assertion and not all of them on the import.
  alloc = await import('./finance-allocations.js').catch(() => ({}));
  vouchers = await import('./finance-vouchers.js');
  CI = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;

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

  for (const l of await h.db.q('SELECT id, name FROM fin_ledgers WHERE book_id = $1', [CI])) LEDGER[l.name] = l.id;
  const nameOf = Object.fromEntries(Object.entries(LEDGER).map(([name, id]) => [id, name]));
  for (const l of await h.db.q('SELECT id, ledger_id, bill_ref FROM fin_voucher_lines WHERE voucher_id = $1', [built.id])) {
    (BILL[nameOf[l.ledger_id]] ??= {})[l.bill_ref ?? 'lump'] = l.id;
  }
  for (const p of await h.db.q('SELECT id, start_date FROM fin_periods WHERE book_id = $1', [CI])) PERIOD[p.start_date] = p.id;
  // A second financial year, so that two receipts can be minted from two number series and meet at nothing but the party lock.
  await ok(h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md'));

  MD = { id: h.users.md.id, name: 'Test MD', roles: ['approver', 'admin'] };
  ACCT = { id: h.users.acct.id, name: 'Test Accountant', roles: ['accountant'] };
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

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

// The plan the entry form will write with the draft (ruling R1: set on the draft by hand until Task 6's route writes it).
async function setPlan(id, plan) {
  const set = await h.db.q(`UPDATE fin_vouchers SET allocation_plan = $1::jsonb WHERE id = $2 AND status = 'draft' RETURNING id`,
    [JSON.stringify(plan), id]);
  assert.equal(set.length, 1, 'the plan is set on a draft');
}
const lineOf = async (voucherId, lineNo) =>
  (await h.db.one('SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = $2', [voucherId, lineNo])).id;

// A draft through the API by `who`. `lines` are [ledger name, debit rupees, credit rupees, bill_ref?, bill_date?]. Its id.
async function draft(voucher_type, date, lines, { who = 'acct', plan = null } = {}) {
  const v = (await ok(h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type, voucher_date: date, client_key: randomUUID(), narration: `${voucher_type} ${date}`,
    lines: lines.map(([name, dr, cr, bill_ref = null, bill_date = null]) =>
      ({ ledger_id: LEDGER[name], debit_paise: dr * R, credit_paise: cr * R, bill_ref, bill_date })),
  }, who))).voucher;
  if (plan) await setPlan(v.id, plan);
  return v.id;
}
// A receipt from `customer` into Cash: line 1 Cash Dr, line 2 the customer Cr, which `adjust` (Auto or Pick) settles bills with.
const receiptDraft = (customer, rupees, adjust, { date = '2027-01-05', who = 'acct' } = {}) =>
  draft('receipt', date, [['Cash', rupees, 0], [customer, 0, rupees]], { who, plan: adjust && { line_no: 2, ...adjust } });

// Submitted through the API: { id, number, line }, line being the party's line. Receipts and small payments post at once.
async function posted(id, who = 'acct', partyLine = 2) {
  const v = (await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, who))).voucher;
  assert.equal(v.status, 'posted', JSON.stringify(v));
  return { id, number: v.number, line: await lineOf(id, partyLine) };
}
const postedReceipt = async (customer, rupees, adjust, opts) => posted(await receiptDraft(customer, rupees, adjust, opts));

const AUTO = { mode: 'auto', picks: [] };
const pick = (...lineIds) => ({ mode: 'pick', picks: lineIds.map(line_id => ({ line_id, amount_paise: null })) });

// ── Reading what is settled ──────────────────────────────────────────────────────────────────

// The allocations a line takes part in, oldest first: [the other line, paise, mode].
const allocationsOf = async lineId => (await h.db.q(
  `SELECT CASE WHEN credit_line_id = $1 THEN debit_line_id ELSE credit_line_id END AS other, amount, mode
     FROM fin_allocations WHERE debit_line_id = $1 OR credit_line_id = $1 ORDER BY id`, [lineId]))
  .map(a => [a.other, Math.round(a.amount * R), a.mode]);
// The allocations touching any line of a voucher.
const allocationsOnVoucher = async voucherId => (await h.db.one(
  `SELECT COUNT(*)::int AS n FROM fin_allocations a
    WHERE a.debit_line_id IN (SELECT id FROM fin_voucher_lines WHERE voucher_id = $1)
       OR a.credit_line_id IN (SELECT id FROM fin_voucher_lines WHERE voucher_id = $1)`, [voucherId])).n;
// How much of each Opening item of `party` is settled, in paise: { lump, '0091', '0104' }.
async function settledOf(party) {
  const out = {};
  for (const [ref, line] of Object.entries(BILL[party])) {
    out[ref] = Math.round((await h.db.one('SELECT COALESCE(sum(amount), 0) AS s FROM fin_allocations WHERE debit_line_id = $1', [line])).s * R);
  }
  return out;
}
const partyCheck = name => alloc.finPartyCheck(h.db.q, LEDGER[name]);
const openItems = name => alloc.finOpenItems(h.db.q, LEDGER[name]);
const ledgerBalance = async name => Math.round((await h.db.one(
  `SELECT COALESCE(sum(l.debit - l.credit), 0) AS b FROM fin_voucher_lines l JOIN fin_vouchers v ON v.id = l.voucher_id
    WHERE l.ledger_id = $1 AND v.status = 'posted'`, [LEDGER[name]])).b * R);
const allocationAudit = async (action, voucherId) => h.db.q(
  `SELECT entity_id, user_id, user_name, before, after FROM fin_audit_log
    WHERE entity = 'allocation' AND action = $1 AND entity_id = $2 ORDER BY id`, [action, voucherId]);
const counts = async () => h.db.one(`SELECT (SELECT COUNT(*)::int FROM fin_allocations) allocations,
  (SELECT COUNT(*)::int FROM fin_audit_log) audit, (SELECT COUNT(*)::int FROM fin_vouchers) vouchers`);

const redo = (lineId, how, actor = ACCT) => h.db.tx((qc, oc) => alloc.finRedoAllocations(qc, oc, lineId, how, actor));
const refusedAs = (status, code) => e => {
  assert.equal(e?.status, status, e?.stack ?? String(e));
  assert.equal(e?.body?.code, code, e?.message);
  return true;
};

// A month moved through the screens' own route by the MD, one allowed step at a time (finance-pg-opening-locks.test.js).
const STEPS = ['open', 'closing', 'locked'];
async function setMonth(start, target) {
  for (;;) {
    const { status } = await h.db.one('SELECT status FROM fin_periods WHERE id = $1', [PERIOD[start]]);
    if (status === target) return;
    const next = STEPS[STEPS.indexOf(status) + (STEPS.indexOf(target) > STEPS.indexOf(status) ? 1 : -1)];
    const body = STEPS.indexOf(next) < STEPS.indexOf(status) ? { status: next, reason: 'put back after the test' } : { status: next };
    await ok(h.call('PUT', `/finance/periods/${PERIOD[start]}/status`, body, 'md'));
  }
}

// ── Auto and Pick (spec §6.3, §6.4) ──────────────────────────────────────────────────────────

test('Auto: the receipt of ₹81,600 settles the lump, 0091, then ₹26,600 of 0104; finPartyCheck ok', gate, async () => {
  // Before: three open items, in Auto's order: the lump (dated the Opening's own day, and first because it is the lump), then
  // the bills by date. Each says what it is.
  const open = await openItems(ACME);
  assert.equal(open.side, 'customer', 'filed under Sundry Debtors');
  assert.equal(open.balance_paise, 95000 * R);
  assert.deepEqual(open.debits.map(i => [i.line_id, i.label, i.date, i.is_opening_lump, i.amount_paise, i.open_paise]), [
    [BILL[ACME].lump, 'Opening balance', '2026-12-31', true, 20000 * R, 20000 * R],
    [BILL[ACME]['0091'], '0091', '2026-12-02', false, 35000 * R, 35000 * R],
    [BILL[ACME]['0104'], '0104', '2026-12-18', false, 40000 * R, 40000 * R],
  ]);
  assert.deepEqual(open.credits, []);

  const r = await postedReceipt(ACME, 81600, AUTO);
  assert.deepEqual(await allocationsOf(r.line), [
    [BILL[ACME].lump, 20000 * R, 'auto'], [BILL[ACME]['0091'], 35000 * R, 'auto'], [BILL[ACME]['0104'], 26600 * R, 'auto'],
  ]);
  assert.deepEqual(await partyCheck(ACME), { outstanding_paise: 13400 * R, on_account_paise: 0, balance_paise: 13400 * R, ok: true });
  const after = await openItems(ACME);
  assert.deepEqual(after.debits.map(i => [i.label, i.open_paise]), [['0104', 13400 * R]], 'only what is left of 0104 is open');
  assert.deepEqual(after.credits, [], 'the receipt is spent in full');

  // made in the name of the login that posted it, and the log keeps what was settled
  const rows = await h.db.q('SELECT made_by_id, made_by FROM fin_allocations WHERE credit_line_id = $1', [r.line]);
  assert.ok(rows.every(a => a.made_by_id === h.users.acct.id && a.made_by === 'Test Accountant'));
  const [applied, ...more] = await allocationAudit('apply', r.id);
  assert.deepEqual(more, [], 'one apply row');
  assert.deepEqual([applied.user_id, applied.user_name, applied.after.line_id, applied.after.mode, applied.after.on_account_paise],
    [h.users.acct.id, 'Test Accountant', r.line, 'auto', 0]);
  assert.deepEqual(applied.after.allocations, [
    { line_id: BILL[ACME].lump, amount_paise: 20000 * R }, { line_id: BILL[ACME]['0091'], amount_paise: 35000 * R },
    { line_id: BILL[ACME]['0104'], amount_paise: 26600 * R },
  ]);
});

test('Auto with ₹1,00,000 against ₹95,000 open leaves ₹5,000 on account; the invariant holds', gate, async () => {
  const r = await postedReceipt(BOLT, 100000, AUTO);
  assert.deepEqual(await settledOf(BOLT), { lump: 20000 * R, '0091': 35000 * R, '0104': 40000 * R });
  assert.deepEqual(await partyCheck(BOLT), { outstanding_paise: 0, on_account_paise: 5000 * R, balance_paise: -5000 * R, ok: true });
  const open = await openItems(BOLT);
  assert.deepEqual(open.debits, [], 'every bill is settled');
  assert.deepEqual(open.credits.map(i => [i.line_id, i.label, i.open_paise, i.amount_paise]), [[r.line, r.number, 5000 * R, 100000 * R]],
    'the receipt is labelled by its number, and ₹5,000 of it is on account');
  assert.equal(await ledgerBalance(BOLT), -5000 * R, 'the ledger agrees: ₹5,000 Cr');
});

test('Pick ticks 0104 then 0091 with ₹50,000: 0104 ₹40,000, 0091 ₹10,000; an unknown line in the plan is ignored', gate, async () => {
  const r = await postedReceipt(COBALT, 50000, {
    mode: 'pick',
    picks: [
      { line_id: 99999999, amount_paise: 100 },                        // no such line
      { line_id: BILL[ACME]['0104'], amount_paise: null },               // another party's bill
      { line_id: BILL[COBALT]['0104'], amount_paise: null },
      { line_id: BILL[COBALT]['0091'], amount_paise: null },
    ],
  });
  assert.deepEqual(await allocationsOf(r.line), [[BILL[COBALT]['0104'], 40000 * R, 'pick'], [BILL[COBALT]['0091'], 10000 * R, 'pick']]);
  assert.deepEqual(await settledOf(COBALT), { lump: 0, '0091': 10000 * R, '0104': 40000 * R }, 'the lump was not ticked, so it stays open');
  assert.deepEqual(await partyCheck(COBALT), { outstanding_paise: 45000 * R, on_account_paise: 0, balance_paise: 45000 * R, ok: true });
});

// Review Focus 2. Auto and Pick put money with nothing to settle on account, and nothing refuses it. A lump is an item like any other
// (spec §9.3: Auto settles it first), so a customer whose opening is only a lump keeps it open under a Pick that ticks nothing, and
// has it settled by Auto, the rest on account.
test('nothing open (Review Focus 2): a vendor with no bills, a customer with only a lump, and a customer already in credit all take the money on account without an error', gate, async () => {
  // A vendor with no bills: a payment, Auto, and one that picks a bill of somebody else's.
  const pay = (rupees, adjust) => draft('payment', '2027-01-06', [[JUNO, rupees, 0], ['Cash', 0, rupees]], { plan: { line_no: 1, ...adjust } });
  assert.deepEqual((await openItems(JUNO)).credits, [], 'nothing to pick: no bills');
  const p1 = await posted(await pay(12000, AUTO), 'acct', 1);
  const p2 = await posted(await pay(3000, pick(BILL[ACME]['0091'])), 'acct', 1);
  assert.deepEqual([await allocationsOf(p1.line), await allocationsOf(p2.line)], [[], []]);
  const juno = await openItems(JUNO);
  assert.equal(juno.side, 'vendor', 'filed under Sundry Creditors');
  assert.deepEqual(juno.debits.map(i => [i.line_id, i.open_paise]), [[p1.line, 12000 * R], [p2.line, 3000 * R]], 'both on account, as advances');
  assert.deepEqual(await partyCheck(JUNO), { outstanding_paise: 0, on_account_paise: 15000 * R, balance_paise: -15000 * R, ok: true },
    'a vendor is the mirror image: what we owe, less what we paid ahead');

  // A customer with only a lump: Pick with nothing ticked puts it all on account; Auto settles the lump, then the rest.
  const k1 = await postedReceipt(KITE, 3000, { mode: 'pick', picks: [] });
  assert.deepEqual(await allocationsOf(k1.line), []);
  assert.deepEqual((await openItems(KITE)).debits.map(i => [i.label, i.is_opening_lump, i.open_paise]), [['Opening balance', true, 20000 * R]]);
  const k2 = await postedReceipt(KITE, 25000, AUTO);
  assert.deepEqual(await allocationsOf(k2.line), [[BILL[KITE].lump, 20000 * R, 'auto']]);
  assert.deepEqual(await partyCheck(KITE), { outstanding_paise: 0, on_account_paise: 8000 * R, balance_paise: -8000 * R, ok: true });

  // A customer already in credit: an advance carried in from Tally, and the new money beside it.
  const l1 = await postedReceipt(LARK, 10000, AUTO);
  assert.deepEqual(await allocationsOf(l1.line), []);
  const lark = await openItems(LARK);
  assert.deepEqual(lark.debits, []);
  assert.deepEqual(lark.credits.map(i => [i.label, i.is_opening_lump, i.open_paise]),
    [['Opening balance', true, 15000 * R], [l1.number, false, 10000 * R]]);
  assert.deepEqual(await partyCheck(LARK), { outstanding_paise: 0, on_account_paise: 25000 * R, balance_paise: -25000 * R, ok: true });
});

// An entry that waits for an Approver keeps its plan until it posts (spec §14), and the approval settles the bills: finPostLocked,
// which an approval reaches without the party locks, takes them first and applies the plan once the entry is posted.
test('a receipt that waits for an Approver keeps its plan, and its bills are settled when it is approved', gate, async () => {
  const before = (await settledOf(ACME))['0104'];
  try {
    await setMonth('2027-01-01', 'closing');
    const id = await receiptDraft(ACME, 10000, AUTO, { date: '2027-01-12' });
    const waiting = (await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'acct'))).voucher;
    assert.equal(waiting.status, 'submitted', 'January is closing: the receipt waits');
    const line = await lineOf(id, 2);
    assert.deepEqual(await allocationsOf(line), [], 'nothing is settled while it waits');
    assert.equal((await ok(h.call('POST', `/finance/vouchers/${id}/approve`, null, 'md'))).voucher.status, 'posted');
    assert.deepEqual(await allocationsOf(line), [[BILL[ACME]['0104'], 10000 * R, 'auto']], 'Auto, against what was open when it posted');
    assert.equal((await settledOf(ACME))['0104'], before + 10000 * R);
    const rows = await h.db.q('SELECT made_by FROM fin_allocations WHERE credit_line_id = $1', [line]);
    assert.deepEqual(rows.map(a => a.made_by), ['Test MD'], 'made by the Approver whose approval posted it');
    assert.equal((await partyCheck(ACME)).ok, true);
  } finally {
    await setMonth('2027-01-01', 'open');
  }
});

// ── Redo (spec §6.5) ─────────────────────────────────────────────────────────────────────────

test('redo replaces the allocations, changes no ledger balance, writes an audit row with before and after, and works with January locked', gate, async () => {
  const r = await postedReceipt(DUNE, 50000, AUTO);
  assert.deepEqual(await allocationsOf(r.line), [[BILL[DUNE].lump, 20000 * R, 'auto'], [BILL[DUNE]['0091'], 30000 * R, 'auto']]);
  const balances = async () => [await ledgerBalance(DUNE), await ledgerBalance('Cash')];
  const was = { balances: await balances(), vouchers: (await counts()).vouchers };
  try {
    await setMonth('2027-01-01', 'locked');
    // Pick, with January locked: a lock protects balances, and an adjustment changes none
    const picked = await redo(r.line, pick(BILL[DUNE]['0104'], BILL[DUNE]['0091']));
    assert.deepEqual(picked, {
      allocations: [{ line_id: BILL[DUNE]['0104'], amount_paise: 40000 * R }, { line_id: BILL[DUNE]['0091'], amount_paise: 10000 * R }],
      on_account_paise: 0,
    });
    assert.deepEqual(await allocationsOf(r.line), [[BILL[DUNE]['0104'], 40000 * R, 'pick'], [BILL[DUNE]['0091'], 10000 * R, 'pick']]);
    assert.deepEqual(await settledOf(DUNE), { lump: 0, '0091': 10000 * R, '0104': 40000 * R }, 'the lump is open again');
    assert.deepEqual(await balances(), was.balances, 'no ledger balance moved');
    assert.equal((await counts()).vouchers, was.vouchers, 'and nothing was posted');
    assert.deepEqual(await partyCheck(DUNE), { outstanding_paise: 45000 * R, on_account_paise: 0, balance_paise: 45000 * R, ok: true });

    const [row, ...more] = await allocationAudit('redo', r.id);
    assert.deepEqual(more, []);
    assert.deepEqual([row.user_id, row.user_name, row.before.line_id, row.after.line_id, row.after.mode, row.after.on_account_paise],
      [h.users.acct.id, 'Test Accountant', r.line, r.line, 'pick', 0]);
    assert.deepEqual(row.before.allocations,
      [{ line_id: BILL[DUNE].lump, amount_paise: 20000 * R }, { line_id: BILL[DUNE]['0091'], amount_paise: 30000 * R }]);
    assert.deepEqual(row.after.allocations, picked.allocations);

    // and back to Auto, still locked
    assert.deepEqual((await redo(r.line, AUTO)).allocations,
      [{ line_id: BILL[DUNE].lump, amount_paise: 20000 * R }, { line_id: BILL[DUNE]['0091'], amount_paise: 30000 * R }]);
    assert.deepEqual(await balances(), was.balances);
    assert.equal((await allocationAudit('redo', r.id)).length, 2);
  } finally {
    await setMonth('2027-01-01', 'open');
  }
});

// Ruling R71: Adjust, from the Unadjusted money list, settles only what the line still holds on account and keeps what it settles
// already; Redo, from the book, works the whole line again. Both through the one route, which the body tells which (`scope`).
test('R71: Adjust keeps what the line settles and spends only its money on account; a Redo still works the whole line again', gate, async () => {
  const [F1, F2, F3] = ['F-1', 'F-2', 'F-3'].map(ref => BILL[FERN][ref]);
  const put = body => h.call('PUT', `/finance/lines/${r.line}/allocations`, body, 'acct');
  const preview = body => h.call('POST', '/finance/allocations/preview', { ledger_id: LEDGER[FERN], line_id: r.line, ...body }, 'acct');
  // ₹45,000 received with two bills hand-picked: F-3 and F-2 settled, ₹15,000 on account (the walkthrough's W2, in small)
  const r = await postedReceipt(FERN, 45000, pick(F3, F2));
  assert.deepEqual(await allocationsOf(r.line), [[F3, 10000 * R, 'pick'], [F2, 20000 * R, 'pick']]);

  // The previews write nothing. An Adjust's: the ₹15,000 on account, against the bills open as they stand, nothing released.
  const was = await counts();
  const adjusting = await ok(preview({ scope: 'open', mode: 'auto' }));
  assert.deepEqual([adjusting.scope, adjusting.side, adjusting.amount_paise, adjusting.allocations, adjusting.on_account_paise],
    ['open', 'credit', 15000 * R, [{ line_id: F1, amount_paise: 15000 * R }], 0]);
  assert.deepEqual(adjusting.items.map(i => [i.line_id, i.open_paise]), [[F1, 30000 * R]], 'F-2 and F-3 stay settled: no release');
  // …a Redo's: all of the line, the bills it settles open again.
  const redoing = await ok(preview({ scope: 'line', mode: 'auto' }));
  assert.deepEqual([redoing.scope, redoing.amount_paise, redoing.allocations],
    ['line', 45000 * R, [{ line_id: F1, amount_paise: 30000 * R }, { line_id: F2, amount_paise: 15000 * R }]]);
  assert.equal((await ok(preview({ mode: 'auto' }))).scope, 'line', 'a body that names no scope is a redo, as before');
  assert.deepEqual(await counts(), was);

  // Adjust, Auto: only the ₹15,000 moves, onto F-1; the hand-picked bills stand; the log says it was an Adjust.
  assert.deepEqual(await ok(put({ mode: 'auto', picks: [], scope: 'open' })), { allocations: [{ line_id: F1, amount_paise: 15000 * R }], on_account_paise: 0 });
  assert.deepEqual(await allocationsOf(r.line), [[F3, 10000 * R, 'pick'], [F2, 20000 * R, 'pick'], [F1, 15000 * R, 'auto']]);
  assert.deepEqual(await partyCheck(FERN), { outstanding_paise: 15000 * R, on_account_paise: 0, balance_paise: 15000 * R, ok: true });
  const [row, ...more] = await allocationAudit('adjust', r.id);
  assert.deepEqual(more, []);
  assert.deepEqual([row.before.allocations, row.after.allocations, row.after.scope, row.after.mode, row.after.on_account_paise], [
    [{ line_id: F3, amount_paise: 10000 * R }, { line_id: F2, amount_paise: 20000 * R }], [{ line_id: F1, amount_paise: 15000 * R }], 'open', 'auto', 0]);
  assert.deepEqual(await allocationAudit('redo', r.id), [], 'an Adjust is no redo');
  // with nothing left on account, an Adjust settles nothing and moves nothing
  assert.deepEqual(await ok(put({ mode: 'auto', scope: 'open' })), { allocations: [], on_account_paise: 0 });
  assert.equal((await allocationsOf(r.line)).length, 3);

  // A Redo still redoes the whole line: Auto, oldest first, over all ₹45,000; F-3 is open again.
  assert.deepEqual(await ok(put({ mode: 'auto', scope: 'line' })),
    { allocations: [{ line_id: F1, amount_paise: 30000 * R }, { line_id: F2, amount_paise: 15000 * R }], on_account_paise: 0 });
  assert.deepEqual(await settledOf(FERN), { 'F-1': 30000 * R, 'F-2': 15000 * R, 'F-3': 0 });
  // any other scope is refused, naming it, and writes nothing
  const still = await counts();
  for (const call of [put({ mode: 'auto', scope: 'some' }), preview({ mode: 'auto', scope: 'some' })]) {
    const refused = await call;
    assert.deepEqual([refused.status, refused.body.code, refused.body.field], [400, 'FIN_BAD_INPUT', 'scope'], JSON.stringify(refused.body));
  }
  assert.deepEqual(await counts(), still);
});

// Ruling R76: an Adjust may settle more of a bill its line part-settles already, Auto or Pick. A line and a bill are one pair
// (UNIQUE debit_line_id, credit_line_id), so the Adjust adds to that pair's allocation, and is never refused for it (spec §2 G2).
test('R76: Adjust onto a bill its line part-settles already tops that allocation up, Auto or Pick, and is never refused', gate, async () => {
  const [G1, G2] = ['G-1', 'G-2'].map(ref => BILL[GORSE][ref]);
  const adjust = (line, how, who = 'acct') => h.call('PUT', `/finance/lines/${line}/allocations`, { ...how, scope: 'open' }, who);
  const typed = (line_id, rupees) => ({ mode: 'pick', picks: [{ line_id, amount_paise: rupees * R }] });
  // Who made each of a line's pairs, and when, to the microsecond: [the other line, made_by_id, made_by, made_at].
  const makers = async line => (await h.db.q(
    `SELECT CASE WHEN credit_line_id = $1 THEN debit_line_id ELSE credit_line_id END AS other, made_by_id, made_by, made_at::text AS made_at
       FROM fin_allocations WHERE debit_line_id = $1 OR credit_line_id = $1 ORDER BY id`, [line]))
    .map(m => [m.other, m.made_by_id, m.made_by, m.made_at]);

  // ₹35,000 received by the accountant, ₹10,000 of it typed against G-1 by hand: ₹25,000 on account
  const a = await postedReceipt(GORSE, 35000, typed(G1, 10000));
  assert.deepEqual(await allocationsOf(a.line), [[G1, 10000 * R, 'pick']]);
  const [first] = await makers(a.line);

  // Adjust, Auto, by the MD, oldest first: the ₹20,000 still open of G-1 joins the ₹10,000 against it already, and ₹5,000 goes to
  // G-2. What this Adjust settled comes back; G-1 stays one pair, chosen as it was first.
  assert.deepEqual(await ok(adjust(a.line, AUTO, 'md')),
    { allocations: [{ line_id: G1, amount_paise: 20000 * R }, { line_id: G2, amount_paise: 5000 * R }], on_account_paise: 0 });
  assert.deepEqual(await allocationsOf(a.line), [[G1, 30000 * R, 'pick'], [G2, 5000 * R, 'auto']]);
  // G-1's pair keeps by whom and when it was first made; G-2's is the MD's
  const [kept, added] = await makers(a.line);
  assert.deepEqual(kept, first);
  assert.deepEqual(added.slice(0, 3), [G2, h.users.md.id, 'Test MD']);
  // the book says two bills, all ₹35,000 settled
  assert.deepEqual((await alloc.finSettledOf(h.db.q, CI, [a.id])).map(s => [s.line_id, s.settled_paise, s.bills, s.modes]),
    [[a.line, 35000 * R, 2, ['auto', 'pick']]]);
  // the log keeps the Adjust, in the MD's name: the line's allocations as they stood before, and what the Adjust added
  const [row, ...more] = await allocationAudit('adjust', a.id);
  assert.deepEqual(more, []);
  assert.deepEqual([row.user_id, row.user_name, row.before.allocations, row.after.allocations, row.after.mode], [
    h.users.md.id, 'Test MD',
    [{ line_id: G1, amount_paise: 10000 * R }], [{ line_id: G1, amount_paise: 20000 * R }, { line_id: G2, amount_paise: 5000 * R }], 'auto']);

  // Adjust, Pick: ₹5,000 received, ₹2,000 of it typed against G-2, then G-2 ticked again for all that is open of it, ₹3,000
  const b = await postedReceipt(GORSE, 5000, typed(G2, 2000));
  assert.deepEqual(await ok(adjust(b.line, pick(G2))), { allocations: [{ line_id: G2, amount_paise: 3000 * R }], on_account_paise: 0 });
  assert.deepEqual(await allocationsOf(b.line), [[G2, 5000 * R, 'pick']]);
  assert.deepEqual(await settledOf(GORSE), { 'G-1': 30000 * R, 'G-2': 10000 * R });
  assert.deepEqual(await partyCheck(GORSE), { outstanding_paise: 0, on_account_paise: 0, balance_paise: 0, ok: true });
});

// ── Reversal (spec §6.5, Review Focus 5) ─────────────────────────────────────────────────────

test('reversing a receipt releases its allocations in the same transaction; its bills are open again (Review Focus 5)', gate, async () => {
  const r = await postedReceipt(EMBER, 55000, AUTO);
  assert.deepEqual(await settledOf(EMBER), { lump: 20000 * R, '0091': 35000 * R, '0104': 0 });

  // The accountant's reversal waits for an Approver (the reversal rule is always): the receipt stands, and so does what it settled.
  const rev = (await ok(h.call('POST', `/finance/vouchers/${r.id}/reverse`, { date: '2027-01-08', reason: 'entered against the wrong party' }, 'acct'))).voucher;
  assert.equal(rev.status, 'submitted');
  assert.equal(await allocationsOnVoucher(r.id), 2, 'nothing is released until the reversal posts');

  // Approved inside a transaction that is not committed: the release is part of the posting, seen inside it and nowhere else,
  // and it goes when the posting is rolled back.
  const held = await opened(c1);
  try {
    assert.equal((await vouchers.finApproveVoucher(held.qc, held.oc, rev.id, MD)).status, 'posted');
    assert.equal((await held.oc(`SELECT COUNT(*)::int AS n FROM fin_allocations WHERE credit_line_id = $1`, [r.line])).n, 0, 'released inside');
    assert.equal(await allocationsOnVoucher(r.id), 2, 'and still there for everyone else');
  } finally {
    await held.close();
  }
  assert.equal(await allocationsOnVoucher(r.id), 2, 'rolled back with the posting');
  assert.equal((await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [r.id])).reversed_by_id, null);

  // Approved for real.
  assert.equal((await ok(h.call('POST', `/finance/vouchers/${rev.id}/approve`, null, 'md'))).voucher.status, 'posted');
  assert.equal(await allocationsOnVoucher(r.id), 0, 'released');
  assert.deepEqual(await settledOf(EMBER), { lump: 0, '0091': 0, '0104': 0 }, 'its bills are open again');
  const open = await openItems(EMBER);
  assert.deepEqual(open.debits.map(i => [i.label, i.open_paise]),
    [['Opening balance', 20000 * R], ['0091', 35000 * R], ['0104', 40000 * R]]);
  assert.deepEqual(open.credits, [], 'neither the reversed receipt nor its reversal is an item');
  assert.deepEqual(await partyCheck(EMBER), { outstanding_paise: 95000 * R, on_account_paise: 0, balance_paise: 95000 * R, ok: true });
  // the log keeps what was released, in the approver's name
  const [released] = await allocationAudit('release', r.id);
  assert.deepEqual([released.user_id, released.user_name], [h.users.md.id, 'Test MD']);
  assert.deepEqual(released.before.allocations.map(a => [a.debit_line_id, a.credit_line_id, a.amount_paise]),
    [[BILL[EMBER].lump, r.line, 20000 * R], [BILL[EMBER]['0091'], r.line, 35000 * R]]);
});

test('redo on a reversed receipt, a draft, or a non-party line is refused FIN_NOT_PARTY_LINE', gate, async () => {
  // A receipt of Acme's that the MD reverses (it posts at once, self-approved), and one that stays: ₹500 each, on account.
  const gone = await postedReceipt(ACME, 500, { mode: 'pick', picks: [] });
  const rev = (await ok(h.call('POST', `/finance/vouchers/${gone.id}/reverse`, { date: '2027-01-09', reason: 'entered twice' }, 'md'))).voucher;
  assert.equal(rev.status, 'posted');
  const live = await postedReceipt(ACME, 500, { mode: 'pick', picks: [] });
  const lines = {
    reversed: gone.line,
    reversal: await lineOf(rev.id, 2),
    draft: await lineOf(await receiptDraft(ACME, 500, AUTO), 2),
    cash: await lineOf(live.id, 1),
  };
  const was = await counts();
  for (const [what, line] of Object.entries(lines)) {
    for (const how of [AUTO, pick(BILL[ACME]['0104'])]) {
      await assert.rejects(redo(line, how), refusedAs(409, 'FIN_NOT_PARTY_LINE'), `${what}, ${how.mode}`);
    }
  }
  // a ledger that is not a party's has no items to list
  await assert.rejects(alloc.finOpenItems(h.db.q, LEDGER.Cash), refusedAs(409, 'FIN_NOT_PARTY_LINE'));
  assert.deepEqual(await counts(), was, 'a refused redo writes nothing');
});

test('a redo says how: Auto or Pick, and a Pick names lines and amounts; anything else is refused FIN_BAD_INPUT and writes nothing', gate, async () => {
  const { line } = await postedReceipt(ACME, 400, { mode: 'pick', picks: [] });
  const was = await counts();
  for (const how of [null, {}, { mode: 'oldest' }, { mode: 'pick' }, { mode: 'pick', picks: 'all' }, { mode: 'pick', picks: [null] },
    { mode: 'pick', picks: [{ line_id: 'x', amount_paise: null }] }, { mode: 'pick', picks: [{ line_id: BILL[ACME]['0104'], amount_paise: 0 }] },
    { mode: 'pick', picks: [{ line_id: BILL[ACME]['0104'], amount_paise: 1.5 }] }]) {
    await assert.rejects(redo(line, how), refusedAs(400, 'FIN_BAD_INPUT'), JSON.stringify(how));
  }
  await assert.rejects(redo(99999999, AUTO), refusedAs(404, 'FIN_NOT_FOUND'));
  assert.deepEqual(await counts(), was);
});

// ── Two at once (spec §6.6, Review Focus 3; ruling R7) ───────────────────────────────────────

// The two receipts are minted from two number series (2026-27 and 2027-28), so the series lock, which every posting takes first,
// does not put them one after the other: only the party lock does.
test('two receipts for one customer at once never over-settle a bill (Review Focus 3)', gate, async () => {
  const a = await receiptDraft(GALE, 60000, AUTO, { date: '2027-03-10' });
  const b = await receiptDraft(GALE, 50000, AUTO, { date: '2027-04-05' });
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await vouchers.finSubmitVoucher(first.qc, first.oc, a, ACCT)).status, 'posted');   // all but the COMMIT
    second = watched(c2, (qc, oc) => vouchers.finSubmitVoucher(qc, oc, b, ACCT));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[GALE], () => second.settled), 'the second posting waits at the party lock');
    await first.commit();
    assert.equal((await second.done).status, 'posted', 'and posts once the first is in, with no refusal');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  const [lineA, lineB] = [await lineOf(a, 2), await lineOf(b, 2)];
  assert.deepEqual(await allocationsOf(lineA), [[BILL[GALE].lump, 20000 * R, 'auto'], [BILL[GALE]['0091'], 35000 * R, 'auto'], [BILL[GALE]['0104'], 5000 * R, 'auto']]);
  assert.deepEqual(await allocationsOf(lineB), [[BILL[GALE]['0104'], 35000 * R, 'auto']], 'the second gets what the first left');
  assert.deepEqual(await settledOf(GALE), { lump: 20000 * R, '0091': 35000 * R, '0104': 40000 * R }, 'no bill settled past what it holds');
  assert.deepEqual(await partyCheck(GALE), { outstanding_paise: 0, on_account_paise: 15000 * R, balance_paise: -15000 * R, ok: true },
    "the second's ₹15,000 left over is on account");
});

// A reversal racing a receipt for the same party (Task 4 review; ruling R7): whichever takes the party lock second sees what the first
// committed. The bill reversed is a journal of January, beside the party's opening bill.
async function januaryBill(party, ref) {
  const id = await draft('journal', '2027-01-04', [[party, 15000, 0, ref, '2027-01-04'], [SALES, 0, 15000]], { who: 'md' });
  const v = (await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'md'))).voucher;
  assert.equal(v.status, 'posted', 'the MD\'s journal posts at once, self-approved');
  return { id, line: await lineOf(id, 1) };
}

test('a reversal and a receipt for one party at once, the reversal first: the receipt waits, then settles what is left, with no deadlock', gate, async () => {
  const j = await januaryBill(HALE, 'J-0301');
  const receipt = await receiptDraft(HALE, 20000, AUTO, { date: '2027-01-21' });
  const first = await opened(c1);
  let second;
  try {
    const rev = await vouchers.finReverseVoucher(first.qc, first.oc, j.id, MD, { date: '2027-01-20', reason: 'billed twice' });
    assert.equal(rev.status, 'posted');                                                                   // all but the COMMIT
    second = watched(c2, (qc, oc) => vouchers.finSubmitVoucher(qc, oc, receipt, ACCT));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[HALE], () => second.settled), 'the receipt waits at the party lock the reversal holds');
    await first.commit();
    assert.equal((await second.done).status, 'posted');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  const reversal = (await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [j.id])).reversed_by_id;
  assert.ok(reversal, 'the bill is reversed');
  assert.equal(await allocationsOnVoucher(j.id), 0, 'nothing is left on the reversed bill');
  assert.equal(await allocationsOnVoucher(reversal), 0, 'or on its reversal');
  assert.deepEqual(await allocationsOf(await lineOf(receipt, 2)), [[BILL[HALE]['0201'], 10000 * R, 'auto']], 'the receipt settled the bill that is left');
  assert.deepEqual(await partyCheck(HALE), { outstanding_paise: 0, on_account_paise: 10000 * R, balance_paise: -10000 * R, ok: true },
    'and the rest is on account');
});

test('a reversal and a receipt for one party at once, the receipt first: the reversal waits, then releases what the receipt put on its bill', gate, async () => {
  const j = await januaryBill(IRIS, 'J-0302');
  const receipt = await receiptDraft(IRIS, 30000, AUTO, { date: '2027-01-21' });
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await vouchers.finSubmitVoucher(first.qc, first.oc, receipt, ACCT)).status, 'posted');   // all but the COMMIT
    assert.deepEqual((await first.qc(`SELECT debit_line_id, amount FROM fin_allocations WHERE credit_line_id = (
      SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = 2) ORDER BY id`, [receipt])).map(a => [a.debit_line_id, Math.round(a.amount * R)]),
    [[BILL[IRIS]['0202'], 10000 * R], [j.line, 15000 * R]], 'the receipt settles the opening bill, then the January one');
    second = watched(c2, (qc, oc) => vouchers.finReverseVoucher(qc, oc, j.id, MD, { date: '2027-01-20', reason: 'billed twice' }));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[IRIS], () => second.settled), 'the reversal waits at the party lock the receipt holds');
    await first.commit();
    assert.equal((await second.done).status, 'posted');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  const reversal = (await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [j.id])).reversed_by_id;
  assert.ok(reversal, 'the bill is reversed');
  assert.equal(await allocationsOnVoucher(j.id), 0, 'what the receipt put on it was released');
  const line = await lineOf(receipt, 2);
  assert.deepEqual(await allocationsOf(line), [[BILL[IRIS]['0202'], 10000 * R, 'auto']], 'the receipt keeps the bill that is left');
  assert.deepEqual(await partyCheck(IRIS), { outstanding_paise: 0, on_account_paise: 20000 * R, balance_paise: -20000 * R, ok: true },
    'and the money released is on account');
  const [released] = await allocationAudit('release', j.id);
  assert.deepEqual(released.before.allocations.map(a => [a.debit_line_id, a.credit_line_id, a.amount_paise]), [[j.line, line, 15000 * R]]);
});

// ── A reversal of a reversal (ruling R9) ─────────────────────────────────────────────────────

// An entry reversed, and its reversal reversed in turn, is in the books again: depth 0 is the entry, 1 its reversal, 2 the reversal
// of that, which puts it back. The restoring voucher is live, so its party lines are items; the plain reversal's never are.
const reverseByMd = async (id, date, reason) =>
  (await ok(h.call('POST', `/finance/vouchers/${id}/reverse`, { date, reason }, 'md'))).voucher;

test('R9: a reversal of a reversal puts its bill back: J → R → R2, the restored bill is an item, Auto settles it, and finPartyCheck is ok', gate, async () => {
  const j = await januaryBill(QUILL, 'J-0401');
  const r = await reverseByMd(j.id, '2027-01-10', 'billed twice');
  assert.deepEqual(await openItems(QUILL), { ledger_id: LEDGER[QUILL], side: 'customer', balance_paise: 0, debits: [], credits: [] },
    'J reversed and R a reversal: nothing is live, and the two net to nothing');
  const r2 = await reverseByMd(r.id, '2027-01-11', 'it was right after all');
  const restored = await lineOf(r2.id, 1);   // R2 mirrors R, which mirrored J: Quill's debit again
  const open = await openItems(QUILL);
  assert.deepEqual(open.debits.map(i => [i.line_id, i.voucher_id, i.label, i.date, i.is_opening_lump, i.open_paise]),
    [[restored, r2.id, 'J-0401', '2027-01-04', false, 15000 * R]], 'the restoring reversal carries the bill, its reference and its date');
  assert.deepEqual(await partyCheck(QUILL), { outstanding_paise: 15000 * R, on_account_paise: 0, balance_paise: 15000 * R, ok: true });

  const pay = await postedReceipt(QUILL, 15000, AUTO, { date: '2027-01-12' });
  assert.deepEqual(await allocationsOf(pay.line), [[restored, 15000 * R, 'auto']], 'Auto settles the restored bill');
  assert.deepEqual(await partyCheck(QUILL), { outstanding_paise: 0, on_account_paise: 0, balance_paise: 0, ok: true });
  // Its line takes a redo, as any live party line does; the plain reversal's is refused.
  assert.deepEqual(await redo(restored, { mode: 'pick', picks: [{ line_id: pay.line, amount_paise: 5000 * R }] }),
    { allocations: [{ line_id: pay.line, amount_paise: 5000 * R }], on_account_paise: 10000 * R });
  await assert.rejects(redo(await lineOf(r.id, 1), AUTO), refusedAs(409, 'FIN_NOT_PARTY_LINE'));
  assert.deepEqual(await partyCheck(QUILL), { outstanding_paise: 10000 * R, on_account_paise: 10000 * R, balance_paise: 0, ok: true });
});

test('R9: J → R → R2 → R3 leaves nothing live: no item, a balance of nothing, and finPartyCheck ok', gate, async () => {
  const j = await januaryBill(REED, 'J-0402');
  const r = await reverseByMd(j.id, '2027-01-10', 'billed twice');
  const r2 = await reverseByMd(r.id, '2027-01-11', 'it was right after all');
  assert.deepEqual((await openItems(REED)).debits.map(i => i.voucher_id), [r2.id], 'depth 2 is live');
  const r3 = await reverseByMd(r2.id, '2027-01-12', 'billed twice after all');
  assert.equal(r3.status, 'posted');
  assert.deepEqual(await openItems(REED), { ledger_id: LEDGER[REED], side: 'customer', balance_paise: 0, debits: [], credits: [] },
    'J and R2 are reversed, R and R3 are reversals');
  assert.deepEqual(await partyCheck(REED), { outstanding_paise: 0, on_account_paise: 0, balance_paise: 0, ok: true });
  assert.equal(await ledgerBalance(REED), 0);
});

// ── A redo at the same moment as a posting (spec §6.6, §13; ruling R7) ───────────────────────

// A redo posts nothing, so it takes no number series and no voucher lock: the party lock alone is what puts it and a posting for
// the same party one after the other, whichever comes first. Without it, the two would spend one bill, and the later COMMIT would
// be refused FIN_OVER_ALLOCATED: a refusal for bill matching.
test('a redo and a receipt for one party at once, the redo first: the receipt waits at the party lock, then settles what the redo left open', gate, async () => {
  const x1 = await postedReceipt(SAGE, 10000, AUTO, { date: '2027-01-15' });
  assert.deepEqual(await allocationsOf(x1.line), [[BILL[SAGE]['S-1'], 10000 * R, 'auto']]);
  const x2 = await receiptDraft(SAGE, 15000, AUTO, { date: '2027-01-16' });
  const first = await opened(c1);
  let second;
  try {
    // The redo moves the first receipt from S-1 onto S-2: all but its COMMIT.
    const moved = await alloc.finRedoAllocations(first.qc, first.oc, x1.line, pick(BILL[SAGE]['S-2']), ACCT);
    assert.deepEqual(moved.allocations, [{ line_id: BILL[SAGE]['S-2'], amount_paise: 10000 * R }]);
    second = watched(c2, (qc, oc) => vouchers.finSubmitVoucher(qc, oc, x2, ACCT));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[SAGE], () => second.settled), 'the receipt waits for the party lock the redo holds');
    await first.commit();
    assert.equal((await second.done).status, 'posted', 'and posts, with no refusal');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  assert.deepEqual(await allocationsOf(x1.line), [[BILL[SAGE]['S-2'], 10000 * R, 'pick']]);
  assert.deepEqual(await allocationsOf(await lineOf(x2, 2)), [[BILL[SAGE]['S-1'], 10000 * R, 'auto']], 'the receipt took what the redo left open');
  assert.deepEqual(await settledOf(SAGE), { 'S-1': 10000 * R, 'S-2': 10000 * R }, 'no bill settled twice');
  assert.deepEqual(await partyCheck(SAGE), { outstanding_paise: 0, on_account_paise: 5000 * R, balance_paise: -5000 * R, ok: true });
});

test('a redo and a receipt for one party at once, the receipt first: the redo waits at the party lock, then works against what the receipt left', gate, async () => {
  const y1 = await postedReceipt(TEAL, 10000, AUTO, { date: '2027-01-15' });
  assert.deepEqual(await allocationsOf(y1.line), [[BILL[TEAL]['T-1'], 10000 * R, 'auto']]);
  const y2 = await receiptDraft(TEAL, 10000, AUTO, { date: '2027-01-16' });
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await vouchers.finSubmitVoucher(first.qc, first.oc, y2, ACCT)).status, 'posted');   // T-2: all but the COMMIT
    second = watched(c2, (qc, oc) => alloc.finRedoAllocations(qc, oc, y1.line, pick(BILL[TEAL]['T-2']), ACCT));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[TEAL], () => second.settled), 'the redo waits for the party lock the receipt holds');
    await first.commit();
    assert.deepEqual(await second.done, { allocations: [], on_account_paise: 10000 * R },
      'T-2 is the second receipt\'s now, so the pick of it is dropped and the money waits on account, with no refusal');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  assert.deepEqual(await allocationsOf(y1.line), []);
  assert.deepEqual(await allocationsOf(await lineOf(y2, 2)), [[BILL[TEAL]['T-2'], 10000 * R, 'auto']]);
  assert.deepEqual(await settledOf(TEAL), { 'T-1': 0, 'T-2': 10000 * R }, 'no bill settled twice');
  assert.deepEqual(await partyCheck(TEAL), { outstanding_paise: 10000 * R, on_account_paise: 10000 * R, balance_paise: 0, ok: true });
});

// The redo reads its line's voucher again once it holds the party lock, so a reversal that took the lock first is seen there.
test('a redo and the reversal of its own receipt at once, the reversal first: the redo waits, reads the receipt reversed, and is refused FIN_NOT_PARTY_LINE', gate, async () => {
  const z = await postedReceipt(UMBER, 10000, AUTO, { date: '2027-01-15' });
  assert.deepEqual(await allocationsOf(z.line), [[BILL[UMBER]['U-1'], 10000 * R, 'auto']]);
  const first = await opened(c1);
  let second;
  try {
    const rev = await vouchers.finReverseVoucher(first.qc, first.oc, z.id, MD, { date: '2027-01-17', reason: 'entered twice' });
    assert.equal(rev.status, 'posted');                                                                  // all but the COMMIT
    second = watched(c2, (qc, oc) => alloc.finRedoAllocations(qc, oc, z.line, AUTO, ACCT));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[UMBER], () => second.settled), 'the redo waits for the party lock the reversal holds');
    await first.commit();
    await assert.rejects(second.done, refusedAs(409, 'FIN_NOT_PARTY_LINE'), 'read again under the lock, the receipt is reversed');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  assert.equal(await allocationsOnVoucher(z.id), 0, 'nothing on the reversed receipt');
  assert.deepEqual(await settledOf(UMBER), { 'U-1': 0 }, 'its bill is open again');
  assert.deepEqual(await partyCheck(UMBER), { outstanding_paise: 10000 * R, on_account_paise: 0, balance_paise: 10000 * R, ok: true });
  assert.deepEqual(await allocationAudit('redo', z.id), [], 'the refused redo wrote nothing');
});

test('a redo and the reversal of its own receipt at once, the redo first: the reversal waits, then releases what the redo wrote', gate, async () => {
  const z = await postedReceipt(OCHRE, 10000, { mode: 'pick', picks: [] }, { date: '2027-01-15' });   // on account
  const first = await opened(c1);
  let second;
  try {
    const done = await alloc.finRedoAllocations(first.qc, first.oc, z.line, AUTO, ACCT);                // all but the COMMIT
    assert.deepEqual(done.allocations, [{ line_id: BILL[OCHRE]['O-1'], amount_paise: 10000 * R }]);
    second = watched(c2, (qc, oc) => vouchers.finReverseVoucher(qc, oc, z.id, MD, { date: '2027-01-17', reason: 'entered twice' }));
    assert.ok(await waitsForPartyLock(pid2, LEDGER[OCHRE], () => second.settled), 'the reversal waits for the party lock the redo holds');
    await first.commit();
    assert.equal((await second.done).status, 'posted');
  } finally {
    await first.close();
    await second?.done.catch(() => {});
  }
  assert.equal(await allocationsOnVoucher(z.id), 0, 'what the redo wrote was released');
  assert.deepEqual(await settledOf(OCHRE), { 'O-1': 0 });
  assert.deepEqual(await partyCheck(OCHRE), { outstanding_paise: 10000 * R, on_account_paise: 0, balance_paise: 10000 * R, ok: true });
  const [released] = await allocationAudit('release', z.id);
  assert.deepEqual(released.before.allocations.map(a => [a.debit_line_id, a.credit_line_id, a.amount_paise]), [[BILL[OCHRE]['O-1'], z.line, 10000 * R]]);
});

// ── The invariant on generated data (spec §6.2, §13) ─────────────────────────────────────────

// A small seeded generator (mulberry32), so the walk is the same on every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The test's own reading of R9, written apart from the engine's: each voucher's depth in its reversal chain, walked up
// reversal_of_id to the entry that reverses nothing.
const DEPTHS = `
  WITH RECURSIVE chain AS (
    SELECT v.id AS voucher_id, v.reversal_of_id AS up, 0 AS depth FROM fin_vouchers v WHERE v.id = ANY($1::int[])
    UNION ALL
    SELECT c.voucher_id, o.reversal_of_id, c.depth + 1 FROM chain c JOIN fin_vouchers o ON o.id = c.up)
  SELECT voucher_id, depth FROM chain WHERE up IS NULL`;
// The posted vouchers with a line on these ledgers: { id, opening, reversed, depth, live }.
async function vouchersOn(ledgerIds) {
  const rows = await h.db.q(`SELECT DISTINCT v.id, v.voucher_type = 'opening' AS opening, v.reversed_by_id IS NOT NULL AS reversed
    FROM fin_vouchers v JOIN fin_voucher_lines l ON l.voucher_id = v.id
   WHERE l.ledger_id = ANY($1::int[]) AND v.status = 'posted' ORDER BY v.id`, [ledgerIds]);
  const depth = new Map((await h.db.q(DEPTHS, [rows.map(r => r.id)])).map(r => [r.voucher_id, r.depth]));
  return rows.map(r => ({ ...r, depth: depth.get(r.id), live: !r.reversed && depth.get(r.id) % 2 === 0 }));
}
// Allocations on a voucher that is not posted, is reversed, or sits at an odd depth: none, ever.
async function deadAllocations() {
  const touched = (await h.db.q(`SELECT DISTINCT l.voucher_id AS id FROM fin_allocations a
    JOIN fin_voucher_lines l ON l.id = a.debit_line_id OR l.id = a.credit_line_id`)).map(r => r.id);
  if (!touched.length) return [];
  const depth = new Map((await h.db.q(DEPTHS, [touched])).map(r => [r.voucher_id, r.depth]));
  const rows = await h.db.q('SELECT id, number, status, reversed_by_id FROM fin_vouchers WHERE id = ANY($1::int[])', [touched]);
  return rows.filter(v => v.status !== 'posted' || v.reversed_by_id != null || depth.get(v.id) % 2 === 1).map(v => v.number ?? v.id);
}
// Lines whose allocations add up to more than they hold: none, ever.
const overAllocated = async () => (await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_voucher_lines l
  WHERE (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.debit_line_id = l.id) > l.debit
     OR (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.credit_line_id = l.id) > l.credit`)).n;
// The invariant as the test reads it, apart from finPartyCheck: on the live vouchers' lines, what is open of the debits less what
// is open of the credits, against the ledger's own Dr − Cr over every posted line; both in paise.
async function invariantOf(name) {
  const live = (await vouchersOn([LEDGER[name]])).filter(v => v.live).map(v => v.id);
  const open = await h.db.one(`SELECT COALESCE(sum(l.debit - l.credit
      - (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.debit_line_id = l.id)
      + (SELECT COALESCE(sum(a.amount), 0) FROM fin_allocations a WHERE a.credit_line_id = l.id)), 0) AS net
    FROM fin_voucher_lines l WHERE l.ledger_id = $1 AND l.voucher_id = ANY($2::int[])`, [LEDGER[name], live]);
  return { open: Math.round(open.net * R), ledger: await ledgerBalance(name) };
}

test('the invariant on generated data: 80 seeded steps of bills, receipts (Auto and Pick), redos, reversals and reversals of reversals, checked after every step', gate, async t => {
  const rand = mulberry32(20261120);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const any = list => list[Math.floor(rand() * list.length)];
  const some = list => {           // about half of them, in a seeded random order (Fisher–Yates)
    const out = list.filter(() => rand() < 0.5);
    for (let i = out.length - 1; i > 0; i--) { const j = int(0, i); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  const PARTIES = [VALE, WREN, YEW];
  const ids = PARTIES.map(name => LEDGER[name]);
  const DAY = '2027-02-15';
  const BILL_DAYS = ['2026-12-08', '2026-12-28', '2027-01-09', '2027-01-30', '2027-02-10'];
  const ran = { bill: 0, auto: 0, pick: 0, redo: 0, reverse: 0, unreverse: 0 };
  const picksFrom = items => some(items).map(i => ({ line_id: i.line_id, amount_paise: rand() < 0.3 ? int(1, i.open_paise) : null }));
  for (let step = 1; step <= 80; step++) {
    const party = any(PARTIES);
    const vouchers_ = await vouchersOn(ids);
    const canReverse = vouchers_.filter(v => v.live && !v.opening);
    const canUnreverse = vouchers_.filter(v => !v.reversed && v.depth % 2 === 1);
    let op = any(['bill', 'bill', 'auto', 'auto', 'pick', 'redo', 'redo', 'reverse', 'reverse', 'unreverse']);
    if (op === 'reverse' && !canReverse.length) op = 'bill';
    if (op === 'unreverse' && !canUnreverse.length) op = 'auto';
    const what = `step ${step}: ${op}`;
    if (op === 'bill') {
      const rupees = 500 * int(1, 24);
      const id = await draft('journal', DAY, [[party, rupees, 0, `G-${step}`, any(BILL_DAYS)], [SALES, 0, rupees]], { who: 'md' });
      assert.equal((await ok(h.call('POST', `/finance/vouchers/${id}/submit`, null, 'md'))).voucher.status, 'posted', what);
    } else if (op === 'auto') {
      await postedReceipt(party, 500 * int(1, 30), AUTO, { date: DAY });
    } else if (op === 'pick') {
      const open = await openItems(party);
      const picks = picksFrom(open.debits);
      if (rand() < 0.3) picks.splice(int(0, picks.length), 0, { line_id: any([99999999, BILL[ACME]['0104'], BILL[VALE]['V-01']]), amount_paise: null });
      await postedReceipt(party, 500 * int(1, 30), { mode: 'pick', picks }, { date: DAY });
    } else if (op === 'redo') {
      const live = vouchers_.filter(v => v.live).map(v => v.id);
      const lines = await h.db.q(`SELECT l.id, l.ledger_id, l.debit > 0 AS is_debit FROM fin_voucher_lines l
        WHERE l.ledger_id = ANY($1::int[]) AND l.voucher_id = ANY($2::int[]) ORDER BY l.id`, [ids, live]);
      const line = any(lines);
      const name = PARTIES.find(p => LEDGER[p] === line.ledger_id);
      const open = await openItems(name);
      const how = rand() < 0.5 ? AUTO : { mode: 'pick', picks: picksFrom(line.is_debit ? open.credits : open.debits) };
      await redo(line.id, how);
    } else {
      // Half the time a restored entry (depth 2 or more) is the one reversed, when there is one, so the walk goes past depth 2.
      const restored = canReverse.filter(v => v.depth >= 2);
      const v = op === 'unreverse' ? any(canUnreverse) : restored.length && rand() < 0.5 ? any(restored) : any(canReverse);
      assert.equal((await reverseByMd(v.id, DAY, `generated step ${step}`)).status, 'posted', what);
    }
    ran[op] += 1;
    for (const name of PARTIES) {
      const check = await partyCheck(name);
      assert.equal(check.ok, true, `${what}: ${name} ${JSON.stringify(check)}`);
      const seen = await invariantOf(name);
      assert.equal(seen.open, seen.ledger, `${what}: ${name}, by the test's own reading of R9`);
      assert.equal(check.outstanding_paise - check.on_account_paise, seen.open, `${what}: ${name}, the engine and the test agree`);
    }
    assert.deepEqual(await deadAllocations(), [], `${what}: an allocation on a voucher that is not live`);
    assert.equal(await overAllocated(), 0, `${what}: a line settled past what it holds`);
  }
  // Non-vacuous: every kind of step ran, and the walk left restored entries and settled bills behind it.
  for (const [op, n] of Object.entries(ran)) assert.ok(n >= 3, `${op} ran ${n} times`);
  const end = await vouchersOn(ids);
  const byDepth = {};
  for (const v of end) byDepth[v.depth] = (byDepth[v.depth] ?? 0) + 1;
  t.diagnostic(`steps: ${JSON.stringify(ran)}; vouchers by depth: ${JSON.stringify(byDepth)}; live: ${end.filter(v => v.live).length}`);
  assert.ok(end.some(v => v.live && v.depth >= 2), 'some entry was restored by a reversal of its reversal');
  assert.ok(end.some(v => v.depth >= 3), 'and some restored entry was reversed again');
  const settledLines = await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_allocations a JOIN fin_voucher_lines l ON l.id = a.debit_line_id
    WHERE l.ledger_id = ANY($1::int[])`, [ids]);
  assert.ok(settledLines.n >= 5, `only ${settledLines.n} allocations stand at the end`);
});
