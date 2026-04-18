-- Shift operator on job card; ledger yield + incentive fields

ALTER TABLE "production_job_cards" ADD COLUMN IF NOT EXISTS "shift_operator_user_id" TEXT;

ALTER TABLE "production_oee_ledgers" ADD COLUMN IF NOT EXISTS "yield_percent" DECIMAL(6,2);
ALTER TABLE "production_oee_ledgers" ADD COLUMN IF NOT EXISTS "incentive_eligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "production_oee_ledgers" ADD COLUMN IF NOT EXISTS "incentive_verified_at" TIMESTAMP(3);
ALTER TABLE "production_oee_ledgers" ADD COLUMN IF NOT EXISTS "attributed_operator_user_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_shift_operator_user_id_fkey" FOREIGN KEY ("shift_operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_attributed_operator_user_id_fkey" FOREIGN KEY ("attributed_operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "production_oee_ledgers_attributed_operator_user_id_idx" ON "production_oee_ledgers"("attributed_operator_user_id");
