// Masters — one generic CRUD engine, five tables + users, zero drift.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import { Button, ConfirmDialog, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { Plus, Pencil, Trash2 } from 'lucide-react';

const CONFIGS = {
  customers: {
    label: 'Customers', endpoint: '/customers',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'segment', label: 'Segment', type: 'select', options: ['pharma', 'fmcg'], required: true },
      { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'contact', label: 'Contact Person' }, { key: 'phone', label: 'Phone' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], render: v => (v ? 'Yes' : 'No') },
    ],
    columns: ['name', 'segment', 'city', 'contact', 'phone'],
  },
  products: {
    label: 'Products', endpoint: '/products',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'code', label: 'Code', required: true },
      { key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true },
      { key: 'board_material_id', label: 'Board', type: 'ref', ref: 'materials', filter: m => m.category === 'board', required: true },
      { key: 'gsm', label: 'GSM', type: 'number' },
      { key: 'size', label: 'Size (L×W×H)' },
      { key: 'ups', label: 'Ups per Sheet', type: 'number', required: true },
      { key: 'wastage_pct', label: 'Wastage %', type: 'number' },
      { key: 'colors', label: 'Colours', type: 'number' },
      { key: 'coating', label: 'Coating', type: 'select', options: ['none', 'aqueous', 'uv', 'matt_lam', 'gloss_lam'] },
      { key: 'special', label: 'Special', type: 'select', options: ['none', 'foil', 'emboss', 'foil_emboss', 'window'] },
      { key: 'rate', label: 'Rate ₹/carton', type: 'number', required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'code', 'customer_name', 'board_name', 'ups', 'coating', 'rate'],
  },
  machines: {
    label: 'Machines', endpoint: '/machines',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'type', label: 'Type', type: 'select', options: ['printing', 'coating', 'foiling', 'embossing', 'die_cutting', 'pasting'], required: true },
      { key: 'capacity_per_hour', label: 'Capacity / hour', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: ['running', 'idle', 'maintenance'] },
    ],
    columns: ['name', 'type', 'capacity_per_hour', 'status'],
  },
  materials: {
    label: 'Materials', endpoint: '/materials',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'category', label: 'Category', type: 'select', options: ['board', 'ink', 'foil', 'adhesive', 'laminate', 'other'], required: true },
      { key: 'spec', label: 'Specification' },
      { key: 'unit', label: 'Unit', required: true },
      { key: 'reorder_level', label: 'Reorder Level', type: 'number' },
    ],
    columns: ['name', 'category', 'spec', 'unit', 'reorder_level'],
  },
  employees: {
    label: 'Employees', endpoint: '/employees',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'role', label: 'Role', type: 'select', options: ['operator', 'supervisor', 'qc_inspector', 'helper'], required: true },
      { key: 'section', label: 'Section', type: 'select', options: ['printing', 'coating', 'foiling', 'embossing', 'die_cutting', 'pasting', 'qc'] },
      { key: 'phone', label: 'Phone' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'role', 'section', 'phone', 'active'],
  },
  vendors: {
    label: 'Vendors', endpoint: '/vendors',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'city', label: 'City' }, { key: 'contact', label: 'Contact' },
      { key: 'phone', label: 'Phone' }, { key: 'categories', label: 'Supplies (categories)' },
    ],
    columns: ['name', 'city', 'contact', 'phone', 'categories'],
  },
  users: {
    label: 'Users', endpoint: '/users', adminOnly: true, noDelete: true,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email', createOnly: true, required: true },
      { key: 'password', label: 'Password', type: 'password', hint: 'Leave blank to keep unchanged' },
      { key: 'role', label: 'Role', type: 'select', options: ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'], required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'email', 'role', 'active'],
  },
};

