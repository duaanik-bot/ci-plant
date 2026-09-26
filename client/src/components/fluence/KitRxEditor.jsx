// A Fluence kit's contents and its prescription — ONE table, ONE Save.
//
// What goes in the box and how each item is taken used to be two editors that
// could drift apart. Here a row is a prescription line, and:
//
//   • an item's first line also carries what the box holds of it — how many,
//     and its MRP in the kit;
//   • adding an item to the kit adds its line; taking it out takes its lines;
//   • a second line for the same item is a second time it is taken
//     ("Mon, Wed & Fri: 1" beside "Sunday: 2");
//   • a line for something that is not in the box (a diet chart) says what it is.
//
// The table's order is the printed order: the kit list follows the order in
// which its items first appear. One Save writes both halves in one transaction
// (PUT …/kit) and names the kit list and prescription revision it opened, so a
// colleague's save in the meantime is refused instead of overwritten.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CornerDownRight, Loader2, MoreHorizontal, PackageMinus, Pencil, Plus, RefreshCw, Trash2, Type } from 'lucide-react';
import { api, fmt } from '../../api.js';
import { Button, SearchableSelect } from '../ui.jsx';
import InnerProductForm from './InnerProductForm.jsx';
import {
  RX_SLOTS, DOSE_FORMS, FREQUENCIES, normaliseRxPayload, normaliseComponentsPayload, componentsSignature,
  formatRxLine, qtyText, qtyValue,
} from '../../lib/fluence.js';

const box = 'h-8 w-full rounded-lg border border-[#1D1D1F]/[0.12] bg-white/90 px-2 text-xs font-medium text-[#1D1D1F] outline-none transition placeholder:text-[#C7C7CC] focus:border-[#0A84FF] focus:ring-2 focus:ring-[#0A84FF]/20';
const badBox = 'border-red-400 bg-red-50/70 focus:border-red-500 focus:ring-red-500/20';
const lab = 'mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[#86868B]';
const iconBtn = 'rounded-lg p-1.5 text-[#86868B] transition hover:bg-[#1D1D1F]/[0.06] hover:text-[#1D1D1F] disabled:opacity-30';

const NUM_KEYS = ['pack_count', ...RX_SLOTS.map(s => s.key), 'other_qty'];
const TEXT_KEYS = ['item_label', 'dosage', 'dose_form', 'frequency', 'other_timing', 'instructions', 'remarks'];
const asText = v => (v == null ? '' : String(v));
const asQty = v => (v == null || v === '' ? '' : qtyText(v));

// A number box that is filled in wrongly (letters, a minus) — never a blank one.
const badNumber = v => { const n = qtyValue(v); return Number.isNaN(n) || (n != null && n < 0); };

function rowOf(line, key) {
  const row = { key, inner_product_id: line.inner_product_id == null ? null : Number(line.inner_product_id) };
  for (const k of TEXT_KEYS) row[k] = asText(line[k]);
  for (const k of NUM_KEYS) row[k] = asQty(line[k]);
  return row;
}

// The editor as the kit opens: its lines in order; a kit item the prescription
// does not name yet gets a bare line where the kit list puts it; a line for an
// item that has left the kit is not shown (and goes on the next save).
function openForm(dossier, nextKey) {
  const comps = dossier.components || [];
  const inKit = new Set(comps.map(c => Number(c.inner_product_id)));
  const lines = dossier.prescription?.lines || [];
  const rows = lines.filter(l => l.inner_product_id == null || inKit.has(Number(l.inner_product_id))).map(l => rowOf(l, nextKey()));
  const named = new Set(rows.map(r => r.inner_product_id).filter(id => id != null));
  comps.forEach((c, i) => {
    const id = Number(c.inner_product_id);
    if (named.has(id)) return;
    const before = new Set(comps.slice(0, i).map(x => Number(x.inner_product_id)));
    let at = 0;
    rows.forEach((r, n) => { if (before.has(r.inner_product_id)) at = n + 1; });
    rows.splice(at, 0, rowOf({ inner_product_id: id }, nextKey()));
    named.add(id);
  });
  return {
    rows,
    items: Object.fromEntries(comps.map(c => [Number(c.inner_product_id), {
      qty_per_kit: asQty(c.qty_per_kit), mrp_in_kit: asQty(c.mrp_in_kit), remarks: asText(c.remarks),
    }])),
    general_instructions: asText(dossier.prescription?.general_instructions),
    remarks: asText(dossier.prescription?.remarks),
    dropped: lines.filter(l => l.inner_product_id != null && !inKit.has(Number(l.inner_product_id)))
      .map(l => l.item_name || `item ${l.inner_product_id}`),
  };
}

