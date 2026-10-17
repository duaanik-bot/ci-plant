// The HR & Payroll schema (supabase/migrations/20261016120000_hr_payroll.sql), read as text.
//
// Salary, bank and loan data live in schema hr and nowhere else (spec §5–§7). These checks
// need no database: they pin the wall around the schema (no foreign key into public, RLS on,
// nothing granted), that a replay can never destroy anything, the money / quantity / month /
// date types, every enum, and that every table and column of spec §7 is there. The behaviour
// itself is proven against a real Postgres in hr-schema-pg.test.js (HR_PG=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sqlPath = fileURLToPath(new URL('../../supabase/migrations/20261016120000_hr_payroll.sql', import.meta.url));
const dbJs = fileURLToPath(new URL('./db.js', import.meta.url));

let cached = null;
function load() {
  if (cached) return cached;
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const code = sql.replace(/--[^\n]*/g, '');                 // comments out: the checks below read statements
  const tables = new Map();
  for (const m of code.matchAll(/create table if not exists hr\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    const cols = new Map();
    for (const line of m[2].split('\n')) {
      const c = /^\s+([a-z_][a-z0-9_]*)\s+(integer|bigint|text|jsonb|boolean|date|timestamptz|numeric\(\d+,\s*\d+\))(.*)$/i.exec(line);
      if (c) cols.set(c[1], { type: c[2].toLowerCase().replace(/\s+/g, ''), rest: c[3] });
    }
    tables.set(m[1], { body: m[2], cols });
  }
  cached = { sql, code, tables };
  return cached;
}
const col = (t, c) => {
  const table = load().tables.get(t);
  assert.ok(table, `table hr.${t} is missing`);
  const found = table.cols.get(c);
  assert.ok(found, `hr.${t}.${c} is missing`);
  return found;
};
const MONTH_RE = String.raw`'^\d{4}-(0[1-9]|1[0-2])$'`;

// ── The checks the brief names ─────────────────────────────────────────

test('brief: the wall, replay safety and money types', () => {
  const { sql } = load();
  assert.match(sql, /set local lock_timeout/i);
  assert.match(sql, /create schema if not exists hr/i);
  for (const m of sql.matchAll(/create table if not exists\s+([\w.]+)/gi)) assert.match(m[1], /^hr\./, m[1]);
  assert.doesNotMatch(sql, /references\s+(public\.|users\b|employees\b)/i);
  assert.doesNotMatch(sql, /\bdrop\s+(table|trigger|schema)\b/i);
  assert.match(sql, /before update or delete on hr\.audit_log/i);
  assert.match(sql, /numeric\(12,\s*2\)/i);
  assert.doesNotMatch(sql, /double precision/i);
  assert.match(fs.readFileSync(dbJs, 'utf8'), /migration\('20261016120000_hr_payroll\.sql'\)/);
});

// ── Spec §7 (+ §6 access): every table and column ──────────────────────

const SPEC = {
  settings: ['key', 'value'],
  pay_channels: ['code', 'label', 'kind', 'bank_name', 'account', 'active'],
  people: ['id', 'code', 'name', 'display_name', 'father_name', 'firm', 'department', 'designation', 'worker_type',
    'status', 'joined_on', 'exited_on', 'phone', 'address', 'emergency_contact', 'pay_channel', 'bank_holder',
    'bank_name', 'bank_account', 'bank_ifsc', 'esi_applicable', 'esi_no', 'pf_uan', 'pan', 'employee_id', 'legacy',
    'notes'],
  person_aliases: ['id', 'person_id', 'alias_norm', 'source', 'approved_by', 'approved_at'],
  pay_setups: ['id', 'person_id', 'effective_from', 'pay_basis', 'base', 'absence_basis', 'absence_divisor',
    'ot_hours_per_day', 'ot_multiplier', 'ot_fixed_rate', 'holiday_mode', 'holiday_divisor', 'holiday_multiplier',
    'holiday_fixed', 'note'],
  import_batches: ['id', 'month', 'file_name', 'file_sha256', 'sheet', 'header_row', 'column_map', 'status', 'counts',
    'uploaded_by', 'uploaded_at', 'applied_by', 'applied_at'],
  import_rows: ['id', 'batch_id', 'row_no', 'raw', 'fields', 'match', 'person_id', 'issues', 'decision', 'decided_by'],
  column_maps: ['id', 'signature', 'field_map', 'blank_zero'],
  runs: ['id', 'month', 'status', 'days_in_month', 'engine_version', 'policy', 'prepared_by', 'prepared_at',
    'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'finalised_by', 'finalised_at', 'sent_back_reason',
    'totals'],
  run_inputs: ['id', 'run_id', 'person_id', 'ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked',
    'misc_earning', 'misc_deduction', 'bonus', 'bill_amount', 'holiday_override', 'paid_separately',
    'paid_separately_note', 'advance_given', 'advance_mode', 'advance_recovery_override', 'loan_recovery_override',
    'include', 'remarks', 'source', 'source_row_id'],
  run_lines: ['id', 'run_id', 'person_id', 'pay_setup_id', 'inputs_hash', 'days', 'present_days', 'daily_rate',
    'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'gross', 'misc_deduction',
    'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions', 'paid_separately', 'net_before_cap',
    'net', 'payable', 'rounding', 'carried_advance', 'flags', 'breakdown', 'pay_channel', 'payment_status',
    'paid_amount', 'paid_at', 'paid_ref'],
  advance_txns: ['id', 'person_id', 'txn_date', 'kind', 'amount', 'run_id', 'source', 'note', 'created_by',
    'created_at', 'reverses_id'],
  loans: ['id', 'loan_no', 'person_id', 'principal', 'issued_on', 'purpose', 'interest_rate', 'instalment',
    'first_due_month', 'status', 'is_opening', 'approved_by', 'approved_at', 'note'],
  loan_txns: ['id', 'loan_id', 'txn_date', 'kind', 'principal_amount', 'interest_amount', 'run_id', 'note',
    'created_by', 'created_at'],
  loan_holidays: ['id', 'loan_id', 'month'],
  adjustments: ['id', 'person_id', 'kind', 'category', 'amount', 'description', 'reference', 'recurrence',
    'start_month', 'end_month', 'status', 'approved_by', 'approved_at', 'created_by', 'created_at'],
  payment_batches: ['id', 'run_id', 'pay_channel', 'count', 'total', 'status', 'reference', 'confirmed_by',
    'confirmed_at'],
  audit_log: ['id', 'at', 'user_id', 'user_name', 'entity', 'entity_id', 'action', 'detail'],
  access: ['user_id', 'level', 'granted_by', 'granted_at', 'note'],
};

test('every table and column of spec §7 is created in schema hr, and nothing else', () => {
  const { tables } = load();
  assert.deepEqual([...tables.keys()].sort(), Object.keys(SPEC).sort());
  for (const [t, cols] of Object.entries(SPEC)) for (const c of cols) col(t, c);
});

// ── Types (controller ruling 1 and 2) ──────────────────────────────────

const MONEY = {
  pay_setups: ['base', 'ot_fixed_rate', 'holiday_fixed'],
  run_inputs: ['misc_earning', 'misc_deduction', 'bonus', 'bill_amount', 'holiday_override', 'paid_separately',
    'advance_given', 'advance_recovery_override', 'loan_recovery_override'],
  run_lines: ['daily_rate', 'basic', 'ot_amount', 'holiday_amount', 'misc_earning', 'bonus', 'adj_earnings', 'gross',
    'misc_deduction', 'adj_deductions', 'loan_recovery', 'advance_recovery', 'total_deductions', 'paid_separately',
    'net_before_cap', 'net', 'payable', 'rounding', 'advance_given', 'carried_advance', 'paid_amount'],
  advance_txns: ['amount'],
  loans: ['principal', 'instalment'],
  loan_txns: ['principal_amount', 'interest_amount'],
  adjustments: ['amount'],
  payment_batches: ['total'],
};
const QUANTITY = {
  pay_setups: ['absence_divisor', 'ot_hours_per_day', 'ot_multiplier', 'holiday_divisor', 'holiday_multiplier'],
  run_inputs: ['ot_hours', 'absent_days', 'paid_leave_days', 'hours_worked'],
  run_lines: ['days', 'present_days', 'days_not_employed'],
  loans: ['interest_rate'],
};
const MONTHS = [['runs', 'month'], ['import_batches', 'month'], ['adjustments', 'start_month'],
  ['adjustments', 'end_month'], ['loans', 'first_due_month'], ['loan_holidays', 'month']];
const DATES = [['people', 'joined_on'], ['people', 'exited_on'], ['loans', 'issued_on'], ['advance_txns', 'txn_date'],
  ['loan_txns', 'txn_date'], ['run_lines', 'paid_on'], ['payment_batches', 'paid_on'], ['pay_setups', 'effective_from']];

test('money is NUMERIC(12,2) and quantities NUMERIC(14,4); no float type anywhere', () => {
  for (const [t, cols] of Object.entries(MONEY)) for (const c of cols) assert.equal(col(t, c).type, 'numeric(12,2)', `hr.${t}.${c}`);
  for (const [t, cols] of Object.entries(QUANTITY)) for (const c of cols) assert.equal(col(t, c).type, 'numeric(14,4)', `hr.${t}.${c}`);
  const { code } = load();
  for (const m of code.matchAll(/\bnumeric\b(\s*\(\s*\d+\s*,\s*\d+\s*\))?/gi)) {
    assert.ok(m[1], 'every numeric names its precision and scale');
    assert.match(m[1].replace(/\s/g, ''), /^\((12,2|14,4)\)$/, m[0]);
  }
  assert.doesNotMatch(code, /\b(real|float[48]?|money|double)\b/i);
});

test('months are TEXT YYYY-MM with the CHECK; dates are DATE; effective_from is the 1st', () => {
  for (const [t, c] of MONTHS) {
    const { type, rest } = col(t, c);
    assert.equal(type, 'text', `hr.${t}.${c}`);
    assert.ok(rest.includes(`check (${c} ~ ${MONTH_RE})`), `hr.${t}.${c} carries the month CHECK`);
  }
  for (const [t, c] of DATES) assert.equal(col(t, c).type, 'date', `hr.${t}.${c}`);
  assert.match(col('pay_setups', 'effective_from').rest, /check \(extract\(day from effective_from\) = 1\)/);
});

// ── Enums (controller ruling 3 and spec §7) ────────────────────────────

const ENUMS = {
  'pay_channels.kind': ['bank', 'cash'],
  'people.worker_type': ['employee', 'contractor'],
  'people.status': ['active', 'on_leave', 'exited'],
  'pay_setups.pay_basis': ['monthly', 'daily', 'hourly', 'contract'],
  'pay_setups.absence_basis': ['calendar_days', 'fixed_divisor'],
  'pay_setups.holiday_mode': ['none', 'formula', 'fixed'],
  'import_batches.status': ['parsed', 'applied', 'superseded', 'discarded'],
  'import_rows.match': ['code', 'exact_name', 'alias', 'manual', 'unmatched', 'ambiguous', 'conflict', 'unknown_code'],
  'import_rows.decision': ['include', 'ignore'],
  'import_rows.advance_mode': ['total', 'extra'],
  'runs.status': ['draft', 'submitted', 'approved', 'finalised'],
  'run_inputs.advance_mode': ['total', 'extra'],
  'run_inputs.source': ['import', 'manual'],
  'run_lines.payment_status': ['pending', 'paid', 'failed', 'reversed'],
  'advance_txns.kind': ['opening', 'given', 'recovered', 'waived', 'adjustment'],
  'loans.status': ['active', 'closed', 'cancelled'],
  'loan_txns.kind': ['disbursed', 'opening', 'payroll_recovery', 'prepayment', 'adjustment', 'waiver'],
  'adjustments.kind': ['earning', 'deduction'],
  'adjustments.recurrence': ['one_time', 'recurring'],
  'adjustments.status': ['pending', 'approved', 'cancelled'],
  'payment_batches.status': ['prepared', 'confirmed'],
  'access.level': ['viewer', 'operator', 'approver', 'admin'],
};

test('every enum has its CHECK with exactly the listed values', () => {
  for (const [key, values] of Object.entries(ENUMS)) {
    const [t, c] = key.split('.');
    const m = new RegExp(`check \\(${c} in \\(([^)]*)\\)\\)`).exec(col(t, c).rest);
    assert.ok(m, `${key} has a CHECK … IN (…)`);
    assert.deepEqual(m[1].split(',').map(v => v.trim().replace(/^'|'$/g, '')), values, key);
  }
  assert.doesNotMatch(load().code, /finalized/i, "the spelling is 'finalised' everywhere");
});

test('defaults the engine and the import rely on', () => {
  assert.match(col('run_inputs', 'advance_mode').rest, /not null default 'total'/);
  assert.match(col('import_rows', 'advance_mode').rest, /not null default 'total'/);
  assert.match(col('run_lines', 'payment_status').rest, /not null default 'pending'/);
  assert.match(col('runs', 'status').rest, /not null default 'draft'/);
  assert.match(col('run_inputs', 'include').rest, /not null default true/);
  // An advance row says where it came from: a NULL or a guessed default would let a payroll
  // posting pass for an in-app advance (or the reverse) and count one advance twice.
  assert.match(col('advance_txns', 'source').rest, /^\s*not null,/);
  assert.match(col('run_inputs', 'source').rest, /^\s*not null check/);
});

// ── Integrity ──────────────────────────────────────────────────────────

test('the partial uniques that stop double posting and the same file twice', () => {
  const { code } = load();
  const flat = code.replace(/\s+/g, ' ');
  assert.match(flat, /create unique index if not exists \w+ on hr\.advance_txns \(run_id, person_id, kind\) where run_id is not null;/);
  assert.match(flat, /create unique index if not exists \w+ on hr\.loan_txns \(loan_id, run_id\) where kind = 'payroll_recovery';/);
  assert.match(flat, /create unique index if not exists \w+ on hr\.import_batches \(month, file_sha256\) where status <> 'discarded';/);
  assert.match(flat, /create unique index if not exists \w+ on hr\.people \(employee_id\) where employee_id is not null;/);
});

test('foreign keys stay inside hr; links to public are plain integers', () => {
  const { code } = load();
  const refs = [...code.matchAll(/references\s+([\w.]+)/gi)].map(m => m[1]);
  assert.ok(refs.length >= 15, `found only ${refs.length} foreign keys`);
  for (const r of refs) assert.match(r, /^hr\./, r);
  assert.doesNotMatch(code, /\bforeign key\b/i);
  // The soft links: hr.access.user_id and hr.people.employee_id carry no constraint to public.
  assert.match(col('access', 'user_id').rest, /^\s*primary key,\s*$/);
  assert.match(col('people', 'employee_id').rest, /^\s*,\s*$/);
});

// ── Replay safety (controller ruling 6) ────────────────────────────────

test('the migration opens with a transaction-local lock timeout', () => {
  const { code } = load();
  assert.match(code.trimStart(), /^set local lock_timeout = '1s';/, 'the first statement');
  assert.doesNotMatch(code, /(^|\n)\s*set\s+lock_timeout/i, 'a plain SET survives on a pooled connection');
});

test('every statement is idempotent and nothing is ever dropped', () => {
  const { code } = load();
  assert.doesNotMatch(code, /\bdrop\b/i);
  assert.doesNotMatch(code, /\btruncate\s+(table\s+)?hr\./i);
  for (const m of code.matchAll(/create\s+(unique\s+)?index\b(\s+if not exists)?/gi)) assert.ok(m[2], m[0]);
  for (const m of code.matchAll(/create\s+table\b(\s+if not exists)?/gi)) assert.ok(m[1], m[0]);
  for (const m of code.matchAll(/create\s+schema\b(\s+if not exists)?/gi)) assert.ok(m[1], m[0]);
  assert.doesNotMatch(code, /(^|\n)\s*create\s+(trigger|function)\b/i, 'CREATE OR REPLACE, so a replay needs no drop');
  const inserts = code.split(';').filter(s => /\binsert\s+into\b/i.test(s));
  assert.ok(inserts.length >= 2, 'the settings seed and the access bootstrap');
  for (const s of inserts) assert.match(s, /on conflict do nothing\s*$/i, s.trim().split('\n')[0]);
  assert.doesNotMatch(code, /\b(update|delete\s+from)\s+hr\.\w+\s+(set|where)\b/i, 'no data is rewritten on a replay');
});

// ── The wall (controller ruling 5) ─────────────────────────────────────

test('RLS on for every hr table, never forced, no policies, nothing granted', () => {
  const { code } = load();
  const flat = code.replace(/\s+/g, ' ');
  assert.match(flat, /where n\.nspname = 'hr' and c\.relkind in \('r', 'p'\) and not c\.relrowsecurity/);
  assert.match(flat, /alter table %s enable row level security/);
  assert.doesNotMatch(code, /force row level security/i, 'FORCE would hide the rows from the server itself');
  assert.doesNotMatch(code, /create\s+policy/i);
  assert.doesNotMatch(code, /\bgrant\b/i);
});

test('every privilege on the schema is revoked from PUBLIC, anon and authenticated', () => {
  const flat = load().code.replace(/\s+/g, ' ');
  for (const role of ['public', 'anon', 'authenticated']) {
    for (const what of ['schema hr', 'all tables in schema hr', 'all sequences in schema hr', 'all functions in schema hr']) {
      assert.match(flat, new RegExp(`revoke all on ${what} from ${role};`), `${what} from ${role}`);
    }
  }
  for (const role of ['anon', 'authenticated']) {
    assert.match(flat, new RegExp(`if exists \\(select 1 from pg_catalog\\.pg_roles where rolname = '${role}'\\) then`),
      `${role} is revoked only where Supabase made it`);
  }
});

test('the audit log is append-only', () => {
  const flat = load().code.replace(/\s+/g, ' ');
  assert.match(flat, /create or replace function hr\.audit_log_immutable\(\) returns trigger/);
  assert.match(flat, /create or replace trigger \w+ before update or delete on hr\.audit_log for each row execute function hr\.audit_log_immutable\(\);/);
  assert.match(flat, /create or replace trigger \w+ before truncate on hr\.audit_log for each statement execute function hr\.audit_log_immutable\(\);/);
});

// ── Seeds ──────────────────────────────────────────────────────────────

test('settings defaults and the access bootstrap', () => {
  const { code } = load();
  const flat = code.replace(/\s+/g, ' ');
  const seeds = {
    rounding: `'"rupee"'`, ot_high_hours: `'150'`, deduction_warn_pct: `'50'`, variance_warn_pct: `'25'`,
    holiday_divisor_default: `'30.5'`, strict_separation: `'false'`,
    blank_zero: `'{"ot_hours": true, "absent_days": true, "misc_earning": true, "advance_given": true, "bill_amount": true}'`,
  };
  for (const [k, v] of Object.entries(seeds)) assert.ok(flat.includes(`('${k}', ${v})`), `setting ${k} = ${v}`);
  assert.ok(flat.includes(
    "insert into hr.access(user_id, level, granted_by, note) select id, 'admin', id, 'bootstrap' from public.users where lower(email) = 'md@motionci.com' on conflict do nothing;"),
  'the bootstrap, verbatim');
  assert.doesNotMatch(code, /insert\s+into\s+hr\.pay_channels/i, 'pay channels are business data: never seeded');
});

// ── db.js replays it, last ─────────────────────────────────────────────

test('init() replays the migration after the last one, with its comment', () => {
  const src = fs.readFileSync(dbJs, 'utf8');
  const line = src.indexOf("await pool.query(migration('20261016120000_hr_payroll.sql'));");
  assert.ok(line > 0, 'the replay line');
  assert.ok(line > src.indexOf("migration('20261006180000_sales_order_drafts.sql')"), 'after the last migration');
  assert.match(src, /\/\/ HR & Payroll \(schema hr\) — 2026-10-16\n\s*await pool\.query\(migration\('20261016120000_hr_payroll\.sql'\)\);/);
  assert.equal(src.split("migration('20261016120000_hr_payroll.sql')").length, 2, 'replayed once');
});
