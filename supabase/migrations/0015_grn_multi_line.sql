-- 0015 — GRN becomes a multi-line priced document.
--
-- `grns` is RENAMED IN PLACE to grn_headers. That is the load-bearing choice:
-- ids are preserved, so every conversations thread, audit entry and
-- notification already pointing at a GRN id still resolves to the right
-- document. Nothing referencing a GRN needs remapping.
--
-- stock_movements are NOT migrated: they carry ref_type='grn', ref_id=<grn id>,
-- and those ids are header ids after the rename, so every existing row stays
-- correct. Line identity remains recoverable through batch_id.
BEGIN;

-- 1. Rename the table. Ids, FKs and sequences all follow it.
ALTER TABLE grns RENAME TO grn_headers;

-- 2. The lines table.
CREATE TABLE IF NOT EXISTS grn_lines (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grn_header_id  INTEGER NOT NULL REFERENCES grn_headers(id),
  po_line_id     INTEGER REFERENCES po_lines(id),
  material_id    INTEGER NOT NULL REFERENCES materials(id),
  qty            DOUBLE PRECISION NOT NULL,
  unit           TEXT,
  rate           DOUBLE PRECISION NOT NULL DEFAULT 0,
  discount_pct   DOUBLE PRECISION NOT NULL DEFAULT 0,
  gst_rate       DOUBLE PRECISION NOT NULL DEFAULT 0,
  hsn_code       TEXT,
  batch_no       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'quarantine'
                 CHECK (status IN ('quarantine','accepted','rejected')),
  qc_at          TIMESTAMPTZ,
  qc_note        TEXT
);

-- 3. Extract exactly one line per existing header.
--    The LEFT JOIN po_lines is deliberate: every historic PO-backed receipt
--    inherits its PO rate and gains a value retroactively. Direct receipts
--    land at rate 0 — honestly unknown, not falsely free.
INSERT INTO grn_lines (grn_header_id, po_line_id, material_id, qty, unit,
                       rate, gst_rate, hsn_code, batch_no, status, qc_at, qc_note)
SELECT h.id, h.po_line_id, h.material_id, h.qty, m.unit,
       COALESCE(pl.rate, 0), COALESCE(m.gst_rate, 0), m.hsn_code,
       h.batch_no, h.status, h.qc_at, h.qc_note
FROM grn_headers h
JOIN materials m ON m.id = h.material_id
LEFT JOIN po_lines pl ON pl.id = h.po_line_id;

-- 4. Repoint stock batches at the line, through the 1:1 mapping step 3 created.
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS grn_line_id INTEGER REFERENCES grn_lines(id);
UPDATE stock_batches sb
   SET grn_line_id = gl.id
  FROM grn_lines gl
 WHERE gl.grn_header_id = sb.grn_id;

-- 5. Batch landed cost. Backfilled where the line knows a rate; left NULL
--    otherwise, which is what a pre-costing direct batch honestly is.
ALTER TABLE stock_batches ADD COLUMN IF NOT EXISTS rate DOUBLE PRECISION;
UPDATE stock_batches sb
   SET rate = gl.rate
  FROM grn_lines gl
 WHERE gl.id = sb.grn_line_id AND gl.rate > 0;

ALTER TABLE stock_batches DROP COLUMN IF EXISTS grn_id;

-- 6. Header gains its document-level money fields and sheds the per-board ones.
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS tax_kind TEXT NOT NULL DEFAULT 'intra';
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS freight DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS round_off DOUBLE PRECISION;

ALTER TABLE grn_headers DROP COLUMN IF EXISTS po_line_id;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS material_id;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qty;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS batch_no;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS status;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qc_at;
ALTER TABLE grn_headers DROP COLUMN IF EXISTS qc_note;

-- 7. Indexes.
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_header_id   ON grn_lines (grn_header_id);
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_material_id ON grn_lines (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_grn_lines_po_line_id  ON grn_lines (po_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_stock_batches_grn_line_id ON stock_batches (grn_line_id);

-- 8. Names the rename left behind.
--    Postgres carries index, constraint and sequence names across
--    ALTER TABLE … RENAME, so a migrated database would keep calling these
--    `grns_*` forever while a database freshly built from init() calls them
--    `grn_headers_*`. Same schema, different catalog — which is exactly the
--    kind of drift that makes a later migration behave differently in
--    production than it did in dev. All catalog-only, no table rewrite.
DROP INDEX IF EXISTS idx_fk_grns_purchase_order_id;
DROP INDEX IF EXISTS idx_fk_grns_vendor_id;
CREATE INDEX IF NOT EXISTS idx_fk_grn_headers_purchase_order_id ON grn_headers (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_fk_grn_headers_vendor_id ON grn_headers (vendor_id);

-- Renaming a constraint-backed index renames the constraint with it.
ALTER INDEX IF EXISTS grns_pkey RENAME TO grn_headers_pkey;
ALTER INDEX IF EXISTS grns_grn_number_key RENAME TO grn_headers_grn_number_key;
ALTER SEQUENCE IF EXISTS grns_id_seq RENAME TO grn_headers_id_seq;

-- Foreign keys have no IF EXISTS on RENAME CONSTRAINT, so they are guarded.
DO $$ BEGIN
  ALTER TABLE grn_headers RENAME CONSTRAINT grns_purchase_order_id_fkey TO grn_headers_purchase_order_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE grn_headers RENAME CONSTRAINT grns_vendor_id_fkey TO grn_headers_vendor_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

COMMIT;
