// Cutting Variances — the warehouse-facing register of every over/under-cut
// recorded at the cutting station. Read-only: the record is captured inline at
// the station; this is where it is reviewed, filtered and exported.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, KpiCard, KpiFilterNotice, PageHeader, rowMatches, useKpiFilter } from '../components/ui.jsx';
import { Scissors, AlertTriangle } from 'lucide-react';

const VARIANCE_KPI_ROWS = {
  over: r => +r.parent_delta > 0,
  under: r => +r.parent_delta < 0,
};
const VARIANCE_KPI_LABEL = {
  over: 'jobs that cut more parent sheets than planned',
  under: 'jobs that cut fewer parent sheets than planned',
};

export default function CuttingVariances() {
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');

  // Surface a load failure instead of swallowing it — a dead/unreachable backend
  // must NOT read as "no variances". A network reject fires no central toast
  // (unlike a 500), so this page owns showing the outage. Last-good rows are kept
  // on a transient blip; the 20s poll clears the flag on the next success.
  useEffect(() => {
    const load = () => api.get('/cutting-variances')
      .then(d => { setRows(d); setLoadError(false); })
      .catch(() => setLoadError(true));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const kpis = useMemo(() => ({
    count: rows.length,
    over: rows.filter(r => r.parent_delta > 0).length,
    under: rows.filter(r => r.parent_delta < 0).length,
    net: rows.reduce((s, r) => s + (r.parent_delta || 0), 0),
  }), [rows]);

  const searched = useMemo(() => (q ? rows.filter(r => rowMatches(r, q)) : rows), [rows, q]);
  // Over- and under-cut are the two halves of the same list, so a card selects
  // one of them by the same sign test the KPI counted with.
  const kpi = useKpiFilter('variances');
  const filtered = kpi.apply(searched, VARIANCE_KPI_ROWS);

  return (
    <div>
      <PageHeader title="Cutting Variances"
        subtitle="Every time cutting recorded more or fewer sheets than the job card — with reason and warehouse impact" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={Scissors} label="Variances" value={fmt.num(kpis.count)} />
        <KpiCard icon={AlertTriangle} label="Over-cut" value={fmt.num(kpis.over)}
          onClick={() => kpi.toggle('over')} active={kpi.is('over')} />
        <KpiCard icon={AlertTriangle} label="Under-cut" value={fmt.num(kpis.under)}
          onClick={() => kpi.toggle('under')} active={kpi.is('under')} />
        <KpiCard label="Net parent sheets" value={`${kpis.net > 0 ? '+' : ''}${fmt.num(kpis.net)}`} />
      </div>
      <KpiFilterNotice filter={kpi} label={VARIANCE_KPI_LABEL[kpi.key]}
        shown={filtered.length} total={searched.length} />
      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the cutting variances can’t load'}. Retrying every 20 seconds…
        </div>
      )}
      {/* Search rides in the table toolbar (left, beside Export) — the page
          no longer floats a half-empty band above the table just to hold it. */}
      <div className="mt-3">
      <DataTable
        exportName="cutting-variances"
        searchValue={q} onSearchChange={setQ}
        searchPlaceholder="Search JC, product, reason…"
        rows={filtered}
        empty={loadError ? 'Server unreachable — nothing to show until it reconnects.' : 'No cutting variances recorded.'}
        columns={[
          { key: 'created_at', label: 'When', export: r => fmt.date(r.created_at), render: r => fmt.date(r.created_at) },
          { key: 'jc_number', label: 'Job Card' },
          { key: 'product_name', label: 'Product', render: r => <span>{r.product_name} <span className="text-slate-400">{r.product_code}</span></span> },
          { key: 'planned_parents', label: 'Card parents', align: 'right', export: r => fmt.num(r.planned_parents), render: r => fmt.num(r.planned_parents) },
          { key: 'actual_parents', label: 'Cut parents', align: 'right', export: r => fmt.num(r.actual_parents), render: r => fmt.num(r.actual_parents) },
          { key: 'parent_delta', label: 'Δ', align: 'right',
            export: r => `${r.parent_delta > 0 ? '+' : ''}${r.parent_delta}`,
            render: r => <span className={r.parent_delta > 0 ? 'font-semibold text-red-600' : 'font-semibold text-emerald-600'}>{r.parent_delta > 0 ? '+' : ''}{fmt.num(r.parent_delta)}</span> },
          { key: 'board_name', label: 'Board' },
          { key: 'reason_code', label: 'Reason' },
          { key: 'note', label: 'Note', render: r => r.note || '—' },
          { key: 'created_by', label: 'By' },
        ]}
      />
      </div>
    </div>
  );
}
