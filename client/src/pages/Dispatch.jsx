// Dispatch — produced lines appear here automatically. Make challan, print, done.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Tabs, useToast } from '../components/ui.jsx';
import { Truck, Printer } from 'lucide-react';

export default function Dispatch() {
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState('ready');
  const [ready, setReady] = useState([]);
  const [register, setRegister] = useState([]);
  const [creating, setCreating] = useState(null); // { order rows grouped }

  const load = () => {
    api.get('/dispatch/ready').then(setReady);
    api.get('/dispatches').then(setRegister);
  };
  useEffect(() => { load(); }, []);

  // group ready lines by order
  const byOrder = {};
  for (const l of ready) (byOrder[l.order_id] ||= { order_id: l.order_id, po_number: l.po_number, customer_name: l.customer_name, delivery_date: l.delivery_date, lines: [] }).lines.push(l);

  const openCreate = grp => {
    setCreating({
      ...grp, vehicle: '', driver: '',
      lines: grp.lines.map(l => ({ ...l, dispatch_qty: Math.min(l.qty - l.dispatched_qty, l.fg_qty) })),
    });
  };

  const save = async () => {
    const lines = creating.lines.filter(l => +l.dispatch_qty > 0).map(l => ({ order_line_id: l.order_line_id, qty: +l.dispatch_qty }));
    if (!lines.length) return toast.error('Enter at least one dispatch quantity');
    const d = await api.post('/dispatches', { order_id: creating.order_id, vehicle: creating.vehicle, driver: creating.driver, lines });
    toast.success(`Challan ${d.challan_number} created`);
    setCreating(null); load();
    nav(`/dispatch/challan/${d.id}`);
  };

  return (
    <div>
      <PageHeader title="Dispatch" subtitle="Finished goods flow here automatically when a job closes" />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'ready', label: 'Ready to Dispatch', count: Object.keys(byOrder).length },
        { key: 'register', label: 'Dispatch Register', count: register.length },
      ]} />

      {tab === 'ready' && (
        <div className="space-y-3">
          {Object.keys(byOrder).length === 0 &&
            <p className="rounded-xl border border-dashed bg-white py-14 text-center text-sm text-gray-400">Nothing waiting for dispatch.</p>}
          {Object.values(byOrder).map(grp => (
            <div key={grp.order_id} className="rounded-[22px] border border-white/70 bg-white/65 backdrop-blur-xl p-4 shadow-card">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <span className="text-sm font-extrabold">{grp.po_number}</span>
                  <span className="ml-2 text-xs text-gray-500">{grp.customer_name} · delivery {fmt.date(grp.delivery_date)}</span>
                </div>
                <Button size="sm" onClick={() => openCreate(grp)}><Truck size={14} /> Make Challan</Button>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                  <th className="px-3 py-1.5">Product</th><th className="px-3 py-1.5 text-right">Ordered</th>
                  <th className="px-3 py-1.5 text-right">Dispatched</th><th className="px-3 py-1.5 text-right">FG in Stock</th>
                </tr></thead>
                <tbody>
                  {grp.lines.map(l => (
                    <tr key={l.order_line_id} className="border-b border-gray-50 last:border-0">
                      <td className="px-3 py-2">{l.product_name} <span className="text-xs text-gray-400">{l.code}</span></td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.dispatched_qty)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums text-emerald-600">{fmt.num(l.fg_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {tab === 'register' && (
        <DataTable searchable
          columns={[
            { key: 'challan_number', label: 'Challan', render: d => <span className="font-semibold">{d.challan_number}</span> },
            { key: 'dispatched_at', label: 'Date', render: d => fmt.dt(d.dispatched_at) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'po_number', label: 'Against PO' },
            { key: 'vehicle', label: 'Vehicle' },
            { key: 'lines', label: 'Items', render: d => <span className="text-xs text-gray-500">{d.lines.map(l => `${l.product_name} ×${fmt.num(l.qty)}`).join(', ')}</span> },
            { key: 'print', label: '', render: d => (
              <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="ghost" onClick={() => nav(`/dispatch/challan/${d.id}`)}><Printer size={14} /> Print</Button>
              </div>) },
          ]}
          rows={register} empty="No dispatches yet" />
      )}

      <Modal open={!!creating} onClose={() => setCreating(null)} title={creating ? `Challan — ${creating.po_number} (${creating.customer_name})` : ''} wide
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
          <Button onClick={save}>Create Challan</Button>
        </>}>
        {creating && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vehicle No"><Input value={creating.vehicle} onChange={e => setCreating({ ...creating, vehicle: e.target.value })} placeholder="PB-10-XX-0000" /></Field>
              <Field label="Driver"><Input value={creating.driver} onChange={e => setCreating({ ...creating, driver: e.target.value })} /></Field>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-1.5">Product</th><th className="px-3 py-1.5 text-right">Balance</th>
                <th className="px-3 py-1.5 text-right">FG Stock</th><th className="px-3 py-1.5 text-right">Dispatch Now</th>
              </tr></thead>
              <tbody>
                {creating.lines.map((l, i) => (
                  <tr key={l.order_line_id} className="border-b border-gray-50">
                    <td className="px-3 py-2">{l.product_name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty - l.dispatched_qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.fg_qty)}</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" min="0" max={Math.min(l.qty - l.dispatched_qty, l.fg_qty)}
                        value={l.dispatch_qty}
                        onChange={e => setCreating(c => ({ ...c, lines: c.lines.map((x, j) => j === i ? { ...x, dispatch_qty: e.target.value } : x) }))}
                        className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-right text-sm focus:border-brand-500 focus:outline-none" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
