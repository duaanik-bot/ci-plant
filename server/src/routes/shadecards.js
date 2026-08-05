// ─── Shade Card Management API ───────────────────────────────────────────────
// The single source of truth for shade cards: identity, the four-status
// approval lifecycle (draft → sent → approved/rejected), supporting documents,
// Sales-Order links and the physical custody loop (issue ⇄ return — a log, not
// a dock zone). Planning, Job Cards, Production and Invoicing read LIVE from
// here — nothing is duplicated. Lifecycle rules are pure functions in
// ../shade-flow.js (unit-tested).
import { Router } from 'express';
import multer from 'multer';
import { q, one, tx } from '../db.js';
import { audit, effectiveProduct, nextNumber } from '../helpers.js';
import { requireRole } from '../auth.js';
import {
  SHADE_STATUSES, APPROVAL_METHODS, DEPARTMENTS, RETURN_CONDITIONS,
  transitionBlocker, labelFor, printingEligibility, codeMatch,
  issueBlocker, returnBlocker, holderOf, ageDays, isExpiredByAge, ageUnknown,
  SHADE_CARD_LIFE_DAYS,
} from '../shade-flow.js';

const r = Router();
const canManage = requireRole('planner', 'qc');
const canMove = requireRole('planner', 'production', 'qc');
// 4 MB is the REAL ceiling, not a preference: production runs as a Vercel
// serverless function, which rejects request bodies past ~4.5 MB before Express
// ever sees them. The old 15 MB cap was only ever true on a laptop — in the
// plant a 9 MB scan of a signed approval died at the platform edge with an
// opaque 413 instead of a message anyone could act on. (chat-rules.js carries
// the same ceiling for messenger attachments, for the same reason.)
export const DOC_MAX_BYTES = 4 * 1024 * 1024;
const DOC_TOO_BIG = 'Documents are capped at 4 MB — compress the scan and try again';

// defParamCharset: browsers send multipart filenames as raw UTF-8, but busboy
// decodes latin1 by default, which turns a Hindi or emoji filename from a plant
// phone into mojibake in the document list and in its download name.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX_BYTES },
  defParamCharset: 'utf8',
});
// multer's LIMIT_FILE_SIZE is a plain Error carrying no .status, so without
// this wrapper an oversized file is logged and answered as a 500 "Server error".
const uploadOne = (req, res, next) => upload.single('file')(req, res, err => {
  if (err) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? DOC_TOO_BIG : err.message });
  }
  next();
});

// product_id, customer_id and order_line_id are deliberately NOT editable here —
// they are the card's identity, and everything auto-populated (board, print
// specs, artwork/output code) resolves through them. Changing one would
// silently re-point a customer-approved card at different work.
const EDIT_COLS = ['title', 'colour_system', 'num_colours', 'print_process',
  'artwork_no', 'artwork_rev', 'output_no', 'print_reference', 'colour_details',
  'expected_approval_date', 'creation_date', 'location', 'remarks'];

// New card numbers are CI-SC-0001…; cards migrated from the Tooling Hub keep
// their SHD- codes, so we scan only our own prefix for the next sequence.
// This used to hand-roll the scan and took the NEWEST row rather than the
// highest, so one card numbered `CI-SC-2026-A` would have restarted the
// sequence at 0001 and jammed every later card on the unique index. It now
// shares the tested minter.
async function nextScNumber(oc = one) {
  return nextNumber('CI-SC-', 'shade_cards', 'sc_number', oc);
}

async function logEvent(id, action, from, to, note, user, qc = q) {
  await qc(`INSERT INTO shade_card_events (shade_card_id, action, from_status, to_status, note, user_name)
            VALUES ($1,$2,$3,$4,$5,$6)`, [id, action, from, to, note || null, user]);
}

// The shade card's current holder, if any — shared by /issue and /return so
// both agree on what "the open row" means.
const openIssueFor = (id, oc = one) =>
  oc('SELECT * FROM shade_card_issues WHERE shade_card_id=$1 AND returned_at IS NULL', [id]);

