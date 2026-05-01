-- CreateTable
CREATE TABLE "effect_categories" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 100,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "effect_values" (
  "id" TEXT NOT NULL,
  "category_id" TEXT NOT NULL,
  "value" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 100,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "effect_values_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "effect_categories_name_key" ON "effect_categories"("name");
CREATE UNIQUE INDEX "effect_values_category_id_value_key" ON "effect_values"("category_id", "value");
CREATE INDEX "effect_values_category_id_active_sort_order_idx" ON "effect_values"("category_id", "active", "sort_order");

-- FKs
ALTER TABLE "effect_values"
ADD CONSTRAINT "effect_values_category_id_fkey"
FOREIGN KEY ("category_id") REFERENCES "effect_categories"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed default categories
INSERT INTO "effect_categories" ("id", "name", "sort_order", "active", "created_at", "updated_at") VALUES
  (gen_random_uuid()::text, 'Embossing', 10, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'Coating', 20, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'Foil', 30, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'Pasting', 40, true, NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;

-- Seed default values
INSERT INTO "effect_values" ("id", "category_id", "value", "description", "sort_order", "active", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."id", v."value", NULL, v."sort_order", true, NOW(), NOW()
FROM "effect_categories" c
JOIN (
  VALUES
    ('Embossing', 'None', 10),
    ('Embossing', 'Embossing', 20),
    ('Embossing', 'Debossing', 30),
    ('Embossing', 'Braille Embossing', 40),
    ('Coating', 'None', 10),
    ('Coating', 'Gloss', 20),
    ('Coating', 'Matt', 30),
    ('Coating', 'UV', 40),
    ('Coating', 'Drip-off', 50),
    ('Foil', 'None', 10),
    ('Foil', 'Gold Foil', 20),
    ('Foil', 'Silver Foil', 30),
    ('Pasting', 'Straight Line', 10),
    ('Pasting', 'Lock Bottom', 20),
    ('Pasting', '4 Corner', 30),
    ('Pasting', '6 Corner', 40)
) AS v("category", "value", "sort_order") ON v."category" = c."name"
ON CONFLICT ("category_id", "value") DO NOTHING;
