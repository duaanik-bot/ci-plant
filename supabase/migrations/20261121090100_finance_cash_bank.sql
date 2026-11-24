-- FINANCE CASH & BANK: receipts and payments that settle bills, cash holders and their counts,
-- the maps that bring HR's staff money into the books, and corrections to the opening (spec
-- docs/superpowers/specs/2026-11-20-finance-cash-bank-design.md, section 10). It builds on
-- 20261027104320_finance_ledger_core.sql: eight new fin_* tables, two new columns each on
-- fin_ledgers and fin_vouchers, the cash_difference approval rule, and the core's posting check
-- widened for opening corrections.
--
--   fin_allocations     — a debit item and a credit item of one party ledger, paired, with an amount (§6.2)
--   fin_cash_counts     — a count of a cash ledger, the book balance it was taken against, its clearing (§5.5)
--   fin_ledger_roles    — the ledger that plays each staff or system role in a book (§7.2)
--   fin_hr_channels     — an HR pay channel code and the cash or bank ledger it pays from, in either book (§7.3)
--   fin_hr_expense_map  — an HR person type or department and the expense ledger it books to (§7.9)
--   fin_book_settings   — a book's settings: when its payroll month is booked (§7.8); where Bring-in's drift repair goes on
--   fin_hr_exceptions   — an HR event Finance could not post yet, and why (§7.7)
--   fin_hr_covers       — the HR rows an HR voucher books when it holds more than its own source's row (§7.4; ruling R27)
--
--   fin_ledgers  + holder_name, float_amount              — a cash holder, and the float kept with them (§5.4, §9.2)
--   fin_vouchers + allocation_plan, is_opening_correction — the bills an entry settles when it posts (§6.3, §6.4);
--                                                            a journal that corrects the Opening (§9.4)
--   fin_approval_rules.rule_key takes cash_difference, 'always' in every book (§8)
--
-- As in the core: nothing outside Finance is read, written or pointed at, and an id from outside
-- (an HR channel code, an HR row, a user) is stored bare. Foreign keys between fin_* tables never
-- cascade. Dates are 'YYYY-MM-DD' TEXT with a format CHECK. Money is NUMERIC(18,2), and NaN is no
-- amount.
--
-- Two hard stops are added for allocations (spec §6.2), each refusal an error with SQLSTATE P0001
-- and a stable FIN_ code in DETAIL, as the core's are:
--   fin_allocation_guard      before the write: both lines on the allocation's ledger and book, one
--                             a debit and one a credit, both vouchers posted and live: neither reversed
--                             nor at an odd depth in its reversal chain (ruling R9) (FIN_BAD_ALLOCATION)
--   fin_allocation_sum_check  at COMMIT: a line's allocations never add up to more than the line
--                             (FIN_OVER_ALLOCATED)
-- and fin_allocations is never truncated (H10: the core's fin_no_truncate), nor fin_hr_covers. H5 and H6 are widened
-- for opening corrections, which are held to the Opening's own date (spec §9.4):
-- fin_voucher_post_check() is replaced, changed in the three places its comment names.
--
-- Data: the cash_difference rule and a settings row (month_end) for every book there is. A book
-- made later gets both from finSetupBooks (scripts/finance-setup.mjs).
--
-- Row-level security is on for every new table, with no policies, and every privilege is revoked
-- from Supabase's anon and authenticated roles, as in the core.
--
-- APPLIED to colour-impressions-prod on 24 Nov 2026, by hand, as the named migration
-- finance_cash_bank (version 20261124095919), after a dry run (spec §10).
--
-- Mirrored locally by server/src/db.js init(), which replays this file right after the Finance
-- core one — so it must stay idempotent.
--
-- LOCKS: fin_ledgers, fin_vouchers and fin_approval_rules are altered, each for a moment: nullable
-- columns, one with a constant default (no rewrite), and a CHECK each, checked once against their
-- rows. The new tables' foreign keys hold fin_books, fin_ledgers, fin_vouchers and
-- fin_voucher_lines while each table is made.
set local lock_timeout = '1s';

-- ─── Cash holders (spec §5.4, §9.2) ───────────────────────────────────────
--
-- A Cash-in-Hand ledger kept by a person: their name, shown with the ledger, and the float they
-- are kept topped up to. The app allows these on a Cash-in-Hand ledger only (FIN_HOLDER_NOT_CASH);
-- the database holds that a float is never set without a holder, and is a real amount, never
-- negative.
ALTER TABLE fin_ledgers ADD COLUMN IF NOT EXISTS holder_name TEXT;
ALTER TABLE fin_ledgers ADD COLUMN IF NOT EXISTS float_amount NUMERIC(18,2);

-- ─── The bills an entry settles, and opening corrections (spec §6.3, §6.4, §9.4) ──
--
-- allocation_plan: how a receipt or payment settles the party's bills, written with its draft and
-- read when it posts. The allocation engine works it out again then, against the bills still open,
-- because a plan is never refused:
--   { "line_no": <its party line>, "mode": "auto" | "pick",
--     "picks": [{ "line_id": <a bill's line>, "amount_paise": <whole paise> | null }] }
-- NULL: nothing to settle.
--
-- is_opening_correction: a journal dated the Opening's own date that corrects figures of the
-- Opening (spec §9.4). Approved, it may post before the books begin (H5), and it may use the
-- system-only staff ledgers as the Opening may (H6). Only a journal is one, and its date is the
-- Opening's own, never another (the posting check below).
ALTER TABLE fin_vouchers ADD COLUMN IF NOT EXISTS allocation_plan JSONB;
ALTER TABLE fin_vouchers ADD COLUMN IF NOT EXISTS is_opening_correction BOOLEAN NOT NULL DEFAULT false;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so each CHECK is added only while the catalogue
-- lacks it, and a replay reads the catalogue and leaves it be.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.fin_ledgers'::regclass and conname = 'fin_ledgers_float_needs_holder') then
    alter table fin_ledgers add constraint fin_ledgers_float_needs_holder
      check (float_amount is null or (holder_name is not null and float_amount >= 0 and float_amount <> 'NaN'::numeric));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.fin_vouchers'::regclass and conname = 'fin_vouchers_correction_is_journal') then
    alter table fin_vouchers add constraint fin_vouchers_correction_is_journal
      check (not is_opening_correction or voucher_type = 'journal');
  end if;
end
$$;

-- ─── The cash_difference rule (spec §5.5, §8) ─────────────────────────────
--
-- A count's shortage or excess is cleared by a receipt or a payment under a rule of its own,
-- seeded 'always' below. The rule-key CHECK is widened to take it, and only while its definition
-- lacks it, so a replay finds it there and changes nothing. Nothing is dropped but the old CHECK,
-- which is replaced by the wider one in the same statement.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conrelid = 'public.fin_approval_rules'::regclass and conname = 'fin_approval_rules_rule_key_check'
                    and pg_catalog.pg_get_constraintdef(oid) like '%cash_difference%') then
    alter table fin_approval_rules drop constraint if exists fin_approval_rules_rule_key_check,
      add constraint fin_approval_rules_rule_key_check check (rule_key in
        ('journal', 'receipt', 'payment', 'contra', 'opening', 'sales', 'purchase', 'credit_note', 'debit_note', 'reversal', 'cash_difference'));
  end if;
end
$$;

-- ─── Bill-wise allocations (spec §6.2) ────────────────────────────────────
--
-- A debit item and a credit item of one party ledger, paired, and how much of the one settles the
-- other: for a customer, a bill and the receipt that pays it; for a vendor, the mirror image. An
-- item is a posted line of a live voucher: one not reversed, at an even depth in its reversal chain
-- (ruling R9: 0 is an entry that reverses nothing, 1 its reversal, 2 a reversal of that, which puts
-- the entry back). An allocation changes no balance, only which items are open, so it may be redone
-- in any month, a closing or locked one too (spec §6.5). Its rules are the hard stops below.
CREATE TABLE IF NOT EXISTS fin_allocations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  ledger_id INTEGER NOT NULL,                -- the party ledger both lines are on; the composite FK keeps it in this book
  debit_line_id INTEGER NOT NULL REFERENCES fin_voucher_lines(id),    -- the debit: a customer's bill, a payment to a vendor
  credit_line_id INTEGER NOT NULL REFERENCES fin_voucher_lines(id),   -- the credit: a customer's receipt, a vendor's bill
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'pick')),   -- how it was chosen (spec §6.3, §6.4)
  made_by_id INTEGER,                        -- users.id, stored bare: no FK
  made_by TEXT,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (debit_line_id, credit_line_id),
  CONSTRAINT fin_allocations_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_allocations_debit_line_id ON fin_allocations (debit_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_allocations_credit_line_id ON fin_allocations (credit_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_allocations_ledger_id ON fin_allocations (ledger_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_allocations_book_id ON fin_allocations (book_id);

-- ─── Cash counts (spec §5.5) ──────────────────────────────────────────────
--
-- A count of a cash ledger on a date: what was counted, and the book balance then (its posted
-- lines dated on or before count_date, read when the count is recorded). The difference is counted
-- less book_balance. A count posts nothing. Clearing a difference posts a receipt or a payment with
-- source_type 'cash_count' and this count's id, so H8 allows one per count, and cleared_voucher_id
-- names it once it posts.
CREATE TABLE IF NOT EXISTS fin_cash_counts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL,
  ledger_id INTEGER NOT NULL,                -- the cash ledger counted; the composite FK keeps it in this book
  count_date TEXT NOT NULL CHECK (count_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  counted NUMERIC(18,2) NOT NULL CHECK (counted >= 0 AND counted <> 'NaN'::numeric),
  book_balance NUMERIC(18,2) NOT NULL,
  note TEXT,
  counted_by_id INTEGER,                     -- users.id, stored bare: no FK
  counted_by TEXT,
  counted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_voucher_id INTEGER REFERENCES fin_vouchers(id),
  CONSTRAINT fin_cash_counts_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_cash_counts_ledger_date ON fin_cash_counts (ledger_id, count_date);
CREATE INDEX IF NOT EXISTS idx_fk_fin_cash_counts_cleared_voucher_id ON fin_cash_counts (cleared_voucher_id);

-- ─── HR's money in the books: roles, channels, the expense map (spec §7.2, §7.3, §7.9) ──
--
-- The ledger that plays each role in a book: the staff ledgers HR's money posts to, and the ones
-- the app posts to by itself (rounding, TDS, cash differences, the inter-company account). One
-- ledger per role in a book.
CREATE TABLE IF NOT EXISTS fin_ledger_roles (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL,
  ledger_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff_advances', 'staff_loans', 'salary_payable', 'salary_expense', 'md_account',
    'advance_waiver', 'other_deductions', 'rounding', 'tds_receivable', 'tds_payable', 'cash_difference', 'intercompany')),
  UNIQUE (book_id, role),
  CONSTRAINT fin_ledger_roles_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_ledger_roles_ledger_id ON fin_ledger_roles (ledger_id);

-- An HR pay channel, by its code in HR (stored bare), and the cash or bank ledger it pays from.
-- One map per channel, to a ledger of either book: a channel's bank may be DP's while the payroll
-- books to CI (spec §7.3).
CREATE TABLE IF NOT EXISTS fin_hr_channels (
  channel_code TEXT PRIMARY KEY,
  book_id INTEGER NOT NULL,                  -- the ledger's book
  ledger_id INTEGER NOT NULL,
  CONSTRAINT fin_hr_channels_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_hr_channels_ledger_id ON fin_hr_channels (ledger_id);

-- Where a book's payroll expense goes, by HR person type or department, set once by the
-- accountant when Tally splits salary expense (spec §7.9): hr_key is 'type:<type>' or
-- 'dept:<department>'.
CREATE TABLE IF NOT EXISTS fin_hr_expense_map (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL,
  hr_key TEXT NOT NULL CHECK (hr_key ~ '^(type|dept):.+$'),
  ledger_id INTEGER NOT NULL,
  UNIQUE (book_id, hr_key),
  CONSTRAINT fin_hr_expense_map_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_hr_expense_map_ledger_id ON fin_hr_expense_map (ledger_id);

-- ─── Book settings (spec §7.8) ────────────────────────────────────────────
--
-- One row per book. payroll_booking: the payroll month's journal is dated the month end
-- (month_end, the default) or the day it is paid (when_paid), as the book's salary is booked in
-- Tally. hr_drift_cursor: where "Bring in from HR" goes on checking the HR entries it already
-- posted (ruling R38b): the id of the last voucher a press checked before its time ran out, the
-- next press taking the older ones; NULL, from the newest. A position, stored bare: no foreign
-- key, as nothing is kept by it. Bring-in writes it; no person sets it.
CREATE TABLE IF NOT EXISTS fin_book_settings (
  book_id INTEGER PRIMARY KEY REFERENCES fin_books(id),
  payroll_booking TEXT NOT NULL DEFAULT 'month_end' CHECK (payroll_booking IN ('month_end', 'when_paid')),
  updated_by TEXT,
  updated_at TIMESTAMPTZ,
  hr_drift_cursor INTEGER
);
-- A database that made the table before the cursor was added to it gains it here.
ALTER TABLE fin_book_settings ADD COLUMN IF NOT EXISTS hr_drift_cursor INTEGER;

-- ─── HR events Finance could not post (spec §7.7) ─────────────────────────
--
-- An HR event, named by the source_type and source_id its voucher would carry (the HR row stored
-- bare), that Finance could not post: a locked month, an unmapped channel, a missing staff ledger.
-- HR's own request went through all the same. One row per event: a retry updates it, and the
-- event posting resolves it and names its voucher here.
CREATE TABLE IF NOT EXISTS fin_hr_exceptions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  book_id INTEGER,                           -- the book it would post to, when that is known
  reason_code TEXT NOT NULL,                 -- a FIN_ code
  reason TEXT NOT NULL,                      -- its sentence
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_tried_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  voucher_id INTEGER REFERENCES fin_vouchers(id),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_hr_exceptions_voucher_id ON fin_hr_exceptions (voucher_id);

-- ─── What an HR voucher books (spec §7.4; ruling R27) ─────────────────────
--
-- An HR voucher's own source names one HR row (an advance, a loan, a line paid on its own). One that
-- books several rows lists them here, by the source_type and source_id each would carry as an event of
-- its own (the HR row stored bare, as fin_hr_exceptions stores it): a batch its lines, a sheet's posting
-- round the advances and loans it made, the month's payroll-sheet advances their rows, and a hidden
-- people's combined entry every row it holds. No names and no amounts: which rows, and nothing else.
-- Whether a person is hidden is read when an entry posts, and that can change, so a row is booked by
-- the live voucher that lists it (posted or waiting, not reversed: H8's own test), and no other entry
-- takes it while that one stands. A row is listed once by a voucher, and a voucher is never deleted,
-- so its list stands as long as it does: no row here is updated or deleted, and the table is never
-- truncated (fin_no_truncate, below).
CREATE TABLE IF NOT EXISTS fin_hr_covers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES fin_vouchers(id),
  source_type TEXT NOT NULL,                 -- an HR event's source key: hr_line_pay, hr_advance, hr_loan, hr_prepay, hr_waiver
  source_id INTEGER NOT NULL,                -- that HR row's id, stored bare
  UNIQUE (voucher_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_hr_covers_source ON fin_hr_covers (source_type, source_id);

-- ─── Hard stops for allocations (spec §6.2) ───────────────────────────────
--
-- The rules an allocation keeps whoever writes it, refused as the core's hard stops are. The app's
-- allocation engine only ever proposes allocations that keep them, under a lock per party ledger
-- (spec §6.6): these are the last stop. Each function runs with an empty search_path, so every
-- table in it is named with its schema.

-- FIN_BAD_ALLOCATION, before the write. Both lines are on the allocation's ledger and book, the
-- debit line a debit and the credit line a credit, and both vouchers are posted and live (ruling
-- R9): not reversed, and at an even depth in its reversal chain. An entry that reverses nothing is
-- at depth 0, its reversal at 1, a reversal of that reversal at 2, and so on: a reversal of a
-- reversal puts the entry back, so its lines are items again, and a plain reversal's never are. The
-- depth is found by walking reversal_of_id, without a lock. A chain of posted reversals always ends,
-- since each voucher in it is marked reversed by the next and a mark is made once (H3, H11); one
-- that has not ended after 1000 steps is refused all the same.
--
-- Locks (ruling R7). The guard reads, and takes no row lock. On its own it refuses every allocation
-- onto lines it can see are not those of a posted, live voucher (a draft, a submitted or discarded
-- entry, a reversed one, a plain reversal), and every pair that is not a debit and a credit of the
-- allocation's ledger and book. What it cannot see is a reversal still being made in another
-- transaction. For that, Finance relies on the party lock, pg_advisory_xact_lock(7300, ledger_id),
-- which the app takes (finance-allocations.js, and finPostLocked in finance-vouchers.js):
--   1. every write to fin_allocations is made under the lock of its party ledger;
--   2. finPostLocked's first statement takes the lock of every party ledger among the posting
--      voucher's own lines, in ascending id. A reversal's lines mirror the original's, so a reversal
--      and any allocation onto the original wait for each other, even one written while the
--      original had none;
--   3. a reversal releases the original's allocations after marking it reversed, under those locks.
-- Whichever of the two takes the lock second sees what the first committed (READ COMMITTED): an
-- allocation that comes second is refused here, and one that came first is released by the
-- reversal, so none is left on a reversed voucher. A lock taken here on the counterpart voucher would
-- come after the party lock, the months and the ledgers, outside the lock order (series, voucher,
-- party, months, ledgers), and would deadlock with a reversal that holds that voucher FOR UPDATE and
-- waits for the party lock. The sum check's two line locks, below, are belt and braces for SQL
-- written by hand without the party lock, and hold under READ COMMITTED only.
create or replace function fin_allocation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent record;
  chain_depth integer;
  chain_up integer;
begin
  for parent in
    select v.id, v.number, v.status, v.reversed_by_id, v.reversal_of_id
      from public.fin_vouchers v
     where v.id in (select l.voucher_id from public.fin_voucher_lines l where l.id in (new.debit_line_id, new.credit_line_id))
     order by v.id
  loop
    if parent.status <> 'posted' or parent.reversed_by_id is not null then
      raise exception using
        message = case
          when parent.status <> 'posted'
            then format('Voucher id %s is not posted (it is %s). Only a posted entry is adjusted.', parent.id, parent.status)
          else format('Voucher %s has been reversed. Its lines are not adjusted.', parent.number)
        end,
        detail = 'FIN_BAD_ALLOCATION',
        errcode = 'P0001';
    end if;
    -- Its depth in its reversal chain (ruling R9): one step up reversal_of_id at a time, read, not locked.
    chain_depth := 0;
    chain_up := parent.reversal_of_id;
    while chain_up is not null and chain_depth < 1000 loop
      chain_depth := chain_depth + 1;
      select o.reversal_of_id into chain_up from public.fin_vouchers o where o.id = chain_up;
    end loop;
    if chain_up is not null or chain_depth % 2 = 1 then
      raise exception using
        message = case
          when chain_up is not null
            then format('Voucher %s sits in a chain of reversals that does not end. Its lines are not adjusted.', parent.number)
          else format('Voucher %s is a reversal. Its lines are not adjusted.', parent.number)
        end,
        detail = 'FIN_BAD_ALLOCATION',
        errcode = 'P0001';
    end if;
  end loop;
  if not exists (select 1 from public.fin_voucher_lines l
                  where l.id = new.debit_line_id
                    and l.ledger_id = new.ledger_id and l.book_id = new.book_id and l.debit > 0)
     or not exists (select 1 from public.fin_voucher_lines l
                     where l.id = new.credit_line_id
                       and l.ledger_id = new.ledger_id and l.book_id = new.book_id and l.credit > 0) then
    raise exception using
      message = format('Line id %s and line id %s are not a debit and a credit of ledger id %s in book id %s.',
                       new.debit_line_id, new.credit_line_id, new.ledger_id, new.book_id),
      detail = 'FIN_BAD_ALLOCATION',
      errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- FIN_OVER_ALLOCATED, at COMMIT. A line's allocations never add up to more than the line holds:
-- the debit line's to more than its debit, the credit line's to more than its credit. Judged once
-- the transaction has written all it will, so a redo (the line's allocations deleted and written
-- again) is judged as it leaves them.
--
-- Locks (ruling R7). Two allocations onto one line are kept apart by the party lock (both of an
-- allocation's lines are on one party ledger), and under it this check never waits. Its own locks
-- are belt and braces for SQL written by hand without that lock: the two lines are locked FOR NO KEY
-- UPDATE, by id alone and in id order, and summed after, so a transaction allocating either line at
-- the same moment waits here for this one to finish and then counts what it allocated. That holds
-- under READ COMMITTED only, where the sum, read after the lock, sees what the other committed.
-- Nothing else locks a posted voucher's lines, and the KEY SHARE that the foreign keys onto them
-- take does not conflict with this lock.
create or replace function fin_allocation_sum_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  side record;
begin
  perform 1
     from public.fin_voucher_lines l
    where l.id in (new.debit_line_id, new.credit_line_id)
    order by l.id
      for no key update;
  for side in
    select l.line_no, v.number, 'debit' as what, l.debit as holds,
           (select coalesce(sum(a.amount), 0) from public.fin_allocations a where a.debit_line_id = l.id) as allocated
      from public.fin_voucher_lines l
      join public.fin_vouchers v on v.id = l.voucher_id
     where l.id = new.debit_line_id
    union all
    select l.line_no, v.number, 'credit', l.credit,
           (select coalesce(sum(a.amount), 0) from public.fin_allocations a where a.credit_line_id = l.id)
      from public.fin_voucher_lines l
      join public.fin_vouchers v on v.id = l.voucher_id
     where l.id = new.credit_line_id
  loop
    if side.allocated > side.holds then
      raise exception using
        message = format('Line %s of voucher %s holds a %s of %s, and its adjustments come to %s.',
                         side.line_no, side.number, side.what, side.holds, side.allocated),
        detail = 'FIN_OVER_ALLOCATED',
        errcode = 'P0001';
    end if;
  end loop;
  return null;
end;
$$;

create or replace trigger fin_allocation_guard before insert or update on fin_allocations
  for each row execute function fin_allocation_guard();

-- PostgreSQL has no CREATE OR REPLACE for a constraint trigger, so it is made once, here, and a
-- replay finds it and leaves it be, as the core's are.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgname = 'fin_allocation_sum_check' and tgrelid = 'public.fin_allocations'::regclass) then
    create constraint trigger fin_allocation_sum_check after insert or update on fin_allocations
      deferrable initially deferred for each row
      execute function fin_allocation_sum_check();
  end if;
end
$$;

-- H10 for allocations: they change no balance, but they are which bills are open, so a TRUNCATE is
-- refused as it is for the vouchers, their lines and the audit log, by the core's own function.
create or replace trigger fin_no_truncate before truncate on fin_allocations
  for each statement execute function fin_no_truncate();
-- …and for what an HR voucher books: emptied, an HR row would be free to be booked a second time.
create or replace trigger fin_no_truncate before truncate on fin_hr_covers
  for each statement execute function fin_no_truncate();

-- ─── H5 and H6, widened for opening corrections (spec §9.4) ───────────────
--
-- This REPLACES fin_voucher_post_check() of 20261027104320_finance_ledger_core.sql (H1, H5 and H6
-- at COMMIT, for a voucher on its way into posted: see the comment there), whose body it copies
-- line for line, changed in three places only:
--   (a) H5, before the books begin: an opening correction is taken there too, when it is approved
--       and dated the day before the books begin, the Opening's own date. The months after it are
--       then judged as they are for the Opening (rulings R70, R73): a locked one refuses it, and a
--       closing one asks for the approval it already has. Any other entry dated there is still
--       refused FIN_BEFORE_BOOKS.
--   (b) H6, system-only ledgers: an opening correction may use one, as the Opening may (the staff
--       ledgers, spec §7.2). An inactive ledger it may not, as the Opening may not: only a reversal
--       takes one.
--   (c) An opening correction dated any day but the day before the books begin is refused, in a
--       month of any status (FIN_BAD_CORRECTION), right after (a): one dated on another day before
--       the books is refused by (a) itself. So (a) and (b) hold for the opening day alone, and a
--       journal flagged as a correction in an open month never reaches H6's exemption.
-- PL/pgSQL replaces a function whole, hence the copy. The constraint triggers that run it,
-- fin_voucher_post_check_ins and _upd, are the core's and stay as they are. db.js init() replays the
-- core migration and then this one, so the body left in place is this one.
create or replace function fin_voucher_post_check()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  reverses_opening boolean := false;
  opening_date text;
  real_date date;
  month_row record;
  carried record;
  line_count integer;
  debits numeric;
  credits numeric;
  bad record;
begin
  -- A voucher is reversed only once it is posted. One marked reversed while it
  -- was still a draft (H3 guards posted vouchers only) would post outside H8's
  -- indexes, which leave out every voucher marked reversed.
  if new.reversed_by_id is not null then
    raise exception using
      message = format('Voucher %s is already marked as reversed, so it cannot be posted.', new.number),
      detail = 'FIN_BAD_REVERSAL',
      errcode = 'P0001';
  end if;

  -- A reversal is proved, because the checks below excuse a reversal from
  -- three rules: before_books when it reverses the Opening voucher, and
  -- inactive and system-only ledgers. The voucher it reverses is another
  -- posted voucher of this book, marked as reversed by this one by COMMIT
  -- (the app marks it in the same transaction), and the two sets of lines
  -- are the same multiset once each line's debit and credit are swapped,
  -- tested both ways with EXCEPT ALL.
  if new.reversal_of_id is not null then
    select o.voucher_type = 'opening', o.voucher_date
      into reverses_opening, opening_date
      from public.fin_vouchers o
     where o.id = new.reversal_of_id and o.id <> new.id and o.book_id = new.book_id
       and o.status = 'posted' and o.reversed_by_id = new.id;
    if not found or exists (
         (select l.ledger_id, l.debit, l.credit from public.fin_voucher_lines l where l.voucher_id = new.id
          except all
          select l.ledger_id, l.credit, l.debit from public.fin_voucher_lines l where l.voucher_id = new.reversal_of_id)
         union all
         (select l.ledger_id, l.credit, l.debit from public.fin_voucher_lines l where l.voucher_id = new.reversal_of_id
          except all
          select l.ledger_id, l.debit, l.credit from public.fin_voucher_lines l where l.voucher_id = new.id)) then
      raise exception using
        message = format('Voucher %s is not a true reversal of voucher id %s. A reversal mirrors every line of a posted voucher of its own book, which is marked as reversed by it.', new.number, new.reversal_of_id),
        detail = 'FIN_BAD_REVERSAL',
        errcode = 'P0001';
    end if;
    -- The Opening voucher is reversed as at its own date (ruling R42). Reversed
    -- later, it would stay in the books until then beside whatever opening was
    -- built in its place, and every balance as at its date would count twice.
    if reverses_opening and new.voucher_date <> opening_date then
      raise exception using
        message = format('Voucher %s reverses the Opening voucher, which is reversed as at its own date, %s, never later.', new.number, opening_date),
        detail = 'FIN_BAD_REVERSAL',
        errcode = 'P0001';
    end if;
    -- The reversal of an Opening voucher is never reversed itself (ruling
    -- R45): that would put the opening back in the books, from then on,
    -- beside whatever opening was built in its place.
    if exists (select 1 from public.fin_vouchers o join public.fin_vouchers oo on oo.id = o.reversal_of_id
                where o.id = new.reversal_of_id and oo.voucher_type = 'opening') then
      raise exception using
        message = format('Voucher %s reverses the reversal of an Opening voucher, which is never reversed itself: a new opening is built instead.', new.number),
        detail = 'FIN_BAD_REVERSAL',
        errcode = 'P0001';
    end if;
  end if;

  -- The date is a real calendar date. The column CHECK proves only its shape.
  begin
    real_date := new.voucher_date::date;
  exception when data_exception then
    raise exception using
      message = format('%s is not a real date.', new.voucher_date),
      detail = 'FIN_BAD_DATE',
      errcode = 'P0001';
  end;

  -- The month is this voucher's book's, and the date is inside it.
  select p.label, p.start_date, p.end_date, p.status
    into month_row
    from public.fin_periods p
   where p.id = new.period_id and p.book_id = new.book_id;
  if not found then
    raise exception using
      message = format('Voucher %s is filed under a month of another book.', new.number),
      detail = 'FIN_WRONG_BOOK',
      errcode = 'P0001';
  end if;
  if real_date < month_row.start_date::date or real_date > month_row.end_date::date then
    raise exception using
      message = format('%s is not in %s, which runs from %s to %s.', new.voucher_date, month_row.label, month_row.start_date, month_row.end_date),
      detail = 'FIN_BAD_DATE',
      errcode = 'P0001';
  end if;

  -- Before the books begin, only the Opening voucher and its reversal, and an
  -- opening correction (spec §9.4) that is approved and dated the Opening's
  -- own date, the day before the books begin (anything else, a NULL included,
  -- is refused). Said first: a typed entry dated there is told so, whatever
  -- the months after it hold.
  if month_row.status = 'before_books' and new.voucher_type <> 'opening' and not reverses_opening
     and (new.is_opening_correction and new.approved_by_id is not null
          and real_date = (select b.books_begin::date - 1 from public.fin_books b where b.id = new.book_id)) is not true then
    raise exception using
      message = format('%s comes ahead of the books. Only the Opening voucher, or a reversal of it, can be dated there.', month_row.label),
      detail = 'FIN_BEFORE_BOOKS',
      errcode = 'P0001';
  end if;

  -- An opening correction is dated the Opening's own date, the day before
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
  -- posting is carried into every later month of its book (the Opening
  -- voucher, dated before the books begin, into all of them: ruling R70), so
  -- it takes the strictest status among them: a locked one refuses it, the
  -- first by date named, and a closing one asks for an approved entry.
  select p.label, p.start_date
    into carried
    from public.fin_periods p
   where p.book_id = new.book_id and p.start_date >= month_row.start_date and p.status = 'locked'
   order by p.start_date
   limit 1;
  if found then
    raise exception using
      message = case
        when carried.start_date = month_row.start_date
          then format('%s is locked. Nothing more can be posted to it.', carried.label)
        when month_row.status = 'before_books'
          then format('%s is locked. Nothing more can be posted to it, and the opening carries into it.', carried.label)
        else format('%s is locked. Nothing more can be posted to it, and an entry dated in %s carries into it.', carried.label, month_row.label)
      end,
      detail = 'FIN_PERIOD_LOCKED',
      errcode = 'P0001';
  end if;
  if new.approved_by_id is null then
    select p.label, p.start_date
      into carried
      from public.fin_periods p
     where p.book_id = new.book_id and p.start_date >= month_row.start_date and p.status = 'closing'
     order by p.start_date
     limit 1;
    if found then
      raise exception using
        message = case
          when carried.start_date = month_row.start_date
            then format('%s is closing. Only an approved entry can be posted to it.', carried.label)
          when month_row.status = 'before_books'
            then format('%s is closing, and the opening carries into it. Only an approved entry can change the opening.', carried.label)
          else format('%s is closing, and an entry dated in %s carries into it. Only an approved entry can be posted to %s.',
                      carried.label, month_row.label, month_row.label)
        end,
        detail = 'FIN_PERIOD_CLOSING',
        errcode = 'P0001';
    end if;
  end if;

  -- The lines: two or more, the debits equal to the credits to the paisa and
  -- more than zero, and the total the sum of the debits. A NaN sum equals
  -- itself and is more than zero, so it is refused by name; the line CHECK
  -- keeps NaN out already, and this holds even without it.
  select count(*), coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0)
    into line_count, debits, credits
    from public.fin_voucher_lines l
   where l.voucher_id = new.id;
  if line_count < 2 then
    raise exception using
      message = 'A voucher needs at least two lines.',
      detail = 'FIN_TOO_FEW_LINES',
      errcode = 'P0001';
  end if;
  if debits <> credits or debits <= 0 or debits = 'NaN'::numeric then
    raise exception using
      message = format('Debits %s and credits %s do not match.', debits, credits),
      detail = 'FIN_UNBALANCED',
      errcode = 'P0001';
  end if;
  if new.total <> debits then
    raise exception using
      message = format('The voucher total %s is not the sum of its debits, %s.', new.total, debits),
      detail = 'FIN_UNBALANCED',
      errcode = 'P0001';
  end if;

  -- Every ledger is active. A reversal mirrors history exactly, so it may use
  -- a ledger switched off since the entry it reverses.
  if new.reversal_of_id is null then
    select l.line_no, fl.name
      into bad
      from public.fin_voucher_lines l
      join public.fin_ledgers fl on fl.id = l.ledger_id
     where l.voucher_id = new.id and not fl.active
     order by l.line_no
     limit 1;
    if found then
      raise exception using
        message = format('Line %s uses %s, which is inactive and takes no new postings.', bad.line_no, bad.name),
        detail = 'FIN_LEDGER_INACTIVE',
        errcode = 'P0001';
    end if;
  end if;

  -- A system-only ledger (manual_entry false) takes only the ERP's own
  -- postings (source_type set), the Opening voucher and its corrections
  -- (spec §9.4), and reversals.
  if new.source_type is null and new.voucher_type <> 'opening' and not new.is_opening_correction
     and new.reversal_of_id is null then
    select l.line_no, fl.name
      into bad
      from public.fin_voucher_lines l
      join public.fin_ledgers fl on fl.id = l.ledger_id
     where l.voucher_id = new.id and not fl.manual_entry
     order by l.line_no
     limit 1;
    if found then
      raise exception using
        message = format('Line %s uses %s, which is kept for system entries only.', bad.line_no, bad.name),
        detail = 'FIN_SYSTEM_LEDGER',
        errcode = 'P0001';
    end if;
  end if;

  return null;
end;
$$;

-- Row-level security, as for the core's tables: on, with no policies, and the Supabase API roles
-- revoked where they exist (a local database has neither).
alter table fin_allocations enable row level security;
alter table fin_cash_counts enable row level security;
alter table fin_ledger_roles enable row level security;
alter table fin_hr_channels enable row level security;
alter table fin_hr_expense_map enable row level security;
alter table fin_book_settings enable row level security;
alter table fin_hr_exceptions enable row level security;
alter table fin_hr_covers enable row level security;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table fin_allocations, fin_cash_counts, fin_ledger_roles, fin_hr_channels, fin_hr_expense_map,
      fin_book_settings, fin_hr_exceptions, fin_hr_covers from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on table fin_allocations, fin_cash_counts, fin_ledger_roles, fin_hr_channels, fin_hr_expense_map,
      fin_book_settings, fin_hr_exceptions, fin_hr_covers from authenticated;
  end if;
end
$$;

-- ─── What every book there is now is given (spec §8, §7.8) ────────────────
--
-- The cash_difference rule, 'always', and the default settings row. A book that has them keeps
-- them as they are.
INSERT INTO fin_approval_rules (book_id, rule_key, mode, limit_amount, updated_by)
SELECT b.id, 'cash_difference', 'always', NULL, 'migration' FROM fin_books b
ON CONFLICT (book_id, rule_key) DO NOTHING;
INSERT INTO fin_book_settings (book_id)
SELECT b.id FROM fin_books b
ON CONFLICT DO NOTHING;

-- Realtime: the core's guarded block, for the eight new tables.
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array[
    'fin_allocations', 'fin_cash_counts', 'fin_ledger_roles', 'fin_hr_channels', 'fin_hr_expense_map',
    'fin_book_settings', 'fin_hr_exceptions', 'fin_hr_covers'
  ] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table);
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table);
  end loop;
end
$$;
