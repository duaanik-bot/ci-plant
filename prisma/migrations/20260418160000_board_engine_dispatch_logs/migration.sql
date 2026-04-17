-- Supplier: default board grades for procurement routing
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "default_for_board_grades" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Vendor PO dispatch audit
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN IF NOT EXISTS "dispatched_at" TIMESTAMP(3);
ALTER TABLE "vendor_material_purchase_orders" ADD COLUMN IF NOT EXISTS "dispatch_actor" VARCHAR(120);

-- Material requirements (per customer PO line)
CREATE TABLE IF NOT EXISTS "material_requirements" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "po_line_item_id" TEXT NOT NULL,
    "board_type" TEXT NOT NULL,
    "gsm" INTEGER NOT NULL,
    "grain_direction" VARCHAR(64) NOT NULL,
    "sheet_length_mm" DECIMAL(12,4) NOT NULL,
    "sheet_width_mm" DECIMAL(12,4) NOT NULL,
    "ups" INTEGER NOT NULL,
    "wastage_pct" DECIMAL(8,4) NOT NULL,
    "order_qty" INTEGER NOT NULL,
    "total_sheets" INTEGER NOT NULL,
    "total_weight_kg" DECIMAL(16,6) NOT NULL,
    "formula_version" VARCHAR(32) NOT NULL DEFAULT 'erp_board_v1',
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_requirements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "material_requirements_po_line_item_id_key" ON "material_requirements"("po_line_item_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_requirements_purchase_order_id_fkey') THEN
    ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_purchase_order_id_fkey"
      FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'material_requirements_po_line_item_id_fkey') THEN
    ALTER TABLE "material_requirements" ADD CONSTRAINT "material_requirements_po_line_item_id_fkey"
      FOREIGN KEY ("po_line_item_id") REFERENCES "po_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Communication audit (email / WhatsApp)
CREATE TABLE IF NOT EXISTS "communication_logs" (
    "id" TEXT NOT NULL,
    "channel" VARCHAR(24) NOT NULL,
    "direction" VARCHAR(16) NOT NULL DEFAULT 'outbound',
    "subject" VARCHAR(500),
    "body_preview" VARCHAR(2000),
    "to_address" VARCHAR(320),
    "status" VARCHAR(24) NOT NULL DEFAULT 'sent',
    "error_message" TEXT,
    "metadata" JSONB,
    "related_table" VARCHAR(80),
    "related_id" VARCHAR(36),
    "actor_label" VARCHAR(120) NOT NULL DEFAULT 'Anik Dua',
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "communication_logs_related_idx" ON "communication_logs"("related_table", "related_id");

-- Line procurement status: legacy paper_ordered → dispatched; default not_calculated
ALTER TABLE "po_line_items" ALTER COLUMN "material_procurement_status" DROP DEFAULT;
UPDATE "po_line_items" SET "material_procurement_status" = 'dispatched' WHERE "material_procurement_status" = 'paper_ordered';
ALTER TABLE "po_line_items" ALTER COLUMN "material_procurement_status" SET DEFAULT 'not_calculated';
