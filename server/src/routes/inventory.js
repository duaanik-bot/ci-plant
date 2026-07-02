// Inventory — stock position, batches, movements ledger, FG, adjustments.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canAdjust = requireRole('planner');

r.get('/inventory/stock', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(qr.q,0) AS quarantine
      FROM materials m
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT material_id, SUM(qty) q FROM stock_batches WHERE status='quarantine' GROUP BY material_id) qr ON qr.material_id=m.id
      ORDER BY m.category, m.name`);
    const demand = await q(`
      SELECT p.board_material_id AS material_id, SUM(ol.sheets_required) AS q
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE ol.status IN ('planned','ready') GROUP BY p.board_material_id`);
    const dmap = Object.fromEntries(demand.map(d => [d.material_id, d.q]));
    res.json(rows.map(m => ({
      ...m, demand: dmap[m.id] || 0,
      short: (m.reorder_level > (m.available || 0)) || ((dmap[m.id] || 0) > (m.available || 0)),
    })));
  } catch (e) { next(e); }
});

r.get('/inventory/batches', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT b.*, m.name AS material_name, m.category
      FROM stock_batches b JOIN materials m ON m.id=b.material_id
      ORDER BY b.id DESC LIMIT 200`));
  } catch (e) { next(e); }
});

r.get('/inventory/movements', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT sm.*, m.name AS material_name, p.name AS product_name
      FROM stock_movements sm
      LEFT JOIN materials m ON m.id=sm.material_id
      LEFT JOIN products p ON p.id=sm.product_id
      ORDER BY sm.id DESC LIMIT 300`));
  } catch (e) { next(e); }
});

r.get('/inventory/fg', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT f.*, p.name AS product_name, p.code, p.rate, c.name AS customer_name
      FROM fg_stock f JOIN products p ON p.id=f.product_id
      JOIN customers c ON c.id=p.customer_id
      WHERE f.qty > 0 ORDER BY p.name`));
  } catch (e) { next(e); }
});

// Manual adjustment (opening stock, count corrections) — still writes the ledger.
r.post('/inventory/adjust', canAdjust, async (req, res, next) => {
  try {
    const { material_id, qty, batch_no, note } = req.body;
    if (!material_id || !qty) return res.status(400).json({ error: 'Material and quantity are required' });
    await tx(async (qc, oc) => {
      const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [material_id])).unit;
      if (qty > 0) {
        const [b] = await qc(
          `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
           VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
          [material_id, batch_no || `ADJ-${Date.now().toString().slice(-6)}`, qty, unit]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
          [material_id, b.id, qty, note || 'Manual adjustment (in)']);
      } else {
        let remaining = -qty;
        const batches = await qc(
          `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
          [material_id]);
        for (const b of batches) {
          if (remaining <= 0) break;
          const take = Math.min(b.qty, remaining);
          const newQty = b.qty - take;
          await qc(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
            [newQty, newQty <= 0 ? 'exhausted' : 'available', b.id]);
          await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, note) VALUES ($1,$2,'adjustment',$3,$4)`,
            [material_id, b.id, -take, note || 'Manual adjustment (out)']);
          remaining -= take;
        }
        if (remaining > 0) throw Object.assign(new Error('Not enough stock to reduce'), { status: 409 });
      }
      await audit('inventory', material_id, 'adjust', String(qty), qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
