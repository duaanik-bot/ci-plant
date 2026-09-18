// Editing a Fluence prescription — one line per kit item, one box per time of
// day. Saves straight to the Fluence master, naming the revision it started
// from so a colleague's save in the meantime is refused instead of overwritten.
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ListPlus, Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { Button } from '../ui.jsx';
import { RX_SLOTS, DOSE_FORMS, FREQUENCIES, normaliseRxPayload, formatRxLine } from '../../lib/fluence.js';

const box = 'h-8 w-full rounded-lg border border-[#1D1D1F]/[0.12] bg-white/85 px-2 text-xs font-medium text-[#1D1D1F] outline-none transition focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20';
const lab = 'mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[#86868B]';
const OTHER_ITEM = '__other__';

const blankLine = (patch = {}) => ({
  inner_product_id: null, item_label: '', dosage: '', dose_form: '', pack_count: '', frequency: '',
  morning_qty: '', afternoon_qty: '', evening_qty: '', night_qty: '', other_timing: '', other_qty: '',
  instructions: '', remarks: '', ...patch,
});
const asForm = v => (v == null ? '' : String(v));

export function formFromPrescription(rx) {
  return {
    general_instructions: rx?.general_instructions || '',
    remarks: rx?.remarks || '',
    lines: (rx?.lines || []).map(l => blankLine({
      inner_product_id: l.inner_product_id ?? null,
      _item_name: l.item_name || '',
      item_label: l.item_label || '',
      dosage: l.dosage || '', dose_form: l.dose_form || '', pack_count: asForm(l.pack_count), frequency: l.frequency || '',
      morning_qty: asForm(l.morning_qty), afternoon_qty: asForm(l.afternoon_qty), evening_qty: asForm(l.evening_qty),
      night_qty: asForm(l.night_qty), other_timing: l.other_timing || '', other_qty: asForm(l.other_qty),
      instructions: l.instructions || '', remarks: l.remarks || '',
    })),
  };
}

