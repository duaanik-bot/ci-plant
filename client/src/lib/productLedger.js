// Status Sheet › Product ledger — one product's life as dated entries.
//
// Pure (tested in server/src/status-report.test.js). Built only from records
// the ERP already keeps — nothing here is stored:
//   PO received   an order line (order_lines)                 + to order book
//   Cancelled     a cancelled line, at its PO date            − what was not sent
//   Produced      a job card closed with output (job_cards)     made, for the record
//   Dispatched    a challan line (dispatch_lines)              − from order book
//   Closed short  a line marked dispatched below its qty        − the gap
//   Sent over     the part of a challan beyond what its line still owed —
//                 recorded, but it never takes "owed" below zero (the
//                 customer received extra; they are not owed less than nothing)
//   Stock in/out  leftover finished goods (fg_movements)       ± stock
//
// Two running balances:
//   order_balance — still owed to the customer. It ends at the sum of the
//                   lines' pending qty, the same number the report shows.
//   stock_balance — leftover cartons on the shelf, from fg_movements.

import { OPEN_KEYS } from './statusReport.js';

const n = v => (Number.isFinite(+v) ? +v : 0);
const day = d => (d ? String(d) : '');

export const LEDGER_KIND = {
  po: 'PO received',
  cancelled: 'Line cancelled',
  produced: 'Produced',
  dispatch: 'Dispatched',
  short: 'Closed short',
  over: 'Sent over the order',
  stock: 'Stock',
};

const FG_LABEL = {
  excess_stock: 'Leftover added to stock',
  opening_stock: 'Opening stock',
  manual_adjustment: 'Stock adjusted',
  stock_consumption: 'Stock used for an order',
};
export const fgLabel = t => FG_LABEL[t] || String(t || 'Stock movement').replace(/_/g, ' ');

// Same-day order: the PO lands before anything made or sent against it, and a
// line is closed short only after its last dispatch.
const RANK = { po: 0, cancelled: 1, produced: 2, stock: 3, dispatch: 4, short: 5 };

export function buildProductLedger({ lines = [], dispatches = [], jobCards = [], fgMoves = [] } = {}) {
  const e = [];
  const lineIds = new Set(lines.map(l => String(l.line_id)));
  for (const l of lines) {
    const base = { line_id: l.line_id, order_id: l.order_id, po_number: l.po_number };
    e.push({ ...base, kind: 'po', date: day(l.po_date), ordered: n(l.qty), note: l.line_remark || l.remarks || '' });
    if (l.delivery === 'cancelled') {
      const left = Math.max(0, n(l.qty) - n(l.dispatched_qty));
      if (left) e.push({ ...base, kind: 'cancelled', date: day(l.po_date), ordered: -left });
    } else if (n(l.short_qty) > 0) {
      e.push({ ...base, kind: 'short', date: day(l.last_dispatched_at || l.po_date), ordered: -n(l.short_qty) });
    }
  }
  const poOf = new Map(lines.map(l => [String(l.line_id), l.po_number]));
  for (const d of dispatches) {
    if (!lineIds.has(String(d.line_id))) continue;
    e.push({
      kind: 'dispatch', date: day(d.dispatched_at), line_id: d.line_id, po_number: poOf.get(String(d.line_id)), dispatched: n(d.qty),
      dispatch_id: d.dispatch_id, challan_number: d.challan_number,
      invoice_id: d.invoice_id, invoice_number: d.invoice_number,
    });
  }
  // Only the line's OWN closed card counts as output: a gang parent's sheets
  // are shared by several products, and its cartons are counted on each
  // member's own card after the split.
  const seen = new Set();
  for (const c of jobCards) {
    if (c.gang_shared || seen.has(c.id) || !lineIds.has(String(c.line_id))) continue;
    if (!(n(c.qty_produced) > 0) || !c.closed_at) continue;
    seen.add(c.id);
    e.push({ kind: 'produced', date: day(c.closed_at), line_id: c.line_id, produced: n(c.qty_produced), job_card_id: c.id, jc_number: c.jc_number });
  }
  for (const m of fgMoves) {
    e.push({
      kind: 'stock', date: day(m.created_at), stock_in: n(m.qty_in), stock_out: n(m.qty_out),
      label: fgLabel(m.movement_type), ref_number: m.ref_number, po_number: m.po_number, note: m.remarks || '',
    });
  }
  e.sort((a, b) => a.date.slice(0, 10).localeCompare(b.date.slice(0, 10))
    || RANK[a.kind] - RANK[b.kind]
    || a.date.localeCompare(b.date));
  // Running balances. A dispatch reduces "owed" only by what its own line still
  // owed at that moment; anything beyond is split out as a "Sent over" entry.
  const owedByLine = new Map();
  let order = 0;
  let stock = 0;
  const out = [];
  for (const x of e) {
    const k = x.line_id != null ? String(x.line_id) : null;
    let take = n(x.ordered);
    let extra = 0;
    if (x.kind === 'dispatch') {
      const left = Math.max(0, k ? (owedByLine.get(k) || 0) : 0);
      const sent = n(x.dispatched);
      const counted = Math.min(sent, left);
      extra = sent - counted;
      take = -counted;
    }
    if (k) owedByLine.set(k, (owedByLine.get(k) || 0) + take);
    order += take;
    stock += n(x.stock_in) - n(x.stock_out);
    out.push({ ...x, label: x.label || LEDGER_KIND[x.kind], order_balance: order, stock_balance: stock });
    if (extra > 0) {
      out.push({ kind: 'over', date: x.date, line_id: x.line_id, po_number: x.po_number, dispatch_id: x.dispatch_id,
        challan_number: x.challan_number, extra, label: LEDGER_KIND.over, order_balance: order, stock_balance: stock });
    }
  }
  return out;
}

