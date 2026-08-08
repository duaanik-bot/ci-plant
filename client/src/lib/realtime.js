import { createClient } from '@supabase/supabase-js';

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

function setStatus(next) {
  status = next;
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
  for (const { listener, tables } of changeListeners) {
    if (tableMatches(payload, tables)) listener(payload);
  }
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
  client ||= createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  channel = client
    // Database triggers send public invalidation broadcasts. State the channel
    // mode explicitly so a Supabase client default can never make the two
    // sides silently incompatible after a library upgrade.
    .channel(topic, { config: { private: false } })
    .on('broadcast', { event: 'db-change' }, emitChange)
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
