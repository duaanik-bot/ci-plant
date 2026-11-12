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
