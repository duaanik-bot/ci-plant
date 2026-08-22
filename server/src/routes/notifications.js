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
import { CATEGORIES, KNOWN_KINDS, OTHER, categoryOf, isCategory, kindsFor } from '../notify-categories.js';

const r = Router();

// Fresh flags for the signed-in user — the JWT deliberately carries only
// id/name/role, and these grants can change mid-session in Masters → Users.
const meFlags = req =>
  one('SELECT id, name, role, active, xs_approver, is_management FROM users WHERE id=$1', [req.user.id]);

// ── My notifications ────────────────────────────────────────────────────────
// Same envelope as the messenger's inbox — {rows, counts, next} plus the filters
// that produce them — so one client filter bar serves both centres. `unread` and
// `rows` keep their existing names and meanings, so the bell that is live in the
// plant right now reads this response unchanged.

const NOTIF_LIMIT_DEFAULT = 40;    // what the bell has always shown
const NOTIF_LIMIT_MAX = 100;

const intParam = v => { const n = +v; return Number.isInteger(n) && n > 0 ? n : null; };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOr400 = (v, name) => {
  if (v == null || v === '') return null;
  if (!ISO_DAY.test(String(v))) {
    throw Object.assign(new Error(`${name} must be a date as YYYY-MM-DD`), { status: 400 });
  }
  return String(v);
};

// "Action required" means there is still something live behind the row — not
// that the row's WORDS sound urgent. A decided, withdrawn or cancelled request
// stops being actionable the moment it is decided, which is the same reason the
// approvals desk reads pending requests instead of notification rows.
const ACTIONABLE = `(
  (n.ref_table='approval_requests' AND EXISTS (
     SELECT 1 FROM approval_requests a WHERE a.id = n.ref_id AND a.status='pending'))
  OR (n.ref_table='extra_sheet_requests' AND EXISTS (
     SELECT 1 FROM extra_sheet_requests x WHERE x.id = n.ref_id AND x.status='pending')))`;

// Ordering: unread first, then newest. Keyset pagination has to walk the WHOLE
// sort key, so the cursor is (was-it-unread, id) and not just the id — ordering
// by id alone on page two would interleave the read tail into the unread head.
const NOTIF_ORDER = '(n.read_at IS NULL) DESC, n.id DESC';
const NOTIF_KEY = '((n.read_at IS NULL), n.id)';

