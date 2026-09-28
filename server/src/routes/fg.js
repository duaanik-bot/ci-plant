// FG lots — labelled excess stock in the Finished Goods warehouse.
// Excess from a closed job card is pushed here as a lot (CI-FG-0001…),
// physically verified, and only then consumable by the planning engine
// against a future order line for the same product.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, lockDocNumbers, netProduceQty, sheetsRequired, childFit, parentSheetsRequired, effectiveProduct, fgMove, fgMatchPredicate, moveLeftoverBoxToFg, fgReceipt, clearMixPlan, boxLeftoverFromFg, adjustFgStock, scrapLeftoverBox, setLotRetired, releaseFgConsumption, consumeFgLot, forceLineStatus, unbankPlanningLeftover } from '../helpers.js';
import { requireRole } from '../auth.js';
import { normalisePicks, fulfilBlock, completesOrder, undoBlock, STOCK_FULFIL_ACTION, STOCK_UNDO_ACTION } from '../stock-fulfil.js';

const r = Router();
const canStore = requireRole('planner', 'dispatch', 'production');
const canVerify = requireRole('qc', 'planner');
const canPlan = requireRole('planner');

const LOT_VIEW = `
  SELECT fl.*, (fl.qty - fl.consumed_qty) AS remaining,
         p.name AS product_name, p.code AS product_code,
         p.party_artwork_code, p.party_item_code,
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
      // The lot's two numbers before the job card's row lock (helpers.js
      // FG_MOVE_PREFIXES — the order every FG move takes them in).
      await lockDocNumbers(['CI-FG-', 'CI-BOX-'], oc);
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

// Add a leftover box from scratch — product off the Product Master plus a
// quantity, no job card behind it. This is how finished goods that the ERP never
// saw produced get onto the books: an opening count, a customer return, cartons
// found on the rack during a stocktake.
//
// reduceFg is FALSE on purpose. POST /fg/move boxes goods that are ALREADY in the
// loose pool, so it carves them out; these arrive from outside it, and carving
// would silently drain In Stock to pay for a box nobody took from it.
r.post('/fg-lots/manual', canStore, async (req, res, next) => {
  try {
    const { product_id, qty, box_number, location, note } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Pick a product' });
    if (!qty || +qty <= 0) return res.status(400).json({ error: 'Enter a quantity greater than zero' });

    const lotId = await tx(async (qc, oc) => {
      const p = await oc('SELECT id, name FROM products WHERE id=$1', [product_id]);
      if (!p) throw Object.assign(new Error('Product not found'), { status: 404 });
      // The physical label is optional, but if one is typed it has to be free —
      // box_number is uniquely indexed, and a raw 23505 reads as a 500 on the floor.
      const label = String(box_number || '').trim();
      if (label) {
        const clash = await oc('SELECT id FROM fg_lots WHERE box_number=$1', [label]);
        if (clash) throw Object.assign(new Error(`Box number ${label} is already in use`), { status: 409 });
      }
      const box = await boxLeftoverFromFg({
        product_id: +product_id, qty: +qty, source: 'manual', created_by: req.user.name,
        reduceFg: false, box_number: label, location, note,
        movement_type: 'opening_stock',
        remarks: `Added manually — ${note || 'opening leftover stock'}`,
      }, qc, oc);
      return box.id;
    });
    res.json(await one(`${LOT_VIEW} WHERE fl.id=$1`, [lotId]));
  } catch (e) { next(e); }
});

// Correct the LOOSE finished-goods pool (FG Stock → In Stock) — the FG twin of
// the RM warehouse's Stock Adjustment. Signed qty: + adds, − removes. A
// reduction beyond the book brings the product to nil, never negative, and the
// ledger records the clamped figure (see adjustFgStock).
r.post('/fg/adjust', canStore, async (req, res, next) => {
  try {
    const { product_id, qty, note } = req.body;
    if (!product_id) return res.status(400).json({ error: 'Pick a product' });
    if (!qty || !Math.trunc(+qty)) return res.status(400).json({ error: 'Enter a quantity to add or remove' });
    const out = await tx(async (qc, oc) => {
      const p = await oc('SELECT id FROM products WHERE id=$1', [product_id]);
      if (!p) throw Object.assign(new Error('Product not found'), { status: 404 });
      return adjustFgStock({ product_id: +product_id, qty: +qty, note, user: req.user.name }, qc, oc);
    });
    res.json({ ok: true, ...out });
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

// Scrap a leftover box — damaged, obsolete or otherwise unusable cartons that
// are leaving the building. The box empties and drops off the Leftover view;
// the goods do NOT come back to loose FG. Destructive and not reversible from
// the UI, so the reason is mandatory (enforced in the helper).
r.post('/fg-lots/:id/scrap', canStore, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) =>
      scrapLeftoverBox(+req.params.id, req.body.reason, qc, oc, req.user.name));
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

// Retire a box / put it back. Retiring keeps the cartons on the books but stops
// planning offering them — the planner's "I don't want this used" without
// destroying anything. canPlan, not canStore: this is a planning decision.
r.post('/fg-lots/:id/retire', canPlan, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) =>
      setLotRetired(+req.params.id, true, req.body.reason, qc, oc, req.user.name));
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

r.post('/fg-lots/:id/unretire', canPlan, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) =>
      setLotRetired(+req.params.id, false, null, qc, oc, req.user.name));
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

// Give FG back that was reserved against this line — the inverse of consume-fg.
// Pass consumption_id to release one booking, omit it to release the lot.
r.post('/order-lines/:id/release-fg', canPlan, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => releaseFgConsumption(
      { lineId: +req.params.id, consumptionId: req.body.consumption_id ? +req.body.consumption_id : null },
      qc, oc, req.user.name));
    res.json({ ok: true, ...out });
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

      // Every lot-side check, the reservation, the ledger row and the re-plan
      // live in consumeFgLot — shared with Complete-from-Stock.
      await consumeFgLot({ line, lotId: lot_id, qty: +qty, remarks }, qc, oc, req.user.name);
    });
    res.json(await one('SELECT * FROM order_lines WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Complete from Stock ────────────────────────────────────────────────────
// The planner ticks the FG boxes that fill an order. Every box is reserved
// through consumeFgLot — the same steps as consume-fg — in ONE transaction.
// When the ticks cover the whole balance the order needs no planning at all:
// the plan is voided (board holds, unbought PRs, banked offcuts, mix) and the
// line goes straight to 'produced', which is exactly what Ready to Dispatch
// reads, so challan → invoice follow the normal Dispatch & Invoice path.
// Fewer ticks than the balance is simply a multi-box consume; the line stays
// in planning for the rest. Undo: POST /order-lines/:id/return-to-planning.
r.post('/order-lines/:id/fulfil-from-stock', canPlan, async (req, res, next) => {
  try {
    const picks = normalisePicks(req.body.picks);
    const remarks = String(req.body.remarks || '').trim() || null;
    const user = req.user.name;
    const out = await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [req.params.id]);
      const jc = line ? await oc('SELECT id FROM job_cards WHERE order_line_id=$1', [line.id]) : null;
      const balanceBefore = line ? netProduceQty(line) : 0;
      const block = fulfilBlock(line, { hasJobCard: !!jc, completing: completesOrder(balanceBefore, picks) });
      if (block) throw Object.assign(new Error(block), { status: line ? 409 : 404 });
      if (balanceBefore <= 0)
        throw Object.assign(new Error('Nothing is left to make on this line'), { status: 409 });

      const boxes = [];
      for (const p of picks) {
        const { lot } = await consumeFgLot({ line, lotId: p.lot_id, qty: p.qty, remarks }, qc, oc, user);
        boxes.push(`${lot.box_number || lot.lot_number} × ${p.qty}`);
      }
      const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
      const balance = netProduceQty(fresh);
      if (!completesOrder(balanceBefore, picks) || balance > 0)
        return { completed: false, balance_to_produce: balance, warnings: [] };

      // Nothing is being made, so nothing the plan claimed may stay claimed.
      // The same unwinding rollbackLine does for a voided plan (its steps 3, 4
      // and 6) — minus the FG release, which is the whole point here, and
      // minus spec/artwork, which describe the carton, not the plan.
      const warnings = [];
      const freed = await qc(
        `UPDATE board_allocations
            SET status='released', released_by=$2, released_at=now(), release_reason=$3
          WHERE order_line_id=$1 AND status='active' AND job_board_mix_id IS NULL
          RETURNING material_id, qty, source`,
        [line.id, user, 'order completed from FG stock — nothing to make']);
      for (const a of freed)
        await audit('materials', a.material_id, 'board_hold_released',
          `${a.qty} sheets released from order line #${line.id} — completed from FG stock`, qc, user);
      const prs = await qc(
        'DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL RETURNING id', [line.id]);
      if (prs.length) await audit('order_line', line.id, 'pr_removed',
        `${prs.length} requisition(s) not yet ordered removed — completed from FG stock`, qc, user);
      const onPo = await oc(
        'SELECT COUNT(*)::int AS n FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NOT NULL', [line.id]);
      if (onPo.n) warnings.push(`${onPo.n} requisition(s) on this line are already on a purchase order — cancel them in Procurement if the board is no longer wanted`);
      await unbankPlanningLeftover(line.id, qc, oc, user, 'completed from FG stock');
      await clearMixPlan(line.id, qc, user, 'completed from FG stock — nothing to make');
      await qc(`UPDATE order_lines SET machine_id=NULL, planned_date=NULL, sheets_required=NULL,
                  parent_sheets_required=NULL, wastage_sheets=NULL, leftover_plan=NULL
                WHERE id=$1`, [line.id]);

      // Straight to Dispatch. 'produced' is not a planning transition, so it is
      // forced — and forcing is what writes the ':manual' audit row with why.
      const why = `Completed from FG stock — ${boxes.join(', ')}${remarks ? ` · ${remarks}` : ''}`;
      await forceLineStatus(line.id, 'produced', why, qc, oc, user);
      await audit('order_line', line.id, STOCK_FULFIL_ACTION, why, qc, user);

      // Ready to Dispatch shows a line only while its product has LOOSE stock.
      // A box matched by carton/artwork code but booked under another product
      // lands in that product's pool — say so rather than let the line vanish.
      const loose = await oc('SELECT COALESCE(qty,0)::int AS n FROM fg_stock WHERE product_id=$1', [line.product_id]);
      const owed = Math.max(0, line.qty - (+line.dispatched_qty || 0));
      if ((loose?.n ?? 0) < owed)
        warnings.push(`Only ${loose?.n ?? 0} pcs of this product are loose in FG against ${owed} owed — check the boxes' product in the FG store before despatch`);
      return { completed: true, balance_to_produce: 0, warnings };
    });
    res.json({ ok: true, ...out, line: await one('SELECT * FROM order_lines WHERE id=$1', [req.params.id]) });
  } catch (e) { next(e); }
});

