// Orders + Planning + Artwork — the front half of the plant workflow.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, sheetsRequired, netProduceQty, readiness, nextNumber, childFit, parentSheetsRequired, leftoverStrips } from '../helpers.js';
import { rankBoardMatches } from '../smartmatch.js';
import { toolingDetail, toolingGateOk } from '../tooling-gate.js';
import { gangDetail } from './gangs.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canArtwork = requireRole('planner', 'qc');

// Effective spec everywhere: a line's job-only overrides (spec_override, the
// "save for this job" branch of the master-update philosophy) win over the
// product master — including the board, so a warehouse stock selection made in
// the planning engine flows through the whole view.
const EFF_BOARD_ID = `COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)`;
const LINE_VIEW = `
  SELECT ol.*, o.po_number, o.po_date, o.delivery_date, o.customer_id,
         COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance_pct,
         c.name AS customer_name, p.name AS product_name, p.code AS product_code,
         COALESCE(ol.spec_override->>'coating', p.coating) AS coating,
         COALESCE(ol.spec_override->>'special', p.special) AS special,
         COALESCE((ol.spec_override->>'colors')::int, p.colors) AS colors,
         COALESCE((ol.spec_override->>'ups')::int, p.ups) AS ups,
         p.gsm, p.size,
         COALESCE((ol.spec_override->>'wastage_pct')::float, p.wastage_pct) AS wastage_pct,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         p.product_type,
         COALESCE(ol.gst_pct, p.gst_pct, gr.rate, 12) AS gst_pct,
         ${EFF_BOARD_ID} AS board_material_id,
         (ol.spec_override->>'board_material_id') IS NOT NULL AS board_overridden,
         p.board_material_id AS master_board_material_id,
         bm.name AS board_name, bm.sheet_l, bm.sheet_w,
         d.code AS die_number, p.tool_id, m.name AS machine_name,
         gg.gang_number
  FROM order_lines ol
  JOIN orders o   ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = ol.product_id
  JOIN materials bm ON bm.id = ${EFF_BOARD_ID}
  LEFT JOIN tools d ON d.id = p.tool_id
  LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
  LEFT JOIN machines m ON m.id = ol.machine_id
  LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id`;

// Resolve the GST % to store on an order line: an explicit override wins,
// else the product's own rate, else the default for its type (from the master).
const resolveGst = (explicit, prod) => {
  const e = explicit === '' || explicit == null ? null : Number(explicit);
  if (e != null && Number.isFinite(e)) return Math.round(e);
  if (prod.gst_pct != null) return prod.gst_pct;
  if (prod.type_gst != null) return prod.type_gst;
  return null; // leave null → billing falls back to product/default at invoice time
};

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
      // Tolerance snapshot: the customer's dispatch tolerance at order entry is
      // frozen on each line, so later master edits never alter old orders.
      const cust = await oc('SELECT tolerance_pct FROM customers WHERE id=$1', [customer_id]);
      const tol = cust?.tolerance_pct ?? 0;
      for (const l of lines) {
        if (!l.product_id || !l.qty) throw Object.assign(new Error('Each line needs a product and quantity'), { status: 400 });
        const prod = await oc(`
          SELECT p.rate, p.gst_pct, gr.rate AS type_gst
          FROM products p LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
          WHERE p.id=$1`, [l.product_id]);
        await qc('INSERT INTO order_lines (order_id, product_id, qty, rate, gst_pct, tolerance_pct) VALUES ($1,$2,$3,$4,$5,$6)',
          [o.id, l.product_id, l.qty, l.rate ?? prod?.rate ?? 0, resolveGst(l.gst, prod || {}), tol]);
      }
      await audit('order', o.id, 'create', po_number, qc, req.user.name);
      return o.id;
    });
    res.json(await one('SELECT * FROM orders WHERE id=$1', [orderId]));
  } catch (e) { next(e); }
});

