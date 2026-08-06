// Dispatch & Invoice — one module for the whole finished-goods-out flow:
// Ready to Dispatch → Dispatch Register → Invoices. Each stage keeps its own
// forms with edit + reverse controls (cancel a challan back to FG, push an
// invoice line back to FG / leftover). The heavy lifting stays in the two
// underlying pages, embedded here so nothing is duplicated.
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Tabs } from '../components/ui.jsx';
import Dispatch from './Dispatch.jsx';
import Invoices from './Invoices.jsx';

export default function DispatchInvoice() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'ready';
  const setTab = t => setParams(t === 'ready' ? {} : { tab: t }, { replace: true });

  // The Shortage tab carries its own count so the zone is visible — and
  // findable — before anything is in it. A tab that only appears once there is
  // a problem is a tab nobody knows exists until the day it matters.
  const [shortCount, setShortCount] = useState(0);
  useEffect(() => {
    api.get('/dispatch/shortages').then(r => setShortCount(r.length)).catch(() => {});
  }, [tab]);

  return (
    <div>
      <PageHeader title="Dispatch & Invoice"
        subtitle="Finished goods out — dispatch, challan register and GST billing, with edit and reverse at every stage" />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'ready', label: 'Ready to Dispatch' },
        { key: 'shortage', label: 'Shortage', count: shortCount, tone: shortCount > 0 ? 'danger' : undefined },
        { key: 'register', label: 'Dispatch Register' },
        { key: 'invoices', label: 'Invoices' },
      ]} />

      {/* Dispatch stays mounted across the two dispatch views so switching
          Ready ↔ Register doesn't reload or drop an open challan form. */}
      {tab !== 'invoices' && <Dispatch embedded view={tab} onShortCount={setShortCount} />}
      {tab === 'invoices' && <Invoices embedded />}
    </div>
  );
}
