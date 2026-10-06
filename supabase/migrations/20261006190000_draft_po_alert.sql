-- New PO alert, straight from the database (owner's request, 6 Oct 2026).
--
-- PRODUCTION ONLY, like the avs migrations: it needs Supabase's pg_net and the
-- avs schema (avs.settings robot_key), neither of which exists on a local
-- database, so init() never replays it.
--
-- The AVS order intake keys new customer POs into the ERP as DRAFT orders by
-- SQL, through the Supabase connector — no CI Plant code runs when it does. So
-- the database itself tells CI Plant: the moment a draft order gets its first
-- line, pg_net posts to POST /api/avs/robot/drafts-notify (routes/avs-robot.js)
-- with the robot key, and CI Plant announces every draft nobody has been told
-- about yet to the whole team — the bell, and a push to every phone with
-- notifications on (routes/drafts.js notifyNewDraftOrders).
--
-- pg_net sends after the inserting transaction commits and never waits for the
-- answer, so a slow or unreachable CI Plant can never slow or fail the intake's
-- insert; and every error here is swallowed for the same reason. A lost call is
-- picked up by any open CI Plant within two minutes (GET /api/drafts/summary).
--
-- Re-posting is harmless: each draft is announced once (orders.draft_notified_at),
-- so the trigger posts on every draft line while the order is still unannounced.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.draft_po_alert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, avs, extensions AS $$
DECLARE
  k   text;
  url text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders
                  WHERE id = NEW.order_id AND status = 'draft' AND draft_notified_at IS NULL) THEN
    RETURN NULL;
  END IF;
  SELECT value INTO k FROM avs.settings WHERE key = 'robot_key';
  IF k IS NULL OR k = '' THEN RETURN NULL; END IF;
  SELECT COALESCE(NULLIF(value, ''), 'https://motionci.in') INTO url FROM avs.settings WHERE key = 'ci_plant_url';
  url := COALESCE(url, 'https://motionci.in');
  PERFORM net.http_post(
    url     := url || '/api/avs/robot/drafts-notify',
    body    := jsonb_build_object('order_id', NEW.order_id),
    headers := jsonb_build_object('content-type', 'application/json', 'x-avs-robot-key', k),
    timeout_milliseconds := 20000);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'draft_po_alert: %', SQLERRM;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.draft_po_alert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS draft_po_alert ON public.order_lines;
CREATE TRIGGER draft_po_alert AFTER INSERT ON public.order_lines
  FOR EACH ROW WHEN (NEW.status = 'draft')
  EXECUTE FUNCTION public.draft_po_alert();
