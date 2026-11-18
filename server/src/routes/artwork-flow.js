// The artwork workflow's buttons (owner, 17 Nov 2026; design plans/2026-11-17-artwork-workflow-design.md):
//
//   POST /api/artwork/export/start | PUT /api/artwork/export/:up/chunk/:n | POST /api/artwork/export/:up/finish
//        the CorelDRAW button on a designer's PC (header x-artwork-key) — mounted before the login check
//   POST /api/artwork/register/versions/:id/export/start (+ the same chunk / finish under /api/artwork/register/export)
//        "Upload designer's PDF" in the window, with the person's login
//   POST /api/artwork/register/exports/:id/match          { version_id } — a person puts an unmatched export on its job
//   POST /api/artwork/register/send-for-approval          { version_ids } — proof + one reply-all DRAFT per thread + Drive
//   POST /api/artwork/register/send-email                 { proof_mail_ids } — sends the reviewed drafts (the ONE client send)
//   POST /api/artwork/register/cancel-draft               { proof_mail_ids }
//   POST /api/artwork/register/decide                     { version_ids, verdict: approved | changes, note }
//   POST /api/artwork/register/release                    { version_ids } — Send to plates (recorded; plate mail is later)
//   POST /api/artwork/register/delete | /restore          { version_ids, reason } — hidden with a reason, never erased
//   GET/POST /api/artwork/register/keys, POST …/keys/:id/off   the designers' PC keys (admin)
//
// Behind the Artwork tick (everyone with it may send — owner, 17 Nov). Each button acts only on versions whose stage
// offers it (artwork-flow.js actionsFor); the others in a selection are answered "skipped" with the reason.
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit } from '../helpers.js';
import { mayArtwork } from '../artwork-intake.js';
import { actionsFor, groupByThread, proofNo, proofMailText } from '../artwork-flow.js';
import { buildProof } from '../artwork-proof.js';
import { readArtworkFromDrive, saveArtworkToDrive } from '../gdrive.js';
import { replyHeaders, replyAll, buildMime, saveDraftUpload, sendDraft, draftHeaders, approvalSent, deleteDraft, APPROVAL_HEADER } from '../gmail.js';
import { CHUNK, hashKey, keyOf, startUpload, putChunk, finishUpload, matchByHand, businessDrive } from '../artwork-upload.js';
import { moveStage, tickOrderLines } from '../artwork-approval.js';
import { markSent, cancelDraftsOf, settleProofMails } from '../artwork-settle.js';

const raw = express.raw({ type: () => true, limit: CHUNK + 1024 });
const idOf = v => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const ids = v => [...new Set((Array.isArray(v) ? v : []).map(idOf).filter(Boolean))].slice(0, 200);
const text = v => String(v ?? '').trim();
const wrap = fn => async (req, res, next) => {
  try { res.json(await fn(req, res)); } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); next(e); }
};
const fail = (status, error) => Object.assign(new Error(error), { status });

// ── the CorelDRAW button (a PC's key, no login) ─────────────────────────────────────────────────────────────────
export const artworkExportRouter = Router();
const keyed = async req => {
  const k = await keyOf(req.get('x-artwork-key'));
  if (!k) throw fail(401, 'This PC\'s artwork key is wrong or switched off — ask an admin for a key (Artwork › Designer PCs).');
  return { key_id: k.id, by_name: k.name };
};
artworkExportRouter.post('/artwork/export/start', wrap(async req => startUpload(await keyed(req), req.body)));
artworkExportRouter.put('/artwork/export/:up/chunk/:n', raw, wrap(async req => putChunk(req.params.up, req.params.n, req.body, await keyed(req))));
artworkExportRouter.post('/artwork/export/:up/finish', wrap(async req => finishUpload(req.params.up, await keyed(req))));

// ── the window's buttons (login + Artwork tick) ────────────────────────────────────────────────────────────────
const r = Router();
r.use('/artwork/register', async (req, res, next) => {
  try {
    const u = await one('SELECT id, name, role, modules, active FROM users WHERE id = $1', [idOf(req.user?.id)]);
    if (!u || !+u.active || !mayArtwork(u)) return res.status(403).json({ error: 'Artwork is not ticked for this login.', code: 'ARTWORK_REFUSED' });
    req.artworkUser = u;
    next();
  } catch (e) { next(e); }
});
const who = req => req.artworkUser?.name || req.user?.name || 'someone';
const person = req => ({ key_id: null, by_name: who(req) });

