// Status Sheet › Reports — company-wise / PO-wise / product-wise roll-ups of
// EVERY order line, owed or delivered, with filters, a remembered report
// setting and Excel/PDF export of exactly what is on screen.
//
// The live sheet beside this tab is the planner's working surface (pending
// lines only, editable). This tab is read-only and answers the questions the
// sheet cannot: "what is Fluence still owed in total", "what did we deliver
// against PO 021", "which products are pending across all companies".
//
// All decisions (delivery buckets, pending qty, grouping, export shape) live
// in lib/statusReport.js and are tested in server/src/status-report.test.js.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { storage } from '../lib/safeStorage.js';
import {
  DELIVERY, DELIVERY_LABEL, OPEN_KEYS, VIEWS,
  enrichLine, filterLines, totalsOf, groupLines, buildReportExportSpec, sumRows, whereMix, whereOrder, drawerCtx,
} from '../lib/statusReport.js';
import { SECTION_ORDER } from '../sections.js';
import { NameLink, Pill, WhereChip, whereLabel } from '../components/StatusReportBits.jsx';
import StatusReportDrawer from '../components/StatusReportDrawer.jsx';
import { DataTable, Input, KpiCard, SubTabs, rowMatches } from '../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../components/FilterChip.jsx';
import { AlertTriangle, Building2, FileText, Package, Rows3, RotateCcw } from 'lucide-react';

// The report setting is remembered per browser, so whoever opens this tab gets
// back the report they last asked for.
export const PREFS_KEY = 'ci_status_report_prefs';
const DEFAULT_PREFS = { view: 'company', delivery: OPEN_KEYS, customers: [], stages: [], from: '', to: '' };
function readPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(storage.getItem(PREFS_KEY) || '{}') }; }
  catch { return DEFAULT_PREFS; }
}

// One-click report settings. Each is just a saved combination of view + filters.
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const QUICK = [
  { key: 'pending_company', label: 'Pending by company', set: { view: 'company', delivery: OPEN_KEYS, customers: [], stages: [], from: '', to: '' } },
  { key: 'pending_po', label: 'Pending POs', set: { view: 'po', delivery: OPEN_KEYS, stages: [], from: '', to: '' } },
  { key: 'pending_product', label: 'Pending products', set: { view: 'product', delivery: OPEN_KEYS, stages: [], from: '', to: '' } },
  { key: 'delivered_po', label: 'Delivered POs', set: { view: 'po', delivery: ['delivered'], stages: [], from: '', to: '' } },
  { key: 'month', label: 'This month — everything', set: () => ({ view: 'po', delivery: [], stages: [], from: firstOfMonth(), to: '' }) },
  { key: 'all', label: 'Whole book', set: { view: 'company', delivery: [], customers: [], stages: [], from: '', to: '' } },
];

const VIEW_ICON = { company: Building2, po: FileText, product: Package, lines: Rows3 };

// One line → one chip. A PO / product / company → its lines counted by stage.
const stageCol = view => (view === 'lines'
  ? { key: 'where', label: 'Stage', card: 'face', sortValue: r => whereOrder(SECTION_ORDER).indexOf(r.where),
      render: r => <WhereChip k={r.where} />, export: r => whereLabel(r.where) }
  : { key: 'where_counts', label: 'Stage', sortable: false, card: 'face',
      render: r => (
        <div className="flex min-w-[150px] max-w-[320px] flex-wrap gap-1">
          {whereMix(r.where_counts, SECTION_ORDER).map(m => <WhereChip key={m.key} k={m.key} count={m.count} />)}
        </div>
      ),
      export: r => whereMix(r.where_counts, SECTION_ORDER).map(m => `${whereLabel(m.key)} ${m.count}`).join(', ') });

