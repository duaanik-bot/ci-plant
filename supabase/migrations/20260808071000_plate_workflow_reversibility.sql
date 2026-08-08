-- Editable Plate PRs and stage-by-stage purchasing reversals.
-- Physical plates, POs and GRNs remain in history; only an unconverted Plate PR
-- may be deliberately deleted through the authorised application action.

ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS saved_by TEXT;
ALTER TABLE tooling_requests ADD COLUMN IF NOT EXISTS saved_at TIMESTAMPTZ;
ALTER TABLE tooling_requests DROP CONSTRAINT IF EXISTS tooling_requests_approval_status_check;
ALTER TABLE tooling_requests ADD CONSTRAINT tooling_requests_approval_status_check
  CHECK (approval_status IN ('draft','saved','pending','approved','converted','rejected','closed'));

UPDATE tooling_requests
SET approval_status='saved', saved_by=COALESCE(created_by,'System'), saved_at=COALESCE(updated_at,created_at)
WHERE family='plate' AND approval_status='pending';

ALTER TABLE plate_request_components ADD COLUMN IF NOT EXISTS approval_from_status TEXT;

ALTER TABLE tooling_purchase_orders ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE tooling_purchase_orders ADD COLUMN IF NOT EXISTS reversed_by TEXT;
ALTER TABLE tooling_purchase_orders ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE tooling_purchase_orders DROP CONSTRAINT IF EXISTS tooling_purchase_orders_status_check;
ALTER TABLE tooling_purchase_orders ADD CONSTRAINT tooling_purchase_orders_status_check
  CHECK (status IN ('open','partially_received','received','closed','reversed'));

ALTER TABLE tooling_grns ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE tooling_grns ADD COLUMN IF NOT EXISTS reversed_by TEXT;
ALTER TABLE tooling_grns ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
ALTER TABLE tooling_grns DROP CONSTRAINT IF EXISTS tooling_grns_status_check;
ALTER TABLE tooling_grns ADD CONSTRAINT tooling_grns_status_check
  CHECK (status IN ('quarantine','accepted','rejected','reversed'));

ALTER TABLE plate_assets DROP CONSTRAINT IF EXISTS plate_assets_status_check;
ALTER TABLE plate_assets ADD CONSTRAINT plate_assets_status_check CHECK (status IN (
  'available','awaiting_verification','reserved','issued_to_printing',
  'returned_pending_verification','damaged','scrapped','lost','replaced','reversed'
));

ALTER TABLE plate_asset_movements DROP CONSTRAINT IF EXISTS plate_asset_movements_action_check;
ALTER TABLE plate_asset_movements ADD CONSTRAINT plate_asset_movements_action_check CHECK (action IN (
  'received','verification_requested','verified','reserved','issued','returned',
  'damaged','scrapped','not_found','replacement_required','location_changed','adjustment','reversed'
));
