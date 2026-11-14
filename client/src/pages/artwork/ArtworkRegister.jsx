// The artwork register — every artwork mail the office AVS files from the company mailbox, as jobs and versions
// (Artwork Manager P1; owner's brief of 14 Nov 2026). One row per job, carrying its latest version; a job opens to its
// whole history (ArtworkJob.jsx). This stage only shows what arrived: checks, proofs and approvals come later.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../../api.js';
import { Button, DataTable, useToast } from '../../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../../components/FilterChip.jsx';
import { RefreshCw } from 'lucide-react';
import ArtworkJob from './ArtworkJob.jsx';

export const VERSION_STATUS = {
  received: { label: 'Received', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  file_to_fetch: { label: 'File to fetch', cls: 'bg-amber-50 text-amber-800 ring-amber-600/30' },
  not_artwork: { label: 'Not artwork', cls: 'bg-slate-100 text-slate-500 ring-slate-400/30' },
};
export function VersionStatus({ status }) {
  const s = VERSION_STATUS[status] || { label: status, cls: 'bg-slate-100 text-slate-600 ring-slate-400/30' };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${s.cls}`}>{s.label}</span>;
}

const CHIPS = [
  { key: '', label: 'All' },
  { key: 'to_sort', label: 'To sort' },
  { key: 'file_to_fetch', label: 'File to fetch' },
];
const matches = (job, chip) => (chip === 'to_sort' ? job.to_sort : chip === 'file_to_fetch' ? job.latest.status === 'file_to_fetch' : true);

export default function ArtworkRegister({ focus }) {
  const toast = useToast();
  const [jobs, setJobs] = useState(null);
  const [chip, setChip] = useState('');
  const [openId, setOpenId] = useState(focus ? Number(focus) : null);

  // The toast and the close handler are read through refs: neither is a stable object, and a loader that depended on
  // them would run again on every render.
  const toastRef = useRef(toast); toastRef.current = toast;
  const load = useCallback(() => api.get('/artwork/register').then(r => setJobs(r.jobs)).catch(e => toastRef.current.error(e.message)), []);
  const closeJob = useCallback(() => setOpenId(null), []);
  useEffect(() => { load(); }, [load]);
  // AVS files four times a day; an open register picks a new run up without a reload.
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const counts = useMemo(() => Object.fromEntries(CHIPS.map(c => [c.key, (jobs || []).filter(j => matches(j, c.key)).length])), [jobs]);
  const rows = useMemo(() => (jobs || []).filter(j => matches(j, chip)), [jobs, chip]);

  const columns = [
    { key: 'job_no', label: 'Job', render: j => <span className="font-mono text-[13px] font-semibold">{j.job_no}</span> },
    { key: 'customer_name', label: 'Customer', render: j => j.customer_name || '—' },
    { key: 'client_item_code', label: 'Item code', render: j => (j.client_item_code ? <span className="font-mono text-[13px]">{j.client_item_code}</span> : '—') },
    { key: 'product_name', label: 'Product', render: j => (
      <div>
        <div className="font-semibold">{j.product_name || '—'}</div>
        <div className="text-[11px] text-slate-500">
          {[j.pack_type, j.to_sort ? 'to sort — not yet matched to a product' : !j.product_id ? 'not linked to a product yet' : null].filter(Boolean).join(' · ')}
        </div>
      </div>
    ) },
    { key: 'latest_label', label: 'Latest version', sortValue: j => j.latest.label, exportValue: j => j.latest.label, render: j => (
      <div>
        <span className="font-mono text-[13px] font-semibold">{j.latest.label}</span>
        {j.latest.variant === 'batch' && <span className="ml-1.5 text-[11px] text-slate-500">batch details</span>}
        {j.versions > 1 && <div className="text-[11px] text-slate-500">{j.versions} versions</div>}
      </div>
    ) },
    { key: 'status', label: 'Status', sortValue: j => j.latest.status, exportValue: j => VERSION_STATUS[j.latest.status]?.label ?? j.latest.status,
      render: j => <VersionStatus status={j.latest.status} /> },
    { key: 'received_at', label: 'Received', sortValue: j => new Date(j.latest.received_at).toISOString(), exportValue: j => fmt.date(j.latest.received_at),
      render: j => fmt.date(j.latest.received_at) },
    { key: 'waiting_days', label: 'Waiting', sortValue: j => j.waiting_days, render: j => `${j.waiting_days} d` },
  ];

  return (
    <div>
      <FilterRail className="mb-3">
        <FilterGroup label="Show">
          {CHIPS.map(c => (
            <FilterChip key={c.key || 'all'} label={c.label} on={chip === c.key} count={counts[c.key]} onClick={() => setChip(c.key)} />
          ))}
        </FilterGroup>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={load}><RefreshCw size={13} className="mr-1 inline" />Refresh</Button>
      </FilterRail>
      <DataTable searchable columns={columns} rows={rows} onRowClick={j => setOpenId(j.id)}
        defaultSort={{ key: 'received_at', dir: 'desc' }}
        exportName="Artwork register"
        empty={jobs == null ? 'Loading…' : chip ? 'Nothing under this chip.' : 'No artwork has been filed yet. The office AVS files artwork mails from the company mailbox on each of its runs.'} />
      <ArtworkJob jobId={openId} onClose={closeJob} onChanged={load} />
    </div>
  );
}
