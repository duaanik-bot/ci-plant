-- HR & PAYROLL, Phase 1: the whole `hr` schema
-- (docs/superpowers/specs/2026-10-16-hr-payroll-design.md, sections 5 to 7).
--
-- Salary, bank and loan data live here and nowhere else. The schema is a wall:
--   * Every table is in schema hr, and no foreign key leaves it. Users, ERP operators
--     and plant rows are joined by id in code (soft links), so plant data can never
--     block, slow or cascade into payroll, and the dev seed's TRUNCATE ... CASCADE on
--     plant tables can never reach it.
--   * Row-level security is on for every hr table, with no policies, and every
--     privilege on the schema, its tables, sequences and functions is revoked from
--     PUBLIC and from Supabase's anon and authenticated roles. Nothing is granted.
--     The ERP server connects as the owner of these tables, which RLS without FORCE
--     does not restrict (as with plate_* and avs.*).
--   * hr.audit_log is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE.
--
-- Types: money NUMERIC(12,2); hours, days, divisors, multipliers and rates
-- NUMERIC(14,4); months TEXT 'YYYY-MM' (checked); calendar dates DATE; moments
-- TIMESTAMPTZ. Ids are identity keys. A column ending _by holds the id of a
-- public.users row; user_id and employee_id are soft links of the same kind.
-- People are never deleted: they leave with status 'exited'.
--
-- NOT applied to production yet (go-live, spec section 20, needs Anik's say-so).
-- Mirrored locally by server/src/db.js init(), which replays this file on every
-- boot, so every statement is idempotent: IF NOT EXISTS, CREATE OR REPLACE,
-- ON CONFLICT DO NOTHING; nothing is ever removed or rewritten.
--
-- LOCKS: new tables only. On a replay, CREATE INDEX IF NOT EXISTS takes a brief
-- SHARE lock and CREATE OR REPLACE TRIGGER a SHARE ROW EXCLUSIVE lock on the hr
-- table concerned (neither blocks a reader), and RLS is only switched on where it
-- is still off. public.users is read once, for the bootstrap grant.
set local lock_timeout = '1s';

create schema if not exists hr;

-- ── Policy ────────────────────────────────────────────────────────────────────

-- rounding, OT threshold, holiday divisor default, deduction-warning %, variance %,
-- strict separation of duties, blank-as-zero defaults (seeded at the end).
create table if not exists hr.settings (
  key        text primary key,
  value      jsonb not null,
  updated_by integer,
  updated_at timestamptz not null default now()
);

-- How people are paid: a company bank allocation, other banks, cash. Created by the
-- workbook loader or in Settings, never seeded: business data stays out of this repo.
create table if not exists hr.pay_channels (
  code       text primary key check (btrim(code) <> ''),
  label      text not null,
  kind       text not null check (kind in ('bank', 'cash')),
  bank_name  text,
  account    text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── People ────────────────────────────────────────────────────────────────────

create table if not exists hr.people (
  id                integer generated always as identity primary key,
  code              text not null unique check (btrim(code) <> ''),
  name              text not null check (btrim(name) <> ''),
  display_name      text,
  father_name       text,
  firm              text,
  department        text,
  designation       text,
  worker_type       text not null default 'employee' check (worker_type in ('employee', 'contractor')),
  status            text not null default 'active' check (status in ('active', 'on_leave', 'exited')),
  joined_on         date,
  exited_on         date,
  phone             text,
  address           text,
  emergency_contact text,
  pay_channel       text references hr.pay_channels (code),
  bank_holder       text,
  bank_name         text,
  bank_account      text,
  bank_ifsc         text,
  esi_applicable    boolean not null default false,
  esi_no            text,
  pf_uan            text,
  pan               text,
  employee_id       integer,
  legacy            jsonb not null default '{}'::jsonb,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (exited_on is null or joined_on is null or exited_on >= joined_on)
);
-- employee_id: the ERP operator this person is (soft link, checked in code); one each.
create unique index if not exists people_employee_id_uq
  on hr.people (employee_id) where employee_id is not null;

-- Spellings of a name that Anik approved once (match.js normName()).
create table if not exists hr.person_aliases (
  id          integer generated always as identity primary key,
  person_id   integer not null references hr.people (id),
  alias_norm  text not null unique check (btrim(alias_norm) <> ''),
  source      text not null default 'manual',
  approved_by integer,
  approved_at timestamptz not null default now()
);
create index if not exists person_aliases_person_idx on hr.person_aliases (person_id);

-- Pay revisions, each from the 1st of a month. A setup a run has used is never
-- edited, only superseded by a later one.
create table if not exists hr.pay_setups (
  id                 integer generated always as identity primary key,
  person_id          integer not null references hr.people (id),
  effective_from     date not null check (extract(day from effective_from) = 1),
  pay_basis          text not null check (pay_basis in ('monthly', 'daily', 'hourly', 'contract')),
  base               numeric(12,2) check (base >= 0),
  absence_basis      text not null default 'calendar_days' check (absence_basis in ('calendar_days', 'fixed_divisor')),
  absence_divisor    numeric(14,4) check (absence_divisor > 0),
  ot_hours_per_day   numeric(14,4) not null default 0 check (ot_hours_per_day >= 0),
  ot_multiplier      numeric(14,4) not null default 1 check (ot_multiplier >= 0),
  ot_fixed_rate      numeric(12,2) check (ot_fixed_rate >= 0),
  holiday_mode       text not null default 'none' check (holiday_mode in ('none', 'formula', 'fixed')),
  holiday_divisor    numeric(14,4) check (holiday_divisor > 0),
  holiday_multiplier numeric(14,4) check (holiday_multiplier >= 0),
  holiday_fixed      numeric(12,2) check (holiday_fixed >= 0),
  note               text,
  created_by         integer,
  created_at         timestamptz not null default now(),
  unique (person_id, effective_from),
  -- What each basis needs to compute at all (a contract is paid its monthly bill amount).
  check (pay_basis = 'contract' or base is not null),
  check (absence_basis <> 'fixed_divisor' or absence_divisor is not null),
  check (holiday_mode <> 'fixed' or holiday_fixed is not null)
);

-- ── Monthly Excel import ──────────────────────────────────────────────────────

create table if not exists hr.import_batches (
  id          integer generated always as identity primary key,
  month       text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  file_name   text,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  sheet       text,
  header_row  integer check (header_row >= 0),
  headers     jsonb,
  signature   text,
  column_map  jsonb,
  blank_zero  jsonb not null default '{}'::jsonb,
  status      text not null default 'parsed' check (status in ('parsed', 'applied', 'superseded', 'discarded')),
  counts      jsonb not null default '{}'::jsonb,
  uploaded_by integer,
  uploaded_at timestamptz not null default now(),
  applied_by  integer,
  applied_at  timestamptz
);
-- The same file twice for one month is caught, unless the earlier copy was discarded.
create unique index if not exists import_batches_month_file_uq
  on hr.import_batches (month, file_sha256) where status <> 'discarded';

-- One sheet row as read (raw) and as parsed (fields: exact decimal strings, null
-- for a blank cell). Source input only: calculated pay never lives here.
create table if not exists hr.import_rows (
  id           integer generated always as identity primary key,
  batch_id     integer not null references hr.import_batches (id),
  row_no       integer not null check (row_no >= 1),
  raw          jsonb not null,
  fields       jsonb not null default '{}'::jsonb,
  match        text not null default 'unmatched' check (match in ('code', 'exact_name', 'alias', 'manual', 'unmatched', 'ambiguous', 'conflict', 'unknown_code')),
  person_id    integer references hr.people (id),
  candidates   jsonb not null default '[]'::jsonb,
  issues       jsonb not null default '[]'::jsonb,
  advance_mode text not null default 'total' check (advance_mode in ('total', 'extra')),
  decision     text check (decision in ('include', 'ignore')),
  decided_by   integer,
  decided_at   timestamptz,
  unique (batch_id, row_no),
  -- Nothing is processed on an uncertain match: a row names a person exactly when the
  -- match is certain (code, exact name, approved alias) or the person was picked by hand.
  -- Candidates (suggestions) never fill person_id.
  check ((match in ('code', 'exact_name', 'alias', 'manual')) = (person_id is not null)),
  check (decision is distinct from 'include' or person_id is not null)
);
create index if not exists import_rows_person_idx on hr.import_rows (person_id);

-- A confirmed column map, by header signature, applied automatically next month.
create table if not exists hr.column_maps (
  id         integer generated always as identity primary key,
  signature  text not null unique,
  field_map  jsonb not null,
  blank_zero jsonb not null default '{}'::jsonb,
  created_by integer,
  created_at timestamptz not null default now(),
  updated_by integer,
  updated_at timestamptz not null default now()
);

-- ── Payroll runs ──────────────────────────────────────────────────────────────

create table if not exists hr.runs (
  id               integer generated always as identity primary key,
  month            text not null unique check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status           text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'finalised')),
  days_in_month    integer not null,
  engine_version   text,
  policy           jsonb not null default '{}'::jsonb,
  prepared_by      integer,
  prepared_at      timestamptz,
  submitted_by     integer,
  submitted_at     timestamptz,
  approved_by      integer,
  approved_at      timestamptz,
  finalised_by     integer,
  finalised_at     timestamptz,
  sent_back_by     integer,
  sent_back_at     timestamptz,
  sent_back_reason text,
  totals           jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  -- The month decides its length: 28 for 2026-02, 29 for 2028-02, 30 for 2026-09.
  -- (A malformed month is left to the month CHECK above.)
  constraint runs_days_in_month_check check (
    case when month ~ '^\d{4}-(0[1-9]|1[0-2])$'
         then days_in_month = extract(day from make_date(substr(month, 1, 4)::int, substr(month, 6, 2)::int, 1)
                                                + interval '1 month' - interval '1 day')
    end)
);

