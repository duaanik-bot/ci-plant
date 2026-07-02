// Job cards + production stages.
// - readiness gate has NO bypass
// - first stage start consumes board stock (ledger row, FIFO)
// - strictly sequential stages, one in_progress at a time
// - final stage completion closes the job, credits FG, feeds dispatch
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, setLineStatus, readiness, routingFor, nextNumber, consumeFifo, fgReceipt } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canRun = requireRole('production');

const JC_VIEW = `
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.ups, p.size, p.colors,
         p.board_material_id, bm.name AS board_name,
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
    jc.stages = await q('SELECT * FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [jc.id]);
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
      if (!gate.material) blocked.push(`board short by ${gate.needed_sheets - gate.available_sheets} sheets`);
      if (blocked.length) throw Object.assign(new Error(`Cannot create job card: ${blocked.join(', ')}`), { status: 409 });

      await setLineStatus(line.id, 'in_production', qc, oc, req.user.name);
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      const jc_number = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
      const [jc] = await qc(
        `INSERT INTO job_cards (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [jc_number, line.id, line.product_id, line.machine_id, line.qty, gate.needed_sheets]);

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
        `SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND status='in_progress'`, [jc.id]);
      if (active.n > 0) throw Object.assign(new Error('Another stage is already running on this job card'), { status: 409 });

      const prev = await oc('SELECT * FROM job_stages WHERE job_card_id=$1 AND seq=$2', [jc.id, st.seq - 1]);
      if (prev && prev.status !== 'completed')
        throw Object.assign(new Error(`Complete "${prev.stage.replace('_', ' ')}" first`), { status: 409 });

      let qtyIn;
      if (!prev) {
        qtyIn = jc.sheets_issued;
        const prod = await oc('SELECT board_material_id FROM products WHERE id=$1', [jc.product_id]);
        await consumeFifo(prod.board_material_id, jc.sheets_issued, 'job_card', jc.id, `Issue to ${jc.jc_number}`, qc, oc);
      } else {
        const ups = (await oc('SELECT ups FROM products WHERE id=$1', [jc.product_id])).ups;
        qtyIn = prev.unit === 'sheets' && st.unit === 'cartons' ? prev.qty_out * ups : prev.qty_out;
      }

      await qc(`UPDATE job_stages SET status='in_progress', qty_in=$1, operator=$2, started_at=now() WHERE id=$3`,
        [qtyIn, req.body.operator || req.user.name, st.id]);
      if (jc.status === 'open') await qc(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [jc.id]);
      await audit('job_stage', st.id, 'start', `${st.stage} qty_in=${qtyIn}`, qc, req.user.name);
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

      const qty_out = +req.body.qty_out;
      const qty_scrap = +(req.body.qty_scrap || 0);
      if (!qty_out && qty_out !== 0) throw Object.assign(new Error('Output quantity is required'), { status: 400 });
      if (qty_out + qty_scrap > st.qty_in)
        throw Object.assign(new Error(`Output + scrap (${qty_out + qty_scrap}) exceeds input (${st.qty_in})`), { status: 409 });

      await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, completed_at=now() WHERE id=$3`,
        [qty_out, qty_scrap, st.id]);
      await audit('job_stage', st.id, 'complete', `${st.stage} out=${qty_out} scrap=${qty_scrap}`, qc, req.user.name);

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [st.job_card_id]);
      const last = await oc('SELECT MAX(seq) AS mx FROM job_stages WHERE job_card_id=$1', [jc.id]);
      if (st.seq === last.mx) {
        const tot = await oc(`SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1`, [jc.id]);
        await qc(`UPDATE job_cards SET status='closed', qty_produced=$1, qty_scrap=$2, closed_at=now() WHERE id=$3`,
          [qty_out, tot.s, jc.id]);
        await fgReceipt(jc.product_id, qty_out, 'job_card', jc.id, qc);
        await setLineStatus(jc.order_line_id, 'produced', qc, oc, req.user.name);
        await audit('job_card', jc.id, 'closed', `produced=${qty_out} scrap=${tot.s}`, qc, req.user.name);
      }
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
