// AVS — Artwork Approval & Verification System.
//
// The carton checks run in Claude (Cowork): photos of a printed sheet are
// compared with the approved artwork, the customer's PO and our order book, and
// each report is written to the Supabase schema `avs` — its own schema, apart
// from the plant tables in public. This router only READS those reports and
// WRITES one thing: QA's final decision (Release / Keep on hold / Reject /
// Artwork alert checked) into avs.decisions. The next check reads the decisions
// straight from there.
//
// The avs schema is created on the production database by migration, not by
// init(): a local database without it answers every read with an empty,
// switched-off module instead of a 500.
import { Router } from 'express';
import { q, one } from '../db.js';
import { optionalText } from '../helpers.js';
import {
  AVS_REPORT_NO, AVS_REMARK_MAX, canDecideAvs, caseState, decisionProblem,
} from '../../../client/src/lib/avs.js';

const r = Router();

const MISSING = new Set(['42P01', '3F000']); // undefined table / undefined schema
const offWhenMissing = (res, next, empty) => e => (MISSING.has(e?.code) ? res.json(empty) : next(e));
const fail = (status, message) => Object.assign(new Error(message), { status });

// The last decision on each report — one row per report_no.
const LAST_DECISION = `
  SELECT DISTINCT ON (report_no) report_no, report_rev, check_no, decision, decided_by, remark, decided_at
    FROM avs.decisions
   ORDER BY report_no, decided_at DESC`;

