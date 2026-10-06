// The AVS check's own way in to CI Plant: a key instead of an ERP login.
//
// A photo uploaded while the Google Drive link is not set up (or when Drive
// refused it) is kept in CI Plant, in avs.check_photo_bytes (avs-intake.js).
// The AVS check — the routine at claude.ai, or Claude in Cowork — fetches it
// here, checks it, files it in the AVS folder, and then marks it filed in
// Supabase (stored = 'drive'), which drops the kept copy.
//
//   GET /api/avs/robot/photos/:id      header  x-avs-robot-key: <avs.settings robot_key>
//   GET /api/avs/robot/queue           the office runner (CARTON PC MAIN) asks
//                                      every few seconds: it says it is alive and
//                                      gets the sets Verify left to it.
//
//   GET  /api/avs/robot/docs/:id       a document kept in CI Plant (avs-docs.js)
//   POST /api/avs/robot/file-report the check saves its report in one call
//                                      (avs-file-report.js; runbook 2C.5).
//
// The key is made by CI Plant with the first kept photo and lives
// only in avs.settings, which the check reads through the Supabase connector;
// it is never sent to a browser. Mounted before requireAuth (app.js).
import { Router } from 'express';
import crypto from 'node:crypto';
import { one, q, tx } from '../db.js';
import { filingProblems, reportUpsert, problemUpsert, photoFiled, setDone, docsUsed } from '../avs-file-report.js';
import { cloudFallback } from './avs-intake.js';
import { markUncacheable } from '../data-tables.js';
import { jobSnapshot } from '../avs-snapshot.js';

const r = Router();
const MISSING = new Set(['42P01', '3F000']); // the avs schema exists only on production

// Compared as digests, so the time taken says nothing about the key.
const sameKey = (given, real) => {
  if (!given || !real) return false;
  const digest = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(digest(given), digest(real));
};

const keyOk = async req => {
  const key = await one(`SELECT value FROM avs.settings WHERE key = 'robot_key'`);
  return sameKey(req.get('x-avs-robot-key'), key?.value);
};

// The office runner: records that it is alive (avs.settings local_runner_seen_at,
// which Verify reads), and gets the sets waiting for it. A set it did not
// start in time has gone to the cloud routine by then (cloudFallback).
r.get('/avs/robot/queue', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const who = String(req.get('x-avs-runner') || 'office runner').replace(/[^\w .@()-]/g, '').slice(0, 60);
    await q(`INSERT INTO avs.settings (key, value, note) VALUES ('local_runner_seen_at', $1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = EXCLUDED.note`,
      [new Date().toISOString(), `last asked by ${who}`]);
    await cloudFallback().catch(e => console.warn('[avs] cloud fallback:', e.message));
    const sets = await q(`SELECT id, queued_at, jc_number FROM avs.check_requests
       WHERE status = 'queued' AND fire_status = 'local' ORDER BY id`);
    const checking = await one(`SELECT count(*)::int AS n FROM avs.check_requests
       WHERE status = 'checking' AND claimed_at > now() - interval '3 hours'`);
    res.json({ ok: true, queued: sets, checking: checking.n, now: new Date().toISOString() });
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

// A document CI Plant kept because Google Drive could not take it (avs-docs.js).
r.get('/avs/robot/docs/:id', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const id = Number(req.params.id);
    const doc = Number.isInteger(id) && id > 0 && await one(`
      SELECT d.id, d.file_name, d.mime, d.sha256, d.stored, d.drive_url, d.url, b.bytes
        FROM avs.check_docs d LEFT JOIN avs.check_doc_bytes b ON b.doc_id = d.id WHERE d.id = $1`, [id]);
    if (!doc) return res.status(404).json({ error: 'No such document.' });
    if (!doc.bytes) return res.status(410).json({ error: 'This document is not kept in CI Plant.', stored: doc.stored, drive_url: doc.drive_url, url: doc.url });
    res.set({
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name || 'document')}`,
      'X-Doc-Sha256': doc.sha256 || '',
    });
    res.end(doc.bytes);
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

r.get('/avs/robot/photos/:id', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) {
      return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    }
    const id = Number(req.params.id);
    const photo = Number.isInteger(id) && id > 0 && await one(`
      SELECT p.id, p.file_name, p.mime, p.sha256, p.stored, p.drive_url, p.filed_path, b.bytes
        FROM avs.check_photos p LEFT JOIN avs.check_photo_bytes b ON b.photo_id = p.id
       WHERE p.id = $1`, [id]);
    if (!photo) return res.status(404).json({ error: 'No such photo.' });
    if (!photo.bytes) {
      return res.status(410).json({
        error: 'This photo is no longer kept in CI Plant: it is in the AVS folder in Google Drive.',
        stored: photo.stored, drive_url: photo.drive_url, filed_path: photo.filed_path,
      });
    }
    res.set({
      'Content-Type': photo.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(photo.file_name)}`,
      'X-Photo-Sha256': photo.sha256 || '',
    });
    res.end(photo.bytes);
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

