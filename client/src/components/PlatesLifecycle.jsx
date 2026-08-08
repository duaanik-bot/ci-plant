import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Eye, FileCheck2, History,
  Minus, PackagePlus, Plus, Printer, RotateCcw, Save, Send, ShoppingBag,
  Trash2, Truck, Warehouse,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import {
  ActionMenu, Button, Checkbox, DataTable, Field, FulfillmentBar, Input,
  KpiCard, Modal, PageHeader, SearchableSelect, Select, SubTabs, Tabs,
  Textarea, useToast,
} from './ui.jsx';
import ProductIdentity from './ProductIdentity.jsx';

const TONE = {
  verification_required: 'bg-amber-50 text-amber-700',
  existing_plate_check: 'bg-slate-100 text-slate-600',
  verified_existing: 'bg-emerald-50 text-emerald-700',
  pr_required: 'bg-orange-50 text-orange-700',
  replacement_required: 'bg-red-50 text-red-700',
  approved: 'bg-blue-50 text-blue-700',
  po_created: 'bg-cyan-50 text-cyan-700',
  ordered: 'bg-cyan-50 text-cyan-700',
  grn_received: 'bg-emerald-50 text-emerald-700',
  available: 'bg-emerald-50 text-emerald-700',
  reserved: 'bg-emerald-50 text-emerald-700',
  issued: 'bg-violet-50 text-violet-700',
  returned_pending_verification: 'bg-amber-50 text-amber-700',
  damaged: 'bg-red-50 text-red-700',
  scrapped: 'bg-slate-200 text-slate-600',
  ready: 'bg-emerald-50 text-emerald-700',
  procurement: 'bg-blue-50 text-blue-700',
  rack_reserved: 'bg-emerald-50 text-emerald-700',
  draft: 'bg-slate-100 text-slate-600',
  saved: 'bg-amber-50 text-amber-700',
  converted: 'bg-blue-50 text-blue-700',
  reversed: 'bg-red-50 text-red-700',
  pending: 'bg-slate-100 text-slate-600',
  available_asset: 'bg-emerald-50 text-emerald-700',
};

const statusLabel = value => ({
  draft: 'Draft', saved: 'Saved', approved: 'Approved', converted: 'PO created',
  verification_required: 'Verify rack', verified_existing: 'Existing & verified',
  pr_required: 'PR required', replacement_required: 'Replacement required',
  po_created: 'PO raised', grn_received: 'GRN received',
  returned_pending_verification: 'Verify return', issued_to_printing: 'Issued to printing',
  reversed: 'Reversed', mixed: 'Mixed status',
}[value] || fmt.title(value || 'pending'));

function StatusChip({ value }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-bold ${TONE[value] || 'bg-slate-100 text-slate-600'}`}>{statusLabel(value)}</span>;
}

const canManage = () => ['admin', 'planner'].includes(auth.user?.role);
const canVerify = () => ['admin', 'planner', 'qc'].includes(auth.user?.role);
const emptyPo = () => ({ vendor_id: '', expected_date: '', rate: '', gst_rate: '18', discount_pct: '',
  payment_terms: '', delivery_terms: '', reference: '', vendor_notes: '', tax_kind: 'intra', freight: '', round_off: '' });

const PROCESS_PLATES = [
  ['cyan','Cyan'],['magenta','Magenta'],['yellow','Yellow'],['black','Black'],
];
const componentKey = component => `${component.component_type}|${component.component_type === 'pantone'
  ? String(component.pantone_code || component.component_label || '').trim().toLowerCase() : ''}`;

function groupedComponents(components = []) {
  const groups = new Map();
  for (const component of components.filter(row => row.status !== 'cancelled')) {
    const key = componentKey(component);
    const group = groups.get(key) || {
      key, component_type: component.component_type, component_label: component.component_label,
      pantone_code: component.pantone_code || null, qty: 0, component_ids: [], statuses: [],
    };
    group.qty += 1; group.component_ids.push(component.id); group.statuses.push(component.status);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    status: group.statuses.every(value => value === group.statuses[0]) ? group.statuses[0] : 'mixed',
  }));
}

function requirementDraft(request) {
  const grouped = groupedComponents(request.components);
  const byType = new Map(grouped.filter(row => row.component_type !== 'pantone').map(row => [row.component_type,row]));
  return {
    plate_master_id: request.components.find(row => row.plate_master_id)?.plate_master_id || '',
    vendor_id: request.vendor_id || '',
    notes: request.notes || '',
    components: [
      ...PROCESS_PLATES.map(([component_type,component_label]) => ({
        component_type, component_label, pantone_code: null, qty: byType.get(component_type)?.qty || 0,
      })),
      ...grouped.filter(row => row.component_type === 'pantone').map(row => ({
        component_type: 'pantone', component_label: row.component_label,
        pantone_code: row.pantone_code, qty: row.qty,
      })),
    ],
  };
}

const draftTotal = draft => (draft?.components || []).reduce((sum,row) => sum + Math.max(0,Number(row.qty)||0),0);

function ComponentStrip({ components = [], compact = false }) {
  return <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
    {groupedComponents(components).map(component => <span key={component.key} title={statusLabel(component.status)}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold ${TONE[component.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${['verified_existing','available','reserved','issued'].includes(component.status) ? 'bg-emerald-500' : component.status === 'verification_required' ? 'bg-amber-500' : component.status === 'scrapped' ? 'bg-slate-400' : 'bg-blue-500'}`} />
      {component.component_label}{component.qty > 1 ? ` x${component.qty}` : ''}
    </span>)}
  </div>;
}

