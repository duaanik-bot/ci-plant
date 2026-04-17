-- Die Hub operational intelligence: hold state, maintenance timestamp, event operator column
ALTER TABLE "die_hub_events" ADD COLUMN IF NOT EXISTS "operator_name" VARCHAR(120);

ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "hub_triage_hold_reason" VARCHAR(500);
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "hub_maintenance_completed_at" TIMESTAMP(3);
