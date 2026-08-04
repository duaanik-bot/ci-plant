// Section workspace — one production stage in full depth:
// KPIs (received / produced / wastage / yield, pending / running / done),
// live queue with search + status filters, completed runs with per-run yield,
// machines, and the complete audit trail. Drilled into from Live Floor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link, Navigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import { ActionMenu, Button, ConfirmDialog, ExportMenu, Field, Input, Modal, OutputChip, rowMatches, SearchInput, searchText, Select, StatusBadge, Tabs, UpstreamChip, useToast, WipChip } from '../components/ui.jsx';
import { TrafficLight, ReadinessPopover } from '../components/Readiness.jsx';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BoardBadge } from '../components/BoardStatus.jsx';
import {
  ArrowLeft, Play, Check, Gauge, PackagePlus, PackageMinus, Percent, History, PauseCircle,
  Plus, Trash2, Pencil, AlertTriangle, User, Undo2,
} from 'lucide-react';
import { SECTION_META, SORTING_REJECTION_REASONS, GENERAL_WASTAGE_REASONS, HOLD_REASONS, CUTTING_VARIANCE_REASONS } from '../sections.js';
import LineClearancePanel, { needsClearance, freshClearance, allClear, clearancePayload } from '../components/LineClearance.jsx';
import BoardIssue from '../components/BoardIssue.jsx';
import PlannedBreakup from '../components/PlannedBreakup.jsx';
import { GangChip, GangMemberList } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import { customerInitials } from '../lib/customerCode.js';
import { resolveAssignment } from '../lib/runAssignment.js';
import { pickerMode, operatorChips, rowsForOperator, runsForOperator, kpisFor, readPick, writePick,
  showsMachineColumn, ownMachineName, shownOperator } from '../lib/operatorScope.js';
import { OperatorRail, RecordingAs } from '../components/OperatorRail.jsx';
import { useSendBack, SendBackDialog } from '../components/SendBack.jsx';
import { BasisToggle, CumulativeSummary, DayCountDialog, ModeChoice, RunLogPanel, postRun } from '../components/DayCount.jsx';
import { resolveEntry, partialBlockers } from '../lib/partialEntry.js';
import { receivedQty, expectedOutputQty, openingCounter } from '../lib/received.js';
import { isCardTier, useTier } from '../lib/tier.js';

