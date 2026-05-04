-- Allow planning-stage shortages without a job card and preserve source traceability.
ALTER TABLE "material_shortages"
  ALTER COLUMN "job_card_id" DROP NOT NULL;

ALTER TABLE "material_shortages"
  ADD COLUMN IF NOT EXISTS "source_po_line_id" TEXT,
  ADD COLUMN IF NOT EXISTS "trigger_reason" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "material_shortages_planning_status_idx"
  ON "material_shortages" ("planning_id", "status");

CREATE INDEX IF NOT EXISTS "material_shortages_source_po_line_idx"
  ON "material_shortages" ("source_po_line_id");
