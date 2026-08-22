// Extra sheet control — when a running stage eats more sheets than planned
// (printing wastage, sheet damage), the operator raises a request. Approval
// reserves permission and stock, then re-fires a separate linked Cutting task.
// Only Cutting's final handoff consumes board FIFO and refills the target
// stage, so "approved", "cut", and "received by Printing" stay distinct.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, consumeDrawnHolds, issueWithWriteOn, nextNumber, notify, GANG_ANCHOR_LINE, outputNumberSql, stageReceipt } from '../helpers.js';
import { COMMITTED_DEMAND_SQL } from '../replenishment.js';
import { gateSubstitution, judge, rankOptions } from '../xs-board-options.js';
import { requireRole } from '../auth.js';
import { canApproveExtraSheets, notificationRecipients } from '../approvals.js';
import {
  releaseExtraSheetReservation,
  repairMissingExtraSheetReturnsQuiet,
  returnIssuedExtraToStock,
} from '../extra-sheet-returns.js';

const r = Router();
const canRequest = requireRole('production', 'planner'); // operator raises, planner may raise on his behalf
const canRun = requireRole('production');                // cutting executes / sends prepared sheets
// Approve / reject is the PLANT HEAD's call alone (users.xs_approver — the
// Plant login, operated by Dharminder). A flag lookup, not a role guard: many
// plant logins carry role=admin and must NOT inherit this decision.
const canApprove = async (req, res, next) => {
  try {
    const u = await one('SELECT xs_approver FROM users WHERE id=$1', [req.user.id]);
    if (canApproveExtraSheets(u)) return next();
    return res.status(403).json({ error: 'Only the plant head can approve or reject extra-sheet requests' });
  } catch (e) { next(e); }
};
// A decided request stops ringing every approver's bell.
const clearRequestBells = (qc, xsId) =>
  qc(`UPDATE notifications SET read_at=now() WHERE ref_table='extra_sheet_requests' AND ref_id=$1 AND read_at IS NULL`, [xsId]);

// Stages that run in sheets can receive extra board. Cartons stages can't —
// a shortage there is an FG problem, not a board problem.
const SHEET_STAGES = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'];
const ACTIVE_XS_STATUSES = ['pending', 'approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing'];
const CUTTING_QUEUE_STATUSES = ['approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing'];
const APPROVAL_REVERSE_STATUSES = ['approved', 'sent_to_cutting', 'cutting_in_progress', 'cutting_completed', 'ready_for_printing', 'issued'];
const CANCELLABLE_XS_STATUSES = ['pending', 'approved', 'sent_to_cutting'];
const SQL_LIST = xs => xs.map(s => `'${s}'`).join(',');

const cuttingRecipients = (users = [], requesterId = null) => users
  .filter(u => u.active !== 0)
  .filter(u => u.role === 'admin' || u.role === 'planner' || (
    u.role === 'production' && (u.sections == null || (Array.isArray(u.sections) && u.sections.includes('cutting')))
  ))
  .map(u => u.id)
  .filter(id => Number(id) !== Number(requesterId));

const printingRecipients = (users = [], requesterId = null) => users
  .filter(u => u.active !== 0)
  .filter(u => u.role === 'admin' || u.role === 'planner' || (
    u.role === 'production' && (u.sections == null || (Array.isArray(u.sections) && u.sections.includes('printing')))
  ))
  .map(u => u.id)
  .filter(id => Number(id) !== Number(requesterId));

async function effectiveBoardForJob(oc, jobCardId) {
  return oc(`
    SELECT COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int,
                    p.board_material_id) AS board_material_id
    FROM job_cards jc
    JOIN products p ON p.id = jc.product_id
    LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
    ${GANG_ANCHOR_LINE}
    WHERE jc.id=$1`, [jobCardId]);
}

async function plannedCutsForJob(oc, jc, materialId) {
  const pcut = await oc(`
    SELECT pj.ups::int AS cuts FROM job_board_mix pj
    WHERE pj.material_id = $1 AND pj.phase IN ('issued','plan')
      AND (pj.order_line_id = $2::int
           OR ($2::int IS NULL AND $3::int IS NOT NULL
               AND pj.order_line_id IN (SELECT pol.id FROM order_lines pol WHERE pol.gang_run_id = $3)))
    ORDER BY (pj.phase = 'issued') DESC, pj.id LIMIT 1`,
    [materialId, jc.order_line_id, jc.gang_run_id]);
  return Math.max(1, pcut?.cuts || jc.children_per_parent || 1);
}

