import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';

// When two people act at once (spec §7.4, §7.5): two postings in one number series, the same draft submitted twice, a
// posting and a month being locked, and two people reversing one entry. Each side is a transaction of its own on a raw
// client, run the way a route's tx() runs one. Where a test says one side waits for the other, it asks Postgres
// (pg_stat_activity), never the clock.
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-race.test.js
//
// The first three tests are the brief's, verbatim but for the file's gate and the third's wait, which asks Postgres
// whether the posting is waiting instead of sleeping 300 ms. The third locks January, so every test after it is dated
// February or later.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
let c1, c2, pid1, pid2;        // two raw clients on the throwaway database, and their backends' pids
let CI, ALPHA, CUST, PERIOD;   // the CI book, its Alpha Bank and Customer A ledgers, month ids: PERIOD.CI['2027-01-01']
let MD, APPR2, ACCT;           // actors, as a route hands them on: { id, name, roles }
let finSubmitVoucher, finReverseVoucher, finSetPeriodStatus;

// qc / oc on a raw client, the way db.js tx() hands them to a helper.
const clientQ = client => {
  const qc = async (text, params = []) => (await client.query(text, params)).rows;
  return { qc, oc: async (text, params = []) => (await qc(text, params))[0] ?? null };
};

// One route's transaction on a raw client: BEGIN, fn(qc, oc), COMMIT; ROLLBACK when anything throws.
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

// A transaction left open on a raw client: a request that has done everything but COMMIT. close(), in a finally, rolls
// back whatever a failed test left open, so the next test finds both clients free.
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

