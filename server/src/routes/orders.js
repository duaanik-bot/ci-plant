// Orders + Planning + Artwork — the front half of the plant workflow.
import { Router } from 'express';
import { syncPrAllocation } from './procurement.js';
import { plantDateStr, PLANT_TODAY_SQL } from '../plant-calendar.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { q, one, tx } from '../db.js';
import { audit, outputNumberSql, setLineStatus, sheetsRequired, netProduceQty, readiness, readinessBatch, fgAvailableFromCtx, nextNumber, childFit, parentSheetsRequired, leftoverStrips, chosenStrips, chosenCutsValid, effectiveParent, parentFitsBoard, fgAvailableForLine, fgMatchPredicate, fgMatchedBy, orderTransitionError, rollbackLine, shadeCardsFor, bankPlanningLeftover, unbankPlanningLeftover, unbankRunLeftover, EFF_BOARD_ID, boardClaimLines, mixFor, replaceMixPlan, clearMixPlan, releasePlanLockHolds, stampBoardState, stampPlateState, boardDrawnLineIds, boardHoldCaps } from '../helpers.js';
import { setTypeError } from '../set-type.js';
import { readinessLight, lightForJobCards } from '../readiness-light.js';
import { linePosition, claimsByBoard, boardPosition, heldFor, stockHoldBudget } from '../board-allocation.js';
import { lineRequirement, mixBalance, mixPosition, rowCovers, substitutionFlags, DEFAULT_MIX_REASON } from '../board-mix.js';
import { rankBoardMatches } from '../smartmatch.js';
import { splitMasterFields } from '../plan-save.js';
import { toolingDetail, toolingGateOk } from '../tooling-gate.js';
import { gangDetail } from './gangs.js';
import { commitBoardForLine, commitInputs } from './board.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';
import multer from 'multer';
import { extractRows } from '../poparse.js';
import { matchWipRows } from '../wip-match.js';

const r = Router();
const canPlan = requireRole('planner');
// Planning-side work — planning a line, its zone, its spec/artwork, its tooling,
// its PR and its stock call. The designer and the plant do all of this. The
// SALES-ORDER lifecycle above (create, edit, cancel, delete, status) stays on
// canPlan: widening that would hand every floor login DELETE /orders/:id.
const canPlanWork = requireRole(...PLANNING_ROLES);
const canArtwork = requireRole(...PLANNING_ROLES, 'qc');

// The die NUMBER a job punches on, as TEXT: a gang's own die first (the whole
// run shares one), then the job override, then the master's typed number. Only
// when all three are blank is the number the Tooling Hub record's auto code.
const DIE_TEXT = `COALESCE(CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.die_number, '') END,
                            ol.spec_override->>'die_number', NULLIF(p.die_number,''))`;
// …so the die's RACK ROW has to be found by that code, not off products.tool_id.
// tool_id is set on 2 of ~1600 masters while 828 carry the die as text — and
// every one of those texts is a real tools.code — so a tool_id join resolves the
// die for almost nobody. Worse, where it does resolve it can disagree with the
// number on screen: a job override naming die 44 would print die 1's sheet size.
// So `dc` (joined on the effective text) wins wherever that text exists, and the
// tool_id row is read only when the code IS that row's. Retired dies are not
// filtered out — a job still naming one should show its size, not a blank — and
// tools.code is UNIQUE (tools_code_key), so this join can never fan a line out.
const dieCol = col => `CASE WHEN ${DIE_TEXT} IS NOT NULL THEN dc.${col} ELSE d.${col} END`;

// Effective spec everywhere: a line's job-only overrides (spec_override, the
// "save for this job" branch of the master-update philosophy) win over the
// product master — including the board, so a warehouse stock selection made in
// the planning engine flows through the whole view.
const LINE_VIEW = `
  SELECT ol.*, o.po_number, o.po_date, o.delivery_date, o.customer_id,
         COALESCE(ol.tolerance_pct, c.tolerance_pct, 0) AS eff_tolerance_pct,
         c.name AS customer_name, p.name AS product_name, p.code AS product_code,
         p.internal_carton_code,
         p.party_item_code,
         COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
         -- The output number, from helpers.js outputNumberSql — the same rule
         -- the job cards and the station queues resolve, so the Planning
         -- queue, Artwork and the status sheet all call a job by one number.
         -- Line-driven, so the override is this line's own. The carton's
         -- untouched master value stays available as master_output_number
         -- below for the screens that compare against it.
         ${outputNumberSql({ override: `ol.spec_override->>'output_number'` })} AS output_number,
         CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.output_number, '') END AS run_output_number,
         CASE WHEN gg.kind = 'gang' THEN NULLIF(gg.die_number, '') END AS run_die_number,
         p.party_artwork_code AS master_party_artwork_code,
         p.output_number AS master_output_number,
         COALESCE(ol.spec_override->>'shade_card_number', p.shade_card_number) AS shade_card_number,
         COALESCE(ol.spec_override->>'shade_card_date', p.shade_card_date) AS shade_card_date,
         p.shade_card_number AS master_shade_card_number,
         p.shade_card_date AS master_shade_card_date,
         COALESCE(ol.spec_override->>'coating', p.coating) AS coating,
         COALESCE(ol.spec_override->>'special', p.special) AS special,
         COALESCE((ol.spec_override->>'colors')::int, p.colors) AS colors,
         COALESCE((ol.spec_override->>'ups')::int, p.ups) AS ups,
         p.gsm, p.size,
         COALESCE(ol.spec_override->>'colour_type', p.colour_type) AS colour_type,
         COALESCE(ol.spec_override->>'print_process', p.print_process) AS print_process,
         COALESCE((ol.spec_override->>'cmyk_colours')::int, p.cmyk_colours) AS cmyk_colours,
         COALESCE((ol.spec_override->>'pantone_colours')::int, p.pantone_colours) AS pantone_colours,
         COALESCE(ol.spec_override->>'pantone_codes', p.pantone_codes) AS pantone_codes,
         COALESCE((ol.spec_override->>'metallic_colours')::int, p.metallic_colours) AS metallic_colours,
         COALESCE(ol.spec_override->>'metallic_details', p.metallic_details) AS metallic_details,
         COALESCE(ol.spec_override->>'print_instructions', p.print_instructions) AS print_instructions,
         -- The master's own ink, carried alongside the effective value. Artwork
         -- VERIFIES colour rather than owning it, so its panel needs to say
         -- "this job differs from the master" without being able to overwrite
         -- either. Same shape as master_party_artwork_code / master_output_number.
         p.colour_type AS master_colour_type,
         p.colors AS master_colors,
         p.print_process AS master_print_process,
         p.pantone_codes AS master_pantone_codes,
         p.metallic_details AS master_metallic_details,
         COALESCE(ol.spec_override->>'pasting_type', p.pasting_type) AS pasting_type,
         COALESCE((ol.spec_override->>'emboss')::int, p.emboss) AS emboss,
         COALESCE((ol.spec_override->>'leafing')::int, p.leafing) AS leafing,
         COALESCE(ol.spec_override->>'leafing_colour', p.leafing_colour) AS leafing_colour,
         COALESCE((ol.spec_override->>'wastage_pct')::float, p.wastage_pct) AS wastage_pct,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         -- Raw finalised parent size (override wins) so the engine can seed AND
         -- diff it; the folded sheet_l/sheet_w below still falls back to the board.
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
         p.product_type,
         COALESCE(ol.gst_pct, p.gst_pct, gr.rate, 12) AS gst_pct,
         ${EFF_BOARD_ID} AS board_material_id,
         (ol.spec_override->>'board_material_id') IS NOT NULL AS board_overridden,
         p.board_material_id AS master_board_material_id,
         bm.name AS board_name,
         -- Board grade/brand (Saffire, FBB…): the product master's explicit
         -- board_grade when set, else the first word of the board name — so
         -- planning always shows BOTH the grade and the full board (gsm + size).
         COALESCE(NULLIF(p.board_grade,''), NULLIF(split_part(p.board_name,' ',1),''), split_part(bm.name,' ',1)) AS board_grade,
         -- Full board NAME from the master board material (grade + gsm + parent).
         COALESCE(mbm.name, p.board_name) AS master_board_name,
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l, bm.sheet_l) AS sheet_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w, bm.sheet_w) AS sheet_w,
         -- Die/Block numbers: explicit job/master text wins; the Tooling Hub
         -- record's auto code (DIE-…/BLK-…) is the fallback when none is set.
         COALESCE(${DIE_TEXT}, d.code) AS die_number,
         NULLIF(p.die_number,'') AS master_die_number,
         -- What that number MEANS, read off the die's own rack record: the sheet
         -- size the die is built for, and how many cartons it blanks out of one
         -- sheet. Planning prints both under the number, because two jobs can
         -- share a board and a coating and still need different dies at
         -- punching — and "die 33" on its own never said whether it fits.
         ${dieCol('ups')} AS die_ups,
         NULLIF(${dieCol('sheet_size')},'') AS die_sheet_size,
         -- The die's TYPE, as distinct from its number. The legacy dies rack
         -- carried die_type; that column was folded into tools.title by the
         -- Tooling Hub migration, so the title is where a die's type lives now.
         NULLIF(${dieCol('title')},'') AS die_type,
         COALESCE(ol.spec_override->>'block_number', NULLIF(p.block_number,''),
                  (SELECT t.code FROM tools t WHERE t.product_id=p.id AND t.family='block' AND t.active=1 ORDER BY t.id LIMIT 1)) AS block_number,
         NULLIF(p.block_number,'') AS master_block_number,
         p.tool_id, m.name AS machine_name,
         -- Whether the board above was CHOSEN or merely parked. A product raised
         -- before its board was known sits on a placeholder, and every board
         -- column here resolves through the material join, so the placeholder
         -- reads exactly like a real decision. The board is not nulled: it is
         -- functionally in play (readiness counts stock against it, and the job
         -- would run on it), so the screens must keep agreeing with what
         -- readiness computed. Only the DISPLAY is held back — see Planning's
         -- and Artwork's board columns, which render a dash off this flag.
         COALESCE(p.spec_incomplete, 0) AS spec_incomplete,
         -- A plan that has been SAVED but not locked. The engine's Save writes
         -- every figure a lock writes and deliberately leaves the line in To
         -- Plan (see POST /order-lines/:id/plan) so a half-finished plan claims
         -- no board and reaches no station — which also means there is no draft
         -- column to read. This pair is what tells a saved plan from one nobody
         -- has opened: a lock always moves the status off 'pending', so a
         -- pending line that already carries a written parent requirement can
         -- only have got there through a save. Both halves are load-bearing —
         -- seeded and legacy 'planned' rows carry a NULL requirement, and a
         -- rollback nulls the column while returning the line to pending, which
         -- correctly reads as "not saved" again.
         -- The rule lives HERE rather than in the client so the queue's badge
         -- and its filter cannot drift apart, and so an explicit draft column,
         -- when it arrives, replaces exactly one line of SQL.
         (ol.status = 'pending' AND ol.parent_sheets_required IS NOT NULL) AS plan_draft,
         gg.gang_number, gg.kind AS run_kind
  FROM order_lines ol
  JOIN orders o   ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = ol.product_id
  JOIN materials bm ON bm.id = ${EFF_BOARD_ID}
  LEFT JOIN materials mbm ON mbm.id = p.board_material_id
  LEFT JOIN tools d ON d.id = p.tool_id
  LEFT JOIN gst_rates gr ON gr.product_type = p.product_type
  LEFT JOIN machines m ON m.id = ol.machine_id
  LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
  -- Must come after gang_runs: DIE_TEXT reads gg, and a LEFT JOIN's ON can only
  -- see tables already joined above it.
  LEFT JOIN tools dc ON dc.family = 'die' AND dc.code = ${DIE_TEXT}`;

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
        (SELECT COALESCE(SUM(ol.qty*ol.rate),0) FROM order_lines ol WHERE ol.order_id=o.id AND ol.status!='cancelled') AS value,
        (SELECT COALESCE(SUM(ol.qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id AND ol.status!='cancelled') AS ordered_qty,
        (SELECT COALESCE(SUM(ol.dispatched_qty),0)::int FROM order_lines ol WHERE ol.order_id=o.id AND ol.status!='cancelled') AS fulfilled_qty,
        -- Every line's product & artwork identifiers, folded into the row so the
        -- Sales Orders search matches by product name, code, artwork or output
        -- number — not just PO/customer. Consumed by the table's deep search.
        (SELECT string_agg(DISTINCT concat_ws(' ',
              p.name, p.code, p.internal_carton_code,
              COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code),
              COALESCE(ol.spec_override->>'output_number', p.output_number), p.size), ' ')
         FROM order_lines ol JOIN products p ON p.id=ol.product_id
         WHERE ol.order_id=o.id) AS search_blob
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
        [po_number, customer_id, po_date || plantDateStr(), delivery_date || null, notes || null]);
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
        [po_number, customer_id, po_date || plantDateStr(), delivery_date || null, notes || null, orderId]);

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

// ONE transaction, and it has to be.
//
// setLineStatus now releases this line's board freeze alongside the status
// flip. Run on the pool those are two independent autocommit statements, and a
// crash between them leaves a CANCELLED line still holding board — with
// LINE_TRANSITIONS.cancelled empty the line is terminal, so no route will ever
// run a release for it again and the sheets are fenced off for good. That is
// precisely the phantom the freeze exists to remove, reintroduced by its own
// cleanup path.
//
// The two bulk-cancel paths already run inside tx(); this single-line route was
// the one that did not.
r.post('/order-lines/:id/cancel', canPlan, async (req, res, next) => {
  try {
    res.json(await tx((qc, oc) => setLineStatus(+req.params.id, 'cancelled', qc, oc, req.user.name)));
  } catch (e) { next(e); }
});

// Station rollback / delete. mode 'rollback' returns the line to the sales
// order (fresh, pending); mode 'delete' removes it from the order entirely.
// Blocked (409 + { blockers }) when real downstream activity exists.
r.post('/order-lines/:id/rollback', canPlan, async (req, res, next) => {
  try {
    const mode = req.body.mode === 'delete' ? 'delete' : 'rollback';
    const note = (req.body.note || '').trim() || null;
    const result = await tx((qc, oc) => rollbackLine({ lineId: +req.params.id, mode, note }, qc, oc, req.user.name));
    res.json(result);
  } catch (e) {
    if (e.blockers) return res.status(409).json({ error: e.message, blockers: e.blockers });
    next(e);
  }
});

