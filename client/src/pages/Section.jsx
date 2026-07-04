// Section workspace — one production stage in full depth:
// KPIs (received / produced / wastage / yield, pending / running / done),
// live queue with search + status filters, completed runs with per-run yield,
// machines, and the complete audit trail. Drilled into from Live Floor.
import { useEffect, useMemo, useState } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, Field, Input, Modal, SearchInput, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import {
  ArrowLeft, Play, Check, Gauge, PackagePlus, PackageMinus, Percent, History, PauseCircle,
} from 'lucide-react';
import { SECTION_META, SORTING_REJECTION_REASONS, GENERAL_WASTAGE_REASONS, HOLD_REASONS } from '../sections.js';

const QUEUE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'hold', label: 'On Hold' },
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

// What each section's operators actually need to see about the job —
// the process column is different on every stage page.
const PROCESS_COLUMN = {
  cutting: {
    header: 'Cut Plan',
    render: r => (<>
      <div className="font-semibold text-slate-700">
        {r.sheet_l ? `${r.sheet_l}×${r.sheet_w}"` : r.board_name}
        {r.child_l ? <span className="text-slate-400"> → {r.child_l}×{r.child_w}"</span> : null}
      </div>
      <div className="text-[11px] text-slate-400">
        {fmt.num(r.sheets_issued)} parent{r.children_per_parent > 1 ? ` · ${r.children_per_parent}/parent → ${fmt.num(r.sheets_issued * r.children_per_parent)} print sheets` : ''}
      </div>
    </>),
  },
  printing: {
    header: 'Print Spec',
    render: r => (<><div className="font-semibold text-slate-700">{r.colors} colours</div><div className="text-[11px] text-slate-400">{r.size || ''}{r.coating !== 'none' ? ` · then ${fmt.title(r.coating)}` : ''}</div></>),
  },
  coating: {
    header: 'Coating',
    render: r => <span className="rounded-full bg-cyan-50 px-2.5 py-0.5 text-xs font-semibold text-cyan-700">{fmt.title(r.coating)}</span>,
  },
  lamination: {
    header: 'Film',
    render: r => <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">{r.coating === 'matt_lam' ? 'Matt' : 'Gloss'} lamination</span>,
  },
  foiling: {
    header: 'Foil Work',
    render: r => (<><span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">{fmt.title(r.special)}</span><div className="mt-0.5 text-[11px] text-slate-400">{r.size || ''}</div></>),
  },
  embossing: {
    header: 'Emboss Work',
    render: r => (<><span className="rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-semibold text-orange-700">{fmt.title(r.special)}</span><div className="mt-0.5 text-[11px] text-slate-400">{r.size || ''}</div></>),
  },
  die_cutting: {
    header: 'Die Spec',
    render: r => (<>
      <div className="font-semibold text-slate-700">{r.die_number ? `Die #${r.die_number}` : `${r.ups} ups / sheet`}</div>
      <div className="text-[11px] text-slate-400">{r.die_number ? `${r.ups} ups${r.die_location ? ` · rack ${r.die_location}` : ''}` : (r.size || '—')}</div>
    </>),
  },
  sorting: {
    header: 'Count Target',
    render: r => (<><div className="font-semibold text-slate-700">{fmt.num(r.qty_planned)} cartons ordered</div><div className="text-[11px] text-slate-400">reject with NCR reason</div></>),
  },
  pasting: {
    header: 'Pack Target',
    render: r => (<><div className="font-semibold text-slate-700">{fmt.num(r.qty_planned)} cartons</div><div className="text-[11px] text-slate-400">record boxes × qty/box on completion</div></>),
  },
  qc: {
    header: 'Release Target',
    render: r => (<><div className="font-semibold text-slate-700">{fmt.num(r.qty_planned)} ordered</div><div className="text-[11px] text-slate-400">closes job → FG on release</div></>),
  },
};

function Kpi({ label, value, sub, icon: Icon, chip = 'bg-brand-50 text-brand-600', accent = 'text-slate-900' }) {
  return (
    <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-3.5 shadow-card">
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
    hold: 'bg-red-50 text-red-700',
    queued: 'bg-brand-50 text-brand-700',
    incoming: 'bg-slate-100 text-slate-500',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[state]}`}>
    {state === 'running' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />}
    {state === 'hold' ? 'on hold' : state}
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
  const [holding, setHolding] = useState(null);
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [operator, setOperator] = useState('');
  const [machineId, setMachineId] = useState('');
  const [employees, setEmployees] = useState([]);
  const [period, setPeriod] = useState('all');
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0', scrap_reason: '', pack_boxes: '', pack_qty_per_box: '' });
  const [qc, setQc] = useState({ qty_accepted: '', qty_rejected: '0', qty_rework: '0', scrap_reason: '', inspector: '', remarks: '' });
  const isQC = section === 'qc';

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
    await api.post(`/job-stages/${starting.id}/start`, {
      operator: operator || undefined,
      machine_id: machineId ? +machineId : undefined,
    });
    toast.success(`${starting.jc_number} started at ${meta.label}${operator ? ` — ${operator}` : ''}`);
    setStarting(null); setOperator(''); setMachineId('');
    load();
  };
  const complete = async () => {
    if (isQC) {
      await api.post(`/job-stages/${completing.id}/complete`, {
        qty_accepted: +qc.qty_accepted, qty_rejected: +qc.qty_rejected || 0, qty_rework: +qc.qty_rework || 0,
        scrap_reason: +qc.qty_rejected > 0 ? qc.scrap_reason || undefined : undefined,
        inspector: qc.inspector || undefined, remarks: qc.remarks || undefined,
      });
      toast.success(`${completing.jc_number} — QC passed, ${fmt.num(+qc.qty_accepted)} to Finished Goods`);
    } else {
      await api.post(`/job-stages/${completing.id}/complete`, {
        qty_out: +form.qty_out, qty_scrap: +form.qty_scrap,
        scrap_reason: +form.qty_scrap > 0 ? form.scrap_reason || undefined : undefined,
        pack_boxes: form.pack_boxes ? +form.pack_boxes : undefined,
        pack_qty_per_box: form.pack_qty_per_box ? +form.pack_qty_per_box : undefined,
      });
      toast.success(`${completing.jc_number} — ${meta.label} completed`);
    }
    setCompleting(null); load();
  };
  const hold = async () => {
    await api.post(`/job-stages/${holding.id}/hold`, { reason: holdReason });
    toast.info(`${holding.jc_number} put on hold — ${holdReason}`);
    setHolding(null); setHoldReason(HOLD_REASONS[0]);
    load();
  };
  const resume = async r => {
    await api.post(`/job-stages/${r.id}/resume`, {});
    toast.success(`${r.jc_number} resumed`);
    load();
  };
  // CI-Production counter-first entry: type the machine counter (good output),
  // wastage auto-computes as received − counter. Still editable.
  const setCounter = v => {
    const received = completing?.qty_in ?? 0;
    const out = v === '' ? '' : Math.max(0, +v);
    setForm(f => ({ ...f, qty_out: v === '' ? '' : String(out), qty_scrap: v === '' ? f.qty_scrap : String(Math.max(0, received - out)) }));
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
              <p className="text-sm text-slate-500">{meta.desc}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(data?.machines || []).map(m => (
              <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/65 backdrop-blur-xl px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                <span className={`h-1.5 w-1.5 rounded-full ${m.status === 'running' ? 'bg-emerald-500' : m.status === 'maintenance' ? 'bg-red-500' : 'bg-slate-300'}`} />
                {m.name}
              </span>
            ))}
            {data && data.machines.length === 0 && (
              <span className="rounded-full border border-white/70 bg-white/65 backdrop-blur-xl px-3 py-1 text-xs font-semibold text-slate-400 shadow-sm">Bench section</span>
            )}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <Kpi label="In Queue" value={k ? k.pending : '…'} sub={k ? `${k.incoming} more upstream` : ''} icon={History} />
        <Kpi label="Running" value={k ? k.running : '…'} icon={Play} chip="bg-amber-50 text-amber-600"
          accent={k?.running ? 'text-amber-600' : 'text-slate-900'}
          sub={k?.on_hold > 0 ? `${k.on_hold} on hold` : ''} />
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
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className={th}>Job Card</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
                <th className={th}>{PROCESS_COLUMN[section]?.header || 'Process'}</th>
                <th className={`${th} text-right`}>Qty ({queue[0]?.unit || 'units'})</th>
                <th className={th}>Machine</th><th className={th}>Operator</th><th className={th}>Status</th>
                <th className={th}>Delivery</th>{canOperate() && <th className={th} />}
              </tr></thead>
              <tbody>
                {queue.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-400">Nothing in this view — the section is clear.</td></tr>
                )}
                {queue.map(r => (
                  <tr key={r.id} className="ci-table-row">
                    <td className={`${td} font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></td>
                    <td className={td}><div className="text-slate-700">{r.customer_name}</div><div className="text-xs text-slate-400">PO {r.po_number}</div></td>
                    <td className={`${td} text-xs`}>{PROCESS_COLUMN[section]?.render(r)}</td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(r.qty_in ?? r.expected_qty)}</td>
                    <td className={`${td} text-xs text-slate-500`}>{r.machine_name || '—'}</td>
                    <td className={`${td} text-xs text-slate-500`}>{r.operator || '—'}</td>
                    <td className={td}>
                      <QueueBadge state={r.queue_state} />
                      {r.queue_state === 'incoming' && r.upstream && (
                        <div className="mt-0.5 text-[11px] text-slate-400">after {fmt.stage(r.upstream.stage)}</div>
                      )}
                      {r.queue_state === 'hold' && r.hold_reason && (
                        <div className="mt-0.5 text-[11px] text-red-500">{r.hold_reason}</div>
                      )}
                    </td>
                    <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.date(r.delivery_date)}</td>
                    {canOperate() && (
                      <td className={`${td} text-right`}>
                        {r.queue_state === 'queued' && (
                          <Button size="sm" onClick={() => { setStarting(r); setOperator(''); setMachineId(data?.machines?.[0]?.id ? String(data.machines[0].id) : ''); }}><Play size={12} /> Start</Button>
                        )}
                        {r.queue_state === 'running' && (
                          <span className="inline-flex gap-1">
                            <Button size="sm" variant="secondary" onClick={() => setHolding(r)} title="Put on hold"><PauseCircle size={12} /> Hold</Button>
                            <Button size="sm" variant="success" onClick={() => {
                              setCompleting(r);
                              setForm({ qty_out: r.qty_in ?? '', qty_scrap: '0', scrap_reason: '', pack_boxes: '', pack_qty_per_box: '' });
                              setQc({ qty_accepted: r.qty_in ?? '', qty_rejected: '0', qty_rework: '0', scrap_reason: '', inspector: '', remarks: '' });
                            }}>
                              <Check size={12} /> Complete
                            </Button>
                          </span>
                        )}
                        {r.queue_state === 'hold' && (
                          <Button size="sm" onClick={() => resume(r)}><Play size={12} /> Resume</Button>
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
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
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
                  <tr key={r.id} className="ci-table-row">
                    <td className={`${td} font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.customer_name}</div></td>
                    <td className={`${td} text-right tabular-nums`}>{fmt.num(r.qty_in)} {r.unit}</td>
                    <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_out)}</td>
                    <td className={`${td} text-right tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {fmt.num(r.qty_scrap)}{r.wastage_pct != null && r.qty_scrap > 0 && <span className="ml-1 text-[11px]">({r.wastage_pct}%)</span>}
                      {r.scrap_reason && <div className="text-[11px] font-medium text-red-400">{r.scrap_reason}</div>}
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
        <div className="ci-form-panel">
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
            <div className="ci-summary-panel text-xs">
              {starting.product_name} · Expected input: <b>{fmt.num(starting.expected_qty)} {starting.unit}</b>
              {starting.machine_name && <> · {starting.machine_name}</>}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Run assignment</span><span>{meta.label}</span></div>
              <div className="ci-form-grid">
              <Field label="Operator" hint="Defaults to your own name if left blank">
                <Select value={operator} onChange={e => setOperator(e.target.value)}>
                  <option value="">— {auth.user?.name} (me) —</option>
                  {sectionCrew.map(e => <option key={e.id} value={e.name}>{e.name}{e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
                </Select>
              </Field>
              {(data?.machines || []).length > 0 && (
                <Field label="Machine">
                  <Select value={machineId} onChange={e => setMachineId(e.target.value)}>
                  {data.machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              </Field>
              )}
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* Hold modal — reason required, straight from the CI-Production playbook */}
      <Modal open={!!holding} onClose={() => setHolding(null)}
        title={holding ? `Hold ${meta.label} — ${holding.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setHolding(null)}>Cancel</Button>
          <Button variant="danger" onClick={hold}><PauseCircle size={13} /> Put on Hold</Button>
        </>}>
        {holding && (
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Hold reason</span><span>Required</span></div>
            <Field label="Reason" required>
              <Select value={holdReason} onChange={e => setHoldReason(e.target.value)}>
                {HOLD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
          </section>
        )}
      </Modal>

      {/* Complete modal — QC gets accepted/rejected/rework capture */}
      <Modal open={!!completing} onClose={() => setCompleting(null)}
        title={completing ? `${isQC ? 'QC Inspection' : `Complete ${meta.label}`} — ${completing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCompleting(null)}>Cancel</Button>
          {isQC ? (
            <Button variant="success" onClick={complete}
              disabled={qc.qty_accepted === '' || (+qc.qty_rejected > 0 && !qc.scrap_reason)}>Pass QC → Finished Goods</Button>
          ) : (
            <Button variant="success" onClick={complete}
              disabled={form.qty_out === '' || (+form.qty_scrap > 0 && !form.scrap_reason)}>Complete Stage</Button>
          )}
        </>}>
        {completing && isQC && (() => {
          const acc = +qc.qty_accepted || 0, rej = +qc.qty_rejected || 0, rw = +qc.qty_rework || 0;
          const inSt = completing.qty_in || 0;
          const accountedOver = acc + rej + rw > inSt;
          return (
            <div className="space-y-3">
              <div className="ci-summary-panel text-xs">
                {completing.product_name} · Presented to QC: <b>{fmt.num(inSt)} cartons</b>
                {inSt > 0 && <span className="ml-2">→ accept rate <b>{(100 * acc / inSt).toFixed(1)}%</b></span>}
              </div>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>QC quantities</span><span>Inspection</span></div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label="Accepted" required>
                  <Input type="number" min="0" value={qc.qty_accepted} onChange={e => setQc({ ...qc, qty_accepted: e.target.value })} autoFocus />
                </Field>
                <Field label="Rejected">
                  <Input type="number" min="0" value={qc.qty_rejected} onChange={e => setQc({ ...qc, qty_rejected: e.target.value })} />
                </Field>
                <Field label="Rework">
                  <Input type="number" min="0" value={qc.qty_rework} onChange={e => setQc({ ...qc, qty_rework: e.target.value })} />
                </Field>
                </div>
              </section>
              {accountedOver && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Accepted + rejected + rework ({fmt.num(acc + rej + rw)}) exceeds presented ({fmt.num(inSt)}).</p>}
              {rej > 0 && (
                <section className="ci-form-panel">
                  <Field label="Rejection reason (NCR)" required>
                    <Select value={qc.scrap_reason} onChange={e => setQc({ ...qc, scrap_reason: e.target.value })}>
                      <option value="">Select reason…</option>
                      {SORTING_REJECTION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  </Field>
                </section>
              )}
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Inspector notes</span><span>Optional</span></div>
                <div className="ci-form-grid">
                <Field label="Inspector" hint="Defaults to you">
                  <Select value={qc.inspector} onChange={e => setQc({ ...qc, inspector: e.target.value })}>
                    <option value="">— {auth.user?.name} (me) —</option>
                    {sectionCrew.map(e => <option key={e.id} value={e.name}>{e.name}</option>)}
                  </Select>
                </Field>
                <Field label="Inspection remarks">
                  <Input value={qc.remarks} onChange={e => setQc({ ...qc, remarks: e.target.value })} placeholder="Optional" />
                </Field>
                </div>
              </section>
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                {fmt.num(acc)} accepted cartons will be released to Finished Goods (batch {completing.jc_number}).
              </p>
            </div>
          );
        })()}
        {completing && !isQC && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {completing.product_name} · Received: <b>{fmt.num(completing.qty_in)} {completing.unit}</b>
              {form.qty_out !== '' && completing.qty_in > 0 && (
                <span className="ml-2 text-slate-500">
                  → yield <b>{(100 * (+form.qty_out) / completing.qty_in).toFixed(1)}%</b>
                </span>
              )}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Counter entry</span><span>{meta.label}</span></div>
              <div className="ci-form-grid">
              <Field label={`Actual counter — good ${completing.unit}`} required hint="Wastage auto-computes from received − counter">
                <Input type="number" min="0" value={form.qty_out} onChange={e => setCounter(e.target.value)} autoFocus />
              </Field>
              <Field label={`Wastage (${completing.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
              </div>
            </section>
            {+form.qty_scrap > 0 && (
              <section className="ci-form-panel">
                <Field label={section === 'sorting' ? 'Rejection reason (NCR)' : 'Wastage reason'} required>
                  <Select value={form.scrap_reason} onChange={e => setForm({ ...form, scrap_reason: e.target.value })}>
                    <option value="">Select reason…</option>
                    {(section === 'sorting' ? SORTING_REJECTION_REASONS : GENERAL_WASTAGE_REASONS)
                      .map(r => <option key={r} value={r}>{r}</option>)}
                  </Select>
                </Field>
              </section>
            )}
            {section === 'pasting' && (
              <section className="ci-form-panel border-dashed">
                <div className="ci-form-panel-title"><span>Packing manifest</span><span>Dispatch helper</span></div>
                <div className="ci-form-grid">
                <Field label="Packing — boxes" hint="Optional manifest for dispatch">
                  <Input type="number" min="0" value={form.pack_boxes} onChange={e => setForm({ ...form, pack_boxes: e.target.value })} />
                </Field>
                <Field label="Cartons per box">
                  <Input type="number" min="0" value={form.pack_qty_per_box} onChange={e => setForm({ ...form, pack_qty_per_box: e.target.value })} />
                </Field>
                {form.pack_boxes && form.pack_qty_per_box && (
                  <p className="col-span-2 text-xs text-slate-500">
                    Manifest: <b>{fmt.num(+form.pack_boxes * +form.pack_qty_per_box)}</b> cartons in {form.pack_boxes} boxes
                    {+form.qty_out > 0 && +form.pack_boxes * +form.pack_qty_per_box !== +form.qty_out && (
                      <span className="ml-1 font-semibold text-amber-600">— differs from counter ({fmt.num(+form.qty_out)})</span>
                    )}
                  </p>
                )}
                </div>
              </section>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
