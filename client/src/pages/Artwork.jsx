// Artwork — two approvals, one lock. Both ticks = locked, automatically.
// No parallel approval systems, no dead reject buttons.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, PageHeader, StatusBadge, useToast } from '../components/ui.jsx';
import { Lock, LockOpen } from 'lucide-react';

function Toggle({ on, onClick, label }) {
  return (
    <button onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs font-semibold transition-colors ${
        on ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
      {on ? '✓ ' : ''}{label}
    </button>
  );
}

export default function Artwork() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const load = () => api.get('/artwork').then(setLines);
  useEffect(() => { load(); }, []);

  const setApproval = async (l, patch) => {
    const updated = await api.post(`/order-lines/${l.id}/artwork`, patch);
    if (updated.artwork_locked && !l.artwork_locked) toast.success(`Artwork locked for ${l.product_name}`);
    load();
  };

  return (
    <div>
      <PageHeader title="Artwork Queue" subtitle="Customer approval + QA shade/text approval → artwork locks automatically" />
      <DataTable searchable
        columns={[
          { key: 'po_number', label: 'PO / Customer', render: l => (<div><div className="font-semibold">{l.po_number}</div><div className="text-xs text-gray-500">{l.customer_name}</div></div>) },
          { key: 'product_name', label: 'Product', render: l => (<div><div>{l.product_name}</div><div className="text-xs text-gray-400">{l.product_code} · {l.colors} colours{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}</div></div>) },
          { key: 'planned_date', label: 'Planned', render: l => fmt.date(l.planned_date) },
          { key: 'appr', label: 'Approvals', render: l => (
            <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
              <Toggle on={!!l.artwork_customer_ok} label="Customer" onClick={() => setApproval(l, { customer_ok: !l.artwork_customer_ok, qa_ok: !!l.artwork_qa_ok })} />
              <Toggle on={!!l.artwork_qa_ok} label="QA Shade/Text" onClick={() => setApproval(l, { customer_ok: !!l.artwork_customer_ok, qa_ok: !l.artwork_qa_ok })} />
            </div>) },
          { key: 'lock', label: 'Lock', render: l => l.artwork_locked
              ? <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600"><Lock size={13} /> Locked</span>
              : <span className="inline-flex items-center gap-1 text-xs text-gray-400"><LockOpen size={13} /> Open</span> },
          { key: 'status', label: 'Line Status', render: l => <StatusBadge status={l.status} /> },
        ]}
        rows={lines} empty="No lines in the artwork queue" />
    </div>
  );
}
