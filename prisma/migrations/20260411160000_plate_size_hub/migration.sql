-- CreateEnum
CREATE TYPE "PlateSize" AS ENUM ('SIZE_560_670', 'SIZE_630_700');

-- AlterTable
ALTER TABLE "cartons" ADD COLUMN "plate_size" "PlateSize";

ALTER TABLE "plate_store" ADD COLUMN "plate_size" "PlateSize" NOT NULL DEFAULT 'SIZE_560_670';

ALTER TABLE "plate_requirements" ADD COLUMN "plate_size" "PlateSize";

-- Prefer carton master when PO line is linked
UPDATE "plate_requirements" pr
SET "plate_size" = c.plate_size
FROM "po_line_items" pol
JOIN "cartons" c ON c.id = pol.carton_id
WHERE pr.po_line_id = pol.id
  AND pr.plate_size IS NULL
  AND c.plate_size IS NOT NULL;

-- Shop default for any remaining legacy rows
UPDATE "plate_requirements" SET "plate_size" = 'SIZE_560_670' WHERE "plate_size" IS NULL;
