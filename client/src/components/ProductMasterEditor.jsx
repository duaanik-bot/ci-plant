import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { api, fmt } from '../api.js';
import {
  PRODUCT_MASTER_FIELDS,
  PRODUCT_MASTER_SOFT_SPEC,
  productMasterBody,
  productMasterRequiredMissing,
  validateProductMaster,
} from '../lib/productMasterConfig.js';
import { Button, Field, Input, Modal, searchText, Select, useToast } from './ui.jsx';

const EMPTY_REFS = { customers: [], materials: [], dies: [], gst_rates: [] };

export default function ProductMasterEditor({ open, product, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [refs, setRefs] = useState(EMPTY_REFS);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !product?.id) return;
    let current = true;
    setForm({ ...product });
    setLoading(true);
    setLoadError('');
    Promise.all([
      api.get('/products'),
      api.get('/customers'),
      api.get('/materials'),
      api.get('/tools?family=die'),
      api.get('/gst_rates'),
    ]).then(([allProducts, customers, materials, dies, gstRates]) => {
      if (!current) return;
      const fresh = allProducts.find(row => String(row.id) === String(product.id));
      setProducts(allProducts);
      setRefs({ customers, materials, dies, gst_rates: gstRates });
      setForm({ ...product, ...(fresh || {}) });
    }).catch(error => {
      if (current) setLoadError(error.message || 'Could not load the full product master.');
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [open, product?.id, retryVersion]);

  const set = patch => setForm(current => ({ ...current, ...patch }));

  const save = async () => {
    if (!form?.id) return;
    const body = productMasterBody(form);
    const problem = validateProductMaster(body, { rows: products, editing: form });
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const saved = await api.put(`/products/${form.id}`, body);
      const next = { ...form, ...saved };
      toast.success('Product master updated');
      onSaved?.(next);
      onClose();
    } catch {
      // The shared API handler already shows the server's reason.
    } finally {
      setSaving(false);
    }
  };

  const renderField = field => {
    if (field.dependsOn) {
      const off = String(form[field.dependsOn] ?? '') !== '1';
      return (
        <Select value={off ? '' : (form[field.key] ?? '')} disabled={off}
          onChange={event => set({ [field.key]: event.target.value })}>
          <option value="">{off ? 'Set Leafing to Yes' : 'Select...'}</option>
          {field.options.map(option => <option key={option} value={option}>{fmt.title(String(option))}</option>)}
        </Select>
      );
    }
    if (field.type === 'select') {
      return (
        <Select value={form[field.key] ?? ''} onChange={event => set({ [field.key]: event.target.value })}>
          <option value="">-</option>
          {field.options.map(option => (
            <option key={option} value={option}>
              {typeof option === 'number'
                ? (field.key === 'active' || field.bool || field.key === 'spec_incomplete'
                    ? (option ? 'Yes' : 'No') : option)
                : (field.key === 'coating' || field.key === 'pasting_type' ? option : fmt.title(String(option)))}
            </option>
          ))}
        </Select>
      );
    }
    if (field.type === 'gstref') {
      return (
        <Select value={form[field.key] ?? ''} onChange={event => set({ [field.key]: event.target.value })}>
          <option value="">-</option>
          {refs.gst_rates.filter(row => row.active).map(row => (
            <option key={row.id} value={row.product_type} data-search={searchText(row)}>{row.label} - {row.rate}%</option>
          ))}
        </Select>
      );
    }
    if (field.type === 'ref') {
      return (
        <Select value={form[field.key] ?? ''} onChange={event => set({ [field.key]: event.target.value })}>
          <option value="">Select...</option>
          {(refs[field.ref] || [])
            .filter(field.filter || (() => true))
            .filter(row => row.active == null || row.active || String(row.id) === String(form[field.key]))
            .map(row => (
              <option key={row.id} value={row.id} data-search={searchText(row)}>
                {row.name ?? `${row.code}${row.carton_size ? ` - ${row.carton_size}` : ''}${row.condition && row.condition !== 'Good' ? ` (${row.condition})` : ''}`}
              </option>
            ))}
        </Select>
      );
    }
    return (
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        value={form[field.key] ?? ''}
        className={field.mono ? 'font-mono' : ''}
        onChange={event => set({ [field.key]: event.target.value })}
      />
    );
  };

  const pending = form ? PRODUCT_MASTER_SOFT_SPEC.filter(spec => {
    const value = form[spec.key];
    return value == null || value === '' || (spec.zeroIsBlank && +value === 0);
  }) : [];

  return (
    <Modal open={open} onClose={saving ? undefined : onClose} size="xl" layer="nested"
      title="Edit Product Master"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={loading || !!loadError || saving || !form || productMasterRequiredMissing(form)}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
      </>}>
      {loading ? (
        <div className="flex min-h-56 items-center justify-center text-sm font-medium text-slate-500">
          <Loader2 size={18} className="mr-2 animate-spin" /> Loading product master...
        </div>
      ) : loadError ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 text-center">
          <AlertTriangle size={22} className="text-amber-600" />
          <div>
            <p className="text-sm font-bold text-slate-800">The full product master could not be loaded.</p>
            <p className="mt-1 text-xs text-slate-500">No fields can be saved until every master reference is available.</p>
          </div>
          <Button variant="secondary" onClick={() => setRetryVersion(version => version + 1)}>Retry</Button>
        </div>
      ) : form ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {pending.length > 0 && (
            <div className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[11px] font-semibold text-amber-800">
              <AlertTriangle size={13} className="shrink-0" />
              <span>Still to fill - you can save now and finish these later:</span>
              {pending.map(spec => (
                <span key={spec.key} className="rounded-full bg-white/80 px-2 py-0.5 font-bold text-amber-700">{spec.label}</span>
              ))}
            </div>
          )}
          {PRODUCT_MASTER_FIELDS.filter(field => !field.showWhen || field.showWhen(form)).map(field => (
            <Field key={field.key} label={field.label} required={field.required} hint={field.hint}
              className={field.newRow ? 'sm:col-start-1' : ''}>
              {renderField(field)}
            </Field>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
