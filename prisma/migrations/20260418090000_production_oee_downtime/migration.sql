-- Production OEE ledger, downtime tracking, stage pulse timestamps, optional press on job card

ALTER TABLE "production_job_cards" ADD COLUMN IF NOT EXISTS "machine_id" TEXT;

ALTER TABLE "production_stage_records" ADD COLUMN IF NOT EXISTS "last_production_tick_at" TIMESTAMP(3);
ALTER TABLE "production_stage_records" ADD COLUMN IF NOT EXISTS "in_progress_since" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "production_downtime_logs" (
    "id" TEXT NOT NULL,
    "production_job_card_id" TEXT NOT NULL,
    "production_stage_record_id" TEXT,
    "machine_id" TEXT,
    "operator_user_id" TEXT NOT NULL,
    "reason_category" VARCHAR(48) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_seconds" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_downtime_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "production_oee_ledgers" (
    "id" TEXT NOT NULL,
    "production_job_card_id" TEXT NOT NULL,
    "machine_id" TEXT,
    "availability_pct" DECIMAL(6,2) NOT NULL,
    "performance_pct" DECIMAL(6,2) NOT NULL,
    "quality_pct" DECIMAL(6,2) NOT NULL,
    "oee_pct" DECIMAL(6,2) NOT NULL,
    "shift_minutes" INTEGER NOT NULL,
    "run_minutes" INTEGER NOT NULL,
    "rated_speed_pph" DECIMAL(12,4),
    "actual_avg_speed_pph" DECIMAL(12,4),
    "good_pieces" INTEGER NOT NULL,
    "total_pieces" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_oee_ledgers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "production_oee_ledgers_production_job_card_id_key" ON "production_oee_ledgers"("production_job_card_id");

CREATE INDEX IF NOT EXISTS "production_downtime_logs_production_job_card_id_idx" ON "production_downtime_logs"("production_job_card_id");
CREATE INDEX IF NOT EXISTS "production_downtime_logs_started_at_idx" ON "production_downtime_logs"("started_at");
CREATE INDEX IF NOT EXISTS "production_downtime_logs_reason_category_idx" ON "production_downtime_logs"("reason_category");

DO $$ BEGIN
  ALTER TABLE "production_job_cards" ADD CONSTRAINT "production_job_cards_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_production_stage_record_id_fkey" FOREIGN KEY ("production_stage_record_id") REFERENCES "production_stage_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_downtime_logs" ADD CONSTRAINT "production_downtime_logs_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "production_oee_ledgers" ADD CONSTRAINT "production_oee_ledgers_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
