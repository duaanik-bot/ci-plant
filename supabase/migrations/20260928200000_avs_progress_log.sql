-- AVS: when each step of a check started, so CI Plant can show where a check's
-- time goes (owner's question, 28 Sep 2026: a check from CI Plant takes 25
-- minutes, from Cowork 15).
--
-- PRODUCTION ONLY, like the other avs migrations. APPLIED 2026-09-28 as the
-- named migration `avs_progress_log`.
--
-- Claude writes check_requests.progress at the start of every step (runbook
-- 2C.1 step 4). This trigger appends { "p": <progress>, "at": <time> } to
-- progress_log whenever progress changes; nothing else writes it, and nothing
-- is ever removed from it.
ALTER TABLE avs.check_requests ADD COLUMN IF NOT EXISTS progress_log jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION avs.check_requests_progress_log() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.progress IS DISTINCT FROM OLD.progress AND NEW.progress IS NOT NULL THEN
    NEW.progress_log := COALESCE(OLD.progress_log, '[]'::jsonb)
      || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('p', NEW.progress, 'at', pg_catalog.now()));
  ELSE
    NEW.progress_log := OLD.progress_log;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS check_requests_progress_log ON avs.check_requests;
CREATE TRIGGER check_requests_progress_log BEFORE UPDATE ON avs.check_requests
  FOR EACH ROW EXECUTE FUNCTION avs.check_requests_progress_log();
