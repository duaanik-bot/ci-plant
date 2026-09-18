// Create or edit one inner product — an item that goes inside a Fluence kit, or a
// printed packaging component. Carton dimensions stay BLANK until they are
// actually known; the form never fills a guess.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Modal } from '../ui.jsx';
import { DOSE_FORMS, normaliseDims } from '../../lib/fluence.js';

const box = 'h-9 w-full rounded-xl border border-[#1D1D1F]/[0.12] bg-white/85 px-2.5 text-sm font-medium text-[#1D1D1F] outline-none transition focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20';
const lab = 'mb-1 block text-[11px] font-semibold text-[#6E6E73]';
const v = x => (x == null ? '' : String(x));

export default function InnerProductForm({ open, item, onClose, onSaved }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      name: v(item?.name), kind: item?.kind || 'item', product_code: v(item?.product_code), artwork_code: v(item?.artwork_code),
      dosage_form: v(item?.dosage_form), standard_mrp: v(item?.standard_mrp),
      carton_l: v(item?.carton_l), carton_w: v(item?.carton_w), carton_h: v(item?.carton_h),
      // A kit-component row carries the component's own remark as `remarks` and the
      // inner product's as `inner_remarks` — this form edits the inner product.
      packaging_info: v(item?.packaging_info), remarks: v(item && 'inner_remarks' in item ? item.inner_remarks : item?.remarks),
    });
  }, [open, item]);

  const set = (k, val) => setForm(f => ({ ...f, [k]: val }));
  const id = item?.inner_product_id ?? item?.id ?? null;

  const save = async () => {
    if (!String(form.name || '').trim()) { setError('The inner product needs a name.'); return; }
    const dims = normaliseDims(form);
    if (dims.errors.length) { setError(dims.errors.join(' ')); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = id ? await api.put(`/fluence/inner-products/${id}`, form) : await api.post('/fluence/inner-products', form);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} layer="nested"
      title={id ? `Inner product — ${item?.name}` : 'New inner product'}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" />} Save</Button>
      </>}>
      <div className="space-y-3">
        <p className="rounded-xl bg-green-50 px-3 py-2 text-xs text-green-900">
          Fluence inner product master. Changes apply to every kit that contains this item.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="sm:col-span-2"><span className={lab}>Name *</span>
            <input className={box} value={form.name ?? ''} onChange={e => set('name', e.target.value)} /></label>
          <label><span className={lab}>Kind</span>
            <select className={box} value={form.kind ?? 'item'} onChange={e => set('kind', e.target.value)}>
              <option value="item">Item (goes inside the kit)</option>
              <option value="packaging">Packaging component</option>
            </select></label>
          <label><span className={lab}>Product code</span>
            <input className={box} value={form.product_code ?? ''} onChange={e => set('product_code', e.target.value)} /></label>
          <label><span className={lab}>Artwork code</span>
            <input className={box} value={form.artwork_code ?? ''} onChange={e => set('artwork_code', e.target.value)} /></label>
          <label><span className={lab}>Dosage form</span>
            <input className={box} list="fluence-inner-forms" value={form.dosage_form ?? ''} onChange={e => set('dosage_form', e.target.value)} placeholder="Tablet" />
            <datalist id="fluence-inner-forms">{DOSE_FORMS.map(f => <option key={f} value={f} />)}</datalist></label>
          <label><span className={lab}>Standard MRP (₹)</span>
            <input className={box} inputMode="decimal" value={form.standard_mrp ?? ''} onChange={e => set('standard_mrp', e.target.value)} /></label>
        </div>
        <div>
          <span className={lab}>Carton dimensions (mm) — leave blank until known</span>
          <div className="grid grid-cols-3 gap-2">
            {[['carton_l', 'Length'], ['carton_w', 'Width'], ['carton_h', 'Height']].map(([k, label]) => (
              <label key={k}><span className="mb-0.5 block text-[10px] uppercase tracking-wider text-[#86868B]">{label}</span>
                <input className={box} inputMode="decimal" value={form[k] ?? ''} onChange={e => set(k, e.target.value)} placeholder="—" /></label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className={lab}>Other packaging information</span>
            <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.packaging_info ?? ''} onChange={e => set('packaging_info', e.target.value)} placeholder="e.g. Strip of 10 in mono carton" /></label>
          <label><span className={lab}>Remarks</span>
            <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.remarks ?? ''} onChange={e => set('remarks', e.target.value)} /></label>
        </div>
        {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}
