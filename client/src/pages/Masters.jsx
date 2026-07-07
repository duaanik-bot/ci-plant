// Masters — one generic CRUD engine, five tables + users, zero drift.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt, auth } from '../api.js';
import { Button, ConfirmDialog, DataTable, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, useToast } from '../components/ui.jsx';
import { Plus, Pencil, Trash2, Power } from 'lucide-react';
import { MODULES } from '../modules.js';

const CONFIGS = {
  customers: {
    label: 'Customers', endpoint: '/customers',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'segment', label: 'Segment', type: 'select', options: ['pharma', 'fmcg'], required: true },
      { key: 'city', label: 'City' }, { key: 'state', label: 'State' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'contact', label: 'Contact Person' }, { key: 'phone', label: 'Phone' },
      { key: 'tolerance_pct', label: 'Dispatch Tolerance %', type: 'number', hint: 'Allowed excess/short dispatch vs ordered qty — snapshotted on each new sales order' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0], render: v => (v ? 'Yes' : 'No') },
    ],
    columns: ['name', 'segment', 'city', 'contact', 'phone', 'tolerance_pct'],
  },
  products: {
    label: 'Products', endpoint: '/products',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'code', label: 'Code', required: true },
      { key: 'customer_id', label: 'Customer', type: 'ref', ref: 'customers', required: true },
      { key: 'board_material_id', label: 'Board', type: 'ref', ref: 'materials', filter: m => m.category === 'board', required: true },
      { key: 'gsm', label: 'GSM', type: 'number' },
      { key: 'size', label: 'Carton Size (L×W×H)' },
      { key: 'child_l', label: 'Print Sheet Length (in)', type: 'number', hint: 'Child sheet — e.g. 18' },
      { key: 'child_w', label: 'Print Sheet Width (in)', type: 'number', hint: 'Child sheet — e.g. 23' },
      { key: 'ups', label: 'Ups per Print Sheet', type: 'number', required: true },
      { key: 'wastage_pct', label: 'Wastage %', type: 'number' },
      { key: 'colors', label: 'Colours', type: 'number' },
      { key: 'coating', label: 'Coating', type: 'select', options: ['none', 'aqueous', 'uv', 'matt_lam', 'gloss_lam'] },
      { key: 'special', label: 'Special', type: 'select', options: ['none', 'foil', 'emboss', 'foil_emboss', 'window'] },
      { key: 'tool_id', label: 'Die', type: 'ref', ref: 'dies', hint: 'Managed in the Tooling Hub' },
      { key: 'product_type', label: 'Product Type', type: 'gstref', hint: 'Sets the default GST — carton 5%, labels/leaflets/shippers 18%' },
      { key: 'gst_pct', label: 'GST % Override', type: 'select', options: [5, 12, 18], hint: 'Leave blank to use the Product Type default' },
      { key: 'rate', label: 'Rate ₹/carton', type: 'number', required: true },
      { key: 'spec_incomplete', label: 'Spec Incomplete', type: 'select', options: [0, 1], render: v => (v ? 'Yes' : 'No'), hint: 'Set by PO-import quick-create — switch to 0 once board & spec are real' },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'code', 'customer_name', 'board_name', 'child_size', 'ups', 'die_number', 'product_type', 'gst_pct', 'rate'],
  },
  gst_rates: {
    label: 'GST Rates', endpoint: '/gst_rates',
    fields: [
      { key: 'label', label: 'Product Type', required: true, hint: 'Display name, e.g. Carton, Labels' },
      { key: 'product_type', label: 'Type Code', required: true, hint: 'Lower-case key, e.g. carton, shipper_label — links products to this rate' },
      { key: 'rate', label: 'GST %', type: 'number', required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['label', 'product_type', 'rate', 'active'],
  },
  machines: {
    label: 'Machines', endpoint: '/machines', operatorMapping: true, activeToggle: true,
    fields: [
      { key: 'name', label: 'Machine Name', required: true },
      { key: 'model', label: 'Make / Model', hint: 'e.g. Komori Lithrone 5-Colour — shown on the Print Planning board' },
      { key: 'type', label: 'Category', type: 'select', options: ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting'], required: true },
      { key: 'capacity_per_hour', label: 'Capacity / hour', type: 'number' },
      { key: 'status', label: 'Status', type: 'select', options: ['running', 'idle', 'maintenance'] },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'model', 'type', 'operators', 'capacity_per_hour', 'status', 'active'],
  },
  materials: {
    label: 'Materials', endpoint: '/materials',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'category', label: 'Category', type: 'select', options: ['board', 'ink', 'foil', 'adhesive', 'laminate', 'other'], required: true },
      { key: 'spec', label: 'Specification' },
      { key: 'unit', label: 'Unit', required: true },
      { key: 'sheet_l', label: 'Parent Sheet Length (in)', type: 'number', hint: 'Boards only — e.g. 25' },
      { key: 'sheet_w', label: 'Parent Sheet Width (in)', type: 'number', hint: 'Boards only — e.g. 36' },
      { key: 'reorder_level', label: 'Reorder Level', type: 'number' },
    ],
    columns: ['name', 'category', 'sheet_size', 'unit', 'reorder_level'],
  },
  employees: {
    label: 'Employees', endpoint: '/employees',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'role', label: 'Role', type: 'select', options: ['operator', 'supervisor', 'qc_inspector', 'helper'], required: true },
      { key: 'section', label: 'Section', type: 'select', options: ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting', 'sorting', 'pasting', 'qc'] },
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
    label: 'Users', endpoint: '/users', adminOnly: true, noDelete: true, moduleAccess: true,
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email', createOnly: true, required: true },
      { key: 'password', label: 'Password', type: 'password', hint: 'Leave blank to keep unchanged' },
      { key: 'role', label: 'Role', type: 'select', options: ['admin', 'planner', 'production', 'qc', 'dispatch', 'viewer'], required: true },
      { key: 'active', label: 'Active', type: 'select', options: [1, 0] },
    ],
    columns: ['name', 'email', 'role', 'modules', 'active'],
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
    api.get('/tools?family=die').then(d => setRefs(r => ({ ...r, dies: d })));
    api.get('/gst_rates').then(g => setRefs(r => ({ ...r, gst_rates: g })));
    api.get('/employees').then(e => setRefs(r => ({ ...r, employees: e })));
  }, []);

  const columns = useMemo(() => [
    ...cfg.columns.map(k => {
      const f = cfg.fields.find(x => x.key === k);
      return {
        key: k,
        label: f?.label || fmt.title(k),
        render: r => {
          const v = r[k];
          if (k === 'sheet_size') return r.sheet_l ? <span className="font-mono text-xs">{r.sheet_l}×{r.sheet_w}"</span> : (v ? <span className="font-mono text-xs">{v}</span> : <span className="text-gray-300">—</span>);
          if (k === 'condition') return <span className={`text-xs font-semibold ${v === 'Good' ? 'text-emerald-600' : v === 'Fair' ? 'text-amber-600' : 'text-red-600'}`}>{v}</span>;
          if (k === 'product_count') return v ? `${v} product${v > 1 ? 's' : ''}` : <span className="text-gray-300">—</span>;
          if (k === 'tolerance_pct') return v ? <span className="font-semibold tabular-nums text-slate-700">±{v}%</span> : <span className="text-gray-300">—</span>;
          if (k === 'operators') {
            const ops = r.operators || [];
            return ops.length
              ? <div className="flex max-w-[260px] flex-wrap gap-1">{ops.map(o0 => (
                  <span key={o0.id} className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">{o0.name}</span>))}</div>
              : <span className="text-xs text-amber-600">No operators assigned</span>;
          }
          if (k === 'modules') {
            if (r.role === 'admin') return <span className="text-xs font-semibold text-slate-500">All (admin)</span>;
            if (r.modules == null) return <span className="text-xs font-semibold text-emerald-600">All modules</span>;
            return <span className="text-xs font-semibold text-brand-700">{r.modules.length} of {MODULES.length} modules</span>;
          }
          if (k === 'die_number' && cfg.endpoint === '/products') return v || <span className="text-gray-300">—</span>;
          if (k === 'name' && cfg.endpoint === '/products' && r.spec_incomplete)
            return <span className="inline-flex items-center gap-2">{v}
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Spec incomplete</span></span>;
          if (k === 'child_size') return r.child_l ? <span className="font-mono text-xs">{r.child_l}×{r.child_w}"</span> : <span className="text-gray-300">—</span>;
          if (k === 'status' || k === 'segment' || k === 'category' || k === 'coating' || k === 'type' || k === 'role')
            return <span className="text-xs capitalize text-gray-600">{String(v ?? '').replace(/_/g, ' ')}</span>;
          if (k === 'active') return v ? <span className="text-xs font-semibold text-emerald-600">Active</span> : <span className="text-xs text-gray-400">Inactive</span>;
          if (k === 'rate') return cfg.endpoint === '/gst_rates' ? `${v}%` : `₹${v}`;
          if (k === 'gst_pct') {
            const eff = r.effective_gst ?? v;
            if (eff == null) return <span className="text-gray-300">—</span>;
            return <span title={v != null ? 'Manual override' : 'From product type'}>{eff}%{v == null && r.product_type ? <span className="ml-1 text-[10px] text-gray-400">auto</span> : null}</span>;
          }
          if (k === 'product_type') return v ? <span className="text-xs capitalize text-gray-600">{String(v).replace(/_/g, ' ')}</span> : <span className="text-gray-300">—</span>;
          return v ?? '—';
        },
      };
    }),
    { key: '_act', label: '', render: r => (
      <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
        {cfg.activeToggle && (
          <button
            className={`rounded p-1.5 ${r.active
              ? 'text-emerald-500 hover:bg-amber-50 hover:text-amber-600'
              : 'text-gray-300 hover:bg-emerald-50 hover:text-emerald-600'}`}
            title={r.active ? 'Deactivate' : 'Activate'}
            onClick={() => toggleActive(r)}><Power size={14} /></button>
        )}
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
      if (f.key === 'active' && (v == null || v === '')) v = 1;        // default: active
      if (f.key === 'tolerance_pct' && v == null) v = 0;               // blank = no tolerance
      if (f.key === 'spec_incomplete' && (v == null || v === '')) v = 0; // blank = spec complete
      body[f.key] = v;
    }
    // Module access travels with the user save — null means every module.
    if (cfg.moduleAccess) body.modules = Array.isArray(editing.modules) ? editing.modules : null;
    const saved = editing.id
      ? await api.put(`${cfg.endpoint}/${editing.id}`, body)
      : await api.post(cfg.endpoint, body);
    // Machine ↔ operator mapping travels with the same save.
    if (cfg.operatorMapping && (saved?.id || editing.id)) {
      await api.put(`/machines/${saved?.id ?? editing.id}/operators`, {
        employee_ids: (editing.operators || []).map(o => o.id),
      });
    }
    toast.success(editing.id ? 'Updated' : 'Created');
    setEditing(null); load();
  };

  const remove = async () => {
    await api.del(`${cfg.endpoint}/${deleting.id}`);
    toast.success('Deleted'); load();
  };

  const toggleActive = async (row) => {
    const next = row.active ? 0 : 1;
    await api.put(`${cfg.endpoint}/${row.id}`, { active: next });
    toast.success(next ? 'Activated' : 'Deactivated'); load();
  };

  return (
    <div>
      <PageHeader title="Masters" subtitle="Customers, products, machines, materials, employees, vendors — and users"
        actions={<Button onClick={() => setEditing({})}><Plus size={15} /> New {cfg.label.slice(0, -1)}</Button>} />
      <Tabs active={tab} onChange={setTab} tabs={visibleConfigs.map(([k, c]) => ({ key: k, label: c.label }))} />
      <DataTable searchable columns={columns} rows={rows} empty={`No ${cfg.label.toLowerCase()} yet`}
        exportName={`${cfg.label} Master`}
        exportSubtitle={`Masters · ${cfg.label}`} />

      <Modal open={!!editing} onClose={() => setEditing(null)} wide={tab === 'products' || tab === 'machines'}
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
                    {f.options.map(o => <option key={o} value={o}>{
                      typeof o === 'number'
                        ? (f.key === 'active' ? (o ? 'Yes' : 'No') : (f.key === 'gst_pct' ? `${o}%` : o))
                        : (f.key === 'condition' ? o : fmt.title(String(o)))
                    }</option>)}
                  </Select>
                ) : f.type === 'gstref' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">—</option>
                    {(refs.gst_rates || []).filter(x => x.active).map(x => (
                      <option key={x.id} value={x.product_type}>{x.label} — {x.rate}%</option>))}
                  </Select>
                ) : f.type === 'ref' ? (
                  <Select value={editing[f.key] ?? ''} onChange={e => setEditing({ ...editing, [f.key]: e.target.value })}>
                    <option value="">Select…</option>
                    {(refs[f.ref] || []).filter(f.filter || (() => true)).map(x => (
                      <option key={x.id} value={x.id}>
                        {x.name ?? `${x.code}${x.carton_size ? ` — ${x.carton_size}` : ''}${x.condition && x.condition !== 'Good' ? ` (${x.condition})` : ''}`}
                      </option>))}
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
        {/* Per-user module access — check exactly what this user may open.
            Unrestricted (null) = every module their role allows; admins
            always see everything regardless of this list. */}
        {editing && cfg.moduleAccess && (() => {
          if (editing.role === 'admin') {
            return (
              <div className="mt-4 rounded-2xl border border-slate-200 p-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Module Access</h4>
                <p className="mt-1.5 text-xs text-slate-500">Admins always have every module — change the role to restrict access.</p>
              </div>
            );
          }
          const restricted = Array.isArray(editing.modules);
          const checked = k => !restricted || editing.modules.includes(k);
          const toggle = k => setEditing(ed => {
            const cur = Array.isArray(ed.modules) ? ed.modules : MODULES.map(m => m.key);
            return { ...ed, modules: cur.includes(k) ? cur.filter(x => x !== k) : [...cur, k] };
          });
          const count = restricted ? editing.modules.length : MODULES.length;
          return (
            <div className="mt-4 rounded-2xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Module Access</h4>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-400">
                    {restricted ? `${count} of ${MODULES.length} modules open` : 'Full access — all modules'}
                  </span>
                  {restricted && (
                    <button type="button" className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600 hover:bg-slate-200"
                      onClick={() => setEditing(ed => ({ ...ed, modules: null }))}>
                      Grant all
                    </button>
                  )}
                </div>
              </div>
              <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                {MODULES.map(m => (
                  <label key={m.key} className={`flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors ${checked(m.key) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>
                    <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                      checked={checked(m.key)} onChange={() => toggle(m.key)} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{m.label}</span>
                  </label>
                ))}
              </div>
              {restricted && count === 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                  No modules selected — this user won't be able to open anything after signing in.
                </p>
              )}
            </div>
          );
        })()}
        {editing && cfg.operatorMapping && (() => {
          const selected = new Set((editing.operators || []).map(o => o.id));
          const crew = (refs.employees || []).filter(e => e.active);
          // Employees from this machine's section float to the top of the list.
          const sorted = [...crew].sort((a, b) =>
            (b.section === editing.type) - (a.section === editing.type) || a.name.localeCompare(b.name));
          const toggle = emp => setEditing(ed => {
            const has = (ed.operators || []).some(o => o.id === emp.id);
            return { ...ed, operators: has ? ed.operators.filter(o => o.id !== emp.id) : [...(ed.operators || []), emp] };
          });
          return (
            <div className="mt-4 rounded-2xl border border-slate-200 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Assigned Operators</h4>
                <span className="text-[11px] font-semibold text-slate-400">{selected.size} assigned — production entry shows only these</span>
              </div>
              {crew.length === 0 && <p className="py-2 text-xs text-slate-400">No active employees yet — add them in the Employees tab first.</p>}
              <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                {sorted.map(emp => (
                  <label key={emp.id} className={`flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm transition-colors ${selected.has(emp.id) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>
                    <input type="checkbox" className="h-4 w-4 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                      checked={selected.has(emp.id)} onChange={() => toggle(emp)} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{emp.name}</span>
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">{(emp.section || emp.role || '').replace(/_/g, ' ')}</span>
                  </label>
                ))}
              </div>
              {selected.size === 0 && editing.id && (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
                  No operators assigned — start-run forms on this machine will show the whole section crew until you assign someone.
                </p>
              )}
            </div>
          );
        })()}
      </Modal>

      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={remove} danger
        title="Delete record?" confirmLabel="Delete"
        message={`Delete "${deleting?.name ?? 'this record'}"? Records in use elsewhere cannot be deleted — mark them inactive instead.`} />
    </div>
  );
}