// The kit list is the items in the order they first appear in the table.
const itemOrder = rows => [...new Set(rows.map(r => r.inner_product_id).filter(id => id != null))];

function payloadOf(form) {
  return {
    components: itemOrder(form.rows).map(id => ({ inner_product_id: id, ...form.items[id] })),
    lines: form.rows.map(({ key, ...line }) => line),
    general_instructions: form.general_instructions,
    remarks: form.remarks,
  };
}

// What we know of an inner product, for showing it: the master's row where it
// is loaded, else what the kit list carried.
function factsOf(p, fromKit) {
  return {
    id: Number(fromKit ? p.inner_product_id : p.id),
    name: p.name, kind: p.kind, dosage_form: p.dosage_form, packaging_info: p.packaging_info, standard_mrp: p.standard_mrp,
    product_code: p.product_code, artwork_code: p.artwork_code, carton_l: p.carton_l, carton_w: p.carton_w, carton_h: p.carton_h,
    inner_remarks: fromKit ? p.inner_remarks : p.remarks,
  };
}

export default function KitRxEditor({ dossier, context, onCancel, onSaved, onDirty, onReload }) {
  const keyCount = useRef(0);
  const nextKey = () => `r${++keyCount.current}`;
  const [form, setForm] = useState(() => openForm(dossier, nextKey));
  const [inner, setInner] = useState(null);
  const [more, setMore] = useState(() => new Set());   // rows showing their extra fields
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [stale, setStale] = useState(false);
  const [creating, setCreating] = useState(false);
  const [itemForm, setItemForm] = useState(null);
  const [adder, setAdder] = useState(0);               // remounts the add-item search empty

  const loadInner = () => api.get('/fluence/inner-products').then(setInner).catch(e => setError(e.message));
  useEffect(() => { loadInner(); }, []);

  const facts = useMemo(() => {
    const m = new Map((dossier.components || []).map(c => [Number(c.inner_product_id), factsOf(c, true)]));
    for (const p of inner || []) m.set(Number(p.id), factsOf(p, false));
    return m;
  }, [dossier.components, inner]);
  const nameOf = id => facts.get(Number(id))?.name || `Item ${id}`;

  const touch = fn => { setForm(fn); onDirty?.(true); };
  const setRow = (key, patch) => touch(f => ({ ...f, rows: f.rows.map(r => (r.key === key ? { ...r, ...patch } : r)) }));
  const setItem = (id, patch) => touch(f => ({ ...f, items: { ...f.items, [id]: { ...f.items[id], ...patch } } }));
  const toggleMore = key => setMore(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  // The first dose typed on a line brings the item's form with it, so the card
  // prints "1 tablet" rather than a bare "1". It shows under the item's name
  // and can be changed under ⋯.
  const setDose = (row, key, value) => {
    const patch = { [key]: value };
    const hadDose = NUM_KEYS.filter(k => k !== 'pack_count').some(k => String(row[k]).trim());
    const itemForm = row.inner_product_id != null ? facts.get(row.inner_product_id)?.dosage_form : null;
    if (!row.dose_form && !hadDose && String(value).trim() && itemForm) patch.dose_form = itemForm;
    setRow(row.key, patch);
  };

  const addItem = raw => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return;
    const key = nextKey();
    touch(f => (f.items[id] ? f : {
      ...f,
      items: { ...f.items, [id]: { qty_per_kit: '1', mrp_in_kit: '', remarks: '' } },
      rows: [...f.rows, rowOf({ inner_product_id: id }, key)],
    }));
    setAdder(n => n + 1);
  };
  const addLineFor = row => {
    const key = nextKey();
    touch(f => {
      const last = f.rows.reduce((at, r, i) => (r.inner_product_id === row.inner_product_id ? i : at), -1);
      const rows = [...f.rows];
      rows.splice(last + 1, 0, { ...rowOf({ inner_product_id: row.inner_product_id }, key), dose_form: row.dose_form });
      return { ...f, rows };
    });
  };
  const addFreeLine = () => { const key = nextKey(); touch(f => ({ ...f, rows: [...f.rows, rowOf({ inner_product_id: null }, key)] })); };
  const removeRow = row => touch(f => {
    const rows = f.rows.filter(r => r.key !== row.key);
    if (row.inner_product_id == null || rows.some(r => r.inner_product_id === row.inner_product_id)) return { ...f, rows };
    const items = { ...f.items };
    delete items[row.inner_product_id];
    return { ...f, rows, items };
  });
  const removeItem = id => touch(f => {
    const items = { ...f.items };
    delete items[id];
    return { ...f, rows: f.rows.filter(r => r.inner_product_id !== id), items };
  });
  const move = (row, d) => touch(f => {
    const i = f.rows.findIndex(r => r.key === row.key);
    const j = i + d;
    if (i < 0 || j < 0 || j >= f.rows.length) return f;
    const rows = [...f.rows];
    [rows[i], rows[j]] = [rows[j], rows[i]];
    return { ...f, rows };
  });

  const save = async () => {
    const body = payloadOf(form);
    const order = body.components.map(c => c.inner_product_id);
    // The shared validator counts kit items ("Item 2: …"); the table shows names.
    const errors = [
      ...normaliseComponentsPayload(body).errors.map(e => e.replace(/^Item (\d+):/, (m, n) => (order[n - 1] ? `${nameOf(order[n - 1])}:` : m))),
      ...normaliseRxPayload(body).errors,
    ];
    if (errors.length) { setError(errors.join(' ')); setStale(false); return; }
    setSaving(true);
    setError(null);
    setStale(false);
    try {
      const url = dossier.product ? `/fluence/products/${dossier.product.id}/kit` : `/fluence/kits/${dossier.kit.id}/kit`;
      const out = await api.put(url, {
        ...body,
        from: context,
        base_components: componentsSignature(dossier.components || []),
        base_revision: dossier.prescription?.revision ?? 0,
      });
      onSaved?.(out);
    } catch (e) {
      setError(e.message);
      setStale(e.status === 409);
    } finally {
      setSaving(false);
    }
  };

  // Line numbers as printed, and where each item's first line is.
  const firstKey = new Map();
  form.rows.forEach((r, i) => { if (r.inner_product_id != null && !firstKey.has(r.inner_product_id)) firstKey.set(r.inner_product_id, { key: r.key, n: i + 1 }); });
  const linesOf = id => form.rows.filter(r => r.inner_product_id === id).length;
  const itemCount = firstKey.size;
  const units = [...firstKey.keys()].reduce((s, id) => s + (Number(form.items[id]?.qty_per_kit) || 0), 0);
  const whose = dossier.part_of
    ? <>the kit of <b>{dossier.part_of.outer_code}</b> — {dossier.product.code} and its other part cartons show it</>
    : dossier.product
      ? <><b>{dossier.product.code}</b>{dossier.kit?.parts?.length ? <> and its {dossier.kit.parts.length} part cartons</> : null}</>
      : <><b>{dossier.kit?.kit_name}</b></>;

  const th = 'whitespace-nowrap px-1.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#6E6E73]';
  const td = 'px-1 py-1 align-top';
  const stickyCell = 'sticky left-0 z-[1] bg-white';

  return (
    <div className="space-y-3" data-kit-rx-editor="1">
      <p className="text-xs text-[#515154]">
        One save updates the <b>Fluence master</b> for {whose}: what is in the box and how each item is taken, together.
        Leave a time blank if nothing is taken then.
      </p>
      {form.dropped.length > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Not in the kit any more, so their prescription lines are not shown and go when you save: <b>{form.dropped.join(', ')}</b>.
        </p>
      )}

      <datalist id="fluence-dose-forms">{DOSE_FORMS.map(f => <option key={f} value={f} />)}</datalist>
      <datalist id="fluence-frequencies">{FREQUENCIES.map(f => <option key={f} value={f} />)}</datalist>

      <div className="overflow-x-auto rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/80">
        <table className="w-full min-w-[1060px] border-collapse text-xs text-[#1D1D1F]">
          <thead>
            <tr className="bg-[#F5F5F7]">
              <th className={`${stickyCell} !bg-[#F5F5F7]`} />
              <th colSpan={2} className="border-l border-[#1D1D1F]/[0.06] px-1.5 pt-1.5 text-left text-[9px] font-extrabold uppercase tracking-[0.16em] text-green-800">In the box</th>
              <th colSpan={8} className="border-l border-[#1D1D1F]/[0.06] px-1.5 pt-1.5 text-left text-[9px] font-extrabold uppercase tracking-[0.16em] text-green-800">How it is taken</th>
              <th />
            </tr>
            <tr className="border-b border-[#1D1D1F]/10 bg-[#F5F5F7]">
              <th className={`${th} ${stickyCell} !bg-[#F5F5F7] w-[230px] min-w-[190px]`}>Item</th>
              <th className={`${th} w-[62px] border-l border-[#1D1D1F]/[0.06] text-right`}>Qty / kit</th>
              <th className={`${th} w-[74px] text-right`}>MRP in kit</th>
              {RX_SLOTS.map((s, i) => <th key={s.key} className={`${th} w-[60px] text-center ${i === 0 ? 'border-l border-[#1D1D1F]/[0.06]' : ''}`}>{s.label}</th>)}
              <th className={`${th} w-[122px]`} title="Anything that is not a time of day — Mon & Thu, Every 6 hours, Before bed">Other time</th>
              <th className={`${th} w-[48px] text-center`}>Qty</th>
              <th className={`${th} w-[112px]`}>Frequency</th>
              <th className={`${th} min-w-[150px]`}>Instructions</th>
              <th className={`${th} w-[92px]`} />
            </tr>
          </thead>
          <tbody>
            {form.rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-6 text-center text-xs text-[#6E6E73]">
                  Nothing in this kit yet. Add its items below — each gets a line for how it is taken.
                </td>
              </tr>
            )}
            {form.rows.map((row, i) => {
              const id = row.inner_product_id;
              const item = id != null ? facts.get(id) : null;
              const first = id != null && firstKey.get(id)?.key === row.key;
              const others = id != null ? linesOf(id) - 1 : 0;
              const k = id != null ? form.items[id] : null;
              const isOpen = more.has(row.key);
              const detail = [row.dose_form, row.dosage, row.pack_count ? `pack of ${row.pack_count}` : null, row.remarks ? `note: ${row.remarks}` : null].filter(Boolean);
              const itemFacts = item ? [item.kind === 'packaging' ? 'Packaging' : null, item.dosage_form, item.packaging_info].filter(Boolean) : [];
              const hasMore = detail.length > 0 || (first && Boolean(k?.remarks));
              const qtyBad = first && k && (qtyValue(k.qty_per_kit) == null || badNumber(k.qty_per_kit) || qtyValue(k.qty_per_kit) === 0);
              const preview = formatRxLine(row, id != null ? item?.name : row.item_label);
              return (
                <Fragment key={row.key}>
                  <tr className={`border-t border-[#1D1D1F]/[0.06] ${first && i > 0 ? 'border-t-[#1D1D1F]/[0.12]' : ''}`} data-rx-row={i + 1}>
                    <td className={`${td} ${stickyCell} pl-2`}>
                      <div className="flex items-start gap-1.5">
                        <span className={`mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${first || id == null ? 'bg-green-700 text-white' : 'bg-green-700/15 text-green-800'}`}>{i + 1}</span>
                        <div className="min-w-0 flex-1 py-1">
                          {id == null ? (
                            <>
                              <input className={`${box} ${!row.item_label.trim() ? badBox : ''}`} value={row.item_label} placeholder="What is this line for?"
                                aria-label={`Line ${i + 1}: what it is for`} onChange={e => setRow(row.key, { item_label: e.target.value })} />
                              <div className="mt-0.5 text-[10px] text-[#86868B]">Not an item in the kit</div>
                            </>
                          ) : (
                            <>
                              <div className={`flex items-center gap-1 truncate font-semibold ${first ? '' : 'text-[#6E6E73]'}`} title={item?.name}>
                                {!first && <CornerDownRight size={12} className="shrink-0 text-green-700" />}
                                <span className="truncate">{item?.name || `Item ${id}`}</span>
                              </div>
                              <div className="truncate text-[10px]" title={[...detail, ...itemFacts].join(' · ')}>
                                {detail.length
                                  ? <span className="font-semibold text-green-800">{detail.join(' · ')}</span>
                                  : first
                                    ? <span className="text-[#86868B]">{itemFacts.join(' · ') || (item?.standard_mrp != null ? `Standard MRP ${fmt.inr(item.standard_mrp)}` : '')}</span>
                                    : <span className="text-[#86868B]">Another line for line {firstKey.get(id)?.n}</span>}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={`${td} border-l border-[#1D1D1F]/[0.06]`}>
                      {first ? (
                        <input className={`${box} text-right font-bold ${qtyBad ? badBox : ''}`} inputMode="decimal" value={k.qty_per_kit}
                          aria-label={`${item?.name || 'Item'}: quantity per kit`} onChange={e => setItem(id, { qty_per_kit: e.target.value })} />
                      ) : <span className="block pt-2 text-center text-[#D1D1D6]">{id == null ? '—' : ''}</span>}
                    </td>
                    <td className={td}>
                      {first ? (
                        <input className={`${box} text-right ${badNumber(k.mrp_in_kit) ? badBox : ''}`} inputMode="decimal" value={k.mrp_in_kit}
                          placeholder={item?.standard_mrp != null ? qtyText(item.standard_mrp) : '—'}
                          title={item?.standard_mrp != null ? `Standard MRP ₹${qtyText(item.standard_mrp)} — enter the MRP this kit prices it at` : 'MRP of one unit in this kit'}
                          aria-label={`${item?.name || 'Item'}: MRP in kit`} onChange={e => setItem(id, { mrp_in_kit: e.target.value })} />
                      ) : <span className="block pt-2 text-center text-[#D1D1D6]">{id == null ? '—' : ''}</span>}
                    </td>
                    {RX_SLOTS.map((s, n) => (
                      <td key={s.key} className={`${td} ${n === 0 ? 'border-l border-[#1D1D1F]/[0.06]' : ''}`}>
                        <input className={`${box} text-center font-bold ${badNumber(row[s.key]) ? badBox : ''}`} inputMode="decimal" value={row[s.key]} placeholder="—"
                          aria-label={`Line ${i + 1}: ${s.label}`} title={`${s.label} — how many`} onChange={e => setDose(row, s.key, e.target.value)} />
                      </td>
                    ))}
                    <td className={td}>
                      <input className={box} value={row.other_timing} placeholder={i === 0 ? 'e.g. Mon & Thu' : ''} aria-label={`Line ${i + 1}: other time`}
                        onChange={e => setDose(row, 'other_timing', e.target.value)} />
                    </td>
                    <td className={td}>
                      <input className={`${box} text-center font-bold ${badNumber(row.other_qty) ? badBox : ''}`} inputMode="decimal" value={row.other_qty} placeholder="—"
                        aria-label={`Line ${i + 1}: other-time quantity`} onChange={e => setDose(row, 'other_qty', e.target.value)} />
                    </td>
                    <td className={td}>
                      <input className={box} list="fluence-frequencies" value={row.frequency} placeholder={i === 0 ? 'Once daily' : ''} aria-label={`Line ${i + 1}: frequency`}
                        onChange={e => setRow(row.key, { frequency: e.target.value })} />
                    </td>
                    <td className={td}>
                      <input className={box} value={row.instructions} placeholder={i === 0 ? 'e.g. After food' : ''} aria-label={`Line ${i + 1}: instructions`}
                        onChange={e => setRow(row.key, { instructions: e.target.value })} />
                    </td>
                    <td className={`${td} whitespace-nowrap pr-2 text-right`}>
                      <button type="button" className={`${iconBtn} relative ${isOpen ? 'bg-[#1D1D1F]/[0.07] text-[#1D1D1F]' : ''}`} onClick={() => toggleMore(row.key)}
                        title={isOpen ? 'Hide form, strength, pack and notes' : 'Form, strength, pack, notes, order'} aria-expanded={isOpen}>
                        <MoreHorizontal size={14} />
                        {hasMore && !isOpen && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-green-600" />}
                      </button>
                      {id != null && (
                        <button type="button" className={iconBtn} onClick={() => addLineFor(row)} title={`Another line for ${item?.name || 'this item'} — a second time it is taken`}>
                          <Plus size={14} />
                        </button>
                      )}
                      <button type="button" className={`${iconBtn} hover:!bg-red-50 hover:!text-red-600`} onClick={() => removeRow(row)}
                        title={id == null ? 'Remove this line' : others ? 'Remove this line — the item stays in the kit' : `Take ${item?.name || 'this item'} out of the kit`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-[#F5F5F7]/70">
                      <td colSpan={12} className="px-2 pb-2.5 pt-1">
                        <div className="sticky left-2 max-w-[min(1000px,calc(100vw_-_72px))] space-y-2">
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                            <label className="sm:col-span-1">
                              <span className={lab}>Form</span>
                              <input className={box} list="fluence-dose-forms" value={row.dose_form} placeholder={item?.dosage_form || 'Tablet'}
                                onChange={e => setRow(row.key, { dose_form: e.target.value })} />
                            </label>
                            <label className="sm:col-span-1">
                              <span className={lab}>Strength</span>
                              <input className={box} value={row.dosage} placeholder="e.g. 500 mg" onChange={e => setRow(row.key, { dosage: e.target.value })} />
                            </label>
                            <label className="sm:col-span-1">
                              <span className={lab}>Pack of</span>
                              <input className={`${box} ${badNumber(row.pack_count) ? badBox : ''}`} inputMode="decimal" value={row.pack_count} placeholder="30"
                                onChange={e => setRow(row.key, { pack_count: e.target.value })} />
                            </label>
                            <label className="col-span-2 sm:col-span-3">
                              <span className={lab}>Note on this line (prints under it)</span>
                              <input className={box} value={row.remarks} onChange={e => setRow(row.key, { remarks: e.target.value })} />
                            </label>
                            {first && (
                              <label className="col-span-2 sm:col-span-3">
                                <span className={lab}>Remark for {item?.name || 'this item'} in this kit</span>
                                <input className={box} value={k.remarks} placeholder="e.g. Free sample" onChange={e => setItem(id, { remarks: e.target.value })} />
                              </label>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <p className={`min-w-0 flex-1 rounded-lg px-2 py-1 text-[11px] ${preview ? 'bg-green-50 text-green-900' : 'text-[#AEAEB2]'}`}>
                              {preview ? <>Reads: {preview}</> : 'Nothing entered for this line yet.'}
                            </p>
                            <Button size="sm" variant="ghost" onClick={() => move(row, -1)} disabled={i === 0}><ArrowUp size={12} /> Up</Button>
                            <Button size="sm" variant="ghost" onClick={() => move(row, 1)} disabled={i === form.rows.length - 1}><ArrowDown size={12} /> Down</Button>
                            {first && item && (
                              <Button size="sm" variant="ghost" onClick={() => setItemForm(item)} title="Carton size, codes, dosage form — for every kit that holds it">
                                <Pencil size={12} /> Item details
                              </Button>
                            )}
                            {first && others > 0 && (
                              <Button size="sm" variant="ghost" className="!text-red-600" onClick={() => removeItem(id)}>
                                <PackageMinus size={12} /> Take it out of the kit ({others + 1} lines)
                              </Button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {itemCount > 0 && (
            <tfoot>
              <tr className="border-t border-[#1D1D1F]/10 bg-[#F5F5F7]/60">
                <td className={`${stickyCell} !bg-[#F7F7F9] px-2 py-1.5 text-[11px] font-semibold text-[#6E6E73]`}>
                  {itemCount} item{itemCount > 1 ? 's' : ''} · {form.rows.length} line{form.rows.length > 1 ? 's' : ''}
                </td>
                <td className="px-1.5 py-1.5 text-right text-[11px] font-bold tabular-nums">{qtyText(units)} units</td>
                <td colSpan={10} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1 sm:max-w-[440px]" data-kit-rx-add="1">
          {inner ? (
            <SearchableSelect key={adder} value="" placeholder="Add an item to the kit — type to search…"
              onChange={e => addItem(e.target.value)}
              options={inner.map(p => ({
                value: p.id,
                label: `${p.name}${p.standard_mrp != null ? ` — ₹${qtyText(p.standard_mrp)}` : ''}`,
                search: [p.product_code, p.artwork_code, p.dosage_form].filter(Boolean).join(' '),
                disabled: form.items[p.id] != null,
              }))} />
          ) : (
            <p className="flex h-10 items-center gap-2 text-xs text-[#86868B]"><Loader2 size={13} className="animate-spin" /> Loading the inner product master…</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setCreating(true)}><Plus size={13} /> New inner product…</Button>
        <Button size="sm" variant="ghost" onClick={addFreeLine} title="A line the card prints for something that is not an item in the box"><Type size={13} /> Line for something not in the kit</Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label>
          <span className={lab}>General instructions (whole kit)</span>
          <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.general_instructions}
            onChange={e => touch(f => ({ ...f, general_instructions: e.target.value }))} placeholder="e.g. Continue for 30 days" />
        </label>
        <label>
          <span className={lab}>Remarks</span>
          <textarea rows={2} className={`${box} h-auto py-1.5`} value={form.remarks}
            onChange={e => touch(f => ({ ...f, remarks: e.target.value }))} />
        </label>
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          {stale && onReload && (
            <Button size="sm" variant="secondary" onClick={onReload}><RefreshCw size={12} /> Load the latest (drops my edits)</Button>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={saving} data-kit-rx-save="1">
          {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save kit & prescription
        </Button>
      </div>

      <InnerProductForm open={creating} item={null} onClose={() => setCreating(false)}
        onSaved={created => {
          // Shown by name at once; the full list follows.
          if (created?.id) {
            setInner(list => ((list || []).some(p => p.id === created.id) ? list : [...(list || []), created]));
            addItem(created.id);
          }
          loadInner();
        }} />
      <InnerProductForm open={Boolean(itemForm)} item={itemForm} onClose={() => setItemForm(null)} onSaved={() => loadInner()} />
    </div>
  );
}
