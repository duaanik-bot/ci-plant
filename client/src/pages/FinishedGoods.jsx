// Finished Goods — QC-accepted production, batch by batch (job card).
// Ordered vs produced (excess / short), available for dispatch, location,
// and full stage-by-stage production history + dispatch traceability.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, KpiCard, Modal, PageHeader, SearchInput, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { Boxes, PackageCheck, TruckIcon, AlertTriangle, ArrowUpRight, History, MapPin } from 'lucide-react';

export default function FinishedGoods() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('ready');
  const [detail, setDetail] = useState(null);

  const load = () => api.get('/finished-goods').then(setRows);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);

  const kpis = useMemo(() => ({
    batches: rows.length,
    available: rows.reduce((s, r) => s + Math.max(0, r.available), 0),
    value: rows.reduce((s, r) => s + Math.max(0, r.available) * (r.rate || 0), 0),
    excess: rows.reduce((s, r) => s + r.excess, 0),
    shortfall: rows.reduce((s, r) => s + r.shortfall, 0),
  }), [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (tab === 'ready') out = out.filter(r => r.available > 0);
    else if (tab === 'dispatched') out = out.filter(r => r.available <= 0);
    if (q) {
      const s = q.toLowerCase();
      out = out.filter(r => [r.product_name, r.product_code, r.batch, r.customer_name, r.po_number]
        .some(v => (v || '').toLowerCase().includes(s)));
    }
    return out;
  }, [rows, tab, q]);

  const openDetail = async r => setDetail(await api.get(`/finished-goods/${r.job_card_id}`));

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  return (
    <div>
      <PageHeader title="Finished Goods" subtitle="QC-accepted production ready for dispatch — full batch traceability" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="FG Batches" value={fmt.num(kpis.batches)} icon={Boxes} />
        <KpiCard label="Available Cartons" value={fmt.num(kpis.available)} icon={PackageCheck} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
        <KpiCard label="FG Value" value={fmt.inr(kpis.value)} icon={ArrowUpRight} />
        <KpiCard label="Excess" value={fmt.num(kpis.excess)} icon={AlertTriangle} chip="bg-amber-50 text-amber-600" accent={kpis.excess ? 'text-amber-600' : 'text-slate-900'} />
        <KpiCard label="Short vs Order" value={fmt.num(kpis.shortfall)} icon={AlertTriangle} chip="bg-red-50 text-red-500" accent={kpis.shortfall ? 'text-red-600' : 'text-slate-900'} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'ready', label: 'Dispatch-Ready', count: rows.filter(r => r.available > 0).length },
          { key: 'dispatched', label: 'Fully Dispatched', count: rows.filter(r => r.available <= 0).length },
          { key: 'all', label: 'All Batches', count: rows.length },
        ]} />
        <div className="mb-4"><SearchInput value={q} onChange={setQ} placeholder="Batch, product, PO, customer…" /></div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 bg-slate-50/80">
              <th className={th}>Batch (JC)</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
              <th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Produced</th>
              <th className={`${th} text-right`}>Excess / Short</th><th className={`${th} text-right`}>Available</th>
              <th className={th}>Location</th><th className={th}>Readiness</th><th className={th} />
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-400">No finished-goods batches in this view. Close a job through QC to see it here.</td></tr>
              )}
              {filtered.map(r => (
                <tr key={r.job_card_id} className="cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60" onClick={() => openDetail(r)}>
                  <td className={`${td} font-bold text-slate-900`}>{r.batch}<div className="text-[11px] font-normal text-slate-400">{fmt.date(r.closed_at)}</div></td>
                  <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></td>
                  <td className={td}><div className="text-slate-700">{r.customer_name}</div><div className="text-xs text-slate-400">PO {r.po_number}</div></td>
                  <td className={`${td} text-right tabular-nums`}>{fmt.num(r.ordered_qty)}</td>
                  <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_produced)}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {r.excess > 0 ? <span className="text-amber-600">+{fmt.num(r.excess)}</span>
                      : r.shortfall > 0 ? <span className="text-red-600">−{fmt.num(r.shortfall)}</span>
                      : <span className="text-slate-300">even</span>}
                  </td>
                  <td className={`${td} text-right font-bold tabular-nums ${r.available > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{fmt.num(Math.max(0, r.available))}</td>
                  <td className={`${td} text-xs`}><span className="inline-flex items-center gap-1 text-slate-500"><MapPin size={11} />{r.fg_location || 'FG-STORE'}</span></td>
                  <td className={td}>
                    {r.available > 0
                      ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"><TruckIcon size={11} /> Ready</span>
                      : <StatusBadge status="dispatched" />}
                  </td>
                  <td className={`${td} text-right`} onClick={e => e.stopPropagation()}>
                    {r.available > 0 && <Link to="/dispatch"><Button size="sm" variant="secondary">Dispatch</Button></Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Batch traceability */}
      <Modal wide open={!!detail} onClose={() => setDetail(null)}
        title={detail ? `Batch ${detail.jc_number} — ${detail.product_name}` : ''}>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['Customer', detail.customer_name], ['PO', detail.po_number], ['Ordered', fmt.num(detail.line_qty)],
                ['Produced (accepted)', fmt.num(detail.qty_produced)], ['Total wastage', fmt.num(detail.qty_scrap)],
                ['Location', detail.fg_location || 'FG-STORE'], ['Closed', fmt.dt(detail.closed_at)], ['Board', detail.board_name]]
                .map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-slate-50 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className="text-sm font-bold text-slate-800">{v}</div>
                  </div>))}
            </div>

            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><History size={13} /> Production history</h4>
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase text-slate-400">
                    <th className="px-3 py-1.5">Stage</th><th className="px-3 py-1.5">Machine</th><th className="px-3 py-1.5">Operator</th>
                    <th className="px-3 py-1.5 text-right">In</th><th className="px-3 py-1.5 text-right">Out</th>
                    <th className="px-3 py-1.5 text-right">Wastage</th><th className="px-3 py-1.5">Completed</th>
                  </tr></thead>
                  <tbody>
                    {detail.stages.map(s => (
                      <tr key={s.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-1.5 font-semibold">{fmt.stage(s.stage)}</td>
                        <td className="px-3 py-1.5 text-slate-500">{s.stage_machine_name || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-500">{s.operator || '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{s.qty_in != null ? fmt.num(s.qty_in) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{s.qty_out != null ? fmt.num(s.qty_out) : '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red-500">{s.qty_scrap ? fmt.num(s.qty_scrap) : ''}{s.scrap_reason ? ` (${s.scrap_reason})` : ''}</td>
                        <td className="px-3 py-1.5 text-slate-400">{fmt.dt(s.completed_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {detail.dispatches.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400"><TruckIcon size={13} /> Dispatches</h4>
                <div className="flex flex-wrap gap-1.5">
                  {detail.dispatches.map((d, i) => (
                    <span key={i} className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                      {d.challan_number} · {fmt.num(d.qty)} · {fmt.date(d.dispatched_at)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
