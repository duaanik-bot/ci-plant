import { useEffect, useRef } from 'react';
import { subscribeToDbChanges } from './realtime.js';

export default function useRealtimeRefresh(load, tables, { debounceMs = 350, enabled = true } = {}) {
  const loadRef = useRef(load);
  const inFlight = useRef(false);
  const tableKey = Array.isArray(tables) ? tables.join('|') : tables || '*';

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    let pending = false;

    const isVisible = () => typeof document === 'undefined' || !document.hidden;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    };
    const run = () => {
      if (!isVisible()) return;
      if (inFlight.current) {
        pending = true;
        return;
      }
      pending = false;
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
        .finally(() => {
          inFlight.current = false;
          if (pending && isVisible()) schedule();
        });
    };
    const unsubscribe = subscribeToDbChanges(() => {
      pending = true;
      if (isVisible()) schedule();
    }, { tables });
    const wake = () => {
      if (pending && isVisible()) schedule();
    };
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);
      window.addEventListener('online', wake);
    }
    return () => {
      clearTimeout(timer);
      unsubscribe();
      if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
        window.removeEventListener('online', wake);
      }
    };
  }, [debounceMs, enabled, tableKey]);
}
