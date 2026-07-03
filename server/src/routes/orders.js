// Orders + Planning + Artwork — the front half of the plant workflow.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, sheetsRequired, readiness, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canArtwork = requireRole('planner', 'qc');

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
r.get('/orders', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT o.*, c.name AS customer_name, c.segment,
        (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.order_id=o.id) AS line_count,
        (SELECT COALESCE(SUM(ol.qty*ol.rate),0) FROM order_lines ol WHERE ol.order_id=o.id AND ol.status!='cancelled') AS value
      FROM orders o JOIN customers c ON c.id=o.customer_id
      ORDER BY o.id DESC`));
  } catch (e) { next(e); }
});

r.get('/orders/:id', async (req, res, next) => {
  try {
    const order = await one(`
      SELECT o.*, c.name AS customer_name, c.city, c.gstin FROM orders o
      JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Not found' });
    order.lines = await q(`${LINE_VIEW} WHERE ol.order_id=$1 ORDER BY ol.id`, [req.params.id]);
    res.json(order);
  } catch (e) { next(e); }
});

r.post('/orders', canPlan, async (req, res, next) => {
  try {
    const { po_number, customer_id, po_date, delivery_date, notes, lines } = req.body;
    if (!po_number || !customer_id || !lines?.length) {
      return res.status(400).json({ error: 'PO number, customer and at least one line are required' });
    }
    const orderId = await tx(async (qc, oc) => {
      const [o] = await qc(
        `INSERT INTO orders (po_number, customer_id, po_date, delivery_date, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [po_number, customer_id, po_date || new Date().toISOString().slice(0, 10), delivery_date || null, notes || null]);
      for (const l of lines) {
        if (!l.product_id || !l.qty) throw Object.assign(new Error('Each line needs a product and quantity'), { status: 400 });
        const prod = await oc('SELECT rate FROM products WHERE id=$1', [l.product_id]);
        await qc('INSERT INTO order_lines (order_id, product_id, qty, rate) VALUES ($1,$2,$3,$4)',
          [o.id, l.product_id, l.qty, l.rate ?? prod?.rate ?? 0]);
      }
      await audit('order', o.id, 'create', po_number, qc, req.user.name);
      return o.id;
    });
    res.json(await one('SELECT * FROM orders WHERE id=$1', [orderId]));
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/cancel', canPlan, async (req, res, next) => {
  try { res.json(await setLineStatus(+req.params.id, 'cancelled', q, one, req.user.name)); } catch (e) { next(e); }
});

// ── Planning ────────────────────────────────────────────────────────────────
r.get('/planning', async (_req, res, next) => {
  try {
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('pending','planned','ready') ORDER BY o.delivery_date NULLS LAST, ol.id`);
    const out = [];
    for (const l of rows) out.push({ ...l, readiness: await readiness(l) });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/plan', canPlan, async (req, res, next) => {
  try {
    const { machine_id, planned_date, tooling_ok, ups_override, wastage_pct_override } = req.body;
    if (!machine_id || !planned_date) return res.status(400).json({ error: 'Machine and planned date are required' });
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      // Planner can override cut plan (ups) and wastage % for this line only —
      // the CI-Production planning engine's editable cut-plan behaviour.
      const eff = {
        ...product,
        ups: ups_override != null && +ups_override > 0 ? +ups_override : product.ups,
        wastage_pct: wastage_pct_override != null && +wastage_pct_override >= 0 ? +wastage_pct_override : product.wastage_pct,
      };
      const sheets = sheetsRequired(eff, line.qty);
      await qc(`UPDATE order_lines SET machine_id=$1, planned_date=$2, sheets_required=$3, tooling_ok=$4 WHERE id=$5`,
        [machine_id, planned_date, sheets, tooling_ok ? 1 : 0, line.id]);
      if (line.status === 'pending') await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
      await audit('order_line', line.id, 'planned',
        `machine ${machine_id}, ${sheets} sheets (${eff.ups} ups, ${eff.wastage_pct}% wastage)`, qc, req.user.name);
    });
    res.json(await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Planning engine context — everything the planner needs on one screen:
// requirement, board stock position, committed demand, and open supply.
r.get('/planning/:lineId/context', async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.lineId]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const matId = line.board_material_id;

    const stock = await one(`
      SELECT
        COALESCE(SUM(CASE WHEN status='available' THEN qty END),0) AS available,
        COALESCE(SUM(CASE WHEN status='quarantine' THEN qty END),0) AS quarantine
      FROM stock_batches WHERE material_id=$1`, [matId]);

    const committed = await one(`
      SELECT COALESCE(SUM(ol.sheets_required),0)::int AS sheets
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE p.board_material_id=$1 AND ol.status IN ('planned','ready') AND ol.id != $2`,
      [matId, line.id]);

    const openPrs = await q(`
      SELECT pr.pr_number, pr.qty, pr.status, pr.needed_by FROM requisitions pr
      WHERE pr.material_id=$1 AND pr.status IN ('pending','approved') ORDER BY pr.id DESC`, [matId]);
    const openPos = await q(`
      SELECT po.po_number, pl.qty, pl.received_qty, po.status, v.name AS vendor_name
      FROM po_lines pl
      JOIN purchase_orders po ON po.id=pl.purchase_order_id
      JOIN vendors v ON v.id=po.vendor_id
      WHERE pl.material_id=$1 AND po.status IN ('open','partially_received') ORDER BY po.id DESC`, [matId]);

    const batches = await q(`
      SELECT batch_no, qty, created_at FROM stock_batches
      WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id LIMIT 8`, [matId]);

    res.json({
      line,
      stock: { ...stock, committed_other: committed.sheets },
      incoming: {
        prs: openPrs,
        pos: openPos.map(p => ({ ...p, pending_qty: Math.max(0, p.qty - p.received_qty) })),
      },
      batches,
    });
  } catch (e) { next(e); }
});

// ── Artwork ─────────────────────────────────────────────────────────────────
r.get('/artwork', async (_req, res, next) => {
  try {
    res.json(await q(`${LINE_VIEW}
      WHERE ol.status IN ('planned','ready') ORDER BY ol.artwork_locked, o.delivery_date NULLS LAST`));
  } catch (e) { next(e); }
});

// ONE approval endpoint that writes the ONE flag the gate reads.
r.post('/order-lines/:id/artwork', canArtwork, async (req, res, next) => {
  try {
    const { customer_ok, qa_ok } = req.body;
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const cust = customer_ok ?? line.artwork_customer_ok;
      const qa = qa_ok ?? line.artwork_qa_ok;
      const locked = cust && qa ? 1 : 0;
      await qc(`UPDATE order_lines SET artwork_customer_ok=$1, artwork_qa_ok=$2, artwork_locked=$3 WHERE id=$4`,
        [cust ? 1 : 0, qa ? 1 : 0, locked, line.id]);
      await audit('order_line', line.id, locked ? 'artwork_locked' : 'artwork_updated', null, qc, req.user.name);
      const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
      const gate = await readiness(fresh, oc);
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && gate.material) {
        await setLineStatus(fresh.id, 'ready', qc, oc, req.user.name);
      }
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/tooling', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      await qc('UPDATE order_lines SET tooling_ok=$1 WHERE id=$2', [req.body.tooling_ok ? 1 : 0, req.params.id]);
      const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      const gate = await readiness(fresh, oc);
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && gate.material) {
        await setLineStatus(fresh.id, 'ready', qc, oc, req.user.name);
      }
      await audit('order_line', +req.params.id, `tooling:${req.body.tooling_ok ? 'ok' : 'pending'}`, null, qc, req.user.name);
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

// Raise a purchase requisition straight from a material shortage
r.post('/order-lines/:id/raise-pr', canPlan, async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const gate = await readiness(line);
    const shortage = Math.max(0, gate.needed_sheets - gate.available_sheets);
    if (shortage === 0) return res.status(400).json({ error: 'No shortage for this line' });
    const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const [pr] = await q(
      `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [pr_number, gate.board_material_id, shortage, line.planned_date,
       `Shortage for ${line.product_name} (PO ${line.po_number})`]);
    await audit('requisition', pr.id, 'create_from_shortage', pr_number, q, req.user.name);
    res.json(pr);
  } catch (e) { next(e); }
});

export default r;
