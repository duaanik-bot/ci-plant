import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { finBootPg } from './finance-pg-harness.js';
import { finMapDbError, FIN_SENTENCES } from './finance-errors.js';

// The Finance Cash & Bank migration on a real database (spec docs/superpowers/specs/2026-11-20-finance-cash-bank-design.md
// §6.2, §9.4, §10). Every refusal here comes from the database itself, so it holds for anything that writes to the books:
// allocations and opening corrections are written by hand, as SP1's schema tests write their hard stops (ruling R3).
//
// Opt-in, because it boots its own throwaway Postgres:
//   cd server && FINANCE_PG=1 node --test src/finance-pg-cash-schema.test.js
//
// One boot for the file, set up the way go-live will be: books CI and DP begin on 2027-01-01, so December 2026 is before the
// books and January to March 2027 are open. The tests share the database and run in order; each deletes the allocations it
// makes and puts back the months it moves. Every name and figure here is invented.
const ON = process.env.FINANCE_PG === '1';
const gate = { skip: ON ? false : 'set FINANCE_PG=1' };

const NEW_TABLES = ['fin_allocations', 'fin_book_settings', 'fin_cash_counts', 'fin_hr_channels', 'fin_hr_covers', 'fin_hr_exceptions',
  'fin_hr_expense_map', 'fin_ledger_roles'];

let h;
const BOOK = {};      // book code -> id
const PERIOD = {};    // CI month start_date -> period id
let ACME, BOLT, SALES, DISCOUNTS, CAPITAL, PETTY, OLD, CASH, PL, STAFF;   // CI ledger ids
// Posted journals, each { id, number, line: { line_no: line id } }: Acme's two bills, two credits that settle them, one bill of
// Bolt's, a draft, and a posted bill that was reversed, with its reversal.
let BILL, BILL2, PAID, PAID2, BOLT_BILL, DRAFT, GONE, GONE_REV;

const ok = async call => {
  const r = await call;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const groupId = async name => (await h.db.one('SELECT id FROM fin_groups WHERE book_id = $1 AND name = $2', [BOOK.CI, name])).id;
const ledger = async (group, name) =>
  (await ok(h.call('POST', '/finance/ledgers', { book_id: BOOK.CI, group_id: await groupId(group), name }, 'acct'))).ledger.id;
const withLines = async v => ({
  ...v, line: Object.fromEntries((await h.db.q('SELECT id, line_no FROM fin_voucher_lines WHERE voucher_id = $1', [v.id])).map(l => [l.line_no, l.id])),
});
// A journal of CI, made by the MD as finance-pg-vouchers.test.js makes them; `lines` are [ledgerId, debit_paise, credit_paise].
const drafted = async (lines, date = '2027-01-12') => (await ok(h.call('POST', '/finance/vouchers', {
  book_id: BOOK.CI, voucher_type: 'journal', voucher_date: date, client_key: randomUUID(), narration: 'cash schema',
  lines: lines.map(([ledger_id, debit_paise, credit_paise]) => ({ ledger_id, debit_paise, credit_paise })),
}, 'md'))).voucher;
// …and submitted by him: the journal rule is always, and an Approver's own entry posts at once, self-approved.
async function journal(lines, date) {
  const v = (await ok(h.call('POST', `/finance/vouchers/${(await drafted(lines, date)).id}/submit`, null, 'md'))).voucher;
  assert.deepEqual([v.status, v.self_approved], ['posted', true]);
  return withLines(v);
}

// One allocation, written straight into the table with no engine in front of it. Amounts in rupees, as the column holds them.
const allocate = (qc, { debit, credit, amount, ledger: ledgerId = ACME, book = BOOK.CI, mode = 'pick' }) => qc(
  `INSERT INTO fin_allocations (book_id, ledger_id, debit_line_id, credit_line_id, amount, mode, made_by_id, made_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, 'Test MD') RETURNING id`, [book, ledgerId, debit, credit, amount, mode, h.users.md.id]);
// A credit to Acme posted by hand inside the caller's transaction, as finPostLocked posts: the draft and its lines, then its
// status (Test Discounts Dr `debit`, Acme Cr `credit`, in rupees, dated in open January). Resolves to its Acme line's id.
async function postedCreditIn(qc, oc, debit, credit) {
  const v = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total) VALUES ($1, 'journal', '2027-01-15', $2) RETURNING id`,
    [BOOK.CI, debit]);
  await qc(`INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, 1, $3, $4, 0), ($1, $2, 2, $5, 0, $6)`,
    [v.id, BOOK.CI, DISCOUNTS, debit, ACME, credit]);
  await qc(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now() WHERE id = $1`,
    [v.id, `HAND-${v.id}`, PERIOD['2027-01-01']]);
  return (await oc('SELECT id FROM fin_voucher_lines WHERE voucher_id = $1 AND line_no = 2', [v.id])).id;
}
const allocated = async lineId => (await h.db.one(
  'SELECT COALESCE(SUM(amount), 0)::float8 AS n FROM fin_allocations WHERE debit_line_id = $1 OR credit_line_id = $1', [lineId])).n;
const clearAllocations = () => h.db.q('DELETE FROM fin_allocations');

const WENT_THROUGH = new Error('the write went through (rolled back)');
// The error a write is refused with at its own statement: it runs in a transaction that is always rolled back.
async function refusedAtStatement(write) {
  let error = null;
  try { await h.db.tx(async (qc, oc) => { await write(qc, oc); throw WENT_THROUGH; }); } catch (e) { error = e; }
  assert.notEqual(error, WENT_THROUGH, 'the write went through: nothing refused it');
  return error;
}
// The error a transaction is refused with, at a statement or at its COMMIT, or null when the COMMIT went through.
async function committed(write) {
  try { await h.db.tx(write); return null; } catch (e) { return e; }
}
// A hard-stop trigger refused it, `code` in DETAIL, and a route passes it on as a 409 in that code's own sentence.
function byTrigger(error, code, what = '') {
  assert.ok(error, `${what}: nothing refused it`);
  assert.deepEqual([error.code, error.detail], ['P0001', code], `${what}: ${error.message}`);
  const mapped = finMapDbError(error);
  assert.deepEqual([mapped.status, mapped.body, mapped.message], [409, { code }, FIN_SENTENCES[code]], what);
}
// The named constraint refused it, and a route passes it on as `status code`.
function byConstraint(error, constraint, status, code) {
  assert.ok(error, `${constraint}: nothing refused it`);
  assert.equal(error.constraint, constraint, error.message);
  const mapped = finMapDbError(error);
  assert.deepEqual([mapped.status, mapped.body], [status, { code }], constraint);
}

