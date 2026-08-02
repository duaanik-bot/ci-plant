// Sort & Paste — the unified sorting + pasting workstation.
//
// One operator screen consolidates two plant stages that used to be separate:
//   1. Sort      — count good vs reject.
//   2. Waste gate — the mandatory hand-off; sorted waste is locked here and the
//                   sorted-good pool (received − waste) becomes the pasting input.
//   3. Hybrid paste — one or more rows, each pasted by machine, by hand, by BOTH
//                   on the same pieces (side-paste → hand-lock), or split across
//                   the two. Every row obeys  input = good + waste; the rows must
//                   cover exactly the sorted-good pool.
//   4. Pack      — the packing manifest, then Complete.
// The two job_stages stay separate in the ledger; the completion is one atomic
// call to /sort-paste/:jobCardId/complete.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { ActionMenu, Button, ExportMenu, Field, Input, Modal, rowMatches, SearchInput, searchText, Select, Tabs, UpstreamChip, useToast } from '../components/ui.jsx';
import {
  ArrowLeft, Play, Check, Gauge, PackagePlus, PackageMinus, Percent, History,
  PauseCircle, Plus, Trash2, User, Combine, AlertTriangle, Scissors, Undo2, Wand2,
} from 'lucide-react';
import { SORT_PASTE_META, SORTING_REJECTION_REASONS, GENERAL_WASTAGE_REASONS, HOLD_REASONS, PASTING_METHODS } from '../sections.js';
import LineClearancePanel, { freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import { CumulativeSummary, ModeChoice, postRun } from '../components/DayCount.jsx';
import { partialBlockers, resolveEntry } from '../lib/partialEntry.js';
import { receivedQty } from '../lib/received.js';
import { pickerMode, operatorChips, rowsForOperator, runsForOperator, readPick, writePick } from '../lib/operatorScope.js';
import { OperatorRail, RecordingAs } from '../components/OperatorRail.jsx';
import { isCardTier, useTier } from '../lib/tier.js';
import { useSendBack, SendBackDialog } from '../components/SendBack.jsx';

// This screen IS the pasting station — /floor/pasting redirects here.
const SECTION = 'sort-paste';

const canOperate = () => ['admin', 'production'].includes(auth.user?.role);

// The day's output and wastage totals are server aggregates over stage_runs that
// the client cannot re-derive per man, so when a man is picked they say plainly
// that they still count the whole station rather than pretending to be his.
const WHOLE_STATION = 'whole station';

const PERIODS = [
  { key: 'today', label: 'Today' }, { key: 'week', label: '7 Days' },
  { key: 'month', label: 'This Month' }, { key: 'fy', label: 'This FY' }, { key: 'all', label: 'All' },
];
function inPeriod(dateStr, period) {
  if (period === 'all' || !dateStr) return period === 'all';
  const d = new Date(dateStr), now = new Date();
  if (period === 'today') return d.toDateString() === now.toDateString();
  if (period === 'week') return now - d < 7 * 864e5;
  if (period === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (period === 'fy') {
    const fyStart = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1);
    return d >= fyStart;
  }
  return true;
}

// ── Row-level pasting maths ──────────────────────────────────────────────────
// A grid row holds the raw inputs; good/waste/input derive from the method.
const emptyRow = () => ({ method: 'machine_manual', both: '', auto: '', manual: '', machine_id: '', waste: '', waste_reason: '' });
function rowGood(r) {
  if (r.method === 'machine') return Math.max(0, +r.auto || 0);
  if (r.method === 'manual') return Math.max(0, +r.manual || 0);
  if (r.method === 'machine_manual') return Math.max(0, +r.both || 0);
  return Math.max(0, +r.auto || 0) + Math.max(0, +r.manual || 0); // split
}
const rowWaste = r => Math.max(0, +r.waste || 0);
const rowInput = r => rowGood(r) + rowWaste(r);
// Map a UI row → the server's { auto_qty, manual_qty } shape.
function rowToPayload(r) {
  const waste = rowWaste(r);
  const base = { method: r.method, input_qty: rowInput(r), waste_qty: waste,
    waste_reason: waste > 0 ? r.waste_reason || undefined : undefined,
    auto_machine_id: r.machine_id ? +r.machine_id : undefined };
  if (r.method === 'machine') return { ...base, auto_qty: Math.max(0, +r.auto || 0), manual_qty: 0 };
  if (r.method === 'manual') return { ...base, auto_qty: 0, manual_qty: Math.max(0, +r.manual || 0) };
  if (r.method === 'machine_manual') { const n = Math.max(0, +r.both || 0); return { ...base, auto_qty: n, manual_qty: n }; }
  return { ...base, auto_qty: Math.max(0, +r.auto || 0), manual_qty: Math.max(0, +r.manual || 0) };
}
const emptyPack = () => ({ boxes: '', qty_per_box: '', loose_qty: '' });
const packLineTotal = pl => (Math.max(0, +pl.boxes || 0) * Math.max(0, +pl.qty_per_box || 0)) + Math.max(0, +pl.loose_qty || 0);
const needsMachine = m => m === 'machine' || m === 'machine_manual' || m === 'split';

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
function QueueBadge({ state, phase }) {
  const map = { running: 'bg-amber-50 text-amber-700', partial: 'bg-cyan-50 text-cyan-700', hold: 'bg-red-50 text-red-700', queued: 'bg-brand-50 text-brand-700', incoming: 'bg-slate-100 text-slate-500' };
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[state]}`}>
        {state === 'running' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-amber-500" />}
        {state === 'partial' && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-cyan-500" />}
        {state === 'hold' ? 'on hold' : state === 'partial' ? 'partially done' : state}
      </span>
      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${phase === 'paste' ? 'text-violet-500' : 'text-fuchsia-500'}`}>
        {phase === 'paste' ? <><Combine size={10} /> pasting</> : <><Scissors size={10} /> sorting</>}
      </span>
    </span>
  );
}
function YieldPill({ pct }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const cls = pct >= 98 ? 'text-emerald-700 bg-emerald-50' : pct >= 95 ? 'text-amber-700 bg-amber-50' : 'text-red-700 bg-red-50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${cls}`}>{pct}%</span>;
}

