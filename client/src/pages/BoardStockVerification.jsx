// Board Stock Verification — the warehouse's pre-cutting physical check.
//
// Lists every board with jobs still AWAITING cutting (the moment cutting
// starts a job drops off on its own), the cumulative sheets those jobs will
// draw, the live pool position, incoming PR/PO paper, and the latest physical
// verification. Recording a verification never reserves stock, never adjusts
// stock, and never blocks Cutting — stock corrections stay with the existing
// warehouse adjustment paths.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, auth, fmt } from '../api.js';
import {
  Button, DataTable, ExportMenu, Field, Input, KpiCard, KpiFilterNotice, KpiRow,
  Modal, PageHeader, rowMatches, SearchInput, Select, Tabs, Textarea, useKpiFilter, useToast,
} from '../components/ui.jsx';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BOARD_FULL, BOARD_HINT, BOARD_LABEL, BOARD_RANK, BOARD_TONE, BOARD_COUNT_TONE, BoardBadge } from '../components/BoardStatus.jsx';
// The vocabulary and the export spec live in lib/ so the screen, the workbook
// and the tests read from one source — and so the PDF can be rendered headless.
import {
  VERIF_LABEL, CUT_LABEL, sizeOf, clientShort, qtyNote, buildBoardVerificationSpec,
} from '../lib/boardVerificationExport.js';
import {
  AlertTriangle, ArrowLeft, Boxes, CheckCircle2, ChevronDown, ChevronRight,
  ClipboardCheck, History, Layers, PackageSearch, Scissors, ShieldCheck, Truck,
} from 'lucide-react';
import ProductIdentity, { productSearchText } from '../components/ProductIdentity.jsx';

// ── Vocabulary ──────────────────────────────────────────────────────────────
// Physical verification is its own dimension beside the stock verdict, so it
// carries its own words and tones: amber = nobody has walked the rack yet,
// green = counted and it agrees, soft red = counted and something is off
// (someone knows — same depth rule as PR Raised), solid red = the rack is
// EMPTY where the book says sheets, and nobody has acted on that yet.
const VERIF_TONE = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  verified: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  mismatch: 'border-red-200 bg-red-50 text-red-600',
  partial: 'border-red-200 bg-red-50 text-red-600',
  not_found: 'border-red-600 bg-red-600 text-white',
};
const VERIF_COUNT_TONE = {
  pending: 'bg-white/70', verified: 'bg-white/70', mismatch: 'bg-white/70',
  partial: 'bg-white/70', not_found: 'bg-white text-red-700',
};
const VERIF_ICON = {
  pending: ClipboardCheck, verified: ShieldCheck, mismatch: AlertTriangle,
  partial: AlertTriangle, not_found: AlertTriangle,
};
const VERIF_RANK = { not_found: 0, mismatch: 1, partial: 2, pending: 3, verified: 4 };

const CUT_TONE = {
  not_sent: 'bg-slate-100 text-slate-600',
  waiting: 'bg-amber-50 text-amber-700',
  planned: 'bg-[#E1EFFF] text-[#0064D2]',
  started: 'bg-slate-200 text-slate-500',
};

// One sheet figure, said again in the units the rack is counted in. Renders
// nothing when the board master cannot support it (see qtyNote).
function QtyNote({ board, sheets, className = '' }) {
  const note = qtyNote(board, sheets);
  if (!note) return null;
  return <div className={`text-[10px] font-semibold tabular-nums text-slate-400 ${className}`}>{note}</div>;
}

const cmpDate = (x, y) => String(x || '9999').localeCompare(String(y || '9999'));
const firstCustomer = b => b.jobs[0]?.customer_name || '';
const uniqueProducts = b => new Set(b.jobs.map(j => j.product_id || j.product_code || j.product_name)).size;
const sameSet = (a, b) => a.length === b.length && b.every(x => a.includes(x));

const SORTS = {
  urgency: { label: 'Urgency', fn: (a, b) => b.uncovered - a.uncovered || b.shortage - a.shortage || cmpDate(a.earliest_planned_date, b.earliest_planned_date) },
  cutting: { label: 'Earliest cutting date', fn: (a, b) => cmpDate(a.earliest_planned_date, b.earliest_planned_date) },
  dispatch: { label: 'Earliest dispatch date', fn: (a, b) => cmpDate(a.earliest_delivery_date, b.earliest_delivery_date) },
  required: { label: 'Highest requirement', fn: (a, b) => b.required - a.required },
  shortage: { label: 'Highest shortage', fn: (a, b) => b.shortage - a.shortage },
  customer: { label: 'Client name', fn: (a, b) => firstCustomer(a).localeCompare(firstCustomer(b)) },
  gsm: { label: 'Board GSM', fn: (a, b) => (a.gsm || 0) - (b.gsm || 0) },
  size: { label: 'Board size', fn: (a, b) => ((+b.sheet_l || 0) * (+b.sheet_w || 0)) - ((+a.sheet_l || 0) * (+a.sheet_w || 0)) },
  verification: { label: 'Verification status', fn: (a, b) => VERIF_RANK[a.verification_status] - VERIF_RANK[b.verification_status] },
};

const BSV_KPI_ROWS = {
  pending_pr: b => b.pr_pending_qty > 0,
  uncovered: b => b.uncovered > 0,
};
const BSV_KPI_LABEL = {
  pending_pr: 'boards with a pending purchase requisition',
  uncovered: 'boards short with nothing on order for the gap',
};

