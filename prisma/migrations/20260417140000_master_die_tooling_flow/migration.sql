-- Product master ↔ Die master link; PO line tooling snapshot; downstream metadata.
ALTER TABLE "cartons" ADD COLUMN IF NOT EXISTS "die_master_id" UUID REFERENCES "dyes"("id") ON DELETE SET NULL;

ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "die_master_id" UUID REFERENCES "dyes"("id") ON DELETE SET NULL;
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "tooling_locked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "line_die_type" TEXT;
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "dim_length_mm" DECIMAL(12, 4);
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "dim_width_mm" DECIMAL(12, 4);
ALTER TABLE "po_line_items" ADD COLUMN IF NOT EXISTS "dim_height_mm" DECIMAL(12, 4);

ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "die_master_id" UUID REFERENCES "dyes"("id") ON DELETE SET NULL;

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "die_master_id" UUID REFERENCES "dyes"("id") ON DELETE SET NULL;
