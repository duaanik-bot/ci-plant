// AVS printing lock — the server's half of client/src/lib/avs.js avsGate().
//
// Planning switches AVS on per job (order_lines.avs_mandatory; for a gang or a
// combined run, gang_runs.avs_mandatory or any member line's). When it is on,
// completing the PRINTING stage of the job's card is refused until every AVS
// report carrying the card's number is released by QA in Artwork Verification.
//
// The AVS reports live in the Supabase schema `avs`, which exists only on the
// production database (it is created by migration, never by init()). A job with
// the switch on, on a database without that schema, stays locked — the switch
// means "QA must release it", and nothing here can release it.
import { avsGate } from '../../client/src/lib/avs.js';

// Is AVS mandatory for this job card? A plain card reads its own line; a run
// card (a gang parent or a combined run: no order line of its own) needs it when
// the run's switch is on or any member line's is — the sheet prints together.
// Self-contained sub-selects, so any query with a job_cards alias can use it.
export const avsMandatorySql = (jc = 'jc') => `(CASE
    WHEN ${jc}.order_line_id IS NULL AND ${jc}.gang_run_id IS NOT NULL THEN
      EXISTS (SELECT 1 FROM gang_runs avs_gr WHERE avs_gr.id = ${jc}.gang_run_id AND avs_gr.avs_mandatory = 1)
      OR EXISTS (SELECT 1 FROM order_lines avs_ml WHERE avs_ml.gang_run_id = ${jc}.gang_run_id AND avs_ml.avs_mandatory = 1)
    ELSE EXISTS (SELECT 1 FROM order_lines avs_ol WHERE avs_ol.id = ${jc}.order_line_id AND avs_ol.avs_mandatory = 1)
  END)`;

// Every report carrying this job card number, latest issue each, with the last
// QA decision that is not an artwork-alert sign-off (that one never releases).
const REPORTS_FOR_CARD = `
  SELECT l.report_no, l.report_rev, l.check_no, l.status, l.product_name, l.issued_at,
         EXISTS (SELECT 1 FROM avs.reports c WHERE c.report_no = l.report_no AND c.row_type = 'CLOSE') AS closed,
         d.decision, d.decided_by, d.remark, d.decided_at,
         d.report_rev AS decision_rev, d.check_no AS decision_check
    FROM avs.latest_reports l
    LEFT JOIN LATERAL (
      SELECT dd.decision, dd.decided_by, dd.remark, dd.decided_at, dd.report_rev, dd.check_no
        FROM avs.decisions dd
       WHERE dd.report_no = l.report_no AND dd.decision <> 'ARTWORK ALERT OK'
       ORDER BY dd.decided_at DESC, dd.id DESC
       LIMIT 1) d ON true
   WHERE upper(btrim(l.job_card)) = upper(btrim($1))
   ORDER BY l.report_no`;

export const AVS_UNAVAILABLE = 'The AVS module is not set up on this database, so nothing can release this job. '
  + 'Ask Planning to switch AVS off for it, with a reason.';

// The lock for one job card: { mandatory, released, jc_number, reports, reason }.
// `qAll` returns rows, `qOne` the first row — the tx() pair or db.js q/one.
export async function avsGateForCard(qAll, qOne, jobCardId) {
  const card = await qOne(
    `SELECT jc.id, jc.jc_number, ${avsMandatorySql('jc')} AS avs_mandatory FROM job_cards jc WHERE jc.id = $1`,
    [jobCardId]);
  if (!card) return null;
  const base = { job_card_id: card.id, jc_number: card.jc_number, mandatory: !!card.avs_mandatory };
  if (!card.avs_mandatory) return { ...base, released: true, reports: [], reason: null };
  // Checked first, so a missing schema never aborts the caller's transaction.
  const has = await qOne(`SELECT to_regclass('avs.latest_reports') IS NOT NULL AS ok`);
  if (!has?.ok) return { ...base, released: false, reports: [], reason: AVS_UNAVAILABLE };
  const rows = await qAll(REPORTS_FOR_CARD, [card.jc_number]);
  return { ...base, ...avsGate(rows) };
}

// The refusal completion throws. Structured so the station can draw its own
// dialog (api.js HANDLED_BY → Section / Floor / Production).
export function avsLockedError(gate) {
  const e = new Error(`AVS is mandatory for ${gate.jc_number}: printing can be completed once QA releases it. ${gate.reason}`);
  e.status = 409;
  e.body = { code: 'AVS_NOT_RELEASED', avs: gate };
  return e;
}