// What a backend is waiting on, asked of Postgres and not of the clock: its wait_event once it waits for a lock
// ('advisory' is a number series, 'transactionid' or 'tuple' a row another transaction holds), or null if it never does.
// Asked through the pool, outside any transaction, so each look is a fresh one.
async function lockWaitOf(pid) {
  for (let i = 0; i < 400; i++) {
    const row = await h.db.one('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (row?.wait_event_type === 'Lock') return row.wait_event;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return null;
}
const ROW_WAITS = ['transactionid', 'tuple'];

const L = (ledger_id, debit_paise, credit_paise) => ({ ledger_id, debit_paise, credit_paise });

// A CI receipt draft made through the API as md: Alpha Bank Dr / Customer A Cr, ₹10. Its id.
async function draftReceipt(date) {
  const r = await h.call('POST', '/finance/vouchers', {
    book_id: CI, voucher_type: 'receipt', voucher_date: date, client_key: randomUUID(), narration: 'race receipt',
    lines: [L(ALPHA, 1000, 0), L(CUST, 0, 1000)],
  }, 'md');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.voucher.id;
}

// …and submitted through the API: a receipt needs no approval, so it posts at once. Its id.
async function postedReceipt(date) {
  const id = await draftReceipt(date);
  const r = await h.call('POST', `/finance/vouchers/${id}/submit`, null, 'md');
  assert.equal(r.body?.voucher?.status, 'posted', JSON.stringify(r.body));
  return id;
}

const lastNumber = async prefix => (await h.db.one('SELECT max(number) AS n FROM fin_vouchers WHERE number LIKE $1', [`${prefix}%`])).n;
const numberAfter = (prefix, last) => `${prefix}${String((last ? Number(last.slice(-4)) : 0) + 1).padStart(4, '0')}`;
const reversalsOf = id => h.db.q('SELECT id, status FROM fin_vouchers WHERE reversal_of_id = $1 ORDER BY id', [id]);
const reversedBy = async id => (await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [id])).reversed_by_id;

before(async () => {
  if (!ON) return;
  h = await finBootPg('race');
  ({ finSubmitVoucher, finReverseVoucher } = await import('./finance-vouchers.js'));
  ({ finSetPeriodStatus } = await import('./finance-masters.js'));
  CI = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'CI'`)).id;
  const groups = Object.fromEntries((await h.call('GET', `/finance/books/${CI}/groups`)).body.groups.map(g => [g.name, g.id]));
  const ledger = async (group, name) => (await h.call('POST', '/finance/ledgers', { book_id: CI, group_id: groups[group], name }, 'md')).body.ledger.id;
  ALPHA = await ledger('Bank Accounts', 'Alpha Bank');
  CUST = await ledger('Sundry Debtors', 'Customer A');
  // a second number series for the same type: the 2027-28 year
  assert.equal((await h.call('POST', '/finance/years', { book_id: CI, label: '2027-28' }, 'md')).status, 200);
  PERIOD = { CI: Object.fromEntries((await h.db.q('SELECT id, start_date FROM fin_periods WHERE book_id = $1', [CI])).map(p => [p.start_date, p.id])) };
  MD = { id: h.users.md.id, name: 'MD', roles: ['approver', 'admin'] };
  APPR2 = { id: h.users.appr2.id, name: 'Second Approver', roles: ['approver'] };
  ACCT = { id: h.users.acct.id, name: 'Accountant', roles: ['accountant'] };
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

test('two postings in one series at the same moment get two consecutive numbers', gate, async () => {
  const [a, b] = [await draftReceipt('2027-01-05'), await draftReceipt('2027-01-05')];
  const [x, y] = await Promise.all([
    inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
    inTx(c2, (qc, oc) => finSubmitVoucher(qc, oc, b, MD)),
  ]);
  const n = [x.number, y.number].map(s => +s.slice(-4)).sort((p, q) => p - q);
  assert.equal(n[1] - n[0], 1);
});

test('the same draft submitted twice at once posts once', gate, async () => {
  const a = await draftReceipt('2027-01-06');
  const results = await Promise.allSettled([
    inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
    inTx(c2, (qc, oc) => finSubmitVoucher(qc, oc, a, MD)),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.body.code, 'FIN_NOT_DRAFT');
});

test('a posting that waits on a month being locked is refused once the lock lands', gate, async () => {
  const jan = PERIOD.CI['2027-01-01'];
  await inTx(c1, (qc, oc) => finSetPeriodStatus(qc, oc, jan, { status: 'closing' }, MD));
  await c2.query('BEGIN');
  const q2 = async (t, p) => (await c2.query(t, p)).rows;
  await finSetPeriodStatus(q2, async (t, p) => (await q2(t, p))[0] ?? null, jan, { status: 'locked' }, MD);
  const v = await draftReceipt('2027-01-07');
  let settled = false;
  const posting = inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, v, MD)).finally(() => { settled = true; });
  assert.ok(await lockWaitOf(pid1), 'the posting waits for the lock');   // asked of Postgres: the brief slept 300 ms here
  assert.equal(settled, false, 'the posting waits for the lock');
  await c2.query('COMMIT');
  await assert.rejects(posting, e => e.body?.code === 'FIN_PERIOD_LOCKED');
});

// ── Beyond the brief ─────────────────────────────────────────────────────────────────────────
// Each of these holds one side open on c1 (or c2), proves the other is waiting, and only then lets the first commit.

// The lock order of every transaction that may post (spec §7.4): its number series first, then rows. Two postings of
// one draft therefore meet at the series, and the one let through second finds the draft posted.
test('the same draft submitted twice: the second waits at the number series, not at the voucher, then finds it posted', gate, async () => {
  const v = await draftReceipt('2027-02-01');
  const first = await opened(c1);
  let second;
  try {
    assert.equal((await finSubmitVoucher(first.qc, first.oc, v, MD)).status, 'posted');   // all but the COMMIT
    second = inTx(c2, (qc, oc) => finSubmitVoucher(qc, oc, v, MD));
    second.catch(() => {});
    assert.equal(await lockWaitOf(pid2), 'advisory', 'the second waits at the number series, holding no row');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_NOT_DRAFT');
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  assert.equal((await h.db.one('SELECT status FROM fin_vouchers WHERE id = $1', [v])).status, 'posted');
});

test('two Approvers reverse one entry at the same moment, in one series: one reversal posts, the other is refused, and no number is lost', gate, async () => {
  const x = await postedReceipt('2027-02-02');
  const before = await lastNumber('CI-JV-2627-');
  const first = await opened(c1);
  let second, mine;
  try {
    mine = await finReverseVoucher(first.qc, first.oc, x, MD, { date: '2027-02-03', reason: 'entered twice' });
    assert.equal(mine.status, 'posted');
    second = inTx(c2, (qc, oc) => finReverseVoucher(qc, oc, x, APPR2, { date: '2027-02-04', reason: 'wrong customer' }));
    second.catch(() => {});
    assert.equal(await lockWaitOf(pid2), 'advisory', 'the second waits at the number series, holding no row');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_ALREADY_REVERSED' && e.message.includes(mine.number));
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  assert.deepEqual((await reversalsOf(x)).map(r => [r.id, r.status]), [[mine.id, 'posted']], 'one reversal, and no second draft left behind');
  assert.equal(await reversedBy(x), mine.id);
  assert.equal(mine.number, numberAfter('CI-JV-2627-', before));
  assert.equal(await lastNumber('CI-JV-2627-'), mine.number, 'the refused reversal took no number');
});

test('two Approvers reverse one entry at the same moment, in two financial years: they meet at the entry, and the second is refused', gate, async () => {
  const x = await postedReceipt('2027-02-05');
  const first = await opened(c1);
  let second, mine;
  try {
    mine = await finReverseVoucher(first.qc, first.oc, x, MD, { date: '2027-03-30', reason: 'entered twice' });
    assert.equal(mine.status, 'posted');
    second = inTx(c2, (qc, oc) => finReverseVoucher(qc, oc, x, APPR2, { date: '2027-04-02', reason: 'wrong customer' }));
    second.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'another number series, so the second waits at the entry itself');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_ALREADY_REVERSED' && e.message.includes(mine.number));
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  assert.deepEqual((await reversalsOf(x)).map(r => r.id), [mine.id]);
  assert.match(mine.number, /^CI-JV-2627-\d{4}$/);
  assert.equal(await lastNumber('CI-JV-2728-'), null, 'nothing was minted in the other year');
});

test('an accountant asks and an Approver reverses one entry at the same moment: one reversal, and the Approver is told it waits for approval', gate, async () => {
  const x = await postedReceipt('2027-02-06');
  const first = await opened(c1);
  let second, asked;
  try {
    asked = await finReverseVoucher(first.qc, first.oc, x, ACCT, { date: '2027-02-07', reason: 'wrong customer' });
    assert.equal(asked.status, 'submitted');
    second = inTx(c2, (qc, oc) => finReverseVoucher(qc, oc, x, APPR2, { date: '2027-02-08', reason: 'entered twice' }));
    second.catch(() => {});
    assert.equal(await lockWaitOf(pid2), 'advisory');
    await first.commit();
    await assert.rejects(second, e => e.status === 409 && e.body?.code === 'FIN_ALREADY_REVERSED' && /waiting for approval/.test(e.message));
  } finally {
    await first.close();
    await second?.catch(() => {});
  }
  assert.deepEqual((await reversalsOf(x)).map(r => [r.id, r.status]), [[asked.id, 'submitted']]);
  assert.equal(await reversedBy(x), null, 'marked only when the reversal posts');
});

test('a reversal into a month being locked waits for the lock, then is refused: nothing written, no number taken', gate, async () => {
  const feb = PERIOD.CI['2027-02-01'];
  const x = await postedReceipt('2027-02-09');
  await inTx(c2, (qc, oc) => finSetPeriodStatus(qc, oc, feb, { status: 'closing' }, MD));
  const taken = await lastNumber('CI-JV-2627-');
  const lock = await opened(c2);
  let reversing;
  try {
    await finSetPeriodStatus(lock.qc, lock.oc, feb, { status: 'locked' }, MD);   // all but the COMMIT
    reversing = inTx(c1, (qc, oc) => finReverseVoucher(qc, oc, x, MD, { date: '2027-02-10', reason: 'entered twice' }));
    reversing.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid1)), 'the reversal waits for the month');
    await lock.commit();
    await assert.rejects(reversing, e => e.status === 409 && e.body?.code === 'FIN_PERIOD_LOCKED');
  } finally {
    await lock.close();
    await reversing?.catch(() => {});
  }
  assert.deepEqual(await reversalsOf(x), [], 'the refused reversal left nothing behind');
  assert.equal(await reversedBy(x), null);
  assert.equal(await lastNumber('CI-JV-2627-'), taken, 'and took no number');
  // the entry, in a month now locked, is reversed into an open one, with the number the refused reversal never took
  const r = await inTx(c1, (qc, oc) => finReverseVoucher(qc, oc, x, MD, { date: '2027-03-01', reason: 'entered twice' }));
  assert.deepEqual([r.status, r.number], ['posted', numberAfter('CI-JV-2627-', taken)]);
});

test('a month being closed while a reversal posts into it waits for the reversal, which stands', gate, async () => {
  const mar = PERIOD.CI['2027-03-01'];
  const y = await postedReceipt('2027-03-02');
  const first = await opened(c1);
  let closing, mine;
  try {
    mine = await finReverseVoucher(first.qc, first.oc, y, MD, { date: '2027-03-03', reason: 'entered twice' });
    closing = inTx(c2, (qc, oc) => finSetPeriodStatus(qc, oc, mar, { status: 'closing' }, MD));
    closing.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'the month waits for the reversal posting into it');
    await first.commit();
    assert.equal((await closing).status, 'closing');
  } finally {
    await first.close();
    await closing?.catch(() => {});
  }
  const row = await h.db.one('SELECT status, period_id FROM fin_vouchers WHERE id = $1', [mine.id]);
  assert.deepEqual([row.status, row.period_id], ['posted', mar]);
  assert.equal(await reversedBy(y), mine.id);
});

// Ruling R70. The Opening voucher carries into every month of the books, so a posting dated before the books begin reads each of
// those months FOR SHARE, after the voucher and before the ledgers (the global lock order). A month that moves (finSetPeriodStatus
// takes one month FOR UPDATE and nothing after it) therefore waits for such a posting, and a posting waits for a move and then
// judges the month as the move left it. On DP, which nothing above touches.
test('R70: the opening holds every month it carries into: closing one waits for its posting, and its reversal waits for a lock, then is refused', gate, async () => {
  const DP = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'DP'`)).id;
  const jan = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2027-01-01'`, [DP])).id;
  const ledgerOf = async name => (await h.db.one('SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = $2', [DP, name])).id;
  const [cash, pl] = [await ledgerOf('Cash'), await ledgerOf('Profit & Loss A/c')];
  const ob = await h.db.tx(async (qc, oc) => {
    const v = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, created_by_id, created_by)
                        VALUES ($1, 'opening', '2026-12-31', 900, $2, 'MD') RETURNING id`, [DP, MD.id]);
    await qc(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit)
              VALUES ($1, $2, 1, $3, 900, 0), ($1, $2, 2, $4, 0, 900)`, [v.id, DP, cash, pl]);
    return v.id;
  });

  // The posting first, all but its COMMIT: January, which the opening carries into, cannot start closing until it is done.
  const first = await opened(c1);
  let closing;
  try {
    assert.equal((await finSubmitVoucher(first.qc, first.oc, ob, MD)).status, 'posted');
    closing = inTx(c2, (qc, oc) => finSetPeriodStatus(qc, oc, jan, { status: 'closing' }, MD));
    closing.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'January waits for the opening that carries into it');
    await first.commit();
    assert.equal((await closing).status, 'closing');
  } finally {
    await first.close();
    await closing?.catch(() => {});
  }

  // The lock first, all but its COMMIT: the MD reversing the opening waits for January, then finds it locked and is refused.
  const lock = await opened(c2);
  let reversing;
  try {
    await finSetPeriodStatus(lock.qc, lock.oc, jan, { status: 'locked' }, MD);
    reversing = inTx(c1, (qc, oc) => finReverseVoucher(qc, oc, ob, MD, { reason: 'rebuilt from Tally' }));
    reversing.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid1)), 'the reversal waits for January');
    await lock.commit();
    await assert.rejects(reversing, e => e.status === 409 && e.body?.code === 'FIN_PERIOD_LOCKED' && /^Jan 2027 is locked\./.test(e.message));
  } finally {
    await lock.close();
    await reversing?.catch(() => {});
  }
  assert.deepEqual(await reversalsOf(ob), [], 'the refused reversal left nothing behind');
  assert.equal(await reversedBy(ob), null);
});

