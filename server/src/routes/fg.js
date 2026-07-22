// FG lots — labelled excess stock in the Finished Goods warehouse.
// Excess from a closed job card is pushed here as a lot (CI-FG-0001…),
// physically verified, and only then consumable by the planning engine
// against a future order line for the same product.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, netProduceQty, sheetsRequired, childFit, parentSheetsRequired, effectiveProduct, fgMove, fgMatchPredicate, moveLeftoverBoxToFg, fgReceipt } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canStore = requireRole('planner', 'dispatch', 'production');
const canVerify = requireRole('qc', 'planner');
const canPlan = requireRole('planner');

const LOT_VIEW = `
  SELECT fl.*, (fl.qty - fl.consumed_qty) AS remaining,
         p.name AS product_name, p.code AS product_code,
         jc.jc_number AS source_batch,
         c.name AS customer_name, o.po_number AS source_po
  FROM fg_lots fl
  JOIN products p ON p.id=fl.product_id
  LEFT JOIN job_cards jc ON jc.id=fl.job_card_id
  LEFT JOIN order_lines sol ON sol.id=fl.order_line_id
  LEFT JOIN orders o ON o.id=sol.order_id
  LEFT JOIN customers c ON c.id=p.customer_id`;

r.get('/fg-lots', async (_req, res, next) => {
  try {
    res.json(await q(`${LOT_VIEW} ORDER BY (fl.status='pending_verification') DESC, fl.id DESC`));
  } catch (e) { next(e); }
});

