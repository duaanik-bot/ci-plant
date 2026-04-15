-- Inventory hub: custody columns + shade_cards
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock';
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "issued_machine_id" TEXT;
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "issued_operator" TEXT;
ALTER TABLE "dyes" ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMPTZ;

ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock';
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "issued_machine_id" TEXT;
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "issued_operator" TEXT;
ALTER TABLE "emboss_blocks" ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS "shade_cards" (
    "id" TEXT NOT NULL,
    "shade_code" TEXT NOT NULL,
    "product_master" TEXT,
    "master_artwork_ref" TEXT,
    "approval_date" DATE,
    "ink_component" TEXT,
    "current_holder" TEXT,
    "impression_count" INTEGER NOT NULL DEFAULT 0,
    "custody_status" VARCHAR(32) NOT NULL DEFAULT 'in_stock',
    "issued_machine_id" TEXT,
    "issued_operator" TEXT,
    "issued_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shade_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shade_cards_shade_code_key" ON "shade_cards"("shade_code");
