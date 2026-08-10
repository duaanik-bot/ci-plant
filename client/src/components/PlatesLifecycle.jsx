import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Eye, FileCheck2, History,
  Minus, PackagePlus, Plus, Printer, RotateCcw, Save, Send, ShoppingBag,
  Layers3 as Layers, Trash2, Truck, Warehouse,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { lineAmount, lineTaxable, poTotals } from '../lib/poTotals.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { plateRackSummary, PLATE_SIZES_IN_ORDER, PLATE_RETIRE_REASONS } from '../lib/plateRack.js';
import { resolvePlateRate } from '../lib/plateRates.js';
import {
  ActionMenu, Button, Checkbox, DataTable, Field, FulfillmentBar, Input,
  KpiCard, Modal, PageHeader, SearchableSelect, Select, SubTabs, Tabs,
  Textarea, useToast,
} from './ui.jsx';
import ProductIdentity from './ProductIdentity.jsx';
import { PoTotalsPanel, TaxKindToggle } from './ProcurementForms.jsx';

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
const FRESH_PLATES_RACK = 'Fresh Plates Rack';
const USED_PLATES_RACK = 'Used Plates Rack';
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

function editableComponentRows(components = []) {
  const grouped = groupedComponents(components);
  const byType = new Map(grouped.filter(row => row.component_type !== 'pantone').map(row => [row.component_type,row]));
  return [
    ...PROCESS_PLATES.map(([component_type,component_label]) => ({
      component_type, component_label, pantone_code: null, qty: byType.get(component_type)?.qty || 0,
    })),
    ...grouped.filter(row => row.component_type === 'pantone').map(row => ({
      component_type: 'pantone', component_label: row.component_label,
      pantone_code: row.pantone_code, qty: row.qty,
    })),
  ];
}

function requirementDraft(request) {
  return {
    plate_master_id: request.components.find(row => row.plate_master_id)?.plate_master_id
      || request.suggested_plate_master_id || '',
    vendor_id: request.vendor_id || request.suggested_vendor_id || '',
    notes: request.notes || '',
    components: editableComponentRows(request.components),
  };
}

const draftTotal = draft => (draft?.components || []).reduce((sum,row) => sum + Math.max(0,Number(row.qty)||0),0);

// ── Approval rules, mirrored from server/src/plates.js ────────────────────
// The button must offer exactly what the route will accept. These three are the
// same rules the server enforces (APPROVABLE_COMPONENT_STATUSES,
// canApprovePlateRequest, canUnapprovePlateRequest), kept in step by
// plate-lifecycle-wiring.test.js — a button that offers a refused action is the
// silent dead click this module has already shipped twice.
const APPROVABLE_COMPONENT_STATUSES = ['pr_required','replacement_required','not_found'];
const approvableComponents = components =>
  (components || []).filter(row => APPROVABLE_COMPONENT_STATUSES.includes(row?.status));
const canApproveRow = row => ['draft','saved','pending'].includes(row?.approval_status)
  && approvableComponents(row?.components).length > 0;
const canUnapproveRow = row => row?.approval_status === 'approved' && !row?.po_number
  && !(row?.components || []).some(c => c.po_line_id || c.grn_id
    || ['po_created','ordered','grn_received'].includes(c.status));

// One spelling of "approve this Plate PR". The row button, the bulk bar and the
// modal differ ONLY in which plates are picked; the rest — save the draft first
// so it has a size, then read the component ids back from what the save actually
// wrote — is identical, and the ids matter: PUT rebuilds the components whenever
// the structure changes, so ids read before the save can be dead by the time the
// approve lands.
async function approvePlateRequest({ request, plateMasterId, keys = null, save }) {
  const fresh = request.approval_status === 'approved' ? request : await save();
  const eligible = approvableComponents(fresh.components)
    .filter(row => keys === null || keys.includes(componentKey(row)));
  if (!eligible.length) throw new Error('No plates on this requirement still need buying');
  await api.post(`/plates/requirements/${request.id}/approve`, {
    plate_master_id: +plateMasterId,
    component_ids: eligible.map(row => row.id),
  });
  return eligible.length;
}

