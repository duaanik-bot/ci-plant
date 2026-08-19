import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Minus, PackagePlus, SlidersHorizontal } from 'lucide-react';
import { api, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { AgeChip, Button, DataTable, Field, Input, Modal, Select, Textarea, useToast } from './ui.jsx';
import ProductIdentity, { productExport, productSearchText } from './ProductIdentity.jsx';

const AGE_BANDS = [['0-30d', 'bg-emerald-400'], ['31-60d', 'bg-amber-400'], ['61-90d', 'bg-orange-400'], ['90d+', 'bg-red-500']];
const bandIdx = d => d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;

function AgeBar({ items, unit = 'lines' }) {
  const counts = [0, 0, 0, 0];
  for (const d of items) { if (d != null) counts[bandIdx(d)]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/60 px-4 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Age in stock</span>
      <div className="flex h-2.5 min-w-[160px] flex-1 overflow-hidden rounded-full bg-slate-100">
        {AGE_BANDS.map(([label, cls], i) => counts[i] > 0 && (
          <div key={label} className={cls} style={{ width: `${counts[i] / total * 100}%` }} title={`${label} - ${counts[i]} ${unit}`} />
        ))}
      </div>
      <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-500">
        {AGE_BANDS.map(([label, cls], i) => (
          <span key={label} className="flex items-center gap-1"><span className={`inline-block h-2 w-2 rounded-full ${cls}`} />{label}: <span className="tabular-nums text-slate-700">{counts[i]}</span></span>
        ))}
      </div>
    </div>
  );
}

function SubTabs({ active, onChange, tabs }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-slate-100/80 p-1">
      {tabs.map(t => (
        <button key={t.key} type="button" onClick={() => onChange(t.key)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${active === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-slate-200/80 px-1.5 text-[10px] tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

const ADD_BLANK = { product_id: '', qty: '', box_number: '', location: '', note: '' };
const ADJ_BLANK = { product_id: '', mode: 'add', qty: '', actual: '', note: '' };
const ADD_REASONS = ['Opening stock', 'Physical count — found on rack', 'Customer return', 'Sample stock'];

export default function FgStockPanel({ onCountsChange }) {
  const toast = useToast();
  const nav = useNavigate();
  const [fg, setFg] = useState([]);
  const [leftoverFg, setLeftoverFg] = useState([]);
  const [products, setProducts] = useState([]);
  const [fgSub, setFgSub] = useState('in');
  const [fgSel, setFgSel] = useState(() => new Set());
  const [pickedBoxes, setPickedBoxes] = useState([]);
  const [move, setMove] = useState(null);
  const [saving, setSaving] = useState(false);

  // Add-a-leftover-box and adjust-loose-stock. Two doors, deliberately separate:
  // a box is a numbered physical thing on the Leftover shelf, loose FG is a pool.
  const [addOpen, setAddOpen] = useState(false);
  const [add, setAdd] = useState(ADD_BLANK);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adj, setAdj] = useState(ADJ_BLANK);

  const pickedRows = leftoverFg.filter(l => pickedBoxes.includes(l.id));

  const load = async () => {
    try {
      const [fgRows, leftoverRows] = await Promise.all([
        api.get('/inventory/fg'),
        api.get('/inventory/leftover-fg'),
      ]);
      setFg(fgRows);
      setLeftoverFg(leftoverRows);
      onCountsChange?.({ in: fgRows.length, leftover: leftoverRows.length });
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not load FG stock');
    }
  };
  useEffect(() => { load(); }, []);
  // The picker lists the whole Product Master, not just what is already in FG.
  // Seeding opening stock for a product the ERP has never produced is the point
  // of these two doors, and such a product has no fg_stock row to be found in.
  useEffect(() => { api.get('/products').then(setProducts).catch(() => {}); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 500 });

  // ── Add a leftover box ──────────────────────────────────────────────────
  const addProduct = products.find(p => String(p.id) === String(add.product_id));
  const saveAdd = async () => {
    setSaving(true);
    try {
      const lot = await api.post('/fg-lots/manual', {
        product_id: +add.product_id,
        qty: Math.floor(+add.qty || 0),
        box_number: add.box_number.trim(),
        location: add.location.trim(),
        note: add.note.trim(),
      });
      toast.success(`Box ${lot.box_number || lot.lot_number} added — ${fmt.num(lot.qty)} cartons`);
      setAddOpen(false);
      setAdd(ADD_BLANK);
      setFgSub('leftover');
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not add leftover stock');
    } finally {
      setSaving(false);
    }
  };

  // ── Adjust loose FG stock — the same shape as the RM warehouse's dialog ──
  // The operator types EITHER the quantity to move OR the figure actually
  // counted; the other one, and the add/reduce direction, are derived. Nobody
  // types a signed number and nobody does the arithmetic.
  const adjProduct = products.find(p => String(p.id) === String(adj.product_id));
  const adjAvail = +fg.find(f => String(f.product_id) === String(adj.product_id))?.qty || 0;
  const adjMag = Math.floor(Math.abs(+adj.qty || 0));
  const adjDelta = adj.mode === 'reduce' ? -adjMag : adjMag;
  // Preview the CLAMP, not the arithmetic: the server brings a product to nil
  // rather than negative, so a dialog promising −110 would be lying.
  const adjNewBalance = Math.max(0, adjAvail + adjDelta);
  const adjClamps = adj.mode === 'reduce' && adjMag > adjAvail;
  const adjLostQty = adjClamps ? adjMag - adjAvail : 0;
  const ADJ_REASONS = adj.mode === 'reduce'
    ? ['Damage / wastage', 'Physical count correction', 'Sample / testing', 'Write-off']
    : ['Opening stock', 'Physical count correction', 'Customer return', 'Rework returned'];

  const setAdjQty = v => setAdj(a => {
    const mag = Math.floor(Math.abs(+v || 0));
    return { ...a, qty: v, actual: v === '' ? '' : String(Math.max(0, adjAvail + (a.mode === 'reduce' ? -mag : mag))) };
  });
  const setAdjActual = v => setAdj(a => {
    if (v === '') return { ...a, actual: '', qty: '' };
    const delta = Math.floor(+v || 0) - adjAvail;
    return {
      ...a, actual: v,
      qty: delta === 0 ? '' : String(Math.abs(delta)),
      mode: delta < 0 ? 'reduce' : delta > 0 ? 'add' : a.mode,
    };
  });
  const setAdjMode = mode => setAdj(a => {
    const mag = Math.floor(Math.abs(+a.qty || 0));
    return { ...a, mode, actual: a.qty === '' ? '' : String(Math.max(0, adjAvail + (mode === 'reduce' ? -mag : mag))) };
  });
  const setAdjProduct = id => setAdj(a => {
    const avail = +fg.find(f => String(f.product_id) === String(id))?.qty || 0;
    const mag = Math.floor(Math.abs(+a.qty || 0));
    return { ...a, product_id: id, actual: a.qty === '' ? '' : String(Math.max(0, avail + (a.mode === 'reduce' ? -mag : mag))) };
  });

  const saveAdj = async () => {
    setSaving(true);
    try {
      const r = await api.post('/fg/adjust', { product_id: +adj.product_id, qty: adjDelta, note: adj.note.trim() });
      toast.success(r.clamped
        ? `Brought to nil — only ${fmt.num(r.applied)} was on the book`
        : `Stock adjusted — ${fmt.num(r.before)} → ${fmt.num(r.after)}`);
      setAdjOpen(false);
      setAdj(ADJ_BLANK);
      setFgSub('in');
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not adjust FG stock');
    } finally {
      setSaving(false);
    }
  };

  // One option list, both dialogs. data-search makes the whole record findable
  // (codes, artwork code, customer), not just the name shown on the row.
  const productOptions = products.map(p => (
    <option key={p.id} value={p.id} data-search={productSearchText({ ...p, product_name: p.name, product_code: p.code })}>
      {p.name}{p.code ? ` · ${p.code}` : ''}
    </option>
  ));

  const boxNumbersLabel = boxes => {
    if (!boxes?.length) return '';
    const nums = boxes.map(b => b.box_number);
    return boxes.length === 1 ? nums[0] : `${boxes.length} boxes: ${nums[0]}...${nums[nums.length - 1]}`;
  };

  const openMove = async f => {
    try {
      const preview = await api.get(`/fg/movement-preview?product_id=${f.product_id}`);
      setMove({
        product: f,
        preview,
        alloc: Object.fromEntries((preview.allocations || []).map(a => [a.order_line_id, a.dispatch_qty])),
        boxLeftover: true,
        vehicle: '',
        driver: '',
      });
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not open FG move');
    }
  };

  const runMove = async mode => {
    const m = move;
    const allocations = (m.preview.allocations || [])
      .map(a => ({ order_line_id: a.order_line_id, qty: +m.alloc[a.order_line_id] || 0 }))
      .filter(a => a.qty > 0);
    const dispatched = allocations.reduce((s, a) => s + a.qty, 0);
    const leftover = Math.max(0, m.preview.available - dispatched);
    setSaving(true);
    try {
      if (mode === 'dispatch') {
        const res = await api.post('/fg/move', {
          product_id: m.product.product_id,
          mode: 'dispatch',
          allocations,
          leftover_qty: m.boxLeftover ? leftover : 0,
          vehicle: m.vehicle,
          driver: m.driver,
        });
        toast.success(`${res.challans.length} challan(s) created${res.boxes?.length ? ` - ${boxNumbersLabel(res.boxes)}` : ''}`);
        if (res.challans?.length === 1) nav(`/dispatch/challan/${res.challans[0].id}`);
      } else if (mode === 'leftover') {
        const res = await api.post('/fg/move', {
          product_id: m.product.product_id,
          mode: 'leftover',
          leftover_qty: m.preview.available,
        });
        toast.success(`Boxed as leftover${res.boxes?.length ? ` - ${boxNumbersLabel(res.boxes)}` : ''}`);
      }
      setMove(null);
      setFgSel(new Set());
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Movement failed');
    } finally {
      setSaving(false);
    }
  };

  const bulkLeftover = async () => {
    const picks = fg.filter(f => fgSel.has(f.product_id));
    if (!picks.length) return;
    setSaving(true);
    try {
      for (const f of picks) await api.post('/fg/move', { product_id: f.product_id, mode: 'leftover', leftover_qty: f.qty });
      toast.success(`${picks.length} product(s) boxed as leftover`);
      setFgSel(new Set());
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Bulk leftover failed');
    } finally {
      setSaving(false);
    }
  };

  const moveBoxToFg = async box => {
    if (!window.confirm(`Move box ${box.box_number || box.lot_number} (${fmt.num(box.remaining)}) back into FG stock?`)) return;
    setSaving(true);
    try {
      await api.post(`/fg-lots/${box.id}/to-fg`, {});
      toast.success(`Box ${box.box_number || box.lot_number} moved to FG`);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not move to FG');
    } finally {
      setSaving(false);
    }
  };

  const bulkMoveToFg = async () => {
    const ids = pickedRows.map(l => l.id);
    if (!ids.length) return;
    const total = pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0);
    if (!window.confirm(`Move ${ids.length} box${ids.length > 1 ? 'es' : ''} (${fmt.num(total)} cartons) back into FG stock?`)) return;
    setSaving(true);
    try {
      const res = await api.post('/fg-lots/bulk-to-fg', { ids });
      toast.success(`${res.count} boxes moved to FG`);
      setPickedBoxes([]);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Bulk move to FG failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Both doors stay on screen on both sub-tabs. A control that only appears
          on the view it writes to is a control nobody finds on the day the shelf
          holds something the ERP never saw produced. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SubTabs active={fgSub} onChange={setFgSub} tabs={[
          { key: 'in', label: 'In Stock', count: fg.length },
          { key: 'leftover', label: 'Leftover', count: leftoverFg.length || 0 },
        ]} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setAdj(ADJ_BLANK); setAdjOpen(true); }}>
            <SlidersHorizontal size={15} /> Adjust Stock
          </Button>
          <Button size="sm" onClick={() => { setAdd(ADD_BLANK); setAddOpen(true); }}>
            <PackagePlus size={15} /> Add Leftover Stock
          </Button>
        </div>
      </div>

      {fgSub === 'in' && (<>
        <AgeBar items={fg.map(f => f.age_days)} unit="SKUs" />
        {fgSel.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-2.5">
            <span className="text-sm font-semibold text-brand-700">{fgSel.size} selected</span>
            <Button size="sm" variant="secondary" onClick={bulkLeftover} disabled={saving}>Box selected as Leftover</Button>
            <button type="button" onClick={() => setFgSel(new Set())} className="text-xs font-semibold text-slate-500 hover:text-slate-700">Clear</button>
          </div>
        )}
        <DataTable
          searchable
          columns={[
            { key: 'sel', label: '', render: f => (
              <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={fgSel.has(f.product_id)}
                onChange={e => setFgSel(s => { const n = new Set(s); e.target.checked ? n.add(f.product_id) : n.delete(f.product_id); return n; })} />) },
            { key: 'product_name', label: 'Product',
              render: f => <ProductIdentity row={f} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Cartons in Stock', align: 'right', render: f => <span className="font-bold tabular-nums">{fmt.num(f.qty)}</span> },
            { key: 'age', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Age in Stock', render: f => f.age_days != null ? <AgeChip days={f.age_days} /> : <span className="text-xs text-slate-300">-</span> },
            { key: 'value', label: 'Value', align: 'right', render: f => fmt.inr(f.qty * f.rate) },
            { key: 'move', label: '', align: 'right', render: f => <Button size="sm" onClick={() => openMove(f)}>Move...</Button> },
          ]}
          rows={fg} empty="No finished goods in stock"
          exportName="FG Stock"
          exportSubtitle="Dispatch & Invoice - Finished goods"
          exportSummary={rows => [
            { label: 'SKUs in stock', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.qty || 0), 0)) },
            { label: 'Stock value', value: fmt.inr(rows.reduce((s, f) => s + (+f.qty || 0) * (+f.rate || 0), 0)) },
          ]} />
      </>)}

      {fgSub === 'leftover' && (<>
        <AgeBar items={leftoverFg.map(l => l.age_days)} unit="boxes" />
        {pickedBoxes.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} selected
              <span className="ml-2 text-xs font-semibold text-slate-500">- {fmt.num(pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0))} cartons</span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPickedBoxes([])}>Clear</Button>
              <Button size="sm" onClick={bulkMoveToFg} disabled={saving}>Move {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} to FG</Button>
            </div>
          </div>
        )}
        <DataTable
          searchable
          selectable
          selectedIds={pickedBoxes}
          onToggleRow={(row, checked) => setPickedBoxes(ids => checked ? [...new Set([...ids, row.id])] : ids.filter(id => id !== row.id))}
          onToggleAll={(rows, checked) => {
            const ids = rows.map(r => r.id);
            setPickedBoxes(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          columns={[
            { key: 'box_number', label: 'Box #', render: l => <span className="font-mono text-xs font-bold text-slate-800">{l.box_number || l.lot_number}</span> },
            { key: 'product_name', label: 'Product',
              render: l => <ProductIdentity row={l} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'customer_name', label: 'Customer' },
            { key: 'remaining', label: 'Cartons', align: 'right', render: l => <span className="font-bold tabular-nums">{fmt.num(l.remaining)}</span> },
            { key: 'source', label: 'Source', render: l => <span className="text-xs capitalize text-gray-500">{(l.source || '').replace(/_/g, ' ') || l.jc_number || '-'}</span> },
            { key: 'age', label: 'Age', render: l => <AgeChip days={l.age_days} /> },
            { key: 'move', label: '', align: 'right', render: l => <Button size="sm" variant="secondary" onClick={() => moveBoxToFg(l)}>Move to FG</Button> },
          ]}
          rows={leftoverFg} empty="No finished-goods leftover boxes - move some from FG stock (In Stock > Move...) or box a dispatch overrun."
          exportName="Leftover FG Boxes"
          exportSubtitle="Dispatch & Invoice - Finished-goods leftover boxes" />
      </>)}

      {/* ── Add a leftover box from scratch ── */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Leftover Stock"
        footer={<>
          <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={saveAdd} disabled={saving || !add.product_id || !(Math.floor(+add.qty) > 0)}>
            Add {Math.floor(+add.qty) > 0 ? `${fmt.num(Math.floor(+add.qty))} cartons` : 'box'}
          </Button>
        </>}>
        <div className="space-y-4">
          <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
            Puts finished goods the ERP never saw produced onto the books as a numbered
            leftover box — an opening count, a customer return, cartons found on the rack.
            In Stock is left alone; nothing is carved out of the loose pool to pay for it.
          </p>

          <Field label="Product" required>
            <Select value={add.product_id} onChange={e => setAdd({ ...add, product_id: e.target.value })}>
              <option value="">Select product…</option>
              {productOptions}
            </Select>
          </Field>

          {addProduct && (
            <div className="rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/70 px-3.5 py-2.5 text-xs text-slate-500">
              {addProduct.code && <span className="font-mono font-semibold text-slate-700">{addProduct.code}</span>}
              {addProduct.party_artwork_code && <> · AW {addProduct.party_artwork_code}</>}
              {addProduct.size && <> · {addProduct.size}</>}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity (cartons)" required>
              <Input type="number" min="1" step="1" value={add.qty}
                onChange={e => setAdd({ ...add, qty: e.target.value })} placeholder="e.g. 250" />
            </Field>
            <Field label="Box number" hint="Leave blank for the next CI-BOX-####">
              <Input value={add.box_number} onChange={e => setAdd({ ...add, box_number: e.target.value })}
                placeholder="Physical label, if any" />
            </Field>
          </div>

          <Field label="Location" hint="Defaults to FG-STORE">
            <Input value={add.location} onChange={e => setAdd({ ...add, location: e.target.value })}
              placeholder="e.g. FG-STORE, Rack 4" />
          </Field>

          <Field label="Reason">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {ADD_REASONS.map(r0 => (
                <button key={r0} type="button" onClick={() => setAdd({ ...add, note: r0 })}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${add.note === r0 ? 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]' : 'border-[#1D1D1F]/10 bg-white/60 text-slate-600 hover:border-[#007AFF]/40'}`}>
                  {r0}
                </button>
              ))}
            </div>
            <Textarea value={add.note} onChange={e => setAdd({ ...add, note: e.target.value })}
              placeholder="Where these cartons came from" />
          </Field>
        </div>
      </Modal>

      {/* ── Adjust the loose FG pool — the RM warehouse dialog, for finished goods ── */}
      <Modal open={adjOpen} onClose={() => setAdjOpen(false)} title="FG Stock Adjustment"
        footer={<>
          <Button variant="secondary" onClick={() => setAdjOpen(false)} disabled={saving}>Cancel</Button>
          <Button variant={adj.mode === 'reduce' ? 'danger' : 'success'} onClick={saveAdj}
            disabled={saving || !adj.product_id || !adjMag}>
            {adj.mode === 'reduce' ? 'Reduce' : 'Add'} Stock
          </Button>
        </>}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-[#1D1D1F]/[0.05] p-1">
            {[
              { key: 'add', label: 'Add stock', icon: Plus, on: 'bg-emerald-500 text-white shadow-sm', off: 'text-emerald-700' },
              { key: 'reduce', label: 'Reduce stock', icon: Minus, on: 'bg-red-500 text-white shadow-sm', off: 'text-red-700' },
            ].map(o => (
              <button key={o.key} type="button" onClick={() => setAdjMode(o.key)}
                className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-semibold transition-all ${adj.mode === o.key ? o.on : `bg-transparent ${o.off} hover:bg-white/50`}`}>
                <o.icon size={15} /> {o.label}
              </button>
            ))}
          </div>

          <Field label="Product" required>
            <Select value={adj.product_id} onChange={e => setAdjProduct(e.target.value)}>
              <option value="">Select product…</option>
              {productOptions}
            </Select>
          </Field>

          {adjProduct && (
            <div className="rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/70 p-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-mono font-semibold text-slate-700">{adjProduct.code || '—'}</span>
                <span>{adjAvail === 0 ? 'Nothing in loose FG yet' : `${fmt.num(adjAvail)} cartons in loose FG`}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 tabular-nums">
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Current</div>
                  <div className="text-lg font-bold text-slate-800">{fmt.num(adjAvail)}</div>
                </div>
                <div className={`text-2xl font-black ${adj.mode === 'reduce' ? 'text-red-500' : 'text-emerald-500'}`}>
                  {adj.mode === 'reduce' ? '−' : '+'}
                </div>
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Change</div>
                  <div className={`text-lg font-bold ${adj.mode === 'reduce' ? 'text-red-600' : 'text-emerald-600'}`}>{fmt.num(adjMag)}</div>
                </div>
                <div className="text-xl font-black text-slate-300">=</div>
                <div className="text-center">
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">New balance</div>
                  <div className={`text-xl font-black ${adjClamps ? 'text-amber-600' : 'text-[#007AFF]'}`}>
                    {fmt.num(adjNewBalance)} <span className="text-xs font-semibold text-slate-400">cartons</span>
                  </div>
                </div>
              </div>
              {adjClamps && (
                <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700">
                  Only {fmt.num(adjAvail)} cartons on the book. The extra {fmt.num(adjLostQty)} cannot come off —
                  this product is brought to nil, never negative, and the ledger records the {fmt.num(adjAvail)} that
                  actually moved.
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
            <Field label={adj.mode === 'reduce' ? 'Quantity to remove' : 'Quantity to add'} required>
              <Input type="number" min="0" step="1" value={adj.qty}
                onChange={e => setAdjQty(e.target.value)} placeholder="e.g. 500" />
            </Field>
            <div className="pt-8 text-xs font-bold uppercase tracking-wide text-slate-300">or</div>
            <Field label="Actual stock counted" hint={adjProduct ? `On system: ${fmt.num(adjAvail)} cartons` : 'Pick a product first'}>
              <Input type="number" min="0" step="1" value={adj.actual} disabled={!adjProduct}
                onChange={e => setAdjActual(e.target.value)} placeholder="e.g. 420" />
            </Field>
          </div>

          {/* Suppressed once the reduction exceeds the book — the counted figure is
              clamped at nil there, so this line would contradict the banner above. */}
          {adjProduct && adj.actual !== '' && !adjClamps && (
            <div className={`-mt-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${adjMag === 0 ? 'bg-slate-50 text-slate-500' : adj.mode === 'reduce' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
              {adjMag === 0
                ? 'Counted figure matches the system — nothing to adjust.'
                : `Counted ${fmt.num(Math.floor(+adj.actual))} vs ${fmt.num(adjAvail)} on system — auto-set to ${adj.mode === 'reduce' ? 'reduce' : 'add'} ${fmt.num(adjMag)} cartons.`}
            </div>
          )}

          <Field label="Reason">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {ADJ_REASONS.map(r0 => (
                <button key={r0} type="button" onClick={() => setAdj({ ...adj, note: r0 })}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${adj.note === r0 ? 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]' : 'border-[#1D1D1F]/10 bg-white/60 text-slate-600 hover:border-[#007AFF]/40'}`}>
                  {r0}
                </button>
              ))}
            </div>
            <Textarea value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })}
              placeholder="Why the book is changing" />
          </Field>
        </div>
      </Modal>

      <Modal wide open={!!move} onClose={() => setMove(null)}
        title={move ? `Move FG - ${move.product.product_name}` : ''}
        footer={move && (() => {
          const dispatched = (move.preview.allocations || []).reduce((s, a) => s + (+move.alloc[a.order_line_id] || 0), 0);
          const leftover = Math.max(0, move.preview.available - dispatched);
          return (<>
            <Button variant="secondary" onClick={() => setMove(null)} disabled={saving}>Keep in FG</Button>
            <Button variant="secondary" onClick={() => runMove('leftover')} disabled={saving}>Box all {fmt.num(move.preview.available)} as Leftover</Button>
            <Button disabled={saving || dispatched === 0} onClick={() => runMove('dispatch')}>
              Dispatch {fmt.num(dispatched)}{move.boxLeftover && leftover > 0 ? ` - box ${fmt.num(leftover)}` : ''}
            </Button>
          </>);
        })()}>
        {move && (() => {
          const dispatched = (move.preview.allocations || []).reduce((s, a) => s + (+move.alloc[a.order_line_id] || 0), 0);
          const leftover = Math.max(0, move.preview.available - dispatched);
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-slate-400">FG on hand</div><div className="text-lg font-bold tabular-nums">{fmt.num(move.preview.fg_stock)}</div></div>
                <div className="rounded-xl bg-emerald-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-emerald-500">To dispatch</div><div className="text-lg font-bold tabular-nums text-emerald-700">{fmt.num(dispatched)}</div></div>
                <div className="rounded-xl bg-amber-50 px-3 py-2"><div className="text-[10px] uppercase tracking-wide text-amber-500">Leftover</div><div className="text-lg font-bold tabular-nums text-amber-700">{fmt.num(leftover)}</div></div>
              </div>

              {move.preview.allocations.length === 0 ? (
                <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">No open sales orders want this product right now - box it all as leftover, or keep it in FG.</p>
              ) : (
                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <table className="w-full text-xs">
                    <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-bold uppercase text-slate-400">
                      <th className="px-3 py-1.5">Sales Order</th><th className="px-3 py-1.5">Customer</th>
                      <th className="px-3 py-1.5 text-right">Ordered</th><th className="px-3 py-1.5 text-right">Dispatched</th>
                      <th className="px-3 py-1.5 text-right">Tol %</th><th className="px-3 py-1.5 text-right">Max (incl. tol)</th>
                      <th className="px-3 py-1.5 text-right">Dispatch now</th>
                    </tr></thead>
                    <tbody>
                      {move.preview.allocations.map(a => (
                        <tr key={a.order_line_id} className="border-b border-slate-50 last:border-0">
                          <td className="px-3 py-1.5 font-semibold text-slate-800">{a.po_number}</td>
                          <td className="px-3 py-1.5 text-slate-500">{a.customer_name}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(a.ordered)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{fmt.num(a.dispatched)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{a.tolerance_pct}%</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmt.num(a.allowed_max)}</td>
                          <td className="px-3 py-1.5 text-right">
                            <input type="number" min="0" max={a.tolerance_room}
                              className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right tabular-nums"
                              value={move.alloc[a.order_line_id] ?? 0}
                              onChange={e => setMove(m => ({ ...m, alloc: { ...m.alloc, [a.order_line_id]: Math.min(a.tolerance_room, Math.max(0, Math.floor(+e.target.value || 0))) } }))} />
                            <div className="text-[9px] text-slate-400">room {fmt.num(a.tolerance_room)}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {dispatched > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Vehicle"><Input value={move.vehicle} onChange={e => setMove({ ...move, vehicle: e.target.value })} placeholder="Optional" /></Field>
                  <Field label="Driver"><Input value={move.driver} onChange={e => setMove({ ...move, driver: e.target.value })} placeholder="Optional" /></Field>
                </div>
              )}
              {leftover > 0 && dispatched > 0 && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={move.boxLeftover} onChange={e => setMove({ ...move, boxLeftover: e.target.checked })} />
                  Box the remaining {fmt.num(leftover)} as a numbered Leftover box (auto CI-BOX-####)
                </label>
              )}
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
