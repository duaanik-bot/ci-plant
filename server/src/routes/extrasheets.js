// Extra sheet control — when a running stage eats more sheets than planned
// (printing wastage, sheet damage), the operator no longer walks to cutting
// and takes board off the pile. He raises a request; the JOB CARD ISSUER
// (planner) approves it; the WAREHOUSE issues it. Every issue consumes board
// FIFO on the ledger against the job card, bumps sheets_issued, and feeds the
// extra quantity into the running stage — so counters, caps and wastage math
// all stay true.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, issueWithWriteOn, nextNumber, notify, GANG_ANCHOR_LINE } from '../helpers.js';
import { COMMITTED_DEMAND_SQL } from '../replenishment.js';
import { requireRole } from '../auth.js';
import { canApproveExtraSheets, notificationRecipients } from '../approvals.js';

const r = Router();
const canRequest = requireRole('production', 'planner'); // operator raises, planner may raise on his behalf
const canControl = requireRole('planner');               // issue — warehouse / job card issuer
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

const XS_VIEW = `
  SELECT x.*,
         jc.jc_number, jc.sheets_issued, jc.children_per_parent, jc.status AS jc_status,
         js.status AS stage_status, js.qty_in AS stage_qty_in, js.unit AS stage_unit,
         p.name AS product_name, p.code AS product_code,
         c.name AS customer_name, o.po_number,
         -- Run context: a gang parent or combined-run card serves SEVERAL
         -- sales orders, so the approver must see the run, not one customer's
         -- name presented as the whole truth.
         (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL) AS run_parent,
         grn.gang_number AS run_number, grn.kind AS run_kind,
         (SELECT COUNT(*)::int FROM order_lines rm WHERE rm.gang_run_id = jc.gang_run_id) AS run_members,
         bm.id AS board_material_id, bm.name AS board_name,
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
         -- another job's. jc.order_line_id is NULL for a gang/run parent card,
         -- so IS DISTINCT FROM counts every active hold as "elsewhere" there —
         -- correct, since a run parent owns no line of its own to net out.
         COALESCE(oth.qty, 0) AS board_committed_elsewhere
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
  JOIN materials bm ON bm.id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN LATERAL (
    SELECT SUM(sb.qty) AS qty FROM stock_batches sb
    WHERE sb.material_id = bm.id AND sb.status='available') av ON true
  -- Board already committed to jobs on this material — the SAME definition the
  -- warehouse strip reports. Extra sheets must come out of what is genuinely
  -- free, never out of board already promised: gating on gross lets one job
  -- quietly eat another's, and the shortage surfaces days later elsewhere.
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(d.q), 0) AS qty FROM (${COMMITTED_DEMAND_SQL}) d
    WHERE d.material_id = bm.id) lk ON true
  LEFT JOIN LATERAL (
    SELECT SUM(ba.qty) AS qty FROM board_allocations ba
    WHERE ba.material_id = bm.id AND ba.status = 'active' AND ba.source = 'stock'
      AND ba.order_line_id IS DISTINCT FROM jc.order_line_id) oth ON true`;

r.get('/extra-sheets', async (_req, res, next) => {
  try {
    res.json(await q(`${XS_VIEW} ORDER BY (x.status IN ('pending','approved')) DESC, x.id DESC`));
  } catch (e) { next(e); }
});

