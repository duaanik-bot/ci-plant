-- The artwork register (Artwork Manager P1; owner's brief of 14 Nov 2026: "a register of new artwork and revisions,
-- show their status and history, connect each job to its Drive files and email thread").
--
-- The office AVS reads the company mailbox four times a day and files every artwork mail into avs.artwork_intake
-- (20261115100100_avs_artwork_intake.sql, skills/avs-artwork/SKILL.md). CI Plant copies each one here
-- (server/src/artwork-intake.js) and the Artwork page's Register tab reads these tables.
--
--   artwork_mails     one row per mail read, whichever job(s) it carried
--   artwork_jobs      one per customer and item code (or product name, for a customer who uses no codes): CI-AW-0001…
--   artwork_versions  what the customer sent: their revision + a receipt number (R0.1, R0.2). The same bytes sent
--                     again are the same version; new bytes under one revision are the next receipt. Never overwritten.
--   artwork_files     a version's files (Drive id + sha256) and links (a SharePoint link is kept, not fetched)
--   artwork_events    the history: received, received again, mapped to a product, marked not artwork…
--
-- P1 only registers and files. Checks, proofs and approvals come later and add their own statuses.
-- Idempotent: init() replays it on every start.

create table if not exists artwork_mails (
  id               serial primary key,
  mailbox_email    text not null,
  gmail_message_id text not null,
  gmail_thread_id  text,
  subject          text,
  from_name        text,
  from_email       text,
  to_text          text,
  received_at      timestamptz,
  body_text        text,
  attachments      jsonb not null default '[]'::jsonb,
  view_url         text,
  summary          text,
  alerted_at       timestamptz,            -- the "announced once" mark, as on enquiry_mails
  created_at       timestamptz not null default now(),
  unique (mailbox_email, gmail_message_id)
);
create index if not exists artwork_mails_unalerted_idx on artwork_mails (id) where alerted_at is null;

create table if not exists artwork_jobs (
  id               serial primary key,
  job_no           text not null unique,   -- CI-AW-0001
  job_key          text not null unique,   -- artwork-register.js jobKey(): customer|code, or customer|name:product
  customer_id      integer,
  customer_name    text,
  client_item_code text,
  product_id       integer,                -- our product, once known (avs.artwork_codes, or mapped by a person)
  product_name     text,
  pack_type        text,
  to_sort          boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists artwork_jobs_to_sort_idx on artwork_jobs (id) where to_sort;

create table if not exists artwork_versions (
  id            serial primary key,
  job_id        integer not null references artwork_jobs (id),
  client_rev    text not null default '',  -- 'R0'; '' when the customer gives none
  receipt_no    integer not null,
  label         text not null,             -- 'R0.2', or 'v2' with no revision
  variant       text,                      -- 'batch' = batch / mfg / exp overprint artwork
  source_print  text not null default '',  -- artwork-register.js sourcePrint(): the files' sha256, sorted
  status        text not null default 'received' check (status in ('received', 'file_to_fetch', 'not_artwork')),
  first_mail_id integer references artwork_mails (id),
  received_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (job_id, client_rev, receipt_no)
);
create index if not exists artwork_versions_job_idx on artwork_versions (job_id, id);

create table if not exists artwork_files (
  id            serial primary key,
  version_id    integer not null references artwork_versions (id),
  role          text not null default 'client_source',
  file_name     text,
  ext           text,
  size_bytes    bigint,
  sha256        text,
  drive_file_id text,
  drive_url     text,
  link_url      text,                      -- artwork sent as a link (SharePoint): kept here, the file fetched by a person
  created_at    timestamptz not null default now()
);
create index if not exists artwork_files_version_idx on artwork_files (version_id, id);

create table if not exists artwork_events (
  id         serial primary key,
  job_id     integer references artwork_jobs (id),
  version_id integer references artwork_versions (id),
  mail_id    integer references artwork_mails (id),
  action     text not null,
  detail     jsonb,
  by_name    text,
  at         timestamptz not null default now()
);
create index if not exists artwork_events_job_idx on artwork_events (job_id, id);
create index if not exists artwork_events_version_idx on artwork_events (version_id, id);

-- The realtime feed, like every table a screen reads (20260918120000_fluence_realtime_ping.sql).
-- Guarded: a database without the realtime function (every local one) skips it.
do $$
declare
  target_table text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach target_table in array array[
    'artwork_mails', 'artwork_jobs', 'artwork_versions', 'artwork_files', 'artwork_events'
  ] loop
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()',
      target_table);
    execute pg_catalog.format(
      'create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()',
      target_table);
  end loop;
end
$$;
