-- A mirrored hold must say it is mirrored ----------------------------------
-- Purely additive: one nullable column, one FK, one index. No existing row
-- changes meaning — job_board_mix_id is NULL on every row until something
-- explicitly sets it, and NULL means exactly what it always implicitly meant
-- ("not part of a board mix").
--
-- Why: a source='stock' board_allocations row is otherwise indistinguishable
-- from a hand-placed hold made in the board hold/move panel (routes/board.js's
-- POST /board/move) — both carry material_id/order_line_id/qty/source='stock'/
-- status='active' and nothing else. helpers.js's releaseMixHolds/
-- consumeMixHolds, scoped only by order_line_id, would therefore also release
-- or consume a planner's own hand-placed hold that has nothing to do with any
-- mix. job_board_mix_id closes that gap — symmetric with the requisition_id
-- column this table already carries for source='requisition' rows: NULL means
-- "not mine, leave it alone"; set means "mine".
--
-- ON DELETE SET NULL, not CASCADE: when a mix row is deleted (always via
-- helpers.js's replaceMixPlan/clearMixPlan, always release-then-delete), its
-- hold has already been flipped out of 'active' a moment earlier, so nulling
-- the link on an already-released/consumed row is harmless bookkeeping, not a
-- live hold losing its owner. CASCADE would instead delete the hold row
-- outright — silently returning sheets to `free` that a still-active hold (had
-- one ever been deleted out of order, bypassing those helpers) said were
-- spoken for. SET NULL fails the safer way: a hold that becomes untracked by
-- the mix stays active and reachable through the existing
-- POST /board/allocations/:id/release route, rather than quietly vanishing.
--
-- Mirrors the DDL in server/src/db.js. Apply through the Supabase SQL editor —
-- the MCP apply_migration path is blocked by the permission classifier.
-- Take a backup first: npm run db:backup
BEGIN;

ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS job_board_mix_id INTEGER;
ALTER TABLE board_allocations DROP CONSTRAINT IF EXISTS board_allocations_job_board_mix_id_fkey;
ALTER TABLE board_allocations ADD CONSTRAINT board_allocations_job_board_mix_id_fkey
  FOREIGN KEY (job_board_mix_id) REFERENCES job_board_mix(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_fk_board_allocations_job_board_mix_id
  ON board_allocations (job_board_mix_id);

COMMIT;
