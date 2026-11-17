-- No artwork work done twice, and the "already done" notice (owner, 17 Nov 2026: "If my designer has done something,
-- then it should not be repeated by the system. If the system has already done it, my designer should get an
-- intimation … sent by the mppchd email to both [the owner's mailbox] and mppchd"). Design: plans/2026-11-17-artwork-dedup-notice-design.md.
--
--   artwork_files.saved_by          'designer' = the office AVS found the designer's own copy of this file on Drive and
--                                   did not save another; drive_url is the designer's copy. Else 'system'.
--   artwork_versions.designer_reply_at  mppchd had already replied in the customer's thread (e.g. the proof) when AVS read it
--   artwork_notices                 one "done by the system" mail per filing batch, from the company mailbox to the two
--                                   company mailboxes only (server/src/artwork-notice.js); waits, retries, gives up after 5
--   artwork_mails.notice_id         the notice a mail was told in — each mail in one notice only
--
-- Idempotent: init() replays it on every start.

alter table artwork_files add column if not exists saved_by text not null default 'system';
do $$ begin
  alter table artwork_files add constraint artwork_files_saved_by_check check (saved_by in ('system', 'designer'));
exception when duplicate_object then null; end $$;

alter table artwork_versions add column if not exists designer_reply_at timestamptz;

create table if not exists artwork_notices (
  id          serial primary key,
  status      text not null default 'waiting'
              check (status in ('waiting', 'sending', 'sent', 'failed', 'gave_up', 'skipped')),
  mail_ids    integer[] not null default '{}',
  subject     text,
  text_body   text,
  html_body   text,
  to_text     text,                 -- who it went to, as sent
  tries       integer not null default 0,
  error       text,                 -- why it is waiting / failed
  message_id  text,                 -- Gmail's id of the sent mail
  claimed_at  timestamptz,          -- when a sender took it ('sending')
  next_try_at timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists artwork_notices_open_idx on artwork_notices (id) where status in ('waiting', 'sending', 'failed');

-- The first time only: mails filed before notices existed are pointed at one 'skipped' notice, so the first notice
-- after this change does not announce weeks of old mail.
do $$
declare
  old_id integer;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artwork_mails' and column_name = 'notice_id') then
    return;
  end if;
  begin
    alter table artwork_mails add column notice_id integer references artwork_notices (id);
  exception when duplicate_column then
    return;   -- another server starting at the same moment added it first, and backfills it
  end;
  if exists (select 1 from artwork_mails) then
    insert into artwork_notices (status, mail_ids, subject, error)
    select 'skipped', coalesce(array_agg(id order by id), '{}'), 'Filed before notices existed', 'not announced'
      from artwork_mails
    returning id into old_id;
    update artwork_mails set notice_id = old_id;
  end if;
end
$$;
create index if not exists artwork_mails_unnoticed_idx on artwork_mails (id) where notice_id is null;

-- The realtime feed (as 20261115100000_artwork_register.sql).
do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.artwork_notices
    for each row execute function public.ci_erp_realtime_ping();
  create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.artwork_notices
    for each statement execute function public.ci_erp_realtime_ping();
end
$$;
