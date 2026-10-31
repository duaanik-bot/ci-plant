// One costing, short and plain: Product & quantity → Carton → Print & finish, with the rates and
// charges folded under "More settings". Picking a product fills the rest — from the Product Master, the
// Size Library, today's Board Rates, the last costing of that product or size, and the figures typical
// in the plant's own costings (lib/costingUi.js recommend). Every box shows where its value came from;
// anything typed is the user's and is never overwritten.
//
// The figures work out as you type (lib/costing.js, the cost sheet's own arithmetic); the server works
// them out again on save. Beside the form: the result, set-up against running cost, the same costing at
// other quantities, the closest earlier costing with the reasons for any difference, and the dies of the
// size — the Size Library and the Die Master shown apart (one does not imply the other).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BookmarkPlus, CheckCircle2, ChevronDown, CircleDashed, History, Info, Layers, Lightbulb, Plus, Ruler, Search,
  SlidersHorizontal, Sparkles, TrendingDown, Wrench, X,
} from 'lucide-react';
import { api } from '../../api.js';
import { Button, Field, Input, Select, Textarea, useToast } from '../../components/ui.jsx';
import { computeCosting, parseSize, sizerProposals, num, styleLabel, quantityBreaks, suggestQuantities } from '../../lib/costing.js';
import {
  SOURCES, closestComparison, coatingChoices, coatingRate, layoutOptions, libraryDeclined, markEdited, newLibraryEntry, perUnit, pct, plain,
  rankHistory, recommend, rupees, stillNeeded,
} from '../../lib/costingUi.js';

// ── small pieces ─────────────────────────────────────────────────────────────────────────────────
export function Card({ icon: Icon, title, hint, children, className = '' }) {
  return (
    <section className={`ci-form-panel glass rounded-2xl p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-start gap-2.5">
        {Icon && <Icon size={18} className="mt-0.5 shrink-0 text-brand-600" />}
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold text-[#1D1D1F]">{title}</h3>
          {hint && <p className="text-xs text-slate-500">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

const TAG_TONE = {
  auto: 'bg-brand-50 text-brand-700 ring-brand-200',
  typical: 'bg-teal-50 text-teal-700 ring-teal-200',
  default: 'bg-slate-100 text-slate-500 ring-slate-200',
  manual: 'bg-amber-50 text-amber-800 ring-amber-200',
};
// Where a value came from, beside its label: blue = filled from the ERP, teal = typical, grey =
// default, amber = typed here.
export function SourceTag({ source }) {
  const def = source && SOURCES[source.kind];
  if (!def) return null;
  return (
    <span title={`${def.label}${source.note ? ` — ${source.note}` : ''}`}
      className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-px align-middle text-[10px] font-semibold ring-1 ${TAG_TONE[def.tone]}`}>
      {def.short}
    </span>
  );
}

function Label({ label, unit, help, source }) {
  return (
    <>
      {label}{unit && <span className="font-normal text-slate-400"> · {unit}</span>}
      {help && <span title={help} className="ml-1 inline-flex cursor-help align-middle text-slate-400"><Info size={12} /></span>}
      <SourceTag source={source} />
    </>
  );
}

// A number box. Text, not type=number: "12,000" and a pasted "0.30 " must read as typed.
export function NumField({ label, unit, hint, help, source, value, onChange, placeholder, className = '' }) {
  return (
    <Field label={<Label label={label} unit={unit} help={help} source={source} />} hint={hint} className={className}>
      <Input inputMode="decimal" autoComplete="off" value={value ?? ''} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </Field>
  );
}

const STYLE_OPTIONS = ['LOCK', 'SIDE', 'LIT', 'CUP', 'DBL PAS', 'DIE CUT', 'NONE'];

