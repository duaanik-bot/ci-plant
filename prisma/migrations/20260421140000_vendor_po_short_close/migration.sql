-- Auto short-close (≤2% variance tolerance) on vendor material POs
ALTER TABLE "vendor_material_purchase_orders"
  ADD COLUMN IF NOT EXISTS "is_short_closed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "short_close_reason" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "short_closed_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "short_close_completion_pct" DECIMAL(6,2);
