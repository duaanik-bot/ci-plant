import test from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatDue, HEARTBEAT_EVERY_MS } from './realtime-heartbeat.js';

test('the API asks for a heartbeat at most once per interval per instance', () => {
  assert.equal(heartbeatDue(-Infinity, 0), true, 'a fresh instance asks at once');
  assert.equal(heartbeatDue(1000, 1000 + HEARTBEAT_EVERY_MS - 1), false);
  assert.equal(heartbeatDue(1000, 1000 + HEARTBEAT_EVERY_MS), true);
});

test('the interval sits inside the database guard and the browser liveness window', async () => {
  const { LIVE_WINDOW_MS } = await import('../../client/src/lib/responseCache.js');
  assert.ok(HEARTBEAT_EVERY_MS >= 45 * 1000, 'the database sends at most one per 45 s anyway');
  assert.ok(HEARTBEAT_EVERY_MS * 2 < LIVE_WINDOW_MS, 'a single missed heartbeat must not switch the cache off');
});

// The heartbeat query (~30 ms, the top statement by DB time on 2026-09-17) was awaited
// before next(), so whichever request came due paid for it — and with one pooled client
// per instance, everything queued behind it did too. It now runs after the response.
import { EventEmitter } from 'node:events';
import { createHeartbeatMiddleware } from './realtime-heartbeat.js';

function rig({ context } = {}) {
  const calls = [];
  const kept = [];
  let t = 1_000_000;
  const mw = createHeartbeatMiddleware({
    query: () => { calls.push(t); return Promise.resolve(); },
    now: () => t,
    requestContext: () => (context ? { waitUntil: p => kept.push(p) } : undefined),
  });
  const request = () => {
    const res = new EventEmitter();
    let nexted = false;
    mw({}, res, () => { nexted = true; });
    return { res, nexted: () => nexted };
  };
  return { calls, kept, request, tick: ms => { t += ms; } };
}
const flush = () => new Promise(r => setImmediate(r));

test('the request goes on at once; the heartbeat runs only after the response is sent', async () => {
  const r = rig();
  const { res, nexted } = r.request();
  assert.equal(nexted(), true, 'next() is called synchronously');
  await flush();
  assert.equal(r.calls.length, 0, 'nothing runs while the response is being built');
  res.emit('finish'); res.emit('close');
  await flush();
  assert.equal(r.calls.length, 1, 'once, even when both finish and close fire');
});

test('an aborted request (close without finish) still sends the heartbeat it claimed', async () => {
  const r = rig();
  const { res } = r.request();
  res.emit('close');
  await flush();
  assert.equal(r.calls.length, 1);
});

test('on Vercel the pending heartbeat is handed to waitUntil, so a frozen instance still sends it', async () => {
  const r = rig({ context: true });
  const { res } = r.request();
  assert.equal(r.kept.length, 1, 'registered while the request is still live');
  res.emit('finish');
  await r.kept[0];
  assert.equal(r.calls.length, 1);
});

test('throttled per instance, and a failing query never surfaces', async () => {
  let t = 0;
  let calls = 0;
  const mw = createHeartbeatMiddleware({ query: () => { calls++; return Promise.reject(new Error('no realtime schema')); }, now: () => t, requestContext: () => undefined });
  const hit = () => { const res = new EventEmitter(); mw({}, res, () => {}); res.emit('finish'); };
  hit(); t += 10_000; hit(); await flush();
  assert.equal(calls, 1, 'second request inside the interval does not ask');
  t += HEARTBEAT_EVERY_MS; hit(); await flush();
  assert.equal(calls, 2);
});
