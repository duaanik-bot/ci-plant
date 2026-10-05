// AVS: fix a photo set before Verify, add documents, and re-check with them
// (owner's request, 5 Oct 2026).
//
//   - Remove a photo from a set that is still taking photos (before Verify), to
//     take or choose it again. Removed for good (owner's choice): the row and any
//     copy CI Plant kept are deleted and the Drive file goes to the bin; the
//     audit trail keeps who removed which photo and when.
//   - Documents with a set: the PO, the customer's approval, the artwork, an
//     e-mail (file or link) or anything else that helps the check. A file goes to
//     Google Drive beside the photos ("<set folder>/Documents"), or is kept in CI
//     Plant while Drive cannot take it (the check fetches it with the robot key,
//     routes/avs-robot.js). Claude reads them first and still cross-checks them
//     (runbook 2.4c). They can be added before Verify, while the check waits, or
//     after the report.
//   - A document can be removed for good until a finished check has used it.
//   - Re-check with new documents: documents added after the report wait for this
//     button. It makes the report's next check (Check n+1) from the SAME photos
//     (photos_from_set_id) plus every document, and starts Claude at once.
import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { one, tx } from '../db.js';
import { optionalText } from '../helpers.js';
import { requireRole } from '../auth.js';
import { avsAudit } from '../avs-audit.js';
import { avsSettings, callDrive, fireUnlessRunning, istDay, linked, readSets } from './avs-intake.js';
import {
  AVS_DOC_MAX_BYTES, AVS_REMARK_MAX, AVS_SET_MAX_DOCS, avsSetFolder, docMime, docProblem, docRemovable, newDocsSinceReport, setLabel,
} from '../../../client/src/lib/avs.js';

const r = Router();
const fail = (status, message) => Object.assign(new Error(message), { status });
const toId = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const canUpload = requireRole('qc', 'production', 'planner');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AVS_DOC_MAX_BYTES }, defParamCharset: 'utf8' });
const maybeFile = (req, res, next) => upload.single('file')(req, res, err => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE'
    ? 'The file is over 4 MB. Save a smaller copy (or paste its Drive link) and try again.' : err.message });
});
const cleanName = name => String(name || 'document').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(-100) || 'document';

const openSet = async id => {
  const set = id && await one('SELECT * FROM avs.check_requests WHERE id = $1', [id]);
  if (!set || set.deleted_at) throw fail(404, 'Photo set not found');
  return set;
};
const setFolder = set => set.drive_folder_path || avsSetFolder({ id: set.id, day: istDay(set.created_at), jc_number: set.jc_number });

// The Drive file of a removed photo or document goes to the bin. A Drive link
// deployed before 5 Oct 2026 has no "trash": the file is then moved out of the
// set into "AVS CHECK/_REMOVED", so the check never sees it.
async function dropFromDrive(fileId) {
  if (!fileId) return null;
  const cfg = await avsSettings();
  if (!linked(cfg).drive) return 'the Drive link is not set up; the Drive copy was left';
  try {
    await callDrive(cfg, { op: 'trash', id: fileId }, { tries: 1 });
    return 'moved to the Google Drive bin';
  } catch (e) {
    if (!/Unknown op/i.test(e.message)) return `Google Drive: ${e.message}`;
    try {
      await callDrive(cfg, { op: 'move', id: fileId, to: 'AVS CHECK/_REMOVED' }, { tries: 1 });
      return 'moved to AVS CHECK/_REMOVED in Google Drive';
    } catch (e2) { return `Google Drive: ${e2.message}`; }
  }
}

// ── Remove a photo before Verify ────────────────────────────────────────────
r.post('/avs/uploads/:id/photos/:photoId/delete', canUpload, async (req, res, next) => {
  try {
    const set = await openSet(toId(req.params.id));
    if (set.status !== 'uploading') {
      throw fail(409, `${setLabel(set.id)} was already sent for checking, so its photos stay with the check. `
        + 'Cancel or delete the set to start again.');
    }
    const photoId = toId(req.params.photoId);
    const photo = await tx(async (qc, oc) => {
      const p = await oc(`SELECT id, seq, file_name, sha256, drive_file_id FROM avs.check_photos
        WHERE id = $1 AND request_id = $2`, [photoId, set.id]);
      if (!p) throw fail(404, `That photo is not in ${setLabel(set.id)}.`);
      // Still open in this transaction: a Verify at the same moment waits for it.
      const still = await oc(`SELECT 1 AS x FROM avs.check_requests WHERE id = $1 AND status = 'uploading' FOR UPDATE`, [set.id]);
      if (!still) throw fail(409, `${setLabel(set.id)} was just sent for checking.`);
      await qc('DELETE FROM avs.check_photo_bytes WHERE photo_id = $1', [p.id]);
      await qc('DELETE FROM avs.check_photos WHERE id = $1', [p.id]);
      await avsAudit(qc, { action: 'PHOTO_REMOVED', setId: set.id, reportNo: set.redo_report_no || null, user: req.user,
        details: { seq: p.seq, file_name: p.file_name, sha256: p.sha256, drive_file_id: p.drive_file_id } });
      return p;
    });
    const drive = await dropFromDrive(photo.drive_file_id);
    const [out] = await readSets({ id: set.id });
    res.json({ ...out, removed: { id: photo.id, file_name: photo.file_name, drive } });
  } catch (e) { next(e); }
});