-- The month's inputs per person, from the import or typed in. Kept apart from the
-- results (run_lines) so a locked month can be re-explained exactly. NULL = not given.
create table if not exists hr.run_inputs (
  id                        integer generated always as identity primary key,
  run_id                    integer not null references hr.runs (id),
  person_id                 integer not null references hr.people (id),
  ot_hours                  numeric(14,4) check (ot_hours >= 0),
  absent_days               numeric(14,4) check (absent_days >= 0),
  paid_leave_days           numeric(14,4) check (paid_leave_days >= 0),
  hours_worked              numeric(14,4) check (hours_worked >= 0),
  misc_earning              numeric(12,2) check (misc_earning >= 0),
  misc_deduction            numeric(12,2) check (misc_deduction >= 0),
  bonus                     numeric(12,2) check (bonus >= 0),
  bill_amount               numeric(12,2) check (bill_amount >= 0),
  holiday_override          numeric(12,2) check (holiday_override >= 0),
  paid_separately           numeric(12,2) check (paid_separately >= 0),
  paid_separately_note      text,
  advance_given             numeric(12,2) check (advance_given >= 0),
  advance_mode              text not null default 'total' check (advance_mode in ('total', 'extra')),
  advance_recovery_override numeric(12,2) check (advance_recovery_override >= 0),
  loan_recovery_override    numeric(12,2) check (loan_recovery_override >= 0),
  include                   boolean not null default true,
  remarks                   text,
  source                    text not null check (source in ('import', 'manual')),
  source_row_id             integer references hr.import_rows (id),
  updated_by                integer,
  updated_at                timestamptz not null default now(),
  unique (run_id, person_id)
);
create index if not exists run_inputs_person_idx on hr.run_inputs (person_id);

