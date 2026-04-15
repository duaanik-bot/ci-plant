-- Track column entry time for Plate Hub analytics
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "last_status_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "plate_store" SET "last_status_updated_at" = COALESCE("updated_at", "created_at") WHERE "last_status_updated_at" IS NULL;

ALTER TABLE "plate_requirements" ADD COLUMN IF NOT EXISTS "last_status_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "plate_requirements" SET "last_status_updated_at" = COALESCE("updated_at", "created_at") WHERE "last_status_updated_at" IS NULL;
