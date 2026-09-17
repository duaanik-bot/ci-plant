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
