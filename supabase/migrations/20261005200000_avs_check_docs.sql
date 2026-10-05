-- AVS: documents with a photo set, and a re-check with new documents (owner's request, 5 Oct 2026).
--
-- People add the documents that help the check — the PO, the customer's approval, the artwork, an
-- e-mail (as a file or a link) — before Verify or after the report. The check reads them first and
-- still cross-checks them (runbook 2.4c). Documents added after the report wait for "Re-check with
-- new documents", which makes the report's next check from the SAME photos (photos_from_set_id).
-- A document can be removed for good (owner's choice) until a finished check has used it.
CREATE TABLE IF NOT EXISTS avs.check_docs (
  id                bigserial PRIMARY KEY,
  request_id        bigint NOT NULL REFERENCES avs.check_requests(id),
  kind              text NOT NULL CHECK (kind IN ('po', 'approval', 'artwork', 'email', 'other')),
  title             text,
  url               text,
  file_name         text,
  mime              text,
  size_bytes        integer,
  sha256            text,
  drive_file_id     text,
  drive_url         text,
  stored            text NOT NULL CHECK (stored IN ('drive', 'ci_plant', 'link')),
  note              text,
  added_by          text,
  added_by_user_id  integer,
  added_by_role     text,
  added_at          timestamptz NOT NULL DEFAULT now(),
  added_after_report boolean NOT NULL DEFAULT false,
  used_in_report    text,
  used_in_check     integer,
  used_at           timestamptz,
  CHECK (url IS NOT NULL OR file_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS check_docs_request_idx ON avs.check_docs (request_id);

-- A document kept in CI Plant while Google Drive could not take it (like avs.check_photo_bytes).
CREATE TABLE IF NOT EXISTS avs.check_doc_bytes (
  doc_id  bigint PRIMARY KEY REFERENCES avs.check_docs(id) ON DELETE CASCADE,
  bytes   bytea NOT NULL,
  kept_at timestamptz NOT NULL DEFAULT now()
);

-- A re-check with new documents uses the photos of an earlier set of the same report.
ALTER TABLE avs.check_requests ADD COLUMN IF NOT EXISTS photos_from_set_id bigint REFERENCES avs.check_requests(id);

ALTER TABLE avs.check_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE avs.check_doc_bytes ENABLE ROW LEVEL SECURITY;