const numCell = (key, { strong, tone } = {}) => ({
  key, align: 'right',
  render: r => <span className={`tabular-nums ${strong ? 'font-semibold' : ''} ${tone ? tone(r) : ''}`}>{fmt.num(r[key])}</span>,
  export: r => r[key] ?? 0,
});
const money = (key, label, strong) => ({
  key, label, align: 'right',
  render: r => <span className={`tabular-nums ${strong ? 'font-bold text-[#1D1D1F]' : 'text-gray-600'}`}>{fmt.inr(r[key])}</span>,
  export: r => Math.round(r[key] || 0),
});
const dateCol = (key, label) => ({
  key, label, render: r => <span className="whitespace-nowrap text-xs text-gray-600">{fmt.date(r[key])}</span>,
  export: r => (r[key] ? fmt.date(r[key]) : ''),
});
const pct = {
  key: 'fulfil_pct', label: 'Delivered %', align: 'right',
  render: r => (
    <div className="flex min-w-[84px] items-center justify-end gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${r.fulfil_pct >= 100 ? 'bg-emerald-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, r.fulfil_pct)}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-gray-600">{r.fulfil_pct}%</span>
    </div>
  ),
  export: r => `${r.fulfil_pct}%`,
};
const pendingQty = { ...numCell('pending_qty', { strong: true, tone: r => (r.pending_qty > 0 ? 'text-amber-700' : 'text-gray-400') }), label: 'Pending' };
// Names open the details drawer (StatusReportDrawer). `open(kind, row)` is
// supplied by the page; export still writes the plain name.
const companyCol = open => ({
  key: 'customer_name', label: 'Company',
  render: r => <NameLink onOpen={() => open('company', r)} title="Orders, deliveries and production for this company">{r.customer_name}</NameLink>,
  export: r => r.customer_name,
});
const poCol = open => ({
  key: 'po_number', label: 'PO no.',
  render: r => <NameLink onOpen={() => open('po', r)} title="Lines, deliveries and production for this PO" className="tabular-nums">{r.po_number}</NameLink>,
  export: r => r.po_number,
});
// Phone / upright-tablet cards pick their status chip by key name, and
// `delivery` / `where*` don't look like one — without explicit roles both
// columns fell behind "Details" and the card never said where a job was.
const status = { key: 'delivery', label: 'Status', card: 'status', render: r => <Pill k={r.delivery} />, export: r => DELIVERY_LABEL[r.delivery] || r.delivery };
const productCol = (open, kind) => ({
  key: 'product_name', label: 'Product',
  render: r => (
    <div className="min-w-[180px]">
      <NameLink onOpen={() => open(kind, r)} title={kind === 'line' ? 'Details of this order line' : 'Every PO, delivery and job card for this product'}>{r.product_name}</NameLink>
      <div className="text-[11px] text-gray-500">{[r.product_code, r.party_item_code].filter(Boolean).join(' · ')}</div>
    </div>
  ),
  export: r => r.product_name,
});

function columnsFor(view, open) {
  const company = companyCol(open);
  if (view === 'company') return [
    company,
    { ...numCell('orders'), label: 'Orders' },
    { ...numCell('lines'), label: 'Lines' },
    { ...numCell('open_lines', { tone: r => (r.open_lines ? 'text-amber-700' : 'text-gray-400') }), label: 'Open lines' },
    stageCol(view),
    { ...numCell('qty'), label: 'Ordered' },
    { ...numCell('dispatched_qty'), label: 'Delivered' },
    pendingQty,
    pct,
    money('pending_value', 'Pending value', true),
    dateCol('oldest_open_po', 'Oldest open PO'),
    dateCol('last_dispatched_at', 'Last dispatch'),
  ];
  if (view === 'po') return [
    company,
    poCol(open),
    dateCol('po_date', 'PO date'),
    dateCol('delivery_date', 'EDD'),
    status,
    stageCol(view),
    { ...numCell('lines'), label: 'Lines' },
    { ...numCell('qty'), label: 'Ordered' },
    { ...numCell('dispatched_qty'), label: 'Delivered' },
    pendingQty,
    pct,
    money('value', 'PO value'),
    money('pending_value', 'Pending value', true),
    dateCol('last_dispatched_at', 'Last dispatch'),
  ];
  if (view === 'product') return [
    company,
    productCol(open, 'product'),
    { key: 'party_artwork_code', label: 'Artwork code', render: r => <span className="text-xs text-gray-600">{r.party_artwork_code || '—'}</span>, export: r => r.party_artwork_code || '' },
    { ...numCell('orders'), label: 'POs' },
    status,
    stageCol(view),
    { ...numCell('qty'), label: 'Ordered' },
    { ...numCell('dispatched_qty'), label: 'Delivered' },
    pendingQty,
    money('pending_value', 'Pending value', true),
    dateCol('last_dispatched_at', 'Last dispatch'),
  ];
  return [
    company,
    poCol(open),
    dateCol('po_date', 'PO date'),
    productCol(open, 'line'),
    { ...numCell('qty'), label: 'Ordered' },
    { ...numCell('dispatched_qty'), label: 'Delivered' },
    pendingQty,
    { key: 'rate', label: 'Rate', align: 'right', render: r => <span className="tabular-nums text-gray-600">{fmt.inr2 ? fmt.inr2(r.rate) : `₹${(+r.rate || 0).toFixed(2)}`}</span>, export: r => +r.rate || 0 },
    money('pending_value', 'Pending value', true),
    status,
    stageCol(view),
    dateCol('last_dispatched_at', 'Last dispatch'),
    { key: 'challans', label: 'Challans', render: r => <span className="text-xs text-gray-600">{r.challans || '—'}</span>, export: r => r.challans || '' },
    { key: 'line_remark', label: 'Remark', render: r => <span className="text-xs text-gray-600">{r.line_remark || r.remarks || ''}</span>, export: r => r.line_remark || r.remarks || '' },
  ];
}

