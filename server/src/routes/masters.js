import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied

// Sections only need a name — the Code and Sort Order are optional on the form
// and filled in here when left blank. Code is slugged from the name (Die Cutting
// → die_cutting) and de-duped; Sort Order drops to the end of the list. Keeps the
// masters.sections NOT NULL/UNIQUE code constraint satisfied without asking the
// user to hand-type a key.
async function fillSectionDefaults(body) {
  if (!body.code || !String(body.code).trim()) {
    const base = String(body.name || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
    let code = base, n = 1;
    while (await one('SELECT 1 FROM sections WHERE code=$1', [code])) code = `${base}_${++n}`;
    body.code = code;
  }
  if (body.sort_order == null || String(body.sort_order).trim() === '') {
    const next = await one('SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM sections');
    body.sort_order = next.next;
  }
}

// Generic CRUD for the five master tables — same shape everywhere.
const MASTERS = {
  customers: ['name', 'city', 'state', 'gstin', 'contact', 'phone', 'segment', 'tolerance_pct', 'shade_approval_requirement', 'active'],
  vendors: ['name', 'city', 'contact', 'phone', 'categories', 'gstin', 'address', 'state', 'state_code', 'email', 'active'],
  materials: ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'reorder_level', 'hsn_code', 'gst_rate', 'std_rate', 'last_rate', 'active', 'grade', 'gsm', 'sheets_per_packet'],
  machines: ['code', 'name', 'model', 'type', 'capacity_per_hour', 'status', 'active'],
  employees: ['name', 'role', 'section', 'phone', 'active'],
  sections: ['code', 'name', 'sort_order', 'active'],
  products: ['customer_id', 'name', 'code', 'internal_carton_code', 'party_item_code', 'party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'board_material_id', 'board_name', 'board_grade', 'gsm', 'size', 'child_l', 'child_w',
             'parent_l', 'parent_w', 'ups', 'colors', 'colour_type', 'coating', 'special', 'pasting_type', 'emboss', 'leafing', 'leafing_colour', 'die_number', 'block_number', 'tool_id', 'product_type', 'rate', 'mrp', 'shade_approval_requirement', 'active', 'spec_incomplete'],
  gst_rates: ['product_type', 'label', 'rate', 'active'],
};