r.post('/artwork/register/versions/:id/export/start', wrap(async req => {
  const id = idOf(req.params.id);
  if (!id) throw fail(404, 'No such version.');
  return startUpload({ ...person(req), version_id: id }, req.body);
}));
r.put('/artwork/register/export/:up/chunk/:n', raw, wrap(async req => putChunk(req.params.up, req.params.n, req.body, { key_id: null })));
r.post('/artwork/register/export/:up/finish', wrap(async req => finishUpload(req.params.up, { key_id: null })));
r.post('/artwork/register/exports/:id/match', wrap(async req => matchByHand(idOf(req.params.id), idOf(req.body?.version_id), who(req))));

// The versions of a selection as the buttons need them: stage, job, the client's mail and thread, latest export.
async function picked(versionIds) {
  const rows = await q(`
    SELECT v.id, v.job_id, v.label, v.stage, v.status, v.deleted_at, v.first_mail_id,
           j.job_no, j.customer_name, j.product_id, j.product_name, j.client_item_code,
           m.gmail_thread_id, m.gmail_message_id, m.subject,
           EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork') AS superseded,
           (SELECT row_to_json(e) FROM (SELECT id, file_name, drive_file_id, size_bytes, page_w_mm, page_h_mm, colours FROM artwork_exports
              WHERE version_id = v.id ORDER BY id DESC LIMIT 1) e) AS export
      FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id LEFT JOIN artwork_mails m ON m.id = v.first_mail_id
     WHERE v.id = ANY($1::int[])`, [versionIds]);
  const byId = new Map(rows.map(x => [x.id, x]));
  return versionIds.map(i => byId.get(i)).filter(Boolean);
}
const skipped = (v, why) => ({ version_id: v.id, label: `${v.job_no} ${v.label}`, why });

