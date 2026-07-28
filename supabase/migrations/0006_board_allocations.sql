-- Board allocation --------------------------------------------------------
-- Until now "committed" was a live SUM over planned order lines — nobody could
-- HOLD board, so whichever job reached cutting first consumed the pile. A row
-- here is an explicit claim: N parent sheets of this board are earmarked for
-- this job, either from warehouse stock or from an incoming requisition.
-- board-allocation.js turns these rows into the planning engine's numbers; with
-- no rows it returns exactly what the old formula returned.
CREATE TABLE IF NOT EXISTS board_allocations (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  qty             DOUBLE PRECISION NOT NULL CHECK (qty > 0),
  source          TEXT NOT NULL CHECK (source IN ('stock','requisition')),
  requisition_id  INTEGER REFERENCES requisitions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','released','consumed')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_by     TEXT,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alloc_material_active
  ON board_allocations (material_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_order_line_id
  ON board_allocations (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_requisition_id
  ON board_allocations (requisition_id);
