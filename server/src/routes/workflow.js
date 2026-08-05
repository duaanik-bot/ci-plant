// Workflow controls — deliberate pushes and safe reversals between modules.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, clearMixPlan, createJobCardForLine, forceLineStatus, readiness, setLineStatus, unbankPlanningLeftover, reverseChainPreview, unwindJobCardOffFloor } from '../helpers.js';

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
  // Everything the client needs goes inside `body` — the error handler spreads
  // `err.body` and NOTHING else, so a field hung on the error itself is dropped
  // before the response is written. `blockers` was already being lost that way
  // on this route (it has no hand-serialising catch of its own, unlike
  // /rollback), and `code`/`at` joined it. `at` is what lets the client turn
  // this refusal into the question it should be: "this is at printing — bring
  // the whole job back to Planning?"
  throw Object.assign(new Error(msg), {
    status: 409,
    body: {
      code: 'STAGES_ON_FLOOR',
      blockers: [msg],
      at: { stage: active.stage, status: active.status },
    },
  });
}

// The floor between a job and Planning, cleared. `force` is the planner
// answering "yes, bring it back": every started station is walked back the way
// it came, in this same transaction, instead of the request being refused.
// Without `force` the old refusal stands — now carrying `at` so the client can
// ask the question rather than just report the wall.
async function clearFloor(oc, qc, jcId, { force, reason, user }) {
  if (!force) { await requireAllStagesPending(oc, jcId); return []; }
  return unwindJobCardOffFloor(jcId, reason || 'reversed to Planning', qc, oc, user);
}

