// Planning — the CI-Production planning engine, distilled.
// Open a line → the engine auto-fills spec + cut plan from the masters,
// shows the board position with committed demand and incoming supply, smart-
// matches warehouse stock when the exact board is short, and locks the plan.
// Press + date live in Print Planning. Shortfall raises a PR without leaving
// the modal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { ActionMenu, Button, Checkbox, ConfirmDialog, DataTable, Field, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, odDays, OutputChip, OverdueDays, PageHeader, PlanSavedBadge, SearchableSelect, searchText, Select, ShadeAge, StatusBadge, Tabs, Textarea, useKpiFilter, useToast, WipChip } from '../components/ui.jsx';
import { BookmarkCheck, CheckCircle2, Check, Wrench, AlertTriangle, Box, PackageSearch, Truck, BookOpen, Palette, Layers, PackageCheck, PauseCircle, ShieldCheck, ShieldQuestion, Scissors, Sparkles, Square, Warehouse, NotebookPen, RotateCcw, Undo2, Link2, Lock, Plus, X, ChevronDown, ChevronRight, Printer, Hash, Zap } from 'lucide-react';
import WorkflowControls, { BulkWorkflowControls } from '../components/WorkflowControls.jsx';
import WarehousePicker, { clientFit } from '../components/WarehousePicker.jsx';
import { clientStrips, chosenCutsValid, chosenStrips } from '../lib/cutFit.js';
import { sharedRunFigures } from '../lib/gangRunMath.js';
import { GangChip, GangCreatedSheet, GangCellParts } from '../components/Gang.jsx';
import { MergeChip, MergeCreatedSheet } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import BoardCommitments from '../components/BoardCommitments.jsx';
import BoardMix, { mixTotals } from '../components/BoardMix.jsx';
import PacketAdvice from '../components/PacketAdvice.jsx';
import ShortagePanel from '../components/ShortagePanel.jsx';
import { DEFAULT_MIX_REASON, mixPosition, rowCovers, smartSeedRow, substitutionFlags } from '../lib/boardMix.js';
import { boardPositionView } from '../lib/boardPositionView.js';
import { parseBoardName } from '../lib/boardCode.js';
import { TrafficLight, ReadinessPopover } from '../components/Readiness.jsx';
import { SET_TYPE_META, SetTypeChip, rowSetType, holdReasonOf } from '../components/SetType.jsx';
import { PLANNING_HOLD_REASONS, PLANNING_HOLD_DEFAULT } from '../sections.js';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BOARD_FULL, BOARD_RANK, BOARD_ROW_CLASS, BoardBadge, rowBoardStateOf } from '../components/BoardStatus.jsx';
import PlateStatus from '../components/PlateStatus.jsx';
// Printing colour + process shares the same one-vocabulary rule — see PrintColour.jsx.
import { PrintColourChips, colourSummary, colourSearchText, colourTypeOf, processOf,
         totalColoursOf, printColourWarnings } from '../components/PrintColour.jsx';
import { Claimants, StockSplit } from '../components/BoardClaims.jsx';
import { customerInitials, customerSearchText } from '../lib/customerCode.js';
import { canPlan } from '../modules.js';

const DEFAULT_WASTAGE_SHEETS = 200;

// The packet-choice key for a line with NO mix, whose advice is against the
// whole cut plan rather than any one board row. Every other key in that map is
// a material_id (a number), so a string sentinel cannot collide with one.
const PACKET_SINGLE = '_plan';

// Rows behind the clickable Planning cards. These take a GROUPED row, so a gang
// is judged as the single job it will actually be: ready only when every member
// is green, late when any member is past its date — the same "weakest member
// decides" rule boardShort() uses.
const PLAN_KPI_ROWS = {
  ready: r => (r._gang || [r]).every(m => m.light?.light === 'green'),
  // Customer WIP — any member urgent makes the run urgent (it prints as one).
  wip: r => (r._gang || [r]).some(m => m.wip),
};
const PLAN_KPI_LABEL = {
  ready: 'jobs with every gate green',
  wip: 'jobs the customer marked WIP (urgent)',
};
// What each board card is showing, in the words the filter notice uses.
const BOARD_FILTER_LABEL = {
  covered: 'jobs whose stock is OK',
  on_order: 'jobs with stock pending on a PR',
  short: 'jobs short of stock with no PR',
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

// The colour scheme — coating and ink — reads as part of what the carton IS,
// so it sits under the product rather than in a spec column of its own. Folded
// on the gang: a run shares ONE sheet, so members that disagree say "mixed"
// rather than quietly reporting the first one's ink.
function ColourScheme({ line }) {
  const lead = gangLead(line);
  const mixed = specCell(line, colourTypeOf).mixed || specCell(line, processOf).mixed;
  const coat = specCell(line, coatingOf, fmt.title);
  const summary = colourSummary(lead);
  const hasInk = colourTypeOf(lead) || lead.print_process;
  if (!coat.text && !coat.mixed && !mixed && !hasInk) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-4">
      <SpecText line={line} pick={coatingOf} format={fmt.title}
        className="whitespace-nowrap text-[11px] font-semibold text-slate-600" />
      {mixed
        ? <span className="text-[11px] font-bold uppercase tracking-wide text-violet-500">mixed ink</span>
        : hasInk ? (
            // The chip already names the ink and the line above already ends in
            // "· 4c", so spelling out "CMYK — 4 colours" beside them was the
            // same fact a third time — and it was the line that pushed every
            // row 20px taller. It stays as the chip's title.
            <span title={summary}><PrintColourChips row={lead} compact /></span>
          ) : null}
    </div>
  );
}

// When the order was booked and how far past due it is — one line under the PO
// it belongs to, rather than the two columns it used to cost. A run booked
// across a month still shows its spread; a line with no date shows nothing at
// all rather than a dash, because an empty line here is quieter than a filler.
// One horizontal gutter for every column on this board. The table's default is
// px-2; at this density that reads as columns touching, and padding a single
// seam by hand only makes that seam the odd one out.
const PLAN_CELL = 'px-2.5';

// The searchable text behind those columns — every member's raw value, so a
// search for a coating or a board still finds the gang that contains it even
// when the cell itself reads "mixed".
const specSearch = (line, pick) => (line._gang || [line]).map(m => pick(m) ?? '').join(' ');

// The PO a row answers for. A single line has its own; a gang answers for its
// OLDEST member, because the run is as overdue as the longest-waiting order in
// it — sorting by OD then floats the run that has kept a customer waiting most.
// `latest` is set only when the members were booked on different days, so the
// PO Date cell shows a span exactly when there is one.
const poAgeOf = line => {
  const ds = [...new Set((line._gang || [line]).map(m => m.po_date).filter(Boolean))].sort();
  return {
    date: ds[0] ?? null,
    latest: ds.length > 1 ? ds[ds.length - 1] : null,
    days: odDays(ds[0]),
    count: ds.length,
  };
};

// 'none' is how the master records an uncoated carton. Reading it back as the
// word "None" makes an uncoated job look like it carries a coating called None.
const coatingOf = m => (m.coating && m.coating !== 'none' ? m.coating : null);

// The member a folded gang row speaks for when its members AGREE. Only ever
// read after specCell has confirmed they do — otherwise the cell says "mixed".
const gangLead = line => (line._gang || [line])[0] || line;

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

// What a die NUMBER actually means: the sheet size the die is built for, and how
// many cartons it blanks out of that sheet. Both come off the die's own rack
// record in Tooling — all 287 live dies carry an ups and all but two a sheet
// size — so the planner reads "which die" and "what it does" without leaving the
// queue.
//
// The die's TYPE deliberately does NOT appear here. The Tooling Hub migration
// titled 273 of those dies "Cutting Die" and the rest with the product's own
// name, so the type line was either noise or a copy of the Product column. The
// size and the ups are the two facts the number was hiding.

// The die's sheet size in ONE spelling. Tooling stores it hand-typed — "14X22",
// "15.75x20.75", "16 x 22" are three spellings of one fact — so it is normalised
// exactly as sizeOf normalises the carton column above. Without this the
// column's width is set by whichever die was typed with the most spaces.
const dieSheetOf = m => {
  const raw = String(m.die_sheet_size ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*(?:x|X|×|\*)\s*/).map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.join('x') : raw;
};

// The plant's word for how many cartons come off one sheet. A 1-up die is "1 up",
// not "1 ups" — the column is read all day and the wrong plural is the kind of
// thing that makes a screen look untended.
const dieUpsOf = m => {
  const n = Number(m.die_ups) || 0;
  return n > 0 ? `${n} up${n === 1 ? '' : 's'}` : null;
};

// Both facts as one string: what a folded gang row folds on (so "mixed" is
// decided once, for the pair), what Export writes, and what search indexes. The
// CELL renders the two parts as separate spans instead of printing this string,
// so the size can carry the monospace weight its digits need while the ups reads
// as a label — see the Die column.
const dieDetailOf = m => [dieSheetOf(m), dieUpsOf(m)].filter(Boolean).join(' · ') || null;