// Ruling R73. Every posting reads the months after its own FOR SHARE, after its own month and before the ledgers: an entry
// carries into each of them. So a later month cannot start closing while an entry is posting into an earlier one, and an entry
// that waits for a later month's lock is refused once it lands. On DP's February and March (the test above locked DP's January).
test('R73: an entry holds every later month: closing March waits for a February posting, and a February posting waiting on March\'s lock is refused', gate, async () => {
  const DP = (await h.db.one(`SELECT id FROM fin_books WHERE code = 'DP'`)).id;
  const mar = (await h.db.one(`SELECT id FROM fin_periods WHERE book_id = $1 AND start_date = '2027-03-01'`, [DP])).id;
  const cash = (await h.db.one(`SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = 'Cash'`, [DP])).id;
  const group = (await h.db.one(`SELECT id FROM fin_groups WHERE book_id = $1 AND name = 'Indirect Incomes'`, [DP])).id;
  const income = (await h.call('POST', '/finance/ledgers', { book_id: DP, group_id: group, name: 'Scrap Sales' }, 'md')).body.ledger.id;
  const receipt = async date => {
    const r = await h.call('POST', '/finance/vouchers', {
      book_id: DP, voucher_type: 'receipt', voucher_date: date, client_key: randomUUID(), narration: 'race receipt',
      lines: [L(cash, 500, 0), L(income, 0, 500)],
    }, 'md');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.voucher.id;
  };

  // The posting first, all but its COMMIT: March, which February's entry carries into, cannot start closing until it is done.
  const feb = await receipt('2027-02-12');
  const first = await opened(c1);
  let closing;
  try {
    assert.equal((await finSubmitVoucher(first.qc, first.oc, feb, MD)).status, 'posted');
    closing = inTx(c2, (qc, oc) => finSetPeriodStatus(qc, oc, mar, { status: 'closing' }, MD));
    closing.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid2)), 'March waits for the February entry that carries into it');
    await first.commit();
    assert.equal((await closing).status, 'closing');
  } finally {
    await first.close();
    await closing?.catch(() => {});
  }

  // The lock first, all but its COMMIT: a February receipt waits for March, then finds it locked and is refused, naming March.
  const late = await receipt('2027-02-13');
  const lock = await opened(c2);
  let posting;
  try {
    await finSetPeriodStatus(lock.qc, lock.oc, mar, { status: 'locked' }, MD);
    posting = inTx(c1, (qc, oc) => finSubmitVoucher(qc, oc, late, MD));
    posting.catch(() => {});
    assert.ok(ROW_WAITS.includes(await lockWaitOf(pid1)), 'the February receipt waits for March');
    await lock.commit();
    await assert.rejects(posting, e => e.status === 409 && e.body?.code === 'FIN_PERIOD_LOCKED' && /^Mar 2027 is locked\./.test(e.message));
  } finally {
    await lock.close();
    await posting?.catch(() => {});
  }
  assert.equal((await h.db.one('SELECT status FROM fin_vouchers WHERE id = $1', [late])).status, 'draft', 'the refused receipt is still a draft');
});
