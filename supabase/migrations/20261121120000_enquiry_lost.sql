-- Order lost (owner, 21 Nov 2026: "whatever costing decisions have been already taken should be highlighted in green
-- or red. If we get the order, then it turns green. If we don't get the order, then it turns red").
--
-- A quoted enquiry the customer did not order is marked 'lost', with the reason in dropped_reason; the desk's Bring back
-- returns it to where it was. Additive: one more allowed status. Replayed by init(); idempotent.
do $$
declare c record;
begin
  for c in select conname, pg_get_constraintdef(oid) AS def from pg_constraint
            where conrelid = 'enquiries'::regclass and contype = 'c' loop
    if c.def like '%price_pending%' and c.def not like '%lost%' then
      execute format('ALTER TABLE enquiries DROP CONSTRAINT %I', c.conname);
    end if;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'enquiries'::regclass and conname = 'enquiries_status_ck5') then
    ALTER TABLE enquiries ADD CONSTRAINT enquiries_status_ck5
      CHECK (status IN ('new', 'ready', 'costing', 'price_pending', 'quote_ready', 'sent', 'dropped', 'countered', 'ordered', 'deleted', 'lost'));
  end if;
end $$;
