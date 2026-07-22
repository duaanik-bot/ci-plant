// ─── Board Rate master API ────────────────────────────────────────────────
// The plant sets ONE ₹/kg per board grade (optionally overridden per vendor);
// every board's ₹/sheet derives from this at read time (see board-math.js).
// Board rates drive every board's price, so each row reports how many boards
// it affects — the buyer sees the blast radius before changing a number.
import { Router } from 'express';
import { q, one } from '../db.js';
import { audit } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canEdit = requireRole('planner'); // admin implied

r.get('/board-rates', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT br.*, v.name AS vendor_name,
             (SELECT count(*) FROM materials m
               WHERE m.category='board' AND m.active=1 AND m.grade = br.grade
                 AND COALESCE(m.leftover, 0) = 0)::int AS board_count
      FROM board_rates br
      LEFT JOIN vendors v ON v.id = br.vendor_id
      ORDER BY br.grade, (br.vendor_id IS NOT NULL), v.name`));
  } catch (e) { next(e); }
});

// The grade list the board form's dropdown is built from — every grade that has
// a rate, plus any grade already in use on a board (so an unrated grade is still
// selectable and simply shows "no rate on file").
r.get('/board-grades', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT grade FROM board_rates WHERE active=1
      UNION
      SELECT grade FROM materials
       WHERE category='board' AND COALESCE(leftover, 0) = 0
         AND grade IS NOT NULL AND grade <> ''
      ORDER BY 1`));
  } catch (e) { next(e); }
});

r.post('/board-rates', canEdit, async (req, res, next) => {
  try {
    const { grade, vendor_id, rate_per_kg, effective_from, active } = req.body;
    if (!String(grade || '').trim()) return res.status(400).json({ error: 'Grade is required' });
    if (!(+rate_per_kg > 0)) return res.status(400).json({ error: 'Rate must be greater than zero' });
    const [row] = await q(
      `INSERT INTO board_rates (grade, vendor_id, rate_per_kg, effective_from, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(grade).trim(), vendor_id || null, +rate_per_kg, effective_from || null, active ?? 1]);
    await audit('board_rates', row.id, 'create',
      `${row.grade} @ ₹${row.rate_per_kg}/kg${row.vendor_id ? ` (vendor ${row.vendor_id})` : ' (base)'}`, q, req.user.name);
    res.json(row);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'A rate already exists for this grade and vendor. Edit that row instead.' });
    next(e);
  }
});

// Field-level PUT: only columns actually present in the body are updated, so
// a falsy-but-valid value (active:0, effective_from:'' → NULL) takes effect
// instead of being silently coalesced back to the stored value.
r.put('/board-rates/:id', canEdit, async (req, res, next) => {
  try {
    const before = await one('SELECT * FROM board_rates WHERE id=$1', [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Not found' });

    if ('rate_per_kg' in req.body && !(+req.body.rate_per_kg > 0))
      return res.status(400).json({ error: 'Rate must be greater than zero' });

    const sets = [];
    const vals = [];
    let i = 1;
    if ('rate_per_kg' in req.body) { sets.push(`rate_per_kg=$${i++}`); vals.push(+req.body.rate_per_kg); }
    if ('effective_from' in req.body) { sets.push(`effective_from=$${i++}`); vals.push(req.body.effective_from || null); }
    if ('active' in req.body) { sets.push(`active=$${i++}`); vals.push(req.body.active ? 1 : 0); }
    if (!sets.length) return res.json(before);
    vals.push(req.params.id);
    const [row] = await q(
      `UPDATE board_rates SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);

    if (+before.rate_per_kg !== +row.rate_per_kg) {
      await audit('board_rates', row.id, 'update',
        `${row.grade} rate ₹${before.rate_per_kg} → ₹${row.rate_per_kg}/kg`, q, req.user.name);
    }
    if (+before.active !== +row.active) {
      await audit('board_rates', row.id, 'update',
        `${row.grade}${row.vendor_id ? ` (vendor ${row.vendor_id})` : ' (base)'} ${row.active ? 'reactivated' : 'deactivated'}`, q, req.user.name);
    }
    res.json(row);
  } catch (e) { next(e); }
});

r.delete('/board-rates/:id', canEdit, async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM board_rates WHERE id=$1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await q('DELETE FROM board_rates WHERE id=$1', [req.params.id]);
    await audit('board_rates', row.id, 'delete',
      `${row.grade} @ ₹${row.rate_per_kg}/kg${row.vendor_id ? ` (vendor ${row.vendor_id})` : ' (base)'}`, q, req.user.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
