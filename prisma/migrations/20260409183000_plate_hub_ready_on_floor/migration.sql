-- Plate Hub: staging custody (READY_ON_FLOOR) + reverse metadata
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "hub_custody_source" VARCHAR(32);
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "hub_previous_status" VARCHAR(32);

-- Widen status to fit READY_ON_FLOOR and future values
ALTER TABLE "plate_store" ALTER COLUMN "status" TYPE VARCHAR(24);
