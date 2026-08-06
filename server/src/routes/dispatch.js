// Dispatch — produced lines with FG stock → challan → gone.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, forceLineStatus, fgIssue, fgReceipt, nextNumber, fgMove, boxLeftoverFromFg } from '../helpers.js';
import { requireRole } from '../auth.js';
import { cascadeAllocate, annotateReadyLines } from '../tolerance-cascade.js';
import { boxBreakdown } from '../box-math.js';
import { isShortage, shortfallOf, productionOver } from '../shortage.js';

const r = Router();
const canDispatch = requireRole('dispatch', 'planner');

// The physical box size for a product — how many pieces a full carton holds.
// Prefer the uniform size stamped on the latest completed pasting stage; when
// that's null (mixed box sizes were packed), fall back to the dominant packing
// line (the one with the most full boxes). Returns 0 when nothing is on record.
async function productQtyPerBox(productId, run) {
  const row = await run(`
    SELECT COALESCE(
             js.pack_qty_per_box,
             (SELECT pl.qty_per_box FROM packing_lines pl
              WHERE pl.job_stage_id=js.id AND pl.qty_per_box > 0
              ORDER BY pl.boxes DESC, pl.qty_per_box DESC LIMIT 1)
           ) AS qty_per_box
    FROM job_cards jc
    JOIN job_stages js ON js.job_card_id=jc.id AND js.stage='pasting' AND js.status='completed'
    -- The card's own product_id, NOT a hop through order_lines: a combined
    -- run's card has order_line_id NULL, so the old join meant a product made
    -- only on combined runs never had a box size on record and every leftover
    -- fell back to "one box for everything".
    WHERE jc.product_id=$1
    ORDER BY js.completed_at DESC NULLS LAST, js.id DESC
    LIMIT 1`, [productId]);
  const rec = Array.isArray(row) ? row[0] : row;
  return Math.max(0, Math.floor(+rec?.qty_per_box || 0));
}

// Open produced order lines wanting a product, priority by delivery date — the
// cascade order for FG-list dispatch across multiple sales orders.
const PRODUCED_LINES_SQL = `
  SELECT ol.id AS order_line_id, ol.order_id, ol.qty AS ordered, ol.dispatched_qty AS dispatched,
         COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS tolerance_pct,
         o.po_number, o.delivery_date, c.name AS customer_name
  FROM order_lines ol
  JOIN orders o ON o.id=ol.order_id
  JOIN customers c ON c.id=o.customer_id
  WHERE ol.product_id=$1 AND ol.status='produced'
  ORDER BY o.delivery_date NULLS LAST, ol.id`;

