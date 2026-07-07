// Job cards + production stages.
// - readiness gate has NO bypass (a board shortage with a PR/PO on order is a
//   soft pass — the card carries a board_pending alarm until stock arrives)
// - first stage start consumes board stock (ledger row, FIFO)
// - strictly sequential stages, one in_progress at a time
// - final stage completion closes the job, credits FG, feeds dispatch
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, findOrCreateLeftoverMaster } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canRun = requireRole('production');

// board_pending: the job card exists but its board hasn't arrived yet — no
// sheets consumed for this card and available stock is below sheets_issued.
// Computed live so the alarm clears itself the moment a GRN lands.
const JC_VIEW = `
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.ups, p.size, p.colors,
         p.child_l, p.child_w,
         p.board_material_id, bm.name AS board_name, bm.sheet_l, bm.sheet_w,
         dd.code AS die_number, dd.condition AS die_condition, dd.location AS die_location,
         ol.qty AS line_qty, ol.order_id, ol.gang_run_id, gg.gang_number,
         o.po_number, o.delivery_date,
         c.name AS customer_name, m.name AS machine_name,
         (jc.status IN ('open','in_progress')
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm
                          WHERE sm.ref_type='job_card' AND sm.ref_id=jc.id AND sm.type='consumption')
          AND stk.avail < jc.sheets_issued) AS board_pending,
         GREATEST(0, jc.sheets_issued - stk.avail)::int AS board_short_sheets
  FROM job_cards jc
  JOIN products p ON p.id = jc.product_id
  JOIN materials bm ON bm.id = p.board_material_id
  LEFT JOIN tools dd ON dd.id = p.tool_id
  JOIN order_lines ol ON ol.id = jc.order_line_id
  JOIN orders o ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN machines m ON m.id = jc.machine_id
  LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sb.qty),0) AS avail FROM stock_batches sb
    WHERE sb.material_id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
      AND sb.status='available'
  ) stk ON true`;

r.get('/job-cards', async (_req, res, next) => {
  try {
    const rows = await q(`${JC_VIEW} ORDER BY (jc.status='closed'), jc.id DESC`);
    const stages = await q('SELECT * FROM job_stages ORDER BY job_card_id, seq');
    const byJc = {};
    for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);
    res.json(rows.map(jc => ({ ...jc, stages: byJc[jc.id] || [] })));
  } catch (e) { next(e); }
});

r.get('/job-cards/:id', async (req, res, next) => {
  try {
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    jc.stages = await q(`
      SELECT js.*, m.name AS stage_machine_name FROM job_stages js
      LEFT JOIN machines m ON m.id = js.machine_id
      WHERE js.job_card_id=$1 ORDER BY js.seq`, [jc.id]);
    jc.issues = await q(`
      SELECT sm.qty, sm.created_at, sm.note, b.batch_no, mt.name AS material_name, mt.unit
      FROM stock_movements sm
      LEFT JOIN stock_batches b ON b.id = sm.batch_id
      LEFT JOIN materials mt ON mt.id = sm.material_id
      WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption'
      ORDER BY sm.id`, [jc.id]);
    res.json(jc);
  } catch (e) { next(e); }
});

// Create a job card from a ready order line. The gate runs for EVERY call.
r.post('/order-lines/:id/job-card', canPlan, async (req, res, next) => {
  try {
    const jcId = await tx(async (qc, oc) => {
      return createJobCardForLine(req.params.id, qc, oc, req.user.name);
    });
    res.json(await one(`${JC_VIEW} WHERE jc.id=$1`, [jcId]));
  } catch (e) { next(e); }
});

