import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { FINANCE_TABLES } from '../../client/src/lib/finance/tables.js';

// The Finance Cash & Bank migration (spec docs/superpowers/specs/2026-11-20-finance-cash-bank-design.md §10), pinned the
// way finance-migration-pins.test.js pins the core one. finance-pg-cash-schema.test.js proves what it does on a database.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const NAME = '20261121090100_finance_cash_bank.sql';
const sql = existsSync(new URL(NAME, DIR)) ? readFileSync(new URL(NAME, DIR), 'utf8') : '';
const CORE = readdirSync(DIR).filter(f => f.endsWith('_finance_ledger_core.sql'));
const core = readFileSync(new URL(CORE[0], DIR), 'utf8');
const NEW_TABLES = ['fin_allocations', 'fin_cash_counts', 'fin_ledger_roles', 'fin_hr_channels', 'fin_hr_expense_map',
  'fin_book_settings', 'fin_hr_exceptions', 'fin_hr_covers'];
const created = text => [...text.matchAll(/CREATE TABLE IF NOT EXISTS (fin_\w+) \(/g)].map(m => m[1]);
const quoted = list => [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);

test('one Cash & Bank migration, sorting after the HR paid-from one, never named like a plate migration', () => {
  assert.ok(existsSync(new URL(NAME, DIR)), `${NAME} missing`);
  assert.deepEqual(readdirSync(DIR).filter(f => f.endsWith('_finance_cash_bank.sql')), [NAME]);
  assert.ok(NAME > '20261121090000_hr_paid_from.sql', NAME);
  assert.ok(NAME > CORE[0], 'after the Finance core, whose tables it alters');
  assert.doesNotMatch(NAME, /plate/i);
});

test('the core migration\'s header rules: a comment first, a short lock, idempotent DDL, no DROP TRIGGER', () => {
  assert.match(sql, /^-- /);
  assert.match(sql, /set local lock_timeout = '1s';/);
  assert.match(sql, /Mirrored locally by server\/src\/db\.js init\(\)/);
  assert.doesNotMatch(sql, /drop trigger/i);
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(sql, /ADD COLUMN (?!IF NOT EXISTS)/i);
  // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS: each one is added only when the catalogue lacks it.
  for (const name of ['fin_ledgers_float_needs_holder', 'fin_vouchers_correction_is_journal']) {
    assert.match(sql, new RegExp(`if not exists \\(select 1 from pg_catalog\\.pg_constraint\\s+where conrelid = 'public\\.fin_\\w+'::regclass `
      + `and conname = '${name}'\\) then\\s+alter table fin_\\w+ add constraint ${name}\\b`, 'i'), name);
  }
});

test('the eight new tables: each created, each in the RLS block, each in the guarded realtime block', () => {
  assert.deepEqual(created(sql).sort(), [...NEW_TABLES].sort(), 'the migration creates exactly the eight');
  const revoke = role => sql.match(new RegExp(`revoke all on table ([\\w\\s,]+?) from ${role};`))?.[1].split(/[\s,]+/).filter(Boolean) ?? [];
  for (const t of NEW_TABLES) {
    assert.match(sql, new RegExp(`^alter table ${t} enable row level security;$`, 'm'), `${t}: RLS`);
    for (const role of ['anon', 'authenticated']) assert.ok(revoke(role).includes(t), `${t}: revoked from ${role}`);
  }
  for (const role of ['anon', 'authenticated']) {
    assert.match(sql, new RegExp(`if exists \\(select 1 from pg_catalog\\.pg_roles where rolname = '${role}'\\) then\\s+revoke all on table`),
      `the revoke from ${role} is guarded: a local database has no such role`);
  }
  const loops = [...sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]\s+loop\b([\s\S]*?)\bend\s+loop/gi)];
  assert.equal(loops.length, 1, 'one foreach loop, the realtime one');
  assert.match(loops[0][2], /ci_erp_realtime_ping/);
  assert.deepEqual(quoted(loops[0][1]).sort(), [...NEW_TABLES].sort());
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.%I for each row/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.%I for each statement/);
});