// ── Add a document (file or link) ───────────────────────────────────────────
r.post('/avs/uploads/:id/docs', canUpload, maybeFile, async (req, res, next) => {
  try {
    const set = await openSet(toId(req.params.id));
    if (set.status === 'cancelled') throw fail(409, `${setLabel(set.id)} was cancelled. Add the document to a new set.`);
    const kind = String(req.body?.kind || '').trim();
    const title = optionalText(req.body?.title);
    const note = optionalText(req.body?.note);
    if (note && note.length > AVS_REMARK_MAX) throw fail(400, `Keep the note under ${AVS_REMARK_MAX} characters.`);
    const url = req.file ? null : optionalText(req.body?.url);
    const file = req.file || null;
    if (!file && !url) throw fail(400, 'Add a file or paste a link.');
    const mime = file ? docMime(file.originalname, file.mimetype) : null;
    const problem = docProblem({ kind, url, title, size: file?.size, type: mime });
    if (problem) throw fail(400, problem);
    const count = await one('SELECT count(*)::int AS n FROM avs.check_docs WHERE request_id = $1', [set.id]);
    if (count.n >= AVS_SET_MAX_DOCS) throw fail(409, `A set holds at most ${AVS_SET_MAX_DOCS} documents.`);
    const after = set.status === 'done';

    let put = null;
    let driveError = null;
    let name = null;
    let sha256 = null;
    if (file) {
      name = `${kind.toUpperCase()} ${cleanName(file.originalname)}`;
      sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const dup = await one('SELECT id FROM avs.check_docs WHERE request_id = $1 AND sha256 = $2', [set.id, sha256]);
      if (dup) throw fail(409, 'This file is already with the set.');
      const cfg = await avsSettings();
      if (linked(cfg).drive) {
        try {
          put = await callDrive(cfg, { op: 'put', path: `${setFolder(set)}/Documents`, name, mime, base64: file.buffer.toString('base64') },
            { again: { ifExists: 'reuse' } });
          if (!put?.id || Number(put.size) !== file.size) { driveError = 'Google Drive already has a different file of that name'; put = null; }
        } catch (e) { driveError = e.reason || e.message; }
      }
    }
    const doc = await tx(async (qc, oc) => {
      const row = await oc(`INSERT INTO avs.check_docs (request_id, kind, title, url, file_name, mime, size_bytes, sha256,
          drive_file_id, drive_url, stored, note, added_by, added_by_user_id, added_by_role, added_after_report)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
      [set.id, kind, title ? title.slice(0, 200) : null, url, name, mime, file?.size ?? null, sha256,
        put?.id || null, put?.url || null, url ? 'link' : put ? 'drive' : 'ci_plant', note,
        req.user.name ?? null, req.user.id ?? null, req.user.role ?? null, after]);
      if (file && !put) await qc('INSERT INTO avs.check_doc_bytes (doc_id, bytes) VALUES ($1, $2)', [row.id, file.buffer]);
      await avsAudit(qc, { action: 'DOC_ADDED', setId: set.id, reportNo: set.report_no || set.redo_report_no || null, user: req.user,
        details: { doc_id: +row.id, kind, title: title || null, file_name: name, url, after_report: after } });
      return row;
    });
    const [out] = await readSets({ id: set.id });
    res.status(201).json({ ...out, last_doc: { id: +doc.id, stored: url ? 'link' : put ? 'drive' : 'ci_plant', drive_error: driveError } });
  } catch (e) { next(e); }
});

// ── Remove a document for good (until a finished check has used it) ─────────
r.post('/avs/uploads/:id/docs/:docId/delete', canUpload, async (req, res, next) => {
  try {
    const set = await openSet(toId(req.params.id));
    const docId = toId(req.params.docId);
    const doc = await tx(async (qc, oc) => {
      const d = await oc('SELECT * FROM avs.check_docs WHERE id = $1 AND request_id = $2 FOR UPDATE', [docId, set.id]);
      if (!d) throw fail(404, `That document is not with ${setLabel(set.id)}.`);
      if (!docRemovable(d)) throw fail(409, `${d.used_in_report} used this document, so it stays on record with that report.`);
      await qc('DELETE FROM avs.check_docs WHERE id = $1', [d.id]);
      await avsAudit(qc, { action: 'DOC_REMOVED', setId: set.id, reportNo: set.report_no || set.redo_report_no || null, user: req.user,
        details: { doc_id: +d.id, kind: d.kind, title: d.title, file_name: d.file_name, url: d.url, sha256: d.sha256 } });
      return d;
    });
    const drive = doc.stored === 'drive' ? await dropFromDrive(doc.drive_file_id) : null;
    const [out] = await readSets({ id: set.id });
    res.json({ ...out, removed: { id: +doc.id, drive } });
  } catch (e) { next(e); }
});

// ── Re-check with new documents ─────────────────────────────────────────────
// The report's next check (Check n+1, runbook rule 21) from the same photos and
// every document; Claude is started at once. One open re-check per report.
r.post('/avs/uploads/:id/recheck', canUpload, async (req, res, next) => {
  try {
    const set = await openSet(toId(req.params.id));
    if (set.status !== 'done' || !set.report_no) throw fail(409, `${setLabel(set.id)} has no report yet: its documents are read when it is checked.`);
    const [full] = await readSets({ id: set.id });
    const fresh = newDocsSinceReport(full);
    if (!fresh.length) throw fail(400, 'Add the new documents first (PO, approval, artwork or e-mail), then re-check.');
    const reason = optionalText(req.body?.reason)
      || `New documents added after the report: ${fresh.map(d => d.title || d.file_name || d.url).join('; ')}`.slice(0, AVS_REMARK_MAX);
    const latest = await one(`SELECT report_no FROM avs.latest_reports WHERE report_no = $1`, [set.report_no]);
    if (!latest) throw fail(404, `${set.report_no} not found (deleted?).`);
    const closed = await one(`SELECT 1 AS x FROM avs.reports WHERE report_no = $1 AND row_type = 'CLOSE' LIMIT 1`, [set.report_no]);
    if (closed) throw fail(409, `${set.report_no} was closed by the owner, so it cannot be checked again.`);
    const photosFrom = set.photos_from_set_id || set.id;

    let made;
    try {
      made = await tx(async (qc, oc) => {
        const row = await oc(`INSERT INTO avs.check_requests
            (status, job_card_id, jc_number, product_hint, note, created_by, created_by_user_id, created_by_role,
             redo_report_no, redo_of_set_id, redo_reason, job_cards, photos_from_set_id, drive_folder_path, drive_folder_id,
             drive_folder_url, queued_at, queued_by)
          VALUES ('queued', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $5) RETURNING *`,
        [set.job_card_id, set.jc_number, set.product_hint, `Re-check with new documents (same photos as ${setLabel(photosFrom)})`,
          req.user.name ?? null, req.user.id ?? null, req.user.role ?? null,
          set.report_no, set.id, reason, Array.isArray(set.job_cards) && set.job_cards.length ? JSON.stringify(set.job_cards) : null,
          photosFrom, set.drive_folder_path, set.drive_folder_id, set.drive_folder_url]);
        // The new documents go with the new check; the earlier ones stay where they are (the check reads both).
        await qc(`UPDATE avs.check_docs SET request_id = $1 WHERE request_id = $2 AND added_after_report AND used_in_report IS NULL`,
          [row.id, set.id]);
        await avsAudit(qc, { action: 'RECHECK_WITH_DOCS', reportNo: set.report_no, setId: row.id, user: req.user, reason,
          details: { redo_of_set_id: set.id, photos_from_set_id: photosFrom, docs: fresh.map(d => +d.id) } });
        return row;
      });
    } catch (e) {
      if (e?.code === '23505') throw fail(409, `${set.report_no} is already being checked again. Reload the page.`);
      throw e;
    }
    const fire = await fireUnlessRunning(await avsSettings(), made);
    const [out] = await readSets({ id: made.id });
    res.status(201).json({ set: out, fire });
  } catch (e) { next(e); }
});

export default r;