export default function PrescriptionEditor({ dossier, context, onCancel, onSaved, onDirty }) {
  const components = dossier.components || [];
  const initial = useMemo(() => formFromPrescription(dossier.prescription), [dossier.prescription]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const itemName = id => components.find(c => c.inner_product_id === id)?.name;
  const touch = next => { setForm(next); onDirty?.(true); };
  const setLine = (i, patch) => touch({ ...form, lines: form.lines.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const move = (i, d) => {
    const lines = [...form.lines];
    const j = i + d;
    if (j < 0 || j >= lines.length) return;
    [lines[i], lines[j]] = [lines[j], lines[i]];
    touch({ ...form, lines });
  };
  const usedIds = new Set(form.lines.map(l => l.inner_product_id).filter(Boolean));
  const missingItems = components.filter(c => !usedIds.has(c.inner_product_id));
  const addKitItems = () => touch({
    ...form,
    lines: [...form.lines, ...missingItems.map(c => blankLine({ inner_product_id: c.inner_product_id, dose_form: c.dosage_form || '' }))],
  });

  const save = async () => {
    const { errors } = normaliseRxPayload(form);
    if (errors.length) { setError(errors.join(' ')); return; }
    setSaving(true);
    setError(null);
    try {
      const out = await api.put(`/fluence/products/${dossier.product.id}/prescription`, {
        ...form,
        from: context,
        base_revision: dossier.prescription?.revision ?? 0,
      });
      onSaved?.(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-[#515154]">
          Saving updates the <b>Fluence master</b> — every module and every job card for {dossier.part_of
            ? <>{dossier.part_of.outer_code} and its part cartons (this one included)</>
            : dossier.kit?.parts?.length ? <>{dossier.product.code} and its {dossier.kit.parts.length} part cartons</> : dossier.product.code} reads this prescription.
          Leave a time blank if nothing is taken then.
        </p>
        {missingItems.length > 0 && (
          <Button size="sm" variant="secondary" onClick={addKitItems} title="Add one line for every kit item not yet on the prescription">
            <ListPlus size={13} /> Add {missingItems.length === components.length ? 'a line per kit item' : `${missingItems.length} missing kit item${missingItems.length > 1 ? 's' : ''}`}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => touch({ ...form, lines: [...form.lines, blankLine()] })}>
          <Plus size={13} /> Add line
        </Button>
      </div>

      {form.lines.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[#1D1D1F]/15 bg-white/50 px-4 py-6 text-center text-xs text-[#6E6E73]">
          No dose lines yet. {components.length ? 'Start with a line per kit item, or add lines one by one.' : 'Add a line for each item the patient takes.'}
        </div>
      )}

      <datalist id="fluence-dose-forms">{DOSE_FORMS.map(f => <option key={f} value={f} />)}</datalist>
      <datalist id="fluence-frequencies">{FREQUENCIES.map(f => <option key={f} value={f} />)}</datalist>

      {form.lines.map((l, i) => {
        const selectValue = l.inner_product_id ? String(l.inner_product_id) : (l._other || l.item_label ? OTHER_ITEM : '');
        const preview = formatRxLine(l, itemName(l.inner_product_id) || l._item_name || l.item_label);
        return (
          <div key={i} className="rounded-2xl border border-white/80 bg-white/60 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-12 flex items-end gap-2 sm:col-span-5">
                <span className="mb-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-700 text-[10px] font-bold text-white">{i + 1}</span>
                <label className="min-w-0 flex-1">
                  <span className={lab}>Kit item</span>
                  <select className={box} value={selectValue}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === OTHER_ITEM) setLine(i, { inner_product_id: null, item_label: l.item_label || '', _other: true });
                      else if (!v) setLine(i, { inner_product_id: null, item_label: '', _other: false });
                      else {
                        const c = components.find(x => String(x.inner_product_id) === v);
                        setLine(i, { inner_product_id: Number(v), item_label: '', _other: false, dose_form: l.dose_form || c?.dosage_form || '' });
                      }
                    }}>
                    <option value="">Choose…</option>
                    {components.map(c => (
                      <option key={c.inner_product_id} value={c.inner_product_id}
                        disabled={usedIds.has(c.inner_product_id) && c.inner_product_id !== l.inner_product_id}>
                        {c.name}{+c.qty_per_kit > 1 ? ` (×${c.qty_per_kit})` : ''}
                      </option>
                    ))}
                    {l.inner_product_id && !components.some(c => c.inner_product_id === l.inner_product_id) && (
                      <option value={l.inner_product_id}>{l._item_name || `Item #${l.inner_product_id}`} (no longer in the kit list)</option>
                    )}
                    <option value={OTHER_ITEM}>Something not in the kit list…</option>
                  </select>
                </label>
              </div>
              {selectValue === OTHER_ITEM && (
                <label className="col-span-12 sm:col-span-3">
                  <span className={lab}>Item name</span>
                  <input className={box} value={l.item_label} onChange={e => setLine(i, { item_label: e.target.value })} placeholder="e.g. Hair serum" />
                </label>
              )}
              <label className="col-span-6 sm:col-span-2">
                <span className={lab}>Form</span>
                <input className={box} list="fluence-dose-forms" value={l.dose_form} onChange={e => setLine(i, { dose_form: e.target.value })} placeholder="Tablet" />
              </label>
              <label className={`col-span-6 ${selectValue === OTHER_ITEM ? 'sm:col-span-2' : 'sm:col-span-3'}`}>
                <span className={lab}>Dosage / strength</span>
                <input className={box} value={l.dosage} onChange={e => setLine(i, { dosage: e.target.value })} placeholder="e.g. 500 mg" />
              </label>
              <label className="col-span-4 sm:col-span-2">
                <span className={lab}>Pack of</span>
                <input className={box} inputMode="decimal" value={l.pack_count} onChange={e => setLine(i, { pack_count: e.target.value })} placeholder="30" />
              </label>

              {/* The day, in order — each time gets its full name and its own box. */}
              {RX_SLOTS.map(s => (
                <label key={s.key} className="col-span-3 sm:col-span-2">
                  <span className={lab}>{s.label}</span>
                  <input className={`${box} text-center font-bold`} inputMode="decimal" value={l[s.key]} placeholder="—"
                    title={`${s.label} — how many`} onChange={e => setLine(i, { [s.key]: e.target.value })} />
                </label>
              ))}
              <label className="col-span-8 sm:col-span-3">
                <span className={lab}>Other time</span>
                <input className={box} value={l.other_timing} onChange={e => setLine(i, { other_timing: e.target.value })} placeholder="e.g. Before bed" />
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className={lab}>Qty</span>
                <input className={`${box} text-center font-bold`} inputMode="decimal" value={l.other_qty} onChange={e => setLine(i, { other_qty: e.target.value })} />
              </label>

              <label className="col-span-12 sm:col-span-3">
                <span className={lab}>Frequency</span>
                <input className={box} list="fluence-frequencies" value={l.frequency} onChange={e => setLine(i, { frequency: e.target.value })} placeholder="Once daily" />
              </label>
              <label className="col-span-12 sm:col-span-5">
                <span className={lab}>Instructions</span>
                <input className={box} value={l.instructions} onChange={e => setLine(i, { instructions: e.target.value })} placeholder="e.g. After breakfast, with water" />
              </label>
              <label className="col-span-12 sm:col-span-4">
                <span className={lab}>Remarks</span>
                <input className={box} value={l.remarks} onChange={e => setLine(i, { remarks: e.target.value })} />
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <p className={`min-w-0 flex-1 rounded-lg px-2 py-1 text-[11px] ${preview ? 'bg-green-50/80 text-green-900' : 'text-[#AEAEB2]'}`}>
                {preview ? <>Reads: {preview}</> : 'Choose the kit item and enter when it is taken.'}
              </p>
              <button type="button" title="Move up" onClick={() => move(i, -1)} disabled={i === 0}
                className="rounded-lg p-1.5 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] disabled:opacity-30"><ArrowUp size={13} /></button>
              <button type="button" title="Move down" onClick={() => move(i, 1)} disabled={i === form.lines.length - 1}
                className="rounded-lg p-1.5 text-[#86868B] hover:bg-[#1D1D1F]/[0.06] disabled:opacity-30"><ArrowDown size={13} /></button>
              <button type="button" title="Remove this line" onClick={() => touch({ ...form, lines: form.lines.filter((_, n) => n !== i) })}
                className="rounded-lg p-1.5 text-red-500 hover:bg-red-50"><Trash2 size={13} /></button>
            </div>
          </div>
        );
      })}

      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className={lab}>General instructions (whole kit)</span>
          <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.general_instructions}
            onChange={e => touch({ ...form, general_instructions: e.target.value })} placeholder="e.g. Continue for 30 days" />
        </label>
        <label>
          <span className={lab}>Remarks</span>
          <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.remarks}
            onChange={e => touch({ ...form, remarks: e.target.value })} />
        </label>
      </div>

      {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save to Fluence master
        </Button>
      </div>
    </div>
  );
}
