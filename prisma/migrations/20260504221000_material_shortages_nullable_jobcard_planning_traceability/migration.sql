-- Make planning-only shortages possible before Job Card creation.
-- Safe for existing records: preserves FK and existing data.

ALTER TABLE "material_shortages"
  ADD COLUMN IF NOT EXISTS "source_po_line_id" TEXT,
  ADD COLUMN IF NOT EXISTS "trigger_reason" VARCHAR(64);

ALTER TABLE "material_shortages"
  ALTER COLUMN "job_card_id" DROP NOT NULL;
