-- Board Stock Verification — the warehouse's pre-cutting physical check.
-- Each row is one verification EVENT for one board material; the latest row
-- per material is its current verification state, and the full history stays
-- queryable for the audit trail and the records export. required_qty /
-- available_qty snapshot the moment of the count, so a verification taken
-- against yesterday's job set can be seen to be stale rather than silently
-- trusted. This table NEVER moves stock — physical differences go through the
-- existing warehouse adjustment paths, and cutting is never gated on it.

CREATE TABLE IF NOT EXISTS board_verifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  status TEXT NOT NULL CHECK (status IN ('pending','verified','mismatch','not_found','partial')),
  physical_qty DOUBLE PRECISION,
  required_qty DOUBLE PRECISION,
  available_qty DOUBLE PRECISION,
  shortage_qty DOUBLE PRECISION,
  excess_qty DOUBLE PRECISION,
  remarks TEXT,
  verified_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_board_verifications_material
  ON board_verifications (material_id, id DESC);
