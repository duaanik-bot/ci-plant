-- The artwork workflow: buttons in sequence, the proof from the designer's CorelDRAW export, Send email from CI Plant
-- (owner, 17 Nov 2026; design plans/2026-11-17-artwork-workflow-design.md).
--
--   artwork_versions.stage   new → designer_file → proof_ready → approval_sent → approved | changes | to_confirm → released
--   artwork_export_keys      one upload key per designer's PC (only its hash is kept)
--   artwork_uploads/_chunks  a designer's PDF arriving in pieces (a request is limited to ~4.5 MB); chunks are deleted
--                            once the file is on Drive
--   artwork_exports          the designer's export of a version: on Drive, with its size and colour list
--   artwork_proof_mails      one approval mail per client thread: the Gmail draft, then the sent mail
--   artwork_proofs           one proof per version in that mail (PRF-…), or a proof the designer sent by hand
--   order_lines trigger      a new line for a product whose latest artwork is approved starts approved by the customer
--
-- Idempotent: init() replays it on every start.

alter table artwork_versions add column if not exists stage text not null default 'new';
do $$ begin
  alter table artwork_versions add constraint artwork_versions_stage_check check (stage in
    ('new', 'designer_file', 'proof_ready', 'approval_sent', 'approved', 'changes', 'to_confirm', 'released'));
exception when duplicate_object then null; end $$;
alter table artwork_versions add column if not exists stage_at timestamptz;
alter table artwork_versions add column if not exists decided_note text;
alter table artwork_versions add column if not exists deleted_at timestamptz;
alter table artwork_versions add column if not exists deleted_reason text;
alter table artwork_versions add column if not exists deleted_by text;
alter table artwork_versions add column if not exists building_at timestamptz;   -- Send for approval is building it (one press at a time)

create table if not exists artwork_export_keys (
  id           serial primary key,
  name         text not null,                  -- the designer / PC it was given to
  key_hash     text not null unique,           -- sha256 of the key; the key itself is shown once
  active       boolean not null default true,
  created_by   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists artwork_uploads (
  id          serial primary key,
  token       text not null unique,            -- the upload's own handle, random
  key_id      integer references artwork_export_keys (id),
  by_name     text,                            -- the key's name, or the logged-in person
  version_id  integer references artwork_versions (id),   -- chosen by a person (fallback upload); else matched
  file_name   text not null,                   -- the .cdr (or .pdf) name the designer exported
  size_bytes  bigint not null,
  sha256      text not null,
  chunks      integer not null,
  page_w_mm   numeric,
  page_h_mm   numeric,
  colours     jsonb not null default '[]'::jsonb,
  status      text not null default 'open' check (status in ('open', 'done', 'failed')),
  error       text,
  created_at  timestamptz not null default now()
);
create table if not exists artwork_upload_chunks (
  upload_id integer not null references artwork_uploads (id) on delete cascade,
  n         integer not null,
  bytes     bytea not null,
  primary key (upload_id, n)
);

create table if not exists artwork_exports (
  id            serial primary key,
  version_id    integer references artwork_versions (id),   -- null = could not be matched: a person picks the job
  upload_id     integer references artwork_uploads (id),
  by_name       text,
  file_name     text not null,
  sha256        text not null,
  size_bytes    bigint,
  page_w_mm     numeric,
  page_h_mm     numeric,
  colours       jsonb not null default '[]'::jsonb,
  drive_file_id text,
  drive_url     text,
  match_note    text,
  dismissed_at  timestamptz,                   -- an unmatched export a person set aside
  created_at    timestamptz not null default now()
);
create index if not exists artwork_exports_version_idx on artwork_exports (version_id, id);
-- the order_lines trigger looks a product's artwork up on every new line
create index if not exists artwork_jobs_product_idx on artwork_jobs (product_id) where product_id is not null;

create table if not exists artwork_proof_mails (
  id               serial primary key,
  gmail_thread_id  text,
  reply_to_mail_id integer references artwork_mails (id),
  version_ids      integer[] not null,
  to_text          text,
  cc_text          text,
  subject          text,
  body_text        text,
  gmail_draft_id   text,
  gmail_message_id text,
  draft_url        text,
  status           text not null default 'draft' check (status in ('draft', 'sending', 'sent', 'cancelled', 'failed')),
  error            text,
  claimed_at       timestamptz,                -- Send email took it ('sending'); a stale claim is settled from Gmail
  checked_at       timestamptz,                -- last look in Gmail for a draft sent from Gmail itself
  draft_deleted_at timestamptz,                -- a cancelled draft taken out of Gmail's Drafts
  mail_token       text,                       -- CI Plant's mark in the mail (header X-CIPlant-Approval): finds it in Gmail as sent
  created_by       text,
  created_at       timestamptz not null default now(),
  sent_by          text,
  sent_at          timestamptz
);
create index if not exists artwork_proof_mails_thread_idx on artwork_proof_mails (gmail_thread_id);

create table if not exists artwork_proofs (
  id            serial primary key,
  proof_no      text unique,                   -- PRF-CI-AW-0012-R0.1-1; null for a proof sent by hand
  version_id    integer not null references artwork_versions (id),
  export_id     integer references artwork_exports (id),
  proof_mail_id integer references artwork_proof_mails (id),
  sha256        text,
  file_name     text,
  drive_file_id text,
  drive_url     text,
  by_hand       boolean not null default false,
  gmail_thread_id text,                        -- the client thread it went out in
  sent_at       timestamptz,                   -- when it reached the client (null = not sent yet); a reply counts only after it
  created_at    timestamptz not null default now()
);
create index if not exists artwork_proofs_version_idx on artwork_proofs (version_id, id);
create index if not exists artwork_proofs_thread_idx on artwork_proofs (gmail_thread_id) where sent_at is not null;

-- A new order line for a product whose NEWEST live artwork — across every artwork job of that product — is approved
-- (or released) starts with the customer's approval ticked. An older approved version behind a newer one that is not
-- approved ticks nothing.
create or replace function artwork_line_customer_ok() returns trigger language plpgsql as $$
begin
  if new.artwork_customer_ok = 0 and (
    select v.stage from artwork_versions v join artwork_jobs j on j.id = v.job_id
     where j.product_id = new.product_id and v.deleted_at is null and v.status <> 'not_artwork'
     order by v.id desc limit 1) in ('approved', 'released') then
    new.artwork_customer_ok := 1;
  end if;
  return new;
end $$;
drop trigger if exists artwork_line_customer_ok on order_lines;
create trigger artwork_line_customer_ok before insert on order_lines
  for each row execute function artwork_line_customer_ok();

do $$
declare
  t text;
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  foreach t in array array['artwork_export_keys', 'artwork_exports', 'artwork_proof_mails', 'artwork_proofs'] loop
    execute pg_catalog.format('create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.%I for each row execute function public.ci_erp_realtime_ping()', t);
    execute pg_catalog.format('create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.%I for each statement execute function public.ci_erp_realtime_ping()', t);
  end loop;
end
$$;