r.put('/orders/:id', canPlan, async (req, res, next) => {
  try {
    const { po_number, customer_id, po_date, delivery_date, notes, lines = [] } = req.body;
    if (!po_number || !customer_id || !lines.length) {
      return res.status(400).json({ error: 'PO number, customer and at least one line are required' });
    }

    const orderId = +req.params.id;
    await tx(async (qc, oc) => {
      const order = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

      const customer = await oc('SELECT id FROM customers WHERE id=$1', [customer_id]);
      if (!customer) throw Object.assign(new Error('Customer not found'), { status: 400 });

      await qc(
        `UPDATE orders
         SET po_number=$1, customer_id=$2, po_date=$3, delivery_date=$4, notes=$5
         WHERE id=$6`,
        [po_number, customer_id, po_date || new Date().toISOString().slice(0, 10), delivery_date || null, notes || null, orderId]);

      const existing = await qc('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [orderId]);
      const keepIds = [];

      for (const l of lines) {
        if (!l.product_id || !l.qty) throw Object.assign(new Error('Each line needs a product and quantity'), { status: 400 });
        const product = await oc(`
          SELECT p.id, p.rate, p.customer_id, p.gst_pct, gr.rate AS type_gst
          FROM products p LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
          WHERE p.id=$1`, [l.product_id]);
        if (!product || String(product.customer_id) !== String(customer_id)) {
          throw Object.assign(new Error('Every product must belong to the selected customer'), { status: 400 });
        }

        const qty = Math.round(+l.qty);
        const rate = l.rate === undefined || l.rate === '' ? product.rate ?? 0 : +l.rate;
        const gst = resolveGst(l.gst, product);
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate)) {
          throw Object.assign(new Error('Line quantity and rate must be valid'), { status: 400 });
        }

        if (l.id) {
          const current = existing.find(x => x.id === +l.id);
          if (!current) throw Object.assign(new Error('Order line not found'), { status: 404 });
          if (qty < current.dispatched_qty) {
            throw Object.assign(new Error('Quantity cannot be below dispatched quantity'), { status: 400 });
          }
          await qc('UPDATE order_lines SET product_id=$1, qty=$2, rate=$3, gst_pct=$4 WHERE id=$5',
            [product.id, qty, rate, gst, current.id]);
          keepIds.push(current.id);
        } else {
          const cust = await oc('SELECT tolerance_pct FROM customers WHERE id=$1', [customer_id]);
          const [created] = await qc(
            'INSERT INTO order_lines (order_id, product_id, qty, rate, gst_pct, tolerance_pct) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [orderId, product.id, qty, rate, gst, cust?.tolerance_pct ?? 0]);
          keepIds.push(created.id);
        }
      }

      for (const line of existing) {
        if (keepIds.includes(line.id)) continue;
        const job = await oc('SELECT id FROM job_cards WHERE order_line_id=$1 LIMIT 1', [line.id]);
        if (line.dispatched_qty > 0 || job) {
          throw Object.assign(new Error('Cannot remove lines that already have dispatch or job card activity'), { status: 400 });
        }
        await qc('DELETE FROM order_lines WHERE id=$1', [line.id]);
      }

      await audit('order', orderId, 'update', po_number, qc, req.user.name);
    });

    const updated = await one(`
      SELECT o.*, c.name AS customer_name, c.city, c.gstin FROM orders o
      JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [orderId]);
    updated.lines = await q(`${LINE_VIEW} WHERE ol.order_id=$1 ORDER BY ol.id`, [orderId]);
    res.json(updated);
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/cancel', canPlan, async (req, res, next) => {
  try { res.json(await setLineStatus(+req.params.id, 'cancelled', q, one, req.user.name)); } catch (e) { next(e); }
});

// ── Pendency ────────────────────────────────────────────────────────────────
// What is still owed to customers: line-wise detail (workflow position, FG
// cover, ageing) plus product-wise and customer-wise roll-ups — the sales
// mirror of /procurement/pendency.
r.get('/sales/pendency', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT ol.id AS line_id, ol.order_id, o.po_number, o.po_date, o.delivery_date,
             c.id AS customer_id, c.name AS customer_name,
             p.id AS product_id, p.name AS product_name, p.code AS product_code, p.size,
             ol.qty, ol.dispatched_qty, (ol.qty - ol.dispatched_qty) AS pending_qty,
             ol.rate, ((ol.qty - ol.dispatched_qty) * ol.rate) AS pending_value,
             ol.status, COALESCE(fg.qty, 0)::int AS fg_qty,
             jc.jc_number, jc.status AS jc_status, jc.qty_planned, jc.qty_produced,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='in_progress' LIMIT 1) AS current_stage,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='pending' ORDER BY seq LIMIT 1) AS next_stage,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages,
             GREATEST(0, (now()::date - o.po_date::date))::int AS age_days,
             CASE WHEN o.delivery_date IS NOT NULL AND o.delivery_date::date < now()::date
                  THEN (now()::date - o.delivery_date::date)::int ELSE 0 END AS overdue_days
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      LEFT JOIN fg_stock fg ON fg.product_id = ol.product_id
      LEFT JOIN job_cards jc ON jc.order_line_id = ol.id
      WHERE o.status = 'open' AND ol.status NOT IN ('cancelled','dispatched')
        AND ol.qty > ol.dispatched_qty
      ORDER BY overdue_days DESC, o.delivery_date ASC NULLS LAST, ol.id`);

    // A job card still open means that quantity is in flight on the floor —
    // FG is only credited when the card closes.
    const wipOf = l => (l.jc_status && l.jc_status !== 'closed' ? +l.qty_planned || 0 : 0);

    const byProduct = {};
    for (const l of rows) {
      const m = (byProduct[l.product_id] ||= {
        key: l.product_id, label: l.product_name, code: l.product_code, size: l.size,
        pending_qty: 0, pending_value: 0, fg_qty: +l.fg_qty, wip_qty: 0,
        orders: new Set(), customers: new Set(), overdue: 0, max_age: 0,
      });
      m.pending_qty += +l.pending_qty;
      m.pending_value += +l.pending_value;
      m.wip_qty += wipOf(l);
      m.orders.add(l.order_id);
      m.customers.add(l.customer_id);
      m.overdue = Math.max(m.overdue, l.overdue_days);
      m.max_age = Math.max(m.max_age, l.age_days);
    }

    const byCustomer = {};
    for (const l of rows) {
      const m = (byCustomer[l.customer_id] ||= {
        key: l.customer_id, label: l.customer_name,
        pending_qty: 0, pending_value: 0, lines: 0, overdue_lines: 0,
        orders: new Set(), products: new Set(), overdue: 0, max_age: 0,
      });
      m.pending_qty += +l.pending_qty;
      m.pending_value += +l.pending_value;
      m.lines += 1;
      if (l.overdue_days > 0) m.overdue_lines += 1;
      m.orders.add(l.order_id);
      m.products.add(l.product_id);
      m.overdue = Math.max(m.overdue, l.overdue_days);
      m.max_age = Math.max(m.max_age, l.age_days);
    }

    res.json({
      lines: rows,
      by_product: Object.values(byProduct)
        .map(m => ({
          ...m, orders: m.orders.size, customers: m.customers.size,
          to_plan: Math.max(0, m.pending_qty - m.fg_qty - m.wip_qty),
        }))
        .sort((a, b) => b.pending_qty - a.pending_qty),
      by_customer: Object.values(byCustomer)
        .map(m => ({ ...m, orders: m.orders.size, products: m.products.size }))
        .sort((a, b) => b.pending_value - a.pending_value),
    });
  } catch (e) { next(e); }
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

// Master-driven spec fields a planner may edit in the planning engine.
// board_material_id joins the list so a warehouse stock selection follows the
// same philosophy: save for this job only, or update the Product Master.
const SPEC_FIELDS = ['ups', 'wastage_pct', 'colors', 'coating', 'special', 'child_l', 'child_w', 'board_material_id'];
const INT_SPEC = ['ups', 'colors', 'board_material_id'];
const TEXT_SPEC = ['coating', 'special'];

r.post('/order-lines/:id/plan', canPlan, async (req, res, next) => {
  try {
    // Press + date now live in Print Planning; the engine locks spec, cut plan
    // and remarks only. machine_id/planned_date are accepted for compatibility
    // but never required — absent values leave the stored ones untouched.
    const { machine_id, planned_date, tooling_ok, wastage_sheets, notes, spec = {}, update_master, leftover } = req.body;
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);

      // Which provided spec fields differ from the product master — and which
      // ones were deliberately set BACK to the master (clearing an override)?
      const changed = {};
      const cleared = [];
      for (const f of SPEC_FIELDS) {
        if (spec[f] === undefined || spec[f] === null || spec[f] === '') continue;
        const v = INT_SPEC.includes(f) ? Math.round(+spec[f]) : (TEXT_SPEC.includes(f) ? spec[f] : +spec[f]);
        if (String(v) !== String(product[f])) changed[f] = v;
        else cleared.push(f);
      }

      const prev = line.spec_override
        ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
        : {};

      // Master-update philosophy: either persist to the Product Master for all
      // future jobs, or keep the change scoped to this job as an override.
      let nextOverride = { ...prev };
      for (const f of cleared) delete nextOverride[f];
      if (Object.keys(changed).length) {
        if (update_master) {
          const sets = Object.keys(changed).map((c, i) => `${c}=$${i + 1}`).join(',');
          await qc(`UPDATE products SET ${sets} WHERE id=$${Object.keys(changed).length + 1}`,
            [...Object.values(changed), product.id]);
          for (const f of Object.keys(changed)) delete nextOverride[f];
          await audit('product', product.id, 'master_update', `from planning: ${Object.keys(changed).join(', ')}`, qc, req.user.name);
        } else {
          nextOverride = { ...nextOverride, ...changed };
          await audit('order_line', line.id, 'spec_override', `job-only: ${Object.keys(changed).join(', ')}`, qc, req.user.name);
        }
      }
      const jobOverride = Object.keys(nextOverride).length ? nextOverride : null;

      // Effective spec = master + surviving job override + this lock's changes.
      const eff = { ...product, ...nextOverride, ...changed };
      const wastage = wastage_sheets === '' || wastage_sheets == null ? null : Math.max(0, Math.round(+wastage_sheets));
      const sheets = sheetsRequired(eff, netProduceQty(line), wastage);
      const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id]);
      const fit = childFit(board, eff);
      const parentSheets = parentSheetsRequired(sheets, fit.count);
      // Leftover decision — validated against the effective board's real
      // strips so a stale client can't book nonsense. Rules:
      //   leftover sent        → store it (push:false stores NULL)
      //   leftover absent      → keep the saved decision, UNLESS the board
      //                          changed in this lock (strips no longer match).
      let leftoverPlan = null;
      if (leftover?.push && leftover.strip) {
        const strips = leftoverStrips(board, eff);
        const pick = strips.find(s =>
          Math.abs(s.l - +leftover.strip.l) < 0.01 && Math.abs(s.w - +leftover.strip.w) < 0.01);
        if (!pick) throw Object.assign(new Error('Leftover strip does not match this board\'s cut plan'), { status: 409 });
        if (!pick.usable) throw Object.assign(new Error(`Strip ${pick.l}×${pick.w}" is under 3" — waste, not stock`), { status: 409 });
        leftoverPlan = { push: true, strip: { l: pick.l, w: pick.w }, strips_per_parent: pick.strips_per_parent,
                         est_sheets: parentSheets, decided_by: req.user.name, decided_at: new Date().toISOString() };
      }
      const keepSaved = leftover === undefined && !changed.board_material_id;
      const prevPlan = typeof line.leftover_plan === 'string' ? JSON.parse(line.leftover_plan) : line.leftover_plan;
      const finalLeftover = leftover !== undefined ? leftoverPlan : (keepSaved ? prevPlan : null);
      await qc(`UPDATE order_lines SET machine_id=COALESCE($1, machine_id), planned_date=COALESCE($2, planned_date),
                  sheets_required=$3, parent_sheets_required=$4,
                  tooling_ok=COALESCE($5, tooling_ok), spec_override=$6, wastage_sheets=$7, notes=$8,
                  leftover_plan=$9 WHERE id=$10`,
        [machine_id || null, planned_date || null, sheets, parentSheets,
         tooling_ok === undefined ? null : (tooling_ok ? 1 : 0),
         jobOverride ? JSON.stringify(jobOverride) : null,
         wastage, notes === undefined ? line.notes : (notes || null),
         finalLeftover ? JSON.stringify(finalLeftover) : null, line.id]);
      // Gang printing guard: a gang shares ONE board. If this plan moved the
      // line onto a different board than its gang mates, it leaves the gang
      // (and a gang left with a single job dissolves). Simple and predictable.
      if (line.gang_run_id) {
        const mate = await oc(`
          SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_id
          FROM order_lines ol JOIN products p ON p.id=ol.product_id
          WHERE ol.gang_run_id=$1 AND ol.id != $2 LIMIT 1`, [line.gang_run_id, line.id]);
        if (mate && +mate.board_id !== +eff.board_material_id) {
          await qc('UPDATE order_lines SET gang_run_id=NULL WHERE id=$1', [line.id]);
          await audit('gang_run', line.gang_run_id, 'remove_line',
            `line ${line.id} left the gang — board changed to ${board?.name}`, qc, req.user.name);
          const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
          if (left.n < 2) {
            await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [line.gang_run_id]);
            await qc('DELETE FROM gang_runs WHERE id=$1', [line.gang_run_id]);
            await audit('gang_run', line.gang_run_id, 'dissolve', 'fewer than 2 jobs left', qc, req.user.name);
          }
        }
      }

      if (line.status === 'pending') await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
      await audit('order_line', line.id, 'planned',
        `${sheets} child → ${parentSheets} parent (${fit.count}/parent, ${eff.ups} ups, `
        + `${wastage != null ? `${wastage} wastage sheets` : `${eff.wastage_pct}% wastage`}`
        + `${changed.board_material_id ? `, board → ${board?.name}` : ''}`
        + `${finalLeftover?.push ? `, leftover ${finalLeftover.strip.l}×${finalLeftover.strip.w}" → warehouse` : ''})`, qc, req.user.name);
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

// Planning engine context — everything the planner needs on one screen:
// requirement, board stock position, committed demand, and open supply.
r.get('/planning/:lineId/context', async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.lineId]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    // ?board_material_id= previews the position of a different board (a
    // warehouse selection the planner hasn't locked yet).
    const matId = +req.query.board_material_id || line.board_material_id;
    const board = matId === line.board_material_id
      ? { id: matId, name: line.board_name, sheet_l: line.sheet_l, sheet_w: line.sheet_w }
      : await one('SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE id=$1', [matId]);

    const stock = await one(`
      SELECT
        COALESCE(SUM(CASE WHEN status='available' THEN qty END),0) AS available,
        COALESCE(SUM(CASE WHEN status='quarantine' THEN qty END),0) AS quarantine
      FROM stock_batches WHERE material_id=$1`, [matId]);

    const committed = await one(`
      SELECT COALESCE(SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)),0)::int AS sheets
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE ${EFF_BOARD_ID}=$1 AND ol.status IN ('planned','ready') AND ol.id != $2`,
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

    // FG warehouse position for this exact product (identity = product master:
    // customer, artwork/code/version, size, board are all part of the product).
    const fgLots = await q(`
      SELECT fl.*, jc.jc_number AS source_batch, o.po_number AS source_po
      FROM fg_lots fl
      LEFT JOIN job_cards jc ON jc.id=fl.job_card_id
      LEFT JOIN order_lines sol ON sol.id=fl.order_line_id
      LEFT JOIN orders o ON o.id=sol.order_id
      WHERE fl.product_id=$1 AND fl.status IN ('pending_verification','verified')
        AND (fl.qty - fl.consumed_qty) > 0
      ORDER BY fl.id`, [line.product_id]);
    const consumed = await q(`
      SELECT fc.*, fl.lot_number FROM fg_consumptions fc
      JOIN fg_lots fl ON fl.id=fc.fg_lot_id
      WHERE fc.order_line_id=$1 ORDER BY fc.id`, [line.id]);

    // Gang context — the other jobs sharing this press run and their combined
    // board need, so the planner sees the whole run while planning one job.
    let gang = null;
    if (line.gang_run_id) {
      try { gang = await gangDetail(line.gang_run_id); } catch { gang = null; }
    }

    // Expected guillotine offcut of this board + child pairing. The planner
    // decides here — once — whether cutting should bank it in the warehouse.
    const strips = leftoverStrips(
      { sheet_l: board?.sheet_l, sheet_w: board?.sheet_w },
      { child_l: line.child_l, child_w: line.child_w });
    const leftover = strips.length ? {
      strips: strips.map(s => ({ ...s, est_sheets: line.parent_sheets_required || 0 })),
      saved: line.leftover_plan || null,
    } : null;

    res.json({
      line,
      board,
      gang,
      leftover,
      stock: { ...stock, committed_other: committed.sheets },
      incoming: {
        prs: openPrs,
        pos: openPos.map(p => ({ ...p, pending_qty: Math.max(0, p.qty - p.received_qty) })),
      },
      batches,
      fg: {
        lots: fgLots.map(l => ({ ...l, remaining: l.qty - l.consumed_qty })),
        verified_available: fgLots.filter(l => l.status === 'verified')
          .reduce((s, l) => s + (l.qty - l.consumed_qty), 0),
        pending_verification: fgLots.filter(l => l.status === 'pending_verification')
          .reduce((s, l) => s + (l.qty - l.consumed_qty), 0),
        consumed_qty: line.fg_consumed_qty || 0,
        consumptions: consumed,
        balance_to_produce: netProduceQty(line),
      },
    });
  } catch (e) { next(e); }
});

