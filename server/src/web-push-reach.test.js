import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pushSupport, urlBase64ToUint8Array } from '../../client/src/lib/webPush.js';
import { pushPayload, pushConfigured } from './push.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// A notification that only reaches somebody already looking at the app does not
// reach the people this ERP most needs: the plant head on the floor, the MD away
// from the desk. These tests pin the reach — and, just as much, pin the two
// things push must never do to the plant work that triggered it.

// ── What a device is actually capable of ──────────────────────────────────
const env = o => pushSupport({
  hasSW: true, hasPush: true, hasNotification: true,
  isIOS: false, isStandalone: false, permission: 'default', serverEnabled: true, ...o });

test('an iPhone in a Safari TAB is told the one thing that will fix it', () => {
  // Apple does not expose PushManager to a tab — only to a site installed on
  // the Home Screen. "Your browser cannot" is true there and useless.
  const r = env({ isIOS: true, isStandalone: false, hasPush: false });
  assert.equal(r.state, 'ios_needs_install');
  assert.equal(r.can, false);
  assert.match(r.message, /Add to Home Screen/);
});

test('the same iPhone, once installed to the Home Screen, can subscribe', () => {
  assert.deepEqual(
    { ...env({ isIOS: true, isStandalone: true, hasPush: true }) },
    { state: 'ready', can: true, message: env({}).message });
});

test('a blocked permission is a different problem from an incapable browser', () => {
  assert.equal(env({ permission: 'denied' }).state, 'blocked');
  assert.match(env({ permission: 'denied' }).message, /site settings/);
  assert.equal(env({ hasPush: false }).state, 'unsupported');
  // …and a granted one is ready, not "already on" — whether a subscription
  // exists is a separate question the caller asks the browser.
  assert.equal(env({ permission: 'granted' }).state, 'ready');
});

test('a server with no VAPID keys says so instead of offering a dead button', () => {
  const r = pushSupport({ hasSW: true, hasPush: true, hasNotification: true, permission: 'granted', serverEnabled: false });
  assert.equal(r.state, 'server_off');
  assert.equal(r.can, false);
  // And the module itself is simply OFF rather than throwing at import time —
  // which is what lets CI, a local database and a preview deploy all boot.
  assert.equal(pushConfigured, false);
});

test('the VAPID key survives the trip from base64url to bytes', () => {
  // '-' and '_' are the url-safe stand-ins for '+' and '/', and the padding is
  // stripped in transit; getting either wrong yields a key the browser refuses.
  const bytes = urlBase64ToUint8Array('BFy-_w');
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...urlBase64ToUint8Array('AAECAw')], [0, 1, 2, 3]);
});

// ── What actually lands on the lock screen ────────────────────────────────
test('the push carries the deep link, so the tap lands on the job', () => {
  const p = JSON.parse(pushPayload({
    kind: 'mgt_request',
    title: 'Management approval asked — GLISIMET TRIO 2',
    body: 'CI-MA-0004 · PO 01989 · qty 24500\nPlant: PO GSM 320\nAVLIVAL STOCKS 290 GSM',
    link: '/planning?ar=6', refTable: 'approval_requests', refId: 6,
  }));
  assert.equal(p.link, '/planning?ar=6');
  // Same request → same tag → the second buzz REPLACES the first rather than
  // stacking, so three alerts about one job do not read as three jobs.
  assert.equal(p.tag, 'approval_requests:6');
  // A phone shows about two lines; the rest is wasted payload against a ~4KB cap.
  assert.equal(p.body, 'CI-MA-0004 · PO 01989 · qty 24500 · Plant: PO GSM 320');
  assert.ok(p.body.length <= 300);
});

test('a payload with nothing in it still reaches the reader', () => {
  const p = JSON.parse(pushPayload({}));
  assert.equal(p.title, 'Colour Impressions');
  assert.equal(p.link, '/');
  assert.equal(p.body, '');
});

// ── The two rules push must never break ───────────────────────────────────
const helpers = read('./helpers.js');
const push = read('./push.js');

