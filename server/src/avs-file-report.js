// The AVS check's report, saved in ONE call (POST /api/avs/robot/file-report).
//
// Before 5 Oct 2026 the check saved its report row, its problem points, its
// photos and the set through the Supabase connector: one long execute_sql that
// timed out again and again on the long findings text, so each run fell back to
// field-by-field statements and spent 4 to 10 minutes on it (AVS time study,
// 5 Oct 2026: 0024 took 9 min 45 s). avs_file.py now posts the same values here
// once, and this file turns them into one transaction.
//
// Pure: it builds SQL and parameters and checks the payload; the route runs them.
// Every statement is safe to repeat (upserts on the reports and problems keys,
// photo and set updates by id), so a lost answer is fixed by posting again.

export const REPORT_COLUMNS = {
  report_no: 'text', report_rev: 'int', check_no: 'int', row_type: 'text', status: 'text',
  checked_on: 'date', issued_at: 'timestamptz', product: 'text', product_name: 'text',
  customer: 'text', artwork_code: 'text', revision: 'text', item_code: 'text',
  product_folder: 'text', date_folder: 'text', headline: 'text', key_finding: 'text',
  po_no: 'text', po_date: 'date', po_age_days: 'int', po_qty: 'numeric', po_open_qty: 'numeric',
  po_result: 'text', job_card: 'text', print_status: 'text', ob_open_qty: 'numeric',
  ob_note: 'text', artwork_alerts: 'text', check_log: 'text', problem_refs: 'text',
  report_file: 'text', master_file: 'text', master_drive_id: 'text', master_sha256: 'text',
  photos: 'text[]', photo_sha256: 'text[]', note: 'text', findings: 'jsonb', station: 'text',
  heading_line: 'text', summary: 'text', recommendation: 'jsonb', print_headline: 'text',
  order_book_strip: 'text', drive_file_id: 'text', drive_url: 'text',
};
// The key of avs.reports: these identify the issue and are never "updated".
const REPORT_KEY = ['report_no', 'check_no', 'report_rev', 'row_type'];

const PROBLEM_COLUMNS = ['ref', 'result', 'title', 'detail', 'action', 'rows', 'severity'];
const RESULTS = new Set(['PASS', 'HOLD', 'REJECT']);
const PROBLEM_RESULTS = new Set(['PASS', 'HOLD', 'REJECT', 'VERIFY', 'INFO']);
const SEVERITIES = new Set(['CRITICAL', 'MAJOR', 'MINOR']);

const isInt = v => Number.isInteger(v) && v >= 0;
const blank = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// What is wrong with a payload, in words the check can act on; [] when fine.
export function filingProblems(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['The body must be a JSON object.'];
  if (!Number.isInteger(p.set_id) || p.set_id <= 0) out.push('set_id must be the id of your photo set.');
  const r = p.report;
  if (!r || typeof r !== 'object') return [...out, 'report is missing.'];
  const unknown = Object.keys(r).filter(k => !(k in REPORT_COLUMNS));
  if (unknown.length) out.push(`report has fields avs.reports does not have: ${unknown.join(', ')}.`);
  if (blank(r.report_no) || !/^AVS-\d{4}-\d{4}$/.test(String(r.report_no))) out.push('report.report_no must look like AVS-2026-0024.');
  if (!RESULTS.has(r.status)) out.push('report.status must be PASS, HOLD or REJECT.');
  for (const k of ['report_rev', 'check_no']) if (!isInt(r[k])) out.push(`report.${k} must be a whole number (0 or more).`);
  if (r.row_type !== undefined && r.row_type !== 'REPORT') out.push('report.row_type must be REPORT (a CLOSE row is not filed here).');
  for (const k of ['photos', 'photo_sha256']) {
    if (r[k] !== undefined && r[k] !== null && !(Array.isArray(r[k]) && r[k].every(x => typeof x === 'string'))) {
      out.push(`report.${k} must be a list of texts.`);
    }
  }
  const probs = p.problems ?? [];
  if (!Array.isArray(probs)) out.push('problems must be a list.');
  else {
    const seen = new Set();
    probs.forEach((x, i) => {
      if (!x || blank(x.ref)) { out.push(`problems[${i}] has no ref.`); return; }
      if (seen.has(x.ref)) out.push(`problem ${x.ref} is listed twice.`);
      seen.add(x.ref);
      if (!PROBLEM_RESULTS.has(x.result)) out.push(`problem ${x.ref}: result must be PASS, HOLD, REJECT, VERIFY or INFO.`);
      if (x.severity != null && !SEVERITIES.has(x.severity)) out.push(`problem ${x.ref}: severity must be CRITICAL, MAJOR or MINOR.`);
      const extra = Object.keys(x).filter(k => !PROBLEM_COLUMNS.includes(k));
      if (extra.length) out.push(`problem ${x.ref} has unknown fields: ${extra.join(', ')}.`);
    });
  }
  const photos = p.photos ?? [];
  if (!Array.isArray(photos)) out.push('photos must be a list.');
  else photos.forEach((x, i) => {
    if (!x || !Number.isInteger(x.id) || x.id <= 0) out.push(`photos[${i}] needs the check_photos id.`);
    else if (blank(x.drive_file_id)) out.push(`photo ${x.id} needs its drive_file_id.`);
  });
  const s = p.set ?? {};
  if (typeof s !== 'object') out.push('set must be an object.');
  else if (s.result !== undefined && s.result !== r.status) out.push('set.result must equal report.status.');
  return out;
}