// Posts a voucher of CI by hand in ONE transaction, as any writer could: the voucher, its lines, then its status, so the
// checks deferred to COMMIT judge it there (ruling R3). `lines` are [ledgerId, debit, credit] in rupees. Resolves to
// { id, error }: the voucher's id and null when the COMMIT went through, the raw error when it was refused.
async function postByHand({ type = 'journal', date = '2026-12-31', lines, approved = false, correction = false }) {
  let id = null;
  const error = await committed(async (qc, oc) => {
    const total = lines.reduce((sum, [, debit]) => sum + debit, 0);
    ({ id } = await oc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, is_opening_correction)
                        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [BOOK.CI, type, date, total, correction]));
    for (const [i, [ledgerId, debit, credit]] of lines.entries()) {
      await qc('INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, BOOK.CI, i + 1, ledgerId, debit, credit]);
    }
    const month = await oc('SELECT id FROM fin_periods WHERE book_id = $1 AND start_date <= $2 AND end_date >= $2', [BOOK.CI, date]);
    await qc(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now(),
                     approved_by_id = $4::int, approved_by = CASE WHEN $4::int IS NULL THEN NULL ELSE 'Test MD' END,
                     approved_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() END
               WHERE id = $1`, [id, `HAND-${id}`, month.id, approved ? h.users.md.id : null]);
  });
  return { id: error ? null : id, error };
}
const refusedAtCommit = ({ error }, code, month) => {
  assert.ok(error, 'the COMMIT went through: nothing refused it');
  assert.deepEqual([error.code, error.detail], ['P0001', code], error.message);
  if (month) assert.match(error.message, new RegExp(`^${month} `), error.message);
};
const setMonth = (start, status) => h.db.q('UPDATE fin_periods SET status = $3 WHERE book_id = $1 AND start_date = $2', [BOOK.CI, start, status]);
const allOpen = async () => { for (const start of ['2027-01-01', '2027-02-01', '2027-03-01']) await setMonth(start, 'open'); };

before(async () => {
  if (!ON) return;
  h = await finBootPg('cash-schema');
  for (const b of await h.db.q('SELECT id, code, books_begin FROM fin_books')) {
    assert.equal(b.books_begin, '2027-01-01', `${b.code} begins its books on the real default`);
    BOOK[b.code] = b.id;
  }
  for (const p of await h.db.q('SELECT id, start_date, status FROM fin_periods WHERE book_id = $1', [BOOK.CI])) {
    PERIOD[p.start_date] = p.id;
    if (p.start_date === '2026-12-01') assert.equal(p.status, 'before_books');
  }
  ACME = await ledger('Sundry Debtors', 'Acme Pharma');
  BOLT = await ledger('Sundry Debtors', 'Bolt Labs');
  SALES = await ledger('Sales Accounts', 'Test Sales');
  DISCOUNTS = await ledger('Indirect Expenses', 'Test Discounts');
  CAPITAL = await ledger('Capital Account', 'Test Capital A/c');
  PETTY = await ledger('Cash-in-Hand', 'Test Petty Cash');
  OLD = await ledger('Deposits (Asset)', 'Test Old Deposit');
  await ok(h.call('PUT', `/finance/ledgers/${OLD}`, { active: false }, 'md'));
  // A staff ledger as finEnsureStaffLedgers will make one: system-only, so only HR's postings and the Opening move it (spec §7.2).
  STAFF = await ledger('Loans & Advances (Asset)', 'Test Staff Advances');
  await h.db.q('UPDATE fin_ledgers SET manual_entry = false WHERE id = $1', [STAFF]);
  const system = async name => (await h.db.one('SELECT id, manual_entry FROM fin_ledgers WHERE book_id = $1 AND name = $2', [BOOK.CI, name]));
  CASH = (await system('Cash')).id;
  const pl = await system('Profit & Loss A/c');
  assert.equal(pl.manual_entry, false, 'Profit & Loss A/c is system-only');
  PL = pl.id;

  BILL = await journal([[ACME, 100000, 0], [SALES, 0, 100000]]);          // Acme owes ₹1,000
  BILL2 = await journal([[ACME, 40000, 0], [SALES, 0, 40000]]);           // and ₹400 more
  PAID = await journal([[DISCOUNTS, 60000, 0], [ACME, 0, 60000]]);        // ₹600 settles some of it
  PAID2 = await journal([[DISCOUNTS, 60000, 0], [ACME, 0, 60000]]);       // and another ₹600
  BOLT_BILL = await journal([[BOLT, 50000, 0], [SALES, 0, 50000]]);
  DRAFT = await withLines(await drafted([[ACME, 30000, 0], [SALES, 0, 30000]]));
  GONE = await journal([[ACME, 20000, 0], [SALES, 0, 20000]]);
  const reversal = (await ok(h.call('POST', `/finance/vouchers/${GONE.id}/reverse`, { date: '2027-01-13', reason: 'raised twice' }, 'md'))).voucher;
  assert.equal(reversal.status, 'posted');
  GONE_REV = await withLines(reversal);
  assert.deepEqual((await h.db.q('SELECT ledger_id, credit FROM fin_voucher_lines WHERE id = $1', [GONE_REV.line[1]]))
    .map(l => [l.ledger_id, l.credit]), [[ACME, 200]], 'the reversal\'s first line is Acme\'s credit, mirrored');
});

after(async () => { await h?.close(); });

// ── The schema ───────────────────────────────────────────────────────────────────────────────────────────────────

test('the eight tables, their keys, RLS and the three allocation triggers are in place, and the posting check is the widened one', gate, async () => {
  const fin = (await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'fin\\_%' ORDER BY 1`)).map(r => r.tablename);
  assert.equal(fin.length, 21);
  for (const t of NEW_TABLES) assert.ok(fin.includes(t), t);
  const rls = await h.db.q(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relrowsecurity AND relname = ANY($1) ORDER BY 1`,
    [NEW_TABLES]);
  assert.deepEqual(rls.map(r => r.relname), NEW_TABLES, 'row-level security on every new table');

  const cols = await h.db.q(`SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = 'public'
       AND ((table_name = 'fin_ledgers' AND column_name IN ('holder_name', 'float_amount'))
         OR (table_name = 'fin_vouchers' AND column_name IN ('allocation_plan', 'is_opening_correction'))
         OR (table_name = 'fin_book_settings' AND column_name = 'hr_drift_cursor'))
     ORDER BY 1, 2`);
  assert.deepEqual(cols.map(c => [c.table_name, c.column_name, c.data_type, c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default]), [
    ['fin_book_settings', 'hr_drift_cursor', 'integer', 32, 0, 'YES', null],
    ['fin_ledgers', 'float_amount', 'numeric', 18, 2, 'YES', null],
    ['fin_ledgers', 'holder_name', 'text', null, null, 'YES', null],
    ['fin_vouchers', 'allocation_plan', 'jsonb', null, null, 'YES', null],
    ['fin_vouchers', 'is_opening_correction', 'boolean', null, null, 'NO', 'false'],
  ]);

  const cons = Object.fromEntries((await h.db.q(`SELECT conname, contype::text AS type, conrelid::regclass::text AS tbl,
      pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text LIKE 'fin\\_%'`)).map(r => [r.conname, r]));
  for (const [name, type, tbl, def] of [
    ['fin_ledgers_float_needs_holder', 'c', 'fin_ledgers'],
    ['fin_vouchers_correction_is_journal', 'c', 'fin_vouchers'],
    ['fin_allocations_ledger_book_fk', 'f', 'fin_allocations', 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)'],
    ['fin_allocations_debit_line_id_fkey', 'f', 'fin_allocations', 'FOREIGN KEY (debit_line_id) REFERENCES fin_voucher_lines(id)'],
    ['fin_allocations_credit_line_id_fkey', 'f', 'fin_allocations', 'FOREIGN KEY (credit_line_id) REFERENCES fin_voucher_lines(id)'],
    ['fin_allocations_book_id_fkey', 'f', 'fin_allocations', 'FOREIGN KEY (book_id) REFERENCES fin_books(id)'],
    ['fin_allocations_debit_line_id_credit_line_id_key', 'u', 'fin_allocations', 'UNIQUE (debit_line_id, credit_line_id)'],
    ['fin_allocations_amount_check', 'c', 'fin_allocations'],
    ['fin_allocations_mode_check', 'c', 'fin_allocations'],
    ['fin_cash_counts_ledger_book_fk', 'f', 'fin_cash_counts', 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)'],
    ['fin_cash_counts_cleared_voucher_id_fkey', 'f', 'fin_cash_counts', 'FOREIGN KEY (cleared_voucher_id) REFERENCES fin_vouchers(id)'],
    ['fin_cash_counts_count_date_check', 'c', 'fin_cash_counts'],
    ['fin_cash_counts_counted_check', 'c', 'fin_cash_counts'],
    ['fin_ledger_roles_ledger_book_fk', 'f', 'fin_ledger_roles', 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)'],
    ['fin_ledger_roles_book_id_role_key', 'u', 'fin_ledger_roles', 'UNIQUE (book_id, role)'],
    ['fin_ledger_roles_role_check', 'c', 'fin_ledger_roles'],
    ['fin_hr_channels_pkey', 'p', 'fin_hr_channels', 'PRIMARY KEY (channel_code)'],
    ['fin_hr_channels_ledger_book_fk', 'f', 'fin_hr_channels', 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)'],
    ['fin_hr_expense_map_ledger_book_fk', 'f', 'fin_hr_expense_map', 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)'],
    ['fin_hr_expense_map_book_id_hr_key_key', 'u', 'fin_hr_expense_map', 'UNIQUE (book_id, hr_key)'],
    ['fin_hr_expense_map_hr_key_check', 'c', 'fin_hr_expense_map'],
    ['fin_book_settings_pkey', 'p', 'fin_book_settings', 'PRIMARY KEY (book_id)'],
    ['fin_book_settings_book_id_fkey', 'f', 'fin_book_settings', 'FOREIGN KEY (book_id) REFERENCES fin_books(id)'],
    ['fin_book_settings_payroll_booking_check', 'c', 'fin_book_settings'],
    ['fin_hr_exceptions_source_type_source_id_key', 'u', 'fin_hr_exceptions', 'UNIQUE (source_type, source_id)'],
    ['fin_hr_exceptions_voucher_id_fkey', 'f', 'fin_hr_exceptions', 'FOREIGN KEY (voucher_id) REFERENCES fin_vouchers(id)'],
    ['fin_hr_covers_voucher_id_fkey', 'f', 'fin_hr_covers', 'FOREIGN KEY (voucher_id) REFERENCES fin_vouchers(id)'],
    ['fin_hr_covers_voucher_id_source_type_source_id_key', 'u', 'fin_hr_covers', 'UNIQUE (voucher_id, source_type, source_id)'],
  ]) {
    assert.deepEqual([cons[name]?.type, cons[name]?.tbl], [type, tbl], name);
    if (def) assert.equal(cons[name].def, def, name);
  }
  assert.match(cons.fin_approval_rules_rule_key_check.def, /'cash_difference'::text/, 'the rule-key CHECK takes cash_difference');

  // The rule the controller set for this migration: every constraint it adds has a Finance code. A CHECK, a UNIQUE or a
  // natural primary key is a Finance refusal, never the fixed 500, and a ledger written across books is FIN_WRONG_BOOK.
  // Left out: an identity primary key, which never collides, and a single-column foreign key, which the hard stops or the
  // server get right before it could break on a write, and which says FIN_IN_USE on a delete, by its wording, whatever its name.
  const added = await h.db.q(`SELECT c.conname, c.contype::text AS type, cardinality(c.conkey) AS width,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attidentity <> '') AS on_identity
      FROM pg_constraint c
     WHERE c.conrelid::regclass::text = ANY($1) OR c.conname IN ('fin_ledgers_float_needs_holder', 'fin_vouchers_correction_is_journal')`, [NEW_TABLES]);
  assert.ok(added.length >= 30, `non-vacuous: ${added.length} constraints`);
  const pgError = (code, constraint, message) => Object.assign(new Error(message), { code, constraint });
  for (const c of added) {
    if (c.type === 't' || c.type === 'n') continue;     // the constraint trigger's own row, and NOT NULLs: no name a write breaks with
    if (c.type === 'p' && c.on_identity) continue;
    if (c.type === 'f' && c.width === 1) {
      const deleted = finMapDbError(pgError('23503', c.conname, 'update or delete on table "x" violates foreign key constraint'));
      assert.deepEqual(deleted.body, { code: 'FIN_IN_USE' }, c.conname);
      continue;
    }
    const e = c.type === 'c' ? pgError('23514', c.conname, 'new row violates check constraint')
      : c.type === 'f' ? pgError('23503', c.conname, 'insert or update on table "x" violates foreign key constraint')
        : pgError('23505', c.conname, 'duplicate key value violates unique constraint');
    const mapped = finMapDbError(e);
    assert.notEqual(mapped.status, 500, `${c.conname} has no Finance code: give it one in finance-errors.js`);
    if (c.type === 'f') assert.deepEqual(mapped.body, { code: 'FIN_WRONG_BOOK' }, c.conname);
  }

  const idx = Object.fromEntries((await h.db.q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1)`,
    [NEW_TABLES])).map(r => [r.indexname, r.indexdef.replace(/^CREATE (?:UNIQUE )?INDEX \w+ ON public\.\w+ USING btree /, '')]));
  for (const [name, key] of Object.entries({
    idx_fk_fin_allocations_debit_line_id: '(debit_line_id)',
    idx_fk_fin_allocations_credit_line_id: '(credit_line_id)',
    idx_fk_fin_allocations_ledger_id: '(ledger_id)',
    idx_fin_hr_covers_source: '(source_type, source_id)',
  })) assert.equal(idx[name], key, name);

  const triggers = await h.db.q(`SELECT t.tgname AS name, p.proname AS fn, t.tgconstraint <> 0 AS is_constraint, t.tgdeferrable AS deferrable,
      t.tginitdeferred AS deferred, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND t.tgrelid = 'public.fin_allocations'::regclass ORDER BY 1`);
  assert.deepEqual(triggers.map(t => [t.name, t.fn, t.is_constraint, t.deferrable, t.deferred]), [
    ['fin_allocation_guard', 'fin_allocation_guard', false, false, false],
    ['fin_allocation_sum_check', 'fin_allocation_sum_check', true, true, true],
    ['fin_no_truncate', 'fin_no_truncate', false, false, false],
  ]);
  assert.match(triggers[0].def, /BEFORE INSERT OR UPDATE ON public\.fin_allocations FOR EACH ROW/);
  assert.match(triggers[1].def, /AFTER INSERT OR UPDATE ON public\.fin_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/);
  assert.match(triggers[2].def, /BEFORE TRUNCATE ON public\.fin_allocations FOR EACH STATEMENT/);

  // init() replays the core migration and then this one, so the posting check left in place is the widened one.
  const post = await h.db.one(`SELECT prosrc FROM pg_proc WHERE proname = 'fin_voucher_post_check' AND pronamespace = 'public'::regnamespace`);
  assert.match(post.prosrc, /new\.is_opening_correction/);
});