// ── the result ───────────────────────────────────────────────────────────────────────────────────
export function ResultCard({ result, missing = [], showWorking: open = false }) {
  const [showWorking, setShowWorking] = useState(open);
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
      {r.split && (
        <div className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-xs text-slate-600">
          <div className="mb-1 flex h-2 overflow-hidden rounded-full bg-slate-200">
            <span className="bg-brand-500" style={{ width: `${Math.max(2, r.split.fixed / r.cost_value * 100)}%` }} />
          </div>
          <b className="text-brand-700">Set-up {rupees(r.split.fixed)}</b> — the same whatever the quantity (wastage sheets, process, minimum printing)
          {' · '}<b>Running {perUnit(r.split.running_per_unit)}</b> a carton
        </div>
      )}
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
      <button type="button" onClick={() => setShowWorking(!showWorking)}
        className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:underline">
        <ChevronDown size={14} className={`transition ${showWorking ? 'rotate-180' : ''}`} />{showWorking ? 'Hide the working' : 'Show how it was worked out'}
      </button>
      {showWorking && <Working lines={r.lines} />}
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
    <div className="mt-3">
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

// The same costing at other quantities — set-up spread over more or fewer cartons. Quantities start as
// suggestions around the one entered; add or remove any.
export function QuantityCard({ inputs, quantities, onQuantities }) {
  const [adding, setAdding] = useState('');
  const qty = num(inputs?.qty);
  const list = quantities?.length ? quantities : suggestQuantities(qty);
  const rows = useMemo(() => quantityBreaks(inputs, [...list, qty].filter(Boolean)), [inputs, list, qty]);
  if (!rows.some(r => r.ok)) return null;
  const here = rows.find(r => r.qty === qty && r.ok);
  const add = () => {
    const n = num(adding);
    if (n > 0) onQuantities([...new Set([...list, n])].sort((a, b) => a - b));
    setAdding('');
  };
  return (
    <div className="glass rounded-2xl p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-bold"><TrendingDown size={16} className="text-brand-600" />Price at other quantities</div>
      <table className="w-full text-xs">
        <thead className="text-[11px] text-slate-500">
          <tr><th className="py-1 text-left">Quantity</th><th className="py-1 text-right">Cost a carton</th><th className="py-1 text-right">Quote</th><th className="py-1 text-right">Order value</th><th className="py-1 text-right">vs yours</th><th /></tr>
        </thead>
        <tbody>
          {rows.filter(r => r.ok).map(r => (
            <tr key={r.qty} className={`border-t border-slate-100 ${r.qty === qty ? 'bg-brand-50/70 font-bold' : ''}`}>
              <td className="py-1">{plain(r.qty, 0)}{r.qty === qty && <span className="ml-1 text-[10px] text-brand-600">yours</span>}</td>
              <td className="py-1 text-right tabular-nums">{perUnit(r.cost_per_unit)}</td>
              <td className="py-1 text-right tabular-nums text-brand-700">{perUnit(r.quote_per_unit)}</td>
              <td className="py-1 text-right tabular-nums">{rupees(r.cost_value)}</td>
              <td className="py-1 text-right tabular-nums">{here && r.qty !== qty ? pct((r.cost_per_unit - here.cost_per_unit) / here.cost_per_unit * 100) : ''}</td>
              <td className="py-1 text-right">{r.qty !== qty && (
                <button type="button" title="Remove" onClick={() => onQuantities(list.filter(x => x !== r.qty))} className="text-slate-400 hover:text-red-500"><X size={12} /></button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-2">
        <Input className="!h-8 !w-28 text-xs" inputMode="decimal" value={adding} placeholder="Add a quantity"
          onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" onClick={add} className="rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-bold text-white">Add</button>
        <span className="text-[11px] text-slate-500">Set-up {rupees(here?.setup ?? rows.find(r => r.ok)?.setup)} is spread over each quantity.</span>
      </div>
    </div>
  );
}

// ── what the plant knows about this size ─────────────────────────────────────────────────────────
// `again` looks the size up afresh when it changes (after a save added to the library).
export function useSizeCheck(sizeKey, excludeId, again) {
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
  }, [sizeKey, excludeId, again]);
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

export function SizeKnowledge({ value, result, onChange, excludeId, alertPct = 15, readOnly = false, check: given }) {
  const size = parseSize(value.size_text);
  const own = useSizeCheck(given ? null : size?.key, excludeId);
  const { data, loading } = given || own;
  if (!size) {
    return <Panel icon={Ruler} title="This size before"><p className="text-sm text-slate-500">Type the carton size (or pick a product) to see earlier costings and dies.</p></Panel>;
  }
  if (loading && !data) return <Panel icon={Ruler} title="This size before"><p className="text-sm text-slate-500">Checking {size.label}…</p></Panel>;
  const lib = data?.library || { exact: [], near: [] };
  const dies = data?.dies || { exact: [], near: [] };
  const history = data?.history || [];
  const cmp = closestComparison(value, result, history, alertPct);
  const ranked = rankHistory(value, history);
  return (
    <div className="space-y-4">
      {cmp && (
        <Panel icon={History} title="Against the closest earlier costing" tone={cmp.significant ? 'warn' : undefined}>
          <p className="text-sm text-slate-700">
            <b>{cmp.against.costing_no}</b> · {cmp.against.costed_on || 'no date'} · {cmp.against.customer_name || 'no customer'} · {plain(cmp.against.qty, 0)} cartons
          </p>
          {cmp.like_for_like ? (
            <>
              <p className="mt-1 text-sm">
                At their {plain(cmp.against.qty, 0)} cartons: {perUnit(cmp.like_for_like.then)} then → <b>{perUnit(cmp.like_for_like.now)}</b> now
                <span className={`ml-1.5 rounded-full px-2 py-0.5 text-xs font-bold ${cmp.significant ? 'bg-amber-200 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>{pct(cmp.like_for_like.delta_pct)}</span>
              </p>
              <p className="text-xs text-slate-500">At your {plain(num(value.inputs?.qty), 0)} cartons it is {perUnit(cmp.now)} ({pct(cmp.delta_pct)}) — the rest is the quantity.</p>
            </>
          ) : (
            <p className="mt-1 text-sm">
              {perUnit(cmp.then)} then → <b>{perUnit(cmp.now)}</b> now
              <span className={`ml-1.5 rounded-full px-2 py-0.5 text-xs font-bold ${cmp.significant ? 'bg-amber-200 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>{pct(cmp.delta_pct)}</span>
            </p>
          )}
          {cmp.significant && <p className="mt-1 text-xs font-semibold text-amber-800">More than {alertPct}% apart at the same quantity — read the reasons before quoting.</p>}
          {(cmp.like_for_like || cmp).reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-600">
              {(cmp.like_for_like || cmp).reasons.slice(0, 5).map(r => <li key={r.part}>{r.text}</li>)}
            </ul>
          )}
        </Panel>
      )}

      <Panel icon={History} title={`Costed before · ${size.label}`}>
        {lib.exact.length === 0 && history.length === 0 && <p className="text-sm text-slate-600">A <b>new size</b> — never costed here.</p>}
        {lib.near.length > 0 && !readOnly && (
          <div className="mb-2 rounded-xl bg-amber-50 px-2.5 py-2 text-xs text-amber-900">
            <b>Did you mean</b> {lib.near.slice(0, 4).map((e, i) => (
              <button key={e.id} type="button" className="font-bold underline underline-offset-2" onClick={() => onChange({ size_text: e.size_key, _edited: ['size_text'] })}>
                {i ? ', ' : ''}{e.size_key.replace(/x/g, ' × ')}
              </button>
            ))}? A size within 2 mm was costed before.
          </div>
        )}
        {ranked.length > 0 ? (
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
        ) : lib.exact.length > 0 && <p className="text-xs text-slate-500">In the Size Library, not yet costed.</p>}
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
        ) : <p className="text-sm text-slate-600">No die of this size in the Die Master — a new die would be needed.</p>}
        {dies.near.length > 0 && <p className="mt-2 text-xs text-slate-500">Close: {dies.near.slice(0, 5).map(d => `${d.code} (${d.carton_size})`).join(', ')}</p>}
      </Panel>
    </div>
  );
}

// ── the sheet layout ─────────────────────────────────────────────────────────────────────────────
// The Size Library's layouts for this size, each priced as entered: the recommended one (most used) is
// chosen for you, the cheapest is flagged, and "Another sheet" opens the boxes to type one.
function LayoutChooser({ value, entries, size, onPick, setIn, src }) {
  const inputs = value.inputs;
  const opts = useMemo(() => layoutOptions(value, entries), [value, entries]);
  const sameSheet = o => num(inputs.sheet_l) === num(o.sheet_l) && num(inputs.sheet_w) === num(o.sheet_w) && num(inputs.ups) === num(o.ups);
  // One option lights up: the same sheet and ups, the same pasting first.
  const chosen = opts.find(o => sameSheet(o) && (o.style || null) === (value.style || null)) || opts.find(sameSheet);
  const matches = o => chosen && o.id === chosen.id;
  const [typing, setTyping] = useState(false);
  const own = typing || !chosen;
  return (
    <div>
      {opts.length > 0 && (
        <div className="space-y-1.5">
          {opts.map(o => (
            <button key={o.id} type="button" onClick={() => { setTyping(false); onPick(o); }}
              className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs ring-1 transition ${matches(o) && !typing ? 'bg-brand-50 ring-brand-400' : 'bg-white/70 ring-slate-200 hover:ring-brand-300'}`}>
              <span>
                <b>{plain(o.sheet_l)} × {plain(o.sheet_w)} in · {plain(o.ups)} ups</b>
                <span className="text-slate-500"> · {styleLabel(o.style)}{o.times_costed ? ` · used ${o.times_costed}×` : ''}</span>
                {o.rank === 0 && <span className="ml-1.5 rounded-full bg-brand-100 px-1.5 py-px text-[10px] font-bold text-brand-700">Most used</span>}
                {o.cheapest && <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-px text-[10px] font-bold text-emerald-700">Cheapest</span>}
              </span>
              <span className="shrink-0 font-bold tabular-nums">{o.cost_per_unit != null ? `${perUnit(o.cost_per_unit)} a carton` : ''}</span>
            </button>
          ))}
          <button type="button" onClick={() => setTyping(true)}
            className={`w-full rounded-xl px-3 py-2 text-left text-xs ring-1 ${own ? 'bg-brand-50 ring-brand-400' : 'bg-white/70 ring-slate-200 hover:ring-brand-300'}`}>
            <b>Another sheet…</b> <span className="text-slate-500">type the sheet size and ups</span>
          </button>
        </div>
      )}
      {own && (
        <div className="mt-2 grid grid-cols-3 gap-2 sm:max-w-md">
          <NumField label="Sheet length" unit="inch" source={src('sheet_l')} value={inputs.sheet_l} onChange={x => setIn('sheet_l', x)} placeholder="e.g. 18" />
          <NumField label="Sheet width" unit="inch" source={src('sheet_w')} value={inputs.sheet_w} onChange={x => setIn('sheet_w', x)} placeholder="e.g. 23" />
          <NumField label="Ups" unit="a sheet" source={src('ups')} value={inputs.ups} onChange={x => setIn('ups', x)} placeholder="e.g. 4"
            help="How many cartons fit on one print sheet" />
        </div>
      )}
      {own && size?.kind === 'carton' && opts.length === 0 && <SizeHelper size={size} onUse={p => onPick({ sheet_l: +p.sheet_l.toFixed(2), sheet_w: +p.sheet_w.toFixed(2), ups: p.ups, style: null })} />}
    </div>
  );
}

// The cost sheet's Sizer tab: the smallest sheet for each layout of a brand-new carton.
function SizeHelper({ size, onUse }) {
  const rows = sizerProposals(size).slice(0, 6);
  return (
    <div className="mt-3 rounded-xl bg-slate-50/80 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold"><Lightbulb size={13} className="text-amber-500" />New size — the Sizer's smallest sheets</div>
      <p className="mb-2 text-[11px] text-slate-500">A starting point only: pick the next board size you can buy, and check with planning.</p>
      <div className="grid grid-cols-3 gap-1.5">
        {rows.map(p => (
          <button key={`${p.l_ups}x${p.w_ups}`} type="button" onClick={() => onUse(p)}
            className="rounded-lg bg-white px-2 py-1 text-left text-[11px] ring-1 ring-slate-200 hover:ring-brand-400">
            <b>{p.ups} ups</b> · {plain(p.sheet_l, 1)} × {plain(p.sheet_w, 1)} in
          </button>
        ))}
      </div>
    </div>
  );
}

// A size + pasting + layout the library has not seen, asked as soon as it is typed. Left unanswered, the
// same question comes up on saving.
function SaveSizeAsk({ entry, onYes, onNo }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
      <BookmarkPlus size={18} className="shrink-0 text-amber-600" />
      <div className="min-w-[200px] flex-1 text-xs">
        <div className="text-[13px] font-bold text-[#1D1D1F]">{entry.new_size ? 'New size' : 'New layout for this size'} — save it to the Size Library?</div>
        <div className="text-slate-600">{entry.ready ? entry.text : 'Fill in the sheet and ups first, then it can be saved.'}</div>
      </div>
      <Button type="button" size="sm" onClick={onYes} disabled={!entry.ready}>Yes, save it</Button>
      {entry.ready && <Button type="button" size="sm" variant="secondary" onClick={onNo}>Not now</Button>}
    </div>
  );
}

// ── coating ──────────────────────────────────────────────────────────────────────────────────────
// Coating in the sheet's own terms, said plainly: a rate per 100 sq in of sheet (the plant's usual ones
// as buttons, named on the Rates tab), and how many sheets are coated — every sheet unless said.
function CoatingField({ value, coatings, set, src }) {
  const inputs = value.inputs;
  const choice = value.coat_choice ?? '';
  const pick = c => {
    if (c === 'none') set({ coat_choice: 'none', inputs: { ...inputs, coat_factor: '', coat_rate: '' } }, ['coat_choice', 'coat_factor', 'coat_rate']);
    else if (c === 'rate') set({ coat_choice: 'rate', inputs: { ...inputs, coat_factor: '' } }, ['coat_choice', 'coat_factor']);
    else set({ coat_choice: String(c), inputs: { ...inputs, coat_factor: c, coat_rate: '' } }, ['coat_choice', 'coat_factor', 'coat_rate']);
  };
  const r = computeCosting(inputs);
  const chip = (key, label, sub, under) => {
    const on = String(choice) === String(key);
    return (
      <button key={key} type="button" onClick={() => pick(key)}
        className={`rounded-xl px-3 py-1.5 text-left text-xs ring-1 transition ${on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white/80 ring-slate-200 hover:ring-brand-300'}`}>
        <b>{label}</b>{sub && <span className={on ? 'text-white/80' : 'text-slate-500'}> {sub}</span>}
        {under && <span className={`block font-semibold ${on ? 'text-white/90' : 'text-brand-700'}`}>{under}</span>}
      </button>
    );
  };
  return (
    <div className="sm:col-span-3">
      <div className="mb-1 text-xs font-medium text-slate-600">
        Coating <span className="text-brand-500">*</span>
        <span title="The cost sheet charges coating by sheet area: a rate per 100 sq in of the print sheet, times the sheets coated. Rate = ₹1 ÷ factor." className="ml-1 inline-flex cursor-help align-middle text-slate-400"><Info size={12} /></span>
        <SourceTag source={src('coat_choice')} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chip('none', 'No coating')}
        {coatingChoices(coatings, choice).map(c => {
          const rate = `₹${coatingRate(c.factor).toFixed(2)}`;
          return chip(String(c.factor), c.name || rate, c.name ? `${rate} / 100 sq in` : '/ 100 sq in', `Factor ${plain(c.factor, 2)}`);
        })}
        {chip('rate', 'Another rate…')}
      </div>
      {choice && choice !== 'none' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {choice === 'rate' && (
            <NumField label="Coating rate" unit="₹ per 100 sq in" source={src('coat_rate')} value={inputs.coat_rate}
              onChange={x => set({ inputs: { ...inputs, coat_rate: x } }, ['coat_rate'])} placeholder="e.g. 0.25" />
          )}
          <NumField label="Sheets to coat" unit={`blank = all ${r.ok ? plain(r.sheets, 0) : ''}`} source={src('coat_sheets')} value={inputs.coat_sheets}
            onChange={x => set({ inputs: { ...inputs, coat_sheets: x } }, ['coat_sheets'])} placeholder={r.ok ? plain(r.sheets, 0) : 'every sheet'}
            help="Leave blank to coat every sheet, wastage included — as the cost sheet does" />
          {r.ok && r.parts.coat_per_sheet > 0 && (
            <div className="self-end rounded-xl bg-white/70 px-3 py-2 text-xs text-slate-600">
              {perUnit(r.parts.coat_per_sheet)} a sheet · <b>{rupees(r.parts.coat)}</b> coating
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── the product ──────────────────────────────────────────────────────────────────────────────────
// One box: search the Product Master, or type a new product's name. Picking a product fills the costing.
function ProductBox({ value, onPick, onName, onUnlink }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRows([]); return undefined; }
    let live = true;
    const t = setTimeout(() => api.get(`/costing/products?search=${encodeURIComponent(s)}`).then(r => live && setRows(r)).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const p = value.product;
  return (
    <div className="relative">
      <Field label={<Label label="Product" source={value.product ? { kind: 'product', note: value.product.code } : null}
        help="Search the Product Master by name, code, size or customer. A product not in the master yet: just type its name." />}>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-3 text-slate-400" />
          <Input className="!pl-9" value={value.product_name || ''} placeholder="Search a product, or type a new one"
            onChange={e => { onName(e.target.value); setQ(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
        </div>
      </Field>
      {p && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
          <Sparkles size={12} className="text-brand-500" />From the Product Master: <b className="text-slate-700">{p.code}</b>{p.customer_name ? ` · ${p.customer_name}` : ''}{p.size ? ` · ${p.size}` : ''}
          <button type="button" title="Cost it as a new product instead" onClick={onUnlink} className="ml-1 text-slate-400 hover:text-red-500"><X size={12} /></button>
        </div>
      )}
      {open && rows.length > 0 && (
        <div data-ci-overlay className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-xl bg-white shadow-xl ring-1 ring-slate-200">
          {rows.map(r => (
            <button key={r.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { onPick(r); setOpen(false); setRows([]); }}
              className="block w-full border-b border-slate-100 px-3 py-2 text-left text-xs last:border-0 hover:bg-brand-50">
              <b>{r.name}</b> <span className="text-slate-400">{r.code}</span>
              <div className="text-slate-500">{[r.customer_name, r.size, r.gsm && `${r.gsm} gsm`, r.sheet_l && r.sheet_w && `${r.sheet_l}×${r.sheet_w} in`, num(r.ups) > 1 && `${r.ups} ups`, r.coating].filter(Boolean).join(' · ')}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── the editor ───────────────────────────────────────────────────────────────────────────────────
export default function CostingEditor({ boot, customers = [], value, onChange, excludeId, hideProductStep = false, askLibrary = false, recheck = 0 }) {
  const toast = useToast();
  const inputs = value.inputs || {};
  const settings = boot?.settings || { coatings: [], alert_pct: 15, defaults: {} };
  const grades = boot?.board_grades || [];
  const src = f => value.sources?.[f];
  // A change the user made: the values, and the boxes it touched marked as typed.
  const set = (patch, edited = []) => onChange(markEdited({ ...value, ...patch, autofill: true }, edited));
  const setIn = (key, x) => set({ inputs: { ...inputs, [key]: x } }, [key]);
  const result = useMemo(() => computeCosting(inputs), [inputs]);
  const missing = stillNeeded(value);
  const size = parseSize(value.size_text);
  const [filed, setFiled] = useState(null);               // the entry just saved from the question below
  const check = useSizeCheck(size?.key, excludeId, `${recheck}|${filed}`);
  const checked = !!size && check.key === size.key && !!check.data;
  const entry = askLibrary && checked && !libraryDeclined(value) ? newLibraryEntry(value, check.data.library?.exact) : null;
  const toLibrary = async () => {
    await api.post('/costing/sizes', { size_text: value.size_text, style: value.style, sheet_l: inputs.sheet_l, sheet_w: inputs.sheet_w, ups: inputs.ups });
    setFiled(entry.key);
    toast.success('Saved to the Size Library');
  };

  // Fill (and refill) the suggestions whenever what they depend on changes: the product, the size check,
  // the pasting (die & pasting follows it), the colours (process follows them). A costing reopened from
  // the register is left as saved until its product or size is changed.
  const ctxKey = `${value.product?.id ?? ''}|${check.key ?? ''}|${check.data ? 1 : 0}|${value.style ?? ''}|${inputs.colours ?? ''}`;
  const lastCtx = useRef(null);
  useEffect(() => {
    if (value.autofill === false || !boot) return;
    if (size?.key && check.key !== size.key) return;          // wait for this size's check
    if (lastCtx.current === ctxKey) return;
    lastCtx.current = ctxKey;
    const next = recommend(value, { product: value.product, check: check.data, typical: boot.typical, defaults: settings.defaults, grades });
    const pick = x => JSON.stringify([x.inputs, x.sources, x.size_text, x.style, x.board_grade, x.coat_choice, x.customer_name]);
    if (pick(next) !== pick(value)) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey, boot]);

  // Size typed as three boxes; a whole "165x58x73" pasted into any box is split across them.
  const [dims, setDims] = useState(() => ({ l: size?.l ?? '', w: size?.w ?? '', h: size?.h ?? '' }));
  const lastText = useRef(value.size_text);
  useEffect(() => {
    if (value.size_text === lastText.current) return;
    lastText.current = value.size_text;
    const s = parseSize(value.size_text);
    setDims({ l: s?.l ?? '', w: s?.w ?? '', h: s?.h ?? '' });
  }, [value.size_text]);
  const setDim = (k, x) => {
    const whole = parseSize(x);
    const next = whole && whole.kind !== 'other' && /x|×|\*/i.test(String(x)) ? { l: whole.l, w: whole.w, h: whole.h ?? '' } : { ...dims, [k]: x };
    setDims(next);
    const text = [next.l, next.w, next.h].map(y => String(y ?? '').trim()).filter(Boolean).join('x');
    lastText.current = text;
    set({ size_text: text }, ['size_text']);
  };

  const pickProduct = p => onChange({ ...value, product: p, product_id: p.id, product_name: p.name, autofill: true });
  const pickCustomer = name => {
    const hit = customers.find(c => c.name.toLowerCase() === name.trim().toLowerCase());
    set({ customer_name: name, customer_id: hit ? hit.id : null }, ['customer_name', 'customer_id']);
  };
  const pickLayout = o => set({ style: o.style || value.style, inputs: { ...inputs, sheet_l: o.sheet_l ?? '', sheet_w: o.sheet_w ?? '', ups: o.ups ?? '' } },
    ['sheet_l', 'sheet_w', 'ups', ...(o.style ? ['style'] : [])]);
  const showEmb = num(inputs.emb_rate) > 0 || +value.product?.emboss === 1 || value.show_emb;
  const filled = Object.values(value.sources || {}).filter(s => s && s.kind !== 'manual' && s.kind !== 'default').length;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
      <form data-ci-form className="min-w-0 space-y-4" onSubmit={e => e.preventDefault()}>
        {!hideProductStep && (
          <Card icon={Sparkles} title="Product & quantity" hint="Pick a product and the rest fills itself in. Blue tags show where each value came from; change anything.">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
              <ProductBox value={value} onPick={pickProduct}
                onName={name => set({ product_name: name }, [])}
                onUnlink={() => onChange({ ...value, product: null, product_id: null, autofill: true })} />
              <Field label={<Label label="Customer" source={src('customer_name')} />}>
                <Input list="costing-customers" value={value.customer_name || ''} onChange={e => pickCustomer(e.target.value)} placeholder="Customer" />
                <datalist id="costing-customers">{customers.map(c => <option key={c.id} value={c.name} />)}</datalist>
              </Field>
              <NumField label="Quantity" unit="cartons" source={src('qty')} value={inputs.qty} onChange={x => setIn('qty', x)} placeholder="e.g. 10,000" />
            </div>
            {filled > 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-brand-700"><Sparkles size={13} />{filled} values filled in for you — check the ones with blue tags.</p>
            )}
          </Card>
        )}

        <Card icon={Layers} title="Carton" hint="Size in mm (length × width × height; leave height blank for a leaflet or label), the print sheet, and the board.">
          <div className="grid gap-3 sm:grid-cols-4">
            <NumField label="Length" unit="mm" source={src('size_text')} value={dims.l} onChange={x => setDim('l', x)} placeholder="e.g. 165" />
            <NumField label="Width" unit="mm" value={dims.w} onChange={x => setDim('w', x)} placeholder="e.g. 58" />
            <NumField label="Height" unit="mm" value={dims.h} onChange={x => setDim('h', x)} placeholder="e.g. 73" />
            <Field label={<Label label="Pasting" source={src('style')} />}>
              <Select value={value.style || ''} onChange={e => set({ style: e.target.value || null }, ['style'])} placeholder="Choose…">
                <option value="">Not set</option>
                {STYLE_OPTIONS.map(s => <option key={s} value={s}>{styleLabel(s)}</option>)}
              </Select>
            </Field>
          </div>
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium text-slate-600">
              Print sheet & ups<SourceTag source={src('ups')} />
              {(check.data?.library?.exact?.length || 0) > 1 && <span className="ml-1.5 text-slate-400">— the recommended layout is chosen; the others are priced for you</span>}
            </div>
            <LayoutChooser value={value} entries={check.key === size?.key ? check.data?.library?.exact || [] : []} size={size} onPick={pickLayout} setIn={setIn} src={src} />
            {entry && entry.key !== filed && <SaveSizeAsk entry={entry} onYes={toLibrary} onNo={() => onChange({ ...value, skip_library: entry.key })} />}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <NumField label="GSM" source={src('gsm')} value={inputs.gsm} onChange={x => setIn('gsm', x)} placeholder="e.g. 300" />
            <Field label={<Label label="Board grade" source={src('board_grade')} />} className="sm:col-span-2">
              <Select value={value.board_grade || ''} placeholder="Choose a grade…"
                onChange={e => {
                  const g = grades.find(x => x.grade === e.target.value);
                  set({ board_grade: e.target.value, inputs: { ...inputs, board_rate: g ? g.rate_per_kg : inputs.board_rate } }, ['board_grade', 'board_rate']);
                }}>
                <option value="">— type the rate instead —</option>
                {grades.map(g => <option key={g.grade} value={g.grade}>{g.grade} — ₹{plain(g.rate_per_kg)}/kg</option>)}
              </Select>
            </Field>
            <NumField label="Board rate" unit="₹ per kg" source={src('board_rate')} value={inputs.board_rate} onChange={x => setIn('board_rate', x)} placeholder="e.g. 95"
              help="Board is bought by weight. Picking a grade fills today's rate from Masters → Board Rates." />
          </div>
        </Card>

        <Card icon={Sparkles} title="Print & finish">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumField label="Colours" source={src('colours')} value={inputs.colours} onChange={x => setIn('colours', x)} placeholder="e.g. 4" />
            {showEmb ? (
              <NumField label="Embossing" unit="₹ per carton" source={src('emb_rate')} value={inputs.emb_rate} onChange={x => setIn('emb_rate', x)} placeholder="e.g. 0.15"
                help="Added per carton after P&F and misc, as the cost sheet does" />
            ) : (
              <button type="button" onClick={() => onChange({ ...value, show_emb: true })} className="self-end rounded-xl px-3 py-2 text-left text-xs font-semibold text-brand-600 ring-1 ring-dashed ring-slate-300 hover:bg-brand-50">
                <Plus size={13} className="mr-1 inline" />Add embossing
              </button>
            )}
            <CoatingField value={value} coatings={settings.coatings || []} set={set} src={src} />
          </div>
        </Card>

        <details className="ci-form-panel glass group rounded-2xl p-4 sm:p-5">
          <summary className="flex cursor-pointer list-none items-center gap-2.5">
            <SlidersHorizontal size={18} className="text-brand-600" />
            <span className="text-[15px] font-bold">More settings</span>
            <span className="text-xs text-slate-500">wastage, printing rate, die & pasting, process, P&F, margin — already filled in</span>
            <ChevronDown size={16} className="ml-auto text-slate-400 transition group-open:rotate-180" />
          </summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <NumField label="Wastage sheets" unit="sheets" source={src('wastage')} value={inputs.wastage} onChange={x => setIn('wastage', x)}
              help="Extra sheets for setting up — a fixed allowance, usually 250–300 whatever the run" />
            <NumField label="Printing rate" unit="₹ per 1,000 sheets per colour" source={src('print_rate')} value={inputs.print_rate} onChange={x => setIn('print_rate', x)} />
            <NumField label="Minimum printing" unit="₹" source={src('print_min')} value={inputs.print_min} onChange={x => setIn('print_min', x)}
              help="A small run pays at least this for printing" />
            <NumField label="Die & pasting" unit="₹ per carton" source={src('dp_rate')} value={inputs.dp_rate} onChange={x => setIn('dp_rate', x)}
              help="Follows the pasting style in your costings: Lock bottom ₹0.30, Side ₹0.20" />
            <NumField label="Process charge" unit="₹ for the job" source={src('process')} value={inputs.process} onChange={x => setIn('process', x)}
              help="Fixed per order — about ₹500 a colour in your costings" />
            <NumField label="P&F" unit="%" source={src('pf_pct')} value={inputs.pf_pct} onChange={x => setIn('pf_pct', x)} />
            <NumField label="Misc" unit="%" source={src('misc_pct')} value={inputs.misc_pct} onChange={x => setIn('misc_pct', x)} />
            <NumField label="Quote margin" unit="₹ per carton" source={src('margin')} value={inputs.margin} onChange={x => setIn('margin', x)} />
            <NumField label="Customer's target price" unit="₹ per carton" source={src('target_price')} value={inputs.target_price} onChange={x => setIn('target_price', x)}
              help="Optional — shows the margin left at the customer's price" />
          </div>
          {!hideProductStep && (
            <Field label="Remarks" className="mt-3">
              <Textarea value={value.remarks || ''} onChange={e => set({ remarks: e.target.value }, [])} placeholder="Anything the next person should know" />
            </Field>
          )}
        </details>
      </form>

      <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
        <ResultCard result={result} missing={missing} />
        <QuantityCard inputs={inputs} quantities={value.quantities} onQuantities={q => onChange({ ...value, quantities: q })} />
        <SizeKnowledge value={value} result={result} onChange={({ _edited, ...patch }) => set(patch, _edited || [])} excludeId={excludeId}
          alertPct={settings.alert_pct || 15} check={check} />
      </div>
    </div>
  );
}
