// Shade Cards — the register. Eight dashboard tiles, each of which IS a filter,
// over one table. The 6 tabs and the separate Alerts sub-view are gone: an
// alarm is now one click from the rows causing it.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import {
  Button, KpiCard, PageHeader, rowMatches, DataTable, SubTabs, useToast,
} from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import {
  Plus, SwatchBook, Send, BadgeCheck, AlertTriangle, Printer, FileClock,
  Clock4, PackageCheck, Archive, ArrowRight,
} from 'lucide-react';
import { STATUS_META, scLabel, today } from './shade-cards/lifecycle.js';
import ShadeCardDrawer from './shade-cards/ShadeCardDrawer.jsx';
import ShadeCardForm from './shade-cards/ShadeCardForm.jsx';
import RetireZone from './shade-cards/RetireZone.jsx';
import ToIssue from './shade-cards/ToIssue.jsx';

const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

const canManage = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);

function ScStatus({ status }) {
  const m = STATUS_META[status] || { label: '—', cls: 'bg-slate-100 text-slate-600' };
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />{m.label}
    </span>
  );
}

// The eight tiles, in the order the plant reads them. `filter` is what makes a
// tile a control rather than a decoration; a null filter is a pure counter.
const TILES = [
  { key: 'all',       label: 'Total',            icon: SwatchBook,   filter: () => true },
  { key: 'pending',   label: 'Pending Approval',  icon: Send,         chip: 'bg-violet-50 text-violet-600',
    filter: r => r.status === 'sent' },
  { key: 'approved',  label: 'Approved',          icon: BadgeCheck,   chip: 'bg-emerald-50 text-emerald-600',
    filter: r => r.status === 'approved' && !r.expired_by_age },
  // Not a register filter — it opens its own priority-banded worklist, because
  // "which of these is most urgent" is the whole point and a flat table cannot
  // say it. `view` sends the click there instead of filtering in place.
  { key: 'to_issue',  label: 'To Issue',          icon: Printer,      chip: 'bg-red-50 text-red-600',
    view: 'to_issue', filter: r => r.to_issue },
  { key: 'issues',    label: 'Issued to Printing', icon: Printer,     chip: 'bg-blue-50 text-blue-600',
    filter: null },
  { key: 'with',      label: 'With Printing',     icon: Printer,      chip: 'bg-blue-50 text-blue-600',
    filter: r => r.with_printing },
  { key: 'returned',  label: 'Returned',          icon: PackageCheck, chip: 'bg-teal-50 text-teal-600',
    filter: r => !r.with_printing && r.issue_count > 0 },
  { key: 'overdue',   label: 'Overdue',           icon: Clock4,       chip: 'bg-red-50 text-red-600',
    filter: r => r.status === 'sent' && r.expected_approval_date && r.expected_approval_date < today() },
  { key: 'aged',      label: 'Age Alerts',        icon: FileClock,    chip: 'bg-orange-50 text-orange-600',
    filter: r => r.expired_by_age || (r.age_days != null && r.age_days >= 335) },
];

