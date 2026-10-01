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
import { markUncacheable } from '../data-tables.js';
import { avsGateForCard } from '../avs-gate.js';
import {
  AVS_REPORT_NO, AVS_REMARK_MAX, AVS_WHO_DECIDES, DECISION_IN_FORCE_SQL, SEVERITY_SQL, canDecideAvs, caseState,
  decisionProblem, decisionsInForce, pdfStamp, undoProblem,
} from '../../../client/src/lib/avs.js';
import { avsSettings, callDrive } from './avs-intake.js';
import { stampPdf } from '../avs-stamp.js';

const r = Router();

const MISSING = new Set(['42P01', '3F000']); // undefined table / undefined schema
const offWhenMissing = (res, next, empty) => e => (MISSING.has(e?.code) ? res.json(empty) : next(e));
const fail = (status, message) => Object.assign(new Error(message), { status });

// The decision in force on each report — one row per report_no. An
// artwork-alert sign-off never decides a case, so it is left out here: taken as
// the "last decision" it made a released report look open again. An undone
// decision and the UNDO row itself are left out too (lib/avs.js
// DECISION_IN_FORCE_SQL), so an undo brings back the decision before it.
const LAST_DECISION = `
  SELECT DISTINCT ON (dd.report_no) dd.id, dd.report_no, dd.report_rev, dd.check_no, dd.decision, dd.decided_by,
         dd.remark, dd.decided_at
    FROM avs.decisions dd
   WHERE ${DECISION_IN_FORCE_SQL('dd')}
   ORDER BY dd.report_no, dd.decided_at DESC, dd.id DESC`;

// Every AVS answer is built from rows Claude writes straight into Supabase,
// where no change is announced on the realtime feed, so none may be answered
// from a browser's memory.
r.use('/avs', (req, _res, next) => { if (req.method === 'GET') markUncacheable(); next(); });

// ── Register: the latest issue of every report ──────────────────────────────
r.get('/avs/reports', async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT l.report_no, l.report_rev, l.check_no, l.status, l.product_name, l.product, l.customer,
             l.artwork_code, l.revision, l.item_code, l.headline, l.key_finding, l.po_no, l.po_date,
             l.po_age_days, l.job_card, l.print_status, l.checked_on, l.issued_at, l.drive_url, l.drive_file_id,
             l.artwork_alerts,
             (SELECT count(*)::int FROM avs.problems p WHERE p.report_id = l.id AND p.result IN ('HOLD','REJECT')) AS open_points,
             sv.critical, sv.major, sv.minor,
             t.queued_at AS set_queued_at, t.claimed_at AS set_claimed_at, t.finished_at AS set_finished_at,
             EXISTS (SELECT 1 FROM avs.reports c WHERE c.report_no = l.report_no AND c.row_type = 'CLOSE') AS closed,
             d.id AS last_decision_id, d.remark AS last_remark,
             d.decision AS last_decision, d.decided_by AS last_decided_by, d.decided_at AS last_decided_at,
             d.report_rev AS last_decision_rev, d.check_no AS last_decision_check
        FROM avs.latest_reports l
        LEFT JOIN (${LAST_DECISION}) d ON d.report_no = l.report_no
        -- How serious the points to clear are (lib/avs.js SEVERITY_SQL).
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE sev = 'CRITICAL')::int AS critical,
                 count(*) FILTER (WHERE sev = 'MAJOR')::int AS major,
                 count(*) FILTER (WHERE sev = 'MINOR')::int AS minor
            FROM (SELECT ${SEVERITY_SQL('p')} AS sev FROM avs.problems p
                   WHERE p.report_id = l.id AND p.result IN ('HOLD','REJECT')) x) sv ON true
        -- The photo set behind this issue: how long it took from Verify to the report.
        LEFT JOIN LATERAL (
          SELECT c.queued_at, c.claimed_at, c.finished_at FROM avs.check_requests c
           WHERE c.status = 'done' AND c.report_no = l.report_no AND COALESCE(c.check_no, 1) = COALESCE(l.check_no, 1)
           ORDER BY c.id DESC LIMIT 1) t ON true
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
    const [problems, history, decisions, closedRow, sets] = await Promise.all([
      q(`SELECT ref, result, title, detail, action, rows, ${SEVERITY_SQL('avs.problems')} AS severity FROM avs.problems WHERE report_id = $1
          ORDER BY CASE result WHEN 'REJECT' THEN 0 WHEN 'HOLD' THEN 1 WHEN 'VERIFY' THEN 2 ELSE 3 END,
                   substring(ref from 1 for 1), (substring(ref from 3))::int`, [report.id]),
      q(`SELECT report_rev, check_no, row_type, status, issued_at, report_file, note
           FROM avs.reports WHERE report_no = $1 ORDER BY check_no, report_rev, issued_at`, [no]),
      q(`SELECT id, report_rev, check_no, decision, decided_by, decided_by_role, remark, decided_at, status_at_decision, source,
                undoes_id
           FROM avs.decisions WHERE report_no = $1 ORDER BY decided_at DESC, id DESC`, [no]),
      one(`SELECT note, issued_at FROM avs.reports WHERE report_no = $1 AND row_type = 'CLOSE' ORDER BY issued_at DESC LIMIT 1`, [no]),
      // The photo sets behind this report: the first check and every redo, with
      // who asked, why, and how each ended — the trail between the issues.
      q(`SELECT id, status, jc_number, created_by, created_at, queued_at, claimed_at, finished_at, report_rev, check_no, result,
                robot_note, redo_report_no, redo_of_set_id, redo_reason, drive_folder_url, cancelled_by, cancelled_at
           FROM avs.check_requests WHERE report_no = $1 OR redo_report_no = $1 ORDER BY id`, [no])
        .catch(e => (MISSING.has(e?.code) || e?.code === '42703' ? [] : Promise.reject(e))),
    ]);
    const { list, last } = decisionsInForce(decisions);
    delete report.id;
    res.json({
      decisions_in_force: last ? last.id : null,
      report: { ...report, closed: !!closedRow, closed_note: closedRow?.note ?? null,
        case_state: caseState({ ...report, closed: !!closedRow }, last) },
      problems, history, decisions: list, can_decide: await mayDecide(req.user),
      sets, open_redo: sets.find(x => x.redo_report_no === no && ['uploading', 'queued', 'checking'].includes(x.status)) || null,
    });
  } catch (e) { next(e); }
});