function VerificationModal({ component, onClose, onSaved }) {
  const toast = useToast();
  const [checks, setChecks] = useState({ found: false, condition_ok: false, artwork_ok: false, colour_ok: false, size_ok: false });
  const [note, setNote] = useState('');
  const save = async outcome => {
    await api.post(`/plates/components/${component.id}/verify-existing`, { outcome, ...checks, note: note || undefined });
    toast.success(outcome === 'usable' ? `${component.component_label} reserved from rack` : `${component.component_label} marked for replacement`);
    await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title="Existing Plate · Physical Verification"
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" disabled={Object.values(checks).some(value => !value)} onClick={() => save('usable')}><CheckCircle2 size={14} /> Verified &amp; Usable</Button></>}>
    <div className="space-y-4">
      <div className="ci-summary-panel text-sm">
        <b>{component.component_label}</b> · {component.plate_size || 'Size pending'}
        <span className="block text-xs text-slate-500">{component.proposed_asset_number} · {component.proposed_rack_location || 'Rack not recorded'} · used {component.proposed_use_count || 0} times</span>
      </div>
      <section className="ci-form-panel">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ['found','Plate found'],['condition_ok','Condition is usable'],['artwork_ok','Correct artwork version'],
            ['colour_ok','Correct colour'],['size_ok','Correct plate size'],
          ].map(([key,label]) => <Checkbox key={key} label={label} checked={checks[key]} onChange={() => setChecks(current => ({ ...current, [key]: !current[key] }))} />)}
        </div>
      </section>
      <Field label="Verification note"><Textarea value={note} onChange={event => setNote(event.target.value)} /></Field>
      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
        <Button size="sm" variant="secondary" onClick={() => save('not_found')}>Not Found</Button>
        <Button size="sm" variant="secondary" onClick={() => save('damaged')}>Damaged</Button>
        <Button size="sm" variant="danger" onClick={() => save('scrap')}>Scrap</Button>
        <Button size="sm" variant="ghost" onClick={() => save('replacement')}><RotateCcw size={13} /> Replacement Required</Button>
      </div>
    </div>
  </Modal>;
}

function ApproveModal({ request, draft, masters, onSaveDraft, onClose, onSaved }) {
  const toast = useToast();
  const eligible = new Set(['pr_required','replacement_required','not_found']);
  const currentGroups = groupedComponents(request.components);
  const candidateSource = request.approval_status === 'approved'
    ? groupedComponents(request.components.filter(row => eligible.has(row.status)))
    : (draft.components || []).map(row => {
      const current = currentGroups.find(group => group.key === componentKey(row));
      const currentEligible = request.components.filter(component => componentKey(component) === componentKey(row) && eligible.has(component.status)).length;
      return { ...row, qty: currentEligible + Math.max(0, Number(row.qty) - Number(current?.qty || 0)) };
    });
  const candidates = candidateSource.filter(row => Number(row.qty) > 0);
  const [selectedKeys, setSelectedKeys] = useState(candidates.map(componentKey));
  const save = async () => {
    const fresh = request.approval_status === 'approved' ? request : await onSaveDraft();
    const selected = fresh.components.filter(row => selectedKeys.includes(componentKey(row))
      && ['pr_required','replacement_required'].includes(row.status));
    if (!selected.length) return toast.error('Choose at least one missing plate to approve');
    await api.post(`/plates/requirements/${request.id}/approve`, {
      plate_master_id: +draft.plate_master_id,
      component_ids: selected.map(row => row.id),
    });
    toast.success(`${selected.length} plate${selected.length === 1 ? '' : 's'} approved`);
    await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title="Approve Plate Requirement"
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{request.approval_status!=='approved'&&<Button variant="secondary" onClick={async()=>{ await onSaveDraft(); toast.success('Plate PR saved'); onClose(); }}><Save size={14}/> Save Changes</Button>}<Button variant="success" disabled={!draft.plate_master_id || !selectedKeys.length} onClick={save}>Approve</Button></>}>
    <div className="space-y-4">
      <ProductIdentity row={request} compact />
      <div className="ci-summary-panel text-sm"><b>Plate size</b><span className="ml-2">{masters.find(row=>String(row.id)===String(draft.plate_master_id))?.plate_size || 'Not selected'}</span></div>
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Plate Requirement</span><span>{candidates.filter(row=>selectedKeys.includes(componentKey(row))).reduce((sum,row)=>sum+Number(row.qty),0)} plates</span></div>
        <div className="space-y-2">{candidates.map(row=><Checkbox key={componentKey(row)} checked={selectedKeys.includes(componentKey(row))}
          label={`${row.component_label} x ${row.qty}`} onChange={()=>setSelectedKeys(current=>current.includes(componentKey(row))?current.filter(key=>key!==componentKey(row)):[...current,componentKey(row)])}/>)}</div>
      </section>
    </div>
  </Modal>;
}

