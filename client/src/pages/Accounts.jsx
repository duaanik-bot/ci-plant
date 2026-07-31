// Accounts — sales & purchase registers. What was sold to which customer and
// what was bought from which vendor in a period; volumes, values, timeline.
// Receivables live on the Invoices page — this is the trading control room.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, DataTable, Input, KpiCard, PageHeader, StatusBadge, Tabs } from '../components/ui.jsx';
import { ReceiptText, Package, ShoppingCart, Factory } from 'lucide-react';

// Local-date ISO (no UTC shift) — period boundaries must match plant time.
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthLabel = ym => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

function presetRange(key) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (key) {
    case 'this': return [iso(new Date(y, m, 1)), iso(now)];
    case 'last': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case '3m': return [iso(new Date(y, m - 2, 1)), iso(now)];
    case 'fy': return [iso(new Date(m >= 3 ? y : y - 1, 3, 1)), iso(now)]; // Indian FY — 1 Apr
    default: return [null, null]; // all time
  }
}

const PRESETS = [
  { key: 'this', label: 'This Month' },
  { key: 'last', label: 'Last Month' },
  { key: '3m', label: '3 Months' },
  { key: 'fy', label: 'This FY' },
  { key: 'all', label: 'All Time' },
];

// 12-month strip ending at the current month.
function last12Months() {
  const out = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export default function Accounts() {
  const [tab, setTab] = useState('customers');
  const [preset, setPreset] = useState('this');
  const [range, setRange] = useState(() => presetRange('this')); // [from, to]
  const [data, setData] = useState({ sales: [], purchases: [], sale_products: [], timeline: { sales: [], purchases: [] } });

  const [from, to] = range;
  useEffect(() => {
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
    api.get(`/accounts/registers${qs ? `?${qs}` : ''}`).then(setData);
  }, [from, to]);

  const pickPreset = key => { setPreset(key); setRange(presetRange(key)); };
  const pickMonth = ym => {
    const [y, m] = ym.split('-').map(Number);
    setPreset(`month:${ym}`);
    setRange([iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))]);
  };
  const setCustom = (which, value) => {
    setPreset('custom');
    setRange(r => which === 'from' ? [value || null, r[1]] : [r[0], value || null]);
  };

  const periodLabel = preset.startsWith('month:')
    ? new Date(`${preset.slice(6)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : preset === 'custom'
      ? `${from ? fmt.date(from) : 'Start'} – ${to ? fmt.date(to) : 'Today'}`
      : PRESETS.find(p => p.key === preset)?.label || 'All Time';

  // ── KPIs for the filtered period ─────────────────────────────────────────
  const kpi = useMemo(() => ({
    salesValue: data.sales.reduce((s, i) => s + i.total, 0),
    salesQty: data.sales.reduce((s, i) => s + i.qty, 0),
    invoices: data.sales.length,
    customers: new Set(data.sales.map(i => i.customer_id)).size,
    purchaseValue: data.purchases.reduce((s, p) => s + p.value, 0),
    purchaseQty: data.purchases.reduce((s, p) => s + p.ordered_qty, 0),
    pos: data.purchases.length,
    vendors: new Set(data.purchases.map(p => p.vendor_id)).size,
  }), [data]);

  // ── Party-wise rollups ───────────────────────────────────────────────────
  const byCustomer = useMemo(() => {
    const map = {};
    for (const i of data.sales) {
      const c = (map[i.customer_id] ||= { customer_name: i.customer_name, city: i.city, segment: i.segment, invoices: 0, qty: 0, taxable: 0, tax: 0, value: 0 });
      c.invoices += 1; c.qty += i.qty; c.taxable += i.subtotal; c.tax += i.tax; c.value += i.total;
    }
    return Object.values(map).sort((a, b) => b.value - a.value);
  }, [data.sales]);

  const byVendor = useMemo(() => {
    const map = {};
    for (const p of data.purchases) {
      const v = (map[p.vendor_id] ||= { vendor_name: p.vendor_name, city: p.city, pos: 0, ordered_qty: 0, received_qty: 0, value: 0, categories: new Set() });
      v.pos += 1; v.ordered_qty += p.ordered_qty; v.received_qty += p.received_qty; v.value += p.value;
      for (const c of (p.categories || '').split(', ').filter(Boolean)) v.categories.add(c);
    }
    return Object.values(map)
      .map(v => ({ ...v, categories: [...v.categories].join(', ') }))
      .sort((a, b) => b.value - a.value);
  }, [data.purchases]);

  // ── 12-month timeline ────────────────────────────────────────────────────
  const months = useMemo(last12Months, []);
  const timeline = useMemo(() => {
    const s = Object.fromEntries(data.timeline.sales.map(m => [m.month, m]));
    const p = Object.fromEntries(data.timeline.purchases.map(m => [m.month, m]));
    return months.map(m => ({
      month: m,
      sales: s[m]?.value || 0, salesQty: s[m]?.qty || 0,
      purchases: p[m]?.value || 0, purchaseQty: p[m]?.qty || 0,
    }));
  }, [months, data.timeline]);
  const maxMonth = Math.max(1, ...timeline.map(m => Math.max(m.sales, m.purchases)));

  const money = v => <span className="tabular-nums">{fmt.inr(v)}</span>;
  const exportPeriod = `Accounts · ${periodLabel}`;

  return (
    <div>
      <PageHeader title="Accounts" subtitle="Sales & purchase registers — customer and vendor volumes for the period" />

      {/* Period controls */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PRESETS.map(p => (
          <Button key={p.key} size="sm" variant={preset === p.key ? 'primary' : 'secondary'} onClick={() => pickPreset(p.key)}>
            {p.label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          <Input type="date" className="h-9 w-36" value={from || ''} onChange={e => setCustom('from', e.target.value)} />
          <span>to</span>
          <Input type="date" className="h-9 w-36" value={to || ''} onChange={e => setCustom('to', e.target.value)} />
        </div>
      </div>

      {/* KPI cards — all scoped to the selected period */}
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {/* Sales and purchase already have a register each, so a card selects
            the register that holds its rows rather than inventing a filter. */}
        <KpiCard label={`Sales · ${periodLabel}`} value={fmt.inr(kpi.salesValue)} icon={ReceiptText}
          sub={`${kpi.invoices} invoice${kpi.invoices === 1 ? '' : 's'} · ${kpi.customers} customer${kpi.customers === 1 ? '' : 's'}`}
          chip="bg-emerald-50 text-emerald-600" accent="text-emerald-700"
          onClick={() => setTab('customers')} active={tab === 'customers'} />
        <KpiCard label="Cartons Sold" value={fmt.num(kpi.salesQty)} icon={Package}
          sub="volume invoiced in period"
          onClick={() => setTab('products')} active={tab === 'products'} />
        <KpiCard label={`Purchases · ${periodLabel}`} value={fmt.inr(kpi.purchaseValue)} icon={ShoppingCart}
          sub={`${kpi.pos} PO${kpi.pos === 1 ? '' : 's'} · ${kpi.vendors} vendor${kpi.vendors === 1 ? '' : 's'}`}
          chip="bg-indigo-50 text-indigo-600" accent="text-indigo-700"
          onClick={() => setTab('vendors')} active={tab === 'vendors'} />
        <KpiCard label="Material Ordered" value={fmt.num(kpi.purchaseQty)} icon={Factory}
          sub="units on POs raised in period" />
      </div>

      {/* 12-month timeline — click a month to filter to it */}
      <div className="mb-5 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-700">12-Month Timeline</h3>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-400" /> Sales</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-indigo-400" /> Purchases</span>
          </div>
        </div>
        <div className="grid grid-cols-6 gap-2 sm:grid-cols-12">
          {timeline.map(m => {
            const active = preset === `month:${m.month}`;
            return (
              <button key={m.month} onClick={() => active ? pickPreset('this') : pickMonth(m.month)}
                title={`${monthLabel(m.month)} — Sales ${fmt.inr(m.sales)} (${fmt.num(m.salesQty)} ctn) · Purchases ${fmt.inr(m.purchases)}`}
                className={`group rounded-lg border px-1 pb-1.5 pt-2 transition ${active ? 'border-brand-300 bg-brand-50' : 'border-transparent hover:border-slate-200 hover:bg-slate-50'}`}>
                <div className="flex h-16 items-end justify-center gap-1">
                  <div className="w-2.5 rounded-t bg-emerald-400 group-hover:bg-emerald-500" style={{ height: `${Math.max(m.sales > 0 ? 6 : 2, 100 * m.sales / maxMonth)}%` }} />
                  <div className="w-2.5 rounded-t bg-indigo-400 group-hover:bg-indigo-500" style={{ height: `${Math.max(m.purchases > 0 ? 6 : 2, 100 * m.purchases / maxMonth)}%` }} />
                </div>
                <div className={`mt-1 text-center text-[10px] font-semibold ${active ? 'text-brand-700' : 'text-gray-400'}`}>{monthLabel(m.month)}</div>
              </button>
            );
          })}
        </div>
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'customers', label: 'Sales by Customer', count: byCustomer.length },
        { key: 'vendors', label: 'Purchases by Vendor', count: byVendor.length },
        { key: 'products', label: 'Product Volumes', count: data.sale_products.length },
        { key: 'sales', label: 'Sales Register', count: data.sales.length },
        { key: 'purchases', label: 'Purchase Register', count: data.purchases.length },
      ]} />

      {tab === 'customers' && (
        <DataTable searchable rows={byCustomer} empty="No sales in this period"
          columns={[
            { key: 'customer_name', label: 'Customer', render: c => (<div><div className="font-semibold">{c.customer_name}</div><div className="text-xs text-gray-400">{c.city}{c.segment ? ` · ${c.segment}` : ''}</div></div>) },
            { key: 'invoices', label: 'Invoices', align: 'right', render: c => <span className="tabular-nums">{c.invoices}</span> },
            { key: 'qty', label: 'Cartons', align: 'right', render: c => <span className="font-semibold tabular-nums">{fmt.num(c.qty)}</span> },
            { key: 'taxable', label: 'Taxable', align: 'right', render: c => money(c.taxable) },
            { key: 'tax', label: 'GST', align: 'right', render: c => <span className="tabular-nums text-xs text-gray-500">{fmt.inr(c.tax)}</span> },
            { key: 'value', label: 'Sales Value', align: 'right', render: c => <span className="font-bold tabular-nums text-emerald-700">{fmt.inr(c.value)}</span> },
          ]}
          exportName="Sales by Customer" exportSubtitle={exportPeriod}
          exportSummary={rows => [
            { label: 'Customers', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, c) => s + c.qty, 0)) },
            { label: 'Sales value', value: fmt.inr(rows.reduce((s, c) => s + c.value, 0)) },
          ]} />
      )}

      {tab === 'vendors' && (
        <DataTable searchable rows={byVendor} empty="No purchases in this period"
          columns={[
            { key: 'vendor_name', label: 'Vendor', render: v => (<div><div className="font-semibold">{v.vendor_name}</div><div className="text-xs text-gray-400">{v.city}</div></div>) },
            { key: 'categories', label: 'Supplies', render: v => <span className="text-xs text-gray-500">{v.categories || '—'}</span> },
            { key: 'pos', label: 'POs', align: 'right', render: v => <span className="tabular-nums">{v.pos}</span> },
            { key: 'ordered_qty', label: 'Ordered', align: 'right', render: v => <span className="font-semibold tabular-nums">{fmt.num(v.ordered_qty)}</span> },
            { key: 'received_qty', label: 'Received', align: 'right', render: v => (
              <span className={`tabular-nums ${v.received_qty >= v.ordered_qty ? 'text-emerald-600 font-semibold' : 'text-gray-500'}`}>{fmt.num(v.received_qty)}</span>) },
            { key: 'value', label: 'Purchase Value', align: 'right', render: v => <span className="font-bold tabular-nums text-indigo-700">{fmt.inr(v.value)}</span> },
          ]}
          exportName="Purchases by Vendor" exportSubtitle={exportPeriod}
          exportSummary={rows => [
            { label: 'Vendors', value: rows.length },
            { label: 'POs', value: rows.reduce((s, v) => s + v.pos, 0) },
            { label: 'Purchase value', value: fmt.inr(rows.reduce((s, v) => s + v.value, 0)) },
          ]} />
      )}

      {tab === 'products' && (
        <DataTable searchable rows={data.sale_products} empty="No products sold in this period"
          columns={[
            { key: 'name', label: 'Product', render: p => (<div><div className="font-semibold">{p.name}</div><div className="text-xs text-gray-400">{p.code}{p.size ? ` · ${p.size}` : ''}</div></div>) },
            { key: 'qty', label: 'Cartons Sold', align: 'right', render: p => <span className="font-bold tabular-nums">{fmt.num(p.qty)}</span> },
            { key: 'invoices', label: 'Invoices', align: 'right', render: p => <span className="tabular-nums">{p.invoices}</span> },
            { key: 'customers', label: 'Customers', align: 'right', render: p => <span className="tabular-nums">{p.customers}</span> },
            { key: 'value', label: 'Value', align: 'right', render: p => <span className="font-bold tabular-nums text-emerald-700">{fmt.inr(p.value)}</span> },
          ]}
          exportName="Product Volumes" exportSubtitle={exportPeriod}
          exportSummary={rows => [
            { label: 'Products', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, p) => s + p.qty, 0)) },
            { label: 'Value', value: fmt.inr(rows.reduce((s, p) => s + p.value, 0)) },
          ]} />
      )}

      {tab === 'sales' && (
        <DataTable searchable rows={data.sales} empty="No invoices in this period"
          columns={[
            { key: 'invoice_number', label: 'Invoice', render: i => (
              <Link to={`/invoices/${i.id}`} onClick={e => e.stopPropagation()} className="font-bold text-brand-600 hover:underline">{i.invoice_number}</Link>) },
            { key: 'invoice_date', label: 'Date', render: i => fmt.date(i.invoice_date) },
            { key: 'customer_name', label: 'Customer', render: i => (<div><div className="font-semibold">{i.customer_name}</div><div className="text-xs text-gray-400">{i.state}</div></div>) },
            { key: 'qty', label: 'Cartons', align: 'right', render: i => <span className="tabular-nums">{fmt.num(i.qty)}</span> },
            { key: 'subtotal', label: 'Taxable', align: 'right', render: i => money(i.subtotal) },
            { key: 'tax', label: 'GST', align: 'right', render: i => <span className="tabular-nums text-xs text-gray-500">{fmt.inr(i.tax)}</span> },
            { key: 'total', label: 'Total', align: 'right', render: i => <span className="font-bold tabular-nums">{fmt.inr(i.total)}</span> },
            { key: 'status', label: 'Status', render: i => <StatusBadge status={i.status} /> },
          ]}
          exportName="Sales Register" exportSubtitle={exportPeriod}
          exportSummary={rows => [
            { label: 'Invoices', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, i) => s + i.qty, 0)) },
            { label: 'Taxable', value: fmt.inr(rows.reduce((s, i) => s + i.subtotal, 0)) },
            { label: 'Total', value: fmt.inr(rows.reduce((s, i) => s + i.total, 0)) },
          ]} />
      )}

      {tab === 'purchases' && (
        <DataTable searchable rows={data.purchases} empty="No purchase orders in this period"
          columns={[
            { key: 'po_number', label: 'PO', render: p => (
              <Link to={`/procurement/po/${p.id}`} onClick={e => e.stopPropagation()} className="font-bold text-brand-600 hover:underline">{p.po_number}</Link>) },
            { key: 'created_at', label: 'Date', render: p => fmt.date(p.created_at) },
            { key: 'vendor_name', label: 'Vendor', render: p => (<div><div className="font-semibold">{p.vendor_name}</div><div className="text-xs text-gray-400">{p.city}</div></div>) },
            { key: 'categories', label: 'Materials', render: p => <span className="text-xs text-gray-500">{p.categories || '—'}{p.line_count > 0 ? ` · ${p.line_count} line${p.line_count === 1 ? '' : 's'}` : ''}</span> },
            { key: 'ordered_qty', label: 'Ordered', align: 'right', render: p => <span className="tabular-nums">{fmt.num(p.ordered_qty)}</span> },
            { key: 'received_qty', label: 'Received', align: 'right', render: p => (
              <span className={`tabular-nums ${p.received_qty >= p.ordered_qty && p.ordered_qty > 0 ? 'text-emerald-600 font-semibold' : 'text-gray-500'}`}>{fmt.num(p.received_qty)}</span>) },
            { key: 'value', label: 'Value', align: 'right', render: p => <span className="font-bold tabular-nums text-indigo-700">{fmt.inr(p.value)}</span> },
            { key: 'status', label: 'Status', render: p => <StatusBadge status={p.status} /> },
          ]}
          exportName="Purchase Register" exportSubtitle={exportPeriod}
          exportSummary={rows => [
            { label: 'POs', value: rows.length },
            { label: 'Ordered', value: fmt.num(rows.reduce((s, p) => s + p.ordered_qty, 0)) },
            { label: 'Value', value: fmt.inr(rows.reduce((s, p) => s + p.value, 0)) },
          ]} />
      )}
    </div>
  );
}
