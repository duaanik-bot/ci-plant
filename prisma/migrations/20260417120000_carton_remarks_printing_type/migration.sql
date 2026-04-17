-- Carton Master: persist remarks and printing type from the UI.
ALTER TABLE "cartons" ADD COLUMN IF NOT EXISTS "remarks" TEXT;
ALTER TABLE "cartons" ADD COLUMN IF NOT EXISTS "printing_type" TEXT;
