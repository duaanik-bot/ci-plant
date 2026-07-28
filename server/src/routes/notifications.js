// In-app notifications + the approval inbox behind the bell.
// A notification is one row for one user (helpers.notify writes them). The
// "Approvals" section of the bell is NOT read from notifications — it lists
// live pending requests, so it can never go stale when a request is decided,
// withdrawn or cancelled somewhere else.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, notify, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';
import {
  canApproveExtraSheets, canDecideManagement, mgtDecisionError, notificationRecipients,
} from '../approvals.js';

const r = Router();

// Fresh flags for the signed-in user — the JWT deliberately carries only
// id/name/role, and these grants can change mid-session in Masters → Users.
const meFlags = req =>
  one('SELECT id, name, role, active, xs_approver, is_management FROM users WHERE id=$1', [req.user.id]);

// ── My notifications ────────────────────────────────────────────────────────
r.get('/notifications', async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT * FROM notifications WHERE user_id=$1
      ORDER BY (read_at IS NULL) DESC, id DESC LIMIT 40`, [req.user.id]);
    const { n } = await one(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    res.json({ unread: n, rows });
  } catch (e) { next(e); }
});

r.post('/notifications/read', async (req, res, next) => {
  try {
    if (req.body?.all) {
      await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);
    } else {
      const ids = (req.body?.ids || []).map(Number).filter(Number.isInteger);
      if (ids.length) {
        await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id=ANY($2::int[]) AND read_at IS NULL',
          [req.user.id, ids]);
      }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Approval inbox — live pending items for the signed-in decider ───────────
r.get('/approvals/pending', async (req, res, next) => {
  try {
    const u = await meFlags(req);
    const out = { can_xs: canApproveExtraSheets(u), can_mgt: canDecideManagement(u), xs: [], mgt: [] };
    if (out.can_xs) {
      out.xs = await q(`
        SELECT x.id, x.xs_number, x.qty, x.reason, x.requested_by, x.requested_at, x.stage,
               jc.jc_number, p.name AS product_name
        FROM extra_sheet_requests x
        JOIN job_cards jc ON jc.id = x.job_card_id
        JOIN products p ON p.id = jc.product_id
        WHERE x.status = 'pending' ORDER BY x.id DESC`);
    }
    if (out.can_mgt) {
      out.mgt = await q(`
        SELECT a.*, ol.qty AS line_qty, p.name AS product_name, c.name AS customer_name, o.po_number
        FROM approval_requests a
        JOIN order_lines ol ON ol.id = a.order_line_id
        JOIN orders o ON o.id = ol.order_id
        JOIN customers c ON c.id = o.customer_id
        JOIN products p ON p.id = ol.product_id
        WHERE a.status = 'pending' ORDER BY a.id DESC`);
    }
    res.json(out);
  } catch (e) { next(e); }
});

// Latest management-approval request per order line — the Planning queue joins
// this map onto its rows for the status chip (client-side, so the /planning
// endpoint itself stays untouched).
r.get('/approvals/by-line', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT DISTINCT ON (order_line_id)
             id, ar_number, order_line_id, note, status,
             requested_by, requested_at, decided_by, decided_at, decision_note
      FROM approval_requests ORDER BY order_line_id, id DESC`);
    res.json(Object.fromEntries(rows.map(a => [a.order_line_id, a])));
  } catch (e) { next(e); }
});

