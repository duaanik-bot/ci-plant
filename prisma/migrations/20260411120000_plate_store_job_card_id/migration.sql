-- Ensure plate_store has job_card_id for Prisma PlateStore.jobCardId @map("job_card_id")
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "job_card_id" TEXT;
