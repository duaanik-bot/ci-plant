-- Fluence's prescriptions, MRPs and new kits, read from Fluence's own mails (owner, 18 Nov 2026; design
-- plans/2026-11-18-fluence-mail-masters-design.md). The office AVS reads Fluence's artwork (the prescription and MRPs
-- printed on the kit carton), Fluence's MRP sheets and their POs; CI Plant keeps each reading here and saves it to the
-- Fluence master through the module's own save (revision, history, MRP trail) — an artwork's reading when the client
-- approves that version, a sheet's when it arrives, a PO's never (compared only). Idempotent: init() replays it.
--
--   status  waiting_approval  read from an artwork version not yet approved
--           queued            to be saved: filing a mail only records it; it is saved right after, in small steps
--           saved             written to the master (the changes it made are in `changes`, before and after)
--           same              the master already said this
--           held              not written: an MRP more than 25 % lower or more than double, a field the robot was not
--                             sure of, a person (or a newer mail) changed the kit since, an artwork whose items are not
--                             the kit's — a person decides (Apply, or Keep the master)
--           not_matched       a sheet line naming no kit we have
--           compared          a PO's MRPs, compared with the master and flagged, never written
--           undone            written, then put back by a person
--           dismissed         held or not matched, and a person kept the master as it was

create table if not exists fluence_mail_readings (
  id                 serial primary key,
  source             text not null check (source in ('artwork', 'mrp_sheet', 'po')),
  intake_id          bigint,
  mail_id            integer references artwork_mails (id),
  gmail_message_id   text,
  gmail_thread_id    text,
  subject            text,
  from_email         text,
  received_at        timestamptz,
  artwork_version_id integer references artwork_versions (id),
  read_from          text,                         -- the file the robot read (e.g. the proof PDF)
  kit_name           text,
  kit_code           text,                         -- an FP- code when the mail names one
  reading            jsonb not null default '{}'::jsonb,
  sure               boolean not null default true,
  unsure             jsonb not null default '[]'::jsonb,   -- the fields the robot was not sure of
  status             text not null default 'waiting_approval',
  hold_reason        text,
  attempts           integer not null default 0,   -- tries to save it; a reading that keeps failing is held, not retried for ever
  notified_at        timestamptz,                  -- when the one notice for its mail went out
  dismissed_at       timestamptz,
  dismissed_by       text,
  kit_id             integer references fluence_kits (id) on delete set null,
  product_id         integer references products (id) on delete set null,
  created_kit_id     integer,                      -- a new development: the kit and draft carton this reading made
  created_product_id integer,
  changes            jsonb,                        -- what it changed: before → after, and the revision / MRP-change ids
  saved_at           timestamptz,
  saved_by           text,
  ack_at             timestamptz,
  ack_by             text,
  undone_at          timestamptz,
  undone_by          text,
  created_at         timestamptz not null default now()
);
alter table fluence_mail_readings add column if not exists attempts integer not null default 0;
alter table fluence_mail_readings add column if not exists notified_at timestamptz;
alter table fluence_mail_readings add column if not exists dismissed_at timestamptz;
alter table fluence_mail_readings add column if not exists dismissed_by text;
do $$ begin
  alter table fluence_mail_readings drop constraint if exists fluence_mail_readings_status_check;
  alter table fluence_mail_readings add constraint fluence_mail_readings_status_check
    check (status in ('waiting_approval', 'queued', 'saved', 'same', 'held', 'not_matched', 'compared', 'undone', 'dismissed'));
end $$;
create index if not exists fluence_mail_readings_version_idx on fluence_mail_readings (artwork_version_id) where status = 'waiting_approval';
create index if not exists fluence_mail_readings_open_idx on fluence_mail_readings (id) where ack_at is null;
create index if not exists fluence_mail_readings_queued_idx on fluence_mail_readings (received_at, id) where status = 'queued';
create index if not exists fluence_mail_readings_untold_idx on fluence_mail_readings (intake_id) where notified_at is null;
create index if not exists fluence_mail_readings_kit_idx on fluence_mail_readings (kit_id, received_at) where status = 'saved';

-- A kit's total MRP (and the carton's) gets the same trail as an item's.
do $$ begin
  alter table fluence_mrp_changes drop constraint if exists fluence_mrp_changes_subject_check;
  alter table fluence_mrp_changes add constraint fluence_mrp_changes_subject_check check (subject in ('inner_product', 'kit_item', 'kit_total'));
end $$;

do $$
begin
  if pg_catalog.to_regprocedure('public.ci_erp_realtime_ping()') is null then
    return;
  end if;
  create or replace trigger ci_erp_realtime_ping after insert or update or delete on public.fluence_mail_readings
    for each row execute function public.ci_erp_realtime_ping();
  create or replace trigger ci_erp_realtime_ping_truncate after truncate on public.fluence_mail_readings
    for each statement execute function public.ci_erp_realtime_ping();
end
$$;