test('a replay of init() changes nothing, and gives an existing book that lacks them its cash_difference rule and its settings', gate, async () => {
  const shape = () => h.db.q(`
      SELECT 'con' AS k, conrelid::regclass::text AS t, conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text LIKE 'fin\\_%'
      UNION ALL SELECT 'idx', tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'fin\\_%'
      UNION ALL SELECT 'trg', tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'fin\\_%'
      UNION ALL SELECT 'fn', '', proname, md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'fin\\_%'
      UNION ALL SELECT 'col', table_name, column_name, data_type || ' ' || is_nullable || ' ' || COALESCE(column_default, '')
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'fin\\_%'
      ORDER BY 1, 2, 3`);
  const ruleCheck = () => h.db.one(`SELECT oid::int AS oid FROM pg_constraint WHERE conname = 'fin_approval_rules_rule_key_check'`);
  const was = await shape();
  const checkWas = await ruleCheck();
  // The DP book loses its cash_difference rule and its settings row, as a book made before this migration would lack them.
  await h.db.q(`DELETE FROM fin_approval_rules WHERE book_id = $1 AND rule_key = 'cash_difference'`, [BOOK.DP]);
  await h.db.q('DELETE FROM fin_book_settings WHERE book_id = $1', [BOOK.DP]);
  await h.db.init();
  assert.deepEqual(await shape(), was, 'a replay leaves every table, column, constraint, index, trigger and function as it was');
  assert.deepEqual(await ruleCheck(), checkWas, 'the rule-key CHECK is replaced once, and never again on a replay');
  const rule = await h.db.one(`SELECT mode, limit_amount, updated_by FROM fin_approval_rules WHERE book_id = $1 AND rule_key = 'cash_difference'`, [BOOK.DP]);
  assert.deepEqual(rule, { mode: 'always', limit_amount: null, updated_by: 'migration' });
  const settings = await h.db.one('SELECT payroll_booking, updated_by, updated_at FROM fin_book_settings WHERE book_id = $1', [BOOK.DP]);
  assert.deepEqual(settings, { payroll_booking: 'month_end', updated_by: null, updated_at: null });
  // …and a book that has them keeps them as they are: CI's came from the setup that made the book.
  assert.equal((await h.db.one(`SELECT updated_by FROM fin_approval_rules WHERE book_id = $1 AND rule_key = 'cash_difference'`, [BOOK.CI])).updated_by,
    'system (go-live)');
});

