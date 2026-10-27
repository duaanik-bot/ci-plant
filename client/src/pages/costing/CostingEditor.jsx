// One costing, top to bottom in plain words: who and what → size and sheet layout → board →
// printing and finishing → charges. The figures work out as you type (lib/costing.js, the cost
// sheet's own arithmetic); the server works them out again when the costing is saved.
//
// Beside the form: the result with every line of the working, then what the plant knows about this
// size — earlier costings (the closest one compared, with the reasons for any difference), the
// Size Library's layouts, and the dies in the Die Master. The library and the dies are shown apart:
// one does not imply the other.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, History, Lightbulb, Ruler, Search, Wrench } from 'lucide-react';
import { api } from '../../api.js';
import { Field, Input, Select, Textarea } from '../../components/ui.jsx';
import { computeCosting, parseSize, sizerProposals, num, styleLabel } from '../../lib/costing.js';
import { closestComparison, coatingLabel, perUnit, pct, plain, rankHistory, rupees, stillNeeded } from '../../lib/costingUi.js';

// ── small pieces ─────────────────────────────────────────────────────────────────────────────────
export function Step({ n, title, hint, children }) {
  return (
    <section className="ci-form-panel glass rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">{n}</span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-[#1D1D1F]">{title}</h3>
          {hint && <p className="text-xs text-slate-500">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

// A number box. Text, not type=number: "12,000" and a pasted "0.30 " must read as typed.
export function NumField({ label, unit, hint, value, onChange, placeholder, className = '' }) {
  return (
    <Field label={<>{label}{unit && <span className="font-normal text-slate-400"> · {unit}</span>}</>} hint={hint} className={className}>
      <Input inputMode="decimal" autoComplete="off" value={value ?? ''} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

const STYLE_OPTIONS = ['LOCK', 'SIDE', 'LIT', 'CUP', 'DBL PAS', 'DIE CUT', 'NONE'];

// ── the result ───────────────────────────────────────────────────────────────────────────────────
export function ResultCard({ result, missing = [] }) {
  if (!result?.ok) {
    return (
      <div className="glass rounded-2xl p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-700"><CircleDashed size={16} />Not worked out yet</div>
        <p className="text-sm text-slate-600">Fill in: <b>{(missing.length ? missing : result?.missing?.map(m => m.label) || []).join(', ')}</b>.</p>
      </div>
    );
  }
  const r = result;
  return (
    <div className="glass rounded-2xl p-4">
      {missing.length > 0 && (
        <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">Before saving, fill in: <b>{missing.join(', ')}</b>.</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Figure label="Cost per carton" value={perUnit(r.cost_per_unit)} strong />
        <Figure label="Quote price per carton" value={perUnit(r.quote_per_unit)} strong tone="blue" />
        <Figure label="Order value at cost" value={rupees(r.cost_value)} />
        <Figure label="Order value at quote" value={rupees(r.quote_value)} />
      </div>
      {r.target && (
        <div className={`mt-3 rounded-xl px-3 py-2 text-sm ${r.target.margin_per_unit < 0 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
          At the customer's target of {perUnit(r.target.price)}: margin {perUnit(r.target.margin_per_unit)} a carton ({pct(r.target.margin_pct)}).
        </div>
      )}
      {r.warnings.length > 0 && (
        <ul className="mt-3 space-y-1">
          {r.warnings.map((w, i) => (
            <li key={i} className="flex gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800"><AlertTriangle size={14} className="mt-px shrink-0" />{w.text}</li>
          ))}
        </ul>
      )}
      <Working lines={r.lines} />
    </div>
  );
}

function Figure({ label, value, strong, tone }) {
  return (
    <div className="rounded-xl bg-white/70 px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`${strong ? 'text-2xl' : 'text-lg'} font-extrabold tabular-nums ${tone === 'blue' ? 'text-brand-600' : 'text-[#1D1D1F]'}`}>{value}</div>
    </div>
  );
}

export function Working({ lines, title = 'How it was worked out' }) {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="overflow-hidden rounded-xl border border-slate-200/70 bg-white/80">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[11px] text-slate-500">
            <tr><th className="px-2.5 py-1.5 text-left font-semibold">Item</th><th className="px-2.5 py-1.5 text-right font-semibold">₹</th><th className="px-2.5 py-1.5 text-right font-semibold">a carton</th></tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.key} className={`border-t border-slate-100 align-top ${l.total ? 'bg-slate-50/80 font-bold' : ''}`}>
                <td className="px-2.5 py-1.5">
                  <div className="text-[#1D1D1F]">{l.label}</div>
                  <div className="font-normal leading-snug text-slate-500">{l.how}</div>
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums">{l.amount == null ? '' : plain(l.amount, 0)}</td>
                <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums">{l.per_unit == null ? '' : perUnit(l.per_unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── what the plant knows about this size ─────────────────────────────────────────────────────────
function useSizeCheck(sizeKey, excludeId) {
  const [state, setState] = useState({ key: null, data: null, loading: false });
  useEffect(() => {
    if (!sizeKey) { setState({ key: null, data: null, loading: false }); return undefined; }
    let live = true;
    setState(s => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.get(`/costing/size-check?size=${encodeURIComponent(sizeKey)}${excludeId ? `&exclude=${excludeId}` : ''}`)
        .then(data => { if (live) setState({ key: sizeKey, data, loading: false }); })
        .catch(() => { if (live) setState({ key: sizeKey, data: null, loading: false }); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [sizeKey, excludeId]);
  return state;
}

function Panel({ icon: Icon, title, children, tone }) {
  return (
    <div className={`rounded-2xl p-4 ${tone === 'warn' ? 'bg-amber-50/90 ring-1 ring-amber-200' : 'glass'}`}>
      <div className="mb-2 flex items-center gap-2 text-sm font-bold text-[#1D1D1F]"><Icon size={16} className="text-brand-600" />{title}</div>
      {children}
    </div>
  );
}
const SmallBtn = ({ onClick, children }) => (
  <button type="button" onClick={onClick} className="shrink-0 rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-brand-700">{children}</button>
);

export function SizeKnowledge({ value, result, onChange, excludeId, alertPct = 15, readOnly = false }) {
  const size = parseSize(value.size_text);
  const { data, loading } = useSizeCheck(size?.key, excludeId);
  if (!size) {
    return <Panel icon={Ruler} title="This size before"><p className="text-sm text-slate-500">Type the carton size to see earlier costings, sheet layouts and dies.</p></Panel>;
  }
  if (loading && !data) return <Panel icon={Ruler} title="This size before"><p className="text-sm text-slate-500">Checking {size.label}…</p></Panel>;
  const lib = data?.library || { exact: [], near: [] };
  const dies = data?.dies || { exact: [], near: [] };
  const history = data?.history || [];
  const applyLayout = e => onChange({
    style: e.style || value.style,
    inputs: { ...value.inputs, sheet_l: e.sheet_l ?? '', sheet_w: e.sheet_w ?? '', ups: e.ups ?? '' },
  });
  const cmp = closestComparison(value, result, history, alertPct);
  const ranked = rankHistory(value, history);
  return (
    <div className="space-y-4">
      {cmp && (
        <Panel icon={History} title="Against the closest earlier costing" tone={cmp.significant ? 'warn' : undefined}>
          <p className="text-sm text-slate-700">
            <b>{cmp.against.costing_no}</b> · {cmp.against.costed_on || 'no date'} · {cmp.against.customer_name || 'no customer'} · {plain(cmp.against.qty, 0)} cartons
          </p>
          <p className="mt-1 text-sm">
            {perUnit(cmp.then)} then → <b>{perUnit(cmp.now)}</b> now
            <span className={`ml-1.5 rounded-full px-2 py-0.5 text-xs font-bold ${cmp.significant ? 'bg-amber-200 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>{pct(cmp.delta_pct)}</span>
          </p>
          {cmp.significant && <p className="mt-1 text-xs font-semibold text-amber-800">More than {alertPct}% apart — read the reasons before quoting.</p>}
          {cmp.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
              {cmp.reasons.slice(0, 5).map(r => <li key={r.part}>{r.text}</li>)}
            </ul>
          )}
        </Panel>
      )}

      <Panel icon={History} title={`Costed before · ${size.label}`}>
        {lib.exact.length === 0 && history.length === 0 && (
          <p className="text-sm text-slate-600">A <b>new size</b> — never costed here.</p>
        )}
        {lib.exact.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs text-slate-500">Sheet layouts used for this size (most used first):</div>
            {lib.exact.map(e => (
              <div key={e.id} className="flex items-center justify-between gap-2 rounded-xl bg-white/70 px-2.5 py-1.5 text-xs">
                <span><b>{styleLabel(e.style)}</b> · {plain(e.sheet_l)} × {plain(e.sheet_w)} in · {plain(e.ups)} ups
                  <span className="text-slate-500"> — costed {e.times_costed}×{e.last_costed ? `, last ${e.last_costed}` : ''}</span></span>
                {!readOnly && <SmallBtn onClick={() => applyLayout(e)}>Use</SmallBtn>}
              </div>
            ))}
          </div>
        )}
        {lib.near.length > 0 && !readOnly && (
          <div className="mt-2 rounded-xl bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
            <b>Did you mean</b> {lib.near.slice(0, 4).map((e, i) => (
              <button key={e.id} type="button" className="font-bold underline underline-offset-2" onClick={() => onChange({ size_text: e.size_key })}>
                {i ? ', ' : ''}{e.size_key.replace(/x/g, ' × ')}
              </button>
            ))}? A size within 2 mm was costed before.
          </div>
        )}
        {ranked.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs text-slate-500">Earlier costings ({history.length}{history.length >= 40 ? '+' : ''}):</div>
            <div className="max-h-56 overflow-auto rounded-xl border border-slate-200/70 bg-white/80">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
                  <th className="px-2 py-1 text-left">Date · No.</th><th className="px-2 py-1 text-left">Customer</th>
                  <th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">GSM</th><th className="px-2 py-1 text-right">Cost</th><th className="px-2 py-1 text-right">vs now</th>
                </tr></thead>
                <tbody>
                  {ranked.slice(0, 12).map(h => {
                    const d = result?.ok && h.cost_per_unit ? (result.cost_per_unit - h.cost_per_unit) / h.cost_per_unit * 100 : null;
                    return (
                      <tr key={h.id} className={`border-t border-slate-100 ${h.comparable ? '' : 'text-slate-400'}`} title={h.why ? `Not compared: ${h.why}` : ''}>
                        <td className="px-2 py-1">{h.costed_on || '—'}<div className="text-slate-400">{h.costing_no}</div></td>
                        <td className="px-2 py-1">{h.customer_name || '—'}<div className="text-slate-400">{h.why || styleLabel(h.style)}</div></td>
                        <td className="px-2 py-1 text-right tabular-nums">{plain(h.qty, 0)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{plain(h.gsm, 0)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{perUnit(h.cost_per_unit)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{h.comparable ? pct(d) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>

      <Panel icon={Wrench} title="Die in the factory (Die Master)">
        {dies.exact.length > 0 ? (
          <ul className="space-y-1 text-xs">
            {dies.exact.map(d => (
              <li key={d.id} className="flex items-center gap-1.5"><CheckCircle2 size={13} className="text-emerald-600" />
                <b>{d.code}</b> · {d.carton_size} · {d.ups ?? '?'} ups{d.condition && d.condition !== 'Good' ? ` · ${d.condition}` : ''}
                {d.product_name ? <span className="text-slate-500"> · {d.product_name}</span> : null}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No die of this size in the Die Master — a new die would be needed.</p>
        )}
        {dies.near.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">Close: {dies.near.slice(0, 5).map(d => `${d.code} (${d.carton_size})`).join(', ')}</p>
        )}
      </Panel>

      {!readOnly && size.kind === 'carton' && lib.exact.length === 0 && (
        <SizeHelper size={size} onUse={p => onChange({ inputs: { ...value.inputs, sheet_l: +p.sheet_l.toFixed(2), sheet_w: +p.sheet_w.toFixed(2), ups: p.ups } })} />
      )}
    </div>
  );
}

// The cost sheet's Sizer tab: the smallest sheet for each layout of this carton.
function SizeHelper({ size, onUse }) {
  const rows = sizerProposals(size);
  return (
    <Panel icon={Lightbulb} title="Size helper (new size)">
      <p className="mb-2 text-xs text-slate-500">The smallest sheet each layout needs, by the cost sheet's Sizer. A starting point only — pick the next board size you can actually buy, and check with planning.</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {rows.map(p => (
          <button key={`${p.l_ups}x${p.w_ups}`} type="button" onClick={() => onUse(p)}
            className="rounded-xl bg-white/80 px-2 py-1.5 text-left text-xs ring-1 ring-slate-200 hover:ring-brand-400">
            <b>{p.ups} ups</b> <span className="text-slate-400">({p.l_ups}×{p.w_ups})</span>
            <div className="tabular-nums text-slate-600">{plain(p.sheet_l, 1)} × {plain(p.sheet_w, 1)} in</div>
          </button>
        ))}
      </div>
    </Panel>
  );
}

// ── copy from the Product Master ─────────────────────────────────────────────────────────────────
function ProductPicker({ onPick }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRows([]); return undefined; }
    let live = true;
    const t = setTimeout(() => api.get(`/costing/products?search=${encodeURIComponent(s)}`).then(r => live && setRows(r)).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return (
    <div className="mt-3 rounded-xl bg-slate-50/80 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-600"><Search size={13} />Start from a product we already make (optional)</div>
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Product name, code, size or customer…" />
      {rows.length > 0 && (
        <div className="mt-1.5 max-h-48 overflow-auto rounded-xl bg-white/90 ring-1 ring-slate-200">
          {rows.map(p => (
            <button key={p.id} type="button" onClick={() => { onPick(p); setQ(''); setRows([]); }}
              className="block w-full border-b border-slate-100 px-3 py-1.5 text-left text-xs last:border-0 hover:bg-brand-50">
              <b>{p.name}</b> <span className="text-slate-400">{p.code}</span>
              <div className="text-slate-500">{[p.customer_name, p.size, p.gsm && `${p.gsm} gsm`, p.sheet_l && p.sheet_w && `${p.sheet_l}×${p.sheet_w} in`, p.ups && `${p.ups} ups`].filter(Boolean).join(' · ')}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────────────────────────
export default function CostingEditor({ boot, customers = [], value, onChange, excludeId, hideProductStep = false }) {
  const inputs = value.inputs || {};
  const set = patch => onChange({ ...value, ...patch });
  const setIn = (key, v) => set({ inputs: { ...inputs, [key]: v } });
  const result = useMemo(() => computeCosting(inputs), [inputs]);
  const missing = stillNeeded(value);
  const settings = boot?.settings || { coatings: [], alert_pct: 15 };
  const grades = boot?.board_grades || [];

  // Size typed as three boxes; a whole "165x58x73" pasted into any box is split across them.
  const size = parseSize(value.size_text);
  const [dims, setDims] = useState(() => ({ l: size?.l ?? '', w: size?.w ?? '', h: size?.h ?? '' }));
  const lastText = useRef(value.size_text);
  useEffect(() => {
    if (value.size_text === lastText.current) return;
    lastText.current = value.size_text;
    const s = parseSize(value.size_text);
    setDims({ l: s?.l ?? '', w: s?.w ?? '', h: s?.h ?? '' });
  }, [value.size_text]);
  const setDim = (k, v) => {
    const whole = parseSize(v);
    const next = whole && whole.kind !== 'other' && /x|×|\*/i.test(String(v))
      ? { l: whole.l, w: whole.w, h: whole.h ?? '' }
      : { ...dims, [k]: v };
    setDims(next);
    const text = [next.l, next.w, next.h].map(x => String(x ?? '').trim()).filter(Boolean).join('x');
    lastText.current = text;
    set({ size_text: text });
  };

  const coatChoices = settings.coatings || [];
  const coatValue = value.coat_choice ?? '';
  const knownCoat = coatChoices.some(c => String(c.factor) === String(coatValue));
  const pickCoat = v => {
    if (v === 'none') set({ coat_choice: 'none', inputs: { ...inputs, coat_factor: '' } });
    else if (v === 'other') set({ coat_choice: 'other', inputs: { ...inputs, coat_factor: '' } });
    else set({ coat_choice: v, inputs: { ...inputs, coat_factor: v } });
  };

  const fromProduct = p => {
    const grade = grades.find(g => g.grade.toLowerCase() === String(p.board_grade || '').toLowerCase());
    const style = /lock/i.test(p.pasting_type || '') ? 'LOCK' : value.style;
    set({
      product_id: p.id, product_name: value.product_name || p.name,
      customer_id: value.customer_id || p.customer_id, customer_name: value.customer_name || p.customer_name,
      size_text: parseSize(p.size)?.key || value.size_text, style,
      inputs: {
        ...inputs, gsm: p.gsm ?? inputs.gsm, sheet_l: p.sheet_l ?? inputs.sheet_l, sheet_w: p.sheet_w ?? inputs.sheet_w,
        ups: p.ups ?? inputs.ups, colours: p.colors ?? inputs.colours, board_rate: grade ? grade.rate_per_kg : inputs.board_rate,
      },
      from_product_note: [p.coating && `Product Master coating: ${p.coating}`, p.board_grade && `board ${p.board_grade}`].filter(Boolean).join(' · '),
    });
  };

  const pickCustomer = name => {
    const hit = customers.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    set({ customer_name: name, customer_id: hit ? hit.id : null });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <form data-ci-form className="min-w-0 space-y-4" onSubmit={e => e.preventDefault()}>
        {!hideProductStep && (
          <Step n={1} title="Customer and product" hint="Who it is for and what it is. Pick a customer from the list, or type a new one.">
            <div className="ci-form-grid grid gap-3 sm:grid-cols-2">
              <Field label="Customer">
                <Input list="costing-customers" value={value.customer_name || ''} onChange={e => pickCustomer(e.target.value)} placeholder="Customer name" />
                <datalist id="costing-customers">{customers.map(c => <option key={c.id} value={c.name} />)}</datalist>
              </Field>
              <Field label="Product name" required>
                <Input value={value.product_name || ''} onChange={e => set({ product_name: e.target.value })} placeholder="e.g. Tablet carton 10×10" />
              </Field>
              <NumField label="Quantity" unit="cartons" value={inputs.qty} onChange={v => setIn('qty', v)} placeholder="e.g. 10000" />
            </div>
            <ProductPicker onPick={fromProduct} />
            {value.from_product_note && <p className="mt-2 text-xs text-slate-500">{value.from_product_note}</p>}
          </Step>
        )}

        <Step n={hideProductStep ? 1 : 2} title="Carton size and sheet layout" hint="Carton size in mm (length × width × height; leave height blank for a leaflet or label). Then the print sheet in inches and how many cartons fit on it.">
          <div className="grid grid-cols-3 gap-2 sm:max-w-md">
            <NumField label="Length" unit="mm" value={dims.l} onChange={v => setDim('l', v)} placeholder="165" />
            <NumField label="Width" unit="mm" value={dims.w} onChange={v => setDim('w', v)} placeholder="58" />
            <NumField label="Height" unit="mm" value={dims.h} onChange={v => setDim('h', v)} placeholder="73" />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="Pasting">
              <Select value={value.style || ''} onChange={e => set({ style: e.target.value || null })} placeholder="Choose…">
                <option value="">Not set</option>
                {STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
              </Select>
            </Field>
            <NumField label="Sheet length" unit="inch" value={inputs.sheet_l} onChange={v => setIn('sheet_l', v)} placeholder="18" />
            <NumField label="Sheet width" unit="inch" value={inputs.sheet_w} onChange={v => setIn('sheet_w', v)} placeholder="23" />
            <NumField label="Ups" unit="cartons a sheet" value={inputs.ups} onChange={v => setIn('ups', v)} placeholder="4" />
          </div>
          <p className="mt-2 text-xs text-slate-500">Tip: if this size was costed before, press <b>Use</b> beside its layout on the right.</p>
        </Step>

        <Step n={hideProductStep ? 2 : 3} title="Board" hint="Pick the board grade to fill in today's ₹ per kg from Board Rates, or type the rate.">
          <div className="grid gap-3 sm:grid-cols-4">
            <NumField label="GSM" value={inputs.gsm} onChange={v => setIn('gsm', v)} placeholder="300" hint="Usually 300–350" />
            <Field label="Board grade" className="sm:col-span-2">
              <Select value={value.board_grade || ''} placeholder="Choose a grade…"
                onChange={e => {
                  const g = grades.find(x => x.grade === e.target.value);
                  set({ board_grade: e.target.value, inputs: { ...inputs, board_rate: g ? g.rate_per_kg : inputs.board_rate } });
                }}>
                <option value="">— type the rate instead —</option>
                {grades.map(g => <option key={g.grade} value={g.grade}>{g.grade} — ₹{plain(g.rate_per_kg)}/kg</option>)}
              </Select>
            </Field>
            <NumField label="Board rate" unit="₹ per kg" value={inputs.board_rate} onChange={v => setIn('board_rate', v)} placeholder="95" />
            <NumField label="Wastage sheets" unit="sheets" value={inputs.wastage} onChange={v => setIn('wastage', v)} hint="Extra sheets for setting. Usually 250–300." />
          </div>
        </Step>

        <Step n={hideProductStep ? 3 : 4} title="Printing and finishing">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumField label="Colours" value={inputs.colours} onChange={v => setIn('colours', v)} hint="Usually 4" />
            <NumField label="Printing rate" unit="₹ per 1,000 sheets, per colour" value={inputs.print_rate} onChange={v => setIn('print_rate', v)} hint="Usually ₹400" />
            <NumField label="Minimum printing charge" unit="₹" value={inputs.print_min} onChange={v => setIn('print_min', v)} hint="Small runs pay at least this" />
            <Field label={<>Coating <span className="text-brand-500">*</span></>} className="sm:col-span-2" hint={num(inputs.coat_factor) > 0 && num(inputs.sheet_l) > 0 && num(inputs.sheet_w) > 0
              ? `= ${perUnit(num(inputs.sheet_l) * num(inputs.sheet_w) / num(inputs.coat_factor) / 100)} a sheet of ${plain(num(inputs.sheet_l))} × ${plain(num(inputs.sheet_w))} in` : 'Choose one — “No coating” is a choice too.'}>
              <Select value={knownCoat || coatValue === 'none' || coatValue === 'other' ? coatValue : (coatValue ? 'other' : '')}
                onChange={e => pickCoat(e.target.value)} placeholder="Choose the coating…">
                <option value="">Choose…</option>
                <option value="none">No coating</option>
                {coatChoices.map(c => <option key={c.factor} value={String(c.factor)}>{coatingLabel(c)}</option>)}
                <option value="other">Another rate…</option>
              </Select>
            </Field>
            {(coatValue === 'other' || (coatValue && !knownCoat && coatValue !== 'none')) && (
              <NumField label="Coating factor" unit="₹1 per factor × 100 sq in" value={inputs.coat_factor}
                onChange={v => set({ coat_choice: 'other', inputs: { ...inputs, coat_factor: v } })} placeholder="6" />
            )}
            <NumField label="Die & pasting" unit="₹ per carton" value={inputs.dp_rate} onChange={v => setIn('dp_rate', v)} hint="Usually ₹0.20–0.40" />
            <NumField label="Embossing" unit="₹ per carton" value={inputs.emb_rate} onChange={v => setIn('emb_rate', v)} hint="Blank if none" />
            <NumField label="Process charge" unit="₹ for the job" value={inputs.process} onChange={v => setIn('process', v)} hint="Fixed per order. Usually ₹1,500–2,000" />
          </div>
        </Step>

        <Step n={hideProductStep ? 4 : 5} title="Charges and price">
          <div className="grid gap-3 sm:grid-cols-4">
            <NumField label="P&F" unit="%" value={inputs.pf_pct} onChange={v => setIn('pf_pct', v)} hint="Usually 5" />
            <NumField label="Misc" unit="%" value={inputs.misc_pct} onChange={v => setIn('misc_pct', v)} hint="Usually blank" />
            <NumField label="Quote margin" unit="₹ per carton" value={inputs.margin} onChange={v => setIn('margin', v)} hint="Added to cost for the quote" />
            <NumField label="Customer's target price" unit="₹ per carton" value={inputs.target_price} onChange={v => setIn('target_price', v)} hint="Optional" />
          </div>
          {!hideProductStep && (
            <Field label="Remarks" className="mt-3">
              <Textarea value={value.remarks || ''} onChange={e => set({ remarks: e.target.value })} placeholder="Anything the next person should know" />
            </Field>
          )}
        </Step>
      </form>

      <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
        <ResultCard result={result} missing={missing} />
        <SizeKnowledge value={value} result={result} onChange={patch => set(patch)} excludeId={excludeId} alertPct={settings.alert_pct || 15} />
      </div>
    </div>
  );
}
