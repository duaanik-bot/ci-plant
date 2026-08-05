// Quick-create masters — add a product or material without leaving the sales
// order / purchase flow you're on. Render AFTER the parent Modal so it stacks
// on top; guard the parent's onClose while this is open.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { boardName, boardCode, takenCodesFor } from '../lib/boardCode.js';
import { Button, Field, Input, Modal, searchText, Select, useToast } from './ui.jsx';

// No wastage_pct here. It was on this form and never saved: products.wastage_pct
// is NOT NULL, so it cannot be added to the generic master write list without
// failing every product create (see server master-columns.test.js), and the
// plant plans wastage in absolute child sheets now — the percentage is only a
// fallback that defaults to 0. An input that silently discards what is typed is
// worse than no input.
const PRODUCT_BLANK = {
  name: '', code: '', board_material_id: '', gsm: '', size: '', child_l: '', child_w: '',
  ups: '', colors: '', coating: '', special: '', tool_id: '',
  product_type: '', gst_pct: '', rate: '',
};
const num = v => (v === '' || v == null ? null : +v);
// A blank box means "not known yet" — it must reach the server as an ABSENT
// column, never as NULL. products fills its own blanks (ups 1, colors 4,
// special 'none', wastage_pct 0) but only for a column the INSERT leaves out:
// an explicit NULL is a value, and NOT NULL refuses the row. Sending every key
// with null in it is what made a half-known product unsaveable — leaving
// Colours or Special empty failed the create outright. JSON.stringify drops
// undefined keys, so pruning here is what the server actually sees as absent.
const known = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ''));

