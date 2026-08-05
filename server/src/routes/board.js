// Board allocation — who is holding this board, and how much is free. All
// arithmetic lives in board-allocation.js; this file only loads rows and hands
// them over.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, EFF_BOARD_ID, BOARD_DEMAND_STATUSES, mixFor, boardDrawnLineIds, boardClaimLines } from '../helpers.js';
import { requireRole } from '../auth.js';
import { boardPosition, linePosition, planMove, movableFrom, holdableFor, lineNeed, canGiveUpBoard, claimsByBoard, heldFor } from '../board-allocation.js';
import { mixPosition } from '../board-mix.js';

const r = Router();
const canMove = requireRole('planner');

// Every live line competing for this board, plus its gang identity so the
// client can group and lock gang rows exactly as the rest of the app does.
//
// "Live" is BOARD_DEMAND_STATUSES, which reaches into in_production: a job
// pushed to a job card but not yet cut is still waiting for these sheets, and
// leaving it out made the panel answer "nobody" about a board with thousands of
// sheets spoken for. It is listed so the planner can SEE the obstacle — taking
// board off it is refused below and in planMove(), because a job already on the
// floor is not a job to raid.
// board_material_id (the line's own EFFECTIVE board, spec_override included)
// is carried alongside — every row here already satisfies EFF_BOARD_ID=$1, so
// it is always equal to materialId, but the mix-aware helpers below want it on
// the line object rather than re-deriving "is this the line's own board" from
// context each time.
async function linesFor(materialId, qc = q) {
  return qc(`
    SELECT ol.id, ol.status, ol.planned_date, ol.gang_run_id, ol.stock_booking,
           COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
           ol.sheets_required, ${EFF_BOARD_ID} AS board_material_id,
           p.id AS product_id, p.name AS product_name, p.code AS product_code,
           p.party_artwork_code,
           o.po_number, o.delivery_date, c.name AS customer_name,
           g.gang_number
    FROM order_lines ol
    JOIN products  p ON p.id = ol.product_id
    JOIN orders    o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN gang_runs g ON g.id = ol.gang_run_id
    WHERE ${EFF_BOARD_ID} = $1 AND ol.status = ANY($2)
    ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`, [materialId, BOARD_DEMAND_STATUSES]);
}

// One batched load of every board_board_mix 'plan' row for a set of lines —
// avoids an N+1 per line on the panel, matching readinessBatch's own "wave"
// idiom in helpers.js.
async function mixByLine(lineIds, qc = q) {
  const byLine = new Map();
  if (!lineIds.length) return byLine;
  const rows = await qc(
    `SELECT * FROM job_board_mix WHERE order_line_id = ANY($1) AND phase='plan'
      ORDER BY order_line_id, (role='planned') DESC, id`,
    [lineIds]);
  for (const row of rows) {
    if (!byLine.has(row.order_line_id)) byLine.set(row.order_line_id, []);
    byLine.get(row.order_line_id).push(row);
  }
  return byLine;
}

