-- Shade Card Hub fields + EmbossBlock → Machine FK

ALTER TABLE "shade_cards" ADD COLUMN "last_verified_at" DATE;
ALTER TABLE "shade_cards" ADD COLUMN "delta_e_reading" DECIMAL(5,2);
ALTER TABLE "shade_cards" ADD COLUMN "approval_attachment_url" VARCHAR(600);
ALTER TABLE "shade_cards" ADD COLUMN "spectro_report_summary" TEXT;
ALTER TABLE "shade_cards" ADD COLUMN "color_swatch_hex" VARCHAR(7);
ALTER TABLE "shade_cards" ADD COLUMN "customer_id" TEXT;

CREATE INDEX "shade_cards_customer_id_idx" ON "shade_cards"("customer_id");

ALTER TABLE "shade_cards" ADD CONSTRAINT "shade_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "emboss_blocks" ADD CONSTRAINT "emboss_blocks_issued_machine_id_fkey" FOREIGN KEY ("issued_machine_id") REFERENCES "machines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
