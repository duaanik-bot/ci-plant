-- The order confirmation to the customer (owner, 21 Nov 2026: "draft the order confirmation reply in the same thread").
-- Once an order is finalised, CI Plant saves a reply in the customer's own Gmail thread as a DRAFT — never sent — and
-- remembers it here so pressing again rewrites that same draft. Additive; replayed by init(); idempotent.
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS customer_draft_id text;
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS customer_draft_url text;
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS customer_draft_mailbox text;
ALTER TABLE enquiry_orders ADD COLUMN IF NOT EXISTS customer_drafted_at timestamptz;
