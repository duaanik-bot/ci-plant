// A list a screen loads when it is needed, with a status every reader can trust.
//
// Built for the product master on Orders (/products, ~1,847 KB): every reader of
// it lives inside a form, so the order list stopped fetching it before first
// paint. Loading late is only safe if an UNLOADED list can never pass for an
// empty one — a code suggestion or a match run over [] is confidently wrong
// (a code another product already owns; every PO line "No match" and a
// duplicate master offered). So the list says what it is:
//
//   idle     nothing asked yet            rows = []
//   loading  first fetch out             rows = []
//   ready    rows are a real answer       (refreshing = a newer copy is out)
//   error    first fetch failed          rows = []  — the next ensure() retries
//
// Once ready it stays ready: a stale mark or a failed refresh keeps the last good
// rows on screen rather than blanking a picker someone is using.
//
// Pure (no React) so every rule is a unit test: orders-products-on-demand.test.js.
export function createOnDemandList(fetchRows) {
  let state = { status: 'idle', rows: [], stale: false, refreshing: false, error: null };
  let inFlight = null;
  let generation = 0; // bumped by markStale; a fetch that started before a bump is stale on arrival
  const subscribers = new Set();

  const emit = patch => {
    state = { ...state, ...patch };
    for (const fn of subscribers) fn(state);
  };

  function load() {
    if (inFlight) return inFlight;
    const startedAt = generation;
    const refreshing = state.status === 'ready';
    emit(refreshing ? { refreshing: true } : { status: 'loading', error: null });
    let request;
    try { request = Promise.resolve(fetchRows()); } catch (e) { request = Promise.reject(e); }
    inFlight = request
      .then(rows => {
        if (!Array.isArray(rows)) throw new Error('The product list did not come back as a list');
        inFlight = null;
        emit({ status: 'ready', rows, stale: generation !== startedAt, refreshing: false, error: null });
        return rows;
      })
      .catch(error => {
        inFlight = null;
        if (refreshing) {
          emit({ refreshing: false, stale: true });
          return state.rows;
        }
        emit({ status: 'error', error });
        throw error;
      });
    return inFlight;
  }

  return {
    get state() { return state; },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    // Memoised: a ready, fresh list answers at once; a list already on its way
    // is shared; anything else is fetched.
    ensure() {
      if (state.status === 'ready' && !state.stale) return Promise.resolve(state.rows);
      return load();
    },
    // Something changed the table. Nothing is fetched now — the next form that
    // opens asks again, and whatever is on screen stays until the new copy lands.
    markStale() {
      generation++;
      if (state.status === 'ready' && !state.stale) emit({ stale: true });
    },
    // We just wrote to it ourselves (quick-create, import): fetch now.
    refresh() {
      generation++;
      if (state.status === 'ready') emit({ stale: true });
      // Queue behind a fetch already out, whichever way it ends: a first load
      // that fails must not swallow the refresh a quick-create just asked for.
      if (inFlight) return inFlight.catch(() => {}).then(() => load());
      return load();
    },
  };
}

// Run `fn` once the browser is idle — after the screen has painted, before the
// user reaches for a form. Older tablet Safari has no requestIdleCallback, so it
// falls back to a plain delay. Returns a cancel function for effect cleanup.
export function scheduleIdle(fn, { timeout = 2000, fallbackMs = 800, env = globalThis } = {}) {
  if (typeof env.requestIdleCallback === 'function') {
    const handle = env.requestIdleCallback(() => fn(), { timeout });
    return () => env.cancelIdleCallback?.(handle);
  }
  const handle = env.setTimeout(fn, fallbackMs);
  return () => env.clearTimeout?.(handle);
}
