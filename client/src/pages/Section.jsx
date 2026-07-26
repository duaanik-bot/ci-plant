// Section workspace — one production stage in full depth:
// KPIs (received / produced / wastage / yield, pending / running / done),
// live queue with search + status filters, completed runs with per-run yield,
// machines, and the complete audit trail. Drilled into from Live Floor.
import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link, Navigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { Button, ConfirmDialog, ExportMenu, Field, Input, Modal, rowMatches, SearchInput, Select, StatusBadge, Tabs, UpstreamChip, useToast } from '../components/ui.jsx';
import {
  ArrowLeft, Play, Check, Gauge, PackagePlus, PackageMinus, Percent, History, PauseCircle,
  Plus, Trash2, Pencil, AlertTriangle, User, Undo2,
} from 'lucide-react';
import { SECTION_META, SORTING_REJECTION_REASONS, GENERAL_WASTAGE_REASONS, HOLD_REASONS, CUTTING_VARIANCE_REASONS } from '../sections.js';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import { GangChip, GangMemberList } from '../components/Gang.jsx';

// The finalised parent (board grade + full board) + child, carried from planning
// onto every station so the floor always sees the sheet that was locked.
function SheetLine({ r }) {
  if (!r.board_name && !r.child_l) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
      {r.board_grade && <span className="rounded bg-slate-800 px-1 py-px font-bold uppercase tracking-wide text-white">{r.board_grade}</span>}
      <span className="font-semibold text-slate-500" title={r.board_name}>{r.board_name}</span>
      {r.child_l ? <span className="text-slate-400">· child {r.child_l}×{r.child_w}"</span> : null}
    </div>
  );
}

// A gang parent runs this station as ONE physical job — one row, one count,
// every bound product listed in the same aligned grid. Splits after die cutting.
function ProductCell({ r }) {
  if (r.gang_members?.length) {
    return (
      <div className="min-w-[220px]">
        <GangMemberList members={r.gang_members} showOrder={false} />
        <div className="mt-1 text-[10px] font-semibold text-violet-500">
          one combined run · separates after die cutting
        </div>
        <SheetLine r={r} />
      </div>
    );
  }
  return (<><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div><SheetLine r={r} /></>);
}

function CustomerCell({ r }) {
  if (r.gang_members?.length) {
    const uniq = [...new Map(r.gang_members.map(m => [`${m.customer_name}|${m.po_number}`, m])).values()];
    return (
      <div className="space-y-0.5">
        {uniq.map((m, i) => (
          <div key={i}>
            <div className="text-slate-700">{m.customer_name}</div>
            <div className="text-xs text-slate-400">PO {m.po_number}</div>
          </div>
        ))}
      </div>
    );
  }
  return (<><div className="text-slate-700">{r.customer_name}</div><div className="text-xs text-slate-400">PO {r.po_number}</div></>);
}

const gangExportName = r => r.gang_members?.length
  ? `${r.gang_number}: ${r.gang_members.map(m => m.product_name).join(' + ')}`
  : r.product_name;

const QUEUE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'partial', label: 'Partially Done' },
  { key: 'hold', label: 'On Hold' },
  { key: 'queued', label: 'Queued' },
  { key: 'incoming', label: 'Incoming' },
];

// Cutting converts parent sheets → child print sheets (input × cuts-per-parent);
// every other stage carries its input forward 1:1. This expected good output is
// what the completion form pre-fills and measures yield against.
// A stage started ahead has no fixed qty_in yet — its basis is whatever the
// previous station has COUNTED so far (upstream_available, unit-converted by
// the server), so the partial flow works station-to-station down the chain.
const expectedOutput = (row, section) =>
  ((row?.qty_in ?? row?.upstream_available) ?? 0) * (section === 'cutting' ? Math.max(1, row?.children_per_parent || 1) : 1);

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

const emptyPack = () => ({ boxes: '', qty_per_box: '', loose_qty: '' });
const packLineTotal = pl => (Math.max(0, +pl.boxes || 0) * Math.max(0, +pl.qty_per_box || 0)) + Math.max(0, +pl.loose_qty || 0);
const packTotal = lines => lines.reduce((s, pl) => s + packLineTotal(pl), 0);

// Parse rows pasted from Excel/WhatsApp into packing lines.
// Accepts "10<TAB>100", "10 x 100", "10,100,25", "10 100 25" — one line per row.
function parsePackingPaste(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(row => row.trim())
    .filter(Boolean)
    .map(row => {
      const nums = row.split(/[\s,x×*|]+/).map(t => t.replace(/[^\d]/g, '')).filter(Boolean).map(Number);
      if (!nums.length) return null;
      if (nums.length === 1) return { boxes: '', qty_per_box: '', loose_qty: String(nums[0]) };
      return { boxes: String(nums[0]), qty_per_box: String(nums[1]), loose_qty: String(nums[2] || '') };
    })
    .filter(Boolean);
}

// What each section's operators actually need to see about the job —
// the process column is different on every stage page.
const PROCESS_COLUMN = {
  cutting: {
    header: 'Cut Plan',
    render: r => (<>
      {/* Finalised parent (board grade + name) + child, carried from planning */}
      <div className="flex flex-wrap items-center gap-1">
        {r.board_grade && <span className="rounded bg-slate-800 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white">{r.board_grade}</span>}
        <span className="text-[11px] font-semibold text-slate-600" title={r.board_name}>{r.board_name}</span>
      </div>
      <div className="font-semibold text-slate-700">
        {r.sheet_l ? `${r.sheet_l}×${r.sheet_w}"` : ''}
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
    partial: 'bg-cyan-50 text-cyan-700',
    hold: 'bg-red-50 text-red-700',
    queued: 'bg-brand-50 text-brand-700',
    incoming: 'bg-slate-100 text-slate-500',
  };
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[state]}`}>
    {state === 'running' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />}
    {state === 'partial' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-cyan-500" />}
    {state === 'hold' ? 'on hold' : state === 'partial' ? 'partially done' : state}
  </span>;
}

function YieldPill({ pct }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const cls = pct >= 98 ? 'text-emerald-700 bg-emerald-50' : pct >= 95 ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${cls}`}>{pct}%</span>;
}