// Cancel / close a whole order. Its still-open lines (anything not yet dispatched)
// are cancelled too; already-dispatched lines stay as-is. Lands in the Closed tab.
r.post('/orders/:id/cancel', canPlan, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    await tx(async (qc, oc) => {
      const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (o.status === 'cancelled') throw Object.assign(new Error('Order is already closed'), { status: 409 });
      // Cancel the lines that have not shipped; leave dispatched ones intact.
      const openLines = await qc(
        `SELECT id FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [o.id]);
      for (const l of openLines) await setLineStatus(l.id, 'cancelled', qc, oc, req.user.name);
      await qc(`UPDATE orders SET status='cancelled'${reason ? ', notes=COALESCE(notes,\'\') || $2' : ''} WHERE id=$1`,
        reason ? [o.id, `\n[closed] ${reason}`] : [o.id]);
      await audit('order', o.id, 'cancel', reason || null, qc, req.user.name);
    });
    res.json(await one(`SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Everything a delete would have to touch, gathered read-only. `hard_blockers`
// stop even a force delete (goods shipped, FG reserved by another order, a
// gang shared with another order). `reversals` is what force will undo on its
// own; `deletes` is what disappears. The dialog shows all three and only then
// asks for the confirmation.
async function deletePreview(orderId) {
  const o = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
  if (!o) return null;
  const hard = [];
  const reversals = [];
  const deletes = [];

  const dispatched = await one('SELECT COUNT(*)::int AS n FROM dispatches WHERE order_id=$1', [orderId]);
  if (dispatched.n > 0)
    hard.push(`${dispatched.n} dispatch challan(s) exist — goods that already left the plant cannot be deleted`);

  const lines = await q(`
    SELECT ol.id, ol.gang_run_id, ol.dispatched_qty, p.name AS product_name
    FROM order_lines ol JOIN products p ON p.id=ol.product_id
    WHERE ol.order_id=$1 ORDER BY ol.id`, [orderId]);
  const lineIds = new Set(lines.map(l => l.id));
  deletes.push(`Sales order ${o.po_number} with ${lines.length} item(s)`);

  const seenGangs = new Set();
  const seenCards = new Set();
  for (const l of lines) {
    if (+l.dispatched_qty > 0)
      hard.push(`${l.product_name}: ${l.dispatched_qty} pcs already dispatched`);

    // The line's own card — or, before the die-cutting split, its gang parent.
    const cards = await q(`
      SELECT * FROM job_cards WHERE order_line_id=$1
      UNION
      SELECT jc.* FROM job_cards jc WHERE $2::int IS NOT NULL AND jc.gang_run_id=$2 AND jc.order_line_id IS NULL`,
      [l.id, l.gang_run_id]);
    for (const jc of cards) {
      if (seenCards.has(jc.id)) continue;
      seenCards.add(jc.id);
      const stages = await q(`SELECT stage, status FROM job_stages WHERE job_card_id=$1 AND status <> 'pending' ORDER BY seq`, [jc.id]);
      for (const s of stages)
        reversals.push(`${jc.jc_number}: ${s.stage.replace(/_/g, ' ')} (${s.status.replace(/_/g, ' ')}) will be reversed`);
      const board = await one(`
        SELECT COALESCE(-SUM(qty),0)::int AS n FROM stock_movements
        WHERE material_id IS NOT NULL AND type IN ('consumption','adjustment')
          AND ((ref_type='job_card' AND ref_id=$1)
            OR (ref_type='job_stage' AND ref_id IN (SELECT id FROM job_stages WHERE job_card_id=$1)))`, [jc.id]);
      if (board.n > 0) reversals.push(`${jc.jc_number}: ${board.n} board sheet(s) return to the warehouse`);
      const lots = await one('SELECT COUNT(*)::int AS n FROM fg_lots WHERE job_card_id=$1', [jc.id]);
      if (lots.n > 0) reversals.push(`${jc.jc_number}: ${lots.n} FG lot(s) will be removed from FG stock`);
      const foreign = await one(`
        SELECT COUNT(*)::int AS n FROM fg_consumptions fc JOIN fg_lots fl ON fl.id=fc.fg_lot_id
        WHERE fl.job_card_id=$1 AND fc.order_line_id <> ALL($2::int[])`, [jc.id, [...lineIds]]);
      if (foreign.n > 0) hard.push(`${jc.jc_number}: finished goods are reserved by another order — release that first`);
      const tools = await one('SELECT COUNT(*)::int AS n FROM tools WHERE issued_job_card_id=$1', [jc.id]);
      if (tools.n > 0) reversals.push(`${jc.jc_number}: ${tools.n} issued tool(s) return to the vault`);
      deletes.push(`Job card ${jc.jc_number} and its stage history`);
    }

    if (l.gang_run_id && !seenGangs.has(l.gang_run_id)) {
      seenGangs.add(l.gang_run_id);
      const members = await q('SELECT id FROM order_lines WHERE gang_run_id=$1', [l.gang_run_id]);
      if (members.some(m => !lineIds.has(m.id)))
        hard.push(`${l.product_name} is ganged with another order’s job — remove it from the gang first`);
    }

    const prs = await q('SELECT pr_number, purchase_order_id FROM requisitions WHERE order_line_id=$1', [l.id]);
    for (const pr of prs) {
      if (pr.purchase_order_id) reversals.push(`${pr.pr_number}: detached from its purchase order (the PO and any GRN stay)`);
      else deletes.push(`Purchase requisition ${pr.pr_number}`);
    }
    const fgRes = await one('SELECT COUNT(*)::int AS n FROM fg_consumptions WHERE order_line_id=$1', [l.id]);
    if (fgRes.n > 0) reversals.push(`${l.product_name}: reserved FG stock is released back to the warehouse`);
  }

  return {
    po_number: o.po_number,
    hard_blockers: [...new Set(hard)],
    reversals: [...new Set(reversals)],
    deletes: [...new Set(deletes)],
    force_required: reversals.length > 0,
  };
}

r.get('/orders/:id/delete-preview', canPlan, async (req, res, next) => {
  try {
    const p = await deletePreview(+req.params.id);
    if (!p) return res.status(404).json({ error: 'Order not found' });
    res.json(p);
  } catch (e) { next(e); }
});

// Delete an entire sales order. Every line is unwound through the same guarded
// rollback engine (mode 'delete') that powers per-line deletion, so job cards,
// stages, planning/artwork/tooling locks and un-ordered PRs all disappear with
// it. Without `force`, it is blocked (409 + { blockers }) the moment any line
// has started production, produced FG, sits on an ordered PR, or has shipped.
// With `force: true` (the dialog's explicit "reverse everything & delete"
// confirmation) started stages are reversed automatically — board returns to
// the warehouse, FG receipts and lots are backed out, tools return to the
// vault — and every derived record is removed. Dispatched goods, FG reserved
// by another order, and gangs shared with other orders still block. A full
// JSON backup of every row about to be removed is written next to the app
// before anything is touched.
r.delete('/orders/:id', canPlan, async (req, res, next) => {
  try {
    const orderId = +req.params.id;
    const note = (req.body?.note || '').trim() || null;
    const force = req.body?.force === true;

    if (force) {
      const preview = await deletePreview(orderId);
      if (!preview) return res.status(404).json({ error: 'Order not found' });
      if (preview.hard_blockers.length)
        return res.status(409).json({ error: preview.hard_blockers[0], blockers: preview.hard_blockers });
      await writeOrderDeleteBackup(orderId, preview.po_number);
    }

    const result = await tx(async (qc, oc) => {
      const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
      if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
      const dispatched = await oc('SELECT COUNT(*)::int AS n FROM dispatches WHERE order_id=$1', [orderId]);
      if (dispatched.n > 0) {
        const e = new Error('Order has dispatch challans — cannot delete');
        e.status = 409;
        e.blockers = ['Dispatch challans exist for this order — cancel those first'];
        throw e;
      }
      const lines = await qc('SELECT id FROM order_lines WHERE order_id=$1', [orderId]);
      const scopeLineIds = new Set(lines.map(l => l.id));
      for (const l of lines) {
        await rollbackLine({
          lineId: l.id, mode: 'delete', force, scopeLineIds,
          note: note || `Order ${o.po_number} deleted`,
        }, qc, oc, req.user.name);
      }
      // Detach any FG ledger rows still pointing at the order, then remove it.
      await qc('UPDATE fg_movements SET order_id=NULL WHERE order_id=$1', [orderId]);
      await audit('order', orderId, force ? 'force_deleted_entirely' : 'deleted_entirely',
        `${o.po_number} — ${lines.length} line(s) removed${force ? ' · production reversed automatically' : ''}${note ? ` · ${note}` : ''}`, qc, req.user.name);
      await qc('DELETE FROM orders WHERE id=$1', [orderId]);
      return { ok: true, deleted: true, message: `Order ${o.po_number} deleted` };
    });
    res.json(result);
  } catch (e) {
    if (e.blockers) return res.status(409).json({ error: e.message, blockers: e.blockers });
    next(e);
  }
});

// Snapshot every row a force delete is about to remove into a timestamped JSON
// file. Locally this stays in the app folder; Vercel functions can only write
// safely to /tmp.
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BACKUP_ROOT = process.env.VERCEL ? tmpdir() : APP_ROOT;
async function writeOrderDeleteBackup(orderId, poNumber) {
  const grab = async (sql, params) => q(sql, params);
  const order = await one('SELECT * FROM orders WHERE id=$1', [orderId]);
  const lines = await grab('SELECT * FROM order_lines WHERE order_id=$1', [orderId]);
  const lineIds = lines.map(l => l.id);
  const gangIds = [...new Set(lines.map(l => l.gang_run_id).filter(Boolean))];
  const cards = await grab(
    `SELECT * FROM job_cards WHERE order_line_id = ANY($1::int[])
     OR (gang_run_id = ANY($2::int[]) AND order_line_id IS NULL)`, [lineIds, gangIds]);
  const cardIds = cards.map(c => c.id);
  const backup = {
    reason: 'force-delete backup', at: new Date().toISOString(), order, lines,
    gang_runs: gangIds.length ? await grab('SELECT * FROM gang_runs WHERE id=ANY($1::int[])', [gangIds]) : [],
    job_cards: cards,
    job_stages: cardIds.length ? await grab('SELECT * FROM job_stages WHERE job_card_id=ANY($1::int[])', [cardIds]) : [],
    pasting_rows: cardIds.length ? await grab('SELECT pr.* FROM pasting_rows pr JOIN job_stages js ON js.id=pr.job_stage_id WHERE js.job_card_id=ANY($1::int[])', [cardIds]) : [],
    packing_lines: cardIds.length ? await grab('SELECT pl.* FROM packing_lines pl JOIN job_stages js ON js.id=pl.job_stage_id WHERE js.job_card_id=ANY($1::int[])', [cardIds]) : [],
    cutting_discrepancies: cardIds.length ? await grab('SELECT * FROM cutting_discrepancies WHERE job_card_id=ANY($1::int[])', [cardIds]) : [],
    extra_sheet_requests: cardIds.length ? await grab('SELECT * FROM extra_sheet_requests WHERE job_card_id=ANY($1::int[])', [cardIds]) : [],
    requisitions: lineIds.length ? await grab('SELECT * FROM requisitions WHERE order_line_id=ANY($1::int[])', [lineIds]) : [],
    fg_lots: cardIds.length ? await grab('SELECT * FROM fg_lots WHERE job_card_id=ANY($1::int[]) OR order_line_id=ANY($2::int[])', [cardIds, lineIds]) : [],
    fg_consumptions: lineIds.length ? await grab('SELECT * FROM fg_consumptions WHERE order_line_id=ANY($1::int[])', [lineIds]) : [],
    stock_movements: cardIds.length ? await grab(
      `SELECT * FROM stock_movements WHERE (ref_type='job_card' AND ref_id=ANY($1::int[]))
       OR (ref_type='job_stage' AND ref_id IN (SELECT id FROM job_stages WHERE job_card_id=ANY($1::int[])))`, [cardIds]) : [],
    fg_movements: await grab('SELECT * FROM fg_movements WHERE order_id=$1 OR order_line_id=ANY($2::int[])', [orderId, lineIds]),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(BACKUP_ROOT, `ORDER-DELETE-BACKUP-${String(poNumber).replace(/[^\w-]+/g, '_')}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 2));
  return file;
}

// Mark fulfilled items complete (the deliberate invoice-time confirmation).
// Only fully-dispatched lines qualify. When every non-cancelled line on the
// order carries completed_at, the order itself rolls up to 'completed'.
r.post('/orders/:id/complete-lines', canPlan, async (req, res, next) => {
  try {
    const ids = (req.body.line_ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'Select at least one item to mark complete' });
    const result = await tx(async (qc, oc) => {
      const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
      const done = [];
      for (const id of ids) {
        const l = await oc('SELECT * FROM order_lines WHERE id=$1 AND order_id=$2', [id, o.id]);
        if (!l) throw Object.assign(new Error(`Line ${id} is not on this order`), { status: 404 });
        if (l.completed_at) continue;                         // already complete — idempotent
        if (+l.dispatched_qty < +l.qty)
          throw Object.assign(new Error(`Item is not fully fulfilled yet (${l.dispatched_qty}/${l.qty} dispatched)`), { status: 409 });
        await qc('UPDATE order_lines SET completed_at=now() WHERE id=$1', [id]);
        await audit('order_line', id, 'completed', `${o.po_number}`, qc, req.user.name);
        done.push(id);
      }
      // Roll up: order completes once no non-cancelled line is left uncompleted.
      const pending = await oc(
        `SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id=$1 AND status<>'cancelled' AND completed_at IS NULL`, [o.id]);
      let rolled = false;
      if (pending.n === 0 && o.status !== 'cancelled' && o.status !== 'completed') {
        await qc(`UPDATE orders SET status='completed' WHERE id=$1`, [o.id]);
        await audit('order', o.id, 'complete', 'all items marked complete', qc, req.user.name);
        rolled = true;
      }
      return { completed: done, order_completed: rolled || o.status === 'completed' };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Sales-order lifecycle: set Pending / Hold / Completed / Closed / Cancelled.
// Guarded by orderTransitionError; reopening a terminal order needs admin.
r.post('/orders/:id/status', canPlan, async (req, res, next) => {
  try {
    const to = String(req.body.status || '').trim();
    const note = (req.body.note || '').trim();
    const isAdmin = req.user?.role === 'admin';
    const result = await tx(async (qc, oc) => {
      const o = await oc('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!o) throw Object.assign(new Error('Order not found'), { status: 404 });
      const err = orderTransitionError(o.status, to, isAdmin);
      if (err) throw Object.assign(new Error(err), { status: 409 });

      // Completing an order requires every non-cancelled line fully dispatched.
      if (to === 'completed') {
        const undone = await oc(
          `SELECT COUNT(*)::int AS n FROM order_lines
           WHERE order_id=$1 AND status<>'cancelled' AND dispatched_qty < qty`, [o.id]);
        if (undone.n > 0) throw Object.assign(new Error('Every item must be fully dispatched before completing the order'), { status: 409 });
      }
      // Cancelling cascades to un-shipped lines (mirrors the old /cancel path).
      if (to === 'cancelled') {
        const openLines = await qc(
          `SELECT id FROM order_lines WHERE order_id=$1 AND status NOT IN ('dispatched','cancelled')`, [o.id]);
        for (const l of openLines) await setLineStatus(l.id, 'cancelled', qc, oc, req.user.name);
      }
      await qc('UPDATE orders SET status=$1 WHERE id=$2', [to, o.id]);
      await audit('order', o.id, `status:${o.status}→${to}`, note || null, qc, req.user.name);
      return { from: o.status, to };
    });
    const out = await one(`SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1`, [req.params.id]);
    res.json({ ...out, transition: result });
  } catch (e) { next(e); }
});

// ── Pendency ────────────────────────────────────────────────────────────────
// What is still owed to customers: line-wise detail (workflow position, FG
// cover, ageing) plus product-wise and customer-wise roll-ups — the sales
// mirror of /procurement/pendency.
r.get('/sales/pendency', async (_req, res, next) => {
  try {
    const rows = await q(`
      WITH demand AS (
        SELECT ol.id AS line_id, ol.order_id, o.po_number, o.po_date, o.delivery_date,
               c.id AS customer_id, c.name AS customer_name,
               p.id AS product_id, p.name AS product_name, p.code AS product_code,
               COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
               p.party_item_code, p.size,
               ol.qty, ol.dispatched_qty, (ol.qty - ol.dispatched_qty) AS pending_qty,
               ol.rate, ((ol.qty - ol.dispatched_qty) * ol.rate) AS pending_value,
               ol.status, ol.gang_run_id, gg.gang_number, gg.kind AS run_kind,
               COALESCE(fg.qty, 0)::int AS fg_qty,
               GREATEST(0, (${PLANT_TODAY_SQL} - o.po_date::date))::int AS age_days,
               CASE WHEN o.delivery_date IS NOT NULL AND o.delivery_date::date < ${PLANT_TODAY_SQL}
                    THEN (${PLANT_TODAY_SQL} - o.delivery_date::date)::int ELSE 0 END AS overdue_days,
               COALESCE(SUM(ol.qty - ol.dispatched_qty) OVER (
                 PARTITION BY ol.product_id
                 ORDER BY o.delivery_date NULLS LAST, o.po_date, ol.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ), 0)::int AS prior_product_pending
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
        JOIN customers c ON c.id = o.customer_id
        JOIN products p ON p.id = ol.product_id
        LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
        LEFT JOIN fg_stock fg ON fg.product_id = ol.product_id
        WHERE o.status IN ('pending','hold') AND ol.status NOT IN ('cancelled','dispatched')
          AND ol.qty > ol.dispatched_qty AND ol.completed_at IS NULL
      )
      SELECT d.*,
             GREATEST(0, LEAST(d.pending_qty, d.fg_qty - d.prior_product_pending))::int AS fg_allocated_qty,
             GREATEST(0, d.pending_qty - GREATEST(0, LEAST(d.pending_qty, d.fg_qty - d.prior_product_pending)))::int AS production_required_qty,
             jc.id AS job_card_id, jc.jc_number, jc.status AS jc_status, jc.qty_planned, jc.qty_produced,
             jc.order_line_id IS NULL AS gang_parent_job,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status IN ('in_progress','partially_completed') ORDER BY seq LIMIT 1) AS current_stage,
             (SELECT stage FROM job_stages WHERE job_card_id=jc.id AND status='pending' ORDER BY seq LIMIT 1) AS next_stage,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id AND status='completed') AS done_stages,
             (SELECT COUNT(*)::int FROM job_stages WHERE job_card_id=jc.id) AS total_stages
      FROM demand d
      LEFT JOIN LATERAL (
        SELECT jc2.*
        FROM job_cards jc2
        WHERE jc2.order_line_id = d.line_id
           OR (d.gang_run_id IS NOT NULL AND jc2.gang_run_id = d.gang_run_id
               AND jc2.parent_job_card_id IS NULL AND jc2.status IN ('open','in_progress'))
        ORDER BY CASE WHEN jc2.order_line_id = d.line_id THEN 0 ELSE 1 END, jc2.id DESC
        LIMIT 1
      ) jc ON true
      ORDER BY d.overdue_days DESC, d.delivery_date ASC NULLS LAST, d.line_id`);

    // A job card still open means that quantity is in flight on the floor —
    // FG is only credited when the card closes.
    const wipOf = l => (l.jc_status && l.jc_status !== 'closed' ? +l.qty_planned || 0 : 0);

    const byProduct = {};
    for (const l of rows) {
      const m = (byProduct[l.product_id] ||= {
        key: l.product_id, label: l.product_name, code: l.product_code, size: l.size,
        pending_qty: 0, pending_value: 0, fg_qty: +l.fg_qty, fg_allocated_qty: 0,
        production_required_qty: 0, wip_qty: 0,
        orders: new Set(), customers: new Set(), overdue_lines: 0, overdue: 0, max_age: 0,
      });
      m.pending_qty += +l.pending_qty;
      m.pending_value += +l.pending_value;
      m.fg_allocated_qty += +l.fg_allocated_qty;
      m.production_required_qty += +l.production_required_qty;
      m.wip_qty += wipOf(l);
      m.orders.add(l.order_id);
      m.customers.add(l.customer_id);
      if (l.overdue_days > 0) m.overdue_lines += 1;
      m.overdue = Math.max(m.overdue, l.overdue_days);
      m.max_age = Math.max(m.max_age, l.age_days);
    }

    const byCustomer = {};
    for (const l of rows) {
      const m = (byCustomer[l.customer_id] ||= {
        key: l.customer_id, label: l.customer_name,
        pending_qty: 0, pending_value: 0, fg_allocated_qty: 0, production_required_qty: 0,
        wip_qty: 0, lines: 0, overdue_lines: 0,
        orders: new Set(), products: new Set(), overdue: 0, max_age: 0,
      });
      m.pending_qty += +l.pending_qty;
      m.pending_value += +l.pending_value;
      m.fg_allocated_qty += +l.fg_allocated_qty;
      m.production_required_qty += +l.production_required_qty;
      m.wip_qty += wipOf(l);
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
          to_plan: Math.max(0, m.production_required_qty - m.wip_qty),
        }))
        .sort((a, b) => b.pending_qty - a.pending_qty),
      by_customer: Object.values(byCustomer)
        .map(m => ({ ...m, orders: m.orders.size, products: m.products.size }))
        .sort((a, b) => b.pending_value - a.pending_value),
    });
  } catch (e) { next(e); }
});

// ── Status Sheet ──────────────────────────────────────────────────────────────
// A live, editable coordination sheet — one row per pending order-line still owed
// to a customer (same demand filter as pendency). Printed is DERIVED from our
// printing stage with a manual override; WIP is a manual flag describing the
// CUSTOMER's work-in-progress (not our floor); EDD (orders.delivery_date) is
// edited inline with no overdue block; P1 is a manual PER-LINE priority flag —
// starring one product must never light up the sibling products on the same PO.
r.get('/status-sheet', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT ol.id AS line_id, ol.order_id, o.po_number, o.po_date, o.delivery_date,
             ol.is_p1,
             ol.gang_run_id, gg.gang_number, gg.kind AS run_kind,
             c.id AS customer_id, c.name AS customer_name,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
             p.party_item_code, p.size,
             ol.qty, ol.dispatched_qty, (ol.qty - ol.dispatched_qty) AS pending_qty,
             ol.wip, ol.wip_date, ol.printed_override,
             CASE WHEN o.delivery_date IS NOT NULL AND o.delivery_date::date < ${PLANT_TODAY_SQL}
                  THEN (${PLANT_TODAY_SQL} - o.delivery_date::date)::int ELSE 0 END AS overdue_days,
             EXISTS (
               SELECT 1 FROM job_cards jc
               JOIN job_stages js ON js.job_card_id = jc.id
               WHERE (jc.order_line_id = ol.id
                      OR (ol.gang_run_id IS NOT NULL AND jc.gang_run_id = ol.gang_run_id
                          AND jc.parent_job_card_id IS NULL))
                 AND js.stage = 'printing' AND js.status = 'completed'
             ) AS printed_derived
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
      WHERE o.status IN ('pending','hold') AND ol.status NOT IN ('cancelled','dispatched')
        AND ol.qty > ol.dispatched_qty AND ol.completed_at IS NULL
      ORDER BY ol.is_p1 DESC,
               (CASE WHEN o.delivery_date IS NOT NULL AND o.delivery_date::date < ${PLANT_TODAY_SQL}
                     THEN (${PLANT_TODAY_SQL} - o.delivery_date::date)::int ELSE 0 END) DESC,
               o.delivery_date ASC NULLS LAST, ol.id`);
    // Manual override wins over the derived production signal (NULL = follow derived).
    // FUTURE auto-P1: when customers.priority lands, OR it into is_p1 here.
    for (const l of rows) {
      l.printed_resolved = (l.printed_override == null) ? l.printed_derived : l.printed_override;
    }
    // Live stage chips — one batched query for the whole sheet. A ganged line
    // rides the gang PARENT card until die cutting, then its own split child
    // card: parent stages first (gang_shared), then the line's own, mirroring
    // /track/:id. Lines without a job card simply get no stages array entry.
    const ids = rows.map(l => l.line_id);
    if (ids.length) {
      const stageRows = await q(`
        SELECT ol.id AS line_id, js.stage, js.status,
               (jc.order_line_id IS NULL) AS gang_shared
        FROM order_lines ol
        JOIN job_cards jc ON (jc.order_line_id = ol.id
             OR (ol.gang_run_id IS NOT NULL AND jc.gang_run_id = ol.gang_run_id
                 AND jc.order_line_id IS NULL))
        JOIN job_stages js ON js.job_card_id = jc.id
        WHERE ol.id = ANY($1::int[])
        ORDER BY ol.id, (jc.order_line_id IS NULL) DESC, js.seq`, [ids]);
      const byLine = new Map();
      for (const s of stageRows) {
        if (!byLine.has(s.line_id)) byLine.set(s.line_id, []);
        byLine.get(s.line_id).push({ stage: s.stage, status: s.status, gang_shared: s.gang_shared });
      }
      for (const l of rows) l.stages = byLine.get(l.line_id) || [];
    }
    res.json({ lines: rows });
  } catch (e) { next(e); }
});

// Line-level edits: Printed override (true/false/null=Auto), the customer WIP
// flag, and the per-product P1 star (priority stays on the starred line only).
r.patch('/status-sheet/line/:id', canPlan, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const sets = [], vals = [];
    if ('printed_override' in req.body) { vals.push(req.body.printed_override); sets.push(`printed_override=$${vals.length}`); }
    if ('wip' in req.body) { vals.push(req.body.wip); sets.push(`wip=$${vals.length}`); }
    // The date rides the flag: explicit when given (the uploaded sheet's own
    // date), today when a line is flagged bare, cleared with the flag — a
    // date with no flag is a stale claim.
    if ('wip_date' in req.body) { vals.push(req.body.wip_date || null); sets.push(`wip_date=$${vals.length}`); }
    else if ('wip' in req.body) {
      vals.push(req.body.wip ? plantDateStr() : null);
      sets.push(`wip_date=$${vals.length}`);
    }
    if ('is_p1' in req.body) { vals.push(req.body.is_p1 ? 1 : 0); sets.push(`is_p1=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(id);
    const out = await one(`UPDATE order_lines SET ${sets.join(', ')} WHERE id=$${vals.length}
                           RETURNING id, wip, wip_date, printed_override, is_p1`, vals);
    if (!out) return res.status(404).json({ error: 'line not found' });
    await audit('order_line', id, 'status-sheet', JSON.stringify(req.body), q, req.user?.name);
    res.json(out);
  } catch (e) { next(e); }
});

// Order-level edits: EDD (delivery_date, no overdue block). P1 is line-level
// now (see the PATCH above) — the old order-wide flag is no longer written here.
r.patch('/status-sheet/order/:id', canPlan, async (req, res, next) => {
  try {
    const id = +req.params.id;
    const sets = [], vals = [];
    if ('delivery_date' in req.body) { vals.push(req.body.delivery_date || null); sets.push(`delivery_date=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(id);
    const out = await one(`UPDATE orders SET ${sets.join(', ')} WHERE id=$${vals.length}
                           RETURNING id, delivery_date`, vals);
    if (!out) return res.status(404).json({ error: 'order not found' });
    await audit('order', id, 'status-sheet', JSON.stringify(req.body), q, req.user?.name);
    res.json(out);
  } catch (e) { next(e); }
});

// ── Customer WIP upload — parse · match · apply ─────────────────────────────
// The customer sends a WIP list (their "we are waiting on these" sheet) as an
// Excel, CSV or PDF. Excel/CSV are read in the BROWSER (exceljs is already in
// the client bundle, and a parsed list of row texts is a few KB where the file
// was megabytes); a PDF's text lives behind pdfjs, which only the server has,
// so PDFs come here first. Both funnels end at /wip-match with plain row
// texts, and nothing writes until the planner confirms at /wip-apply.

const wipUpload = multer({
  storage: multer.memoryStorage(),
  // 4 MB is the REAL ceiling — Vercel rejects bodies past ~4.5 MB before
  // Express runs (see shadecards.js DOC_MAX_BYTES for the incident).
  limits: { fileSize: 4 * 1024 * 1024 },
});
const wipUploadOne = (req, res, next) => wipUpload.single('file')(req, res, err => {
  if (err) {
    return res.status(400).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? 'Files are capped at 4 MB — export a smaller list and try again'
        : err.message,
    });
  }
  next();
});

