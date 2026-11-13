// Size proposals and KLDs (owner, 12 Nov 2026: "Whenever there is a new size … you will propose the size to me … out
// of which I will select one. Once we select all of this, you will create the KLD for the product and save it … in
// the cost sheet itself … save those KLDs in the drive dua.anik@gmail.com and share it with mppchd@gmail.com").
//
//   GET  /costing/sizing/proposals?size=&style=&gsm=   die check (Die Master + 2024 register), then layouts on the
//                                                      board master's sheets (client/src/lib/sizing.js)
//   PUT  /costing/sizing/kld                           draw the KLD of a size + layout; saved on its Size Library entry
//                                                      (made if new), a redraw is the next revision
//   GET  /costing/sizes/:id/kld · GET /costing/sizes/:id/kld.pdf
//   POST /costing/sizes/:id/kld/drive                  the PDF into the trial mailbox's Drive, shared with the business
//                                                      mailbox's address (and nobody else)
// All behind the Costing tick. Audit lines name the size and revision only.
import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { parseSize, normStyle } from '../costing-engine.js';
import { matchDies, mayCost } from '../costing-match.js';
import { proposals, readings, cartonPlan, overRules, settingsProblem, cleanSettings } from '../../../client/src/lib/sizing.js';
import { kldPdf } from '../kld-pdf.js';
import { accessToken, gmailConfigured } from '../gmail.js';
import { driveAllowed, saveKldToDrive } from '../gdrive.js';

const r = Router();
const fail = (status, error) => Object.assign(new Error(error), { status });
// Whose Drive keeps the KLDs and who they are shared with: mailbox keys, so the addresses stay in enquiry_mailboxes.
export const KLD_DRIVE = Object.freeze({ owner: 'trial', shareWith: 'business', folder: 'CI Plant KLDs' });
const STYLE_WORDS = { SIDE: 'side pasting', LOCK: 'lock bottom' };

const guard = async (req, res, next) => {
  try {
    const u = await one('SELECT id, name, role, active, modules, is_management FROM users WHERE id = $1 AND active = 1', [req.user?.id]);
    if (!mayCost(u)) return res.status(403).json({ error: 'Costing is not ticked for this login — ask an admin to tick it in Masters → Users.', code: 'COSTING_REFUSED' });
    req.costingUser = u;
    return next();
  } catch (e) { return next(e); }
};
const intId = v => (/^\d{1,9}$/.test(String(v ?? '')) ? Number(v) : 0);

// The 2024 register by size: the same three numbers, then each side within 3 mm (written in the same order).
async function registerMatches(size) {
  const rows = await q(`SELECT die_no, l_mm::float8 AS l, w_mm::float8 AS w, h_mm::float8 AS h, style, ups, size_text
                          FROM die_register
                         WHERE l_mm BETWEEN $1 - 3 AND $1 + 3 AND w_mm BETWEEN $2 - 3 AND $2 + 3 AND h_mm BETWEEN $3 - 3 AND $3 + 3
                         ORDER BY abs(l_mm - $1) + abs(w_mm - $2) + abs(h_mm - $3), die_no`, [size.l, size.w, size.h]);
  const exact = rows.filter(x => x.l === size.l && x.w === size.w && x.h === size.h);
  return { exact, near: rows.filter(x => !exact.includes(x)).slice(0, 8) };
}

r.get('/costing/sizing/proposals', guard, async (req, res, next) => {
  try {
    const size = parseSize(req.query.size);
    const style = normStyle(req.query.style);
    const gsm = Number(req.query.gsm) > 0 ? Number(req.query.gsm) : null;
    const none = { master: { exact: [], near: [] }, register: { exact: [], near: [] } };
    if (!size || size.kind !== 'carton') {
      return res.json({ size, style, unsupported: true, reason: 'Type the carton size as L × W × H in mm.', readings: [], dies: none });
    }
    const [boards, tools, register] = await Promise.all([
      q(`SELECT id, name, sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, grain FROM materials
          WHERE category = 'board' AND active = 1 AND COALESCE(leftover, 0) = 0 AND sheet_l > 0 AND sheet_w > 0`),
      q(`SELECT t.id, t.code, t.title, t.ups, t.sheet_size, t.carton_size, t.zone, t.location, t.condition, p.name AS product_name
           FROM tools t LEFT JOIN products p ON p.id = t.product_id WHERE t.family = 'die' AND t.active = 1 ORDER BY t.code`),
      registerMatches(size),
    ]);
    res.json({ size, style, gsm, dies: { master: matchDies(size, tools), register }, ...proposals({ style, size, boards, gsm }) });
  } catch (e) { next(e); }
});

