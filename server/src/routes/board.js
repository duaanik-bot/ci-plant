// Board allocation — who is holding this board, and how much is free. All
// arithmetic lives in board-allocation.js; this file only loads rows and hands
// them over.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, EFF_BOARD_ID } from '../helpers.js';
import { requireRole } from '../auth.js';
import { boardPosition, linePosition, planMove, movableFrom, holdableFor, lineNeed } from '../board-allocation.js';

const r = Router();
const canMove = requireRole('planner');

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

// Load everything planMove needs, inside whatever transaction the caller owns.
// `wanted` lines missing from the planned/ready set are fetched explicitly: the
// receiving job is often still 'pending' (a line only becomes 'planned' at the
// end of the plan-save), and rejecting that as "no longer planned" would make
// the feature unusable on exactly the jobs it exists to help.
async function moveInputs(materialId, qc, wanted = []) {
  const [available, lines, allocations, openPrs] = await Promise.all([
    availableFor(materialId, qc), linesFor(materialId, qc),
    allocationsFor(materialId, qc), openPrsFor(materialId, qc),
  ]);
  const missing = wanted.filter(id => id && !lines.some(l => l.id === id));
  if (missing.length) {
    const extra = await qc(`
      SELECT ol.id, ol.status, ol.planned_date, ol.gang_run_id,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
             ol.sheets_required,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             o.po_number, o.delivery_date, c.name AS customer_name, g.gang_number
      FROM order_lines ol
      JOIN products  p ON p.id = ol.product_id
      JOIN orders    o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs g ON g.id = ol.gang_run_id
      WHERE ol.id = ANY($1::int[])`, [missing]);
    lines.push(...extra);
  }
  return { available, lines, allocations, openPrs };
}

// Same mirror rule as procurement.js: an open PR naming an order line always has
// a matching requisition-source allocation, so the planning engine sees incoming
// board as coverage.
async function syncMovedPrAllocation(qc, pr, close) {
  if (!pr?.order_line_id) return;
  await qc(`UPDATE board_allocations SET status='released', released_at=now()
            WHERE requisition_id=$1 AND status='active'`, [pr.id]);
  if (close || !(Number(pr.qty) > 0)) return;
  await qc(`INSERT INTO board_allocations
              (material_id, order_line_id, qty, source, requisition_id, reason, created_by)
            VALUES ($1,$2,$3,'requisition',$4,$5,$6)`,
    [pr.material_id, pr.order_line_id, pr.qty, pr.id,
     `Incoming on ${pr.pr_number}`, pr.requested_by || null]);
}

r.post('/board/move/preview', canMove, async (req, res, next) => {
  try {
    const { material_id, from_order_line_id, to_order_line_id, qty } = req.body;
    const inputs = await moveInputs(+material_id, q, [+from_order_line_id, +to_order_line_id]);
    res.json(planMove({
      materialId: +material_id,
      fromLineId: +from_order_line_id,
      toLineId: +to_order_line_id,
      qty: +qty,
      ...inputs,
    }));
  } catch (e) { next(e); }
});

