-- DIRECT (trading) invoices: a tax invoice raised straight from stock — board
-- out of the warehouse, cartons out of loose FG — with no order, job card or
-- challan behind it. For goods the plant trades rather than makes.
--
-- The header is an ordinary `invoices` row (kind = 'direct', its own CI-TRD-
-- series), so payments, the outstanding ledger and the sales register read it
-- with no change. Its lines live in their OWN table: invoice_lines is welded to
-- a dispatch line (dispatch_line_id NOT NULL UNIQUE) and every production-side
-- query inner-joins through it, so a direct invoice is simply invisible to all
-- of them — the manufacturing chain is untouched.
--
-- APPLIED to colour-impressions-prod 2026-10-05 as the named migration
-- `direct_invoices`.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: ADD COLUMN with a constant default is catalogue-only (no rewrite) but
-- holds ACCESS EXCLUSIVE on invoices until commit; the CHECK validates ~a few
-- hundred rows. The new foreign keys take SHARE ROW EXCLUSIVE on invoices,
-- materials and products (blocks master saves for milliseconds, never a read).
-- A timeout rolls the whole file back to be re-run.
set local lock_timeout = '1s';

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'dispatch';
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_kind_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_kind_check CHECK (kind IN ('dispatch','direct'));

CREATE TABLE IF NOT EXISTS direct_invoice_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  -- What left the shelf: a board/material from the warehouse, or a finished
  -- carton from loose FG stock. Exactly one of the two ids is set.
  item_type TEXT NOT NULL CHECK (item_type IN ('board','carton')),
  material_id INTEGER REFERENCES materials(id),
  product_id INTEGER REFERENCES products(id),
  -- Frozen at billing: a tax invoice must not change when a master is renamed.
  description TEXT NOT NULL,
  hsn TEXT,
  unit TEXT NOT NULL,
  qty DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  rate DOUBLE PRECISION NOT NULL CHECK (rate >= 0),
  amount DOUBLE PRECISION NOT NULL,
  gst_pct DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (gst_pct >= 0),
  CONSTRAINT direct_invoice_lines_one_item CHECK (
    (item_type = 'board'  AND material_id IS NOT NULL AND product_id IS NULL) OR
    (item_type = 'carton' AND product_id  IS NOT NULL AND material_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_fk_direct_invoice_lines_invoice_id ON direct_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fk_direct_invoice_lines_material_id ON direct_invoice_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_direct_invoice_lines_product_id ON direct_invoice_lines (product_id);

-- Realtime: same guarded block as 20260918120000_fluence_realtime_ping.sql.
do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  execute 'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.direct_invoice_lines for each row execute function public.ci_erp_realtime_ping()';
  execute 'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.direct_invoice_lines for each statement execute function public.ci_erp_realtime_ping()';
end
$$;
