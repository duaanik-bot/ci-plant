// Dispatch — produced lines with FG stock → challan → gone.
import { Router } from 'express';
import db from '../db.js';
import { audit, setLineStatus, fgIssue, nextNumber } from '../helpers.js';

const r = Router();

// Lines ready to dispatch (produced, FG available)
r.get('/dispatch/ready', (req, res) => {
  res.json(db.prepare(`
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
    ORDER BY o.delivery_date`).all());
});

r.get('/dispatches', (req, res) => {
  const ds = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.city, o.po_number
    FROM dispatches d JOIN customers c ON c.id=d.customer_id
    JOIN orders o ON o.id=d.order_id ORDER BY d.id DESC`).all();
  const lines = db.prepare(`
    SELECT dl.*, p.name AS product_name, p.code FROM dispatch_lines dl
    JOIN products p ON p.id=dl.product_id`).all();
  const byD = {};
  for (const l of lines) (byD[l.dispatch_id] ||= []).push(l);
  res.json(ds.map(d => ({ ...d, lines: byD[d.id] || [] })));
});

r.get('/dispatches/:id', (req, res) => {
  const d = db.prepare(`
    SELECT d.*, c.name AS customer_name, c.city, c.state, c.gstin, o.po_number, o.po_date
    FROM dispatches d JOIN customers c ON c.id=d.customer_id
    JOIN orders o ON o.id=d.order_id WHERE d.id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.lines = db.prepare(`
    SELECT dl.*, p.name AS product_name, p.code, p.size FROM dispatch_lines dl
    JOIN products p ON p.id=dl.product_id WHERE dl.dispatch_id=?`).all(d.id);
  res.json(d);
});

// Create a challan for one order's produced lines. FG issued atomically.
r.post('/dispatches', (req, res, next) => {
  try {
    const { order_id, vehicle, driver, notes, lines } = req.body;
    if (!order_id || !lines?.length) return res.status(400).json({ error: 'Order and at least one line are required' });
    const dId = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      const challan_number = nextNumber('CI-CH-', 'dispatches', 'challan_number');
      const info = db.prepare(
        'INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, notes) VALUES (?,?,?,?,?,?)'
      ).run(challan_number, order_id, order.customer_id, vehicle || null, driver || null, notes || null);
      const dId = info.lastInsertRowid;

      for (const l of lines) {
        const ol = db.prepare('SELECT * FROM order_lines WHERE id=?').get(l.order_line_id);
        if (!ol || ol.status !== 'produced')
          throw Object.assign(new Error('Line is not ready for dispatch'), { status: 409 });
        const qty = +l.qty;
        if (!qty || qty <= 0) throw Object.assign(new Error('Dispatch quantity must be positive'), { status: 400 });
        if (ol.dispatched_qty + qty > ol.qty)
          throw Object.assign(new Error(`Dispatch exceeds ordered quantity for line ${ol.id}`), { status: 409 });

        fgIssue(ol.product_id, qty, 'dispatch', dId);   // throws if FG short
        db.prepare('INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES (?,?,?,?)')
          .run(dId, ol.id, ol.product_id, qty);
        const newDispatched = ol.dispatched_qty + qty;
        db.prepare('UPDATE order_lines SET dispatched_qty=? WHERE id=?').run(newDispatched, ol.id);
        if (newDispatched >= ol.qty) setLineStatus(ol.id, 'dispatched');
      }
      // Order complete when every line is dispatched or cancelled
      const open = db.prepare(
        `SELECT COUNT(*) n FROM order_lines WHERE order_id=? AND status NOT IN ('dispatched','cancelled')`).get(order_id);
      if (open.n === 0) db.prepare(`UPDATE orders SET status='completed' WHERE id=?`).run(order_id);
      audit('dispatch', dId, 'create', challan_number);
      return dId;
    })();
    res.json(db.prepare('SELECT * FROM dispatches WHERE id=?').get(dId));
  } catch (e) { next(e); }
});

export default r;
