// New costing — one product. Opens blank (the Rates tab's defaults), on a saved costing to revise it
// (?id=), or as a copy of any costing — an old cost-sheet row included — to cost it again (?from=).
// A saved costing keeps every revision; "What changed?" is written beside each one. A complete costing
// is approved by a login with the Management right; changing its figures sends it back to Draft, and the
// quotation of a Draft costing is stamped DRAFT. A size + pasting + layout new to the Size Library joins
// it only on a yes: the form asks, and saving asks if that went unanswered.
import { useEffect, useState } from 'react';
import { BadgeCheck, FilePlus2, RotateCcw, Save } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ExportMenu, Input, Modal, useToast } from '../../components/ui.jsx';
import { computeCosting, num, parseSize } from '../../lib/costing.js';
import { batchExportSpec, blankValue, costingExportSpec, libraryDeclined, newLibraryEntry, savePayload, stillNeeded, valueFromSaved } from '../../lib/costingUi.js';
import CostingEditor from './CostingEditor.jsx';

// What the page remembers about a saved costing.
const meta = c => ({ id: c.id, costing_no: c.costing_no, version: c.version, complete: c.complete, status: c.status,
  approved_by_name: c.approved_by_name, approved_at: c.approved_at, approved_version: c.approved_version });

export function ApprovalChip({ c }) {
  if (!c) return null;
  if (c.status === 'approved') {
    return (
      <span title={`Revision ${c.approved_version} approved by ${c.approved_by_name} on ${c.approved_at}`}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
        <BadgeCheck size={12} />Approved · {c.approved_by_name}
      </span>
    );
  }
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">Draft — not approved</span>;
}

