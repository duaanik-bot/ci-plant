-- Three columns that reached server/src/db.js init() but were never applied to
-- production, because the waves that added them were committed and then not
-- deployed. Production ran fine without them only because the code that queries
-- them was also unshipped; deploying that code against a database lacking these
-- columns would fail on the live plant.
--
--   machines.is_default      <- station default machine wave
--   order_lines.is_p1        <- per-product P1 wave
--   products.block_number    <- foil/emboss block number wave
--
-- Delta counterpart of the matching statements in init(). Copied statement for
-- statement rather than reworded, so the two cannot drift.
--
-- Additive only: no column is dropped, retyped, or renamed, and every statement
-- is idempotent, so replaying this is a no-op.

BEGIN;

-- ── products.block_number ───────────────────────────────────────────────────
-- Foil/emboss block number — auto-populates Planning, Artwork and the Job Card.
ALTER TABLE products ADD COLUMN IF NOT EXISTS block_number TEXT;

-- ── order_lines.is_p1 ──────────────────────────────────────────────────────
-- P1 moved from the order to the product LINE: the star marks one product, not
-- the whole PO. The DO block backfills the old order-level flag onto its lines
-- exactly once (only when the column is first created), so a later per-line
-- clear is never re-overwritten by a replay. orders.is_p1 already exists here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='order_lines' AND column_name='is_p1') THEN
    ALTER TABLE order_lines ADD COLUMN is_p1 INTEGER NOT NULL DEFAULT 0;
    UPDATE order_lines ol SET is_p1=1 FROM orders o WHERE o.id=ol.order_id AND o.is_p1=1;
  END IF;
END $$;

-- ── machines.is_default ────────────────────────────────────────────────────
-- Cutting and printing start jobs on the flagged machine automatically; one
-- flag per category, enforced on write in routes/masters.js.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_default INTEGER NOT NULL DEFAULT 0;

-- Board cutting is the normal path for cartons, so it is the plant's cutting
-- default. Guarded on "no default yet in this category" so it seeds once and
-- never overrides a later choice made in Masters → Machines.
UPDATE machines SET is_default = 1
WHERE type = 'cutting' AND name = 'Board Cutting Machine'
  AND NOT EXISTS (SELECT 1 FROM machines WHERE type = 'cutting' AND is_default = 1);

COMMIT;
