import { useEffect, useRef } from 'react';

export default function useFallbackRefresh(load, {
  enabled = true,
  intervalMs = 60000,
  loadOnMount = true,
  visibleOnly = true,
  wakeOnFocus = true,
} = {}) {
  const loadRef = useRef(load);
  const inFlight = useRef(false);

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    const isVisible = () => !visibleOnly || typeof document === 'undefined' || !document.hidden;
    const run = () => {
      if (cancelled || inFlight.current || !isVisible()) return;
      inFlight.current = true;
      let result;
      try {
        result = loadRef.current();
      } catch {
        inFlight.current = false;
        return;
      }
      Promise.resolve(result)
        .catch(() => {})
        .finally(() => { inFlight.current = false; });
    };

    if (loadOnMount) run();
    const timer = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    const wake = () => run();

    if (wakeOnFocus && typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);
      window.addEventListener('online', wake);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (wakeOnFocus && typeof document !== 'undefined' && typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
        window.removeEventListener('online', wake);
      }
    };
  }, [enabled, intervalMs, loadOnMount, visibleOnly, wakeOnFocus]);
}
