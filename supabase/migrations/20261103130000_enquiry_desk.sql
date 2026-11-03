-- ENQUIRY DESK — customer enquiries from the mailbox, pushed into Costing, priced by a person, quoted and
-- answered in the customer's own e-mail thread (docs/superpowers/specs/2026-11-03-enquiry-desk-design.md).
-- Written 2026-11-03.
--
-- APPLIED to colour-impressions-prod 2026-11-03 as the named migration `enquiry_desk` (owner's go-ahead to ship the
-- enquiry desk), after a BEGIN/ROLLBACK dry run on production.
--
-- Built on AVS (owner's call): Claude reads the mailbox and saves replies as drafts through its own Gmail
-- connector, claiming jobs from CI Plant with the AVS robot key. No mail credential is kept here.
--
--   enquiry_mailboxes  the two mailboxes, trial and business; one is in use
--   enquiry_settings   one row: the quotation's terms and the reply's opening and closing words
--   enquiry_jobs       the robot's work list: fetch, or save a reply as a Gmail draft (with the exact text and PDF).
--                      There is no send job: CI Plant never sends a mail; a person sends the draft from Gmail
--   enquiry_mails      each mail filed, by its Gmail message id (once per mailbox)
--   enquiries          one row per item asked about (an e-mail can hold several)
--   enquiry_contacts   a sender's address remembered against a customer master
--   quotations         a customer's quotation: a snapshot of customer-facing lines only
--   enquiry_events     what happened to an enquiry or a quotation, prices included (Costing tick only;
--                      the plant-wide audit log gets numbers and actions, never a price)
--
-- No foreign key leaves these tables (as Costing): customer, product and costing are kept as an id plus
-- the name as it stood, so the dev seed's TRUNCATE … CASCADE cannot wipe them.
set local lock_timeout = '1s';

CREATE TABLE IF NOT EXISTS enquiry_mailboxes (
  key             text PRIMARY KEY CHECK (key IN ('trial', 'business')),
  email           text NOT NULL,
  label           text NOT NULL,
  -- 'own': a reply goes only to the mailbox itself (the trial); 'customers': to the customer
  send_to         text NOT NULL DEFAULT 'own' CHECK (send_to IN ('own', 'customers')),
  in_use          boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_name text
);
CREATE UNIQUE INDEX IF NOT EXISTS enquiry_mailboxes_one_in_use ON enquiry_mailboxes (in_use) WHERE in_use;
INSERT INTO enquiry_mailboxes (key, email, label, send_to, in_use) VALUES
  ('trial', 'dua.anik@gmail.com', 'Trial', 'own', true),
  ('business', 'mppchd@gmail.com', 'Business', 'customers', false)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS enquiry_settings (
  id              integer PRIMARY KEY CHECK (id = 1),
  terms           text NOT NULL,
  opening         text NOT NULL,
  closing         text NOT NULL,
  fetch_days      integer NOT NULL DEFAULT 7 CHECK (fetch_days BETWEEN 1 AND 60),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_name text
);
INSERT INTO enquiry_settings (id, terms, opening, closing) VALUES (1,
  E'Prices are per carton, ex-works.\nGST extra as applicable.\nDelivery as agreed on order.',
  E'Thank you for your enquiry. Please find our rates below; the quotation is attached.',
  E'We look forward to your order.')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS enquiry_jobs (
  id                serial PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('fetch', 'draft')),
  mailbox           text NOT NULL,
  mailbox_email     text NOT NULL,
  quotation_id      integer,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'working', 'done', 'failed', 'cancelled')),
  -- what the robot is to do: for a fetch, since when; for a draft, the exact reply
  brief             jsonb NOT NULL DEFAULT '{}',
  attachment        bytea,
  attachment_name   text,
  attachment_sha256 text,
  result            jsonb,
  error             text,
  fire_status       text,
  queued_by         integer,
  queued_by_name    text,
  queued_at         timestamptz NOT NULL DEFAULT now(),
  claimed_by        text,
  claimed_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX IF NOT EXISTS enquiry_jobs_open ON enquiry_jobs (status, id) WHERE status IN ('queued', 'working');