export default function StatusReports() {
  const [lines, setLines] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [prefs, setPrefs] = useState(readPrefs);
  const [q, setQ] = useState('');
  const { view, delivery, customers, stages = [], from, to } = prefs;
  const set = patch => setPrefs(p => ({ ...p, ...(typeof patch === 'function' ? patch(p) : patch) }));
  useEffect(() => { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);

  // Its own mount load as well as the fallback poll: the poll is gated on a
  // visible tab, and a report that opens empty reads as "no orders".
  const load = () => api.get('/status-sheet/report')
    .then(d => { setLines((d.lines || []).map(enrichLine)); setLoadError(false); })
    .catch(() => setLoadError(true));
  useEffect(() => { load(); }, []);
  useFallbackRefresh(load, { intervalMs: 120000, loadOnMount: false });

  const all = lines || [];
  // Company chips count lines inside the OTHER filters, so a chip never
  // promises rows it cannot show.
  const beforeCompany = useMemo(() => filterLines(all, { delivery, stages, from, to }), [all, delivery, stages, from, to]);
  const companyChips = useMemo(() => {
    const m = new Map();
    for (const l of beforeCompany) {
      const c = m.get(l.customer_id) || { id: l.customer_id, name: l.customer_name, n: 0 };
      c.n += 1; m.set(l.customer_id, c);
    }
    // Selected companies stay on the rail even when a filter empties them.
    for (const id of customers) {
      if (!m.has(id)) {
        const any = all.find(l => String(l.customer_id) === String(id));
        if (any) m.set(id, { id, name: any.customer_name, n: 0 });
      }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
  }, [beforeCompany, customers, all]);
  const deliveryCounts = useMemo(() => {
    const base = filterLines(all, { customers, stages, from, to });
    const c = Object.fromEntries(DELIVERY.map(d => [d.key, 0]));
    for (const l of base) c[l.delivery] += 1;
    return c;
  }, [all, customers, stages, from, to]);
  // "Where it is" chips: counted inside every other filter, in plant order.
  // Delivered / cancelled are left off the rail — the Status chips own those.
  const whereChips = useMemo(() => {
    const base = filterLines(all, { customers, delivery, from, to });
    const c = {};
    for (const l of base) c[l.where] = (c[l.where] || 0) + 1;
    return whereOrder(SECTION_ORDER, Object.keys(c))
      .filter(k => k !== 'delivered' && k !== 'cancelled')
      .filter(k => c[k] || stages.includes(k))
      .map(k => ({ key: k, count: c[k] || 0 }));
  }, [all, customers, delivery, stages, from, to]);

  const filtered = useMemo(() => filterLines(all, { customers, delivery, stages, from, to }), [all, customers, delivery, stages, from, to]);
  const grouped = useMemo(() => groupLines(filtered, view), [filtered, view]);
  const rows = useMemo(() => (q ? grouped.filter(r => rowMatches(r, q)) : grouped), [grouped, q]);
  // KPIs answer for the rows on screen, search included.
  const kpi = useMemo(() => (view === 'lines' ? totalsOf(rows) : totalsOf(
    q ? filtered.filter(l => rows.some(r => rowCovers(r, l, view))) : filtered,
  )), [rows, filtered, q, view]);

  // The details drawer: a trail of clicks, so Back walks company → PO → line.
  const [trail, setTrail] = useState([]);
  const openDrawer = (kind, row) => setTrail([drawerCtx(kind, row)]);
  const columns = useMemo(() => columnsFor(view, openDrawer), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Show in the report" — narrow the table to what the drawer is about.
  const showInReport = ctx => {
    if (ctx.kind === 'company') { set({ view: 'po', customers: [ctx.customer_id] }); setQ(''); }
    else if (ctx.kind === 'po') {
      const l = all.find(x => String(x.order_id) === String(ctx.order_id));
      set({ view: 'lines', customers: l ? [l.customer_id] : [], delivery: [], stages: [] }); setQ(l ? String(l.po_number) : '');
    } else if (ctx.kind === 'product') {
      set({ view: 'lines', customers: [ctx.customer_id], delivery: [], stages: [] }); setQ(ctx.product_name || '');
    }
    setTrail([]);
  };
  const toggle = (key, value) => set(p => {
    const cur = p[key].map(String);
    const v = String(value);
    const next = cur.includes(v) ? p[key].filter(x => String(x) !== v) : [...p[key], value];
    return { [key]: next };
  });
  const applyQuick = qk => { set(typeof qk.set === 'function' ? qk.set() : qk.set); setQ(''); };
  const dirty = JSON.stringify({ ...prefs, view: 'company' }) !== JSON.stringify({ ...DEFAULT_PREFS });

  const custNames = customers.map(id => (all.find(l => String(l.customer_id) === String(id)) || {}).customer_name).filter(Boolean);
  const exportMeta = [
    `Status: ${delivery.length ? delivery.map(k => DELIVERY_LABEL[k]).join(', ') : 'All'}`,
    custNames.length ? `Companies: ${custNames.join(', ')}` : 'Companies: All',
    stages.length ? `Stage: ${stages.map(whereLabel).join(', ')}` : null,
    from || to ? `PO date: ${from ? fmt.date(from) : 'start'} – ${to ? fmt.date(to) : 'today'}` : null,
    q ? `Search: "${q}"` : null,
    'Values are quantity × rate, before GST',
  ];

  return (
    <div>
      {/* The report setting: what to look at, then which slice of the book. */}
      <div className="flex flex-wrap items-center gap-3">
        <SubTabs views={VIEWS.map(v => ({ ...v, icon: VIEW_ICON[v.key] }))} active={view} onChange={k => set({ view: k })} />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Quick reports</span>
          {QUICK.map(qk => (
            <button key={qk.key} type="button" onClick={() => applyQuick(qk)}
              className="rounded-full border border-[#1D1D1F]/10 bg-white px-2.5 py-1 text-xs font-medium text-[#515154] hover:border-[#0071F0]/40 hover:text-[#0064D2]">
              {qk.label}
            </button>
          ))}
        </div>
      </div>

      <FilterRail className="mt-3">
        <FilterGroup label="Status" divider={false}>
          {DELIVERY.map(d => (
            <FilterChip key={d.key} label={d.label} count={deliveryCounts[d.key]} tone={d.tone}
              on={delivery.includes(d.key)} onClick={() => toggle('delivery', d.key)} />
          ))}
        </FilterGroup>
        <FilterGroup label="PO date">
          <div className="flex items-center gap-1.5">
            <Input type="date" value={from} onChange={e => set({ from: e.target.value })} className="!h-8 w-[140px] text-xs" aria-label="PO date from" />
            <span className="text-xs text-gray-400">to</span>
            <Input type="date" value={to} onChange={e => set({ to: e.target.value })} className="!h-8 w-[140px] text-xs" aria-label="PO date to" />
          </div>
        </FilterGroup>
        {dirty && (
          <button type="button" onClick={() => { setPrefs({ ...DEFAULT_PREFS, view }); setQ(''); }}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-[#0064D2] hover:bg-[#E1EFFF]">
            <RotateCcw size={12} /> Reset to pending
          </button>
        )}
      </FilterRail>
      {whereChips.length > 0 && (
        <FilterRail className="mt-2">
          <FilterGroup label="Where it is" divider={false}>
            {whereChips.map(c => (
              <FilterChip key={c.key} label={whereLabel(c.key)} count={c.count}
                on={stages.includes(c.key)} onClick={() => toggle('stages', c.key)} />
            ))}
          </FilterGroup>
        </FilterRail>
      )}
      {companyChips.length > 0 && (
        <FilterRail className="mt-2">
          <FilterGroup label="Company" divider={false}>
            {companyChips.map(c => (
              <FilterChip key={c.id} count={c.n}
                label={<span className="min-w-0 max-w-[11rem] truncate">{c.name}</span>}
                title={`${c.name} — ${c.n} line${c.n === 1 ? '' : 's'}`}
                on={customers.map(String).includes(String(c.id))}
                onClick={() => toggle('customers', c.id)} />
            ))}
          </FilterGroup>
        </FilterRail>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-6">
        <KpiCard label="Companies" value={fmt.num(kpi.customers)} compact />
        <KpiCard label="Orders" value={fmt.num(kpi.orders)} compact />
        <KpiCard label="Ordered qty" value={fmt.num(kpi.qty)} compact />
        <KpiCard label="Delivered qty" value={fmt.num(kpi.dispatched_qty)} accent="text-emerald-700" compact sub={`${kpi.fulfil_pct}% of ordered`} />
        <KpiCard label="Pending qty" value={fmt.num(kpi.pending_qty)} accent="text-amber-700" compact sub={`${fmt.num(kpi.open_lines)} open lines`} />
        <KpiCard label="Pending value" value={fmt.inrShort(kpi.pending_value)} compact sub="before GST" title={fmt.inr(kpi.pending_value)} />
      </div>

      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {lines ? 'showing the last data loaded' : 'the report can’t load'}. Retrying…
        </div>
      )}

      <div className="mt-3">
        <DataTable
          key={view}
          columns={columns}
          rows={rows}
          empty={lines == null ? 'Loading…' : 'Nothing matches these filters'}
          searchValue={q} onSearchChange={setQ}
          searchPlaceholder="Search company, PO, product, code…"
          getRowId={r => r.id}
          defaultSort={view === 'company' ? { key: 'pending_qty', dir: 'desc' }
            : view === 'lines' ? { key: 'po_date', dir: 'desc' }
            : view === 'po' ? { key: 'po_date', dir: 'desc' }
            : { key: 'pending_qty', dir: 'desc' }}
          exportName="Status Report"
          exportSpec={(sortedRows, cols) => buildReportExportSpec({
            view, rows: sortedRows, columns: cols,
            title: 'Status Report',
            subtitle: `${(VIEWS.find(v => v.key === view) || {}).label} · as on ${fmt.date(new Date())}`,
            meta: [...exportMeta, `${sortedRows.length} rows`],
            totals: sumRows(sortedRows, view),
          })}
        />
      </div>
      {rows.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">Click a company, PO or product name for its orders, deliveries and production.</p>
      )}
      <StatusReportDrawer trail={trail} lines={all}
        onOpen={ctx => setTrail(t => [...t, ctx])}
        onBack={() => setTrail(t => t.slice(0, -1))}
        onClose={() => setTrail([])}
        onShowInReport={showInReport} />
    </div>
  );
}

// Does grouped row `r` stand for line `l`? Used to keep the KPIs on the
// searched set without a second grouping pass.
function rowCovers(r, l, view) {
  if (view === 'company') return String(r.customer_id) === String(l.customer_id);
  if (view === 'po') return String(r.order_id) === String(l.order_id);
  if (view === 'product') return String(r.customer_id) === String(l.customer_id) && String(r.product_id) === String(l.product_id);
  return false;
}
