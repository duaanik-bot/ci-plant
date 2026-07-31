// Planning — the CI-Production planning engine, distilled.
// Open a line → the engine auto-fills spec + cut plan from the masters,
// shows the board position with committed demand and incoming supply, smart-
// matches warehouse stock when the exact board is short, and locks the plan.
// Press + date live in Print Planning. Shortfall raises a PR without leaving
// the modal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import { Button, Checkbox, ConfirmDialog, DataTable, dueDelta, Field, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, PageHeader, Select, ShadeAge, StatusBadge, Tabs, Textarea, useKpiFilter, useToast } from '../components/ui.jsx';
import { CheckCircle2, Check, Wrench, AlertTriangle, PackageSearch, Truck, BookOpen, Palette, Layers, PackageCheck, ShieldCheck, ShieldQuestion, Scissors, Sparkles, Warehouse, NotebookPen, RotateCcw, Undo2, Link2, Plus, X, ChevronDown, ChevronRight, Printer } from 'lucide-react';
import WorkflowControls, { BulkWorkflowControls } from '../components/WorkflowControls.jsx';
import WarehousePicker, { clientFit } from '../components/WarehousePicker.jsx';
import { GangChip, GangCreatedSheet, GangCellParts } from '../components/Gang.jsx';
import BoardCommitments from '../components/BoardCommitments.jsx';
import BoardMix, { mixTotals } from '../components/BoardMix.jsx';
import { TrafficLight, ReadinessPopover } from '../components/Readiness.jsx';
import { customerInitials, customerSearchText } from '../lib/customerCode.js';

const DEFAULT_WASTAGE_SHEETS = 200;

// Rows behind the clickable Planning cards. These take a GROUPED row, so a gang
// is judged as the single job it will actually be: ready only when every member
// is green, late when any member is past its date — the same "weakest member
// decides" rule boardShort() uses.
const PLAN_KPI_ROWS = {
  ready: r => (r._gang || [r]).every(m => m.light?.light === 'green'),
  late: r => (r._gang || [r]).some(m => dueDelta(m.delivery_date) > 0),
};
const PLAN_KPI_LABEL = {
  ready: 'jobs with every gate green',
  late: 'jobs past their delivery date',
};

// Management-approval chip — the latest ask for this line. Advisory only: a
// pending or rejected ask never blocks Job Card / production; it just shows
// where the question stands. Hover carries the whole story (ask + decision).
function MgtChip({ a }) {
  if (!a || a.status === 'cancelled') return null;
  const tone = {
    pending: 'border-amber-200 bg-amber-50 text-amber-700',
    approved: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rejected: 'border-red-200 bg-red-50 text-red-600',
  }[a.status];
  const label = { pending: 'With management', approved: 'MGT approved', rejected: 'MGT rejected' }[a.status];
  const title = `${a.ar_number} — ${a.note}` +
    (a.decided_by ? ` · ${a.status} by ${a.decided_by}` : ` · asked by ${a.requested_by}`) +
    (a.decision_note ? ` — ${a.decision_note}` : '');
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>
      <ShieldQuestion size={10} /> {label}
    </span>
  );
}

// A gang is decided on three things — the board, its GSM and the coating — so
// each gets its own sortable column rather than sitting inside the product's
// sub-line. Sorting on Coating (or Board, or GSM) stacks the candidates for one
// press run together, which is how the planner finds them by eye.
//
// One value per row; a gang row folds its members and shows "mixed" when they
// genuinely differ, so a gang already broken across two boards is visible as
// such instead of silently reporting its first member.
function specCell(line, pick, format = v => v) {
  const values = [...new Set((line._gang || [line]).map(m => pick(m)).map(v => (v == null || v === '' ? null : v)))];
  if (values.length > 1) return { text: 'mixed', mixed: true };
  const v = values[0];
  return { text: v == null ? null : String(format(v)), mixed: false };
}

// Renders what specCell resolved: the value, a violet "mixed" when a gang is not
// uniform on it, or a dash. Kept in one place so all four spec columns read the
// same way down the table.
function SpecText({ line, pick, format, className = '' }) {
  const { text, mixed } = specCell(line, pick, format);
  if (mixed) return <span className="text-[11px] font-bold uppercase tracking-wide text-violet-500">mixed</span>;
  if (!text) return <span className="text-xs text-slate-300">—</span>;
  return <span className={className}>{text}</span>;
}

// The searchable text behind those columns — every member's raw value, so a
// search for a coating or a board still finds the gang that contains it even
// when the cell itself reads "mixed".
const specSearch = (line, pick) => (line._gang || [line]).map(m => pick(m) ?? '').join(' ');

// 'none' is how the master records an uncoated carton. Reading it back as the
// word "None" makes an uncoated job look like it carries a coating called None.
const coatingOf = m => (m.coating && m.coating !== 'none' ? m.coating : null);

// The carton's own size (L×W×H in mm), off products.size. That column is free
// text typed by whoever created the master, so the same carton appears as
// "142X115X108", "43 x 35 x 75" and "100 x 48 x 48" — three spellings of one
// fact. Normalised to a single compact form, otherwise the column reads as a
// ransom note and its width is set by whichever row had the most spaces.
// 1367 of 1594 products carry a size; the rest fall back to a dash.
const sizeOf = m => {
  const raw = String(m.size ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*(?:x|X|×|\*)\s*/).map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.join('x') : raw;
};

// A die's type only earns its sub-line when it says something the number does
// not: the Tooling Hub migration titled every untyped legacy die "Die <number>",
// which would just print the number twice.
const dieTypeOf = m => {
  const t = String(m.die_type ?? '').trim();
  if (!t) return null;
  return t.toLowerCase() === `die ${String(m.die_number ?? '').trim().toLowerCase()}` ? null : t;
};

