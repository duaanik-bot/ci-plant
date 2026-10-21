import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finBootPg } from './finance-pg-harness.js';

// Opt-in: boots its own throwaway Postgres.
//   cd server && FINANCE_PG=1 node --test src/finance-pg-schema.test.js
const gate = { skip: process.env.FINANCE_PG === '1' ? false : 'set FINANCE_PG=1' };

test('init() builds every fin_ table, and replaying the migration changes nothing', gate, async () => {
  const h = await finBootPg('schema', { setup: false });
  try {
    const tables = (await h.db.q(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fin\\_%' ORDER BY 1`)).map(r => r.tablename);
    assert.equal(tables.length, 13);
    const snap = () => h.db.q(`SELECT table_name, column_name, data_type FROM information_schema.columns
                               WHERE table_schema='public' ORDER BY 1, 2`);
    const before = await snap();
    await h.db.init();
    assert.deepEqual(await snap(), before);
  } finally { await h.close(); }
});

// The names below are the ones later tasks map errors on (finMapDbError, the H1-H10 tests). Each must exist,
// and each constraint must do what spec section 6 says. No test here posts a voucher: the hard-stop triggers
// added later check a posted voucher's lines, and this file is about the tables.
test('the constraints and indexes later tasks map errors on exist, and mean what the spec says', gate, async () => {
  const h = await finBootPg('contract', { setup: false });
  try {
    const q = (sql, params) => h.db.q(sql, params);

    // The migration loads no data.
    const tables = (await q(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'fin\\_%'`)).map(r => r.tablename);
    for (const t of tables) assert.equal((await h.db.one(`SELECT COUNT(*)::int AS n FROM ${t}`)).n, 0, `${t} starts empty`);

    // ── Names: what each is, and what it sits on ──
    const cons = Object.fromEntries((await q(`SELECT conname, contype::text || ' ' || conrelid::regclass::text AS what, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text LIKE 'fin\\_%'`)).map(r => [r.conname, r]));
    for (const [name, what] of Object.entries({
      fin_voucher_lines_one_side: 'c fin_voucher_lines',
      fin_vouchers_posted_shape: 'c fin_vouchers',
      fin_ledgers_group_book_fk: 'f fin_ledgers',
      fin_voucher_lines_voucher_book_fk: 'f fin_voucher_lines',
      fin_voucher_lines_ledger_book_fk: 'f fin_voucher_lines',
      fin_vouchers_number_key: 'u fin_vouchers',
      fin_vouchers_client_key_key: 'u fin_vouchers',
      fin_vouchers_reversed_by_id_key: 'u fin_vouchers',
      fin_vouchers_reversed_only_posted: 'c fin_vouchers',
      fin_vouchers_reversal_is_journal: 'c fin_vouchers',
      fin_approval_rules_limit_not_nan: 'c fin_approval_rules',
    })) assert.equal(cons[name]?.what, what, name);
    assert.equal(cons.fin_ledgers_group_book_fk.def, 'FOREIGN KEY (group_id, book_id) REFERENCES fin_groups(id, book_id)');
    assert.equal(cons.fin_voucher_lines_voucher_book_fk.def, 'FOREIGN KEY (voucher_id, book_id) REFERENCES fin_vouchers(id, book_id)');
    assert.equal(cons.fin_voucher_lines_ledger_book_fk.def, 'FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers(id, book_id)');

    const idx = Object.fromEntries((await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'fin\\_%'`)).map(r => [r.indexname, r.indexdef]));
    const keyOf = n => (idx[n] ?? '').replace(/^CREATE (?:UNIQUE )?INDEX \w+ ON public\.\w+ USING btree /, '');
    for (const [name, key] of Object.entries({
      fin_groups_book_name_key: '(book_id, lower(name))',
      fin_ledgers_book_name_key: '(book_id, lower(name))',
      fin_ledgers_book_code_key: '(book_id, code) WHERE (code IS NOT NULL)',
      fin_ledgers_party_key: '(book_id, party_type, party_id) WHERE (party_id IS NOT NULL)',
      // spec 6.6, exactly:
      fin_vouchers_one_live_opening: `(book_id) WHERE ((voucher_type = 'opening'::text) AND (status = 'posted'::text) AND (reversed_by_id IS NULL))`,
      fin_vouchers_one_live_source: `(source_type, source_id) WHERE ((source_type IS NOT NULL) AND (status = ANY (ARRAY['submitted'::text, 'posted'::text])) AND (reversed_by_id IS NULL) AND (reversal_of_id IS NULL))`,
      fin_vouchers_one_reversal: `(reversal_of_id) WHERE ((reversal_of_id IS NOT NULL) AND (status <> 'discarded'::text))`,
      fin_access_user_book_key: '(user_id, book_id)',
      fin_approval_rules_book_rule_key: '(book_id, rule_key)',
      fin_periods_book_start_key: '(book_id, start_date)',
      fin_years_book_start_key: '(book_id, start_date)',
    })) {
      assert.match(idx[name] ?? '', /^CREATE UNIQUE INDEX/, `${name} is a unique index`);
      assert.equal(keyOf(name), key, name);
    }
    for (const [name, key] of Object.entries({
      idx_fin_vouchers_book_date: '(book_id, voucher_date, status)',
      idx_fin_voucher_lines_ledger: '(ledger_id)',
      idx_fin_audit_book_at: '(book_id, at)',
      idx_fin_audit_entity: '(entity, entity_id)',
    })) {
      assert.match(idx[name] ?? '', /^CREATE INDEX/, `${name} is a plain index`);
      assert.equal(keyOf(name), key, name);
    }

    // ── Rules that hold for the whole schema ──
    assert.deepEqual(await q(`SELECT conrelid::regclass::text AS from_table, confrelid::regclass::text AS to_table FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text LIKE 'fin\\_%' AND confrelid::regclass::text NOT LIKE 'fin\\_%'`), [],
      'no fin_ table has a foreign key onto an ERP table');
    assert.deepEqual(await q(`SELECT c.conname FROM pg_constraint c
        WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'fin\\_%'
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
                          AND (string_to_array(i.indkey::text, ' ')::smallint[])[1] = c.conkey[1])`), [],
      'every foreign key is led by a full index');
    const dateCols = await q(`SELECT c.relname AS tbl, a.attname AS col, a.atttypid::regtype::text AS typ,
        EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c' AND a.attnum = ANY (k.conkey)
                AND pg_get_constraintdef(k.oid) LIKE '%^[0-9]{4}-[0-9]{2}-[0-9]{2}$%') AS checked
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname LIKE 'fin\\_%' AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.attname LIKE '%\\_date' OR a.attname IN ('as_at', 'books_begin'))`);
    assert.equal(dateCols.length, 11, 'non-vacuous: the date columns of spec section 6');
    assert.deepEqual(dateCols.filter(c => c.typ !== 'text' || !c.checked), [], 'every date column is TEXT with the YYYY-MM-DD CHECK');

    // Replaying the migration leaves every constraint and index exactly as it was.
    const shape = () => q(`SELECT 'con' AS k, conrelid::regclass::text AS t, conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text LIKE 'fin\\_%'
      UNION ALL SELECT 'idx', tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'fin\\_%'
      ORDER BY 1, 2, 3`);
    const shapeBefore = await shape();
    await h.db.init();
    assert.deepEqual(await shape(), shapeBefore);

    // ── Meaning: probe the real constraints ──
    const insert = (table, row) => {
      const cols = Object.keys(row);
      return [`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(row)];
    };
    const add = async (table, row) => (await h.db.one(...insert(table, row))).id;
    const refuse = (constraint, table, row) => assert.rejects(
      h.db.tx(qc => qc(...insert(table, row))),
      e => { assert.equal(e.constraint, constraint, `${table} ${JSON.stringify(row)}`); return true; });

    const A = await add('fin_books', { code: 'ZA', name: 'Probe A', billing_entity_id: 9001, books_begin: '2027-01-01' });   // no billing entity 9001: stored bare
    const B = await add('fin_books', { code: 'ZB', name: 'Probe B', billing_entity_id: 9002, books_begin: '2027-01-01' });
    await refuse('fin_books_code_check', 'fin_books', { code: 'z', name: 'x', billing_entity_id: 9003, books_begin: '2027-01-01' });
    await refuse('fin_books_code_check', 'fin_books', { code: 'ABCDE', name: 'x', billing_entity_id: 9003, books_begin: '2027-01-01' });
    await refuse('fin_books_billing_entity_id_key', 'fin_books', { code: 'ZC', name: 'x', billing_entity_id: 9001, books_begin: '2027-01-01' });
    await refuse('fin_books_books_begin_check', 'fin_books', { code: 'ZC', name: 'x', billing_entity_id: 9003, books_begin: '1-Jan-27' });

    const year = await add('fin_years', { book_id: A, label: '2026-27', short: '2627', start_date: '2026-04-01', end_date: '2027-03-31' });
    await refuse('fin_years_book_start_key', 'fin_years', { book_id: A, label: 'dup', short: '2627', start_date: '2026-04-01', end_date: '2027-03-31' });
    const month = { book_id: A, year_id: year, month_no: 10, label: 'Jan 2027', start_date: '2027-01-01', end_date: '2027-01-31', status: 'open' };
    const jan = await add('fin_periods', month);
    await refuse('fin_periods_book_start_key', 'fin_periods', month);
    await refuse('fin_periods_status_check', 'fin_periods', { ...month, start_date: '2027-02-01', status: 'frozen' });

    // groups and ledgers: names unique per book however they are cased; a NULL code never collides; a party links once per book
    const gA = await add('fin_groups', { book_id: A, name: 'Probe Group', nature: 'asset' });
    const gB = await add('fin_groups', { book_id: B, name: 'Probe Group', nature: 'asset' });      // the same name in another book is fine
    await refuse('fin_groups_book_name_key', 'fin_groups', { book_id: A, name: 'PROBE group', nature: 'asset' });
    const lA = await add('fin_ledgers', { book_id: A, group_id: gA, name: 'Probe Ledger', code: 'C1' });
    const lB = await add('fin_ledgers', { book_id: B, group_id: gB, name: 'Probe Ledger' });
    await refuse('fin_ledgers_book_name_key', 'fin_ledgers', { book_id: A, group_id: gA, name: 'probe LEDGER' });
    await refuse('fin_ledgers_book_code_key', 'fin_ledgers', { book_id: A, group_id: gA, name: 'Other', code: 'C1' });
    await add('fin_ledgers', { book_id: A, group_id: gA, name: 'No code 1' });
    await add('fin_ledgers', { book_id: A, group_id: gA, name: 'No code 2' });
    await add('fin_ledgers', { book_id: A, group_id: gA, name: 'Customer 7', party_type: 'customer', party_id: 7 });
    await refuse('fin_ledgers_party_key', 'fin_ledgers', { book_id: A, group_id: gA, name: 'Customer 7 again', party_type: 'customer', party_id: 7 });
    await add('fin_ledgers', { book_id: A, group_id: gA, name: 'Vendor 7', party_type: 'vendor', party_id: 7 });   // same id, other kind
    await refuse('fin_ledgers_party_pair', 'fin_ledgers', { book_id: A, group_id: gA, name: 'Half a party', party_type: 'vendor' });
    await refuse('fin_ledgers_group_book_fk', 'fin_ledgers', { book_id: A, group_id: gB, name: 'In the other book\'s tree' });

    // vouchers: draft rows only
    const draft = { book_id: A, voucher_type: 'journal', voucher_date: '2027-01-10' };
    const vA = await add('fin_vouchers', draft);
    const at = new Date();
    await refuse('fin_vouchers_voucher_date_check', 'fin_vouchers', { ...draft, voucher_date: '10-01-2027' });
    await refuse('fin_vouchers_voucher_type_check', 'fin_vouchers', { ...draft, voucher_type: 'quote' });
    await refuse('fin_vouchers_status_check', 'fin_vouchers', { ...draft, status: 'approved' });
    // posted exactly when it carries a number, a month and a time
    await refuse('fin_vouchers_posted_shape', 'fin_vouchers', { ...draft, status: 'posted' });
    await refuse('fin_vouchers_posted_shape', 'fin_vouchers', { ...draft, status: 'posted', number: 'X-1', period_id: jan });          // no posted_at
    await refuse('fin_vouchers_posted_shape', 'fin_vouchers', { ...draft, status: 'posted', period_id: jan, posted_at: at });          // no number
    await refuse('fin_vouchers_posted_shape', 'fin_vouchers', { ...draft, status: 'posted', number: 'X-1', posted_at: at });          // no month
    await refuse('fin_vouchers_posted_shape', 'fin_vouchers', { ...draft, status: 'draft', number: 'X-1', period_id: jan, posted_at: at });
    await add('fin_vouchers', { ...draft, number: 'D-1' });                   // a number alone does not make a voucher posted
    await refuse('fin_vouchers_number_key', 'fin_vouchers', { ...draft, number: 'D-1' });
    const key = randomUUID();
    await add('fin_vouchers', { ...draft, client_key: key });
    await refuse('fin_vouchers_client_key_key', 'fin_vouchers', { ...draft, client_key: key });
    // one live posting per ERP document: only submitted or posted ones, only while not reversed
    const src = { ...draft, source_type: 'invoice', source_id: 11 };
    await add('fin_vouchers', { ...src, status: 'submitted' });
    await refuse('fin_vouchers_one_live_source', 'fin_vouchers', { ...src, status: 'submitted' });
    await add('fin_vouchers', { ...src, status: 'draft' });
    await add('fin_vouchers', { ...src, status: 'discarded' });
    await add('fin_vouchers', { ...src, source_id: 12, status: 'submitted' });
    await add('fin_vouchers', { ...draft, status: 'submitted' });             // hand-made: no source, never collides
    await add('fin_vouchers', { ...draft, status: 'submitted' });
    // a voucher is reversed once: a discarded reversal frees the slot
    await add('fin_vouchers', { ...draft, reversal_of_id: vA });
    await refuse('fin_vouchers_one_reversal', 'fin_vouchers', { ...draft, reversal_of_id: vA });
    await add('fin_vouchers', { ...draft, reversal_of_id: vA, status: 'discarded' });
    const r1 = await add('fin_vouchers', draft);
    // only a posted voucher is ever marked reversed (final wave item 4): a draft, a waiting entry or a discarded one is not
    for (const status of ['draft', 'submitted', 'discarded']) {
      await refuse('fin_vouchers_reversed_only_posted', 'fin_vouchers', { ...draft, status, reversed_by_id: r1 });
    }
    // …and each reversal marks one voucher. Posted rows, in a transaction that never commits: the hard stops added later would
    // check their lines at COMMIT.
    await assert.rejects(h.db.tx(async qc => {
      for (const n of ['R-1', 'R-2']) {
        await qc(...insert('fin_vouchers', { ...draft, status: 'posted', number: n, period_id: jan, posted_at: at, reversed_by_id: r1 }));
      }
    }), e => { assert.equal(e.constraint, 'fin_vouchers_reversed_by_id_key'); return true; });
    // a reversal is a journal (final wave item 5): it mirrors its entry's lines, whatever that entry's type
    for (const voucher_type of ['payment', 'receipt', 'contra', 'opening', 'sales']) {
      await refuse('fin_vouchers_reversal_is_journal', 'fin_vouchers', { ...draft, voucher_type, reversal_of_id: r1 });
    }
    await add('fin_vouchers', { ...draft, reversal_of_id: r1 });

    // lines: exactly one side, positive; the voucher's book and the ledger's book must be the line's book
    const line = (extra = {}) => ({ voucher_id: vA, book_id: A, line_no: 1, ledger_id: lA, debit: 5, credit: 0, ...extra });
    await add('fin_voucher_lines', line());
    await add('fin_voucher_lines', line({ line_no: 2, debit: 0, credit: 5 }));
    await refuse('fin_voucher_lines_one_side', 'fin_voucher_lines', line({ line_no: 3, debit: 5, credit: 5 }));
    await refuse('fin_voucher_lines_one_side', 'fin_voucher_lines', line({ line_no: 3, debit: 0, credit: 0 }));
    await refuse('fin_voucher_lines_one_side', 'fin_voucher_lines', line({ line_no: 3, debit: -5, credit: 0 }));
    await refuse('fin_voucher_lines_voucher_id_line_no_key', 'fin_voucher_lines', line({ line_no: 2 }));
    await refuse('fin_voucher_lines_voucher_book_fk', 'fin_voucher_lines', line({ line_no: 3, book_id: B, ledger_id: lB }));
    await refuse('fin_voucher_lines_ledger_book_fk', 'fin_voucher_lines', line({ line_no: 3, ledger_id: lB }));
    await refuse('fin_voucher_lines_bill_date_check', 'fin_voucher_lines', line({ line_no: 3, bill_date: '2027-1-5' }));
    await add('fin_voucher_lines', line({ line_no: 3, bill_ref: 'INV-1', bill_date: '2027-01-05', due_date: '2027-02-04' }));

    // nothing cascades: a parent with children cannot be deleted
    for (const sql of [`DELETE FROM fin_vouchers WHERE id = ${vA}`, `DELETE FROM fin_groups WHERE id = ${gA}`,
      `DELETE FROM fin_years WHERE id = ${year}`, `DELETE FROM fin_books WHERE id = ${A}`]) {
      await assert.rejects(h.db.q(sql), e => e.code === '23503', sql);
    }

    // access, rules
    await refuse('fin_access_roles_check', 'fin_access', { user_id: 1, book_id: A, roles: [] });
    await refuse('fin_access_roles_check', 'fin_access', { user_id: 1, book_id: A, roles: ['owner'] });
    await refuse('fin_access_roles_check', 'fin_access', { user_id: 1, book_id: A, roles: ['viewer', 'owner'] });
    await add('fin_access', { user_id: 1, book_id: A, roles: ['viewer', 'approver'] });
    await refuse('fin_access_user_book_key', 'fin_access', { user_id: 1, book_id: A, roles: ['admin'] });
    await add('fin_access', { user_id: 1, book_id: B, roles: ['admin'], can_export: false });
    await refuse('fin_approval_rules_limit_iff_above', 'fin_approval_rules', { book_id: A, rule_key: 'payment', mode: 'above_limit' });
    await refuse('fin_approval_rules_limit_iff_above', 'fin_approval_rules', { book_id: A, rule_key: 'payment', mode: 'always', limit_amount: 100 });
    await refuse('fin_approval_rules_rule_key_check', 'fin_approval_rules', { book_id: A, rule_key: 'bogus', mode: 'never' });
    // NaN is no limit (final wave item 3): PostgreSQL's NaN is greater than every number, so `limit_amount >= 0` lets it through
    await refuse('fin_approval_rules_limit_not_nan', 'fin_approval_rules', { book_id: A, rule_key: 'contra', mode: 'above_limit', limit_amount: 'NaN' });
    await add('fin_approval_rules', { book_id: A, rule_key: 'payment', mode: 'above_limit', limit_amount: 100000 });
    await add('fin_approval_rules', { book_id: A, rule_key: 'reversal', mode: 'always' });
    await refuse('fin_approval_rules_book_rule_key', 'fin_approval_rules', { book_id: A, rule_key: 'payment', mode: 'never' });

    // audit: before, after and at are ordinary column names; the BIGINT id comes back as a number
    const audit = await h.db.one(`INSERT INTO fin_audit_log (book_id, entity, entity_id, action, user_name, before, after)
        VALUES ($1, 'voucher', $2, 'create', 'Probe', $3, $4) RETURNING id, at, before, after`, [A, vA, { n: 1 }, { n: 2 }]);
    assert.equal(typeof audit.id, 'number');
    assert.ok(audit.at instanceof Date);
    assert.deepEqual([audit.before, audit.after], [{ n: 1 }, { n: 2 }]);

    // import staging: the proposal columns a 'create' row carries. Whether a row's ledger is a party's is worked out each
    // time the import is read, from the book as it stands, and never stored (ruling R46).
    const stagingColumns = (await q(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fin_import_ledgers' ORDER BY ordinal_position`)).map(r => r.column_name);
    assert.deepEqual(stagingColumns,
      ['id', 'import_id', 'tally_name', 'tally_group', 'debit', 'credit', 'ledger_id', 'match_status', 'group_id', 'party_type', 'party_id']);
    const imp = await add('fin_imports', { book_id: A, purpose: 'opening', as_at: '2026-12-31', file_names: ['tb.xlsx'], summary: { rows: 1 } });
    await refuse('fin_imports_status_check', 'fin_imports', { book_id: A, purpose: 'opening', as_at: '2026-12-31', status: 'done' });
    await add('fin_import_ledgers', { import_id: imp, tally_name: 'Acme Pharma Ltd', tally_group: 'Sundry Debtors', debit: 100,
      match_status: 'create', group_id: gA, party_type: 'customer', party_id: 7 });
    await refuse('fin_import_ledgers_match_status_check', 'fin_import_ledgers', { import_id: imp, tally_name: 'X', match_status: 'maybe' });
    await add('fin_import_bills', { import_id: imp, tally_ledger_name: 'Acme Pharma Ltd', bill_ref: 'INV-1', bill_date: '2026-12-01', due_date: '2026-12-31', amount: 100, side: 'dr' });
    await refuse('fin_import_bills_side_check', 'fin_import_bills', { import_id: imp, tally_ledger_name: 'X', amount: 1, side: 'debit' });

    // db.js keeps one pool per process: a second boot while this one is open is refused, not silently shared
    await assert.rejects(finBootPg('overlap', { setup: false }), /'contract' is still open/);
  } finally { await h.close(); }
});