test('cash_difference: in the widened rule-key CHECK, replaced only when missing, and seeded \'always\' for every book', () => {
  const was = quoted(core.match(/rule_key TEXT NOT NULL CHECK \(rule_key IN\s*\(([^)]*)\)\)/)?.[1] ?? '');
  assert.equal(was.length, 10, 'non-vacuous: the core\'s ten rule keys');
  const check = sql.match(/add constraint fin_approval_rules_rule_key_check check \(rule_key in\s*\(([^)]*)\)\)/i);
  assert.ok(check, 'the CHECK is re-added under its own name');
  assert.deepEqual(quoted(check[1]), [...was, 'cash_difference']);
  assert.match(sql, /and conname = 'fin_approval_rules_rule_key_check'\s+and pg_catalog\.pg_get_constraintdef\(oid\) like '%cash_difference%'\) then/,
    'replaced only while the current definition lacks it');
  assert.match(sql, /alter table fin_approval_rules drop constraint if exists fin_approval_rules_rule_key_check,\s+add constraint fin_approval_rules_rule_key_check/,
    'dropped and re-added in one statement');
  assert.match(sql, /INSERT INTO fin_approval_rules \(book_id, rule_key, mode, limit_amount, updated_by\)\s+SELECT b\.id, 'cash_difference', 'always', NULL, 'migration' FROM fin_books b\s+ON CONFLICT \(book_id, rule_key\) DO NOTHING;/);
  assert.ok(sql.indexOf('INSERT INTO fin_approval_rules') > sql.indexOf('add constraint fin_approval_rules_rule_key_check'), 'the rule is seeded after the CHECK takes it');
  assert.match(sql, /INSERT INTO fin_book_settings \(book_id\)\s+SELECT b\.id FROM fin_books b\s+ON CONFLICT DO NOTHING;/);
});

test('fin_book_settings keeps Bring-in\'s drift resume point: hr_drift_cursor, a bare voucher id, null at first (ruling R38b)', () => {
  const table = sql.match(/CREATE TABLE IF NOT EXISTS fin_book_settings \(([\s\S]*?)\n\);/)?.[1] ?? '';
  assert.match(table, /payroll_booking TEXT NOT NULL/, 'non-vacuous: the settings table read');
  assert.match(table, /,\n  hr_drift_cursor INTEGER$/, 'its last column: nullable, no default, and no foreign key');
  assert.match(sql, /^ALTER TABLE fin_book_settings ADD COLUMN IF NOT EXISTS hr_drift_cursor INTEGER;$/m,
    'and added to a table made before it had the column');
});

test('FINANCE_TABLES has twenty-one: the union of both Finance migrations\' tables', () => {
  const both = [...created(core), ...created(sql)];
  assert.equal(new Set(both).size, both.length, 'no table is created by both');
  assert.equal(FINANCE_TABLES.length, 21);
  assert.deepEqual([...FINANCE_TABLES].sort(), [...both].sort());
});

// ── Beyond the brief's pins ───────────────────────────────────────────────────────────────────────────────────────