// ── Allocations (spec §6.2) ──────────────────────────────────────────────────────────────────────────────────────

test('an allocation between a posted debit and a posted credit of one party ledger is accepted', gate, async () => {
  try {
    const [{ id }] = await h.db.tx(qc => allocate(qc, { debit: BILL.line[1], credit: PAID.line[2], amount: 600, mode: 'auto' }));
    const row = await h.db.one('SELECT * FROM fin_allocations WHERE id = $1', [id]);
    assert.deepEqual([row.book_id, row.ledger_id, row.debit_line_id, row.credit_line_id, row.amount, row.mode, row.made_by_id, row.made_by],
      [BOOK.CI, ACME, BILL.line[1], PAID.line[2], 600, 'auto', h.users.md.id, 'Test MD']);
    assert.ok(row.made_at instanceof Date);
    // The rest of the bill from the other credit: a line takes allocations up to exactly what it holds.
    await h.db.tx(qc => allocate(qc, { debit: BILL.line[1], credit: PAID2.line[2], amount: 400 }));
    assert.equal(await allocated(BILL.line[1]), 1000);
    // An allocation may be changed, and is judged again as it is changed.
    await h.db.tx(qc => qc('UPDATE fin_allocations SET amount = 500 WHERE id = $1', [id]));
    assert.equal(await allocated(BILL.line[1]), 900);
    // Two lines of one voucher may be paired too (a journal that moves money between a party's bills).
    const move = await journal([[ACME, 7000, 0], [ACME, 0, 7000]]);
    await h.db.tx(qc => allocate(qc, { debit: move.line[1], credit: move.line[2], amount: 70 }));
    // The way the allocation engine writes one: in the transaction that posts the entry, after its status (spec §6.6). A
    // posting refused at COMMIT takes its allocations with it.
    await h.db.tx(async (qc, oc) => allocate(qc, { debit: BILL2.line[1], credit: await postedCreditIn(qc, oc, 100, 100), amount: 100 }));
    assert.equal(await allocated(BILL2.line[1]), 100);
    byTrigger(await committed(async (qc, oc) => allocate(qc, { debit: BILL2.line[1], credit: await postedCreditIn(qc, oc, 100, 90), amount: 90 })),
      'FIN_UNBALANCED', 'a posting refused at COMMIT');
    assert.equal(await allocated(BILL2.line[1]), 100, 'and the allocation made with it went too');
  } finally {
    await clearAllocations();
  }
});

