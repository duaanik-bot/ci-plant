// Orders + Planning + Artwork — the front half of the plant workflow.
import { Router } from 'express';
import db from '../db.js';
import { audit, setLineStatus, sheetsRequired, readiness, nextNumber } from '../helpers.js';

const r = Router();

const LINE_VIEW = `
  SELECT ol.*, o.po_number, o.po_date, o.delivery_date, o.customer_id,
         c.name AS customer_name, p.name AS product_name, p.code AS product_code,
         p.coating, p.special, p.colors, p.ups, p.gsm, p.size,
         p.board_material_id, bm.name AS board_name,
         m.name AS machine_name
  FROM order_lines ol
  JOIN orders o   ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = ol.product_id
  JOIN materials bm ON bm.id = p.board_material_id
  LEFT JOIN machines m ON m.id = ol.machine_id`;

// ── Orders ──────────────────────────────────────────────────────────────────
r.get('/orders', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.segment,
      (SELECT COUNT(*) FROM order_lines ol WHERE ol.order_id=o.id) AS line_count,
      (SELECT COALESCE(SUM(ol.qty*ol.rate),0) FROM order_lines ol WHERE ol.order_id=o.id AND ol.status!='cancelled') AS value
    FROM orders o JOIN customers c ON c.id=o.customer_id
    ORDER BY o.id DESC`).all();
  res.json(orders);
});

r.get('/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.city, c.gstin FROM orders o
    JOIN customers c ON c.id=o.customer_id WHERE o.id=?`).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  order.lines = db.prepare(`${LINE_VIEW} WHERE ol.order_id=? ORDER BY ol.id`).all(req.params.id);
  res.json(order);
});

r.post('/orders', (req, res, next) => {
  try {
    const { po_number, customer_id, po_date, delivery_date, notes, lines } = req.body;
    if (!po_number || !customer_id || !lines?.length) {
      return res.status(400).json({ error: 'PO number, customer and at least one line are required' });
    }
    const result = db.transaction(() => {
      const info = db.prepare(
        'INSERT INTO orders (po_number, customer_id, po_date, delivery_date, notes) VALUES (?,?,?,?,?)'
      ).run(po_number, customer_id, po_date || new Date().toISOString().slice(0, 10), delivery_date || null, notes || null);
      const orderId = info.lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES (?,?,?,?)');
      for (const l of lines) {
        if (!l.product_id || !l.qty) throw Object.assign(new Error('Each line needs a product and quantity'), { status: 400 });
        const prod = db.prepare('SELECT rate FROM products WHERE id=?').get(l.product_id);
        ins.run(orderId, l.product_id, l.qty, l.rate ?? prod?.rate ?? 0);
      }
      audit('order', orderId, 'create', po_number);
      return orderId;
    })();
    res.json(db.prepare('SELECT * FROM orders WHERE id=?').get(result));
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/cancel', (req, res, next) => {
  try { res.json(setLineStatus(+req.params.id, 'cancelled')); } catch (e) { next(e); }
});

// ── Planning ────────────────────────────────────────────────────────────────
// Lines waiting to be planned + lines already planned (for the planning board)
r.get('/planning', (req, res) => {
  const rows = db.prepare(`${LINE_VIEW}
    WHERE ol.status IN ('pending','planned','ready') ORDER BY o.delivery_date, ol.id`).all();
  res.json(rows.map(l => ({ ...l, readiness: readiness(l) })));
});

// Plan a line: assign machine + date; computes sheets required.
r.post('/order-lines/:id/plan', (req, res, next) => {
  try {
    const { machine_id, planned_date, tooling_ok } = req.body;
    if (!machine_id || !planned_date) return res.status(400).json({ error: 'Machine and planned date are required' });
    db.transaction(() => {
      const line = db.prepare('SELECT * FROM order_lines WHERE id=?').get(req.params.id);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(line.product_id);
      const sheets = sheetsRequired(product, line.qty);
      db.prepare(`UPDATE order_lines SET machine_id=?, planned_date=?, sheets_required=?, tooling_ok=? WHERE id=?`)
        .run(machine_id, planned_date, sheets, tooling_ok ? 1 : 0, line.id);
      if (line.status === 'pending') setLineStatus(line.id, 'planned');
      audit('order_line', line.id, 'planned', `machine ${machine_id}, ${sheets} sheets`);
    })();
    res.json(db.prepare(`${LINE_VIEW} WHERE ol.id=?`).get(req.params.id));
  } catch (e) { next(e); }
});

// ── Artwork ─────────────────────────────────────────────────────────────────
r.get('/artwork', (req, res) => {
  const rows = db.prepare(`${LINE_VIEW}
    WHERE ol.status IN ('planned','ready') ORDER BY ol.artwork_locked, o.delivery_date`).all();
  res.json(rows);
});

// ONE approval endpoint that writes the ONE flag the gate reads.
r.post('/order-lines/:id/artwork', (req, res, next) => {
  try {
    const { customer_ok, qa_ok } = req.body;
    db.transaction(() => {
      const line = db.prepare('SELECT * FROM order_lines WHERE id=?').get(req.params.id);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const cust = customer_ok ?? line.artwork_customer_ok;
      const qa = qa_ok ?? line.artwork_qa_ok;
      const locked = cust && qa ? 1 : 0;   // both approvals ⇒ locked. No second system.
      db.prepare(`UPDATE order_lines SET artwork_customer_ok=?, artwork_qa_ok=?, artwork_locked=? WHERE id=?`)
        .run(cust ? 1 : 0, qa ? 1 : 0, locked, line.id);
      audit('order_line', line.id, locked ? 'artwork_locked' : 'artwork_updated');
      // If everything is now ready, promote automatically.
      const fresh = db.prepare('SELECT * FROM order_lines WHERE id=?').get(line.id);
      const gate = readiness(fresh);
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && gate.material) {
        setLineStatus(fresh.id, 'ready');
      }
    })();
    const out = db.prepare(`${LINE_VIEW} WHERE ol.id=?`).get(req.params.id);
    res.json({ ...out, readiness: readiness(out) });
  } catch (e) { next(e); }
});

