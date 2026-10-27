-- COSTING — new-product costing, worked out the way the plant's own cost sheet does it
-- (server/src/costing-engine.js), with every size ever costed kept in a Size Library apart from the
-- physical Die Master. Written 2026-10-27.
--
-- APPLIED to colour-impressions-prod 2026-10-27 as the named migration `costing` (owner's go-ahead:
-- "commit, push and deploy … apply the costing migration to production (backup first)").
--
--   costing_sizes     the Size Library: one entry per size + pasting + layout (sheet L × W, ups).
--                     Needs no die; the Die Master (the Tooling Hub's die family in `tools`) is only
--                     ever read beside it.
--   costing_batches   a bulk costing: several products costed together
--   costings          one costing: who, what, which size, and its current inputs and figures.
--                     ERP-made ones are CST-0001…; rows loaded from the old cost sheet are
--                     OLD-<row> and keep the figures the sheet itself showed (sheet_result).
--   costing_versions  every revision of a costing, append-only: inputs, formula version, figures,
--                     why it changed, who, when — so a quote can always be explained later
--   costing_settings  one row: the defaults a new costing starts from, coating factor names, and
--                     the difference that raises an alert against an earlier costing
--
-- No foreign key leaves these tables. Customer, product, die and user are kept as an id plus the
-- name as it stood, so a plant master can be renamed or deleted without touching a quotation
-- record — and the dev seed's TRUNCATE … CASCADE cannot wipe costings.
CREATE TABLE IF NOT EXISTS costing_sizes (
  id           serial PRIMARY KEY,
  -- '165x58x73' (mm, L x W x H) for a carton, '100x140' for flat work, the typed text otherwise
  size_key     text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('carton', 'flat', 'other')),
  l_mm         numeric(10,2),
  w_mm         numeric(10,2),
  h_mm         numeric(10,2),
  -- pasting as the sheet writes it: LOCK, SIDE, LIT, CUP …
  style        text,
  -- the layout: print sheet in inches and cartons a sheet
  sheet_l      numeric(10,3),
  sheet_w      numeric(10,3),
  ups          numeric(10,2),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('size_chart', 'costing', 'manual')),
  -- every cost-sheet row this entry was read from: [{ sheet, row, raw }]
  source_refs  jsonb NOT NULL DEFAULT '[]',
  notes        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   integer
);
-- One entry per size + pasting + layout: the same carton can never be entered twice.
CREATE UNIQUE INDEX IF NOT EXISTS costing_sizes_entry
  ON costing_sizes (size_key, COALESCE(style, ''), COALESCE(sheet_l, 0), COALESCE(sheet_w, 0), COALESCE(ups, 0));
CREATE INDEX IF NOT EXISTS costing_sizes_dims ON costing_sizes (l_mm, w_mm, h_mm);

CREATE TABLE IF NOT EXISTS costing_batches (
  id             serial PRIMARY KEY,
  batch_no       text NOT NULL UNIQUE,
  title          text,
  customer_id    integer,
  customer_name  text,
  -- the common settings the batch's rows started from
  common         jsonb NOT NULL DEFAULT '{}',
  archived       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer,
  created_by_name text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     integer,
  updated_by_name text
);

CREATE TABLE IF NOT EXISTS costings (
  id             serial PRIMARY KEY,
  costing_no     text NOT NULL UNIQUE,
  source         text NOT NULL DEFAULT 'erp' CHECK (source IN ('erp', 'sheet')),
  -- old cost-sheet rows: the workbook's name, the row, and a fingerprint so loading a newer copy of
  -- the workbook adds only rows not already here
  source_file    text,
  source_row     integer,
  source_key     text,
  batch_id       integer REFERENCES costing_batches(id) ON DELETE SET NULL,
  batch_pos      integer,
  customer_id    integer,
  customer_name  text,
  product_id     integer,
  product_name   text,
  size_text      text,
  size_key       text,
  size_kind      text,
  l_mm           numeric(10,2),
  w_mm           numeric(10,2),
  h_mm           numeric(10,2),
  style          text,
  size_id        integer REFERENCES costing_sizes(id) ON DELETE SET NULL,
  -- NULL only for an old cost-sheet row whose date cell was empty or unreadable
  costed_on      date DEFAULT CURRENT_DATE,
  version        integer NOT NULL DEFAULT 1,
  formula        text NOT NULL,
  inputs         jsonb NOT NULL DEFAULT '{}',
  -- computeCosting(inputs, formula) as it stood when saved
  result         jsonb,
  -- old cost-sheet rows: the figures the sheet itself showed, whether the formula gives the same,
  -- and where the sheet broke its own rule ([{ kind, text }])
  sheet_result   jsonb,
  reproduced     boolean,
  notes          jsonb NOT NULL DEFAULT '[]',
  complete       boolean NOT NULL DEFAULT false,
  -- copied out of inputs/result for lists, search and sorting
  qty            numeric(14,2),
  gsm            numeric(10,2),
  cost_per_unit  numeric(14,4),
  quote_per_unit numeric(14,4),
  cost_value     numeric(16,2),
  remarks        text,
  archived       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer,
  created_by_name text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     integer,
  updated_by_name text
);
CREATE UNIQUE INDEX IF NOT EXISTS costings_source_key ON costings (source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS costings_size_key ON costings (size_key);
CREATE INDEX IF NOT EXISTS costings_costed_on ON costings (costed_on DESC, id DESC);
CREATE INDEX IF NOT EXISTS costings_batch ON costings (batch_id, batch_pos);
CREATE INDEX IF NOT EXISTS costings_size ON costings (size_id);

CREATE TABLE IF NOT EXISTS costing_versions (
  id              serial PRIMARY KEY,
  costing_id      integer NOT NULL REFERENCES costings(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  formula         text NOT NULL,
  inputs          jsonb NOT NULL,
  result          jsonb,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      integer,
  created_by_name text,
  UNIQUE (costing_id, version)
);

CREATE TABLE IF NOT EXISTS costing_settings (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- what a new costing starts from (the cost sheet's most used values, 2025)
  defaults    jsonb NOT NULL DEFAULT '{}',
  -- [{ factor, name }] — the coating factors offered, with the plant's own names for them
  coatings    jsonb NOT NULL DEFAULT '[]',
  -- an earlier costing of the same carton that differs by more than this % raises an alert
  alert_pct   numeric(6,2) NOT NULL DEFAULT 15,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  integer
);
INSERT INTO costing_settings (id, defaults, coatings)
VALUES (1,
  '{"wastage": 250, "colours": 4, "print_rate": 400, "print_min": 1600, "process": 2000, "dp_rate": 0.3, "emb_rate": 0, "pf_pct": 5, "misc_pct": 0, "margin": 0.05}',
  '[{"factor": 6, "name": ""}, {"factor": 3, "name": ""}, {"factor": 2, "name": ""}]')
ON CONFLICT (id) DO NOTHING;

-- Same lock-down as the other private tables: the server connects as owner.
ALTER TABLE costing_sizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE costings ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE costing_settings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON costing_sizes, costing_batches, costings, costing_versions, costing_settings FROM anon, authenticated;
  END IF;
END $$;

-- Announce changes on the realtime feed like every table a screen reads
-- (20260918120000_fluence_realtime_ping.sql is the template), so a costing saved on one screen shows
-- on another at once. Guarded: a database without the realtime function (every local one) skips it.
set local lock_timeout = '1s';
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array['costing_sizes', 'costing_batches', 'costings', 'costing_settings'] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table);
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table);
  end loop;
end
$$;