test('an allocation onto a draft, a reversed voucher, two debits, or lines of two ledgers is refused with FIN_BAD_ALLOCATION', gate, async () => {
  const pair = { debit: BILL.line[1], credit: PAID.line[2], amount: 100 };
  for (const [what, write] of [
    ['a draft\'s line', { ...pair, debit: DRAFT.line[1] }],
    ['a reversed voucher\'s line', { ...pair, debit: GONE.line[1] }],
    ['a plain reversal\'s line (depth 1, ruling R9)', { ...pair, credit: GONE_REV.line[1] }],
    ['two debits', { ...pair, credit: BILL2.line[1] }],
    ['two credits', { ...pair, debit: PAID2.line[2] }],
    ['the sides the wrong way round', { ...pair, debit: PAID.line[2], credit: BILL.line[1] }],
    ['lines of two ledgers', { ...pair, debit: BOLT_BILL.line[1] }],
    ['lines of two ledgers, named by the other', { ...pair, debit: BOLT_BILL.line[1], ledger: BOLT }],
    ['a ledger neither line is on', { ...pair, ledger: BOLT }],
    ['the lines\' ledger, in another book', { ...pair, book: BOOK.DP }],
    ['a line that is not there', { ...pair, debit: 999999 }],
  ]) {
    byTrigger(await refusedAtStatement(qc => allocate(qc, write)), 'FIN_BAD_ALLOCATION', what);
  }
  // An allocation that was right is judged again when it is changed.
  try {
    const [{ id }] = await h.db.tx(qc => allocate(qc, pair));
    byTrigger(await refusedAtStatement(qc => qc('UPDATE fin_allocations SET debit_line_id = $2 WHERE id = $1', [id, DRAFT.line[1]])),
      'FIN_BAD_ALLOCATION', 'changed onto a draft');
    byTrigger(await refusedAtStatement(qc => qc('UPDATE fin_allocations SET credit_line_id = $2 WHERE id = $1', [id, GONE_REV.line[1]])),
      'FIN_BAD_ALLOCATION', 'changed onto a reversal');
    assert.equal(await allocated(BILL.line[1]), 100, 'the refusals changed nothing');
  } finally {
    await clearAllocations();
  }
});

// Ruling R9. A reversal of a reversal puts its entry back in the books, so the voucher that does it is live: at depth 2 in its
// reversal chain (the entry 0, its reversal 1), not reversed. Its lines take allocations; a plain reversal's (depth 1) never do, nor
// any voucher of the chain once it is reversed; and a reversal of the restoring one (depth 3) is a plain reversal again. The guard
// finds the depth by walking reversal_of_id, without a lock.
test('R9: an allocation onto a reversal of a reversal (depth 2) is accepted; onto a plain reversal (depth 1), or a reversed voucher of its chain, it is refused FIN_BAD_ALLOCATION', gate, async () => {
  const back = await journal([[ACME, 30000, 0], [SALES, 0, 30000]], '2027-01-14');                       // Acme owes ₹300
  const reverse = async (v, reason) =>
    withLines((await ok(h.call('POST', `/finance/vouchers/${v.id}/reverse`, { date: '2027-01-14', reason }, 'md'))).voucher);
  const rev = await reverse(back, 'raised twice');                    // depth 1: Acme's ₹300 credited back
  const rev2 = await reverse(rev, 'it was right');                    // depth 2: and owed again
  assert.deepEqual((await h.db.q('SELECT ledger_id, debit FROM fin_voucher_lines WHERE id = $1', [rev2.line[1]])).map(l => [l.ledger_id, l.debit]),
    [[ACME, 300]], 'the restoring reversal\'s first line is Acme\'s debit, as the entry\'s was');
  try {
    await h.db.tx(qc => allocate(qc, { debit: rev2.line[1], credit: PAID.line[2], amount: 300 }));
    assert.equal(await allocated(rev2.line[1]), 300, 'depth 2 is live: accepted');
    for (const [what, write] of [
      ['a plain reversal, not reversed (depth 1)', { debit: BILL.line[1], credit: GONE_REV.line[1], amount: 100 }],
      ['a reversal that has been reversed (depth 1)', { debit: BILL.line[1], credit: rev.line[1], amount: 100 }],
      ['the entry the chain began with, reversed (depth 0)', { debit: back.line[1], credit: PAID2.line[2], amount: 100 }],
    ]) byTrigger(await refusedAtStatement(qc => allocate(qc, write)), 'FIN_BAD_ALLOCATION', what);
    // Reversing the restoring one releases what it held, and the chain is dead again: depth 2 reversed, depth 3 a plain reversal.
    const rev3 = await reverse(rev2, 'raised twice after all');
    assert.equal(await allocated(rev2.line[1]), 0, 'the reversal released the allocation on the restoring entry');
    for (const [what, write] of [
      ['a reversal of a reversal that has been reversed (depth 2)', { debit: rev2.line[1], credit: PAID.line[2], amount: 100 }],
      ['a reversal of that (depth 3)', { debit: BILL.line[1], credit: rev3.line[1], amount: 100 }],
    ]) byTrigger(await refusedAtStatement(qc => allocate(qc, write)), 'FIN_BAD_ALLOCATION', what);
  } finally {
    await clearAllocations();
  }
});

test('allocations totalling more than a line holds are refused at COMMIT with FIN_OVER_ALLOCATED', gate, async () => {
  try {
    // ₹600 and ₹600 against a bill of ₹1,000: both statements go through, and the COMMIT refuses them.
    let wrote = 0;
    byTrigger(await committed(async qc => {
      await allocate(qc, { debit: BILL.line[1], credit: PAID.line[2], amount: 600 });
      await allocate(qc, { debit: BILL.line[1], credit: PAID2.line[2], amount: 600 });
      wrote = 2;
    }), 'FIN_OVER_ALLOCATED', 'a debit over-allocated in one transaction');
    assert.equal(wrote, 2, 'the check waits for COMMIT: both statements went through');
    assert.equal(await allocated(BILL.line[1]), 0, 'and the refused COMMIT kept nothing');
    // A credit of ₹600 put against ₹700 of bills.
    byTrigger(await committed(qc => allocate(qc, { debit: BILL.line[1], credit: PAID.line[2], amount: 700 })),
      'FIN_OVER_ALLOCATED', 'a credit over-allocated');
    // Judged as the transaction leaves it: too much at first, put right before COMMIT, goes through.
    assert.equal(await committed(async qc => {
      const [{ id }] = await allocate(qc, { debit: BILL.line[1], credit: PAID.line[2], amount: 700 });
      await qc('UPDATE fin_allocations SET amount = 600 WHERE id = $1', [id]);
    }), null);
    // Across transactions: the ₹600 that stands counts against what comes after it, on either side.
    byTrigger(await committed(qc => allocate(qc, { debit: BILL.line[1], credit: PAID2.line[2], amount: 500 })),
      'FIN_OVER_ALLOCATED', 'the bill, over by ₹100');
    assert.equal(await committed(qc => allocate(qc, { debit: BILL.line[1], credit: PAID2.line[2], amount: 400 })), null);
    byTrigger(await committed(qc => allocate(qc, { debit: BILL2.line[1], credit: PAID2.line[2], amount: 300 })),
      'FIN_OVER_ALLOCATED', 'the credit, over by ₹100');
    assert.equal(await committed(qc => allocate(qc, { debit: BILL2.line[1], credit: PAID2.line[2], amount: 200 })), null);
    assert.deepEqual([await allocated(BILL.line[1]), await allocated(PAID2.line[2])], [1000, 600]);
    // A changed amount is judged too.
    byTrigger(await committed(qc => qc('UPDATE fin_allocations SET amount = 250 WHERE debit_line_id = $1', [BILL2.line[1]])),
      'FIN_OVER_ALLOCATED', 'an allocation raised past its credit');
  } finally {
    await clearAllocations();
  }
});