// Running/held sheet stages an extra-sheet request can be raised against —
// feeds the "New Request" picker on the control page.
r.get('/extra-sheets/eligible', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT js.id AS job_stage_id, js.stage, js.qty_in, js.status AS stage_status,
             jc.id AS job_card_id, jc.jc_number, jc.sheets_issued, jc.children_per_parent,
             p.name AS product_name, p.code AS product_code, c.name AS customer_name,
             (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL) AS run_parent,
             grn.gang_number AS run_number, grn.kind AS run_kind,
             (SELECT COUNT(*)::int FROM order_lines rm WHERE rm.gang_run_id = jc.gang_run_id) AS run_members,
             bm.name AS board_name, COALESCE(av.qty,0) AS board_available,
             COALESCE(lk.qty, 0) AS board_committed,
             GREATEST(COALESCE(av.qty,0) - COALESCE(lk.qty,0), 0) AS board_free,
             open_req.xs_number AS open_request
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
        WHERE job_card_id = jc.id AND status IN ('pending','approved') LIMIT 1) open_req ON true
      WHERE js.status IN ('in_progress','partially_completed','hold') AND js.unit='sheets'
        AND jc.status IN ('open','in_progress')
      ORDER BY jc.jc_number`));
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
        WHERE job_card_id=$1 AND status IN ('pending','approved')`, [st.job_card_id]);
      if (open)
        throw Object.assign(new Error(`${open.xs_number} is already awaiting approval/issue for ${st.jc_number} — one open request per job`), { status: 409 });

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
        link: '/extra-sheets',
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
      let qty = x.qty;
      if (req.body.qty != null) {
        qty = Math.round(+req.body.qty || 0);
        if (qty <= 0 || qty > x.qty)
          throw Object.assign(new Error(`Approved quantity must be between 1 and the requested ${x.qty}`), { status: 400 });
      }
      await qc(`UPDATE extra_sheet_requests SET status='approved', qty=$1, approved_by=$2, approved_at=now(), approval_note=$3 WHERE id=$4`,
        [qty, req.user.name, req.body.note || null, x.id]);
      await audit('extra_sheet', x.id, 'approve',
        `${x.xs_number} — ${qty} parent sheets approved${qty !== x.qty ? ` (trimmed from ${x.qty})` : ''}`, qc, req.user.name);
      await clearRequestBells(qc, x.id);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} approved — ${qty} parent sheets`,
        body: `${req.user.name} approved${qty !== x.qty ? ` (trimmed from ${x.qty})` : ''}${req.body.note ? ` — ${req.body.note}` : ''}. Warehouse issues next.`,
        link: '/extra-sheets',
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
      if (!['pending', 'approved'].includes(x.status))
        throw Object.assign(new Error(`Only a pending/approved request can be rejected (this one is ${x.status})`), { status: 409 });
      await qc(`UPDATE extra_sheet_requests SET status='rejected', rejected_by=$1, rejected_at=now(), reject_reason=$2 WHERE id=$3`,
        [req.user.name, reason, x.id]);
      await audit('extra_sheet', x.id, 'reject', `${x.xs_number} — ${reason}`, qc, req.user.name);
      await clearRequestBells(qc, x.id);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} rejected`,
        body: `${req.user.name}: ${reason}`,
        link: '/extra-sheets',
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Requester withdraws a pending request.
r.post('/extra-sheets/:id/cancel', canRequest, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (x.status !== 'pending') throw Object.assign(new Error(`Only a pending request can be cancelled (this one is ${x.status})`), { status: 409 });
      await qc(`UPDATE extra_sheet_requests SET status='cancelled' WHERE id=$1`, [x.id]);
      await audit('extra_sheet', x.id, 'cancel', x.xs_number, qc, req.user.name);
      await clearRequestBells(qc, x.id); // withdrawn — stop ringing the approver
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

// Warehouse issues the approved sheets — the only place stock actually moves.
// One transaction: FIFO consumption on the ledger (ref = job card, so it shows
// on the traveler), sheets_issued bump, and the running stage receives the
// extra quantity (cutting in parent sheets; downstream stages in child sheets).
r.post('/extra-sheets/:id/issue', canControl, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const x = await oc('SELECT * FROM extra_sheet_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!x) throw Object.assign(new Error('Request not found'), { status: 404 });
      if (x.status !== 'approved')
        throw Object.assign(new Error(x.status === 'pending'
          ? 'The job card issuer must approve this request before the warehouse can issue'
          : `Only an approved request can be issued (this one is ${x.status})`), { status: 409 });

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [x.job_card_id]);
      if (jc.status === 'closed') throw Object.assign(new Error('Job is already closed — nothing to issue against'), { status: 409 });
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [x.job_stage_id]);
      // Same three statuses the request accepts — the warehouse must be able to
      // issue against exactly the stages an operator was allowed to ask from.
      if (!['in_progress', 'hold', 'partially_completed'].includes(st.status))
        throw Object.assign(new Error(`The ${st.stage.replace('_', ' ')} stage has moved on (${st.status}) — cancel this request and raise a fresh one from the running stage`), { status: 409 });

      // Same effective-board rule as the cutting issue: a job-only warehouse
      // pick (spec_override) is what the extra sheets come from too.
      //
      // Keyed on the CARD, through the same LEFT-JOIN-plus-anchor XS_VIEW and
      // the eligible-stages picker above use. A gang parent or combined-run
      // card has order_line_id = NULL, so the old `FROM order_lines ol ...
      // WHERE ol.id=$1` matched nothing and handed back null — which the next
      // line dereferenced, turning the warehouse's Issue click into a raw 500.
      // Those are the very cards the other two queries were converted to
      // admit: the picker offers a run stage, the plant head approves it, and
      // this was where it fell over. jc.product_id (not ol.product_id) for the
      // same reason — it is the one product reference a run card carries.
      const eff = await oc(`
        SELECT COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int,
                        p.board_material_id) AS board_material_id
        FROM job_cards jc
        JOIN products p ON p.id = jc.product_id
        LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
        ${GANG_ANCHOR_LINE}
        WHERE jc.id=$1`, [jc.id]);
      // Nil today on every card in the plant, so this refuses nothing that
      // works now — it is here so the two ways this lookup can come back empty
      // (no row, or a product with no board linked) both land as a 409 the
      // warehouse can read, instead of a null reaching issueWithWriteOn and
      // writing stock on against material NULL.
      if (!eff?.board_material_id)
        throw Object.assign(new Error('This job card has no board on it — set the board on the job before issuing extra sheets'), { status: 409 });

      // Extra sheets come out of NET, never gross — gross includes board the
      // Planning Engine has locked for other jobs. That used to be a 409 here:
      // over the free figure, refused outright. Task 12 removes the refusal.
      // Anik's call, verbatim in substance: zero stock, or board committed to
      // another job, SOFT-alarms and still issues; a later GRN restocks and the
      // committed plan still stands. The reason is physical, not procedural —
      // by the time the warehouse clicks Issue, the operator has already
      // carried these sheets off the floor and the plant head has already
      // approved the quantity. Refusing the PAPERWORK at this point cannot put
      // board back on the pile; it only leaves the ERP disagreeing with the
      // plant, which is the worse failure. So gross/locked/free are still
      // computed here, but now purely as facts: passed to issueWithWriteOn
      // below (which clamps the book at nil and write-ons any shortfall rather
      // than going negative) and folded into the audit trail so the decision
      // is recorded, never silent. jc/st are already locked FOR UPDATE above,
      // so this is still a consistent snapshot, not a stale read racing a
      // concurrent change to the same job.
      const pos = await oc(`
        SELECT COALESCE(av.qty, 0) AS gross, COALESCE(lk.qty, 0) AS locked
        FROM (SELECT 1) _
        LEFT JOIN LATERAL (SELECT SUM(sb.qty) AS qty FROM stock_batches sb
          WHERE sb.material_id=$1 AND sb.status='available') av ON true
        LEFT JOIN LATERAL (SELECT COALESCE(SUM(d.q),0) AS qty
          FROM (${COMMITTED_DEMAND_SQL}) d WHERE d.material_id=$1) lk ON true`,
        [eff.board_material_id]);
      const free = Math.max(0, Number(pos.gross) - Number(pos.locked));

      const wo = await issueWithWriteOn(eff.board_material_id, x.qty, 'job_card', jc.id,
        `Extra issue ${x.xs_number} — ${x.reason}`, qc, oc,
        { reason: x.reason, user: req.user.name, label: jc.jc_number });

      await qc('UPDATE job_cards SET sheets_issued = sheets_issued + $1 WHERE id=$2', [x.qty, jc.id]);
      // Cutting counts parent sheets; every later sheet stage counts child
      // sheets, so the extra parents arrive there already converted.
      const extraIn = st.stage === 'cutting' ? x.qty : x.qty * Math.max(1, jc.children_per_parent || 1);
      // The issued row IS the record — stageReceipt() adds it into the stage's
      // received quantity and its ceiling on every read. We deliberately do NOT
      // fold it into job_stages.qty_in: a stage started ahead of its upstream
      // carries a NULL qty_in meaning "input not fixed yet, read it live", and
      // COALESCE(qty_in,0) + extras used to overwrite that with the extras
      // ALONE. That is how CI-JC-0001's printing stage came to report 100
      // sheets received while cutting had handed it 27,000.

      await qc(`UPDATE extra_sheet_requests SET status='issued', issued_by=$1, issued_at=now() WHERE id=$2`,
        [req.user.name, x.id]);
      await audit('extra_sheet', x.id, 'issue',
        `${x.xs_number} — ${x.qty} parent sheets issued to ${jc.jc_number}; ${st.stage.replace('_', ' ')} receives +${extraIn}`
        + (wo?.shortfall ? ` — ${wo.shortfall} written on, book was short` : '')
        // The refusal is gone but the fact is not: record it plainly when this
        // issue reached past what was genuinely free, so a soft alarm the
        // warehouse clicked through still leaves a trail an approver can find.
        + (x.qty > free ? ` — ate ${Math.round(x.qty - free)} sheets of board committed to other jobs` : ''),
        qc, req.user.name);
      await audit('job_card', jc.id, 'extra_sheet_issue',
        `${x.xs_number} — sheets_issued ${jc.sheets_issued} → ${jc.sheets_issued + x.qty}`, qc, req.user.name);
      await audit('job_stage', st.id, 'extra_sheets',
        `received +${extraIn} via ${x.xs_number} (${x.reason})`, qc, req.user.name);
      await notify([x.requested_by_id], {
        kind: 'xs_decision',
        title: `${x.xs_number} issued — board is on its way`,
        body: `${x.qty} parent sheets issued to ${jc.jc_number}; ${st.stage.replace('_', ' ')} receives +${extraIn}.`,
        link: '/extra-sheets',
        refTable: 'extra_sheet_requests', refId: x.id,
      }, qc);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
