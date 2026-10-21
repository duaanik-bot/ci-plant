import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';

// The hard stops of spec §7.2 (H1–H10), probed on a real database. Every refusal here comes from the
// database itself, never from the app, so it holds for anything that writes to the books.
//
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-db.test.js
//
// One boot for the whole file, set up the way go-live will be: books CI and DP begin on 2027-01-01, the
// real default, so April to December 2026 are before the books and January to March 2027 are open. The
// tests share the database and run in order. A test that moves a month's status puts it back, and a test
// that posts an Opening voucher reverses it again, so H8 starts with no live Opening voucher in CI.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

let h;
const BOOK = {};        // book code -> id
const CODE = {};        // book id -> code
const PERIOD = {};      // book code -> month start_date -> period id
let A, B, CASH, CAPITAL, PL, DP_LEDGER, DP_CASH;   // ledger ids, set in before()

const insert = (table, row) => {
  const cols = Object.keys(row);
  return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row)];
};

// A ledger in a book, under one of that book's groups, by name.
async function ledger(code, name, group, extra = {}) {
  const g = await h.db.one('SELECT id FROM fin_groups WHERE book_id = $1 AND name = $2', [BOOK[code], group]);
  assert.ok(g, `${code} has no group "${group}"`);
  return (await h.db.one(...insert('fin_ledgers', { book_id: BOOK[code], group_id: g.id, name, ...extra }))).id;
}

// A draft voucher and its lines, in one transaction, so a refused line leaves nothing behind. A line is
// [ledgerId, debit, credit] in rupees. `total` is the sum of the debits unless `extra` says otherwise.
// Resolves to the voucher id.
function draft(code, type, date, lines, extra = {}) {
  return h.db.tx(async (qc, oc) => {
    const total = lines.reduce((sum, [, debit]) => sum + debit, 0);
    const v = await oc(...insert('fin_vouchers', { book_id: BOOK[code], voucher_type: type, voucher_date: date, total, ...extra }));
    for (const [i, [ledgerId, debit, credit]] of lines.entries()) {
      await qc(...insert('fin_voucher_lines', { voucher_id: v.id, book_id: BOOK[code], line_no: i + 1, ledger_id: ledgerId, debit, credit }));
    }
    return v.id;
  });
}

// Posts a voucher the way the app will (spec §7.4 step 5), in one transaction, so the deferred checks run
// at its COMMIT. It sets the status, a test number nobody else uses, the month that covers the date (or
// extra.period_id), posted_at, and whatever else `extra` sets. `marking` is the voucher this one reverses:
// it is marked reversed_by_id in the same transaction, as the app does. Resolves to the posted row.
let serial = 0;
function post(id, extra = {}, { marking = null } = {}) {
  return h.db.tx(async (qc, oc) => {
    const { period_id: month, ...rest } = extra;
    const v = await oc('SELECT book_id, voucher_date FROM fin_vouchers WHERE id = $1', [id]);
    const covering = await oc('SELECT id FROM fin_periods WHERE book_id = $1 AND start_date <= $2 AND end_date >= $2',
      [v.book_id, v.voucher_date]);
    const set = { status: 'posted', number: `TEST-${String(++serial).padStart(4, '0')}`, period_id: month ?? covering?.id ?? null, ...rest };
    const cols = Object.keys(set);
    const row = await oc(`UPDATE fin_vouchers SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, posted_at = now()
                           WHERE id = $1 RETURNING *`, [id, ...Object.values(set)]);
    if (marking != null) {
      const marked = await qc('UPDATE fin_vouchers SET reversed_by_id = $1 WHERE id = $2 AND reversed_by_id IS NULL RETURNING id', [id, marking]);
      assert.equal(marked.length, 1, `voucher ${marking} was already reversed`);
    }
    return row;
  });
}

// Reverses a posted voucher the way the app does (spec §7.5): a journal with every line mirrored, posted on
// `date`, and the original marked reversed in the same transaction. Resolves to the reversal's id.
async function reverse(originalId, date) {
  const o = await h.db.one('SELECT book_id FROM fin_vouchers WHERE id = $1', [originalId]);
  const lines = await h.db.q('SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [originalId]);
  const r = await draft(CODE[o.book_id], 'journal', date, lines.map(l => [l.ledger_id, l.credit, l.debit]), { reversal_of_id: originalId });
  await post(r, {}, { marking: originalId });
  return r;
}

// Awaits a write that must be refused and checks who refused it: a hard-stop trigger (its code in DETAIL,
// SQLSTATE P0001) or a named constraint. Resolves to the error.
async function expectCode(promise, code) {
  let error = null;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, `expected ${code}, but there was no error: the write went through`);
  const got = `got ${error.code} detail=${error.detail} constraint=${error.constraint}: ${error.message}`;
  if (code.startsWith('FIN_')) {
    assert.equal(error.detail, code, got);
    assert.equal(error.code, 'P0001', got);
  } else {
    assert.equal(error.constraint, code, got);
  }
  return error;
}