// One funnel for every format the customer sends, decided by MAGIC BYTES, not
// the filename: %PDF → pdfjs row extraction, PK (a zip = .xlsx) → exceljs,
// anything else → treated as CSV/plain text. Everything lands as row texts.
// exceljs runs HERE and not in the browser because its READ path (unlike the
// write path the exporter uses) never resolves under the browser bundle —
// found the hard way: wb.xlsx.load() hangs even on a file exceljs just wrote.
r.post('/status-sheet/wip-parse', canPlan, wipUploadOne, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const buf = req.file.buffer;
    const head = buf.subarray(0, 5).toString();

    if (head.startsWith('%PDF')) {
      const rows = await extractRows(buf);
      const texts = rows.map(x => x.text);
      // A "PDF" with no extractable text is a scan — same verdict the PO
      // import gives, same honest message.
      if (texts.join('').replace(/\s/g, '').length < 40) {
        return res.status(422).json({ code: 'scanned', error: 'This PDF is a scan — it has no selectable text. Ask for the original file or an Excel export.' });
      }
      return res.json({ rows: texts });
    }

    if (head.startsWith('PK')) {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const texts = [];
      // Every worksheet — customers hide the real list behind a title sheet
      // often enough that reading only the first would return headings.
      wb.eachSheet(ws => {
        ws.eachRow(row => {
          const cells = (Array.isArray(row.values) ? row.values : []).map(v => {
            if (v == null) return '';
            if (v instanceof Date) {
              // dd/mm/yyyy — the shape rowDate()'s DATE_RE reads, day first
              // like every Indian customer sheet.
              const d = String(v.getUTCDate()).padStart(2, '0');
              const m = String(v.getUTCMonth() + 1).padStart(2, '0');
              return `${d}/${m}/${v.getUTCFullYear()}`;
            }
            if (typeof v === 'object') return String(v.text ?? v.result ?? '');
            return String(v);
          }).filter(Boolean);
          if (cells.length) texts.push(cells.join(' '));
        });
      });
      return res.json({ rows: texts });
    }

    // CSV / plain text
    const texts = buf.toString('utf8').split(/\r?\n/).map(l =>
      l.split(',').map(c => c.replace(/^\s*"|"\s*$/g, '').trim()).filter(Boolean).join(' '));
    return res.json({ rows: texts });
  } catch (e) { next(e); }
});

// Match row texts against the products currently PENDING on the Status Sheet.
// Candidates are only those products — matching against the whole master file
// would happily map items the plant is not making, and the sheet is the scope
// the planner is looking at. A matched product fans out to EVERY pending line
// of that product: the customer chases the product, not our order split.
r.post('/status-sheet/wip-match', canPlan, async (req, res, next) => {
  try {
    const texts = (Array.isArray(req.body.rows) ? req.body.rows : [])
      .map(t => String(t ?? '')).slice(0, 2000);
    if (!texts.length) return res.status(400).json({ error: 'No rows to match' });
    const lines = await q(`
      SELECT ol.id AS line_id, ol.order_id, ol.wip, ol.wip_date, o.po_number,
             c.name AS customer_name,
             p.id AS product_id, p.name, p.code, p.party_item_code
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE o.status IN ('pending','hold') AND ol.status NOT IN ('cancelled','dispatched')
        AND ol.qty > ol.dispatched_qty AND ol.completed_at IS NULL`);
    const byProduct = new Map();
    for (const l of lines) {
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
      byProduct.get(l.product_id).push(l);
    }
    const products = [...byProduct.values()].map(ls => ls[0])
      .map(l => ({ id: l.product_id, name: l.name, code: l.code, party_item_code: l.party_item_code }));
    const aliases = products.length ? await q(
      `SELECT product_id, alias_norm FROM product_aliases WHERE product_id = ANY($1)`,
      [products.map(p => p.id)]).catch(() => []) : [];
    const verdicts = matchWipRows(texts, products, aliases);
    const items = verdicts.filter(v => v.status !== 'none').map(v => ({
      ...v,
      lines: (byProduct.get(v.product_id) || []).map(l => ({
        line_id: l.line_id, po_number: l.po_number, customer_name: l.customer_name,
        already_wip: !!l.wip,
      })),
    })).filter(v => v.lines.length);
    res.json({
      items,
      unmatched: verdicts.filter(v => v.status === 'none').length,
      scanned_rows: texts.length,
    });
  } catch (e) { next(e); }
});

// The planner said yes. One transaction, one audit row per line, and the
// response is the fresh flags so the sheet repaints without a reload.
r.post('/status-sheet/wip-apply', canPlan, async (req, res, next) => {
  try {
    const items = (Array.isArray(req.body.items) ? req.body.items : [])
      .map(x => ({ line_id: +x.line_id, wip_date: x.wip_date || null }))
      .filter(x => x.line_id);
    if (!items.length) return res.status(400).json({ error: 'Nothing selected' });
    const today = plantDateStr();
    const out = await tx(async (qc) => {
      const done = [];
      for (const it of items) {
        const row = await qc(
          `UPDATE order_lines SET wip=true, wip_date=$2 WHERE id=$1
           RETURNING id, wip, wip_date`, [it.line_id, it.wip_date || today]);
        if (!row[0]) continue;
        await audit('order_line', it.line_id, 'status-sheet-wip-import',
          `marked Customer WIP (${row[0].wip_date}) from an uploaded WIP list`, qc, req.user?.name);
        done.push(row[0]);
      }
      return done;
    });
    res.json({ applied: out });
  } catch (e) { next(e); }
});

// ── Planning ────────────────────────────────────────────────────────────────

