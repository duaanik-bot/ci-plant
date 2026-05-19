-- Performance indexes for dashboard / hot-path queries.
-- These columns are filtered/sorted on every dashboard load but were unindexed,
-- forcing sequential scans on Postgres (slow both locally and on Neon).

-- CreateIndex
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "jobs_due_date_idx" ON "jobs"("due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "jobs_status_due_date_idx" ON "jobs"("status", "due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_stages_completed_at_idx" ON "job_stages"("completed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_stages_machine_id_completed_at_idx" ON "job_stages"("machine_id", "completed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_stages_machine_id_started_at_idx" ON "job_stages"("machine_id", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "inventory_reorder_point_idx" ON "inventory"("reorder_point");
