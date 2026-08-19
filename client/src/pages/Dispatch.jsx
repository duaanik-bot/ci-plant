// Dispatch — produced lines appear here automatically. From the Ready list you
// open "Move FG" for a product: the on-hand FG cascades across that product's
// open sales orders within customer tolerance, boxes are auto-calculated from
// the dispatch quantity, and any leftover is boxed into individually-numbered
// CI-BOX lots (one per physical carton + one for the loose remainder).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmt } from '../api.js';
import useRealtimeRefresh from '../lib/useRealtimeRefresh.js';
import { OPERATIONS_REALTIME_TABLES } from '../lib/realtimeTables.js';
import { Button, DataTable, dueDelta, Field, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, PageHeader, ResetFilters, Tabs, useFilterReset, useKpiFilter, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import ProductIdentity, { productExport, productSearchText } from '../components/ProductIdentity.jsx';
import { boxBreakdown, boxLabel } from '../lib/boxes.js';
import { Truck, Printer, Boxes, Pencil, Undo2, PackageCheck, Warehouse, Banknote, AlertTriangle, FileText, CalendarDays } from 'lucide-react';

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

// Rows behind the clickable cards. Ready-view predicates take an order-line;
// register predicates take a challan with its lines attached.
const READY_KPI_ROWS = {
  excess: l => (+l.excess_available || 0) > 0,
  late: l => dueDelta(l.delivery_date) > 0,
};
const READY_KPI_LABEL = {
  excess: 'lines with over-run to clear',
  late: 'lines past their delivery date',
};
const REGISTER_KPI_LABEL = { month: 'challans dispatched this month' };

export default function Dispatch({ embedded = false, view, onShortCount }) {
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState('ready');
  const [ready, setReady] = useState([]);
  const [register, setRegister] = useState([]);
  const [moving, setMoving] = useState(null);   // product-centric Move FG state
  const [selectedIds, setSelectedIds] = useState([]);   // order_line_ids ticked on the Ready table
  const [customer, setCustomer] = useState(null);       // customer chip filter (null = all)
  const [bulk, setBulk] = useState(null);               // bulk Move FG modal state
  const [shortOnly, setShortOnly] = useState(false);    // Shortage chip inside Ready
  const [shorts, setShorts] = useState([]);             // the Shortage ZONE's own rows
  const [shortage, setShortage] = useState(null);       // shortage decision modal
  const [loadingMove, setLoadingMove] = useState(false);
  const [saving, setSaving] = useState(false);

  const [threads, setThreads] = useState({});
  // Dispatched-but-unbilled lines. The register's own rows cannot answer "what
  // has left the gate and not been invoiced" — dispatch_lines carry no rate and
  // no invoice link — so the billing view is asked directly. Failure is silent:
  // one KPI going quiet must never take the dispatch register down with it.
  const [unbilled, setUnbilled] = useState([]);

  const load = () => {
    api.get('/dispatch/ready').then(setReady);
    // Its own call, not a filter over `ready` — Ready cannot see a line with
    // zero finished goods, and that is exactly the worst shortage.
    api.get('/dispatch/shortages').then(rs => { setShorts(rs); onShortCount?.(rs.length); }).catch(() => {});
    api.get('/billing/uninvoiced').then(setUnbilled).catch(() => {});
    api.get('/dispatches').then(ds => {
      setRegister(ds);
      threadSummary('dispatch', ds.map(d => d.id)).then(setThreads).catch(() => {});
    });
  };
  useEffect(() => { load(); }, []);
  useRealtimeRefresh(load, OPERATIONS_REALTIME_TABLES, { debounceMs: 700 });

  // A KPI card narrows the LINES the table shows. One flat row per order line —
  // the PO is a column, not a card header — so a filter simply removes rows
  // instead of leaving an empty order tile behind.
  const readyKpi = useKpiFilter(embedded ? view : tab);
  // Customer chip narrows first, then the KPI card — so "over-run to clear"
  // means "…for this customer" once a chip is on, which is how it reads.
  const shortageRows = ready.filter(l => l.is_shortage);
  const afterShort = shortOnly ? shortageRows : ready;
  const customerRows = customer == null ? afterShort : afterShort.filter(l => l.customer_id === customer);
  const readyRows = readyKpi.apply(customerRows, READY_KPI_ROWS);

  // One chip per customer with ready stock, biggest first.
  const customerChips = (() => {
    const m = new Map();
    for (const l of ready) {
      const e = m.get(l.customer_id) || { id: l.customer_id, name: l.customer_name, lines: 0 };
      e.lines++; m.set(l.customer_id, e);
    }
    return [...m.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  })();

  // A row that is no longer visible must not stay silently selected — the bulk
  // bar would otherwise act on lines the user cannot see.
  const visibleIds = readyRows.map(l => l.order_line_id);
  const selected = selectedIds.filter(id => visibleIds.includes(id));
  const selectedLines = readyRows.filter(l => selected.includes(l.order_line_id));

  // What the selection actually amounts to on the loading dock: the cartons
  // going out and the boxes they fill. Boxes are summed per line from that
  // product's real packing rather than dividing the total by one box size —
  // a mixed selection has as many box sizes as it has products.
  const selTotals = selectedLines.reduce((t, l) => ({
    cartons: t.cartons + (+l.suggested_dispatch || 0),
    boxes: t.boxes + (+l.suggested_boxes || 0),
    excess: t.excess + (+l.leftover_qty || 0),
    short: t.short + (+l.shortfall_qty || 0),
  }), { cartons: 0, boxes: 0, excess: 0, short: 0 });

  // Open the Move FG modal for a product — pull the cascade plan + FG on hand.
  const openMove = async (product_id, product_name) => {
    setMoving({ product_id, product_name, loading: true, allocations: [], fg_stock: 0, qty_per_box: 0, vehicle: '', driver: '' });
    setLoadingMove(true);
    try {
      const p = await api.get(`/fg/movement-preview?product_id=${product_id}`);
      setMoving({
        product_id, product_name: p.product_name || product_name,
        fg_stock: p.fg_stock, qty_per_box: p.qty_per_box || 0,
        vehicle: '', driver: '',
        allocations: (p.allocations || []).map(a => ({ ...a, dispatch_now: a.dispatch_qty })),
      });
    } catch { setMoving(null); } finally { setLoadingMove(false); }
  };

  // ── Bulk Move FG ──────────────────────────────────────────────────────────
  // The single-line modal is product-centric because one product cascades
  // across several orders. Bulk keeps that shape: the operator decides PER LINE
  // how much goes out, and whatever the product pool has left over is boxed —
  // then the whole set is sent as ONE transaction so a tolerance rejection on
  // the last line cannot leave the first three already dispatched.
  const openBulk = () => setBulk({
    vehicle: '', driver: '',
    lines: selectedLines.map(l => ({
      order_line_id: l.order_line_id, product_id: l.product_id, product_name: l.product_name,
      code: l.code, po_number: l.po_number, customer_name: l.customer_name,
      fg_qty: l.fg_qty, qty_per_box: l.qty_per_box,
      // How many OTHER ready lines drink from this product's pool, and whether
      // they are all in this selection. Boxing is only safe when they are —
      // otherwise the leftover we box is stock another order still wants.
      shares_pool_with: l.shares_pool_with || 0,
      pool_fully_selected: selectedLines.filter(x => x.product_id === l.product_id).length === (l.shares_pool_with || 0) + 1,
      tolerance_pct: l.tolerance_pct, tolerance_room: l.tolerance_room,
      ordered: l.qty, dispatched: l.dispatched_qty,
      suggested: l.suggested_dispatch,
      dispatch_now: l.suggested_dispatch,     // pre-filled with the cascade's answer
      // Default on — the plant does not want it loose — but never when other
      // lines for the same product are outside this selection.
      box_leftover: selectedLines.filter(x => x.product_id === l.product_id).length === (l.shares_pool_with || 0) + 1,
    })),
  });

  const setBulkLine = (id, patch) =>
    setBulk(b => ({ ...b, lines: b.lines.map(x => (x.order_line_id === id ? { ...x, ...patch } : x)) }));

  // Leftover is a property of the PRODUCT POOL, so it is computed per product
  // across the selected lines — never summed per row, which would box the same
  // cartons twice when two lines share a product.
  const bulkTotals = (() => {
    if (!bulk) return { dispatch: 0, leftover: 0, boxing: 0, products: 0, over: [] };
    const byProduct = new Map();
    for (const l of bulk.lines) {
      const e = byProduct.get(l.product_id) || { fg: l.fg_qty, per: l.qty_per_box, taken: 0, box: false };
      e.taken += Math.max(0, Math.floor(+l.dispatch_now) || 0);
      e.box = e.box || (l.box_leftover && l.pool_fully_selected);
      byProduct.set(l.product_id, e);
    }
    let dispatch = 0, leftover = 0, boxing = 0;
    const over = [];
    for (const [pid, e] of byProduct) {
      dispatch += e.taken;
      const rest = e.fg - e.taken;
      if (rest < 0) over.push(pid);
      else { leftover += rest; if (e.box) boxing += rest; }
    }
    return { dispatch, leftover, boxing, products: byProduct.size, over };
  })();

  // Per line: never offer more than the tolerance ceiling allows.
  const bulkLineError = l => {
    const n = Math.floor(+l.dispatch_now) || 0;
    if (n < 0) return 'negative';
    if (n > l.tolerance_room) return `over ±${l.tolerance_pct}% (max ${fmt.num(l.tolerance_room)})`;
    return null;
  };
  const bulkBlocked = !bulk || bulkTotals.over.length > 0
    || bulk.lines.some(l => bulkLineError(l))
    || (bulkTotals.dispatch <= 0 && bulkTotals.boxing <= 0);

  const resolveShortage = async () => {
    setSaving(true);
    try {
      const r = await api.post(`/order-lines/${shortage.line.order_line_id}/shortage`,
        { action: shortage.action, reason: shortage.reason.trim() });
      toast.success(shortage.action === 'replan'
        ? `Back to Planning — ${fmt.num(r.balance_to_produce)} to make`
        : `Closed ${fmt.num(r.short_by)} short${r.order_completed ? ' · sales order completed' : ''}`);
      setShortage(null); setSelectedIds([]); load();
    } catch { /* server explains via central toast */ } finally { setSaving(false); }
  };

  const runBulk = async () => {
    setSaving(true);
    try {
      // One payload per product — the shape /fg/move already takes.
      const byProduct = new Map();
      for (const l of bulk.lines) {
        const e = byProduct.get(l.product_id) || { product_id: l.product_id, allocations: [], fg: l.fg_qty, box: false };
        const n = Math.floor(+l.dispatch_now) || 0;
        if (n > 0) e.allocations.push({ order_line_id: l.order_line_id, qty: n });
        e.box = e.box || (l.box_leftover && l.pool_fully_selected);
        byProduct.set(l.product_id, e);
      }
      const moves = [...byProduct.values()].map(e => {
        const taken = e.allocations.reduce((t, a) => t + a.qty, 0);
        return {
          product_id: e.product_id, mode: 'dispatch', allocations: e.allocations,
          leftover_qty: e.box ? Math.max(0, e.fg - taken) : 0,
        };
      }).filter(m => m.allocations.length || m.leftover_qty > 0);
      const res = await api.post('/fg/move-bulk', { moves, vehicle: bulk.vehicle || undefined, driver: bulk.driver || undefined });
      const ch = res.challans?.length || 0, bx = res.boxes?.length || 0;
      toast.success(`${ch} challan${ch === 1 ? '' : 's'} raised${bx ? ` · ${bx} leftover box${bx === 1 ? '' : 'es'}` : ''}`);
      setBulk(null); setSelectedIds([]); load();
    } catch { /* server explains via central toast */ } finally { setSaving(false); }
  };

  const setAllocQty = (order_line_id, v) =>
    setMoving(m => ({ ...m, allocations: m.allocations.map(a => (a.order_line_id === order_line_id ? { ...a, dispatch_now: v } : a)) }));

  const toDispatch = moving ? moving.allocations.reduce((s, a) => s + (Math.floor(+a.dispatch_now) || 0), 0) : 0;
  const leftover = moving ? Math.max(0, moving.fg_stock - toDispatch) : 0;

  const boxNumbersLabel = boxes => {
    if (!boxes?.length) return '';
    const nums = boxes.map(b => b.box_number);
    return boxes.length === 1 ? nums[0] : `${boxes.length} boxes: ${nums[0]}…${nums[nums.length - 1]}`;
  };

  // Box the whole on-hand FG for this product into numbered leftover cartons.
  const boxAllAsLeftover = async () => {
    if (!moving.fg_stock) return toast.error('No FG on hand to box');
    setSaving(true);
    try {
      const res = await api.post('/fg/move', { product_id: moving.product_id, mode: 'leftover', leftover_qty: moving.fg_stock });
      toast.success(`Boxed ${fmt.num(moving.fg_stock)} as leftover — ${boxNumbersLabel(res.boxes)}`);
      setMoving(null); load();
    } catch { /* server explains via central toast */ } finally { setSaving(false); }
  };

  // Dispatch the entered per-order quantities — one challan per sales order.
  // The remainder is boxed in the SAME transaction (the server's 'dispatch' mode
  // takes an optional leftover_qty), so loose FG always lands back at zero: a
  // carton at rest carries a box number, never an anonymous loose balance.
  // Safe because the server dispatches EXACTLY the qty sent — it throws on a
  // tolerance breach rather than clamping — so what remains after the debit is
  // exactly this leftover, and the server's own over-box guard passes on equality.
  const dispatchNow = async () => {
    const allocations = moving.allocations
      .filter(a => (Math.floor(+a.dispatch_now) || 0) > 0)
      .map(a => ({ order_line_id: a.order_line_id, qty: Math.floor(+a.dispatch_now) }));
    if (!allocations.length) return toast.error('Enter at least one dispatch quantity');
    setSaving(true);
    try {
      const res = await api.post('/fg/move', {
        product_id: moving.product_id, mode: 'dispatch', allocations,
        leftover_qty: leftover,
        vehicle: moving.vehicle, driver: moving.driver,
      });
      const nums = (res.challans || []).map(c => c.challan_number).join(', ');
      const boxed = res.boxes?.length ? ` · ${fmt.num(leftover)} boxed as ${boxNumbersLabel(res.boxes)}` : '';
      toast.success(`Dispatched ${fmt.num(toDispatch)} — challan ${nums}${boxed}`);
      setMoving(null); load();
      if (res.challans?.length === 1) nav(`/dispatch/challan/${res.challans[0].id}`);
    } catch { /* tolerance / stock 409 surfaces via central toast */ } finally { setSaving(false); }
  };

  // Cancel an entire challan — reverse every line back to FG stock, one click.
  const cancelDispatch = async d => {
    if (!window.confirm(`Cancel challan ${d.challan_number}? All its goods go back to FG stock and the challan is removed.`)) return;
    try {
      await api.post(`/dispatches/${d.id}/cancel`, {});
      toast.success(`${d.challan_number} cancelled — goods returned to FG`);
      load();
    } catch (e) { toast.error(e.message || 'Could not cancel the challan'); }
  };

  const activeView = embedded ? view : tab;

  // Ready-to-dispatch KPIs. fg_qty is the PRODUCT's stock and repeats on every
  // order line asking for that product, so it is summed once per product — a
  // straight sum over lines would report the same cartons two or three times.
  const kpiReady = (() => {
    const left = l => Math.max(0, (+l.qty || 0) - (+l.dispatched_qty || 0));
    const fgByProduct = new Map(ready.map(l => [l.product_id, +l.fg_qty || 0]));
    const late = ready.filter(l => dueDelta(l.delivery_date) > 0);
    return {
      // Counted off `ready`, never off `readyRows`: readyRows is the FILTERED
      // list, so reading it here would make the strip shrink as you click it and
      // there would be no number left showing what the filter was taken out of.
      orders: new Set(ready.map(l => l.order_id)).size,
      lines: ready.length,
      customers: new Set(ready.map(l => l.customer_id)).size,
      products: new Set(ready.map(l => l.product_id)).size,
      cartons: ready.reduce((s, l) => s + left(l), 0),
      fg: [...fgByProduct.values()].reduce((s, n) => s + n, 0),
      value: ready.reduce((s, l) => s + left(l) * (+l.rate || 0), 0),
      excess: ready.reduce((s, l) => s + (+l.excess_available || 0), 0),
      late: new Set(late.map(l => l.order_id)).size,
      worstLate: late.reduce((s, l) => Math.max(s, dueDelta(l.delivery_date) || 0), 0),
    };
  })();

  // Dispatch-register KPIs — the challan book, plus the money that has shipped
  // but not yet been billed.
  const registerKpi = useKpiFilter(embedded ? view : tab);
  // Two independent views on this page, so two lists: Ready carries the
  // customer chip and the shortage chip, the register only its own KPI.
  const readyFilters = useFilterReset([
    [customer, setCustomer, null, 'customer'],
    [shortOnly, setShortOnly, false, 'shortage'],
    [readyKpi.keys, readyKpi.clear, [], 'KPI card'],
  ]);
  const registerFilters = useFilterReset([[registerKpi.keys, registerKpi.clear, [], 'KPI card']]);
  const kpiRegister = (() => {
    const now = new Date();
    const thisMonth = d => {
      const t = d.dispatched_at ? new Date(d.dispatched_at) : null;
      return !!t && !Number.isNaN(+t) && t.getMonth() === now.getMonth() && t.getFullYear() === now.getFullYear();
    };
    const qtyOf = d => (d.lines || []).reduce((s, l) => s + (+l.qty || 0), 0);
    const mtd = register.filter(thisMonth);
    return {
      challans: register.length,
      customers: new Set(register.map(d => d.customer_id)).size,
      orders: new Set(register.map(d => d.order_id)).size,
      cartons: register.reduce((s, d) => s + qtyOf(d), 0),
      mtdChallans: mtd.length,
      mtdCartons: mtd.reduce((s, d) => s + qtyOf(d), 0),
      // The card is labelled with a DATE, so it must be the latest dispatch by
      // date. /dispatches comes back id DESC, and a back-dated challan entered
      // today would put an older date under "Last Dispatch".
      latest: register.reduce((best, d) => {
        const t = d.dispatched_at ? +new Date(d.dispatched_at) : NaN;
        if (Number.isNaN(t)) return best;
        const bt = best?.dispatched_at ? +new Date(best.dispatched_at) : -Infinity;
        return t > bt ? d : best;
      }, null),
      unbilledLines: unbilled.length,
      unbilledValue: unbilled.reduce((s, l) => s + (+l.amount || 0), 0),
      // Handed out so the "This Month" card filters by the very test it counted
      // with — a second copy of "is this month" is a second chance to disagree.
      isThisMonth: thisMonth,
    };
  })();
  const registerRows = registerKpi.apply(register, { month: kpiRegister.isThisMonth });

  return (
    <div>
      {!embedded && <PageHeader title="Dispatch" subtitle="Finished goods flow here automatically when a job closes" />}
      {!embedded && (
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'ready', label: 'Ready to Dispatch', count: kpiReady.orders },
          { key: 'register', label: 'Dispatch Register', count: register.length },
        ]} />
      )}

      {activeView === 'ready' && (
        <>
        <KpiRow cols={6}>
          <KpiCard compact icon={Truck} tone="info" label="Orders Ready"
            value={fmt.num(kpiReady.orders)}
            sub={`${fmt.count(kpiReady.lines, 'line')} · ${fmt.count(kpiReady.customers, 'customer')}`} />
          <KpiCard compact icon={Boxes} tone="neutral" label="Cartons to Send"
            value={fmt.num(kpiReady.cartons)}
            sub={kpiReady.products ? `across ${fmt.count(kpiReady.products, 'product')}` : 'nothing produced and in stock'} />
          <KpiCard compact icon={Warehouse} tone="good" label="FG on Hand"
            value={fmt.num(kpiReady.fg)}
            sub="cartons in finished goods" />
          <KpiCard compact icon={Banknote} tone="neutral" label="Value Ready"
            value={fmt.inrShort(kpiReady.value)} title={fmt.inr(kpiReady.value)}
            sub="dispatchable, not yet billed" />
          <KpiCard compact icon={PackageCheck} label="Excess Produced"
            tone={kpiReady.excess ? 'warn' : 'neutral'}
            value={fmt.num(kpiReady.excess)}
            sub={kpiReady.excess ? 'over-run — box to leftover' : 'no over-run to clear'}
            onClick={() => readyKpi.toggle('excess')} active={readyKpi.is('excess')} />
          <KpiCard compact icon={AlertTriangle} label="Past Delivery Date"
            tone={kpiReady.late ? 'bad' : 'good'}
            value={fmt.num(kpiReady.late)}
            sub={kpiReady.late ? `${fmt.count(kpiReady.late, 'order')} late · oldest ${kpiReady.worstLate}d` : 'everything within date'}
            onClick={() => readyKpi.toggle('late')} active={readyKpi.is('late')} />
        </KpiRow>
        <KpiFilterNotice filter={readyKpi} label={READY_KPI_LABEL[readyKpi.key]}
          shown={readyRows.length} total={ready.length} />
        {readyFilters.dirty && (
          <div className="mb-3 flex justify-end">
            <ResetFilters filters={readyFilters} shown={readyRows.length} total={ready.length} />
          </div>
        )}

        {/* Customer chips — the plant dispatches customer by customer, so this
            is the cut that actually gets used before picking lines. */}
        {(customerChips.length > 1 || shortageRows.length > 0) && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            {/* Shortage — production is OVER and the line still cannot be
                filled. It is a COPY of the row, not a move: the line stays in
                the main list, this just narrows to the ones needing a decision. */}
            {shortageRows.length > 0 && (
              <button type="button" onClick={() => setShortOnly(v => !v)}
                className={`rounded-full px-3 py-1 text-xs font-bold transition ${shortOnly
                  ? 'bg-red-600 text-white shadow-sm' : 'bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100'}`}>
                <AlertTriangle size={11} className="mr-1 inline" />
                Shortage <span className="ml-1 opacity-70">{shortageRows.length}</span>
              </button>
            )}
            <button type="button" onClick={() => setCustomer(null)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${customer == null
                ? 'bg-slate-800 text-white shadow-sm' : 'bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white'}`}>
              All <span className="ml-1 opacity-60">{ready.length}</span>
            </button>
            {customerChips.map(c => (
              <button key={c.id} type="button" onClick={() => setCustomer(customer === c.id ? null : c.id)}
                className={`rounded-full px-3 py-1 text-xs font-bold transition ${customer === c.id
                  ? 'bg-brand-600 text-white shadow-sm' : 'bg-white/70 text-slate-600 ring-1 ring-slate-200 hover:bg-white'}`}>
                {c.name} <span className="ml-1 opacity-60">{c.lines}</span>
              </button>
            ))}
          </div>
        )}

        {/* Bulk bar — appears only with a selection, like Procurement's. */}
        {selected.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/70 px-4 py-2.5 shadow-card backdrop-blur-xl animate-fadeIn">
            <span className="text-sm font-semibold text-slate-700">
              {selected.length} line{selected.length > 1 ? 's' : ''} selected
              <span className="ml-2 text-xs font-normal text-slate-500">
                <b className="text-slate-700">{fmt.num(selTotals.cartons)}</b> cartons in
                {' '}<b className="text-slate-700">{fmt.num(selTotals.boxes)}</b> boxes
                {selTotals.excess > 0 && <> · {fmt.num(selTotals.excess)} excess</>}
                {selTotals.short > 0 &&
                  <> · <span className="font-semibold text-red-600">{fmt.num(selTotals.short)} short</span></>}
              </span>
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(visibleIds)}>Select all {readyRows.length}</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>Deselect all</Button>
              <Button size="sm" onClick={openBulk}><Truck size={13} /> Move FG for {selected.length} line{selected.length > 1 ? 's' : ''}</Button>
            </div>
          </div>
        )}

        <DataTable searchable resetSignal={readyFilters.token} selectable
          selectedIds={selected}
          onToggleRow={(row, checked) => setSelectedIds(ids => checked
            ? [...new Set([...ids, row.order_line_id])]
            : ids.filter(id => id !== row.order_line_id))}
          onToggleAll={(rows, checked) => {
            const ids = rows.map(r => r.order_line_id);
            setSelectedIds(cur => checked ? [...new Set([...cur, ...ids])] : cur.filter(id => !ids.includes(id)));
          }}
          columns={[
            { key: 'po_number', label: 'PO / Customer', card: 'title',
              render: l => (
                <div>
                  <span className="font-extrabold">{l.po_number}</span>
                  <span className="ml-2 text-xs text-gray-500">{l.customer_name}</span>
                </div>),
              export: l => `${l.po_number} · ${l.customer_name}` },
            { key: 'delivery_date', label: 'Delivery',
              render: l => (
                <span className="whitespace-nowrap">
                  {fmt.date(l.delivery_date)}
                  {l.tolerance_pct > 0 && (
                    <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-bold text-brand-700">±{l.tolerance_pct}%</span>
                  )}
                </span>),
              export: l => `${fmt.date(l.delivery_date)}${l.tolerance_pct > 0 ? ` (±${l.tolerance_pct}%)` : ''}` },
            { key: 'product_name', label: 'Product', card: 'subtitle',
              render: l => <ProductIdentity row={l} compact={false} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'packing', label: 'Packing',
              render: l => (
                <span className="text-xs text-slate-500">
                  {l.packed_total > 0
                    ? <span className="inline-flex items-center gap-1"><Boxes size={12} className="text-slate-400" /> {fmt.num(l.packed_total)} pcs in {l.pack_boxes} boxes</span>
                    : l.pack_boxes
                      ? <span className="inline-flex items-center gap-1"><Boxes size={12} className="text-slate-400" /> {l.pack_boxes} boxes{l.pack_qty_per_box ? ` × ${l.pack_qty_per_box}` : ''}</span>
                      : <span className="text-slate-300">—</span>}
                </span>),
              export: l => (l.packed_total > 0 ? `${fmt.num(l.packed_total)} pcs in ${l.pack_boxes} boxes`
                : l.pack_boxes ? `${l.pack_boxes} boxes${l.pack_qty_per_box ? ` × ${l.pack_qty_per_box}` : ''}` : '—') },
            { key: 'qty', label: 'Ordered', align: 'right', card: 'metric',
              render: l => <span className="tabular-nums">{fmt.num(l.qty)}</span>, export: l => fmt.num(l.qty) },
            { key: 'dispatched_qty', label: 'Dispatched', align: 'right', card: 'metric',
              render: l => <span className="tabular-nums">{fmt.num(l.dispatched_qty)}</span>, export: l => fmt.num(l.dispatched_qty) },
            { key: 'fg_qty', label: 'FG in Stock', align: 'right', card: 'metric',
              render: l => (
                <div className="leading-tight">
                  <span className="font-bold tabular-nums text-emerald-600">{fmt.num(l.fg_qty)}</span>
                  {/* A box consumed against this line in planning is sitting in
                      the store under its own number and belongs in THIS lot.
                      Unsaid, the storekeeper ships loose stock and leaves the
                      box on the rack against an order that has already gone. */}
                  {+l.reserved_qty > 0 && (
                    <div className="whitespace-nowrap text-[10px] font-bold text-violet-600"
                      title={`Box ${l.reserved_boxes} was consumed in planning for this line — send it with this lot`}>
                      + box {l.reserved_boxes} ({fmt.num(l.reserved_qty)})
                    </div>
                  )}
                </div>
              ),
              export: l => (+l.reserved_qty > 0
                ? `${fmt.num(l.fg_qty)} (+ box ${l.reserved_boxes}: ${fmt.num(l.reserved_qty)})`
                : fmt.num(l.fg_qty)) },
            { key: 'suggested_dispatch', label: 'Suggested Dispatch', align: 'right', card: 'metric',
              render: l => (
                <span className={`font-bold tabular-nums ${l.suggested_dispatch > 0 ? 'text-brand-600' : 'text-slate-300'}`}>
                  {fmt.num(l.suggested_dispatch)}
                  {l.uses_tolerance && <span className="ml-1 text-[10px] font-bold text-amber-600" title="Fills into the tolerance band">±</span>}
                </span>),
              export: l => fmt.num(l.suggested_dispatch) },
            // S/E — Short and Excess against this order, one signed figure.
            // MINUS is short: the pool cannot fill what the order still wants.
            // PLUS is excess: finished goods no order can absorb within
            // tolerance, which is what gets boxed — so the carton breakdown
            // sits under the positive case only. A line can never be both.
            { key: 'se_qty', label: 'S/E Qty', align: 'right', card: 'metric',
              sortValue: l => (l.short_qty > 0 ? -l.short_qty : l.leftover_qty),
              render: l => (
                <div className="text-right">
                  {l.short_qty > 0 ? (
                    <div className="font-bold tabular-nums text-red-600" title="Short — the order wants more than finished goods can cover">
                      −{fmt.num(l.short_qty)}
                    </div>
                  ) : l.leftover_qty > 0 ? (
                    <>
                      <div className="font-bold tabular-nums text-amber-600" title="Excess — beyond what any order can take within tolerance">
                        +{fmt.num(l.leftover_qty)}
                      </div>
                      <div className="text-[10px] leading-tight text-slate-400">{boxLabel(l.leftover_qty, l.qty_per_box)}</div>
                    </>
                  ) : (
                    <span className="text-xs font-semibold text-slate-300">even</span>
                  )}
                </div>),
              export: l => (l.short_qty > 0 ? `-${fmt.num(l.short_qty)}`
                : l.leftover_qty > 0 ? `+${fmt.num(l.leftover_qty)} (${boxLabel(l.leftover_qty, l.qty_per_box)})`
                : 'even') },
            { key: 'actions', label: '', card: 'actions',
              render: l => (
                <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                  {l.is_shortage && (
                    <Button size="sm" variant="secondary" title="Production is over and this line is still short"
                      onClick={() => setShortage({ line: l, action: 'replan', reason: '' })}>
                      <AlertTriangle size={13} /> Resolve
                    </Button>
                  )}
                  <Button size="sm" onClick={() => openMove(l.product_id, l.product_name)}><Truck size={14} /> Move FG</Button>
                </div>) },
          ]}
          rows={readyRows} empty="Nothing waiting for dispatch."
          getRowId={l => l.order_line_id}
          exportName="Ready to Dispatch"
          exportSubtitle="Produced lines with finished goods on hand" />
        </>
      )}

      {/* ── The Shortage zone ─────────────────────────────────────────────
          Its own tab, always present, so the plant can find it before there is
          anything in it. Everything here has finished production and still
          cannot be met, so every row owes one of two answers. */}
      {activeView === 'shortage' && (
        <>
        <KpiRow cols={4}>
          <KpiCard compact icon={AlertTriangle} tone={shorts.length ? 'bad' : 'good'} label="Lines Short"
            value={fmt.num(shorts.length)}
            sub={shorts.length ? `${fmt.count(new Set(shorts.map(l => l.customer_id)).size, 'customer')} affected` : 'nothing outstanding'} />
          <KpiCard compact icon={Boxes} tone="neutral" label="Cartons Short"
            value={fmt.num(shorts.reduce((t, l) => t + (+l.shortfall_qty || 0), 0))}
            sub="below what the orders want" />
          <KpiCard compact icon={PackageCheck} tone="neutral" label="On Hand"
            value={fmt.num(shorts.reduce((t, l) => t + (+l.suggested_dispatch || 0), 0))}
            sub="dispatchable right now" />
          <KpiCard compact icon={Warehouse} tone={shorts.some(l => l.nothing_made) ? 'bad' : 'neutral'} label="Nothing Made"
            value={fmt.num(shorts.filter(l => l.nothing_made).length)}
            sub={shorts.some(l => l.nothing_made) ? 'no usable output at all' : 'every line made something'} />
        </KpiRow>

        <DataTable searchable
          columns={[
            { key: 'po_number', label: 'PO / Customer', card: 'title',
              render: l => (
                <div>
                  <span className="font-extrabold">{l.po_number}</span>
                  <span className="ml-2 text-xs text-gray-500">{l.customer_name}</span>
                </div>),
              export: l => `${l.po_number} · ${l.customer_name}` },
            { key: 'product_name', label: 'Product', card: 'subtitle',
              render: l => <ProductIdentity row={l} compact={false} />,
              searchValue: productSearchText,
              export: productExport },
            { key: 'jc_number', label: 'Batch',
              render: l => (
                <span className="text-xs">
                  <span className="font-semibold text-slate-600">{l.jc_number || '—'}</span>
                  <span className="ml-1 text-slate-400">closed {fmt.date(l.closed_at)}</span>
                </span>),
              export: l => `${l.jc_number || '—'} closed ${fmt.date(l.closed_at)}` },
            { key: 'qty', label: 'Ordered', align: 'right', card: 'metric',
              render: l => <span className="tabular-nums">{fmt.num(l.qty)}</span>, export: l => fmt.num(l.qty) },
            { key: 'qty_produced', label: 'Made', align: 'right', card: 'metric',
              render: l => (
                <span className={`tabular-nums ${l.nothing_made ? 'font-bold text-red-600' : ''}`}>
                  {fmt.num(l.qty_produced)}
                  {l.qty_scrap > 0 && <span className="ml-1 text-[10px] text-slate-400">−{fmt.num(l.qty_scrap)} scrap</span>}
                </span>),
              export: l => `${fmt.num(l.qty_produced)}${l.qty_scrap > 0 ? ` (−${fmt.num(l.qty_scrap)} scrap)` : ''}` },
            { key: 'suggested_dispatch', label: 'On Hand', align: 'right', card: 'metric',
              render: l => <span className="tabular-nums text-emerald-600">{fmt.num(l.suggested_dispatch)}</span>,
              export: l => fmt.num(l.suggested_dispatch) },
            { key: 'shortfall_qty', label: 'Short By', align: 'right', card: 'metric',
              render: l => (
                <div className="text-right">
                  <div className="font-bold tabular-nums text-red-600">−{fmt.num(l.shortfall_qty)}</div>
                  {l.nothing_made && <div className="text-[10px] font-bold uppercase leading-tight text-red-500">nothing made</div>}
                </div>),
              export: l => `-${fmt.num(l.shortfall_qty)}${l.nothing_made ? ' (nothing made)' : ''}` },
            { key: 'actions', label: '', card: 'actions',
              render: l => (
                <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                  <Button size="sm" onClick={() => setShortage({ line: l, action: 'replan', reason: '' })}>
                    <AlertTriangle size={13} /> Decide
                  </Button>
                </div>) },
          ]}
          rows={shorts}
          empty="Nothing is short. A line lands here when its batch has closed and finished goods still cannot cover what the order wants — then it needs one of two answers: make the balance, or close it short."
          getRowId={l => l.order_line_id}
          exportName="Shortages"
          exportSubtitle="Production finished, order still not met" />
        </>
      )}

      {activeView === 'register' && (
        <>
        <KpiRow cols={5}>
          <KpiCard compact icon={FileText} tone="info" label="Challans Issued"
            value={fmt.num(kpiRegister.challans)}
            sub={`${fmt.count(kpiRegister.customers, 'customer')} · ${fmt.count(kpiRegister.orders, 'order')}`} />
          <KpiCard compact icon={Boxes} tone="neutral" label="Cartons Dispatched"
            value={fmt.num(kpiRegister.cartons)}
            sub={kpiRegister.challans ? `avg ${fmt.num(Math.round(kpiRegister.cartons / kpiRegister.challans))} per challan` : 'nothing shipped yet'} />
          <KpiCard compact icon={CalendarDays} tone="good" label="This Month"
            value={fmt.num(kpiRegister.mtdCartons)}
            sub={`cartons on ${fmt.count(kpiRegister.mtdChallans, 'challan')}`}
            onClick={() => registerKpi.toggle('month')} active={registerKpi.is('month')} />
          <KpiCard compact icon={Truck} tone="neutral" label="Last Dispatch"
            value={kpiRegister.latest ? fmt.date(kpiRegister.latest.dispatched_at) : '—'}
            sub={kpiRegister.latest ? `${kpiRegister.latest.challan_number} · ${kpiRegister.latest.customer_name}` : 'no challan raised yet'} />
          <KpiCard compact icon={Banknote} label="Awaiting Invoice"
            tone={kpiRegister.unbilledLines ? 'warn' : 'good'}
            value={fmt.inrShort(kpiRegister.unbilledValue)} title={fmt.inr(kpiRegister.unbilledValue)}
            sub={kpiRegister.unbilledLines ? `${fmt.count(kpiRegister.unbilledLines, 'challan line')} to bill`
              : kpiRegister.challans ? 'every challan is billed' : 'no challans raised yet'} />
        </KpiRow>
        <KpiFilterNotice filter={registerKpi} label={REGISTER_KPI_LABEL[registerKpi.key]}
          shown={registerRows.length} total={register.length} />
        {registerFilters.dirty && (
          <div className="mb-3 flex justify-end">
            <ResetFilters filters={registerFilters} shown={registerRows.length} total={register.length} />
          </div>
        )}
        <DataTable searchable resetSignal={registerFilters.token}
          columns={[
            { key: 'challan_number', label: 'Challan', render: d => <span className="font-semibold">{d.challan_number}</span> },
            { key: 'dispatched_at', label: 'Date', render: d => fmt.dt(d.dispatched_at) },
            { key: 'customer_name', label: 'Customer' },
            { key: 'po_number', label: 'Against PO' },
            { key: 'vehicle', label: 'Vehicle' },
            { key: 'lines', label: 'Items',
              searchValue: d => d.lines.map(productSearchText).join(' '),
              export: d => d.lines.map(l => `${productExport(l)} x${fmt.num(l.qty)}`).join(', '),
              render: d => (
                <div className="space-y-1 text-xs text-gray-500">
                  {d.lines.map(l => (
                    <ProductIdentity key={l.id} row={l} compact meta={`x${fmt.num(l.qty)}`} />
                  ))}
                </div>
              ) },
            threadColumn({ entity: 'dispatch', threads, idOf: d => d.id }),
            { key: 'actions', label: '', render: d => (
              <div className="flex justify-end gap-1" onClick={e => e.stopPropagation()}>
                <Button size="sm" variant="secondary" title="Edit vehicle, driver or line quantities" onClick={() => nav(`/dispatch/challan/${d.id}`)}><Pencil size={13} /> Edit</Button>
                <Button size="sm" variant="ghost" title="Print delivery challan" onClick={() => nav(`/dispatch/challan/${d.id}`)}><Printer size={14} /> Print</Button>
                <Button size="sm" variant="ghost" title="Cancel challan — return goods to FG" onClick={() => cancelDispatch(d)}><Undo2 size={13} /> Cancel</Button>
              </div>) },
          ]}
          rows={registerRows} empty="No dispatches yet"
          rowClass={unreadRowClass(threads, d => d.id)}
          getRowId={d => d.id}
          exportName="Dispatch Register"
          exportSubtitle="Challans with vehicle and item detail" />
        </>
      )}

      {/* Shortage — the batch is finished and the order still is not met.
          Two decisions and only two: accept the gap, or make the balance. */}
      <Modal open={!!shortage} onClose={() => setShortage(null)}
        title={shortage ? `Shortage — ${shortage.line.po_number}` : ''}
        footer={shortage && (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setShortage(null)} disabled={saving}>Cancel</Button>
            <Button onClick={resolveShortage} disabled={saving || !shortage.reason.trim()}>
              {shortage.action === 'close' ? <><PackageCheck size={14} /> Close short</> : <><Undo2 size={14} /> Send to Planning</>}
            </Button>
          </div>
        )}>
        {shortage && (() => {
          const l = shortage.line;
          const owed = Math.max(0, l.qty - l.dispatched_qty);
          return (
            <div className="space-y-4">
              <div>
                <ProductIdentity row={l} />
                <div className="text-xs text-slate-500">{l.customer_name} · ordered {fmt.num(l.qty)} · dispatched {fmt.num(l.dispatched_qty)}</div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['Still owed', owed, 'from-slate-50 to-slate-100 text-slate-800'],
                  ['On hand', l.suggested_dispatch, 'from-emerald-50 to-emerald-100 text-emerald-700'],
                  ['Short by', l.shortfall_qty, 'from-red-50 to-red-100 text-red-700'],
                ].map(([k, v, cls]) => (
                  <div key={k} className={`rounded-2xl bg-gradient-to-br ${cls} p-3`}>
                    <div className="text-[11px] font-bold uppercase tracking-wide opacity-70">{k}</div>
                    <div className="text-xl font-extrabold tabular-nums">{fmt.num(v)}</div>
                  </div>
                ))}
              </div>
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Production is over — job card closed, so nothing more is coming for this line.
              </p>

              <div className="space-y-2">
                {[
                  ['replan', 'Send to Planning',
                    `Re-plan the ${fmt.num(l.shortfall_qty)} balance. The line goes back to the planner's queue and the new job card is raised for the shortfall only — not the whole order again.`],
                  ['close', 'Close short',
                    `Dispatch the ${fmt.num(l.suggested_dispatch)} on hand, accept the ${fmt.num(l.shortfall_qty)} gap and close the line. The sales order completes if this was its last open line.`],
                ].map(([key, title, body]) => (
                  <label key={key} className={`flex cursor-pointer gap-3 rounded-2xl border p-3 transition ${shortage.action === key
                    ? 'border-brand-400 bg-brand-50/60 ring-1 ring-brand-200' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                    <input type="radio" className="mt-1" checked={shortage.action === key}
                      onChange={() => setShortage(s2 => ({ ...s2, action: key }))} />
                    <span>
                      <span className="block text-sm font-bold text-slate-800">{title}</span>
                      <span className="block text-xs text-slate-500">{body}</span>
                    </span>
                  </label>
                ))}
              </div>
              <Field label="Reason" required>
                <Input value={shortage.reason} autoFocus
                  onChange={e => setShortage(s2 => ({ ...s2, reason: e.target.value }))}
                  placeholder="e.g. high rejection at sorting" />
              </Field>
            </div>
          );
        })()}
      </Modal>

      {/* Bulk Move FG — one row per selected line, one transaction */}
      <Modal open={!!bulk} onClose={() => setBulk(null)} wide
        title={bulk ? `Move FG — ${bulk.lines.length} line${bulk.lines.length > 1 ? 's' : ''}` : ''}
        footer={bulk && (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setBulk(null)} disabled={saving}>Cancel</Button>
            <Button onClick={runBulk} disabled={saving || bulkBlocked}>
              <PackageCheck size={14} /> Dispatch {fmt.num(bulkTotals.dispatch)}
              {bulkTotals.boxing > 0 ? ` · box ${fmt.num(bulkTotals.boxing)}` : ''}
            </Button>
          </div>
        )}>
        {bulk && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {[
                ['To dispatch', bulkTotals.dispatch, 'from-emerald-50 to-emerald-100 text-emerald-700'],
                ['To box as leftover', bulkTotals.boxing, 'from-amber-50 to-amber-100 text-amber-700'],
                ['Products', bulkTotals.products, 'from-slate-50 to-slate-100 text-slate-800'],
              ].map(([k, v, cls]) => (
                <div key={k} className={`rounded-2xl bg-gradient-to-br ${cls} p-3`}>
                  <div className="text-[11px] font-bold uppercase tracking-wide opacity-70">{k}</div>
                  <div className="text-xl font-extrabold tabular-nums">{fmt.num(v)}</div>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-2xl border border-slate-200">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50 text-left text-[11px] font-bold uppercase text-slate-500">
                  <th className="px-3 py-2">Product / PO</th>
                  <th className="px-3 py-2 text-right">FG</th>
                  <th className="px-3 py-2 text-right">Suggested</th>
                  <th className="px-3 py-2 text-right">Dispatch</th>
                  <th className="px-3 py-2 text-right">Leftover</th>
                  <th className="px-3 py-2 text-center">Box it</th>
                </tr></thead>
                <tbody>
                  {bulk.lines.map(l => {
                    const n = Math.max(0, Math.floor(+l.dispatch_now) || 0);
                    const rest = Math.max(0, l.fg_qty - n);
                    const err = bulkLineError(l);
                    return (
                      <tr key={l.order_line_id} className="border-b border-slate-100 last:border-0 align-top">
                        <td className="px-3 py-2">
                          <ProductIdentity row={l} compact />
                          <div className="text-xs text-slate-500">{l.po_number} · {l.customer_name} · ordered {fmt.num(l.ordered)} · ±{l.tolerance_pct}%</div>
                          {err && <div className="text-xs font-semibold text-red-600">{err}</div>}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmt.num(l.fg_qty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-400">{fmt.num(l.suggested)}</td>
                        <td className="px-3 py-2 text-right">
                          <Input type="number" min="0" className="w-28 text-right"
                            value={l.dispatch_now}
                            onChange={e => setBulkLine(l.order_line_id, { dispatch_now: e.target.value })} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="tabular-nums font-semibold text-amber-700">{fmt.num(rest)}</div>
                          {rest > 0 && <div className="text-[10px] leading-tight text-slate-400">{boxLabel(rest, l.qty_per_box, fmt.num)}</div>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" checked={l.box_leftover && l.pool_fully_selected}
                            disabled={rest === 0 || !l.pool_fully_selected}
                            onChange={e => setBulkLine(l.order_line_id, { box_leftover: e.target.checked })} />
                          {!l.pool_fully_selected && (
                            <div className="text-[10px] leading-tight text-slate-400" title="Another ready line wants this same product">
                              shared pool
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {bulkTotals.over.length > 0 && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
                A product is over-allocated — the dispatch quantities for it add up to more than its FG stock.
              </p>
            )}
            <p className="text-xs text-slate-500">
              Unticked leftovers stay loose in FG stock. Everything below goes out as one transaction — one challan per sales order.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vehicle"><Input value={bulk.vehicle} onChange={e => setBulk({ ...bulk, vehicle: e.target.value })} placeholder="Optional" /></Field>
              <Field label="Driver"><Input value={bulk.driver} onChange={e => setBulk({ ...bulk, driver: e.target.value })} placeholder="Optional" /></Field>
            </div>
          </div>
        )}
      </Modal>

      {/* Move FG — product-centric dispatch / leftover with live box math */}
      <Modal open={!!moving} onClose={() => setMoving(null)} wide
        title={moving ? `Move FG — ${moving.product_name}` : ''}
        footer={moving && !moving.loading && (
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="secondary" onClick={() => setMoving(null)} disabled={saving}>Keep in FG</Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={boxAllAsLeftover} disabled={saving || !moving.fg_stock}>
                <Warehouse size={14} /> Box all {fmt.num(moving.fg_stock)} as Leftover
              </Button>
              <Button onClick={dispatchNow} disabled={saving || toDispatch <= 0}>
                <PackageCheck size={14} /> Dispatch {fmt.num(toDispatch)}
                {leftover > 0 && ` · box ${fmt.num(leftover)}`}
              </Button>
            </div>
          </div>
        )}>
        {moving && (moving.loading || loadingMove ? (
          <p className="py-10 text-center text-sm text-gray-400">Loading FG movement plan…</p>
        ) : (
          <div className="space-y-4">
            {/* Three summary tiles */}
            <div className="grid grid-cols-3 gap-3">
              {[
                ['FG on hand', moving.fg_stock, 'from-slate-50 to-slate-100 text-slate-800'],
                ['To dispatch', toDispatch, 'from-emerald-50 to-emerald-100 text-emerald-700'],
                ['Leftover → boxed', leftover, 'from-amber-50 to-amber-100 text-amber-700'],
              ].map(([k, v, cls]) => (
                <div key={k} className={`rounded-2xl bg-gradient-to-br ${cls} px-4 py-3 shadow-sm`}>
                  <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{k}</div>
                  <div className="text-2xl font-black tabular-nums">{fmt.num(v)}</div>
                  <div className="text-[11px] font-semibold opacity-70">{boxLabel(v, moving.qty_per_box, fmt.num)}</div>
                </div>
              ))}
            </div>

            <div className="text-[11px] font-semibold text-slate-500">
              Box size on record: {moving.qty_per_box > 0 ? `${fmt.num(moving.qty_per_box)} / box` : 'none — leftover will box as one lot'}
            </div>

            {/* One row per allocated sales order */}
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-1.5">Sales Order</th><th className="px-3 py-1.5">Customer</th>
                <th className="px-3 py-1.5 text-right">Ordered</th><th className="px-3 py-1.5 text-right">Dispatched</th>
                <th className="px-3 py-1.5 text-right">Tol %</th><th className="px-3 py-1.5 text-right">Max incl. tol</th>
                <th className="px-3 py-1.5 text-right">Dispatch Now</th>
              </tr></thead>
              <tbody>
                {moving.allocations.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No open sales order needs this product — box the FG as leftover.</td></tr>
                )}
                {moving.allocations.map(a => {
                  const room = Math.max(0, a.allowed_max - a.dispatched);
                  const val = Math.floor(+a.dispatch_now) || 0;
                  const over = val > room;
                  const b = boxBreakdown(val, moving.qty_per_box);
                  return (
                    <tr key={a.order_line_id} className="border-b border-gray-50 align-top">
                      <td className="px-3 py-2 font-semibold">{a.po_number}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">{a.customer_name}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(a.ordered)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt.num(a.dispatched)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">±{a.tolerance_pct}%</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmt.num(a.allowed_max)}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0"
                          value={a.dispatch_now}
                          onChange={e => setAllocQty(a.order_line_id, e.target.value)}
                          className={`w-32 rounded-lg border px-2 py-1 text-right text-sm focus:outline-none ${over ? 'border-amber-400 bg-amber-50 focus:border-amber-500' : 'border-gray-300 focus:border-brand-500'}`} />
                        <div className={`mt-0.5 text-[10px] font-semibold ${over ? 'text-amber-600' : 'text-slate-400'}`}>
                          {over ? `beyond tolerance — room ${fmt.num(room)}` : `room ${fmt.num(room)}`}
                        </div>
                        {val > 0 && (
                          <div className="mt-0.5 text-[11px] font-semibold text-emerald-600">
                            = {b.per > 0 ? `${fmt.num(b.boxes)} box${b.boxes === 1 ? '' : 'es'} × ${fmt.num(b.per)}${b.loose > 0 ? ` + ${fmt.num(b.loose)} loose` : ''}` : `${fmt.num(b.loose)} loose`}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Vehicle / Driver */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vehicle No"><Input value={moving.vehicle} onChange={e => setMoving({ ...moving, vehicle: e.target.value })} placeholder="PB-10-XX-0000" /></Field>
              <Field label="Driver"><Input value={moving.driver} onChange={e => setMoving({ ...moving, driver: e.target.value })} /></Field>
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
}
