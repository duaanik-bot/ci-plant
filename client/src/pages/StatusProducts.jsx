// Status Sheet › Product ledger — every product in the Masters product table,
// with its order position and leftover stock, so a product can be tracked
// from order to delivery. Click a product for its ledger.
//
// Nothing here has its own table: the list is the products master
// (GET /status-sheet/products), the order figures and stages are the Reports
// tab's own lines (GET /status-sheet/report), folded per product by
// lib/productLedger.js productRows, and the ledger is the shared details
// drawer opened on the product.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import useFallbackRefresh from '../lib/useFallbackRefresh.js';
import { storage } from '../lib/safeStorage.js';
import { drawerCtx, enrichLine, whereMix } from '../lib/statusReport.js';
import { productRows, TRACK } from '../lib/productLedger.js';
import { SECTION_ORDER } from '../sections.js';
import { DataTable, KpiCard, rowMatches } from '../components/ui.jsx';
import { FilterChip, FilterGroup, FilterRail } from '../components/FilterChip.jsx';
import { NameLink, WhereChip, whereLabel } from '../components/StatusReportBits.jsx';
import StatusReportDrawer from '../components/StatusReportDrawer.jsx';
import { AlertTriangle, RotateCcw } from 'lucide-react';

const PREFS_KEY = 'ci_status_products_prefs';
const DEFAULT_PREFS = { master: 'active', track: [], customers: [] };
function readPrefs() {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(storage.getItem(PREFS_KEY) || '{}') }; }
  catch { return DEFAULT_PREFS; }
}
const MASTER = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'all', label: 'All' },
];

const num = (key, label, tone) => ({
  key, label, align: 'right',
  render: r => <span className={`tabular-nums ${tone ? tone(r) : ''}`}>{fmt.num(r[key])}</span>,
  export: r => r[key] ?? 0,
});
const dateCol = (key, label) => ({
  key, label,
  render: r => <span className="whitespace-nowrap text-xs text-gray-600">{r[key] ? fmt.date(r[key]) : '—'}</span>,
  export: r => (r[key] ? fmt.date(r[key]) : ''),
});