// The Size Library entry for a size + pasting + layout: the existing one (brought back if retired), or a new one.
async function entryFor(size, style, lay, u) {
  const row = await one(`
    INSERT INTO costing_sizes (size_key, kind, l_mm, w_mm, h_mm, style, sheet_l, sheet_w, ups, source, source_refs, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', '[]', $10, $10)
    ON CONFLICT DO NOTHING RETURNING id`,
  [size.key, size.kind, size.l, size.w, size.h, style, lay.sheet_short, lay.sheet_long, lay.ups, u.id]);
  if (row) {
    await audit('costing_size', row.id, 'create', `${size.label} ${style} (from a size proposal)`, q, u.name);
    return row.id;
  }
  const dup = await one(`SELECT id FROM costing_sizes WHERE size_key = $1 AND COALESCE(style, '') = COALESCE($2, '')
                            AND COALESCE(sheet_l, 0) = COALESCE($3, 0) AND COALESCE(sheet_w, 0) = COALESCE($4, 0) AND COALESCE(ups, 0) = COALESCE($5, 0)`,
  [size.key, style, lay.sheet_short, lay.sheet_long, lay.ups]);
  await q('UPDATE costing_sizes SET active = true, updated_at = now(), updated_by = $2 WHERE id = $1 AND NOT active', [dup.id, u.id]);
  return dup.id;
}

const cleanLayout = o => {
  const long = Number(o?.sheet?.long), short = Number(o?.sheet?.short);
  const ups = Math.round(Number(o?.ups)), m = Math.round(Number(o?.m)), n = Math.round(Number(o?.n));
  const acrossOn = o?.acrossOn === 'long' || o?.acrossOn === 'short' ? o.acrossOn : null;
  if (!(long > 0 && short > 0 && ups > 0 && m > 0 && n > 0 && m * n === ups && acrossOn)) return null;
  const r3 = x => Math.round(x * 1000) / 1000;
  return { sheet_long: r3(Math.max(long, short)), sheet_short: r3(Math.min(long, short)), ups, m, n, across_on: acrossOn };
};

r.put('/costing/sizing/kld', guard, async (req, res, next) => {
  try {
    const u = req.costingUser;
    const size = parseSize(req.body?.size_text);
    if (!size || size.kind !== 'carton') throw fail(400, 'Type the carton size as L × W × H in mm.');
    const style = normStyle(req.body?.style);
    const reading = readings(style, size).find(x => x.key === req.body?.reading);
    if (!reading) throw fail(400, 'KLDs are drawn for side pasting (side-open or top-open) and lock bottom — pick one of the proposals.');
    const layout = cleanLayout(req.body?.option);
    if (!layout) throw fail(400, 'Pick a layout first: the sheet, the ups and how they sit on it.');
    // the output's own settings — gripper, edges, gap between ups (13 Nov 2026) — kept with the layout they shaped
    const settingsIn = req.body?.settings ?? req.body?.option?.settings ?? null;
    const sp = settingsProblem(settingsIn);
    if (sp) throw fail(400, sp);
    layout.settings = cleanSettings(settingsIn);
    // a die may run tighter than the house rules: drawn all the same, with how far it runs past them (no hard blocker)
    layout.over_rules = overRules(reading, layout);
    const sizeId = await entryFor(size, style, layout, u);
    const plan = cartonPlan(reading);
    const kld = {
      v: 1, construction: reading.construction, reading: reading.key, style, size_key: size.key,
      tube: reading.tube, face: reading.face, w: reading.w,
      rules: { glue: plan.glue, tuck: plan.tuck, dust: Math.round(plan.dust * 100) / 100, lock: plan.lock },
      layout, drawn_at: new Date().toISOString(), drawn_by: u.name,
    };
    // the revision and the Drive copies come from the row itself, in the same statement (two redraws never share a rev)
    const saved = await one(`
      UPDATE costing_sizes
         SET kld = $2::jsonb || jsonb_build_object('rev', COALESCE((kld->>'rev')::int, 0) + 1, 'drive', COALESCE(kld->'drive', '[]'::jsonb)),
             updated_at = now(), updated_by = $3
       WHERE id = $1 RETURNING kld`, [sizeId, JSON.stringify(kld), u.id]);
    await audit('costing_size', sizeId, 'kld', `KLD rev ${saved.kld.rev} — ${size.label} ${style}`, q, u.name);
    res.json({ size_id: sizeId, kld: saved.kld });
  } catch (e) { next(e); }
});

