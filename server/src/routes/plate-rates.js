import { Router } from 'express';
import { one, q } from '../db.js';
import { plantDateStr } from '../plant-calendar.js';
import { requireRole } from '../auth.js';
import { audit } from '../helpers.js';

const r = Router();
const canEdit = requireRole('planner');

r.get('/plate-rates', async (_req, res, next) => {
  try {
    res.json(await q(`SELECT pr.*,to_char(pr.effective_from,'YYYY-MM-DD') AS effective_from,
        pm.code AS plate_code,pm.plate_size,v.name AS vendor_name
      FROM plate_rates pr
      JOIN plate_masters pm ON pm.id=pr.plate_master_id
      LEFT JOIN vendors v ON v.id=pr.vendor_id
      ORDER BY pm.plate_size,(pr.vendor_id IS NOT NULL),v.name,pr.effective_from DESC,pr.id DESC`));
  } catch (error) { next(error); }
});

r.post('/plate-rates', canEdit, async (req, res, next) => {
  try {
    const plateMasterId = Number(req.body.plate_master_id);
    const rate = Number(req.body.rate_per_plate);
    if (!plateMasterId) return res.status(400).json({ error: 'Choose a Plate Size' });
    if (!(rate > 0)) return res.status(400).json({ error: 'Rate must be greater than zero' });
    const master = await one('SELECT * FROM plate_masters WHERE id=$1', [plateMasterId]);
    if (!master) return res.status(404).json({ error: 'Plate Master not found' });
    const [row] = await q(`INSERT INTO plate_rates
      (plate_master_id,vendor_id,rate_per_plate,effective_from,active)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [plateMasterId, req.body.vendor_id || null, rate,
     req.body.effective_from || plantDateStr(), req.body.active === 0 ? 0 : 1]);
    await audit('plate_rate', row.id, 'create',
      `${master.plate_size} @ Rs ${row.rate_per_plate}/plate${row.vendor_id ? ` (vendor ${row.vendor_id})` : ' (base)'}`,
      q, req.user.name);
    res.status(201).json(row);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'A rate already exists for this Plate Size and vendor. Edit that row instead.' });
    next(error);
  }
});

r.put('/plate-rates/:id', canEdit, async (req, res, next) => {
  try {
    const before = await one(`SELECT pr.*,pm.plate_size FROM plate_rates pr
      JOIN plate_masters pm ON pm.id=pr.plate_master_id WHERE pr.id=$1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Plate Rate not found' });
    if ('rate_per_plate' in req.body && !(Number(req.body.rate_per_plate) > 0)) {
      return res.status(400).json({ error: 'Rate must be greater than zero' });
    }
    const sets = [];
    const values = [];
    if ('rate_per_plate' in req.body) { values.push(Number(req.body.rate_per_plate)); sets.push(`rate_per_plate=$${values.length}`); }
    if ('effective_from' in req.body) { values.push(req.body.effective_from || plantDateStr()); sets.push(`effective_from=$${values.length}`); }
    if ('active' in req.body) { values.push(req.body.active ? 1 : 0); sets.push(`active=$${values.length}`); }
    if (!sets.length) return res.json(before);
    values.push(req.params.id);
    const [row] = await q(`UPDATE plate_rates SET ${sets.join(',')},updated_at=now()
      WHERE id=$${values.length} RETURNING *`, values);
    await audit('plate_rate', row.id, 'update',
      `${before.plate_size} rate Rs ${before.rate_per_plate} -> Rs ${row.rate_per_plate}/plate`, q, req.user.name);
    res.json(row);
  } catch (error) { next(error); }
});

r.delete('/plate-rates/:id', canEdit, async (req, res, next) => {
  try {
    const row = await one(`SELECT pr.*,pm.plate_size FROM plate_rates pr
      JOIN plate_masters pm ON pm.id=pr.plate_master_id WHERE pr.id=$1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Plate Rate not found' });
    await q('DELETE FROM plate_rates WHERE id=$1', [req.params.id]);
    await audit('plate_rate', row.id, 'delete',
      `${row.plate_size} @ Rs ${row.rate_per_plate}/plate`, q, req.user.name);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

export default r;
