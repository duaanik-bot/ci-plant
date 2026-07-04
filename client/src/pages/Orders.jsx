import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Copy, Pencil, Plus, Save, Trash2, X } from 'lucide-react';

const emptyLine = { product_id: '', qty: '', rate: '' };
const toDateInput = s => (s ? String(s).slice(0, 10) : '');

function productSpec(product) {
  if (!product) return null;
  const article = [
    product.code || product.product_code,
    product.size,
    product.gsm ? `${product.gsm} GSM` : '',
    product.colors ? `${product.colors}C` : '',
  ].filter(Boolean).join(' · ');
  const details = [
    product.board_name,
    product.child_l && product.child_w ? `Print ${product.child_l}×${product.child_w}"` : '',
    product.ups ? `${product.ups} ups` : '',
    product.wastage_pct != null ? `${product.wastage_pct}% wastage` : '',
    product.coating && product.coating !== 'none' ? fmt.title(product.coating) : '',
    product.special && product.special !== 'none' ? fmt.title(product.special) : '',
  ].filter(Boolean).join(' · ');
  return { article, details };
}

function ProductSpec({ product }) {
  const spec = productSpec(product);
  if (!spec) return null;
  return (
    <div className="mt-2 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2">
      <div className="text-[11px] font-bold leading-4 text-slate-600">{spec.article}</div>
      {spec.details && <div className="mt-0.5 text-[11px] leading-4 text-slate-400">{spec.details}</div>}
    </div>
  );
}

