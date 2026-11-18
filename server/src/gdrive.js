// Drive for KLDs (owner, 12 Nov 2026: "You will save those KLDs in the drive dua.anik@gmail.com and share it with
// mppchd@gmail.com"). CI Plant uses the Google link it already keeps for the trial mailbox (gmail.js) with one more
// permission, drive.file: Google then lets CI Plant see and change only the files and folders CI Plant itself made —
// never anything else in that Drive.
//
// Every save is a NEW file (a redrawn KLD never overwrites the copy the team may be working from), put in one folder
// CI Plant made and marked (appProperties ciplant=kld), and shared as reader with exactly one address.
// GDRIVE_API_BASE / GDRIVE_UPLOAD_BASE exist only so the tests can point at a fake Google.
import crypto from 'node:crypto';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const api = () => process.env.GDRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const uploadBase = () => process.env.GDRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3';

// Was the Google link made with the Drive permission?
export const driveAllowed = link => String(link?.scope || '').split(/\s+/).includes(DRIVE_SCOPE);

async function call(token, method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...headers }, body });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = j.error?.message || res.statusText || String(res.status);
    const refused = res.status === 401 || res.status === 403;
    throw Object.assign(new Error(refused ? `Drive refused (${why}) — press Connect Gmail again in the Enquiry desk settings and allow Drive.`
      : `Drive said: ${why}`), { status: refused ? 409 : 502 });
  }
  return j;
}

const MARK = "appProperties has { key='ciplant' and value='kld' }";

export async function saveKldToDrive({ token, folderName, fileName, bytes, shareWith = null }) {
  const found = await call(token, 'GET', `${api()}/files?${new URLSearchParams({
    q: `mimeType='application/vnd.google-apps.folder' and trashed=false and ${MARK}`, fields: 'files(id,name)', spaces: 'drive',
  })}`);
  let folderId = found.files?.[0]?.id;
  if (!folderId) {
    const made = await call(token, 'POST', `${api()}/files?fields=id`,
      JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', appProperties: { ciplant: 'kld' } }),
      { 'content-type': 'application/json' });
    folderId = made.id;
  }
  const boundary = `ciplant_${crypto.randomBytes(10).toString('hex')}`;
  const meta = JSON.stringify({ name: fileName, mimeType: 'application/pdf', parents: [folderId], appProperties: { ciplant: 'kld' } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const file = await call(token, 'POST', `${uploadBase()}/files?uploadType=multipart&fields=id,webViewLink`, body,
    { 'content-type': `multipart/related; boundary=${boundary}` });
  if (shareWith) {
    await call(token, 'POST', `${api()}/files/${encodeURIComponent(file.id)}/permissions`,
      JSON.stringify({ type: 'user', role: 'reader', emailAddress: shareWith }), { 'content-type': 'application/json' });
  }
  return { file_id: file.id, link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, folder_id: folderId };
}

// ── artwork files (17 Nov 2026): the designer's exports and the proofs, in the business mailbox's Drive ───────────
// One folder CI Plant made (appProperties ciplant=artwork). A resumable upload, so a large export is never refused
// (a multipart upload is only for files up to 5 MB). Every save is a new file; a file is shared as reader with each
// address given (the company mailboxes), so everyone who reviews can open it.
const ART = "appProperties has { key='ciplant' and value='artwork' }";
export async function saveArtworkToDrive({ token, folderName = 'CI Plant – artwork proofs', fileName, bytes, mime = 'application/pdf', shareWith = [] }) {
  const found = await call(token, 'GET', `${api()}/files?${new URLSearchParams({
    q: `mimeType='application/vnd.google-apps.folder' and trashed=false and ${ART}`, fields: 'files(id,name)', spaces: 'drive',
  })}`);
  let folderId = found.files?.[0]?.id;
  if (!folderId) {
    const made = await call(token, 'POST', `${api()}/files?fields=id`,
      JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', appProperties: { ciplant: 'artwork' } }),
      { 'content-type': 'application/json' });
    folderId = made.id;
  }
  const start = await fetch(`${uploadBase()}/files?uploadType=resumable&fields=id,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime,
      'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify({ name: fileName, mimeType: mime, parents: [folderId], appProperties: { ciplant: 'artwork' } }),
  });
  const where = start.headers.get('location');
  if (!start.ok || !where) {
    const j = await start.json().catch(() => ({}));
    const refused = start.status === 401 || start.status === 403;
    throw Object.assign(new Error(refused ? `Drive refused (${j.error?.message || start.status}) — press Connect Gmail again for the business mailbox and allow Drive.`
      : `Drive said: ${j.error?.message || start.status}`), { status: refused ? 409 : 502 });
  }
  const file = await call(token, 'PUT', where, Buffer.from(bytes), { 'content-type': mime });
  for (const email of [...new Set(shareWith.filter(Boolean))]) {
    await call(token, 'POST', `${api()}/files/${encodeURIComponent(file.id)}/permissions?sendNotificationEmail=false`,
      JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }), { 'content-type': 'application/json' });
  }
  return { file_id: file.id, link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, folder_id: folderId };
}

// A file CI Plant saved (drive.file lets it read only its own files) → its bytes.
export async function readArtworkFromDrive({ token, fileId }) {
  const res = await fetch(`${api()}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(`Drive could not give the file back (${res.status}).`), { status: 502 });
  return Buffer.from(await res.arrayBuffer());
}