const cast = type => (type === 'text' ? '' : `::${type}`);
const value = (type, v) => {
  if (v === undefined || v === null || (typeof v === 'string' && v === '' && type !== 'text')) return null;
  if (type === 'jsonb') return JSON.stringify(v);
  return v;
};

// The avs.reports upsert: insert the issue, or (posted again) bring it up to date.
export function reportUpsert(report) {
  const r = { row_type: 'REPORT', station: 'C', ...report };
  if (r.issued_at === undefined) r.issued_at = new Date().toISOString();
  const cols = Object.keys(REPORT_COLUMNS).filter(k => r[k] !== undefined);
  const params = cols.map(k => value(REPORT_COLUMNS[k], r[k]));
  const vals = cols.map((k, i) => `$${i + 1}${cast(REPORT_COLUMNS[k])}`);
  const sets = cols.filter(k => !REPORT_KEY.includes(k)).map(k => `${k} = EXCLUDED.${k}`);
  const text = `INSERT INTO avs.reports (${cols.join(', ')}) VALUES (${vals.join(', ')})
    ON CONFLICT (report_no, check_no, report_rev, row_type) DO UPDATE SET ${sets.join(', ')}
    RETURNING id, report_no, report_rev, check_no, status`;
  return { text, params };
}

export function problemUpsert(reportId, reportNo, prob) {
  const params = [reportId, reportNo, ...PROBLEM_COLUMNS.map(k => (prob[k] === undefined ? null : prob[k]))];
  const text = `INSERT INTO avs.problems (report_id, report_no, ${PROBLEM_COLUMNS.join(', ')})
    VALUES ($1, $2, ${PROBLEM_COLUMNS.map((_, i) => `$${i + 3}`).join(', ')})
    ON CONFLICT (report_id, ref) DO UPDATE SET report_no = EXCLUDED.report_no,
      ${PROBLEM_COLUMNS.filter(k => k !== 'ref').map(k => `${k} = EXCLUDED.${k}`).join(', ')}`;
  return { text, params };
}

export function photoFiled(setId, ph) {
  return {
    text: `UPDATE avs.check_photos SET stored = 'drive', drive_file_id = $3, drive_url = $4,
      filed_path = COALESCE($5, filed_path), filed_at = now()
      WHERE id = $1 AND request_id = $2 RETURNING id`,
    params: [ph.id, setId, ph.drive_file_id,
      ph.drive_url || `https://drive.google.com/file/d/${ph.drive_file_id}/view`, ph.filed_path ?? null],
  };
}

export function setDone(setId, report, set = {}) {
  return {
    text: `UPDATE avs.check_requests SET status = 'done', finished_at = COALESCE(finished_at, now()),
      report_no = $2, report_rev = $3, check_no = $4, result = $5, progress = 'Report ready',
      robot_note = COALESCE($6, robot_note), drive_folder_path = COALESCE($7, drive_folder_path),
      drive_folder_id = COALESCE($8, drive_folder_id), drive_folder_url = COALESCE($9, drive_folder_url),
      updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
        AND (status = 'checking' OR (status = 'done' AND report_no = $2))
      RETURNING id, status, finished_at`,
    params: [setId, report.report_no, report.report_rev, report.check_no, report.status,
      set.robot_note ?? null, set.drive_folder_path ?? null, set.drive_folder_id ?? null,
      set.drive_folder_url ?? (set.drive_folder_id ? `https://drive.google.com/drive/folders/${set.drive_folder_id}` : null)],
  };
}
