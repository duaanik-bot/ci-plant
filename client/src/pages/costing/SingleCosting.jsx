// New costing — one product. Opens blank (the Rates tab's defaults), on a saved costing to revise it
// (?id=), or as a copy of any costing — an old cost-sheet row included — to cost it again (?from=).
// A saved costing keeps every revision; "What changed?" is written beside each one.
import { useEffect, useState } from 'react';
import { FilePlus2, RotateCcw, Save } from 'lucide-react';
import { api } from '../../api.js';
import { Button, ExportMenu, Input, useToast } from '../../components/ui.jsx';
import { computeCosting } from '../../lib/costing.js';
import { batchExportSpec, blankValue, costingExportSpec, savePayload, stillNeeded, valueFromSaved } from '../../lib/costingUi.js';
import CostingEditor from './CostingEditor.jsx';

export default function SingleCosting({ boot, customers, openId, fromId, startSize, onSaved, onFresh }) {
  const toast = useToast();
  const defaults = boot?.settings?.defaults || {};
  const [value, setValue] = useState(() => blankValue(defaults, startSize));
  const [saved, setSaved] = useState(null);       // { id, costing_no, version } once saved / opened
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const id = openId || fromId;
    if (!id) { setValue(blankValue(defaults, startSize)); setSaved(null); setDirty(false); return undefined; }
    let live = true;
    setLoading(true);
    api.get(`/costing/costings/${id}`).then(c => {
      if (!live) return;
      const editable = openId && c.source === 'erp';
      setValue(valueFromSaved(c, { asNew: !editable }));
      setSaved(editable ? { id: c.id, costing_no: c.costing_no, version: c.version } : null);
      setDirty(!editable);
      if (openId && !editable) toast.info(`${c.costing_no} is from the old cost sheet — opened as a new costing to cost again.`);
    }).catch(() => {}).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, fromId, startSize]);

  const change = v => { setValue(v); setDirty(true); };
  const missing = stillNeeded(value);
  const canSave = !!value.product_name?.trim();

  const save = async () => {
    const body = savePayload(value, note.trim());
    const c = saved
      ? await api.put(`/costing/costings/${saved.id}`, body)
      : await api.post('/costing/costings', body);
    setSaved({ id: c.id, costing_no: c.costing_no, version: c.version });
    setDirty(false);
    setNote('');
    toast.success(saved
      ? (c.version > saved.version ? `${c.costing_no} saved as revision ${c.version}` : `${c.costing_no} saved`)
      : `Saved as ${c.costing_no}${c.complete ? '' : ' (incomplete — open it again to finish)'}`);
    onSaved?.(c);
  };

  const fresh = () => { setValue(blankValue(defaults)); setSaved(null); setNote(''); setDirty(false); onFresh?.(); };

  if (loading) return <div className="p-8 text-sm text-slate-400">Opening the costing…</div>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <div className="text-sm font-bold text-[#1D1D1F]">
            {saved ? <>Editing <span className="text-brand-600">{saved.costing_no}</span> · revision {saved.version}</> : 'New costing'}
            {dirty && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Not saved</span>}
          </div>
          {missing.length > 0 && <div className="text-xs text-slate-500">Still to fill in: {missing.join(', ')}</div>}
        </div>
        {saved && dirty && (
          <Input className="!h-9 w-64" value={note} onChange={e => setNote(e.target.value)} placeholder="What changed? (kept with the revision)" />
        )}
        <Button onClick={save} disabled={!canSave || (!dirty && !!saved)}><Save size={15} className="mr-1.5 inline" />{saved ? 'Save revision' : 'Save costing'}</Button>
        <ExportMenu label="Export (internal)" build={() => costingExportSpec({ ...value, ...(saved || {}), formula: boot?.current_formula, result: computeCosting(value.inputs) })} />
        {/* For the customer: product, size, quantity and the quote price — no internal cost. */}
        <ExportMenu label="Quotation" build={() => batchExportSpec({ batch_no: saved?.costing_no, customer_name: value.customer_name },
          [{ product_name: value.product_name, size_text: value.size_text, inputs: value.inputs }], { customer: true })} />
        <Button variant="secondary" onClick={fresh}>{saved ? <><FilePlus2 size={15} className="mr-1.5 inline" />New costing</> : <><RotateCcw size={15} className="mr-1.5 inline" />Start over</>}</Button>
      </div>
      <CostingEditor boot={boot} customers={customers} value={value} onChange={change} excludeId={saved?.id} />
    </div>
  );
}
