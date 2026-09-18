-- Fluence Prescription & Kit Master — a Fluence-only feature, fully additive.
--
-- Applied to production (Supabase colour-impressions-prod) on 2026-09-18 as the
-- named migration `fluence_prescription_kits`, sanctioned by Anik. Locally,
-- init() replays this file.
--
-- A Fluence carton is a KIT box: the plant prints the outer carton, and the
-- customer fills it with several items (tablets, sachets, serums…). The printed
-- carton carries the prescription — which item to take, how much, and when. This
-- migration gives that knowledge a master:
--
--   fluence_customers          which customers the feature is switched on for
--   fluence_inner_products     every item (or printed packaging component) that
--                              goes inside a kit, with its carton dimensions
--   fluence_kits               one kit — the customer's kit list entry, linked to
--                              the ERP product (the kit carton) it is printed as
--   fluence_kit_components     what goes into a kit, and how many of each
--   fluence_prescriptions      the kit's prescription (header) …
--   fluence_prescription_lines … and its dose lines, one per item
--   fluence_master_revisions   every change, before and after, by whom and from
--                              which module
--   fluence_part_cartons       a kit's other printed cartons (Topico filler,
--                              inner box, leaflet, tray, separator), each reading
--                              the kit of its OUTER carton
--
-- Nothing existing is altered. Every foreign key into an existing table is
-- ON DELETE SET NULL / CASCADE, so deleting a product or a customer behaves
-- exactly as it does today — a kit simply loses its link. Every statement is
-- IF NOT EXISTS / idempotent, so replaying this file is a no-op.

