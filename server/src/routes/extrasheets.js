// Extra sheet control — when a running stage eats more sheets than planned
// (printing wastage, sheet damage), the operator no longer walks to cutting
// and takes board off the pile. He raises a request; the JOB CARD ISSUER
// (planner) approves it; the WAREHOUSE issues it. Every issue consumes board
// FIFO on the ledger against the job card, bumps sheets_issued, and feeds the
// extra quantity into the running stage — so counters, caps and wastage math
// all stay true.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, consumeFifo, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canRequest = requireRole('production', 'planner'); // operator raises, planner may raise on his behalf
const canControl = requireRole('planner');               // approve / reject / issue — job card issuer + warehouse

// Stages that run in sheets can receive extra board. Cartons stages can't —
// a shortage there is an FG problem, not a board problem.
const SHEET_STAGES = ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'];

const XS_VIEW = `
  SELECT x.*,
         jc.jc_number, jc.sheets_issued, jc.children_per_parent, jc.status AS jc_status,
         js.status AS stage_status, js.qty_in AS stage_qty_in, js.unit AS stage_unit,
         p.name AS product_name, p.code AS product_code,
         c.name AS customer_name, o.po_number,
         bm.id AS board_material_id, bm.name AS board_name,
         COALESCE(av.qty, 0) AS board_available
  FROM extra_sheet_requests x
  JOIN job_cards jc ON jc.id = x.job_card_id
  JOIN job_stages js ON js.id = x.job_stage_id
  JOIN products p ON p.id = jc.product_id
  JOIN order_lines ol ON ol.id = jc.order_line_id
  JOIN orders o ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN materials bm ON bm.id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN LATERAL (
    SELECT SUM(sb.qty) AS qty FROM stock_batches sb
    WHERE sb.material_id = bm.id AND sb.status='available') av ON true`;

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
             bm.name AS board_name, COALESCE(av.qty,0) AS board_available,
             open_req.xs_number AS open_request
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN customers c ON c.id = (SELECT customer_id FROM orders WHERE id = ol.order_id)
      JOIN materials bm ON bm.id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
      LEFT JOIN LATERAL (
        SELECT SUM(sb.qty) AS qty FROM stock_batches sb
        WHERE sb.material_id = bm.id AND sb.status='available') av ON true
      LEFT JOIN LATERAL (
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id = jc.id AND status IN ('pending','approved') LIMIT 1) open_req ON true
      WHERE js.status IN ('in_progress','hold') AND js.unit='sheets'
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
      if (!['in_progress', 'hold'].includes(st.status))
        throw Object.assign(new Error('Extra sheets can only be requested while the stage is running or on hold'), { status: 409 });

      const open = await oc(`
        SELECT xs_number FROM extra_sheet_requests
        WHERE job_card_id=$1 AND status IN ('pending','approved')`, [st.job_card_id]);
      if (open)
        throw Object.assign(new Error(`${open.xs_number} is already awaiting approval/issue for ${st.jc_number} — one open request per job`), { status: 409 });

      const xs_number = await nextNumber('CI-XS-', 'extra_sheet_requests', 'xs_number', oc);
      const [row] = await qc(`
        INSERT INTO extra_sheet_requests (xs_number, job_card_id, job_stage_id, stage, qty, reason, note, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [xs_number, st.job_card_id, st.id, st.stage, qty, reason, req.body.note || null, req.user.name]);
      await audit('extra_sheet', row.id, 'request',
        `${xs_number} — ${qty} parent sheets for ${st.jc_number} at ${st.stage.replace('_', ' ')} (${reason})`, qc, req.user.name);
      await audit('job_card', st.job_card_id, 'extra_sheet_request', `${xs_number} — ${qty} parent sheets (${reason})`, qc, req.user.name);
      return row.id;
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [id]));
  } catch (e) { next(e); }
});

// Job card issuer approves — may trim the quantity (audited old → new).
r.post('/extra-sheets/:id/approve', canControl, async (req, res, next) => {
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
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/extra-sheets/:id/reject', canControl, async (req, res, next) => {
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
      if (!['in_progress', 'hold'].includes(st.status))
        throw Object.assign(new Error(`The ${st.stage.replace('_', ' ')} stage has moved on (${st.status}) — cancel this request and raise a fresh one from the running stage`), { status: 409 });

      // Same effective-board rule as the cutting issue: a job-only warehouse
      // pick (spec_override) is what the extra sheets come from too.
      const eff = await oc(`
        SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
        FROM order_lines ol JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [jc.order_line_id]);
      await consumeFifo(eff.board_material_id, x.qty, 'job_card', jc.id,
        `Extra issue ${x.xs_number} — ${x.reason}`, qc, oc);

      await qc('UPDATE job_cards SET sheets_issued = sheets_issued + $1 WHERE id=$2', [x.qty, jc.id]);
      // Cutting counts parent sheets; every later sheet stage counts child
      // sheets, so the extra parents arrive there already converted.
      const extraIn = st.stage === 'cutting' ? x.qty : x.qty * Math.max(1, jc.children_per_parent || 1);
      await qc('UPDATE job_stages SET qty_in = COALESCE(qty_in,0) + $1 WHERE id=$2', [extraIn, st.id]);

      await qc(`UPDATE extra_sheet_requests SET status='issued', issued_by=$1, issued_at=now() WHERE id=$2`,
        [req.user.name, x.id]);
      await audit('extra_sheet', x.id, 'issue',
        `${x.xs_number} — ${x.qty} parent sheets issued to ${jc.jc_number}; ${st.stage.replace('_', ' ')} receives +${extraIn}`, qc, req.user.name);
      await audit('job_card', jc.id, 'extra_sheet_issue',
        `${x.xs_number} — sheets_issued ${jc.sheets_issued} → ${jc.sheets_issued + x.qty}`, qc, req.user.name);
      await audit('job_stage', st.id, 'extra_sheets',
        `qty_in +${extraIn} via ${x.xs_number} (${x.reason})`, qc, req.user.name);
    });
    res.json(await one(`${XS_VIEW} WHERE x.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