r.get('/dispatch/ready', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT ol.id AS order_line_id, ol.qty, ol.dispatched_qty, ol.rate, ol.order_id,
             COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS tolerance_pct,
             o.po_number, o.delivery_date, c.id AS customer_id, c.name AS customer_name, c.city,
             p.id AS product_id, p.name AS product_name, p.code,
             COALESCE(f.qty,0) AS fg_qty,
             jc.id AS job_card_id, jc.qty_produced, jc.status AS jc_status,
             pk.pack_boxes, pk.pack_qty_per_box, pk.packed_total,
             GREATEST(0, COALESCE(jc.qty_produced,0) - ol.dispatched_qty
                         - COALESCE(lot.lotted,0) - (ol.qty - ol.dispatched_qty)) AS excess_available
      FROM order_lines ol
      JOIN orders o ON o.id=ol.order_id
      JOIN customers c ON c.id=o.customer_id
      JOIN products p ON p.id=ol.product_id
      LEFT JOIN fg_stock f ON f.product_id=p.id
      LEFT JOIN job_cards jc ON jc.order_line_id=ol.id
      LEFT JOIN LATERAL (
        SELECT js.pack_boxes, js.pack_qty_per_box,
               (SELECT COALESCE(SUM(total),0)::int FROM packing_lines WHERE job_stage_id=js.id) AS packed_total
        FROM job_stages js WHERE js.job_card_id=jc.id AND js.stage='pasting' AND js.status='completed'
        LIMIT 1) pk ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(fl.qty),0)::int AS lotted FROM fg_lots fl
        WHERE fl.job_card_id=jc.id AND fl.status != 'rejected') lot ON true
      WHERE ol.status='produced' AND COALESCE(f.qty,0) > 0
      ORDER BY o.delivery_date NULLS LAST`);

    // Suggested dispatch and the leftover that follows it are DERIVED FROM THE
    // SAME cascade the Move FG preview runs — see annotateReadyLines(), which is
    // pure so the shared-pool double-count is covered by tests rather than hope.
    const perBox = new Map();
    for (const id of new Set(rows.map(l => l.product_id))) perBox.set(id, await productQtyPerBox(id, q));
    annotateReadyLines(rows, perBox);
    for (const l of rows) {
      const { boxes, loose } = boxBreakdown(l.leftover_qty, l.qty_per_box);
      l.leftover_boxes = boxes;
      l.leftover_loose = loose;
      // A line still in production is not short — more is coming. Only a closed
      // job card makes the gap final and the two decisions worth offering.
      l.production_over = productionOver(l);
      l.is_shortage = isShortage(l);
      l.shortfall_qty = l.is_shortage ? shortfallOf(l) : 0;
      // How many cartons this line's dispatch would physically fill.
      l.suggested_boxes = boxBreakdown(l.suggested_dispatch, l.qty_per_box).boxes;
    }
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/dispatches', async (_req, res, next) => {
  try {
    const ds = await q(`
      SELECT d.*, c.name AS customer_name, c.city, o.po_number
      FROM dispatches d JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id ORDER BY d.id DESC`);
    const lines = await q(`
      SELECT dl.*, p.name AS product_name, p.code FROM dispatch_lines dl
      JOIN products p ON p.id=dl.product_id`);
    const byD = {};
    for (const l of lines) (byD[l.dispatch_id] ||= []).push(l);
    res.json(ds.map(d => ({ ...d, lines: byD[d.id] || [] })));
  } catch (e) { next(e); }
});

r.get('/dispatches/:id', async (req, res, next) => {
  try {
    const d = await one(`
      SELECT d.*, c.name AS customer_name, c.city, c.state, c.gstin, o.po_number, o.po_date
      FROM dispatches d JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id WHERE d.id=$1`, [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    d.lines = await q(`
      SELECT dl.*, p.name AS product_name, p.code, p.size,
             ol.qty AS ordered_qty, ol.dispatched_qty AS line_dispatched_qty, ol.status AS line_status,
             COALESCE(ol.tolerance_pct, c2.tolerance_pct, 0) AS tolerance_pct,
             COALESCE(f.qty,0) AS fg_qty,
             il.invoice_id, i.invoice_number,
             co.id AS coa_id, co.coa_number, co.status AS coa_status,
             pk.pack_boxes, pk.pack_qty_per_box, pk.packed_total
      FROM dispatch_lines dl
      JOIN products p ON p.id=dl.product_id
      JOIN order_lines ol ON ol.id=dl.order_line_id
      JOIN orders o2 ON o2.id=ol.order_id
      JOIN customers c2 ON c2.id=o2.customer_id
      LEFT JOIN fg_stock f ON f.product_id=p.id
      LEFT JOIN invoice_lines il ON il.dispatch_line_id=dl.id
      LEFT JOIN invoices i ON i.id=il.invoice_id
      LEFT JOIN coas co ON co.dispatch_line_id=dl.id
      LEFT JOIN LATERAL (
        SELECT js.pack_boxes, js.pack_qty_per_box,
               (SELECT COALESCE(SUM(total),0)::int FROM packing_lines WHERE job_stage_id=js.id) AS packed_total
        FROM job_cards jc JOIN job_stages js ON js.job_card_id=jc.id AND js.stage='pasting' AND js.status='completed'
        WHERE jc.order_line_id=dl.order_line_id LIMIT 1) pk ON true
      WHERE dl.dispatch_id=$1 ORDER BY dl.id`, [d.id]);
    res.json(d);
  } catch (e) { next(e); }
});

// Create a challan for one order's produced lines. FG issued atomically.
// Customer tolerance: dispatch may exceed the ordered quantity up to the
// tolerance snapshot on the line. Beyond that, a structured 409 comes back so
// the UI can offer: dispatch as entered (override) / trim to tolerance /
// edit manually / move the excess to the FG warehouse.
r.post('/dispatches', canDispatch, async (req, res, next) => {
  try {
    const { order_id, vehicle, driver, notes, lines, tolerance_override } = req.body;
    if (!order_id || !lines?.length) return res.status(400).json({ error: 'Order and at least one line are required' });
    const dId = await tx(async (qc, oc) => {
      const order = await oc('SELECT * FROM orders WHERE id=$1', [order_id]);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      const challan_number = await nextNumber('CI-CH-', 'dispatches', 'challan_number', oc);
      const [d] = await qc(
        'INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [challan_number, order_id, order.customer_id, vehicle || null, driver || null, notes || null]);

      for (const l of lines) {
        const ol = await oc(`
          SELECT ol.*, COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance,
                 p.name AS product_name
          FROM order_lines ol
          JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
          JOIN products p ON p.id=ol.product_id
          WHERE ol.id=$1 FOR UPDATE OF ol`, [l.order_line_id]);
        if (!ol || ol.status !== 'produced')
          throw Object.assign(new Error('Line is not ready for dispatch'), { status: 409 });
        const qty = +l.qty;
        if (!qty || qty <= 0) throw Object.assign(new Error('Dispatch quantity must be positive'), { status: 400 });

        const allowedMax = Math.floor(ol.qty * (1 + ol.eff_tolerance / 100));
        const total = ol.dispatched_qty + qty;
        if (total > allowedMax && !tolerance_override) {
          const e = new Error(
            `This dispatch exceeds the customer tolerance against this PO for ${ol.product_name} — ` +
            `ordered ${ol.qty}, already dispatched ${ol.dispatched_qty}, proposed ${qty}, ` +
            `total ${total} vs allowed ${allowedMax} (±${ol.eff_tolerance}%).`);
          e.status = 409;
          e.body = {
            code: 'TOLERANCE_EXCEEDED',
            line: {
              order_line_id: ol.id, product_name: ol.product_name,
              ordered: ol.qty, dispatched: ol.dispatched_qty, proposed: qty,
              total, allowed_max: allowedMax, tolerance_pct: ol.eff_tolerance,
              tolerance_room: Math.max(0, allowedMax - ol.dispatched_qty),
            },
          };
          throw e;
        }
        if (total > allowedMax) {
          await audit('order_line', ol.id, 'tolerance_override',
            `dispatch ${qty} → total ${total} vs allowed ${allowedMax} (±${ol.eff_tolerance}% of ${ol.qty})`,
            qc, req.user.name);
        }
        if (qty !== (ol.qty - ol.dispatched_qty)) {
          await audit('order_line', ol.id, 'dispatch_qty_manual',
            `balance ${ol.qty - ol.dispatched_qty}, dispatched ${qty}`, qc, req.user.name);
        }

        await fgIssue(ol.product_id, qty, 'dispatch', d.id, qc, oc);
        await qc('INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES ($1,$2,$3,$4)',
          [d.id, ol.id, ol.product_id, qty]);
        const newDispatched = ol.dispatched_qty + qty;
        await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [newDispatched, ol.id]);
        if (newDispatched >= ol.qty) await setLineStatus(ol.id, 'dispatched', qc, oc, req.user.name);
      }
      const open = await oc(
        `SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [order_id]);
      if (open.n === 0) await qc(`UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'`, [order_id]);
      await audit('dispatch', d.id, 'create', challan_number, qc, req.user.name);
      return d.id;
    });
    res.json(await one('SELECT * FROM dispatches WHERE id=$1', [dId]));
  } catch (e) { next(e); }
});

