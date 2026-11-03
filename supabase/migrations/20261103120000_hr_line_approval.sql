-- HR & PAYROLL: per-person PAYMENT APPROVAL on a run line, and numbered payment batches
-- (owner's request, 2026-11-03).
--
-- After a month's salary is approved (the run), each person's line is approved for payment one
-- by one or many at once, or the approval is undone (with a reason). Only an approved line can be
-- marked paid; a hold still stops the money any time. The columns:
--   hr.run_lines.approval_status  'unapproved' (the default) | 'approved'
--   hr.run_lines.approved_by      the public.users id who approved it (a soft link, like every *_by)
--   hr.run_lines.approved_at      when
--   hr.run_lines.approval_note    the note given with the approval, or the reason it was undone
--   hr.payment_batches.batch_no   CI-PAY-0001 …, minted by nextNumber() for every "Mark paid" of a set
-- The full decision history is in hr.audit_log.
--
-- Replayed by server/src/db.js init() on every boot, right after the HR migrations, so it is
-- idempotent AND lock-free on a replay: every change sits in one DO block that looks at the
-- catalogue first and alters a table only when something is missing. A database that already has
-- all of it is never ALTERed again (no ACCESS EXCLUSIVE lock on a boot). Nothing is dropped.
--
-- The two one-time fills run only in the same branch that adds their column, so a replay never
-- touches a row again:
--   * a line already PAID before this existed is recorded as approved (approved_by stays null, the
--     note says why), so "paid ⇒ approved" holds for every month and the reconciliation closes;
--   * a payment batch made before batch_no existed gets its number in id order.
set local lock_timeout = '1s';

do $$
declare
  fresh boolean := not exists (select 1 from information_schema.columns
                                where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'approval_status');
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'approved_by') then
    alter table hr.run_lines add column if not exists approved_by integer;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'approved_at') then
    alter table hr.run_lines add column if not exists approved_at timestamptz;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'run_lines' and column_name = 'approval_note') then
    alter table hr.run_lines add column if not exists approval_note text;
  end if;
  if fresh then
    alter table hr.run_lines add column if not exists approval_status text not null default 'unapproved'
      constraint run_lines_approval_status_check check (approval_status in ('unapproved', 'approved'));
    -- One time only (the branch that adds the column): a line paid before this existed counts as approved.
    update hr.run_lines
       set approval_status = 'approved',
           approved_at = coalesce(paid_at, now()),
           approval_note = 'Paid before per-person payment approval existed (recorded as approved by migration 20261103120000)'
     where payment_status = 'paid';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'hr' and table_name = 'payment_batches' and column_name = 'batch_no') then
    alter table hr.payment_batches add column if not exists batch_no text
      constraint payment_batches_batch_no_key unique;
    -- One time only: the batches made before batch_no existed are numbered in id order.
    update hr.payment_batches b
       set batch_no = 'CI-PAY-' || lpad(n.rn::text, 4, '0')
      from (select id, row_number() over (order by id) as rn from hr.payment_batches) n
     where n.id = b.id and b.batch_no is null;
  end if;

  if not exists (select 1 from pg_catalog.pg_indexes
                  where schemaname = 'hr' and tablename = 'run_lines' and indexname = 'run_lines_approval_idx') then
    create index if not exists run_lines_approval_idx on hr.run_lines (run_id, approval_status);
  end if;
end
$$;
