// Section workspace — one production stage in full depth:
// KPIs (received / produced / wastage / yield, pending / running / done),
// live queue with search + status filters, completed runs with per-run yield,
// machines, and the complete audit trail. Drilled into from Live Floor.
import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, Field, Input, Modal, SearchInput, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import {
  Printer, Droplets, Sparkles, Stamp, Scissors, Combine, ShieldCheck,
  ArrowLeft, Play, Check, Gauge, PackagePlus, PackageMinus, Percent, History,
} from 'lucide-react';

const SECTION_META = {
  printing: { label: 'Printing', icon: Printer, tint: 'text-sky-600 bg-sky-50' },
  coating: { label: 'Coating', icon: Droplets, tint: 'text-cyan-600 bg-cyan-50' },
  foiling: { label: 'Foiling', icon: Sparkles, tint: 'text-amber-600 bg-amber-50' },
  embossing: { label: 'Embossing', icon: Stamp, tint: 'text-orange-600 bg-orange-50' },
  die_cutting: { label: 'Die Cutting', icon: Scissors, tint: 'text-rose-600 bg-rose-50' },
  pasting: { label: 'Pasting', icon: Combine, tint: 'text-violet-600 bg-violet-50' },
  qc: { label: 'QC', icon: ShieldCheck, tint: 'text-emerald-600 bg-emerald-50' },
};

const QUEUE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'queued', label: 'Queued' },
  { key: 'incoming', label: 'Incoming' },
];

// Pureflix timeline presets — filter completed runs by period.
const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 Days' },
  { key: 'month', label: 'This Month' },
  { key: 'fy', label: 'This FY' },
  { key: 'all', label: 'All' },
];
function inPeriod(dateStr, period) {
  if (period === 'all' || !dateStr) return period === 'all';
  const d = new Date(dateStr);
  const now = new Date();
  if (period === 'today') return d.toDateString() === now.toDateString();
  if (period === 'week') return now - d < 7 * 864e5;
  if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (period === 'fy') {
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
    return d >= fyStart;
  }
  return true;
}

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

