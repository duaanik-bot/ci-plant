// Workflow controls — deliberate pushes and safe reversals between modules.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, createJobCardForLine, forceLineStatus, readiness, setLineStatus } from '../helpers.js';

const r = Router();

const LINE_VIEW = `
  SELECT ol.*, o.po_number, o.delivery_date, c.name AS customer_name,
         p.name AS product_name, p.code AS product_code
  FROM order_lines ol
  JOIN orders o ON o.id=ol.order_id
  JOIN customers c ON c.id=o.customer_id
  JOIN products p ON p.id=ol.product_id`;

function can(user, roles) {
  return user?.role === 'admin' || roles.includes(user?.role);
}

function requireAny(req, roles) {
  if (!can(req.user, roles)) {
    const e = new Error(`Your role (${req.user?.role}) cannot perform this workflow action`);
    e.status = 403;
    throw e;
  }
}

async function linePayload(lineId) {
  const line = await one(`${LINE_VIEW} WHERE ol.id=$1`, [lineId]);
  return line ? { ...line, readiness: await readiness(line) } : null;
}

r.post('/workflow/order-lines/:id', async (req, res, next) => {
  try {
    const { action, destinations = [], note, clear_artwork = true } = req.body || {};
    const lineId = +req.params.id;
    const result = await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });

      if (action === 'push_to_artwork') {
        requireAny(req, ['planner']);
        let currentStatus = line.status;
        if (line.status === 'pending') {
          if (!line.machine_id || !line.planned_date || !line.sheets_required) {
            throw Object.assign(new Error('Lock the planning engine before pushing this line to Artwork'), { status: 409 });
          }
          await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
          currentStatus = 'planned';
        }
        if (!['planned', 'ready'].includes(currentStatus)) {
          throw Object.assign(new Error('Only planned lines can be pushed to Artwork'), { status: 409 });
        }
        await audit('order_line', line.id, 'workflow:planning→artwork', note || 'Pushed to Artwork queue', qc, req.user.name);
        return { ok: true, message: 'Line is available in Artwork queue' };
      }

      if (action === 'reverse_to_planning') {
        requireAny(req, ['planner']);
        const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1 FOR UPDATE', [line.id]);
        if (jc) {
          const started = await oc(
            `SELECT COUNT(*)::int AS n FROM job_stages
             WHERE job_card_id=$1 AND status != 'pending'`, [jc.id]);
          if (started.n > 0) {
            throw Object.assign(new Error('Cannot reverse: this job card already has started, held, or completed stages'), { status: 409 });
          }
          await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
          await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
          await audit('job_card', jc.id, 'workflow:deleted_before_start', note || 'Reversed before production start', qc, req.user.name);
        }
        await qc(
          `UPDATE order_lines
           SET status='planned',
               artwork_customer_ok=CASE WHEN $2 THEN 0 ELSE artwork_customer_ok END,
               artwork_qa_ok=CASE WHEN $2 THEN 0 ELSE artwork_qa_ok END,
               artwork_locked=CASE WHEN $2 THEN 0 ELSE artwork_locked END
           WHERE id=$1`,
          [line.id, clear_artwork ? 1 : 0]);
        await audit('order_line', line.id, 'workflow:back_to_planning',
          note || (clear_artwork ? 'Reversed and artwork approvals cleared' : 'Reversed, artwork approvals retained'),
          qc, req.user.name);
        return { ok: true, message: 'Line moved back to Planning' };
      }

      if (action === 'push_to_job_card') {
        requireAny(req, ['planner']);
        const gate = await readiness(line, oc);
        if (line.status === 'planned' && gate.artwork && gate.tooling && gate.material) {
          await setLineStatus(line.id, 'ready', qc, oc, req.user.name);
        }
        const jcId = await createJobCardForLine(line.id, qc, oc, req.user.name);
        const selected = Array.isArray(destinations) && destinations.length ? destinations : ['cutting'];
        if (selected.includes('print_planning')) {
          const current = await oc('SELECT queue_pos FROM job_cards WHERE id=$1', [jcId]);
          if (!current.queue_pos) {
            const pos = await oc('SELECT COALESCE(MAX(queue_pos),0)+1 AS n FROM job_cards WHERE status IN (\'open\',\'in_progress\')');
            await qc('UPDATE job_cards SET queue_pos=$1 WHERE id=$2', [pos.n, jcId]);
          }
        }
        await audit('job_card', jcId, 'workflow:job_card_destination',
          `Destinations: ${selected.join(', ')}${note ? ` — ${note}` : ''}`, qc, req.user.name);
        return { ok: true, job_card_id: jcId, message: 'Job card created and routed' };
      }

      if (action === 'reverse_job_card') {
        requireAny(req, ['planner']);
        const target = req.body.target || 'planning';
        const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1 FOR UPDATE', [line.id]);
        if (!jc) throw Object.assign(new Error('No job card exists for this line'), { status: 404 });
        const started = await oc(
          `SELECT COUNT(*)::int AS n FROM job_stages
           WHERE job_card_id=$1 AND status != 'pending'`, [jc.id]);
        if (started.n > 0) {
          throw Object.assign(new Error('Cannot reverse: this job card already has started, held, or completed stages'), { status: 409 });
        }
        await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
        await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
        const nextStatus = target === 'artwork' ? 'planned' : 'planned';
        await forceLineStatus(line.id, nextStatus, note || `Job card reversed to ${target}`, qc, oc, req.user.name);
        if (target === 'planning') {
          await qc('UPDATE order_lines SET artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0 WHERE id=$1', [line.id]);
        }
        await audit('order_line', line.id, `workflow:job_card→${target}`, note || null, qc, req.user.name);
        return { ok: true, message: `Job card reversed to ${target === 'artwork' ? 'Artwork' : 'Planning'}` };
      }

      throw Object.assign(new Error('Unknown workflow action'), { status: 400 });
    });
    res.json({ ...result, line: await linePayload(lineId) });
  } catch (e) { next(e); }
});

export default r;
