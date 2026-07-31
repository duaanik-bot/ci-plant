// Workflow controls — deliberate pushes and safe reversals between modules.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, clearMixPlan, createJobCardForLine, forceLineStatus, readiness, setLineStatus, unbankPlanningLeftover } from '../helpers.js';

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

// Every reverse below needs the card untouched by production. That used to be
// a dead end — "this job card already has started stages" told the planner the
// reverse was impossible, which is how a job that reached cutting could never
// get back to Planning at all. It is not impossible: production walks back one
// station at a time, so name the stage to send back first. The LAST active
// stage is the one to name — that is where the walk back begins.
async function requireAllStagesPending(oc, jcId) {
  const active = await oc(
    `SELECT stage, status FROM job_stages
     WHERE job_card_id=$1 AND status <> 'pending' ORDER BY seq DESC LIMIT 1`, [jcId]);
  if (!active) return;
  const label = s => (s || '').replace(/_/g, ' ');
  const msg = `${label(active.stage)} is ${label(active.status)} — send it back first, then reverse this`;
  throw Object.assign(new Error(msg), { status: 409, blockers: [msg] });
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
          if (!line.sheets_required) {
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
          await requireAllStagesPending(oc, jc.id);
          // Multi-board: that guard just proved every stage is still pending,
          // which is the same fact clearMixPlan's own guard checks — board has
          // definitely not left the warehouse for this card. But this card is
          // deleted outright here rather than routed through clearMixPlan, so
          // any phase='issued' rows (the board-issue confirm/override step can
          // write those well before the stage itself starts — see production.js
          // on that two-request gap) must be cleared directly, or they dangle on
          // order_line_id — job_board_mix has no job_card_id column at all — and
          // get silently inherited by whatever job card is raised next for this
          // line, the first time ITS cutting stage starts. phase='plan' rows are
          // left alone: this action never resets sheets_required, so the cut plan
          // they are frozen against is still exactly what it was.
          await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='issued'`, [line.id]);
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

      if (action === 'reverse_plan') {
        // Un-lock the plan: a Planned (or Ready) line goes all the way back to
        // "To Plan". The locked cut plan is void, so its derived figures, gang
        // membership and any unstarted job card are cleared. Material/spec edits
        // survive so the planner reopens the engine pre-filled.
        requireAny(req, ['planner']);
        if (!['planned', 'ready'].includes(line.status)) {
          throw Object.assign(new Error('Only a planned line can be reversed back to “To Plan”'), { status: 409 });
        }
        const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1 FOR UPDATE', [line.id]);
        if (jc) {
          await requireAllStagesPending(oc, jc.id);
          await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
          await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
          await audit('job_card', jc.id, 'workflow:deleted_before_start', note || 'Removed while reversing plan', qc, req.user.name);
        }
        // The plan bound this line to a gang's shared board — reversing releases
        // it, dissolving the gang if fewer than two jobs remain.
        if (line.gang_run_id) {
          await qc('UPDATE order_lines SET gang_run_id=NULL WHERE id=$1', [line.id]);
          const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
          if (left.n < 2) {
            await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [line.gang_run_id]);
            await qc('DELETE FROM gang_runs WHERE id=$1', [line.gang_run_id]);
            await audit('gang_run', line.gang_run_id, 'dissolve', 'fewer than 2 jobs left after plan reverse', qc, req.user.name);
          } else {
            await audit('gang_run', line.gang_run_id, 'remove_line', `line ${line.id} left the gang — plan reversed`, qc, req.user.name);
          }
        }
        // Take back the still-planned board offcut banked at plan-lock.
        await unbankPlanningLeftover(line.id, qc, oc, req.user.name, 'plan reversed');
        // The mix's `ups` and `covers` are frozen against the cut plan this
        // reversal is about to erase — the board, child size and wastage that
        // produced them stop existing the moment sheets_required and
        // parent_sheets_required go back to NULL below. A mix left standing
        // would balance against arithmetic nobody can any longer point to, and
        // its mirrored board_allocations hold would keep sitting `active`
        // forever with no UI left to release it — the Board Mix panel only
        // renders for a planned line. Clear it here, same as plan-save already
        // does when a re-lock arrives with no mix.
        await clearMixPlan(line.id, qc, req.user.name, 'plan reversed — cut plan voided');
        await qc(
          `UPDATE order_lines
             SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL,
                 artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0
           WHERE id=$1`, [line.id]);
        await forceLineStatus(line.id, 'pending', note || 'Plan reversed — back to To Plan', qc, oc, req.user.name);
        await audit('order_line', line.id, 'workflow:plan_reversed', note || 'Plan reversed to To Plan', qc, req.user.name);
        return { ok: true, message: 'Plan reversed — line is back in To Plan' };
      }

      if (action === 'push_to_job_card') {
        requireAny(req, ['planner']);
        const gate = await readiness(line, oc);
        if (line.status === 'planned' && gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
          await setLineStatus(line.id, 'ready', qc, oc, req.user.name);
        }
        const jcId = await createJobCardForLine(line.id, qc, oc, req.user.name);
        // An explicit empty destinations list means "create the job card and hand
        // it to the Job Card station — defer the Print Planning / Cutting routing
        // until it is finalised there". Any non-empty list routes immediately.
        const routed = Array.isArray(destinations) && destinations.length > 0;
        const selected = routed ? destinations : [];
        if (selected.includes('print_planning')) {
          const current = await oc('SELECT queue_pos FROM job_cards WHERE id=$1', [jcId]);
          if (!current.queue_pos) {
            const pos = await oc('SELECT COALESCE(MAX(queue_pos),0)+1 AS n FROM job_cards WHERE status IN (\'open\',\'in_progress\')');
            await qc('UPDATE job_cards SET queue_pos=$1 WHERE id=$2', [pos.n, jcId]);
          }
        }
        await audit('job_card', jcId, 'workflow:job_card_destination',
          routed
            ? `Destinations: ${selected.join(', ')}${note ? ` — ${note}` : ''}`
            : `Sent to Job Card station — routing deferred to finalise${note ? ` — ${note}` : ''}`,
          qc, req.user.name);
        return { ok: true, job_card_id: jcId, message: routed ? 'Job card created and routed' : 'Job card created — sent to Job Card station' };
      }

      if (action === 'reverse_job_card') {
        requireAny(req, ['planner']);
        const target = req.body.target || 'planning';
        const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1 FOR UPDATE', [line.id]);
        if (!jc) throw Object.assign(new Error('No job card exists for this line'), { status: 404 });
        await requireAllStagesPending(oc, jc.id);
        // Multi-board: identical situation and identical fix as
        // reverse_to_planning just above — every stage here is confirmed
        // pending, so board has definitely not left the warehouse, but this job
        // card is deleted outright rather than through clearMixPlan. Any
        // phase='issued' rows must be cleared here too, or they dangle on
        // order_line_id and get silently inherited by the next job card raised
        // for this line. phase='plan' rows are untouched — the cut plan itself
        // is not reset by this action.
        await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='issued'`, [line.id]);
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