export default function Masters() {
  const toast = useToast();
  const isAdmin = auth.user?.role === 'admin';
  const [tab, setTab] = useState('customers');
  const [rows, setRows] = useState([]);
  const [refs, setRefs] = useState({ customers: [], materials: [] });
  const [editing, setEditing] = useState(null); // record or {} for new
  const [deleting, setDeleting] = useState(null);

  const visibleConfigs = Object.entries(CONFIGS).filter(([, c]) => !c.adminOnly || isAdmin);
  const cfg = CONFIGS[tab];
  const load = () => api.get(cfg.endpoint).then(setRows);
  useEffect(() => { load(); }, [tab]);
  useEffect(() => {
    api.get('/customers').then(c => setRefs(r => ({ ...r, customers: c })));
    api.get('/materials').then(m => setRefs(r => ({ ...r, materials: m })));
  }, []);

  const columns = useMemo(() => [
    ...cfg.columns.map(k => {
      const f = cfg.fields.find(x => x.key === k);
      return {
        key: k,
        label: f?.label || fmt.title(k),
        render: r => {
          const v = r[k];
          if (k === 'status' || k === 'segment' || k === 'category' || k === 'coating' || k === 'type' || k === 'role')
            return <span className="text-xs capitalize text-gray-600">{String(v ?? '').replace(/_/g, ' ')}</span>;
          if (k === 'active') return v ? <span className="text-xs font-semibold text-emerald-600">Active</span> : <span className="text-xs text-gray-400">Inactive</span>;
          if (k === 'rate') return `₹${v}`;
          return v ?? '—';
        },
      };
    }),
    { key: '_act', label: '', render: r => (
      <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
        <button className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" onClick={() => setEditing(r)}><Pencil size={14} /></button>
        {!cfg.noDelete && (
          <button className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600" onClick={() => setDeleting(r)}><Trash2 size={14} /></button>
        )}
      </div>) },
  ], [tab, cfg]);

  const save = async () => {
    const body = {};
    for (const f of cfg.fields) {
      if (editing.id && f.createOnly) continue;               // e.g. email
      let v = editing[f.key];
      if (f.type === 'password' && !v) continue;              // blank = unchanged
      if (f.type === 'number' || f.type === 'ref') v = v === '' || v == null ? null : +v;
      body[f.key] = v;
    }
    if (editing.id) await api.put(`${cfg.endpoint}/${editing.id}`, body);
    else await api.post(cfg.endpoint, body);
    toast.success(editing.id ? 'Updated' : 'Created');
    setEditing(null); load();
  };

  const remove = async () => {
    await api.del(`${cfg.endpoint}/${deleting.id}`);
    toast.success('Deleted'); load();
  };

  return (
    <div>
      <PageHeader title="Masters" subtitle="Customers, products, machines, materials, employees, vendors — and users"
        actions={<Button onClick={() => setEditing({})}><Plus size={15} /> New {cfg.label.slice(0, -1)}</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={visibleConfigs.map(([k, c]) => ({ key: k, label: c.label }))} />
      <DataTable searchable columns={columns} rows={rows} empty={`No ${cfg.label.toLowerCase()} yet`} />

      <Modal open={!!editing} onClose={() => setEditing(null)} wide={tab === 'products'}
        title={`${editing?.id ? 'Edit' : 'New'} ${cfg.label.slice(0, -1)}`}
        footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={save} disabled={cfg.fields.some(f => {
            if (editing?.id && (f.createOnly || f.type === 'password')) return false;
            if (!editing?.id && f.type === 'password' && tab === 'users') return !editing?.[f.key]; // password required on create
            return f.required && !editing?.[f.key] && editing?.[f.key] !== 0;
          })}>Save</Button>
        </>}>
        {editing && (
          <div className={`grid gap-3 ${tab === 'products' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {cfg.fields.map(f => (
              <Field key={f.key} label={f.label} required={f.required} hint={editing.id ? f.hint : undefined}>
                {f.type === 'select' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {f.options.map(o => <option key={o} value={o}>{typeof o === 'number' ? (o ? 'Yes' : 'No') : fmt.title(String(o))}</option>)}
                  </Select>
                ) : f.type === 'ref' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">Select…</option>
                    {(refs[f.ref] || []).filter(f.filter || (() => true)).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </Select>
                ) : (
                  <Input type={f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}
                    value={editing[f.key] ?? ''}
                    disabled={!!editing.id && f.createOnly}
                    onChange={e => setEditing({ ...editing, [f.key]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} danger
        title="Delete record?" confirmLabel="Delete"
        message={`Delete "${deleting?.name}"? Records in use elsewhere cannot be deleted — mark them inactive instead.`} />
    </div>
  );
}