export default function Orders() {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [form, setForm] = useState({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });
  const [tab, setTab] = useState('open');

  const load = () => api.get('/orders').then(setOrders);
  useEffect(() => {
    load();
    api.get('/customers').then(setCustomers);
    api.get('/products').then(setProducts);
  }, []);

  const openOrders = orders.filter(o => o.status === 'open');
  const closedOrders = orders.filter(o => o.status !== 'open');
  const custProducts = products.filter(p => String(p.customer_id) === String(form.customer_id) && p.active);
  const setLine = (i, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cloneLine = i => setForm(f => {
    const source = f.lines[i] || emptyLine;
    const copy = { product_id: source.product_id, qty: source.qty, rate: source.rate };
    return { ...f, lines: [...f.lines.slice(0, i + 1), copy, ...f.lines.slice(i + 1)] };
  });

  const save = async () => {
    const lines = form.lines.filter(l => l.product_id && l.qty).map(l => ({ ...l, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate }));
    await api.post('/orders', { ...form, customer_id: +form.customer_id, lines });
    toast.success('Order created');
    setShowNew(false);
    setForm({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });
    load();
  };

  const openDetail = o => api.get(`/orders/${o.id}`).then(setDetail);
  const closeDetail = () => {
    setDetail(null);
    setEditing(false);
    setEditForm(null);
  };
  const detailToForm = o => ({
    po_number: o.po_number || '',
    customer_id: String(o.customer_id || ''),
    po_date: toDateInput(o.po_date),
    delivery_date: toDateInput(o.delivery_date),
    notes: o.notes || '',
    lines: o.lines.map(l => ({
      id: l.id,
      product_id: String(l.product_id),
      qty: l.qty,
      rate: l.rate,
      dispatched_qty: l.dispatched_qty,
      status: l.status,
    })),
  });
  const startEdit = () => {
    setEditForm(detailToForm(detail));
    setEditing(true);
  };
  const editProducts = products.filter(p => String(p.customer_id) === String(editForm?.customer_id) && p.active);
  const setEditLine = (i, patch) => setEditForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cloneEditLine = i => setEditForm(f => {
    const source = f.lines[i] || emptyLine;
    const copy = { product_id: source.product_id, qty: source.qty, rate: source.rate };
    return { ...f, lines: [...f.lines.slice(0, i + 1), copy, ...f.lines.slice(i + 1)] };
  });
  const saveEdit = async () => {
    const lines = editForm.lines
      .filter(l => l.product_id && l.qty)
      .map(l => ({ ...l, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate }));
    const updated = await api.put(`/orders/${detail.id}`, { ...editForm, customer_id: +editForm.customer_id, lines });
    toast.success('Order updated');
    setDetail(updated);
    setEditForm(detailToForm(updated));
    setEditing(false);
    load();
  };

  return (
    <div>
      <PageHeader title="Sales Orders" subtitle="Customer POs in — every line tracked to dispatch"
        actions={<Button onClick={() => setShowNew(true)}><Plus size={15} /> New Order</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'open', label: 'Open', count: openOrders.length },
        { key: 'closed', label: 'Closed', count: closedOrders.length },
      ]} />

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
        rows={tab === 'open' ? openOrders : closedOrders} onRowClick={openDetail}
        empty={tab === 'open' ? 'No open orders — create your first one' : 'No completed or cancelled orders yet'} />

      {/* New order */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Customer Order" wide
        footer={<>
          <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
          <Button onClick={save} disabled={!form.po_number || !form.customer_id || !form.lines.some(l => l.product_id && l.qty)}>Create Order</Button>
        </>}>
        <div className="space-y-4">
          <section className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span>Customer PO</span>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700">Sales intake</span>
            </div>
            <div className="ci-form-grid">
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
          </section>

          <section className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span>Order Lines</span>
              <span>{form.lines.filter(l => l.product_id && l.qty).length} ready</span>
            </div>
            <div className="space-y-2">
              {form.lines.map((l, i) => {
                const prod = products.find(p => String(p.id) === String(l.product_id));
                return (
                  <div key={i} className="ci-line-item">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_110px_110px_120px_68px] md:items-start">
                      <div className="flex h-10 items-center justify-center rounded-lg bg-slate-50 text-xs font-black tabular-nums text-slate-400">
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0">
                        <Select value={l.product_id} onChange={e => {
                          const p = products.find(x => String(x.id) === e.target.value);
                          setLine(i, { product_id: e.target.value, rate: p?.rate ?? '' });
                        }}>
                          <option value="">{form.customer_id ? 'Select product…' : 'Pick a customer first'}</option>
                          {custProducts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                        </Select>
                        <ProductSpec product={prod} />
                      </div>
                      <Input type="number" min="1" placeholder="Qty" value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} />
                      <Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} />
                      <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                        {l.qty && l.rate ? fmt.inr(l.qty * l.rate) : '—'}
                      </div>
                      <div className="flex h-10 items-center justify-end gap-1">
                        <button type="button" title="Clone line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600" onClick={() => cloneLine(i)}>
                          <Copy size={14} />
                        </button>
                        <button type="button" title="Delete line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500" onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }))}><Plus size={13} /> Add line</Button>
            </div>
          </section>

          <section className="ci-form-panel">
            <Field label="Notes"><Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
          </section>
        </div>
      </Modal>

      {/* Order detail */}
      <Modal open={!!detail} onClose={closeDetail} title={detail ? `${detail.po_number} — ${detail.customer_name}` : ''} wide
        footer={detail && (editing ? <>
          <Button variant="secondary" onClick={() => { setEditing(false); setEditForm(detailToForm(detail)); }}><X size={14} /> Cancel</Button>
          <Button onClick={saveEdit} disabled={!editForm?.po_number || !editForm?.customer_id || !editForm?.lines.some(l => l.product_id && l.qty)}>
            <Save size={14} /> Save Changes
          </Button>
        </> : <>
          <Button variant="secondary" onClick={closeDetail}>Close</Button>
          <Button onClick={startEdit}><Pencil size={14} /> Edit Order</Button>
        </>)}>
        {detail && !editing && (
          <div>
            <div className="mb-3 flex gap-6 text-sm text-gray-600">
              <span>PO date: <b>{fmt.date(detail.po_date)}</b></span>
              <span>Delivery: <b>{fmt.date(detail.delivery_date)}</b></span>
              <StatusBadge status={detail.status} />
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-2 w-12">#</th><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Dispatched</th><th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2">Status</th>
              </tr></thead>
              <tbody>
                {detail.lines.map((l, i) => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="px-3 py-2 text-xs font-black tabular-nums text-slate-300">{String(i + 1).padStart(2, '0')}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{l.product_name}</div>
                      <ProductSpec product={l} />
                    </td>
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
        {detail && editing && editForm && (
          <div className="space-y-4">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Customer PO</span><span>Edit mode</span></div>
              <div className="ci-form-grid">
              <Field label="Customer PO Number" required>
                <Input value={editForm.po_number} onChange={e => setEditForm({ ...editForm, po_number: e.target.value })} />
              </Field>
              <Field label="Customer" required>
                <Select value={editForm.customer_id} onChange={e => setEditForm({ ...editForm, customer_id: e.target.value, lines: [{ ...emptyLine }] })}>
                  <option value="">Select customer…</option>
                  {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="PO Date">
                <Input type="date" value={editForm.po_date} onChange={e => setEditForm({ ...editForm, po_date: e.target.value })} />
              </Field>
              <Field label="Delivery Date">
                <Input type="date" value={editForm.delivery_date} onChange={e => setEditForm({ ...editForm, delivery_date: e.target.value })} />
              </Field>
              </div>
            </section>

            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Order Lines</span><span>{editForm.lines.length} lines</span></div>
              <div className="space-y-2">
              {editForm.lines.map((l, i) => {
                const prod = products.find(p => String(p.id) === String(l.product_id));
                return (
                  <div key={l.id ?? `new-${i}`} className="ci-line-item">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_110px_110px_120px_68px] md:items-start">
                      <div className="flex h-10 items-center justify-center rounded-lg bg-slate-50 text-xs font-black tabular-nums text-slate-400">
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0">
                        <Select value={l.product_id} onChange={e => {
                          const p = products.find(x => String(x.id) === e.target.value);
                          setEditLine(i, { product_id: e.target.value, rate: p?.rate ?? '' });
                        }}>
                          <option value="">{editForm.customer_id ? 'Select product…' : 'Pick a customer first'}</option>
                          {editProducts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                        </Select>
                        <ProductSpec product={prod} />
                      </div>
                      <Input type="number" min={Math.max(1, l.dispatched_qty || 0)} placeholder="Qty" value={l.qty} onChange={e => setEditLine(i, { qty: e.target.value })} />
                      <Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setEditLine(i, { rate: e.target.value })} />
                      <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                        {l.qty && l.rate ? fmt.inr(l.qty * l.rate) : '—'}
                        {l.status && <div className="mt-1"><StatusBadge status={l.status} /></div>}
                      </div>
                      <div className="flex h-10 items-center justify-end gap-1">
                        <button type="button" title="Clone line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600" onClick={() => cloneEditLine(i)}>
                          <Copy size={14} />
                        </button>
                        <button
                          type="button"
                          title="Delete line"
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-300"
                          disabled={editForm.lines.length === 1}
                          onClick={() => setEditForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => setEditForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }))}>
                <Plus size={13} /> Add line
              </Button>
              </div>
            </section>

            <section className="ci-form-panel">
              <Field label="Notes"><Textarea value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} /></Field>
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
