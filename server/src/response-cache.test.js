// The browser half: when may a repeat GET be answered without the network?
// Every rule in client/src/lib/responseCache.js has a case here, including the
// one that makes it sound — a change that committed after the query read the
// data is necessarily announced after the request started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCache, parseTableHeader, MAX_AGE_MS, LIVE_WINDOW_MS } from '../../client/src/lib/responseCache.js';

function rig() {
  let t = 1_000_000;
  const clock = { now: () => t, tick: ms => { t += ms; } };
  const cache = createResponseCache({ now: clock.now });
  cache.noteStatus('SUBSCRIBED');
  clock.tick(10);
  cache.noteHeartbeat(['orders', 'job_cards', 'job_stages']);
  clock.tick(10);
  return { cache, clock };
}
const put = (cache, clock, over = {}) => cache.store('/floor/counts', {
  text: '{"n":1}', tables: ['job_cards', 'job_stages'], startedAt: clock.now(), token: 'tok', ...over,
});

test('a repeat GET with nothing changed is answered locally', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(5000);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}');
  assert.equal(cache.stats().hits, 1);
});

test('a change to a table the response read — arriving after the request started — is a miss', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(200);
  cache.noteChange('job_stages');
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
});

test('a change that arrived BEFORE the request started does not void it', () => {
  const { cache, clock } = rig();
  cache.noteChange('job_stages'); clock.tick(5);
  put(cache, clock); clock.tick(100);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}');
});

test('a change to a table the response did not read leaves it alone', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteChange('orders');
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}');
});

test('same millisecond counts as after — ties go to the network', () => {
  const { cache, clock } = rig();
  put(cache, clock);
  cache.noteChange('job_cards');
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
});

test('another sign-in never sees this one\'s entries', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  assert.equal(cache.lookup('/floor/counts', 'someone-else'), null);
});

test('past MAX_AGE the network is asked even if nothing was announced', () => {
  const { cache, clock } = rig();
  put(cache, clock);
  for (let i = 0; i < 12; i++) { clock.tick(60_000); cache.noteHeartbeat(['orders', 'job_cards', 'job_stages']); }
  assert.ok(12 * 60_000 > MAX_AGE_MS);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
});

test('a socket that dropped at any point since the request started voids it, even once it is back', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteStatus('CHANNEL_ERROR'); clock.tick(100);
  cache.noteStatus('SUBSCRIBED'); cache.noteHeartbeat(['orders', 'job_cards', 'job_stages']); clock.tick(100);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
});

test('SUBSCRIBED repeated while already live does not restart the live spell', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteStatus('SUBSCRIBED'); clock.tick(100);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}');
});

test('no heartbeat within LIVE_WINDOW — the database pipe may be stalled — is a miss', () => {
  const { cache, clock } = rig();
  put(cache, clock);
  clock.tick(LIVE_WINDOW_MS + 1);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
  assert.equal(cache.stats().entries, 0, 'the miss dropped the entry; the fetch that follows replaces it');
  cache.noteHeartbeat(['orders', 'job_cards', 'job_stages']); clock.tick(1);
  put(cache, clock); clock.tick(1);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}', 'a fresh heartbeat restores caching');
});

test('never live, or never a heartbeat, means never a hit', () => {
  let t = 5;
  const c1 = createResponseCache({ now: () => t });
  c1.noteHeartbeat(['job_cards', 'job_stages']);
  c1.store('/x', { text: '1', tables: ['job_cards'], startedAt: t, token: 'tok' });
  t += 10;
  assert.equal(c1.lookup('/x', 'tok'), null, 'never SUBSCRIBED');
  const c2 = createResponseCache({ now: () => t });
  c2.noteStatus('SUBSCRIBED'); t += 1;
  c2.store('/x', { text: '1', tables: ['job_cards'], startedAt: t, token: 'tok' });
  t += 10;
  assert.equal(c2.lookup('/x', 'tok'), null, 'never a heartbeat');
});

test('a table the heartbeat does not vouch for can never be served locally', () => {
  const { cache, clock } = rig();
  cache.store('/chat', { text: '[]', tables: ['conversations'], startedAt: clock.now(), token: 'tok' });
  clock.tick(100);
  assert.equal(cache.lookup('/chat', 'tok'), null);
  assert.equal(cache.stats().reasons['unannounced-table'], 1);
});

test('our own write since the request started voids every entry', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteMutation();
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
  clock.tick(10); put(cache, clock); clock.tick(10);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}', 'a request after the write is fine');
});

test('a catch-up (reconnect) or an unattributable change voids every entry', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteCatchUp();
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
  clock.tick(10); put(cache, clock); clock.tick(10);
  cache.noteChange(undefined);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
});

test('nothing is stored without a table list, and nothing oversize is stored', () => {
  const { cache, clock } = rig();
  cache.store('/a', { text: '{}', tables: null, startedAt: clock.now(), token: 'tok' });
  cache.store('/b', { text: '{}', tables: [], startedAt: clock.now(), token: 'tok' });
  const tiny = createResponseCache({ now: clock.now, maxTextChars: 3 });
  tiny.store('/c', { text: '12345', tables: ['orders'], startedAt: clock.now(), token: 'tok' });
  assert.equal(cache.stats().entries, 0);
  assert.equal(tiny.stats().entries, 0);
});

