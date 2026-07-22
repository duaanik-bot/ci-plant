// PO Import wizard — upload a customer PO PDF, review auto-mapped lines,
// create the order in one click. Confirmed/corrected mappings are saved as
// per-customer aliases so matching converges to exact for repeat items.
import { useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, ConfirmDialog, Field, Input, Modal, Select, useToast } from './ui.jsx';
import { FileUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';

const chip = {
  matched: 'bg-emerald-50 text-emerald-700',
  suggested: 'bg-amber-50 text-amber-700',
  none: 'bg-red-50 text-red-600',
};
const chipLabel = { matched: 'Matched', suggested: 'Suggested', none: 'No match' };

const emptyLine = () => ({
  raw_text: '', pdf_rate: null, item_code: null, product_id: '', qty: '', rate: '', gst: '',
  party_item_code: '', aw_code: '',
  status: 'none', confidence: null, suggestions: [], learned: false,
});
const lineTax = l => (l.qty && l.rate ? l.qty * l.rate * (Number(l.gst) || 0) / 100 : 0);

export default function ImportPOWizard({ open, onClose, customers, products, gstRates, onCreated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState(null);        // null = upload step
  const [creating, setCreating] = useState(null); // { lineIdx, name, rate, product_type, gst_pct }
  const [localProducts, setLocalProducts] = useState([]); // quick-created this session
  const [confirmRate, setConfirmRate] = useState(null);  // pending master-rate revision
  const [rateOverrides, setRateOverrides] = useState({}); // productId → new master rate applied this session
  const fileRef = useRef(null);

  const allProducts = useMemo(() => [...products, ...localProducts], [products, localProducts]);
  const custProducts = allProducts.filter(p => String(p.customer_id) === String(form?.customer_id) && p.active);

  const gstOf = p => {
    if (!p) return '';
    if (p.gst != null) return p.gst;
    if (p.effective_gst != null) return p.effective_gst;
    if (p.gst_pct != null) return p.gst_pct;
    const t = gstRates.find(g => g.product_type === p.product_type);
    return t ? t.rate : 12;
  };

  const toFormLine = l => {
    const best = l.match?.best;
    return {
      raw_text: l.raw_text, pdf_rate: l.rate ?? null, item_code: l.item_code ?? null,
      product_id: best ? String(best.product_id) : '',
      qty: l.qty ?? '', rate: l.rate ?? best?.rate ?? '', gst: best ? best.gst : '',
      // Party item code prefills from the matched master, else the code we read
      // off the PDF line — so a No-match line arrives ready to save onto the
      // product you pick. AW code only lives on the master.
      party_item_code: best?.party_item_code || l.item_code || '',
      aw_code: best?.party_artwork_code || '',
      status: l.match?.status || 'none', confidence: best?.confidence ?? null,
      suggestions: l.match?.suggestions || [], learned: false,
    };
  };

  const reset = () => { setResult(null); setForm(null); setCreating(null); setBusy(false); setConfirmRate(null); setRateOverrides({}); };
  const close = () => { if (creating) return; reset(); onClose(); };

  const handleFile = async file => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api.upload('/orders/import/parse', file);
      setResult(res);
      setForm({
        po_number: res.po_number || '',
        customer_id: res.customer_id ? String(res.customer_id) : '',
        po_date: res.po_date || '', delivery_date: res.delivery_date || '', notes: '',
        lines: res.lines.length ? res.lines.map(toFormLine) : [emptyLine()],
      });
      res.warnings?.forEach(w => toast.info(w));
    } catch (e) {
      if (e.data?.code === 'scanned') toast.error(e.message);
    } finally { setBusy(false); }
  };

  const rematch = async customerId => {
    if (!customerId) { setForm(f => ({ ...f, customer_id: '' })); return; }
    const raw = form.lines.filter(l => l.raw_text).map(l => ({ raw_text: l.raw_text, qty: l.qty === '' ? null : +l.qty, rate: l.pdf_rate, item_code: l.item_code }));
    if (!raw.length) { setForm(f => ({ ...f, customer_id: String(customerId) })); return; }
    const res = await api.post('/orders/import/rematch', { customer_id: +customerId, lines: raw });
    setForm(f => ({ ...f, customer_id: String(customerId), lines: res.lines.map(toFormLine) }));
  };

  const setLine = (i, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const pickProduct = (i, productId) => {
    const p = custProducts.find(x => String(x.id) === String(productId));
    const cur = form.lines[i];
    setLine(i, {
      product_id: String(productId || ''),
      rate: cur.pdf_rate ?? p?.rate ?? '',
      gst: gstOf(p),
      // Prefer what the planner already typed, then the master's saved codes,
      // then the code read off the PDF line.
      party_item_code: cur.party_item_code || p?.party_item_code || cur.item_code || '',
      aw_code: cur.aw_code || p?.party_artwork_code || '',
      learned: !!productId && !!cur.raw_text,
    });
  };

  // Revise one or more linked product masters' rates to the PO's rate (confirmed
  // by the planner). Writes straight to each master via PUT /products/:id, then
  // applies the new rate locally so the mismatch flag clears and any other line
  // on the same product re-checks against the revised master.
  const applyMasterRates = async (items) => {
    try {
      await Promise.all(items.map(it => api.put(`/products/${it.productId}`, { rate: it.newRate })));
      setRateOverrides(o => { const n = { ...o }; for (const it of items) n[it.productId] = it.newRate; return n; });
      setLocalProducts(ps => ps.map(p => {
        const hit = items.find(it => String(it.productId) === String(p.id));
        return hit ? { ...p, rate: hit.newRate } : p;
      }));
      toast.success(items.length === 1
        ? `Master rate updated: ${items[0].name} (${items[0].code}) → ₹${items[0].newRate}`
        : `${items.length} master rates updated from this PO`);
    } catch { /* central toast already surfaced the error */ }
  };

  const quickCreate = async () => {
    const p = await api.post('/orders/import/quick-product', {
      customer_id: +form.customer_id,
      name: creating.name,
      rate: creating.rate === '' ? 0 : +creating.rate,
      product_type: creating.product_type || null,
      gst_pct: creating.gst_pct === '' ? null : +creating.gst_pct,
    });
    setLocalProducts(ps => [...ps, p]);
    setLine(creating.lineIdx, {
      product_id: String(p.id),
      rate: form.lines[creating.lineIdx].pdf_rate ?? p.rate,
      gst: p.gst, status: 'matched', confidence: 1, learned: true,
    });
    toast.success(`Master created: ${p.name} (${p.code}) — spec incomplete, finish it in Masters`);
    setCreating(null);
  };

  const createOrder = async () => {
    setBusy(true);
    try {
      const kept = form.lines.filter(l => l.product_id && l.qty);
      // learn aliases for every human-confirmed mapping before creating
      await Promise.all(kept.filter(l => l.learned && l.raw_text).map(l =>
        api.post('/orders/import/alias', { customer_id: +form.customer_id, alias_text: l.raw_text, product_id: +l.product_id })));
      // write the party item code / AW code onto each mapped master (partial
      // update — empty cells are omitted so they never wipe an existing value).
      await Promise.all(kept
        .filter(l => (l.party_item_code || '').trim() || (l.aw_code || '').trim())
        .map(l => {
          const body = {};
          if ((l.party_item_code || '').trim()) body.party_item_code = l.party_item_code.trim();
          if ((l.aw_code || '').trim()) body.party_artwork_code = l.aw_code.trim();
          return api.put(`/products/${l.product_id}`, body);
        }));
      await api.post('/orders', {
        po_number: form.po_number, customer_id: +form.customer_id,
        po_date: form.po_date || undefined, delivery_date: form.delivery_date || undefined,
        notes: form.notes || undefined,
        lines: kept.map(l => ({ product_id: +l.product_id, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate, gst: l.gst })),
      });
      toast.success('Order created from PDF');
      onCreated();
      reset();
      onClose();
    } finally { setBusy(false); }
  };

  // Every line whose PO rate differs from its linked master, de-duped by product
  // (so two lines on the same product don't double-count) — drives the bulk
  // "Update all" control.
  const rateMismatches = (() => {
    if (!form) return [];
    const seen = new Set(); const out = [];
    for (const l of form.lines) {
      if (l.pdf_rate == null || !l.product_id) continue;
      const prod = custProducts.find(p => String(p.id) === String(l.product_id));
      if (!prod || seen.has(prod.id)) continue;
      const masterRate = Number(rateOverrides[prod.id] ?? prod.rate);
      if (masterRate !== Number(l.pdf_rate)) {
        seen.add(prod.id);
        out.push({ productId: prod.id, name: prod.name, code: prod.code, oldRate: masterRate, newRate: Number(l.pdf_rate) });
      }
    }
    return out;
  })();

  const totals = (form?.lines || []).reduce((t, l) => {
    if (l.qty && l.rate) { t.taxable += l.qty * l.rate; t.gst += lineTax(l); }
    return t;
  }, { taxable: 0, gst: 0 });
  const ready = form && form.po_number && form.customer_id && form.lines.some(l => l.product_id && l.qty);

  return (
    <>
      <Modal open={open} onClose={close} title="Import Customer PO" wide
        footer={form ? <>
          <Button variant="secondary" onClick={close}>Cancel</Button>
          <Button onClick={createOrder} disabled={!ready || busy}><Sparkles size={14} /> Create Order</Button>
        </> : <Button variant="secondary" onClick={close}>Cancel</Button>}>

        {!form && (
          <label className="flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/60 p-8 text-center hover:border-blue-300 hover:bg-blue-50/40"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}>
            {busy ? <Loader2 size={28} className="animate-spin text-blue-500" /> : <FileUp size={28} className="text-slate-400" />}
            <div className="text-sm font-semibold text-slate-600">{busy ? 'Reading the PDF…' : 'Drop the customer PO PDF here, or click to choose'}</div>
            <div className="text-xs text-slate-400">Digital PDFs only (text-selectable) — scans need the original file</div>
            <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={e => { handleFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
        )}

        {form && (
          <div className="space-y-4">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Customer PO</span>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-700">From PDF — check &amp; edit</span></div>
              <div className="ci-form-grid">
                <Field label="Customer PO Number" required><Input value={form.po_number} onChange={e => setForm({ ...form, po_number: e.target.value })} /></Field>
                <Field label="Customer" required
                  hint={result?.customer_candidates?.length > 1 ? `Also possible: ${result.customer_candidates.slice(1).map(c => c.name).join(', ')}` : undefined}>
                  <Select value={form.customer_id} onChange={e => rematch(e.target.value)}>
                    <option value="">Select customer…</option>
                    {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
                <Field label="PO Date"><Input type="date" value={form.po_date} onChange={e => setForm({ ...form, po_date: e.target.value })} /></Field>
                <Field label="Delivery Date"><Input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} /></Field>
              </div>
            </section>

            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Mapped Lines</span>
                <span className="flex items-center gap-2">
                  {rateMismatches.length >= 2 && (
                    <button type="button"
                      className="rounded-full bg-blue-600 px-2.5 py-0.5 text-[10px] font-bold text-white hover:bg-blue-700"
                      onClick={() => setConfirmRate({ items: rateMismatches })}>
                      Update all {rateMismatches.length} master rates
                    </button>
                  )}
                  <span>{form.lines.filter(l => l.product_id && l.qty).length} of {form.lines.length} ready</span>
                </span></div>
              <div className="space-y-2">
                {form.lines.map((l, i) => {
                  const prod = custProducts.find(p => String(p.id) === String(l.product_id));
                  const masterRate = prod ? Number(rateOverrides[prod.id] ?? prod.rate) : null;
                  const rateMismatch = l.pdf_rate != null && prod && masterRate !== Number(l.pdf_rate);
                  return (
                    <div key={i} className="ci-line-item">
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${chip[l.status]}`}>
                          {chipLabel[l.status]}{l.confidence != null && l.status !== 'none' ? ` ${Math.round(l.confidence * 100)}%` : ''}
                        </span>
                        {l.raw_text && <span className="max-w-[420px] truncate text-[11px] text-slate-400" title={l.raw_text}>PDF: “{l.raw_text}”</span>}
                        {rateMismatch && (
                          <span className="inline-flex items-center gap-1">
                            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">PDF ₹{l.pdf_rate} · Master ₹{masterRate}</span>
                            <button type="button"
                              className="rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-blue-700"
                              onClick={() => setConfirmRate({ items: [{ productId: prod.id, name: prod.name, code: prod.code, oldRate: masterRate, newRate: Number(l.pdf_rate) }] })}>
                              Update master → ₹{l.pdf_rate}
                            </button>
                          </span>
                        )}
                        {prod?.spec_incomplete ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">Spec incomplete</span> : null}
                      </div>
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_92px_100px_84px_118px_40px] md:items-start">
                        <div className="min-w-0">
                          {l.status === 'suggested' && !l.product_id ? (
                            <Select value="" onChange={e => pickProduct(i, e.target.value)}>
                              <option value="">Pick the right product…</option>
                              {l.suggestions.map(s => <option key={s.product_id} value={s.product_id}>{s.name} ({s.code}) — {Math.round(s.confidence * 100)}%</option>)}
                              <option value="" disabled>──────────</option>
                              {custProducts.map(p => <option key={`all-${p.id}`} value={p.id}>{p.name} ({p.code})</option>)}
                            </Select>
                          ) : l.status === 'none' && !l.product_id ? (
                            <div className="flex gap-2">
                              <div className="min-w-0 flex-1">
                                <Select value="" onChange={e => pickProduct(i, e.target.value)}>
                                  <option value="">{form.customer_id ? 'Map to existing product…' : 'Pick a customer first'}</option>
                                  {custProducts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                                </Select>
                              </div>
                              <Button size="sm" variant="secondary" disabled={!form.customer_id}
                                onClick={() => setCreating({ lineIdx: i, name: l.raw_text, rate: l.pdf_rate ?? '', product_type: '', gst_pct: '' })}>
                                <Plus size={13} /> Create master
                              </Button>
                            </div>
                          ) : (
                            <Select value={l.product_id} onChange={e => pickProduct(i, e.target.value)}>
                              <option value="">Select product…</option>
                              {custProducts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
                            </Select>
                          )}
                        </div>
                        <Input type="number" min="1" placeholder="Qty" value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} />
                        <Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} />
                        <Input type="number" step="0.01" min="0" placeholder="GST %" title="GST % — defaults from product type" value={l.gst ?? ''} onChange={e => setLine(i, { gst: e.target.value })} />
                        <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                          {l.qty && l.rate ? fmt.inr(l.qty * l.rate + lineTax(l)) : '—'}
                        </div>
                        <button type="button" title="Drop line" className="flex h-10 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500"
                          onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {l.product_id && (
                        <div className="mt-2 grid grid-cols-1 gap-2 border-t border-slate-100 pt-2 md:grid-cols-2">
                          <label className="flex items-center gap-2">
                            <span className="w-[104px] shrink-0 text-[11px] font-semibold text-slate-400">Party Item Code</span>
                            <Input value={l.party_item_code || ''} placeholder="e.g. PCS-O253"
                              onChange={e => setLine(i, { party_item_code: e.target.value })} />
                          </label>
                          <label className="flex items-center gap-2">
                            <span className="w-[104px] shrink-0 text-[11px] font-semibold text-slate-400">AW Code</span>
                            <Input value={l.aw_code || ''} placeholder="artwork code"
                              onChange={e => setLine(i, { aw_code: e.target.value })} />
                          </label>
                          <span className="text-[10px] text-slate-300 md:col-span-2">
                            Saved onto {prod ? `${prod.name} (${prod.code})` : 'this product master'} when you create the order — so next time this PO matches on its own.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }))}>
                  <Plus size={13} /> Add line
                </Button>
                {totals.taxable > 0 && (
                  <div className="min-w-[180px] rounded-xl bg-slate-50 px-4 py-2 text-right text-xs tabular-nums">
                    <div className="flex justify-between gap-6 text-slate-500"><span>Taxable</span><span>{fmt.inr(totals.taxable)}</span></div>
                    <div className="flex justify-between gap-6 text-slate-500"><span>GST</span><span>{fmt.inr(totals.gst)}</span></div>
                    <div className="mt-1 flex justify-between gap-6 border-t border-slate-200 pt-1 font-bold text-slate-800"><span>Total</span><span>{fmt.inr(totals.taxable + totals.gst)}</span></div>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </Modal>

      {/* Confirm before revising one or more product master rates from the PO */}
      <ConfirmDialog open={!!confirmRate} onClose={() => setConfirmRate(null)}
        title={confirmRate?.items?.length > 1 ? 'Update master rates?' : 'Update master rate?'}
        confirmLabel={confirmRate?.items?.length > 1 ? `Update ${confirmRate.items.length} masters` : 'Update master'}
        message={confirmRate ? (confirmRate.items.length === 1
          ? `Revise the saved rate for ${confirmRate.items[0].name} (${confirmRate.items[0].code}) from ₹${confirmRate.items[0].oldRate} to ₹${confirmRate.items[0].newRate} per carton? This updates the product master and applies to future orders.`
          : (
            <>
              Revise these {confirmRate.items.length} product master rates to match this PO? This applies to future orders.
              {confirmRate.items.map(it => (
                <span key={it.productId} className="mt-1.5 block text-xs text-slate-500">
                  • {it.name} <span className="text-slate-400">({it.code})</span>: ₹{it.oldRate} → <b className="text-slate-700">₹{it.newRate}</b>
                </span>
              ))}
            </>
          )) : ''}
        onConfirm={() => applyMasterRates(confirmRate.items)} />

      {/* Quick-create master — rendered after the parent Modal so it stacks on top */}
      <Modal open={!!creating} onClose={() => setCreating(null)} title="Create Product Master"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
          <Button onClick={quickCreate} disabled={!creating?.name?.trim()}>Create — finish spec later</Button>
        </>}>
        {creating && (
          <div className="space-y-3">
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Board and technical spec get placeholders and the product is flagged <b>Spec incomplete</b> — complete it in Masters before it can go to production.
            </p>
            <Field label="Product Name" required><Input value={creating.name} onChange={e => setCreating({ ...creating, name: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Rate ₹"><Input type="number" step="0.01" value={creating.rate} onChange={e => setCreating({ ...creating, rate: e.target.value })} /></Field>
              <Field label="Product Type">
                <Select value={creating.product_type} onChange={e => setCreating({ ...creating, product_type: e.target.value })}>
                  <option value="">—</option>
                  {gstRates.filter(g => g.active !== 0).map(g => <option key={g.product_type} value={g.product_type}>{g.label} ({g.rate}%)</option>)}
                </Select>
              </Field>
              <Field label="GST % Override"><Input type="number" step="1" min="0" placeholder="auto" value={creating.gst_pct} onChange={e => setCreating({ ...creating, gst_pct: e.target.value })} /></Field>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
