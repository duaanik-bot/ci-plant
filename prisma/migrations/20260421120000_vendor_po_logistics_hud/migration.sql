-- Logistics HUD: mill → gate tracking on vendor material POs
ALTER TABLE "vendor_material_purchase_orders"
  ADD COLUMN IF NOT EXISTS "transporter_name" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "lr_number" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "vehicle_number" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "estimated_arrival_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "logistics_status" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "logistics_updated_at" TIMESTAMP(3);