async function issueExtraSheetsToStage({ qc, oc, x, jc, st, req, materialId, parentQty, stageQty }) {
  const printingCompleted = st.stage === 'printing' && st.status === 'completed';
  if (printingCompleted && req.body.confirm_completed_printing !== true) {
    throw Object.assign(new Error(
      'Printing is already completed for this job. Confirm that you still want to issue these extra sheets.'
    ), {
      status: 409,
      body: { code: 'PRINTING_COMPLETED_CONFIRMATION_REQUIRED', printing_completed: true },
    });
  }
  const finalMaterialId = materialId || x.board_material_id || (await effectiveBoardForJob(oc, jc.id))?.board_material_id;
  if (!finalMaterialId)
    throw Object.assign(new Error('This extra-sheet request has no board material to consume'), { status: 409 });
  const finalParentQty = Math.max(0, Math.round(+parentQty || +x.cutting_actual_qty || +x.qty || 0));
  const finalStageQty = Math.max(0, Math.round(+stageQty || +x.issued_stage_qty || (st.stage === 'cutting'
    ? finalParentQty
    : finalParentQty * Math.max(1, x.cuts_per_parent || jc.children_per_parent || 1))));
  if (finalParentQty <= 0 || finalStageQty <= 0)
    throw Object.assign(new Error('No good extra sheets were recorded by Cutting'), { status: 409 });

  const wo = await issueWithWriteOn(finalMaterialId, finalParentQty, 'job_card', jc.id,
    `Extra sheets ${x.xs_number} cut and sent to ${st.stage.replace('_', ' ')} — ${x.reason}`, qc, oc,
    { reason: x.reason, user: req.user.name, label: jc.jc_number });
  // The same rule cutting start applies, at the second place board leaves the
  // warehouse for a job. It matters most HERE: cutting start's consume is
  // material-scoped, and an XS issue may name a DIFFERENT board than cutting
  // drew, so a hold on the XS material was never inside its reach. After this
  // the job keeps no claim on sheets it has physically taken.
  //
  // A gang parent card carries no order_line_id — its members' holds are found
  // through the run, exactly as production.js does at its own draw.
  const xsHoldLines = jc.order_line_id
    ? [jc.order_line_id]
    : jc.gang_run_id
      ? (await qc('SELECT id FROM order_lines WHERE gang_run_id=$1', [jc.gang_run_id])).map(r => r.id)
      : [];
  await consumeDrawnHolds(xsHoldLines, [finalMaterialId], qc);
  await qc('UPDATE job_cards SET sheets_issued = sheets_issued + $1 WHERE id=$2', [finalParentQty, jc.id]);
  await qc(`UPDATE extra_sheet_requests
            SET status='issued', issued_by=$1, issued_at=now(),
                board_material_id=$2, issued_stage_qty=$3, stock_movement_ids=$4::jsonb
            WHERE id=$5`,
    [req.user.name, finalMaterialId, finalStageQty, JSON.stringify((wo?.movements || []).map(m => m.id)), x.id]);
  await audit('extra_sheet', x.id, 'send_to_printing',
    `${x.xs_number} — ${finalParentQty} parent sheets consumed, ${finalStageQty} sheets received by ${st.stage.replace('_', ' ')}`
    + (wo?.shortfall ? ` — ${wo.shortfall} written on, book was short` : ''),
    qc, req.user.name);
  await audit('job_card', jc.id, 'extra_sheet_received',
    `${x.xs_number} — +${finalStageQty} Extra Sheets received by ${st.stage.replace('_', ' ')}; sheets_issued ${jc.sheets_issued} → ${jc.sheets_issued + finalParentQty}`,
    qc, req.user.name);
  await audit('job_stage', st.id, 'extra_sheets',
    `+${finalStageQty} Extra Sheets received from Cutting via ${x.xs_number} (${x.reason})`, qc, req.user.name);
  await notify([x.requested_by_id], {
    kind: 'xs_received',
    title: `Extra Sheets Received — ${jc.jc_number}`,
    body: `+${finalStageQty} Extra Sheets Received from Cutting. Your available stock has been updated.`,
    link: `/floor/${st.stage}?q=${encodeURIComponent(jc.jc_number)}`,
    refTable: 'extra_sheet_requests', refId: x.id,
  }, qc);
  const users = await qc('SELECT id, role, active, sections FROM users');
  await notify(printingRecipients(users, x.requested_by_id), {
    kind: 'xs_received',
    title: `Extra Sheets Received — ${jc.jc_number}`,
    body: `+${finalStageQty} Extra Sheets Received from Cutting are now available for ${jc.jc_number}.`,
    link: `/floor/${st.stage}?q=${encodeURIComponent(jc.jc_number)}`,
    refTable: 'extra_sheet_requests', refId: x.id,
  }, qc);
  return { parentQty: finalParentQty, stageQty: finalStageQty, stock: wo };
}

