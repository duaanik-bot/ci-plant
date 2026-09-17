// A GET answered by the browser itself, when it can PROVE nothing it depends on
// has changed.
//
// Three-quarters of all API traffic was a 304 — a screen re-asking for data that
// had not changed, with the server running every query to find that out. The
// server now says which tables a response was built from (X-Data-Tables), and the
// database announces every committed change, one message per table per
// transaction, on the realtime feed. With both, a repeat request can be answered
// here — but ONLY when every one of these holds; the first doubt is a miss:
//
//   1. same signed-in token, and the entry is younger than MAX_AGE (the ceiling
//      for anything that drifts with the clock alone — "today", overdue days);
//   2. the feed has been SUBSCRIBED without a break since the request started,
//      so no change could have slipped past while the socket was down;
//   3. a database heartbeat arrived within LIVE_WINDOW — the socket being open
//      proves nothing about the database-to-realtime pipe, the heartbeat does,
//      and the heartbeat also names which tables are really being announced;
//   4. every table the response read is one of those announced tables;
//   5. no change to any of those tables arrived since the request STARTED — a
//      change that committed after the query read the data is necessarily
//      announced after that start, so nothing stale can hide behind the entry;
//   6. no write of our own (POST/PUT/PATCH/DELETE/upload), and no catch-up event
//      (reconnect, wake-up), happened since the request started;
//   7. after a wake-up (sleep, network back, a frozen tab resumed) a heartbeat has
//      arrived since — the socket may have died unnoticed while the device slept.
//
// Every stamp comes from ONE clock (`now`, which cachedGet uses too). A clock that
// steps backwards would leave later events stamped "before" older entries, so a
// step back drops every entry and every heartbeat, and an entry that claims to
// have started in the future is never stored or served.
//
// Memory is bounded twice: MAX_TEXT_CHARS per entry and MAX_TOTAL_CHARS overall,
// oldest out first; entries past MAX_AGE are swept on every store, and any miss
// drops the entry it judged (a miss is always followed by a fetch that replaces it).
//
// Pure and clock-injected so every rule is a unit test (response-cache.test.js).
export const MAX_AGE_MS = 10 * 60 * 1000;
export const LIVE_WINDOW_MS = 150 * 1000;
export const MAX_ENTRIES = 250;
export const MAX_TEXT_CHARS = 2 * 1000 * 1000;
export const MAX_TOTAL_CHARS = 16 * 1000 * 1000;

// A change to one of these voids EVERY entry, not just the ones that read it:
// users carries roles, scopes and the active flag, so a deactivated or re-scoped
// login must not keep reading screens from memory until MAX_AGE. (Presence stamps
// on users are filtered out at the trigger, so this fires only on real edits.)
export const VOID_ALL_TABLES = new Set(['users']);

export function parseTableHeader(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const list = value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}

export function createResponseCache({
  now = () => Date.now(),
  maxAgeMs = MAX_AGE_MS,
  liveWindowMs = LIVE_WINDOW_MS,
  maxEntries = MAX_ENTRIES,
  maxTextChars = MAX_TEXT_CHARS,
  maxTotalChars = MAX_TOTAL_CHARS,
} = {}) {
  const entries = new Map();
  const lastChangeAt = new Map();
  let chars = 0;
  let announced = null;          // Set of tables the latest heartbeat vouched for
  let lastBeatAt = -Infinity;
  let liveSince = null;          // start of the current unbroken SUBSCRIBED spell
  let lastMutationAt = -Infinity;
  let lastCatchUpAt = -Infinity;
  let lastResumeAt = -Infinity;
  let lastNow = -Infinity;
  const stats = { hits: 0, misses: 0, stored: 0, reasons: {} };

  const drop = key => {
    const e = entries.get(key);
    if (!e) return;
    chars -= e.text.length;
    entries.delete(key);
  };
  const dropAll = () => { entries.clear(); chars = 0; };

  // The one clock. A step backwards invalidates everything stamped before it.
  function clock() {
    const t = now();
    if (t < lastNow) {
      dropAll();
      for (const [table, at] of lastChangeAt) if (at > t) lastChangeAt.set(table, t);
      if (liveSince != null && liveSince > t) liveSince = t;
      lastMutationAt = Math.min(lastMutationAt, t);
      lastResumeAt = Math.min(lastResumeAt, t);
      lastCatchUpAt = t;
      lastBeatAt = -Infinity;        // a heartbeat stamped in the future proves nothing
    }
    lastNow = t;
    return t;
  }

  const miss = (reason, key) => {
    if (key != null) drop(key);
    stats.misses++;
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
    return null;
  };

  return {
    now: clock,

    noteStatus(status) {
      const t = clock();
      if (status === 'SUBSCRIBED') { if (liveSince == null) liveSince = t; }
      else liveSince = null;
    },
    noteChange(table) {
      const t = clock();
      if (typeof table === 'string' && table) {
        const name = table.toLowerCase();
        lastChangeAt.set(name, t);
        if (VOID_ALL_TABLES.has(name)) lastCatchUpAt = t;
      } else lastCatchUpAt = t;          // a change we cannot attribute voids everything
    },
    noteHeartbeat(tables) {
      lastBeatAt = clock();
      if (Array.isArray(tables)) announced = new Set(tables.map(x => String(x).toLowerCase()));
    },
    noteMutation() { lastMutationAt = clock(); },
    noteCatchUp() { lastCatchUpAt = clock(); },
    // The device slept, the network came back, or a frozen tab resumed: whatever
    // was cached is void, and nothing is trusted again until a heartbeat arrives.
    noteResume() { const t = clock(); lastCatchUpAt = t; lastResumeAt = t; },

    store(key, { text, tables, startedAt, token }) {
      const t = clock();
      if (typeof text !== 'string' || text.length > maxTextChars) return;
      if (!Array.isArray(tables) || !tables.length || !Number.isFinite(startedAt) || startedAt > t) return;
      for (const [k, e] of entries) if (t - e.startedAt > maxAgeMs) drop(k);
      drop(key);
      entries.set(key, { text, tables, startedAt, token });
      chars += text.length;
      stats.stored++;
      while (entries.size > maxEntries || chars > maxTotalChars) drop(entries.keys().next().value);
    },

    lookup(key, token) {
      const e = entries.get(key);
      if (!e) return miss('absent');
      const t = clock();
      if (!entries.has(key)) return miss('clock');
      if (e.token !== token) return miss('token', key);
      if (e.startedAt > t || t - e.startedAt > maxAgeMs) return miss('age', key);
      if (liveSince == null || liveSince > e.startedAt) return miss('not-live', key);
      if (t - lastBeatAt > liveWindowMs || !announced) return miss('no-heartbeat', key);
      if (lastMutationAt >= e.startedAt) return miss('own-write', key);
      if (lastCatchUpAt >= e.startedAt) return miss('catch-up', key);
      if (lastBeatAt <= lastResumeAt) return miss('resumed', key);
      for (const table of e.tables) {
        if (!announced.has(table)) return miss('unannounced-table', key);
        const c = lastChangeAt.get(table);
        if (c != null && c >= e.startedAt) return miss('changed', key);
      }
      entries.delete(key); entries.set(key, e);   // keep recently used entries
      stats.hits++;
      return e.text;
    },

    clear() { dropAll(); },
    stats() {
      return { ...stats, reasons: { ...stats.reasons }, entries: entries.size, chars,
        live: liveSince != null, announced: announced ? announced.size : 0 };
    },
  };
}

// The one cache the app shares: api.js reads and fills it, realtime.js feeds it.
export const responseCache = createResponseCache();
