-- TRADING ITEMS: goods the plant buys and sells without making them — a
-- "Ripple 200 ml jacket" has a name, a unit and a rate, and nothing else. They
-- are ordinary materials rows in their own category, so the warehouse ledger,
-- stock adjustment and the direct invoice all work on them unchanged, while
-- every board screen (which asks for category = 'board') never sees them.
--
-- APPLIED to colour-impressions-prod 2026-10-05 as the named migration
-- `trading_items`.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: the constraint swap holds ACCESS EXCLUSIVE on materials until commit
-- and validates a few hundred rows (milliseconds). A timeout rolls it back to
-- be re-run.
set local lock_timeout = '1s';

ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_category_check;
ALTER TABLE materials ADD CONSTRAINT materials_category_check
  CHECK (category IN ('board','ink','foil','adhesive','laminate','other','trading'));
