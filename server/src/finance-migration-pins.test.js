import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const files = readdirSync(DIR).filter(f => f.endsWith('_finance_ledger_core.sql'));
const sql = files.length === 1 ? readFileSync(new URL(files[0], DIR), 'utf8') : '';
const FIN_TABLES = ['fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers', 'fin_vouchers', 'fin_voucher_lines',
  'fin_access', 'fin_approval_rules', 'fin_audit_log', 'fin_imports', 'fin_import_ledgers', 'fin_import_bills'];

test('one finance migration, after the newest existing one, never named like a plate migration', () => {
  assert.equal(files.length, 1);
  assert.ok(files[0] > '20261006190000', files[0]);
  assert.doesNotMatch(files[0], /plate/i);
});

test('standard header, short lock, idempotent DDL, no DROP TRIGGER', () => {
  assert.match(sql, /^-- /);
  assert.match(sql, /set local lock_timeout = '1s';/);
  assert.match(sql, /Mirrored locally by server\/src\/db\.js init\(\)/);
  assert.doesNotMatch(sql, /drop trigger/i);
  assert.doesNotMatch(sql, /CREATE TABLE (?!IF NOT EXISTS)/i);
  assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
});

test('every finance table, each in the guarded realtime block', () => {
  for (const t of FIN_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`), t);
    assert.ok(sql.includes(`'${t}'`), `${t} missing from the realtime array`);
  }
  assert.match(sql, /to_regprocedure\('public\.ci_erp_realtime_ping\(\)'\) is null/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping after insert or update or delete on public\.%I for each row/);
  assert.match(sql, /create or replace trigger ci_erp_realtime_ping_truncate after truncate on public\.%I for each statement/);
});

test('isolation: everything the migration alters, indexes, triggers on or references is a fin_ table', () => {
  const targets = [
    ...[...sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/REFERENCES (?:public\.)?(\w+)/gi)].map(m => m[1]),
    ...[...sql.matchAll(/INDEX IF NOT EXISTS \w+\s+ON (?:public\.)?(\w+)/gi)].map(m => m[1]),
    // `on public.%I` is the realtime block's format() template, which test 3 requires verbatim and the
    // next test checks the tables of. It is the one target skipped. Any other name after ON is captured,
    // so `on other_schema.some_table` reads as "other_schema" and fails here.
    ...[...sql.matchAll(/\b(?:BEFORE|AFTER)\s+[A-Z ,]+?\s+ON (?!public\.%I\b)(?:public\.)?(\w+)/gi)].map(m => m[1]),
  ];
  assert.ok(targets.length >= 25, `non-vacuous: only ${targets.length} targets found`);
  assert.deepEqual(targets.filter(t => !t.startsWith('fin_')), []);
});

test('the realtime block names exactly the thirteen finance tables (its %I targets are invisible to the isolation scan)', () => {
  // Every `foreach … in array array[…] loop` runs a template whose %I target the isolation scan cannot
  // see, so every such loop, not only the first, may name finance tables only.
  const loops = [...sql.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([^\]]*)\]\s+loop\b([\s\S]*?)\bend\s+loop/gi)];
  const names = loop => [...loop[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(loops.length >= 1, 'non-vacuous: no foreach loop found');
  for (const loop of loops) assert.deepEqual(names(loop).filter(t => !t.startsWith('fin_')), [], 'a loop names a table outside Finance');
  const realtime = loops.filter(loop => /ci_erp_realtime_ping/.test(loop[2]));
  assert.equal(realtime.length, 1, 'one realtime loop');
  assert.deepEqual(names(realtime[0]).sort(), [...FIN_TABLES].sort());
});

test('init() replays the finance migration as its last statement', () => {
  const db = readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  assert.match(db, new RegExp(`await pool\\.query\\(migration\\('${files[0]}'\\)\\);\\n\\}`));
});

// ── The hard stops (spec §7.2, H1–H10). finance-pg-db.test.js proves what they do; these pin their shape. ──

// What the triggers raise: the twelve of the brief, and FIN_BAD_REVERSAL (Ruling R18). Task 6's
// finMapDbError maps every one of them.
const HARD_STOP_CODES = ['FIN_UNBALANCED', 'FIN_TOO_FEW_LINES', 'FIN_POSTED_IMMUTABLE', 'FIN_PERIOD_LOCKED', 'FIN_PERIOD_CLOSING',
  'FIN_BEFORE_BOOKS', 'FIN_BAD_DATE', 'FIN_WRONG_BOOK', 'FIN_LEDGER_INACTIVE', 'FIN_SYSTEM_LEDGER', 'FIN_AUDIT_APPEND_ONLY', 'FIN_NO_TRUNCATE',
  'FIN_BAD_REVERSAL'];
const HARD_STOP_FUNCTIONS = ['fin_audit_guard', 'fin_line_guard', 'fin_no_truncate', 'fin_voucher_guard', 'fin_voucher_post_check'];

test('the eight hard-stop triggers, each on its own table, the two posting checks deferred to COMMIT', () => {
  const words = text => text.split(' ').join('\\s+');
  for (const [name, timing, table, fn] of [
    ['fin_voucher_guard', 'before update or delete', 'fin_vouchers', 'fin_voucher_guard'],
    ['fin_line_guard', 'before insert or update or delete', 'fin_voucher_lines', 'fin_line_guard'],
    ['fin_voucher_post_check_ins', 'after insert', 'fin_vouchers', 'fin_voucher_post_check'],
    ['fin_voucher_post_check_upd', 'after update', 'fin_vouchers', 'fin_voucher_post_check'],
    ['fin_audit_guard', 'before update or delete', 'fin_audit_log', 'fin_audit_guard'],
    ['fin_no_truncate', 'before truncate', 'fin_vouchers', 'fin_no_truncate'],
    ['fin_no_truncate', 'before truncate', 'fin_voucher_lines', 'fin_no_truncate'],
    ['fin_no_truncate', 'before truncate', 'fin_audit_log', 'fin_no_truncate'],
  ]) {
    assert.match(sql, new RegExp(`\\btrigger ${name}\\s+${words(timing)}\\s+on (?:public\\.)?${table}\\s[^;]*?execute function (?:public\\.)?${fn}\\(\\);`, 'i'),
      `${name} ${timing} on ${table}`);
  }
  assert.equal(sql.match(/deferrable initially deferred/gi)?.length, 2);
  // Only on the way INTO posted, so marking a posted voucher reversed never re-checks it (spec §7.2).
  assert.match(sql, /fin_voucher_post_check_ins after insert on fin_vouchers\s+deferrable initially deferred for each row when \(new\.status = 'posted'\)\s/i);
  assert.match(sql, /fin_voucher_post_check_upd after update on fin_vouchers\s+deferrable initially deferred for each row when \(new\.status = 'posted' and old\.status <> 'posted'\)\s/i);
});

test('the hard stops replay cleanly: CREATE OR REPLACE for every function and plain trigger, a guard for each constraint trigger', () => {
  // PostgreSQL has no CREATE OR REPLACE CONSTRAINT TRIGGER, and DROP TRIGGER is refused above (Ruling R14).
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+constraint\s+trigger/i);
  const triggers = [...sql.matchAll(/\bcreate\s+(or\s+replace\s+)?(constraint\s+)?trigger\s+(\w+)/gi)];
  assert.equal(triggers.length, 10, 'the eight hard stops and the two realtime templates');
  for (const [, orReplace, constraint, name] of triggers) {
    if (!constraint) { assert.ok(orReplace, `${name} is created with CREATE OR REPLACE`); continue; }
    assert.match(sql, new RegExp(`if not exists \\(select 1 from (?:pg_catalog\\.)?pg_trigger\\s+where tgname = '${name}' `
      + `and tgrelid = 'public\\.fin_vouchers'::(?:pg_catalog\\.)?regclass\\) then\\s+create constraint trigger ${name}\\b`, 'i'),
    `${name} is created only when it is not there yet`);
  }
  const functions = [...sql.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)];
  assert.deepEqual(functions.map(m => m[2]).sort(), HARD_STOP_FUNCTIONS);
  assert.ok(functions.every(m => m[1]), 'every function is CREATE OR REPLACE');
});

test('every hard stop raises SQLSTATE P0001 with its FIN_ code in DETAIL, and the codes are the thirteen the app maps', () => {
  const raises = sql.match(/\braise\s+exception\b/gi) ?? [];
  const shaped = [...sql.matchAll(/\braise exception using\s+message = [\s\S]*?,\s+detail = '(FIN_[A-Z_]+)',\s+errcode = 'P0001';/gi)];
  assert.ok(raises.length >= HARD_STOP_CODES.length, `non-vacuous: ${raises.length} raises`);
  assert.equal(shaped.length, raises.length, 'every RAISE reads: message, then detail = a FIN_ code, then errcode P0001');
  assert.deepEqual([...new Set(shaped.map(m => m[1]))].sort(), [...HARD_STOP_CODES].sort());
});

test('the hard stops come after the tables and before the realtime block, and each function names its tables with their schema', () => {
  const at = text => { const i = sql.indexOf(text); assert.ok(i >= 0, text); return i; };
  assert.ok(at('CREATE TABLE IF NOT EXISTS fin_import_bills') < at('create or replace function fin_voucher_guard()'));
  assert.ok(at('create or replace trigger fin_no_truncate before truncate on fin_audit_log') < at('-- Realtime:'));
  // Each function runs with an empty search_path. A table named there without `public.` would fail only when
  // the branch naming it runs, so no test that misses the branch would notice.
  for (const name of HARD_STOP_FUNCTIONS) {
    const body = sql.match(new RegExp(`create or replace function ${name}\\(\\)([\\s\\S]*?)\\n\\$\\$;`))?.[1] ?? '';
    assert.match(body, /^\s*returns trigger\s+language plpgsql\s+set search_path = ''\s+as \$\$/, name);
    assert.doesNotMatch(body, /\b(?:from|join|update|into|table)\s+(?!public\.)fin_\w+/i, `${name} names a table without public.`);
  }
});