// Send for approval: for each client thread, a proof per version (designer's export + strip + stamp), saved to Drive,
// and ONE reply-all draft carrying them all. Nothing is sent.
// The versions are claimed first (building_at), so two presses never build twice; one press builds for about 20
// seconds (the server stops a request at 30) and leaves the rest for the next press; one mail carries at most 17 MB of
// proofs (Gmail's limit is 25 MB after encoding). Each mail carries CI Plant's mark (X-CIPlant-Approval), so Gmail can
// later be asked, strictly, whether THIS mail went.
const BUDGET_MS = 20000;          // stop starting new mails after this
const LAST_CALL_MS = 23000;       // never hand a draft to Gmail after this (the server stops the request at 30 s)
const MAIL_MAX = 17 * 1024 * 1024;
r.post('/artwork/register/send-for-approval', wrap(async req => {
  const started = Date.now();
  const all = await picked(ids(req.body?.version_ids));
  const out = { drafts: [], skipped: [] };
  const want = [];
  for (const v of all) {
    if (!actionsFor(v).includes('send_for_approval')) out.skipped.push(skipped(v, `is "${v.stage}", not waiting to go for approval`));
    else if (!v.export?.drive_file_id) out.skipped.push(skipped(v, 'has no designer\'s export yet'));
    else want.push(v);
  }
  if (!want.length) return out;
  const claimed = new Set((await q(`UPDATE artwork_versions SET building_at = now()
                                     WHERE id = ANY($1::int[]) AND stage = 'designer_file' AND deleted_at IS NULL
                                       AND (building_at IS NULL OR building_at < now() - interval '2 minutes') RETURNING id`, [want.map(v => v.id)])).map(x => x.id));
  const ready = want.filter(v => claimed.has(v.id));
  for (const v of want) if (!claimed.has(v.id)) out.skipped.push(skipped(v, 'is being built by another press right now'));
  if (!ready.length) return out;
  try {
    const drive = await businessDrive();
    for (const group of groupByThread(ready)) {
      if (Date.now() - started > BUDGET_MS) {
        for (const v of group) out.skipped.push(skipped(v, 'not built yet — press Send for approval again for the rest'));
        continue;
      }
      const bytes = group.reduce((n, v) => n + Number(v.export.size_bytes || 0), 0);
      if (bytes > MAIL_MAX) {
        for (const v of group) out.skipped.push(skipped(v, `its proofs come to ${(bytes / 1048576).toFixed(1)} MB — too big for one approval mail; select fewer at a time or make the export smaller`));
        continue;
      }
      let draft = null;
      try {
        const proofs = [];
        for (const v of group) {
          const n = Number((await one('SELECT count(*)::int AS n FROM artwork_proofs WHERE version_id = $1', [v.id])).n) + 1;
          const no = proofNo(v.job_no, v.label, n);
          const pdfBytes = await readArtworkFromDrive({ token: drive.token, fileId: v.export.drive_file_id });
          const built = await buildProof({ pdfBytes, info: { proof_no: no, date: new Date().toISOString(), customer: v.customer_name,
            product_name: v.product_name, client_item_code: v.client_item_code, label: v.label, colours: v.export.colours || [] } });
          const name = `${no}.pdf`;
          const saved = await saveArtworkToDrive({ token: drive.token, fileName: name, bytes: built.bytes, shareWith: drive.shareWith });
          proofs.push({ v, no, built, name, saved });
        }
        const head = group[0];
        const hdr = head.gmail_message_id ? await replyHeaders(drive.token, head.gmail_message_id) : {};
        const { to, cc } = replyAll(hdr, drive.link.email);
        if (!to.length) throw fail(409, 'The client\'s mail has no address to reply to — open the mail in Gmail.');
        const mail = proofMailText({ subject: head.subject, proofs: proofs.map(p => ({ proof_no: p.no, product_name: p.v.product_name,
          client_item_code: p.v.client_item_code, label: p.v.label, page_w_mm: p.built.page_w_mm, page_h_mm: p.built.page_h_mm, colours: p.v.export.colours || [] })) });
        const builtBytes = proofs.reduce((n, p) => n + p.built.bytes.length, 0);
        if (builtBytes > MAIL_MAX) throw fail(413, `the proofs come to ${(builtBytes / 1048576).toFixed(1)} MB — too big for one approval mail; select fewer at a time`);
        if (Date.now() - started > LAST_CALL_MS) throw fail(408, 'not built yet (time ran out on this press) — press Send for approval again');
        const token = crypto.randomBytes(12).toString('hex');
        const mime = buildMime({ from: drive.link.email, to, cc, subject: mail.subject, text: mail.text, inReplyTo: hdr.inReplyTo, references: hdr.references,
          headers: { [APPROVAL_HEADER]: token },
          attachments: proofs.map(p => ({ name: p.name, mime: 'application/pdf', bytes: Buffer.from(p.built.bytes) })) });
        draft = await saveDraftUpload(drive.token, { email: drive.link.email, mime, threadId: hdr.threadId || head.gmail_thread_id || undefined });
        draft.token = token;
        const thread = draft.thread_id || head.gmail_thread_id;
        const pmId = await tx(async (qc, oc) => {
          const pm = await oc(`INSERT INTO artwork_proof_mails (gmail_thread_id, reply_to_mail_id, version_ids, to_text, cc_text, subject, body_text,
                                                               gmail_draft_id, gmail_message_id, draft_url, created_by, mail_token)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [thread, head.first_mail_id, group.map(v => v.id), to.join(', '), cc.join(', '), mail.subject, mail.text,
            draft.draft_id, draft.message_id, draft.view_url, who(req), draft.token]);
          for (const p of proofs) {
            await qc(`INSERT INTO artwork_proofs (proof_no, version_id, export_id, proof_mail_id, sha256, file_name, drive_file_id, drive_url, gmail_thread_id)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [p.no, p.v.id, p.v.export.id, pm.id, p.built.sha256, p.name, p.saved.file_id, p.saved.link, thread]);
          }
          await moveStage(qc, { versionIds: group.map(v => v.id), to: 'proof_ready', from: ['designer_file'], by: who(req), action: 'proof_ready',
            detail: { proof_mail_id: pm.id, proofs: proofs.map(p => p.no) } });
          await audit('artwork_proof_mail', pm.id, 'draft', `Approval mail drafted — ${proofs.map(p => p.no).join(', ')}`, qc, who(req));
          return pm.id;
        });
        out.drafts.push({ proof_mail_id: pmId, versions: group.map(v => v.id), proofs: proofs.map(p => p.no), draft_url: draft.view_url, to, cc });
      } catch (e) {
        // a draft made but not recorded is taken out of Gmail again, so no unrecorded mail waits in Drafts
        if (draft?.draft_id) await deleteDraft(drive.token, { draftId: draft.draft_id }).catch(() => {});
        if (!e.status && !e.gmail) throw e;
        for (const v of group) out.skipped.push(skipped(v, e.message));
      }
    }
  } finally {
    await q(`UPDATE artwork_versions SET building_at = NULL WHERE id = ANY($1::int[])`, [[...claimed]]);
  }
  return out;
}));

