-- Kit Studio — carton sizing, layout and draft kits for the Fluence kit master.
-- Fully additive: four new kit_studio_* tables, nothing existing is altered.
--
-- Kit Studio started as a stand-alone page. It moves into the ERP as its own
-- module, sitting ON the Fluence master rather than beside it:
--
--   kit_studio_kits       one row per kit — its outer carton size, how sure we
--                         are of it, the carton layout and the studio's notes.
--                         WHAT is in the kit is not stored here: it is read
--                         from, and written to, fluence_kit_components.
--   kit_studio_products   one row per inner product — its carton size and how
--                         sure we are of it. A CONFIRMED size is also written to
--                         fluence_inner_products.carton_l/w/h, so every module
--                         reading the Fluence master sees it.
--   kit_studio_drafts     kits being designed that are not kits yet.
--   kit_studio_settings   the studio's clearance rules (one row, 'main').
--
-- Every studio document keeps its full shape in `data`; the columns beside it
-- are the parts other screens may want to query (size, status, the link).
--
-- APPLIED to colour-impressions-prod 2026-09-26 as the named migration
-- `kit_studio` (tables + realtime pings, no data). The Kit Studio artifact's data
-- was then imported into these tables, and CONFIRMED sizes filled into the
-- Fluence master only where it had none (fluence_inner_products.carton_*, and
-- products.size of linked kit cartons) — each fill has an audit_log row by
-- 'Kit Studio import'.
--
-- Every foreign key into an existing table is ON DELETE SET NULL, so deleting a
-- Fluence kit or inner product behaves exactly as it does today — the studio
-- row simply loses its link. Every statement is IF NOT EXISTS / idempotent, so
-- replaying this file (init() does, locally) is a no-op.

CREATE TABLE IF NOT EXISTS kit_studio_kits (
  -- The studio's own id ('k001' …, or 'f<fluence kit id>' for a kit first
  -- opened in the studio after it was created in the Fluence master).
  id TEXT PRIMARY KEY,
  fluence_kit_id INTEGER REFERENCES fluence_kits(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  family TEXT,
  -- Outer carton, millimetres. NULL = not known.
  carton_l NUMERIC,
  carton_w NUMERIC,
  carton_h NUMERIC,
  size_status TEXT NOT NULL DEFAULT 'MISSING',
  size_source TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Bumped on every save; a save names the version it was based on, so two
  -- people editing one kit cannot silently overwrite each other.
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT kit_studio_kits_fluence_kit_id_key UNIQUE (fluence_kit_id),
  CONSTRAINT kit_studio_kits_size_status_check CHECK (size_status IN ('CONFIRMED', 'PROPOSED', 'VERIFY', 'CONFLICT', 'MISSING')),
  CONSTRAINT kit_studio_kits_dims_check CHECK (
    (carton_l IS NULL OR carton_l > 0) AND (carton_w IS NULL OR carton_w > 0) AND (carton_h IS NULL OR carton_h > 0))
);

CREATE TABLE IF NOT EXISTS kit_studio_products (
  -- The studio's own id ('p001' …, or 'i<inner product id>').
  id TEXT PRIMARY KEY,
  fluence_inner_product_id INTEGER REFERENCES fluence_inner_products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  carton_l NUMERIC,
  carton_w NUMERIC,
  carton_h NUMERIC,
  size_status TEXT NOT NULL DEFAULT 'MISSING',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT kit_studio_products_fluence_inner_product_id_key UNIQUE (fluence_inner_product_id),
  CONSTRAINT kit_studio_products_size_status_check CHECK (size_status IN ('CONFIRMED', 'PROPOSED', 'VERIFY', 'CONFLICT', 'MISSING')),
  CONSTRAINT kit_studio_products_dims_check CHECK (
    (carton_l IS NULL OR carton_l > 0) AND (carton_w IS NULL OR carton_w > 0) AND (carton_h IS NULL OR carton_h > 0))
);

CREATE TABLE IF NOT EXISTS kit_studio_drafts (
  id TEXT PRIMARY KEY,
  name TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS kit_studio_settings (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- The studio's tables announce their changes on the realtime feed like the
-- Fluence tables do (20260918120000_fluence_realtime_ping.sql), so one person's
-- save reaches another person's open studio. Guarded: a database without the
-- realtime function (every local one) skips it.
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array[
    'kit_studio_kits',
    'kit_studio_products',
    'kit_studio_drafts',
    'kit_studio_settings'
  ] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table
    );
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table
    );
  end loop;
end
$$;
