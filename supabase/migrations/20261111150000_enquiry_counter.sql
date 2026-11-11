-- ENQUIRY DESK: THE CUSTOMER'S COUNTER-OFFER AND THE REVISED QUOTATION (owner, 11 Nov 2026: "once we get the customer
-- quotation counter, we should have one control … the customer target price and his quotation counter … one field in
-- which we will be setting our final price. That will be the revised quotation for that particular party, for that
-- particular mail thread … the amount of loss in the whole batch, the total percentage of the discount asked").
--
--   enquiries.counter          [{ qty, theirs, ours }] — the customer's price per quantity, and our price it answered
--   enquiries.counter_mail_id  the mail the counter came in (the revised quotation replies in its thread)
--   enquiries.counter_at / counter_by_name / counter_round   when, who filed it, which round (1, 2 …)
--   enquiries.status 'countered'  — the desk's Counter tab
--   quotations.revision        0 = first quotation; 1, 2 … = revised after a counter
--   quotations.supersedes_id   the quotation a revision replaces; that one becomes 'superseded'
-- No foreign key (as the rest of the enquiry desk). Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS counter jsonb;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS counter_mail_id integer;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS counter_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS counter_by_name text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS counter_round integer NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS supersedes_id integer;

do $$
declare c record;
begin
  -- enquiries.status: + 'countered' (replace whichever check names the old list)
  for c in select conname, pg_get_constraintdef(oid) AS def from pg_constraint
            where conrelid = 'enquiries'::regclass and contype = 'c' loop
    if c.def like '%price_pending%' and c.def not like '%countered%' then
      execute format('ALTER TABLE enquiries DROP CONSTRAINT %I', c.conname);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'enquiries'::regclass and conname = 'enquiries_status_ck2') then
    ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_ck2
      CHECK (status IN ('new', 'ready', 'costing', 'price_pending', 'quote_ready', 'sent', 'dropped', 'countered'));
  end if;
  -- quotations.status: + 'superseded'
  for c in select conname, pg_get_constraintdef(oid) AS def from pg_constraint
            where conrelid = 'quotations'::regclass and contype = 'c' loop
    if c.def like '%drafted%' and c.def not like '%superseded%' then
      execute format('ALTER TABLE quotations DROP CONSTRAINT %I', c.conname);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'quotations'::regclass and conname = 'quotations_status_ck2') then
    ALTER TABLE quotations ADD CONSTRAINT quotations_status_ck2
      CHECK (status IN ('ready', 'queued', 'drafted', 'sent', 'cancelled', 'superseded'));
  end if;
end $$;
