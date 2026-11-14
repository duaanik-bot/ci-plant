-- The office computer answers a Fetch (owner, 14 Nov 2026: "While we click on the refresh button or fetch the emails, it
-- should trigger the AVS on my office PC").
--
-- PRODUCTION ONLY, like the other avs migrations (init() never replays it); a test runs it after creating the schema.
--
-- Fetch from mail queues a fetch job for the business mailbox (server/src/enquiry-cloud.js startFetch). A small watcher
-- on the office computer asks GET /api/enquiry-desk/waiting every minute and, when one waits, starts the office Claude
-- with the avs-enquiries skill. By its own rules that Claude writes nothing but through avs functions, and types no
-- secret: it takes the job with avs.take_enquiry_fetch(), files with avs.file_enquiry_mails, and closes the job with
-- avs.finish_enquiry_fetch(job, result). The scheduled AVS runs take a waiting job too, so a Fetch pressed while the
-- office computer is off is answered by the next run. A job taken more than an hour ago and never closed can be taken
-- again (as the desk robot's jobs can).

-- The oldest waiting fetch for the business mailbox, now taken by the office: { job_id, since, queued_by }, or NULL.
CREATE OR REPLACE FUNCTION avs.take_enquiry_fetch() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, avs AS $$
  UPDATE enquiry_jobs SET status = 'working', claimed_by = 'AVS (office)', claimed_at = now()
   WHERE id = (SELECT id FROM enquiry_jobs
                WHERE kind = 'fetch' AND mailbox = 'business'
                  AND (status = 'queued' OR (status = 'working' AND claimed_at < now() - interval '1 hour'))
                ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING jsonb_build_object('job_id', id, 'since', brief->>'since', 'queued_by', queued_by_name);
$$;

-- Close a fetch the office took: { read, filed, skipped, counters, … } as the run counted them.
CREATE OR REPLACE FUNCTION avs.finish_enquiry_fetch(job_id bigint, result jsonb DEFAULT '{}'::jsonb) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, avs AS $$
  WITH done AS (
    UPDATE enquiry_jobs SET status = 'done', result = COALESCE(finish_enquiry_fetch.result, '{}'::jsonb), finished_at = now()
     WHERE id = finish_enquiry_fetch.job_id AND kind = 'fetch' AND mailbox = 'business' AND status = 'working'
    RETURNING id
  )
  SELECT CASE WHEN EXISTS (SELECT 1 FROM done) THEN 'done' ELSE 'not open: nothing changed' END;
$$;

REVOKE ALL ON FUNCTION avs.take_enquiry_fetch() FROM PUBLIC;
REVOKE ALL ON FUNCTION avs.finish_enquiry_fetch(bigint, jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION avs.take_enquiry_fetch() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION avs.finish_enquiry_fetch(bigint, jsonb) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION avs.take_enquiry_fetch() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION avs.finish_enquiry_fetch(bigint, jsonb) FROM authenticated';
  END IF;
END $$;
