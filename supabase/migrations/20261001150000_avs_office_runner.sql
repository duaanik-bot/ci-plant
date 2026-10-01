-- AVS office runner (1 Oct 2026): a small program on an office Mac (CARTON PC
-- MAIN) starts the check within seconds instead of waiting 1-5 minutes for a
-- cloud session. Verify leaves a set to it when it is alive (fire_status
-- 'local'); a set it did not start in time is sent to the cloud routine
-- ('fallback'). Its heartbeat is avs.settings local_runner_seen_at.
ALTER TABLE avs.check_requests DROP CONSTRAINT IF EXISTS check_requests_fire_status_check;
ALTER TABLE avs.check_requests ADD CONSTRAINT check_requests_fire_status_check
  CHECK (fire_status IS NULL OR fire_status IN ('fired', 'joined', 'failed', 'not_linked', 'local', 'fallback'));