CREATE TABLE IF NOT EXISTS enquiry_mails (
  id               serial PRIMARY KEY,
  mailbox          text NOT NULL,
  mailbox_email    text NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id  text,
  subject          text,
  from_name        text,
  from_email       text,
  to_text          text,
  received_at      timestamptz,
  body_text        text,
  attachments      jsonb NOT NULL DEFAULT '[]',
  view_url         text,
  summary          text,
  job_id           integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_email, gmail_message_id)
);

CREATE TABLE IF NOT EXISTS enquiries (
  id                serial PRIMARY KEY,
  enquiry_no        text NOT NULL UNIQUE,
  mail_id           integer REFERENCES enquiry_mails (id),
  mailbox           text,
  customer_id       integer,
  customer_name     text,
  contact_name      text,
  contact_email     text,
  product_id        integer,
  product_name      text,
  size_text         text,
  size_key          text,
  style             text,
  board             text,
  gsm               numeric,
  colours           numeric,
  coating           text,
  specs             text,
  quantities        numeric[] NOT NULL DEFAULT '{}',
  target_price      numeric,
  notes             text,
  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'ready', 'costing', 'price_pending', 'quote_ready', 'sent', 'dropped')),
  dropped_reason    text,
  costing_id        integer,
  batch_id          integer,
  -- [{ qty, final, proposed }]: the person's price per carton for each quantity, and the proposal it was set against
  final_prices      jsonb NOT NULL DEFAULT '[]',
  finalised_by      integer,
  finalised_by_name text,
  finalised_at      timestamptz,
  quotation_id      integer,
  source            text NOT NULL DEFAULT 'robot' CHECK (source IN ('robot', 'person')),
  created_by        integer,
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by_name   text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiries_status ON enquiries (status);
CREATE INDEX IF NOT EXISTS enquiries_mail ON enquiries (mail_id);
CREATE INDEX IF NOT EXISTS enquiries_costing ON enquiries (costing_id) WHERE costing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enquiries_quotation ON enquiries (quotation_id) WHERE quotation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS enquiry_contacts (
  email         text PRIMARY KEY,
  customer_id   integer,
  customer_name text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotations (
  id               serial PRIMARY KEY,
  quotation_no     text NOT NULL UNIQUE,
  mailbox          text,
  customer_id      integer,
  customer_name    text,
  contact_name     text,
  contact_email    text,
  -- the enquiry mail answered: the reply goes into its thread
  reply_mail_id    integer,
  -- customer-facing only (enquiry-desk.js customerLine): product, size, specs, quantity, rate, amount
  lines            jsonb NOT NULL DEFAULT '[]',
  total            numeric,
  terms            text,
  email_subject    text,
  email_opening    text,
  email_closing    text,
  status           text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'queued', 'drafted', 'sent', 'cancelled')),
  job_id           integer,
  gmail_draft_id   text,
  gmail_draft_url  text,
  gmail_message_id text,
  sent_to          text,
  sent_at          timestamptz,
  sent_by_name     text,
  created_by       integer,
  created_by_name  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_name  text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotations_status ON quotations (status);

CREATE TABLE IF NOT EXISTS enquiry_events (
  id           serial PRIMARY KEY,
  enquiry_id   integer,
  quotation_id integer,
  action       text NOT NULL,
  detail       jsonb,
  by_name      text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_events_enquiry ON enquiry_events (enquiry_id) WHERE enquiry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enquiry_events_quotation ON enquiry_events (quotation_id) WHERE quotation_id IS NOT NULL;

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
    'enquiry_mailboxes', 'enquiry_settings', 'enquiry_jobs', 'enquiry_mails', 'enquiries',
    'enquiry_contacts', 'quotations', 'enquiry_events'
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