// Set-type triage — the planner's Single / Gang / Hold tag on a queue line.
// Advisory only: it moves the line between the queue's zones and gates
// nothing. Two rules keep the zones honest:
//   • a line in a gang_run can never be tagged single — it physically shares
//     a sheet; the tag would lie. Remove it from the gang first.
//   • gang / hold on a ganged line fans out to EVERY member — the run moves
//     as one, so half a gang can never sit in a different zone (the client
//     reads hold off any member for the same reason).
// Only pending lines retag: once a plan is locked the tag is history, not a
// control, so the server refuses instead of silently rewriting it.
r.patch('/planning/:id/set-type', canPlanWork, async (req, res, next) => {
  try {
    const set_type = String(req.body.set_type || '');
    const reason = String(req.body.hold_reason || '').trim();
    const line = await one('SELECT id, status, gang_run_id FROM order_lines WHERE id=$1', [+req.params.id]);
    if (!line) throw Object.assign(new Error('Order line not found'), { status: 404 });
    const members = line.gang_run_id
      ? await q('SELECT id, status FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id])
      : [line];
    const refusal = setTypeError({ line, members, set_type, reason });
    if (refusal) throw Object.assign(new Error(refusal), { status: 400 });
    const ids = members.map(m => m.id);
    await q(`UPDATE order_lines
        SET set_type=$1, hold_reason=$2, set_type_by=$3, set_type_at=now()
        WHERE id = ANY($4::int[])`,
      [set_type, set_type === 'hold' ? reason : null, req.user.name, ids]);
    for (const id of ids)
      await audit('order_line', id, `set_type:${set_type}`, set_type === 'hold' ? reason : null, q, req.user.name);
    res.json({ updated: ids.length, set_type });
  } catch (e) { next(e); }
});

r.get('/planning', async (_req, res, next) => {
  try {
    // pending/planned/ready are the planner's live queue; in_production lines
    // (already pushed to a job card) feed the "Completed" tab and the "All" view.
    // Newest sales order first (orders.id rises with entry), lines in their own
    // order within it — a PO booked this morning tops the queue instead of
    // sinking to wherever its delivery date fell. The table's default sort
    // mirrors this; any column header still re-sorts the queue by hand.
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('pending','planned','ready','in_production')
      ORDER BY ol.order_id DESC, ol.id`);
    // One batch of lookups for the whole queue instead of six per line — the
    // page cost no longer scales with how many lines are waiting. fg_available
    // is the verified FG matching each line (Internal Carton → Party Artwork →
    // Product Code), driving the queue's "FG Stock Available" column.
    const ctx = await readinessBatch(rows);
    // The traffic light over those same gates, so Planning and the floor can
    // never hold two opinions about one job. A planning LINE is not a job card:
    // it has no cutting stage of its own, so it is keyed negatively here — no
    // job_stages row can ever match, which leaves "Board cut" not-applicable
    // rather than late while the shade verdict still resolves by product. A
    // line already pushed rides a card (the gang PARENT for a ganged line) and
    // only its release stamp is read: the parent's manual override is
    // deliberately NOT applied, so a gang member's own readiness is never
    // silently rewritten by the press run it shares.
    const lightExtras = await lightForJobCards(
      rows.map(l => ({ id: -l.id, product_id: l.product_id })), one);
    // jc.id rides along with finalised_at now: Planning's one-click Issue
    // action needs the job card id so a card issued against an already-pushed
    // line can auto-return when printing completes (production.js keys the
    // auto-return off shade_card_issues.job_card_id).
    const released = new Map((rows.length ? await q(`
      SELECT ol.id AS line_id, jc.finalised_at, jc.id AS job_card_id
      FROM order_lines ol
      JOIN job_cards jc ON (jc.order_line_id = ol.id
           OR (ol.gang_run_id IS NOT NULL AND jc.gang_run_id = ol.gang_run_id
               AND jc.order_line_id IS NULL))
      WHERE ol.id = ANY($1::int[])`, [rows.map(l => l.id)]) : [])
      .map(c => [c.line_id, c]));
    // Shade card status for Planning's one-click Issue action: the module's
    // live card per product (shadeCardsFor already carries shade_card_id +
    // status), plus which cards are currently OUT so the button hides once a
    // card is already with printing.
    const shadeCards = await shadeCardsFor(rows.map(l => l.product_id));
    const shadeOpen = await q(`SELECT shade_card_id FROM shade_card_issues WHERE returned_at IS NULL`);
    const openSet = new Set(shadeOpen.map(x => x.shade_card_id));
    // Board on order per line — ONE query for the whole queue. Feeds the
    // three-state board verdict the chips filter on (covered / on_order /
    // short) so Planning and Print Planning speak the same vocabulary and a
    // GRN in procurement moves both at once.
    // Gates once per line, feeding BOTH the board verdict and the traffic
    // light, so the two can never describe different facts.
    const gatesByLine = new Map();
    for (const l of rows) gatesByLine.set(l.id, await readiness(l, one, ctx));
    // ONE rule for the verdict, shared with Print Planning, Job Cards and the
    // cutting queue — and the only place that can see a RUN's combined
    // requirement, which no per-line gate can (see stampBoardState).
    await stampBoardState(rows, {
      lineIdOf: l => l.id,
      gangIdOf: l => l.gang_run_id,
      gatesOf: l => gatesByLine.get(l.id),
    });
    // Plates, in the same vocabulary and the same one-query shape. A line with no
    // job card yet gets null, not red — the requirement is raised at finalisation.
    // The job card comes from `released`, NOT from the row — the same source the
    // payload's own job_card_id uses below. Reading l.job_card_id here silently
    // stamped nothing at all, because the raw row does not carry it.
    await stampPlateState(rows, {
      jobCardIdOf: l => released.get(l.id)?.job_card_id ?? null,
      gangIdOf: l => l.gang_run_id,
    });
    const out = [];
    for (const l of rows) {
      const gates = gatesByLine.get(l.id);
      const sc = shadeCards[l.product_id];
      out.push({
        ...l,                       // carries board_state, stamped above
        readiness: gates,
        light: readinessLight({
          gates, ...lightExtras.get(-l.id),
          machineId: l.machine_id, finalisedAt: released.get(l.id)?.finalised_at ?? null, toolingOk: l.tooling_ok,
        }),
        fg_available: fgAvailableFromCtx(l, ctx),
        job_card_id: released.get(l.id)?.job_card_id ?? null,
        shade_card_id: sc?.shade_card_id ?? null,
        shade_status: sc?.status ?? null,
        shade_with_printing: openSet.has(sc?.shade_card_id),
      });
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Distinct spec values the Product Master actually uses — feeds the planning
// engine's Coating / Special pickers so they offer the real plant vocabulary
// ("Aqueous Varnish", "Drip Off", …) instead of a hardcoded enum. Ordered by
// how common each value is; free typing still passes through (datalist).
r.get('/spec-options', async (_req, res, next) => {
  try {
    const opts = {};
    for (const col of ['coating', 'special', 'colour_type', 'print_process', 'pantone_codes', 'metallic_details', 'pasting_type', 'leafing_colour']) {
      const rows = await q(
        `SELECT ${col} AS v FROM products WHERE ${col} IS NOT NULL AND ${col} <> ''
         GROUP BY ${col} ORDER BY COUNT(*) DESC, ${col}`);
      opts[col] = rows.map(x => x.v);
    }
    res.json(opts);
  } catch (e) { next(e); }
});

// Popup payload for "Use FG Stock" straight from the Planning Queue: the order
// context, the codes, and every verified stock reference that matches by the
// code hierarchy — with the running ledger for each reference.
r.get('/order-lines/:id/fg-match', async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const lots = await q(`
      SELECT fl.*, (fl.qty - fl.consumed_qty) AS remaining,
             fp.name AS lot_product_name, fp.code AS lot_product_code,
             fp.internal_carton_code AS lot_carton_code, fp.party_artwork_code AS lot_artwork_code,
             jc.jc_number AS source_batch, o.po_number AS source_po
      FROM fg_lots fl
      JOIN products fp ON fp.id = fl.product_id
      JOIN products p ON p.id = $1
      LEFT JOIN job_cards jc ON jc.id = fl.job_card_id
      LEFT JOIN order_lines sol ON sol.id = fl.order_line_id
      LEFT JOIN orders o ON o.id = sol.order_id
      WHERE fl.status='verified' AND (fl.qty - fl.consumed_qty) > 0 AND ${fgMatchPredicate()}
      ORDER BY fl.id`, [line.product_id]);
    const withMatch = lots.map(l => ({
      ...l,
      matched_by: fgMatchedBy(line, {
        internal_carton_code: l.lot_carton_code, party_artwork_code: l.lot_artwork_code, code: l.lot_product_code,
      }),
    }));
    // Ledger rows for the matched references (most recent first, capped).
    const refs = [...new Set(withMatch.map(l => l.lot_number))];
    const ledger = refs.length ? await q(`
      SELECT * FROM fg_movements WHERE ref_number = ANY($1::text[]) ORDER BY id DESC LIMIT 50`, [refs]) : [];
    res.json({
      line: {
        id: line.id, po_number: line.po_number, customer_name: line.customer_name,
        internal_carton_code: line.internal_carton_code, party_artwork_code: line.party_artwork_code,
        product_code: line.product_code, product_name: line.product_name,
        gsm: line.gsm, size: line.size, coating: line.coating, board_name: line.board_name,
        qty: line.qty, fg_consumed_qty: line.fg_consumed_qty || 0,
        balance_to_produce: netProduceQty(line), status: line.status,
      },
      fg_available: withMatch.reduce((s, l) => s + l.remaining, 0),
      lots: withMatch,
      ledger,
    });
  } catch (e) { next(e); }
});

// Master-driven spec fields a planner may edit in the planning engine.
// board_material_id joins the list so a warehouse stock selection follows the
// same philosophy: save for this job only, or update the Product Master.
// Printing colour and process ride the SAME job-only/master fork as every other
// spec field, so "change it in Planning → asked whether to update the master →
// audited" comes for free rather than growing a second, divergent path.
const SPEC_FIELDS = ['ups', 'wastage_pct', 'colors', 'colour_type', 'print_process', 'cmyk_colours', 'pantone_colours', 'pantone_codes', 'metallic_colours', 'metallic_details', 'print_instructions', 'pasting_type', 'coating', 'special', 'emboss', 'leafing', 'leafing_colour', 'child_l', 'child_w', 'parent_l', 'parent_w', 'board_material_id', 'party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'die_number', 'block_number'];
const INT_SPEC = ['ups', 'colors', 'cmyk_colours', 'pantone_colours', 'metallic_colours', 'emboss', 'leafing', 'board_material_id'];
const TEXT_SPEC = ['colour_type', 'print_process', 'pantone_codes', 'metallic_details', 'print_instructions', 'pasting_type', 'coating', 'special', 'leafing_colour', 'party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'die_number', 'block_number'];

// Board grade (brand) + GSM live on the product but ARE the board's identity —
// when the finalised board changes, they follow it. First word = grade (matches
// the board_grade backfill), "NNN gsm" in the name/spec = GSM.
function boardIdentity(board) {
  if (!board) return {};
  const grade = String(board.name || '').trim().split(/[\s·]+/)[0] || null;
  const m = String(board.name || '').match(/(\d{2,4})\s*gsm/i) || String(board.spec || '').match(/(\d{2,4})\s*gsm/i);
  return { board_grade: grade, gsm: m ? +m[1] : null };
}

r.post('/order-lines/:id/plan', canPlanWork, async (req, res, next) => {
  try {
    // Press + date now live in Print Planning; the engine locks spec, cut plan
    // and remarks only. machine_id/planned_date are accepted for compatibility
    // but never required — absent values leave the stored ones untouched.
    const { machine_id, planned_date, tooling_ok, wastage_sheets, notes, spec = {}, update_master, leftover, qty } = req.body;
    // A DRAFT save is the planner's "save my work" — every figure on the screen
    // is written exactly as a lock writes it, but the job does not leave the To
    // Plan list. It is not a weaker save; it is the same save without the status
    // flip, so re-opening the engine finds the work where it was left.
    //
    // Nothing downstream sees a draft: BOARD_DEMAND_STATUSES starts at
    // 'planned', so a job still sitting at 'pending' claims no board, raises no
    // committed figure and reaches no station. That is what makes this safe to
    // offer — a half-finished plan cannot quietly start competing for stock.
    const draft = !!req.body.draft;
    // Boards the mix planned but the shelf could not cover. Collected inside the
    // transaction, spoken after it commits: the plan is saved either way.
    const boardShortfalls = [];
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });

      // Planning is over once the job leaves for the floor. This route rewrites
      // sheets_required, parent_sheets_required, the spec override and the board
      // mix (clearMixPlan wipes it outright) — all of it frozen into the job card
      // at finalise, into children_per_parent, and into the board already issued
      // to cutting. Re-locking a job that has been cut and printed would true its
      // consumption and cutting variance up against a plan that no longer
      // describes what the plant physically did.
      //
      // Nothing enforced this before: only `pending` was ever branched on (for
      // the status flip below), so an in_production line sailed straight through.
      // Reversing the job card back to Planning is the supported way to re-plan —
      // the floor already uses it — so this refuses and names that path rather
      // than silently rewriting production history.
      if (!['pending', 'planned', 'ready'].includes(line.status)) {
        throw Object.assign(
          new Error(`This plan is locked — ${line.status.replace(/_/g, ' ')} work cannot be re-planned. `
            + 'Reverse the job card back to Planning first if the cut plan really must change.'),
          { status: 409, body: { code: 'PLAN_ALREADY_EXECUTED', at: { stage: null, status: line.status } } });
      }

      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);

      // Order quantity is editable from the engine. Update it BEFORE the cut plan
      // is computed so the sheet count reflects the new requirement. Guarded by
      // what's already gone out the door.
      if (qty !== undefined && qty !== null && qty !== '') {
        const nq = Math.round(+qty);
        if (!Number.isFinite(nq) || nq <= 0)
          throw Object.assign(new Error('Order quantity must be greater than zero'), { status: 400 });
        if (nq < line.dispatched_qty)
          throw Object.assign(new Error(`Quantity cannot go below the ${line.dispatched_qty} already dispatched`), { status: 400 });
        if (nq !== line.qty) {
          await qc('UPDATE order_lines SET qty=$1 WHERE id=$2', [nq, line.id]);
          await audit('order_line', line.id, 'qty_edit', `${line.qty} → ${nq} (planning engine)`, qc, req.user.name);
          line.qty = nq;
        }
      }

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
      //
      // The choice is per FIELD, not per save. A planner who retunes ups for
      // good and trims the parent for this run only was previously forced to
      // answer one question for both — and answering it either way filed one of
      // the two changes in the wrong place. `master_fields` is the subset of
      // `changed` the planner ticked; everything else in the same save falls
      // through to the job-only override below. Omitting it entirely keeps the
      // old all-or-nothing behaviour, so every existing caller is unaffected.
      const { toMaster, toJob } = splitMasterFields({
        changed, updateMaster: !!update_master, masterFields: req.body.master_fields,
      });
      let nextOverride = { ...prev };
      for (const f of cleared) delete nextOverride[f];
      if (Object.keys(toMaster).length) {
        {
          // Finalising the board also carries its grade + GSM back to the master —
          // the board IS the source of both, so they never drift out of sync.
          const masterChanged = { ...toMaster };
          if (toMaster.board_material_id) {
            const nb = await oc('SELECT name, spec FROM materials WHERE id=$1', [toMaster.board_material_id]);
            const id = boardIdentity(nb);
            if (id.board_grade) masterChanged.board_grade = id.board_grade;
            if (id.gsm != null) masterChanged.gsm = id.gsm;
            // The denormalised copy follows the link here too. It did not
            // before — board_name is not in SPEC_FIELDS, so this path wrote the
            // grade and GSM but left the name naming the old board, exactly the
            // drift syncProductBoardName() exists to prevent on the master form
            // (its comment already claims Planning keeps the two in step; for
            // the stored column that was not true). It matters more now: a
            // product raised without a board has NO name to go stale, and
            // Planning is the first place one is ever chosen — leave it out and
            // the Board column in the Products master stays blank for good.
            // Guarded by `changed.board_material_id`, so this is a REAL link
            // change and no rate edit can reformat a thousand legacy names.
            if (nb?.name) masterChanged.board_name = nb.name;
            // This IS the journey completing. A product raised without a board
            // was parked on a placeholder and flagged spec_incomplete; naming
            // the real board here is precisely the fact the flag was waiting
            // for, so it clears itself rather than needing a second trip to
            // Masters. Only on a board change — an update that merely retunes
            // ups or colours has not answered the question the flag asks.
            if (product.spec_incomplete) masterChanged.spec_incomplete = 0;
          }
          const sets = Object.keys(masterChanged).map((c, i) => `${c}=$${i + 1}`).join(',');
          await qc(`UPDATE products SET ${sets} WHERE id=$${Object.keys(masterChanged).length + 1}`,
            [...Object.values(masterChanged), product.id]);
          for (const f of Object.keys(masterChanged)) delete nextOverride[f];
          await audit('product', product.id, 'master_update',
            `from planning: ${Object.entries(masterChanged).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v}`).join('; ')}`.slice(0, 500),
            qc, req.user.name);
        }
      }
      // Everything the planner did NOT tick — and every field of an ordinary
      // "Save for this Job Only" — stays on the line. Both audit rows can be
      // written for one save now, which is the point: a split decision leaves a
      // split trail, naming which fields went where.
      if (Object.keys(toJob).length) {
        nextOverride = { ...nextOverride, ...toJob };
        await audit('order_line', line.id, 'spec_override',
          `job-only: ${Object.entries(toJob).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v}`).join('; ')}`.slice(0, 500),
          qc, req.user.name);
      }
      const jobOverride = Object.keys(nextOverride).length ? nextOverride : null;

      // Effective spec = master + surviving job override + this lock's changes.
      const eff = { ...product, ...nextOverride, ...changed };
      const wastage = wastage_sheets === '' || wastage_sheets == null ? null : Math.max(0, Math.round(+wastage_sheets));
      const sheets = sheetsRequired(eff, netProduceQty(line), wastage);
      const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id]);
      // Parent sheet is the product's own finalised size when set, else the board's.
      const parent = effectiveParent(eff, board);
      // …and a finalised size LARGER than the board it is trimmed from is
      // physically impossible — no guillotine enlarges a sheet — yet nothing
      // refused it, so a drifted master (a 25×38 parent filed against a
      // 23×26.5" board, straight off a live screenshot) locked plans whose
      // whole cut arithmetic ran on a sheet the warehouse cannot supply.
      // Orientation-aware (sorted axes) and equal-is-fine — see the helper.
      if (!parentFitsBoard(parent, board)) throw Object.assign(
        new Error(`Parent ${parent.sheet_l}×${parent.sheet_w}" cannot be trimmed from board ${board.sheet_l}×${board.sheet_w}" — fix the parent size in the cut plan or the Product Master`),
        { status: 409 });
      const fit = childFit(parent, eff);
      const parentSheets = parentSheetsRequired(sheets, fit.count);
      // Leftover decision — validated against the effective board's real
      // strips so a stale client can't book nonsense. Rules:
      //   leftover sent        → store it (push:false stores NULL)
      //   leftover absent      → keep the saved decision, UNLESS the board
      //                          changed in this lock (strips no longer match).
      let leftoverPlan = null;
      if (leftover?.push && leftover.strip) {
        const strips = leftoverStrips(parent, eff);
        const pick = strips.find(s =>
          Math.abs(s.l - +leftover.strip.l) < 0.01 && Math.abs(s.w - +leftover.strip.w) < 0.01);
        if (!pick) throw Object.assign(new Error('Leftover strip does not match this board\'s cut plan'), { status: 409 });
        if (!pick.usable) throw Object.assign(new Error(`Strip ${pick.l}×${pick.w}" is under 3" — waste, not stock`), { status: 409 });
        leftoverPlan = { push: true, strip: { l: pick.l, w: pick.w }, strips_per_parent: pick.strips_per_parent,
                         est_sheets: parentSheets, decided_by: req.user.name, decided_at: new Date().toISOString() };
      }
      const keepSaved = leftover === undefined && !changed.board_material_id;
      const prevPlanRaw = typeof line.leftover_plan === 'string' ? JSON.parse(line.leftover_plan) : line.leftover_plan;
      // keepSaved never carries a v2 (per-mix-row) plan forward. Its rows are
      // frozen against mix rows this very save is about to replace or clear
      // (replaceMixPlan/clearMixPlan below), so "keep what was saved" would
      // re-bank LO-PLAN-<line>-<mat> batches for boards the new plan may not
      // cut at all — and cutting-complete would skip them (board absent from
      // the issue), stranding phantom planned stock. A v2 plan exists only
      // when THIS request's mix_leftovers derives it fresh, in the mix block.
      // Legacy single-board plans keep the old keepSaved contract untouched.
      const prevPlan = prevPlanRaw?.version === 2 ? null : prevPlanRaw;
      const finalLeftover = leftover !== undefined ? leftoverPlan : (keepSaved ? prevPlan : null);
      // Planned date is generated the moment the plan locks: an explicit value
      // wins, else the one already stored, else today's lock date. Date columns
      // in this schema are TEXT (YYYY-MM-DD), so the fallback must be text too —
      // CURRENT_DATE::text keeps COALESCE type-consistent.
      // Whose stock the plan runs on. A run decides this once for the whole
      // pile (POST /gang-runs/:id/stock-booking stamps the members), so a
      // member line never takes a per-line value from here. A mix books shelf
      // boards by definition, so locking a mix forces the plan back to 'book'
      // — a fresh_pr flag beside stock-drawing mix rows would fence the claim
      // while the mix draws the shelf, over-quoting free everywhere.
      const wantsMix = Array.isArray(req.body.mix) && req.body.mix.length > 0;
      const stockBooking = line.gang_run_id ? null
        : wantsMix ? 'book'
          : ['book', 'fresh_pr'].includes(req.body.stock_booking) ? req.body.stock_booking : null;
      // A mix save's leftover decision is v2, derived from req.body.
      // mix_leftovers inside the mix block below — only there do the
      // validated rows exist — and written by it. Neither the legacy
      // `leftover` field nor a kept legacy plan applies to a mixed line
      // (which board's strip would a single {push, strip} even name?), so
      // the lock starts from NULL and the mix block writes the real value.
      // No-mix saves store finalLeftover exactly as they always did.
      const storedLeftover = wantsMix ? null : finalLeftover;
      // A draft has no planned date. The lock is what schedules a job, and
      // stamping today onto a job still sitting in To Plan would date work
      // nobody has committed to — the Print Planning board reads that column.
      await qc(`UPDATE order_lines SET machine_id=COALESCE($1, machine_id),
                  planned_date=${draft ? 'COALESCE($2, planned_date)' : 'COALESCE($2, planned_date, CURRENT_DATE::text)'},
                  sheets_required=$3, parent_sheets_required=$4,
                  tooling_ok=COALESCE($5, tooling_ok), spec_override=$6, wastage_sheets=$7, notes=$8,
                  leftover_plan=$9, stock_booking=COALESCE($11, stock_booking) WHERE id=$10`,
        [machine_id || null, planned_date || null, sheets, parentSheets,
         tooling_ok === undefined ? null : (tooling_ok ? 1 : 0),
         jobOverride ? JSON.stringify(jobOverride) : null,
         wastage, notes === undefined ? line.notes : (notes || null),
         storedLeftover ? JSON.stringify(storedLeftover) : null, line.id, stockBooking]);

      // The mix is frozen against the cut plan that produced it — `ups` and
      // `covers` were computed then. Re-planning changes the requirement, the
      // child size or the board underneath it, so a stored mix would balance
      // against arithmetic that no longer holds. Accept a fresh mix when the
      // client sends one; otherwise clear what is there and make the planner
      // rebuild it, rather than releasing a job on a stale balance.
      let v2Plan = null;            // {version:2, rows:[…]} — set by the mix block, banked below
      const mixMats = new Map();    // material_id → its materials row, for the per-row bank
      if (Array.isArray(req.body.mix) && req.body.mix.length) {
        // A gang shares ONE board across several jobs and buys it on a single
        // combined PR. Unpicking one member's board is out of scope, exactly as
        // planMove() already refuses. Same wording, so the floor hears one story.
        if (line.gang_run_id) throw Object.assign(
          new Error(`${product.name} prints in a gang — move the gang's board from Planning`),
          { status: 409 });
        const plannedUps = fit.count;
        if (!(plannedUps > 0)) throw Object.assign(
          new Error('This board and child size cut nothing — fix the cut plan before mixing boards'),
          { status: 409 });
        // One rule for which sheet a row cuts from, shared by the chosen-cuts
        // validation below AND the v2 leftover derivation further down, so
        // the two can never disagree about a row's parent: the planned role
        // cuts from the trimmed parent (effectiveParent — `parent` above), a
        // substitute from its own mother sheet.
        const rowParentFor = (role, mat) =>
          role === 'planned' ? parent : { sheet_l: mat.sheet_l, sheet_w: mat.sheet_w };
        const rows = [];
        for (const raw of req.body.mix) {
          // spec rides along solely for the leftover path below —
          // findOrCreateLeftoverMaster stamps the source board's spec onto
          // the leftover master it mints.
          const mat = await oc('SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE id=$1',
            [+raw.material_id]);
          if (!mat) throw Object.assign(new Error('Unknown board in the mix'), { status: 400 });
          mixMats.set(mat.id, mat);
          // Deliberately NOT effectiveParent(eff, mat): eff.parent_l/parent_w (when
          // set) is a finalised trim of the board CURRENTLY locked in, not a size
          // every candidate would share — folding it into every candidate's fit
          // would silently make ups_differ always false, since every row would be
          // measured against the same overridden sheet regardless of what it
          // actually is physically cut from.
          //
          // This leaves plannedUps (which DOES honour the trim) asymmetric with
          // every candidate's native fit. Checked against live data before
          // shipping: 980 of 1,594 products carry parent_l/parent_w, and NONE of
          // them differs from its board's own sheet size, so the asymmetry is
          // inert today and no real substitution is wrongly refused. Should a
          // genuine trim ever be entered, this errs toward calling the candidate
          // 'heavy' and refusing the save — the safe direction.
          const ups = childFit(mat, eff).count;
          const flags = substitutionFlags({
            plannedBoard: { id: eff.board_material_id, name: board?.name },
            candidateBoard: mat, plannedUps, candidateUps: ups });
          if (!flags.ok) throw Object.assign(
            new Error(`${mat.name} cannot substitute for ${board?.name} — the grade must match`),
            { status: 409 });
          // REPEALED 2026-08-05 (decided by Anik) — this used to 409 here:
          // `${mat.name} cuts ${ups} up against ${plannedUps} — a different
          // imposition needs its own plate, not a substitution`. Differing
          // cuts are planner intent now: the plate never changes — the
          // child/print sheet is identical across every row of a mix — only
          // how many of it each board yields. The refusal's real basis was
          // never a plant rule; it was arithmetic downstream: job_cards
          // stored children_per_parent as a single INTEGER, so a mix of
          // differing ups had no one value for cuttingVariance() to derive
          // parents from. That basis is gone — variance has been per-board
          // since this wave's Task 3 (mixCuttingVariance, judging each row
          // against its OWN cuts, with a per-board true-up at cutting
          // completion) — so nothing downstream needs a shared integer any
          // more.
          //
          // flags.ups_differ is still computed above and still returned
          // as-is: severity/labelling never changed (chosen cuts change how
          // a board is CUT, never what it IS), and the client still reads it
          // to drive the reason-required warning.
          const role = mat.id === +eff.board_material_id ? 'planned' : 'substitute';
          // Same per-row parent rule the v2 leftover derivation uses below
          // (rowParentFor, declared above) — so a chosen cut count is
          // validated against exactly the sheet it will actually be banked
          // against.
          const rowParent = rowParentFor(role, mat);
          // The board's natural ceiling when nothing is chosen: a
          // substitute's is its own native fit (`ups` above); the planned
          // row's is plannedUps itself, the unit the requirement was derived
          // in — not `ups`, which for the planned row can differ from
          // plannedUps in the (today inert — see the comment above) parent-
          // override edge case. Today's behaviour when no chosen value is
          // sent — unchanged.
          const naturalMax = role === 'planned' ? plannedUps : ups;
          let chosenUps = naturalMax;
          if (raw.ups !== undefined && raw.ups !== null && raw.ups !== '') {
            // Coerce & guard BEFORE validating. chosenCutsValid's own
            // internal `Math.round(+k || 0)` would silently reinterpret
            // garbage (a non-numeric string, or a fraction like 2.9) into a
            // DIFFERENT integer than the one this block would go on to
            // store — and job_board_mix.ups is INTEGER NOT NULL CHECK
            // (ups > 0), so a fractional value would fail there as a raw
            // type-cast error instead of a plain refusal here.
            // Number.isFinite + Number.isInteger is the guard; `+raw.ups` is
            // not.
            const rawUps = Number(raw.ups);
            if (!Number.isFinite(rawUps) || !Number.isInteger(rawUps)) throw Object.assign(
              new Error(`Enter a whole number of cuts for ${mat.name}`), { status: 400 });
            const cutsCheck = chosenCutsValid(rowParent, eff, rawUps);
            if (!cutsCheck.ok) throw Object.assign(
              new Error(`${mat.name}: ${cutsCheck.why}`), { status: 409 });
            chosenUps = rawUps;
          }
          // Coerce NUMERICALLY before the DB sees it. Postgres orders NaN above
          // every other double, so 'NaN'::double precision > 0 is TRUE — a
          // non-numeric sheets would sail through both CHECK (sheets > 0) and
          // CHECK (covers > 0) and poison this line's balance permanently.
          // Number.isFinite is the guard; `+raw.sheets || 0` is not.
          const sheets = Number(raw.sheets);
          if (!Number.isFinite(sheets) || !(sheets > 0)) throw Object.assign(
            new Error(`Enter a sheet count for ${mat.name}`), { status: 400 });
          // A substitution WITHOUT a reason is a soft alarm, never a refusal.
          // This used to 400 (`Give a reason for using ${mat.name}`) and it
          // stopped a plan the plant had already decided on — the board is in
          // the warehouse, the grade matches, the ups match, the mix balances,
          // and the only thing missing was a sentence.
          //
          // A blank one no longer lands NULL either: a SUBSTITUTE row falls back
          // to DEFAULT_MIX_REASON, so the job card, the allocation note and the
          // audit trail all read the same plain sentence. The client pre-fills
          // that same constant, so this is a backstop for a cleared field or a
          // caller that isn't the planning engine — not the normal path. The
          // PLANNED row keeps NULL: its own board needs no explaining.
          //
          // flags.reason_required is unchanged and still true here — it is what
          // drives the warning on screen. It just no longer decides the request.
          // The HARD refusals above stay hard: wrong grade, and an ups change
          // that needs its own plate. Those are physics; this was paperwork.
          const reason = String(raw.reason || '').trim()
            || (role === 'substitute' ? DEFAULT_MIX_REASON : null);
          // A named lot must belong to the board it is named against. Nothing in
          // the schema enforces the pair — job_board_mix carries material_id and
          // stock_batch_id as independent FKs — so a client bug could file a lot
          // under the wrong board and consumeFifo would silently ignore it at
          // issue, quietly demoting a deliberate lot choice back to FIFO. Refuse
          // it here, where the planner is still looking at the screen.
          let batchId = null;
          if (raw.stock_batch_id) {
            batchId = +raw.stock_batch_id;
            const b = await oc('SELECT id FROM stock_batches WHERE id=$1 AND material_id=$2',
              [batchId, mat.id]);
            if (!b) throw Object.assign(
              new Error(`That lot does not belong to ${mat.name} — pick a lot of this board, or leave it blank for FIFO`),
              { status: 409 });
          }
          rows.push({
            material_id: mat.id,
            stock_batch_id: batchId,
            sheets,
            ups: chosenUps,
            covers: rowCovers({ sheets, ups: chosenUps, plannedUps }),
            role,
            reason,
          });
        }
        const bal = mixBalance({ required: parentSheets, rows });
        // Under-coverage only. Over-coverage is the planner's decision and is
        // often unavoidable once cuts differ — see mixBalance's `sufficient`.
        if (!bal.sufficient) throw Object.assign(
          new Error(`The board mix covers ${Math.round(bal.covered)} of ${Math.round(bal.required)} parent sheets — allocate ${Math.ceil(bal.balance)} more`),
          { status: 409 });

        // ── Per-row leftover choices (v2) ─────────────────────────────────
        // req.body.mix_leftovers: [{material_id, bank}] — banking is opt-in
        // per mix row. The strip is derived HERE from the row's own geometry,
        // never taken from the client: a planned-role row cuts from the
        // trimmed parent (effectiveParent — `parent` above), a substitute
        // from its own mother sheet, the same asymmetry the ups computation
        // above documents at length. The stored shape matches production.js's
        // cutting-complete v2 reader field for field — {version:2, rows:
        // [{material_id, cuts, strip:{l,w}, strips_per_parent, est_sheets}]}
        // — where est_sheets is that row's PARENT sheets (job_board_mix
        // .sheets), the figure the confirm replaces with actualParents.
        // A bank request for a board not in the mix is ignored, not refused:
        // the mix rows are the plan, the toggles only decorate them. No
        // mix_leftovers at all (or every row off) leaves v2Plan null — the
        // main UPDATE above already stored NULL, and the bank section below
        // sweeps whatever an earlier lock banked.
        const bankWanted = new Map(
          (Array.isArray(req.body.mix_leftovers) ? req.body.mix_leftovers : [])
            .map(x => [+x.material_id, !!x.bank]));
        const v2Rows = [];
        for (const row of rows) {
          if (!bankWanted.get(row.material_id)) continue;
          const mat = mixMats.get(row.material_id);
          const rowParent = rowParentFor(row.role, mat);
          // row.ups is the planner's CHOSEN cuts (validated against this same
          // rowParent above, so cuts and strips can never disagree about the
          // parent). At the board's own max chosenStrips resolves to
          // leftoverStrips; below it, the sub-max layout's strips.
          const strips = chosenStrips(rowParent, eff, row.ups);
          if (!strips.length) throw Object.assign(
            new Error(`No strip left to bank on ${mat.name}`), { status: 409 });
          const usable = strips.filter(s => s.usable);
          if (!usable.length) {
            const best = [...strips].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
            throw Object.assign(
              new Error(`Strip ${best.l}×${best.w}" is under 3" — waste, not stock`), { status: 409 });
          }
          // Two clean rectangles can both be bankable; the payload carries no
          // strip choice, so the largest (most board saved) wins.
          const pick = [...usable].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
          v2Rows.push({
            material_id: row.material_id,
            cuts: row.ups,
            strip: { l: pick.l, w: pick.w },
            strips_per_parent: pick.strips_per_parent || 1,
            est_sheets: row.sheets,
          });
        }
        if (v2Rows.length) {
          v2Plan = { version: 2, rows: v2Rows,
                     decided_by: req.user.name, decided_at: new Date().toISOString() };
          await qc('UPDATE order_lines SET leftover_plan=$1 WHERE id=$2',
            [JSON.stringify(v2Plan), line.id]);
        }

        // CAPPED, NEVER REFUSED — the same rule the no-mix freeze below applies.
        // The mix is written whole; only its HOLDS are limited to free stock,
        // and whatever could not be held is reported back for the planner to
        // read. Refusing here made Lock Plan die silently the moment a raised
        // wastage outgrew the shelf.
        const { caps: mixCaps, shortfalls } = await boardHoldCaps(rows, [line.id], qc);
        boardShortfalls.push(...shortfalls);
        await replaceMixPlan(line.id, rows, qc, req.user.name, mixCaps);
        await audit('order_line', line.id, 'board_mix',
          rows.map(r => `${r.sheets} of material ${r.material_id}`).join('; ').slice(0, 500),
          qc, req.user.name);
      } else if (!draft || Array.isArray(req.body.mix)) {
        // No mix sent, or an empty one. Either way the stored plan rows are now
        // invalid — see clearMixPlan's comment on frozen `ups` and `covers`.
        //
        // A DRAFT is the one caller allowed to say nothing about the mix. It
        // OMITS the key when the mix on screen does not balance yet, and the
        // stored rows are then left exactly as they are — clearing them would
        // mean "save my work" threw away the half-built mix the planner is
        // working on, which is the one thing that button exists to prevent. An
        // empty ARRAY is still a deliberate clear, from a draft as from a lock.
        await clearMixPlan(line.id, qc, req.user.name,
          draft ? 'draft saved without a mix' : 'plan re-locked without a mix');
      }

      // Gang printing guard: a gang shares ONE board. If this plan moved the
      // line onto a different board than its gang mates, it leaves the gang
      // (and a gang left with a single job dissolves). Simple and predictable.
      if (line.gang_run_id) {
        const mate = await oc(`
          SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_id
          FROM order_lines ol JOIN products p ON p.id=ol.product_id
          WHERE ol.gang_run_id=$1 AND ol.id != $2 LIMIT 1`, [line.gang_run_id, line.id]);
        if (mate && +mate.board_id !== +eff.board_material_id) {
          await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE id=$1", [line.id]);
          await audit('gang_run', line.gang_run_id, 'remove_line',
            `line ${line.id} left the gang — board changed to ${board?.name}`, qc, req.user.name);
          const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
          if (left.n < 2) {
            await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE gang_run_id=$1", [line.gang_run_id]);
            // A dissolving MERGE run takes its run-level leftover bank with it
            // — the deleted row leaves no re-lock to reconcile LO-PLAN-RUN
            // batches. No-op for gang-kind runs and unbanked merges.
            await unbankRunLeftover(line.gang_run_id, qc, oc, req.user.name, 'run dissolved — board changed');
            await qc('DELETE FROM gang_runs WHERE id=$1', [line.gang_run_id]);
            await audit('gang_run', line.gang_run_id, 'dissolve', 'fewer than 2 jobs left', qc, req.user.name);
          }
        }
      }

      // Bank (or clear) the board offcut in the warehouse the moment the cut is
      // locked — Phase 1 spec. Ganged lines are skipped (their leftover carries
      // product-specific traceability only after the die-cut split), matching
      // the cutting-complete carve-out. Cutting-complete trues this up to the
      // actual parents cut and flips it from "planned" to "confirmed".
      const stillGang = (await oc('SELECT gang_run_id FROM order_lines WHERE id=$1', [line.id]))?.gang_run_id;
      if (wantsMix) {
        // v2: one batch per banked mix row. Zero first whatever this save no
        // longer names — the legacy unsuffixed batch and any per-row batch
        // whose row dropped out or toggled off — then bank each named row;
        // bankPlanningLeftover's own reconciliation trues up the survivors
        // (qty delta on the same strip, full reverse + re-book on a strip
        // change). A mix save is never ganged: the mix block 409s gang lines
        // before reaching here, so no stillGang guard on this branch.
        //
        // plannedQty is in STRIPS: strips_per_parent × that row's parent
        // sheets — the same formula cutting-complete confirms with
        // strips_per_parent × actualParents, so the true-up delta is purely
        // the parents difference (mirrors the legacy call two branches down).
        const keep = (v2Plan?.rows || []).map(r => `LO-PLAN-${line.id}-${r.material_id}`);
        await unbankPlanningLeftover(line.id, qc, oc, req.user.name,
          v2Plan ? 'mix leftover rows changed' : 'plan changed', keep);
        for (const r of v2Plan?.rows || []) {
          await bankPlanningLeftover(line, mixMats.get(r.material_id), r.strip,
            r.strips_per_parent || 1,
            (r.strips_per_parent || 1) * r.est_sheets, qc, oc, req.user.name,
            `LO-PLAN-${line.id}-${r.material_id}`);
        }
      } else if (finalLeftover?.push && finalLeftover.strip && !stillGang) {
        // A line coming OFF a mix may still hold per-row (suffixed) batches
        // from a v2 lock; the legacy bank below reconciles only its own
        // unsuffixed one. keep makes this a no-op on a never-mixed line —
        // nothing matches after the filter, so no movement and no audit.
        await unbankPlanningLeftover(line.id, qc, oc, req.user.name,
          'mix leftover rows dropped', [`LO-PLAN-${line.id}`]);
        await bankPlanningLeftover(line, board, finalLeftover.strip,
          finalLeftover.strips_per_parent || 1,
          (finalLeftover.strips_per_parent || 1) * parentSheets, qc, oc, req.user.name);
      } else {
        await unbankPlanningLeftover(line.id, qc, oc, req.user.name, 'plan changed');
      }

      // ── FREEZE THE BOARD THIS PLAN NEEDS ────────────────────────────────
      //
      // Until now, locking a plan reserved nothing. "Committed" on the
      // warehouse screen was derived demand, not a claim, so whichever job
      // reached cutting first ate the pile and the job that was planned first
      // failed later, far from the cause. This is the claim.
      //
      // RELEASE FIRST, ALWAYS — unconditional and unbranched. Four hazards
      // collapse into that one rule: a re-lock that CHANGES the board
      // (commitBoardForLine is per-material and would strand the old board's
      // row forever), a re-lock that SHRINKS the requirement (it returns early
      // on `want - alreadyHeld <= 0` and never releases the surplus), a save
      // that ADOPTS a mix (the mix writes its own per-row holds and Phase 1
      // deliberately stopped ABSORB from touching a freeze, so the two would
      // stack), and plain idempotence. The released sheets return to `free`
      // inside this same transaction, so the re-commit below is not starving
      // itself.
      await releasePlanLockHolds(line.id, qc, req.user.name, 'plan re-locked');

      // Two exclusions, each for its own reason:
      //   (draft is NOT excluded.) A saved draft freezes exactly as a lock
      //   does. It was excluded in Phase 2a only until Discard existed on every
      //   screen that can create one — POST /gang-runs/:id/plan/discard closed
      //   that, so a draft's board can always be handed back. The route's own
      //   header has said the same thing for longer: "the one thing a draft
      //   DOES commit is board". This makes the engine agree with it.
      //   stillGang— a run plans its board as one pile; per-member freezing is
      //              Phase 2b and needs the cap struck at run level. Use
      //              `stillGang`, NOT line.gang_run_id: the gang guard above
      //              can null it mid-handler.
      //   wantsMix — replaceMixPlan already wrote one hold per mix row. A
      //              second claim here would double-hold the same sheets.
      if (!stillGang && !wantsMix && eff.board_material_id && parentSheets > 0) {
        // CAPPED, NEVER REFUSED. This whole handler is one transaction: a
        // COMMIT_EXCEEDS_FREE thrown here would roll back the qty edit, the
        // master update, the spec override, the mix and the banking — a short
        // shelf would start killing plans the planner already decided on.
        // Physics hard, paperwork soft. The uncovered remainder is not lost:
        // it is exactly what the warehouse's Shortfall column reports.
        const [avail, allLines, allocs] = await commitInputs(eff.board_material_id, qc);
        const { free } = boardPosition({
          available: avail, allocations: allocs, lines: allLines,
          materialId: eff.board_material_id,
        });
        const held = heldFor(allocs, line.id, eff.board_material_id);
        const want = Math.min(parentSheets, held + Math.max(0, free));
        if (want > 0) {
          await commitBoardForLine({
            materialId: eff.board_material_id,
            lineId: line.id,
            want,
            reason: `Frozen by the planning engine for ${eff.name || `line #${line.id}`}`,
            origin: 'plan_lock',
            user: req.user.name,
          }, qc);
        }
      }

      if (line.status === 'pending' && !draft) {
        await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
        // Artwork can lock against a saved draft. If it got here first,
        // re-run readiness after planning so both work orders converge.
        const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
        const gate = await readiness(fresh, oc);
        if (gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
          await setLineStatus(fresh.id, 'ready', qc, oc, req.user.name);
        }
      }
      // The leftover fragment names the plan that was actually stored: the v2
      // rows on a mix save, the legacy single strip otherwise (storedLeftover
      // === finalLeftover on every no-mix save, so that path reads as before).
      const loNote = v2Plan
        ? `, leftover ${v2Plan.rows.map(x => `${x.strip.l}×${x.strip.w}"`).join(' + ')} → warehouse`
        : storedLeftover?.push ? `, leftover ${storedLeftover.strip.l}×${storedLeftover.strip.w}" → warehouse` : '';
      await audit('order_line', line.id, draft ? 'plan_draft' : 'planned',
        `${sheets} child → ${parentSheets} parent (${fit.count}/parent, ${eff.ups} ups, `
        + `${wastage != null ? `${wastage} wastage sheets` : `${eff.wastage_pct}% wastage`}`
        + `${changed.board_material_id ? `, board → ${board?.name}` : ''}`
        + loNote + ')', qc, req.user.name);
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out), board_shortfalls: boardShortfalls });
  } catch (e) { next(e); }
});

