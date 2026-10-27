// Rates & method — the defaults a new costing starts from, the coating factors offered (with the
// plant's own names for them), the difference that raises an alert, and the method itself in plain
// words, so anyone can check a costing by hand. Admins change the rates; everyone can read them.
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Field, Input, useToast } from '../../components/ui.jsx';
import { coatingWords } from '../../lib/costingUi.js';
import { NumField } from './CostingEditor.jsx';

const DEFAULTS = [
  { key: 'wastage', label: 'Wastage sheets', unit: 'sheets' },
  { key: 'colours', label: 'Colours' },
  { key: 'print_rate', label: 'Printing rate', unit: '₹ per 1,000 sheets, per colour' },
  { key: 'print_min', label: 'Minimum printing charge', unit: '₹' },
  { key: 'process', label: 'Process charge', unit: '₹ for the job' },
  { key: 'dp_rate', label: 'Die & pasting', unit: '₹ per carton' },
  { key: 'emb_rate', label: 'Embossing', unit: '₹ per carton' },
  { key: 'pf_pct', label: 'P&F', unit: '%' },
  { key: 'misc_pct', label: 'Misc', unit: '%' },
  { key: 'margin', label: 'Quote margin', unit: '₹ per carton' },
];

const METHOD = [
  ['Sheets', 'quantity ÷ ups + wastage sheets'],
  ['Board', 'sheets × weight of one sheet × ₹ per kg. Weight of one sheet (kg) = sheet length × width (inches) × GSM ÷ 15,50,000'],
  ['Printing', 'sheets × colours × printing rate ÷ 1,000 — never less than the minimum printing charge'],
  ['Coating', 'sheets × (sheet length × width ÷ coating factor ÷ 100). Factor 6 means ₹1 for every 600 sq inches'],
  ['Die & pasting', 'quantity × ₹ per carton'],
  ['Process', 'the fixed charge for the job'],
  ['Subtotal', 'board + printing + coating + die & pasting + process'],
  ['P&F', 'P&F % of the subtotal'],
  ['Misc', 'misc % of (subtotal + P&F)'],
  ['Cost per carton', '(subtotal + P&F + misc) ÷ quantity + embossing per carton'],
  ['Quote price', 'cost per carton + quote margin'],
];

export default function CostingRates({ boot, onSaved }) {
  const toast = useToast();
  const canEdit = !!boot?.can_edit_rates;
  const [f, setF] = useState(null);
  useEffect(() => {
    const s = boot?.settings || {};
    setF({ defaults: { ...(s.defaults || {}) }, coatings: (s.coatings || []).map(c => ({ ...c })), alert_pct: s.alert_pct ?? 15 });
  }, [boot]);
  if (!f) return null;
  const setD = (k, v) => setF(x => ({ ...x, defaults: { ...x.defaults, [k]: v } }));
  const setC = (i, patch) => setF(x => ({ ...x, coatings: x.coatings.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const save = async () => {
    await api.put('/costing/settings', f);
    toast.success('Rates saved — new costings start from these');
    onSaved?.();
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form data-ci-form onSubmit={e => e.preventDefault()} className="ci-form-panel glass space-y-4 rounded-2xl p-4">
        <div>
          <h3 className="text-[15px] font-bold">Defaults for a new costing</h3>
          <p className="text-xs text-slate-500">{canEdit ? 'Every new costing starts with these; each costing can still change them.' : 'Only an admin can change these.'}</p>
        </div>
        <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
          {DEFAULTS.map(d => <NumField key={d.key} label={d.label} unit={d.unit} value={f.defaults[d.key]} onChange={v => setD(d.key, v)} />)}
        </fieldset>
        <div>
          <h3 className="text-[15px] font-bold">Coating choices</h3>
          <p className="text-xs text-slate-500">The cost sheet keeps coating as a factor (2, 3, 6…): ₹1 for every factor × 100 sq inches of sheet. Give each factor the name the plant uses, so the choice is obvious.</p>
          <fieldset disabled={!canEdit} className="mt-2 space-y-2">
            {f.coatings.map((c, i) => (
              <div key={i} className="flex items-end gap-2">
                <NumField className="w-28" label="Factor" value={c.factor} onChange={v => setC(i, { factor: v })} />
                <Field label="Name" className="flex-1"><Input value={c.name || ''} onChange={e => setC(i, { name: e.target.value })} placeholder="e.g. Aqueous varnish" /></Field>
                <span className="mb-2.5 w-36 text-xs text-slate-500">{coatingWords(c.factor)}</span>
                {canEdit && <button type="button" onClick={() => setF(x => ({ ...x, coatings: x.coatings.filter((_, j) => j !== i) }))} className="mb-1.5 rounded-md p-1.5 text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>}
              </div>
            ))}
            {canEdit && <Button size="sm" variant="secondary" onClick={() => setF(x => ({ ...x, coatings: [...x.coatings, { factor: '', name: '' }] }))}><Plus size={14} className="mr-1 inline" />Add a coating</Button>}
          </fieldset>
        </div>
        <fieldset disabled={!canEdit}>
          <NumField label="Alert when an earlier costing of the same carton differs by more than" unit="%" value={f.alert_pct} onChange={v => setF(x => ({ ...x, alert_pct: v }))} className="sm:w-1/2" />
        </fieldset>
        {canEdit && <Button onClick={save}>Save rates</Button>}
      </form>

      <div className="glass rounded-2xl p-4">
        <h3 className="text-[15px] font-bold">How a costing is worked out</h3>
        <p className="mb-3 text-xs text-slate-500">The plant's own cost sheet, step by step. Every costing shows these lines with its own numbers, so any figure can be checked by hand.</p>
        <ol className="space-y-1.5 text-sm">
          {METHOD.map(([k, v], i) => (
            <li key={k} className="flex gap-2"><span className="w-5 shrink-0 text-right font-bold text-slate-400">{i + 1}.</span><span><b>{k}</b> = {v}</span></li>
          ))}
        </ol>
        <h4 className="mt-4 text-sm font-bold">Rule versions</h4>
        <p className="mb-1 text-xs text-slate-500">A saved costing keeps the version it was worked out with, so an old quote always reworks to the same figures.</p>
        <ul className="space-y-1 text-xs text-slate-600">
          {(boot?.formulas || []).map(x => <li key={x.key}><b>{x.key}</b> — {x.label}{x.key === boot.current_formula ? ' (used for new costings)' : ''}</li>)}
        </ul>
      </div>
    </div>
  );
}