test('one call site: every notification in the app buzzes, because notify() does', () => {
  assert.match(helpers, /deferPushToUsers\(ids, pushPayload\(\{ kind, title, body, link, refTable, refId \}\)\)/);
  // Exactly one — a second call site is a second place for the rules to be broken.
  assert.equal(helpers.match(/deferPushToUsers\(/g).length, 1);
});

test('a push can never fail the plant work that triggered it', () => {
  // Not awaited, and returns undefined so it cannot be awaited by accident.
  assert.doesNotMatch(helpers, /await deferPushToUsers/);
  assert.match(push, /export function deferPushToUsers/);   // not `async`
  // Every path inside is caught: a phone that did not buzz must never roll back
  // an approval, a plate issue or an extra-sheet decision.
  assert.ok(push.match(/catch/g).length >= 5);
});

test('a push never runs inside the caller transaction, and never on its client', () => {
  // Vercel freezes a function once its response is sent; waitUntil is what keeps
  // an in-flight push alive. setImmediate is the plant machine's equivalent.
  assert.match(push, /waitUntil/);
  assert.match(push, /setImmediate/);
  // The pool, NOT the caller's qc: by the time this runs the caller's client is
  // back in the pool and writing through it would be writing through a
  // connection that is no longer ours.
  assert.match(push, /await pushToUsers\(userIds, payload, q\)/);
});

test('a subscription that the push service says is gone is deleted, not retried forever', () => {
  assert.match(push, /const isDead = status => status === 404 \|\| status === 410/);
  assert.match(push, /DELETE FROM push_subscriptions WHERE id = ANY/);
});

// ── The device row, and who it belongs to ─────────────────────────────────
const routes = read('./routes/notifications.js');
const schema = read('./db.js');
const migration = read('../../supabase/migrations/20260822120000_push_subscriptions.sql');

test('an endpoint is a DEVICE, so a second person signing in takes it over', () => {
  // UNIQUE on endpoint alone. Keyed on (user_id, endpoint) instead, the plant
  // tablet would keep buzzing the previous user for approvals that are no
  // longer theirs to see.
  assert.match(migration, /endpoint TEXT NOT NULL UNIQUE/);
  assert.match(schema, /endpoint TEXT NOT NULL UNIQUE/);
  assert.match(routes, /ON CONFLICT \(endpoint\) DO UPDATE/);
  assert.match(routes, /SET user_id = EXCLUDED\.user_id/);
});

test('nobody can silence somebody else phone', () => {
  assert.match(routes, /DELETE FROM push_subscriptions WHERE endpoint=\$1 AND user_id=\$2/);
  // …and the test buzz can only ever reach the caller's own devices.
  assert.match(routes, /pushToUsers\(\[req\.user\.id\]/);
});

test('the key route answers honestly when the server cannot push', () => {
  assert.match(routes, /enabled: pushConfigured/);
  assert.match(routes, /key: pushConfigured \? publicKey\(\) : null/);
});

// ── The worker that puts it on the screen ─────────────────────────────────
const sw = read('../../client/public/sw.js');
const layout = read('../../client/src/components/AppLayout.jsx');
const main = read('../../client/src/main.jsx');

test('tapping the notification reuses the open app rather than opening a second one', () => {
  assert.match(sw, /notificationclick/);
  assert.match(sw, /clients\.matchAll/);
  assert.match(sw, /c\.navigate\(url\.href\)/);
  assert.match(sw, /openWindow/);
  // The deep link rides on the notification itself, so the tap needs no server.
  assert.match(sw, /data: \{ link: d\.link \|\| '\/'/);
});

test('an approval stays on the lock screen until it is dealt with', () => {
  assert.match(sw, /requireInteraction: d\.kind === 'mgt_request' \|\| d\.kind === 'xs_request'/);
});

test('the worker caches nothing — a plant ERP must not serve yesterday figures', () => {
  assert.doesNotMatch(sw, /caches\.|cache\.put|addEventListener\('fetch'/);
});

test('the worker is re-registered on every boot, and the panel can turn a device on', () => {
  assert.match(main, /navigator\.serviceWorker\.register\('\/sw\.js'/);
  assert.match(layout, /api\.post\('\/push\/subscribe', \{ subscription: sub\.toJSON\(\) \}\)/);
  // The server is told BEFORE the browser forgets: a device dropped locally but
  // still on the server's list is one nobody can silence.
  assert.ok(layout.indexOf("api.post('/push/unsubscribe'") < layout.indexOf('sub.unsubscribe()'));
});