// Send email: each reviewed draft goes as it stands in Gmail — only while every version on it is still waiting
// ("proof ready"), live and the newest of its job. The row is claimed first ('sending'), so two presses never send
// twice. Before sending, Gmail is asked: a draft changed in Gmail is not sent from here (nobody reviewed the change); a
// draft already sent (from Gmail, or by a press whose answer was lost) is recorded as sent, never sent again.
const CLAIM = `
  UPDATE artwork_proof_mails pm SET status = 'sending', error = NULL, claimed_at = now()
   WHERE pm.id = $1 AND pm.status = 'draft'
     AND NOT EXISTS (SELECT 1 FROM artwork_versions v WHERE v.id = ANY(pm.version_ids)
                       AND (v.stage <> 'proof_ready' OR v.deleted_at IS NOT NULL OR v.status = 'not_artwork'
                            OR EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork')))
  RETURNING *`;
async function whyNotSendable(id) {
  const pm = await one('SELECT status, version_ids FROM artwork_proof_mails WHERE id = $1', [id]);
  if (!pm) return 'no such approval mail';
  if (pm.status !== 'draft') return `is ${pm.status}, not a draft waiting to be sent`;
  const bad = await one(`SELECT v.id, v.stage, v.status, v.deleted_at, EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork') AS newer
                           FROM artwork_versions v WHERE v.id = ANY($1::int[])
                            AND (v.stage <> 'proof_ready' OR v.deleted_at IS NOT NULL OR v.status = 'not_artwork'
                                 OR EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork'))
                          LIMIT 1`, [pm.version_ids]);
  if (!bad) return 'is being sent by another press right now';
  return bad.deleted_at ? 'its version was deleted' : bad.status === 'not_artwork' ? 'its version was marked not artwork'
    : bad.newer ? 'a newer version of the job came in — this proof is replaced; build a new one'
      : `its version is "${bad.stage}" now — refresh the window`;
}
r.post('/artwork/register/send-email', wrap(async req => {
  const list = ids(req.body?.proof_mail_ids);
  const out = { sent: [], skipped: [] };
  if (!list.length) return out;
  const drive = await businessDrive();
  await settleProofMails({ ids: list, max: list.length });          // a press whose answer was lost earlier is settled first
  for (const id of list) {
    const pm = await one(CLAIM, [id]);
    if (!pm) { out.skipped.push({ proof_mail_id: id, why: await whyNotSendable(id) }); continue; }
    const back = async why => {
      await q(`UPDATE artwork_proof_mails SET status = 'draft', error = $2 WHERE id = $1 AND status = 'sending'`, [id, String(why).slice(0, 300)]);
      out.skipped.push({ proof_mail_id: id, why });
    };
    try {
      const now = await draftHeaders(drive.token, { draftId: pm.gmail_draft_id });
      if (!now || now.sent) {
        // gone, or sent from Gmail: was it sent? then it is recorded — never sent a second time
        const s = now?.sent ? { sent: true, at: now.at || new Date().toISOString(), message_id: now.message_id }
          : await approvalSent(drive.token, { draftId: pm.gmail_draft_id, threadId: pm.gmail_thread_id, marker: pm.mail_token });
        if (s.sent) {
          await markSent(id, { at: s.at, messageId: s.message_id, by: `${who(req)} (it had already gone from Gmail)` });
          out.sent.push({ proof_mail_id: id, to: pm.to_text, already: true });
        } else await back('The draft is no longer in Gmail and was not sent — press Cancel draft, then Send for approval again.');
        continue;
      }
      if (pm.gmail_message_id && now.message_id && now.message_id !== pm.gmail_message_id) {
        await back('The draft was changed in Gmail after CI Plant made it, so it is not sent from here — send it from Gmail (CI Plant will see that it went), or Cancel draft and build it again.');
        continue;
      }
      const sent = await sendDraft(drive.token, { draftId: pm.gmail_draft_id });
      await markSent(id, { messageId: sent.message_id, by: who(req) });
      out.sent.push({ proof_mail_id: id, to: now.to || pm.to_text });
    } catch (e) {
      // not known to have gone: back to a draft with the reason (if Gmail did take it, the next press or settle finds it sent)
      await back(e.message);
      if (!e.status && !e.gmail) throw e;
    }
  }
  return out;
}));

