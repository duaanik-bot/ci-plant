-- HR & PAYROLL: A LOAN'S INSTALMENT FOR ONE MONTH (owner's request, 2026-11-14: "an easy way to edit the instalment
-- amount for the selected month, keeping the wires intact with the loan … ask whether to keep the instalment for all
-- the upcoming months or only this time").
--
--   hr.loan_holidays.amount   NULL: the month is held (nothing due), as every row so far.
--                             A value: what that month takes from the loan instead of the instalment (never more
--                             than is outstanding). The schedule, the payroll line and the finalise posting all read
--                             it, so the loan ledger stays the one record.
-- Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

alter table hr.loan_holidays add column if not exists amount numeric(12, 2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_holidays_amount_check') then
    alter table hr.loan_holidays add constraint loan_holidays_amount_check check (amount is null or amount >= 0);
  end if;
end $$;