// Everything the check reads about a set's job, in ONE answer (6 Oct 2026;
// runbook 2C.3a). avs_prefetch.py saves it as snapshot.json while Claude reads
// the photos, so the 6 to 10 connector SELECTs of 2.5b / 2.5c are not needed.
//   GET /api/avs/robot/job-snapshot/:setId   header x-avs-robot-key
// Read only: avs-snapshot.js only SELECTs.
r.get('/avs/robot/job-snapshot/:setId', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const id = Number(req.params.setId);
    const set = Number.isInteger(id) && id > 0 && await one(`SELECT * FROM avs.check_requests WHERE id = $1`, [id]);
    if (!set) return res.status(404).json({ error: 'No such set.' });
    const started = Date.now();
    const snap = await jobSnapshot((text, params) => q(text, params), set);
    res.json({ ok: true, ms: Date.now() - started, ...snap });
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    next(e);
  }
});

// The check's report, saved in ONE call (5 Oct 2026; runbook 2C.5). avs_file.py
// posts the avs.reports row, its problem points, the filed photos and the set's
// result; they are written together or not at all. Before this the check sent
// the same values through the Supabase connector, which timed out on the long
// findings text and cost 4 to 10 minutes a report (AVS time study, 5 Oct 2026).
//   POST /api/avs/robot/file-report   header x-avs-robot-key   body: avs-file-report.js
// A cancelled or deleted set is refused by the database itself (AVS_CANCELLED /
// AVS_DELETED); the answer carries that text so the check stops as its prompt says.
r.post('/avs/robot/file-report', async (req, res, next) => {
  try {
    markUncacheable();
    res.set('Cache-Control', 'no-store');
    if (!await keyOk(req)) return res.status(401).json({ error: 'Wrong or missing robot key (avs.settings robot_key).' });
    const p = req.body;
    const problems = filingProblems(p);
    if (problems.length) return res.status(400).json({ error: 'The report was not saved.', problems });
    const started = Date.now();
    const out = await tx(async (qc, oc) => {
      const up = reportUpsert(p.report);
      const rep = await oc(up.text, up.params);
      for (const prob of p.problems ?? []) {
        const pu = problemUpsert(rep.id, rep.report_no, prob);
        await qc(pu.text, pu.params);
      }
      const photos = [];
      for (const ph of p.photos ?? []) {
        const pf = photoFiled(p.set_id, ph);
        const row = await oc(pf.text, pf.params);
        if (!row) throw Object.assign(new Error(`Photo ${ph.id} is not a photo of set ${p.set_id}.`), { status: 409 });
        photos.push(row.id);
      }
      const sd = setDone(p.set_id, p.report, p.set ?? {});
      const set = await oc(sd.text, sd.params);
      if (!set) {
        const now = await oc(`SELECT status, deleted_at, report_no FROM avs.check_requests WHERE id = $1`, [p.set_id]);
        throw Object.assign(new Error(now
          ? `Set ${p.set_id} is ${now.deleted_at ? 'deleted' : now.status}${now.report_no ? ` (report ${now.report_no})` : ''}: nothing was saved.`
          : `There is no set ${p.set_id}: nothing was saved.`), { status: 409 });
      }
      const docs = p.docs_used?.length ? await qc(docsUsed(p.docs_used, p.report).text, docsUsed(p.docs_used, p.report).params) : [];
      const latest = await oc(`SELECT report_no, report_rev, check_no, status FROM avs.latest_reports
        WHERE report_no = $1`, [rep.report_no]);
      return { report: rep, problems: (p.problems ?? []).length, photos, set, latest, docs_used: docs.map(d => +d.id) };
    });
    // QA decisions since the last run (2.8b step 3), read here so the check needs no other query.
    const since = typeof p.decisions_since === 'string' && !Number.isNaN(Date.parse(p.decisions_since)) ? p.decisions_since : null;
    const decisions = since ? await q(`SELECT report_no, report_rev, check_no, decision, decided_by, remark, decided_at, undoes_id
       FROM avs.decisions WHERE decided_at > $1::timestamptz ORDER BY decided_at`, [since]) : [];
    res.json({ ok: true, ms: Date.now() - started, ...out, decisions });
  } catch (e) {
    if (MISSING.has(e?.code)) return res.status(404).json({ error: 'AVS is not set up on this database.' });
    const msg = String(e?.message || e);
    if (/AVS_(CANCELLED|DELETED)/.test(msg)) return res.status(409).json({ error: msg, stop: true });
    if (e?.status === 409) return res.status(409).json({ error: msg });
    if (['23514', '22P02', '22007', '22008', '23502'].includes(e?.code)) {
      return res.status(400).json({ error: `The database refused a value: ${msg}` });
    }
    next(e);
  }
});

export default r;