// Discard a SAVED-but-unlocked plan — the exact inverse of the engine's Save.
//
// Save (`draft: true` above) writes every figure a lock writes and deliberately
// leaves the line in To Plan. Nothing downstream reads a draft — except board.
// replaceMixPlan mirrors every mix row into board_allocations, and it ABSORBS
// any hand-placed hold the line already carried on those boards, so a saved
// draft sits on real committed stock with no screen left that can give it back:
// the Board Mix panel renders only inside the engine, and the line never reached
// 'planned', so workflow.js's reverse_plan refuses it outright. That stranded
// hold is what this route releases.
//
// It is NOT reverse_plan. That walks a LOCKED line back off 'planned', deletes
// its job card, dissolves its gang and resets artwork approvals — a draft has
// none of those to undo. Two routes, two guards, so neither is reachable from
// the other's state and each refusal can name the right button.
//
// canPlanWork, not canPlan: the client offers this behind canPlan(auth.user),
// which is PLANNING_ROLES — the very list canPlanWork resolves. Narrowing the
// server to 'planner' alone would show a production login a button that can only
// ever answer with a role error (gang-role-parity.test.js exists for that drift).
r.post('/order-lines/:id/plan/discard', canPlanWork, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      // FOR UPDATE before the guard reads the row, not after: the guard's whole
      // claim is "this line is still an unlocked draft", and a Lock Plan landing
      // on the same line concurrently would otherwise be read here as 'pending'
      // and then commit 'planned' underneath us — releasing the board a live
      // plan had just claimed.
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });

      // The saved-draft test is the SAME pair LINE_VIEW's `plan_draft` column
      // computes (status='pending' AND parent_sheets_required IS NOT NULL), so
      // the badge the planner clicked and the route that answers it can never
      // disagree about what a saved plan is. Each half refuses in its own words:
      // the two failures are different mistakes with different next actions, and
      // one shared "cannot discard" would leave the planner guessing which.
      if (line.status !== 'pending') {
        throw Object.assign(
          new Error(`This plan is locked — ${line.status.replace(/_/g, ' ')} work has no saved draft to discard. `
            + 'Use Reverse Plan to un-lock it back to To Plan instead.'),
          { status: 409, body: { code: 'PLAN_NOT_DRAFT', at: { stage: null, status: line.status } } });
      }
      if (line.parent_sheets_required == null) {
        throw Object.assign(
          new Error('Nothing has been saved on this job yet — there is no plan to discard.'),
          { status: 409, body: { code: 'PLAN_NEVER_SAVED' } });
      }

      // A gang shares ONE board across several jobs and plans it as one pile —
      // the run owns the plan, not the member. Same wording as the mix guard in
      // plan-save, so the floor hears one story about gangs and boards.
      //
      // The run now has its own Discard (gangs.js's /gang-runs/:id/plan/discard),
      // so this names it rather than sending the planner off to break the run up:
      // leaving the gang was never what they wanted, it was the only door that
      // existed. Refusing HERE is still right — releasing one member's share of a
      // pile the other members are still counting on would strand the rest.
      if (line.gang_run_id) {
        const p = await oc('SELECT name FROM products WHERE id=$1', [line.product_id]);
        const g = await oc('SELECT gang_number FROM gang_runs WHERE id=$1', [line.gang_run_id]);
        throw Object.assign(
          new Error(`${p?.name || 'This job'} prints in ${g?.gang_number || 'a run'} — the run plans its board as `
            + 'one pile, so there is no single job\'s plan to discard. Open the run and discard its plan there '
            + 'to release the board for every member at once.'),
          { status: 409, body: { code: 'PLAN_DISCARD_GANGED', gang_run_id: line.gang_run_id } });
      }

      // Read what is about to go before it goes, so the response and the audit
      // trail can NAME the board that came back rather than reporting a count.
      // "Released 2,400 sheets of Saffire 340" is checkable against the
      // warehouse; "plan discarded" is not.
      const mix = await mixFor(line.id, 'plan', qc);
      const released = mix.map(m => ({
        material_id: m.material_id,
        board_name: m.board_name,
        sheets: Number(m.sheets) || 0,
      }));
      const totalSheets = released.reduce((s, m) => s + m.sheets, 0);
      // Was there actually a planned offcut on the shelf? unbankPlanningLeftover
      // is a silent no-op when there is not, and the response has to tell the
      // planner which of the two happened. qty > 0 (not initial_qty) is the live
      // test: a bank another job has already drawn down to nothing, or one a
      // previous sweep zeroed, is not stock this discard is handing back.
      const banked = await oc(
        `SELECT COUNT(*)::int AS n FROM stock_batches
          WHERE (batch_no = $1 OR batch_no LIKE $2) AND qty > 0`,
        [`LO-PLAN-${line.id}`, `LO-PLAN-${line.id}-%`]);
      const leftoverUnbanked = banked.n > 0;

      const why = 'saved plan discarded — board released';
      // clearMixPlan releases the mirrored board_allocations holds and deletes
      // the phase='plan' rows; unbankPlanningLeftover sweeps the LO-PLAN-<line>
      // (and LO-PLAN-<line>-<mat>) batches the save banked against a cut that is
      // no longer going to happen.
      await clearMixPlan(line.id, qc, req.user.name, why);
      await releasePlanLockHolds(line.id, qc, req.user.name, 'draft plan discarded');
      await unbankPlanningLeftover(line.id, qc, oc, req.user.name, why);
      // sheets_required goes with parent_sheets_required, never without it.
      // board-allocation.js reads a line's requirement as
      // `parent_sheets_required ?? sheets_required` — nulling only the parent
      // would leave every board-position reader quoting the CHILD print count
      // as a parent-sheet demand, which is strictly larger than the plan this
      // route just deleted. They are one derived pair from one cut plan
      // (reverse_plan clears them together for the same reason).
      //
      // What deliberately SURVIVES: spec_override, wastage_sheets, notes,
      // machine_id and planned_date. Those are not commitments — they are the
      // spec the planner decided and the remarks and scheduling they typed.
      // "Unsave" is about reversing what the save COMMITTED (board), and a
      // planner who discards a cut plan to redo it wants the engine to reopen
      // pre-filled with the spec work, not blank. Nothing downstream can act on
      // them while the line sits in To Plan, so keeping them costs nothing and
      // throwing them away would destroy work the owner never asked to lose.
      await qc(
        `UPDATE order_lines
            SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL
          WHERE id=$1`, [line.id]);

      // Nulling parent_sheets_required is what flips LINE_VIEW's plan_draft
      // false, so the blue "Saved · lock pending" badge and its filter chip
      // clear themselves off the ONE rule — nothing else to keep in step.
      await audit('order_line', line.id, 'plan_discarded',
        (released.length
          ? `Saved plan discarded — released ${totalSheets} sheets: `
            + released.map(m => `${m.sheets} of ${m.board_name || `material ${m.material_id}`}`).join('; ')
          : 'Saved plan discarded — no board was held')
          + (leftoverUnbanked ? ' · planned leftover taken back off the shelf' : '')
          + ' · spec, remarks and press kept',
        qc, req.user.name);
      // Per-board line so the material's own timeline shows the release, in the
      // same shape board.js's hold audits use — the warehouse reads that trail
      // by board, not by order line.
      for (const m of released) {
        await audit('materials', m.material_id, 'board_hold_released',
          `${m.sheets} sheets released from order line #${line.id} — ${why}`, qc, req.user.name);
      }

      return { released, total_sheets: totalSheets, leftover_unbanked: leftoverUnbanked };
    });
    res.json(out);
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
        COALESCE(SUM(CASE WHEN status='quarantine' THEN qty END),0) AS quarantine,
        -- Open write-ons against this board — same correlated subquery as
        -- /inventory/stock. The book was forced to nil because more left the
        -- warehouse than it said existed, and no storekeeper has physically
        -- recounted it yet. Distinct from a balance that reads zero because
        -- it was simply consumed clean.
        COALESCE((SELECT SUM(qty) FROM stock_writeons
                  WHERE material_id=$1 AND reconciled_at IS NULL), 0) AS open_writeon_qty
      FROM stock_batches WHERE material_id=$1`, [matId]);

    // `otherLines` excludes this line, exactly as the committed query it
    // replaces did. The line being planned is usually still 'pending' at this
    // point, so it must NOT be looked up inside a status-filtered set — it is
    // passed explicitly as `line`, taken from LINE_VIEW, which carries no
    // status filter.
    const [allocations, otherLines] = await Promise.all([
      q(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active'`, [matId]),
      boardClaimLines([matId], [line.id]),
    ]);
    // A job whose board cutting has already ISSUED has no open board need left:
    // its sheets came out of `available` at the draw and are on the floor. Without
    // this the engine bills the same sheets twice — it read the 500 left after
    // CI-JC-0035 took its 600, subtracted the 600 again, and reported "short 100"
    // on a job that was already cut AND printed, offering to buy board the plant
    // was standing on. `others` now reaches into in_production, where drawn lines
    // actually live, so boardClaimLines flags every one of them; the draw — not
    // the status — is what closes a job's claim. Only the line being planned is
    // resolved here, because it is not in that set.
    const drawn = await boardDrawnLineIds([line.id]);
    const position = linePosition({
      line: { ...line, board_drawn: drawn.has(line.id) },
      others: otherLines,
      available: Number(stock.available), allocations, materialId: matId,
    });
    // Who the committed sheets belong to — the same list, from the same
    // arithmetic, that Smart Match quotes for every rival board. Board Position
    // and Smart Match are read side by side on one screen, so a planner who
    // switches to a suggested board must find the identical story waiting.
    position.claimants = claimsByBoard({ lines: otherLines, allocations }).get(matId)?.claimants || [];

    // The job's board mix, plus every same-grade board that could join it.
    //
    // Anchored to the line's OWN actual board — line.board_material_id/
    // board_name/sheet_l/sheet_w — never to matId/board above. Those two track
    // whichever board `?board_material_id=` is previewing for the single-board
    // swap this endpoint already supported before the mix existed. The mix's
    // idea of "planned" has to stay fixed to what is actually saved — it is
    // what job_board_mix.role='planned' rows already point at on disk — or a
    // preview request would make the candidate list and the stock block below
    // disagree about which board this job is even planned on.
    const mix = await mixFor(line.id, 'plan', q);
    // How much each board the SAVED mix names is actually holding.
    //
    // The candidate query below cannot answer this: it returns only boards that
    // still HAVE stock (`COALESCE(av.q,0) > 0`), so the one row a planner most
    // needs flagged — a mix row whose board has since been emptied — is exactly
    // the row it omits. Live line 128 is the case: 700 sheets written against a
    // board whose three batches are all exhausted, under a green 'Fully covered
    // ✓', because the panel had never been given anything to check against.
    //
    // Raw shelf stock, deliberately, matching the single-line release gate in
    // readiness() (`availableQty`) rather than the list view's claimable — holds
    // do not reduce stock_batches, so this is the same number the gate reads.
    const mixAvail = mix.length ? await q(
      `SELECT m.id, COALESCE(av.q, 0)::float AS available
         FROM materials m
         LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                    WHERE status='available' GROUP BY material_id) av ON av.material_id = m.id
        WHERE m.id = ANY($1)`, [[...new Set(mix.map(r => r.material_id))]]) : [];
    const mixAvailById = new Map(mixAvail.map(r => [r.id, Number(r.available)]));
    for (const r of mix) r.available = mixAvailById.get(r.material_id) ?? 0;
    // …and FREE, on the same rule the "+ Add board" candidates and the gang's
    // saved rows are costed with (claimsByBoard + stockHoldBudget, this line
    // excluded). Without it a reopened row carried only the raw shelf, the
    // client seeded that into the over-allocation check, and one board told
    // two stories on one screen — the row read gross while the candidate list
    // beside it read net. r.available stays the raw shelf: the emptiness
    // check ("no stock behind these sheets") is a physical question.
    if (mix.length) {
      const mixIds = [...new Set(mix.map(r => r.material_id))];
      const [mixClaimLines, mixAllocs] = await Promise.all([
        boardClaimLines(mixIds, [line.id]),
        q(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [mixIds]),
      ]);
      const mixClaims = claimsByBoard({ lines: mixClaimLines, allocations: mixAllocs });
      for (const r of mix) {
        const budget = stockHoldBudget({
          materialId: r.material_id, available: Number(r.available || 0),
          allocations: mixAllocs, claimLines: mixClaimLines, ownerLineIds: [line.id],
        });
        r.committed = Math.round(mixClaims.get(r.material_id)?.committed || 0);
        r.held = Math.round(budget.held);
        r.free = Math.round(budget.free);
      }
    }

    const plannedBoardRow = {
      id: line.board_material_id, name: line.board_name,
      sheet_l: line.sheet_l, sheet_w: line.sheet_w,
    };
    // Mirrors plan-save's `parent = effectiveParent(eff, board); fit =
    // childFit(parent, eff)` exactly, so the two never quote a different ups for
    // the same saved plan — line.sheet_l/child_l already fold spec_override the
    // same way eff does, this just makes that mirroring explicit rather than
    // relying on the reader to know LINE_VIEW already applied it. plannedParent
    // is kept whole (not inlined) because the mix block below hands its dims to
    // the client — the strip preview for the PLANNED row must run the same
    // geometry chosenStrips is given at save.
    const plannedParent = effectiveParent(line, plannedBoardRow);
    const plannedFit = childFit(
      plannedParent, { child_l: line.child_l, child_w: line.child_w });
    const plannedUps = plannedFit.count;
    const plannedBoard = { id: line.board_material_id, name: line.board_name };
    // Grade has no reliable SQL column to filter on for this purpose — a
    // materials.grade column exists, but substitutionFlags (the function that
    // will actually gate the save) reads the board NAME via parseBoardName,
    // never that column, and nothing keeps the two in sync. Filtering here by
    // materials.grade could admit or silently drop a candidate that plan-save
    // would decide differently, so every stocked board is fetched — at ~80
    // rows on live data this is negligible — and substitutionFlags is the one
    // and only grade authority, in both places it is asked.
    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available
      FROM materials m
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND COALESCE(av.q,0) > 0 AND m.id != $1`, [line.board_material_id]);
    const mixCandidates = candidates.map(c => {
      // Own native sheet size, NOT effectiveParent(eff, c) — see the identical
      // choice and its reasoning in the plan-save mix block below.
      //
      // The whole fit, not just its count: waste_pct is what orders this list
      // now, and it is the same number Smart Match already shows beside every
      // board it offers.
      const fit = childFit(c, { child_l: line.child_l, child_w: line.child_w });
      const flags = substitutionFlags({
        plannedBoard, candidateBoard: c, plannedUps, candidateUps: fit.count });
      // max_cuts is this board's own natural ceiling — the same fit.count the
      // row's `ups` defaults to today. Named separately so `ups` can become
      // the CHOSEN value (editable cuts) without the client losing the cap it
      // clamps against. sheet_l/sheet_w already ride along via m.* for the
      // client-side strip preview.
      return { ...c, ups: fit.count, max_cuts: fit.count, waste_pct: fit.waste_pct, utilization: fit.utilization, ...flags };
    }).filter(c => c.ok).sort((a, b) => {
      // LEAST TRIM FIRST. This list used to be ordered by |gsm_delta| — nearest
      // GSM — which answers a different question: how close the substitute is
      // to spec, not how much board it throws away. Grade is already fixed and
      // GSM is the plant's own call, so the board that wastes least is the one
      // worth suggesting, and it is what "+ Add board" and Planning's "Cover
      // with another board" now default to.
      //
      // GSM closeness survives as the tie-break, so two boards that trim the
      // same still offer the nearer one first. waste_pct is null only for an
      // unsized board, which cannot reach here (candidates require sheet
      // dimensions and substitutionFlags blocks a zero fit) — the guard keeps
      // such a row last rather than sorting NaN.
      const wa = a.waste_pct ?? Infinity;
      const wb = b.waste_pct ?? Infinity;
      if (wa !== wb) return wa - wb;
      return Math.abs(a.gsm_delta) - Math.abs(b.gsm_delta);
    });

    // WHAT THIS JOB MAY ACTUALLY TAKE of each candidate.
    //
    // `available` off the query above is the gross shelf. The mix panel printed
    // it as "N free" and the seeds sized themselves against it, so a board
    // holding 2,000 sheets of which 1,100 were already committed to another
    // product offered all 2,000 — the planner was invited to spend board a job
    // in production is owed. Reported from the floor on FBB · 320 GSM · 23x26.5.
    //
    // Same costing the Smart Match endpoint below already does, and the same
    // rule Board Position states for the planned board: claims first, then what
    // is left. THIS line is excluded from the demand side, so a board it
    // already holds does not read as committed against itself — `free` is
    // "yours to take", which is what both the label and the over-stock warning
    // need to mean.
    {
      const candIds = mixCandidates.map(c => c.id);
      if (candIds.length) {
        const [candLines, candAllocs] = await Promise.all([
          boardClaimLines(candIds, [line.id]),
          q(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [candIds]),
        ]);
        const candClaims = claimsByBoard({ lines: candLines, allocations: candAllocs });
        for (const c of mixCandidates) {
          const claim = candClaims.get(c.id);
          c.committed = Math.round(claim?.committed || 0);
          // free comes from the SAVE path's own arithmetic (stockHoldBudget),
          // not a hand-rolled available − committed. The difference is
          // heldOutsideClaims: a pending draft's freeze reserves the shelf but
          // its line is in no claim set, so the hand-rolled figure quoted more
          // than the save would allow and the hold silently capped at lock.
          const budget = stockHoldBudget({
            materialId: c.id, available: Number(c.available || 0),
            allocations: candAllocs, claimLines: candLines, ownerLineIds: [line.id],
          });
          c.held = Math.round(budget.held);
          c.free = Math.round(budget.free);
          c.claimants = claim?.claimants || [];
        }
      }
    }

    // loose_sheets rides along so the packet advice can prefer a COUNTED loose
    // figure over the remainder derivation — packetPlan reads it per lot and
    // falls back where it is NULL. Without it every pile reads as derived and
    // the panel keeps guessing k = 0.
    const lots = await q(`
      SELECT id, material_id, batch_no, qty, loose_sheets FROM stock_batches
      WHERE material_id = ANY($1) AND status='available' AND qty > 0
      ORDER BY created_at, id`,
      [[line.board_material_id, ...mixCandidates.map(c => c.id)]]);

    // Spec touch point 2. `position` above is the single-board answer, which is
    // right for every job without a mix. A mixed line's claim on ANY board is
    // exactly the sheets written against it, and only the PLANNED board carries
    // the unmet remainder. Without this, previewing the 290 GSM board on a job
    // planned at 300 shows its whole 4,000-sheet requirement pressing on 290
    // GSM stock, on top of whatever the mix already committed there.
    //
    // materialId stays `matId` (the board this request is actually asking
    // about, preview or not) — only plannedBoardId is pinned to the line's real
    // board, because that has to agree with the role='planned' rows on disk.
    const mixPos = mixPosition({
      line, rows: mix, materialId: matId, plannedBoardId: line.board_material_id });
    // held_for_me STAYS on the board_allocations ledger. mixPos.held is
    // job_board_mix PLAN sheets — a different ledger, and replaceMixPlan caps
    // the real hold below the row's sheets when free stock runs out ("a row
    // capped to nothing writes no hold at all"). Subtracting plan-sheets from
    // an allocations total handed the client held/held_for_me from two books,
    // and heldOthers went negative-or-wrong the moment a mix was capped.
    const shown = mixPos
      ? { ...position,
          mix_held: mixPos.held,
          my_open_need: mixPos.open_need,
          net: position.free - mixPos.open_need - position.others_open_need,
          short: Math.max(0, -(position.free - mixPos.open_need - position.others_open_need)) }
      : position;
    // A fresh_pr plan refuses the shelf: nothing of it presses on free stock
    // (net is simply what the other jobs leave), and its still-to-buy is the
    // FULL requirement less its own PR on order and the stock already HELD for
    // it (a landed, covered PR becomes a hold — without netting it the panel
    // demands the full quantity again on a job whose board is in the racks).
    // A mixed plan books shelf boards by definition, so the mix override wins.
    const stockShown = line.stock_booking === 'fresh_pr' && !mixPos
      ? { ...shown,
          my_open_need: 0,
          net: position.free - position.others_open_need,
          short: drawn.has(line.id) ? 0
            : Math.max(0, position.need - position.held_for_me - position.incoming_for_me) }
      : shown;

    // Every open PR on this board, with the product and run it was raised FOR
    // — the duplicate alarm blocks only on this line's own product (or its own
    // run); the rest render as informational "already under PR" chips.
    const openPrs = await q(`
      SELECT pr.id, pr.pr_number, pr.qty, pr.status, pr.needed_by, pr.order_line_id,
             olr.product_id, pp.name AS product_name, pp.code AS product_code,
             pp.party_artwork_code, pp.party_item_code,
             olr.gang_run_id, gr.gang_number
      FROM requisitions pr
      LEFT JOIN order_lines olr ON olr.id = pr.order_line_id
      LEFT JOIN products pp ON pp.id = olr.product_id
      LEFT JOIN gang_runs gr ON gr.id = olr.gang_run_id
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
      JOIN products fp ON fp.id = fl.product_id
      JOIN products p ON p.id = $1
      LEFT JOIN job_cards jc ON jc.id=fl.job_card_id
      LEFT JOIN order_lines sol ON sol.id=fl.order_line_id
      LEFT JOIN orders o ON o.id=sol.order_id
      WHERE fl.status IN ('pending_verification','verified')
        AND (fl.qty - fl.consumed_qty) > 0 AND ${fgMatchPredicate()}
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
    //
    // Measured on effectiveParent, NOT on the board's raw mother sheet: a
    // product carrying a finalised parent_l/parent_w is cut from that trim, and
    // the trim moves the strip. 20×24.5 out of a 20×38 board leaves a bankable
    // 20×13.5"; trimmed to 20×26 the same cut leaves 20×1.5", which is waste.
    // plan-save validates the planner's pick with leftoverStrips(effectiveParent
    // (eff, board), eff) and 409s a strip that does not match, so quoting the
    // raw sheet here offered a strip that could not be banked — and, when it
    // did match a different real strip, banked an offcut the plant never cut.
    // Same folding as plannedUps above: line.parent_l/child_l already carry
    // spec_override, exactly as `eff` does on the save path.
    const stripParent = effectiveParent(line, { sheet_l: board?.sheet_l, sheet_w: board?.sheet_w });
    const stripChild = { child_l: line.child_l, child_w: line.child_w };
    const strips = leftoverStrips(stripParent, stripChild);
    // Strips this plan yields = one per parent sheet cut. parent_sheets_required
    // is NULL until a plan is locked, so an unplanned job quoted "≈ 0 sheets"
    // against a cut that will really bank hundreds; fall back to the same
    // sheets → parent arithmetic the lock itself will run.
    const estParents = line.parent_sheets_required
      || parentSheetsRequired(
           sheetsRequired(line, netProduceQty(line), line.wastage_sheets),
           childFit(stripParent, stripChild).count);
    const leftover = strips.length ? {
      strips: strips.map(s => ({ ...s, est_sheets: (s.strips_per_parent || 1) * estParents })),
      saved: line.leftover_plan || null,
    } : null;

    // Shade-card expiry check — the planner sees a critical alert the moment a
    // stale (365-day+) shade card would be used on this product.
    const shadeCards = await shadeCardsFor([line.product_id]);

    res.json({
      line,
      board,
      gang,
      leftover,
      shade_card: shadeCards[line.product_id] || null,
      // Cutting has already issued this job's board — the sheets are on the
      // floor. The client recomputes its own net/short from the live cut-plan
      // form rather than reading stock.short, so it needs the same fact the
      // server's openNeed() now uses, or the two twins disagree on screen.
      board_drawn: drawn.has(line.id),
      // committed_other is kept for the existing client math; held/free/short
      // are the allocation-aware view. With no allocations, or no mix, `shown`
      // is `position` itself (mixPosition returned null) so this reads exactly
      // as it always did.
      stock: {
        ...stock,
        committed_other: stockShown.others_open_need,
        held: stockShown.held,
        held_for_me: stockShown.held_for_me,
        incoming_for_me: stockShown.incoming_for_me,
        free: stockShown.free,
        net: stockShown.net,
        short: stockShown.short,
        // The named jobs behind committed_other. A number alone was read as
        // "some stock is spoken for, somewhere"; the planner's actual question
        // is which job, so that taking it from them can be a decision.
        claimants: position.claimants,
      },
      mix: {
        rows: mix,
        planned_ups: plannedUps,
        // So the planned board's own row can quote its trim in the same units
        // the substitutes now do — a list where one option has no waste figure
        // reads as a gap, not as "this one is the plan".
        planned_waste_pct: plannedFit.waste_pct,
        planned_board_id: line.board_material_id,
        // The exact parent the planned fit was measured on — effectiveParent
        // folds a finalised parent_l/parent_w trim over the board's mother
        // sheet, and the trim moves the strip (see the leftover block below).
        // Null when the line has no board and no trim: nothing to cut from.
        planned_parent_l: plannedParent.sheet_l ?? null,
        planned_parent_w: plannedParent.sheet_w ?? null,
        candidates: mixCandidates,
        lots,
        ...mixBalance({ required: lineRequirement(line), rows: mix }),
      },
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

    // Every board that could physically do the job, with its stock.
    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available,
             COALESCE(src.name, m.name) AS match_name, COALESCE(src.spec, m.spec) AS match_spec
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND (COALESCE(av.q,0) > 0 OR m.id = $1)`,
      [anchorId]);

    // …and WHO is already waiting on each of them. Board sitting in the
    // warehouse is not the same as board a planner may take, so every suggestion
    // is costed against the live claims on it (BOARD_DEMAND_STATUSES) rather
    // than presented as free stock. The claimants ride along so the row can name
    // the job standing in the way instead of just quoting a smaller number —
    // whether to take board off that job is a planner's call, not the engine's.
    const boardIds = candidates.map(c => c.id);
    const [claimLines, allocations] = await Promise.all([
      boardClaimLines(boardIds, [line.id]),
      boardIds.length
        ? q(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [boardIds])
        : [],
    ]);
    const claims = claimsByBoard({ lines: claimLines, allocations });
    for (const c of candidates) {
      const claim = claims.get(c.id);
      c.committed = claim?.committed || 0;
      // Holds owned by lines outside the claim set (a pending draft's freeze)
      // reserve the shelf too — stockHoldBudget's heldOutsideClaims, the same
      // figure the save path subtracts. smartmatch.js nets it off `free` so a
      // suggestion never quotes board the lock would immediately cap away.
      c.held = stockHoldBudget({
        materialId: c.id, available: Number(c.available || 0),
        allocations, claimLines, ownerLineIds: [line.id],
      }).held;
      c.claimants = claim?.claimants || [];
    }

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
    // Include lines still in artwork (planned/ready) plus those already pushed
    // to a job card (in_production) — the latter power the "Completed" tab, from
    // where tooling can still be fanned into the hub.
    //
    // ── SAVED DRAFTS COME HERE TOO ──────────────────────────────────────────
    // The designer's work depends on the SPEC — child size, ups, colours, die,
    // artwork code, shade card — and every one of those is written by the plan
    // SAVE. Board coverage is a separate, slower question. Waiting for the plan
    // to be locked before the designer may start makes artwork wait on stock
    // that nobody needs yet, which is precisely backwards while a gang is being
    // assembled: the setup is settled long before the board is.
    //
    // So the gate is "the plan is SAVED", not "the plan is locked". The second
    // clause is LINE_VIEW's `plan_draft` rule spelled out (pending AND already
    // carrying a written parent requirement) — the same one pair the badge, the
    // filter chip and both discard routes are written against.
    //
    // This is safe in the one direction that matters: createJobCardForLine
    // refuses any status outside planned/ready, so a draft can be designed and
    // its artwork locked, but it can NEVER reach the floor without the plan
    // being locked first. Nothing else moves either — 'pending' is below
    // BOARD_DEMAND_STATUSES, so a job sitting in the artwork queue on a draft
    // still claims no board, which is the whole point of letting it in early.
    //
    // artwork_locked earns its own clause: a plan can be discarded after the
    // designer has finished, and `parent_sheets_required` going NULL would then
    // yank completed work out of the Locked tab. Finished artwork stays visible.
    const rows = await q(`${LINE_VIEW}
      WHERE ol.status IN ('planned','ready','in_production')
         OR (ol.status = 'pending'
             AND (ol.parent_sheets_required IS NOT NULL OR ol.artwork_locked = 1))
      ORDER BY ol.artwork_locked, o.delivery_date NULLS LAST`);
    // Tooling chips: ONE query for every product on the page.
    const pids = [...new Set(rows.map(l => l.product_id))];
    const tools = pids.length ? await q(`
      SELECT * FROM tools
      WHERE product_id = ANY($1)
         OR id IN (SELECT tool_id FROM products WHERE id = ANY($1) AND tool_id IS NOT NULL)`,
      [pids]) : [];
    // Job-card tag: marks a line as pushed (drives the Completed tab / hides "To JC").
    //
    // A line on a RUN (gang or combined) has no card of its own — the run's
    // parent card carries order_line_id NULL and gang_run_id instead, and a
    // gang only mints per-member children after die cutting. Matching on
    // order_line_id alone therefore returned NOTHING for every member of a
    // pushed run, so a finalised gang sat in Locked for ever while a single
    // product moved to Completed the moment it was pushed. Resolve BOTH: the
    // line's own card first, else the card its run is riding.
    const lineIds = rows.map(l => l.id);
    const runIds = [...new Set(rows.map(l => l.gang_run_id).filter(Boolean))];
    const [ownCards, runCards] = await Promise.all([
      lineIds.length
        ? q('SELECT id, order_line_id, jc_number FROM job_cards WHERE order_line_id = ANY($1)', [lineIds])
        : [],
      runIds.length
        ? q(`SELECT id, gang_run_id, jc_number FROM job_cards
             WHERE gang_run_id = ANY($1) AND order_line_id IS NULL AND parent_job_card_id IS NULL`, [runIds])
        : [],
    ]);
    // Board coverage — the SAME three-state verdict Planning and the Print
    // Planning triage serve (covered / on_order / short), resolved here so the
    // artwork queue can never hold a different opinion about a job's board than
    // the pages either side of it. Artwork is where board trouble is still
    // cheap: the plates are not made and the press is not booked, so this is
    // the last queue where "nobody has bought this board" is news rather than
    // an emergency. One batch of lookups for the page, exactly as /planning
    // does it — the cost does not scale with how many lines are waiting.
    const ctx = await readinessBatch(rows);
    const artGates = new Map();
    for (const l of rows) artGates.set(l.id, await readiness(l, one, ctx));
    // Same one rule as /planning and the floor. The drawn clause carries more
    // weight on this queue than on Planning: its Completed tab is nothing BUT
    // in_production lines, and without it every one of them would read short
    // the moment its board left the warehouse.
    await stampBoardState(rows, {
      lineIdOf: l => l.id,
      gangIdOf: l => l.gang_run_id,
      gatesOf: l => artGates.get(l.id),
    });
    // This queue never carried a job card ID — only the number, for display. The
    // plate verdict is keyed by card, so the id is fetched alongside it above.
    const cardIdByLine = new Map(ownCards.map(c => [c.order_line_id, c.id]));
    const cardIdByRun = new Map(runCards.map(c => [c.gang_run_id, c.id]));
    await stampPlateState(rows, {
      jobCardIdOf: l => cardIdByLine.get(l.id) ?? cardIdByRun.get(l.gang_run_id) ?? null,
      gangIdOf: l => l.gang_run_id,
    });
    for (const l of rows) {
      const mine = tools.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      l.tooling = toolingDetail({ id: l.product_id, special: l.special, tool_id: l.tool_id }, mine);
      l.tooling_ready = toolingGateOk(l.tooling, l.tooling_ok);
      l.jc_number = ownCards.find(j => j.order_line_id === l.id)?.jc_number
        || (l.gang_run_id ? runCards.find(j => j.gang_run_id === l.gang_run_id)?.jc_number : null)
        || null;
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// ONE approval endpoint — approvals only. Locking is a separate, deliberate
// action (POST …/artwork/lock below): both ticks no longer lock automatically,
// and a locked line's approvals are frozen until it is explicitly unlocked.
r.post('/order-lines/:id/artwork', canArtwork, async (req, res, next) => {
  try {
    const { customer_ok, qa_ok } = req.body;
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      if (line.artwork_locked) {
        throw Object.assign(new Error('Artwork is locked — unlock it from the Locked tab before changing approvals'), { status: 409 });
      }
      const cust = customer_ok ?? line.artwork_customer_ok;
      const qa = qa_ok ?? line.artwork_qa_ok;
      await qc(`UPDATE order_lines SET artwork_customer_ok=$1, artwork_qa_ok=$2 WHERE id=$3`,
        [cust ? 1 : 0, qa ? 1 : 0, line.id]);
      await audit('order_line', line.id, 'artwork_updated', null, qc, req.user.name);
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

// Deliberate lock — requires both approvals; promotes planned → ready when the
// sibling gates (tooling, material) also pass. Replaces the old auto-lock.
r.post('/order-lines/:id/artwork/lock', canArtwork, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      if (line.artwork_locked) return; // already locked — idempotent
      if (!line.artwork_customer_ok || !line.artwork_qa_ok) {
        throw Object.assign(new Error('Customer approval and QA approval are both required before the artwork can be locked'), { status: 409 });
      }
      await qc('UPDATE order_lines SET artwork_locked=1 WHERE id=$1', [line.id]);
      await audit('order_line', line.id, 'artwork_locked', 'locked from the Artwork queue', qc, req.user.name);
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

// Reverse from the Locked queue — blocked once a job card exists (a ganged line
// also rides the gang PARENT card, so that blocks every member). Unlocking a
// line that was promoted to 'ready' demotes it back to 'planned' so the
// pipeline's gates stay honest. Approvals are kept — only the lock is lifted.
r.post('/order-lines/:id/artwork/unlock', canArtwork, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      if (!line.artwork_locked) return; // already unlocked — idempotent
      const jc = await oc(
        `SELECT jc_number FROM job_cards
         WHERE order_line_id=$1
            OR ($2::int IS NOT NULL AND gang_run_id=$2 AND order_line_id IS NULL)
         LIMIT 1`, [line.id, line.gang_run_id]);
      if (jc) {
        throw Object.assign(new Error(`Job card ${jc.jc_number} already exists for this artwork — reverse the job card first`), { status: 409 });
      }
      await qc('UPDATE order_lines SET artwork_locked=0 WHERE id=$1', [line.id]);
      await audit('order_line', line.id, 'artwork_unlocked', 'unlocked from the Locked queue', qc, req.user.name);
      if (line.status === 'ready') {
        await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
      }
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

// Detail-form save from the Artwork Queue. Approval fields are shared with the
// approval endpoint above; planning fields stay planner/admin-only.
r.put('/order-lines/:id/artwork', canArtwork, async (req, res, next) => {
  try {
    const { customer_ok, qa_ok, planned_date, qty, notes, spec = {}, update_master } = req.body;
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });

      // Approvals save only while the artwork is unlocked; a locked line's
      // approvals are frozen (the lock itself never changes from this form —
      // locking/unlocking are the dedicated endpoints above).
      if (!line.artwork_locked) {
        const cust = customer_ok ?? line.artwork_customer_ok;
        const qa = qa_ok ?? line.artwork_qa_ok;
        await qc(`UPDATE order_lines SET artwork_customer_ok=$1, artwork_qa_ok=$2 WHERE id=$3`,
          [cust ? 1 : 0, qa ? 1 : 0, line.id]);
      }

      // Identity codes + finish spec edited on the Artwork form follow the
      // master-update philosophy: "Sync Master?" pushes the change back to the
      // Carton Product Master; otherwise it stays a job override. Emboss and
      // Leafing are 0/1 ints — 0 is a real value, so they skip the ''→null trim.
      const CODE_SPEC = ['party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'die_number', 'block_number', 'leafing_colour'];
      const AW_INT_SPEC = ['emboss', 'leafing'];
      const codeChanges = {};
      if (req.user.role === 'admin' || PLANNING_ROLES.includes(req.user.role)) {
        const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
        for (const f of CODE_SPEC) {
          if (spec[f] === undefined) continue;
          const v = String(spec[f] ?? '').trim() || null;
          if (String(v ?? '') !== String(product[f] ?? '')) codeChanges[f] = v;
        }
        for (const f of AW_INT_SPEC) {
          if (spec[f] === undefined || spec[f] === null || spec[f] === '') continue;
          const v = Math.round(+spec[f]);
          if (!Number.isFinite(v)) continue;
          if (String(v) !== String(product[f] ?? '')) codeChanges[f] = v;
        }
        if (Object.keys(codeChanges).length) {
          if (update_master) {
            const sets = Object.keys(codeChanges).map((c, i) => `${c}=$${i + 1}`).join(',');
            await qc(`UPDATE products SET ${sets} WHERE id=$${Object.keys(codeChanges).length + 1}`,
              [...Object.values(codeChanges), product.id]);
            await audit('product', product.id, 'master_update',
              `from artwork: ${Object.entries(codeChanges).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v ?? '—'}`).join('; ')}`.slice(0, 500),
              qc, req.user.name);
          } else {
            const prev = line.spec_override
              ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
              : {};
            const nextOverride = { ...prev, ...codeChanges };
            await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
              [JSON.stringify(nextOverride), line.id]);
            await audit('order_line', line.id, 'spec_override',
              `job-only: ${Object.entries(codeChanges).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v ?? '—'}`).join('; ')}`.slice(0, 500),
              qc, req.user.name);
          }
        }
      }

      if (req.user.role === 'admin' || PLANNING_ROLES.includes(req.user.role)) {
        const sets = [];
        const vals = [];
        const add = (sql, value) => { vals.push(value); sets.push(`${sql}=$${vals.length}`); };
        if (planned_date !== undefined) add('planned_date', planned_date || null);
        if (notes !== undefined) add('notes', notes || null);
        if (qty !== undefined) {
          const n = Number(qty);
          if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
          add('qty', Math.round(n));
        }
        if (sets.length) {
          vals.push(line.id);
          await qc(`UPDATE order_lines SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
        }
      }

      await audit('order_line', line.id, 'artwork_updated', 'Artwork detail form saved', qc, req.user.name);
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json({ ...out, readiness: await readiness(out) });
  } catch (e) { next(e); }
});