r.post('/board/move', canMove, async (req, res, next) => {
  try {
    const { material_id, from_order_line_id, to_order_line_id, qty } = req.body;
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to move board between jobs' });

    // Allocations are a board concept. Inks and consumables have no order-line
    // demand competing over them, so there is nothing to reshuffle.
    const mat = await one('SELECT category, name FROM materials WHERE id=$1', [+material_id]);
    if (!mat) return res.status(404).json({ error: 'Material not found' });
    if (mat.category !== 'board')
      return res.status(400).json({ error: `${mat.name} is not a board — only board can be held for a job` });

    const out = await tx(async (qc, oc) => {
      // Lock both lines for the life of the transaction, then re-plan from
      // freshly read rows — a client preview may be minutes stale.
      await qc('SELECT id FROM order_lines WHERE id=ANY($1::int[]) FOR UPDATE',
        [[+from_order_line_id, +to_order_line_id]]);
      const inputs = await moveInputs(+material_id, qc, [+from_order_line_id, +to_order_line_id]);
      const plan = planMove({
        materialId: +material_id,
        fromLineId: +from_order_line_id,
        toLineId: +to_order_line_id,
        qty: +qty,
        ...inputs,
      });
      if (!plan.ok)
        throw Object.assign(new Error(plan.blockers[0]),
          { status: 409, body: { code: 'move_blocked', blockers: plan.blockers } });

      const from = inputs.lines.find(l => l.id === +from_order_line_id);
      const to = inputs.lines.find(l => l.id === +to_order_line_id);
      const raised = [];

      for (const e of plan.effects) {
        if (e.kind === 'hold') {
          await qc(`INSERT INTO board_allocations
                      (material_id, order_line_id, qty, source, reason, created_by)
                    VALUES ($1,$2,$3,'stock',$4,$5)`,
            [+material_id, e.order_line_id, e.qty, reason, req.user.name]);
        }
        if (e.kind === 'pr_down') {
          const [pr] = e.close
            ? await qc(`UPDATE requisitions SET qty=$1, status='closed', status_reason=$3
                        WHERE id=$2 RETURNING *`,
                [e.new_qty, e.requisition_id, `Covered from stock — ${reason}`])
            : await qc(`UPDATE requisitions SET qty=$1 WHERE id=$2 RETURNING *`,
                [e.new_qty, e.requisition_id]);
          await qc('UPDATE requisition_lines SET qty=$1 WHERE requisition_id=$2',
            [e.new_qty, e.requisition_id]);
          await syncMovedPrAllocation(qc, pr, e.close);
          await audit('requisition', e.requisition_id,
            e.close ? 'covered_from_stock' : 'reduced_by_move',
            `${e.text} — board moved to ${to.product_name} (${reason})`, qc, req.user.name);
        }
        if (e.kind === 'pr_new') {
          const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number', oc);
          const [pr] = await qc(
            `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                       requested_by, priority, order_line_id)
             VALUES ($1,$2,$3,$4,$5,$6,'normal',$7) RETURNING *`,
            [pr_number, +material_id, e.qty, from.delivery_date || null,
             `Board moved to ${to.product_name} — auto-raised (${reason})`,
             req.user.name, e.order_line_id]);
          await qc(`INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
                    VALUES ($1,$2,$3,$4)`, [pr.id, +material_id, e.qty, from.delivery_date || null]);
          await syncMovedPrAllocation(qc, pr, false);
          raised.push(pr);
          await audit('requisition', pr.id, 'create_from_move',
            `${pr_number} auto-raised for ${from.product_name} — board moved to ${to.product_name} (${reason})`,
            qc, req.user.name);
        }
      }

      const summary = `${plan.qty} parent sheets moved ${from.product_name} → ${to.product_name} — ${reason}`;
      await audit('materials', +material_id, 'board_moved', summary, qc, req.user.name);
      await audit('order_line', from.id, 'board_moved_out', summary, qc, req.user.name);
      await audit('order_line', to.id, 'board_moved_in', summary, qc, req.user.name);

      return { ...plan, raised };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.post('/board/allocations/:id/release', canMove, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to release held board' });
    const a = await one('SELECT * FROM board_allocations WHERE id=$1', [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.status !== 'active') return res.status(409).json({ error: `This hold is already ${a.status}` });
    await tx(async (qc) => {
      await qc(`UPDATE board_allocations SET status='released', released_at=now(),
               released_by=$1, release_reason=$2 WHERE id=$3`, [req.user.name, reason, a.id]);
      await audit('materials', a.material_id, 'board_hold_released',
        `${a.qty} sheets released from order line #${a.order_line_id} — ${reason}`, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export { linesFor, allocationsFor, openPrsFor, availableFor };
export default r;
