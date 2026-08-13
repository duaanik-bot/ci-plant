// Status Sheet — the live, editable coordination view of every PENDING order-line
// still owed to a customer. One row per order × product. Read-only supply figures
// (order qty / supplied / pending) sit beside editable coordination fields:
//   • Stages       — tiny live chips of the line's real production route
//   • Print Status — READ-ONLY, synced live from the printing stage itself
//                    (not started / queued / running / partial / hold / done)
//   • EDD          — the order's delivery date, edited inline, no overdue block
//   • WIP          — the CUSTOMER's urgency flag (not our floor): Yes/No dropdown
//                    with the date it was marked, settable by hand or by
//                    uploading the customer's own WIP list (Excel/CSV/PDF)
//   • P1           — a manual, PER-PRODUCT priority flag
// Edits post to /status-sheet/* and update optimistically; realtime/fallback refresh reconciles.
import { useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { dayOf } from '../lib/dayOf.js';
import { Button, DataTable, KpiCard, KpiFilterNotice, Modal, odDays, OverdueDays, PageHeader, ResetFilters, rowMatches, useFilterReset, useKpiFilter, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { ClipboardList, AlertTriangle, Star, Hammer, FileUp, Loader2, Zap } from 'lucide-react';
import { GangChip, GangCellParts } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { SECTION_META } from '../sections.js';

const STATUS_KPI_ROWS = {
  overdue: r => +r.overdue_days > 0,
  p1: r => !!r.is_p1,
  wip: r => !!r.wip,
};
const STATUS_KPI_LABEL = {
  overdue: 'lines past their delivery date',
  p1: 'lines on a P1 product',
  wip: 'lines the customer marked WIP (urgent)',
};

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

  // Optimistic line edit (Printed override / WIP / P1) — patch one line, reconcile on error.
  const patchLine = (line, body) => {
    setRows(rs => rs.map(r => (r.line_id === line.line_id ? { ...r, ...body } : r)));
    api.patch(`/status-sheet/line/${line.line_id}`, body).catch(load);
  };
  // Order-level edits (EDD) touch every line of that order in the view.
  const patchOrder = (line, body) => {
    setRows(rs => rs.map(r => (r.order_id === line.order_id ? { ...r, ...body } : r)));
    api.patch(`/status-sheet/order/${line.order_id}`, body).catch(load);
  };

  // ── Customer WIP import — parse → review → confirm ────────────────────────
  const toast = useToast();
  const fileRef = useRef(null);
  const [wipOpen, setWipOpen] = useState(false);
  const [wipBusy, setWipBusy] = useState(false);
  const [wipRes, setWipRes] = useState(null);          // /wip-match response
  const [wipSel, setWipSel] = useState(() => new Set()); // checked line ids
  const [wipDates, setWipDates] = useState({});          // line_id → date
  const closeWip = () => { setWipOpen(false); setWipRes(null); setWipSel(new Set()); setWipDates({}); };
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
      const res = await api.post('/status-sheet/wip-match', { rows: parsed.rows });
      setWipRes(res);
      // Confident matches arrive ticked ("Yes to All" is then one click);
      // fuzzy suggestions arrive unticked for the planner's eye. Lines already
      // WIP arrive unticked too — nothing to do for them.
      const sel = new Set();
      const dates = {};
      for (const it of res.items) {
        for (const l of it.lines) {
          dates[l.line_id] = it.date || todayISO();
          if (it.status === 'matched' && !l.already_wip) sel.add(l.line_id);
        }
      }
      setWipSel(sel); setWipDates(dates);
    } catch (e) {
      toast.error(e.message || 'Could not read that file');
    } finally { setWipBusy(false); }
  };
  const applyWip = async () => {
    setWipBusy(true);
    try {
      const items = [...wipSel].map(id => ({ line_id: id, wip_date: wipDates[id] || todayISO() }));
      const res = await api.post('/status-sheet/wip-apply', { items });
      toast.success(`${res.applied.length} line${res.applied.length === 1 ? '' : 's'} marked Customer WIP`);
      closeWip(); load();
    } catch (e) { toast.error(e.message || 'Could not mark the lines'); }
    finally { setWipBusy(false); }
  };

  const kpis = useMemo(() => ({
    lines: rows.length,
    pendingQty: rows.reduce((s, r) => s + (r.pending_qty || 0), 0),
    overdue: rows.filter(r => r.overdue_days > 0).length,
    p1: rows.filter(r => r.is_p1).length,
    wip: rows.filter(r => r.wip).length,
  }), [rows]);

  const kpi = useKpiFilter('status-sheet');
  // wipSel is deliberately absent: those are the lines the user has ticked to
  // mark WIP, a checklist they are building to submit, not a way of narrowing
  // the sheet. Clearing it here would throw away their work.
  const filters = useFilterReset([
    [q, setQ, '', 'search'],
    [kpi.keys, kpi.clear, [], 'KPI card'],
  ]);
  const searched = useMemo(() => (q
    ? rows.filter(r => rowMatches(r, q, (r._gang || [r]).map(productSearchText).join(' ')))
    : rows), [rows, q]);
  // Applied to LINES, before gangs collapse, because the cards count lines too.
  const filtered = kpi.apply(searched, STATUS_KPI_ROWS);
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
  const EddCell = m => (
    <input type="date" value={m.delivery_date ? String(m.delivery_date).slice(0, 10) : ''}
      onChange={e => patchOrder(m, { delivery_date: e.target.value || null })}
      className={`${selCls} ${m.overdue_days > 0 ? 'bg-red-50 text-red-700 border-red-300' : ''}`}
      title={m.overdue_days > 0 ? `${m.overdue_days} day(s) overdue` : ''} />
  );
  // WIP — the customer's urgency, always hand-editable. Toggling Yes stamps
  // today unless a date is already there (the upload flow writes the sheet's
  // own date); the date stays editable while the flag is on and leaves with it.
  const WipCell = m => (
    <div className="flex flex-col gap-1">
      <select className={`${selCls} ${m.wip ? 'bg-blue-50 text-blue-700 border-blue-300' : ''}`}
        value={m.wip ? 'yes' : 'no'}
        onChange={e => {
          const on = e.target.value === 'yes';
          patchLine(m, { wip: on, wip_date: on ? (m.wip_date || todayISO()) : null });
        }}>
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </select>
      {m.wip && (
        <input type="date" value={m.wip_date ? String(m.wip_date).slice(0, 10) : ''}
          onChange={e => patchLine(m, { wip: true, wip_date: e.target.value || todayISO() })}
          className="h-7 rounded-md border border-blue-200 bg-blue-50/60 px-1.5 text-[11px] font-medium text-blue-700 focus:outline-none"
          title="When the customer's list marked it WIP" />
      )}
    </div>
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
    if (!st.length) return <span className="text-[10px] font-bold uppercase tracking-wide text-slate-300">not started</span>;
    const done = st.filter(s => s.status === 'completed').length;
    const runningAt = st.findIndex(s => s.status === 'in_progress' || s.status === 'partially_completed');
    // Where the eye should land: the stage actually running, else the next one
    // waiting, else the last (the route is finished).
    const here = runningAt >= 0 ? st[runningAt] : (st[done] || st[st.length - 1]);
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
          {finished ? 'done' : (STAGE_SHORT[here.stage] || here.stage)}
        </span>
        <span className="text-[10px] font-semibold tabular-nums text-slate-400">{done}/{st.length}</span>
      </div>
    );
  };
  // Text form of the route for exports: Cut✓ Prt… Die (✓ done, … running).
  const stageText = m => {
    const st = m.stages || [];
    if (!st.length) return 'Not started';
    return st.map(s => `${STAGE_SHORT[s.stage] || s.stage}${
      s.status === 'completed' ? '✓'
        : (s.status === 'in_progress' || s.status === 'partially_completed') ? '…' : ''}`).join(' ');
  };

  // EDD is ORDER-level. A gang usually shares one order → one control; a gang
  // spanning several orders partitions them so each order stays editable.
  // (P1 is per-LINE, so a gang always gets one star per member.)
  const oneOrder = g => new Set(g.map(m => m.order_id)).size === 1;
  const sum = (g, k) => g.reduce((s, m) => s + (Number(m[k]) || 0), 0);
  const perMember = (r, f, sep = ' · ') => (r._gang ? r._gang.map(f).join(sep) : f(r));

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
      export: r => { const d = poAgeOf(r).days; return d == null ? '—' : `${d}d`; },
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
    { key: 'qty', label: 'Order Qty', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'qty') : r.qty,
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'qty'))} render={m => fmt.num(m.qty)} /> : fmt.num(r.qty) },
    { key: 'dispatched_qty', colClass: 'ci-p3', label: 'Supplied', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'dispatched_qty') : r.dispatched_qty,
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'dispatched_qty'))} render={m => fmt.num(m.dispatched_qty)} /> : fmt.num(r.dispatched_qty) },
    { key: 'pending_qty', label: 'Pending', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'pending_qty') : r.pending_qty,
      render: r => r._gang
        ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'pending_qty'))} render={m => <span className="font-semibold text-slate-900">{fmt.num(m.pending_qty)}</span>} />
        : <span className="font-semibold text-slate-900">{fmt.num(r.pending_qty)}</span> },
    { key: 'stages', label: 'Stages', sortable: false,
      export: r => perMember(r, stageText, ' | '),
      render: r => r._gang ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'} render={StagesCell} /> : StagesCell(r) },
    { key: 'printed', label: 'Print Status', sortable: false,
      export: r => perMember(r, m => printState(m)[0]),
      render: r => r._gang ? <GangCellParts members={r._gang} render={PrintedCell} /> : PrintedCell(r) },
    { key: 'delivery_date', label: 'EDD',
      export: r => (r._gang ? [...new Set(r._gang.map(m => fmt.date(m.delivery_date)))].join(' · ') : fmt.date(r.delivery_date)),
      render: r => !r._gang ? EddCell(r) : (oneOrder(r._gang) ? EddCell(r._gang[0]) : <GangCellParts members={r._gang} render={EddCell} />) },
    { key: 'wip', colClass: 'ci-p3', label: 'WIP', sortable: false,
      export: r => perMember(r, m => (m.wip ? `Yes${m.wip_date ? ` (${String(m.wip_date).slice(0, 10)})` : ''}` : 'No')),
      render: r => r._gang ? <GangCellParts members={r._gang} render={WipCell} /> : WipCell(r) },
    { key: 'is_p1', label: 'P1', align: 'right',
      export: r => perMember(r, m => (m.is_p1 ? 'P1' : '—')),
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" render={P1Cell} /> : P1Cell(r) },
    threadColumn({ entity: 'order_line', threads, idOf: threadLineId }),
  ];

  return (
    <div>
      <PageHeader title="Status Sheet"
        subtitle="Live pending-order status — supply progress, delivery dates, customer WIP and priority in one editable sheet"
        actions={
          <Button variant="secondary" onClick={() => { setWipOpen(true); }}>
            <FileUp size={15} /> Import WIP List
          </Button>
        } />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard icon={ClipboardList} label="Pending lines" value={fmt.num(kpis.lines)} />
        <KpiCard label="Pending qty" value={fmt.num(kpis.pendingQty)} />
        <KpiCard icon={AlertTriangle} label="Overdue" value={fmt.num(kpis.overdue)} accent="text-red-600"
          onClick={() => kpi.toggle('overdue')} active={kpi.is('overdue')} />
        <KpiCard icon={Star} label="P1 products" value={fmt.num(kpis.p1)} accent="text-amber-600"
          onClick={() => kpi.toggle('p1')} active={kpi.is('p1')} />
        <KpiCard icon={Hammer} label="Customer WIP" value={fmt.num(kpis.wip)} accent="text-blue-600"
          onClick={() => kpi.toggle('wip')} active={kpi.is('wip')} />
      </div>
      <KpiFilterNotice filter={kpi} label={STATUS_KPI_LABEL[kpi.key]}
        shown={filtered.length} total={searched.length} className="mt-3" />
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
        searchPlaceholder="Search order, company, product…"
        getRowId={r => r.line_id}
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
        empty={loadError ? 'Server unreachable — nothing to show until it reconnects.' : 'No pending orders — everything is dispatched or closed.'}
      />
      </div>

      {/* ── Import the customer's WIP list ──────────────────────────────────
          Two phases in one modal: drop the file, then review what matched.
          Nothing is written until "Mark … as WIP" — confident matches arrive
          ticked (so Yes-to-All is one click), fuzzy suggestions arrive
          unticked for the planner's eye, and every date stays editable. */}
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
                      </span>
                      <input type="date" value={wipDates[l.line_id] || ''} disabled={l.already_wip}
                        onChange={e => setWipDates(d => ({ ...d, [l.line_id]: e.target.value }))}
                        className="h-7 shrink-0 rounded-md border border-slate-200 px-1.5 text-[11px] text-slate-600"
                        title="The WIP date recorded against this line" />
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
