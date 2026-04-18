-- QC gate on GRN receipts + usable kg rollup on vendor PO
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN IF NOT EXISTS "total_usable_received_kg" DECIMAL(16,6) NOT NULL DEFAULT 0;

ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_status" VARCHAR(16);
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_actual_gsm" DECIMAL(8,2);
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_shade_match" BOOLEAN;
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_surface_cleanliness" BOOLEAN;
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_remarks" TEXT;
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_performed_by_user_id" TEXT;
ALTER TABLE "vendor_material_receipts" ADD COLUMN IF NOT EXISTS "qc_performed_at" TIMESTAMP(3);

-- Grandfather existing gate entries as QC-passed so usable stock matches prior gross behaviour
UPDATE "vendor_material_receipts"
SET
  "qc_status" = 'PASSED',
  "qc_performed_at" = COALESCE("qc_performed_at", "created_at")
WHERE "qc_status" IS NULL;

UPDATE "vendor_material_purchase_orders" v
SET "total_usable_received_kg" = sub.usable
FROM (
  SELECT "vendor_po_id", COALESCE(SUM("received_qty"), 0) AS usable
  FROM "vendor_material_receipts"
  WHERE "qc_status" = 'PASSED'
  GROUP BY "vendor_po_id"
) sub
WHERE v.id = sub."vendor_po_id";
