import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardCheck, Eye, FileCheck2, History,
  Minus, PackagePlus, Plus, Printer, RotateCcw, Save, Send, ShoppingBag,
  Layers3 as Layers, Pencil, Trash2, Truck, Warehouse,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import { lineAmount, lineTaxable, poTotals } from '../lib/poTotals.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { masterOutputSync, plateRackSummary, PLATE_SIZES_IN_ORDER, PLATE_RETIRE_REASONS, PLATE_SET_ASIDE_REASONS } from '../lib/plateRack.js';

// The movement actions a set-aside writes, and therefore the only ones Undo may
// offer. Derived from the same table the picker offers and the server keys on,
// so a fourth reason can never appear in one place and not the other.
const UNDOABLE_SET_ASIDE_ACTIONS = PLATE_SET_ASIDE_REASONS.map(row => row.action);
import { resolvePlateRate } from '../lib/plateRates.js';
import {
  ActionMenu, Button, Checkbox, DataTable, Field, FulfillmentBar, Input,
  KpiCard, Modal, PageHeader, SearchableSelect, searchText, Select, SelectionDock, SubTabs, Tabs,
  Textarea, useToast,
} from './ui.jsx';
import ProductIdentity from './ProductIdentity.jsx';
import RackPickerModal from './RackPickerModal.jsx';
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
// A PR is ready to become a PO when it holds plates that were approved and
// nothing has bought them yet. The row button and the bulk dock ask this same
// question so one can never offer what the other refuses.
const canCreatePoRow = row => !row?.po_number
  && (row?.components || []).some(component => component.status === 'approved');

// The two PO doors, mirroring the server's own guards (PUT and DELETE in
// routes/plates.js) so a button is never offered that the API will refuse.
//
// EDIT: anything not cancelled. A part-received PO can still have its expected
// date or terms corrected; the server refuses the LINE edits on its own.
const canEditPo = row => row?.status !== 'reversed';
// DELETE: only a PO nobody outside this screen has seen — never sent, nothing
// received, still open. Everything else must be REVERSED, so the number and the
// vendor's paper trail survive.
const canDeletePo = row => row?.status === 'open' && !row?.sent_at
  && !(row?.lines || []).some(line => Number(line.received_qty) > 0);
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

// ── The rack, read straight off the requirement ───────────────────────────
// The server computes both figures (rackReusePlan in server/src/plates.js) and
// ships them on the row, so the screen does no arithmetic of its own. That is
// deliberate: the number printed here has to be the number the button spends,
// and the only way two sides cannot drift is for one of them not to count.
const rackTotal = row => Number(row?.rack_reuse?.total) || 0;
const rackNeeded = row => Number(row?.rack_reuse?.needed) || 0;
const rackLineFor = (row, key) => (row?.rack_reuse?.lines || []).find(line => line.key === key);

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

