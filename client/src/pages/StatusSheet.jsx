// Status Sheet — the live, editable coordination view of every PENDING order-line
// still owed to a customer. One row per order × product. Read-only supply figures
// (order qty / supplied / pending) sit beside editable coordination fields:
//   • Stages   — tiny live chips of the line's real production route (done/running)
//   • Printed  — derived from our printing stage, with an Auto/Yes/No override
//   • EDD      — the order's delivery date, edited inline, no overdue block
//   • WIP      — a manual flag for the CUSTOMER's work-in-progress (not our floor)
//   • P1       — a manual, PER-PRODUCT priority flag (starring one line must not
//                light up the sibling products on the same PO)
// Edits post to /status-sheet/* and update optimistically; the 20s poll reconciles.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, KpiCard, KpiFilterNotice, PageHeader, SearchInput, rowMatches, useKpiFilter } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { ClipboardList, AlertTriangle, Star, Hammer } from 'lucide-react';
import { GangChip, GangCellParts } from '../components/Gang.jsx';
import { MergeChip } from '../components/Merge.jsx';
import { SECTION_META } from '../sections.js';

const STATUS_KPI_ROWS = {
  overdue: r => +r.overdue_days > 0,
  p1: r => !!r.is_p1,
  wip: r => !!r.wip,
};
const STATUS_KPI_LABEL = {
  overdue: 'lines past their delivery date',
  p1: 'lines on a P1 product',
  wip: 'lines already in production',
};

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
  // on a transient blip; the 20s poll clears the flag on the next success.
  const load = () => api.get('/status-sheet')
    .then(d => {
      const lines = d.lines || [];
      setRows(lines); setLoadError(false);
      threadSummary('order_line', lines.map(l => l.line_id)).then(setThreads).catch(() => {});
    })
    .catch(() => setLoadError(true));
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

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

  const printedResolved = r => (r.printed_override == null ? r.printed_derived : r.printed_override);

  const kpis = useMemo(() => ({
    lines: rows.length,
    pendingQty: rows.reduce((s, r) => s + (r.pending_qty || 0), 0),
    overdue: rows.filter(r => r.overdue_days > 0).length,
    p1: rows.filter(r => r.is_p1).length,
    wip: rows.filter(r => r.wip).length,
  }), [rows]);

  const kpi = useKpiFilter('status-sheet');
  const searched = useMemo(() => (q ? rows.filter(r => rowMatches(r, q)) : rows), [rows, q]);
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
  const PrintedCell = m => {
    const val = m.printed_override == null ? 'auto' : (m.printed_override ? 'yes' : 'no');
    const on = printedResolved(m);
    return (
      <select className={`${selCls} ${on ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : ''}`}
        value={val} onChange={e => { const v = e.target.value; patchLine(m, { printed_override: v === 'auto' ? null : v === 'yes' }); }}>
        <option value="auto">Auto ({m.printed_derived ? 'Yes' : 'No'})</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  };
  const EddCell = m => (
    <input type="date" value={m.delivery_date ? String(m.delivery_date).slice(0, 10) : ''}
      onChange={e => patchOrder(m, { delivery_date: e.target.value || null })}
      className={`${selCls} ${m.overdue_days > 0 ? 'bg-red-50 text-red-700 border-red-300' : ''}`}
      title={m.overdue_days > 0 ? `${m.overdue_days} day(s) overdue` : ''} />
  );
  const WipCell = m => (
    <select className={`${selCls} ${m.wip ? 'bg-blue-50 text-blue-700 border-blue-300' : ''}`}
      value={m.wip ? 'yes' : 'no'} onChange={e => patchLine(m, { wip: e.target.value === 'yes' })}>
      <option value="no">No</option>
      <option value="yes">Yes</option>
    </select>
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
    return (
      <div className="flex max-w-[12rem] flex-wrap gap-0.5">
        {st.map((s, i) => {
          const done = s.status === 'completed';
          const active = s.status === 'in_progress' || s.status === 'partially_completed';
          return (
            <span key={i}
              title={`${SECTION_META[s.stage]?.label || s.stage} — ${String(s.status).replace(/_/g, ' ')}${s.gang_shared ? ' · gang run' : ''}`}
              className={`rounded px-1 py-px text-[9px] font-bold uppercase tracking-wide
                ${done ? 'bg-emerald-100 text-emerald-700'
                  : active ? 'bg-amber-100 text-amber-700'
                  : 'bg-slate-100 text-slate-400'}`}>
              {STAGE_SHORT[s.stage] || s.stage}
            </span>
          );
        })}
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
    { key: 'po_date', label: 'Date', render: r => fmt.date(r._gang ? [...r._gang.map(m => m.po_date)].sort()[0] : r.po_date) },
    { key: 'customer_name', label: 'Company', render: r => {
      const p1 = r._gang ? r._gang.some(m => m.is_p1) : r.is_p1;
      const name = r._gang ? [...new Set(r._gang.map(m => m.customer_name))].join(' · ') : r.customer_name;
      return <span className="flex items-center gap-1.5">{p1 ? <Star size={13} className="fill-amber-400 text-amber-500" /> : null}{name}</span>;
    } },
    { key: 'product_name', label: 'Product', render: r => r._gang
      ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'}
          total={<span className={`font-semibold normal-case ${r.run_kind === 'merge' ? 'text-teal-600' : 'text-violet-600'}`}>
            {r.run_kind === 'merge' ? 'one pile — no split' : 'together until die cutting'}</span>}
          render={m => (<div className="min-w-[9rem]"><div className="text-slate-800">{m.product_name}</div><div className="text-xs text-slate-400">{m.product_code}</div></div>)} />
      : (<div className="min-w-[9rem]"><div className="text-slate-800">{r.product_name}</div><div className="text-xs text-slate-400">{r.product_code}</div></div>) },
    { key: 'qty', label: 'Order Qty', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'qty') : r.qty,
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'qty'))} render={m => fmt.num(m.qty)} /> : fmt.num(r.qty) },
    { key: 'dispatched_qty', label: 'Supplied', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'dispatched_qty') : r.dispatched_qty,
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'dispatched_qty'))} render={m => fmt.num(m.dispatched_qty)} /> : fmt.num(r.dispatched_qty) },
    { key: 'pending_qty', label: 'Pending', align: 'right', sortValue: r => r._gang ? sum(r._gang, 'pending_qty') : r.pending_qty,
      render: r => r._gang
        ? <GangCellParts members={r._gang} align="right" tone={r.run_kind === 'merge' ? 'teal' : 'violet'} total={fmt.num(sum(r._gang, 'pending_qty'))} render={m => <span className="font-semibold text-slate-900">{fmt.num(m.pending_qty)}</span>} />
        : <span className="font-semibold text-slate-900">{fmt.num(r.pending_qty)}</span> },
    { key: 'stages', label: 'Stages', sortable: false,
      export: r => perMember(r, stageText, ' | '),
      render: r => r._gang ? <GangCellParts members={r._gang} tone={r.run_kind === 'merge' ? 'teal' : 'violet'} render={StagesCell} /> : StagesCell(r) },
    { key: 'printed', label: 'Printed', sortable: false,
      export: r => perMember(r, m => (printedResolved(m) ? 'Yes' : 'No')),
      render: r => r._gang ? <GangCellParts members={r._gang} render={PrintedCell} /> : PrintedCell(r) },
    { key: 'delivery_date', label: 'EDD',
      export: r => (r._gang ? [...new Set(r._gang.map(m => fmt.date(m.delivery_date)))].join(' · ') : fmt.date(r.delivery_date)),
      render: r => !r._gang ? EddCell(r) : (oneOrder(r._gang) ? EddCell(r._gang[0]) : <GangCellParts members={r._gang} render={EddCell} />) },
    { key: 'wip', label: 'WIP', sortable: false,
      export: r => perMember(r, m => (m.wip ? 'Yes' : 'No')),
      render: r => r._gang ? <GangCellParts members={r._gang} render={WipCell} /> : WipCell(r) },
    { key: 'is_p1', label: 'P1', align: 'right',
      export: r => perMember(r, m => (m.is_p1 ? 'P1' : '—')),
      render: r => r._gang ? <GangCellParts members={r._gang} align="right" render={P1Cell} /> : P1Cell(r) },
    threadColumn({ entity: 'order_line', threads, idOf: threadLineId }),
  ];

  return (
    <div>
      <PageHeader title="Status Sheet"
        subtitle="Live pending-order status — supply progress, delivery dates, customer WIP and priority in one editable sheet" />
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
      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the status sheet can’t load'}. Retrying every 20 seconds…
        </div>
      )}
      <div className="my-3 flex justify-end">
        <SearchInput value={q} onChange={setQ} placeholder="Search order, company, product…" />
      </div>
      <DataTable
        columns={columns}
        rows={displayRows}
        getRowId={r => r.line_id}
        rowClass={unreadRowClass(threads, threadLineId)}
        groupBy={r => (r._gang ? `gang-${r.gang_run_id}` : null)}
        groupTone={r => (r.run_kind === 'merge' ? 'teal' : 'violet')}
        defaultSort={{ key: 'delivery_date', dir: 'asc' }}
        exportName="Status Sheet"
        exportSubtitle="Pending order status"
        empty={loadError ? 'Server unreachable — nothing to show until it reconnects.' : 'No pending orders — everything is dispatched or closed.'}
      />
    </div>
  );
}
