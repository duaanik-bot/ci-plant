-- Delete an enquiry (owner, 14 Nov 2026: "also give option to delete the enquiry").
--
-- A deleted row leaves every list and count on the desk but stays in the database with its reason (dropped_reason),
-- and the desk's Undo brings it back (server/src/routes/enquiries.js POST /costing/enquiries/delete). Only a row not on
-- a live quotation or an order can be deleted. Replayed by init(); idempotent.
do $$
declare c record;
begin
  -- enquiries.status: + 'deleted' (replace whichever check names the old list)
  for c in select conname, pg_get_constraintdef(oid) AS def from pg_constraint
            where conrelid = 'enquiries'::regclass and contype = 'c' loop
    if c.def like '%price_pending%' and c.def not like '%deleted%' then
      execute format('ALTER TABLE enquiries DROP CONSTRAINT %I', c.conname);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'enquiries'::regclass and conname = 'enquiries_status_ck4') then
    ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_ck4
      CHECK (status IN ('new', 'ready', 'costing', 'price_pending', 'quote_ready', 'sent', 'dropped', 'countered', 'ordered', 'deleted'));
  end if;
end $$;
