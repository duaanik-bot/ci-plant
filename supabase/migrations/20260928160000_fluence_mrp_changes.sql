-- The MRP trail of the Fluence module — every change to an MRP it keeps, old and
-- new, who made it and from where, and whether Colour Impressions has seen it.
--
--   subject          'inner_product' — an inner product's standard MRP
--                    'kit_item'      — an item's MRP in one kit (fluence_kit_components)
--   item_name,        the names as they were when the MRP changed, so the trail
--   kit_name         reads the same after a rename or a deletion
--   old_mrp/new_mrp  NULL = no MRP on record
--   outside          1 = changed from a customer's own login (only Fluence
--                    ticked): it waits, flagged, until Colour Impressions
--                    management acknowledges it (ack_*), and management is told
--                    at once. 0 = a Colour Impressions login; nothing to acknowledge.
--
-- Written by server/src/routes/fluence.js (recordMrpChanges) and Kit Studio's
-- inner product save; read and acknowledged on Fluence → MRP updates and in the
-- notification centre.
--
-- Additive and idempotent: a new table, two indexes, the realtime ping triggers
-- (guarded — a database without the realtime function, every local one, skips
-- them). Replayed by server/src/db.js init() after the Kit Studio file.
-- APPLIED to colour-impressions-prod 2026-09-28 as the named migration
-- `fluence_mrp_changes`, before the code that writes it was deployed.
CREATE TABLE IF NOT EXISTS fluence_mrp_changes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject TEXT NOT NULL CHECK (subject IN ('inner_product', 'kit_item')),
  inner_product_id INTEGER REFERENCES fluence_inner_products(id) ON DELETE SET NULL,
  kit_id INTEGER REFERENCES fluence_kits(id) ON DELETE SET NULL,
  item_name TEXT,
  kit_name TEXT,
  old_mrp NUMERIC(12,2),
  new_mrp NUMERIC(12,2),
  changed_by TEXT NOT NULL,
  changed_by_id INTEGER,
  outside INTEGER NOT NULL DEFAULT 0,
  changed_from TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ack_at TIMESTAMPTZ,
  ack_by TEXT,
  ack_by_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fluence_mrp_changes_at ON fluence_mrp_changes (changed_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_fluence_mrp_changes_open ON fluence_mrp_changes (changed_at DESC) WHERE outside = 1 AND ack_at IS NULL;

do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  execute 'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.fluence_mrp_changes for each row execute function public.ci_erp_realtime_ping()';
  execute 'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.fluence_mrp_changes for each statement execute function public.ci_erp_realtime_ping()';
end
$$;
