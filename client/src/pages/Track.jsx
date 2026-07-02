// Track — pick any order line and see its whole life:
// SO → planning → artwork → every production stage → FG → challans.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { PageHeader, SearchInput, StatusBadge } from '../components/ui.jsx';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleDashed, Loader2, FileText, PackageCheck } from 'lucide-react';

function ProgressPill({ row }) {
  if (row.status === 'dispatched') return <StatusBadge status="dispatched" />;
  if (row.current_stage) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
    <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />{fmt.stage(row.current_stage)}
  </span>;
  if (row.jc_number && row.next_stage) return <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">queue · {fmt.stage(row.next_stage)}</span>;
  return <StatusBadge status={row.status} />;
}

export default function Track() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [journey, setJourney] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => { api.get('/track').then(r => { setRows(r); if (r.length && !selected) setSelected(r[0].id); }); }, []);
  useEffect(() => {
    if (!selected) return;
    setJourney(null);
    api.get(`/track/${selected}`).then(setJourney);
  }, [selected]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const s = q.toLowerCase();
    return rows.filter(r => [r.po_number, r.customer_name, r.product_name, r.product_code, r.jc_number]
      .some(v => (v || '').toLowerCase().includes(s)));
  }, [rows, q]);

  const pct = journey ? Math.round(100 * journey.events.filter(e => e.state === 'done').length / journey.events.length) : 0;

  return (
    <div>
      <PageHeader title="Track" subtitle="Follow any product from sales order to the customer's gate" />

      <div className="grid gap-4 lg:grid-cols-[380px,1fr]">
        {/* Line picker */}
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
          <div className="border-b border-slate-100 p-3">
            <SearchInput value={q} onChange={setQ} placeholder="PO, product, customer, JC…" />
          </div>
          <div className="max-h-[70vh] divide-y divide-slate-50 overflow-y-auto">
            {filtered.map(r => (
              <button key={r.id} onClick={() => setSelected(r.id)}
                className={`block w-full px-4 py-3 text-left transition-colors ${selected === r.id ? 'bg-brand-50/70' : 'hover:bg-slate-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-bold text-slate-900">{r.product_name}</span>
                  <ProgressPill row={r} />
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-slate-500">
                  <span className="truncate">{r.customer_name} · PO {r.po_number}</span>
                  <span className="tabular-nums">{fmt.num(r.dispatched_qty)}/{fmt.num(r.qty)}</span>
                </div>
              </button>
            ))}
            {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No matching lines</p>}
          </div>
        </div>

        {/* Journey */}
        <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-card">
          {!journey ? (
            <div className="py-24 text-center text-sm text-slate-400">Loading journey…</div>
          ) : (
            <>
              {/* Header card */}
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{journey.line.product_name}</h2>
                    <StatusBadge status={journey.line.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {journey.line.product_code} · {journey.line.customer_name}, {journey.line.city} · PO {journey.line.po_number}
                    {journey.line.delivery_date && <> · delivery {fmt.date(journey.line.delivery_date)}</>}
                  </div>
                </div>
                <div className="flex gap-5 text-right">
                  <div>
                    <div className="text-lg font-extrabold tabular-nums text-slate-900">{fmt.num(journey.line.qty)}</div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">ordered</div>
                  </div>
                  <div>
                    <div className="text-lg font-extrabold tabular-nums text-emerald-600">{fmt.num(journey.line.dispatched_qty)}</div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">dispatched</div>
                  </div>
                  <div>
                    <div className="text-lg font-extrabold tabular-nums text-brand-600">{pct}%</div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">journey</div>
                  </div>
                </div>
              </div>

              {/* Timeline */}
              <ol className="relative ml-3 space-y-0 border-l-2 border-slate-100">
                {journey.events.map(ev => (
                  <li key={ev.key} className="relative pb-5 pl-6 last:pb-0">
                    <span className={`absolute -left-[11px] top-0 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-white ${
                      ev.state === 'done' ? 'bg-emerald-500 text-white'
                        : ev.state === 'active' ? 'bg-amber-400 text-white'
                        : 'bg-slate-200 text-slate-400'}`}>
                      {ev.state === 'done' ? <CheckCircle2 size={12} />
                        : ev.state === 'active' ? <Loader2 size={12} className="animate-spin" />
                        : <CircleDashed size={12} />}
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className={`text-sm font-bold ${ev.state === 'todo' ? 'text-slate-400' : 'text-slate-900'}`}>
                        {ev.title}
                        {ev.dispatch_id && (
                          <Link to={`/dispatch/challan/${ev.dispatch_id}`}
                            className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline">
                            <FileText size={11} /> challan
                          </Link>
                        )}
                      </span>
                      <span className="text-[11px] tabular-nums text-slate-400">
                        {ev.at ? fmt.dt(ev.at) : ''}{ev.by ? ` · ${ev.by}` : ''}
                      </span>
                    </div>
                    <div className={`mt-0.5 text-xs ${ev.state === 'todo' ? 'text-slate-400' : 'text-slate-600'}`}>{ev.detail}</div>
                  </li>
                ))}
              </ol>

              {journey.line.status === 'dispatched' && (
                <div className="mt-5 flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                  <PackageCheck size={16} /> Fully dispatched — journey complete.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