// ── The printing lock of one job card ───────────────────────────────────────
// What the printing station shows before it tries to complete: is AVS
// mandatory for this job, is it released, and if not, why. The completion
// route asks the same question (avs-gate.js) and refuses on the same answer.
r.get('/avs/gate/:jobCardId', async (req, res, next) => {
  try {
    const id = Number(req.params.jobCardId);
    if (!Number.isInteger(id) || id <= 0) throw fail(400, 'Not a job card id');
    const gate = await avsGateForCard(q, one, id);
    if (!gate) throw fail(404, 'Job card not found');
    res.json(gate);
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
    if (!(await mayDecide(req.user))) throw fail(403, AVS_WHO_DECIDES);
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

// ── Undo a decision ─────────────────────────────────────────────────────────
// Only the decision in force on the latest issue (or its artwork-alert
// sign-off), and never by deleting it: an UNDO row names it, with who, when and
// why. The decision before it, if any, is in force again.
r.post('/avs/reports/:no/decisions/:id/undo', async (req, res, next) => {
  try {
    const no = req.params.no;
    if (!AVS_REPORT_NO.test(no)) throw fail(400, 'Not an AVS report number');
    if (!(await mayDecide(req.user))) throw fail(403, AVS_WHO_DECIDES);
    const id = Number(req.params.id);
    const remark = optionalText(req.body?.remark);
    const problem = undoProblem({ remark });
    if (problem) throw fail(400, problem);
    const target = Number.isInteger(id) && id > 0 && await one(`SELECT id, report_rev, check_no, decision FROM avs.decisions
      WHERE id = $1 AND report_no = $2`, [id, no]);
    if (!target) throw fail(404, 'Decision not found');
    if (target.decision === 'UNDO') throw fail(409, 'An undo cannot be undone. Record the decision again.');
    const report = await one('SELECT report_rev, check_no FROM avs.latest_reports WHERE report_no = $1', [no]);
    if (!report || +report.report_rev !== +target.report_rev || +report.check_no !== +(target.check_no ?? 1)) {
      throw fail(409, 'This decision was made on an earlier issue of the report; only a decision on the latest issue can be undone.');
    }
    if (target.decision !== 'ARTWORK ALERT OK') {
      const inForce = await one(`SELECT dd.id FROM avs.decisions dd WHERE dd.report_no = $1 AND ${DECISION_IN_FORCE_SQL('dd')}
        ORDER BY dd.decided_at DESC, dd.id DESC LIMIT 1`, [no]);
      if (+inForce?.id !== +target.id) throw fail(409, 'Only the decision in force can be undone. Reload the report.');
    }
    let saved;
    try {
      saved = await one(`
        INSERT INTO avs.decisions (report_no, report_rev, check_no, decision, undoes_id, decided_by, decided_by_user_id,
                                   decided_by_role, remark, decided_at, source)
        VALUES ($1, $2, $3, 'UNDO', $4, $5, $6, $7, $8, now(), 'ci-plant')
        RETURNING id, report_rev, check_no, decision, undoes_id, decided_by, decided_by_role, remark, decided_at, source`,
        [no, target.report_rev, target.check_no ?? 1, target.id, req.user.name ?? null, req.user.id ?? null,
          req.user.role ?? null, remark ? remark.slice(0, AVS_REMARK_MAX) : null]);
    } catch (e) {
      if (e?.code === '23505') throw fail(409, 'This decision was already undone. Reload the report.');
      throw e;
    }
    res.status(201).json(saved);
  } catch (e) { next(e); }
});

// QA by role; everyone else by the AVS decision right (users.avs_approver),
// read fresh from the database — a stale token can never grant it.
async function mayDecide(user) {
  if (!user) return false;
  if (canDecideAvs({ role: user.role })) return true;
  const row = await one('SELECT avs_approver FROM users WHERE id = $1 AND active = 1', [user.id]).catch(() => null);
  return canDecideAvs({ role: user.role, avs_approver: row?.avs_approver });
}

// ── The report PDF, with QA's decision stamped on it ────────────────────────
// Read through the Drive link (the PDF lives in CI AVS) and returned from CI
// Plant, so the people who open it see "RELEASED BY QA" (or rejected / kept on
// hold) once QA has decided this issue. Without a decision it is the PDF as
// filed. A PDF too big for one answer is not served here: the page then opens
// the Drive copy.
const PDF_MAX = 4 * 1024 * 1024;
r.get('/avs/reports/:no/pdf', async (req, res, next) => {
  try {
    const no = req.params.no;
    if (!AVS_REPORT_NO.test(no)) throw fail(400, 'Not an AVS report number');
    const report = await one(`SELECT report_no, report_rev, check_no, status, drive_file_id, report_file
                                FROM avs.latest_reports WHERE report_no = $1`, [no]);
    if (!report) throw fail(404, `${no} not found`);
    if (!report.drive_file_id) throw fail(404, `The PDF of ${no} is not linked yet`);
    const [last, closed] = await Promise.all([
      one(`${LAST_DECISION.replace('ORDER BY dd.report_no', 'AND dd.report_no = $1 ORDER BY dd.report_no')}`, [no]),
      one(`SELECT 1 AS x FROM avs.reports WHERE report_no = $1 AND row_type = 'CLOSE' LIMIT 1`, [no]),
    ]);
    const state = caseState({ ...report, closed: !!closed }, last || null);
    const sameIssue = last && +last.report_rev === +report.report_rev && +(last.check_no ?? 1) === +(report.check_no ?? 1);
    const stamp = pdfStamp(state, sameIssue ? last : null);
    const got = await callDrive(await avsSettings(), { op: 'get', id: report.drive_file_id }, { timeoutMs: 26000, tries: 2 });
    const bytes = Buffer.from(got.base64 || '', 'base64');
    if (!bytes.length) throw fail(502, 'Google Drive sent an empty file');
    const out = Buffer.from(await stampPdf(bytes, stamp));
    if (out.length > PDF_MAX) throw fail(413, 'The PDF is too big to send from CI Plant; open it in Drive');
    const name = String(report.report_file || `${no}.pdf`).replace(/[^\w .()+-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('X-AVS-Stamp', stamp ? stamp.words : 'none');
    res.end(out);
  } catch (e) { next(e); }
});

export default r;