// Undo a Complete-from-Stock: the line leaves Dispatch and goes back to To
// Plan. `release` lists the reservations (fg_consumptions ids) to hand back to
// the shelf; any not listed stay booked to the line, so the planner can amend
// the quantities rather than start over. Refused once anything has despatched.
r.post('/order-lines/:id/return-to-planning', canPlan, async (req, res, next) => {
  try {
    const release = Array.isArray(req.body.release) ? [...new Set(req.body.release.map(Number).filter(Boolean))] : [];
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to send this order back to planning' });
    const user = req.user.name;
    const out = await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [req.params.id]);
      const jc = line ? await oc('SELECT id FROM job_cards WHERE order_line_id=$1', [line.id]) : null;
      const marked = line ? await oc(
        `SELECT 1 FROM audit_log WHERE entity='order_line' AND entity_id=$1 AND action=$2 LIMIT 1`,
        [line.id, STOCK_FULFIL_ACTION]) : null;
      const block = undoBlock(line, { hasJobCard: !!jc, reservedQty: +line?.fg_consumed_qty || 0, markedFromStock: !!marked });
      if (block) throw Object.assign(new Error(block), { status: line ? 409 : 404 });

      await forceLineStatus(line.id, 'pending', `Back to planning from Dispatch — ${reason}`, qc, oc, user);
      let released = 0;
      for (const id of release) {
        const r0 = await releaseFgConsumption({ lineId: line.id, consumptionId: id }, qc, oc, user);
        released += r0.released;
      }
      const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
      await audit('order_line', line.id, STOCK_UNDO_ACTION,
        `${reason} — ${released} pcs released to stock, ${fresh.fg_consumed_qty} pcs still reserved · balance to produce ${netProduceQty(fresh)}`,
        qc, user);
      return { released, kept: fresh.fg_consumed_qty, balance_to_produce: netProduceQty(fresh) };
    });
    res.json({ ok: true, ...out });
  } catch (e) { next(e); }
});

