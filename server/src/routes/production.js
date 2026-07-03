// Job cards + production stages.
// - readiness gate has NO bypass
// - first stage start consumes board stock (ledger row, FIFO)
// - strictly sequential stages, one in_progress at a time
// - final stage completion closes the job, credits FG, feeds dispatch
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, readiness, routingFor, nextNumber, consumeFifo, fgReceipt, effectiveProduct } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canRun = requireRole('production');

const JC_VIEW = `
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.ups, p.size, p.colors,
         p.child_l, p.child_w,
         p.board_material_id, bm.name AS board_name, bm.sheet_l, bm.sheet_w,
         ol.qty AS line_qty, ol.order_id, o.po_number, o.delivery_date,
         c.name AS customer_name, m.name AS machine_name
  FROM job_cards jc
  JOIN products p ON p.id = jc.product_id
  JOIN materials bm ON bm.id = p.board_material_id
  JOIN order_lines ol ON ol.id = jc.order_line_id
  JOIN orders o ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  LEFT JOIN machines m ON m.id = jc.machine_id`;

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
      SELECT sm.qty, sm.created_at, b.batch_no, mt.name AS material_name, mt.unit
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
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const gate = await readiness(line, oc);
      const blocked = [];
      if (!gate.artwork) blocked.push('artwork not locked');
      if (!gate.tooling) blocked.push('tooling not ready');
      if (!gate.material) blocked.push(`board short by ${gate.parent_needed - gate.available_sheets} parent sheets`);
      if (blocked.length) throw Object.assign(new Error(`Cannot create job card: ${blocked.join(', ')}`), { status: 409 });

      await setLineStatus(line.id, 'in_production', qc, oc, req.user.name);
      const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      const product = effectiveProduct(master, line); // honor job-only spec override
      const jc_number = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
      // Issue PARENT sheets to the job; cutting converts them to child print sheets.
      const [jc] = await qc(
        `INSERT INTO job_cards (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued, children_per_parent)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [jc_number, line.id, line.product_id, line.machine_id, line.qty, gate.parent_needed, gate.children_per_parent]);

      const stages = routingFor(product);
      for (let i = 0; i < stages.length; i++) {
        await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
          [jc.id, i + 1, stages[i].stage, stages[i].unit]);
      }
      await audit('job_card', jc.id, 'create', jc_number, qc, req.user.name);
      return jc.id;
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

      let qtyIn;
      if (!prev) {
        qtyIn = jc.sheets_issued;
        const prod = await oc('SELECT board_material_id FROM products WHERE id=$1', [jc.product_id]);
        await consumeFifo(prod.board_material_id, jc.sheets_issued, 'job_card', jc.id, `Issue to ${jc.jc_number}`, qc, oc);
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
      await qc(`UPDATE job_stages SET status='in_progress', qty_in=$1, operator=$2, machine_id=$3, started_at=now() WHERE id=$4`,
        [qtyIn, req.body.operator || req.user.name, machineId, st.id]);
      if (jc.status === 'open') await qc(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [jc.id]);
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
             c.name AS customer_name, o.po_number, o.delivery_date
      FROM job_cards jc
      JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE jc.status IN ('open','in_progress') AND js.status != 'completed'
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id`);
    const presses = await q(`SELECT * FROM machines WHERE type='printing' ORDER BY name`);
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
      await qc('UPDATE job_cards SET machine_id=$1 WHERE id=$2', [machine_id || null, job_card_id]);
      await qc('UPDATE order_lines SET machine_id=$1 WHERE id=$2', [machine_id || null, jc.order_line_id]);
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
      const pack_boxes = st.stage === 'pasting' && req.body.pack_boxes ? +req.body.pack_boxes : null;
      const pack_qty_per_box = st.stage === 'pasting' && req.body.pack_qty_per_box ? +req.body.pack_qty_per_box : null;
      await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, scrap_reason=$3,
                qty_accepted=$4, qty_rejected=$5, qty_rework=$6, inspector=$7, remarks=$8,
                pack_boxes=$9, pack_qty_per_box=$10, completed_at=now() WHERE id=$11`,
        [qty_out, qty_scrap, scrap_reason, qty_accepted, qty_rejected, qty_rework,
         isQC ? (req.body.inspector || req.user.name) : null, req.body.remarks || null,
         pack_boxes, pack_qty_per_box, st.id]);
      await audit('job_stage', st.id, isQC ? 'qc' : 'complete',
        isQC ? `QC accepted=${qty_accepted} rejected=${qty_rejected} rework=${qty_rework}${scrap_reason ? ` (${scrap_reason})` : ''}`
             : `${st.stage} out=${qty_out} scrap=${qty_scrap}${scrap_reason ? ` (${scrap_reason})` : ''}`, qc, req.user.name);

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
             GREATEST(0, ol.qty - jc.qty_produced) AS shortfall
      FROM job_cards jc
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
    res.json(jc);
  } catch (e) { next(e); }
});

export default r;
