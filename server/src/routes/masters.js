import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied

// Generic CRUD for the five master tables — same shape everywhere.
const MASTERS = {
  customers: ['name', 'city', 'state', 'gstin', 'contact', 'phone', 'segment', 'active'],
  vendors: ['name', 'city', 'contact', 'phone', 'categories', 'active'],
  materials: ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'reorder_level'],
  machines: ['name', 'type', 'capacity_per_hour', 'status'],
  employees: ['name', 'role', 'section', 'phone', 'active'],
  dies: ['die_number', 'die_type', 'ups', 'sheet_size', 'carton_size', 'location',
         'condition', 'impression_count', 'max_impressions', 'active'],
  products: ['customer_id', 'name', 'code', 'board_material_id', 'gsm', 'size', 'child_l', 'child_w',
             'ups', 'wastage_pct', 'colors', 'coating', 'special', 'die_id', 'gst_pct', 'rate', 'active'],
};

for (const [table, cols] of Object.entries(MASTERS)) {
  r.get(`/${table}`, async (_req, res, next) => {
    try {
      let rows;
      if (table === 'products') {
        rows = await q(`
          SELECT p.*, c.name AS customer_name, m.name AS board_name, d.die_number, d.condition AS die_condition
          FROM products p JOIN customers c ON c.id=p.customer_id
          JOIN materials m ON m.id=p.board_material_id
          LEFT JOIN dies d ON d.id=p.die_id ORDER BY p.name`);
      } else if (table === 'dies') {
        rows = await q(`
          SELECT d.*, (SELECT COUNT(*)::int FROM products p WHERE p.die_id=d.id) AS product_count
          FROM dies d ORDER BY d.die_number`);
      } else {
        rows = await q(`SELECT * FROM ${table} ORDER BY name`);
      }
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post(`/${table}`, canEdit, async (req, res, next) => {
    try {
      const vals = cols.map(c => req.body[c] ?? null);
      const ph = cols.map((_, i) => `$${i + 1}`).join(',');
      const [row] = await q(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
      await audit(table, row.id, 'create', null, q, req.user.name);
      res.json(row);
    } catch (e) { next(e); }
  });

  r.put(`/${table}/:id`, canEdit, async (req, res, next) => {
    try {
      const sets = cols.filter(c => c in req.body);
      if (!sets.length) return res.json({});
      const assign = sets.map((c, i) => `${c}=$${i + 1}`).join(',');
      const vals = sets.map(c => req.body[c]);
      vals.push(req.params.id);
      const [row] = await q(
        `UPDATE ${table} SET ${assign} WHERE id=$${sets.length + 1} RETURNING *`, vals);
      await audit(table, +req.params.id, 'update', null, q, req.user.name);
      res.json(row);
    } catch (e) { next(e); }
  });

  r.delete(`/${table}/:id`, canEdit, async (req, res, next) => {
    try {
      await q(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
      await audit(table, +req.params.id, 'delete', null, q, req.user.name);
      res.json({ ok: true });
    } catch (e) {
      e.status = 409;
      e.message = 'Cannot delete — record is used elsewhere. Mark it inactive instead.';
      next(e);
    }
  });
}

export default r;
