import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Minus, PackagePlus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { isNoLimit, toleranceLabel } from '../lib/tolerance.js';
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

const ADD_BLANK = { product_id: '', qty: '', box_number: '', location: '', note: '' };
const ADJ_BLANK = { product_id: '', mode: 'add', qty: '', actual: '', note: '' };
const ADD_REASONS = ['Opening stock', 'Physical count — found on rack', 'Customer return', 'Sample stock'];
// Scrapping is a write-off, not a move — the cartons leave the building and do
// not return to loose FG. The reason is mandatory, so offer the real ones.
const SCRAP_REASONS = ['Damaged in storage', 'Print/quality defect', 'Obsolete artwork', 'Wet or soiled', 'Sent to mill for pulping'];

export default function FgStockPanel({ onCountsChange }) {
  const toast = useToast();
  const nav = useNavigate();
  const [fg, setFg] = useState([]);
  const [leftoverFg, setLeftoverFg] = useState([]);
  const [products, setProducts] = useState([]);
  const [fgSel, setFgSel] = useState(() => new Set());
  const [pickedBoxes, setPickedBoxes] = useState([]);
  const [move, setMove] = useState(null);
  const [scrap, setScrap] = useState(null);   // { box, reason } while confirming a box write-off
  const [wipe, setWipe] = useState(null);     // { row, reason } while confirming a READY-stock write-off
  const [boxesFor, setBoxesFor] = useState(null);  // product whose boxes drawer is open
  const [showZero, setShowZero] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add-a-leftover-box and adjust-loose-stock. Two doors, deliberately separate:
  // a box is a numbered physical thing on the Leftover shelf, loose FG is a pool.
  const [addOpen, setAddOpen] = useState(false);
  const [add, setAdd] = useState(ADD_BLANK);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adj, setAdj] = useState(ADJ_BLANK);

  const pickedRows = leftoverFg.filter(l => pickedBoxes.includes(l.id));

  // /inventory/fg now returns EVERY product master, zeros included, so the
  // switch has something to reveal. A row counts as holding stock if it holds
  // either pool — a product with no loose stock but three boxes on the rack is
  // very much a live position, and the old `qty > 0` query hid exactly that.
  const fgHidden = fg.filter(f => +f.total_qty <= 0).length;
  const fgRows = showZero ? fg : fg.filter(f => +f.total_qty > 0);
  // Boxes of the product whose drawer is open — the old Leftover tab, scoped.
  const boxRows = boxesFor ? leftoverFg.filter(l => l.product_id === boxesFor.product_id) : [];

  const load = async () => {
    try {
      const [fgRows, leftoverRows] = await Promise.all([
        api.get('/inventory/fg'),
        api.get('/inventory/leftover-fg'),
      ]);
      setFg(fgRows);
      setLeftoverFg(leftoverRows);
      // The tab badge counts what is IN STOCK, not how many masters exist — the
      // row set is now the whole master list, and "In Stock 1,661" would be a
      // lie told in the loudest place on the screen.
      onCountsChange?.({
        in: fgRows.filter(f => +f.total_qty > 0).length,
        leftover: leftoverRows.length,
      });
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

  // Box this product's new production into numbered cartons. The server splits
  // by the product's real per-box packing and allocates a CI-BOX number to each,
  // so "box the leftover" and "allocate the box number" are one action — a box
  // without a number is exactly the anonymous pile this whole module removes.
  const boxRowLeftover = async f => {
    const n = Math.floor(+f.ready_qty || 0);
    if (!(n > 0)) return toast.error('No new production to box');
    if (!window.confirm(`Box all ${fmt.num(n)} cartons of ${f.code} as leftover?\n\nThey leave ready stock and get their own CI-BOX numbers.`)) return;
    setSaving(true);
    try {
      const res = await api.post('/fg/move', { product_id: f.product_id, mode: 'leftover', leftover_qty: n });
      toast.success(`Boxed ${fmt.num(n)} — ${boxNumbersLabel(res.boxes)}`);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not box the stock');
    } finally { setSaving(false); }
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

  // Open the adjustment door already pointed at the row that was clicked — no
  // hunting the product back out of a dropdown you just came from. 'reduce'
  // pre-loads the whole on-hand figure, which is the "zero it down" case.
  const openAdjFor = (f, mode = 'add') => {
    setAdj({ ...ADJ_BLANK, product_id: String(f.product_id), mode,
             qty: mode === 'reduce' ? String(Math.floor(+f.ready_qty || 0)) : '' });
    setAdjOpen(true);
  };

  // Put a retired box back in circulation. Retiring happens in planning (it is a
  // planning decision), but the warehouse is where you SEE what is retired, so
  // the way back has to be here too or the state is a one-way door.
  const unretireBox = async box => {
    if (!window.confirm(`Put ${box.box_number || box.lot_number} back in circulation? Planning will start offering it again.`)) return;
    setSaving(true);
    try {
      await api.post(`/fg-lots/${box.id}/unretire`, {});
      toast.success(`${box.box_number || box.lot_number} is back in circulation`);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not un-retire the box');
    } finally { setSaving(false); }
  };

  // Write off the READY (loose) stock of a product. Distinct from adjusting it
  // down: an adjustment is a count correction, this is stock that existed and is
  // being destroyed, so the reason is mandatory and says so in the ledger.
  // Boxes are NOT touched from here — each carries its own number and has to be
  // written off individually, or the audit trail stops meaning anything.
  const wipeReadyStock = async () => {
    const why = (wipe.reason || '').trim();
    if (!why) return toast.error('Give a reason for writing this stock off');
    const n = Math.floor(+wipe.row.ready_qty || 0);
    setSaving(true);
    try {
      await api.post('/fg/adjust', { product_id: wipe.row.product_id, qty: -n, note: `Scrapped — ${why}` });
      toast.success(`${fmt.num(n)} cartons of ${wipe.row.code} written off`);
      setWipe(null);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not write the stock off');
    } finally { setSaving(false); }
  };

  // Write the box off. Deliberately a modal and not a window.confirm: the reason
  // is mandatory and is the only record of WHY stock vanished, so it has to be
  // typed before the button will fire.
  const scrapBox = async () => {
    const why = (scrap.reason || '').trim();
    if (!why) return toast.error('Give a reason for scrapping this box');
    setSaving(true);
    try {
      const res = await api.post(`/fg-lots/${scrap.box.id}/scrap`, { reason: why });
      toast.success(`Box ${scrap.box.box_number || scrap.box.lot_number} scrapped — ${fmt.num(res.remaining)} cartons written off`);
      setScrap(null);
      await load();
    } catch (e) {
      if (!e.data) toast.error(e.message || 'Could not scrap the box');
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
        {/* ONE MODULE. In Stock and Leftover were two tabs over the same stock,
            which meant a product's real position was never on one line: fresh
            production on one tab, its old boxed leftovers on another, and no
            total anywhere. They are now columns on a single master row, and the
            per-box work (scrap, retire, move) lives in that row's Boxes drawer. */}
        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
          {fg.filter(f => +f.total_qty > 0).length} with stock
          <span className="ml-2 font-semibold normal-case tracking-normal text-slate-400">
            · {leftoverFg.length} leftover box{leftoverFg.length === 1 ? '' : 'es'}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => { setAdj(ADJ_BLANK); setAdjOpen(true); }}>
            <SlidersHorizontal size={15} /> Adjust Stock
          </Button>
          <Button size="sm" onClick={() => { setAdd(ADD_BLANK); setAddOpen(true); }}>
            <PackagePlus size={15} /> Add Leftover Stock
          </Button>
        </div>
      </div>

      {(<>
        {/* THE POSITION IS EVERY MASTER — the switch governs the LIST only.
            Same rule the board warehouse arrived at: a product at zero is a real
            position, and it is exactly the row a box gets booked onto tomorrow.
            The count on the switch says what it is holding back, so nothing
            disappears silently. */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <AgeBar items={fgRows.map(f => f.age_days)} unit="SKUs" />
          <label className="flex cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#1D1D1F]/[0.06] bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:border-slate-300">
            <input type="checkbox" className="h-3.5 w-3.5 accent-[#007AFF]"
              checked={showZero} onChange={e => setShowZero(e.target.checked)} />
            Show zero stock
            {fgHidden > 0 && !showZero && (
              <span className="rounded-full bg-slate-100 px-1.5 text-[10px] tabular-nums text-slate-500">{fgHidden}</span>
            )}
          </label>
        </div>
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
            // Three quantities, because the plant thinks in three. Ready is what
            // Ready to Dispatch can ship today; boxed is carved OUT of it and
            // never double-counted; total is what is physically in the store.
            { key: 'ready_qty', label: 'New Production', align: 'right',
              render: f => +f.ready_qty > 0
                ? <span className="font-bold tabular-nums text-emerald-700">{fmt.num(f.ready_qty)}</span>
                : <span className="tabular-nums text-slate-300">0</span> },
            { key: 'boxed_qty', label: 'Old Leftover', align: 'right',
              export: f => +f.boxed_qty || 0,
              render: f => +f.boxed_qty > 0 ? (
                <div className="leading-tight">
                  <span className="font-bold tabular-nums text-amber-700">{fmt.num(f.boxed_qty)}</span>
                  <div className="font-mono text-[10px] text-slate-400" title={f.box_numbers || ''}>
                    {f.box_count} box{f.box_count > 1 ? 'es' : ''}
                  </div>
                  {/* Retired stock is still ON the books and still counted in
                      this row — it is simply no longer offered in planning. Say
                      so here, or it looks like stock that has gone missing. */}
                  {+f.retired_qty > 0 && (
                    <div className="text-[10px] font-bold text-slate-500"
                      title="Retired — still in the warehouse, but planning will not offer it">
                      {fmt.num(f.retired_qty)} retired
                    </div>
                  )}
                </div>
              ) : <span className="tabular-nums text-slate-300">0</span> },
            // Box numbers get their own column, and it is the door to the boxes:
            // per-box work (scrap, retire, move back) has to live somewhere now
            // that the Leftover tab is gone.
            { key: 'box_numbers', label: 'Box Numbers',
              export: f => f.box_numbers || '',
              render: f => f.box_numbers ? (
                <button type="button" onClick={() => setBoxesFor(f)}
                  title="Open this product's boxes — scrap, retire or move one back to ready stock"
                  className="rounded font-mono text-[10px] text-slate-500 underline decoration-dotted underline-offset-2 hover:text-[#007AFF]">
                  {f.box_numbers}
                </button>
              ) : <span className="text-xs text-slate-300">-</span> },
            { key: 'total_qty', label: 'Total Available', align: 'right',
              render: f => +f.total_qty > 0
                ? <span className="font-black tabular-nums text-slate-900">{fmt.num(f.total_qty)}</span>
                : <span className="tabular-nums text-slate-300">0</span> },
            // Consumed in planning against a line that has not shipped. These
            // cartons must travel with that PO's lot — saying so on the row is
            // the only place the storekeeper would ever see it.
            // NOT a third pile. Consuming a box pushes its cartons INTO the loose
            // pool, so what is committed is already counted in New Production and
            // in Total. Sitting in a column of its own beside Total it reads as
            // extra stock, so the cell says out loud that it is a subset.
            { key: 'reserved_qty', label: 'Committed in Planning', align: 'right',
              export: f => +f.reserved_qty || 0,
              render: f => +f.reserved_qty > 0 ? (
                <div className="leading-tight"
                  title={`Already counted in New Production — not extra stock. Box ${f.reserved_boxes || ''} is earmarked for ${f.reserved_for || ''} and must travel with that lot.`}>
                  <span className="text-[10px] font-semibold text-violet-400">of which </span>
                  <span className="font-bold tabular-nums text-violet-700">{fmt.num(f.reserved_qty)}</span>
                  <div className="text-[10px] font-semibold text-violet-500">
                    send with {f.reserved_for}
                  </div>
                </div>
              ) : <span className="text-xs text-slate-300">-</span> },
            { key: 'age', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Age in Stock', render: f => f.age_days != null ? <AgeChip days={f.age_days} /> : <span className="text-xs text-slate-300">-</span> },
            { key: 'value', label: 'Value', align: 'right',
              export: f => (+f.total_qty || 0) * (+f.rate || 0),
              render: f => fmt.inr((+f.total_qty || 0) * (+f.rate || 0)) },
            { key: 'move', label: '', align: 'right', render: f => (
              <div className="flex items-center justify-end gap-1.5">
                {/* The two things a storekeeper does with new production: send it
                    out, or box it and give it a number. Both live on the row. */}
                <Button size="sm" onClick={() => openMove(f)} disabled={!(+f.ready_qty > 0)}
                  title="Send this product's new production out against its open orders">Dispatch</Button>
                <Button size="sm" variant="secondary" onClick={() => boxRowLeftover(f)} disabled={saving || !(+f.ready_qty > 0)}
                  title="Box the new production into numbered CI-BOX cartons">Box it</Button>
                <Button size="sm" variant="secondary" onClick={() => openAdjFor(f, 'add')}>Adjust</Button>
                <button type="button"
                  title={`Write off the ready stock of ${f.code}`}
                  aria-label={`Write off the ready stock of ${f.code}`}
                  disabled={!(+f.ready_qty > 0)}
                  onClick={() => setWipe({ row: f, reason: '' })}
                  className="rounded-lg border border-red-200 bg-white/70 p-1.5 text-red-500 transition-all hover:border-red-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 disabled:hover:bg-white/70">
                  <Trash2 size={14} />
                </button>
              </div>
            ) },
          ]}
          rows={fgRows} empty={showZero ? 'No product masters' : 'Nothing in finished goods — tick "Show zero stock" to see every master.'}
          exportName="FG Stock"
          exportSubtitle="Dispatch & Invoice - Finished goods"
          exportSummary={rows => [
            { label: 'SKUs listed', value: rows.length },
            { label: 'Ready cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.ready_qty || 0), 0)) },
            { label: 'Boxed cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.boxed_qty || 0), 0)) },
            { label: 'Total cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.total_qty || 0), 0)) },
            { label: 'Stock value', value: fmt.inr(rows.reduce((s, f) => s + (+f.total_qty || 0) * (+f.rate || 0), 0)) },
          ]} />
      </>)}

      {/* The boxes of ONE product — what used to be the whole Leftover tab, now
          scoped to the row you opened it from. Everything per-box still lives
          here: scrap, retire/un-retire, move back to ready stock, ageing. */}
      <Modal open={!!boxesFor} onClose={() => setBoxesFor(null)} size="xl"
        title={boxesFor ? `Boxes — ${boxesFor.product_name}` : 'Boxes'}
        footer={<Button variant="secondary" onClick={() => setBoxesFor(null)}>Close</Button>}>
        {boxesFor && (<>
        <AgeBar items={boxRows.map(l => l.age_days)} unit="boxes" />
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
            { key: 'retired', label: 'Retired',
              export: l => (+l.retired ? `Yes — ${l.retired_reason || ''}` : ''),
              render: l => +l.retired ? (
                <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600"
                  title={`Retired by ${l.retired_by || 'someone'} — ${l.retired_reason || 'no reason given'}. Still in the warehouse; planning will not offer it.`}>
                  retired
                </span>
              ) : <span className="text-xs text-slate-300">-</span> },
            { key: 'move', label: '', align: 'right', render: l => (
              <div className="flex items-center justify-end gap-1.5">
                {+l.retired ? (
                  <Button size="sm" variant="secondary" onClick={() => unretireBox(l)}>Un-retire</Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => moveBoxToFg(l)}>Move to FG</Button>
                <button type="button"
                  title={`Scrap box ${l.box_number || l.lot_number}`}
                  aria-label={`Scrap box ${l.box_number || l.lot_number}`}
                  onClick={() => setScrap({ box: l, reason: '' })}
                  className="rounded-lg border border-red-200 bg-white/70 p-1.5 text-red-500 transition-all hover:border-red-400 hover:bg-red-50 hover:text-red-600">
                  <Trash2 size={14} />
                </button>
              </div>
            ) },
          ]}
          rows={boxRows} empty="This product has no leftover boxes yet — use Box it on its row to make one."
          exportName="Leftover FG Boxes"
          exportSubtitle="Dispatch & Invoice - Finished-goods leftover boxes" />
        </>)}
      </Modal>

      {/* ── Write off a product's READY stock ── */}
      <Modal open={!!wipe} onClose={() => setWipe(null)} title="Write off ready stock"
        footer={<>
          <Button variant="secondary" onClick={() => setWipe(null)} disabled={saving}>Cancel</Button>
          <Button onClick={wipeReadyStock} disabled={saving || !(wipe?.reason || '').trim()}>
            Write off {fmt.num(Math.floor(+wipe?.row?.ready_qty || 0))} cartons
          </Button>
        </>}>
        {wipe && (
          <div className="space-y-4">
            <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
              Writes off all <span className="font-bold">{fmt.num(Math.floor(+wipe.row.ready_qty || 0))}</span> ready
              cartons of {wipe.row.product_name}. The stock is gone and this cannot be undone from here.
              {+wipe.row.boxed_qty > 0 && (
                <> Its <span className="font-bold">{fmt.num(wipe.row.boxed_qty)}</span> boxed cartons
                  ({wipe.row.box_numbers}) are <span className="font-bold">not</span> touched — write each box
                  off from the Leftover tab so every box number is accounted for separately.</>
              )}
            </p>
            <Field label="Reason">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {SCRAP_REASONS.map(r0 => (
                  <button key={r0} type="button" onClick={() => setWipe({ ...wipe, reason: r0 })}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${wipe.reason === r0 ? 'border-red-500 bg-red-500/10 text-red-600' : 'border-[#1D1D1F]/10 bg-white/60 text-slate-600 hover:border-red-400/40'}`}>
                    {r0}
                  </button>
                ))}
              </div>
              <Textarea value={wipe.reason} onChange={e => setWipe({ ...wipe, reason: e.target.value })}
                placeholder="Why this stock is being written off" />
            </Field>
          </div>
        )}
      </Modal>

      {/* ── Scrap a leftover box — a write-off, not a move ── */}
      <Modal open={!!scrap} onClose={() => setScrap(null)} title="Scrap leftover box"
        footer={<>
          <Button variant="secondary" onClick={() => setScrap(null)} disabled={saving}>Cancel</Button>
          <Button onClick={scrapBox} disabled={saving || !(scrap?.reason || '').trim()}>
            Scrap {fmt.num(scrap?.box?.remaining || 0)} cartons
          </Button>
        </>}>
        {scrap && (
          <div className="space-y-4">
            <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">
              Writes off box <span className="font-mono font-bold">{scrap.box.box_number || scrap.box.lot_number}</span> —{' '}
              <span className="font-bold">{fmt.num(scrap.box.remaining)}</span> cartons of {scrap.box.product_name}.
              The cartons are gone: they do <span className="font-bold">not</span> come back to FG stock,
              and this cannot be undone from here.
            </p>
            <Field label="Reason">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {SCRAP_REASONS.map(r0 => (
                  <button key={r0} type="button" onClick={() => setScrap({ ...scrap, reason: r0 })}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${scrap.reason === r0 ? 'border-red-500 bg-red-500/10 text-red-600' : 'border-[#1D1D1F]/10 bg-white/60 text-slate-600 hover:border-red-400/40'}`}>
                    {r0}
                  </button>
                ))}
              </div>
              <Textarea value={scrap.reason} onChange={e => setScrap({ ...scrap, reason: e.target.value })}
                placeholder="Why these cartons are being written off" />
            </Field>
          </div>
        )}
      </Modal>

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
                          <td className="px-3 py-1.5 text-right tabular-nums">{toleranceLabel(a.tolerance_pct)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{isNoLimit(a.tolerance_pct) ? '—' : fmt.num(a.allowed_max)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {/* A no-limit customer has no ceiling to clamp to —
                                capping the input at tolerance_room (which is the
                                CASCADE room, i.e. the outstanding need) would
                                refuse over-dispatch the customer plainly allows.
                                Physical FG stock is still the gate on save. */}
                            <input type="number" min="0" max={isNoLimit(a.tolerance_pct) ? undefined : a.tolerance_room}
                              className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right tabular-nums"
                              value={move.alloc[a.order_line_id] ?? 0}
                              onChange={e => setMove(m => {
                                const typed = Math.max(0, Math.floor(+e.target.value || 0));
                                const next = isNoLimit(a.tolerance_pct) ? typed : Math.min(a.tolerance_room, typed);
                                return { ...m, alloc: { ...m.alloc, [a.order_line_id]: next } };
                              })} />
                            <div className="text-[9px] text-slate-400">{isNoLimit(a.tolerance_pct) ? 'no limit' : `room ${fmt.num(a.tolerance_room)}`}</div>
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
