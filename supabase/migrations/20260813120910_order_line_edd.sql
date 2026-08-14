-- EDD per PRODUCT, as an override of the order's own delivery date.
--
-- orders.delivery_date is ONE date for the whole PO. On the live Status Sheet
-- 161 of 205 lines (79%) sit on a PO carrying several products, and one PO
-- carries 26 — so an order-level column cannot hold the customer's WIP list,
-- which names a delivery date per ITEM. Two products of one PO wanting
-- different days was simply unanswerable there.
--
-- An OVERRIDE, not a move. NULL means "follow the order", so every existing row
-- reads exactly as it does today and Planning, Dispatch and every other screen
-- keep reading orders.delivery_date untouched. Only the Status Sheet resolves
-- COALESCE(ol.delivery_date, o.delivery_date).
--
-- Purely additive (one nullable TEXT column — dates ride as text in this schema,
-- like orders.po_date and order_lines.wip_date, so JSON serialisation can never
-- shift the day across a timezone). Adding a nullable column with no default is
-- metadata-only in Postgres 11+: no table rewrite, no meaningful lock.
--
-- MUST BE APPLIED BEFORE the code that ships with it: GET /status-sheet selects
-- ol.delivery_date.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS delivery_date TEXT;

COMMIT;