function VerifBadge({ status }) {
  const Icon = VERIF_ICON[status] || ClipboardCheck;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold ${VERIF_TONE[status] || VERIF_TONE.pending}`}>
      <Icon size={12} className="shrink-0" /> {VERIF_LABEL[status] || status}
    </span>
  );
}

// ── Per-job cells on a board row ────────────────────────────────────────────
// A board is one row, but its jobs are many, so the product columns partition
// inside the cell — the idiom Planning and the Status Sheet already use for a
// gang (components/Gang.jsx). The geometry constant is local rather than
// imported because a gang segment is tuned taller: this is a report read a
// screenful at a time, not a queue row. THE INVARIANT IS THAT EVERY PARTITIONED
// COLUMN IN THIS TABLE USES JOB_SEG — the dividers only line up across the row
// while they share one height.
const JOB_SEG = 'flex min-h-[34px] flex-col justify-center py-1';
// Long boards are common; a row that lists twenty jobs inline stops being a
// board list. The rest stay one click away in the expander, which is the whole
// point of keeping it.
const INLINE_JOBS = 4;

function JobParts({ jobs, align = 'left', total, render }) {
  const shown = jobs.slice(0, INLINE_JOBS);
  const hidden = jobs.length - shown.length;
  const right = align === 'right';
  return (
    <div>
      <div className="divide-y divide-[#0A84FF]/15">
        {shown.map((j, i) => (
          <div key={j.order_line_id ?? i} className={`${JOB_SEG} ${right ? 'items-end text-right' : ''}`}>
            {render(j)}
          </div>
        ))}
      </div>
      {/* The hint repeats in every partitioned column and must not wrap: each
          cell has to end at the same height or the totals below stop lining up
          across the row. Two words fit the narrowest column; the sentence lives
          in the tooltip, and the chevron already says the row opens. */}
      {hidden > 0 && (
        <div title={`${hidden} more job${hidden === 1 ? '' : 's'} on this board — open the row to see them`}
          className={`whitespace-nowrap pt-1 text-[10px] font-semibold text-slate-400 ${right ? 'text-right' : ''}`}>
          +{hidden} more
        </div>
      )}
      {total !== undefined && (
        <div className={`mt-1 border-t-2 border-[#0A84FF]/30 pt-1.5 text-[11px] font-bold text-[#0064D2] ${right ? 'text-right tabular-nums' : ''}`}>
          {total}
        </div>
      )}
    </div>
  );
}

