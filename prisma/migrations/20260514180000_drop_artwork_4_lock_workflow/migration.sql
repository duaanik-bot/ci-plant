-- Deprecate the standalone 4-lock artwork workflow.
-- After this migration the canonical artwork-approval seal lives on
-- PoLineItem.specOverrides.artworkLocked (set by the planning PATCH route
-- and executePrePressFinalize). See PR 1 commit e4f579e for the wiring.
--
-- This migration is destructive — it drops the artworks and
-- artwork_approvals tables and their FKs. Plate provenance is preserved by
-- dropping plate_store.artwork_id (no replacement column; lookups now route
-- through plate_requirements.plate_barcode and plate_store.artwork_code).

-- 1. Drop foreign keys that point at artworks / artwork_approvals.
ALTER TABLE "jobs"             DROP CONSTRAINT IF EXISTS "jobs_artwork_id_fkey";
ALTER TABLE "plate_store"      DROP CONSTRAINT IF EXISTS "plate_store_artwork_id_fkey";
ALTER TABLE "artwork_approvals" DROP CONSTRAINT IF EXISTS "artwork_approvals_artwork_id_fkey";
ALTER TABLE "artwork_approvals" DROP CONSTRAINT IF EXISTS "artwork_approvals_approved_by_fkey";
ALTER TABLE "artworks"         DROP CONSTRAINT IF EXISTS "artworks_job_id_fkey";
ALTER TABLE "artworks"         DROP CONSTRAINT IF EXISTS "artworks_uploaded_by_fkey";

-- 2. Drop columns on surviving tables that reference the deleted ones.
ALTER TABLE "jobs"        DROP COLUMN IF EXISTS "artwork_id";
ALTER TABLE "plate_store" DROP COLUMN IF EXISTS "artwork_id";

-- 3. Drop the dependent table first, then the parent.
DROP TABLE IF EXISTS "artwork_approvals";
DROP TABLE IF EXISTS "artworks";

-- 4. New canonical press-side barcode lives on plate_requirements.
--    Generated at executePrePressFinalize time. Nullable so existing
--    requirements created before this migration stay valid.
ALTER TABLE "plate_requirements"
  ADD COLUMN IF NOT EXISTS "plate_barcode" VARCHAR(60);

CREATE UNIQUE INDEX IF NOT EXISTS "plate_requirements_plate_barcode_unique"
  ON "plate_requirements"("plate_barcode")
  WHERE "plate_barcode" IS NOT NULL;
