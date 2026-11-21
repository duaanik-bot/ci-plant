-- The sales order against an order finalised on the enquiry desk (owner, 21 Nov 2026: "once the sales order comes, it can
-- track it and fill the actual rates … but still keep it finalised"). The actual rate and quantity ride on each line of
-- enquiry_orders.lines (actual_rate, actual_qty, actual_po, …) beside the rate finalised; this records when and by whom
-- they were taken from the sales order. Additive; replayed by init(); idempotent.
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS so_checked_at timestamptz;
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS so_checked_by text;