// Edit a challan after the fact. Header fields (vehicle/driver/notes) are
// always editable. Line quantities move real FG stock — an increase issues
// more FG (tolerance-guarded exactly like creation), a decrease returns the
// difference to the FG warehouse, zero removes the line. A line that is
// already on a tax invoice is frozen: fix the invoice first.
r.put('/dispatches/:id', canDispatch, async (req, res, next) => {
  try {
    const { vehicle, driver, notes, lines, tolerance_override } = req.body;
    await tx(async (qc, oc) => {
      const d = await oc('SELECT * FROM dispatches WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!d) throw Object.assign(new Error('Dispatch not found'), { status: 404 });

      await qc('UPDATE dispatches SET vehicle=$1, driver=$2, notes=$3 WHERE id=$4',
        [vehicle !== undefined ? (vehicle || null) : d.vehicle,
         driver !== undefined ? (driver || null) : d.driver,
         notes !== undefined ? (notes || null) : d.notes, d.id]);

      for (const l of lines || []) {
        const dl = await oc(`
          SELECT dl.*, ol.qty AS ordered, ol.dispatched_qty, ol.status AS line_status,
                 COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance,
                 p.name AS product_name
          FROM dispatch_lines dl
          JOIN order_lines ol ON ol.id=dl.order_line_id
          JOIN orders o ON o.id=ol.order_id
          JOIN customers c ON c.id=o.customer_id
          JOIN products p ON p.id=dl.product_id
          WHERE dl.id=$1 AND dl.dispatch_id=$2 FOR UPDATE OF dl, ol`, [l.dispatch_line_id, d.id]);
        if (!dl) throw Object.assign(new Error('Dispatch line not found on this challan'), { status: 404 });

        const newQty = Math.max(0, Math.round(+l.qty || 0));
        if (newQty === dl.qty) continue;

        const inv = await oc(`
          SELECT i.invoice_number FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id
          WHERE il.dispatch_line_id=$1`, [dl.id]);
        if (inv)
          throw Object.assign(new Error(`${dl.product_name} is billed on ${inv.invoice_number} — edit that invoice first`), { status: 409 });

        const delta = newQty - dl.qty;
        const totalAfter = dl.dispatched_qty + delta;

        if (delta > 0) {
          const allowedMax = Math.floor(dl.ordered * (1 + dl.eff_tolerance / 100));
          if (totalAfter > allowedMax && !tolerance_override) {
            const e = new Error(
              `This edit takes ${dl.product_name} beyond the customer tolerance — ` +
              `total ${totalAfter} vs allowed ${allowedMax} (±${dl.eff_tolerance}%).`);
            e.status = 409;
            e.body = {
              code: 'TOLERANCE_EXCEEDED',
              line: {
                order_line_id: dl.order_line_id, dispatch_line_id: dl.id, product_name: dl.product_name,
                ordered: dl.ordered, dispatched: dl.dispatched_qty - dl.qty, proposed: newQty,
                total: totalAfter, allowed_max: allowedMax, tolerance_pct: dl.eff_tolerance,
                tolerance_room: Math.max(0, allowedMax - (dl.dispatched_qty - dl.qty)),
              },
            };
            throw e;
          }
          if (totalAfter > allowedMax) {
            await audit('order_line', dl.order_line_id, 'tolerance_override',
              `challan edit +${delta} → total ${totalAfter} vs allowed ${allowedMax} (±${dl.eff_tolerance}% of ${dl.ordered})`,
              qc, req.user.name);
          }
          await fgIssue(dl.product_id, delta, 'dispatch_edit', d.id, qc, oc);
        } else {
          await fgReceipt(dl.product_id, -delta, 'dispatch_edit', d.id, qc);
        }

        if (newQty === 0) {
          const coa = await oc('SELECT * FROM coas WHERE dispatch_line_id=$1', [dl.id]);
          if (coa?.status === 'issued')
            throw Object.assign(new Error(`${coa.coa_number} is issued against this line — reopen the COA before removing it`), { status: 409 });
          if (coa) await qc('DELETE FROM coas WHERE id=$1', [coa.id]);
          await qc('DELETE FROM dispatch_lines WHERE id=$1', [dl.id]);
        } else {
          await qc('UPDATE dispatch_lines SET qty=$1 WHERE id=$2', [newQty, dl.id]);
          await qc(`UPDATE coas SET qty=$1, updated_at=now() WHERE dispatch_line_id=$2 AND status='draft'`, [newQty, dl.id]);
        }

        await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [totalAfter, dl.order_line_id]);
        if (dl.line_status === 'dispatched' && totalAfter < dl.ordered)
          await forceLineStatus(dl.order_line_id, 'produced', 'challan edit reduced the dispatched quantity', qc, oc, req.user.name);
        else if (dl.line_status === 'produced' && totalAfter >= dl.ordered)
          await setLineStatus(dl.order_line_id, 'dispatched', qc, oc, req.user.name);

        await audit('dispatch', d.id, 'edit_line',
          `${dl.product_name}: ${dl.qty} → ${newQty}`, qc, req.user.name);
      }

      // The order follows its lines: reopen if anything is pending again.
      const open = await oc(
        `SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [d.order_id]);
      await qc(`UPDATE orders SET status=$1 WHERE id=$2 AND status NOT IN ('cancelled','hold','closed')`,
        [open.n === 0 ? 'completed' : 'pending', d.order_id]);
      await audit('dispatch', d.id, 'edit', d.challan_number, qc, req.user.name);
    });
    // Return the same shape the detail view reads.
    const d = await one(`
      SELECT d.*, c.name AS customer_name, c.city, c.state, c.gstin, o.po_number, o.po_date
      FROM dispatches d JOIN customers c ON c.id=d.customer_id
      JOIN orders o ON o.id=d.order_id WHERE d.id=$1`, [req.params.id]);
    res.json(d);
  } catch (e) { next(e); }
});

// FG-list movement preview — for a product, how the on-hand FG would cascade
// across its open sales orders within tolerance, and what would be left over.
r.get('/fg/movement-preview', async (req, res, next) => {
  try {
    const productId = +req.query.product_id;
    if (!productId) return res.status(400).json({ error: 'product_id is required' });
    const overrideAvail = req.query.qty != null && req.query.qty !== '' ? Math.max(0, Math.floor(+req.query.qty)) : null;
    const fg = (await one('SELECT qty FROM fg_stock WHERE product_id=$1', [productId]))?.qty || 0;
    const available = overrideAvail != null ? Math.min(overrideAvail, fg) : fg;
    const lines = await q(PRODUCED_LINES_SQL, [productId]);
    const plan = cascadeAllocate(available, lines);
    const p = await one('SELECT name, code FROM products WHERE id=$1', [productId]);
    const qty_per_box = await productQtyPerBox(productId, q);
    res.json({ product_id: productId, product_name: p?.name, product_code: p?.code, fg_stock: fg, available, qty_per_box, ...plan });
  } catch (e) { next(e); }
});

// FG-list movement execute — the single place FG material moves. Creates one
// challan per sales order for the dispatch allocations (tolerance already
// respected by the cascade) and boxes any leftover as a numbered leftover box.
// mode: 'dispatch' (allocations [+ optional leftover]) | 'leftover' (box only).
// The one place FG material moves for a single product. Extracted from the
// route so /fg/move-bulk can run it for many products inside ONE transaction —
// a partly-applied bulk dispatch (three challans raised, the fourth rejected)
// would leave the plant reconciling by hand. Both callers therefore share this
// body rather than a second copy of the tolerance and boxing rules.
export async function applyFgMove({ product_id, mode, allocations = [], leftover_qty = 0, vehicle, driver, notes }, qc, oc, user) {
    const out = { challans: [], box: null, boxes: [] };

    if (mode === 'dispatch') {
      // Group the per-line allocations by their sales order → one challan each.
      const byOrder = {};
      for (const a of allocations) {
        if (!(+a.qty > 0)) continue;
        const ol = await oc(`
          SELECT ol.*, COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance, p.name AS product_name
          FROM order_lines ol JOIN orders o ON o.id=ol.order_id JOIN customers c ON c.id=o.customer_id
          JOIN products p ON p.id=ol.product_id
          WHERE ol.id=$1 FOR UPDATE OF ol`, [a.order_line_id]);
        if (!ol || ol.status !== 'produced') throw Object.assign(new Error('A selected line is no longer ready for dispatch'), { status: 409 });
        if (ol.product_id !== +product_id) throw Object.assign(new Error('All lines must be for the same product'), { status: 409 });
        const qty = Math.floor(+a.qty);
        const allowedMax = Math.floor(ol.qty * (1 + ol.eff_tolerance / 100));
        if (ol.dispatched_qty + qty > allowedMax)
          throw Object.assign(new Error(`${ol.product_name}: ${qty} exceeds the ±${ol.eff_tolerance}% tolerance on ${ol.id}`), { status: 409 });
        (byOrder[ol.order_id] ||= []).push({ ol, qty });
      }
      for (const [orderId, items] of Object.entries(byOrder)) {
        const order = await oc('SELECT * FROM orders WHERE id=$1', [orderId]);
        const challan_number = await nextNumber('CI-CH-', 'dispatches', 'challan_number', oc);
        const [d] = await qc('INSERT INTO dispatches (challan_number, order_id, customer_id, vehicle, driver, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [challan_number, orderId, order.customer_id, vehicle || null, driver || null, notes || null]);
        for (const { ol, qty } of items) {
          await fgIssue(ol.product_id, qty, 'dispatch', d.id, qc, oc);
          await qc('INSERT INTO dispatch_lines (dispatch_id, order_line_id, product_id, qty) VALUES ($1,$2,$3,$4)', [d.id, ol.id, ol.product_id, qty]);
          const nd = ol.dispatched_qty + qty;
          await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [nd, ol.id]);
          if (nd >= ol.qty) await setLineStatus(ol.id, 'dispatched', qc, oc, user);
        }
        const open = await oc(`SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [orderId]);
        if (open.n === 0) await qc(`UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'`, [orderId]);
        await audit('dispatch', d.id, 'create', `${challan_number} (FG-list move)`, qc, user);
        out.challans.push({ id: d.id, challan_number });
      }
    }

    // Box the leftover — a PHYSICAL move: the qty leaves loose fg_stock and
    // lives in numbered boxes (so FG "In Stock" drops, no double count). One
    // individually-numbered box per physical carton + one for any loose
    // remainder, sized by the product's real per-box packing.
    const boxQty = Math.floor(+leftover_qty || 0);
    if (boxQty > 0) {
      // Guard inside the tx: never box more than is actually in loose stock.
      const stock = (await oc('SELECT qty FROM fg_stock WHERE product_id=$1 FOR UPDATE', [product_id]))?.qty || 0;
      if (boxQty > stock)
        throw Object.assign(new Error(`Cannot box ${boxQty} — only ${stock} in FG stock`), { status: 409 });

      const per = await productQtyPerBox(product_id, oc);
      const { boxes, loose } = boxBreakdown(boxQty, per);
      // A full carton each, then a single box for the loose remainder. If no
      // per-box size is on record, fall back to one box for the whole qty.
      const chunks = per > 0
        ? [...Array(boxes).fill(per), ...(loose > 0 ? [loose] : [])]
        : [boxQty];
      for (const chunkQty of chunks) {
        const box = await boxLeftoverFromFg(
          { product_id, qty: chunkQty, created_by: user, remarks: `Boxed as leftover from FG list` }, qc, oc);
        if (box) out.boxes.push({ box_number: box.box_number, lot_number: box.lot_number, qty: box.qty });
      }
      out.box = out.boxes[0] || null;   // backward-compat: first box
    }
  return out;
}

// FG-list movement execute — one product.
// mode: 'dispatch' (allocations [+ optional leftover]) | 'leftover' (box only).
r.post('/fg/move', canDispatch, async (req, res, next) => {
  try {
    if (!req.body.product_id) return res.status(400).json({ error: 'product_id is required' });
    res.json(await tx((qc, oc) => applyFgMove(req.body, qc, oc, req.user.name)));
  } catch (e) { next(e); }
});

// Bulk movement — many products, ONE transaction. `moves` is the per-product
// payload /fg/move takes. Either every challan is raised and every leftover
// boxed, or nothing is: a 409 on the last product rolls the earlier ones back.
r.post('/fg/move-bulk', canDispatch, async (req, res, next) => {
  try {
    const moves = Array.isArray(req.body.moves) ? req.body.moves : [];
    if (!moves.length) return res.status(400).json({ error: 'At least one move is required' });
    if (moves.some(m => !m.product_id)) return res.status(400).json({ error: 'Every move needs a product_id' });
    const { vehicle, driver, notes } = req.body;
    const out = await tx(async (qc, oc) => {
      const all = { challans: [], boxes: [], products: 0 };
      for (const m of moves) {
        const r1 = await applyFgMove({ ...m, vehicle: m.vehicle ?? vehicle, driver: m.driver ?? driver, notes: m.notes ?? notes }, qc, oc, req.user.name);
        all.challans.push(...r1.challans);
        all.boxes.push(...r1.boxes);
        all.products++;
      }
      return all;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Resolve a shortage — the line made less than the order wants and production
// is over. Two decisions, and only these two:
//
//   close  — dispatch whatever finished goods exist, then close the line short.
//            The customer gets what was made; the gap is accepted and the sales
//            order completes if this was its last open line.
//   replan — hand the line back to the planner to make the BALANCE. It returns
//            to 'planned' and netProduceQty() nets what already shipped, so the
//            new job card is raised for the shortfall and not the whole order.
// Resolve a shortage — the line made less than the order wants and production
// is over. Two decisions, and only these two:
//
//   close  — dispatch whatever finished goods exist, then close the line short.
//            The customer gets what was made; the gap is accepted and the sales
//            order completes if this was its last open line.
//   replan — hand the line back to the planner to make the BALANCE. It returns
//            to 'planned' and netProduceQty() nets what already shipped, so the
//            new job card is raised for the shortfall and not the whole order.
//
// Extracted from the route so the two paths can actually be RUN against a
// database in a test. Until they were, the riskiest new code in Dispatch had
// never once executed — no live line has ever qualified as a shortage.
export async function resolveShortage({ lineId, action, reason, vehicle, driver }, qc, oc, user) {
    const ol = await oc(`
      SELECT ol.*, jc.status AS jc_status, jc.jc_number, p.name AS product_name,
             COALESCE(f.qty,0) AS fg_qty,
             COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance
      FROM order_lines ol
      JOIN orders o ON o.id=ol.order_id
      JOIN customers c ON c.id=o.customer_id
      JOIN products p ON p.id=ol.product_id
      LEFT JOIN fg_stock f ON f.product_id=ol.product_id
      LEFT JOIN job_cards jc ON jc.order_line_id=ol.id
      WHERE ol.id=$1 FOR UPDATE OF ol`, [lineId]);
    if (!ol) throw Object.assign(new Error('Order line not found'), { status: 404 });
    if (ol.status !== 'produced')
      throw Object.assign(new Error(`This line is '${ol.status}', not awaiting dispatch`), { status: 409 });
    // Guard the premise rather than trusting the screen: production must be
    // over. A line whose card is still open is not short, it is unfinished,
    // and closing or re-planning it would abandon a run that is still going.
    if (!productionOver({ jc_status: ol.jc_status }))
      throw Object.assign(new Error(
        `${ol.jc_number || 'The job card'} has not closed yet — this line is still in production, not short`), { status: 409 });

    if (action === 'replan') {
      await setLineStatus(ol.id, 'planned', qc, oc, user);
      await audit('order_line', ol.id, 'shortage:replan',
        `short — back to Planning for the balance (${reason})`, qc, user);
      return { action, order_line_id: ol.id, balance_to_produce: Math.max(0, ol.qty - (ol.fg_consumed_qty || 0) - ol.dispatched_qty) };
    }

    // close — ship what exists (within tolerance), then close the gap.
    const room = Math.max(0, Math.floor(ol.qty * (1 + ol.eff_tolerance / 100)) - ol.dispatched_qty);
    const send = Math.max(0, Math.min(ol.fg_qty, room));
    let challan = null;
    if (send > 0) {
      const r1 = await applyFgMove({ product_id: ol.product_id, mode: 'dispatch',
        allocations: [{ order_line_id: ol.id, qty: send }],
        vehicle: vehicle, driver: driver }, qc, oc, user);
      challan = r1.challans[0] || null;
    }
    // applyFgMove only flips the line to 'dispatched' when the order is FULLY
    // met. Closing short is the deliberate exception, so force it and say why.
    const after = await oc('SELECT status, dispatched_qty FROM order_lines WHERE id=$1', [ol.id]);
    if (after.status !== 'dispatched')
      await forceLineStatus(ol.id, 'dispatched', `closed short — ${reason}`, qc, oc, user);
    const shortBy = Math.max(0, ol.qty - after.dispatched_qty);
    await audit('order_line', ol.id, 'shortage:close',
      `closed ${shortBy} short of ${ol.qty} (${reason})`, qc, user);

    const open = await oc(`SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [ol.order_id]);
    let order_completed = false;
    if (open.n === 0) {
      await qc(`UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'`, [ol.order_id]);
      order_completed = true;
    }
    return { action, order_line_id: ol.id, dispatched: send, short_by: shortBy, challan, order_completed };
}

r.post('/order-lines/:id/shortage', canDispatch, async (req, res, next) => {
  try {
    const { action, reason = '', vehicle, driver } = req.body;
    if (!['close', 'replan'].includes(action))
      return res.status(400).json({ error: "action must be 'close' or 'replan'" });
    if (!reason.trim()) return res.status(400).json({ error: 'A reason is required to resolve a shortage' });
    res.json(await tx((qc, oc) => resolveShortage(
      { lineId: req.params.id, action, reason: reason.trim(), vehicle, driver }, qc, oc, req.user.name)));
  } catch (e) { next(e); }
});

// Cancel a whole challan — reverse every line back to FG stock and delete the
// dispatch. The reverse-of-dispatch decision, one click. Blocked if any line is
// already billed (remove it from the invoice first) or carries an issued COA.
r.post('/dispatches/:id/cancel', canDispatch, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const d = await oc('SELECT * FROM dispatches WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!d) throw Object.assign(new Error('Challan not found'), { status: 404 });
      const dls = await qc(`
        SELECT dl.*, ol.qty AS ordered, ol.dispatched_qty, ol.status AS line_status, p.name AS product_name
        FROM dispatch_lines dl
        JOIN order_lines ol ON ol.id=dl.order_line_id
        JOIN products p ON p.id=dl.product_id
        WHERE dl.dispatch_id=$1 FOR UPDATE OF dl, ol`, [d.id]);
      // Guard: nothing on this challan may be billed or have an issued COA.
      for (const dl of dls) {
        const inv = await oc(`SELECT i.invoice_number FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id WHERE il.dispatch_line_id=$1`, [dl.id]);
        if (inv) throw Object.assign(new Error(`${dl.product_name} is billed on ${inv.invoice_number} — remove it from that invoice first`), { status: 409 });
        const coa = await oc(`SELECT coa_number, status FROM coas WHERE dispatch_line_id=$1`, [dl.id]);
        if (coa?.status === 'issued') throw Object.assign(new Error(`${coa.coa_number} is issued against ${dl.product_name} — reopen the COA first`), { status: 409 });
      }
      for (const dl of dls) {
        await qc('DELETE FROM coas WHERE dispatch_line_id=$1', [dl.id]);
        await fgReceipt(dl.product_id, dl.qty, 'dispatch_cancel', d.id, qc);   // goods back to FG
        const nd = Math.max(0, dl.dispatched_qty - dl.qty);
        await qc('UPDATE order_lines SET dispatched_qty=$1 WHERE id=$2', [nd, dl.order_line_id]);
        if (dl.line_status === 'dispatched' && nd < dl.ordered)
          await forceLineStatus(dl.order_line_id, 'produced', `challan ${d.challan_number} cancelled`, qc, oc, req.user.name);
        await qc('DELETE FROM dispatch_lines WHERE id=$1', [dl.id]);
      }
      await qc(`UPDATE orders SET status='pending' WHERE id=$1 AND status='completed'`, [d.order_id]);
      await audit('dispatch', d.id, 'cancel', `${d.challan_number} cancelled — ${dls.length} line(s) returned to FG stock`, qc, req.user.name);
      await qc('DELETE FROM dispatches WHERE id=$1', [d.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