// One SELECT for the list and the detail. Every joined fact the dashboard needs,
// plus the order line the card inherits from and the open custody row.
const CARD_VIEW = `
  SELECT sc.*, p.name AS product_name, p.code AS product_code,
         p.party_artwork_code AS product_artwork_code,
         p.output_number AS product_output_number,
         p.board_name, p.gsm, p.colors AS product_colours,
         p.colour_type AS product_colour_system, p.coating,
         c.name AS customer_name,
         ol.qty AS order_qty, ol.status AS line_status,
         o.id AS order_id, o.po_number, o.po_date,
         COALESCE(sco.orders, '[]'::json) AS orders,
         COALESCE(docs.n, 0) AS docs_count,
         COALESCE(iss.n, 0)  AS issue_count,
         open_i.id AS open_issue_id, open_i.issued_to, open_i.department,
         open_i.issued_at, open_i.issued_by,
         im.name AS issued_machine_name, ijc.jc_number AS issued_jc_number,
         last_r.returned_at AS last_returned_at, last_r.condition AS last_condition,
         jcs.jc_number AS latest_jc_number, jcs.status AS latest_jc_status,
         pl.status AS planning_status,
         work.work_tier, work.work_jc_number, work.work_queue_pos,
         work.work_press_name, work.work_po_number, work.work_line_status
  FROM shade_cards sc
  LEFT JOIN products p ON p.id = sc.product_id
  LEFT JOIN customers c ON c.id = sc.customer_id
  LEFT JOIN order_lines ol ON ol.id = sc.order_line_id
  LEFT JOIN orders o ON o.id = ol.order_id
  LEFT JOIN LATERAL (
    SELECT * FROM shade_card_issues i
    WHERE i.shade_card_id = sc.id AND i.returned_at IS NULL LIMIT 1) open_i ON true
  LEFT JOIN machines im ON im.id = open_i.machine_id
  LEFT JOIN job_cards ijc ON ijc.id = open_i.job_card_id
  LEFT JOIN LATERAL (
    SELECT returned_at, condition FROM shade_card_issues i
    WHERE i.shade_card_id = sc.id AND i.returned_at IS NOT NULL
    ORDER BY i.returned_at DESC LIMIT 1) last_r ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object('id', o2.id, 'po_number', o2.po_number,
                                      'status', o2.status, 'order_date', o2.po_date)
                    ORDER BY o2.id) AS orders
    FROM shade_card_orders l JOIN orders o2 ON o2.id = l.order_id
    WHERE l.shade_card_id = sc.id) sco ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM shade_card_docs d
                     WHERE d.shade_card_id = sc.id) docs ON true
  LEFT JOIN LATERAL (SELECT COUNT(*)::int AS n FROM shade_card_issues i
                     WHERE i.shade_card_id = sc.id) iss ON true
  LEFT JOIN LATERAL (SELECT jc.jc_number, jc.status FROM job_cards jc
                     WHERE jc.product_id = sc.product_id
                     ORDER BY jc.id DESC LIMIT 1) jcs ON true
  -- /reports' awaiting_production bucket needs the SALES-ORDER status, not the
  -- card's own line_status (NULL for all 599 legacy cards with no order_line_id
  -- — exactly the cards that bucket exists to surface). ol2 because ol above is
  -- already the card's own order-line join.
  LEFT JOIN LATERAL (SELECT ol2.status FROM order_lines ol2
                     WHERE ol2.product_id = sc.product_id
                     ORDER BY ol2.id DESC LIMIT 1) pl ON true
  -- ── "Should be issued" worklist ────────────────────────────────────────────
  -- The most urgent live work waiting on this card's product, and how far down
  -- the print plan it has travelled. Print Planning is what sets
  -- job_cards.machine_id, so the three tiers are already facts the plant keeps:
  --   1  a job card WITH a press — scheduled on a printing line, running next
  --   2  a job card WITHOUT one  — sitting in Print Planning triage
  --   3  an open sales order line with no job card raised yet
  -- Ordering by tier and then queue_pos means the first row is always the most
  -- urgent thing the floor is waiting on, which is the order a storeman should
  -- hand the cards out in. Only ONE row per card: the worklist answers "how
  -- soon is this needed", not "how many jobs want it".
  LEFT JOIN LATERAL (
    SELECT CASE WHEN jc.machine_id IS NOT NULL THEN 1
                WHEN jc.id IS NOT NULL         THEN 2
                ELSE 3 END                          AS work_tier,
           jc.jc_number AS work_jc_number, jc.queue_pos AS work_queue_pos,
           wm.name AS work_press_name, wo.po_number AS work_po_number,
           wol.status AS work_line_status
    FROM order_lines wol
    JOIN orders wo ON wo.id = wol.order_id
    LEFT JOIN job_cards jc ON jc.order_line_id = wol.id AND jc.status <> 'closed'
    LEFT JOIN machines wm ON wm.id = jc.machine_id
    WHERE wol.product_id = sc.product_id
      AND wol.status IN ('pending','planned','ready','in_production')
    ORDER BY (CASE WHEN jc.machine_id IS NOT NULL THEN 1
                   WHEN jc.id IS NOT NULL         THEN 2
                   ELSE 3 END),
             jc.queue_pos NULLS LAST, wol.id
    LIMIT 1) work ON true`;