// Correct a Plate PO in place, instead of reversing it and retyping the whole
// document because a date or a rate was wrong.
//
// The header is always editable while the PO is alive. The LINES are only
// editable until a plate arrives — after that the qty and rate sit underneath a
// GRN, and the server refuses them. This modal says which state it is in rather
// than presenting fields that will bounce.
//
// QTY IS NOT EDITABLE, deliberately and at both ends: a plate line's quantity
// IS the number of approved components pointing at it. Changing it here would
// leave the two disagreeing with nothing to reconcile them — add or remove
// plates on the requirement instead.
function PlatePoEditModal({ po, vendors, onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const received = (po.lines || []).some(line => Number(line.received_qty) > 0);
  const [form, setForm] = useState({
    vendor_id: po.vendor_id ? String(po.vendor_id) : '',
    expected_date: po.expected_date ? String(po.expected_date).slice(0, 10) : '',
    reference: po.reference || '',
    payment_terms: po.payment_terms || '',
    delivery_terms: po.delivery_terms || '',
    vendor_notes: po.vendor_notes || '',
    tax_kind: po.tax_kind || 'intra',
    freight: po.freight ?? 0,
    round_off: po.round_off ?? 0,
  });
  const [lines, setLines] = useState((po.lines || []).map(line => ({
    id: line.id, label: line.item_name || line.plate_size || `Line ${line.id}`,
    qty: line.qty, rate: line.rate, discount_pct: line.discount_pct ?? 0,
    gst_rate: line.gst_rate ?? 0, hsn_code: line.hsn_code || '',
  })));
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const setLine = (id, key, value) => setLines(current => current.map(row => row.id === id ? { ...row, [key]: value } : row));

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/plates/purchase-orders/${po.id}`, {
        ...form,
        vendor_id: form.vendor_id ? Number(form.vendor_id) : null,
        // Lines are sent only when they can be taken; the server refuses them
        // on a received PO and there is no reason to make it say so.
        lines: received ? [] : lines.map(row => ({
          id: row.id, rate: row.rate, discount_pct: row.discount_pct,
          gst_rate: row.gst_rate, hsn_code: row.hsn_code,
        })),
      });
      toast.success(`${po.po_number} updated`);
      onSaved?.();
      onClose();
    } catch (error) {
      toast.error(error.message || 'Could not update this Plate PO');
    } finally { setBusy(false); }
  };

  return <Modal open onClose={onClose} wide title={`Edit ${po.po_number}`}
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={busy || !form.vendor_id} onClick={save}><Save size={14} /> Save PO</Button></>}>
    {received && (
      <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
        <AlertTriangle size={14} className="mt-px shrink-0" />
        <span>Plates have already been received on this PO, so its vendor and line rates are fixed.
          The delivery date, terms and notes can still be corrected. To change a rate, reverse the GRN first.</span>
      </div>
    )}
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Purchase Order</span><span>{po.po_number}</span></div>
      <div className="ci-form-grid">
        <Field label="Vendor">
          <SearchableSelect value={form.vendor_id} disabled={received}
            onChange={value => set('vendor_id', value)}
            options={(vendors || []).map(vendor => ({ value: String(vendor.id), label: vendor.name }))} />
        </Field>
        <Field label="Expected date">
          <Input type="date" value={form.expected_date} onChange={e => set('expected_date', e.target.value)} />
        </Field>
        <Field label="Reference">
          <Input value={form.reference} onChange={e => set('reference', e.target.value)} />
        </Field>
        <Field label="Tax">
          <Select value={form.tax_kind} onChange={e => set('tax_kind', e.target.value)}
            options={[{ value: 'intra', label: 'CGST + SGST (within state)' }, { value: 'inter', label: 'IGST (inter-state)' }]} />
        </Field>
        <Field label="Freight">
          <Input type="number" value={form.freight} onChange={e => set('freight', e.target.value)} />
        </Field>
        <Field label="Round off">
          <Input type="number" value={form.round_off} onChange={e => set('round_off', e.target.value)} />
        </Field>
        <Field label="Payment terms">
          <Input value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} />
        </Field>
        <Field label="Delivery terms">
          <Input value={form.delivery_terms} onChange={e => set('delivery_terms', e.target.value)} />
        </Field>
      </div>
      <Field label="Notes to vendor">
        <Textarea rows={2} value={form.vendor_notes} onChange={e => set('vendor_notes', e.target.value)} />
      </Field>
    </section>
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Lines</span><span>quantity follows the requirement</span></div>
      <div className="space-y-2">
        {lines.map(line => (
          <div key={line.id} className="grid grid-cols-2 items-end gap-2 rounded-xl border border-slate-200 px-3 py-2 md:grid-cols-5">
            <div className="col-span-2 md:col-span-1">
              <div className="text-xs font-bold text-slate-700">{line.label}</div>
              <div className="text-[11px] text-slate-400">{line.qty} plates</div>
            </div>
            <Field label="Rate">
              <Input type="number" disabled={received} value={line.rate}
                onChange={e => setLine(line.id, 'rate', e.target.value)} />
            </Field>
            <Field label="Disc %">
              <Input type="number" disabled={received} value={line.discount_pct}
                onChange={e => setLine(line.id, 'discount_pct', e.target.value)} />
            </Field>
            <Field label="GST %">
              <Input type="number" disabled={received} value={line.gst_rate}
                onChange={e => setLine(line.id, 'gst_rate', e.target.value)} />
            </Field>
            <Field label="HSN">
              <Input disabled={received} value={line.hsn_code}
                onChange={e => setLine(line.id, 'hsn_code', e.target.value)} />
            </Field>
          </div>
        ))}
        {!lines.length && <p className="py-2 text-center text-sm text-slate-400">This PO has no lines.</p>}
      </div>
    </section>
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

// ── Add plates already in the plant ───────────────────────────────────────
// Stock that never came through a PR/PO/GRN: opening stock, a set cut outside the
// system, plates found on a shelf.
//
// TWO WAYS IN, and the second is not a fallback. The output number is how the
// plant names a job and is the fast key — but it is NOT a gate: plenty of cartons
// have no number on the master yet, and the number is exactly the thing nobody
// remembers for old stock. Making it mandatory turned a two-second entry into a
// dead end. Either key resolves the SAME context, so neither can drift.
//
// Whatever is known gets written back through Sync Master?, the plant's existing
// fork for output_number (Artwork form, Planning). That is what stops this screen
// from being a place where the plant's knowledge goes to die.
function rackEntryRows(components = []) {
  const byType = new Map(components.filter(row => row.component_type !== 'pantone')
    .map(row => [row.component_type, row]));
  return [
    ...PROCESS_PLATES.map(([component_type, component_label]) => ({
      component_type, component_label, pantone_code: null, qty: byType.get(component_type)?.qty || 0,
    })),
    ...components.filter(row => row.component_type === 'pantone').map(row => ({
      component_type: 'pantone', component_label: row.component_label,
      pantone_code: row.pantone_code, qty: Number(row.qty) || 1,
    })),
  ];
}

const RACK_CHOICES = [
  { key: 'fresh', label: 'Fresh', hint: 'Never printed', conditions: ['Good'] },
  { key: 'used', label: 'Used', hint: 'Has already run', conditions: ['Good', 'Fair'] },
];

function AddPlatesModal({ masters, defaultRack, onClose, onSaved }) {
  const toast = useToast();
  const [mode, setMode] = useState('output');
  const [number, setNumber] = useState('');
  const [productId, setProductId] = useState('');
  const [products, setProducts] = useState([]);
  const [looking, setLooking] = useState(false);
  const [lookup, setLookup] = useState(null);
  const [match, setMatch] = useState(null);
  const [form, setForm] = useState(null);
  const [newPantone, setNewPantone] = useState('');
  const [busy, setBusy] = useState(false);

  // Only when the product door is opened — most entries never need the list, and
  // it is 1,600 rows.
  useEffect(() => {
    if (mode !== 'product' || products.length) return;
    api.get('/plates/entry-products').then(setProducts).catch(() => {});
  }, [mode, products.length]);

  const choose = picked => {
    setMatch(picked);
    setForm({
      rack: defaultRack === 'used' ? 'used' : 'fresh',
      condition: 'Good',
      plate_master_id: masters.find(row => row.plate_size === picked.plate_size)?.id || '',
      artwork_version: picked.artwork_version || '',
      // Editable in the form, wherever it came from. Entering by product with the
      // number in hand is the whole reason Sync Master? has anything to offer.
      output_number: picked.output_number || '',
      update_master: masterOutputSync({
        typed: picked.output_number, master: picked.master_output_number,
      }).suggested,
      remarks: '',
      components: rackEntryRows(picked.components),
    });
  };

  const clear = () => { setMatch(null); setForm(null); setLookup(null); };

  // Editing the number throws away what the last one resolved to. Without this the
  // panel keeps naming the OLD carton under a number that has been changed, and
  // Add writes the plates against it — the operator's own correction is what makes
  // the screen lie. Cleared on edit, not merely disabled: a stale identity panel is
  // the thing being read to decide this is the right job.
  const retype = value => {
    setNumber(value);
    if (value.trim() !== (match?.output_number || '')) clear();
  };

  const swapMode = next => { setMode(next); setNumber(''); setProductId(''); clear(); };

  const find = async (query = `output_number=${encodeURIComponent(number.trim())}`) => {
    setLooking(true); setMatch(null); setForm(null);
    try {
      const result = await api.get(`/plates/entry-context?${query}`);
      setLookup(result);
      // One match is not a choice — fill the form and let them get on with it.
      if (result.matches.length === 1) choose(result.matches[0]);
    } catch (error) { toast.error(error.message || 'That job could not be looked up'); }
    finally { setLooking(false); }
  };

  const pickProduct = value => {
    setProductId(value);
    clear();
    if (value) find(`product_id=${encodeURIComponent(value)}`);
  };

  // The Sync Master? state, asked of the number as it stands in the form, using
  // the SAME rule the route re-asks before writing (lib/plateRack.js). This only
  // decides what to OFFER — the server never trusts the flag alone.
  const typedNumber = (form?.output_number || '').trim();
  const heldNumber = (match?.master_output_number || '').trim();
  const sync = masterOutputSync({ typed: typedNumber, master: heldNumber });

  const rack = RACK_CHOICES.find(row => row.key === form?.rack) || RACK_CHOICES[0];
  const total = (form?.components || []).reduce((sum, row) => sum + Math.max(0, Number(row.qty) || 0), 0);
  const updateQty = (key, qty) => setForm(current => ({
    ...current,
    components: current.components.map(row => (componentKey(row) === key ? { ...row, qty } : row)),
  }));
  const addPantone = () => {
    const identity = newPantone.trim();
    if (!identity) return;
    const row = { component_type: 'pantone', component_label: `Pantone - ${identity}`, pantone_code: identity, qty: 1 };
    if (form.components.some(existing => componentKey(existing) === componentKey(row))) {
      return toast.error(`${row.component_label} is already listed`);
    }
    setForm(current => ({ ...current, components: [...current.components, row] }));
    setNewPantone('');
  };

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.post('/plates/warehouse/assets', {
        product_id: match.product_id,
        plate_master_id: Number(form.plate_master_id),
        output_number: typedNumber,
        rack: form.rack,
        condition: form.condition,
        artwork_version: form.artwork_version,
        remarks: form.remarks,
        update_master: Boolean(form.update_master),
        components: form.components.filter(row => Number(row.qty) > 0),
      });
      toast.success(`${result.count} plate(s) added to ${result.rack_location}`
        + (result.master_synced ? ` · master output number set to ${result.master_synced.to}` : ''));
      await onSaved();
      onClose();
    } catch (error) { toast.error(error.message || 'The plates could not be added'); }
    finally { setBusy(false); }
  };

  return <Modal open onClose={onClose} title="Add plates to the warehouse" wide
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="success" disabled={!form || !form.plate_master_id || !total || busy} onClick={submit}>
        <PackagePlus size={14} /> {busy ? 'Adding…' : `Add ${total} plate${total === 1 ? '' : 's'}`}
      </Button>
    </>}>
    <div className="space-y-4">
      {/* Two doors, said plainly. The output number leads because it is how the
          plant names a job — but it is a choice, not a gate: a carton whose master
          has no number yet is entered by name and tells the master afterwards. */}
      <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white/70 p-0.5">
        {[{ key: 'output', label: 'By output number' }, { key: 'product', label: 'By product' }].map(option => {
          const on = mode === option.key;
          return <button key={option.key} type="button" onClick={() => swapMode(option.key)}
            className={`flex-1 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${on ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
            {option.label}
          </button>;
        })}
      </div>

      {mode === 'output' ? (
        <Field label="Output number" required
          hint="Product, customer, artwork and colours are read from Product Master and Planning.">
          <div className="flex gap-2">
            <Input value={number} autoFocus placeholder="e.g. 18604"
              onChange={event => retype(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find(); } }} />
            <Button type="button" variant="secondary" disabled={!number.trim() || looking} onClick={() => find()}>
              {looking ? 'Looking…' : 'Find'}
            </Button>
          </div>
        </Field>
      ) : (
        <Field label="Product" required
          hint="Search by carton name, internal code or the customer's item code.">
          <SearchableSelect value={productId} onChange={event => pickProduct(event.target.value)}
            placeholder={products.length ? 'Search the Carton Product Master…' : 'Loading products…'}
            options={products.map(row => ({
              value: String(row.id),
              label: `${row.name}${row.output_number ? ` · ${row.output_number}` : ''}`,
              search: searchText(row, `${row.code} ${row.name} ${row.party_item_code || ''} ${row.customer_name} ${row.output_number || ''}`),
            }))} />
        </Field>
      )}

      {/* A gang number names a SHEET of several cartons, so there is no one product
          to file the plates against. Said plainly, with the run number, rather than
          left as an empty result the operator would read as a typo. */}
      {lookup?.gang_runs?.length > 0 && <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{lookup.output_number} is the gang run {lookup.gang_runs.map(row => row.gang_number).join(', ')} — a shared sheet, not one carton.
          Plates for a gang are received against that run's own Plate PR.</span>
      </div>}

      {/* A miss is no longer a dead end — the other door is right there, and the
          product it finds can be given this very number on the way through. */}
      {lookup && !lookup.matches.length && !lookup.gang_runs.length && <div className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">No active product carries output number {lookup.output_number}, in Product Master or on a planned order line.</span>
        <Button size="sm" variant="secondary" onClick={() => swapMode('product')}>Find it by product</Button>
      </div>}

      {/* output_number is plain text on the master — nothing stops two cartons
          sharing one. Show them both rather than silently taking the first. */}
      {lookup?.matches?.length > 1 && <section className="ci-form-panel">
        <div className="ci-form-panel-title"><span>Which product?</span><span>{lookup.matches.length} carry this number</span></div>
        <div className="divide-y divide-slate-100">{lookup.matches.map(option => (
          <button key={option.product_id} type="button" onClick={() => choose(option)}
            className={`flex w-full items-center gap-3 py-2 text-left ${match?.product_id === option.product_id ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
            <span className="min-w-0 flex-1">
              <b className="text-sm text-slate-800">{option.product_name}</b>
              <span className="block font-mono text-[10px] text-slate-400">{option.product_code} · {option.customer_name}</span>
            </span>
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {option.source === 'planning' ? 'From planning' : 'Product Master'}
            </span>
          </button>
        ))}</div>
      </section>}

      {match && form && <>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title">
            <span>{match.product_name}</span>
            {/* Three states, not two. Entering by product with a blank master, the
                old "Number from Product Master" was a caption on a number that did
                not exist — it read as confirmation that the master had one. */}
            <span>{match.source === 'planning' ? 'Number from a planned order line'
              : match.source === 'master' ? 'Number from Product Master'
              : heldNumber ? 'Found by product' : 'Found by product · no output number on file'}</span>
          </div>
          <div className="grid gap-3 py-1 text-xs text-slate-600 sm:grid-cols-3">
            <span><span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Customer</span>{match.customer_name}</span>
            <span><span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Product code</span><span className="font-mono">{match.product_code}</span></span>
            <span><span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">Party code</span><span className="font-mono">{match.party_item_code || '—'}</span></span>
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Rack" required hint={rack.key === 'used' ? 'Recorded with one run so far — a used plate has printed at least once' : 'Recorded with no runs'}>
            <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-white/70 p-0.5">
              {RACK_CHOICES.map(option => {
                const on = form.rack === option.key;
                return <button key={option.key} type="button"
                  onClick={() => setForm(current => ({ ...current, rack: option.key, condition: 'Good' }))}
                  className={`flex-1 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${on ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
                  {option.label}<span className={`ml-1 font-semibold ${on ? 'text-white/70' : 'text-slate-400'}`}>{option.hint}</span>
                </button>;
              })}
            </div>
          </Field>
          <Field label="Plate size" required
            hint={`Suggested from ${match.plate_size_from}`}>
            <Select value={form.plate_master_id} onChange={event => setForm(current => ({ ...current, plate_master_id: event.target.value }))}>
              <option value="">Choose a size</option>
              {masters.map(row => <option key={row.id} value={row.id}>{row.plate_size}</option>)}
            </Select>
          </Field>
          {/* Only a used plate can be anything but Good — a plate that has never
              printed and is already Fair is a plate with a story the rack cannot tell. */}
          {rack.key === 'used' && <Field label="Condition" required>
            <Select value={form.condition} onChange={event => setForm(current => ({ ...current, condition: event.target.value }))}>
              {rack.conditions.map(option => <option key={option} value={option}>{option}</option>)}
            </Select>
          </Field>}
          <Field label="Artwork / revision" required
            hint="How a Plate PR will find these plates. R1 never matches an R2 job.">
            <Input value={form.artwork_version}
              onChange={event => setForm(current => ({ ...current, artwork_version: event.target.value }))} />
          </Field>
          {/* Editable whichever door was used. Entered by product, this is where
              the number the plant knows finally gets written down. */}
          <Field label="Output number"
            hint={heldNumber ? `Product Master says ${heldNumber}` : 'Nothing on the master yet'}>
            {/* The tick follows the CURRENT proposal: type a number into a blank
                master and syncing is suggested again, because it is a new offer. */}
            <Input value={form.output_number} placeholder="Not known"
              onChange={event => setForm(current => ({
                ...current,
                output_number: event.target.value,
                update_master: masterOutputSync({ typed: event.target.value, master: heldNumber }).suggested,
              }))} />
          </Field>
        </div>

        {/* ── Sync Master? — the plant's existing fork for output_number ──────
            Filling a blank leads and is ticked: the master is incomplete and the
            plant is telling it the answer. Replacing a number the master already
            holds is a disagreement about which is right, so it arrives UNTICKED
            and prints both — a typo here would otherwise rename the number every
            future job for this carton prints under. */}
        {sync.offer && <section className={`rounded-lg border px-3 py-2.5 ${sync.state === 'conflict' ? 'border-amber-200 bg-amber-50' : 'border-brand-200 bg-brand-50'}`}>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
              checked={Boolean(form.update_master)}
              onChange={event => setForm(current => ({ ...current, update_master: event.target.checked }))} />
            <span className="min-w-0 text-xs">
              <b className={sync.state === 'conflict' ? 'text-amber-900' : 'text-brand-900'}>Sync Master?</b>
              <span className={`ml-1.5 font-semibold ${sync.state === 'conflict' ? 'text-amber-800' : 'text-brand-800'}`}>
                {sync.state === 'conflict'
                  ? <>Change {match.product_code}'s output number from <b className="line-through">{sync.from}</b> to <b>{sync.to}</b> on the Carton Product Master?</>
                  : <>{match.product_code} has no output number on its master. Save <b>{sync.to}</b> to it.</>}
              </span>
              <span className="mt-0.5 block text-[11px] font-medium text-slate-500">
                Left unticked, the number still goes on these plates — the master keeps what it has.
              </span>
            </span>
          </label>
        </section>}

        <section className="ci-form-panel">
          <div className="ci-form-panel-title">
            <span>Which plates are you entering?</span>
            <span>{total} plate{total === 1 ? '' : 's'} · 0 leaves a colour out</span>
          </div>
          <div className="divide-y divide-slate-100">{form.components.map(row => (
            <div key={componentKey(row)} className="grid items-center gap-3 py-2 sm:grid-cols-[1fr_132px]">
              <div>
                <b className="text-sm">{row.component_label}</b>
                {row.component_type === 'pantone' && <span className="block text-[11px] text-slate-400">Pantone identity kept on every physical plate</span>}
              </div>
              <QuantityControl row={row} onChange={qty => updateQty(componentKey(row), qty)} />
            </div>
          ))}</div>
          <div className="mt-3 flex max-w-md gap-2 border-t border-slate-100 pt-3">
            <Input value={newPantone} placeholder="Pantone number or name"
              onChange={event => setNewPantone(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addPantone(); } }} />
            <Button type="button" variant="secondary" onClick={addPantone}><Plus size={14} /> Add Pantone</Button>
          </div>
        </section>

        <Field label="Remarks" hint="Where these plates came from, if it is worth recording">
          <Textarea value={form.remarks} onChange={event => setForm(current => ({ ...current, remarks: event.target.value }))} />
        </Field>
      </>}
    </div>
  </Modal>;
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
    // Undo lives on the movement it reverses, because this is the only screen
    // that has a movement id at all — /plates/warehouse returns plates, not
    // movements, and groups them into sets besides.
    //
    // Offered only for the three set-aside actions, and only when no job card or
    // requirement is attached. That mirrors invertMovement exactly: the server
    // refuses everything else, and a button whose only outcome is a 409 is worse
    // than no button.
    { key: 'undo', label: '', sortable: false, render: row => (
      UNDOABLE_SET_ASIDE_ACTIONS.includes(row.action) && !row.job_card_id && !row.tooling_request_id
        ? <Button size="sm" variant="ghost" disabled={busy}
            onClick={() => undoMovement(row.id).catch(error => toast.error(error.message))}>Undo</Button>
        : null
    ) },
  ];
  const undoMovement = async movementId => {
    setBusy(true);
    try {
      const out = await api.post('/plates/assets/undo-movement', { movement_id: movementId });
      toast.success(`${out.plate} put back — it is ${String(out.status).replace(/_/g, ' ')} again`);
      await load();
      onChanged?.();
    } finally { setBusy(false); }
  };
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
  const [addingPlates, setAddingPlates] = useState(false);
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
  // The other direction: a set that is off the rack and is going back on it.
  const [restoring, setRestoring] = useState(null);
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
  const [editPo, setEditPo] = useState(null);
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
  // Same narrowing rule as bulk approve: the rows the rack can help are acted on
  // and the rest are simply left alone, rather than greying the button out and
  // making somebody work out which selection spoiled it.
  const rackSelection = selectedRequirements.filter(row => rackTotal(row) > 0);
  const rackSelectionTotal = rackSelection.reduce((sum, row) => sum + rackTotal(row), 0);
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
  // Everything that is off the rack but not in a job's hands. Fresh and Used are
  // both keyed on status === 'available', so without this list a set-aside plate
  // renders nowhere at all and can never be brought back.
  const ASIDE_STATUSES = ['damaged', 'lost', 'awaiting_verification', 'scrapped'];
  const asideRows = warehouse.filter(row => ASIDE_STATUSES.includes(row.status));
  const rackRows = warehouseView === 'aside'
    ? asideRows
    : warehouse.filter(row => row.status === 'available'
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
  // One spelling of "take what the rack already holds". The row button, the form
  // button and the bulk dock differ only in WHICH requirements they name and, in
  // the form's case, which colour — never in what the action means.
  //
  // Sequential for the same reason approveSelected is: a pooled serverless
  // backend runs one client, so a dozen concurrent claims deadlock. Each PR is
  // reported on its own so one that lost its plate to somebody else in the
  // meantime does not discard the rest.
  const useFromRack = async (rows, componentIds = null) => {
    setBulkApproving(rows.length > 1);
    if (rows.length === 1) setBusyRow(rows[0].id);
    let reused = 0; const failed = [];
    for (const row of rows) {
      try {
        const out = await api.post(`/plates/requirements/${row.id}/use-from-rack`,
          componentIds ? { component_ids: componentIds } : {});
        reused += out.reused;
      } catch (error) { failed.push(`${row.request_number}: ${error.message}`); }
    }
    setBulkApproving(false); setBusyRow(null);
    if (reused) toast.success(`${reused} plate${reused === 1 ? '' : 's'} taken from the rack — no need to buy ${reused === 1 ? 'it' : 'them'}`);
    if (failed.length) toast.error(failed[0]);
    if (detail) await refreshDetail(); else await load();
  };
  // WHICH plate, asked before anything is spent. useFromRack above takes whatever
  // the server's ordering proposes and is still the right door for the bulk dock;
  // every single-PR door now goes through here instead, because the ordering is a
  // guess about a physical object the planner can see and the query cannot.
  //
  // `picker` holds the fetched lines in STATE and hands the same array identity to
  // the modal for as long as it is open. RackPickerModal re-seeds its selection in
  // an effect keyed on `lines`, so an array rebuilt inline on each render would
  // throw the planner's picks away as fast as they were made.
  const [picker, setPicker] = useState(null);
  const openPicker = async (row, componentIds = null) => {
    setBusyRow(row.id);
    try {
      const out = await api.get(`/plates/requirements/${row.id}/rack-candidates`);
      const lines = componentIds
        ? out.lines.filter(line => componentIds.includes(line.component_id))
        : out.lines;
      if (!lines.length) return toast.error('No plate on this requirement is waiting for a rack plate');
      setPicker({ row, lines });
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); }
  };
  const confirmPicks = async picks => {
    const row = picker.row;
    setPicker(null); setBusyRow(row.id);
    try {
      const out = await api.post(`/plates/requirements/${row.id}/use-from-rack`, { picks });
      const took = out.reused + out.swapped;
      if (took) toast.success(`${took} plate${took === 1 ? '' : 's'} taken from the rack — no need to buy ${took === 1 ? 'it' : 'them'}`);
      // Never silent: a plate the planner chose and did not get must be named.
      for (const miss of out.skipped || []) {
        toast.error(`${miss.component_label}: that plate was not taken (${String(miss.reason).replace(/_/g, ' ')})`);
      }
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); if (detail) await refreshDetail(); else await load(); }
  };
  // Undo, which reaches exactly as far as the rack: a plate still reserved goes
  // back on the shelf, a plate already issued to printing has physically gone and
  // its way back is a RETURN. The server refuses per line and names the plate; so
  // does this.
  const releaseRack = async (row, componentIds = null) => {
    setBusyRow(row.id);
    try {
      const out = await api.post(`/plates/requirements/${row.id}/release-rack`,
        componentIds ? { component_ids: componentIds } : {});
      toast.success(`${out.released} plate${out.released === 1 ? '' : 's'} returned to the rack`);
      for (const miss of out.skipped || []) {
        toast.error(`${miss.component_label}: ${miss.asset_number || 'that plate'} is ${String(miss.status).replace(/_/g, ' ')}`);
      }
    } catch (error) { toast.error(error.message); }
    finally { setBusyRow(null); if (detail) await refreshDetail(); else await load(); }
  };
  // Take a plate off the rack from inside the picker. One plate, one reason: the
  // picker lists individual plate assets, not sets.
  const setAsidePlate = async (assetId, reason) => {
    try {
      const out = await api.post('/plates/assets/set-aside', { asset_ids: [assetId], reason });
      // No Undo in this toast: ui.jsx's toast is push(type, msg) — a message and
      // nothing else — and it clears after 3800ms. Undo lives on the Set aside
      // tab, where the plate now is and where somebody would go looking for it.
      toast.success(`${out.plates.join(', ')} taken off the rack — undo it on the Set aside tab`);
    } catch (error) { toast.error(error.message); }
    finally { if (detail) await refreshDetail(); else await load(); }
  };
  // Retire straight from the picker. The endpoint is the one the warehouse has
  // always used — this is a second door onto it, not a second implementation.
  //
  // The LABEL travels, not a key: /plates/assets/retire reads a free-text reason
  // (String(req.body.reason).trim()) and writes it to the plate's remarks, where
  // "Worn out — dot loss" is the point. Set aside is the opposite — keyed, because
  // its reason resolves to a status.
  const retireFromPicker = async (assetId, reason) => {
    try {
      const out = await api.post('/plates/assets/retire', { asset_ids: [assetId], reason });
      toast.success(`${out.plates.join(', ')} retired — ${reason}`);
    } catch (error) { toast.error(error.message); }
    finally { if (detail) await refreshDetail(); else await load(); }
  };
  // Put plates back. Takes the whole SET, not one plate: a warehouse row is a
  // grouped set — summarizePlateSet gives it `asset_ids` and `row.id` is only the
  // first plate in it — and Retire scraps every plate in a set at once. Sending
  // `row.id` alone would answer "Back on the rack" on a retired set of four by
  // restoring one and leaving three scrapped, invisible, and unmentioned.
  const makeAvailable = async (assetIds, condition, reason) => {
    try {
      const out = await api.post('/plates/assets/make-available',
        { asset_ids: assetIds, condition, reason });
      toast.success(`${out.plates.join(', ')} back on the rack as ${condition}`);
    } catch (error) { toast.error(error.message); }
    finally { await load(); }
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
    } else if (action.kind === 'delete_po') {
      const out = await api.del(`/plates/purchase-orders/${action.row.id}`);
      toast.success(`${action.row.po_number} deleted — ${out.plates_returned ?? 0} plate(s) back to Approved`);
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
    // The warehouse, answered on the requirement itself. Before this column the
    // rack was consulted once — when the PR was raised — and never again, so a
    // plate that came back from the press an hour later was invisible and the
    // plant bought one it already owned. The figure is what the button takes,
    // never what the rack happens to hold.
    { key: 'rack_reuse', label: 'On Rack', align: 'right', sortValue: row => rackTotal(row),
      render: row => {
        const needed = rackNeeded(row);
        if (!needed) return <span className="text-xs text-slate-300">—</span>;
        const total = rackTotal(row);
        return <div className="text-right">
          <b className={`text-sm tabular-nums ${total ? 'text-emerald-700' : 'text-slate-400'}`}>{total}</b>
          <span className="block text-[10px] font-semibold text-slate-400">of {needed} to find</span>
        </div>;
      } },
    { key: 'delivery_date', label: 'Needed by', render: row => fmt.date(row.needed_by || row.delivery_date) },
    { key: 'approval_status', label: 'PR Status', render: row => <StatusChip value={row.approval_status} /> },
    { key: 'po_number', label: 'PO', render: row => row.po_number || '—' },
    { key: 'actions', label: '', sortable: false, render: row => <div className="flex justify-end gap-1" onClick={event => event.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => openRequirement(row)}><Eye size={12} /> Open</Button>
      {/* Offered BEFORE Approve, because approving is what puts a plate onto a
          purchase order — and a plate the plant already owns should never get
          there. One click; the count on the button is the count in the column. */}
      {canVerify() && rackTotal(row) > 0 && <Button size="sm" variant="success"
        disabled={busyRow === row.id}
        title={`Choose ${rackTotal(row)} matching plate(s) from the rack for ${row.request_number}`}
        onClick={() => openPicker(row)}><Warehouse size={12} /> Use {rackTotal(row)} from Rack</Button>}
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
      {/* Raise the PO for THIS PR without ticking it first. Same modal the bulk
          path opens — one group instead of many — so the two entry points cannot
          become two policies. Shown only while the row actually has approved
          plates to buy and no PO yet, which is exactly canCreatePoRow. */}
      {canManage() && canCreatePoRow(row) && <Button size="sm"
        onClick={() => openPlatePo([row])}><ShoppingBag size={12} /> Create PO</Button>}
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
      {/* Open the printable PO — the same document the vendor gets. POPrint
          already serves the plate family; the row simply never linked to it. */}
      <Button size="sm" variant="secondary" onClick={() => window.open(`/tooling/plates/po/${row.id}`, '_blank', 'noopener')}>
        <Eye size={12} /> View
      </Button>
      <ActionMenu label={`${row.po_number} actions`} items={[
        ...(canEditPo(row) ? [{key:'edit',label:'Edit PO',icon:Pencil,onClick:()=>setEditPo(row)}] : []),
        ...(!row.sent_at && !['reversed','closed','received'].includes(row.status) ? [{key:'send',label:'Mark sent to vendor',icon:Send,onClick:async()=>{await api.post(`/plates/purchase-orders/${row.id}/send`);toast.success(`${row.po_number} marked sent`);load();}}] : []),
        ...(row.status!=='reversed' ? [{key:'reverse',label:'Reverse PO',icon:RotateCcw,danger:true,onClick:()=>setReasonAction({
          kind:'reverse_po',row,title:`Reverse ${row.po_number}?`,confirmLabel:'Reverse PO',icon:RotateCcw,danger:true,requireReason:true,
          description:row.sent_at?'This PO has already been issued to the vendor. Confirm vendor cancellation before reversing it. Any active GRN must be reversed first.':'This returns its Plate components to Approved. Any active GRN must be reversed first.',
        })}] : []),
        // Delete is offered ONLY for a PO nobody outside this screen has seen.
        // The moment it has been sent or received against, its number has to
        // survive and Reverse is the only honest undo — so the entry is not
        // greyed out, it is absent, and Reverse sits there instead.
        ...(canDeletePo(row) ? [{key:'delete',label:'Delete PO',icon:Trash2,danger:true,onClick:()=>setReasonAction({
          kind:'delete_po',row,title:`Delete ${row.po_number}?`,confirmLabel:'Delete PO',icon:Trash2,danger:true,
          description:'This PO was never sent and nothing has been received against it, so it can be removed outright. Its plates go back to Approved and can be bought again. The PO number will not be reused.',
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
    //
    // On the Set aside tab the plate has already left the rack, so Retire is not the
    // question being asked there — putting it back is. Fresh and Used are untouched.
    { key: 'actions', label: '', sortable: false, render: row => (
      <div className="flex items-center justify-end gap-1">
        {warehouseView === 'aside'
          ? canVerify() && <Button size="sm" variant="secondary"
            title={`Put all ${row.qty || row.components?.length || 1} plates in this set back on the rack`}
            onClick={event => { event.stopPropagation(); setRestoring({ rows: [row], condition: '', reason: '' }); }}>
            <RotateCcw size={12} /> Back on the rack
          </Button>
          : canManage() && <Button size="sm" variant="ghost" title={`Retire all ${row.qty || row.components?.length || 1} plates in this set`}
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
        <KpiCard compact label={warehouseView === 'fresh' ? 'Fresh rack' : warehouseView === 'used' ? 'Used rack' : 'Set aside'}
          value={rackSummary.total}
          icon={Warehouse}
          tone={warehouseView === 'aside' ? (rackSummary.total ? 'warn' : 'neutral') : (rackSummary.total ? 'good' : 'neutral')} />
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
      {/* The bulk actions DOCK at the foot of the screen rather than sitting in
          the flow above the table. A PR list runs to dozens of rows, so a bar
          pinned at the top means ticking a row near the bottom and then
          scrolling all the way back up to act on it. Same dock, same measured
          tail room, as the Planning queue — see useDockTailRoom in ui.jsx. */}
      <SelectionDock open={selectedIds.length > 0} count={selectedIds.length}
        summary={selectedRequirements.slice(0, 3).map(row => row.request_number).join(' · ')
          + (selectedRequirements.length > 3 ? ` +${selectedRequirements.length - 3} more` : '')}
        title={selectedRequirements.map(row => row.request_number).join(', ')}
        onClear={() => setSelectedIds([])} clearLabel="Deselect all">
        {!canApproveBulk && !canCreateBulkPo && !canDeleteBulk && !rackSelectionTotal && <span className="text-xs font-semibold text-amber-700">Select PRs with plates on the rack to reuse, unapproved PRs to approve, approved PRs for a PO, or editable PRs to delete</span>}
        {!allViewSelected && <Button size="sm" variant="ghost" onClick={() => setSelectedIds(current => [...new Set([...current, ...reqRows.map(row => row.id)])])}>Select all</Button>}
        {/* The rack first, for the same reason it sits left of Approve on the row:
            every plate taken here is a plate that never reaches a purchase order.
            The count is the sum of the selected rows' own On Rack figures. */}
        {canVerify() && rackSelectionTotal > 0 && <Button size="sm" variant="success" disabled={bulkApproving}
          onClick={() => useFromRack(rackSelection)}>
          <Warehouse size={13} /> Use {rackSelectionTotal} from Rack
        </Button>}
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
      </SelectionDock>
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
    {/* Back on the rack — the way out of Set aside, and the only way back for a
        plate that was retired.

        The condition is asked, never assumed: the server refuses without it
        because a plate the floor prints from must not carry a grade nobody chose.
        The reason is required for the same kind of reason — a plate reappearing on
        the rack with no account of why is a plate somebody will distrust. Both are
        checked here as well as there, so a considered click is answered by the
        screen rather than by a 400. */}
    {restoring && <Modal open onClose={()=>setRestoring(null)}
      title={`Put ${restoring.rows.reduce((sum,row)=>sum+(row.qty||row.components?.length||1),0)} plate(s) back on the rack`}
      footer={<>
        <Button variant="secondary" onClick={()=>setRestoring(null)}>Cancel</Button>
        <Button variant="success"
          disabled={!restoring.condition || !restoring.reason.trim()}
          onClick={async()=>{
            const rows = restoring.rows, { condition, reason } = restoring;
            setRestoring(null);
            await makeAvailable(rows.flatMap(row=>row.asset_ids?.length?row.asset_ids:[row.id]), condition, reason.trim());
          }}>
          <RotateCcw size={14}/> Back on the rack
        </Button>
      </>}>
      <div className="space-y-4">
        <div className="ci-summary-panel text-xs text-slate-600">
          These plates go back to being offered for reuse. A plate that was <b>retired</b> comes
          back to the <b>{USED_PLATES_RACK}</b> — recovered stock is not fresh stock.
        </div>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Coming back</span><span>{restoring.rows.length} set(s)</span></div>
          <div>{restoring.rows.map(row=>(
            <div key={row.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 last:border-0">
              <span className="min-w-0 flex-1">
                <b className="text-sm text-slate-800">{row.contains || row.component_label}</b>
                <span className="block font-mono text-[10px] text-slate-400">
                  {row.qty || row.components?.length || 1} plate set · {row.plate_size} · {row.product_name}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <StatusChip value={row.status} />
              </span>
            </div>
          ))}</div>
        </section>
        <div>
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Condition <span className="normal-case tracking-normal text-red-500">required</span></div>
          <div className="flex flex-wrap gap-1.5">
            {['Good','Fair'].map(option=>{
              const on = restoring.condition === option;
              return <button key={option} type="button"
                onClick={()=>setRestoring(current=>({...current, condition: on ? '' : option}))}
                className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${on ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {option}
              </button>;
            })}
          </div>
        </div>
        <Field label="Why is it going back" required>
          <Input value={restoring.reason} placeholder="Found it in the die store / checked and it prints fine"
            onChange={event=>setRestoring(current=>({...current, reason:event.target.value}))} />
        </Field>
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
          {key:'aside',label:'Set aside',count:asideRows.length},
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
        {/* Stock arriving without paperwork. Sits with the rack switch because it
            is the one thing on this screen that ADDS to the rack rather than
            narrowing what you can see of it — and it stays put when rows are
            ticked, so it never trades places with the selection actions. */}
        {canManage() && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setAddingPlates(true)}>
          <PackagePlus size={13} /> Add Plates
        </Button>}
        {rackPicked.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5">
          <b className="text-sm text-brand-900">{rackPicked.length} plate set(s) ticked</b>
          <Button size="sm" variant="ghost" onClick={()=>setRackPicked([])}>Clear</Button>
          {/* Neither of these is a question you can ask of a plate that is already off
              the rack: Issue wants an available plate and Retire wants one to scrap.
              Offering them on the Set aside tab would be two buttons whose only reply
              is an error. Bringing a set back is offered per row instead, because the
              condition is stated about ONE set of plates, not a tickbox full of them. */}
          {canManage() && warehouseView !== 'aside' && <Button size="sm" onClick={()=>setIssuing({ rows: warehouseRows.filter(row=>rackPicked.includes(row.id)), job_card_id:'', note:'' })}>
            <Send size={13}/> Issue to a Job
          </Button>}
          {canManage() && warehouseView !== 'aside' && <Button size="sm" variant="danger" onClick={()=>setRetiring({ rows: warehouseRows.filter(row=>rackPicked.includes(row.id)), reason:'', note:'' })}>
            <Trash2 size={13}/> Retire
          </Button>}
        </div>}
      </div>
      <DataTable searchable selectable rows={warehouseRows} columns={warehouseColumns}
        selectedIds={rackPicked}
        onToggleRow={(row,checked)=>setRackPicked(current=>checked?[...current,row.id]:current.filter(id=>id!==row.id))}
        onToggleAll={(rows,checked)=>{ const ids=rows.map(row=>row.id); setRackPicked(current=>checked?[...new Set([...current,...ids])]:current.filter(id=>!ids.includes(id))); }}
        onRowClick={setAssetHistory}
        empty={warehouseView === 'aside' ? 'Nothing is set aside — every plate is on a rack or on a press' : 'No available plate sets in this rack'}
        exportName={warehouseView === 'aside' ? 'Plates Set Aside' : 'Plates Warehouse'} />
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
        <section className="ci-form-panel"><div className="ci-form-panel-title"><span>Plate colour and quantity</span><div className="flex flex-wrap items-center justify-end gap-2"><span>0 removes a colour · Product Master: {detail.product_master_colour_count ?? '—'} colours</span>{canVerify() && rackTotal(detail) > 0 && <Button size="sm" variant="success" disabled={busyRow===detail.id}
            onClick={()=>openPicker(detail)}><Warehouse size={12}/> Use {rackTotal(detail)} from Rack</Button>}{detailEditable && <Button size="sm" variant="secondary" onClick={() => fetchProductMasterColours().catch(error => toast.error(error.message))}><RotateCcw size={12}/> Fetch Master Colours</Button>}</div></div>
          <div className="divide-y divide-slate-100">{editForm.components.map(row=>{
            const lifecycle=detailGroups.find(group=>group.key===componentKey(row));
            // The same warehouse answer the list column prints, per colour. Both
            // come off row.rack_reuse, so the four lines here always add up to the
            // one number on the row — see rackReusePlan in server/src/plates.js.
            const rack=rackLineFor(detail,componentKey(row));
            // A line that already HOLDS a rack plate is not a claimable line, so
            // rackReusePlan never emits a rack_reuse row for it — verified_existing
            // is in PLATE_HELD_COMPONENT_STATUSES, not RACK_CLAIMABLE_COMPONENT_STATUSES.
            // Change and Undo therefore cannot live inside the `rack` branch below:
            // nested there they would be controls that never once render.
            const rackHeld=canVerify() && lifecycle?.status==='verified_existing';
            return <div key={componentKey(row)} className="grid items-center gap-3 py-2.5 sm:grid-cols-[minmax(170px,1fr)_140px_150px_132px]">
              <div><b className="text-sm">{row.component_label}</b>{row.component_type==='pantone'&&<span className="block text-[11px] text-slate-400">Pantone identity retained on every physical plate</span>}</div>
              <div>{lifecycle ? <StatusChip value={lifecycle.status}/> : <span className="text-xs text-slate-400">Not required</span>}</div>
              {/* One cell, three states: a line the rack can still fill offers Use, a
                  line already holding a rack plate offers Change and Undo, and a line
                  that is neither shows the dash. */}
              <div className="flex items-center gap-1.5">
                {rack && <>
                  <span title={`${rack.available} matching plate${rack.available===1?'':'s'} free on the rack`}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold ${rack.usable ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                    <Warehouse size={11}/>{rack.usable} of {rack.needed} on rack
                  </span>
                  {canVerify() && rack.usable > 0 && <Button size="sm" variant="ghost" disabled={busyRow===detail.id}
                    onClick={()=>openPicker(detail,rack.component_ids)}>Use</Button>}
                </>}
                {rackHeld && <>
                  <Button size="sm" variant="ghost" disabled={busyRow===detail.id}
                    onClick={()=>openPicker(detail,lifecycle.component_ids)}>Change</Button>
                  <Button size="sm" variant="ghost" disabled={busyRow===detail.id}
                    onClick={()=>releaseRack(detail,lifecycle.component_ids)}>Undo</Button>
                </>}
                {!rack && !rackHeld && <span className="text-xs text-slate-300">—</span>}
              </div>
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
    {/* `lines` comes straight off state and keeps one identity for as long as the
        picker is open — the modal re-seeds its selection on that identity. */}
    <RackPickerModal open={Boolean(picker)} requestNumber={picker?.row?.request_number}
      lines={picker?.lines || []} busy={busyRow === picker?.row?.id}
      onCancel={() => setPicker(null)} onConfirm={confirmPicks} onSetAside={setAsidePlate} onRetire={retireFromPicker} />
    {verifying && <VerificationModal component={verifying} onClose={()=>setVerifying(null)} onSaved={refreshDetail}/>}
    {approving && detail && editForm && <ApproveModal request={detail} draft={editForm} masters={masters} onSaveDraft={saveRequirement} onClose={()=>setApproving(false)} onSaved={refreshDetail}/>}
    {poModal && <PlatePoModal groups={poModal.groups} vendors={vendors} plateRates={plateRates} onClose={()=>setPoModal(null)} onSaved={async()=>{setSelectedIds([]);await refreshDetail();}}/>}
    {grnModal && <PlateGrnModal po={grnModal.po} line={grnModal.line} onClose={()=>setGrnModal(null)} onSaved={load}/>}
    {editPo && <PlatePoEditModal po={editPo} vendors={vendors} onClose={()=>setEditPo(null)} onSaved={load}/>}
    {returnModal && <ReturnModal asset={returnModal} onClose={()=>setReturnModal(null)} onSaved={load}/>}
    {addingPlates && <AddPlatesModal masters={masters} defaultRack={warehouseView}
      onClose={()=>setAddingPlates(false)} onSaved={load}/>}
    {assetHistory && <AssetHistoryModal asset={assetHistory} onClose={()=>setAssetHistory(null)} onChanged={load}/>}
    {reasonAction && <ReasonActionModal action={reasonAction} onClose={()=>setReasonAction(null)} onConfirm={performReasonAction}/>}
  </div>;
}
