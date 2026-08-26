import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Ban, Boxes, CheckCircle2, ClipboardCheck, Download, Eye,
  FileCheck2, History, PackageCheck, PackagePlus, Plus, Printer, RotateCcw,
  Send, ShoppingBag, Trash2, Truck, Warehouse,
} from 'lucide-react';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import {
  initialReceipt, lineTicked, lineReceipt, pendingOf, receiptTotals, toggleToolingLine,
  fillAll, clearAll, toReceiptPayload,
} from '../lib/toolingGrnSelection.js';
import { stockPosition } from '../lib/toolingStock.js';
import {
  ActionMenu, Button, DataTable, Field, FulfillmentBar, Input, KpiCard, Modal,
  PageHeader, SearchableSelect, Select, SubTabs, Tabs, Textarea, useToast,
} from './ui.jsx';
import ProductIdentity from './ProductIdentity.jsx';
import { PoTotalsPanel, TaxKindToggle } from './ProcurementForms.jsx';
import PlatesLifecycle from './PlatesLifecycle.jsx';
import ClosePoLinesModal from './ClosePoLines.jsx';

const FAMILY = {
  plate: { singular: 'Plate', plural: 'Plates', unit: 'plates', icon: Printer },
  die: { singular: 'Die', plural: 'Dies', unit: 'dies', icon: Boxes },
  block: { singular: 'Block', plural: 'Blocks', unit: 'blocks', icon: PackageCheck },
};

const APPROVAL = {
  pending: ['Pending', 'bg-slate-100 text-slate-600'],
  approved: ['Approved', 'bg-emerald-50 text-emerald-700'],
  converted: ['Converted', 'bg-blue-50 text-blue-700'],
  rejected: ['Rejected', 'bg-red-50 text-red-700'],
  closed: ['Closed', 'bg-slate-100 text-slate-500'],
};

const PO_STATUS = {
  open: ['Open', 'bg-amber-50 text-amber-700'],
  partially_received: ['Part received', 'bg-blue-50 text-blue-700'],
  received: ['Received', 'bg-emerald-50 text-emerald-700'],
  closed: ['Closed', 'bg-slate-100 text-slate-500'],
};

const GRN_STATUS = {
  quarantine: ['Awaiting QC', 'bg-amber-50 text-amber-700'],
  accepted: ['Accepted', 'bg-emerald-50 text-emerald-700'],
  rejected: ['Rejected', 'bg-red-50 text-red-700'],
};

const AGE_TONE = {
  '0-7': 'bg-emerald-50 text-emerald-700',
  '8-15': 'bg-amber-50 text-amber-700',
  '16-30': 'bg-orange-100 text-orange-700',
  '30+': 'bg-red-100 text-red-700',
};

function Chip({ value, map }) {
  const [label, tone] = map[value] || [fmt.title(value), 'bg-slate-100 text-slate-600'];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-bold ${tone}`}>{label}</span>;
}

function BulkDeleteModal({ family, rows, onClose, onDeleted }) {
  const toast = useToast();
  const meta = FAMILY[family];
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      const result = await api.del(`/tooling/procurement/${family}/requirements/bulk`, {
        request_ids: rows.map(row => row.id), reason: reason.trim(),
      });
      toast.success(`${result.deleted} ${meta.singular} PR${result.deleted === 1 ? '' : 's'} deleted`);
      await onDeleted(); onClose();
    } catch (error) { toast.error(error.message || `Could not delete ${meta.singular.toLowerCase()} PRs`); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} title={`Delete ${rows.length} ${meta.singular} PR${rows.length === 1 ? '' : 's'}?`}
    footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={busy || !reason.trim()} onClick={remove}><Trash2 size={14} /> Delete selected PRs</Button></>}>
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>This permanently removes every selected pending {meta.singular.toLowerCase()} PR. Any approval, PO, GRN or warehouse allocation blocks the entire action.</span>
      </div>
      <Field label="Reason" required><Textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="Record why these PRs are being deleted" /></Field>
    </div>
  </Modal>;
}

const num = value => Number(value) || 0;
const canBuy = () => ['admin', 'planner'].includes(auth.user?.role);
const canQc = () => ['admin', 'qc'].includes(auth.user?.role);

// A PO line's receipt state, in the same tones the rest of the module uses:
// nothing yet, part landed, all in — and closed short, where the balance was
// waived rather than delivered.
const RECEIPT_TONE = {
  open: 'bg-slate-100 text-slate-600',
  partial: 'bg-amber-50 text-amber-700',
  received: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-slate-200 text-slate-500',
};

const STOCK_TONE = {
  free: 'bg-emerald-50 text-emerald-700',
  spoken_for: 'bg-amber-50 text-amber-700',
  none: 'bg-slate-100 text-slate-500',
};
const QUALIFIER_TONE = { amber: 'text-amber-600', sky: 'text-sky-600' };

// One chip and its exceptions. See lib/toolingStock.js for why the chip counts
// FREE rather than what is on the shelf.
function StockPosition({ row, compact = false }) {
  const stock = stockPosition(row);
  return (
    <div className={compact ? 'mt-1.5' : ''}>
      <span title={stock.title}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${STOCK_TONE[stock.state]}`}>
        <Warehouse size={11} /> {stock.headline}
      </span>
      {stock.qualifiers.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] font-semibold tabular-nums">
          {stock.qualifiers.map(q => <span key={q.key} className={QUALIFIER_TONE[q.tone]}>{q.label}</span>)}
        </div>
      )}
    </div>
  );
}

function TermsFields({ form, set }) {
  return (
    <section className="ci-form-panel">
      <div className="ci-form-panel-title"><span>Terms &amp; vendor notes</span><span>printed on the PO</span></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Payment Terms"><Input value={form.payment_terms} onChange={e => set({ payment_terms: e.target.value })} /></Field>
        <Field label="Delivery Terms"><Input value={form.delivery_terms} onChange={e => set({ delivery_terms: e.target.value })} /></Field>
        <Field label="Vendor Reference"><Input value={form.reference} onChange={e => set({ reference: e.target.value })} /></Field>
        <Field label="Vendor Notes"><Input value={form.vendor_notes} onChange={e => set({ vendor_notes: e.target.value })} /></Field>
      </div>
    </section>
  );
}