function ComponentStrip({ components = [], compact = false }) {
  return <div className={`flex flex-wrap ${compact ? 'gap-1' : 'gap-1.5'}`}>
    {groupedComponents(components).map(component => <span key={component.key} title={statusLabel(component.status)}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold ${TONE[component.status] || 'bg-slate-100 text-slate-600'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${['verified_existing','available','reserved','issued'].includes(component.status) ? 'bg-emerald-500' : component.status === 'verification_required' ? 'bg-amber-500' : component.status === 'scrapped' ? 'bg-slate-400' : 'bg-blue-500'}`} />
      {component.component_label}{component.qty > 1 ? ` x${component.qty}` : ''}
    </span>)}
  </div>;
}

function PlateProductIdentity({ row, compact = false }) {
  if (!row?.is_gang) return <ProductIdentity row={row} compact={compact} />;
  const members = Array.isArray(row.gang_members) ? row.gang_members : [];
  return <div className="min-w-0">
    <b className={`block truncate text-slate-800 ${compact ? 'text-xs' : 'text-sm'}`}>{row.product_name || row.gang_number || 'Gang Plate'}</b>
    <span className="block truncate text-[11px] text-slate-500">Unified gang plate · {members.length || 'Multiple'} products</span>
    {members.length > 0 && <span className="block max-w-[340px] truncate text-[10px] text-slate-400"
      title={members.map(member => member.product_name).filter(Boolean).join(' · ')}>
      {members.map(member => member.product_name).filter(Boolean).join(' · ')}
    </span>}
  </div>;
}

function VerificationModal({ component, onClose, onSaved }) {
  const toast = useToast();
  const [checks, setChecks] = useState({ found: false, condition_ok: false, artwork_ok: false, colour_ok: false, size_ok: false });
  const [note, setNote] = useState('');
  const save = async outcome => {
    await api.post(`/plates/components/${component.id}/verify-existing`, { outcome, ...checks, note: note || undefined });
    toast.success(outcome === 'usable' ? `${component.component_label} verified and ready from rack` : `${component.component_label} marked for replacement`);
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
    try {
      const count = await approvePlateRequest({
        request, plateMasterId: draft.plate_master_id, keys: selectedKeys, save: onSaveDraft,
      });
      toast.success(`${count} plate${count === 1 ? '' : 's'} approved`);
      await onSaved(); onClose();
    } catch (error) { toast.error(error.message || 'Could not approve this Plate PR'); }
  };
  return <Modal open onClose={onClose} title="Approve Plate Requirement"
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>{request.approval_status!=='approved'&&<Button variant="secondary" onClick={async()=>{ await onSaveDraft(); toast.success('Plate PR saved'); onClose(); }}><Save size={14}/> Save Changes</Button>}<Button variant="success" disabled={!draft.plate_master_id || !selectedKeys.length} onClick={save}>Approve</Button></>}>
    <div className="space-y-4">
      <PlateProductIdentity row={request} compact />
      <div className="ci-summary-panel text-sm"><b>Plate size</b><span className="ml-2">{masters.find(row=>String(row.id)===String(draft.plate_master_id))?.plate_size || 'Not selected'}</span></div>
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Plate Requirement</span><span>{candidates.filter(row=>selectedKeys.includes(componentKey(row))).reduce((sum,row)=>sum+Number(row.qty),0)} plates</span></div>
        <div className="space-y-2">{candidates.map(row=><Checkbox key={componentKey(row)} checked={selectedKeys.includes(componentKey(row))}
          label={`${row.component_label} x ${row.qty}`} onChange={()=>setSelectedKeys(current=>current.includes(componentKey(row))?current.filter(key=>key!==componentKey(row)):[...current,componentKey(row)])}/>)}</div>
      </section>
    </div>
  </Modal>;
}

function PlatePoModal({ groups, vendors, plateRates, onClose, onSaved }) {
  const toast = useToast();
  const vendorIds = [...new Set(groups.map(group => String(group.request.vendor_id || group.request.suggested_vendor_id || '')).filter(Boolean))];
  const initialVendorId = vendorIds.length === 1 ? vendorIds[0] : '';
  const rateFor = (group, vendorId) => resolvePlateRate(
    plateRates, group.components[0]?.plate_master_id, vendorId)?.rate_per_plate ?? '';
  const [form, setForm] = useState(() => ({
    ...emptyPo(), vendor_id: initialVendorId,
  }));
  const [lineTerms, setLineTerms] = useState(() => Object.fromEntries(groups.map(group => {
    const rate = rateFor(group, initialVendorId);
    return [group.request.id, {
      rate, autoRate: rate, gst_rate: String(group.components[0]?.plate_gst_rate ?? 18), discount_pct: '',
    }];
  })));
  const [busy, setBusy] = useState(false);
  const patch = value => setForm(current => ({ ...current, ...value }));
  const patchLine = (requestId, value) => setLineTerms(current => ({
    ...current, [requestId]: { ...current[requestId], ...value },
  }));
  const changeVendor = vendorId => {
    patch({ vendor_id: vendorId });
    setLineTerms(current => Object.fromEntries(groups.map(group => {
      const terms = current[group.request.id];
      const nextAutoRate = rateFor(group, vendorId);
      const stillAutomatic = terms.rate === '' || String(terms.rate) === String(terms.autoRate);
      return [group.request.id, {
        ...terms, rate: stillAutomatic ? nextAutoRate : terms.rate, autoRate: nextAutoRate,
      }];
    })));
  };
  const plateCount = groups.reduce((sum, group) => sum + group.components.length, 0);
  const commercialLines = groups.map(group => ({
    material_id: group.components[0]?.plate_master_id || group.request.id,
    qty: group.components.length,
    rate: Number(lineTerms[group.request.id]?.rate) || 0,
    gst_rate: Number(lineTerms[group.request.id]?.gst_rate) || 0,
    discount_pct: Number(lineTerms[group.request.id]?.discount_pct) || 0,
  }));
  const totals = poTotals(commercialLines, {
    freight: form.freight, taxKind: form.tax_kind, round_off: form.round_off,
  });
  const selectedVendor = vendors.find(row => String(row.id) === String(form.vendor_id));
  const save = async () => {
    if (!form.vendor_id) return toast.error('Choose a vendor');
    setBusy(true);
    try {
      const po = await api.post('/plates/purchase-orders', {
        vendor_id: +form.vendor_id, expected_date: form.expected_date || undefined,
        vendor_notes: form.vendor_notes || undefined, payment_terms: form.payment_terms || undefined,
        delivery_terms: form.delivery_terms || undefined, reference: form.reference || undefined,
        tax_kind: form.tax_kind, freight: totals.freight, round_off: totals.round_off,
        groups: groups.map(group => ({
          request_id: group.request.id, component_ids: group.components.map(row => row.id),
          rate: lineTerms[group.request.id]?.rate === '' ? undefined : +lineTerms[group.request.id]?.rate,
          gst_rate: +lineTerms[group.request.id]?.gst_rate || 0,
          discount_pct: +lineTerms[group.request.id]?.discount_pct || 0,
        })),
      });
      toast.success(`${po.po_number} created for ${groups.length} Plate PR${groups.length === 1 ? '' : 's'}`);
      await onSaved(); onClose();
    } catch (error) { toast.error(error.message || 'Could not create Plate PO'); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title={groups.length > 1 ? 'Create Bulk Plate PO' : 'Create Plate Purchase Order'} wide
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy || !form.vendor_id || !plateCount} onClick={save}><ShoppingBag size={14} /> Create PO</Button></>}>
    <div className="space-y-4">
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Supplier &amp; delivery</span><span>{groups.length} PR{groups.length === 1 ? '' : 's'} · {plateCount} plates</span></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Vendor" required><SearchableSelect value={form.vendor_id} onChange={event => changeVendor(event.target.value)}
            options={[{ value: '', label: 'Choose vendor' }, ...vendors.map(row => ({ value: String(row.id), label: row.name }))]} /></Field>
          <Field label="Expected Delivery"><Input type="date" value={form.expected_date} onChange={event => patch({ expected_date: event.target.value })} /></Field>
          <Field label="Tax Treatment"><TaxKindToggle value={form.tax_kind} onChange={tax_kind => patch({ tax_kind })} /></Field>
        </div>
        {selectedVendor && <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500 sm:grid-cols-3">
          <span><b className="text-slate-700">Supplier</b><span className="block">{selectedVendor.name}</span></span>
          <span><b className="text-slate-700">GSTIN</b><span className="block font-mono">{selectedVendor.gstin || 'Not recorded'}</span></span>
          <span><b className="text-slate-700">Address</b><span className="block">{[selectedVendor.address,selectedVendor.city,selectedVendor.state].filter(Boolean).join(', ') || 'Not recorded'}</span></span>
        </div>}
      </section>
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Finalized Plate requirements</span><span>fetched from approved PR rows</span></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[1260px] table-fixed text-left">
          <thead><tr className="border-b border-slate-200 text-[10px] font-bold uppercase text-slate-400">
            <th className="w-[210px] px-2 py-2">Product / PR</th><th className="w-[95px] px-2 py-2">Output</th>
            <th className="w-[240px] px-2 py-2">Finalized Plates</th><th className="w-[105px] px-2 py-2">Plate Size</th>
            <th className="w-[85px] px-2 py-2">HSN</th><th className="w-[50px] px-2 py-2 text-right">Qty</th>
            <th className="w-[110px] px-2 py-2">Rate / Plate</th><th className="w-[80px] px-2 py-2">GST %</th>
            <th className="w-[90px] px-2 py-2">Discount %</th><th className="w-[110px] px-2 py-2 text-right">Taxable</th>
            <th className="w-[110px] px-2 py-2 text-right">Line Total</th>
          </tr></thead>
          <tbody>{groups.map((group,index) => {
            const terms = lineTerms[group.request.id];
            const plateSize = group.components[0]?.plate_size || group.request.suggested_plate_size || '—';
            const commercial = commercialLines[index];
            return <tr key={group.request.id} className="border-b border-slate-100 align-top last:border-0">
              <td className="px-2 py-3"><b className="block text-sm text-slate-800">{group.request.product_name}</b><span className="block text-[11px] text-slate-400">{group.request.request_number} · {group.request.jc_number}</span></td>
              <td className="px-2 py-3 font-mono text-xs font-semibold text-slate-700">{group.request.output_number || '—'}</td>
              <td className="px-2 py-3"><ComponentStrip components={group.components} compact /></td>
              <td className="px-2 py-3 font-mono text-xs font-semibold text-slate-700">{plateSize}</td>
              <td className="px-2 py-3 font-mono text-xs text-slate-600">{group.components[0]?.plate_hsn_code || '—'}</td>
              <td className="px-2 py-3 text-right text-sm font-bold tabular-nums text-slate-800">{group.components.length}</td>
              <td className="px-2 py-2"><Input aria-label={`Rate per plate for ${group.request.request_number}`} type="number" min="0" value={terms.rate} onChange={event => patchLine(group.request.id, { rate: event.target.value })} /><span className="mt-1 block text-[10px] text-slate-400">{terms.autoRate === '' ? 'No master rate' : `Master Rs ${Number(terms.autoRate).toFixed(2)}`}</span></td>
              <td className="px-2 py-2"><Input aria-label={`GST for ${group.request.request_number}`} type="number" min="0" value={terms.gst_rate} onChange={event => patchLine(group.request.id, { gst_rate: event.target.value })} /></td>
              <td className="px-2 py-2"><Input aria-label={`Discount for ${group.request.request_number}`} type="number" min="0" value={terms.discount_pct} onChange={event => patchLine(group.request.id, { discount_pct: event.target.value })} /></td>
              <td className="px-2 py-3 text-right text-xs font-semibold tabular-nums text-slate-700">{fmt.inr(lineTaxable(commercial))}</td>
              <td className="px-2 py-3 text-right text-xs font-bold tabular-nums text-slate-900">{fmt.inr(lineAmount(commercial))}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
      <section className="ci-form-panel"><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Payment Terms"><Input value={form.payment_terms} onChange={event => patch({ payment_terms: event.target.value })} /></Field>
        <Field label="Delivery Terms"><Input value={form.delivery_terms} onChange={event => patch({ delivery_terms: event.target.value })} /></Field>
        <Field label="Reference"><Input value={form.reference} onChange={event => patch({ reference: event.target.value })} /></Field>
        <Field label="Vendor Notes"><Input value={form.vendor_notes} onChange={event => patch({ vendor_notes: event.target.value })} /></Field>
      </div></section>
      <PoTotalsPanel lines={commercialLines} taxKind={form.tax_kind} freight={form.freight} roundOff={form.round_off}
        onFreight={freight => patch({ freight })} onRoundOff={round_off => patch({ round_off })} />
    </div>
  </Modal>;
}

function PlateGrnModal({ po, line, onClose, onSaved }) {
  const toast = useToast();
  const outstanding = (line.components || []).filter(row => ['po_created','ordered'].includes(row.status));
  const [selected, setSelected] = useState(outstanding.map(row => row.id));
  const [form, setForm] = useState({ rack_location: FRESH_PLATES_RACK, condition: 'Good', batch_no: '', vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '', remarks: '' });
  const patch = value => setForm(current => ({ ...current, ...value }));
  const save = async () => {
    if (!selected.length) return toast.error('Choose at least one received plate');
    const grn = await api.post('/plates/grns', { po_line_id: line.id, component_ids: selected, ...form });
    toast.success(`${grn.grn_number} received · ${selected.length} plates ready`); await onSaved(); onClose();
  };
  return <Modal open onClose={onClose} title={`Plate GRN · ${po.po_number}`} wide
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" disabled={!selected.length} onClick={save}><PackagePlus size={14} /> Receive Plates</Button></>}>
    <div className="space-y-4">
      <section className="ci-form-panel"><div className="ci-form-panel-title"><span>{line.product_name}</span><span>{line.jc_number} · Output {line.output_number || '—'}</span></div>
        <div className="space-y-2">{outstanding.map(component => <Checkbox key={component.id} checked={selected.includes(component.id)} label={component.component_label}
          onChange={() => setSelected(current => current.includes(component.id) ? current.filter(id => id !== component.id) : [...current, component.id])} />)}</div>
      </section>
      <section className="ci-form-panel"><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Storage Location"><Input value={FRESH_PLATES_RACK} disabled /></Field>
        <Field label="Condition"><Select value={form.condition} onChange={event => patch({ condition: event.target.value })}><option>Good</option><option>Fair</option></Select></Field>
        <Field label="Batch / Vendor Reference"><Input value={form.batch_no} onChange={event => patch({ batch_no: event.target.value })} /></Field>
        <Field label="Vehicle No"><Input value={form.vehicle_no} onChange={event => patch({ vehicle_no: event.target.value })} /></Field>
        <Field label="Supplier Invoice"><Input value={form.supplier_invoice_no} onChange={event => patch({ supplier_invoice_no: event.target.value })} /></Field>
        <Field label="Invoice Date"><Input type="date" value={form.supplier_invoice_date} onChange={event => patch({ supplier_invoice_date: event.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Remarks"><Textarea value={form.remarks} onChange={event => patch({ remarks: event.target.value })} /></Field></div>
      </div></section>
    </div>
  </Modal>;
}

// Verification is per PLATE, not per set: the warehouse has the pile in front of it
// and three of a set can be fit to run again while the fourth is finished. Ticked
// keeps a plate — it goes to the Used Plates Rack; unticked scraps it. Each row
// carries the plate's age, because a plate on its ninth run is the one to look at
// hardest. The age is shown and never enforced.
function ReturnModal({ asset, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const plates = (asset.components?.length ? asset.components : [{
    asset_id: asset.id, asset_number: asset.asset_number, component_label: asset.component_label,
    condition: asset.condition, use_count: asset.use_count, last_used_at: asset.last_used_at,
  }]).map(row => ({ ...row, asset_id: Number(row.asset_id ?? row.id) }));
  const [keep, setKeep] = useState(() => Object.fromEntries(plates.map(row => [row.asset_id, true])));
  const kept = plates.filter(row => keep[row.asset_id]).length;
  const scrapped = plates.length - kept;

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/plates/assets/${asset.id}/verify-return`, {
        decisions: plates.map(row => ({
          asset_id: row.asset_id,
          action: keep[row.asset_id] ? 'verified_ok' : 'scrap',
        })),
        note: note || undefined,
      });
      toast.success(scrapped
        ? `${kept} plate(s) to ${USED_PLATES_RACK}, ${scrapped} scrapped`
        : `${kept} plate(s) moved to ${USED_PLATES_RACK}`);
      await onSaved(); onClose();
    } finally { setBusy(false); }
  };

  return <Modal open onClose={onClose} title="Verify Returned Plates"
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="success" disabled={busy}
        onClick={() => save().catch(error => { setBusy(false); toast.error(error.message); })}>
        <CheckCircle2 size={14} /> {scrapped ? `Verify — ${kept} kept, ${scrapped} scrapped` : `Verify ${kept} plate(s)`}
      </Button>
    </>}>
    <div className="space-y-4">
      <div className="ci-summary-panel text-sm">
        <b>{asset.product_name} · {plates.length} plates</b>
        <span className="block text-xs text-slate-500">Output {asset.output_number || '—'} · {asset.jc_number}</span>
        <span className="block text-xs text-slate-500">Press returned these as <b>{asset.condition || 'Good'}</b></span>
      </div>
      <section className="ci-form-panel">
        <div className="ci-form-panel-title">
          <span>Keep or scrap</span>
          <span>Ticked → {USED_PLATES_RACK}</span>
        </div>
        <div>
          {plates.map(row => {
            const uses = Number(row.use_count) || 0;
            const on = !!keep[row.asset_id];
            return (
              <label key={row.asset_id}
                className="flex cursor-pointer items-center gap-3 border-b border-slate-100 py-2 last:border-0">
                <input type="checkbox" checked={on}
                  aria-label={`Keep ${row.component_label}`}
                  className="h-5 w-5 shrink-0 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                  onChange={() => setKeep(current => ({ ...current, [row.asset_id]: !on }))} />
                <span className="min-w-0 flex-1">
                  <b className="text-sm text-slate-800">{row.component_label}</b>
                  <span className="block font-mono text-[10px] text-slate-400">
                    {row.asset_number}{row.condition ? ` · ${row.condition}` : ''}
                  </span>
                </span>
                {/* Age: the number of runs this individual plate has already done. */}
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular-nums text-slate-700">{uses}</span>
                  <span className="block text-[10px] text-slate-400">{uses === 1 ? 'run' : 'runs'}</span>
                </span>
                <span className={`w-24 shrink-0 whitespace-nowrap rounded-full px-2 py-1 text-center text-[10px] font-bold ${on ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                  {on ? 'Used Rack' : 'Scrap'}
                </span>
              </label>
            );
          })}
        </div>
      </section>
      <Field label="Verification note"><Textarea value={note} rows={2} onChange={event => setNote(event.target.value)} /></Field>
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

// A warehouse row is a SET, so this shows every plate in it — each with its own age
// and a tick box — and the movements of all of them together. It used to fetch
// `/plates/assets/{first.id}/history`, i.e. ONE plate's record under a title reading
// "4 plate set", which made a set of four look like a single plate with no history.
function AssetHistoryModal({ asset, onClose, onChanged }) {
  const toast = useToast();
  const ids = (asset.asset_ids?.length ? asset.asset_ids : [asset.id]).filter(Boolean);
  const [detail, setDetail] = useState(null);
  const [picked, setPicked] = useState([]);
  const [reason, setReason] = useState('');
  // Free text only when the chips cannot say it — 'Other' is the escape hatch, and
  // it is optional too.
  const [otherReason, setOtherReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get(`/plates/sets/history?asset_ids=${ids.join(',')}`).then(setDetail);
  useEffect(() => { load(); }, [ids.join(',')]);
  const plates = detail?.plates || [];
  const retirable = plates.filter(row => row.status === 'available');
  const retire = async () => {
    setBusy(true);
    try {
      const chosen = reason === 'Other' ? otherReason : reason;
      const result = await api.post('/plates/assets/retire', {
        asset_ids: picked,
        reason: chosen.trim() || undefined,
      });
      toast.success(`${result.retired} plate(s) retired — ${result.plates.join(', ')}`);
      setPicked([]); setReason(''); setOtherReason('');
      await load();
      onChanged?.();
    } finally { setBusy(false); }
  };
  const columns = [
    { key: 'at', label: 'When', render: row => fmt.dt(row.at) },
    { key: 'asset_number', label: 'Plate', render: row => <span className="font-mono text-[11px]">{row.asset_number}</span> },
    { key: 'action', label: 'Movement', render: row => <StatusChip value={row.action} /> },
    { key: 'jc_number', label: 'Job Card', render: row => row.jc_number || '—' },
    { key: 'machine_name', label: 'Machine', render: row => row.machine_name || '—' },
    { key: 'to_location', label: 'Location', render: row => row.to_location || row.from_location || '—' },
    { key: 'condition', label: 'Condition', render: row => row.condition || '—' },
    { key: 'user_name', label: 'By', render: row => row.user_name || '—' },
  ];
  return <Modal open onClose={onClose} title={`${asset.asset_number} · Plate History`} wide
    footer={<>
      <Button variant="secondary" onClick={onClose}>Close</Button>
      {/* The reason is a note, never a gate — same rule as the list view. Whoever is
          standing at the rack has already decided; a required text box only delays it. */}
      {picked.length > 0 && <Button variant="danger" disabled={busy}
        onClick={() => retire().catch(error => { setBusy(false); toast.error(error.message); })}>
        <Trash2 size={14} /> Retire {picked.length} plate(s)
      </Button>}
    </>}>
    {!detail ? <p className="py-8 text-center text-sm text-slate-400">Loading history…</p> : <div className="space-y-4">
      <section className="ci-form-panel">
        <div className="ci-form-panel-title">
          <span>Plates in this set</span>
          <span>{retirable.length} of {plates.length} available · tick to retire</span>
        </div>
        <div>
          {plates.map(row => {
            const on = picked.includes(row.id);
            const available = row.status === 'available';
            return (
              <label key={row.id}
                className={`flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 ${available ? 'cursor-pointer' : 'opacity-60'}`}>
                <input type="checkbox" checked={on} disabled={!available}
                  aria-label={`Retire ${row.component_label} ${row.asset_number}`}
                  className="h-5 w-5 shrink-0 rounded border-[#1D1D1F]/20 accent-[#007AFF]"
                  onChange={() => setPicked(current => on ? current.filter(id => id !== row.id) : [...current, row.id])} />
                <span className="min-w-0 flex-1">
                  <b className="text-sm text-slate-800">{row.component_label}</b>
                  <span className="block font-mono text-[10px] text-slate-400">
                    {row.asset_number} · {row.plate_size} · {row.rack_location || '—'}
                  </span>
                </span>
                {/* The plate's own age — the figure the retire decision turns on. */}
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular-nums text-slate-700">{row.use_count || 0}</span>
                  <span className="block text-[10px] text-slate-400">{(row.use_count || 0) === 1 ? 'run' : 'runs'}</span>
                </span>
                <span className="w-16 shrink-0 text-right text-[10px] text-slate-400">{row.age_days || 0} d old</span>
                <StatusChip value={row.status} />
              </label>
            );
          })}
        </div>
      </section>
      {picked.length > 0 && (
        <div>
          {/* Same optional chips as the list-view retire, so the two routes into the
              same decision look and behave alike. Tapping the live chip clears it. */}
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Reason <span className="normal-case tracking-normal text-slate-400">(optional)</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PLATE_RETIRE_REASONS.map(option => {
              const on = reason === option;
              return <button key={option} type="button"
                onClick={() => setReason(on ? '' : option)}
                className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {option}
              </button>;
            })}
          </div>
          {reason === 'Other' && (
            <Input className="mt-2" value={otherReason} placeholder="What happened to it? (optional)"
              onChange={event => setOtherReason(event.target.value)} />
          )}
        </div>
      )}
      <div>
        <div className="mb-2 text-xs font-bold uppercase text-slate-500">Movements — every plate in this set</div>
        <DataTable rows={detail.movements || []} columns={columns} empty="No movements recorded" />
      </div>
    </div>}
  </Modal>;
}

export default function PlatesLifecycle() {
  const toast = useToast();
  const [tab, setTab] = useState('requirements');
  const [reqView, setReqView] = useState('open');
  const [approvalView, setApprovalView] = useState('all');
  const [warehouseView, setWarehouseView] = useState('fresh');
  // Rack selection + the ad-hoc issue dialog: plates handed straight to a job with
  // no PR behind them.
  const [rackPicked, setRackPicked] = useState([]);
  // Size filter for the rack. Defaults to 'all' rather than the main size: filtering
  // stock away before anyone asks is how a plate that IS on the rack reads as missing.
  const [sizeView, setSizeView] = useState('all');
  // Retire straight from the list — { rows, reason, note }. Retiring a whole set is
  // the common case (the artwork changed, so all four plates are dead), and making
  // someone open each set to tick four boxes is the slow way to say that.
  const [retiring, setRetiring] = useState(null);
  const [issuing, setIssuing] = useState(null);
  const [openJobs, setOpenJobs] = useState([]);
  const [requirements, setRequirements] = useState([]);
  const [pos, setPos] = useState([]);
  const [grns, setGrns] = useState([]);
  const [warehouse, setWarehouse] = useState([]);
  const [returns, setReturns] = useState([]);
  const [history, setHistory] = useState([]);
  const [masters, setMasters] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [plateRates, setPlateRates] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [newPantone, setNewPantone] = useState('');
  const [verifying, setVerifying] = useState(null);
  const [approving, setApproving] = useState(false);
  const [busyRow, setBusyRow] = useState(null);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [poModal, setPoModal] = useState(null);
  const [grnModal, setGrnModal] = useState(null);
  const [returnModal, setReturnModal] = useState(null);
  const [assetHistory, setAssetHistory] = useState(null);
  const [reasonAction, setReasonAction] = useState(null);

  const load = async () => {
    const [nextRequirements,nextPos,nextGrns,nextWarehouse,nextReturns,nextHistory,nextMasters,nextVendors,nextPlateRates] = await Promise.all([
      api.get('/plates/requirements'), api.get('/plates/purchase-orders'), api.get('/plates/grns'),
      api.get('/plates/warehouse'), api.get('/plates/returns'), api.get('/plates/history'),
      api.get('/plate-masters'), api.get('/vendors'), api.get('/plate-rates'),
    ]);
    setRequirements(nextRequirements); setPos(nextPos); setGrns(nextGrns); setWarehouse(nextWarehouse);
    setReturns(nextReturns); setHistory(nextHistory); setMasters(nextMasters); setVendors(nextVendors); setPlateRates(nextPlateRates);
    setSelectedIds(current => current.filter(id => nextRequirements.some(row => row.id === id)));
    setRackPicked(current => current.filter(id => nextWarehouse.some(row => row.id === id)));
    if (detail) setDetail(nextRequirements.find(row => row.id === detail.id) || null);
  };
  // Job cards for the ad-hoc issue picker. Fetched separately and tolerantly: the
  // warehouse must still open if Job Cards is unavailable to this login.
  useEffect(() => {
    api.get('/job-cards')
      .then(rows => setOpenJobs(rows.filter(row => row.status !== 'closed')))
      .catch(() => setOpenJobs([]));
  }, []);
  const issuePlates = async () => {
    const result = await api.post('/plates/assets/issue', {
      asset_ids: issuing.rows.flatMap(row => row.asset_ids?.length ? row.asset_ids : [row.id]),
      job_card_id: Number(issuing.job_card_id),
      note: issuing.note || undefined,
    });
    toast.success(`${result.issued} plate(s) issued to ${result.jc_number}`
      + (result.tooling_marked ? ' · tooling marked OK' : ''));
    setIssuing(null); setRackPicked([]);
    await load();
  };
  // Retire every plate in the chosen sets. The reason is optional; when 'Other' is
  // picked the free text replaces it, otherwise the chip's own words are recorded.
  const retirePlates = async () => {
    const reason = retiring.reason === 'Other' ? retiring.note : (retiring.reason || retiring.note);
    const result = await api.post('/plates/assets/retire', {
      asset_ids: retiring.rows.flatMap(row => row.asset_ids?.length ? row.asset_ids : [row.id]),
      reason: reason || undefined,
    });
    toast.success(`${result.retired} plate(s) retired to scrap`);
    setRetiring(null); setRackPicked([]);
    await load();
  };
  useEffect(() => { load().catch(error => toast.error(error.message || 'Could not load Plates')); }, []);
  useRealtimeRefresh(() => load().catch(() => {}), OPERATIONS_REALTIME_TABLES, { debounceMs: 650 });

  const counts = useMemo(() => ({
    verify: requirements.reduce((sum,row) => sum + row.components.filter(component => component.status === 'verification_required').length, 0),
    approval: requirements.reduce((sum,row) => sum + row.components.filter(component => ['pr_required','replacement_required'].includes(component.status)).length, 0),
    ordered: pos.reduce((sum,po) => sum + po.lines.reduce((lineSum,line) => lineSum + Math.max(0, Number(line.qty)-Number(line.received_qty)), 0), 0),
    ready: requirements.filter(row => row.plate_summary?.is_ready).length,
  }), [requirements,pos]);
  const isConvertedPr = row => row.approval_status === 'converted' || !!row.po_number;
  const reqGroups = {
    open: requirements.filter(row => !row.plate_summary?.is_ready && !isConvertedPr(row)),
    converted: requirements.filter(isConvertedPr),
    ready: requirements.filter(row => row.plate_summary?.is_ready),
    all: requirements,
  };
  const lifecycleRows = reqGroups[reqView] || reqGroups.open;
  const approvedStatuses = new Set(['approved']);
  const reqRows = reqView === 'converted' ? lifecycleRows : lifecycleRows.filter(row => approvalView === 'all'
    || (approvalView === 'approved' ? approvedStatuses.has(row.approval_status) : !approvedStatuses.has(row.approval_status)));
  const selectedRequirements = requirements.filter(row => selectedIds.includes(row.id));
  const selectedPoGroups = selectedRequirements.map(request => ({
    request, components: request.components.filter(component => component.status === 'approved'),
  }));
  const canCreateBulkPo = selectedRequirements.length > 0
    && selectedPoGroups.every(group => group.components.length > 0);
  const canDeleteBulk = selectedRequirements.length > 0
    && selectedRequirements.every(row => ['draft','saved','pending'].includes(row.approval_status));
  // Bulk approve NARROWS rather than refuses: a mixed selection approves the ones
  // that can be, instead of greying out and making the user work out which row
  // spoiled it. Create Bulk PO and Delete stay all-or-nothing — those two write
  // one shared document, so a partial run would be a wrong document.
  const approvableSelection = selectedRequirements.filter(row => canApproveRow(row)
    && requirementDraft(row).plate_master_id);
  const canApproveBulk = canManage() && approvableSelection.length > 0;
  const allViewSelected = reqRows.length > 0 && reqRows.every(row => selectedIds.includes(row.id));
  // Buying a plate is one job in three steps; the rail above keeps them together.
  const PROCUREMENT_TABS = ['requirements', 'pos', 'grns'];
  const PLATE_STAGES = [
    { key: 'buy', label: 'Requirement → PO → GRN', tabs: PROCUREMENT_TABS,
      dot: 'bg-violet-500', on: 'border-violet-200 bg-violet-50 text-violet-800',
      badge: 'bg-violet-200/70 text-violet-900', hover: 'hover:text-violet-700',
      count: () => reqGroups.open.length
        + pos.filter(row => !['received','closed','reversed'].includes(row.status)).length
        + grns.length },
    { key: 'warehouse', label: 'Plates Warehouse', tabs: ['warehouse'],
      dot: 'bg-sky-500', on: 'border-sky-200 bg-sky-50 text-sky-800',
      badge: 'bg-sky-200/70 text-sky-900', hover: 'hover:text-sky-700',
      count: () => warehouse.filter(row => row.status === 'available'
        && [FRESH_PLATES_RACK, USED_PLATES_RACK].includes(row.rack_location)).length },
    { key: 'returns', label: 'Return from Printing', tabs: ['returns'],
      dot: 'bg-amber-500', on: 'border-amber-200 bg-amber-50 text-amber-800',
      badge: 'bg-amber-200/70 text-amber-900', hover: 'hover:text-amber-700',
      count: () => returns.length },
    { key: 'history', label: 'History', tabs: ['history'],
      dot: 'bg-slate-400', on: 'border-slate-300 bg-slate-100 text-slate-800',
      badge: 'bg-slate-300/70 text-slate-800', hover: 'hover:text-slate-700',
      count: () => history.length },
  ];
  const rackRows = warehouse.filter(row => row.status === 'available'
    && (warehouseView === 'fresh' ? row.rack_location === FRESH_PLATES_RACK : row.rack_location === USED_PLATES_RACK));
  // The size filter narrows the TABLE only. The KPI strip keeps counting the whole
  // rack, so the size cards stay a picture of what is in stock rather than echoing
  // whichever chip happens to be pressed.
  const warehouseRows = sizeView === 'all' ? rackRows : rackRows.filter(row => row.plate_size === sizeView);
  // Counted in physical plates, not sets — a row here is a set of four.
  const rackSummary = plateRackSummary(rackRows);

  const openRequirement = row => { setDetail(row); setEditForm(requirementDraft(row)); setNewPantone(''); };
  // Save-then-approve, from the list, on the suggested size. A draft PR has no
  // size stamped on it yet — that is what the save is for — so this is two calls
  // and one gesture. `busyRow` is not decoration: approve is now one click on a
  // row, and a double-click would otherwise send the second call against
  // component ids the first has already replaced.
  const saveRowDraft = async row => {
    const draft = requirementDraft(row);
    if (!draft.plate_master_id) throw new Error('No plate size on this PR — open it and choose one');
    if (!draftTotal(draft)) throw new Error('This Plate PR has no plates on it');
    await api.put(`/plates/requirements/${row.id}`, draft);
    return api.get(`/plates/requirements/${row.id}`);
  };
  const approveRow = async row => {
    setBusyRow(row.id);
    try {
      const count = await approvePlateRequest({
        request: row, plateMasterId: requirementDraft(row).plate_master_id, save: () => saveRowDraft(row),
      });
      toast.success(`${row.request_number} — ${count} plate${count === 1 ? '' : 's'} approved`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Could not approve this Plate PR');
    } finally { setBusyRow(null); }
  };
  // Sequential on purpose: every approve is two writes on the same PR, and
  // firing a dozen at a pooled serverless backend is how the one-client pool
  // deadlocks. Each PR is reported on its own so a single bad one does not
  // discard the others.
  const approveSelected = async rows => {
    setBulkApproving(true);
    const done = [], failed = [];
    for (const row of rows) {
      try {
        await approvePlateRequest({
          request: row, plateMasterId: requirementDraft(row).plate_master_id, save: () => saveRowDraft(row),
        });
        done.push(row.request_number);
      } catch (error) { failed.push(`${row.request_number}: ${error.message}`); }
    }
    setBulkApproving(false);
    if (done.length) toast.success(`${done.length} Plate PR${done.length === 1 ? '' : 's'} approved`);
    if (failed.length) toast.error(`${failed.length} could not be approved — ${failed[0]}`);
    setSelectedIds([]);
    await load();
  };
  const refreshDetail = async () => {
    await load();
    if (!detail) return null;
    const fresh = await api.get(`/plates/requirements/${detail.id}`);
    setDetail(fresh); setEditForm(requirementDraft(fresh));
    return fresh;
  };
  const fetchProductMasterColours = async () => {
    if (!detail) return;
    const fresh = await api.get(`/plates/requirements/${detail.id}`);
    if (!fresh.product_master_components?.length) return toast.error('No colour total is available in Product Master');
    setDetail(fresh);
    setEditForm(current => ({ ...current, components: editableComponentRows(fresh.product_master_components) }));
    toast.success(`${fresh.product_master_colour_count} colours fetched from Product Master. Review and save the Plate PR.`);
  };
  const openPlatePo = async requests => {
    try {
      const fresh = await Promise.all(requests.map(request => api.get(`/plates/requirements/${request.id}`)));
      const groups = fresh.map(request => ({
        request, components: request.components.filter(component => component.status === 'approved'),
      }));
      if (!groups.length || groups.some(group => !group.components.length)) {
        return toast.error('One or more selected Plate PRs no longer have approved plates');
      }
      setPoModal({ groups });
    } catch (error) { toast.error(error.message || 'Could not fetch finalized Plate PR rows'); }
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
    } else if (action.kind === 'bulk_delete_pr') {
      const result = await api.del('/plates/requirements/bulk', {
        request_ids: action.rows.map(row => row.id), reason,
      });
      toast.success(`${result.deleted} Plate PR${result.deleted === 1 ? '' : 's'} deleted`);
      if (action.rows.some(row => row.id === detail?.id)) { setDetail(null); setEditForm(null); }
      setSelectedIds([]);
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
    { key: 'product_name', label: 'Product', render: row => <PlateProductIdentity row={row} compact /> },
    { key: 'output_number', label: 'Output', render: row => <b className="font-mono text-xs">{row.output_number || '—'}</b> },
    { key: 'components', label: 'Plate Set', sortable: false, render: row => <div><ComponentStrip components={row.components} compact /><span className="mt-1 block text-[10px] font-semibold text-slate-400">{row.plate_summary.ready}/{row.plate_summary.required} ready</span></div> },
    { key: 'delivery_date', label: 'Needed by', render: row => fmt.date(row.needed_by || row.delivery_date) },
    { key: 'approval_status', label: 'PR Status', render: row => <StatusChip value={row.approval_status} /> },
    { key: 'po_number', label: 'PO', render: row => row.po_number || '—' },
    { key: 'actions', label: '', sortable: false, render: row => <div className="flex justify-end gap-1" onClick={event => event.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => openRequirement(row)}><Eye size={12} /> Open</Button>
      {/* Approve without opening the PR. It takes the size the screen already
          suggests, which is the same value the modal opens pre-filled with — so
          this is the modal's default action with the modal skipped, not a second
          policy. Anything unusual (a different size, only some colours, a Pantone
          to name) still wants Open. */}
      {canManage() && canApproveRow(row) && <Button size="sm" variant="success"
        disabled={busyRow === row.id || !requirementDraft(row).plate_master_id}
        title={requirementDraft(row).plate_master_id ? undefined : 'No plate size on this PR — open it and choose one'}
        onClick={() => approveRow(row)}><CheckCircle2 size={12} /> Approve</Button>}
      {canManage() && canUnapproveRow(row) && <Button size="sm" variant="secondary"
        disabled={busyRow === row.id} onClick={() => setReasonAction({
          kind:'unapprove',row,title:`Unapprove ${row.request_number}?`,confirmLabel:'Unapprove',icon:RotateCcw,requireReason:true,
          description:'This reopens the Plate PR as Saved and makes its size and quantities editable. A Plate PO must be reversed first.',
        })}><RotateCcw size={12} /> Unapprove</Button>}
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
    // A PO can carry several plate sets, so its Output is a SET of numbers. It
    // sorts on the first of them via sortValue rather than on the rendered join,
    // which would order "18604, 8520" as one string. Deep search still reaches
    // every number through row.lines[].output_number.
    { key: 'output_number', label: 'Output',
      sortValue: row => [...new Set(row.lines.map(line => line.output_number).filter(Boolean))].sort()[0] || '',
      render: row => {
      const outputs = [...new Set(row.lines.map(line => line.output_number).filter(Boolean))];
      if (!outputs.length) return '—';
      return <span className="font-mono text-xs font-bold">{outputs[0]}
        {outputs.length > 1 && <span className="block text-[10px] font-semibold text-slate-400">+{outputs.length - 1} more</span>}</span>;
    } },
    { key: 'expected_date', label: 'Expected', render: row => fmt.date(row.expected_date) },
    { key: 'total', label: 'Total', align: 'right', sortable: false, render: row => fmt.inr(poTotals(row.lines.map(line => ({
      ...line, material_id: line.inventory_item_id,
    })), { freight: row.freight, taxKind: row.tax_kind, round_off: row.round_off }).grand) },
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
    { key: 'output_number', label: 'Output', render: row => <b className="font-mono text-xs">{row.output_number || '—'}</b> },
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
    { key: 'asset_number', label: 'Plate Set', render: row => <span><b className="font-mono text-xs">{row.asset_number}</b><span className="block text-[11px] text-slate-400">{row.qty || row.components?.length || 1} plates</span></span> },
    { key: 'product_name', label: 'Product', render: row => <PlateProductIdentity row={row} compact /> },
    { key: 'component_label', label: 'Contains', render: row => <span className="font-semibold">{row.contains || row.component_label}</span> },
    // Size earns its own sortable column: it is how the rack is physically organised
    // and the first thing asked when a job needs plates.
    { key: 'plate_size', label: 'Size', render: row => <span className="whitespace-nowrap font-mono text-xs font-bold text-slate-700">{row.plate_size || '—'}</span> },
    // Output earns its own column on the rack, as it already had on every other
    // plate screen. It was rendered inside the artwork cell — so the column
    // SORTED and searched on artwork_version while showing the output number
    // above it, and the number the plant actually calls a plate by could not be
    // ordered or found at all.
    { key: 'output_number', label: 'Output', render: row => <b className="font-mono text-xs">{row.output_number || '—'}</b> },
    { key: 'artwork_version', label: 'Artwork', render: row => <span className="text-xs text-slate-500">{row.artwork_version || '—'}</span> },
    { key: 'rack_location', label: 'Storage', render: row => row.rack_location || '—' },
    { key: 'use_count', label: 'Uses', align: 'right' },
    { key: 'last_used_at', label: 'Last Used', render: row => fmt.date(row.last_used_at) },
    { key: 'age_days', label: 'Age', align: 'right', render: row => `${row.age_days || 0} d` },
    { key: 'status', label: 'Status', render: row => <StatusChip value={row.status} /> },
    // Retire the whole set from the LIST — the usual reason (artwork changed, set
    // damaged) kills every plate in it, so making someone open the set to tick each
    // plate is the slow way to say one thing.
    { key: 'actions', label: '', sortable: false, render: row => (
      <div className="flex items-center justify-end gap-1">
        {canManage() && <Button size="sm" variant="ghost" title={`Retire all ${row.qty || row.components?.length || 1} plates in this set`}
          onClick={event => { event.stopPropagation(); setRetiring({ rows: [row], reason: '', note: '' }); }}>
          <Trash2 size={12} />
        </Button>}
        <Button size="sm" variant="secondary" onClick={event => { event.stopPropagation(); setAssetHistory(row); }}><History size={12} /></Button>
      </div>
    ) },
  ];
  const returnColumns = [
    { key: 'asset_number', label: 'Plate Set', render: row => <span><b>{row.asset_number}</b><span className="block text-[11px] text-slate-400">{row.qty || row.components?.length || 1} plates</span></span> },
    { key: 'product_name', label: 'Product', render: row => <PlateProductIdentity row={row} compact /> },
    { key: 'output_number', label: 'Output', render: row => <b className="font-mono text-xs">{row.output_number || '—'}</b> },
    { key: 'component_label', label: 'Contains', render: row => <span>{row.contains || row.component_label}<span className="block text-[11px] text-slate-400">{row.plate_size}</span></span> },
    { key: 'jc_number', label: 'Job Card' },
    // How much life this set has already had. Shown, never enforced — the decision
    // stays with the person holding the plate.
    { key: 'use_count', label: 'Uses', align: 'right', render: row => {
      const uses = Number(row.use_count) || 0;
      return <span className="tabular-nums font-bold">{uses}</span>;
    } },
    // The press's verdict is why a mixed job arrives here as two cards rather than
    // one, so it has to be legible — a Damaged card carries its reason beneath it.
    { key: 'condition', label: 'Press Says', render: row => {
      const condition = row.condition || 'Good';
      const tone = condition === 'Damaged' ? 'bg-red-50 text-red-700'
        : condition === 'Fair' ? 'bg-amber-50 text-amber-700'
        : 'bg-emerald-50 text-emerald-700';
      return <span>
        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold ${tone}`}>{condition}</span>
        {row.operator_note && <span className="mt-0.5 block text-[11px] text-slate-500">{row.operator_note}</span>}
      </span>;
    } },
    { key: 'returned_by', label: 'Returned By' },
    { key: 'return_date', label: 'Returned', render: row => fmt.dt(row.return_date) },
    { key: 'previous_location', label: 'Previous Rack', render: row => row.previous_location || row.rack_location || '—' },
    { key: 'actions', label: '', sortable: false, render: row => canVerify() ? <Button size="sm" variant="success" onClick={event => { event.stopPropagation(); setReturnModal(row); }}><FileCheck2 size={12} /> Verify</Button> : null },
  ];
  const historyColumns = [
    { key: 'at', label: 'When', render: row => fmt.dt(row.at) },
    { key: 'asset_number', label: 'Plate', render: row => <b>{row.asset_number}</b> },
    { key: 'product_name', label: 'Product', render: row => `${row.product_code} · ${row.product_name}` },
    { key: 'output_number', label: 'Output', render: row => <b className="font-mono text-xs">{row.output_number || '—'}</b> },
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
    {/* The strip follows the TAB. It used to be five requirement counters that sat
        frozen at zero while you were reading the warehouse — a band of chrome that
        answered a question you had not asked. Each tab now states its own figures. */}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tab === 'warehouse' ? <>
        <KpiCard compact label={warehouseView === 'fresh' ? 'Fresh rack' : 'Used rack'}
          value={rackSummary.total} icon={Warehouse} tone={rackSummary.total ? 'good' : 'neutral'} />
        {/* Wear leads, shelf age sits under it. Age alone cannot separate a plate cut
            in March that has run eleven times from one cut in March that has never
            run — and it is the first that gets issued by mistake. */}
        <KpiCard compact label="Average wear"
          value={`${rackSummary.avg_runs} ${rackSummary.avg_runs === 1 ? 'run' : 'runs'}`}
          sub={`${rackSummary.avg_age_days} d on the shelf`} icon={History} />
        {rackSummary.by_size.map(row => (
          <KpiCard key={row.plate_size} compact label={row.plate_size} value={row.plates} icon={Layers} />
        ))}
      </> : tab === 'returns' ? <>
        <KpiCard compact label="Sets to verify" value={returns.length} icon={Warehouse} tone={returns.length ? 'warn' : 'neutral'} />
        <KpiCard compact label="Plates waiting" value={returns.reduce((sum, row) => sum + (row.qty || 1), 0)} icon={Layers} />
        {/* Accumulator deliberately not named `worst`: board-state-one-name.test.js
            greps for `reduce((worst` to stop the board collapse being re-spelled,
            and this is a plain maximum over run counts. */}
        <KpiCard compact label="Most runs waiting"
          value={returns.reduce((highest, row) => Math.max(highest, Number(row.use_count) || 0), 0)} icon={History} />
        <KpiCard compact label="Damaged returns"
          value={returns.filter(row => row.condition === 'Damaged').length} icon={AlertTriangle}
          tone={returns.some(row => row.condition === 'Damaged') ? 'warn' : 'neutral'} />
      </> : <>
        <KpiCard compact label="Verify Existing" value={counts.verify} icon={FileCheck2} tone={counts.verify ? 'warn' : 'neutral'} />
        <KpiCard compact label="Approval Required" value={counts.approval} icon={ClipboardCheck} tone={counts.approval ? 'warn' : 'neutral'} />
        <KpiCard compact label="On Order" value={counts.ordered} icon={Truck} />
        <KpiCard compact label="Jobs Ready" value={counts.ready} icon={CheckCircle2} tone="good" />
      </>}
    </div>
    {/* Four stages of a plate's life, not six screens. Buying one — raise the need,
        order it, receive it — is a single continuous job done by a single person, so
        PR/PO/GRN live behind one chip with their own step rail inside. The rack, the
        press returns and the archive are genuinely separate places and stay separate.
        Colour carries the stage: violet while it is being bought, sky once it is
        stock, amber while the press still owes it back, slate for the archive. */}
    <div className="flex flex-wrap items-center gap-2">
      {PLATE_STAGES.map(stage => {
        const on = stage.tabs.includes(tab);
        const count = stage.count();
        return (
          <button key={stage.key} type="button"
            onClick={() => setTab(stage.tabs[0])}
            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-bold transition-colors ${on ? stage.on : `border-transparent text-slate-500 hover:bg-slate-100 ${stage.hover}`}`}>
            <span className={`h-2 w-2 rounded-full ${stage.dot}`} />
            {stage.label}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? stage.badge : 'bg-slate-200/70 text-slate-600'}`}>{count}</span>
          </button>
        );
      })}
    </div>
    {/* The buying steps, only while you are in that stage. */}
    {PROCUREMENT_TABS.includes(tab) && (
      <SubTabs active={tab} onChange={setTab} views={[
        { key:'requirements',label:'Requirement / PR',count:reqGroups.open.length },
        { key:'pos',label:'Purchase Orders',count:pos.filter(row=>!['received','closed','reversed'].includes(row.status)).length },
        { key:'grns',label:'GRN',count:grns.length },
      ]}/>
    )}
    {tab==='requirements' && <>
      {selectedIds.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
        <b className="mr-auto text-sm text-brand-900">{selectedIds.length} selected</b>
        {!canApproveBulk && !canCreateBulkPo && !canDeleteBulk && <span className="text-xs font-semibold text-amber-700">Select unapproved PRs to approve, approved PRs for a PO, or editable PRs to delete</span>}
        {!allViewSelected && <Button size="sm" variant="ghost" onClick={() => setSelectedIds(current => [...new Set([...current, ...reqRows.map(row => row.id)])])}>Select all</Button>}
        <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Deselect all</Button>
        {/* Thirteen PRs raised in one go want approving in one go. Same gesture as
            the row button, run one at a time. */}
        <Button size="sm" variant="success" disabled={!canApproveBulk || bulkApproving}
          onClick={() => approveSelected(approvableSelection)}>
          <CheckCircle2 size={13} /> {bulkApproving ? 'Approving…' : `Approve ${approvableSelection.length}`}
        </Button>
        <Button size="sm" disabled={!canCreateBulkPo} onClick={() => openPlatePo(selectedRequirements)}><ShoppingBag size={13} /> Create Bulk PO</Button>
        <Button size="sm" variant="danger" disabled={!canDeleteBulk} onClick={() => setReasonAction({
          kind:'bulk_delete_pr',rows:selectedRequirements,title:`Delete ${selectedRequirements.length} Plate PR${selectedRequirements.length===1?'':'s'}?`,
          confirmLabel:'Delete selected PRs',icon:Trash2,danger:true,requireReason:true,
          description:'This permanently removes every selected editable Plate PR. The entire action is blocked if any selected PR has approval, PO, GRN or production activity.',
        })}><Trash2 size={13} /> Delete PRs</Button>
      </div>}
      {/* One line, two questions: WHICH requirements (the stage they are at) and, in
          a lighter weight beside it, whether they are approved. Two full-width chip
          bands stacked on top of each other read as one undifferentiated wall — and
          the approval question only ever narrows the stage you have already chosen,
          so it should never carry the same visual weight. */}
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs active={reqView} onChange={value=>{setReqView(value);setSelectedIds([]);}} views={[
          {key:'open',label:'Open',count:reqGroups.open.length},
          {key:'converted',label:'Converted',count:reqGroups.converted.length},
          {key:'ready',label:'Ready',count:reqGroups.ready.length},
          {key:'all',label:'All',count:requirements.length},
        ]}/>
        {reqView !== 'converted' && (
          <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white/70 p-0.5">
            {[
              // "All approvals", not "All": the stage filter beside it already has an
              // "All", and two identical chips a centimetre apart meaning different
              // things is worse than the extra word.
              { key: 'all', label: 'All approvals', count: lifecycleRows.length },
              { key: 'approved', label: 'Approved', count: lifecycleRows.filter(row=>approvedStatuses.has(row.approval_status)).length },
              { key: 'unapproved', label: 'Unapproved', count: lifecycleRows.filter(row=>!approvedStatuses.has(row.approval_status)).length },
            ].map(option => {
              const on = approvalView === option.key;
              return (
                <button key={option.key} type="button"
                  onClick={()=>{setApprovalView(option.key);setSelectedIds([]);}}
                  className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
                  {option.label}<span className={`ml-1 tabular-nums ${on ? 'text-white/70' : 'text-slate-400'}`}>{option.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <DataTable searchable selectable rows={reqRows} columns={requestColumns}
      selectedIds={selectedIds}
      onToggleRow={(row, checked) => setSelectedIds(current => checked ? [...new Set([...current,row.id])] : current.filter(id => id !== row.id))}
      onToggleAll={(rows, checked) => { const ids=rows.map(row=>row.id); setSelectedIds(current=>checked?[...new Set([...current,...ids])]:current.filter(id=>!ids.includes(id))); }}
      onRowClick={openRequirement} empty="No plate requirements in this view" exportName="Plate Requirements" /></>}
    {/* Retire from the list view. Whole sets, no drill-in: the reasons that kill a
        plate usually kill the set it belongs to. The reason is OPTIONAL — offered as
        one-tap chips so recording it is easier than skipping it, never as a gate. */}
    {retiring && <Modal open onClose={()=>setRetiring(null)}
      title={`Retire ${retiring.rows.reduce((sum,row)=>sum+(row.qty||row.components?.length||1),0)} plate(s)`}
      footer={<>
        <Button variant="secondary" onClick={()=>setRetiring(null)}>Cancel</Button>
        <Button variant="danger" onClick={()=>retirePlates().catch(error=>toast.error(error.message))}>
          <Trash2 size={14}/> Retire to scrap
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="ci-summary-panel text-xs text-slate-600">
          These plates leave the rack for <b>Scrap</b> and stop being offered for reuse.
          Anything already on a press is skipped.
        </div>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Going to scrap</span><span>{retiring.rows.length} set(s)</span></div>
          <div>{retiring.rows.map(row=>(
            <div key={row.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 last:border-0">
              <span className="min-w-0 flex-1">
                <b className="text-sm text-slate-800">{row.contains || row.component_label}</b>
                <span className="block font-mono text-[10px] text-slate-400">
                  {row.qty || row.components?.length || 1} plate set · {row.plate_size} · {row.product_name}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-bold tabular-nums text-slate-700">{row.use_count || 0}</span>
                <span className="block text-[10px] text-slate-400">runs</span>
              </span>
            </div>
          ))}</div>
        </section>
        <div>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Reason <span className="normal-case tracking-normal text-slate-400">(optional)</span></div>
          <div className="flex flex-wrap gap-1.5">
            {PLATE_RETIRE_REASONS.map(option=>{
              const on = retiring.reason === option;
              return <button key={option} type="button"
                onClick={()=>setRetiring(current=>({...current, reason: on ? '' : option}))}
                className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-red-500 bg-red-50 text-red-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {option}
              </button>;
            })}
          </div>
        </div>
        {(retiring.reason === 'Other' || retiring.note) && (
          <Field label="Note"><Input value={retiring.note} placeholder="Anything worth recording (optional)"
            onChange={event=>setRetiring(current=>({...current, note:event.target.value}))} /></Field>
        )}
      </div>
    </Modal>}
    {/* Ad-hoc issue: the rack already holds the plates, so the job takes them without
        a PR being raised to buy what exists. It still lands on a JOB, so the plate
        returns through the normal completion flow. */}
    {issuing && <Modal open onClose={()=>setIssuing(null)} title={`Issue ${issuing.rows.length} plate set(s) from the rack`}
      footer={<>
        <Button variant="secondary" onClick={()=>setIssuing(null)}>Cancel</Button>
        <Button disabled={!issuing.job_card_id} onClick={()=>issuePlates().catch(error=>toast.error(error.message))}>
          <Send size={14}/> Issue &amp; mark tooling
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="ci-summary-panel text-xs text-slate-600">
          {issuing.rows.reduce((sum,row)=>sum+(row.qty||row.components?.length||1),0)} plates across {issuing.rows.length} set(s).
          Issuing marks this job's tooling gate satisfied, so the readiness light stops asking for plates it already has.
        </div>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Plates going out</span><span>from the {warehouseView === 'fresh' ? 'Fresh' : 'Used'} rack</span></div>
          <div>{issuing.rows.map(row=><div key={row.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 last:border-0">
            <span className="min-w-0 flex-1"><b className="text-sm text-slate-800">{row.contains || row.component_label}</b>
              <span className="block font-mono text-[10px] text-slate-400">{row.asset_number} · {row.plate_size}</span></span>
            <span className="shrink-0 text-right"><span className="block text-sm font-bold tabular-nums text-slate-700">{row.use_count || 0}</span>
              <span className="block text-[10px] text-slate-400">runs</span></span>
          </div>)}</div>
        </section>
        <Field label="Issue to job card" required>
          <SearchableSelect value={issuing.job_card_id}
            onChange={event=>setIssuing(current=>({...current, job_card_id:event.target.value}))}>
            <option value="">Choose the job these plates are for</option>
            {openJobs.map(job=><option key={job.id} value={job.id}>{job.jc_number} · {job.product_name}</option>)}
          </SearchableSelect>
        </Field>
        <Field label="Note"><Input value={issuing.note}
          onChange={event=>setIssuing(current=>({...current, note:event.target.value}))}
          placeholder="Why these are going out without a PR (optional)" /></Field>
      </div>
    </Modal>}
    {tab==='pos' && <DataTable searchable rows={pos} columns={poColumns} empty="No Plate Purchase Orders" exportName="Plate Purchase Orders" />}
    {tab==='grns' && <DataTable searchable rows={grns} columns={grnColumns} empty="No Plate GRNs" exportName="Plate GRN Register" />}
    {tab==='warehouse' && <>
      {/* Rack switch sits with the selection bar rather than on a band of its own —
          the KPI strip above already names which rack you are in. */}
      <div className="flex flex-wrap items-center gap-2">
        <SubTabs active={warehouseView} onChange={value=>{setWarehouseView(value);setRackPicked([]);}} views={[
          {key:'fresh',label:'Fresh',count:warehouse.filter(row=>row.status==='available'&&row.rack_location===FRESH_PLATES_RACK).length},
          {key:'used',label:'Used',count:warehouse.filter(row=>row.status==='available'&&row.rack_location===USED_PLATES_RACK).length},
        ]}/>
        {/* Size sits BESIDE the rack switch, not on a rail of its own — a second full
            band of chips is what made this page read as clutter. Lighter weight than
            the rack tabs because it narrows a view rather than changing which view
            you are in. 600 x 730 leads: it is the plant's main offset size. */}
        <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white/70 p-0.5">
          {[{ key: 'all', label: 'All sizes' }, ...PLATE_SIZES_IN_ORDER.map(size => ({ key: size, label: size }))].map(option => {
            const on = sizeView === option.key;
            const plates = option.key === 'all'
              ? rackSummary.total
              : (rackSummary.by_size.find(row => row.plate_size === option.key)?.plates || 0);
            return (
              <button key={option.key} type="button"
                onClick={() => { setSizeView(option.key); setRackPicked([]); }}
                className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
                {option.label}<span className={`ml-1 tabular-nums ${on ? 'text-white/70' : 'text-slate-400'}`}>{plates}</span>
              </button>
            );
          })}
        </div>
        {rackPicked.length > 0 && <div className="ml-auto flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5">
          <b className="text-sm text-brand-900">{rackPicked.length} plate set(s) ticked</b>
          <Button size="sm" variant="ghost" onClick={()=>setRackPicked([])}>Clear</Button>
          {canManage() && <Button size="sm" onClick={()=>setIssuing({ rows: warehouseRows.filter(row=>rackPicked.includes(row.id)), job_card_id:'', note:'' })}>
            <Send size={13}/> Issue to a Job
          </Button>}
          {canManage() && <Button size="sm" variant="danger" onClick={()=>setRetiring({ rows: warehouseRows.filter(row=>rackPicked.includes(row.id)), reason:'', note:'' })}>
            <Trash2 size={13}/> Retire
          </Button>}
        </div>}
      </div>
      <DataTable searchable selectable rows={warehouseRows} columns={warehouseColumns}
        selectedIds={rackPicked}
        onToggleRow={(row,checked)=>setRackPicked(current=>checked?[...current,row.id]:current.filter(id=>id!==row.id))}
        onToggleAll={(rows,checked)=>{ const ids=rows.map(row=>row.id); setRackPicked(current=>checked?[...new Set([...current,...ids])]:current.filter(id=>!ids.includes(id))); }}
        onRowClick={setAssetHistory} empty="No available plate sets in this rack" exportName="Plates Warehouse" />
    </>}
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
        <div className="flex flex-wrap items-start justify-between gap-3"><PlateProductIdentity row={detail} /><StatusChip value={detail.approval_status}/></div>
        <div className="grid gap-3 sm:grid-cols-5">{[
          ['Customer',detail.customer_name],['Output',detail.output_number || '—'],['Required',`${draftTotal(editForm)} plates`],['Ready',`${detail.plate_summary.ready}/${detail.plate_summary.required}`],['Needed',fmt.date(detail.needed_by||detail.delivery_date)],
        ].map(([label,value])=><div key={label} className="border-b border-slate-100 pb-2"><span className="text-[10px] font-bold uppercase text-slate-400">{label}</span><p className="text-sm font-semibold">{value}</p></div>)}</div>
        {detail.is_gang && detail.gang_members?.length > 0 && <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Gang members</span><span>{detail.gang_members.length} products · one Plate Set</span></div>
          <div className="divide-y divide-slate-100">{detail.gang_members.map(member => <div key={`${member.order_line_id}-${member.product_id}`} className="grid gap-1 py-2 text-xs sm:grid-cols-[1fr_110px_120px]">
            <span><b className="text-slate-700">{member.product_name}</b><span className="block text-[10px] text-slate-400">{member.product_code || 'No internal code'}</span></span>
            <span><b className="block text-[10px] uppercase text-slate-400">Output</b>{member.output_number || '—'}</span>
            <span><b className="block text-[10px] uppercase text-slate-400">Artwork</b>{member.artwork_version || member.party_artwork_code || '—'}</span>
          </div>)}</div>
        </section>}
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
        <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Plate colour and quantity</span><div className="flex flex-wrap items-center justify-end gap-2"><span>0 removes a colour · Product Master: {detail.product_master_colour_count ?? '—'} colours</span>{detailEditable && <Button size="sm" variant="secondary" onClick={() => fetchProductMasterColours().catch(error => toast.error(error.message))}><RotateCcw size={12}/> Fetch Master Colours</Button>}</div></div>
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
            {/* This row IS the reuse decision — whether an existing rack plate is good
                enough to print again. The API already returns both age signals; showing
                them costs nothing and is the whole point of tracking a plate's life. */}
            <div><b className="text-sm">{component.component_label}</b><span className="ml-2 text-xs text-slate-500">{component.proposed_asset_number} · {component.proposed_rack_location||'rack pending'} · used {component.proposed_use_count||0} times{component.proposed_last_used_at?` · last ${fmt.date(component.proposed_last_used_at)}`:''}</span></div>
            {canVerify()&&<Button size="sm" variant="secondary" onClick={()=>setVerifying(component)}><FileCheck2 size={12}/> Verify</Button>}
          </div>)}</div>
        </section>}
        {detail.components.some(component=>component.older_artwork_count>0) && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"><AlertTriangle size={14} className="mt-0.5 shrink-0"/>Existing plates belong to an older artwork version and are excluded from reuse.</div>}
        {canManage() && detail.components.some(component=>component.status==='approved') && <div className="flex justify-end"><Button onClick={()=>openPlatePo([detail])}><ShoppingBag size={14}/> Create PO for Approved Plates</Button></div>}
        {detail.events?.length>0 && <section><div className="mb-2 text-xs font-bold uppercase text-slate-500">Activity</div><div className="space-y-2">{detail.events.map(event=><div key={event.id} className="grid gap-1 border-l-2 border-slate-200 pl-3 sm:grid-cols-[150px_1fr_auto]">
          <span className="text-xs font-semibold text-slate-700">{statusLabel(event.action)}</span><span className="text-xs text-slate-500">{event.note||'—'}</span><span className="text-[11px] text-slate-400">{event.user_name||'System'} · {fmt.dt(event.at)}</span>
        </div>)}</div></section>}
      </div>
    </Modal>}
    {verifying && <VerificationModal component={verifying} onClose={()=>setVerifying(null)} onSaved={refreshDetail}/>}
    {approving && detail && editForm && <ApproveModal request={detail} draft={editForm} masters={masters} onSaveDraft={saveRequirement} onClose={()=>setApproving(false)} onSaved={refreshDetail}/>}
    {poModal && <PlatePoModal groups={poModal.groups} vendors={vendors} plateRates={plateRates} onClose={()=>setPoModal(null)} onSaved={async()=>{setSelectedIds([]);await refreshDetail();}}/>}
    {grnModal && <PlateGrnModal po={grnModal.po} line={grnModal.line} onClose={()=>setGrnModal(null)} onSaved={load}/>}
    {returnModal && <ReturnModal asset={returnModal} onClose={()=>setReturnModal(null)} onSaved={load}/>}
    {assetHistory && <AssetHistoryModal asset={assetHistory} onClose={()=>setAssetHistory(null)} onChanged={load}/>}
    {reasonAction && <ReasonActionModal action={reasonAction} onClose={()=>setReasonAction(null)} onConfirm={performReasonAction}/>}
  </div>;
}
