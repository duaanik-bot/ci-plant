// ─── Shade Card Management API ───────────────────────────────────────────────
// The single source of truth for shade cards: identity, the approval lifecycle
// (internal QC + customer), revision history, supporting documents, Sales-Order
// links and the physical dock loop (Triage → Vault ⇄ On Press). Planning, Job
// Cards, Production and Invoicing read LIVE from here — nothing is duplicated.
// Lifecycle rules are pure functions in ../shade-flow.js (unit-tested).
import { Router } from 'express';
import multer from 'multer';
import { q, one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';
import {
  SHADE_STATUSES, APPROVAL_METHODS, transitionBlocker, labelFor, approvalClass,
  effectiveRequirement, productionEligibility, ageDays, isExpiredByAge,
  dockIssueBlocker, dockReturnBlocker, SHADE_CARD_LIFE_DAYS,
} from '../shade-flow.js';

const r = Router();
const canManage = requireRole('planner', 'qc');
const canMove = requireRole('planner', 'production', 'qc');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const EDIT_COLS = ['title', 'product_id', 'customer_id', 'print_process', 'colour_system',
  'num_colours', 'artwork_no', 'artwork_rev', 'print_reference', 'colour_details',
  'approval_requirement', 'expected_approval_date', 'creation_date', 'location', 'remarks'];

// New card numbers are CI-SC-0001…; cards migrated from the Tooling Hub keep
// their SHD- codes, so we scan only our own prefix for the next sequence.
async function nextScNumber(oc = one) {
  const row = await oc(`SELECT sc_number FROM shade_cards WHERE sc_number LIKE 'CI-SC-%'
                        ORDER BY id DESC LIMIT 1`);
  const m = row?.sc_number?.match(/(\d+)$/);
  return `CI-SC-${String(m ? +m[1] + 1 : 1).padStart(4, '0')}`;
}

async function logEvent(id, action, from, to, note, user, qc = q) {
  await qc(`INSERT INTO shade_card_events (shade_card_id, action, from_status, to_status, note, user_name)
            VALUES ($1,$2,$3,$4,$5,$6)`, [id, action, from, to, note || null, user]);
}

// One SELECT used by the list and the detail — every joined fact the dashboard
// columns need, plus the requirement config columns eligibility derives from.
const CARD_VIEW = `
  SELECT sc.*, p.name AS product_name, p.code AS product_code,
         p.shade_approval_requirement AS product_requirement,
         p.colors AS product_colours, p.colour_type AS product_colour_system,
         c.name AS customer_name, c.shade_approval_requirement AS customer_requirement,
         im.name AS issued_machine_name, ijc.jc_number AS issued_jc_number,
         sup.sc_number AS superseded_by_number,
         COALESCE(sco.orders, '[]'::json) AS orders,
         COALESCE(docs.n, 0) AS docs_count,
         pl.status AS planning_status,
         jcs.jc_number AS latest_jc_number, jcs.status AS latest_jc_status,
         le.action AS last_action, le.user_name AS last_user, le.at AS last_at
  FROM shade_cards sc
  LEFT JOIN products p ON p.id = sc.product_id
  LEFT JOIN customers c ON c.id = sc.customer_id
  LEFT JOIN machines im ON im.id = sc.issued_machine_id
  LEFT JOIN job_cards ijc ON ijc.id = sc.issued_job_card_id
  LEFT JOIN shade_cards sup ON sup.id = sc.superseded_by
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', o.id, 'po_number', o.po_number, 'status', o.status,
                                      'order_date', o.po_date) ORDER BY o.id) AS orders
    FROM shade_card_orders l JOIN orders o ON o.id = l.order_id
    WHERE l.shade_card_id = sc.id) sco ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM shade_card_docs d
                     WHERE d.shade_card_id = sc.id) docs ON true
  LEFT JOIN LATERAL (SELECT ol.status FROM order_lines ol
                     WHERE ol.product_id = sc.product_id
                     ORDER BY ol.id DESC LIMIT 1) pl ON true
  LEFT JOIN LATERAL (SELECT jc.jc_number, jc.status FROM job_cards jc
                     WHERE jc.product_id = sc.product_id
                     ORDER BY jc.id DESC LIMIT 1) jcs ON true
  LEFT JOIN LATERAL (SELECT action, user_name, at FROM shade_card_events e
                     WHERE e.shade_card_id = sc.id ORDER BY e.id DESC LIMIT 1) le ON true`;

// Age + production-eligibility decoration, one place for every response.
function decorate(card) {
  const requirement = effectiveRequirement(card,
    { shade_approval_requirement: card.product_requirement },
    { shade_approval_requirement: card.customer_requirement });
  const gate = productionEligibility(card, requirement);
  return {
    ...card,
    age_days: ageDays(card),
    expired_by_age: isExpiredByAge(card),
    approval_class: approvalClass(card),
    requirement,
    production_eligible: gate.eligible,
    production_block_hard: gate.hard,
    production_block_reason: gate.reason,
  };
}

// ── Meta for pickers ─────────────────────────────────────────────────────────
r.get('/shade-cards/meta', async (_req, res, next) => {
  try {
    res.json({
      statuses: SHADE_STATUSES,
      approval_methods: APPROVAL_METHODS,
      life_days: SHADE_CARD_LIFE_DAYS,
    });
  } catch (e) { next(e); }
});

// ── Dashboard list ───────────────────────────────────────────────────────────
r.get('/shade-cards', async (req, res, next) => {
  try {
    const wh = [];
    const params = [];
    if (!('all' in req.query)) wh.push('sc.active = 1');
    if (req.query.product_id) { params.push(+req.query.product_id); wh.push(`sc.product_id = $${params.length}`); }
    if (req.query.customer_id) { params.push(+req.query.customer_id); wh.push(`sc.customer_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); wh.push(`sc.status = $${params.length}`); }
    const rows = await q(`${CARD_VIEW} ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
                          ORDER BY sc.updated_at DESC, sc.id DESC`, params);
    res.json(rows.map(decorate));
  } catch (e) { next(e); }
});

// ── Print stations for the dock (presses + crew + running print jobs) ───────
r.get('/shade-cards/print-stations', async (_req, res, next) => {
  try {
    const machines = await q(`
      SELECT m.id, m.name, m.status,
             COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id = mo.employee_id
        WHERE mo.machine_id = m.id AND e.active = 1) ops ON true
      WHERE m.type = 'printing' AND COALESCE(m.active, 1) = 1
      ORDER BY m.name`);
    const jobs = await q(`
      SELECT js.job_card_id, jc.jc_number, p.name AS product_name,
             COALESCE(js.machine_id, jc.machine_id) AS machine_id
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      JOIN products p ON p.id = jc.product_id
      WHERE js.stage = 'printing' AND js.status IN ('pending','in_progress','partially_completed')
        AND COALESCE(js.machine_id, jc.machine_id) IS NOT NULL
      ORDER BY jc.jc_number`);
    res.json({ machines, jobs });
  } catch (e) { next(e); }
});

// ── Alerts feed ──────────────────────────────────────────────────────────────
// Computed live so it can never drift: pending approvals, overdue responses,
// cards ageing towards the 365-day cliff, and approvals whose artwork or
// product master moved on after the customer signed.
r.get('/shade-cards/alerts', async (_req, res, next) => {
  try {
    const rows = (await q(`${CARD_VIEW} WHERE sc.active = 1`)).map(decorate);
    const alerts = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const sc of rows) {
      const ref = { id: sc.id, sc_number: sc.sc_number, title: sc.title, customer_name: sc.customer_name };
      if (['draft', 'internal_review'].includes(sc.status))
        alerts.push({ ...ref, kind: 'pending_internal', severity: 'info',
          message: `${sc.sc_number} awaiting internal approval (${labelFor(sc.status)})` });
      if (['sent_to_customer', 'customer_reviewing'].includes(sc.status)) {
        const overdue = sc.expected_approval_date && sc.expected_approval_date < today;
        alerts.push({ ...ref, kind: overdue ? 'approval_overdue' : 'pending_customer',
          severity: overdue ? 'critical' : 'warn',
          message: overdue
            ? `${sc.sc_number} customer approval OVERDUE (expected ${sc.expected_approval_date})`
            : `${sc.sc_number} awaiting customer approval` });
      }
      if (sc.status === 'revised')
        alerts.push({ ...ref, kind: 'revised', severity: 'info',
          message: `${sc.sc_number} Rev ${sc.revision_no} issued — re-approval pending` });
      if (sc.expired_by_age && !['expired', 'superseded', 'archived'].includes(sc.status))
        alerts.push({ ...ref, kind: 'expired', severity: 'critical',
          message: `${sc.sc_number} is ${sc.age_days} days old — past the ${SHADE_CARD_LIFE_DAYS}-day life` });
      else if (sc.age_days != null && sc.age_days >= SHADE_CARD_LIFE_DAYS - 30 && sc.age_days < SHADE_CARD_LIFE_DAYS)
        alerts.push({ ...ref, kind: 'expiring', severity: 'warn',
          message: `${sc.sc_number} expires in ${SHADE_CARD_LIFE_DAYS - sc.age_days} days` });
    }
    // Approved cards whose artwork identity or product master changed afterwards.
    const drift = await q(`
      SELECT sc.id, sc.sc_number, sc.title, c.name AS customer_name, sc.artwork_no,
             p.party_artwork_code,
             (SELECT MAX(a.created_at) FROM audit_log a
              WHERE a.entity IN ('products','product') AND a.entity_id = sc.product_id) AS master_touched_at,
             COALESCE(sc.approval_received_date, sc.internal_approval_date) AS approved_on
      FROM shade_cards sc
      JOIN products p ON p.id = sc.product_id
      LEFT JOIN customers c ON c.id = sc.customer_id
      WHERE sc.active = 1 AND sc.status = 'customer_approved'`);
    for (const d of drift) {
      if (d.artwork_no && d.party_artwork_code && d.artwork_no !== d.party_artwork_code)
        alerts.push({ id: d.id, sc_number: d.sc_number, title: d.title, customer_name: d.customer_name,
          kind: 'artwork_changed', severity: 'warn',
          message: `${d.sc_number} approved against artwork ${d.artwork_no}, product now carries ${d.party_artwork_code}` });
      if (d.master_touched_at && d.approved_on
          && new Date(d.master_touched_at) > new Date(d.approved_on))
        alerts.push({ id: d.id, sc_number: d.sc_number, title: d.title, customer_name: d.customer_name,
          kind: 'master_changed', severity: 'warn',
          message: `${d.sc_number}: product master updated after the approval — verify the shade still matches` });
    }
    const rank = { critical: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
    res.json(alerts);
  } catch (e) { next(e); }
});

// ── Management reports ───────────────────────────────────────────────────────
r.get('/shade-cards/reports', async (_req, res, next) => {
  try {
    const rows = (await q(`${CARD_VIEW} WHERE sc.active = 1`)).map(decorate);
    const today = new Date().toISOString().slice(0, 10);
    const pendingInternal = rows.filter(x => ['draft', 'internal_review'].includes(x.status));
    const pendingCustomer = rows.filter(x => ['sent_to_customer', 'customer_reviewing'].includes(x.status));
    const overdue = pendingCustomer.filter(x => x.expected_approval_date && x.expected_approval_date < today);
    const approved = rows.filter(x => x.status === 'customer_approved' && !x.expired_by_age);
    const expired = rows.filter(x => x.expired_by_age || x.status === 'expired');
    // Approval turnaround: sent → received, per customer.
    const turns = rows.filter(x => x.sent_to_customer_date && x.approval_received_date)
      .map(x => ({ customer: x.customer_name || '—',
        days: Math.max(0, Math.round((Date.parse(x.approval_received_date) - Date.parse(x.sent_to_customer_date)) / 86400000)) }));
    const byCustomer = {};
    for (const t of turns) {
      (byCustomer[t.customer] ??= { customer: t.customer, approvals: 0, total_days: 0 });
      byCustomer[t.customer].approvals++;
      byCustomer[t.customer].total_days += t.days;
    }
    const tat = Object.values(byCustomer)
      .map(x => ({ ...x, avg_days: +(x.total_days / x.approvals).toFixed(1) }))
      .sort((a, b) => b.approvals - a.approvals);
    const revisions = await q(`
      SELECT sc.sc_number, sc.title, c.name AS customer_name, COUNT(r.id)::int AS revisions,
             MAX(r.created_at) AS last_revised
      FROM shade_card_revisions r
      JOIN shade_cards sc ON sc.id = r.shade_card_id
      LEFT JOIN customers c ON c.id = sc.customer_id
      GROUP BY sc.sc_number, sc.title, c.name ORDER BY revisions DESC`);
    // Approved and linked to work that has not reached the floor yet.
    const awaitingProduction = approved.filter(x =>
      ['pending', 'planned', 'ready'].includes(x.planning_status));
    res.json({
      kpis: {
        total: rows.length,
        pending_internal: pendingInternal.length,
        pending_customer: pendingCustomer.length,
        overdue: overdue.length,
        approved: approved.length,
        expired: expired.length,
        avg_tat_days: turns.length ? +(turns.reduce((s, t) => s + t.days, 0) / turns.length).toFixed(1) : null,
      },
      pending_internal: pendingInternal,
      pending_customer: pendingCustomer,
      overdue,
      approved,
      expired,
      awaiting_production: awaitingProduction,
      tat_by_customer: tat,
      revision_history: revisions,
    });
  } catch (e) { next(e); }
});

// ── Detail (revisions, events, docs meta, orders) ────────────────────────────
r.get('/shade-cards/:id(\\d+)', async (req, res, next) => {
  try {
    const card = await one(`${CARD_VIEW} WHERE sc.id=$1`, [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Shade card not found' });
    const [revisions, events, docs] = await Promise.all([
      q('SELECT * FROM shade_card_revisions WHERE shade_card_id=$1 ORDER BY revision_no DESC', [card.id]),
      q('SELECT * FROM shade_card_events WHERE shade_card_id=$1 ORDER BY id DESC', [card.id]),
      q(`SELECT id, revision_no, doc_type, title, file_name, mime, size_bytes, note, uploaded_by, created_at
         FROM shade_card_docs WHERE shade_card_id=$1 ORDER BY id DESC`, [card.id]),
    ]);
    res.json({ ...decorate(card), revisions, events, docs });
  } catch (e) { next(e); }
});

// ── Create ───────────────────────────────────────────────────────────────────
r.post('/shade-cards', canManage, async (req, res, next) => {
  try {
    const { title, product_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'A shade card needs a name' });
    const out = await tx(async (qc, oc) => {
      const prod = product_id ? await oc('SELECT * FROM products WHERE id=$1', [product_id]) : null;
      const customerId = req.body.customer_id || prod?.customer_id || null;
      const cust = customerId ? await oc('SELECT * FROM customers WHERE id=$1', [customerId]) : null;
      const requirement = req.body.approval_requirement
        || prod?.shade_approval_requirement || cust?.shade_approval_requirement || 'customer';
      const sc_number = await nextScNumber(oc);
      const [card] = await qc(`
        INSERT INTO shade_cards (sc_number, title, product_id, customer_id, print_process,
          colour_system, num_colours, artwork_no, artwork_rev, print_reference, colour_details,
          approval_requirement, expected_approval_date, creation_date, location, remarks, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [sc_number, title.trim(), prod?.id || null, customerId,
         req.body.print_process || null,
         req.body.colour_system || prod?.colour_type || null,
         req.body.num_colours || prod?.colors || null,
         req.body.artwork_no || prod?.party_artwork_code || null,
         req.body.artwork_rev || null,
         req.body.print_reference || null, req.body.colour_details || null,
         requirement, req.body.expected_approval_date || null,
         req.body.creation_date || new Date().toISOString().slice(0, 10),
         req.body.location || null, req.body.remarks || null, req.user.name]);
      for (const oid of [...new Set((req.body.order_ids || []).map(Number).filter(Boolean))]) {
        await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id) VALUES ($1,$2)
                  ON CONFLICT DO NOTHING`, [card.id, oid]);
      }
      await logEvent(card.id, 'created', null, 'draft', null, req.user.name, qc);
      await audit('shade_card', card.id, 'create', `${sc_number} — ${card.title}`, qc, req.user.name);
      return card;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Edit specification ───────────────────────────────────────────────────────
r.put('/shade-cards/:id(\\d+)', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      const cols = EDIT_COLS.filter(c => req.body[c] !== undefined);
      if (!cols.length) return card;
      const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      const vals = cols.map(c => (req.body[c] === '' ? null : req.body[c]));
      const [fresh] = await qc(`UPDATE shade_cards SET ${sets}, updated_at=now()
                                WHERE id=$${cols.length + 1} RETURNING *`, [...vals, card.id]);
      await logEvent(card.id, 'edited', null, null, cols.join(', '), req.user.name, qc);
      await audit('shade_card', card.id, 'update', `${card.sc_number} — ${cols.join(', ')}`, qc, req.user.name);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Status transitions (the lifecycle) ───────────────────────────────────────
// One endpoint, guarded by the pure transition map. Each target carries its own
// payload: send → dates, customer approval → method/stamp/signatory detail,
// internal approval → QC stamp + signatory. Verbal approvals demand remarks.
r.post('/shade-cards/:id(\\d+)/status', canManage, async (req, res, next) => {
  try {
    const { to } = req.body;
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = transitionBlocker(card, to);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });

      const today = new Date().toISOString().slice(0, 10);
      const sets = ['status=$1', 'updated_at=now()'];
      const vals = [to];
      const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };

      if (to === 'internal_approved') {
        set('internal_qc_stamp', req.body.internal_qc_stamp ? 1 : 0);
        set('internal_signatory', req.body.internal_signatory?.trim() || req.user.name);
        set('internal_approval_date', req.body.internal_approval_date || today);
      }
      if (to === 'sent_to_customer') {
        set('sent_to_customer_date', req.body.sent_to_customer_date || today);
        if (req.body.expected_approval_date !== undefined)
          set('expected_approval_date', req.body.expected_approval_date || null);
      }
      if (to === 'customer_approved') {
        const method = req.body.approval_method;
        if (!APPROVAL_METHODS.some(m => m.key === method))
          throw Object.assign(new Error('Pick how the approval was received'), { status: 400 });
        if (method === 'verbal' && !req.body.note?.trim())
          throw Object.assign(new Error('A verbal approval needs mandatory remarks'), { status: 400 });
        set('approval_method', method);
        set('approval_received_date', req.body.approval_received_date || today);
        set('approval_received_by', req.body.approval_received_by?.trim() || req.user.name);
        set('customer_stamp', req.body.customer_stamp ? 1 : 0);
        set('customer_signature', req.body.customer_signature ? 1 : 0);
        set('customer_contact_name', req.body.customer_contact_name || null);
        set('customer_designation', req.body.customer_designation || null);
        set('customer_company', req.body.customer_company || null);
        if (req.body.note !== undefined) set('approval_remarks', req.body.note || null);
      }
      if (to === 'superseded' && req.body.superseded_by) set('superseded_by', +req.body.superseded_by);

      vals.push(card.id);
      const [fresh] = await qc(`UPDATE shade_cards SET ${sets.join(', ')}
                                WHERE id=$${vals.length} RETURNING *`, vals);
      await logEvent(card.id, 'status', card.status, to, req.body.note, req.user.name, qc);
      await audit('shade_card', card.id, to,
        `${card.sc_number}: ${labelFor(card.status)} → ${labelFor(to)}${req.body.note ? ` — ${req.body.note}` : ''}`,
        qc, req.user.name);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── New revision ─────────────────────────────────────────────────────────────
// Freezes the current card into shade_card_revisions, bumps the revision number
// and resets both approvals — a revised shade must earn its sign-offs again.
r.post('/shade-cards/:id(\\d+)/revise', canManage, async (req, res, next) => {
  try {
    if (!req.body.reason?.trim()) return res.status(400).json({ error: 'A revision needs a reason' });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      if (['superseded', 'archived'].includes(card.status))
        throw Object.assign(new Error(`A ${labelFor(card.status)} card cannot be revised`), { status: 409 });
      await qc(`INSERT INTO shade_card_revisions
          (shade_card_id, revision_no, reason, requested_by, approved_by, snapshot, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [card.id, card.revision_no, req.body.reason.trim(), req.body.requested_by || null,
         req.body.approved_by || null, JSON.stringify(card), req.user.name]);
      const [fresh] = await qc(`
        UPDATE shade_cards SET revision_no = revision_no + 1, status='revised',
          sent_to_customer_date=NULL, expected_approval_date=NULL, approval_received_date=NULL,
          approval_received_by=NULL, approval_method=NULL, approval_remarks=NULL,
          customer_stamp=0, customer_signature=0, customer_contact_name=NULL,
          customer_designation=NULL, customer_company=NULL,
          internal_qc_stamp=0, internal_signatory=NULL, internal_approval_date=NULL,
          creation_date=$2, updated_at=now()
        WHERE id=$1 RETURNING *`,
        [card.id, req.body.creation_date || new Date().toISOString().slice(0, 10)]);
      await logEvent(card.id, 'revised', card.status, 'revised',
        `Rev ${fresh.revision_no}: ${req.body.reason.trim()}`, req.user.name, qc);
      await audit('shade_card', card.id, 'revise',
        `${card.sc_number} Rev ${fresh.revision_no} — ${req.body.reason.trim()}`, qc, req.user.name);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Sales-Order links ────────────────────────────────────────────────────────
r.post('/shade-cards/:id(\\d+)/orders', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      const order = await oc('SELECT id, po_number FROM orders WHERE id=$1', [req.body.order_id]);
      if (!order) throw Object.assign(new Error('Sales order not found'), { status: 404 });
      await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id) VALUES ($1,$2)
                ON CONFLICT DO NOTHING`, [card.id, order.id]);
      await logEvent(card.id, 'order_linked', null, null, order.po_number, req.user.name, qc);
      return { ok: true };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.delete('/shade-cards/:id(\\d+)/orders/:orderId', canManage, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      await qc('DELETE FROM shade_card_orders WHERE shade_card_id=$1 AND order_id=$2',
        [card.id, req.params.orderId]);
      await logEvent(card.id, 'order_unlinked', null, null, `Order #${req.params.orderId}`, req.user.name, qc);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Supporting documents ─────────────────────────────────────────────────────
r.post('/shade-cards/:id(\\d+)/docs', canManage, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      const [doc] = await qc(`
        INSERT INTO shade_card_docs (shade_card_id, revision_no, doc_type, title, file_name,
                                     mime, size_bytes, data, note, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id, revision_no, doc_type, title, file_name, mime, size_bytes, note, uploaded_by, created_at`,
        [card.id, card.revision_no, req.body.doc_type || 'other',
         req.body.title || req.file.originalname, req.file.originalname,
         req.file.mimetype, req.file.size, req.file.buffer,
         req.body.note || null, req.user.name]);
      await logEvent(card.id, 'doc_added', null, null,
        `${req.body.doc_type || 'other'} — ${req.file.originalname}`, req.user.name, qc);
      return doc;
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/shade-cards/docs/:docId(\\d+)', async (req, res, next) => {
  try {
    const doc = await one('SELECT * FROM shade_card_docs WHERE id=$1', [req.params.docId]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"`);
    res.send(doc.data);
  } catch (e) { next(e); }
});

r.delete('/shade-cards/docs/:docId(\\d+)', canManage, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const doc = await oc('SELECT * FROM shade_card_docs WHERE id=$1', [req.params.docId]);
      if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
      await qc('DELETE FROM shade_card_docs WHERE id=$1', [doc.id]);
      await logEvent(doc.shade_card_id, 'doc_removed', null, null, doc.file_name, req.user.name, qc);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Physical dock: Direct Issue to Print ─────────────────────────────────────
r.post('/shade-cards/:id(\\d+)/issue', canMove, async (req, res, next) => {
  try {
    const { machine_id, operator, job_card_id } = req.body;
    if (!machine_id) return res.status(400).json({ error: 'Select a target machine' });
    if (!operator?.trim()) return res.status(400).json({ error: 'Select an operator' });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = dockIssueBlocker(card);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });
      const mach = await oc('SELECT name FROM machines WHERE id=$1', [machine_id]);
      if (!mach) throw Object.assign(new Error('Machine not found'), { status: 404 });
      const [fresh] = await qc(`
        UPDATE shade_cards SET dock_zone='on_press', dock_since=now(),
          issued_machine_id=$1, issued_operator=$2, issued_job_card_id=$3,
          issued_at=now(), verified=0, verified_at=NULL, updated_at=now()
        WHERE id=$4 RETURNING *`,
        [machine_id, operator.trim(), job_card_id || null, card.id]);
      await logEvent(card.id, 'issued', card.dock_zone, 'on_press',
        `${mach.name} · ${operator.trim()}`, req.user.name, qc);
      await audit('shade_card', card.id, 'issued',
        `${card.sc_number} → ${mach.name} (${operator.trim()})`, qc, req.user.name);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Physical dock: Return to Vault ───────────────────────────────────────────
r.post('/shade-cards/:id(\\d+)/return-to-vault', canMove, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const blk = dockReturnBlocker(card);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });
      const [fresh] = await qc(`
        UPDATE shade_cards SET dock_zone='vault', dock_since=now(),
          verified=1, verified_at=now(),
          issued_machine_id=NULL, issued_operator=NULL, issued_job_card_id=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`, [card.id]);
      await logEvent(card.id, 'returned', 'on_press', 'vault',
        'Run complete — verified & stored', req.user.name, qc);
      await audit('shade_card', card.id, 'returned', `${card.sc_number} back to vault`, qc, req.user.name);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Physical dock: shelve into the vault without a press run ─────────────────
r.post('/shade-cards/:id(\\d+)/to-vault', canMove, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      if (card.dock_zone !== 'triage')
        throw Object.assign(new Error('Only a card in triage can be shelved directly'), { status: 409 });
      const [fresh] = await qc(`UPDATE shade_cards SET dock_zone='vault', dock_since=now(), updated_at=now()
                                WHERE id=$1 RETURNING *`, [card.id]);
      await logEvent(card.id, 'shelved', 'triage', 'vault', null, req.user.name, qc);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Delete (soft) ────────────────────────────────────────────────────────────
r.delete('/shade-cards/:id(\\d+)', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      if (!card.active) return card;
      const [fresh] = await qc('UPDATE shade_cards SET active=0, updated_at=now() WHERE id=$1 RETURNING *', [card.id]);
      await logEvent(card.id, 'deleted', card.status, null, null, req.user.name, qc);
      await audit('shade_card', card.id, 'delete', card.sc_number, qc, req.user.name);
      return fresh;
    });
    res.json({ ok: true, id: out.id });
  } catch (e) { next(e); }
});

export default r;
