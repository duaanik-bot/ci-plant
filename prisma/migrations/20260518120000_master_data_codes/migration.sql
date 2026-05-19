-- 1. Add nullable code columns
ALTER TABLE "effect_categories" ADD COLUMN "code" VARCHAR(48);
ALTER TABLE "effect_values"     ADD COLUMN "code" VARCHAR(48);

-- 2. Backfill category codes from name (SCREAMING_SNAKE), curated overrides
UPDATE "effect_categories"
SET "code" = upper(regexp_replace(btrim("name"), '[^A-Za-z0-9]+', '_', 'g'));

UPDATE "effect_categories" SET "code" = 'BOARD_TYPE'   WHERE lower("name") = 'board type';
UPDATE "effect_categories" SET "code" = 'BOARD_COLOUR' WHERE lower("name") IN ('board colour','board color');
UPDATE "effect_categories" SET "code" = 'COATING'      WHERE lower("name") = 'coating';
UPDATE "effect_categories" SET "code" = 'FOIL'         WHERE lower("name") = 'foil';
UPDATE "effect_categories" SET "code" = 'EMBOSS'       WHERE lower("name") IN ('emboss','embossing');
UPDATE "effect_categories" SET "code" = 'PASTING'      WHERE lower("name") = 'pasting';
UPDATE "effect_categories" SET "code" = 'UNIT'         WHERE lower("name") IN ('unit','uom','units','unit of measure');

-- 3. Backfill value codes from value text (SCREAMING_SNAKE)
UPDATE "effect_values"
SET "code" = upper(regexp_replace(btrim("value"), '[^A-Za-z0-9]+', '_', 'g'));

-- Curated unit value codes (only rows under the UNIT category)
UPDATE "effect_values" v SET "code" = m.code
FROM (VALUES
  ('numbers','NOS'), ('number','NOS'), ('nos','NOS'), ('pcs','NOS'), ('pieces','NOS'),
  ('kilogram','KG'), ('kg','KG'),
  ('sheets','SHT'), ('sheet','SHT'),
  ('box','BOX'),
  ('gross','GRS'), ('grs','GRS'),
  ('tonnes','TON'), ('tonne','TON'),
  ('metres','MTR'), ('meter','MTR'),
  ('litres','LTR'), ('litre','LTR'),
  ('packets','PKT'), ('packet','PKT'),
  ('cartons','CTN'), ('labels','LBL'), ('set','SET')
) AS m(label, code)
WHERE v."category_id" IN (SELECT id FROM "effect_categories" WHERE "code" = 'UNIT')
  AND lower(btrim(v."value")) = m.label;

-- 4. De-duplicate any colliding (category_id, code) before adding unique index:
--    suffix dupes with _2, _3 ... keeping the lowest sort_order as canonical
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY category_id, code ORDER BY sort_order, value) AS rn
  FROM "effect_values"
)
UPDATE "effect_values" e
SET "code" = e."code" || '_' || ranked.rn
FROM ranked
WHERE e.id = ranked.id AND ranked.rn > 1;

-- 5. Enforce NOT NULL + uniqueness
ALTER TABLE "effect_categories" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "effect_values"     ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "effect_categories_code_key" ON "effect_categories"("code");
CREATE UNIQUE INDEX "effect_values_category_id_code_key" ON "effect_values"("category_id","code");

-- 6. Repoint label-storing record fields → unit codes (UNIT only).
--    Unmapped values are left untouched (MasterSelect keeps them visible).
UPDATE "inventory" SET "unit" = 'SHT' WHERE lower(btrim("unit")) IN ('sheets','sheet');
UPDATE "inventory" SET "unit" = 'KG'  WHERE lower(btrim("unit")) = 'kg';
UPDATE "inventory" SET "unit" = 'GRS' WHERE lower(btrim("unit")) IN ('grs','gross');
UPDATE "inventory" SET "unit" = 'TON' WHERE lower(btrim("unit")) IN ('tonnes','tonne');
UPDATE "inventory" SET "unit" = 'PKT' WHERE lower(btrim("unit")) IN ('packets','packet');
UPDATE "inventory" SET "unit" = 'MTR' WHERE lower(btrim("unit")) IN ('metres','meter');
UPDATE "inventory" SET "unit" = 'LTR' WHERE lower(btrim("unit")) IN ('litres','litre');
UPDATE "inventory" SET "unit" = 'NOS' WHERE lower(btrim("unit")) IN ('pieces','piece','nos');