// Everything that narrows WHICH rows are in play; the category is not here.
// Counts are built from this same list and differ from the page only in the
// facet they describe, so a tab's number always matches the rows behind it.
function notifScope(query, add) {
  const where = [];
  const from = dayOr400(query.from, 'from');
  const to = dayOr400(query.to, 'to');
  // The plant clock wherever the database runs, as the timeline does it.
  if (from) where.push(`n.created_at >= (${add(from)}::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (to) where.push(`n.created_at < ((${add(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  if (query.unread === '1') where.push('n.read_at IS NULL');
  if (query.action === '1') where.push(ACTIONABLE);
  return where;
}

function foldCounts(rows) {
  const counts = { all: 0, unread: 0, action: 0 };
  for (const c of CATEGORIES) counts[c.id] = 0;
  for (const row of rows) {
    const n = row.n;
    counts.all += n;
    if (row.unread) counts.unread += n;
    if (row.actionable) counts.action += n;
    counts[categoryOf(row.kind)] += n;
  }
  return counts;
}

r.get('/notifications', async (req, res, next) => {
  try {
    const limit = Math.min(NOTIF_LIMIT_MAX,
      Math.max(1, parseInt(req.query.limit, 10) || NOTIF_LIMIT_DEFAULT));

    const params = [];
    const add = v => { params.push(v); return `$${params.length}`; };
    const scope = [`n.user_id = ${add(req.user.id)}`, ...notifScope(req.query, add)];

    // The badge on the bell — every unread row I have, never narrowed by the
    // filters. A count that dropped because somebody picked a date range would
    // read as "those notifications went away".
    const { n: unread } = await one(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [req.user.id]);

    // ONE grouped query for every category tab. Kinds are folded into categories
    // in JS (notify-categories.js is the single home for that map), so the SQL
    // groups by the raw kind — at most a few dozen rows however long the plant's
    // history gets.
    const counts = foldCounts(await q(`
      SELECT n.kind, (n.read_at IS NULL) AS unread, ${ACTIONABLE} AS actionable, COUNT(*)::int AS n
      FROM notifications n
      WHERE ${scope.join(' AND ')}
      GROUP BY 1, 2, 3`, [...params]));

    const where = [...scope];
    if (req.query.category != null && req.query.category !== '') {
      const category = String(req.query.category);
      if (!isCategory(category)) {
        return res.status(400).json({
          error: `Unknown category '${category.replace(/[^a-z_]/gi, '').slice(0, 20)}'`,
        });
      }
      // `other` is defined by exclusion — it is every kind no category claims,
      // including ones written after this code. Listing kinds for it would mean
      // "nothing", which is the one answer the fallback must never give.
      where.push(category === OTHER
        ? `NOT (n.kind = ANY(${add(KNOWN_KINDS)}))`
        : `n.kind = ANY(${add(kindsFor(category))})`);
    }

    const before = intParam(req.query.before);
    if (before) {
      const cur = await one(
        'SELECT id, (read_at IS NULL) AS unread FROM notifications WHERE id=$1 AND user_id=$2',
        [before, req.user.id]);
      // A cursor that no longer resolves ends the scroll instead of restarting
      // it at the top, which is what ignoring it would do.
      if (!cur) return res.json({ unread, rows: [], counts, next: null, categories: CATEGORIES });
      where.push(`${NOTIF_KEY} < (${add(cur.unread)}::boolean, ${add(cur.id)}::int)`);
    }

    // limit + 1: whether there is another page is a fact, not a guess.
    const page = await q(`
      SELECT n.*, ${ACTIONABLE} AS actionable
      FROM notifications n
      WHERE ${where.join(' AND ')}
      ORDER BY ${NOTIF_ORDER}
      LIMIT ${limit + 1}`, params);
    const rows = page.slice(0, limit).map(row => ({ ...row, category: categoryOf(row.kind) }));
    res.json({
      unread,
      rows,
      counts,
      next: page.length > limit ? rows[rows.length - 1].id : null,
      // The tab definitions travel with the data so the bell's tab row is not a
      // second copy of the category map, drifting from this one.
      categories: CATEGORIES,
    });
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

// ONE management-approval request, by id — what the Planning review card reads
// when a notification names a request. Neither list above can answer this:
// /approvals/pending holds only what is STILL pending, and /approvals/by-line
// only the LATEST ask per line, so a decided or superseded request — exactly
// what a "CI-MA-0004 approved" bell carries — is invisible to both.
//
// Readable by any signed-in user on purpose. The planner following their own
// decision bell is not management, and refusing them the row would leave that
// notification opening an empty page. Deciding stays gated below.
r.get('/approvals/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // Postgres would answer a non-numeric id with 22P02 — a 500 at the plant
    // for what is only a bad link.
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Approval id must be a number' });
    const a = await one(`
      SELECT a.*, ol.qty AS line_qty, ol.status AS line_status, ol.product_id,
             p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number, o.po_date
      FROM approval_requests a
      JOIN order_lines ol ON ol.id = a.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE a.id=$1`, [id]);
    if (!a) return res.status(404).json({ error: 'Request not found' });
    // Whether the READER may decide it, answered by the server rather than by a
    // JWT that carries only id/name/role — the client cannot work this out.
    res.json({ ...a, can_decide: canDecideManagement(await meFlags(req)) });
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
        link: `/planning?ar=${row.id}`,
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
        link: `/planning?ar=${a.id}`,
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
