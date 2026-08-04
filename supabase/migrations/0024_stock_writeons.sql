-- A write-on is the system admitting its own book was wrong: more board left
-- the warehouse than the book said existed. We record it rather than let the
-- balance go negative, because no shelf holds minus one hundred and fifty
-- sheets and every number derived from SUM(qty) inherits the lie.

CREATE TABLE IF NOT EXISTS stock_writeons (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  qty             DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  book_before     DOUBLE PRECISION NOT NULL,
  issued_qty      DOUBLE PRECISION NOT NULL,
  batch_id        INTEGER REFERENCES stock_batches(id),
  ref_type        TEXT NOT NULL,
  ref_id          INTEGER,
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at   TIMESTAMPTZ,
  reconciled_by   TEXT,
  counted_qty     DOUBLE PRECISION,
  reconcile_note  TEXT
);

CREATE INDEX IF NOT EXISTS idx_writeons_open
  ON stock_writeons (material_id) WHERE reconciled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_writeons_ref
  ON stock_writeons (ref_type, ref_id);

-- A flag, not a role, matching xs_approver / reverse_approver: an admin plant
-- login must not silently inherit the warehouse's recount queue.
ALTER TABLE users ADD COLUMN IF NOT EXISTS warehouse_notify INTEGER NOT NULL DEFAULT 0;

UPDATE users SET warehouse_notify = 1
  WHERE role = 'admin'
    AND NOT EXISTS (SELECT 1 FROM users WHERE warehouse_notify = 1);
