-- HR & PAYROLL: MANUAL ENTRY LOCK + THE PAYROLL MONTH AN ADVANCE IS DEDUCTED IN (owner's request, 2026-11-14:
-- "when we come to a new payroll month we should have the list of employees, take manual entries in bulk or edit
-- them, save and lock it as is, and unlock it" — "when we give an advance today, ask which payroll month it is
-- deducted from, previous month by default: in November we pay October's salary").
--
--   hr.runs.inputs_locked_by / inputs_locked_at   a draft month's entries locked as they are: input edits, bulk
--                                                  entry, sheet imports and recalculation are refused until someone
--                                                  unlocks it. Submitting still works.
--   hr.advance_txns.for_month                      the payroll month an advance given in the app is deducted in.
--                                                  NULL (every older row) keeps the old rule: the month of txn_date.
-- Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

alter table hr.runs add column if not exists inputs_locked_by integer;
alter table hr.runs add column if not exists inputs_locked_at timestamptz;

alter table hr.advance_txns add column if not exists for_month text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'advance_txns_for_month_check') then
    alter table hr.advance_txns add constraint advance_txns_for_month_check
      check (for_month is null or for_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  end if;
end $$;
