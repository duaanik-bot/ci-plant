-- ERP naming: per-line board queue persisted as material_queue
ALTER TABLE "material_requirements" RENAME TO "material_queue";
ALTER INDEX "material_requirements_pkey" RENAME TO "material_queue_pkey";
ALTER INDEX "material_requirements_po_line_item_id_key" RENAME TO "material_queue_po_line_item_id_key";

ALTER TABLE "material_queue" RENAME CONSTRAINT "material_requirements_purchase_order_id_fkey" TO "material_queue_purchase_order_id_fkey";
ALTER TABLE "material_queue" RENAME CONSTRAINT "material_requirements_po_line_item_id_fkey" TO "material_queue_po_line_item_id_fkey";

ALTER TABLE "material_queue" ADD COLUMN IF NOT EXISTS "total_metric_tons" DECIMAL(18,8);

UPDATE "material_queue"
SET "total_metric_tons" = CAST("total_weight_kg" AS DECIMAL(18,8)) / 1000
WHERE "total_metric_tons" IS NULL;

-- Canonical blue segment: vendor PO sent (on order)
UPDATE "po_line_items" SET "material_procurement_status" = 'on_order' WHERE "material_procurement_status" = 'dispatched';