// Smart Match — rank stocked boards that can produce this line's child sheet.
// Computed on demand (never on page load); ~250 boards, single aggregate query.
// ?sheets= lets the client match against its live cut-plan total,
// ?board_material_id= re-anchors matching when the planner previews a board,
// and ?child_l/?child_w match against an unlocked child-size edit.
r.get('/planning/:lineId/smart-match', async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.lineId]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const childL = +req.query.child_l, childW = +req.query.child_w;
    if (childL > 0 && childW > 0) { line.child_l = childL; line.child_w = childW; }
    const anchorId = +req.query.board_material_id || line.master_board_material_id;
    const childSheets = +req.query.sheets
      || line.sheets_required
      || sheetsRequired(line, netProduceQty(line), line.wastage_sheets);

    // One pass: every board with its free vs committed position. Committed
    // honours other lines' overrides so a stolen board shows as taken.
    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(cm.q,0) AS committed,
             COALESCE(src.name, m.name) AS match_name, COALESCE(src.spec, m.spec) AS match_spec
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT ${EFF_BOARD_ID} AS mid,
                        SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) AS q
                 FROM order_lines ol JOIN products p ON p.id=ol.product_id
                 WHERE ol.status IN ('planned','ready') AND ol.id != $1 GROUP BY 1) cm ON cm.mid=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND (COALESCE(av.q,0) > 0 OR m.id = $2)`,
      [line.id, anchorId]);

    const currentBoard = candidates.find(c => c.id === anchorId)
      || await one('SELECT * FROM materials WHERE id=$1', [anchorId]);
    const matches = rankBoardMatches({
      product: line,             // effective child_l/child_w/gsm from LINE_VIEW
      childSheets,
      currentBoard,
      candidates,
    });
    res.json({ child_sheets: childSheets, anchor_board_id: anchorId, matches: matches.slice(0, 12) });
  } catch (e) { next(e); }
});

// ── Artwork ─────────────────────────────────────────────────────────────────
r.get('/artwork', async (_req, res, next) => {
  try {
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('planned','ready') ORDER BY ol.artwork_locked, o.delivery_date NULLS LAST`);
    // Tooling chips: ONE query for every product on the page.
    const pids = [...new Set(rows.map(l => l.product_id))];
    const tools = pids.length ? await q(`
      SELECT * FROM tools
      WHERE product_id = ANY($1)
         OR id IN (SELECT tool_id FROM products WHERE id = ANY($1) AND tool_id IS NOT NULL)`,
      [pids]) : [];
    for (const l of rows) {
      const mine = tools.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      l.tooling = toolingDetail({ id: l.product_id, special: l.special, tool_id: l.tool_id }, mine);
      l.tooling_ready = toolingGateOk(l.tooling, l.tooling_ok);
    }
    res.json(rows);
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
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
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
      if (fresh.status === 'planned' && gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
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
    const shortage = Math.max(0, gate.parent_needed - gate.available_sheets);
    if (shortage === 0) return res.status(400).json({ error: 'No shortage for this line' });
    const boardRow = await one('SELECT leftover, name FROM materials WHERE id=$1', [gate.board_material_id]);
    if (boardRow?.leftover)
      return res.status(409).json({ error: `${boardRow.name} is a leftover offcut — raise the PR against its parent board instead.` });
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