function CutChip({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${CUT_TONE[status] || CUT_TONE.not_sent}`}>
      <Scissors size={10} className="shrink-0" /> {CUT_LABEL[status] || status}
    </span>
  );
}

// One labelled chip rail — All + a chip per state, counts from the searched set.
function ChipRail({ label, states, labels, tones, countTones, counts, active, onToggle, onClear }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 shrink-0 text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">{label}</span>
      <button type="button" onClick={onClear}
        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] ${
          active.length === 0 ? 'border-[#0A84FF]/25 bg-[#E1EFFF] text-[#0064D2]' : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
        All
        <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${active.length === 0 ? 'bg-white/70' : 'bg-[#1D1D1F]/[0.07]'}`}>
          {Object.values(counts).reduce((s, n) => s + n, 0)}
        </span>
      </button>
      {states.map(k => {
        const on = active.includes(k);
        return (
          <button key={k} type="button" onClick={() => onToggle(k)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] ${
              on ? tones[k] : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white'}`}>
            {labels[k]}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? (countTones?.[k] || 'bg-white/70') : 'bg-[#1D1D1F]/[0.07]'}`}>
              {counts[k] || 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function BoardStockVerification() {
  const toast = useToast();
  const [data, setData] = useState({ boards: [], generated_at: null });
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('report');
  const [q, setQ] = useState('');
  const [stockFilter, setStockFilter] = useState([]);
  const [verifFilter, setVerifFilter] = useState([]);
  const [cutFilter, setCutFilter] = useState([]);
  const [grade, setGrade] = useState('');
  const [gsm, setGsm] = useState('');
  const [cutBefore, setCutBefore] = useState('');
  const [dispBefore, setDispBefore] = useState('');
  const [sortKey, setSortKey] = useState('urgency');
  const [open, setOpen] = useState(() => new Set());
  const [verifying, setVerifying] = useState(null);   // { board, status, qty, remarks }
  const [history, setHistory] = useState(null);       // { board, rows|null }
  const kpi = useKpiFilter('bsv');

  const canVerify = ['admin', 'planner', 'production'].includes(auth.user?.role);

  const load = () => api.get('/board-verification/report')
    .then(d => { setData(d); setLoading(false); })
    .catch(() => setLoading(false));
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);

  const boards = data.boards;

  // Search first, then filters — the KPI strip and every chip count the
  // SEARCHED set, so the numbers always say what the filters came out of.
  const searched = useMemo(() => (q.trim()
    ? boards.filter(b => rowMatches(b, q, b.jobs.map(productSearchText).join(' ')))
    : boards), [boards, q]);
  const filtered = useMemo(() => searched.filter(b =>
    (!stockFilter.length || stockFilter.includes(b.stock_state))
    && (!verifFilter.length || verifFilter.includes(b.verification_status))
    && (!cutFilter.length || b.jobs.some(j => cutFilter.includes(j.cutting_status)))
    && (!grade || b.grade === grade)
    && (!gsm || String(b.gsm) === gsm)
    && (!cutBefore || (b.earliest_planned_date && String(b.earliest_planned_date) <= cutBefore))
    && (!dispBefore || (b.earliest_delivery_date && String(b.earliest_delivery_date).slice(0, 10) <= dispBefore))),
  [searched, stockFilter, verifFilter, cutFilter, grade, gsm, cutBefore, dispBefore]);
  const shown = useMemo(
    () => [...kpi.apply(filtered, BSV_KPI_ROWS)].sort(SORTS[sortKey].fn),
    [filtered, kpi, sortKey]);

  const k = useMemo(() => ({
    toVerify: searched.filter(b => b.verification_status === 'pending').length,
    jobs: searched.reduce((s, b) => s + b.job_count, 0),
    required: searched.reduce((s, b) => s + b.required, 0),
    shortBoards: searched.filter(b => b.shortage > 0).length,
    shortSheets: searched.reduce((s, b) => s + b.shortage, 0),
    prBoards: searched.filter(b => b.pr_pending_qty > 0).length,
    prQty: searched.reduce((s, b) => s + b.pr_pending_qty, 0),
    verified: searched.filter(b => b.verification_status === 'verified').length,
    issues: searched.filter(b => ['mismatch', 'not_found', 'partial'].includes(b.verification_status)).length,
    uncovered: searched.reduce((s, b) => s + b.uncovered, 0),
    uncoveredBoards: searched.filter(b => b.uncovered > 0).length,
  }), [searched]);

  const stockCounts = useMemo(() => Object.fromEntries(
    ['covered', 'on_order', 'short'].map(s => [s, searched.filter(b => b.stock_state === s).length])), [searched]);
  const verifCounts = useMemo(() => Object.fromEntries(
    Object.keys(VERIF_LABEL).map(s => [s, searched.filter(b => b.verification_status === s).length])), [searched]);
  const cutCounts = useMemo(() => Object.fromEntries(
    ['not_sent', 'waiting', 'planned'].map(s => [s, searched.filter(b => b.jobs.some(j => j.cutting_status === s)).length])), [searched]);

  const grades = useMemo(() => [...new Set(boards.map(b => b.grade).filter(Boolean))].sort(), [boards]);
  const gsms = useMemo(() => [...new Set(boards.map(b => b.gsm).filter(Boolean))].sort((a, b) => a - b), [boards]);

  const toggleIn = setter => key =>
    setter(cur => (cur.includes(key) ? cur.filter(x => x !== key) : [...cur, key]));
  // A KPI card that names a set an existing chip rail already controls drives
  // THAT rail rather than adding a rival filter — one piece of state.
  const driveChips = (setter, cur, target) => () => setter(sameSet(cur, target) ? [] : target);

  const toggleOpen = id => setOpen(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-4 py-2.5 align-top';
  const sth = 'px-3 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400';
  const std = 'px-3 py-1.5 align-top';

  // ── Export — one spec, PDF + a five-worksheet Excel, honouring the live
  // filters and sort. Verification history is fetched at click time so the
  // records sheet is always current.
  const appliedMeta = () => [
    stockFilter.length ? `Stock: ${stockFilter.map(s => BOARD_LABEL[s]).join(' + ')}` : null,
    verifFilter.length ? `Verification: ${verifFilter.map(s => VERIF_LABEL[s]).join(' + ')}` : null,
    cutFilter.length ? `Cutting: ${cutFilter.map(s => CUT_LABEL[s]).join(' + ')}` : null,
    grade ? `Board type: ${grade}` : null,
    gsm ? `GSM: ${gsm}` : null,
    cutBefore ? `Cutting on/before ${fmt.date(cutBefore)}` : null,
    dispBefore ? `Dispatch on/before ${fmt.date(dispBefore)}` : null,
    q.trim() ? `Search: "${q}"` : null,
    `Sort: ${SORTS[sortKey].label}`,
    `${shown.length} of ${boards.length} boards`,
  ].filter(Boolean);

  const exportSummary = () => [
    { label: 'Boards to verify', value: fmt.num(k.toVerify) },
    { label: 'Jobs awaiting cutting', value: fmt.num(k.jobs) },
    { label: 'Required sheets', value: fmt.num(k.required) },
    { label: 'Stock shortage', value: fmt.num(k.shortSheets) },
    { label: 'Pending PR sheets', value: fmt.num(k.prQty) },
    { label: 'Physically verified', value: fmt.num(k.verified) },
    { label: 'Mismatches / issues', value: fmt.num(k.issues) },
    { label: 'Uncovered sheets', value: fmt.num(k.uncovered) },
  ];

  const buildExport = async () => {
    const records = await api.get('/board-verification/records').catch(() => []);
    return buildBoardVerificationSpec({
      boards: shown,
      totalBoards: boards.length,
      records,
      meta: appliedMeta(),
      summary: exportSummary(),
      boardFull: BOARD_FULL,
    });
  };

  // ── Tab 2 — Board vs Product Requirement (flat coverage table) ────────────
  const coverageCols = [
    {
      key: 'board_name', label: 'Board', card: 'title',
      render: b => (
        <div>
          <div className="font-bold text-slate-900">{b.board_name}</div>
          <div className="text-[11px] text-slate-400">{[b.board_code, b.leftover ? 'leftover strip' : null].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
      searchValue: b => `${b.board_name} ${b.board_code || ''}`,
      export: b => b.board_name,
    },
    { key: 'grade', label: 'Board Type', card: 'detail', render: b => b.grade || '—' },
    { key: 'gsm', label: 'GSM', align: 'right', card: 'detail', render: b => b.gsm || '—' },
    { key: 'size', label: 'Sheet Size', card: 'detail', render: b => sizeOf(b), export: b => sizeOf(b), sortValue: b => (+b.sheet_l || 0) * 1000 + (+b.sheet_w || 0) },
    {
      key: 'available', label: 'Available', align: 'right', card: 'metric',
      render: b => <>{fmt.num(b.available)}<QtyNote board={b} sheets={b.available} className="!text-right" /></>,
      export: b => b.available, sortValue: b => +b.available,
    },
    { key: 'committed', label: 'Booked', align: 'right', render: b => fmt.num(b.committed), sortValue: b => +b.committed },
    {
      key: 'required', label: 'Awaiting Cutting', align: 'right', card: 'metric',
      render: b => <><b>{fmt.num(b.required)}</b><QtyNote board={b} sheets={b.required} className="!text-right" /></>,
      export: b => b.required, sortValue: b => +b.required,
    },
    { key: 'shortage', label: 'Shortage', align: 'right', render: b => (b.shortage > 0 ? <b className="text-red-600">{fmt.num(b.shortage)}</b> : <span className="text-slate-300">0</span>), export: b => b.shortage, sortValue: b => +b.shortage },
    { key: 'pr_pending_qty', label: 'Pending PR', align: 'right', render: b => (b.pr_pending_qty ? fmt.num(b.pr_pending_qty) : <span className="text-slate-300">—</span>), export: b => b.pr_pending_qty, sortValue: b => +b.pr_pending_qty },
    { key: 'po_pending_qty', label: 'Pending PO', align: 'right', render: b => (b.po_pending_qty ? fmt.num(b.po_pending_qty) : <span className="text-slate-300">—</span>), export: b => b.po_pending_qty, sortValue: b => +b.po_pending_qty },
    { key: 'uncovered', label: 'Uncovered', align: 'right', render: b => (b.uncovered > 0 ? <b className="text-red-700">{fmt.num(b.uncovered)}</b> : <span className="text-slate-300">0</span>), export: b => b.uncovered, sortValue: b => +b.uncovered },
    { key: 'products', label: 'Products', align: 'right', render: b => uniqueProducts(b), export: b => uniqueProducts(b), sortValue: b => uniqueProducts(b) },
    { key: 'earliest_planned_date', label: 'Earliest Cutting', render: b => fmt.date(b.earliest_planned_date), export: b => fmt.date(b.earliest_planned_date) },
    { key: 'earliest_delivery_date', label: 'Earliest Dispatch', render: b => fmt.date(b.earliest_delivery_date), export: b => fmt.date(b.earliest_delivery_date) },
    { key: 'risk', label: 'Risk Status', card: 'status', render: b => <BoardBadge state={b.stock_state} compact />, export: b => BOARD_FULL[b.stock_state], sortValue: b => BOARD_RANK[b.stock_state] },
  ];

  const verifyDisabled = verifying
    && ['verified', 'mismatch', 'partial'].includes(verifying.status)
    && (verifying.qty === '' || verifying.qty == null);

  const preview = useMemo(() => {
    if (!verifying || verifying.qty === '' || verifying.qty == null) return null;
    const physical = +verifying.qty;
    if (!Number.isFinite(physical)) return null;
    // Client twin of verificationComputed — the modal shows the variance the
    // server will save, before the user commits.
    return {
      shortage: Math.max(0, verifying.board.required - physical),
      excess: Math.max(0, physical - verifying.board.required),
      book: physical - verifying.board.available,
    };
  }, [verifying]);

  const saveVerification = async () => {
    const { board, status, qty, remarks } = verifying;
    try {
      await api.post(`/board-verification/${board.material_id}/verify`, {
        status,
        physical_qty: qty === '' || qty == null ? null : +qty,
        remarks: remarks || null,
      });
      toast.success(`${board.board_name} — ${VERIF_LABEL[status]} recorded`);
      setVerifying(null);
      load();
    } catch { /* central handler already toasts */ }
  };

  const openHistory = async b => {
    setHistory({ board: b, rows: null });
    const rows = await api.get(`/board-verification/records?material_id=${b.material_id}`).catch(() => []);
    setHistory(h => (h && h.board.material_id === b.material_id ? { ...h, rows } : h));
  };

  return (
    <div>
      <div className="mb-3">
        <Link to="/production" className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-800">
          <ArrowLeft size={14} /> Back to Job Cards
        </Link>
      </div>
      <PageHeader
        title="Board Stock Verification"
        subtitle="Physically confirm the board for jobs headed to cutting is really on the shelf. A check only — it never reserves stock and never blocks Cutting."
        actions={<>
          <SearchInput className="w-80" value={q} onChange={setQ}
            placeholder="Client, product, JC, SO, artwork, board, GSM, size…" />
          <ExportMenu build={buildExport} />
        </>} />

      <KpiRow cols={8}>
        <KpiCard compact icon={ClipboardCheck} label="Boards to Verify" tone={k.toVerify ? 'warn' : 'good'}
          value={fmt.num(k.toVerify)} sub={k.toVerify ? 'pending physical check' : 'all checked'}
          onClick={driveChips(setVerifFilter, verifFilter, ['pending'])} active={sameSet(verifFilter, ['pending'])} />
        <KpiCard compact icon={Scissors} label="Jobs Awaiting Cutting" tone="info"
          value={fmt.num(k.jobs)} sub="drop off once cutting starts" />
        <KpiCard compact icon={Layers} label="Required Sheets" tone="neutral"
          value={fmt.num(k.required)} sub="parent sheets, cumulative" />
        <KpiCard compact icon={Boxes} label="Stock Shortage" tone={k.shortSheets ? 'bad' : 'good'}
          value={fmt.num(k.shortSheets)} sub={k.shortSheets ? fmt.count(k.shortBoards, 'board') : 'no board short'}
          onClick={driveChips(setStockFilter, stockFilter, ['on_order', 'short'])} active={sameSet(stockFilter, ['on_order', 'short'])} />
        <KpiCard compact icon={Truck} label="Pending PRs" tone={k.prBoards ? 'bad' : 'neutral'}
          value={fmt.num(k.prBoards)} sub={k.prBoards ? `${fmt.num(k.prQty)} sheets on PR` : 'nothing pending'}
          onClick={() => kpi.toggle('pending_pr')} active={kpi.is('pending_pr')} />
        <KpiCard compact icon={ShieldCheck} label="Physically Verified" tone={k.verified ? 'good' : 'neutral'}
          value={fmt.num(k.verified)}
          onClick={driveChips(setVerifFilter, verifFilter, ['verified'])} active={sameSet(verifFilter, ['verified'])} />
        <KpiCard compact icon={AlertTriangle} label="Count Issues" tone={k.issues ? 'bad' : 'neutral'}
          value={fmt.num(k.issues)} sub={k.issues ? 'mismatch / not found / partial' : 'none reported'}
          onClick={driveChips(setVerifFilter, verifFilter, ['mismatch', 'not_found', 'partial'])}
          active={sameSet(verifFilter, ['mismatch', 'not_found', 'partial'])} />
        <KpiCard compact icon={PackageSearch} label="Uncovered" tone={k.uncovered ? 'alarm' : 'good'}
          value={fmt.num(k.uncovered)} sub={k.uncovered ? `sheets · ${fmt.count(k.uncoveredBoards, 'board')} · no PR/PO` : 'every gap on order'}
          onClick={() => kpi.toggle('uncovered')} active={kpi.is('uncovered')} />
      </KpiRow>
      <KpiFilterNotice filter={kpi} label={BSV_KPI_LABEL[kpi.key]} shown={shown.length} total={searched.length} />

      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <ChipRail label="Stock" states={['covered', 'on_order', 'short']}
            labels={BOARD_LABEL} tones={BOARD_TONE} countTones={BOARD_COUNT_TONE} counts={stockCounts}
            active={stockFilter} onToggle={toggleIn(setStockFilter)} onClear={() => setStockFilter([])} />
          <ChipRail label="Verification" states={Object.keys(VERIF_LABEL)}
            labels={VERIF_LABEL} tones={VERIF_TONE} countTones={VERIF_COUNT_TONE} counts={verifCounts}
            active={verifFilter} onToggle={toggleIn(setVerifFilter)} onClear={() => setVerifFilter([])} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <ChipRail label="Cutting" states={['not_sent', 'waiting', 'planned']}
            labels={CUT_LABEL} tones={{
              not_sent: 'border-slate-300 bg-slate-100 text-slate-600',
              waiting: 'border-amber-200 bg-amber-50 text-amber-700',
              planned: 'border-[#0A84FF]/25 bg-[#E1EFFF] text-[#0064D2]',
            }} counts={cutCounts}
            active={cutFilter} onToggle={toggleIn(setCutFilter)} onClear={() => setCutFilter([])} />
          <div className="inline-flex shrink-0 items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Board</span>
            <Select className="w-40" value={grade} onChange={e => setGrade(e.target.value)} placeholder="All types">
              <option value="">All types</option>
              {grades.map(g => <option key={g} value={g}>{g}</option>)}
            </Select>
            <Select className="w-32" value={gsm} onChange={e => setGsm(e.target.value)} placeholder="All GSM">
              <option value="">All GSM</option>
              {gsms.map(g => <option key={g} value={String(g)}>{g} GSM</option>)}
            </Select>
          </div>
          <div className="inline-flex shrink-0 items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Cutting by</span>
            <div className="w-36 shrink-0"><Input type="date" className="h-9" value={cutBefore} onChange={e => setCutBefore(e.target.value)} /></div>
            <span className="text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Dispatch by</span>
            <div className="w-36 shrink-0"><Input type="date" className="h-9" value={dispBefore} onChange={e => setDispBefore(e.target.value)} /></div>
          </div>
          <div className="inline-flex shrink-0 items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Sort</span>
            <Select className="w-48" value={sortKey} onChange={e => setSortKey(e.target.value)}>
              {Object.entries(SORTS).map(([kk, s]) => <option key={kk} value={kk}>{s.label}</option>)}
            </Select>
          </div>
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'report', label: 'Verification Report', count: shown.length },
        { key: 'coverage', label: 'Board vs Product Requirement', count: shown.length },
      ]} />

      {loading && <p className="rounded-xl border border-dashed border-white/70 bg-white/65 py-14 text-center text-sm text-gray-400 backdrop-blur-xl">Loading the board position…</p>}

      {!loading && shown.length === 0 && (
        <p className="rounded-xl border border-dashed border-white/70 bg-white/65 py-14 text-center text-sm text-gray-400 backdrop-blur-xl">
          {boards.length === 0
            ? 'Nothing to verify — no live job is waiting on board ahead of cutting.'
            : 'No boards match the current filters. Clear a chip or the search to widen the view.'}
        </p>
      )}

      {!loading && shown.length > 0 && tab === 'report' && (
        <div className="ci-data-panel">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="ci-table-head">
                <th className={`${th} w-8`} />
                <th className={`${th} text-right`}>S.No.</th>
                <th className={`${th} min-w-[240px]`}>Board</th>
                <th className={`${th} min-w-[92px]`}>Client</th>
                <th className={`${th} min-w-[230px]`}>Product</th>
                <th className={`${th} min-w-[104px] text-right`}>Order Qty</th>
                <th className={`${th} min-w-[120px]`}>Cutting</th>
                <th className={`${th} min-w-[130px] text-right`}>Board Needed</th>
                <th className={`${th} min-w-[180px] text-right`}>Warehouse Position</th>
                <th className={`${th} min-w-[130px]`}>On Order</th>
                <th className={`${th} min-w-[110px] text-right`}>Shortage</th>
                <th className={`${th} min-w-[190px]`}>Stock Position</th>
                <th className={`${th} min-w-[230px]`}>Physical Verification</th>
                <th className={th} />
              </tr></thead>
              <tbody>
                {shown.map((b, i) => {
                  const isOpen = open.has(b.material_id);
                  const incoming = b.pr_pending_qty + b.po_pending_qty;
                  return (
                    <Fragment key={b.material_id}>
                      <tr className="ci-table-row cursor-pointer"
                        onClick={e => {
                          if (e.target.closest('button, a, input, select, label, [role="button"]')) return;
                          toggleOpen(b.material_id);
                        }}>
                        <td className={td}>
                          {isOpen ? <ChevronDown size={14} className="text-[#0A84FF]" /> : <ChevronRight size={14} className="text-slate-400" />}
                        </td>
                        <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>
                        <td className={td}>
                          <div className="font-bold text-slate-900">{b.board_name}</div>
                          <div className="text-[11px] text-slate-400">
                            {[b.board_code, b.grade, b.gsm ? `${b.gsm} GSM` : null, sizeOf(b)].filter(Boolean).join(' · ')}
                            {b.leftover ? ' · leftover strip' : ''}
                          </div>
                        </td>
                        <td className={td}>
                          <JobParts jobs={b.jobs} render={j => (
                            <span className="text-xs font-semibold text-slate-700" title={j.customer_name}>
                              {clientShort(j.customer_name)}
                            </span>
                          )} />
                        </td>
                        <td className={td}>
                          <JobParts jobs={b.jobs} render={j => (
                            <div className="flex min-w-0 items-start gap-1.5">
                              <ProductIdentity row={j} compact className="min-w-0 flex-1" codesClassName="max-w-[210px]" />
                              {j.gang_number && (
                                <span className="mt-0.5 shrink-0 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-600">
                                  {j.gang_number}
                                </span>
                              )}
                            </div>
                          )} />
                        </td>
                        <td className={`${td} text-right`}>
                          <JobParts jobs={b.jobs} align="right"
                            total={fmt.num(b.jobs.reduce((s, j) => s + (+j.order_qty || 0), 0))}
                            render={j => (
                              <>
                                <div className="text-xs font-semibold tabular-nums text-slate-800">
                                  {j.order_qty != null ? fmt.num(j.order_qty) : '—'}
                                </div>
                                {j.planned_qty != null && j.planned_qty !== j.order_qty && (
                                  <div className="text-[10px] tabular-nums text-slate-400">make {fmt.num(j.planned_qty)}</div>
                                )}
                              </>
                            )} />
                        </td>
                        <td className={td}>
                          <JobParts jobs={b.jobs} render={j => (
                            <>
                              <CutChip status={j.cutting_status} />
                              {j.planned_date && <div className="mt-0.5 text-[10px] text-slate-400">{fmt.date(j.planned_date)}</div>}
                            </>
                          )} />
                        </td>
                        <td className={`${td} text-right`}>
                          <JobParts jobs={b.jobs} align="right"
                            total={<>
                              <div>{fmt.num(b.required)}</div>
                              <QtyNote board={b} sheets={b.required} className="!text-right" />
                              <div className="text-[10px] font-semibold text-slate-400">{fmt.count(b.job_count, 'job')}</div>
                            </>}
                            render={j => (
                              <>
                                <div className="text-xs font-bold tabular-nums text-slate-800">{fmt.num(j.need)}</div>
                                <QtyNote board={b} sheets={j.need} />
                                {j.open_need > 0 && (
                                  <div className="text-[10px] tabular-nums text-amber-600">buy {fmt.num(j.open_need)}</div>
                                )}
                              </>
                            )} />
                        </td>
                        <td className={`${td} text-right`}>
                          <div className="font-semibold tabular-nums text-slate-800">{fmt.num(b.available)} <span className="text-[11px] font-normal text-slate-400">in warehouse</span></div>
                          <QtyNote board={b} sheets={b.available} />
                          <div className="text-[11px] tabular-nums text-slate-400">
                            committed {fmt.num(b.committed)} · {b.free >= 0
                              ? `free ${fmt.num(b.free)}`
                              : <span className="font-semibold text-red-600">short {fmt.num(-b.free)}</span>}
                          </div>
                        </td>
                        <td className={td}>
                          {incoming > 0 ? (
                            <>
                              <div className="font-semibold tabular-nums text-slate-700">{fmt.num(incoming)} <span className="text-[11px] font-normal text-slate-400">sheets</span></div>
                              <QtyNote board={b} sheets={incoming} />
                              <div className="text-[11px] text-slate-400">
                                {[...b.prs.map(x => x.pr_number), ...b.pos.map(x => x.po_number)].slice(0, 2).join(' · ')}
                                {b.prs.length + b.pos.length > 2 ? ` +${b.prs.length + b.pos.length - 2}` : ''}
                              </div>
                            </>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className={`${td} text-right`}>
                          {b.shortage > 0 ? (
                            <>
                              <div className="font-bold tabular-nums text-red-600">{fmt.num(b.shortage)}</div>
                              <QtyNote board={b} sheets={b.shortage} />
                              <div className="text-[11px] text-slate-400">
                                {b.uncovered > 0
                                  ? <span className="font-semibold text-red-700">uncovered {fmt.num(b.uncovered)}</span>
                                  : 'covered by PR/PO'}
                              </div>
                            </>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className={td}><BoardBadge state={b.stock_state} /></td>
                        <td className={td}>
                          <VerifBadge status={b.verification_status} />
                          {b.verification && b.verification_status !== 'pending' && (
                            <div className="mt-1 text-[11px] text-slate-400">
                              {b.verification.physical_qty != null && <>counted <b className="text-slate-600">{fmt.num(b.verification.physical_qty)}</b> · </>}
                              {b.verification.verified_by} · {fmt.dt(b.verification.created_at)}
                            </div>
                          )}
                          {b.verification_stale && (
                            <div className="mt-0.5 text-[11px] font-semibold text-amber-600">
                              <AlertTriangle size={11} className="mr-0.5 inline" /> requirement moved since count — re-verify
                            </div>
                          )}
                        </td>
                        <td className={`${td} text-right`}>
                          <div className="flex justify-end gap-1.5">
                            {canVerify && (
                              <Button size="sm" variant="secondary"
                                onClick={() => setVerifying({ board: b, status: 'verified', qty: '', remarks: '' })}>
                                <ClipboardCheck size={13} /> Verify
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" title="Verification history" onClick={() => openHistory(b)}>
                              <History size={13} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-l-[3px] border-l-[#0A84FF]/40">
                          {/* Spans every column of the row above — chevron, serial, the
                              six board/product columns, the four position columns and
                              the action rail. A new column that forgets this leaves the
                              detail panel short of the table's width. */}
                          <td colSpan={14} className="bg-[#F5F9FF]/70 px-5 pb-4 pt-1">
                            <div className="overflow-x-auto rounded-xl border border-[#0A84FF]/10 bg-white/70">
                              <table className="w-full text-xs">
                                <thead><tr>
                                  <th className={sth}>Client</th>
                                  <th className={sth}>Sales Order</th>
                                  <th className={sth}>Job Card</th>
                                  <th className={sth}>Product</th>
                                  <th className={`${sth} text-right`}>Ordered</th>
                                  <th className={`${sth} text-right`}>To Produce</th>
                                  <th className={`${sth} text-right`}>Board Needed</th>
                                  <th className={sth}>Cutting</th>
                                  <th className={sth}>Dispatch</th>
                                  <th className={sth}>PR</th>
                                  <th className={sth}>Remarks</th>
                                </tr></thead>
                                <tbody>
                                  {b.jobs.map(j => (
                                    <tr key={j.order_line_id} className="border-t border-slate-100">
                                      <td className={`${std} font-semibold text-slate-800`}>{j.customer_name}</td>
                                      <td className={std}>
                                        <div className="text-slate-700">PO {j.po_number}</div>
                                        <div className="text-[10px] text-slate-400">{j.po_date ? fmt.date(j.po_date) : '—'}</div>
                                      </td>
                                      <td className={std}>
                                        {j.jc_number ? (
                                          <>
                                            <div className="font-semibold text-slate-700">{j.jc_number}</div>
                                            <div className="text-[10px] text-slate-400">{fmt.date(j.jc_created_at)}</div>
                                          </>
                                        ) : <span className="text-slate-400">not created</span>}
                                      </td>
                                      <td className={std}>
                                        <div className="flex min-w-0 items-start gap-1.5">
                                          <ProductIdentity row={j} compact className="min-w-0 flex-1" codesClassName="max-w-[240px]" />
                                          {j.gang_number && (
                                            <span className="mt-0.5 shrink-0 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-600">
                                              {j.gang_number}
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className={`${std} text-right tabular-nums`}>{j.order_qty != null ? fmt.num(j.order_qty) : '—'}</td>
                                      <td className={`${std} text-right tabular-nums`}>{j.planned_qty != null ? fmt.num(j.planned_qty) : '—'}</td>
                                      <td className={`${std} text-right`}>
                                        <div className="font-bold tabular-nums">{fmt.num(j.need)}</div>
                                        {(j.held > 0 || j.incoming > 0) && (
                                          <div className="text-[10px] text-slate-400">
                                            {[j.held > 0 ? `held ${fmt.num(j.held)}` : null, j.incoming > 0 ? `on order ${fmt.num(j.incoming)}` : null].filter(Boolean).join(' · ')}
                                          </div>
                                        )}
                                      </td>
                                      <td className={std}>
                                        <CutChip status={j.cutting_status} />
                                        {j.planned_date && <div className="mt-0.5 text-[10px] text-slate-400">{fmt.date(j.planned_date)}</div>}
                                      </td>
                                      <td className={std}>{j.delivery_date ? fmt.date(j.delivery_date) : <span className="text-slate-300">—</span>}</td>
                                      <td className={std}>
                                        {j.pr_covered
                                          ? <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600">PR Raised</span>
                                          : b.pr_pending_qty > 0
                                            ? <span className="text-[10px] text-slate-400">board PR pending</span>
                                            : <span className="text-slate-300">—</span>}
                                      </td>
                                      <td className={`${std} max-w-[180px] text-[10px] text-slate-500`}>{j.line_notes || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && shown.length > 0 && tab === 'coverage' && (
        <DataTable
          columns={coverageCols}
          rows={shown}
          defaultSort={{ key: 'uncovered', dir: 'desc' }}
          exportName="Board vs Product Requirement"
          exportSubtitle="Which products wait on each board, and how the gap is covered"
          exportMeta={appliedMeta}
          exportSummary={exportSummary}
          empty="No boards match the current filters."
        />
      )}

      {/* Record a physical verification — never changes stock, never blocks Cutting */}
      <Modal open={!!verifying} onClose={() => setVerifying(null)}
        title={verifying ? `Physical verification — ${verifying.board.board_name}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setVerifying(null)}>Cancel</Button>
          <Button variant="success" disabled={!!verifyDisabled} onClick={saveVerification}>
            <ShieldCheck size={13} /> Save Verification
          </Button>
        </>}>
        {verifying && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <b>{verifying.board.board_name}</b>
                  <div className="text-xs text-slate-400">
                    {[verifying.board.grade, verifying.board.gsm ? `${verifying.board.gsm} GSM` : null, sizeOf(verifying.board)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <BoardBadge state={verifying.board.stock_state} compact />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-white px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase text-slate-400">Jobs need</div>
                  <div className="font-bold tabular-nums">{fmt.num(verifying.board.required)}</div>
                  <QtyNote board={verifying.board} sheets={verifying.board.required} className="!text-center" />
                </div>
                <div className="rounded-lg bg-white px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase text-slate-400">Book stock</div>
                  <div className="font-bold tabular-nums">{fmt.num(verifying.board.available)}</div>
                  <QtyNote board={verifying.board} sheets={verifying.board.available} className="!text-center" />
                </div>
                <div className="rounded-lg bg-white px-2 py-1.5">
                  <div className="text-[10px] font-bold uppercase text-slate-400">On order</div>
                  <div className="font-bold tabular-nums">{fmt.num(verifying.board.pr_pending_qty + verifying.board.po_pending_qty)}</div>
                  <QtyNote board={verifying.board} sheets={verifying.board.pr_pending_qty + verifying.board.po_pending_qty} className="!text-center" />
                </div>
              </div>
              <div className="mt-2 text-xs text-slate-400">
                Recording a verification never changes warehouse stock and never blocks Cutting.
                Stock corrections go through the usual warehouse adjustment.
              </div>
            </div>
            <Field label="Verification result" required>
              <Select value={verifying.status} onChange={e => setVerifying(v => ({ ...v, status: e.target.value }))}>
                {Object.entries(VERIF_LABEL).map(([kk, label]) => (
                  <option key={kk} value={kk}>{label}{kk === 'pending' ? ' (re-queue)' : ''}</option>
                ))}
              </Select>
            </Field>
            <Field label="Physically available quantity (parent sheets)"
              hint={verifying.status === 'not_found' ? 'Leave blank to record zero on the shelf.' : undefined}
              required={['verified', 'mismatch', 'partial'].includes(verifying.status)}>
              <Input type="number" min="0" value={verifying.qty}
                onChange={e => setVerifying(v => ({ ...v, qty: e.target.value }))}
                placeholder="Counted on the rack…" />
              {verifying.qty !== '' && verifying.qty != null && Number.isFinite(+verifying.qty) && (
                <QtyNote board={verifying.board} sheets={+verifying.qty} className="mt-1" />
              )}
            </Field>
            {preview && (
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className={`rounded-lg px-2 py-1.5 ${preview.shortage > 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>
                  <div className="text-[10px] font-bold uppercase opacity-70">Shortage vs jobs</div>
                  <div className="font-bold tabular-nums">{fmt.num(preview.shortage)}</div>
                </div>
                <div className={`rounded-lg px-2 py-1.5 ${preview.excess > 0 ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-500'}`}>
                  <div className="text-[10px] font-bold uppercase opacity-70">Excess vs jobs</div>
                  <div className="font-bold tabular-nums">{fmt.num(preview.excess)}</div>
                </div>
                <div className={`rounded-lg px-2 py-1.5 ${preview.book !== 0 ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
                  <div className="text-[10px] font-bold uppercase opacity-70">vs book</div>
                  <div className="font-bold tabular-nums">{preview.book > 0 ? '+' : ''}{fmt.num(preview.book)}</div>
                </div>
              </div>
            )}
            <Field label="Remarks">
              <Textarea value={verifying.remarks}
                onChange={e => setVerifying(v => ({ ...v, remarks: e.target.value }))}
                placeholder="Rack location, packet condition, count method…" />
            </Field>
          </div>
        )}
      </Modal>

      {/* Verification history — the audit trail for one board */}
      <Modal open={!!history} onClose={() => setHistory(null)} wide
        title={history ? `Verification history — ${history.board.board_name}` : ''}>
        {history && (
          history.rows == null
            ? <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
            : history.rows.length === 0
              ? <p className="py-8 text-center text-sm text-slate-400">No verification has been recorded for this board yet.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr>
                      <th className={sth}>Status</th>
                      <th className={`${sth} text-right`}>Counted</th>
                      <th className={`${sth} text-right`}>Required then</th>
                      <th className={`${sth} text-right`}>Book then</th>
                      <th className={`${sth} text-right`}>Short</th>
                      <th className={`${sth} text-right`}>Excess</th>
                      <th className={sth}>By</th>
                      <th className={sth}>When</th>
                      <th className={sth}>Remarks</th>
                    </tr></thead>
                    <tbody>
                      {history.rows.map(rw => (
                        <tr key={rw.id} className="border-t border-slate-100">
                          <td className={std}><VerifBadge status={rw.status} /></td>
                          <td className={`${std} text-right tabular-nums`}>{rw.physical_qty != null ? fmt.num(rw.physical_qty) : '—'}</td>
                          <td className={`${std} text-right tabular-nums`}>{rw.required_qty != null ? fmt.num(rw.required_qty) : '—'}</td>
                          <td className={`${std} text-right tabular-nums`}>{rw.available_qty != null ? fmt.num(rw.available_qty) : '—'}</td>
                          <td className={`${std} text-right tabular-nums ${rw.shortage_qty > 0 ? 'font-bold text-red-600' : ''}`}>{rw.shortage_qty != null ? fmt.num(rw.shortage_qty) : '—'}</td>
                          <td className={`${std} text-right tabular-nums`}>{rw.excess_qty != null ? fmt.num(rw.excess_qty) : '—'}</td>
                          <td className={std}>{rw.verified_by || '—'}</td>
                          <td className={std}>{fmt.dt(rw.created_at)}</td>
                          <td className={`${std} max-w-[220px]`}>{rw.remarks || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
        )}
      </Modal>
    </div>
  );
}