// PLANNED-BOARD RULE: extra sheets are always issued against the PLANNED board
// (bm — the spec-override/product board), never a mix substitute. So when the
// job carries a board mix, the parent→child conversion uses that board's
// CHOSEN cuts (job_board_mix.ups — the count the guillotine will actually
// make, which since chosen cuts shipped can sit BELOW the natural fit stored
// in children_per_parent), else the legacy column, byte-identical. Issued rows
// win over plan rows for the same board, mirroring mixFor's precedence. An
// all-substitute mix has no row for the planned board → NULL → legacy cpp
// (the XS board is not in the mix; its cut surfaces as a loud variance at
// completion — see production.js's cutXs comment).
// Expects `jc` (job_cards) and `bm` (the planned board material) in scope.
const PLANNED_CUTS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT pj.ups::int AS cuts FROM job_board_mix pj
    WHERE pj.material_id = bm.id AND pj.phase IN ('issued','plan')
      AND (pj.order_line_id = jc.order_line_id
           OR (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL
               AND pj.order_line_id IN (SELECT pol.id FROM order_lines pol
                                        WHERE pol.gang_run_id = jc.gang_run_id)))
    ORDER BY (pj.phase = 'issued') DESC, pj.id LIMIT 1
  ) pcut ON true`;

const XS_VIEW = `
  SELECT x.*,
         jc.jc_number, jc.qty_planned, jc.sheets_issued, jc.children_per_parent, jc.status AS jc_status,
         GREATEST(jc.sheets_issued - COALESCE(xsum.qty, 0), 0) AS original_issued_qty,
         COALESCE(xsum.qty, 0) AS additional_issued_qty,
         jc.sheets_issued AS total_issued_qty,
         js.status AS stage_status, js.qty_in AS stage_qty_in, js.unit AS stage_unit,
         p.id AS product_id, p.name AS product_name, p.code AS product_code,
         ${outputNumberSql({ override: `COALESCE(ol.spec_override, gol.spec_override)->>'output_number'`, run: 'grn' })} AS output_number,
         p.party_artwork_code, p.party_item_code,
         p.child_l, p.child_w, p.ups,
         c.name AS customer_name, o.po_number,
         -- Run context: a gang parent or combined-run card serves SEVERAL
         -- sales orders, so the approver must see the run, not one customer's
         -- name presented as the whole truth.
         (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL) AS run_parent,
         grn.gang_number AS run_number, grn.kind AS run_kind,
         (SELECT COUNT(*)::int FROM order_lines rm WHERE rm.gang_run_id = jc.gang_run_id) AS run_members,
         -- THE EFFECTIVE BOARD. bm is what the job was PLANNED on; xbm is
         -- what this request will actually eat, once the plant head has
         -- approved it onto something else. board_material_id has always
         -- coalesced — every descriptive column beside it did not, so a
         -- substituted request handed Cutting a slip naming the board that was
         -- NOT consumed, and the stock strip beside it counted the wrong pile.
         -- The planned board stays on the row under its own name: "substituted
         -- FROM" is the whole story, and half of it is not worth telling.
         COALESCE(x.board_material_id, bm.id) AS board_material_id,
         COALESCE(xbm.name, bm.name) AS board_name,
         COALESCE(xbm.gsm, bm.gsm) AS board_gsm,
         COALESCE(xbm.sheet_l, bm.sheet_l) AS parent_l,
         COALESCE(xbm.sheet_w, bm.sheet_w) AS parent_w,
         COALESCE(xbm.sheets_per_packet, bm.sheets_per_packet) AS sheets_per_packet,
         COALESCE(xbm.grade, bm.grade) AS board_grade,
         bm.id AS planned_board_id, bm.name AS planned_board_name,
         bm.gsm AS planned_board_gsm, bm.grade AS planned_board_grade,
         bm.sheet_l AS planned_parent_l, bm.sheet_w AS planned_parent_w,
         (x.board_material_id IS NOT NULL AND x.board_material_id <> bm.id) AS board_substituted,
         COALESCE(sm.name, pm.name) AS printing_machine_name,
         COALESCE(x.cuts_per_parent, pcut.cuts, jc.children_per_parent, 1)::int AS effective_cuts,
         (SELECT COUNT(*)::int FROM extra_sheet_requests xr WHERE xr.job_card_id = x.job_card_id AND xr.id <= x.id) AS request_no,
         COALESCE(av.qty, 0) AS board_available,
         COALESCE(lk.qty, 0) AS board_committed,
         -- NET is what extra sheets may actually be drawn from: the shelf less
         -- the board already committed to other jobs. Never negative.
         GREATEST(COALESCE(av.qty, 0) - COALESCE(lk.qty, 0), 0) AS board_free,
         -- The soft-alarm figure for Task 12: live board_allocations holds
         -- (source='stock', the same warehouse-hold mechanism issuableFor()
         -- reads in board-allocation.js) on THIS board that belong to some
         -- OTHER order line. Narrower than board_committed above (which is
         -- every planned/ready/in_production line's whole open requirement,
         -- including this job's own) — this is only explicit holds, and only
         -- another job's. A run card carries NO order_line_id, but it is not
         -- ownerless: its holds live on its MEMBER lines, so a run is netted
         -- out through its run, not through a line it does not have. Comparing
         -- against jc.order_line_id alone called every hold "elsewhere" for a
         -- run — the same reasoning that refused OMEZYME its own 5,250-sheet
         -- freeze at cutting start. On the live plant it overstated
         -- CI-GANG-JC-0039 by its own 963 and CI-GANG-JC-0041 by its own 650.
         COALESCE(oth.qty, 0) AS board_committed_elsewhere,
         -- The planned board's CHOSEN cuts when the job carries a mix (NULL
         -- otherwise) — see PLANNED_CUTS_LATERAL: the client's parent→child
         -- conversions read this before the legacy children_per_parent.
         pcut.cuts AS planned_cuts
  FROM extra_sheet_requests x
  JOIN job_cards jc ON jc.id = x.job_card_id
  JOIN job_stages js ON js.id = x.job_stage_id
  JOIN products p ON p.id = jc.product_id
  -- LEFT + anchor: a run card (gang parent or combined run) has no line of its
  -- own — the old INNER join dropped its rows entirely, so a request raised on
  -- a running run stage vanished from this view, the approval queue and the
  -- create response, while the approver's bell had already been rung.
  LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
  ${GANG_ANCHOR_LINE}
  LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN gang_runs grn ON grn.id = jc.gang_run_id
  LEFT JOIN machines pm ON pm.id = jc.machine_id
  LEFT JOIN machines sm ON sm.id = js.machine_id
  JOIN materials bm ON bm.id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN materials xbm ON xbm.id = x.board_material_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(xi.cutting_actual_qty, xi.qty)),0)::int AS qty,
           COALESCE(SUM(COALESCE(xi.issued_stage_qty,
             CASE WHEN xi.stage='cutting' THEN COALESCE(xi.cutting_actual_qty, xi.qty)
                  ELSE COALESCE(xi.cutting_actual_qty, xi.qty) * GREATEST(COALESCE(xi.cuts_per_parent, jc.children_per_parent, 1), 1) END)),0)::int AS stage_qty
    FROM extra_sheet_requests xi
    WHERE xi.job_card_id = jc.id AND xi.status='issued') xsum ON true
  LEFT JOIN LATERAL (
    SELECT SUM(sb.qty) AS qty FROM stock_batches sb
    WHERE sb.material_id = COALESCE(x.board_material_id, bm.id) AND sb.status='available') av ON true
  -- Board already committed to jobs on this material — the SAME definition the
  -- warehouse strip reports. Extra sheets must come out of what is genuinely
  -- free, never out of board already promised: gating on gross lets one job
  -- quietly eat another's, and the shortage surfaces days later elsewhere.
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.q), 0) AS qty FROM (${COMMITTED_DEMAND_SQL}) d
    WHERE d.material_id = COALESCE(x.board_material_id, bm.id)) lk ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ba.qty) AS qty FROM board_allocations ba
    WHERE ba.material_id = COALESCE(x.board_material_id, bm.id) AND ba.status = 'active' AND ba.source = 'stock'
      AND ba.order_line_id IS DISTINCT FROM jc.order_line_id
      AND (jc.gang_run_id IS NULL
           OR ba.order_line_id NOT IN (SELECT rol.id FROM order_lines rol
                                       WHERE rol.gang_run_id = jc.gang_run_id))) oth ON true
  ${PLANNED_CUTS_LATERAL}`;

r.get('/extra-sheets', async (_req, res, next) => {
  try {
    await repairMissingExtraSheetReturnsQuiet();
    res.json(await q(`${XS_VIEW} ORDER BY (x.status IN (${SQL_LIST(ACTIVE_XS_STATUSES)})) DESC, x.id DESC`));
  } catch (e) { next(e); }
});

r.get('/extra-sheets/cutting-queue', async (_req, res, next) => {
  try {
    await repairMissingExtraSheetReturnsQuiet();
    res.json(await q(`${XS_VIEW}
      WHERE x.status IN (${SQL_LIST(CUTTING_QUEUE_STATUSES)})
      ORDER BY CASE x.status
        WHEN 'sent_to_cutting' THEN 0
        WHEN 'approved' THEN 1
        WHEN 'cutting_in_progress' THEN 2
        WHEN 'cutting_completed' THEN 3
        WHEN 'ready_for_printing' THEN 4
        ELSE 5 END,
        x.approved_at NULLS LAST, x.id`));
  } catch (e) { next(e); }
});

// Running/held sheet stages an extra-sheet request can be raised against —
// feeds the "New Request" picker on the control page.
r.get('/extra-sheets/eligible', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT js.id AS job_stage_id, js.stage, js.qty_in, js.status AS stage_status,
             jc.id AS job_card_id, jc.jc_number, jc.sheets_issued, jc.children_per_parent,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             p.party_artwork_code, p.party_item_code, c.name AS customer_name,
             (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL) AS run_parent,
             grn.gang_number AS run_number, grn.kind AS run_kind,
             (SELECT COUNT(*)::int FROM order_lines rm WHERE rm.gang_run_id = jc.gang_run_id) AS run_members,
             bm.name AS board_name, COALESCE(av.qty,0) AS board_available,
             COALESCE(lk.qty, 0) AS board_committed,
             GREATEST(COALESCE(av.qty,0) - COALESCE(lk.qty,0), 0) AS board_free,
             open_req.xs_number AS open_request,
             -- Planned board's chosen cuts under a mix — same rule as XS_VIEW.
             pcut.cuts AS planned_cuts
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      -- LEFT + anchor, same reason as XS_VIEW: a run card's stages are exactly
      -- the ones an operator runs short ON, and the INNER join hid every one
      -- of them from this picker.
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      ${GANG_ANCHOR_LINE}
      LEFT JOIN customers c ON c.id = (SELECT customer_id FROM orders WHERE id = COALESCE(ol.order_id, gol.order_id))
      LEFT JOIN gang_runs grn ON grn.id = jc.gang_run_id
      JOIN materials bm ON bm.id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
      LEFT JOIN LATERAL (
        SELECT SUM(sb.qty) AS qty FROM stock_batches sb
        WHERE sb.material_id = bm.id AND sb.status='available') av ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(d.q), 0) AS qty FROM (${COMMITTED_DEMAND_SQL}) d
        WHERE d.material_id = bm.id) lk ON true
      LEFT JOIN LATERAL (
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id = jc.id AND status IN (${SQL_LIST(ACTIVE_XS_STATUSES)}) LIMIT 1) open_req ON true
      ${PLANNED_CUTS_LATERAL}
      WHERE js.status IN ('in_progress','partially_completed','hold') AND js.unit='sheets'
        AND jc.status IN ('open','in_progress')
      ORDER BY jc.jc_number`));
  } catch (e) { next(e); }
});

