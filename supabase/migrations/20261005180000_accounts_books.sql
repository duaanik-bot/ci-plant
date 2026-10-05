-- ACCOUNTS BOOKS: the money-out half the ERP never had. Customer invoices and
-- receipts already exist (invoices, payments); these three tables are their
-- mirror on the buying side, and together the two halves make the party ledger
-- and the cash & bank book.
--
--   purchase_bills / purchase_bill_lines — a vendor's bill. A line that names a
--     trading item lands its quantity in stock (the inward twin of the direct
--     invoice); a line with no item is value only — a board supplier's bill
--     whose goods already came in through a GRN, freight, a service.
--   vendor_payments — money paid to a vendor, against a bill or on account.
--
-- Nothing here is read by procurement, planning or production.
--
-- APPLIED to colour-impressions-prod 2026-10-05 as the named migration
-- `accounts_books`.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: new tables only. Their foreign keys take SHARE ROW EXCLUSIVE on
-- vendors, materials and stock_batches for the length of this transaction
-- (blocks a master save for milliseconds, never a read).
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS purchase_bills (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_number TEXT NOT NULL UNIQUE,          -- ours: CI-PB-0001
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  vendor_bill_no TEXT,                       -- theirs, as printed on the bill
  bill_date TEXT NOT NULL,
  subtotal DOUBLE PRECISION NOT NULL,
  tax DOUBLE PRECISION NOT NULL DEFAULT 0,
  round_off DOUBLE PRECISION NOT NULL DEFAULT 0,
  total DOUBLE PRECISION NOT NULL,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_bills_vendor_id ON purchase_bills (vendor_id);

CREATE TABLE IF NOT EXISTS purchase_bill_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES purchase_bills(id),
  material_id INTEGER REFERENCES materials(id),      -- set = stock came in with this line
  batch_id INTEGER REFERENCES stock_batches(id),     -- the pile it landed on
  description TEXT NOT NULL,
  unit TEXT,
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  rate DOUBLE PRECISION NOT NULL CHECK (rate >= 0),
  amount DOUBLE PRECISION NOT NULL,
  gst_pct DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (gst_pct >= 0)
);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_bill_lines_bill_id ON purchase_bill_lines (bill_id);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_bill_lines_material_id ON purchase_bill_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_purchase_bill_lines_batch_id ON purchase_bill_lines (batch_id);

CREATE TABLE IF NOT EXISTS vendor_payments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_number TEXT NOT NULL UNIQUE,       -- CI-PAY-0001
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  purchase_bill_id INTEGER REFERENCES purchase_bills(id),   -- NULL = on account
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL DEFAULT 'neft' CHECK (mode IN ('neft','rtgs','upi','cheque','cash')),
  reference TEXT, notes TEXT,
  paid_on TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_vendor_payments_vendor_id ON vendor_payments (vendor_id);
CREATE INDEX IF NOT EXISTS idx_fk_vendor_payments_purchase_bill_id ON vendor_payments (purchase_bill_id);

-- Realtime: same guarded block as 20260918120000_fluence_realtime_ping.sql.
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array['purchase_bills', 'purchase_bill_lines', 'vendor_payments'] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table);
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table);
  end loop;
end
$$;
