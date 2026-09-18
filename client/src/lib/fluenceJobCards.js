// Which Fluence products a job card carries — for boards whose cards name only a
// LEAD product. A gang or combined-run card prints every member line's carton,
// and a mixed run can lead with another customer's product, so the card's own
// product_id cannot say whether it is Fluence, nor which cartons to open.
//
// Every card asking in the same render pass is answered by ONE request, and the
// answer is kept for a few minutes: a board of 30 cards costs one call, not 30.
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const TTL_MS = 5 * 60 * 1000;
const CHUNK = 200;             // the server's per-request ceiling
const cache = new Map();       // job card id → { at, ids }
const waiting = new Map();     // job card id → [callbacks]
let timer = null;

function flush() {
  timer = null;
  const pending = new Map(waiting);
  waiting.clear();
  const ids = [...pending.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    api.get(`/fluence/job-cards/products?ids=${chunk.join(',')}`)
      .then(out => {
        for (const id of chunk) {
          const found = (out?.products?.[id] || []).map(Number);
          cache.set(id, { at: Date.now(), ids: found });
          pending.get(id).forEach(fn => fn(found));
        }
      })
      // A failed lookup answers "unknown", never "not Fluence" — the caller
      // keeps whatever it could tell from the card itself.
      .catch(() => { for (const id of chunk) pending.get(id).forEach(fn => fn(null)); });
  }
}

export function loadJobCardFluenceProducts(jobCardId) {
  const id = Number(jobCardId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.ids);
  return new Promise(resolve => {
    if (!waiting.has(id)) waiting.set(id, []);
    waiting.get(id).push(resolve);
    if (!timer) timer = setTimeout(flush, 0);
  });
}

// null while unknown (or when not asked); otherwise the Fluence product ids, in
// the run's own line order.
export function useJobCardFluenceProducts(jobCardId, enabled) {
  const id = jobCardId == null ? null : Number(jobCardId);
  const [found, setFound] = useState(null);   // { id, ids } — tagged, so a reused component never shows another card's answer
  useEffect(() => {
    if (!enabled || id == null) return undefined;
    let live = true;
    loadJobCardFluenceProducts(id).then(ids => { if (live && ids) setFound({ id, ids }); });
    return () => { live = false; };
  }, [id, enabled]);
  if (!enabled || id == null) return null;
  if (found?.id === id) return found.ids;
  return cache.get(id)?.ids ?? null;
}
