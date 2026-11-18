// The designer's export arriving in CI Plant (owner, 17 Nov 2026: the proof is the designer's CorelDRAW export, sent by
// "a button inside CorelDRAW" on each designer's own PC; design plans/2026-11-17-artwork-workflow-design.md §5).
//
// A request to CI Plant is limited to about 4.5 MB, so the PDF comes in pieces: start (what the file is) → chunks
// (≤ 3 MB each, kept in artwork_upload_chunks) → finish (put together, fingerprint checked, saved to the business
// mailbox's Drive, matched to the version it is for). The CorelDRAW button uses a key of its own PC; the window's
// "Upload designer's PDF" uses the person's login and names the version. Chunks are deleted once the file is on Drive.
import crypto from 'node:crypto';
import { q, one, tx } from './db.js';
import { audit } from './helpers.js';
import { gmailConfigured, accessToken } from './gmail.js';
import { driveAllowed, saveArtworkToDrive } from './gdrive.js';
import { matchExport } from './artwork-flow.js';

export const CHUNK = 3 * 1024 * 1024;
// One approval mail carries at most 17 MB of proofs (Gmail's limit is 25 MB after encoding), so an export is capped there.
export const MAX_BYTES = 17 * 1024 * 1024;
// Where an export may go: a version waiting for the designer's file, or sent back. Out for approval or approved — no:
// a new export then needs the client's new file (a new version) or "changes asked" first.
const OPEN_STAGES = ['new', 'designer_file', 'changes', 'to_confirm'];
const STAGE_WORDS = { proof_ready: 'has a proof waiting to be sent (Cancel draft first)', approval_sent: 'is out for approval with the client',
  approved: 'is approved', released: 'is released to plates' };
// The version a person picked, checked: live, the newest of its job, and open for an export.
export async function openVersion(versionId) {
  const v = await one(`SELECT v.id, v.stage, v.label, EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id
                               AND x.deleted_at IS NULL AND x.status <> 'not_artwork') AS newer
                         FROM artwork_versions v WHERE v.id = $1 AND v.deleted_at IS NULL`, [versionId]);
  if (!v) throw fail(404, 'No such version.');
  if (v.newer) throw fail(409, `${v.label} is replaced by a newer version — put the export on the newest one.`);
  if (!OPEN_STAGES.includes(v.stage)) throw fail(409, `${v.label} ${STAGE_WORDS[v.stage] || `is "${v.stage}"`} — it cannot take a new export now (a new approval needs the client's new file, or "changes asked" first).`);
  return v;
}
const fail = (status, error) => Object.assign(new Error(error), { status });
const text = v => String(v ?? '').trim();
export const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

// The business mailbox's Google link, able to write Drive — else why not. Used by uploads and proofs.
export async function businessDrive() {
  if (!gmailConfigured()) throw fail(409, 'Gmail is not set up on the server yet — then Connect Gmail for the business mailbox (Enquiry desk › Settings).');
  const link = await one(`SELECT * FROM gmail_links WHERE mailbox = 'business'`);
  if (!link) throw fail(409, 'The business mailbox (mppchd) has no Gmail connected — an admin presses Connect Gmail for it in Enquiry desk › Settings.');
  if (!driveAllowed(link)) throw fail(409, 'The business mailbox was connected without Drive — press Connect Gmail again and allow Drive.');
  const shareWith = (await q(`SELECT email FROM enquiry_mailboxes WHERE key IN ('business', 'trial')`))
    .map(r => text(r.email).toLowerCase()).filter(e => /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/.test(e) && e !== text(link.email).toLowerCase());
  return { link, token: await accessToken(link), shareWith };
}

// The key of a designer's PC → { id, name }, or null.
export async function keyOf(raw) {
  const k = text(raw);
  if (k.length < 20) return null;
  const row = await one(`SELECT id, name FROM artwork_export_keys WHERE key_hash = $1 AND active`, [hashKey(k)]);
  if (row) await q('UPDATE artwork_export_keys SET last_used_at = now() WHERE id = $1', [row.id]);
  return row;
}

