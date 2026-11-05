-- HR & PAYROLL: BULK ADVANCE SHEETS (owner's request, 2026-11-05: "near the 24th or 25th we give advances to most of
-- our employees — a bulk form like Excel with all the people; export it as PDF / Excel for management; take approval
-- from management in the software, notifying them; advance by default, or a loan with months and why; then payroll
-- takes it up").
--
--   hr.advance_sheets       one sheet per bulk round: the payroll month it is for, the date it is paid, how it is
--                           paid (cash or a pay channel), status draft → submitted → posted (and back to draft when
--                           management sends it back). Numbered CI-ADV-0001 …
--   hr.advance_sheet_lines  one per person on the sheet: advance or loan, the amount, for a loan the months and the
--                           reason; the preparer's remarks, management's remarks and decision (pending / approved /
--                           rejected, who, when); once posted, the advance_txns or loans row it became.
-- Posting goes through the same path as Pay staff (routes/hr-ledgers.js), so payroll recovers it exactly as any advance
-- or loan given in the app. Replayed by db.js init(): idempotent; tables are created only when missing.
set local lock_timeout = '1s';

do $$
begin
  if to_regclass('hr.advance_sheets') is null then
    create table hr.advance_sheets (
      id           integer generated always as identity primary key,
      sheet_no     text not null unique,
      month        text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
      paid_on      date not null,
      paid_via     text not null default 'cash',
      status       text not null default 'draft' check (status in ('draft', 'submitted', 'posted')),
      note         text,
      created_by   integer,
      created_at   timestamptz not null default now(),
      submitted_by integer,
      submitted_at timestamptz,
      sent_back_by integer,
      sent_back_at timestamptz,
      sent_back_reason text,
      posted_by    integer,
      posted_at    timestamptz
    );
    alter table hr.advance_sheets enable row level security;
    revoke all on hr.advance_sheets from public;
  end if;

  if to_regclass('hr.advance_sheet_lines') is null then
    create table hr.advance_sheet_lines (
      id           integer generated always as identity primary key,
      sheet_id     integer not null references hr.advance_sheets (id) on delete cascade,
      person_id    integer not null references hr.people (id),
      kind         text not null default 'advance' check (kind in ('advance', 'loan')),
      amount       numeric(12,2) not null check (amount > 0),
      instalments  integer check (instalments is null or instalments between 1 and 120),
      purpose      text,
      remarks      text,
      mgmt_remarks text,
      decision     text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
      decided_by   integer,
      decided_at   timestamptz,
      advance_txn_id integer,
      loan_id      integer,
      posted_at    timestamptz,
      unique (sheet_id, person_id),
      check (kind = 'advance' or instalments is not null)
    );
    create index advance_sheet_lines_sheet_idx on hr.advance_sheet_lines (sheet_id);
    alter table hr.advance_sheet_lines enable row level security;
    revoke all on hr.advance_sheet_lines from public;
    -- Their identity sequences, as every hr sequence (done here, once, so a replay changes nothing).
    revoke all on all sequences in schema hr from public;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on hr.advance_sheets, hr.advance_sheet_lines from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on hr.advance_sheets, hr.advance_sheet_lines from authenticated;
  end if;
end
$$;