// The finalised parent (board grade + full board) + child, carried from planning
// onto every station so the floor always sees the sheet that was locked.
// Stays on ONE line — the board name truncates with the full text on hover, so a
// long grade never turns a queue row into a four-line block.
function SheetLine({ r }) {
  if (!r.board_name && !r.child_l) return null;
  return (
    <div className="mt-0.5 flex items-center gap-1 text-[10px] leading-tight" title={[r.board_name, r.child_l ? `child ${r.child_l}×${r.child_w}"` : null].filter(Boolean).join(' · ')}>
      {r.board_grade && <span className="shrink-0 rounded bg-slate-800 px-1 py-px font-bold uppercase tracking-wide text-white">{r.board_grade}</span>}
      <span className="truncate font-semibold text-slate-500">{r.board_name}</span>
      {r.child_l ? <span className="shrink-0 text-slate-400">· {r.child_l}×{r.child_w}"</span> : null}
    </div>
  );
}

// A gang parent runs this station as ONE physical job — one row, one count,
// every bound product listed in the same aligned grid. Splits after die cutting.
// `sheet` is dropped on stations whose own process column already prints the
// board — otherwise cutting rows carry the same grade, board and child size twice.
// The product name is the one thing an operator reads to know what is on the
// machine, so it WRAPS in full — it is never truncated. The width it needs was
// bought from the two columns beside it: Customer / PO now shows initials, and
// the running-row actions are icons. A name long enough to take three lines
// costs three lines; a queue row that names the wrong carton costs a reprint.
// A fixed 300px band, deliberately NOT the table's slack column. Product used to
// carry `w-full` and swallow every spare pixel, which was fine for the longest
// carton name and left a hole beside the customer for every short one. The slack
// now goes to the action column at the table's right edge, where empty space
// reads as margin rather than as a gap between two fields that belong together.
//
// The name is set a step smaller than the table (13px/17px) and clamped to two
// lines. The small type is what makes the clamp civil rather than brutal: at
// 13px a ~280px column holds about 34 characters a line, so 68 characters fit
// BEFORE anything is cut — which is longer than almost every carton name the
// plant runs, and the handful that overflow keep the full text on hover. Three
// lines of 14px bought nobody anything except a third fewer jobs on screen.
// The board spec used to sit on its own line under every name — grade chip,
// board, GSM, sheet and child size. It cost a line on EVERY row to answer a
// question the floor asks occasionally, and the row it was costing is the one an
// operator scans to find his next job. It moves onto the code line's tooltip;
// nothing is lost, and a fifth job comes on screen. The Completed Runs table
// keeps the visible line — nobody is scanning that one against the clock.
const boardSpec = r => {
  const name = String(r.board_name || '');
  // board_name usually already leads with the grade ("Saffire · 290 GSM · 23x36"),
  // so only prefix it when it does not — otherwise the hover reads "Saffire ·
  // Saffire · 290 GSM".
  const grade = r.board_grade && !name.toLowerCase().startsWith(String(r.board_grade).toLowerCase())
    ? r.board_grade : null;
  return [grade, name, r.child_l ? `child ${r.child_l}×${r.child_w}"` : null].filter(Boolean).join(' · ');
};

function ProductCell({ r }) {
  // A COMBINED RUN is ONE product — its member list would print the same carton
  // N times, so the cell names the product once (like a solo job) and carries
  // the promise line; the per-PO breakdown lives in the Customer / PO column.
  // Teal, never violet: violet means "splits after die cutting", which is the
  // one thing a combined run must never do.
  if (r.run_kind === 'merge' && r.gang_members?.length) {
    return (
      <div className="w-[300px] max-w-full">
        <div className="line-clamp-2 break-words text-[13px] font-semibold leading-[17px] text-slate-800" title={r.product_name}>{r.product_name}</div>
        <div className="truncate text-xs text-slate-400" title={boardSpec(r)}>
          {r.product_code}
          {r.qty_planned > 0 && <span className="font-semibold tabular-nums text-slate-500"> · {fmt.num(r.qty_planned)} pcs</span>}
        </div>
        <div className="mt-0.5 truncate text-[10px] font-semibold text-teal-600">
          {r.gang_members.length} sales orders · one pile — no split
        </div>
      </div>
    );
  }
  if (r.gang_members?.length) {
    return (
      <div className="w-[300px] max-w-full tl:w-[230px]" title={boardSpec(r)}>
        <GangMemberList members={r.gang_members} showOrder={false} showOutput={!r.run_output_number} dense />
        <div className="mt-0.5 truncate text-[10px] font-semibold text-violet-500">
          one combined run · splits after die cutting
        </div>
      </div>
    );
  }
  return (
    <div className="w-[300px] max-w-full tl:w-[230px]">
      <div className="line-clamp-2 break-words text-[13px] font-semibold leading-[17px] text-slate-800" title={r.product_name}>{r.product_name}</div>
      {/* The ordered quantity sits with the code, the way a gang's total does —
          so the figure is in the same place whether one order or four paid for
          the run. This is the ORDER's pcs, not the station's received count,
          which has its own column and reads 0 until upstream delivers. */}
      <div className="truncate text-xs text-slate-400" title={boardSpec(r)}>
        {r.product_code}
        {r.qty_planned > 0 && <span className="font-semibold tabular-nums text-slate-500"> · {fmt.num(r.qty_planned)} pcs</span>}
      </div>
    </div>
  );
}

// Initials, not the registered name — "Swiss Garnier Life Sciences" reads SGLS,
// the same short form the plant already uses on Planning and the masters list
// (lib/customerCode.js). The full name stays on the row's hover AND in the
// search haystack, because rowMatches() reads the row's own customer_name and
// never the rendered text — so typing "swiss" still finds a cell reading SGLS.
// Initials, not the registered name — "Swiss Garnier Life Sciences" reads SGLS,
// the same short form Planning and the masters list use (lib/customerCode.js).
// The full name stays on hover AND in the search haystack, because rowMatches()
// reads the row's own customer_name and never the rendered text.
//
// Each PO carries the quantity bought ON IT. A gang prints one run for several
// orders, and the product cell gives the combined figure — but the man asking
// "how many of these are Galpha 3022's?" is asking a question the combined
// figure cannot answer, and the split is what the cartons are counted into
// after die cutting.
function CustomerCell({ r }) {
  if (r.gang_members?.length) {
    // SUM per PO, never last-one-wins: a gang can bind two lines of the same
    // order, and showing one of their quantities as though it were the pair's
    // would understate that PO.
    const byPo = [...r.gang_members.reduce((acc, m) => {
      const k = `${m.customer_name}|${m.po_number}`;
      const cur = acc.get(k) || { ...m, qty: 0 };
      cur.qty += (+m.qty || 0);
      return acc.set(k, cur);
    }, new Map()).values()];
    return (
      <div className="w-[112px] space-y-0.5">
        {byPo.map((m, i) => (
          <div key={i} title={`${m.customer_name} · PO ${m.po_number} · ${fmt.num(m.qty)} pcs`}>
            <div className="truncate font-bold text-slate-700">{customerInitials(m.customer_name) || '—'}</div>
            <div className="truncate text-xs text-slate-400">
              {m.po_number}
              {m.qty > 0 && <span className="font-semibold tabular-nums text-slate-500"> · {fmt.num(m.qty)}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="w-[112px]" title={`${r.customer_name} · PO ${r.po_number}`}>
      <div className="truncate font-bold text-slate-700">{customerInitials(r.customer_name) || '—'}</div>
      <div className="truncate text-xs text-slate-400">{r.po_number}</div>
    </div>
  );
}

// The print-set number the floor calls a job by — it belongs beside the job card
// number, not buried in the spec. Absent on jobs whose master never carried one,
// and the chip simply does not render rather than printing an empty label.
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

// The expected good output the completion form pre-fills and measures yield
// against. `section` stands in for the stage here — a section page only ever
// renders its own stage's rows.
const expectedOutput = (row, section) => expectedOutputQty(row, section, row?.children_per_parent);

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
    // Three single-line facts — board, parent→child size, sheet maths. Each one
    // truncates rather than wrapping; the full text lives on the row's tooltip.
    render: r => (
      <div className="w-[158px]">
        {/* Finalised parent (board grade + name) + child, carried from planning */}
        <div className="flex items-center gap-1" title={r.board_name}>
          {r.board_grade && <span className="shrink-0 rounded bg-slate-800 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-white">{r.board_grade}</span>}
          <span className="truncate text-[11px] font-semibold text-slate-600">{r.board_name}</span>
        </div>
        <div className="truncate font-semibold text-slate-700">
          {r.sheet_l ? `${r.sheet_l}×${r.sheet_w}"` : ''}
          {r.child_l ? <span className="text-slate-400"> → {r.child_l}×{r.child_w}"</span> : null}
        </div>
        <div className="truncate text-[11px] text-slate-400"
          title={`${fmt.num(r.sheets_issued)} parent sheets${r.children_per_parent > 1 ? ` · ${r.children_per_parent} per parent → ${fmt.num(r.sheets_issued * r.children_per_parent)} print sheets` : ''}`}>
          {fmt.num(r.sheets_issued)} parent{r.children_per_parent > 1 ? ` · ${r.children_per_parent}/parent → ${fmt.num(r.sheets_issued * r.children_per_parent)}` : ''}
        </div>
      </div>
    ),
  },
  printing: {
    header: 'Print Spec',
    render: r => (<div className="w-[132px]"><div className="font-semibold text-slate-700">{r.colors} colours</div><div className="truncate text-[11px] text-slate-400" title={`${r.size || ''}${r.coating !== 'none' ? ` · then ${fmt.title(r.coating)}` : ''}`}>{r.size || ''}{r.coating !== 'none' ? ` · then ${fmt.title(r.coating)}` : ''}</div></div>),
  },
  coating: {
    header: 'Coating',
    render: r => <span className="inline-block whitespace-nowrap rounded-full bg-cyan-50 px-2.5 py-0.5 text-xs font-semibold text-cyan-700">{fmt.title(r.coating)}</span>,
  },
  lamination: {
    header: 'Film',
    render: r => <span className="inline-block whitespace-nowrap rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold text-teal-700">{r.coating === 'matt_lam' ? 'Matt' : 'Gloss'} lam</span>,
  },
  foiling: {
    header: 'Foil Work',
    render: r => (<div className="w-[118px]"><span className="inline-block whitespace-nowrap rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">{fmt.title(r.special)}</span><div className="truncate text-[11px] text-slate-400">{r.size || ''}</div></div>),
  },
  embossing: {
    header: 'Emboss Work',
    render: r => (<div className="w-[118px]"><span className="inline-block whitespace-nowrap rounded-full bg-orange-50 px-2.5 py-0.5 text-xs font-semibold text-orange-700">{fmt.title(r.special)}</span><div className="truncate text-[11px] text-slate-400">{r.size || ''}</div></div>),
  },
  die_cutting: {
    header: 'Die Spec',
    render: r => (<div className="w-[140px]">
      <div className="truncate font-semibold text-slate-700">{r.die_number ? `Die #${r.die_number}` : `${r.ups} ups / sheet`}</div>
      <div className="truncate text-[11px] text-slate-400">{r.die_number ? `${r.ups} ups${r.die_location ? ` · rack ${r.die_location}` : ''}` : (r.size || '—')}</div>
    </div>),
  },
  sorting: {
    header: 'Count Target',
    render: r => (<div className="w-[118px]"><div className="truncate font-semibold text-slate-700">{fmt.num(r.qty_planned)} cartons</div><div className="truncate text-[11px] text-slate-400">reject with NCR reason</div></div>),
  },
  pasting: {
    header: 'Pack Target',
    render: r => (<div className="w-[118px]"><div className="truncate font-semibold text-slate-700">{fmt.num(r.qty_planned)} cartons</div><div className="truncate text-[11px] text-slate-400" title="Record boxes × qty per box on completion">boxes × qty/box</div></div>),
  },
  qc: {
    header: 'Release Target',
    render: r => (<div className="w-[118px]"><div className="truncate font-semibold text-slate-700">{fmt.num(r.qty_planned)} ordered</div><div className="truncate text-[11px] text-slate-400">closes job → FG</div></div>),
  },
};

function Kpi({ label, value, sub, icon: Icon, chip = 'bg-brand-50 text-brand-600', accent = 'text-slate-900' }) {
  return (
    <div className="rounded-[18px] border border-white/70 bg-white/65 backdrop-blur-xl p-2.5 shadow-card">
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
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[state]}`}>
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
  const tier = useTier();
  // "phone" here means the CARD presentation — phones and upright tablets.
  const phone = isCardTier(tier);
  // Tablets keep the table but the action cell compacts: one small primary,
  // everything secondary behind the app's own overflow idiom.
  const touchTable = tier === 'tabl';
  const touchUI = tier !== 'desktop';
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
  // "As planned" breakup shown in the completion dialog, cutting stages only.
  // 'idle' | 'loading' | 'loaded' | 'error' — see PlannedBreakup's own header
  // comment and openComplete below for the fail-OPEN contract: unlike
  // issueStatus (Start, which fails CLOSED), an 'error' here never blocks
  // Complete — it degrades to a one-line note because completion records
  // board that has already left the warehouse.
  const [breakupStatus, setBreakupStatus] = useState('idle');
  const [breakupRows, setBreakupRows] = useState([]);   // mixed-job board_mix, cut-geometry enriched
  const [breakupPhase, setBreakupPhase] = useState(null); // 'issued' | 'plan' | null
  const breakupReqRef = useRef(0); // guards a stale GET landing after a newer row/close
  const runLogReqRef = useRef(0);  // same guard on the run log — it pre-fills a counter
  const [starting, setStarting] = useState(null);
  const [holding, setHolding] = useState(null);
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [operator, setOperator] = useState('');
  const [machineId, setMachineId] = useState('');
  // Cutting and Printing open with machine + operator already resolved; the
  // dropdowns stay hidden behind Change. Every other station opens on the
  // dropdowns, so this is true there from the moment the modal opens.
  const [showPickers, setShowPickers] = useState(false);
  const [clearance, setClearance] = useState([]);          // line clearance checks in the start modal
  // Board issue — board is consumed only at a job's FIRST stage (cutting is
  // always first in routingFor()), and never for a gang card (order_line_id is
  // null; Planning already refuses a gang line a mix — see BoardMix.jsx). Every
  // other Start never touches this at all: issueStatus stays 'idle'.
  // 'idle' | 'loading' | 'loaded' | 'error' — three real states, never
  // collapsed into two. See BoardIssue.jsx's header comment for why a caught
  // fetch failure must never look like a confirmed empty mix.
  const [issueStatus, setIssueStatus] = useState('idle');
  const [issuePlan, setIssuePlan] = useState([]);          // last CONFIRMED load — the plan, untouched
  const [issueRows, setIssueRows] = useState([]);          // editable copy shown/posted
  const [issueLots, setIssueLots] = useState([]);
  const [issueReason, setIssueReason] = useState('');
  // Read straight off the context response rather than inferred from
  // issuePlan[0].ups — BoardMix.jsx's own row editor has no guard against
  // dropping the role='planned' row, so "first row" is not a safe stand-in
  // for "the planned board's ups" in every reachable state.
  const [issuePlannedUps, setIssuePlannedUps] = useState(0);
  // Guards against a stale request landing after a newer row/retry started —
  // the modal can be closed and reopened on a different row faster than a
  // slow GET resolves.
  const issueReqRef = useRef(0);
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
  // Sending a job back one station lives in components/SendBack.jsx — the same
  // dialog Sort & Paste uses, so the two can never drift on an act that undoes
  // real ledger movements.
  const sb = useSendBack({ toast, onDone: () => load() });
  // Partial counter filling — the day-wise run log for the stage being
  // completed, and the operator's explicit choice when the counter falls short:
  // null = not chosen yet, 'partial' = save today's count and keep the job
  // open, 'final' = close the stage (wastage auto-computes as before).
  const [runLog, setRunLog] = useState(null);
  const [entryMode, setEntryMode] = useState(null);
  // 'delta' (what was just run) or 'total' (the cumulative counter reading).
  const [entryBasis, setEntryBasis] = useState('delta');
  // The other door: a queue row's "Day count" button, straight to today's
  // figure without going through the completion form at all.
  const [dayCounting, setDayCounting] = useState(null);
  // Who is at the press. Three operators share this device and this login, so
  // the pick is BOTH a view filter (his press's queue) and the name filed
  // against everything he records. null = all presses, nobody named.
  const [pick, setPick] = useState(null);
  // The stored pick is restored once, when the crew first arrives — not on
  // every 5s poll, which would fight the operator's own taps.
  const restoredRef = useRef(null);
  const isQC = section === 'qc';
  // Pasting is also the packing station — every job passes through it — so the
  // packing manifest is captured here.
  const isPackingStage = section === 'pasting';
  // The board verdict belongs to CUTTING and nowhere else on the floor. Cutting
  // is where board is drawn, so "has it actually landed?" is the question the
  // operator is holding a guillotine over. Downstream the sheets are already
  // cut — every row would read Stock OK, which is decoration, not signal.
  const showsBoard = section === 'cutting';

  const load = () => api.get(`/floor/${section}`).then(setData);
  useEffect(() => {
    setData(null); setTab('queue'); setQ(searchParams.get('q') || ''); setState('all'); setPeriod('all');
    setPick(null);
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

  // Who can be at this station. Rebuilt on every poll, which is what makes a
  // Masters crew change show up here without a reload. A pooled station also
  // reads the employee master, so a man filed under the station but not yet
  // attached to any machine can still sign his work.
  // `pickMode`, not `mode` — `mode` further down is the completion form's
  // partial/final choice.
  const pickMode = pickerMode(section);
  const chips = useMemo(
    () => (pickMode ? operatorChips(data?.machines, { mode: pickMode, employees, section }) : []),
    [pickMode, section, data?.machines, employees]);

  // Restore the device's last pick ONCE the crew is known — the rail cannot
  // resolve a stored key before the machines have loaded. readPick drops a pick
  // made on an earlier calendar day, so the night man never signs the morning.
  useEffect(() => {
    if (!chips.length || restoredRef.current === section) return;
    restoredRef.current = section;
    setPick(readPick(section, chips));
  }, [section, chips]);

  // A man taken off that press in Masters stops filtering the screen, rather
  // than leaving it pinned to a lane that is no longer his.
  useEffect(() => {
    if (pick && chips.length && !chips.some(c => c.key === pick.key)) setPick(null);
  }, [chips, pick]);

  // A man's own tap CANCELS the pending restore. Without this, tapping a chip in
  // the instant between the rail mounting and the restore effect running gets
  // silently overwritten by the stored value — reachable on a slow floor tablet,
  // and it looks exactly like the button not working.
  const choosePick = c => { restoredRef.current = section; setPick(c); writePick(section, c); };

  // The rows this operator is responsible for — the basis for BOTH the list and
  // the KPI strip, so a card can never contradict the rows beneath it. The
  // status chips and the search box narrow the list further; they must NOT
  // narrow the KPIs, because "Running 3" is what makes those chips worth
  // tapping.
  // Queued work and finished work ask different questions of the same chip. At
  // printing both mean "this press". At a pooled station the queue means
  // "unclaimed, or mine" while a completed run means "I ran it" — an unclaimed
  // completed run is a contradiction.
  const pressQueue = useMemo(() => rowsForOperator(data?.queue || [], pick), [data, pick]);
  const pressCompleted = useMemo(() => runsForOperator(data?.completed || [], pick), [data, pick]);

  const queue = useMemo(() => {
    let rows = pressQueue;
    if (state !== 'all') rows = rows.filter(r => r.queue_state === state);
    if (q) rows = rows.filter(r => rowMatches(r, q));
    return rows;
  }, [pressQueue, q, state]);

  const completed = useMemo(() => {
    let rows = pressCompleted;
    if (period !== 'all') rows = rows.filter(r => inPeriod(r.completed_at, period));
    if (q) rows = rows.filter(r => rowMatches(r, q));
    return rows;
  }, [pressCompleted, q, period]);

  if (!meta) return <Navigate to="/floor" replace />;
  const Icon = meta.icon;
  // No pick: the server's own numbers, untouched. Picked: recomputed over that
  // press by kpisFor, which mirrors the server's block line for line.
  const k = pick ? kpisFor(pressQueue, pressCompleted) : data?.kpis;

  const sectionCrew = employees.filter(e => e.active && (!e.section || e.section === section));
  // Operator picker is machine-driven: a machine with assigned operators shows
  // ONLY its crew; unassigned machines fall back to the section crew.
  const startMachine = (data?.machines || []).find(m => String(m.id) === String(machineId));
  const machineCrew = startMachine?.operators?.length ? startMachine.operators : null;

  // Board is consumed only at a job's very first stage. cutting is always
  // first in routingFor() — a split gang child's own first stage is sorting,
  // but it never has a 'cutting' job_stage at all, so gating on the SECTION
  // (rather than trying to infer stage position client-side) already excludes
  // it for free. A RUN parent card (gang or combined run) physically runs
  // cutting as one row with order_line_id null — its mix belongs to the RUN
  // (entered once in the run's engine, stored split across the members), so
  // it is fetched from the run's own detail rather than a line's planning
  // context. Same rows, same confirm, one pile.
  const loadBoardIssue = r => {
    const myReq = ++issueReqRef.current;
    setIssueReason('');
    const runId = r.order_line_id == null ? r.line_gang_run_id : null;
    if (section !== 'cutting' || (r.order_line_id == null && !runId)) {
      setIssueStatus('idle'); setIssuePlan([]); setIssueRows([]); setIssueLots([]); setIssuePlannedUps(0);
      return;
    }
    setIssueStatus('loading'); setIssuePlan([]); setIssueRows([]); setIssueLots([]); setIssuePlannedUps(0);
    (runId ? api.get(`/gang-runs/${runId}`) : api.get(`/planning/${r.order_line_id}/context`))
      .then(d => {
        if (issueReqRef.current !== myReq) return; // superseded by a newer row/retry
        const rows = (d?.mix?.rows || []).map(x => ({
          material_id: x.material_id, stock_batch_id: x.stock_batch_id,
          // A run-level row prices itself (covers === sheets — a differing cut
          // is refused at plan-save); the server re-derives covers on confirm.
          sheets: x.sheets, ups: x.ups, covers: x.covers ?? x.sheets,
          role: x.role, reason: x.reason, board_name: x.board_name,
        }));
        setIssuePlan(rows);
        setIssueRows(rows.map(x => ({ ...x })));
        setIssueLots(d?.mix?.lots || []);
        setIssuePlannedUps(d?.mix?.planned_ups || 0);
        setIssueStatus('loaded');
      })
      .catch(() => {
        if (issueReqRef.current !== myReq) return;
        // FAIL CLOSED — never resolve this to [] the way a genuinely
        // mix-free job would read. 'error' blocks Start with a visible,
        // retryable message instead of silently taking the no-mix branch.
        setIssueStatus('error');
      });
  };

  const start = async (ackShade = false) => {
    if (issueStatus === 'loading' || issueStatus === 'error') return; // belt and braces — Start is already disabled
    const body = {
      operator: operator || undefined,
      machine_id: machineId ? +machineId : undefined,
      line_clearance: needsClearance(section) ? clearancePayload(clearance) : undefined,
      ack_shade: ackShade || undefined,
    };
    try {
      // The issued mix must be recorded BEFORE the start, because stage start
      // is what consumes it from the warehouse. Only a CONFIRMED load with
      // rows present posts anything — 'idle' (not cutting, or a card with no
      // line and no run) and a confirmed empty mix both skip it, exactly as
      // they did before this feature existed.
      if (issueStatus === 'loaded' && issueRows.length) {
        await api.post(`/job-cards/${starting.job_card_id}/board-issue`,
          { rows: issueRows, reason: issueReason });
      }
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
    setStarting(null); setOperator(''); setMachineId(''); setShowPickers(false); setShadeAlarm(null);
    setIssueStatus('idle'); setIssuePlan([]); setIssueRows([]); setIssueLots([]);
    setIssuePlannedUps(0); setIssueReason('');
    load();
  };
  // One entry point for the count/complete modal. What the counter opens with is
  // openingCounter()'s single rule, applied twice: once here off the row alone,
  // and again the moment the run log lands and the real counted total is known.
  //
  // The second pass is the one that matters. The log arrives AFTER the form is
  // built, so on the first pass a partially-counted row can only be blanked —
  // and a stage whose day counts already cover the whole issue was blanked with
  // it. The operator was shown "2,766 of 2,766 recorded" above an empty box and
  // a dead button, and had to key that same 2,766 back in to close the stage.
  const openComplete = r => {
    setCompleting(r);
    setEntryMode(null);
    setEntryBasis('delta');
    setRunLog(null);
    const partial = r.queue_state === 'partial';
    const exp = expectedOutput(r, section);
    const qcExp = receivedQty(r);
    const myLog = ++runLogReqRef.current;
    api.get(`/job-stages/${r.id}/runs`)
      .then(log => {
        if (runLogReqRef.current !== myLog) return;   // a newer row won the race
        setRunLog(log);
        const counted = log?.rollup?.qty_good || 0;
        const hasRuns = !!log?.runs?.length;
        const filled = openingCounter({ expected: isQC ? qcExp : exp, priorGood: counted, hasRuns });
        // Only ever fills a box the operator has not touched: this can land a
        // second or two in, and overwriting a figure being typed is worse than
        // the blank box it replaces.
        if (!filled) return;
        // /complete reads BOTH figures as stage totals and refuses anything
        // below the log — closing 8,480 good / 0 waste over a log holding 200
        // waste is a 409, not a save. So the wastage box carries the logged
        // total up with the counter, and the reason the log already recorded
        // comes with it, or the button would only be dead for a new reason.
        const wasted = log?.rollup?.qty_scrap || 0;
        const loggedReason = [...(log?.runs || [])].reverse().find(x => x.scrap_reason)?.scrap_reason || '';
        if (isQC) setQc(f => (f.qty_accepted === '' ? { ...f, qty_accepted: filled } : f));
        else setForm(f => (f.qty_out !== '' ? f : {
          ...f,
          qty_out: filled,
          qty_scrap: wasted > 0 ? String(wasted) : f.qty_scrap,
          scrap_reason: wasted > 0 ? loggedReason : f.scrap_reason,
        }));
      })
      .catch(() => { if (runLogReqRef.current === myLog) setRunLog(null); });
    setForm({ qty_out: openingCounter({ expected: exp, hasRuns: partial }), qty_scrap: '0', scrap_reason: '' });
    setVariance({ reason: '', note: '' });
    setPacking([emptyPack()]);
    setQc({ qty_accepted: openingCounter({ expected: qcExp, hasRuns: partial }), qty_rejected: '0', qty_rework: '0', scrap_reason: '', inspector: '', remarks: '' });
    // As-planned breakup — cutting stages only. A gang card (order_line_id
    // null) can never carry a mix (Planning refuses one), so it skips the
    // fetch and goes straight to 'loaded': PlannedBreakup's single-board
    // fallback already has everything it needs off the row itself.
    const myReq = ++breakupReqRef.current;
    if (section !== 'cutting') {
      setBreakupStatus('idle'); setBreakupRows([]); setBreakupPhase(null);
    } else if (r.order_line_id == null) {
      setBreakupStatus('loaded'); setBreakupRows([]); setBreakupPhase(null);
    } else {
      setBreakupStatus('loading'); setBreakupRows([]); setBreakupPhase(null);
      // FAIL OPEN, deliberately the opposite of loadBoardIssue's fail-closed
      // 'error' state: Start gates consumption that hasn't happened yet, so a
      // failed load there must block. Completing records cutting that has
      // ALREADY happened — the board is already cut, right or wrong — so a
      // network blip here must never stop the operator from recording it.
      api.get(`/job-cards/${r.job_card_id}`)
        .then(jc => {
          if (breakupReqRef.current !== myReq) return; // superseded
          setBreakupRows(jc.board_mix || []);
          setBreakupPhase(jc.board_mix_phase || null);
          setBreakupStatus('loaded');
        })
        .catch(() => {
          if (breakupReqRef.current !== myReq) return;
          setBreakupStatus('error');
        });
    }
  };
  // Save a partial day count: the stage stays open, nothing is auto-wasted.
  // Non-QC counters are cumulative (the machine counter as it reads), so the
  // run posted is today's delta over what the log already holds. QC enters
  // today's accepted/rejected directly.
  const savePartial = async () => {
    const good = todayGood;
    const scrap = isQC ? (+qc.qty_rejected || 0) : (+form.qty_scrap || 0);
    const reason = isQC ? qc.scrap_reason : form.scrap_reason;
    await postRun(completing.id, { good, scrap, reason, operator: pick?.name });
    const expected = isQC ? receivedQty(completing) : expectedOutput(completing, section);
    toast.success(`${completing.jc_number} — partial count saved: ${fmt.num(good)} added · ${fmt.num(stageTotal)} counted · ${fmt.num(Math.max(0, expected - stageTotal))} to go`);
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
        operator: pick?.name || undefined,
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
        // Who finished it, not who started it. Without this the server falls
        // back to st.operator and a job Shiv starts but Dileep closes is filed
        // entirely under Shiv.
        operator: pick?.name || undefined,
      });
      toast.success(section === 'die_cutting' && completing.gang_number
        ? `${completing.jc_number} — die cutting done, ${completing.gang_number} separated into individual job cards`
        : `${completing.jc_number} — ${meta.label} completed`);
    }
    setCompleting(null); load();
  };
  const hold = async () => {
    await api.post(`/job-stages/${holding.id}/hold`, { reason: holdReason, operator: pick?.name || undefined });
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
  const expectedNow = completing ? (isQC ? receivedQty(completing) : expectedOutput(completing, section)) : 0;
  const priorGood = runLog?.rollup?.qty_good || 0;
  const priorScrap = runLog?.rollup?.qty_scrap || 0;
  // The day log already covers everything this stage was issued for. Nothing is
  // left to run, so the form opens on that total instead of asking for it again
  // — and says so, rather than leaving the operator to work out why the box is
  // filled. See openingCounter() in lib/received.js.
  const fullyCounted = expectedNow > 0 && priorGood >= expectedNow;
  // What the number in the box MEANS. Final always reads as the stage total —
  // that is what /complete records. Partial reads as the quantity just run, so
  // a stage takes a second, third and fourth count without mental arithmetic;
  // the counter-total basis stays one click away for machine-counter stations.
  const basisNow = entryMode === 'partial' ? (isQC ? 'delta' : entryBasis) : 'total';
  const entry = resolveEntry({
    basis: basisNow,
    entered: isQC ? qc.qty_accepted : form.qty_out,
    priorGood,
  });
  const todayGood = entry.adding;
  const stageTotal = entry.total;
  const enteredNow = completing
    ? (isQC ? stageTotal + (+qc.qty_rejected || 0) + (+qc.qty_rework || 0) : stageTotal)
    : 0;
  const entryTouched = completing && (isQC ? qc.qty_accepted !== '' : form.qty_out !== '');
  const hasShortfall = entryTouched && enteredNow < expectedNow;
  const mode = entryMode ?? (hasShortfall ? null : 'final');
  const partialStops = partialBlockers({
    basis: basisNow,
    entered: isQC ? qc.qty_accepted : form.qty_out,
    priorGood,
    scrap: isQC ? qc.qty_rejected : form.qty_scrap,
    scrapReason: isQC ? qc.scrap_reason : form.scrap_reason,
  });
  const chooseMode = m => {
    setEntryMode(m);
    if (isQC) return;
    if (m === 'partial') setForm(f => ({ ...f, qty_scrap: '0', scrap_reason: '' }));
    else setForm(f => ({ ...f, qty_scrap: f.qty_out === '' ? f.qty_scrap : String(Math.max(0, expectedNow - (+f.qty_out || 0))) }));
  };

  // Headers may wrap — that costs one header row, not every data row. The data
  // cells are the ones pinned to a width so they truncate instead of stacking.
  // Tighter than the app default: a station queue is read standing at a machine,
  // so more rows on screen beats airy padding. Widths are declared per column —
  // `w-px` + nowrap makes a cell hug its content in an auto table, and the single
  // `w-full` on Product hands it ALL the slack, which is where a 68-character
  // carton name actually needs it. Without that the table pours its spare width
  // into Job Card and the action buttons and squeezes the one column that matters.
  const th = 'px-2.5 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
  const td = 'px-2.5 py-2 align-middle';
  // `pin` holds a column at its content width; `share` lets it take a
  // proportional cut of whatever is left over. Only three columns are pinned:
  // the two numeric ones, which never need more than their digits, and Product,
  // which is capped on purpose — give it the surplus and a short carton name
  // leaves a hole beside the customer. Everything else grows together, so a wide
  // screen spreads the room across the row instead of pooling 330px of nothing
  // between Status and the buttons.
  const pin = 'w-px whitespace-nowrap';
  const share = 'whitespace-nowrap';

  return (
    <div>
      {/* Header */}
      <div className="mb-3">
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
          {/* Touch: the machine list is one swipeable line — die cutting names
              every die here, and wrapping them ate half a portrait screen. */}
          <div className="flex flex-wrap gap-1.5 touch:w-full touch:basis-full touch:flex-nowrap touch:overflow-x-auto touch:pb-1 scrollbar-none">
            {(data?.machines || []).map(m => (
              <span key={m.id} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/70 bg-white/65 backdrop-blur-xl px-2.5 py-0.5 text-[11px] font-semibold text-slate-600 shadow-sm">
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
      <div className="ci-kpi-rail mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-7">
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

      {/* Toolbar — on a phone every band becomes its own swipe rail: chips and
          filters keep their full size and the thumb pans, nothing clips. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 ph:mb-2 ph:block ph:space-y-2">
        {/* Tabs and the operator rail read as one left-hand group — the counts
            follow the pick, so a man's tab says how much work HE has. */}
        <div className="flex flex-wrap items-center gap-2 ph:flex-nowrap ph:overflow-x-auto ph:pb-1 scrollbar-none">
          <Tabs active={tab} onChange={setTab} tabs={[
            // Touch screens get one-word tabs — "Production Queue" was clipping
            // to "Production Que" in the portrait rail.
            { key: 'queue', label: touchUI ? 'Queue' : 'Production Queue', count: pressQueue.length },
            { key: 'completed', label: touchUI ? 'Completed' : 'Completed Runs', count: pressCompleted.length },
            { key: 'audit', label: touchUI ? 'Audit' : 'Audit Trail' },
          ]} />
          <OperatorRail chips={chips} pick={pick} onPick={choosePick} mode={pickMode} />
        </div>
        <div className="mb-4 flex items-center gap-2 ph:mb-0 ph:flex-nowrap ph:overflow-x-auto ph:pb-1 scrollbar-none">
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
              meta: [pick ? `Operator: ${pick.name}${pick.machineName ? ` — ${pick.machineName}` : ''}` : null,
                `Filter: ${QUEUE_FILTERS.find(f => f.key === state)?.label || 'All'}`, q ? `Search: "${q}"` : null],
              summary: kpiSummary,
              columns: [
                { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number}${r.output_number ? ` · Out ${r.output_number}` : ''}${r.gang_number ? ` (${r.gang_number})` : ''}` },
                { key: 'product_name', label: 'Product', export: r => r.gang_members?.length ? gangExportName(r) : `${r.product_name} (${r.product_code})` },
                { key: 'customer_name', label: 'Customer / PO', export: r => r.gang_members?.length
                  ? [...new Set(r.gang_members.map(m => `${m.customer_name} · PO ${m.po_number}`))].join(' | ')
                  : `${r.customer_name} · PO ${r.po_number}` },
                { key: 'process', label: PROCESS_COLUMN[section]?.header || 'Process', render: r => PROCESS_COLUMN[section]?.render(r) },
                { key: 'qty_in', label: `Qty (${queue[0]?.unit || 'units'})`, align: 'right', export: r => fmt.num(receivedQty(r)) },
                ...(showsMachineColumn(section) ? [
                  { key: 'machine_name', label: section === 'printing' ? 'Press' : 'Machine',
                    export: r => (ownMachineName(r, section) ? `${r.machine_name}${r.machine_model ? ` — ${r.machine_model}` : ''}` : '—') },
                ] : []),
                { key: 'operator', label: 'Operator', export: r => shownOperator(r, section) || '—' },
                { key: 'queue_state', label: 'Status', export: r => `${fmt.title(r.queue_state)}${r.queue_state === 'hold' && r.hold_reason ? ` — ${r.hold_reason}` : ''}` },
                { key: 'delivery_date', label: 'Delivery', export: r => fmt.date(r.delivery_date) },
              ],
              rows: queue,
            };
            if (tab === 'completed') return {
              name: `${meta.label} Completed Runs`,
              title: `${meta.label} — Completed Runs`,
              subtitle: 'Live Floor · Station output',
              meta: [pick ? `Operator: ${pick.name}${pick.machineName ? ` — ${pick.machineName}` : ''}` : null,
                `Period: ${PERIODS.find(p => p.key === period)?.label || 'All'}`, q ? `Search: "${q}"` : null],
              summary: kpiSummary,
              columns: [
                { key: 'jc_number', label: 'Job Card', export: r => `${r.jc_number}${r.output_number ? ` · Out ${r.output_number}` : ''}${r.gang_number ? ` (${r.gang_number})` : ''}` },
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

      {/* Queue — phone: one card per job, thumb-sized actions, nothing sideways.
          The card is built from the SAME fragments the table renders (readiness
          light, chips, process line, queue badge) and calls the same handlers,
          so behaviour cannot drift between the two forms. */}
      {tab === 'queue' && phone && (
        <div className="ci-card-grid grid grid-cols-1 gap-2.5">
          {queue.length === 0 && (
            <div className="ci-data-panel px-4 py-12 text-center text-sm text-slate-400">
              {!pick ? <>Nothing in this view — the section is clear.</>
                : pick.machineName ? <>Nothing in this view — {pick.machineName} is clear for {pick.name}.</>
                : <>Nothing assigned to {pick.name} yet.{' '}
                    <button type="button" onClick={() => choosePick(null)} className="font-semibold text-brand-700 underline">Show all operators</button></>}
            </div>
          )}
          {queue.map(r => (
            <div key={r.id} className={`glass rounded-2xl p-3 ${r.gang_members?.length ? 'border-l-[3px] border-violet-400' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-slate-900">
                  {r.light && <ReadinessPopover light={r.light}><TrafficLight light={r.light} size="sm" /></ReadinessPopover>}
                  <span className="truncate">{r.jc_number}</span>
                </span>
                <QueueBadge state={r.queue_state} />
              </div>
              <div className="mt-1.5"><ProductCell r={r} /></div>
              <div className="mt-1"><CustomerCell r={r} /></div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {(!r.gang_members?.length || r.run_output_number) && <OutputChip number={r.output_number} />}
                {showsBoard && r.board_state && r.board_state !== 'covered' && (
                  <BoardBadge state={r.board_state} compact />
                )}
                {r.wip && <WipChip on />}
                {r.gang_number && <GangChip number={r.gang_number} />}
                {r.upstream && <UpstreamChip upstream={r.upstream} available={r.upstream_available} unit={r.unit} />}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 border-t border-[#1D1D1F]/[0.06] pt-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{r.unit || 'Units'}</div>
                  <div className="text-[13px] font-bold tabular-nums text-slate-800">{fmt.num(receivedQty(r))}</div>
                </div>
                {showsMachineColumn(section) && (
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{section === 'printing' ? 'Press' : 'Machine'}</div>
                    <div className="truncate text-[13px] font-semibold text-slate-800">
                      {ownMachineName(r, section) ? r.machine_name : <span className="text-amber-600">{section === 'printing' ? 'Not assigned' : '—'}</span>}
                    </div>
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Operator</div>
                  <div className="truncate text-[13px] font-semibold text-slate-800">{shownOperator(r, section) || '—'}</div>
                </div>
              </div>
              <div className="mt-1 text-xs text-slate-500">{PROCESS_COLUMN[section]?.render(r)}</div>
              {r.queue_state === 'hold' && r.hold_reason && (
                <div className="mt-1 text-[12px] font-semibold text-red-500">{r.hold_reason}</div>
              )}
              {r.queue_state === 'partial' && (
                <div className="mt-1 text-[12px] font-bold tabular-nums text-cyan-700">
                  {fmt.num(r.qty_out || 0)} / {fmt.num(expectedOutput(r, section) || r.expected_qty || 0)} counted
                  {r.qty_scrap > 0 && <span className="font-medium text-red-500"> · {fmt.num(r.qty_scrap)} waste</span>}
                </div>
              )}
              {canOperate() && (
                <div className="mt-2.5 space-y-1.5">
                  {(r.startable ?? r.queue_state === 'queued') && (
                    <Button className="w-full" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                      onClick={() => {
                        const a = resolveAssignment(section, r, data?.machines);
                        setStarting(r); setMachineId(a.machineId); setOperator(pick?.name || a.operator);
                        setShowPickers(!a.auto); setClearance(freshClearance());
                        loadBoardIssue(r);
                      }}>
                      <Play size={14} /> {r.queue_state === 'incoming' ? 'Start ahead' : 'Start'}
                    </Button>
                  )}
                  {(r.queue_state === 'running' || r.queue_state === 'partial') && (
                    <div className="flex items-center gap-1.5">
                      <Button variant="success" className="flex-1" onClick={() => openComplete(r)}>
                        <Check size={14} /> {r.queue_state === 'partial' ? 'Count / Finish' : 'Complete'}
                      </Button>
                      <ActionMenu items={[
                        ...(r.unit === 'sheets' ? [{ key: 'xs', label: 'Extra sheets', icon: PackagePlus,
                          onClick: () => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); } }] : []),
                        { key: 'hold', label: 'Hold', icon: PauseCircle, onClick: () => setHolding(r) },
                        { key: 'sendback', label: 'Send back', icon: Undo2, onClick: () => sb.open(r) },
                        { key: 'day', label: 'Day count', icon: Plus, onClick: () => setDayCounting(r) },
                      ]} />
                    </div>
                  )}
                  {r.queue_state === 'hold' && (
                    <div className="flex items-center gap-1.5">
                      <Button className="flex-1" onClick={() => resume(r)}><Play size={14} /> Resume</Button>
                      {r.unit === 'sheets' && (
                        <ActionMenu items={[{ key: 'xs', label: 'Extra sheets', icon: PackagePlus,
                          onClick: () => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); } }]} />
                      )}
                    </div>
                  )}
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
                {!touchTable && <th className={`${th} ${pin} text-right`}>S.No.</th>}
                <th className={`${th} ${share}`}>Job Card</th>
                <th className={`${th} ${pin}`}>Product</th>
                <th className={`${th} ${share}`}>Customer / PO</th>
                <th className={`${th} ${share} ci-p3`}>{PROCESS_COLUMN[section]?.header || 'Process'}</th>
                {/* The unit alone — "Qty (sheets)" forced a 104px column for a
                    figure that is usually four characters. */}
                <th className={`${th} ${pin} text-right`}>{queue[0]?.unit || 'Units'}</th>
                {/* Die cutting picks its machine at Start — see showsMachineColumn.
                    The OPERATOR column stays: once a man self-assigns, his name
                    against the job is exactly what the floor needs. */}
                {showsMachineColumn(section) &&
                  <th className={`${th} ${share}`}>{section === 'printing' ? 'Press' : 'Machine'}</th>}
                <th className={`${th} ${share}`}>Operator</th>
                <th className={`${th} ${share}`}>Status</th>
                {canOperate() && <th className={`${th} ${share} text-right`} />}
              </tr></thead>
              <tbody>
                {queue.length === 0 && (
                  <tr><td colSpan={showsMachineColumn(section) ? 10 : 9} className="px-4 py-12 text-center text-sm text-slate-400">
                    {!pick ? <>Nothing in this view — the section is clear.</>
                      : pick.machineName
                        ? <>Nothing in this view — {pick.machineName} is clear for {pick.name}.</>
                        : (
                          /* A pooled chip shows only what the man has taken, so an
                             empty list means "you are on nothing" — and the next
                             move is to go and pick a job up, not to wonder why. */
                          <>
                            Nothing assigned to {pick.name} yet.{' '}
                            <button type="button" onClick={() => choosePick(null)}
                              className="font-semibold text-brand-700 underline-offset-2 hover:underline">
                              Show all operators
                            </button>{' '}
                            to pick up a job — it lands here once you start it.
                          </>
                        )}
                  </td></tr>
                )}
                {queue.map((r, i) => (
                  <tr key={r.id} className={`ci-table-row ${r.gang_members?.length ? (r.run_kind === 'merge' ? 'border-l-[3px] border-teal-400 bg-teal-50/30' : 'border-l-[3px] border-violet-400 bg-violet-50/30') : ''}`}>
                    {!touchTable && <td className={`${td} text-right tabular-nums text-slate-400`}>{i + 1}</td>}
                    <td className={`${td} whitespace-nowrap font-bold text-slate-900`}>
                      {/* This station's own dot — red only when THIS station
                          cannot produce, not when the card has a distant snag. */}
                      <span className="inline-flex items-center gap-1.5">
                        {r.light && (
                          <ReadinessPopover light={r.light}>
                            <TrafficLight light={r.light} size="sm" />
                          </ReadinessPopover>
                        )}
                        {r.jc_number}
                      </span>
                      {/* A gang that has been NAMED shows the run's own output
                          number — one plate set for the whole sheet. Unnamed,
                          each bound product still carries its own in the
                          product cell, so the parent shows nothing. */}
                      {(!r.gang_members?.length || r.run_output_number) &&
                        <div className="mt-0.5"><OutputChip number={r.output_number} /></div>}
                      {showsBoard && r.board_state && r.board_state !== 'covered' && (
                        <div className="mt-0.5"><BoardBadge state={r.board_state} compact /></div>
                      )}
                      {r.wip && <div className="mt-0.5"><WipChip on /></div>}
                      {r.gang_number && <div className="mt-0.5">{r.run_kind === 'merge' ? <MergeChip number={r.gang_number} /> : <GangChip number={r.gang_number} />}</div>}
                    </td>
                    {/* These two read as one unit — the carton and who bought it —
                        so the gap between them is halved and the room goes inside
                        the cells instead of between them. */}
                    <td className={`${td} pr-1`}><ProductCell r={r} /></td>
                    <td className={`${td} pl-1`}><CustomerCell r={r} /></td>
                    <td className={`${td} ci-p3 text-xs`}>{PROCESS_COLUMN[section]?.render(r)}</td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.num(receivedQty(r))}</td>
                    {/* At printing these mirror the Print Planning board live — drag a
                        job to another press and both flip here. Everywhere else they
                        show only what THIS stage really has: a job nobody has started
                        is on no machine and belongs to no one, and must never borrow
                        the job card's press to look otherwise. */}
                    {showsMachineColumn(section) && (
                      <td className={td}>
                        {ownMachineName(r, section) ? (
                          <div className="w-[106px]" title={`${r.machine_name}${r.machine_model ? ` — ${r.machine_model}` : ''}`}>
                            <div className="truncate text-xs font-bold text-slate-800">{r.machine_name}</div>
                            {r.machine_model && <div className="truncate text-[11px] text-slate-400">{r.machine_model}</div>}
                          </div>
                        ) : (
                          <span className="whitespace-nowrap text-xs font-semibold text-amber-600"
                            title={section === 'printing' ? 'Not assigned — set the press in Print Planning' : 'Chosen by the operator when he starts'}>
                            {section === 'printing' ? 'Not assigned' : '—'}
                          </span>
                        )}
                      </td>
                    )}
                    <td className={td}>
                      {shownOperator(r, section) ? (
                        <span className="inline-flex max-w-[104px] items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700" title={shownOperator(r, section)}>
                          <User size={10} className="shrink-0" /> <span className="truncate">{shownOperator(r, section)}</span>
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className={td}>
                      <QueueBadge state={r.queue_state} />
                      {r.queue_state === 'hold' && r.hold_reason && (
                        <div className="mt-0.5 max-w-[150px] truncate text-[11px] text-red-500" title={r.hold_reason}>{r.hold_reason}</div>
                      )}
                      {r.queue_state === 'partial' && (
                        <div className="mt-0.5 whitespace-nowrap text-[11px] font-bold tabular-nums text-cyan-700"
                          title={`${fmt.num(r.qty_out || 0)} of ${fmt.num(expectedOutput(r, section) || r.expected_qty || 0)} counted so far${r.qty_scrap > 0 ? ` · ${fmt.num(r.qty_scrap)} waste` : ''}`}>
                          {fmt.num(r.qty_out || 0)} / {fmt.num(expectedOutput(r, section) || r.expected_qty || 0)}
                          {r.qty_scrap > 0 && <span className="font-medium text-red-500"> · {fmt.num(r.qty_scrap)} waste</span>}
                        </div>
                      )}
                      {/* Where the feed stands — cutting started / counting / done. */}
                      {r.upstream && (
                        <div className="mt-0.5">
                          <UpstreamChip upstream={r.upstream} available={r.upstream_available} unit={r.unit} />
                        </div>
                      )}
                    </td>
                    {canOperate() && touchTable && (
                      /* Tablet action cell — the primary verb stays on screen at
                         sm size; hold / send back / day count / extra sheets
                         live behind the ⋯ the rest of the app already speaks.
                         No cluster, no sideways scroll. */
                      <td className={`${td} whitespace-nowrap text-right`}>
                        <span className="inline-flex items-center gap-1">
                          {(r.startable ?? r.queue_state === 'queued') && (
                            <Button size="sm" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                              title={r.queue_state === 'incoming' ? 'Start ahead — the previous stage has not finished yet' : 'Start this run'}
                              onClick={() => {
                                const a = resolveAssignment(section, r, data?.machines);
                                setStarting(r); setMachineId(a.machineId); setOperator(pick?.name || a.operator);
                                setShowPickers(!a.auto); setClearance(freshClearance());
                                loadBoardIssue(r);
                              }}>
                              <Play size={12} /> Start
                            </Button>
                          )}
                          {(r.queue_state === 'running' || r.queue_state === 'partial') && (
                            <>
                              <Button size="sm" variant="success" onClick={() => openComplete(r)}
                                title={r.queue_state === 'partial' ? "Record today's count, or finish the stage" : 'Enter the counter and complete'}>
                                <Check size={12} /> {r.queue_state === 'partial' ? 'Count' : 'Complete'}
                              </Button>
                              <ActionMenu items={[
                                ...(r.unit === 'sheets' ? [{ key: 'xs', label: 'Extra sheets', icon: PackagePlus,
                                  onClick: () => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); } }] : []),
                                { key: 'hold', label: 'Hold', icon: PauseCircle, onClick: () => setHolding(r) },
                                { key: 'sendback', label: 'Send back', icon: Undo2, onClick: () => sb.open(r) },
                                { key: 'day', label: 'Day count', icon: Plus, onClick: () => setDayCounting(r) },
                              ]} />
                            </>
                          )}
                          {r.queue_state === 'hold' && (
                            <>
                              <Button size="sm" onClick={() => resume(r)}><Play size={12} /> Resume</Button>
                              {r.unit === 'sheets' && (
                                <ActionMenu items={[{ key: 'xs', label: 'Extra sheets', icon: PackagePlus,
                                  onClick: () => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); } }]} />
                              )}
                            </>
                          )}
                        </span>
                      </td>
                    )}
                    {canOperate() && !touchTable && (
                      <td className={`${td} whitespace-nowrap text-right`}>
                        {(r.startable ?? r.queue_state === 'queued') && (
                          <Button size="sm" variant={r.queue_state === 'incoming' ? 'secondary' : 'primary'}
                            title={r.queue_state === 'incoming'
                              ? `Start ahead — ${r.upstream ? fmt.stage(r.upstream.stage) : 'the previous stage'} hasn't finished yet; this stage can't be completed until it does`
                              : 'Start this run'}
                            onClick={() => {
                              // Never default to machines[0] — that posted the
                              // alphabetically-first machine of the section and
                              // silently misattributed the run.
                              const a = resolveAssignment(section, r, data?.machines);
                              // A man who has named himself on the rail outranks
                              // the crew fallback: he IS the one at the press,
                              // and every visible row is his press's work.
                              setStarting(r); setMachineId(a.machineId); setOperator(pick?.name || a.operator);
                              setShowPickers(!a.auto); setClearance(freshClearance());
                              loadBoardIssue(r);
                            }}>
                            <Play size={12} /> {r.queue_state === 'incoming' ? 'Start ahead' : 'Start'}
                          </Button>
                        )}
                        {/* The four side actions carry their icon only — their
                            labels were costing the row more width than the
                            product name had. Each keeps a title naming the
                            action first, so a hover still reads as a word, and
                            an aria-label so the button is never just a glyph.
                            Complete keeps its text: it is the one action an
                            operator must not have to hover to find. */}
                        {(r.queue_state === 'running' || r.queue_state === 'partial') && (
                          <span className="inline-flex gap-1">
                            {r.unit === 'sheets' && (
                              <Button size="sm" variant="ghost" className="px-2" aria-label="Extra sheets"
                                title="Extra sheets — request more from the warehouse"
                                onClick={() => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); }}>
                                <PackagePlus size={14} />
                              </Button>
                            )}
                            <Button size="sm" variant="secondary" className="px-2" aria-label="Hold"
                              title="Hold — pause this job here" onClick={() => setHolding(r)}>
                              <PauseCircle size={14} />
                            </Button>
                            <Button size="sm" variant="ghost" className="px-2" aria-label="Send back"
                              title="Send back — return this job one station" onClick={() => sb.open(r)}>
                              <Undo2 size={14} />
                            </Button>
                            <Button size="sm" variant="ghost" className="px-2" aria-label="Day count"
                              title="Day count — record today's output and keep the job open here"
                              onClick={() => setDayCounting(r)}>
                              <Plus size={14} />
                            </Button>
                            <Button size="sm" variant="success" onClick={() => openComplete(r)}
                              title={r.queue_state === 'partial' ? "Record today's count, or finish the stage" : 'Enter the counter and complete'}>
                              <Check size={12} /> {r.queue_state === 'partial' ? 'Count / Finish' : 'Complete'}
                            </Button>
                          </span>
                        )}
                        {r.queue_state === 'hold' && (
                          <span className="inline-flex gap-1">
                            {r.unit === 'sheets' && (
                              <Button size="sm" variant="ghost" className="px-2" aria-label="Extra sheets"
                                title="Extra sheets — request more from the warehouse"
                                onClick={() => { setRequesting(r); setReqForm({ qty: '', reason: '', note: '' }); }}>
                                <PackagePlus size={14} />
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
      {tab === 'completed' && phone && (
        <div className="ci-card-grid grid grid-cols-1 gap-2.5">
          {completed.length === 0 && (
            <div className="ci-data-panel px-4 py-12 text-center text-sm text-slate-400">No completed runs yet.</div>
          )}
          {completed.map(r => (
            <div key={r.id} className={`glass rounded-2xl p-3 ${r.gang_members?.length ? 'border-l-[3px] border-violet-400' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-slate-900">
                  {r.light && <ReadinessPopover light={r.light}><TrafficLight light={r.light} size="sm" /></ReadinessPopover>}
                  <span className="truncate">{r.jc_number}</span>
                </span>
                <YieldPill pct={r.yield_pct} />
              </div>
              {r.gang_members?.length
                ? <div className="mt-1.5"><GangMemberList members={r.gang_members} showOrder={false} showOutput={!r.run_output_number} dense /><SheetLine r={r} /></div>
                : (
                  <div className="mt-1.5">
                    <div className="break-words text-[14px] font-semibold leading-snug text-slate-800">{r.product_name}</div>
                    <div className="text-xs text-slate-400">{customerInitials(r.customer_name)}</div>
                    <SheetLine r={r} />
                  </div>
                )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {(!r.gang_members?.length || r.run_output_number) && <OutputChip number={r.output_number} />}
                {r.wip && <WipChip on />}
                {r.gang_number && <GangChip number={r.gang_number} />}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 border-t border-[#1D1D1F]/[0.06] pt-2">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Received</div>
                  <div className="text-[13px] font-semibold tabular-nums text-slate-800">{fmt.num(r.qty_in)} {r.unit}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Produced</div>
                  <div className="text-[13px] font-bold tabular-nums text-emerald-700">{fmt.num(r.qty_out)}</div>
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Wastage</div>
                  <div className={`text-[13px] font-semibold tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                    {fmt.num(r.qty_scrap)}{r.wastage_pct != null && r.qty_scrap > 0 && <span className="ml-1 text-[11px]">({r.wastage_pct}%)</span>}
                  </div>
                </div>
              </div>
              {r.scrap_reason && <div className="mt-1 text-[12px] font-medium text-red-400">{r.scrap_reason}</div>}
              <div className="mt-1.5 text-xs text-slate-500">
                {r.operator || '—'} · {fmt.dt(r.completed_at)}{r.duration_min != null ? ` · ${r.duration_min}m` : ''}
              </div>
              {canOperate() && (
                <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => openAdjust(r)}><Pencil size={13} /> Adjust</Button>
                  <Button size="sm" variant="ghost" onClick={() => sb.open(r)}><Undo2 size={13} /> Send back</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setReversing(r); setReverseReason(''); }}><Undo2 size={13} /> Reverse</Button>
                </div>
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
                  <tr key={r.id} className={`ci-table-row ${r.gang_members?.length ? (r.run_kind === 'merge' ? 'border-l-[3px] border-teal-400 bg-teal-50/30' : 'border-l-[3px] border-violet-400 bg-violet-50/30') : ''}`}>
                    <td className={`${td} whitespace-nowrap font-bold text-slate-900`}>
                      {/* This station's own dot — red only when THIS station
                          cannot produce, not when the card has a distant snag. */}
                      <span className="inline-flex items-center gap-1.5">
                        {r.light && (
                          <ReadinessPopover light={r.light}>
                            <TrafficLight light={r.light} size="sm" />
                          </ReadinessPopover>
                        )}
                        {r.jc_number}
                      </span>
                      {(!r.gang_members?.length || r.run_output_number) &&
                        <div className="mt-0.5"><OutputChip number={r.output_number} /></div>}
                      {r.gang_number && <div className="mt-0.5">{r.run_kind === 'merge' ? <MergeChip number={r.gang_number} /> : <GangChip number={r.gang_number} />}</div>}
                    </td>
                    {/* Same rule as the queue: the name wraps in full, the
                        customer sits under it as initials with the registered
                        name on hover. */}
                    <td className={td}>{r.gang_members?.length
                      ? <div className="w-[248px]"><GangMemberList members={r.gang_members} showOrder={false} showOutput={!r.run_output_number} dense /><SheetLine r={r} /></div>
                      : (<div className="w-[248px]" title={`${r.product_name} · ${r.customer_name}`}>
                          <div className="break-words font-semibold leading-snug text-slate-800">{r.product_name}</div>
                          <div className="truncate text-xs text-slate-400">{customerInitials(r.customer_name)}</div>
                          <SheetLine r={r} />
                        </div>)}</td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{fmt.num(r.qty_in)} {r.unit}</td>
                    <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(r.qty_out)}</td>
                    <td className={`${td} text-right tabular-nums ${r.qty_scrap > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                      <span className="whitespace-nowrap">{fmt.num(r.qty_scrap)}{r.wastage_pct != null && r.qty_scrap > 0 && <span className="ml-1 text-[11px]">({r.wastage_pct}%)</span>}</span>
                      {r.scrap_reason && <div className="max-w-[130px] truncate text-[11px] font-medium text-red-400" title={r.scrap_reason}>{r.scrap_reason}</div>}
                    </td>
                    <td className={`${td} text-right`}><YieldPill pct={r.yield_pct} /></td>
                    <td className={`${td} max-w-[110px] truncate text-xs text-slate-500`} title={r.operator || ''}>{r.operator || '—'}</td>
                    <td className={`${td} whitespace-nowrap text-xs tabular-nums text-slate-500`}>{fmt.dt(r.completed_at)}</td>
                    <td className={`${td} whitespace-nowrap text-right text-xs tabular-nums text-slate-500`}>{r.duration_min != null ? `${r.duration_min}m` : '—'}</td>
                    {canOperate() && (
                      <td className={`${td} whitespace-nowrap text-right`}>
                        {touchTable ? (
                          <ActionMenu items={[
                            { key: 'adjust', label: 'Adjust quantities', icon: Pencil, onClick: () => openAdjust(r) },
                            { key: 'sendback', label: 'Send back', icon: Undo2, onClick: () => sb.open(r) },
                            { key: 'reverse', label: 'Reverse', icon: Undo2, onClick: () => { setReversing(r); setReverseReason(''); } },
                          ]} />
                        ) : (
                        <span className="inline-flex justify-end gap-1">
                          <Button size="sm" variant="ghost" title="Adjust quantities — cascades to the next stage" onClick={() => openAdjust(r)}>
                            <Pencil size={12} /> Adjust
                          </Button>
                          <Button size="sm" variant="ghost" title="Send this job back one station" onClick={() => sb.open(r)}>
                            <Undo2 size={12} /> Send back
                          </Button>
                          <Button size="sm" variant="ghost" title="Reopen this completed stage here to correct its output" onClick={() => { setReversing(r); setReverseReason(''); }}>
                            <Undo2 size={12} /> Reverse
                          </Button>
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
          <Button onClick={() => start()}
            disabled={issueStatus === 'loading' || issueStatus === 'error'
              || (needsClearance(section) && !allClear(clearance))}
            title={
              issueStatus === 'loading' ? 'Loading this job’s board plan…'
              : issueStatus === 'error' ? 'Could not load the board plan — retry before starting'
              : (needsClearance(section) && !allClear(clearance)) ? 'Confirm line clearance first'
              : undefined}>
            <Play size={13} /> Start Run
          </Button>
        </>}>
        {starting && (
          <div className="space-y-3">
            <div className="ci-summary-panel text-xs">
              {starting.gang_number
                ? <span className="font-semibold text-violet-700">{starting.gang_number} — {starting.gang_members?.length || ''} products in one run</span>
                : starting.product_name} · Expected input: <b>{fmt.num(starting.expected_qty)} {starting.unit}</b>
              {/* machine_name falls back to the JOB CARD's press, so it only means
                  this stage's machine when the stage has one of its own — or at
                  printing, where the press IS this station's machine. Anywhere
                  else it would name a press on a cutting or coating run. */}
              {starting.machine_name && (starting.machine_id || section === 'printing') && <> · {starting.machine_name}</>}
              {starting.gang_members?.length > 0 && <GangMemberList members={starting.gang_members} className="mt-2" />}
            </div>
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Run assignment</span><span>{meta.label}</span></div>
              {!showPickers && startMachine ? (
                /* Cutting and Printing arrive decided — the press came from Print
                   Planning, the cutting machine from the master's default flag.
                   Change is always one click away for a breakdown or a relief man. */
                <div className="flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black text-slate-800">{startMachine.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      <User size={11} /> {operator || auth.user?.name}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-black tracking-wider text-white">AUTO</span>
                    <button type="button" onClick={() => setShowPickers(true)}
                      className="text-xs font-bold text-brand-700 underline decoration-dotted underline-offset-2 hover:text-brand-900">
                      Change
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="ci-form-grid">
                    {(data?.machines || []).length > 0 && (
                      <Field label="Machine">
                        <Select value={machineId} onChange={e => { setMachineId(e.target.value); setOperator(''); }}>
                          {/* Blank first: an unpicked machine must stay unpicked
                              rather than record whichever sorted first. */}
                          <option value="">— Select machine —</option>
                          {data.machines.map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}{m.operators?.length ? ` — ${m.operators.length} operator${m.operators.length > 1 ? 's' : ''}` : ''}</option>)}
                        </Select>
                      </Field>
                    )}
                    <Field label="Operator"
                      hint={machineCrew ? `Assigned crew of ${startMachine.name}` : 'Defaults to your own name if left blank'}>
                      <Select value={operator} onChange={e => setOperator(e.target.value)}>
                        <option value="">— {auth.user?.name} (me) —</option>
                        {(machineCrew || sectionCrew).map(e => <option key={e.id} value={e.name} data-search={searchText(e)}>{e.name}{e.role && e.role !== 'operator' ? ` (${fmt.title(e.role)})` : ''}</option>)}
                      </Select>
                    </Field>
                  </div>
                  {startMachine && !machineCrew && (
                    <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                      No operators are assigned to {startMachine.name} — showing the whole {meta.label} crew.
                      Assign operators in Masters → Machines to tighten this list.
                    </p>
                  )}
                </>
              )}
            </section>
            <BoardIssue status={issueStatus} mix={issuePlan} lots={issueLots} rows={issueRows}
              onChange={setIssueRows} reason={issueReason} onReason={setIssueReason}
              plannedUps={issuePlannedUps} onRetry={() => loadBoardIssue(starting)} />
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
            <Button variant="primary" onClick={savePartial} disabled={partialStops.length > 0}>
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
        {/* Whose name this count goes under. The Start modal already names the
            operator in its run-assignment panel; completion never did, and on a
            shared device that is exactly where the wrong man's name gets
            recorded. Closing it clears the pick and the rail goes back to All. */}
        {completing && <RecordingAs pick={pick} onChange={() => choosePick(null)} />}
        {/* Every completion now OPENS with the choice, so "today's count" is a
            visible option instead of a discovery. Final stays pre-selected so a
            straightforward close is still one click; on a shortfall the panel
            turns amber and nothing is pre-selected until the operator says. */}
        {completing && (
          <ModeChoice mode={mode} onChoose={chooseMode} isQC={isQC}
            shortfall={hasShortfall ? { entered: enteredNow, expected: expectedNow } : null} />
        )}
        {/* Day-wise counts already on the stage — with today's live delta. */}
        {completing && (
          <RunLogPanel runLog={runLog} onDelete={completing.status !== 'completed' ? deleteRun : null}>
            {/* A total-basis figure under the log is a typo, not a dead end —
                the same keystrokes are usually the quantity just run. */}
            {!isQC && entry.belowLog && (
              <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] font-semibold text-amber-800">
                {fmt.num(+form.qty_out || 0)} is below the {fmt.num(priorGood)} already recorded.
                {mode === 'partial' ? (
                  <button type="button" onClick={() => setEntryBasis('delta')}
                    className="ml-1 underline decoration-dotted underline-offset-2 hover:text-amber-900">
                    Is that what you ran just now? Switch to “Adding now”.
                  </button>
                ) : ' Choose “Day count” above to add it to the log instead, or delete a wrong count.'}
              </p>
            )}
            {!isQC && !entry.belowLog && todayGood > 0 && mode === 'partial' && (
              <p className="mt-2 text-[11px] font-semibold text-cyan-700">
                Adds {fmt.num(todayGood)} to the log · stage reaches {fmt.num(stageTotal)} {completing.unit}.
              </p>
            )}
          </RunLogPanel>
        )}
        {completing && isQC && (() => {
          const acc = +qc.qty_accepted || 0, rej = +qc.qty_rejected || 0, rw = +qc.qty_rework || 0;
          const inSt = receivedQty(completing);
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
                    {sectionCrew.map(e => <option key={e.id} value={e.name} data-search={searchText(e)}>{e.name}</option>)}
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
                : completing.product_name} · Received: <b>{fmt.num(receivedQty(completing))} {completing.unit}</b>
              {completing.upstream?.status === 'partially_completed' && (
                <span className="ml-2 font-semibold text-amber-600">
                  so far from {fmt.stage(completing.upstream.stage)} — still counting there
                </span>
              )}
              {completing.extra_issued > 0 && (
                <span className="ml-2 font-semibold text-slate-500">
                  incl. {fmt.num(completing.extra_issued)} extra sheets issued here
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
            {section === 'cutting' && (
              <PlannedBreakup status={breakupStatus} rows={breakupRows} phase={breakupPhase}
                single={{ board_name: completing.board_name, count: completing.children_per_parent || 1,
                          sheets: completing.sheets_issued, sheets_per_packet: completing.sheets_per_packet }} />
            )}
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
              {/* Only in Day-count mode, and only once the stage HAS a log:
                  closing the stage always means the total, and on a first count
                  the two bases are the same figure. */}
              {mode === 'partial' && (
                <BasisToggle basis={entryBasis} onChange={setEntryBasis}
                  unit={completing.unit} prior={priorGood} className="mb-2.5" />
              )}
              <div className="ci-form-grid">
              <Field
                label={mode === 'partial' && basisNow === 'delta'
                  ? `Good ${completing.unit} run now`
                  : priorGood > 0 ? `Counter now — total good ${completing.unit}` : `Actual counter — good ${completing.unit}`}
                required
                hint={mode === 'partial'
                  ? (priorGood <= 0
                      ? 'The shortfall stays pending, not wasted'
                      : basisNow === 'delta'
                        ? `Just this lot — added to the ${fmt.num(priorGood)} already recorded`
                        : `Cumulative, as the counter reads — ${fmt.num(priorGood)} already recorded`)
                  : fullyCounted
                    ? `All ${fmt.num(priorGood)} ${completing.unit} are already on the day log — nothing left to count`
                    : 'Wastage auto-computes from received − counter'}>
                <Input type="number" min="0" value={form.qty_out} onChange={e => setCounter(e.target.value)} autoFocus />
              </Field>
              <Field label={mode === 'partial' ? `Wastage today (${completing.unit}) — optional` : `Wastage (${completing.unit})`}>
                <Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} />
              </Field>
              </div>
              {/* Closing a stage that already has day counts: spell out the
                  split so the operator sees the balance this final adds. */}
              {mode !== 'partial' && priorGood > 0 && form.qty_out !== '' && (
                <CumulativeSummary prior={priorGood} total={+form.qty_out || 0} unit={completing.unit} className="mt-2" />
              )}
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

      {/* Day count straight off the queue row — same engine as the Partial mode
          inside the completion form, without opening it. */}
      <DayCountDialog
        open={!!dayCounting}
        onClose={() => setDayCounting(null)}
        stageId={dayCounting?.id}
        title={dayCounting ? `Day Count — ${dayCounting.jc_number}` : ''}
        subtitle={dayCounting ? <>
          {dayCounting.gang_number
            ? <span className="font-semibold text-violet-700">{dayCounting.gang_number} — one combined count for the whole gang</span>
            : dayCounting.product_name}
          {' · '}Received: <b>{fmt.num(receivedQty(dayCounting))} {dayCounting.unit}</b>
          {/* The figure is live while upstream is still counting, so say so —
              it will rise again the next time that station records a day. */}
          {dayCounting.upstream?.status === 'partially_completed' && (
            <span className="ml-2 font-semibold text-amber-600">
              so far from {fmt.stage(dayCounting.upstream.stage)} — still counting there
            </span>
          )}
          {dayCounting.extra_issued > 0 && (
            <span className="ml-2 font-semibold text-slate-500">
              incl. {fmt.num(dayCounting.extra_issued)} extra sheets issued here
            </span>
          )}
        </> : null}
        variant={isQC ? 'qc' : 'counter'}
        unit={dayCounting?.unit || 'units'}
        expected={dayCounting ? expectedOutput(dayCounting, section) : 0}
        reasons={section === 'sorting' ? SORTING_REJECTION_REASONS : GENERAL_WASTAGE_REASONS}
        operator={pick?.name || ''}
        onSaved={({ good }) => {
          toast.success(`${dayCounting.jc_number} — day count saved: ${fmt.num(good)} today`);
          load();
        }}
      />

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

      <SendBackDialog {...sb.dialogProps} stationLabel={meta.label} />
    </div>
  );
}
