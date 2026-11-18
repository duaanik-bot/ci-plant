// What an approval does outside the artwork register (owner, 17 Nov 2026: approving ticks "artwork customer OK" on the
// product's open order lines; a newer version or "changes asked" never unticks a planned line). Shared by the client's
// reply (artwork-intake.js) and the person's Approve button (routes/artwork-flow.js).
import { audit } from './helpers.js';

// Moves versions to a stage, only from the stages given, and writes the history. → the versions that moved.
export async function moveStage(qc, { versionIds, to, from, by, action, detail = {} }) {
  if (!versionIds.length) return [];
  const moved = await qc(`UPDATE artwork_versions SET stage = $2, stage_at = now()
                           WHERE id = ANY($1::int[]) AND stage = ANY($3::text[]) AND deleted_at IS NULL
                           RETURNING id, job_id`, [versionIds, to, from]);
  for (const m of moved) {
    await qc(`INSERT INTO artwork_events (job_id, version_id, action, detail, by_name) VALUES ($1, $2, $3, $4, $5)`,
      [m.job_id, m.id, action || to, JSON.stringify(detail), by]);
  }
  return moved;
}

// The product's open, unlocked order lines get the customer's approval ticked — when the product's NEWEST live artwork,
// across every artwork job of that product, is approved or released. (An older approved version behind a newer one
// says nothing about what prints now.) Lines raised later are ticked by the order_lines trigger (migration
// 20261118100000); open orders are 'draft' (a PO the intake drafted), 'pending' or 'hold'. → how many lines.
export async function tickIfApproved(qc, productId, by) {
  if (!productId) return 0;
  const [last] = await qc(`SELECT v.id, v.stage, v.label, j.job_no FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id
                            WHERE j.product_id = $1 AND v.deleted_at IS NULL AND v.status <> 'not_artwork' ORDER BY v.id DESC LIMIT 1`, [productId]);
  if (!last || !['approved', 'released'].includes(last.stage)) return 0;
  const lines = await qc(`UPDATE order_lines l SET artwork_customer_ok = 1
                           FROM orders o
                          WHERE l.order_id = o.id AND o.status IN ('draft', 'pending', 'hold') AND l.product_id = $1 AND l.artwork_locked = 0
                            AND l.artwork_customer_ok = 0 AND l.status NOT IN ('dispatched', 'cancelled')
                          RETURNING l.id`, [productId]);
  for (const l of lines) await audit('order_line', l.id, 'artwork', `Customer approved — artwork ${last.job_no} ${last.label}`, qc, by);
  return lines.length;
}

// After a version is approved: tick its product's lines (if it is the product's newest).
export async function tickOrderLines(qc, versionId, by) {
  const [v] = await qc(`SELECT j.product_id FROM artwork_versions v JOIN artwork_jobs j ON j.id = v.job_id WHERE v.id = $1`, [versionId]);
  return tickIfApproved(qc, v?.product_id, by);
}
