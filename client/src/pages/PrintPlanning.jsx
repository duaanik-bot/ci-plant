// Print Planning — the CI-Production press kanban. Triage is a full-width band
// on top (tick jobs → send to a press in one go, or drag), press lanes fill the
// width below; top-to-bottom of a lane IS the live printing queue on the floor.
// Native HTML5 drag & drop, no library. Gang runs (jobs that print together)
// travel as ONE stack — any move carries every job in the gang. Every move —
// tick-and-send, quick-send, drag, send-back — can be undone from the bar that
// appears at the bottom for ten seconds.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmt, auth } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { Button, ExportMenu, Field, odDays, odExport, odTone, OverdueDays, PageHeader, ResetFilters, rowMatches, SEARCH_FX, SearchInput, searchText, Select, useFilterReset, useToast, WipChip } from '../components/ui.jsx';
import { Inbox, Printer, GripVertical, Radio, Link2, AlertTriangle, User, CheckCircle2, ArrowDown, LayoutGrid, RotateCcw, X, Pencil, FileText, PauseCircle, Play, Gauge, Square, CheckSquare, Undo2, ChevronRight, ChevronLeft, CornerUpLeft, Building2, ChevronUp, ChevronDown, ArrowUpToLine, ArrowDownToLine, Maximize2, Minimize2, ChevronsUpDown, Search, Layers, SlidersHorizontal } from 'lucide-react';
import { ReadinessPopover, TrafficLight } from '../components/Readiness.jsx';
// The board vocabulary lives in ONE place for the whole ERP — see BoardStatus.jsx.
import { BOARD_LABEL, BOARD_FULL, BOARD_HINT, BOARD_TONE, BOARD_COUNT_TONE, BOARD_RANK, BoardBadge, boardStateOf } from '../components/BoardStatus.jsx';
import PlateStatus from '../components/PlateStatus.jsx';
// One chip shape for every filter rail in the ERP — see FilterChip.jsx.
import { FilterChip, FilterGroup } from '../components/FilterChip.jsx';
// The customer axis — identical here and on Planning, Artwork and Job Cards, so
// one company is one colour wherever a planner meets it.
import { CustomerFilterGroup } from '../components/CustomerFilterGroup.jsx';
import { WipFilterGroup } from '../components/WipFilter.jsx';
import { CustomerDot } from '../components/CustomerDot.jsx';
import { customerChipsFrom, filterByCustomers, toggleCustomer } from '../lib/customerChips.js';
import { customerInitials } from '../lib/customerCode.js';
import { customerHue } from '../lib/customerColour.js';
// Printing colour + process follows the same one-vocabulary rule — see PrintColour.jsx.
import { ColourBadge, ProcessBadge, ColourCodeLines, PrintColourFilterRail, ActiveColourFilters,
         COLOUR_RANK, PROCESS_RANK, colourTypeOf, processOf, totalColoursOf, colourSummary,
         colourFilterCounts, matchesColourFilters } from '../components/PrintColour.jsx';
import { DangerZone } from '../components/WorkflowControls.jsx';
import { HOLD_REASONS } from '../sections.js';
import { SET_TYPE_META, SetTypeChip, cardSetType, isMergeRun } from '../components/SetType.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { plannedChildSheets } from '../lib/received.js';

const TRIAGE = 'triage';

// The same Single / Gang / Hold vocabulary Planning's zones use, mapped onto
// this board's FACTS rather than the planner's stored tag: a card here is
// already plated, so intent has become physical truth. Hold is the press hold
// this page has always had (the stage hold with its reason picklist) — NOT a
// second parking flag; one job can never be "held" two different ways.
// cardSetType now comes from lib/setType.js via SetType.jsx — this page used
// to hand-roll it, and its copy tested gang_run_id, so a COMBINED run (one
// product, several sales orders, never splits) read as a Gang on the press
// board while the planning queue was being taught to call it a Single.
const canPlan = () => ['admin', 'planner'].includes(auth.user?.role);

// Per-machine colour identity. Each press lane gets its own hue so the board
// reads at a glance on the floor — matching the coloured top-rail, header icon,
// count badge and the left edge of every card queued on that press. Hues are
// drawn from the app's Apple system palette (systemBlue / Green / Purple / Teal)
// — amber and red are deliberately left out, reserved for the printing/hold
// status signals. Triage sits neutral (slate) so real machines pop. Full class
// strings live here literally so Tailwind's JIT never purges them.
const TRIAGE_THEME = {
  icon: 'text-slate-400',
  badge: 'bg-slate-200/70 text-slate-600',
  edge: 'border-l-slate-300',
  dot: 'bg-slate-300',
  chip: 'bg-slate-100 text-slate-500',
  queue: 'bg-slate-100 text-slate-500',
  shell: 'border-slate-200/70 border-t-[3px] border-t-slate-300 bg-slate-50/50 backdrop-blur-xl',
  active: 'border-slate-300 border-t-[3px] border-t-slate-400 bg-slate-100/70 ring-2 ring-slate-200',
};
const PALETTE = [
  { icon: 'text-blue-500',    badge: 'bg-blue-100 text-blue-700',       edge: 'border-l-blue-500',
    dot: 'bg-blue-500',    chip: 'bg-blue-50 text-blue-700',       queue: 'bg-blue-100 text-blue-700',
    send: 'bg-blue-600 hover:bg-blue-700',
    shell: 'border-blue-200/60 border-t-[3px] border-t-blue-400 bg-blue-50/45 backdrop-blur-xl',
    active: 'border-blue-300 border-t-[3px] border-t-blue-500 bg-blue-50/80 ring-2 ring-blue-200' },
  { icon: 'text-emerald-500', badge: 'bg-emerald-100 text-emerald-700', edge: 'border-l-emerald-500',
    dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700', queue: 'bg-emerald-100 text-emerald-700',
    send: 'bg-emerald-600 hover:bg-emerald-700',
    shell: 'border-emerald-200/60 border-t-[3px] border-t-emerald-400 bg-emerald-50/45 backdrop-blur-xl',
    active: 'border-emerald-300 border-t-[3px] border-t-emerald-500 bg-emerald-50/80 ring-2 ring-emerald-200' },
  { icon: 'text-violet-500',  badge: 'bg-violet-100 text-violet-700',   edge: 'border-l-violet-500',
    dot: 'bg-violet-500',  chip: 'bg-violet-50 text-violet-700',   queue: 'bg-violet-100 text-violet-700',
    send: 'bg-violet-600 hover:bg-violet-700',
    shell: 'border-violet-200/60 border-t-[3px] border-t-violet-400 bg-violet-50/45 backdrop-blur-xl',
    active: 'border-violet-300 border-t-[3px] border-t-violet-500 bg-violet-50/80 ring-2 ring-violet-200' },
  { icon: 'text-teal-500',    badge: 'bg-teal-100 text-teal-700',       edge: 'border-l-teal-500',
    dot: 'bg-teal-500',    chip: 'bg-teal-50 text-teal-700',       queue: 'bg-teal-100 text-teal-700',
    send: 'bg-teal-600 hover:bg-teal-700',
    shell: 'border-teal-200/60 border-t-[3px] border-t-teal-400 bg-teal-50/45 backdrop-blur-xl',
    active: 'border-teal-300 border-t-[3px] border-t-teal-500 bg-teal-50/80 ring-2 ring-teal-200' },
];
const pressTheme = i => PALETTE[i % PALETTE.length];

// A date is overdue when the committed delivery day has already passed.
const isOverdue = d => {
  if (!d) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(d) < today;
};

