-- Fluence readings in the "done by the system" notice mail (owner, 20 Nov 2026: "Yes, add it"; design
-- plans/2026-11-18-fluence-mail-masters-design.md §4.3). The notice that goes from the business mailbox to the two
-- company mailboxes after each robot run (artwork-notice.js) now also says what the system did with Fluence's mails:
-- saved to the Fluence master, held for a person, not matched, a PO that differs, already the same. Each reading is told
-- once, when its whole mail is settled: fluence_mail_readings.notice_id, as artwork_mails.notice_id. Idempotent: init()
-- replays it.
--
-- The first time only: readings already settled before the notice told Fluence are pointed at one 'skipped' notice, so
-- the first notice after this change does not announce them (management had the bell for each). A reading still waiting
-- for its artwork's approval, or still being saved, is told when it settles.
do $$
declare
  old_id integer;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'fluence_mail_readings' and column_name = 'notice_id') then
    return;
  end if;
  begin
    alter table fluence_mail_readings add column notice_id integer references artwork_notices (id);
  exception when duplicate_column then
    return;   -- another server starting at the same moment added it first, and backfills it
  end;
  if exists (select 1 from fluence_mail_readings where status not in ('waiting_approval', 'queued')) then
    insert into artwork_notices (status, subject, error)
    values ('skipped', 'Fluence readings settled before the notice told them', 'not announced')
    returning id into old_id;
    update fluence_mail_readings set notice_id = old_id where status not in ('waiting_approval', 'queued');
  end if;
end
$$;
create index if not exists fluence_mail_readings_unnoticed_idx on fluence_mail_readings (intake_id) where notice_id is null;
