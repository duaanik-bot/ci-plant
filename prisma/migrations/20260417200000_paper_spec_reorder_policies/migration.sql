-- Dynamic reorder radar: per MRP radar key safety stock / max buffer
CREATE TABLE "paper_spec_reorder_policies" (
    "id" UUID NOT NULL,
    "radar_key" VARCHAR(256) NOT NULL,
    "minimum_threshold" INTEGER NOT NULL DEFAULT 0,
    "maximum_buffer" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_spec_reorder_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "paper_spec_reorder_policies_radar_key_key" ON "paper_spec_reorder_policies"("radar_key");
