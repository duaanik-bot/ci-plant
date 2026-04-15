-- Plate Hub triage + impression tracking
ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "triage_channel" VARCHAR(40);
ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "po_line_id" TEXT;

ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "total_impressions" INTEGER NOT NULL DEFAULT 0;