const bal = (amount, debitLedger = A, creditLedger = B) => [[debitLedger, amount, 0], [creditLedger, 0, amount]];
const mirror = lines => lines.map(([ledgerId, debit, credit]) => [ledgerId, credit, debit]);
const row = id => h.db.one('SELECT * FROM fin_vouchers WHERE id = $1', [id]);
const setMonth = (code, start, status) =>
  h.db.q('UPDATE fin_periods SET status = $3 WHERE book_id = $1 AND start_date = $2', [BOOK[code], start, status]);

// A write that must never commit runs in a transaction ending in this error, so if the write does go
// through, it is rolled back all the same and the tests after it keep their data.
const WENT_THROUGH = new Error('the write went through (rolled back)');

// The book's live Opening voucher, posting one if it has none.
async function liveOpening(code) {
  const live = await h.db.one(`SELECT id FROM fin_vouchers
    WHERE book_id = $1 AND voucher_type = 'opening' AND status = 'posted' AND reversed_by_id IS NULL`, [BOOK[code]]);
  if (live) return live.id;
  const o = await draft(code, 'opening', '2026-12-31', code === 'DP' ? bal(700, DP_CASH, DP_LEDGER) : bal(500, CASH, CAPITAL));
  await post(o);
  return o;
}

before(async () => {
  if (!ON) return;
  h = await finBootPg('db');
  for (const b of await h.db.q('SELECT id, code, books_begin FROM fin_books')) {
    assert.equal(b.books_begin, '2027-01-01', `${b.code} begins its books on the real default`);
    BOOK[b.code] = b.id;
    CODE[b.id] = b.code;
  }
  for (const p of await h.db.q('SELECT p.id, b.code, p.start_date, p.status FROM fin_periods p JOIN fin_books b ON b.id = p.book_id')) {
    (PERIOD[p.code] ??= {})[p.start_date] = p.id;
    if (p.start_date === '2026-12-01') assert.equal(p.status, 'before_books', `${p.code} Dec 2026`);
    if (p.start_date >= '2027-01-01') assert.equal(p.status, 'open', `${p.code} ${p.start_date}`);
  }
  const system = async (code, name) => (await h.db.one('SELECT id FROM fin_ledgers WHERE book_id = $1 AND name = $2', [BOOK[code], name])).id;
  A = await ledger('CI', 'Rent', 'Indirect Expenses');
  B = await ledger('CI', 'Freight', 'Direct Expenses');
  CAPITAL = await ledger('CI', 'Proprietor Capital A/c', 'Capital Account');
  CASH = await system('CI', 'Cash');
  PL = await system('CI', 'Profit & Loss A/c');           // seeded system-only: manual_entry = false
  DP_LEDGER = await ledger('DP', 'Rent', 'Indirect Expenses');
  DP_CASH = await system('DP', 'Cash');
});

after(async () => { await h?.close(); });

test('the eight hard-stop triggers are in place, the two posting checks deferred to COMMIT, and a replay changes none of them', gate, async () => {
  const triggers = async () => (await h.db.q(`
      SELECT c.relname AS tbl, t.tgname AS name, p.proname AS fn, t.tgconstraint <> 0 AS is_constraint,
             t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred, t.tgenabled::text AS enabled, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'fin\\_%'`))
    .sort((x, y) => `${x.tbl} ${x.name}`.localeCompare(`${y.tbl} ${y.name}`));
  const now = await triggers();
  assert.deepEqual(now.map(t => [t.tbl, t.name, t.fn, t.is_constraint, t.deferrable, t.deferred, t.enabled]), [
    ['fin_audit_log', 'fin_audit_guard', 'fin_audit_guard', false, false, false, 'O'],
    ['fin_audit_log', 'fin_no_truncate', 'fin_no_truncate', false, false, false, 'O'],
    ['fin_voucher_lines', 'fin_line_guard', 'fin_line_guard', false, false, false, 'O'],
    ['fin_voucher_lines', 'fin_no_truncate', 'fin_no_truncate', false, false, false, 'O'],
    ['fin_vouchers', 'fin_no_truncate', 'fin_no_truncate', false, false, false, 'O'],
    ['fin_vouchers', 'fin_voucher_guard', 'fin_voucher_guard', false, false, false, 'O'],
    ['fin_vouchers', 'fin_voucher_post_check_ins', 'fin_voucher_post_check', true, true, true, 'O'],
    ['fin_vouchers', 'fin_voucher_post_check_upd', 'fin_voucher_post_check', true, true, true, 'O'],
  ]);
  // The posting checks fire only on the way INTO posted.
  const def = name => now.find(t => t.name === name).def;
  assert.match(def('fin_voucher_post_check_ins'), /AFTER INSERT ON public\.fin_vouchers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN \(\(new\.status = 'posted'::text\)\)/);
  assert.match(def('fin_voucher_post_check_upd'), /AFTER UPDATE ON public\.fin_vouchers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN \(\(\(new\.status = 'posted'::text\) AND \(old\.status <> 'posted'::text\)\)\)/);
  // init() replays the migration on every boot.
  await h.db.init();
  assert.deepEqual(await triggers(), now);
});