export default function ShadeCards() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [meta, setMeta] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState(null);
  const [view, setView] = useState('register');
  const [tile, setTile] = useState('all');
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [threads, setThreads] = useState({});

  // A dead backend must never read as "no shade cards" — the page owns showing
  // the outage, and last-good rows survive a transient blip.
  const load = () => Promise.all([
    api.get('/shade-cards?all=1').then(rs => {
      setRows(rs);
      threadSummary('shade_card', rs.map(r => r.id)).then(setThreads).catch(() => {});
    }),
    api.get('/shade-cards/alerts').then(setAlerts),
  ]).then(() => setLoadError(false)).catch(() => setLoadError(true));

  useEffect(() => {
    load();
    api.get('/shade-cards/meta').then(setMeta).catch(() => {});
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (view === 'reports') api.get('/shade-cards/reports').then(setReports).catch(() => {});
  }, [view, rows]);

  const active = useMemo(() => rows.filter(r => r.active), [rows]);
  const counts = useMemo(() => {
    const out = {};
    for (const t of TILES) {
      out[t.key] = t.key === 'issues'
        ? active.reduce((n, r) => n + (r.issue_count || 0), 0)
        : active.filter(t.filter).length;
    }
    return out;
  }, [active]);

  const tileDef = TILES.find(t => t.key === tile) || TILES[0];
  const visible = useMemo(
    () => active.filter(tileDef.filter || (() => true)),
    [active, tileDef]);

  const critical = alerts.filter(a => a.severity === 'critical');

  const columns = [
    { key: 'sc_number', label: 'Card No', render: r => (
        <span className="font-semibold text-slate-900">{r.sc_number}</span>),
      searchValue: r => r.sc_number },
    { key: 'po_number', label: 'Sales Order', render: r => r.po_number
        ? <span className="font-medium text-brand-600">{r.po_number}</span>
        : <span className="text-slate-300">—</span>,
      searchValue: r => `${r.po_number || ''} ${(r.orders || []).map(o => o.po_number).join(' ')}` },
    { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
    { key: 'product_name', label: 'Product', render: r => (
        <span>{r.product_name || '—'}{r.product_code && <span className="ml-1 text-slate-400">{r.product_code}</span>}</span>),
      export: r => `${r.product_name || ''} ${r.product_code || ''}`.trim() || '—' },
    { key: 'artwork_no', label: 'AW / Output', render: r => (
        <span className={`whitespace-nowrap text-xs ${r.code_ok ? '' : 'font-bold text-red-600'}`}>
          {r.artwork_no || '—'}<span className="text-slate-300"> / </span>{r.output_no || '—'}
          {!r.code_ok && <AlertTriangle size={11} className="ml-1 inline" />}
        </span>),
      export: r => `${r.artwork_no || '—'} / ${r.output_no || '—'}`,
      searchValue: r => `${r.artwork_no || ''} ${r.output_no || ''}` },
    { key: 'status', label: 'Status', render: r => <ScStatus status={r.status} />,
      export: r => scLabel(r.status), sortValue: r => r.status },
    { key: 'holder', label: 'Held by', sortValue: r => r.issued_to || '',
      render: r => r.with_printing
        ? <span className="whitespace-nowrap text-xs font-semibold text-blue-700">
            {r.issued_to} <span className="font-normal text-slate-400">· {fmt.title(r.department)}</span></span>
        : <span className="text-xs text-slate-400">In store</span>,
      export: r => r.with_printing ? `${r.issued_to} (${r.department})` : 'In store',
      searchValue: r => r.with_printing ? `${r.issued_to} ${r.department}` : 'in store' },
    { key: 'sent_to_customer_date', label: 'Sent → Approved',
      sortValue: r => r.sent_to_customer_date || '',
      render: r => (
        <span className="whitespace-nowrap text-xs">
          {r.sent_to_customer_date ? fmt.date(r.sent_to_customer_date) : '—'}
          <ArrowRight size={11} className="mx-1 inline text-slate-300" />
          {r.approval_received_date
            ? <span className="font-semibold text-emerald-700">{fmt.date(r.approval_received_date)}</span>
            : r.expected_approval_date
              ? <span className={r.expected_approval_date < today() ? 'font-semibold text-red-600' : 'text-slate-500'}>
                  exp. {fmt.date(r.expected_approval_date)}</span>
              : '—'}
        </span>),
      export: r => `${r.sent_to_customer_date || '—'} → ${r.approval_received_date || '—'}` },
    { key: 'age_days', label: 'Age', align: 'right', sortValue: r => r.age_days ?? -1,
      render: r => r.age_days == null ? '—'
        : <span className={`font-semibold tabular-nums ${r.expired_by_age ? 'text-red-600' : r.age_days >= 335 ? 'text-amber-600' : 'text-slate-600'}`}>{r.age_days}d</span>,
      export: r => r.age_days != null ? `${r.age_days}d` : '—' },
    { key: 'updated_at', label: 'Updated', render: r => fmt.dt(r.updated_at) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title="Shade Cards"
        subtitle="Create · send to the customer · approve · issue to printing · return"
        actions={canManage() && (
          <Button onClick={() => setCreating(true)}><Plus size={14} /> New Shade Card</Button>)} />

      {loadError && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the shade cards can’t load'}. Retrying every 20 seconds…
        </div>
      )}

      {/* The dashboard. Each tile filters the table below it. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {TILES.map(t => (
          <button key={t.key} onClick={() => { setTile(t.key); setView(t.view || 'register'); }}
            disabled={!t.filter}
            className={`text-left transition ${t.filter ? 'cursor-pointer' : 'cursor-default'} ${
              (t.view ? view === t.view : tile === t.key && view === 'register') && t.filter
                ? 'ring-2 ring-brand-400 ring-offset-2 rounded-[22px]' : ''}`}>
            <KpiCard label={t.label} value={fmt.num(counts[t.key])} icon={t.icon}
              chip={t.chip} accent={counts[t.key] ? undefined : 'text-slate-400'} />
          </button>))}
      </div>

      {critical.length > 0 && (
        <div className="glass rounded-[22px] border border-red-200/60 bg-red-50/60 p-4">
          <p className="mb-1.5 flex items-center gap-2 text-sm font-extrabold text-red-700">
            <AlertTriangle size={15} /> {critical.length} shade card{critical.length > 1 ? 's' : ''} need attention now
          </p>
          <ul className="space-y-1">
            {critical.slice(0, 5).map((a, i) => (
              <li key={i} className="text-xs font-medium text-red-700/90">
                <button className="underline decoration-red-300 underline-offset-2"
                  onClick={() => setDetailId(a.id)}>{a.message}</button>
              </li>))}
            {critical.length > 5 && <li className="text-xs text-red-500">…and {critical.length - 5} more</li>}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SubTabs active={view} onChange={setView} views={[
          { key: 'register', label: 'Register', icon: SwatchBook },
          { key: 'to_issue', label: 'To Issue', icon: Printer, count: counts.to_issue },
          { key: 'reports', label: 'Reports', icon: FileClock },
          { key: 'retired', label: 'Retired Numbers', icon: Archive },
        ]} />
        {view === 'register' && tile !== 'all' && (
          <button className="text-xs font-semibold text-brand-600 underline underline-offset-2"
            onClick={() => setTile('all')}>Showing {tileDef.label} — clear filter</button>)}
      </div>

      {view === 'register' && (
        <DataTable
          exportName="shade-cards" exportSubtitle="Shade Card register"
          exportMeta={() => [`Filter: ${tileDef.label}`]}
          rows={visible}
          columns={[...columns, threadColumn({ entity: 'shade_card', threads, idOf: r => r.id })]}
          rowClass={unreadRowClass(threads, r => r.id)}
          getRowId={r => r.id}
          searchable
          onRowClick={r => setDetailId(r.id)}
          defaultSort={{ key: 'updated_at', dir: 'desc' }}
          empty="No shade cards here — create one or clear the filter"
        />
      )}

      {view === 'to_issue' && <ToIssue rows={active} onOpen={setDetailId} />}
      {view === 'reports' && <Reports reports={reports} />}
      {view === 'retired' && <RetireZone onChange={load} toast={toast} />}

      {creating && (
        <ShadeCardForm meta={meta} onClose={() => setCreating(false)} toast={toast}
          onCreated={async id => { setCreating(false); await load(); setDetailId(id); }} />)}

      {detailId && (
        <ShadeCardDrawer id={detailId} meta={meta} toast={toast}
          onClose={() => setDetailId(null)} onChange={load} />)}
    </div>
  );
}

function Reports({ reports }) {
  if (!reports) return <p className="text-sm text-slate-400">Loading reports…</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Avg approval turnaround"
          value={reports.kpis.avg_tat_days != null ? `${reports.kpis.avg_tat_days}d` : '—'} icon={Clock4} />
        <KpiCard label="Overdue approvals" value={fmt.num(reports.kpis.overdue)} icon={AlertTriangle}
          chip="bg-red-50 text-red-600" accent={reports.kpis.overdue ? 'text-red-600' : undefined} />
        <KpiCard label="With printing" value={fmt.num(reports.kpis.with_printing)} icon={Printer}
          chip="bg-blue-50 text-blue-600" />
        <KpiCard label="Expired" value={fmt.num(reports.kpis.expired)} icon={FileClock}
          chip="bg-orange-50 text-orange-600" accent={reports.kpis.expired ? 'text-orange-600' : undefined} />
      </div>
      <DataTable exportName="shade-card-tat-by-customer"
        exportSubtitle="Customer-wise approval performance"
        rows={reports.tat_by_customer} serialNumber
        columns={[
          { key: 'customer', label: 'Customer' },
          { key: 'approvals', label: 'Approvals', align: 'right' },
          { key: 'avg_days', label: 'Avg turnaround (days)', align: 'right',
            render: r => <span className={`font-bold ${r.avg_days > 14 ? 'text-red-600' : r.avg_days > 7 ? 'text-amber-600' : 'text-emerald-700'}`}>{r.avg_days}</span> },
        ]}
        empty="No completed approval cycles yet" />
      <DataTable exportName="shade-cards-awaiting-production"
        exportSubtitle="Approved cards whose jobs have not reached the floor"
        rows={reports.awaiting_production}
        columns={[
          { key: 'sc_number', label: 'Shade Card' },
          { key: 'customer_name', label: 'Customer', render: r => r.customer_name || '—' },
          { key: 'product_name', label: 'Product', render: r => r.product_name || '—' },
          { key: 'approval_received_date', label: 'Approved on', render: r => fmt.date(r.approval_received_date) },
        ]}
        empty="Nothing approved is waiting on production" />
    </div>
  );
}
