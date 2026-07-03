import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { KpiCard, PageHeader, StatusBadge } from '../components/ui.jsx';
import { AlertTriangle, TrendingUp, Truck, Layers, Factory, Percent, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function Dashboard() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api.get('/dashboard').then(x => live && setD(x));
    load();
    const t = setInterval(load, 15000); // live, no refresh button
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!d) return <div className="py-20 text-center text-sm text-gray-400">Loading…</div>;

  const stageOrder = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc'];
  const wipMap = Object.fromEntries(d.wip_by_stage.map(s => [s.stage, s.n]));

  return (
    <div>
      <PageHeader title="Command Centre" subtitle="Live view of the plant — updates automatically" />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Orders in Hand" value={fmt.inr(d.orders_in_hand.value)} sub={`${d.orders_in_hand.lines} lines · ${fmt.num(d.orders_in_hand.qty)} cartons`} icon={Layers} />
        <KpiCard label="Jobs on Floor" value={d.wip_jobs} sub="open job cards" icon={Factory} accent="text-amber-600" />
        <KpiCard label="Produced (Month)" value={fmt.num(d.produced_month)} sub="cartons" icon={TrendingUp} accent="text-emerald-600" />
        <KpiCard label="Scrap % (Month)" value={`${d.scrap_pct}%`} sub="across all stages" icon={Percent} accent={d.scrap_pct > 3 ? 'text-red-600' : 'text-gray-900'} />
        <KpiCard label="Ready to Dispatch" value={fmt.inr(d.ready_dispatch.value)} sub={`${d.ready_dispatch.lines} lines`} icon={Truck} accent="text-violet-600" />
        <KpiCard label="On-Time (Month)" value={d.on_time_pct == null ? '—' : `${d.on_time_pct}%`}
          sub={d.on_time_pct == null ? 'no dispatches yet' : 'of dispatches vs delivery date'} icon={Clock}
          accent={d.on_time_pct == null ? 'text-gray-900' : d.on_time_pct >= 90 ? 'text-emerald-600' : d.on_time_pct >= 70 ? 'text-amber-600' : 'text-red-600'} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {/* WIP by stage */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-gray-900">Work-in-Progress by Stage</h3>
          <div className="space-y-2">
            {stageOrder.map(s => (
              <div key={s} className="flex items-center gap-3">
                <span className="w-24 text-xs font-medium text-gray-500">{fmt.stage(s)}</span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-gray-100">
                  <div className="h-full rounded bg-brand-500 transition-all"
                    style={{ width: `${Math.min(100, (wipMap[s] || 0) * 33)}%` }} />
                </div>
                <span className="w-6 text-right text-sm font-bold tabular-nums">{wipMap[s] || 0}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Alerts */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-gray-900">Needs Attention</h3>
          {d.alerts.length === 0 && <p className="text-sm text-gray-400">All clear. Nothing pending.</p>}
          <ul className="space-y-2">
            {d.alerts.map((a, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <AlertTriangle size={13} className={`mt-0.5 shrink-0 ${a.type === 'shortage' ? 'text-red-500' : a.type === 'due' ? 'text-amber-500' : 'text-blue-500'}`} />
                {a.text}
              </li>
            ))}
          </ul>
        </div>

        {/* Machines */}
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-gray-900">Machines</h3>
          <ul className="space-y-1.5">
            {d.machines.map(m => (
              <li key={m.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-gray-50">
                <div>
                  <div className="text-xs font-semibold text-gray-800">{m.name}</div>
                  <div className="text-[11px] capitalize text-gray-400">{m.type.replace('_', ' ')}</div>
                </div>
                <div className="flex items-center gap-2">
                  {m.active_jobs > 0 && <span className="text-[11px] font-bold text-amber-600">{m.active_jobs} job{m.active_jobs > 1 ? 's' : ''}</span>}
                  <StatusBadge status={m.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* MES panel — bottleneck, machine utilisation, operator productivity */}
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-slate-900">Bottleneck — WIP by section</h3>
          {(!d.bottleneck || d.bottleneck.length === 0) && <p className="text-sm text-slate-400">No work in progress.</p>}
          {(() => { const mx = Math.max(1, ...(d.bottleneck || []).map(b => b.wip)); return (d.bottleneck || []).slice(0, 8).map((b, i) => (
            <div key={b.stage} className="mb-2 flex items-center gap-3 text-sm">
              <span className="w-24 text-xs font-semibold text-slate-500">{fmt.stage(b.stage)}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${i === 0 ? 'bg-red-400' : 'bg-brand-400'}`} style={{ width: `${Math.max(4, 100 * b.wip / mx)}%` }} />
              </div>
              <span className="w-6 text-right text-sm font-bold tabular-nums">{b.wip}</span>
              {i === 0 && b.wip > 1 && <span className="rounded-full bg-red-50 px-1.5 text-[10px] font-bold text-red-600">HOT</span>}
            </div>)); })()}
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-slate-900">Machine Utilisation — today</h3>
          {(d.machine_util || []).filter(m => m.runs_today > 0).length === 0
            ? <p className="text-sm text-slate-400">No machine runs completed today.</p>
            : (d.machine_util || []).filter(m => m.runs_today > 0).slice(0, 8).map(m => (
              <div key={m.id} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                <div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-700">{m.name}</div><div className="text-[11px] capitalize text-slate-400">{fmt.stage(m.type)}</div></div>
                <div className="shrink-0 text-right"><div className="text-sm font-bold tabular-nums text-emerald-600">{fmt.num(m.output_today)}</div><div className="text-[10px] text-slate-400">{m.runs_today} run{m.runs_today > 1 ? 's' : ''}</div></div>
              </div>))}
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
          <h3 className="mb-3 text-sm font-bold text-slate-900">Operator Productivity — today</h3>
          {(d.operator_prod || []).length === 0
            ? <p className="text-sm text-slate-400">No operator output logged today.</p>
            : d.operator_prod.map(o => (
              <div key={o.operator} className="mb-1.5 flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-[10px] font-bold text-white">{o.operator.slice(0, 1)}</span>
                  <span className="truncate text-xs font-semibold text-slate-700">{o.operator}</span>
                </div>
                <div className="shrink-0 text-right"><div className="text-sm font-bold tabular-nums">{fmt.num(o.output)}</div><div className="text-[10px] text-slate-400">{o.runs} run{o.runs > 1 ? 's' : ''}{o.wastage > 0 ? ` · ${fmt.num(o.wastage)} waste` : ''}</div></div>
              </div>))}
        </div>
      </div>

      {/* Jobs on floor */}
      <div className="mt-5 rounded-xl border border-gray-200 bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-bold text-gray-900">Jobs on the Floor</h3>
          <Link to="/production" className="text-xs font-semibold text-brand-600 hover:underline">Open Production →</Link>
        </div>
        {d.recent_jobs.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-400">No active job cards.</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-bold uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2">Job Card</th><th className="px-4 py-2">Product</th><th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2 text-right">Qty</th><th className="px-4 py-2">Current Stage</th><th className="px-4 py-2">Progress</th>
            </tr></thead>
            <tbody>
              {d.recent_jobs.map(j => (
                <tr key={j.jc_number} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-2.5 font-semibold text-gray-900">{j.jc_number}</td>
                  <td className="px-4 py-2.5">{j.product_name}</td>
                  <td className="px-4 py-2.5 text-gray-500">{j.customer_name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt.num(j.qty_planned)}</td>
                  <td className="px-4 py-2.5">{j.current_stage ? <StatusBadge status="in_progress" /> : <span className="text-gray-400 text-xs">queued</span>} <span className="ml-1 text-xs text-gray-600">{fmt.stage(j.current_stage || '')}</span></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded bg-gray-100">
                        <div className="h-full bg-emerald-500" style={{ width: `${(100 * j.done_stages) / j.total_stages}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-gray-500">{j.done_stages}/{j.total_stages}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
