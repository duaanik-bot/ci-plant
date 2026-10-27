-- FINANCE LEDGER CORE: the books of account. Thirteen fin_* tables hold one set
-- of books per business (Colour Impressions and Darbi Print Pack): financial
-- years and their months with the lock state of each, Tally-style groups and
-- ledgers, vouchers and their debit/credit lines, who may do what in Finance,
-- the approval rules, an append-only audit log, and the staging tables for the
-- Tally opening-balance import.
--
--   fin_books, fin_years, fin_periods                 — a book, its years, its months
--   fin_groups, fin_ledgers                           — Tally's tree and the accounts in it
--   fin_vouchers, fin_voucher_lines                   — every entry and its lines
--   fin_access, fin_approval_rules                    — Finance's own grants and limits
--   fin_audit_log                                     — who did what, never edited
--   fin_imports, fin_import_ledgers, fin_import_bills — Tally import staging
--
-- Nothing else in the ERP reads or writes these tables, and they point at
-- nothing outside themselves: an ERP id (billing entity, customer, vendor,
-- user) is stored bare, never as a foreign key. Foreign keys between fin_*
-- tables never cascade, so a delete that would orphan a row is refused.
--
-- Dates are 'YYYY-MM-DD' TEXT with a format CHECK (the shared pool has no DATE
-- parser; this is the ERP's own convention). Money is NUMERIC(18,2).
--
-- No data is loaded here. Books, years, groups, rules and the first grants come
-- from scripts/finance-setup.mjs.
--
-- Row-level security is on for every fin_* table, with no policies, and every
-- privilege is revoked from Supabase's anon and authenticated roles, as with
-- tooling_* (0035) and hr.*. The ERP server connects as the owner of these
-- tables, which RLS without FORCE does not restrict.
--
-- APPLIED to colour-impressions-prod: 2026-10-27, as the named migration
-- finance_ledger_core (go-live, spec section 18.3).
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: new tables only; no FK onto any existing table, so no existing table is locked.
set local lock_timeout = '1s';

-- ─── Books, years, months ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fin_books (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2,4}$'),   -- CI, DP: the first part of a voucher number
  name TEXT NOT NULL,                        -- display name; GSTIN and address are read from billing_entities
  billing_entity_id INTEGER NOT NULL UNIQUE, -- billing_entities.id, stored bare: no FK
  books_begin TEXT NOT NULL CHECK (books_begin ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fin_years (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  label TEXT NOT NULL,                       -- 2026-27
  short TEXT NOT NULL,                       -- 2627, the year part of a voucher number
  start_date TEXT NOT NULL CHECK (start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  end_date TEXT NOT NULL CHECK (end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_years_book_start_key ON fin_years (book_id, start_date);

CREATE TABLE IF NOT EXISTS fin_periods (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  year_id INTEGER NOT NULL REFERENCES fin_years(id),
  month_no SMALLINT NOT NULL CHECK (month_no BETWEEN 1 AND 12),   -- 1 = April
  label TEXT NOT NULL,                       -- Jan 2027
  start_date TEXT NOT NULL CHECK (start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  end_date TEXT NOT NULL CHECK (end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  status TEXT NOT NULL CHECK (status IN ('before_books', 'open', 'closing', 'locked')),
  status_changed_by TEXT,
  status_changed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_periods_book_start_key ON fin_periods (book_id, start_date);
CREATE INDEX IF NOT EXISTS idx_fk_fin_periods_year_id ON fin_periods (year_id);

-- ─── Groups and ledgers ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fin_groups (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  parent_id INTEGER REFERENCES fin_groups(id),    -- NULL = primary group
  name TEXT NOT NULL,
  nature TEXT NOT NULL CHECK (nature IN ('asset', 'liability', 'income', 'expense')),
  affects_gross_profit BOOLEAN NOT NULL DEFAULT false,   -- Sales, Purchase, Direct Incomes and Expenses
  is_system BOOLEAN NOT NULL DEFAULT false,              -- predefined: cannot be deleted, nature fixed
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (id, book_id)                       -- the target of fin_ledgers_group_book_fk
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_groups_book_name_key ON fin_groups (book_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_fk_fin_groups_parent_id ON fin_groups (parent_id);

CREATE TABLE IF NOT EXISTS fin_ledgers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  group_id INTEGER NOT NULL,                 -- with book_id, the composite FK below keeps a ledger in its own book's tree
  name TEXT NOT NULL,
  code TEXT,
  tally_name TEXT,                           -- the ledger's name in Tally; matches month-end imports even if renamed here
  party_type TEXT CHECK (party_type IN ('customer', 'vendor')),
  party_id INTEGER,                          -- customers.id or vendors.id, stored bare: no FK
  manual_entry BOOLEAN NOT NULL DEFAULT true,    -- false = system only: refused in hand-typed vouchers
  is_system BOOLEAN NOT NULL DEFAULT false,      -- Cash and Profit & Loss A/c: cannot be deleted
  active BOOLEAN NOT NULL DEFAULT true,          -- inactive ledgers refuse new postings; history stays
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, book_id),                      -- the target of fin_voucher_lines_ledger_book_fk
  CONSTRAINT fin_ledgers_party_pair CHECK ((party_type IS NULL) = (party_id IS NULL)),
  CONSTRAINT fin_ledgers_group_book_fk FOREIGN KEY (group_id, book_id) REFERENCES fin_groups (id, book_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_ledgers_book_name_key ON fin_ledgers (book_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS fin_ledgers_book_code_key ON fin_ledgers (book_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_ledgers_party_key ON fin_ledgers (book_id, party_type, party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fk_fin_ledgers_group_id ON fin_ledgers (group_id, book_id);

-- ─── Vouchers and their lines ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fin_vouchers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  voucher_type TEXT NOT NULL CHECK (voucher_type IN
    ('journal', 'receipt', 'payment', 'contra', 'opening', 'sales', 'purchase', 'credit_note', 'debit_note')),
  number TEXT UNIQUE,                        -- minted when the voucher posts, never earlier
  voucher_date TEXT NOT NULL CHECK (voucher_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  period_id INTEGER REFERENCES fin_periods(id),   -- set and verified at posting
  narration TEXT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'posted', 'discarded')),
  total NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total <> 'NaN'::numeric),   -- the sum of the debits: kept by the app, re-verified at posting
  reversal_of_id INTEGER REFERENCES fin_vouchers(id),
  reversed_by_id INTEGER UNIQUE REFERENCES fin_vouchers(id),   -- the one column a posted voucher may ever change (NULL to a value)
  source_type TEXT,                          -- the ERP document this was posted from (sub-project 2); NULL if keyed by hand
  source_id INTEGER,
  source_fingerprint TEXT,
  client_key UUID UNIQUE,                    -- makes a retried create return the same draft
  created_by_id INTEGER,                     -- *_by_id columns are users.id, stored bare: no FK
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_by_id INTEGER,
  submitted_by TEXT,
  submitted_at TIMESTAMPTZ,
  approved_by_id INTEGER,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  self_approved BOOLEAN NOT NULL DEFAULT false,
  posted_by_id INTEGER,
  posted_by TEXT,
  posted_at TIMESTAMPTZ,
  last_rejected_by TEXT,
  last_rejected_at TIMESTAMPTZ,
  last_reject_reason TEXT,
  UNIQUE (id, book_id),                      -- the target of fin_voucher_lines_voucher_book_fk
  CONSTRAINT fin_vouchers_posted_shape CHECK
    ((status = 'posted') = (number IS NOT NULL AND period_id IS NOT NULL AND posted_at IS NOT NULL)),
  -- Only a posted voucher is ever marked reversed. A mark on a draft would take it out of H8's indexes,
  -- which leave out every voucher marked reversed, before it ever posts.
  CONSTRAINT fin_vouchers_reversed_only_posted CHECK (reversed_by_id IS NULL OR status = 'posted'),
  -- A reversal is a journal, whatever the type of the entry it mirrors.
  CONSTRAINT fin_vouchers_reversal_is_journal CHECK (reversal_of_id IS NULL OR voucher_type = 'journal')
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_vouchers_one_live_opening ON fin_vouchers (book_id)
  WHERE voucher_type = 'opening' AND status = 'posted' AND reversed_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_vouchers_one_live_source ON fin_vouchers (source_type, source_id)
  WHERE source_type IS NOT NULL AND status IN ('submitted', 'posted') AND reversed_by_id IS NULL AND reversal_of_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fin_vouchers_one_reversal ON fin_vouchers (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL AND status <> 'discarded';
CREATE INDEX IF NOT EXISTS idx_fin_vouchers_book_date ON fin_vouchers (book_id, voucher_date, status);
CREATE INDEX IF NOT EXISTS idx_fk_fin_vouchers_period_id ON fin_vouchers (period_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_vouchers_reversal_of_id ON fin_vouchers (reversal_of_id);

CREATE TABLE IF NOT EXISTS fin_voucher_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  voucher_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,                  -- the voucher's book, and the ledger's: both composite FKs below use it
  line_no SMALLINT NOT NULL,
  ledger_id INTEGER NOT NULL,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit NUMERIC(18,2) NOT NULL DEFAULT 0,
  narration TEXT,
  bill_ref TEXT,                             -- party lines only; bill-wise matching is sub-project 5, capture starts now
  bill_date TEXT CHECK (bill_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  due_date TEXT CHECK (due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  UNIQUE (voucher_id, line_no),
  -- NaN is no amount. PostgreSQL's NaN equals itself and is greater than every number, so without its own
  -- terms it would pass `debit > 0` here, and H1's sums too. The same goes for fin_vouchers.total.
  CONSTRAINT fin_voucher_lines_one_side CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0))
    AND debit <> 'NaN'::numeric AND credit <> 'NaN'::numeric),
  CONSTRAINT fin_voucher_lines_voucher_book_fk FOREIGN KEY (voucher_id, book_id) REFERENCES fin_vouchers (id, book_id),
  CONSTRAINT fin_voucher_lines_ledger_book_fk FOREIGN KEY (ledger_id, book_id) REFERENCES fin_ledgers (id, book_id)
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_voucher_lines_voucher_id ON fin_voucher_lines (voucher_id, book_id);
CREATE INDEX IF NOT EXISTS idx_fin_voucher_lines_ledger ON fin_voucher_lines (ledger_id);

-- ─── Access, rules, audit ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fin_access (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL,                  -- users.id, stored bare: no FK
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  roles TEXT[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['viewer', 'accountant', 'approver', 'admin']::text[]),
  can_export BOOLEAN NOT NULL DEFAULT true,
  granted_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_access_user_book_key ON fin_access (user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_access_book_id ON fin_access (book_id);

CREATE TABLE IF NOT EXISTS fin_approval_rules (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  rule_key TEXT NOT NULL CHECK (rule_key IN
    ('journal', 'receipt', 'payment', 'contra', 'opening', 'sales', 'purchase', 'credit_note', 'debit_note', 'reversal')),
  mode TEXT NOT NULL CHECK (mode IN ('always', 'above_limit', 'never')),
  limit_amount NUMERIC(18,2) CHECK (limit_amount >= 0),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fin_approval_rules_limit_iff_above CHECK ((mode = 'above_limit') = (limit_amount IS NOT NULL)),
  -- NaN is no limit: PostgreSQL's NaN is greater than every number, so it passes `limit_amount >= 0`.
  CONSTRAINT fin_approval_rules_limit_not_nan CHECK (limit_amount IS NULL OR limit_amount <> 'NaN'::numeric)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_approval_rules_book_rule_key ON fin_approval_rules (book_id, rule_key);

CREATE TABLE IF NOT EXISTS fin_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  entity TEXT NOT NULL,                      -- voucher, ledger, group, period, rule, access, import, book
  entity_id INTEGER,
  action TEXT NOT NULL,
  user_id INTEGER,                           -- users.id, stored bare: no FK; NULL for a system action
  user_name TEXT NOT NULL,
  reason TEXT,
  before JSONB,
  after JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_book_at ON fin_audit_log (book_id, at);
CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON fin_audit_log (entity, entity_id);

-- ─── Tally import staging ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fin_imports (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES fin_books(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('opening', 'parallel_tb')),
  as_at TEXT NOT NULL CHECK (as_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'matched', 'used', 'discarded')),
  file_names TEXT[] NOT NULL DEFAULT '{}',
  uploaded_by TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_voucher_id INTEGER REFERENCES fin_vouchers(id),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_imports_book_id ON fin_imports (book_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_imports_opening_voucher_id ON fin_imports (opening_voucher_id);

CREATE TABLE IF NOT EXISTS fin_import_ledgers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES fin_imports(id),
  tally_name TEXT NOT NULL,
  tally_group TEXT,
  debit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit <> 'NaN'::numeric),     -- NaN is no amount, as on a voucher line
  credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit <> 'NaN'::numeric),
  ledger_id INTEGER REFERENCES fin_ledgers(id),
  match_status TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched', 'matched', 'create')),
  -- The proposal for a 'create' row: the group the new ledger goes under, and
  -- the ERP customer or vendor it links to (stored bare: no FK). Whether a
  -- row's ledger is a party's is worked out each time the import is read, from
  -- the book as it stands, and never stored (ruling R46).
  group_id INTEGER REFERENCES fin_groups(id),
  party_type TEXT CHECK (party_type IN ('customer', 'vendor')),
  party_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_import_ledgers_import_id ON fin_import_ledgers (import_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_import_ledgers_ledger_id ON fin_import_ledgers (ledger_id);
CREATE INDEX IF NOT EXISTS idx_fk_fin_import_ledgers_group_id ON fin_import_ledgers (group_id);

CREATE TABLE IF NOT EXISTS fin_import_bills (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id INTEGER NOT NULL REFERENCES fin_imports(id),
  tally_ledger_name TEXT NOT NULL,
  bill_ref TEXT,
  bill_date TEXT CHECK (bill_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  due_date TEXT CHECK (due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  amount NUMERIC(18,2) NOT NULL CHECK (amount <> 'NaN'::numeric),   -- signed: Dr positive, Cr negative, as `side` says
  side TEXT NOT NULL CHECK (side IN ('dr', 'cr'))
);
CREATE INDEX IF NOT EXISTS idx_fk_fin_import_bills_import_id ON fin_import_bills (import_id);

-- ─── Hard stops (spec §7.2, H1–H10) ───────────────────────────────────────
--
-- The rules the books keep whoever writes to them. Each refusal is an error
-- with SQLSTATE P0001 whose DETAIL is a stable FIN_ code; the app turns the
-- code into its own sentence. H2, H7 and H8 are the CHECK, the composite
-- foreign keys and the partial unique indexes above.
--
--   H1   a posted voucher has two lines or more, its debits equal its
--        credits and are more than zero (and never NaN), and its total is
--        the debits
--   H3   a posted voucher is never changed or deleted; the one change it
--        takes is reversed_by_id, once, from NULL to its own posted reversal
--   H4   the lines of a posted voucher are never added, changed or deleted
--   H5   the month is the voucher's own book's and holds the date, a real
--        calendar date; open takes anything, closing only an approved entry,
--        locked nothing, before_books only the Opening voucher or its reversal;
--        and a posting takes the strictest status of its month and of every
--        month after it, which it is carried into (rulings R70, R73)
--   H6   every ledger used is active, except in a reversal; a system-only
--        ledger is used only by the ERP's own postings, the Opening voucher
--        and reversals
--   H9   the audit log is append-only
--   H10  no TRUNCATE of the vouchers, their lines or the audit log
--
-- H5 and H6 excuse a reversal from three rules, so a reversal is proved
-- first (FIN_BAD_REVERSAL): it reverses another posted voucher of its own
-- book, mirrors that voucher's lines exactly, and that voucher is marked as
-- reversed by it at COMMIT. A reversal of the Opening voucher carries the
-- Opening voucher's own date (ruling R42), and is never reversed itself
-- (ruling R45).
--
-- Each function runs with an empty search_path, so every table in it is
-- named with its schema.

-- H3. A posted voucher is frozen. Drafts, submitted and discarded vouchers
-- are the app's business and pass untouched.
create or replace function fin_voucher_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'posted' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception using
      message = format('Voucher %s is posted and cannot be deleted. Reverse it instead.', old.number),
      detail = 'FIN_POSTED_IMMUTABLE',
      errcode = 'P0001';
  end if;
  -- Being marked reversed: reversed_by_id from NULL to the voucher's own
  -- reversal, already posted (the app posts it first, in the same
  -- transaction) in the same book, and nothing else in the row changing.
  -- Any other value would take the voucher out of H8's indexes unreversed.
  if old.reversed_by_id is null and new.reversed_by_id is not null
     and (to_jsonb(new) - 'reversed_by_id') = (to_jsonb(old) - 'reversed_by_id')
     and exists (select 1 from public.fin_vouchers r
                  where r.id = new.reversed_by_id and r.id <> old.id and r.reversal_of_id = old.id
                    and r.book_id = old.book_id and r.status = 'posted') then
    return new;
  end if;
  raise exception using
    message = case
      when old.reversed_by_id is not null
        then format('Voucher %s is posted and already reversed. Nothing about it can change.', old.number)
      when new.reversed_by_id is not null and (to_jsonb(new) - 'reversed_by_id') = (to_jsonb(old) - 'reversed_by_id')
        then format('Voucher %s can be marked reversed only by its own posted reversal.', old.number)
      else format('Voucher %s is posted and cannot be changed. Reverse it instead.', old.number)
    end,
    detail = 'FIN_POSTED_IMMUTABLE',
    errcode = 'P0001';
end;
$$;

-- H4. The lines of a posted voucher are frozen, and a line is never moved
-- into or out of one. The voucher a line belongs to (for an UPDATE, both the
-- one it leaves and the one it joins) is read FOR SHARE: that holds the
-- voucher's status still until this transaction ends, and a voucher that is
-- being posted makes this write wait for the posting, which it then sees.
-- An unlocked read would see the voucher as it was, a draft, and a line
-- written then would join a voucher that had been checked without it.
create or replace function fin_line_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  voucher_ids integer[];
  parent record;
begin
  if tg_op = 'INSERT' then
    voucher_ids := array[new.voucher_id];
  elsif tg_op = 'DELETE' then
    voucher_ids := array[old.voucher_id];
  else
    voucher_ids := array[old.voucher_id, new.voucher_id];
  end if;
  -- Lock by id alone and test the status of the row the lock returns, which
  -- is the latest one. A status test in the WHERE clause would be made on
  -- this statement's snapshot, and would leave a voucher being posted unlocked.
  for parent in
    select v.number, v.status
      from public.fin_vouchers v
     where v.id = any (voucher_ids)
     order by v.id
       for share
  loop
    if parent.status = 'posted' then
      raise exception using
        message = format('Voucher %s is posted. Its lines cannot be added, changed or deleted.', parent.number),
        detail = 'FIN_POSTED_IMMUTABLE',
        errcode = 'P0001';
    end if;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- H1, H5 and H6, for a voucher on its way into posted. The checks run in this
-- order, and the first that fails is the refusal: the reversal link, the
-- date, its month, a typed entry before the books begin, the strictest status
-- of its month and the months after it, the lines, the ledgers. They run at
-- COMMIT, on the voucher as its transaction leaves it. Its lines must be
-- written before its status: once it is posted, H4 refuses them. Marking a
-- posted voucher reversed is not a way into posted, so a voucher in a month
-- locked since it was posted can still be reversed into an open one.
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

  -- Before the books begin, only the Opening voucher and its reversal. Said
  -- first: a typed entry dated there is told so, whatever the months after
  -- it hold.
  if month_row.status = 'before_books' and new.voucher_type <> 'opening' and not reverses_opening then
    raise exception using
      message = format('%s comes ahead of the books. Only the Opening voucher, or a reversal of it, can be dated there.', month_row.label),
      detail = 'FIN_BEFORE_BOOKS',
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
  -- postings (source_type set), the Opening voucher and reversals.
  if new.source_type is null and new.voucher_type <> 'opening' and new.reversal_of_id is null then
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

-- H9. The audit log is append-only.
create or replace function fin_audit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    message = 'The Finance audit log is append-only. Its rows are never edited or deleted.',
    detail = 'FIN_AUDIT_APPEND_ONLY',
    errcode = 'P0001';
end;
$$;

-- H10. TRUNCATE fires no row trigger, so these three tables refuse it as a
-- statement, a CASCADE from any table above them included.
create or replace function fin_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    message = format('%s cannot be truncated. The books are never wiped.', tg_table_name),
    detail = 'FIN_NO_TRUNCATE',
    errcode = 'P0001';
end;
$$;

create or replace trigger fin_voucher_guard before update or delete on fin_vouchers
  for each row execute function fin_voucher_guard();
create or replace trigger fin_line_guard before insert or update or delete on fin_voucher_lines
  for each row execute function fin_line_guard();

-- PostgreSQL has no CREATE OR REPLACE for a constraint trigger, so each one
-- is created once, here, and a replay finds it and leaves it be.
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'fin_voucher_post_check_ins' and tgrelid = 'public.fin_vouchers'::regclass) then
    create constraint trigger fin_voucher_post_check_ins after insert on fin_vouchers
      deferrable initially deferred for each row when (new.status = 'posted')
      execute function fin_voucher_post_check();
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'fin_voucher_post_check_upd' and tgrelid = 'public.fin_vouchers'::regclass) then
    create constraint trigger fin_voucher_post_check_upd after update on fin_vouchers
      deferrable initially deferred for each row when (new.status = 'posted' and old.status <> 'posted')
      execute function fin_voucher_post_check();
  end if;
end
$$;

create or replace trigger fin_audit_guard before update or delete on fin_audit_log
  for each row execute function fin_audit_guard();
create or replace trigger fin_no_truncate before truncate on fin_vouchers
  for each statement execute function fin_no_truncate();
create or replace trigger fin_no_truncate before truncate on fin_voucher_lines
  for each statement execute function fin_no_truncate();
create or replace trigger fin_no_truncate before truncate on fin_audit_log
  for each statement execute function fin_no_truncate();

-- Row-level security, as tooling_* (0035) and hr.*: on, with no policies, and the
-- Supabase API roles revoked where they exist (a local database has neither).
alter table fin_books enable row level security;
alter table fin_years enable row level security;
alter table fin_periods enable row level security;
alter table fin_groups enable row level security;
alter table fin_ledgers enable row level security;
alter table fin_vouchers enable row level security;
alter table fin_voucher_lines enable row level security;
alter table fin_access enable row level security;
alter table fin_approval_rules enable row level security;
alter table fin_audit_log enable row level security;
alter table fin_imports enable row level security;
alter table fin_import_ledgers enable row level security;
alter table fin_import_bills enable row level security;
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on table fin_books, fin_years, fin_periods, fin_groups, fin_ledgers, fin_vouchers, fin_voucher_lines,
      fin_access, fin_approval_rules, fin_audit_log, fin_imports, fin_import_ledgers, fin_import_bills from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on table fin_books, fin_years, fin_periods, fin_groups, fin_ledgers, fin_vouchers, fin_voucher_lines,
      fin_access, fin_approval_rules, fin_audit_log, fin_imports, fin_import_ledgers, fin_import_bills from authenticated;
  end if;
end
$$;

-- Realtime: same guarded block as 20260918120000_fluence_realtime_ping.sql.
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array[
    'fin_books', 'fin_years', 'fin_periods', 'fin_groups', 'fin_ledgers', 'fin_vouchers', 'fin_voucher_lines',
    'fin_access', 'fin_approval_rules', 'fin_audit_log', 'fin_imports', 'fin_import_ledgers', 'fin_import_bills'
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
