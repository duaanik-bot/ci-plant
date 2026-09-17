// Unread/count badges for a list screen's rows, one /threads/summary request per
// chunk of ids (a URL holding every id of a long register would be refused).
//
// A list screen re-asks on every realtime wave. api.get already hands back the
// SAME object when a chunk's bytes did not change (lib/cachedGet.js), but merging
// the chunks with Object.assign({}, ...parts) built a new object every time, so
// setThreads always saw "new data" and the whole register re-rendered for badges
// that had not moved. So: when every chunk is the object it was last time, the
// merge it produced last time is returned as-is.
//
// Remembered per entity, one merge each — a handful of small objects for the
// life of the tab. Responses are read-only: the merge is never edited in place.
export function createThreadSummary(get, chunk) {
  const last = new Map();                 // entity → { parts, merged }
  return (entity, ids) => {
    const calls = [];
    for (let i = 0; i < ids.length; i += chunk) {
      calls.push(get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + chunk).join(',')}`));
    }
    return Promise.all(calls).then(parts => {
      const prev = last.get(entity);
      if (prev && prev.parts.length === parts.length && prev.parts.every((p, i) => p === parts[i])) return prev.merged;
      const merged = Object.assign({}, ...parts);
      last.set(entity, { parts, merged });
      return merged;
    });
  };
}