// The amount: more than nothing, never NaN, and an allocation is Auto's or Pick's.
test('an allocation\'s amount is more than zero and never NaN, and its mode is auto or pick', gate, async () => {
  const pair = { debit: BILL.line[1], credit: PAID.line[2] };
  for (const amount of [0, -5, 'NaN']) {
    byConstraint(await refusedAtStatement(qc => allocate(qc, { ...pair, amount })), 'fin_allocations_amount_check', 400, 'FIN_BAD_AMOUNT');
  }
  byConstraint(await refusedAtStatement(qc => allocate(qc, { ...pair, amount: 5, mode: 'manual' })), 'fin_allocations_mode_check', 400, 'FIN_BAD_INPUT');
  byConstraint(await refusedAtStatement(async qc => { await allocate(qc, { ...pair, amount: 5 }); await allocate(qc, { ...pair, amount: 5 }); }),
    'fin_allocations_debit_line_id_credit_line_id_key', 409, 'FIN_BAD_ALLOCATION');
});

// H10 for allocations: they change no balance, but they are which bills are open, so nothing empties them either.
test('TRUNCATE fin_allocations is refused FIN_NO_TRUNCATE', gate, async () => {
  try {
    await h.db.tx(qc => allocate(qc, { debit: BILL.line[1], credit: PAID.line[2], amount: 100 }));
    for (const sql of ['TRUNCATE fin_allocations', 'TRUNCATE fin_allocations CASCADE', 'TRUNCATE fin_allocations, fin_voucher_lines']) {
      byTrigger(await refusedAtStatement(qc => qc(sql)), 'FIN_NO_TRUNCATE', sql);
    }
    assert.equal(await allocated(BILL.line[1]), 100, 'the allocation is still there');
  } finally {
    await clearAllocations();
  }
});

