-- 0023: the Customer-WIP flag learns WHEN.
--
-- order_lines.wip has marked "the customer calls this urgent" since the Status
-- Sheet shipped. The customer's own WIP list carries a date per item, and the
-- new upload-and-map flow records it: wip_date is the date a line was marked,
-- taken from the uploaded sheet when it has one, today otherwise. Cleared when
-- the flag is taken off — a date with no flag is a stale claim.
--
-- Purely additive (one nullable TEXT column holding YYYY-MM-DD — dates ride
-- as text in this schema, the same as orders.po_date/delivery_date, so JSON
-- serialisation can never shift the day across timezones); every existing row
-- reads NULL and no behaviour changes until a line is marked.
--
-- Apply through the Supabase SQL editor. Take a backup first (npm run db:backup).
BEGIN;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS wip_date TEXT;

COMMIT;