// Readiness gates on one line: a single "Ready" pill when all pass, otherwise
// compact icon chips (green = cleared, grey = pending, red = material short,
// amber = short but a PR/PO is on order — the job may proceed, board awaited).
function ReadinessCell({ readiness, light }) {
  const short = readiness.material ? 0 : Math.max(0, readiness.parent_needed - readiness.available_sheets);
  const pending = !!readiness.material_pending;
  const gates = [
    { key: 'artwork', label: 'Artwork', icon: Palette, ok: readiness.artwork, hint: readiness.artwork ? 'ready' : 'pending' },
    { key: 'tooling', label: 'Tooling', icon: Wrench, ok: readiness.tooling, hint: readiness.tooling ? 'ready' : 'pending' },
    { key: 'material', label: 'Material', icon: Layers, ok: readiness.material,
      hint: readiness.material ? 'ready'
        : pending ? `short ${fmt.num(short)} parent sheets — PR/PO raised, board awaited`
        : `short ${fmt.num(short)} parent sheets` },
  ];
  // The dot answers "can this run"; the chips answer "what exactly is missing".
  // A planner wants both — the operator's screens carry the dot alone.
  const dot = light ? (
    <ReadinessPopover light={light}><TrafficLight light={light} size="sm" /></ReadinessPopover>
  ) : null;
  if (gates.every(g => g.ok)) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {dot}
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700">
          <CheckCircle2 size={12} /> Ready
        </span>
      </span>
    );
  }
  return (
    <div className="flex items-center gap-0.5">
      {dot}
      {gates.map(g => (
        <span key={g.key} title={`${g.label}: ${g.hint}`}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
            g.ok ? 'bg-emerald-50 text-emerald-600'
              : g.key === 'material' ? (pending ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500')
              : 'bg-slate-100 text-slate-400'
          }`}>
          <g.icon size={12} />
        </span>
      ))}
      {short > 0 && (
        <span className={`ml-0.5 whitespace-nowrap text-[10px] font-bold tabular-nums ${pending ? 'text-amber-600' : 'text-red-600'}`}
          title={pending ? `Material short ${fmt.num(short)} parent sheets — PR/PO raised, board awaited`
            : `Material short ${fmt.num(short)} parent sheets`}>
          −{fmt.num(short)}
        </span>
      )}
    </div>
  );
}

// wrap: long text (customer names, board names) breaks onto extra lines
// instead of being cut with an ellipsis.
function Stat({ label, value, accent = 'text-slate-900', small, wrap }) {
  return (
    <div className="min-w-0 rounded-xl bg-slate-50 px-3 py-2">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-slate-400" title={label}>{label}</div>
      <div className={`${small ? 'text-[13px]' : 'text-sm'} ${wrap ? 'break-words leading-snug' : 'truncate'} font-extrabold tabular-nums ${accent}`} title={typeof value === 'string' ? value : undefined}>{value}</div>
    </div>
  );
}

// Section card — one visual language for every engine block.
function Card({ icon: Icon, title, sub, actions, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-[#1D1D1F]/[0.07] bg-white/55 p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-400">
          {Icon && <Icon size={13} className="shrink-0" />}
          <span className="truncate">{title}</span>
          {sub && <span className="truncate font-medium normal-case tracking-normal text-slate-400">— {sub}</span>}
        </h4>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// Editable combobox backed by the Product Master's real values. The field shows
// exactly what the master stores and offers every value the plant actually uses
// (datalist), while still allowing a one-off custom entry. The current value is
// always in the list so a master/override value never silently vanishes.
function SpecCombo({ id, value, options = [], placeholder, onChange }) {
  const list = [...new Set([...options, value].filter(v => v != null && v !== ''))];
  return (
    <>
      <Input list={id} value={value} placeholder={placeholder} onChange={onChange} />
      <datalist id={id}>{list.map(o => <option key={o} value={o} />)}</datalist>
    </>
  );
}

// Small amber marker on a field label whose value differs from the master.
function Edited() {
  return <span className="ml-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-px align-middle text-[9px] font-bold uppercase tracking-wide text-amber-600">edited</span>;
}

// Gang compatibility, previewed live in the create modal (the server is the
// authority — this mirrors its rules so the planner sees the answer instantly).
// No hard blocks — every mismatch is a soft warning the planner can override.
// The planner may deliberately gang different boards/coatings/customers (same
// size/GSM under different grade names, etc.) and process anyway; the server
// treats all of these as warnings too, so nothing here rejects the run.
function gangPreview(lines) {
  const uniq = pick => [...new Set(lines.map(pick).filter(v => v != null && v !== ''))];
  const conflicts = [];
  const warnings = [];
  if (uniq(l => l.board_material_id).length > 1) warnings.push({ field: 'Board', values: uniq(l => l.board_name) });
  if (uniq(l => l.coating).length > 1) warnings.push({ field: 'Coating', values: uniq(l => fmt.title(l.coating)) });
  if (uniq(l => l.colors).length > 1) warnings.push({ field: 'Colours', values: uniq(l => `${l.colors}c`) });
  if (uniq(l => l.special).length > 1) warnings.push({ field: 'Finish', values: uniq(l => fmt.title(l.special)) });
  const gsms = lines.map(l => l.gsm).filter(g => g != null);
  if (gsms.length > 1 && Math.max(...gsms) - Math.min(...gsms) > 10) warnings.push({ field: 'GSM', values: [...new Set(gsms.map(String))] });
  const days = lines.map(l => Date.parse(l.delivery_date)).filter(Number.isFinite);
  if (days.length > 1 && (Math.max(...days) - Math.min(...days)) / 86400000 > 7) warnings.push({ field: 'Delivery', values: uniq(l => fmt.date(l.delivery_date)) });
  return { ok: conflicts.length === 0, conflicts, warnings };
}

// The violet gang language (chip / unified member grid) lives in components/Gang.jsx
// so Planning, the stations, Job Cards and Track all render a gang identically.

const CATEGORY_STYLE = {
  exact: 'bg-emerald-50 text-emerald-700',
  near: 'bg-amber-50 text-amber-700',
  alternate: 'bg-violet-50 text-violet-700',
};
const CATEGORY_LABEL = { exact: 'Exact', near: 'Near', alternate: 'Alternate' };

export default function Planning() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [planLine, setPlanLine] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [boardSel, setBoardSel] = useState(null); // effective board for this plan (may be a warehouse pick)
  const [boardHist, setBoardHist] = useState([]); // previous selections, newest last — powers Undo
  const [mixRows, setMixRows] = useState([]); // Board Mix draft — {material_id, sheets, ups, ...} rows
  const [form, setForm] = useState({ qty: '', ups: '', wastage_sheets: '', colors: '', colour_type: '', pasting_type: '', coating: '', emboss: '0', leafing: '0', leafing_colour: '', child_l: '', child_w: '', parent_l: '', parent_w: '', party_artwork_code: '', output_number: '', die_number: '', block_number: '', notes: '' });
  const [lo, setLo] = useState({ push: false, strip: null }); // leftover offcut → warehouse decision
  const [prBusy, setPrBusy] = useState(false);
  const [prView, setPrView] = useState(null);    // inline PR tracker (chip click)
  const [dupPr, setDupPr] = useState(null);      // duplicate-PR confirmation { existing, count, add_qty, reason }
  const [whOpen, setWhOpen] = useState(false);
  const [boardPanel, setBoardPanel] = useState(false);
  const [smart, setSmart] = useState(null);      // smart-match results for the current shortage
  const [smartAll, setSmartAll] = useState(false);
  const [consumeLot, setConsumeLot] = useState(null); // { lot, qty } — confirm FG consumption
  const [fgUse, setFgUse] = useState(null); // "Use FG Stock" popup straight from the queue
  const [masterPrompt, setMasterPrompt] = useState(null); // { changed: {...} }
  const [reverseConfirm, setReverseConfirm] = useState(false); // form-level "Reverse Plan" confirm
  const [reverseBusy, setReverseBusy] = useState(false);
  const canPlanRole = ['admin', 'planner'].includes(auth.user?.role);
  const [selectedIds, setSelectedIds] = useState([]);
  const [tab, setTab] = useState('pending');
  const [boardFilter, setBoardFilter] = useState('all');   // 'all' | 'short' | 'ready'
  const [gangSel, setGangSel] = useState(null);     // lines being reviewed in the create-gang modal
  const [gangBusy, setGangBusy] = useState(false);
  const [gangView, setGangView] = useState(null);   // fetched gang detail — drives the ONE unified Gang Engine
  const [gangEdits, setGangEdits] = useState({});   // per-member draft { [lineId]: { qty, ups } } in the gang engine
  const [gangWastage, setGangWastage] = useState(String(DEFAULT_WASTAGE_SHEETS)); // shared wastage in the gang engine
  const [gangIssue, setGangIssue] = useState(''); // planner's manual "sheets to issue" override ('' = follow the calc)
  const [gangWhOpen, setGangWhOpen] = useState(false); // gang board Warehouse picker open (manual)
  const [gangSmart, setGangSmart] = useState(null);  // smart-match board suggestions (null = closed)
  const [gangExpand, setGangExpand] = useState(null); // line id whose full spec panel is open
  const [gangSpecForm, setGangSpecForm] = useState(null); // per-product identity draft in the expander
  const [gangSheetForm, setGangSheetForm] = useState({ child_l: '', child_w: '', coating: '' }); // unified gang sheet lock (child + coating)
  const [gangReverseOpen, setGangReverseOpen] = useState(false); // reverse confirm
  const [gangSheetPrompt, setGangSheetPrompt] = useState(null); // master-update popup for the gang sheet lock
  const [gangBusyLock, setGangBusyLock] = useState(false); // Lock Gang Plan in flight
  const [engineFromGang, setEngineFromGang] = useState(null); // gang_run_id to reopen after the single-product engine closes
  const [gangAddable, setGangAddable] = useState(null); // eligible lines picker (null = closed)
  const [gangAddSel, setGangAddSel] = useState([]);  // ids chosen to add
  const [gangSuccess, setGangSuccess] = useState(null); // freshly created gang → UPI-style confirmation sheet
  const [suggestions, setSuggestions] = useState([]);
  const [hideSuggest, setHideSuggest] = useState(false);
  const [approvals, setApprovals] = useState({});   // order_line_id → latest management ask (chips + menu state)
  const [askMgt, setAskMgt] = useState(null);       // { line, note } — "Ask Management Approval" popup
  const [askBusy, setAskBusy] = useState(false);
  const [specOpts, setSpecOpts] = useState({ coating: [], special: [], colour_type: [], pasting_type: [], leafing_colour: [] }); // distinct master values → engine pickers
  const smartSeq = useRef(0);

  const load = () => Promise.all([
    api.get('/planning').then(setLines),
    api.get('/gang-suggestions').then(setSuggestions).catch(() => {}),
    api.get('/approvals/by-line').then(setApprovals).catch(() => {}),
  ]);
  useEffect(() => { load(); }, []);
  useEffect(() => { api.get('/spec-options').then(setSpecOpts).catch(() => {}); }, []);
  const pending = lines.filter(l => l.status === 'pending');
  const planned = lines.filter(l => ['planned', 'ready'].includes(l.status));
  // Completed = pushed onward to a job card (left the planner's active queue).
  const completed = lines.filter(l => l.status === 'in_production');
  // "All" shows every planning state at once (To Plan + Planned + Completed).
  const shown = { pending, planned, completed, all: lines }[tab] || pending;
  // A gang collapses into ONE row: the anchor line carries `_gang` (all member
  // lines, in id order) and a synthetic id so it never collides with a line id.
  const groupedRows = (() => {
    const out = [];
    const seen = new Set();
    for (const r of shown) {
      if (!r.gang_run_id) { out.push(r); continue; }
      if (seen.has(r.gang_run_id)) continue;
      seen.add(r.gang_run_id);
      const members = shown.filter(x => x.gang_run_id === r.gang_run_id);
      out.push(members.length > 1 ? { ...r, id: `gang-${r.gang_run_id}`, _gang: members } : r);
    }
    return out;
  })();
  // Board shortage — the readiness gate the planner actually schedules around.
  // A gang counts as short if ANY member is: the run cannot go on press with one
  // member's board missing, so hiding it behind a healthy sibling would be a lie.
  // Applied AFTER grouping for the same reason — filtering members would split
  // a run that must move as one.
  const boardShort = r => (r._gang || [r]).some(m => m.readiness && !m.readiness.material);
  const shortCount = groupedRows.filter(boardShort).length;
  // A KPI card can narrow the queue too. It runs AFTER the board chips and on
  // GROUPED rows for the same reason board shortage does: a gang goes to press
  // as one job, so it is ready only when every member is, and late when any
  // member is. The Board Short card is not here — it drives boardFilter itself,
  // so board never ends up filtered from two places at once.
  const planKpi = useKpiFilter(tab);
  const boardRows = boardFilter === 'all' ? groupedRows
    : groupedRows.filter(r => (boardFilter === 'short' ? boardShort(r) : !boardShort(r)));
  const displayRows = planKpi.apply(boardRows, PLAN_KPI_ROWS);

  // KPI strip — counts follow whatever the thing beside them counts, or the
  // planner stops believing both. Job/carton/readiness figures run over the
  // tab's LINES, matching the tab badges above; the board figures run over
  // groupedRows through the SAME boardShort() the Board short/ready chips use,
  // so a gang is one job in the strip exactly as it is in the chip. Deliberately
  // NOT filtered by boardFilter: the strip describes the whole tab and the chips
  // drill into it — a Board Short card that only counted the board-short filter
  // would just be restating its own filter.
  const kpiPlan = (() => {
    const rows = shown;
    const lit = k => rows.filter(l => l.light?.light === k).length;
    // Same arithmetic as ReadinessCell, so the queue's red "−725" on a row and
    // the strip's total are the same number counted the same way.
    const shortOf = l => (l.readiness && !l.readiness.material
      ? Math.max(0, (+l.readiness.parent_needed || 0) - (+l.readiness.available_sheets || 0)) : 0);
    const shortRows = groupedRows.filter(boardShort);
    const late = rows.filter(l => dueDelta(l.delivery_date) > 0);
    return {
      jobs: rows.length,
      gangs: new Set(rows.filter(l => l.gang_run_id).map(l => l.gang_run_id)).size,
      ganged: rows.filter(l => l.gang_run_id).length,
      onPress: rows.filter(l => l.machine_name).length,
      qty: rows.reduce((s, l) => s + (+l.qty || 0), 0),
      fgCovered: rows.reduce((s, l) => s + (+l.fg_consumed_qty || 0), 0),
      parentSheets: rows.reduce((s, l) => s + (+l.parent_sheets_required || 0), 0),
      childSheets: rows.reduce((s, l) => s + (+l.sheets_required || 0), 0),
      green: lit('green'), amber: lit('amber'), red: lit('red'),
      // shortRows.length is shortCount by construction — the chip's number.
      shortSheets: shortRows.flatMap(r => r._gang || [r]).reduce((s, m) => s + shortOf(m), 0),
      onOrder: shortRows.filter(r => (r._gang || [r]).some(m => m.readiness?.material_pending)).length,
      late: late.length,
      worstLate: late.reduce((s, l) => Math.max(s, dueDelta(l.delivery_date) || 0), 0),
      dueSoon: rows.filter(l => { const d = dueDelta(l.delivery_date); return d !== null && d <= 0 && d >= -7; }).length,
    };
  })();

  const selectedLines = lines.filter(l => selectedIds.includes(l.id));
  const clearSelection = () => setSelectedIds([]);
  // Selecting a gang row selects every member line (they act as one job).
  const rowIds = row => (row._gang ? [row.id, ...row._gang.map(m => m.id)] : [row.id]);
  const toggleSelected = (row, checked) => setSelectedIds(ids => checked
    ? [...new Set([...ids, ...rowIds(row)])]
    : ids.filter(id => !rowIds(row).includes(id)));
  const toggleAll = (visibleRows, checked) => {
    const visibleIds = visibleRows.flatMap(rowIds);
    setSelectedIds(ids => checked
      ? [...new Set([...ids, ...visibleIds])]
      : ids.filter(id => !visibleIds.includes(id)));
  };

  // Ask management — advisory sign-off for the selective job where something
  // looks off (rate, qty, board, date…). One open ask per line (server-
  // enforced); a pending or rejected ask never blocks Job Card or production.
  const effLine = l => (l._gang ? l._gang[0] : l);
  const submitAsk = async () => {
    const note = (askMgt?.note || '').trim();
    if (!note) { toast.error('Write what management should look at — that note is the ask'); return; }
    setAskBusy(true);
    try {
      const a = await api.post('/approvals', { order_line_id: askMgt.line.id, note });
      toast.success(`${a.ar_number} sent to management`);
      setAskMgt(null);
      load();
    } finally { setAskBusy(false); }
  };
  const withdrawAsk = async a => {
    await api.post(`/approvals/${a.id}/cancel`);
    toast.success(`${a.ar_number} withdrawn`);
    load();
  };
  const mgtMenuItems = l => {
    if (!canPlanRole) return [];
    const eff = effLine(l);
    const a = approvals[eff.id];
    return a?.status === 'pending'
      ? [{ key: 'mgt', label: `Withdraw ${a.ar_number}`, icon: ShieldQuestion, onClick: () => withdrawAsk(a) }]
      : [{ key: 'mgt', label: 'Ask Management Approval', icon: ShieldQuestion, onClick: () => setAskMgt({ line: eff, note: '' }) }];
  };

  const loadCtx = (line, boardId) =>
    api.get(`/planning/${line.id}/context${boardId && boardId !== line.board_material_id ? `?board_material_id=${boardId}` : ''}`);

  const openPlan = async l => {
    setPlanLine(l); setCtx(null); setSmart(null); setSmartAll(false); setBoardHist([]);
    setBoardSel({ id: l.board_material_id, name: l.board_name, sheet_l: l.sheet_l, sheet_w: l.sheet_w });
    setForm({
      qty: String(l.qty ?? ''),
      ups: String(l.ups),
      wastage_sheets: String(l.wastage_sheets ?? DEFAULT_WASTAGE_SHEETS),
      colors: String(l.colors ?? ''), colour_type: l.colour_type || '', pasting_type: l.pasting_type || '', coating: l.coating || '',
      emboss: String(l.emboss ? 1 : 0), leafing: String(l.leafing ? 1 : 0), leafing_colour: l.leafing_colour || '',
      child_l: l.child_l != null ? String(l.child_l) : '', child_w: l.child_w != null ? String(l.child_w) : '',
      parent_l: l.parent_l != null ? String(l.parent_l) : '', parent_w: l.parent_w != null ? String(l.parent_w) : '',
      // Single sets auto-populate the mapped Artwork Code + Output (print set)
      // Number from the Carton Product Master. Gang runs bypass this — a gang
      // layout generates its own dynamic set number.
      party_artwork_code: l.gang_run_id ? '' : (l.party_artwork_code || ''),
      output_number: l.gang_run_id ? '' : (l.output_number || ''),
      // Die & block are product identity too (hub auto-code is the fallback).
      die_number: l.die_number || '',
      block_number: l.block_number || '',
      notes: l.notes || '',
    });
    const savedLo = typeof l.leftover_plan === 'string' ? JSON.parse(l.leftover_plan) : l.leftover_plan;
    setLo(savedLo?.push ? { push: true, strip: savedLo.strip } : { push: false, strip: null });
    const d = await loadCtx(l);
    setCtx(d);
    // Seed the Board Mix draft from whatever is already saved for this line —
    // 'planned' role reads as severity 'none', every other row a generic
    // 'warn' (a saved row can never be 'heavy': plan-save 409s an ups-differing
    // row before it can reach the database, so nothing stronger ever persists).
    setMixRows((d?.mix?.rows || []).map(r => ({
      material_id: r.material_id, board_name: r.board_name, ups: r.ups, sheets: r.sheets,
      stock_batch_id: r.stock_batch_id, reason: r.reason || '',
      severity: r.role === 'planned' ? 'none' : 'warn',
    })));
  };

  // Master-driven fields the planner can edit here. The master-update
  // philosophy fires whenever one differs from what the line opened with.
  const changedSpec = () => {
    if (!planLine) return {};
    const out = {};
    const cmp = (f, v, isNum) => {
      // A field the server didn't send (e.g. an API that predates this spec)
      // has no master value to diff against — never flag it as an edit.
      if (planLine[f] === undefined) return;
      const cur = isNum ? +v : v;
      const master = isNum ? +planLine[f] : planLine[f];
      if (v !== '' && v != null && String(cur) !== String(master)) out[f] = cur;
    };
    cmp('ups', form.ups, true);
    cmp('colors', form.colors, true); cmp('coating', form.coating);
    cmp('colour_type', form.colour_type); cmp('pasting_type', form.pasting_type);
    cmp('emboss', form.emboss, true); cmp('leafing', form.leafing, true); cmp('leafing_colour', form.leafing_colour);
    cmp('child_l', form.child_l, true); cmp('child_w', form.child_w, true);
    cmp('parent_l', form.parent_l, true); cmp('parent_w', form.parent_w, true);
    if (!planLine.gang_run_id) { cmp('party_artwork_code', form.party_artwork_code); cmp('output_number', form.output_number); }
    cmp('die_number', form.die_number); cmp('block_number', form.block_number);
    if (boardSel && +boardSel.id !== +planLine.board_material_id) out.board_material_id = +boardSel.id;
    return out;
  };
  const edited = planLine ? changedSpec() : {};

  // Board grade + GSM are read off the board name. While a board override is in
  // play they PREVIEW the picked board (grade = first token, "NNN gsm" = GSM);
  // Update Master on Lock writes them back — see boardIdentity() on the server.
  const gradeOf = nm => String(nm || '').trim().split(/[\s·]+/)[0] || '';
  const gsmOf = nm => { const m = String(nm || '').match(/(\d{2,4})\s*gsm/i); return m ? m[1] : ''; };
  const boardShift = !!(planLine && boardSel && +boardSel.id !== +planLine.board_material_id);
  const shownGrade = boardShift ? gradeOf(boardSel?.name) : (planLine?.board_grade || '');
  const shownGsm = boardShift ? gsmOf(boardSel?.name) : (planLine?.gsm ? String(planLine.gsm) : '');

  // Live cut-plan math — CI-Production formula: qty / ups gives base child
  // print sheets, wastage is added in absolute sheets (plant default 200);
  // the parent-sheet fit converts to board to issue.
  const calc = useMemo(() => {
    if (!planLine || !boardSel) return null;
    const ups = Math.max(1, +form.ups || planLine.ups);
    const wastage = Math.max(0, Math.round(+form.wastage_sheets || 0));
    // Production plans the BALANCE: ordered qty minus verified FG consumed.
    // Order qty is editable here — the entered value drives the whole cut plan.
    const orderQty = form.qty === '' || form.qty == null ? planLine.qty : Math.max(0, Math.round(+form.qty));
    const planQty = Math.max(0, orderQty - (planLine.fg_consumed_qty || 0));
    const base = Math.ceil(planQty / ups);
    const total = base + wastage;
    const childL = +form.child_l || planLine.child_l;
    const childW = +form.child_w || planLine.child_w;
    // Parent cut = the finalised parent size the planner set, else the board's
    // full mother sheet. Editing it re-fits the cut plan live.
    const parentL = +form.parent_l || boardSel.sheet_l;
    const parentW = +form.parent_w || boardSel.sheet_w;
    const fit = clientFit(parentL, parentW, childL, childW);
    const cpp = fit?.cpp > 0 ? fit.cpp : 1;
    const parentTrimmed = (+form.parent_l && +form.parent_l !== +boardSel.sheet_l) || (+form.parent_w && +form.parent_w !== +boardSel.sheet_w);
    return {
      ups, wastage, base, total, planQty, childL, childW,
      wastagePctEq: base > 0 ? +((wastage / base) * 100).toFixed(1) : 0,
      sized: !!fit, cpp, waste: fit?.cpp > 0 ? fit.waste : null, util: fit?.cpp > 0 ? fit.util : null,
      parent: Math.ceil(total / cpp),
      parentSize: fit ? `${parentL}×${parentW}"` : null,
      parentTrimmed,
      childSize: fit ? `${childL}×${childW}"` : null,
      orderQty,
    };
  }, [planLine, boardSel, form.ups, form.wastage_sheets, form.child_l, form.child_w, form.parent_l, form.parent_w, form.qty]);

  // Gang cut-plan math — mirrors the server's per-member calc so the "sheets to
  // issue" breakdown updates live as wastage changes. Each member: qty÷ups gives
  // base child sheets, ÷ children-per-parent (its own child on the shared board)
  // gives parent sheets. The gang prints as ONE press run, so the wastage is a
  // SINGLE allowance booked to the lead member — never multiplied per product.
  const gangCalc = useMemo(() => {
    if (!gangView?.members?.length) return null;
    const w = Math.max(0, Math.round(+gangWastage || 0));
    const anchor = gangView.members[0];
    let baseChild = 0, childSheets = 0, parent = 0;
    const per = gangView.members.map((m, i) => {
      const net = Math.max(0, (+m.qty || 0) - (+m.fg_consumed_qty || 0));
      const ups = Math.max(1, +m.ups || 1);
      const base = Math.ceil(net / ups);
      const child = base + (i === 0 ? w : 0); // wastage once, on the lead member
      const fit = clientFit(anchor?.sheet_l, anchor?.sheet_w, +m.child_l || +anchor?.child_l, +m.child_w || +anchor?.child_w);
      const cpp = fit && fit.cpp > 0 ? fit.cpp : 1;
      const p = Math.ceil(child / cpp);
      baseChild += base; childSheets += child; parent += p;
      return { id: m.id, base, child, cpp, parent: p };
    });
    return { baseChild, wastageTotal: w, childSheets, parent, per, members: gangView.members.length };
  }, [gangView, gangWastage]);

  const position = useMemo(() => {
    if (!ctx || !calc) return null;
    const available = +ctx.stock.available;
    const committed = +ctx.stock.committed_other;
    const net = available - committed - calc.parent;
    const incoming = ctx.incoming.pos.reduce((s, p) => s + p.pending_qty, 0);
    return { available, committed, net, incoming, short: Math.max(0, -net) };
  }, [ctx, calc]);

  // A mix that does not balance, or carries a row needing its own plate, must
  // not lock — the server refuses it anyway, and a disabled button says so
  // before the planner has typed a reason for nothing. Recomputed from the
  // LIVE draft (mixRows) against the LIVE cut plan (calc.parent), never from
  // ctx.mix.balanced, which only reflects whatever was saved last.
  const mixOk = mixRows.length === 0
    || (mixTotals(mixRows, ctx?.mix?.planned_ups, calc?.parent ?? 0).balanced
        && !mixRows.some(r => r.ups_differ));

  // Smart Match — fetched only when the selected board runs short, debounced
  // so cut-plan typing doesn't spam the API.
  useEffect(() => {
    if (!planLine || !position || !calc) return;
    if (position.short <= 0) { setSmart(null); return; }
    const id = ++smartSeq.current;
    const t = setTimeout(() => {
      const dims = calc.childL > 0 && calc.childW > 0 ? `&child_l=${calc.childL}&child_w=${calc.childW}` : '';
      api.get(`/planning/${planLine.id}/smart-match?sheets=${calc.total}&board_material_id=${boardSel.id}${dims}`)
        .then(d => { if (smartSeq.current === id) { setSmart(d); setSmartAll(false); } })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [planLine?.id, boardSel?.id, position?.short, calc?.total, calc?.childL, calc?.childW]);

  // A warehouse / smart-match selection — job-level board change, previewed
  // instantly; the master-update philosophy asks its question on Lock.
  // Every switch records the outgoing board so Undo can step back through
  // the picks, and Reset jumps straight to the product master's board.
  const pickBoard = async row => {
    const next = { id: row.id ?? row.material_id, name: row.name, sheet_l: row.sheet_l, sheet_w: row.sheet_w };
    setBoardHist(h => [...h, boardSel]);
    setLo({ push: false, strip: null }); // a different board leaves different strips
    setBoardSel(next); setWhOpen(false); setCtx(null);
    setCtx(await loadCtx(planLine, next.id));
    toast.info(`Board switched to ${next.name} for this plan — lock to confirm`);
  };
  const undoBoard = async () => {
    const prev = boardHist[boardHist.length - 1];
    if (!prev) return;
    setBoardHist(h => h.slice(0, -1));
    setLo({ push: false, strip: null });
    setBoardSel(prev); setCtx(null);
    setCtx(await loadCtx(planLine, prev.id));
    toast.info(`Board back to ${prev.name}`);
  };
  const resetBoard = async () => {
    const master = { id: planLine.master_board_material_id, name: planLine.board_name, sheet_l: planLine.sheet_l, sheet_w: planLine.sheet_w };
    // board_name/sheet dims in the line row belong to the effective board; if it
    // was overridden, the context reload below fetches the master board's data.
    setBoardHist(h => [...h, boardSel]);
    setLo({ push: false, strip: null });
    setBoardSel(master); setCtx(null);
    const fresh = await loadCtx(planLine, master.id);
    setBoardSel({ id: fresh.board.id, name: fresh.board.name, sheet_l: fresh.board.sheet_l, sheet_w: fresh.board.sheet_w });
    setCtx(fresh);
    toast.info('Board reset to the product master');
  };

  // Clicking Lock: if a master-driven field changed, ask the philosophy question.
  const onLock = () => {
    if (lo.push && !lo.strip) { toast.error('Pick which leftover strip to keep, or turn off the warehouse push'); return; }
    const changed = changedSpec();
    if (Object.keys(changed).length) setMasterPrompt({ changed });
    else savePlan({ spec: {}, update_master: false });
  };

  const savePlan = async ({ spec, update_master }) => {
    const updated = await api.post(`/order-lines/${planLine.id}/plan`, {
      wastage_sheets: +form.wastage_sheets || 0, notes: form.notes,
      spec, update_master,
      // Only send qty when the planner actually changed it — avoids a needless
      // order-line write (and audit row) on every plain plan lock.
      ...(form.qty !== '' && +form.qty > 0 && +form.qty !== planLine.qty ? { qty: +form.qty } : {}),
      leftover: lo.push && lo.strip ? { push: true, strip: lo.strip } : { push: false },
      // A row a planner has zeroed out (or that the seed skipped — see the
      // "Cover with another board" handler) contributes nothing and the
      // server's job_board_mix CHECK (sheets > 0) refuses it outright; drop it
      // here rather than let a mix that reads balanced 400 on save.
      mix: mixRows.filter(r => Number(r.sheets) > 0).map(r => ({
        material_id: r.material_id, stock_batch_id: r.stock_batch_id,
        sheets: r.sheets, reason: r.reason,
      })),
    });
    toast.success(`Plan locked — ${fmt.num(calc.parent)} parent sheets · assign a press in Print Planning`
      + (update_master ? ' · Product Master updated' : Object.keys(spec || {}).length ? ' · saved for this job' : '')
      + (lo.push && lo.strip ? ` · leftover ${lo.strip.l}×${lo.strip.w}" → warehouse after cutting` : ''));
    // A gang shares one board — changing it moves this job out of the gang.
    if (planLine.gang_run_id && !updated.gang_run_id) {
      toast.info(`Board changed — ${planLine.product_name} removed from gang ${planLine.gang_number}`);
    }
    const gid = engineFromGang;
    setMasterPrompt(null); setEngineFromGang(null); setPlanLine(null); load();
    returnToGang(gid);   // back to Manage Gang if the engine was opened from there
  };

  // Reverse the locked plan straight from the engine — un-locks back to "To Plan".
  const reversePlan = async () => {
    setReverseBusy(true);
    try {
      await api.post(`/workflow/order-lines/${planLine.id}`, { action: 'reverse_plan' });
      toast.success(`${planLine.product_name} reversed to To Plan`);
      const gid = engineFromGang;
      setReverseConfirm(false); setEngineFromGang(null); setPlanLine(null); setTab('pending'); load();
      returnToGang(gid);
    } finally {
      setReverseBusy(false);
    }
  };

  // ── Gang printing ─────────────────────────────────────────────────────────
  const gangCheck = gangSel ? gangPreview(gangSel) : null;
  const createGang = async () => {
    setGangBusy(true);
    try {
      const gang = await api.post('/gang-runs', { line_ids: gangSel.map(l => l.id) });
      setGangSel(null); clearSelection(); load();
      setGangSuccess(gang); // the UPI-style confirmation carries the receipt
    } catch (e) {
      if (e.data?.code === 'GANG_CONFLICT') toast.error(e.message);
    } finally { setGangBusy(false); }
  };
  // Manage Gang is the gang's control centre: it seeds an editable qty/ups draft
  // per member and can pull in more jobs. Refreshing re-seeds the drafts so the
  // inputs always mirror the saved figures.
  const seedGangEdits = detail => setGangEdits(Object.fromEntries(
    detail.members.map(m => [m.id, { qty: String(m.qty ?? ''), ups: String(m.ups ?? '') }])));
  // Open the ONE unified Gang Engine (from the row button, the gang chip, or the
  // "Plan Gang Now" success sheet). It IS the planning engine — just gang-scoped.
  // The gang's shared sheet form (child + coating) is seeded from the first
  // member — after any lock they're identical across the gang anyway.
  const seedGangSheet = d => setGangSheetForm({
    child_l: d.members?.[0]?.child_l != null ? String(d.members[0].child_l) : '',
    child_w: d.members?.[0]?.child_w != null ? String(d.members[0].child_w) : '',
    coating: d.members?.[0]?.coating || '',
  });
  const openGangById = async gangId => {
    const d = await api.get(`/gang-runs/${gangId}`);
    setGangView(d); seedGangEdits(d); seedGangSheet(d); setGangAddable(null);
    setGangWastage(String(d.members?.[0]?.wastage_sheets ?? DEFAULT_WASTAGE_SHEETS));
    setGangIssue(d.issue_parent_sheets != null ? String(d.issue_parent_sheets) : '');
  };
  const openGang = l => openGangById(l.gang_run_id);
  const gangMemberDraft = (id, patch) => setGangEdits(e => ({ ...e, [id]: { ...e[id], ...patch } }));
  const gangMemberDirty = m => {
    const d = gangEdits[m.id]; if (!d) return false;
    return (d.qty !== '' && +d.qty !== +m.qty) || (d.ups !== '' && +d.ups !== +m.ups);
  };
  const saveGangMember = async m => {
    const d = gangEdits[m.id] || {};
    const body = {};
    if (d.qty !== '' && +d.qty > 0 && +d.qty !== +m.qty) body.qty = +d.qty;
    if (d.ups !== '' && +d.ups >= 1 && +d.ups !== +m.ups) body.ups = +d.ups;
    if (!Object.keys(body).length) return;
    const detail = await api.patch(`/gang-runs/${gangView.id}/lines/${m.id}`, body);
    setGangView(detail); seedGangEdits(detail); load();
    toast.success(`${m.product_name} updated${body.qty ? ` · qty ${fmt.num(body.qty)}` : ''}${body.ups ? ` · ${body.ups} ups` : ''}`);
  };
  // Open the FULL planning engine on a gang member — the row carries only the
  // gang view's fields, so look the complete line up from the planning list.
  // We remember the gang so closing / locking the engine drops the planner
  // straight back into Manage Gang ("both" — quick controls AND the full engine).
  const openGangEngine = async m => {
    let full = lines.find(x => x.id === m.id);
    if (!full) { const fresh = await api.get('/planning'); setLines(fresh); full = fresh.find(x => x.id === m.id); }
    if (!full) { toast.error('Could not load this job — refresh planning'); return; }
    setEngineFromGang(m.gang_run_id ?? gangView?.id ?? null);
    setGangView(null);
    openPlan(full);
  };
  // Reopen the Manage Gang modal (used after the engine closes). Swallows a 404
  // in case the gang dissolved (e.g. the member's board changed on lock).
  const returnToGang = async gid => {
    if (!gid) return;
    try { const d = await api.get(`/gang-runs/${gid}`); setGangView(d); seedGangEdits(d); setGangAddable(null); }
    catch { /* gang no longer exists — stay on the planning list */ }
  };
  // Close the engine, returning to the gang it was opened from (if any).
  const dismissEngine = () => {
    const gid = engineFromGang;
    setEngineFromGang(null); setPlanLine(null);
    returnToGang(gid);
  };
  // Finalise the currently-selected board for the WHOLE gang — the mother sheet
  // is the one thing the gang shares, so it's set once for all members. Each
  // product keeps its own child size / ups; only the parent board is unified.
  const [gangBoardBusy, setGangBoardBusy] = useState(false);
  const applyGangBoard = async () => {
    if (!boardSel || !planLine?.gang_run_id) return;
    setGangBoardBusy(true);
    try {
      const d = await api.post(`/gang-runs/${planLine.gang_run_id}/board`, { board_material_id: +boardSel.id });
      toast.success(`${d.gang_number} — ${boardSel.name} set as the gang's board for all ${d.members.length} jobs`);
      // This job's board is now the gang board — reflect it so it's no longer a
      // pending "change" (Lock won't try to pull it out of the gang).
      const updatedLine = { ...planLine, board_material_id: +boardSel.id, board_name: boardSel.name, sheet_l: boardSel.sheet_l, sheet_w: boardSel.sheet_w };
      setPlanLine(updatedLine); setBoardHist([]);
      setCtx(await loadCtx(updatedLine, +boardSel.id));
      load();
    } finally { setGangBoardBusy(false); }
  };
  const openAddJobs = async () => {
    setGangAddSel([]);
    setGangAddable(await api.get(`/gang-runs/${gangView.id}/addable`));
  };
  const toggleAddSel = id => setGangAddSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const confirmAddJobs = async () => {
    const detail = await api.post(`/gang-runs/${gangView.id}/add-lines`, { line_ids: gangAddSel });
    setGangView(detail); seedGangEdits(detail); setGangAddable(null); load();
    toast.success(`${gangAddSel.length} job${gangAddSel.length > 1 ? 's' : ''} added to ${detail.gang_number}`);
  };
  // Set ONE common board (mother sheet) for the whole gang from the engine's
  // board picker — every product prints on the same sheet.
  const setGangBoard = async board => {
    const boardId = board.id ?? board.material_id;
    const d = await api.post(`/gang-runs/${gangView.id}/board`, { board_material_id: boardId });
    toast.success(`${d.gang_number} — board set to ${board.name} for all ${d.members.length} jobs`);
    setGangView(d); seedGangEdits(d); seedGangSheet(d); setGangWhOpen(false); load();
  };
  // Lock the gang's shared sheet — board (parent) + child + coating. Opens the
  // same master-update popup the single engine uses: keep the change job-only,
  // or push it back to the product master(s) for every future job.
  const lockGangSheet = () => {
    const anchor = gangView?.members?.[0];
    setGangSheetPrompt({
      gang_number: gangView.gang_number, count: gangView.members.length,
      payload: {
        board_material_id: anchor?.board_material_id,
        child_l: gangSheetForm.child_l, child_w: gangSheetForm.child_w, coating: gangSheetForm.coating,
      },
    });
  };
  const applyGangSheet = async updateMaster => {
    const d = await api.post(`/gang-runs/${gangView.id}/shared`, { ...gangSheetPrompt.payload, update_master: updateMaster });
    toast.success(updateMaster
      ? `${d.gang_number} — sheet saved to the product master(s) · applied to all ${d.members.length} jobs`
      : `${d.gang_number} — sheet locked for these ${d.members.length} jobs`);
    setGangSheetPrompt(null); setGangView(d); seedGangEdits(d); seedGangSheet(d); load();
  };
  // Lock the whole gang's cut plan in one go (shared wastage), then close.
  const lockGangPlan = async () => {
    setGangBusyLock(true);
    try {
      const d = await api.post(`/gang-runs/${gangView.id}/plan`, {
        wastage_sheets: +gangWastage || 0,
        issue_parent_sheets: gangIssue === '' ? null : Math.max(0, Math.round(+gangIssue)),
      });
      toast.success(`${d.gang_number} planned as one job — issuing ${fmt.num(d.total_parent_sheets)} parent sheets`);
      setGangView(null); load();
    } finally { setGangBusyLock(false); }
  };
  // Reverse the whole gang's plan back to To Plan (gang kept intact).
  const reverseGang = async () => {
    const d = await api.post(`/gang-runs/${gangView.id}/reverse`);
    toast.info(`${d.gang_number} reversed — ${d.members.length} jobs back to To Plan`);
    setGangReverseOpen(false); setGangView(d); seedGangEdits(d); load();
  };
  // Smart-match a shared board for the gang (auto-ranked); Manual = warehouse.
  const runGangSmart = async () => {
    const d = await api.get(`/gang-runs/${gangView.id}/smart-match`);
    setGangSmart(d.matches || []);
  };
  const pickSmartBoard = async m => {
    await setGangBoard({ id: m.material_id, name: m.name, sheet_l: m.sheet_l, sheet_w: m.sheet_w });
    setGangSmart(null);
  };
  // Per-product full spec — open the child builder + colours/coating/finish for
  // one member, edit inline, and save as a job-only override (re-derives sheets).
  // Per-product panel edits only the product's IDENTITY (artwork code, output /
  // set number). The shared sheet (parent · child · coating) is
  // locked at the gang level; pasting / embossing / effects come from the master.
  // Shade card is read-only everywhere now — live from the Shade Card module.
  const openSpec = m => {
    setGangExpand(gangExpand === m.id ? null : m.id);
    setGangSpecForm({
      party_artwork_code: m.party_artwork_code || '', output_number: m.output_number || '',
      die_number: m.die_number || '', block_number: m.block_number || '',
    });
  };
  const saveSpec = async m => {
    const f = gangSpecForm || {};
    const spec = {
      party_artwork_code: f.party_artwork_code, output_number: f.output_number,
      die_number: f.die_number, block_number: f.block_number,
    };
    const d = await api.patch(`/gang-runs/${gangView.id}/lines/${m.id}`, { spec });
    setGangView(d); seedGangEdits(d); setGangExpand(null);
    toast.success(`${m.product_name} identity saved`);
  };
  const gangRemoveLine = async lineId => {
    const d = await api.post(`/gang-runs/${gangView.id}/remove-line`, { line_id: lineId });
    if (d.dissolved) { toast.info('Gang dissolved — fewer than 2 jobs left'); setGangView(null); }
    else { setGangView(d); seedGangEdits(d); }
    load();
  };
  const gangDissolve = async () => {
    await api.del(`/gang-runs/${gangView.id}`);
    toast.info(`${gangView.gang_number} dissolved — jobs print on their own again`);
    setGangView(null); load();
  };
  const gangRaisePr = async () => {
    const pr = await api.post(`/gang-runs/${gangView.id}/raise-pr`);
    toast.success(`${pr.pr_number} raised for ${fmt.num(pr.qty)} parent sheets — one PR covers the whole gang`);
    setGangView(await api.get(`/gang-runs/${gangView.id}`));
  };

  const raisePrInline = async (opts = {}) => {
    setPrBusy(true);
    try {
      const qty = +opts.qty || position.short;
      const pr = await api.post('/requisitions', {
        material_id: boardSel.id,
        qty,
        needed_by: planLine.delivery_date,
        order_line_id: planLine.id,
        reason: `Shortfall for ${planLine.product_name} (PO ${planLine.po_number}) — planning engine`,
        ...(opts.reraise_of ? { reraise_of: opts.reraise_of, reraise_reason: opts.reraise_reason } : {}),
      });
      toast.success(`${pr.pr_number} raised for ${fmt.num(qty)} sheets`);
      setDupPr(null);
      setCtx(await loadCtx(planLine, boardSel.id));
    } finally { setPrBusy(false); }
  };

  // Duplicate-PR guard: raising a PR while this board already has an active
  // (pending/approved) requisition asks for explicit confirmation + reason.
  const onRaisePr = () => {
    const active = ctx?.incoming?.prs || [];
    if (active.length) {
      setDupPr({ existing: active[0], count: active.length, add_qty: String(position.short), reason: '' });
      return;
    }
    raisePrInline();
  };

  // Inline PR tracker — view/track a requisition without leaving the engine.
  const openPrTracker = async pr => {
    try { setPrView(await api.get(`/requisitions/${pr.id}`)); }
    catch { toast.error('Could not load the requisition'); }
  };

  const createJC = async l => {
    await api.post(`/order-lines/${l.id}/job-card`);
    toast.success('Job card created — see Print Planning');
    load();
  };

  // Consume verified FG against this line — confirmed in a dedicated modal.
  const doConsumeFg = async () => {
    const updated = await api.post(`/order-lines/${planLine.id}/consume-fg`, {
      lot_id: consumeLot.lot.id, qty: +consumeLot.qty,
    });
    toast.success(`${fmt.num(+consumeLot.qty)} pcs consumed from ${consumeLot.lot.lot_number} — balance to produce ${fmt.num(Math.max(0, updated.qty - updated.fg_consumed_qty))}`);
    setConsumeLot(null);
    setPlanLine(pl => ({ ...pl, fg_consumed_qty: updated.fg_consumed_qty, sheets_required: updated.sheets_required, parent_sheets_required: updated.parent_sheets_required }));
    setCtx(await loadCtx(planLine, boardSel.id));
    load();
  };

  // "Use FG Stock" — opened directly from the Planning Queue column. Fetches
  // the code-matched stock references and opens a self-contained popup; no need
  // to enter the full Planning Engine.
  const openFgUse = async l => {
    try {
      const d = await api.get(`/order-lines/${l.id}/fg-match`);
      if (!d.lots.length) { toast.info('No verified FG stock matches this order right now'); return; }
      const first = d.lots[0];
      setFgUse({
        ...d, lotId: first.id,
        qty: String(Math.min(first.remaining, d.line.balance_to_produce)),
        remarks: '',
      });
    } catch (e) { toast.error(e.message || 'Could not load FG stock'); }
  };
  const doFgUse = async () => {
    const lot = fgUse.lots.find(l => l.id === fgUse.lotId);
    const updated = await api.post(`/order-lines/${fgUse.line.id}/consume-fg`, {
      lot_id: fgUse.lotId, qty: +fgUse.qty, remarks: fgUse.remarks || undefined,
    });
    toast.success(`${fmt.num(+fgUse.qty)} pcs consumed from ${lot.lot_number} — balance to produce ${fmt.num(Math.max(0, updated.qty - updated.fg_consumed_qty))}`);
    setFgUse(null);
    load();
  };

  const verifyLot = async (lot, approve) => {
    await api.post(`/fg-lots/${lot.id}/verify`, { approve });
    toast.success(`${lot.lot_number} ${approve ? 'verified — approved for consumption' : 'rejected'}`);
    setCtx(await loadCtx(planLine, boardSel.id));
  };

  const specLabel = k => k === 'board_material_id' ? 'Board'
    : k === 'child_l' ? 'Child Length (in)' : k === 'child_w' ? 'Child Width (in)'
    : k === 'parent_l' ? 'Parent Length (in)' : k === 'parent_w' ? 'Parent Width (in)'
    : k === 'colour_type' ? 'Colour Type' : k === 'pasting_type' ? 'Pasting Type'
    : k === 'party_artwork_code' ? 'Artwork Code' : k === 'output_number' ? 'Output Number'
    : k === 'die_number' ? 'Die Number' : k === 'block_number' ? 'Block Number' : fmt.title(k);
  const specValue = (k, v) => {
    if (k === 'board_material_id') return String(v) === String(planLine?.board_material_id) ? planLine?.board_name : boardSel?.name;
    if (k === 'emboss' || k === 'leafing') return +v ? 'Yes' : 'No';
    return ['coating', 'special', 'leafing_colour'].includes(k) ? fmt.title(String(v)) : v;
  };

  const fgRelevant = ctx && (ctx.fg.lots.length > 0 || ctx.fg.consumed_qty > 0 || ctx.fg.verified_available > 0 || ctx.fg.pending_verification > 0);
  const smartShown = smart?.matches?.filter(m => !m.is_current) || [];
  const smartVisible = smartAll ? smartShown : smartShown.slice(0, 3);

  return (
    <div>
      <PageHeader title="Planning" subtitle="Requirement → cut plan → board position → machine & date → lock" />
      <Tabs active={tab} onChange={k => { setTab(k); clearSelection(); }} tabs={[
        { key: 'pending', label: 'To Plan', count: pending.length },
        { key: 'planned', label: 'Planned', count: planned.length },
        { key: 'completed', label: 'Completed', count: completed.length },
        { key: 'all', label: 'All', count: lines.length },
      ]} />

      <KpiRow cols={6}>
        <KpiCard compact icon={Layers} tone="info" label="Jobs in Queue"
          value={fmt.num(kpiPlan.jobs)}
          sub={kpiPlan.gangs
            ? `${fmt.num(kpiPlan.ganged)} in ${fmt.count(kpiPlan.gangs, 'gang run')}`
            : `${fmt.num(kpiPlan.onPress)} assigned to a press`} />
        <KpiCard compact icon={PackageCheck} tone="neutral" label="Cartons to Make"
          value={fmt.num(Math.max(0, kpiPlan.qty - kpiPlan.fgCovered))}
          sub={kpiPlan.fgCovered
            ? `${fmt.num(kpiPlan.qty)} ordered − ${fmt.num(kpiPlan.fgCovered)} from FG`
            : kpiPlan.qty ? 'none covered by FG stock' : 'nothing in this queue'} />
        <KpiCard compact icon={Scissors} tone="neutral" label="Parent Sheets"
          value={fmt.num(kpiPlan.parentSheets)}
          sub={kpiPlan.childSheets ? `${fmt.num(kpiPlan.childSheets)} print sheets` : 'no cut plan locked yet'} />
        <KpiCard compact icon={CheckCircle2} label="Ready to Run"
          tone={!kpiPlan.jobs ? 'neutral' : kpiPlan.green === kpiPlan.jobs ? 'good' : kpiPlan.green ? 'warn' : 'bad'}
          value={`${fmt.num(kpiPlan.green)}/${fmt.num(kpiPlan.jobs)}`}
          sub={`${fmt.num(kpiPlan.amber)} waiting · ${fmt.num(kpiPlan.red)} blocked`}
          onClick={() => planKpi.toggle('ready')} active={planKpi.is('ready')} />
        {/* Leads with the SHEET shortfall — the Board short chip below already
            carries the job count, and repeating it here would just be the same
            number twice. The job count stays in the sub so the two visibly
            agree; procurement needs the sheets, not another tally.
            Clicking it drives that SAME chip rather than adding a second board
            filter beside it: one piece of state, so the card and the chip
            cannot end up disagreeing about which rows are showing. */}
        <KpiCard compact icon={Warehouse} label="Board Short"
          tone={shortCount ? 'bad' : 'good'}
          value={fmt.num(kpiPlan.shortSheets)}
          sub={shortCount
            ? `sheets · ${fmt.count(shortCount, 'job')} short · ${fmt.num(kpiPlan.onOrder)} on PR/PO`
            : 'board in stock for every job'}
          onClick={() => { setBoardFilter(boardFilter === 'short' ? 'all' : 'short'); clearSelection(); }}
          active={boardFilter === 'short'} />
        <KpiCard compact icon={Truck} label="Delivery Pressure"
          tone={kpiPlan.late ? 'bad' : kpiPlan.dueSoon ? 'warn' : 'good'}
          value={fmt.num(kpiPlan.late)}
          sub={kpiPlan.late
            ? `past due · oldest ${kpiPlan.worstLate}d · ${fmt.num(kpiPlan.dueSoon)} due in 7d`
            : `none past due · ${fmt.num(kpiPlan.dueSoon)} due in 7 days`}
          onClick={() => planKpi.toggle('late')} active={planKpi.is('late')} />
      </KpiRow>
      <KpiFilterNotice filter={planKpi} label={PLAN_KPI_LABEL[planKpi.key]}
        shown={displayRows.length} total={groupedRows.length} />

      {/* Board shortage — the one gate that decides whether a job can be planned
          at all. "Board ready" is the list you can actually schedule today;
          "Board short" is the chase list for procurement. Both directions are
          offered because planners use each at a different point in the day. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11px] font-bold uppercase tracking-[0.02em] text-slate-400">Board</span>
        {[
          { key: 'all', label: 'All', count: groupedRows.length },
          { key: 'ready', label: 'Board ready', count: groupedRows.length - shortCount, tone: 'emerald' },
          { key: 'short', label: 'Board short', count: shortCount, tone: 'red' },
        ].map(f => {
          const on = boardFilter === f.key;
          const tone = on
            ? f.tone === 'red' ? 'border-red-200 bg-red-50 text-red-700'
              : f.tone === 'emerald' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-[#0A84FF]/25 bg-[#E1EFFF] text-[#0064D2]'
            : 'border-white/70 bg-white/60 text-slate-500 hover:bg-white';
          return (
            <button key={f.key} type="button"
              onClick={() => { setBoardFilter(f.key); clearSelection(); }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold backdrop-blur-xl transition-all duration-200 ease-apple active:scale-[0.97] ${tone}`}>
              {f.key === 'short' && <Layers size={12} />}
              {f.label}
              <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? 'bg-white/70' : 'bg-[#1D1D1F]/[0.07]'}`}>{f.count}</span>
            </button>
          );
        })}
      </div>

      {/* Gang opportunities — jobs already sharing a board + coating */}
      {!hideSuggest && suggestions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-violet-100 bg-violet-50/70 px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-bold text-violet-800">
            <Link2 size={13} /> Gang printing
          </span>
          {suggestions.slice(0, 3).map(s => (
            <button key={`${s.board_material_id}|${s.coating}`} type="button"
              onClick={() => setGangSel(lines.filter(l => s.line_ids.includes(l.id)))}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100">
              {s.lines.length} jobs · {s.board_name} · {fmt.title(s.coating)}
            </button>
          ))}
          <span className="text-[11px] text-violet-400">— same board & coating can share one press run</span>
          <button type="button" className="ml-auto text-violet-300 hover:text-violet-500" onClick={() => setHideSuggest(true)}>
            <X size={14} />
          </button>
        </div>
      )}
      <BulkWorkflowControls lines={selectedLines} context="planning" onDone={load} onClear={clearSelection}
        extra={selectedLines.length >= 2 && selectedLines.every(l => ['pending', 'planned'].includes(l.status) && !l.gang_run_id)
          ? <Button size="sm" className="rounded-xl px-2 py-1 text-[11px]"
              onClick={() => setGangSel(selectedLines)}><Link2 size={12} /> Gang Together</Button>
          : null} />
      <DataTable searchable
        selectable
        selectedIds={selectedIds}
        onToggleRow={toggleSelected}
        onToggleAll={toggleAll}
        // Newest sales order at the top. Without this the table fell back to its
        // first sortable column (PO number, ascending), so a freshly booked order
        // landed wherever its number sorted — usually the bottom, where nobody
        // could find it. order_id is not a column: it rises with entry, and the
        // table reads the raw row value, so this is purely the OPENING order.
        // Clicking any header still re-sorts the queue.
        defaultSort={{ key: 'order_id', dir: 'desc' }}
        groupBy={l => (l._gang ? `gang-${l.gang_run_id}` : null)}
        columns={[
          // The customer shows as initials (Swiss Garnier Life Sciences → SGLS):
          // full registered names ran three lines deep in this column and pushed
          // the spec columns off the screen. The full name stays on hover AND in
          // the search haystack via searchValue, so typing "swiss" still finds a
          // row that reads "SGLS". Export keeps the full name — a PDF has no
          // hover.
          { key: 'po_number', label: 'PO / Customer',
            export: l => l._gang
              ? `${l.gang_number}: ${[...new Set(l._gang.map(m => `${m.po_number} (${m.customer_name})`))].join(' | ')}`
              : `${l.po_number} (${l.customer_name})`,
            searchValue: l => (l._gang || [l])
              .map(m => `${m.po_number ?? ''} ${customerSearchText(m.customer_name)}`).join(' '),
            render: l => l._gang
            ? (() => {
                const pos = [...new Set(l._gang.map(m => m.po_number))];
                const custs = [...new Set(l._gang.map(m => m.customer_name).filter(Boolean))];
                return (
                  <div onClick={e => e.stopPropagation()}>
                    <GangChip number={l.gang_number} onClick={() => openGang(l)} />
                    <div className="mt-1 font-semibold text-gray-900">{pos.join(' · ')}</div>
                    <div className="text-xs text-gray-500" title={custs.join(' · ')}>
                      {custs.map(customerInitials).join(' · ')}
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-500">
                      {l._gang.length} jobs · one run
                    </div>
                  </div>
                );
              })()
            : (<div>
                <div className="font-semibold text-gray-900">{l.po_number}</div>
                <div className="text-xs font-semibold text-gray-500" title={l.customer_name}>
                  {customerInitials(l.customer_name) || <span className="text-gray-300">—</span>}
                </div>
              </div>) },
          { key: 'product_name', label: 'Product',
            export: l => l._gang ? l._gang.map(m => m.product_name).join(' + ') : l.product_name,
            render: l => l._gang
            ? <GangCellParts members={l._gang}
                total={<span className="font-semibold normal-case text-violet-600">together until die cutting</span>}
                render={m => (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="min-w-0">
                      <div className="max-w-[200px] truncate text-sm font-semibold text-gray-900" title={m.product_name}>{m.product_name}</div>
                      {/* Coating moved out to its own sortable column. */}
                      <div className="max-w-[200px] truncate text-xs text-gray-400">{m.product_code} · {m.colors}c{m.special !== 'none' ? ` · ${fmt.title(m.special)}` : ''}</div>
                    </div>
                    <button type="button" title={`Open the engine for ${m.product_name} only`}
                      className="shrink-0 rounded-lg p-1 text-slate-300 hover:bg-violet-100 hover:text-violet-600"
                      onClick={e => { e.stopPropagation(); openPlan(m); }}>
                      <Wrench size={12} />
                    </button>
                  </div>
                )} />
            // Capped, but NOT truncated: a carton name is how a planner
            // identifies the row, so it wraps to a second line rather than
            // losing its tail. Uncapped it claimed ~270px of a table that was
            // already 900px too wide for the screen.
            : (<div className="max-w-[200px]"><div className="flex items-center gap-1.5"><span className="break-words">{l.product_name}</span>{l.gang_number && <span onClick={e => e.stopPropagation()}><GangChip number={l.gang_number} onClick={() => openGang(l)} /></span>}</div><div className="break-words text-xs text-gray-400">{l.product_code} · {l.colors}c{l.special !== 'none' ? ` · ${fmt.title(l.special)}` : ''}</div></div>) },
          // ── The gang triad: coating · GSM · board. Sort on any one of them and
          // every job that could share a press run stacks together. Die follows,
          // because that is where a ganged run has to split again.
          { key: 'coating', label: 'Coating',
            // 'none' is the master's way of saying uncoated — it reads as a dash,
            // not as the word "None", so an uncoated job is visibly not a
            // candidate for a coated gang.
            sortValue: l => specCell(l, coatingOf, fmt.title).text || '',
            searchValue: l => specSearch(l, m => m.coating),
            export: l => specCell(l, coatingOf, fmt.title).text || '—',
            // Was nowrap, so a two-word coating ("Aqueous Varnish", "Drip Off +
            // Emboss") set the column's floor at its full one-line length. It
            // wraps now — two short lines cost nothing next to a three-line
            // product name in the same row.
            render: l => <SpecText line={l} pick={coatingOf} format={fmt.title}
              className="block max-w-[86px] text-xs font-semibold text-slate-700" /> },
          { key: 'gsm', label: 'GSM', align: 'right',
            sortValue: l => Number(specCell(l, m => m.gsm).text) || 0,
            searchValue: l => specSearch(l, m => m.gsm),
            export: l => specCell(l, m => m.gsm).text || '—',
            render: l => <SpecText line={l} pick={m => m.gsm} className="tabular-nums font-semibold text-slate-700" /> },
          // Grade is the "board type" a planner gangs on (Duplex GB, FBB,
          // Saffire…); the full board name — grade + GSM + parent size — sits
          // under it so the sheet actually being bought is never a guess.
          { key: 'board_grade', label: 'Board',
            sortValue: l => specCell(l, m => m.board_grade).text || '',
            searchValue: l => specSearch(l, m => `${m.board_grade ?? ''} ${m.board_name ?? ''}`),
            export: l => specCell(l, m => m.board_name).text || specCell(l, m => m.board_grade).text || '—',
            render: l => (
              <div className="min-w-0">
                <SpecText line={l} pick={m => m.board_grade} className="whitespace-nowrap text-xs font-semibold text-slate-700" />
                <div className="max-w-[142px] truncate text-[11px] text-slate-400"
                  title={specCell(l, m => m.board_name).text || ''}>
                  {specCell(l, m => m.board_name).text || ''}
                </div>
              </div>) },
          { key: 'die_number', label: 'Die',
            sortValue: l => specCell(l, m => m.die_number).text || '',
            searchValue: l => specSearch(l, m => `${m.die_number ?? ''} ${m.die_type ?? ''}`),
            export: l => specCell(l, m => m.die_number).text || '—',
            render: l => {
              const type = specCell(l, dieTypeOf).text;
              return (
                <div className="min-w-0">
                  <SpecText line={l} pick={m => m.die_number} className="whitespace-nowrap font-mono text-xs font-semibold text-slate-700" />
                  {type && <div className="max-w-[74px] truncate text-[11px] text-slate-400" title={type}>{type}</div>}
                </div>
              );
            } },
          // Carton dimensions, closing the spec block: coating · GSM · board ·
          // die · size. Sorting is on the longest edge, because "which cartons
          // are about this big" is the question a planner asks of it — a plain
          // string sort would file 100x48x48 next to 1000x48x48.
          { key: 'size', label: 'Size (mm)',
            sortValue: l => {
              const t = specCell(l, sizeOf).text;
              return t ? Math.max(...t.split('x').map(n => parseFloat(n) || 0)) : 0;
            },
            searchValue: l => specSearch(l, m => `${m.size ?? ''} ${sizeOf(m) ?? ''}`),
            export: l => specCell(l, sizeOf).text || '—',
            render: l => <SpecText line={l} pick={sizeOf}
              className="whitespace-nowrap font-mono text-[11px] font-semibold text-slate-600" /> },
          { key: 'qty', label: 'Qty', align: 'right',
            export: l => fmt.num(l._gang ? l._gang.reduce((s, m) => s + (+m.qty || 0), 0) : l.qty),
            sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (+m.qty || 0), 0) : l.qty),
            render: l => l._gang
              ? <GangCellParts members={l._gang} align="right"
                  total={fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))}
                  render={m => m.fg_consumed_qty > 0
                    ? (<div><div className="tabular-nums">{fmt.num(m.qty)}</div><div className="whitespace-nowrap text-[11px] font-semibold text-violet-600">−{fmt.num(m.fg_consumed_qty)} FG → {fmt.num(m.qty - m.fg_consumed_qty)}</div></div>)
                    : <span className="tabular-nums">{fmt.num(m.qty)}</span>} />
              : l.fg_consumed_qty > 0
                ? (<div><div className="tabular-nums">{fmt.num(l.qty)}</div><div className="whitespace-nowrap text-[11px] font-semibold text-violet-600">−{fmt.num(l.fg_consumed_qty)} FG → {fmt.num(l.qty - l.fg_consumed_qty)}</div></div>)
                : fmt.num(l.qty) },
          // "FG Stock Available" — the heading was the widest thing in a column
          // whose cell is a dash on most rows, so the words set the width.
          { key: 'fg_available', label: 'FG Stock', align: 'right', sortable: false, render: l => {
            const cell = m => (
              m.fg_available > 0 && ['pending', 'planned', 'ready'].includes(m.status)
                ? (<div className="flex flex-col items-end gap-1" onClick={e => e.stopPropagation()}>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700">
                      <PackageCheck size={11} /> {fmt.num(m.fg_available)}
                    </span>
                    <Button size="sm" variant="secondary" className="whitespace-nowrap !px-2 !py-1 !text-[11px]" onClick={() => openFgUse(m)}>Use FG Stock</Button>
                  </div>)
                : <span className="text-xs text-slate-300">—</span>
            );
            return l._gang ? <GangCellParts members={l._gang} align="right" render={cell} /> : cell(l);
          } },
          // Sheets and Press are the OUTPUT of planning — a line that has not
          // been planned yet cannot have either, so on the To Plan tab they were
          // two guaranteed columns of dashes holding 150px hostage. They come
          // back the moment a row can actually carry them.
          //
          // Delivery is gone outright: it reads orders.delivery_date, which is
          // NULL on all 55 orders — the Swiss List import never carried a
          // delivery date, so the column has never shown anything but a dash on
          // any tab. Restore it here once that data lands.
          ...(tab === 'pending' ? [] : [
            { key: 'sheets_required', label: 'Sheets', align: 'right',
              export: l => fmt.num(l._gang ? l._gang.reduce((s, m) => s + (+m.sheets_required || 0), 0) : (l.sheets_required || 0)),
              sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (+m.sheets_required || 0), 0) : l.sheets_required),
              render: l => {
                const cell = m => m.sheets_required
                  ? (<div><div className="tabular-nums">{fmt.num(m.sheets_required)}</div>{m.parent_sheets_required ? <div className="text-[11px] text-slate-400">{fmt.num(m.parent_sheets_required)} parent</div> : null}</div>)
                  : '—';
                if (!l._gang) return cell(l);
                const parent = l._gang.reduce((s, m) => s + (+m.parent_sheets_required || 0), 0);
                return <GangCellParts members={l._gang} align="right"
                  total={parent ? `${fmt.num(parent)} parent` : '—'}
                  render={cell} />;
              } },
            { key: 'machine_name', label: 'Press', render: l => l.machine_name ? (<div><div className="text-xs font-semibold">{l.machine_name}</div>{l.planned_date && <div className="text-xs text-gray-400">{fmt.date(l.planned_date)}</div>}</div>) : <span className="text-xs text-gray-400">via Print Planning</span> },
          ]),
          { key: 'gates', label: 'Readiness', sortable: false, render: l => l._gang
            ? <GangCellParts members={l._gang} render={m => <ReadinessCell readiness={m.readiness} light={m.light} />} />
            : <ReadinessCell readiness={l.readiness} light={l.light} /> },
          { key: 'status', label: 'Status', render: l => {
            if (!l._gang) return (
              <div className="flex flex-col items-start gap-1">
                <StatusBadge status={l.status} />
                <MgtChip a={approvals[l.id]} />
              </div>
            );
            const sts = [...new Set(l._gang.map(m => m.status))];
            return (
              <div className="flex flex-col items-start gap-1">
                {sts.map(s => <StatusBadge key={s} status={s} />)}
                {sts.length === 1 && <span className="text-[10px] font-semibold text-violet-500">whole gang</span>}
                <MgtChip a={approvals[l._gang[0].id]} />
              </div>
            );
          } },
          { key: 'act', label: '', sortable: false, render: l => l._gang
            ? (() => {
                const allReady = l._gang.every(m => m.status === 'ready');
                // ONE button — the Gang Engine. It plans, edits, adds/removes and
                // sets the shared board, all in the same engine. Job Card appears
                // once every member is ready.
                return (
                  <div className="flex flex-col items-end gap-1" onClick={e => e.stopPropagation()}>
                    {allReady && <Button size="sm" variant="success" className="whitespace-nowrap" onClick={() => createJC(l._gang[0])}>Job Card</Button>}
                    <Button size="sm" variant={allReady ? 'secondary' : 'primary'} className="whitespace-nowrap" onClick={() => openGang(l._gang[0])}>
                      <Link2 size={12} /> Gang Engine
                    </Button>
                  </div>
                );
              })()
            : (
            <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
              {l.status === 'ready'
                ? <Button size="sm" variant="success" className="whitespace-nowrap" onClick={() => createJC(l)}>Job Card</Button>
                : <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => openPlan(l)}><Wrench size={13} /> Plan</Button>}
              {/* Step 5 of the shade-card process: Planning issues an APPROVED
                  card to printing. Hidden once already out (shade_with_printing). */}
              {l.shade_card_id && l.shade_status === 'approved' && !l.shade_with_printing && (
                <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={async () => {
                  const to = window.prompt('Issue the shade card to whom?');
                  if (!to?.trim()) return;
                  try {
                    await api.post(`/shade-cards/${l.shade_card_id}/issue`,
                      { issued_to: to.trim(), department: 'printing', job_card_id: l.job_card_id || undefined });
                    toast.success('Shade card issued to printing');
                    load();
                  } catch (e) { toast.error(e.message); }
                }}><Printer size={13} /> Issue Shade Card</Button>)}
              {/* ONE menu. This cell used to carry two ⋯ buttons — workflow and
                  danger — that were pixel-identical and both said "More
                  actions", so which held Delete was pure guesswork. */}
              <WorkflowControls line={l} context="planning" onDone={load} asMenu includeDanger
                extraItems={[
                  ...(l.status === 'ready'
                    ? [{ key: 'engine', label: 'Open Planning Engine', icon: Wrench, onClick: () => openPlan(l) }]
                    : []),
                  ...mgtMenuItems(l),
                ]} />
            </div>) },
        ]}
        rows={displayRows} empty={{
          pending: 'No lines waiting for planning',
          planned: 'No planned lines',
          completed: 'Nothing pushed to a job card yet',
          all: 'No lines in planning',
        }[tab]}
        exportName="Planning Queue"
        exportSubtitle="Order lines · readiness gates and press assignment"
        exportMeta={() => [`Tab: ${fmt.title(tab)}`]}
        exportSummary={rows => {
          const flat = rows.flatMap(l => (l._gang ? l._gang : [l]));
          return [
            { label: 'Lines', value: flat.length },
            { label: 'Qty', value: fmt.num(flat.reduce((s, l) => s + (+l.qty || 0), 0)) },
            { label: 'Child sheets', value: fmt.num(flat.reduce((s, l) => s + (+l.sheets_required || 0), 0)) },
            { label: 'Parent sheets', value: fmt.num(flat.reduce((s, l) => s + (+l.parent_sheets_required || 0), 0)) },
          ];
        }} />

      {/* ── Planning Engine ── */}
      <Modal wide open={!!planLine} onClose={() => { if (whOpen || consumeLot || masterPrompt || reverseConfirm || prView || dupPr || askMgt) return; dismissEngine(); }}
        title={planLine ? `Planning Engine — ${planLine.product_name}${planLine.gang_number ? ` · ${planLine.gang_number}` : ''}` : ''}
        footer={<>
          {engineFromGang && (
            <Button variant="ghost" className="mr-auto !text-violet-600" onClick={dismissEngine}>
              <Link2 size={14} /> Back to Gang
            </Button>
          )}
          {canPlanRole && ['planned', 'ready'].includes(planLine?.status) && (
            <Button variant="danger" className={engineFromGang ? '' : 'mr-auto'} onClick={() => setReverseConfirm(true)}>
              <Undo2 size={14} /> Reverse Plan
            </Button>
          )}
          {calc && (
            <span className={`self-center text-xs text-slate-500 ${engineFromGang || (canPlanRole && ['planned', 'ready'].includes(planLine?.status)) ? '' : 'mr-auto'}`}>
              {fmt.num(calc.total)} child sheets → <b className="text-slate-800">{fmt.num(calc.parent)} parent</b>
              {position ? position.short > 0
                ? <span className="ml-1.5 font-bold text-red-600">short {fmt.num(position.short)}</span>
                : <span className="ml-1.5 font-bold text-emerald-600">stock OK</span> : null}
            </span>
          )}
          {/* Ask management — optional, form-level. A pending ask shows as the
              chip instead (one open ask per line); never a blocker either way. */}
          {canPlanRole && planLine && (approvals[planLine.id]?.status === 'pending'
            ? <span className="self-center"><MgtChip a={approvals[planLine.id]} /></span>
            : <Button variant="secondary" className="whitespace-nowrap !text-amber-700"
                onClick={() => setAskMgt({ line: planLine, note: '' })}>
                <ShieldQuestion size={14} /> Ask Management
              </Button>)}
          <Button variant="secondary" onClick={dismissEngine}>Cancel</Button>
          <Button onClick={onLock} disabled={!calc || !mixOk}>
            Lock Plan{calc ? ` — ${fmt.num(calc.parent)} parent sheets` : ''}
          </Button>
        </>}>
        {planLine && (
          <div className="space-y-4">
            {/* Order ribbon — customer gets double width so long names never cut.
                Order Qty is editable: the whole cut plan below recomputes live. */}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
              <div className="col-span-3 sm:col-span-2"><Stat small wrap label="Customer" value={planLine.customer_name} /></div>
              <Stat small wrap label="PO" value={planLine.po_number} />
              <div className="rounded-2xl border border-brand-200/70 bg-brand-50/40 px-2.5 py-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-brand-500">
                  Order Qty{planLine.eff_tolerance_pct > 0 ? ` (±${planLine.eff_tolerance_pct}%)` : ''}
                  {form.qty !== '' && +form.qty !== planLine.qty && <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] font-bold text-amber-700">edited</span>}
                </div>
                <input type="number" min="1" value={form.qty}
                  onChange={e => setForm({ ...form, qty: e.target.value })}
                  className="mt-0.5 w-full border-0 bg-transparent p-0 text-sm font-bold tabular-nums text-slate-900 outline-none focus:ring-0" />
              </div>
              <Stat small label="Delivery" value={fmt.date(planLine.delivery_date)} />
              <Stat small wrap label="Die" value={planLine.die_number || '—'} />
              <Stat small label="Status" value={fmt.title(planLine.status)} />
            </div>

            {/* Shade card — live from the Shade Card Management module: expiry
                ticker (crossed its 1-year lifespan) plus the current approval
                state so the planner sees at a glance whether colour is cleared. */}
            {ctx?.shade_card?.expired ? (
              <p className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-bold text-red-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>Critical Alert: The Shade Card for this product ({ctx.shade_card.code}) has exceeded its 1-year
                  lifespan (Age: {fmt.num(ctx.shade_card.age_days)} days) and has reached obsolescence.
                  Renewal / verification required before this job runs colour.</span>
              </p>
            ) : ctx?.shade_card?.status && ctx.shade_card.status !== 'approved' ? (
              <p className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-bold text-amber-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>Shade Card {ctx.shade_card.code} is {fmt.title(ctx.shade_card.status)} — not yet approved.
                  Track it in Shade Card Management before production runs colour.</span>
              </p>
            ) : ctx?.shade_card?.status === 'approved' ? (
              <p className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-700">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
                <span>Shade Card {ctx.shade_card.code} approved
                  {ctx.shade_card.approval_date ? ` on ${fmt.date(ctx.shade_card.approval_date)}` : ''}.</span>
              </p>
            ) : null}

            {/* Gang mode — this job prints as part of a gang. The mother board is
                the shared thing: pick it here and finalise it for the whole gang. */}
            {planLine.gang_run_id && (
              <p className="flex items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50/70 px-3.5 py-2.5 text-xs font-semibold text-violet-700">
                <Link2 size={15} className="mt-0.5 shrink-0" />
                <span>This job prints with gang <b>{planLine.gang_number}</b> as one product. Choose the board below and
                  <b> finalise it for the whole gang</b> from the Gang card — every member shares one mother sheet.
                  (Each product keeps its own child size &amp; ups.)</span>
              </p>
            )}

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,340px)]">
              {/* ── LEFT: the plan the operator edits ── */}
              <div className="min-w-0 space-y-4">
                {/* Product spec — auto-populated from the master. The top row is
                    editable (and pushes back to the master on Lock); the reference
                    strip below mirrors the rest of the master spec, read-only. */}
                <Card icon={BookOpen} title="Product Spec" sub="auto-filled from master, editable">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Field label={<>Colours{'colors' in edited && <Edited />}</>}>
                      <Input type="number" min="1" max="8" value={form.colors} onChange={e => setForm({ ...form, colors: e.target.value })} />
                    </Field>
                    <Field label={<>Coating{'coating' in edited && <Edited />}</>}>
                      <SpecCombo id="spec-coating" value={form.coating} options={specOpts.coating}
                        placeholder="e.g. Aqueous Varnish" onChange={e => setForm({ ...form, coating: e.target.value })} />
                    </Field>
                    <Field label={<>Emboss{'emboss' in edited && <Edited />}</>}>
                      <Select value={form.emboss} onChange={e => setForm({ ...form, emboss: e.target.value })}>
                        <option value="0">No</option>
                        <option value="1">Yes</option>
                      </Select>
                    </Field>
                    <Field label={<>Leafing{'leafing' in edited && <Edited />}</>}>
                      <Select value={form.leafing} onChange={e => setForm({ ...form, leafing: e.target.value, ...(e.target.value === '0' ? { leafing_colour: '' } : {}) })}>
                        <option value="0">No</option>
                        <option value="1">Yes</option>
                      </Select>
                    </Field>
                    {form.leafing === '1' && (
                      <Field label={<>Leafing Colour{'leafing_colour' in edited && <Edited />}</>}>
                        <SpecCombo id="spec-leafing-colour" value={form.leafing_colour} options={specOpts.leafing_colour}
                          placeholder="e.g. gold" onChange={e => setForm({ ...form, leafing_colour: e.target.value })} />
                      </Field>
                    )}
                    <Field label={<>Colour Type{'colour_type' in edited && <Edited />}</>}>
                      <SpecCombo id="spec-colour-type" value={form.colour_type} options={specOpts.colour_type}
                        placeholder="e.g. CMYK" onChange={e => setForm({ ...form, colour_type: e.target.value })} />
                    </Field>
                    <Field label={<>Pasting Type{'pasting_type' in edited && <Edited />}</>}>
                      <SpecCombo id="spec-pasting-type" value={form.pasting_type} options={specOpts.pasting_type}
                        placeholder="e.g. auto / manual" onChange={e => setForm({ ...form, pasting_type: e.target.value })} />
                    </Field>
                    {!planLine.gang_run_id ? (
                      <>
                        <Field label={<>Artwork Code{'party_artwork_code' in edited && <Edited />}</>}
                          hint="auto-pulled from the Carton Product Master">
                          <Input value={form.party_artwork_code} placeholder="Party artwork code"
                            onChange={e => setForm({ ...form, party_artwork_code: e.target.value })} />
                        </Field>
                        <Field label={<>Output Number{'output_number' in edited && <Edited />}</>}
                          hint="print set number — single runs">
                          <Input value={form.output_number} placeholder="e.g. OP-1042"
                            onChange={e => setForm({ ...form, output_number: e.target.value })} />
                        </Field>
                      </>
                    ) : (
                      <div className="col-span-2 rounded-xl bg-violet-50 px-3 py-2 text-[11px] font-semibold text-violet-700 sm:col-span-1">
                        Gang run — artwork code &amp; output number come from the gang's own layout, not the master.
                      </div>
                    )}
                    {/* Shade card — read-only here, for gang members too: the
                        number is now typed in exactly one place, the Shade Card
                        module. planLine (not form) is the source, since it is
                        never edited and is populated the instant the line opens —
                        no flash while ctx's live copy is still loading. */}
                    <Field label="Shade Card">
                      {planLine?.shade_card_number ? (
                        <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                          <a href={`/shade-cards?q=${encodeURIComponent(planLine.shade_card_number)}`}
                             className="font-mono text-xs font-semibold text-brand-600 hover:underline">
                            {planLine.shade_card_number}</a>
                          {planLine.shade_card_date && <ShadeAge date={planLine.shade_card_date} />}
                        </div>
                      ) : (
                        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                          No shade card registered for this product — create one in Shade Cards.
                        </p>)}
                    </Field>
                    {/* Die & block numbers — editable master text; the Tooling
                        Hub record's auto code stays the fallback display. */}
                    <Field label={<>Die Number{'die_number' in edited && <Edited />}</>}
                      hint="auto-pulled from the master · hub DIE code is the fallback">
                      <Input value={form.die_number} placeholder="e.g. D-105"
                        onChange={e => setForm({ ...form, die_number: e.target.value })} />
                    </Field>
                    <Field label={<>Block Number{'block_number' in edited && <Edited />}</>}
                      hint="foil/emboss block · hub BLK code is the fallback">
                      <Input value={form.block_number} placeholder="e.g. B-22"
                        onChange={e => setForm({ ...form, block_number: e.target.value })} />
                    </Field>
                  </div>
                  {/* Master reference — the descriptive spec the planner needs at a
                      glance. Not editable here; maintained in the Product Master. */}
                  {/* Board grade + GSM track the finalised board: while a board
                      override is in play they preview the picked board (amber),
                      and Update Master on Lock writes them back to the master. */}
                  <div className="mt-3 border-t border-slate-100 pt-3">
                    <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      Board identity — grade &amp; GSM follow the finalised board
                      {boardShift && <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-bold text-amber-700">preview · syncs on Update Master</span>}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat small label="Board Grade" value={shownGrade || '—'} accent={boardShift ? 'text-amber-600' : undefined} />
                      <Stat small wrap label="Board Name" value={(boardShift ? boardSel?.name : planLine.master_board_name || planLine.board_name) || '—'} accent={boardShift ? 'text-amber-600' : undefined} />
                      <Stat small label="GSM" value={shownGsm || '—'} accent={boardShift ? 'text-amber-600' : undefined} />
                      <Stat small wrap label="Size (mm)" value={planLine.size || '—'} />
                    </div>
                  </div>
                </Card>

                {/* Cut plan — editable, live math. Child size is master-driven:
                    editing it fires the same update-master question on Lock. */}
                <Card icon={Scissors} title="Cut Plan" sub="parent → child, wastage in child sheets">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label={<>Child L (in){'child_l' in edited && <Edited />}</>}>
                      <Input type="number" min="0" step="0.25" value={form.child_l} onChange={e => setForm({ ...form, child_l: e.target.value })} />
                    </Field>
                    <Field label={<>Child W (in){'child_w' in edited && <Edited />}</>}>
                      <Input type="number" min="0" step="0.25" value={form.child_w} onChange={e => setForm({ ...form, child_w: e.target.value })} />
                    </Field>
                    <Field label={<>Parent L (in){'parent_l' in edited && <Edited />}</>} hint={boardSel ? `board ${boardSel.sheet_l}"` : undefined}>
                      <Input type="number" min="0" step="0.25" value={form.parent_l}
                        placeholder={boardSel ? String(boardSel.sheet_l) : ''}
                        onChange={e => setForm({ ...form, parent_l: e.target.value })} />
                    </Field>
                    <Field label={<>Parent W (in){'parent_w' in edited && <Edited />}</>} hint={boardSel ? `board ${boardSel.sheet_w}"` : undefined}>
                      <Input type="number" min="0" step="0.25" value={form.parent_w}
                        placeholder={boardSel ? String(boardSel.sheet_w) : ''}
                        onChange={e => setForm({ ...form, parent_w: e.target.value })} />
                    </Field>
                    <Field label={<>Ups / print sheet{'ups' in edited && <Edited />}</>}>
                      <Input type="number" min="1" value={form.ups} onChange={e => setForm({ ...form, ups: e.target.value })} />
                    </Field>
                    <Field label="Wastage (sheets)" hint={calc && calc.wastage > 0 ? `≈ ${calc.wastagePctEq}%` : undefined}>
                      <Input type="number" min="0" step="10" value={form.wastage_sheets} onChange={e => setForm({ ...form, wastage_sheets: e.target.value })} />
                    </Field>
                  </div>
                  {calc && (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <Stat label="Base Sheets" value={fmt.num(calc.base)} />
                      <Stat label="+ Wastage" value={fmt.num(calc.wastage)} />
                      <Stat label="Total Sheets" value={fmt.num(calc.total)} accent="text-brand-600" />
                    </div>
                  )}
                  {/* Parent → child conversion band */}
                  {calc && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                      {calc.sized ? (
                        <>
                          <span className="font-semibold text-slate-700">Parent {calc.parentSize}</span>
                          {calc.parentTrimmed && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">trimmed from board {boardSel.sheet_l}×{boardSel.sheet_w}"</span>}
                          <span className="text-slate-300">→</span>
                          <span className="font-semibold text-slate-700">child {calc.childSize}</span>
                          <span className="rounded-full bg-brand-50 px-2 py-0.5 font-bold text-brand-700">{calc.cpp} per parent</span>
                          {calc.waste != null && (
                            <span className={`rounded-full px-2 py-0.5 font-bold ${calc.waste <= 10 ? 'bg-emerald-50 text-emerald-700' : calc.waste <= 20 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                              {calc.waste}% cut waste
                            </span>
                          )}
                          <span className="ml-auto font-extrabold tabular-nums text-brand-600">
                            {fmt.num(calc.parent)} parent sheets to issue
                          </span>
                        </>
                      ) : (
                        <span className="text-amber-600">No sheet sizes on this board/product — add parent & print sheet sizes in Masters for the cut fit. Issuing 1:1.</span>
                      )}
                    </div>
                  )}
                </Card>

                {/* Remarks — press + date moved to Print Planning. The tooling
                    gate clears itself from the tools rack; no manual flag here. */}
                <Card icon={NotebookPen} title="Remarks" sub="press & date are set in Print Planning">
                  <Field label="Remarks">
                    <Input value={form.notes} placeholder="Optional planning note" onChange={e => setForm({ ...form, notes: e.target.value })} />
                  </Field>
                </Card>
              </div>

              {/* ── RIGHT: warehouse intelligence ── */}
              <div className="min-w-0 space-y-4">
                {/* Board position + incoming supply + smart match */}
                <Card icon={PackageSearch} title="Board Position"
                  actions={<>
                    {boardHist.length > 0 && (
                      <Button size="sm" variant="ghost" className="!px-2" onClick={undoBoard}
                        title={`Undo — back to ${boardHist[boardHist.length - 1]?.name}`}>
                        <Undo2 size={12} /> Undo
                      </Button>
                    )}
                    {boardSel && +boardSel.id !== +planLine.master_board_material_id && (
                      <Button size="sm" variant="ghost" className="!px-2" onClick={resetBoard}
                        title="Reset to the product master's board">
                        <RotateCcw size={12} /> Master
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setWhOpen(true)}><Warehouse size={12} /> Warehouse</Button>
                  </>}>
                  <div className="mb-2.5 flex items-start gap-1.5 text-xs">
                    {planLine.board_grade && <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white" title="Board grade">{planLine.board_grade}</span>}
                    <span className="min-w-0 break-words font-semibold text-slate-700">{boardSel?.name}</span>
                    {boardSel && +boardSel.id !== +planLine.board_material_id
                      ? <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-amber-600">override</span>
                      : planLine.board_overridden
                        ? <span className="shrink-0 rounded-full bg-violet-50 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-violet-600">job board</span>
                        : <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-slate-500">master</span>}
                  </div>
                  {!ctx ? <p className="py-4 text-center text-xs text-slate-400">Loading warehouse…</p> : (
                    <>
                      {/* Three columns, deliberately: row one is the warehouse
                          (what exists, what is spoken for, what is left), row two
                          is this job against it. Two columns stranded the fifth
                          tile on a row of its own and broke that reading. */}
                      <div className="grid grid-cols-3 gap-2">
                        <Stat small label="Available" value={fmt.num(position.available)} />
                        <Stat small label="Committed" value={fmt.num(position.committed)} accent={position.committed > 0 ? 'text-amber-600' : 'text-slate-900'} />
                        <Stat small label="Free" value={fmt.num(ctx.stock.free ?? position.available)}
                          accent={(ctx.stock.free ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600'} />
                        <Stat small label="This Plan" value={fmt.num(calc.parent)} />
                        <Stat small label="Net After Plan" value={fmt.num(position.net)}
                          accent={position.net >= 0 ? 'text-emerald-600' : 'text-red-600'} />
                      </div>
                      <p className="mt-1.5 text-[10px] text-slate-400">Parent sheets · held = earmarked for a named job, free = still up for grabs</p>
                      {ctx.stock.held_for_me > 0 && (
                        <p className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                          {fmt.num(ctx.stock.held_for_me)} sheets are held for this job
                        </p>
                      )}

                      {(ctx.incoming.prs.length > 0 || ctx.incoming.pos.length > 0) && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {ctx.incoming.prs.map(p => (
                            <button key={p.pr_number} type="button" onClick={() => openPrTracker(p)}
                              title="Track this requisition without leaving the engine"
                              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:bg-amber-100">
                              <Truck size={10} /> {p.pr_number} · {fmt.num(p.qty)} · {fmt.title(p.status)}
                            </button>
                          ))}
                          {ctx.incoming.pos.map(p => (
                            <span key={p.po_number} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                              <Truck size={10} /> {p.po_number} · {fmt.num(p.pending_qty)} due · {p.vendor_name}
                            </span>
                          ))}
                        </div>
                      )}

                      {position.short > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2.5">
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
                            <AlertTriangle size={13} /> Short {fmt.num(position.short)} parent sheets
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" onClick={() => setBoardPanel(true)}>
                              Take board from another job
                            </Button>
                            <Button size="sm" variant="danger" onClick={onRaisePr} disabled={prBusy}>
                              Raise PR for {fmt.num(position.short)}
                            </Button>
                            {/* A gang shares one board across every member and 409s if a
                                mix is sent for it — don't offer a seed that can only be
                                refused. See BoardMix's own gang guard, same reasoning. */}
                            {!ctx?.gang && (
                              <Button size="sm" variant="primary" onClick={() => {
                                const c = (ctx?.mix?.candidates || [])[0];
                                if (!c) return;
                                // The planned board only earns a row here if it still has
                                // something to contribute. When it is fully out of stock
                                // (plannedSheets === 0 — AVAILABLE 0 is not a rare case),
                                // seeding a zero-sheet row for it anyway used to balance
                                // client-side but fail plan-save's `sheets > 0` check every
                                // time, showing a green mix that a real save always 400s.
                                const plannedSheets = Math.max(0, calc.parent - position.short);
                                setMixRows(rows => rows.length ? rows : [
                                  ...(plannedSheets > 0 ? [{ material_id: ctx.mix.planned_board_id,
                                    board_name: boardSel?.name, ups: ctx.mix.planned_ups,
                                    sheets: plannedSheets,
                                    stock_batch_id: null, reason: '', severity: 'none' }] : []),
                                  { material_id: c.id, board_name: c.name, ups: c.ups,
                                    sheets: position.short, stock_batch_id: null, reason: '',
                                    severity: c.severity, gsm_delta: c.gsm_delta,
                                    ups_differ: c.ups_differ, size_differs: c.size_differs,
                                    available: c.available },
                                ]);
                              }}>
                                Cover with another board
                              </Button>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Smart Match — nearby usable stock, best first */}
                      {position.short > 0 && smartShown.length > 0 && (
                        <div className="mt-2.5">
                          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                            <Sparkles size={12} className="text-brand-500" /> Smart Match
                          </div>
                          <div className="space-y-1.5">
                            {smartVisible.map(m => (
                              <div key={m.material_id} className="rounded-xl bg-slate-50 px-2.5 py-2 text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${CATEGORY_STYLE[m.category]}`}>{CATEGORY_LABEL[m.category]}</span>
                                  <span className="min-w-0 truncate font-semibold text-slate-800" title={m.name}>{m.name}</span>
                                  <Button size="sm" variant="secondary" className="ml-auto !px-2.5 !py-1 !text-[11px]" onClick={() => pickBoard(m)}>Use</Button>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums text-[11px] text-slate-500">
                                  <span>{m.parent_size} · {m.children_per_parent}/parent</span>
                                  <span className={m.cut_waste_pct <= 10 ? 'text-emerald-600' : m.cut_waste_pct <= 20 ? 'text-amber-600' : 'text-red-500'}>{m.utilization}% util</span>
                                  <span className={m.sufficient ? 'font-semibold text-emerald-600' : 'font-semibold text-red-500'}>
                                    {m.sufficient ? `${fmt.num(m.free)} free — covers plan` : `${fmt.num(m.free)} free · short ${fmt.num(m.short)}`}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                          {smartShown.length > 3 && (
                            <button type="button" onClick={() => setSmartAll(a => !a)}
                              className="mt-1.5 text-[11px] font-semibold text-brand-600 hover:underline">
                              {smartAll ? 'Show top 3' : `Show ${smartShown.length - 3} more options`}
                            </button>
                          )}
                        </div>
                      )}

                      {ctx.batches.length > 0 && (
                        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400">
                          FIFO: {ctx.batches.slice(0, 4).map(b => `${b.batch_no} (${fmt.num(b.qty)})`).join(' · ')}{ctx.batches.length > 4 ? ' …' : ''}
                        </p>
                      )}
                      <BoardMix ctx={ctx} required={calc.parent} rows={mixRows} onChange={setMixRows} />
                    </>
                  )}
                </Card>

                {/* Leftover offcut — banked into Leftover RM the moment this cut
                    is locked (as "planned"); cutting-complete trues it up to the
                    actual parents cut and marks it "confirmed". */}
                {ctx?.leftover && (
                  <Card icon={Scissors} title="Leftover"
                    sub="offcut strips this cut plan leaves on the parent sheet">
                    <div className="space-y-1.5">
                      {ctx.leftover.strips.map((s, i) => {
                        const sel = lo.push && lo.strip && Math.abs(lo.strip.l - s.l) < 0.01 && Math.abs(lo.strip.w - s.w) < 0.01;
                        return (
                          <button key={i} type="button" disabled={!s.usable}
                            onClick={() => setLo({ push: true, strip: { l: s.l, w: s.w } })}
                            className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-xs transition
                              ${sel ? 'bg-[#0A84FF]/[0.08] ring-1 ring-[#0A84FF]/30' : 'bg-slate-50 hover:bg-slate-100'}
                              ${s.usable ? '' : 'cursor-not-allowed opacity-40'}`}>
                            <span className="font-semibold text-slate-800">{s.l}×{s.w}"</span>
                            <span className="tabular-nums text-slate-500">
                              {s.usable ? `≈ ${fmt.num(s.est_sheets)} sheets` : 'too small — waste'}
                            </span>
                          </button>
                        );
                      })}
                      <Checkbox label="Bank to Leftover RM on lock"
                        checked={lo.push}
                        onChange={e => setLo(v => {
                          if (!e.target.checked) return { push: false, strip: v.strip };
                          const first = ctx.leftover.strips.find(s => s.usable);
                          return { push: true, strip: v.strip || (first ? { l: first.l, w: first.w } : null) };
                        })} />
                      {lo.push && !lo.strip && <p className="text-[10px] text-amber-600">Pick which strip to keep.</p>}
                    </div>
                  </Card>
                )}

                {/* Gang run — the other jobs sharing this press run */}
                {ctx?.gang && (
                  <Card icon={Link2} title={`Gang ${ctx.gang.gang_number}`} sub="prints together">
                    <div className="space-y-1.5">
                      {ctx.gang.members.map(m => (
                        <div key={m.id} className={`flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-xs ${m.id === planLine.id ? 'bg-violet-50' : 'bg-slate-50'}`}>
                          <span className="min-w-0 truncate font-semibold text-slate-700" title={m.product_name}>
                            {m.product_name}{m.id === planLine.id ? ' (this job)' : ''}
                          </span>
                          <span className="shrink-0 tabular-nums text-slate-500">{fmt.num(m.parent_sheets)} parent</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 font-bold text-violet-700">
                        {fmt.num(ctx.gang.total_parent_sheets)} parent sheets combined
                      </span>
                      {ctx.gang.position?.short > 0
                        ? <span className="rounded-full bg-red-50 px-2 py-0.5 font-bold text-red-600">gang short {fmt.num(ctx.gang.position.short)}</span>
                        : <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700">board covers the gang</span>}
                    </div>

                    {/* Finalise the mother board for the whole gang (unified product). */}
                    {(() => {
                      const boardsDiffer = new Set((ctx.gang.members || []).map(m => m.board_material_id)).size > 1;
                      const changed = boardSel && +boardSel.id !== +planLine.board_material_id;
                      return (
                        <div className="mt-2.5 rounded-xl border border-violet-200 bg-white/70 p-2.5">
                          <div className="mb-1.5 text-[11px] font-bold text-violet-800">
                            Finalise the gang's board
                          </div>
                          <div className="mb-2 text-[10px] leading-relaxed text-slate-500">
                            {boardsDiffer
                              ? <>Members are on <b className="text-amber-600">different boards</b> right now. Pick one mother sheet and apply it to all {ctx.gang.members.length} jobs.</>
                              : <>All {ctx.gang.members.length} jobs share <b>{boardSel?.name || ctx.gang.members[0]?.board_name}</b>. Change it here to re-board the whole gang.</>}
                          </div>
                          <Button size="sm" className="w-full justify-center whitespace-normal !text-[11px]"
                            variant={changed || boardsDiffer ? 'primary' : 'secondary'}
                            disabled={gangBoardBusy || !boardSel}
                            onClick={applyGangBoard}>
                            <Link2 size={12} /> Use {boardSel?.name ? `“${boardSel.name}”` : 'this board'} for all {ctx.gang.members.length} jobs
                          </Button>
                        </div>
                      );
                    })()}

                    <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                      Moves as one job in Print Planning. Locking this job alone onto a <i>different</i> board (without the button above) pulls it out of the gang.
                    </p>
                  </Card>
                )}

                {/* FG warehouse — surfaced only when there is stock to act on */}
                <Card icon={PackageCheck} title="FG Warehouse" sub="matching stock">
                  {!ctx ? <p className="py-2 text-center text-xs text-slate-400">Loading FG…</p> : !fgRelevant ? (
                    <p className="text-[11px] text-slate-400">No FG lots for this product — excess from earlier batches would appear here.</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <Stat small label="FG Available (verified)" value={fmt.num(ctx.fg.verified_available)}
                          accent={ctx.fg.verified_available > 0 ? 'text-emerald-600' : 'text-slate-900'} />
                        <Stat small label="Balance to Produce" value={fmt.num(ctx.fg.balance_to_produce)} accent="text-brand-600" />
                      </div>

                      {ctx.fg.verified_available > 0 && ctx.fg.balance_to_produce > 0 && (
                        <p className="mt-2 rounded-xl bg-emerald-50 px-2.5 py-2 text-[11px] font-semibold text-emerald-800">
                          {fmt.num(ctx.fg.verified_available)} pcs verified FG can reduce this production plan — consume below.
                        </p>
                      )}
                      {ctx.fg.pending_verification > 0 && (
                        <p className="mt-2 rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] font-semibold text-amber-700">
                          {fmt.num(ctx.fg.pending_verification)} pcs awaiting physical verification.
                        </p>
                      )}

                      {ctx.fg.lots.length > 0 && (
                        <div className="mt-2 space-y-1.5">
                          {ctx.fg.lots.map(lot => (
                            <div key={lot.id} className="rounded-xl bg-slate-50 px-2.5 py-2 text-xs">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-bold text-slate-800">{lot.lot_number}</span>
                                <span className="tabular-nums text-slate-500">{fmt.num(lot.remaining)} pcs</span>
                                <StatusBadge status={lot.status} />
                              </div>
                              {(lot.box_count || lot.source_batch) && (
                                <div className="mt-0.5 text-[10px] text-slate-400">
                                  {lot.box_count ? `${lot.box_count} boxes` : ''}{lot.box_count && lot.source_batch ? ' · ' : ''}{lot.source_batch ? `batch ${lot.source_batch}` : ''}
                                </div>
                              )}
                              <div className="mt-1.5 flex gap-1.5">
                                {lot.status === 'pending_verification' && (
                                  <>
                                    <Button size="sm" variant="secondary" onClick={() => verifyLot(lot, true)}>
                                      <ShieldCheck size={12} /> Verify
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => verifyLot(lot, false)}>Reject</Button>
                                  </>
                                )}
                                {lot.status === 'verified' && ctx.fg.balance_to_produce > 0 && (
                                  <Button size="sm" variant="success"
                                    onClick={() => setConsumeLot({ lot, qty: String(Math.min(lot.remaining, ctx.fg.balance_to_produce)) })}>
                                    Consume
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {ctx.fg.consumptions.length > 0 && (
                        <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                          Consumed: {ctx.fg.consumptions.map(c => `${fmt.num(c.qty)} from ${c.lot_number}${c.user_name ? ` (${c.user_name})` : ''}`).join(' · ')}
                        </p>
                      )}
                    </>
                  )}
                </Card>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Paper warehouse picker ── */}
      <WarehousePicker open={whOpen} onClose={() => setWhOpen(false)}
        childL={calc?.childL ?? planLine?.child_l} childW={calc?.childW ?? planLine?.child_w}
        currentBoardId={boardSel?.id}
        parentNeededFor={cpp => calc ? Math.ceil(calc.total / Math.max(1, cpp)) : null}
        onSelect={pickBoard} />

      {/* ── Consume FG confirmation ── */}
      <Modal open={!!consumeLot} onClose={() => setConsumeLot(null)} title="Consume FG stock against this order"
        footer={<>
          <Button variant="secondary" onClick={() => setConsumeLot(null)}>Cancel</Button>
          <Button variant="success" onClick={doConsumeFg}
            disabled={!(+consumeLot?.qty > 0) || +consumeLot?.qty > (consumeLot?.lot.remaining ?? 0)}>
            Consume {consumeLot ? fmt.num(+consumeLot.qty || 0) : ''} pcs
          </Button>
        </>}>
        {consumeLot && ctx && (
          <div className="space-y-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Matching FG stock available: <b>{fmt.num(consumeLot.lot.remaining)} pcs</b> in{' '}
              <b>{consumeLot.lot.lot_number}</b> (physically verified{consumeLot.lot.verified_by ? ` by ${consumeLot.lot.verified_by}` : ''}).
              Do you want to consume this stock against <b>{planLine?.product_name}</b>?
            </p>
            <Field label="Quantity to consume" required hint={`Balance to produce: ${fmt.num(ctx.fg.balance_to_produce)} pcs`}>
              <Input type="number" min="1" max={Math.min(consumeLot.lot.remaining, ctx.fg.balance_to_produce)}
                value={consumeLot.qty} onChange={e => setConsumeLot({ ...consumeLot, qty: e.target.value })} autoFocus />
            </Field>
            {+consumeLot.qty > 0 && (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Ordered" value={fmt.num(planLine.qty)} />
                <Stat label="FG Consumed (after)" value={fmt.num((planLine.fg_consumed_qty || 0) + +consumeLot.qty)} accent="text-violet-600" />
                <Stat label="Production Balance" value={fmt.num(Math.max(0, planLine.qty - (planLine.fg_consumed_qty || 0) - +consumeLot.qty))} accent="text-brand-600" />
              </div>
            )}
            <p className="text-[11px] text-slate-400">Fully audited: who verified, who consumed, and when. Warehouse stock reflects the consumption immediately.</p>
          </div>
        )}
      </Modal>

      {/* ── Use FG Stock (from the Planning Queue) ── */}
      {(() => {
        const lot = fgUse?.lots.find(l => l.id === fgUse.lotId);
        const bal = fgUse?.line.balance_to_produce ?? 0;
        const maxConsume = lot ? Math.min(lot.remaining, bal) : 0;
        const qtyNum = +fgUse?.qty || 0;
        const valid = qtyNum > 0 && qtyNum <= maxConsume;
        const matchLabel = { internal_carton_code: 'Internal Carton Code', party_artwork_code: 'Party Artwork Code', product_code: 'Product Code' };
        const MOVE_LABEL = { opening_stock: 'Opening Stock', production_receipt: 'Production Receipt', stock_consumption: 'Stock Consumption', excess_stock: 'Excess Stock', manual_adjustment: 'Manual Adjustment' };
        return (
          <Modal wide open={!!fgUse} onClose={() => setFgUse(null)} title="Use FG Stock"
            footer={<>
              <Button variant="secondary" onClick={() => setFgUse(null)}>Cancel</Button>
              <Button variant="success" onClick={doFgUse} disabled={!valid}>
                Consume {fmt.num(qtyNum)} pcs{lot ? ` from ${lot.lot_number}` : ''}
              </Button>
            </>}>
            {fgUse && lot && (
              <div className="space-y-4">
                {/* Order + product identity (display / secondary verification) */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat small wrap label="Sales Order No." value={fgUse.line.po_number} />
                  <Stat small wrap label="Customer" value={fgUse.line.customer_name} />
                  <Stat small wrap label="Product" value={fgUse.line.product_name} />
                  <Stat small wrap label="Internal Carton Code" value={fgUse.line.internal_carton_code || '—'} accent={fgUse.line.internal_carton_code ? 'text-slate-900' : 'text-slate-400'} />
                  <Stat small wrap label="Party Artwork Code" value={fgUse.line.party_artwork_code || '—'} accent={fgUse.line.party_artwork_code ? 'text-slate-900' : 'text-slate-400'} />
                  <Stat small wrap label="Product Code" value={fgUse.line.product_code} />
                  <Stat small label="Order Quantity" value={fmt.num(fgUse.line.qty)} />
                  <Stat small label="Already FG-Consumed" value={fmt.num(fgUse.line.fg_consumed_qty)} accent={fgUse.line.fg_consumed_qty > 0 ? 'text-violet-600' : 'text-slate-900'} />
                  <Stat small label="FG Stock Available" value={fmt.num(fgUse.fg_available)} accent="text-emerald-600" />
                </div>
                {(fgUse.line.gsm || fgUse.line.size || fgUse.line.coating || fgUse.line.board_name) && (
                  <p className="text-[11px] text-slate-400">
                    {[fgUse.line.board_name, fgUse.line.gsm ? `${fgUse.line.gsm} GSM` : null, fgUse.line.size,
                      fgUse.line.coating && fgUse.line.coating !== 'none' ? fmt.title(fgUse.line.coating) : null]
                      .filter(Boolean).join(' · ')} — specs shown for verification only; matching uses the codes above.
                  </p>
                )}

                {/* Stock reference picker — one row per matching FG lot */}
                <div>
                  <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    FG Stock Reference{fgUse.lots.length > 1 ? ` — ${fgUse.lots.length} matches` : ''}
                  </div>
                  <div className="space-y-1.5">
                    {fgUse.lots.map(l => (
                      <button key={l.id} type="button"
                        onClick={() => setFgUse(f => ({ ...f, lotId: l.id, qty: String(Math.min(l.remaining, bal)) }))}
                        className={`flex w-full flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs transition
                          ${l.id === fgUse.lotId ? 'bg-[#0A84FF]/[0.08] ring-1 ring-[#0A84FF]/30' : 'bg-slate-50 hover:bg-slate-100'}`}>
                        <span className="font-bold text-slate-800">{l.lot_number}</span>
                        {l.box_number && <span className="rounded bg-slate-200/70 px-1.5 py-px font-mono text-[10px] font-semibold text-slate-600">{l.box_number}</span>}
                        {l.kind === 'leftover' && <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-amber-700">leftover</span>}
                        <span className="tabular-nums text-slate-500">{fmt.num(l.remaining)} pcs available</span>
                        {l.source_batch && <span className="text-[10px] text-slate-400">batch {l.source_batch}</span>}
                        <span className="ml-auto rounded-full bg-slate-100 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-slate-500">
                          matched · {matchLabel[l.matched_by]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Consume + remarks */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Quantity to Consume" required
                    hint={`Max ${fmt.num(maxConsume)} — capped by ${lot.remaining <= bal ? 'stock' : 'order balance'}`}>
                    <Input type="number" min="1" max={maxConsume} value={fgUse.qty}
                      onChange={e => setFgUse({ ...fgUse, qty: e.target.value })} autoFocus />
                  </Field>
                  <Field label="Remarks">
                    <Input value={fgUse.remarks} placeholder="Optional note recorded in the ledger"
                      onChange={e => setFgUse({ ...fgUse, remarks: e.target.value })} />
                  </Field>
                </div>
                {qtyNum > maxConsume && (
                  <p className="text-[11px] font-semibold text-red-600">
                    Cannot consume {fmt.num(qtyNum)} — only {fmt.num(maxConsume)} can be used against this order.
                  </p>
                )}

                {/* Live result */}
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="FG Ref After" value={fmt.num(Math.max(0, lot.remaining - qtyNum))} accent="text-emerald-600" />
                  <Stat label="FG Consumed (after)" value={fmt.num(fgUse.line.fg_consumed_qty + qtyNum)} accent="text-violet-600" />
                  <Stat label="Remaining for Production" value={fmt.num(Math.max(0, bal - qtyNum))} accent="text-brand-600" />
                </div>
                {qtyNum >= bal && qtyNum > 0 && (
                  <p className="rounded-xl bg-emerald-50 px-3 py-2 text-[11px] font-semibold text-emerald-800">
                    This covers the full order balance — no production will be required for this line.
                  </p>
                )}

                {/* Movement trail for the selected reference */}
                {fgUse.ledger.filter(m => m.ref_number === lot.lot_number).length > 0 && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Movement history — {lot.lot_number}</div>
                    <div className="overflow-hidden rounded-xl border border-slate-200">
                      <table className="w-full text-[11px]">
                        <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase text-slate-400">
                          <th className="px-2.5 py-1.5">Type</th><th className="px-2.5 py-1.5">Source</th>
                          <th className="px-2.5 py-1.5 text-right">In</th><th className="px-2.5 py-1.5 text-right">Out</th>
                          <th className="px-2.5 py-1.5 text-right">Balance</th><th className="px-2.5 py-1.5">When / By</th>
                        </tr></thead>
                        <tbody>
                          {fgUse.ledger.filter(m => m.ref_number === lot.lot_number).slice().reverse().map(m => (
                            <tr key={m.id} className="border-b border-slate-50 last:border-0">
                              <td className="px-2.5 py-1.5 font-semibold text-slate-700">{MOVE_LABEL[m.movement_type]}{m.parent_ref ? <span className="ml-1 text-[9px] text-violet-500">← {m.parent_ref}</span> : null}</td>
                              <td className="px-2.5 py-1.5 capitalize text-slate-500">{m.source_module}</td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums text-emerald-600">{m.qty_in ? fmt.num(m.qty_in) : ''}</td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums text-red-500">{m.qty_out ? fmt.num(m.qty_out) : ''}</td>
                              <td className="px-2.5 py-1.5 text-right font-bold tabular-nums">{fmt.num(m.balance)}</td>
                              <td className="px-2.5 py-1.5 text-slate-400">{fmt.date(m.created_at)}{m.created_by ? ` · ${m.created_by}` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-slate-400">
                  Consuming reserves this stock against the order: the reference balance drops now, production only makes the remainder, and every move is recorded in the FG Warehouse ledger.
                </p>
              </div>
            )}
          </Modal>
        );
      })()}

      {/* ── Create gang run ── */}
      <Modal open={!!gangSel} onClose={() => setGangSel(null)} title="Gang these jobs on one press run"
        footer={<>
          <Button variant="secondary" onClick={() => setGangSel(null)}>Cancel</Button>
          <Button onClick={createGang} disabled={gangBusy || !gangCheck?.ok || (gangSel?.length ?? 0) < 2}>
            <Link2 size={14} /> Gang {gangSel?.length} Jobs
          </Button>
        </>}>
        {gangSel && (
          <div className="space-y-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Ganged jobs <b>print together</b>: they share the board, run back-to-back on the same press,
              and buy their board shortage on <b>one</b> purchase requisition.
            </p>
            <div className="space-y-1.5">
              {gangSel.map(l => (
                <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl bg-white px-3 py-2 text-xs shadow-sm ring-1 ring-slate-100">
                  <span className="font-bold text-slate-800">{l.product_name}</span>
                  <span className="text-slate-400">{l.po_number} · {l.customer_name}</span>
                  <span className="ml-auto tabular-nums text-slate-500">{fmt.num(l.qty)} pcs · {fmt.date(l.delivery_date)}</span>
                  {gangSel.length > 2 && (
                    <button type="button" title="Leave out of this gang" className="text-slate-300 hover:text-red-500"
                      onClick={() => setGangSel(g => g.filter(x => x.id !== l.id))}><X size={13} /></button>
                  )}
                </div>
              ))}
            </div>
            {gangCheck && (
              <div className="space-y-1.5 text-xs">
                {gangCheck.ok && gangCheck.warnings.length === 0 ? (
                  <p className="flex items-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 font-semibold text-emerald-700">
                    <CheckCircle2 size={14} /> Same board ({gangSel[0].board_name}) and coating ({fmt.title(gangSel[0].coating)}) — good to gang.
                  </p>
                ) : gangCheck.conflicts.map(c => (
                  <p key={c.field} className="flex items-center gap-1.5 rounded-xl bg-red-50 px-3 py-2 font-semibold text-red-700">
                    <AlertTriangle size={14} /> {c.field} differs: {c.values.join(' vs ')} — these can't print together.
                  </p>
                ))}
                {gangCheck.warnings.map(w => (
                  <p key={w.field} className="flex items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 font-semibold text-amber-700">
                    <AlertTriangle size={14} /> {w.field} differs ({w.values.join(', ')}) — allowed, just check before running.
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ══ Gang Engine — ONE engine for the whole gang (plan · products×ups ·
             add/remove · common board · lock), styled like the single engine ══ */}
      <Modal wide open={!!gangView} onClose={() => setGangView(null)}
        title={gangView ? `Gang Engine — ${gangView.gang_number} · ${gangView.members.length} products on one sheet` : ''}
        footer={<>
          <Button variant="ghost" className="!text-red-500" onClick={gangDissolve}>Dissolve</Button>
          {gangView?.members?.some(m => ['planned', 'ready'].includes(m.status)) && (
            <Button variant="danger" onClick={() => setGangReverseOpen(true)}>
              <Undo2 size={14} /> Reverse Plan
            </Button>
          )}
          {gangView && (() => {
            const effIssue = gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets);
            const overridden = gangIssue !== '' && +gangIssue !== gangCalc?.parent;
            const short = Math.max(0, effIssue + (gangView.position?.committed_other ?? 0) - (gangView.position?.available ?? 0));
            return (
              <span className="mr-auto self-center pl-1 text-xs text-slate-500">
                <b className="text-slate-800">{fmt.num(effIssue)} parent</b> to issue
                {overridden && <span className="ml-1 text-amber-600">(manual)</span>}
                {short > 0
                  ? <span className="ml-1.5 font-bold text-red-600">short {fmt.num(short)}</span>
                  : <span className="ml-1.5 font-bold text-emerald-600">stock OK</span>}
              </span>
            );
          })()}
          <Button variant="secondary" onClick={() => setGangView(null)}>Cancel</Button>
          <Button onClick={lockGangPlan} disabled={gangBusyLock || !gangView}>
            <Link2 size={13} /> Lock Gang Plan{gangView ? ` — ${fmt.num(gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets))} sheets` : ''}
          </Button>
        </>}>
        {gangView && (() => {
          const anchor = gangView.members[0];
          const boardsDiffer = new Set(gangView.members.map(m => m.board_material_id)).size > 1;
          const totalQty = gangView.members.reduce((s, m) => s + (+m.qty || 0), 0);
          return (
          <div className="space-y-4">
            {/* Gang ribbon */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat small label="Gang" value={gangView.gang_number} />
              <Stat small label="Products" value={gangView.members.length} />
              <Stat small label="Combined Qty" value={fmt.num(totalQty)} />
              <Stat small wrap label="Shared Board" value={boardsDiffer ? 'mixed — set one' : `${anchor?.board_grade ? anchor.board_grade + ' · ' : ''}${anchor?.board_name || '—'}`}
                accent={boardsDiffer ? 'text-amber-600' : undefined} />
            </div>

            {/* Journey — together until die punching, then split into cartons */}
            <p className="flex items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50/70 px-3.5 py-2.5 text-[11px] font-semibold text-violet-700">
              <Link2 size={14} className="mt-0.5 shrink-0" />
              <span>One sheet · one press run: all {gangView.members.length} products cut, print and travel <b>together up to die punching</b>,
                then split into individual cartons — each carton runs its own journey (sorting → pasting → QC) in its own cell.</span>
            </p>

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
              {/* ── LEFT: products (qty × ups), add/remove, common sheet, wastage ── */}
              <div className="min-w-0 space-y-4">
                <Card icon={Layers} title="Products in this gang" sub="each keeps its own qty & ups on the shared sheet">
                  <div className="overflow-hidden rounded-xl border border-violet-200/70">
                    <div className="grid grid-cols-[minmax(0,1fr)_64px_52px_66px_auto] items-center gap-x-2 bg-violet-100/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-violet-600">
                      <span>Product</span><span className="text-right">Qty</span><span className="text-right">Ups</span><span className="text-right">Sheets</span><span />
                    </div>
                    {gangView.members.map((m, i) => {
                      const editable = ['pending', 'planned', 'ready'].includes(m.status);
                      const d = gangEdits[m.id] || { qty: String(m.qty ?? ''), ups: String(m.ups ?? '') };
                      const dirty = gangMemberDirty(m);
                      const expanded = gangExpand === m.id;
                      return (
                        <div key={m.id} className={i ? 'border-t border-violet-200/60' : ''}>
                          <div className={`grid grid-cols-[minmax(0,1fr)_64px_52px_66px_auto] items-center gap-x-2 px-3 py-2 ${expanded ? 'bg-violet-100/50' : 'bg-violet-50/40'}`}>
                            <div className="min-w-0">
                              <button type="button" onClick={() => openSpec(m)} title="Open this product's full spec — child size, colours, coating, finish"
                                className="group flex min-w-0 items-center gap-1 text-left">
                                {expanded ? <ChevronDown size={12} className="shrink-0 text-violet-500" /> : <ChevronRight size={12} className="shrink-0 text-violet-400" />}
                                <span className="truncate text-xs font-bold text-slate-800 group-hover:text-violet-700">{m.product_name}</span>
                                {m.jc_number && <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-px text-[9px] font-bold text-brand-700">{m.jc_number}</span>}
                              </button>
                              <div className="flex items-center gap-1.5 pl-4 text-[10px] text-slate-400">
                                <span className="truncate">{m.child_l ? `${m.child_l}×${m.child_w}" child · ` : ''}{m.colors}c · {fmt.title(m.coating)}</span>
                                <StatusBadge status={m.status} />
                              </div>
                              {/* Board identity — read-only. The board's grade,
                                  GSM & parent size at a glance, so the planner can
                                  judge each board before locking the shared sheet. */}
                              <div className="flex items-center gap-1 pl-4 pt-0.5 text-[10px]">
                                {m.board_grade && <span className="shrink-0 rounded bg-slate-700 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-white" title="Board grade">{m.board_grade}</span>}
                                <span className="min-w-0 truncate font-medium text-slate-500" title={m.master_board_name || ''}>
                                  {m.master_board_name
                                    ? `${m.master_board_name}${(m.master_gsm || m.gsm) && !/gsm/i.test(m.master_board_name) ? ` · ${m.master_gsm || m.gsm} GSM` : ''}`
                                    : (m.master_gsm || m.gsm ? `${m.master_gsm || m.gsm} GSM` : 'Board not set')}
                                </span>
                              </div>
                            </div>
                            <input type="number" min="1" disabled={!editable} value={d.qty}
                              onChange={e => gangMemberDraft(m.id, { qty: e.target.value })}
                              className="h-7 w-full rounded-lg border border-slate-200 bg-white px-1.5 text-right text-xs font-semibold tabular-nums text-slate-800 outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-300 disabled:bg-slate-100 disabled:text-slate-400" />
                            <input type="number" min="1" disabled={!editable} value={d.ups}
                              onChange={e => gangMemberDraft(m.id, { ups: e.target.value })}
                              className="h-7 w-full rounded-lg border border-slate-200 bg-white px-1.5 text-right text-xs font-semibold tabular-nums text-slate-800 outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-300 disabled:bg-slate-100 disabled:text-slate-400" />
                            <span className="text-right text-xs font-bold tabular-nums text-slate-700">{fmt.num(gangCalc?.per?.find(p => p.id === m.id)?.parent ?? m.parent_sheets)}</span>
                            <div className="flex items-center gap-0.5 pl-1">
                              {dirty
                                ? <button type="button" title="Save qty / ups" className="rounded-lg bg-brand-500 p-1 text-white hover:bg-brand-600" onClick={() => saveGangMember(m)}><Check size={13} /></button>
                                : <span className="w-[25px]" />}
                              <button type="button" title="Remove from gang" className="rounded-lg p-1 text-slate-300 hover:bg-red-50 hover:text-red-500" onClick={() => gangRemoveLine(m.id)}><X size={13} /></button>
                            </div>
                          </div>
                          {/* Per-product master card. Parent · child · coating are
                              LOCKED at the gang level (shared sheet) — here we show
                              each product's own master (board grade, GSM, size,
                              pasting, embossing, effects — applied after the split)
                              and edit only its identity (artwork / set no / shade). */}
                          {expanded && gangSpecForm && (
                            <div className="border-t border-violet-200/60 bg-white px-3 py-3 space-y-3">
                              <div>
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                                  From master · {m.product_code}{m.internal_carton_code ? ` · ${m.internal_carton_code}` : ''}
                                  <span className="ml-1 font-medium normal-case text-slate-300">— pasting, embossing &amp; effects run per carton after the split</span>
                                </div>
                                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                                  <Stat small label="Board Grade" value={m.board_grade || '—'} />
                                  <Stat small wrap label="Board Name" value={m.master_board_name || '—'} />
                                  <Stat small label="GSM" value={m.master_gsm || m.gsm || '—'} />
                                  <Stat small wrap label="Carton Size" value={m.carton_size || '—'} />
                                  <Stat small label="Colours" value={m.colors ? `${m.colors}c` : '—'} />
                                  <Stat small label="Colour Type" value={m.colour_type ? fmt.title(m.colour_type) : '—'} />
                                  <Stat small wrap label="Pasting" value={m.pasting_type ? fmt.title(m.pasting_type) : '—'} />
                                  <Stat small label="Embossing" value={m.emboss ? 'Yes' : 'No'} accent={m.emboss ? 'text-amber-600' : undefined} />
                                  <Stat small label="Leafing" value={m.leafing ? (m.leafing_colour ? fmt.title(m.leafing_colour) : 'Yes') : 'No'} accent={m.leafing ? 'text-amber-600' : undefined} />
                                  <Stat small label="Special" value={m.special && m.special !== 'none' ? fmt.title(m.special) : '—'} />
                                  <Stat small label="Die" value={m.die_number || '—'} />
                                </div>
                              </div>

                              {/* Identity — the only per-product editable set on the gang layout */}
                              <div>
                                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-violet-500"><Palette size={11} /> Layout identity — editable</div>
                                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                                  <Field label="Artwork Code"><Input value={gangSpecForm.party_artwork_code} placeholder="party artwork code" onChange={e => setGangSpecForm(f => ({ ...f, party_artwork_code: e.target.value }))} /></Field>
                                  <Field label="Output / Set No."><Input value={gangSpecForm.output_number} placeholder="e.g. OP-1042" onChange={e => setGangSpecForm(f => ({ ...f, output_number: e.target.value }))} /></Field>
                                  <Field label="Die Number"><Input value={gangSpecForm.die_number} placeholder="e.g. D-105" onChange={e => setGangSpecForm(f => ({ ...f, die_number: e.target.value }))} /></Field>
                                  <Field label="Block Number"><Input value={gangSpecForm.block_number} placeholder="e.g. B-22" onChange={e => setGangSpecForm(f => ({ ...f, block_number: e.target.value }))} /></Field>
                                  {/* Read-only, like the single-job drawer — typed in exactly one place: the Shade Card module. */}
                                  <Field label="Shade Card">
                                    {m.shade_card_number ? (
                                      <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-2.5 py-2">
                                        <a href={`/shade-cards?q=${encodeURIComponent(m.shade_card_number)}`}
                                           className="font-mono text-xs font-semibold text-brand-600 hover:underline">
                                          {m.shade_card_number}</a>
                                        {m.shade_card_date && <ShadeAge date={m.shade_card_date} />}
                                      </div>
                                    ) : (
                                      <p className="rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] font-semibold text-amber-700">
                                        No shade card — create one in Shade Cards.
                                      </p>)}
                                  </Field>
                                </div>
                              </div>

                              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                                <button type="button" onClick={() => openGangEngine(m)} className="inline-flex items-center gap-1 text-[10px] font-bold text-violet-600 hover:underline">
                                  <Wrench size={11} /> Full engine for this product
                                </button>
                                <div className="flex gap-2">
                                  <Button size="sm" variant="secondary" onClick={() => setGangExpand(null)}>Cancel</Button>
                                  <Button size="sm" onClick={() => saveSpec(m)}>Save identity</Button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    <div className="flex items-center justify-between border-t-2 border-violet-300 bg-violet-100/60 px-3 py-1.5 text-[11px] font-bold text-violet-800">
                      <span>{gangView.members.length} products · {fmt.num(totalQty)} pcs</span>
                      <span className="tabular-nums">{fmt.num(gangCalc?.parent ?? gangView.total_parent_sheets)} parent sheets</span>
                    </div>
                  </div>

                  {/* Add product */}
                  {gangAddable ? (
                    <div className="mt-2.5 rounded-xl border border-dashed border-violet-300 bg-violet-50/30 p-2.5">
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-[11px] font-bold text-violet-700">Add products to {gangView.gang_number}</span>
                        <button type="button" className="text-slate-300 hover:text-slate-500" onClick={() => setGangAddable(null)}><X size={13} /></button>
                      </div>
                      {gangAddable.length === 0 ? (
                        <p className="py-3 text-center text-[11px] text-slate-400">No other jobs are free to gang right now.</p>
                      ) : (
                        <div className="max-h-52 space-y-1 overflow-y-auto">
                          {gangAddable.map(l => (
                            <label key={l.id} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${gangAddSel.includes(l.id) ? 'bg-violet-100' : 'bg-white hover:bg-violet-50'}`}>
                              <input type="checkbox" className="h-3.5 w-3.5 accent-[#7C3AED]" checked={gangAddSel.includes(l.id)} onChange={() => toggleAddSel(l.id)} />
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold text-slate-800">{l.product_name}</div>
                                <div className="truncate text-[10px] text-slate-400">{l.po_number} · {l.customer_name} · {fmt.num(l.qty)} pcs</div>
                              </div>
                              {l.compatible
                                ? <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-px text-[9px] font-bold text-emerald-700">same board</span>
                                : <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[9px] font-bold text-amber-600" title={`${l.board_name} · ${fmt.title(l.coating)}`}>differs</span>}
                            </label>
                          ))}
                        </div>
                      )}
                      {gangAddSel.length > 0 && (
                        <Button size="sm" className="mt-2 w-full justify-center" onClick={confirmAddJobs}>
                          <Plus size={12} /> Add {gangAddSel.length} to gang
                        </Button>
                      )}
                    </div>
                  ) : (
                    <button type="button" onClick={openAddJobs}
                      className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-violet-300 py-2 text-[11px] font-bold text-violet-600 transition-colors hover:bg-violet-50">
                      <Plus size={13} /> Add another product to this gang
                    </button>
                  )}
                </Card>

                {/* ══ Gang Sheet — the ONE shared sheet: parent · child · coating.
                       Locked here, this is the single source of truth for the run. ══ */}
                <Card icon={Scissors} title="Gang Sheet — parent · child · coating" sub="single source of truth · locked for the whole gang">
                  {/* Parent (board) */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-violet-500">Parent (board)</div>
                      <div className="flex items-center gap-1.5">
                        {!boardsDiffer && anchor?.board_grade && <span className="shrink-0 rounded-full bg-slate-800 px-1.5 py-px text-[9px] font-bold uppercase tracking-wide text-white">{anchor.board_grade}</span>}
                        <span className="truncate text-sm font-bold text-slate-800">{boardsDiffer ? 'Members on different boards' : (anchor?.board_name || '—')}</span>
                      </div>
                      <div className="text-[11px] text-slate-400">{anchor?.sheet_l ? `${anchor.sheet_l}×${anchor.sheet_w}" parent sheet` : 'no size'}{boardsDiffer ? ' · pick one to unify' : ''}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant={boardsDiffer ? 'primary' : 'secondary'} onClick={runGangSmart}><Sparkles size={13} /> Smart Match</Button>
                      <Button size="sm" variant="secondary" onClick={() => setGangWhOpen(true)}><Warehouse size={13} /> Manual</Button>
                    </div>
                  </div>
                  {boardsDiffer && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[10px] font-semibold text-amber-600">
                      Gang prints on ONE sheet — choose a single board and it applies to all {gangView.members.length} products.
                    </p>
                  )}

                  {/* Child + coating — shared, with the live fit on the parent */}
                  {(() => {
                    const fit = clientFit(anchor?.sheet_l, anchor?.sheet_w, +gangSheetForm.child_l, +gangSheetForm.child_w);
                    const dirty = anchor && ((gangSheetForm.child_l !== '' && +gangSheetForm.child_l !== +anchor.child_l)
                      || (gangSheetForm.child_w !== '' && +gangSheetForm.child_w !== +anchor.child_w)
                      || (gangSheetForm.coating || '') !== (anchor.coating || '')
                      || (anchor.board_name && anchor.master_board_name && anchor.board_name !== anchor.master_board_name)); // board changed vs master
                    return (
                      <div className="mt-3 border-t border-slate-100 pt-3">
                        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-violet-500">Child (press sheet) &amp; coating — shared</div>
                        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                          <Field label="Child L (in)"><Input type="number" min="0" step="0.25" value={gangSheetForm.child_l} onChange={e => setGangSheetForm(f => ({ ...f, child_l: e.target.value }))} /></Field>
                          <Field label="Child W (in)"><Input type="number" min="0" step="0.25" value={gangSheetForm.child_w} onChange={e => setGangSheetForm(f => ({ ...f, child_w: e.target.value }))} /></Field>
                          <Field label="Coating"><SpecCombo id="gang-sheet-coat" value={gangSheetForm.coating} options={specOpts.coating} placeholder="e.g. Aqueous Varnish" onChange={e => setGangSheetForm(f => ({ ...f, coating: e.target.value }))} /></Field>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] text-slate-500">
                            {fit && fit.cpp > 0
                              ? <>Child on parent: <b className="text-slate-800">{fit.cpp}/parent</b> · <span className={fit.waste <= 10 ? 'text-emerald-600' : fit.waste <= 20 ? 'text-amber-600' : 'text-red-600'}>{fit.util}% util</span></>
                              : <span className="font-semibold text-red-500">child doesn’t fit the board — adjust</span>}
                          </span>
                          <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} onClick={lockGangSheet}>
                            <ShieldCheck size={13} /> Lock sheet →
                          </Button>
                        </div>
                        <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
                          Parent, child &amp; coating are the gang's single source of truth. Pasting, embossing &amp; other effects stay per product from each master — they run per carton after the split at die punching.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Smart Match suggestions — ranked boards for the whole gang */}
                  {gangSmart && (
                    <div className="mt-2.5 rounded-xl border border-violet-200 bg-violet-50/40 p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-violet-600"><Sparkles size={11} /> Best boards for this gang</span>
                        <button type="button" className="text-slate-300 hover:text-slate-500" onClick={() => setGangSmart(null)}><X size={12} /></button>
                      </div>
                      {gangSmart.length === 0 ? (
                        <p className="py-2 text-center text-[11px] text-slate-400">No matching board in stock — try Manual.</p>
                      ) : (
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {gangSmart.map(mm => (
                            <button key={mm.material_id} type="button" onClick={() => pickSmartBoard(mm)}
                              className="flex w-full items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-left text-xs ring-1 ring-slate-100 hover:bg-violet-50">
                              <div className="min-w-0">
                                <div className="truncate font-semibold text-slate-800">{mm.name}</div>
                                <div className="truncate text-[10px] text-slate-400">
                                  {mm.sheet_l}×{mm.sheet_w}"{mm.children_per_parent ? ` · ${mm.children_per_parent}/parent` : ''}{mm.utilization != null ? ` · ${mm.utilization}% util` : ''} · {fmt.num(mm.free)} free
                                </div>
                              </div>
                              <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold ${mm.category === 'exact' ? 'bg-emerald-50 text-emerald-700' : mm.category === 'near' ? 'bg-amber-50 text-amber-700' : 'bg-violet-50 text-violet-700'}`}>
                                {fmt.title(mm.category || 'option')}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>

                {/* Sheets to issue — the full calculation, then the planner's
                    final call on how much board actually goes to the floor. */}
                <Card icon={Scissors} title="Sheets to Issue" sub="see the maths, then decide the final number">
                  <Field label="Wastage sheets (one run)" hint={`Plant default ${DEFAULT_WASTAGE_SHEETS} — ONE allowance for the whole gang, not per product`}>
                    <Input type="number" min="0" value={gangWastage} onChange={e => setGangWastage(e.target.value)} />
                  </Field>
                  {gangCalc && (
                    <div className="mt-3 space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                      <div className="flex items-center justify-between"><span className="text-slate-500">Base child sheets <span className="text-slate-400">(Σ qty ÷ ups)</span></span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.baseChild)}</span></div>
                      <div className="flex items-center justify-between"><span className="text-slate-500">+ Wastage <span className="text-slate-400">(one press run)</span></span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.wastageTotal)}</span></div>
                      <div className="flex items-center justify-between border-t border-slate-200 pt-1.5"><span className="text-slate-500">= Child print sheets</span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.childSheets)}</span></div>
                      <div className="flex items-center justify-between"><span className="text-slate-500">→ Parent sheets <span className="text-slate-400">(÷ children per parent)</span></span><span className="font-bold tabular-nums text-violet-600">{fmt.num(gangCalc.parent)}</span></div>
                    </div>
                  )}
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wide text-violet-500">Parent sheets to issue</span>
                      {gangIssue !== '' && +gangIssue !== gangCalc?.parent && (
                        <button type="button" className="text-[10px] font-bold text-slate-400 hover:text-violet-600" onClick={() => setGangIssue('')}>reset to {fmt.num(gangCalc?.parent)}</button>
                      )}
                    </div>
                    <Input type="number" min="0" value={gangIssue}
                      placeholder={gangCalc ? String(gangCalc.parent) : ''}
                      onChange={e => setGangIssue(e.target.value)} />
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                      {gangIssue === '' || +gangIssue === gangCalc?.parent
                        ? <>Leave blank to issue the calculated <b className="text-slate-500">{fmt.num(gangCalc?.parent || 0)}</b>. Type a number to overrule it.</>
                        : <span className="font-semibold text-amber-600">Manual override — issuing {fmt.num(Math.round(+gangIssue))} vs calculated {fmt.num(gangCalc?.parent)} ({+gangIssue >= gangCalc?.parent ? '+' : ''}{fmt.num(Math.round(+gangIssue) - (gangCalc?.parent || 0))}), split across the {gangCalc?.members} products on Lock.</span>}
                    </p>
                  </div>
                </Card>
              </div>

              {/* ── RIGHT: combined board position + soft warnings ── */}
              <div className="space-y-4">
                {(() => {
                  // Board position tracks the number the planner will actually
                  // ISSUE (their override, else the live calc), so "short" and the
                  // Raise-PR trigger stay honest with the decision on the left.
                  const issueNow = gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets);
                  const avail = gangView.position?.available ?? 0;
                  const other = gangView.position?.committed_other ?? 0;
                  const short = Math.max(0, issueNow + other - avail);
                  return (
                <Card icon={Warehouse} title="Board Position" sub="combined for the gang">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat small label="Available" value={fmt.num(avail)} />
                    <Stat small label="Other Demand" value={fmt.num(other)} />
                    <Stat small label="To Issue" value={fmt.num(issueNow)} accent="text-violet-600" />
                    <Stat small label={short > 0 ? 'Short' : 'Position'}
                      value={short > 0 ? fmt.num(short) : 'Covered'}
                      accent={short > 0 ? 'text-red-600' : 'text-emerald-600'} />
                  </div>
                  {short > 0 && (
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-red-700">
                        <AlertTriangle size={13} /> Short {fmt.num(short)} — cutting waits for stock
                      </span>
                      <Button size="sm" variant="danger" onClick={gangRaisePr}>Raise ONE PR</Button>
                    </div>
                  )}
                </Card>
                  );
                })()}

                {gangView.compat?.warnings?.length > 0 && (
                  <Card icon={AlertTriangle} title="Check before running" sub="soft — not blocked">
                    <div className="space-y-1">
                      {gangView.compat.warnings.map(w => (
                        <p key={w.field} className="text-[11px] font-semibold text-amber-600">
                          ⚠ {fmt.title(w.field)} differs ({w.values.join(', ')})
                        </p>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </div>
          );
        })()}
      </Modal>

      {/* Gang board picker — sets ONE mother sheet for every product in the gang */}
      <WarehousePicker open={gangWhOpen} onClose={() => setGangWhOpen(false)}
        childL={gangView?.members?.[0]?.child_l} childW={gangView?.members?.[0]?.child_w}
        currentBoardId={gangView?.members?.[0]?.board_material_id}
        onSelect={setGangBoard} />

      {/* Reverse the whole gang's plan back to To Plan (gang kept) */}
      <ConfirmDialog open={gangReverseOpen} onClose={() => setGangReverseOpen(false)} onConfirm={reverseGang}
        title={`Reverse ${gangView?.gang_number || 'gang'} plan?`} confirmLabel="Reverse Plan" danger
        message={`Every product goes back to "To Plan" — cut-plan figures and artwork locks clear, and any unstarted job card is removed. The gang stays together so you can re-plan. Blocked if anything has started on the floor.`} />

      {/* Lock the gang sheet — same master-update choice as the single engine */}
      <Modal open={!!gangSheetPrompt} onClose={() => setGangSheetPrompt(null)}
        title={gangSheetPrompt ? `Lock the sheet for ${gangSheetPrompt.gang_number}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setGangSheetPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => applyGangSheet(false)}>Save for these {gangSheetPrompt?.count} jobs only</Button>
          <Button onClick={() => applyGangSheet(true)}>Update Product Master{gangSheetPrompt?.count > 1 ? 's' : ''}</Button>
        </>}>
        {gangSheetPrompt && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              The board, child sheet &amp; coating apply to all <b>{gangSheetPrompt.count}</b> jobs in {gangSheetPrompt.gang_number}.
              Keep it just for these jobs, or push it back to the product master(s) so every future job inherits it?
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-700">Parent (board)</span><span className="tabular-nums text-slate-500">{gangView?.members?.[0]?.board_grade} · {gangView?.members?.[0]?.board_name}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-700">Child sheet</span><span className="tabular-nums text-slate-500">{gangSheetPrompt.payload.child_l}×{gangSheetPrompt.payload.child_w}"</span></div>
              <div className="flex items-center justify-between gap-3"><span className="font-semibold text-slate-700">Coating</span><span className="text-slate-500">{gangSheetPrompt.payload.coating ? fmt.title(gangSheetPrompt.payload.coating) : '—'}</span></div>
            </div>
            <p className="text-[11px] text-slate-400">
              "Update master" only rewrites fields that differ from each product's master (and syncs board name + grade). Anything already matching the master is left alone.
            </p>
          </div>
        )}
      </Modal>

      {/* ── Gang created — UPI-style confirmation ── */}
      <GangCreatedSheet gang={gangSuccess}
        onClose={() => setGangSuccess(null)}
        onPlan={() => {
          const g = gangSuccess;
          setGangSuccess(null);
          openGangById(g.id);   // straight into the unified Gang Engine
        }} />

      {/* ── Ask Management Approval — advisory sign-off for a selective job ── */}
      <Modal open={!!askMgt} onClose={() => setAskMgt(null)} title="Ask Management Approval"
        footer={<>
          <Button variant="secondary" onClick={() => setAskMgt(null)}>Cancel</Button>
          <Button disabled={askBusy} onClick={submitAsk}>
            <ShieldQuestion size={14} /> Send to Management
          </Button>
        </>}>
        {askMgt && (
          <div className="space-y-3">
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <div className="font-semibold text-slate-800">{askMgt.line.product_name}</div>
              <div className="text-xs text-slate-500">
                PO {askMgt.line.po_number || '—'} · {askMgt.line.customer_name} · qty {fmt.num(askMgt.line.qty)}
              </div>
            </div>
            <Field label="What should management look at?" required>
              <Textarea autoFocus rows={3} value={askMgt.note}
                placeholder="e.g. Board rate looks high for this run / customer pushed delivery — confirm we still print this week"
                onChange={e => setAskMgt(a => ({ ...a, note: e.target.value }))} />
            </Field>
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
              This is not a blocker — the job continues normally. Management gets it on their bell and
              answers with approve / reject; you'll be notified either way.
            </p>
          </div>
        )}
      </Modal>

      {/* ── Master-update philosophy prompt ── */}
      <Modal open={!!masterPrompt} onClose={() => setMasterPrompt(null)} title="Save master-driven changes"
        footer={<>
          <Button variant="secondary" onClick={() => setMasterPrompt(null)}>Cancel</Button>
          <Button variant="secondary" onClick={() => savePlan({ spec: masterPrompt.changed, update_master: false })}>Save for this Job Only</Button>
          <Button onClick={() => savePlan({ spec: masterPrompt.changed, update_master: true })}>Update Product Master</Button>
        </>}>
        {masterPrompt && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              You changed master-driven fields on <b>{planLine?.product_name}</b>. Do you want to keep the change only for this job, or update the Product Master so every future job uses it?
            </p>
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              {Object.entries(masterPrompt.changed).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <span className="shrink-0 font-semibold text-slate-700">{specLabel(k)}</span>
                  <span className="min-w-0 text-right tabular-nums text-slate-500">
                    <span className="line-through">{planLine?.[k] == null || planLine?.[k] === '' ? '—' : specValue(k, planLine[k])}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{specValue(k, v)}</b>
                  </span>
                </div>
              ))}
            </div>
            {['party_artwork_code', 'output_number'].some(k => k in (masterPrompt.changed || {})) && (
              <p className="rounded-xl bg-brand-50 px-3 py-2 text-[11px] font-semibold text-brand-700">
                Sync Master? Updating the Carton Product Master keeps the Artwork Code / Output Number
                auto-populating on every future plan. (Gang runs always use their own set numbers. The
                shade card is no longer part of this sync — it lives in the Shade Card module.)
              </p>
            )}
            <p className="text-[11px] text-slate-400">This master-update choice applies wherever master-driven data is edited across the app.</p>
          </div>
        )}
      </Modal>

      {/* ── Inline PR tracker — view a requisition without leaving the engine ── */}
      <Modal open={!!prView} onClose={() => setPrView(null)}
        title={prView ? `${prView.pr_number} — ${fmt.title(prView.status)}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setPrView(null)}>Back to Engine</Button>
          <Button onClick={() => window.open('/procurement', '_blank', 'noopener')}>
            Open Procurement ↗
          </Button>
        </>}>
        {prView && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat small wrap label="Material" value={prView.material_name} />
              <Stat small label="Quantity" value={`${fmt.num(prView.qty)} ${prView.unit || ''}`} />
              <Stat small label="Status" value={fmt.title(prView.status)} />
              <Stat small label="Needed By" value={fmt.date(prView.needed_by)} />
              <Stat small label="Raised" value={fmt.date(prView.created_at)} />
              <Stat small wrap label="Requested By" value={prView.requested_by || '—'} />
            </div>
            {prView.po_number && (
              <p className="rounded-xl bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-700">
                Converted into <b>{prView.po_number}</b>{prView.vendor_name ? ` · ${prView.vendor_name}` : ''}
                {prView.po_expected_date ? ` · expected ${fmt.date(prView.po_expected_date)}` : ''}
              </p>
            )}
            {prView.reraise_of_number && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                Re-raised over {prView.reraise_of_number}{prView.reraise_reason ? `: ${prView.reraise_reason}` : ''}
              </p>
            )}
            {prView.reason && <p className="text-sm text-slate-600">Reason: {prView.reason}</p>}
            <p className="text-[11px] text-slate-400">Opening Procurement uses a new tab — your planning engine stays exactly as you left it.</p>
          </div>
        )}
      </Modal>

      {/* ── Duplicate PR confirmation ── */}
      <Modal open={!!dupPr} onClose={() => setDupPr(null)} title="Requisition already raised for this board"
        footer={<>
          <Button variant="secondary" onClick={() => setDupPr(null)}>No, Cancel</Button>
          <Button variant="danger" disabled={prBusy || !(+dupPr?.add_qty > 0) || !dupPr?.reason.trim()}
            onClick={() => raisePrInline({ qty: +dupPr.add_qty, reraise_of: dupPr.existing.id, reraise_reason: dupPr.reason.trim() })}>
            Yes, Raise Again
          </Button>
        </>}>
        {dupPr && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-800">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span><b>Warning:</b> A Purchase Requisition has already been raised for this product's board
                ({dupPr.existing.pr_number} · {fmt.num(dupPr.existing.qty)} sheets · {fmt.title(dupPr.existing.status)}
                {dupPr.count > 1 ? ` — and ${dupPr.count - 1} more active` : ''}).
                Are you sure you want to raise it again?</span>
            </p>
            <Field label="Additional Quantity Required" required>
              <Input type="number" min="1" value={dupPr.add_qty} autoFocus
                onChange={e => setDupPr({ ...dupPr, add_qty: e.target.value })} />
            </Field>
            <Field label="Reason for Re-raising" required>
              <Textarea value={dupPr.reason} placeholder="e.g. wastage on press, allocation adjustment, revised quantity"
                onChange={e => setDupPr({ ...dupPr, reason: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={reverseConfirm}
        onClose={() => setReverseConfirm(false)}
        onConfirm={reversePlan}
        danger
        title="Reverse this plan?"
        confirmLabel={reverseBusy ? 'Reversing…' : 'Reverse Plan'}
        message={planLine ? `${planLine.product_name} goes back to “To Plan”. The locked cut plan — sheets, board position and any leftover booking — is cleared and artwork approvals reset. Material and spec edits are kept.` : ''}
      />

      <BoardCommitments
        open={boardPanel}
        onClose={() => setBoardPanel(false)}
        materialId={boardSel?.id}
        prContext={{ id: null, pr_number: 'this job', order_line_id: planLine?.id }}
        onChanged={async () => { if (planLine && boardSel) setCtx(await loadCtx(planLine, boardSel.id)); }} />
    </div>
  );
}