r.post('/artwork/register/cancel-draft', wrap(async req => {
  const out = { cancelled: [] };
  let drive = null;
  try { drive = await businessDrive(); } catch { /* not connected: the Gmail draft is deleted by a later settle */ }
  for (const id of ids(req.body?.proof_mail_ids)) {
    const pm = await tx(async (qc, oc) => {
      const row = await oc(`UPDATE artwork_proof_mails SET status = 'cancelled', error = $2 WHERE id = $1 AND status = 'draft' RETURNING id, version_ids, gmail_draft_id`,
        [id, `cancelled by ${who(req)}`]);
      if (!row) return null;
      await moveStage(qc, { versionIds: row.version_ids, to: 'designer_file', from: ['proof_ready'], by: who(req), action: 'draft_cancelled', detail: { proof_mail_id: id } });
      return row;
    });
    if (!pm) continue;
    if (drive) {
      try { await deleteDraft(drive.token, { draftId: pm.gmail_draft_id }); await q(`UPDATE artwork_proof_mails SET draft_deleted_at = now() WHERE id = $1`, [id]); }
      catch (e) { console.warn(`[artwork-flow] draft ${id} not deleted in Gmail: ${e.message}`); }
    }
    out.cancelled.push(id);
  }
  return out;
}));

// Approve / Changes by a person (a WhatsApp or phone approval, or a reply the robot could not read for sure).
r.post('/artwork/register/decide', wrap(async req => {
  const verdict = text(req.body?.verdict), note = text(req.body?.note);
  if (!['approved', 'changes'].includes(verdict)) throw fail(400, 'Approved or changes?');
  if (!note) throw fail(400, 'Say how the client answered (e.g. "approved on WhatsApp by Mr X, 17 Nov").');
  const all = await picked(ids(req.body?.version_ids));
  const out = { moved: [], skipped: [], order_lines: 0 };
  await tx(async qc => {
    for (const v of all) {
      if (!actionsFor(v).includes('decide')) { out.skipped.push(skipped(v, `is "${v.stage}" — nothing to decide`)); continue; }
      const m = await moveStage(qc, { versionIds: [v.id], to: verdict, from: ['approval_sent', 'to_confirm', 'changes'], by: who(req), action: `decided_${verdict}`, detail: { note } });
      if (!m.length) continue;
      await qc('UPDATE artwork_versions SET decided_note = $2 WHERE id = $1', [v.id, note]);
      if (verdict === 'approved') out.order_lines += await tickOrderLines(qc, v.id, who(req));
      out.moved.push(v.id);
    }
  });
  return out;
}));

r.post('/artwork/register/release', wrap(async req => {
  const all = await picked(ids(req.body?.version_ids));
  const out = { moved: [], skipped: [] };
  await tx(async qc => {
    for (const v of all) {
      if (!actionsFor(v).includes('release')) { out.skipped.push(skipped(v, `is "${v.stage}", not approved`)); continue; }
      if ((await moveStage(qc, { versionIds: [v.id], to: 'released', from: ['approved'], by: who(req), action: 'released' })).length) out.moved.push(v.id);
    }
  });
  return out;
}));