// Spec touch point 2 (board.js) — the sixth site the design doc names and the
// plan's inventory of six missed. A mixed line's claim on ITS OWN planned
// board is what the mix has not yet covered, never the whole requirement —
// board-allocation.js's pure functions (lineNeed, holdableFor, movableFrom)
// all read a line's need from a single field, parent_sheets_required, so the
// correction is made to a COPY of that field at this boundary, exactly as the
// design doc specifies ("a new helper feeding linePosition, not an edit to
// board-allocation.js"). Only when materialId IS the line's own planned board
// — mixPosition's rule is that a SUBSTITUTE board never carries the unmet
// remainder, and a line being offered `materialId` as a brand new substitute
// (the general hold/move mechanism, which predates and is more general than
// the mix feature) must keep reading its full, un-adjusted need. A line with
// no mix at all is returned byte-identical: mixPosition returns null.
function mixAwareNeed(line, materialId, mixMap) {
  if (line.board_material_id !== materialId) return null;
  const rows = mixMap.get(line.id) || [];
  return mixPosition({ line, rows, materialId, plannedBoardId: materialId });
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
    const mixMap = await mixByLine(lines.map(l => l.id));

    const position = boardPosition({ available, allocations, lines, materialId });
    const prByLine = {};
    for (const pr of openPrs) if (pr.order_line_id) (prByLine[pr.order_line_id] ||= []).push(pr);

    // TWO different questions about the same board, and the panel needs both.
    //
    //   position.held / position.free — board physically HELD from stock, and
    //     what is therefore still handoutable. This is what the Move and Hold
    //     controls are allowed to act on, and movableFrom()/holdableFor() are
    //     built on it, so it must keep its meaning exactly.
    //
    //   committed / claimants — what named jobs are OWED (claimsByBoard, the
    //     same rule as the PR register and Smart Match). A board with nothing
    //     held but 3,650 sheets owed to two OMEZYME jobs is not free, and a
    //     panel that said "Free 4,850" while the register said 1,200 was the
    //     contradiction this closes.
    const claims = claimsByBoard({ lines: await boardClaimLines([materialId]), allocations })
      .get(materialId);
    const committed = claims?.committed || 0;

    res.json({
      board,
      ...position,
      committed,
      free_after_claims: available - committed,
      committed_on_order: claims?.on_order || 0,
      claimants: claims?.claimants || [],
      lines: lines.map(l => {
        const mixPos = mixAwareNeed(l, materialId, mixMap);
        return {
          ...l,
          // A balanced (or over-covered) mix must never show a negative need —
          // mixPosition already clamps open_need at zero for exactly this.
          need: mixPos ? mixPos.open_need : lineNeed(l),
          held: allocations.filter(a => a.source === 'stock' && a.order_line_id === l.id)
            .reduce((s, a) => s + Number(a.qty), 0),
          incoming: allocations.filter(a => a.source === 'requisition' && a.order_line_id === l.id)
            .reduce((s, a) => s + Number(a.qty), 0),
          // A job on the floor is shown, never offered: movable 0 collapses the
          // client's Move control, and planMove() refuses it server-side too.
          movable: canGiveUpBoard(l)
            ? movableFrom({ line: l, available, allocations, lines, materialId })
            : 0,
          can_give_up: canGiveUpBoard(l),
          // holdableFor takes only this one line, unlike movableFrom above
          // (which also needs the whole `lines` array for its own internal
          // boardPosition/free calculation) — so it is the one place this can
          // be corrected without touching how any OTHER line's hold is capped.
          holdable: mixPos ? mixPos.open_need : holdableFor({ line: l, allocations, materialId }),
          prs: prByLine[l.id] || [],
        };
      }),
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
      SELECT ol.id, ol.sheets_required, ${EFF_BOARD_ID} AS board_material_id,
             COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required
      FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.id=$1`, [lineId]);
    if (!line) return res.status(404).json({ error: 'Order line not found' });
    // Board already issued to cutting is spent, not outstanding — same rule as
    // the planning context. See openNeed()'s note on double-billing a draw.
    const others = lines.filter(l => l.id !== lineId);
    const drawn = await boardDrawnLineIds([lineId, ...others.map(l => l.id)]);
    const position = linePosition({
      line: { ...line, board_drawn: drawn.has(line.id) },
      others: others.map(l => ({ ...l, board_drawn: drawn.has(l.id) })),
      available, allocations, materialId,
    });
    // Same mix-aware correction the panel above applies, and the identical
    // pattern orders.js's planning context already runs for its own single-
    // line preview: a mixed line's claim on ITS OWN planned board is the
    // mix's unmet remainder, never the whole requirement. Unlike the panel,
    // this line may be previewing a board that is NOT its own planned board
    // at all (a substitute candidate — this route is generic over any
    // materialId/lineId pair), so mixAwareNeed's own board_material_id check
    // is what keeps a substitute-board preview reading exactly as it did
    // before this feature existed.
    const mix = await mixFor(lineId, 'plan', q);
    const mixPos = mixAwareNeed(line, materialId, new Map([[line.id, mix]]));
    const shown = mixPos
      ? { ...position,
          held_for_me: mixPos.held,
          my_open_need: mixPos.open_need,
          net: position.free - mixPos.open_need - position.others_open_need,
          short: Math.max(0, -(position.free - mixPos.open_need - position.others_open_need)) }
      : position;
    res.json(shown);
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
             ol.sheets_required, ${EFF_BOARD_ID} AS board_material_id,
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

// planMove (board-allocation.js) is not mix-aware — deliberately: its
// `holdableFor`/`movableFrom` conflate two things through one shared `lines`
// array (the per-line "cap a hold at what this line could ever need" that
// boardPosition's own `over_held` accounting depends on, and the per-line
// "how much MORE can this line take" that mixAwareNeed corrects above) and
// giving it an adjusted requirement for one line would silently corrupt the
// OTHER computation for that same line — a mix-covered line's existing,
// legitimate hold would misread as excess and inflate `free`. That is a
// bigger, more considered change than this fix warrants; see the commit
// message for the full reasoning.
//
// This is a narrower, independent, ADDITIVE ceiling instead: it can only
// REJECT a move planMove would otherwise allow, never permit one planMove
// itself refuses, so it cannot interact with board-allocation.js's own
// accounting at all. Only the RECEIVING line is checked — mixPosition's rule
// that a substitute board never carries the unmet remainder already makes the
// giving side self-limiting once its own board_allocations hold is taken back
// (planMove's own pr_new effect covers that). Returns Infinity (no ceiling)
// whenever `materialId` is not the line's own planned board, or the line
// carries no mix at all — the general hold/move mechanism, which predates and
// is broader than the mix feature, is otherwise unaffected.
async function mixMoveCeiling(toLineId, materialId, lines, qc) {
  const to = lines.find(l => l.id === toLineId);
  if (!to || to.board_material_id !== materialId) return Infinity;
  const rows = await mixFor(toLineId, 'plan', qc);
  const mixPos = mixAwareNeed(to, materialId, new Map([[to.id, rows]]));
  return mixPos ? mixPos.open_need : Infinity;
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

// Beyond what planMove itself blocks, also refuse a move that would push more
// board onto the receiving line's OWN planned board than its mix has left to
// cover — see mixMoveCeiling's own comment for why this lives here rather
// than inside planMove/board-allocation.js.
function applyMixCeiling(plan, ceiling, to) {
  if (!plan.ok || plan.qty <= ceiling + 1e-6) return plan;
  return {
    ...plan, ok: false,
    blockers: [...plan.blockers,
      `${to?.product_name || 'That job'}'s board mix already covers its requirement — it needs at most ${Math.round(ceiling)} more sheets here`],
  };
}

r.post('/board/move/preview', canMove, async (req, res, next) => {
  try {
    const { material_id, from_order_line_id, to_order_line_id, qty } = req.body;
    const inputs = await moveInputs(+material_id, q, [+from_order_line_id, +to_order_line_id]);
    const plan = planMove({
      materialId: +material_id,
      fromLineId: +from_order_line_id,
      toLineId: +to_order_line_id,
      qty: +qty,
      ...inputs,
    });
    const ceiling = await mixMoveCeiling(+to_order_line_id, +material_id, inputs.lines, q);
    res.json(applyMixCeiling(plan, ceiling, inputs.lines.find(l => l.id === +to_order_line_id)));
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
      const ceiling = await mixMoveCeiling(+to_order_line_id, +material_id, inputs.lines, qc);
      const plan = applyMixCeiling(planMove({
        materialId: +material_id,
        fromLineId: +from_order_line_id,
        toLineId: +to_order_line_id,
        qty: +qty,
        ...inputs,
      }), ceiling, inputs.lines.find(l => l.id === +to_order_line_id));
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

// ── Commit / uncommit — a planner's explicit hold on a board ────────────────
//
// Everything above answers "who is owed this board" by DERIVING it from live
// demand: plan a job on a board and it is committed, un-plan it and it is not.
// That is the right default and it stays exactly as it was. What it cannot do
// is let a planner say "this board is mine while I decide" — the only way to
// take a hold was to raid another job through /board/move, and the only way to
// give one back was to know the allocation's id.
//
// These two make the hold a first-class action on any board, from anywhere it
// is quoted (Board Position and every Smart Match row). A commit is a
// board_allocations row with source='stock' — the same row /board/move writes,
// read by the same boardPosition()/heldFor() arithmetic, so nothing downstream
// needed a new concept to understand it.
//
// The one hard rule: a commit can only ever take FREE stock. Never another
// job's hold — that is what /board/move is for, and it asks its own questions
// (a reason, a preview, a PR raised for the job being raided) that this must
// not become a silent shortcut around.
function commitInputs(materialId) {
  return Promise.all([availableFor(materialId), linesFor(materialId), allocationsFor(materialId)]);
}

// `qty` is the TOTAL this job wants held on this board, not an increment. The
// server holds the difference, so pressing Commit twice on the same row leaves
// the same hold rather than stacking a second one — the button says "Commit
// 2,600" and the answer to it is 2,600 held, however many times it is pressed.
r.post('/board/commit', canMove, async (req, res, next) => {
  try {
    const materialId = +req.body.material_id;
    const lineId = +req.body.order_line_id;
    const want = Math.round(+req.body.qty);
    if (!(want > 0)) return res.status(400).json({ error: 'How many sheets do you want to commit?' });

    const mat = await one('SELECT id, category, name FROM materials WHERE id=$1', [materialId]);
    if (!mat) return res.status(404).json({ error: 'Board not found' });
    if (mat.category !== 'board')
      return res.status(400).json({ error: `${mat.name} is not a board — only board can be committed to a job` });

    const out = await tx(async (qc) => {
      // Lock the line, then read the position fresh: a screen minutes old may
      // be quoting free stock another planner has since taken.
      await qc('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
      const [available, lines, allocations] = await commitInputs(materialId);
      const line = lines.find(l => l.id === lineId)
        || await one('SELECT id, status FROM order_lines WHERE id=$1', [lineId]);
      if (!line) throw Object.assign(new Error('Order line not found'), { status: 404 });

      const alreadyHeld = heldFor(allocations, lineId, materialId);
      const qty = want - alreadyHeld;
      if (qty <= 0) return { committed: 0, held_for_line: alreadyHeld, already: true };

      const { free } = boardPosition({ available, allocations, lines, materialId });
      if (qty > free) throw Object.assign(
        new Error(free > 0
          ? `Only ${Math.round(free)} more sheets of ${mat.name} are free — take the rest off another job to go further`
          : `No free ${mat.name} left to commit — every sheet is already held`),
        { status: 409, body: { code: 'COMMIT_EXCEEDS_FREE', free: Math.round(free) } });

      const reason = String(req.body.reason || '').trim() || 'Committed from the planning engine';
      await qc(`INSERT INTO board_allocations
                  (material_id, order_line_id, qty, source, reason, created_by)
                VALUES ($1,$2,$3,'stock',$4,$5)`, [materialId, lineId, qty, reason, req.user.name]);
      await audit('materials', materialId, 'board_committed',
        `${qty} sheets committed to order line #${lineId} — ${reason}`, qc, req.user.name);
      await audit('order_line', lineId, 'board_committed',
        `${qty} sheets of ${mat.name} committed — ${reason}`, qc, req.user.name);
      return { committed: qty, held_for_line: alreadyHeld + qty };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Give board back. `qty` absent releases this job's whole hold on the board;
// a number releases down TO the remainder — the existing rows are released and
// one fresh row re-takes what is being kept, because board_allocations rows are
// immutable ledger entries and partial-editing one would lose the trail of what
// was originally taken and when.
r.post('/board/uncommit', canMove, async (req, res, next) => {
  try {
    const materialId = +req.body.material_id;
    const lineId = +req.body.order_line_id;
    const mat = await one('SELECT id, category, name FROM materials WHERE id=$1', [materialId]);
    if (!mat) return res.status(404).json({ error: 'Board not found' });

    const out = await tx(async (qc) => {
      await qc('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
      const rows = await qc(
        `SELECT * FROM board_allocations
          WHERE material_id=$1 AND order_line_id=$2 AND source='stock' AND status='active'
          ORDER BY id`, [materialId, lineId]);
      const held = rows.reduce((s, a) => s + Number(a.qty), 0);
      if (!(held > 0)) throw Object.assign(
        new Error(`This job is not holding any ${mat.name}`), { status: 409, body: { code: 'NOTHING_COMMITTED' } });

      const askedRaw = req.body.qty;
      const asked = askedRaw === undefined || askedRaw === null || askedRaw === ''
        ? held : Math.round(+askedRaw);
      if (!(asked > 0)) throw Object.assign(new Error('How many sheets do you want to release?'), { status: 400 });
      const give = Math.min(asked, held);
      const keep = held - give;

      const reason = String(req.body.reason || '').trim() || 'Released from the planning engine';
      await qc(`UPDATE board_allocations SET status='released', released_at=now(),
                  released_by=$1, release_reason=$2
                WHERE id = ANY($3::int[])`, [req.user.name, reason, rows.map(a => a.id)]);
      if (keep > 0) {
        await qc(`INSERT INTO board_allocations
                    (material_id, order_line_id, qty, source, reason, created_by)
                  VALUES ($1,$2,$3,'stock',$4,$5)`,
          [materialId, lineId, keep, `Kept after releasing ${give} — ${reason}`, req.user.name]);
      }
      await audit('materials', materialId, 'board_uncommitted',
        `${give} sheets released from order line #${lineId} — ${reason}`, qc, req.user.name);
      await audit('order_line', lineId, 'board_uncommitted',
        `${give} sheets of ${mat.name} released${keep > 0 ? `, ${keep} kept` : ''} — ${reason}`, qc, req.user.name);
      return { released: give, held_for_line: keep };
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
