// COA Register — the Certificates of Analysis as filed in the mppchd Drive,
// mirrored into coa_register / coa_register_files by scripts/coa-register-sync.mjs.
// Read-only here: the register is kept in Drive, never edited in CI Plant.
//
//   GET /coa-register              the register (no PDF bytes) + can_download
//   GET /coa-register/:no/pdf      the COA's PDF, inline, to view on screen
//   GET /coa-register/:no/pdf?download=1   as a download — needs the right
import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { mayViewCoa, mayDownloadCoa } from '../coa-register.js';

const r = Router();

// The login as it stands now — ticks change mid-session and the token carries
// only id/name/role, so the rights are read from users on every request.
async function loginOf(req) {
  return one('SELECT id, role, active, modules, coa_download FROM users WHERE id = $1 AND active = 1', [req.user?.id]);
}
const refuse = (res, error) => res.status(403).json({ error, code: 'COA_REGISTER_REFUSED' });

r.get('/coa-register', async (req, res, next) => {
  try {
    const u = await loginOf(req);
    if (!u || !mayViewCoa(u)) return refuse(res, 'The COA Register module is not ticked for this login.');
    const rows = await q(`
      SELECT c.coa_no, c.company, c.customer, c.invoice_no,
             to_char(c.invoice_date, 'YYYY-MM-DD') AS invoice_date, c.line_no, c.product,
             c.party_item_code, c.po_no, to_char(c.po_date, 'YYYY-MM-DD') AS po_date,
             c.job_card, c.qty::float8 AS qty, c.std_gsm::float8 AS std_gsm, c.status,
             c.rows_on_hold, c.qc_signed, c.remarks, c.file_name, c.folder,
             to_char(c.date_generated, 'YYYY-MM-DD') AS date_generated,
             to_char(c.date_approved, 'YYYY-MM-DD') AS date_approved,
             c.pdf_path, c.synced_at,
             f.size_bytes AS pdf_size
        FROM coa_register c
        LEFT JOIN coa_register_files f ON f.coa_no = c.coa_no
       ORDER BY c.invoice_date DESC NULLS LAST, c.invoice_no DESC, c.line_no, c.coa_no`);
    res.json({ rows, can_download: mayDownloadCoa(u) });
  } catch (e) { next(e); }
});

r.get('/coa-register/:no/pdf', async (req, res, next) => {
  try {
    const u = await loginOf(req);
    if (!u || !mayViewCoa(u)) return refuse(res, 'The COA Register module is not ticked for this login.');
    const download = String(req.query.download ?? '') === '1';
    if (download && !mayDownloadCoa(u)) {
      return refuse(res, 'Downloading a COA needs the “Download COA” right — ask an admin to tick it in Masters → Users.');
    }
    const f = await one('SELECT file_name, bytes FROM coa_register_files WHERE coa_no = $1', [req.params.no]);
    if (!f) return res.status(404).json({ error: `No PDF is filed for COA ${req.params.no}.` });
    if (download) {
      await audit('coa_register', null, 'download', req.params.no, q, req.user.name)
        .catch(e => console.warn(`[coa-register] download audit failed: ${e.message}`));
    }
    const name = String(f.file_name).replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(f.bytes);
  } catch (e) { next(e); }
});

export default r;
