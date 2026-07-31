-- Multi-board consumption ---------------------------------------------------
-- Adds job_board_mix. Purely additive: no existing table, column, constraint or
-- index is touched, and no existing row changes meaning. A job with no rows in
-- this table behaves exactly as it does today.
--
-- A job is PLANNED against one board and that never changes. What changes is
-- what it actually eats: 4,000 sheets of 300 GSM is routinely finished as 2,500
-- of 300 plus 1,500 of 290, because that is what the warehouse holds.
--
-- A row is "N parent sheets of THIS board against this job". covers restates
-- that in the PLANNED board's units so a balance can be struck against one
-- requirement. phase='plan' rows come from the Planning Engine; phase='issued'
-- rows are written at Cutting Start and are the truth.
--
-- Mirrors the DDL in server/src/db.js. Apply through the Supabase SQL editor —
-- the MCP apply_migration path is blocked by the permission classifier.
-- Take a backup first: npm run db:backup
BEGIN;

CREATE TABLE IF NOT EXISTS job_board_mix (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id   INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  material_id     INTEGER NOT NULL REFERENCES materials(id),
  stock_batch_id  INTEGER REFERENCES stock_batches(id) ON DELETE SET NULL,
  sheets          DOUBLE PRECISION NOT NULL CHECK (sheets > 0),
  ups             INTEGER NOT NULL CHECK (ups > 0),
  covers          DOUBLE PRECISION NOT NULL CHECK (covers > 0),
  role            TEXT NOT NULL CHECK (role IN ('planned','substitute')),
  phase           TEXT NOT NULL CHECK (phase IN ('plan','issued')),
  reason          TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_order_line_id
  ON job_board_mix (order_line_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_material_id
  ON job_board_mix (material_id);
CREATE INDEX IF NOT EXISTS idx_fk_job_board_mix_stock_batch_id
  ON job_board_mix (stock_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_board_mix_line_phase
  ON job_board_mix (order_line_id, phase);

COMMIT;