function PoModal({ family, form, setForm, vendors, inventory, onClose, onCreated }) {
  const toast = useToast();
  const meta = FAMILY[family];
  const [busy, setBusy] = useState(false);
  const set = patch => setForm(current => ({ ...current, ...patch }));
  const updateLine = (index, patch) => setForm(current => ({
    ...current,
    lines: current.lines.map((line, i) => i === index ? { ...line, ...patch } : line),
  }));
  const pickItem = (index, itemId) => {
    const item = inventory.find(row => String(row.id) === String(itemId));
    updateLine(index, item ? {
      inventory_item_id: String(item.id), material_id: String(item.id), item_name: item.name,
      unit: item.unit || 'nos', hsn_code: item.hsn_code || '', gst_rate: item.gst_rate ?? '',
      rate: item.std_rate ?? '',
    } : { inventory_item_id: '', material_id: '', item_name: '', unit: 'nos' });
  };
  const addLine = () => setForm(current => ({ ...current, lines: [...current.lines, {
    inventory_item_id: '', material_id: '', item_name: '', qty: '', rate: '', hsn_code: '', unit: 'nos', discount_pct: '', gst_rate: '',
  }] }));
  const save = async () => {
    const lines = form.lines.filter(line => line.inventory_item_id && num(line.qty) > 0);
    if (!form.vendor_id) return toast.error('Choose a vendor');
    if (!lines.length) return toast.error(`Add at least one ${meta.singular.toLowerCase()} line`);
    setBusy(true);
    try {
      const po = await api.post(`/tooling/procurement/${family}/purchase-orders`, {
        request_ids: form.request_ids,
        vendor_id: +form.vendor_id,
        expected_date: form.expected_date || undefined,
        tax_kind: form.tax_kind,
        freight: form.freight || 0,
        round_off: form.round_off || 0,
        payment_terms: form.payment_terms || undefined,
        delivery_terms: form.delivery_terms || undefined,
        reference: form.reference || undefined,
        vendor_notes: form.vendor_notes || undefined,
        lines: lines.map(line => ({
          tooling_request_id: line.tooling_request_id || undefined,
          inventory_item_id: +line.inventory_item_id,
          qty: +line.qty, rate: +line.rate || 0, hsn_code: line.hsn_code || undefined,
          unit: line.unit || 'nos', discount_pct: +line.discount_pct || 0, gst_rate: +line.gst_rate || 0,
        })),
      });
      toast.success(`${po.po_number} created`);
      await onCreated();
      onClose();
    } catch (error) { toast.error(error.message || 'Could not create purchase order'); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={form.request_ids.length ? `Create ${meta.singular} PO` : `Direct ${meta.singular} PO`} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={save}><ShoppingBag size={14} /> Create PO</Button></>}>
      <div className="space-y-4">
        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Supplier &amp; delivery</span><span>{form.request_ids.length ? `${form.request_ids.length} approved requirement${form.request_ids.length === 1 ? '' : 's'}` : 'without a Job Card requirement'}</span></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vendor" required><SearchableSelect value={form.vendor_id} onChange={e => set({ vendor_id: e.target.value })}
              options={[{ value: '', label: 'Choose vendor' }, ...vendors.map(v => ({ value: String(v.id), label: v.name }))]} /></Field>
            <Field label="Expected Delivery"><Input type="date" value={form.expected_date} onChange={e => set({ expected_date: e.target.value })} /></Field>
          </div>
          <div className="mt-3"><TaxKindToggle value={form.tax_kind} onChange={value => set({ tax_kind: value })} /></div>
        </section>

        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>{meta.singular} lines</span><span>quantity, rate and GST</span></div>
          <div className="space-y-2">
            {form.lines.map((line, index) => (
              <div key={`${line.tooling_request_id || 'direct'}-${index}`} className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3 md:grid-cols-[minmax(220px,2fr)_90px_110px_90px_72px_36px]">
                <Field label={meta.singular}>
                  {line.tooling_request_id
                    ? <div className="min-h-9 rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-800">{line.item_name}<span className="block text-[11px] font-normal text-slate-400">{line.request_number} · {line.jc_number}</span></div>
                    : <SearchableSelect value={line.inventory_item_id} onChange={e => pickItem(index, e.target.value)} options={[
                      { value: '', label: `Choose ${meta.singular.toLowerCase()} master` },
                      ...inventory.map(item => ({ value: String(item.id), label: `${item.code} · ${item.name}` })),
                    ]} />}
                </Field>
                <Field label="Qty"><Input type="number" min="0" value={line.qty} onChange={e => updateLine(index, { qty: e.target.value })} /></Field>
                <Field label="Rate"><Input type="number" min="0" value={line.rate} onChange={e => updateLine(index, { rate: e.target.value })} /></Field>
                <Field label="HSN"><Input value={line.hsn_code} onChange={e => updateLine(index, { hsn_code: e.target.value })} /></Field>
                <Field label="GST %"><Input type="number" min="0" value={line.gst_rate} onChange={e => updateLine(index, { gst_rate: e.target.value })} /></Field>
                <div className="flex items-end"><Button size="sm" variant="ghost" title="Remove line" disabled={form.lines.length === 1}
                  onClick={() => setForm(current => ({ ...current, lines: current.lines.filter((_, i) => i !== index) }))}>×</Button></div>
              </div>
            ))}
          </div>
          {!form.request_ids.length && <Button className="mt-3" size="sm" variant="ghost" onClick={addLine}><Plus size={13} /> Add line</Button>}
        </section>

        <TermsFields form={form} set={set} />
        <PoTotalsPanel lines={form.lines} materials={inventory.map(item => ({ ...item, id: item.id }))}
          taxKind={form.tax_kind} freight={form.freight} roundOff={form.round_off}
          onFreight={value => set({ freight: value })} onRoundOff={value => set({ round_off: value })} />
      </div>
    </Modal>
  );
}