export function ProductQuickCreate({ open, onClose, customerId, customerName, suggestedCode, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(PRODUCT_BLANK);
  const [refs, setRefs] = useState({ materials: [], dies: [], gst_rates: [] });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Internal Code arrives pre-issued from the customer's series (computed by
    // the caller from its already-loaded product list). Editable; blank still
    // works — the server issues the code on save.
    setForm({ ...PRODUCT_BLANK, code: suggestedCode || '' });
    Promise.all([api.get('/materials'), api.get('/tools?family=die'), api.get('/gst_rates')])
      .then(([materials, dies, gst_rates]) => setRefs({ materials, dies, gst_rates }))
      .catch(() => {});
  }, [open, suggestedCode]);

  const set = patch => setForm(f => ({ ...f, ...patch }));
  // Board and Ups are learned on the way, not at the order desk — the board is
  // picked in Planning and the ups fall out of the cut layout. Holding the
  // order line hostage to them meant the sales desk guessed, and a guessed
  // board is worse than a blank one. Held here: only what the line itself
  // cannot be raised without — something to call it, and something to bill it.
  const ready = form.name && form.rate;

  const save = async () => {
    setSaving(true);
    try {
      const product = await api.post('/products', known({
        customer_id: +customerId,
        name: form.name,
        code: form.code,
        board_material_id: num(form.board_material_id),
        gsm: num(form.gsm),
        size: form.size || null,
        child_l: num(form.child_l),
        child_w: num(form.child_w),
        ups: num(form.ups),
        colors: num(form.colors),
        coating: form.coating || null,
        special: form.special || null,
        tool_id: num(form.tool_id),
        product_type: form.product_type || null,
        gst_pct: num(form.gst_pct),
        rate: num(form.rate),
        active: 1,
      }));
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
          <Field label="Internal Code" hint="Auto-issued — clear to take the next code on save">
            <Input className="font-mono" value={form.code} onChange={e => set({ code: e.target.value })} />
          </Field>
          <Field label="Board" hint="Leave blank to decide in Planning — the product is flagged Spec incomplete until it is set">
            <Select value={form.board_material_id} onChange={e => set({ board_material_id: e.target.value })}>
              <option value="">Select board…</option>
              {refs.materials.filter(m => m.category === 'board' && (m.active ?? 1)).map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="GSM"><Input type="number" value={form.gsm} onChange={e => set({ gsm: e.target.value })} /></Field>
          {/* What the carton IS and what it sells for, together and high up:
              Carton Size, Product Type, Rate and GST sit straight under Board +
              GSM because that block is what the sales desk actually knows when
              it raises the line. The print spec (sheet, ups, colours, finish)
              follows underneath — it is filled in later, in Planning. */}
          <Field label="Carton Size (L×W×H)"><Input value={form.size} onChange={e => set({ size: e.target.value })} /></Field>
          <Field label="Product Type" hint="Sets the default GST — carton 5%, labels/leaflets/shippers 18%">
            <Select value={form.product_type} onChange={e => set({ product_type: e.target.value })}>
              <option value="">—</option>
              {refs.gst_rates.filter(g => g.active).map(g => <option key={g.id} value={g.product_type}>{g.label} — {g.rate}%</option>)}
            </Select>
          </Field>
          <Field label="Rate ₹/carton" required><Input type="number" step="0.01" value={form.rate} onChange={e => set({ rate: e.target.value })} /></Field>
          <Field label="GST % Override" hint="Leave blank to use the Product Type default">
            <Select value={form.gst_pct} onChange={e => set({ gst_pct: e.target.value })}>
              <option value="">—</option>
              {[5, 12, 18].map(o => <option key={o} value={o}>{o}%</option>)}
            </Select>
          </Field>
          <Field label="Print Sheet Length (in)" hint="Child sheet — e.g. 18"><Input type="number" value={form.child_l} onChange={e => set({ child_l: e.target.value })} /></Field>
          <Field label="Print Sheet Width (in)" hint="Child sheet — e.g. 23"><Input type="number" value={form.child_w} onChange={e => set({ child_w: e.target.value })} /></Field>
          <Field label="Ups per Print Sheet" hint="Defaults to 1 — Planning re-derives it from the cut layout"><Input type="number" value={form.ups} onChange={e => set({ ups: e.target.value })} /></Field>
          <Field label="Colours"><Input type="number" value={form.colors} onChange={e => set({ colors: e.target.value })} /></Field>
          <Field label="Coating">
            <Select value={form.coating} onChange={e => set({ coating: e.target.value })}>
              <option value="">—</option>
              {['None', 'Aqueous Varnish (Gloss)', 'Aqueous Varnish (Matte)', 'Drip-Off Coating',
                'Full UV Coating', 'Spot UV', 'Thermal Lamination (Gloss)', 'Thermal Lamination (Matte)',
                'Soft Touch', 'Gloss'].map(o => <option key={o} value={o}>{o}</option>)}
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
                <option key={d.id} value={d.id} data-search={searchText(d)}>
                  {`${d.code}${d.carton_size ? ` — ${d.carton_size}` : ''}${d.condition && d.condition !== 'Good' ? ` (${d.condition})` : ''}`}
                </option>))}
            </Select>
          </Field>
        </div>
      </div>
    </Modal>
  );
}

const MATERIAL_BLANK = { grade: '', gsm: '', sheet_l: '', sheet_w: '', sheets_per_packet: '', reorder_level: '' };

// Sheets in one packet, by grade — same plant standard the Boards master seeds.
// Kept in step with PACKET_BY_GRADE in Masters.jsx.
const PACKET_BY_GRADE = {
  'Duplex GB': 144, 'Duplex WB': 144, 'FBB': 100, 'Saffire': 100, 'SBS': 100, 'Chromo Paper': 150,
};

