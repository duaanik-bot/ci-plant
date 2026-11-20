-- ENQUIRY DESK: THE DESK COSTS AN ENQUIRY BY ITSELF (owner, 20 Nov 2026). New columns only, no data.
--
--   costings.auto_costed             true on a costing the desk worked out itself (it waits for a person to approve)
--   costing_settings.customer_rates  [{ word, board_rate }] — a customer's own board rate, matched on a word of the name
--   enquiry_settings.auto_cost       the switch: the desk costs a new enquiry by itself (on by default)
--   enquiries.opening                'side' | 'top' — how a side-pasted carton opens, as the mail says
--   enquiries.auto_cost_at / auto_cost_why   when the desk last tried, and why it could not cost it by itself
--   enquiries.reply_claim_at         when a mail's reply claim (Approve, or a Management drop or delete) finalised the row;
--                                    cleared once the row is on its quotation. Only such a row, still on no quotation,
--                                    is a reply cut off part-way — a row finalised any other way is never sent again.
-- No foreign key (as the rest of the enquiry desk). Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

ALTER TABLE costings ADD COLUMN IF NOT EXISTS auto_costed boolean NOT NULL DEFAULT false;
ALTER TABLE costing_settings ADD COLUMN IF NOT EXISTS customer_rates jsonb NOT NULL DEFAULT '[]';
ALTER TABLE enquiry_settings ADD COLUMN IF NOT EXISTS auto_cost boolean NOT NULL DEFAULT true;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS opening text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS auto_cost_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS auto_cost_why text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS reply_claim_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'enquiries'::regclass and conname = 'enquiries_opening_ck') then
    ALTER TABLE enquiries ADD CONSTRAINT enquiries_opening_ck CHECK (opening IS NULL OR opening IN ('side', 'top'));
  end if;
end $$;
