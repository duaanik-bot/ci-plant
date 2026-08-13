-- Status Sheet: the planner's own note against an order line.
--
-- The Status Sheet's export is sent to customers, and it was asked to carry a
-- Remarks column. Nothing on order_lines could hold one: order_lines.notes
-- exists but the production and short-close paths write it, so a coordination
-- remark and a machine-written note would share a field and overwrite each
-- other. This is a separate column for a separate author.
--
-- Purely additive (one nullable TEXT column); every existing row reads NULL and
-- no behaviour changes until someone types a remark. Adding a nullable column
-- with no default is metadata-only in Postgres 11+, so there is no table
-- rewrite and no meaningful lock on order_lines.
--
-- MUST BE APPLIED BEFORE the code that ships with it: GET /status-sheet
-- selects ol.remarks, so the page 500s on prod for as long as the deploy is
-- ahead of this migration.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS remarks TEXT;

COMMIT;
