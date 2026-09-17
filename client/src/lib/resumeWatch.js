// Tells the response cache when the device may have been away: slept, lost the
// network, or had its tab frozen. In each case the realtime socket can be dead
// without realtime-js having noticed yet, so what it would have announced
// meanwhile may be lost (responseCache rule 7).
//
// Signals, any one of which counts:
//   • the page lifecycle `resume` event (a frozen tab thawed);
//   • `online` (the network came back) and a `pageshow` restored from bfcache;
//   • the tab becoming visible after being hidden longer than GAP_MS;
//   • a timer tick arriving GAP_MS or more late — timers stop while a device
//     sleeps, whatever the page visibility says.
// A false alarm costs one round of network requests, never a stale screen.
export const TICK_MS = 5 * 1000;
export const GAP_MS = 20 * 1000;

export function watchResume({
  win = globalThis.window,
  doc = globalThis.document,
  now = () => Date.now(),
  onResume,
  tickMs = TICK_MS,
  gapMs = GAP_MS,
  every = (fn, ms) => setInterval(fn, ms),
} = {}) {
  if (!win || !doc || typeof onResume !== 'function') return () => {};
  let lastTick = now();
  let hiddenAt = doc.visibilityState === 'hidden' ? now() : null;
  const fire = () => onResume();

  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') { hiddenAt = now(); return; }
    if (hiddenAt != null && now() - hiddenAt >= gapMs) fire();
    hiddenAt = null;
  };
  const onPageShow = e => { if (e && e.persisted) fire(); };

  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('resume', fire);
  win.addEventListener('online', fire);
  win.addEventListener('pageshow', onPageShow);
  const timer = every(() => {
    const t = now();
    if (t - lastTick >= gapMs) fire();
    lastTick = t;
  }, tickMs);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.removeEventListener('resume', fire);
    win.removeEventListener('online', fire);
    win.removeEventListener('pageshow', onPageShow);
    clearInterval(timer);
  };
}
