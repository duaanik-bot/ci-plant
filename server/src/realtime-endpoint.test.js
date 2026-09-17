// The browser talks to Supabase Realtime through @supabase/realtime-js ALONE.
// The whole supabase-js client (auth, storage, postgrest, functions) was 156 KB
// of the entry chunk every plant tablet parses on a cold load, and the app only
// ever used its `.channel()` — a pass-through to the realtime client it builds.
// These tests pin that the hand-built RealtimeClient connects EXACTLY as the one
// supabase-js 2.111.0 built: same socket URL, same apikey, same token, same
// protocol version, same channel config, same failure on a bad URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { RealtimeClient } from '@supabase/realtime-js';
import { realtimeEndpoint, realtimeClientOptions } from '../../client/src/lib/realtimeEndpoint.js';

const URL_ = 'https://ylbfeptgefzimcqnwphy.supabase.co';
const KEY = 'sb_publishable_TESTKEY_not_real';
const TOPIC = 'ci-erp:db-changes';

const build = (url = URL_, key = KEY) => new RealtimeClient(realtimeEndpoint(url), realtimeClientOptions(key));
const pick = c => ({
  endpointURL: c.endpointURL(),
  vsn: c.vsn,
  timeout: c.timeout,
  heartbeatIntervalMs: c.heartbeatIntervalMs,
  worker: c.worker,
});

test('the socket URL is supabase-js\'s: realtime/v1 under the project, http→ws, apikey + vsn 2.0.0', () => {
  assert.equal(realtimeEndpoint(URL_), 'wss://ylbfeptgefzimcqnwphy.supabase.co/realtime/v1');
  assert.equal(
    build().endpointURL(),
    'wss://ylbfeptgefzimcqnwphy.supabase.co/realtime/v1/websocket?apikey=sb_publishable_TESTKEY_not_real&vsn=2.0.0',
  );
  assert.equal(build().vsn, '2.0.0');
  // Trimmed, trailing slash tolerated, scheme case folded, a path prefix kept,
  // plain http (local Supabase) becomes plain ws.
  assert.equal(realtimeEndpoint(` ${URL_}/ `), 'wss://ylbfeptgefzimcqnwphy.supabase.co/realtime/v1');
  assert.equal(realtimeEndpoint('HTTPS://A.supabase.co'), 'wss://a.supabase.co/realtime/v1');
  assert.equal(realtimeEndpoint('https://x.co/base'), 'wss://x.co/base/realtime/v1');
  assert.equal(realtimeEndpoint('http://127.0.0.1:54321'), 'ws://127.0.0.1:54321/realtime/v1');
});

test('a misconfigured env fails the way supabase-js failed it', () => {
  for (const bad of ['', '   ', undefined, null]) {
    assert.throws(() => realtimeEndpoint(bad), { message: 'supabaseUrl is required.' }, JSON.stringify(bad));
  }
  for (const bad of ['ftp://x.co', 'ylbfeptgefzimcqnwphy.supabase.co']) {
    assert.throws(() => realtimeEndpoint(bad), { message: 'Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.' }, bad);
  }
  for (const bad of ['https://', 'https:///', 'http://[bad']) {
    assert.throws(() => realtimeEndpoint(bad), { message: 'Invalid supabaseUrl: Provided URL is malformed.' }, bad);
  }
  assert.throws(() => realtimeClientOptions(''), { message: 'supabaseKey is required.' });
});

test('with no signed-in Supabase session the token is the publishable key, as supabase-js fell back to', async () => {
  const opts = realtimeClientOptions(KEY);
  assert.deepEqual(opts.params, { apikey: KEY });
  assert.equal(await opts.accessToken(), KEY);
  assert.equal(await build().accessToken(), KEY);
});

test('the channel the app joins is public broadcast, same params as before', () => {
  const ch = build().channel(TOPIC, { config: { private: false } });
  assert.equal(ch.topic, `realtime:${TOPIC}`);
  assert.deepEqual(ch.params.config, {
    broadcast: { ack: false, self: false },
    presence: { key: '', enabled: false },
    private: false,
  });
});

test('parity with supabase-js 2.111.0 while it is still installed', async t => {
  let createClient;
  try { ({ createClient } = await import('@supabase/supabase-js')); } catch {
    t.skip('@supabase/supabase-js not installed — the literal pins above still hold');
    return;
  }
  for (const url of [URL_, ` ${URL_}/ `, 'http://127.0.0.1:54321', 'https://x.co/base']) {
    const theirs = createClient(url, KEY, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    }).realtime;
    const ours = build(url);
    assert.deepEqual(pick(ours), pick(theirs), url);
    assert.equal(await ours.accessToken(), await theirs.accessToken(), url);
    assert.deepEqual(
      ours.channel(TOPIC, { config: { private: false } }).params,
      theirs.channel(TOPIC, { config: { private: false } }).params,
      url,
    );
  }
  for (const bad of ['', 'ftp://x.co', 'https://']) {
    let theirs;
    try { createClient(bad, KEY); } catch (e) { theirs = e.message; }
    assert.throws(() => realtimeEndpoint(bad), { message: theirs }, bad);
  }
});

test('nothing in the client imports the whole supabase-js client', () => {
  const root = new URL('../../client/src/', import.meta.url);
  const hits = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = new URL(name, dir);
      if (statSync(p).isDirectory()) { walk(new URL(`${name}/`, dir)); continue; }
      if (!/\.(jsx?|mjs)$/.test(name)) continue;
      if (/['"]@supabase\/supabase-js['"]/.test(readFileSync(p, 'utf8'))) hits.push(p.pathname);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
  const realtime = readFileSync(new URL('lib/realtime.js', root), 'utf8');
  assert.match(realtime, /import \{ RealtimeClient \} from '@supabase\/realtime-js'/);
  assert.match(realtime, /new RealtimeClient\(realtimeEndpoint\(supabaseUrl\), realtimeClientOptions\(supabaseKey\)\)/);
});