function PlatePoModal({ request, components, vendors, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(emptyPo());
  const patch = value => setForm(current => ({ ...current, ...value }));
  const save = async () => {
    if (!form.vendor_id) return toast.error('Choose a vendor');
    const po = await api.post('/plates/purchase-orders', {
      vendor_id: +form.vendor_id, expected_date: form.expected_date || undefined,
      vendor_notes: form.vendor_notes || undefined, payment_terms: form.payment_terms || undefined,
      delivery_terms: form.delivery_terms || undefined, reference: form.reference || undefined,
      tax_kind: form.tax_kind, freight: +form.freight || 0, round_off: +form.round_off || 0,
      groups: [{ request_id: request.id, component_ids: components.map(row => row.id), rate: +form.rate || 0,
        gst_rate: +form.gst_rate || 0, discount_pct: +form.discount_pct || 0 }],
    });
    toast.success(`${po.po_number} created`); await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title="Create Plate Purchase Order" wide
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!form.vendor_id || !components.length} onClick={save}><ShoppingBag size={14} /> Create PO</Button></>}>
    <div className="space-y-4">
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Supplier &amp; delivery</span><span>{components.length}-plate set</span></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor" required><SearchableSelect value={form.vendor_id} onChange={event => patch({ vendor_id: event.target.value })}
            options={[{ value: '', label: 'Choose vendor' }, ...vendors.map(row => ({ value: String(row.id), label: row.name }))]} /></Field>
          <Field label="Expected Delivery"><Input type="date" value={form.expected_date} onChange={event => patch({ expected_date: event.target.value })} /></Field>
        </div>
      </section>
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>{request.product_name}</span><span>{request.jc_number}</span></div>
        <ComponentStrip components={components} />
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Rate / Plate"><Input type="number" min="0" value={form.rate} onChange={event => patch({ rate: event.target.value })} /></Field>
          <Field label="GST %"><Input type="number" min="0" value={form.gst_rate} onChange={event => patch({ gst_rate: event.target.value })} /></Field>
          <Field label="Discount %"><Input type="number" min="0" value={form.discount_pct} onChange={event => patch({ discount_pct: event.target.value })} /></Field>
        </div>
      </section>
      <section className="ci-form-panel"><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Payment Terms"><Input value={form.payment_terms} onChange={event => patch({ payment_terms: event.target.value })} /></Field>
        <Field label="Delivery Terms"><Input value={form.delivery_terms} onChange={event => patch({ delivery_terms: event.target.value })} /></Field>
        <Field label="Reference"><Input value={form.reference} onChange={event => patch({ reference: event.target.value })} /></Field>
        <Field label="Vendor Notes"><Input value={form.vendor_notes} onChange={event => patch({ vendor_notes: event.target.value })} /></Field>
      </div></section>
    </div>
  </Modal>;
}