// → { upload, chunk_size, chunks }
export async function startUpload({ key_id = null, by_name, version_id = null }, body) {
  const fileName = text(body?.file_name).replace(/[\\/]+/g, ' ').slice(0, 250);
  const size = Number(body?.size_bytes), sha = text(body?.sha256).toLowerCase();
  if (!fileName) throw fail(400, 'Which file? (file_name)');
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) {
    throw fail(400, `The PDF is ${(size / 1048576).toFixed(1)} MB; an approval proof can be at most ${MAX_BYTES / 1048576} MB — export it with smaller images.`);
  }
  if (version_id) await openVersion(version_id);
  // pieces of uploads left unfinished for a day are cleared
  await q(`WITH old AS (UPDATE artwork_uploads SET status = 'failed', error = 'left unfinished' WHERE status = 'open' AND created_at < now() - interval '1 day' RETURNING id)
           DELETE FROM artwork_upload_chunks WHERE upload_id IN (SELECT id FROM old)`);
  if (!/^[0-9a-f]{64}$/.test(sha)) throw fail(400, 'The file\'s sha256 is needed (64 hex characters).');
  const colours = (Array.isArray(body?.colours) ? body.colours : []).map(text).filter(Boolean).slice(0, 60);
  const mm = v => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 5000 ? Number(v) : null);
  const token = crypto.randomBytes(18).toString('base64url');
  const chunks = Math.ceil(size / CHUNK);
  await q(`INSERT INTO artwork_uploads (token, key_id, by_name, version_id, file_name, size_bytes, sha256, chunks, page_w_mm, page_h_mm, colours)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
  [token, key_id, by_name, version_id, fileName, size, sha, chunks, mm(body?.page_w_mm), mm(body?.page_h_mm), JSON.stringify(colours)]);
  return { upload: token, chunk_size: CHUNK, chunks };
}

const openUpload = async (token, who) => {
  const u = await one(`SELECT * FROM artwork_uploads WHERE token = $1`, [text(token)]);
  if (!u) throw fail(404, 'No such upload.');
  if ((who.key_id ?? null) !== (u.key_id ?? null)) throw fail(403, 'This upload was started by someone else.');
  if (u.status === 'done') throw fail(409, 'This upload is finished already.');
  return u;
};

export async function putChunk(token, n, bytes, who) {
  const u = await openUpload(token, who);
  const i = Number(n);
  if (!Number.isInteger(i) || i < 0 || i >= u.chunks) throw fail(400, `Piece ${n} is not one of 0–${u.chunks - 1}.`);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CHUNK) throw fail(400, `Each piece must be 1 byte to ${CHUNK} bytes.`);
  await q(`INSERT INTO artwork_upload_chunks (upload_id, n, bytes) VALUES ($1, $2, $3)
           ON CONFLICT (upload_id, n) DO UPDATE SET bytes = EXCLUDED.bytes`, [u.id, i, bytes]);
  return { received: i };
}

// The versions an export may be for, as matchExport() wants them.
async function candidates() {
  return q(`SELECT v.id AS version_id, j.client_item_code, v.client_rev, v.stage, v.deleted_at
              FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id
             WHERE v.deleted_at IS NULL AND v.status <> 'not_artwork'
               AND NOT EXISTS (SELECT 1 FROM artwork_versions x WHERE x.job_id = v.job_id AND x.id > v.id AND x.deleted_at IS NULL AND x.status <> 'not_artwork')`);
}

// Moves a version to "designer's file in" when it was waiting for one. → true when it moved.
export async function exportArrived(qc, versionId, by) {
  const moved = await qc(`UPDATE artwork_versions SET stage = 'designer_file', stage_at = now()
                           WHERE id = $1 AND stage IN ('new', 'designer_file', 'changes', 'to_confirm') AND deleted_at IS NULL RETURNING id, job_id`, [versionId]);
  if (moved.length) {
    await qc(`INSERT INTO artwork_events (job_id, version_id, action, detail, by_name) VALUES ($1, $2, 'designer_file', '{}'::jsonb, $3)`,
      [moved[0].job_id, versionId, by]);
  }
  return moved.length > 0;
}

// → { export_id, version_id | null, matched, why }
export async function finishUpload(token, who) {
  const u = await openUpload(token, who);
  const parts = await q(`SELECT n, bytes FROM artwork_upload_chunks WHERE upload_id = $1 ORDER BY n`, [u.id]);
  if (parts.length !== u.chunks || parts.some((p, i) => p.n !== i)) throw fail(409, `${parts.length} of ${u.chunks} pieces arrived — send the missing ones, then finish.`);
  const bytes = Buffer.concat(parts.map(p => p.bytes));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== Number(u.size_bytes) || sha !== u.sha256) {
    await q(`UPDATE artwork_uploads SET status = 'failed', error = 'the pieces did not make the file that was announced' WHERE id = $1`, [u.id]);
    await q(`DELETE FROM artwork_upload_chunks WHERE upload_id = $1`, [u.id]);
    throw fail(422, 'The file arrived damaged (size or fingerprint differs) — press the button again.');
  }
  // Which version: the one a person chose (checked again: it may have moved on while the pieces came), else by the
  // code and revision in the file name.
  if (u.version_id) {
    try { await openVersion(u.version_id); } catch (e) {
      await q(`UPDATE artwork_uploads SET status = 'failed', error = $2 WHERE id = $1`, [u.id, String(e.message).slice(0, 300)]);
      await q(`DELETE FROM artwork_upload_chunks WHERE upload_id = $1`, [u.id]);
      throw e;
    }
  }
  let versionId = u.version_id, why = null;
  if (!versionId) {
    const m = matchExport(u.file_name, await candidates());
    versionId = m.version_id ?? null; why = m.why ?? null;
  }
  const drive = await businessDrive();
  const pdfName = u.file_name.replace(/\.(cdr|pdf)$/i, '') + '.pdf';
  const saved = await saveArtworkToDrive({ token: drive.token, fileName: `EXPORT ${pdfName}`, bytes, shareWith: drive.shareWith });
  const out = await tx(async (qc, oc) => {
    const e = await oc(`INSERT INTO artwork_exports (version_id, upload_id, by_name, file_name, sha256, size_bytes, page_w_mm, page_h_mm, colours, drive_file_id, drive_url, match_note)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [versionId, u.id, u.by_name, u.file_name, sha, bytes.length, u.page_w_mm, u.page_h_mm, JSON.stringify(u.colours || []), saved.file_id, saved.link, why]);
    await qc(`UPDATE artwork_uploads SET status = 'done' WHERE id = $1`, [u.id]);
    await qc(`DELETE FROM artwork_upload_chunks WHERE upload_id = $1`, [u.id]);
    if (versionId) await exportArrived(qc, versionId, u.by_name);
    await audit('artwork_export', e.id, 'upload', `Designer's export ${u.file_name} from ${u.by_name || '—'}${versionId ? '' : ` — not matched: ${why}`}`, qc, u.by_name);
    return { export_id: e.id, version_id: versionId, matched: !!versionId, why, drive_url: saved.link };
  });
  return out;
}

// A person puts an unmatched export on its version.
export async function matchByHand(exportId, versionId, by) {
  if (!versionId) throw fail(400, 'Pick the version this export is for.');
  // checked before the transaction: a second query inside it would wait for the connection the transaction holds
  await openVersion(versionId);
  return tx(async (qc, oc) => {
    const e = await oc('SELECT id, version_id FROM artwork_exports WHERE id = $1 FOR UPDATE', [exportId]);
    if (!e) throw fail(404, 'No such export.');
    await qc(`UPDATE artwork_exports SET version_id = $2, match_note = $3 WHERE id = $1`, [exportId, versionId, `matched by ${by}`]);
    await exportArrived(qc, versionId, by);
    return { export_id: exportId, version_id: versionId };
  });
}