test('the entry list is bounded, oldest out first', () => {
  let t = 1;
  const c = createResponseCache({ now: () => t, maxEntries: 2 });
  c.noteStatus('SUBSCRIBED'); c.noteHeartbeat(['orders']); t++;
  for (const k of ['/1', '/2', '/3']) c.store(k, { text: k, tables: ['orders'], startedAt: t, token: 'tok' });
  t++;
  assert.equal(c.lookup('/1', 'tok'), null);
  assert.equal(c.lookup('/3', 'tok'), '/3');
});

test('parseTableHeader reads the server header, and treats absence as "do not cache"', () => {
  assert.deepEqual(parseTableHeader('job_cards,Job_Stages, orders'), ['job_cards', 'job_stages', 'orders']);
  assert.equal(parseTableHeader(''), null);
  assert.equal(parseTableHeader(null), null);
});

test('a change to users voids every entry — a deactivated or re-scoped login must not read from memory', () => {
  const { cache, clock } = rig();
  put(cache, clock);
  cache.store('/planning', { text: '[]', tables: ['orders'], startedAt: clock.now(), token: 'tok' });
  clock.tick(100);
  cache.noteChange('users');
  assert.equal(cache.lookup('/floor/counts', 'tok'), null);
  assert.equal(cache.lookup('/planning', 'tok'), null, 'even an entry that never read users');
});

// Every rule compares stamps from one clock. A clock stepped BACKWARDS (a tablet
// running fast corrected by NTP) would otherwise leave every later change, write and
// reconnect stamped "before" entries stored earlier — deaf to all of them — and a
// heartbeat stamped in the future would count as fresh for as long as the step.
test('a clock that steps backwards voids every entry and every future-stamped heartbeat', () => {
  let t = 10_000_000;
  const c = createResponseCache({ now: () => t });
  c.noteStatus('SUBSCRIBED'); t += 10;
  c.noteHeartbeat(['orders']); t += 10;
  c.store('/orders', { text: 'old', tables: ['orders'], startedAt: t, token: 'tok' });
  t += 10;
  assert.equal(c.lookup('/orders', 'tok'), 'old', 'baseline hit');
  t -= 24 * 3600 * 1000;                       // corrected by a day
  c.noteChange('orders');                      // announced with the corrected clock
  assert.equal(c.lookup('/orders', 'tok'), null, 'the change after the step still voids it');
  c.store('/orders', { text: 'new', tables: ['orders'], startedAt: t, token: 'tok' });
  t += 10;
  assert.equal(c.lookup('/orders', 'tok'), null, 'the heartbeat stamped before the step no longer vouches');
  c.noteHeartbeat(['orders']); t += 10;
  c.store('/future', { text: 'f', tables: ['orders'], startedAt: t + 60_000, token: 'tok' });
  assert.equal(c.stats().entries, 0, 'a request that claims to have started in the future is never stored');
  c.store('/orders', { text: 'new', tables: ['orders'], startedAt: t, token: 'tok' });
  t += 10;
  assert.equal(c.lookup('/orders', 'tok'), 'new', 'a heartbeat after the step restores it');
});

// A socket can be dead without the client knowing yet — a tablet asleep, Wi-Fi gone —
// and realtime-js only notices on its own heartbeat timeout. Until a database
// heartbeat arrives AFTER the wake-up, nothing proves the socket survived.
test('after a wake-up, nothing is served until a heartbeat arrives after it', () => {
  const { cache, clock } = rig();
  put(cache, clock); clock.tick(100);
  cache.noteResume(); clock.tick(10);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null, 'entries from before the sleep are void');
  put(cache, clock); clock.tick(10);
  assert.equal(cache.lookup('/floor/counts', 'tok'), null, 'even an entry fetched after waking waits for the proof');
  assert.equal(cache.stats().reasons.resumed, 1);
  cache.noteHeartbeat(['orders', 'job_cards', 'job_stages']); clock.tick(10);
  put(cache, clock); clock.tick(10);
  assert.equal(cache.lookup('/floor/counts', 'tok'), '{"n":1}', 'a heartbeat after waking restores caching');
});

// A floor tablet keeps one tab open all shift. Entries it can never serve again must
// not stay in memory, and the live ones share one budget, not 250 × a per-entry cap.
test('memory: a total character budget, dead entries dropped, a miss frees its entry', () => {
  let t = 1;
  const c = createResponseCache({ now: () => t, maxTotalChars: 10, maxTextChars: 6 });
  c.noteStatus('SUBSCRIBED'); c.noteHeartbeat(['orders']); t++;
  for (const k of ['/a', '/b', '/c']) c.store(k, { text: 'xxxx', tables: ['orders'], startedAt: t, token: 'tok' });
  assert.equal(c.stats().entries, 2, '12 chars over a 10-char budget: oldest out');
  assert.equal(c.stats().chars, 8);
  assert.equal(c.lookup('/a', 'tok'), null);
  c.store('/big', { text: 'x'.repeat(7), tables: ['orders'], startedAt: t, token: 'tok' });
  assert.equal(c.stats().entries, 2, 'over the per-entry cap: not stored');
  c.noteMutation(); t++;
  assert.equal(c.lookup('/b', 'tok'), null);
  assert.equal(c.stats().entries, 1, 'a miss drops the entry it judged');
  t += MAX_AGE_MS + 1;
  c.store('/d', { text: 'y', tables: ['orders'], startedAt: t, token: 'tok' });
  assert.equal(c.stats().entries, 1, 'storing sweeps entries past MAX_AGE');
  assert.equal(c.stats().chars, 1);
  c.clear();
  assert.deepEqual([c.stats().entries, c.stats().chars], [0, 0]);
});
