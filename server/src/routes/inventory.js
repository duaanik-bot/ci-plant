// Inventory — stock position, batches, movements ledger, FG, adjustments.
import { Router } from 'express';
import db from '../db.js';
import { audit } from '../helpers.js';

const r = Router();

// Stock position per material: available / quarantine / reserved-by-open-jobs
r.get('/inventory/stock', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine
    FROM materials m
    LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
    LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='quarantine' GROUP BY material_id) qr ON qr.material_id=m.id
    ORDER BY m.category, m.name`).all();
  // demand from planned/ready lines not yet in production
  const demand = db.prepare(`
    SELECT p.board_material_id AS material_id, SUM(ol.sheets_required) AS q
    FROM order_lines ol JOIN products p ON p.id=ol.product_id
    WHERE ol.status IN ('planned','ready') GROUP BY p.board_material_id`).all();
  const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
  res.json(rows.map(m => ({ ...m, demand: dmap[m.id] || 0, short: (m.reorder_level > (m.available || 0)) || ((dmap[m.id] || 0) > (m.available || 0)) })));
});

r.get('/inventory/batches', (req, res) => {
  res.json(db.prepare(`
    SELECT b.*, m.name AS material_name, m.category
    FROM stock_batches b JOIN materials m ON m.id=b.material_id
    ORDER BY b.id DESC LIMIT 200`).all());
});

r.get('/inventory/movements', (req, res) => {
  res.json(db.prepare(`
    SELECT sm.*, m.name AS material_name, p.name AS product_name
    FROM stock_movements sm
    LEFT JOIN materials m ON m.id=sm.material_id
    LEFT JOIN products p ON p.id=sm.product_id
    ORDER BY sm.id DESC LIMIT 300`).all());
});

r.get('/inventory/fg', (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, p.name AS product_name, p.code, p.rate, c.name AS customer_name
    FROM fg_stock f JOIN products p ON p.id=f.product_id
    JOIN customers c ON c.id=p.customer_id
    WHERE f.qty > 0 ORDER BY p.name`).all());
});

// Manual adjustment (opening stock, count corrections) — still writes the ledger.
r.post('/inventory/adjust', (req, res, next) => {
  try {
    const { material_id, qty, batch_no, note } = req.body;
    if (!material_id || !qty) return res.status(400).json({ error: 'Material and quantity are required' });
    db.transaction(() => {
      const unit = db.prepare('SELECT unit FROM materials WHERE id=?').get(material_id).unit;
      if (qty > 0) {
        const info = db.prepare(
          `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
           VALUES (?,?,?,?,?,'available')`
        ).run(material_id, batch_no || `ADJ-${Date.now().toString().slice(-6)}`, qty, qty, unit);
        db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES (?,?,?,?,?)`)
          .run(material_id, info.lastInsertRowid, 'adjustment', qty, note || 'Manual adjustment (in)');
      } else {
        // negative adjustment: FIFO reduce
        let remaining = -qty;
        const batches = db.prepare(
          `SELECT * FROM stock_batches WHERE material_id=? AND status='available' AND qty>0 ORDER BY created_at, id`).all(material_id);
        for (const b of batches) {
          if (remaining <= 0) break;
          const take = Math.min(b.qty, remaining);
          db.prepare('UPDATE stock_batches SET qty=qty-?, status=CASE WHEN qty-?<=0 THEN \'exhausted\' ELSE status END WHERE id=?')
            .run(take, take, b.id);
          db.prepare(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES (?,?,?,?,?)`)
            .run(material_id, b.id, 'adjustment', -take, note || 'Manual adjustment (out)');
          remaining -= take;
        }
        if (remaining > 0) throw Object.assign(new Error('Not enough stock to reduce'), { status: 409 });
      }
      audit('inventory', material_id, 'adjust', String(qty));
    })();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