export default function StatusProducts() {
  const [products, setProducts] = useState(null);
  const [lines, setLines] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const [prefs, setPrefs] = useState(readPrefs);
  const [q, setQ] = useState('');
  const [trail, setTrail] = useState([]);
  const { master, track, customers } = prefs;
  const set = patch => setPrefs(p => ({ ...p, ...patch }));
  useEffect(() => { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);

  const load = () => Promise.all([api.get('/status-sheet/products'), api.get('/status-sheet/report')])
    .then(([p, r]) => { setProducts(p.products || []); setLines((r.lines || []).map(enrichLine)); setLoadError(false); })
    .catch(() => setLoadError(true));
  useEffect(() => { load(); }, []);
  useFallbackRefresh(load, { intervalMs: 180000, loadOnMount: false });

  const all = useMemo(() => productRows(products || [], lines), [products, lines]);
  const byMaster = useMemo(() => all.filter(r => (master === 'all' ? true : master === 'active' ? r.active : !r.active)), [all, master]);
  const custSet = new Set(customers.map(String));
  const trackSet = new Set(track);
  const trackCounts = useMemo(() => {
    const c = { pending: 0, delivered: 0, never: 0 };
    for (const r of byMaster) if (!custSet.size || custSet.has(String(r.customer_id))) c[r.track] += 1;
    return c;
  }, [byMaster, customers]); // eslint-disable-line react-hooks/exhaustive-deps
  const companyChips = useMemo(() => {
    const m = new Map();
    for (const r of byMaster) {
      if (trackSet.size && !trackSet.has(r.track)) continue;
      const k = r.customer_id ?? 'none';
      const c = m.get(k) || { id: k, name: r.customer_name || 'No company', n: 0 };
      c.n += 1; m.set(k, c);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
  }, [byMaster, track]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = useMemo(() => byMaster.filter(r => (!custSet.size || custSet.has(String(r.customer_id ?? 'none')))
    && (!trackSet.size || trackSet.has(r.track))), [byMaster, customers, track]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (q ? filtered.filter(r => rowMatches(r, q)) : filtered), [filtered, q]);
  const kpi = useMemo(() => ({
    products: rows.length,
    pending: rows.filter(r => r.track === 'pending').length,
    pendingQty: rows.reduce((s, r) => s + r.pending_qty, 0),
    stock: rows.reduce((s, r) => s + r.stock_qty, 0),
    stocked: rows.filter(r => r.stock_qty > 0).length,
  }), [rows]);

  const toggle = (key, v) => set({ [key]: prefs[key].map(String).includes(String(v)) ? prefs[key].filter(x => String(x) !== String(v)) : [...prefs[key], v] });
  const open = r => setTrail([drawerCtx('product', r)]);

  const columns = [
    {
      key: 'product_name', label: 'Product',
      render: r => (
        <div className="min-w-[200px]">
          <NameLink onOpen={() => open(r)} title="Open this product's ledger">{r.product_name}</NameLink>
          <div className="text-[11px] text-gray-500">{[r.product_code, r.party_item_code, r.size].filter(Boolean).join(' · ')}</div>
        </div>
      ),
      export: r => r.product_name,
    },
    { key: 'product_code', label: 'Code', card: 'hide', render: r => <span className="text-xs text-gray-600">{r.product_code || '—'}</span>, export: r => r.product_code || '' },
    { key: 'customer_name', label: 'Company', render: r => <span className="text-sm">{r.customer_name || '—'}</span>, export: r => r.customer_name || '' },
    {
      key: 'where_counts', label: 'Stage', sortable: false, card: 'face',
      render: r => (r.open_lines
        ? <div className="flex min-w-[140px] max-w-[300px] flex-wrap gap-1">{whereMix(r.where_counts, SECTION_ORDER).map(m => <WhereChip key={m.key} k={m.key} count={m.count} />)}</div>
        : <span className="text-xs text-gray-400">{r.track === 'never' ? 'Never ordered' : 'Nothing pending'}</span>),
      export: r => (r.open_lines ? whereMix(r.where_counts, SECTION_ORDER).map(m => `${whereLabel(m.key)} ${m.count}`).join(', ') : (r.track === 'never' ? 'Never ordered' : 'Nothing pending')),
    },
    num('orders', 'POs'),
    num('qty', 'Ordered'),
    num('dispatched_qty', 'Delivered'),
    num('pending_qty', 'Pending', r => (r.pending_qty > 0 ? 'font-semibold text-amber-700' : 'text-gray-400')),
    num('stock_qty', 'In stock', r => (r.stock_qty > 0 ? 'font-semibold text-teal-700' : 'text-gray-400')),
    dateCol('last_po_date', 'Last PO'),
    dateCol('last_dispatched_at', 'Last dispatch'),
  ];

  const dirty = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_PREFS);
  const custNames = customers.map(id => companyChips.find(c => String(c.id) === String(id))?.name).filter(Boolean);

  return (
    <div>
      <FilterRail>
        <FilterGroup label="Master" divider={false}>
          {MASTER.map(m => (
            <FilterChip key={m.key} label={m.label} on={master === m.key} onClick={() => set({ master: m.key })} />
          ))}
        </FilterGroup>
        <FilterGroup label="Orders">
          {TRACK.map(t => (
            <FilterChip key={t.key} label={t.label} count={trackCounts[t.key]} tone={t.tone}
              on={track.includes(t.key)} onClick={() => toggle('track', t.key)} />
          ))}
        </FilterGroup>
        {dirty && (
          <button type="button" onClick={() => { setPrefs(DEFAULT_PREFS); setQ(''); }}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-[#0064D2] hover:bg-[#E1EFFF]">
            <RotateCcw size={12} /> Reset
          </button>
        )}
      </FilterRail>
      {companyChips.length > 1 && (
        <FilterRail className="mt-2">
          <FilterGroup label="Company" divider={false}>
            {companyChips.map(c => (
              <FilterChip key={c.id} count={c.n}
                label={<span className="min-w-0 max-w-[11rem] truncate">{c.name}</span>}
                title={`${c.name} — ${c.n} product${c.n === 1 ? '' : 's'}`}
                on={customers.map(String).includes(String(c.id))} onClick={() => toggle('customers', c.id)} />
            ))}
          </FilterGroup>
        </FilterRail>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label="Products" value={fmt.num(kpi.products)} compact />
        <KpiCard label="With pending orders" value={fmt.num(kpi.pending)} accent="text-amber-700" compact />
        <KpiCard label="Pending qty" value={fmt.num(kpi.pendingQty)} accent="text-amber-700" compact />
        <KpiCard label="Leftover stock" value={fmt.num(kpi.stock)} accent="text-teal-700" compact sub={`${fmt.num(kpi.stocked)} products`} />
      </div>

      {loadError && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          <AlertTriangle size={16} className="shrink-0" />
          Couldn't reach the server — {products ? 'showing the last data loaded' : 'the product list can’t load'}. Retrying…
        </div>
      )}

      <div className="mt-3">
        <DataTable
          columns={columns}
          rows={rows}
          empty={products == null ? 'Loading…' : 'No products match these filters'}
          searchValue={q} onSearchChange={setQ}
          searchPlaceholder="Search product, code, company…"
          getRowId={r => r.id}
          defaultSort={{ key: 'pending_qty', dir: 'desc' }}
          exportName="Product Ledger"
          exportSubtitle={`Product list · as on ${fmt.date(new Date())}`}
          exportMeta={[
            `Master: ${MASTER.find(m => m.key === master)?.label}`,
            track.length ? `Orders: ${track.map(k => TRACK.find(t => t.key === k)?.label).join(', ')}` : null,
            custNames.length ? `Companies: ${custNames.join(', ')}` : null,
          ].filter(Boolean)}
          exportSummary={rs => [
            { label: 'Products', value: fmt.num(rs.length) },
            { label: 'Pending qty', value: fmt.num(rs.reduce((s, r) => s + r.pending_qty, 0)) },
            { label: 'Leftover stock', value: fmt.num(rs.reduce((s, r) => s + r.stock_qty, 0)) },
          ]}
        />
      </div>
      {rows.length > 0 && <p className="mt-2 text-xs text-gray-500">Click a product for its ledger — orders, production, deliveries and stock in date order.</p>}

      <StatusReportDrawer trail={trail} lines={lines}
        onOpen={ctx => setTrail(t => [...t, ctx])}
        onBack={() => setTrail(t => t.slice(0, -1))}
        onClose={() => setTrail([])} />
    </div>
  );
}