// Planning → From Stock: every order line completed from stock, newest first,
// with the boxes booked to it and who sent it. Read off the audit marker, so a
// produced line from a job card or a shortage close can never appear here.
r.get('/planning/from-stock', async (_req, res, next) => {
  try {
    res.json(await q(`
      WITH marked AS (
        SELECT entity_id AS line_id, MAX(id) AS audit_id FROM audit_log
        WHERE entity='order_line' AND action=$1 GROUP BY entity_id)
      SELECT ol.id, ol.qty, ol.dispatched_qty, ol.fg_consumed_qty, ol.status, ol.order_id,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.code AS product_code, p.name AS product_name,
             a.created_at AS fulfilled_at, a.user_name AS fulfilled_by, a.detail AS fulfil_detail,
             COALESCE((SELECT json_agg(json_build_object(
                        'id', fc.id, 'qty', fc.qty, 'lot_number', fl.lot_number, 'box_number', fl.box_number,
                        'kind', fl.kind, 'remarks', fc.remarks) ORDER BY fc.id)
                       FROM fg_consumptions fc JOIN fg_lots fl ON fl.id = fc.fg_lot_id
                       WHERE fc.order_line_id = ol.id), '[]'::json) AS boxes
      FROM marked m
      JOIN audit_log a ON a.id = m.audit_id
      JOIN order_lines ol ON ol.id = m.line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE ol.status IN ('produced', 'dispatched')
        AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_line_id = ol.id)
      ORDER BY a.id DESC
      LIMIT 300`, [STOCK_FULFIL_ACTION]));
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
             p.internal_carton_code, p.party_artwork_code, p.party_item_code,
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
