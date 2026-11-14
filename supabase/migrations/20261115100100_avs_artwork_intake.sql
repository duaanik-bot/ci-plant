-- Artwork mails from the company mailbox, filed by the office AVS (Artwork Manager P1; owner's brief of 14 Nov 2026:
-- "identify new artwork and revisions received by email … an additional process in our AVS routine check; it should
-- not replace or disrupt existing routines").
--
-- PRODUCTION ONLY, like the other avs migrations: the avs schema exists only there, so init() never replays it. A test
-- builds the table by creating the avs schema and running this file; the pg_net part is skipped where pg_net is not
-- available.
--
-- The office AVS writes nothing but avs tables (its own rules). So it files each artwork mail it reads in the business
-- mailbox here, one row per mail, through avs.file_artwork_mails (skills/avs-artwork/SKILL.md). The moment rows land,
-- pg_net posts to POST /api/avs/robot/artwork-notify with the robot key and CI Plant copies them into the artwork
-- register and announces them (server/src/artwork-intake.js). pg_net sends after the inserting transaction commits and
-- never waits for the answer, and every error here is swallowed, so a slow or unreachable CI Plant can never slow or
-- fail AVS's run. A lost call is picked up by any open CI Plant within two minutes (GET /api/drafts/summary). CI Plant
-- writes its answer back on the row: status, handled_at, result.

CREATE TABLE IF NOT EXISTS avs.artwork_intake (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL DEFAULT 'artwork' CHECK (kind IN ('artwork', 'to_sort')),
  mailbox_email    text NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id  text,
  subject          text,
  from_name        text,
  from_email       text,
  to_text          text,
  received_at      timestamptz,
  body_text        text,
  attachments      jsonb DEFAULT '[]'::jsonb,
  view_url         text,
  summary          text,
  customer_name    text,
  -- [{ client_item_code, client_rev, product_name, pack_type, variant,
  --    files: [{ file_name, size_bytes, sha256, drive_file_id, drive_url }], links: [url] }]
  items            jsonb DEFAULT '[]'::jsonb,
  intake_run_id    bigint,                      -- the AVS run (avs.intake_runs.id) that read it
  created_at       timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'filed', 'skipped', 'refused')),
  handled_at       timestamptz,
  result           jsonb,                       -- CI Plant's answer: the CI-AW numbers, or why it was skipped/refused
  UNIQUE (mailbox_email, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS artwork_intake_new_idx ON avs.artwork_intake (id) WHERE status = 'new';

ALTER TABLE avs.artwork_intake ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON avs.artwork_intake FROM PUBLIC;

-- AVS files a run's mails with ONE call: SELECT avs.file_artwork_mails($m$ [ { … }, { … } ] $m$::jsonb) (one object
-- alone is taken as a list of one). A missing list is empty, the kind defaults to artwork, the address is lower-cased,
-- and a mail filed before is left alone. One call is one statement, so the trigger below tells CI Plant once and the
-- register gets one alert for the run. The answer: [{ gmail_message_id, intake_id, filed }] — filed false = it was in
-- the table already.
CREATE OR REPLACE FUNCTION avs.file_artwork_mails(mails jsonb) RETURNS jsonb
LANGUAGE sql AS $$
  WITH src AS (
    SELECT x AS m
      FROM jsonb_array_elements(CASE jsonb_typeof(mails) WHEN 'array' THEN mails ELSE jsonb_build_array(mails) END) x
  ), ins AS (
    INSERT INTO avs.artwork_intake (kind, mailbox_email, gmail_message_id, gmail_thread_id, subject, from_name, from_email,
                                    to_text, received_at, body_text, attachments, view_url, summary, customer_name,
                                    items, intake_run_id)
    SELECT COALESCE(NULLIF(m->>'kind', ''), 'artwork'), lower(trim(m->>'mailbox_email')), m->>'gmail_message_id',
           m->>'gmail_thread_id', m->>'subject', m->>'from_name', m->>'from_email', m->>'to_text',
           NULLIF(m->>'received_at', '')::timestamptz, m->>'body_text', COALESCE(m->'attachments', '[]'::jsonb),
           m->>'view_url', m->>'summary', m->>'customer_name',
           COALESCE(m->'items', '[]'::jsonb), NULLIF(m->>'intake_run_id', '')::bigint
      FROM src
    ON CONFLICT (mailbox_email, gmail_message_id) DO NOTHING
    RETURNING id, gmail_message_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('gmail_message_id', s.m->>'gmail_message_id', 'intake_id', i.id,
                                               'filed', i.id IS NOT NULL)), '[]'::jsonb)
    FROM src s LEFT JOIN ins i ON i.gmail_message_id = s.m->>'gmail_message_id';
$$;
REVOKE ALL ON FUNCTION avs.file_artwork_mails(jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON avs.artwork_intake FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION avs.file_artwork_mails(jsonb) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON avs.artwork_intake FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION avs.file_artwork_mails(jsonb) FROM authenticated';
  END IF;
END $$;

-- The database tells CI Plant (production: pg_net).
DO $outer$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    RAISE NOTICE 'artwork_intake_alert: pg_net is not available here; the trigger is left out';
    RETURN;
  END IF;
  CREATE EXTENSION IF NOT EXISTS pg_net;

  CREATE OR REPLACE FUNCTION avs.artwork_intake_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = avs, public, extensions AS $fn$
  DECLARE
    k   text;
    url text;
  BEGIN
    SELECT value INTO k FROM avs.settings WHERE key = 'robot_key';
    IF k IS NULL OR k = '' THEN RETURN NULL; END IF;
    SELECT COALESCE(NULLIF(value, ''), 'https://motionci.in') INTO url FROM avs.settings WHERE key = 'ci_plant_url';
    url := COALESCE(url, 'https://motionci.in');
    PERFORM net.http_post(
      url     := url || '/api/avs/robot/artwork-notify',
      body    := jsonb_build_object('from', 'avs.artwork_intake'),
      headers := jsonb_build_object('content-type', 'application/json', 'x-avs-robot-key', k),
      timeout_milliseconds := 20000);
    RETURN NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'artwork_intake_alert: %', SQLERRM;
    RETURN NULL;
  END $fn$;

  REVOKE ALL ON FUNCTION avs.artwork_intake_alert() FROM PUBLIC;
  DROP TRIGGER IF EXISTS artwork_intake_alert ON avs.artwork_intake;
  -- Once per statement: one call of avs.file_artwork_mails = one start of the copier = one alert for the run.
  CREATE TRIGGER artwork_intake_alert AFTER INSERT ON avs.artwork_intake
    FOR EACH STATEMENT
    EXECUTE FUNCTION avs.artwork_intake_alert();
END $outer$;
