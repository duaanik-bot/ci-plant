// PO Import wizard — upload a customer PO PDF, review auto-mapped lines,
// create the order in one click. Confirmed/corrected mappings are saved as
// per-customer aliases so matching converges to exact for repeat items.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../api.js';
import { Button, ConfirmDialog, Field, Input, Modal, searchText, Select, useToast } from './ui.jsx';
import { FileUp, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';

const chip = {
  matched: 'bg-emerald-50 text-emerald-700',
  suggested: 'bg-amber-50 text-amber-700',
  none: 'bg-red-50 text-red-600',
};
const chipLabel = { matched: 'Matched', suggested: 'Suggested', none: 'No match' };
const COATINGS = ['Aqueous Varnish', 'Aqueous Varnish + Spot UV', 'Drip Off', 'Full UV'];
const PASTING_TYPES = ['BSO', 'LOCK BOTTOM'];
const COLOUR_TYPES = ['CMYK', 'Pantone', 'CMYK + Pantone'];

const emptyLine = () => ({
  raw_text: '', pdf_rate: null, item_code: null, product_id: '', qty: '', rate: '', gst: '',
  artwork_code: null, party_item_code: '', aw_code: '',
  name_text: '', carton_size: '', board_grade: '', gsm: '', coating: '',
  die_code: '', sheet_size: '', ups: '', pasting_type: '',
  status: 'none', confidence: null, suggestions: [], foreign: null, learned: false,
});
const lineTax = l => (l.qty && l.rate ? l.qty * l.rate * (Number(l.gst) || 0) / 100 : 0);
const numOrNull = v => (v === '' || v == null ? null : +v);
const str = v => String(v ?? '').trim();
const boardGradeOf = b => b?.grade || (str(b?.name).match(/^([^ ·]+)/)?.[1] ?? '');
const boardGsmOf = b => b?.gsm ?? (str(b?.name).match(/\b(\d{2,4})\s*GSM\b/i)?.[1] ?? '');
const withoutLeadCode = s => str(s).replace(/^(?=\S*\d)[A-Za-z][A-Za-z0-9/\-.]{3,24}\s+/, '').replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, '').replace(/\s+/g, ' ').trim();
const sizeKey = value => str(value).toLowerCase().replace(/[×"]/g, 'x').replace(/\s*x\s*/g, 'x').replace(/\b(mm|cm|inches|inch|in)\b/g, '').replace(/\s+/g, '').replace(/x+$/g, '');
const codeKey = value => str(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
const splitSize2 = value => {
  const m = str(value).replace(/[×]/g, 'x').match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  return m ? { l: m[1], w: m[2] } : null;
};
const sameDims = (a, b, c, d) => {
  const x = [+a, +b].sort((m, n) => m - n);
  const y = [+c, +d].sort((m, n) => m - n);
  return x.every(Number.isFinite) && y.every(Number.isFinite)
    && Math.abs(x[0] - y[0]) < 0.01 && Math.abs(x[1] - y[1]) < 0.01;
};

export default function ImportPOWizard({ open, onClose, customers, products, gstRates, onCreated }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [form, setForm] = useState(null);        // null = upload step
  const [creating, setCreating] = useState(null); // { lineIdx, name, rate, product_type, gst_pct }
  const [localProducts, setLocalProducts] = useState([]); // quick-created this session
  const [confirmRate, setConfirmRate] = useState(null);  // pending master-rate revision
  const [rateOverrides, setRateOverrides] = useState({}); // productId → new master rate applied this session
  const [migrating, setMigrating] = useState(null);      // { lineIdx, product } — pending cross-customer move
  const [materials, setMaterials] = useState([]);
  const [dies, setDies] = useState([]);
  const fileRef = useRef(null);

  const allProducts = useMemo(() => [...products, ...localProducts], [products, localProducts]);
  const custProducts = allProducts.filter(p => String(p.customer_id) === String(form?.customer_id) && p.active);
  const boards = materials.filter(m => m.category === 'board' && (m.active ?? 1) && !m.leftover);

  useEffect(() => {
    if (!open) return;
    Promise.all([
      api.get('/materials').catch(() => []),
      api.get('/tools?family=die').catch(() => []),
    ]).then(([mats, dieRows]) => { setMaterials(mats); setDies(dieRows); });
  }, [open]);

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
      artwork_code: l.artwork_code ?? null, name_text: l.name_text || '',
      carton_size: l.carton_size || '', board_grade: l.board_grade || '',
      gsm: l.gsm ?? '', coating: l.coating || '',
      die_code: l.die_code || '', sheet_size: l.sheet_size || '',
      ups: l.ups ?? '', pasting_type: l.pasting_type || '',
      product_id: best ? String(best.product_id) : '',
      qty: l.qty ?? '', rate: l.rate ?? best?.rate ?? '', gst: best ? best.gst : '',
      // Party item code prefills from the matched master, else the code we read
      // off the PDF line — so a No-match line arrives ready to save onto the
      // product you pick. AW code only lives on the master.
      party_item_code: best?.party_item_code || l.item_code || '',
      aw_code: best?.party_artwork_code || l.artwork_code || '',
      status: l.match?.status || 'none', confidence: best?.confidence ?? null,
      suggestions: l.match?.suggestions || [], foreign: l.match?.foreign || null, learned: false,
    };
  };

  const reset = () => { setResult(null); setForm(null); setCreating(null); setBusy(false); setConfirmRate(null); setRateOverrides({}); setMigrating(null); };
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
    const raw = form.lines.filter(l => l.raw_text).map(l => ({
      raw_text: l.raw_text, qty: l.qty === '' ? null : +l.qty, rate: l.pdf_rate,
      item_code: l.item_code, artwork_code: l.artwork_code, name_text: l.name_text,
      carton_size: l.carton_size, board_grade: l.board_grade, gsm: l.gsm, coating: l.coating,
      die_code: l.die_code, sheet_size: l.sheet_size, ups: l.ups, pasting_type: l.pasting_type,
    }));
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
      aw_code: cur.aw_code || p?.party_artwork_code || cur.artwork_code || '',
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

  const boardForLine = l => {
    const grade = str(l.board_grade).toLowerCase();
    const gsm = str(l.gsm);
    const sheet = splitSize2(l.sheet_size);
    if (!grade && !gsm && !sheet) return null;
    const scored = boards.map(b => {
      const bg = boardGradeOf(b).toLowerCase();
      const gg = str(boardGsmOf(b));
      let score = 0;
      if (grade && bg === grade) score += 3;
      if (gsm && gg === gsm) score += 2;
      if (sheet && sameDims(sheet.l, sheet.w, b.sheet_l, b.sheet_w)) score += 2;
      return { board: b, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    return scored[0]?.board || null;
  };

  const dieForLine = l => {
    const wantedCode = codeKey(l.die_code);
    const carton = sizeKey(l.carton_size);
    const sheet = sizeKey(l.sheet_size);
    const ups = numOrNull(l.ups);
    const scored = dies.map(d => {
      let score = 0;
      if (wantedCode && codeKey(d.code) === wantedCode) score += 100;
      if (carton && sizeKey(d.carton_size) === carton) score += 5;
      if (sheet && sizeKey(d.sheet_size) === sheet) score += 4;
      if (ups && Number(d.ups) === ups) score += 1;
      return { die: d, score };
    }).filter(x => x.score >= 4 || x.score >= 100).sort((a, b) => b.score - a.score);
    return scored[0]?.die || null;
  };

  const cartonType = () => gstRates.find(g => g.active !== 0 && /carton/i.test(`${g.product_type} ${g.label}`))?.product_type || '';

  const createDraftFromLine = (l, lineIdx) => {
    const board = boardForLine(l);
    const die = dieForLine(l);
    const dieSheet = splitSize2(die?.sheet_size);
    const parsedSheet = splitSize2(l.sheet_size);
    const sheet = dieSheet || parsedSheet;
    return {
      lineIdx,
      name: str(l.name_text) || withoutLeadCode(l.raw_text),
      internal_code: '',
      party_item_code: l.party_item_code || l.item_code || '',
      party_artwork_code: l.aw_code || l.artwork_code || '',
      tool_id: die ? String(die.id) : '',
      die_number: l.die_code || die?.code || '',
      board_material_id: board ? String(board.id) : '',
      board_grade: l.board_grade || (board ? boardGradeOf(board) : ''),
      gsm: l.gsm || (board ? boardGsmOf(board) : ''),
      size: l.carton_size || die?.carton_size || '',
      sheet_size: l.sheet_size || die?.sheet_size || '',
      child_l: sheet?.l || '', child_w: sheet?.w || '',
      parent_l: board?.sheet_l ?? '', parent_w: board?.sheet_w ?? '',
      ups: l.ups || die?.ups || '', colors: die?.colors || 4, colour_type: 'CMYK',
      coating: l.coating || '', pasting_type: l.pasting_type || '',
      product_type: cartonType(), gst_pct: '', rate: l.pdf_rate ?? '',
      spec_incomplete: 1,
    };
  };

  const setCreate = patch => setCreating(c => ({ ...c, ...patch }));
  const setCreateSheetSize = value => {
    const sheet = splitSize2(value);
    setCreating(c => ({
      ...c,
      sheet_size: value,
      child_l: sheet?.l || c.child_l,
      child_w: sheet?.w || c.child_w,
    }));
  };
  const pickCreateBoard = boardId => {
    const board = boards.find(b => String(b.id) === String(boardId));
    setCreating(c => ({
      ...c,
      board_material_id: boardId,
      board_grade: c.board_grade || boardGradeOf(board),
      gsm: c.gsm || boardGsmOf(board),
      parent_l: c.parent_l || board?.sheet_l || '',
      parent_w: c.parent_w || board?.sheet_w || '',
    }));
  };
  const pickCreateDie = dieId => {
    const die = dies.find(d => String(d.id) === String(dieId));
    const sheet = splitSize2(die?.sheet_size);
    setCreating(c => ({
      ...c,
      tool_id: dieId,
      die_number: die?.code || c.die_number || '',
      size: c.size || die?.carton_size || '',
      sheet_size: c.sheet_size || die?.sheet_size || '',
      child_l: c.child_l || sheet?.l || '',
      child_w: c.child_w || sheet?.w || '',
      ups: c.ups || die?.ups || '',
      colors: c.colors || die?.colors || 4,
    }));
  };

  const quickCreate = async () => {
    const p = await api.post('/orders/import/quick-product', {
      customer_id: +form.customer_id,
      name: creating.name,
      code: creating.internal_code || null,
      party_item_code: creating.party_item_code || null,
      party_artwork_code: creating.party_artwork_code || null,
      board_material_id: numOrNull(creating.board_material_id),
      board_grade: creating.board_grade || null,
      gsm: numOrNull(creating.gsm),
      size: creating.size || null,
      sheet_size: creating.sheet_size || null,
      child_l: numOrNull(creating.child_l),
      child_w: numOrNull(creating.child_w),
      parent_l: numOrNull(creating.parent_l),
      parent_w: numOrNull(creating.parent_w),
      ups: numOrNull(creating.ups),
      colors: numOrNull(creating.colors),
      colour_type: creating.colour_type || 'CMYK',
      coating: creating.coating || null,
      pasting_type: creating.pasting_type || null,
      die_number: creating.die_number || null,
      tool_id: numOrNull(creating.tool_id),
      rate: creating.rate === '' ? 0 : +creating.rate,
      product_type: creating.product_type || null,
      gst_pct: creating.gst_pct === '' ? null : +creating.gst_pct,
      spec_incomplete: +creating.spec_incomplete ? 1 : 0,
    });
    setLocalProducts(ps => [...ps, p]);
    setLine(creating.lineIdx, {
      product_id: String(p.id),
      rate: form.lines[creating.lineIdx].pdf_rate ?? p.rate,
      gst: p.gst, status: 'matched', confidence: 1, learned: true,
      party_item_code: p.party_item_code || creating.party_item_code || '',
      aw_code: p.party_artwork_code || creating.party_artwork_code || '',
      carton_size: p.size || creating.size || '',
      board_grade: p.board_grade || creating.board_grade || '',
      gsm: p.gsm || creating.gsm || '',
      coating: p.coating || creating.coating || '',
      die_code: p.die_number || creating.die_number || '',
      ups: p.ups || creating.ups || '',
      pasting_type: p.pasting_type || creating.pasting_type || '',
    });
    toast.success(`Master saved: ${p.name} (${p.code})`);
    setCreating(null);
  };

  // A line's product living under a sister customer (SGBT <-> SGLS moves are
  // routine): one confirmed click re-homes the master — new owner, next code in
  // their series, aliases carried along — then uses it on this line. The line is
  // marked learned so submitting also teaches this PO's wording to the new owner.
  const migrateAndUse = async () => {
    const { lineIdx, product } = migrating;
    try {
      const p = await api.post(`/products/${product.product_id}/migrate-customer`, { customer_id: +form.customer_id });
      // Set the line from the response directly (same pattern as quickCreate):
      // custProducts has not re-rendered yet, so pickProduct cannot see p here.
      setLocalProducts(ps => [...ps, p]);
      const cur = form.lines[lineIdx];
      setLine(lineIdx, {
        product_id: String(p.id),
        rate: cur.pdf_rate ?? p.rate ?? '',
        gst: p.gst,
        party_item_code: cur.party_item_code || p.party_item_code || cur.item_code || '',
        aw_code: cur.aw_code || p.party_artwork_code || '',
        status: 'matched', confidence: product.confidence, foreign: null, learned: true,
      });
      toast.success(`${p.name} moved from ${product.customer_name} — now ${p.code}`);
    } catch { /* central toast already surfaced the error */ }
    setMigrating(null);
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
                    {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
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
                  // The line's product found under a SISTER customer — offered
                  // beneath whichever picker branch renders, never auto-applied.
                  const foreignChip = l.foreign && !l.product_id && form.customer_id ? (
                    <div className="flex items-center gap-2 rounded-lg bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-700">
                      <span className="min-w-0 flex-1 truncate">
                        Found under <b>{l.foreign.customer_name}</b>: {l.foreign.name} <span className="text-violet-400">({l.foreign.code})</span> — {Math.round(l.foreign.confidence * 100)}%
                      </span>
                      <button type="button"
                        className="shrink-0 rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-violet-700"
                        onClick={() => setMigrating({ lineIdx: i, product: l.foreign })}>
                        Move here &amp; use
                      </button>
                    </div>
                  ) : null;
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
                      <div className="ci-line-grid grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_92px_100px_84px_118px_40px] md:items-start">
                        <div className="ci-line-key min-w-0">
                          <div className="space-y-1.5">
                            <div className="flex items-start gap-1.5">
                              <div className="min-w-0 flex-1">
                                {l.status === 'suggested' && !l.product_id ? (
                                  <Select value="" onChange={e => pickProduct(i, e.target.value)}>
                                    <option value="">Pick the right product…</option>
                                    {l.suggestions.map(s => <option key={s.product_id} value={s.product_id} data-search={searchText(s)}>{s.name} ({s.code}) — {Math.round(s.confidence * 100)}%</option>)}
                                    <option value="" disabled>──────────</option>
                                    {custProducts.map(p => <option key={`all-${p.id}`} value={p.id} data-search={searchText(p)}>{p.name} ({p.code})</option>)}
                                  </Select>
                                ) : l.status === 'none' && !l.product_id ? (
                                  <Select value="" onChange={e => pickProduct(i, e.target.value)}>
                                    <option value="">{form.customer_id ? 'Map to existing product…' : 'Pick a customer first'}</option>
                                    {custProducts.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name} ({p.code})</option>)}
                                  </Select>
                                ) : (
                                  <Select value={l.product_id} onChange={e => pickProduct(i, e.target.value)}>
                                    <option value="">Select product…</option>
                                    {custProducts.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name} ({p.code})</option>)}
                                  </Select>
                                )}
                              </div>
                              {/* The door out of a wrong guess. Keyed on the line having no
                                  product committed — NOT on the matcher's band. A 0.74
                                  "Suggested" is exactly when a genuinely new SKU resembles
                                  a sibling, and scrubbing the item code and date out of the
                                  line lifted a whole class of those from "No match" (where
                                  this button lived) into "Suggested" (where it did not).
                                  Same affordance as the sales-order line — see Orders.jsx. */}
                              {!l.product_id && (
                                <button type="button" disabled={!form.customer_id}
                                  title={form.customer_id ? 'Create a new product master for this line' : 'Pick a customer first'}
                                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                                  onClick={() => setCreating(createDraftFromLine(l, i))}>
                                  <Plus size={15} />
                                </button>
                              )}
                            </div>
                            {foreignChip}
                          </div>
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
                            <span className="w-[104px] shrink-0 text-[11px] font-semibold text-slate-400">Item Code</span>
                            <Input value={l.party_item_code || ''} placeholder="e.g. PCS-O253"
                              onChange={e => setLine(i, { party_item_code: e.target.value })} />
                          </label>
                          <label className="flex items-center gap-2">
                            <span className="w-[104px] shrink-0 text-[11px] font-semibold text-slate-400">Artwork Code</span>
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

      {/* Confirm before re-homing a product master to this PO's customer */}
      <ConfirmDialog open={!!migrating} onClose={() => setMigrating(null)}
        title="Move product to this customer?"
        confirmLabel="Move & use"
        message={migrating ? `${migrating.product.name} currently belongs to ${migrating.product.customer_name} as ${migrating.product.code}. Move it to ${customers.find(c => String(c.id) === String(form?.customer_id))?.name || 'this customer'}? It gets the next code in their series, and its order history stays attached.` : ''}
        onConfirm={migrateAndUse} />

      {/* Quick-create master — rendered after the parent Modal so it stacks on top */}
      <Modal open={!!creating} onClose={() => setCreating(null)} wide title="Create Product Master"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(null)}>Cancel</Button>
          <Button onClick={quickCreate} disabled={!creating?.name?.trim()}>Save Master &amp; Use</Button>
        </>}>
        {creating && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Product Name" required><Input value={creating.name} onChange={e => setCreate({ name: e.target.value })} /></Field>
              <Field label="Internal Code"><Input className="font-mono" placeholder="auto" value={creating.internal_code} onChange={e => setCreate({ internal_code: e.target.value })} /></Field>
              <Field label="Item Code"><Input value={creating.party_item_code} onChange={e => setCreate({ party_item_code: e.target.value })} /></Field>
              <Field label="Artwork Code"><Input value={creating.party_artwork_code} onChange={e => setCreate({ party_artwork_code: e.target.value })} /></Field>
              <Field label="Carton Dimensions"><Input value={creating.size} placeholder="L×W×H" onChange={e => setCreate({ size: e.target.value })} /></Field>
              <Field label="Coating"><Input value={creating.coating} placeholder="e.g. Aqueous Varnish" list="po-import-coatings" onChange={e => setCreate({ coating: e.target.value })} /></Field>
              <datalist id="po-import-coatings">{COATINGS.map(c => <option key={c} value={c} />)}</datalist>
              <Field label="Die">
                <Select value={creating.tool_id} onChange={e => pickCreateDie(e.target.value)}>
                  <option value="">No linked die</option>
                  {dies.map(d => (
                    <option key={d.id} value={d.id} data-search={searchText(d)}>
                      {d.code}{d.carton_size ? ` — ${d.carton_size}` : ''}{d.sheet_size ? ` · ${d.sheet_size}` : ''}{d.ups ? ` · ${d.ups} ups` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Die Number"><Input value={creating.die_number} onChange={e => setCreate({ die_number: e.target.value })} /></Field>
              <Field label="Print Sheet Size"><Input value={creating.sheet_size} placeholder="e.g. 15.75×20.75" onChange={e => setCreateSheetSize(e.target.value)} /></Field>
              <Field label="Pasting Type">
                <Select value={creating.pasting_type} onChange={e => setCreate({ pasting_type: e.target.value })}>
                  <option value="">—</option>
                  {PASTING_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
                </Select>
              </Field>
              <Field label="Board">
                <Select value={creating.board_material_id} onChange={e => pickCreateBoard(e.target.value)}>
                  <option value="">Unspecified board</option>
                  {boards.map(b => <option key={b.id} value={b.id} data-search={searchText(b)}>{b.name}</option>)}
                </Select>
              </Field>
              <Field label="Board Grade"><Input value={creating.board_grade} onChange={e => setCreate({ board_grade: e.target.value })} /></Field>
              <Field label="GSM"><Input type="number" value={creating.gsm} onChange={e => setCreate({ gsm: e.target.value })} /></Field>
              <Field label="Ups per Print Sheet"><Input type="number" value={creating.ups} onChange={e => setCreate({ ups: e.target.value })} /></Field>
              <Field label="Child Sheet Length"><Input type="number" step="0.01" value={creating.child_l} onChange={e => setCreate({ child_l: e.target.value })} /></Field>
              <Field label="Child Sheet Width"><Input type="number" step="0.01" value={creating.child_w} onChange={e => setCreate({ child_w: e.target.value })} /></Field>
              <Field label="Parent Sheet Length"><Input type="number" step="0.01" value={creating.parent_l} onChange={e => setCreate({ parent_l: e.target.value })} /></Field>
              <Field label="Parent Sheet Width"><Input type="number" step="0.01" value={creating.parent_w} onChange={e => setCreate({ parent_w: e.target.value })} /></Field>
              <Field label="Total Colours"><Input type="number" value={creating.colors} onChange={e => setCreate({ colors: e.target.value })} /></Field>
              <Field label="Colour Type">
                <Select value={creating.colour_type} onChange={e => setCreate({ colour_type: e.target.value })}>
                  {COLOUR_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
                </Select>
              </Field>
              <Field label="Product Type">
                <Select value={creating.product_type} onChange={e => setCreate({ product_type: e.target.value })}>
                  <option value="">—</option>
                  {gstRates.filter(g => g.active !== 0).map(g => <option key={g.product_type} value={g.product_type}>{g.label} ({g.rate}%)</option>)}
                </Select>
              </Field>
              <Field label="GST % Override"><Input type="number" step="1" min="0" placeholder="auto" value={creating.gst_pct} onChange={e => setCreate({ gst_pct: e.target.value })} /></Field>
              <Field label="Rate ₹"><Input type="number" step="0.01" value={creating.rate} onChange={e => setCreate({ rate: e.target.value })} /></Field>
              <Field label="Spec Incomplete">
                <Select value={String(creating.spec_incomplete ?? 1)} onChange={e => setCreate({ spec_incomplete: +e.target.value })}>
                  <option value="1">Yes</option>
                  <option value="0">No</option>
                </Select>
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
