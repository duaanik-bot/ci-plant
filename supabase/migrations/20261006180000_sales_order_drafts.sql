-- Draft sales orders and draft product masters (owner's request, 6 Oct 2026).
--
-- The AVS order intake reads each new customer PO from the company mailbox and
-- now keys it into the ERP itself. What it keys is a DRAFT: it shows on Sales
-- Orders, Sales Pendency and the Status Sheet in orange, but it is not demand —
-- Planning never sees it — until a person has checked it against the PO and
-- pressed Confirm order. A product the intake had to create for a new item is a
-- draft master in the same way, until it is confirmed (with its order, or on its
-- own in Masters).
--
--   orders.status       'draft'  → 'pending' on Confirm (routes/orders.js)
--   order_lines.status  'draft'  → 'pending' with its order; every planning,
--                                  board and floor query names the statuses it
--                                  wants ('pending','planned',…), so a draft
--                                  line is never picked up by any of them
--   products.is_draft   1        → 0 on Confirm
--
-- A line inserted under a draft order is a draft line whoever inserts it — the
-- intake's SQL, an edit that adds a line, or a carton's hidden part lines — so
-- the trigger below does it once, in the database.
--
-- Idempotent: init() replays it on every boot (DROP-then-ADD constraints,
-- IF NOT EXISTS columns, CREATE OR REPLACE function, DROP-then-CREATE trigger).

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft','pending','hold','completed','closed','cancelled'));

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_status_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_status_check
  CHECK (status IN ('draft','pending','planned','ready','in_production','produced','dispatched','cancelled'));

-- Where a draft came from and who confirmed it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS draft_source TEXT;        -- e.g. 'avs_intake'
ALTER TABLE orders ADD COLUMN IF NOT EXISTS draft_note TEXT;          -- what the intake wants a person to check
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
-- When the team was told about this draft (bell + phone push, routes/drafts.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS draft_notified_at TIMESTAMPTZ;

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_draft INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS draft_source TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS draft_note TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS drafted_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS confirmed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_draft ON orders (id) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS idx_orders_draft_unnotified ON orders (id) WHERE status = 'draft' AND draft_notified_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_draft ON products (id) WHERE is_draft = 1;

-- A line booked under a draft order is a draft line.
CREATE OR REPLACE FUNCTION order_lines_follow_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending'
     AND EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND status = 'draft') THEN
    NEW.status := 'draft';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_lines_follow_draft ON order_lines;
CREATE TRIGGER order_lines_follow_draft BEFORE INSERT ON order_lines
  FOR EACH ROW EXECUTE FUNCTION order_lines_follow_draft();

-- A product made as a draft remembers when.
CREATE OR REPLACE FUNCTION products_stamp_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_draft = 1 AND NEW.drafted_at IS NULL THEN
    NEW.drafted_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS products_stamp_draft ON products;
CREATE TRIGGER products_stamp_draft BEFORE INSERT OR UPDATE OF is_draft ON products
  FOR EACH ROW EXECUTE FUNCTION products_stamp_draft();
