-- AVS: stop a check that is running, delete a check or a whole report so it can
-- be done again, and an audit trail of every such step (owner's request,
-- 1 Oct 2026).
--
-- PRODUCTION ONLY, like 20260926140100_avs_photo_sets.sql: init() never builds
-- the schema `avs`. This file is the record of what was applied, as the named
-- migration `avs_cancel_delete_audit`.
--
-- Nothing is ever erased. "Delete" hides a photo set or a report from the
-- register and the printing lock, with who, when and why; the rows, the PDF in
-- Drive and QA's decisions stay on record, and avs.audit_log keeps the trail.
--
--   Cancel        any set that is not finished, including one Claude is
--                 checking. Claude cannot be stopped from outside, so the
--                 database stops it: once a set is cancelled, every later write
--                 of the run to that set or its photos is refused with an error
--                 that starts AVS_CANCELLED (the routine stops on it), and the
--                 run's final write — report, problems, photos and set in one
--                 statement — is rolled back with it.
--   Delete a set  hides it (deleted_at). A running one is cancelled first.
--   Delete a      avs.deleted_reports: the report number is void. It leaves
--   report        avs.latest_reports (so the register and the printing lock no
--                 longer see it), every set behind it is hidden, and a new
--                 report row under that number is refused (AVS_DELETED). A
--                 redo is a fresh check with a NEW report number.
--   Redo          a new set for the same job cards, with the same photos
--                 (replaces_set_id / replaces_report_no); more can be added.

-- ── Audit log: append only ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS avs.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL,
  report_no     text,
  set_id        bigint,
  actor         text,
  actor_user_id integer,
  actor_role    text,
  reason        text,
  details       jsonb
);
CREATE INDEX IF NOT EXISTS audit_log_report_idx ON avs.audit_log (report_no, at);
CREATE INDEX IF NOT EXISTS audit_log_set_idx ON avs.audit_log (set_id, at);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON avs.audit_log (at DESC);

CREATE OR REPLACE FUNCTION avs.audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  RAISE EXCEPTION 'avs.audit_log is append only: % refused', TG_OP;
END $$;
DROP TRIGGER IF EXISTS audit_log_append_only ON avs.audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON avs.audit_log
  FOR EACH ROW EXECUTE FUNCTION avs.audit_log_append_only();

-- ── Sets: cancel reason, delete, redo source ────────────────────────────────
ALTER TABLE avs.check_requests
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_status text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by text,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id integer,
  ADD COLUMN IF NOT EXISTS delete_reason text,
  ADD COLUMN IF NOT EXISTS replaces_set_id bigint REFERENCES avs.check_requests(id),
  ADD COLUMN IF NOT EXISTS replaces_report_no text;
DO $$ BEGIN
  ALTER TABLE avs.check_requests ADD CONSTRAINT check_requests_delete_reason_check
    CHECK (deleted_at IS NULL OR length(btrim(coalesce(delete_reason, ''))) > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS check_requests_live_idx ON avs.check_requests (status, id) WHERE deleted_at IS NULL;

-- ── Deleted reports ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS avs.deleted_reports (
  report_no          text PRIMARY KEY,
  deleted_at         timestamptz NOT NULL DEFAULT now(),
  deleted_by         text,
  deleted_by_user_id integer,
  deleted_by_role    text,
  reason             text NOT NULL CHECK (length(btrim(reason)) > 0),
  snapshot           jsonb
);

-- The register, the report page and the printing lock all read
-- avs.latest_reports: a deleted report leaves it. The view's own text is kept
-- and only the filter is added, so its columns are not touched.
DO $$
DECLARE d text;
BEGIN
  IF to_regclass('avs.latest_reports') IS NULL THEN RETURN; END IF;
  d := pg_get_viewdef('avs.latest_reports'::regclass, true);
  IF position('deleted_reports' in d) = 0 THEN
    d := regexp_replace(d, '\sWHERE\s',
      ' WHERE NOT EXISTS (SELECT 1 FROM avs.deleted_reports dr WHERE dr.report_no = reports.report_no) AND ');
    IF position('deleted_reports' in d) = 0 THEN RAISE EXCEPTION 'avs.latest_reports has no WHERE to extend'; END IF;
    EXECUTE 'CREATE OR REPLACE VIEW avs.latest_reports AS ' || d;
  END IF;
END $$;

-- ── The stop: a cancelled or deleted set takes no more writes from a run ────
CREATE OR REPLACE FUNCTION avs.check_requests_stopped_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  IF (OLD.status = 'cancelled' OR OLD.deleted_at IS NOT NULL) AND (
       NEW.status IS DISTINCT FROM OLD.status OR NEW.progress IS DISTINCT FROM OLD.progress
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
    OR NEW.report_no IS DISTINCT FROM OLD.report_no OR NEW.report_rev IS DISTINCT FROM OLD.report_rev
    OR NEW.check_no IS DISTINCT FROM OLD.check_no OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.robot_note IS DISTINCT FROM OLD.robot_note
    OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)) THEN
    RAISE EXCEPTION 'AVS_CANCELLED: set % was % in CI Plant by % (%). STOP THIS RUN NOW: file nothing more, write nothing more, release the Drive lock if you hold it.',
      OLD.id, CASE WHEN OLD.deleted_at IS NOT NULL THEN 'deleted' ELSE 'cancelled' END,
      coalesce(OLD.deleted_by, OLD.cancelled_by, 'someone'), coalesce(OLD.delete_reason, OLD.cancel_reason, 'no reason given')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_requests_a_stopped_guard ON avs.check_requests;
CREATE TRIGGER check_requests_a_stopped_guard BEFORE UPDATE ON avs.check_requests
  FOR EACH ROW EXECUTE FUNCTION avs.check_requests_stopped_guard();

CREATE OR REPLACE FUNCTION avs.check_photos_stopped_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO '' AS $$
DECLARE s record;
BEGIN
  SELECT id, status, deleted_at INTO s FROM avs.check_requests WHERE id = OLD.request_id;
  IF s.status = 'cancelled' OR s.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'AVS_CANCELLED: set % was % in CI Plant. STOP THIS RUN NOW: file nothing more, write nothing more.',
      s.id, CASE WHEN s.deleted_at IS NOT NULL THEN 'deleted' ELSE 'cancelled' END USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS check_photos_a_stopped_guard ON avs.check_photos;
CREATE TRIGGER check_photos_a_stopped_guard BEFORE UPDATE ON avs.check_photos
  FOR EACH ROW EXECUTE FUNCTION avs.check_photos_stopped_guard();

-- A deleted report number is void: nothing more is issued under it.
CREATE OR REPLACE FUNCTION avs.reports_deleted_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM avs.deleted_reports d WHERE d.report_no = NEW.report_no) THEN
    RAISE EXCEPTION 'AVS_DELETED: report % was deleted in CI Plant and its number is void. Never re-check or continue it; issue the check under a NEW report number.',
      NEW.report_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('avs.reports') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS reports_deleted_guard ON avs.reports;
    CREATE TRIGGER reports_deleted_guard BEFORE INSERT ON avs.reports
      FOR EACH ROW EXECUTE FUNCTION avs.reports_deleted_guard();
  END IF;
END $$;

ALTER TABLE avs.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE avs.deleted_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON avs.audit_log, avs.deleted_reports FROM anon, authenticated;
