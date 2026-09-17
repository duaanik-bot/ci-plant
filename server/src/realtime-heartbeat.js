// Proof that the database-to-browser change feed is alive.
//
// A browser answers a repeat GET from memory only while it can be sure it would
// have heard about any change. An open websocket does not prove that — the
// database's replication into Supabase Realtime can stall while the socket stays
// up — so the database itself sends a heartbeat through the same pipe, naming the
// tables whose changes it is announcing (public.ci_erp_realtime_heartbeat). A
// browser that stops hearing it stops trusting its cache within 150 s.
//
// pg_cron is not installed, so the heartbeat rides on traffic: an authenticated
// request asks for one at most every HEARTBEAT_EVERY_MS per server instance, and
// the database function itself sends at most one per 45 s however many instances
// ask. No traffic means no heartbeat, which means no cache hits — the safe default.
import { q } from './db.js';
import { withoutLedger } from './data-tables.js';

export const HEARTBEAT_EVERY_MS = 50 * 1000;

export function heartbeatDue(lastAt, now) {
  return !(Number.isFinite(lastAt) && now - lastAt < HEARTBEAT_EVERY_MS);
}

let lastAskedAt = -Infinity;

export async function heartbeatMiddleware(_req, _res, next) {
  const now = Date.now();
  if (heartbeatDue(lastAskedAt, now)) {
    lastAskedAt = now;   // throttle failures too: a database without the function is asked once a minute
    try {
      await withoutLedger(() => q('SELECT public.ci_erp_realtime_heartbeat()'));
    } catch { /* local dev has no realtime schema; the feed simply never proves itself there */ }
  }
  next();
}
