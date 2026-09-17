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
  // The contract CHANGED on purpose (it used to be "a hit hands back a fresh
  // object, so callers may mutate it"). A screen refetched on every realtime wave
  // and every fallback poll handed React a brand-new object each time, so it
  // re-rendered a whole 1-2 MB board that had not changed. Responses are now
  // READ-ONLY: the same bytes come back as the same object, and React's
  // Object.is bail-out skips the render. A caller that wants to edit one copies it.
  assert.equal(second.data, first.data, 'responses are read-only; identical bytes return the identical object');
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

// ── Same bytes, same object ──────────────────────────────────────────────────
// A refetch that brings back exactly what the screen already holds must hand the
// screen the object it already holds. The memo lives beside the cache so the one
// clear() at sign-out forgets both.

const changed = (cache, clock) => { cache.noteChange('orders'); clock.tick(1); };

test('a network 200 with the same bytes returns the same object, without trusting the cache', async () => {
  const { cache, clock } = live();
  let calls = 0;
  const doFetch = async () => { calls++; return response(200, { rows: [1, 2] }, { 'X-Data-Tables': 'orders' }); };
  const first = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  changed(cache, clock);                     // the entry is void: this one goes to the network
  const second = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.equal(second.hit, false);
  assert.equal(calls, 2);
  assert.equal(second.data, first.data, 'identical bytes from the network: identical object');
});

test('different bytes are a new object, and that new object is what the next repeat returns', async () => {
  const { cache, clock } = live();
  let body = { rows: [1] };
  const doFetch = async () => response(200, body, { 'X-Data-Tables': 'orders' });
  const first = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  changed(cache, clock);
  body = { rows: [1, 2] };
  const second = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.notEqual(second.data, first.data);
  assert.deepEqual(second.data, { rows: [1, 2] });
  changed(cache, clock);
  const third = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.equal(third.data, second.data);
  const fourth = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.equal(fourth.hit, true);
  assert.equal(fourth.data, second.data, 'a hit hands back the memoised object too');
});

test('two URLs with the same bytes never share an object', async () => {
  const { cache, clock } = live();
  const doFetch = async () => response(200, [], { 'X-Data-Tables': 'orders' });
  const a = await cachedGet({ url: '/a', token: 't', cache, doFetch, now: clock.now });
  const b = await cachedGet({ url: '/b', token: 't', cache, doFetch, now: clock.now });
  assert.notEqual(a.data, b.data);
});

test('clear() and a different token both forget the memo', async () => {
  const { cache, clock } = live();
  const doFetch = async () => response(200, { rows: [1] }, { 'X-Data-Tables': 'orders' });
  const first = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  cache.clear();
  const afterClear = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now });
  assert.equal(afterClear.hit, false);
  assert.notEqual(afterClear.data, first.data, 'signed out: nothing parsed for the last login survives');
  const otherLogin = await cachedGet({ url: '/orders', token: 'u', cache, doFetch, now: clock.now });
  assert.equal(otherLogin.hit, false);
  assert.notEqual(otherLogin.data, afterClear.data, 'another token never receives this token\'s object');
  assert.equal(cache.stats().memo.entries, 1, 'the other token\'s copy replaced it, it did not pile up');
});

test('only a 200 that parsed is memoised — an error body or a bad body is always fresh', async () => {
  const { cache, clock } = live();
  const fail = async () => response(500, { error: 'x' }, { 'X-Data-Tables': 'orders' });
  const e1 = await cachedGet({ url: '/orders', token: 't', cache, now: clock.now, doFetch: fail });
  const e2 = await cachedGet({ url: '/orders', token: 't', cache, now: clock.now, doFetch: fail });
  assert.notEqual(e1.data, e2.data);
  const bad = async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html>' });
  const b1 = await cachedGet({ url: '/x', token: 't', cache, now: clock.now, doFetch: bad });
  const b2 = await cachedGet({ url: '/x', token: 't', cache, now: clock.now, doFetch: bad });
  assert.notEqual(b1.data, b2.data);
  assert.equal(cache.stats().memo.entries, 0);
});

test('a 200 the cache may not store (no table header) is still memoised by its bytes', async () => {
  const { cache, clock } = live();
  const doFetch = async () => response(200, { summary: { 7: 1 } });
  const a = await cachedGet({ url: '/threads/summary?entity=grn&ids=7', token: 't', cache, doFetch, now: clock.now });
  const b = await cachedGet({ url: '/threads/summary?entity=grn&ids=7', token: 't', cache, doFetch, now: clock.now });
  assert.equal(b.hit, false);
  assert.equal(b.data, a.data);
});

test('the memo is bounded by entries AND by characters, least recently used out first', async () => {
  let t = 1000;
  const clock = { now: () => t };
  const cache = createResponseCache({ now: clock.now, memoMaxEntries: 2, memoMaxChars: 20 });
  const get = (url, body) => cachedGet({ url, token: 't', cache, now: clock.now,
    doFetch: async () => response(200, body) });
  const a = await get('/a', [1]);
  const b = await get('/b', [2]);
  assert.equal((await get('/a', [1])).data, a.data, '/a used again: now the most recent');
  await get('/c', [3]);                                   // third entry: /b (least recent) goes
  assert.equal(cache.stats().memo.entries, 2);
  assert.notEqual((await get('/b', [2])).data, b.data, '/b was evicted');
  const big = 'x'.repeat(30);
  await get('/big', big);
  assert.ok(cache.stats().memo.chars <= 20, 'a body over the whole budget is never memoised');
  const lots = 'y'.repeat(17);
  await get('/d', lots);                                  // 19 chars beside /b's 3: /b must make room
  assert.deepEqual([cache.stats().memo.entries, cache.stats().memo.chars], [1, 19]);
});

test('a dev build freezes what it memoises, so an in-place edit fails loudly instead of leaking', async () => {
  const { cache, clock } = live();
  const doFetch = async () => response(200, { rows: [{ id: 1, tags: ['a'] }] }, { 'X-Data-Tables': 'orders' });
  const out = await cachedGet({ url: '/orders', token: 't', cache, doFetch, now: clock.now, freeze: true });
  assert.ok(Object.isFrozen(out.data) && Object.isFrozen(out.data.rows)
    && Object.isFrozen(out.data.rows[0]) && Object.isFrozen(out.data.rows[0].tags));
  assert.throws(() => out.data.rows.push({ id: 2 }), TypeError);
  assert.throws(() => { out.data.rows[0].id = 9; }, TypeError);
  const prod = await cachedGet({ url: '/other', token: 't', cache, doFetch, now: clock.now });
  assert.equal(Object.isFrozen(prod.data), false, 'production pays nothing for the guard');
});
