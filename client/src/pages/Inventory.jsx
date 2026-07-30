// Inventory — one stock truth: position, batches, movement ledger, FG.
import { useEffect, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import { kgPerSheet, packets, packetWeight, ratePerSheet, resolveRatePerKg, totalWeight } from '../lib/boardMath.js';
import { AgeChip, Button, DataTable, Field, Input, Modal, PageHeader, searchText, Select, StatusBadge, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { Plus, Minus, ShoppingBag } from 'lucide-react';
import MasterHistory from '../components/MasterHistory.jsx';
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';

// One batched call paints the thread column for a whole list. /threads/summary
// refuses more than 200 ids at once — a truncated answer is indistinguishable
// from "nobody has commented here" — so a long list is asked for in slices.
const THREAD_CHUNK = 200;
const threadSummary = (entity, ids) => {
  const calls = [];
  for (let i = 0; i < ids.length; i += THREAD_CHUNK) {
    calls.push(api.get(`/threads/summary?entity=${entity}&ids=${ids.slice(i, i + THREAD_CHUNK).join(',')}`));
  }
  return Promise.all(calls).then(parts => Object.assign({}, ...parts));
};

// Board total weight for a stock row, from its own strip size × (inherited) gsm.
// Non-board / missing-gsm masters → null so the cell shows "—", never a wrong 0.
// A row holding nothing weighs nothing no matter what its master is missing, so
// an empty row reads a real 0.0 kg instead of a dash that looks like a data gap.
const rowWeight = (m, sheets) => (+sheets === 0 ? 0 : totalWeight(m, sheets));

// The plant counts, buys and stores board in PACKETS; the ledger transacts in
// SHEETS, because cutting and planning are sheet-denominated. Every stock figure
// therefore leads with packets — the warehouse's own unit — and carries its
// sheet equivalent underneath, so nobody has to convert in their head and the
// number production consumes stays visible.
const packetsOf = (m, sheets) => (+sheets === 0 ? 0 : packets(m, sheets));

// Packets are display-only and stay fractional: 250 sheets of a 100-sheet pack
// is 2.5 packets, not 3. Rounding here would silently invent stock.
const pktText = p => (p == null ? '—' : (+p).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

// Two-line stock cell — packets in front, sheets beneath. Used by every raw
// material list so RM stock reads the same wherever it appears.
function StockCell({ m, sheets, short }) {
  const p = packetsOf(m, sheets);
  return (
    <div className="leading-tight">
      <div className={`text-[15px] font-black tabular-nums ${short ? 'text-red-600' : 'text-gray-900'}`}>
        {pktText(p)}<span className="ml-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">pkt</span>
      </div>
      <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-slate-400">
        {fmt.num(sheets)} sheets
      </div>
    </div>
  );
}

// Plain-text twin of StockCell for PDF/XLSX export, where a two-line cell has to
// collapse into one string.
const stockText = (m, sheets) => `${pktText(packetsOf(m, sheets))} pkt · ${fmt.num(sheets)} sheets`;

// ── Board spec on the stock list ─────────────────────────────────────────────
// The warehouse lists the SAME board columns the Boards master shows — grade,
// GSM, sheet size, sheets/packet, kg/sheet, packet kg, ₹/kg, ₹/sheet — because a
// stock row and a master row are the same board, and a storekeeper should not
// have to open Masters to answer "what is this and what is it worth". Nothing is
// stored on the stock row: the spec rides along on /inventory/stock (which
// already returns m.* plus the grade/gsm/pack a leftover inherits from its
// parent) and every number below is derived live, so changing a grade's ₹/kg
// reprices the warehouse on the next load with no backfill.
//
// Every helper returns null on an incomplete master so the cell shows "—"
// instead of a confident, wrong zero — same rule as boardMath itself.
const dash = <span className="text-xs text-slate-300">—</span>;
const numCell = (v, digits = 0) => (v == null ? dash
  : <span className="tabular-nums text-slate-700">{(+v).toFixed(digits)}</span>);

// ₹/kg for a stock row: the grade's base rate. No vendor here — a stock row
// belongs to no vendor, so the base rate is the honest valuation.
const rateKgOf = (m, rates) => resolveRatePerKg(rates, m.grade, null)?.rate_per_kg ?? null;

// Value of what is on the floor = sheets × ₹/sheet. Null (not 0) when the board
// has no rate on file, so an unrated board reads as unknown rather than free.
const stockValue = (m, rates) => {
  const rs = ratePerSheet(m, rateKgOf(m, rates));
  return rs == null ? null : rs * (+m.available || 0);
};

// The board columns, shared by the RM Stock and RM Leftover lists so both read
// identically. A leftover keeps its own strip size but inherits grade/GSM/pack,
// which is exactly what the endpoint COALESCEs in.
const boardSpecColumns = rates => [
  { key: 'grade', label: 'Grade',
    render: m => (m.grade
      ? <span className="inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{m.grade}</span>
      : dash),
    export: m => m.grade || '' },
  { key: 'gsm', label: 'GSM', align: 'right', render: m => numCell(m.gsm), export: m => m.gsm ?? '' },
  { key: 'sheet_size', label: 'Sheet Size',
    render: m => (m.sheet_l ? <span className="whitespace-nowrap font-mono text-xs">{m.sheet_l}×{m.sheet_w}"</span> : dash),
    export: m => (m.sheet_l ? `${m.sheet_l}x${m.sheet_w}` : '') },
  { key: 'sheets_per_packet', label: 'Sheets / Packet', align: 'right',
    render: m => numCell(m.sheets_per_packet), export: m => m.sheets_per_packet ?? '' },
  { key: 'kg_per_sheet', label: 'Kg / Sheet', align: 'right',
    render: m => numCell(kgPerSheet(m), 4), export: m => kgPerSheet(m)?.toFixed(4) ?? '' },
  { key: 'packet_kg', label: 'Packet Weight', align: 'right',
    render: m => { const p = packetWeight(m); return p == null ? dash
      : <span className="tabular-nums text-slate-700">{p.toFixed(3)} kg</span>; },
    export: m => packetWeight(m)?.toFixed(3) ?? '' },
  { key: 'rate_per_kg', label: 'Rate ₹ / kg', align: 'right',
    render: m => { const r = rateKgOf(m, rates); return r == null ? dash
      : <span className="tabular-nums font-semibold text-slate-800">₹{r}</span>; },
    export: m => rateKgOf(m, rates) ?? '' },
  { key: 'rate_per_sheet', label: 'Rate ₹ / Sheet', align: 'right',
    render: m => { const rs = ratePerSheet(m, rateKgOf(m, rates)); return rs == null ? dash
      : <span className="tabular-nums font-semibold text-slate-800">₹{rs.toFixed(2)}</span>; },
    export: m => ratePerSheet(m, rateKgOf(m, rates))?.toFixed(2) ?? '' },
  { key: 'stock_value', label: 'Stock Value', align: 'right',
    render: m => { const v = stockValue(m, rates); return v == null ? dash
      : <span className="tabular-nums font-bold text-slate-900">₹{fmt.num(Math.round(v))}</span>; },
    export: m => { const v = stockValue(m, rates); return v == null ? '' : Math.round(v); } },
];

// Age distribution — the "aging control" now lives inline above each stock list
// (split per RM / FG) instead of a separate tab.
const AGE_BANDS = [['0–30d', 'bg-emerald-400'], ['31–60d', 'bg-amber-400'], ['61–90d', 'bg-orange-400'], ['90d+', 'bg-red-500']];
const bandIdx = d => d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;
function AgeBar({ items, unit = 'lines' }) {
  const counts = [0, 0, 0, 0];
  for (const d of items) { if (d == null) continue; counts[bandIdx(d)]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/60 px-4 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Age in stock</span>
      <div className="flex h-2.5 min-w-[160px] flex-1 overflow-hidden rounded-full bg-slate-100">
        {AGE_BANDS.map(([label, cls], i) => counts[i] > 0 && (
          <div key={label} className={cls} style={{ width: `${counts[i] / total * 100}%` }} title={`${label} · ${counts[i]} ${unit}`} />
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

// In-pill sub-buttons — e.g. In Stock / Leftover under RM or FG. Only visible
// inside the parent pill, keeping leftover right next to its own stock.
function SubTabs({ active, onChange, tabs }) {
  return (
    <div className="mb-3 inline-flex items-center gap-1 rounded-full bg-slate-100/80 p-1">
      {tabs.map(t => (
        <button key={t.key} type="button" onClick={() => onChange(t.key)}
          className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${active === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-slate-200/80 px-1.5 text-[10px] tabular-nums">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export default function Inventory() {
  const toast = useToast();
  const [tab, setTab] = useState('fg');
  const [stock, setStock] = useState([]);
  const [batches, setBatches] = useState([]);
  const [moves, setMoves] = useState([]);
  const [fg, setFg] = useState([]);
  const [leftovers, setLeftovers] = useState(null);
  const [leftoverFg, setLeftoverFg] = useState([]);
  // Board rate master — one ₹/kg per grade prices every board in it, so the
  // warehouse values stock from the same source Procurement buys at. Failing to
  // an empty list is deliberate: the rate columns show "—", never a wrong ₹0.
  const [boardRates, setBoardRates] = useState([]);
  const [fgSel, setFgSel] = useState(() => new Set());   // selected product ids on FG list
  const [move, setMove] = useState(null);                // FG movement modal (single product)
  const [rmSub, setRmSub] = useState('in');              // RM pill sub-view: in | leftover
  // Most of the 300-odd board masters hold nothing on any given day. The list
  // opens on what is actually in the warehouse; the empty and negative rows are
  // one tick away, because a negative row is a count correction someone still
  // has to chase, not noise to bury.
  const [showEmpty, setShowEmpty] = useState(false);
  const [fgSub, setFgSub] = useState('in');              // FG pill sub-view: in | leftover
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjLocked, setAdjLocked] = useState(false);   // opened from a row → material fixed
  const [adj, setAdj] = useState({ material_id: '', mode: 'add', qty: '', actual: '', batch_no: '', note: '' });
  const [viewing, setViewing] = useState(null);        // material row → 360° drawer
  const [picked, setPicked] = useState([]);            // selected material ids → PR
  const [prOpen, setPrOpen] = useState(false);
  // Threads hang off the BOARD MASTER, which is what an RM stock row is. The FG,
  // batch, leftover and ledger lists below are lots and movements — different
  // records entirely — so they carry no doorbell.
  const [threads, setThreads] = useState({});

  // Raising a PR is an ask, not a commitment, so the storekeeper who sees the
  // shortage can raise it. Mirrors canRaisePr on the server — keep the two in
  // step, and never show a control that would 403.
  const canRaisePr = ['admin', 'planner', 'production', 'qc'].includes(auth.user?.role);

  // A selection belongs to the list it was made on. The checkboxes and the
  // selection bar only exist on RM Stock → In Stock, so leaving that view has
  // to drop the picks: otherwise the header's Raise PR button would quietly
  // seed boards the user can no longer see, and a requisition is a real
  // document to raise off invisible state.
  useEffect(() => {
    if (tab !== 'stock' || rmSub !== 'in') setPicked([]);
  }, [tab, rmSub]);

  // Open the adjustment modal. Pass a stock row to adjust THAT material straight
  // away (row click / Adjust button) — no dropdown hunt; pass nothing for the
  // header button, which keeps the pick-from-list flow.
  const ADJ_BLANK = { material_id: '', mode: 'add', qty: '', actual: '', batch_no: '', note: '' };
  const openAdjust = (m) => {
    setAdj({ ...ADJ_BLANK, material_id: m ? String(m.id) : '' });
    setAdjLocked(!!m);
    setAdjOpen(true);
  };
  const closeAdjust = () => { setAdjOpen(false); setAdjLocked(false); setAdj(ADJ_BLANK); };

  // Live math for the adjustment modal — the system does the arithmetic so the
  // operator never types a signed number or guesses the resulting balance.
  const adjMat = stock.find(m => String(m.id) === String(adj.material_id));
  const adjAvail = +adjMat?.available || 0;
  const adjMag = Math.abs(+adj.qty || 0);
  const adjDelta = adj.mode === 'reduce' ? -adjMag : adjMag;
  const adjNewBalance = adjAvail + adjDelta;
  // Below-zero reductions are allowed (soft caution, not a block) — matches the
  // plant's count-correction reality where the position can legitimately go negative.
  const adjBelowZero = adj.mode === 'reduce' && adjMag > adjAvail;

  // Two-way binding between "quantity to add/remove" and "actual stock counted".
  // Either cell can be the one the operator types into; the other — and the
  // add/reduce direction — is derived. Typing a quantity is the original flow
  // and is untouched; typing a counted figure is the new shortcut.
  const setAdjQty = v => setAdj(a => {
    const mag = Math.abs(+v || 0);
    const delta = a.mode === 'reduce' ? -mag : mag;
    return { ...a, qty: v, actual: v === '' ? '' : String(adjAvail + delta) };
  });
  const setAdjActual = v => setAdj(a => {
    if (v === '') return { ...a, actual: '', qty: '' };
    const delta = (+v || 0) - adjAvail;
    return {
      ...a, actual: v,
      qty: delta === 0 ? '' : String(Math.abs(delta)),
      mode: delta < 0 ? 'reduce' : delta > 0 ? 'add' : a.mode,
    };
  });
  // Flipping direction or swapping material keeps the typed quantity and
  // re-derives the counted figure off the new basis.
  const setAdjMode = mode => setAdj(a => {
    const mag = Math.abs(+a.qty || 0);
    return { ...a, mode, actual: a.qty === '' ? '' : String(adjAvail + (mode === 'reduce' ? -mag : mag)) };
  });
  const setAdjMaterial = id => setAdj(a => {
    const avail = +stock.find(m => String(m.id) === String(id))?.available || 0;
    const mag = Math.abs(+a.qty || 0);
    return { ...a, material_id: id, actual: a.qty === '' ? '' : String(avail + (a.mode === 'reduce' ? -mag : mag)) };
  });
  const REASONS = adj.mode === 'reduce'
    ? ['Damage / wastage', 'Physical count correction', 'Sample / testing', 'Write-off']
    : ['Opening stock', 'Goods received', 'Physical count correction', 'Customer return'];

  const load = () => {
    api.get('/inventory/stock').then(ms => {
      setStock(ms);
      threadSummary('material', ms.map(m => m.id)).then(setThreads).catch(() => {});
    });
    api.get('/inventory/batches').then(setBatches);
    api.get('/inventory/movements').then(setMoves);
    api.get('/inventory/fg').then(setFg);
    api.get('/inventory/leftovers').then(setLeftovers);
    api.get('/inventory/leftover-fg').then(setLeftoverFg);
    api.get('/board-rates').then(setBoardRates).catch(() => setBoardRates([]));
  };
  useEffect(() => { load(); }, []);

  // FG-list movement — open the tolerance cascade for a product.
  const openMove = async f => {
    const preview = await api.get(`/fg/movement-preview?product_id=${f.product_id}`);
    setMove({
      product: f, preview,
      alloc: Object.fromEntries((preview.allocations || []).map(a => [a.order_line_id, a.dispatch_qty])),
      boxLeftover: true, vehicle: '', driver: '',
    });
  };
  const runMove = async (mode) => {
    const m = move;
    const allocations = (m.preview.allocations || [])
      .map(a => ({ order_line_id: a.order_line_id, qty: +m.alloc[a.order_line_id] || 0 }))
      .filter(a => a.qty > 0);
    const dispatched = allocations.reduce((s, a) => s + a.qty, 0);
    const leftover = Math.max(0, m.preview.available - dispatched);
    try {
      if (mode === 'dispatch') {
        const res = await api.post('/fg/move', {
          product_id: m.product.product_id, mode: 'dispatch', allocations,
          leftover_qty: m.boxLeftover ? leftover : 0, vehicle: m.vehicle, driver: m.driver,
        });
        toast.success(`${res.challans.length} challan(s) created${res.box ? ` · box ${res.box.box_number}` : ''}`);
      } else if (mode === 'leftover') {
        const res = await api.post('/fg/move', { product_id: m.product.product_id, mode: 'leftover', leftover_qty: m.preview.available });
        toast.success(`Boxed as leftover — ${res.box?.box_number}`);
      }
      setMove(null); setFgSel(new Set()); load();
    } catch (e) { toast.error(e.message || 'Movement failed'); }
  };
  const moveBoxToFg = async box => {
    if (!window.confirm(`Move box ${box.box_number || box.lot_number} (${fmt.num(box.remaining)}) back into FG stock?`)) return;
    try {
      await api.post(`/fg-lots/${box.id}/to-fg`, {});
      toast.success(`Box ${box.box_number || box.lot_number} moved to FG`);
      load();
    } catch (e) { toast.error(e.message || 'Could not move to FG'); }
  };

  // Multi-select "Move to FG" on the Leftover tab — one atomic batch.
  const [pickedBoxes, setPickedBoxes] = useState([]);
  const pickedRows = leftoverFg.filter(l => pickedBoxes.includes(l.id));
  const bulkMoveToFg = async () => {
    const ids = pickedRows.map(l => l.id);
    if (!ids.length) return;
    const total = pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0);
    if (!window.confirm(`Move ${ids.length} box${ids.length > 1 ? 'es' : ''} (${fmt.num(total)} cartons) back into FG stock?`)) return;
    try {
      const res = await api.post('/fg-lots/bulk-to-fg', { ids });
      toast.success(`${res.count} boxes moved to FG`);
      setPickedBoxes([]);
      load();
    } catch (e) { toast.error(e.message || 'Bulk move to FG failed'); }
  };

  const bulkLeftover = async () => {
    const picks = fg.filter(f => fgSel.has(f.product_id));
    try {
      for (const f of picks) await api.post('/fg/move', { product_id: f.product_id, mode: 'leftover', leftover_qty: f.qty });
      toast.success(`${picks.length} product(s) boxed as leftover`);
      setFgSel(new Set()); load();
    } catch (e) { toast.error(e.message || 'Bulk leftover failed'); }
  };

  const saveAdj = async () => {
    await api.post('/inventory/adjust', {
      material_id: +adj.material_id,
      qty: adjDelta,                          // system-signed: + for add, − for reduce
      batch_no: adj.mode === 'add' ? adj.batch_no : '',
      note: adj.note,
    });
    toast.success('Stock adjusted');
    closeAdjust();
    load();
  };

  return (
    <div>
      <PageHeader title="Warehouse" subtitle="Raw material and finished goods, live — every change is a ledger entry"
        actions={<>
          <Button variant="secondary" onClick={() => openAdjust(null)}><Plus size={15} /> Adjustment</Button>
          {canRaisePr && (
            <Button onClick={() => setPrOpen(true)}><ShoppingBag size={15} /> Raise Purchase Requisition</Button>
          )}
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'fg', label: 'FG Stock', count: fg.length },
        { key: 'stock', label: 'RM Stock' },
        { key: 'batches', label: 'RM Batches' },
        { key: 'moves', label: 'Movement Ledger' },
      ]} />

      {tab === 'stock' && (
        <SubTabs active={rmSub} onChange={setRmSub} tabs={[
          { key: 'in', label: 'In Stock' },
          { key: 'leftover', label: 'Leftover', count: leftovers?.masters.filter(m => m.available > 0).length || 0 },
        ]} />
      )}

      {tab === 'stock' && rmSub === 'in' && (() => {
        // Total board tonnage on hand — sum of computable row weights. Only
        // BOARDS carry weight; a board in stock that still can't be weighed
        // (genuinely gsm-less / missing sheet dims) is surfaced as a count beside
        // the figure so a missing board master stays visible, not absorbed as 0.
        // Non-boards (ink, film, adhesive, chemical) contribute to neither — they
        // aren't boards missing a GSM, they're simply not weighed here.
        const inStock = stock.filter(m => +m.available > 0);
        let kg = 0, missing = 0, pkt = 0;
        for (const m of inStock) {
          const w = rowWeight(m, m.available);
          if (w != null) kg += w;
          else if (m.category === 'board') missing++;
          pkt += packetsOf(m, m.available) || 0;
        }
        // Empty rows are every master at exactly zero; negative rows are counts
        // corrected below zero by an adjustment. Both hide together, and the
        // toggle says how many it is holding back so nothing vanishes silently.
        const hidden = stock.filter(m => +m.available <= 0).length;
        const rows = showEmpty ? stock : stock.filter(m => +m.available > 0);
        return (<>
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-2xl border border-[#1D1D1F]/[0.06] bg-white/60 px-4 py-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Packets on hand</div>
            <div className="mt-0.5 text-2xl font-black tabular-nums text-slate-900">
              {pktText(pkt)} <span className="text-sm font-bold text-slate-400">pkt</span>
              <span className="ml-2 text-sm font-semibold text-slate-400">({fmt.num(inStock.reduce((s, m) => s + (+m.available || 0), 0))} sheets)</span>
            </div>
          </div>
          <div className="h-9 w-px bg-slate-200" />
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Board tonnage on hand</div>
            <div className="mt-0.5 text-2xl font-black tabular-nums text-slate-900">
              {(kg / 1000).toFixed(2)} <span className="text-sm font-bold text-slate-400">t</span>
              <span className="ml-2 text-sm font-semibold text-slate-400">({fmt.num(Math.round(kg))} kg)</span>
            </div>
          </div>
          {missing > 0 && (
            <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-500">
              {missing} item{missing === 1 ? '' : 's'} without GSM — not weighed
            </div>
          )}
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 rounded-xl border border-[#1D1D1F]/[0.06] bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-slate-300">
            <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={showEmpty}
              onChange={e => setShowEmpty(e.target.checked)} />
            Show zero &amp; negative stock
            {hidden > 0 && !showEmpty && <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">{hidden} hidden</span>}
          </label>
        </div>
        <AgeBar items={inStock.map(m => m.age_days)} unit="materials" />
        {picked.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {picked.length} board{picked.length > 1 ? 's' : ''} selected
              <span className="ml-2 text-xs font-semibold text-slate-500">
                · {fmt.num(stock.filter(m => picked.includes(m.id)).reduce((s, m) => s + (+m.suggested || 0), 0))} sheets suggested
              </span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear</Button>
              {canRaisePr && (
                <Button size="sm" onClick={() => setPrOpen(true)}>
                  Raise Purchase Requisition
                </Button>
              )}
            </div>
          </div>
        )}
        <DataTable
          searchable
          dense
          selectable={canRaisePr}
          selectedIds={picked}
          onToggleRow={(row, checked) => setPicked(ids => checked
            ? [...new Set([...ids, row.id])]
            : ids.filter(id => id !== row.id))}
          onToggleAll={(visible, checked) => {
            // Select All follows DataTable's contract: the CURRENTLY VISIBLE
            // (searched + sorted) rows, not the whole board master.
            const ids = visible.map(r => r.id);
            setPicked(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          columns={[
            // Board name over its plant code — the same two-line identity the
            // Boards master shows, so the code on the floor ("2038340GB") reads
            // straight off the stock list. The old "Category" column is gone: it
            // said "board" on every row, because the board master IS the raw
            // material master.
            { key: 'name', label: 'Board', render: m => (<div><div className="font-semibold">{m.name}</div><div className="font-mono text-[11px] text-gray-400">{m.spec}</div></div>) },
            ...boardSpecColumns(boardRates),
            { key: 'available', label: 'Available (Packets / Sheets)', align: 'right',
              render: m => <StockCell m={m} sheets={m.available} short={m.short} />,
              export: m => stockText(m, m.available) },
            { key: 'weight', label: 'Total Weight', align: 'right', render: m => {
                const w = rowWeight(m, m.available);
                return w == null
                  ? <span className="text-xs text-slate-300">—</span>
                  : <span className="tabular-nums font-semibold text-slate-700">{w.toFixed(1)} kg</span>;
              } },
            { key: 'age', label: 'Age in Stock', render: m => (m.age_days != null && +m.available > 0) ? <AgeChip days={m.age_days} /> : <span className="text-xs text-slate-300">—</span> },
            { key: 'quarantine', label: 'Quarantine', align: 'right', render: m => <span className="tabular-nums text-amber-600">{fmt.num(m.quarantine)}</span> },
            { key: 'demand', label: 'Committed Demand', align: 'right', render: m => <span className="tabular-nums">{fmt.num(m.demand)}</span> },
            { key: 'reorder_level', label: 'Reorder Level', align: 'right', render: m => fmt.num(m.reorder_level) },
            { key: 'short', label: 'Health', render: m => m.short
                ? <span className="text-xs font-bold text-red-600">SHORT</span>
                : <span className="text-xs font-semibold text-emerald-600">OK</span> },
            threadColumn({ entity: 'material', threads, idOf: m => m.id }),
          ]}
          onRowClick={setViewing}
          rows={rows}
          rowClass={unreadRowClass(threads, m => m.id)}
          getRowId={m => m.id}
          exportName="RM Stock Position"
          exportSubtitle="Warehouse · Raw material"
          exportSummary={rows => [
            { label: 'Boards', value: rows.length },
            { label: 'Short', value: rows.filter(m => m.short).length },
            { label: 'Available (packets)', value: pktText(rows.reduce((s, m) => s + (packetsOf(m, m.available) || 0), 0)) },
            { label: 'Available (sheets)', value: fmt.num(rows.reduce((s, m) => s + (+m.available || 0), 0)) },
            { label: 'Committed demand', value: fmt.num(rows.reduce((s, m) => s + (+m.demand || 0), 0)) },
            { label: 'Board weight (kg)', value: fmt.num(Math.round(rows.reduce((s, m) => s + (rowWeight(m, m.available) || 0), 0))) },
            // Unrated boards contribute nothing rather than a fake ₹0, so this is
            // the value of the stock that HAS a rate on file — the count beside it
            // says how much stock is not priced.
            { label: 'Stock value (₹)', value: fmt.num(Math.round(rows.reduce((s, m) => s + (stockValue(m, boardRates) || 0), 0))) },
            { label: 'Boards with no rate', value: rows.filter(m => +m.available > 0 && rateKgOf(m, boardRates) == null).length },
          ]} />
      </>);
      })()}

      {tab === 'fg' && (
        <SubTabs active={fgSub} onChange={setFgSub} tabs={[
          { key: 'in', label: 'In Stock', count: fg.length },
          { key: 'leftover', label: 'Leftover', count: leftoverFg.length || 0 },
        ]} />
      )}

      {tab === 'fg' && fgSub === 'in' && (<>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <AgeBar items={fg.map(f => f.age_days)} unit="SKUs" />
        </div>
        {fgSel.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-brand-200 bg-brand-50/60 px-4 py-2.5">
            <span className="text-sm font-semibold text-brand-700">{fgSel.size} selected</span>
            <Button size="sm" variant="secondary" onClick={bulkLeftover}>Box selected as Leftover</Button>
            <button type="button" onClick={() => setFgSel(new Set())} className="text-xs font-semibold text-slate-500 hover:text-slate-700">Clear</button>
          </div>
        )}
        <DataTable
          searchable
          columns={[
            { key: 'sel', label: '', render: f => (
              <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={fgSel.has(f.product_id)}
                onChange={e => setFgSel(s => { const n = new Set(s); e.target.checked ? n.add(f.product_id) : n.delete(f.product_id); return n; })} />) },
            { key: 'product_name', label: 'Product', render: f => (<div><div className="font-semibold">{f.product_name}</div><div className="text-xs text-gray-400">{f.code}</div></div>) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'qty', label: 'Cartons in Stock', align: 'right', render: f => <span className="font-bold tabular-nums">{fmt.num(f.qty)}</span> },
            { key: 'age', label: 'Age in Stock', render: f => f.age_days != null ? <AgeChip days={f.age_days} /> : <span className="text-xs text-slate-300">—</span> },
            { key: 'value', label: 'Value', align: 'right', render: f => fmt.inr(f.qty * f.rate) },
            { key: 'move', label: '', align: 'right', render: f => <Button size="sm" onClick={() => openMove(f)}>Move…</Button> },
          ]}
          rows={fg} empty="No finished goods in stock"
          exportName="FG Stock"
          exportSubtitle="Warehouse · Finished goods"
          exportSummary={rows => [
            { label: 'SKUs in stock', value: rows.length },
            { label: 'Cartons', value: fmt.num(rows.reduce((s, f) => s + (+f.qty || 0), 0)) },
            { label: 'Stock value', value: fmt.inr(rows.reduce((s, f) => s + (+f.qty || 0) * (+f.rate || 0), 0)) },
          ]} />
      </>)}

      {tab === 'batches' && (
        <DataTable searchable
          columns={[
            { key: 'batch_no', label: 'Batch', render: b => <span className="font-mono text-xs font-semibold">{b.batch_no}</span> },
            { key: 'material_name', label: 'Board' },
            { key: 'qty', label: 'Remaining', align: 'right', render: b => `${fmt.num(b.qty)} ${b.unit}` },
            { key: 'initial_qty', label: 'Received', align: 'right', render: b => fmt.num(b.initial_qty) },
            { key: 'status', label: 'Status', render: b => <StatusBadge status={b.status} /> },
            { key: 'created_at', label: 'Received On', render: b => fmt.date(b.created_at) },
            { key: 'age', label: 'Age', render: b => b.status === 'available' && b.qty > 0 ? <AgeChip date={b.created_at} /> : null },
          ]}
          rows={batches}
          exportName="RM Batches"
          exportSubtitle="Warehouse · Batch-wise raw material" />
      )}

      {tab === 'stock' && rmSub === 'leftover' && (
        <div className="space-y-4">
          <DataTable
            searchable
            dense
            columns={[
              { key: 'code', label: 'Code', render: m => <span className="font-mono text-xs font-semibold">{m.code}</span> },
              { key: 'name', label: 'Leftover', render: m => (<div><div className="font-semibold">{m.name}</div><div className="text-xs text-gray-400">from {m.source_name || '—'}</div></div>) },
              { key: 'size', label: 'Strip Size', render: m => <span className="tabular-nums">{m.sheet_l}×{m.sheet_w}"</span> },
              // Same board columns as the RM list. A strip keeps its OWN size (the
              // Strip Size column above, so the shared sheet_size one is dropped)
              // but inherits grade/GSM/pack from the board it was cut from, which
              // is what makes an offcut weighable and valuable at all.
              ...boardSpecColumns(boardRates).filter(c => c.key !== 'sheet_size'),
              { key: 'available', label: 'Available (Packets / Sheets)', align: 'right',
                render: m => <StockCell m={m} sheets={m.available} />,
                export: m => stockText(m, m.available) },
              { key: 'weight', label: 'Total Weight', align: 'right', render: m => {
                  const w = rowWeight(m, m.available);
                  return w == null
                    ? <span className="text-xs text-slate-300">—</span>
                    : <span className="tabular-nums font-semibold text-slate-700">{w.toFixed(1)} kg</span>;
                } },
            ]}
            onRowClick={setViewing}
            rows={leftovers?.masters || []} empty="No leftover stock banked yet — plan a job on an odd board and push its offcut here"
            exportName="Leftover Stock"
            exportSubtitle="Warehouse · Banked offcut strips" />
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-400">Lots — oldest first</h3>
            <DataTable
              searchable
              columns={[
                { key: 'batch_no', label: 'Lot', render: b => <span className="font-mono text-xs font-semibold">{b.batch_no}</span> },
                { key: 'material_name', label: 'Leftover' },
                { key: 'origin', label: 'Stage', render: b => b.origin === 'planned'
                    ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-600">Planned</span>
                    : <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600">Confirmed</span> },
                { key: 'source', label: 'From', render: b => <span className="text-xs text-gray-500">{b.origin === 'planned' ? `line ${String(b.batch_no).replace('LO-PLAN-', '')}` : (String(b.batch_no).startsWith('LO-') ? String(b.batch_no).slice(3) : '—')}</span> },
                { key: 'qty', label: 'Sheets', align: 'right', render: b => fmt.num(b.qty) },
                { key: 'age', label: 'Age', render: b => <AgeChip days={b.age_days} /> },
                { key: 'created_at', label: 'Banked On', render: b => fmt.date(b.created_at) },
              ]}
              rows={leftovers?.lots || []} empty="No lots"
              exportName="Leftover Lots"
              exportSubtitle="Warehouse · Oldest first" />
          </div>
        </div>
      )}

      {tab === 'fg' && fgSub === 'leftover' && (<>
        <AgeBar items={leftoverFg.map(l => l.age_days)} unit="boxes" />
        {pickedBoxes.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} selected
              <span className="ml-2 text-xs font-semibold text-slate-500">· {fmt.num(pickedRows.reduce((s, l) => s + (+l.remaining || 0), 0))} cartons</span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPickedBoxes([])}>Clear</Button>
              <Button size="sm" onClick={bulkMoveToFg}>Move {pickedBoxes.length} box{pickedBoxes.length > 1 ? 'es' : ''} to FG</Button>
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
            { key: 'product_name', label: 'Product', render: l => (<div><div className="font-semibold">{l.product_name}</div><div className="text-xs text-gray-400">{l.code}</div></div>) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'remaining', label: 'Cartons', align: 'right', render: l => <span className="font-bold tabular-nums">{fmt.num(l.remaining)}</span> },
            { key: 'source', label: 'Source', render: l => <span className="text-xs capitalize text-gray-500">{(l.source || '').replace(/_/g, ' ') || l.jc_number || '—'}</span> },
            { key: 'age', label: 'Age', render: l => <AgeChip days={l.age_days} /> },
            { key: 'move', label: '', align: 'right', render: l => <Button size="sm" variant="secondary" onClick={() => moveBoxToFg(l)}>Move to FG</Button> },
          ]}
          rows={leftoverFg} empty="No finished-goods leftover boxes — move some from FG stock (In Stock → Move…) or box a dispatch overrun."
          exportName="Leftover FG Boxes"
          exportSubtitle="Warehouse · Finished-goods leftover boxes" />
      </>)}

      {tab === 'moves' && (
        <DataTable searchable
          columns={[
            { key: 'created_at', label: 'When', render: m => fmt.dt(m.created_at) },
            { key: 'type', label: 'Type', render: m => <StatusBadge status={m.type === 'consumption' || m.type === 'dispatch' ? 'cancelled' : m.type === 'grn' ? 'quarantine' : 'available'} /> && <span className="text-xs font-semibold capitalize">{m.type.replace('_', ' ')}</span> },
            { key: 'material_name', label: 'Item', render: m => m.material_name || m.product_name || '—' },
            { key: 'qty', label: 'Qty', align: 'right', render: m => <span className={`font-bold tabular-nums ${m.qty < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{m.qty > 0 ? '+' : ''}{fmt.num(m.qty)}</span> },
            { key: 'note', label: 'Note', render: m => <span className="text-xs text-gray-500">{m.note || `${m.ref_type || ''} #${m.ref_id || ''}`}</span> },
          ]}
          rows={moves}
          exportName="Movement Ledger"
          exportSubtitle="Warehouse · Every stock change, audited" />
      )}

      <Modal open={adjOpen} onClose={closeAdjust}
        title={adjLocked && adjMat ? `Stock Adjustment — ${adjMat.name}` : 'Stock Adjustment'}
        footer={<>
          <Button variant="secondary" onClick={closeAdjust}>Cancel</Button>
          <Button variant={adj.mode === 'reduce' ? 'danger' : 'success'} onClick={saveAdj}
            disabled={!adj.material_id || !adjMag}>
            {adj.mode === 'reduce' ? 'Reduce' : 'Add'} Stock
          </Button>
        </>}>
        <div className="space-y-4">
          {/* Add / Reduce — direction lives here, not in a signed number */}
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

          {/* Row-launched adjustments already know their material — show it fixed
              rather than a dropdown the operator has to re-find, with an escape
              hatch back to the full list. */}
          {adjLocked && adjMat ? (
            <Field label="Board">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-[#1D1D1F]/10 bg-white/70 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">{adjMat.name}</div>
                  <div className="truncate text-xs text-slate-400">{adjMat.code || adjMat.spec || fmt.title(adjMat.category)}</div>
                </div>
                <button type="button" onClick={() => setAdjLocked(false)}
                  className="shrink-0 text-xs font-semibold text-[#007AFF] hover:underline">Change</button>
              </div>
            </Field>
          ) : (
            <Field label="Board" required>
              <Select value={adj.material_id} onChange={e => setAdjMaterial(e.target.value)}>
                <option value="">Select board…</option>
                {stock.map(m => <option key={m.id} value={m.id} data-search={searchText(m)}>{m.name}</option>)}
              </Select>
            </Field>
          )}

          {/* Live position + system-computed balance */}
          {adjMat && (
            <div className="rounded-2xl border border-[#1D1D1F]/[0.08] bg-white/70 p-3.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{adjMat.spec || fmt.title(adjMat.category)}</span>
                <span>Reorder at {fmt.num(adjMat.reorder_level)} {adjMat.unit}
                  {adjMat.quarantine > 0 && <> · {fmt.num(adjMat.quarantine)} in quarantine</>}</span>
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
                  <div className={`text-xl font-black ${adjBelowZero ? 'text-amber-600' : 'text-[#007AFF]'}`}>
                    {fmt.num(adjNewBalance)} <span className="text-xs font-semibold text-slate-400">{adjMat.unit}</span>
                  </div>
                </div>
              </div>
              {adjBelowZero && (
                <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700">
                  Heads up — only {fmt.num(adjAvail)} {adjMat.unit} on hand. This takes the position to {fmt.num(adjNewBalance)} {adjMat.unit} (below zero). It will still be recorded.
                </div>
              )}
            </div>
          )}

          {/* Type EITHER cell — quantity or counted stock. The other one, and the
              add/reduce direction, follow automatically. */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
            <Field label={adj.mode === 'reduce' ? 'Quantity to remove' : 'Quantity to add'} required>
              <div className="relative">
                <Input type="number" min="0" value={adj.qty}
                  onChange={e => setAdjQty(e.target.value)} placeholder="e.g. 5000" />
                {adjMat && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">{adjMat.unit}</span>}
              </div>
            </Field>
            <div className="pt-8 text-xs font-bold uppercase tracking-wide text-slate-300">or</div>
            <Field label="Actual stock counted" hint={adjMat ? `On system: ${fmt.num(adjAvail)} ${adjMat.unit}` : 'Pick a board first'}>
              <div className="relative">
                <Input type="number" min="0" value={adj.actual} disabled={!adjMat}
                  onChange={e => setAdjActual(e.target.value)} placeholder="e.g. 4200" />
                {adjMat && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">{adjMat.unit}</span>}
              </div>
            </Field>
          </div>

          {adjMat && adj.actual !== '' && (
            <div className={`-mt-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold ${adjMag === 0 ? 'bg-slate-50 text-slate-500' : adj.mode === 'reduce' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>
              {adjMag === 0
                ? `Counted figure matches the system — nothing to adjust.`
                : `Counted ${fmt.num(+adj.actual)} vs ${fmt.num(adjAvail)} on system — auto-set to ${adj.mode === 'reduce' ? 'reduce' : 'add'} ${fmt.num(adjMag)} ${adjMat.unit}.`}
            </div>
          )}

          {adj.mode === 'add' && (
            <Field label="Batch No" hint="Leave blank to auto-generate">
              <Input value={adj.batch_no} onChange={e => setAdj({ ...adj, batch_no: e.target.value })} placeholder="Supplier / lot reference" />
            </Field>
          )}

          <Field label="Reason">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {REASONS.map(r0 => (
                <button key={r0} type="button" onClick={() => setAdj({ ...adj, note: r0 })}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-all ${adj.note === r0 ? 'border-[#007AFF] bg-[#007AFF]/10 text-[#007AFF]' : 'border-[#1D1D1F]/10 bg-white/60 text-slate-600 hover:border-[#007AFF]/40'}`}>
                  {r0}
                </button>
              ))}
            </div>
            <Textarea value={adj.note} onChange={e => setAdj({ ...adj, note: e.target.value })} placeholder="Add a note for the ledger…" />
          </Field>
        </div>
      </Modal>

      {/* FG movement — the single place to move FG: keep, dispatch (tolerance
          cascade across sales orders), or box the remainder as leftover. */}
      <Modal wide open={!!move} onClose={() => setMove(null)}
        title={move ? `Move FG — ${move.product.product_name}` : ''}
        footer={move && (() => {
          const dispatched = (move.preview.allocations || []).reduce((s, a) => s + (+move.alloc[a.order_line_id] || 0), 0);
          const leftover = Math.max(0, move.preview.available - dispatched);
          return (<>
            <Button variant="secondary" onClick={() => setMove(null)}>Keep in FG</Button>
            <Button variant="secondary" onClick={() => runMove('leftover')}>Box all {fmt.num(move.preview.available)} as Leftover</Button>
            <Button disabled={dispatched === 0} onClick={() => runMove('dispatch')}>
              Dispatch {fmt.num(dispatched)}{move.boxLeftover && leftover > 0 ? ` · box ${fmt.num(leftover)}` : ''}
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
                <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm text-slate-500">No open sales orders want this product right now — box it all as leftover, or keep it in FG.</p>
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

      {/* ── Material 360° — where an adjustment now lives ── */}
      {viewing && (
        <MasterHistory kind="materials" record={viewing} onClose={() => setViewing(null)}
          actions={
            <Button size="sm" variant="secondary"
              onClick={() => { const m = viewing; setViewing(null); openAdjust(m); }}>
              Adjust Stock
            </Button>
          } />
      )}

      {/* ── Warehouse door into the ONE procurement lifecycle ── */}
      <NewRequisitionModal
        open={prOpen}
        onClose={() => setPrOpen(false)}
        onRaised={() => { setPicked([]); load(); }}
        seedMaterialIds={picked}
        defaults={{ department: 'Stores', purpose: 'stock_replenishment' }} />
    </div>
  );
}
