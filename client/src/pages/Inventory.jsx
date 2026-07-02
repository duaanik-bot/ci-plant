// Inventory — one stock truth: position, batches, movement ledger, FG.
import { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Plus } from 'lucide-react';

export default function Inventory() {
  const toast = useToast();
  const [tab, setTab] = useState('stock');
  const [stock, setStock] = useState([]);
  const [batches, setBatches] = useState([]);
  const [moves, setMoves] = useState([]);
  const [fg, setFg] = useState([]);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adj, setAdj] = useState({ material_id: '', qty: '', batch_no: '', note: '' });

  const load = () => {
    api.get('/inventory/stock').then(setStock);
    api.get('/inventory/batches').then(setBatches);
    api.get('/inventory/movements').then(setMoves);
    api.get('/inventory/fg').then(setFg);
  };
  useEffect(() => { load(); }, []);

  const saveAdj = async () => {
    await api.post('/inventory/adjust', { ...adj, material_id: +adj.material_id, qty: +adj.qty });
    toast.success('Stock adjusted');
    setAdjOpen(false); setAdj({ material_id: '', qty: '', batch_no: '', note: '' });
    load();
  };

  return (
    <div>
      <PageHeader title="Warehouse" subtitle="Raw material and finished goods, live — every change is a ledger entry"
        actions={<Button variant="secondary" onClick={() => setAdjOpen(true)}><Plus size={15} /> Adjustment</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'stock', label: 'RM Stock' },
        { key: 'fg', label: 'FG Stock', count: fg.length },
        { key: 'batches', label: 'RM Batches' },
        { key: 'moves', label: 'Movement Ledger' },
      ]} />

      {tab === 'stock' && (
        <DataTable
          columns={[
            { key: 'name', label: 'Material', render: m => (<div><div className="font-semibold">{m.name}</div><div className="text-xs text-gray-400">{m.spec}</div></div>) },
            { key: 'category', label: 'Category', render: m => <StatusBadge status={m.category === 'board' ? 'open' : 'pending'} /> && <span className="text-xs capitalize text-gray-500">{m.category}</span> },
            { key: 'available', label: 'Available', align: 'right', render: m => <span className={`font-bold tabular-nums ${m.short ? 'text-red-600' : 'text-gray-900'}`}>{fmt.num(m.available)} {m.unit}</span> },
            { key: 'quarantine', label: 'Quarantine', align: 'right', render: m => <span className="tabular-nums text-amber-600">{fmt.num(m.quarantine)}</span> },
            { key: 'demand', label: 'Committed Demand', align: 'right', render: m => <span className="tabular-nums">{fmt.num(m.demand)}</span> },
            { key: 'reorder_level', label: 'Reorder Level', align: 'right', render: m => fmt.num(m.reorder_level) },
            { key: 'short', label: 'Health', render: m => m.short
                ? <span className="text-xs font-bold text-red-600">SHORT</span>
                : <span className="text-xs font-semibold text-emerald-600">OK</span> },
          ]}
          rows={stock} />
      )}

      {tab === 'fg' && (
        <DataTable
          columns={[
            { key: 'product_name', label: 'Product', render: f => (<div><div className="font-semibold">{f.product_name}</div><div className="text-xs text-gray-400">{f.code}</div></div>) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Cartons in Stock', align: 'right', render: f => <span className="font-bold tabular-nums">{fmt.num(f.qty)}</span> },
            { key: 'value', label: 'Value', align: 'right', render: f => fmt.inr(f.qty * f.rate) },
          ]}
          rows={fg} empty="No finished goods in stock" />
      )}

      {tab === 'batches' && (
        <DataTable searchable
          columns={[
            { key: 'batch_no', label: 'Batch', render: b => <span className="font-mono text-xs font-semibold">{b.batch_no}</span> },
            { key: 'material_name', label: 'Material' },
            { key: 'qty', label: 'Remaining', align: 'right', render: b => `${fmt.num(b.qty)} ${b.unit}` },
            { key: 'initial_qty', label: 'Received', align: 'right', render: b => fmt.num(b.initial_qty) },
            { key: 'status', label: 'Status', render: b => <StatusBadge status={b.status} /> },
            { key: 'created_at', label: 'Received On', render: b => fmt.date(b.created_at) },
          ]}
          rows={batches} />
      )}

      {tab === 'moves' && (
        <DataTable searchable
          columns={[
            { key: 'created_at', label: 'When', render: m => fmt.dt(m.created_at) },
            { key: 'type', label: 'Type', render: m => <StatusBadge status={m.type === 'consumption' || m.type === 'dispatch' ? 'cancelled' : m.type === 'grn' ? 'quarantine' : 'available'} /> && <span className="text-xs font-semibold capitalize">{m.type.replace('_', ' ')}</span> },
            { key: 'material_name', label: 'Item', render: m => m.material_name || m.product_name || '—' },
            { key: 'qty', label: 'Qty', align: 'right', render: m => <span className={`font-bold tabular-nums ${m.qty < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{m.qty > 0 ? '+' : ''}{fmt.num(m.qty)}</span> },
            { key: 'note', label: 'Note', render: m => <span className="text-xs text-gray-500">{m.note || `${m.ref_type || ''} #${m.ref_id || ''}`}</span> },
          ]}
          rows={moves} />
      )}

      <Modal open={adjOpen} onClose={() => setAdjOpen(false)} title="Stock Adjustment"
        footer={<>
          <Button variant="secondary" onClick={() => setAdjOpen(false)}>Cancel</Button>
          <Button onClick={saveAdj} disabled={!adj.material_id || !adj.qty}>Save</Button>
        </>}>
        <div className="space-y-3">
          <Field label="Material" required>
            <Select value={adj.material_id} onChange={e => setAdj({ ...adj, material_id: e.target.value })}>
              <option value="">Select material…</option>
              {stock.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Quantity (negative to reduce)" required>
            <Input type="number" value={adj.qty} onChange={e => setAdj({ ...adj, qty: e.target.value })} placeholder="e.g. 5000 or -1200" />
          </Field>
          <Field label="Batch No (for additions)"><Input value={adj.batch_no} onChange={e => setAdj({ ...adj, batch_no: e.target.value })} /></Field>
          <Field label="Reason"><Textarea value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