-- One channel's payment of a finalised run: its lines are marked paid with the
-- bank reference and date. Finalising is never proof of payment.
create table if not exists hr.payment_batches (
  id           integer generated always as identity primary key,
  run_id       integer not null references hr.runs (id),
  pay_channel  text not null,
  count        integer not null default 0 check (count >= 0),
  total        numeric(12,2) not null default 0 check (total >= 0),
  status       text not null default 'prepared' check (status in ('prepared', 'confirmed')),
  reference    text,
  paid_on      date,
  confirmed_by integer,
  confirmed_at timestamptz,
  created_by   integer,
  created_at   timestamptz not null default now()
);
create index if not exists payment_batches_run_idx on hr.payment_batches (run_id);

-- The engine's result per person (server/src/hr/engine.js computeLine), with the
-- setup and engine version it used. net_before_cap may be negative: it is the
-- workbook's "Final Payment". loan_recovery and advance_recovery are after the cap.
-- breakdown is [{code, label, kind, qty, rate, formula, amount}].
create table if not exists hr.run_lines (
  id                integer generated always as identity primary key,
  run_id            integer not null references hr.runs (id),
  person_id         integer not null references hr.people (id),
  pay_setup_id      integer references hr.pay_setups (id),
  engine_version    text,
  inputs_hash       text,
  days              numeric(14,4),
  present_days      numeric(14,4),
  days_not_employed numeric(14,4),
  daily_rate        numeric(12,2),
  basic             numeric(12,2),
  ot_amount         numeric(12,2),
  holiday_amount    numeric(12,2),
  misc_earning      numeric(12,2),
  bonus             numeric(12,2),
  adj_earnings      numeric(12,2),
  gross             numeric(12,2),
  misc_deduction    numeric(12,2),
  adj_deductions    numeric(12,2),
  loan_recovery     numeric(12,2),
  advance_recovery  numeric(12,2),
  loan_recoveries   jsonb not null default '[]'::jsonb,
  total_deductions  numeric(12,2),
  paid_separately   numeric(12,2),
  net_before_cap    numeric(12,2),
  net               numeric(12,2),
  payable           numeric(12,2),
  rounding          numeric(12,2),
  advance_given     numeric(12,2),
  carried_advance   numeric(12,2),
  unrecovered       jsonb not null default '{}'::jsonb,
  flags             jsonb not null default '[]'::jsonb,
  breakdown         jsonb not null default '[]'::jsonb,
  exact             jsonb,
  pay_channel       text,
  payment_status    text not null default 'pending' check (payment_status in ('pending', 'paid', 'failed', 'reversed')),
  payment_batch_id  integer references hr.payment_batches (id),
  paid_amount       numeric(12,2),
  paid_on           date,
  paid_at           timestamptz,
  paid_ref          text,
  computed_at       timestamptz not null default now(),
  unique (run_id, person_id)
);
create index if not exists run_lines_person_idx on hr.run_lines (person_id);

