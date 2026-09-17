// realtime-js alone, not supabase-js: `.channel()` is all the app uses, and the
// full client dragged auth/storage/REST into the entry chunk. See realtimeEndpoint.js.
import { RealtimeClient } from '@supabase/realtime-js';
import { responseCache } from './responseCache.js';
import { createStatusTracker } from './realtimeStatus.js';
import { watchResume } from './resumeWatch.js';
import { realtimeEndpoint, realtimeClientOptions } from './realtimeEndpoint.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
const topic = import.meta.env.VITE_SUPABASE_REALTIME_TOPIC || 'ci-erp:db-changes';

const configured = Boolean(supabaseUrl && supabaseKey);

let client;
let channel;
let starting = false;
let status = configured ? 'idle' : 'disabled';
const changeListeners = new Set();
const statusListeners = new Set();
const tracker = createStatusTracker();

function setStatus(next) {
  status = next;
  responseCache.noteStatus(next);
  // Back after a break: nothing announced while the socket was down will ever
  // arrive, so every cached answer is void and every live screen reloads once.
  if (tracker.next(next).catchUp) {
    responseCache.noteCatchUp();
    for (const { listener } of changeListeners) listener({});
  }
  for (const listener of statusListeners) listener(status);
}

function normalisePayload(message) {
  return message?.payload || message || {};
}

function tableMatches(payload, tables) {
  if (!tables || tables === '*' || tables.length === 0) return true;
  const table = payload?.table;
  if (!table) return true;
  return new Set(Array.isArray(tables) ? tables : [tables]).has(table);
}

function emitChange(message) {
  const payload = normalisePayload(message);
  // Before any listener refetches: the cache must already know this table changed.
  responseCache.noteChange(payload?.table);
  for (const { listener, tables } of changeListeners) {
    if (tableMatches(payload, tables)) listener(payload);
  }
}

// The database's heartbeat (public.ci_erp_realtime_heartbeat): proof the feed is
// alive end to end, and the list of tables whose changes it announces.
function noteHeartbeat(message) {
  const payload = normalisePayload(message);
  responseCache.noteHeartbeat(Array.isArray(payload?.tracked) ? payload.tracked : null);
}

if (typeof window !== 'undefined') {
  window.__ciResponseCacheStats = () => responseCache.stats();
  // Slept, offline, frozen: the socket may have died unnoticed, so nothing cached
  // is trusted until the database's next heartbeat arrives.
  watchResume({ onResume: () => responseCache.noteResume() });
}

export function isRealtimeConfigured() {
  return configured;
}

export function getRealtimeStatus() {
  return status;
}

export function startRealtime() {
  if (!configured || channel || starting) return;
  starting = true;
  client ||= new RealtimeClient(realtimeEndpoint(supabaseUrl), realtimeClientOptions(supabaseKey));

  channel = client
    // Database triggers send public invalidation broadcasts. State the channel
    // mode explicitly so a Supabase client default can never make the two
    // sides silently incompatible after a library upgrade.
    .channel(topic, { config: { private: false } })
    .on('broadcast', { event: 'db-change' }, emitChange)
    .on('broadcast', { event: 'db-heartbeat' }, noteHeartbeat)
    .subscribe(next => {
      starting = false;
      setStatus(next);
    });
}

export function subscribeToDbChanges(listener, { tables } = {}) {
  const entry = { listener, tables };
  changeListeners.add(entry);
  startRealtime();
  return () => changeListeners.delete(entry);
}

export function subscribeToRealtimeStatus(listener) {
  statusListeners.add(listener);
  listener(status);
  startRealtime();
  return () => statusListeners.delete(listener);
}
