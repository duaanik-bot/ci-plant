// Inventory — one raw-material stock truth: position, batches and movement ledger.
import { useEffect, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { kgPerSheet, packetWeight, ratePerSheet, resolveRatePerKg, totalWeight } from '../lib/boardMath.js';
import { packetsOf, packetText } from '../lib/packets.js';
import { stockSplit } from '../lib/replenishment.js';
import { AgeChip, Button, DataTable, Field, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, PageHeader, searchText, Select, StatusBadge, Tabs, Textarea, useKpiFilter, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { HEALTH, healthOf, HealthBadge } from '../components/BoardHealth.jsx';
import { Plus, Minus, ShoppingBag, Layers, Lock, PackageCheck, AlertTriangle, Truck, ShieldAlert } from 'lucide-react';
import MasterHistory from '../components/MasterHistory.jsx';
import NewRequisitionModal from '../components/NewRequisitionModal.jsx';
import ProductIdentity from '../components/ProductIdentity.jsx';

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

// packetsOf / packetText moved to lib/packets.js when the station queue began
// showing packets under its sheet figures. Same arithmetic on both screens by
// construction — a second copy is how 2.5 packets becomes 3 on one of them.
// Every stock figure here still leads with packets, the warehouse's own unit,
// and carries its sheet equivalent underneath.

// Two-line stock cell — packets in front, sheets beneath. Used by every raw
// material list so RM stock reads the same wherever it appears.
//
// It used to take a `short` flag and paint the packet figure red. That tint was
// a THIRD reader of `m.short` — the same boolean behind the old SHORT badge and
// the export's Short count — and `short` is computed from `reserved`, a demand
// definition blind to board_allocations. So the shelf figure could turn red
// while every column beside it read fine, and nothing on the row explained why.
// The verdict now lives in exactly one place, the Health column, which reads
// the columns it sits next to. A quantity is a quantity here; the judgement is
// Health's job.
function StockCell({ m, sheets }) {
  const p = packetsOf(m, sheets);
  return (
    <div className="leading-tight">
      <div className="text-[15px] font-black tabular-nums text-gray-900">
        {packetText(p)}<span className="ml-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">pkt</span>
      </div>
      <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-slate-400">
        {fmt.num(sheets)} sheets
      </div>
    </div>
  );
}

// Plain-text twin of StockCell for PDF/XLSX export, where a two-line cell has to
// collapse into one string.
const stockText = (m, sheets) => `${packetText(packetsOf(m, sheets))} pkt · ${fmt.num(sheets)} sheets`;

// Which of a stock row's four figures BoardHealth judges, spelled ONCE. Three
// readers ask for this verdict — the Health cell, its export twin, and the
// export summary's count — and a row mapped by hand at each of them is how one
// of them ends up quoting `reserved` again six months from now. The module owns
// the ladder; this owns which columns feed it.
const healthOfRow = m => {
  const s = stockSplit(m);
  return healthOf({ openWriteOn: m.open_writeon_qty, frozen: s.committed, free: s.net, buyLine: m.reorder_level });
};

// "Worst first" on the Health header, in the ladder's own declared order —
// BoardHealth says the order IS the semantics, so this reads it rather than
// re-spelling it. It exists because the Health column still carries `key:
// 'short'`, which is a REAL field on the row: without a sortValue the
// comparator falls back to `a['short']` and ranks a four-state verdict by the
// retired boolean this task exists to stop reading. That is a nastier failure
// than the dead sort the Shortfall column documents — the rows do move, and
// they move plausibly, so nothing on screen says the order is wrong.
const HEALTH_RANK = Object.keys(HEALTH);

// The same two-unit reading as StockCell, for the columns that sit BESIDE
// Available and were sheets-only: a storekeeper comparing "committed" or "on
// order" against "available" was converting one of the three in his head.
// Keeps each column's own colour, and greys a zero so the row still scans.
function UnitCell({ m, sheets, tone }) {
  const n = Math.round(+sheets || 0);
  if (!n) return <span className="tabular-nums text-slate-300">—</span>;
  return (
    <div className="leading-tight">
      <div className={`tabular-nums font-semibold ${tone}`}>
        {packetText(packetsOf(m, n))}<span className="ml-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">pkt</span>
      </div>
      <div className="mt-0.5 text-[11px] font-semibold tabular-nums text-slate-400">{fmt.num(n)} sheets</div>
    </div>
  );
}

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
  { key: 'grade', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Grade',
    render: m => (m.grade
      ? <span className="inline-block rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">{m.grade}</span>
      : dash),
    export: m => m.grade || '' },
  { key: 'gsm', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'GSM', align: 'right', render: m => numCell(m.gsm), export: m => m.gsm ?? '' },
  { key: 'sheet_size', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Sheet Size',
    render: m => (m.sheet_l ? <span className="whitespace-nowrap font-mono text-xs">{m.sheet_l}×{m.sheet_w}"</span> : dash),
    export: m => (m.sheet_l ? `${m.sheet_l}x${m.sheet_w}` : '') },
  { key: 'sheets_per_packet', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Sheets / Packet', align: 'right',
    render: m => numCell(m.sheets_per_packet), export: m => m.sheets_per_packet ?? '' },
  { key: 'kg_per_sheet', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Kg / Sheet', align: 'right',
    render: m => numCell(kgPerSheet(m), 4), export: m => kgPerSheet(m)?.toFixed(4) ?? '' },
  { key: 'packet_kg', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Packet Weight', align: 'right',
    render: m => { const p = packetWeight(m); return p == null ? dash
      : <span className="tabular-nums text-slate-700">{p.toFixed(3)} kg</span>; },
    export: m => packetWeight(m)?.toFixed(3) ?? '' },
  { key: 'rate_per_kg', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Rate ₹ / kg', align: 'right',
    render: m => { const r = rateKgOf(m, rates); return r == null ? dash
      : <span className="tabular-nums font-semibold text-slate-800">₹{r}</span>; },
    export: m => rateKgOf(m, rates) ?? '' },
  { key: 'rate_per_sheet', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Rate ₹ / Sheet', align: 'right',
    render: m => { const rs = ratePerSheet(m, rateKgOf(m, rates)); return rs == null ? dash
      : <span className="tabular-nums font-semibold text-slate-800">₹{rs.toFixed(2)}</span>; },
    export: m => ratePerSheet(m, rateKgOf(m, rates))?.toFixed(2) ?? '' },
  { key: 'stock_value', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Stock Value', align: 'right',
    render: m => { const v = stockValue(m, rates); return v == null ? dash
      : <span className="tabular-nums font-bold text-slate-900">₹{fmt.num(Math.round(v))}</span>; },
    export: m => { const v = stockValue(m, rates); return v == null ? '' : Math.round(v); } },
];

// What each RM KPI card is filtering the board list down to, said in the same
// words the card uses.
const RM_KPI_LABEL = {
  committed: 'boards with stock frozen for a job',
  net: 'boards with stock still free to promise',
  // One sentence, because the two cards it replaces became one. `pr` and
  // `incoming` are deleted rather than kept "just in case": no card can select
  // those keys any more, and a label for a card nobody can click is the second
  // vocabulary this rebuild exists to remove.
  on_order: 'boards with board on a PR or a PO',
  reorder: 'boards whose free stock is below the buy line',
  // `over` was missing entirely, so the ONE fault card on this strip produced
  // the nameless notice "the selected KPI". Task 2 renames the card; the key it
  // filters on stays `over`, and it needs a sentence like every other.
  over: 'boards short of what their jobs need',
};

// Age distribution — the "aging control" now lives inline above each stock list
// instead of a separate tab.
const AGE_BANDS = [['0–30d', 'bg-emerald-400'], ['31–60d', 'bg-amber-400'], ['61–90d', 'bg-orange-400'], ['90d+', 'bg-red-500']];
const bandIdx = d => d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;
function AgeBar({ items, unit = 'lines', compact = false }) {
  const counts = [0, 0, 0, 0];
  for (const d of items) { if (d == null) continue; counts[bandIdx(d)]++; }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  // Inline form for a control row. A full-width banner spent a whole line of
  // screen on a distribution nobody reads twice, and the per-row Age in Stock
  // column already carries the detail — so this keeps the shape and the counts
  // and gives the line back to the table. Empty bands are dropped rather than
  // printed as zeros.
  if (compact) {
    return (
      <div className="flex items-center gap-2" title={AGE_BANDS.map(([l], i) => `${l}: ${counts[i]} ${unit}`).join('  ·  ')}>
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Age</span>
        <div className="flex h-2 w-20 overflow-hidden rounded-full bg-slate-100">
          {AGE_BANDS.map(([label, cls], i) => counts[i] > 0 && (
            <div key={label} className={cls} style={{ width: `${counts[i] / total * 100}%` }} title={`${label} · ${counts[i]} ${unit}`} />
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tabular-nums text-slate-500">
          {AGE_BANDS.map(([label, cls], i) => counts[i] > 0 && (
            <span key={label} className="flex items-center gap-1" title={`${label} · ${counts[i]} ${unit}`}>
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />{counts[i]}
            </span>
          ))}
        </span>
      </div>
    );
  }
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

// In-pill sub-buttons — e.g. In Stock / Leftover under RM. Only visible
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
  // Lands on whichever tab leads — every other module in the plant opens on its
  // first chip, so RM moving to the front has to bring the landing tab with it.
  const [tab, setTab] = useState('stock');
  const [stock, setStock] = useState([]);
  const [batches, setBatches] = useState([]);
  // Recounting one pile's loose sheets — the deliberate correction of the
  // packet count nobody has ever recorded. Blank clears it back to derived.
  const [looseEdit, setLooseEdit] = useState(null);
  const [moves, setMoves] = useState([]);
  const [leftovers, setLeftovers] = useState(null);
  // Board rate master — one ₹/kg per grade prices every board in it, so the
  // warehouse values stock from the same source Procurement buys at. Failing to
  // an empty list is deliberate: the rate columns show "—", never a wrong ₹0.
  const [boardRates, setBoardRates] = useState([]);
  const [rmSub, setRmSub] = useState('in');              // RM pill sub-view: in | leftover
  // Most of the 300-odd board masters hold nothing on any given day. The list
  // opens on what is actually in the warehouse; the empty and negative rows are
  // one tick away, because a negative row is a count correction someone still
  // has to chase, not noise to bury.
  const [showEmpty, setShowEmpty] = useState(false);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adjLocked, setAdjLocked] = useState(false);   // opened from a row → material fixed
  const [adj, setAdj] = useState({ material_id: '', mode: 'add', qty: '', actual: '', batch_no: '', note: '' });
  const [viewing, setViewing] = useState(null);        // material row → 360° drawer
  const [picked, setPicked] = useState([]);            // selected material ids → PR
  const [prOpen, setPrOpen] = useState(false);
  // RM stock KPI strip: which card is filtering the board list beneath it.
  // Scoped to the sub-view so leaving "In Stock" never leaves a hidden filter on.
  const rmKpi = useKpiFilter(`${tab}:${rmSub}`);
  // Grade rail — FBB / Duplex / Saffire …. The KPI totals are computed AFTER
  // this filter, so picking a grade re-states the whole warehouse position for
  // that grade rather than just hiding rows under unchanged totals.
  const [rmGrade, setRmGrade] = useState('all');
  // Threads hang off the BOARD MASTER, which is what an RM stock row is. The
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
  // A reduction beyond the book is still allowed, but it no longer drives the
  // position negative: the server covers what it can and WRITES ON the rest, so
  // the balance lands at nil (see issueWithWriteOn in helpers.js). Preview that,
  // or this dialog promises a −110 the ledger will never hold — which is exactly
  // what it did until a UAT caught it.
  const adjNewBalance = Math.max(0, adjAvail + adjDelta);
  const adjWritesOn = adj.mode === 'reduce' && adjMag > adjAvail;
  const adjWriteOnQty = adjWritesOn ? adjMag - adjAvail : 0;

  // Two-way binding between "quantity to add/remove" and "actual stock counted".
  // Either cell can be the one the operator types into; the other — and the
  // add/reduce direction — is derived. Typing a quantity is the original flow
  // and is untouched; typing a counted figure is the new shortcut.
  const setAdjQty = v => setAdj(a => {
    const mag = Math.abs(+v || 0);
    const delta = a.mode === 'reduce' ? -mag : mag;
    return { ...a, qty: v, actual: v === '' ? '' : String(Math.max(0, adjAvail + delta)) };
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
    return { ...a, mode, actual: a.qty === '' ? '' : String(Math.max(0, adjAvail + (mode === 'reduce' ? -mag : mag))) };
  });
  const setAdjMaterial = id => setAdj(a => {
    const avail = +stock.find(m => String(m.id) === String(id))?.available || 0;
    const mag = Math.abs(+a.qty || 0);
    return { ...a, material_id: id, actual: a.qty === '' ? '' : String(Math.max(0, avail + (a.mode === 'reduce' ? -mag : mag))) };
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
    api.get('/inventory/leftovers').then(setLeftovers);
    api.get('/board-rates').then(setBoardRates).catch(() => setBoardRates([]));
  };
  useEffect(() => { load(); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

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
      <PageHeader title="Warehouse" subtitle="Raw material stock, leftovers, batches and the movement ledger"
        actions={<>
          <Button variant="secondary" onClick={() => openAdjust(null)}><Plus size={15} /> Adjustment</Button>
          {canRaisePr && (
            <Button onClick={() => setPrOpen(true)}><ShoppingBag size={15} /> Raise Purchase Requisition</Button>
          )}
        </>} />
      <Tabs active={tab} onChange={setTab} tabs={[
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
        // Tonnage, packets and the "can't be weighed" count are accumulated with
        // the rest of the position below, so every figure on the strip follows
        // the SAME grade filter. Only BOARDS carry weight; a board that still
        // can't be weighed (gsm-less / missing sheet dims) is counted out loud
        // rather than absorbed as a silent 0. Non-boards (ink, film, adhesive)
        // are simply not weighed here.
        //
        // Empty rows are every master at exactly zero; negative rows are counts
        // corrected below zero by an adjustment. Both hide together, and the
        // toggle says how many it is holding back so nothing vanishes silently.
        // Grade rail, built from the data so a new grade in the master appears
        // on its own without a code change. Counts are of the rows behind each
        // chip, so an empty grade is visibly empty rather than missing.
        const gradeOf = m => (m.grade || '').trim() || 'Ungraded';
        const grades = [...new Set(stock.map(gradeOf))].sort((a, b) =>
          stock.filter(m => gradeOf(m) === b).length - stock.filter(m => gradeOf(m) === a).length);
        // THE POSITION SET — every board in the chosen grade, INCLUDING the ones
        // holding nothing. A board at zero is a real position, and it is exactly
        // the board a requisition gets raised against: counting only boards with
        // stock is how "PR raised" came to read nil while six live requisitions
        // for 42,200 sheets sat against three empty boards. The zero-stock toggle
        // below governs the LIST only — never the position.
        const base = rmGrade === 'all' ? stock : stock.filter(m => gradeOf(m) === rmGrade);
        const hidden = base.filter(m => +m.available <= 0).length;

        // The warehouse position, summed from the SAME per-board split the
        // server sends (client twin recomputes it so a stale response can never
        // show a number the server would not have produced).
        //
        // Every figure is per-board and never netted across boards — one
        // board's surplus cannot cover another's shortage. Because
        // committed + free === available on every row, Gross = Committed +
        // Balance holds exactly on the strip. Shortfall sits outside that sum:
        // it is demand with no stock behind it, not stock.
        const pos = base.reduce((a, m) => {
          const s = stockSplit(m);
          a.gross += Math.max(0, +m.available || 0);
          a.committed += s.committed;
          a.net += s.net;
          a.over += s.over_committed;
          const pr = +m.pr_qty || 0, inc = +m.incoming || 0;
          a.pr += pr;
          a.incoming += inc;
          // Weight and packets are carried for EVERY figure, not just gross —
          // board is bought by the kilo, so a quantity the plant cannot weigh is
          // a quantity it cannot price or plan a truck around. All of them follow
          // the SAME filtered set, so picking a grade re-states every card.
          //
          // Only the gross pass counts a board that cannot be weighed at all: it
          // is one master-data gap, and rowWeight() returns a real 0 for a board
          // holding nothing, so an empty row is never mistaken for a missing GSM.
          const gq = Math.max(0, +m.available || 0);
          const w = rowWeight(m, gq);
          if (w != null) a.grossKg += w; else if (m.category === 'board') a.noWeight++;
          a.committedKg += rowWeight(m, s.committed) || 0;
          a.netKg += rowWeight(m, s.net) || 0;
          a.prKg += rowWeight(m, pr) || 0;
          a.incomingKg += rowWeight(m, inc) || 0;
          a.grossPkt += packetsOf(m, gq) || 0;
          a.committedPkt += packetsOf(m, s.committed) || 0;
          a.netPkt += packetsOf(m, s.net) || 0;
          a.prPkt += packetsOf(m, pr) || 0;
          a.incomingPkt += packetsOf(m, inc) || 0;
          a.overKg += rowWeight(m, s.over_committed) || 0;
          a.overPkt += packetsOf(m, s.over_committed) || 0;
          // How much of the sales book this demand actually is. Unioned by id,
          // never summed: the Planning Engine can split ONE line across two
          // boards, and adding the per-board counts would report it twice.
          if (+m.committed_qty > 0) {
            for (const id of m.committed_line_ids || []) a.cmtLines.add(id);
            for (const id of m.committed_product_ids || []) a.cmtProducts.add(id);
          }
          if (gq > 0) a.stockedBoards++;
          if (s.committed > 0) a.committedBoards++;
          if (s.net > 0) a.netBoards++;
          if (+m.pr_qty > 0) { a.prBoards++; a.prCount += +m.pr_count || 0; }
          if (+m.incoming > 0) a.incomingBoards++;
          // A board is over-committed when planning has locked more than the
          // shelf holds. Counted per board and never netted: another board's
          // surplus is not cover for this one's hole.
          if (s.over_committed > 0) {
            a.overBoards++;
            // Already answered = an open PR or an unreceived PO on that board.
            // The gap is the same either way; whether anyone has acted on it
            // is what tells a buyer where to look first.
            if (pr > 0 || inc > 0) a.overAnsweredBoards++; else a.overOpen += s.over_committed;
          }
          // `reorderHit` used to be counted here. Nothing in the tree has ever
          // set that field — the line survived only because `reorderBoards` is
          // recomputed from `belowReorder` a few lines below, which is the real
          // rule (free stock, not gross). Counting a field that is always
          // undefined is a rule nobody can find when the number looks wrong.
          return a;
        }, { gross: 0, committed: 0, net: 0, over: 0, overOpen: 0, pr: 0, incoming: 0, noWeight: 0,
             grossPkt: 0, committedPkt: 0, netPkt: 0, prPkt: 0, incomingPkt: 0, overPkt: 0,
             grossKg: 0, committedKg: 0, netKg: 0, prKg: 0, incomingKg: 0, overKg: 0,
             stockedBoards: 0, committedBoards: 0, netBoards: 0, prBoards: 0, prCount: 0,
             incomingBoards: 0, reorderBoards: 0, overBoards: 0, overAnsweredBoards: 0,
             cmtLines: new Set(), cmtProducts: new Set() });
        // Below the BUY LINE = the classic buy trigger, judged on FREE TO
        // PROMISE rather than ON SHELF: board already frozen for a job is not
        // cover. The field is still `reorder_level` — only the column's label
        // moved, and renaming the field is a migration this screen does not need.
        const belowReorder = m => (+m.reorder_level || 0) > 0 && stockSplit(m).net < (+m.reorder_level || 0);
        pos.reorderBoards = base.filter(belowReorder).length;

        // ONE shape for every quantity card: weight as the headline — board is
        // bought and sold by the kilo, so tonnage is the figure that travels
        // between the warehouse, purchase and the truck — then the two units the
        // floor actually handles, then what the number is about. Identical
        // structure across the strip so any two cards compare at a glance.
        //
        // A quantity that nothing in it could be weighed falls back to its sheet
        // count rather than printing a confident 0.00 t over real stock.
        const qtyValue = (kg, sheets) => (kg > 0 ? `${(kg / 1000).toFixed(2)} t` : fmt.num(Math.round(sheets)));
        const qtySub = (pkt, sheets, note) => (
          <>
            <span className="block tabular-nums">{packetText(pkt)} pkt · {fmt.num(Math.round(sheets))} sheets</span>
            <span className="block text-[#86868B]">{note}</span>
          </>
        );
        const nBoards = n => `${n} board${n === 1 ? '' : 's'}`;

        // Grade chips. Counts follow the POSITION set, matching the cards — a
        // rail that counted only stocked boards would disagree with its own
        // totals. Lives in the sticky control row below, where the space its
        // chips leave over is what the age spread and the switches use.
        const gradeChips = [['all', 'All boards'], ...grades.map(g => [g, g])].map(([key, label]) => {
          const n = key === 'all' ? stock.length : stock.filter(m => gradeOf(m) === key).length;
          return (
            <button key={key} onClick={() => setRmGrade(key)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] font-bold transition-colors ${
                rmGrade === key
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'}`}>
              {label}
              <span className={`ml-1.5 tabular-nums ${rmGrade === key ? 'text-white/60' : 'text-slate-400'}`}>{n}</span>
            </button>
          );
        });

        // Each card filters the list under it to exactly the boards it counted,
        // so a number and the rows behind it can never disagree.
        //
        // An active card OVERRIDES the zero-stock toggle. That is the whole
        // point for On order and Below reorder: both are about boards that have
        // run out, so leaving the toggle in charge would show a number with an
        // empty list under it.
        //
        // `pr` and `incoming` are gone from this map because the cards that were
        // the only source of those keys are gone — merged into `on_order`. A
        // predicate no card can select is dead, and a dead predicate here is how
        // the map stops being a readable list of what the strip can do.
        const rows = rmKpi.key
          ? rmKpi.apply(base, {
            committed: m => stockSplit(m).committed > 0,
            net: m => stockSplit(m).net > 0,
            on_order: m => (+m.pr_qty || 0) > 0 || (+m.incoming || 0) > 0,
            over: m => stockSplit(m).over_committed > 0,
            reorder: belowReorder,
          })
          : (showEmpty ? base : base.filter(m => +m.available > 0));
        // The RM stock columns, named once because they are needed twice.
        // Hoisted out of the JSX for ONE reason: `exportColumns` REPLACES the
        // column list wholesale (`columns: exportColumns || columns`, in
        // DataTable), so the workbook's unmerged view has to be DERIVED from
        // this list. Writing it out as a second hand-kept array is how a
        // printout starts disagreeing with the screen it was printed from —
        // and passing only the two split columns, which is the obvious
        // reading of that prop, silently drops every other column from the
        // PDF and the workbook, board name included.
        const rmColumns = [
          // Board name over its plant code — the same two-line identity the
          // Boards master shows, so the code on the floor ("2038340GB") reads
          // straight off the stock list. The old "Category" column is gone: it
          // said "board" on every row, because the board master IS the raw
          // material master.
          { key: 'name', colClass: 'min-w-[190px] ci-cap', label: 'Board', render: m => (<div><div className="font-semibold">{m.name}</div><div className="font-mono text-[11px] text-gray-400">{m.spec}</div></div>) },
          ...boardSpecColumns(boardRates),
          { key: 'available', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'On Shelf', align: 'right',
            render: m => <StockCell m={m} sheets={m.available} />,
            export: m => stockText(m, m.available) },
          // Total Weight is gone from the ROW, not from the screen: the kg
          // summary line and the tonnage headline on every KPI card still
          // carry it. Per row it was a multiplication of two columns sitting
          // two apart — On Shelf and Kg / Sheet — and the width it cost is
          // what Shortfall and On Order now use.
          { key: 'age', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Age in Stock', render: m => (m.age_days != null && +m.available > 0) ? <AgeChip days={m.age_days} /> : <span className="text-xs text-slate-300">—</span> },
          // The columns behind the KPI strip, in the order the strip reads.
          // Zero is greyed so a row's real position carries at a glance down
          // a long list.
          { key: 'committed', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Frozen', align: 'right',
            render: m => {
              const s = stockSplit(m);
              return (
                <div>
                  <UnitCell m={m} sheets={s.committed} tone="text-amber-700" />
                  {+m.committed_lines > 0 && (
                    <div className="text-[10px] text-slate-400">{fmt.num(+m.committed_lines)} job{+m.committed_lines === 1 ? '' : 's'}</div>
                  )}
                </div>
              );
            },
            export: m => stockText(m, Math.round(stockSplit(m).committed)) },
          // Free to Promise is the one-glance answer to "can I give this board
          // to a new job?", so it renders in the same two units as every other
          // quantity on the row. It was the only one of the three in bare
          // sheets, sitting between two packets-over-sheets columns — a
          // storekeeper comparing them was converting one of the pair in his
          // head. Its export was a bare number for the same reason and moves
          // with it.
          { key: 'net', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Free to Promise', align: 'right',
            render: m => <UnitCell m={m} sheets={stockSplit(m).net} tone="text-emerald-700" />,
            export: m => stockText(m, Math.round(stockSplit(m).net)) },
          // Shortfall sits OUTSIDE the On Shelf = Frozen + Free to Promise
          // trio, deliberately. Those three divide up board that EXISTS.
          // This is demand with no board behind it — the only figure on the
          // row that may exceed the shelf, and the only one that is not stock.
          //
          // It replaces the red "+N over" badge that used to live inside the
          // Frozen cell. That badge was the only thing on a row saying "this
          // board is the bottleneck", and once over-commitment stops happening
          // on the planning path it would read zero — leaving a board at Free
          // to Promise 0 WITH a PR raised looking identical to one with
          // nothing behind it. On Order sits next to it for exactly that
          // reason: "short 7,893 · 12,240 on order" is one sentence.
          //
          // `key` names the KPI card this column stands behind, and unlike
          // every sibling it is NOT a field on the row: the figure is derived
          // by stockSplit. DataTable's comparator falls back to `a[sort.key]`
          // when a column declares no sortValue, so without the line below
          // every row compares as undefined — the header still draws its sort
          // arrow and the list does not move. "Worst shortfall first" is the
          // first thing anyone does with this column, so it is declared.
          { key: 'over', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Shortfall', align: 'right',
            sortValue: m => stockSplit(m).over_committed,
            // UnitCell already greys a zero to an em-dash at its own size; a
            // ternary here only made this column's dash smaller than the ones
            // beside it, so the row of zeros no longer lined up.
            render: m => <UnitCell m={m} sheets={stockSplit(m).over_committed} tone="text-red-600" />,
            export: m => stockText(m, Math.round(stockSplit(m).over_committed)) },
          // PO over PR in one cell. They answer one question — "is anything
          // coming?" — and asking it in two columns cost width the row needs
          // for Shortfall. The export keeps them SEPARATE: a workbook is
          // filtered and pivoted, and the summary block already emits distinct
          // PR and PO totals that a merged column would contradict.
          //
          // `sortValue`, not `sortKey` — same trap Shortfall documents above.
          // `on_order` is not a field on the row, so without this the
          // comparator reads `a['on_order']`, gets undefined on every row, and
          // the header draws a sort arrow over a list that never moves.
          { key: 'on_order', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'On Order', align: 'right',
            sortValue: m => (+m.incoming || 0) + (+m.pr_qty || 0),
            render: m => {
              const po = +m.incoming || 0, pr = +m.pr_qty || 0;
              if (!po && !pr) return <span className="text-xs text-slate-300">—</span>;
              return (
                <div>
                  {po > 0 && <UnitCell m={m} sheets={po} tone="text-sky-700" />}
                  {pr > 0 && <div className="text-[10px] font-semibold text-violet-700">{packetText(packetsOf(m, pr))} PKT on PR</div>}
                </div>
              );
            } },
          // Packets over sheets, because the number it is compared against —
          // Free to Promise — is now in those units. Bare sheets beside a
          // packets figure is the conversion this rebuild removes.
          { key: 'reorder_level', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Buy Line', align: 'right',
            render: m => +m.reorder_level > 0
              ? <UnitCell m={m} sheets={+m.reorder_level} tone="text-slate-600" />
              : <span className="text-xs text-slate-300">—</span>,
            export: m => stockText(m, Math.round(+m.reorder_level || 0)) },
          // Health, and nothing else on the row, says what a person should do
          // about this board. `card: 'status'` pins it to the phone card's
          // status slot — without it the column classifies as a plain detail
          // and falls behind Details, where the one verdict on the row is the
          // thing you have to tap to see.
          { key: 'short', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Health', card: 'status',
            sortValue: m => HEALTH_RANK.indexOf(healthOfRow(m)),
            render: m => <HealthBadge state={healthOfRow(m)} />,
            export: m => HEALTH[healthOfRow(m)].label },
          threadColumn({ entity: 'material', threads, idOf: m => m.id }),
        ];
        // A sheet has room the row does not. On Order merges PO and PR into
        // one cell so Shortfall fits across the screen; the export splits them
        // back apart, because "is anything coming?" is one question at a
        // glance and two in a pivot — and the summary block below still totals
        // PR and PO separately, which one merged column would contradict.
        const rmExportColumns = rmColumns.flatMap(c => (c.key !== 'on_order' ? [c] : [
          { key: 'pr_qty', label: 'PR Raised', align: 'right', export: m => stockText(m, Math.round(+m.pr_qty || 0)) },
          { key: 'incoming', label: 'Incoming (PO)', align: 'right', export: m => stockText(m, Math.round(+m.incoming || 0)) },
        ]));
        return (<>
        {/* The position, read once at the top. These SCROLL AWAY with the page:
            pinning six cards held a quarter of the screen for figures nobody
            re-reads while working a 300-row list, and it pushed the board list
            below the fold. What stays behind is the thin control row under
            them — the subset you are in and the switches that change it. */}

        {/* The warehouse position, left to right the way the plant reasons:
            what is on the shelf → what planning has frozen → what is left to
            promise → what has already been asked for → what is frozen past the
            shelf → what has fallen under its buy line. Every card filters the
            list to exactly what it counted; On shelf clears back to the whole
            grade. Six cards, not seven: PR raised and Incoming on PO were one
            question asked twice. */}
        <KpiRow cols={6} className="mb-2">
          <KpiCard compact icon={Layers} tone="info" label="On shelf"
            value={qtyValue(pos.grossKg, pos.gross)}
            sub={qtySub(pos.grossPkt, pos.gross,
              `on the shelf · ${pos.stockedBoards} of ${nBoards(base.length)} holding stock`)}
            title="Physical stock in the plant right now. Frozen + Free to promise always equals this. Click to clear any card filter."
            onClick={() => rmKpi.clear()} active={!rmKpi.key} />
          {/* The tooltip no longer ends with "…N sheets of that demand has no
              stock behind it". That figure is the Shortfall column and the To
              arrange card; a third place to read it is the duplication this
              rebuild exists to remove. */}
          <KpiCard compact icon={Lock} tone="warn" label="Frozen for jobs"
            value={qtyValue(pos.committedKg, pos.committed)}
            sub={qtySub(pos.committedPkt, pos.committed, (
              <>
                {pos.cmtProducts.size} product{pos.cmtProducts.size === 1 ? '' : 's'} ·{' '}
                {pos.cmtLines.size} order line{pos.cmtLines.size === 1 ? '' : 's'} ·{' '}
                {pos.committedBoards} board{pos.committedBoards === 1 ? '' : 's'}
              </>
            ))}
            title={`Board the Planning Engine has fixed to named jobs, covering ${pos.cmtProducts.size} products across ${pos.cmtLines.size} sales-order lines.`}
            onClick={() => rmKpi.toggle('committed')} active={rmKpi.is('committed')} />
          <KpiCard compact icon={PackageCheck} tone="good" label="Free to promise"
            value={qtyValue(pos.netKg, pos.net)}
            sub={qtySub(pos.netPkt, pos.net, `free on ${nBoards(pos.netBoards)} · still to promise`)}
            title="On shelf minus what planning has frozen — what you can still promise."
            onClick={() => rmKpi.toggle('net')} active={rmKpi.is('net')} />
          {/* PR raised and Incoming on PO were two cards answering ONE question
              — "is anything coming?" — and the pair cost the strip a column the
              rebuild needed. They are added into one headline and split apart
              again on the sub-line, because a buyer must never act on the total
              without knowing which half a supplier has actually accepted. The
              workbook keeps them as two columns for the same reason. */}
          <KpiCard compact icon={Truck} tone="info" label="On order"
            value={qtyValue(pos.incomingKg + pos.prKg, pos.incoming + pos.pr)}
            sub={qtySub(pos.incomingPkt + pos.prPkt, pos.incoming + pos.pr, (pos.incoming + pos.pr) > 0
              ? `${fmt.num(Math.round(pos.incoming))} on PO · ${fmt.num(Math.round(pos.pr))} on PR`
              : 'nothing ordered or requisitioned')}
            title="Board already asked for: still to arrive on open purchase orders, plus requisitions raised and not yet turned into a PO. Counted on every board in the grade, including the ones that have run out."
            onClick={() => rmKpi.toggle('on_order')} active={rmKpi.is('on_order')} />
          {/* Frozen beyond the shelf. It sits AFTER On order deliberately: the
              question a buyer asks of this number is "has anyone ordered it
              yet", and On order — now one card, not two — is the answer sitting
              beside it. Never folded into Frozen for jobs — it is demand with
              no board behind it, not stock, so On shelf = Frozen + Free to
              promise still holds exactly. */}
          <KpiCard compact icon={ShieldAlert} tone={pos.over > 0 ? 'bad' : 'good'} label="To arrange"
            value={qtyValue(pos.overKg, pos.over)}
            sub={qtySub(pos.overPkt, pos.over, pos.over > 0
              ? `${nBoards(pos.overBoards)} locked past stock · ${
                  pos.overOpen > 0 ? `${fmt.num(Math.round(pos.overOpen))} with nothing on order` : 'all on a PR or PO'}`
              : 'nothing locked past its shelf')}
            title="Board the Planning Engine has fixed to jobs beyond what the shelf actually holds. The gap is the same whether or not anyone has ordered it — the sub-line says how much of it still has no PR or PO behind it. Click to list only these boards."
            onClick={() => rmKpi.toggle('over')} active={rmKpi.is('over')} />
          <KpiCard compact icon={AlertTriangle} tone={pos.reorderBoards > 0 ? 'bad' : 'info'} label="Below reorder"
            value={fmt.num(pos.reorderBoards)}
            sub={
              <>
                <span className="block tabular-nums">of {nBoards(base.length)} in this grade</span>
                <span className="block text-[#86868B]">
                  {pos.reorderBoards > 0 ? 'NET stock under the buy line' : 'every board is above its line'}
                </span>
              </>
            }
            title="Judged on free to promise, not on shelf — board already frozen for a job is not cover."
            onClick={() => rmKpi.toggle('reorder')} active={rmKpi.is('reorder')} />
        </KpiRow>

        {/* THE ONLY PINNED THING — one line, ~36px. Grade on the left; the space
            the chips leave over carries what used to own two full-width rows of
            its own: the unweighable-boards note, the age spread and the
            zero-stock switch. Everything here answers "what am I looking at",
            which is the one question that survives scrolling. */}
        {/* Desktop pins this one line BELOW the header — pinning it at 0 parked
            it under the z-30 header band, where its chips were invisible AND
            untappable once the page scrolled. Every TOUCH tier drops sticky
            altogether and becomes a rounded glass panel of two swipe rails
            (grades, then the meta cluster): nothing to collide with, and the
            same shape on an iPad as on the Redmi. */}
        <div className="sticky top-[var(--ci-header-h)] z-20 -mx-1 mb-2 border-b border-[#1D1D1F]/[0.06] bg-[#F5F5F7]/95 px-1 py-1.5 backdrop-blur touch:static touch:mx-0 touch:rounded-2xl touch:border touch:border-white/70 touch:bg-white/60 touch:px-2.5 touch:py-2 touch:shadow-glass touch:backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Grade</span>
            {/* display:contents on desktop — the wrapper doesn't exist there.
                On touch it becomes the grades' own one-line swipe rail. */}
            <span className="contents touch:flex touch:min-w-0 touch:flex-1 touch:flex-nowrap touch:items-center touch:gap-2 touch:overflow-x-auto touch:pb-0.5 scrollbar-none">
              {gradeChips}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 touch:ml-0 touch:mt-1.5 touch:w-full touch:basis-full touch:flex-nowrap touch:overflow-x-auto touch:pb-0.5 scrollbar-none">
              {pos.noWeight > 0 && (
                <span className="whitespace-nowrap rounded-lg bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-500"
                  title="These boards have no GSM or sheet size on the master, so nothing here can weigh them.">
                  {pos.noWeight} without GSM
                </span>
              )}
              {/* Ages describe the LISTED boards. An empty board has no age at
                  all, so summing the position set would dilute it with nulls. */}
              <AgeBar compact items={rows.map(m => m.age_days)} unit="boards" />
              {/* While a card is active it decides the list, so the switch is
                  shown as not applying rather than silently doing nothing. */}
              <label className={`flex select-none items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#1D1D1F]/[0.06] bg-white px-2 py-0.5 text-[11px] font-semibold ${
                rmKpi.key ? 'text-slate-400 opacity-60' : 'cursor-pointer text-slate-600 hover:border-slate-300'}`}
                title={rmKpi.key ? 'A KPI card is showing exactly the boards it counted — clear it to use this switch.' : undefined}>
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#007AFF]" checked={showEmpty} disabled={!!rmKpi.key}
                  onChange={e => setShowEmpty(e.target.checked)} />
                Show zero stock
                {hidden > 0 && !showEmpty && !rmKpi.key && <span className="rounded-full bg-slate-100 px-1.5 text-[10px] tabular-nums text-slate-500">{hidden}</span>}
              </label>
            </div>
          </div>
          <KpiFilterNotice filter={rmKpi} label={RM_KPI_LABEL[rmKpi.key]}
            shown={rows.length} total={base.length} className="mt-1.5" />
        </div>
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
          columns={rmColumns}
          // The workbook and the PDF get PR and PO back as two columns. See
          // rmExportColumns above for why this cannot be written as the two
          // columns on their own.
          exportColumns={rmExportColumns}
          onRowClick={setViewing}
          rows={rows}
          rowClass={unreadRowClass(threads, m => m.id)}
          getRowId={m => m.id}
          exportName="RM Stock Position"
          exportSubtitle="Warehouse · Raw material"
          exportSummary={rows => [
            { label: 'Boards', value: rows.length },
            // The sheet counts what the screen counts. This was `m.short`, the
            // same boolean the Health cell stopped reading — a workbook saying
            // "Short 14" beside fourteen rows reading RECOUNT or FROZEN OUT is
            // the disagreement this rebuild removes.
            { label: 'Needs attention', value: rows.filter(m => healthOfRow(m) !== 'ok').length },
            { label: 'On shelf (packets)', value: packetText(rows.reduce((s, m) => s + (packetsOf(m, m.available) || 0), 0)) },
            { label: 'On shelf (sheets)', value: fmt.num(rows.reduce((s, m) => s + (+m.available || 0), 0)) },
            // Exported the same way the strip totals it — per board, never
            // netted across boards, so the sheet reconciles with the screen.
            { label: 'Frozen', value: fmt.num(Math.round(rows.reduce((s, m) => s + stockSplit(m).committed, 0))) },
            { label: 'Free to promise', value: fmt.num(Math.round(rows.reduce((s, m) => s + stockSplit(m).net, 0))) },
            { label: 'PR raised (awaiting PO)', value: fmt.num(Math.round(rows.reduce((s, m) => s + (+m.pr_qty || 0), 0))) },
            { label: 'Incoming on PO', value: fmt.num(Math.round(rows.reduce((s, m) => s + (+m.incoming || 0), 0))) },
            { label: 'Board weight (kg)', value: fmt.num(Math.round(rows.reduce((s, m) => s + (rowWeight(m, m.available) || 0), 0))) },
            // Unrated boards contribute nothing rather than a fake ₹0, so this is
            // the value of the stock that HAS a rate on file — the count beside it
            // says how much stock is not priced.
            { label: 'Stock value (₹)', value: fmt.num(Math.round(rows.reduce((s, m) => s + (stockValue(m, boardRates) || 0), 0))) },
            { label: 'Boards with no rate', value: rows.filter(m => +m.available > 0 && rateKgOf(m, boardRates) == null).length },
          ]} />
      </>);
      })()}

      {tab === 'batches' && (
        <DataTable searchable
          columns={[
            { key: 'batch_no', label: 'Batch', render: b => <span className="font-mono text-xs font-semibold">{b.batch_no}</span> },
            { key: 'material_name', label: 'Board' },
            { key: 'qty', label: 'Remaining', align: 'right', render: b => `${fmt.num(b.qty)} ${b.unit}` },
            { key: 'initial_qty', label: 'Received', align: 'right', render: b => fmt.num(b.initial_qty) },
            // Loose sheets on this pile — COUNTED where the column carries a
            // figure, derived from the remainder where it is still NULL. The
            // two must never look alike: the derived figure is the smallest
            // answer the pile can hold, so it can only ever understate.
            { key: 'loose_sheets', label: 'Loose', align: 'right',
              render: b => {
                const P = Number(b.sheets_per_packet) || 0;
                if (!(P > 0)) return <span className="text-gray-300" title="No packet size on this board master — loose cannot be counted against it.">—</span>;
                const counted = b.loose_sheets != null;
                const q = Math.max(0, Math.floor(Number(b.qty) || 0));
                const n = counted ? Number(b.loose_sheets) : q % P;
                // Loose sheets and whole packets must add up to the pile, so
                // (qty − loose) has to divide by the packet size. A counted
                // figure that does not is provably wrong — and this is the one
                // screen where somebody can put it right, so it must say so
                // rather than showing a confident "counted". The planning
                // panel already refuses to over-promise on it (packetPlan
                // snaps it down); this is how the warehouse finds out.
                const impossible = counted && (q - n) % P !== 0;
                return (
                  <button type="button" onClick={() => setLooseEdit({ id: b.id, batch_no: b.batch_no, value: counted ? String(Math.round(n)) : '' })}
                    className="tabular-nums font-semibold text-slate-700 hover:underline"
                    title={impossible
                      ? `${Math.round(n)} loose cannot be true of ${fmt.num(q)} sheets at ${P} to a packet — the rest would not make whole packets. Click to recount.`
                      : counted ? 'Counted at the last issue. Click to recount.'
                        : 'Derived from the sheet total — the smallest figure this pile can hold. Click to record a real count.'}>
                    {fmt.num(n)}
                    <span className={`ml-1 text-[10px] font-normal ${impossible ? 'font-semibold text-red-600' : counted ? 'text-slate-400' : 'text-amber-600'}`}>
                      {impossible ? 'recount' : counted ? 'counted' : 'derived'}
                    </span>
                  </button>
                );
              },
              export: b => b.loose_sheets ?? '' },
            { key: 'status', label: 'Status', render: b => <StatusBadge status={b.status} /> },
            { key: 'created_at', label: 'Received On', render: b => fmt.date(b.created_at) },
            { key: 'age', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Age', render: b => b.status === 'available' && b.qty > 0 ? <AgeChip date={b.created_at} /> : null },
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
              { key: 'name', colClass: 'min-w-[190px]', label: 'Leftover', render: m => (<div><div className="font-semibold">{m.name}</div><div className="text-xs text-gray-400">from {m.source_name || '—'}</div></div>) },
              { key: 'size', label: 'Strip Size', render: m => <span className="tabular-nums">{m.sheet_l}×{m.sheet_w}"</span> },
              // Same board columns as the RM list. A strip keeps its OWN size (the
              // Strip Size column above, so the shared sheet_size one is dropped)
              // but inherits grade/GSM/pack from the board it was cut from, which
              // is what makes an offcut weighable and valuable at all.
              ...boardSpecColumns(boardRates).filter(c => c.key !== 'sheet_size'),
              // Same header the RM Stock list uses. The banned words live in TWO
              // column arrays in this one file, so renaming only the stock list
              // leaves the screen saying "On Shelf" on one sub-tab and
              // "Available" on the other — the half-renamed screen exactly.
              { key: 'available', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'On Shelf', align: 'right',
                render: m => <StockCell m={m} sheets={m.available} />,
                export: m => stockText(m, m.available) },
              // A BANKED STRIP USED TO READ 100% FREE BY CONSTRUCTION. The
              // leftovers endpoint never ran its masters through enrichStockRow,
              // so `committed_qty` was absent, stockSplit put the whole strip in
              // Free to Promise, and an offcut a locked plan had already frozen
              // looked available to promise to the next job. The route now sends
              // the same aggregates the RM Stock list gets; these three read them
              // through the SAME helpers and the SAME BoardHealth module, so an
              // offcut and a mother board are judged by one rule, not two.
              //
              // Frozen and Free to Promise sit immediately after On Shelf on both
              // sub-tabs, because the identity that makes them legible —
              // On Shelf = Frozen + Free to Promise — only reads at a glance when
              // the three are adjacent and in that order.
              { key: 'committed', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Frozen', align: 'right',
                render: m => <UnitCell m={m} sheets={stockSplit(m).committed} tone="text-amber-700" />,
                export: m => stockText(m, Math.round(stockSplit(m).committed)) },
              { key: 'net', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Free to Promise', align: 'right',
                render: m => <UnitCell m={m} sheets={stockSplit(m).net} tone="text-emerald-700" />,
                export: m => stockText(m, Math.round(stockSplit(m).net)) },
              { key: 'weight', colClass: 'w-px ci-p3', cellClass: 'whitespace-nowrap', label: 'Total Weight', align: 'right', render: m => {
                  const w = rowWeight(m, m.available);
                  return w == null
                    ? <span className="text-xs text-slate-300">—</span>
                    : <span className="tabular-nums font-semibold text-slate-700">{w.toFixed(1)} kg</span>;
                } },
              // Health last, exactly as on the RM Stock list — one verdict per
              // row, off `healthOfRow`, never a second copy of the ladder. It
              // carries `key: 'short'` and `sortValue` for the same reason the
              // stock list's does: `short` is a REAL field on the row, so a
              // column without a sortValue would silently rank a four-state
              // verdict by the retired boolean. On an offcut, BELOW LINE
              // effectively never fires — nobody sets a buy line on a strip you
              // cannot order — which is correct, not a gap: the two rungs that
              // matter here are RECOUNT and FROZEN OUT.
              { key: 'short', colClass: 'w-px', cellClass: 'whitespace-nowrap', label: 'Health', card: 'status',
                sortValue: m => HEALTH_RANK.indexOf(healthOfRow(m)),
                render: m => <HealthBadge state={healthOfRow(m)} />,
                export: m => HEALTH[healthOfRow(m)].label },
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

      {tab === 'moves' && (
        <DataTable searchable
          columns={[
            { key: 'created_at', label: 'When', render: m => fmt.dt(m.created_at) },
            { key: 'type', label: 'Type', render: m => <StatusBadge status={m.type === 'consumption' || m.type === 'dispatch' ? 'cancelled' : m.type === 'grn' ? 'quarantine' : 'available'} /> && <span className="text-xs font-semibold capitalize">{m.type.replace('_', ' ')}</span> },
            { key: 'material_name', label: 'Item', render: m => m.product_name
              ? <ProductIdentity row={m} compact />
              : (m.material_name || '—') },
            { key: 'qty', label: 'Qty', align: 'right', render: m => <span className={`font-bold tabular-nums ${m.qty < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{m.qty > 0 ? '+' : ''}{fmt.num(m.qty)}</span> },
            { key: 'note', label: 'Note', render: m => <span className="text-xs text-gray-500">{m.note || `${m.ref_type || ''} #${m.ref_id || ''}`}</span> },
          ]}
          rows={moves}
          exportName="Movement Ledger"
          exportSubtitle="Warehouse · Every stock change, audited" />
      )}

      {/* Recount the loose sheets on one pile. Loose is a ledger — it opens at
          the derived remainder and every issue and return moves it — so like
          any ledger it can drift from the shelf. This is how somebody who has
          physically counted puts it right, and it is the ONLY place a human
          states the figure outright rather than confirming a pick. */}
      <Modal open={!!looseEdit} onClose={() => setLooseEdit(null)}
        title={looseEdit ? `Recount loose sheets — ${looseEdit.batch_no}` : 'Recount loose sheets'}
        footer={<>
          <Button variant="secondary" onClick={() => setLooseEdit(null)}>Cancel</Button>
          <Button variant="success" onClick={async () => {
            await api.post(`/inventory/batches/${looseEdit.id}/loose`,
              { loose_sheets: looseEdit.value === '' ? null : looseEdit.value });
            setLooseEdit(null);
            api.get('/inventory/batches').then(setBatches);
            toast.success('Loose sheets recorded');
          }}>Save count</Button>
        </>}>
        <Field label="Loose sheets on this pile"
          hint="Sheets NOT in a sealed packet. Leave blank to go back to the derived figure.">
          <Input type="number" min="0" autoFocus value={looseEdit?.value ?? ''}
            onChange={e => setLooseEdit({ ...looseEdit, value: e.target.value })} />
        </Field>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Loose sheets and whole packets must add up to the sheets on this pile, so a
          figure that cannot be true is shown as the nearest smaller one that can — never
          a larger one, which would promise board that is not on the shelf.
        </p>
      </Modal>

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
                  <div className={`text-xl font-black ${adjWritesOn ? 'text-amber-600' : 'text-[#007AFF]'}`}>
                    {fmt.num(adjNewBalance)} <span className="text-xs font-semibold text-slate-400">{adjMat.unit}</span>
                  </div>
                </div>
              </div>
              {adjWritesOn && (
                <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700">
                  Only {fmt.num(adjAvail)} {adjMat.unit} on the book. The extra {fmt.num(adjWriteOnQty)} will be
                  written on and the board brought to nil — never negative. A recount is raised for the warehouse.
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

          {/* Suppressed once the reduction exceeds the book: the counted figure is
              clamped at nil, so "counted 0 vs 40 — auto-set to reduce 150" would
              contradict itself. The write-on banner above already tells that story. */}
          {adjMat && adj.actual !== '' && !adjWritesOn && (
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
