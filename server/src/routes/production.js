// Job cards + production stages. Fixes the old system by design:
// - readiness gate has NO bypass
// - stage start consumes board stock (ledger row, FIFO)
// - strictly sequential stages, one in_progress at a time
// - final stage completion closes the job, credits FG, notifies dispatch
import { Router } from 'express';
import db from '../db.js';
import { audit, setLineStatus, readiness, routingFor, nextNumber, consumeFifo, fgReceipt } from '../helpers.js';

const r = Router();

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

r.get('/job-cards', (req, res) => {
  const rows = db.prepare(`${JC_VIEW} ORDER BY jc.status='closed', jc.id DESC`).all();
  const stages = db.prepare('SELECT * FROM job_stages ORDER BY job_card_id, seq').all();
  const byJc = {};
  for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);
  res.json(rows.map(jc => ({ ...jc, stages: byJc[jc.id] || [] })));
});

r.get('/job-cards/:id', (req, res) => {
  const jc = db.prepare(`${JC_VIEW} WHERE jc.id=?`).get(req.params.id);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  jc.stages = db.prepare('SELECT * FROM job_stages WHERE job_card_id=? ORDER BY seq').all(jc.id);
  res.json(jc);
});

// Create a job card from a ready order line. The gate runs for EVERY call.
r.post('/order-lines/:id/job-card', (req, res, next) => {
  try {
    const jcId = db.transaction(() => {
      const line = db.prepare('SELECT * FROM order_lines WHERE id=?').get(req.params.id);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });
      const gate = readiness(line);
      const blocked = [];
      if (!gate.artwork) blocked.push('artwork not locked');
      if (!gate.tooling) blocked.push('tooling not ready');
      if (!gate.material) blocked.push(`board short by ${gate.needed_sheets - gate.available_sheets} sheets`);
      if (blocked.length) throw Object.assign(new Error(`Cannot create job card: ${blocked.join(', ')}`), { status: 409 });

      setLineStatus(line.id, 'in_production'); // ready → in_production (state machine enforces 'ready')
      const product = db.prepare('SELECT * FROM products WHERE id=?').get(line.product_id);
      const jc_number = nextNumber('CI-JC-', 'job_cards', 'jc_number');
      const info = db.prepare(
        `INSERT INTO job_cards (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued)
         VALUES (?,?,?,?,?,?)`
      ).run(jc_number, line.id, line.product_id, line.machine_id, line.qty, gate.needed_sheets);
      const jcId = info.lastInsertRowid;

      const stages = routingFor(product);
      const ins = db.prepare('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES (?,?,?,?)');
      stages.forEach((s, i) => ins.run(jcId, i + 1, s.stage, s.unit));
      audit('job_card', jcId, 'create', jc_number);
      return jcId;
    })();
    res.json(db.prepare(`${JC_VIEW} WHERE jc.id=?`).get(jcId));
  } catch (e) { next(e); }
});

// Start a stage. First stage consumes board stock in the same transaction.
r.post('/job-stages/:id/start', (req, res, next) => {
  try {
    db.transaction(() => {
      const st = db.prepare('SELECT * FROM job_stages WHERE id=?').get(req.params.id);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'pending') throw Object.assign(new Error('Stage already started'), { status: 409 });

      const jc = db.prepare('SELECT * FROM job_cards WHERE id=?').get(st.job_card_id);
      const active = db.prepare(
        `SELECT COUNT(*) AS n FROM job_stages WHERE job_card_id=? AND status='in_progress'`).get(jc.id);
      if (active.n > 0) throw Object.assign(new Error('Another stage is already running on this job card'), { status: 409 });

      const prev = db.prepare('SELECT * FROM job_stages WHERE job_card_id=? AND seq=?').get(jc.id, st.seq - 1);
      if (prev && prev.status !== 'completed')
        throw Object.assign(new Error(`Complete "${prev.stage.replace('_', ' ')}" first`), { status: 409 });

      // qty_in: first stage = sheets issued; later stages = previous qty_out
      // (converted sheets→cartons at the die-cutting → pasting boundary).
      let qtyIn;
      if (!prev) {
        qtyIn = jc.sheets_issued;
        consumeFifo(
          db.prepare('SELECT board_material_id FROM products WHERE id=?').get(jc.product_id).board_material_id,
          jc.sheets_issued, 'job_card', jc.id, `Issue to ${jc.jc_number}`
        );
      } else {
        const prevUnit = prev.unit, thisUnit = st.unit;
        const ups = db.prepare('SELECT ups FROM products WHERE id=?').get(jc.product_id).ups;
        qtyIn = prevUnit === 'sheets' && thisUnit === 'cartons' ? prev.qty_out * ups : prev.qty_out;
      }

      db.prepare(`UPDATE job_stages SET status='in_progress', qty_in=?, operator=?, started_at=datetime('now','localtime') WHERE id=?`)
        .run(qtyIn, req.body.operator || null, st.id);
      if (jc.status === 'open') db.prepare(`UPDATE job_cards SET status='in_progress' WHERE id=?`).run(jc.id);
      audit('job_stage', st.id, 'start', `${st.stage} qty_in=${qtyIn}`);
    })();
    res.json(db.prepare('SELECT * FROM job_stages WHERE id=?').get(req.params.id));
  } catch (e) { next(e); }
});

// Complete a stage. Final stage closes the job card + FG receipt + line status.
r.post('/job-stages/:id/complete', (req, res, next) => {
  try {
    db.transaction(() => {
      const st = db.prepare('SELECT * FROM job_stages WHERE id=?').get(req.params.id);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'in_progress') throw Object.assign(new Error('Stage is not running'), { status: 409 });

      const qty_out = +req.body.qty_out;
      const qty_scrap = +(req.body.qty_scrap || 0);
      if (!qty_out && qty_out !== 0) throw Object.assign(new Error('Output quantity is required'), { status: 400 });
      if (qty_out + qty_scrap > st.qty_in)
        throw Object.assign(new Error(`Output + scrap (${qty_out + qty_scrap}) exceeds input (${st.qty_in})`), { status: 409 });

      db.prepare(`UPDATE job_stages SET status='completed', qty_out=?, qty_scrap=?, completed_at=datetime('now','localtime') WHERE id=?`)
        .run(qty_out, qty_scrap, st.id);
      audit('job_stage', st.id, 'complete', `${st.stage} out=${qty_out} scrap=${qty_scrap}`);

      const jc = db.prepare('SELECT * FROM job_cards WHERE id=?').get(st.job_card_id);
      const last = db.prepare('SELECT MAX(seq) AS mx FROM job_stages WHERE job_card_id=?').get(jc.id);
      if (st.seq === last.mx) {
        // Close the job: totals, FG receipt, dispatch-ready — all here, atomically.
        const totScrap = db.prepare(
          `SELECT COALESCE(SUM(qty_scrap),0) AS s FROM job_stages WHERE job_card_id=?`).get(jc.id).s;
        db.prepare(`UPDATE job_cards SET status='closed', qty_produced=?, qty_scrap=?, closed_at=datetime('now','localtime') WHERE id=?`)
          .run(qty_out, totScrap, jc.id);
        fgReceipt(jc.product_id, qty_out, 'job_card', jc.id);
        setLineStatus(jc.order_line_id, 'produced');
        audit('job_card', jc.id, 'closed', `produced=${qty_out} scrap=${totScrap}`);
      }
    })();
    res.json(db.prepare('SELECT * FROM job_stages WHERE id=?').get(req.params.id));
  } catch (e) { next(e); }
});

export default r;
