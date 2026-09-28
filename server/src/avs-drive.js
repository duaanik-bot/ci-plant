// The Drive link (a Google Apps Script web app, client/src/lib/avs-robot/drive-link.gs)
// seen from CI Plant: one POST per call. Apps Script answers through a redirect
// to script.googleusercontent.com, which fetch follows with a GET.
//
// Google now and then loses that answer (seen on 28 Sep 2026, about one call in
// six): the redirect bounces back to the /exec address as a GET, which gives the
// link's GET page ({ ok: true, service }) — or Google's "Page Not Found". The
// call may well have run, but its answer is gone. Neither is ever taken as the
// answer: the call is tried again while time is left (`again` changes the second
// try, e.g. a photo asks for the file of that name already there), and otherwise
// it fails, so an upload keeps its photo in CI Plant rather than recording a
// Drive file it cannot name.

// What the link's doGet() answers; a POST answer never carries it.
export const DRIVE_GET_PAGE = 'CI Plant AVS Drive link';

const fail = (status, message) => Object.assign(new Error(message), { status });

// { data } — the link's answer; { refused } — the link said no (never tried
// again); { lost } — no answer came back (tried again).
export function readDriveReply(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    return { lost: 'Google answered with a web page instead of the Drive link\'s answer' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { lost: 'Google Drive sent an answer CI Plant cannot read' };
  if (data.service === DRIVE_GET_PAGE && !('error' in data)) return { lost: 'Google lost the Drive link\'s answer on the way back' };
  if (!data.ok) return { refused: data.error || 'no reason given' };
  return { data };
}

// One call, tried up to `tries` times within `timeoutMs` in all.
export async function postDrive(url, body, { timeoutMs = 25000, tries = 2, again = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lost = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const left = deadline - Date.now();
    if (attempt > 1 && left < 4000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), left);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(attempt > 1 && again ? { ...body, ...again } : body),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      const reply = readDriveReply(await res.text());
      if (reply.data) return reply.data;
      if (reply.refused) throw fail(502, `Google Drive refused: ${reply.refused}`);
      lost = reply.lost;
    } catch (e) {
      if (e.status) throw e;
      if (e.name === 'AbortError') {
        throw Object.assign(fail(504, 'Google Drive took too long to answer. Try again.'), { reason: 'Google Drive took too long to answer' });
      }
      lost = `Google Drive could not be reached (${e.message})`;
    } finally { clearTimeout(timer); }
  }
  // `reason` is the short form, for a photo kept in CI Plant instead.
  const reason = lost || 'Google Drive did not answer';
  throw Object.assign(fail(502, `${reason}. Try again; if it keeps happening, check that the Drive link is `
    + 'deployed as a Web app with access "Anyone".'), { reason });
}