// Age, printing verdict and code match, in one place for every response.
function decorate(card) {
  const gate = printingEligibility(card);
  const match = codeMatch(card, {
    party_artwork_code: card.product_artwork_code,
    output_number: card.product_output_number,
  });
  const open = card.open_issue_id
    ? { issued_to: card.issued_to, department: card.department, issued_at: card.issued_at }
    : null;
  return {
    ...card,
    age_days: ageDays(card),
    expired_by_age: isExpiredByAge(card),
    // Undatable is not young. expired_by_age is false for a card made yesterday
    // AND for one nobody can date, so without this flag the register showed an
    // undatable card as comfortably in-date.
    age_unknown: ageUnknown(card),
    printing_eligible: gate.eligible,
    printing_block_reason: gate.reason,
    code_ok: match.ok,
    code_mismatches: match.mismatches,
    holder: holderOf(open),
    with_printing: !!card.open_issue_id,
    // Should this card be walked to the floor right now? Approved, in date,
    // nobody holding it, and live work waiting on it. Deliberately NOT
    // "approved and not issued" — a card with no order behind it is not
    // pending, it is simply idle, and listing it as work to do would bury the
    // handful that genuinely are.
    to_issue: card.status === 'approved' && !card.open_issue_id
              && !isExpiredByAge(card) && card.work_tier != null,
    work_tier: card.work_tier ?? null,
  };
}

// The three bands the To Issue worklist groups by, most urgent first. Exported
// so the client names them identically — a band whose label drifts between the
// two ends is a band nobody trusts.
export const WORK_TIERS = [
  { tier: 1, key: 'on_press',  label: 'Scheduled on a press',   hint: 'Print Planning has put these on a line — issue first' },
  { tier: 2, key: 'triage',    label: 'In Print Planning triage', hint: 'Job card raised, waiting for a press' },
  { tier: 3, key: 'order_only', label: 'Sales order open',       hint: 'Ordered, no job card raised yet' },
];

// ── Meta for pickers ─────────────────────────────────────────────────────────
r.get('/shade-cards/meta', async (_req, res, next) => {
  try {
    res.json({
      statuses: SHADE_STATUSES,
      approval_methods: APPROVAL_METHODS,
      departments: DEPARTMENTS,
      return_conditions: RETURN_CONDITIONS,
      work_tiers: WORK_TIERS,
      life_days: SHADE_CARD_LIFE_DAYS,
    });
  } catch (e) { next(e); }
});

