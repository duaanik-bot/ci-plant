// Track — pick any order line and see its whole life:
// SO → planning → artwork → every production stage → FG → challans.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { ExportMenu, PageHeader, rowMatches, SearchInput, StatusBadge, Tabs } from '../components/ui.jsx';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleDashed, Loader2, FileText, PackageCheck, Link2, Layers, Scissors, Truck } from 'lucide-react';
import { GangChip } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';

function ProgressPill({ row }) {
  if (row.status === 'dispatched') return <StatusBadge status="dispatched" />;
  if (row.current_stage) return <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
    <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />{fmt.stage(row.current_stage)}
  </span>;
  if (row.jc_number && row.next_stage) return <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">queue · {fmt.stage(row.next_stage)}</span>;
  return <StatusBadge status={row.status} />;
}

// The full order-line life, in travel order — every status a line can wear on
// its way to the gate (the schema's vocabulary minus `cancelled`, which the
// server already keeps out of /track). One chip each, so "what's sitting in
// Planned?" is one tap instead of a hunt through the In-Progress pile.
const LINE_STATUSES = ['pending', 'planned', 'ready', 'in_production', 'produced', 'dispatched'];

export default function Track() {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [journey, setJourney] = useState(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');

  useEffect(() => { api.get('/track').then(r => { setRows(r); if (r.length && !selected) setSelected(r[0].id); }); }, []);
  useEffect(() => {
    if (!selected) return;
    setJourney(null);
    api.get(`/track/${selected}`).then(setJourney);
  }, [selected]);

  const counts = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);
  const filtered = useMemo(() => {
    const base = tab === 'all' ? rows : rows.filter(r => r.status === tab);
    if (!q) return base;
    return base.filter(r => rowMatches(r, q, productSearchText(r)));
  }, [rows, tab, q]);

  const pct = journey ? Math.round(100 * journey.events.filter(e => e.state === 'done').length / journey.events.length) : 0;

  return (
    <div>
      <PageHeader title="Track" subtitle="Follow any product from sales order to the customer's gate"
        actions={<ExportMenu build={() => ({
          name: 'Order Tracking',
          title: 'Order Tracking',
          subtitle: `Track · ${tab === 'all' ? 'All' : fmt.title(tab)} order lines${journey ? ` + journey of ${journey.line.product_name}` : ''}`,
          meta: [q ? `Search: "${q}"` : null],
          sections: [
            {
              heading: `${tab === 'all' ? 'All' : fmt.title(tab)} Lines`,
              columns: [
                { key: 'product_name', label: 'Product', export: productExport },
                { key: 'customer_name', label: 'Customer / PO', export: r => `${r.customer_name} · PO ${r.po_number}` },
                { key: 'jc_number', label: 'Job Card', export: r => r.jc_number || '—' },
                { key: 'qty', label: 'Ordered', align: 'right', export: r => fmt.num(r.qty) },
                { key: 'dispatched_qty', label: 'Dispatched', align: 'right', export: r => fmt.num(r.dispatched_qty) },
                { key: 'status', label: 'Status', export: r => fmt.title(r.status) },
              ],
              rows: filtered,
            },
            ...(journey ? [{
              heading: `Journey — ${journey.line.product_name} · PO ${journey.line.po_number} (${pct}% complete)`,
              columns: [
                { key: 'title', label: 'Milestone' },
                { key: 'state', label: 'State', export: e => fmt.title(e.state) },
                { key: 'at', label: 'When', export: e => (e.at ? fmt.dt(e.at) : '—') },
                { key: 'by', label: 'By', export: e => e.by || '—' },
                { key: 'detail', label: 'Detail', export: e => e.detail || '—' },
              ],
              rows: journey.events,
            }] : []),
          ],
        })} />} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'all', label: 'All', count: rows.length },
        ...LINE_STATUSES.map(s => ({ key: s, label: fmt.title(s), count: counts[s] || 0 })),
      ]} />

      <div className="grid gap-4 lg:grid-cols-[380px,1fr]">
        {/* Line picker */}
        <div className="overflow-hidden rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl shadow-card">
          <div className="border-b border-slate-100 p-3">
            <SearchInput value={q} onChange={setQ} placeholder="PO, product, customer, JC…" />
          </div>
          <div className="max-h-[70vh] divide-y divide-slate-50 overflow-y-auto">
            {filtered.map(r => (
              <div key={r.id} role="button" tabIndex={0}
                onClick={() => setSelected(r.id)}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelected(r.id); }}
                className={`block w-full cursor-pointer px-4 py-3 text-left transition-colors ${selected === r.id ? 'bg-brand-50/70' : 'hover:bg-slate-50'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProductIdentity row={r} compact className="min-w-0" codesClassName="max-w-[230px]" />
                    {r.gang_number && (r.run_kind === 'merge' ? <MergeChip number={r.gang_number} /> : <GangChip number={r.gang_number} />)}
                  </span>
                  <ProgressPill row={r} />
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-slate-500">
                  <span className="truncate">{r.customer_name} · PO {r.po_number}</span>
                  <span className="tabular-nums">{fmt.num(r.dispatched_qty)}/{fmt.num(r.qty)}</span>
                </div>
              </div>
            ))}
            {filtered.length === 0 && <p className="px-4 py-10 text-center text-sm text-slate-400">No matching lines</p>}
          </div>
        </div>

        {/* Journey */}
        <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-5 shadow-card">
          {!journey ? (
            <div className="py-24 text-center text-sm text-slate-400">Loading journey…</div>
          ) : (
            <>
              {/* Header card */}
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <ProductIdentity row={journey.line}
                      nameClassName="text-lg font-extrabold tracking-tight text-slate-900" />
                    <StatusBadge status={journey.line.status} />
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {journey.line.customer_name}, {journey.line.city} · PO {journey.line.po_number}
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

              {/* Run ribbon — a GANG shares the sheet up to die cutting and then
                  becomes its own carton job; a COMBINED RUN is one identical
                  pile that never splits and is divided per sales order at
                  dispatch. Two different promises, so two different ribbons. */}
              {journey.line.gang_number && (
                journey.line.run_kind === 'merge' ? (
                  <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-teal-200/70 bg-teal-50/60 px-3.5 py-2.5 text-xs font-semibold text-teal-800">
                    <Layers size={13} />
                    <span>Combined Run {journey.line.gang_number} — runs as one job through every stage</span>
                    <span className="inline-flex items-center gap-1 text-teal-600">
                      <Truck size={12} /> allocated back to this sales order at dispatch
                    </span>
                  </div>
                ) : (
                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-200/70 bg-violet-50/60 px-3.5 py-2.5 text-xs font-semibold text-violet-800">
                  <Link2 size={13} />
                  <span>Gang {journey.line.gang_number} — travels with the gang as one job</span>
                  <span className="inline-flex items-center gap-1 text-violet-500">
                    <Scissors size={12} /> separates into its own cartons after die cutting
                  </span>
                </div>
                )
              )}

              {/* Timeline */}
              <ol className="relative ml-3 space-y-0 border-l-2 border-slate-100">
                {journey.events.map(ev => (
                  <li key={ev.key} className="relative pb-5 pl-6 last:pb-0">
                    <span className={`absolute -left-[11px] top-0 flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-white ${
                      ev.gang_shared
                        ? (ev.state === 'done' ? 'bg-violet-500 text-white'
                          : ev.state === 'active' ? 'bg-violet-400 text-white'
                          : 'bg-violet-100 text-violet-400')
                        : ev.state === 'done' ? 'bg-emerald-500 text-white'
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