export default function SingleCosting({ boot, customers, openId, fromId, startSize, onSaved, onFresh }) {
  const toast = useToast();
  const defaults = boot?.settings?.defaults || {};
  const [value, setValue] = useState(() => blankValue(defaults, startSize));
  const [saved, setSaved] = useState(null);       // meta() once saved / opened
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(null);     // the library entry put to the user on saving
  const [saves, setSaves] = useState(0);          // the editor looks the size up again after each save

  useEffect(() => {
    const id = openId || fromId;
    if (!id) { setValue(blankValue(defaults, startSize)); setSaved(null); setDirty(false); return undefined; }
    let live = true;
    setLoading(true);
    api.get(`/costing/costings/${id}`).then(c => {
      if (!live) return;
      const editable = openId && c.source === 'erp';
      // As saved: nothing is re-suggested until the product or the size is changed.
      setValue({ ...valueFromSaved(c, { asNew: !editable }), autofill: false });
      setSaved(editable ? meta(c) : null);
      setDirty(!editable);
      if (openId && !editable) toast.info(`${c.costing_no} is from the old cost sheet — opened as a new costing to cost again.`);
    }).catch(() => {}).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, fromId, startSize]);

  const change = v => { setValue(v); setDirty(true); };
  const missing = stillNeeded(value);
  const canSave = !!value.product_name?.trim();
  const result = computeCosting(value.inputs);

  const store = async v => {
    const body = savePayload(v, note.trim());
    const c = saved
      ? await api.put(`/costing/costings/${saved.id}`, body)
      : await api.post('/costing/costings', body);
    setSaved(meta(c));
    setDirty(false);
    setNote('');
    toast.success(saved
      ? (c.version > saved.version ? `${c.costing_no} saved as revision ${c.version}${saved.status === 'approved' ? ' — back to Draft for approval' : ''}` : `${c.costing_no} saved`)
      : `Saved as ${c.costing_no}${c.complete ? '' : ' (incomplete — open it again to finish)'}`);
    setSaves(n => n + 1);
    onSaved?.(c);
  };

  // Only a complete costing can add to the library. The look-up failing never stops a save.
  const save = async () => {
    const size = parseSize(value.size_text);
    let entry = null;
    if (size && result.ok && !libraryDeclined(value)) {
      try {
        const check = await api.get(`/costing/size-check?size=${encodeURIComponent(size.key)}`);
        entry = newLibraryEntry(value, check.library?.exact);
      } catch { entry = null; }
    }
    if (entry) setAsking(entry);
    else await store(value);
  };

  const answer = async yes => {
    const v = yes ? value : { ...value, skip_library: asking.key };
    setValue(v);
    await store(v);
    setAsking(null);
  };

  const approve = async () => {
    const c = await api.post(`/costing/costings/${saved.id}/approve`, {});
    setSaved(meta(c));
    toast.success(`${c.costing_no} approved`);
    onSaved?.(c);
  };

  const fresh = () => { setValue(blankValue(defaults)); setSaved(null); setNote(''); setDirty(false); onFresh?.(); };
  // The quotation prices the quantity entered, and any others chosen under "Price at other quantities".
  const quoteQuantities = [...new Set([num(value.inputs?.qty), ...(value.quantities || [])].filter(q => q > 0))];
  const approved = saved?.status === 'approved' && !dirty;

  if (loading) return <div className="p-8 text-sm text-slate-400">Opening the costing…</div>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#1D1D1F]">
            {saved ? <span>Editing <span className="text-brand-600">{saved.costing_no}</span> · revision {saved.version}</span> : 'New costing'}
            {saved && <ApprovalChip c={saved} />}
            {dirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Not saved</span>}
          </div>
          {missing.length > 0 && <div className="text-xs text-slate-500">Still to fill in: {missing.join(', ')}</div>}
        </div>
        {saved && dirty && (
          <Input className="!h-9 w-64" value={note} onChange={e => setNote(e.target.value)} placeholder="What changed? (kept with the revision)" />
        )}
        <Button onClick={save} disabled={!canSave || (!dirty && !!saved)}><Save size={15} className="mr-1.5 inline" />{saved ? 'Save revision' : 'Save costing'}</Button>
        {boot?.can_approve && saved && saved.status !== 'approved' && (
          <Button variant="success" onClick={approve} disabled={dirty || !saved.complete}
            title={dirty ? 'Save the changes first' : !saved.complete ? 'Fill it in completely first' : 'Approve these figures for quotation'}>
            <BadgeCheck size={15} className="mr-1.5 inline" />Approve
          </Button>
        )}
        <ExportMenu label="Export (internal)" build={() => costingExportSpec({ ...value, ...(saved || {}), formula: boot?.current_formula, result })} />
        {/* For the customer: product, size and the quote price at each quantity — no internal cost. */}
        <ExportMenu label="Quotation" build={() => batchExportSpec({ batch_no: saved?.costing_no, customer_name: value.customer_name },
          [{ product_name: value.product_name, size_text: value.size_text, inputs: value.inputs }],
          { customer: true, quantities: quoteQuantities.length > 1 ? quoteQuantities : [], draft: !approved })} />
        <Button variant="secondary" onClick={fresh}>{saved ? <><FilePlus2 size={15} className="mr-1.5 inline" />New costing</> : <><RotateCcw size={15} className="mr-1.5 inline" />Start over</>}</Button>
      </div>
      <CostingEditor boot={boot} customers={customers} value={value} onChange={change} excludeId={saved?.id} askLibrary recheck={saves} />
      <Modal open={!!asking} onClose={() => setAsking(null)} title={asking?.new_size ? 'Save this new size to the Size Library?' : 'Save this new layout to the Size Library?'}
        footer={<><Button variant="secondary" onClick={() => answer(false)}>No, only the costing</Button><Button onClick={() => answer(true)}>Yes, save it</Button></>}>
        <p className="text-sm font-bold text-[#1D1D1F]">{asking?.text}</p>
        <p className="mt-1 text-sm text-slate-600">The next costing of this size will offer this sheet and ups.</p>
      </Modal>
    </div>
  );
}
