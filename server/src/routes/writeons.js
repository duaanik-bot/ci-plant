// The warehouse's recount queue. A write-on is an open question — "the book
// said 40, the floor took 150" — and it stays open until somebody physically
// counts the shelf. Reconciling books the difference so the mismatch is FIXED,
// not merely acknowledged.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { audit, issueWithWriteOn } from '../helpers.js';
import { requireRole } from '../auth.js';

const r = Router();
const canReconcile = requireRole('planner');

const WO_VIEW = `
  SELECT w.*, m.name AS material_name, m.code AS material_code, m.unit,
         COALESCE((SELECT SUM(qty) FROM stock_batches
                   WHERE material_id=w.material_id AND status='available'), 0) AS book_now
  FROM stock_writeons w
  JOIN materials m ON m.id = w.material_id`;

r.get('/stock-writeons', async (req, res, next) => {
  try {
    const openOnly = String(req.query.open ?? '') === '1';
    res.json(await q(
      `${WO_VIEW} ${openOnly ? 'WHERE w.reconciled_at IS NULL' : ''}
       ORDER BY w.reconciled_at IS NOT NULL, w.created_at`, []));
  } catch (e) { next(e); }
});

r.post('/stock-writeons/:id/reconcile', canReconcile, async (req, res, next) => {
  try {
    const counted = Number(req.body?.counted_qty);
    if (!Number.isFinite(counted) || counted < 0)
      return res.status(400).json({ error: 'A physical count is required, and cannot be negative' });

    await tx(async (qc, oc) => {
      const w = await oc('SELECT * FROM stock_writeons WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!w) throw Object.assign(new Error('Write-on not found'), { status: 404 });
      if (w.reconciled_at)
        throw Object.assign(new Error(`Already reconciled by ${w.reconciled_by}`), { status: 409 });

      const book = Number((await oc(
        `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`,
        [w.material_id]))?.q || 0);
      const delta = counted - book;

      // delta === 0 is a real outcome: the book was right and the floor
      // miscounted. It books nothing and still closes the row.
      if (delta !== 0) {
        const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [w.material_id]))?.unit || 'sheets';
        const note = `Recount of write-on #${w.id} — counted ${counted}, book ${book}`
          + `${req.body?.note ? ` (${req.body.note})` : ''}`;
        if (delta > 0) {
          const [b] = await qc(
            `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
             VALUES ($1,$2,$3,$3,$4,'available') RETURNING id`,
            [w.material_id, `RECOUNT-${w.id}`, delta, unit]);
          await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                    VALUES ($1,$2,'adjustment',$3,'stock_writeon',$4,$5)`,
            [w.material_id, b.id, delta, w.id, note]);
        } else {
          // A count BELOW the book is a further reduction — it takes the same
          // clamp-at-nil path, so a recount can never drive the board negative.
          await issueWithWriteOn(w.material_id, -delta, 'stock_writeon', w.id, note, qc, oc,
            { reason: 'Recount', user: req.user.name, unit });
        }
      }

      await qc(`UPDATE stock_writeons
                SET reconciled_at=now(), reconciled_by=$1, counted_qty=$2, reconcile_note=$3
                WHERE id=$4`,
        [req.user.name, counted, (req.body?.note || '').trim() || null, w.id]);
      await audit('materials', w.material_id, 'writeon_reconciled',
        `Write-on #${w.id} reconciled — counted ${counted} against a book of ${book}`
        + `${delta === 0 ? '; book was correct' : `; adjusted by ${delta > 0 ? '+' : ''}${delta}`}`,
        qc, req.user.name);
      await qc(`UPDATE notifications SET read_at=now()
                WHERE ref_table='stock_writeons' AND ref_id=$1 AND read_at IS NULL`, [w.id]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