-- ── Advances ──────────────────────────────────────────────────────────────────

-- Balance = opening + given + adjustment - recovered - waived, always summed, never
-- stored. source: manual (Give advance, in the app), payroll (posted at finalise), ...
create table if not exists hr.advance_txns (
  id          integer generated always as identity primary key,
  person_id   integer not null references hr.people (id),
  txn_date    date not null,
  kind        text not null check (kind in ('opening', 'given', 'recovered', 'waived', 'adjustment')),
  amount      numeric(12,2) not null check (amount > 0),
  run_id      integer references hr.runs (id),
  source      text not null,
  note        text,
  created_by  integer,
  created_at  timestamptz not null default now(),
  reverses_id integer references hr.advance_txns (id)
);
create index if not exists advance_txns_person_idx on hr.advance_txns (person_id);
-- A run posts each kind of advance row for a person once, so a second finalise
-- cannot post twice.
create unique index if not exists advance_txns_run_once_uq
  on hr.advance_txns (run_id, person_id, kind) where run_id is not null;
-- A row is reversed at most once.
create unique index if not exists advance_txns_reverses_uq
  on hr.advance_txns (reverses_id) where reverses_id is not null;

-- ── Loans ─────────────────────────────────────────────────────────────────────

create table if not exists hr.loans (
  id              integer generated always as identity primary key,
  loan_no         text not null unique check (loan_no ~ '^CI-LN-[0-9]{4,}$'),
  person_id       integer not null references hr.people (id),
  principal       numeric(12,2) not null check (principal > 0),
  issued_on       date not null,
  purpose         text,
  interest_rate   numeric(14,4) not null default 0 check (interest_rate = 0),
  instalment      numeric(12,2) not null check (instalment > 0),
  first_due_month text not null check (first_due_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  paid_via        text,
  status          text not null default 'active' check (status in ('active', 'closed', 'cancelled')),
  is_opening      boolean not null default false,
  approved_by     integer,
  approved_at     timestamptz,
  note            text,
  created_by      integer,
  created_at      timestamptz not null default now()
);
-- interest_rate: Phase 1 loans are interest-free (spec section 11); Phase 2 lifts the CHECK.
create index if not exists loans_person_idx on hr.loans (person_id);

-- Outstanding = disbursed + opening - payroll_recovery - prepayment - waiver,
-- +/- adjustment (server/src/hr/loans.js), always summed, never stored.
create table if not exists hr.loan_txns (
  id               integer generated always as identity primary key,
  loan_id          integer not null references hr.loans (id),
  txn_date         date not null,
  kind             text not null check (kind in ('disbursed', 'opening', 'payroll_recovery', 'prepayment', 'adjustment', 'waiver')),
  principal_amount numeric(12,2) not null,
  interest_amount  numeric(12,2) not null default 0 check (interest_amount >= 0),
  run_id           integer references hr.runs (id),
  note             text,
  created_by       integer,
  created_at       timestamptz not null default now(),
  -- The kind gives the direction, so the amount is positive; only an adjustment is signed.
  check (principal_amount > 0 or (kind = 'adjustment' and principal_amount <> 0)),
  -- A payroll recovery always names its run, so the once-per-run key below holds.
  check (kind <> 'payroll_recovery' or run_id is not null)
);
create index if not exists loan_txns_loan_idx on hr.loan_txns (loan_id);
-- Recovered at most once per loan per run.
create unique index if not exists loan_txns_recovery_once_uq
  on hr.loan_txns (loan_id, run_id) where kind = 'payroll_recovery';

-- A month in which no instalment is due.
create table if not exists hr.loan_holidays (
  id         integer generated always as identity primary key,
  loan_id    integer not null references hr.loans (id),
  month      text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note       text,
  created_by integer,
  created_at timestamptz not null default now(),
  unique (loan_id, month)
);

-- ── Adjustments ───────────────────────────────────────────────────────────────

-- Arrears, recoveries and other earnings or deductions, once or for a range of months.
create table if not exists hr.adjustments (
  id          integer generated always as identity primary key,
  person_id   integer not null references hr.people (id),
  kind        text not null check (kind in ('earning', 'deduction')),
  category    text,
  amount      numeric(12,2) not null check (amount > 0),
  description text,
  reference   text,
  recurrence  text not null default 'one_time' check (recurrence in ('one_time', 'recurring')),
  start_month text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month   text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'cancelled')),
  approved_by integer,
  approved_at timestamptz,
  created_by  integer,
  created_at  timestamptz not null default now(),
  -- Recurring needs both ends, in order; one-time never repeats.
  check (recurrence <> 'recurring' or (end_month is not null and end_month >= start_month)),
  check (recurrence <> 'one_time' or end_month is null or end_month = start_month)
);
create index if not exists adjustments_person_idx on hr.adjustments (person_id);

