-- Short-close audit: remarks + actor display name
ALTER TABLE "vendor_material_purchase_orders"
  ADD COLUMN IF NOT EXISTS "short_close_remarks" TEXT,
  ADD COLUMN IF NOT EXISTS "short_closed_by_user_id" TEXT,
  ADD COLUMN IF NOT EXISTS "short_closed_by_name" VARCHAR(120);

ALTER TABLE "vendor_material_purchase_orders"
  ALTER COLUMN "short_close_reason" TYPE VARCHAR(120);