function PlateGrnModal({ po, line, onClose, onSaved }) {
  const toast = useToast();
  const outstanding = (line.components || []).filter(row => ['po_created','ordered'].includes(row.status));
  const [selected, setSelected] = useState(outstanding.map(row => row.id));
  const [form, setForm] = useState({ rack_location: 'GRN staging', condition: 'Good', batch_no: '', vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '', remarks: '' });
  const patch = value => setForm(current => ({ ...current, ...value }));
  const save = async () => {
    if (!selected.length) return toast.error('Choose at least one received plate');
    const grn = await api.post('/plates/grns', { po_line_id: line.id, component_ids: selected, ...form });
    toast.success(`${grn.grn_number} received · ${selected.length} plates ready`); await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title={`Plate GRN · ${po.po_number}`} wide
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" disabled={!selected.length} onClick={save}><PackagePlus size={14} /> Receive Plates</Button></>}>
    <div className="space-y-4">
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>{line.product_name}</span><span>{line.jc_number}</span></div>
        <div className="space-y-2">{outstanding.map(component => <Checkbox key={component.id} checked={selected.includes(component.id)} label={component.component_label}
          onChange={() => setSelected(current => current.includes(component.id) ? current.filter(id => id !== component.id) : [...current, component.id])} />)}</div>
      </section>
      <section className="ci-form-panel"><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Temporary / Rack Location" required><Input value={form.rack_location} onChange={event => patch({ rack_location: event.target.value })} /></Field>
        <Field label="Condition"><Select value={form.condition} onChange={event => patch({ condition: event.target.value })}><option>Good</option><option>Fair</option><option>Damaged</option></Select></Field>
        <Field label="Batch / Vendor Reference"><Input value={form.batch_no} onChange={event => patch({ batch_no: event.target.value })} /></Field>
        <Field label="Vehicle No"><Input value={form.vehicle_no} onChange={event => patch({ vehicle_no: event.target.value })} /></Field>
        <Field label="Supplier Invoice"><Input value={form.supplier_invoice_no} onChange={event => patch({ supplier_invoice_no: event.target.value })} /></Field>
        <Field label="Invoice Date"><Input type="date" value={form.supplier_invoice_date} onChange={event => patch({ supplier_invoice_date: event.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Remarks"><Textarea value={form.remarks} onChange={event => patch({ remarks: event.target.value })} /></Field></div>
      </div></section>
    </div>
  </Modal>;
}

function ReturnModal({ asset, onClose, onSaved }) {
  const toast = useToast();
  const [rack, setRack] = useState(asset.previous_location || asset.rack_location || '');
  const [condition, setCondition] = useState('Good');
  const [note, setNote] = useState('');
  const save = async action => {
    await api.post(`/plates/assets/${asset.id}/verify-return`, { action, rack_location: rack || undefined, condition, note: note || undefined });
    toast.success(action === 'verified_ok' ? `${asset.asset_number} returned to rack` : `${asset.asset_number} updated`);
    await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title="Verify Plate Return"
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" disabled={!rack} onClick={() => save('verified_ok')}><CheckCircle2 size={14} /> Verified OK</Button></>}>
    <div className="space-y-4">
      <div className="ci-summary-panel text-sm"><b>{asset.asset_number} · {asset.component_label}</b><span className="block text-xs text-slate-500">{asset.product_name} · {asset.jc_number}</span></div>
      <div className="ci-form-grid">
        <Field label="Rack Location" required><Input value={rack} onChange={event => setRack(event.target.value)} /></Field>
        <Field label="Condition"><Select value={condition} onChange={event => setCondition(event.target.value)}><option>Good</option><option>Fair</option></Select></Field>
        <div className="md:col-span-2"><Field label="Verification note"><Textarea value={note} onChange={event => setNote(event.target.value)} /></Field></div>
      </div>
      <div className="flex gap-2 border-t border-slate-200 pt-3"><Button variant="secondary" onClick={() => save('damaged')}>Damaged / Hold</Button><Button variant="danger" onClick={() => save('scrap')}>Scrap</Button></div>
    </div>
  </Modal>;
}

function QuantityControl({ row, onChange, disabled = false }) {
  const qty = Math.max(0, Number(row.qty) || 0);
  return <div className="flex h-9 w-[132px] items-center overflow-hidden rounded-lg border border-slate-200 bg-white">
    <button type="button" title={`Reduce ${row.component_label}`} aria-label={`Reduce ${row.component_label}`}
      disabled={disabled || qty === 0} onClick={()=>onChange(Math.max(0,qty-1))}
      className="flex h-full w-9 shrink-0 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:opacity-30"><Minus size={14}/></button>
    <Input type="number" min="0" max="99" value={qty} disabled={disabled}
      onChange={event=>onChange(Math.max(0,Math.min(99,Math.trunc(Number(event.target.value)||0))))}
      className="h-full min-w-0 flex-1 rounded-none border-0 px-1 text-center tabular-nums shadow-none" />
    <button type="button" title={`Add ${row.component_label}`} aria-label={`Add ${row.component_label}`}
      disabled={disabled || qty >= 99} onClick={()=>onChange(Math.min(99,qty+1))}
      className="flex h-full w-9 shrink-0 items-center justify-center text-blue-600 hover:bg-blue-50 disabled:opacity-30"><Plus size={14}/></button>
  </div>;
}

function ReasonActionModal({ action, onClose, onConfirm }) {
  const toast = useToast();
  const [reason,setReason] = useState('');
  const [busy,setBusy] = useState(false);
  const Icon = action.icon;
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(reason.trim()); onClose(); }
    catch (error) { toast.error(error.message || 'The action could not be completed'); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title={action.title}
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={action.danger?'danger':'success'} disabled={busy || (action.requireReason && !reason.trim())} onClick={submit}>{Icon && <Icon size={14}/>} {action.confirmLabel}</Button></>}>
    <div className="space-y-4">
      <div className={`flex items-start gap-2 rounded-lg border px-3 py-3 text-sm ${action.danger?'border-red-200 bg-red-50 text-red-800':'border-amber-200 bg-amber-50 text-amber-800'}`}>
        <AlertTriangle size={16} className="mt-0.5 shrink-0"/><span>{action.description}</span>
      </div>
      <Field label={action.requireReason ? 'Reason' : 'Reason (optional)'} required={action.requireReason}>
        <Textarea value={reason} onChange={event=>setReason(event.target.value)} placeholder={action.placeholder || 'Record why this action is needed'} />
      </Field>
    </div>
  </Modal>;
}

function AssetHistoryModal({ asset, onClose }) {
  const [detail, setDetail] = useState(null);
  useEffect(() => { api.get(`/plates/assets/${asset.id}/history`).then(setDetail); }, [asset.id]);
  const columns = [
    { key: 'at', label: 'When', render: row => fmt.dt(row.at) },
    { key: 'action', label: 'Movement', render: row => <StatusChip value={row.action} /> },
    { key: 'jc_number', label: 'Job Card', render: row => row.jc_number || '—' },
    { key: 'machine_name', label: 'Machine', render: row => row.machine_name || '—' },
    { key: 'to_location', label: 'Location', render: row => row.to_location || row.from_location || '—' },
    { key: 'condition', label: 'Condition', render: row => row.condition || '—' },
    { key: 'user_name', label: 'By', render: row => row.user_name || '—' },
  ];
  return <Modal open onClose={onClose} title={`${asset.asset_number} · Plate History`} wide footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
    {!detail ? <p className="py-8 text-center text-sm text-slate-400">Loading history…</p> : <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['Product',detail.product_name],['Component',detail.component_label],['Size',detail.plate_size],
          ['Artwork',detail.artwork_version],['Created',fmt.date(detail.plate_created_on)],['Uses',detail.use_count],
          ['Location',detail.rack_location || '—'],['Status',statusLabel(detail.status)],
        ].map(([label,value]) => <div key={label} className="border-b border-slate-100 pb-2"><span className="text-[10px] font-bold uppercase text-slate-400">{label}</span><p className="text-sm font-semibold text-slate-700">{value}</p></div>)}
      </div>
      <DataTable rows={detail.movements || []} columns={columns} empty="No movements recorded" />
    </div>}
  </Modal>;
}

export default function PlatesLifecycle() {
  const toast = useToast();
  const [tab, setTab] = useState('requirements');
  const [reqView, setReqView] = useState('open');
  const [warehouseView, setWarehouseView] = useState('available');
  const [requirements, setRequirements] = useState([]);
  const [pos, setPos] = useState([]);
  const [grns, setGrns] = useState([]);
  const [warehouse, setWarehouse] = useState([]);
  const [returns, setReturns] = useState([]);
  const [history, setHistory] = useState([]);
  const [masters, setMasters] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [newPantone, setNewPantone] = useState('');
  const [verifying, setVerifying] = useState(null);
  const [approving, setApproving] = useState(false);
  const [poModal, setPoModal] = useState(null);
  const [grnModal, setGrnModal] = useState(null);
  const [returnModal, setReturnModal] = useState(null);
  const [assetHistory, setAssetHistory] = useState(null);
  const [reasonAction, setReasonAction] = useState(null);

  const load = async () => {
    const [nextRequirements,nextPos,nextGrns,nextWarehouse,nextReturns,nextHistory,nextMasters,nextVendors] = await Promise.all([
      api.get('/plates/requirements'), api.get('/plates/purchase-orders'), api.get('/plates/grns'),
      api.get('/plates/warehouse'), api.get('/plates/returns'), api.get('/plates/history'),
      api.get('/plate-masters'), api.get('/vendors'),
    ]);
    setRequirements(nextRequirements); setPos(nextPos); setGrns(nextGrns); setWarehouse(nextWarehouse);
    setReturns(nextReturns); setHistory(nextHistory); setMasters(nextMasters); setVendors(nextVendors);
    if (detail) setDetail(nextRequirements.find(row => row.id === detail.id) || null);
  };
  useEffect(() => { load().catch(error => toast.error(error.message || 'Could not load Plates')); }, []);
  useRealtimeRefresh(() => load().catch(() => {}), OPERATIONS_REALTIME_TABLES, { debounceMs: 650 });

  const counts = useMemo(() => ({
    verify: requirements.reduce((sum,row) => sum + row.components.filter(component => component.status === 'verification_required').length, 0),
    approval: requirements.reduce((sum,row) => sum + row.components.filter(component => ['pr_required','replacement_required'].includes(component.status)).length, 0),
    ordered: pos.reduce((sum,po) => sum + po.lines.reduce((lineSum,line) => lineSum + Math.max(0, Number(line.qty)-Number(line.received_qty)), 0), 0),
    ready: requirements.filter(row => row.plate_summary?.is_ready).length,
  }), [requirements,pos]);
  const reqRows = requirements.filter(row => reqView === 'all' || (reqView === 'ready' ? row.plate_summary?.is_ready : !row.plate_summary?.is_ready));
  const warehouseRows = warehouse.filter(row => warehouseView === 'all' || (warehouseView === 'available' ? row.status === 'available' : warehouseView === 'issued' ? row.status === 'issued_to_printing' : ['damaged','scrapped','lost'].includes(row.status)));

  const openRequirement = row => { setDetail(row); setEditForm(requirementDraft(row)); setNewPantone(''); };
  const refreshDetail = async () => {
    await load();
    if (!detail) return null;
    const fresh = await api.get(`/plates/requirements/${detail.id}`);
    setDetail(fresh); setEditForm(requirementDraft(fresh));
    return fresh;
  };
  const saveRequirement = async () => {
    if (!detail || !editForm) return null;
    if (!editForm.plate_master_id) throw new Error('Choose a Plate Master size');
    if (!draftTotal(editForm)) throw new Error('Add at least one plate');
    await api.put(`/plates/requirements/${detail.id}`, editForm);
    toast.success(`${detail.request_number} saved`);
    return refreshDetail();
  };
  const updateDraftQty = (key,qty) => setEditForm(current=>({
    ...current,
    components:current.components.map(row=>componentKey(row)===key?{...row,qty}:row),
  }));
  const addPantone = () => {
    const identity = newPantone.trim();
    if (!identity) return;
    const row = { component_type:'pantone',component_label:`Pantone - ${identity}`,pantone_code:identity,qty:1 };
    const key = componentKey(row);
    setEditForm(current=>{
      const existing=current.components.find(item=>componentKey(item)===key);
      return {...current,components:existing
        ? current.components.map(item=>componentKey(item)===key?{...item,qty:Number(item.qty)+1}:item)
        : [...current.components,row]};
    });
    setNewPantone('');
  };
  const performReasonAction = async reason => {
    const action = reasonAction;
    if (!action) return;
    if (action.kind === 'delete_pr') {
      await api.del(`/plates/requirements/${action.row.id}`, { reason: reason || undefined });
      toast.success(`${action.row.request_number} deleted`);
      if (detail?.id === action.row.id) { setDetail(null); setEditForm(null); }
    } else if (action.kind === 'unapprove') {
      await api.post(`/plates/requirements/${action.row.id}/unapprove`, { reason });
      toast.success(`${action.row.request_number} reopened as Saved`);
    } else if (action.kind === 'reverse_po') {
      await api.post(`/plates/purchase-orders/${action.row.id}/reverse`, { reason });
      toast.success(`${action.row.po_number} reversed`);
    } else if (action.kind === 'reverse_grn') {
      await api.post(`/plates/grns/${action.row.id}/reverse`, { reason });
      toast.success(`${action.row.grn_number} reversed`);
    }
    await load();
    if (detail && action.kind === 'unapprove') await refreshDetail();
  };

  const requestColumns = [
    { key: 'request_number', label: 'Requirement', render: row => <span><b>{row.request_number}</b><span className="block text-[11px] text-slate-400">{row.jc_number}</span></span> },
    { key: 'product_name', label: 'Product', render: row => <ProductIdentity row={row} compact /> },
    { key: 'components', label: 'Plate Set', sortable: false, render: row => <div><ComponentStrip components={row.components} compact /><span className="mt-1 block text-[10px] font-semibold text-slate-400">{row.plate_summary.ready}/{row.plate_summary.required} ready</span></div> },
    { key: 'delivery_date', label: 'Needed by', render: row => fmt.date(row.needed_by || row.delivery_date) },
    { key: 'approval_status', label: 'PR Status', render: row => <StatusChip value={row.approval_status} /> },
    { key: 'po_number', label: 'PO', render: row => row.po_number || '—' },
    { key: 'actions', label: '', sortable: false, render: row => <div className="flex justify-end gap-1" onClick={event => event.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => openRequirement(row)}><Eye size={12} /> Open</Button>
      {canManage() && <ActionMenu label={`${row.request_number} actions`} items={[{
        key:'delete',label:'Delete Plate PR',icon:Trash2,danger:true,onClick:()=>setReasonAction({
          kind:'delete_pr',row,title:`Delete ${row.request_number}?`,confirmLabel:'Delete PR',icon:Trash2,danger:true,requireReason:true,
          description:'This permanently removes the unconverted Plate PR. Any active PO, GRN or floor issue will block deletion until it is reversed one stage at a time.',
        }),
      }]}/>}
    </div> },
  ];
  const poColumns = [
    { key: 'po_number', label: 'PO No', render: row => <b>{row.po_number}</b> },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'lines', label: 'Plate Sets', sortable: false, render: row => <span>{row.lines.map(line => line.product_name).join(', ')}<span className="block text-[11px] text-slate-400">{row.lines.reduce((sum,line) => sum + Number(line.qty),0)} individual plates</span></span> },
    { key: 'expected_date', label: 'Expected', render: row => fmt.date(row.expected_date) },
    { key: 'fulfilment', label: 'Fulfilment', sortable: false, render: row => { const total=row.lines.reduce((sum,line)=>sum+Number(line.qty),0); const done=row.lines.reduce((sum,line)=>sum+Number(line.received_qty),0); return <FulfillmentBar pct={total ? done/total*100 : 0} done={done} total={total} />; } },
    { key: 'status', label: 'Status', render: row => <StatusChip value={row.status} /> },
    { key: 'actions', label: '', sortable: false, render: row => { const line=row.lines.find(item => Number(item.received_qty)<Number(item.qty)); return canManage() ? <div className="flex justify-end gap-1" onClick={event=>event.stopPropagation()}>
      {line && !['reversed','closed'].includes(row.status) && <Button size="sm" onClick={() => setGrnModal({ po: row, line })}><PackagePlus size={12} /> GRN</Button>}
      <ActionMenu label={`${row.po_number} actions`} items={[
        ...(!row.sent_at && !['reversed','closed','received'].includes(row.status) ? [{key:'send',label:'Mark sent to vendor',icon:Send,onClick:async()=>{await api.post(`/plates/purchase-orders/${row.id}/send`);toast.success(`${row.po_number} marked sent`);load();}}] : []),
        ...(row.status!=='reversed' ? [{key:'reverse',label:'Reverse PO',icon:RotateCcw,danger:true,onClick:()=>setReasonAction({
          kind:'reverse_po',row,title:`Reverse ${row.po_number}?`,confirmLabel:'Reverse PO',icon:RotateCcw,danger:true,requireReason:true,
          description:row.sent_at?'This PO has already been issued to the vendor. Confirm vendor cancellation before reversing it. Any active GRN must be reversed first.':'This returns its Plate components to Approved. Any active GRN must be reversed first.',
        })}] : []),
      ]}/>
    </div> : null; } },
  ];
  const grnColumns = [
    { key: 'grn_number', label: 'GRN', render: row => <b>{row.grn_number}</b> },
    { key: 'product_name', label: 'Product', render: row => <span>{row.product_name}<span className="block text-[11px] text-slate-400">{row.jc_number} · {row.request_number}</span></span> },
    { key: 'plate_size', label: 'Size' },
    { key: 'plates', label: 'Plates', render: row => <span>{row.plates.map(plate => plate.component_label).join(', ')}<span className="block text-[11px] text-slate-400">{row.plates.map(plate => plate.asset_number).join(' · ')}</span></span> },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'created_at', label: 'Received', render: row => fmt.dt(row.created_at) },
    { key: 'status', label: 'Status', render: row => <StatusChip value={row.status} /> },
    { key: 'actions', label: '', sortable: false, render: row => canManage() && row.status!=='reversed' ? <div onClick={event=>event.stopPropagation()} className="flex justify-end"><ActionMenu label={`${row.grn_number} actions`} items={[{
      key:'reverse',label:'Reverse GRN',icon:RotateCcw,danger:true,onClick:()=>setReasonAction({
        kind:'reverse_grn',row,title:`Reverse ${row.grn_number}?`,confirmLabel:'Reverse GRN',icon:RotateCcw,danger:true,requireReason:true,
        description:'Received plate assets will be retained as reversed history and the quantities will return to the active Plate PO. Plates already used in production cannot be reversed.',
      }),
    }]}/></div> : null },
  ];
  const warehouseColumns = [
    { key: 'asset_number', label: 'Plate', render: row => <b className="font-mono text-xs">{row.asset_number}</b> },
    { key: 'product_name', label: 'Product', render: row => <ProductIdentity row={row} compact /> },
    { key: 'component_label', label: 'Colour / Type', render: row => <span className="font-semibold">{row.component_label}<span className="block text-[11px] font-normal text-slate-400">{row.plate_size}</span></span> },
    { key: 'artwork_version', label: 'Output / Artwork', render: row => <span>{row.output_number || '—'}<span className="block text-[11px] text-slate-400">{row.artwork_version}</span></span> },
    { key: 'rack_location', label: 'Rack / Location', render: row => row.rack_location || '—' },
    { key: 'use_count', label: 'Uses', align: 'right' },
    { key: 'last_used_at', label: 'Last Used', render: row => fmt.date(row.last_used_at) },
    { key: 'age_days', label: 'Age', align: 'right', render: row => `${row.age_days || 0} d` },
    { key: 'status', label: 'Status', render: row => <StatusChip value={row.status} /> },
    { key: 'actions', label: '', sortable: false, render: row => <Button size="sm" variant="secondary" onClick={event => { event.stopPropagation(); setAssetHistory(row); }}><History size={12} /></Button> },
  ];
  const returnColumns = [
    { key: 'asset_number', label: 'Plate', render: row => <b>{row.asset_number}</b> },
    { key: 'product_name', label: 'Product', render: row => <ProductIdentity row={row} compact /> },
    { key: 'component_label', label: 'Colour', render: row => `${row.component_label} · ${row.plate_size}` },
    { key: 'jc_number', label: 'Job Card' },
    { key: 'returned_by', label: 'Returned By' },
    { key: 'return_date', label: 'Returned', render: row => fmt.dt(row.return_date) },
    { key: 'previous_location', label: 'Previous Rack', render: row => row.previous_location || row.rack_location || '—' },
    { key: 'actions', label: '', sortable: false, render: row => canVerify() ? <Button size="sm" variant="success" onClick={event => { event.stopPropagation(); setReturnModal(row); }}><FileCheck2 size={12} /> Verify</Button> : null },
  ];
  const historyColumns = [
    { key: 'at', label: 'When', render: row => fmt.dt(row.at) },
    { key: 'asset_number', label: 'Plate', render: row => <b>{row.asset_number}</b> },
    { key: 'product_name', label: 'Product', render: row => `${row.product_code} · ${row.product_name}` },
    { key: 'component_label', label: 'Component' },
    { key: 'action', label: 'Movement', render: row => <StatusChip value={row.action} /> },
    { key: 'jc_number', label: 'Job Card', render: row => row.jc_number || '—' },
    { key: 'to_location', label: 'Location', render: row => row.to_location || row.from_location || '—' },
    { key: 'user_name', label: 'By', render: row => row.user_name || '—' },
  ];
  const detailEditable = !!detail && ['draft','saved','pending'].includes(detail.approval_status) && canManage();
  const detailGroups = detail ? groupedComponents(detail.components) : [];
  const detailApproveable = !!detail && canManage() && ['saved','approved'].includes(detail.approval_status)
    && detail.components.some(component => ['pr_required','replacement_required','not_found'].includes(component.status));

  return <div className="space-y-4">
    <PageHeader title="Plates" subtitle="Job Card requirement → physical verification → approval → PO → GRN → printing → return"
      actions={canManage() ? <Button variant="secondary" onClick={() => { window.location.href='/masters?tab=plates'; }}><Printer size={15} /> Plate Master</Button> : null} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <KpiCard compact label="Verify Existing" value={counts.verify} icon={FileCheck2} tone={counts.verify ? 'warn' : 'neutral'} />
      <KpiCard compact label="Approval Required" value={counts.approval} icon={ClipboardCheck} tone={counts.approval ? 'warn' : 'neutral'} />
      <KpiCard compact label="On Order" value={counts.ordered} icon={Truck} />
      <KpiCard compact label="Jobs Ready" value={counts.ready} icon={CheckCircle2} tone="good" />
      <KpiCard compact label="Returns to Verify" value={returns.length} icon={Warehouse} tone={returns.length ? 'warn' : 'neutral'} />
    </div>
    <Tabs active={tab} onChange={setTab} tabs={[
      { key:'requirements',label:'Plate Requirements / PR',count:requirements.filter(row=>!row.plate_summary?.is_ready).length },
      { key:'pos',label:'Purchase Orders',count:pos.filter(row=>!['received','closed','reversed'].includes(row.status)).length },
      { key:'grns',label:'GRN',count:grns.length },
      { key:'warehouse',label:'Plates Warehouse',count:warehouse.length },
      { key:'returns',label:'Return from Printing',count:returns.length },
      { key:'history',label:'History',count:history.length },
    ]} />
    {tab==='requirements' && <><SubTabs active={reqView} onChange={setReqView} views={[
      {key:'open',label:'Open',count:requirements.filter(row=>!row.plate_summary?.is_ready).length},
      {key:'ready',label:'Ready',count:requirements.filter(row=>row.plate_summary?.is_ready).length},
      {key:'all',label:'All',count:requirements.length},
    ]}/><DataTable searchable rows={reqRows} columns={requestColumns} onRowClick={openRequirement} empty="No plate requirements in this view" exportName="Plate Requirements" /></>}
    {tab==='pos' && <DataTable searchable rows={pos} columns={poColumns} empty="No Plate Purchase Orders" exportName="Plate Purchase Orders" />}
    {tab==='grns' && <DataTable searchable rows={grns} columns={grnColumns} empty="No Plate GRNs" exportName="Plate GRN Register" />}
    {tab==='warehouse' && <><SubTabs active={warehouseView} onChange={setWarehouseView} views={[
      {key:'available',label:'Available',count:warehouse.filter(row=>row.status==='available').length},
      {key:'issued',label:'Issued',count:warehouse.filter(row=>row.status==='issued_to_printing').length},
      {key:'exceptions',label:'Damaged / Scrap',count:warehouse.filter(row=>['damaged','scrapped','lost'].includes(row.status)).length},
      {key:'all',label:'All',count:warehouse.length},
    ]}/><DataTable searchable rows={warehouseRows} columns={warehouseColumns} onRowClick={setAssetHistory} empty="No plates in this warehouse view" exportName="Plates Warehouse" /></>}
    {tab==='returns' && <DataTable searchable rows={returns} columns={returnColumns} empty="No plates awaiting return verification" exportName="Plate Returns" />}
    {tab==='history' && <DataTable searchable rows={history} columns={historyColumns} empty="No plate movements" exportName="Plate Movement History" />}

    {detail && editForm && <Modal open onClose={() => {setDetail(null);setEditForm(null);}} title={`${detail.request_number} · ${detail.jc_number}`} wide
      footer={<>
        <Button variant="secondary" onClick={() => {setDetail(null);setEditForm(null);}}>Close</Button>
        {detailEditable && <Button variant="secondary" onClick={()=>saveRequirement().catch(error=>toast.error(error.message))}><Save size={14}/> Save</Button>}
        {detailApproveable && <Button variant="success" disabled={!draftTotal(editForm)||!editForm.plate_master_id} onClick={() => setApproving(true)}>Approve</Button>}
        {canManage() && detail.approval_status==='approved' && <Button variant="secondary" onClick={()=>setReasonAction({
          kind:'unapprove',row:detail,title:`Unapprove ${detail.request_number}?`,confirmLabel:'Unapprove',icon:RotateCcw,requireReason:true,
          description:'This reopens the Plate PR as Saved and makes its size and quantities editable. A Plate PO must be reversed first.',
        })}><RotateCcw size={14}/> Unapprove</Button>}
      </>}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><ProductIdentity row={detail} /><StatusChip value={detail.approval_status}/></div>
        <div className="grid gap-3 sm:grid-cols-4">{[
          ['Customer',detail.customer_name],['Required',`${draftTotal(editForm)} plates`],['Ready',`${detail.plate_summary.ready}/${detail.plate_summary.required}`],['Needed',fmt.date(detail.needed_by||detail.delivery_date)],
        ].map(([label,value])=><div key={label} className="border-b border-slate-100 pb-2"><span className="text-[10px] font-bold uppercase text-slate-400">{label}</span><p className="text-sm font-semibold">{value}</p></div>)}</div>
        <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Requirement setup</span><span>{draftTotal(editForm)} physical plates</span></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plate Size" required><Select value={editForm.plate_master_id} disabled={!detailEditable}
              onChange={event=>setEditForm(current=>({...current,plate_master_id:event.target.value}))}>
              <option value="">Choose plate size</option>{masters.filter(row=>row.active).map(row=><option key={row.id} value={row.id}>{row.plate_size}</option>)}
            </Select></Field>
            <Field label="Preferred Vendor"><SearchableSelect value={editForm.vendor_id} disabled={!detailEditable}
              onChange={event=>setEditForm(current=>({...current,vendor_id:event.target.value}))}
              options={[{value:'',label:'No preference'},...vendors.map(row=>({value:String(row.id),label:row.name}))]}/></Field>
          </div>
        </section>
        <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Plate colour and quantity</span><span>0 removes a colour</span></div>
          <div className="divide-y divide-slate-100">{editForm.components.map(row=>{
            const lifecycle=detailGroups.find(group=>group.key===componentKey(row));
            return <div key={componentKey(row)} className="grid items-center gap-3 py-2.5 sm:grid-cols-[minmax(180px,1fr)_150px_132px]">
              <div><b className="text-sm">{row.component_label}</b>{row.component_type==='pantone'&&<span className="block text-[11px] text-slate-400">Pantone identity retained on every physical plate</span>}</div>
              <div>{lifecycle ? <StatusChip value={lifecycle.status}/> : <span className="text-xs text-slate-400">Not required</span>}</div>
              <QuantityControl row={row} disabled={!detailEditable} onChange={qty=>updateDraftQty(componentKey(row),qty)}/>
            </div>;
          })}</div>
          {detailEditable && <div className="mt-3 flex max-w-md gap-2 border-t border-slate-100 pt-3">
            <Input value={newPantone} onChange={event=>setNewPantone(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addPantone();}}} placeholder="Pantone number or name"/>
            <Button type="button" variant="secondary" onClick={addPantone}><Plus size={14}/> Add Pantone</Button>
          </div>}
        </section>
        <Field label="Remarks"><Textarea value={editForm.notes} disabled={!detailEditable} onChange={event=>setEditForm(current=>({...current,notes:event.target.value}))}/></Field>
        {detail.components.some(component=>component.status==='verification_required') && <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Physical verification required</span><span>{detail.components.filter(component=>component.status==='verification_required').length} plates</span></div>
          <div className="space-y-2">{detail.components.filter(component=>component.status==='verification_required').map(component=><div key={component.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2">
            <div><b className="text-sm">{component.component_label}</b><span className="ml-2 text-xs text-slate-500">{component.proposed_asset_number} · {component.proposed_rack_location||'rack pending'}</span></div>
            {canVerify()&&<Button size="sm" variant="secondary" onClick={()=>setVerifying(component)}><FileCheck2 size={12}/> Verify</Button>}
          </div>)}</div>
        </section>}
        {detail.components.some(component=>component.older_artwork_count>0) && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0"/>Existing plates belong to an older artwork version and are excluded from reuse.</div>}
        {canManage() && detail.components.some(component=>component.status==='approved') && <div className="flex justify-end"><Button onClick={()=>setPoModal({ request:detail, components:detail.components.filter(component=>component.status==='approved') })}><ShoppingBag size={14}/> Create PO for Approved Plates</Button></div>}
        {detail.events?.length>0 && <section><div className="mb-2 text-xs font-bold uppercase text-slate-500">Activity</div><div className="space-y-2">{detail.events.map(event=><div key={event.id} className="grid gap-1 border-l-2 border-slate-200 pl-3 sm:grid-cols-[150px_1fr_auto]">
          <span className="text-xs font-semibold text-slate-700">{statusLabel(event.action)}</span><span className="text-xs text-slate-500">{event.note||'—'}</span><span className="text-[11px] text-slate-400">{event.user_name||'System'} · {fmt.dt(event.at)}</span>
        </div>)}</div></section>}
      </div>
    </Modal>}
    {verifying && <VerificationModal component={verifying} onClose={()=>setVerifying(null)} onSaved={refreshDetail}/>}
    {approving && detail && editForm && <ApproveModal request={detail} draft={editForm} masters={masters} onSaveDraft={saveRequirement} onClose={()=>setApproving(false)} onSaved={refreshDetail}/>}
    {poModal && <PlatePoModal request={poModal.request} components={poModal.components} vendors={vendors} onClose={()=>setPoModal(null)} onSaved={refreshDetail}/>}
    {grnModal && <PlateGrnModal po={grnModal.po} line={grnModal.line} onClose={()=>setGrnModal(null)} onSaved={load}/>}
    {returnModal && <ReturnModal asset={returnModal} onClose={()=>setReturnModal(null)} onSaved={load}/>}
    {assetHistory && <AssetHistoryModal asset={assetHistory} onClose={()=>setAssetHistory(null)}/>}
    {reasonAction && <ReasonActionModal action={reasonAction} onClose={()=>setReasonAction(null)} onConfirm={performReasonAction}/>}
  </div>;
}
