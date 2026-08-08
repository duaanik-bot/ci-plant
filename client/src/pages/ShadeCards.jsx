// Shade Cards — the register, and now the module's whole navigation. Seven
// tabs walk the real process left to right (make → send → wait → issue →
// floor) plus two reference views; the eight dashboard tiles below them stay
// a global counter that filters the Register tab specifically. Alerts stay a
// banner, not a separate sub-view: an alarm is one click from the rows
// causing it.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import {
  Button, KpiCard, PageHeader, rowMatches, DataTable, SubTabs, useToast,
} from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import {
  Plus, SwatchBook, Send, BadgeCheck, AlertTriangle, Printer, FileClock,
  Clock4, PackageCheck, Archive, ArrowRight, Search,
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
    // age_unknown belongs here too: a card nobody can date escapes the 365-day
    // rule entirely, which is an age problem even though it has no age.
    filter: r => r.expired_by_age || r.age_unknown || (r.age_days != null && r.age_days >= 335) },
];

// The tab row IS the module's navigation. Four of these render the register
// table over a different row set; three open their own view (`own: true`).
// Keeping the predicate, the count and the empty line in one place is what
// stops a tab whose number disagrees with the list beneath it. Left to right
// is the real process: make → send → wait → issue → floor, then the two
// reference views.
const VIEWS = [
  { key: 'register',      label: 'Register',      icon: SwatchBook,
    rows: rs => rs,
    empty: 'No shade cards yet — create one from a sales order' },
  { key: 'to_send',       label: 'To Send',        icon: Send,
    rows: rs => rs.filter(r => r.status === 'draft'),
    empty: 'Nothing waiting to go to a customer' },
  { key: 'with_customer', label: 'With Customer',  icon: Clock4,
    rows: rs => rs.filter(r => r.status === 'sent'),
    empty: 'No card is sitting with a customer' },
  // Its own priority-banded worklist, not a register filter — "which of these
  // is most urgent" is the whole point and a flat table cannot say it. Still
  // carries a `rows` predicate so its tab badge comes from the same place as
  // ToIssue.jsx's own filter, and can never disagree with it.
  { key: 'to_issue',      label: 'To Issue',       icon: Printer, own: true,
    rows: rs => rs.filter(r => r.to_issue) },
  { key: 'floor_waiting', label: 'Floor Waiting',  icon: AlertTriangle,
    rows: rs => rs.filter(r => r.to_issue && r.work_tier === 1),
    empty: 'No press is waiting on a shade card' },
  { key: 'reports',       label: 'Reports',        icon: FileClock, own: true },
  { key: 'retired',       label: 'Retired Numbers', icon: Archive,  own: true },
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
  // Every surface that shows a shade card links here as /shade-cards?q=CI1482 —
  // the Product Master, Planning, Artwork and the Job Card. Without reading the
  // param those links all landed on an unfiltered 600-row register and the user
  // had to retype the number they just clicked, which makes a link feel broken.
  const [deepLink, setDeepLink] = useState(
    () => new URLSearchParams(window.location.search).get('q')?.trim() || '');
  const [deepLinkOpened, setDeepLinkOpened] = useState(false);

  // A dead backend must never read as "no shade cards" — the page owns showing
  // the outage, and last-good rows survive a transient blip.
  const load = () => Promise.all([
    api.get('/shade-cards?all=1').then(rs => {
      setRows(rs);
      threadSummary('shade_card', rs.map(r => r.id)).then(setThreads).catch(() => {});
    }),
    api.get('/shade-cards/alerts').then(setAlerts),
  ]).then(() => setLoadError(false)).catch(() => setLoadError(true));

  useFallbackRefresh(load, { intervalMs: 60000 });
  useEffect(() => {
    api.get('/shade-cards/meta').then(setMeta).catch(() => {});
  }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });
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
  const viewDef = VIEWS.find(v => v.key === view) || VIEWS[0];
  // One count per tab, from the same `active` rows the tiles use — the badge
  // and the rows it opens read the same predicate, so they cannot disagree.
  // reports/retired have no `rows` predicate (their content isn't a slice of
  // the register at all) so they carry no badge rather than a fabricated one.
  const viewCounts = useMemo(() => {
    const out = {};
    for (const v of VIEWS) if (v.rows) out[v.key] = v.rows(active).length;
    return out;
  }, [active]);
  // Register is the only table-backed view a tile may narrow further — the
  // other three (to_send / with_customer / floor_waiting) are already a
  // filter, so stacking a tile on top would be a hidden second condition,
  // exactly what naming the tabs after the process exists to avoid.
  const visible = useMemo(() => {
    const base = view === 'register'
      ? active.filter(tileDef.filter || (() => true))
      : (viewDef.rows ? viewDef.rows(active) : []);
    // The deep link narrows whatever tab is open rather than forcing Register,
    // so arriving from a link and then switching tabs keeps the card in view.
    return deepLink ? base.filter(r => rowMatches(r, deepLink)) : base;
  }, [active, tileDef, view, viewDef, deepLink]);

  // Land straight on the card when the link identifies exactly one. Clicking a
  // shade card number elsewhere in the ERP means "show me THAT card", not "here
  // is a list containing it". Only fires once, so closing the drawer does not
  // immediately reopen it.
  useEffect(() => {
    if (!deepLink || deepLinkOpened || !rows.length) return;
    const hit = active.filter(r => rowMatches(r, deepLink));
    if (hit.length === 1) setDetailId(hit[0].id);
    setDeepLinkOpened(true);
  }, [deepLink, deepLinkOpened, rows, active]);

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
    // An undatable card reads "no date", not "—". A dash says "nothing here";
    // this card has something wrong with it — it escapes the 365-day rule
    // altogether — and the register has to say so rather than look blank.
    { key: 'age_days', label: 'Age', align: 'right', sortValue: r => r.age_days ?? -1,
      render: r => r.age_unknown
        ? <span className="whitespace-nowrap font-semibold text-amber-600" title="No date on record — this card's age cannot be checked against the 365-day life">no date</span>
        : r.age_days == null ? '—'
        : <span className={`font-semibold tabular-nums ${r.expired_by_age ? 'text-red-600' : r.age_days >= 335 ? 'text-amber-600' : 'text-slate-600'}`}>{r.age_days}d</span>,
      export: r => r.age_unknown ? 'no date' : r.age_days != null ? `${r.age_days}d` : '—' },
    { key: 'updated_at', label: 'Updated', render: r => fmt.dt(r.updated_at) },
  ];

  // Floor Waiting's one extra fact: which press is waiting and which job card
  // it is waiting for. Without this it is just a shorter register — with it,
  // it is an instruction. Every row here is work_tier === 1, so both columns
  // are populated for the whole view, never a hedge column that's mostly "—".
  const floorColumns = [
    columns[0],
    { key: 'work_press_name', label: 'Press', sortValue: r => r.work_press_name || '',
      render: r => r.work_press_name
        ? <span className="whitespace-nowrap text-xs font-bold text-red-700">
            {r.work_press_name}
            {r.work_queue_pos != null && <span className="ml-1 font-medium text-slate-400">#{r.work_queue_pos}</span>}
          </span>
        : <span className="text-xs text-slate-400">—</span>,
      export: r => r.work_press_name ? `${r.work_press_name}${r.work_queue_pos != null ? ` #${r.work_queue_pos}` : ''}` : '—' },
    { key: 'work_jc_number', label: 'Job Card',
      render: r => r.work_jc_number
        ? <span className="whitespace-nowrap text-xs font-semibold text-slate-700">{r.work_jc_number}</span>
        : <span className="text-slate-300">—</span>,
      export: r => r.work_jc_number || '—' },
    ...columns.slice(1),
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
          Couldn't reach the server — {rows.length ? 'showing the last data loaded' : 'the shade cards can’t load'}. Retrying every minute…
        </div>
      )}

      {/* The dashboard. Each tile filters the table below it. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        {/* This strip filtered its table before KpiCard could do it itself, via
            a wrapper <button> and its own ring. Now it uses the shared onClick /
            active props, so a selected shade tile looks like a selected card
            anywhere else in the ERP instead of a lookalike. */}
        {TILES.map(t => (
          <KpiCard key={t.key} label={t.label} value={fmt.num(counts[t.key])} icon={t.icon}
            chip={t.chip} accent={counts[t.key] ? undefined : 'text-slate-400'}
            onClick={t.filter ? () => { setTile(t.key); setView(t.view || 'register'); } : undefined}
            active={!!t.filter && (t.view ? view === t.view : tile === t.key && view === 'register')} />))}
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
        <SubTabs active={view} onChange={setView}
          views={VIEWS.map(v => ({ key: v.key, label: v.label, icon: v.icon, count: viewCounts[v.key] }))} />
        {view === 'register' && tile !== 'all' && (
          <button className="text-xs font-semibold text-brand-600 underline underline-offset-2"
            onClick={() => setTile('all')}>Showing {tileDef.label} — clear filter</button>)}
      </div>

      {/* Arrived from a shade card link elsewhere in the ERP. Say so plainly and
          make it one click to get back to the full list — a filter the user
          cannot see is a filter they will think is a bug. */}
      {deepLink && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-brand-200 bg-brand-50/70 px-4 py-2.5 text-sm">
          <Search size={14} className="shrink-0 text-brand-600" />
          <span className="font-semibold text-brand-800">
            Showing shade cards matching “{deepLink}”
          </span>
          <span className="text-xs font-medium text-brand-700/70">
            {visible.length === 0 ? 'nothing matched' : `${fmt.num(visible.length)} match${visible.length === 1 ? '' : 'es'}`}
          </span>
          <button className="ml-auto text-xs font-bold text-brand-700 underline underline-offset-2"
            onClick={() => {
              setDeepLink('');
              // Drop the param too, so a refresh does not silently re-filter.
              window.history.replaceState({}, '', window.location.pathname);
            }}>Show all shade cards</button>
        </div>)}

      {!viewDef.own && (
        <DataTable
          // Remounts the table fresh on every tab switch, so a search or sort
          // left over from one tab can never silently narrow the next one —
          // that would make the tab's own count disagree with what's on screen.
          key={view}
          exportName={`shade-cards-${viewDef.key}`} exportSubtitle="Shade Card register"
          exportMeta={() => view === 'register' ? [`Filter: ${tileDef.label}`] : [`View: ${viewDef.label}`]}
          rows={visible}
          columns={[...(view === 'floor_waiting' ? floorColumns : columns),
            threadColumn({ entity: 'shade_card', threads, idOf: r => r.id })]}
          rowClass={unreadRowClass(threads, r => r.id)}
          getRowId={r => r.id}
          searchable
          onRowClick={r => setDetailId(r.id)}
          defaultSort={{ key: 'updated_at', dir: 'desc' }}
          empty={view === 'register' && tile !== 'all'
            ? `No shade cards match "${tileDef.label}" — clear the filter to see everything`
            : viewDef.empty}
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