function GrnModal({ family, form, setForm, pos, inventory, vendors, onClose, onCreated }) {
  const toast = useToast();
  const meta = FAMILY[family];
  const [busy, setBusy] = useState(false);
  const set = patch => setForm(current => ({ ...current, ...patch }));
  // Every line on the PO, outstanding balances pre-filled. The finished ones are
  // KEPT and shown greyed — filtering them out made a part-received PO render as
  // a smaller order than the one that was raised.
  const pickPo = value => {
    const po = pos.find(row => String(row.id) === String(value));
    setForm(current => ({ ...current, purchase_order_id: value, lines: po ? initialReceipt(po) : [] }));
  };
  const updateLine = (index, patch) => setForm(current => ({ ...current,
    lines: current.lines.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  const setLines = next => setForm(current => ({ ...current, lines: next(current.lines) }));
  const totals = receiptTotals(form.lines);
  const receivable = (form.lines || []).filter(line => line.receivable).length;
  const save = async () => {
    if (form.mode === 'po' && !form.purchase_order_id) return toast.error('Choose a purchase order');
    if (form.mode === 'direct' && (!form.inventory_item_id || !(num(form.qty) > 0))) return toast.error(`Choose a ${meta.singular.toLowerCase()} and quantity`);
    const lines = form.mode === 'po' ? toReceiptPayload(form.lines) : [];
    if (form.mode === 'po' && !lines.length) return toast.error('Enter at least one received quantity');
    setBusy(true);
    try {
      await api.post(`/tooling/procurement/${family}/grns`, {
        purchase_order_id: form.mode === 'po' ? +form.purchase_order_id : undefined,
        lines,
        inventory_item_id: form.mode === 'direct' ? +form.inventory_item_id : undefined,
        qty: form.mode === 'direct' ? +form.qty : undefined,
        batch_no: form.mode === 'direct' ? form.batch_no || undefined : undefined,
        vendor_id: form.mode === 'direct' && form.vendor_id ? +form.vendor_id : undefined,
        vehicle_no: form.vehicle_no || undefined,
        supplier_invoice_no: form.supplier_invoice_no || undefined,
        supplier_invoice_date: form.supplier_invoice_date || undefined,
        received_by: form.received_by || undefined,
        remarks: form.remarks || undefined,
      });
      toast.success('GRN created · awaiting QC');
      await onCreated(); onClose();
    } catch (error) { toast.error(error.message || 'Could not create GRN'); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Create ${meta.singular} GRN`} wide
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="success" disabled={busy || (form.mode === 'po' && !totals.lines)} onClick={save}>
          <PackagePlus size={14} /> Create GRN{form.mode === 'po' && totals.lines > 1 ? `s · ${totals.lines} lines` : ''}
        </Button></>}>
      <div className="space-y-4">
        <SubTabs active={form.mode} onChange={mode => set({ mode })} views={[
          { key: 'po', label: 'Against Purchase Order' }, { key: 'direct', label: 'Direct Receipt' },
        ]} />
        <section className="ci-form-panel">
          {form.mode === 'po' ? <>
            <Field label="Open Purchase Order" required><SearchableSelect value={form.purchase_order_id} onChange={e => pickPo(e.target.value)} options={[
              { value: '', label: 'Choose purchase order' }, ...pos.filter(po => ['open','partially_received'].includes(po.status)).map(po => ({ value: String(po.id), label: `${po.po_number} · ${po.vendor_name}` })),
            ]} /></Field>
            {form.lines.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" disabled={totals.lines >= receivable}
                onClick={() => setLines(fillAll)}>Select all</Button>
              <Button size="sm" variant="ghost" disabled={!totals.lines}
                onClick={() => setLines(clearAll)}>Deselect all</Button>
              <span className="ml-auto text-[11px] font-bold uppercase tracking-wide text-slate-400 tabular-nums">
                {totals.lines} of {receivable} line{receivable === 1 ? '' : 's'} · {fmt.num(totals.qty)} {meta.singular.toLowerCase()}s
              </span>
            </div>}
            <div className="mt-3 space-y-2">{form.lines.map((line, index) => (
              <div key={line.id}
                className={`grid gap-2 rounded-lg border p-3 sm:grid-cols-[auto_minmax(200px,1fr)_120px_160px] ${line.receivable ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50'}`}>
                {/* A die is a quantity, so the tick means "the whole outstanding
                    balance" and the box below stays editable for a part delivery. */}
                <input type="checkbox" className="mt-2 h-4 w-4 shrink-0 accent-brand-600 disabled:opacity-40"
                  aria-label={`Receive the full balance of ${line.material_name || `line ${line.id}`}`}
                  disabled={!line.receivable} checked={lineTicked(line)}
                  onChange={() => setLines(current => toggleToolingLine(current, index))} />
                <div className="min-w-0 text-sm font-semibold">
                  {line.material_name}
                  {(line.request_number || line.jc_number) && <span className="block truncate text-[11px] font-normal text-slate-400">
                    {[line.request_number, line.jc_number].filter(Boolean).join(' · ')}
                  </span>}
                  <span className="block text-[11px] font-normal text-slate-400">
                    {line.receivable
                      ? `Pending ${fmt.num(line.pending)} of ${fmt.num(line.order_qty)} ${line.unit || 'nos'}`
                      : line.closed_short
                        ? `Closed short · ${fmt.num(line.received_qty)} of ${fmt.num(line.order_qty)} ${line.unit || 'nos'} received`
                        : `Fully received · ${fmt.num(line.order_qty)} ${line.unit || 'nos'}`}
                  </span>
                </div>
                <Field label={`Receive / ${fmt.num(line.pending)}`}>
                  <Input type="number" min="0" max={line.pending} value={line.receive_qty} disabled={!line.receivable}
                    onChange={e => updateLine(index, { receive_qty: e.target.value })} /></Field>
                <Field label="Batch / serial">
                  <Input value={line.batch_no} disabled={!line.receivable}
                    onChange={e => updateLine(index, { batch_no: e.target.value })} /></Field>
              </div>
            ))}</div>
          </> : <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`${meta.singular} Master`} required><SearchableSelect value={form.inventory_item_id} onChange={e => set({ inventory_item_id: e.target.value })} options={[
              { value: '', label: `Choose ${meta.singular.toLowerCase()}` }, ...inventory.map(item => ({ value: String(item.id), label: `${item.code} · ${item.name}` })),
            ]} /></Field>
            <Field label="Vendor"><SearchableSelect value={form.vendor_id} onChange={e => set({ vendor_id: e.target.value })} options={[
              { value: '', label: 'Optional vendor' }, ...vendors.map(v => ({ value: String(v.id), label: v.name })),
            ]} /></Field>
            <Field label="Quantity" required><Input type="number" min="0" value={form.qty} onChange={e => set({ qty: e.target.value })} /></Field>
            <Field label="Batch / serial"><Input value={form.batch_no} onChange={e => set({ batch_no: e.target.value })} /></Field>
          </div>}
        </section>
        <section className="ci-form-panel">
          <div className="ci-form-panel-title"><span>Receipt details</span><span>same fields as Procurement GRN</span></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Vehicle No"><Input value={form.vehicle_no} onChange={e => set({ vehicle_no: e.target.value })} /></Field>
            <Field label="Received By"><Input value={form.received_by} onChange={e => set({ received_by: e.target.value })} /></Field>
            <Field label="Supplier Invoice No"><Input value={form.supplier_invoice_no} onChange={e => set({ supplier_invoice_no: e.target.value })} /></Field>
            <Field label="Supplier Invoice Date"><Input type="date" value={form.supplier_invoice_date} onChange={e => set({ supplier_invoice_date: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Remarks"><Textarea value={form.remarks} onChange={e => set({ remarks: e.target.value })} /></Field></div>
          </div>
        </section>
      </div>
    </Modal>
  );
}

function QcModal({ family, grn, onClose, onSaved }) {
  const toast = useToast();
  const [accepted, setAccepted] = useState(String(grn.qty));
  const [rejected, setRejected] = useState('0');
  const [reason, setReason] = useState('');
  const save = async () => {
    if (Math.abs(num(accepted) + num(rejected) - num(grn.qty)) > 0.0001) return toast.error('Accepted and rejected must equal received quantity');
    await api.post(`/tooling/procurement/${family}/grns/${grn.id}/qc`, {
      accepted_qty: +accepted, rejected_qty: +rejected, rejection_reason: reason || undefined,
    });
    toast.success(`${grn.grn_number} QC completed`); await onSaved(); onClose();
  };
  return (
    <Modal open onClose={onClose} title={`QC · ${grn.grn_number}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="success" onClick={save}><CheckCircle2 size={14} /> Complete QC</Button></>}>
      <div className="ci-form-grid">
        <div className="md:col-span-2 rounded-lg bg-slate-50 p-3 text-sm"><b>{grn.item_name}</b><span className="block text-xs text-slate-500">Received {fmt.num(grn.qty)} {grn.unit || 'nos'} · {grn.vendor_name || 'Direct receipt'}</span></div>
        <Field label="Accepted"><Input type="number" min="0" max={grn.qty} value={accepted} onChange={e => { setAccepted(e.target.value); setRejected(String(Math.max(0, num(grn.qty) - num(e.target.value)))); }} /></Field>
        <Field label="Rejected"><Input type="number" min="0" max={grn.qty} value={rejected} onChange={e => { setRejected(e.target.value); setAccepted(String(Math.max(0, num(grn.qty) - num(e.target.value)))); }} /></Field>
        <div className="md:col-span-2"><Field label="Rejection / QC note"><Textarea value={reason} onChange={e => setReason(e.target.value)} /></Field></div>
      </div>
    </Modal>
  );
}

function InventoryModal({ family, initial, vendors, products, onClose, onSaved }) {
  const toast = useToast();
  const meta = FAMILY[family];
  const [form, setForm] = useState({
    name: initial?.name || '', product_id: initial?.product_id ? String(initial.product_id) : '',
    specification: initial?.specification || '', size: initial?.size || '', tool_type: initial?.tool_type || '',
    unit: initial?.unit || 'nos', hsn_code: initial?.hsn_code || '', gst_rate: initial?.gst_rate ?? '',
    std_rate: initial?.std_rate ?? '', min_stock: initial?.min_stock ?? '',
    preferred_vendor_id: initial?.preferred_vendor_id ? String(initial.preferred_vendor_id) : '',
  });
  const set = patch => setForm(current => ({ ...current, ...patch }));
  const save = async () => {
    if (!form.name.trim()) return toast.error(`${meta.singular} master name is required`);
    const body = { ...form, product_id: form.product_id ? +form.product_id : null,
      preferred_vendor_id: form.preferred_vendor_id ? +form.preferred_vendor_id : null,
      gst_rate: +form.gst_rate || 0, std_rate: +form.std_rate || 0, min_stock: +form.min_stock || 0 };
    if (initial?.id) await api.put(`/tooling/procurement/${family}/inventory/${initial.id}`, body);
    else await api.post(`/tooling/procurement/${family}/inventory`, body);
    toast.success(`${meta.singular} master saved`); await onSaved(); onClose();
  };
  return (
    <Modal open onClose={onClose} title={initial?.id ? `Edit ${initial.code}` : `New ${meta.singular} Master`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save}>Save Master</Button></>}>
      <div className="ci-form-grid">
        <Field label="Master Name" required><Input value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
        <Field label="Type"><Input value={form.tool_type} onChange={e => set({ tool_type: e.target.value })} placeholder={family === 'plate' ? 'Offset plate' : family === 'die' ? 'Cutting die' : 'Emboss / foil block'} /></Field>
        <Field label="Size"><Input value={form.size} onChange={e => set({ size: e.target.value })} /></Field>
        <Field label="Unit"><Input value={form.unit} onChange={e => set({ unit: e.target.value })} /></Field>
        <div className="md:col-span-2"><Field label="Specification"><Textarea value={form.specification} onChange={e => set({ specification: e.target.value })} /></Field></div>
        <div className="md:col-span-2"><Field label="Linked Product"><SearchableSelect value={form.product_id} onChange={e => set({ product_id: e.target.value })} options={[
          { value: '', label: 'Shared / no product' }, ...products.map(p => ({ value: String(p.id), label: `${p.name} · ${p.code}` })),
        ]} /></Field></div>
        <Field label="HSN"><Input value={form.hsn_code} onChange={e => set({ hsn_code: e.target.value })} /></Field>
        <Field label="GST %"><Input type="number" min="0" value={form.gst_rate} onChange={e => set({ gst_rate: e.target.value })} /></Field>
        <Field label="Standard Rate"><Input type="number" min="0" value={form.std_rate} onChange={e => set({ std_rate: e.target.value })} /></Field>
        <Field label="Minimum Stock"><Input type="number" min="0" value={form.min_stock} onChange={e => set({ min_stock: e.target.value })} /></Field>
        <div className="md:col-span-2"><Field label="Preferred Vendor"><SearchableSelect value={form.preferred_vendor_id} onChange={e => set({ preferred_vendor_id: e.target.value })} options={[
          { value: '', label: 'No preferred vendor' }, ...vendors.map(v => ({ value: String(v.id), label: v.name })),
        ]} /></Field></div>
      </div>
    </Modal>
  );
}

function GenericToolingProcurement({ family }) {
  const meta = FAMILY[family];
  const toast = useToast();
  const [tab, setTab] = useState('requirements');
  const [reqView, setReqView] = useState('open');
  const [poView, setPoView] = useState('pending');
  const [grnView, setGrnView] = useState('pending');
  const [warehouseView, setWarehouseView] = useState('stock');
  const [pendencyView, setPendencyView] = useState('lines');
  const [requests, setRequests] = useState([]);
  const [pos, setPos] = useState([]);
  const [grns, setGrns] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [batches, setBatches] = useState([]);
  const [movements, setMovements] = useState([]);
  const [history, setHistory] = useState([]);
  const [pendency, setPendency] = useState({ lines: [], items: [], parties: [] });
  const [vendors, setVendors] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkDeleteRows, setBulkDeleteRows] = useState(null);
  const [poModal, setPoModal] = useState(null);
  const [grnModal, setGrnModal] = useState(null);
  const [qcModal, setQcModal] = useState(null);
  const [itemModal, setItemModal] = useState(null);
  const [detail, setDetail] = useState(null);
  // Line-level "no more receipts" — { po, preselectId? }, from the PO row's
  // menu or a Pendency row with that line pre-ticked.
  const [closeLines, setCloseLines] = useState(null);

  const load = async () => {
    const base = `/tooling/procurement/${family}`;
    const [nextRequests, nextPos, nextGrns, nextInventory, nextBatches, nextMovements, nextHistory, nextPendency] = await Promise.all([
      api.get(`/tooling/requirements?family=${family}`),
      api.get(`${base}/purchase-orders`), api.get(`${base}/grns`), api.get(`${base}/inventory`),
      api.get(`${base}/batches`), api.get(`${base}/movements`), api.get(`${base}/purchase-history`), api.get(`${base}/pendency`),
    ]);
    setRequests(nextRequests); setPos(nextPos); setGrns(nextGrns); setInventory(nextInventory);
    setBatches(nextBatches); setMovements(nextMovements); setHistory(nextHistory); setPendency(nextPendency);
    setSelectedIds(current => current.filter(id => nextRequests.some(row => row.id === id)));
  };
  useEffect(() => {
    setTab('requirements'); setSelectedIds([]);
    load().catch(() => {});
    api.get('/vendors').then(setVendors);
    api.get('/products').then(setProducts);
  }, [family]);
  useRealtimeRefresh(() => load().catch(() => {}), OPERATIONS_REALTIME_TABLES, { debounceMs: 650 });

  const reqGroups = {
    open: requests.filter(row => ['pending','approved'].includes(row.approval_status)),
    converted: requests.filter(row => row.approval_status === 'converted'),
    closed: requests.filter(row => ['closed','rejected'].includes(row.approval_status)),
  };
  const poRows = pos.filter(po => poView === 'completed' ? ['received','closed'].includes(po.status) : !['received','closed'].includes(po.status));
  const grnRows = grns.filter(grn => grnView === 'completed' ? grn.status !== 'quarantine' : grn.status === 'quarantine');
  const selected = requests.filter(row => selectedIds.includes(row.id));
  const poSelectable = selected.length > 0 && selected.every(row => row.approval_status === 'approved');
  const deleteSelectable = selected.length > 0 && selected.every(row => row.approval_status === 'pending');
  const currentRequestRows = reqGroups[reqView];
  const allViewSelected = currentRequestRows.length > 0 && currentRequestRows.every(row => selectedIds.includes(row.id));

  const counts = useMemo(() => ({
    pending: requests.filter(row => row.approval_status === 'pending').length,
    approved: requests.filter(row => row.approval_status === 'approved').length,
    // pendingOf, not qty-received: a closed-short line's balance is waived and
    // must not read as still on order.
    onOrder: pos.reduce((sum, po) => sum + po.lines.reduce((lineSum, line) => lineSum + pendingOf(line), 0), 0),
    quarantine: grns.filter(row => row.status === 'quarantine').reduce((sum, row) => sum + num(row.qty), 0),
    free: inventory.reduce((sum, row) => sum + num(row.stock_free), 0),
  }), [requests, pos, grns, inventory]);

  const blankPo = () => ({ request_ids: [], vendor_id: '', expected_date: '', tax_kind: 'intra', freight: '', round_off: '',
    payment_terms: '', delivery_terms: '', reference: '', vendor_notes: '', lines: [{ inventory_item_id: '', material_id: '', item_name: '', qty: '', rate: '', hsn_code: '', unit: 'nos', discount_pct: '', gst_rate: '' }] });
  const openPoFor = rows => setPoModal({ ...blankPo(), request_ids: rows.map(row => row.id), lines: rows.map(row => ({
    tooling_request_id: row.id, request_number: row.request_number, jc_number: row.jc_number,
    inventory_item_id: String(row.inventory_item_id || ''), material_id: String(row.inventory_item_id || ''),
    item_name: row.inventory_name || row.product_name, qty: String(row.qty), rate: String(inventory.find(item => item.id === row.inventory_item_id)?.std_rate || ''),
    hsn_code: inventory.find(item => item.id === row.inventory_item_id)?.hsn_code || '', unit: row.inventory_unit || 'nos',
    discount_pct: '', gst_rate: String(inventory.find(item => item.id === row.inventory_item_id)?.gst_rate || ''),
  })) });
  const blankGrn = () => ({ mode: 'po', purchase_order_id: '', lines: [], inventory_item_id: '', qty: '', batch_no: '', vendor_id: '',
    vehicle_no: '', supplier_invoice_no: '', supplier_invoice_date: '', received_by: auth.user?.name || '', remarks: '' });
  const openGrn = () => setGrnModal(blankGrn());
  // Both doors into the GRN form fill the same way, so the row-level button can
  // never offer something the PO picker would not.
  const openGrnFor = po => setGrnModal({ ...blankGrn(), purchase_order_id: String(po.id),
    lines: initialReceipt(po) });

  const approve = async row => { await api.post(`/tooling/procurement/${family}/requirements/${row.id}/approve`); toast.success(`${row.request_number} approved`); load(); };
  const reserve = async row => {
    try {
      const result = await api.post(`/tooling/procurement/${family}/requirements/${row.id}/reserve`);
      toast.success(result.shortage > 0 ? `${fmt.num(result.reserved_now)} reserved · ${fmt.num(result.shortage)} still required` : `${row.request_number} covered from warehouse`);
      load();
    } catch (error) { toast.error(error.message || 'Could not reserve stock'); }
  };
  const act = async (row, action, body = {}) => {
    await api.post(`/tooling/procurement/${family}/requirements/${row.id}/${action}`, body);
    toast.info(`${row.request_number} updated`); load();
  };

  const requestColumns = [
    { key: 'request_number', label: 'Requirement', render: row => <span><b>{row.request_number}</b><span className="block text-[11px] text-slate-400">{row.jc_number}</span></span> },
    { key: 'product_name', label: 'Product', render: row => <ProductIdentity row={row} compact /> },
    { key: 'inventory_name', label: `${meta.singular} Master`, render: row => <span>{row.inventory_name || 'Not linked'}<span className="block text-[11px] text-slate-400">{row.inventory_code || row.inventory_specification || '—'}</span>{row.inventory_item_id && <StockPosition row={row} compact />}</span> },
    { key: 'qty', label: 'Qty', align: 'right', render: row => <span className="font-semibold tabular-nums">{fmt.num(row.qty)}<span className="block text-[10px] font-normal text-slate-400">{meta.unit}</span></span> },
    { key: 'needed_by', label: 'Needed by', render: row => fmt.date(row.needed_by) },
    { key: 'approval_status', label: 'Approval', render: row => <Chip value={row.approval_status} map={APPROVAL} /> },
    { key: 'po_number', label: 'PO', render: row => row.po_number || '—' },
    { key: 'actions', label: '', sortable: false, render: row => <div className="flex items-center justify-end gap-1" onClick={event => event.stopPropagation()}>
      {canBuy() && row.approval_status === 'pending' && <Button size="sm" variant="success" onClick={() => approve(row)}>Approve</Button>}
      {canBuy() && row.approval_status === 'approved' && num(row.stock_free) > 0 && <Button size="sm" variant="secondary" onClick={() => reserve(row)}><Warehouse size={12} /> Reserve</Button>}
      {canBuy() && row.approval_status === 'approved' && <Button size="sm" onClick={() => openPoFor([row])}>Create PO</Button>}
      <ActionMenu items={[
        { label: 'View requirement', icon: Eye, onClick: () => setDetail(row) },
        ...(canBuy() && row.approval_status === 'approved' ? [{ label: 'Un-approve', icon: RotateCcw, onClick: () => act(row, 'unapprove') }] : []),
        ...(canBuy() && row.approval_status === 'pending' ? [{ label: 'Reject', icon: AlertTriangle, danger: true, onClick: () => act(row, 'reject') }] : []),
      ]} />
    </div> },
  ];

  const poColumns = [
    { key: 'po_number', label: 'PO No', render: po => <Link className="font-bold text-brand-600 hover:underline" to={`/tooling/${meta.plural.toLowerCase()}/po/${po.id}`}>{po.po_number}</Link> },
    { key: 'vendor_name', label: 'Vendor' },
    // One item, one numbered line — the same grammar the Plate register uses, so
    // the two read alike.
    //
    // This showed the FIRST item and "+3". A four-line order could not say what
    // the other three were, and the request numbers underneath were a comma list
    // that belonged to no item in particular — so a PO covering four job cards
    // could not tell you which die was for which. The trailing chip is this
    // family's version of the plate build: a die is a quantity, so what a line
    // has to say is how much of it has landed.
    { key: 'lines', label: meta.plural, sortable: false, render: po => <div className="space-y-0.5">
      {po.lines.map((line, index) => {
        const receipt = lineReceipt(line);
        const refs = [line.request_number, line.jc_number].filter(Boolean).join(' · ');
        return <div key={line.id ?? index} className="flex min-w-0 items-start gap-2">
          <span className="mt-px w-4 shrink-0 text-right text-[10px] font-semibold tabular-nums text-slate-400">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-bold text-slate-700">{line.material_name || '—'}</span>
              {(line.size || line.spec) && <span className="shrink-0 truncate font-mono text-[10px] text-slate-400">{line.size || line.spec}</span>}
              <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${RECEIPT_TONE[receipt.state]}`}>{receipt.label}</span>
            </div>
            {refs && <span className="block truncate text-[10px] text-slate-400">{refs}</span>}
          </div>
        </div>;
      })}
      {!po.lines.length && <span className="text-xs text-slate-400">—</span>}
      <span className="block pl-6 pt-0.5 text-[11px] text-slate-400">
        {po.lines.length} {po.lines.length === 1 ? meta.singular.toLowerCase() : meta.plural.toLowerCase()}
        {po.lines.some(line => line.request_number) ? '' : ' · Direct PO'}
      </span>
    </div> },
    { key: 'expected_date', label: 'Expected', render: po => fmt.date(po.expected_date) },
    { key: 'fulfilment', label: 'Fulfilment', sortable: false, render: po => {
      // Waived balances are not owed, so the bar measures against what can
      // still arrive — an order with a closed line can then read complete.
      const ordered = po.lines.reduce((sum, line) => sum + (line.closed_short ? Math.min(num(line.received_qty), num(line.qty)) : num(line.qty)), 0);
      const received = po.lines.reduce((sum, line) => sum + Math.min(num(line.received_qty), num(line.qty)), 0);
      return <FulfillmentBar pct={ordered ? received / ordered * 100 : 0} done={received} total={ordered} />;
    } },
    { key: 'status', label: 'Status', render: po => <Chip value={po.status} map={PO_STATUS} /> },
    { key: 'actions', label: '', sortable: false, render: po => <div className="flex justify-end gap-1" onClick={event => event.stopPropagation()}>
      <Link to={`/tooling/${meta.plural.toLowerCase()}/po/${po.id}`}><Button size="sm" variant="secondary"><Eye size={12} /> Open</Button></Link>
      {canBuy() && ['open','partially_received'].includes(po.status) && <Button size="sm" onClick={() => openGrnFor(po)}><PackagePlus size={12} /> GRN</Button>}
      <ActionMenu items={[
        { label: 'Print / send PO', icon: Send, onClick: () => window.open(`/tooling/${meta.plural.toLowerCase()}/po/${po.id}`, '_self') },
        ...(canBuy() && !po.sent_at ? [{ label: 'Mark sent to vendor', icon: Truck, onClick: async () => { await api.post(`/tooling/procurement/${family}/purchase-orders/${po.id}/send`); toast.success(`${po.po_number} marked sent`); load(); } }] : []),
        ...(canBuy() && !['closed', 'reversed'].includes(po.status) ? [{ label: 'Close lines — no more receipts…', icon: Ban, danger: true, onClick: () => setCloseLines({ po }) }] : []),
      ]} />
    </div> },
  ];

  const grnColumns = [
    { key: 'grn_number', label: 'GRN No', render: row => <b>{row.grn_number}</b> },
    { key: 'item_name', label: meta.singular, render: row => <span>{row.item_name}<span className="block text-[11px] text-slate-400">{row.item_code} · {row.request_number || 'Direct receipt'}</span></span> },
    { key: 'vendor_name', label: 'Vendor', render: row => row.vendor_name || 'Direct' },
    { key: 'qty', label: 'Received', align: 'right', render: row => `${fmt.num(row.qty)} ${row.unit || 'nos'}` },
    { key: 'batch_no', label: 'Batch / Serial', render: row => row.batch_no || '—' },
    { key: 'created_at', label: 'Received on', render: row => fmt.dt(row.created_at) },
    { key: 'status', label: 'QC', render: row => <Chip value={row.status} map={GRN_STATUS} /> },
    { key: 'actions', label: '', sortable: false, render: row => canQc() && row.status === 'quarantine'
      ? <Button size="sm" variant="success" onClick={event => { event.stopPropagation(); setQcModal(row); }}><FileCheck2 size={12} /> QC</Button> : null },
  ];

  const inventoryColumns = [
    { key: 'code', label: 'Code', render: row => <b>{row.code}</b> },
    { key: 'name', label: `${meta.singular} Master`, render: row => <span>{row.name}<span className="block text-[11px] text-slate-400">{row.product_name || 'Shared master'}</span></span> },
    { key: 'specification', label: 'Specification', render: row => row.specification || '—' },
    { key: 'size', label: 'Size / Type', render: row => <span>{row.size || '—'}<span className="block text-[11px] text-slate-400">{row.tool_type || ''}</span></span> },
    { key: 'stock_free', label: 'Warehouse Position', sortable: true, render: row => <StockPosition row={row} /> },
    { key: 'preferred_vendor_name', label: 'Vendor', render: row => row.preferred_vendor_name || row.last_vendor_name || '—' },
    { key: 'last_purchase_at', label: 'Purchase History', render: row => row.last_purchase_at ? <span>{fmt.date(row.last_purchase_at)}<span className="block text-[11px] text-slate-400">{fmt.inr(row.last_rate)} · {row.purchase_count} receipt{num(row.purchase_count) === 1 ? '' : 's'}</span></span> : 'No purchase yet' },
    { key: 'min_stock', label: 'Minimum', align: 'right', render: row => <span className={num(row.stock_free) < num(row.min_stock) ? 'font-bold text-red-600' : ''}>{fmt.num(row.min_stock)}</span> },
  ];

  const batchColumns = [
    { key: 'batch_no', label: 'Batch / Serial', render: row => <b>{row.batch_no || `Batch ${row.id}`}</b> },
    { key: 'item_name', label: meta.singular, render: row => `${row.item_code} · ${row.item_name}` },
    { key: 'qty', label: 'Available', align: 'right', render: row => fmt.num(row.qty) },
    { key: 'reserved_qty', label: 'Reserved', align: 'right', render: row => fmt.num(row.reserved_qty) },
    { key: 'free', label: 'Free', align: 'right', render: row => fmt.num(num(row.qty) - num(row.reserved_qty)) },
    { key: 'vendor_name', label: 'Vendor', render: row => row.vendor_name || 'Opening / adjustment' },
    { key: 'grn_number', label: 'GRN', render: row => row.grn_number || '—' },
    { key: 'received_at', label: 'Received', render: row => fmt.dt(row.received_at) },
  ];

  const movementColumns = [
    { key: 'at', label: 'When', render: row => fmt.dt(row.at) },
    { key: 'item_name', label: meta.singular, render: row => `${row.item_code} · ${row.item_name}` },
    { key: 'movement_type', label: 'Movement', render: row => fmt.title(row.movement_type) },
    { key: 'qty', label: 'Qty', align: 'right', render: row => <span className={num(row.qty) < 0 ? 'text-red-600' : 'text-emerald-700'}>{fmt.num(row.qty)}</span> },
    { key: 'reference', label: 'Reference', render: row => row.reference || row.request_number || row.grn_number || '—' },
    { key: 'note', label: 'Note', render: row => row.note || '—' },
    { key: 'user_name', label: 'By', render: row => row.user_name || '—' },
  ];

  const historyColumns = [
    { key: 'created_at', label: 'Received', render: row => fmt.date(row.created_at) },
    { key: 'item_name', label: meta.singular, render: row => `${row.item_code} · ${row.item_name}` },
    { key: 'vendor_name', label: 'Vendor', render: row => row.vendor_name || 'Direct' },
    { key: 'po_number', label: 'PO', render: row => row.po_number || '—' },
    { key: 'grn_number', label: 'GRN', render: row => row.grn_number },
    { key: 'qty', label: 'Qty', align: 'right', render: row => `${fmt.num(row.qty)} ${row.unit || 'nos'}` },
    { key: 'rate', label: 'Rate', align: 'right', render: row => row.rate == null ? '—' : fmt.inr(row.rate) },
  ];

  const pendencyColumns = pendencyView === 'lines' ? [
    { key: 'po_number', label: 'PO', render: row => <b>{row.po_number}</b> },
    { key: 'item_name', label: meta.singular, render: row => <span>{row.product_name || `${row.item_code} · ${row.item_name}`}
      <span className="block text-[11px] text-slate-400">{row.product_name ? `${row.item_code} · ${[row.request_number, row.jc_number].filter(Boolean).join(' · ')}` : 'Direct PO'}</span></span>,
      export: row => [row.product_name, row.item_code, row.item_name].filter(Boolean).join(' · ') },
    { key: 'vendor_name', label: 'Vendor' },
    { key: 'pending_qty', label: 'Pending', align: 'right', render: row => `${fmt.num(row.pending_qty)} ${row.unit}` },
    { key: 'expected_date', label: 'Expected', render: row => fmt.date(row.expected_date) },
    { key: 'age_bucket', label: 'Age', render: row => <span className={`rounded-full px-2 py-1 text-[11px] font-bold ${AGE_TONE[row.age_bucket]}`}>{row.age_bucket} days</span> },
    // The row-level close: THIS line stops expecting receipts, the order's
    // other lines stay live. Same modal as the PO row, this line pre-ticked.
    { key: 'actions', label: '', sortable: false, render: row => canBuy() ? <div className="flex justify-end" onClick={event => event.stopPropagation()}>
      <Button size="sm" variant="ghost" title="No more receipts — close this line" onClick={() => {
        const po = pos.find(p => p.id === row.purchase_order_id);
        if (!po) return toast.error('Reload — this order is not in the register yet');
        setCloseLines({ po, preselectId: row.id });
      }}><Ban size={12} /> No more</Button>
    </div> : null },
  ] : pendencyView === 'items' ? [
    { key: 'item_code', label: 'Code', render: row => <b>{row.item_code}</b> }, { key: 'item_name', label: meta.singular },
    { key: 'lines', label: 'PO Lines', align: 'right' }, { key: 'pending_qty', label: 'Pending Qty', align: 'right', render: row => fmt.num(row.pending_qty) },
  ] : [
    { key: 'vendor_name', label: 'Vendor', render: row => <b>{row.vendor_name}</b> },
    { key: 'lines', label: 'PO Lines', align: 'right' }, { key: 'pending_qty', label: 'Pending Qty', align: 'right', render: row => fmt.num(row.pending_qty) },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title={meta.plural} subtitle={`Job Card requirement → approval → Purchase Order → GRN → QC → ${meta.singular.toLowerCase()} warehouse`}
        actions={<>
          {canBuy() && <Button variant="secondary" onClick={() => setPoModal(blankPo())}><ShoppingBag size={15} /> Direct PO</Button>}
          {canBuy() && <Button variant="success" onClick={openGrn}><PackagePlus size={15} /> Create GRN</Button>}
          {canBuy() && tab === 'warehouse' && <Button onClick={() => setItemModal({})}><Plus size={15} /> New {meta.singular} Master</Button>}
        </>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard compact label="Pending Approval" value={counts.pending} icon={ClipboardCheck} tone={counts.pending ? 'warn' : 'neutral'} />
        <KpiCard compact label="Approved" value={counts.approved} icon={CheckCircle2} tone="good" />
        <KpiCard compact label="On Order" value={fmt.num(counts.onOrder)} icon={Truck} />
        <KpiCard compact label="Awaiting QC" value={fmt.num(counts.quarantine)} icon={FileCheck2} tone={counts.quarantine ? 'warn' : 'neutral'} />
        <KpiCard compact label="Free Stock" value={fmt.num(counts.free)} icon={Warehouse} tone="good" />
      </div>

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'requirements', label: 'Requirements', count: counts.pending },
        { key: 'pos', label: 'Purchase Orders', count: pos.filter(po => !['received','closed'].includes(po.status)).length },
        { key: 'grns', label: 'GRN / QC', count: grns.filter(row => row.status === 'quarantine').length },
        { key: 'warehouse', label: 'Warehouse', count: inventory.length },
        { key: 'pendency', label: 'Pendency', count: pendency.lines.length },
      ]} />

      {tab === 'requirements' && <>
        {selectedIds.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
          <b className="mr-auto text-sm text-brand-900">{selectedIds.length} selected</b>
          {!poSelectable && !deleteSelectable && <span className="text-xs font-semibold text-amber-700">Select only approved PRs for a PO, or only pending PRs to delete</span>}
          {!allViewSelected && <Button size="sm" variant="ghost" onClick={() => setSelectedIds(current => [...new Set([...current, ...currentRequestRows.map(row => row.id)])])}>Select all</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Deselect all</Button>
          <Button size="sm" disabled={!poSelectable} onClick={() => openPoFor(selected)}><ShoppingBag size={13} /> Create Bulk PO</Button>
          <Button size="sm" variant="danger" disabled={!deleteSelectable} onClick={() => setBulkDeleteRows(selected)}><Trash2 size={13} /> Delete PRs</Button>
        </div>}
        <SubTabs active={reqView} onChange={value => { setReqView(value); setSelectedIds([]); }} views={[
          { key: 'open', label: 'Pending', count: reqGroups.open.length },
          { key: 'converted', label: 'Converted', count: reqGroups.converted.length },
          { key: 'closed', label: 'Closed', count: reqGroups.closed.length },
        ]} />
        {/* NEWEST FIRST — see the Plate queue: an undeclared sort is not
            "server order", it is first-column-ascending. */}
        <DataTable searchable selectable rows={reqGroups[reqView]} columns={requestColumns}
          defaultSort={{ key: 'id', dir: 'desc' }}
          selectedIds={selectedIds} onToggleRow={(row, checked) => setSelectedIds(current => checked ? [...new Set([...current, row.id])] : current.filter(id => id !== row.id))}
          onToggleAll={(rows, checked) => { const ids = rows.map(row => row.id); setSelectedIds(current => checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id))); }}
          onRowClick={setDetail} searchPlaceholder={`Search ${meta.plural.toLowerCase()}, Job Card, product or code…`}
          empty={`No ${meta.singular.toLowerCase()} requirements in this view`} exportName={`${meta.plural} Requirements`} />
      </>}

      {tab === 'pos' && <>
        <SubTabs active={poView} onChange={setPoView} views={[
          { key: 'pending', label: 'Pending', count: pos.filter(po => !['received','closed'].includes(po.status)).length },
          { key: 'completed', label: 'Completed', count: pos.filter(po => ['received','closed'].includes(po.status)).length },
        ]} />
        <DataTable searchable rows={poRows} columns={poColumns} defaultSort={{ key: 'id', dir: 'desc' }} empty="No purchase orders in this view" exportName={`${meta.plural} Purchase Orders`} />
      </>}

      {tab === 'grns' && <>
        <SubTabs active={grnView} onChange={setGrnView} views={[
          { key: 'pending', label: 'Pending QC', count: grns.filter(row => row.status === 'quarantine').length },
          { key: 'completed', label: 'Completed', count: grns.filter(row => row.status !== 'quarantine').length },
        ]} />
        <DataTable searchable rows={grnRows} columns={grnColumns} defaultSort={{ key: 'id', dir: 'desc' }} empty="No GRNs in this view" exportName={`${meta.plural} GRN Register`} />
      </>}

      {tab === 'warehouse' && <>
        <SubTabs active={warehouseView} onChange={setWarehouseView} views={[
          { key: 'stock', label: 'Stock', count: inventory.length },
          { key: 'batches', label: 'Batches', count: batches.length },
          { key: 'movements', label: 'Movements', count: movements.length },
          { key: 'history', label: 'Purchase History', count: history.length },
        ]} />
        {warehouseView === 'stock' && <DataTable searchable rows={inventory} columns={inventoryColumns} defaultSort={{ key: 'code', dir: 'asc' }} onRowClick={setItemModal} empty={`No ${meta.singular.toLowerCase()} masters`} exportName={`${meta.plural} Warehouse`} />}
        {warehouseView === 'batches' && <DataTable searchable rows={batches.map(row => ({ ...row, free: num(row.qty) - num(row.reserved_qty) }))} columns={batchColumns}
          defaultSort={{ key: 'id', dir: 'desc' }} empty="No warehouse batches" exportName={`${meta.plural} Batches`} />}
        {warehouseView === 'movements' && <DataTable searchable rows={movements} columns={movementColumns} defaultSort={{ key: 'at', dir: 'desc' }} empty="No stock movements" exportName={`${meta.plural} Movement Ledger`} />}
        {warehouseView === 'history' && <DataTable searchable rows={history} columns={historyColumns} defaultSort={{ key: 'created_at', dir: 'desc' }} empty="No purchase history" exportName={`${meta.plural} Purchase History`} />}
      </>}

      {tab === 'pendency' && <>
        <SubTabs active={pendencyView} onChange={setPendencyView} views={[
          { key: 'lines', label: 'PO Lines', count: pendency.lines.length },
          { key: 'items', label: meta.plural, count: pendency.items.length },
          { key: 'parties', label: 'Vendors', count: pendency.parties.length },
        ]} />
        <DataTable searchable rows={pendency[pendencyView] || []} columns={pendencyColumns}
          defaultSort={{ key: 'expected_date', dir: 'asc' }} empty="Nothing is pending" exportName={`${meta.plural} Pendency`} />
      </>}

      {closeLines && <ClosePoLinesModal
        poNumber={closeLines.po.po_number} vendorName={closeLines.po.vendor_name} unitWord={meta.unit}
        impactEmptyText="No job requirement rides on the ticked lines — direct PO stock."
        lines={(closeLines.po.lines || []).map(line => ({
          id: line.id, qty: num(line.qty), received_qty: num(line.received_qty), unit: line.unit,
          closed_short: !!line.closed_short, closed_reason: line.closed_reason, closed_by: line.closed_by,
          pending: Math.max(0, num(line.qty) - num(line.received_qty)),
          preselected: line.id === closeLines.preselectId,
          title: line.material_name || line.item_name,
          sub: [line.request_number, line.jc_number].filter(Boolean).join(' · ') || 'Direct PO',
        }))}
        // The die/block impact: which requirement each closing line strands. A
        // requirement with NOTHING received offers the checkbox — release it
        // back to Approved for re-sourcing; a part-received one keeps its
        // converted anchor and the row says so.
        loadImpact={line_ids => api.post(`/tooling/procurement/${family}/purchase-orders/${closeLines.po.id}/lines/close-impact`, { line_ids })
          .then(r => [...new Map((r.requirements || []).map(row => {
            const eligible = num(row.received_qty) === 0;
            return [row.requirement_id, {
              id: row.requirement_id, selectable: eligible, defaultOn: eligible, qty: null,
              order_line_id: row.order_line_id,
              title: row.product_name || row.request_number, code: row.product_code,
              sub: [row.request_number, row.jc_number].filter(Boolean).join(' · '),
              message: eligible
                ? `Returns to Approved for re-sourcing — plan the ${meta.singular.toLowerCase()} again.`
                : `${fmt.num(row.received_qty)} of ${fmt.num(row.qty)} received — stays converted; raise a fresh requirement for the shortfall.`,
            }];
          })).values()])}
        onCloseLines={(line_ids, reason, releases) => api.post(`/tooling/procurement/${family}/purchase-orders/${closeLines.po.id}/lines/close`,
          { line_ids, reason, release_requirements: (releases || []).map(row => row.id) })}
        onReopenLines={line_ids => api.post(`/tooling/procurement/${family}/purchase-orders/${closeLines.po.id}/lines/reopen`, { line_ids })}
        onDone={load} onClose={() => setCloseLines(null)} />}
      {poModal && <PoModal family={family} form={poModal} setForm={setPoModal} vendors={vendors} inventory={inventory} onClose={() => setPoModal(null)} onCreated={async () => { setSelectedIds([]); await load(); }} />}
      {bulkDeleteRows && <BulkDeleteModal family={family} rows={bulkDeleteRows} onClose={() => setBulkDeleteRows(null)} onDeleted={async () => { setSelectedIds([]); await load(); }} />}
      {grnModal && <GrnModal family={family} form={grnModal} setForm={setGrnModal} pos={pos} inventory={inventory} vendors={vendors} onClose={() => setGrnModal(null)} onCreated={load} />}
      {qcModal && <QcModal family={family} grn={qcModal} onClose={() => setQcModal(null)} onSaved={load} />}
      {itemModal && <InventoryModal family={family} initial={itemModal.id ? itemModal : null} vendors={vendors} products={products} onClose={() => setItemModal(null)} onSaved={load} />}
      {detail && <Modal open onClose={() => setDetail(null)} title={`${detail.request_number} · ${detail.product_name}`}
        footer={<><Button variant="secondary" onClick={() => setDetail(null)}>Close</Button>{canBuy() && detail.approval_status === 'approved' && <Button onClick={() => { setDetail(null); openPoFor([detail]); }}>Create PO</Button>}</>}>
        <div className="space-y-4">
          <ProductIdentity row={detail} />
          <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Job Card</span><p className="font-semibold">{detail.jc_number}</p></div>
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Required</span><p className="font-semibold">{fmt.num(detail.qty)} {meta.unit}</p></div>
            <div><span className="text-[10px] font-bold uppercase text-slate-400">Approval</span><p><Chip value={detail.approval_status} map={APPROVAL} /></p></div>
          </div>
          {detail.inventory_item_id && <section className="ci-form-panel"><div className="ci-form-panel-title"><span>{meta.singular} master</span><span>{detail.inventory_code}</span></div><p className="font-semibold">{detail.inventory_name}</p><p className="text-xs text-slate-500">{detail.inventory_specification || 'No additional specification'}</p><StockPosition row={detail} /></section>}
        </div>
      </Modal>}
    </div>
  );
}

export default function ToolingProcurement({ family }) {
  return family === 'plate' ? <PlatesLifecycle /> : <GenericToolingProcurement family={family} />;
}
