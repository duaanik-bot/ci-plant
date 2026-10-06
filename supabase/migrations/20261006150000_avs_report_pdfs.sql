-- AVS report PDFs kept in CI Plant, so the PDF button never waits for Google.
--
-- PRODUCTION ONLY, like the other avs migrations: init() never builds the
-- schema `avs`. This file is the record of what was applied, as the named
-- migration `avs_report_pdfs` (owner's OK, 6 Oct 2026).
--
-- Since 1 Oct the PDF button (GET /api/avs/reports/:no/pdf) read each report
-- through the Drive link (Apps Script) and stamped QA's decision on it. The
-- Drive link answers in 4 to 35 s and Vercel stops a request at 30 s, so the
-- button often failed (504). Now CI Plant keeps one copy of each report PDF
-- AS FILED (no stamp), keyed by its Drive file id: fetched once in the
-- background, then every open stamps that copy on the spot. The stamp is drawn
-- exactly as before; the PDF in Drive is never changed.
--
-- A new issue of a report is a new Drive file, so it gets its own row.
CREATE TABLE IF NOT EXISTS avs.report_pdfs (
  drive_file_id text PRIMARY KEY,
  report_no     text NOT NULL,
  bytes         bytea NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  cached_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_pdfs_report_no ON avs.report_pdfs (report_no);
-- PDFs are compressed already: kept as they are, out of line.
ALTER TABLE avs.report_pdfs ALTER COLUMN bytes SET STORAGE EXTERNAL;

-- Same lock-down as the rest of the schema.
ALTER TABLE avs.report_pdfs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON avs.report_pdfs FROM anon, authenticated;
