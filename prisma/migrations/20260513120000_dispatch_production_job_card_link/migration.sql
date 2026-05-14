-- Bridge dispatch queue to the production-flow ProductionJobCard.
-- Additive: makes legacy job_id nullable, adds optional production_job_card_id FK + index.
-- Existing rows keep their job_id. New rows originating from pasting completion populate
-- production_job_card_id instead.

-- 1) Make legacy FK nullable.
ALTER TABLE "dispatches"
  ALTER COLUMN "job_id" DROP NOT NULL;

-- 2) Drop and recreate FK so it allows NULLs (Postgres keeps NOT NULL on the FK side
--    unless we recreate the constraint).
ALTER TABLE "dispatches"
  DROP CONSTRAINT IF EXISTS "dispatches_job_id_fkey";

ALTER TABLE "dispatches"
  ADD CONSTRAINT "dispatches_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- 3) Add production_job_card_id (nullable) + FK to production_job_cards.
ALTER TABLE "dispatches"
  ADD COLUMN "production_job_card_id" TEXT;

ALTER TABLE "dispatches"
  ADD CONSTRAINT "dispatches_production_job_card_id_fkey"
  FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Index for the dispatch queue lookup (join + filter by job card).
CREATE INDEX "dispatches_production_job_card_id_idx"
  ON "dispatches"("production_job_card_id");
