-- Shortage response: awaiting replacement flag + replacement ETA for lead-buffer.

ALTER TABLE "vendor_material_purchase_orders"
  ADD COLUMN IF NOT EXISTS "procurement_shortage_flag" VARCHAR(48),
  ADD COLUMN IF NOT EXISTS "replacement_eta_at" TIMESTAMP(3);