CREATE TABLE IF NOT EXISTS fluence_customers (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feature is switched on for Fluence by data, not by a name test at read
-- time: a later rename of the customer (its master spelling is
-- "Fluence Pharamceuticals Pvt. Ltd. ") must not silently switch it off.
INSERT INTO fluence_customers (customer_id)
SELECT id FROM customers WHERE name ILIKE 'fluence%'
ON CONFLICT (customer_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS fluence_inner_products (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  -- Upper-case letters, digits and '+' only: the de-duplication key, so
  -- "F-TRICHO GOLD" and "F TRICHO GOLD" cannot become two masters.
  name_key TEXT NOT NULL,
  -- item = what the customer packs (tablet strip, sachet, serum…);
  -- packaging = a printed component inside the kit (inner box, filler, leaflet).
  kind TEXT NOT NULL DEFAULT 'item',
  product_code TEXT,
  artwork_code TEXT,
  -- When the plant itself prints this component, the ERP product it is.
  erp_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  dosage_form TEXT,
  standard_mrp NUMERIC,
  -- Carton dimensions in millimetres. NULL means NOT YET KNOWN — never a guess.
  carton_l NUMERIC,
  carton_w NUMERIC,
  carton_h NUMERIC,
  packaging_info TEXT,
  remarks TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT fluence_inner_products_name_key_key UNIQUE (name_key),
  CONSTRAINT fluence_inner_products_kind_check CHECK (kind IN ('item', 'packaging')),
  CONSTRAINT fluence_inner_products_dims_check CHECK (
    (carton_l IS NULL OR carton_l > 0) AND (carton_w IS NULL OR carton_w > 0) AND (carton_h IS NULL OR carton_h > 0))
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_inner_products_erp_product_id
  ON fluence_inner_products (erp_product_id);

CREATE TABLE IF NOT EXISTS fluence_kits (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The kit as the customer spells it ("F1-O2"), or the product name when the
  -- kit was started from an ERP product that has no customer kit entry.
  kit_name TEXT NOT NULL,
  -- Where this kit came from, unique so an import can be re-run safely:
  -- 'customer-master:party-sl:<n>' or 'erp-product:<id>'.
  source_ref TEXT NOT NULL,
  -- The ERP product (the printed kit carton). NULL = not linked yet.
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  link_method TEXT,
  linked_at TIMESTAMPTZ,
  linked_by TEXT,
  -- A likely product for an unlinked kit. Only a person turns it into a link.
  suggested_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  suggestion_reason TEXT,
  party_sl_no INTEGER,
  valid_from DATE,
  valid_to DATE,
  kit_type TEXT,
  kit_total_mrp NUMERIC,
  -- A re-listed duplicate of another kit entry (same name, same items).
  superseded_by_kit_id INTEGER REFERENCES fluence_kits(id) ON DELETE SET NULL,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT fluence_kits_source_ref_key UNIQUE (source_ref),
  CONSTRAINT fluence_kits_product_id_key UNIQUE (product_id),
  CONSTRAINT fluence_kits_link_method_check CHECK (
    link_method IS NULL OR link_method IN ('exact_name', 'confirmed_suggestion', 'manual', 'created_from_product'))
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_kits_suggested_product_id ON fluence_kits (suggested_product_id);
CREATE INDEX IF NOT EXISTS idx_fk_fluence_kits_superseded_by_kit_id ON fluence_kits (superseded_by_kit_id);

CREATE TABLE IF NOT EXISTS fluence_kit_components (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES fluence_kits(id) ON DELETE CASCADE,
  inner_product_id INTEGER NOT NULL REFERENCES fluence_inner_products(id),
  sr INTEGER NOT NULL,
  qty_per_kit NUMERIC NOT NULL DEFAULT 1,
  -- MRP of ONE unit inside this kit, as the customer's kit list prices it.
  mrp_in_kit NUMERIC,
  remarks TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT fluence_kit_components_kit_item_key UNIQUE (kit_id, inner_product_id),
  CONSTRAINT fluence_kit_components_qty_check CHECK (qty_per_kit > 0)
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_kit_components_inner_product_id
  ON fluence_kit_components (inner_product_id);

CREATE TABLE IF NOT EXISTS fluence_prescriptions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES fluence_kits(id) ON DELETE CASCADE,
  general_instructions TEXT,
  remarks TEXT,
  -- Bumped on every save. Job cards print it, so the floor can see which
  -- revision it is working to; a save must name the revision it was based on.
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ,
  updated_by TEXT,
  updated_from TEXT,
  CONSTRAINT fluence_prescriptions_kit_id_key UNIQUE (kit_id)
);

CREATE TABLE IF NOT EXISTS fluence_prescription_lines (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prescription_id INTEGER NOT NULL REFERENCES fluence_prescriptions(id) ON DELETE CASCADE,
  sr INTEGER NOT NULL,
  -- The kit item this dose is for; item_label when it is not in the kit master.
  inner_product_id INTEGER REFERENCES fluence_inner_products(id),
  item_label TEXT,
  dosage TEXT,
  dose_form TEXT,
  -- How many tablets / capsules / sachets the pack holds.
  pack_count NUMERIC,
  frequency TEXT,
  morning_qty NUMERIC,
  afternoon_qty NUMERIC,
  evening_qty NUMERIC,
  night_qty NUMERIC,
  other_timing TEXT,
  other_qty NUMERIC,
  instructions TEXT,
  remarks TEXT,
  CONSTRAINT fluence_prescription_lines_qty_check CHECK (
    (morning_qty IS NULL OR morning_qty >= 0) AND (afternoon_qty IS NULL OR afternoon_qty >= 0) AND
    (evening_qty IS NULL OR evening_qty >= 0) AND (night_qty IS NULL OR night_qty >= 0) AND
    (other_qty IS NULL OR other_qty >= 0) AND (pack_count IS NULL OR pack_count >= 0))
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_prescription_lines_prescription_id
  ON fluence_prescription_lines (prescription_id);
CREATE INDEX IF NOT EXISTS idx_fk_fluence_prescription_lines_inner_product_id
  ON fluence_prescription_lines (inner_product_id);

CREATE TABLE IF NOT EXISTS fluence_master_revisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES fluence_kits(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  revision INTEGER,
  before JSONB,
  after JSONB,
  note TEXT,
  changed_by TEXT,
  changed_by_id INTEGER,
  changed_from TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fluence_master_revisions_area_check CHECK (area IN ('prescription', 'components', 'kit_link'))
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_master_revisions_kit_id
  ON fluence_master_revisions (kit_id, changed_at DESC);

-- Some kits are printed as several cartons. A Topico kit is its OUTER carton —
-- the one linked to the kit, carrying the MRP — plus parts: filler, inner box,
-- leaflet, tray, separator. A part carries no kit of its own. It reads the kit of
-- its outer carton, whatever kit that is now: the same prescription and contents,
-- and an edit made from a part changes that one kit. Unlink the outer carton and
-- its parts show nothing; link it again and they follow.
CREATE TABLE IF NOT EXISTS fluence_part_cartons (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  outer_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- What the part is: 'filler', 'inner box', 'leaflet', 'tray', 'separator'.
  part TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  linked_by TEXT,
  source TEXT,
  CONSTRAINT fluence_part_cartons_not_itself CHECK (product_id <> outer_product_id)
);

CREATE INDEX IF NOT EXISTS idx_fk_fluence_part_cartons_outer_product_id
  ON fluence_part_cartons (outer_product_id);
