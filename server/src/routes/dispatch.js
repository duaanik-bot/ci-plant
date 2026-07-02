// Dispatch — produced lines with FG stock → challan → gone.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, fgIssue, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canDispatch = requireRole('dispatch', 'planner');

r.get('/dispatch/ready', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT ol.id AS order_line_id, ol.qty, ol.dispatched_qty, ol.rate, ol.order_id,
             o.po_number, o.delivery_date, c.id AS customer_id, c.name AS customer_name, c.city,
             p.id AS product_id, p.name AS product_name, p.code,
             COALESCE(f.qty,0) AS fg_qty
      FROM order_lines ol
      JOIN orders o ON o.id=ol.order_id
      JOIN customers c ON c.id=o.customer_id
      JOIN products p ON p.id=ol.product_id
      LEFT JOIN fg_stock f ON f.product_id=p.id
      WHERE ol.status='produced'
      ORDER BY o.delivery_date NULLS LAST`));
  } catch (e) { next(e); }
});

r.get('/dispatches', async (_req, res, next) => {
  try {
    const ds = await q(`
      SELECT d.*, c.name AS customer_name, c.city, o.po_number
      FROM dispatches d JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id ORDER BY d.id DESC`);
    const lines = await q(`
      SELECT dl.*, p.name AS product_name, p.code FROM dispatch_lines dl
      JOIN products p ON p.id=dl.product_id`);
    const byD = {};
    for (const l of lines) (byD[l.dispatch_id] ||= []).push(l);
    res.json(ds.map(d => ({ ...d, lines: byD[d.id] || [] })));
  } catch (e) { next(e); }
});

r.get('/dispatches/:id', async (req, res, next) => {
  try {
    const d = await one(`
      SELECT d.*, c.name AS customer_name, c.city, c.state, c.gstin, o.po_number, o.po_date
      FROM dispatches d JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id WHERE d.id=$1`, [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    d.lines = await q(`
      SELECT dl.*, p.name AS product_name, p.code, p.size FROM dispatch_lines dl
      JOIN products p ON p.id=dl.product_id WHERE dl.dispatch_id=$1`, [d.id]);
    res.json(d);
  } catch (e) { next(e); }
});

// Create a challan for one order's produced lines. FG issued atomically.
r.post('/dispatches', canDispatch, async (req, res, next) => {
  try {
    const { order_id, vehicle, driver, notes, lines } = req.body;
    if (!order_id || !lines?.length) return res.status(400).json({ error: 'Order and at least one line are required' });
    const dId = await tx(async (qc, oc) => {
      const order = await oc('SELECT * FROM orders WHERE id=$1', [order_id]);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      const challan_number = await nextNumber('CI-CH-', 'dispatches', 'challan_number', oc);
      const [d] = await qc(
        'INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [challan_number, order_id, order.customer_id, vehicle || null, driver || null, notes || null]);

      for (const l of lines) {
        const ol = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [l.order_line_id]);
        if (!ol || ol.status !== 'produced')
          throw Object.assign(new Error('Line is not ready for dispatch'), { status: 409 });
        const qty = +l.qty;
        if (!qty || qty <= 0) throw Object.assign(new Error('Dispatch quantity must be positive'), { status: 400 });
        if (ol.dispatched_qty + qty > ol.qty)
          throw Object.assign(new Error(`Dispatch exceeds ordered quantity for line ${ol.id}`), { status: 409 });

        await fgIssue(ol.product_id, qty, 'dispatch', d.id, qc, oc);
        await qc('INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES ($1,$2,$3,$4)',
          [d.id, ol.id, ol.product_id, qty]);
        const newDispatched = ol.dispatched_qty + qty;
        await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [newDispatched, ol.id]);
        if (newDispatched >= ol.qty) await setLineStatus(ol.id, 'dispatched', qc, oc, req.user.name);
      }
      const open = await oc(
        `SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [order_id]);
      if (open.n === 0) await qc(`UPDATE orders SET status='completed' WHERE id=$1`, [order_id]);
      await audit('dispatch', d.id, 'create', challan_number, qc, req.user.name);
      return d.id;
    });
    res.json(await one('SELECT * FROM dispatches WHERE id=$1', [dId]));
  } catch (e) { next(e); }
});

export default r;
