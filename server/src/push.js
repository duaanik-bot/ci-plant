// Web push — reaching the phone in the reader's pocket.
//
// The bell in the app only speaks to somebody already looking at the app. The
// people this ERP most needs to reach are the ones who are NOT: the plant head
// walking the floor when an extra-sheet request goes up, the MD away from the
// desk when a planner asks for a management approval. A notification nobody
// sees is a job standing still.
//
// TWO RULES GOVERN THIS FILE, and both are about what it must never do.
//
// 1. IT MUST NEVER FAIL A WRITE. Every notify() call in this codebase runs
//    inside the caller's transaction — issuing a plate, approving extra sheets,
//    raising an approval. A push that throws inside that transaction would roll
//    back the actual plant work over a phone that did not buzz. Nothing in here
//    is allowed to propagate; the bell row is already committed either way.
//
// 2. IT MUST NEVER RUN INSIDE THAT TRANSACTION. A push is one HTTPS round trip
//    PER DEVICE. Awaiting them inside tx() holds a pooled client open across
//    the network, which on the serverless pool (max 1) is the same shape as the
//    self-deadlock that once froze the floor. So sending is DEFERRED — handed
//    to the platform to finish after the response, never awaited by the caller.
import webpush from 'web-push';
import { q } from './db.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// mailto: identifies the sender to the push services, which is a requirement of
// the VAPID spec rather than a nicety — they use it to reach an operator when a
// sender misbehaves.
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:dua.anik@gmail.com';

// Configured once, and only when there is something to configure. Without keys
// the whole feature is simply off: the app still writes bell rows, still shows
// them, and nothing anywhere throws. That is deliberate — a local database, a
// preview deploy and CI all run without VAPID keys, and none of them should
// need them to boot.
export const pushConfigured = !!(PUBLIC_KEY && PRIVATE_KEY);
if (pushConfigured) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

export const publicKey = () => PUBLIC_KEY;

// What the service worker receives. Deliberately small: a push payload has a
// hard size limit (~4KB after encryption) and the body is a phone-screen line,
// not the whole notification. `link` is the deep link — the same one the bell
// follows — so tapping the phone lands on the job, not the app's front door.
export function pushPayload({ kind, title, body, link, refTable, refId }) {
  return JSON.stringify({
    kind: kind || 'note',
    title: String(title || 'Colour Impressions'),
    // Two lines is what a phone shows before it truncates; more is wasted bytes.
    body: String(body || '').split('\n').slice(0, 2).join(' · ').slice(0, 300),
    link: link || '/',
    // Collapse key: a second buzz about the SAME request replaces the first on
    // the lock screen instead of stacking. Without it, three plant alerts about
    // one job read as three jobs.
    tag: refTable && refId ? `${refTable}:${refId}` : `${kind || 'note'}`,
  });
}

// A push service answers 404 or 410 for a subscription that is permanently
// gone — the user revoked permission, or the browser install was removed.
// Anything else (a timeout, a 5xx) may well work next time.
const isDead = status => status === 404 || status === 410;

// Send to every device these users have registered. Returns a small tally so a
// caller that WANTS to know (the test-push button) can say what happened;
// callers that do not simply ignore it. Never throws.
export async function pushToUsers(userIds, payload, qc = q) {
  const ids = [...new Set((userIds || []).map(Number))].filter(id => Number.isInteger(id) && id > 0);
  if (!pushConfigured || !ids.length) return { sent: 0, failed: 0, pruned: 0, devices: 0 };
  let subs = [];
  try {
    subs = await qc(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])', [ids]);
  } catch (e) {
    console.warn(`[push] could not read subscriptions: ${e.message}`);
    return { sent: 0, failed: 0, pruned: 0, devices: 0 };
  }

  let sent = 0; let failed = 0; let pruned = 0;
  const dead = [];
  // Concurrently: a plant alert can fan out to a dozen devices, and doing them
  // one after another would add a dozen round trips to whatever is waiting.
  await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
      sent += 1;
    } catch (e) {
      if (isDead(e?.statusCode)) { dead.push(s.id); return; }
      failed += 1;
      console.warn(`[push] send failed (${e?.statusCode || 'no status'}): ${e?.message}`);
    }
  }));

  // Housekeeping, and it too must not throw: a subscription that could not be
  // deleted is a row to try again next time, not a reason to report a failure.
  try {
    if (dead.length) {
      await qc('DELETE FROM push_subscriptions WHERE id = ANY($1::int[])', [dead]);
      pruned = dead.length;
    }
    const ok = subs.filter(s => !dead.includes(s.id)).map(s => s.id);
    if (ok.length) await qc('UPDATE push_subscriptions SET last_ok_at=now(), failures=0 WHERE id = ANY($1::int[])', [ok]);
  } catch (e) {
    console.warn(`[push] housekeeping failed: ${e.message}`);
  }
  return { sent, failed, pruned, devices: subs.length };
}

// Vercel freezes a serverless function the moment its response is sent, which
// would kill a push still in flight. `waitUntil` is the platform's answer: work
// handed to it keeps the function alive until it settles. Read off the request
// context rather than importing @vercel/functions, so this file stays a plain
// module that runs unchanged under `node src/index.js` on the plant's own
// machine — where setImmediate is all that is needed, because nothing freezes.
function deferred(run) {
  const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.();
  const waitUntil = ctx?.waitUntil;
  if (typeof waitUntil === 'function') { waitUntil(run()); return; }
  setImmediate(() => { run(); });
}

// The entry point notify() uses. Fire-and-forget BY CONSTRUCTION: it returns
// undefined, so a caller cannot await it even by accident, and every path is
// wrapped so nothing reaches the transaction that called it.
//
// `q` — the pool — is used deliberately instead of the caller's `qc`. By the
// time this runs the caller's transaction has committed or rolled back and its
// client is back in the pool; writing through it would be writing through a
// connection that is no longer ours.
export function deferPushToUsers(userIds, payload) {
  if (!pushConfigured) return;
  try {
    deferred(async () => {
      try { await pushToUsers(userIds, payload, q); } catch (e) {
        console.warn(`[push] deferred send failed: ${e?.message}`);
      }
    });
  } catch (e) {
    console.warn(`[push] could not defer: ${e?.message}`);
  }
}
