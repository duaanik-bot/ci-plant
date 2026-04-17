-- Canonical pasting styles (Product Master + Die Master + hub)
CREATE TYPE "PastingStyle" AS ENUM ('LOCK_BOTTOM', 'BSO', 'SPECIAL');

-- dyes.pasting_type (varchar) -> pasting_style (enum)
ALTER TABLE "dyes" ADD COLUMN "pasting_style" "PastingStyle";

UPDATE "dyes" SET "pasting_style" = CASE
  WHEN "pasting_type" IS NULL OR BTRIM("pasting_type") = '' THEN NULL
  WHEN lower("pasting_type") ~ '(lock|crash).*(bottom|lock)|^lock bottom$|^crash' THEN 'LOCK_BOTTOM'::"PastingStyle"
  WHEN lower(BTRIM("pasting_type")) = 'bso' OR lower("dye_type") = 'bso' THEN 'BSO'::"PastingStyle"
  ELSE 'SPECIAL'::"PastingStyle"
END;

ALTER TABLE "dyes" DROP COLUMN "pasting_type";

-- cartons.carton_construct (varchar) -> pasting_style (enum)
ALTER TABLE "cartons" ADD COLUMN "pasting_style" "PastingStyle";

UPDATE "cartons" SET "pasting_style" = CASE
  WHEN "carton_construct" IS NULL OR BTRIM("carton_construct") = '' THEN NULL
  WHEN lower("carton_construct") ~ '(lock|crash).*(bottom|lock)|^lock bottom$|^crash' THEN 'LOCK_BOTTOM'::"PastingStyle"
  WHEN lower(BTRIM("carton_construct")) = 'bso' THEN 'BSO'::"PastingStyle"
  ELSE 'SPECIAL'::"PastingStyle"
END;

ALTER TABLE "cartons" DROP COLUMN "carton_construct";