// Push excess from a closed job card into an FG lot. The physical cartons are
// already in fg_stock (QC credited them at job close) — the lot labels and
// ring-fences the excess so it can be verified and consumed by planning.
r.post('/fg-lots', canStore, async (req, res, next) => {
  try {
    const { job_card_id, qty, box_count, qty_per_box, loose_qty, location, note, source, kind } = req.body;
    if (!job_card_id || !qty || +qty <= 0)
      return res.status(400).json({ error: 'Job card and a positive quantity are required' });
    const lotId = await tx(async (qc, oc) => {
      const jc = await oc(`
        SELECT jc.*, ol.qty AS ordered_qty, ol.dispatched_qty
        FROM job_cards jc JOIN order_lines ol ON ol.id=jc.order_line_id
        WHERE jc.id=$1 FOR UPDATE OF jc`, [job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status !== 'closed') throw Object.assign(new Error('Only a closed (QC-passed) batch can push excess to FG'), { status: 409 });

      const lotted = await oc(
        `SELECT COALESCE(SUM(qty),0)::int AS n FROM fg_lots WHERE job_card_id=$1 AND status != 'rejected'`, [job_card_id]);
      const excess = Math.max(0, jc.qty_produced - jc.ordered_qty) - lotted.n;
      if (+qty > excess)
        throw Object.assign(new Error(`Only ${excess} excess pieces remain on this batch (produced ${jc.qty_produced}, ordered ${jc.ordered_qty}, already lotted ${lotted.n})`), { status: 409 });

      const lot_number = await nextNumber('CI-FG-', 'fg_lots', 'lot_number', oc);
      // Every lot is a physical, numbered box — CI-BOX-#### is auto-allocated
      // and editable afterwards (PUT /fg-lots/:id).
      const box_number = await nextNumber('CI-BOX-', 'fg_lots', 'box_number', oc);
      const [lot] = await qc(`
        INSERT INTO fg_lots (lot_number, box_number, kind, product_id, job_card_id, order_line_id, qty,
                             box_count, qty_per_box, loose_qty, source, location, note, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [lot_number, box_number, kind === 'leftover' ? 'leftover' : 'fg_excess',
         jc.product_id, jc.id, jc.order_line_id, +qty,
         box_count ? +box_count : null, qty_per_box ? +qty_per_box : null, loose_qty ? +loose_qty : null,
         source || 'dispatch_excess', location || jc.fg_location || 'FG-STORE', note || null, req.user.name]);
      await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,'adjustment',0,'fg_lot',$2,$3)`,
        [jc.product_id, lot.id, `Excess moved to FG lot ${lot_number} (${qty} pcs from batch ${jc.jc_number})`]);

      // FG Warehouse ledger: this lot is a new stock reference. If the same
      // finished good was previously consumed against an order, link the excess
      // back to that reference (parent-child) so re-production is traceable.
      const parent = await oc(`
        SELECT pl.lot_number FROM fg_lots pl
        JOIN products fp ON fp.id = pl.product_id
        JOIN products p ON p.id = $1
        WHERE pl.id != $2 AND pl.consumed_qty > 0 AND ${fgMatchPredicate()}
        ORDER BY pl.id DESC LIMIT 1`, [jc.product_id, lot.id]);
      const cust = await oc('SELECT customer_id FROM products WHERE id=$1', [jc.product_id]);
      await fgMove({
        ref_number: lot_number, parent_ref: parent?.lot_number || null, fg_lot_id: lot.id,
        product_id: jc.product_id, order_line_id: jc.order_line_id, customer_id: cust?.customer_id,
        qty_in: +qty, movement_type: 'excess_stock', source_module: 'production',
        created_by: req.user.name,
        remarks: `Excess from batch ${jc.jc_number}${parent?.lot_number ? ` · linked to ${parent.lot_number}` : ''}`,
      }, qc, oc);

      await audit('fg_lot', lot.id, 'create',
        `${lot_number} — ${qty} pcs excess from ${jc.jc_number}${box_count ? ` (${box_count} boxes${loose_qty ? ` + ${loose_qty} loose` : ''})` : ''}`,
        qc, req.user.name);
      return lot.id;
    });
    res.json(await one(`${LOT_VIEW} WHERE fl.id=$1`, [lotId]));
  } catch (e) { next(e); }
});

// Physical verification — only verified lots can be consumed by planning.
r.post('/fg-lots/:id/verify', canVerify, async (req, res, next) => {
  try {
    const { approve, note } = req.body;
    await tx(async (qc, oc) => {
      const lot = await oc('SELECT * FROM fg_lots WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!lot) throw Object.assign(new Error('Lot not found'), { status: 404 });
      if (lot.status !== 'pending_verification')
        throw Object.assign(new Error(`Lot already ${lot.status.replace(/_/g, ' ')}`), { status: 409 });
      await qc(`UPDATE fg_lots SET status=$1, verified_by=$2, verified_at=now(), verification_note=$3 WHERE id=$4`,
        [approve ? 'verified' : 'rejected', req.user.name, note || null, lot.id]);
      await audit('fg_lot', lot.id, approve ? 'verify_approve' : 'verify_reject',
        `${lot.lot_number}${note ? ` — ${note}` : ''}`, qc, req.user.name);
    });
    res.json(await one(`${LOT_VIEW} WHERE fl.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Edit a box's editable fields — box number, location, note. The auto-assigned
// CI-BOX-#### can be overwritten with the physical label actually used on the
// floor; uniqueness is enforced by the DB index.
r.put('/fg-lots/:id', canStore, async (req, res, next) => {
  try {
    const { box_number, location, note } = req.body;
    await tx(async (qc, oc) => {
      const lot = await oc('SELECT * FROM fg_lots WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!lot) throw Object.assign(new Error('Box/lot not found'), { status: 404 });
      const nextBox = box_number === undefined ? lot.box_number : (String(box_number).trim() || null);
      if (nextBox && nextBox !== lot.box_number) {
        const clash = await oc('SELECT id FROM fg_lots WHERE box_number=$1 AND id != $2', [nextBox, lot.id]);
        if (clash) throw Object.assign(new Error(`Box number ${nextBox} is already in use`), { status: 409 });
      }
      await qc(`UPDATE fg_lots SET box_number=$1, location=COALESCE($2,location), note=COALESCE($3,note) WHERE id=$4`,
        [nextBox, location ?? null, note ?? null, lot.id]);
      await audit('fg_lot', lot.id, 'edit',
        `${lot.lot_number}${nextBox !== lot.box_number ? ` · box ${lot.box_number || '—'} → ${nextBox || '—'}` : ''}`, qc, req.user.name);
    });
    res.json(await one(`${LOT_VIEW} WHERE fl.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Move a leftover box's remaining qty back into loose FG stock — the reverse of
// "Box as Leftover". The box empties and leaves the Leftover view.
r.post('/fg-lots/:id/to-fg', canStore, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => { await moveLeftoverBoxToFg(+req.params.id, qc, oc, req.user.name); });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Bulk version — move several leftover boxes back into loose FG in ONE tx, so
// the batch is atomic (any bad/empty box rolls the whole thing back).
r.post('/fg-lots/bulk-to-fg', canStore, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one box' });
    const moved = await tx(async (qc, oc) => {
      const out = [];
      for (const id of ids) { const r = await moveLeftoverBoxToFg(id, qc, oc, req.user.name); out.push(r); }
      return out;
    });
    res.json({ ok: true, count: moved.length });
  } catch (e) { next(e); }
});

// Consume verified FG against an order line — the planning engine's move.
// The line's balance-to-produce drops; sheets/parent requirements recompute
// if the line was already planned. Physical stock stays in fg_stock until
// dispatch (this is a reservation, fully audited).
r.post('/order-lines/:id/consume-fg', canPlan, async (req, res, next) => {
  try {
    const { lot_id, qty, remarks } = req.body;
    if (!lot_id || !qty || +qty <= 0) return res.status(400).json({ error: 'Lot and a positive quantity are required' });
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!line) throw Object.assign(new Error('Order line not found'), { status: 404 });
      if (!['pending', 'planned', 'ready'].includes(line.status))
        throw Object.assign(new Error('FG can only be consumed while the line is in planning (before production starts)'), { status: 409 });
      const jc = await oc('SELECT id FROM job_cards WHERE order_line_id=$1', [line.id]);
      if (jc) throw Object.assign(new Error('A job card already exists for this line — adjust the job card instead'), { status: 409 });

      const lot = await oc('SELECT * FROM fg_lots WHERE id=$1 FOR UPDATE', [lot_id]);
      if (!lot) throw Object.assign(new Error('FG lot not found'), { status: 404 });
      if (lot.status !== 'verified')
        throw Object.assign(new Error('Lot must pass physical verification before consumption'), { status: 409 });
      // The lot's finished good must match the line by the code hierarchy
      // (Internal Carton Code → Party Artwork Code → Product Code).
      const match = await oc(`
        SELECT 1 FROM products p, products fp
        WHERE p.id=$1 AND fp.id=$2 AND ${fgMatchPredicate()}`, [line.product_id, lot.product_id]);
      if (!match)
        throw Object.assign(new Error('Lot product does not match this order line'), { status: 409 });
      const remaining = lot.qty - lot.consumed_qty;
      if (+qty > remaining)
        throw Object.assign(new Error(`Only ${remaining} pieces remain in ${lot.lot_number}`), { status: 409 });
      const balance = netProduceQty(line);
      if (+qty > balance)
        throw Object.assign(new Error(`Only ${balance} pieces are left to cover on this line`), { status: 409 });

      await qc('INSERT INTO fg_consumptions (fg_lot_id, order_line_id, qty, user_name, remarks) VALUES ($1,$2,$3,$4,$5)',
        [lot.id, line.id, +qty, req.user.name, remarks || null]);
      const newConsumed = lot.consumed_qty + +qty;
      await qc(`UPDATE fg_lots SET consumed_qty=$1, status=CASE WHEN $1 >= qty THEN 'consumed' ELSE status END WHERE id=$2`,
        [newConsumed, lot.id]);
      // A leftover box is physical stock held OUT of loose fg_stock. Allocating
      // it to an order returns that qty to fg_stock so the order can dispatch it.
      if (lot.kind === 'leftover') await fgReceipt(lot.product_id, +qty, 'leftover_consume', lot.id, qc);
      await qc('UPDATE order_lines SET fg_consumed_qty = fg_consumed_qty + $1 WHERE id=$2', [+qty, line.id]);

      // FG Warehouse ledger — the reservation deducts from this stock reference.
      const ord = await oc('SELECT order_id FROM order_lines WHERE id=$1', [line.id]);
      const cust = await oc(`SELECT o.customer_id FROM orders o WHERE o.id=$1`, [ord?.order_id]);
      await fgMove({
        ref_number: lot.lot_number, fg_lot_id: lot.id, product_id: lot.product_id,
        order_line_id: line.id, order_id: ord?.order_id, customer_id: cust?.customer_id,
        qty_out: +qty, movement_type: 'stock_consumption', source_module: 'planning',
        created_by: req.user.name, remarks: remarks || null,
      }, qc, oc);

      // Re-plan the material requirement on the reduced balance.
      const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
      if (fresh.sheets_required != null) {
        const master = await oc('SELECT * FROM products WHERE id=$1', [fresh.product_id]);
        const product = effectiveProduct(master, fresh);
        const board = await oc('SELECT * FROM materials WHERE id=$1', [product.board_material_id]);
        const sheets = sheetsRequired(product, netProduceQty(fresh));
        const fit = childFit(board, product);
        await qc('UPDATE order_lines SET sheets_required=$1, parent_sheets_required=$2 WHERE id=$3',
          [sheets, parentSheetsRequired(sheets, fit.count), fresh.id]);
      }
      await audit('order_line', line.id, 'fg_consume',
        `${qty} pcs from ${lot.lot_number} — balance to produce ${netProduceQty({ ...line, fg_consumed_qty: (line.fg_consumed_qty || 0) + +qty })}`,
        qc, req.user.name);
      await audit('fg_lot', lot.id, 'consume', `${qty} pcs against order line ${line.id}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM order_lines WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// FG Warehouse Movement Ledger — the complete stock-movement trail. Filter by
// ?product_id, ?ref_number, or ?order_line_id; newest first.
r.get('/fg-movements', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    for (const [key, col] of [['product_id', 'm.product_id'], ['order_line_id', 'm.order_line_id']]) {
      if (req.query[key]) { params.push(+req.query[key]); where.push(`${col}=$${params.length}`); }
    }
    if (req.query.ref_number) { params.push(req.query.ref_number); where.push(`m.ref_number=$${params.length}`); }
    const rows = await q(`
      SELECT m.*, p.name AS product_name, p.code AS product_code,
             p.internal_carton_code, p.party_artwork_code,
             c.name AS customer_name, o.po_number
      FROM fg_movements m
      JOIN products p ON p.id = m.product_id
      LEFT JOIN customers c ON c.id = m.customer_id
      LEFT JOIN orders o ON o.id = m.order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.id DESC LIMIT 500`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

export default r;
