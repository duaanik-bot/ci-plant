// Draft sales orders and draft product masters (owner's request, 6 Oct 2026).
//
// The AVS order intake reads each new customer PO from the company mailbox and
// keys it into the ERP: the order and its lines with status 'draft', and — for
// an item we have never made — a new product master with is_draft = 1, mapped
// to its artwork in avs.artwork_codes. A draft shows everywhere orders are read
// (Sales Orders, Sales Pendency, the Status Sheet) in orange, but it is not
// demand: Planning, board, floor and dashboards only read the statuses they
// name, and 'draft' is none of them. A person checks the draft against the PO
// and presses Confirm order; only then do its lines become 'pending' and reach
// Planning (supabase/migrations/20261006180000_sales_order_drafts.sql).
//
//   GET  /api/drafts/summary          counts for the Drafts chip and the nav badge
//   GET  /api/drafts                  draft orders (with lines, new masters and
//                                     their artwork mapping) and draft masters
//   POST /api/orders/:id/confirm      draft → pending: lines to Planning, the
//                                     order's draft masters confirmed with it
//   POST /api/products/:id/confirm-draft   one draft master confirmed alone
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus } from '../helpers.js';
import { requireRole } from '../auth.js';
import { markUncacheable } from '../data-tables.js';

const r = Router();
const canPlan = requireRole('planner'); // admin implied — the same people who key orders
const MISSING = new Set(['42P01', '3F000']); // the avs schema exists only on production
const fail = (status, message) => Object.assign(new Error(message), { status });
const note = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);

// What the intake mapped for these products (avs.artwork_codes). Empty where
// the avs schema does not exist (a local database).
async function artworkFor(productIds) {
  if (!productIds.length) return new Map();
  try {
    const rows = await q(`
      SELECT product_id, item_code, rev, artwork_code, output_number, status, note,
             master_pdf_id, approved_file_id, updated_at
        FROM avs.artwork_codes WHERE product_id = ANY($1::int[])
       ORDER BY updated_at DESC NULLS LAST`, [productIds]);
    const out = new Map();
    for (const a of rows) if (!out.has(a.product_id)) out.set(a.product_id, a);
    return out;
  } catch (e) {
    if (MISSING.has(e.code)) return new Map();
    throw e;
  }
}

// Open intake flags on these orders (avs.order_flags), same fallback.
async function flagsFor(orderIds) {
  if (!orderIds.length) return [];
  try {
    return await q(`
      SELECT id, order_id, order_line_id, kind, result, text, source, raised_at
        FROM avs.order_flags WHERE order_id = ANY($1::int[]) AND cleared_at IS NULL
       ORDER BY raised_at DESC`, [orderIds]);
  } catch (e) {
    if (MISSING.has(e.code)) return [];
    throw e;
  }
}

// Artwork mappings still to confirm on draft work: an artwork_codes row in
// 'to_confirm' for a draft master or for a product on a draft order.
async function artworksToConfirm() {
  try {
    const row = await one(`
      SELECT COUNT(DISTINCT ac.product_id)::int AS n
        FROM avs.artwork_codes ac
        JOIN products p ON p.id = ac.product_id
       WHERE ac.status = 'to_confirm'
         AND (p.is_draft = 1 OR EXISTS (
               SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id
                WHERE ol.product_id = p.id AND o.status = 'draft'))`);
    return row?.n || 0;
  } catch (e) {
    if (MISSING.has(e.code)) return 0;
    throw e;
  }
}

export async function draftSummary() {
  const c = await one(`
    SELECT (SELECT COUNT(*)::int FROM orders WHERE status = 'draft') AS orders,
           (SELECT COUNT(*)::int FROM order_lines ol JOIN orders o ON o.id = ol.order_id
             WHERE o.status = 'draft' AND ol.part_of_line_id IS NULL) AS lines,
           (SELECT COUNT(*)::int FROM products WHERE is_draft = 1) AS products`);
  const artworks = await artworksToConfirm();
  return { ...c, artworks, total: c.orders + c.products };
}

r.get('/drafts/summary', async (_req, res, next) => {
  try {
    markUncacheable();
    res.json(await draftSummary());
  } catch (e) { next(e); }
});