// Short press label for the quick-send buttons: "Press 3" out of
// "Offset Printing Press No. 3 (5 Colour)". Falls back to the full name.
const shortPress = name => {
  const m = /(\d+)\s*(?:\(|$)/.exec(name || '');
  return m ? `Press ${m[1]}` : (name || 'Press');
};

// One labelled cell of the card's field grid. Every value on the face carries
// its caption — a new planner should never have to guess what a number is.
// Sized so a lane fits 10-15 cards behind its own scrollbar without losing a field.
function F({ label, children, hero, tone }) {
  return (
    <div className={`min-w-0 px-1.5 py-[3px] ${hero ? 'bg-gradient-to-b from-blue-50/90 to-white' : 'bg-white'}`}>
      <div className="truncate text-[8px] font-bold uppercase tracking-[0.06em] text-slate-400">{label}</div>
      <div className={`truncate text-[11.5px] font-bold tabular-nums leading-[15px] tracking-tight ${
        hero ? 'text-[12.5px] text-blue-600' : tone || 'text-slate-800'}`}>{children}</div>
    </div>
  );
}

// A mixed job's cuts are per board — one legacy figure would name a wrong
// number — so displays read "mixed · N boards" and this tooltip carries each
// pile's own issued × cuts breakdown.
const isMix = card => Array.isArray(card?.mix_cuts) && card.mix_cuts.length > 1;
const mixTitle = card => (card?.mix_cuts || [])
  .map(m => `${m.board_name}: ${fmt.num(m.issued)} × ${m.cuts} = ${fmt.num((+m.issued || 0) * (+m.cuts || 1))}`)
  .join(' · ');

// A lane's OWN search — compact sibling of the global SearchInput. Filters one
// lane live per keystroke while every other lane stays put; the global search
// up in the page header still sweeps the whole board.
function LaneSearch({ value, onChange, placeholder }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#0A84FF]/80" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`h-[30px] w-full rounded-full border pl-7 pr-7 text-[12px] font-medium text-slate-700 outline-none transition duration-200 ${SEARCH_FX}`} />
      {value && (
        <button onClick={() => onChange('')} title="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 transition-colors hover:text-slate-600">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// Both places this renders — the board's header rail and an expanded lane's
// toolbar — put something before it (the view switch; the lane name), so it
// always wants its leading hairline.
function BoardStatusChips({ value, onChange, counts, scope = 'across the board' }) {
  return (
    <FilterGroup label="Board">
      {[
        // "All" reads identically here and in the Set Type group two chips to
        // the right, and on a typical board both say 30. The caption is what
        // tells them apart, which is why every group on this rail now has one.
        { key: 'all', label: 'All', count: counts.all },
        // Lit chips wear the badge's own tone, read from BOARD_TONE rather than
        // restated here: the chip you clicked and the badge you read must never
        // be able to disagree about what colour a state is.
        { key: 'covered', label: BOARD_LABEL.covered, count: counts.covered, on: BOARD_TONE.covered, pill: BOARD_COUNT_TONE.covered },
        { key: 'on_order', label: BOARD_LABEL.on_order, count: counts.on_order, on: BOARD_TONE.on_order, pill: BOARD_COUNT_TONE.on_order },
        { key: 'short', label: BOARD_LABEL.short, count: counts.short, on: BOARD_TONE.short, pill: BOARD_COUNT_TONE.short },
      ].map(f => (
        <FilterChip key={f.key} label={f.label} count={f.count} on={value === f.key}
          tone={f.on} countTone={f.pill}
          title={f.key === 'all'
            ? `${f.count} job${f.count === 1 ? '' : 's'} ${scope}`
            : `${f.count} ${scope} — ${BOARD_HINT[f.key]}`}
          onClick={() => onChange(f.key)} />
      ))}
    </FilterGroup>
  );
}

// The reorder cluster — move a card (or a whole gang) within its queue without
// dragging: one step up/down, or straight to the top/end. Boundary buttons
// disable themselves so the affordance doubles as "where am I in the queue".
function ReorderButtons({ onReorder, first, last, tone = 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' }) {
  const btn = `rounded p-0.5 transition-colors disabled:opacity-25 disabled:pointer-events-none ${tone}`;
  return (
    <span className="flex items-center gap-px" onClick={e => e.stopPropagation()}>
      <button className={btn} title="Move to top" disabled={first} onClick={() => onReorder('top')}><ArrowUpToLine size={12} /></button>
      <button className={btn} title="Move up" disabled={first} onClick={() => onReorder('up')}><ChevronUp size={13} /></button>
      <button className={btn} title="Move down" disabled={last} onClick={() => onReorder('down')}><ChevronDown size={13} /></button>
      <button className={btn} title="Move to end" disabled={last} onClick={() => onReorder('end')}><ArrowDownToLine size={12} /></button>
    </span>
  );
}

// Job card — the face answers "what is this and can I run it?" without a
// click: product + customer, PO number and dates, ordered pieces, sheets and
// colours, the board it prints on, and readiness. Status is a written pill,
// never a colour to memorise. The status-coloured left edge still carries the
// state at a glance: amber = printing now, red = on hold, on-press = its
// How long the customer has been waiting, for one card and for a whole run.
// Same rule as Planning, Artwork and the Job Card register: a run answers for
// its OLDEST PO, because the sheet is as overdue as the longest-waiting order
// printed on it, and `latest` is set only when the members were booked on
// different days so a span is shown exactly when there is one.
//
// The PO date is the only clock most of this board has — delivery_date is null
// on the great majority of open lines, which is why "Deliver By" so often reads
// as a dash two columns over.
const cardPoAge = card => ({ date: card?.po_date ?? null, latest: null, days: odDays(card?.po_date), count: card?.po_date ? 1 : 0 });

const groupPoAge = g => {
  const ds = [...new Set((g?.cards || []).map(c => c?.po_date).filter(Boolean))].sort();
  return { date: ds[0] ?? null, latest: ds.length > 1 ? ds[ds.length - 1] : null, days: odDays(ds[0]), count: ds.length };
};

// machine's hue, grey = still in triage. Status always wins over machine hue.
// One source of truth for how a card's state is worded and coloured — the
// kanban card and the expanded table row both read this, so they can never
// disagree about what a job looks like.
function statusOf(card, onPress, theme) {
  const partial = card.printing_status === 'partially_completed';
  const running = card.printing_status === 'in_progress' || partial;
  const held = card.printing_status === 'hold';
  return {
    partial, running, held,
    edge: partial ? 'border-l-cyan-500' : running ? 'border-l-amber-500' : held ? 'border-l-red-500'
      : onPress ? (theme?.edge || 'border-l-[#007AFF]') : 'border-l-slate-300',
    dot: partial ? 'bg-cyan-500' : running ? 'bg-amber-500' : held ? 'bg-red-500' : (theme?.dot || 'bg-slate-300'),
    pill: partial ? 'bg-cyan-50 text-cyan-700' : running ? 'bg-amber-50 text-amber-700'
      : held ? 'bg-red-50 text-red-600' : onPress ? (theme?.chip || 'bg-slate-100 text-slate-500') : 'bg-slate-100 text-slate-500',
    pillLabel: partial ? 'Partly printed' : running ? 'Printing now' : held ? 'On hold' : onPress ? 'Queued' : 'In triage',
  };
}

function Card({ card, grip, onPress, theme, onDone, seq, wide,
  selectable, selected, onToggle, presses, onSend, onSendBack, onReorder, first, last }) {
  const { partial, running, held, edge, dot, pill, pillLabel } = statusOf(card, onPress, theme);
  const late = isOverdue(card.delivery_date);
  // Days since the customer raised the PO — the wait the plant is answerable
  // for, and on most of this board the only date there is.
  const od = odDays(card.po_date);
  // Board chip: explicit board name (already "grade gsm parent"), or material
  // name; the gsm cell only when the name does not already carry it.
  const board = card.board_display || null;
  const gsm = card.gsm && !(board || '').includes(String(card.gsm)) ? `${card.gsm} gsm` : null;
  return (
    <div className={`group relative rounded-xl border border-l-[5px] bg-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${edge} ${
      partial ? 'border-cyan-300 ring-1 ring-cyan-200' : running ? 'border-amber-300 ring-1 ring-amber-200' : held ? 'border-red-200' : 'border-slate-200'}`}>
      {/* SELECTION lives in the card's own top-right corner, not inline in the
          header. Wedged between the grip and the job number it was a 15px
          target the eye had to hunt for on every card; here it is always in
          the same place, never moves as the header fills up, and is big enough
          to hit at a glance. The header keeps clear of it with pr-7. */}
      {selectable && (
        <button onClick={e => { e.stopPropagation(); onToggle?.(); }}
          title={selected ? 'Deselect this job' : 'Select this job'}
          aria-label={selected ? 'Deselect this job' : 'Select this job'}
          aria-pressed={!!selected}
          className={`absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
            selected
              ? 'bg-blue-50 text-blue-600 ring-1 ring-blue-200'
              : 'text-slate-300 hover:bg-slate-50 hover:text-slate-500'}`}>
          {selected ? <CheckSquare size={20} /> : <Square size={20} />}
        </button>
      )}
      <div className="px-2.5 pb-2 pt-1.5">
        {/* Header: identity + written status + readiness + actions */}
        <div className={`flex items-center gap-1.5 ${selectable ? 'pr-7' : ''}`}>
          {grip && <GripVertical size={13} className="shrink-0 text-slate-300 group-hover:text-slate-400" />}
          {seq != null && (
            <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-extrabold tabular-nums ${theme?.queue || 'bg-slate-100 text-slate-500'}`}>{seq}</span>
          )}
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${running ? 'animate-pulseSoft' : ''}`} />
          <span className="truncate text-[13px] font-extrabold tracking-tight text-slate-900">{card.jc_number}</span>
          {/* Output number (plate / positive no.) from the product master.
              Always present so a blank reads as "not filled in yet", not as a
              different kind of card. */}
          <span title="Output No. — the plate / positive number from the product master"
            className={`flex shrink-0 items-baseline gap-1 rounded px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums ${
              card.output_no ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-300'}`}>
            <span className={`text-[8px] font-bold uppercase tracking-wide ${card.output_no ? 'text-blue-400' : 'text-slate-300'}`}>Output</span>
            {card.output_no || '—'}
          </span>
          <span className="flex-1" />
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill}`}>{pillLabel}</span>
          {card.light && (
            <span onClick={e => e.stopPropagation()}>
              <ReadinessPopover light={card.light}>
                <TrafficLight light={card.light} size="sm" />
              </ReadinessPopover>
            </span>
          )}
          {/* Pulled in by a negative margin, not hidden by opacity alone: the
              28px menu button would otherwise set the row height while invisible. */}
          <span className="-my-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100"
            onClick={e => e.stopPropagation()}>
            <DangerZone jobCard={card} onDone={onDone} asMenu />
          </span>
          <ChevronRight size={13} className="shrink-0 text-slate-300 transition-colors group-hover:text-blue-400" />
        </div>

        {/* Product is the hero, customer right under it */}
        <ProductIdentity row={card} className="mt-0.5"
          nameClassName="text-[12.5px] font-extrabold leading-4 tracking-tight text-slate-900" />
        <div className="mt-px flex items-center gap-1 truncate text-[10.5px] leading-4 text-slate-500">
          {card.customer_name && (
            // The company's own colour REPLACES the generic building glyph
            // rather than joining it. Both say "this is the customer" and only
            // one of them says WHICH — and on a kanban card this line is 10.5px
            // with a truncated name already fighting for it, so icon + dot +
            // name is clutter. The glyph stays as the fallback for a card whose
            // customer has no id to colour, so the line never loses its marker.
            <span className="flex min-w-0 items-center gap-1 truncate" title={card.customer_name}>
              {customerHue(card.customer_id)
                ? <CustomerDot id={card.customer_id} className="mr-0" />
                : <Building2 size={10} className="shrink-0 text-slate-300" />}
              <span className="truncate">{card.customer_name}</span>
            </span>
          )}
        </div>

        {/* Labelled field grid — the whole story on the face */}
        <div className={`mt-1 grid overflow-hidden rounded-lg border border-slate-100 bg-slate-100 gap-px ${wide ? 'grid-cols-4' : 'grid-cols-2'}`}>
          <F label="Customer PO">{card.po_number || '—'}</F>
          {/* The wait rides WITH the PO date rather than taking a cell of its
              own. This grid is exactly 8 fields — a clean 4×2 wide and 2×4
              narrow — and a ninth would leave a ragged half-row and make every
              card in the lane taller, which on a tablet is the difference
              between a lane you can scan and one you scroll. Text, not the
              pill the table uses: every other figure on this face is plain, and
              one filled chip among them reads as an alert rather than a number.
              Same bands either way, from odTone. */}
          <F label="PO Date">
            {card.po_date ? fmt.date(card.po_date) : '—'}
            {od != null && (
              <span title={`${od} day${od === 1 ? '' : 's'} since the customer PO was raised`}
                className={`ml-1 text-[10px] font-extrabold ${odTone(od) || 'text-slate-400'}`}>{od}d</span>
            )}
          </F>
          <F label="Deliver By" tone={late ? 'text-red-600' : undefined}>
            {card.delivery_date ? fmt.date(card.delivery_date) : '—'}
          </F>
          <F label="Ordered" hero>{card.qty_planned ? `${fmt.num(card.qty_planned)} pcs` : '—'}</F>
          <F label="Sheets">{fmt.num(card.sheets_issued)} sh</F>
          <F label="Colours">{totalColoursOf(card) ?? '—'}{totalColoursOf(card) ? ' col' : ''}</F>
          <F label="Planned">{card.planned_date ? fmt.date(card.planned_date) : '—'}</F>
          <F label="Cuts / parent">{isMix(card)
            ? <span title={mixTitle(card)}>mixed · {card.mix_cuts.length} boards</span>
            : (card.children_per_parent || 1)}</F>
        </div>

        {/* Board, in the plant's own words, at the size the question deserves:
            "can I print this?" is settled before anything else on the card, so
            it gets the full width rather than a 9.5px chip in the wrap row.
            Bought-and-coming is not the same trouble as nothing-ordered, and
            the press planner schedules around the difference. */}
        {/* Board and plates are ONE readiness line, and the plate chip rides at
            the end of the board band rather than down among the spec chips.
            Both answer the same question — can this card go on a press today —
            and the plate state was being read as decoration next to the gsm and
            coating tags, which are reference material nobody schedules on.
            Still no SECOND band: a second full-width row would grow every card
            in the lane, which is why the chip sits inline here instead. */}
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1"><BoardBadge state={boardStateOf(card)} band /></div>
          {card.plate_state && <PlateStatus state={card.plate_state} wear={card.plate_wear} wearRuns={card.plate_wear_runs} wearReplace={card.plate_wear_replace} compact className="mt-1 shrink-0" />}
        </div>

        {/* Spec + blockers — words, not colours to memorise */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {board && <span className="rounded-md border border-amber-100 bg-amber-50/70 px-1.5 py-px text-[9.5px] font-bold text-amber-800">{board}</span>}
          {gsm && <span className="rounded-md border border-amber-100 bg-amber-50/70 px-1.5 py-px text-[9.5px] font-bold text-amber-800">{gsm}</span>}
          {card.coating && <span className="rounded-md border border-slate-100 bg-slate-50 px-1.5 py-px text-[9.5px] font-bold text-slate-500">{card.coating}</span>}
          <SetTypeChip type={cardSetType(card)} reason={cardSetType(card) === 'hold' ? card.hold_reason : ''} />
          {/* Ink. Compact, so plain Offset stays silent and only work that needs
              a different set-up — spot colours, a metallic unit — speaks up. */}
          <ColourBadge row={card} compact />
          <ProcessBadge row={card} compact />
          {card.pantone_codes && (
            <span title={card.pantone_codes}
              className="max-w-[150px] truncate rounded-md border border-violet-100 bg-violet-50 px-1.5 py-px text-[9.5px] font-bold text-violet-700">
              {card.pantone_codes}
            </span>
          )}
          {card.metallic_details && (
            <span title={card.metallic_details}
              className="max-w-[150px] truncate rounded-md border border-amber-200 bg-amber-100 px-1.5 py-px text-[9.5px] font-bold text-amber-800">
              {card.metallic_details}
            </span>
          )}
          {card.wip && <WipChip on />}
          {card.tooling_ready === false && <span className="rounded-md bg-red-50 px-1.5 py-px text-[9.5px] font-bold text-red-600">✕ Tooling not ready</span>}
          {late && <span className="ml-auto rounded-md bg-red-50 px-1.5 py-px text-[9.5px] font-bold text-red-600">Overdue</span>}
        </div>

        {/* Live progress — printed so far vs the job's expected PRINT sheets
            (parents × cuts-per-parent — Σ per board under a mix — so the units
            finally match the counter). */}
        {(running || partial) && card.printed_so_far > 0 && (() => {
          const expected = plannedChildSheets(card);
          const pct = expected > 0 ? Math.min(100, Math.round((100 * card.printed_so_far) / expected)) : null;
          return (
            <div className="mt-1.5">
              <div className={`flex items-center justify-between text-[11px] font-bold tabular-nums ${partial ? 'text-cyan-700' : 'text-amber-700'}`}>
                <span>
                  {fmt.num(card.printed_so_far)}{expected > 0 ? ` of ${fmt.num(expected)}` : ''} sh printed
                  {card.print_waste_so_far > 0 && <span className="ml-1.5 font-semibold text-red-500">· {fmt.num(card.print_waste_so_far)} waste</span>}
                </span>
                {pct != null && <span>{pct}%</span>}
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full transition-all duration-500 ${partial ? 'bg-cyan-500' : 'bg-amber-500'}`}
                  style={{ width: `${pct ?? 0}%` }} />
              </div>
            </div>
          );
        })()}
        {held && card.hold_reason && (
          <div className="mt-1.5 truncate text-[11px] font-semibold text-red-500">{card.hold_reason}</div>
        )}

        {/* Footer: operator + reorder + the card's own actions */}
        <div className="mt-1 flex items-center gap-1.5 border-t border-slate-100 pt-1">
          {card.printing_operator ? (
            <span className="flex min-w-0 items-center gap-1 truncate text-[10.5px] font-semibold text-slate-500">
              <User size={11} className="shrink-0 text-slate-400" /> {card.printing_operator}
            </span>
          ) : <span className="text-[10.5px] font-semibold text-slate-300">Unmanned</span>}
          <span className="ml-auto" />
          {onReorder && <ReorderButtons onReorder={onReorder} first={first} last={last} />}
          {onSend && presses?.length > 0 && (
            <span className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Send to</span>
              {presses.map((p, i) => (
                <button key={p.id} title={p.name} onClick={() => onSend(p.id)}
                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm transition-colors ${pressTheme(i).send}`}>
                  {shortPress(p.name).replace('Press ', 'P')}
                </button>
              ))}
            </span>
          )}
          {onSendBack && (
            <button onClick={e => { e.stopPropagation(); onSendBack(); }}
              title="Send back to Triage"
              className="flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700">
              <CornerUpLeft size={10} /> Triage
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// One draggable unit in a lane: a single job card, or a whole gang stack.
function groupLane(cards) {
  const groups = [];
  const byGang = new Map();
  for (const c of cards) {
    if (c.gang_run_id) {
      if (byGang.has(c.gang_run_id)) { byGang.get(c.gang_run_id).cards.push(c); continue; }
      const g = { key: `gang-${c.gang_run_id}`, gang_number: c.gang_number, cards: [c] };
      byGang.set(c.gang_run_id, g);
      groups.push(g);
    } else {
      groups.push({ key: `card-${c.id}`, gang_number: null, cards: [c] });
    }
  }
  return groups;
}

// Edit a queued run in place — quantity, sheets, operator, press + position,
// and dates. Backed by PUT /print-planning/:id. Press change is sent as
// machine_id + the destination lane's new ordered_ids (this card appended).
function EditQueueForm({ card, presses, lanes, onClose, onSaved, onClash }) {
  const [form, setForm] = useState({
    qty_planned: card.qty_planned ?? '',
    sheets_issued: card.sheets_issued ?? '',
    operator: card.printing_operator ?? '',
    machine_id: card.machine_id ?? '',
    planned_date: card.planned_date ? String(card.planned_date).slice(0, 10) : '',
    delivery_date: card.delivery_date ? String(card.delivery_date).slice(0, 10) : '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    const body = {
      qty_planned: Number(form.qty_planned),
      sheets_issued: Number(form.sheets_issued),
      operator: form.operator || null,
      planned_date: form.planned_date || null,
      delivery_date: form.delivery_date || null,
    };
    const newMachine = form.machine_id ? Number(form.machine_id) : null;
    if (newMachine !== (card.machine_id ?? null)) {
      body.machine_id = newMachine;
      // The server moves the WHOLE gang, so the destination order must place
      // every gang partner too — otherwise partners keep stale positions and
      // the gang lands scattered through the queue instead of contiguous.
      const gangIds = card.gang_run_id
        ? Object.values(lanes).flat().filter(c => c.gang_run_id === card.gang_run_id).map(c => c.id)
        : [card.id];
      const movingIds = gangIds.length ? gangIds : [card.id];
      // Destination lane order: existing lane ids (minus the movers) + movers.
      // Triage is ordered too — the cards land at the end of the triage queue.
      const dest = (lanes[newMachine ?? 'triage'] || []).map(c => c.id).filter(i => !movingIds.includes(i));
      body.ordered_ids = [...dest, ...movingIds];
    }
    try { await api.put(`/print-planning/${card.id}`, body); onSaved(); }
    catch (e) {
      if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
        onClash(e.data.collision, async () => {
          await api.put(`/print-planning/${card.id}`, { ...body, confirm_collision: true });
          onSaved();
        });
      } else alert(e?.message || 'Could not save changes');
    }
    finally { setBusy(false); }
  };

  const field = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-extrabold text-slate-900">Edit — {card.jc_number}</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-slate-500">Planned qty
            <input type="number" className={field} value={form.qty_planned} onChange={e => set('qty_planned', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Sheets issued
            <input type="number" className={field} value={form.sheets_issued} onChange={e => set('sheets_issued', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Operator
            <input className={field} value={form.operator} onChange={e => set('operator', e.target.value)} />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">Press
            {/* Searchable like every other picker — a press is found by its number,
                model or the operator on it, not only by the name shown. */}
            <Select value={form.machine_id} onChange={e => set('machine_id', e.target.value)}>
              <option value="">Triage (unassigned)</option>
              {presses.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name}</option>)}
            </Select>
          </label>
          <label className="text-xs font-semibold text-slate-500">Planned date
            <input type="date" className={field} value={form.planned_date} onChange={e => set('planned_date', e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-slate-500">Delivery date
            <input type="date" className={field} value={form.delivery_date} onChange={e => set('delivery_date', e.target.value)} />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-amber-600">Delivery date changes the whole order, not just this line.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">Cancel</button>
          <button onClick={save} disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PrintPlanning() {
  const [cards, setCards] = useState([]);
  const [presses, setPresses] = useState([]);
  const [dragOverLane, setDragOverLane] = useState(null);
  const [completed, setCompleted] = useState([]);
  const [tab, setTab] = useState('board');        // 'board' | 'completed'
  const [chooser, setChooser] = useState(null);   // { card, done } | null
  const [editCard, setEditCard] = useState(null); // card being edited | null
  const [clashPrompt, setClashPrompt] = useState(null); // { collision, confirm } strength mix-up alarm
  const [holding, setHolding] = useState(null);         // card being put on hold
  const [holdReason, setHoldReason] = useState(HOLD_REASONS[0]);
  const [completedPress, setCompletedPress] = useState('all'); // table-view press filter
  const [q, setQ] = useState('');                // one search across board + completed table
  const [sel, setSel] = useState(() => new Set()); // selected TRIAGE group keys
  // Expanded full-screen table view of one lane. Not a module of its own —
  // the same lane, the same cards, the same actions, just information-dense.
  const [expanded, setExpanded] = useState(null);  // TRIAGE | press id | null
  const triageRail = useRef(null);                 // the horizontal triage rail, for the ‹ › scroll buttons
  // Every lane's OWN live search, keyed by lane (TRIAGE or press id). Composes
  // with the whole-board search in the page header — both narrow at once.
  const [laneQ, setLaneQ] = useState({});
  const setLQ = (key, v) => setLaneQ(s => ({ ...s, [key]: v }));
  const [expQ, setExpQ] = useState('');            // the expanded view's OWN search
  const [expSort, setExpSort] = useState(null);    // { key, dir } | null — view-only sort
  // Board Status chip filter — ONE state for both views (kanban + expanded
  // table). Pure client state, so a fallback repaint can never reset it.
  const [boardStatus, setBoardStatus] = useState('all'); // 'all' | 'ready' | 'pending'
  const [zone, setZone] = useState('all'); // set-type zone: 'all'|'single'|'gang'|'hold' — All by default; a press board schedules gangs as first-class work
  const [mergeOnly, setMergeOnly] = useState(false); // second axis: combined runs only, composes with the zone
  // Customer-WIP filter — on = only jobs the customer is chasing. A second
  // axis beside the board chips; both narrow at once, like the searches do.
  const [wipOnly, setWipOnly] = useState(false);
  // WHICH customer — a different question from Customer WIP beside it, which
  // asks about urgency. Multi-select on customer_ids, never names: the id is
  // what the colour is keyed on and what survives a spelling correction.
  const [customerFilters, setCustomerFilters] = useState([]); // customer_ids; empty = all
  // Counted over the WHOLE board, exactly like boardCounts and the Customer WIP
  // count below it — on this page a chip says what it would keep out of every
  // card on the board, not out of whatever the lane filters have already left.
  //
  // ONE customer per card here: a gang's card resolves its order through the
  // run's LEAD line, which is what the Customer column has always shown, so no
  // members function is passed. Declared before boardFilterActive and
  // emptyLaneReason because both read it.
  const customerChips = useMemo(() => customerChipsFrom(cards), [cards]);
  // Printing colour + process filters. MULTI-select, because the question a
  // press planner actually asks is "show me everything with spot colour in it",
  // which is Pantone AND CMYK + Pantone at once. An empty Set means ALL — never
  // filter on an empty set or the board blanks before anyone clicks. Shared by
  // the kanban and the expanded table, so the filter survives switching views.
  const [colourSel, setColourSel] = useState(() => new Set());
  const [processSel, setProcessSel] = useState(() => new Set());
  const [bandSel, setBandSel] = useState(() => new Set());
  const colourFilters = { colour: colourSel, process: processSel, band: bandSel };
  const anyColourFilter = colourSel.size > 0 || processSel.size > 0 || bandSel.size > 0;
  // The ink block folds behind a disclosure on the board rail — see its own
  // comment there. Opens automatically for a planner who arrives with ink
  // already filtering (a filter set, then the view switched and switched back),
  // so the chips doing the narrowing are never a click away from being seen.
  const [inkOpen, setInkOpen] = useState(anyColourFilter);
  // How many of the three folded axes are narrowing, and which — the disclosure
  // has to be able to say so while the chips themselves are hidden.
  const inkActiveCount = colourSel.size + processSel.size + bandSel.size;
  const activeInkNames = [...colourSel, ...processSel,
    ...(bandSel.size ? [`${[...bandSel].join(' / ')} colours`] : [])];
  const clearColourFilters = () => { setColourSel(new Set()); setProcessSel(new Set()); setBandSel(new Set()); };
  // ONE name for "the board is showing a subset". Reordering, dragging and the
  // queue-position numbers all key off this: a drag inside a filtered lane
  // would write positions computed from the rows still visible, silently
  // reordering the jobs it is hiding. It was spelled out five separate times,
  // which is how a new filter axis ends up wired into four of them.
  const boardFilterActive = boardStatus !== 'all' || wipOnly || zone !== 'all' || mergeOnly
    || anyColourFilter || customerFilters.length > 0;
  // Why a lane that HAS jobs is showing none. It named the board-status filter
  // unconditionally, so any OTHER axis doing the hiding printed the literal
  // `is "undefined"` — already true of Customer WIP, and the colour axes would
  // have made it the common case.
  const emptyLaneReason = (laneName, laneSearch) => {
    if (laneSearch) return `Nothing in ${laneName} matches "${laneSearch}"`;
    if (boardStatus !== 'all') return `Nothing in ${laneName} is "${BOARD_LABEL[boardStatus]}"`;
    const ink = [...colourSel, ...processSel,
      ...(bandSel.size ? [`${[...bandSel].join(' / ')} colours`] : [])];
    if (ink.length) return `Nothing in ${laneName} is ${ink.join(' or ')}`;
    if (zone !== 'all') return `Nothing in ${laneName} is ${SET_TYPE_META[zone]?.label || zone}`;
    if (mergeOnly) return `Nothing in ${laneName} is a combined run`;
    if (wipOnly) return `Nothing in ${laneName} is marked Customer WIP`;
    if (customerFilters.length) {
      const names = customerChips.filter(c => customerFilters.includes(c.id))
        .map(c => customerInitials(c.name) || c.name);
      if (names.length) return `Nothing in ${laneName} belongs to ${names.join(' or ')}`;
    }
    return `Nothing in ${laneName} matches the filters`;
  };
  const [undo, setUndo] = useState(null);          // { msg, entries } | null
  const undoTimer = useRef(null);
  const toast = useToast();
  const navigate = useNavigate();
  const dragIds = useRef([]);        // all job-card ids moving together
  const dropBeforeId = useRef(null); // first card id of the group dropped onto

  // Sequenced load: only the NEWEST request may repaint. A slow poll dispatched
  // before a move must not resolve after the post-move reload and repaint the
  // pre-move order — with a live wall display polling every 5s that stale frame
  // would look real. Errors are swallowed; the next poll retries in 5s.
  const loadSeq = useRef(0);
  const load = () => {
    const n = ++loadSeq.current;
    return api.get('/print-planning').then(d => {
      if (n !== loadSeq.current) return;
      setCards(d.cards); setPresses(d.presses); setCompleted(d.completed || []);
    }).catch(() => {});
  };
  // Realtime moves the board; this timer is only a visible-tab safety net.
  useFallbackRefresh(load, { intervalMs: 30000 });
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 500 });
  // Expanded view housekeeping: its search and sort start fresh each time it
  // opens, Esc closes it (unless a modal is on top), and the page behind it
  // stops scrolling while it is up.
  useEffect(() => { setExpQ(''); setExpSort(null); }, [expanded]);
  useEffect(() => {
    if (expanded == null) return;
    const onKey = e => {
      if (e.key === 'Escape' && !chooser && !editCard && !holding && !clashPrompt) setExpanded(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [expanded, chooser, editCard, holding, clashPrompt]);
  // If the expanded press stops existing (deactivated in Masters), fall back
  // to the board rather than showing an empty shell.
  useEffect(() => {
    if (expanded != null && expanded !== TRIAGE && !presses.some(p => p.id === expanded)) setExpanded(null);
  }, [expanded, presses]);

  // Day-wise counter log for the open card popup — fetched live on open.
  const [chooserRuns, setChooserRuns] = useState(null);
  useEffect(() => {
    setChooserRuns(null);
    if (chooser?.card?.printing_stage_id)
      api.get(`/job-stages/${chooser.card.printing_stage_id}/runs`).then(setChooserRuns).catch(() => setChooserRuns(null));
  }, [chooser?.card?.printing_stage_id]);

  // Two lane maps. fullLanes is the truth (every card, no filter) — every
  // ordered_ids we send to the server comes from here, so a search filter can
  // never scramble the queue positions of cards it is hiding. lanes is what the
  // screen shows: fullLanes narrowed by the search.
  const fullLanes = useMemo(() => {
    const byLane = { [TRIAGE]: [] };
    for (const p of presses) byLane[p.id] = [];
    for (const c of cards) {
      const lane = c.machine_id && byLane[c.machine_id] ? c.machine_id : TRIAGE;
      byLane[lane].push(c);
    }
    return byLane;
  }, [cards, presses]);
  const statusPass = c => boardStateOf(c) === boardStatus;
  // A card's ZONE is run-level: one held member parks the whole run's stack in
  // Hold — a gang travels as one here exactly as it does everywhere else. The
  // chip on each card face stays card-level (cardSetType), so inside a held
  // stack the eye can still find WHICH member the press stopped on.
  const heldRuns = useMemo(() => new Set(
    cards.filter(c => c.gang_run_id && c.printing_status === 'hold').map(c => c.gang_run_id)), [cards]);
  // Run-level, then the shared card rule. `heldRuns` stays keyed on
  // gang_run_id — a held member parks the whole stack whichever KIND of run it
  // is — but what makes a card Gang is the kind, so a combined run lands in
  // Single here exactly as it does on the planning queue.
  const zoneOf = c => (heldRuns.has(c.gang_run_id) ? 'hold' : cardSetType(c));
  const lanes = useMemo(() => {
    const anyLaneQ = Object.values(laneQ).some(Boolean);
    if (!q && !anyLaneQ && boardStatus === 'all' && !wipOnly && zone === 'all' && !mergeOnly
        && !anyColourFilter && !customerFilters.length) return fullLanes;
    const byLane = {};
    for (const k of Object.keys(fullLanes)) {
      let list = fullLanes[k];
      if (wipOnly) list = list.filter(c => c.wip);
      if (boardStatus !== 'all') list = list.filter(statusPass);
      if (zone !== 'all') list = list.filter(c => zoneOf(c) === zone);
      if (mergeOnly) list = list.filter(isMergeRun);
      // Guarded against the WHOLE board's chips, not this lane's: a customer
      // with cards on press 2 and none on press 1 must still narrow press 1 to
      // empty rather than release there and show it unfiltered.
      list = filterByCustomers(list, customerFilters, customerChips);
      if (anyColourFilter) list = list.filter(c => matchesColourFilters(c, colourFilters));
      if (q) list = list.filter(c => rowMatches(c, q, productSearchText(c)));
      if (laneQ[k]) list = list.filter(c => rowMatches(c, laneQ[k], productSearchText(c)));
      byLane[k] = list;
    }
    return byLane;
  }, [fullLanes, q, laneQ, boardStatus, wipOnly, zone, mergeOnly, heldRuns, colourSel, processSel, bandSel,
      customerFilters, customerChips]);
  // Zone counts run over the unfiltered board and count JOBS the way the eye
  // does — a gang run's stack is one job, however many cards it carries.
  const zoneCounts = useMemo(() => {
    const seen = new Set();
    const n = { all: 0, single: 0, gang: 0, hold: 0 };
    for (const c of cards) {
      const key = c.gang_run_id ? `g${c.gang_run_id}` : `c${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n.all++;
      n[zoneOf(c)]++;
    }
    return n;
  }, [cards, heldRuns]);
  // Combined runs in the OPEN zone — the same second axis Planning carries,
  // counted the way the eye counts: a run's stack is one job, however many
  // cards it holds. Hidden at zero, so the press rail never grows on a board
  // with no combined work on it.
  const mergeCount = useMemo(() => {
    const seen = new Set();
    let n = 0;
    for (const c of cards) {
      if (!isMergeRun(c)) continue;
      if (zone !== 'all' && zoneOf(c) !== zone) continue;
      const key = `g${c.gang_run_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
    }
    return n;
  }, [cards, zone, heldRuns]);
  // Chip counts come from the unfiltered board so they never restate the filter.
  const countStates = list => {
    const n = { all: list.length, covered: 0, on_order: 0, short: 0 };
    for (const c of list) n[boardStateOf(c)]++;
    return n;
  };
  const boardCounts = useMemo(() => countStates(cards), [cards]);
  const colourCounts = useMemo(() => colourFilterCounts(cards), [cards]);
  const matchCount = useMemo(() => (q ? Object.values(lanes).reduce((s, l) => s + l.length, 0) : null), [lanes, q]);
  // Sheets each press finished TODAY — the day's output at a glance per lane.
  const todayByPress = useMemo(() => {
    const isToday = ts => ts && new Date(ts).toDateString() === new Date().toDateString();
    const by = {};
    for (const c of completed) {
      if (!isToday(c.completed_at) || !c.machine_id) continue;
      by[c.machine_id] = (by[c.machine_id] || 0) + (c.printed_sheets ?? 0);
    }
    return by;
  }, [completed]);

  // Completed runs grouped by the press they printed on (unassigned bucket last).
  const completedByPress = useMemo(() => {
    const by = { unassigned: [] };
    for (const p of presses) by[p.id] = [];
    for (const c of completed) {
      const k = c.machine_id && by[c.machine_id] ? c.machine_id : 'unassigned';
      by[k].push(c);
    }
    return by;
  }, [completed, presses]);

  // Selection lives on triage GROUP keys (a gang selects as one). Prune keys
  // whenever the board reloads — a job that left triage drops out silently.
  const triageGroups = useMemo(() => groupLane(lanes[TRIAGE] || []), [lanes]);
  useEffect(() => {
    const valid = new Set(groupLane(fullLanes[TRIAGE] || []).map(g => g.key));
    setSel(prev => {
      const next = new Set([...prev].filter(k => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [fullLanes]);
  const selGroups = useMemo(() => triageGroups.filter(g => sel.has(g.key)), [triageGroups, sel]);
  const selSheets = selGroups.reduce((s, g) => s + g.cards.reduce((x, c) => x + (c.sheets_issued || 0), 0), 0);
  const toggleSel = key => setSel(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const selectAllTriage = () => setSel(new Set(triageGroups.map(g => g.key)));
  const clearSel = () => setSel(new Set());
  // Every way this board narrows itself. The TAB (board vs completed) is not
  // here — those are two different lists, and moving between them is
  // navigation. Everything else defaults to "show everything" and so resets:
  // the whole-board search, each lane's own box, the board-status cards, the
  // zone, Combined, Customer WIP, the customer chips and the three ink axes.
  const filters = useFilterReset([
    [q, setQ, '', 'search'],
    [laneQ, setLaneQ, {}, 'lane searches'],
    [boardStatus, setBoardStatus, 'all', 'board status'],
    [zone, setZone, 'all', 'zone'],
    [mergeOnly, setMergeOnly, false, 'Combined'],
    [wipOnly, setWipOnly, false, 'Customer WIP'],
    [customerFilters, setCustomerFilters, [], 'customer'],
    [colourSel, setColourSel, new Set(), 'ink'],
    [processSel, setProcessSel, new Set(), 'process'],
    [bandSel, setBandSel, new Set(), 'band'],
  ], clearSel);

  // ---- Undo -----------------------------------------------------------------
  // Every move records how to put things back: one assign call per moved group,
  // returning it to its source lane in that lane's pre-move order. The bar shows
  // for ten seconds; a new move replaces it.
  const showUndo = (msg, entries) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ msg, entries });
    undoTimer.current = setTimeout(() => setUndo(null), 10000);
  };
  const runUndo = async () => {
    const u = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (!u) return;
    let failed = 0;
    for (const e of u.entries) {
      const payload = { job_card_id: e.job_card_id, machine_id: e.machine_id, ordered_ids: e.ordered_ids };
      try { await api.post('/print-planning/assign', payload); }
      catch (err) {
        // Returning a card to the press it just left can re-fire the strength
        // alarm; it was acceptable there seconds ago, so confirm silently.
        if (err.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
          try { await api.post('/print-planning/assign', { ...payload, confirm_collision: true }); }
          catch { failed++; }
        } else failed++;
      }
    }
    // Say what actually happened — an undo that half-worked must not report
    // success while a card is stranded on the wrong lane.
    if (failed) toast.error(`Undo incomplete — ${failed} move${failed === 1 ? '' : 's'} could not be restored`);
    else toast.info('Move undone');
    load();
  };

  // ---- Moves ----------------------------------------------------------------
  // The one mover. groups → destination lane (TRIAGE or a press id), appended
  // at the end (drag handles its own insert position separately). Sequential
  // assigns; a strength clash pauses THAT group behind the existing modal and
  // the rest continue. Ends with a reload + the undo bar. Triage is ordered the
  // same way a press is — the server happily sets queue_pos with a null
  // machine — so cards land (and restore) exactly where the planner put them.
  const sendGroups = async (destKey, groups, { confirm = false } = {}) => {
    if (!groups.length) return;
    const machine_id = destKey === TRIAGE ? null : +destKey;
    const movingIds = groups.flatMap(g => g.cards.map(c => c.id));
    // How to put every group back — its source lane, in that lane's current order.
    const entries = groups.map(g => {
      const src = g.cards[0].machine_id && fullLanes[g.cards[0].machine_id] ? g.cards[0].machine_id : TRIAGE;
      return {
        job_card_id: g.cards[0].id,
        machine_id: src === TRIAGE ? null : +src,
        ordered_ids: (fullLanes[src] || []).map(c => c.id),
      };
    });
    const destLane = machine_id || TRIAGE;
    const destBase = (fullLanes[destLane] || []).map(c => c.id).filter(id => !movingIds.includes(id));
    setCards(cs => cs.map(c => (movingIds.includes(c.id) ? { ...c, machine_id } : c)));
    const moved = [];
    // ordered_ids grows incrementally — each group's POST carries only the
    // groups that have already landed plus itself, so a group that fails (409,
    // strength clash the planner cancels) never has destination positions
    // written for it by an EARLIER group's request.
    const landed = [];
    for (const g of groups) {
      const dest = [...destBase, ...landed, ...g.cards.map(c => c.id)];
      const payload = { job_card_id: g.cards[0].id, machine_id, ordered_ids: dest, confirm_collision: confirm || undefined };
      try {
        await api.post('/print-planning/assign', payload);
        moved.push(g);
        landed.push(...g.cards.map(c => c.id));
      } catch (e) {
        if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
          setClashPrompt({
            collision: e.data.collision,
            confirm: () => sendGroups(destKey, [g], { confirm: true }),
          });
        }
        // This group stays put — pull the optimistic move back.
        const ids = g.cards.map(c => c.id);
        const back = g.cards[0].machine_id ?? null;
        setCards(cs => cs.map(c => (ids.includes(c.id) ? { ...c, machine_id: back } : c)));
      }
    }
    if (moved.length) {
      const destName = machine_id ? shortPress(presses.find(p => p.id === machine_id)?.name) : 'Triage';
      const jobs = moved.reduce((s, g) => s + g.cards.length, 0);
      showUndo(`${jobs} job${jobs === 1 ? '' : 's'} → ${destName}`, entries.filter((_, i) => moved.includes(groups[i])));
      setSel(prev => {
        const next = new Set(prev);
        for (const g of moved) next.delete(g.key);
        return next;
      });
    }
    load();
  };

  // Reorder a group WITHIN its lane — one step up/down or straight to the
  // top/end — the whole gang moving as one block. Works in triage exactly like
  // on a press. Optimistic: the cards array itself is re-sequenced (lanes render
  // in array order), then the server persists the same order.
  const reorderBusy = useRef(false);
  const moveWithin = async (laneKey, group, action) => {
    if (reorderBusy.current) return;
    const lane = fullLanes[laneKey] || [];
    const groups = groupLane(lane);
    const idx = groups.findIndex(g => g.key === group.key);
    if (idx < 0) return;
    const to = action === 'top' ? 0 : action === 'up' ? Math.max(0, idx - 1)
      : action === 'down' ? Math.min(groups.length - 1, idx + 1) : groups.length - 1;
    if (to === idx) return;
    const next = [...groups];
    next.splice(to, 0, ...next.splice(idx, 1));
    const orderedIds = next.flatMap(g => g.cards.map(c => c.id));
    // Optimistic re-sequence: lane members take the new order in place, every
    // other card keeps its slot.
    const laneSet = new Set(orderedIds);
    setCards(cs => {
      const byId = new Map(cs.map(c => [c.id, c]));
      let k = 0;
      return cs.map(c => (laneSet.has(c.id) ? byId.get(orderedIds[k++]) : c));
    });
    reorderBusy.current = true;
    try {
      await api.post('/print-planning/assign', {
        job_card_id: group.cards[0].id,
        machine_id: laneKey === TRIAGE ? null : +laneKey,
        ordered_ids: orderedIds,
      });
      showUndo(`${group.cards[0].jc_number} moved`, [{
        job_card_id: group.cards[0].id,
        machine_id: laneKey === TRIAGE ? null : +laneKey,
        ordered_ids: lane.map(c => c.id),
      }]);
    } catch { /* central toast */ }
    finally { reorderBusy.current = false; load(); }
  };

  const moveGroup = async (laneKey, beforeId) => {
    const ids = dragIds.current.map(Number).filter(Boolean);
    // Clear the gesture refs NOW, not after the awaits — a planner working in
    // rhythm can lift the next card before this POST resolves, and a late
    // wipe would empty the new drag's ids mid-gesture (its drop would then
    // silently no-op).
    dragIds.current = []; dropBeforeId.current = null; setDragOverLane(null);
    if (!ids.length) return;
    const machine_id = laneKey === TRIAGE ? null : +laneKey;
    const first = cards.find(c => c.id === ids[0]);
    const srcLane = first?.machine_id && fullLanes[first.machine_id] ? first.machine_id : TRIAGE;
    const undoEntry = {
      job_card_id: ids[0],
      machine_id: srcLane === TRIAGE ? null : +srcLane,
      ordered_ids: (fullLanes[srcLane] || []).map(c => c.id),
    };
    // Destination lane order (optimistic): existing cards minus the moving
    // group, with the whole group inserted at the drop point. Ordering is
    // computed on the UNFILTERED lane so an active search can never scramble
    // the queue positions of the cards it is hiding. Triage gets the same
    // treatment, so dragging within triage reorders it too.
    const dest = (fullLanes[laneKey] || []).filter(c => !ids.includes(c.id)).map(c => c.id);
    const insertAt = beforeId ? dest.indexOf(+beforeId) : dest.length;
    dest.splice(insertAt < 0 ? dest.length : insertAt, 0, ...ids);
    // A drop that changes nothing (same lane, same order — a long-press that
    // never travelled, a jitter-lift released in place) must not rewrite the
    // queue or raise a toast.
    const prevIds = (fullLanes[laneKey] || []).map(c => c.id);
    if (ids.every(id => prevIds.includes(id)) && dest.join(',') === prevIds.join(',')) return;
    setCards(cs => cs.map(c => (ids.includes(c.id) ? { ...c, machine_id } : c)));
    const payload = { job_card_id: ids[0], machine_id, ordered_ids: dest };
    try {
      // One call — the server assigns the press to every job in the gang.
      await api.post('/print-planning/assign', payload);
      const destName = machine_id ? shortPress(presses.find(p => p.id === machine_id)?.name) : 'Triage';
      showUndo(`${ids.length} job${ids.length === 1 ? '' : 's'} → ${destName}`, [undoEntry]);
      load();
    } catch (e) {
      // Soft strength mix-up alarm — hold the optimistic move, ask, then re-send.
      if (e.data?.code === 'PRODUCT_STRENGTH_COLLISION') {
        setClashPrompt({
          collision: e.data.collision,
          confirm: () => api.post('/print-planning/assign', { ...payload, confirm_collision: true }),
        });
      } else load();
    }
  };

  // Runs printed TODAY, pinned green at the foot of their live press lane.
  const openJobCard = card => { setChooser(null); navigate(`/production/jobcard/${card.id}`); };
  // Jump straight to this job at the printing station — search pre-filled, so
  // the operator lands on the exact row to record a count or complete.
  const openAtStation = card => { setChooser(null); navigate(`/floor/printing?q=${encodeURIComponent(card.jc_number)}`); };
  const holdRun = async () => {
    await api.post(`/job-stages/${holding.printing_stage_id}/hold`, { reason: holdReason });
    toast.info(`${holding.jc_number} put on hold — ${holdReason}`);
    setHolding(null); setHoldReason(HOLD_REASONS[0]); load();
  };
  const resumeRun = async card => {
    setChooser(null);
    await api.post(`/job-stages/${card.printing_stage_id}/resume`, {});
    toast.success(`${card.jc_number} resumed`);
    load();
  };
  const reverseRun = async card => {
    const reason = window.prompt('Reason for reversing this printed run back to Triage?');
    if (!reason) return;
    try { await api.post('/print-planning/reverse', { job_card_id: card.id, reason }); setChooser(null); load(); }
    catch (e) { alert(e?.message || 'Could not reverse this run'); }
  };

  // ── Pointer drag engine ────────────────────────────────────────────────────
  // The board used native HTML5 drag-and-drop, which NEVER fires from a touch
  // screen — and iPadOS routes even the trackpad through the touch path, so on
  // a tablet neither finger nor cursor could move a card. Rebuilt on pointer
  // events, which every input speaks: a mouse lifts a card after 5px of
  // travel; a finger lifts it after a 220ms hold, so lanes still scroll
  // normally under a swiping thumb. Semantics are unchanged — hover a card to
  // drop before it, hover lane space to append, release outside every lane to
  // throw a press job back to Triage, Esc cancels.
  const ptr = useRef(null);          // the one live gesture, if any
  const justDragged = useRef(null);  // group.key whose next click is swallowed

  // The drop must always commit through THIS render's handlers — a refresh
  // repaint mid-drag would otherwise leave onUp holding a stale moveGroup
  // whose lane snapshot re-orders the queue with dead data.
  const live = useRef({});
  live.current = { moveGroup, sendGroups };
  // A navigation mid-drag must not leave window listeners and a ghost behind.
  useEffect(() => () => { ptr.current?.teardown?.(); }, []);

  const parseLaneKey = s => (s === TRIAGE ? TRIAGE : Number(s));

  const startDrag = (e, group, laneKey) => {
    if (!canPlan() || ptr.current) return;
    if (e.button != null && e.button !== 0) return;
    // Buttons, ticks and fields inside a card keep their own gestures.
    if (e.target.closest('button, input, a, select, textarea, [role="button"]')) return;
    const sourceEl = e.currentTarget;
    const d = {
      startX: e.clientX, startY: e.clientY, pointerType: e.pointerType,
      lifted: false, ghost: null, dx: 0, dy: 0, holdTimer: null, overLane: null,
    };
    const teardown = () => {
      clearTimeout(d.holdTimer);
      d.ghost?.remove();
      sourceEl.style.opacity = '';
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', blockScroll);
      window.removeEventListener('keydown', onKey, true);
      ptr.current = null;
      setDragOverLane(null);
    };
    const lift = (x, y) => {
      dragIds.current = group.cards.map(c => c.id);
      dropBeforeId.current = null;
      const r = sourceEl.getBoundingClientRect();
      d.srcRect = r;
      // A cloned <tr> outside its table collapses to nothing — wrap it.
      let ghost;
      if (sourceEl.tagName === 'TR') {
        ghost = document.createElement('table');
        ghost.appendChild(sourceEl.cloneNode(true));
      } else ghost = sourceEl.cloneNode(true);
      ghost.style.cssText =
        `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;margin:0;` +
        'z-index:9999;pointer-events:none;opacity:.92;transform:rotate(1.5deg) scale(1.02);' +
        'box-shadow:0 24px 48px rgba(29,29,31,.35);border-radius:16px;background:rgba(255,255,255,.96);';
      document.body.appendChild(ghost);
      d.ghost = ghost; d.lifted = true;
      d.dx = x - r.left; d.dy = y - r.top;
      sourceEl.style.opacity = '0.35';
      // A mouse sweeping across the board would otherwise paint text selection
      // over every label it crosses.
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      window.getSelection()?.removeAllRanges();
    };
    const track = (x, y) => {
      if (d.ghost) { d.ghost.style.left = `${x - d.dx}px`; d.ghost.style.top = `${y - d.dy}px`; }
      // A long board is crossed mid-drag by pushing the page at its edges.
      if (y < 80) window.scrollBy(0, -14);
      else if (y > window.innerHeight - 80) window.scrollBy(0, 14);
      const els = document.elementsFromPoint(x, y);
      // The expanded press table floats over the board — while it is open,
      // only ITS lanes and rows may catch a drop; elementsFromPoint would
      // otherwise pierce its backdrop onto invisible lanes beneath.
      const scope = document.querySelector('[data-drop-scope]');
      const inScope = el => !scope || scope.contains(el);
      // A gang's own sibling rows carry the same drag id — never a target.
      const groupEl = els.find(el => el.dataset?.dragFirst && inScope(el)
        && !dragIds.current.includes(Number(el.dataset.dragFirst)));
      const laneEl = els.find(el => el.dataset?.laneKey != null && inScope(el));
      // Lanes and the triage rail scroll INSIDE themselves — nudge whichever
      // scroller the pointer is riding so deep queues stay reachable.
      if (laneEl) {
        const lr = laneEl.getBoundingClientRect();
        if (y < lr.top + 56) laneEl.scrollTop -= 12;
        else if (y > lr.bottom - 56) laneEl.scrollTop += 12;
        const rail = laneEl.querySelector('.overflow-x-auto') || els.find(el => el.classList?.contains('overflow-x-auto'));
        if (rail) {
          const rr = rail.getBoundingClientRect();
          if (x < rr.left + 56) rail.scrollLeft -= 14;
          else if (x > rr.right - 56) rail.scrollLeft += 14;
        }
      }
      d.overSelf = d.srcRect && x >= d.srcRect.left && x <= d.srcRect.right && y >= d.srcRect.top && y <= d.srcRect.bottom;
      dropBeforeId.current = groupEl ? Number(groupEl.dataset.dragFirst) : null;
      d.overLane = laneEl ? parseLaneKey(laneEl.dataset.laneKey) : null;
      setDragOverLane(d.overLane);
    };
    const onMove = ev => {
      // A second finger (or a palm) must never steer the first finger's drag.
      if (ev.pointerId !== d.pointerId) return;
      if (!d.lifted) {
        const dist = Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY);
        if (d.pointerType === 'mouse') { if (dist > 5) lift(ev.clientX, ev.clientY); else return; }
        // A finger that travels before the hold fires is scrolling, not dragging.
        else if (dist > 12) { teardown(); return; }
        else return;
      }
      track(ev.clientX, ev.clientY);
    };
    const onUp = ev => {
      // Only the finger that lifted the card may drop it.
      if (ev.pointerId !== d.pointerId) return;
      if (!d.lifted) { teardown(); return; }
      justDragged.current = group.key;
      setTimeout(() => { justDragged.current = null; }, 150);
      const over = d.overLane;
      const overSelf = d.overSelf;
      const before = dropBeforeId.current;
      const px = ev.clientX, py = ev.clientY;
      teardown();
      // Released on its own footprint: the card never moved — change nothing.
      if (over === laneKey && overSelf && before == null) {
        dragIds.current = []; dropBeforeId.current = null;
        return;
      }
      if (over != null) { live.current.moveGroup(over, before); return; }
      // Not over a lane. A release NEAR one (its header, its search box, the
      // gap between columns) is a miss, not an instruction — cancel. Only a
      // release clearly off the board throws a press job home to Triage.
      const nearLane = [...document.querySelectorAll('[data-lane-key]')].some(el => {
        const r = el.getBoundingClientRect();
        return px >= r.left - 48 && px <= r.right + 48 && py >= r.top - 64 && py <= r.bottom + 48;
      });
      if (!nearLane && laneKey !== TRIAGE) { live.current.sendGroups(TRIAGE, [group]); return; }
      dragIds.current = []; dropBeforeId.current = null;
    };
    const onCancel = ev => { if (ev.pointerId === d.pointerId) teardown(); };
    // Capture phase + stopPropagation: Escape must cancel the DRAG and nothing
    // else — the expanded table also closes itself on Escape.
    const onKey = ev => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      teardown();
    };
    // Non-passive and registered inside the gesture, so once a card is lifted
    // the page stops panning under the finger (and Safari stops firing the
    // pointercancel that would kill the drag).
    const blockScroll = ev => { if (d.lifted) ev.preventDefault(); };
    if (d.pointerType !== 'mouse') {
      d.holdTimer = setTimeout(() => { lift(d.startX, d.startY); track(d.startX, d.startY); }, 220);
    }
    d.pointerId = e.pointerId;
    d.teardown = teardown;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    window.addEventListener('keydown', onKey, true);
    ptr.current = d;
  };

  const laneProps = laneKey => ({ 'data-lane-key': String(laneKey) });

  const groupProps = (group, laneKey) => ({
    'data-drag-first': group.cards[0].id,
    onPointerDown: e => startDrag(e, group, laneKey),
    // The click that trails a completed drag must not open the job chooser.
    onClickCapture: e => {
      if (justDragged.current === group.key) {
        justDragged.current = null; e.preventDefault(); e.stopPropagation();
      }
    },
  });

  const renderGroup = (group, laneKey, theme, seq, pos) => {
    const draggable = canPlan();
    const onPress = laneKey !== TRIAGE;
    const inTriage = laneKey === TRIAGE;
    // Reorder buttons hide while a search or the Board Status chip narrows the
    // lane — "up" against a half-hidden queue would move the card somewhere
    // the eye can't follow.
    const reorder = canPlan() && !q && !laneQ[laneKey] && boardStatus === 'all' && !wipOnly && zone === 'all'
      ? action => moveWithin(laneKey, group, action) : undefined;
    const cardActions = c => ({
      onSend: inTriage && canPlan() ? pressId => sendGroups(pressId, [group]) : undefined,
      onSendBack: onPress && canPlan() ? () => sendGroups(TRIAGE, [group]) : undefined,
    });
    if (!group.gang_number) {
      const c = group.cards[0];
      return (
        <div key={group.key} {...groupProps(group, laneKey)}
          onClick={() => setChooser({ card: c, done: false })}
          className={draggable ? 'cursor-grab active:cursor-grabbing touch:select-none' : 'cursor-pointer'}>
          <Card card={c} grip={draggable} onPress={onPress} theme={theme} onDone={load}
            seq={seq} wide={onPress}
            selectable={inTriage && canPlan()} selected={sel.has(group.key)}
            onToggle={() => toggleSel(group.key)} presses={presses} {...cardActions(c)}
            onReorder={reorder} first={pos?.first} last={pos?.last} />
        </div>
      );
    }
    const sheets = group.cards.reduce((s, c) => s + c.sheets_issued, 0);
    // A gang leads with its PRODUCTS — the members' names ARE the title. The
    // gang number stays as the small violet code beside them.
    const gangTitle = group.cards.map(c => c.product_name).join('  +  ');
    return (
      <div key={group.key} {...groupProps(group, laneKey)}
        className={`rounded-2xl border border-dashed border-violet-300 bg-violet-50/60 p-1.5 ${draggable ? 'cursor-grab active:cursor-grabbing touch:select-none' : ''}`}>
        <div className="mb-1 px-1.5 pt-0.5">
          <div className="flex items-center gap-1.5">
            {draggable && <GripVertical size={11} className="shrink-0 text-violet-300" />}
            {inTriage && canPlan() && (
              <button onClick={e => { e.stopPropagation(); toggleSel(group.key); }}
                title={sel.has(group.key) ? 'Deselect gang' : 'Select whole gang'}
                className={`shrink-0 ${sel.has(group.key) ? 'text-violet-600' : 'text-violet-300 hover:text-violet-500'}`}>
                {sel.has(group.key) ? <CheckSquare size={14} /> : <Square size={14} />}
              </button>
            )}
            {seq != null && (
              <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-violet-100 text-[10px] font-extrabold tabular-nums text-violet-700">{seq}</span>
            )}
            <span className="flex items-center gap-1 rounded bg-violet-100 px-1.5 py-0.5 text-[9.5px] font-extrabold uppercase tracking-wide text-violet-700">
              <Link2 size={9} /> {group.gang_number}
            </span>
            <span className="text-[10px] font-bold text-violet-500">
              {group.cards.length === 1 ? 'gang run · moves as one' : `${group.cards.length} products · one sheet · move together`}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {reorder && <ReorderButtons onReorder={reorder} first={pos?.first} last={pos?.last}
                tone="text-violet-300 hover:text-violet-600 hover:bg-violet-100" />}
              <span className="text-[10px] font-bold tabular-nums text-violet-500">{fmt.num(sheets)} sh</span>
            </span>
          </div>
          <div className="mt-1 truncate text-[12px] font-extrabold leading-4 tracking-tight text-violet-900" title={gangTitle}>
            {gangTitle}
          </div>
          {canPlan() && (
            <div className="mt-1 flex items-center gap-1" onClick={e => e.stopPropagation()}>
              {inTriage && (<>
                <span className="text-[10px] font-bold uppercase tracking-wide text-violet-400">Send gang to</span>
                {presses.map((p, i) => (
                  <button key={p.id} title={p.name} onClick={() => sendGroups(p.id, [group])}
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm ${pressTheme(i).send}`}>
                    {shortPress(p.name).replace('Press ', 'P')}
                  </button>
                ))}
              </>)}
              {onPress && (
                <button onClick={() => sendGroups(TRIAGE, [group])}
                  className="flex items-center gap-1 rounded-md border border-violet-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-violet-600 hover:border-violet-300">
                  <CornerUpLeft size={10} /> Whole gang → Triage
                </button>
              )}
            </div>
          )}
        </div>
        <div className="space-y-1">
          {group.cards.map(c => (
            <div key={c.id} onClick={() => setChooser({ card: c, done: false })} className="cursor-pointer">
              <Card card={c} onPress={onPress} theme={theme} onDone={load} wide={onPress} />
            </div>
          ))}
        </div>
      </div>
    );
  };

  // Lane bodies scroll INSIDE themselves — a press day of 10-15 cards lives
  // behind the lane's own scrollbar, so the page never grows past one screen
  // and every lane's top (the next job to print) stays visible side by side.
  const laneShell = (theme, active, maxH) =>
    `flex min-h-[280px] flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-2xl border p-2.5 transition-colors [scrollbar-width:thin] ${maxH} ${
      active ? theme.active : `${theme.shell} shadow-card`}`;

  const triageSheets = (fullLanes[TRIAGE] || []).reduce((s, c) => s + (c.sheets_issued || 0), 0);

  return (
    <div>
      <PageHeader title="Print Planning"
        actions={<>
          {/* The whole-board search lives up here, clearly apart from each
              lane's own search below. It sweeps every lane at once (and the
              Completed table); a lane search then narrows within it. */}
          {q && tab === 'board' && (
            <span className="rounded-full bg-[#007AFF]/10 px-2.5 py-0.5 text-[11px] font-bold tabular-nums text-[#007AFF]">
              {matchCount ?? 0} match{matchCount === 1 ? '' : 'es'}
            </span>
          )}
          <SearchInput value={q} onChange={setQ} placeholder="Search whole board…" />
          {/* The one-page press line-up — the sheet the shift shares on each
              press's WhatsApp group. Opens its own tab so the board stays put. */}
          <a href="/print-planning/lineup" target="_blank" rel="noopener"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/75 bg-white/65 px-4 py-2 text-sm font-semibold text-[#1D1D1F] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] backdrop-blur-xl transition-all duration-200 ease-apple hover:bg-white/90 hover:text-[#007AFF]">
            <FileText size={14} /> Line-up Report
          </a>
          <ExportMenu build={() => {
            // Completed tab exports the green table exactly as filtered.
            if (tab === 'completed') {
              const pressName = id => presses.find(p => p.id === id)?.name || '—';
              const rows = completed
                .filter(c => completedPress === 'all' || c.machine_id === +completedPress)
                .filter(c => !q || rowMatches(c, q, productSearchText(c)))
                .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
              return {
                name: 'Printed Runs',
                title: 'Print Planning — Printed Runs',
                subtitle: 'Completed printing runs, latest first',
                meta: [
                  completedPress === 'all' ? 'All presses' : `Press: ${pressName(+completedPress)}`,
                  q ? `Search: "${q}"` : null,
                ],
                columns: [
                  { key: 'jc_number', label: 'Job Card', export: c => `${c.jc_number}${c.gang_number ? ` (${c.gang_number})` : ''}` },
                  { key: 'product_name', label: 'Product', export: productExport },
                  { key: 'customer_name', label: 'Customer' },
                  { key: 'press', label: 'Press', export: c => pressName(c.machine_id) },
                  { key: 'printed_sheets', label: 'Sheets Printed', align: 'right', export: c => fmt.num(c.printed_sheets ?? c.sheets_issued) },
                  { key: 'printing_operator', label: 'Operator', export: c => c.printing_operator || '—' },
                  { key: 'completed_at', label: 'Completed', export: c => fmt.dt(c.completed_at) },
                  // Same verdict as the cell beside it (cardSetType): a
                  // COMBINED run shared nothing, so it exports as Single.
                  { key: 'set_type', label: 'Set Type', export: c => SET_TYPE_META[cardSetType(c)].label },
                ],
                rows,
              };
            }
            const laneColumns = [
              { key: 'queue', label: '#', align: 'right', export: c => c._pos },
              { key: 'jc_number', label: 'Job Card' },
              { key: 'gang_number', label: 'Gang', export: c => c.gang_number || '—' },
              { key: 'set_type', label: 'Set Type', export: c => SET_TYPE_META[cardSetType(c)].label
                + (cardSetType(c) === 'hold' && c.hold_reason ? ` — ${c.hold_reason}` : '') },
              { key: 'product_name', label: 'Product', export: productExport },
              { key: 'customer_name', label: 'Customer' },
              { key: 'po_number', label: 'Customer PO', export: c => c.po_number || '—' },
              // A column the screen shows must leave with the sheet — same rule
              // the comment below states for the ones after it.
              { key: 'po_date', label: 'PO Date', export: c => (c.po_date ? fmt.date(c.po_date) : '—') },
              { key: 'od', label: 'OD', align: 'right',
                export: c => { return odExport(odDays(c.po_date)); } },
              { key: 'qty_planned', label: 'Ordered pcs', align: 'right', export: c => fmt.num(c.qty_planned) },
              { key: 'sheets_issued', label: 'Sheets', align: 'right', export: c => fmt.num(c.sheets_issued) },
              // A column the screen shows must leave with the sheet, or the
              // printed board and the live board disagree about the same job.
              { key: 'board_state', label: 'Board Status', export: c => BOARD_FULL[boardStateOf(c)] || '—' },
              // Same rule for ink: what the press planner reads on screen has
              // to leave with the sheet, including the Pantone and metallic
              // detail that decides which inks get pulled from the store.
              { key: 'colour_type', label: 'Colour Type', export: c => colourTypeOf(c) || '—' },
              { key: 'print_process', label: 'Process', export: c => processOf(c) || '—' },
              { key: 'colors', label: 'Colours', align: 'right', export: c => totalColoursOf(c) ?? '—' },
              { key: 'pantone_codes', label: 'Pantone Codes', export: c => c.pantone_codes || '—' },
              { key: 'metallic_details', label: 'Metallic', export: c => c.metallic_details || '—' },
              { key: 'planned_date', label: 'Planned', export: c => (c.planned_date ? fmt.date(c.planned_date) : '—') },
              { key: 'delivery_date', label: 'Delivery', export: c => (c.delivery_date ? fmt.date(c.delivery_date) : '—') },
            ];
            const withPos = list => list.map((c, i) => ({ ...c, _pos: i + 1 }));
            return {
              name: 'Print Planning Board',
              title: 'Print Planning Board',
              subtitle: 'Press queues top-to-bottom — the live printing order',
              // The export mirrors the screen, filters included — say so in the
              // meta so a filtered sheet can never pass as the whole board.
              meta: [
                wipOnly ? 'Customer WIP only' : null,
                boardStatus !== 'all' ? `Board filter: ${BOARD_LABEL[boardStatus]}` : null,
                zone !== 'all' ? `Set type: ${SET_TYPE_META[zone].label}` : null,
                colourSel.size ? `Colour filter: ${[...colourSel].join(', ')}` : null,
                processSel.size ? `Process filter: ${[...processSel].join(', ')}` : null,
                bandSel.size ? `Colour count: ${[...bandSel].join(', ')}` : null,
                q ? `Search: "${q}"` : null,
                ...Object.entries(laneQ).filter(([, v]) => v).map(([k, v]) =>
                  `Lane search (${k === TRIAGE ? 'Triage' : presses.find(p => p.id === +k)?.name || k}): "${v}"`),
              ],
              summary: [
                { label: 'In triage', value: lanes[TRIAGE].length },
                { label: 'Assigned', value: presses.reduce((s, p) => s + (lanes[p.id] || []).length, 0) },
                { label: 'Presses', value: presses.length },
              ],
              sections: [
                { heading: 'Triage — Unassigned', columns: laneColumns, rows: withPos(lanes[TRIAGE]) },
                ...presses.map(p => ({
                  heading: `${p.name} — ${fmt.num((lanes[p.id] || []).reduce((s, c) => s + c.sheets_issued, 0))} sheets queued`,
                  columns: laneColumns,
                  rows: withPos(lanes[p.id] || []),
                })),
              ],
            };
          }} />
          <Link to="/floor/printing" className="inline-flex items-center gap-1.5 rounded-full border border-white/75 bg-white/65 px-4 py-2 text-sm font-semibold text-[#1D1D1F] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(29,29,31,0.05),0_8px_20px_rgba(29,29,31,0.06)] backdrop-blur-xl transition-all duration-200 ease-apple hover:bg-white/90 hover:text-[#007AFF]">
          <Radio size={14} /> Live Printing
        </Link></>} />

      {/* ROW 1 — the view switch and every filter, and nothing else. Six axes
          narrow this board; each is a captioned group behind a hairline, so the
          rail reads as six short questions rather than one run of twenty chips.
          The triage toolbar that used to share this container now has its own
          row below. Gaps stay tight (gap-x-2): the dividers do the separating,
          and a wide gap on top of them spaces the rail out twice. */}
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="inline-flex shrink-0 rounded-full border border-white/70 bg-white/60 p-1 shadow-card backdrop-blur-xl">
          {[['board', 'Board', LayoutGrid], ['completed', 'Completed', CheckCircle2]].map(([key, label, Icon]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-all ${
                tab === key ? 'bg-white text-[#007AFF] shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              <Icon size={14} /> {label}
              {key === 'completed' && completed.length > 0 && (
                <span className="ml-1 rounded-full bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-700">{completed.length}</span>
              )}
            </button>
          ))}
        </div>
        {tab === 'board' && (
          // Changing the chip also clears the triage selection — a bulk send
          // must never carry rows the filter has just hidden from the eye.
          <BoardStatusChips value={boardStatus} counts={boardCounts}
            onChange={k => { setBoardStatus(k); clearSel(); }} />
        )}
        {tab === 'board' && (
          // Set-type zones — the same four words Planning's queue triages by,
          // read off this board's facts (gang stacks; the press hold). View-
          // only, like every chip on this rail: positions are never rewritten,
          // and a change clears the selection so a bulk send can't carry rows
          // the eye just lost.
          //
          // Only Gang and Hold spend a hue. Single is the ordinary case and has
          // nothing to warn about, so it lights graphite alongside All — which
          // is the rule the whole rail now follows: colour marks the jobs
          // somebody has to act on, structure says which axis you are on.
          <FilterGroup label="Set Type">
            {[['all', 'All', null], ['single', 'Single', SET_TYPE_META.single.icon], ['gang', 'Gang', Link2], ['hold', 'Hold', PauseCircle]].map(([k, label, Icon]) => (
              <FilterChip key={k} label={label} icon={Icon} count={zoneCounts[k]} on={zone === k}
                tone={SET_TYPE_META[k]?.lit}
                onClick={() => { setZone(k); clearSel(); }} />
            ))}
          </FilterGroup>
        )}
        {/* Combined — a second AXIS, not a fifth zone: it narrows whichever
            zone is open, so it gets its own caption rather than sitting in the
            Set Type run where it would read as one. Teal because violet here
            means "splits after die cutting", the one thing a combined run never
            does. Hidden at zero so the rail does not grow on a board without
            one — and the group's hairline goes with it. */}
        {tab === 'board' && mergeCount > 0 && (
          <FilterGroup label="Only">
            <FilterChip label="Combined" icon={Layers} count={mergeCount} on={mergeOnly}
              tone="border-teal-200 bg-teal-100 text-teal-800"
              title="Combined runs only — one product on several sales orders, printed as one pile"
              onClick={() => { setMergeOnly(v => !v); clearSel(); }} />
          </FilterGroup>
        )}
        {tab === 'board' && (
          // The only chip here about URGENCY rather than about what the job is,
          // and the one chip that keeps the system blue. It sits before the ink
          // block rather than after it so the rail breaks into even rows: the
          // axes that describe the JOB, then the ones that describe its INK
          // (that block is its own flex container and always wraps whole).
          //
          // Now the shared group, so the artwork queue and the job-card register
          // filter urgency with the identical control — WipFilter.jsx carries
          // the reason the blue is spent here and nowhere else.
          <WipFilterGroup count={cards.filter(c => c.wip).length} on={wipOnly}
            scope="across the board" unit="card"
            onToggle={() => { setWipOnly(w => !w); clearSel(); }} />
        )}
        {tab === 'board' && (
          // WHOSE job it is — next to Urgency because Customer WIP asks about
          // the same company and the two read together, but a separate axis: WIP
          // is "they are chasing it", this is "it is theirs". Sits before the ink
          // block for the same reason Urgency does — that block is its own flex
          // container and always wraps whole.
          //
          // Selecting clears the triage selection like every chip on this rail:
          // a bulk send must never carry cards the filter has just hidden.
          <CustomerFilterGroup chips={customerChips} selected={customerFilters}
            scope="across the board" unit="card"
            note="Composes with the board cards, the zones and the ink chips"
            onToggle={id => { setCustomerFilters(f => toggleCustomer(f, id)); clearSel(); }} />
        )}
        {/* ── INK, BEHIND A DISCLOSURE ────────────────────────────────────────
            Eight axes on one rail is a paint chart even after every one of them
            got a caption: Board, Set Type, Only, Urgency and Customer describe
            WHICH JOB, and the eye triages on those. Ink, Process and Colours
            describe how it PRINTS — three more axes and eleven more chips,
            asked for far less often, and between them they were most of why
            this rail wrapped onto three rows.

            So they fold. The four triage axes stay always-visible and the ink
            block opens on demand, which puts the ordinary board back on one or
            two rows without taking a single control away.

            THE TOGGLE LIGHTS WHEN THE FOLDED AXES ARE FILTERING, and carries
            their count. That is the whole safety of this: a filter that
            narrows the board while invisible is the bug this page has already
            shipped once — a chip left lit somewhere it is no longer offered
            empties the register with nothing on screen to explain it. Collapsed
            and active, the control is blue, counts the active axes and names
            them on hover; Reset still clears them with everything else. */}
        {tab === 'board' && (
          <FilterGroup label="Ink">
            <FilterChip label={inkOpen ? 'Hide' : 'Filters'} icon={inkOpen ? ChevronUp : SlidersHorizontal}
              count={inkActiveCount || null} on={inkOpen || inkActiveCount > 0}
              tone={inkActiveCount > 0
                ? 'border-[#0A84FF]/30 bg-[#0A84FF] text-white'
                : undefined}
              countTone={inkActiveCount > 0 ? 'bg-white/25' : undefined}
              title={inkActiveCount > 0
                ? `Narrowed by ${activeInkNames.join(', ')} — ${inkOpen ? 'the chips are below' : 'click to show the chips, or Reset filters to clear them'}.`
                : 'Ink, process and colour-count filters — the same three axes the printing station queue uses.'}
              onClick={() => setInkOpen(v => !v)} />
          </FilterGroup>
        )}
        {tab === 'board' && inkOpen && (
          // Ink filters — the same rail the printing station queue uses, so a
          // planner and a press operator narrow the same way. Selecting also
          // clears the triage selection: a bulk send must never carry rows the
          // filter has just hidden from the eye.
          //
          // Its own flex container, so it always wraps as one whole block onto
          // the row the disclosure opens.
          <PrintColourFilterRail
            colour={colourSel} setColour={s => { setColourSel(s); clearSel(); }}
            process={processSel} setProcess={s => { setProcessSel(s); clearSel(); }}
            band={bandSel} setBand={s => { setBandSel(s); clearSel(); }}
            counts={colourCounts} scope="across the board" />
        )}
        {/* Nine axes narrow this board and every one of them is a small chip.
            One control puts them all back; hidden while none is lit. */}
        {tab === 'board' && <ResetFilters filters={filters} className="ml-auto" />}
      </div>

      {/* The TRIAGE TOOLBAR — its own row, not more chips on the filter rail.
          It used to share that wrap container, so "13 jobs · 22,026 sh", the
          lane search and three buttons queued up behind twenty filter chips and
          landed wherever the wrap happened to put them. They are not filters;
          they act on the band directly below them, and they now sit with it. */}
      {tab === 'board' && (
          <div className="mb-2.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="flex items-center gap-1.5 text-sm font-extrabold text-slate-900">
              <Inbox size={14} className={TRIAGE_THEME.icon} /> Triage
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${TRIAGE_THEME.badge}`}>
              {laneQ[TRIAGE] || boardFilterActive
                ? `${lanes[TRIAGE].length} of ${(fullLanes[TRIAGE] || []).length} jobs`
                : `${lanes[TRIAGE].length} job${lanes[TRIAGE].length === 1 ? '' : 's'} · ${fmt.num(triageSheets)} sh`}
            </span>
            <span className="w-48">
              <LaneSearch value={laneQ[TRIAGE] || ''} onChange={v => setLQ(TRIAGE, v)} placeholder="Search Triage…" />
            </span>
            <button onClick={() => setExpanded(TRIAGE)} title="Expand Triage as a full-screen table"
              className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800">
              <Maximize2 size={11} /> Table
            </button>
            {canPlan() && (<>
              <button onClick={selectAllTriage} disabled={!triageGroups.length}
                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:opacity-40">
                Select all
              </button>
              <button onClick={clearSel} disabled={!sel.size}
                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:opacity-40">
                Deselect all
              </button>
              {sel.size > 0 && (
                <span className="flex flex-wrap items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/80 py-1 pl-3 pr-1.5">
                  <span className="text-[11px] font-extrabold tabular-nums text-blue-700">
                    {selGroups.reduce((s, g) => s + g.cards.length, 0)} selected · {fmt.num(selSheets)} sh
                  </span>
                  <span className="text-[11px] font-bold uppercase tracking-wide text-blue-400">Send to</span>
                  {presses.map((p, i) => (
                    <button key={p.id} title={p.name} onClick={() => sendGroups(p.id, selGroups)}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold text-white shadow-sm transition-colors ${pressTheme(i).send}`}>
                      {shortPress(p.name)}
                    </button>
                  ))}
                </span>
              )}
            </>)}
        </div>
      )}

      {tab === 'board' && (<>
      {/* What the board is currently narrowed to, said back in words with one
          way out — a lit chip in a long rail is easy to leave on and then
          mistake a filtered board for the whole queue. */}
      <ActiveColourFilters colour={colourSel} process={processSel} band={bandSel}
        onClear={() => { clearColourFilters(); clearSel(); }} className="mb-2" />
      {/* ============ TRIAGE — full-width band on top ============
          Its toolbar lives up in the header row; the band is pure cards. */}
      <div className="mb-4">
        {/* One horizontal rail — triage never eats vertical space from the
            presses however many jobs pile up. Scroll sideways (trackpad swipe,
            the thin scrollbar, or the ‹ › buttons); the full list experience
            lives in the Table view. */}
        <div data-lane {...laneProps(TRIAGE)}
          className={`relative rounded-2xl border p-2.5 shadow-card transition-colors ${
            dragOverLane === TRIAGE ? TRIAGE_THEME.active : TRIAGE_THEME.shell}`}>
          <div ref={triageRail}
            className="flex gap-2 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-width:thin]"
            style={{ minHeight: '120px' }}>
            {triageGroups.map((g, i, arr) => (
              <div key={`rail-${g.key}`} className="w-[345px] shrink-0">
                {renderGroup(g, TRIAGE, TRIAGE_THEME, null, { first: i === 0, last: i === arr.length - 1 })}
              </div>
            ))}
            {lanes[TRIAGE].length === 0 && (
              <div className="flex w-full flex-col items-center gap-1.5 py-8 text-center text-slate-300">
                <CheckCircle2 size={22} className="text-emerald-300" />
                <span className="text-xs font-semibold text-slate-400">
                  {(fullLanes[TRIAGE] || []).length > 0 && (laneQ[TRIAGE] || boardFilterActive)
                    ? emptyLaneReason('Triage', laneQ[TRIAGE])
                    : 'All jobs assigned'}
                </span>
                <span className="text-[10px]">Drop a card here to send it back to triage</span>
              </div>
            )}
          </div>
          {triageGroups.length > 4 && (<>
            {/* Instant jumps, not behavior:'smooth' — smooth scroll animation
                frames are throttled to zero in embedded/wall-display webviews,
                where the button would silently do nothing. */}
            <button onClick={() => triageRail.current?.scrollBy({ left: -710 })}
              title="Scroll left"
              className="absolute left-1.5 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-500 shadow-lg backdrop-blur transition-colors hover:text-slate-800">
              <ChevronLeft size={16} />
            </button>
            <button onClick={() => triageRail.current?.scrollBy({ left: 710 })}
              title="Scroll right"
              className="absolute right-1.5 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-500 shadow-lg backdrop-blur transition-colors hover:text-slate-800">
              <ChevronRight size={16} />
            </button>
          </>)}
        </div>
      </div>

      {/* ============ PRESS LANES — full width below ============ */}
      <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 400px), 1fr))` }}>
        {presses.map((p, idx) => {
          const lane = lanes[p.id] || [];
          const sheets = lane.reduce((s, c) => s + c.sheets_issued, 0);
          const theme = pressTheme(idx);
          return (
            <div key={p.id} className="flex flex-col">
              <div className="mb-2 flex min-h-[3.25rem] items-start justify-between gap-2 px-1">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 truncate text-sm font-extrabold text-slate-900">
                    <Printer size={14} className={theme.icon} /> {p.name}
                  </span>
                  {/* Press designation + who runs it, stacked so neither truncates */}
                  {p.model && (
                    <div className="mt-0.5 truncate pl-[22px] text-[11px] font-semibold text-slate-400">{p.model}</div>
                  )}
                  {p.operators?.length > 0 && (
                    <div className="mt-0.5 flex items-center gap-1 truncate pl-[22px] text-[11px] font-bold text-slate-600">
                      <User size={10} className="text-slate-400" />
                      {p.operators.map(o => o.name).join(', ')}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="flex items-center gap-1">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${theme.badge}`}>
                      {laneQ[p.id] || boardFilterActive
                        ? `${lane.length} of ${(fullLanes[p.id] || []).length}`
                        : `${lane.length} · ${fmt.num(sheets)} sh`}
                    </span>
                    <button onClick={() => setExpanded(p.id)} title={`Expand ${p.name} as a full-screen table`}
                      className="rounded-full border border-slate-200 bg-white p-1 text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-700">
                      <Maximize2 size={11} />
                    </button>
                  </span>
                  {/* The day's output on this press — climbs as runs complete. */}
                  {todayByPress[p.id] > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-emerald-600">
                      <CheckCircle2 size={10} /> {fmt.num(todayByPress[p.id])} sh today
                    </span>
                  )}
                </div>
              </div>
              {/* This press's own search — filters this lane only, live. */}
              <div className="mb-1.5 flex px-0.5">
                <LaneSearch value={laneQ[p.id] || ''} onChange={v => setLQ(p.id, v)}
                  placeholder={`Search ${shortPress(p.name)}…`} />
              </div>
              <div data-lane className={laneShell(theme, dragOverLane === p.id, 'max-h-[calc(100vh-300px)]')} {...laneProps(p.id)}>
                {/* Under the Board Status chip the visible list is not the
                    queue, so per-card numbers would lie — mask them like the
                    expanded table does. */}
                {groupLane(lane).map((g, i, arr) =>
                  renderGroup(g, p.id, theme, boardStatus === 'all' && !wipOnly && zone === 'all' ? i + 1 : '·', { first: i === 0, last: i === arr.length - 1 }))}
                {lane.length === 0 && (
                  <div className="flex flex-col items-center gap-1.5 py-12 text-center text-slate-300">
                    <ArrowDown size={20} className={dragOverLane === p.id ? theme.icon : 'text-slate-300'} />
                    <span className="text-xs font-semibold text-slate-400">
                      {(fullLanes[p.id] || []).length > 0 && (laneQ[p.id] || boardFilterActive)
                        // One spelling: this copy named the board-status filter
                        // unconditionally, so any OTHER axis emptying the lane
                        // (Customer WIP, colour, Combined) printed `is
                        // "undefined"`. The helper names whichever axis did it.
                        ? emptyLaneReason(shortPress(p.name), laneQ[p.id])
                        : `Drag jobs here — or tick them in Triage and press "${shortPress(p.name)}"`}
                    </span>
                    <span className="text-[10px]">They queue top-to-bottom</span>
                  </div>
                )}
                {/* Printed runs live in the Completed table now — a finished job
                    leaves the board so lanes only ever show work still to do. */}
              </div>
            </div>
          );
        })}
      </div>

      {/* ============ EXPANDED LANE — the same lane as a full-screen table ============
          Not a new module: same cards, same colours, same actions (drag, reorder,
          send, hold menu, readiness, details), just information-dense. Its own
          search filters this lane only, live per keystroke; column sorts re-VIEW
          the queue — while a filter or sort is active, reordering pauses so the
          eye and the queue can never disagree. */}
      {expanded != null && (() => {
        const isT = expanded === TRIAGE;
        const pIdx = isT ? -1 : presses.findIndex(p => p.id === expanded);
        const press = isT ? null : presses[pIdx];
        if (!isT && !press) return null;
        const theme = isT ? TRIAGE_THEME : pressTheme(pIdx);
        const laneAll = fullLanes[expanded] || [];
        const laneSheets = laneAll.reduce((s, c) => s + c.sheets_issued, 0);
        // Gang verdicts are uniform across members (weakest member decides),
        // so testing the lead card IS the group's board-status verdict.
        const laneCounts = countStates(laneAll);
        const laneColourCounts = colourFilterCounts(laneAll);
        let groups = groupLane(laneAll).filter(g =>
          (!wipOnly || g.cards.some(c => c.wip)) &&
          (boardStatus === 'all' || statusPass(g.cards[0])) &&
          (zone === 'all' || zoneOf(g.cards[0]) === zone) &&
          (!mergeOnly || isMergeRun(g.cards[0])) &&
          (!anyColourFilter || matchesColourFilters(g.cards[0], colourFilters)) &&
          (!expQ || g.cards.some(c => rowMatches(c, expQ, productSearchText(c)))));
        if (expSort) {
          const { key, dir } = expSort;
          // Board Status sorts by TROUBLE, not by the alphabet — and through the
          // same fallback the badge uses, so a mid-deploy card still ranks.
          // Colour and process sort the same way: by INTENT (metallic first,
          // richest build first), which is the order a press planner asks for —
          // alphabetically, "Offset + Metallic" would sort under O beside plain
          // Offset, which is the opposite of useful.
          const val = c => (key === 'board_state' ? BOARD_RANK[boardStateOf(c)]
            : key === 'colour_type' ? (COLOUR_RANK[colourTypeOf(c)] ?? 9)
            : key === 'print_process' ? (PROCESS_RANK[processOf(c)] ?? 9)
            : key === 'colors' ? totalColoursOf(c)
            : c[key]);
          // PO date and OD read the WHOLE group, not its first card: a run is as
          // overdue as the longest-waiting PO on the sheet, so a gang sorts by
          // its oldest member. Every other key keeps reading cards[0].
          const groupVal = g => {
            if (key === 'po_date') return groupPoAge(g).date ?? '';
            // The days themselves, not the date — sorting the date ascending
            // would put the MOST overdue first under an "asc" arrow, which is
            // the opposite of what the arrow says.
            if (key === 'od') return groupPoAge(g).days;
            return val(g.cards[0]);
          };
          groups = [...groups].sort((a, b) => {
            const va = groupVal(a), vb = groupVal(b);
            if (va == null || va === '') return 1;
            if (vb == null || vb === '') return -1;
            const na = +va, nb = +vb;
            const r = !isNaN(na) && !isNaN(nb) ? na - nb : String(va).localeCompare(String(vb));
            return dir === 'asc' ? r : -r;
          });
        }
        const shownCards = groups.reduce((s, g) => s + g.cards.length, 0);
        const interactive = canPlan() && !expQ && !expSort && !boardFilterActive;
        const rail = { triage: 'border-t-slate-300' }[expanded] ||
          ['border-t-blue-400', 'border-t-emerald-400', 'border-t-violet-400', 'border-t-teal-400'][pIdx % 4];
        const Th = ({ children, k, right, w, pin }) => (
          <th style={w ? { width: w } : undefined}
            className={`sticky top-0 border-b border-slate-200 bg-white/95 px-2 py-2 text-[10px] font-extrabold uppercase tracking-wider text-slate-400 backdrop-blur ${right ? 'text-right' : 'text-left'} ${
              pin ? 'right-0 z-20 shadow-[-8px_0_8px_-8px_rgba(11,18,32,0.10)]' : 'z-10'}`}>
            {k ? (
              <button
                onClick={() => setExpSort(s => (s?.key !== k ? { key: k, dir: 'asc' } : s.dir === 'asc' ? { key: k, dir: 'desc' } : null))}
                className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-slate-700 ${expSort?.key === k ? 'text-blue-600' : ''}`}>
                {children}
                {expSort?.key === k
                  ? (expSort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
                  : <ChevronsUpDown size={11} className="text-slate-300" />}
              </button>
            ) : children}
          </th>
        );
        const td = 'border-b border-slate-100 px-2 py-2 align-top';
        // One data row. Every fact the kanban card shows, one cell each; the
        // lead row of a group also carries position + the group's actions.
        const renderRow = (card, group, isLead, seq, pos) => {
          const { running, partial, held, dot, pill, pillLabel } = statusOf(card, !isT, theme);
          const late = isOverdue(card.delivery_date);
          const board = card.board_display || null;
          const gsm = card.gsm && !(board || '').includes(String(card.gsm)) ? `${card.gsm} gsm` : null;
          const expected = plannedChildSheets(card); // Σ per board under a mix
          const pct = (running || partial) && card.printed_so_far > 0 && expected > 0
            ? Math.min(100, Math.round((100 * card.printed_so_far) / expected)) : null;
          const gang = !!group.gang_number;
          const reorder = interactive ? action => moveWithin(expanded, group, action) : undefined;
          return (
            <tr key={card.id} {...(interactive ? groupProps(group, expanded) : {})}
              onClick={() => setChooser({ card, done: false })}
              className={`group cursor-pointer transition-colors hover:bg-blue-50/40 ${
                gang ? 'bg-violet-50/40' : ''} ${interactive ? 'cursor-grab active:cursor-grabbing' : ''}`}>
              <td className={`${td} w-14`}>
                {isLead && (
                  <span className="flex items-center gap-1">
                    {interactive && <GripVertical size={12} className="shrink-0 text-slate-300" />}
                    {isT && canPlan() ? (
                      <button onClick={e => { e.stopPropagation(); toggleSel(group.key); }}
                        className={`shrink-0 rounded transition-colors ${sel.has(group.key) ? 'text-blue-600' : 'text-slate-300 hover:text-slate-500'}`}>
                        {sel.has(group.key) ? <CheckSquare size={15} /> : <Square size={15} />}
                      </button>
                    ) : (
                      <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-md text-[10px] font-extrabold tabular-nums ${theme?.queue || 'bg-slate-100 text-slate-500'}`}>{seq}</span>
                    )}
                  </span>
                )}
                {!isLead && <CornerUpLeft size={11} className="ml-1 rotate-180 text-violet-300" />}
              </td>
              <td className={`${td} min-w-[110px]`}>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${dot} ${running ? 'animate-pulseSoft' : ''}`} /> {pillLabel}
                </span>
                {held && card.hold_reason && (
                  <div className="mt-1 max-w-[150px] truncate text-[10px] font-semibold text-red-500" title={card.hold_reason}>{card.hold_reason}</div>
                )}
                {pct != null && (
                  <div className="mt-1.5 w-[110px]">
                    <div className={`text-[10px] font-bold tabular-nums ${partial ? 'text-cyan-700' : 'text-amber-700'}`}>
                      {fmt.num(card.printed_so_far)} / {fmt.num(expected)} sh · {pct}%
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${partial ? 'bg-cyan-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )}
              </td>
              <td className={`${td} min-w-[220px]`}>
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] font-extrabold tracking-tight text-slate-900">{card.jc_number}</span>
                  {gang && <span className="rounded bg-violet-100 px-1 py-px text-[9px] font-bold text-violet-700">{group.gang_number}</span>}
                </span>
                <ProductIdentity row={card} compact className="mt-0.5 max-w-[340px]"
                  nameClassName="text-[11.5px] font-bold text-slate-700" />
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <span className={`inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[11px] font-extrabold tabular-nums ${
                  card.output_no ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-300'}`}>
                  {card.output_no || '—'}
                </span>
              </td>
              <td className={`${td} max-w-[160px] truncate text-[11px] font-semibold text-slate-600`} title={card.customer_name}>
                <CustomerDot id={card.customer_id} />{card.customer_name || '—'}</td>
              <td className={`${td} max-w-[130px] truncate text-[11px] font-semibold text-slate-500`} title={card.party_artwork_code || ''}>{card.party_artwork_code || '—'}</td>
              <td className={`${td} whitespace-nowrap`}>
                {/* The date moved to its own sortable column beside this one. */}
                <div className="text-[11.5px] font-bold text-slate-700">{card.po_number || '—'}</div>
              </td>
              <td className={`${td} whitespace-nowrap text-[11px] font-semibold tabular-nums text-slate-600`}>
                {card.po_date ? fmt.date(card.po_date) : <span className="text-slate-300">—</span>}
              </td>
              <td className={`${td} whitespace-nowrap text-right`}>
                <OverdueDays days={odDays(card.po_date)} />
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <div className={`text-[11.5px] font-bold ${late ? 'text-red-600' : 'text-slate-700'}`}>
                  {card.delivery_date ? fmt.date(card.delivery_date) : '—'}{late && <span className="ml-1 rounded bg-red-50 px-1 text-[9px] font-bold">late</span>}
                </div>
                {card.planned_date && <div className="text-[10px] font-semibold text-slate-400">plan {fmt.date(card.planned_date)}</div>}
              </td>
              <td className={`${td} whitespace-nowrap text-right`}>
                <div className="text-[12px] font-extrabold tabular-nums text-blue-600">{card.qty_planned ? `${fmt.num(card.qty_planned)}` : '—'}<span className="ml-0.5 text-[9px] font-bold text-slate-400">pcs</span></div>
                <div className="text-[10px] font-semibold tabular-nums text-slate-400"
                  title={isMix(card) ? mixTitle(card) : undefined}>
                  {fmt.num(card.sheets_issued)} sh · {card.colors ?? '—'} col · {isMix(card)
                    ? `mixed · ${card.mix_cuts.length} boards`
                    : `${card.children_per_parent || 1} cut`}
                </div>
              </td>
              <td className={`${td} min-w-[140px]`}>
                <span className="flex flex-wrap gap-1">
                  {board && <span className="rounded-md border border-amber-100 bg-amber-50/70 px-1.5 py-px text-[9.5px] font-bold text-amber-800">{board}</span>}
                  {gsm && <span className="rounded-md border border-amber-100 bg-amber-50/70 px-1.5 py-px text-[9.5px] font-bold text-amber-800">{gsm}</span>}
                  {card.coating && <span className="rounded-md border border-slate-100 bg-slate-50 px-1.5 py-px text-[9.5px] font-bold text-slate-500">{card.coating}</span>}
                </span>
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <div className="flex items-center gap-1">
                  <BoardBadge state={boardStateOf(card)} />
                  {card.plate_state && <PlateStatus state={card.plate_state} wear={card.plate_wear} wearRuns={card.plate_wear_runs} wearReplace={card.plate_wear_replace} compact />}
                </div>
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <ColourBadge row={card} compact />
                <ColourCodeLines row={card} className="mt-0.5 max-w-[150px]" />
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <ProcessBadge row={card} />
              </td>
              <td className={`${td} whitespace-nowrap text-right`}>
                <div className="font-semibold tabular-nums">{totalColoursOf(card) ?? '—'}</div>
                <div className="max-w-[160px] truncate text-[11px] text-slate-400" title={colourSummary(card)}>{colourSummary(card)}</div>
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <span className="flex items-center gap-1.5">
                  {card.light && (
                    <span onClick={e => e.stopPropagation()}>
                      <ReadinessPopover light={card.light}><TrafficLight light={card.light} size="sm" /></ReadinessPopover>
                    </span>
                  )}
                </span>
                <div className="mt-0.5"><SetTypeChip type={cardSetType(card)} reason={cardSetType(card) === 'hold' ? card.hold_reason : ''} /></div>
                {card.wip && <div className="mt-0.5"><WipChip on /></div>}
                {card.tooling_ready === false && <div className="mt-0.5 text-[9.5px] font-bold text-red-600">✕ Tooling</div>}
              </td>
              <td className={`${td} max-w-[110px] truncate text-[11px] font-semibold text-slate-500`}>{card.printing_operator || '—'}</td>
              {/* Pinned right so reorder/send controls never hide behind a
                  horizontal scroll, whatever the screen width. */}
              <td onClick={e => e.stopPropagation()}
                className={`${td} sticky right-0 z-[5] w-[210px] bg-white shadow-[-8px_0_8px_-8px_rgba(11,18,32,0.10)]`}>
                {isLead && (
                  <span className="flex items-center justify-end gap-1.5">
                    {reorder && <ReorderButtons onReorder={reorder} first={pos.first} last={pos.last} />}
                    {isT && canPlan() && presses.map((p2, i2) => (
                      <button key={p2.id} title={`Send to ${p2.name}`} onClick={() => sendGroups(p2.id, [group])}
                        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold text-white shadow-sm ${pressTheme(i2).send}`}>
                        {shortPress(p2.name)}
                      </button>
                    ))}
                    {!isT && canPlan() && (
                      <button title="Send back to Triage" onClick={() => sendGroups(TRIAGE, [group])}
                        className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600 hover:border-slate-300 hover:text-slate-800">
                        <CornerUpLeft size={10} /> Triage
                      </button>
                    )}
                    <DangerZone jobCard={card} onDone={load} asMenu />
                    <ChevronRight size={13} className="text-slate-300 group-hover:text-blue-400" />
                  </span>
                )}
                {!isLead && (
                  <span className="flex items-center justify-end gap-1.5">
                    <DangerZone jobCard={card} onDone={load} asMenu />
                    <ChevronRight size={13} className="text-slate-300 group-hover:text-blue-400" />
                  </span>
                )}
              </td>
            </tr>
          );
        };
        return (
          <div data-drop-scope className={`fixed inset-0 z-40 flex flex-col border-t-4 bg-gradient-to-b from-slate-50 to-slate-100 ${rail}`}>
            {/* Toolbar — same identity as the lane header, plus this view's own search */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200/80 bg-white/80 px-5 py-3 backdrop-blur-xl">
              <span className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight text-slate-900">
                {isT ? <Inbox size={16} className={theme.icon} /> : <Printer size={16} className={theme.icon} />}
                {isT ? 'Triage' : press.name}
              </span>
              {!isT && press.model && <span className="text-[11px] font-semibold text-slate-400">{press.model}</span>}
              {!isT && press.operators?.length > 0 && (
                <span className="flex items-center gap-1 text-[11px] font-bold text-slate-600">
                  <User size={11} className="text-slate-400" /> {press.operators.map(o => o.name).join(', ')}
                </span>
              )}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${theme.badge}`}>
                {laneAll.length} job{laneAll.length === 1 ? '' : 's'} · {fmt.num(laneSheets)} sh
              </span>
              <BoardStatusChips value={boardStatus} counts={laneCounts} scope="in this lane"
                onChange={k => { setBoardStatus(k); clearSel(); }} />
              {/* Same three Sets as the board, so a filter set on the kanban is
                  still set here and vice versa — switching card ↔ table view
                  never silently widens what is being looked at. */}
              <PrintColourFilterRail
                colour={colourSel} setColour={s => { setColourSel(s); clearSel(); }}
                process={processSel} setProcess={s => { setProcessSel(s); clearSel(); }}
                band={bandSel} setBand={s => { setBandSel(s); clearSel(); }}
                counts={laneColourCounts} scope="in this lane" />
              {!isT && todayByPress[expanded] > 0 && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-emerald-600">
                  <CheckCircle2 size={10} /> {fmt.num(todayByPress[expanded])} sh today
                </span>
              )}
              {isT && canPlan() && (<>
                <button onClick={selectAllTriage} disabled={!triageGroups.length}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:opacity-40">
                  Select all
                </button>
                <button onClick={clearSel} disabled={!sel.size}
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800 disabled:opacity-40">
                  Deselect all
                </button>
                {sel.size > 0 && (
                  <span className="flex flex-wrap items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50/80 py-1 pl-3 pr-1.5">
                    <span className="text-[11px] font-extrabold tabular-nums text-blue-700">
                      {selGroups.reduce((s, g) => s + g.cards.length, 0)} selected · {fmt.num(selSheets)} sh
                    </span>
                    <span className="text-[11px] font-bold uppercase tracking-wide text-blue-400">Send to</span>
                    {presses.map((p2, i2) => (
                      <button key={p2.id} title={p2.name} onClick={() => sendGroups(p2.id, selGroups)}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold text-white shadow-sm transition-colors ${pressTheme(i2).send}`}>
                        {shortPress(p2.name)}
                      </button>
                    ))}
                  </span>
                )}
              </>)}
              {!interactive && canPlan() && (
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[10.5px] font-bold text-amber-700">
                  {expQ ? 'Filtered view' : expSort ? 'Sorted view' : 'Board-filter view'} — drag & reorder paused
                  {expSort && (
                    <button onClick={() => setExpSort(null)} className="ml-1.5 underline decoration-amber-300 underline-offset-2 hover:text-amber-900">
                      back to queue order
                    </button>
                  )}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2">
                {(expQ || boardFilterActive) && (
                  <span className="rounded-full bg-[#007AFF]/10 px-2.5 py-0.5 text-[11px] font-bold tabular-nums text-[#007AFF]">
                    {shownCards} of {laneAll.length}
                  </span>
                )}
                <SearchInput className="w-72 md:w-96" value={expQ} onChange={setExpQ}
                  placeholder={`Search ${isT ? 'Triage' : shortPress(press.name)} — JC, output, artwork, PO, product…`} />
                <button onClick={() => setExpanded(null)} title="Back to board (Esc)"
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800">
                  <Minimize2 size={12} /> Board
                </button>
              </span>
            </div>

            {/* The queue as a table — drop targets and drag sources are the same
                handlers the kanban uses, so behaviour is identical. */}
            <div data-lane {...(interactive ? laneProps(expanded) : {})}
              className={`min-h-0 flex-1 overflow-auto px-5 pb-6 pt-3 transition-shadow [scrollbar-width:thin] ${
                dragOverLane === expanded ? 'ring-2 ring-inset ring-blue-300' : ''}`}>
              {/* NOT overflow-hidden. This row is nineteen columns wide, and on
                  a tablet in landscape the last few exceed the viewport — with
                  the overflow clipped here they were unreachable rather than
                  scrollable, because a clipped box does not hand its overflow
                  to the scrolling parent. Dropping the clip lets the lane's own
                  overflow-auto scroll sideways to them. Deliberately not a new
                  .overflow-x-auto element: the drag autoscroll picks its rail
                  by exactly that class, and a second one inside the lane would
                  capture it. Nothing changes while the table fits. */}
              <div className="rounded-xl border border-slate-200 bg-white shadow-card">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr>
                      <Th w={56}>#</Th>
                      <Th>Status</Th>
                      <Th k="product_name">Job</Th>
                      <Th k="output_no">Output</Th>
                      <Th k="customer_name">Customer</Th>
                      <Th>Artwork</Th>
                      <Th k="po_number">Customer PO</Th>
                      {/* The PO's own date and the wait it has run up, beside
                          the PO itself. Sortable, which the grey sub-line this
                          replaces never was — and on this board the PO date is
                          the only date most jobs have, so "Deliver By" next
                          door is a dash far more often than not. */}
                      <Th k="po_date">PO Date</Th>
                      <Th k="od" right>OD</Th>
                      <Th k="delivery_date">Deliver By</Th>
                      <Th k="qty_planned" right>Ordered</Th>
                      <Th>Board &amp; Finish</Th>
                      {/* Sits beside the board it describes, not off at the end
                          of the row: "Saffire · 340 GSM · 22x28" and "have we
                          got it" are one thought. */}
                      <Th k="board_state">Board Status</Th>
                      {/* Ink: what has to be hung on the units. Sortable by
                          intent — metallic first, richest build first. */}
                      <Th k="colour_type">Colour</Th>
                      <Th k="print_process">Process</Th>
                      <Th k="colors" right>Colours</Th>
                      <Th>Ready</Th>
                      <Th>Operator</Th>
                      <Th right pin>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g, i, arr) => {
                      const pos = { first: i === 0, last: i === arr.length - 1 };
                      const seq = expSort || expQ || boardFilterActive ? '·' : i + 1;
                      return g.cards.map((c, j) => renderRow(c, g, j === 0, seq, pos));
                    })}
                    {groups.length === 0 && (
                      <tr><td colSpan={19} className="px-4 py-16 text-center text-sm text-slate-400">
                        {laneAll.length > 0 && (expQ || boardFilterActive)
                          ? `${emptyLaneReason(isT ? 'Triage' : press.name, expQ)}.`
                          : 'No jobs in this lane.'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}
      </>)}

      {tab === 'completed' && (() => {
        // Table view of every printed run — a finished job leaves the board and
        // lives here, green, so the kanban stays pure "work to do".
        const pressName = id => presses.find(p => p.id === id)?.name || '—';
        const rows = completed
          .filter(c => completedPress === 'all' || c.machine_id === +completedPress)
          .filter(c => !q || rowMatches(c, q, productSearchText(c)))
          .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
        const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
        const td = 'px-4 py-2.5';
        return (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-1 rounded-xl bg-slate-100/80 p-1 w-fit">
              {[{ id: 'all', name: `All Presses (${completed.length})` },
                ...presses.map(p => ({ id: String(p.id), name: `${p.name} (${completedByPress[p.id]?.length || 0})` }))].map(p => (
                <button key={p.id} onClick={() => setCompletedPress(p.id)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition-all ${
                    completedPress === String(p.id) ? 'bg-white text-emerald-700 shadow-sm ring-1 ring-white' : 'text-slate-500 hover:text-slate-800'}`}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="ci-data-panel">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="ci-table-head">
                    <th className={th}>Job Card</th><th className={th}>Product</th><th className={th}>Customer</th>
                    <th className={th}>Press</th><th className={`${th} text-right`}>Sheets Printed</th>
                    <th className={th}>Operator</th><th className={th}>Completed</th><th className={th}>Set Type</th><th className={th}>Status</th>
                  </tr></thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={9} className="px-4 py-12 text-center text-sm text-slate-400">No printed runs yet.</td></tr>
                    )}
                    {rows.map(c => (
                      <tr key={c.id} onClick={() => setChooser({ card: c, done: true })}
                        className="cursor-pointer border-l-[3px] border-emerald-400 bg-emerald-50/40 transition-colors hover:bg-emerald-50/80">
                        <td className={`${td} font-bold text-slate-900`}>
                          {c.jc_number}
                          {c.gang_number && <div className="text-[10px] font-bold text-violet-500">{c.gang_number}</div>}
                        </td>
                        <td className={td}>
                          <ProductIdentity row={c} compact />
                        </td>
                        <td className={`${td} text-slate-600`}><CustomerDot id={c.customer_id} />{c.customer_name}</td>
                        <td className={`${td} text-xs font-semibold text-slate-600`}>{pressName(c.machine_id)}</td>
                        <td className={`${td} text-right font-semibold tabular-nums text-emerald-700`}>{fmt.num(c.printed_sheets ?? c.sheets_issued)}</td>
                        <td className={`${td} text-xs text-slate-500`}>{c.printing_operator || '—'}</td>
                        <td className={`${td} text-xs tabular-nums text-slate-500`}>{fmt.dt(c.completed_at)}</td>
                        {/* A printed run cannot be on hold, so this column only
                            says whether the sheet was SHARED — which is the
                            run's kind, not the mere presence of a run: a
                            combined run is one product on one plate and shared
                            nothing. cardSetType answers exactly that, and the
                            press-hold branch is dead here by construction. */}
                        <td className={td}><SetTypeChip type={cardSetType(c)} /></td>
                        <td className={td}>
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                            <CheckCircle2 size={11} /> Printed
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {chooser && (() => {
        const c = chooser.card;
        const st = chooser.done ? 'completed' : c.printing_status;
        const pill = st === 'completed' ? 'bg-emerald-500 text-white'
          : st === 'partially_completed' ? 'bg-cyan-500 text-white'
          : st === 'in_progress' ? 'bg-amber-500 text-white'
          : st === 'hold' ? 'bg-red-500 text-white'
          : 'bg-slate-200 text-slate-600';
        const pillLabel = st === 'completed' ? 'Printed' : st === 'partially_completed' ? 'Partially Printed'
          : st === 'in_progress' ? 'Printing Now' : st === 'hold' ? 'On Hold'
          : c.machine_id ? 'Queued on Press' : 'In Triage';
        const printed = chooser.done ? (c.printed_sheets ?? 0) : (c.printed_so_far ?? 0);
        const waste = c.print_waste_so_far ?? 0;
        const expected = plannedChildSheets(c); // Σ per board under a mix
        const remaining = Math.max(0, expected - printed - waste);
        const pct = expected > 0 ? Math.min(100, Math.round((100 * printed) / expected)) : null;
        const press = presses.find(p => p.id === c.machine_id)?.name;
        const Stat = ({ label, value, tone = 'text-slate-900' }) => (
          <div className="rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
            <div className={`text-sm font-extrabold tabular-nums ${tone}`}>{value}</div>
          </div>
        );
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setChooser(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-extrabold text-slate-900">
                <span className="truncate">{c.jc_number}</span>
                {c.gang_number && <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">{c.gang_number}</span>}
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow-sm ${pill}`}>{pillLabel}</span>
              </span>
              <button onClick={() => setChooser(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <div className="truncate text-xs text-slate-500">{c.product_name} · {c.customer_name}</div>
            <div className="mb-3 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
              {c.po_number && <span>PO {c.po_number}{c.po_date ? ` · ${fmt.date(c.po_date)}` : ''}</span>}
              {c.delivery_date && <span>Delivery {fmt.date(c.delivery_date)}</span>}
              {press && <span className="font-semibold text-slate-500">{press}</span>}
              {c.printing_operator && <span className="inline-flex items-center gap-1"><User size={10} /> {c.printing_operator}</span>}
              {c.printing_started_at && <span>started {fmt.dt(c.printing_started_at)}</span>}
              {chooser.done && c.completed_at && <span className="font-semibold text-emerald-600">completed {fmt.dt(c.completed_at)}</span>}
            </div>
            {st === 'hold' && c.hold_reason && (
              <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600">On hold — {c.hold_reason}</div>
            )}
            {/* Printing status in numbers — the full quantity picture. */}
            <div className="mb-3 grid grid-cols-3 gap-1.5">
              <Stat label="Ordered" value={`${fmt.num(c.qty_planned)} pcs`} />
              <Stat label="Parents issued" value={`${fmt.num(c.sheets_issued)} sh`} />
              <Stat label="Print sheets" value={expected > 0 ? `${fmt.num(expected)} sh` : '—'} />
              <Stat label="Printed" value={`${fmt.num(printed)} sh`} tone={st === 'completed' ? 'text-emerald-600' : 'text-cyan-700'} />
              <Stat label="Waste" value={waste > 0 ? `${fmt.num(waste)} sh` : '0'} tone={waste > 0 ? 'text-red-600' : 'text-slate-400'} />
              <Stat label="Remaining" value={st === 'completed' ? '—' : `${fmt.num(remaining)} sh`} tone="text-slate-600" />
            </div>
            {pct != null && printed > 0 && (
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-[11px] font-bold tabular-nums text-slate-500">
                  <span>Progress</span><span>{pct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${st === 'completed' ? 'bg-emerald-500' : st === 'partially_completed' ? 'bg-cyan-500' : 'bg-amber-500'}`}
                    style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {/* Day-wise counter log — every partial count as it was recorded. */}
            {chooserRuns?.runs?.length > 0 && (
              <div className="mb-3 rounded-xl border border-cyan-100 bg-cyan-50/40 p-3">
                <div className="mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-cyan-800">
                  <span>Counter log</span>
                  <span className="tabular-nums">{fmt.num(chooserRuns.rollup?.qty_good || 0)} good · {fmt.num(chooserRuns.rollup?.qty_scrap || 0)} waste</span>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {chooserRuns.runs.map(run => (
                      <tr key={run.id} className="border-t border-cyan-100">
                        <td className="py-1 pr-2 tabular-nums text-slate-500">{fmt.date(run.run_date)}</td>
                        <td className="py-1 pr-2 text-right font-semibold tabular-nums text-emerald-700">{fmt.num(run.qty_good)}</td>
                        <td className="py-1 pr-2 text-right tabular-nums text-red-600">
                          {run.qty_scrap > 0 ? <>{fmt.num(run.qty_scrap)}{run.scrap_reason && <span className="ml-1 text-[10px] text-red-400">({run.scrap_reason})</span>}</> : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="py-1 text-right text-[11px] text-slate-500">{run.operator || '—'}{run.note ? ` · ${run.note}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!chooser.done && c.light && (
              <div className="mb-3 flex items-center gap-1.5">
                <ReadinessPopover light={c.light}>
                  <span className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                    <TrafficLight light={c.light} size="md" /> Readiness — what is still missing
                  </span>
                </ReadinessPopover>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <button onClick={() => openJobCard(chooser.card)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                <FileText size={15} className="text-slate-400" /> View Job Card
              </button>
              {!chooser.done && canPlan() && (
                <button onClick={() => { setEditCard(chooser.card); setChooser(null); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-100">
                  <Pencil size={15} /> Printing Queue — Edit
                </button>
              )}
              {/* Process — land on the exact row at the printing station to
                  record a count or complete the run. */}
              {!chooser.done && (
                <button onClick={() => openAtStation(chooser.card)}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100">
                  <Gauge size={15} /> Process — Record Count / Complete
                </button>
              )}
              {!chooser.done && canPlan() && c.machine_id && (
                <button onClick={() => {
                  const g = groupLane(fullLanes[c.machine_id] || []).find(x => x.cards.some(cc => cc.id === c.id));
                  setChooser(null);
                  if (g) sendGroups(TRIAGE, [g]);
                }}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                  <CornerUpLeft size={15} className="text-slate-400" /> Send back to Triage
                </button>
              )}
              {/* Queued (pending) holds too — parking a job nobody has started
                  is exactly what the Hold zone is for. Only a finished run
                  refuses (the server enforces the same list). */}
              {['pending', 'in_progress', 'partially_completed'].includes(chooser.card.printing_status) && !chooser.done && (
                <button onClick={() => { setHolding(chooser.card); setChooser(null); }}
                  className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-100">
                  <PauseCircle size={15} /> {chooser.card.printing_status === 'pending' ? 'Hold this Job' : 'Hold this Run'}
                </button>
              )}
              {chooser.card.printing_status === 'hold' && (
                // The server resumes by evidence (runs → partial, start stamp →
                // running, else back to queued) — the label reads the same
                // evidence so the button never promises a press restart the
                // resume won't perform.
                <button onClick={() => resumeRun(chooser.card)}
                  className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-100">
                  <Play size={15} /> {chooser.card.printing_started_at || chooser.card.printed_so_far > 0 ? 'Resume Printing' : 'Release Hold'}
                </button>
              )}
              {chooser.done && canPlan() && (
                <button onClick={() => reverseRun(chooser.card)}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 hover:bg-amber-100">
                  <RotateCcw size={15} /> Reverse to Triage
                </button>
              )}
            </div>
          </div>
        </div>
        );
      })()}

      {/* Hold — reason required; the card and the station queue both turn red. */}
      {holding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setHolding(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-white/70 bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                <PauseCircle size={16} className="text-red-500" /> Hold {holding.jc_number}
              </span>
              <button onClick={() => setHolding(null)} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
            </div>
            <p className="mb-3 text-xs text-slate-500">
              The run pauses on {holding.product_name}. It turns red here and on the printing queue until resumed.
            </p>
            <Field label="Hold reason" required>
              <Select value={holdReason} onChange={e => setHoldReason(e.target.value)}>
                {HOLD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setHolding(null)}>Cancel</Button>
              <Button variant="danger" onClick={holdRun}><PauseCircle size={13} /> Put on Hold</Button>
            </div>
          </div>
        </div>
      )}

      {editCard && (
        <EditQueueForm card={editCard} presses={presses} lanes={fullLanes}
          onClose={() => setEditCard(null)}
          onSaved={() => { setEditCard(null); load(); }}
          onClash={(collision, confirm) => setClashPrompt({ collision, confirm })} />
      )}

      {clashPrompt && (
        <StrengthClashModal
          collision={clashPrompt.collision}
          onCancel={() => { setClashPrompt(null); load(); }}
          onConfirm={async () => {
            try { await clashPrompt.confirm(); } catch { /* central toast */ }
            setClashPrompt(null); setEditCard(null); load();
          }} />
      )}

      {/* Undo bar — every move leaves a ten-second window to take it back. */}
      {undo && (
        <div className="fixed bottom-5 left-1/2 z-[70] -translate-x-1/2">
          <div className="flex animate-slideUp items-center gap-3 rounded-full border border-slate-700 bg-slate-900/95 py-2 pl-4 pr-2 text-sm font-semibold text-white shadow-2xl backdrop-blur">
            <span className="tabular-nums">{undo.msg}</span>
            <button onClick={runUndo}
              className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[13px] font-extrabold text-slate-900 transition-colors hover:bg-blue-50 hover:text-blue-700">
              <Undo2 size={13} /> Undo
            </button>
            <button onClick={() => setUndo(null)} className="rounded-full p-1 text-slate-400 hover:text-white"><X size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

// Soft strength mix-up alarm — same brand, different strength somewhere in the
// plan. Never blocks: "Plan Anyway" proceeds (and is audited), "Cancel" reverts.
function StrengthClashModal({ collision, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-amber-100 p-2 text-amber-600"><AlertTriangle size={22} /></div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">Strength mix-up check</h3>
            <p className="text-sm text-slate-500">Same brand, different strength is already in the plan.</p>
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You're planning <b>{collision.this.product_name}</b>
          {collision.this.strength && <> (strength <b>{collision.this.strength}</b>)</>}.
          <div className="mt-2 space-y-1">
            {collision.others.map((o, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                <span>Already planned:</span>
                <b>{o.product_name}</b>
                {o.strength && <span className="rounded bg-amber-200/70 px-1.5 font-semibold">{o.strength}</span>}
                <span className="text-amber-700">
                  · {o.location}{o.planned_date ? ` · ${fmt.date(o.planned_date)}` : ''}{o.jc_number ? ` · ${o.jc_number}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">Different strengths of the same product can get swapped. Sure you want to plan this one too?</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>Plan Anyway</Button>
        </div>
      </div>
    </div>
  );
}
