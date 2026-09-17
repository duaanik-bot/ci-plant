// The GET path through the response cache (client/src/lib/cachedGet.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCache } from '../../client/src/lib/responseCache.js';
import { cachedGet } from '../../client/src/lib/cachedGet.js';

const response = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: k => headers[k] ?? null },
  text: async () => JSON.stringify(body),
});

function live(t0 = 1000) {
  let t = t0;
  const clock = { now: () => t, tick: ms => { t += ms; } };
  const cache = createResponseCache({ now: clock.now });
  cache.noteStatus('SUBSCRIBED'); clock.tick(1);
  cache.noteHeartbeat(['orders', 'job_cards']); clock.tick(1);
  return { cache, clock };
}

test('a miss fetches, stores, and the repeat is answered without the network', async () => {
  const { cache, clock } = live();
  let calls = 0;
  const doFetch = async () => { calls++; return response(200, { rows: [1] }, { 'X-Data-Tables': 'orders' }); };
  const first = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  clock.tick(500);
  const second = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.equal(first.hit, false);
  assert.equal(second.hit, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.data, { rows: [1] });
  assert.notEqual(second.data, first.data, 'a hit hands back a fresh object, so callers may mutate it');
});

test('a change announced WHILE the request is in flight voids the entry it produces', async () => {
  const { cache, clock } = live();
  const doFetch = async () => {
    clock.tick(50);
    cache.noteChange('orders');          // committed after the server read, announced mid-flight
    clock.tick(50);
    return response(200, { rows: ['old'] }, { 'X-Data-Tables': 'orders' });
  };
  await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  clock.tick(10);
  let fetched = false;
  const again = await cachedGet({ url: '/orders', token: 't', cache, now: clock.now,
    doFetch: async () => { fetched = true; return response(200, { rows: ['new'] }, { 'X-Data-Tables': 'orders' }); } });
  assert.equal(fetched, true);
  assert.deepEqual(again.data, { rows: ['new'] });
});

test('no header, a non-200, or a header-less error is never stored', async () => {
  const { cache, clock } = live();
  await cachedGet({ url: '/a', token: 't', cache, now: clock.now, doFetch: async () => response(200, {}, {}) });
  await cachedGet({ url: '/b', token: 't', cache, now: clock.now, doFetch: async () => response(304, {}, { 'X-Data-Tables': 'orders' }) });
  await cachedGet({ url: '/c', token: 't', cache, now: clock.now, doFetch: async () => response(500, { error: 'x' }, { 'X-Data-Tables': 'orders' }) });
  assert.equal(cache.stats().entries, 0);
});

test('a GET that wrote invalidates our own copies of what it touched', async () => {
  const { cache, clock } = live();
  await cachedGet({ url: '/orders', token: 't', cache, now: clock.now,
    doFetch: async () => response(200, {}, { 'X-Data-Tables': 'orders' }) });
  clock.tick(100);
  await cachedGet({ url: '/chat/messages', token: 't', cache, now: clock.now,
    doFetch: async () => response(200, {}, { 'X-Data-Wrote': 'orders' }) });
  clock.tick(1);
  let fetched = false;
  await cachedGet({ url: '/orders', token: 't', cache, now: clock.now,
    doFetch: async () => { fetched = true; return response(200, {}, { 'X-Data-Tables': 'orders' }); } });
  assert.equal(fetched, true);
});

test('a body that is not JSON comes back as {} exactly as api.js always did', async () => {
  const { cache, clock } = live();
  const out = await cachedGet({ url: '/x', token: 't', cache, now: clock.now,
    doFetch: async () => ({ status: 502, headers: { get: () => null }, text: async () => '<html>bad gateway' }) });
  assert.deepEqual(out.data, {});
});

test('startedAt comes from the cache\'s own clock, so both sides stamp on one timeline', async () => {
  const { cache, clock } = live();
  const stored = [];
  const spy = { ...cache, lookup: cache.lookup, now: cache.now, noteChange: cache.noteChange,
    store: (k, v) => { stored.push(v.startedAt); cache.store(k, v); } };
  await cachedGet({ url: '/orders', token: 't', cache: spy,
    doFetch: async () => response(200, {}, { 'X-Data-Tables': 'orders' }) });
  assert.deepEqual(stored, [clock.now()], 'no now() passed: the cache clock is used, not Date.now()');
});
