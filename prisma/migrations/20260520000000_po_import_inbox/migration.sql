-- CreateTable
CREATE TABLE "po_import_jobs" (
    "id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "file_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "po_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "po_import_items" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "pdf_bytes" BYTEA,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "customer_id" TEXT,
    "detection" JSONB,
    "extracted" JSONB,
    "catalog" JSONB,
    "error_message" TEXT,
    "committed_po_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "po_import_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "po_import_jobs_created_by_created_at_idx" ON "po_import_jobs"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "po_import_items_job_id_status_idx" ON "po_import_items"("job_id", "status");

-- AddForeignKey
ALTER TABLE "po_import_items" ADD CONSTRAINT "po_import_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "po_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
