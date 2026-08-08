-- Cover every Plate lifecycle foreign key used by operational joins and
-- cascades. The first migration keeps the model readable; this follow-up is
-- separate because the live preview was advisor-checked after installation.
CREATE INDEX IF NOT EXISTS idx_plate_masters_vendor ON plate_masters(preferred_vendor_id);
CREATE INDEX IF NOT EXISTS idx_plate_assets_master ON plate_assets(plate_master_id);
CREATE INDEX IF NOT EXISTS idx_plate_assets_vendor ON plate_assets(vendor_id);
CREATE INDEX IF NOT EXISTS idx_plate_components_master ON plate_request_components(plate_master_id);
CREATE INDEX IF NOT EXISTS idx_plate_components_proposed ON plate_request_components(proposed_asset_id);
CREATE INDEX IF NOT EXISTS idx_plate_components_grn ON plate_request_components(grn_id);
CREATE INDEX IF NOT EXISTS idx_plate_movements_component ON plate_asset_movements(request_component_id);
CREATE INDEX IF NOT EXISTS idx_plate_movements_machine ON plate_asset_movements(machine_id);
