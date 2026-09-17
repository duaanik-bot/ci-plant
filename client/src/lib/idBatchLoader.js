// Look records up by id, many callers at once, as few requests as possible.
//
// Built for ProductIdentity: every product name on every screen is one of these
// components, and each one whose row arrived without its codes wants its master
// record. Asking per component would be a request per row on a 60-row station
// queue; asking for the whole master (what it used to do) was ~1,062 KB parsed
// on the tablet at every page load. So every id asked for within one macrotask
// is gathered and sent as one request — React runs all of a commit's effects in
// the same task, so one screen's worth of rows lands in one batch.
//
// The rules the plant depends on (products-identity.test.js):
//   - ids are normalised to positive integers ('12' and 12 are one id); junk
//     resolves null without a request;
//   - a batch is split at `cap` ids, the same cap the server enforces;
//   - an answer is kept for the life of the page — found AND not found. An id the
//     server does not return (a deleted product, one without a board) would
//     otherwise be asked for again on every re-render;
//   - a failed request is NOT remembered as "not found": those ids resolve null
//     for now and are asked for again next time, as the old whole-list cache
//     retried after a failure.
export function createIdBatchLoader({ fetchBatch, cap = 200, schedule = fn => setTimeout(fn, 0) }) {
  const known = new Map();    // id → record | null (null = the server has no such row)
  const inFlight = new Map(); // id → Promise<record | null>
  let queued = new Map();     // id → { resolve }, waiting for the next flush
  let scheduled = false;

  const settleChunk = async (ids, batch) => {
    const waiting = ids.map(id => [id, batch.get(id)]);
    let rows;
    try {
      rows = await fetchBatch(ids);
    } catch {
      rows = null;
    }
    // Only a real list is an answer; anything else is a failure, and a failure
    // must not be written down as "no such product".
    const answered = Array.isArray(rows);
    const byId = new Map();
    if (answered) for (const row of rows) byId.set(Number(row?.id), row);
    for (const [id, slot] of waiting) {
      const record = byId.get(id) ?? null;
      if (answered) known.set(id, record);
      inFlight.delete(id);
      slot.resolve(record);
    }
  };

  const flush = () => {
    scheduled = false;
    const batch = queued;
    queued = new Map(); // anything asked while these requests are out waits for the next task
    const ids = [...batch.keys()];
    const runs = [];
    for (let i = 0; i < ids.length; i += cap) runs.push(settleChunk(ids.slice(i, i + cap), batch));
    return Promise.all(runs);
  };

  function load(rawId) {
    const id = Number(rawId);
    if (rawId == null || rawId === '' || !Number.isInteger(id) || id <= 0) return Promise.resolve(null);
    if (known.has(id)) return Promise.resolve(known.get(id));
    if (inFlight.has(id)) return inFlight.get(id);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    queued.set(id, { resolve });
    inFlight.set(id, promise);
    if (!scheduled) {
      scheduled = true;
      schedule(flush);
    }
    return promise;
  }

  return { load };
}
