-- A trading item may belong to ONE customer: "Ripple 200 ml Jacket" is Pureflix
-- Ripple's, and must not be billed to anybody else by a slip of the picker.
-- NULL keeps today's behaviour — the item can be sold to any party. Only
-- trading items use the column; boards and chemicals leave it NULL.
--
-- APPLIED to colour-impressions-prod 2026-10-06 as the named migration
-- `trading_item_customer`.
--
-- Mirrored locally by server/src/db.js init(), which replays this file — so it
-- must stay idempotent.
--
-- LOCKS: a nullable ADD COLUMN is catalogue-only but holds ACCESS EXCLUSIVE on
-- materials until commit; the foreign key takes SHARE ROW EXCLUSIVE on
-- customers. The index build scans ~400 rows. A timeout rolls it all back.
set local lock_timeout = '1s';

ALTER TABLE materials ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_fk_materials_customer_id ON materials (customer_id);