function Kpi({ label, value, sub, icon: Icon, chip = 'bg-brand-50 text-brand-600', accent = 'text-slate-900' }) {
  return (
    <div className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        {Icon && <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${chip}`}><Icon size={12} /></span>}
      </div>
      <div className={`mt-0.5 text-xl font-extrabold tracking-tight tabular-nums ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function QueueBadge({ state }) {
  const map = {
    running: 'bg-amber-50 text-amber-700',
    queued: 'bg-brand-50 text-brand-700',
    incoming: 'bg-slate-100 text-slate-500',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[state]}`}>
    {state === 'running' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />}{state}
  </span>;
}

function YieldPill({ pct }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const cls = pct >= 98 ? 'text-emerald-700 bg-emerald-50' : pct >= 95 ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${cls}`}>{pct}%</span>;
}

export default function Section() {
  const { section } = useParams();
  const meta = SECTION_META[section];
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('queue');
  const [q, setQ] = useState('');
  const [state, setState] = useState('all');
  const [completing, setCompleting] = useState(null);
  const [starting, setStarting] = useState(null);
  const [operator, setOperator] = useState('');
  const [employees, setEmployees] = useState([]);
  const [period, setPeriod] = useState('all');
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0' });

  const load = () => api.get(`/floor/${section}`).then(setData);
  useEffect(() => {
    setData(null); setTab('queue'); setQ(''); setState('all'); setPeriod('all');
    if (meta) { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }
  }, [section]);
  useEffect(() => { api.get('/employees').then(setEmployees); }, []);

  const queue = useMemo(() => {
    let rows = data?.queue || [];
    if (state !== 'all') rows = rows.filter(r => r.queue_state === state);
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter(r => [r.jc_number, r.product_name, r.product_code, r.customer_name, r.po_number, r.operator]
        .some(v => (v || '').toLowerCase().includes(s)));
    }
    return rows;
  }, [data, q, state]);

  const completed = useMemo(() => {
    let rows = data?.completed || [];
    if (period !== 'all') rows = rows.filter(r => inPeriod(r.completed_at, period));
    if (q) {
      const s = q.toLowerCase();
      rows = rows.filter(r => [r.jc_number, r.product_name, r.product_code, r.customer_name, r.po_number, r.operator]
        .some(v => (v || '').toLowerCase().includes(s)));
    }
    return rows;
  }, [data, q, period]);

  if (!meta) return <Navigate to="/floor" replace />;
  const Icon = meta.icon;
  const k = data?.kpis;

  const sectionCrew = employees.filter(e => e.active && (!e.section || e.section === section));
  const start = async () => {
    await api.post(`/job-stages/${starting.id}/start`, { operator: operator || undefined });
    toast.success(`${starting.jc_number} started at ${meta.label}${operator ? ` — ${operator}` : ''}`);
    setStarting(null); setOperator('');
    load();
  };
  const complete = async () => {
    await api.post(`/job-stages/${completing.id}/complete`, { qty_out: +form.qty_out, qty_scrap: +form.qty_scrap });
    toast.success(`${completing.jc_number} — ${meta.label} completed`);
    setCompleting(null); load();
  };

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5';

  return (
    <div>
      {/* Header */}
      <div className="mb-5">
        <Link to="/floor" className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-indigo-700">
          <ArrowLeft size={13} /> Live Floor
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${meta.tint}`}><Icon size={20} /></span>
            <div>
              <h1 className="text-2xl font-bold leading-tight text-slate-950 sm:text-[28px]">{meta.label}</h1>
              <p className="text-sm text-slate-500">Sequential stage · full traceability, run by run</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(data?.machines || []).map(m => (
              <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                <span className={`h-1.5 w-1.5 rounded-full ${m.status === 'running' ? 'bg-emerald-500' : m.status === 'maintenance' ? 'bg-red-500' : 'bg-slate-300'}`} />
                {m.name}
              </span>
            ))}
            {data && data.machines.length === 0 && (
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-400 shadow-sm">Bench section</span>
            )}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <Kpi label="In Queue" value={k ? k.pending : '…'} sub={k ? `${k.incoming} more upstream` : ''} icon={History} />
        <Kpi label="Running" value={k ? k.running : '…'} icon={Play} chip="bg-amber-50 text-amber-600" accent={k?.running ? 'text-amber-600' : 'text-slate-900'} />
        <Kpi label="Completed Today" value={k ? k.completed_today : '…'} icon={Check} chip="bg-emerald-50 text-emerald-600" />
        <Kpi label="Received Today" value={k ? fmt.num(k.received_today) : '…'} icon={PackagePlus} />
        <Kpi label="Produced Today" value={k ? fmt.num(k.produced_today) : '…'} icon={Gauge} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" />
        <Kpi label="Wastage Today" value={k ? fmt.num(k.scrap_today) : '…'} icon={PackageMinus} chip="bg-red-50 text-red-500"
          accent={k?.scrap_today > 0 ? 'text-red-600' : 'text-slate-900'} />
        <Kpi label="Yield" value={k?.yield_today != null ? `${k.yield_today}%` : k?.yield_all != null ? `${k.yield_all}%` : '—'}
          sub={k?.yield_today != null ? 'today' : 'lifetime'} icon={Percent}
          chip="bg-brand-50 text-brand-600"
          accent={(k?.yield_today ?? k?.yield_all) >= 98 ? 'text-emerald-600' : (k?.yield_today ?? k?.yield_all) >= 95 ? 'text-amber-600' : 'text-slate-900'} />
      </div>

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'queue', label: 'Production Queue', count: data?.queue.length },
          { key: 'completed', label: 'Completed Runs', count: data?.completed.length },
          { key: 'audit', label: 'Audit Trail' },
        ]} />
        <div className="mb-4 flex items-center gap-2">
          {tab === 'queue' && (
            <div className="flex gap-1 rounded-xl bg-slate-100/80 p-1">
              {QUEUE_FILTERS.map(f => (
                <button key={f.key} onClick={() => setState(f.key)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${state === f.key ? 'bg-white text-indigo-800 shadow-sm ring-1 ring-white' : 'text-slate-500 hover:text-slate-800'}`}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {tab === 'completed' && (
            <div className="flex gap-1 rounded-xl bg-slate-100/80 p-1">
              {PERIODS.map(p => (
                <button key={p.key} onClick={() => setPeriod(p.key)}
                  className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${period === p.key ? 'bg-white text-indigo-800 shadow-sm ring-1 ring-white' : 'text-slate-500 hover:text-slate-800'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {tab !== 'audit' && <SearchInput value={q} onChange={setQ} placeholder="JC, product, PO, operator…" />}
        </div>
      </div>

      {/* Queue */}
      {tab === 'queue' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                <th className={th}>Job Card</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
                <th className={`${th} text-right`}>Qty ({queue[0]?.unit || 'units'})</th>
                <th className={th}>Machine</th><th className={th}>Operator</th><th className={th}>Status</th>
                <th className={th}>Delivery</th>{canOperate() && <th className={th} />}
              </tr></thead>
              <tbody>
                {queue.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">Nothing in this view — the section is clear.</td></tr>
                )}
                {queue.map(r => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className={`${td} font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></td>
                    <td className={td}><div className="text-slate-700">{r.customer_name}</div><div className="text-xs text-slate-400">PO {r.po_number}</div></td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(r.qty_in ?? r.expected_qty)}</td>
                    <td className={`${td} text-xs text-slate-500`}>{r.machine_name || '—'}</td>
                    <td className={`${td} text-xs text-slate-500`}>{r.operator || '—'}</td>
                    <td className={td}>
                      <QueueBadge state={r.queue_state} />
                      {r.queue_state === 'incoming' && r.upstream && (
                        <div className="mt-0.5 text-[11px] text-slate-400">after {fmt.stage(r.upstream.stage)}</div>
                      )}
                    </td>
                    <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.date(r.delivery_date)}</td>
                    {canOperate() && (
                      <td className={`${td} text-right`}>
                        {r.queue_state === 'queued' && (
                          <Button size="sm" onClick={() => { setStarting(r); setOperator(''); }}><Play size={12} /> Start</Button>
                        )}
                        {r.queue_state === 'running' && (
                          <Button size="sm" variant="success" onClick={() => { setCompleting(r); setForm({ qty_out: r.qty_in ?? '', qty_scrap: '0' }); }}>
                            <Check size={12} /> Complete
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Completed runs */}
      {tab === 'completed' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 bg-slate-50/80">
                <th className={th}>Job Card</th><th className={th}>Product</th>
                <th className={`${th} text-right`}>Received</th><th className={`${th} text-right`}>Produced</th>
                <th className={`${th} text-right`}>Wastage</th><th className={`${th} text-right`}>Yield</th>
                <th className={th}>Operator</th><th className={th}>Completed</th><th className={`${th} text-right`}>Run Time</th>
              </tr></thead>
              <tbody>
                {completed.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">No completed runs yet.</td></tr>
                )}
                {completed.map(r => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className={`${td} font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.customer_name}</div></td>
                    <td className={`${td} text-right tabular-nums`}>{fmt.num(r.qty_in)} {r.unit}</td>
                    <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_out)}</td>
                    <td className={`${td} text-right tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {fmt.num(r.qty_scrap)}{r.wastage_pct != null && r.qty_scrap > 0 && <span className="ml-1 text-[11px]">({r.wastage_pct}%)</span>}
                    </td>
                    <td className={`${td} text-right`}><YieldPill pct={r.yield_pct} /></td>
                    <td className={`${td} text-xs text-slate-500`}>{r.operator || '—'}</td>
                    <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.dt(r.completed_at)}</td>
                    <td className={`${td} text-right text-xs tabular-nums text-slate-500`}>{r.duration_min != null ? `${r.duration_min}m` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit trail */}
      {tab === 'audit' && (
        <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-card">
          {(data?.audit || []).length === 0 && <p className="py-10 text-center text-sm text-slate-400">No activity recorded yet.</p>}
          <ol className="relative ml-2 border-l-2 border-slate-100">
            {(data?.audit || []).map(a => (
              <li key={a.id} className="relative pb-4 pl-5 last:pb-0">
                <span className={`absolute -left-[5px] top-1.5 h-2 w-2 rounded-full ${a.action === 'start' ? 'bg-amber-400' : a.action === 'complete' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm">
                    <b className="font-bold text-slate-900">{a.jc_number}</b>
                    <span className="ml-2 font-semibold capitalize text-slate-600">{a.action}</span>
                    {a.detail && <span className="ml-2 text-xs text-slate-400">{a.detail}</span>}
                  </span>
                  <span className="text-[11px] tabular-nums text-slate-400">{fmt.dt(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Start modal — pick the operator running this stage */}
      <Modal open={!!starting} onClose={() => setStarting(null)}
        title={starting ? `Start ${meta.label} — ${starting.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setStarting(null)}>Cancel</Button>
          <Button onClick={start}><Play size={13} /> Start Run</Button>
        </>}>
        {starting && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              {starting.product_name} · Expected input: <b>{fmt.num(starting.expected_qty)} {starting.unit}</b>
              {starting.machine_name && <> · {starting.machine_name}</>}
            </div>
            <Field label="Operator" hint="Defaults to your own name if left blank">
              <Select value={operator} onChange={e => setOperator(e.target.value)}>
                <option value="">— {auth.user?.name} (me) —</option>
                {sectionCrew.map(e => <option key={e.id} value={e.name}>{e.name}{e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      {/* Complete modal */}
      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `Complete ${meta.label} — ${completing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          <Button variant="success" onClick={complete} disabled={form.qty_out === ''}>Complete Stage</Button>
        </>}>
        {completing && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              {completing.product_name} · Received: <b>{fmt.num(completing.qty_in)} {completing.unit}</b>
              {form.qty_out !== '' && completing.qty_in > 0 && (
                <span className="ml-2 text-slate-500">
                  → yield <b>{(100 * (+form.qty_out) / completing.qty_in).toFixed(1)}%</b>
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Good output (${completing.unit})`} required>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setForm({ ...form, qty_out: e.target.value })} />
              </Field>
              <Field label={`Wastage (${completing.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
