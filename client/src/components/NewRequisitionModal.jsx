// New Purchase Requisition — ONE form, several doors.
//
// Procurement and Warehouse both raise PRs, and there is exactly one procurement
// lifecycle behind them (PR → approval → PO → GRN → stock). So this modal is
// self-contained: it loads its own masters, rates, live stock and duplicate
// check, and every caller passes only what makes its door different.
//
// A storekeeper on `production`/`qc` has no Procurement module, so routing them
// there to finish a PR would dead-end. The form comes to them instead.
import { useCallback, useEffect, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import { MaterialQuickCreate } from './QuickCreateMasters.jsx';
import { PrLineEditor } from './ProcurementForms.jsx';
import { AlertTriangle } from 'lucide-react';

const blankLine = () => ({ material_id: '', qty: '', est_rate: '', unit: '', remarks: '' });

const PURPOSE_LABELS = [
  ['production', 'Production / Job requirement'],
  ['stock_replenishment', 'Stock replenishment'],
  ['reorder_level', 'Reorder level procurement'],
  ['general_inventory', 'General inventory purchase'],
];

// `defaults` seeds the header (department, purpose). `seedMaterialIds` prefills
// the line list from a warehouse selection, with the quantity already set to the
// server's suggested figure — the user reviews rather than retypes.
export default function NewRequisitionModal({ open, onClose, onRaised, seedMaterialIds = [], defaults = {} }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [stock, setStock] = useState([]);
  const [prs, setPrs] = useState([]);
  const [boardRates, setBoardRates] = useState(new Map());
  const [quickMat, setQuickMat] = useState(null);   // { line: i }
  const [dupPr, setDupPr] = useState(null);         // { dupes, reason }
  const [saving, setSaving] = useState(false);

  // Everything the form needs, loaded when it opens. Failures degrade rather
  // than block: no stock means the strip shows "—", and the form still works.
  useEffect(() => {
    if (!open) { setForm(null); setDupPr(null); setQuickMat(null); return; }
    let live = true;
    (async () => {
      const [ms, st, ps, rates] = await Promise.all([
        api.get('/materials').catch(() => []),
        api.get('/inventory/stock').catch(() => []),
        api.get('/requisitions').catch(() => []),
        api.get('/board-po-rates').catch(() => []),
      ]);
      if (!live) return;
      setMaterials(ms); setStock(st); setPrs(ps);
      setBoardRates(new Map(rates.map(r => [String(r.material_id),
        { rate: r.rate_per_sheet, source: r.source, rate_per_kg: r.rate_per_kg }])));

      const byId = new Map(st.map(s => [String(s.id), s]));
      const seeded = seedMaterialIds
        .map(id => ({ id: String(id), s: byId.get(String(id)), m: ms.find(x => String(x.id) === String(id)) }))
        .filter(x => x.m)
        .map(({ id, s, m }) => ({
          ...blankLine(), material_id: id, unit: m.unit || '',
          qty: s && +s.suggested > 0 ? String(s.suggested) : '',
        }));

      setForm({
        requested_by: auth.user?.name || '', department: '', needed_by: '',
        priority: 'normal', purpose: 'production', reason: '', remarks: '',
        ...defaults,
        lines: seeded.length ? seeded : [blankLine()],
      });
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seedMaterialIds.join(','), JSON.stringify(defaults)]);

  // Board ₹/sheet from the rate master, else the material's std → last rate.
  // Mirrors the server's resolvePoRate precedence so screen and server agree.
  const rateFor = mat => {
    if (!mat) return null;
    const b = boardRates.get(String(mat.id));
    if (b) return { rate: b.rate, source: b.source, rate_per_kg: b.rate_per_kg };
    if (mat.std_rate != null) return { rate: mat.std_rate, source: 'std', rate_per_kg: null };
    if (mat.last_rate != null) return { rate: mat.last_rate, source: 'last', rate_per_kg: null };
    return { rate: null, source: 'none', rate_per_kg: null };
  };

  // Stable identity keyed on the stock array — the board picker memoizes its
  // option list on this function. See the twin in Procurement.jsx.
  const stockFor = useCallback(id => stock.find(s => String(s.id) === String(id)) || null, [stock]);

  const activePrsFor = materialId => {
    if (!materialId) return [];
    return prs.filter(p => ['pending', 'approved'].includes(p.status)
      && (p.lines || []).some(l => String(l.material_id) === String(materialId)));
  };

  const body = (extra = {}) => ({
    requested_by: form.requested_by || undefined, department: form.department || undefined,
    needed_by: form.needed_by || undefined, priority: form.priority || 'normal',
    purpose: form.purpose || 'production',
    reason: form.reason || undefined, remarks: form.remarks || undefined,
    lines: form.lines.filter(l => l.material_id && +l.qty > 0).map(l => ({
      material_id: +l.material_id, qty: +l.qty,
      est_rate: l.est_rate === '' || l.est_rate == null ? undefined : +l.est_rate,
      remarks: l.remarks || undefined,
    })), ...extra,
  });

  const raise = async payload => {
    setSaving(true);
    try {
      const pr = await api.post('/requisitions', payload);
      toast.success(payload.reraise_of ? 'Requisition re-raised' : `${pr.pr_number || 'Requisition'} raised`);
      setDupPr(null);
      onRaised?.(pr);
      onClose();
    } catch (e) {
      // api.js already toasts plain errors centrally; only structured decision
      // errors (e.data.code) reach the caller untoasted.
      if (e.data?.code) toast.error(e.message || 'Could not raise the requisition');
    } finally { setSaving(false); }
  };

  // Intercept when any item already has an active PR — confirmed with a reason.
  const submit = () => {
    const lines = form.lines.filter(l => l.material_id && +l.qty > 0);
    if (!lines.length) return toast.error('Add at least one item with a quantity');
    const dupes = lines
      .map(l => ({ line: l, existing: activePrsFor(l.material_id) }))
      .filter(d => d.existing.length);
    if (dupes.length) { setDupPr({ dupes, reason: '' }); return; }
    raise(body());
  };

  // A board created on the fly drops onto the line that asked for it.
  const handleCreated = async material => {
    const ms = await api.get('/materials').catch(() => materials);
    setMaterials(ms);
    const i = quickMat?.line ?? 0;
    setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i
      ? { ...l, material_id: String(material.id), unit: material.unit || '',
          est_rate: l.est_rate ? l.est_rate : (rateFor(material)?.rate != null ? String(rateFor(material).rate) : '') }
      : l)) }));
    setQuickMat(null);
  };

  return (<>
    <Modal open={open} onClose={() => { if (!quickMat) onClose(); }} title="New Purchase Requisition" wide
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={saving || !form?.lines.some(l => l.material_id && +l.qty > 0)} onClick={submit}>
          {saving ? 'Raising…' : 'Raise PR'}
        </Button>
      </>}>
      {form && <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Requested By"><Input value={form.requested_by} onChange={e => setForm({ ...form, requested_by: e.target.value })} /></Field>
          <Field label="Department"><Input value={form.department} placeholder="e.g. Planning, Stores"
            onChange={e => setForm({ ...form, department: e.target.value })} /></Field>
          <Field label="Needed By"><Input type="date" value={form.needed_by} onChange={e => setForm({ ...form, needed_by: e.target.value })} /></Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
              <option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option>
            </Select>
          </Field>
        </div>
        {/* Not every purchase answers a job. Replenishment buying needs no
            product, job card or customer order behind it. */}
        <Field label="Purpose" hint="Replenishment purchases need no order or job linkage">
          <Select value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })}>
            {PURPOSE_LABELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </Select>
        </Field>
        <PrLineEditor lines={form.lines} materials={materials} activePrsFor={activePrsFor}
          rateFor={rateFor} stockFor={stockFor}
          onChange={lines => setForm({ ...form, lines })}
          onQuickCreate={i => setQuickMat({ line: i })} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reason"><Textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field>
          <Field label="Remarks" hint="Internal note carried through to the PO stage">
            <Textarea value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </Field>
        </div>
      </div>}
    </Modal>

    {/* ── Duplicate PR confirmation (multi-item) ── */}
    <Modal open={!!dupPr} onClose={() => setDupPr(null)} title="Some items already have active requisitions"
      footer={<>
        <Button variant="secondary" onClick={() => setDupPr(null)}>No, Cancel</Button>
        <Button variant="danger" disabled={saving || !dupPr?.reason.trim()}
          onClick={() => raise(body({
            reraise_of: dupPr.dupes[0].existing[0].id, reraise_reason: dupPr.reason.trim(),
          }))}>
          Raise Anyway
        </Button>
      </>}>
      {dupPr && <div className="space-y-3">
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm font-semibold text-amber-800">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span><b>Warning:</b> {dupPr.dupes.length} item{dupPr.dupes.length > 1 ? 's' : ''} on this requisition
            already {dupPr.dupes.length > 1 ? 'have' : 'has'} an active PR. Confirm with a reason to raise anyway.</span>
        </p>
        <div className="space-y-1.5">
          {dupPr.dupes.map((d, i) => {
            const mat = materials.find(m => String(m.id) === String(d.line.material_id));
            return (
              <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                <span className="font-semibold text-slate-700">{mat?.name || `Material #${d.line.material_id}`} · {fmt.num(d.line.qty)}</span>
                <span className="text-slate-500">already on {d.existing.map(p => p.pr_number).join(', ')}</span>
              </div>
            );
          })}
        </div>
        <Field label="Reason for Re-raising" required>
          <Textarea value={dupPr.reason} placeholder="e.g. wastage on press, allocation adjustment, revised order quantity"
            onChange={e => setDupPr({ ...dupPr, reason: e.target.value })} />
        </Field>
      </div>}
    </Modal>

    <MaterialQuickCreate open={!!quickMat} onClose={() => setQuickMat(null)} onCreated={handleCreated} />
  </>);
}
