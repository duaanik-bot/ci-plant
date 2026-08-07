import { useEffect, useRef } from 'react';
import { subscribeToDbChanges } from './realtime.js';

export default function useRealtimeRefresh(load, tables, { debounceMs = 350, enabled = true } = {}) {
  const loadRef = useRef(load);
  const tableKey = Array.isArray(tables) ? tables.join('|') : tables || '*';

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    const unsubscribe = subscribeToDbChanges(() => {
      clearTimeout(timer);
      timer = setTimeout(() => loadRef.current(), debounceMs);
    }, { tables });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [debounceMs, enabled, tableKey]);
}
