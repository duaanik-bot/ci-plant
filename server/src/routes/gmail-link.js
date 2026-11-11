// Google sends the admin's browser back here after the Gmail consent page (no CI Plant login token rides on that
// redirect, so this route sits before requireAuth — the signed `state` carries who asked and for which mailbox).
//   GET /api/gmail/callback?code=&state=     store the encrypted link, then back to the enquiry desk
// The start (POST /costing/enquiry-desk/gmail/:key/connect) and Disconnect live in routes/enquiries.js.
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { one, q } from '../db.js';
import { audit } from '../helpers.js';
import { JWT_SECRET } from '../auth.js';
import { exchangeCode, sealToken, forgetToken } from '../gmail.js';

const r = Router();

// Where Google sends the browser back: this same server, as the browser reached it (motionci.in, or localhost in dev).
// Each origin used must be listed on the Google client as an authorised redirect URI.
export function redirectUri(req) {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto') || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto.split(',')[0]}://${host}/api/gmail/callback`;
}
export const signState = (mailbox, userId) => jwt.sign({ p: 'gmail', mb: mailbox, uid: userId }, JWT_SECRET, { expiresIn: '15m' });

const back = (res, params) => res.redirect(303, `/costing?${new URLSearchParams({ tab: 'enquiries', ...params })}`);

r.get('/gmail/callback', async (req, res) => {
  let st;
  try { st = jwt.verify(String(req.query.state || ''), JWT_SECRET); } catch { return back(res, { gmail: 'expired' }); }
  if (st?.p !== 'gmail' || !['trial', 'business'].includes(st.mb)) return back(res, { gmail: 'expired' });
  if (req.query.error) return back(res, { gmail: 'denied', mb: st.mb });
  try {
    const u = await one('SELECT id, name, role FROM users WHERE id = $1 AND active = 1', [st.uid]);
    if (u?.role !== 'admin') return back(res, { gmail: 'refused', mb: st.mb });
    const box = await one('SELECT key, email FROM enquiry_mailboxes WHERE key = $1', [st.mb]);
    if (!box) return back(res, { gmail: 'refused', mb: st.mb });
    const got = await exchangeCode(String(req.query.code || ''), redirectUri(req));
    // The Google account must be the mailbox's own — never another mailbox's drafts.
    if (got.email !== String(box.email).toLowerCase()) return back(res, { gmail: 'wrong', mb: st.mb, as: got.email });
    await q(`INSERT INTO gmail_links (mailbox, email, refresh_token_enc, scope, connected_at, connected_by_name)
             VALUES ($1, $2, $3, $4, now(), $5)
             ON CONFLICT (mailbox) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc,
               scope = EXCLUDED.scope, connected_at = now(), connected_by_name = EXCLUDED.connected_by_name,
               last_error = NULL, last_error_at = NULL`,
    [box.key, got.email, sealToken(got.refresh_token), got.scope, u.name]);
    forgetToken(box.key);
    await audit('enquiry_desk', 1, 'gmail_connect', `Gmail connected for the ${box.key} mailbox`, q, u.name);
    return back(res, { gmail: 'connected', mb: box.key });
  } catch (e) {
    console.error('[gmail] connect failed:', e.message);
    return back(res, { gmail: 'failed', mb: st.mb, why: String(e.message || '').slice(0, 200) });
  }
});

export default r;