// Ruling R4. PL/pgSQL replaces a function whole, so the posting check is copied from the core migration and changed in the
// two places the brief names, and one more the pre-review fix asked for, and nowhere else: (a) H5's before_books branch takes
// an approved opening correction dated the day before the books begin; (b) H6's system-only exemption takes opening
// corrections, as it takes the Opening; (c) an opening correction dated any other day is refused in every month
// (FIN_BAD_CORRECTION), so (a) and (b) hold for the opening day only.
const fn = (text, name) => text.match(new RegExp(`create or replace function ${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';
const CHANGES = [
  [`  -- Before the books begin, only the Opening voucher and its reversal. Said
  -- first: a typed entry dated there is told so, whatever the months after
  -- it hold.
  if month_row.status = 'before_books' and new.voucher_type <> 'opening' and not reverses_opening then`,
  `  -- Before the books begin, only the Opening voucher and its reversal, and an
  -- opening correction (spec §9.4) that is approved and dated the Opening's
  -- own date, the day before the books begin (anything else, a NULL included,
  -- is refused). Said first: a typed entry dated there is told so, whatever
  -- the months after it hold.
  if month_row.status = 'before_books' and new.voucher_type <> 'opening' and not reverses_opening
     and (new.is_opening_correction and new.approved_by_id is not null
          and real_date = (select b.books_begin::date - 1 from public.fin_books b where b.id = new.book_id)) is not true then`],
  [`  -- A system-only ledger (manual_entry false) takes only the ERP's own
  -- postings (source_type set), the Opening voucher and reversals.
  if new.source_type is null and new.voucher_type <> 'opening' and new.reversal_of_id is null then`,
  `  -- A system-only ledger (manual_entry false) takes only the ERP's own
  -- postings (source_type set), the Opening voucher and its corrections
  -- (spec §9.4), and reversals.
  if new.source_type is null and new.voucher_type <> 'opening' and not new.is_opening_correction
     and new.reversal_of_id is null then`],
  [`  -- The month's status, and that of every month after it (ruling R73). A
`,
  `  -- An opening correction is dated the Opening's own date, the day before
  -- the books begin, whatever month holds that date and whatever its status
  -- (spec §9.4): the exemptions it shares with the Opening, above and below,
  -- hold for that date alone. One dated on any other day before the books
  -- was told so above.
  if new.is_opening_correction
     and real_date is distinct from (select b.books_begin::date - 1 from public.fin_books b where b.id = new.book_id) then
    raise exception using
      message = format('Voucher %s is an opening correction dated %s. An opening correction is dated the day before the books begin, the Opening''s own date.',
                       new.number, new.voucher_date),
      detail = 'FIN_BAD_CORRECTION',
      errcode = 'P0001';
  end if;

  -- The month's status, and that of every month after it (ruling R73). A
`],
];

test('R4: fin_voucher_post_check is the core\'s, line for line, but for the before_books acceptance, the H6 exemption and the correction\'s date', () => {
  const was = fn(core, 'fin_voucher_post_check');
  const now = fn(sql, 'fin_voucher_post_check');
  assert.ok(was.length > 4000 && now.length > 4000, 'non-vacuous: both functions were found whole');
  for (const [before, after] of CHANGES) {
    assert.equal(was.split(before).length, 2, `the core has the passage once: ${before.split('\n').pop().trim()}`);
    assert.equal(now.split(after).length, 2, `the replacement has its change once: ${after.split('\n').pop().trim()}`);
  }
  assert.equal(now, CHANGES.reduce((text, [before, after]) => text.replace(before, after), was));
  assert.match(sql, /This REPLACES fin_voucher_post_check\(\) of 20261027104320_finance_ledger_core\.sql/,
    'a comment above it says it replaces the core migration\'s function');
});

// The hard stops this file adds or replaces replay cleanly and raise the way the core's do (finance-migration-pins.test.js):
// CREATE OR REPLACE for every function and plain trigger, a catalogue guard for the constraint trigger, an empty search_path
// with every table named with its schema, and every refusal SQLSTATE P0001 with a FIN_ code in DETAIL.
const FUNCTIONS = ['fin_allocation_guard', 'fin_allocation_sum_check', 'fin_voucher_post_check'];

test('the allocation checks and the replaced posting check: replay-safe, schema-qualified, each refusal a FIN_ code', () => {
  const functions = [...sql.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)];
  assert.deepEqual(functions.map(m => m[2]).sort(), FUNCTIONS);
  assert.ok(functions.every(m => m[1]), 'every function is CREATE OR REPLACE');
  for (const name of FUNCTIONS) {
    const body = fn(sql, name).replace(/^create or replace function \w+\(\)/, '');
    assert.match(body, /^\s*returns trigger\s+language plpgsql\s+set search_path = ''\s+as \$\$/, name);
    assert.doesNotMatch(body, /\b(?:from|join|update|into|table)\s+(?!public\.)fin_\w+/i, `${name} names a table without public.`);
  }
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+constraint\s+trigger/i);
  const triggers = [...sql.matchAll(/\bcreate\s+(or\s+replace\s+)?(constraint\s+)?trigger\s+(\w+)/gi)];
  assert.deepEqual(triggers.map(m => m[3]),
    ['fin_allocation_guard', 'fin_allocation_sum_check', 'fin_no_truncate', 'fin_no_truncate', 'ci_erp_realtime_ping', 'ci_erp_realtime_ping_truncate']);
  for (const [, orReplace, constraint, name] of triggers) {
    if (!constraint) { assert.ok(orReplace, `${name} is created with CREATE OR REPLACE`); continue; }
    assert.match(sql, new RegExp(`if not exists \\(select 1 from pg_catalog\\.pg_trigger\\s+where tgname = '${name}' `
      + `and tgrelid = 'public\\.fin_allocations'::regclass\\) then\\s+create constraint trigger ${name}\\b`, 'i'), `${name} only when missing`);
  }
  assert.match(sql, /\btrigger fin_allocation_guard before insert or update on fin_allocations\s+for each row execute function fin_allocation_guard\(\);/);
  assert.match(sql, /create constraint trigger fin_allocation_sum_check after insert or update on fin_allocations\s+deferrable initially deferred for each row\s+execute function fin_allocation_sum_check\(\);/);
  // H10 for allocations: the core's own fin_no_truncate(), as on the vouchers, their lines and the audit log; and for what an HR
  // voucher books (ruling R27), which is as lasting as the voucher.
  assert.match(sql, /\bcreate or replace trigger fin_no_truncate before truncate on fin_allocations\s+for each statement execute function fin_no_truncate\(\);/);
  assert.match(sql, /\bcreate or replace trigger fin_no_truncate before truncate on fin_hr_covers\s+for each statement execute function fin_no_truncate\(\);/);

  const raises = sql.match(/\braise\s+exception\b/gi) ?? [];
  const shaped = [...sql.matchAll(/\braise exception using\s+message = [\s\S]*?,\s+detail = '(FIN_[A-Z_]+)',\s+errcode = 'P0001';/gi)];
  assert.ok(raises.length >= 15, `non-vacuous: ${raises.length} raises`);
  assert.equal(shaped.length, raises.length, 'every RAISE reads: message, then detail = a FIN_ code, then errcode P0001');
  const codes = new Set(shaped.map(m => m[1]));
  for (const code of ['FIN_BAD_ALLOCATION', 'FIN_OVER_ALLOCATED', 'FIN_BAD_CORRECTION']) assert.ok(codes.has(code), code);
});

// Ruling R7: concurrency between allocations and reversals is the party lock's job, taken by the app. The guard reads and takes
// no row lock: one on the counterpart voucher would sit outside the lock order and cycle with a reversal. The protocol it
// relies on is written down above it, and the sum check keeps its two line locks, belt and braces for SQL written by hand.
test('R7: the allocation guard takes no row lock, the protocol it relies on is written above it, and the sum check locks only its lines', () => {
  const LOCK = /\bfor\s+(?:share|update|no\s+key\s+update|key\s+share)\b/gi;
  const guard = fn(sql, 'fin_allocation_guard');
  const sum = fn(sql, 'fin_allocation_sum_check');
  assert.ok(guard.length > 500 && sum.length > 500, 'non-vacuous: both functions were found');
  assert.deepEqual(guard.match(LOCK) ?? [], [], 'the guard reads without locking');
  assert.deepEqual(sum.match(LOCK) ?? [], ['for no key update'], 'the sum check takes one lock');
  assert.match(sum, /from public\.fin_voucher_lines l\s+where l\.id in \(new\.debit_line_id, new\.credit_line_id\)\s+order by l\.id\s+for no key update;/);
  const at = sql.indexOf('create or replace function fin_allocation_guard()');
  const above = sql.slice(sql.lastIndexOf('\n\n', at), at);
  for (const said of [/ruling R7/, /pg_advisory_xact_lock\(7300, ledger_id\)/, /finPostLocked's first statement/, /own lines, in ascending id/,
    /after marking it reversed/, /belt and braces/, /READ COMMITTED/]) assert.match(above, said);
});

test('isolation: everything the migration alters, indexes, triggers on or references is a fin_ table', () => {
  const targets = [
    ...[...sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/REFERENCES (?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/INDEX IF NOT EXISTS \w+\s+ON (?:public\.)?(\w+)/gi)].map(m => m[1]),
    // `on public.%I` is the realtime block's template, whose tables the test above holds to the seven.
    ...[...sql.matchAll(/\b(?:BEFORE|AFTER)\s+[A-Z ,]+?\s+ON (?!public\.%I\b)(?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/INSERT INTO (?:public\.)?(\w+)/gi)].map(m => m[1]),
  ];
  assert.ok(targets.length >= 30, `non-vacuous: only ${targets.length} targets found`);
  assert.deepEqual(targets.filter(t => !t.startsWith('fin_')), []);
});