r.get('/drafts', async (_req, res, next) => {
  try {
    markUncacheable();
    const orders = await q(`
      SELECT o.id, o.po_number, o.po_date, o.delivery_date, o.status, o.notes, o.created_at,
             o.draft_source, o.draft_note, o.customer_id, c.name AS customer_name
        FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status = 'draft'
       ORDER BY o.id DESC`);
    const orderIds = orders.map(o => o.id);
    const lines = orderIds.length ? await q(`
      SELECT ol.id, ol.order_id, ol.product_id, ol.qty, ol.rate, ol.status, ol.line_remark,
             p.name AS product_name, p.code AS product_code, p.party_item_code,
             p.party_artwork_code, p.output_number, p.size, p.is_draft AS product_is_draft,
             p.board_material_id, p.spec_incomplete
        FROM order_lines ol JOIN products p ON p.id = ol.product_id
       WHERE ol.order_id = ANY($1::int[]) AND ol.part_of_line_id IS NULL
       ORDER BY ol.order_id, ol.id`, [orderIds]) : [];
    // LEFT JOINs: a master the intake made without a customer's board or with
    // no board yet must still show here, or nobody would ever confirm it.
    const products = await q(`
      SELECT p.id, p.name, p.code, p.customer_id, c.name AS customer_name, p.size,
             p.party_item_code, p.party_artwork_code, p.output_number, p.board_material_id,
             m.name AS board_material_name, p.gsm, p.spec_incomplete, p.draft_source, p.draft_note,
             p.drafted_at,
             (SELECT string_agg(DISTINCT o.po_number, ', ')
                FROM order_lines ol JOIN orders o ON o.id = ol.order_id
               WHERE ol.product_id = p.id AND o.status = 'draft') AS draft_pos
        FROM products p
        LEFT JOIN customers c ON c.id = p.customer_id
        LEFT JOIN materials m ON m.id = p.board_material_id
       WHERE p.is_draft = 1
       ORDER BY p.drafted_at DESC NULLS LAST, p.id DESC`);
    const productIds = [...new Set([...lines.map(l => l.product_id), ...products.map(p => p.id)])];
    const art = await artworkFor(productIds);
    const flags = await flagsFor(orderIds);
    for (const l of lines) l.artwork = art.get(l.product_id) || null;
    for (const p of products) p.artwork = art.get(p.id) || null;
    for (const o of orders) {
      o.lines = lines.filter(l => l.order_id === o.id);
      o.flags = flags.filter(f => f.order_id === o.id);
      o.value = o.lines.reduce((s, l) => s + (+l.qty || 0) * (+l.rate || 0), 0);
      o.new_products = o.lines.filter(l => l.product_is_draft).length;
    }
    res.json({ orders, products, summary: await draftSummary() });
  } catch (e) { next(e); }
});

// Draft → pending. Every line of the order (a carton's hidden part lines
// included) becomes demand, and every draft master on it is confirmed with it:
// an order Planning can see must never stand on a master nobody has checked.
export async function confirmDraftOrder(orderId, qc, oc, user, why = null) {
  const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!o) throw fail(404, 'Order not found');
  if (o.status !== 'draft') throw fail(409, `This order is already ${o.status} — only a draft is confirmed`);
  const lines = await qc(`SELECT id FROM order_lines WHERE order_id=$1 AND status='draft' ORDER BY id`, [orderId]);
  const live = await oc(`SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status <> 'cancelled'`, [orderId]);
  if (!live?.n) throw fail(409, 'This draft has no lines — add at least one line before confirming it');
  for (const l of lines) await setLineStatus(l.id, 'pending', qc, oc, user);
  const products = await qc(`
    UPDATE products SET is_draft = 0, confirmed_at = now(), confirmed_by = $2
     WHERE is_draft = 1 AND id IN (SELECT product_id FROM order_lines WHERE order_id = $1)
    RETURNING id, code, name`, [orderId, user]);
  await qc(`UPDATE orders SET status='pending', confirmed_at=now(), confirmed_by=$2 WHERE id=$1`, [orderId, user]);
  await audit('order', orderId, 'status:draft→pending', why ? `Draft confirmed: ${why}` : 'Draft confirmed', qc, user);
  for (const p of products) await audit('product', p.id, 'draft_confirmed', `With order ${o.po_number}`, qc, user);
  return { order_id: orderId, po_number: o.po_number, lines: lines.length, products };
}

r.post('/orders/:id/confirm', canPlan, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw fail(400, 'Bad order id');
    const out = await tx((qc, oc) => confirmDraftOrder(id, qc, oc, req.user.name, note(req.body?.note)));
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/products/:id/confirm-draft', canPlan, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw fail(400, 'Bad product id');
    const out = await tx(async (qc, oc) => {
      const p = await oc('SELECT id, code, name, is_draft FROM products WHERE id=$1 FOR UPDATE', [id]);
      if (!p) throw fail(404, 'Product not found');
      if (!p.is_draft) throw fail(409, `${p.code || p.name} is not a draft`);
      await qc(`UPDATE products SET is_draft=0, confirmed_at=now(), confirmed_by=$2 WHERE id=$1`, [id, req.user.name]);
      await audit('product', id, 'draft_confirmed', note(req.body?.note), qc, req.user.name);
      return { id, code: p.code, name: p.name };
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
