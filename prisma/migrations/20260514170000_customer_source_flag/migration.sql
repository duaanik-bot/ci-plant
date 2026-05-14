-- Audit flag for customers. NULL means manual entry (legacy or operator-created).
-- Auto-created masters from PO PDF import set source = 'po_import_ai' so they
-- can be surfaced for review in the customer master list.

ALTER TABLE "customers"
  ADD COLUMN "source" TEXT;

-- Partial index — only the small set of unreviewed AI imports needs fast lookup.
CREATE INDEX "customers_source_idx"
  ON "customers"("source")
  WHERE "source" IS NOT NULL;