// ── Ask management (from Planning — form footer or row menu) ────────────────
r.post('/approvals', requireRole('planner'), async (req, res, next) => {
  try {
    const note = (req.body.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Say what management should look at — the note is the whole point of the ask' });
    const id = await tx(async (qc, oc) => {
      const line = await oc(`
        SELECT ol.id, ol.qty, o.po_number, p.name AS product_name, c.name AS customer_name
        FROM order_lines ol
        JOIN orders o ON o.id = ol.order_id
        JOIN customers c ON c.id = o.customer_id
        JOIN products p ON p.id = ol.product_id
        WHERE ol.id=$1 FOR UPDATE OF ol`, [req.body.order_line_id]);
      if (!line) throw Object.assign(new Error('Order line not found'), { status: 404 });
      const open = await oc(
        `SELECT ar_number FROM approval_requests WHERE order_line_id=$1 AND status='pending'`, [line.id]);
      if (open) throw Object.assign(
        new Error(`${open.ar_number} is already with management for this job — one open ask per line`), { status: 409 });

      const ar_number = await nextNumber('CI-MA-', 'approval_requests', 'ar_number', oc);
      const [row] = await qc(`
        INSERT INTO approval_requests (ar_number, kind, order_line_id, note, requested_by, requested_by_id)
        VALUES ($1,'planning',$2,$3,$4,$5) RETURNING id`,
        [ar_number, line.id, note, req.user.name, req.user.id]);
      await audit('approval', row.id, 'request', `${ar_number} — ${line.product_name} (${note})`, qc, req.user.name);
      await audit('order_line', line.id, 'mgt_approval_request', `${ar_number} — ${note}`, qc, req.user.name);

      const users = await qc('SELECT id, active, is_management FROM users');
      await notify(notificationRecipients(users, 'is_management', req.user.id), {
        kind: 'mgt_request',
        title: `Management approval asked — ${line.product_name}`,
        body: `${ar_number} · PO ${line.po_number || '—'} · ${line.customer_name} · qty ${line.qty}\n${req.user.name}: ${note}`,
        link: '/planning',
        refTable: 'approval_requests', refId: row.id,
      }, qc);
      return row.id;
    });
    res.json(await one('SELECT * FROM approval_requests WHERE id=$1', [id]));
  } catch (e) { next(e); }
});

// ── Management decides ──────────────────────────────────────────────────────
const decide = action => async (req, res, next) => {
  try {
    const u = await meFlags(req);
    if (!canDecideManagement(u)) {
      return res.status(403).json({ error: 'Only management can decide a management-approval request' });
    }
    await tx(async (qc, oc) => {
      const a = await oc('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!a) throw Object.assign(new Error('Request not found'), { status: 404 });
      const err = mgtDecisionError(a.status, action);
      if (err) throw Object.assign(new Error(err), { status: 409 });
      const status = action === 'approve' ? 'approved' : 'rejected';
      await qc(`UPDATE approval_requests SET status=$1, decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$4`,
        [status, req.user.name, (req.body?.note || '').trim() || null, a.id]);
      await audit('approval', a.id, action, `${a.ar_number}${req.body?.note ? ` — ${req.body.note}` : ''}`, qc, req.user.name);
      await audit('order_line', a.order_line_id, `mgt_approval_${status}`, `${a.ar_number} by ${req.user.name}`, qc, req.user.name);
      // The ask is answered — clear every management bell that still carries it.
      await qc(`UPDATE notifications SET read_at=now() WHERE ref_table='approval_requests' AND ref_id=$1 AND read_at IS NULL`, [a.id]);
      await notify([a.requested_by_id], {
        kind: 'mgt_decision',
        title: `${a.ar_number} ${status} by ${req.user.name}`,
        body: `${a.note}${req.body?.note ? `\n${req.user.name}: ${req.body.note}` : ''}`,
        link: '/planning',
        refTable: 'approval_requests', refId: a.id,
      }, qc);
    });
    res.json(await one('SELECT * FROM approval_requests WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
};
r.post('/approvals/:id/approve', decide('approve'));
r.post('/approvals/:id/reject', decide('reject'));

// Requester withdraws an ask that management has not decided yet.
r.post('/approvals/:id/cancel', requireRole('planner'), async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const a = await oc('SELECT * FROM approval_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!a) throw Object.assign(new Error('Request not found'), { status: 404 });
      const err = mgtDecisionError(a.status, 'cancel');
      if (err) throw Object.assign(new Error(err), { status: 409 });
      await qc(`UPDATE approval_requests SET status='cancelled' WHERE id=$1`, [a.id]);
      await audit('approval', a.id, 'cancel', a.ar_number, qc, req.user.name);
      await qc(`UPDATE notifications SET read_at=now() WHERE ref_table='approval_requests' AND ref_id=$1 AND read_at IS NULL`, [a.id]);
    });
    res.json(await one('SELECT * FROM approval_requests WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

export default r;
