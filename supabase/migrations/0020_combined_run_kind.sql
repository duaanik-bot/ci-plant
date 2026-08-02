-- 0020: Combined Runs — gang_runs learns which KIND of run it is.
--
-- A run is a numbered group of order lines that go to press together:
--   'gang'  — DIFFERENT products on one shared sheet; splits into one child
--             job card per product after die cutting.
--   'merge' — a COMBINED RUN (CI-MRG-): the SAME product on several sales
--             orders. Never splits — one pile of identical cartons runs the
--             whole route as one job card, allocated back per sales order at
--             dispatch.
-- Every existing row is a gang; DEFAULT 'gang' leaves live runs untouched.
--
-- Purely additive (ADD COLUMN IF NOT EXISTS + a recreated CHECK), so applying
-- this out of order relative to 0017-0019 is harmless. Numbered 0020 because
-- 0017 is taken on the grn-multi-line branch and 0014 has collided before.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'gang';
ALTER TABLE gang_runs DROP CONSTRAINT IF EXISTS gang_runs_kind_check;
ALTER TABLE gang_runs ADD CONSTRAINT gang_runs_kind_check CHECK (kind IN ('gang','merge'));

ALTER TABLE gang_runs ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(id);
CREATE INDEX IF NOT EXISTS idx_fk_gang_runs_product_id ON gang_runs (product_id);

COMMIT;
