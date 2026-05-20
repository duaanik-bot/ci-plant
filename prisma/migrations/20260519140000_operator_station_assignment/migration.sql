-- CreateTable
CREATE TABLE "operator_station_assignment" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "stage_key" VARCHAR(40) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_station_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_station_assignment_stage_key_idx" ON "operator_station_assignment"("stage_key");

-- CreateIndex
CREATE UNIQUE INDEX "operator_station_assignment_operator_id_stage_key_key" ON "operator_station_assignment"("operator_id", "stage_key");

-- AddForeignKey
ALTER TABLE "operator_station_assignment" ADD CONSTRAINT "operator_station_assignment_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operator_master"("id") ON DELETE CASCADE ON UPDATE CASCADE;
