-- HR & PAYROLL: a payroll line can be put ON HOLD (owner's request, 2026-10-17).
--
-- Each person's line in a month's run already carries a payment status: pending (shown
-- as "Unpaid"), paid, failed or reversed. This adds on_hold — the money is not to go out
-- until somebody releases it — and the columns that say why and who:
--   hold_reason  why the line is on hold (required by the route that holds it)
--   held_by      the public.users id who put it on hold (a soft link, like every *_by)
--   held_at      when
--   status_note  the note given with the latest status change (e.g. why a paid line was
--                marked unpaid again); the full history is in hr.audit_log
--
-- Replayed by server/src/db.js init() on every boot, right after 20261016120000_hr_payroll.sql,
-- so it is idempotent AND lock-free on a replay: every change sits in one DO block that
-- looks at the catalogue first and alters hr.run_lines only when something is missing.
-- A database that already has all of it is never ALTERed again (no ACCESS EXCLUSIVE
-- lock on a boot). The CHECK keeps its name, run_lines_payment_status_check (the name
-- Postgres gave the inline CHECK of the first migration), and is swapped only while it
-- does not yet allow on_hold. Nothing is dropped except that one constraint, which is
-- re-added in the same transaction; no row is rewritten.
set local lock_timeout = '1s';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'hold_reason') then
    alter table hr.run_lines add column if not exists hold_reason text;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'held_by') then
    alter table hr.run_lines add column if not exists held_by integer;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'held_at') then
    alter table hr.run_lines add column if not exists held_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'status_note') then
    alter table hr.run_lines add column if not exists status_note text;
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'hr.run_lines'::regclass
                    and c.conname = 'run_lines_payment_status_check'
                    and pg_catalog.pg_get_constraintdef(c.oid) like '%on_hold%') then
    alter table hr.run_lines drop constraint if exists run_lines_payment_status_check;
    alter table hr.run_lines add constraint run_lines_payment_status_check
      check (payment_status in ('pending', 'paid', 'on_hold', 'failed', 'reversed'));
  end if;
end
$$;
