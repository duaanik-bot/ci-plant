-- Plate store: serial, output, rack number, UPS (sheet ups) for hub add-stock modal
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "serial_number" TEXT;
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "output_number" TEXT;
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "rack_number" TEXT;
ALTER TABLE "plate_store" ADD COLUMN IF NOT EXISTS "ups" INTEGER;
