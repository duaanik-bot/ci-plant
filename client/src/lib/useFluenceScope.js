// Which products and customers the Fluence prescription & kit master is switched
// on for — fetched ONCE per page session and shared by every Fluence button.
//
// A row decides for itself whether to offer its Fluence door by asking this set
// about the product ids it already carries. No existing endpoint had to grow a
// column for it, and a non-Fluence row renders exactly what it rendered before.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const TTL_MS = 5 * 60 * 1000;
let cached = null;      // { at, value }
let inflight = null;
const listeners = new Set();

export function loadFluenceScope({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  inflight = api.get('/fluence/scope')
    .then(value => {
      cached = { at: Date.now(), value };
      listeners.forEach(fn => fn(value));
      return value;
    })
    .catch(() => ({ enabled: false, can_edit: false, customer_ids: [], product_ids: [] }))
    .finally(() => { inflight = null; });
  return inflight;
}

export function scopeFrom(value) {
  const products = new Set((value?.product_ids || []).map(Number));
  const customers = new Set((value?.customer_ids || []).map(Number));
  return {
    ready: Boolean(value),
    enabled: Boolean(value?.enabled),
    canEdit: Boolean(value?.can_edit),
    isProduct: id => id != null && products.has(Number(id)),
    isCustomer: id => id != null && customers.has(Number(id)),
    // The Fluence ids among these, first-seen order, no repeats.
    fluenceIds: ids => [...new Set((ids || []).filter(v => v != null).map(Number))].filter(id => products.has(id)),
  };
}

export function useFluenceScope() {
  const [value, setValue] = useState(cached?.value ?? null);
  useEffect(() => {
    let live = true;
    const onValue = v => { if (live) setValue(v); };
    listeners.add(onValue);
    loadFluenceScope().then(onValue);
    return () => { live = false; listeners.delete(onValue); };
  }, []);
  return useMemo(() => scopeFrom(value), [value]);
}
