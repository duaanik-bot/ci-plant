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
// request asks for one (after its response) at most every HEARTBEAT_EVERY_MS per server instance, and
// the database function itself sends at most one per 45 s however many instances
// ask. No traffic means no heartbeat, which means no cache hits — the safe default.
import { q } from './db.js';
import { withoutLedger } from './data-tables.js';

export const HEARTBEAT_EVERY_MS = 50 * 1000;

export function heartbeatDue(lastAt, now) {
  return !(Number.isFinite(lastAt) && now - lastAt < HEARTBEAT_EVERY_MS);
}

// Vercel's per-request context (what @vercel/functions' waitUntil reads). Absent locally.
const vercelRequestContext = () => globalThis[Symbol.for('@vercel/request-context')]?.get?.();

// AFTER the response, never before it. Measured 2026-09-17 the heartbeat was the top
// statement by database time (~30 ms a call), and awaiting it before next() made
// whichever request came due pay for it — plus everything queued behind the instance's
// one pooled client. The promise is registered with waitUntil while the request is still
// live, so an instance frozen after responding still sends the heartbeat. A promise
// settles once, so 'finish' and 'close' together (or 'close' alone, for an aborted
// request) run the query exactly once.
export function createHeartbeatMiddleware({ query, now = () => Date.now(), requestContext = vercelRequestContext }) {
  let lastAskedAt = -Infinity;
  return function heartbeatMiddleware(_req, res, next) {
    const t = now();
    if (heartbeatDue(lastAskedAt, t)) {
      lastAskedAt = t;   // throttle failures too: a database without the function is asked once a minute
      const beat = new Promise(resolve => { res.once('finish', resolve); res.once('close', resolve); })
        .then(() => query())
        .catch(() => { /* local dev has no realtime schema; the feed simply never proves itself there */ });
      const ctx = requestContext();
      if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(beat);
    }
    next();
  };
}

export const heartbeatMiddleware = createHeartbeatMiddleware({
  query: () => withoutLedger(() => q('SELECT public.ci_erp_realtime_heartbeat()')),
});
