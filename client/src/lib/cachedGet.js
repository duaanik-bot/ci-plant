// A GET through the realtime-validated response cache (responseCache.js).
//
// The one rule that makes it sound lives here: startedAt is taken BEFORE the
// request is issued. Any change the response did not see committed after the
// server read the data, so its announcement arrives after startedAt and voids the
// entry — even if it lands while this very request is still in flight.
//
// RESPONSES ARE READ-ONLY. When a GET brings back exactly the bytes this URL last
// brought back — from the cache, or from the network after a wave that touched
// some other table, a 30 s poll, or a 10-minute age refetch the browser answered
// with a 304 — the caller gets the SAME object it got last time, not a fresh
// parse. `.then(setX)` then hands React the value it already holds and the screen
// does not re-render; on a plant tablet that was a whole-board render every poll.
// The price: two callers of one URL share one object, so no caller may sort,
// splice, push onto or assign into a response. Copy first ([...rows], {...row}).
// A dev build deep-freezes what it memoises so an in-place edit throws there
// instead of silently corrupting another screen in production.
import { parseTableHeader } from './responseCache.js';

const DEV_FREEZE = import.meta.env?.DEV === true;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

// `now` defaults to the cache's own clock: startedAt must be on the same timeline
// as every stamp the cache compares it with.
export async function cachedGet({ url, token, cache, doFetch, now = cache.now ?? (() => Date.now()), freeze = DEV_FREEZE }) {
  const hit = cache.lookup(url, token);
  if (hit != null) {
    const known = cache.recall(url, token, hit);
    if (known) return { hit: true, data: known.data };
    const data = JSON.parse(hit);
    cache.remember(url, token, hit, freeze ? deepFreeze(data) : data);
    return { hit: true, data };
  }

  const startedAt = now();
  const res = await doFetch();
  let text = await res.text().catch(() => '');
  let data;
  // Only a 200 is ever shared: an error body is handed to err.data and toasts,
  // and nothing about it is worth keeping. A string compare of the bytes is a
  // fraction of JSON.parse and of the render it would trigger.
  const known = res.status === 200 ? cache.recall(url, token, text) : undefined;
  if (known) {
    data = known.data;
    text = known.text;                 // keep ONE copy of the string, the memo's
  } else {
    let parsed = true;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; parsed = false; }
    if (res.status === 200 && parsed && text) cache.remember(url, token, text, freeze ? deepFreeze(data) : data);
  }

  // A GET that wrote (the chat thread stamping last_seen_at) invalidates our own
  // copies of what it touched at once, without waiting for the broadcast.
  const wrote = parseTableHeader(res.headers?.get?.('X-Data-Wrote'));
  if (wrote) for (const table of wrote) cache.noteChange(table);

  if (res.status === 200) {
    const tables = parseTableHeader(res.headers?.get?.('X-Data-Tables'));
    if (tables) cache.store(url, { text, tables, startedAt, token });
  }
  return { hit: false, res, data };
}
