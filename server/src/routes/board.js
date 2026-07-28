// Board allocation — who is holding this board, and how much is free. All
// arithmetic lives in board-allocation.js; this file only loads rows and hands
// them over.
import { Router } from 'express';
import { q, one } from '../db.js';
import { EFF_BOARD_ID } from '../helpers.js';
import { boardPosition, linePosition, movableFrom, holdableFor, lineNeed } from '../board-allocation.js';

const r = Router();

// Every planned/ready line competing for this board, plus its gang identity so
// the client can group and lock gang rows exactly as the rest of the app does.
async function linesFor(materialId, qc = q) {
  return qc(`
    SELECT ol.id, ol.status, ol.planned_date, ol.gang_run_id,
           COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
           ol.sheets_required,
           p.id AS product_id, p.name AS product_name, p.code AS product_code,
           p.party_artwork_code,
           o.po_number, o.delivery_date, c.name AS customer_name,
           g.gang_number
    FROM order_lines ol
    JOIN products  p ON p.id = ol.product_id
    JOIN orders    o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN gang_runs g ON g.id = ol.gang_run_id
    WHERE ${EFF_BOARD_ID} = $1 AND ol.status IN ('planned','ready')
    ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`, [materialId]);
}

async function allocationsFor(materialId, qc = q) {
  return qc(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active' ORDER BY id`, [materialId]);
}

async function openPrsFor(materialId, qc = q) {
  return qc(`SELECT id, pr_number, qty, status, order_line_id, needed_by
             FROM requisitions
             WHERE material_id=$1 AND status IN ('pending','approved') ORDER BY id`, [materialId]);
}

async function availableFor(materialId, qc = q) {
  const [row] = await qc(
    `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`,
    [materialId]);
  return Number(row.q);
}

// Everything the panel renders, in one call.
r.get('/board/:materialId/panel', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const board = await one(
      'SELECT id, name, spec, category, grade, gsm, sheet_l, sheet_w FROM materials WHERE id=$1', [materialId]);
    if (!board) return res.status(404).json({ error: 'Board not found' });

    const [available, lines, allocations, openPrs] = await Promise.all([
      availableFor(materialId), linesFor(materialId), allocationsFor(materialId), openPrsFor(materialId),
    ]);

    const position = boardPosition({ available, allocations, lines, materialId });
    const prByLine = {};
    for (const pr of openPrs) if (pr.order_line_id) (prByLine[pr.order_line_id] ||= []).push(pr);

    res.json({
      board,
      ...position,
      lines: lines.map(l => ({
        ...l,
        need: lineNeed(l),
        held: allocations.filter(a => a.source === 'stock' && a.order_line_id === l.id)
          .reduce((s, a) => s + Number(a.qty), 0),
        incoming: allocations.filter(a => a.source === 'requisition' && a.order_line_id === l.id)
          .reduce((s, a) => s + Number(a.qty), 0),
        movable: movableFrom({ line: l, available, allocations, lines, materialId }),
        holdable: holdableFor({ line: l, allocations, materialId }),
        prs: prByLine[l.id] || [],
      })),
      unlinked_prs: openPrs.filter(pr => !pr.order_line_id),
    });
  } catch (e) { next(e); }
});

// Position for one line — the planning engine's numbers, from the same math.
//
// The line is resolved SEPARATELY and without a status filter: it is usually
// still 'pending' while the Planning Engine is open on it, so it is NOT in
// linesFor()'s planned/ready set. Passing it as `line` and the rest as `others`
// mirrors the `AND ol.id != $2` that has been correct in production for months.
r.get('/board/:materialId/position/:lineId', async (req, res, next) => {
  try {
    const materialId = +req.params.materialId;
    const lineId = +req.params.lineId;
    const [available, lines, allocations] = await Promise.all([
      availableFor(materialId), linesFor(materialId), allocationsFor(materialId),
    ]);
    const line = lines.find(l => l.id === lineId) || await one(`
      SELECT ol.id, ol.sheets_required,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required
      FROM order_lines ol WHERE ol.id=$1`, [lineId]);
    if (!line) return res.status(404).json({ error: 'Order line not found' });
    res.json(linePosition({
      line, others: lines.filter(l => l.id !== lineId), available, allocations, materialId,
    }));
  } catch (e) { next(e); }
});

export { linesFor, allocationsFor, openPrsFor, availableFor };
export default r;