test('H1 unbalanced, one-line and wrong-total vouchers do not post', gate, async () => {
  const unbalanced = await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 90]]);
  await expectCode(post(unbalanced), 'FIN_UNBALANCED');
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0]])), 'FIN_TOO_FEW_LINES');
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [])), 'FIN_TOO_FEW_LINES');
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 100]], { total: 90 })), 'FIN_UNBALANCED');
  // to the paisa, however many lines
  await expectCode(post(await draft('CI', 'journal', '2027-01-10', [[A, 100.01, 0], [B, 0, 50], [B, 0, 50]])), 'FIN_UNBALANCED');

  // The refusal comes at COMMIT and takes the whole posting with it: still a draft, no number, no month.
  const refused = await row(unbalanced);
  assert.deepEqual([refused.status, refused.number, refused.period_id, refused.posted_at], ['draft', null, null, null]);

  const ok = await post(await draft('CI', 'journal', '2027-01-10', [[A, 100, 0], [B, 0, 100]]));   // balanced posts
  assert.equal(ok.status, 'posted');
  await post(await draft('CI', 'journal', '2027-01-10', [[A, 100.01, 0], [B, 0, 50], [B, 0, 50.01]]));

  // A voucher inserted already posted can never have a line (H4), so it never commits either.
  await expectCode(h.db.tx(qc => qc(...insert('fin_vouchers', {
    book_id: BOOK.CI, voucher_type: 'journal', voucher_date: '2027-01-10', status: 'posted', number: 'TEST-DIRECT',
    period_id: PERIOD.CI['2027-01-01'], posted_at: new Date(),
  }))), 'FIN_TOO_FEW_LINES');
});

test('H2 a line is one side, never both, never zero', gate, async () => {
  await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 5, 5], [B, 0, 0]]), 'fin_voucher_lines_one_side');
  await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 5, 0], [B, 0, 0]], { narration: 'H2 zero line' }), 'fin_voucher_lines_one_side');
  assert.equal((await h.db.one(`SELECT COUNT(*)::int AS n FROM fin_vouchers WHERE narration = 'H2 zero line'`)).n, 0,
    'the refused line took its voucher with it');
});

// PostgreSQL's NaN equals itself and is greater than every number, so `debit > 0` holds for it, and so would
// H1's "debits equal credits and are more than zero". JavaScript's NaN reaches it through node-pg as 'NaN'.
test('H2 NaN is no amount: no line and no voucher total may be NaN', gate, async t => {
  await t.test('a NaN debit', async () => {
    await expectCode(draft('CI', 'journal', '2027-01-10', [[A, NaN, 0], [B, 0, NaN]], { total: 0 }), 'fin_voucher_lines_one_side');
  });
  await t.test('a NaN credit', async () => {
    await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 5, 0], [B, 0, NaN]], { total: 5 }), 'fin_voucher_lines_one_side');
  });
  await t.test('a NaN total', async () => {
    await expectCode(draft('CI', 'journal', '2027-01-10', bal(5), { total: NaN }), 'fin_vouchers_total_check');
  });
});

test('H1 a NaN sum never balances, even with the CHECKs that refuse NaN gone', gate, async () => {
  // The CHECKs are dropped in a transaction that is always rolled back, and the posting check is made
  // immediate so that it runs inside it.
  await expectCode(h.db.tx(async (qc, oc) => {
    await qc('ALTER TABLE fin_voucher_lines DROP CONSTRAINT fin_voucher_lines_one_side');
    await qc('ALTER TABLE fin_vouchers DROP CONSTRAINT IF EXISTS fin_vouchers_total_check');
    await qc('SET CONSTRAINTS ALL IMMEDIATE');
    const v = await oc(...insert('fin_vouchers', { book_id: BOOK.CI, voucher_type: 'journal', voucher_date: '2027-01-10', total: NaN }));
    await qc(...insert('fin_voucher_lines', { voucher_id: v.id, book_id: BOOK.CI, line_no: 1, ledger_id: A, debit: NaN, credit: 0 }));
    await qc(...insert('fin_voucher_lines', { voucher_id: v.id, book_id: BOOK.CI, line_no: 2, ledger_id: B, debit: 0, credit: NaN }));
    await qc(`UPDATE fin_vouchers SET status = 'posted', number = 'TEST-NAN', period_id = $2, posted_at = now() WHERE id = $1`,
      [v.id, PERIOD.CI['2027-01-01']]);
    throw WENT_THROUGH;
  }), 'FIN_UNBALANCED');
  const kept = await h.db.q(`SELECT conname FROM pg_constraint WHERE conname IN ('fin_voucher_lines_one_side', 'fin_vouchers_total_check') ORDER BY 1`);
  assert.deepEqual(kept.map(c => c.conname), ['fin_voucher_lines_one_side', 'fin_vouchers_total_check'], 'the rollback put both CHECKs back');
});