// Generic identity/finish spec editor — powers the Job Card's editable fields
// (Output No / Shade Card / Die / Block / Emboss / Leafing). Same master-update
// fork as Planning and Artwork; blocked once the job card is finalised (the
// Finalise gate means "inherited data is frozen — reopen to edit").
r.put('/order-lines/:id/spec', canPlanWork, async (req, res, next) => {
  try {
    const { spec = {}, update_master } = req.body;
    await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const jc = await oc(
        `SELECT jc_number, finalised_at, status FROM job_cards
         WHERE order_line_id=$1
            OR ($2::int IS NOT NULL AND gang_run_id=$2 AND order_line_id IS NULL)
         ORDER BY (order_line_id IS NULL) LIMIT 1`, [line.id, line.gang_run_id]);
      if (jc?.finalised_at) {
        throw Object.assign(new Error(`Job card ${jc.jc_number} is finalised — reopen it before editing inherited spec`), { status: 409 });
      }
      if (jc?.status === 'closed') {
        throw Object.assign(new Error(`Job card ${jc.jc_number} is closed — its spec is history now`), { status: 409 });
      }
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      const TEXT_F = ['party_artwork_code', 'output_number', 'shade_card_number', 'shade_card_date', 'die_number', 'block_number', 'leafing_colour'];
      const INT_F = ['emboss', 'leafing'];
      const changes = {};
      for (const f of TEXT_F) {
        if (spec[f] === undefined) continue;
        const v = String(spec[f] ?? '').trim() || null;
        if (String(v ?? '') !== String(product[f] ?? '')) changes[f] = v;
      }
      for (const f of INT_F) {
        if (spec[f] === undefined || spec[f] === null || spec[f] === '') continue;
        const v = Math.round(+spec[f]);
        if (!Number.isFinite(v)) continue;
        if (String(v) !== String(product[f] ?? '')) changes[f] = v;
      }
      if (!Object.keys(changes).length) return;
      if (update_master) {
        const sets = Object.keys(changes).map((c, i) => `${c}=$${i + 1}`).join(',');
        await qc(`UPDATE products SET ${sets} WHERE id=$${Object.keys(changes).length + 1}`,
          [...Object.values(changes), product.id]);
        await audit('product', product.id, 'master_update',
          `from job card: ${Object.entries(changes).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v ?? '—'}`).join('; ')}`.slice(0, 500),
          qc, req.user.name);
      } else {
        const prev = line.spec_override
          ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
          : {};
        await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
          [JSON.stringify({ ...prev, ...changes }), line.id]);
        await audit('order_line', line.id, 'spec_override',
          `job-only (from job card): ${Object.entries(changes).map(([f, v]) => `${f}: ${product[f] ?? '—'} → ${v ?? '—'}`).join('; ')}`.slice(0, 500),
          qc, req.user.name);
      }
    });
    const out = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/order-lines/:id/tooling', canPlanWork, async (req, res, next) => {
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
r.post('/order-lines/:id/raise-pr', canPlanWork, async (req, res, next) => {
  try {
    const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    // With a ctx the gate's available_sheets is CLAIMABLE (shelf less other
    // jobs' active holds, claimableQty) instead of the gross shelf. Without
    // it, a board fully frozen for other jobs answered "No shortage for this
    // line" — refusing the PR for the exact situation a PR exists to solve,
    // while the list beside it showed Stock Short off the same claimable
    // figure. fresh_pr and mix branches are unaffected; a fresh line's
    // incoming also becomes correctly line-scoped.
    const ctx = await readinessBatch([line]);
    const gate = await readiness(line, one, ctx);
    // A mix that balances leaves nothing to buy, however short the PLANNED board
    // looks on its own — the rest is coming from substitute boards already held
    // for this job. gate.mix_balance is what remains genuinely unallocated.
    // Without this, mixPosition's whole reason for existing (a substitute board
    // is held, never needed) never reached the one endpoint that spends money:
    // a fully covered job would still raise a real requisitions row.
    //
    // Ceil the balance only AFTER the same EPS test the rest of the feature
    // balances by. covers is a float sum, so a fully covered mix can leave
    // residue like 1e-10 — which mixBalance() calls balanced and Math.ceil()
    // turns into a one-sheet purchase requisition. Rounding before the
    // tolerance test is how a covered job buys board it does not need.
    const MIX_EPS = 1e-6;
    // For a fresh_pr line the gate's figures are already line-scoped (its own
    // holds, its own PR mirror), so the still-to-buy also nets incoming_sheets
    // — otherwise this endpoint re-buys the full quantity on every call. A
    // 'book' line keeps the historic spelling: its incoming is board-wide and
    // the duplicate alarm, not arithmetic, guards the double raise.
    const shortage = gate.mix_active
      ? (gate.mix_balance > MIX_EPS ? Math.ceil(gate.mix_balance) : 0)
      : gate.stock_booking === 'fresh_pr'
        ? Math.max(0, gate.parent_needed - gate.available_sheets - gate.incoming_sheets)
        : Math.max(0, gate.parent_needed - gate.available_sheets);
    if (shortage === 0) return res.status(400).json({ error: 'No shortage for this line' });
    const boardRow = await one('SELECT leftover, name FROM materials WHERE id=$1', [gate.board_material_id]);
    if (boardRow?.leftover)
      return res.status(409).json({ error: `${boardRow.name} is a leftover offcut — raise the PR against its parent board instead.` });
    const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const [pr] = await q(
      `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason, order_line_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pr_number, gate.board_material_id, shortage, line.planned_date,
       `Shortage for ${line.product_name} (PO ${line.po_number})`, line.id]);
    // The mirror is the fence: without it a fresh_pr line's claim never nets
    // its own purchase, and this endpoint's own re-buy guard reads zero
    // forever. Same line + sync pair every other PR door writes.
    await q(`INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
             VALUES ($1,$2,$3,$4)`, [pr.id, gate.board_material_id, shortage, line.planned_date]);
    await syncPrAllocation(q, pr);
    await audit('requisition', pr.id, 'create_from_shortage', pr_number, q, req.user.name);
    res.json(pr);
  } catch (e) { next(e); }
});