export default function Section() {
  const { section } = useParams();
  const [searchParams] = useSearchParams();
  const meta = SECTION_META[section];
  const toast = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('queue');
  // ?q= deep link — the machine board's jump button lands pre-filtered to a JC.
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [state, setState] = useState('all');
  const [completing, setCompleting] = useState(null);
  const [starting, setStarting] = useState(null);
  const [holding, setHolding] = useState(null);
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [operator, setOperator] = useState('');
  const [machineId, setMachineId] = useState('');
  const [clearance, setClearance] = useState([]);          // line clearance checks in the start modal
  const [shadeAlarm, setShadeAlarm] = useState(null);      // soft shade-card 409 → { shade, proceed }
  const [requesting, setRequesting] = useState(null);      // running row → extra sheet request modal
  const [reqForm, setReqForm] = useState({ qty: '', reason: '', note: '' });
  const [employees, setEmployees] = useState([]);
  const [period, setPeriod] = useState('all');
  const [form, setForm] = useState({ qty_out: '', qty_scrap: '0', scrap_reason: '' });
  const [variance, setVariance] = useState({ reason: '', note: '' });
  const [packing, setPacking] = useState([emptyPack()]);
  const [qc, setQc] = useState({ qty_accepted: '', qty_rejected: '0', qty_rework: '0', scrap_reason: '', inspector: '', remarks: '' });
  const [adjusting, setAdjusting] = useState(null);      // completed run being corrected
  const [adjForm, setAdjForm] = useState({ qty_out: '', qty_scrap: '', reason: '' });
  const [impact, setImpact] = useState(null);
  const [reversing, setReversing] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  // Partial counter filling — the day-wise run log for the stage being
  // completed, and the operator's explicit choice when the counter falls short:
  // null = not chosen yet, 'partial' = save today's count and keep the job
  // open, 'final' = close the stage (wastage auto-computes as before).
  const [runLog, setRunLog] = useState(null);
  const [entryMode, setEntryMode] = useState(null);
  const isQC = section === 'qc';
  // Pasting is also the packing station — every job passes through it — so the
  // packing manifest is captured here.
  const isPackingStage = section === 'pasting';

  const load = () => api.get(`/floor/${section}`).then(setData);
  useEffect(() => {
    setData(null); setTab('queue'); setQ(searchParams.get('q') || ''); setState('all'); setPeriod('all');
    if (meta) {
      load();
      // Near-realtime: a Print Planning drag lands here within seconds.
      // Poll unconditionally — browsers throttle hidden tabs on their own,
      // and plant wall displays must keep updating; focus refreshes instantly.
      const t = setInterval(load, 5000);
      const onWake = () => load();
      document.addEventListener('visibilitychange', onWake);
      window.addEventListener('focus', onWake);
      return () => {
        clearInterval(t);
        document.removeEventListener('visibilitychange', onWake);
        window.removeEventListener('focus', onWake);
      };
    }
  }, [section, searchParams]);
  useEffect(() => { api.get('/employees').then(setEmployees); }, []);

  const queue = useMemo(() => {
    let rows = data?.queue || [];
    if (state !== 'all') rows = rows.filter(r => r.queue_state === state);
    if (q) rows = rows.filter(r => rowMatches(r, q));
    return rows;
  }, [data, q, state]);

  const completed = useMemo(() => {
    let rows = data?.completed || [];
    if (period !== 'all') rows = rows.filter(r => inPeriod(r.completed_at, period));
    if (q) rows = rows.filter(r => rowMatches(r, q));
    return rows;
  }, [data, q, period]);

  if (!meta) return <Navigate to="/floor" replace />;
  const Icon = meta.icon;
  const k = data?.kpis;

  const sectionCrew = employees.filter(e => e.active && (!e.section || e.section === section));
  // Operator picker is machine-driven: a machine with assigned operators shows
  // ONLY its crew; unassigned machines fall back to the section crew.
  const startMachine = (data?.machines || []).find(m => String(m.id) === String(machineId));
  const machineCrew = startMachine?.operators?.length ? startMachine.operators : null;
  const start = async (ackShade = false) => {
    const body = {
      operator: operator || undefined,
      machine_id: machineId ? +machineId : undefined,
      line_clearance: needsClearance(section) ? clearancePayload(clearance) : undefined,
      ack_shade: ackShade || undefined,
    };
    try {
      await api.post(`/job-stages/${starting.id}/start`, body);
    } catch (e) {
      // Soft shade-card alarm (internal-approval-pending) — let the operator
      // acknowledge and proceed. Hard blocks (no data.code) toast centrally.
      if (e.data?.code === 'SHADE_CARD_NOT_ELIGIBLE') {
        setShadeAlarm({ shade: e.data.shade });
        return;
      }
      throw e;
    }
    toast.success(`${starting.jc_number} started at ${meta.label}${operator ? ` — ${operator}` : ''}`);
    setStarting(null); setOperator(''); setMachineId(''); setShadeAlarm(null);
    load();
  };
  // One entry point for the count/complete modal — running rows arrive with the
  // counter prefilled to the full expected output (unchanged), partially-done
  // rows arrive blank so the operator types the counter as it reads now.
  const openComplete = r => {
    setCompleting(r);
    setEntryMode(null);
    setRunLog(null);
    api.get(`/job-stages/${r.id}/runs`).then(setRunLog).catch(() => setRunLog(null));
    const partial = r.queue_state === 'partial';
    const exp = expectedOutput(r, section);
    setForm({ qty_out: !partial && exp > 0 ? String(exp) : '', qty_scrap: '0', scrap_reason: '' });
    setVariance({ reason: '', note: '' });
    setPacking([emptyPack()]);
    setQc({ qty_accepted: partial ? '' : (r.qty_in ?? r.upstream_available) ?? '', qty_rejected: '0', qty_rework: '0', scrap_reason: '', inspector: '', remarks: '' });
  };
  // Save a partial day count: the stage stays open, nothing is auto-wasted.
  // Non-QC counters are cumulative (the machine counter as it reads), so the
  // run posted is today's delta over what the log already holds. QC enters
  // today's accepted/rejected directly.
  const savePartial = async () => {
    const priorGood = runLog?.rollup?.qty_good || 0;
    const good = isQC ? (+qc.qty_accepted || 0) : (+form.qty_out || 0) - priorGood;
    const scrap = isQC ? (+qc.qty_rejected || 0) : (+form.qty_scrap || 0);
    const reason = isQC ? qc.scrap_reason : form.scrap_reason;
    await api.post(`/job-stages/${completing.id}/runs`, {
      qty_good: good, qty_scrap: scrap,
      scrap_reason: scrap > 0 ? reason || undefined : undefined,
    });
    const total = priorGood + good;
    const expected = isQC ? ((completing.qty_in ?? completing.upstream_available) || 0) : expectedOutput(completing, section);
    toast.success(`${completing.jc_number} — partial count saved: ${fmt.num(good)} today · ${fmt.num(Math.max(0, expected - total))} to go`);
    setCompleting(null); load();
  };
  const deleteRun = async run => {
    await api.del(`/job-stages/${completing.id}/runs/${run.id}`);
    toast.info(`Day count of ${fmt.num(run.qty_good)} removed`);
    api.get(`/job-stages/${completing.id}/runs`).then(setRunLog).catch(() => {});
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
      const packLines = isPackingStage
        ? packing.map(pl => ({ boxes: +pl.boxes || 0, qty_per_box: +pl.qty_per_box || 0, loose_qty: +pl.loose_qty || 0 }))
            .filter(pl => packLineTotal(pl) > 0)
        : undefined;
      await api.post(`/job-stages/${completing.id}/complete`, {
        qty_out: +form.qty_out, qty_scrap: +form.qty_scrap,
        scrap_reason: +form.qty_scrap > 0 ? form.scrap_reason || undefined : undefined,
        variance_reason: variance.reason || undefined,
        variance_note: variance.note || undefined,
        packing_lines: packLines?.length ? packLines : undefined,
      });
      toast.success(section === 'die_cutting' && completing.gang_number
        ? `${completing.jc_number} — die cutting done, ${completing.gang_number} separated into individual job cards`
        : `${completing.jc_number} — ${meta.label} completed`);
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
  // Row-level adjustment of a completed run: preview the downstream impact
  // first, then save with a mandatory reason. The server cascades qty_in
  // to the next stage in real time and audits old → new.
  const openAdjust = r => {
    setAdjusting(r);
    setAdjForm({ qty_out: String(r.qty_out ?? ''), qty_scrap: String(r.qty_scrap ?? 0), reason: '' });
    setImpact(null);
  };
  useEffect(() => {
    if (!adjusting || adjForm.qty_out === '') return;
    const t = setTimeout(() => {
      api.get(`/job-stages/${adjusting.id}/impact?qty_out=${+adjForm.qty_out || 0}&qty_scrap=${+adjForm.qty_scrap || 0}`)
        .then(setImpact).catch(() => setImpact(null));
    }, 250);
    return () => clearTimeout(t);
  }, [adjusting, adjForm.qty_out, adjForm.qty_scrap]);
  const saveAdjust = async () => {
    await api.post(`/job-stages/${adjusting.id}/adjust`, {
      qty_out: +adjForm.qty_out, qty_scrap: +adjForm.qty_scrap || 0, reason: adjForm.reason,
    });
    toast.success(`${adjusting.jc_number} — ${meta.label} adjusted, downstream updated`);
    setAdjusting(null); load();
  };
  const reverseRun = async () => {
    await api.post(`/job-stages/${reversing.id}/reverse`, { reason: reverseReason });
    toast.info(`${reversing.jc_number} — ${meta.label} reversed to in-progress`);
    setReversing(null); setReverseReason('');
    load();
  };
  // CI-Production counter-first entry: type the machine counter (good output),
  // wastage auto-computes as received − counter. Still editable.
  // In PARTIAL mode the shortfall is work still to come, not wastage — so the
  // auto-fill is off and the wastage box holds only what was really spoilt today.
  const setCounter = v => {
    const expected = expectedOutput(completing, section);
    const out = v === '' ? '' : Math.max(0, +v);
    setForm(f => ({
      ...f,
      qty_out: v === '' ? '' : String(out),
      qty_scrap: entryMode === 'partial' || v === '' ? f.qty_scrap : String(Math.max(0, expected - out)),
    }));
  };
  // Shortfall = the counter reads below the expected output. That is the moment
  // the operator must say whether this is a partial day count or the final one.
  const expectedNow = completing ? (isQC ? ((completing.qty_in ?? completing.upstream_available) || 0) : expectedOutput(completing, section)) : 0;
  const enteredNow = completing
    ? (isQC ? (+qc.qty_accepted || 0) + (+qc.qty_rejected || 0) + (+qc.qty_rework || 0) : (+form.qty_out || 0))
    : 0;
  const entryTouched = completing && (isQC ? qc.qty_accepted !== '' : form.qty_out !== '');
  const hasShortfall = entryTouched && enteredNow < expectedNow;
  const mode = entryMode ?? (hasShortfall ? null : 'final');
  const priorGood = runLog?.rollup?.qty_good || 0;
  const priorScrap = runLog?.rollup?.qty_scrap || 0;
  const todayGood = isQC ? (+qc.qty_accepted || 0) : (+form.qty_out || 0) - priorGood;
  const chooseMode = m => {
    setEntryMode(m);
    if (isQC) return;
    if (m === 'partial') setForm(f => ({ ...f, qty_scrap: '0', scrap_reason: '' }));
    else setForm(f => ({ ...f, qty_scrap: f.qty_out === '' ? f.qty_scrap : String(Math.max(0, expectedNow - (+f.qty_out || 0))) }));
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
          <ExportMenu build={() => {
            const kpiSummary = k ? [
              { label: 'In queue', value: k.pending },
              { label: 'Running', value: k.running },
              { label: 'Completed today', value: k.completed_today },
              { label: 'Produced today', value: fmt.num(k.produced_today) },
              { label: 'Wastage today', value: fmt.num(k.scrap_today) },
              { label: 'Yield', value: k.yield_today != null ? `${k.yield_today}%` : k.yield_all != null ? `${k.yield_all}%` : '—' },
            ] : [];
            if (tab === 'queue') return {
              name: `${meta.label} Queue`,
              title: `${meta.label} — Production Queue`,
              subtitle: 'Live Floor · Station queue',
              meta: [`Filter: ${QUEUE_FILTERS.find(f => f.key === state)?.label || 'All'}`, q ? `Search: "${q}"` : null],
              summary: kpiSummary,
              columns: [
                { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number}${r.gang_number ? ` (${r.gang_number})` : ''}` },
                { key: 'product_name', label: 'Product', export: r => r.gang_members?.length ? gangExportName(r) : `${r.product_name} (${r.product_code})` },
                { key: 'customer_name', label: 'Customer / PO', export: r => r.gang_members?.length
                  ? [...new Set(r.gang_members.map(m => `${m.customer_name} · PO ${m.po_number}`))].join(' | ')
                  : `${r.customer_name} · PO ${r.po_number}` },
                { key: 'process', label: PROCESS_COLUMN[section]?.header || 'Process', render: r => PROCESS_COLUMN[section]?.render(r) },
                { key: 'qty_in', label: `Qty (${queue[0]?.unit || 'units'})`, align: 'right', export: r => fmt.num(r.qty_in ?? r.expected_qty) },
                { key: 'machine_name', label: section === 'printing' ? 'Press' : 'Machine', export: r => (r.machine_name ? `${r.machine_name}${r.machine_model ? ` — ${r.machine_model}` : ''}` : '—') },
                { key: 'operator', label: 'Operator', export: r => r.operator || '—' },
                { key: 'queue_state', label: 'Status', export: r => `${fmt.title(r.queue_state)}${r.queue_state === 'hold' && r.hold_reason ? ` — ${r.hold_reason}` : ''}` },
                { key: 'delivery_date', label: 'Delivery', export: r => fmt.date(r.delivery_date) },
              ],
              rows: queue,
            };
            if (tab === 'completed') return {
              name: `${meta.label} Completed Runs`,
              title: `${meta.label} — Completed Runs`,
              subtitle: 'Live Floor · Station output',
              meta: [`Period: ${PERIODS.find(p => p.key === period)?.label || 'All'}`, q ? `Search: "${q}"` : null],
              summary: kpiSummary,
              columns: [
                { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number}${r.gang_number ? ` (${r.gang_number})` : ''}` },
                { key: 'product_name', label: 'Product', export: r => r.gang_members?.length ? gangExportName(r) : `${r.product_name} · ${r.customer_name}` },
                { key: 'qty_in', label: 'Received', align: 'right', export: r => `${fmt.num(r.qty_in)} ${r.unit}` },
                { key: 'qty_out', label: 'Produced', align: 'right', export: r => fmt.num(r.qty_out) },
                { key: 'qty_scrap', label: 'Wastage', align: 'right', export: r => `${fmt.num(r.qty_scrap)}${r.wastage_pct != null && r.qty_scrap > 0 ? ` (${r.wastage_pct}%)` : ''}${r.scrap_reason ? ` — ${r.scrap_reason}` : ''}` },
                { key: 'yield_pct', label: 'Yield', align: 'right', export: r => (r.yield_pct != null ? `${r.yield_pct}%` : '—') },
                { key: 'operator', label: 'Operator', export: r => r.operator || '—' },
                { key: 'completed_at', label: 'Completed', export: r => fmt.dt(r.completed_at) },
                { key: 'duration_min', label: 'Run Time', align: 'right', export: r => (r.duration_min != null ? `${r.duration_min}m` : '—') },
              ],
              rows: completed,
            };
            return {
              name: `${meta.label} Audit Trail`,
              title: `${meta.label} — Audit Trail`,
              subtitle: 'Live Floor · Every start, hold and completion',
              columns: [
                { key: 'created_at', label: 'When', export: a => fmt.dt(a.created_at) },
                { key: 'jc_number', label: 'Job Card' },
                { key: 'action', label: 'Action', export: a => fmt.title(a.action) },
                { key: 'detail', label: 'Detail', export: a => a.detail || '—' },
                { key: 'user_name', label: 'By', export: a => a.user_name || '—' },
              ],
              rows: data?.audit || [],
            };
          }} />
        </div>
      </div>

      {/* Queue */}
      {tab === 'queue' && (
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className={`${th} text-right`}>S.No.</th>
                <th className={th}>Job Card</th><th className={th}>Product</th><th className={th}>Customer / PO</th>
                <th className={th}>{PROCESS_COLUMN[section]?.header || 'Process'}</th>
                <th className={`${th} text-right`}>Qty ({queue[0]?.unit || 'units'})</th>
                <th className={th}>{section === 'printing' ? 'Press' : 'Machine'}</th><th className={th}>Operator</th><th className={th}>Status</th>
                <th className={th}>Delivery</th>{canOperate() && <th className={th} />}
              </tr></thead>
              <tbody>
                {queue.length === 0 && (
                  <tr><td colSpan={11} className="px-4 py-12 text-center text-sm text-slate-400">Nothing in this view — the section is clear.</td></tr>
                )}
                {queue.map((r, i) => (
                  <tr key={r.id} className={`ci-table-row ${r.gang_members?.length ? 'border-l-[3px] border-violet-400 bg-violet-50/30' : ''}`}>
                    <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                    <td className={`${td} font-bold text-slate-900`}>
                      {r.jc_number}
                      {r.gang_number && <div className="mt-0.5"><GangChip number={r.gang_number} /></div>}
                    </td>
                    <td className={td}><ProductCell r={r} /></td>
                    <td className={td}><CustomerCell r={r} /></td>
                    <td className={`${td} text-xs`}>{PROCESS_COLUMN[section]?.render(r)}</td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(r.qty_in ?? r.expected_qty)}</td>
                    {/* Machine + operator mirror the Print Planning board live —
                        drag a job to another press and both flip here. */}
                    <td className={td}>
                      {r.machine_name ? (<>
                        <div className="text-xs font-bold text-slate-800">{r.machine_name}</div>
                        {r.machine_model && <div className="text-[11px] text-slate-400">{r.machine_model}</div>}
                      </>) : (
                        <span className="text-xs font-semibold text-amber-600">
                          {section === 'printing' ? 'Not assigned — set in Print Planning' : '—'}
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      {r.operator ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">
                          <User size={10} /> {r.operator}
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className={td}>
                      <QueueBadge state={r.queue_state} />
                      {r.queue_state === 'hold' && r.hold_reason && (
                        <div className="mt-0.5 text-[11px] text-red-500">{r.hold_reason}</div>
                      )}
                      {r.queue_state === 'partial' && (
                        <div className="mt-0.5 text-[11px] font-bold tabular-nums text-cyan-700">
                          {fmt.num(r.qty_out || 0)} of {fmt.num(expectedOutput(r, section) || r.expected_qty || 0)} done
                          {r.qty_scrap > 0 && <span className="font-medium text-red-500"> · {fmt.num(r.qty_scrap)} waste</span>}
                        </div>
                      )}
                      {/* Where the feed stands — cutting started / counting / done. */}
                      {r.upstream && (
                        <div className="mt-1">
                          <UpstreamChip upstream={r.upstream} available={r.upstream_available} unit={r.unit} />
                        </div>
                      )}
                    </td>
                    <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.date(r.delivery_date)}</td>
                    {canOperate() && (
                      <td className={`${td} text-right`}>
                        {(r.startable ?? r.queue_state === 'queued') && (
                          <Button size="sm" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                            title={r.queue_state === 'incoming'
                              ? `Start ahead — ${r.upstream ? fmt.stage(r.upstream.stage) : 'the previous stage'} hasn't finished yet; this stage can't be completed until it does`
                              : 'Start this run'}
                            onClick={() => { setStarting(r); setOperator(''); setMachineId(data?.machines?.[0]?.id ? String(data.machines[0].id) : ''); setClearance(freshClearance()); }}>
                            <Play size={12} /> {r.queue_state === 'incoming' ? 'Start ahead' : 'Start'}
                          </Button>
                        )}
                        {(r.queue_state === 'running' || r.queue_state === 'partial') && (
                          <span className="inline-flex gap-1">
                            {r.unit === 'sheets' && (
                              <Button size="sm" variant="ghost" title="Request extra sheets from the warehouse"
                                onClick={() => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); }}>
                                <PackagePlus size={12} /> Sheets
                              </Button>
                            )}
                            <Button size="sm" variant="secondary" onClick={() => setHolding(r)} title="Put on hold"><PauseCircle size={12} /> Hold</Button>
                            <Button size="sm" variant="success" onClick={() => openComplete(r)}
                              title={r.queue_state === 'partial' ? "Record today's count, or finish the stage" : 'Enter the counter and complete'}>
                              <Check size={12} /> {r.queue_state === 'partial' ? 'Count / Finish' : 'Complete'}
                            </Button>
                          </span>
                        )}
                        {r.queue_state === 'hold' && (
                          <span className="inline-flex gap-1">
                            {r.unit === 'sheets' && (
                              <Button size="sm" variant="ghost" title="Request extra sheets from the warehouse"
                                onClick={() => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); }}>
                                <PackagePlus size={12} /> Sheets
                              </Button>
                            )}
                            <Button size="sm" onClick={() => resume(r)}><Play size={12} /> Resume</Button>
                          </span>
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
                {canOperate() && <th className={th} />}
              </tr></thead>
              <tbody>
                {completed.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-sm text-slate-400">No completed runs yet.</td></tr>
                )}
                {completed.map(r => (
                  <tr key={r.id} className={`ci-table-row ${r.gang_members?.length ? 'border-l-[3px] border-violet-400 bg-violet-50/30' : ''}`}>
                    <td className={`${td} font-bold text-slate-900`}>
                      {r.jc_number}
                      {r.gang_number && <div className="mt-0.5"><GangChip number={r.gang_number} /></div>}
                    </td>
                    <td className={td}>{r.gang_members?.length
                      ? <div className="min-w-[220px]"><GangMemberList members={r.gang_members} showOrder={false} /><SheetLine r={r} /></div>
                      : (<><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.customer_name}</div><SheetLine r={r} /></>)}</td>
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
                    {canOperate() && (
                      <td className={`${td} text-right`}>
                        <span className="inline-flex justify-end gap-1">
                          <Button size="sm" variant="ghost" title="Adjust quantities — cascades to the next stage" onClick={() => openAdjust(r)}>
                            <Pencil size={12} /> Adjust
                          </Button>
                          <Button size="sm" variant="ghost" title="Reverse this completed stage" onClick={() => { setReversing(r); setReverseReason(''); }}>
                            <Undo2 size={12} /> Reverse
                          </Button>
                        </span>
                      </td>
                    )}
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
          <Button onClick={() => start()} disabled={needsClearance(section) && !allClear(clearance)}
            title={needsClearance(section) && !allClear(clearance) ? 'Confirm line clearance first' : undefined}>
            <Play size={13} /> Start Run
          </Button>
        </>}>
        {starting && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {starting.gang_number
                ? <span className="font-semibold text-violet-700">{starting.gang_number} — {starting.gang_members?.length || ''} products in one run</span>
                : starting.product_name} · Expected input: <b>{fmt.num(starting.expected_qty)} {starting.unit}</b>
              {starting.machine_name && <> · {starting.machine_name}</>}
              {starting.gang_members?.length > 0 && <GangMemberList members={starting.gang_members} className="mt-2" />}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Run assignment</span><span>{meta.label}</span></div>
              <div className="ci-form-grid">
              {(data?.machines || []).length > 0 && (
                <Field label="Machine">
                  <Select value={machineId} onChange={e => { setMachineId(e.target.value); setOperator(''); }}>
                  {data.machines.map(m => <option key={m.id} value={m.id}>{m.name}{m.operators?.length ? ` — ${m.operators.length} operator${m.operators.length > 1 ? 's' : ''}` : ''}</option>)}
                </Select>
              </Field>
              )}
              <Field label="Operator"
                hint={machineCrew ? `Assigned crew of ${startMachine.name}` : 'Defaults to your own name if left blank'}>
                <Select value={operator} onChange={e => setOperator(e.target.value)}>
                  <option value="">— {auth.user?.name} (me) —</option>
                  {(machineCrew || sectionCrew).map(e => <option key={e.id} value={e.name}>{e.name}{e.role && e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
                </Select>
              </Field>
              </div>
              {startMachine && !machineCrew && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                  No operators are assigned to {startMachine.name} — showing the whole {meta.label} crew.
                  Assign operators in Masters → Machines to tighten this list.
                </p>
              )}
            </section>
            {needsClearance(section) && <LineClearancePanel checks={clearance} onChange={setClearance} />}
          </div>
        )}
      </Modal>

      {/* Soft shade-card alarm — internal approval still pending, but this
          product/customer only requires internal sign-off, so the operator may
          acknowledge and proceed. The ack is audited server-side. */}
      <ConfirmDialog open={!!shadeAlarm} onClose={() => setShadeAlarm(null)} danger
        title="Shade card approval pending"
        message={shadeAlarm
          ? `${shadeAlarm.shade.reason}. Proceed with printing anyway? This acknowledgement is recorded against ${shadeAlarm.shade.sc_number}.`
          : ''}
        confirmLabel="Acknowledge & start"
        onConfirm={() => start(true)} />

      {/* Extra sheets — the operator's controlled path when the run needs more
          board. Raised here, approved by the job card issuer, issued by the
          warehouse. Nothing moves off the pile without both. */}
      <Modal open={!!requesting} onClose={() => setRequesting(null)}
        title={requesting ? `Request Extra Sheets — ${requesting.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setRequesting(null)}>Cancel</Button>
          <Button disabled={!(+reqForm.qty > 0) || !reqForm.reason} onClick={async () => {
            const xs = await api.post('/extra-sheets', {
              job_stage_id: requesting.id, qty: +reqForm.qty,
              reason: reqForm.reason, note: reqForm.note || undefined,
            });
            toast.success(`${xs.xs_number} raised — awaiting approval by the job card issuer, then warehouse issue`);
            setRequesting(null); load();
          }}><PackagePlus size={13} /> Raise Request</Button>
        </>}>
        {requesting && (() => {
          const cpp = Math.max(1, requesting.children_per_parent || 1);
          const qty = Math.max(0, Math.round(+reqForm.qty || 0));
          return (
            <div className="space-y-3">
              <div className="ci-summary-panel text-xs">
                {requesting.product_name} · running at {meta.label} with <b>{fmt.num(requesting.qty_in)} {requesting.unit}</b>
                <div className="mt-1 text-slate-500">
                  Board: <b>{requesting.board_name}</b> · issued so far <b>{fmt.num(requesting.sheets_issued)}</b> parent sheets
                </div>
              </div>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>Extra requirement</span><span>Parent sheets</span></div>
                <div className="ci-form-grid">
                  <Field label="Parent sheets needed" required
                    hint={section !== 'cutting' && qty > 0 ? `= ${fmt.num(qty * cpp)} print sheets after cutting (${cpp}/parent)` : undefined}>
                    <Input type="number" min="1" value={reqForm.qty} autoFocus
                      onChange={e => setReqForm({ ...reqForm, qty: e.target.value })} />
                  </Field>
                  <Field label="Reason" required>
                    <Select value={reqForm.reason} onChange={e => setReqForm({ ...reqForm, reason: e.target.value })}>
                      <option value="">Select reason…</option>
                      {GENERAL_WASTAGE_REASONS.map(r0 => <option key={r0} value={r0}>{r0}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="mt-3">
                  <Field label="Note for the approver">
                    <Input value={reqForm.note} placeholder="Optional — what happened on the machine"
                      onChange={e => setReqForm({ ...reqForm, note: e.target.value })} />
                  </Field>
                </div>
              </section>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                The request goes to the <b>job card issuer</b> for approval and is then <b>issued by the warehouse</b>.
                Stock only moves on issue — it is consumed FIFO against {requesting.jc_number} and this stage's
                received quantity increases automatically.
              </p>
            </div>
          );
        })()}
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
          {mode === 'partial' ? (
            <Button variant="primary" onClick={savePartial}
              disabled={
                !entryTouched || todayGood < 0 ||
                (todayGood === 0 && (isQC ? +qc.qty_rejected : +form.qty_scrap) <= 0) ||
                (isQC ? (+qc.qty_rejected > 0 && !qc.scrap_reason) : (+form.qty_scrap > 0 && !form.scrap_reason))
              }>
              Save Partial Count — Job Continues
            </Button>
          ) : isQC ? (
            <Button variant="success" onClick={complete}
              disabled={mode === null || qc.qty_accepted === '' || (+qc.qty_rejected > 0 && !qc.scrap_reason)}>Pass QC → Finished Goods</Button>
          ) : (
            <Button variant="success" onClick={complete}
              disabled={
                mode === null ||
                form.qty_out === '' ||
                (+form.qty_scrap > 0 && !form.scrap_reason) ||
                (section === 'cutting' &&
                  Math.round(((+form.qty_out || 0) + (+form.qty_scrap || 0)) / Math.max(1, completing?.children_per_parent || 1))
                    !== Math.round(completing?.sheets_issued || completing?.qty_in || 0) &&
                  !variance.reason)
              }>Complete Stage</Button>
          )}
        </>}>
        {/* Partial counter filling — the moment of truth. A counter below the
            expected output is NOT wastage until the operator says so. */}
        {completing && hasShortfall && (
          <div className="mb-3 rounded-xl border-2 border-amber-300 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-800">
              <AlertTriangle size={15} />
              Counter is short — {fmt.num(enteredNow)} of {fmt.num(expectedNow)} {isQC ? 'accounted for' : 'expected'}
            </div>
            <p className="mt-1 text-xs text-amber-700">Is this a partial day count, or the final figure for this stage?</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => chooseMode('partial')}
                className={`rounded-xl border-2 p-2.5 text-left transition-all ${mode === 'partial' ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-200' : 'border-slate-200 bg-white hover:border-cyan-300'}`}>
                <div className="text-sm font-bold text-cyan-800">Partial — more to come</div>
                <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
                  Save today's count and keep the job open here. Nothing goes to wastage.
                </div>
              </button>
              <button type="button" onClick={() => chooseMode('final')}
                className={`rounded-xl border-2 p-2.5 text-left transition-all ${mode === 'final' ? 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200' : 'border-slate-200 bg-white hover:border-emerald-300'}`}>
                <div className="text-sm font-bold text-emerald-800">Final — complete the stage</div>
                <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
                  {isQC ? 'Close QC with these totals.' : 'Close the stage — the shortfall counts as wastage unless you edit it.'}
                </div>
              </button>
            </div>
          </div>
        )}
        {/* Day-wise counts already on the stage — with today's live delta. */}
        {completing && runLog?.runs?.length > 0 && (
          <div className="mb-3 rounded-xl border border-cyan-200 bg-cyan-50/50 p-3">
            <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-cyan-800">
              <span>Recorded so far</span>
              <span className="tabular-nums">{fmt.num(priorGood)} good · {fmt.num(priorScrap)} waste</span>
            </div>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {runLog.runs.map(run => (
                  <tr key={run.id} className="border-t border-cyan-100">
                    <td className="py-1.5 pr-2 tabular-nums text-slate-500">{fmt.date(run.run_date)}</td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums text-emerald-700">{fmt.num(run.qty_good)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-red-600">
                      {run.qty_scrap > 0 ? <>{fmt.num(run.qty_scrap)}{run.scrap_reason && <span className="ml-1 text-[10px] text-red-400">({run.scrap_reason})</span>}</> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-[11px] text-slate-500">{run.operator || '—'}{run.note ? ` · ${run.note}` : ''}</td>
                    <td className="py-1.5 text-right">
                      {completing.status !== 'completed' && (
                        <button type="button" title="Remove this day count" onClick={() => deleteRun(run)}
                          className="rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500">
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!isQC && entryTouched && todayGood < 0 && (
              <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700">
                Counter ({fmt.num(+form.qty_out || 0)}) reads below the {fmt.num(priorGood)} already recorded — check the entry, or delete a wrong day count above.
              </p>
            )}
            {!isQC && entryTouched && todayGood > 0 && mode === 'partial' && (
              <p className="mt-2 text-[11px] font-semibold text-cyan-700">Today adds {fmt.num(todayGood)} to the log.</p>
            )}
          </div>
        )}
        {completing && isQC && (() => {
          const acc = +qc.qty_accepted || 0, rej = +qc.qty_rejected || 0, rw = +qc.qty_rework || 0;
          const inSt = (completing.qty_in ?? completing.upstream_available) || 0;
          const accountedOver = acc + rej + rw > inSt;
          return (
            <div className="space-y-3">
              <div className="ci-summary-panel text-xs">
                {completing.product_name} · Presented to QC: <b>{fmt.num(inSt)} cartons</b>
                {completing.qty_in == null && completing.upstream?.status === 'partially_completed' && (
                  <span className="ml-2 font-semibold text-amber-600">so far from {fmt.stage(completing.upstream.stage)} — still counting there</span>
                )}
                {inSt > 0 && <span className="ml-2">→ accept rate <b>{(100 * acc / inSt).toFixed(1)}%</b></span>}
              </div>
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span>QC quantities</span><span>Inspection</span></div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Field label={mode === 'partial' ? 'Accepted today' : 'Accepted'} required>
                  <Input type="number" min="0" value={qc.qty_accepted} onChange={e => setQc({ ...qc, qty_accepted: e.target.value })} autoFocus />
                </Field>
                <Field label={mode === 'partial' ? 'Rejected today' : 'Rejected'}>
                  <Input type="number" min="0" value={qc.qty_rejected} onChange={e => setQc({ ...qc, qty_rejected: e.target.value })} />
                </Field>
                {mode !== 'partial' && (
                <Field label="Rework">
                  <Input type="number" min="0" value={qc.qty_rework} onChange={e => setQc({ ...qc, qty_rework: e.target.value })} />
                </Field>
                )}
                </div>
              </section>
              {accountedOver && mode !== 'partial' && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">Accepted + rejected + rework ({fmt.num(acc + rej + rw)}) exceeds presented ({fmt.num(inSt)}).</p>}
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
              {mode !== 'partial' && (
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
              )}
              {mode === 'partial' ? (
                <p className="rounded-lg bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-700">
                  Inspection continues — {fmt.num(acc)} accepted today goes on the day log. Finished Goods receives the full accepted total when QC finally passes.
                </p>
              ) : (
              <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                {fmt.num(acc)} accepted cartons will be released to Finished Goods (batch {completing.jc_number}).
              </p>
              )}
            </div>
          );
        })()}
        {completing && !isQC && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {completing.gang_number
                ? <span className="font-semibold text-violet-700">{completing.gang_number} — one combined count for the whole gang</span>
                : completing.product_name} · Received: <b>{fmt.num(completing.qty_in ?? completing.upstream_available ?? 0)} {completing.unit}</b>
              {completing.qty_in == null && completing.upstream?.status === 'partially_completed' && (
                <span className="ml-2 font-semibold text-amber-600">
                  so far from {fmt.stage(completing.upstream.stage)} — still counting there
                </span>
              )}
              {section === 'cutting' && completing.children_per_parent > 1 && (
                <span className="ml-2 text-slate-500">
                  → {completing.children_per_parent} cuts/parent = <b>{fmt.num(expectedOutput(completing, section))}</b> print sheets
                </span>
              )}
              {form.qty_out !== '' && expectedOutput(completing, section) > 0 && (
                <span className="ml-2 text-slate-500">
                  → yield <b>{(100 * (+form.qty_out) / expectedOutput(completing, section)).toFixed(1)}%</b>
                </span>
              )}
            </div>
            {section === 'cutting' && mode !== 'partial' && completing.children_per_parent >= 1 && (() => {
              const cpp = Math.max(1, completing.children_per_parent || 1);
              const plannedParents = Math.round(completing.sheets_issued || completing.qty_in || 0);
              const actualParents = Math.round(((+form.qty_out || 0) + (+form.qty_scrap || 0)) / cpp);
              const delta = actualParents - plannedParents;
              if (form.qty_out === '' || delta === 0) return null;
              const over = delta > 0;
              return (
                <section className="ci-form-panel" style={{ borderColor: '#f59e0b' }}>
                  <div className="ci-form-panel-title">
                    <span className="text-amber-700">⚠ Cutting {over ? 'more' : 'fewer'} than the job card</span>
                    <span>Reason required</span>
                  </div>
                  <p className="px-1 pb-2 text-xs text-slate-600">
                    Job card: <b>{fmt.num(plannedParents)}</b> parents · You're cutting{' '}
                    <b>{fmt.num(actualParents)}</b> ({over ? '+' : ''}{fmt.num(delta)}).{' '}
                    {over
                      ? <>Warehouse will consume <b>{fmt.num(delta)}</b> more parent sheets.</>
                      : <>Warehouse will refund <b>{fmt.num(-delta)}</b> parent sheets.</>}
                  </p>
                  <div className="ci-form-grid">
                    <Field label="Reason" required>
                      <Select value={variance.reason} onChange={e => setVariance({ ...variance, reason: e.target.value })}>
                        <option value="">Select reason…</option>
                        {CUTTING_VARIANCE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </Select>
                    </Field>
                    <Field label="Note" hint="Optional">
                      <Input value={variance.note} onChange={e => setVariance({ ...variance, note: e.target.value })} placeholder="e.g. sealed 500-pack, cut all" />
                    </Field>
                  </div>
                </section>
              );
            })()}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Counter entry</span><span>{meta.label}</span></div>
              <div className="ci-form-grid">
              <Field
                label={priorGood > 0 ? `Counter now — total good ${completing.unit}` : `Actual counter — good ${completing.unit}`}
                required
                hint={mode === 'partial'
                  ? (priorGood > 0 ? `Cumulative, as the counter reads — ${fmt.num(priorGood)} already recorded` : 'The shortfall stays pending, not wasted')
                  : 'Wastage auto-computes from received − counter'}>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setCounter(e.target.value)} autoFocus />
              </Field>
              <Field label={mode === 'partial' ? `Wastage today (${completing.unit}) — optional` : `Wastage (${completing.unit})`}>
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
            {isPackingStage && mode !== 'partial' && (() => {
              const total = packTotal(packing);
              const boxes = packing.reduce((s, pl) => s + (Math.max(0, +pl.boxes || 0)) + (+pl.loose_qty > 0 ? 1 : 0), 0);
              const setPack = (i, patch) => setPacking(p => p.map((pl, j) => (j === i ? { ...pl, ...patch } : pl)));
              const onPaste = (i, e) => {
                const rows = parsePackingPaste(e.clipboardData?.getData('text'));
                if (rows.length <= 1) return; // single value → normal input behaviour
                e.preventDefault();
                setPacking(p => [...p.slice(0, i), ...rows, ...p.slice(i + 1)]);
              };
              return (
              <section className="ci-form-panel border-dashed">
                <div className="ci-form-panel-title">
                  <span>Packing manifest</span>
                  <span>Full boxes · loose boxes · loose pieces — paste rows straight from Excel</span>
                </div>
                <div className="space-y-1.5">
                  <div className="grid grid-cols-[1fr_1fr_1fr_90px_34px] gap-2 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    <span>Boxes</span><span>Qty / box</span><span>Loose pcs</span><span className="text-right">Line total</span><span />
                  </div>
                  {packing.map((pl, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_90px_34px] items-center gap-2">
                      <Input type="number" min="0" placeholder="0" value={pl.boxes}
                        onPaste={e => onPaste(i, e)}
                        onChange={e => setPack(i, { boxes: e.target.value })} />
                      <Input type="number" min="0" placeholder="0" value={pl.qty_per_box}
                        onPaste={e => onPaste(i, e)}
                        onChange={e => setPack(i, { qty_per_box: e.target.value })} />
                      <Input type="number" min="0" placeholder="0" value={pl.loose_qty}
                        onChange={e => setPack(i, { loose_qty: e.target.value })} />
                      <div className="rounded-lg bg-slate-50 px-2 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                        {packLineTotal(pl) ? fmt.num(packLineTotal(pl)) : '—'}
                      </div>
                      <button type="button" title="Remove line" disabled={packing.length === 1}
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                        onClick={() => setPacking(p => p.filter((_, j) => j !== i))}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button variant="ghost" size="sm" onClick={() => setPacking(p => [...p, emptyPack()])}>
                      <Plus size={13} /> Add line
                    </Button>
                    {total > 0 && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="rounded-full bg-brand-50 px-2.5 py-1 font-bold tabular-nums text-brand-700">
                          {fmt.num(total)} cartons · {boxes} boxes
                        </span>
                        {+form.qty_out !== total && (
                          <Button size="sm" variant="secondary" onClick={() => setCounter(String(total))}>
                            Use as counter
                          </Button>
                        )}
                        {+form.qty_out > 0 && +form.qty_out !== total && (
                          <span className="font-semibold text-amber-600">differs from counter ({fmt.num(+form.qty_out)})</span>
                        )}
                        {+form.qty_out === total && <span className="font-semibold text-emerald-600">matches counter ✓</span>}
                      </div>
                    )}
                  </div>
                </div>
              </section>
              );
            })()}
          </div>
        )}
      </Modal>

      {/* Adjust modal — permitted change to a completed run with impact preview.
          Downstream stages update in real time; unsafe edits are blocked. */}
      <Modal open={!!adjusting} onClose={() => setAdjusting(null)}
        title={adjusting ? `Adjust ${meta.label} — ${adjusting.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setAdjusting(null)}>Cancel</Button>
          <Button onClick={saveAdjust}
            disabled={adjForm.qty_out === '' || !adjForm.reason.trim() || !!impact?.blocked}>
            Save &amp; Update Downstream
          </Button>
        </>}>
        {adjusting && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {adjusting.product_name} · Received: <b>{fmt.num(adjusting.qty_in)} {adjusting.unit}</b>
              <span className="ml-2 text-slate-500">recorded: {fmt.num(adjusting.qty_out)} good · {fmt.num(adjusting.qty_scrap)} wastage</span>
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Corrected quantities</span><span>{meta.label}</span></div>
              <div className="ci-form-grid">
                <Field label={`Good output (${adjusting.unit})`} required>
                  <Input type="number" min="0" value={adjForm.qty_out} autoFocus
                    onChange={e => setAdjForm({ ...adjForm, qty_out: e.target.value })} />
                </Field>
                <Field label={`Wastage (${adjusting.unit})`}>
                  <Input type="number" min="0" value={adjForm.qty_scrap}
                    onChange={e => setAdjForm({ ...adjForm, qty_scrap: e.target.value })} />
                </Field>
              </div>
            </section>
            {/* Impact preview — what changes downstream before anything is saved */}
            {impact && (impact.blocked ? (
              <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-700">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {impact.blocked}
              </p>
            ) : (
              <section className="ci-form-panel border-dashed">
                <div className="ci-form-panel-title"><span>Impact preview</span><span>Applied on save</span></div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                    <span className="font-semibold text-slate-700">{fmt.stage(adjusting.stage)} output</span>
                    <span className="tabular-nums text-slate-500">
                      <span className="line-through">{fmt.num(impact.old.qty_out)}</span>
                      <span className="mx-1.5 text-slate-300">→</span>
                      <b className="text-slate-900">{fmt.num(impact.new.qty_out)}</b>
                    </span>
                  </div>
                  {impact.downstream.length === 0 && (
                    <p className="px-1 text-slate-400">No downstream stage has started yet — the next stage will simply receive the new quantity.</p>
                  )}
                  {impact.downstream.map(d => (
                    <div key={d.id} className="flex items-center justify-between rounded-lg bg-amber-50/70 px-3 py-2">
                      <span className="font-semibold text-slate-700">
                        {fmt.stage(d.stage)} <span className="ml-1 font-medium text-slate-400">({d.status.replace('_', ' ')})</span>
                      </span>
                      {d.new_qty_in != null ? (
                        <span className="tabular-nums text-slate-500">
                          receives <span className="line-through">{fmt.num(d.old_qty_in)}</span>
                          <span className="mx-1.5 text-slate-300">→</span>
                          <b className="text-slate-900">{fmt.num(d.new_qty_in)}</b>
                        </span>
                      ) : <span className="text-slate-400">{d.note}</span>}
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <section className="ci-form-panel">
              <Field label="Reason for adjustment" required hint="Recorded in the audit trail with old → new values">
                <Input value={adjForm.reason} placeholder="e.g. counter misread, recount after sorting"
                  onChange={e => setAdjForm({ ...adjForm, reason: e.target.value })} />
              </Field>
            </section>
          </div>
        )}
      </Modal>

      <Modal open={!!reversing} onClose={() => setReversing(null)}
        title={reversing ? `Reverse ${meta.label} — ${reversing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReversing(null)}>Cancel</Button>
          <Button variant="secondary" onClick={reverseRun} disabled={!reverseReason.trim()}>
            <Undo2 size={13} /> Reverse Stage
          </Button>
        </>}>
        {reversing && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {reversing.product_name} · recorded: <b>{fmt.num(reversing.qty_out)}</b> good
              {reversing.qty_scrap > 0 && <span> · {fmt.num(reversing.qty_scrap)} wastage</span>}
            </div>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              This sends the completed row back to in-progress. It is blocked if a downstream stage has already started or the job is closed.
            </p>
            <Field label="Reason for reverse" required>
              <Input value={reverseReason} placeholder="e.g. wrong completion, recount required, QC hold"
                onChange={e => setReverseReason(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
