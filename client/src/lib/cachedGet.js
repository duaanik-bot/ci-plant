// A GET through the realtime-validated response cache (responseCache.js).
//
// The one rule that makes it sound lives here: startedAt is taken BEFORE the
// request is issued. Any change the response did not see committed after the
// server read the data, so its announcement arrives after startedAt and voids the
// entry — even if it lands while this very request is still in flight.
import { parseTableHeader } from './responseCache.js';

// `now` defaults to the cache's own clock: startedAt must be on the same timeline
// as every stamp the cache compares it with.
export async function cachedGet({ url, token, cache, doFetch, now = cache.now ?? (() => Date.now()) }) {
  const hit = cache.lookup(url, token);
  if (hit != null) return { hit: true, data: JSON.parse(hit) };

  const startedAt = now();
  const res = await doFetch();
  const text = await res.text().catch(() => '');
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

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