// Two connections of their own: the pool has one client, and one side of each race must hold its transaction open.
// pg_stat_activity shows the other side waiting on a lock, so the test proves a wait, not merely a slow write.
const connected = async () => { const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); return client; };
const pidOf = async client => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
// Resolves once backend `pid` waits on a lock. `settled()` is what its statement came to, which must still be nothing.
async function waitsOnLock(pid, settled) {
  for (let i = 0; ; i++) {
    assert.equal(settled(), null, `it did not wait: ${settled()?.error?.message ?? 'it went through'}`);
    const r = await h.db.one('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (r?.wait_event_type === 'Lock') return;
    assert.ok(i < 200, 'it never waited on a lock');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function race(holderWork, writerWork, check) {
  const holder = await connected();
  const writer = await connected();
  try {
    await holder.query('BEGIN');
    await holderWork(holder);
    await writer.query('BEGIN');
    const pid = await pidOf(writer);
    let settled = null;
    const write = writerWork(writer).then(value => { settled = { value }; }, error => { settled = { error }; });
    await waitsOnLock(pid, () => settled);
    await holder.query('COMMIT');
    await write;
    await check(settled);
    await writer.query('ROLLBACK');
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await writer.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([holder.end(), writer.end()]);
  }
}
const allocateOn = (client, { debit, credit, amount }) => client.query(
  `INSERT INTO fin_allocations (book_id, ledger_id, debit_line_id, credit_line_id, amount, mode) VALUES ($1, $2, $3, $4, $5, 'pick')`,
  [BOOK.CI, ACME, debit, credit, amount]);

test('two transactions putting money on one bill at the same moment never settle more than it holds', gate, async () => {
  try {
    // Each runs its COMMIT-time check early (SET CONSTRAINTS ALL IMMEDIATE) and holds its transaction open. The second
    // waits for the first to finish, then counts what the first allocated: ₹600 and ₹600 against a bill of ₹1,000.
    await race(
      async holder => {
        await allocateOn(holder, { debit: BILL.line[1], credit: PAID.line[2], amount: 600 });
        await holder.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      async writer => {
        await allocateOn(writer, { debit: BILL.line[1], credit: PAID2.line[2], amount: 600 });
        await writer.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      settled => byTrigger(settled.error, 'FIN_OVER_ALLOCATED', 'the second'));
    assert.equal(await allocated(BILL.line[1]), 600, 'the bill holds ₹1,000 and is settled ₹600');
  } finally {
    await clearAllocations();
  }
});

// The party-lock protocol (ruling R7): concurrency between allocations and reversals is kept by the party lock, which the
// app takes, and not by any row lock in the triggers. Each side here takes it as the app will, by hand. A reversal is
// posted as finReverseVoucher and finPostLocked post one: the bill locked FOR UPDATE first, then (finPostLocked's first
// statement) the party lock of every party ledger on its own lines, the reversal posted and the bill marked, and only then
// the bill's allocations released.
const PARTY_LOCK = 'SELECT pg_advisory_xact_lock(7300, $1)';     // FIN_ALLOC_LOCK_NS 7300, the party ledger's id
async function reverseUnderPartyLock(client, bill) {
  await client.query('SELECT id FROM fin_vouchers WHERE id = $1 FOR UPDATE', [bill.id]);
  await client.query(PARTY_LOCK, [ACME]);
  const lines = (await client.query('SELECT ledger_id, debit, credit FROM fin_voucher_lines WHERE voucher_id = $1 ORDER BY line_no', [bill.id])).rows;
  const r = (await client.query(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, total, reversal_of_id)
                                 VALUES ($1, 'journal', '2027-01-14', $2, $3) RETURNING id`, [BOOK.CI, lines.reduce((sum, l) => sum + l.debit, 0), bill.id])).rows[0];
  for (const [i, l] of lines.entries()) {
    await client.query('INSERT INTO fin_voucher_lines (voucher_id, book_id, line_no, ledger_id, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)',
      [r.id, BOOK.CI, i + 1, l.ledger_id, l.credit, l.debit]);
  }
  await client.query(`UPDATE fin_vouchers SET status = 'posted', number = $2, period_id = $3, posted_at = now() WHERE id = $1`,
    [r.id, `RACE-${r.id}`, PERIOD['2027-01-01']]);
  await client.query('UPDATE fin_vouchers SET reversed_by_id = $1 WHERE id = $2', [r.id, bill.id]);
  const released = await client.query(`DELETE FROM fin_allocations a USING fin_voucher_lines l
    WHERE l.voucher_id = $1 AND (a.debit_line_id = l.id OR a.credit_line_id = l.id)`, [bill.id]);
  return released.rowCount;
}
const isReversed = async bill => (await h.db.one('SELECT reversed_by_id FROM fin_vouchers WHERE id = $1', [bill.id])).reversed_by_id != null;

test('R7: an allocation onto a bill being reversed waits at the party lock, then is refused: the later one sees the reversal', gate, async () => {
  const bill = await journal([[ACME, 15000, 0], [SALES, 0, 15000]]);
  try {
    await race(
      holder => reverseUnderPartyLock(holder, bill),
      async writer => {
        await writer.query(PARTY_LOCK, [ACME]);
        await allocateOn(writer, { debit: bill.line[1], credit: PAID.line[2], amount: 100 });
      },
      settled => byTrigger(settled.error, 'FIN_BAD_ALLOCATION', 'onto the bill reversed while it waited'));
    assert.ok(await isReversed(bill), 'the bill is reversed');
    assert.equal(await allocated(bill.line[1]), 0, 'and nothing is allocated to it');
  } finally {
    await clearAllocations();
  }
});

// The cycle ruling R7 removes. The reversal holds its bill FOR UPDATE and waits for the party lock, which a receipt or a redo
// holds while it writes an allocation onto that bill. Had the guard locked the bill, each would wait for the other (40P01).
// It reads without locking: the allocation goes through, and the reversal, once it has the party lock, releases it.
test('R7: a reversal holding its bill FOR UPDATE and waiting for the party lock does not deadlock with an allocation onto that bill', gate, async () => {
  const bill = await journal([[ACME, 15000, 0], [SALES, 0, 15000]]);
  const allocator = await connected();
  const reverser = await connected();
  try {
    await allocator.query('BEGIN');
    await allocator.query(PARTY_LOCK, [ACME]);
    await reverser.query('BEGIN');
    const pid = await pidOf(reverser);
    let reversed = null;
    const reversal = reverseUnderPartyLock(reverser, bill)
      .then(async released => { await reverser.query('COMMIT'); reversed = { released }; }, error => { reversed = { error }; });
    await waitsOnLock(pid, () => reversed);                // the reverser holds the bill and waits for Acme's party lock
    await allocateOn(allocator, { debit: bill.line[1], credit: PAID.line[2], amount: 100 });
    await allocator.query('COMMIT');
    await reversal;
    assert.equal(reversed.error?.message, undefined, 'the reversal went through');
    assert.equal(reversed.released, 1, 'and released the allocation committed while it waited');
    assert.ok(await isReversed(bill), 'the bill is reversed');
    assert.equal(await allocated(bill.line[1]), 0, 'and no allocation survives on it');
    assert.equal(await allocated(PAID.line[2]), 0, 'the credit is on account again');
  } finally {
    await allocator.query('ROLLBACK').catch(() => {});
    await reverser.query('ROLLBACK').catch(() => {});
    await Promise.allSettled([allocator.end(), reverser.end()]);
    await clearAllocations();
  }
});

// ── Opening corrections (spec §9.4) ──────────────────────────────────────────────────────────────────────────────

test('an opening correction posts in before_books when dated the opening day and approved; dated any other day it is refused FIN_BEFORE_BOOKS; with Jan 2027 locked it is refused FIN_PERIOD_LOCKED', gate, async () => {
  const opening = await postByHand({ type: 'opening', lines: [[CASH, 500, 0], [CAPITAL, 0, 500]], approved: true });
  assert.equal(opening.error, null, 'the Opening it corrects');
  const lines = [[CASH, 100, 0], [CAPITAL, 0, 100]];
  const posted = await postByHand({ lines, approved: true, correction: true });
  assert.equal(posted.error, null, 'approved and dated 31 Dec 2026, the day before the books begin: it posts');
  const row = await h.db.one('SELECT voucher_type, voucher_date, status, is_opening_correction FROM fin_vouchers WHERE id = $1', [posted.id]);
  assert.deepEqual(row, { voucher_type: 'journal', voucher_date: '2026-12-31', status: 'posted', is_opening_correction: true });
  // Any other day before the books begin, or no approval, and it is refused as any other entry dated there is.
  for (const date of ['2026-12-30', '2026-12-01', '2026-04-01']) refusedAtCommit(await postByHand({ date, lines, approved: true, correction: true }), 'FIN_BEFORE_BOOKS');
  refusedAtCommit(await postByHand({ lines, correction: true }), 'FIN_BEFORE_BOOKS');
  // The months after it, as for the Opening (rulings R70, R73): any locked one refuses it, the first by date named.
  try {
    await setMonth('2027-01-01', 'locked');
    refusedAtCommit(await postByHand({ lines, approved: true, correction: true }), 'FIN_PERIOD_LOCKED', 'Jan 2027');
    await setMonth('2027-01-01', 'open');
    await setMonth('2027-03-01', 'locked');
    refusedAtCommit(await postByHand({ lines, approved: true, correction: true }), 'FIN_PERIOD_LOCKED', 'Mar 2027');
    // A closing one asks for an approval, which a correction always carries.
    await setMonth('2027-03-01', 'open');
    await setMonth('2027-01-01', 'closing');
    assert.equal((await postByHand({ lines, approved: true, correction: true })).error, null);
  } finally {
    await allOpen();
  }
});

test('a plain journal in before_books is still refused FIN_BEFORE_BOOKS', gate, async () => {
  const lines = [[CASH, 100, 0], [CAPITAL, 0, 100]];
  refusedAtCommit(await postByHand({ lines, approved: true }), 'FIN_BEFORE_BOOKS');                     // the opening day, approved
  refusedAtCommit(await postByHand({ lines, approved: true, date: '2026-12-15' }), 'FIN_BEFORE_BOOKS');
  refusedAtCommit(await postByHand({ lines }), 'FIN_BEFORE_BOOKS');
});

test('H6: an opening correction may use a system-only ledger, as the Opening may; an inactive one it may not', gate, async () => {
  assert.equal((await postByHand({ lines: [[CASH, 50, 0], [PL, 0, 50]], approved: true, correction: true })).error, null);
  refusedAtCommit(await postByHand({ date: '2027-01-20', lines: [[CASH, 50, 0], [PL, 0, 50]], approved: true }), 'FIN_SYSTEM_LEDGER');
  refusedAtCommit(await postByHand({ lines: [[OLD, 50, 0], [CASH, 0, 50]], approved: true, correction: true }), 'FIN_LEDGER_INACTIVE');
});

// The pre-review fix: the exemptions a correction shares with the Opening hold on the opening day only. Without the date rule a
// journal flagged as a correction, dated in an open month, would take H6's exemption and move a ledger only HR's postings may.
test('a journal flagged as an opening correction but dated 2027-02-10 is refused, even on an open month, and cannot touch a system-only ledger', gate, async () => {
  const flagged = (lines, extra = {}) => ({ date: '2027-02-10', lines, approved: true, correction: true, ...extra });
  const onStaff = [[STAFF, 40, 0], [CASH, 0, 40]];
  // February is open: the same entry posts there unflagged, and flagged it is refused for its date.
  assert.equal((await postByHand(flagged([[CASH, 40, 0], [CAPITAL, 0, 40]], { correction: false }))).error, null);
  byTrigger((await postByHand(flagged([[CASH, 40, 0], [CAPITAL, 0, 40]]))).error, 'FIN_BAD_CORRECTION', 'open February');
  // The system-only staff ledger refuses a plain journal, and the flag is no way round it.
  refusedAtCommit(await postByHand(flagged(onStaff, { correction: false })), 'FIN_SYSTEM_LEDGER');
  byTrigger((await postByHand(flagged(onStaff))).error, 'FIN_BAD_CORRECTION', 'onto the staff ledger');
  byTrigger((await postByHand(flagged(onStaff, { approved: false }))).error, 'FIN_BAD_CORRECTION', 'unapproved');
  // In every status of the month: closing and locked as well as open.
  try {
    for (const status of ['closing', 'locked']) {
      await setMonth('2027-02-01', status);
      byTrigger((await postByHand(flagged(onStaff))).error, 'FIN_BAD_CORRECTION', `February ${status}`);
    }
  } finally {
    await allOpen();
  }
  assert.equal((await h.db.one('SELECT COUNT(*)::int AS n FROM fin_voucher_lines WHERE ledger_id = $1', [STAFF])).n, 0,
    'nothing reached the staff ledger');
  // On the opening day itself the correction takes the staff ledger, as the Opening may (H6).
  assert.equal((await postByHand({ lines: onStaff, approved: true, correction: true })).error, null);
});

test('an opening correction is a journal, refused by fin_vouchers_correction_is_journal otherwise', gate, async () => {
  for (const voucher_type of ['receipt', 'payment', 'contra', 'opening', 'sales']) {
    byConstraint(await refusedAtStatement(qc => qc(`INSERT INTO fin_vouchers (book_id, voucher_type, voucher_date, is_opening_correction)
      VALUES ($1, $2, '2026-12-31', true)`, [BOOK.CI, voucher_type])), 'fin_vouchers_correction_is_journal', 400, 'FIN_BAD_INPUT');
  }
});

// ── The rule, the settings, the holders, the HR columns ──────────────────────────────────────────────────────────

test('cash_difference is \'always\' in both books, and fin_book_settings holds month_end for both', gate, async () => {
  const rules = await h.db.q(`SELECT b.code, r.mode, r.limit_amount FROM fin_approval_rules r JOIN fin_books b ON b.id = r.book_id
    WHERE r.rule_key = 'cash_difference' ORDER BY b.code`);
  assert.deepEqual(rules.map(r => [r.code, r.mode, r.limit_amount]), [['CI', 'always', null], ['DP', 'always', null]]);
  const settings = await h.db.q('SELECT b.code, s.payroll_booking FROM fin_book_settings s JOIN fin_books b ON b.id = s.book_id ORDER BY b.code');
  assert.deepEqual(settings.map(s => [s.code, s.payroll_booking]), [['CI', 'month_end'], ['DP', 'month_end']]);
  // The widened CHECK still refuses a rule nobody named, and the setting takes the two ways the spec names.
  const unnamed = await refusedAtStatement(qc => qc(`INSERT INTO fin_approval_rules (book_id, rule_key, mode) VALUES ($1, 'cash_float', 'always')`, [BOOK.CI]));
  assert.equal(unnamed.constraint, 'fin_approval_rules_rule_key_check', unnamed.message);
  byConstraint(await refusedAtStatement(qc => qc(`UPDATE fin_book_settings SET payroll_booking = 'weekly' WHERE book_id = $1`, [BOOK.CI])),
    'fin_book_settings_payroll_booking_check', 400, 'FIN_BAD_INPUT');
  assert.equal(await committed(qc => qc(`UPDATE fin_book_settings SET payroll_booking = 'when_paid' WHERE book_id = $1`, [BOOK.CI])), null);
  await h.db.q(`UPDATE fin_book_settings SET payroll_booking = 'month_end' WHERE book_id = $1`, [BOOK.CI]);
});

test('a float without a holder name is refused by fin_ledgers_float_needs_holder', gate, async () => {
  const set = (holder, float) => qc => qc('UPDATE fin_ledgers SET holder_name = $2, float_amount = $3 WHERE id = $1', [PETTY, holder, float]);
  byConstraint(await refusedAtStatement(set(null, 5000)), 'fin_ledgers_float_needs_holder', 400, 'FIN_BAD_INPUT');
  for (const float of [-1, 'NaN']) byConstraint(await refusedAtStatement(set('Holder A', float)), 'fin_ledgers_float_needs_holder', 400, 'FIN_BAD_INPUT');
  for (const [holder, float] of [['Holder A', 5000], ['Holder A', 0], ['Holder A', null], [null, null]]) {
    assert.equal(await committed(set(holder, float)), null, `${holder} ${float}`);
  }
});

test('the four HR columns exist, nullable text', gate, async () => {
  const cols = await h.db.q(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'hr' AND (table_name, column_name) IN
      (('advance_txns', 'paid_via'), ('loan_txns', 'paid_via'), ('payment_batches', 'paid_from'), ('run_lines', 'paid_from'))
    ORDER BY 1`);
  assert.deepEqual(cols.map(c => [c.table_name, c.column_name, c.data_type, c.is_nullable]), [
    ['advance_txns', 'paid_via', 'text', 'YES'],
    ['loan_txns', 'paid_via', 'text', 'YES'],
    ['payment_batches', 'paid_from', 'text', 'YES'],
    ['run_lines', 'paid_from', 'text', 'YES'],
  ]);
});