// ── The warehouse pick ─────────────────────────────────────────────────────
//
// One SQL, one shape, used by BOTH the picker and the approval. The dialog
// cannot show a board on terms the transaction would not honour, because the
// transaction re-runs the same judge() over the same row it rendered.
//
// `shelf` is what is physically there. `free` is what is genuinely unpromised —
// shelf less COMMITTED_DEMAND_SQL, the identical definition the warehouse strip
// and the existing approval gate already use, so no third spelling of "free"
// enters the app. The gap between them is board booked to other jobs, and it is
// reported rather than hidden: it is exactly the stock the plant head is asking
// about when he says "it is frozen for another job but I only need fifty".
const boardCandidatesSql = `
  WITH shelf AS (
    SELECT sb.material_id, SUM(sb.qty)::int AS qty
    FROM stock_batches sb WHERE sb.status='available' GROUP BY 1
  ), committed AS (
    SELECT d.material_id, COALESCE(SUM(d.q), 0)::int AS qty
    FROM (${COMMITTED_DEMAND_SQL}) d GROUP BY 1
  )
  SELECT m.id, m.name, m.code, m.category, m.active, m.leftover,
         m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet,
         COALESCE(s.qty, 0) AS shelf,
         GREATEST(COALESCE(s.qty, 0) - COALESCE(c.qty, 0), 0) AS free
  FROM materials m
  LEFT JOIN shelf s ON s.material_id = m.id
  LEFT JOIN committed c ON c.material_id = m.id
  -- The planned board is listed even when the shelf is bare: the approver has
  -- to see WHY he is being offered alternatives before he sees them.
  WHERE m.category = 'board' AND (COALESCE(s.qty, 0) > 0 OR m.id = $1::int)`;

// Everything the substitution decision needs, resolved once.
//
// Deliberately NOT built on XS_VIEW. This runs inside the approval's own
// transaction, and XS_VIEW carries COMMITTED_DEMAND_SQL twice in laterals — a
// third and fourth execution of the plant's most expensive query, to fetch a
// cut count plannedCutsForJob already answers in one indexed read. The
// candidates query runs COMMITTED_DEMAND_SQL exactly once, grouped, for every
// board at the same time.
async function substitutionContext(oc, qc, xsId) {
  const x = await oc(`
    SELECT x.*, jc.jc_number, jc.product_id, jc.children_per_parent, jc.order_line_id, jc.gang_run_id
    FROM extra_sheet_requests x JOIN job_cards jc ON jc.id = x.job_card_id
    WHERE x.id=$1`, [xsId]);
  if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
  const eff = await effectiveBoardForJob(oc, x.job_card_id);
  const plannedId = eff?.board_material_id;
  if (!plannedId)
    throw Object.assign(new Error('This job card has no board on it — set the board on the job before approving extra sheets'), { status: 409 });
  const product = await oc(
    'SELECT id, name, code, child_l, child_w, parent_l, parent_w, ups FROM products WHERE id=$1', [x.product_id]);
  const rows = await qc(boardCandidatesSql, [plannedId]);
  const planned = rows.find(m => Number(m.id) === Number(plannedId))
    || await oc(`SELECT id, name, code, category, active, leftover, grade, gsm, sheet_l, sheet_w,
                        sheets_per_packet, 0 AS shelf, 0 AS free FROM materials WHERE id=$1`, [plannedId]);
  // The planned board's CHOSEN cuts under a mix, else the legacy cpp — the same
  // precedence XS_VIEW's planned_cuts and the create dialog already read.
  const plannedCuts = Math.max(1, await plannedCutsForJob(oc, x, plannedId));
  return { x, product, planned, rows, plannedId, plannedCuts };
}

