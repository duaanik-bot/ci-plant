-- HR & PAYROLL: an ACCOUNTS level and a per-login HIDE LIST (owner's request, 2026-11-05: "give access to my
-- accounts id, but I don't want to reveal all the employees and their salaries to him — selective, at my
-- discretion, hide anyone's salary and even name").
--
--   hr.access.level gains 'accounts' (between viewer and operator): reads the registers, payslips, reports and
--     ledgers, and pays — marks lines paid / on hold, pays staff advances. Changes no salary, approves nothing.
--   hr.access_hidden (user_id, person_id, mode): for a viewer or accounts login, the people it must not see.
--     mode 'pay' = the name shows, every amount of theirs is withheld; 'all' = the person is not there at all.
--     A person not listed is visible (the owner's choice: new people show up until hidden).
-- The server (hr/privacy.js) enforces it; nothing hidden ever leaves it for that login.
--
-- Replayed by server/src/db.js init() on every boot: idempotent and lock-free on a replay (the catalogue is
-- read first; a database that has it all is never altered again). Nothing is dropped but the old level check,
-- which is replaced by the wider one in the same statement.
set local lock_timeout = '1s';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'hr.access'::regclass and conname = 'access_level_check'
                    and pg_get_constraintdef(oid) like '%accounts%') then
    alter table hr.access drop constraint if exists access_level_check,
      add constraint access_level_check check (level in ('viewer', 'accounts', 'operator', 'approver', 'admin'));
  end if;

  if to_regclass('hr.access_hidden') is null then
    create table hr.access_hidden (
      user_id   integer not null,
      person_id integer not null references hr.people (id) on delete cascade,
      mode      text not null check (mode in ('pay', 'all')),
      set_by    integer,
      set_at    timestamptz not null default now(),
      primary key (user_id, person_id)
    );
    alter table hr.access_hidden enable row level security;
    -- As every hr table: nothing for PUBLIC or Supabase's API roles (done here, once, so a replay changes nothing).
    revoke all on hr.access_hidden from public;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
      revoke all on hr.access_hidden from anon;
    end if;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
      revoke all on hr.access_hidden from authenticated;
    end if;
  end if;
end
$$;
