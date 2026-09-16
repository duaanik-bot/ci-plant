// How long a screen waits before refetching after a change somewhere in the plant.
//
// Every open screen hears the same database-change broadcast at the same moment.
// With a fixed debounce they all refetched together — six screens asking the
// database for their whole page in one millisecond — and the combined work pegged
// the 2-core database, so every request in the plant queued behind it. Measured on
// live prod 2026-09-16: Planning 431 ms alone, 1,027 ms with six screens at once;
// the Live Floor badge 65 ms alone, 1,039 ms.
//
// Each wait now gets its own random share of a short window on top of the
// debounce. The same refreshes still happen; they arrive spread over about a
// second instead of stacked on one instant. A screen's OWN save still reloads
// straight away — that path calls load() directly and never comes through here.
export const REFRESH_JITTER_MS = 1200;

export function refreshDelay(debounceMs, random = Math.random) {
  const base = Number.isFinite(+debounceMs) && +debounceMs > 0 ? +debounceMs : 0;
  return base + Math.floor(random() * REFRESH_JITTER_MS);
}