for (const [table, cols] of Object.entries(MASTERS)) {
  r.get(`/${table}`, async (_req, res, next) => {
    try {
      let rows;
      if (table === 'products') {
        rows = await q(`
          SELECT p.*, c.name AS customer_name, m.name AS board_material_name, m.sheet_l, m.sheet_w,
                 d.code AS linked_die_code, d.condition AS die_condition,
                 COALESCE(p.gst_pct, gr.rate, 12) AS effective_gst
          FROM products p JOIN customers c ON c.id=p.customer_id
          JOIN materials m ON m.id=p.board_material_id
          LEFT JOIN tools d ON d.id=p.tool_id
          LEFT JOIN gst_rates gr ON gr.product_type = p.product_type ORDER BY p.name`);
      } else if (table === 'gst_rates') {
        rows = await q(`SELECT * FROM gst_rates ORDER BY rate, label`);
      } else if (table === 'sections') {
        rows = await q(`SELECT * FROM sections ORDER BY COALESCE(sort_order, 9999), name`);
      } else if (table === 'employees') {
        // Group people department-wise, in the plant's section order, then by name.
        rows = await q(`
          SELECT e.* FROM employees e
          LEFT JOIN sections s ON s.code = e.section
          ORDER BY COALESCE(s.sort_order, 9999), e.name`);
      } else if (table === 'machines') {
        // Machines carry their assigned operators — production entry filters
        // the operator picker to exactly this list.
        rows = await q(`
          SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
          FROM machines m
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object('id', e.id, 'name', e.name, 'role', e.role) ORDER BY e.name) AS operators
            FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
            WHERE mo.machine_id=m.id AND e.active=1) ops ON true
          ORDER BY m.type, m.name`);
      } else {
        rows = await q(`SELECT * FROM ${table} ORDER BY name`);
      }
      res.json(rows);
    } catch (e) { next(e); }
  });

  r.post(`/${table}`, canEdit, async (req, res, next) => {
    try {
      if (table === 'sections') await fillSectionDefaults(req.body);
      // Plant default: a new board carries 18% GST unless the buyer types another.
      if (table === 'materials' && String(req.body.category) === 'board'
          && (req.body.gst_rate == null || req.body.gst_rate === '')) req.body.gst_rate = 18;
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
      // Field-level history: diff against the stored row so the audit trail
      // records exactly what changed (old → new), not just "update".
      const before = await one(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
      const assign = sets.map((c, i) => `${c}=$${i + 1}`).join(',');
      const vals = sets.map(c => req.body[c]);
      vals.push(req.params.id);
      const [row] = await q(
        `UPDATE ${table} SET ${assign} WHERE id=$${sets.length + 1} RETURNING *`, vals);
      const diff = before ? sets
        .filter(c => String(before[c] ?? '') !== String(row?.[c] ?? ''))
        .map(c => `${c}: ${before[c] ?? '—'} → ${row?.[c] ?? '—'}`)
        .join('; ') : null;
      await audit(table, +req.params.id, 'update', diff ? diff.slice(0, 500) : null, q, req.user.name);
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

// ── Company profile ─────────────────────────────────────────────────────────
// Single-row "us" record — the buyer block on every PO and the home state that
// decides CGST/SGST (intra) vs IGST (inter) on purchases.
const COMPANY_COLS = ['name', 'gstin', 'address', 'city', 'state', 'state_code', 'phone', 'email'];
r.get('/company-profile', async (_req, res, next) => {
  try { res.json(await one('SELECT * FROM company_profile ORDER BY id LIMIT 1') || {}); }
  catch (e) { next(e); }
});
r.put('/company-profile', canEdit, async (req, res, next) => {
  try {
    const current = await one('SELECT * FROM company_profile ORDER BY id LIMIT 1');
    const vals = COMPANY_COLS.map(c => (c in req.body ? req.body[c] : current?.[c]) ?? null);
    let row;
    if (current) {
      const assign = COMPANY_COLS.map((c, i) => `${c}=$${i + 1}`).join(',');
      [row] = await q(`UPDATE company_profile SET ${assign} WHERE id=$${COMPANY_COLS.length + 1} RETURNING *`,
        [...vals, current.id]);
    } else {
      const ph = COMPANY_COLS.map((_, i) => `$${i + 1}`).join(',');
      [row] = await q(`INSERT INTO company_profile (${COMPANY_COLS.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    }
    await audit('company_profile', row.id, 'update', null, q, req.user.name);
    res.json(row);
  } catch (e) { next(e); }
});

// Machine ↔ operator mapping — replace the machine's assigned operator set.
r.put('/machines/:id/operators', canEdit, async (req, res, next) => {
  try {
    const ids = [...new Set((req.body.employee_ids || []).map(Number).filter(Boolean))];
    const machine = await one('SELECT * FROM machines WHERE id=$1', [req.params.id]);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    const before = await q(
      'SELECT employee_id FROM machine_operators WHERE machine_id=$1 ORDER BY employee_id', [machine.id]);
    await q('DELETE FROM machine_operators WHERE machine_id=$1', [machine.id]);
    for (const eid of ids) {
      await q('INSERT INTO machine_operators (machine_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [machine.id, eid]);
    }
    await audit('machine', machine.id, 'operators_update',
      `${machine.name}: [${before.map(b => b.employee_id).join(',')}] → [${ids.join(',')}]`, q, req.user.name);
    // Keep the live printing queue honest: jobs already planned on this press
    // whose print run hasn't finished pick up the (new) first crew member.
    if (machine.type === 'printing') {
      const crew = await one(`
        SELECT e.name FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=$1 AND e.active=1 ORDER BY e.name LIMIT 1`, [machine.id]);
      await q(`
        UPDATE job_stages js SET operator=$1
        FROM job_cards jc
        WHERE jc.id=js.job_card_id AND jc.machine_id=$2
          AND js.stage='printing' AND js.status != 'completed'`,
        [crew?.name || null, machine.id]);
    }
    res.json({ ok: true, machine_id: machine.id, employee_ids: ids });
  } catch (e) { next(e); }
});

export default r;