// ── Sales-Order prefill ──────────────────────────────────────────────────────
// Everything the create form shows read-only, resolved from ONE order line.
// effectiveProduct applies the line's job-only spec_override exactly the way
// Planning, Production and the Job Card do, so a card created against an
// overridden line inherits the override and not the stale master.
r.get('/shade-cards/prefill/:lineId(\\d+)', async (req, res, next) => {
  try {
    const line = await one(`
      SELECT ol.id AS order_line_id, ol.qty, ol.spec_override, ol.product_id,
             o.id AS order_id, o.po_number, o.po_date,
             cu.id AS customer_id, cu.name AS customer_name
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE ol.id = $1`, [req.params.lineId]);
    if (!line) return res.status(404).json({ error: 'Sales order line not found' });
    const product = await one('SELECT * FROM products WHERE id=$1', [line.product_id]);
    const p = effectiveProduct(product, line);
    res.json({
      order_line_id: line.order_line_id,
      order_id: line.order_id,
      po_number: line.po_number,
      po_date: line.po_date,
      customer_id: line.customer_id,
      customer_name: line.customer_name,
      product_id: line.product_id,
      product_name: p?.name || null,
      product_code: p?.code || null,
      description: [p?.name, p?.party_item_code].filter(Boolean).join(' · ') || null,
      order_qty: line.qty,
      // NOTE: there is deliberately no `revision` here. The ERP has no artwork
      // revision column anywhere — the only artwork_rev in the schema is the
      // free-text one on shade_cards itself. So Revision cannot be inherited;
      // it stays a typed field. Returning null would render an always-blank
      // read-only row that looks like a bug.
      artwork_no: p?.party_artwork_code || null,
      output_no: p?.output_number || null,
      board: [p?.board_name, p?.gsm ? `${p.gsm} GSM` : null].filter(Boolean).join(' · ') || null,
      print_specs: [p?.colour_type, p?.colors ? `${p.colors} colours` : null, p?.coating]
        .filter(Boolean).join(' · ') || null,
      colour_system: p?.colour_type || null,
      num_colours: p?.colors ?? null,
      suggested_title: p?.name ? `${p.name} shade card` : '',
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

// ── Alerts feed ──────────────────────────────────────────────────────────────
// Computed live so it can never drift: drafts not yet sent, pending/overdue/
// rejected customer responses, cards ageing towards the 365-day cliff, cards
// stuck outside the store past a week, and approvals whose artwork, output
// code or product master moved on after the customer signed.
r.get('/shade-cards/alerts', async (_req, res, next) => {
  try {
    const rows = (await q(`${CARD_VIEW} WHERE sc.active = 1`)).map(decorate);
    const alerts = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const sc of rows) {
      const ref = { id: sc.id, sc_number: sc.sc_number, title: sc.title, customer_name: sc.customer_name };
      if (sc.status === 'draft')
        alerts.push({ ...ref, kind: 'not_sent', severity: 'info',
          message: `${sc.sc_number} is still a draft — not yet sent to the customer` });
      if (sc.status === 'sent') {
        const overdue = sc.expected_approval_date && sc.expected_approval_date < today;
        alerts.push({ ...ref, kind: overdue ? 'approval_overdue' : 'pending_customer',
          severity: overdue ? 'critical' : 'warn',
          message: overdue
            ? `${sc.sc_number} customer approval OVERDUE (expected ${sc.expected_approval_date})`
            : `${sc.sc_number} awaiting customer approval` });
      }
      if (sc.status === 'rejected')
        alerts.push({ ...ref, kind: 'rejected', severity: 'critical',
          message: `${sc.sc_number} was rejected by the customer — correct it and send again` });
      if (sc.expired_by_age)
        alerts.push({ ...ref, kind: 'expired', severity: 'critical',
          message: `${sc.sc_number} is ${sc.age_days} days old — past the ${SHADE_CARD_LIFE_DAYS}-day life` });
      else if (sc.age_days != null && sc.age_days >= SHADE_CARD_LIFE_DAYS - 30)
        alerts.push({ ...ref, kind: 'expiring', severity: 'warn',
          message: `${sc.sc_number} expires in ${SHADE_CARD_LIFE_DAYS - sc.age_days} days` });
      // No date on record at all. Not the same alarm as "expired" — this card
      // cannot be judged either way, so it silently escaped the 365-day rule
      // entirely. Someone has to look at the physical card and date it.
      if (sc.age_unknown && sc.status === 'approved')
        alerts.push({ ...ref, kind: 'no_age', severity: 'warn',
          message: `${sc.sc_number} has no date on record — its age cannot be checked, so the 365-day rule never applies to it. Date the physical card.` });
      // Long-pending return: the card has been out of the store for over a week.
      if (sc.open_issue_id && sc.issued_at) {
        const outDays = Math.floor((Date.now() - Date.parse(sc.issued_at)) / 86400000);
        if (outDays >= 7)
          alerts.push({ ...ref, kind: 'return_overdue', severity: outDays >= 21 ? 'critical' : 'warn',
            message: `${sc.sc_number} has been with ${sc.issued_to} (${sc.department}) for ${outDays} days — chase the return` });
      }
      // Code drift: the card was approved against codes the master no longer
      // carries. This is the warn-not-block check.
      for (const m of sc.code_mismatches || [])
        alerts.push({ ...ref, kind: 'code_mismatch', severity: 'warn',
          message: `${sc.sc_number}: ${m.field} on the card is ${m.card}, the product master now carries ${m.order}` });
    }
    // Approved cards whose product master changed after the approval landed.
    // The artwork-drift half of this used to live here too, but it is now
    // code_mismatches from decorate() in the loop above — sourced from the
    // SAME codeMatch() rule printingEligibility uses, instead of a bespoke
    // one-field comparison duplicated in this query. Only the master-changed
    // check remains: it has no per-card column to hang off decorate().
    const drift = await q(`
      SELECT sc.id, sc.sc_number, sc.title, c.name AS customer_name,
             (SELECT MAX(a.created_at) FROM audit_log a
              WHERE a.entity IN ('products','product') AND a.entity_id = sc.product_id) AS master_touched_at,
             COALESCE(sc.approval_received_date, sc.internal_approval_date) AS approved_on
      FROM shade_cards sc
      JOIN products p ON p.id = sc.product_id
      LEFT JOIN customers c ON c.id = sc.customer_id
      WHERE sc.active = 1 AND sc.status = 'approved'`);
    for (const d of drift) {
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
    const pendingCustomer = rows.filter(x => x.status === 'sent');
    const overdue = pendingCustomer.filter(x => x.expected_approval_date && x.expected_approval_date < today);
    const approved = rows.filter(x => x.status === 'approved' && !x.expired_by_age);
    const expired = rows.filter(x => x.expired_by_age);
    const withPrinting = rows.filter(x => x.with_printing);
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
    // Approved and linked to work that has not reached the floor yet.
    const awaitingProduction = approved.filter(x =>
      ['pending', 'planned', 'ready'].includes(x.planning_status));
    res.json({
      kpis: {
        total: rows.length,
        pending_customer: pendingCustomer.length,
        overdue: overdue.length,
        approved: approved.length,
        expired: expired.length,
        with_printing: withPrinting.length,
        avg_tat_days: turns.length ? +(turns.reduce((s, t) => s + t.days, 0) / turns.length).toFixed(1) : null,
      },
      pending_customer: pendingCustomer,
      overdue,
      approved,
      expired,
      with_printing: withPrinting,
      awaiting_production: awaitingProduction,
      tat_by_customer: tat,
    });
  } catch (e) { next(e); }
});

// ── Detail (issues, events, docs meta, orders) ───────────────────────────────
r.get('/shade-cards/:id(\\d+)', async (req, res, next) => {
  try {
    const card = await one(`${CARD_VIEW} WHERE sc.id=$1`, [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Shade card not found' });
    const [issues, events, docs] = await Promise.all([
      q(`SELECT i.*, m.name AS machine_name, jc.jc_number
         FROM shade_card_issues i
         LEFT JOIN machines m ON m.id = i.machine_id
         LEFT JOIN job_cards jc ON jc.id = i.job_card_id
         WHERE i.shade_card_id=$1 ORDER BY i.id DESC`, [card.id]),
      q('SELECT * FROM shade_card_events WHERE shade_card_id=$1 ORDER BY id DESC', [card.id]),
      q(`SELECT id, revision_no, doc_type, title, file_name, mime, size_bytes, note, uploaded_by, created_at
         FROM shade_card_docs WHERE shade_card_id=$1 ORDER BY id DESC`, [card.id]),
    ]);
    res.json({ ...decorate(card), issues, events, docs });
  } catch (e) { next(e); }
});

// ── Create ───────────────────────────────────────────────────────────────────
// A card is created FROM a sales order line: everything on it is inherited, so
// the caller sends the line and only the handful of facts that exist nowhere
// else. order_line_id is nullable in the schema for the 599 bulk-imported
// legacy cards, but it is required here — every new card belongs to an order.
r.post('/shade-cards', canManage, async (req, res, next) => {
  try {
    const lineId = +req.body.order_line_id || null;
    if (!lineId) return res.status(400).json({ error: 'Pick the sales order this shade card is for' });
    const out = await tx(async (qc, oc) => {
      const line = await oc(`
        SELECT ol.*, o.id AS order_id, o.customer_id
        FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.id=$1`, [lineId]);
      if (!line) throw Object.assign(new Error('Sales order line not found'), { status: 404 });
      const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
      const p = effectiveProduct(product, line);
      const sc_number = await nextScNumber(oc);
      const [card] = await qc(`
        INSERT INTO shade_cards (sc_number, title, product_id, customer_id, order_line_id,
          print_process, colour_system, num_colours, artwork_no, artwork_rev, output_no,
          print_reference, colour_details, expected_approval_date, creation_date,
          location, remarks, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [sc_number,
         req.body.title?.trim() || `${p?.name || 'Product'} shade card`,
         line.product_id, line.customer_id, lineId,
         req.body.print_process || null,
         req.body.colour_system || p?.colour_type || null,
         req.body.num_colours || p?.colors || null,
         p?.party_artwork_code || null,      // inherited, never typed
         req.body.artwork_rev || null,       // typed: the ERP has no source for it
         p?.output_number || null,           // inherited, never typed
         req.body.print_reference || null, req.body.colour_details || null,
         req.body.expected_approval_date || null,
         req.body.creation_date || new Date().toISOString().slice(0, 10),
         req.body.location || null, req.body.remarks || null, req.user.name]);
      // The originating order also joins the reuse list, so a card that later
      // serves repeat orders reads consistently from one place.
      await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id) VALUES ($1,$2)
                ON CONFLICT DO NOTHING`, [card.id, line.order_id]);
      await logEvent(card.id, 'created', null, 'draft', `for order line #${lineId}`, req.user.name, qc);
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

// ── Status transitions ───────────────────────────────────────────────────────
// Three moves, guarded by the pure transition map:
//   sent      dispatched to the customer
//   approved  the signed, stamped card came back
//   rejected  the customer said no
// Recording an approval RESETS creation_date, which restarts the 365-day age
// clock — that is how an expired card is renewed rather than replaced.
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

      if (to === 'sent') {
        set('sent_to_customer_date', req.body.sent_to_customer_date || today);
        if (req.body.expected_approval_date !== undefined)
          set('expected_approval_date', req.body.expected_approval_date || null);
        // Re-sending clears the previous verdict so the register never shows an
        // approval that is no longer the live answer.
        for (const col of ['approval_received_date', 'approval_received_by', 'approval_method',
                           'approval_remarks', 'customer_contact_name', 'customer_designation',
                           'customer_company']) set(col, null);
        set('customer_stamp', 0);
        set('customer_signature', 0);
      }
      if (to === 'approved') {
        const method = req.body.approval_method;
        if (!APPROVAL_METHODS.some(m => m.key === method))
          throw Object.assign(new Error('Pick how the approval was received'), { status: 400 });
        if (method === 'verbal' && !req.body.note?.trim())
          throw Object.assign(new Error('A verbal approval needs mandatory remarks'), { status: 400 });
        const received = req.body.approval_received_date || today;
        set('approval_method', method);
        set('approval_received_date', received);
        set('approval_received_by', req.body.approval_received_by?.trim() || req.user.name);
        set('customer_stamp', req.body.customer_stamp ? 1 : 0);
        set('customer_signature', req.body.customer_signature ? 1 : 0);
        set('customer_contact_name', req.body.customer_contact_name || null);
        set('customer_designation', req.body.customer_designation || null);
        set('customer_company', req.body.customer_company || null);
        if (req.body.note !== undefined) set('approval_remarks', req.body.note || null);
        // The renewal: the card's life runs from the day this approval landed.
        set('creation_date', received);
      }
      if (to === 'rejected') {
        if (!req.body.note?.trim())
          throw Object.assign(new Error('Record why the customer rejected the card'), { status: 400 });
        set('approval_remarks', req.body.note.trim());
        set('approval_received_date', null);
        set('approval_method', null);
      }

      vals.push(card.id);
      const [fresh] = await qc(`UPDATE shade_cards SET ${sets.join(', ')}
                                WHERE id=$${vals.length} RETURNING *`, vals);
      await logEvent(card.id, 'status', card.status, to, req.body.note, req.user.name, qc);
      await audit('shade_card', card.id, to,
        `${card.sc_number}: ${labelFor(card.status)} → ${labelFor(to)}${req.body.note ? ` — ${req.body.note}` : ''}`,
        qc, req.user.name);
      // products.shade_card_number/date is a derived cache — keep it true, but
      // never against a product whose number the user RETIRED. The same guard
      // the boot-time back-fill carries has to be here too: without it,
      // approving a card silently un-retires the product's free-text number,
      // which is exactly the bug the retire zone exists to prevent.
      // promoted_to IS NULL because a promotion row is provenance, not a retire.
      if (card.product_id) {
        await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3
                  WHERE id=$1 AND NOT EXISTS (
                    SELECT 1 FROM shade_card_legacy_numbers l
                    WHERE l.product_id = $1 AND l.restored_at IS NULL
                      AND l.promoted_to IS NULL)`,
          [card.product_id, fresh.sc_number, fresh.creation_date]);
      }
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Supporting documents ─────────────────────────────────────────────────────
r.post('/shade-cards/:id(\\d+)/docs', canManage, uploadOne, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Belt to multer's suspender: the wire cap and the stored cap are one
    // number, so anything that arrives larger is still refused in words the
    // operator can act on rather than stored.
    if (req.file.size > DOC_MAX_BYTES) return res.status(400).json({ error: DOC_TOO_BIG });
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

// ── Custody: issue ───────────────────────────────────────────────────────────
// Step 5 of the process. Planning issues an APPROVED card to a department and a
// named person. A press and job card are optional: attaching the job card is
// what lets printing-complete auto-return the card, which is how the plant has
// always worked.
r.post('/shade-cards/:id(\\d+)/issue', canMove, async (req, res, next) => {
  try {
    const issued_to = req.body.issued_to?.trim();
    if (!issued_to) return res.status(400).json({ error: 'Who is the card being issued to?' });
    const department = req.body.department || 'printing';
    if (!DEPARTMENTS.some(d => d.key === department))
      return res.status(400).json({ error: `Unknown department "${department}"` });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      const open = card ? await openIssueFor(card.id, oc) : null;
      const blk = issueBlocker(card, open);
      if (blk) throw Object.assign(new Error(blk), { status: card ? 409 : 404 });
      const [issue] = await qc(`
        INSERT INTO shade_card_issues (shade_card_id, issued_to, department, issued_by,
                                       job_card_id, machine_id, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [card.id, issued_to, department, req.user.name,
         req.body.job_card_id ? +req.body.job_card_id : null,
         req.body.machine_id ? +req.body.machine_id : null,
         req.body.remarks || null]);
      // A card issued for work on another order joins that order's reuse list.
      if (issue.job_card_id) {
        await qc(`INSERT INTO shade_card_orders (shade_card_id, order_id)
                  SELECT $1, ol.order_id FROM job_cards jc
                  JOIN order_lines ol ON ol.id = jc.order_line_id
                  WHERE jc.id = $2 ON CONFLICT DO NOTHING`, [card.id, issue.job_card_id]);
      }
      await logEvent(card.id, 'issued', null, null,
        `${issued_to} · ${department}`, req.user.name, qc);
      await audit('shade_card', card.id, 'issued',
        `${card.sc_number} → ${issued_to} (${department})`, qc, req.user.name);
      await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [card.id]);
      return issue;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Custody: return ──────────────────────────────────────────────────────────
// Step 7. Closing the open row IS the return — there is no zone to write back.
r.post('/shade-cards/:id(\\d+)/return', canMove, async (req, res, next) => {
  try {
    const condition = req.body.condition || 'good';
    if (!RETURN_CONDITIONS.some(c => c.key === condition))
      return res.status(400).json({ error: `Unknown condition "${condition}"` });
    const out = await tx(async (qc, oc) => {
      const card = await oc('SELECT * FROM shade_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!card) throw Object.assign(new Error('Shade card not found'), { status: 404 });
      const open = await openIssueFor(card.id, oc);
      const blk = returnBlocker(open);
      if (blk) throw Object.assign(new Error(blk), { status: 409 });
      // A 'lost' condition still closes the row — deliberately. The card is not
      // with printing any more, and leaving the row open would claim it is out
      // on press, which is the one thing we know for certain is false. The
      // condition column is what records that it never physically came back.
      const [issue] = await qc(`
        UPDATE shade_card_issues SET returned_at=now(), returned_by=$2, received_by=$3,
               condition=$4, remarks=COALESCE($5, remarks)
        WHERE id=$1 RETURNING *`,
        [open.id, req.body.returned_by?.trim() || open.issued_to,
         req.body.received_by?.trim() || req.user.name, condition, req.body.remarks || null]);
      await logEvent(card.id, 'returned', null, null,
        `from ${open.issued_to} · ${condition}`, req.user.name, qc);
      await audit('shade_card', card.id, 'returned',
        `${card.sc_number} back from ${open.issued_to} — ${condition}`, qc, req.user.name);
      await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [card.id]);
      return issue;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Retire zone: the legacy free-text shade card numbers ─────────────────────
// products.shade_card_number/date used to be typed by hand in four places. It
// is now a DERIVED cache of this module, and these routes are how the old
// values are cleared away without ever destroying one.
//
//   candidates  a product carrying a free-text number with NO card behind it —
//               a number nobody can approve, issue or track
//   duplicates  a product whose free-text number matches its real card, so the
//               column is pure redundancy
//   retired     values already moved out, restorable at any time
r.get('/shade-cards/legacy', canManage, async (_req, res, next) => {
  try {
    const [candidates, duplicates, retired] = await Promise.all([
      q(`SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
                c.name AS customer_name, p.shade_card_number, p.shade_card_date
         FROM products p LEFT JOIN customers c ON c.id = p.customer_id
         WHERE COALESCE(p.shade_card_number,'') <> ''
           AND NOT EXISTS (SELECT 1 FROM shade_cards s
                           WHERE s.product_id = p.id AND s.active = 1)
         ORDER BY p.code`),
      q(`SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
                p.shade_card_number, s.sc_number, s.id AS shade_card_id
         FROM products p
         JOIN LATERAL (SELECT id, sc_number FROM shade_cards sc
                       WHERE sc.product_id = p.id AND sc.active = 1
                       ORDER BY sc.id DESC LIMIT 1) s ON true
         WHERE COALESCE(p.shade_card_number,'') <> ''
         ORDER BY p.code`),
      q(`SELECT l.*, p.code AS product_code, p.name AS product_name,
                sc.sc_number AS promoted_number
         FROM shade_card_legacy_numbers l
         JOIN products p ON p.id = l.product_id
         LEFT JOIN shade_cards sc ON sc.id = l.promoted_to
         WHERE l.restored_at IS NULL ORDER BY l.id DESC`),
    ]);
    res.json({ candidates, duplicates, retired });
  } catch (e) { next(e); }
});

// Move a product's free-text value into the zone and clear the columns.
r.post('/shade-cards/legacy/retire', canManage, async (req, res, next) => {
  try {
    const ids = [...new Set((req.body.product_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one product' });
    const out = await tx(async (qc) => {
      const rows = await qc(`
        INSERT INTO shade_card_legacy_numbers (product_id, sc_number, sc_date, retired_by)
        SELECT id, shade_card_number, shade_card_date, $2 FROM products
        WHERE id = ANY($1) AND COALESCE(shade_card_number,'') <> ''
        RETURNING id, product_id`, [ids, req.user.name]);
      await qc(`UPDATE products SET shade_card_number=NULL, shade_card_date=NULL
                WHERE id = ANY($1)`, [rows.map(x => x.product_id)]);
      for (const row of rows) {
        await audit('product', row.product_id, 'shade_number_retired',
          'Legacy free-text shade card number retired — restorable from the retire zone',
          qc, req.user.name);
      }
      return { retired: rows.length };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Turn an orphan number into a real card, then retire the free text behind it.
// One action, because asking a user to retire and then separately create would
// leave the number in limbo if they stopped halfway.
r.post('/shade-cards/legacy/promote', canManage, async (req, res, next) => {
  try {
    const ids = [...new Set((req.body.product_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one product' });
    const out = await tx(async (qc, oc) => {
      const made = [];
      for (const pid of ids) {
        const p = await oc(`SELECT * FROM products WHERE id=$1
                            AND COALESCE(shade_card_number,'') <> ''`, [pid]);
        if (!p) continue;
        // The free-text number is preferred so nothing printed or remembered in
        // the plant breaks — but sc_number is UNIQUE, and a free-text value may
        // already belong to another product's card. Fall back to a fresh number
        // and keep the original in remarks rather than failing the whole batch.
        const taken = await oc('SELECT id FROM shade_cards WHERE sc_number=$1', [p.shade_card_number]);
        const number = taken ? await nextScNumber(oc) : p.shade_card_number;
        const [card] = await qc(`
          INSERT INTO shade_cards (sc_number, title, product_id, customer_id, status,
            creation_date, approval_received_date, approval_method, artwork_no, output_no,
            colour_system, num_colours, remarks, created_by)
          VALUES ($1,$2,$3,$4,'approved',$5,$5,'physical_signed_copy',$6,$7,$8,$9,$10,$11)
          RETURNING *`,
          [number, `${p.name} shade card`, p.id, p.customer_id,
           p.shade_card_date || null, p.party_artwork_code || null, p.output_number || null,
           p.colour_type || null, p.colors || null,
           taken ? `Promoted from legacy number ${p.shade_card_number} (already in use, renumbered)` : 'Promoted from the legacy product-master number',
           req.user.name]);
        await qc(`INSERT INTO shade_card_legacy_numbers
                   (product_id, sc_number, sc_date, promoted_to, retired_by)
                  VALUES ($1,$2,$3,$4,$5)`,
          [p.id, p.shade_card_number, p.shade_card_date, card.id, req.user.name]);
        await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3 WHERE id=$1`,
          [p.id, card.sc_number, card.creation_date]);
        await logEvent(card.id, 'created', null, 'approved',
          `promoted from the legacy number ${p.shade_card_number}`, req.user.name, qc);
        await audit('shade_card', card.id, 'create',
          `${card.sc_number} promoted from the product master`, qc, req.user.name);
        made.push({ product_id: p.id, shade_card_id: card.id, sc_number: card.sc_number });
      }
      return { promoted: made.length, cards: made };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Put a retired value back on the product. Nothing was ever destroyed.
r.post('/shade-cards/legacy/:id(\\d+)/restore', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const row = await oc(`SELECT * FROM shade_card_legacy_numbers WHERE id=$1`, [req.params.id]);
      if (!row) throw Object.assign(new Error('Retired number not found'), { status: 404 });
      if (row.restored_at) throw Object.assign(new Error('Already restored'), { status: 409 });
      await qc(`UPDATE products SET shade_card_number=$2, shade_card_date=$3 WHERE id=$1`,
        [row.product_id, row.sc_number, row.sc_date]);
      await qc(`UPDATE shade_card_legacy_numbers SET restored_at=now(), restored_by=$2
                WHERE id=$1`, [row.id, req.user.name]);
      await audit('product', row.product_id, 'shade_number_restored',
        `Legacy shade card number ${row.sc_number} restored to the product master`,
        qc, req.user.name);
      return { ok: true };
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
