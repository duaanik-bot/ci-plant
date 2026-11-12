// Status Sheet › Reports — the roll-up behind the Reports tab.
//
// Pure on purpose (like wipExport.js): the page supplies lines from
// GET /status-sheet/report, and every decision — which bucket a line is in,
// what "pending" means, how lines fold into a company / PO / product row, and
// what the workbook looks like — lives here so node --test can hold it.
//
// Delivery buckets, one per line, a cascade so a line is never in two:
//   cancelled  — the line was cancelled. Counts nowhere in qty or value.
//   delivered  — fully dispatched, OR marked dispatched below its qty (closed
//                short / inside tolerance). Owes nothing; the gap is `short_qty`.
//   part       — something has gone, more is still owed.
//   pending    — nothing dispatched yet.
// Pending qty is only ever owed on `part` and `pending` lines.
//
// "Where it is" (`where`), one key per line:
//   cancelled / delivered — the delivery bucket says it all, the line is off
//                the floor.
//   otherwise  — lib/lineStage.js lineStageOf(): unplanned · planned · queued ·
//                a plant stage (printing, die_cutting, …) · done (produced,
//                waiting to go out). The SAME function the live sheet's
//                "Where it is" rail uses, so the two tabs never disagree.
import { lineStageOf } from './lineStage.js';