// Quick-create straight onto a PR/PO line. This builds a BOARD, because the
// board master is the plant's only raw-material master — grade, GSM and parent
// size are what price (₹/kg × kg/sheet) and weigh it, so a row created here has
// to carry them or it lands on the PO with no rate. Name and code are composed
// exactly as the Boards master composes them, so a board added mid-PO is
// indistinguishable from one added in Masters.
export function MaterialQuickCreate({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(MATERIAL_BLANK);
  const [refs, setRefs] = useState({ materials: [], grades: [] });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(MATERIAL_BLANK);
    Promise.all([api.get('/materials'), api.get('/board-grades')])
      .then(([materials, grades]) => setRefs({ materials, grades }))
      .catch(() => {});
  }, [open]);

  const set = patch => setForm(f => ({ ...f, ...patch }));
  // Picking a grade seeds the standard packet size into a blank field only — an
  // odd mill pack the buyer typed survives a grade change.
  const setGrade = grade => set({
    grade,
    sheets_per_packet: (form.sheets_per_packet ?? '') !== ''
      ? form.sheets_per_packet : (PACKET_BY_GRADE[grade] ?? ''),
  });

  const name = boardName(form);
  const takenCodes = takenCodesFor(refs.materials, null);
  const code = name ? boardCode(form, takenCodes) : '';
  // Same identity rule as the Boards master: the name is how a board is matched
  // on everywhere else, so two may not share one.
  const clash = name && refs.materials.find(m => m.category === 'board'
    && String(m.name ?? '').trim().toLowerCase() === name.trim().toLowerCase());
  const ready = !!name && !clash;

  const save = async () => {
    setSaving(true);
    try {
      const material = await api.post('/materials', {
        name,
        category: 'board',
        spec: code || null,
        unit: 'sheets',
        grade: form.grade,
        gsm: num(form.gsm),
        sheet_l: num(form.sheet_l),
        sheet_w: num(form.sheet_w),
        sheets_per_packet: num(form.sheets_per_packet),
        gst_rate: 18,
        reorder_level: num(form.reorder_level) ?? 0,
        // Every column this route knows is written explicitly: an omitted key is
        // inserted as NULL, not as its column default, so leaving `active` out
        // fails the NOT NULL constraint outright. Same defaults the Boards
        // master applies to a new row.
        active: 1,
      });
      toast.success(`Board "${material.name}" created`);
      onCreated?.(material);
    } catch { /* central toast already shown — keep the modal open */ }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Board — quick create"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={!ready || saving}>{saving ? 'Creating…' : 'Create & Use Board'}</Button>
      </>}>
      <div className="space-y-3">
        <p className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700">
          Goes straight into the Boards master and is selected on your line.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Grade" required hint="Drives the ₹/kg this board is bought at">
            <Select value={form.grade} onChange={e => setGrade(e.target.value)}>
              <option value="">Select grade…</option>
              {refs.grades.map(g => <option key={g.grade} value={g.grade} data-search={searchText(g)}>{g.grade}</option>)}
            </Select>
          </Field>
          <Field label="GSM" required><Input type="number" value={form.gsm} onChange={e => set({ gsm: e.target.value })} /></Field>
          <Field label="Parent Sheet Length (in)" required><Input type="number" value={form.sheet_l} onChange={e => set({ sheet_l: e.target.value })} /></Field>
          <Field label="Parent Sheet Width (in)" required><Input type="number" value={form.sheet_w} onChange={e => set({ sheet_w: e.target.value })} /></Field>
          <Field label="Sheets / Packet" hint="Auto-filled from the grade">
            <Input type="number" value={form.sheets_per_packet} onChange={e => set({ sheets_per_packet: e.target.value })} />
          </Field>
          <Field label="Reorder Level"><Input type="number" value={form.reorder_level} onChange={e => set({ reorder_level: e.target.value })} /></Field>
        </div>
        {/* The composed identity, shown before saving — the same name and code the
            Boards master would produce, so there is no surprise on the list. */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Board name</div>
          <div className="mt-0.5 font-semibold text-slate-800">
            {name || <span className="font-normal text-slate-400">Grade, GSM and both sheet sizes needed</span>}
            {code && <span className="ml-2 font-mono text-xs text-slate-400">{code}</span>}
          </div>
          {clash && <div className="mt-1 text-xs font-semibold text-red-600">
            “{name}” already exists in the board master — pick it on the line instead.
          </div>}
        </div>
      </div>
    </Modal>
  );
}