// Toggle tooling from planning/artwork screens
r.post('/order-lines/:id/tooling', (req, res, next) => {
  try {
    db.transaction(() => {
      db.prepare('UPDATE order_lines SET tooling_ok=? WHERE id=?').run(req.body.tooling_ok ? 1 : 0, req.params.id);
      const fresh = db.prepare('SELECT * FROM order_lines WHERE id=?').get(req.params.id);
      const gate = readiness(fresh);
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && gate.material) setLineStatus(fresh.id, 'ready');
      audit('order_line', +req.params.id, `tooling:${req.body.tooling_ok ? 'ok' : 'pending'}`);
    })();
    const out = db.prepare(`${LINE_VIEW} WHERE ol.id=?`).get(req.params.id);
    res.json({ ...out, readiness: readiness(out) });
  } catch (e) { next(e); }
});

// Raise a purchase requisition straight from a material shortage
r.post('/order-lines/:id/raise-pr', (req, res, next) => {
  try {
    const line = db.prepare(`${LINE_VIEW} WHERE ol.id=?`).get(req.params.id);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const gate = readiness(line);
    const shortage = Math.max(0, gate.needed_sheets - gate.available_sheets);
    if (shortage === 0) return res.status(400).json({ error: 'No shortage for this line' });
    const pr_number = nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const info = db.prepare(
      `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason) VALUES (?,?,?,?,?)`
    ).run(pr_number, gate.board_material_id, shortage, line.planned_date,
          `Shortage for ${line.product_name} (PO ${line.po_number})`);
    audit('requisition', info.lastInsertRowid, 'create_from_shortage', pr_number);
    res.json(db.prepare('SELECT * FROM requisitions WHERE id=?').get(info.lastInsertRowid));
  } catch (e) { next(e); }
});

export default r;
