-- AVS photo sets — carton photos uploaded in CI Plant for Claude to check.
--
-- PRODUCTION ONLY. The schema `avs` is created on colour-impressions-prod by
-- migration and never by init(): a local database has no `avs` schema, and the
-- AVS routes answer there with a switched-off module. This file is the record
-- of what was applied, not something init() replays. APPLIED 2026-09-26 as the
-- named migration `avs_photo_sets`.
--
--   avs.check_requests  one row per photo set: the job card it is for, who
--                       started it, and where it stands —
--                       uploading → (Verify) queued → (Claude) checking → done | failed,
--                       or cancelled while uploading or queued. Claude writes
--                       claimed_at, progress, the report it issued and robot_note.
--   avs.check_photos    one row per photo: its name, size, SHA-256 and where it
--                       is in Google Drive. The photo itself is only in Drive.
--
-- Same lock-down as the rest of the schema: RLS on, no policies, nothing for
-- anon or authenticated. CI Plant reaches it as the database owner, through its
-- own API behind the ERP login; Claude through the Supabase connector.
CREATE TABLE IF NOT EXISTS avs.check_requests (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status             text NOT NULL DEFAULT 'uploading'
                     CHECK (status IN ('uploading','queued','checking','done','failed','cancelled')),
  job_card_id        integer,
  jc_number          text,
  product_hint       text,
  note               text,
  created_by         text,
  created_by_user_id integer,
  created_by_role    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  next_seq           integer NOT NULL DEFAULT 0,
  drive_folder_path  text,
  drive_folder_id    text,
  drive_folder_url   text,
  queued_at          timestamptz,
  queued_by          text,
  fired_at           timestamptz,
  fire_status        text CHECK (fire_status IS NULL OR fire_status IN ('fired','joined','failed','not_linked')),
  fire_error         text,
  session_url        text,
  claimed_at         timestamptz,
  claimed_by         text,
  progress           text,
  finished_at        timestamptz,
  report_no          text,
  report_rev         integer,
  check_no           integer,
  result             text CHECK (result IS NULL OR result IN ('PASS','HOLD','REJECT')),
  robot_note         text,
  cancelled_at       timestamptz,
  cancelled_by       text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS check_requests_status_idx ON avs.check_requests (status, queued_at);
CREATE INDEX IF NOT EXISTS check_requests_job_card_idx ON avs.check_requests (jc_number);

CREATE TABLE IF NOT EXISTS avs.check_photos (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id    bigint NOT NULL REFERENCES avs.check_requests(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  file_name     text NOT NULL,
  original_name text,
  mime          text,
  size_bytes    integer,
  sha256        text,
  captured_at   timestamptz,
  drive_file_id text,
  drive_url     text,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, seq)
);

ALTER TABLE avs.check_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE avs.check_photos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON avs.check_requests, avs.check_photos FROM anon, authenticated;