const entryWithKld = id => one(`SELECT id, size_key, style, sheet_l::float8 AS sheet_l, sheet_w::float8 AS sheet_w, ups::float8 AS ups, kld
                                   FROM costing_sizes WHERE id = $1`, [intId(id)]);
const titleOf = row => `${String(row.size_key).replace(/x/g, ' × ')} mm${STYLE_WORDS[row.style] ? ` · ${STYLE_WORDS[row.style]}` : ''}`;
const fileOf = row => `KLD ${row.size_key} ${row.style || ''} rev ${row.kld?.rev || 1}.pdf`.replace(/\s+/g, ' ');

r.get('/costing/sizes/:id/kld', guard, async (req, res, next) => {
  try {
    const row = await entryWithKld(req.params.id);
    if (!row?.kld) throw fail(404, 'No KLD has been drawn for this size yet.');
    res.json({ size_id: row.id, size_key: row.size_key, style: row.style, sheet_l: row.sheet_l, sheet_w: row.sheet_w, ups: row.ups, title: titleOf(row), kld: row.kld });
  } catch (e) { next(e); }
});

r.get('/costing/sizes/:id/kld.pdf', guard, async (req, res, next) => {
  try {
    const row = await entryWithKld(req.params.id);
    if (!row?.kld) throw fail(404, 'No KLD has been drawn for this size yet.');
    const bytes = await kldPdf({ kld: row.kld, title: titleOf(row) });
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${fileOf(row).replace(/"/g, '')}"`);
    res.send(Buffer.from(bytes));
  } catch (e) { next(e); }
});

r.post('/costing/sizes/:id/kld/drive', guard, async (req, res, next) => {
  try {
    const u = req.costingUser;
    const row = await entryWithKld(req.params.id);
    if (!row?.kld) throw fail(404, 'Draw the KLD first.');
    if (!gmailConfigured()) throw fail(503, 'Google is not set up on the server yet.');
    const link = await one('SELECT mailbox, email, refresh_token_enc, scope FROM gmail_links WHERE mailbox = $1', [KLD_DRIVE.owner]);
    if (!link) throw fail(409, 'Connect Google for the trial mailbox first: Enquiry desk → Settings → Connect Gmail, and allow Drive.');
    if (!driveAllowed(link)) {
      throw fail(409, `The Google connection for ${link.email} was made before Drive was allowed — press Connect Gmail again in the Enquiry desk settings and allow Drive.`);
    }
    const share = await one('SELECT email FROM enquiry_mailboxes WHERE key = $1', [KLD_DRIVE.shareWith]);
    const bytes = await kldPdf({ kld: row.kld, title: titleOf(row) });
    const token = await accessToken(link);
    const got = await saveKldToDrive({ token, folderName: KLD_DRIVE.folder, fileName: fileOf(row), bytes, shareWith: share?.email || null });
    const entry = { rev: row.kld.rev, file_id: got.file_id, link: got.link, shared_with: share?.email || null, saved_at: new Date().toISOString(), saved_by: u.name };
    const upd = await one(`UPDATE costing_sizes SET kld = jsonb_set(kld, '{drive}', COALESCE(kld->'drive', '[]'::jsonb) || $2::jsonb)
                            WHERE id = $1 RETURNING kld`, [row.id, JSON.stringify([entry])]);
    await audit('costing_size', row.id, 'kld_drive', `KLD rev ${entry.rev} saved to Drive${entry.shared_with ? ` and shared with ${entry.shared_with}` : ''}`, q, u.name);
    res.json({ drive: entry, kld: upd.kld });
  } catch (e) { next(e); }
});

export default r;