export default function SortPaste() {
  const tier = useTier();
  // "phone" here means the CARD presentation — phones and upright tablets.
  const phone = isCardTier(tier);
  const touchTable = tier === 'tabl';
  const touchUI = tier !== 'desktop';
  const meta = SORT_PASTE_META;
  const Icon = meta.icon;
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('queue');
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [period, setPeriod] = useState('all');
  const [employees, setEmployees] = useState([]);
  // start (sorting) modal
  const [starting, setStarting] = useState(null);
  const [operator, setOperator] = useState('');
  const [clearance, setClearance] = useState([]);
  // hold modal
  const [holding, setHolding] = useState(null);
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  // process wizard
  const [proc, setProc] = useState(null);           // queue row being processed
  const [waste, setWaste] = useState({ qty: '0', reason: '' });
  // Until the operator edits the split, ALL the wastage is assumed to be sorting
  // rejection — the gate below prefills itself and paste waste stays 0.
  const [wasteTouched, setWasteTouched] = useState(false);
  const [rows, setRows] = useState([emptyRow()]);
  const [packing, setPacking] = useState([emptyPack()]);
  const [pasteWasteReason, setPasteWasteReason] = useState('');   // single reason for the derived paste waste
  const [pasteOperator, setPasteOperator] = useState('');
  const [saving, setSaving] = useState(false);
  // partial day count on the active stage
  const [daycount, setDaycount] = useState(null);
  const [dayForm, setDayForm] = useState({ good: '', waste: '0', reason: '' });
  // reverse (redo) a completed run
  const [reversing, setReversing] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  // Hand a job back one station — bad blanks belong at die cutting, not here.
  // Shared with Section.jsx so the manifest an operator signs is identical.
  const sb = useSendBack({ toast, onDone: () => load() });
  // Who is on the machine. Sorting and pasting share this floor device, so the
  // pick is both a view filter and the name filed against what he records.
  const [pick, setPick] = useState(null);
  const restoredRef = useRef(false);

  const load = () => api.get('/floor/sort-paste').then(setData);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    const onWake = () => load();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onWake); window.removeEventListener('focus', onWake); };
  }, []);
  useEffect(() => { api.get('/employees').then(setEmployees); }, []);

  const machines = data?.machines || [];
  const autoMachines = machines.filter(m => !m.is_manual);
  const defMachine = autoMachines[0] ? String(autoMachines[0].id) : '';
  const sectionCrew = employees.filter(e => e.active && (!e.section || e.section === 'sorting' || e.section === 'pasting'));

  // Every name Masters knows for this screen — the machines' crews plus anyone
  // filed under sorting or pasting, because "Manual Pasting" carries no crew at
  // all and its man still has to be able to sign his work.
  const pickMode = pickerMode(SECTION);
  const chips = useMemo(
    () => (pickMode ? operatorChips(data?.machines, { mode: pickMode, employees, section: SECTION }) : []),
    [pickMode, data?.machines, employees]);
  useEffect(() => {
    if (!chips.length || restoredRef.current) return;
    restoredRef.current = true;
    setPick(readPick(SECTION, chips));
  }, [chips]);
  useEffect(() => {
    if (pick && chips.length && !chips.some(c => c.key === pick.key)) setPick(null);
  }, [chips, pick]);
  // A man's own tap CANCELS the pending restore — see Section.jsx for why.
  const choosePick = c => { restoredRef.current = true; setPick(c); writePick(SECTION, c); };

  // His work: everything nobody has taken, plus what he took. A colleague's
  // running job drops away; a finished run belongs to whoever ran it.
  const mineQueue = useMemo(() => rowsForOperator(data?.queue || [], pick), [data, pick]);
  const mineCompleted = useMemo(() => runsForOperator(data?.completed || [], pick), [data, pick]);

  const queue = useMemo(() => {
    let list = mineQueue;
    if (q) list = list.filter(r => rowMatches(r, q));
    return list;
  }, [mineQueue, q]);
  const completed = useMemo(() => {
    let list = mineCompleted;
    if (period !== 'all') list = list.filter(r => inPeriod(r.completed_at, period));
    if (q) list = list.filter(r => rowMatches(r, q));
    return list;
  }, [mineCompleted, q, period]);

  // Only the cards that DESCRIBE THE LIST are re-scoped to the picked man —
  // In Queue and Running are counted off the same rows shown beneath them.
  //
  // The day's output and wastage cards are NOT: this station's server totals
  // come from a SQL aggregate over stage_runs (sorted vs paste waste split),
  // which the client does not hold and must not guess at. They stay whole-station
  // and say so, rather than being quietly wrong.
  const k = useMemo(() => {
    if (!data?.kpis) return data?.kpis;
    if (!pick) return data.kpis;
    return {
      ...data.kpis,
      pending: mineQueue.filter(s => s.queue_state === 'queued').length,
      incoming: mineQueue.filter(s => s.queue_state === 'incoming').length,
      running: mineQueue.filter(s => ['running', 'partial'].includes(s.queue_state)).length,
      on_hold: mineQueue.filter(s => s.queue_state === 'hold').length,
    };
  }, [data, pick, mineQueue]);

  // Received & sorted-good for whichever phase this job is in.
  const received = proc ? (proc.phase === 'paste' ? proc.sorting_qty_out : receivedQty(proc)) ?? 0 : 0;
  const sortedWaste = proc?.phase === 'paste' ? 0 : Math.max(0, +waste.qty || 0);
  // Pool the rows must cover. Sorted waste (entered below) carves the sorting
  // portion out of the total wastage, so the pool = received − sorted waste.
  const goodToPaste = proc?.phase === 'paste' ? received : Math.max(0, received - sortedWaste);
  const pastedGood = rows.reduce((s, r) => s + rowGood(r), 0);
  // Paste waste is DERIVED, not typed — whatever of the pool wasn't pasted good.
  const pasteWaste = Math.max(0, goodToPaste - pastedGood);
  const totalWastage = Math.max(0, received - pastedGood);   // sort + paste, auto from good
  const overPasted = pastedGood > goodToPaste;
  const remaining = goodToPaste - pastedGood;                // unpasted → becomes paste waste
  const wasteReasonMissing = proc?.phase !== 'paste' && sortedWaste > 0 && !waste.reason;
  const pasteReasonMissing = pasteWaste > 0 && !pasteWasteReason;
  const balanced = pastedGood > 0 && !overPasted && goodToPaste > 0;

  const openProcess = row => {
    setProc(row);
    const good = row.phase === 'paste' ? (row.sorting_qty_out ?? 0) : receivedQty(row);
    setWaste({ qty: '0', reason: '' });
    // Seed one row pre-allocated to the whole sorted-good pool on the default
    // (machine + hand) method — the common case needs zero typing.
    setRows([{ ...emptyRow(), machine_id: defMachine, both: good ? String(good) : '' }]);
    setPacking([emptyPack()]);
    setPasteWasteReason('');
    setPasteOperator('');
  };
  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows(rs => [...rs, { ...emptyRow(), machine_id: defMachine }]);
  // One-tap: pour the still-unallocated sorted-good pieces into this row's
  // primary quantity, so the operator never does the subtraction by hand.
  const fillRemaining = i => setRows(rs => rs.map((r, j) => {
    if (j !== i) return r;
    const others = rs.reduce((s, x, kk) => s + (kk === i ? 0 : rowInput(x)), 0);
    const want = Math.max(0, goodToPaste - others - rowWaste(r));
    if (r.method === 'machine') return { ...r, auto: String(want) };
    if (r.method === 'manual') return { ...r, manual: String(want) };
    if (r.method === 'machine_manual') return { ...r, both: String(want) };
    const manual = Math.max(0, +r.manual || 0);
    return { ...r, auto: String(Math.max(0, want - manual)) };
  }));

  const start = async () => {
    await api.post(`/job-stages/${starting.sorting_stage_id}/start`, {
      operator: operator || undefined,
      line_clearance: clearancePayload(clearance),
    });
    toast.success(`${starting.jc_number} started at Sort & Paste${operator ? ` — ${operator}` : ''}`);
    setStarting(null); setOperator(''); load();
  };
  const hold = async () => {
    await api.post(`/job-stages/${holding.active_stage_id}/hold`, { reason: holdReason, operator: pick?.name || undefined });
    toast.info(`${holding.jc_number} put on hold — ${holdReason}`);
    setHolding(null); setHoldReason(HOLD_REASONS[0]); load();
  };
  const resume = async r => { await api.post(`/job-stages/${r.active_stage_id}/resume`, {}); toast.success(`${r.jc_number} resumed`); load(); };
  // Partial day count on the ACTIVE stage (sorting until it completes, then
  // pasting) — today's good + waste go on the day log, the job stays open, and
  // the final atomic Sort & Paste completion reconciles against the log.
  const openDayCount = r => { setDaycount(r); setDayForm({ good: '', waste: '0', reason: '' }); };
  const saveDayCount = async () => {
    const good = +dayForm.good || 0, waste = +dayForm.waste || 0;
    await postRun(daycount.active_stage_id, { good, scrap: waste, reason: dayForm.reason, operator: pick?.name });
    toast.success(`${daycount.jc_number} — partial count saved: ${fmt.num(good)} ${daycount.phase === 'paste' ? 'pasted' : 'sorted'} today`);
    setDaycount(null); load();
  };
  const reverseRun = async () => {
    await api.post(`/sort-paste/${reversing.job_card_id}/reverse`, { reason: reverseReason });
    toast.info(`${reversing.jc_number} — Sort & Paste reversed, back on the floor to redo`);
    setReversing(null); setReverseReason(''); load();
  };

  const submit = async () => {
    setSaving(true);
    try {
      const packLines = packing.map(pl => ({ boxes: +pl.boxes || 0, qty_per_box: +pl.qty_per_box || 0, loose_qty: +pl.loose_qty || 0 }))
        .filter(pl => packLineTotal(pl) > 0);
      const firstMachine = rows.map(r => r.machine_id).find(Boolean);
      // Build the row payloads (good only), then attribute the single derived
      // paste-waste to the first row so the server's per-row `input = good +
      // waste` and `total input = sorted-good` both reconcile.
      const rowPayloads = rows.filter(r => rowGood(r) > 0).map(rowToPayload);
      if (rowPayloads.length && pasteWaste > 0) {
        rowPayloads[0] = {
          ...rowPayloads[0],
          input_qty: rowPayloads[0].input_qty + pasteWaste,
          waste_qty: pasteWaste,
          waste_reason: pasteWasteReason || 'Pasting wastage',
        };
      }
      await api.post(`/sort-paste/${proc.job_card_id}/complete`, {
        sorted_waste: proc.phase === 'paste' ? undefined : sortedWaste,
        sorted_waste_reason: proc.phase === 'paste' ? undefined : (sortedWaste > 0 ? waste.reason : undefined),
        rows: rowPayloads,
        packing_lines: packLines.length ? packLines : undefined,
        paste_machine_id: firstMachine ? +firstMachine : undefined,
        paste_operator: pasteOperator || pick?.name || undefined,
      });
      toast.success(`${proc.jc_number} — sorted & pasted, ${fmt.num(pastedGood)} cartons to QC`);
      setProc(null); load();
    } finally { setSaving(false); }
  };

  // Headers may wrap — that costs one header row, not every data row. The data
  // cells are the ones pinned to a width so they truncate instead of stacking.
  const th = 'px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-2 py-1.5 align-middle';
  const hug = 'w-px whitespace-nowrap';

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
            {machines.map(m => (
              <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full border border-white/70 bg-white/65 backdrop-blur-xl px-3 py-1 text-xs font-semibold text-slate-600 shadow-sm">
                <span className={`h-1.5 w-1.5 rounded-full ${m.status === 'running' ? 'bg-emerald-500' : m.status === 'maintenance' ? 'bg-red-500' : 'bg-slate-300'}`} />
                {m.name}{m.is_manual ? <span className="text-[10px] font-bold text-violet-500">MANUAL</span> : null}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        <Kpi label="In Queue" value={k ? k.pending : '…'} sub={k ? `${k.incoming} upstream` : ''} icon={History} />
        <Kpi label="Running" value={k ? k.running : '…'} icon={Play} chip="bg-amber-50 text-amber-600" accent={k?.running ? 'text-amber-600' : 'text-slate-900'} sub={k?.on_hold > 0 ? `${k.on_hold} on hold` : ''} />
        <Kpi label="Completed Today" value={k ? k.completed_today : '…'} icon={Check} chip="bg-emerald-50 text-emerald-600" sub={pick ? WHOLE_STATION : ''} />
        <Kpi label="Received Today" value={k ? fmt.num(k.received_today) : '…'} icon={PackagePlus} sub={pick ? WHOLE_STATION : ''} />
        <Kpi label="Pasted Today" value={k ? fmt.num(k.produced_today) : '…'} icon={Gauge} chip="bg-emerald-50 text-emerald-600" accent="text-emerald-600" sub={pick ? WHOLE_STATION : ''} />
        <Kpi label="Wastage Today" value={k ? fmt.num(k.scrap_today) : '…'} icon={PackageMinus} chip="bg-red-50 text-red-500"
          accent={k?.scrap_today > 0 ? 'text-red-600' : 'text-slate-900'} sub={k ? `sort ${fmt.num(k.sorted_waste_today)} · paste ${fmt.num(k.paste_waste_today)}${pick ? ` · ${WHOLE_STATION}` : ''}` : ''} />
        <Kpi label="Yield" value={k?.yield_today != null ? `${k.yield_today}%` : '—'} sub={pick ? `today · ${WHOLE_STATION}` : 'today'} icon={Percent} chip="bg-brand-50 text-brand-600"
          accent={k?.yield_today >= 98 ? 'text-emerald-600' : k?.yield_today >= 95 ? 'text-amber-600' : 'text-slate-900'} />
      </div>

      {/* Toolbar — phone: each band is a swipe rail; nothing wraps or clips. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 ph:mb-2 ph:block ph:space-y-2">
        {/* Tabs and the operator rail read as one left-hand group — the counts
            follow the pick, so a man's tab says how much work HE has. */}
        <div className="flex flex-wrap items-center gap-2 ph:flex-nowrap ph:overflow-x-auto ph:pb-1 scrollbar-none">
          <Tabs active={tab} onChange={setTab} tabs={[
            { key: 'queue', label: touchUI ? 'Queue' : 'Production Queue', count: mineQueue.length },
            { key: 'completed', label: touchUI ? 'Completed' : 'Completed Runs', count: mineCompleted.length },
            { key: 'audit', label: touchUI ? 'Audit' : 'Audit Trail' },
          ]} />
          <OperatorRail chips={chips} pick={pick} onPick={choosePick} mode={pickMode} />
        </div>
        <div className="mb-4 flex items-center gap-2 ph:mb-0 ph:flex-nowrap ph:overflow-x-auto ph:pb-1 scrollbar-none">
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
            if (tab === 'completed') return {
              name: 'Sort & Paste Completed Runs', title: 'Sort & Paste — Completed Runs', subtitle: 'Live Floor · Unified station output',
              meta: [`Period: ${PERIODS.find(p => p.key === period)?.label || 'All'}`, q ? `Search: "${q}"` : null],
              columns: [
                { key: 'jc_number', label: 'Job Card' },
                { key: 'product_name', label: 'Product', export: r => `${r.product_name} · ${r.customer_name}` },
                { key: 'sorted_in', label: 'Received', align: 'right', export: r => fmt.num(r.sorted_in) },
                { key: 'sorted_waste', label: 'Sorted Waste', align: 'right', export: r => fmt.num(r.sorted_waste) },
                { key: 'auto_qty', label: 'Auto', align: 'right', export: r => fmt.num(r.auto_qty) },
                { key: 'manual_qty', label: 'Manual', align: 'right', export: r => fmt.num(r.manual_qty) },
                { key: 'qty_scrap', label: 'Paste Waste', align: 'right', export: r => fmt.num(r.qty_scrap) },
                { key: 'qty_out', label: 'Pasted Good', align: 'right', export: r => fmt.num(r.qty_out) },
                { key: 'yield_pct', label: 'Yield', align: 'right', export: r => (r.yield_pct != null ? `${r.yield_pct}%` : '—') },
                { key: 'operator', label: 'Operator', export: r => r.operator || '—' },
                { key: 'completed_at', label: 'Completed', export: r => fmt.dt(r.completed_at) },
              ],
              rows: completed,
            };
            return {
              name: 'Sort & Paste Queue', title: 'Sort & Paste — Production Queue', subtitle: 'Live Floor · Unified station',
              columns: [
                { key: 'jc_number', label: 'Job Card' },
                { key: 'product_name', label: 'Product', export: r => `${r.product_name} (${r.product_code})` },
                { key: 'customer_name', label: 'Customer / PO', export: r => `${r.customer_name} · PO ${r.po_number}` },
                { key: 'phase', label: 'Phase', export: r => (r.phase === 'paste' ? 'Pasting' : 'Sorting') },
                { key: 'expected_qty', label: 'Qty', align: 'right', export: r => fmt.num(receivedQty(r)) },
                { key: 'queue_state', label: 'Status', export: r => fmt.title(r.queue_state) },
                { key: 'delivery_date', label: 'Delivery', export: r => fmt.date(r.delivery_date) },
              ],
              rows: queue,
            };
          }} />
        </div>
      </div>

      {/* Queue — phone: cards with the same fragments and handlers the table
          uses; Process/Start/Resume become full-width thumb targets. */}
      {tab === 'queue' && phone && (
        <div className="grid grid-cols-1 gap-2.5 tp:grid-cols-2 tp:items-start">
          {queue.length === 0 && (
            <div className="ci-data-panel px-4 py-12 text-center text-sm text-slate-400">Nothing here — the station is clear.</div>
          )}
          {queue.map(r => (
            <div key={r.job_card_id} className="glass rounded-2xl p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-[15px] font-bold text-slate-900">{r.jc_number}</span>
                <QueueBadge state={r.queue_state} phase={r.phase} />
              </div>
              <div className="mt-1.5">
                <div className="break-words text-[14px] font-semibold leading-snug text-slate-800">{r.product_name}</div>
                <div className="text-xs text-slate-400">{r.product_code}</div>
              </div>
              <div className="mt-1 text-[13px] text-slate-700">{r.customer_name} <span className="text-slate-400">· PO {r.po_number}</span></div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {r.upstream && <UpstreamChip upstream={r.upstream} available={r.upstream_available} unit={r.unit} />}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 border-t border-[#1D1D1F]/[0.06] pt-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Qty</div>
                  <div className="text-[13px] font-bold tabular-nums text-slate-800">{fmt.num(receivedQty(r))}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Operator</div>
                  <div className="truncate text-[13px] font-semibold text-slate-800">{r.operator || '—'}</div>
                </div>
              </div>
              {r.queue_state === 'hold' && r.hold_reason && (
                <div className="mt-1 text-[12px] font-semibold text-red-500">{r.hold_reason}</div>
              )}
              {r.queue_state === 'partial' && (
                <div className="mt-1 text-[12px] font-bold tabular-nums text-cyan-700">
                  {fmt.num(r.qty_out || 0)} / {fmt.num(receivedQty(r))} {r.phase === 'paste' ? 'pasted' : 'sorted'}
                </div>
              )}
              {canOperate() && (
                <div className="mt-2.5 space-y-1.5">
                  {r.phase === 'paste' && !['running', 'partial'].includes(r.queue_state) ? (
                    <Button variant="success" className="w-full" onClick={() => openProcess(r)}><Combine size={14} /> Process</Button>
                  ) : ['running', 'partial'].includes(r.queue_state) ? (
                    <div className="flex items-center gap-1.5">
                      <Button variant="success" className="flex-1" onClick={() => openProcess(r)}><Combine size={14} /> Process</Button>
                      <ActionMenu items={[
                        { key: 'hold', label: 'Hold', icon: PauseCircle, onClick: () => setHolding(r) },
                        { key: 'sendback', label: 'Send back', icon: Undo2, onClick: () => sb.open(r, r.active_stage_id) },
                        { key: 'day', label: 'Day count', icon: Plus, onClick: () => openDayCount(r) },
                      ]} />
                    </div>
                  ) : r.queue_state === 'hold' ? (
                    <Button className="w-full" onClick={() => resume(r)}><Play size={14} /> Resume</Button>
                  ) : (r.startable ?? r.queue_state === 'queued') ? (
                    <Button className="w-full" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                      onClick={() => { setStarting(r); setOperator(pick?.name || ''); setClearance(freshClearance()); }}>
                      <Play size={14} /> {r.queue_state === 'incoming' ? 'Start ahead' : 'Start'}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === 'queue' && !phone && (
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className={`${th} ${hug} text-right`}>S.No.</th>
                <th className={`${th} ${hug}`}>Job Card</th>
                <th className={`${th} w-full`}>Product</th>
                <th className={`${th} ${hug}`}>Customer / PO</th>
                <th className={`${th} ${hug} text-right`}>Qty</th>
                <th className={`${th} ${hug}`}>Operator</th>
                <th className={`${th} ${hug}`}>Status</th>
                {canOperate() && <th className={`${th} ${hug} text-right`} />}
              </tr></thead>
              <tbody>
                {queue.length === 0 && <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">Nothing here — the station is clear.</td></tr>}
                {queue.map((r, i) => (
                  <tr key={r.job_card_id} className="ci-table-row">
                    <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                    <td className={`${td} whitespace-nowrap font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="w-[176px]" title={r.product_name}><div className="truncate font-semibold text-slate-800">{r.product_name}</div><div className="truncate text-xs text-slate-400">{r.product_code}</div></div></td>
                    <td className={td}><div className="w-[118px]" title={`${r.customer_name} · PO ${r.po_number}`}><div className="truncate text-slate-700">{r.customer_name}</div><div className="truncate text-xs text-slate-400">PO {r.po_number}</div></div></td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(receivedQty(r))}</td>
                    <td className={td}>{r.operator ? <span className="inline-flex max-w-[92px] items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700" title={r.operator}><User size={10} className="shrink-0" /> <span className="truncate">{r.operator}</span></span> : <span className="text-xs text-slate-300">—</span>}</td>
                    <td className={td}>
                      <QueueBadge state={r.queue_state} phase={r.phase} />
                      {r.queue_state === 'hold' && r.hold_reason && <div className="mt-0.5 max-w-[150px] truncate text-[11px] text-red-500" title={r.hold_reason}>{r.hold_reason}</div>}
                      {r.queue_state === 'partial' && (
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold tabular-nums text-cyan-700"
                          title={`${fmt.num(r.qty_out || 0)} of ${fmt.num(receivedQty(r))} ${r.phase === 'paste' ? 'pasted' : 'sorted'} so far`}>
                          {fmt.num(r.qty_out || 0)} / {fmt.num(receivedQty(r))} {r.phase === 'paste' ? 'pasted' : 'sorted'}
                        </div>
                      )}
                      {/* Where the feed stands — die cutting started / counting / done. */}
                      {r.upstream && (
                        <div className="mt-0.5">
                          <UpstreamChip upstream={r.upstream} available={r.upstream_available} unit={r.unit} />
                        </div>
                      )}
                    </td>
                    {canOperate() && touchTable && (
                      <td className={`${td} whitespace-nowrap text-right`}>
                        <span className="inline-flex items-center gap-1">
                          {r.phase === 'paste' && !['running', 'partial'].includes(r.queue_state) ? (
                            <Button size="sm" variant="success" onClick={() => openProcess(r)}><Combine size={12} /> Process</Button>
                          ) : ['running', 'partial'].includes(r.queue_state) ? (
                            <>
                              <Button size="sm" variant="success" onClick={() => openProcess(r)}><Combine size={12} /> Process</Button>
                              <ActionMenu items={[
                                { key: 'hold', label: 'Hold', icon: PauseCircle, onClick: () => setHolding(r) },
                                { key: 'sendback', label: 'Send back', icon: Undo2, onClick: () => sb.open(r, r.active_stage_id) },
                                { key: 'day', label: 'Day count', icon: Plus, onClick: () => openDayCount(r) },
                              ]} />
                            </>
                          ) : r.queue_state === 'hold' ? (
                            <Button size="sm" onClick={() => resume(r)}><Play size={12} /> Resume</Button>
                          ) : (r.startable ?? r.queue_state === 'queued') ? (
                            <Button size="sm" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                              title={r.queue_state === 'incoming' ? 'Start ahead — die cutting is not finished yet' : 'Start this run'}
                              onClick={() => { setStarting(r); setOperator(pick?.name || ''); setClearance(freshClearance()); }}>
                              <Play size={12} /> Start
                            </Button>
                          ) : null}
                        </span>
                      </td>
                    )}
                    {canOperate() && !touchTable && (
                      <td className={`${td} whitespace-nowrap text-right`}>
                        {/* Paste-phase (sorting already done) → straight to Process.
                            Sort-phase → Start, then Process; Hold/Resume as usual. */}
                        {r.phase === 'paste' && !['running', 'partial'].includes(r.queue_state) ? (
                          <Button size="sm" variant="success" onClick={() => openProcess(r)}><Combine size={12} /> Process</Button>
                        ) : ['running', 'partial'].includes(r.queue_state) ? (
                          <span className="inline-flex gap-1">
                            <Button size="sm" variant="secondary" onClick={() => setHolding(r)} title="Put on hold"><PauseCircle size={12} /> Hold</Button>
                            {/* Blanks that should never have reached pasting go
                                back to die cutting, with the same signed manifest
                                every other station shows. */}
                            <Button size="sm" variant="ghost" className="px-2" aria-label="Send back"
                              title="Send back — return this job one station"
                              onClick={() => sb.open(r, r.active_stage_id)}>
                              <Undo2 size={14} />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => openDayCount(r)}
                              title={`Record a partial day count — today's ${r.phase === 'paste' ? 'pasted' : 'sorted'} quantity, job stays open`}>
                              <Plus size={12} /> Day count
                            </Button>
                            <Button size="sm" variant="success" onClick={() => openProcess(r)}><Combine size={12} /> Process</Button>
                          </span>
                        ) : r.queue_state === 'hold' ? (
                          <Button size="sm" onClick={() => resume(r)}><Play size={12} /> Resume</Button>
                        ) : (r.startable ?? r.queue_state === 'queued') ? (
                          <Button size="sm" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                            title={r.queue_state === 'incoming' ? 'Start ahead — die cutting is not finished yet; you can sort but completion waits for it' : 'Start this run'}
                            onClick={() => { setStarting(r); setOperator(pick?.name || ''); setClearance(freshClearance()); }}>
                            <Play size={12} /> {r.queue_state === 'incoming' ? 'Start ahead' : 'Start'}
                          </Button>
                        ) : null}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Completed — phone cards: the sort/paste split reads as a labelled
          grid instead of eight right-aligned columns. */}
      {tab === 'completed' && phone && (
        <div className="grid grid-cols-1 gap-2.5 tp:grid-cols-2 tp:items-start">
          {completed.length === 0 && (
            <div className="ci-data-panel px-4 py-12 text-center text-sm text-slate-400">No completed runs yet.</div>
          )}
          {completed.map(r => (
            <div key={r.id} className="glass rounded-2xl p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-[15px] font-bold text-slate-900">{r.jc_number}</span>
                <YieldPill pct={r.yield_pct} />
              </div>
              <div className="mt-1">
                <div className="break-words text-[14px] font-semibold leading-snug text-slate-800">{r.product_name}</div>
                <div className="text-xs text-slate-400">{r.customer_name}</div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-x-2 gap-y-1.5 border-t border-[#1D1D1F]/[0.06] pt-2">
                <div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Received</div>
                  <div className="text-[13px] font-semibold tabular-nums text-slate-800">{fmt.num(r.sorted_in)}</div></div>
                <div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Sorted Waste</div>
                  <div className={`text-[13px] font-semibold tabular-nums ${r.sorted_waste > 0 ? 'text-red-600' : 'text-slate-400'}`}>{fmt.num(r.sorted_waste)}</div></div>
                <div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Auto / Manual</div>
                  <div className="text-[13px] font-semibold tabular-nums"><span className="text-sky-700">{fmt.num(r.auto_qty)}</span><span className="text-slate-300"> / </span><span className="text-violet-700">{fmt.num(r.manual_qty)}</span></div></div>
                <div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Paste Waste</div>
                  <div className={`text-[13px] font-semibold tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>{fmt.num(r.qty_scrap)}</div></div>
                <div><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Pasted Good</div>
                  <div className="text-[13px] font-bold tabular-nums text-emerald-700">{fmt.num(r.qty_out)}</div></div>
              </div>
              {r.sorted_waste_reason && <div className="mt-1 text-[12px] text-red-400">{r.sorted_waste_reason}</div>}
              <div className="mt-1.5 text-xs text-slate-500">{r.operator || '—'} · {fmt.dt(r.completed_at)}</div>
              {canOperate() && (
                <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={() => { setReversing(r); setReverseReason(''); }}>
                  <Undo2 size={13} /> Reverse
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === 'completed' && !phone && (
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className={th}>Job Card</th><th className={th}>Product</th>
                <th className={`${th} text-right`}>Received</th><th className={`${th} text-right`}>Sorted Waste</th>
                <th className={`${th} text-right`}>Auto / Manual</th><th className={`${th} text-right`}>Paste Waste</th>
                <th className={`${th} text-right`}>Pasted Good</th><th className={`${th} text-right`}>Yield</th>
                <th className={th}>Operator</th><th className={th}>Completed</th>{canOperate() && <th className={th} />}
              </tr></thead>
              <tbody>
                {completed.length === 0 && <tr><td colSpan={canOperate() ? 11 : 10} className="px-4 py-12 text-center text-sm text-slate-400">No completed runs yet.</td></tr>}
                {completed.map(r => (
                  <tr key={r.id} className="ci-table-row">
                    <td className={`${td} font-bold text-slate-900`}>{r.jc_number}</td>
                    <td className={td}><div className="font-semibold text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.customer_name}</div></td>
                    <td className={`${td} text-right tabular-nums`}>{fmt.num(r.sorted_in)}</td>
                    <td className={`${td} text-right tabular-nums ${r.sorted_waste > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      {fmt.num(r.sorted_waste)}{r.sorted_waste_reason && <div className="text-[11px] text-red-400">{r.sorted_waste_reason}</div>}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      <span className="text-sky-700">{fmt.num(r.auto_qty)}</span><span className="text-slate-300"> / </span><span className="text-violet-700">{fmt.num(r.manual_qty)}</span>
                    </td>
                    <td className={`${td} text-right tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>{fmt.num(r.qty_scrap)}</td>
                    <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_out)}</td>
                    <td className={`${td} text-right`}><YieldPill pct={r.yield_pct} /></td>
                    <td className={`${td} text-xs text-slate-500`}>{r.operator || '—'}</td>
                    <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.dt(r.completed_at)}</td>
                    {canOperate() && (
                      <td className={`${td} text-right`}>
                        <Button size="sm" variant="ghost" title="Reverse this run — sends it back to the floor to redo" onClick={() => { setReversing(r); setReverseReason(''); }}>
                          <Undo2 size={12} /> Reverse
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Audit */}
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
                    <span className="ml-2 font-semibold capitalize text-slate-600">{a.action.replace(/_/g, ' ')}</span>
                    {a.stage && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[10px] font-bold text-slate-500">{fmt.stage(a.stage)}</span>}
                    {a.detail && <span className="ml-2 text-xs text-slate-400">{a.detail}</span>}
                  </span>
                  <span className="text-[11px] tabular-nums text-slate-400">{fmt.dt(a.created_at)}{a.user_name ? ` · ${a.user_name}` : ''}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Start (sorting) modal */}
      <Modal open={!!starting} onClose={() => setStarting(null)}
        title={starting ? `Start Sort & Paste — ${starting.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setStarting(null)}>Cancel</Button>
          <Button onClick={start} disabled={!allClear(clearance)} title={!allClear(clearance) ? 'Confirm line clearance first' : undefined}><Play size={13} /> Start Run</Button>
        </>}>
        {starting && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">{starting.product_name} · Expected input: <b>{fmt.num(starting.expected_qty)} {starting.unit}</b></div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Run assignment</span><span>Sort & Paste</span></div>
              <Field label="Operator" hint="Defaults to your own name if left blank">
                <Select value={operator} onChange={e => setOperator(e.target.value)}>
                  <option value="">— {auth.user?.name} (me) —</option>
                  {sectionCrew.map(e => <option key={e.id} value={e.name} data-search={searchText(e)}>{e.name}{e.role && e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
                </Select>
              </Field>
            </section>
            <LineClearancePanel checks={clearance} onChange={setClearance} />
          </div>
        )}
      </Modal>

      {/* Hold modal */}
      {/* Partial day count — today's quantity on the active stage; the job
          stays open and the final Process run reconciles against the log. */}
      <Modal open={!!daycount} onClose={() => setDaycount(null)}
        title={daycount ? `Partial Day Count — ${daycount.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setDaycount(null)}>Cancel</Button>
          <Button variant="primary" onClick={saveDayCount}
            disabled={partialBlockers({
              basis: 'delta', entered: dayForm.good, priorGood: daycount?.qty_out || 0,
              scrap: dayForm.waste, scrapReason: dayForm.reason,
            }).length > 0}>
            Save Partial Count — Job Continues
          </Button>
        </>}>
        {daycount && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {daycount.product_name} · {daycount.phase === 'paste' ? 'Pasting' : 'Sorting'} phase ·
              Received: <b>{fmt.num(receivedQty(daycount))} {daycount.unit}</b>
              {(daycount.qty_out || 0) > 0 && <span className="ml-2 font-semibold text-cyan-700">{fmt.num(daycount.qty_out)} already on the day log</span>}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Today's count</span><span>{daycount.phase === 'paste' ? 'Pasting' : 'Sorting'}</span></div>
              <div className="ci-form-grid">
                <Field label={`${daycount.phase === 'paste' ? 'Pasted' : 'Sorted'} good now (${daycount.unit})`} required
                  hint={(daycount.qty_out || 0) > 0
                    ? `Just this lot — added to the ${fmt.num(daycount.qty_out)} already recorded`
                    : 'Enter as many counts as the job takes — the balance stays pending'}>
                  <Input type="number" min="0" value={dayForm.good} onChange={e => setDayForm({ ...dayForm, good: e.target.value })} autoFocus />
                </Field>
                <Field label={`Waste today (${daycount.unit}) — optional`}>
                  <Input type="number" min="0" value={dayForm.waste} onChange={e => setDayForm({ ...dayForm, waste: e.target.value })} />
                </Field>
              </div>
              {(+dayForm.waste || 0) > 0 && (
                <Field label="Waste reason" required>
                  <Select value={dayForm.reason} onChange={e => setDayForm({ ...dayForm, reason: e.target.value })}>
                    <option value="">Select reason…</option>
                    {(daycount.phase === 'paste' ? GENERAL_WASTAGE_REASONS : SORTING_REJECTION_REASONS).map(r => <option key={r} value={r}>{r}</option>)}
                  </Select>
                </Field>
              )}
            </section>
            {/* Where the stage lands after this count — so the operator can see
                a second, third or fourth entry stacking on the log. */}
            {(() => {
              const received = receivedQty(daycount);
              const { adding, total } = resolveEntry({
                basis: 'delta', entered: dayForm.good, priorGood: daycount.qty_out || 0,
              });
              if (adding <= 0) return null;
              return (
                <p className="rounded-lg bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-700">
                  Adds {fmt.num(adding)} · {fmt.num(total)} of {fmt.num(received)} {daycount.unit} counted
                  {total < received && <> · {fmt.num(received - total)} still to go</>}
                </p>
              );
            })()}
            <p className="rounded-lg bg-cyan-50 px-3 py-2 text-xs font-semibold text-cyan-700">
              Nothing goes to wastage automatically — the remaining quantity stays pending here, and the final Process run closes the job against this log.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={!!holding} onClose={() => setHolding(null)}
        title={holding ? `Hold Sort & Paste — ${holding.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setHolding(null)}>Cancel</Button>
          <Button variant="danger" onClick={hold}><PauseCircle size={13} /> Put on Hold</Button>
        </>}>
        {holding && (
          <section className="ci-form-panel">
            <div className="ci-form-panel-title"><span>Hold reason</span><span>Required</span></div>
            <Field label="Reason" required>
              <Select value={holdReason} onChange={e => setHoldReason(e.target.value)}>{HOLD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}</Select>
            </Field>
          </section>
        )}
      </Modal>

      {/* Process wizard — waste gate → hybrid grid → pack */}
      <Modal open={!!proc} onClose={() => setProc(null)} wide
        title={proc ? `Sort & Paste — ${proc.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setProc(null)}>Cancel</Button>
          <Button variant="success" onClick={submit}
            disabled={saving || !balanced || wasteReasonMissing || pasteReasonMissing}
            title={overPasted ? 'Pasted good exceeds the pool — reduce it' : !balanced ? 'Enter the pasted-good quantity' : undefined}>
            <Check size={13} /> Complete Sort & Paste
          </Button>
        </>}>
        {proc && (
          <div className="space-y-3">
            {/* Whose name this run goes under. Sorting and pasting share this
                device, so the name is confirmed where the write happens and not
                only up in the header. */}
            <RecordingAs pick={pick} onChange={() => choosePick(null)} />
            {/* Same choice every other station now opens with. Sort & Paste
                completes atomically across both stages, so "Day count" hands
                straight over to the day-count form rather than trying to run a
                partial through the sort → waste-gate → paste wizard. */}
            <ModeChoice mode="final" isQC={false}
              onChoose={m => { if (m === 'partial') { const row = proc; setProc(null); openDayCount(row); } }} />
            <div className="ci-summary-panel text-xs">
              {proc.product_name} · <b>{fmt.num(received)} {proc.unit}</b> {proc.phase === 'paste' ? 'sorted good' : 'received'}
              {proc.phase === 'paste' && proc.sorting_qty_out != null && <span className="ml-2 text-slate-500">(sorting already completed)</span>}
            </div>
            {/* Day counts already on the active phase — the wizard figures below
                are the running totals, so show the balance being added. */}
            {proc.qty_out > 0 && (
              <CumulativeSummary
                prior={proc.qty_out}
                total={proc.phase === 'paste' ? pastedGood : Math.max(0, received - sortedWaste)}
                unit={proc.unit} />
            )}

            {/* ❶ Hybrid pasting — enter the GOOD pasted; waste is derived */}
            <section className="ci-form-panel border-dashed">
              <div className="ci-form-panel-title"><span className="inline-flex items-center gap-1.5"><Combine size={13} /> Hybrid pasting</span><span>Enter pasted good — waste is auto</span></div>
              <div className="grid grid-cols-1 gap-2.5 tp:grid-cols-2 tp:items-start">
                {rows.map((r, i) => {
                  const good = rowGood(r);
                  return (
                    <div key={i} className="rounded-xl border border-slate-200 bg-white/70 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Row {i + 1}</span>
                        <div className="flex items-center gap-2">
                          {remaining > 0 && rows.length > 1 && (
                            <button type="button" title={`Put the ${fmt.num(remaining)} not-yet-pasted pieces in this row`}
                              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700 hover:bg-brand-100"
                              onClick={() => fillRemaining(i)}><Wand2 size={11} /> fill {fmt.num(remaining)}</button>
                          )}
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold tabular-nums text-slate-600">good {fmt.num(good)}</span>
                          <button type="button" title="Remove row" disabled={rows.length === 1}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                            onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                        <Field label="Method">
                          <Select value={r.method} onChange={e => setRow(i, { method: e.target.value })}>
                            {PASTING_METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                          </Select>
                        </Field>
                        {r.method === 'machine_manual' && (
                          <Field label="Pasted qty (both steps)" hint="Machine side-paste → hand lock, same pieces">
                            <Input type="number" min="0" value={r.both} onChange={e => setRow(i, { both: e.target.value })} />
                          </Field>
                        )}
                        {(r.method === 'machine' || r.method === 'split') && (
                          <Field label="Machine qty"><Input type="number" min="0" value={r.auto} onChange={e => setRow(i, { auto: e.target.value })} /></Field>
                        )}
                        {(r.method === 'manual' || r.method === 'split') && (
                          <Field label="Manual qty"><Input type="number" min="0" value={r.manual} onChange={e => setRow(i, { manual: e.target.value })} /></Field>
                        )}
                        {needsMachine(r.method) && (
                          <Field label="Machine">
                            <Select value={r.machine_id} onChange={e => setRow(i, { machine_id: e.target.value })}>
                              <option value="">— pick paster —</option>
                              {autoMachines.map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
                            </Select>
                          </Field>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={addRow}><Plus size={13} /> Add row</Button>
                  <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold tabular-nums ${
                    overPasted ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    {overPasted ? <><AlertTriangle size={13} /> over by {fmt.num(-remaining)} — reduce a row</>
                      : <><Check size={13} /> {fmt.num(pastedGood)} pasted good · {fmt.num(pasteWaste)} paste waste (auto)</>}
                  </div>
                </div>
                {/* Live bar — green = pasted good, amber = the auto paste waste. */}
                <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full transition-all ${overPasted ? 'bg-red-400' : 'bg-emerald-500'}`}
                    style={{ width: `${goodToPaste > 0 ? Math.min(100, Math.round(100 * pastedGood / goodToPaste)) : 0}%` }} />
                  {!overPasted && pasteWaste > 0 && (
                    <div className="h-full bg-amber-400" style={{ width: `${goodToPaste > 0 ? Math.round(100 * pasteWaste / goodToPaste) : 0}%` }} />
                  )}
                </div>
              </div>
              {pasteWaste > 0 && !overPasted && (
                <div className="mt-2">
                  <Field label="Paste waste reason" required>
                    <Select value={pasteWasteReason} onChange={e => setPasteWasteReason(e.target.value)}>
                      <option value="">Select…</option>
                      {GENERAL_WASTAGE_REASONS.map(x => <option key={x} value={x}>{x}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                Reconciles to <b>{fmt.num(pastedGood)}</b> pasted good + <b>{fmt.num(pasteWaste)}</b> paste waste{proc.phase !== 'paste' ? <> + <b>{fmt.num(sortedWaste)}</b> sorted waste</> : null} = <b>{fmt.num(received)}</b> received.
              </p>
            </section>

            {/* ❷ Sorted waste gate — carve the sorting portion out of the total wastage */}
            {proc.phase !== 'paste' && (
              <section className="ci-form-panel">
                <div className="ci-form-panel-title"><span className="inline-flex items-center gap-1.5"><Scissors size={13} /> Sorted waste gate</span><span>How much of the wastage was sorting</span></div>
                <div className="ci-form-grid">
                  <Field label={`Sorted waste (${proc.unit})`} hint={`Of the ${fmt.num(totalWastage)} wasted, how many were rejected in sorting — enter 0 if none`}>
                    <Input type="number" min="0" value={waste.qty} onChange={e => setWaste({ ...waste, qty: e.target.value })} />
                  </Field>
                  {sortedWaste > 0 && (
                    <Field label="Rejection reason (NCR)" required>
                      <Select value={waste.reason} onChange={e => setWaste({ ...waste, reason: e.target.value })}>
                        <option value="">Select reason…</option>
                        {SORTING_REJECTION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </Select>
                    </Field>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs font-semibold">
                  <span className="text-emerald-700"><Check size={12} className="mr-0.5 inline" />{fmt.num(pastedGood)} pasted good</span>
                  <span className="text-fuchsia-600">{fmt.num(sortedWaste)} sorted waste</span>
                  <span className="text-amber-600">{fmt.num(pasteWaste)} paste waste</span>
                  <span className="text-slate-400">= {fmt.num(received)} received</span>
                </div>
              </section>
            )}

            {/* ❸ Packing manifest */}
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span className="inline-flex items-center gap-1.5"><PackagePlus size={13} /> Packing manifest</span><span>Optional — boxes × qty/box + loose</span></div>
              <div className="space-y-1.5">
                <div className="grid grid-cols-[1fr_1fr_1fr_90px_34px] gap-2 px-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <span>Boxes</span><span>Qty / box</span><span>Loose pcs</span><span className="text-right">Line total</span><span />
                </div>
                {packing.map((pl, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1fr_90px_34px] items-center gap-2">
                    <Input type="number" min="0" placeholder="0" value={pl.boxes} onChange={e => setPacking(p => p.map((x, j) => j === i ? { ...x, boxes: e.target.value } : x))} />
                    <Input type="number" min="0" placeholder="0" value={pl.qty_per_box} onChange={e => setPacking(p => p.map((x, j) => j === i ? { ...x, qty_per_box: e.target.value } : x))} />
                    <Input type="number" min="0" placeholder="0" value={pl.loose_qty} onChange={e => setPacking(p => p.map((x, j) => j === i ? { ...x, loose_qty: e.target.value } : x))} />
                    <div className="rounded-lg bg-slate-50 px-2 py-2 text-right text-xs font-bold tabular-nums text-slate-600">{packLineTotal(pl) ? fmt.num(packLineTotal(pl)) : '—'}</div>
                    <button type="button" title="Remove line" disabled={packing.length === 1}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30"
                      onClick={() => setPacking(p => p.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={() => setPacking(p => [...p, emptyPack()])}><Plus size={13} /> Add line</Button>
              </div>
            </section>

            <section className="ci-form-panel">
              <Field label="Pasting operator" hint="Defaults to the run operator / you">
                <Select value={pasteOperator} onChange={e => setPasteOperator(e.target.value)}>
                  <option value="">— {proc.operator || auth.user?.name} —</option>
                  {sectionCrew.map(e => <option key={e.id} value={e.name} data-search={searchText(e)}>{e.name}</option>)}
                </Select>
              </Field>
            </section>
          </div>
        )}
      </Modal>

      {/* Reverse (redo) a completed run */}
      <SendBackDialog {...sb.dialogProps} stationLabel={meta.label} />

      <Modal open={!!reversing} onClose={() => setReversing(null)}
        title={reversing ? `Reverse Sort & Paste — ${reversing.jc_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setReversing(null)}>Cancel</Button>
          <Button variant="secondary" onClick={reverseRun} disabled={!reverseReason.trim()}><Undo2 size={13} /> Reverse Run</Button>
        </>}>
        {reversing && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {reversing.product_name} · recorded <b>{fmt.num(reversing.qty_out)}</b> pasted good
              {reversing.sorted_waste > 0 && <span> · {fmt.num(reversing.sorted_waste)} sorted waste</span>}
            </div>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              This clears the sorted waste, the hybrid rows and the packing manifest, and puts the job back on the floor to sort &amp; paste again. Blocked once QC has started.
            </p>
            <Field label="Reason for reverse" required>
              <Input value={reverseReason} placeholder="e.g. wrong counts, recount required, re-paste"
                onChange={e => setReverseReason(e.target.value)} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