// Start a stage. First stage consumes board stock in the same transaction.
r.post('/job-stages/:id/start', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'pending') throw Object.assign(new Error('Stage already started'), { status: 409 });

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [st.job_card_id]);
      const active = await oc(
        `SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND status IN ('in_progress','hold')`, [jc.id]);
      if (active.n > 0) throw Object.assign(new Error('Another stage is already running (or on hold) on this job card'), { status: 409 });

      const prev = await oc('SELECT * FROM job_stages WHERE job_card_id=$1 AND seq=$2', [jc.id, st.seq - 1]);
      if (prev && prev.status !== 'completed')
        throw Object.assign(new Error(`Complete "${prev.stage.replace('_', ' ')}" first`), { status: 409 });

      // Two-parallel-workflow rule: printing can only begin once the job has
      // been assigned a press in Print Planning (Cutting done + Print Planning done).
      if (st.stage === 'printing' && !jc.machine_id)
        throw Object.assign(new Error('Assign this job to a press in Print Planning before printing can start'), { status: 409 });

      // Line clearance — every working station (cutting → pasting) must confirm
      // the checklist before the run starts. Accepts ["item", …] or
      // [{label, ok}, …]; every item must be ticked. QC is exempt.
      let clearance = null;
      if (st.stage !== 'qc') {
        const raw = Array.isArray(req.body.line_clearance) ? req.body.line_clearance : [];
        const items = raw.map(it => (typeof it === 'string' ? { label: it, ok: true } : { label: String(it?.label || ''), ok: !!it?.ok }))
          .filter(it => it.label);
        if (!items.length || items.some(it => !it.ok))
          throw Object.assign(new Error('Line clearance incomplete — confirm every checklist point before starting'), { status: 409 });
        clearance = JSON.stringify({ items: items.map(it => it.label), by: req.body.operator || req.user.name, at: new Date().toISOString() });
      }

      let qtyIn;
      if (!prev) {
        qtyIn = jc.sheets_issued;
        // Issue the line's EFFECTIVE board — a warehouse pick made in the
        // planning engine (spec_override) must be what cutting consumes.
        const eff = await oc(`
          SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM order_lines ol JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [jc.order_line_id]);
        await consumeFifo(eff.board_material_id, jc.sheets_issued, 'job_card', jc.id, `Issue to ${jc.jc_number}`, qc, oc);
      } else {
        const ups = (await oc('SELECT ups FROM products WHERE id=$1', [jc.product_id])).ups;
        qtyIn = prev.unit === 'sheets' && st.unit === 'cartons' ? prev.qty_out * ups : prev.qty_out;
      }

      let machineId = req.body.machine_id ?? null;
      if (machineId) {
        const m = await oc('SELECT * FROM machines WHERE id=$1', [machineId]);
        if (!m || m.type !== st.stage) machineId = null; // only accept a machine of this section
      }
      // Printing inherits the press assigned in Print Planning by default, so
      // machine utilisation is attributed even without re-picking the machine.
      if (!machineId && st.stage === 'printing' && jc.machine_id) machineId = jc.machine_id;
      // Operator preference: explicit pick → the press operator already on the
      // stage (set by Print Planning) → the signed-in user.
      await qc(`UPDATE job_stages SET status='in_progress', qty_in=$1, operator=$2, machine_id=$3, line_clearance=$4, started_at=now() WHERE id=$5`,
        [qtyIn, req.body.operator || st.operator || req.user.name, machineId, clearance, st.id]);
      if (jc.status === 'open') await qc(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [jc.id]);
      if (clearance) {
        const c = JSON.parse(clearance);
        await audit('job_stage', st.id, 'line_clearance', `${st.stage} — ${c.items.length} points confirmed by ${c.by}`, qc, req.user.name);
      }
      await audit('job_stage', st.id, 'start', `${st.stage} qty_in=${qtyIn}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Print planning (kanban) ────────────────────────────────────────────────
// Job cards whose printing stage is still open, grouped by press.
r.get('/print-planning', async (_req, res, next) => {
  try {
    const cards = await q(`
      SELECT jc.id, jc.jc_number, jc.machine_id, jc.queue_pos, jc.sheets_issued, jc.qty_planned,
             js.status AS printing_status, js.operator AS printing_operator,
             p.name AS product_name, p.code AS product_code, p.colors, p.coating,
             c.name AS customer_name, o.po_number, o.delivery_date,
             ol.gang_run_id, gg.gang_number,
             (NOT EXISTS (SELECT 1 FROM stock_movements sm
                          WHERE sm.ref_type='job_card' AND sm.ref_id=jc.id AND sm.type='consumption')
              AND stk.avail < jc.sheets_issued) AS board_pending
      FROM job_cards jc
      JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sb.qty),0) AS avail FROM stock_batches sb
        WHERE sb.material_id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
          AND sb.status='available'
      ) stk ON true
      WHERE jc.status IN ('open','in_progress') AND js.status != 'completed'
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id`);
    // Active presses only, each carrying its assigned crew — the lane header
    // shows "CI-1 · Komori Lithrone 5-Colour · Shiv Kumar".
    const presses = await q(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=m.id AND e.active=1) ops ON true
      WHERE m.type='printing' AND COALESCE(m.active,1)=1 ORDER BY m.name`);
    res.json({ cards, presses });
  } catch (e) { next(e); }
});

// Persist a drag: which press lane, and the full order of that lane.
r.post('/print-planning/assign', canPlan, async (req, res, next) => {
  try {
    const { job_card_id, machine_id, ordered_ids } = req.body;
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const printing = await oc(`SELECT status FROM job_stages WHERE job_card_id=$1 AND stage='printing'`, [job_card_id]);
      if (printing?.status === 'completed')
        throw Object.assign(new Error('Printing already completed for this job'), { status: 409 });
      if (machine_id) {
        const m = await oc('SELECT * FROM machines WHERE id=$1', [machine_id]);
        if (!m || m.type !== 'printing') throw Object.assign(new Error('Not a printing machine'), { status: 400 });
      }
      // A ganged job never moves alone — the whole gang follows to the press
      // (or back to triage), so the shared run stays on one machine.
      const line = await oc('SELECT gang_run_id FROM order_lines WHERE id=$1', [jc.order_line_id]);
      const gangJcIds = line?.gang_run_id
        ? (await qc(`
            SELECT jc2.id, jc2.order_line_id FROM job_cards jc2
            JOIN order_lines ol2 ON ol2.id = jc2.order_line_id
            JOIN job_stages js2 ON js2.job_card_id = jc2.id AND js2.stage='printing'
            WHERE ol2.gang_run_id=$1 AND jc2.status IN ('open','in_progress') AND js2.status != 'completed'`,
            [line.gang_run_id]))
        : [{ id: jc.id, order_line_id: jc.order_line_id }];
      // The move lands on the live printing queue in the same transaction:
      // every not-yet-completed printing stage follows to the new press and
      // is handed to that press's assigned operator (its crew's first name).
      // Back to triage clears both — the job has no press, so no operator.
      const crew = machine_id
        ? await oc(`
            SELECT e.name FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
            WHERE mo.machine_id=$1 AND e.active=1 ORDER BY e.name LIMIT 1`, [machine_id])
        : null;
      for (const g of gangJcIds) {
        await qc('UPDATE job_cards SET machine_id=$1 WHERE id=$2', [machine_id || null, g.id]);
        await qc('UPDATE order_lines SET machine_id=$1 WHERE id=$2', [machine_id || null, g.order_line_id]);
        await qc(`UPDATE job_stages SET machine_id=$1, operator=$2
                  WHERE job_card_id=$3 AND stage='printing' AND status != 'completed'`,
          [machine_id || null, crew?.name || null, g.id]);
      }
      // Re-sequence the whole lane in the order the board shows it.
      for (let i = 0; i < (ordered_ids || []).length; i++) {
        await qc('UPDATE job_cards SET queue_pos=$1 WHERE id=$2', [i + 1, ordered_ids[i]]);
      }
      if (!ordered_ids?.length) await qc('UPDATE job_cards SET queue_pos=NULL WHERE id=$1', [job_card_id]);
      await audit('job_card', job_card_id, 'print_plan',
        machine_id ? `assigned press ${machine_id}` : 'moved to triage', qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Hold / resume a running stage — machine breakdown, shade issue, etc.
r.post('/job-stages/:id/hold', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'in_progress') throw Object.assign(new Error('Only a running stage can be put on hold'), { status: 409 });
      await qc(`UPDATE job_stages SET status='hold', hold_reason=$1 WHERE id=$2`, [req.body.reason || null, st.id]);
      await audit('job_stage', st.id, 'hold', `${st.stage}${req.body.reason ? ` — ${req.body.reason}` : ''}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/resume', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'hold') throw Object.assign(new Error('Stage is not on hold'), { status: 409 });
      await qc(`UPDATE job_stages SET status='in_progress', hold_reason=NULL WHERE id=$1`, [st.id]);
      await audit('job_stage', st.id, 'resume', st.stage, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// Complete a stage. Final stage closes the job card + FG receipt + line status.
r.post('/job-stages/:id/complete', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'in_progress') throw Object.assign(new Error('Stage is not running'), { status: 409 });

      const isQC = st.stage === 'qc';
      // QC captures Accepted / Rejected / Rework; other stages capture Good / Wastage.
      // For QC, good output = accepted (only accepted moves to Finished Goods).
      const qty_accepted = isQC ? +(req.body.qty_accepted ?? req.body.qty_out) : null;
      const qty_rejected = isQC ? +(req.body.qty_rejected || 0) : null;
      const qty_rework = isQC ? +(req.body.qty_rework || 0) : null;
      const qty_out = isQC ? qty_accepted : +req.body.qty_out;
      const qty_scrap = isQC ? qty_rejected : +(req.body.qty_scrap || 0);
      if (!qty_out && qty_out !== 0) throw Object.assign(new Error(isQC ? 'Accepted quantity is required' : 'Output quantity is required'), { status: 400 });

      // Cutting converts parent sheets → child print sheets, so its output cap
      // is qty_in × children_per_parent (CI-Production exempts cutting too).
      let cap = st.qty_in;
      if (st.stage === 'cutting') {
        const jcRow0 = await oc('SELECT children_per_parent FROM job_cards WHERE id=$1', [st.job_card_id]);
        cap = st.qty_in * Math.max(1, jcRow0?.children_per_parent || 1);
      }
      const consumed = isQC ? (qty_accepted + qty_rejected + qty_rework) : (qty_out + qty_scrap);
      if (consumed > cap)
        throw Object.assign(new Error(`${isQC ? 'Accepted + rejected + rework' : 'Output + scrap'} (${consumed}) exceeds input (${cap})`), { status: 409 });

      const scrap_reason = qty_scrap > 0 ? (req.body.scrap_reason || null) : null;

      // Packing manifest — multi-line factory packing on the pasting stage:
      // N full boxes of X each, part boxes, loose pieces. Each line is stored;
      // the summary lands on the stage for quick reads (back-compatible).
      let pack_boxes = st.stage === 'pasting' && req.body.pack_boxes ? +req.body.pack_boxes : null;
      let pack_qty_per_box = st.stage === 'pasting' && req.body.pack_qty_per_box ? +req.body.pack_qty_per_box : null;
      const packingLines = st.stage === 'pasting' && Array.isArray(req.body.packing_lines)
        ? req.body.packing_lines
            .map(pl => ({
              boxes: Math.max(0, Math.round(+pl.boxes || 0)),
              qty_per_box: Math.max(0, Math.round(+pl.qty_per_box || 0)),
              loose_qty: Math.max(0, Math.round(+pl.loose_qty || 0)),
            }))
            .map(pl => ({ ...pl, total: pl.boxes * pl.qty_per_box + pl.loose_qty }))
            .filter(pl => pl.total > 0)
        : null;
      if (packingLines?.length) {
        for (const pl of packingLines) {
          await qc(`INSERT INTO packing_lines (job_stage_id, boxes, qty_per_box, loose_qty, total)
                    VALUES ($1,$2,$3,$4,$5)`, [st.id, pl.boxes, pl.qty_per_box, pl.loose_qty, pl.total]);
        }
        pack_boxes = packingLines.reduce((s, pl) => s + pl.boxes + (pl.loose_qty > 0 ? 1 : 0), 0);
        const boxLines = packingLines.filter(pl => pl.boxes > 0);
        pack_qty_per_box = boxLines.length === 1 ? boxLines[0].qty_per_box : null;
        const packedTotal = packingLines.reduce((s, pl) => s + pl.total, 0);
        await audit('job_stage', st.id, 'packing_manifest',
          `${packingLines.length} lines — ${packedTotal} pcs in ${pack_boxes} boxes`, qc, req.user.name);
      }
      await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, scrap_reason=$3,
                qty_accepted=$4, qty_rejected=$5, qty_rework=$6, inspector=$7, remarks=$8,
                pack_boxes=$9, pack_qty_per_box=$10, completed_at=now() WHERE id=$11`,
        [qty_out, qty_scrap, scrap_reason, qty_accepted, qty_rejected, qty_rework,
         isQC ? (req.body.inspector || req.user.name) : null, req.body.remarks || null,
         pack_boxes, pack_qty_per_box, st.id]);
      await audit('job_stage', st.id, isQC ? 'qc' : 'complete',
        isQC ? `QC accepted=${qty_accepted} rejected=${qty_rejected} rework=${qty_rework}${scrap_reason ? ` (${scrap_reason})` : ''}`
             : `${st.stage} out=${qty_out} scrap=${qty_scrap}${scrap_reason ? ` (${scrap_reason})` : ''}`, qc, req.user.name);

      // Bank the planned leftover offcut — booked once per job card, from the
      // ACTUAL parents cut (qty_in), not the planned figure. Idempotent via
      // the LO-<jc_number> batch_no, so retries and stage adjustments can't
      // double-book. Declined/absent plan = no-op.
      if (st.stage === 'cutting') {
        const lp = await oc(`
          SELECT ol.leftover_plan, jc.jc_number,
                 COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM job_cards jc JOIN order_lines ol ON ol.id=jc.order_line_id
          JOIN products p ON p.id=ol.product_id WHERE jc.id=$1`, [st.job_card_id]);
        const plan = typeof lp?.leftover_plan === 'string' ? JSON.parse(lp.leftover_plan) : lp?.leftover_plan;
        if (plan?.push && plan.strip) {
          const batchNo = `LO-${lp.jc_number}`;
          const dup = await oc('SELECT id FROM stock_batches WHERE batch_no=$1', [batchNo]);
          if (!dup) {
            const srcBoard = await oc('SELECT * FROM materials WHERE id=$1', [lp.board_material_id]);
            const master = await findOrCreateLeftoverMaster(srcBoard, plan.strip, qc, oc);
            const loQty = (plan.strips_per_parent || 1) * st.qty_in;
            const [loBatch] = await qc(`
              INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
              VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`, [master.id, batchNo, loQty]);
            await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                      VALUES ($1,$2,'leftover_in',$3,'job_stage',$4,$5)`,
              [master.id, loBatch.id, loQty, st.id,
               `Leftover ${plan.strip.l}×${plan.strip.w}" banked from ${lp.jc_number}`]);
            await audit('material', master.id, 'leftover_in',
              `${loQty} sheets ${plan.strip.l}×${plan.strip.w}" from ${lp.jc_number}`, qc, req.user.name);
          }
        }
      }

      // Wastage hits the movement ledger — production scrap is visible in the warehouse.
      if (qty_scrap > 0) {
        const jcRow = await oc('SELECT product_id FROM job_cards WHERE id=$1', [st.job_card_id]);
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
          [jcRow.product_id, -qty_scrap, st.id,
           `${st.stage.replace('_', ' ')} wastage (${st.unit})${scrap_reason ? ` — ${scrap_reason}` : ''}`]);
      }

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [st.job_card_id]);
      const last = await oc('SELECT MAX(seq) AS mx FROM job_stages WHERE job_card_id=$1', [jc.id]);
      if (st.seq === last.mx) {
        const tot = await oc(`SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1`, [jc.id]);
        // Only QC-accepted quantity becomes Finished Goods.
        await qc(`UPDATE job_cards SET status='closed', qty_produced=$1, qty_scrap=$2,
                  fg_location=COALESCE(fg_location,'FG-STORE'), closed_at=now() WHERE id=$3`,
          [qty_out, tot.s, jc.id]);
        await fgReceipt(jc.product_id, qty_out, 'job_card', jc.id, qc);
        await setLineStatus(jc.order_line_id, 'produced', qc, oc, req.user.name);
        await audit('job_card', jc.id, 'closed', `FG ${qty_out} accepted (batch ${jc.jc_number})`, qc, req.user.name);
      }
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Row-level stage adjustment ──────────────────────────────────────────────
// A permitted correction to a COMPLETED stage's quantities cascades forward:
// the next stage's received quantity updates in real time. Guard rails:
// nothing downstream may already be completed, the job must still be open,
// and every change is audited old → new with a reason.
async function stageImpact(stageId, newOut, newScrap, oc) {
  const st = await oc(`
    SELECT js.*, jc.status AS jc_status, jc.children_per_parent, jc.jc_number, jc.product_id
    FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id WHERE js.id=$1`, [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });

  const out = { stage: st, old: { qty_out: st.qty_out, qty_scrap: st.qty_scrap }, new: { qty_out: newOut, qty_scrap: newScrap }, downstream: [], blocked: null };
  if (st.status !== 'completed') { out.blocked = 'Only a completed stage can be adjusted'; return out; }
  if (st.jc_status === 'closed') { out.blocked = 'Job is closed — finished goods and dispatch already exist. Use a controlled FG adjustment instead of editing history.'; return out; }

  const later = await oc(`SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND seq>$2 AND status='completed'`, [st.job_card_id, st.seq]);
  if (later.n > 0) { out.blocked = 'A later stage is already completed — its recorded output would become inconsistent. Adjust the latest completed stage instead.'; return out; }

  let cap = st.qty_in;
  if (st.stage === 'cutting') cap = st.qty_in * Math.max(1, st.children_per_parent || 1);
  if (newOut + newScrap > cap) { out.blocked = `Output + wastage (${newOut + newScrap}) exceeds received (${cap})`; return out; }

  const next = await oc('SELECT * FROM job_stages WHERE job_card_id=$1 AND seq=$2', [st.job_card_id, st.seq + 1]);
  if (next && next.status !== 'pending') {
    const ups = (await oc('SELECT ups FROM products WHERE id=$1', [st.product_id])).ups;
    const newIn = st.unit === 'sheets' && next.unit === 'cartons' ? newOut * ups : newOut;
    out.downstream.push({ id: next.id, stage: next.stage, status: next.status, old_qty_in: next.qty_in, new_qty_in: newIn });
  } else if (next) {
    out.downstream.push({ id: next.id, stage: next.stage, status: next.status, old_qty_in: null, new_qty_in: null, note: 'not started — will receive the new quantity automatically' });
  }
  return out;
}

