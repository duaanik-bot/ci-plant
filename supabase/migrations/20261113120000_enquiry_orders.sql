-- ENQUIRY DESK: ORDER FINALISED (owner, 12 Nov 2026: "Once the order is finalised with the customer, we need a button to
-- finalise the order … data also needs to be added into that particular order, and it needs to be mentioned what the
-- loss is where we have booked this order"). Spec: docs/superpowers/specs/2026-11-13-order-finalised-design.md
--
--   enquiry_orders              one finalised order (CI-OF-0001 …): its lines as finalised — quantity, rate, our cost,
--                               margin or loss, output sheet, ups, board, die, KLD — the totals, and the order sheet
--                               mailed to the company mailbox (mail_status none | sent | failed, with the reason)
--   enquiries.order_id          the order an enquiry was finalised on
--   enquiries.status 'ordered'  the desk's Orders tab
-- No foreign key (as the rest of the enquiry desk). Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS enquiry_orders (
  id               serial PRIMARY KEY,
  order_no         text NOT NULL UNIQUE,
  mailbox          text,
  customer_id      integer,
  customer_name    text,
  quotation_id     integer,
  lines            jsonb NOT NULL DEFAULT '[]',
  total            numeric(16,2),
  loss             numeric(16,2),
  items_at_loss    integer NOT NULL DEFAULT 0,
  new_dies         integer NOT NULL DEFAULT 0,
  mail_wanted      boolean NOT NULL DEFAULT false,
  mail_status      text NOT NULL DEFAULT 'none' CHECK (mail_status IN ('none', 'sent', 'failed')),
  mail_to          text,
  mail_subject     text,
  mail_message_id  text,
  mail_error       text,
  mail_sent_at     timestamptz,
  created_by       integer,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_orders_created ON enquiry_orders (created_at DESC);

ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS order_id integer;
CREATE INDEX IF NOT EXISTS enquiries_order ON enquiries (order_id) WHERE order_id IS NOT NULL;

do $$
declare c record;
begin
  -- enquiries.status: + 'ordered' (replace whichever check names the old list)
  for c in select conname, pg_get_constraintdef(oid) AS def from pg_constraint
            where conrelid = 'enquiries'::regclass and contype = 'c' loop
    if c.def like '%price_pending%' and c.def not like '%ordered%' then
      execute format('ALTER TABLE enquiries DROP CONSTRAINT %I', c.conname);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'enquiries'::regclass and conname = 'enquiries_status_ck3') then
    ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_ck3
      CHECK (status IN ('new', 'ready', 'costing', 'price_pending', 'quote_ready', 'sent', 'dropped', 'countered', 'ordered'));
  end if;
end $$;

-- The realtime feed, like the desk's other tables (20261103130000_enquiry_desk.sql). Guarded: a database without the
-- realtime function (every local one) skips it.
do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  execute 'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.enquiry_orders for each row execute function public.ci_erp_realtime_ping()';
  execute 'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.enquiry_orders for each statement execute function public.ci_erp_realtime_ping()';
end
$$;
