import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextProductCode, placeholderBoardId } from '../helpers.js';
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

// The Internal Code is editable on the form, so a typed duplicate must come
// back as a named 409, not a raw unique-key 500. Everything else passes
// through untouched.
function productCodeClash(table, e, req) {
  if (table === 'products' && e.code === '23505' && e.constraint === 'products_code_key') {
    e.status = 409;
    e.message = `Internal Code ${req.body.code} is already taken — clear the field to take the next code in the series.`;
  }
  return e;
}

// Generic CRUD for the five master tables — same shape everywhere.
const MASTERS = {
  customers: ['name', 'city', 'state', 'gstin', 'contact', 'phone', 'segment', 'tolerance_pct', 'shade_approval_requirement', 'active'],
  vendors: ['name', 'city', 'contact', 'phone', 'categories', 'gstin', 'address', 'state', 'state_code', 'email', 'active'],
  materials: ['name', 'category', 'spec', 'unit', 'sheet_l', 'sheet_w', 'reorder_level', 'hsn_code', 'gst_rate', 'std_rate', 'last_rate', 'active', 'grade', 'gsm', 'sheets_per_packet'],
  machines: ['code', 'name', 'model', 'type', 'capacity_per_hour', 'status', 'active', 'is_default'],
  employees: ['name', 'role', 'section', 'phone', 'active'],
  sections: ['code', 'name', 'sort_order', 'active'],
  products: ['customer_id', 'name', 'code', 'internal_carton_code', 'party_item_code', 'party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'board_material_id', 'board_name', 'board_grade', 'gsm', 'size', 'child_l', 'child_w',
             'parent_l', 'parent_w', 'ups', 'colors', 'colour_type', 'coating', 'special', 'pasting_type', 'emboss', 'leafing', 'leafing_colour', 'die_number', 'block_number', 'tool_id', 'product_type', 'rate', 'mrp', 'shade_approval_requirement', 'active', 'spec_incomplete'],
  gst_rates: ['product_type', 'label', 'rate', 'active'],
};

// products.board_name is a denormalised copy of the linked board material's
// name. Nothing types it any more — the Board picker is the only door, and the
// form dropped its Board Name field — but it is still read as legacy display
// and as the middle term of the grade fallback
// (COALESCE(board_grade, first word of board_name, first word of the material
// name)) in orders/floor/gangs, and printed on the shade card. So re-point a
// product at another board and the copy sits there naming the old one: a
// product cut from Saffire still reading "FBB 300 GSM 31.5x41.5".
//
// Planning already keeps the two in step on a board change (the gang
// shared-sheet lock, the engine's Update Product Master); this closes the
// master form, the one door that did not.
//
// Only a REAL change to the link rewrites the copy. 980 products carry a
// legacy-format name ("FBB 300 GSM 31.5x41.5" against the composed
// "FBB · 300 GSM · 31.5x41.5") that means the same board — editing a rate must
// not silently reformat a thousand rows as a side effect.
async function syncProductBoardName(body, id) {
  if (!('board_material_id' in body)) return;
  const next = body.board_material_id;
  if (next == null || next === '') return;
  if (id != null) {
    const before = await one('SELECT board_material_id FROM products WHERE id=$1', [id]);
    if (before && String(before.board_material_id) === String(next)) return;   // link unchanged
  }
  const board = await one('SELECT name FROM materials WHERE id=$1', [next]);
  if (board?.name) body.board_name = board.name;
}

