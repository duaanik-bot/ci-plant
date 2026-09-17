// How many WRITES are on the wire right now, and which of them landed.
//
// The build watch reads this before it reloads a screen by itself. A reload in
// the middle of a save is the worst kind of lost entry: the figure may or may
// not have reached the server, and the operator is left looking at a fresh page
// with no way to tell which. So while a write is in flight the page stays put.
//
// A GET is not counted. It cannot lose an entry — the reloaded page simply asks
// again — and counting it kept the very screens this reload is for on an old
// build: Floor, Section, Sort & Paste and Print Planning reload their data
// every 30 s and the chat dock every 60 s, both of which divide the watch's
// 1-minute re-check, so a wall screen whose re-check happened to land inside
// its load window would find itself "busy" at every look, all shift.
//
// It is a module of its own, not part of api.js, so the watch (and its tests)
// can read the count without importing the whole API client.
let count = 0;
const writeListeners = new Set();

export function writesInFlight() { return count; }

// Hear about writes. `listener` runs as a write STARTS and may return a function;
// that function runs only if the write SUCCEEDS. The split is what lets a form
// tracker remember where a save came from at the moment it was sent, and only
// forget the form's edits once the server has accepted them.
export function onWrite(listener) {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

export async function tracked(isWrite, run) {
  if (!isWrite) return run();
  count++;
  const onSuccess = [];
  for (const listener of writeListeners) {
    try {
      const done = listener();
      if (typeof done === 'function') onSuccess.push(done);
    } catch { /* a listener must never break a request */ }
  }
  try {
    const out = await run();
    for (const done of onSuccess) {
      try { done(); } catch { /* as above */ }
    }
    return out;
  } finally {
    count--;
  }
}