// The plant head opens the picker. Read-only; the same flag guards it as the
// decision it feeds, because the free/committed position of every board in the
// warehouse is not a thing an operator needs off a request row.
r.get('/extra-sheets/:id/board-options', canApprove, async (req, res, next) => {
  try {
    const { x, product, planned, rows, plannedCuts } = await substitutionContext(one, q, req.params.id);
    const needed = Math.max(0, Math.round(+req.query.qty || +x.qty || 0));
    const options = rankOptions(
      rows.map(m => judge(m, { planned, product, needed, plannedCuts, stage: x.stage })),
      needed);
    res.json({
      xs_number: x.xs_number, jc_number: x.jc_number, stage: x.stage,
      requested_qty: x.qty, needed,
      planned_cuts: plannedCuts,
      planned_yield: x.stage === 'cutting' ? needed : needed * plannedCuts,
      product: {
        name: product?.name, code: product?.code,
        child_l: product?.child_l, child_w: product?.child_w,
        parent_l: product?.parent_l, parent_w: product?.parent_w,
      },
      planned_board_id: Number(planned.id),
      options,
    });
  } catch (e) { next(e); }
});

// Operator raises a request from the running stage.
r.post('/extra-sheets', canRequest, async (req, res, next) => {
  try {
    const qty = Math.round(+req.body.qty || 0);
    const reason = (req.body.reason || '').trim();
    if (qty <= 0) return res.status(400).json({ error: 'Quantity (parent sheets) must be at least 1' });
    if (!reason) return res.status(400).json({ error: 'A reason is required — why does this job need more sheets?' });

    const id = await tx(async (qc, oc) => {
      const st = await oc(`
        SELECT js.*, jc.status AS jc_status, jc.jc_number
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE js.id=$1 FOR UPDATE OF js`, [req.body.job_stage_id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.jc_status === 'closed') throw Object.assign(new Error('Job is already closed'), { status: 409 });
      if (!SHEET_STAGES.includes(st.stage))
        throw Object.assign(new Error('Extra sheets can only be requested from a sheet stage (cutting → die cutting)'), { status: 409 });
      // partially_completed counts as running: a long run that has had a day's
      // count entered sits in that status (and a resumed hold returns to it),
      // which is exactly when a stage is most likely to run short of board.
      // The eligible-stages picker has always listed those stages; this POST
      // used to reject them, so the request died at the last click.
      if (!['in_progress', 'hold', 'partially_completed'].includes(st.status))
        throw Object.assign(new Error('Extra sheets can only be requested while the stage is running or on hold'), { status: 409 });

      const open = await oc(`
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id=$1 AND status IN (${SQL_LIST(ACTIVE_XS_STATUSES)})`, [st.job_card_id]);
      if (open)
        throw Object.assign(new Error(`${open.xs_number} is already open for ${st.jc_number} — close the current extra-sheet loop before raising another request`), { status: 409 });

      const xs_number = await nextNumber('CI-XS-', 'extra_sheet_requests', 'xs_number', oc);
      const [row] = await qc(`
        INSERT INTO extra_sheet_requests (xs_number, job_card_id, job_stage_id, stage, qty, reason, note, requested_by, requested_by_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [xs_number, st.job_card_id, st.id, st.stage, qty, reason, req.body.note || null, req.user.name, req.user.id]);
      await audit('extra_sheet', row.id, 'request',
        `${xs_number} — ${qty} parent sheets for ${st.jc_number} at ${st.stage.replace('_', ' ')} (${reason})`, qc, req.user.name);
      await audit('job_card', st.job_card_id, 'extra_sheet_request', `${xs_number} — ${qty} parent sheets (${reason})`, qc, req.user.name);
      // Ring the plant head's bell — approval is his call alone, so he gets his
      // own dedicated notification the moment the request exists.
      const users = await qc('SELECT id, active, xs_approver FROM users');
      await notify(notificationRecipients(users, 'xs_approver', req.user.id), {
        kind: 'xs_request',
        title: `Extra sheets need your approval — ${xs_number}`,
        body: `${qty} parent sheets for ${st.jc_number} at ${st.stage.replace('_', ' ')} — ${reason} (by ${req.user.name})`,
        link: `/extra-sheets?xs=${row.id}`,
        refTable: 'extra_sheet_requests', refId: row.id,
      }, qc);
      return row.id;
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [id]));
  } catch (e) { next(e); }
});

// The plant head approves — may trim the quantity (audited old → new).
r.post('/extra-sheets/:id/approve', canApprove, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (x.status !== 'pending') throw Object.assign(new Error(`Only a pending request can be approved (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [x.job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed') throw Object.assign(new Error('Job is already closed'), { status: 409 });
      let qty = x.qty;
      if (req.body.qty != null) {
        qty = Math.round(+req.body.qty || 0);
        if (qty <= 0 || qty > x.qty)
          throw Object.assign(new Error(`Approved quantity must be between 1 and the requested ${x.qty}`), { status: 400 });
      }
      // ── Which board ──────────────────────────────────────────────────────
      //
      // The default has not moved: no board named, and this is byte-for-byte
      // the approval it always was, on the job's planned board. Naming one is
      // the plant head reaching into the warehouse for something else — a
      // lighter sheet of the same grade, a bigger one he can trim down, or the
      // pile that is booked to another job and only fifty sheets deep.
      //
      // The dialog already rendered a verdict for that board. It is not
      // trusted: the SAME pure judge() runs here, on rows read inside this
      // transaction, so a stale picker or a hand-rolled POST cannot approve
      // terms nobody saw. Physics (nothing on the shelf, a sheet too small to
      // yield one print sheet) refuses whatever anyone ticks. Consequence —
      // grade, caliper, size, a changed cut count, board booked elsewhere — is
      // the plant head's to accept, and every one of them costs him a reason.
      const ctx = await substitutionContext(oc, qc, x.id);
      const chosenId = req.body.board_material_id != null
        ? Math.round(+req.body.board_material_id)
        : Number(ctx.plannedId);
      const substituting = Number(chosenId) !== Number(ctx.plannedId);
      const chosen = ctx.rows.find(m => Number(m.id) === Number(chosenId))
        || (substituting
          ? await oc(`SELECT id, name, code, category, active, leftover, grade, gsm, sheet_l, sheet_w,
                             sheets_per_packet, 0 AS shelf, 0 AS free FROM materials WHERE id=$1`, [chosenId])
          : ctx.planned);
      if (!chosen)
        throw Object.assign(new Error('That board is not on the material master'), { status: 404 });

      const subReason = String(req.body.substitute_reason || '').trim();
      const plannedCuts = ctx.plannedCuts;
      const gate = gateSubstitution({
        candidate: chosen, planned: ctx.planned, product: ctx.product,
        needed: qty, plannedCuts, stage: x.stage,
        reason: subReason, override: req.body.allow_committed === true,
      });
      if (!gate.ok) {
        throw Object.assign(new Error(gate.blockers[0]), {
          status: 409,
          body: { code: 'XS_BOARD_UNAVAILABLE', blockers: gate.blockers, board: gate.verdict },
        });
      }

      // A substitute has no row in job_board_mix — nobody planned it — so its
      // cuts are geometry, and they are STORED. effective_cuts reads
      // x.cuts_per_parent first, which is what keeps every later parent →
      // print-sheet conversion (the row, the Cutting slip, the receipt) on the
      // board that is actually being cut rather than the one that was planned.
      const cuts = substituting
        ? Math.max(1, gate.verdict.cuts)
        : await plannedCutsForJob(oc, jc, chosenId);
      await qc(`UPDATE extra_sheet_requests
                SET status='sent_to_cutting', qty=$1, approved_by=$2, approved_at=now(), approval_note=$3,
                    board_material_id=$4, cuts_per_parent=$5, sent_to_cutting_at=now()
                WHERE id=$6`,
        [qty, req.user.name, req.body.note || null, chosenId, cuts, x.id]);
      await audit('extra_sheet', x.id, 'approve',
        `${x.xs_number} — ${qty} parent sheets approved${qty !== x.qty ? ` (trimmed from ${x.qty})` : ''}; re-fired to Cutting`
        + (substituting ? ` on ${chosen.name} (NOT the planned ${ctx.planned.name})` : ''), qc, req.user.name);
      if (substituting) {
        // Loud, on both books, and never a silent column change: the board a
        // job ran on is the first thing anyone asks when a carton comes back.
        const detail = `${x.xs_number} — board substituted: ${ctx.planned.name} → ${chosen.name}`
          + ` (${qty} parent sheets, ${cuts} print sheets per parent`
          + (cuts !== plannedCuts ? ` — the planned board cuts ${plannedCuts}` : '')
          + `) — ${subReason}`
          + (gate.verdict.short ? ` [TAKEN AGAINST BOARD BOOKED TO OTHER JOBS: ${gate.verdict.free} free of ${gate.verdict.shelf} on the shelf]` : '')
          + (gate.verdict.cautions.length ? ` — accepted: ${gate.verdict.cautions.map(c => c.axis).join(', ')}` : '');
        await audit('extra_sheet', x.id, 'extra_sheet_board_substituted', detail, qc, req.user.name);
        await audit('job_card', x.job_card_id, 'extra_sheet_board_substituted', detail, qc, req.user.name);
        await audit('materials', chosenId, 'extra_sheet_board_substituted',
          `${qty} parent sheets committed to ${jc.jc_number} via ${x.xs_number} in place of ${ctx.planned.name} — ${subReason}`,
          qc, req.user.name);
      }
      await audit('job_card', x.job_card_id, 'extra_sheet_refire',
        `${x.xs_number} — EXTRA SHEETS re-cut required: ${qty} parent sheets`, qc, req.user.name);
      await clearRequestBells(qc, x.id);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} approved — sent to Cutting`,
        body: `${req.user.name} approved ${qty} parent sheets${qty !== x.qty ? ` (trimmed from ${x.qty})` : ''}`
          + (substituting ? ` on ${chosen.name} instead of ${ctx.planned.name} — ${subReason}` : '')
          + `. Cutting must prepare them before Printing receives stock.`,
        link: `/extra-sheets?xs=${x.id}`,
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
      const users = await qc('SELECT id, role, active, sections FROM users');
      await notify(cuttingRecipients(users, req.user.id), {
        kind: 'xs_cutting',
        title: substituting
          ? `Extra Sheets Approved on a DIFFERENT BOARD — ${jc.jc_number}`
          : `Extra Sheets Approved — ${jc.jc_number}`,
        body: `${qty} extra parent sheets require Cutting for ${jc.jc_number}`
          + (substituting
            ? ` — take them off ${chosen.name}, NOT the planned ${ctx.planned.name}`
              + (cuts !== plannedCuts ? `; this sheet cuts ${cuts} up, not ${plannedCuts}` : '')
              + ` (${subReason})`
            : '')
          + `. Open the Extra Sheets Requirements queue.`,
        link: '/floor/cutting?xs=1',
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/reject', canApprove, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required' });
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!ACTIVE_XS_STATUSES.includes(x.status))
        throw Object.assign(new Error(`Only an open request can be rejected (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1', [x.job_card_id]);
      const materialId = x.status === 'pending'
        ? null
        : x.board_material_id || (jc ? (await effectiveBoardForJob(oc, jc.id))?.board_material_id : null);
      const releasedQty = x.status === 'pending' ? 0 : Math.max(0, Math.round(+x.qty || 0));
      await qc(`UPDATE extra_sheet_requests SET status='rejected', rejected_by=$1, rejected_at=now(), reject_reason=$2 WHERE id=$3`,
        [req.user.name, reason, x.id]);
      const releaseNote = await releaseExtraSheetReservation({
        qc, oc, x, jc, materialId, parentQty: releasedQty, reason: `rejected - ${reason}`, user: req.user.name,
      });
      await audit('extra_sheet', x.id, 'reject',
        `${x.xs_number} - ${reason}${releaseNote ? `; ${releaseNote}` : ''}`, qc, req.user.name);
      await clearRequestBells(qc, x.id);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} rejected`,
        body: `${req.user.name}: ${reason}${releaseNote ? `. ${releaseNote}.` : ''}`,
        link: `/extra-sheets?xs=${x.id}`,
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// The requester can withdraw before physical Cutting starts. The plant head can
// cancel the same pre-cutting states for an accidental request or approval;
// once Cutting has started, the dedicated Cutting / approval reversal controls
// preserve the physical transaction trail instead of silently cancelling it.
r.post('/extra-sheets/:id/cancel', canRequest, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!CANCELLABLE_XS_STATUSES.includes(x.status)) {
        throw Object.assign(new Error(
          `Only a request before Cutting starts can be cancelled (this one is ${x.status}); use Reverse for a completed step`
        ), { status: 409 });
      }
      const actor = await oc('SELECT id, xs_approver FROM users WHERE id=$1', [req.user.id]);
      const isOwner = Number(x.requested_by_id) === Number(req.user.id);
      if (!isOwner && !canApproveExtraSheets(actor)) {
        throw Object.assign(new Error('Only the requester or plant head can cancel this extra-sheet request'), { status: 403 });
      }
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1', [x.job_card_id]);
      const materialId = x.status === 'pending'
        ? null
        : x.board_material_id || (jc ? (await effectiveBoardForJob(oc, jc.id))?.board_material_id : null);
      const releasedQty = x.status === 'pending' ? 0 : Math.max(0, Math.round(+x.qty || 0));
      await qc(`UPDATE extra_sheet_requests SET status='cancelled' WHERE id=$1`, [x.id]);
      const releaseNote = await releaseExtraSheetReservation({
        qc, oc, x, jc, materialId, parentQty: releasedQty, reason: 'cancelled before Cutting', user: req.user.name,
      });
      const detail = `${x.xs_number} - cancelled before Cutting${x.status !== 'pending' ? ` from ${x.status}` : ''}${releaseNote ? `; ${releaseNote}` : ''}`;
      await audit('extra_sheet', x.id, 'cancel', detail, qc, req.user.name);
      await audit('job_card', x.job_card_id, 'extra_sheet_cancel', detail, qc, req.user.name);
      await clearRequestBells(qc, x.id); // withdrawn — stop ringing approvers / Cutting
      const users = await qc('SELECT id, role, active, sections FROM users');
      await notify([x.requested_by_id, ...cuttingRecipients(users, req.user.id)], {
        kind: 'xs_decision',
        title: `Extra Sheets Cancelled — ${jc?.jc_number || x.xs_number}`,
        body: `${req.user.name} cancelled ${x.xs_number} before Cutting started.${releaseNote ? ` ${releaseNote}.` : ''}`,
        link: `/extra-sheets?xs=${x.id}`,
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Cutting receives an operational child task. This does NOT reopen the original
// cutting stage; it starts the request's own counter.
r.post('/extra-sheets/:id/cutting/start', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!['approved', 'sent_to_cutting'].includes(x.status))
        throw Object.assign(new Error(`Only a request sent to Cutting can be started (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT jc_number FROM job_cards WHERE id=$1', [x.job_card_id]);
      await qc(`UPDATE extra_sheet_requests
                SET status='cutting_in_progress',
                    cutting_started_by=$1, cutting_started_at=now(),
                    cutting_machine_id=COALESCE($2::int, cutting_machine_id)
                WHERE id=$3`,
        [req.body.operator || req.user.name, req.body.machine_id ? +req.body.machine_id : null, x.id]);
      await audit('extra_sheet', x.id, 'cutting_start',
        `${x.xs_number} — extra sheets cutting started for ${jc?.jc_number || `job #${x.job_card_id}`}`, qc, req.user.name);
      await audit('job_card', x.job_card_id, 'extra_sheet_cutting_start',
        `${x.xs_number} — Cutting started extra-sheet counter`, qc, req.user.name);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/cutting/complete', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!['sent_to_cutting', 'approved', 'cutting_in_progress'].includes(x.status))
        throw Object.assign(new Error(`Only a Cutting task in progress can be completed (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [x.job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed') throw Object.assign(new Error('Job is already closed'), { status: 409 });
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [x.job_stage_id]);
      if (!st) throw Object.assign(new Error('Request stage not found'), { status: 404 });
      const actual = Math.round(+req.body.actual_qty || 0);
      const wastage = Math.round(+req.body.wastage_qty || 0);
      if (actual <= 0) throw Object.assign(new Error('Actual extra cutting quantity must be at least 1 parent sheet'), { status: 400 });
      if (actual > x.qty) throw Object.assign(new Error(`Cutting quantity cannot exceed the approved ${x.qty} parent sheets`), { status: 409 });
      if (wastage < 0 || wastage > actual) throw Object.assign(new Error('Cutting wastage must be between 0 and the actual parent sheets cut'), { status: 400 });
      const goodParents = Math.max(0, actual - wastage);
      const cuts = Math.max(1, x.cuts_per_parent || await plannedCutsForJob(oc, jc, x.board_material_id));
      const stageQty = st.stage === 'cutting' ? goodParents : goodParents * cuts;
      if (stageQty <= 0)
        throw Object.assign(new Error('No good extra sheets were recorded by Cutting'), { status: 409 });
      const status = goodParents < x.qty ? 'cutting_completed' : 'ready_for_printing';
      await qc(`UPDATE extra_sheet_requests
                SET status=$1, cuts_per_parent=$2,
                    cutting_completed_by=$3, cutting_completed_at=now(),
                    cutting_actual_qty=$4, cutting_wastage_qty=$5, cutting_good_qty=$6,
                    issued_stage_qty=$7,
                    cutting_machine_id=COALESCE($8::int, cutting_machine_id),
                    cutting_note=$9
                WHERE id=$10`,
        [status, cuts, req.body.operator || req.user.name, actual, wastage, goodParents, stageQty,
         req.body.machine_id ? +req.body.machine_id : null, req.body.note || null, x.id]);
      await audit('extra_sheet', x.id, goodParents < x.qty ? 'cutting_complete_partial' : 'cutting_complete',
        `${x.xs_number} — ${actual} extra parents cut, ${wastage} wastage, ${stageQty} sheets ready for ${st.stage.replace('_', ' ')}`,
        qc, req.user.name);
      await audit('job_card', jc.id, 'extra_sheet_cutting_complete',
        `${x.xs_number} — ${actual} extra parents cut; ${stageQty} sheets ready for Printing`, qc, req.user.name);
      await issueExtraSheetsToStage({
        qc, oc, x: { ...x, cuts_per_parent: cuts }, jc, st, req,
        materialId: x.board_material_id, parentQty: actual, stageQty,
      });
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/cutting/reverse', canRun, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reverse the extra cutting entry' });
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!['cutting_in_progress', 'cutting_completed', 'ready_for_printing'].includes(x.status))
        throw Object.assign(new Error(`Only a Cutting entry can be reversed from Cutting (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT jc_number FROM job_cards WHERE id=$1', [x.job_card_id]);
      if (x.status === 'cutting_in_progress') {
        await qc(`UPDATE extra_sheet_requests
                  SET status='sent_to_cutting',
                      cutting_started_by=NULL, cutting_started_at=NULL
                  WHERE id=$1`, [x.id]);
        await audit('extra_sheet', x.id, 'cutting_start_reverse',
          `${x.xs_number} — Cutting start reversed for ${jc?.jc_number || `job #${x.job_card_id}`} — ${reason}`,
          qc, req.user.name);
        await audit('job_card', x.job_card_id, 'extra_sheet_cutting_start_reverse',
          `${x.xs_number} — extra cutting start reversed — ${reason}`, qc, req.user.name);
      } else {
        const nextStatus = x.cutting_started_at ? 'cutting_in_progress' : 'sent_to_cutting';
        await qc(`UPDATE extra_sheet_requests
                  SET status=$1,
                      cutting_completed_by=NULL, cutting_completed_at=NULL,
                      cutting_actual_qty=NULL, cutting_wastage_qty=NULL, cutting_good_qty=NULL,
                      issued_stage_qty=NULL, cutting_note=NULL
                  WHERE id=$2`, [nextStatus, x.id]);
        await audit('extra_sheet', x.id, 'cutting_counter_reverse',
          `${x.xs_number} — extra cutting counter reversed for ${jc?.jc_number || `job #${x.job_card_id}`} — ${reason}`,
          qc, req.user.name);
        await audit('job_card', x.job_card_id, 'extra_sheet_cutting_counter_reverse',
          `${x.xs_number} — extra cutting counter reversed — ${reason}`, qc, req.user.name);
      }
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/send-to-printing', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!['cutting_completed', 'ready_for_printing'].includes(x.status))
        throw Object.assign(new Error(`Only a completed extra cutting task can be sent to Printing (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [x.job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed') throw Object.assign(new Error('Job is already closed'), { status: 409 });
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [x.job_stage_id]);
      if (!st) throw Object.assign(new Error('Request stage not found'), { status: 404 });
      const materialId = x.board_material_id || (await effectiveBoardForJob(oc, jc.id))?.board_material_id;
      const parentQty = Math.max(0, Math.round(+x.cutting_actual_qty || +x.qty || 0));
      const stageQty = Math.max(0, Math.round(+x.issued_stage_qty || (st.stage === 'cutting'
        ? parentQty
        : parentQty * Math.max(1, x.cuts_per_parent || jc.children_per_parent || 1))));
      await issueExtraSheetsToStage({ qc, oc, x, jc, st, req, materialId, parentQty, stageQty });
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/reverse', canApprove, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reverse an extra-sheet approval' });
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (!APPROVAL_REVERSE_STATUSES.includes(x.status))
        throw Object.assign(new Error(`Only an approved extra-sheet flow can be reversed (this one is ${x.status})`), { status: 409 });
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [x.job_card_id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [x.job_stage_id]);
      if (!st) throw Object.assign(new Error('Request stage not found'), { status: 404 });

      let returned = 0;
      let releaseNote = '';
      let stageQty = Math.max(0, Math.round(+x.issued_stage_qty || 0));
      const reservedQty = Math.max(0, Math.round(+x.qty || 0));
      const parentQty = Math.max(0, Math.round(+x.cutting_actual_qty || +x.qty || 0));
      if (x.status === 'issued') {
        const materialId = x.board_material_id || (await effectiveBoardForJob(oc, jc.id))?.board_material_id;
        if (!materialId)
          throw Object.assign(new Error('This extra-sheet request has no board material to return'), { status: 409 });
        if (!stageQty) {
          stageQty = st.stage === 'cutting'
            ? parentQty
            : parentQty * Math.max(1, x.cuts_per_parent || jc.children_per_parent || 1);
        }
        const receipt = await stageReceipt(oc, st.id);
        const withoutThisReceipt = Math.max(0, Number(receipt.received || 0) - stageQty);
        const runUse = await oc(
          `SELECT COALESCE(SUM(qty_good + qty_scrap),0)::int AS n FROM stage_runs WHERE job_stage_id=$1`,
          [st.id]);
        const consumed = Math.max(
          Number(st.qty_out || 0) + Number(st.qty_scrap || 0),
          Number(runUse?.n || 0)
        );
        if (consumed > withoutThisReceipt) {
          throw Object.assign(new Error(
            `${st.stage.replace('_', ' ')} has already consumed these extra sheets. Reverse or adjust that stage first, then reverse this approval.`
          ), { status: 409 });
        }
        returned = await returnIssuedExtraToStock({ qc, oc, x, jc, materialId, parentQty, reason, user: req.user.name });
        await qc('UPDATE job_cards SET sheets_issued=GREATEST(0, sheets_issued - $1) WHERE id=$2', [parentQty, jc.id]);
      } else {
        const materialId = x.board_material_id || (await effectiveBoardForJob(oc, jc.id))?.board_material_id;
        releaseNote = await releaseExtraSheetReservation({
          qc, oc, x, jc, materialId, parentQty: reservedQty, reason: `approval reversed - ${reason}`, user: req.user.name,
        });
      }

      await qc(`UPDATE extra_sheet_requests
                SET status='reversed', reversed_by=$1, reversed_at=now(), reverse_reason=$2
                WHERE id=$3`, [req.user.name, reason, x.id]);
      await clearRequestBells(qc, x.id);
      await audit('extra_sheet', x.id, 'approval_reverse',
        `${x.xs_number} - approval reversed from ${x.status}${returned ? `; ${returned} parent sheets returned` : ''}${releaseNote ? `; ${releaseNote}` : ''} - ${reason}`,
        qc, req.user.name);
      await audit('job_card', x.job_card_id, 'extra_sheet_approval_reverse',
        `${x.xs_number} - extra-sheet approval reversed${returned ? `; sheets_issued ${jc.sheets_issued} -> ${Math.max(0, jc.sheets_issued - parentQty)}` : ''}${releaseNote ? `; ${releaseNote}` : ''} - ${reason}`,
        qc, req.user.name);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} reversed`,
        body: `${req.user.name} reversed this extra-sheet approval: ${reason}${releaseNote ? `. ${releaseNote}.` : ''}`,
        link: `/extra-sheets?xs=${x.id}`,
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Compatibility with the old control page: "issue" is now the final physical
// handoff from Cutting to Printing, not approval itself.
r.post('/extra-sheets/:id/issue', canRun, async (req, res, next) => {
  req.url = `/extra-sheets/${req.params.id}/send-to-printing`;
  return r.handle(req, res, next);
});

export default r;