// The product list row: a master product joined to its order lines. Lines are
// the enriched lines from the report; products with no lines still appear —
// tracking a product includes knowing it was never ordered.
export function productRows(products = [], lines = []) {
  const byProduct = new Map();
  for (const l of lines) {
    const k = String(l.product_id);
    if (!byProduct.has(k)) byProduct.set(k, []);
    byProduct.get(k).push(l);
  }
  return products.map(p => {
    const ls = byProduct.get(String(p.product_id)) || [];
    const live = ls.filter(l => l.delivery !== 'cancelled');
    const open = ls.filter(l => OPEN_KEYS.includes(l.delivery));
    const where_counts = {};
    for (const l of open) where_counts[l.where] = (where_counts[l.where] || 0) + 1;
    const lastPo = ls.reduce((m, l) => (day(l.po_date) > m ? day(l.po_date) : m), '');
    const lastDisp = ls.reduce((m, l) => (day(l.last_dispatched_at) > m ? day(l.last_dispatched_at) : m), '');
    const ordered = live.reduce((s, l) => s + n(l.qty), 0);
    const delivered = live.reduce((s, l) => s + n(l.dispatched_qty), 0);
    const pending = ls.reduce((s, l) => s + n(l.pending_qty), 0);
    return {
      ...p,
      id: `p${p.product_id}`,
      orders: new Set(ls.map(l => l.order_id)).size,
      lines: ls.length,
      open_lines: open.length,
      qty: ordered,
      dispatched_qty: delivered,
      pending_qty: pending,
      pending_value: ls.reduce((s, l) => s + n(l.pending_value), 0),
      where_counts,
      last_po_date: lastPo || null,
      last_dispatched_at: lastDisp || null,
      // One word for the product's order state, for the filter chips.
      track: !ls.length ? 'never' : open.length ? 'pending' : 'delivered',
      stock_qty: n(p.stock_qty),
    };
  });
}

export const TRACK = [
  { key: 'pending', label: 'Pending orders', tone: 'border-amber-200 bg-amber-50 text-amber-700' },
  { key: 'delivered', label: 'All delivered', tone: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  { key: 'never', label: 'Never ordered', tone: 'border-slate-200 bg-slate-100 text-slate-600' },
];
