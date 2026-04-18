-- Interconnected inventory: floor splits + issue traceability
ALTER TABLE "paper_warehouse" ADD COLUMN "originated_from_id" UUID;

ALTER TABLE "paper_warehouse" ADD CONSTRAINT "paper_warehouse_originated_from_id_fkey" FOREIGN KEY ("originated_from_id") REFERENCES "paper_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "paper_issue_to_floor" (
    "id" UUID NOT NULL,
    "source_paper_warehouse_id" UUID NOT NULL,
    "destination_warehouse_id" UUID,
    "production_job_card_id" UUID,
    "qty_sheets" INTEGER NOT NULL,
    "operator_user_id" TEXT NOT NULL,
    "operator_name" TEXT NOT NULL,
    "high_priority_authorized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_issue_to_floor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "paper_issue_to_floor_source_paper_warehouse_id_idx" ON "paper_issue_to_floor"("source_paper_warehouse_id");

ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_source_paper_warehouse_id_fkey" FOREIGN KEY ("source_paper_warehouse_id") REFERENCES "paper_warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "paper_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "paper_issue_to_floor" ADD CONSTRAINT "paper_issue_to_floor_production_job_card_id_fkey" FOREIGN KEY ("production_job_card_id") REFERENCES "production_job_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;
