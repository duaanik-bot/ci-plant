-- Individual printing-plate lifecycle. A Plate Master is a controlled size,
-- not one SKU per colour: CMYK and Pantone are requirement/asset attributes.
-- Existing aggregate tooling_inventory_items stay untouched for audit history.

INSERT INTO tooling_inventory_items
  (family,master_key,code,name,specification,size,tool_type,unit,active)
VALUES
  ('plate','plate-size|560x670','CI-PL-560670','Printing Plate 560 x 670',
   'Controlled plate size; colour is an asset attribute','560 x 670','Offset plate','nos',1),
  ('plate','plate-size|600x730','CI-PL-600730','Printing Plate 600 x 730',
   'Controlled plate size; colour is an asset attribute','600 x 730','Offset plate','nos',1)
ON CONFLICT (master_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS plate_masters (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  plate_size TEXT NOT NULL UNIQUE,
  allowed_components TEXT[] NOT NULL DEFAULT ARRAY['cyan','magenta','yellow','black','pantone']::text[],
  inventory_item_id INTEGER NOT NULL UNIQUE REFERENCES tooling_inventory_items(id),
  preferred_vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  hsn_code TEXT,
  gst_rate DOUBLE PRECISION NOT NULL DEFAULT 18,
  standard_lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (standard_lead_time_days >= 0),
  remarks TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(allowed_components) > 0)
);

INSERT INTO plate_masters (code,plate_size,inventory_item_id)
SELECT 'CI-PL-560670','560 x 670',id
FROM tooling_inventory_items WHERE master_key='plate-size|560x670'
ON CONFLICT (plate_size) DO NOTHING;

INSERT INTO plate_masters (code,plate_size,inventory_item_id)
SELECT 'CI-PL-600730','600 x 730',id
FROM tooling_inventory_items WHERE master_key='plate-size|600x730'
ON CONFLICT (plate_size) DO NOTHING;

CREATE TABLE IF NOT EXISTS plate_assets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_number TEXT NOT NULL UNIQUE,
  plate_master_id INTEGER NOT NULL REFERENCES plate_masters(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  output_number TEXT,
  artwork_reference TEXT,
  artwork_version TEXT NOT NULL,
  component_type TEXT NOT NULL CHECK (component_type IN ('cyan','magenta','yellow','black','pantone')),
  component_label TEXT NOT NULL,
  pantone_code TEXT,
  source_grn_id INTEGER REFERENCES tooling_grns(id) ON DELETE SET NULL,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  purchase_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  plate_created_on DATE NOT NULL DEFAULT CURRENT_DATE,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  rack_location TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN (
    'available','awaiting_verification','reserved','issued_to_printing',
    'returned_pending_verification','damaged','scrapped','lost'
  )),
  condition TEXT NOT NULL DEFAULT 'Good' CHECK (condition IN ('Good','Fair','Damaged','Scrapped','Lost')),
  current_job_card_id INTEGER REFERENCES job_cards(id) ON DELETE SET NULL,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  remarks TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plate_assets_match
  ON plate_assets(product_id,output_number,artwork_version,plate_master_id,component_type,status);
CREATE INDEX IF NOT EXISTS idx_plate_assets_rack ON plate_assets(status,rack_location);
CREATE INDEX IF NOT EXISTS idx_plate_assets_job ON plate_assets(current_job_card_id);
CREATE INDEX IF NOT EXISTS idx_plate_assets_grn ON plate_assets(source_grn_id);

CREATE TABLE IF NOT EXISTS plate_request_components (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tooling_request_id INTEGER NOT NULL REFERENCES tooling_requests(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  component_type TEXT NOT NULL CHECK (component_type IN ('cyan','magenta','yellow','black','pantone')),
  component_label TEXT NOT NULL,
  pantone_code TEXT,
  plate_master_id INTEGER REFERENCES plate_masters(id),
  status TEXT NOT NULL DEFAULT 'existing_plate_check' CHECK (status IN (
    'existing_plate_check','verification_required','verified_existing','pr_required',
    'approved','po_created','ordered','grn_received','available','reserved','issued',
    'returned_pending_verification','damaged','scrapped','not_found','replacement_required','cancelled'
  )),
  proposed_asset_id INTEGER REFERENCES plate_assets(id) ON DELETE SET NULL,
  matched_asset_id INTEGER REFERENCES plate_assets(id) ON DELETE SET NULL,
  po_line_id INTEGER REFERENCES tooling_po_lines(id) ON DELETE SET NULL,
  grn_id INTEGER REFERENCES tooling_grns(id) ON DELETE SET NULL,
  verified_found INTEGER,
  verified_condition_ok INTEGER,
  verified_artwork_ok INTEGER,
  verified_colour_ok INTEGER,
  verified_size_ok INTEGER,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tooling_request_id,sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_plate_components_request
  ON plate_request_components(tooling_request_id,status,sequence_no);
CREATE INDEX IF NOT EXISTS idx_plate_components_asset ON plate_request_components(matched_asset_id);
CREATE INDEX IF NOT EXISTS idx_plate_components_po_line ON plate_request_components(po_line_id);

CREATE TABLE IF NOT EXISTS plate_asset_movements (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plate_asset_id INTEGER NOT NULL REFERENCES plate_assets(id),
  request_component_id INTEGER REFERENCES plate_request_components(id) ON DELETE SET NULL,
  tooling_request_id INTEGER REFERENCES tooling_requests(id) ON DELETE SET NULL,
  job_card_id INTEGER REFERENCES job_cards(id) ON DELETE SET NULL,
  machine_id INTEGER REFERENCES machines(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN (
    'received','verification_requested','verified','reserved','issued','returned',
    'damaged','scrapped','not_found','replacement_required','location_changed','adjustment'
  )),
  from_status TEXT,
  to_status TEXT,
  from_location TEXT,
  to_location TEXT,
  condition TEXT,
  note TEXT,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plate_movements_asset ON plate_asset_movements(plate_asset_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_plate_movements_request ON plate_asset_movements(tooling_request_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_plate_movements_job ON plate_asset_movements(job_card_id,id DESC);

ALTER TABLE plate_masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE plate_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE plate_request_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE plate_asset_movements ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON TABLE plate_masters,plate_assets,plate_request_components,plate_asset_movements FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON TABLE plate_masters,plate_assets,plate_request_components,plate_asset_movements FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ci_local_preview') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
      plate_masters,plate_assets,plate_request_components,plate_asset_movements TO ci_local_preview;
    GRANT USAGE,SELECT ON SEQUENCE plate_masters_id_seq,plate_assets_id_seq,
      plate_request_components_id_seq,plate_asset_movements_id_seq TO ci_local_preview;
  END IF;
END
$$;

DO $$
DECLARE
  target_table TEXT;
BEGIN
  IF pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') IS NOT NULL THEN
    FOREACH target_table IN ARRAY ARRAY[
      'plate_masters','plate_assets','plate_request_components','plate_asset_movements'
    ] LOOP
      EXECUTE pg_catalog.format('DROP TRIGGER IF EXISTS ci_erp_realtime_ping ON public.%I', target_table);
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER ci_erp_realtime_ping AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ci_erp_realtime_ping()',
        target_table
      );
    END LOOP;
  END IF;
END
$$;
