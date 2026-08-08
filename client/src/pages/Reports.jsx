// Reports — the old Excel pivots, live. Filter-driven, no refresh discipline.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { DataTable, ExportMenu, PageHeader, Tabs } from '../components/ui.jsx';

export default function Reports() {
  const [tab, setTab] = useState('insights');
  const [data, setData] = useState({});

  const load = () => Promise.all([
      api.get('/reports/production'),
      api.get('/reports/scrap'),
      api.get('/reports/sales'),
      api.get('/reports/dispatch-register'),
      api.get('/reports/machine-load'),
      api.get('/reports/insights'),
      api.get('/reports/extra-sheets'),
    ]).then(([production, scrap, sales, dispatch, machines, insights, extraSheets]) =>
      setData({ production, scrap, sales, dispatch, machines, insights, extraSheets }));
  useEffect(() => { load(); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 1000 });

  return (
    <div>
      <PageHeader title="Reports" subtitle="Live registers — export any view as a branded PDF or Excel workbook" />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'insights', label: 'Sales Insights' },
        { key: 'production', label: 'Production Register' },
        { key: 'scrap', label: 'Scrap by Stage' },
        { key: 'extra_sheets', label: 'Wastage Control' },
        { key: 'sales', label: 'Customer Sales' },
        { key: 'dispatch', label: 'Dispatch Register' },
        { key: 'machines', label: 'Machine Load (30d)' },
      ]} />

      {tab === 'insights' && data.insights && (() => {
        const ins = data.insights;
        const maxMonth = Math.max(1, ...ins.monthly.map(m => +m.dispatched_value));
        const maxCust = Math.max(1, ...ins.top_customers.map(c => +c.value));
        const maxProd = Math.max(1, ...ins.top_products.map(p => +p.value));
        const Bar = ({ pct, cls = 'bg-brand-500' }) => (
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>);
        return (
          <div className="space-y-4">
            <div className="flex justify-end">
              <ExportMenu build={() => ({
                name: 'Sales Insights',
                title: 'Sales Insights',
                subtitle: 'Reports · Dispatched value, top customers & products, receivables',
                orientation: 'portrait',
                summary: [
                  { label: 'Invoiced', value: fmt.inr(ins.receivables.invoiced) },
                  { label: 'Collected', value: fmt.inr(ins.receivables.collected) },
                  { label: 'Receivable', value: fmt.inr(ins.receivables.outstanding) },
                ],
                sections: [
                  {
                    heading: 'Dispatched Value by Month',
                    columns: [
                      { key: 'month', label: 'Month' },
                      { key: 'dispatched_value', label: 'Dispatched Value', align: 'right', export: m => fmt.inr(m.dispatched_value) },
                    ],
                    rows: ins.monthly,
                  },
                  {
                    heading: 'Top Customers',
                    columns: [
                      { key: 'name', label: 'Customer' },
                      { key: 'value', label: 'Dispatched Value', align: 'right', export: c => fmt.inr(c.value) },
                    ],
                    rows: ins.top_customers,
                  },
                  {
                    heading: 'Top Products',
                    columns: [
                      { key: 'name', label: 'Product' },
                      { key: 'code', label: 'Code' },
                      { key: 'value', label: 'Dispatched Value', align: 'right', export: p => fmt.inr(p.value) },
                    ],
                    rows: ins.top_products,
                  },
                ],
              })} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Dispatched Value by Month</h3>
                {ins.monthly.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No dispatches yet</p>}
                <div className="space-y-2.5">
                  {ins.monthly.map(m => (
                    <div key={m.month} className="flex items-center gap-3 text-sm">
                      <span className="w-16 text-xs font-semibold text-slate-500">{m.month}</span>
                      <Bar pct={100 * m.dispatched_value / maxMonth} />
                      <span className="w-24 text-right text-xs font-bold tabular-nums">{fmt.inr(m.dispatched_value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Top Customers</h3>
                <div className="space-y-2.5">
                  {ins.top_customers.map(c => (
                    <div key={c.name} className="flex items-center gap-3 text-sm">
                      <span className="w-32 truncate text-xs font-semibold text-slate-600">{c.name}</span>
                      <Bar pct={100 * c.value / maxCust} cls="bg-indigo-400" />
                      <span className="w-20 text-right text-xs font-bold tabular-nums">{fmt.inr(c.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Top Products</h3>
                <div className="space-y-2.5">
                  {ins.top_products.map(p => (
                    <div key={p.code} className="flex items-center gap-3 text-sm">
                      <span className="w-32 truncate text-xs font-semibold text-slate-600">{p.name}</span>
                      <Bar pct={100 * p.value / maxProd} cls="bg-emerald-400" />
                      <span className="w-20 text-right text-xs font-bold tabular-nums">{fmt.inr(p.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-6 rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl px-5 py-4 shadow-card text-sm">
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Invoiced</span><div className="text-lg font-extrabold tabular-nums">{fmt.inr(ins.receivables.invoiced)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Collected</span><div className="text-lg font-extrabold tabular-nums text-emerald-600">{fmt.inr(ins.receivables.collected)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Receivable</span><div className="text-lg font-extrabold tabular-nums text-amber-600">{fmt.inr(ins.receivables.outstanding)}</div></div>
            </div>
          </div>
        );
      })()}

      {tab === 'production' && (
        <DataTable searchable rows={data.production || []}
          columns={[
            { key: 'jc_number', label: 'Job Card', render: r => <span className="font-semibold">{r.jc_number}</span> },
            { key: 'closed_at', label: 'Closed', render: r => fmt.date(r.closed_at) },
            { key: 'product_name', label: 'Product' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'machine_name', label: 'Machine' },
            { key: 'qty_planned', label: 'Ordered', align: 'right', render: r => fmt.num(r.qty_planned) },
            { key: 'qty_produced', label: 'Produced', align: 'right', render: r => fmt.num(r.qty_produced) },
            { key: 'qty_scrap', label: 'Scrap', align: 'right', render: r => <span className="text-red-600">{fmt.num(r.qty_scrap)}</span> },
            { key: 'fulfilment_pct', label: 'Fulfilment', align: 'right', render: r => `${r.fulfilment_pct}%` },
          ]} empty="No closed jobs in range"
          exportName="Production Register"
          exportSubtitle="Reports · Closed job cards"
          exportSummary={rows => [
            { label: 'Jobs', value: rows.length },
            { label: 'Ordered', value: fmt.num(rows.reduce((s, r) => s + (+r.qty_planned || 0), 0)) },
            { label: 'Produced', value: fmt.num(rows.reduce((s, r) => s + (+r.qty_produced || 0), 0)) },
            { label: 'Scrap', value: fmt.num(rows.reduce((s, r) => s + (+r.qty_scrap || 0), 0)) },
          ]} />
      )}

      {tab === 'scrap' && (
        <DataTable rows={data.scrap || []}
          columns={[
            { key: 'stage', label: 'Stage', render: r => <span className="font-semibold">{fmt.stage(r.stage)}</span> },
            { key: 'runs', label: 'Runs', align: 'right' },
            { key: 'input', label: 'Total Input', align: 'right', render: r => fmt.num(r.input) },
            { key: 'scrap', label: 'Total Scrap', align: 'right', render: r => <span className="text-red-600">{fmt.num(r.scrap)}</span> },
            { key: 'scrap_pct', label: 'Scrap %', align: 'right', render: r => <span className={`font-bold ${r.scrap_pct > 2 ? 'text-red-600' : 'text-gray-900'}`}>{r.scrap_pct ?? 0}%</span> },
          ]} empty="No completed stages yet"
          exportName="Scrap by Stage"
          exportSubtitle="Reports · Stage-wise wastage"
          exportSummary={rows => [
            { label: 'Stages', value: rows.length },
            { label: 'Total input', value: fmt.num(rows.reduce((s, r) => s + (+r.input || 0), 0)) },
            { label: 'Total scrap', value: fmt.num(rows.reduce((s, r) => s + (+r.scrap || 0), 0)) },
          ]} />
      )}

      {/* Wastage control — where the extra board went: the measured answer to
          "cutting gave me a few more". Only requests received back from
          Cutting count. */}
      {tab === 'extra_sheets' && data.extraSheets && (() => {
        const xs = data.extraSheets;
        const d = xs.discipline || {};
        const maxReason = Math.max(1, ...xs.by_reason.map(r => +r.sheets));
        const maxStage = Math.max(1, ...xs.by_stage.map(r => +r.sheets));
        const maxMonth = Math.max(1, ...xs.monthly.map(r => +r.sheets));
        const Bar = ({ pct, cls = 'bg-amber-400' }) => (
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full ${cls}`} style={{ width: `${Math.max(2, pct)}%` }} />
          </div>);
        const xsSummary = [
          { label: 'Extra sheets issued', value: fmt.num(d.issued_sheets) },
          { label: 'Issued requests', value: fmt.num(d.issued) },
          { label: 'Open now', value: fmt.num(d.open) },
          { label: 'Rejected', value: fmt.num(d.rejected) },
          { label: 'Cancelled', value: fmt.num(d.cancelled) },
        ];
        return (
          <div className="space-y-4">
            <div className="flex justify-end">
              <ExportMenu build={() => ({
                name: 'Wastage Control',
                title: 'Wastage Control',
                subtitle: 'Reports · Extra sheet discipline — breakdowns and full register',
                summary: xsSummary,
                sections: [
                  {
                    heading: 'Extra Sheets by Reason',
                    columns: [
                      { key: 'reason', label: 'Reason' },
                      { key: 'sheets', label: 'Sheets', align: 'right', export: r => fmt.num(r.sheets) },
                    ],
                    rows: xs.by_reason,
                  },
                  {
                    heading: 'Extra Sheets by Stage',
                    columns: [
                      { key: 'stage', label: 'Stage', export: r => fmt.stage(r.stage) },
                      { key: 'sheets', label: 'Sheets', align: 'right', export: r => fmt.num(r.sheets) },
                    ],
                    rows: xs.by_stage,
                  },
                  {
                    heading: 'Monthly Trend',
                    columns: [
                      { key: 'month', label: 'Month' },
                      { key: 'sheets', label: 'Sheets', align: 'right', export: r => fmt.num(r.sheets) },
                    ],
                    rows: xs.monthly,
                  },
                  {
                    heading: 'Register',
                    columns: [
                      { key: 'xs_number', label: 'Request' },
                      { key: 'issued_at', label: 'Issued', export: r => fmt.date(r.issued_at) },
                      { key: 'jc_number', label: 'Job Card' },
                      { key: 'product_name', label: 'Product' },
                      { key: 'customer_name', label: 'Customer' },
                      { key: 'stage', label: 'Stage', export: r => fmt.stage(r.stage) },
                      { key: 'qty', label: 'Extra Sheets', align: 'right', export: r => fmt.num(r.qty) },
                      { key: 'extra_pct', label: 'Extra %', align: 'right', export: r => `${r.extra_pct ?? 0}%` },
                      { key: 'reason', label: 'Reason' },
                    ],
                    rows: xs.register || [],
                  },
                ],
              })} />
            </div>
            <div className="flex flex-wrap gap-6 rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl px-5 py-4 shadow-card text-sm">
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Extra Sheets Issued</span><div className="text-lg font-extrabold tabular-nums text-amber-600">{fmt.num(d.issued_sheets)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Issued Requests</span><div className="text-lg font-extrabold tabular-nums">{fmt.num(d.issued)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Open Now</span><div className="text-lg font-extrabold tabular-nums text-brand-700">{fmt.num(d.open)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Rejected</span><div className="text-lg font-extrabold tabular-nums text-red-600">{fmt.num(d.rejected)}</div></div>
              <div><span className="text-xs uppercase tracking-wide text-slate-400">Cancelled</span><div className="text-lg font-extrabold tabular-nums text-slate-400">{fmt.num(d.cancelled)}</div></div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Extra Sheets by Reason</h3>
                {xs.by_reason.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No extra sheets issued yet</p>}
                <div className="space-y-2.5">
                  {xs.by_reason.map(r => (
                    <div key={r.reason} className="flex items-center gap-3 text-sm">
                      <span className="w-32 truncate text-xs font-semibold text-slate-600">{r.reason}</span>
                      <Bar pct={100 * r.sheets / maxReason} />
                      <span className="w-20 text-right text-xs font-bold tabular-nums">{fmt.num(r.sheets)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Extra Sheets by Stage</h3>
                {xs.by_stage.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No extra sheets issued yet</p>}
                <div className="space-y-2.5">
                  {xs.by_stage.map(r => (
                    <div key={r.stage} className="flex items-center gap-3 text-sm">
                      <span className="w-32 truncate text-xs font-semibold text-slate-600">{fmt.stage(r.stage)}</span>
                      <Bar pct={100 * r.sheets / maxStage} cls="bg-rose-400" />
                      <span className="w-20 text-right text-xs font-bold tabular-nums">{fmt.num(r.sheets)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
                <h3 className="mb-3 text-sm font-bold text-slate-900">Monthly Trend</h3>
                {xs.monthly.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No extra sheets issued yet</p>}
                <div className="space-y-2.5">
                  {xs.monthly.map(m => (
                    <div key={m.month} className="flex items-center gap-3 text-sm">
                      <span className="w-16 text-xs font-semibold text-slate-500">{m.month}</span>
                      <Bar pct={100 * m.sheets / maxMonth} cls="bg-indigo-400" />
                      <span className="w-20 text-right text-xs font-bold tabular-nums">{fmt.num(m.sheets)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <DataTable searchable rows={xs.register || []}
              columns={[
                { key: 'xs_number', label: 'Request', render: r => <span className="font-semibold">{r.xs_number}</span> },
                { key: 'issued_at', label: 'Issued', render: r => fmt.date(r.issued_at) },
                { key: 'jc_number', label: 'Job Card' },
                { key: 'product_name', label: 'Product' },
                { key: 'customer_name', label: 'Customer' },
                { key: 'stage', label: 'Stage', render: r => fmt.stage(r.stage) },
                { key: 'qty', label: 'Extra Sheets', align: 'right', render: r => <span className="font-bold text-amber-700">{fmt.num(r.qty)}</span> },
                { key: 'original_issue', label: 'Original Issue', align: 'right', render: r => fmt.num(r.original_issue) },
                { key: 'extra_pct', label: 'Extra %', align: 'right', render: r => <span className={`font-bold ${r.extra_pct > 5 ? 'text-red-600' : 'text-gray-900'}`}>{r.extra_pct ?? 0}%</span> },
                { key: 'reason', label: 'Reason', render: r => <>{r.reason}{r.note ? <span className="block text-[11px] text-slate-400">{r.note}</span> : null}</> },
                { key: 'issued_by', label: 'Control', render: r => <span className="text-xs text-slate-500">req {r.requested_by || '—'} · appr {r.approved_by || '—'} · issue {r.issued_by || '—'}</span> },
              ]} empty="No extra sheets issued yet — the plant is running on plan"
              exportName="Wastage Control Register"
              exportSubtitle="Reports · Extra sheet issues, reasons & control trail"
              exportSummary={() => [
                { label: 'Extra sheets issued', value: fmt.num(d.issued_sheets) },
                { label: 'Issued requests', value: fmt.num(d.issued) },
                { label: 'Open now', value: fmt.num(d.open) },
                { label: 'Rejected', value: fmt.num(d.rejected) },
                { label: 'Cancelled', value: fmt.num(d.cancelled) },
              ]} />
          </div>
        );
      })()}

      {tab === 'sales' && (
        <DataTable rows={data.sales || []}
          columns={[
            { key: 'customer_name', label: 'Customer', render: r => <span className="font-semibold">{r.customer_name}</span> },
            { key: 'segment', label: 'Segment', render: r => <span className="text-xs uppercase text-gray-500">{r.segment}</span> },
            { key: 'orders', label: 'Orders', align: 'right' },
            { key: 'order_value', label: 'Order Value', align: 'right', render: r => fmt.inr(r.order_value) },
            { key: 'dispatched_value', label: 'Dispatched', align: 'right', render: r => fmt.inr(r.dispatched_value) },
            { key: 'pending_value', label: 'Pending', align: 'right', render: r => <span className="font-bold">{fmt.inr(r.pending_value)}</span> },
          ]} empty="No sales yet"
          exportName="Customer Sales"
          exportSubtitle="Reports · Customer-wise order and dispatch value"
          exportSummary={rows => [
            { label: 'Customers', value: rows.length },
            { label: 'Order value', value: fmt.inr(rows.reduce((s, r) => s + (+r.order_value || 0), 0)) },
            { label: 'Dispatched', value: fmt.inr(rows.reduce((s, r) => s + (+r.dispatched_value || 0), 0)) },
            { label: 'Pending', value: fmt.inr(rows.reduce((s, r) => s + (+r.pending_value || 0), 0)) },
          ]} />
      )}

      {tab === 'dispatch' && (
        <DataTable searchable rows={data.dispatch || []}
          columns={[
            { key: 'challan_number', label: 'Challan', render: r => <span className="font-semibold">{r.challan_number}</span> },
            { key: 'dispatched_at', label: 'Date', render: r => fmt.dt(r.dispatched_at) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'po_number', label: 'PO' },
            { key: 'vehicle', label: 'Vehicle' },
            { key: 'total_qty', label: 'Cartons', align: 'right', render: r => fmt.num(r.total_qty) },
            { key: 'value', label: 'Value', align: 'right', render: r => fmt.inr(r.value) },
          ]} empty="No dispatches yet"
          exportName="Dispatch Register"
          exportSubtitle="Reports · Challan-wise dispatches"
          exportSummary={rows => [
            { label: 'Challans', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, r) => s + (+r.total_qty || 0), 0)) },
            { label: 'Value', value: fmt.inr(rows.reduce((s, r) => s + (+r.value || 0), 0)) },
          ]} />
      )}

      {tab === 'machines' && (
        <DataTable rows={data.machines || []}
          columns={[
            { key: 'name', label: 'Machine', render: r => <span className="font-semibold">{r.name}</span> },
            { key: 'type', label: 'Type', render: r => <span className="text-xs capitalize text-gray-500">{r.type.replace('_', ' ')}</span> },
            { key: 'capacity_per_hour', label: 'Capacity/hr', align: 'right', render: r => fmt.num(r.capacity_per_hour) },
            { key: 'jobs_30d', label: 'Jobs (30d)', align: 'right' },
            { key: 'produced_30d', label: 'Produced (30d)', align: 'right', render: r => fmt.num(r.produced_30d) },
            { key: 'scrap_30d', label: 'Scrap (30d)', align: 'right', render: r => <span className="text-red-600">{fmt.num(r.scrap_30d)}</span> },
          ]}
          exportName="Machine Load (30d)"
          exportSubtitle="Reports · Machine utilisation, last 30 days" />
      )}
    </div>
  );
}
