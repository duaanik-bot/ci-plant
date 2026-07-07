// Quick-create masters — add a product or material without leaving the sales
// order / purchase flow you're on. Render AFTER the parent Modal so it stacks
// on top; guard the parent's onClose while this is open.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input, Modal, Select, useToast } from './ui.jsx';

const PRODUCT_BLANK = {
  name: '', code: '', board_material_id: '', gsm: '', size: '', child_l: '', child_w: '',
  ups: '', wastage_pct: '', colors: '', coating: '', special: '', tool_id: '',
  product_type: '', gst_pct: '', rate: '',
};
const num = v => (v === '' || v == null ? null : +v);

export function ProductQuickCreate({ open, onClose, customerId, customerName, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(PRODUCT_BLANK);
  const [refs, setRefs] = useState({ materials: [], dies: [], gst_rates: [] });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(PRODUCT_BLANK);
    Promise.all([api.get('/materials'), api.get('/tools?family=die'), api.get('/gst_rates')])
      .then(([materials, dies, gst_rates]) => setRefs({ materials, dies, gst_rates }))
      .catch(() => {});
  }, [open]);

  const set = patch => setForm(f => ({ ...f, ...patch }));
  const ready = form.name && form.code && form.board_material_id && form.ups && form.rate;

  const save = async () => {
    setSaving(true);
    try {
      const product = await api.post('/products', {
        customer_id: +customerId,
        name: form.name,
        code: form.code,
        board_material_id: num(form.board_material_id),
        gsm: num(form.gsm),
        size: form.size || null,
        child_l: num(form.child_l),
        child_w: num(form.child_w),
        ups: num(form.ups),
        wastage_pct: num(form.wastage_pct),
        colors: num(form.colors),
        coating: form.coating || null,
        special: form.special || null,
        tool_id: num(form.tool_id),
        product_type: form.product_type || null,
        gst_pct: num(form.gst_pct),
        rate: num(form.rate),
        active: 1,
      });
      toast.success(`Product "${product.name}" created`);
      onCreated?.(product);
    } catch { /* central toast already shown — keep the modal open */ }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} wide title="New Product — quick create"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready || saving}>{saving ? 'Creating…' : 'Create & Use Product'}</Button>
      </>}>
      <div className="space-y-3">
        <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700">
          Goes straight into the Products master for <b>{customerName || 'this customer'}</b> and is selected on your order line.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required><Input value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="Code" required><Input value={form.code} onChange={e => set({ code: e.target.value })} /></Field>
          <Field label="Board" required>
            <Select value={form.board_material_id} onChange={e => set({ board_material_id: e.target.value })}>
              <option value="">Select board…</option>
              {refs.materials.filter(m => m.category === 'board').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="GSM"><Input type="number" value={form.gsm} onChange={e => set({ gsm: e.target.value })} /></Field>
          <Field label="Carton Size (L×W×H)"><Input value={form.size} onChange={e => set({ size: e.target.value })} /></Field>
          <Field label="Print Sheet Length (in)" hint="Child sheet — e.g. 18"><Input type="number" value={form.child_l} onChange={e => set({ child_l: e.target.value })} /></Field>
          <Field label="Print Sheet Width (in)" hint="Child sheet — e.g. 23"><Input type="number" value={form.child_w} onChange={e => set({ child_w: e.target.value })} /></Field>
          <Field label="Ups per Print Sheet" required><Input type="number" value={form.ups} onChange={e => set({ ups: e.target.value })} /></Field>
          <Field label="Wastage %"><Input type="number" value={form.wastage_pct} onChange={e => set({ wastage_pct: e.target.value })} /></Field>
          <Field label="Colours"><Input type="number" value={form.colors} onChange={e => set({ colors: e.target.value })} /></Field>
          <Field label="Coating">
            <Select value={form.coating} onChange={e => set({ coating: e.target.value })}>
              <option value="">—</option>
              {['none', 'aqueous', 'uv', 'matt_lam', 'gloss_lam'].map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Special">
            <Select value={form.special} onChange={e => set({ special: e.target.value })}>
              <option value="">—</option>
              {['none', 'foil', 'emboss', 'foil_emboss', 'window'].map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
            </Select>
          </Field>
          <Field label="Die" hint="Managed in the Tooling Hub">
            <Select value={form.tool_id} onChange={e => set({ tool_id: e.target.value })}>
              <option value="">—</option>
              {refs.dies.map(d => (
                <option key={d.id} value={d.id}>
                  {`${d.code}${d.carton_size ? ` — ${d.carton_size}` : ''}${d.condition && d.condition !== 'Good' ? ` (${d.condition})` : ''}`}
                </option>))}
            </Select>
          </Field>
          <Field label="Product Type" hint="Sets the default GST — carton 5%, labels/leaflets/shippers 18%">
            <Select value={form.product_type} onChange={e => set({ product_type: e.target.value })}>
              <option value="">—</option>
              {refs.gst_rates.filter(g => g.active).map(g => <option key={g.id} value={g.product_type}>{g.label} — {g.rate}%</option>)}
            </Select>
          </Field>
          <Field label="GST % Override" hint="Leave blank to use the Product Type default">
            <Select value={form.gst_pct} onChange={e => set({ gst_pct: e.target.value })}>
              <option value="">—</option>
              {[5, 12, 18].map(o => <option key={o} value={o}>{o}%</option>)}
            </Select>
          </Field>
          <Field label="Rate ₹/carton" required><Input type="number" step="0.01" value={form.rate} onChange={e => set({ rate: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

const MATERIAL_BLANK = { name: '', category: '', spec: '', unit: '', sheet_l: '', sheet_w: '', reorder_level: '' };

export function MaterialQuickCreate({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(MATERIAL_BLANK);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setForm(MATERIAL_BLANK); }, [open]);

  const set = patch => setForm(f => ({ ...f, ...patch }));
  const ready = form.name && form.category && form.unit;

  const save = async () => {
    setSaving(true);
    try {
      const material = await api.post('/materials', {
        name: form.name,
        category: form.category,
        spec: form.spec || null,
        unit: form.unit,
        sheet_l: num(form.sheet_l),
        sheet_w: num(form.sheet_w),
        reorder_level: num(form.reorder_level),
      });
      toast.success(`Material "${material.name}" created`);
      onCreated?.(material);
    } catch { /* central toast already shown — keep the modal open */ }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Material — quick create"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready || saving}>{saving ? 'Creating…' : 'Create & Use Material'}</Button>
      </>}>
      <div className="space-y-3">
        <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700">
          Goes straight into the Materials master and is selected on your line.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required><Input value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="Category" required>
            <Select value={form.category} onChange={e => set({ category: e.target.value })}>
              <option value="">Select category…</option>
              {['board', 'ink', 'foil', 'adhesive', 'laminate', 'other'].map(o => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
          <Field label="Specification"><Input value={form.spec} onChange={e => set({ spec: e.target.value })} /></Field>
          <Field label="Unit" required><Input value={form.unit} onChange={e => set({ unit: e.target.value })} placeholder="e.g. sheets, kg" /></Field>
          <Field label="Parent Sheet Length (in)" hint="Boards only — e.g. 25"><Input type="number" value={form.sheet_l} onChange={e => set({ sheet_l: e.target.value })} /></Field>
          <Field label="Parent Sheet Width (in)" hint="Boards only — e.g. 36"><Input type="number" value={form.sheet_w} onChange={e => set({ sheet_w: e.target.value })} /></Field>
          <Field label="Reorder Level"><Input type="number" value={form.reorder_level} onChange={e => set({ reorder_level: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}