// One default machine per category. The Start modal resolves a station's default
// by flag, so two flagged machines of the same type would make the pick
// arbitrary — clear the siblings whenever a machine claims the flag.
async function keepOneDefaultMachine(row) {
  if (!row || Number(row.is_default) !== 1) return;
  await q(`UPDATE machines SET is_default = 0 WHERE type = $1 AND id <> $2 AND is_default = 1`,
    [row.type, row.id]);
}

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
      if (table === 'products') {
        await syncProductBoardName(req.body, null);
        // Internal Code: blank means "issue the next code in this customer's
        // series" — the client normally prefills it, but the server is the
        // authority so a bare API create is never born code-less.
        if (!req.body.code || !String(req.body.code).trim()) {
          req.body.code = await nextProductCode(+req.body.customer_id);
        }
        // internal_carton_code is a server-kept mirror of code (the FG-matching
        // key) — the form no longer carries it.
        req.body.internal_carton_code = req.body.code;
        // A product may now be raised before its board is chosen. Unlike ups or
        // colors, board_material_id has NO default to fall back on when the
        // column is left out — and it is INNER-joined in seven places,
        // the Products master list among them. So a null board would not merely
        // fail the insert: it would hide the row from the one screen the spec
        // gets finished on. Same answer the PO import already gives an
        // unmatched line — park it on a placeholder and flag spec_incomplete,
        // which is what puts the amber "Spec incomplete" badge on the name in
        // Masters. board_name is deliberately left blank (syncProductBoardName
        // ran above and skips an absent link), so nothing on screen claims the
        // placeholder is the real board.
        if (req.body.board_material_id == null || req.body.board_material_id === '') {
          const boardId = await placeholderBoardId(one);
          if (!boardId) return res.status(400).json({ error: 'Create a board material first' });
          req.body.board_material_id = boardId;
          req.body.spec_incomplete = 1;
        }
      }
      // Only the columns the caller actually sent. Naming every column and
      // passing NULL for the absent ones DEFEATS the schema's own defaults:
      // `colors INTEGER NOT NULL DEFAULT 4` accepts silence and fills itself,
      // but an explicit NULL is a value, and the row is refused. That is what
      // made a half-known product impossible to save — the master had to be
      // complete before it could exist, which is backwards for a plant that
      // learns a spec as the job moves. Absent now means "not known yet": the
      // database fills what it can, the rest stays blank to be finished later,
      // and the form says what is still pending instead of refusing.
      // The UPDATE path below has always worked this way (`c in req.body`).
      const sets = cols.filter(c => c in req.body && req.body[c] !== undefined);
      if (!sets.length) {
        return res.status(400).json({ error: 'Nothing to create — send at least one field' });
      }
      const ph = sets.map((_, i) => `$${i + 1}`).join(',');
      const [row] = await q(
        `INSERT INTO ${table} (${sets.join(',')}) VALUES (${ph}) RETURNING *`,
        sets.map(c => req.body[c]));
      await audit(table, row.id, 'create', null, q, req.user.name);
      if (table === 'machines') await keepOneDefaultMachine(row);
      res.json(row);
    } catch (e) { next(productCodeClash(table, e, req)); }
  });

  r.put(`/${table}/:id`, canEdit, async (req, res, next) => {
    try {
      // Before `sets` is taken — the sync adds board_name to the body, and a
      // column the body does not carry is not written.
      if (table === 'products') await syncProductBoardName(req.body, req.params.id);
      // A product changing hands (SGBT ↔ SGLS is routine) must land in the new
      // owner's code series — the form still carries the OLD code, so writing
      // the body as-is would file a Biotech product under SW-. Regenerate here;
      // the PUT's own field diff then audits `code: SW-204 → SGB-336` for free.
      if (table === 'products' && req.body.customer_id != null) {
        const cur = await one('SELECT customer_id FROM products WHERE id=$1', [req.params.id]);
        if (cur && +req.body.customer_id !== +cur.customer_id) {
          req.body.code = await nextProductCode(+req.body.customer_id);
        }
      }
      // Whatever code this row ends up with, the mirror follows it — the form
      // no longer carries internal_carton_code, the server keeps it = code.
      if (table === 'products' && req.body.code != null && String(req.body.code).trim()) {
        req.body.internal_carton_code = String(req.body.code).trim();
      }
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
      if (table === 'machines') await keepOneDefaultMachine(row);
      res.json(row);
    } catch (e) { next(productCodeClash(table, e, req)); }
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

// Move a product to another customer — the master keeps its id (every order,
// job and shade card stays attached); only the owner and the code change, and
// the alias learning follows the product to its new owner so the next PO from
// that entity still recognises the line.
r.post('/products/:id/migrate-customer', canEdit, async (req, res, next) => {
  try {
    const target = +req.body.customer_id;
    if (!target) return res.status(400).json({ error: 'customer_id required' });
    const p = await one('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    if (+p.customer_id === target) return res.status(400).json({ error: 'Product already belongs to that customer' });
    const cust = await one('SELECT id, name FROM customers WHERE id=$1 AND active=1', [target]);
    if (!cust) return res.status(400).json({ error: 'Target customer not found' });
    const from = await one('SELECT name FROM customers WHERE id=$1', [p.customer_id]);
    const code = await nextProductCode(target);
    const row = await tx(async (qc) => {
      const [updated] = await qc('UPDATE products SET customer_id=$1, code=$2, internal_carton_code=$2 WHERE id=$3 RETURNING *', [target, code, req.params.id]);
      await qc(`INSERT INTO product_aliases (customer_id, alias_norm, product_id)
                SELECT $1, alias_norm, product_id FROM product_aliases WHERE product_id=$2 AND customer_id=$3
                ON CONFLICT (customer_id, alias_norm) DO UPDATE SET product_id=EXCLUDED.product_id`,
        [target, updated.id, p.customer_id]);
      await qc('DELETE FROM product_aliases WHERE product_id=$1 AND customer_id=$2', [updated.id, p.customer_id]);
      return updated;
    });
    await audit('product', row.id, 'migrate',
      `${from?.name || p.customer_id} → ${cust.name}; code ${p.code} → ${row.code}`, q, req.user.name);
    const full = await one(`
      SELECT p.*, COALESCE(p.gst_pct, gr.rate, 12) AS gst
      FROM products p LEFT JOIN gst_rates gr ON gr.product_type=p.product_type WHERE p.id=$1`, [row.id]);
    res.json(full);
  } catch (e) { next(e); }
});

export default r;
