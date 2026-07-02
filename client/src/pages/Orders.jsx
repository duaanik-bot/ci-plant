import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Textarea, useToast } from '../components/ui.jsx';
import { Plus, Trash2 } from 'lucide-react';

const emptyLine = { product_id: '', qty: '', rate: '' };

export default function Orders() {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });

  const load = () => api.get('/orders').then(setOrders);
  useEffect(() => {
    load();
    api.get('/customers').then(setCustomers);
    api.get('/products').then(setProducts);
  }, []);

  const custProducts = products.filter(p => String(p.customer_id) === String(form.customer_id) && p.active);
  const setLine = (i, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const save = async () => {
    const lines = form.lines.filter(l => l.product_id && l.qty).map(l => ({ ...l, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate }));
    await api.post('/orders', { ...form, customer_id: +form.customer_id, lines });
    toast.success('Order created');
    setShowNew(false);
    setForm({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });
    load();
  };

  const openDetail = o => api.get(`/orders/${o.id}`).then(setDetail);

  return (
    <div>
      <PageHeader title="Customer Orders" subtitle="Purchase orders received from customers"
        actions={<Button onClick={() => setShowNew(true)}><Plus size={15} /> New Order</Button>} />

      <DataTable searchable
        columns={[
          { key: 'po_number', label: 'PO Number', render: o => <span className="font-semibold text-gray-900">{o.po_number}</span> },
          { key: 'customer_name', label: 'Customer' },
          { key: 'po_date', label: 'PO Date', render: o => fmt.date(o.po_date) },
          { key: 'delivery_date', label: 'Delivery', render: o => fmt.date(o.delivery_date) },
          { key: 'line_count', label: 'Lines', align: 'right' },
          { key: 'value', label: 'Value', align: 'right', render: o => fmt.inr(o.value) },
          { key: 'status', label: 'Status', render: o => <StatusBadge status={o.status} /> },
        ]}
        rows={orders} onRowClick={openDetail} empty="No orders yet — create your first one" />

      {/* New order */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Customer Order" wide
        footer={<>
          <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
          <Button onClick={save} disabled={!form.po_number || !form.customer_id || !form.lines.some(l => l.product_id && l.qty)}>Create Order</Button>
        </>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer PO Number" required><Input value={form.po_number} onChange={e => setForm({ ...form, po_number: e.target.value })} placeholder="e.g. MED/PO/2610" /></Field>
          <Field label="Customer" required>
            <Select value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value, lines: [{ ...emptyLine }] })}>
              <option value="">Select customer…</option>
              {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="PO Date"><Input type="date" value={form.po_date} onChange={e => setForm({ ...form, po_date: e.target.value })} /></Field>
          <Field label="Delivery Date"><Input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} /></Field>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Order Lines</div>
          {form.lines.map((l, i) => {
            const prod = products.find(p => String(p.id) === String(l.product_id));
            return (
              <div key={i} className="mb-2 flex items-end gap-2">
                <div className="flex-1">
                  <Select value={l.product_id} onChange={e => {
                    const p = products.find(x => String(x.id) === e.target.value);
                    setLine(i, { product_id: e.target.value, rate: p ? p.rate : '' });
                  }}>
                    <option value="">{form.customer_id ? 'Select product…' : 'Pick a customer first'}</option>
                    {custProducts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                  </Select>
                </div>
                <div className="w-28"><Input type="number" min="1" placeholder="Qty" value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} /></div>
                <div className="w-24"><Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} /></div>
                <div className="w-24 pb-2 text-right text-xs font-semibold tabular-nums text-gray-500">
                  {l.qty && l.rate ? fmt.inr(l.qty * l.rate) : ''}
                </div>
                <button className="pb-2 text-gray-300 hover:text-red-500" onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                  <Trash2 size={15} />
                </button>
                {prod && <div className="hidden" />}
              </div>
            );
          })}
          <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }))}><Plus size={13} /> Add line</Button>
        </div>

        <div className="mt-3"><Field label="Notes"><Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field></div>
      </Modal>

      {/* Order detail */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.po_number} — ${detail.customer_name}` : ''} wide>
        {detail && (
          <div>
            <div className="mb-3 flex gap-6 text-sm text-gray-600">
              <span>PO date: <b>{fmt.date(detail.po_date)}</b></span>
              <span>Delivery: <b>{fmt.date(detail.delivery_date)}</b></span>
              <StatusBadge status={detail.status} />
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Dispatched</th><th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2">Status</th>
              </tr></thead>
              <tbody>
                {detail.lines.map(l => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="px-3 py-2">{l.product_name} <span className="text-xs text-gray-400">{l.product_code}</span></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.dispatched_qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₹{l.rate}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.inr(l.qty * l.rate)}</td>
                    <td className="px-3 py-2"><StatusBadge status={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.notes && <p className="mt-3 text-xs text-gray-500">Note: {detail.notes}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
