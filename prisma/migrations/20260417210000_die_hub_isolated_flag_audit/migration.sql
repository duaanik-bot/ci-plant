-- Die Hub: isolated poor-condition flag (does not replace physical condition columns)
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "hub_status_flag" VARCHAR(32);
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "hub_poor_reported_by" VARCHAR(120);

-- Immutable log: canonical action + return condition snapshot
ALTER TABLE "die_hub_events" ADD COLUMN IF NOT EXISTS "hub_action" VARCHAR(64);
ALTER TABLE "die_hub_events" ADD COLUMN IF NOT EXISTS "event_condition" VARCHAR(16);

-- Operator Master: staff ledger (name + active only)
ALTER TABLE "operator_master" DROP COLUMN IF EXISTS "department";