// ── Register: the latest issue of every report ──────────────────────────────
r.get('/avs/reports', async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT l.report_no, l.report_rev, l.check_no, l.status, l.product_name, l.product, l.customer,
             l.artwork_code, l.revision, l.item_code, l.headline, l.key_finding, l.po_no, l.po_date,
             l.po_age_days, l.job_card, l.print_status, l.checked_on, l.issued_at, l.drive_url,
             l.artwork_alerts,
             (SELECT count(*)::int FROM avs.problems p WHERE p.report_id = l.id AND p.result IN ('HOLD','REJECT')) AS open_points,
             EXISTS (SELECT 1 FROM avs.reports c WHERE c.report_no = l.report_no AND c.row_type = 'CLOSE') AS closed,
             d.decision AS last_decision, d.decided_by AS last_decided_by, d.decided_at AS last_decided_at,
             d.report_rev AS last_decision_rev, d.check_no AS last_decision_check
        FROM avs.latest_reports l
        LEFT JOIN (${LAST_DECISION}) d ON d.report_no = l.report_no
       ORDER BY l.report_no DESC`);
    const reports = rows.map(x => ({
      ...x,
      case_state: caseState(x, x.last_decision
        ? { decision: x.last_decision, report_rev: x.last_decision_rev, check_no: x.last_decision_check }
        : null),
    }));
    res.json({ enabled: true, can_decide: await mayDecide(req.user), reports });
  } catch (e) {
    offWhenMissing(res, next, { enabled: false, can_decide: false, reports: [] })(e);
  }
});

// ── One report: latest issue, its problems, every issue, every decision ─────
r.get('/avs/reports/:no', async (req, res, next) => {
  try {
    const no = req.params.no;
    if (!AVS_REPORT_NO.test(no)) throw fail(400, 'Not an AVS report number');
    const report = await one(`
      SELECT id, report_no, report_rev, check_no, status, product_name, product, heading_line, customer,
             artwork_code, revision, item_code, headline, summary, key_finding, recommendation,
             po_no, po_date, po_age_days, po_qty, po_open_qty, po_result, job_card, print_status,
             print_headline, order_book_strip, ob_note, artwork_alerts, check_log, report_file,
             date_folder, product_folder, drive_url, checked_on, issued_at, master_file, note
        FROM avs.latest_reports WHERE report_no = $1`, [no]);
    if (!report) throw fail(404, `${no} not found`);
    const [problems, history, decisions, closedRow] = await Promise.all([
      q(`SELECT ref, result, title, detail, action, rows FROM avs.problems WHERE report_id = $1
          ORDER BY CASE result WHEN 'REJECT' THEN 0 WHEN 'HOLD' THEN 1 WHEN 'VERIFY' THEN 2 ELSE 3 END,
                   substring(ref from 1 for 1), (substring(ref from 3))::int`, [report.id]),
      q(`SELECT report_rev, check_no, row_type, status, issued_at, report_file, note
           FROM avs.reports WHERE report_no = $1 ORDER BY check_no, report_rev, issued_at`, [no]),
      q(`SELECT id, report_rev, check_no, decision, decided_by, decided_by_role, remark, decided_at, status_at_decision, source
           FROM avs.decisions WHERE report_no = $1 ORDER BY decided_at DESC`, [no]),
      one(`SELECT note, issued_at FROM avs.reports WHERE report_no = $1 AND row_type = 'CLOSE' ORDER BY issued_at DESC LIMIT 1`, [no]),
    ]);
    const last = decisions[0] || null;
    delete report.id;
    res.json({
      report: { ...report, closed: !!closedRow, closed_note: closedRow?.note ?? null,
        case_state: caseState({ ...report, closed: !!closedRow }, last) },
      problems, history, decisions, can_decide: await mayDecide(req.user),
    });
  } catch (e) { next(e); }
});

// ── QA's decision ────────────────────────────────────────────────────────────
// Recorded against the issue the person was looking at (report_rev / check_no
// from the page). If a newer issue arrived in the meantime the save is refused,
// so nobody releases a report they did not read.
r.post('/avs/reports/:no/decisions', async (req, res, next) => {
  try {
    const no = req.params.no;
    if (!AVS_REPORT_NO.test(no)) throw fail(400, 'Not an AVS report number');
    if (!(await mayDecide(req.user))) throw fail(403, 'Only QA or management can record an AVS decision');
    const report = await one(`
      SELECT report_no, report_rev, check_no, status, artwork_alerts,
             EXISTS (SELECT 1 FROM avs.problems p WHERE p.report_id = l.id AND p.result = 'VERIFY') AS has_alert
        FROM avs.latest_reports l WHERE report_no = $1`, [no]);
    if (!report) throw fail(404, `${no} not found`);
    const seenRev = Number(req.body?.report_rev);
    const seenCheck = Number(req.body?.check_no ?? 1);
    if (!Number.isInteger(seenRev) || seenRev !== +report.report_rev || seenCheck !== +report.check_no) {
      throw fail(409, 'A newer issue of this report has arrived. Reload it and decide on the new one.');
    }
    const decision = optionalText(req.body?.decision);
    const remark = optionalText(req.body?.remark);
    const problem = decisionProblem({ decision, remark, status: report.status, hasAlert: report.has_alert });
    if (problem) throw fail(400, problem);
    const saved = await one(`
      INSERT INTO avs.decisions (report_no, report_rev, check_no, decision, decided_by, decided_by_user_id,
                                 decided_by_role, remark, decided_at, source, status_at_decision)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'ci-plant', $9)
      RETURNING id, report_rev, check_no, decision, decided_by, decided_by_role, remark, decided_at, status_at_decision, source`,
      [no, report.report_rev, report.check_no, decision, req.user.name ?? null, req.user.id ?? null,
        req.user.role ?? null, remark ? remark.slice(0, AVS_REMARK_MAX) : null, report.status]);
    res.status(201).json(saved);
  } catch (e) { next(e); }
});

// QA and admin by role; a management login by its flag, read fresh from the
// database — a stale token can never grant it.
async function mayDecide(user) {
  if (!user) return false;
  if (canDecideAvs({ role: user.role })) return true;
  const row = await one('SELECT is_management FROM users WHERE id = $1 AND active = 1', [user.id]).catch(() => null);
  return +(row?.is_management ?? 0) === 1;
}

export default r;
