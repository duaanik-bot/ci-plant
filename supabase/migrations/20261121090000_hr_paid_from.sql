-- HR & PAYROLL: WHERE THE MONEY CAME FROM (Finance Cash & Bank, spec 7.3 and 11 item 1).
-- Finance will post staff money to the books and has to know which cash or bank account each payout came out of.
-- Four nullable text columns, nothing else; NULL means "not recorded", so every existing row stays valid:
--   hr.advance_txns.paid_via       the cash or bank account an advance was paid through
--   hr.loan_txns.paid_via          the cash or bank account a loan was paid through
--   hr.payment_batches.paid_from   the cash or bank account a salary payment batch was paid from
--   hr.run_lines.paid_from         the cash or bank account a payroll line was paid from
-- Mirrored locally by server/src/db.js init(): idempotent, a column is added only when it is missing.
set local lock_timeout = '1s';

alter table hr.advance_txns    add column if not exists paid_via text;
alter table hr.loan_txns       add column if not exists paid_via text;
alter table hr.payment_batches add column if not exists paid_from text;
alter table hr.run_lines       add column if not exists paid_from text;