test('H3 a posted voucher cannot change or vanish; reversed_by_id is set once', gate, async t => {
  // Each case gets a voucher of its own, posted in January.
  const posted = async () => {
    const v = await draft('CI', 'journal', '2027-01-11', bal(100));
    await post(v);
    return v;
  };
  const mark = (v, by) => h.db.q('UPDATE fin_vouchers SET reversed_by_id = $2 WHERE id = $1', [v, by]);

  await t.test('nothing about it changes, and it is never deleted', async () => {
    const v = await posted();
    const was = await row(v);
    await expectCode(h.db.q(`UPDATE fin_vouchers SET narration = 'edited after posting' WHERE id = $1`, [v]), 'FIN_POSTED_IMMUTABLE');
    await expectCode(h.db.q(`UPDATE fin_vouchers SET status = 'draft', number = NULL, period_id = NULL, posted_at = NULL WHERE id = $1`, [v]),
      'FIN_POSTED_IMMUTABLE');
    await expectCode(h.db.q('DELETE FROM fin_vouchers WHERE id = $1', [v]), 'FIN_POSTED_IMMUTABLE');
    assert.deepEqual(await row(v), was);
  });

  // The mark names the voucher's own reversal, posted, in its book. Any other value would take the voucher
  // out of H8's indexes (one live Opening voucher, one live posting per ERP document) unreversed.
  await t.test('it is not marked reversed by a reversal still waiting to post', async () => {
    const v = await posted();
    const waiting = await draft('CI', 'journal', '2027-01-12', mirror(bal(100)), { reversal_of_id: v });
    await expectCode(mark(v, waiting), 'FIN_POSTED_IMMUTABLE');
  });
  await t.test('it is not marked reversed by itself', async () => {
    const v = await posted();
    await expectCode(mark(v, v), 'FIN_POSTED_IMMUTABLE');
  });
  await t.test('it is not marked reversed by a posted voucher that does not reverse it', async () => {
    const v = await posted();
    await expectCode(mark(v, await posted()), 'FIN_POSTED_IMMUTABLE');
  });
  await t.test('it is not marked reversed by a voucher of the other book, even one that says it reverses it', async () => {
    const v = await posted();
    // Such a voucher can never post (FIN_BAD_REVERSAL). Inserted posted here, it lasts until the COMMIT that
    // would refuse it, which never comes.
    await expectCode(h.db.tx(async (qc, oc) => {
      const x = await oc(...insert('fin_vouchers', {
        book_id: BOOK.DP, voucher_type: 'journal', voucher_date: '2027-01-12', status: 'posted', number: `TEST-OTHER-BOOK-${v}`,
        period_id: PERIOD.DP['2027-01-01'], posted_at: new Date(), reversal_of_id: v,
      }));
      await qc('UPDATE fin_vouchers SET reversed_by_id = $2 WHERE id = $1', [v, x.id]);
      throw WENT_THROUGH;
    }), 'FIN_POSTED_IMMUTABLE');
  });
  await t.test('it is marked by its own posted reversal, in the transaction that posts it, that column alone, once', async () => {
    const v = await posted();
    const was = await row(v);
    const r = await draft('CI', 'journal', '2027-01-12', mirror(bal(100)), { reversal_of_id: v });
    await expectCode(h.db.tx(async qc => {
      await qc(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now() WHERE id = $1`,
        [r, `TEST-REVERSAL-${r}`, PERIOD.CI['2027-01-01']]);
      await qc(`UPDATE fin_vouchers SET reversed_by_id = $2, narration = 'reversed' WHERE id = $1`, [v, r]);
    }), 'FIN_POSTED_IMMUTABLE');
    await post(r, {}, { marking: v });
    await expectCode(mark(v, await posted()), 'FIN_POSTED_IMMUTABLE');
    await expectCode(h.db.q('UPDATE fin_vouchers SET reversed_by_id = NULL WHERE id = $1', [v]), 'FIN_POSTED_IMMUTABLE');
    assert.deepEqual(await row(v), { ...was, reversed_by_id: r }, 'exactly as posted, plus the mark');
  });

  await t.test('only a posted voucher is frozen: a draft is edited, sent back from submitted, and deleted', async () => {
    const d = await draft('CI', 'journal', '2027-01-12', []);
    await h.db.q(`UPDATE fin_vouchers SET narration = 'still a draft', status = 'submitted' WHERE id = $1`, [d]);
    await h.db.q(`UPDATE fin_vouchers SET status = 'draft' WHERE id = $1`, [d]);
    await h.db.q('DELETE FROM fin_vouchers WHERE id = $1', [d]);
    assert.equal(await row(d), null);
  });
});

test('H4 lines of a posted voucher are frozen', gate, async () => {
  const v = await draft('CI', 'journal', '2027-01-13', bal(100));
  await post(v);
  const lines = id => h.db.q('SELECT line_no, ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [id]);
  const posted = await lines(v);
  await expectCode(h.db.q(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, 3, $3, 10, 0)`,
    [v, BOOK.CI, A]), 'FIN_POSTED_IMMUTABLE');
  await expectCode(h.db.q('UPDATE fin_voucher_lines SET debit = 999 WHERE voucher_id = $1 AND line_no = 1', [v]), 'FIN_POSTED_IMMUTABLE');
  await expectCode(h.db.q('DELETE FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = 2', [v]), 'FIN_POSTED_IMMUTABLE');
  // nor moved into a posted voucher, or out of one
  const d = await draft('CI', 'journal', '2027-01-13', bal(5));
  await expectCode(h.db.q('UPDATE fin_voucher_lines SET voucher_id = $2, line_no = 9 WHERE voucher_id = $1 AND line_no = 1', [d, v]), 'FIN_POSTED_IMMUTABLE');
  await expectCode(h.db.q('UPDATE fin_voucher_lines SET voucher_id = $2, line_no = 9 WHERE voucher_id = $1 AND line_no = 1', [v, d]), 'FIN_POSTED_IMMUTABLE');
  assert.deepEqual(await lines(v), posted);

  // A draft's lines are not frozen.
  await h.db.q('UPDATE fin_voucher_lines SET debit = 6 WHERE voucher_id = $1 AND line_no = 1', [d]);
  await h.db.q('DELETE FROM fin_voucher_lines WHERE voucher_id = $1', [d]);
  assert.deepEqual(await lines(d), []);
});

// Two connections of their own: the pool has one client, and one side of the race must hold its transaction
// open. The posting holds its voucher row; a line written meanwhile must wait for the posting to finish and
// then see the voucher posted. Reading the voucher's status without a lock would let the write through.
test('H4 holds under a race: a line written while its voucher is being posted waits for the posting, then is refused', gate, async () => {
  const poster = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const writer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await poster.connect();
  await writer.connect();
  try {
    const ways = [
      ['an added line', `INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, ${BOOK.CI}, 3, ${A}, 50, 0)`],
      ['a changed line', 'UPDATE fin_voucher_lines SET debit = 150 WHERE voucher_id = $1 AND line_no = 1'],
      ['a deleted line', 'DELETE FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = 2'],
    ];
    for (const [what, sql] of ways) {
      const v = await draft('CI', 'journal', '2027-01-14', bal(100));
      await poster.query('BEGIN');
      await poster.query(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now() WHERE id = $1`,
        [v, `TEST-RACE-${v}`, PERIOD.CI['2027-01-01']]);
      let settled = false;
      const write = writer.query(sql, [v]);
      write.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(settled, false, `${what} waits for the posting to finish`);
      await poster.query('COMMIT');
      await expectCode(write, 'FIN_POSTED_IMMUTABLE');
      assert.equal((await row(v)).status, 'posted', what);
      const lines = await h.db.q('SELECT line_no, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [v]);
      assert.deepEqual(lines.map(l => [l.line_no, l.debit, l.credit]), [[1, 100, 0], [2, 0, 100]], `${what}: the posted lines are as checked`);
    }
  } finally {
    await poster.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([poster.end(), writer.end()]);
  }
});

test('H5 months: locked, closing without approval, before books, bad and foreign dates', gate, async () => {
  // The date is a real calendar date, inside the month the voucher names, and that month is its own book's.
  await expectCode(post(await draft('CI', 'journal', '2027-02-29', bal(100)), { period_id: PERIOD.CI['2027-02-01'] }), 'FIN_BAD_DATE');
  await expectCode(post(await draft('CI', 'journal', '2027-01-15', bal(100)), { period_id: PERIOD.CI['2027-02-01'] }), 'FIN_BAD_DATE');
  await expectCode(post(await draft('CI', 'journal', '2027-01-15', bal(100)), { period_id: PERIOD.DP['2027-01-01'] }), 'FIN_WRONG_BOOK');

  // Before the books begin, only the Opening voucher, and a reversal of it.
  await expectCode(post(await draft('CI', 'journal', '2026-12-31', bal(100))), 'FIN_BEFORE_BOOKS');
  const opening = await draft('CI', 'opening', '2026-12-31', bal(100, CASH, CAPITAL));
  await post(opening);
  const jan = await draft('CI', 'journal', '2027-01-15', bal(100));
  await post(jan);
  // a true reversal (mirrored, posted and marked in one transaction), but of a journal, not the Opening voucher
  await expectCode(post(await draft('CI', 'journal', '2026-12-31', mirror(bal(100)), { reversal_of_id: jan }), {}, { marking: jan }),
    'FIN_BEFORE_BOOKS');
  assert.equal((await row(jan)).reversed_by_id, null, 'the refusal took the mark with it');
  await reverse(opening, '2026-12-31');
  assert.ok((await row(opening)).reversed_by_id, 'the Opening voucher is reversed on its own date');

  // Locked and closing months.
  try {
    await setMonth('CI', '2027-02-01', 'locked');
    await expectCode(post(await draft('CI', 'journal', '2027-02-10', bal(100))), 'FIN_PERIOD_LOCKED');
    await expectCode(post(await draft('CI', 'journal', '2027-02-10', bal(100)), { approved_by_id: h.users.md.id }), 'FIN_PERIOD_LOCKED');
    await setMonth('CI', '2027-03-01', 'closing');
    const mar = await draft('CI', 'journal', '2027-03-10', bal(100));
    await expectCode(post(mar), 'FIN_PERIOD_CLOSING');
    const approved = await post(mar, { approved_by_id: h.users.md.id, approved_by: 'Test MD', approved_at: new Date() });
    assert.equal(approved.status, 'posted');
  } finally {
    await setMonth('CI', '2027-02-01', 'open');
    await setMonth('CI', '2027-03-01', 'open');
  }
});

test('H6 inactive and system-only ledgers', gate, async () => {
  const OLD = await ledger('CI', 'Old Deposit', 'Deposits (Asset)', { active: false });
  await expectCode(post(await draft('CI', 'journal', '2027-01-16', bal(100, OLD, B))), 'FIN_LEDGER_INACTIVE');
  await expectCode(post(await draft('CI', 'journal', '2027-01-16', bal(100, A, PL))), 'FIN_SYSTEM_LEDGER');
  await expectCode(post(await draft('CI', 'journal', '2027-01-16', [[A, 100, 0], [B, 0, 50], [PL, 0, 50]])), 'FIN_SYSTEM_LEDGER');

  // The system-only ledger is taken by the Opening voucher, by a voucher the ERP posts from one of its
  // documents, and by a reversal, which mirrors what it reverses.
  const opening = await draft('CI', 'opening', '2026-12-31', bal(100, CASH, PL));
  await post(opening);
  const auto = await draft('CI', 'journal', '2027-01-16', bal(200, A, PL), { source_type: 'test_document', source_id: 1 });
  await post(auto);
  await reverse(auto, '2027-01-17');
  await reverse(opening, '2026-12-31');

  // Only a reversal may use an inactive ledger: one switched off since the entry it reverses.
  await expectCode(post(await draft('CI', 'opening', '2026-12-31', bal(100, CASH, OLD))), 'FIN_LEDGER_INACTIVE');
  const LAPSED = await ledger('CI', 'Lapsed Ledger', 'Indirect Expenses');
  const used = await draft('CI', 'journal', '2027-01-18', bal(300, LAPSED, B));
  await post(used);
  await h.db.q('UPDATE fin_ledgers SET active = false WHERE id = $1', [LAPSED]);
  await expectCode(post(await draft('CI', 'journal', '2027-01-19', bal(300, LAPSED, B))), 'FIN_LEDGER_INACTIVE');
  await reverse(used, '2027-01-19');
});

test('H7 a line cannot use the other book\'s ledger', gate, async () => {
  await expectCode(draft('CI', 'journal', '2027-01-10', [[A, 1, 0], [DP_LEDGER, 0, 1]]), 'fin_voucher_lines_ledger_book_fk');
});

test('H8 one live opening per book, one reversal per voucher, one live posting per source', gate, async () => {
  // One live Opening voucher per book (H5 and H6 reversed theirs); the other book keeps its own.
  await post(await draft('CI', 'opening', '2026-12-31', bal(500, CASH, CAPITAL)));
  await expectCode(post(await draft('CI', 'opening', '2026-12-31', bal(600, CASH, CAPITAL))), 'fin_vouchers_one_live_opening');
  await post(await draft('DP', 'opening', '2026-12-31', bal(700, DP_CASH, DP_LEDGER)));

  // One reversal per voucher, a draft one included.
  const j = await draft('CI', 'journal', '2027-01-21', bal(100));
  await post(j);
  await draft('CI', 'journal', '2027-01-22', [[A, 0, 100], [B, 100, 0]], { reversal_of_id: j });
  await expectCode(draft('CI', 'journal', '2027-01-22', [[A, 0, 100], [B, 100, 0]], { reversal_of_id: j }), 'fin_vouchers_one_reversal');

  // One live posting per ERP document, whether it is waiting for approval or posted.
  const source = { source_type: 'test_invoice', source_id: 41 };
  await post(await draft('CI', 'journal', '2027-01-23', bal(100), source));
  const twin = await draft('CI', 'journal', '2027-01-23', bal(100), source);      // a draft of it may exist
  await expectCode(post(twin), 'fin_vouchers_one_live_source');
  await expectCode(h.db.q(`UPDATE fin_vouchers SET status = 'submitted' WHERE id = $1`, [twin]), 'fin_vouchers_one_live_source');
});

// H5 and H6 excuse a reversal from three rules: a reversal of the Opening voucher may be dated before the
// books, and a reversal may use an inactive or a system-only ledger. So a reversal is proved first: it
// reverses another posted voucher of its own book, mirrors its lines exactly (debit and credit swapped, as
// multisets), and that voucher is marked as reversed by it at COMMIT. Each case has vouchers of its own.
test('a reversal is proved before it is excused: a posted voucher of its book, mirrored line for line, marked by COMMIT', gate, async t => {
  const DORMANT = await ledger('CI', 'Dormant Ledger', 'Indirect Expenses', { active: false });
  const posted = async lines => {
    const v = await draft('CI', 'journal', '2027-01-27', lines);
    await post(v);
    return v;
  };

  await t.test('P4: dated before the books, using a system-only and an inactive ledger, "reversing" an Opening voucher never posted', async () => {
    // Its mirror image is exact, so the one thing wrong is that it was never posted; and the draft cannot even take the mark,
    // since only a posted voucher is marked reversed (fin_vouchers_reversed_only_posted, final wave item 4).
    const neverPosted = await draft('CI', 'opening', '2026-12-31', [[PL, 100, 0], [DORMANT, 0, 100]]);
    const x = await draft('CI', 'journal', '2026-06-15', [[PL, 0, 100], [DORMANT, 100, 0]], { reversal_of_id: neverPosted });
    await expectCode(post(x), 'FIN_BAD_REVERSAL');
    await expectCode(post(x, {}, { marking: neverPosted }), 'fin_vouchers_reversed_only_posted');
  });

  await t.test('P5: dated before the books, using a system-only ledger, "reversing" the other book\'s Opening voucher', async () => {
    const theirs = await liveOpening('DP');
    const x = await draft('CI', 'journal', '2026-09-09', [[PL, 40, 0], [B, 0, 40]], { reversal_of_id: theirs });
    await expectCode(post(x), 'FIN_BAD_REVERSAL');
    await expectCode(post(x, {}, { marking: theirs }), 'FIN_POSTED_IMMUTABLE');   // and the mark itself is refused (H3)
  });

  for (const [what, lines, wrong] of [
    ['a paisa off', bal(100), [[A, 0, 100.01], [B, 100.01, 0]]],
    ['a copy, not a mirror', bal(100), bal(100)],
    ['a line short', [[A, 100, 0], [B, 0, 100], [A, 5, 0], [B, 0, 5]], mirror(bal(100))],
    ['a line over', bal(100), [...mirror(bal(100)), [A, 0, 1], [B, 1, 0]]],
  ]) {
    await t.test(`its lines are the original's, each side swapped: not ${what}`, async () => {
      const v = await posted(lines);
      await expectCode(post(await draft('CI', 'journal', '2027-01-28', wrong, { reversal_of_id: v }), {}, { marking: v }), 'FIN_BAD_REVERSAL');
      assert.equal((await row(v)).reversed_by_id, null, 'the refusal took the mark with it');
    });
  }

  await t.test('the voucher it reverses is marked as reversed by it at COMMIT', async () => {
    const v = await posted(bal(100));
    await expectCode(post(await draft('CI', 'journal', '2027-01-28', mirror(bal(100)), { reversal_of_id: v })), 'FIN_BAD_REVERSAL');
  });

  await t.test('a voucher reverses another, never itself', async () => {
    const d = await draft('CI', 'journal', '2027-01-28', [[A, 100, 0], [A, 0, 100]]);   // its own mirror image
    await h.db.q('UPDATE fin_vouchers SET reversal_of_id = id WHERE id = $1', [d]);
    await expectCode(post(d, {}, { marking: d }), 'FIN_POSTED_IMMUTABLE');   // the mark is refused (H3)
    await expectCode(post(d), 'FIN_BAD_REVERSAL');
  });

  // H8's indexes leave out a voucher marked reversed, so a voucher already marked must not post: here, a second live Opening
  // voucher would. A draft cannot take the mark at all (fin_vouchers_reversed_only_posted), so the one way left is a posting that
  // sets the mark itself, in the same statement, and the check at COMMIT refuses that.
  await t.test('a voucher already marked as reversed does not post', async () => {
    await liveOpening('CI');
    const second = await draft('CI', 'opening', '2026-12-31', bal(50, CASH, CAPITAL));
    const other = await draft('CI', 'journal', '2027-01-28', []);
    await expectCode(h.db.q('UPDATE fin_vouchers SET reversed_by_id = $2 WHERE id = $1', [second, other]), 'fin_vouchers_reversed_only_posted');
    await expectCode(post(second, { reversed_by_id: other }), 'FIN_BAD_REVERSAL');
  });

  await t.test('a true reversal posts', async () => {
    const v = await posted(bal(100));
    const r = await reverse(v, '2027-01-28');
    assert.deepEqual([(await row(r)).status, (await row(v)).reversed_by_id], ['posted', r]);
  });

  // Ruling R42: an Opening voucher is reversed as at its own date. Reversed later, it would stay in the books until then,
  // beside whatever opening was built in its place, and every balance as at its date would count the opening twice.
  await t.test('an Opening voucher is reversed as at its own date, never a day later', async () => {
    const opening = await liveOpening('CI');
    const lines = await h.db.q('SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [opening]);
    const late = await draft('CI', 'journal', '2027-01-28', lines.map(l => [l.ledger_id, l.credit, l.debit]), { reversal_of_id: opening });
    await expectCode(post(late, {}, { marking: opening }), 'FIN_BAD_REVERSAL');
    assert.equal((await row(opening)).reversed_by_id, null, 'the refusal took the mark with it');
    await h.db.q(`UPDATE fin_vouchers SET status = 'discarded' WHERE id = $1`, [late]);
    const r = await reverse(opening, '2026-12-31');
    assert.deepEqual([(await row(r)).status, (await row(opening)).reversed_by_id], ['posted', r]);
  });

  // Ruling R45: the reversal of an Opening voucher is never reversed itself. It would put the opening back in the books,
  // from its own date on, beside whatever opening was built in its place.
  await t.test('the reversal of an Opening voucher is never reversed, on any date', async () => {
    const opening = await liveOpening('CI');
    const r = await reverse(opening, '2026-12-31');
    const lines = await h.db.q('SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [r]);
    for (const date of ['2027-01-29', '2026-12-31']) {
      const undo = await draft('CI', 'journal', date, lines.map(l => [l.ledger_id, l.credit, l.debit]), { reversal_of_id: r });
      await expectCode(post(undo, {}, { marking: r }), 'FIN_BAD_REVERSAL');
      assert.equal((await row(r)).reversed_by_id, null, `${date}: the refusal took the mark with it`);
      await h.db.q(`UPDATE fin_vouchers SET status = 'discarded' WHERE id = $1`, [undo]);
    }
  });
});

// Each TRUNCATE runs in a transaction that is always rolled back, so if one did go through, the tests after
// it would still have their data.
const truncate = sql => h.db.tx(async qc => { await qc(sql); throw WENT_THROUGH; });

test('H9 H10 the audit log is append-only and nothing in the books can be truncated', gate, async () => {
  const entry = await h.db.one(`INSERT INTO fin_audit_log (book_id, entity, action, user_name) VALUES ($1, 'test', 'probe', 'Test') RETURNING id`,
    [BOOK.CI]);
  await expectCode(h.db.q(`UPDATE fin_audit_log SET reason = 'rewritten' WHERE id = $1`, [entry.id]), 'FIN_AUDIT_APPEND_ONLY');
  await expectCode(h.db.q('DELETE FROM fin_audit_log WHERE id = $1', [entry.id]), 'FIN_AUDIT_APPEND_ONLY');
  assert.equal((await h.db.one('SELECT reason FROM fin_audit_log WHERE id = $1', [entry.id])).reason, null);

  await expectCode(truncate('TRUNCATE fin_voucher_lines'), 'FIN_NO_TRUNCATE');
  await expectCode(truncate('TRUNCATE fin_audit_log'), 'FIN_NO_TRUNCATE');
  for (const table of ['fin_vouchers', 'fin_voucher_lines', 'fin_audit_log', 'fin_books']) {
    await expectCode(truncate(`TRUNCATE ${table} CASCADE`), 'FIN_NO_TRUNCATE');   // fin_books: the cascade reaches the vouchers
  }
});

test('a voucher in a month locked after posting can still be marked reversed', gate, async () => {
  const v = await draft('CI', 'journal', '2027-01-25', bal(400));
  await post(v);
  await setMonth('CI', '2027-01-01', 'locked');
  try {
    const r = await reverse(v, '2027-03-02');           // the reversal posts in an open month, and marks v in the same transaction
    const marked = await row(v);
    assert.deepEqual([marked.status, marked.reversed_by_id], ['posted', r]);
  } finally {
    await setMonth('CI', '2027-01-01', 'open');
  }
});
