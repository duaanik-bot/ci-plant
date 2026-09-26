// The per-job AVS switch — Planning decides whether a job's PRINTING may be
// completed only after QA has released it in Artwork Verification. The lock
// itself is avs-gate.js, checked by POST /job-stages/:id/complete.
//
// Off by default. Planning (planner; admin always passes) switches it on per job:
// on the order line for a single job, on the run for a gang or a combined run
// (stamped onto every member line too, the way the run's stock booking is — the
// sheet prints together). The press never switches its own lock: production
// logins are refused here even though they share other planning work.
//
// Switching it off once printing has started is the planned way out when the
// check cannot be done in time. It needs a reason, saved with the planner's name
// in the audit log. Once printing is completed the switch no longer applies.
import { Router } from 'express';
import { tx } from '../db.js';
import { audit, optionalText } from '../helpers.js';
import { requireRole } from '../auth.js';
import { avsSwitchProblem } from '../../../client/src/lib/avs.js';

const r = Router();
const canSwitch = requireRole('planner');

const fail = (status, message, body) => Object.assign(new Error(message), { status }, body ? { body } : {});
const toId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

// The card a line or run prints on (the newest, if a reverse re-minted it) and
// the status of its printing stage — null when no card or no printing exists yet.
async function printingOf(oc, { lineId, runId }) {
  const card = lineId
    ? await oc(`SELECT jc.id, jc.jc_number FROM job_cards jc
                 WHERE jc.order_line_id = $1 AND jc.parent_job_card_id IS NULL
                 ORDER BY jc.id DESC LIMIT 1`, [lineId])
    : await oc(`SELECT jc.id, jc.jc_number FROM job_cards jc
                 WHERE jc.gang_run_id = $1 AND jc.order_line_id IS NULL
                 ORDER BY jc.id DESC LIMIT 1`, [runId]);
  if (!card) return { card: null, printing: null };
  const st = await oc(`SELECT status FROM job_stages WHERE job_card_id = $1 AND stage = 'printing'
                        ORDER BY seq LIMIT 1`, [card.id]);
  return { card, printing: st?.status ?? null };
}

const auditText = ({ on, reason, card, printing }) => {
  const where = card ? ` (${card.jc_number}, printing ${String(printing || 'not started').replace(/_/g, ' ')})` : '';
  return on ? `AVS mandatory ON${where}` : `AVS mandatory OFF${where}${reason ? ` — reason: ${reason}` : ''}`;
};

// AVS_REASON_REQUIRED is structured: AvsSwitch.jsx asks for the reason and
// sends the switch again with it.
function refuse(problem) {
  throw fail(problem.status, problem.message, problem.code ? { code: problem.code } : undefined);
}

r.post('/avs/switch', canSwitch, async (req, res, next) => {
  try {
    const on = req.body?.on;
    const reason = optionalText(req.body?.reason);
    const out = await tx(async (qc, oc) => {
      let lineId = toId(req.body?.line_id);
      let runId = toId(req.body?.gang_run_id);
      const cardId = toId(req.body?.job_card_id);
      if (!lineId && !runId && cardId) {
        const jc = await oc('SELECT order_line_id, gang_run_id, parent_job_card_id FROM job_cards WHERE id = $1', [cardId]);
        if (!jc) throw fail(404, 'Job card not found');
        if (jc.parent_job_card_id) throw fail(409, 'This card was split off its gang after printing; AVS was decided on the gang.');
        if (jc.order_line_id) lineId = jc.order_line_id; else runId = jc.gang_run_id;
      }

      if (lineId) {
        const line = await oc('SELECT id, gang_run_id FROM order_lines WHERE id = $1 FOR UPDATE', [lineId]);
        if (!line) throw fail(404, 'Order line not found');
        if (line.gang_run_id) {
          throw fail(409, 'This job prints in a gang or combined run, so AVS is switched on the run (Gang Engine).');
        }
        const { card, printing } = await printingOf(oc, { lineId: line.id });
        const problem = avsSwitchProblem({ on, reason, printing });
        if (problem) refuse(problem);
        await qc('UPDATE order_lines SET avs_mandatory = $1 WHERE id = $2 AND gang_run_id IS NULL', [on ? 1 : 0, line.id]);
        await audit('order_line', line.id, 'avs_mandatory', auditText({ on, reason, card, printing }), qc, req.user.name);
        return { ok: true, target: 'line', avs_mandatory: on, jc_number: card?.jc_number ?? null };
      }

      if (runId) {
        const run = await oc('SELECT id, gang_number FROM gang_runs WHERE id = $1 FOR UPDATE', [runId]);
        if (!run) throw fail(404, 'Gang run not found');
        const { card, printing } = await printingOf(oc, { runId: run.id });
        const problem = avsSwitchProblem({ on, reason, printing });
        if (problem) refuse(problem);
        await qc('UPDATE gang_runs SET avs_mandatory = $1 WHERE id = $2', [on ? 1 : 0, run.id]);
        await qc('UPDATE order_lines SET avs_mandatory = $1 WHERE gang_run_id = $2', [on ? 1 : 0, run.id]);
        await audit('gang_run', run.id, 'avs_mandatory',
          `${run.gang_number}: ${auditText({ on, reason, card, printing })}`, qc, req.user.name);
        return { ok: true, target: 'run', avs_mandatory: on, jc_number: card?.jc_number ?? null };
      }

      throw fail(400, 'Name the job: line_id, gang_run_id or job_card_id.');
    });
    res.json(out);
  } catch (e) { next(e); }
});

export default r;
