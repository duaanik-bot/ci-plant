// Status Sheet — the live, editable coordination view of every PENDING order-line
// still owed to a customer. One row per order × product. Read-only supply figures
// (order qty / supplied / pending) sit beside editable coordination fields:
//   • Stages       — tiny live chips of the line's real production route
//   • Print Status — READ-ONLY, synced live from the printing stage itself
//                    (not started / queued / running / partial / hold / done)
//   • EDD          — this PRODUCT's delivery date, edited inline. A LINE-level
//                    override of the PO's own date (79% of these lines share a PO
//                    with other products), imported from the customer's WIP list
//   • WIP          — the CUSTOMER's urgency, a TRI-STATE (WIP / Non-WIP / not on
//                    their list) with the date it was said, settable by hand, in
//                    bulk, or by uploading the customer's own WIP list
//   • Remarks      — the planner's own note against the line, edited inline
//   • P1           — a manual, PER-PRODUCT priority flag
//
// SCOPE: every line still owed to a customer, PLUS every line carrying a WIP
// record even after it completes or dispatches (see server/src/wip-scope.js).
// A customer chases a product until they receive it, so an imported list stays
// cumulative instead of losing rows the week we finish them. The Status chips
// are how the finished ones are filtered back out of view.
//
// Edits post to /status-sheet/* and update optimistically; realtime/fallback refresh reconciles.
import { useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { dayOf } from '../lib/dayOf.js';
import { buildWipExportSpec, EXPORT_EXCLUDED_KEYS } from '../lib/wipExport.js';
import { lineStageOf, lineStageRail, LINE_STAGE_LABEL, PRE_STAGE_KEYS } from '../lib/lineStage.js';
import { Button, ConfirmDialog, DataTable, Input, KpiCard, KpiFilterNotice, Modal, odDays, odExport, OverdueDays, PageHeader, ResetFilters, rowMatches, SelectionDock, useFilterReset, useKpiFilter, useToast } from '../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../components/FilterChip.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { ClipboardList, AlertTriangle, Star, Hammer, FileUp, Loader2, Zap, ZapOff, X, Eraser, CalendarDays, CalendarCheck } from 'lucide-react';
import { GangChip, GangCellParts } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { SECTION_META, SECTION_ORDER } from '../sections.js';
import { DRIP_OFF_PLATE_SIZE, dripPlateStateLabel, hasDripOffCoating } from '../lib/plateInks.js';

const STATUS_KPI_ROWS = {
  overdue: r => +r.overdue_days > 0,
  p1: r => !!r.is_p1,
  wip: r => r.wip === true,
};
const STATUS_KPI_LABEL = {
  overdue: 'lines past their delivery date',
  p1: 'lines on a P1 product',
  // Says LINES, and says the scope, because Planning's card counts the same
  // customer list a different way and the two numbers have to be readable side
  // by side — see the KPI card below.
  wip: 'lines the customer marked WIP — including ones already produced or dispatched',
};

// The three states a line can be at, in the order the plant moves through them.
// `line_status` is derived server-side (wip-scope.js) as a cascade, so exactly
// one of these is true for any line and a chip can never double-count a row.
// Lit tones echo the row's own badge below (STATUS_PILL), so the chip a planner
// clicks and the pill they read on the row cannot disagree. Pending carries no
// tone and lights graphite — it is the ordinary state of the book, not a thing
// to act on.
const LINE_STATUSES = [
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  { key: 'dispatched', label: 'Dispatched', tone: 'border-blue-200 bg-blue-50 text-blue-700' },
];
const STATUS_LABEL = Object.fromEntries(LINE_STATUSES.map(s => [s.key, s.label]));
const STATUS_PILL = {
  pending: 'bg-slate-100 text-slate-600',
  completed: 'bg-emerald-50 text-emerald-700',
  dispatched: 'bg-blue-50 text-blue-700',
};

// WIP is a TRI-STATE and the select has to say so. '' is the DOM's only honest
// spelling of "no value" — mapped to null on the way out, because null and
// false mean different things here and a coerced false would tell the plant the
// customer said something they never said.
const WIP_OPTIONS = [
  { value: '', label: 'Not on list' },
  { value: 'yes', label: 'WIP' },
  { value: 'no', label: 'Non-WIP' },
];
const wipValue = w => (w === true ? 'yes' : w === false ? 'no' : '');
const wipFromValue = v => (v === 'yes' ? true : v === 'no' ? false : null);

// Every row a display row stands for, as real order lines. A collapsed gang row
// is ONE row on screen and several lines in the database — every bulk action,
// every count and every export decision has to go through this, or a planner
// ticking one gang would silently write to a single member of it.
const linesOf = r => r._gang || [r];

// Every caller below writes this into order_lines.wip_date. dayOf, never
// toISOString(): before 05:30 IST that reads yesterday, so a line marked on the
// night shift recorded the wrong day it was marked.
const todayISO = () => dayOf(new Date());

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

// This sheet keys rows on `line_id`, but a collapsed gang row carries a
// synthetic `gang-<run>` in that field and stands for several order lines at
// once — there is no single record to discuss, so it gets no doorbell rather
// than a thread hung on a fake id.
const threadLineId = r => (r._gang ? null : r.line_id);

// The PO a row answers for, and how long the customer has been waiting. Same
// rule as Planning, Artwork, the Job Card register and Print Planning: a gang
// answers for its OLDEST member, and `latest` is set only when the members were
// booked on different days, so the cell shows a span exactly when there is one.
//
// NOTE the two different senses of "late" on this screen. The Overdue KPI above
// the table counts lines past their DELIVERY date; OD here is days since the
// customer raised the PO, which is the figure every other planning screen shows
// under that name and the only clock most lines have — delivery_date is null on
// the great majority of the open book. The chip's own tooltip says which it is.
const poAgeOf = r => {
  const ds = [...new Set((r._gang || [r]).map(m => m.po_date).filter(Boolean))].sort();
  return { date: ds[0] ?? null, latest: ds.length > 1 ? ds[ds.length - 1] : null, days: odDays(ds[0]), count: ds.length };
};

// Ultra-short stage tags — the whole route has to fit in one narrow cell.
const STAGE_SHORT = {
  cutting: 'Cut', printing: 'Prt', coating: 'Coat', lamination: 'Lam',
  foiling: 'Foil', embossing: 'Emb', die_cutting: 'Die', sorting: 'Srt',
  pasting: 'Pst', qc: 'QC',
};

// ── Where it is ───────────────────────────────────────────────────────────────
// The plant word for a `lineStageOf` key. Stages are named by SECTION_META and
// nothing else, so this screen, the floor nav and the job card cannot end up
// with three names for one station; the four non-stage keys come from the lib
// that defines them. Falls back to the raw key so a stage invented tomorrow
// shows up readable rather than blank.
const stageKeyLabel = key =>
  LINE_STAGE_LABEL[key] || SECTION_META[key]?.label || String(key || '').replace(/_/g, ' ');

// Where ONE line is, as a word. `lineStageOf` is the single spelling behind the
// chip, this cell and the exported column — see lib/lineStage.js.
const whereItIs = m => stageKeyLabel(lineStageOf(m).key);

// How far down its route a line is. Only meaningful once a job card exists:
// before that there is no route, and "0/0" would read as a job that has stalled
// rather than one that has not started.
const stageProgress = m => { const { done, total } = lineStageOf(m); return total ? `${done}/${total}` : '—'; };

// Unplanned / Planned / In production, as its own word for the export. The
// chips answer this on screen; a workbook has no chips, so it gets a column it
// can be filtered on in Excel.
const PLANNING_STATUS = {
  pending: 'Unplanned', planned: 'Planned', ready: 'Planned',
  in_production: 'In production', produced: 'Produced', dispatched: 'Dispatched',
};
const planningStatus = m => PLANNING_STATUS[m.status] || m.status || '—';

// Emerald is this page's existing word for "finished" (STATUS_PILL.completed and
// the completed-stage ticks below both use it), so the chip that means finished
// wears it too. Every other chip on the rail is CLASSIFICATION — where a job
// happens to be standing is not something the plant must act on — so they light
// graphite, which is FilterChip's default. See ci-erp-filter-chip-system: colour
// is spent on severity, never on identity.
const STAGE_CHIP_TONE = { done: 'border-emerald-200 bg-emerald-50 text-emerald-700' };

const selCls =
  'h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 ' +
  'focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100';

export default function StatusSheet() {
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState('');
  const [threads, setThreads] = useState({});

  // Surface a load failure instead of swallowing it — a dead/unreachable backend
  // must NOT read as "no pending orders". A network reject fires no central toast
  // (unlike a 500), so this page owns showing the outage. Last-good rows are kept
  // on a transient blip; the fallback poll clears the flag on the next success.
  const load = () => api.get('/status-sheet')
    .then(d => {
      const lines = d.lines || [];
      setRows(lines); setLoadError(false);
      threadSummary('order_line', lines.map(l => l.line_id)).then(setThreads).catch(() => {});
    })
    .catch(() => setLoadError(true));
  useFallbackRefresh(load, { intervalMs: 60000 });
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

  // Optimistic line edit (Printed override / WIP / Remarks / P1) — patch one
  // line, reconcile on error.
  const patchLine = (line, body) => {
    setRows(rs => rs.map(r => (r.line_id === line.line_id ? { ...r, ...body } : r)));
    api.patch(`/status-sheet/line/${line.line_id}`, body).catch(load);
  };
  // Remarks is free text, so it saves on BLUR rather than per keystroke — a
  // PATCH per character would race its own responses and lose the tail of a
  // sentence. The typed value lives in local state until then, keyed by line,
  // so a background refresh cannot yank the caret out of a half-typed note.
  const [remarkDraft, setRemarkDraft] = useState({});
  const commitRemark = m => {
    const draft = remarkDraft[m.line_id];
    if (draft === undefined) return;
    setRemarkDraft(d => { const n = { ...d }; delete n[m.line_id]; return n; });
    if ((draft || '') === (m.remarks || '')) return;
    patchLine(m, { remarks: draft.trim() || null });
  };
  // EDD is a line-level OVERRIDE, so what is SENT and what is SHOWN differ and
  // cannot go through patchLine's plain merge. The request carries the override
  // alone; the row shows the resolved date, which falls back to the PO's the
  // moment the override is cleared. Merging the resolved value into the request
  // would write the PO's own date back as this line's override — the line would
  // look unchanged and then stop following the order forever after.
  // Apply one date to the WHOLE PO — the counterpart to the per-product
  // override. Writes the order's own date and drops every line override on it,
  // so the PO ends with one date that every line follows and every OTHER screen
  // (Planning, Dispatch, the Job Card register all read orders.delivery_date)
  // agrees with. Confirmed first: on this book a PO can carry 26 products.
  const [poEdd, setPoEdd] = useState(null);   // { line, count }
  const applyEddToPo = async ({ line }) => {
    const date = line.delivery_date ? String(line.delivery_date).slice(0, 10) : null;
    setRows(rs => rs.map(r => (r.order_id === line.order_id
      ? { ...r, delivery_date: date, line_delivery_date: null, order_delivery_date: date }
      : r)));
    try {
      const res = await api.patch(`/status-sheet/order/${line.order_id}`, { delivery_date: date });
      toast.success(`PO ${line.po_number} — every product now due ${fmt.date(date)}`
        + (res.overrides_cleared ? ` · ${res.overrides_cleared} per-product date${res.overrides_cleared === 1 ? '' : 's'} replaced` : ''));
      load();
    } catch (e) { toast.error(e.message || 'Could not set the PO’s delivery date'); load(); }
  };

  const setEddOverride = (line, value) => {
    setRows(rs => rs.map(r => (r.line_id === line.line_id
      ? { ...r, line_delivery_date: value, delivery_date: value ?? r.order_delivery_date ?? null }
      : r)));
    api.patch(`/status-sheet/line/${line.line_id}`, { delivery_date: value }).catch(load);
  };

  // ── Customer WIP import — parse → review → confirm ────────────────────────
  const toast = useToast();
  const fileRef = useRef(null);
  const [wipOpen, setWipOpen] = useState(false);
  const [wipBusy, setWipBusy] = useState(false);
  const [wipRes, setWipRes] = useState(null);          // /wip-match response
  const [wipSel, setWipSel] = useState(() => new Set()); // checked line ids
  const [wipDates, setWipDates] = useState({});          // line_id → date
  const [wipEdds, setWipEdds] = useState({});            // line_id → EDD from the file
  const closeWip = () => { setWipOpen(false); setWipRes(null); setWipSel(new Set()); setWipDates({}); setWipEdds({}); };
  const handleWipFile = async file => {
    if (!file) return;
    setWipBusy(true);
    try {
      if (!/\.(xlsx|xls|csv|pdf|txt)$/i.test(file.name)) {
        toast.error('Upload the customer’s WIP list as Excel (.xlsx), CSV or a text PDF');
        return;
      }
      // One funnel for every format: the server reads the file (by magic
      // bytes, not extension) and hands back plain row texts. exceljs cannot
      // read in the browser — its load() hangs under the browser bundle — so
      // spreadsheets go up as files exactly like PDFs, inside the 4 MB cap.
      const parsed = await api.upload('/status-sheet/wip-parse', file);
      // `grid` carries the sheet's CELLS, not just the joined row text, so the
      // server can find the EDD by its column heading instead of guessing which
      // of two dates on a row is the delivery date.
      const res = await api.post('/status-sheet/wip-match', { rows: parsed.rows, grid: parsed.grid });
      setWipRes(res);
      // Confident matches arrive ticked ("Yes to All" is then one click);
      // fuzzy suggestions arrive unticked for the planner's eye. Lines already
      // WIP arrive unticked too — nothing to do for them.
      const sel = new Set();
      const dates = {};
      const edds = {};
      for (const it of res.items) {
        for (const l of it.lines) {
          // The file's EDD for this row, offered per line and editable. Left
          // blank when the sheet named none — an absent EDD must leave the
          // order's existing date alone rather than blanking it.
          if (it.edd) edds[l.line_id] = it.edd;
          dates[l.line_id] = it.date || todayISO();
          if (it.status === 'matched' && !l.already_wip) sel.add(l.line_id);
        }
      }
      setWipSel(sel); setWipDates(dates); setWipEdds(edds);
    } catch (e) {
      toast.error(e.message || 'Could not read that file');
    } finally { setWipBusy(false); }
  };
  const applyWip = async () => {
    setWipBusy(true);
    try {
      const items = [...wipSel].map(id => ({
        line_id: id,
        wip_date: wipDates[id] || todayISO(),
        // Only send an EDD the file actually gave (or the planner typed) —
        // an empty one must leave the order's existing delivery date alone.
        edd: wipEdds[id] || null,
      }));
      const res = await api.post('/status-sheet/wip-apply', { items });
      const eddN = res.edd_applied || 0;
      toast.success(`${res.applied.length} line${res.applied.length === 1 ? '' : 's'} marked Customer WIP`
        + (eddN ? ` · EDD set on ${eddN} line${eddN === 1 ? '' : 's'}` : ''));
      closeWip(); load();
    } catch (e) { toast.error(e.message || 'Could not mark the lines'); }
    finally { setWipBusy(false); }
  };

  const kpis = useMemo(() => ({
    lines: rows.length,
    pendingQty: rows.reduce((s, r) => s + (r.pending_qty || 0), 0),
    overdue: rows.filter(r => r.overdue_days > 0).length,
    p1: rows.filter(r => r.is_p1).length,
    wip: rows.filter(r => r.wip === true).length,
  }), [rows]);

  // ── Chip filters — status and customer, both multi-select ─────────────────
  // Empty means "everything", not "nothing": a filter that starts by hiding the
  // whole sheet reads as a page that failed to load. Both narrow the same
  // searched set the KPI cards count, so every figure on screen agrees.
  const [statusKeys, setStatusKeys] = useState([]);
  const [custKeys, setCustKeys] = useState([]);
  // WHERE the line is on the floor — Unplanned · Planned · Queued · the stage it
  // is standing on · Done. A separate question from the commercial status beside
  // it: "Pending" says the customer has not been supplied, this says what the
  // plant is doing about it.
  const [stageKeys, setStageKeys] = useState([]);
  const toggleIn = (set, key) => set(cur => (cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]));

  const statusCounts = useMemo(() => {
    const c = { pending: 0, completed: 0, dispatched: 0 };
    for (const r of rows) if (c[r.line_status] != null) c[r.line_status]++;
    return c;
  }, [rows]);
  // Counted over LINES, like every other count on this page, and over the whole
  // sheet rather than the filtered view — a chip has to say how much it would
  // bring back, not how much of it survives the filters already lit.
  const stageChips = useMemo(() => lineStageRail(rows, SECTION_ORDER), [rows]);
  // Customers present on the sheet, most lines first so the busiest chip is
  // reachable without reading an alphabet, then alphabetical for a stable rail.
  const customers = useMemo(() => {
    const c = new Map();
    for (const r of rows) if (r.customer_name) c.set(r.customer_name, (c.get(r.customer_name) || 0) + 1);
    return [...c.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => ({ name, n }));
  }, [rows]);

  // How many products each PO carries ON THIS SHEET. Counted over every row,
  // never the filtered view: "apply to the whole PO" reaches all of them, so a
  // count taken after a customer chip or a search would understate what the
  // button is about to change.
  const poSize = useMemo(() => {
    const c = {};
    for (const r of rows) c[r.order_id] = (c[r.order_id] || 0) + 1;
    return c;
  }, [rows]);

  const kpi = useKpiFilter('status-sheet');
  // wipSel is deliberately absent: those are the lines the user has ticked to
  // mark WIP, a checklist they are building to submit, not a way of narrowing
  // the sheet. Clearing it here would throw away their work.
  // Every filter on this page, so "Reset filters" means the whole page and not
  // whichever ones were wired first — the two chip rails narrow the sheet just
  // as hard as the search box, and a reset that left them lit would be the bug
  // this mechanism exists to prevent. Clearing the view also drops the row
  // selection: those ticks name rows, and rows the planner can no longer see
  // must not stay armed under a bulk button.
  const filters = useFilterReset([
    [q, setQ, '', 'search'],
    [kpi.keys, kpi.clear, [], 'KPI card'],
    [statusKeys, setStatusKeys, [], 'status'],
    [stageKeys, setStageKeys, [], 'stage'],
    [custKeys, setCustKeys, [], 'customer'],
  ], () => setSelIds([]));
  const searched = useMemo(() => (q
    ? rows.filter(r => rowMatches(r, q, (r._gang || [r]).map(productSearchText).join(' ')))
    : rows), [rows, q]);
  // Applied to LINES, before gangs collapse, because the cards count lines too.
  const chipped = useMemo(() => searched.filter(r =>
    (!statusKeys.length || statusKeys.includes(r.line_status))
    && (!stageKeys.length || stageKeys.includes(lineStageOf(r).key))
    && (!custKeys.length || custKeys.includes(r.customer_name))), [searched, statusKeys, stageKeys, custKeys]);
  const filtered = kpi.apply(chipped, STATUS_KPI_ROWS);
  // A gang is ONE physical unit until die cutting — so it reads as ONE row here
  // too. Collapse every pending member line sharing a gang_run_id into a single
  // synthetic row carrying `_gang` (members in view order); everything else is a
  // plain line. Mirrors Planning / Artwork so a gang looks identical everywhere.
  const displayRows = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const r of filtered) {
      if (!r.gang_run_id) { out.push(r); continue; }
      if (seen.has(r.gang_run_id)) continue;
      seen.add(r.gang_run_id);
      const members = filtered.filter(x => x.gang_run_id === r.gang_run_id);
      out.push(members.length > 1 ? { ...r, line_id: `gang-${r.gang_run_id}`, _gang: members } : r);
    }
    return out;
  }, [filtered]);

  // ── Selection and bulk WIP ────────────────────────────────────────────────
  // Selection is held as DISPLAY row ids (a gang's synthetic `gang-<run>`
  // included) because that is what the checkbox column ticks. It is expanded to
  // real order-line ids only at the moment of writing — a gang row stands for
  // several lines, and marking one member of a run the customer is chasing
  // would be a silent half-answer.
  const [selIds, setSelIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Narrowing the view must not leave an invisible selection armed: a planner
  // who filters to one customer and hits "Mark as WIP" is talking about what is
  // in front of them. Ids that fell out of view are dropped from the count and
  // from the write.
  const selectedRows = useMemo(() => {
    const want = new Set(selIds.map(String));
    return displayRows.filter(r => want.has(String(r.line_id)));
  }, [displayRows, selIds]);
  const selectedLines = useMemo(() => selectedRows.flatMap(linesOf), [selectedRows]);

  const clearSel = () => setSelIds([]);

  // ── Start the WIP list over ───────────────────────────────────────────────
  // Importing a customer's list ADDS to what is already there, which is the
  // point — but it means there has to be a way back to a blank sheet, or a
  // wrong list can only be undone one row at a time.
  //
  // Scoped to WHAT IS IN VIEW, not the whole book. The flow this exists for is
  // "pick the party, wipe their list, import the new one", so a customer chip
  // must narrow it; clearing every other customer's WIP because one was being
  // re-done would be the worst possible reading of this button. `filtered` is
  // the line-level set after search, chips and KPI cards, before gangs collapse.
  const [clearOpen, setClearOpen] = useState(false);
  const clearable = useMemo(() => filtered.filter(r => r.wip != null), [filtered]);
  // Named so the confirm can say WHOSE list is about to go.
  const clearScope = useMemo(() => {
    const names = [...new Set(clearable.map(r => r.customer_name).filter(Boolean))];
    return names.length === 1 ? names[0] : `${names.length} customers`;
  }, [clearable]);
  const clearAllWip = async () => {
    const line_ids = clearable.map(r => r.line_id);
    if (!line_ids.length) return;
    setBulkBusy(true);
    setRows(rs => rs.map(r => (line_ids.includes(r.line_id) ? { ...r, wip: null, wip_date: null } : r)));
    try {
      const res = await api.post('/status-sheet/lines/bulk', { wip: null, line_ids });
      toast.success(`WIP list cleared — ${res.applied.length} line${res.applied.length === 1 ? '' : 's'} taken off`);
      clearSel(); load();
    } catch (e) {
      toast.error(e.message || 'Could not clear the WIP list');
      load();
    } finally { setBulkBusy(false); }
  };
  const applyBulk = async (wip, verb) => {
    const line_ids = [...new Set(selectedLines.map(l => l.line_id))];
    if (!line_ids.length) return;
    setBulkBusy(true);
    // Optimistic, exactly like the single-line edit beside it — the sheet
    // repaints at once and `load()` reconciles if the server disagrees.
    const stamp = wip == null ? null : todayISO();
    setRows(rs => rs.map(r => (line_ids.includes(r.line_id)
      ? { ...r, wip, wip_date: wip == null ? null : (r.wip_date || stamp) } : r)));
    try {
      const res = await api.post('/status-sheet/lines/bulk', { wip, line_ids });
      const n = res.applied.length;
      toast.success(`${n} line${n === 1 ? '' : 's'} ${verb}`);
      clearSel();
      load();
    } catch (e) {
      toast.error(e.message || 'Could not update those lines');
      load();
    } finally { setBulkBusy(false); }
  };

  // Cell renderers pulled out so a gang row can reuse them PER MEMBER inside
  // GangCellParts, while a plain line renders them once. Editable controls always
  // act on the member line (`m`), so a gang's cartons stay individually editable.
  // Print Status — READ-ONLY, the printing stage's own live state. The old
  // Auto/Yes/No override select is gone at Anik's ask: the press already says
  // where the job is, and a hand-typed "Yes" over a stage that never ran was
  // the sheet lying to the customer. Richer than the old boolean, too — refresh
  // keeps it current without anyone touching it.
  const printState = m => {
    const ps = (m.stages || []).find(s => s.stage === 'printing');
    if (!ps) return ['Not started', 'bg-slate-100 text-slate-500', false];
    switch (ps.status) {
      case 'completed': return ['Done', 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200', false];
      case 'in_progress': return ['Running', 'bg-amber-50 text-amber-700 ring-1 ring-amber-200', true];
      case 'partially_completed': return ['Partial', 'bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200', true];
      case 'hold': return ['On hold', 'bg-red-50 text-red-600 ring-1 ring-red-200', false];
      default: return ['Queued', 'bg-slate-100 text-slate-500', false];
    }
  };
  const PrintedCell = m => {
    const [label, cls, live] = printState(m);
    return (
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}
        title="Synced live from the printing stage — read-only">
        {live && <span className="h-1.5 w-1.5 animate-pulseSoft rounded-full bg-current" />}
        {label}
      </span>
    );
  };
  // EDD — this PRODUCT's delivery date, edited against the ORDER LINE.
  //
  // It used to write the order, which moved every product on that PO at once.
  // 79% of the lines here share a PO with other products (one carries 26) and
  // the customer's list names a date per item, so the order-level column could
  // never hold what they send. A line's own date OVERRIDES the PO's; clearing
  // the box removes the override and the line goes back to following the order,
  // which is why an empty input is "follow the PO" and not "no date".
  const EddCell = m => {
    const own = !!m.line_delivery_date;
    const siblings = poSize[m.order_id] || 1;
    return (
      <div className="flex flex-col gap-1">
        <input type="date" value={m.delivery_date ? String(m.delivery_date).slice(0, 10) : ''}
          onChange={e => setEddOverride(m, e.target.value || null)}
          className={`${selCls} ${m.overdue_days > 0 ? 'border-red-300 bg-red-50 text-red-700'
            : own ? 'border-blue-200 bg-blue-50/40' : ''}`}
          title={[
            m.overdue_days > 0 ? `${m.overdue_days} day(s) overdue` : '',
            own ? 'This product’s own EDD' : (m.delivery_date ? `Following PO ${m.po_number}` : 'No delivery date yet'),
          ].filter(Boolean).join(' · ')} />
        {/* Offered only where it would actually do something: a PO with one
            product on the sheet is already "the whole PO", and a row with no
            date has nothing to apply. */}
        {siblings > 1 && m.delivery_date && (
          <button type="button" onClick={() => setPoEdd({ line: m, count: siblings })}
            title={`Give all ${siblings} products on PO ${m.po_number} this delivery date`}
            className="inline-flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[10px] font-bold text-slate-400 hover:bg-slate-100 hover:text-brand-600">
            <CalendarCheck size={11} /> Apply to PO ({siblings})
          </button>
        )}
      </div>
    );
  };
  // WIP — the customer's urgency, always hand-editable, and a TRI-STATE:
  //   WIP         they are waiting on it
  //   Non-WIP     they have told us it is NOT in progress — a deliberate
  //               negative, which is why it is not the same as blank
  //   Not on list no record at all; this is what "Remove from WIP" writes
  // Choosing either record stamps today unless a date is already there (the
  // upload flow writes the customer's own date). The date stays editable while
  // a record exists and leaves with it — a date with no record is a stale claim.
  const WipCell = m => (
    <div className="flex flex-col gap-1">
      <select className={`${selCls} ${
        m.wip === true ? 'border-blue-300 bg-blue-50 text-blue-700'
          : m.wip === false ? 'border-slate-300 bg-slate-100 text-slate-500' : ''}`}
        value={wipValue(m.wip)}
        onChange={e => {
          const next = wipFromValue(e.target.value);
          patchLine(m, { wip: next, wip_date: next == null ? null : (m.wip_date || todayISO()) });
        }}>
        {WIP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {m.wip != null && (
        <input type="date" value={m.wip_date ? String(m.wip_date).slice(0, 10) : ''}
          onChange={e => patchLine(m, { wip: m.wip, wip_date: e.target.value || todayISO() })}
          className={`h-7 rounded-md border px-1.5 text-[11px] font-medium focus:outline-none ${
            m.wip ? 'border-blue-200 bg-blue-50/60 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
          title={m.wip ? "When the customer's list marked it WIP" : 'When the customer said it is not in progress'} />
      )}
    </div>
  );
  // Remarks — the planner's own note. Saved on blur, not per keystroke (see
  // commitRemark): a PATCH per character races its own responses and loses the
  // end of a sentence.
  const RemarksCell = m => (
    <Input value={remarkDraft[m.line_id] ?? m.remarks ?? ''}
      onChange={e => setRemarkDraft(d => ({ ...d, [m.line_id]: e.target.value }))}
      onBlur={() => commitRemark(m)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      placeholder="—"
      className="h-8 min-w-[8rem] text-xs"
      title="A note against this line — carried into the export" />
  );
  const StatusCell = m => (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
      STATUS_PILL[m.line_status] || STATUS_PILL.pending}`}>
      {STATUS_LABEL[m.line_status] || m.line_status}
    </span>
  );
  const P1Cell = m => (
    <button onClick={() => patchLine(m, { is_p1: m.is_p1 ? 0 : 1 })}
      title={m.is_p1 ? 'Priority (this product only) — click to clear' : 'Mark this product P1 (priority)'}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition
        ${m.is_p1 ? 'bg-amber-100 text-amber-700' : 'text-slate-400 hover:bg-slate-100'}`}>
      <Star size={13} className={m.is_p1 ? 'fill-amber-400 text-amber-500' : ''} />
      P1
    </button>
  );
  // The line's real production route as tiny chips — every stage it will pass
  // through, highlighted up to where it actually is: green = completed, amber =
  // running / partially done, muted = still waiting. The route is the job's own
  // job_stages rows (dynamic per product), not the fixed 10-stage list.
  const StagesCell = m => {
    const st = m.stages || [];
    // No route yet — but WHICH no-route this is matters, so it says so rather
    // than one flat "not started" over both. Same words as the chips.
    if (!st.length) return (
      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{whereItIs(m)}</span>
    );
    const done = st.filter(s => s.status === 'completed').length;
    const runningAt = st.findIndex(s => s.status === 'in_progress' || s.status === 'partially_completed');
    // Where the eye should land — taken from lineStageOf, NOT recomputed here.
    // This cell and the chip rail used to be free to disagree about a route that
    // completes out of sequence; now there is one answer and both read it.
    const here = lineStageOf(m).key;
    const finished = done === st.length;
    return (
      // ONE line, always. This used to be a wrapping cloud of chips with no
      // minimum width, so the wide table squeezed the column to ~40px and every
      // chip dropped onto its own row — a ten-stage route made one line eight
      // times taller than its neighbours. A route is a progression, so it reads
      // as one: a tick per stage, then the stage it is standing on. Height is
      // fixed at a single line no matter how long the route is, and the full
      // route stays one hover away.
      <div className="flex items-center gap-1.5 whitespace-nowrap"
        title={st.map(s => `${SECTION_META[s.stage]?.label || s.stage} — ${String(s.status).replace(/_/g, ' ')}${s.gang_shared ? ' · gang run' : ''}`).join('\n')}>
        <span className="flex shrink-0 items-center gap-[2px]">
          {st.map((s, i) => {
            const d = s.status === 'completed';
            const a = s.status === 'in_progress' || s.status === 'partially_completed';
            return (
              <span key={i} aria-hidden
                className={`h-3 w-[5px] rounded-[2px] ${
                  d ? 'bg-emerald-500' : a ? 'bg-amber-500 shadow-[0_0_0_1px_rgba(255,149,0,.35)]' : 'bg-slate-300'}`} />
            );
          })}
        </span>
        <span className={`text-[10px] font-bold uppercase tracking-wide ${
          finished ? 'text-emerald-600' : runningAt >= 0 ? 'text-amber-700' : 'text-slate-500'}`}>
          {finished ? 'done' : (STAGE_SHORT[here] || stageKeyLabel(here))}
        </span>
        <span className="text-[10px] font-semibold tabular-nums text-slate-400">{done}/{st.length}</span>
      </div>
    );
  };
  // The route, spelled out, for the on-screen tooltip only. The EXPORT used to
  // carry this — "Cut✓ Prt… Die" — and it was the wrong answer to the question
  // being asked of it: whoever opens the workbook wants to know where the job
  // is, not to decode a sequence and work it out. The exported column is
  // `whereItIs` now, and this stays as the hover detail on the sheet.
  const stageText = m => {
    const st = m.stages || [];
    if (!st.length) return whereItIs(m);
    return st.map(s => `${STAGE_SHORT[s.stage] || s.stage}${
      s.status === 'completed' ? '✓'
        : (s.status === 'in_progress' || s.status === 'partially_completed') ? '…' : ''}`).join(' ');
  };

  const sum = (g, k) => g.reduce((s, m) => s + (Number(m[k]) || 0), 0);
  const perMember = (r, f, sep = ' · ') => (r._gang ? r._gang.map(f).join(sep) : f(r));

  // The DRIP OFF plate a drip-coated line answers for. Structure carries the
  // identity, colour the severity: a required mask with NO paperwork is the
  // red — it is the one state somebody has to act on before coating can run.
  // Non-drip cartons stay a dash, so the column reads as a drip register.
  const dripPlateText = m => {
    if (m.dripoff_plate) {
      return `${m.dripoff_plate.plate_size || DRIP_OFF_PLATE_SIZE} · ${dripPlateStateLabel(m.dripoff_plate.status)}`;
    }
    return hasDripOffCoating(m) ? 'Required — not raised' : '—';
  };
  const DRIP_TONE = {
    'Issued to coating': 'bg-violet-50 text-violet-700',
    Consumed: 'bg-slate-100 text-slate-500',
    'Ready on rack': 'bg-emerald-50 text-emerald-700',
    'On order': 'bg-cyan-50 text-cyan-700',
    'Verify rack plate': 'bg-amber-50 text-amber-700',
    'To buy': 'bg-orange-50 text-orange-700',
  };
  const DripPlateCell = m => {
    if (!m.dripoff_plate && !hasDripOffCoating(m)) return <span className="text-slate-300">—</span>;
    const state = m.dripoff_plate ? dripPlateStateLabel(m.dripoff_plate.status) : null;
    const tone = state ? (DRIP_TONE[state] || 'bg-slate-100 text-slate-600') : 'bg-red-50 text-red-700';
    return (
      <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold ${tone}`}
        title={m.dripoff_plate ? `DRIP OFF plate · ${m.dripoff_plate.plate_size || DRIP_OFF_PLATE_SIZE}` : 'Drip-off coating — no DRIP OFF plate on a Plate PR yet'}>
        {state || 'Plate not raised'}
      </span>
    );
  };

  const columns = [
    { key: 'po_number', label: 'Order #', render: r => r._gang
      ? (<div>{r.run_kind === 'merge' ? <MergeChip number={r.gang_number} /> : <GangChip number={r.gang_number} />}<div className="mt-0.5 font-semibold text-slate-800">{[...new Set(r._gang.map(m => m.po_number))].join(' · ')}</div><div className={`text-[10px] font-bold uppercase tracking-wide ${r.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-500'}`}>{r.run_kind === 'merge' ? `${r._gang.length} orders · one pile` : `${r._gang.length} cartons · one run`}</div></div>)
      : <span className="font-semibold text-slate-800">{r.po_number}</span> },
    // Was labelled just "Date" and sorted on the rendered string, which orders
    // by the day name. Named for what it is now, sorted on the raw date, and a
    // gang shows its span — the same pair every other planning screen carries.
    { key: 'po_date', colClass: 'ci-p3', label: 'PO Date', card: 'detail',
      sortValue: r => poAgeOf(r).date || '',
      export: r => { const a = poAgeOf(r); return a.date
        ? fmt.date(a.date) + (a.latest ? ` — ${fmt.date(a.latest)}` : '') : '—'; },
      render: r => { const a = poAgeOf(r);
        if (!a.date) return <span className="text-slate-300">—</span>;
        return (
          <div className="text-xs tabular-nums leading-4 text-slate-600">
            <div className="whitespace-nowrap">{fmt.date(a.date)}</div>
            {a.latest && <div className="whitespace-nowrap text-[10px] text-slate-400">→ {fmt.date(a.latest)}</div>}
          </div>
        ); } },
    { key: 'od', colClass: 'ci-p3', label: 'OD', align: 'right',
      sortValue: r => poAgeOf(r).days ?? -1,
      export: r => { return odExport(poAgeOf(r).days); },
      render: r => { const a = poAgeOf(r); return <OverdueDays days={a.days} count={a.count} />; } },
    { key: 'customer_name', colClass: 'ci-cap-sm', label: 'Company', render: r => {
      const p1 = r._gang ? r._gang.some(m => m.is_p1) : r.is_p1;
      const name = r._gang ? [...new Set(r._gang.map(m => m.customer_name))].join(' · ') : r.customer_name;
      return <span className="flex items-center gap-1.5">{p1 ? <Star size={13} className="fill-amber-400 text-amber-500" /> : null}{name}</span>;
    } },
    { key: 'product_name', colClass: 'ci-cap', label: 'Product',
      searchValue: r => (r._gang || [r]).map(productSearchText).join(' '),
      export: r => r._gang ? r._gang.map(productExport).join(' + ') : productExport(r),
      render: r => r._gang
      ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'}
          total={<span className={`font-semibold normal-case ${r.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-600'}`}>
            {r.run_kind === 'merge' ? 'one pile — no split' : 'together until die cutting'}</span>}
          render={m => <ProductIdentity row={m} compact className="min-w-[9rem]" />} />
      : <ProductIdentity row={r} compact className="min-w-[9rem]" /> },
    // Every quantity column carries its own `export`, and MUST.
    //
    // A gang row renders <GangCellParts>, which builds its content from props
    // inside the component and so has no `children`. The exporter reads a cell
    // by walking `props.children` (it never renders a component), so a gang row
    // in a column without an `export` came out BLANK — Order Qty, Supplied and
    // Pending were all empty on exactly the rows a customer most wants to read.
    // The figure exported is the run's TOTAL, which is what a collapsed row
    // means; the members are already named one per line in the Product column.
    // fmt.num keeps the thousands separators for the PDF, and the exporter's
    // xlNumber strips them back to a real number for Excel, so the column stays
    // sortable and summable.
    { key: 'qty', label: 'Order Qty', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'qty') : r.qty,
      export: r => fmt.num(r._gang ? sum(r._gang, 'qty') : r.qty),
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'qty'))} render={m => fmt.num(m.qty)} /> : fmt.num(r.qty) },
    { key: 'dispatched_qty', colClass: 'ci-p3', label: 'Supplied', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'dispatched_qty') : r.dispatched_qty,
      export: r => fmt.num(r._gang ? sum(r._gang, 'dispatched_qty') : r.dispatched_qty),
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'dispatched_qty'))} render={m => fmt.num(m.dispatched_qty)} /> : fmt.num(r.dispatched_qty) },
    { key: 'pending_qty', label: 'Pending', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'pending_qty') : r.pending_qty,
      export: r => fmt.num(r._gang ? sum(r._gang, 'pending_qty') : r.pending_qty),
      render: r => r._gang
        ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'pending_qty'))} render={m => <span className="font-semibold text-slate-900">{fmt.num(m.pending_qty)}</span>} />
        : <span className="font-semibold text-slate-900">{fmt.num(r.pending_qty)}</span> },
    // WHERE IT IS — one word, the same one the chip above is filtering on.
    // Sortable in plant order rather than alphabetically, so sorting the column
    // walks the floor from unplanned to done instead of from Coating to Queued.
    { key: 'stages', label: 'Stage',
      sortValue: r => { const k = lineStageOf(r._gang ? r._gang[0] : r).key;
        const i = [...PRE_STAGE_KEYS, ...SECTION_ORDER].indexOf(k);
        return i < 0 ? SECTION_ORDER.length + PRE_STAGE_KEYS.length : i; },
      export: r => perMember(r, whereItIs, ' | '),
      render: r => r._gang ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'} render={StagesCell} /> : StagesCell(r) },
    // How far down the route that stage sits. "Printing" alone does not say
    // whether it is the second station of nine or the last one — on screen the
    // bar already shows it, so this column exists for the workbook and stays
    // out of the way with the other detail columns.
    { key: 'stage_progress', colClass: 'ci-p3', label: 'Progress', align: 'right', card: 'detail',
      sortValue: r => { const { done, total } = lineStageOf(r._gang ? r._gang[0] : r); return total ? done / total : -1; },
      export: r => perMember(r, stageProgress),
      render: r => <span className="text-xs tabular-nums text-slate-500">{perMember(r, stageProgress)}</span> },
    // The job card the line is running on — the one thing that lets whoever
    // reads the export go and look the job up. A ganged line answers to its
    // gang's card and later its own, so both are named.
    { key: 'job_cards', colClass: 'ci-p3', label: 'Job Card', card: 'detail', sortable: false,
      searchValue: r => linesOf(r).flatMap(m => m.job_cards || []).join(' '),
      export: r => perMember(r, m => (m.job_cards || []).join(' + ') || '—'),
      render: r => {
        const jc = [...new Set(linesOf(r).flatMap(m => m.job_cards || []))];
        if (!jc.length) return <span className="text-slate-300">—</span>;
        return <span className="whitespace-nowrap text-xs font-semibold tabular-nums text-slate-600">{jc.join(' · ')}</span>;
      } },
    // Unplanned / Planned / In production. On screen the chips answer this, so
    // it rides as a detail column; in the workbook it is what makes the sheet
    // filterable the same way the rail filters it here.
    { key: 'planning_status', colClass: 'ci-p3', label: 'Planning', card: 'detail',
      sortValue: r => planningStatus(r._gang ? r._gang[0] : r),
      export: r => perMember(r, planningStatus),
      render: r => <span className="whitespace-nowrap text-xs text-slate-500">{perMember(r, planningStatus)}</span> },
    { key: 'printed', label: 'Print Status', sortable: false,
      export: r => perMember(r, m => printState(m)[0]),
      render: r => r._gang ? <GangCellParts members={r._gang} render={PrintedCell} /> : PrintedCell(r) },
    // The drip-off varnish mask, for every drip-coated carton: which size,
    // where it stands (issued at coating start, consumed at completion — the
    // plate module's lifecycle), red when the coating demands one and no Plate
    // PR carries it yet. A chip renders as '' in the workbook, so the export
    // spells the same fact out in words.
    { key: 'dripoff_plate', colClass: 'ci-p3', label: 'Drip Plate', card: 'detail', sortable: false,
      searchValue: r => perMember(r, dripPlateText),
      export: r => perMember(r, dripPlateText),
      render: r => r._gang ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'} render={DripPlateCell} /> : DripPlateCell(r) },
    { key: 'delivery_date', label: 'EDD',
      export: r => (r._gang ? [...new Set(r._gang.map(m => fmt.date(m.delivery_date)))].join(' · ') : fmt.date(r.delivery_date)),
      // Per LINE now, so a gang always shows one control per member — the
      // old single-control shortcut for a one-order gang would have edited
      // the first member and silently left the others behind.
      render: r => r._gang ? <GangCellParts members={r._gang} render={EddCell} /> : EddCell(r) },
    { key: 'wip', colClass: 'ci-p3', label: 'WIP', sortable: false,
      // Three states, spelled out. "No" would have collapsed Non-WIP and
      // never-mentioned back into one word in the very report that exists to
      // tell them apart.
      export: r => perMember(r, m => (m.wip == null ? '—'
        : `${m.wip ? 'WIP' : 'Non-WIP'}${m.wip_date ? ` (${String(m.wip_date).slice(0, 10)})` : ''}`)),
      render: r => r._gang ? <GangCellParts members={r._gang} render={WipCell} /> : WipCell(r) },
    // The status the chips filter on. Visible, and deliberately absent from the
    // export — wipExport.js drops it by key, so renaming the label cannot put
    // it back in a customer's workbook.
    { key: 'line_status', label: 'Status', sortable: true,
      sortValue: r => r.line_status || '',
      render: r => r._gang ? <GangCellParts members={r._gang} render={StatusCell} /> : StatusCell(r) },
    { key: 'remarks', label: 'Remarks', sortable: false, width: 'w-[11rem]',
      searchValue: r => linesOf(r).map(m => m.remarks || '').join(' '),
      export: r => perMember(r, m => m.remarks || '—'),
      render: r => r._gang ? <GangCellParts members={r._gang} render={RemarksCell} /> : RemarksCell(r) },
    { key: 'is_p1', label: 'P1', align: 'right',
      export: r => perMember(r, m => (m.is_p1 ? 'P1' : '—')),
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" render={P1Cell} /> : P1Cell(r) },
    threadColumn({ entity: 'order_line', threads, idOf: threadLineId }),
  ];

  return (
    <div>
      <PageHeader title="Status Sheet"
        subtitle="Live pending-order status — supply progress, delivery dates, customer WIP and priority in one editable sheet"
        actions={<>
          {/* Only offered when there is something to clear — a dead button on a
              header is one more thing to read past, and its absence says the
              list is already empty for whoever is in view. */}
          {clearable.length > 0 && (
            <Button variant="secondary" disabled={bulkBusy} onClick={() => setClearOpen(true)}>
              <Eraser size={15} /> Clear WIP ({clearable.length})
            </Button>
          )}
          <Button variant="secondary" onClick={() => { setWipOpen(true); }}>
            <FileUp size={15} /> Import WIP List
          </Button>
        </>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard icon={ClipboardList} label="Pending lines" value={fmt.num(kpis.lines)} />
        <KpiCard label="Pending qty" value={fmt.num(kpis.pendingQty)} />
        <KpiCard icon={AlertTriangle} label="Overdue" value={fmt.num(kpis.overdue)} accent="text-red-600"
          onClick={() => kpi.toggle('overdue')} active={kpi.is('overdue')} />
        <KpiCard icon={Star} label="P1 products" value={fmt.num(kpis.p1)} accent="text-amber-600"
          onClick={() => kpi.toggle('p1')} active={kpi.is('p1')} />
        {/* WIP LINES, and the sub says so. Planning's strip carries a card off
            the same customer list that will legitimately read LOWER, because it
            counts queue ROWS: a gang is one job there however many WIP members
            it carries, and a line we have already dispatched has left the queue
            while it is still on this sheet (wip-scope.js — the sheet is
            cumulative on purpose). Two true numbers, so each card names its own
            unit and its own scope rather than leaving the planner to guess
            which one is broken. */}
        <KpiCard icon={Hammer} label="WIP Lines" value={fmt.num(kpis.wip)} accent="text-blue-600"
          sub="customer's list · incl. dispatched"
          title="Order LINES the customer marked WIP. This sheet is cumulative — a line stays on it after it is produced or dispatched, until someone takes it off the WIP list — so this runs higher than Planning's WIP Jobs card. Click to show only these."
          onClick={() => kpi.toggle('wip')} active={kpi.is('wip')} />
      </div>
      <KpiFilterNotice filter={kpi} label={STATUS_KPI_LABEL[kpi.key]}
        shown={filtered.length} total={chipped.length} className="mt-3" />

      {/* Three chip rails, one question each: what the CUSTOMER is owed, WHERE
          the plant has got to, and WHOSE it is. All multi-select, all narrowing
          the same set the KPI cards count — so "Pending" beside "Printing"
          beside a customer reads as the sentence it looks like.

          Every chip comes from FilterChip, never from a class string written
          here: this page used to hand-roll two different pill shapes, which is
          exactly the drift that component exists to stop (see
          ci-erp-filter-chip-system). Structure carries identity — each axis has
          a CAPTION, so "Pending 99" and "Planned 57" cannot be mistaken for the
          same question. Colour is spent only on the states this plant acts on;
          a stage chip is classification and lights graphite.

          No rail carries its own reset: all three are registered with
          useFilterReset above, so "Show everything" is the ONE control that
          clears the page. */}
      <FilterRail className="mt-3">
        <FilterGroup label="Owed" divider={false}>
          {LINE_STATUSES.map(s => (
            <FilterChip key={s.key} label={s.label} count={statusCounts[s.key]}
              on={statusKeys.includes(s.key)} tone={s.tone}
              onClick={() => { toggleIn(setStatusKeys, s.key); clearSel(); }} />
          ))}
        </FilterGroup>
        {/* The new axis. Reads left to right the way the plant runs: nobody has
            planned it → planned → the card is waiting → the station it is
            standing on → finished. A stage nothing is sitting at keeps its chip
            and recedes, so the rail does not change width through the day. */}
        <FilterGroup label="Where it is">
          {stageChips.map(c => (
            <FilterChip key={c.key} label={stageKeyLabel(c.key)} count={c.count}
              on={stageKeys.includes(c.key)} tone={STAGE_CHIP_TONE[c.key]}
              title={PRE_STAGE_KEYS.includes(c.key) || c.key === 'done'
                ? undefined
                : `Lines standing at ${stageKeyLabel(c.key)} — running there, or waiting to start`}
              onClick={() => { toggleIn(setStageKeys, c.key); clearSel(); }} />
          ))}
        </FilterGroup>
      </FilterRail>
      {customers.length > 1 && (
        <FilterRail className="mt-2">
          <FilterGroup label="Customer" divider={false}>
            {/* A customer name is the one chip label with no length limit —
                "Swiss Garniers Biotech Private Limited" is a real party here.
                The cap goes on the NAME, not the chip, so the count pill beside
                it is never the thing that gets clipped: min-w-0 is what lets a
                flex child truncate at all, and shrink-0 keeps the number whole. */}
            {customers.map(c => (
              <FilterChip key={c.name} count={c.n}
                label={<span className="min-w-0 max-w-[11rem] truncate">{c.name}</span>}
                on={custKeys.includes(c.name)}
                title={`${c.name} — ${c.n} line${c.n === 1 ? '' : 's'}`}
                onClick={() => { toggleIn(setCustKeys, c.name); clearSel(); }} />
            ))}
          </FilterGroup>
        </FilterRail>
      )}
      {filters.dirty && (
        <div className="mt-3 flex justify-end">
          <ResetFilters filters={filters} shown={filtered.length} total={rows.length} />
        </div>
      )}
      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the status sheet can’t load'}. Retrying every minute…
        </div>
      )}
      {/* The search box lives in the table's own toolbar (left, beside Export)
          — no more half-empty band floating above the sheet just to hold it. */}
      <div className="mt-3">
      <DataTable
        columns={columns}
        rows={displayRows}
        searchValue={q} onSearchChange={setQ}
        // Universal: rowMatches walks every raw field of the line plus each
        // column's own searchValue, so the product's codes and the planner's
        // remark are as findable as the PO number. No whitelist to fall behind.
        searchPlaceholder="Search anything — order, company, product, code, remark…"
        getRowId={r => r.line_id}
        selectable
        selectedIds={selIds}
        onToggleRow={(row, checked) => setSelIds(cur => (checked
          ? [...new Set([...cur, row.line_id])]
          : cur.filter(id => String(id) !== String(row.line_id))))}
        onToggleAll={(rs, checked) => {
          const ids = rs.map(r => r.line_id);
          const want = new Set(ids.map(String));
          setSelIds(cur => (checked
            ? [...new Set([...cur, ...ids])]
            : cur.filter(id => !want.has(String(id)))));
        }}
        rowClass={r => {
          // A WIP row is tinted at ROW level — urgency is visible from across
          // the room, not only in one cell. The unread-thread tint still wins
          // (it asks for a click; the WIP tint only asks for attention).
          const unread = unreadRowClass(threads, threadLineId)(r);
          if (unread) return unread;
          const isWip = r._gang ? r._gang.some(m => m.wip) : r.wip;
          return isWip ? 'bg-blue-50/60' : '';
        }}
        groupBy={r => (r._gang ? `gang-${r.gang_run_id}` : null)}
        groupTone={r => (r.run_kind === 'merge' ? 'teal' : 'violet')}
        defaultSort={{ key: 'delivery_date', dir: 'asc' }}
        exportName="Status Sheet"
        exportSubtitle="Pending order status"
        // The workbook's SHAPE is a decision here, not just its rows: with two
        // or more customers in view it becomes one worksheet per customer. See
        // wipExport.js — it also drops the Status column and splits a run
        // shared by two companies so neither sheet carries the other's carton.
        exportSpec={(sortedRows, cols) => buildWipExportSpec({
          rows: sortedRows,
          columns: cols,
          excluded: EXPORT_EXCLUDED_KEYS,
          name: 'Status Sheet',
          subtitle: 'Pending order status',
          meta: [
            q ? `Search: "${q}"` : null,
            statusKeys.length ? `Status: ${statusKeys.map(k => STATUS_LABEL[k]).join(', ')}` : null,
            stageKeys.length ? `Stage: ${stageKeys.map(stageKeyLabel).join(', ')}` : null,
            custKeys.length ? `Customers: ${custKeys.join(', ')}` : null,
            `${sortedRows.length} of ${rows.length} records`,
          ],
        })}
        empty={loadError ? 'Server unreachable — nothing to show until it reconnects.'
          : (statusKeys.length || stageKeys.length || custKeys.length) ? 'Nothing matches these filters — clear one to widen the view.'
          : 'No pending orders — everything is dispatched or closed.'}
      />
      </div>

      {/* Bulk WIP. Three actions because there are three states, and the two
          negatives are genuinely different: Non-WIP records that the customer
          said it is not in progress; Remove takes the line off their list
          entirely. The count names LINES, not rows — a ticked gang is several. */}
      {/* Applying a date to a whole PO replaces whatever its other products
          were individually given, so it says how many and which PO. */}
      <ConfirmDialog open={!!poEdd} onClose={() => setPoEdd(null)}
        onConfirm={() => applyEddToPo(poEdd)}
        confirmLabel={`Set all ${poEdd?.count ?? 0}`}
        title={`Give the whole PO this date?`}
        message={poEdd ? `All ${poEdd.count} products on PO ${poEdd.line.po_number} will be due ${fmt.date(poEdd.line.delivery_date)}. Any product on that PO carrying its own EDD loses it and follows the PO again — which is also what makes Planning and Dispatch show this date, since they read the PO's.` : ''} />

      {/* Wiping a customer's WIP list is not a bulk edit of a few ticked rows —
          it acts on everything in view — so it asks first, and the question
          names the count and whose list it is rather than "are you sure?". */}
      <ConfirmDialog open={clearOpen} onClose={() => setClearOpen(false)} onConfirm={clearAllWip}
        danger confirmLabel={`Clear ${clearable.length} line${clearable.length === 1 ? '' : 's'}`}
        title="Start the WIP list over?"
        message={`This takes ${clearable.length} line${clearable.length === 1 ? '' : 's'} off the WIP list for ${clearScope} — every WIP and Non-WIP mark currently in view, and the dates with them. Nothing else about the orders changes, and you can import a fresh list straight after. Lines outside the current filters are untouched.`} />

      <SelectionDock open={selectedRows.length > 0} count={selectedLines.length}
        summary={`${selectedLines.length} line${selectedLines.length === 1 ? '' : 's'}`
          + (selectedRows.length !== selectedLines.length ? ` across ${selectedRows.length} rows` : '')
          + ' · ' + [...new Set(selectedLines.map(l => l.customer_name))].slice(0, 3).join(' · ')}
        title={[...new Set(selectedLines.map(l => l.customer_name))].join(', ')}
        onClear={clearSel}>
        <Button size="sm" disabled={bulkBusy} onClick={() => applyBulk(true, 'marked Customer WIP')}>
          <Zap size={13} /> Mark as WIP
        </Button>
        <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => applyBulk(false, 'marked Non-WIP')}>
          <ZapOff size={13} /> Mark as Non-WIP
        </Button>
        <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => applyBulk(null, 'removed from the WIP list')}>
          <X size={13} /> Remove from WIP
        </Button>
      </SelectionDock>

      {/* ── Import the customer's WIP list ──────────────────────────────────
          Two phases in one modal: drop the file, then review what matched.
          Nothing is written until "Mark … as WIP" — confident matches arrive
          ticked (so Yes-to-All is one click), fuzzy suggestions arrive
          unticked for the planner's eye, and every date stays editable.

          The import ADDS. It only ever writes a WIP record onto the lines that
          are ticked, so last week's list survives this week's — the cumulative
          list Anik asked for. Nothing here can clear a record: taking a product
          off the list is the deliberate "Remove from WIP" in the dock. */}
      <Modal open={wipOpen} onClose={closeWip} wide title="Import Customer WIP List"
        footer={wipRes ? <>
          <Button variant="secondary" onClick={closeWip}>Cancel</Button>
          <Button onClick={applyWip} disabled={wipBusy || wipSel.size === 0}>
            <Zap size={13} /> {wipBusy ? 'Marking…' : `Mark ${wipSel.size} line${wipSel.size === 1 ? '' : 's'} as WIP`}
          </Button>
        </> : <Button variant="secondary" onClick={closeWip}>Close</Button>}>
        {!wipRes ? (
          <label className="flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/60 p-8 text-center hover:border-blue-300 hover:bg-blue-50/40"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleWipFile(e.dataTransfer.files?.[0]); }}>
            {wipBusy ? <Loader2 size={28} className="animate-spin text-blue-500" /> : <FileUp size={28} className="text-slate-400" />}
            <div className="text-sm font-semibold text-slate-600">
              {wipBusy ? 'Reading the list…' : "Drop the customer's WIP list here, or click to choose"}
            </div>
            <div className="text-xs text-slate-400">
              Excel (.xlsx), CSV, or a text PDF — each row an item they are waiting on.
              Matched products are shown for confirmation before anything is marked.
              This <span className="font-semibold text-slate-500">adds to</span> the existing WIP list;
              products only leave it when you remove them.
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,application/pdf" className="hidden"
              onChange={e => { handleWipFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-blue-50/70 px-3 py-2 text-xs font-semibold text-blue-800">
              <Zap size={13} className="shrink-0" />
              <span>
                {wipRes.items.length} product{wipRes.items.length === 1 ? '' : 's'} mapped to pending lines
                {wipRes.unmatched > 0 && <span className="text-blue-500"> · {wipRes.unmatched} row{wipRes.unmatched === 1 ? '' : 's'} unrecognised</span>}
                . Tick what to mark — nothing is written until you confirm.
              </span>
              <button type="button" className="ml-auto shrink-0 rounded-full bg-white/80 px-2 py-0.5 font-bold text-blue-700 hover:bg-white"
                onClick={() => setWipSel(new Set(wipRes.items.flatMap(it => it.lines.filter(l => !l.already_wip).map(l => l.line_id))))}>
                Yes to all
              </button>
            </div>
            {/* Say HOW the EDD was read. "Second date on each row" is a guess
                the planner must be able to check, and a file that named its
                column deserves to be trusted out loud. */}
            <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-xs font-semibold ${
              wipRes.edd?.mode === 'header' ? 'bg-emerald-50/70 text-emerald-800'
                : wipRes.edd?.mode === 'positional' ? 'bg-amber-50/70 text-amber-800'
                : 'bg-slate-50 text-slate-500'}`}>
              <CalendarDays size={13} className="shrink-0" />
              <span>
                {wipRes.edd?.mode === 'header'
                  ? <>EDD read from the sheet’s own <span className="font-bold">“{wipRes.edd.column}”</span> column.</>
                  : wipRes.edd?.mode === 'positional'
                    ? <>This sheet names no delivery column — the <span className="font-bold">second date on each row</span> is offered as the EDD. Check them before confirming.</>
                    : <>No delivery date found in this file — EDD is left as it is. You can still type one per line.</>}
                {' '}EDD is set on the product line, so two items of one PO can want different days.
              </span>
            </div>
            <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
              {wipRes.items.map(it => (
                <div key={it.row} className={`rounded-xl border p-2.5 ${it.status === 'matched' ? 'border-blue-100 bg-white' : 'border-amber-200 bg-amber-50/40'}`}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700" title={it.text}>{it.text}</span>
                    {it.status === 'suggested' && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700"
                        title={`Fuzzy match at ${Math.round((it.confidence || 0) * 100)}% — check before ticking`}>
                        possible · {Math.round((it.confidence || 0) * 100)}%
                      </span>
                    )}
                  </div>
                  {it.lines.map(l => (
                    <label key={l.line_id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-slate-50">
                      <input type="checkbox" className="h-4 w-4 accent-[#0A84FF]" disabled={l.already_wip}
                        checked={l.already_wip || wipSel.has(l.line_id)}
                        onChange={e => setWipSel(s => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(l.line_id); else n.delete(l.line_id);
                          return n;
                        })} />
                      <span className="min-w-0 flex-1 text-xs text-slate-600">
                        PO <span className="font-semibold text-slate-800">{l.po_number}</span> · {l.customer_name}
                        {l.already_wip && <span className="ml-1.5 text-[10px] font-bold text-blue-500">already WIP</span>}
                        {/* A line sitting at Non-WIP is tickable — the customer
                            has changed their mind, and that is the whole point
                            of a second list. */}
                        {l.wip === false && <span className="ml-1.5 text-[10px] font-bold text-slate-400">was Non-WIP</span>}
                        {/* The row that used to go missing. Before the matcher
                            shared the sheet's scope, a product we had already
                            finished simply came back "unrecognised". */}
                        {l.line_status && l.line_status !== 'pending' && (
                          <span className={`ml-1.5 rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase ${
                            STATUS_PILL[l.line_status]}`}>{STATUS_LABEL[l.line_status]}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-wide text-slate-400">WIP</span>
                      <input type="date" value={wipDates[l.line_id] || ''} disabled={l.already_wip}
                        onChange={e => setWipDates(d => ({ ...d, [l.line_id]: e.target.value }))}
                        className="h-7 shrink-0 rounded-md border border-slate-200 px-1.5 text-[11px] text-slate-600"
                        title="The WIP date recorded against this line" />
                      {/* EDD writes to the ORDER, so it is shown against the PO
                          it will move and left blank when the file named none —
                          blank means "leave the existing date alone", never
                          "clear it". */}
                      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-wide text-slate-400">EDD</span>
                      <input type="date" value={wipEdds[l.line_id] || ''} disabled={l.already_wip}
                        onChange={e => setWipEdds(d => ({ ...d, [l.line_id]: e.target.value }))}
                        className={`h-7 shrink-0 rounded-md border px-1.5 text-[11px] ${
                          wipEdds[l.line_id] && wipEdds[l.line_id] !== l.current_edd
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : 'border-slate-200 text-slate-600'}`}
                        title={l.current_edd
                          ? `This product on PO ${l.po_number} currently says ${l.current_edd}`
                          : `This product on PO ${l.po_number} has no delivery date yet`} />
                    </label>
                  ))}
                </div>
              ))}
              {!wipRes.items.length && (
                <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
                  Nothing in that file matched a pending product — check it is the WIP list for items still open here.
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