// Readiness gates on one line: a single "Ready" pill when all pass, otherwise
// compact icon chips (green = cleared, grey = pending, red = material short,
// amber = short but a PR/PO is on order — the job may proceed, board awaited).
function ReadinessCell({ readiness, light }) {
  // Under a mix the shortfall lives across the rows, not on the planned board:
  // asking parent_needed - available_sheets there reported the planned board's
  // own gap while the real hole sat on an emptied substitute. mix_short is the
  // summed truth; the single-board subtraction stays for jobs without a mix.
  const short = readiness.material ? 0
    : readiness.mix_active ? Math.max(0, Math.round(readiness.mix_short || 0))
    : Math.max(0, readiness.parent_needed - readiness.available_sheets);
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

// Tiny label/value line for a modal's ledger body — Master / Using / Covers /
// Pending after in Smart Match's mix-seed confirm below.
function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 font-semibold text-slate-700">{k}</span>
      <span className="min-w-0 text-right text-slate-900">{v}</span>
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

// The extra fact a suggestion chip carries past its headline — the carton a
// board group all shares, or the board a carton group all sits on. Amber when
// it is a decision the planner still has to make (more than one board).
function SuggestTag({ tone, children }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold ${tone === 'amber'
      ? 'bg-amber-100 text-amber-700' : 'bg-violet-100 text-violet-700'}`}>{children}</span>
  );
}

// One axis of the gang-opportunity strip: label, chips, and the reason this
// axis shares a press. Both bands use the same geometry so the chip rows line
// up under one another. Only three chips show — the tail is one click away
// rather than silently dropped, because "3 shown" reads as "3 exist".
function GangSuggestBand({ icon, label, note, items, chip, onPick, className = '' }) {
  const [all, setAll] = useState(false);
  const SHOWN = 3;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <span className="flex min-w-[108px] items-center gap-1.5 text-xs font-bold text-violet-800">
        {icon} {label}
      </span>
      {(all ? items : items.slice(0, SHOWN)).map(s => (
        <button key={s.key ?? `${s.board_material_id}|${s.coating}`} type="button" onClick={() => onPick(s)}
          className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100">
          {chip(s)}
        </button>
      ))}
      {items.length > SHOWN && (
        <button type="button" onClick={() => setAll(a => !a)}
          className="text-[11px] font-bold text-violet-500 underline-offset-2 hover:underline">
          {all ? 'Show less' : `+${items.length - SHOWN} more`}
        </button>
      )}
      <span className="text-[11px] text-violet-400">{note}</span>
    </div>
  );
}

const CATEGORY_STYLE = {
  exact: 'bg-emerald-50 text-emerald-700',
  near: 'bg-amber-50 text-amber-700',
  alternate: 'bg-violet-50 text-violet-700',
};
// Smart Match only ever offers the SAME grade now (smartmatch.js keeps Saffire
// on Saffire and FBB on FBB), so these three describe the WEIGHT gap and
// nothing else. 'Alternate' used to mean a different family, which is why the
// third one is named for what it actually is.
const CATEGORY_LABEL = { exact: 'Exact', near: 'Near', alternate: 'Off GSM' };

export default function Planning() {
  const toast = useToast();
  const [lines, setLines] = useState([]);
  const [planLine, setPlanLine] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [boardSel, setBoardSel] = useState(null); // effective board for this plan (may be a warehouse pick)
  const [boardHist, setBoardHist] = useState([]); // previous selections, newest last — powers Undo
  const [mixRows, setMixRows] = useState([]); // Board Mix draft — {material_id, sheets, ups, ...} rows
  // Which mix rows bank their strip, keyed by material_id. Session state like
  // the rows themselves: reset wherever mixRows reset, and reopening a saved
  // plan seeds it from the saved v2 leftover_plan so the toggles show what is
  // actually banked rather than defaulting everything back on. Holds only the
  // planner's EXPLICIT choices — a row absent here follows the chip's own
  // default (ON while its reduced cut leaves a usable strip), which is why the
  // payload derives the effective state per row instead of reading this raw.
  const [mixLeftovers, setMixLeftovers] = useState({});
  // Which packet-picking option the planner picked, keyed by material_id — the
  // per-board case — plus PACKET_SINGLE for a line with no mix at all, whose
  // advice is against the whole cut plan rather than any one row.
  //
  // SESSION-ONLY, deliberately, and reset wherever mixRows reset. The agreed
  // home for it is order_lines.spec_override (the design's "Choosing an option"
  // section), which needs a plan-save payload change; the picking hint is
  // already worth having read-only, so that is its own task. Nothing here is
  // issued at plan time either way — the requirement and the issued figure are
  // untouched by the choice, which is the whole reason the panel is advice.
  const [packetChoice, setPacketChoice] = useState({});
  const [gangPacketChoice, setGangPacketChoice] = useState({});
  const [form, setForm] = useState({ qty: '', ups: '', wastage_sheets: '', colors: '', colour_type: '', print_process: '', cmyk_colours: '', pantone_colours: '', pantone_codes: '', metallic_colours: '', metallic_details: '', print_instructions: '', pasting_type: '', coating: '', emboss: '0', leafing: '0', leafing_colour: '', child_l: '', child_w: '', parent_l: '', parent_w: '', party_artwork_code: '', output_number: '', die_number: '', block_number: '', notes: '' });
  const [lo, setLo] = useState({ push: false, strip: null }); // leftover offcut → warehouse decision
  const [prBusy, setPrBusy] = useState(false);
  const [prView, setPrView] = useState(null);    // inline PR tracker (chip click)
  const [stockBooking, setStockBooking] = useState('book'); // whose stock this plan runs on — 'book' | 'fresh_pr'
  const [sbBusy, setSbBusy] = useState(false);   // stock-booking toggle in flight
  const [dupPr, setDupPr] = useState(null);      // duplicate-PR confirmation { existing, count, add_qty, reason }
  const [gangPrBusy, setGangPrBusy] = useState(false);
  const [gangSbBusy, setGangSbBusy] = useState(false); // run stock-booking toggle in flight
  const [gangDupPr, setGangDupPr] = useState(null); // gang already covered { existing[], incoming, reason }
  const [whOpen, setWhOpen] = useState(false);
  const [boardPanel, setBoardPanel] = useState(false);
  // The result of a board move, held only for this session. board_allocations
  // has no 'move' source (db.js:1914), so a moved-in hold is indistinguishable
  // from ordinary stock after a reload — better to forget than to guess wrong.
  const [lastMove, setLastMove] = useState(null);
  const [smart, setSmart] = useState(null);      // smart-match results for the current shortage
  const [smartAll, setSmartAll] = useState(false);
  const [consumeLot, setConsumeLot] = useState(null); // { lot, qty } — confirm FG consumption
  const [fgUse, setFgUse] = useState(null); // "Use FG Stock" popup straight from the queue
  const [masterPrompt, setMasterPrompt] = useState(null); // { changed: {...} }
  const [mixConfirm, setMixConfirm] = useState(null); // { rows: [...] } — Lock Plan's end-of-flow mix confirm
  const [lockShortConfirm, setLockShortConfirm] = useState(null); // { short, free, parent } — soft gate: lock a SHORT plan out loud, never silently
  const [gangLockShortConfirm, setGangLockShortConfirm] = useState(null); // the run-level twin — { short, free }
  // Smart Match's Use — consented seeding into the mix (board-mix wave, Task
  // 8). { match, kind: 'mix' | 'swap' } | null — 'mix' seeds a substitute row
  // behind a coverage preview, 'swap' keeps pickBoard's whole-board-swap
  // semantics behind its own confirm (a different grade would 409 the mix).
  const [smartConfirm, setSmartConfirm] = useState(null);
  const [reverseConfirm, setReverseConfirm] = useState(false); // form-level "Reverse Plan" confirm
  const [reverseBusy, setReverseBusy] = useState(false);
  // "Discard saved plan" — the inverse of Save, for a plan saved but never
  // locked. { line, rows | null } — rows is the SAVED mix (what the discard will
  // hand back), null while it is still being fetched. Reachable from the queue
  // row's ⋯ and from the engine footer, so it is page-level state, not engine
  // state: the row menu opens it with no engine on screen.
  const [discardAsk, setDiscardAsk] = useState(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const canPlanRole = canPlan(auth.user);
  const [selectedIds, setSelectedIds] = useState([]);
  const [tab, setTab] = useState('pending');
  const [subTab, setSubTab] = useState('all'); // set-type zone: 'all'|'single'|'gang'|'hold' — opens with the complete To Plan queue
  // "Plan saved" — a SEPARATE filter axis from the zone chips above, not a
  // fifth zone: the zones are mutually exclusive set-types (a job is Single or
  // Gang, never both), while a saved plan cuts across all of them. Folding it
  // into subTab would have destroyed that exclusivity.
  const [draftOnly, setDraftOnly] = useState(false);
  const [holdAsk, setHoldAsk] = useState(null);   // { rows, pick, reason } — "Why is this on hold?" prompt; pick is the dropdown, reason the free text 'Other' collects
  const [holdBusy, setHoldBusy] = useState(false);
  const [boardFilters, setBoardFilters] = useState([]);   // subset of 'covered'|'on_order'|'short'; empty = all
  const [gangSel, setGangSel] = useState(null);     // lines being reviewed in the create-gang modal
  const [gangBusy, setGangBusy] = useState(false);
  const [gangView, setGangView] = useState(null);   // fetched gang detail — drives the ONE unified Gang Engine
  const [gangEdits, setGangEdits] = useState({});   // per-member draft { [lineId]: { qty, ups } } in the gang engine
  const [gangWastage, setGangWastage] = useState(String(DEFAULT_WASTAGE_SHEETS)); // shared wastage in the gang engine
  const [gangIssue, setGangIssue] = useState(''); // planner's manual "sheets to issue" override ('' = follow the calc)
  const [gangMixRows, setGangMixRows] = useState([]); // the RUN's Board Mix draft — one row per board, run-level sheets
  // Per-row leftover toggles for a MERGE run's mix — {[material_id]: bool},
  // seeded from the live LO-PLAN-RUN batches (the batches ARE the record; no
  // JSON column on gang_runs, by design) and reset whenever the mix rows
  // reseed. A gang-kind run never banks, so this stays empty noise for it.
  const [gangLeftovers, setGangLeftovers] = useState({});
  const [gangWhOpen, setGangWhOpen] = useState(false); // gang board Warehouse picker open (manual)
  const [gangSmart, setGangSmart] = useState(null);  // smart-match board suggestions (null = closed)
  const [gangExpand, setGangExpand] = useState(null); // line id whose full spec panel is open
  const [gangSpecForm, setGangSpecForm] = useState(null); // per-product identity draft in the expander
  const [gangSheetForm, setGangSheetForm] = useState({ child_l: '', child_w: '', coating: '' }); // unified gang sheet lock (child + coating)
  const [gangNumbers, setGangNumbers] = useState({ output_number: '', die_number: '' }); // the RUN's own plate + die number
  const [gangNumBusy, setGangNumBusy] = useState(false);
  const [gangReverseOpen, setGangReverseOpen] = useState(false); // reverse confirm
  const [gangSheetPrompt, setGangSheetPrompt] = useState(null); // master-update popup for the gang sheet lock
  const [gangBusyLock, setGangBusyLock] = useState(false); // Lock Gang Plan in flight
  const [gangBusySave, setGangBusySave] = useState(false); // Save Run Plan (draft) in flight
  const [gangDiscardAsk, setGangDiscardAsk] = useState(null); // { run, rows } — run-level unsave confirm
  const [gangDiscardBusy, setGangDiscardBusy] = useState(false);
  const [engineFromGang, setEngineFromGang] = useState(null); // gang_run_id to reopen after the single-product engine closes
  const [gangAddable, setGangAddable] = useState(null); // eligible lines picker (null = closed)
  const [gangAddSel, setGangAddSel] = useState([]);  // ids chosen to add
  const [gangSuccess, setGangSuccess] = useState(null); // freshly created gang → UPI-style confirmation sheet
  const [gangConvertBusy, setGangConvertBusy] = useState(false); // same-carton gang → Combined Run, in flight
  const [suggestions, setSuggestions] = useState([]);
  const [hideSuggest, setHideSuggest] = useState(false);
  const [suggestExpanded, setSuggestExpanded] = useState(false); // '+N more' opens the full list in place
  const [approvals, setApprovals] = useState({});   // order_line_id → latest management ask (chips + menu state)
  const [askMgt, setAskMgt] = useState(null);       // { line, note } — "Ask Management Approval" popup
  const [askBusy, setAskBusy] = useState(false);
  const [specOpts, setSpecOpts] = useState({ coating: [], special: [], colour_type: [], pasting_type: [], leafing_colour: [] }); // distinct master values → engine pickers
  // Every board in the master, for the Board Identity picker. The Warehouse
  // modal answers "what is on the shelf"; this answers "which board is this
  // product", which is a master question and has no business behind a modal.
  const [boards, setBoards] = useState([]);
  const [commitBusy, setCommitBusy] = useState(false); // commit/uncommit in flight
  // Bumped whenever a hold is taken or given back. Smart Match quotes every
  // candidate's free/committed figures, and a commit on one of them changes
  // numbers this line's own position never sees — without this the strip would
  // keep showing the stock it had a moment ago.
  const [boardRev, setBoardRev] = useState(0);
  // ── Commit / uncommit: ask first, then remember what was done ─────────────
  // The confirm every commit and release now routes through — Board Position's
  // pair and every Smart Match row alike. Holding board is a decision other
  // planners feel (their free stock shrinks by exactly this much), and it used
  // to happen on one unguarded click.
  //
  // { kind: 'commit' | 'uncommit', materialId, name, qty, add?, undo? } | null.
  // `qty` is the END STATE — what the job will hold after a commit, what it
  // holds before a release — because that is the number the server works in
  // (POST /board/commit holds the DIFFERENCE). `add` is the increment when the
  // caller knows it. `undo` marks the action as the reversal of `lastCommit`,
  // so completing it clears the trail instead of starting an undo-of-undo.
  const [commitConfirm, setCommitConfirm] = useState(null);
  // What THIS engine session has committed, per board — {[material_id]: qty},
  // taken from /board/commit's own `held_for_line`.
  //
  // Scope, stated plainly: session state. A reload forgets it, and it speaks
  // only for holds taken from this panel. It exists because a Smart Match row
  // cannot answer "what does THIS job hold on that board" — the row's
  // `claimants` are built from OTHER lines and its `committed` is the whole
  // claim on the shelf — so without it there is no honest way to offer
  // Uncommit beside Commit on a row. The Board Position panel remains the
  // authoritative view of held_for_me for the SELECTED board; nothing here
  // invents a server field.
  const [heldHere, setHeldHere] = useState({});
  // Smart Match used to vanish the instant a commit cleared the shortage that
  // opened it — the planner's own action deleting the list they were working
  // down, mid-decision. Set on any successful commit or release, it keeps the
  // panel on screen for the rest of this line's session.
  const [smartPinned, setSmartPinned] = useState(false);
  // The last commit/release, for Undo — { kind, materialId, name, qty } | null.
  const [lastCommit, setLastCommit] = useState(null);
  const smartSeq = useRef(0);

  const load = () => Promise.all([
    api.get('/planning').then(setLines),
    api.get('/gang-suggestions').then(setSuggestions).catch(() => {}),
    api.get('/approvals/by-line').then(setApprovals).catch(() => {}),
  ]);
  useEffect(() => { load(); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });
  useEffect(() => { api.get('/spec-options').then(setSpecOpts).catch(() => {}); }, []);
  useEffect(() => {
    api.get('/materials')
      .then(ms => setBoards(ms.filter(m => m.category === 'board' && m.active !== 0)))
      .catch(() => {});
  }, []);
  const pending = lines.filter(l => l.status === 'pending');
  const planned = lines.filter(l => ['planned', 'ready'].includes(l.status));
  // Completed = pushed onward to a job card (left the planner's active queue).
  const completed = lines.filter(l => l.status === 'in_production');
  // "All" shows every planning state at once (To Plan + Planned + Completed).
  const tabLines = { pending, planned, completed, all: lines }[tab] || pending;
  // A gang collapses into ONE row: the anchor line carries `_gang` (all member
  // lines, in id order) and a synthetic id so it never collides with a line id.
  const tabGrouped = (() => {
    const out = [];
    const seen = new Set();
    for (const r of tabLines) {
      if (!r.gang_run_id) { out.push(r); continue; }
      if (seen.has(r.gang_run_id)) continue;
      seen.add(r.gang_run_id);
      const members = tabLines.filter(x => x.gang_run_id === r.gang_run_id);
      out.push(members.length > 1 ? { ...r, id: `gang-${r.gang_run_id}`, _gang: members } : r);
    }
    return out;
  })();
  // The set-type zone narrows the tab AFTER gang collapse — a run must land in
  // one zone whole, never split across two (same reason board state collapses
  // after grouping). Everything below — KPI strip, board counts, suggestions,
  // the table — describes the ZONE, so no number on the page disagrees with
  // the list beside it; the tab badges above keep whole-tab counts and the
  // sub-chips carry the zone counts.
  const zoneCounts = (() => {
    const c = { all: tabGrouped.length, single: 0, gang: 0, new_output: 0, hold: 0 };
    for (const r of tabGrouped) c[rowSetType(r)]++;
    return c;
  })();
  const zoneRows = subTab === 'all' ? tabGrouped : tabGrouped.filter(r => rowSetType(r) === subTab);
  // A saved-but-unlocked plan, off the server's ONE rule (plan_draft: still in
  // To Plan AND already carrying a written parent requirement). A gang row is
  // draft when ANY member is — the run collapses to one row, and one member's
  // saved work is still work saved that the planner may want to find.
  const rowDraft = r => (r._gang || [r]).some(m => !!m.plan_draft);
  // Counted on the ZONE, before the filter narrows it, so the chip says how
  // many of the rows in front of the planner it would keep. Outside To Plan the
  // count is 0 by construction (plan_draft needs status 'pending'), which is
  // what hides the chip there.
  const draftCount = zoneRows.filter(rowDraft).length;
  // Narrowed HERE, where the zone is applied, so the KPI strip, the board
  // counts, the suggestions and the table all keep describing one and the same
  // set — the invariant the comment above depends on. `&& draftCount` means a
  // filter left on cannot outlive the rows it filtered: when the last draft in
  // view is locked the chip disappears and the queue comes back, instead of
  // stranding the planner on an empty table with no visible control to clear.
  const groupedRows = draftOnly && draftCount ? zoneRows.filter(rowDraft) : zoneRows;
  // The zone's LINES (gang rows unfolded) — feeds the KPI strip and the
  // suggestion filter, exactly what `shown` meant before zones existed.
  const shown = groupedRows.flatMap(r => (r._gang ? r._gang : [r]));
  // Gang-zone stacks — how many zone rows share one board · GSM · coating.
  // Drives the zone's groupBy: only keys with company (>1) become a stack.
  const gangStackKey = l => `${l.board_name || 'no board'}|${l.gsm || '—'}|${l.coating || '—'}`;
  const gangStacks = (() => {
    const m = new Map();
    if (subTab === 'gang') for (const r of groupedRows) m.set(gangStackKey(r), (m.get(gangStackKey(r)) || 0) + 1);
    return m;
  })();
  // Board state — ONE three-state verdict per job, computed on the server so
  // Planning, the Print Planning triage and the floor cannot disagree:
  //   covered   board is here: warehouse stock, an alternate/mixed board, or
  //             board moved to this job from another
  //   on_order  a PR names this job and the board is still coming
  //   short     nobody covered it and nobody ordered it
  // They partition the queue — every job is in exactly one, so the counts add
  // up to All and no job is chased twice. A gang takes its WEAKEST member's
  // state (the run cannot go on press with one member's board missing), and it
  // is evaluated AFTER grouping because filtering members would split a run
  // that must move as one.
  // The collapse comes from BoardStatus.jsx so it cannot drift from the badge
  // or from the Artwork queue — this page used to hand-roll the same
  // map/reduce over BOARD_RANK a second time. Only the FALLBACK is this page's
  // own: a Planning row carries `readiness`, so a payload served mid-deploy
  // without board_state still reads its board gate rather than defaulting to
  // covered, which on the one screen that can FIX a short job would hide it.
  const boardGate = m => (m.readiness?.material ? 'covered' : 'short');
  const rowBoardState = r => rowBoardStateOf(r, boardGate);
  const boardShort = r => rowBoardState(r) !== 'covered';   // the KPI card's "short" = anything unresolved
  // The same red wash the Artwork queue wears, on the same two verdicts, out of
  // the same CSS — a job short of board has to look identical wherever a planner
  // meets it. It sits UNDER the readiness light rather than instead of it: the
  // light is the composite verdict (artwork, tooling, shade, board) and is
  // untouched, while the wash names the one gate that is the planner's to close
  // from this screen.
  //
  // A job still waiting to be planned NEVER washes, whatever its board says.
  // Measured on live data before shipping: 61 of the 72 lines in To Plan read
  // short, because nobody has allocated or bought board for a job nobody has
  // planned yet — that is the normal state of that tab, not an alarm, and
  // colouring 85% of it red would have made the wash the background instead of
  // the warning. Red here means "this WAS planned and still has no board",
  // which is 3 of 5 on Planned and 2 of 50 on Completed. Keyed off the row's
  // status rather than the open tab, so All agrees with the two tabs it
  // aggregates instead of contradicting them. To Plan keeps the board KPI
  // cards and the board filter it already had — the count is still there to
  // click, it just is not shouted.
  const boardRowClass = r => ((r._gang || [r]).some(m => m.status !== 'pending')
    ? BOARD_ROW_CLASS[rowBoardState(r)] : '');
  const countOf = k => groupedRows.filter(r => rowBoardState(r) === k).length;
  const coveredCount = countOf('covered');
  const onOrderCount = countOf('on_order');
  const shortCount = countOf('short');
  // Readiness is the OTHER filter axis, and it runs after the board one, on
  // GROUPED rows for the same reason board coverage does: a gang goes to press
  // as one job, so it is ready only when every member is. The three board cards
  // are not in here — they drive boardFilters directly, so board is never
  // filtered from two places at once.
  const planKpi = useKpiFilter(tab, { multi: true });
  const boardRows = boardFilters.length === 0 ? groupedRows
    : groupedRows.filter(r => boardFilters.includes(rowBoardState(r)));
  const displayRows = planKpi.apply(boardRows, PLAN_KPI_ROWS);
  // Every card toggles independently and stays lit until clicked again. The
  // three board cards PARTITION the queue, so within that axis selection is a
  // UNION (covered + short shows both piles; intersecting partition states
  // could only ever be empty). Across axes it is an INTERSECTION — Stock Short
  // AND Customer WIP is "urgent jobs still needing board", which is the whole
  // point of combining. "Jobs in Queue" is the way back to everything, and one
  // notice reports every active card and clears them together.
  const toggleBoardFilter = key => {
    setBoardFilters(cur => (cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]));
    clearSelection();
  };
  const clearAllFilters = () => { setBoardFilters([]); planKpi.clear(); clearSelection(); };
  const activeFilterLabels = [
    ...boardFilters.map(k => BOARD_FILTER_LABEL[k]),
    ...planKpi.keys.map(k => PLAN_KPI_LABEL[k]),
  ];
  const anyFilter = activeFilterLabels.length > 0;

  // KPI strip — counts follow whatever the thing beside them counts, or the
  // planner stops believing both. Job/carton/readiness figures run over the
  // ZONE's lines (tab, then set-type sub-chip), matching the list below — the
  // tab badges above keep whole-tab counts; the board figures run over
  // groupedRows through the SAME rowBoardState() the board chips use, so a gang is
  // one job in the strip exactly as it is in the chip. Deliberately NOT
  // filtered by boardFilters: the strip describes the whole tab and the cards
  // drill into it — a Stock Short card that only counted the board-short filter
  // would just be restating its own filter.
  const kpiPlan = (() => {
    const rows = shown;
    const lit = k => rows.filter(l => l.light?.light === k).length;
    // Same arithmetic as ReadinessCell, so the queue's red "−725" on a row and
    // the strip's total are the same number counted the same way.
    const shortOf = l => (l.readiness && !l.readiness.material
      ? Math.max(0, (+l.readiness.parent_needed || 0) - (+l.readiness.available_sheets || 0)) : 0);
    // Every unresolved job (short + on order) — the sheet gap procurement is
    // still carrying, whether or not a PR has been written for it yet.
    const shortRows = groupedRows.filter(boardShort);
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
      wip: groupedRows.filter(PLAN_KPI_ROWS.wip).length,
      // Sheets still to find across every unresolved job, ordered or not.
      shortSheets: shortRows.flatMap(r => r._gang || [r]).reduce((s, m) => s + shortOf(m), 0),
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
  // Set-type retag — one call per ROW; the server fans a gang out to every
  // member via any one id (the run moves as one). The per-row dropdown and the
  // bulk bar share THIS path, so a tag applied to seven rows is the same write
  // seven times, never a second rule. Hold routes through the reason prompt
  // first; cancel there and nothing was written.
  const saveSetTypes = async (rows, set_type, hold_reason) => {
    try {
      await Promise.all(rows.map(row =>
        api.patch(`/planning/${(row._gang ? row._gang[0] : row).id}/set-type`, { set_type, hold_reason })));
      const what = rows.length === 1
        ? (rows[0]._gang ? `${rows[0].gang_number} — all ${rows[0]._gang.length} jobs` : rows[0].product_name)
        : fmt.count(rows.length, 'job');
      toast.success(set_type === 'hold' ? `${what} on hold` : `${what} → ${SET_TYPE_META[set_type].label}`);
      setHoldAsk(null);
      clearSelection();
      load();
    } catch (e) { toast.error(e.message); }
  };
  const setTypeMenuItems = row => {
    const cur = rowSetType(row);
    // A ganged row never offers Single — it physically shares a sheet.
    const opts = (row.gang_run_id ? ['gang', 'hold'] : ['single', 'gang', 'new_output', 'hold']).filter(k => k !== cur);
    return opts.map(k => ({
      key: k, label: `Move to ${SET_TYPE_META[k].label}`, icon: SET_TYPE_META[k].icon,
      onClick: () => (k === 'hold' ? setHoldAsk({ rows: [row], pick: PLANNING_HOLD_DEFAULT, reason: '' }) : saveSetTypes([row], k)),
    }));
  };
  // What actually gets stored as the hold reason: the picked option, or what
  // the planner wrote when they picked 'Other'. Empty means the prompt is not
  // answered yet, which is what disables the button — so 'Other' with a blank
  // box refuses exactly as a blank free-text reason always did.
  const holdReasonText = ask => (ask?.pick === 'Other' ? (ask.reason || '').trim() : (ask?.pick || ''));

  // The bulk bar tags one write per JOB, not per line: selected gang members
  // collapse to one anchor (the server fans the run out anyway), so "3 jobs →
  // Gang" means three, not three-plus-echoes.
  const selectedRowAnchors = (() => {
    const seen = new Set(); const out = [];
    for (const l of selectedLines) {
      const k = l.gang_run_id ? `g${l.gang_run_id}` : `l${l.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out;
  })();

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
    // lastMove belongs to the line it was made on. Carrying it into the next
    // line would tell that planner "N sheets moved in" over a job that never
    // received any, with a live "Move it back" beside it.
    setPlanLine(l); setCtx(null); setSmart(null); setSmartAll(false); setBoardHist([]); setLastMove(null);
    // The commit session belongs to the line it was made on, exactly like
    // lastMove above: heldHere would otherwise offer Uncommit on a board the
    // NEXT job never touched, the pin would hold a panel open over a fresh
    // shortage that never produced it, and Undo would offer to release
    // somebody else's hold. openPlan is the one place the engine resets for a
    // new line — savePlan/dismissEngine only null planLine on the way OUT, and
    // applyGangBoard clears boardHist without changing line, so the holds it
    // leaves standing are still this job's and stay remembered.
    setSmartPinned(false); setLastCommit(null); setHeldHere({}); setCommitConfirm(null);
    setStockBooking(l.stock_booking || 'book');
    setBoardSel({ id: l.board_material_id, name: l.board_name, sheet_l: l.sheet_l, sheet_w: l.sheet_w });
    setForm({
      qty: String(l.qty ?? ''),
      ups: String(l.ups),
      wastage_sheets: String(l.wastage_sheets ?? DEFAULT_WASTAGE_SHEETS),
      colors: String(l.colors ?? ''), colour_type: l.colour_type || '', pasting_type: l.pasting_type || '', coating: l.coating || '',
      print_process: l.print_process || '',
      cmyk_colours: l.cmyk_colours != null ? String(l.cmyk_colours) : '',
      pantone_colours: l.pantone_colours != null ? String(l.pantone_colours) : '',
      pantone_codes: l.pantone_codes || '',
      metallic_colours: l.metallic_colours != null ? String(l.metallic_colours) : '',
      metallic_details: l.metallic_details || '',
      print_instructions: l.print_instructions || '',
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
    // Seed the Board Mix draft from whatever is already saved for this line.
    // Severity and the differing-cuts flags come from the LIVE candidate list
    // when the saved board is still in it — this runs strictly AFTER the ctx
    // fetch resolves (same `d`, same async frame), so there is no load race to
    // guard — which keeps the "cuts N up natively" note and the severity-driven
    // fields identical between a fresh row and a reopened one. A saved board
    // the candidates no longer offer (stock ran dry) falls back to the old
    // generic 'warn', exactly as every reopened row used to.
    const candById = new Map((d?.mix?.candidates || []).map(c => [c.id, c]));
    setMixRows((d?.mix?.rows || []).map(r => {
      const c = r.role === 'planned' ? null : candById.get(r.material_id);
      return {
        material_id: r.material_id, board_name: r.board_name, ups: r.ups, sheets: r.sheets,
        stock_batch_id: r.stock_batch_id, reason: r.reason || '',
        severity: r.role === 'planned' ? 'none' : (c?.severity ?? 'warn'),
        ...(c ? { gsm_delta: c.gsm_delta, ups_differ: c.ups_differ, size_differs: c.size_differs } : {}),
        // Carried through, or the panel's own over-allocation warning is dead on
        // every REOPENED plan: it is guarded by `r.available != null`, and a row
        // rebuilt without the field silently never trips it. That is how live
        // line 128 showed 'Fully covered ✓' over a board holding nothing.
        // FREE first, gross shelf only as a fallback — the gang seed's exact
        // spelling. The server now costs saved single-line rows too, so a
        // reopened row reading the gross figure while the "+ Add board" list
        // beside it read the net one had one board telling two stories.
        available: r.free ?? r.available ?? c?.free ?? c?.available ?? null,
        // The raw shelf rides separately so "over" can distinguish a board
        // that is EMPTY from one that is full but fully committed.
        shelf: r.available ?? c?.available ?? null,
      };
    }));
    // Seed the leftover toggles from what the saved plan actually banked: an
    // explicit boolean per saved row, so a row whose strip went to waste last
    // lock reopens OFF instead of drifting back to the chip's default-ON. A
    // line with no v2 plan banked nothing — every saved row seeds false.
    const bankedRows = new Set(savedLo?.version === 2 && Array.isArray(savedLo.rows)
      ? savedLo.rows.map(x => +x.material_id) : []);
    setMixLeftovers(Object.fromEntries(
      (d?.mix?.rows || []).map(r => [r.material_id, bankedRows.has(+r.material_id)])));
    // Nothing to seed the packet choice from — it is not persisted yet (see the
    // state's own comment). Opening a line must still CLEAR the previous line's
    // picks, or the next job's rows would open pre-selected on a decision taken
    // for a different job's sheets.
    setPacketChoice({});
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
    cmp('print_process', form.print_process);
    cmp('cmyk_colours', form.cmyk_colours, true); cmp('pantone_colours', form.pantone_colours, true);
    cmp('pantone_codes', form.pantone_codes);
    cmp('metallic_colours', form.metallic_colours, true); cmp('metallic_details', form.metallic_details);
    cmp('print_instructions', form.print_instructions);
    cmp('emboss', form.emboss, true); cmp('leafing', form.leafing, true); cmp('leafing_colour', form.leafing_colour);
    cmp('child_l', form.child_l, true); cmp('child_w', form.child_w, true);
    cmp('parent_l', form.parent_l, true); cmp('parent_w', form.parent_w, true);
    if (!planLine.gang_run_id) { cmp('party_artwork_code', form.party_artwork_code); cmp('output_number', form.output_number); }
    cmp('die_number', form.die_number); cmp('block_number', form.block_number);
    if (boardSel && +boardSel.id !== +planLine.board_material_id) out.board_material_id = +boardSel.id;
    return out;
  };
  const edited = planLine ? changedSpec() : {};
  // Which colour-detail fields the CURRENT form state asks for — read off the
  // form, not off planLine, so the boxes appear the moment the planner picks a
  // type rather than after a save.
  const colourFormHas = {
    cmyk: String(form.colour_type || '').toLowerCase().includes('cmyk'),
    pantone: String(form.colour_type || '').toLowerCase().includes('pantone'),
    metallic: String(form.print_process || '').toLowerCase().includes('metallic'),
  };
  // The same soft rules the server exposes, run live against what is typed.
  const colourWarnings = planLine ? printColourWarnings({
    colour_type: form.colour_type, colors: form.colors, print_process: form.print_process,
    cmyk_colours: form.cmyk_colours, pantone_colours: form.pantone_colours,
    pantone_codes: form.pantone_codes, metallic_colours: form.metallic_colours,
    metallic_details: form.metallic_details,
  }) : [];

  // Board grade + GSM are read off the board name. While a board override is in
  // play they PREVIEW the picked board (grade = first token, "NNN gsm" = GSM);
  // Update Master on Lock writes them back — see boardIdentity() on the server.
  const gradeOf = nm => String(nm || '').trim().split(/[\s·]+/)[0] || '';
  const gsmOf = nm => { const m = String(nm || '').match(/(\d{2,4})\s*gsm/i); return m ? m[1] : ''; };
  const boardShift = !!(planLine && boardSel && +boardSel.id !== +planLine.board_material_id);
  const shownGrade = boardShift ? gradeOf(boardSel?.name) : (planLine?.board_grade || '');
  // Read off the FINALISED board first, exactly as this panel's heading says.
  // products.gsm is the master's own column and goes stale the moment a job
  // overrides its board — on live line 128 it read 290 beside a 320 GSM board.
  // It stays as the fallback for a board whose name carries no GSM to parse.
  const shownGsm = boardShift ? gsmOf(boardSel?.name)
    : (gsmOf(planLine?.board_name) || (planLine?.gsm ? String(planLine.gsm) : ''));

  // Options for the Board Identity picker. searchText flattens the whole
  // material onto the row, so typing '2038' or a spec code finds a board named
  // 'FBB · 300 GSM · 20 x 38' — the same behaviour the PR/PO board picker has.
  const boardOptions = useMemo(() => {
    const list = boards.map(b => ({ value: String(b.id), label: b.name, search: searchText(b) }));
    // The board a job is actually ON must always be selectable. A leftover
    // offcut, or a board since deactivated, is absent from the master list yet
    // IS what this plan runs on — and a picker that cannot render its own
    // value shows an empty field over a job that definitely has a board.
    if (boardSel?.id && !list.some(o => o.value === String(boardSel.id))) {
      list.unshift({ value: String(boardSel.id), label: boardSel.name || `Board #${boardSel.id}`, search: '' });
    }
    return list;
  }, [boards, boardSel?.id, boardSel?.name]);

  // A board's full MATERIALS row, by id — the only place on this page that can
  // answer `sheets_per_packet`, which the packet advice needs and neither
  // planning context carries. `boardSel` holds just what the picker had to hand
  // ({id, name, sheet_l, sheet_w}); the server's `ctx.board` is hand-built to
  // the same four fields (orders.js's /planning/:lineId/context), NOT a
  // SELECT *; and the run's mix context carries no board row at all, only
  // planned_board_id/name/ups. This list is GET /materials — `SELECT * FROM
  // materials` — so it is the real master row, already fetched for the Board
  // Identity picker above.
  //
  // Returns null rather than a stub for a board it cannot find (a leftover
  // offcut, or one since deactivated — the same absentees boardOptions has to
  // patch around). PacketAdvice renders nothing on a null board, which is the
  // honest answer: "we did not read this board's master", never "its master has
  // no packet size".
  const boardMasters = useMemo(() => {
    const m = new Map();
    for (const b of boards) m.set(+b.id, b);
    return m;
  }, [boards]);
  const boardMasterFor = id => (id == null ? null : boardMasters.get(+id) || null);

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
    // A "trim" larger than the board is physically impossible — you cannot cut
    // a 25×38 parent out of a 23×26.5 mother sheet. Sorted-axis compare so a
    // parent that is the board turned sideways still reads as a fit; the
    // server's plan-save now 409s the same rule (parentFitsBoard), this just
    // says it while the planner is still looking at the field.
    const bL = +boardSel.sheet_l, bW = +boardSel.sheet_w;
    const parentOversize = parentTrimmed && bL > 0 && bW > 0
      && (Math.max(parentL, parentW) > Math.max(bL, bW) + 1e-6
        || Math.min(parentL, parentW) > Math.min(bL, bW) + 1e-6);
    return {
      ups, wastage, base, total, planQty, childL, childW, parentL, parentW,
      wastagePctEq: base > 0 ? +((wastage / base) * 100).toFixed(1) : 0,
      sized: !!fit, cpp, waste: fit?.cpp > 0 ? fit.waste : null, util: fit?.cpp > 0 ? fit.util : null,
      parent: Math.ceil(total / cpp),
      parentSize: fit ? `${parentL}×${parentW}"` : null,
      parentTrimmed, parentOversize,
      childSize: fit ? `${childL}×${childW}"` : null,
      orderQty,
    };
  }, [planLine, boardSel, form.ups, form.wastage_sheets, form.child_l, form.child_w, form.parent_l, form.parent_w, form.qty]);

  // The offcut of the cut plan ON SCREEN, not the one the dialog opened on.
  // Child and Parent L/W are all editable here and every one of them moves the
  // strip, so a card fed from the server snapshot goes stale the moment the
  // planner trims the parent — and offers a strip plan-save will 409 as "does
  // not match this board's cut plan". est_sheets follows calc.parent for the
  // same reason: one strip per parent sheet cut, live.
  const loStrips = useMemo(() => {
    if (!calc) return [];
    return clientStrips(calc.parentL, calc.parentW, calc.childL, calc.childW)
      .map(s => ({ ...s, est_sheets: (s.strips_per_parent || 1) * calc.parent }));
  }, [calc]);

  // A pick the cut plan no longer yields must not survive the edit that killed
  // it — plan-save 409s a strip it cannot re-derive, so drop the selection here
  // and let the planner re-pick from what the new cut actually leaves.
  // `calc` must be non-null before this can judge anything: with no cut plan
  // yet there are no strips to match against, and clearing on that would drop
  // the saved decision a job re-opens with. (openPlan batches planLine,
  // boardSel and lo together, so calc is in fact ready on the same render —
  // this guard makes that independent of the batching rather than reliant on it.)
  useEffect(() => {
    if (!planLine || !calc || !lo.strip) return;
    const still = loStrips.some(s =>
      s.usable && Math.abs(s.l - lo.strip.l) < 0.01 && Math.abs(s.w - lo.strip.w) < 0.01);
    if (!still) setLo({ push: false, strip: null });
  }, [planLine, calc, loStrips, lo.strip]);

  // Gang cut-plan math — mirrors the server's per-member calc so the "sheets to
  // issue" breakdown updates live as wastage changes. Each member: qty÷ups gives
  // base child sheets, ÷ children-per-parent (its own child on the shared board)
  // gives parent sheets. The gang prints as ONE press run, so the wastage is a
  // SINGLE allowance booked to the lead member — never multiplied per product.
  //
  // On a CO-PRINTED (shared) layout the per-member figures above are REFERENCE
  // only: one sheet prints every member, so the run is the MAX any member
  // needs, not the SUM (sharedRunFigures — client twin of the server's
  // sharedLayoutRun). The headline `parent` — the figure gangIssueNow, the
  // Board Mix target and the Lock caption all speak — becomes that run's
  // parent count; the sum survives as `naturalParent` for the reference row.
  // CI-GANG-0010 read 1,100 off the sum while the run needed 600.
  const gangCalc = useMemo(() => {
    if (!gangView?.members?.length) return null;
    const w = Math.max(0, Math.round(+gangWastage || 0));
    const anchor = gangView.members[0];
    let baseChild = 0, childSheets = 0, parent = 0;
    // Net = ordered − FG-consumed − already dispatched, the server's
    // netProduceQty exactly (a re-planned line after a partial dispatch only
    // owes the balance — netting fg alone re-prices the whole order).
    const netOf = m => Math.max(0, (+m.qty || 0) - (+m.fg_consumed_qty || 0) - (+m.dispatched_qty || 0));
    const per = gangView.members.map((m, i) => {
      const net = netOf(m);
      const ups = Math.max(1, +m.ups || 1);
      const base = Math.ceil(net / ups);
      const child = base + (i === 0 ? w : 0); // wastage once, on the lead member
      const fit = clientFit(anchor?.sheet_l, anchor?.sheet_w, +m.child_l || +anchor?.child_l, +m.child_w || +anchor?.child_w);
      const cpp = fit && fit.cpp > 0 ? fit.cpp : 1;
      const p = Math.ceil(child / cpp);
      baseChild += base; childSheets += child; parent += p;
      return { id: m.id, base, child, cpp, parent: p };
    });
    const sum = { baseChild, wastageTotal: w, childSheets, parent, per, members: gangView.members.length };
    if (gangView.kind === 'merge' || gangView.layout_mode !== 'shared') return sum;
    // cpp: the server's settled-layout figure when it has one, else the same
    // anchor fit the reference column just used — never a third geometry.
    const anchorFit = clientFit(anchor?.sheet_l, anchor?.sheet_w, +anchor?.child_l, +anchor?.child_w);
    const run = sharedRunFigures(
      gangView.members.map(m => ({ id: m.id, net: netOf(m), ups: +m.ups })),
      { wastage: w, cpp: gangView.layout_run?.cpp ?? (anchorFit?.cpp > 0 ? anchorFit.cpp : null) });
    if (!run) return sum;   // a member without ups — degrade to the sum + the pending banner
    return {
      ...sum,
      sharedMode: true,
      parent: run.runParent,
      childSheets: run.runChild,
      naturalParent: sum.parent,
      needParent: run.needParent,
      childWastage: run.childWastage,
      parentWastage: run.parentWastage,
      yieldByMember: Object.fromEntries(run.per.map(p => [p.id, p.yieldPieces])),
    };
  }, [gangView, gangWastage]);

  const position = useMemo(() => {
    if (!ctx || !calc) return null;
    const available = +ctx.stock.available;
    const committed = +ctx.stock.committed_other;
    // What this job still needs FROM THIS BOARD.
    //
    // With no mix that is the whole cut plan, exactly as it always was. With a
    // mix in play the ROWS carry the requirement and only the unmet remainder
    // falls on the planned board — mixPosition's rule, imported rather than
    // re-derived so this panel cannot drift from the server, which computes the
    // saved-plan answer with the very same function.
    //
    // Recomputed here rather than read off ctx.stock.short because it must
    // track the LIVE form: wastage, ups, child size and the mix rows are all
    // still being edited, and the server's number is for what was last saved.
    //
    // Before this, a mix that fully covered the job still had its whole
    // requirement charged to the planned board — 'Fully covered ✓' in the mix
    // panel sitting beside 'Short 200 parent sheets', a Raise PR button and a
    // red shortfall in the footer, for board nobody needed to buy.
    const plannedUps = ctx.mix?.planned_ups;
    const mixPos = mixPosition({
      line: { parent_sheets_required: calc.parent },
      rows: mixRows.filter(r => Number(r.sheets) > 0).map(r => ({
        material_id: +r.material_id,
        sheets: r.sheets,
        // Same render guard mixTotals uses: rowCovers throws by design, and a
        // half-typed row must not blank the engine.
        covers: plannedUps > 0 && r.ups > 0
          ? rowCovers({ sheets: r.sheets, ups: r.ups, plannedUps }) : 0,
      })),
      materialId: boardSel ? +boardSel.id : null,
      plannedBoardId: ctx.mix?.planned_board_id != null ? +ctx.mix.planned_board_id : null,
    });
    // …and once cutting has ISSUED the board, nothing is outstanding at all.
    // The sheets left on the shelf are what remains AFTER that draw, so charging
    // the requirement against them again bills the same board twice and reports
    // a shortage the plant is standing on — CI-JC-0035 read "short 100" of board
    // it had already cut and printed. This sits OUTSIDE the mix arithmetic
    // deliberately: how a met requirement was split across boards changes
    // nothing about it being met. Twin of the server's openNeed().
    // A fresh_pr plan refuses the shelf: nothing of it presses on free stock,
    // and its still-to-buy is the FULL cut plan less its own PR on order and
    // the stock already HELD for it (a landed, covered PR becomes a hold — if
    // it were not netted, the panel would demand the full quantity again on a
    // job whose board is in the racks). Mirrors the server's stockShown
    // override; a live mix draft wins over the flag — a mix books the shelf.
    // The five tiles are ONE sentence — available − committed = free, and
    // free − this plan = net after plan — and it is boardPositionView that
    // holds them to it, under test, because this panel had drifted out of it
    // in two places at once.
    //
    // `committed` here is other jobs' OPEN need only. A job whose board is
    // fully frozen has nothing left to find, so its holds fell out of the tile
    // entirely: ACEBROBID's 8,959 reserved sheets read as "Committed 0" beside
    // "Free 41" on a 9,000 shelf. And `net` subtracted that open need but never
    // the holds, so HB-29's 700-sheet plan scored 9,000 − 0 − 700 = 8,300 and
    // the footer said "stock OK" while the Planning list beside it said Stock
    // Short −659. The list was right; readiness() counts holds through
    // claimableQty. boardPositionView adds the holds into `committed`, which
    // makes the row add up AND makes net honest, in one move.
    const incoming = ctx.incoming.pos.reduce((s, p) => s + p.pending_qty, 0);
    return {
      ...boardPositionView({
        available,
        committedOpen: committed,
        held: +ctx.stock.held || 0,
        heldForMe: +ctx.stock.held_for_me || 0,
        need: ctx.board_drawn ? 0 : (mixPos ? mixPos.open_need : calc.parent),
        fresh: stockBooking === 'fresh_pr' && !mixPos,
        drawn: !!ctx.board_drawn,
        ownIncoming: +ctx.stock.incoming_for_me || 0,
        planParent: calc.parent,
      }),
      incoming,
    };
  }, [ctx, calc, mixRows, boardSel, stockBooking]);

  // This job's own hold on the board in front of it, and how much more it could
  // take. `takeable` is an INCREMENT — a NEW hold on top of what is already
  // held — so its ceiling is free_for_others (sheets nobody holds), never
  // `free`: free is this job's own view and CONTAINS its own hold, so capping
  // there offered "Commit 700" against four-tenths of a packet of genuinely
  // unheld board. Also capped at what the plan still needs — committing past
  // the requirement parks sheets nobody is going to press.
  const myCommit = useMemo(() => {
    const held = Math.max(0, +ctx?.stock?.held_for_me || 0);
    const takeable = Math.max(0, Math.min(position?.free_for_others ?? 0, (calc?.parent ?? 0) - held));
    return { held, takeable };
  }, [ctx?.stock?.held_for_me, position?.free_for_others, calc?.parent]);

  // A mix that does not balance must not lock — the server refuses it anyway,
  // and a disabled button says so before the planner has typed a reason for
  // nothing. Recomputed from the LIVE draft (mixRows) against the LIVE cut
  // plan (calc.parent), never from ctx.mix.balanced, which only reflects
  // whatever was saved last.
  //
  // The ups_differ veto is REPEALED here (single-line side, matching the
  // server's own repeal in orders.js's mix loop): differing cuts are planner
  // intent now — the plate never changes, each board simply yields a
  // different count of the same print sheet, and covers convert by the cuts
  // ratio inside mixTotals. Grade and balance stay gated exactly as before —
  // grade by the server's 409 (candidates are grade-filtered at source), the
  // balance right here.
  const mixOk = mixRows.length === 0
    || mixTotals(mixRows, ctx?.mix?.planned_ups, calc?.parent ?? 0).sufficient;

  // Is this plan still the planner's to change? Once the job is on the floor the
  // cut plan is history: the job card froze it, cutting drew the board against
  // it, and POST /plan now refuses (PLAN_ALREADY_EXECUTED). The engine stays
  // fully READABLE — the planner still opens it to see what was planned — but it
  // stops presenting "Lock Plan" as the thing to do. Reverse Plan is already
  // gated to planned/ready, so before this the footer offered a locked, printing
  // job exactly one action, and it was the wrong one.
  // The same question asked of ANY line, not just the one the engine has open —
  // the queue's ⋯ menu needs it with planLine still null. planEditable stays the
  // engine's own reading of it (no open line = nothing to disable).
  const planEditableRow = l => ['pending', 'planned', 'ready'].includes(l?.status);
  const planEditable = !planLine || planEditableRow(planLine);

  // ── The RUN's Board Mix ────────────────────────────────────────────────
  // The number the run's mix must add up to: the planner's override if they
  // typed one, else the live calc, else what is already stored. Exactly the
  // figure the Lock button and Board Position quote, so the panel can never
  // balance against a total the save then judges differently.
  const gangIssueNow = gangIssue !== '' && !isNaN(+gangIssue)
    ? Math.max(0, Math.round(+gangIssue))
    : (gangCalc?.parent ?? gangView?.total_parent_sheets ?? 0);
  // BoardMix takes the same ctx shape the single-line engine passes. No `gang`
  // key on purpose: that flag is what makes the panel refuse a mix on a line
  // that prints in a gang, and this IS the gang's own panel. The child dims
  // ride along off the lead member (a MERGE run is one product, so its child
  // IS the run's; a gang's lead is the same member every run-level figure —
  // planned_ups, wastage — already speaks for) so the cuts cap and the strip
  // chips have real geometry to measure against instead of the bare
  // board_name the synthetic line used to carry.
  const gangIsMerge = gangView?.kind === 'merge';
  // Is the whole run still unlocked, and does it hold a SAVED plan?
  //
  // Both read the members, because that is where the server keeps the answer:
  // there is no draft flag on gang_runs, and inventing one would give the badge a
  // second source of truth to drift from. `plan_draft` is LINE_VIEW's own column
  // (status='pending' AND parent_sheets_required IS NOT NULL) — but MEMBER_VIEW
  // does not compute it, so it is recomputed here off the two fields MEMBER_VIEW
  // does carry, deliberately as the same pair rather than a second rule.
  //
  // `every` on pending, `some` on saved: one locked member means the run's board
  // is live and Save must stand down, while one saved member is a plan worth
  // offering to discard (the route releases them all together anyway). This is
  // also exactly how the queue row's own badge decides — rowDraft ORs plan_draft
  // across `_gang` — so the badge on the row and the buttons in the engine can
  // never disagree about whether this run has something saved.
  const gangEveryPending = !!gangView?.members?.length
    && gangView.members.every(m => m.status === 'pending');
  const gangDraft = gangEveryPending
    && gangView.members.some(m => m.parent_sheets_required != null);
  const gangMixCtx = gangView?.mix
    ? { mix: gangView.mix, line: { board_name: gangView.mix.planned_board_name,
        child_l: gangView.members?.[0]?.child_l, child_w: gangView.members?.[0]?.child_w } }
    : null;
  // Same gate as a single line's mixOk, against the run's own total: an empty
  // mix is fine (the run issues its planned board only), a half-built one is
  // not. Checked live off the draft, never off what is saved.
  //
  // The ups_differ veto is REPEALED for a MERGE run (matching the server's
  // own merge-scoped repeal in gangs.js's plan-lock mix block, and the
  // single-line repeal before it): one product means one plannedUps, so
  // differing cuts are planner intent and covers convert by the ratio inside
  // mixTotals. A GANG keeps the veto — its cuts are per member and derived,
  // and a board that cuts any member differently still cannot join.
  const gangMixOk = gangMixRows.length === 0
    || (mixTotals(gangMixRows, gangView?.mix?.planned_ups, gangIssueNow).sufficient
        && (gangIsMerge || !gangMixRows.some(r => r.ups_differ)));
  // The bank the run's lock should request for one mix row — the exact twin
  // of the single-line mixBankOn above it in this file, over the run's own
  // ctx fields, so the chip on screen and the payload can never disagree.
  // Merge only: a gang banks nothing at plan.
  const gangBankOn = r => {
    const m = gangView?.mix;
    if (!gangIsMerge || !m || !(Number(r.ups) > 0)) return false;
    const isPlanned = r.severity === 'none';
    const cand = isPlanned ? null : (m.candidates || []).find(c => c.id === r.material_id);
    const max = isPlanned
      ? (Number(m.planned_ups) > 0 ? Number(m.planned_ups) : Math.max(1, Number(r.ups) || 1))
      : (Number(cand?.max_cuts) > 0 ? Number(cand.max_cuts) : Math.max(1, Number(r.ups) || 1));
    if (!(Number(r.ups) < max)) return false;
    const childL = Number(gangMixCtx?.line?.child_l), childW = Number(gangMixCtx?.line?.child_w);
    if (!(childL > 0 && childW > 0)) return false;
    const pl = isPlanned ? Number(m.planned_parent_l) : Number(cand?.sheet_l);
    const pw = isPlanned ? Number(m.planned_parent_w) : Number(cand?.sheet_w);
    if (!(pl > 0 && pw > 0)) return false;
    if (!chosenCutsValid(pl, pw, childL, childW, r.ups).ok) return false;
    if (!chosenStrips(pl, pw, childL, childW, r.ups).some(s => s.usable)) return false;
    return (r.material_id in gangLeftovers) ? !!gangLeftovers[r.material_id] : true;
  };
  // What the run's issue actually presses on its PLANNED board. With no mix
  // that is the whole issue, exactly as before. With one it is the sheets
  // written against the planned board plus whatever the mix has not covered —
  // board-mix.js's rule, that a substitute is never "needed" beyond what is
  // written against it and only the planned board carries the remainder.
  //
  // Derived here, once, because THREE places quote it (the Board Position
  // card, the dialog footer, and the server's own gangDetail) and the two
  // client ones derive `short` themselves off the live draft — a server-only
  // fix shows nothing, and two hand-rolled copies drift the moment one is
  // edited. Without it a run covered off a second board still reads "Short"
  // and still offers a PR for board the planner has just sourced.
  const gangPressingOnPlanned = (() => {
    if (!gangMixRows.length) return gangIssueNow;
    const covered = mixTotals(gangMixRows, gangView?.mix?.planned_ups, gangIssueNow).covered;
    const held = gangMixRows
      .filter(r => r.material_id === gangView?.mix?.planned_board_id)
      .reduce((s, r) => s + Number(r.sheets || 0), 0);
    return held + Math.max(0, gangIssueNow - covered);
  })();

  // ONE spelling of "is the run short right now", shared by the footer verdict,
  // the Board Position card and the lock gate — three copies of this arithmetic
  // is how the single engine's footer said "stock OK" beside a list saying
  // Stock Short. held_others is the server's own new figure (stock frozen by
  // lines outside both the members and the claim set); the book branch must
  // carry it or the client twin drifts from gangPosition's.
  const gangShortNow = (() => {
    if (!gangView) return null;
    const onOrder = gangView.position?.incoming ?? 0;
    const freshRun = (gangView.stock_booking || 'book') === 'fresh_pr';
    const heldRun = gangView.position?.held ?? 0;
    const avail = gangView.position?.available ?? 0;
    const other = (gangView.position?.committed_other ?? 0) + (gangView.position?.held_others ?? 0);
    const short = freshRun
      ? Math.max(0, gangPressingOnPlanned - heldRun - onOrder)
      : Math.max(0, gangPressingOnPlanned + other - avail - onOrder);
    return { short, freshRun, onOrder, free: Math.max(0, avail - other) };
  })();

  // Smart Match — fetched only when the selected board runs short, debounced
  // so cut-plan typing doesn't spam the API.
  useEffect(() => {
    if (!planLine || !position || !calc) return;
    // A fresh_pr plan is not hunting the shelves — its board is being bought.
    //
    // The shortage clearing used to EMPTY the results, not merely hide them,
    // so pinning the panel alone would have kept an empty box on screen. Once
    // pinned it keeps fetching: the planner is still working the list, and a
    // row quoting the free stock it had before their own commit is worse than
    // no row at all. /planning/:id/smart-match ranks candidates against the
    // requirement and never needed a shortage to answer.
    if ((position.short <= 0 && !smartPinned) || position.fresh) { setSmart(null); return; }
    const id = ++smartSeq.current;
    const t = setTimeout(() => {
      const dims = calc.childL > 0 && calc.childW > 0 ? `&child_l=${calc.childL}&child_w=${calc.childW}` : '';
      api.get(`/planning/${planLine.id}/smart-match?sheets=${calc.total}&board_material_id=${boardSel.id}${dims}`)
        .then(d => { if (smartSeq.current === id) { setSmart(d); setSmartAll(false); } })
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [planLine?.id, boardSel?.id, position?.short, position?.fresh, calc?.total, calc?.childL, calc?.childW, boardRev, smartPinned]);

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
  // ── Commit / uncommit ──────────────────────────────────────────────────────
  // Committed demand is DERIVED — plan a job on a board and it is committed,
  // un-plan it and it is not — and that stays the default. These two let the
  // planner say it OUTRIGHT instead: take free sheets and hold them against
  // this job now, or give them back. Available wherever a board is quoted, the
  // job's own board and every Smart Match row alike, because "reserve that one
  // while I decide" is the same sentence on both.
  //
  // Only ever free stock: raiding another job is what "Take board from another
  // job" is for, and it asks its own questions (reason, preview, a PR raised
  // for the job being raided) that this must not become a shortcut around.
  // `total` is the number of sheets this job should end up holding on that
  // board, not an amount to add — the server holds the difference, so a second
  // press of the same button is a no-op rather than a second hold.
  //
  // Neither is reached by a bare click any more — every caller opens
  // `commitConfirm` and the planner answers it (see runCommitConfirm below).
  // The calls, the toasts, the boardRev bump and the ctx reload are unchanged;
  // what is new is that each one leaves a session record behind so the panel
  // can offer Uncommit and Undo over it.
  const commitBoard = async (materialId, name, total, { undo = false } = {}) => {
    if (!(total > 0)) return;
    setCommitBusy(true);
    try {
      const out = await api.post('/board/commit', { material_id: materialId, order_line_id: planLine.id, qty: total });
      toast.success(out.already
        ? `${fmt.num(out.held_for_line)} sheets of ${name} are already committed to this job`
        : `${fmt.num(out.committed)} sheets of ${name} committed to ${planLine.product_name}`);
      // `held_for_line` — the server's own figure for what this job holds on
      // this board now — never the qty that was asked for. The server holds
      // the DIFFERENCE, so the two part company the moment anything was
      // already held (and on the `already` path it holds nothing new at all).
      const heldNow = Math.max(0, +out.held_for_line || 0);
      setHeldHere(h => ({ ...h, [materialId]: heldNow }));
      setSmartPinned(true);
      // Undoing a commit means releasing the hold, and uncommitBoard releases
      // the WHOLE hold — so the figure Undo promises is what stands after this
      // press, not just the sheets this press added.
      setLastCommit(undo ? null : { kind: 'commit', materialId, name, qty: heldNow });
      setBoardRev(n => n + 1);
      setCtx(await loadCtx(planLine, boardSel.id));
    } catch (e) { toast.error(e.message); }
    finally { setCommitBusy(false); }
  };
  const uncommitBoard = async (materialId, name, { undo = false } = {}) => {
    setCommitBusy(true);
    try {
      const out = await api.post('/board/uncommit', { material_id: materialId, order_line_id: planLine.id });
      toast.success(`${fmt.num(out.released)} sheets of ${name} released back to free stock`);
      // No qty is sent, so the server released everything: this job holds none
      // of this board any more, and `released` IS what it held a moment ago —
      // the total a re-commit has to restore.
      setHeldHere(h => { const next = { ...h }; delete next[materialId]; return next; });
      setSmartPinned(true);
      setLastCommit(undo ? null : { kind: 'uncommit', materialId, name, qty: Math.max(0, +out.released || 0) });
      setBoardRev(n => n + 1);
      setCtx(await loadCtx(planLine, boardSel.id));
    } catch (e) { toast.error(e.message); }
    finally { setCommitBusy(false); }
  };
  // The one place a hold actually changes. The dialog stays open, buttons
  // disabled, while the call is in flight — same shape as every other confirm
  // in this engine.
  const runCommitConfirm = async () => {
    const c = commitConfirm;
    if (!c) return;
    if (c.kind === 'commit') await commitBoard(c.materialId, c.name, c.qty, { undo: !!c.undo });
    else await uncommitBoard(c.materialId, c.name, { undo: !!c.undo });
    setCommitConfirm(null);
  };
  // Undo is the inverse action, and it asks the same question rather than
  // slipping past it: undoing a commit IS a release, and the owner asked for
  // approval on releases. `undo: true` rides along so the trail clears when it
  // lands — one step back, never a chain.
  const askUndoCommit = () => {
    if (!lastCommit) return;
    setCommitConfirm({
      kind: lastCommit.kind === 'commit' ? 'uncommit' : 'commit',
      materialId: lastCommit.materialId, name: lastCommit.name, qty: lastCommit.qty, undo: true,
    });
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

  // Clicking Lock: a mix in play asks the coverage question first — "then you
  // should be asking me at the end whether I want to lock the masters" — ahead
  // of the ordinary master-driven-field question, which still fires afterward
  // for any OTHER edited field once the mix decision is made (see the two
  // confirm handlers below). No mix at all falls through exactly as before.
  // Every changed field ticked — the master question opens on "yes to all",
  // which is the answer it has always had. Unticking is the new part.
  const allPicked = changed => Object.fromEntries(Object.keys(changed).map(k => [k, true]));

  const onLock = () => {
    if (lo.push && !lo.strip) { toast.error('Pick which leftover strip to keep, or turn off the warehouse push'); return; }
    // SOFT gate, physics hard paperwork soft: a short plan may lock — the
    // server caps the hold at free stock and says so — but never silently.
    // "stock OK" beside a live Lock button on a plan 659 short is how a
    // 700-sheet plan was invited onto four-tenths of a packet. The dialog
    // quotes position.free (THIS job's view, its own hold included) because
    // that is exactly what the lock's hold cap measures against.
    if (position && !position.fresh && !position.drawn && position.short > 0 && !lockShortConfirm) {
      setLockShortConfirm({ short: position.short, free: position.free, parent: calc?.parent ?? 0 });
      return;
    }
    const activeMix = mixRows.filter(r => Number(r.sheets) > 0);
    if (activeMix.length > 0) { setMixConfirm({ rows: activeMix }); return; }
    const changed = changedSpec();
    if (Object.keys(changed).length) setMasterPrompt({ changed, draft: false, picked: allPicked(changed) });
    else savePlan({ spec: {}, update_master: false });
  };

  // "Save" — the planner's own words: "sometimes I just want to save my work".
  // Everything the lock writes is written; the job stays in To Plan. The master
  // question is still asked, because an edited master-driven field is an edited
  // master-driven field whether or not the plan is being committed.
  //
  // Deliberately skips the mix confirm the lock runs: that dialog asks whether
  // to LOCK a coverage decision, and a draft is not locking one. The mix rows
  // still save (when they balance — see savePlan).
  const onSave = () => {
    const changed = changedSpec();
    if (Object.keys(changed).length) setMasterPrompt({ changed, draft: true, picked: allPicked(changed) });
    else savePlan({ spec: {}, update_master: false, draft: true });
  };

  // A single substitute row, on its own, that isn't the planned board and
  // still balances the requirement (guaranteed by mixOk gating Lock in the
  // first place) means the planned board contributed nothing — the owner's
  // "full replacement" case, which earns the master question instead of the
  // plain job-only confirm.
  const mixFullReplacement = !!(mixConfirm && mixConfirm.rows.length === 1 && mixConfirm.rows[0].severity !== 'none');

  // Substitute boards in this coverage, and the sentence that will be written
  // against them. A SOFT alarm: it states the substitution and Lock Plan stays
  // live. Plan-save used to 400 here ("Give a reason for using ..."), which
  // stopped a plan whose board was already in the warehouse and whose mix
  // already balanced — see the soft-gate comment in orders.js.
  //
  // The alarm now fires on the SUBSTITUTION, not on a missing reason: the
  // reason is pre-filled, so "no reason" would almost never be true, while
  // "you are not printing on the planned board" always is — and that is the
  // fact worth putting in front of the planner before they lock. Named boards,
  // not a count, for the same reason BoardMix names them.
  const mixSubs = (mixConfirm?.rows || []).filter(r => r.severity && r.severity !== 'none');
  // One shared reason across the substitute rows (BoardMix writes the field
  // through to all of them); fall back to exactly what the server would store
  // for a row that reaches it blank, so this never promises the wrong sentence.
  const mixSubReason = String(mixSubs.find(r => String(r.reason || '').trim())?.reason || '').trim()
    || DEFAULT_MIX_REASON;

  // "Lock for this job only" — for BOTH the ordinary mix and a full
  // replacement taken job-only: the mix (or the one substitute row) saves
  // exactly as drafted, the Product Master is untouched. Any other
  // master-driven field edited alongside the mix stays job-only here too,
  // rather than silently promoting it to the master without its own question.
  const confirmMixJobOnly = () => savePlan({ spec: changedSpec(), update_master: false });

  // "Lock and make this the product's board" — full replacement only. Reuses
  // the EXISTING master-update path verbatim: set the board override, clear
  // the mix (a full replacement needs no mix row at all once it IS the
  // board), and save with spec.board_material_id + update_master: true —
  // same shape savePlan/masterPrompt already send for any other board swap.
  const confirmMixMakeMaster = () => {
    const row = mixConfirm.rows[0];
    const cand = (ctx?.mix?.candidates || []).find(c => c.id === row.material_id);
    if (cand) setBoardSel({ id: cand.id, name: cand.name, sheet_l: cand.sheet_l, sheet_w: cand.sheet_w });
    setMixRows([]); setMixLeftovers({}); setPacketChoice({});
    savePlan({ spec: { ...changedSpec(), board_material_id: +row.material_id }, update_master: true });
  };

  // The bank the save should request for one mix row — the same answer the
  // row's own chip shows, derived with the same cutFit twins BoardMix renders
  // from (its stripInfoFor): a strip exists only below the row's natural
  // ceiling, cut from the planned row's trimmed parent or a substitute's own
  // mother sheet, and only a usable (≥3") pick counts. mixLeftovers holds the
  // planner's EXPLICIT clicks; a row without one follows the chip's default —
  // ON. Deriving here rather than sending the raw map is what keeps a green
  // "Banks …" chip and the server's bank in agreement, and what keeps a stale
  // explicit ON (cuts since raised back to max, strip gone) from riding into
  // a 409 the screen no longer shows a chip for.
  const mixBankOn = r => {
    const m = ctx?.mix;
    if (!m || !(Number(r.ups) > 0)) return false;
    const isPlanned = r.severity === 'none';
    const cand = isPlanned ? null : (m.candidates || []).find(c => c.id === r.material_id);
    const max = isPlanned
      ? (Number(m.planned_ups) > 0 ? Number(m.planned_ups) : Math.max(1, Number(r.ups) || 1))
      : (Number(cand?.max_cuts) > 0 ? Number(cand.max_cuts) : Math.max(1, Number(r.ups) || 1));
    if (!(Number(r.ups) < max)) return false;
    const childL = Number(ctx?.line?.child_l), childW = Number(ctx?.line?.child_w);
    if (!(childL > 0 && childW > 0)) return false;
    const pl = isPlanned ? Number(m.planned_parent_l) : Number(cand?.sheet_l);
    const pw = isPlanned ? Number(m.planned_parent_w) : Number(cand?.sheet_w);
    if (!(pl > 0 && pw > 0)) return false;
    if (!chosenCutsValid(pl, pw, childL, childW, r.ups).ok) return false;
    if (!chosenStrips(pl, pw, childL, childW, r.ups).some(s => s.usable)) return false;
    return (r.material_id in mixLeftovers) ? !!mixLeftovers[r.material_id] : true;
  };

  // A saved plan whose Board Mix outgrew free stock says so, once per board.
  // The plan IS saved — the mix is written whole and only its stock HOLD was
  // capped — so this is never an error, and it must never be silent either:
  // the refusal it replaced carried a structured code no screen handled, which
  // made Lock Plan look broken the moment a raised wastage outgrew the shelf.
  // The persistent copy of this is the warehouse's Shortfall column.
  const sayBoardShortfalls = res => {
    for (const s of res?.board_shortfalls || []) toast.info(s.message);
  };

  const savePlan = async ({ spec, update_master, master_fields = null, draft = false }) => {
    // One filtered list for both mix fields, so a zeroed-out row can never be
    // dropped from `mix` yet still send a phantom bank in `mix_leftovers`.
    // (The server would shrug — a bank for a board not in the mix is ignored,
    // orders.js's own comment says so — but the payload shouldn't carry noise
    // the reader then has to know is inert.)
    const activeMix = mixRows.filter(r => Number(r.sheets) > 0);
    const updated = await api.post(`/order-lines/${planLine.id}/plan`, {
      wastage_sheets: +form.wastage_sheets || 0, notes: form.notes,
      spec, update_master, draft,
      // Which of the edited fields the planner ticked for the master. null =
      // the old all-or-nothing answer, which is still what the mix confirm and
      // "Save for this Job Only" send.
      ...(master_fields ? { master_fields } : {}),
      // The toggle already persisted it; riding the lock too keeps the plan
      // write atomic with the figures it was decided against. The server
      // forces 'book' when a mix rides along — a mix books the shelf.
      stock_booking: stockBooking,
      // Only send qty when the planner actually changed it — avoids a needless
      // order-line write (and audit row) on every plain plan lock.
      ...(form.qty !== '' && +form.qty > 0 && +form.qty !== planLine.qty ? { qty: +form.qty } : {}),
      leftover: lo.push && lo.strip ? { push: true, strip: lo.strip } : { push: false },
      // A row a planner has zeroed out (or that the seed skipped — see the
      // "Cover with another board" handler) contributes nothing and the
      // server's job_board_mix CHECK (sheets > 0) refuses it outright; drop it
      // here rather than let a mix that reads balanced 400 on save.
      //
      // A DRAFT with a half-built mix omits the key entirely rather than
      // sending an unbalanced one the server would 409: the stored mix is left
      // exactly as it is, so "save my work" never costs the planner the mix
      // they were in the middle of. An emptied mix still sends `[]`, which the
      // server reads as a deliberate clear. The banks ride inside the same
      // guard — withholding the mix while naming banks against its rows would
      // ask the server to price a mix it was not sent.
      //
      // `ups` is the row's CHOSEN cuts — the figure the panel's editable Cuts
      // input holds — which the server validates with chosenCutsValid against
      // the same per-row parent and stores in job_board_mix.ups. Left unsent
      // it would silently default every row back to its natural maximum,
      // undoing the reduction the leftover bank below is priced on.
      ...(draft && !mixOk ? {} : {
        mix: activeMix.map(r => ({
          material_id: r.material_id, stock_batch_id: r.stock_batch_id,
          sheets: r.sheets, ups: r.ups, reason: r.reason,
        })),
        // Which of those rows bank their strip — only rows still in the mix,
        // each at its chip's effective state (mixBankOn above). Omitted
        // entirely on a no-mix save: the server ignores it there, so sending
        // it would be pure noise.
        ...(activeMix.length ? {
          mix_leftovers: activeMix.filter(mixBankOn)
            .map(r => ({ material_id: +r.material_id, bank: true })),
        } : {}),
      }),
    });
    const masterNote = update_master
      ? (master_fields ? ` · ${master_fields.length} field${master_fields.length === 1 ? '' : 's'} to the Product Master` : ' · Product Master updated')
      : Object.keys(spec || {}).length ? ' · saved for this job' : '';
    toast.success(draft
      ? `Saved — ${fmt.num(calc.parent)} parent sheets · still in To Plan${masterNote}`
      : `Plan locked — ${fmt.num(calc.parent)} parent sheets · assign a press in Print Planning${masterNote}`
        + (lo.push && lo.strip ? ` · leftover ${lo.strip.l}×${lo.strip.w}" → warehouse after cutting` : ''));
    sayBoardShortfalls(updated);
    // A gang shares one board — changing it moves this job out of the gang.
    if (planLine.gang_run_id && !updated.gang_run_id) {
      toast.info(`Board changed — ${planLine.product_name} removed from gang ${planLine.gang_number}`);
    }
    const gid = engineFromGang;
    setMasterPrompt(null); setMixConfirm(null); setEngineFromGang(null); setPlanLine(null); load();
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

  // ── Discard a saved plan ──────────────────────────────────────────────────
  // Save leaves the job in To Plan but its mix takes REAL board holds, and
  // nothing else on the page can release them: the Board Mix panel lives inside
  // the engine and Reverse Plan refuses a line that never left 'pending'. This
  // is that release — "unsave".
  //
  // The confirm is opened first and the saved mix fetched into it, rather than
  // read off `mixRows`: those are the panel's LIVE rows, which the planner may
  // have edited since the save, and a dialog that promises to release a board
  // the save never committed would be lying. /planning/:id/context returns
  // mix.rows straight from mixFor('plan') — the same rows the server is about to
  // clear. One path for both entry points, so the queue's ⋯ (no engine, no ctx
  // in memory) and the engine footer can never describe the same discard
  // differently.
  const askDiscard = async line => {
    setDiscardAsk({ line, rows: null });
    try {
      const d = await api.get(`/planning/${line.id}/context`);
      // Guard against a second open racing this one — only fill the dialog that
      // is still asking about THIS line.
      setDiscardAsk(a => (a?.line?.id === line.id ? { ...a, rows: d?.mix?.rows || [] } : a));
    } catch {
      // The list is a courtesy; the server names what it actually released in
      // the toast afterwards. An empty array reads as "no board was held", so
      // failure falls back to that rather than blocking the discard.
      setDiscardAsk(a => (a?.line?.id === line.id ? { ...a, rows: [] } : a));
    }
  };

  const discardPlan = async line => {
    setDiscardBusy(true);
    try {
      const out = await api.post(`/order-lines/${line.id}/plan/discard`);
      const boards = (out.released || [])
        .map(m => `${fmt.num(m.sheets)} × ${m.board_name || `board #${m.material_id}`}`).join(', ');
      toast.success(boards
        ? `Saved plan discarded — ${fmt.num(out.total_sheets)} sheets back to free stock: ${boards}`
          + (out.leftover_unbanked ? ' · planned leftover taken back' : '')
        : `Saved plan discarded — no board was held${out.leftover_unbanked ? ' · planned leftover taken back' : ''}`);
      setDiscardAsk(null);
      // If the engine is open on the line just discarded, what it was editing no
      // longer exists — close it rather than leave a cut plan on screen that the
      // server has deleted. A discard from the queue with the engine shut (or
      // open on a DIFFERENT line) leaves it alone.
      if (planLine?.id === line.id) { const gid = engineFromGang; setEngineFromGang(null); setPlanLine(null); returnToGang(gid); }
      load();
    } catch (e) {
      // The route's refusals are STRUCTURED 409s (PLAN_NOT_DRAFT etc.), and
      // api.js deliberately suppresses its central toast for anything carrying a
      // `code` — the caller is expected to say it. Every one of them means the
      // line moved under the planner (someone locked it, or ganged it), so the
      // queue is refetched: leaving a stale "Saved · lock pending" badge beside
      // the message would invite the same click again.
      toast.error(e.message || 'Could not discard the saved plan');
      setDiscardAsk(null);
      load();
    } finally {
      setDiscardBusy(false);
    }
  };

  // ── Gang printing ─────────────────────────────────────────────────────────
  const gangCheck = gangSel ? gangPreview(gangSel) : null;
  // Two families of opportunity from one endpoint. `kind` is absent on a cached
  // older payload, so anything not explicitly a carton group stays a board one.
  // Scoped to the set-type zone like everything else on the page — in the Gang
  // zone the band is the shortlist of press runs to build, so it shows in FULL
  // there instead of the top-picks cap.
  const zoneLineIds = new Set(shown.map(l => l.id));
  const inZone = s => subTab === 'all' || s.line_ids?.some(id => zoneLineIds.has(id));
  const mergeSuggest = suggestions.filter(s => s.kind === 'merge' && inZone(s));
  const boardSuggest = suggestions.filter(s => s.kind === 'board' && inZone(s));
  const sizeSuggest = suggestions.filter(s => s.kind === 'size' && inZone(s));
  const suggestFull = suggestExpanded || subTab === 'gang';
  // A suggestion is a pre-filled selection, not a commitment — it opens the same
  // create modal (and the same compatibility warnings) as picking rows by hand.
  const pickSuggestion = s => {
    const picked = lines.filter(l => s.line_ids.includes(l.id));
    if (picked.length < 2) { toast.info('Those jobs have moved on — refreshing the queue'); load(); return; }
    setGangSel(picked);
  };
  const createGang = async () => {
    setGangBusy(true);
    try {
      // Same product on every selected order → a COMBINED RUN (one pile, no
      // split); different products → a gang. The server enforces the same rule.
      const sameProduct = new Set(gangSel.map(l => l.product_id)).size === 1;
      const gang = sameProduct
        ? await api.post('/merge-runs', { line_ids: gangSel.map(l => l.id) })
        : await api.post('/gang-runs', { line_ids: gangSel.map(l => l.id) });
      setGangSel(null); clearSelection(); load();
      setGangSuccess(gang); // the UPI-style confirmation carries the receipt
    } catch (e) {
      if (e.data?.code === 'GANG_CONFLICT' || e.data?.code === 'merge_conflicts') toast.error(e.message);
      else throw e;
    } finally { setGangBusy(false); }
  };
  // Manage Gang is the gang's control centre: it seeds an editable qty/ups draft
  // per member and can pull in more jobs. Refreshing re-seeds the drafts so the
  // inputs always mirror the saved figures.
  const seedGangEdits = detail => setGangEdits(Object.fromEntries(
    detail.members.map(m => [m.id, { qty: String(m.qty ?? ''), ups: String(m.ups ?? '') }])));
  // The run's Board Mix draft, seeded from whatever is already saved. The
  // server re-adds the members it was split across (gang-mix.js's
  // runMixFromMembers), so this is the run-level row the planner typed, not
  // one row per member per board. Same severity mapping as the single-line
  // seed above: a saved row can never be 'heavy' because the plan route 409s
  // an ups-differing row before it can reach the database.
  const seedGangMix = d => {
    // Severity and the differing-cuts flags come from the LIVE candidate list
    // when the saved board is still in it — the same enrichment the single-
    // line seed runs — so a reopened merge row keeps its "cuts N up natively"
    // note and its cap. A board the candidates no longer offer falls back to
    // the old generic 'warn', exactly as before.
    const candById = new Map((d?.mix?.candidates || []).map(c => [c.id, c]));
    setGangMixRows((d?.mix?.rows || []).map(r => {
      const c = r.role === 'planned' ? null : candById.get(r.material_id);
      return {
        material_id: r.material_id, board_name: r.board_name, ups: r.ups, sheets: r.sheets,
        stock_batch_id: r.stock_batch_id, reason: r.reason || '',
        severity: r.role === 'planned' ? 'none' : (c?.severity ?? 'warn'),
        ...(c ? { gsm_delta: c.gsm_delta, ups_differ: c.ups_differ, size_differs: c.size_differs } : {}),
        // FREE first, gross shelf only as a fallback. gangMixContext now costs
        // both the rows and the candidates, and a reopened row reading the gross
        // figure while the "+ Add board" list beside it reads the net one had the
        // same board telling two stories on one screen.
        available: r.free ?? r.available ?? c?.free ?? c?.available ?? null,
        // Raw shelf, separately — see the single-line seed: a full-but-frozen
        // board must not be called "empty".
        shelf: r.available ?? c?.available ?? null,
      };
    }));
    // Seed the leftover toggles from what the last lock actually banked — an
    // explicit boolean per saved row, exactly like the single-line seed, so a
    // strip sent to waste last lock reopens OFF instead of drifting back to
    // the chip's default-ON. The banked set is the live batches themselves.
    const bankedMats = new Set((d?.mix?.leftover_batches || []).map(b => +b.material_id));
    setGangLeftovers(Object.fromEntries(
      (d?.mix?.rows || []).map(r => [r.material_id, bankedMats.has(+r.material_id)])));
    // Not persisted yet, so there is nothing to seed — but opening (or
    // refreshing) a run must clear the previous one's picks, exactly as the
    // single-line seed does.
    setGangPacketChoice({});
  };
  // Open the ONE unified Gang Engine (from the row button, the gang chip, or the
  // "Plan Gang Now" success sheet). It IS the planning engine — just gang-scoped.
  // The gang's shared sheet form (child + coating) is seeded from the first
  // member — after any lock they're identical across the gang anyway.
  const seedGangSheet = d => setGangSheetForm({
    child_l: d.members?.[0]?.child_l != null ? String(d.members[0].child_l) : '',
    child_w: d.members?.[0]?.child_w != null ? String(d.members[0].child_w) : '',
    coating: d.members?.[0]?.coating || '',
  });
  // The run's OWN plate and die number — typed, never fetched from a master,
  // because a gang's layout is made for this run and no other.
  const seedGangNumbers = d => setGangNumbers({
    output_number: d.output_number || '', die_number: d.die_number || '',
  });
  const openGangById = async gangId => {
    const d = await api.get(`/gang-runs/${gangId}`);
    setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); seedGangNumbers(d); setGangAddable(null);
    setGangWastage(String(d.members?.[0]?.wastage_sheets ?? DEFAULT_WASTAGE_SHEETS));
    setGangIssue(d.issue_parent_sheets != null ? String(d.issue_parent_sheets) : '');
  };
  // Re-read the OPEN run's figures without disturbing the modal's drafts.
  // Deliberately not openGangById: that re-seeds everything, and seedGangMix
  // would overwrite the planner's live Board Mix rows (including ones the cover
  // seed just wrote) while setGangIssue would discard their manual sheet
  // override. A PR appearing or disappearing changes the run's POSITION, not
  // the plan being authored on top of it. One spelling of the endpoint, so the
  // callers below can't drift apart.
  const refreshGangView = async () => {
    if (!gangView) return;
    setGangView(await api.get(`/gang-runs/${gangView.id}`));
  };
  // Saved on its own, not at plan-lock: a run already on the floor is the
  // commonest case for naming a plate, and it must not need re-planning.
  const saveGangNumbers = async () => {
    setGangNumBusy(true);
    try {
      const d = await api.patch(`/gang-runs/${gangView.id}/numbers`, gangNumbers);
      setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); seedGangNumbers(d);
      toast.success(`${d.gang_number} — run numbers saved`);
      load();
    } catch (e) { toast.error(e.message || 'Could not save the run numbers'); }
    finally { setGangNumBusy(false); }
  };
  // A same-carton gang becomes a Combined Run in place: the run keeps its
  // members, gains a CI-MRG- number, and stops splitting. The server refuses
  // once anything has physically started (a stage running or board consumed).
  const convertGangToMerge = async () => {
    if (gangConvertBusy) return; // the disabled prop lags a re-render — same guard as gangRaisePr
    setGangConvertBusy(true);
    try {
      const d = await api.post(`/gang-runs/${gangView.id}/convert-to-merge`);
      setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); load();
      toast.success(`${d.gang_number} — combined into one run: no split, allocated per PO at dispatch`);
    } catch (e) {
      toast.error(e.message);
    } finally { setGangConvertBusy(false); }
  };
  const openGang = l => openGangById(l.gang_run_id);
  // The quiet die setting — no popup at create; the engine carries the switch
  // for the rare case the inference is wrong. Values survive the flip.
  const flipLayoutMode = async () => {
    try {
      const d = await api.patch(`/gang-runs/${gangView.id}/layout`,
        { layout_mode: gangView.layout_mode === 'shared' ? 'separate' : 'shared' });
      setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d);
      toast.success(d.layout_mode === 'shared'
        ? `${d.gang_number} — treated as one co-printed die`
        : `${d.gang_number} — treated as separate children (classic gang maths)`);
    } catch (e) { toast.error(e.message); }
  };

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
    setGangView(detail); seedGangEdits(detail); seedGangMix(detail); load();
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
    try { const d = await api.get(`/gang-runs/${gid}`); setGangView(d); seedGangEdits(d); seedGangMix(d); setGangAddable(null); }
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
    setGangView(detail); seedGangEdits(detail); seedGangMix(detail); setGangAddable(null); load();
    toast.success(`${gangAddSel.length} job${gangAddSel.length > 1 ? 's' : ''} added to ${detail.gang_number}`);
  };
  // Set ONE common board (mother sheet) for the whole gang from the engine's
  // board picker — every product prints on the same sheet.
  const setGangBoard = async board => {
    const boardId = board.id ?? board.material_id;
    const d = await api.post(`/gang-runs/${gangView.id}/board`, { board_material_id: boardId });
    toast.success(`${d.gang_number} — board set to ${board.name} for all ${d.members.length} jobs`);
    setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); setGangWhOpen(false); load();
  };
  // Lock the gang's shared sheet — board (parent) + child + coating. Opens the
  // same master-update popup the single engine uses: keep the change job-only,
  // or push it back to the product master(s) for every future job.
  const lockGangSheet = () => {
    const anchor = gangView?.members?.[0];
    setGangSheetPrompt({
      gang_number: gangView.gang_number, count: gangView.members.length,
      job_card: gangView.job_card || null,
      payload: {
        board_material_id: anchor?.board_material_id,
        child_l: gangSheetForm.child_l, child_w: gangSheetForm.child_w, coating: gangSheetForm.coating,
      },
    });
  };
  const applyGangSheet = async updateMaster => {
    const d = await api.post(`/gang-runs/${gangView.id}/shared`, { ...gangSheetPrompt.payload, update_master: updateMaster });
    const card = d.job_card ? ` · ${d.job_card.jc_number} re-stamped` : '';
    toast.success(updateMaster
      ? `${d.gang_number} — sheet saved to the product master(s) · applied to all ${d.members.length} jobs${card}`
      : `${d.gang_number} — sheet locked for these ${d.members.length} jobs${card}`);
    setGangSheetPrompt(null); setGangView(d); seedGangEdits(d); seedGangMix(d); seedGangSheet(d); load();
  };
  // Lock the whole gang's cut plan in one go (shared wastage), then close.
  // ONE payload for Save and Lock. Extracted rather than written twice on
  // purpose: the two differ by a single `draft` flag, and every other figure —
  // the wastage, the manual issue, the chosen cuts, the bank toggles — has to be
  // identical or a saved plan would lock as something other than what was saved.
  // Two copies of this object is exactly the drift that made the job-card
  // traveler its own component.
  const gangPlanPayload = ({ draft = false } = {}) => {
    // One filtered list for both mix fields — same rule as the single-line
    // savePlan: a zeroed row must not vanish from `mix` yet still send a
    // phantom bank in `mix_leftovers`.
    const activeGangMix = gangMixRows.filter(r => Number(r.sheets) > 0);
    return {
      wastage_sheets: +gangWastage || 0,
      issue_parent_sheets: gangIssue === '' ? null : Math.max(0, Math.round(+gangIssue)),
      // A DRAFT with a half-built mix omits the mix keys ENTIRELY rather than
      // sending an under-covered one the run's plan route would 409 on
      // (`runBal.sufficient`) — the stored mix is left exactly as it is, so
      // "save my work" never costs the planner the mix they were in the middle
      // of building. Byte-for-byte the rule savePlan applies to a single line,
      // and the reason Save is not gated on gangMixOk. An EMPTIED mix still
      // sends `[]`, which is a real instruction to clear it; only an unbalanced
      // one is withheld. Both keys go together — naming banks against rows the
      // server was not sent would ask it to price a mix it does not have.
      ...(draft && !gangMixOk ? {} : {
        // Run-level rows. The server splits them across the members it stores
        // them on — see gangs.js step 4 and gang-mix.js. `ups` is the CHOSEN
        // cuts on a MERGE run — left unsent it would default every row back
        // to its natural maximum, undoing the reduction the bank below is
        // priced on. A gang's cuts are derived per member, so its payload
        // deliberately carries no ups at all — byte-identical to before.
        mix: activeGangMix.map(r => ({
          material_id: r.material_id, sheets: Number(r.sheets),
          stock_batch_id: r.stock_batch_id ?? null, reason: r.reason || '',
          ...(gangIsMerge ? { ups: r.ups } : {}),
        })),
        // Which rows bank their strip — merge only, each at its chip's
        // effective state (gangBankOn), mirroring the single-line payload.
        ...(gangIsMerge && activeGangMix.length ? {
          mix_leftovers: activeGangMix.filter(gangBankOn)
            .map(r => ({ material_id: +r.material_id, bank: true })),
        } : {}),
      }),
    };
  };

  const lockGangPlan = async (confirmedShort = false) => {
    // Same soft gate as the single engine's Lock: a short run may lock — the
    // server caps the run's holds and reports the shortfalls — but never
    // silently. The gang lock had NO confirm of any kind before this.
    if (!confirmedShort && gangShortNow && !gangShortNow.freshRun && gangShortNow.short > 0) {
      setGangLockShortConfirm(gangShortNow);
      return;
    }
    setGangBusyLock(true);
    try {
      const d = await api.post(`/gang-runs/${gangView.id}/plan`, gangPlanPayload());
      toast.success(`${d.gang_number} planned as one job — issuing ${fmt.num(d.total_parent_sheets)} parent sheets`);
      sayBoardShortfalls(d);
      setGangView(null); load();
    } finally { setGangBusyLock(false); }
  };

  // Save the run's plan WITHOUT locking it — the run-level twin of the single
  // engine's Save. Same payload, same server maths, `draft: true` the only
  // difference: every member's figures, the split mix and its board holds are
  // written, and every member stays in To Plan wearing "Saved · lock pending".
  //
  // The modal stays OPEN afterwards, unlike Lock. Lock is the end of the job, so
  // closing is the right ending; a save is a pause in the middle of one, and
  // shutting the engine on it would hide the very work just saved. The run is
  // refetched so the badge and the freshly-costed free-stock figures appear on
  // the same screen the planner is still looking at.
  const saveGangPlan = async () => {
    setGangBusySave(true);
    try {
      const d = await api.post(`/gang-runs/${gangView.id}/plan`, { ...gangPlanPayload({ draft: true }), draft: true });
      toast.success(`${d.gang_number} plan saved — ${fmt.num(d.total_parent_sheets)} parent sheets held, lock still pending`);
      sayBoardShortfalls(d);
      setGangView(d); load();
    } finally { setGangBusySave(false); }
  };

  // Confirm first, and fetch what the SAVED plan is holding into the dialog
  // rather than reading the panel's live rows — the planner may have edited them
  // since the save, and a dialog promising to release a board the save never
  // committed would be lying. Same reasoning, same shape, as askDiscard for a
  // single line; here the rows come off gangDetail's mix, which is rebuilt from
  // the members by runMixFromMembers, so the planner sees the run-level rows
  // they typed and not one per member per board.
  const askGangDiscard = async run => {
    setGangDiscardAsk({ run, rows: null });
    try {
      const d = await api.get(`/gang-runs/${run.id}`);
      setGangDiscardAsk(a => (a?.run?.id === run.id ? { ...a, rows: d?.mix?.rows || [] } : a));
    } catch {
      // The list is a courtesy; the server names what it actually released in
      // the toast afterwards. An empty array reads as "no board was held", so
      // failure falls back to that rather than blocking the discard.
      setGangDiscardAsk(a => (a?.run?.id === run.id ? { ...a, rows: [] } : a));
    }
  };

  const discardGangPlan = async run => {
    setGangDiscardBusy(true);
    try {
      const out = await api.post(`/gang-runs/${run.id}/plan/discard`);
      const boards = (out.released || [])
        .map(m => `${fmt.num(m.sheets)} × ${m.board_name || `board #${m.material_id}`}`).join(', ');
      toast.success(boards
        ? `${run.gang_number} plan discarded — ${fmt.num(out.total_sheets)} sheets back to free stock: ${boards}`
          + (out.leftover_unbanked ? ' · planned leftover taken back' : '')
        : `${run.gang_number} plan discarded — no board was held${out.leftover_unbanked ? ' · planned leftover taken back' : ''}`);
      setGangDiscardAsk(null);
      // The run SURVIVES a discard (unlike Dissolve), so the engine reopens on
      // the refreshed run rather than closing: the members still print together
      // and the planner is mid-way through re-planning them. `out.run` is the
      // post-discard detail the route returns, so this costs no second fetch.
      //
      // seedGangMix goes WITH it, and that is the point rather than a detail.
      // gangMixRows is the panel's own draft and survives a gangView change on
      // its own, so without this the mix rows stayed on screen after their board
      // had been handed back — a panel showing two boards and a "stock OK"
      // footer, with nothing left to say whether any of it was still held. The
      // discarded run returns rows: [], so this clears the rows and their bank
      // toggles together and the panel states the truth: nothing is held.
      //
      // It does cost the planner the mix they had typed. That is the right way
      // round: re-adding two rows is a moment's work (Smart Match refills them
      // in one click), while being unable to tell whether stock is committed is
      // the mistake that gets board issued twice.
      if (out.run) { setGangView(out.run); seedGangMix(out.run); }
      load();
    } catch (e) {
      // Structured 409s (RUN_NOT_DRAFT / RUN_NEVER_SAVED) suppress api.js's
      // central toast, so the caller says it. Every one of them means the run
      // moved under the planner, so the queue is refetched: leaving a stale
      // "Saved · lock pending" badge beside the message invites the same click.
      toast.error(e.message || 'Could not discard the saved run plan');
      setGangDiscardAsk(null);
      load();
    } finally { setGangDiscardBusy(false); }
  };
  // Reverse the whole gang's plan back to To Plan (gang kept intact).
  const reverseGang = async () => {
    const d = await api.post(`/gang-runs/${gangView.id}/reverse`);
    toast.info(`${d.gang_number} reversed — ${d.members.length} jobs back to To Plan`);
    setGangReverseOpen(false); setGangView(d); seedGangEdits(d); seedGangMix(d); load();
  };
  // Smart-match a shared board for the gang (auto-ranked); Manual = warehouse.
  const runGangSmart = async () => {
    const d = await api.get(`/gang-runs/${gangView.id}/smart-match`);
    if (d.layout_pending) { toast.info(d.layout_reason || 'Layout pending — enter the final child size first'); return; }
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
    setGangView(d); seedGangEdits(d); seedGangMix(d); setGangExpand(null);
    toast.success(`${m.product_name} identity saved`);
  };
  const gangRemoveLine = async lineId => {
    const d = await api.post(`/gang-runs/${gangView.id}/remove-line`, { line_id: lineId });
    if (d.dissolved) { toast.info('Gang dissolved — fewer than 2 jobs left'); setGangView(null); }
    else { setGangView(d); seedGangEdits(d); seedGangMix(d); }
    load();
  };
  const gangDissolve = async () => {
    await api.del(`/gang-runs/${gangView.id}`);
    toast.info(`${gangView.gang_number} dissolved — jobs print on their own again`);
    setGangView(null); load();
  };
  // ONE gang, ONE requisition. The in-flight lock is the first line of defence
  // (a second click cannot even leave the browser); the server's 409 is the
  // second, and catches the reload-and-click-again case the lock cannot see.
  // Whose stock the RUN runs on — one choice for the whole pile. Persisted the
  // moment it flips (a stale flag beside a full-quantity PR double-covers).
  const setGangBookingMode = async mode => {
    if (gangSbBusy || !gangView || mode === (gangView.stock_booking || 'book')) return;
    setGangSbBusy(true);
    try {
      await api.post(`/gang-runs/${gangView.id}/stock-booking`, { stock_booking: mode });
      await refreshGangView();
      load();
    } finally { setGangSbBusy(false); }
  };

  const gangRaisePr = async (opts = {}) => {
    if (gangPrBusy) return;
    setGangPrBusy(true);
    try {
      const pr = await api.post(`/gang-runs/${gangView.id}/raise-pr`, opts);
      toast.success(`${pr.pr_number} raised for ${fmt.num(pr.qty)} parent sheets — one PR covers the whole gang`);
      setGangDupPr(null);
      await refreshGangView();
    } catch (e) {
      if (e.data?.code !== 'gang_pr_exists') throw e;
      // Already covered — show which PR has it rather than minting a duplicate.
      setGangDupPr({ existing: e.data.existing || [], incoming: e.data.incoming || 0, reason: '' });
      await refreshGangView();
    } finally { setGangPrBusy(false); }
  };

  // Whose stock this plan runs on. Persisted the moment the toggle flips —
  // a raised full-quantity PR sitting beside a stale 'book' flag would
  // double-cover the line (full claim on the shelf AND full incoming).
  const setBookingMode = async mode => {
    if (sbBusy || mode === stockBooking || !planLine) return;
    setSbBusy(true);
    const prev = stockBooking;
    setStockBooking(mode);
    try {
      await api.post(`/order-lines/${planLine.id}/stock-booking`, { stock_booking: mode });
    } catch {
      // The write itself failed — the server still holds the old mode.
      setStockBooking(prev);
      setSbBusy(false);
      return;
    }
    // The write landed; a refetch hiccup must NOT revert the visible toggle,
    // or the engine shows 'book' figures while every server screen fences.
    setPlanLine(p => (p ? { ...p, stock_booking: mode } : p));
    try {
      setCtx(await loadCtx({ ...planLine, stock_booking: mode }, boardSel.id));
      load();
    } catch { /* api.js toasts; the next refetch heals the figures */ }
    setSbBusy(false);
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
        reason: stockBooking === 'fresh_pr'
          ? `Full quantity for ${planLine.product_name} (PO ${planLine.po_number}) — shelf left free, planning engine`
          : `Shortfall for ${planLine.product_name} (PO ${planLine.po_number}) — planning engine`,
        ...(opts.reraise_of ? { reraise_of: opts.reraise_of, reraise_reason: opts.reraise_reason } : {}),
      });
      toast.success(`${pr.pr_number} raised for ${fmt.num(qty)} sheets`);
      setDupPr(null);
      setCtx(await loadCtx(planLine, boardSel.id));
    } finally { setPrBusy(false); }
  };

  // Undo and Cancel are reached from TWO screens now — the single-line engine
  // and the run modal — and those keep their state in different places, so the
  // refresh has to branch. The single line's context needs a line AND a board
  // to fetch (opening a run sets neither, and boardSel starts null), which is
  // why each side is guarded rather than assumed: an unguarded boardSel.id
  // threw here AFTER the requisition had already been deleted, leaving the row
  // on screen and the server one PR lighter.
  const refreshAfterPrChange = async () => {
    if (planLine && boardSel) setCtx(await loadCtx(planLine, boardSel.id));
    await refreshGangView();
    load();
  };

  // Undo — the PR was a mistake. DELETE removes the row outright; the server
  // refuses if it has reached a PO and says which one, so surface that verbatim
  // rather than inventing a friendlier lie.
  const undoPr = async pr => {
    setPrBusy(true);
    try {
      await api.del(`/requisitions/${pr.id}`);
      toast.success(`${pr.pr_number} undone`);
      await refreshAfterPrChange();
    } finally { setPrBusy(false); }
  };

  // Cancel — the PR was real and the decision changed. close() keeps the row with
  // the reason against it, and the server rejects a blank reason with a 400.
  const cancelPr = async (pr, reason) => {
    setPrBusy(true);
    try {
      await api.post(`/requisitions/${pr.id}/close`, { reason });
      toast.success(`${pr.pr_number} cancelled`);
      await refreshAfterPrChange();
    } finally { setPrBusy(false); }
  };

  // Was the inline onClick of "Cover with another board". Unchanged behaviour:
  // the planned board keeps only what it can still give — seeding a zero-sheet
  // row balances on screen but fails plan-save's `sheets > 0` check every time.
  const seedCoverMix = () => {
    const c = (ctx?.mix?.candidates || [])[0];
    if (!c) return;
    // Seed only an empty mix — the same guard the old functional update
    // (`rows.length ? rows : […]`) enforced, hoisted so the leftover toggles
    // reset in step with the reseed: fresh rows arrive at their natural cuts,
    // where no bank chip exists yet, so no stale click may speak for them.
    if (mixRows.length) return;
    const plannedSheets = Math.max(0, calc.parent - position.short);
    // Same reason the leftover toggles reset here: a mix arriving from nothing
    // changes every row's sheets, so a pick made against the whole-plan figure
    // (or against a previous draft) no longer speaks for what is on screen.
    setMixLeftovers({}); setPacketChoice({});
    setMixRows([
      ...(plannedSheets > 0 ? [{ material_id: ctx.mix.planned_board_id,
        board_name: boardSel?.name, ups: ctx.mix.planned_ups,
        sheets: plannedSheets, stock_batch_id: null, reason: '', severity: 'none' }] : []),
      { material_id: c.id, board_name: c.name, ups: c.ups, sheets: position.short,
        stock_batch_id: null, reason: DEFAULT_MIX_REASON, severity: c.severity,
        gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
        size_differs: c.size_differs, available: c.free ?? c.available },
    ]);
  };

  // Smart Match's Use — grade equality decides which confirm fires. Both
  // names must parse AND agree, exactly substitutionFlags's own gate (`if
  // (!planned || !cand) return blocked();` before it ever compares grades) —
  // an unparseable name is NOT a coincidental match. This matters in practice:
  // a leftover's own name ("Leftover — Duplex GB · 296 GSM · 20x38 · 20×13.5\"",
  // helpers.js's createLeftover) never matches parseBoardName's regex, so a
  // same-family leftover offered by Smart Match still routes to 'swap' — the
  // same board ctx.mix.candidates itself already excludes for the identical
  // reason (substitutionFlags blocks an unparseable name there too).
  const smartSameGrade = m => {
    const planned = parseBoardName(boardSel?.name);
    const cand = parseBoardName(m?.name);
    return !!planned && !!cand && planned.grade.trim().toLowerCase() === cand.grade.trim().toLowerCase();
  };

  // The current balance Smart Match's preview converts — the same number
  // BoardMix's own ledger and mixOk gate against, never a stale ctx figure: a
  // mix in progress reads mixTotals' live balance, an empty mix reads the
  // plain shortage.
  const smartBalance = mixRows.length
    ? mixTotals(mixRows, ctx?.mix?.planned_ups, calc?.parent ?? 0).balance
    : (position?.short ?? 0);

  const smartMatch = smartConfirm?.kind === 'mix' ? smartConfirm.match : null;
  // Guarded exactly like rowCovers's own render guard (BoardMix.jsx's
  // mixTotals): a half-loaded match or a planned board with no usable ups
  // must preview "nothing to add" rather than throw mid-render.
  const smartSeed = smartMatch && Number(ctx?.mix?.planned_ups) > 0 && Number(smartMatch.children_per_parent) > 0
    ? smartSeedRow({
        balanceParent: smartBalance,
        plannedUps: ctx.mix.planned_ups,
        cuts: smartMatch.children_per_parent,
        // FREE, not `available`: `available` is the gross shelf, and seeding
        // against it proposed 1,976 sheets of a board with 1,100 already
        // committed to another product. free = available − committed is what
        // this plan can actually draw. The planner may still type past it —
        // the row's own over-stock warning says so — but the SUGGESTION must
        // never start by quietly spending someone else's board.
        available: smartMatch.free ?? smartMatch.available,
      })
    : { sheets: 0, coversParent: 0, pendingAfter: Math.max(0, smartBalance) };
  const smartAlreadyInMix = !!(smartMatch && mixRows.some(r => +r.material_id === +smartMatch.material_id));

  // Same shape as seedCoverMix: the planned board keeps only what it can
  // still give, then the match joins as a substitute row. Severity/flags come
  // from ctx.mix.candidates when the match is ALSO a candidate there (both
  // lists are grade-filtered the same way via substitutionFlags, so this is
  // the common case); otherwise computed here with the same substitutionFlags
  // the server gates on — parseBoardName re-derives GSM/size from the NAME
  // string, so passing just {id, name} is sufficient, no separate sheet dims
  // needed. A same-grade match substitutionFlags still can't score (`!f.ok`)
  // is not a blocked row — Use only reaches 'mix' kind once grades already
  // matched — so that dead-code path falls back to 'warn' rather than surface
  // 'blocked' severity for a row the planner just consented to.
  const confirmSmartSeed = () => {
    const m = smartMatch;
    if (!m || smartSeed.sheets <= 0 || smartAlreadyInMix) return;
    const cand = (ctx?.mix?.candidates || []).find(c => +c.id === +m.material_id);
    const flags = cand
      ? { severity: cand.severity, gsm_delta: cand.gsm_delta, ups_differ: cand.ups_differ, size_differs: cand.size_differs }
      : (() => {
          const f = substitutionFlags({
            plannedBoard: boardSel, candidateBoard: { id: m.material_id, name: m.name },
            plannedUps: ctx?.mix?.planned_ups, candidateUps: m.children_per_parent,
          });
          return f.ok
            ? { severity: f.severity, gsm_delta: f.gsm_delta, ups_differ: f.ups_differ, size_differs: f.size_differs }
            : { severity: 'warn', gsm_delta: null, ups_differ: null, size_differs: null };
        })();
    const newRow = { material_id: m.material_id, board_name: m.name, ups: m.children_per_parent,
      sheets: smartSeed.sheets, stock_batch_id: null, reason: DEFAULT_MIX_REASON,
      available: m.available, ...flags };
    if (!mixRows.length) {
      const plannedSheets = Math.max(0, calc.parent - smartBalance);
      setMixLeftovers({}); setPacketChoice({});
      setMixRows([
        ...(plannedSheets > 0 ? [{ material_id: ctx.mix.planned_board_id,
          board_name: boardSel?.name, ups: ctx.mix.planned_ups,
          sheets: plannedSheets, stock_batch_id: null, reason: '', severity: 'none' }] : []),
        newRow,
      ]);
    } else {
      setMixRows(rows => [...rows, newRow]);
    }
    setSmartConfirm(null);
    toast.success(`${m.name} added to the mix — ${smartSeed.pendingAfter > 0
      ? `${fmt.num(Math.round(smartSeed.pendingAfter))} still short` : 'fully covered'}`);
  };

  // This line's OWN live requisitions, scoped to the PRODUCT (or the line's own
  // run): a PR raised for THIS product — or anchored anywhere in THIS line's
  // gang, since a gang PR names one member but buys for the whole run. Another
  // product's PR on the same board is not this line's — it stays in the chips
  // as information. One spelling, three readers: the duplicate-PR guard below,
  // the shortage panel's PR strip, and the "full quantity on order" note.
  const minePrs = (ctx?.incoming?.prs || []).filter(p =>
    (p.product_id != null && p.product_id === planLine?.product_id)
    || (planLine?.gang_run_id != null && p.gang_run_id === planLine.gang_run_id));

  // Duplicate-PR guard — raising a second PR for a line already covered is the
  // accident the confirm exists to catch.
  const onRaisePr = () => {
    if (minePrs.length) {
      setDupPr({ existing: minePrs[0], count: minePrs.length, add_qty: String(position.short), reason: '' });
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
    : k === 'print_process' ? 'Printing Process'
    : k === 'cmyk_colours' ? 'CMYK Colours' : k === 'pantone_colours' ? 'Pantone Colours'
    : k === 'pantone_codes' ? 'Pantone Codes'
    : k === 'metallic_colours' ? 'Metallic Colours' : k === 'metallic_details' ? 'Metallic Colour / Code'
    : k === 'print_instructions' ? 'Printing Instructions'
    : k === 'party_artwork_code' ? 'Artwork Code' : k === 'output_number' ? 'Output Number'
    : k === 'die_number' ? 'Die Number' : k === 'block_number' ? 'Block Number' : fmt.title(k);
  const specValue = (k, v) => {
    if (k === 'board_material_id') return String(v) === String(planLine?.board_material_id) ? planLine?.board_name : boardSel?.name;
    if (k === 'emboss' || k === 'leafing') return +v ? 'Yes' : 'No';
    return ['coating', 'special', 'leafing_colour'].includes(k) ? fmt.title(String(v)) : v;
  };
  // The master prompt's two derived lists: every field that changed, and the
  // subset still ticked. Both buttons and the "stays on this job" line read
  // from these, so the modal cannot promise one split and send another.
  const masterChangedKeys = Object.keys(masterPrompt?.changed || {});
  const masterPicked = masterChangedKeys.filter(k => masterPrompt?.picked?.[k]);

  const fgRelevant = ctx && (ctx.fg.lots.length > 0 || ctx.fg.consumed_qty > 0 || ctx.fg.verified_available > 0 || ctx.fg.pending_verification > 0);
  const smartShown = smart?.matches?.filter(m => !m.is_current) || [];
  const smartVisible = smartAll ? smartShown : smartShown.slice(0, 3);
  // Was `position.short > 0 && smartShown.length > 0` inline. A shortage is
  // still what OPENS the panel; a commit or release made from it is what keeps
  // it open (smartPinned), because clearing the shortage was the planner's own
  // doing and deleting their working list as the reward for it is not an
  // answer. Derived once — the panel's gate and where Undo renders both read
  // it, and two copies would drift into showing Undo twice or nowhere.
  const smartPanelShown = smartShown.length > 0 && ((position?.short ?? 0) > 0 || smartPinned);
  // One Undo, rendered in exactly one place: inside Smart Match when that
  // panel is up (that is where the action was taken and where the eye is),
  // otherwise in Board Position beneath its own commit row. Deliberately NOT
  // the Board Position header — there is already an Undo there and it steps
  // back through BOARD SELECTIONS, which is a different sentence entirely.
  const undoCommitStrip = lastCommit && planEditable ? (
    <button type="button" disabled={commitBusy} onClick={askUndoCommit}
      title="Reverse the last hold taken on this job — it asks before anything moves"
      className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-violet-700 transition-colors hover:bg-violet-100 disabled:opacity-50">
      <Undo2 size={11} />
      Undo — {lastCommit.kind === 'commit' ? 'release' : 're-commit'} {fmt.num(lastCommit.qty)} of {lastCommit.name}
    </button>
  ) : null;

  return (
    <div>
      <PageHeader title="Planning" subtitle="Requirement → cut plan → board position → machine & date → lock" />
      <Tabs active={tab} onChange={k => { setTab(k); clearSelection(); }} tabs={[
        { key: 'pending', label: 'To Plan', count: pending.length },
        { key: 'planned', label: 'Planned', count: planned.length },
        { key: 'completed', label: 'Completed', count: completed.length },
        { key: 'all', label: 'All', count: lines.length },
      ]} />

      {/* Set-type zones — the planner's triage of the tab above. One row of
          sub-chips, deliberately lighter than the tab rail: tabs are where a
          job IS in the workflow, zones are how it will PRINT. Opens on All so
          every To Plan job is visible before the planner narrows the queue.
          Counts are rows (a gang = one job), scoped to the active tab. */}
      <div className="-mt-1 mb-3 flex flex-wrap items-center gap-1">
        {[['all', 'All', null], ['single', 'Single', Square], ['gang', 'Gang', Link2], ['new_output', 'New Output', SET_TYPE_META.new_output.icon], ['hold', 'Hold', PauseCircle]].map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => { setSubTab(k); clearSelection(); }}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
              subTab === k
                ? k === 'hold' ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-200'
                  : k === 'gang' ? 'bg-violet-100 text-violet-800 ring-1 ring-violet-200'
                  : k === 'new_output' ? 'bg-sky-100 text-sky-800 ring-1 ring-sky-200'
                  : 'bg-[#1D1D1F]/[0.85] text-white'
                : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09] hover:text-[#1D1D1F]'}`}>
            {Icon && <Icon size={11} />} {label}
            <span className={`rounded-full px-1.5 text-[10px] ${subTab === k ? 'bg-white/25' : 'bg-[#1D1D1F]/[0.07]'}`}>
              {fmt.num(zoneCounts[k])}
            </span>
          </button>
        ))}
        {/* Plan saved — a second AXIS, not a sixth zone. It rides the same strip
            so the planner reaches it with the zone chips, but behind a hairline
            divider and in the badge's own blue, because it does not partition
            the tab the way the set-types do: it narrows whichever zone is open.
            Hidden at zero — only To Plan can hold a saved-but-unlocked plan, so
            everywhere else the chip would be a control with nothing to do. */}
        {draftCount > 0 && <>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-[#1D1D1F]/[0.10]" />
          <button type="button" onClick={() => { setDraftOnly(v => !v); clearSelection(); }}
            title="Show only jobs whose plan is saved and still waiting to be locked"
            aria-pressed={draftOnly}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${
              draftOnly
                ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-200'
                : 'bg-[#1D1D1F]/[0.05] text-[#6E6E73] hover:bg-[#1D1D1F]/[0.09] hover:text-[#1D1D1F]'}`}>
            <BookmarkCheck size={11} /> Plan saved
            <span className={`rounded-full px-1.5 text-[10px] ${draftOnly ? 'bg-white/25' : 'bg-[#1D1D1F]/[0.07]'}`}>
              {fmt.num(draftCount)}
            </span>
          </button>
        </>}
      </div>

      {/* ONE strip, one control. Every filter this page offers is a card here —
          there is no second row of chips saying the same thing in smaller type,
          so a number can never disagree with the thing beside it. Cards
          multi-select: each click toggles that card and the active set combines
          (union across the board partition, intersection with readiness/WIP).
          "Jobs in Queue" is the way back to everything. */}
      <KpiRow cols={8}>
        <KpiCard compact icon={Layers} tone="info" label="Jobs in Queue"
          value={fmt.num(kpiPlan.jobs)}
          sub={anyFilter
            ? 'filtered — click for all'
            : kpiPlan.gangs
              ? `${fmt.num(kpiPlan.ganged)} in ${fmt.count(kpiPlan.gangs, 'gang run')}`
              : `${fmt.num(kpiPlan.onPress)} on a press`}
          onClick={clearAllFilters} active={!anyFilter} />
        <KpiCard compact icon={Box} tone="neutral" label="Cartons to Make"
          value={fmt.num(Math.max(0, kpiPlan.qty - kpiPlan.fgCovered))}
          sub={kpiPlan.fgCovered
            ? `${fmt.num(kpiPlan.fgCovered)} from FG stock`
            : kpiPlan.qty ? 'none covered by FG' : 'nothing in this queue'} />
        <KpiCard compact icon={Scissors} tone="neutral" label="Parent Sheets"
          value={fmt.num(kpiPlan.parentSheets)}
          sub={kpiPlan.childSheets ? `${fmt.num(kpiPlan.childSheets)} print sheets` : 'no cut plan locked yet'} />
        <KpiCard compact icon={CheckCircle2} label="Ready to Run"
          tone={!kpiPlan.jobs ? 'neutral' : kpiPlan.green === kpiPlan.jobs ? 'good' : kpiPlan.green ? 'warn' : 'bad'}
          value={`${fmt.num(kpiPlan.green)}/${fmt.num(kpiPlan.jobs)}`}
          sub={`${fmt.num(kpiPlan.amber)} waiting · ${fmt.num(kpiPlan.red)} blocked`}
          onClick={() => planKpi.toggle('ready')} active={planKpi.is('ready')} />
        {/* The three board cards partition the queue: covered + on PR + short
            adds up to every job, so a job is chased once and only once. Each
            leads with the number its reader acts on — jobs you can schedule,
            jobs waiting on a delivery, and for the buy list the SHEET shortfall
            (procurement needs sheets, not another tally), with the job count in
            the sub so the card and the list visibly agree. */}
        {/* The same three words Print Planning and Artwork use, and the same
            red depth: `bad` (tint) for board someone has already bought and is
            waiting on, `alarm` (solid) for board nobody has ordered. Both are
            red because both mean the job cannot print — the depth says which
            one needs a person to move. The label is the short head; the sub
            carries the qualifier the badge spells out on a card. */}
        <KpiCard compact icon={PackageCheck} label="Stock OK"
          tone={coveredCount ? 'good' : 'neutral'}
          value={fmt.num(coveredCount)}
          sub={coveredCount ? 'stock in hand' : 'none covered yet'}
          onClick={() => toggleBoardFilter('covered')} active={boardFilters.includes('covered')} />
        <KpiCard compact icon={Truck} label="PR Raised" tone={onOrderCount ? 'bad' : 'neutral'}
          value={fmt.num(onOrderCount)}
          sub={onOrderCount ? 'stock pending — on a PR' : 'nothing on order'}
          onClick={() => toggleBoardFilter('on_order')} active={boardFilters.includes('on_order')} />
        <KpiCard compact icon={Warehouse} label="Stock Short"
          tone={shortCount ? 'alarm' : 'good'}
          value={fmt.num(kpiPlan.shortSheets)}
          sub={shortCount ? `sheets · ${fmt.count(shortCount, 'job')} to buy · no PR` : 'every job covered'}
          onClick={() => toggleBoardFilter('short')} active={boardFilters.includes('short')} />
        <KpiCard compact icon={Zap} label="Customer WIP"
          tone={kpiPlan.wip ? 'warn' : 'neutral'}
          value={fmt.num(kpiPlan.wip)}
          sub={kpiPlan.wip ? 'customer is chasing these' : 'none marked urgent'}
          onClick={() => planKpi.toggle('wip')} active={planKpi.is('wip')} />
      </KpiRow>
      {/* One notice for the whole strip — it names every active card and clears
          them together, so a filtered list is never a mystery and never takes
          two clicks to undo. */}
      <KpiFilterNotice
        filter={{ key: anyFilter ? 'on' : null, clear: clearAllFilters }}
        label={activeFilterLabels.join(' · ')}
        shown={displayRows.length} total={groupedRows.length} />

      {/* Consolidation suggestions — all that is left on this line now the board
          filter lives in the strip above, so they start at the left edge in the
          space the chips used to take. Combine (teal) leads: repeat orders of
          one carton are the strongest consolidation there is. Hover a chip for
          the full story; click it to pre-fill the create modal. No suggestions
          → no empty band, and the table climbs the page instead. */}
      {canPlanRole && !hideSuggest && (mergeSuggest.length + boardSuggest.length + sizeSuggest.length > 0) && (
          <div className={`mb-4 flex min-w-0 max-w-full items-center gap-1.5 ${suggestFull ? 'flex-wrap' : 'overflow-x-auto scrollbar-none'}`}>
            <Sparkles size={14} className="shrink-0 text-slate-400" />
            {(suggestFull ? mergeSuggest : mergeSuggest.slice(0, 2)).map(sg => (
              <button key={sg.key} type="button" onClick={() => pickSuggestion(sg)}
                title={`${sg.product_name} — ${sg.lines.length} sales orders (${sg.lines.map(l => l.po_number).join(', ')}). Combine into ONE run: no split, one sort, one paste, one QC; allocated back per PO at dispatch.`}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-teal-100/80 px-2.5 py-1 text-xs font-bold text-teal-700 ring-1 ring-teal-200/70 transition-colors hover:bg-teal-200/70">
                <Layers size={12} /> {sg.product_code} · {sg.lines.length} POs · {fmt.num(sg.total_qty)}
              </button>
            ))}
            {(suggestFull ? boardSuggest : boardSuggest.slice(0, 2)).map(sg => (
              <button key={sg.key} type="button" onClick={() => pickSuggestion(sg)}
                title={`${sg.lines.length} jobs on ${sg.board_name} · ${fmt.title(sg.coating)} — same board & coating can share one press run.`}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-violet-100/80 px-2.5 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200/70 transition-colors hover:bg-violet-200/70">
                <Link2 size={12} /> {sg.lines.length} jobs · {sg.board_name}
              </button>
            ))}
            {(suggestFull ? sizeSuggest : sizeSuggest.slice(0, 1)).map(sg => (
              <button key={sg.key} type="button" onClick={() => pickSuggestion(sg)}
                title={`${sg.lines.length} jobs are the ${sg.size_label} carton — one die layout: set the board once and they all nest.`}
                className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-violet-100/80 px-2.5 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200/70 transition-colors hover:bg-violet-200/70">
                <Box size={12} /> {sg.lines.length} jobs · {sg.size_label}
              </button>
            ))}
            {subTab !== 'gang' && (mergeSuggest.length + boardSuggest.length + sizeSuggest.length) > 5 && (
              <button type="button" onClick={() => setSuggestExpanded(x => !x)}
                title={suggestExpanded ? 'Back to the top picks' : 'Show every consolidation chance in the queue'}
                className="shrink-0 rounded-full bg-[#1D1D1F]/[0.06] px-2.5 py-1 text-xs font-bold text-slate-500 transition-colors hover:bg-[#1D1D1F]/[0.12] hover:text-slate-700">
                {suggestExpanded ? 'show less' : `+${mergeSuggest.length + boardSuggest.length + sizeSuggest.length - 5} more`}
              </button>
            )}
            <button type="button" className="shrink-0 text-slate-300 hover:text-slate-500"
              title="Hide suggestions for this visit" onClick={() => setHideSuggest(true)}>
              <X size={14} />
            </button>
          </div>
      )}

      <BulkWorkflowControls lines={selectedLines} context="planning" onDone={load} onClear={clearSelection}
        // Two families of bulk action, and the dock now keeps them physically
        // apart — they read as one undifferentiated row of blue buttons
        // otherwise, which is exactly what the planner complained about:
        //   TAG (`move`) — Move to Gang / Move to Hold writes the set-type on
        //   every selected job (zone movement only, nothing physical; a run
        //   tags whole). Anik's ask: bulk movement, NOT gang creation.
        //   BUILD (`lead`) — Combine / Gang makes the physical run. The
        //   selection chooses which build: repeat orders of ONE carton combine
        //   (no split); different cartons gang onto one shared sheet.
        // Both families are planner work — every endpoint behind them is
        // requireRole('planner'). Without this the buttons render for anyone
        // holding the planning module and a qc/floor login clicks straight
        // into a bare 403.
        lead={(() => {
          if (!canPlanRole) return null;
          const buildable = selectedLines.length >= 2
            && selectedLines.every(l => ['pending', 'planned'].includes(l.status) && !l.gang_run_id);
          if (!buildable) return null;
          const sameProduct = new Set(selectedLines.map(l => l.product_id)).size === 1;
          // "Gang these N" is the wording the in-table band already uses — the
          // two entry points into the same modal must not be two vocabularies.
          return sameProduct
            ? <Button size="sm" variant="solid" className="rounded-full bg-teal-600 px-3 py-1.5 text-[11px] hover:bg-teal-700"
                onClick={() => setGangSel(selectedLines)}><Layers size={12} /> Combine these {selectedLines.length}</Button>
            : <Button size="sm" variant="solid" className="rounded-full bg-violet-600 px-3 py-1.5 text-[11px] hover:bg-violet-700"
                onClick={() => setGangSel(selectedLines)}><Link2 size={12} /> Gang these {selectedLines.length}</Button>;
        })()}
        move={(() => {
          if (!canPlanRole) return null;
          const allPending = selectedLines.length > 0 && selectedLines.every(l => l.status === 'pending');
          if (!allPending) return null;
          // Every zone is reachable in bulk, including back to Single — a
          // mis-tagged pile has to be undoable the same way it was made.
          // Single and New Output are hidden when the selection holds a ganged
          // job: the server refuses those two on a run, so offering them would
          // promise a move that cannot happen.
          const anyGanged = selectedLines.some(l => l.gang_run_id);
          const BULK = [
            { key: 'single', solo: true },
            { key: 'gang' },
            { key: 'new_output', solo: true },
            { key: 'hold' },
          ];
          // Tonal, not solid — and in SET_TYPE_META's own colours, so the chip
          // that tags a row and the button that tags a pile are the same
          // colour for the same zone. That single source is also why the four
          // never carry a hand-written bg-*: those were the ones the brand
          // gradient swallowed.
          const chips = BULK.filter(b => !(b.solo && anyGanged)).map(b => {
            const m = SET_TYPE_META[b.key];
            const Icon = m.icon;
            return (
              <button key={b.key} type="button"
                onClick={() => (b.key === 'hold'
                  ? setHoldAsk({ rows: selectedRowAnchors, pick: PLANNING_HOLD_DEFAULT, reason: '' })
                  : saveSetTypes(selectedRowAnchors, b.key))}
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold transition-all duration-200 ease-apple hover:brightness-[0.96] active:scale-[0.97] touch:min-h-[38px] touch:px-3 ${m.chip}`}>
                <Icon size={12} /> {m.label}
              </button>
            );
          });
          return chips.length ? <>{chips}</> : null;
        })()} />
      <DataTable searchable cardClass="ci-card-edge"
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
        // Six figures on the card face, not four. On a tablet this board IS
        // the planner's working surface — PO date, days overdue, GSM, board,
        // board status and quantity are what the decision is made on, so none
        // of them may sit behind a Details fold.
        faceMetrics={6}
        // In the Gang zone the stack key switches from "this run" to "this
        // board": candidates for one press run — same board, GSM, coating —
        // pull together with any existing runs on that board, which is how a
        // planner reads the pile. A stack of one is no stack: solitary keys
        // stay independent so the zone is not all rail. Elsewhere the key
        // stays the gang run itself.
        groupBy={subTab === 'gang'
          ? (l => (gangStacks.get(gangStackKey(l)) > 1 ? gangStackKey(l) : (l._gang ? `gang-${l.gang_run_id}` : null)))
          : (l => (l._gang ? `gang-${l.gang_run_id}` : null))}
        groupTone={l => (l.run_kind === 'merge' ? 'teal' : 'violet')}
        renderGroupHeader={subTab === 'gang' ? rows => {
          const [f] = rows;
          if (!f) return null;
          const jobs = rows.reduce((s, r) => s + (r._gang ? r._gang.length : 1), 0);
          // Loose lines only — a row already in a run gangs via its own engine.
          const loose = rows.filter(r => !r.gang_run_id);
          return (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-bold text-violet-700">
              <Link2 size={11} /> {fmt.count(jobs, 'job')} · {f.board_name || 'no board yet'}
              {f.gsm ? <span className="font-semibold text-violet-500">{f.gsm} GSM</span> : null}
              {f.coating ? <span className="font-semibold text-violet-500">{fmt.title(f.coating)}</span> : null}
              {canPlanRole && loose.length >= 2 && (
                <button type="button" onClick={e => { e.stopPropagation(); setGangSel(loose); }}
                  className="ml-1 inline-flex items-center gap-1 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-bold text-white transition-colors hover:bg-violet-700">
                  <Link2 size={10} /> Gang these {loose.length}
                </button>
              )}
            </div>
          );
        } : undefined}
        rowClass={boardRowClass}
        columns={[
          // The customer shows as initials (Swiss Garnier Life Sciences → SGLS):
          // full registered names ran three lines deep in this column and pushed
          // the spec columns off the screen. The full name stays on hover AND in
          // the search haystack via searchValue, so typing "swiss" still finds a
          // row that reads "SGLS". Export keeps the full name — a PDF has no
          // hover.
          // ── ORDER ─────────────────────────────────────────────────────────
          // PO, customer, the date it was booked and how overdue it is: one
          // fact — "whose order is this and how long has it waited" — so it is
          // one cell. The three sorts it used to carry as three columns are on
          // the heading's own menu, because merging cells must never cost a
          // sort.
          { key: 'po_number', label: 'Order', width: 'w-[132px]', colClass: PLAN_CELL,
            // Just the PO number now — PO date and Days overdue became columns
            // of their own beside this one, and a sort menu that repeats what
            // the next two headers already do is two ways to say one thing.
            sortKeys: [
              { key: 'po_number', label: 'PO number' },
            ],
            export: l => (l._gang
              ? `${l.gang_number}: ${[...new Set(l._gang.map(m => `${m.po_number} ${m.po_date ? `(${fmt.date(m.po_date)})` : ''} — ${m.customer_name}`))].join(' | ')}`
              : `${l.po_number}${l.po_date ? ` (${fmt.date(l.po_date)})` : ''} — ${l.customer_name}`)
              + (l.run_output_number || l.output_number ? ` · Out ${l.run_output_number || l.output_number}` : ''),
            // The plate number is on the row, so it has to be typeable too —
            // the floor calls a job by it as often as by its PO.
            searchValue: l => (l._gang || [l])
              .map(m => `${m.po_number ?? ''} ${m.po_date ?? ''} ${customerSearchText(m.customer_name)}`).join(' ')
              + ` ${l.run_output_number ?? ''} ${l.output_number ?? ''}`,
            render: l => l._gang
            ? (() => {
                const pos = [...new Set(l._gang.map(m => m.po_number))];
                const custs = [...new Set(l._gang.map(m => m.customer_name).filter(Boolean))];
                const merged = l.run_kind === 'merge';
                return (
                  <div onClick={e => e.stopPropagation()}>
                    {merged
                      ? <MergeChip number={l.gang_number} onClick={() => openGang(l)} />
                      : <GangChip number={l.gang_number} onClick={() => openGang(l)} />}
                    <div className="mt-1 font-semibold text-gray-900">{pos.join(' · ')}</div>
                    {/* The dates moved out to the sortable PO Date column beside
                        this one, which carries the run's spread in full. */}
                    <div className="text-xs text-gray-500" title={custs.join(' · ')}>
                      {custs.map(customerInitials).join(' · ')}
                    </div>
                    <div className={`mt-0.5 text-[10px] font-bold uppercase tracking-wide ${merged ? 'text-teal-600' : 'text-violet-500'}`}>
                      {merged ? `${l._gang.length} orders · one pile` : `${l._gang.length} jobs · one run`}
                    </div>
                    {/* The run's OWN plate number — the identity a gang travels
                        under once the planner names it, shown here exactly as a
                        single carton shows its master number below, and as the
                        press board and every station queue show it. A merge is
                        one product, so its number is the carton's own. */}
                    {(l.run_output_number || (merged && l.output_number)) && (
                      <div className="mt-0.5"><OutputChip number={l.run_output_number || l.output_number} /></div>
                    )}
                    {l._gang.some(m => m.wip) && <div className="mt-0.5"><WipChip on /></div>}
                  </div>
                );
              })()
            : (<div>
                <div className="font-semibold text-gray-900">{l.po_number}</div>
                <div className="text-xs font-semibold text-gray-500" title={l.customer_name}>
                  {customerInitials(l.customer_name) || <span className="text-gray-300">—</span>}
                </div>
                {l.output_number && <div className="mt-0.5"><OutputChip number={l.output_number} /></div>}
                {l.wip && <div className="mt-0.5"><WipChip on date={l.wip_date} /></div>}
              </div>) },
          // PO Date and OD as columns of their own — the same pair Artwork and
          // the Job Card register carry, so the one clock most of this book has
          // reads identically wherever a planner meets it. They used to be a
          // sub-line inside Order, which could be sorted but not scanned down.
          //
          // A gang answers for its OLDEST member and shows the run's span, so
          // the range the Order cell used to print lives here now, not lost.
          { key: 'po_date', label: 'PO Date', width: 'w-[96px]', colClass: PLAN_CELL, card: 'detail',
            sortValue: l => poAgeOf(l).date || '',
            export: l => { const a = poAgeOf(l); return a.date
              ? fmt.date(a.date) + (a.latest ? ` — ${fmt.date(a.latest)}` : '') : '—'; },
            render: l => { const a = poAgeOf(l);
              if (!a.date) return <span className="text-gray-300">—</span>;
              return (
                <div className="text-xs tabular-nums leading-4 text-gray-600">
                  <div className="whitespace-nowrap">{fmt.date(a.date)}</div>
                  {a.latest && <div className="whitespace-nowrap text-[10px] text-gray-400">→ {fmt.date(a.latest)}</div>}
                </div>
              ); } },
          { key: 'od', label: 'OD', width: 'w-[56px]', align: 'right', colClass: PLAN_CELL,
            sortValue: l => poAgeOf(l).days ?? -1,
            export: l => { const d = poAgeOf(l).days; return d == null ? '—' : `${d}d`; },
            render: l => { const a = poAgeOf(l); return <OverdueDays days={a.days} count={a.count} />; } },
          { key: 'product_name', label: 'Product', width: 'w-[176px]', colClass: PLAN_CELL,
            sortable: false,
            sortKeys: [
              { key: 'product_name', label: 'Product name' },
              { key: 'coating', label: 'Coating', sortValue: l => specCell(l, coatingOf, fmt.title).text || '' },
              { key: 'printing', label: 'Ink', sortValue: l => totalColoursOf(gangLead(l)) ?? -1 },
            ],
            searchValue: l => [
              (l._gang || [l]).map(productSearchText).join(' '),
              specSearch(l, m => m.coating),
              (l._gang || [l]).map(colourSearchText).join(' '),
            ].join(' '),
            export: l => l._gang ? l._gang.map(productExport).join(' + ') : productExport(l),
            render: l => (<div className="min-w-0">{l._gang
            ? <GangCellParts members={l._gang} tone={l.run_kind === 'merge' ? 'teal' : 'violet'}
                total={<span className={`font-semibold normal-case ${l.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-600'}`}>
                  {l.run_kind === 'merge' ? 'one pile — no split' : 'together until die cutting'}</span>}
                render={m => (
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ProductIdentity row={m} compact className="min-w-0 max-w-[200px]"
                      meta={[m.colors != null ? `${m.colors}c` : null, m.special && m.special !== 'none' ? fmt.title(m.special) : null].filter(Boolean).join(' · ')} />
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
            : (<div className="max-w-[200px]"><div className="flex items-start gap-1.5"><ProductIdentity row={l} className="min-w-0 flex-1"
                meta={[l.colors != null ? `${l.colors}c` : null, l.special && l.special !== 'none' ? fmt.title(l.special) : null].filter(Boolean).join(' · ')} />
              {l.gang_number && <span className="mt-0.5" onClick={e => e.stopPropagation()}>{l.run_kind === 'merge' ? <MergeChip number={l.gang_number} onClick={() => openGang(l)} /> : <GangChip number={l.gang_number} onClick={() => openGang(l)} />}</span>}</div></div>)}<ColourScheme line={l} /></div>) },
          // ── BOARD ─────────────────────────────────────────────────────────
          // What the job prints ON, and nothing else: grade, weight, and the
          // sheet actually being bought. Its own column because this is the
          // fact a gang decision turns on — and the name WRAPS rather than
          // truncating, because a board name you cannot read is the one thing
          // this column exists for. The stock verdict moved out to sit under
          // Readiness, where the other go/no-go signals live.
          { key: 'board_grade', label: 'Board', width: 'w-[116px]', colClass: PLAN_CELL,
            sortable: false,
            sortKeys: [
              { key: 'board_grade', label: 'Board grade', sortValue: l => (l.spec_incomplete ? '' : specCell(l, m => m.board_grade).text || '') },
              { key: 'gsm', label: 'GSM', sortValue: l => Number(specCell(l, m => m.gsm).text) || 0 },
            ],
            searchValue: l => (l.spec_incomplete ? '' : specSearch(l, m => `${m.board_grade ?? ''} ${m.board_name ?? ''} ${m.gsm ?? ''}`)),
            export: l => (l.spec_incomplete ? '—'
              : specCell(l, m => m.board_name).text || specCell(l, m => m.board_grade).text || '—'),
            render: l => {
              if (l.spec_incomplete) return <span className="text-xs text-slate-300" title="No board chosen yet — picked in planning">—</span>;
              // ONE line. The board's own name already carries grade, weight and
              // parent sheet ("FBB · 300 GSM · 20x38"), so the grade+gsm line
              // above it was the same three facts a second time. Bold, because
              // this is the fact the gang decision turns on. A line whose board
              // has no name on file falls back to the pieces.
              const boardName = specCell(l, m => m.board_name).text || '';
              if (boardName) {
                return <div className="break-words text-xs font-bold leading-4 text-slate-800">{boardName}</div>;
              }
              return (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs font-bold leading-4 text-slate-800">
                  <SpecText line={l} pick={m => m.board_grade} className="text-xs font-bold text-slate-800" />
                  <span className="whitespace-nowrap tabular-nums">
                    <SpecText line={l} pick={m => m.gsm} className="tabular-nums" /><span className="ml-0.5 font-semibold text-slate-500">gsm</span>
                  </span>
                </div>
              );
            } },
          // ── DIE ───────────────────────────────────────────────────────────
          // The number a planner asks the rack for, with the sheet it punches
          // and how many up — and the carton's own size beneath, because "which
          // die" and "how big is it" are asked in the same breath.
          //
          // nowrap WITHOUT overflow-hidden on the detail lines: this table is
          // auto-layout, so a width class is a HINT it can squeeze — but a
          // nowrap run sets the column's min-content width, which table layout
          // must honour, so the cell can never clip a die's size and ups.
          { key: 'die_number', label: 'Die', width: 'w-[96px]', colClass: PLAN_CELL,
            sortable: false,
            sortKeys: [
              { key: 'die_number', label: 'Die number', sortValue: l => specCell(l, m => m.die_number).text || '' },
            ],
            searchValue: l => specSearch(l, m => `${m.die_number ?? ''} ${m.die_type ?? ''} ${m.die_sheet_size ?? ''} ${m.die_ups ? `${m.die_ups} ups` : ''}`),
            export: l => {
              const num = specCell(l, m => m.die_number).text;
              const detail = specCell(l, dieDetailOf).text;
              if (!num) return '—';
              return detail ? `${num} (${detail})` : num;
            },
            render: l => {
              const { text: dieDetail, mixed: dieMixed } = specCell(l, dieDetailOf);
              const lead = gangLead(l);
              return (
                <div className="min-w-0 leading-4">
                  <SpecText line={l} pick={m => m.die_number}
                    className="block whitespace-nowrap font-mono text-xs font-semibold text-slate-700" />
                  {!dieMixed && dieDetail && (
                    <div className="flex items-baseline gap-1 whitespace-nowrap leading-4" title={dieDetail}>
                      {dieSheetOf(lead) && (
                        <span className="font-mono text-[11px] font-medium text-slate-500">{dieSheetOf(lead)}</span>
                      )}
                      {/* The separator belongs to the PAIR, not to the ups — a
                          die with no sheet size on file rendered a stray "·"
                          leading the line. */}
                      {dieSheetOf(lead) && dieUpsOf(lead) && (
                        <span className="font-sans text-[11px] text-slate-400">·</span>
                      )}
                      {dieUpsOf(lead) && (
                        <span className="font-sans text-[11px] font-semibold text-slate-600">{dieUpsOf(lead)}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            } },
          // ── PANEL ─────────────────────────────────────────────────────────
          // The carton's own dimensions. Its own column because it is a
          // question of its own — "how big is the thing" — and reading it out
          // of the bottom of the die cell made it look like part of the die.
          // Sorted on the longest edge, because "which cartons are about this
          // big" is what a planner asks of it; a string sort would file
          // 100x48x48 next to 1000x48x48.
          { key: 'size', label: 'Panel', width: 'w-[88px]', colClass: PLAN_CELL,
            sortValue: l => {
              const t = specCell(l, sizeOf).text;
              return t ? Math.max(...t.split('x').map(n => parseFloat(n) || 0)) : 0;
            },
            searchValue: l => specSearch(l, m => `${m.size ?? ''} ${sizeOf(m) ?? ''}`),
            export: l => specCell(l, sizeOf).text || '—',
            render: l => <SpecText line={l} pick={sizeOf}
              className="whitespace-nowrap font-mono text-[11px] font-semibold text-slate-600" /> },
          // ── QUANTITY ──────────────────────────────────────────────────────
          // Ordered, what finished stock covers, and the sheets it takes: one
          // column, because they are one arithmetic. Sheets only exist once a
          // line is planned, so on To Plan that line simply is not there — it
          // was never a column of dashes, it is an absent fact.
          { key: 'qty', label: 'Quantity', width: 'w-[96px]', align: 'right', colClass: PLAN_CELL,
            sortable: false,
            sortKeys: [
              { key: 'qty', label: 'Ordered', sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (+m.qty || 0), 0) : l.qty) },
              ...(tab === 'pending' ? [] : [{ key: 'sheets_required', label: 'Sheets', sortValue: l => (l._gang ? l._gang.reduce((s, m) => s + (+m.sheets_required || 0), 0) : l.sheets_required) }]),
            ],
            export: l => fmt.num(l._gang ? l._gang.reduce((s, m) => s + (+m.qty || 0), 0) : l.qty),
            render: l => {
              const cell = m => (
                <div className="text-right">
                  <div className="tabular-nums font-semibold text-slate-800">{fmt.num(m.qty)}</div>
                  {m.fg_consumed_qty > 0 && (
                    <div className="whitespace-nowrap text-[11px] font-semibold text-violet-600">
                      −{fmt.num(m.fg_consumed_qty)} FG → {fmt.num(m.qty - m.fg_consumed_qty)}
                    </div>
                  )}
                  {m.sheets_required ? (
                    <div className="whitespace-nowrap text-[11px] tabular-nums text-slate-500">
                      {fmt.num(m.sheets_required)} sh{m.parent_sheets_required ? ` · ${fmt.num(m.parent_sheets_required)} par` : ''}
                    </div>
                  ) : null}
                  {/* Finished stock that could cover this order, and the button
                      that spends it — the offer belongs beside the number it
                      would reduce, not in a column of its own two cells away. */}
                  {m.fg_available > 0 && ['pending', 'planned', 'ready'].includes(m.status) && (
                    <div className="mt-1 flex flex-col items-end gap-1" onClick={e => e.stopPropagation()}>
                      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-emerald-700">
                        <PackageCheck size={11} /> {fmt.num(m.fg_available)}
                      </span>
                      <Button size="sm" variant="secondary" className="whitespace-nowrap !px-2 !py-1 !text-[11px]" onClick={() => openFgUse(m)}>Use FG Stock</Button>
                    </div>
                  )}
                </div>
              );
              if (!l._gang) return cell(l);
              const parent = l._gang.reduce((s, m) => s + (+m.parent_sheets_required || 0), 0);
              return <GangCellParts members={l._gang} align="right" tone={l.run_kind === 'merge' ? 'teal' : 'violet'}
                total={<span className="tabular-nums">{fmt.num(l._gang.reduce((s, m) => s + (+m.qty || 0), 0))}{parent ? ` · ${fmt.num(parent)} par` : ''}</span>}
                render={cell} />;
            } },
          // Press is the OUTPUT of planning — absent until a line is planned.
          ...(tab === 'pending' ? [] : [
            { key: 'machine_name', label: 'Press', width: 'w-[96px]', colClass: PLAN_CELL, render: l => l.machine_name ? (<div><div className="text-xs font-semibold">{l.machine_name}</div>{l.planned_date && <div className="text-xs text-gray-400">{fmt.date(l.planned_date)}</div>}</div>) : <span className="text-xs text-gray-400">via Print Planning</span> },
          ]),
          // Readiness, and under it the board verdict — they are the same
          // question ("can this run today?") answered by different gates, so a
          // planner reads them as one block instead of hunting a chip three
          // columns away.
          { key: 'gates', label: 'Readiness', width: 'w-[136px]', colClass: PLAN_CELL,
            sortable: false,
            sortKeys: [
              { key: 'board_state', label: 'Board status', sortValue: l => BOARD_RANK[rowBoardState(l)] },
            ],
            searchValue: l => `${BOARD_FULL[rowBoardState(l)]} board`,
            export: l => BOARD_FULL[rowBoardState(l)],
            render: l => (
              <div className="space-y-1">
                {l._gang
                  ? <GangCellParts members={l._gang} tone={l.run_kind === 'merge' ? 'teal' : 'violet'} render={m => <ReadinessCell readiness={m.readiness} light={m.light} />} />
                  : <ReadinessCell readiness={l.readiness} light={l.light} />}
                <BoardBadge state={rowBoardState(l)} compact />
                {l.plate_state && <PlateStatus state={l.plate_state} compact className="ml-1" />}
              </div>
            ) },
          // Set-type triage — the dropdown that moves a row between the zones
          // above. Pending rows retag; a locked plan wears the chip inert (the
          // server refuses the write too). A gang row is one job here: the
          // menu acts on the whole run and never offers Single.
          // card:'face' — this is the control that MOVES a row between zones
          // (single / gang / new output / hold). On a card it has to be the
          // thumb's first target, not something behind a Details fold, so it
          // rides the face as a live chip directly under the identity.
          { key: 'set_type', label: 'Set Type', width: 'w-[92px]', colClass: PLAN_CELL, sortable: false, card: 'face',
            searchValue: l => `${SET_TYPE_META[rowSetType(l)].label} ${holdReasonOf(l)}`,
            export: l => SET_TYPE_META[rowSetType(l)].label
              + (rowSetType(l) === 'hold' && holdReasonOf(l) ? ` — ${holdReasonOf(l)}` : ''),
            render: l => {
              const type = rowSetType(l);
              const editable = canPlanRole && (l._gang || [l]).every(m => m.status === 'pending');
              return (
                <div onClick={e => e.stopPropagation()}>
                  {editable
                    ? <ActionMenu items={setTypeMenuItems(l)} label="Change set type"
                        trigger={({ toggle, open }) =>
                          <SetTypeChip type={type} reason={holdReasonOf(l)} editable toggle={toggle} open={open} />} />
                    : <SetTypeChip type={type} reason={holdReasonOf(l)} editable={false} />}
                </div>
              );
            } },
          { key: 'status', label: 'Status', width: 'w-[88px]', colClass: PLAN_CELL, render: l => {
            // A saved-but-unlocked plan says so INSTEAD of "pending". The status
            // is genuinely still pending — that is the point of Save, and every
            // downstream reader must keep seeing it — but "pending" on a job the
            // planner spent twenty minutes on reads as "your work is gone", and
            // is the one thing this cell must not say.
            if (!l._gang) return (
              <div className="flex flex-col items-start gap-1">
                {l.plan_draft ? <PlanSavedBadge /> : <StatusBadge status={l.status} />}
                <MgtChip a={approvals[l.id]} />
              </div>
            );
            // A collapsed GANG speaks for N lines at once, so its cell has two
            // answers rather than one.
            //
            // RUN-LEVEL SAVED — every member pending, at least one carrying a cut
            // plan — is now a real state a route produces: the Gang Engine's Save
            // (gangs.js reads `draft` on /gang-runs/:id/plan). It gets the badge
            // outright, the same one a single line gets, because it means the same
            // thing about the same button. The condition is `gangDraft` verbatim,
            // so the row and the engine footer can never disagree about whether
            // this run has something saved.
            //
            // MIXED — a locked member beside a saved one — is not run-level saved
            // and must not wear the badge: no route can save half a run, and the
            // statuses are the honest answer. A member gets there per-line (saved
            // as a single before it was tagged Gang, or re-derived by a qty/spec
            // edit). But the filter chip counts such a run — rowDraft is ANY
            // member — so a row matching "Saved" with nothing on it to say why
            // reads as a bug in the filter. The count names it instead.
            const sts = [...new Set(l._gang.map(m => m.status))];
            const savedN = l._gang.filter(m => m.plan_draft).length;
            if (sts.length === 1 && sts[0] === 'pending' && savedN) return (
              <div className="flex flex-col items-start gap-1">
                <PlanSavedBadge />
                <MgtChip a={approvals[l._gang[0].id]} />
              </div>
            );
            return (
              <div className="flex flex-col items-start gap-1">
                {sts.map(s => <StatusBadge key={s} status={s} />)}
                {sts.length === 1 && <span className="text-[10px] font-semibold text-violet-500">whole gang</span>}
                {savedN > 0 && (
                  <span className="text-[10px] font-semibold text-blue-600">
                    {savedN} of {l._gang.length} saved
                  </span>
                )}
                <MgtChip a={approvals[l._gang[0].id]} />
              </div>
            );
          } },
          { key: 'act', label: '', width: 'w-[108px]', colClass: PLAN_CELL, sortable: false, render: l => l._gang
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
                : <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => openPlan(l)}>
                    {/* This branch also catches in_production / produced / dispatched —
                        the engine opens on them READ-ONLY, so the button must not
                        promise planning it cannot do. It said "Plan" on a job that was
                        already cut and printed. */}
                    <Wrench size={13} /> {['pending', 'planned'].includes(l.status) ? 'Plan' : 'View Plan'}
                  </Button>}
              {/* ONE menu. This cell used to carry two ⋯ buttons — workflow and
                  danger — that were pixel-identical and both said "More
                  actions", so which held Delete was pure guesswork. */}
              <WorkflowControls line={l} context="planning" onDone={load} asMenu includeDanger
                extraItems={[
                  // Unsave. Offered off the same ONE rule the badge renders from
                  // (l.plan_draft), so the row that says "Saved · lock pending"
                  // is exactly the row that can take it back — and never a
                  // ganged line, whose plan belongs to the run (the route 409s
                  // it, and a menu item that can only fail is not an option).
                  // planEditableRow, not the engine's planEditable: that one
                  // reads planLine, which is null when this menu is opened from
                  // the queue.
                  ...(canPlanRole && l.plan_draft && !l.gang_run_id && planEditableRow(l)
                    ? [{ key: 'discard_plan', label: 'Discard saved plan', icon: Undo2, tone: 'danger', onClick: () => askDiscard(l) }]
                    : []),
                  ...(l.status === 'ready'
                    ? [{ key: 'engine', label: 'Open Planning Engine', width: 'w-[124px]', icon: Wrench, onClick: () => openPlan(l) }]
                    : []),
                  ...mgtMenuItems(l),
                ]} />
            </div>) },
        ]}
        // The screen merges cells so the board fits without scrolling; a PDF
        // or a workbook has no such limit, so the export keeps one fact per
        // column exactly as it always did.
        exportColumns={[
          { key: 'po_number', label: 'PO / Customer',
            export: l => (l._gang
              ? `${l.gang_number}: ${[...new Set(l._gang.map(m => `${m.po_number} — ${m.customer_name}`))].join(' | ')}`
              : `${l.po_number} — ${l.customer_name}`)
              + (l.run_output_number || l.output_number ? ` · Out ${l.run_output_number || l.output_number}` : '') },
          { key: 'po_date', label: 'PO Date',
            export: l => { const a = poAgeOf(l); return a.date ? fmt.date(a.date) + (a.latest ? ` — ${fmt.date(a.latest)}` : '') : '—'; } },
          { key: 'od', label: 'OD', align: 'right',
            export: l => { const d = poAgeOf(l).days; return d == null ? '—' : `${d}d`; } },
          { key: 'product_name', label: 'Product',
            export: l => (l._gang ? l._gang.map(productExport).join(' + ') : productExport(l)) },
          { key: 'coating', label: 'Coating', export: l => specCell(l, coatingOf, fmt.title).text || '—' },
          { key: 'printing', label: 'Printing',
            export: l => (specCell(l, colourTypeOf).mixed ? 'mixed' : colourSummary(gangLead(l))) },
          { key: 'gsm', label: 'GSM', align: 'right', export: l => specCell(l, m => m.gsm).text || '—' },
          { key: 'board_grade', label: 'Board',
            export: l => (l.spec_incomplete ? '—' : specCell(l, m => m.board_name).text || specCell(l, m => m.board_grade).text || '—') },
          { key: 'board_state', label: 'Board Status', export: l => BOARD_FULL[rowBoardState(l)] },
          { key: 'die_number', label: 'Die',
            export: l => {
              const num = specCell(l, m => m.die_number).text;
              const detail = specCell(l, dieDetailOf).text;
              if (!num) return '—';
              return detail ? `${num} (${detail})` : num;
            } },
          { key: 'size', label: 'Size (mm)', export: l => specCell(l, sizeOf).text || '—' },
          { key: 'qty', label: 'Qty', align: 'right',
            export: l => fmt.num(l._gang ? l._gang.reduce((s, m) => s + (+m.qty || 0), 0) : l.qty) },
          { key: 'fg_available', label: 'FG Stock', align: 'right',
            export: l => (l.fg_available > 0 ? fmt.num(l.fg_available) : '—') },
          ...(tab === 'pending' ? [] : [
            { key: 'sheets_required', label: 'Sheets', align: 'right',
              export: l => fmt.num(l._gang ? l._gang.reduce((s, m) => s + (+m.sheets_required || 0), 0) : (l.sheets_required || 0)) },
            { key: 'machine_name', label: 'Press', export: l => l.machine_name || 'via Print Planning' },
          ]),
          { key: 'set_type', label: 'Set Type',
            export: l => SET_TYPE_META[rowSetType(l)].label
              + (rowSetType(l) === 'hold' && holdReasonOf(l) ? ` — ${holdReasonOf(l)}` : '') },
          { key: 'status', label: 'Status', export: l => fmt.title(l._gang ? l._gang[0].status : l.status) },
        ]}
        rows={displayRows} empty={subTab !== 'all' ? {
          single: 'Nothing tagged Single here',
          gang: 'No jobs tagged Gang — use the Set Type dropdown to build this pile',
          new_output: 'Nothing waiting on a new output',
          hold: 'Nothing on hold',
        }[subTab] : {
          pending: 'No lines waiting for planning',
          planned: 'No planned lines',
          completed: 'Nothing pushed to a job card yet',
          all: 'No lines in planning',
        }[tab]}
        exportName="Planning Queue"
        exportSubtitle="Order lines · readiness gates and press assignment"
        exportMeta={() => [`Tab: ${fmt.title(tab)}`,
          ...(subTab !== 'all' ? [`Set type: ${SET_TYPE_META[subTab].label}`] : []),
          // The export names every narrowing the page applied, for the same
          // reason the KPI strip follows the zone: a sheet handed round the
          // plant has to say which set it is.
          ...(draftOnly && draftCount ? ['Filter: plan saved, lock pending'] : [])]}
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
      <Modal wide open={!!planLine} onClose={() => { if (whOpen || consumeLot || masterPrompt || mixConfirm || lockShortConfirm || smartConfirm || commitConfirm || reverseConfirm || discardAsk || prView || dupPr || askMgt) return; dismissEngine(); }}
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
              {position ? position.fresh
                ? (position.drawn
                  ? <span className="ml-1.5 font-bold text-emerald-600">board issued</span>
                  : position.short > 0
                    ? <span className="ml-1.5 font-bold text-indigo-600">fresh PR · {fmt.num(position.short)} to order</span>
                    : <span className="ml-1.5 font-bold text-emerald-600">covered · shelf left free</span>)
                : position.short > 0
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
          {/* Discard saved plan — the inverse of the Save button two along.
              Only on a line that HAS a saved plan (plan_draft), so an engine
              opened on a job nobody has saved offers nothing to undo, and never
              on a gang member: a member can carry plan_draft (saved as a single
              before it was tagged Gang) but its board belongs to the run, and
              the route refuses it. Same gate as the queue row's ⋯ item, which is
              the other way in. */}
          {canPlanRole && planLine?.plan_draft && !planLine?.gang_run_id && (
            <Button variant="danger" disabled={discardBusy} onClick={() => askDiscard(planLine)}
              title="Discard this saved cut plan and release the board it holds">
              <Undo2 size={14} /> Discard Saved Plan
            </Button>
          )}
          <Button variant="secondary" onClick={dismissEngine}>{planEditable ? 'Cancel' : 'Close'}</Button>
          {/* Save — keeps the work, keeps the job in To Plan. Not gated on
              mixOk: an unbalanced mix is exactly the state a planner wants to
              come back to, and savePlan leaves the stored one alone rather
              than sending a half-built one the server would refuse. */}
          {planEditable && planLine?.status === 'pending' && (
            <Button variant="secondary" onClick={onSave} disabled={!calc}
              title="Save this work and leave the job in To Plan">
              Save
            </Button>
          )}
          {planEditable ? (
            // Amber when the plan is SHORT — still enabled (paperwork soft:
            // the lock caps the hold and the shortfall is said out loud), but
            // a short lock must never wear the same coat as a covered one.
            // variant="solid": .btn-brand paints over bg-* utilities.
            position && !position.fresh && !position.drawn && position.short > 0 ? (
              <Button variant="solid" className="!bg-amber-500 !text-white hover:!bg-amber-600"
                onClick={onLock} disabled={!calc || !mixOk}>
                Lock Plan{calc ? ` — ${fmt.num(calc.parent)} parent` : ''} · {fmt.num(position.short)} short
              </Button>
            ) : (
              <Button onClick={onLock} disabled={!calc || !mixOk}>
                Lock Plan{calc ? ` — ${fmt.num(calc.parent)} parent sheets` : ''}
              </Button>
            )
          ) : (
            <span className="flex items-center gap-1.5 whitespace-nowrap rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-bold text-emerald-700">
              <ShieldCheck size={14} />
              Plan locked
              {planLine?.parent_sheets_required ? ` — ${fmt.num(planLine.parent_sheets_required)} parent sheets` : ''}
              {' · '}{fmt.title(planLine?.status)}
            </span>
          )}
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
                    {/* Colour detail follows the type, exactly as in the master:
                        a CMYK-only carton is never shown an empty Pantone box.
                        Hiding does not clear — switching the type back brings
                        the codes with it. */}
                    {colourFormHas.cmyk && (
                      <Field label={<>CMYK Colours{'cmyk_colours' in edited && <Edited />}</>}>
                        <Input type="number" min="0" max="12" value={form.cmyk_colours}
                          onChange={e => setForm({ ...form, cmyk_colours: e.target.value })} />
                      </Field>
                    )}
                    {colourFormHas.pantone && (
                      <Field label={<>Pantone Colours{'pantone_colours' in edited && <Edited />}</>}>
                        <Input type="number" min="0" max="12" value={form.pantone_colours}
                          onChange={e => setForm({ ...form, pantone_colours: e.target.value })} />
                      </Field>
                    )}
                    {colourFormHas.pantone && (
                      <Field label={<>Pantone Codes{'pantone_codes' in edited && <Edited />}</>}>
                        <SpecCombo id="spec-pantone-codes" value={form.pantone_codes} options={specOpts.pantone_codes}
                          placeholder="e.g. Pantone 186 C" onChange={e => setForm({ ...form, pantone_codes: e.target.value })} />
                      </Field>
                    )}
                    <Field label={<>Printing Process{'print_process' in edited && <Edited />}</>}>
                      <SpecCombo id="spec-print-process" value={form.print_process} options={specOpts.print_process}
                        placeholder="e.g. Offset" onChange={e => setForm({ ...form, print_process: e.target.value })} />
                    </Field>
                    {colourFormHas.metallic && (
                      <Field label={<>Metallic Colours{'metallic_colours' in edited && <Edited />}</>}>
                        <Input type="number" min="0" max="12" value={form.metallic_colours}
                          onChange={e => setForm({ ...form, metallic_colours: e.target.value })} />
                      </Field>
                    )}
                    {colourFormHas.metallic && (
                      <Field label={<>Metallic Colour / Code{'metallic_details' in edited && <Edited />}</>}>
                        <SpecCombo id="spec-metallic-details" value={form.metallic_details} options={specOpts.metallic_details}
                          placeholder="e.g. Metallic Gold (Pantone 871 C)" onChange={e => setForm({ ...form, metallic_details: e.target.value })} />
                      </Field>
                    )}
                    {(colourFormHas.pantone || colourFormHas.metallic) && (
                      <Field label={<>Printing Instructions{'print_instructions' in edited && <Edited />}</>} className="col-span-2 sm:col-span-3">
                        <Input value={form.print_instructions} placeholder="Special press instructions"
                          onChange={e => setForm({ ...form, print_instructions: e.target.value })} />
                      </Field>
                    )}
                    {/* Soft, never a gate. The plant has to be able to plan a
                        job while the customer is still choosing the shade. */}
                    {colourWarnings.length > 0 && (
                      <div className="col-span-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 sm:col-span-3">
                        {colourWarnings.map(w => <div key={w.code}>{w.message}</div>)}
                      </div>
                    )}
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
                      Board identity — grade, GSM &amp; sheet follow the finalised board
                      {boardShift && <span className="rounded-full bg-amber-100 px-1.5 py-px text-[9px] font-bold text-amber-700">preview · syncs on Update Master</span>}
                    </div>
                    {/* The board itself is now CHOSEN here, not only previewed.
                        The Warehouse modal answers "what is on the shelf" and
                        stays the right door for that; naming the board this
                        product runs on is a master decision and belongs beside
                        the master fields it drives. Everything under it is read
                        off whatever is picked — grade is the first token of the
                        name, GSM the "NNN gsm" in it, the sheet the board's own
                        parent size — so the four tiles cannot disagree with the
                        board above them the way a hand-typed grade could.
                        The FINALISED board, as this panel's own heading
                        promises — never master_board_name, which is the product
                        master's ORIGINAL choice and is a different board the
                        moment a job carries a board override. Live line 128 is
                        what that cost: the panel read 'Saffire · 290 GSM ·
                        23x36' while the job actually ran on 'Saffire · 320 GSM
                        · 23x36', so the planner built the board mix against the
                        290 — which had no stock — while the 320 sat holding
                        exactly the sheets needed. */}
                    <Field label={<>Board{'board_material_id' in edited && <Edited />}</>}
                      hint="grade · GSM · parent sheet below all read off this board">
                      <SearchableSelect
                        value={boardSel?.id ? String(boardSel.id) : ''}
                        disabled={!planEditable}
                        placeholder="Pick the board…"
                        options={boardOptions}
                        onChange={e => {
                          const b = boards.find(m => String(m.id) === String(e.target.value));
                          if (b && +b.id !== +boardSel?.id) pickBoard(b);
                        }} />
                    </Field>
                    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Stat small label="Board Grade" value={shownGrade || '—'} accent={boardShift ? 'text-amber-600' : undefined} />
                      <Stat small label="GSM" value={shownGsm || '—'} accent={boardShift ? 'text-amber-600' : undefined} />
                      <Stat small wrap label="Sheet (in)"
                        value={boardSel?.sheet_l > 0 && boardSel?.sheet_w > 0 ? `${boardSel.sheet_l} × ${boardSel.sheet_w}` : '—'}
                        accent={boardShift ? 'text-amber-600' : undefined} />
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
                          {/* "Trimmed from" was rendered for ANY difference,
                              including a parent LARGER than the board — the
                              physically impossible state Anik's screenshot
                              caught ("Parent 25×38 trimmed from board
                              23×26.5″"). Oversize now says what is actually
                              wrong; plan-save 409s it on the same rule. */}
                          {calc.parentTrimmed && (calc.parentOversize
                            ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">larger than board {boardSel.sheet_l}×{boardSel.sheet_w}" — cannot be cut from it, fix the parent size</span>
                            : <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">trimmed from board {boardSel.sheet_l}×{boardSel.sheet_w}"</span>)}
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
                  {/* PACKET ADVICE — how the "N parent sheets to issue" above
                      is actually picked off the shelf, since board is stored
                      and handed over in packets and the plan asks for a raw
                      sheet count.

                      ONLY when the line has no mix. A mixed plan gets the same
                      advice per Board Mix row, against each board's own sheets,
                      packet size and lots — and one whole-plan suggestion
                      sitting above several per-board ones would contradict
                      them, because the mix is precisely the case where the
                      requirement is NOT drawn off one board.

                      `required` is calc.parent — the very figure the band above
                      names, not a second derivation of it. The board is
                      boardSel (which may be an unlocked warehouse preview)
                      enriched with its materials master: boardSel itself
                      carries no packet size, and neither does ctx.board.

                      And never on a line that prints in a GANG, for the same
                      reason BoardMix refuses a mix there: the run draws ONE
                      pile off one board for every member, so per-member advice
                      would have three jobs each proposing to open packets out
                      of the same pile. The run's own panel carries it, against
                      the run's combined requirement — and BoardMix's gang
                      notice, immediately below this card, already sends the
                      planner there, so a second pointer here would be noise. */}
                  {ctx && calc && !ctx.gang && mixRows.length === 0 && boardSel && (
                    <PacketAdvice
                      required={calc.parent}
                      board={{ ...(boardMasterFor(boardSel.id) || {}), ...boardSel }}
                      lots={(ctx.mix?.lots || []).filter(l => +l.material_id === +boardSel.id)}
                      chosen={packetChoice[PACKET_SINGLE] ?? null}
                      onChoose={key => setPacketChoice(c => ({ ...c, [PACKET_SINGLE]: key }))} />
                  )}
                </Card>

                {/* Boards We Are Using — the coverage ledger. Owner's own words:
                    "whatever coverage we are going to do should be on the left
                    side, where we are putting out that these are the boards we
                    are using" — so it sits directly under the cut plan, beside
                    the job's own spec, not buried under warehouse intelligence
                    on the right. ctx gates it (mix data lives on ctx), matching
                    the "Loading warehouse…" gate the right column already uses. */}
                {ctx && calc && (
                  <Card icon={Layers} title="Boards We Are Using" sub={`${fmt.num(calc.parent)} required`}>
                    {/* printUps/orderQty are the LIVE cut plan's own figures,
                        never recomputed: calc.ups is the effective "Ups /
                        print sheet" (form value falling back to the line's),
                        and calc.planQty is the order figure Base Sheets is
                        derived from — the balance after FG consumption, so a
                        job partly served from FG stock doesn't read amber-
                        short against cartons this plan was never asked for. */}
                    {/* boardFor is what lets each row carry its own packet
                        advice: the packet size lives only on the materials
                        master, which this page already holds for the board
                        picker — no new server field. */}
                    <BoardMix ctx={ctx} required={calc.parent} rows={mixRows} onChange={setMixRows}
                      printUps={calc.ups} orderQty={calc.planQty}
                      leftovers={mixLeftovers} onLeftovers={setMixLeftovers}
                      boardFor={boardMasterFor}
                      packetChoice={packetChoice} onPacketChoice={setPacketChoice} />
                  </Card>
                )}

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
                        {/* Same word as the Smart Match strips below — the tile
                            row and the strips must read as one vocabulary. */}
                        <Stat small label="In Warehouse" value={fmt.num(position.available)} />
                        <Stat small label="Committed" value={fmt.num(position.committed)} accent={position.committed > 0 ? 'text-amber-600' : 'text-slate-900'} />
                        <Stat small label="Free" value={fmt.num(position.free)}
                          accent={position.free > 0 ? 'text-emerald-600' : 'text-red-600'} />
                        <Stat small label={position.drawn ? 'This Plan · issued' : 'This Plan'} value={fmt.num(calc.parent)}
                          accent={position.drawn ? 'text-emerald-600' : 'text-slate-900'} />
                        <Stat small label="Net After Plan" value={fmt.num(position.net)}
                          accent={position.net >= 0 ? 'text-emerald-600' : 'text-red-600'} />
                      </div>
                      <p className="mt-1.5 text-[10px] text-slate-400">{position.fresh
                        ? 'Parent sheets · this plan buys its board fresh — free stock stays with other jobs'
                        : 'Parent sheets · committed = owed to other live jobs, free = what this plan can still draw'}</p>
                      {/* Whose stock does this plan run on? One choice per plan;
                          a gang decides it once for the whole run (in the Gang
                          Engine), so a member line never shows it here. */}
                      {!ctx.gang && (
                        <div className="mt-2">
                          <div className="flex rounded-xl bg-slate-100 p-1 text-[11px] font-semibold">
                            <button type="button" disabled={!planEditable || sbBusy}
                              onClick={() => setBookingMode('book')}
                              className={`flex-1 rounded-lg px-2 py-1.5 transition-colors disabled:cursor-not-allowed ${stockBooking === 'book'
                                ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                              Book warehouse stock
                            </button>
                            <button type="button" disabled={!planEditable || sbBusy || mixRows.length > 0}
                              onClick={() => setBookingMode('fresh_pr')}
                              className={`flex-1 rounded-lg px-2 py-1.5 transition-colors disabled:cursor-not-allowed ${stockBooking === 'fresh_pr'
                                ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                              Fresh PR — leave stock free
                            </button>
                          </div>
                          {stockBooking === 'fresh_pr' && mixRows.length > 0 ? (
                            <p className="mt-1 text-[10px] font-semibold text-amber-600">
                              A board mix books shelf stock, so locking this mix saves the plan as Book warehouse stock.
                            </p>
                          ) : stockBooking === 'fresh_pr' ? (
                            <p className="mt-1 text-[10px] text-slate-400">
                              {/* free_for_others, NEVER position.free — `free` is THIS job's
                                  view and contains its own hold, so it read "9,000 free for
                                  other products" on a shelf this job had 8,959 of. */}
                              The board stays locked; the {fmt.num(position.free_for_others)} free sheets stay free for other
                              products, and this job buys its full {fmt.num(calc.parent)}.
                            </p>
                          ) : mixRows.length > 0 ? (
                            <p className="mt-1 text-[10px] text-slate-400">A board mix books shelf stock by definition — clear the mix to buy fresh.</p>
                          ) : null}
                        </div>
                      )}
                      {/* The same claim list Smart Match puts under every rival
                          board. Both panels are read side by side; a planner who
                          switches to a suggestion must meet the identical story.
                          figure="claim" because the Committed tile above sums
                          open need PLUS holds — rows carrying open_need alone
                          read "Committed to ACEBROBID — 0" under a tile saying
                          8,959, for the job freezing the shelf. */}
                      <Claimants claimants={ctx.stock.claimants} figure="claim" className="mt-1.5" />
                      {/* A board sitting at nil because it was WRITTEN ON (more left the
                          warehouse than the book held, so the balance was forced to nil
                          rather than going negative) is a different situation from one
                          sitting at nil because it was consumed clean — the book and the
                          shelf may genuinely disagree here and nobody has counted yet.
                          Same amber vocabulary as BoardPicker's StockCell badge. */}
                      {+ctx.stock.open_writeon_qty > 0 && (
                        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                          <span title="Board left the warehouse beyond the book — physical recount pending"
                            className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            written on {fmt.num(ctx.stock.open_writeon_qty)}
                          </span>
                          is inside Available as a book correction, not a counted shelf.
                        </p>
                      )}
                      {/* Without this the panel reads as a contradiction — 500 available,
                          600 this plan, and a net that does not subtract the one from the
                          other — because the draw already happened and is not pending. */}
                      {position.drawn && (
                        <p className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                          Board already issued to cutting — these {fmt.num(calc.parent)} sheets are on the floor, not on the
                          shelf. The {fmt.num(position.available)} available is what is left <i>after</i> this job took its board.
                        </p>
                      )}
                      {/* The commitment row — what this job is HOLDING on this
                          board, and the two buttons that change it. A derived
                          claim (planning a job on a board) has always been the
                          default; this is the planner saying it outright, and
                          taking it back. Never shown once the board is drawn:
                          the sheets are on the floor, and a hold on them would
                          be a claim on stock that has already left. */}
                      {planEditable && !position.drawn && (myCommit.held > 0 || myCommit.takeable > 0) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5">
                          <span className="text-[11px] font-semibold text-slate-600">
                            Committed to this job
                            <b className={`ml-1.5 tabular-nums ${myCommit.held > 0 ? 'text-emerald-700' : 'text-slate-400'}`}>
                              {fmt.num(myCommit.held)}
                            </b>
                            <span className="text-slate-400"> of {fmt.num(calc.parent)} needed</span>
                          </span>
                          <div className="ml-auto flex gap-1.5">
                            {myCommit.takeable > 0 && (
                              <Button size="sm" variant="secondary" disabled={commitBusy}
                                className="!px-2 !py-1 !text-[11px]"
                                onClick={() => setCommitConfirm({ kind: 'commit', materialId: boardSel.id, name: boardSel.name,
                                  qty: myCommit.held + myCommit.takeable, add: myCommit.takeable })}
                                title={`Hold ${fmt.num(myCommit.takeable)} more free sheets against this job`}>
                                <Lock size={11} /> Commit {fmt.num(myCommit.takeable)}
                              </Button>
                            )}
                            {myCommit.held > 0 && (
                              <Button size="sm" variant="ghost" disabled={commitBusy}
                                className="!px-2 !py-1 !text-[11px]"
                                onClick={() => setCommitConfirm({ kind: 'uncommit', materialId: boardSel.id,
                                  name: boardSel.name, qty: myCommit.held })}
                                title="Give these sheets back to free stock">
                                Uncommit
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                      {/* Undo lives here only while Smart Match is not up to carry
                          it — one strip, never two of them offering the same
                          reversal in different words. */}
                      {!smartPanelShown && undoCommitStrip && (
                        <div className="mt-1.5">{undoCommitStrip}</div>
                      )}
                      {!planEditable && ctx.stock.held_for_me > 0 && (
                        <p className="mt-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                          {fmt.num(ctx.stock.held_for_me)} sheets are held for this job
                        </p>
                      )}

                      {(ctx.incoming.prs.length > 0 || ctx.incoming.pos.length > 0) && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {/* Every open PR on the BOARD, each naming the product it
                              buys for. Another product's PR is information, never an
                              alarm — only this product's (or this run's) PR triggers
                              the duplicate confirm (onRaisePr). */}
                          {ctx.incoming.prs.map(p => {
                            const mine = (p.product_id != null && p.product_id === planLine.product_id)
                              || (planLine.gang_run_id != null && p.gang_run_id === planLine.gang_run_id);
                            return (
                              <button key={p.pr_number} type="button" onClick={() => openPrTracker(p)}
                                title={p.product_name
                                  ? `Raised for ${p.product_name}${p.gang_number ? ` (${p.gang_number})` : ''} — track it without leaving the engine`
                                  : 'Not tied to a job — track it without leaving the engine'}
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${mine
                                  ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                                <Truck size={10} /> {p.pr_number} · {fmt.num(p.qty)} · {fmt.title(p.status)}
                                {!mine && <span className="text-slate-400">· {p.gang_number || p.product_code || p.product_name || 'stock'}</span>}
                              </button>
                            );
                          })}
                          {ctx.incoming.pos.map(p => (
                            <span key={p.po_number} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-semibold text-brand-700">
                              <Truck size={10} /> {p.po_number} · {fmt.num(p.pending_qty)} due · {p.vendor_name}
                            </span>
                          ))}
                        </div>
                      )}
                      {(() => {
                        const others = (ctx.incoming.prs || []).filter(p =>
                          !((p.product_id != null && p.product_id === planLine.product_id)
                            || (planLine.gang_run_id != null && p.gang_run_id === planLine.gang_run_id)));
                        const qty = others.reduce((s, p) => s + (+p.qty || 0), 0);
                        return qty > 0 ? (
                          <p className="mt-1.5 text-[10px] font-medium text-slate-400">
                            This board is already under PR for other jobs — {fmt.num(qty)} sheets incoming. That board is theirs; raising for this job stays a fresh, separate PR.
                          </p>
                        ) : null;
                      })()}

                      {/* Shortage, requisition and move-result all live in ONE panel
                          now — the three used to be separate inline rows here, and a
                          successful action made its own result vanish with the
                          shortage that produced it. A fresh_pr plan is not "short",
                          it is buying: same panel, calmer colour, and the quantity is
                          the full requirement less its own PR and held stock.
                          onCoverMix is withheld on a gang because a gang shares one
                          board across every member and the server 409s a mix sent for
                          it — don't offer a seed that can only be refused. See
                          BoardMix's own gang guard, same reasoning. */}
                      <ShortagePanel
                        short={position.short}
                        fresh={position.fresh}
                        ownIncoming={position.own_incoming}
                        prs={minePrs}
                        lastMove={lastMove?.material_id === boardSel?.id ? lastMove : null}
                        role={auth.user?.role}
                        neededBy={planLine.delivery_date}
                        boardName={boardSel?.name}
                        jobLabel={`${planLine.product_name} (PO ${planLine.po_number})`}
                        coverCandidate={(ctx?.mix?.candidates || [])[0]?.name}
                        busy={prBusy}
                        onRaisePr={onRaisePr}
                        onTakeBoard={() => setBoardPanel(true)}
                        onCoverMix={ctx?.gang ? undefined : seedCoverMix}
                        onUndoPr={undoPr}
                        onCancelPr={cancelPr}
                        onTrackPr={openPrTracker}
                        onMoveBack={() => setBoardPanel(true)}
                      />
                      {/* Only when the incoming quantity comes from a PO rather than a
                          live PR. With a PR standing, the panel above already names it
                          and offers the controls — two rows saying the same thing in
                          different words is what this redesign exists to remove. */}
                      {position.fresh && position.short === 0 && !position.drawn && position.own_incoming > 0 && !minePrs.length && (
                        <p className="mt-2.5 rounded-xl bg-emerald-50 px-3 py-2.5 text-xs font-semibold text-emerald-700">
                          Full quantity on order — {fmt.num(position.own_incoming)} sheets incoming for this job. The shelf stays free for other products.
                        </p>
                      )}

                      {/* Smart Match — nearby usable stock, best first */}
                      {smartPanelShown && (
                        <div className="mt-2.5">
                          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                            <Sparkles size={12} className="text-brand-500" /> Smart Match
                            {/* Says what the list is, so a planner hunting a
                                board that is NOT on it knows why: the grade
                                filter, not an empty warehouse. */}
                            <span className="font-semibold normal-case tracking-normal text-slate-300">
                              · {shownGrade || 'same grade'} only
                            </span>
                            {undoCommitStrip && <span className="ml-auto">{undoCommitStrip}</span>}
                          </div>
                          {/* The panel outliving its own shortage is the point of
                              smartPinned, but a list headed "Smart Match" over a
                              job that is no longer short reads as a bug unless it
                              says why it is still here. */}
                          {position.short <= 0 && (
                            <p className="mb-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700">
                              Still listed — this job now holds board here.
                            </p>
                          )}
                          <div className="space-y-1.5">
                            {smartVisible.map(m => (
                              <div key={m.material_id} className="rounded-xl bg-slate-50 px-2.5 py-2 text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${CATEGORY_STYLE[m.category]}`}>{CATEGORY_LABEL[m.category]}</span>
                                  <span className="min-w-0 truncate font-semibold text-slate-800" title={m.name}>{m.name}</span>
                                  {/* Three different decisions, so three
                                      routes. "Commit" reserves this board's
                                      free sheets against the job without
                                      switching to it — the planner holding a
                                      board while they finish deciding had no
                                      way to say so, and the only thing that
                                      stopped somebody else taking it was
                                      speed. "Use" no longer acts on its own:
                                      same grade seeds the mix behind a popup
                                      naming master/using/covers/pending, a
                                      different grade can only swap the plan's
                                      board and says so. */}
                                  <div className="ml-auto flex shrink-0 gap-1">
                                    {m.free > 0 && planEditable && !position.drawn && (
                                      <Button size="sm" variant="ghost" disabled={commitBusy}
                                        className="!px-2 !py-1 !text-[11px]"
                                        onClick={() => setCommitConfirm({ kind: 'commit', materialId: m.material_id, name: m.name,
                                          qty: Math.min(m.free, m.parent_needed) })}
                                        title={`Hold ${fmt.num(Math.min(m.free, m.parent_needed))} sheets of ${m.name} against this job`}>
                                        <Lock size={11} /> Commit
                                      </Button>
                                    )}
                                    {/* Giving board back was only ever reachable for
                                        the SELECTED board — a planner who committed
                                        from this list had to switch the plan onto
                                        that board to undo it. heldHere is what makes
                                        this offerable: the row's own `committed` is
                                        the whole claim on the shelf and cannot say
                                        which part is ours. Session-scoped, so a
                                        reload drops the button, not the hold. */}
                                    {heldHere[m.material_id] > 0 && planEditable && !position.drawn && (
                                      <Button size="sm" variant="ghost" disabled={commitBusy}
                                        className="!px-2 !py-1 !text-[11px]"
                                        onClick={() => setCommitConfirm({ kind: 'uncommit', materialId: m.material_id,
                                          name: m.name, qty: heldHere[m.material_id] })}
                                        title={`Give the ${fmt.num(heldHere[m.material_id])} sheets held for this job back to free stock`}>
                                        Uncommit
                                      </Button>
                                    )}
                                    <Button size="sm" variant="secondary" className="!px-2.5 !py-1 !text-[11px]"
                                      onClick={() => setSmartConfirm({ match: m, kind: smartSameGrade(m) ? 'mix' : 'swap' })}>Use</Button>
                                  </div>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums text-[11px] text-slate-500">
                                  <span>{m.parent_size} · {m.children_per_parent}/parent</span>
                                  <span className={m.cut_waste_pct <= 10 ? 'text-emerald-600' : m.cut_waste_pct <= 20 ? 'text-amber-600' : 'text-red-500'}>{m.utilization}% util</span>
                                </div>
                                {/* The triple on its own line — three labelled figures
                                    beat a run of prose, and every row answers the same
                                    three questions in the same three places. */}
                                <StockSplit available={m.available} committed={m.committed}
                                  free={m.free} short={m.short} sufficient={m.sufficient} className="mt-1.5" />
                                {/* Never a bare "free" figure when jobs are behind it.
                                    `need`, because the StockSplit above quotes
                                    claimsByBoard's committed — the whole claim on the
                                    shelf — and the rows have to total the figure they
                                    are explaining. The Board Position card opposite
                                    passes figure="claim" for the same reason: its
                                    Committed tile is open need PLUS holds now. */}
                                <Claimants claimants={m.claimants} figure="need" className="mt-1" />
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

                      {/* The board's lot list used to print here as
                          "FIFO: <batch> (qty) · …". Removed with the mix row's
                          FIFO select for the same reason: it named a draw order
                          the planner does not choose and cannot change from
                          this screen. Naming a lot is still possible where it
                          means something — BoardMix shows the picker whenever a
                          board carries more than one lot. `ctx.batches` stays on
                          the API response; nothing else reads it today, and it
                          costs one small query that the warehouse views may yet
                          want. */}
                    </>
                  )}
                </Card>

                {/* Leftover offcut — banked into Leftover RM the moment this cut
                    is locked (as "planned"); cutting-complete trues it up to the
                    actual parents cut and marks it "confirmed". Strips come from
                    loStrips (the LIVE cut plan), never ctx.leftover, so trimming
                    the parent re-measures the offcut in place instead of leaving
                    the board's untrimmed strip on screen. */}
                {loStrips.length > 0 && (
                  <Card icon={Scissors} title="Leftover"
                    sub="offcut strips this cut plan leaves on the parent sheet">
                    <div className="space-y-1.5">
                      {loStrips.map((s, i) => {
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
                      {loStrips.some(s => s.usable) ? (
                        <>
                          <Checkbox label="Bank to Leftover RM on lock"
                            checked={lo.push}
                            onChange={e => setLo(v => {
                              if (!e.target.checked) return { push: false, strip: v.strip };
                              const first = loStrips.find(s => s.usable);
                              return { push: true, strip: v.strip || (first ? { l: first.l, w: first.w } : null) };
                            })} />
                          {lo.push && !lo.strip && <p className="text-[10px] text-amber-600">Pick which strip to keep.</p>}
                        </>
                      ) : (
                        <p className="text-[10px] text-slate-500">
                          Nothing bankable — this cut leaves under 3" on the short side.
                        </p>
                      )}
                    </div>
                  </Card>
                )}

                {/* Gang run — the other jobs sharing this press run */}
                {ctx?.gang && (
                  <Card icon={Link2} title={`Gang ${ctx.gang.gang_number}`} sub="prints together">
                    <div className="space-y-1.5">
                      {ctx.gang.members.map(m => (
                        <div key={m.id} className={`flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-xs ${m.id === planLine.id ? 'bg-violet-50' : 'bg-slate-50'}`}>
                          <ProductIdentity row={m} compact className="min-w-0" codesClassName="max-w-[220px]"
                            meta={m.id === planLine.id ? 'this job' : ''} />
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
      <Modal open={!!gangSel} onClose={() => setGangSel(null)}
        title={gangSel && new Set(gangSel.map(l => l.product_id)).size === 1
          ? 'Combine these orders into one run'
          : 'Gang these jobs on one press run'}
        footer={<>
          <Button variant="secondary" onClick={() => setGangSel(null)}>Cancel</Button>
          {gangSel && new Set(gangSel.map(l => l.product_id)).size === 1 ? (
            <Button className="!bg-teal-600 hover:!bg-teal-700" onClick={createGang}
              disabled={gangBusy || (gangSel?.length ?? 0) < 2}>
              <Layers size={14} /> Combine {gangSel?.length} Orders
            </Button>
          ) : (
            <Button onClick={createGang} disabled={gangBusy || !gangCheck?.ok || (gangSel?.length ?? 0) < 2}>
              <Link2 size={14} /> Gang {gangSel?.length} Jobs
            </Button>
          )}
        </>}>
        {gangSel && (
          <div className="space-y-3">
            {new Set(gangSel.map(l => l.product_id)).size === 1 ? (
              <p className="rounded-xl bg-teal-50 px-3 py-2.5 text-sm text-teal-800">
                Every order here is <b>{gangSel[0].product_name}</b> — the same carton. Combined, they run as
                <b> ONE job</b> through every stage (no split after die cutting: one sort, one paste, one QC),
                and the pile is <b>allocated back per sales order at dispatch</b>, earliest delivery first.
              </p>
            ) : (
            <>
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Ganged jobs <b>print together</b>: they share the board, run back-to-back on the same press,
              and buy their board shortage on <b>one</b> purchase requisition.
            </p>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
              The system remembers your dies: a combination it has run before arrives with its layout
              already filled in — a new one asks for the ups and the final child size once, then remembers it.
            </p>
            </>
            )}
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
      {/* onClose respects the dialogs stacked ON this modal — the discard confirm
          and the gang sheet's master prompt both render above it, and a click
          landing on the backdrop would otherwise close the engine out from under
          the question it is asking (the single engine's own onClose guards the
          same way, against its own list). */}
      <Modal wide open={!!gangView} onClose={() => { if (gangDiscardAsk || gangSheetPrompt) return; setGangView(null); }}
        title={gangView
          ? gangView.kind === 'merge'
            ? `Combined Run — ${gangView.gang_number} · ${gangView.members.length} sales orders, one pile`
            : `Gang Engine — ${gangView.gang_number} · ${gangView.members.length} products on one sheet`
          : ''}
        footer={<>
          {/* The engine opens from a run chip on the row, which anyone holding
              the planning module can click — so breaking the run up needs its
              own guard, not just the one on the bulk build buttons. */}
          {canPlanRole && <Button variant="ghost" className="!text-red-500" onClick={gangDissolve}>Dissolve</Button>}
          {canPlanRole && gangView?.members?.some(m => ['planned', 'ready'].includes(m.status)) && (
            <Button variant="danger" onClick={() => setGangReverseOpen(true)}>
              <Undo2 size={14} /> Reverse Plan
            </Button>
          )}
          {gangView && (() => {
            const effIssue = gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets);
            const overridden = gangIssue !== '' && +gangIssue !== gangCalc?.parent;
            // Same arithmetic as the Board Position card above, incoming PRs
            // and all — a footer that still cried "short" while the card said
            // "on order" is what sent the planner back to the button.
            const onOrder = gangView.position?.incoming ?? 0;
            // A fresh_pr run refuses the shelf: its still-to-buy is what the
            // run presses (mix-credited via gangPressingOnPlanned) less its
            // own PR and the stock already held for the run. Twin of
            // gangPosition's rule — the Board Position card carries the same
            // branch.
            const { short, freshRun } = gangShortNow ?? { short: 0, freshRun: false };
            return (
              <span className="mr-auto self-center pl-1 text-xs text-slate-500">
                <b className="text-slate-800">{fmt.num(effIssue)} parent</b> to issue
                {overridden && <span className="ml-1 text-amber-600">(manual)</span>}
                {short > 0
                  ? <span className={`ml-1.5 font-bold ${freshRun ? 'text-indigo-600' : 'text-red-600'}`}>{freshRun ? `fresh PR · ${fmt.num(short)} to order` : `short ${fmt.num(short)}`}</span>
                  : onOrder > 0
                    ? <span className="ml-1.5 font-bold text-sky-600">{fmt.num(onOrder)} on order{freshRun ? ' · shelf left free' : ''}</span>
                    : <span className="ml-1.5 font-bold text-emerald-600">stock OK</span>}
              </span>
            );
          })()}
          {/* Discard the run's saved plan — the inverse of Save below, and the
              run-level twin of the single engine's "Discard Saved Plan" (same
              variant, same icon, same position before Cancel, so the two engines
              read as one product). Only when a save actually exists: gangDraft
              is the server's own plan_draft pair read across the members. */}
          {canPlanRole && gangView && gangDraft && (
            <Button variant="danger" disabled={gangDiscardBusy || gangBusySave || gangBusyLock}
              onClick={() => askGangDiscard(gangView)}
              title="Discard this saved run plan and release the board it holds — the run stays together">
              <Undo2 size={14} /> Discard Saved Plan
            </Button>
          )}
          <Button variant="secondary" onClick={() => setGangView(null)}>Cancel</Button>
          {/* Save — keeps the work, keeps every member in To Plan. Offered only
              while the whole run is still pending: one locked member means the
              run's board is already live, and a draft there would write figures
              without un-locking anything — a click with no visible effect. That
              run's door is Reverse Plan, already in this footer.
              Deliberately NOT gated on gangMixOk, exactly as the single engine's
              Save is not: an unbalanced mix is the state a planner most wants to
              come back to, and gangPlanPayload withholds it rather than sending
              one the server would refuse. */}
          {canPlanRole && gangView && gangEveryPending && (
            <Button variant="secondary" onClick={saveGangPlan}
              disabled={gangBusySave || gangBusyLock || !gangCalc}
              title="Save this work and leave the run in To Plan">
              {gangBusySave ? 'Saving…' : 'Save'}
            </Button>
          )}
          {/* () => lockGangPlan() and never a bare reference: the click event
              would land in confirmedShort, truthy, and silently skip the
              short-lock confirm. Amber when short — enabled (paperwork soft),
              never dressed like a covered lock; variant="solid" because
              .btn-brand paints over bg-* utilities. */}
          <Button onClick={() => lockGangPlan()}
            {...(gangShortNow && !gangShortNow.freshRun && gangShortNow.short > 0
              ? { variant: 'solid', className: '!bg-amber-500 !text-white hover:!bg-amber-600' } : {})}
            disabled={gangBusyLock || gangBusySave || !gangView || (gangView.layout_pending && !gangView.layout_fallback_child) || !gangMixOk}
            title={gangView?.layout_pending
              ? (gangView.layout_fallback_child
                  ? `Locks on the members' agreed ${gangView.layout_fallback_child.l}×${gangView.layout_fallback_child.w}" child sheet and saves it as the layout — the Run Sheet can still change it later`
                  : 'Layout pending — the members carry no single agreed child sheet size; enter it in the Run Sheet first')
              : undefined}>
            {gangView?.kind === 'merge' ? <Layers size={13} /> : <Link2 size={13} />} {gangView?.kind === 'merge' ? 'Lock Run Plan' : 'Lock Gang Plan'}{gangView ? ` — ${fmt.num(gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets))} sheets` : ''}{gangShortNow && !gangShortNow.freshRun && gangShortNow.short > 0 ? ` · ${fmt.num(gangShortNow.short)} short` : ''}
          </Button>
        </>}>
        {gangView && (() => {
          const anchor = gangView.members[0];
          // Teal is the combined run's colour, violet the gang's — one helper
          // so every accent inside this modal follows the run's kind. Both
          // class strings stay literal for Tailwind's scanner.
          const mergeMode = gangView.kind === 'merge';
          const tv = (violet, teal) => (mergeMode ? teal : violet);
          const boardsDiffer = new Set(gangView.members.map(m => m.board_material_id)).size > 1;
          const totalQty = gangView.members.reduce((s, m) => s + (+m.qty || 0), 0);
          return (
          <div className="space-y-4">
            {/* Run ribbon */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat small label={gangView.kind === 'merge' ? 'Combined Run' : 'Gang'} value={gangView.gang_number} />
              <Stat small label={gangView.kind === 'merge' ? 'Sales Orders' : 'Products'} value={gangView.members.length} />
              <Stat small label="Combined Qty" value={fmt.num(totalQty)} />
              <Stat small wrap label="Shared Board" value={boardsDiffer ? 'mixed — set one' : `${anchor?.board_grade ? anchor.board_grade + ' · ' : ''}${anchor?.board_name || '—'}`}
                accent={boardsDiffer ? 'text-amber-600' : undefined} />
            </div>

            {/* Saved · lock pending — the same badge the queue row wears, said
                once on the face of the engine. It answers the question a planner
                reopening a run actually has ("is what I'm looking at saved, or am
                I about to lose it?") in the one place they are already looking,
                and it names what the save is holding: the figure beside it is the
                board this draft has committed, which is exactly what Discard
                gives back. Absent on a locked run and on one never saved, so it
                only ever appears when it is telling the planner something. */}
            {gangDraft && (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50/70 px-3.5 py-2.5">
                <PlanSavedBadge />
                <span className="text-[11px] font-semibold text-blue-700">
                  This plan is <b>saved</b> — every member stays in To Plan until the run is locked.
                  {gangView.mix?.rows?.length
                    ? <> It is holding <b>{fmt.num(gangView.mix.rows.reduce((s, r) => s + (Number(r.sheets) || 0), 0))} sheets</b>
                      {' '}across {gangView.mix.rows.length} board{gangView.mix.rows.length === 1 ? '' : 's'}; Discard gives that back.</>
                    : ' No board is held against it yet.'}
                </span>
              </div>
            )}

            {gangView.kind === 'merge' ? (
              /* Journey — one pile, the whole route, split back per PO at dispatch */
              <p className="flex items-start gap-2 rounded-2xl border border-teal-200 bg-teal-50/70 px-3.5 py-2.5 text-[11px] font-semibold text-teal-700">
                <Layers size={14} className="mt-0.5 shrink-0" />
                <span>One carton · one pile: {gangView.members.length} sales orders of <b>{anchor?.product_name}</b> run as
                  <b> ONE job through every stage</b> — no split after die cutting, one sort, one paste, one QC.
                  The pile divides <b>on paper at dispatch</b>: one challan and one invoice <b>per sales order</b>,
                  earliest delivery first, overs boxed as leftover.</span>
              </p>
            ) : (
            /* Journey — together until die punching, then split into cartons */
            <p className="flex items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50/70 px-3.5 py-2.5 text-[11px] font-semibold text-violet-700">
              <Link2 size={14} className="mt-0.5 shrink-0" />
              <span>One sheet · one press run: all {gangView.members.length} products cut, print and travel <b>together up to die punching</b>,
                then split into individual cartons — each carton runs its own journey (sorting → pasting → QC) in its own cell.</span>
            </p>
            )}

            {/* SHARED layout: the state machine on the face of the modal. While
                the final child size is missing the gang is LAYOUT PENDING — a
                soft state when the members' specs already agree on one sheet
                (locking the plan adopts and saves that size), a hard wait only
                when nothing agrees; once settled, the run preview shows the
                co-printed MAX and who gains overs. */}
            {gangView.kind !== 'merge' && (
              <div className="-mt-2 flex justify-end">
                <button type="button" onClick={flipLayoutMode}
                  title={gangView.layout_mode === 'shared'
                    ? 'This gang plans as ONE co-printed die (run = the largest job). Switch to classic separate-children maths (run = sum of jobs).'
                    : 'This gang plans as separate children (run = sum of jobs). Switch to a co-printed die (run = the largest job, one layout).'}
                  className="text-[10px] font-semibold text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline">
                  die: {gangView.layout_mode === 'shared' ? 'co-printed (one layout)' : 'separate children'} — switch
                </button>
              </div>
            )}
            {gangView.layout_mode === 'shared' && (gangView.layout_pending ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-[11px] font-semibold text-amber-800">
                <AlertTriangle size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  {gangView.layout_fallback_child ? (<>
                    <b>Layout Pending</b> — {gangView.layout_reason}. The members already agree on{' '}
                    <b>{gangView.layout_fallback_child.l}×{gangView.layout_fallback_child.w}"</b> through their
                    spec, so <b>locking the plan saves that size as this layout</b> and proceeds — enter a
                    different size in the Run Sheet below if the designer's nesting lands elsewhere.
                  </>) : (<>
                    <b>Layout Pending</b> — {gangView.layout_reason}. Enter each job's <b>ups</b> in the members
                    table and the <b>final child sheet size</b> in the Run Sheet below once the designer settles
                    the nesting. Smart Match, Plan and the Job Card wait until then.
                  </>)}
                  {!gangView.die_memory && (
                    <span className="mt-1 block font-medium text-amber-700/80">
                      First time for this combination — the layout you lock will be <b>remembered</b>, and the
                      next gang of these products will arrive with it filled in.
                    </span>
                  )}
                </span>
              </div>
            ) : gangView.layout_run && (
              <div className="rounded-2xl border border-violet-200 bg-white/70 px-3.5 py-2.5 text-[11px]">
                {gangView.die_memory && (
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[10px] font-bold uppercase tracking-wide text-emerald-600">
                    <CheckCircle2 size={11} /> Die remembered — “{gangView.die_memory.name}”
                    {gangView.die_memory.last_gang_number && <span className="font-semibold normal-case text-slate-400">last locked on {gangView.die_memory.last_gang_number}</span>}
                    <span className="font-semibold normal-case text-slate-400">· fully editable — locking the plan updates the memory</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-semibold text-slate-700">
                  <span className="font-bold uppercase tracking-wide text-violet-500">Co-printed run</span>
                  <span>child {gangView.layout_child?.l}×{gangView.layout_child?.w}"</span>
                  <span>{gangView.total_ups} ups total</span>
                  <span><b className="tabular-nums">{fmt.num(gangView.layout_run.run_child)}</b> child sheets
                    {gangView.layout_run.run_child !== gangView.layout_run.need_child &&
                      <span className="text-slate-400"> (incl. wastage)</span>}
                    {/* The parent conversion, spelled out — this banner's child
                        count read as "sheets" is exactly how 1,200 child got
                        typed into the parent issue box on CI-GANG-0010. */}
                    {gangView.layout_run.run_parent != null && <>
                      <span className="text-slate-400"> → </span>
                      <b className="tabular-nums">{fmt.num(gangView.layout_run.run_parent)}</b> parent
                      <span className="text-slate-400"> ({gangView.layout_run.cpp}/parent)</span>
                    </>}
                    <span className="text-slate-400"> — the largest job sets the run; one sheet prints everyone</span>
                  </span>
                </div>
                {gangView.layout_run.per.some(x => x.overs > 0) && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold text-amber-700">
                    <AlertTriangle size={12} className="shrink-0" />
                    {gangView.layout_run.per.filter(x => x.overs > 0).map(x => {
                      const m = gangView.members.find(mm => mm.id === x.id);
                      return <span key={x.id}>{m?.product_code}: +{fmt.num(x.overs)} overs (ratio ≠ orders — they go to FG/leftover)</span>;
                    })}
                  </div>
                )}
              </div>
            ))}

            {/* A same-carton GANG is the old workaround for what a Combined Run
                does properly — say so, on the spot, with the one-click fix. */}
            {gangView.kind !== 'merge' && new Set(gangView.members.map(m => m.product_id)).size === 1 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-teal-300 bg-teal-50 px-3.5 py-2.5 text-[11px] font-semibold text-teal-800">
                <Layers size={14} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  Every job in this gang is the <b>same carton</b> ({anchor?.product_code}) on {gangView.members.length} sales
                  orders. A gang splits after die cutting, so sorting, pasting and QC would each run {gangView.members.length} times
                  over one identical pile. Combine them into one run instead.
                </span>
                <Button size="sm" className="!bg-teal-600 hover:!bg-teal-700" disabled={gangConvertBusy}
                  onClick={convertGangToMerge}>
                  <Layers size={12} /> {gangConvertBusy ? 'Combining…' : 'Combine into One Run'}
                </Button>
              </div>
            )}

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)]">
              {/* ── LEFT: products (qty × ups), add/remove, common sheet, wastage ── */}
              <div className="min-w-0 space-y-4">
                <Card icon={Layers}
                  title={gangView.kind === 'merge' ? 'Sales orders in this run' : 'Products in this gang'}
                  sub={gangView.kind === 'merge' ? 'one carton — each PO keeps its own quantity' : 'each keeps its own qty & ups on the shared sheet'}>
                  <div className={`overflow-hidden rounded-xl border ${tv('border-violet-200/70', 'border-teal-200/70')}`}>
                    <div className={`grid grid-cols-[minmax(0,1fr)_64px_52px_66px_auto] items-center gap-x-2 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${tv('bg-violet-100/60 text-violet-600', 'bg-teal-100/60 text-teal-700')}`}>
                      <span>Product</span><span className="text-right">Qty</span><span className="text-right">Ups</span><span className="text-right">Sheets</span><span />
                    </div>
                    {gangView.members.map((m, i) => {
                      const editable = ['pending', 'planned', 'ready'].includes(m.status);
                      const d = gangEdits[m.id] || { qty: String(m.qty ?? ''), ups: String(m.ups ?? '') };
                      const dirty = gangMemberDirty(m);
                      const expanded = gangExpand === m.id;
                      return (
                        <div key={m.id} className={i ? `border-t ${tv('border-violet-200/60', 'border-teal-200/60')}` : ''}>
                          <div className={`grid grid-cols-[minmax(0,1fr)_64px_52px_66px_auto] items-center gap-x-2 px-3 py-2 ${expanded ? tv('bg-violet-100/50', 'bg-teal-100/50') : tv('bg-violet-50/40', 'bg-teal-50/40')}`}>
                            <div className="min-w-0">
                              <button type="button" onClick={() => openSpec(m)} title="Open this product's full spec — child size, colours, coating, finish"
                                className="group flex min-w-0 items-center gap-1 text-left">
                                {expanded ? <ChevronDown size={12} className={`shrink-0 ${tv('text-violet-500', 'text-teal-600')}`} /> : <ChevronRight size={12} className={`shrink-0 ${tv('text-violet-400', 'text-teal-500')}`} />}
                                <span className={`truncate text-xs font-bold text-slate-800 ${tv('group-hover:text-violet-700', 'group-hover:text-teal-700')}`}>{m.product_name}</span>
                                {m.jc_number && <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-px text-[9px] font-bold text-brand-700">{m.jc_number}</span>}
                              </button>
                              <div className="flex items-center gap-1.5 pl-4 text-[10px] text-slate-400">
                                <span className="truncate">{m.child_l ? `${m.child_l}×${m.child_w}" child · ` : ''}{m.colors}c · {fmt.title(m.coating)}</span>
                                {/* Co-printed: what the run YIELDS this product —
                                    run sheets × its ups, every sheet printing it. */}
                                {gangCalc?.sharedMode && gangCalc.yieldByMember?.[m.id] != null && (
                                  <span className={`shrink-0 font-semibold tabular-nums ${tv('text-violet-500', 'text-teal-600')}`}
                                    title="What the co-printed run yields this product if every sheet prints — run sheets × its ups">
                                    → {fmt.num(gangCalc.yieldByMember[m.id])} pcs</span>
                                )}
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
                            <span className="text-right text-xs font-bold tabular-nums text-slate-700"
                              title={gangCalc?.sharedMode
                                ? "This product's own maths — reference only. The gang co-prints on one sheet, so the run buys the gang-level parent figure below, never this sum."
                                : undefined}>
                              {fmt.num(gangCalc?.per?.find(p => p.id === m.id)?.parent ?? m.parent_sheets)}</span>
                            <div className="flex items-center gap-0.5 pl-1">
                              {dirty
                                ? <button type="button" title="Save qty / ups" className="rounded-lg bg-brand-500 p-1 text-white hover:bg-brand-600" onClick={() => saveGangMember(m)}><Check size={13} /></button>
                                : <span className="w-[25px]" />}
                              {canPlanRole && <button type="button" title="Remove from gang" className="rounded-lg p-1 text-slate-300 hover:bg-red-50 hover:text-red-500" onClick={() => gangRemoveLine(m.id)}><X size={13} /></button>}
                            </div>
                          </div>
                          {/* Per-product master card. Parent · child · coating are
                              LOCKED at the gang level (shared sheet) — here we show
                              each product's own master (board grade, GSM, size,
                              pasting, embossing, effects — applied after the split)
                              and edit only its identity (artwork / set no / shade). */}
                          {expanded && gangSpecForm && (
                            <div className={`border-t ${tv('border-violet-200/60', 'border-teal-200/60')} bg-white px-3 py-3 space-y-3`}>
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
                                <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide ${tv('text-violet-500', 'text-teal-600')}`}><Palette size={11} /> Layout identity — editable</div>
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
                                <button type="button" onClick={() => openGangEngine(m)} className={`inline-flex items-center gap-1 text-[10px] font-bold ${tv('text-violet-600', 'text-teal-600')} hover:underline`}>
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
                    <div className={`border-t-2 px-3 py-1.5 text-[11px] font-bold ${tv('border-violet-300 bg-violet-100/60 text-violet-800', 'border-teal-300 bg-teal-100/60 text-teal-800')}`}>
                      <div className="flex items-center justify-between">
                        <span>{gangView.members.length} products · {fmt.num(totalQty)} pcs</span>
                        <span className="tabular-nums">
                          {fmt.num(gangCalc?.parent ?? gangView.total_parent_sheets)} parent sheets
                          {gangCalc?.sharedMode && <span className="font-semibold"> — one co-printed run</span>}
                        </span>
                      </div>
                      {/* Co-printed: the SHEETS column above is each product's own
                          maths, kept as reference — the run buys the gang-level
                          figure, never that sum. Wastage is one allowance. */}
                      {gangCalc?.sharedMode && (
                        <div className={`mt-0.5 flex flex-wrap items-center justify-end gap-x-3 text-[10px] font-semibold tabular-nums ${tv('text-violet-600/80', 'text-teal-600/80')}`}>
                          <span>products' own sum {fmt.num(gangCalc.naturalParent)} — reference</span>
                          <span>wastage {fmt.num(gangCalc.childWastage)} child → {fmt.num(gangCalc.parentWastage)} parent</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Add product */}
                  {gangAddable ? (
                    <div className={`mt-2.5 rounded-xl border border-dashed p-2.5 ${tv('border-violet-300 bg-violet-50/30', 'border-teal-300 bg-teal-50/30')}`}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className={`text-[11px] font-bold ${tv('text-violet-700', 'text-teal-700')}`}>{mergeMode ? `Add sales orders to ${gangView.gang_number}` : `Add products to ${gangView.gang_number}`}</span>
                        <button type="button" className="text-slate-300 hover:text-slate-500" onClick={() => setGangAddable(null)}><X size={13} /></button>
                      </div>
                      {gangAddable.length === 0 ? (
                        <p className="py-3 text-center text-[11px] text-slate-400">No other jobs are free to gang right now.</p>
                      ) : (
                        <div className="max-h-52 space-y-1 overflow-y-auto">
                          {gangAddable.map(l => (
                            <label key={l.id} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${gangAddSel.includes(l.id) ? tv('bg-violet-100', 'bg-teal-100') : tv('bg-white hover:bg-violet-50', 'bg-white hover:bg-teal-50')}`}>
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
                      className={`mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2 text-[11px] font-bold transition-colors ${tv('border-violet-300 text-violet-600 hover:bg-violet-50', 'border-teal-300 text-teal-600 hover:bg-teal-50')}`}>
                      <Plus size={13} /> {gangView.kind === 'merge' ? 'Add another sales order of this carton' : 'Add another product to this gang'}
                    </button>
                  )}
                </Card>

                {/* ══ Gang Sheet — the ONE shared sheet: parent · child · coating.
                       Locked here, this is the single source of truth for the run. ══ */}
                <Card icon={Scissors}
                  title={mergeMode ? 'Run Sheet — parent · child · coating' : 'Gang Sheet — parent · child · coating'}
                  sub={mergeMode ? 'single source of truth · locked for the whole run' : 'single source of truth · locked for the whole gang'}>
                  {/* Parent (board) */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`text-[10px] font-bold uppercase tracking-wide ${tv('text-violet-500', 'text-teal-600')}`}>Parent (board)</div>
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
                        <div className={`mb-1.5 text-[10px] font-bold uppercase tracking-wide ${tv('text-violet-500', 'text-teal-600')}`}>Child (press sheet) &amp; coating — shared</div>
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
                          {mergeMode
                            ? <>Parent, child &amp; coating are the run's single source of truth — one carton, one layout, one pile end to end.</>
                            : <>Parent, child &amp; coating are the gang's single source of truth. Pasting, embossing &amp; other effects stay per product from each master — they run per carton after the split at die punching.</>}
                        </p>
                      </div>
                    );
                  })()}

                  {/* Smart Match suggestions — ranked boards for the whole gang */}
                  {gangSmart && (
                    <div className={`mt-2.5 rounded-xl border p-2 ${tv('border-violet-200 bg-violet-50/40', 'border-teal-200 bg-teal-50/40')}`}>
                      <div className="mb-1 flex items-center justify-between">
                        <span className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide ${tv('text-violet-600', 'text-teal-700')}`}><Sparkles size={11} /> {mergeMode ? 'Best boards for this run' : 'Best boards for this gang'}</span>
                        <button type="button" className="text-slate-300 hover:text-slate-500" onClick={() => setGangSmart(null)}><X size={12} /></button>
                      </div>
                      {gangSmart.length === 0 ? (
                        <p className="py-2 text-center text-[11px] text-slate-400">No matching board in stock — try Manual.</p>
                      ) : (
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {gangSmart.map(mm => (
                            <button key={mm.material_id} type="button" onClick={() => pickSmartBoard(mm)}
                              className={`flex w-full items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-left text-xs ring-1 ring-slate-100 ${tv('hover:bg-violet-50', 'hover:bg-teal-50')}`}>
                              <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold text-slate-800">{mm.name}</div>
                                <div className="truncate text-[10px] text-slate-400">
                                  {mm.sheet_l}×{mm.sheet_w}"{mm.children_per_parent ? ` · ${mm.children_per_parent}/parent` : ''}{mm.utilization != null ? ` · ${mm.utilization}% util` : ''}
                                </div>
                                {/* Same labelled triple as the single-job engine —
                                    one vocabulary, whichever door the planner came in. */}
                                <StockSplit available={mm.available} committed={mm.committed}
                                  free={mm.free} short={mm.short} sufficient={mm.sufficient} className="mt-1" />
                                {/* The row is itself a button, so the claim cannot
                                    be an expander here — it is named inline instead.
                                    Same rule as the single-job engine: no free
                                    figure without the job standing behind it. */}
                                {mm.committed > 0 && (
                                  <div className="mt-1 truncate text-[10px] font-semibold text-amber-600"
                                    title={(mm.claimants || []).map(c => `${c.product_name} — ${fmt.num(c.need)}`).join('\n')}>
                                    <Lock size={9} className="mr-0.5 inline align-[-1px]" />
                                    Committed to {mm.claimants?.[0]?.product_name || 'other jobs'}
                                    {mm.claimants?.length > 1 ? ` +${mm.claimants.length - 1} more` : ''}
                                  </div>
                                )}
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

                {/* ══ The RUN's own numbers ══
                    A gang of mixed products is a new layout every time: the
                    plate set and the die are made for THIS run and exist for
                    no other job, so neither comes from a product master — they
                    are typed here once and then travel with the gang number
                    and the product names to every station the run passes.
                    Saved on their own, so a run already on the floor can be
                    named without re-planning anything. A Combined Run prints
                    one product from its own master plate and die, so it never
                    shows this. */}
                {!mergeMode && (() => {
                  const numDirty = (gangNumbers.output_number || '') !== (gangView.output_number || '')
                    || (gangNumbers.die_number || '') !== (gangView.die_number || '');
                  return (
                    <Card icon={Hash} title="Run Numbers" sub="this gang's own output & die — new every run, on every job card">
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                        <Field label="Output No (this run)" hint="the plate/positive set made for this gang — not from any product master">
                          <Input value={gangNumbers.output_number} placeholder="e.g. OP-2207"
                            onChange={e => setGangNumbers(f => ({ ...f, output_number: e.target.value }))} />
                        </Field>
                        <Field label="Die No (this run)" hint="the die cut for this gang's layout">
                          <Input value={gangNumbers.die_number} placeholder="e.g. D-318"
                            onChange={e => setGangNumbers(f => ({ ...f, die_number: e.target.value }))} />
                        </Field>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-500">
                          {gangView.output_number || gangView.die_number
                            ? <>Carried by every card of {gangView.gang_number} — press, die cutting, the traveler.</>
                            : <>Not given yet — each carton still shows its own master number.</>}
                        </span>
                        <Button size="sm" variant={numDirty ? 'primary' : 'secondary'}
                          disabled={!numDirty || gangNumBusy} onClick={saveGangNumbers}>
                          <Hash size={13} /> {gangNumBusy ? 'Saving…' : 'Save run numbers'}
                        </Button>
                      </div>
                    </Card>
                  );
                })()}

                {/* Sheets to issue — the full calculation, then the planner's
                    final call on how much board actually goes to the floor. */}
                <Card icon={Scissors} title="Sheets to Issue" sub="see the maths, then decide the final number">
                  <Field label="Wastage sheets (one run)" hint={`Plant default ${DEFAULT_WASTAGE_SHEETS} — ONE allowance for the whole gang, not per product`}>
                    <Input type="number" min="0" value={gangWastage} onChange={e => setGangWastage(e.target.value)} />
                  </Field>
                  {gangCalc && (
                    <div className="mt-3 space-y-1.5 rounded-xl bg-slate-50 px-3 py-2.5 text-xs">
                      {/* Co-printed: one sheet prints every member, so the base
                          is the LARGEST job, never the sum — the members' own
                          maths stays a reference line underneath. */}
                      {gangCalc.sharedMode ? (
                        <div className="flex items-center justify-between"><span className="text-slate-500">Base child sheets <span className="text-slate-400">(largest job — max qty ÷ ups)</span></span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.childSheets - gangCalc.childWastage)}</span></div>
                      ) : (
                        <div className="flex items-center justify-between"><span className="text-slate-500">Base child sheets <span className="text-slate-400">(Σ qty ÷ ups)</span></span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.baseChild)}</span></div>
                      )}
                      <div className="flex items-center justify-between"><span className="text-slate-500">+ Wastage <span className="text-slate-400">(one press run)</span></span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.wastageTotal)}</span></div>
                      <div className="flex items-center justify-between border-t border-slate-200 pt-1.5"><span className="text-slate-500">= Child print sheets</span><span className="font-semibold tabular-nums text-slate-700">{fmt.num(gangCalc.childSheets)}</span></div>
                      <div className="flex items-center justify-between"><span className="text-slate-500">→ Parent sheets <span className="text-slate-400">(÷ children per parent)</span></span><span className={`font-bold tabular-nums ${tv('text-violet-600', 'text-teal-600')}`}>{fmt.num(gangCalc.parent)}</span></div>
                      {gangCalc.sharedMode && (
                        <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-[11px]">
                          <span className="text-slate-400">Products' own sum — reference, not bought</span>
                          <span className="font-semibold tabular-nums text-slate-400">{fmt.num(gangCalc.naturalParent)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className={`text-[11px] font-bold uppercase tracking-wide ${tv('text-violet-500', 'text-teal-600')}`}>Parent sheets to issue</span>
                      {gangIssue !== '' && +gangIssue !== gangCalc?.parent && (
                        <button type="button" className={`text-[10px] font-bold text-slate-400 ${tv('hover:text-violet-600', 'hover:text-teal-600')}`} onClick={() => setGangIssue('')}>reset to {fmt.num(gangCalc?.parent)}</button>
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

                {/* Board Mix for the WHOLE RUN — the run is one pile off one
                    board, so the mix is entered once against the run's issue
                    and the server splits it across the members it is stored on
                    (gangs.js step 4 / gang-mix.js). Sits directly under Sheets
                    to Issue because it balances against that number: change the
                    issue and the coverage below has to move with it.

                    Same panel the single-line engine uses, same twin functions
                    behind the balance, so a run and a solo job can never be
                    judged by different arithmetic. */}
                {gangMixCtx && (
                  <Card icon={Layers} title="Board Mix — the whole run"
                    sub={`one pile, ${fmt.num(gangIssueNow)} parent sheets — cover it off one board or several`}>
                    {/* A MERGE run is one product, so it gets the full
                        single-line treatment: editable cuts, the Cartons
                        column (the run's own ups), the order ledger line
                        (Σ members' still-to-produce — the same balance-
                        after-FG figure calc.planQty feeds the line panel)
                        and the per-row leftover chips, seeded from the live
                        LO-PLAN-RUN batches. A GANG's cuts are derived per
                        member (derivedCuts renders them read-only with one
                        line saying so) and it banks nothing — no leftover
                        wiring, no cartons column, exactly as before.

                        boardFor turns on the run's per-board PACKET advice,
                        and it needed no server change: gangMixContext already
                        returns `lots` for the planned board and every
                        candidate, and its candidates are SELECT m.* so they
                        bring their own packet size. The run's PLANNED board is
                        the one gap — that context returns only
                        planned_board_id/name/ups/waste_pct/parent dims, and
                        MEMBER_VIEW selects just bm.name/sheet_l/sheet_w — so
                        its master comes from this page's own materials list,
                        exactly as the single line's does. Advice is per BOARD,
                        so it reads the same for a gang as for a merge: a
                        gang's derived CUTS have no bearing on how a pile of
                        that board is picked off the shelf. */}
                    <BoardMix ctx={gangMixCtx} required={gangIssueNow}
                      rows={gangMixRows} onChange={setGangMixRows}
                      derivedCuts={!gangIsMerge}
                      printUps={gangIsMerge ? gangView.members?.[0]?.ups : null}
                      orderQty={gangIsMerge
                        ? gangView.members.reduce((s, m) => s + Math.max(0, (+m.qty || 0) - (+m.fg_consumed_qty || 0)), 0)
                        : null}
                      {...(gangIsMerge ? { leftovers: gangLeftovers, onLeftovers: setGangLeftovers } : {})}
                      boardFor={boardMasterFor}
                      packetChoice={gangPacketChoice} onPacketChoice={setGangPacketChoice} />
                  </Card>
                )}
              </div>

              {/* ── RIGHT: combined board position + soft warnings ── */}
              <div className="space-y-4">
                {(() => {
                  // Board position tracks the number the planner will actually
                  // ISSUE (their override, else the live calc), so "short" and the
                  // Raise-PR trigger stay honest with the decision on the left.
                  const issueNow = gangIssue !== '' && !isNaN(+gangIssue) ? Math.round(+gangIssue) : (gangCalc?.parent ?? gangView.total_parent_sheets);
                  const avail = gangView.position?.available ?? 0;
                  // Other Demand = other jobs' open claims PLUS their frozen
                  // holds (held_others) — the same both-halves sum the single
                  // engine's Committed tile learned. Open claims alone made a
                  // fully-frozen rival read as zero demand.
                  const other = (gangView.position?.committed_other ?? 0) + (gangView.position?.held_others ?? 0);
                  // Board already ON ORDER for this run is cover. Leaving it out
                  // is what made a raised PR look like it never happened — the
                  // banner read "Short N" exactly as before and got clicked again.
                  const onOrder = gangView.position?.incoming ?? 0;
                  const prs = gangView.open_prs || [];
                  // ONE spelling for the whole gang panel: gangShortNow, which
                  // this card, the footer and the lock gate all read — three
                  // inline copies of this arithmetic is how verdicts drift.
                  const { short, freshRun } = gangShortNow ?? { short: 0, freshRun: false };
                  // The run's own one-click seed. Same shape as seedCoverMix, over the run's
                  // figures: the planned board keeps only what it can still give — seeding a
                  // zero-sheet row balances on screen but fails plan-save's sheets > 0 check.
                  const seedGangCoverMix = () => {
                    const c = gangView.mix.candidates[0];
                    const plannedSheets = Math.max(0, issueNow - short);
                    // The run's twin of seedCoverMix, and it resets the packet
                    // picks for the same reason: a mix seeded from nothing
                    // rewrites every row's sheets, so a pick taken against the
                    // old figures no longer speaks for what is on screen.
                    setGangPacketChoice({});
                    setGangMixRows([
                      ...(plannedSheets > 0 ? [{ material_id: gangView.mix.planned_board_id,
                        board_name: gangView.mix.planned_board_name, ups: gangView.mix.planned_ups,
                        sheets: plannedSheets, stock_batch_id: null, reason: '', severity: 'none' }] : []),
                      { material_id: c.id, board_name: c.name, ups: c.ups, sheets: short,
                        stock_batch_id: null, reason: DEFAULT_MIX_REASON, severity: c.severity,
                        gsm_delta: c.gsm_delta, ups_differ: c.ups_differ,
                        size_differs: c.size_differs, available: c.free ?? c.available },
                    ]);
                  };
                  return (
                <Card icon={Warehouse} title="Board Position" sub="combined for the gang">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat small label="In Warehouse" value={fmt.num(avail)} />
                    <Stat small label="Other Demand" value={fmt.num(other)} />
                    <Stat small label="To Issue" value={fmt.num(issueNow)} accent={tv('text-violet-600', 'text-teal-600')} />
                    <Stat small label={onOrder > 0 ? 'On Order' : (short > 0 ? (freshRun ? 'To Order' : 'Short') : 'Position')}
                      value={onOrder > 0 ? fmt.num(onOrder) : (short > 0 ? fmt.num(short) : 'Covered')}
                      accent={onOrder > 0 ? 'text-sky-600' : (short > 0 ? (freshRun ? 'text-indigo-600' : 'text-red-600') : 'text-emerald-600')} />
                  </div>
                  {/* Whose stock does the RUN run on? One choice for the whole
                      pile — stamped onto every member so demand, PRs and the
                      floor all read the same story. */}
                  <div className="mt-2.5">
                    <div className="flex rounded-xl bg-slate-100 p-1 text-[11px] font-semibold">
                      <button type="button" disabled={gangSbBusy}
                        onClick={() => setGangBookingMode('book')}
                        className={`flex-1 rounded-lg px-2 py-1.5 transition-colors disabled:cursor-not-allowed ${!freshRun
                          ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                        Book warehouse stock
                      </button>
                      <button type="button" disabled={gangSbBusy || !!gangView.mix?.active || gangMixRows.length > 0}
                        onClick={() => setGangBookingMode('fresh_pr')}
                        className={`flex-1 rounded-lg px-2 py-1.5 transition-colors disabled:cursor-not-allowed ${freshRun
                          ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                        Fresh PR — leave stock free
                      </button>
                    </div>
                    {freshRun && (
                      <p className="mt-1 text-[10px] text-slate-400">
                        The run buys its full {fmt.num(issueNow)}; free shelf stock stays with other jobs.
                      </p>
                    )}
                  </div>
                  {(gangView.other_prs || []).length > 0 && (
                    <p className="mt-2 text-[10px] font-medium text-slate-400">
                      Board already under PR for other jobs — {fmt.num((gangView.other_prs || []).reduce((s, p) => s + (+p.qty || 0), 0))} sheets
                      incoming ({(gangView.other_prs || []).map(p => `${p.pr_number}${p.gang_number ? ` · ${p.gang_number}` : p.product_code ? ` · ${p.product_code}` : ''}`).join(', ')}).
                      Never a blocker for this run.
                    </p>
                  )}
                  {/* Only while the run is STILL short. Then the panel below is in
                      card mode and this strip is the one thing naming the standing
                      requisition. Once the shortage is covered the panel shows its
                      own PR face — number, status, quantity and the controls — and
                      two rows saying the same thing in different words is what this
                      redesign exists to remove. */}
                  {prs.length > 0 && short > 0 && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 rounded-xl bg-sky-50 px-3 py-2">
                      <Truck size={13} className="shrink-0 text-sky-700" />
                      <span className="text-[11px] font-semibold text-sky-700">
                        One PR covers the whole gang —
                      </span>
                      {prs.map(p => (
                        <button key={p.id} onClick={() => openPrTracker(p)}
                          className="rounded-lg bg-white px-1.5 py-0.5 text-[11px] font-bold text-sky-700 underline decoration-sky-300 hover:decoration-sky-600">
                          {p.pr_number}
                        </button>
                      ))}
                      <span className="text-[11px] font-semibold text-sky-700">
                        · {fmt.num(onOrder)} sheets {prs[0]?.status === 'approved' ? 'approved' : 'pending'}
                      </span>
                    </div>
                  )}
                  {/* Shortage and requisition in ONE panel, the same component the
                      single-line engine renders — the run used to carry its own
                      inline copy of this row, and the two drifted in wording for
                      the same facts. No board-move route exists on a run, so no
                      lastMove/onMoveBack/onTakeBoard is passed and the panel can
                      never enter move mode here.

                      onCoverMix is the same one-click seed the single-line engine
                      offers — planned board keeps what it can still give, the
                      least-waste candidate takes the shortfall, and the rows land
                      in the run's own Board Mix panel on the left for the planner
                      to adjust. Candidates never include the planned board, so
                      without this seed the planned+substitute shape cannot be
                      authored at all. A fresh_pr run is not hunting substitutes —
                      its board is being bought — so the seed hides.

                      onRaisePr stays wrapped so gangRaisePr is only ever reached
                      with no argument: its `opts` default IS the POST body, and
                      the inline button this replaces guarded the same way — a
                      bare handler reference there was handed React's click event
                      straight in as the request body.

                      raiseLabel keeps the run's own wording: ONE requisition
                      covers every member, and saying so at the button is what
                      stops a planner raising one per job. No neededBy is passed —
                      the server derives it (earliest member delivery_date,
                      gangs.js) and re-deriving it here to caption the confirm
                      would be a second copy of that rule, free to drift into
                      quoting a date the PR does not carry. */}
                  <ShortagePanel
                    short={short}
                    fresh={freshRun}
                    prs={prs}
                    role={auth.user?.role}
                    boardName={gangView.mix?.planned_board_name}
                    jobLabel={`${gangView.gang_number} — ${gangView.members.length} jobs`}
                    coverCandidate={gangView.mix?.candidates?.[0]?.name}
                    raiseLabel={prs.length ? `Raise for the balance ${fmt.num(short)}` : 'Raise ONE PR'}
                    busy={prBusy || gangPrBusy}
                    onRaisePr={() => gangRaisePr()}
                    onCoverMix={
                      !freshRun && (gangView.mix?.candidates || []).length > 0 && gangMixRows.length === 0
                        ? seedGangCoverMix
                        : undefined}
                    onUndoPr={undoPr}
                    onCancelPr={cancelPr}
                    onTrackPr={openPrTracker}
                  />
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
      {/* Lock a SHORT plan out loud. Soft by design — the server caps the
          hold at free stock and the plan locks; this dialog only makes sure
          the planner heard the number before the footer said "locked". The
          figure is position.free: THIS job's view, its own hold included,
          because that is exactly what the hold cap measures against. */}
      <ConfirmDialog open={!!lockShortConfirm} onClose={() => setLockShortConfirm(null)}
        onConfirm={() => onLock()}
        title={lockShortConfirm ? `Lock a plan ${fmt.num(lockShortConfirm.short)} sheets short?` : ''}
        confirmLabel="Lock anyway — hold caps at free stock"
        message={lockShortConfirm
          ? `This plan wants ${fmt.num(lockShortConfirm.parent)} parent sheets but only `
            + `${fmt.num(lockShortConfirm.free)} are free for it. The plan still locks — the hold is `
            + `capped at what is free, and the remaining ${fmt.num(lockShortConfirm.short)} shows in the `
            + `warehouse Shortfall column until board arrives or you take it from another job.`
          : ''} />

      {/* The run-level twin of the short-lock confirm above. ONE PR covers
          every member (the raise button's own wording), so the body says so. */}
      <ConfirmDialog open={!!gangLockShortConfirm} onClose={() => setGangLockShortConfirm(null)}
        onConfirm={() => lockGangPlan(true)}
        title={gangLockShortConfirm ? `Lock the run ${fmt.num(gangLockShortConfirm.short)} sheets short?` : ''}
        confirmLabel="Lock anyway — holds capped at free stock"
        message={gangLockShortConfirm
          ? `Only ${fmt.num(gangLockShortConfirm.free)} sheets are free for this run. The run still locks — `
            + `every member's hold is capped at what is free, and the remaining `
            + `${fmt.num(gangLockShortConfirm.short)} shows in the warehouse Shortfall column. `
            + `One PR covers the whole run if you choose to raise it.`
          : ''} />

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
            {/* The card is already minted on a combined run — the sheet still
                changes, and it takes the card's board and sheet count with it.
                Say so BEFORE the planner commits: this is paperwork moving
                under a job that exists, not a fresh plan. */}
            {gangSheetPrompt.job_card && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <b>{gangSheetPrompt.job_card.jc_number}</b> is already created — it will be re-stamped with this
                sheet and its parent-sheet count re-derived. Board has not been issued yet, so nothing on the floor moves.
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              "Update master" only rewrites fields that differ from each product's master (and syncs board name + grade). Anything already matching the master is left alone.
            </p>
          </div>
        )}
      </Modal>

      {/* ── Gang created — UPI-style confirmation ── */}
      {gangSuccess?.kind === 'merge' ? (
        <MergeCreatedSheet run={gangSuccess}
          onClose={() => setGangSuccess(null)}
          onPlan={() => {
            const g = gangSuccess;
            setGangSuccess(null);
            openGangById(g.id);   // the same engine drives a combined run
          }} />
      ) : (
      <GangCreatedSheet gang={gangSuccess}
        onClose={() => setGangSuccess(null)}
        onPlan={() => {
          const g = gangSuccess;
          setGangSuccess(null);
          openGangById(g.id);   // straight into the unified Gang Engine
        }} />
      )}

      {/* ── Ask Management Approval — advisory sign-off for a selective job ── */}
      {/* "Why is this on hold?" — the reason IS the tag: it rides under the
          chip and in the timeline, so a parked pile explains itself later.
          One prompt serves both paths — the per-row dropdown sends one row,
          the bulk bar sends the whole selection under ONE reason. Cancel
          writes nothing. Not a gate — a held job still plans and prints
          exactly as before. */}
      <Modal open={!!holdAsk} onClose={() => setHoldAsk(null)}
        title={holdAsk ? `Put on Hold — ${holdAsk.rows.length === 1
          ? (holdAsk.rows[0]._gang ? holdAsk.rows[0].gang_number : holdAsk.rows[0].product_name)
          : fmt.count(holdAsk.rows.length, 'job')}` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setHoldAsk(null)}>Cancel</Button>
          <Button disabled={holdBusy || !holdReasonText(holdAsk)}
            onClick={async () => { setHoldBusy(true); try { await saveSetTypes(holdAsk.rows, 'hold', holdReasonText(holdAsk)); } finally { setHoldBusy(false); } }}>
            <PauseCircle size={14} /> Put on Hold
          </Button>
        </>}>
        {holdAsk && (
          <div className="space-y-3">
            {/* The reason is a PICKLIST first — the same four answers cover
                nearly every parked job, and one tap beats typing. 'Other'
                reveals the free-text box rather than replacing the list, so
                the short list never costs a reason it cannot express. */}
            <Field label={holdAsk.rows.length === 1 ? 'Why is this job on hold?' : `Why are these ${holdAsk.rows.length} jobs on hold?`} required>
              {/* Deliberately NOT autoFocus. Focusing on mount opens the menu
                  before the effect that syncs the box to the chosen label has
                  settled, so the list ends up filtered to the default and the
                  other reasons look missing. Unfocused, the prompt opens
                  showing the default (one click to confirm) and a click on the
                  field clears the query and offers all five. */}
              <Select value={holdAsk.pick} placeholder="Select a reason…"
                onChange={e => setHoldAsk(h => ({ ...h, pick: e.target.value }))}>
                <option value="">Select a reason…</option>
                {PLANNING_HOLD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            {holdAsk.pick === 'Other' && (
              <Field label="Write the reason" required>
                <Textarea autoFocus rows={2} value={holdAsk.reason}
                  placeholder="e.g. waiting artwork / customer confirming qty / board decision pending"
                  onChange={e => setHoldAsk(h => ({ ...h, reason: e.target.value }))} />
              </Field>
            )}
            {holdAsk.rows.length > 1 && (
              <p className="rounded-xl bg-slate-100 px-3 py-2 text-[11px] font-semibold text-slate-600">
                One reason covers the whole selection — it shows under every job's Hold chip.
              </p>
            )}
            {(holdAsk.rows.some(r => r._gang || r.gang_run_id)) && (
              <p className="rounded-xl bg-violet-50 px-3 py-2 text-[11px] font-semibold text-violet-700">
                {holdAsk.rows.length === 1 && holdAsk.rows[0]._gang
                  ? `${holdAsk.rows[0].gang_number} moves as one — all ${holdAsk.rows[0]._gang.length} jobs in the run go on hold together.`
                  : 'A gang run in the selection moves as one — every job in it goes on hold together.'}
              </p>
            )}
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
              Hold only parks the job in the Hold zone — planning, readiness and the floor are untouched.
            </p>
          </div>
        )}
      </Modal>

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
          <Button variant="secondary"
            onClick={() => savePlan({ spec: masterPrompt.changed, update_master: false, draft: masterPrompt.draft })}>
            {masterPicked.length ? 'None — This Job Only' : 'Save for this Job Only'}
          </Button>
          <Button disabled={!masterPicked.length}
            onClick={() => savePlan({
              spec: masterPrompt.changed, update_master: true,
              master_fields: masterPicked, draft: masterPrompt.draft,
            })}>
            {masterPicked.length === masterChangedKeys.length
              ? 'Update Product Master'
              : `Update Selected (${masterPicked.length})`}
          </Button>
        </>}>
        {masterPrompt && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              You changed master-driven fields on <b>{planLine?.product_name}</b>. Tick the ones the Product Master
              should learn — every future job gets those. Anything left unticked is saved for this job only.
            </p>
            {/* One decision per FIELD. A planner who retunes ups for good and
                trims the parent for this run only used to have to answer for
                both at once, which filed one of the two in the wrong place. */}
            <div className="space-y-1 rounded-xl bg-slate-50 p-2.5 text-sm">
              {Object.entries(masterPrompt.changed).map(([k, v]) => (
                <label key={k}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1 transition-colors hover:bg-white">
                  <Checkbox checked={!!masterPrompt.picked[k]}
                    onChange={e => setMasterPrompt(p => ({ ...p, picked: { ...p.picked, [k]: e.target.checked } }))} />
                  <span className="shrink-0 font-semibold text-slate-700">{specLabel(k)}</span>
                  <span className="ml-auto min-w-0 text-right tabular-nums text-slate-500">
                    <span className="line-through">{planLine?.[k] == null || planLine?.[k] === '' ? '—' : specValue(k, planLine[k])}</span>
                    <span className="mx-1.5 text-slate-300">→</span>
                    <b className="text-slate-900">{specValue(k, v)}</b>
                  </span>
                </label>
              ))}
              {masterChangedKeys.length > 1 && (
                <div className="flex justify-end gap-3 border-t border-slate-200 pt-1.5 text-[11px] font-semibold">
                  <button type="button" className="text-brand-600 hover:underline"
                    onClick={() => setMasterPrompt(p => ({ ...p, picked: allPicked(p.changed) }))}>Select all</button>
                  <button type="button" className="text-slate-400 hover:underline"
                    onClick={() => setMasterPrompt(p => ({ ...p, picked: {} }))}>Clear all</button>
                </div>
              )}
            </div>
            {masterPicked.length > 0 && masterPicked.length < masterChangedKeys.length && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                {masterChangedKeys.filter(k => !masterPrompt.picked[k]).map(specLabel).join(', ')}
                {masterChangedKeys.length - masterPicked.length === 1
                  ? ' stays on this job only — the master keeps its own value for it.'
                  : ' stay on this job only — the master keeps its own values for them.'}
              </p>
            )}
            {['party_artwork_code', 'output_number'].some(k => masterPrompt.picked?.[k]) && (
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

      {/* ── Lock Plan's end-of-flow mix confirm — "then you should be asking me
          at the end whether I want to lock the masters". A plain ledger
          summary plus the lock question; a full replacement additionally
          offers the master question via the SAME savePlan/masterPrompt shape
          every other master-driven edit already uses. ── */}
      <Modal open={!!mixConfirm} onClose={() => setMixConfirm(null)}
        title={mixFullReplacement ? 'This board now covers the whole job' : 'Confirm board coverage'}
        footer={<>
          <Button variant="secondary" onClick={() => setMixConfirm(null)}>Cancel</Button>
          {mixFullReplacement ? (
            <>
              <Button variant="secondary" onClick={confirmMixJobOnly}>Lock for this job only</Button>
              <Button onClick={confirmMixMakeMaster}>Lock and make this the product's board</Button>
            </>
          ) : (
            <Button onClick={confirmMixJobOnly}>
              Lock Plan{calc ? ` — ${fmt.num(calc.parent)} parent sheets` : ''}
            </Button>
          )}
        </>}>
        {mixConfirm && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              {mixFullReplacement
                ? <>{mixConfirm.rows[0].board_name} covers this job's whole requirement on its own — the planned board contributes nothing. Keep this for <b>{planLine?.product_name}</b> only, or make it the product's board for every future job?</>
                : <>{planLine?.product_name} draws board from {mixConfirm.rows.length} source{mixConfirm.rows.length > 1 ? 's' : ''} on this plan. The Product Master stays unchanged either way — this coverage applies to this job only.</>}
            </p>
            <div className="overflow-hidden rounded-xl border border-[#1D1D1F]/[0.08]">
              <div className="divide-y divide-[#1D1D1F]/[0.06] bg-white">
                {mixConfirm.rows.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate font-semibold text-slate-700">{r.board_name}</span>
                      {r.severity === 'none' && (
                        <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-600">Planned</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums font-bold text-slate-800">{fmt.num(r.sheets)}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-0.5 border-t border-[#1D1D1F]/[0.08] bg-slate-50/80 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-500">Total</span>
                  <span className="font-extrabold tabular-nums text-slate-800">
                    {fmt.num(mixConfirm.rows.reduce((s, r) => s + Number(r.sheets || 0), 0))}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-500">Required</span>
                  <span className="font-extrabold tabular-nums text-emerald-600">{fmt.num(calc?.parent ?? 0)} ✓</span>
                </div>
              </div>
            </div>
            {mixSubs.length > 0 && (
              <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                <AlertTriangle size={13} className="mt-px shrink-0" />
                <span>
                  {mixSubs.map(r => r.board_name).filter(Boolean).join(', ')}{' '}
                  {mixSubs.length === 1 ? 'is a substitute' : 'are substitutes'}, not the planned board.
                  Recorded as “{mixSubReason}”. Not a blocker — the plan locks and the board issues
                  normally; change the wording in Board Mix if there's a better reason.
                </span>
              </p>
            )}
            {/* The ✓ above says the mix BALANCES — it never said the sheets
                exist. A mix past free stock locks with its hold CAPPED
                (boardHoldCaps), and this confirm wore an unqualified green
                check over exactly that. Planned row measures against
                position.free (own view — its own frozen sheets are still
                takeable); a substitute row against its seeded free figure. */}
            {(() => {
              const capped = mixConfirm.rows.map(r => {
                const freeFor = r.severity === 'none' ? (position?.free ?? null) : (r.available ?? null);
                return freeFor != null && Number(r.sheets) > Number(freeFor)
                  ? { name: r.board_name, free: Math.max(0, Math.round(freeFor)),
                      short: Math.round(Number(r.sheets) - Math.max(0, Number(freeFor))) }
                  : null;
              }).filter(Boolean);
              if (!capped.length) return null;
              return (
                <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                  <AlertTriangle size={13} className="mt-px shrink-0" />
                  <span>
                    {capped.map(c => `${c.name}: only ${fmt.num(c.free)} free — the hold caps there, ${fmt.num(c.short)} short until board arrives`).join('; ')}.
                    {' '}Not a blocker — the plan locks and the shortfall shows in the warehouse Shortfall column.
                  </span>
                </p>
              );
            })()}
          </div>
        )}
      </Modal>

      {/* ── Smart Match's Use — consented seeding into the mix (board-mix
          wave, Task 8). Owner's own words: "give me a pop up that you want
          to use this as per Smart Match, and then we say okay... this is
          the master and this is what we are using and this is pending and
          this is what we are covering from an alternate board". Same grade
          as the planned board joins the mix behind this preview; a
          different grade (or an unparseable name) keeps pickBoard's
          whole-board-swap semantics behind its own confirm just below —
          the mix would 409 a cross-grade row anyway, so a swap is the only
          honest offer there. Nothing on Smart Match acts silently any more. ── */}
      <Modal open={smartConfirm?.kind === 'mix'} onClose={() => setSmartConfirm(null)}
        title="Use this board, as per Smart Match?"
        footer={<>
          <Button variant="secondary" onClick={() => setSmartConfirm(null)}>Not now</Button>
          <Button onClick={confirmSmartSeed} disabled={smartSeed.sheets === 0 || smartAlreadyInMix}>Add to the mix</Button>
        </>}>
        {smartMatch && (
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm">
              <Row k="Master" v={`${boardSel?.name} — needs ${fmt.num(calc?.parent ?? 0)} parent sheets`} />
              <Row k="Using" v={`${smartMatch.name} — ${fmt.num(smartSeed.sheets)} sheets at ${smartMatch.children_per_parent} cuts`} />
              <Row k="Covers" v={`${fmt.num(Math.round(smartSeed.coversParent))} parent-equivalent`} />
              <Row k="Pending after" v={smartSeed.pendingAfter > 0 ? `${fmt.num(Math.round(smartSeed.pendingAfter))} still short` : 'fully covered'} />
            </div>
            {smartAlreadyInMix ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                Already in the mix — adjust its sheets on the left.
              </p>
            ) : smartSeed.sheets === 0 ? (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                This board has no stock free to seed — nothing to add.
              </p>
            ) : (
              <p className="text-[11px] text-slate-400">
                Adds a substitute row on the left — the master row stays, and the normal flow continues:
                ledger, leftover toggle, lock, floor.
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Different grade (or unparseable name) — the mix would 409 this, so
          Use keeps pickBoard's original whole-board-swap behaviour. Just no
          longer silent: the plan re-parents and needs its own lock, and this
          says so before it happens instead of after. */}
      <Modal open={smartConfirm?.kind === 'swap'} onClose={() => setSmartConfirm(null)}
        title="Switch this plan's board?"
        footer={<>
          <Button variant="secondary" onClick={() => setSmartConfirm(null)}>Not now</Button>
          <Button onClick={() => { const m = smartConfirm.match; setSmartConfirm(null); pickBoard(m); }}>Switch board</Button>
        </>}>
        {smartConfirm?.kind === 'swap' && (() => {
          const m = smartConfirm.match;
          const candGrade = parseBoardName(m?.name)?.grade || 'unrecognised name';
          const planGrade = parseBoardName(boardSel?.name)?.grade || 'unrecognised name';
          return (
            <div className="space-y-2 text-sm text-slate-600">
              <p>
                Switches this plan's board to <b className="text-slate-900">{m?.name}</b> ({candGrade} against
                the master's {planGrade}) — the cut plan re-parents and you lock to confirm.
              </p>
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
                It does not join the mix: a different grade is the customer's spec, not a substitution.
              </p>
            </div>
          );
        })()}
      </Modal>

      {/* ── Commit / release confirms ──────────────────────────────────────
          Commit used to change a hold on one unguarded click, from Board
          Position and from every Smart Match row, and a release was reachable
          only for the selected board. Both now ask the same question in the
          same words wherever they are pressed — and Undo comes through here
          too, because undoing a commit IS a release. ── */}
      <Modal open={commitConfirm?.kind === 'commit'} onClose={() => setCommitConfirm(null)}
        title="Commit this board to the job?"
        footer={<>
          <Button variant="secondary" disabled={commitBusy} onClick={() => setCommitConfirm(null)}>Not now</Button>
          <Button disabled={commitBusy} onClick={runCommitConfirm}>
            Commit {fmt.num(commitConfirm?.qty ?? 0)} sheets
          </Button>
        </>}>
        {commitConfirm?.kind === 'commit' && (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              <b className="text-slate-900">{fmt.num(commitConfirm.qty)} sheets</b> of{' '}
              <b className="text-slate-900">{commitConfirm.name}</b> are held for{' '}
              <b className="text-slate-900">{planLine?.product_name}</b>.
              {/* The button that opened this may have said "Commit 600" while
                  the job ends up holding 1,100 — the server holds the
                  DIFFERENCE, so both numbers are true and the dialog says so
                  rather than picking one and looking wrong beside the other. */}
              {commitConfirm.add != null && commitConfirm.add !== commitConfirm.qty && (
                <> {fmt.num(commitConfirm.qty - commitConfirm.add)} are already held — this takes {fmt.num(commitConfirm.add)} more.</>
              )}
            </p>
            <p>They stop counting as free stock for every other job on this board.</p>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-500">
              Nothing is issued and nothing is consumed — this is a reservation, and you can release it again from here.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={commitConfirm?.kind === 'uncommit'} onClose={() => setCommitConfirm(null)}
        title="Release this board back to free stock?"
        footer={<>
          <Button variant="secondary" disabled={commitBusy} onClick={() => setCommitConfirm(null)}>Not now</Button>
          <Button variant="danger" disabled={commitBusy} onClick={runCommitConfirm}>Release</Button>
        </>}>
        {commitConfirm?.kind === 'uncommit' && (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              {commitConfirm.qty > 0 ? (
                <>The <b className="text-slate-900">{fmt.num(commitConfirm.qty)} sheets</b> of{' '}
                  <b className="text-slate-900">{commitConfirm.name}</b> held for this job go back to free stock.</>
              ) : (
                <>The sheets of <b className="text-slate-900">{commitConfirm.name}</b> held for this job go back to free stock.</>
              )}
            </p>
            <p>Other jobs can take them the moment they are back, so re-committing later is not guaranteed to find them.</p>
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
      <Modal open={!!dupPr} onClose={() => setDupPr(null)} title="Requisition already raised for this product"
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
              <span><b>Warning:</b> A Purchase Requisition is already active for <b>this product</b> on this board
                ({dupPr.existing.pr_number} · {fmt.num(dupPr.existing.qty)} sheets · {fmt.title(dupPr.existing.status)}
                {dupPr.count > 1 ? ` — and ${dupPr.count - 1} more active` : ''}).
                Other products&apos; PRs on this board never trigger this — only a second PR for the same product does.
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

      {/* ── Gang already covered by a PR ── */}
      <Modal open={!!gangDupPr} onClose={() => setGangDupPr(null)}
        title="This gang is already covered"
        footer={<>
          <Button variant="secondary" onClick={() => setGangDupPr(null)}>Close</Button>
          <Button variant="danger"
            disabled={gangPrBusy || !gangDupPr?.reason.trim() || !gangDupPr?.existing?.length}
            onClick={() => gangRaisePr({ reraise_of: gangDupPr.existing[0].id, reraise_reason: gangDupPr.reason.trim() })}>
            {gangPrBusy ? 'Raising…' : 'Raise Another Anyway'}
          </Button>
        </>}>
        {gangDupPr && (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2.5 text-sm font-semibold text-sky-800">
              <Truck size={16} className="mt-0.5 shrink-0" />
              <span>
                A gang buys its board <b>once</b>, for the whole run.
                {' '}{gangDupPr.existing.map(p => `${p.pr_number} (${fmt.num(p.qty)} sheets · ${fmt.title(p.status)})`).join(', ')}
                {' '}already covers {gangView?.gang_number} — <b>{fmt.num(gangDupPr.incoming)} sheets on order</b>.
                Nothing more is needed unless the quantity has genuinely changed.
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {gangDupPr.existing.map(p => (
                <Button key={p.id} size="sm" variant="secondary" onClick={() => { setGangDupPr(null); openPrTracker(p); }}>
                  View {p.pr_number}
                </Button>
              ))}
            </div>
            <Field label="Reason for a second requisition" required>
              <Textarea value={gangDupPr.reason} placeholder="e.g. a job joined the gang, revised quantity, wastage on press"
                onChange={e => setGangDupPr({ ...gangDupPr, reason: e.target.value })} />
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

      {/* ── Discard saved plan ────────────────────────────────────────────────
          A Modal, not the ConfirmDialog the reverse above uses: this one has to
          LIST the boards and sheet counts it is about to hand back, and the last
          line — that the spec edits and remarks survive — is the sentence that
          decides whether the planner presses it at all. Both need real markup,
          not a message string. ── */}
      <Modal open={!!discardAsk} onClose={() => { if (!discardBusy) setDiscardAsk(null); }}
        title="Discard this saved plan?"
        footer={<>
          <Button variant="secondary" disabled={discardBusy} onClick={() => setDiscardAsk(null)}>Not now</Button>
          <Button variant="danger" disabled={discardBusy || !discardAsk?.rows}
            onClick={() => discardPlan(discardAsk.line)}>
            {discardBusy ? 'Discarding…' : 'Discard the saved plan'}
          </Button>
        </>}>
        {discardAsk && (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              The saved cut plan for <b className="text-slate-900">{discardAsk.line.product_name}</b> is
              discarded, and the board it is holding goes back to free stock.
            </p>
            {/* What actually comes back. Null = still fetching; an empty list is
                a real and common answer (a plan saved with no mix holds nothing),
                and it must read as that rather than as a missing figure. */}
            {discardAsk.rows == null ? (
              <p className="text-xs text-slate-400">Checking what this plan is holding…</p>
            ) : discardAsk.rows.length ? (
              <div className="rounded-xl border border-red-100 bg-red-50/60 px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-red-500">Released back to free stock</div>
                <ul className="mt-1 space-y-0.5">
                  {discardAsk.rows.map(r => (
                    <li key={r.material_id} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-semibold text-slate-800">{r.board_name || `Board #${r.material_id}`}</span>
                      <span className="shrink-0 font-bold tabular-nums text-red-700">{fmt.num(r.sheets)} sheets</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 border-t border-red-200/70 pt-1 text-right text-xs font-bold tabular-nums text-red-700">
                  {fmt.num(discardAsk.rows.reduce((s, r) => s + (Number(r.sheets) || 0), 0))} sheets in total
                </div>
              </div>
            ) : (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                No board is held against this plan — nothing to give back.
              </p>
            )}
            <p>
              The job returns to <b className="text-slate-900">To Plan</b> untouched otherwise, and other jobs
              can take that board the moment it is free.
            </p>
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-[11px] font-semibold text-emerald-700">
              The spec edits and remarks you typed are kept — reopen the engine and it is still all there.
            </p>
          </div>
        )}
      </Modal>

      {/* Run-level discard confirm — the twin of the single-line dialog above,
          wearing the same shape so the two engines read as one product. The
          differences are the ones that are actually true of a run: the board is
          named per BOARD (the planner typed run-level rows; the per-member split
          is an implementation detail they never saw), the members are counted,
          and the last line promises the run itself survives — the thing a planner
          will most fear when a red button appears next to Dissolve. */}
      <Modal open={!!gangDiscardAsk} onClose={() => { if (!gangDiscardBusy) setGangDiscardAsk(null); }}
        title="Discard this saved run plan?"
        footer={<>
          <Button variant="secondary" disabled={gangDiscardBusy} onClick={() => setGangDiscardAsk(null)}>Not now</Button>
          <Button variant="danger" disabled={gangDiscardBusy || !gangDiscardAsk?.rows}
            onClick={() => discardGangPlan(gangDiscardAsk.run)}>
            {gangDiscardBusy ? 'Discarding…' : 'Discard the saved plan'}
          </Button>
        </>}>
        {gangDiscardAsk && (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              The saved cut plan for <b className="text-slate-900">{gangDiscardAsk.run.gang_number}</b>
              {' '}— all {gangDiscardAsk.run.members?.length || 0} jobs — is discarded, and the board it is
              holding goes back to free stock.
            </p>
            {/* Null = still fetching; an empty list is a real and common answer
                (a plan saved with no mix holds nothing) and must read as that
                rather than as a missing figure. */}
            {gangDiscardAsk.rows == null ? (
              <p className="text-xs text-slate-400">Checking what this plan is holding…</p>
            ) : gangDiscardAsk.rows.length ? (
              <div className="rounded-xl border border-red-100 bg-red-50/60 px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-red-500">Released back to free stock</div>
                <ul className="mt-1 space-y-0.5">
                  {gangDiscardAsk.rows.map(r => (
                    <li key={r.material_id} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-semibold text-slate-800">{r.board_name || `Board #${r.material_id}`}</span>
                      <span className="shrink-0 font-bold tabular-nums text-red-700">{fmt.num(r.sheets)} sheets</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 border-t border-red-200/70 pt-1 text-right text-xs font-bold tabular-nums text-red-700">
                  {fmt.num(gangDiscardAsk.rows.reduce((s, r) => s + (Number(r.sheets) || 0), 0))} sheets in total
                </div>
              </div>
            ) : (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                No board is held against this plan — nothing to give back.
              </p>
            )}
            <p>
              Every job returns to <b className="text-slate-900">To Plan</b> untouched otherwise, and other jobs
              can take that board the moment it is free.
            </p>
            <p className="rounded-xl bg-emerald-50 px-3 py-2 text-[11px] font-semibold text-emerald-700">
              The run stays together and the spec edits and remarks you typed are kept — this reopens with all of
              it still there. Only the cut plan and the board it held go.
            </p>
          </div>
        )}
      </Modal>

      <BoardCommitments
        open={boardPanel}
        onClose={() => setBoardPanel(false)}
        materialId={boardSel?.id}
        prContext={{ id: null, pr_number: 'this job', order_line_id: planLine?.id }}
        onChanged={async moved => {
          // Only a move passes a payload; a repoint calls this with nothing.
          // /board/move's response doesn't carry the material, so stamp it here
          // with the board that was on screen when the move happened. Without
          // that stamp the strip outlives the board it describes — the render
          // below can then drop it on its own, instead of every board-changing
          // path having to remember to clear it.
          if (moved) setLastMove({ ...moved, material_id: boardSel?.id });
          if (planLine && boardSel) setCtx(await loadCtx(planLine, boardSel.id));
        }} />
    </div>
  );
}