// Whose stock this plan runs on — 'book' (free shelf stock counts toward the
// plan, PR only the balance) or 'fresh_pr' (buy the FULL requirement; the
// shelf stays free for other jobs). Persisted the moment the planner flips the
// toggle, not at lock: a raised full-quantity PR with a stale 'book' flag
// would double-cover the line — full claim on the shelf AND full incoming.
r.post('/order-lines/:id/stock-booking', canPlanWork, async (req, res, next) => {
  try {
    const mode = req.body.stock_booking;
    if (!['book', 'fresh_pr'].includes(mode))
      return res.status(400).json({ error: "stock_booking must be 'book' or 'fresh_pr'" });
    const line = await one('SELECT * FROM order_lines WHERE id=$1', [req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    if (line.gang_run_id)
      return res.status(409).json({ error: 'This line runs in a gang — the whole run draws from one pile, so set the choice on the run.' });
    // Same edit window as the plan itself: once the job leaves for the floor
    // its board story is history, not a preference.
    if (!['pending', 'planned', 'ready'].includes(line.status))
      return res.status(409).json({ error: `This plan is locked — ${line.status.replace(/_/g, ' ')} work cannot change its stock booking.` });
    // The guards re-run inside the UPDATE itself: a concurrent gang join (or
    // status flip) between the read above and this write must void the write,
    // not race it — a member whose flag contradicts its run would make the
    // gang card and the Board register disagree about the same shelf.
    const updated = await q(`UPDATE order_lines SET stock_booking=$1
       WHERE id=$2 AND gang_run_id IS NULL AND status IN ('pending','planned','ready')
       RETURNING id`, [mode, line.id]);
    if (!updated.length)
      return res.status(409).json({ error: 'The line changed while you decided — reopen the plan and set the choice again.' });
    await audit('order_line', line.id, 'stock_booking', mode, q, req.user.name);
    res.json({ ok: true, stock_booking: mode });
  } catch (e) { next(e); }
});

export default r;
