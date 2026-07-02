// Reports — the old Excel pivots, live. Filter-driven, no refresh discipline.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, PageHeader, Tabs } from '../components/ui.jsx';

export default function Reports() {
  const [tab, setTab] = useState('production');
  const [data, setData] = useState({});

  useEffect(() => {
    Promise.all([
      api.get('/reports/production'),
      api.get('/reports/scrap'),
      api.get('/reports/sales'),
      api.get('/reports/dispatch-register'),
      api.get('/reports/machine-load'),
    ]).then(([production, scrap, sales, dispatch, machines]) =>
      setData({ production, scrap, sales, dispatch, machines }));
  }, []);

  return (
    <div>
      <PageHeader title="Reports" subtitle="Live registers — export by printing or copying any table" />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'production', label: 'Production Register' },
        { key: 'scrap', label: 'Scrap by Stage' },
        { key: 'sales', label: 'Customer Sales' },
        { key: 'dispatch', label: 'Dispatch Register' },
        { key: 'machines', label: 'Machine Load (30d)' },
      ]} />

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
          ]} empty="No closed jobs in range" />
      )}

      {tab === 'scrap' && (
        <DataTable rows={data.scrap || []}
          columns={[
            { key: 'stage', label: 'Stage', render: r => <span className="font-semibold">{fmt.stage(r.stage)}</span> },
            { key: 'runs', label: 'Runs', align: 'right' },
            { key: 'input', label: 'Total Input', align: 'right', render: r => fmt.num(r.input) },
            { key: 'scrap', label: 'Total Scrap', align: 'right', render: r => <span className="text-red-600">{fmt.num(r.scrap)}</span> },
            { key: 'scrap_pct', label: 'Scrap %', align: 'right', render: r => <span className={`font-bold ${r.scrap_pct > 2 ? 'text-red-600' : 'text-gray-900'}`}>{r.scrap_pct ?? 0}%</span> },
          ]} empty="No completed stages yet" />
      )}

      {tab === 'sales' && (
        <DataTable rows={data.sales || []}
          columns={[
            { key: 'customer_name', label: 'Customer', render: r => <span className="font-semibold">{r.customer_name}</span> },
            { key: 'segment', label: 'Segment', render: r => <span className="text-xs uppercase text-gray-500">{r.segment}</span> },
            { key: 'orders', label: 'Orders', align: 'right' },
            { key: 'order_value', label: 'Order Value', align: 'right', render: r => fmt.inr(r.order_value) },
            { key: 'dispatched_value', label: 'Dispatched', align: 'right', render: r => fmt.inr(r.dispatched_value) },
            { key: 'pending_value', label: 'Pending', align: 'right', render: r => <span className="font-bold">{fmt.inr(r.pending_value)}</span> },
          ]} empty="No sales yet" />
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
          ]} empty="No dispatches yet" />
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
          ]} />
      )}
    </div>
  );
}
