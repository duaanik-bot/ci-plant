import { Router } from 'express';
import db from '../db.js';
import { audit } from '../helpers.js';

const r = Router();

// Generic CRUD for the five master tables — same shape everywhere = simplicity.
const MASTERS = {
  customers: ['name', 'city', 'state', 'gstin', 'contact', 'phone', 'segment', 'active'],
  vendors: ['name', 'city', 'contact', 'phone', 'categories', 'active'],
  materials: ['name', 'category', 'spec', 'unit', 'reorder_level'],
  machines: ['name', 'type', 'capacity_per_hour', 'status'],
  products: ['customer_id', 'name', 'code', 'board_material_id', 'gsm', 'size', 'ups',
             'wastage_pct', 'colors', 'coating', 'special', 'rate', 'active'],
};

for (const [table, cols] of Object.entries(MASTERS)) {
  r.get(`/${table}`, (_req, res) => {
    let rows;
    if (table === 'products') {
      rows = db.prepare(`
        SELECT p.*, c.name AS customer_name, m.name AS board_name
        FROM products p JOIN customers c ON c.id=p.customer_id
        JOIN materials m ON m.id=p.board_material_id ORDER BY p.name`).all();
    } else {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY name`).all();
    }
    res.json(rows);
  });

  r.post(`/${table}`, (req, res, next) => {
    try {
      const vals = cols.map(c => req.body[c] ?? null);
      const info = db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...vals);
      audit(table, info.lastInsertRowid, 'create');
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid));
    } catch (e) { next(e); }
  });

  r.put(`/${table}/:id`, (req, res, next) => {
    try {
      const sets = cols.filter(c => c in req.body);
      if (!sets.length) return res.json({});
      db.prepare(`UPDATE ${table} SET ${sets.map(c => `${c}=?`).join(',')} WHERE id=?`)
        .run(...sets.map(c => req.body[c]), req.params.id);
      audit(table, +req.params.id, 'update');
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
    } catch (e) { next(e); }
  });

  r.delete(`/${table}/:id`, (req, res, next) => {
    try {
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
      audit(table, +req.params.id, 'delete');
      res.json({ ok: true });
    } catch (e) {
      e.status = 409;
      e.message = 'Cannot delete — record is used elsewhere. Mark it inactive instead.';
      next(e);
    }
  });
}

export default r;