// What a reverse would have to walk back, before anyone commits to it.
r.get('/workflow/order-lines/:id/reverse-preview', async (req, res, next) => {
  try {
    const line = await one('SELECT id, gang_run_id FROM order_lines WHERE id=$1', [+req.params.id]);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    const jc = await one(
      `SELECT id FROM job_cards WHERE order_line_id=$1
       UNION ALL
       SELECT id FROM job_cards WHERE gang_run_id=$2 AND order_line_id IS NULL AND parent_job_card_id IS NULL
       LIMIT 1`, [line.id, line.gang_run_id]);
    if (!jc) return res.json({ jc_number: null, at: null, chain: [], hops: 0, gang: false, jobs: 0 });
    res.json(await reverseChainPreview(jc.id));
  } catch (e) { next(e); }
});

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
    const { action, destinations = [], note, clear_artwork = true, force = false } = req.body || {};
    const lineId = +req.params.id;
    const result = await tx(async (qc, oc) => {
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
      if (!line) throw Object.assign(new Error('Line not found'), { status: 404 });

      // A GANG member's work sits on the run's PARENT card, which carries no
      // order_line_id of its own (the GANG_ANCHOR_LINE shape). Looking only for
      // `order_line_id = line.id` found nothing for a ganged job, so every
      // reverse below silently skipped the card that actually holds the stages —
      // which is why a gang could not be reversed from Artwork or Job Cards at all.
      const cardFor = async () => await oc(
        `SELECT * FROM job_cards WHERE order_line_id=$1
         UNION ALL
         SELECT * FROM job_cards
          WHERE gang_run_id=$2 AND order_line_id IS NULL AND parent_job_card_id IS NULL
         LIMIT 1`, [line.id, line.gang_run_id]);

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
        const jc = await cardFor();
        let hops = [];
        if (jc) {
          hops = await clearFloor(oc, qc, jc.id, {
            force, user: req.user.name, reason: note || 'brought back to Planning',
          });
          // Multi-board: every stage is pending by the time we reach here — the
          // guard proved it, or clearFloor's walk-back has just made it true,
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
          await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
          await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
          await audit('job_card', jc.id,
            hops.length ? 'workflow:unwound_off_floor' : 'workflow:deleted_before_start',
            hops.length
              ? `Walked back through ${hops.map(h => h.from.replace(/_/g, ' ')).join(' → ')} — ${note || 'reversed to Planning'}`
              : (note || 'Reversed before production start'),
            qc, req.user.name);
        }

        // One physical run comes back as ONE job. A gang's stages live on the
        // parent card, so unwinding it while returning only the clicked member
        // would strand its mates reading 'in production' with no card under them.
        const affected = jc?.gang_run_id
          ? await qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [jc.gang_run_id])
          : [{ id: line.id }];
        for (const a of affected) {
          await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='issued'`, [a.id]);
          await qc(
            `UPDATE order_lines
             SET artwork_customer_ok=CASE WHEN $2 THEN 0 ELSE artwork_customer_ok END,
                 artwork_qa_ok=CASE WHEN $2 THEN 0 ELSE artwork_qa_ok END,
                 artwork_locked=CASE WHEN $2 THEN 0 ELSE artwork_locked END
             WHERE id=$1`, [a.id, clear_artwork ? 1 : 0]);
          // forceLineStatus rather than a bare UPDATE: arriving back from
          // in_production is a real transition and the timeline must show it.
          await forceLineStatus(a.id, 'planned', note || 'Reversed to Planning', qc, oc, req.user.name);
          await audit('order_line', a.id, 'workflow:back_to_planning',
            note || (clear_artwork ? 'Reversed and artwork approvals cleared' : 'Reversed, artwork approvals retained'),
            qc, req.user.name);
        }
        const many = affected.length > 1;
        return {
          ok: true, hops,
          message: hops.length
            ? `Walked back off ${hops.map(h => h.from.replace(/_/g, ' ')).join(' → ')} — ${many ? `${affected.length} jobs are` : 'the job is'} back in Planning`
            : `${many ? `${affected.length} jobs moved` : 'Line moved'} back to Planning`,
        };
      }

      if (action === 'reverse_plan') {
        // Un-lock the plan: a Planned (or Ready) line goes all the way back to
        // "To Plan". The locked cut plan is void, so its derived figures, gang
        // membership and any unstarted job card are cleared. Material/spec edits
        // survive so the planner reopens the engine pre-filled.
        requireAny(req, ['planner']);
        // `force` is the planner having answered "yes, bring it back" to a job
        // that is on the floor — the status gate is exactly the wall that answer
        // is overriding, so it only applies to an unforced call.
        if (!force && !['planned', 'ready'].includes(line.status)) {
          throw Object.assign(
            new Error('Only a planned line can be reversed back to “To Plan”'),
            { status: 409, body: { code: 'LINE_ON_FLOOR', at: { stage: null, status: line.status } } });
        }
        const jc = await cardFor();
        let hops = [];
        if (jc) {
          hops = await clearFloor(oc, qc, jc.id, {
            force, user: req.user.name, reason: note || 'plan reversed to To Plan',
          });
          await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
          await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
          await audit('job_card', jc.id,
            hops.length ? 'workflow:unwound_off_floor' : 'workflow:deleted_before_start',
            hops.length
              ? `Walked back through ${hops.map(h => h.from.replace(/_/g, ' ')).join(' → ')} — ${note || 'plan reversed'}`
              : (note || 'Removed while reversing plan'),
            qc, req.user.name);
        }
        // The plan bound this line to a gang's shared board — reversing releases
        // it, dissolving the gang if fewer than two jobs remain.
        if (line.gang_run_id) {
          await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE id=$1", [line.id]);
          const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
          if (left.n < 2) {
            await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE gang_run_id=$1", [line.gang_run_id]);
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
        const jc = await cardFor();
        if (!jc) throw Object.assign(new Error('No job card exists for this line'), { status: 404 });
        const hops = await clearFloor(oc, qc, jc.id, {
          force, user: req.user.name, reason: note || `job card reversed to ${target}`,
        });
        // Multi-board: identical situation and identical fix as
        // reverse_to_planning just above — every stage here is confirmed
        // pending, so board has definitely not left the warehouse, but this job
        // card is deleted outright rather than through clearMixPlan. Any
        // phase='issued' rows must be cleared here too, or they dangle on
        // order_line_id and get silently inherited by the next job card raised
        // for this line. phase='plan' rows are untouched — the cut plan itself
        // is not reset by this action.
        // …and for a gang, on EVERY member — the parent card being deleted here
        // is the one card all of them shared.
        await qc(`DELETE FROM job_board_mix WHERE phase='issued' AND order_line_id IN (
                    SELECT id FROM order_lines
                     WHERE id=$1 OR ($2::int IS NOT NULL AND gang_run_id=$2))`,
          [line.id, jc.gang_run_id]);
        await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
        await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
        const nextStatus = target === 'artwork' ? 'planned' : 'planned';
        // A gang card is one run over several lines — every member comes back.
        const back = jc.gang_run_id
          ? await qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [jc.gang_run_id])
          : [{ id: line.id }];
        for (const b of back) {
          await forceLineStatus(b.id, nextStatus, note || `Job card reversed to ${target}`, qc, oc, req.user.name);
          if (target === 'planning') {
            await qc('UPDATE order_lines SET artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0 WHERE id=$1', [b.id]);
          }
          await audit('order_line', b.id, `workflow:job_card→${target}`, note || null, qc, req.user.name);
        }
        return {
          ok: true, hops,
          message: `${back.length > 1 ? `${back.length} jobs` : 'Job card'} reversed to ${target === 'artwork' ? 'Artwork' : 'Planning'}`
            + (hops.length ? ` — walked back off ${hops.map(h => h.from.replace(/_/g, ' ')).join(' → ')}` : ''),
        };
      }

      throw Object.assign(new Error('Unknown workflow action'), { status: 400 });
    });
    res.json({ ...result, line: await linePayload(lineId) });
  } catch (e) { next(e); }
});

export default r;