export const DELIVERY = [
  { key: 'pending', label: 'Pending', tone: 'border-amber-200 bg-amber-50 text-amber-700' },
  { key: 'part', label: 'Part delivered', tone: 'border-blue-200 bg-blue-50 text-blue-700' },
  { key: 'delivered', label: 'Delivered', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  { key: 'cancelled', label: 'Cancelled', tone: 'border-slate-200 bg-slate-100 text-slate-600' },
];
export const DELIVERY_LABEL = Object.fromEntries(DELIVERY.map(d => [d.key, d.label]));
// The book a planner means by "open": owed in full or in part.
export const OPEN_KEYS = ['pending', 'part'];

// The keys `where` can take that are not plant stages, in the order they are
// shown: before the floor, then (plant stages go between), then after it.
export const WHERE_BEFORE = ['unplanned', 'planned', 'queued'];
export const WHERE_AFTER = ['done', 'delivered', 'cancelled'];
export const WHERE_LABEL = {
  unplanned: 'Not planned', planned: 'Planned', queued: 'Job card raised',
  done: 'Produced — to dispatch', delivered: 'Delivered', cancelled: 'Cancelled',
};

export function whereOf(line, delivery = deliveryOf(line)) {
  if (delivery === 'cancelled' || delivery === 'delivered') return delivery;
  return lineStageOf(line).key;
}

// Every `where` key in display order: before → plant stages → anything else
// seen in the data → after. `stageOrder` is the plant's own list (SECTION_ORDER),
// passed in so this file stays free of React/lucide imports.
export function whereOrder(stageOrder = [], seen = []) {
  const known = new Set([...WHERE_BEFORE, ...stageOrder, ...WHERE_AFTER]);
  const extra = seen.filter(k => !known.has(k));
  return [...WHERE_BEFORE, ...stageOrder, ...extra, ...WHERE_AFTER];
}

// A group's stage mix as [{key, count}] in display order — what the Stage
// column shows for a PO, a product or a company.
export function whereMix(counts, stageOrder = []) {
  const keys = Object.keys(counts || {});
  return whereOrder(stageOrder, keys).filter(k => counts[k]).map(k => ({ key: k, count: counts[k] }));
}

// The report views — the "what kind of report" setting.
export const VIEWS = [
  { key: 'company', label: 'Company-wise' },
  { key: 'po', label: 'PO-wise' },
  { key: 'product', label: 'Product-wise' },
  { key: 'lines', label: 'Line detail' },
];

const n = v => (Number.isFinite(+v) ? +v : 0);

export function deliveryOf(line) {
  const qty = n(line.qty);
  const disp = n(line.dispatched_qty);
  if (line.status === 'cancelled') return 'cancelled';
  if (line.status === 'dispatched' || (qty > 0 && disp >= qty)) return 'delivered';
  if (disp > 0) return 'part';
  return 'pending';
}

// Adds the derived facts every view reads. Never mutates the input.
export function enrichLine(line) {
  const delivery = deliveryOf(line);
  const qty = n(line.qty);
  const disp = n(line.dispatched_qty);
  const rate = n(line.rate);
  const live = delivery !== 'cancelled';
  const pending_qty = OPEN_KEYS.includes(delivery) ? Math.max(0, qty - disp) : 0;
  const short_qty = delivery === 'delivered' ? Math.max(0, qty - disp) : 0;
  return {
    ...line,
    delivery,
    where: whereOf(line, delivery),
    pending_qty,
    short_qty,
    value: live ? qty * rate : 0,
    delivered_value: live ? disp * rate : 0,
    pending_value: pending_qty * rate,
  };
}

// po_date is a plain 'YYYY-MM-DD' text column, so string compare is a date compare.
const dayStr = d => (d ? String(d).slice(0, 10) : '');

export function filterLines(lines, { customers = [], delivery = [], stages = [], from = '', to = '' } = {}) {
  const cust = new Set(customers.map(String));
  const del = new Set(delivery);
  const wh = new Set(stages);
  return lines.filter(l => {
    if (cust.size && !cust.has(String(l.customer_id))) return false;
    if (del.size && !del.has(l.delivery)) return false;
    if (wh.size && !wh.has(l.where)) return false;
    const d = dayStr(l.po_date);
    if (from && (!d || d < from)) return false;
    if (to && (!d || d > to)) return false;
    return true;
  });
}

function blankTotals() {
  return {
    lines: 0, qty: 0, dispatched_qty: 0, pending_qty: 0, short_qty: 0,
    value: 0, delivered_value: 0, pending_value: 0,
    pending: 0, part: 0, delivered: 0, cancelled: 0,
    oldest_open_po: '', last_dispatched_at: '',
    where_counts: {},
  };
}
function addLine(t, l) {
  t.lines += 1;
  t[l.delivery] += 1;
  if (l.where) t.where_counts[l.where] = (t.where_counts[l.where] || 0) + 1;
  if (l.delivery !== 'cancelled') {
    t.qty += n(l.qty);
    t.dispatched_qty += n(l.dispatched_qty);
  }
  t.pending_qty += l.pending_qty;
  t.short_qty += l.short_qty;
  t.value += l.value;
  t.delivered_value += l.delivered_value;
  t.pending_value += l.pending_value;
  const d = dayStr(l.po_date);
  if (OPEN_KEYS.includes(l.delivery) && d && (!t.oldest_open_po || d < t.oldest_open_po)) t.oldest_open_po = d;
  const ld = l.last_dispatched_at ? String(l.last_dispatched_at) : '';
  if (ld && ld > t.last_dispatched_at) t.last_dispatched_at = ld;
  return t;
}
function finish(t) {
  t.open_lines = t.pending + t.part;
  t.fulfil_pct = t.qty > 0 ? Math.round((t.dispatched_qty / t.qty) * 100) : 0;
  t.oldest_open_po = t.oldest_open_po || null;
  t.last_dispatched_at = t.last_dispatched_at || null;
  return t;
}

export function totalsOf(lines) {
  const t = blankTotals();
  const orders = new Set();
  const customers = new Set();
  for (const l of lines) { addLine(t, l); orders.add(l.order_id); customers.add(l.customer_id); }
  t.orders = orders.size;
  t.customers = customers.size;
  return finish(t);
}

// The overall state of a group of lines, for a PO or product row.
export function groupDelivery(t) {
  if (t.lines && t.cancelled === t.lines) return 'cancelled';
  if (t.pending + t.part === 0) return 'delivered';
  if (t.part > 0 || t.delivered > 0) return 'part';
  return 'pending';
}

const KEYERS = {
  company: l => `c${l.customer_id}`,
  po: l => `o${l.order_id}`,
  product: l => `c${l.customer_id}-p${l.product_id}`,
};

// Folds lines into the rows a view shows. 'lines' is the identity view.
export function groupLines(lines, view) {
  if (view === 'lines') return lines.map(l => ({ ...l, id: `l${l.line_id}` }));
  const keyOf = KEYERS[view] || KEYERS.company;
  const map = new Map();
  for (const l of lines) {
    const k = keyOf(l);
    let g = map.get(k);
    if (!g) {
      g = {
        id: k, customer_id: l.customer_id, customer_name: l.customer_name,
        ...(view === 'po' ? { order_id: l.order_id, po_number: l.po_number, po_date: l.po_date, delivery_date: l.delivery_date } : {}),
        ...(view === 'product' ? {
          product_id: l.product_id, product_name: l.product_name, product_code: l.product_code,
          party_item_code: l.party_item_code, party_artwork_code: l.party_artwork_code,
        } : {}),
        _orders: new Set(), _t: blankTotals(),
      };
      map.set(k, g);
    }
    g._orders.add(l.order_id);
    addLine(g._t, l);
  }
  return [...map.values()].map(({ _orders, _t, ...g }) => {
    const t = finish(_t);
    return { ...g, ...t, orders: _orders.size, delivery: groupDelivery(t) };
  });
}

// Excel/PDF spec. With more than one company in view, the PO, product and line
// views become one section per company with its own totals — the same
// customer-per-section rule the live sheet's workbook keeps (wipExport.js), so
// a page can be sent to one customer without carrying another's jobs.
export function buildReportExportSpec({ view, rows, columns, title, subtitle, meta = [], totals }) {
  const viewLabel = (VIEWS.find(v => v.key === view) || VIEWS[0]).label;
  const name = `${title} — ${viewLabel}`;
  const summary = summaryOf(totals || sumRows(rows, view));
  const base = { name, title: name, subtitle, meta: meta.filter(Boolean) };
  const companies = [...new Set(rows.map(r => r.customer_name))];
  if (view === 'company' || companies.length < 2) {
    return { ...base, columns, rows, summary };
  }
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.customer_name)) byCompany.set(r.customer_name, []);
    byCompany.get(r.customer_name).push(r);
  }
  const sections = [...byCompany.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([company, rs]) => ({
      heading: company,
      columns: columns.filter(c => c.key !== 'customer_name'),
      rows: rs,
      summary: summaryOf(sumRows(rs, view)),
    }));
  return { ...base, summary, sections };
}