r.post('/artwork/register/delete', wrap(async req => {
  const reason = text(req.body?.reason);
  if (!reason) throw fail(400, 'Why delete it? (kept with the reason, can be put back)');
  const list = ids(req.body?.version_ids);
  const { rows, drafts } = await tx(async qc => {
    const rows = await qc(`UPDATE artwork_versions SET deleted_at = now(), deleted_reason = $2, deleted_by = $3
                            WHERE id = ANY($1::int[]) AND deleted_at IS NULL RETURNING id, job_id`, [list, reason, who(req)]);
    for (const x of rows) await qc(`INSERT INTO artwork_events (job_id, version_id, action, detail, by_name) VALUES ($1, $2, 'deleted', $3, $4)`, [x.job_id, x.id, JSON.stringify({ reason }), who(req)]);
    // an approval mail of a deleted version must not go
    const drafts = await cancelDraftsOf(qc, rows.map(x => x.id), `version deleted by ${who(req)}`, who(req));
    return { rows, drafts };
  });
  if (drafts.length) {
    try {
      const drive = await businessDrive();
      for (const d of drafts) {
        await deleteDraft(drive.token, { draftId: d.gmail_draft_id });
        await q(`UPDATE artwork_proof_mails SET draft_deleted_at = now() WHERE id = $1`, [d.id]);
      }
    } catch (e) { console.warn(`[artwork-flow] cancelled drafts not deleted in Gmail yet: ${e.message}`); }
  }
  return { deleted: rows.map(x => x.id), drafts_cancelled: drafts.map(d => d.id) };
}));
r.post('/artwork/register/restore', wrap(async req => {
  const rows = await tx(async qc => {
    const back = await qc(`UPDATE artwork_versions SET deleted_at = NULL, deleted_reason = NULL, deleted_by = NULL
                            WHERE id = ANY($1::int[]) AND deleted_at IS NOT NULL RETURNING id, job_id`, [ids(req.body?.version_ids)]);
    for (const x of back) await qc(`INSERT INTO artwork_events (job_id, version_id, action, detail, by_name) VALUES ($1, $2, 'restored', '{}'::jsonb, $3)`, [x.job_id, x.id, who(req)]);
    // its approval mail was cancelled when it was deleted: waiting at "proof ready" with no mail, it goes back a step
    const orphans = await qc(`SELECT v.id FROM artwork_versions v WHERE v.id = ANY($1::int[]) AND v.stage = 'proof_ready'
                                AND NOT EXISTS (SELECT 1 FROM artwork_proof_mails pm WHERE v.id = ANY(pm.version_ids) AND pm.status IN ('draft', 'sending'))`,
    [back.map(x => x.id)]);
    await moveStage(qc, { versionIds: orphans.map(o => o.id), to: 'designer_file', from: ['proof_ready'], by: who(req), action: 'draft_cancelled', detail: { why: 'put back; its approval mail was cancelled' } });
    return back;
  });
  return { restored: rows.map(x => x.id) };
}));

// An export nobody could put on a job, set aside by a person (it stays on Drive).
r.post('/artwork/register/exports/:id/dismiss', wrap(async req => {
  const row = await one(`UPDATE artwork_exports SET dismissed_at = now(), match_note = COALESCE(match_note, '') || $2 WHERE id = $1 AND version_id IS NULL AND dismissed_at IS NULL RETURNING id`,
    [idOf(req.params.id), ` · set aside by ${who(req)}`]);
  if (!row) throw fail(404, 'No such unmatched export.');
  return { dismissed: row.id };
}));

// The designers' PC keys. Admin only; a key is shown once, only its hash is kept.
const admin = req => { if (req.artworkUser?.role !== 'admin') throw fail(403, 'Only an admin manages the designers\' keys.'); };
r.get('/artwork/register/keys', wrap(async req => { admin(req); return { keys: await q('SELECT id, name, active, created_by, created_at, last_used_at FROM artwork_export_keys ORDER BY id') }; }));
r.post('/artwork/register/keys', wrap(async req => {
  admin(req);
  const name = text(req.body?.name).slice(0, 80);
  if (!name) throw fail(400, 'Whose PC is it for? (e.g. "Designer 1 — office PC")');
  const key = `ciaw_${crypto.randomBytes(24).toString('base64url')}`;
  const row = await one(`INSERT INTO artwork_export_keys (name, key_hash, created_by) VALUES ($1, $2, $3) RETURNING id`, [name, hashKey(key), who(req)]);
  await audit('artwork_export_key', row.id, 'create', `Artwork upload key for ${name}`, q, who(req));
  return { id: row.id, name, key, note: 'Copy this key into the CorelDRAW button setup now — it is not shown again.' };
}));
r.post('/artwork/register/keys/:id/off', wrap(async req => {
  admin(req);
  const row = await one(`UPDATE artwork_export_keys SET active = false WHERE id = $1 RETURNING id, name`, [idOf(req.params.id)]);
  if (!row) throw fail(404, 'No such key.');
  await audit('artwork_export_key', row.id, 'off', `Artwork upload key for ${row.name} switched off`, q, who(req));
  return { off: row.id };
}));

export default r;