-- ── Audit and access ──────────────────────────────────────────────────────────

-- HR's own trail (server/src/hr/audit.js hrAudit). Never the plant audit_log, which
-- /timeline shows to every login.
create table if not exists hr.audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  user_id   integer,
  user_name text,
  entity    text not null,
  entity_id text,
  action    text not null,
  detail    jsonb
);
create index if not exists audit_log_entity_idx on hr.audit_log (entity, entity_id, id);
create index if not exists audit_log_at_idx on hr.audit_log (at);

create or replace function hr.audit_log_immutable() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception 'hr.audit_log is append-only: % refused', tg_op
    using hint = 'Write a new audit row instead.';
end
$$;

create or replace trigger audit_log_immutable
  before update or delete on hr.audit_log
  for each row execute function hr.audit_log_immutable();

create or replace trigger audit_log_no_truncate
  before truncate on hr.audit_log
  for each statement execute function hr.audit_log_immutable();

-- Who may open HR & Payroll, and how far (server/src/hr/access.js). Read fresh on every
-- request, never from the JWT. Each level includes the ones before it.
create table if not exists hr.access (
  user_id    integer primary key,
  level      text not null check (level in ('viewer', 'operator', 'approver', 'admin')),
  granted_by integer,
  granted_at timestamptz not null default now(),
  note       text
);

-- ── The wall ──────────────────────────────────────────────────────────────────

-- RLS on for every hr table, with no policies (switched on only where still off, so a
-- replay takes no lock for it).
do $$
declare
  t regclass;
begin
  for t in
    select c.oid::regclass
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'hr' and c.relkind in ('r', 'p') and not c.relrowsecurity
  loop
    execute pg_catalog.format('alter table %s enable row level security', t);
  end loop;
end
$$;

revoke all on schema hr from public;
revoke all on all tables in schema hr from public;
revoke all on all sequences in schema hr from public;
revoke all on all functions in schema hr from public;

-- Supabase's API roles: revoked where they exist (a local database has neither).
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on schema hr from anon;
    revoke all on all tables in schema hr from anon;
    revoke all on all sequences in schema hr from anon;
    revoke all on all functions in schema hr from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on schema hr from authenticated;
    revoke all on all tables in schema hr from authenticated;
    revoke all on all sequences in schema hr from authenticated;
    revoke all on all functions in schema hr from authenticated;
  end if;
end
$$;

-- ── Seeds ─────────────────────────────────────────────────────────────────────

-- Policy defaults. A replay never overwrites what Settings has changed since.
insert into hr.settings (key, value) values
  ('rounding', '"rupee"'),
  ('ot_high_hours', '150'),
  ('deduction_warn_pct', '50'),
  ('variance_warn_pct', '25'),
  ('holiday_divisor_default', '30.5'),
  ('strict_separation', 'false'),
  ('blank_zero', '{"ot_hours": true, "absent_days": true, "misc_earning": true, "advance_given": true, "bill_amount": true}')
on conflict do nothing;

-- Bootstrap: the MD's login starts as HR admin, if it exists; nobody else has access
-- until he grants it in Settings. A replay never changes a level set since.
insert into hr.access(user_id, level, granted_by, note)
select id, 'admin', id, 'bootstrap' from public.users where lower(email) = 'md@motionci.com'
on conflict do nothing;
