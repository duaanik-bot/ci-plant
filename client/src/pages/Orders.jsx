import { useEffect, useState } from 'react';
import { api, auth, fmt } from '../api.js';
import { Button, DataTable, dueDelta, ExportMenu, Field, FulfillmentBar, Input, KpiCard, KpiFilterNotice, KpiRow, Modal, PageHeader, rowMatches, searchText, Select, StatusBadge, SubTabs, Tabs, Textarea, useKpiFilter, useToast } from '../components/ui.jsx';
import { threadColumn, unreadRowClass } from '../components/ThreadCell.jsx';
import { ProductQuickCreate } from '../components/QuickCreateMasters.jsx';
import { nextCodeForRows } from '../lib/productCode.js';
import { AlertTriangle, Ban, Banknote, Boxes, CheckCircle2, ClipboardList, Copy, Download, Factory, FileUp, PackageCheck, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import ImportPOWizard from '../components/ImportPOWizard.jsx';

const emptyLine = { product_id: '', qty: '', rate: '', gst: '' };
const th = 'px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400';
const td = 'px-4 py-2.5';

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

function exportCsv(filename, header, rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Where a pending line stands right now — FG cover first (dispatchable today),
// then the live workflow position from line status + floor stage.
const PENDENCY_TONES = {
  delayed: 'bg-red-50 text-red-600',
  ready_fg: 'bg-emerald-50 text-emerald-700',
  partial_fg: 'bg-cyan-50 text-cyan-700',
  production_required: 'bg-amber-50 text-amber-700',
  produced: 'bg-emerald-50 text-emerald-700',
  in_production: 'bg-amber-50 text-amber-700',
  ready: 'bg-violet-50 text-violet-700',
  planned: 'bg-blue-50 text-blue-700',
  pending: 'bg-gray-100 text-gray-600',
};
function pendencyStage(l) {
  const fgCover = +(l.fg_allocated_qty ?? l.fg_qty ?? 0);
  const pending = +l.pending_qty || 0;
  if (+l.overdue_days > 0 && fgCover < pending) return { key: 'delayed', label: 'Delayed' };
  if (fgCover >= pending && pending > 0) return { key: 'ready_fg', label: 'Ready from FG' };
  if (fgCover > 0) return { key: 'partial_fg', label: 'Partially Ready' };
  if (l.status === 'produced') return { key: 'produced', label: 'Produced' };
  if (l.status === 'in_production') {
    return {
      key: 'in_production',
      label: l.current_stage ? `On Floor · ${fmt.title(l.current_stage)}`
        : l.next_stage ? `Queued · ${fmt.title(l.next_stage)}` : 'On floor',
    };
  }
  if (l.status === 'ready') return { key: 'ready', label: 'Ready for production' };
  if (l.status === 'planned') return { key: 'planned', label: 'Planned' };
  if (pending > 0) return { key: 'production_required', label: 'Production Required' };
  return { key: 'pending', label: 'Awaiting Planning' };
}
function PendencyBadge({ line }) {
  const s = pendencyStage(line);
  return (
    <div>
      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${PENDENCY_TONES[s.key]}`}>{s.label}</span>
      {line.total_stages > 0 && (
        <div className="mt-0.5 text-[11px] text-slate-400">
          {line.jc_number}{line.gang_parent_job ? ' · gang parent' : ''} · {line.done_stages}/{line.total_stages} stages
        </div>
      )}
    </div>
  );
}

// Which rows sit behind each clickable KPI card, and what to call that set once
// it is the only thing on screen. Kept beside the card definitions rather than
// inside the component: these are constants, and a card whose predicate drifts
// from its arithmetic is the one bug this whole feature can introduce.
const ORDER_KPI_ROWS = {
  // Fulfilment: the orders actually in flight — some dispatched, not all.
  part: o => (+o.fulfilled_qty || 0) > 0 && (+o.fulfilled_qty || 0) < (+o.ordered_qty || 0),
  // Open Value: everything with pieces still owed, untouched or half-shipped.
  open: o => (+o.fulfilled_qty || 0) < (+o.ordered_qty || 0),
  // Past Delivery Date: the same test the card counts with.
  late: o => (+o.fulfilled_qty || 0) < (+o.ordered_qty || 0) && dueDelta(o.delivery_date) > 0,
};
const ORDER_KPI_LABEL = {
  part: 'part-dispatched orders',
  open: 'orders with pieces still to dispatch',
  late: 'orders past their delivery date',
};

// The pendency tab lists LINES, so its cards filter lines, not orders.
const PENDENCY_KPI_ROWS = {
  ready_fg: l => (+l.fg_allocated_qty || 0) > 0,
  on_floor: l => !!l.jc_status && l.jc_status !== 'closed',
  to_plan: l => !l.jc_status || l.jc_status === 'closed',
  overdue: l => +l.overdue_days > 0,
};
const PENDENCY_KPI_LABEL = {
  ready_fg: 'lines with FG stock against them',
  on_floor: 'lines already on a job card',
  to_plan: 'lines with no job card yet',
  overdue: 'lines past their delivery date',
};

function buildPendencyRollups(lines) {
  const byProduct = {};
  const byCustomer = {};
  for (const l of lines) {
    const wip = l.jc_status && l.jc_status !== 'closed' ? +l.qty_planned || 0 : 0;
    const p = (byProduct[l.product_id] ||= {
      key: l.product_id, label: l.product_name, code: l.product_code, size: l.size,
      pending_qty: 0, pending_value: 0, fg_qty: +l.fg_qty || 0, fg_allocated_qty: 0,
      production_required_qty: 0, wip_qty: 0, orders: new Set(), customers: new Set(),
      overdue_lines: 0, overdue: 0, max_age: 0,
    });
    p.pending_qty += +l.pending_qty || 0;
    p.pending_value += +l.pending_value || 0;
    p.fg_allocated_qty += +l.fg_allocated_qty || 0;
    p.production_required_qty += +l.production_required_qty || 0;
    p.wip_qty += wip;
    p.orders.add(l.order_id); p.customers.add(l.customer_id);
    if (+l.overdue_days > 0) p.overdue_lines += 1;
    p.overdue = Math.max(p.overdue, +l.overdue_days || 0);
    p.max_age = Math.max(p.max_age, +l.age_days || 0);

    const c = (byCustomer[l.customer_id] ||= {
      key: l.customer_id, label: l.customer_name, pending_qty: 0, pending_value: 0,
      fg_allocated_qty: 0, production_required_qty: 0, wip_qty: 0, lines: 0,
      overdue_lines: 0, orders: new Set(), products: new Set(), overdue: 0, max_age: 0,
    });
    c.pending_qty += +l.pending_qty || 0;
    c.pending_value += +l.pending_value || 0;
    c.fg_allocated_qty += +l.fg_allocated_qty || 0;
    c.production_required_qty += +l.production_required_qty || 0;
    c.wip_qty += wip;
    c.lines += 1;
    if (+l.overdue_days > 0) c.overdue_lines += 1;
    c.orders.add(l.order_id); c.products.add(l.product_id);
    c.overdue = Math.max(c.overdue, +l.overdue_days || 0);
    c.max_age = Math.max(c.max_age, +l.age_days || 0);
  }
  return {
    by_product: Object.values(byProduct).map(r => ({
      ...r, orders: r.orders.size, customers: r.customers.size,
      to_plan: Math.max(0, r.production_required_qty - r.wip_qty),
    })).sort((a, b) => b.pending_qty - a.pending_qty),
    by_customer: Object.values(byCustomer).map(r => ({
      ...r, orders: r.orders.size, products: r.products.size,
      to_plan: Math.max(0, r.production_required_qty - r.wip_qty),
    })).sort((a, b) => b.pending_value - a.pending_value),
  };
}
const toDateInput = s => (s ? String(s).slice(0, 10) : '');
const lineTax = l => (l.qty && l.rate ? (l.qty * l.rate) * (Number(l.gst) || 0) / 100 : 0);
const orderTotals = lines => {
  const taxable = lines.reduce((s, l) => s + (l.qty && l.rate ? l.qty * l.rate : 0), 0);
  const gst = lines.reduce((s, l) => s + lineTax(l), 0);
  return { taxable, gst, total: taxable + gst };
};

function productSpec(product) {
  if (!product) return null;
  const article = [
    product.code || product.product_code,
    product.size,
    product.gsm ? `${product.gsm} GSM` : '',
    product.colors ? `${product.colors}C` : '',
  ].filter(Boolean).join(' · ');
  const details = [
    product.board_name,
    product.coating && product.coating !== 'none' ? fmt.title(product.coating) : '',
    product.sheet_l && product.sheet_w ? `Sheet ${product.sheet_l}×${product.sheet_w}"` : '',
    product.die_number ? `AW ${product.die_number}` : '',
    product.child_l && product.child_w ? `Print ${product.child_l}×${product.child_w}"` : '',
    product.ups ? `${product.ups} ups` : '',
    product.special && product.special !== 'none' ? fmt.title(product.special) : '',
  ].filter(Boolean).join(' · ');
  return { article, details };
}

function ProductSpec({ product }) {
  const spec = productSpec(product);
  if (!spec) return null;
  return (
    <div className="mt-2 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2">
      <div className="text-[11px] font-bold leading-4 text-slate-600">{spec.article}</div>
      {spec.details && <div className="mt-0.5 text-[11px] leading-4 text-slate-400">{spec.details}</div>}
    </div>
  );
}

function OrderTotals({ lines }) {
  const t = orderTotals(lines);
  if (!t.taxable) return null;
  return (
    <div className="min-w-[180px] rounded-xl bg-slate-50 px-4 py-2 text-right text-xs tabular-nums">
      <div className="flex justify-between gap-6 text-slate-500"><span>Taxable</span><span>{fmt.inr(t.taxable)}</span></div>
      <div className="flex justify-between gap-6 text-slate-500"><span>GST</span><span>{fmt.inr(t.gst)}</span></div>
      <div className="mt-1 flex justify-between gap-6 border-t border-slate-200 pt-1 font-bold text-slate-800"><span>Total</span><span>{fmt.inr(t.total)}</span></div>
    </div>
  );
}

export default function Orders() {
  const toast = useToast();
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [form, setForm] = useState({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });
  const [gstRates, setGstRates] = useState([]);
  const [tab, setTab] = useState('pending');
  const [quickProduct, setQuickProduct] = useState(null); // { line, mode: 'new' | 'edit' }
  const [pendency, setPendency] = useState(null);
  const [pendencyFilter, setPendencyFilter] = useState({ search: '', customer: '', product: '', status: '' });
  const [pendencyView, setPendencyView] = useState('customer'); // customer | item | lines
  // Two lists, two entities: the order register talks about ORDERS, the pendency
  // detail talks about the individual order LINE it shows.
  const [orderThreads, setOrderThreads] = useState({});
  const [lineThreads, setLineThreads] = useState({});

  // Pendency is loaded from two places (initial load + entering the tab), so the
  // fetch and its thread summary live together — otherwise the second caller
  // would leave the line badges painted against the previous set of lines.
  const loadPendency = () => api.get('/sales/pendency').then(p => {
    setPendency(p);
    threadSummary('order_line', (p.lines || []).map(l => l.line_id)).then(setLineThreads).catch(() => {});
  }).catch(() => {});
  const load = () => {
    api.get('/orders').then(os => {
      setOrders(os);
      threadSummary('order', os.map(o => o.id)).then(setOrderThreads).catch(() => {});
    });
    loadPendency();
  };
  useEffect(() => {
    load();
    api.get('/customers').then(setCustomers);
    api.get('/products').then(setProducts);
    api.get('/gst_rates').then(setGstRates);
  }, []);
  // Pendency reflects dispatches and floor moves made elsewhere — refresh on entry.
  useEffect(() => {
    if (tab === 'pendency') loadPendency();
  }, [tab]);

  // Default GST for a product: its manual override → its type's rate (master) → 12%.
  const gstOf = p => {
    if (!p) return '';
    if (p.effective_gst != null) return p.effective_gst;
    if (p.gst_pct != null) return p.gst_pct;
    const t = gstRates.find(g => g.product_type === p.product_type);
    return t ? t.rate : 12;
  };

  const byStatus = s => orders.filter(o => o.status === s);
  const ordersForTab = {
    pending: byStatus('pending'),
    hold: byStatus('hold'),
    completed: byStatus('completed'),
    closed: byStatus('closed'),
    cancelled: byStatus('cancelled'),
  };

  // KPI strip — scoped to the tab being looked at, so the numbers always
  // describe the list underneath rather than a module-wide constant that never
  // moves. Open value is prorated by the pieces still to go: an order's `value`
  // is the whole PO, and billing half of it as outstanding would overstate the
  // book by the amount already dispatched.
  const kpiOrders = (() => {
    const rows = ordersForTab[tab] || [];
    const ordered = rows.reduce((s, o) => s + (+o.ordered_qty || 0), 0);
    const done = rows.reduce((s, o) => s + (+o.fulfilled_qty || 0), 0);
    const late = rows.filter(o => (+o.fulfilled_qty || 0) < (+o.ordered_qty || 0) && dueDelta(o.delivery_date) > 0);
    return {
      orders: rows.length,
      lines: rows.reduce((s, o) => s + (+o.line_count || 0), 0),
      customers: new Set(rows.map(o => o.customer_id ?? o.customer_name)).size,
      value: rows.reduce((s, o) => s + (+o.value || 0), 0),
      openValue: rows.reduce((s, o) => {
        const q = +o.ordered_qty || 0;
        return s + (q > 0 ? (+o.value || 0) * (Math.max(0, q - (+o.fulfilled_qty || 0)) / q) : 0);
      }, 0),
      ordered,
      done,
      pct: ordered > 0 ? Math.round((done / ordered) * 100) : 0,
      late: late.length,
      worstLate: late.reduce((s, o) => Math.max(s, dueDelta(o.delivery_date) || 0), 0),
      dated: rows.filter(o => o.delivery_date).length,
    };
  })();

  // Clicking a KPI card filters the table to exactly the rows that card counted
  // — same test on both sides, so the number and the list can never disagree.
  // Only cards naming a SUBSET are wired; a total covers every row already.
  const orderKpi = useKpiFilter(tab);
  const orderRows = orderKpi.apply(ordersForTab[tab] || ordersForTab.pending, ORDER_KPI_ROWS);
  const custProducts = products.filter(p => String(p.customer_id) === String(form.customer_id) && p.active);
  const setLine = (i, patch) => setForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cloneLine = i => setForm(f => {
    const source = f.lines[i] || emptyLine;
    const copy = { product_id: source.product_id, qty: source.qty, rate: source.rate, gst: source.gst };
    return { ...f, lines: [...f.lines.slice(0, i + 1), copy, ...f.lines.slice(i + 1)] };
  });

  const save = async () => {
    const lines = form.lines.filter(l => l.product_id && l.qty).map(l => ({ ...l, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate }));
    await api.post('/orders', { ...form, customer_id: +form.customer_id, lines });
    toast.success('Order created');
    setShowNew(false);
    setForm({ po_number: '', customer_id: '', po_date: '', delivery_date: '', notes: '', lines: [{ ...emptyLine }] });
    load();
  };

  // Quick-created product → refresh the master list and drop it onto the line
  // that asked for it, with rate + GST defaults filled the same as a pick.
  const handleProductCreated = async product => {
    const ps = await api.get('/products');
    setProducts(ps);
    const enriched = ps.find(p => String(p.id) === String(product.id)) || product;
    const patch = { product_id: String(product.id), rate: enriched.rate ?? '', gst: gstOf(enriched) };
    if (quickProduct?.mode === 'edit') setEditLine(quickProduct.line, patch);
    else setLine(quickProduct.line, patch);
    setQuickProduct(null);
  };
  const quickCustomerId = quickProduct?.mode === 'edit' ? editForm?.customer_id : form.customer_id;

  const openDetail = o => api.get(`/orders/${o.id}`).then(setDetail);
  const closeDetail = () => {
    setDetail(null);
    setEditing(false);
    setEditForm(null);
  };
  const [closeOrderModal, setCloseOrderModal] = useState(null); // { reason }

  const canDelete = ['admin', 'planner'].includes(auth.user?.role);
  const [deleteTarget, setDeleteTarget] = useState(null); // order row pending delete
  const [delPreview, setDelPreview] = useState(null);     // /delete-preview payload (null = loading)
  const [delConfirm, setDelConfirm] = useState(false);    // "I'm sure" tick for a force delete
  const [delBusy, setDelBusy] = useState(false);
  const askDeleteOrder = o => {
    setDelPreview(null); setDelConfirm(false); setDeleteTarget(o);
    api.get(`/orders/${o.id}/delete-preview`)
      .then(setDelPreview)
      .catch(e => setDelPreview({ hard_blockers: [e.message || 'Could not check this order'], reversals: [], deletes: [], force_required: false }));
  };
  const runDeleteOrder = async () => {
    setDelBusy(true);
    try {
      await api.del(`/orders/${deleteTarget.id}`, delPreview?.force_required ? { force: true } : undefined);
      toast.success(delPreview?.force_required
        ? `Order ${deleteTarget.po_number} reversed & deleted everywhere`
        : `Order ${deleteTarget.po_number} deleted`);
      setDeleteTarget(null);
      load();
    } catch (e) {
      if (e.data?.blockers) setDelPreview(p => ({ ...(p || { reversals: [], deletes: [] }), hard_blockers: e.data.blockers, force_required: false }));
      else toast.error(e.message || 'Could not delete order');
    } finally { setDelBusy(false); }
  };

  const cancelOrder = async () => {
    try {
      await api.post(`/orders/${detail.id}/cancel`, { reason: closeOrderModal.reason || undefined });
      toast.info(`${detail.po_number} closed`);
      setCloseOrderModal(null); load();
      api.get(`/orders/${detail.id}`).then(setDetail);
    } catch (e) { toast.error(e.message || 'Could not close order'); }
  };

  const setOrderStatus = async (status) => {
    try {
      const updated = await api.post(`/orders/${detail.id}/status`, { status });
      toast.success(`Order marked ${status}`);
      setDetail(d => ({ ...d, status: updated.status }));
      load();
    } catch (e) { toast.error(e.message || `Could not set ${status}`); }
  };

  const markLineComplete = async lineId => {
    try {
      const r = await api.post(`/orders/${detail.id}/complete-lines`, { line_ids: [lineId] });
      toast.success(`Item marked complete${r.order_completed ? ' · order moved to Completed' : ''}`);
      load(); api.get(`/orders/${detail.id}`).then(setDetail);
    } catch (e) { toast.error(e.message || 'Could not mark complete'); }
  };
  const detailToForm = o => ({
    po_number: o.po_number || '',
    customer_id: String(o.customer_id || ''),
    po_date: toDateInput(o.po_date),
    delivery_date: toDateInput(o.delivery_date),
    notes: o.notes || '',
    lines: o.lines.map(l => ({
      id: l.id,
      product_id: String(l.product_id),
      qty: l.qty,
      rate: l.rate,
      gst: l.gst_pct,
      dispatched_qty: l.dispatched_qty,
      status: l.status,
    })),
  });
  const startEdit = () => {
    setEditForm(detailToForm(detail));
    setEditing(true);
  };
  const editProducts = products.filter(p => String(p.customer_id) === String(editForm?.customer_id) && p.active);
  const setEditLine = (i, patch) => setEditForm(f => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cloneEditLine = i => setEditForm(f => {
    const source = f.lines[i] || emptyLine;
    const copy = { product_id: source.product_id, qty: source.qty, rate: source.rate, gst: source.gst };
    return { ...f, lines: [...f.lines.slice(0, i + 1), copy, ...f.lines.slice(i + 1)] };
  });
  const saveEdit = async () => {
    const lines = editForm.lines
      .filter(l => l.product_id && l.qty)
      .map(l => ({ ...l, qty: +l.qty, rate: l.rate === '' ? undefined : +l.rate }));
    const updated = await api.put(`/orders/${detail.id}`, { ...editForm, customer_id: +editForm.customer_id, lines });
    toast.success('Order updated');
    setDetail(updated);
    setEditForm(detailToForm(updated));
    setEditing(false);
    load();
  };

  const allPdLines = pendency?.lines || [];
  const pdProductOptions = [...new Map(allPdLines.map(l => [l.product_id, l.product_name])).entries()]
    .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const pdCustomerOptions = [...new Map(allPdLines.map(l => [l.customer_id, l.customer_name])).entries()]
    .map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  const pdKpi = useKpiFilter(tab);
  const pdUnfiltered = allPdLines.filter(l => {
    const status = pendencyStage(l).key;
    const searchOk = rowMatches(l, pendencyFilter.search, `${status} ${pendencyStage(l).label}`);
    const customerOk = !pendencyFilter.customer || String(l.customer_id) === String(pendencyFilter.customer);
    const productOk = !pendencyFilter.product || String(l.product_id) === String(pendencyFilter.product);
    const statusOk = !pendencyFilter.status || status === pendencyFilter.status;
    return searchOk && customerOk && productOk && statusOk;
  });
  // The KPI card narrows what the dropdowns already narrowed. Everything below
  // — rollups, summary, all three views — is built from this one list, so the
  // strip, the roll-up tables and the line detail can never fall out of step.
  const pdLines = pdKpi.apply(pdUnfiltered, PENDENCY_KPI_ROWS);
  const pdRollups = buildPendencyRollups(pdLines);
  const pdSummary = {
    orders: new Set(pdLines.map(l => l.order_id)).size,
    customers: new Set(pdLines.map(l => l.customer_id)).size,
    qty: pdLines.reduce((s, l) => s + +l.pending_qty, 0),
    ordered: pdLines.reduce((s, l) => s + +l.qty, 0),
    value: pdLines.reduce((s, l) => s + +l.pending_value, 0),
    ready: pdLines.reduce((s, l) => s + Math.min(+l.pending_qty || 0, +l.fg_allocated_qty || 0), 0),
    onFloor: pdRollups.by_product.reduce((s, m) => s + m.wip_qty, 0),
    toPlan: pdRollups.by_product.reduce((s, m) => s + m.to_plan, 0),
    overdueLines: pdLines.filter(l => l.overdue_days > 0).length,
    maxOverdue: pdLines.reduce((s, l) => Math.max(s, l.overdue_days), 0),
  };
  const statusCounts = allPdLines.reduce((acc, l) => {
    const key = pendencyStage(l).key;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PageHeader title="Sales Orders" subtitle="Customer POs in — every line tracked to dispatch"
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowImport(true)}><FileUp size={15} /> Import PO</Button>
          <Button onClick={() => setShowNew(true)}><Plus size={15} /> New Order</Button>
        </div>} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'pending', label: 'Pending', count: ordersForTab.pending.length },
        { key: 'hold', label: 'Hold', count: ordersForTab.hold.length },
        { key: 'completed', label: 'Completed', count: ordersForTab.completed.length },
        { key: 'closed', label: 'Closed', count: ordersForTab.closed.length },
        { key: 'cancelled', label: 'Cancelled', count: ordersForTab.cancelled.length },
        { key: 'pendency', label: 'Pendency' },
      ]} />

      {tab !== 'pendency' && (
        <KpiRow cols={6}>
          {/* The first three describe the whole tab, so they stay plain tiles —
              clicking one could only ever re-show the list already on screen. */}
          <KpiCard compact icon={ClipboardList} tone="info" label={`${fmt.title(tab)} Orders`}
            value={fmt.num(kpiOrders.orders)}
            sub={`${fmt.count(kpiOrders.lines, 'line')} · ${fmt.count(kpiOrders.customers, 'customer')}`} />
          <KpiCard compact icon={Banknote} tone="neutral" label="Order Value"
            value={fmt.inrShort(kpiOrders.value)} title={fmt.inr(kpiOrders.value)}
            sub={kpiOrders.orders ? `avg ${fmt.inrShort(kpiOrders.value / kpiOrders.orders)} per order` : 'nothing booked'} />
          <KpiCard compact icon={Boxes} tone="neutral" label="Cartons Ordered"
            value={fmt.num(kpiOrders.ordered)}
            sub={`${fmt.num(kpiOrders.done)} dispatched so far`} />
          <KpiCard compact icon={PackageCheck} label="Fulfilment"
            tone={kpiOrders.pct >= 100 ? 'good' : kpiOrders.pct > 0 ? 'warn' : 'neutral'}
            value={`${kpiOrders.pct}%`}
            sub={`${fmt.num(Math.max(0, kpiOrders.ordered - kpiOrders.done))} pcs still to go`}
            onClick={() => orderKpi.toggle('part')} active={orderKpi.is('part')} />
          <KpiCard compact icon={Factory} tone="violet" label="Open Value"
            value={fmt.inrShort(kpiOrders.openValue)} title={`${fmt.inr(kpiOrders.openValue)} — value of the pieces not yet dispatched`}
            sub="still to dispatch & bill"
            onClick={() => orderKpi.toggle('open')} active={orderKpi.is('open')} />
          <KpiCard compact icon={AlertTriangle} label="Past Delivery Date"
            tone={kpiOrders.late ? 'bad' : 'good'}
            value={fmt.num(kpiOrders.late)}
            sub={kpiOrders.late ? `oldest ${kpiOrders.worstLate} days late`
              : kpiOrders.dated ? 'all within promised date' : 'no delivery dates set'}
            onClick={() => orderKpi.toggle('late')} active={orderKpi.is('late')} />
        </KpiRow>
      )}

      {tab !== 'pendency' && (
        <KpiFilterNotice filter={orderKpi} label={ORDER_KPI_LABEL[orderKpi.key]}
          shown={orderRows.length} total={(ordersForTab[tab] || []).length} />
      )}

      {tab !== 'pendency' && (
        <DataTable searchable
          // Latest PO entered sits at the top. The API already hands them over
          // newest-first, but the table re-sorted by its first column (PO number,
          // ascending) and buried the order just booked. `id` is not a column —
          // it rises with entry, so this only sets the OPENING order; every
          // header still sorts on click.
          defaultSort={{ key: 'id', dir: 'desc' }}
          columns={[
            { key: 'po_number', label: 'PO Number', render: o => <span className="font-semibold text-gray-900">{o.po_number}</span> },
            { key: 'customer_name', label: 'Customer' },
            { key: 'po_date', label: 'PO Date', render: o => fmt.date(o.po_date) },
            { key: 'delivery_date', label: 'Delivery', render: o => fmt.date(o.delivery_date) },
            { key: 'line_count', label: 'Lines', align: 'right' },
            { key: 'value', label: 'Value', align: 'right', render: o => fmt.inr(o.value) },
            { key: 'fulfillment', label: 'Fulfillment', sortValue: o => (o.ordered_qty > 0 ? (o.fulfilled_qty / o.ordered_qty) * 100 : 0),
              export: o => `${(o.ordered_qty > 0 ? Math.min(100, (o.fulfilled_qty / o.ordered_qty) * 100) : 0).toFixed(1)}%`,
              render: o => <FulfillmentBar pct={o.ordered_qty > 0 ? (o.fulfilled_qty / o.ordered_qty) * 100 : 0}
                done={o.fulfilled_qty} total={o.ordered_qty} unit="pcs" /> },
            { key: 'status', label: 'Status', render: o => <StatusBadge status={o.status} /> },
            threadColumn({ entity: 'order', threads: orderThreads, idOf: o => o.id }),
            { key: '_actions', label: '', sortable: false, render: o => (
              canDelete && ['pending', 'hold', 'cancelled'].includes(tab) ? (
                <div className="flex justify-end" onClick={e => e.stopPropagation()}>
                  <button type="button" title="Delete order"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-red-50 hover:text-red-500"
                    onClick={() => askDeleteOrder(o)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null
            ) },
          ]}
          rows={orderRows} onRowClick={openDetail}
          rowClass={unreadRowClass(orderThreads, o => o.id)}
          getRowId={o => o.id}
          empty={{
            pending: 'No pending orders — create your first one',
            hold: 'No orders on hold',
            completed: 'No completed orders yet',
            closed: 'No closed orders',
            cancelled: 'No cancelled orders',
          }[tab]}
          exportName="Sales Orders"
          exportSubtitle="Customer POs, line counts and values"
          exportMeta={() => [`Tab: ${fmt.title(tab)}`]}
          exportSummary={rows => [
            { label: 'Orders', value: rows.length },
            { label: 'Lines', value: rows.reduce((s, o) => s + (+o.line_count || 0), 0) },
            { label: 'Value', value: fmt.inr(rows.reduce((s, o) => s + (+o.value || 0), 0)) },
          ]} />
      )}

      {/* ── Pendency dashboard ── */}
      {tab === 'pendency' && (
        <div className="space-y-3">
          {!pendency ? <p className="py-10 text-center text-sm text-slate-400">Loading pendency…</p> : allPdLines.length === 0 ? (
            <p className="rounded-xl border border-dashed bg-white py-12 text-center text-sm text-gray-400">Nothing pending — every pending order line is fully dispatched.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SubTabs active={pendencyView} onChange={setPendencyView} views={[
                  { key: 'customer', label: 'Customer-wise Pendency', count: pdRollups.by_customer.length },
                  { key: 'item', label: 'Item-wise Pendency', count: pdRollups.by_product.length },
                  { key: 'lines', label: 'Line Detail', count: pdLines.length },
                ]} />
                <ExportMenu build={() => ({
                  name: 'Sales Pendency',
                  title: 'Sales Pendency',
                  subtitle: 'Orders · What is pending, where it is, and how late',
                  summary: [
                    { label: 'Pending lines', value: fmt.num(pdLines.length) },
                    { label: 'Pending qty', value: fmt.num(pdSummary.qty) },
                    { label: 'Pending value', value: fmt.inr(pdSummary.value) },
                    { label: 'Ready ex-FG', value: fmt.num(pdSummary.ready) },
                    { label: 'On floor', value: fmt.num(pdSummary.onFloor) },
                    { label: 'Overdue lines', value: fmt.num(pdSummary.overdueLines) },
                  ],
                  sections: [
                    {
                      heading: 'Product-wise Pendency',
                      columns: [
                        { key: 'label', label: 'Product' },
                        { key: 'code', label: 'Code' },
                        { key: 'pending_qty', label: 'Pending', align: 'right', export: r => fmt.num(r.pending_qty) },
                        { key: 'fg_allocated_qty', label: 'FG Cover', align: 'right', export: r => `${fmt.num(r.fg_allocated_qty)} of ${fmt.num(r.fg_qty)}` },
                        { key: 'wip_qty', label: 'On Floor', align: 'right', export: r => fmt.num(r.wip_qty) },
                        { key: 'to_plan', label: 'To Plan', align: 'right', export: r => fmt.num(r.to_plan) },
                        { key: 'pending_value', label: 'Value', align: 'right', export: r => fmt.inr(r.pending_value) },
                        { key: 'overdue', label: 'Ageing', align: 'right', export: r => (r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`) },
                      ],
                      rows: pdRollups.by_product,
                    },
                    {
                      heading: 'Customer-wise Pendency',
                      columns: [
                        { key: 'label', label: 'Customer' },
                        { key: 'pending_qty', label: 'Pending', align: 'right', export: r => fmt.num(r.pending_qty) },
                        { key: 'pending_value', label: 'Value', align: 'right', export: r => fmt.inr(r.pending_value) },
                        { key: 'orders', label: 'Orders', align: 'right' },
                        { key: 'lines', label: 'Lines', align: 'right', export: r => `${r.lines}${r.overdue_lines > 0 ? ` (${r.overdue_lines} late)` : ''}` },
                        { key: 'overdue', label: 'Ageing', align: 'right', export: r => (r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`) },
                      ],
                      rows: pdRollups.by_customer,
                    },
                    {
                      heading: 'Line-wise Pending Detail',
                      columns: [
                        { key: 'po_number', label: 'PO' },
                        { key: 'customer_name', label: 'Customer' },
                        { key: 'product_name', label: 'Product' },
                        { key: 'qty', label: 'Ordered', align: 'right', export: l => fmt.num(l.qty) },
                        { key: 'dispatched_qty', label: 'Dispatched', align: 'right', export: l => fmt.num(l.dispatched_qty) },
                        { key: 'pending_qty', label: 'Pending', align: 'right', export: l => fmt.num(l.pending_qty) },
                        { key: 'fg_allocated_qty', label: 'FG Cover', align: 'right', export: l => `${fmt.num(l.fg_allocated_qty)} of ${fmt.num(l.fg_qty)}` },
                        { key: 'delivery_date', label: 'Delivery', export: l => `${fmt.date(l.delivery_date)}${l.overdue_days > 0 ? ` (${l.overdue_days}d overdue)` : ''}` },
                        { key: 'pending_value', label: 'Value', align: 'right', export: l => fmt.inr(l.pending_value) },
                      ],
                      rows: pdLines,
                    },
                  ],
                })} />
              </div>
              <div className="ci-form-panel">
                <div className="ci-form-panel-title">
                  <span>Pendency controls</span>
                  <span>{fmt.num(pdLines.length)} of {fmt.num(allPdLines.length)} lines visible</span>
                </div>
                <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_minmax(180px,220px)_minmax(180px,220px)_minmax(180px,220px)]">
                  <Input value={pendencyFilter.search}
                    onChange={e => setPendencyFilter(f => ({ ...f, search: e.target.value }))}
                    placeholder="Search PO, customer, product, job card..." />
                  <Select value={pendencyFilter.customer} onChange={e => setPendencyFilter(f => ({ ...f, customer: e.target.value }))}>
                    <option value="">All customers</option>
                    {pdCustomerOptions.map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
                  </Select>
                  <Select value={pendencyFilter.product} onChange={e => setPendencyFilter(f => ({ ...f, product: e.target.value }))}>
                    <option value="">All products</option>
                    {pdProductOptions.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name}</option>)}
                  </Select>
                  <Select value={pendencyFilter.status} onChange={e => setPendencyFilter(f => ({ ...f, status: e.target.value }))}>
                    <option value="">All statuses</option>
                    <option value="delayed">Delayed ({statusCounts.delayed || 0})</option>
                    <option value="ready_fg">Ready from FG ({statusCounts.ready_fg || 0})</option>
                    <option value="partial_fg">Partially Ready ({statusCounts.partial_fg || 0})</option>
                    <option value="in_production">On Floor ({statusCounts.in_production || 0})</option>
                    <option value="ready">Ready for Production ({statusCounts.ready || 0})</option>
                    <option value="planned">Planned ({statusCounts.planned || 0})</option>
                    <option value="production_required">Production Required ({statusCounts.production_required || 0})</option>
                  </Select>
                </div>
                {(pendencyFilter.search || pendencyFilter.customer || pendencyFilter.product || pendencyFilter.status) && (
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setPendencyFilter({ search: '', customer: '', product: '', status: '' })}>Clear filters</Button>
                  </div>
                )}
              </div>
              {/* The same six pendency numbers, now on the shared KpiCard the
                  rest of this module and Planning / Dispatch use, instead of a
                  bespoke tile with its own type scale. It stays HERE rather than
                  under the tabs because these totals follow the filters directly
                  above them — moving it up would divorce the number from the
                  control that changes it. "Still to Plan" gets its own card: it
                  was buried in On Floor's sub line, where the one figure that
                  says "nobody has started this" was the easiest to miss. */}
              <KpiRow cols={6}>
                <KpiCard compact icon={ClipboardList} tone="info" label="Pending Lines"
                  value={fmt.num(pdLines.length)}
                  sub={`${fmt.count(pdSummary.orders, 'order')} · ${fmt.count(pdSummary.customers, 'customer')}`} />
                <KpiCard compact icon={Banknote} tone="neutral" label="Pending Value"
                  value={fmt.inrShort(pdSummary.value)} title={fmt.inr(pdSummary.value)}
                  sub={`${fmt.num(pdSummary.qty)} of ${fmt.num(pdSummary.ordered)} pcs owed`} />
                <KpiCard compact icon={PackageCheck} tone="good" label="Ready ex-FG"
                  value={fmt.num(pdSummary.ready)}
                  sub="cartons dispatchable today"
                  onClick={() => pdKpi.toggle('ready_fg')} active={pdKpi.is('ready_fg')} />
                <KpiCard compact icon={Factory} tone="warn" label="On the Floor"
                  value={fmt.num(pdSummary.onFloor)}
                  sub="cartons already in production"
                  onClick={() => pdKpi.toggle('on_floor')} active={pdKpi.is('on_floor')} />
                <KpiCard compact icon={Boxes} tone="violet" label="Still to Plan"
                  value={fmt.num(pdSummary.toPlan)}
                  sub="cartons with no job card yet"
                  onClick={() => pdKpi.toggle('to_plan')} active={pdKpi.is('to_plan')} />
                <KpiCard compact icon={AlertTriangle} label="Overdue Lines"
                  tone={pdSummary.overdueLines ? 'bad' : 'good'}
                  value={fmt.num(pdSummary.overdueLines)}
                  sub={pdSummary.overdueLines ? `oldest ${pdSummary.maxOverdue} days late` : 'nothing past its date'}
                  onClick={() => pdKpi.toggle('overdue')} active={pdKpi.is('overdue')} />
              </KpiRow>
              {/* A card selected here narrows the three pendency views AND the
                  numbers above them — the rollups are rebuilt from the same
                  filtered lines, so a selected card never leaves a roll-up
                  totalling rows the table is no longer showing. */}
              <KpiFilterNotice filter={pdKpi} label={PENDENCY_KPI_LABEL[pdKpi.key]}
                shown={pdLines.length} total={pdUnfiltered.length} />

              {pendencyView === 'item' && (
              <div className="grid gap-4">
                <div className="ci-data-panel">
                  <div className="border-b border-[#1D1D1F]/[0.05] bg-white/30 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Product-wise pendency</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="ci-table-head">
                        <th className={th}>Product</th>
                        <th className={`${th} text-right`}>Pending</th>
                        <th className={`${th} text-right`}>FG</th>
                        <th className={`${th} text-right`}>On Floor</th>
                        <th className={`${th} text-right`}>To Plan</th>
                        <th className={`${th} text-right`}>Value</th>
                        <th className={`${th} text-right`}>Ageing</th>
                      </tr></thead>
                      <tbody>
                        {pdRollups.by_product.map(r => (
                          <tr key={r.key} className="ci-table-row cursor-pointer" title="Show this product's pending lines"
                            onClick={() => { setPendencyFilter(f => ({ ...f, product: String(r.key) })); setPendencyView('lines'); }}>
                            <td className={td}>
                              <div className="font-semibold text-slate-800">{r.label}</div>
                              <div className="text-[11px] text-slate-400">{[r.code, r.size, `${r.customers > 1 ? `${r.customers} customers · ` : ''}${r.orders} order${r.orders > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</div>
                            </td>
                            <td className={`${td} text-right font-bold tabular-nums text-amber-600`}>{fmt.num(r.pending_qty)}</td>
                            <td className={`${td} text-right tabular-nums ${r.fg_allocated_qty > 0 ? 'font-semibold text-emerald-600' : 'text-slate-400'}`}>
                              {fmt.num(r.fg_allocated_qty)}
                              {r.fg_qty > r.fg_allocated_qty && <div className="text-[10px] font-medium text-slate-400">of {fmt.num(r.fg_qty)}</div>}
                            </td>
                            <td className={`${td} text-right tabular-nums text-slate-500`}>{fmt.num(r.wip_qty)}</td>
                            <td className={`${td} text-right tabular-nums ${r.to_plan > 0 ? 'font-bold text-red-600' : 'text-slate-400'}`}>{fmt.num(r.to_plan)}</td>
                            <td className={`${td} text-right tabular-nums text-slate-500`}>{fmt.inr(r.pending_value)}</td>
                            <td className={`${td} text-right text-xs tabular-nums ${r.overdue > 0 ? 'font-bold text-red-600' : 'text-slate-500'}`}>
                              {r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              )}

              {pendencyView === 'customer' && (
              <div className="grid gap-4">
                <div className="ci-data-panel">
                  <div className="border-b border-[#1D1D1F]/[0.05] bg-white/30 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-slate-500">Customer-wise pendency</div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead><tr className="ci-table-head">
                        <th className={th}>Customer</th>
                        <th className={`${th} text-right`}>Pending</th>
                        <th className={`${th} text-right`}>FG</th>
                        <th className={`${th} text-right`}>Value</th>
                        <th className={`${th} text-right`}>Orders</th>
                        <th className={`${th} text-right`}>Lines</th>
                        <th className={`${th} text-right`}>Ageing</th>
                      </tr></thead>
                      <tbody>
                        {pdRollups.by_customer.map(r => (
                          <tr key={r.key} className="ci-table-row cursor-pointer" title="Show this customer's pending lines"
                            onClick={() => { setPendencyFilter(f => ({ ...f, customer: String(r.key) })); setPendencyView('lines'); }}>
                            <td className={td}>
                              <div className="font-semibold text-slate-800">{r.label}</div>
                              <div className="text-[11px] text-slate-400">{r.products} product{r.products > 1 ? 's' : ''}</div>
                            </td>
                            <td className={`${td} text-right font-bold tabular-nums text-amber-600`}>{fmt.num(r.pending_qty)}</td>
                            <td className={`${td} text-right tabular-nums ${r.fg_allocated_qty > 0 ? 'font-semibold text-emerald-600' : 'text-slate-400'}`}>{fmt.num(r.fg_allocated_qty)}</td>
                            <td className={`${td} text-right font-semibold tabular-nums`}>{fmt.inr(r.pending_value)}</td>
                            <td className={`${td} text-right tabular-nums text-slate-500`}>{r.orders}</td>
                            <td className={`${td} text-right tabular-nums text-slate-500`}>
                              {r.lines}{r.overdue_lines > 0 && <span className="ml-1 text-[11px] font-bold text-red-600">({r.overdue_lines} late)</span>}
                            </td>
                            <td className={`${td} text-right text-xs tabular-nums ${r.overdue > 0 ? 'font-bold text-red-600' : 'text-slate-500'}`}>
                              {r.overdue > 0 ? `${r.overdue}d overdue` : `${r.max_age}d`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              )}

              {pendencyView === 'lines' && (
              <div>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Line-wise pending detail</span>
                  <Button size="sm" variant="secondary" onClick={() => exportCsv(
                    `sales-pendency-${new Date().toISOString().slice(0, 10)}.csv`,
                    ['PO', 'Customer', 'Product', 'Code', 'Ordered', 'Dispatched', 'Pending', 'FG Cover', 'FG Total', 'Production Required', 'Status', 'Job Card', 'Stage', 'Delivery', 'Overdue (days)', 'Age (days)', 'Pending Value'],
                    pdLines.map(l => [l.po_number, l.customer_name, l.product_name, l.product_code, l.qty, l.dispatched_qty, l.pending_qty, l.fg_allocated_qty, l.fg_qty, l.production_required_qty,
                      pendencyStage(l).label, l.jc_number || '', l.current_stage || l.next_stage || '', l.delivery_date || '', l.overdue_days, l.age_days, Math.round(l.pending_value)]),
                  )}><Download size={13} /> Export CSV</Button>
                </div>
                <DataTable searchable
                  // Same rule as the order list and Planning: newest order first,
                  // so a line booked today opens at the top of the pendency detail.
                  defaultSort={{ key: 'order_id', dir: 'desc' }}
                  columns={[
                    { key: 'po_number', label: 'PO', render: l => <span className="font-semibold text-gray-900">{l.po_number}</span> },
                    { key: 'customer_name', label: 'Customer' },
                    { key: 'product_name', label: 'Product', render: l => (
                      <div>
                        <div className="font-semibold text-slate-800">{l.product_name}</div>
                        <div className="text-[11px] text-slate-400">{[l.product_code, l.size].filter(Boolean).join(' · ')}</div>
                      </div>
                    ) },
                    { key: 'qty', label: 'Ordered', align: 'right', render: l => fmt.num(l.qty) },
                    { key: 'dispatched_qty', label: 'Dispatched', align: 'right', render: l => fmt.num(l.dispatched_qty) },
                    { key: 'fulfillment', label: 'Fulfillment', sortValue: l => (l.qty > 0 ? (l.dispatched_qty / l.qty) * 100 : 0),
                      export: l => `${(l.qty > 0 ? Math.min(100, (l.dispatched_qty / l.qty) * 100) : 0).toFixed(1)}%`,
                      render: l => <FulfillmentBar pct={l.qty > 0 ? (l.dispatched_qty / l.qty) * 100 : 0} /> },
                    { key: 'pending_qty', label: 'Pending', align: 'right', render: l => <span className="font-bold text-amber-600">{fmt.num(l.pending_qty)}</span> },
                    { key: 'fg_allocated_qty', label: 'FG Cover', align: 'right', render: l => (
                      <div className={l.fg_allocated_qty > 0 ? 'font-semibold text-emerald-600' : 'text-slate-400'}>
                        {fmt.num(l.fg_allocated_qty)}
                        {l.fg_qty > l.fg_allocated_qty && <div className="text-[10px] font-medium text-slate-400">of {fmt.num(l.fg_qty)}</div>}
                      </div>
                    ) },
                    { key: 'production_required_qty', label: 'Prod. Req.', align: 'right', render: l => (
                      <span className={l.production_required_qty > 0 ? 'font-semibold text-amber-600' : 'text-slate-400'}>{fmt.num(l.production_required_qty)}</span>
                    ) },
                    { key: 'status', label: 'Status', render: l => <PendencyBadge line={l} /> },
                    { key: 'delivery_date', label: 'Delivery', render: l => (
                      <div className="text-xs">
                        {fmt.date(l.delivery_date)}
                        {l.overdue_days > 0 && <div className="font-bold text-red-600">{l.overdue_days}d overdue</div>}
                      </div>
                    ) },
                    { key: 'pending_value', label: 'Value', align: 'right', render: l => fmt.inr(l.pending_value) },
                    // A pendency row IS an order line — `line_id`, never `id`
                    // (there is no `id` on this payload at all).
                    threadColumn({ entity: 'order_line', threads: lineThreads, idOf: l => l.line_id }),
                  ]}
                  rows={pdLines} getRowId={l => l.line_id}
                  rowClass={unreadRowClass(lineThreads, l => l.line_id)}
                  onRowClick={l => openDetail({ id: l.order_id })}
                  empty="Nothing pending"
                  exportName="Line-wise Pendency"
                  exportSubtitle="Orders · Pending order lines" />
              </div>
              )}
            </>
          )}
        </div>
      )}

      {/* New order */}
      <Modal open={showNew} onClose={() => { if (!quickProduct) setShowNew(false); }} title="New Customer Order" wide
        footer={<>
          <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
          <Button onClick={save} disabled={!form.po_number || !form.customer_id || !form.lines.some(l => l.product_id && l.qty)}>Create Order</Button>
        </>}>
        <div className="space-y-4">
          <section className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span>Customer PO</span>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700">Sales intake</span>
            </div>
            <div className="ci-form-grid">
              <Field label="Customer PO Number" required><Input value={form.po_number} onChange={e => setForm({ ...form, po_number: e.target.value })} placeholder="e.g. MED/PO/2610" /></Field>
              <Field label="Customer" required
                hint={(() => {
                  const c = customers.find(x => String(x.id) === String(form.customer_id));
                  return c ? `Dispatch tolerance ±${c.tolerance_pct || 0}% — snapshotted on this order` : undefined;
                })()}>
                <Select value={form.customer_id} onChange={e => setForm({ ...form, customer_id: e.target.value, lines: [{ ...emptyLine }] })}>
                  <option value="">Select customer…</option>
                  {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}{c.tolerance_pct ? ` (±${c.tolerance_pct}%)` : ''}</option>)}
                </Select>
              </Field>
              <Field label="PO Date"><Input type="date" value={form.po_date} onChange={e => setForm({ ...form, po_date: e.target.value })} /></Field>
              <Field label="Delivery Date"><Input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} /></Field>
            </div>
          </section>

          <section className="ci-form-panel">
            <div className="ci-form-panel-title">
              <span>Order Lines</span>
              <span>{form.lines.filter(l => l.product_id && l.qty).length} ready</span>
            </div>
            <div className="space-y-2">
              {form.lines.map((l, i) => {
                const prod = products.find(p => String(p.id) === String(l.product_id));
                return (
                  <div key={i} className="ci-line-item">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_92px_100px_84px_118px_68px] md:items-start">
                      <div className="flex h-10 items-center justify-center rounded-lg bg-slate-50 text-xs font-black tabular-nums text-slate-400">
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-start gap-1.5">
                          <div className="min-w-0 flex-1">
                            <Select value={l.product_id} onChange={e => {
                              const p = products.find(x => String(x.id) === String(e.target.value));
                              setLine(i, { product_id: e.target.value, rate: p?.rate ?? '', gst: gstOf(p) });
                            }}>
                              <option value="">{form.customer_id ? 'Select product…' : 'Pick a customer first'}</option>
                              {custProducts.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name} ({p.code})</option>)}
                            </Select>
                          </div>
                          <button type="button" disabled={!form.customer_id}
                            title={form.customer_id ? 'Create a new product for this customer' : 'Pick a customer first'}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => setQuickProduct({ line: i, mode: 'new' })}>
                            <Plus size={15} />
                          </button>
                        </div>
                        <ProductSpec product={prod} />
                      </div>
                      <Input type="number" min="1" placeholder="Qty" value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} />
                      <Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} />
                      <Input type="number" step="0.01" min="0" placeholder="GST %" title="GST % — defaults from product type" value={l.gst ?? ''} onChange={e => setLine(i, { gst: e.target.value })} />
                      <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                        {l.qty && l.rate ? fmt.inr(l.qty * l.rate + lineTax(l)) : '—'}
                        {l.qty && l.rate && Number(l.gst) ? <div className="text-[10px] font-medium text-slate-400">incl. {fmt.inr(lineTax(l))} GST</div> : null}
                      </div>
                      <div className="flex h-10 items-center justify-end gap-1">
                        <button type="button" title="Clone line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600" onClick={() => cloneLine(i)}>
                          <Copy size={14} />
                        </button>
                        <button type="button" title="Delete line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500" onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }))}><Plus size={13} /> Add line</Button>
              <OrderTotals lines={form.lines} />
            </div>
          </section>

          <section className="ci-form-panel">
            <Field label="Notes"><Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></Field>
          </section>
        </div>
      </Modal>

      {/* Order detail */}
      <Modal open={!!detail} onClose={() => { if (!quickProduct) closeDetail(); }} title={detail ? `${detail.po_number} — ${detail.customer_name}` : ''} wide
        footer={detail && (editing ? <>
          <Button variant="secondary" onClick={() => { setEditing(false); setEditForm(detailToForm(detail)); }}><X size={14} /> Cancel</Button>
          <Button onClick={saveEdit} disabled={!editForm?.po_number || !editForm?.customer_id || !editForm?.lines.some(l => l.product_id && l.qty)}>
            <Save size={14} /> Save Changes
          </Button>
        </> : <>
          <Button variant="secondary" onClick={closeDetail}>Close</Button>
          {detail.status !== 'cancelled' && (
            <Button variant="danger" onClick={() => setCloseOrderModal({ reason: '' })}><Ban size={14} /> Close Order</Button>
          )}
          <Button onClick={startEdit}><Pencil size={14} /> Edit Order</Button>
        </>)}>
        {detail && !editing && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-600">
              <span>PO date: <b>{fmt.date(detail.po_date)}</b></span>
              <span>Delivery: <b>{fmt.date(detail.delivery_date)}</b></span>
              {detail.lines?.[0]?.eff_tolerance_pct > 0 && (
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-bold text-brand-700"
                  title="Dispatch tolerance snapshotted when this order was created">
                  Dispatch tolerance ±{detail.lines[0].eff_tolerance_pct}%
                </span>
              )}
              <StatusBadge status={detail.status} />
            </div>
            {detail && (() => {
              const isAdmin = auth.user?.role === 'admin';
              const s = detail.status;
              const B = ({ to, children, variant = 'secondary' }) => (
                <Button size="sm" variant={variant} onClick={() => setOrderStatus(to)}>{children}</Button>
              );
              return (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {s === 'hold' && <B to="pending" variant="primary">Resume (Pending)</B>}
                  {s === 'pending' && <B to="hold">Hold</B>}
                  {s === 'pending' && <B to="completed" variant="primary">Complete</B>}
                  {(s === 'pending' || s === 'hold') && <B to="closed">Close</B>}
                  {(s === 'pending' || s === 'hold') && <B to="cancelled" variant="danger">Cancel</B>}
                  {['completed', 'closed', 'cancelled'].includes(s) && isAdmin && <B to="pending">Reopen</B>}
                </div>
              );
            })()}
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-gray-50 text-left text-xs font-bold uppercase text-gray-500">
                <th className="px-3 py-2 w-12">#</th><th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Dispatched</th><th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">GST</th>
                <th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2">Status</th>
              </tr></thead>
              <tbody>
                {detail.lines.map((l, i) => (
                  <tr key={l.id} className="border-b border-gray-50">
                    <td className="px-3 py-2 text-xs font-black tabular-nums text-slate-300">{String(i + 1).padStart(2, '0')}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{l.product_name}</div>
                      <ProductSpec product={l} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.num(l.dispatched_qty)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">₹{l.rate}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.gst_pct}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.inr(l.qty * l.rate)}</td>
                    <td className="px-3 py-2">
                      {l.completed_at ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700"><CheckCircle2 size={12} /> Completed</span>
                      ) : (l.dispatched_qty >= l.qty && l.status !== 'cancelled') ? (
                        <button type="button" onClick={() => markLineComplete(l.id)}
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-200 px-2 py-0.5 text-[11px] font-bold text-emerald-600 transition hover:bg-emerald-50" title="Item fulfilled — mark complete">
                          <CheckCircle2 size={12} /> Mark complete
                        </button>
                      ) : <StatusBadge status={l.status} />}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-xs font-semibold text-slate-500">
                  <td colSpan={5}></td><td className="px-3 pt-2 text-right">Taxable</td>
                  <td className="px-3 pt-2 text-right tabular-nums">{fmt.inr(detail.lines.reduce((s, l) => s + l.qty * l.rate, 0))}</td><td></td>
                </tr>
                <tr className="text-xs font-semibold text-slate-500">
                  <td colSpan={5}></td><td className="px-3 text-right">GST</td>
                  <td className="px-3 text-right tabular-nums">{fmt.inr(detail.lines.reduce((s, l) => s + l.qty * l.rate * (Number(l.gst_pct) || 0) / 100, 0))}</td><td></td>
                </tr>
                <tr className="text-sm font-bold text-slate-800">
                  <td colSpan={5}></td><td className="px-3 pb-2 text-right">Total</td>
                  <td className="px-3 pb-2 text-right tabular-nums">{fmt.inr(detail.lines.reduce((s, l) => s + l.qty * l.rate * (1 + (Number(l.gst_pct) || 0) / 100), 0))}</td><td></td>
                </tr>
              </tfoot>
            </table>
            {detail.notes && <p className="mt-3 text-xs text-gray-500">Note: {detail.notes}</p>}
          </div>
        )}
        {detail && editing && editForm && (
          <div className="space-y-4">
            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Customer PO</span><span>Edit mode</span></div>
              <div className="ci-form-grid">
              <Field label="Customer PO Number" required>
                <Input value={editForm.po_number} onChange={e => setEditForm({ ...editForm, po_number: e.target.value })} />
              </Field>
              <Field label="Customer" required>
                <Select value={editForm.customer_id} onChange={e => setEditForm({ ...editForm, customer_id: e.target.value, lines: [{ ...emptyLine }] })}>
                  <option value="">Select customer…</option>
                  {customers.filter(c => c.active).map(c => <option key={c.id} value={c.id} data-search={searchText(c)}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="PO Date">
                <Input type="date" value={editForm.po_date} onChange={e => setEditForm({ ...editForm, po_date: e.target.value })} />
              </Field>
              <Field label="Delivery Date">
                <Input type="date" value={editForm.delivery_date} onChange={e => setEditForm({ ...editForm, delivery_date: e.target.value })} />
              </Field>
              </div>
            </section>

            <section className="ci-form-panel">
              <div className="ci-form-panel-title"><span>Order Lines</span><span>{editForm.lines.length} lines</span></div>
              <div className="space-y-2">
              {editForm.lines.map((l, i) => {
                const prod = products.find(p => String(p.id) === String(l.product_id));
                return (
                  <div key={l.id ?? `new-${i}`} className="ci-line-item">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[46px_minmax(0,1fr)_92px_100px_84px_118px_68px] md:items-start">
                      <div className="flex h-10 items-center justify-center rounded-lg bg-slate-50 text-xs font-black tabular-nums text-slate-400">
                        {String(i + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-start gap-1.5">
                          <div className="min-w-0 flex-1">
                            <Select value={l.product_id} onChange={e => {
                              const p = products.find(x => String(x.id) === String(e.target.value));
                              setEditLine(i, { product_id: e.target.value, rate: p?.rate ?? '', gst: gstOf(p) });
                            }}>
                              <option value="">{editForm.customer_id ? 'Select product…' : 'Pick a customer first'}</option>
                              {editProducts.map(p => <option key={p.id} value={p.id} data-search={searchText(p)}>{p.name} ({p.code})</option>)}
                            </Select>
                          </div>
                          <button type="button" disabled={!editForm.customer_id}
                            title={editForm.customer_id ? 'Create a new product for this customer' : 'Pick a customer first'}
                            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-300 text-slate-400 transition-colors hover:border-brand-400 hover:bg-brand-50 hover:text-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => setQuickProduct({ line: i, mode: 'edit' })}>
                            <Plus size={15} />
                          </button>
                        </div>
                        <ProductSpec product={prod} />
                      </div>
                      <Input type="number" min={Math.max(1, l.dispatched_qty || 0)} placeholder="Qty" value={l.qty} onChange={e => setEditLine(i, { qty: e.target.value })} />
                      <Input type="number" step="0.01" placeholder="Rate ₹" value={l.rate} onChange={e => setEditLine(i, { rate: e.target.value })} />
                      <Input type="number" step="0.01" min="0" placeholder="GST %" title="GST % — defaults from product type" value={l.gst ?? ''} onChange={e => setEditLine(i, { gst: e.target.value })} />
                      <div className="rounded-lg bg-slate-50 px-3 py-2 text-right text-xs font-bold tabular-nums text-slate-600">
                        {l.qty && l.rate ? fmt.inr(l.qty * l.rate + lineTax(l)) : '—'}
                        {l.status && <div className="mt-1"><StatusBadge status={l.status} /></div>}
                      </div>
                      <div className="flex h-10 items-center justify-end gap-1">
                        <button type="button" title="Clone line" className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-blue-600" onClick={() => cloneEditLine(i)}>
                          <Copy size={14} />
                        </button>
                        <button
                          type="button"
                          title="Delete line"
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-300"
                          disabled={editForm.lines.length === 1}
                          onClick={() => setEditForm(f => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
              <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={() => setEditForm(f => ({ ...f, lines: [...f.lines, { ...emptyLine }] }))}>
                <Plus size={13} /> Add line
              </Button>
              </div>
            </section>

            <section className="ci-form-panel">
              <Field label="Notes"><Textarea value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} /></Field>
            </section>
          </div>
        )}
      </Modal>

      {/* ── Close / cancel a whole order ── */}
      <Modal open={!!closeOrderModal} onClose={() => setCloseOrderModal(null)} title={detail ? `Close ${detail.po_number}?` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setCloseOrderModal(null)}>Keep Open</Button>
          <Button variant="danger" onClick={cancelOrder}><Ban size={14} /> Close Order</Button>
        </>}>
        {closeOrderModal && detail && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Closing moves <b>{detail.po_number}</b> to the <b>Closed</b> tab and cancels any items not yet dispatched.
              Already-dispatched items are left untouched. This does not delete invoices or challans.
            </p>
            <Field label="Reason (optional)">
              <Textarea value={closeOrderModal.reason} onChange={e => setCloseOrderModal({ reason: e.target.value })}
                placeholder="e.g. customer cancelled the balance, order superseded" />
            </Field>
          </div>
        )}
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete ${deleteTarget.po_number}?` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={runDeleteOrder}
            disabled={delBusy || !delPreview || delPreview.hard_blockers.length > 0 || (delPreview.force_required && !delConfirm)}>
            <Trash2 size={14} />
            {delBusy ? 'Deleting…' : delPreview?.force_required ? 'Reverse & Delete Everything' : 'Delete Order'}
          </Button>
        </>}>
        {deleteTarget && (
          <div className="space-y-3">
            {!delPreview ? (
              <p className="text-sm text-slate-500">Checking everywhere this order has travelled…</p>
            ) : delPreview.hard_blockers.length > 0 ? (
              <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                <b>Can’t delete:</b>
                <ul className="mt-1 list-disc pl-5">{delPreview.hard_blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
              </div>
            ) : (
              <>
                {delPreview.force_required && (
                  <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <b className="flex items-center gap-1.5"><AlertTriangle size={14} /> Will be reversed automatically first:</b>
                    <ul className="mt-1 list-disc pl-5">{delPreview.reversals.map((b, i) => <li key={i}>{b}</li>)}</ul>
                  </div>
                )}
                <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
                  <b>Then permanently deleted:</b>
                  <ul className="mt-1 list-disc pl-5">{delPreview.deletes.map((b, i) => <li key={i}>{b}</li>)}</ul>
                </div>
                <p className="text-xs text-slate-500">
                  A backup file of every removed record is saved on the server before anything is touched.
                  This cannot be undone from the app.
                </p>
                {delPreview.force_required && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700">
                    <input type="checkbox" className="mt-0.5 accent-red-600" checked={delConfirm}
                      onChange={e => setDelConfirm(e.target.checked)} />
                    Yes, I’m sure — reverse the running production and delete this order everywhere it has travelled.
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </Modal>

      <ImportPOWizard open={showImport} onClose={() => setShowImport(false)}
        customers={customers} products={products} gstRates={gstRates}
        onCreated={() => { load(); api.get('/products').then(setProducts); }} />

      {/* Quick-create product — stacks above whichever order modal opened it */}
      <ProductQuickCreate open={!!quickProduct} onClose={() => setQuickProduct(null)}
        customerId={quickCustomerId}
        customerName={customers.find(c => String(c.id) === String(quickCustomerId))?.name}
        suggestedCode={quickCustomerId ? nextCodeForRows({
          rows: products, customerId: quickCustomerId,
          customerName: customers.find(c => String(c.id) === String(quickCustomerId))?.name,
        }) : ''}
        onCreated={handleProductCreated} />
    </div>
  );
}