// Totals over already-grouped rows (or raw lines in the line view).
export function sumRows(rows, view) {
  if (view === 'lines') return totalsOf(rows);
  const t = { ...blankTotals(), orders: 0 };
  const orderIds = new Set();
  for (const r of rows) {
    for (const k of ['lines', 'qty', 'dispatched_qty', 'pending_qty', 'short_qty', 'value', 'delivered_value', 'pending_value', 'pending', 'part', 'delivered', 'cancelled']) t[k] += n(r[k]);
    if (view === 'po') orderIds.add(r.order_id); else t.orders += n(r.orders);
  }
  if (view === 'po') t.orders = orderIds.size;
  // One PO carries many products, so per-product order counts do not add up to
  // an order count — say nothing rather than a wrong number.
  if (view === 'product') t.orders = null;
  return finish(t);
}

const num = v => Math.round(n(v)).toLocaleString('en-IN');
export function summaryOf(t) {
  if (!t) return [];
  return [
    t.orders == null ? null : { label: 'Orders', value: num(t.orders) },
    { label: 'Lines', value: num(t.lines) },
    { label: 'Ordered qty', value: num(t.qty) },
    { label: 'Delivered qty', value: num(t.dispatched_qty) },
    { label: 'Pending qty', value: num(t.pending_qty) },
    { label: 'Pending value (₹, ex-GST)', value: num(t.pending_value) },
  ].filter(Boolean);
}

// ── Drawer ──────────────────────────────────────────────────────────────────
// What a click opens. `ctx` is { kind: 'company' | 'po' | 'product' | 'line', … }
// built from a row by drawerCtx(). The drawer always shows the WHOLE history
// of what was clicked — every line, owed or delivered — not just the slice the
// report's filters happen to show, because "details of this PO" means all of it.
export function drawerCtx(kind, row) {
  if (kind === 'company') return { kind, customer_id: row.customer_id, customer_name: row.customer_name };
  if (kind === 'po') return { kind, order_id: row.order_id, po_number: row.po_number, customer_name: row.customer_name };
  if (kind === 'product') return { kind, customer_id: row.customer_id, product_id: row.product_id, product_name: row.product_name, customer_name: row.customer_name };
  return { kind: 'line', line_id: row.line_id, product_name: row.product_name, po_number: row.po_number, customer_name: row.customer_name };
}

export function scopeLines(lines, ctx) {
  if (!ctx) return [];
  const eq = (a, b) => String(a) === String(b);
  if (ctx.kind === 'company') return lines.filter(l => eq(l.customer_id, ctx.customer_id));
  if (ctx.kind === 'po') return lines.filter(l => eq(l.order_id, ctx.order_id));
  if (ctx.kind === 'product') return lines.filter(l => eq(l.customer_id, ctx.customer_id) && eq(l.product_id, ctx.product_id));
  return lines.filter(l => eq(l.line_id, ctx.line_id));
}

// Challans as the drawer lists them: one row per challan, its lines' qty added
// up, products named, newest first. A challan carrying three of a PO's cartons
// is ONE delivery, not three.
export function groupDispatches(dispatches, lineById = new Map()) {
  const by = new Map();
  for (const d of dispatches || []) {
    let g = by.get(d.dispatch_id);
    if (!g) {
      g = {
        dispatch_id: d.dispatch_id, challan_number: d.challan_number, dispatched_at: d.dispatched_at,
        vehicle: d.vehicle, qty: 0, items: [], invoices: new Map(),
      };
      by.set(d.dispatch_id, g);
    }
    g.qty += n(d.qty);
    const l = lineById.get(d.line_id) || lineById.get(String(d.line_id));
    g.items.push({ line_id: d.line_id, qty: n(d.qty), product_name: l?.product_name, po_number: l?.po_number });
    if (d.invoice_id) g.invoices.set(d.invoice_id, { id: d.invoice_id, number: d.invoice_number, date: d.invoice_date });
  }
  return [...by.values()]
    .map(g => ({ ...g, invoices: [...g.invoices.values()] }))
    .sort((a, b) => String(b.dispatched_at || '').localeCompare(String(a.dispatched_at || '')) || n(b.dispatch_id) - n(a.dispatch_id));
}