r.get('/job-stages/:id/impact', canRun, async (req, res, next) => {
  try {
    const newOut = Math.max(0, Math.round(+req.query.qty_out || 0));
    const newScrap = Math.max(0, Math.round(+req.query.qty_scrap || 0));
    const impact = await stageImpact(req.params.id, newOut, newScrap, one);
    res.json({
      stage: { id: impact.stage.id, stage: impact.stage.stage, jc_number: impact.stage.jc_number, qty_in: impact.stage.qty_in, unit: impact.stage.unit },
      old: impact.old, new: impact.new, downstream: impact.downstream, blocked: impact.blocked,
    });
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/adjust', canRun, async (req, res, next) => {
  try {
    const newOut = Math.max(0, Math.round(+req.body.qty_out || 0));
    const newScrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required for adjusting a completed stage' });
    await tx(async (qc, oc) => {
      const impact = await stageImpact(req.params.id, newOut, newScrap, oc);
      if (impact.blocked) throw Object.assign(new Error(impact.blocked), { status: 409 });
      const st = impact.stage;

      await qc(`UPDATE job_stages SET qty_out=$1, qty_scrap=$2 WHERE id=$3`, [newOut, newScrap, st.id]);
      // Wastage delta hits the movement ledger so warehouse figures stay true.
      const scrapDelta = newScrap - (st.qty_scrap || 0);
      if (scrapDelta !== 0) {
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
          [st.product_id, -scrapDelta, st.id, `${st.stage.replace('_', ' ')} wastage adjusted — ${reason}`]);
      }
      for (const d of impact.downstream) {
        if (d.new_qty_in == null) continue;
        await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [d.new_qty_in, d.id]);
        await audit('job_stage', d.id, 'cascade_update',
          `qty_in ${d.old_qty_in} → ${d.new_qty_in} (upstream ${st.stage} adjusted)`, qc, req.user.name);
      }
      await audit('job_stage', st.id, 'adjust',
        `out ${st.qty_out} → ${newOut}, scrap ${st.qty_scrap} → ${newScrap} — ${reason}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Finished Goods ──────────────────────────────────────────────────────────
// Every closed job card is an FG batch: QC-accepted qty in, dispatched out,
// with ordered vs produced (excess / short) and dispatch readiness.
r.get('/finished-goods', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT jc.id AS job_card_id, jc.jc_number AS batch, jc.qty_produced, jc.qty_scrap,
             jc.fg_location, jc.closed_at,
             p.id AS product_id, p.name AS product_name, p.code AS product_code, p.rate,
             c.name AS customer_name, o.po_number,
             ol.qty AS ordered_qty, ol.dispatched_qty, ol.status AS line_status,
             (jc.qty_produced - ol.dispatched_qty) AS available,
             GREATEST(0, jc.qty_produced - ol.qty) AS excess,
             GREATEST(0, ol.qty - jc.qty_produced) AS shortfall,
             COALESCE(lot.lotted, 0) AS lotted_qty
      FROM job_cards jc
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(qty),0)::int AS lotted FROM fg_lots
        WHERE job_card_id=jc.id AND status != 'rejected') lot ON true
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE jc.status='closed'
      ORDER BY (jc.qty_produced - ol.dispatched_qty) > 0 DESC, jc.closed_at DESC NULLS LAST`));
  } catch (e) { next(e); }
});

// One batch's full production history (stage by stage) for FG traceability.
r.get('/finished-goods/:jobCardId', async (req, res, next) => {
  try {
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.jobCardId]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    jc.stages = await q(`SELECT js.*, m.name AS stage_machine_name FROM job_stages js
      LEFT JOIN machines m ON m.id=js.machine_id WHERE js.job_card_id=$1 ORDER BY js.seq`, [jc.id]);
    jc.dispatches = await q(`
      SELECT d.challan_number, d.dispatched_at, dl.qty FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id WHERE dl.order_line_id=$1 ORDER BY d.id`, [jc.order_line_id]);
    jc.packing = await q(`
      SELECT pl.* FROM packing_lines pl
      JOIN job_stages js ON js.id=pl.job_stage_id
      WHERE js.job_card_id=$1 ORDER BY pl.id`, [jc.id]);
    jc.lots = await q(`
      SELECT fl.*, (fl.qty - fl.consumed_qty) AS remaining FROM fg_lots fl
      WHERE fl.job_card_id=$1 ORDER BY fl.id`, [jc.id]);
    res.json(jc);
  } catch (e) { next(e); }
});

export default r;
