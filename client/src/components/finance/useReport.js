// One report read, the way every Finance report screen asks for it:
//
//   const { data, failed, reload } = useReport(url, version);
//
// `url` is the GET to make, or null when there is nothing to ask yet (no ledger chosen, a period that ends before it starts).
// `data` is the answer FOR THAT URL, or null: an answer that came for another period, ledger or book is never handed back, so the
// figures on screen are always the figures of what the screen says it is showing. `failed` is true when the newest request for
// this url failed; `data` may still be the last answer, which the screen then says is old (LoadNotice). `reload()` asks again and
// answers with a promise, so a Retry button stays busy until it settles.
//
// It asks again when `version` moves (the Reports page bumps it after a voucher is changed from the detail) and when another login
// changes a Finance table (useRealtimeRefresh(load, FINANCE_TABLES)). Overlapping requests are settled by newestAnswerGate: an
// older answer never lands over a newer one, and a failure is not an answer, so it never pushes a good one aside.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import useRealtimeRefresh from '../../lib/useRealtimeRefresh.js';
import { newestAnswerGate } from '../../lib/newestAnswer.js';
import { FINANCE_TABLES } from '../../lib/finance/tables.js';
import { finReportShown } from '../../lib/finance/reports.js';

export default function useReport(url, version = 0) {
  const [answer, setAnswer] = useState({ url: null, data: null });
  const [failedUrl, setFailedUrl] = useState(null);
  const gate = useRef(null);
  const latest = useRef(0);
  if (!gate.current) gate.current = newestAnswerGate();

  const load = useCallback(async () => {
    if (!url) return;
    const seq = gate.current.begin();
    latest.current = seq;
    let data;
    try {
      data = await api.get(url);
    } catch {
      // The server's own sentence, when there is one, has reached the toast (api.js); the line above the table says it on the page.
      if (seq === latest.current) setFailedUrl(url);
      return;
    }
    if (!gate.current.accept(seq)) return;
    setAnswer({ url, data });
    // Only this request's own failure is cleared: a newer request for something else may have failed meanwhile, and must stay failed.
    setFailedUrl(failed => (failed === url ? null : failed));
  }, [url]);

  useEffect(() => { load(); }, [load, version]);
  useRealtimeRefresh(load, FINANCE_TABLES, { enabled: Boolean(url) });

  return { ...finReportShown({ answer, failedUrl }, url), reload: load };
}
