-- HR & PAYROLL: A SUB-ACCOUNT (owner's request, 2026-11-15: "consolidate the account of Jiut Paswan and Gangadhari
-- Paswan — Gangadhari is the sub account of Jiut").
--
--   hr.people.parent_id   NULL: an account of its own, as every row so far.
--                         A person id: this person is a sub-account of that one. The sub-account keeps its own payroll
--                         line (its own bill and pay); whatever its pay cannot cover (advance, loan instalments) is taken
--                         from the main account's pay the same month, and posted back to the sub-account's ledgers at
--                         finalise. People, payroll and reports show the two together. One level only: a main account
--                         is never itself a sub-account (the route refuses it).
-- Replayed by db.js init(): idempotent.
set local lock_timeout = '1s';

alter table hr.people add column if not exists parent_id integer references hr.people (id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'people_parent_not_self') then
    alter table hr.people add constraint people_parent_not_self check (parent_id is null or parent_id <> id);
  end if;
end $$;
create index if not exists people_parent_idx on hr.people (parent_id) where parent_id is not null;
