// Board Stock Verification — the warehouse's pre-cutting physical check.
//
// The report lists every board with live, un-drawn claims and the jobs still
// AWAITING cutting that make up its cumulative requirement, so the warehouse
// can walk the rack and confirm the sheets are really there before the queue
// arrives. It is an operational check only: it never reserves stock, never
// adjusts stock, and never blocks Cutting — a job the warehouse has not
// verified still starts normally, and the moment cutting starts the job drops
// off this report on its own.
//
// All board arithmetic lives in board-allocation.js / helpers.js — this file
// only loads rows and hands them over (the board.js contract). Committed
// demand is claimsByBoard() over boardClaimLines(); a spelling of the demand
// rule in this file would be the seventh copy of a rule that already burned
// two screens.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { audit, boardClaimLines, openPrLineIds } from '../helpers.js';
import { claimsByBoard } from '../board-allocation.js';
import {
  CUTTING_LABEL, cuttingStatusOf,
  VERIFICATION_STATUSES, VERIFICATION_LABEL, COUNTED_STATUSES,
  verificationComputed, verificationStale, poolVerdict,
} from '../verification-logic.js';

const r = Router();

// Physical verification is a floor/warehouse act, not an inventory adjustment:
// production records the count, planning owns any stock correction that
// follows (through the existing adjustment paths). Admin passes implicitly.
const canVerify = requireRole('planner', 'production');

const num = v => Number(v || 0);

// The per-line facts the report shows beside each claim: order/customer dates,
// the job card (a gang member reads the RUN's parent card — order_line_id is
// NULL on those, so the lateral tries the line's own card first and falls back
// to the run parent), and the cutting-bearing stage. The first stage of a card
// is where board is drawn, so when a routing carries no explicit 'cutting'
// stage the earliest stage answers for it.
async function lineDetails(lineIds, qc = q) {
  if (!lineIds.length) return new Map();
  const rows = await qc(`
    SELECT ol.id, ol.qty AS order_qty, ol.fg_consumed_qty, ol.status AS line_status,
           ol.planned_date, ol.sheets_required, ol.notes AS line_notes,
           o.po_number, o.po_date, o.delivery_date, o.created_at AS order_created_at,
           p.party_artwork_code, p.internal_carton_code, p.party_item_code,
           jc.id AS jc_id, jc.jc_number, jc.created_at AS jc_created_at, jc.status AS jc_status,
           cs.status AS stage_status, cs.started_at AS stage_started_at
    FROM order_lines ol
    JOIN orders o ON o.id = ol.order_id
    JOIN products p ON p.id = ol.product_id
    LEFT JOIN LATERAL (
      SELECT j.id, j.jc_number, j.created_at, j.status FROM job_cards j
      WHERE j.order_line_id = ol.id
         OR (ol.gang_run_id IS NOT NULL AND j.order_line_id IS NULL AND j.gang_run_id = ol.gang_run_id)
      ORDER BY (j.order_line_id = ol.id) DESC, j.id DESC
      LIMIT 1
    ) jc ON true
    LEFT JOIN LATERAL (
      SELECT js.status, js.started_at FROM job_stages js
      WHERE js.job_card_id = jc.id
      ORDER BY (js.stage = 'cutting') DESC, js.seq
      LIMIT 1
    ) cs ON true
    WHERE ol.id = ANY($1)`, [lineIds]);
  return new Map(rows.map(x => [x.id, x]));
}

// A claimant becomes a report job while its cutting has not started. Claimants
// arrive from claimsByBoard, which has already dropped every DRAWN line, so
// board_drawn is false by construction here; the stage status catches the rare
// start that has not yet posted its consumption.
function enrichJobs(claimants, detailBy, openPr) {
  return claimants
    .map(cl => {
      const d = detailBy.get(cl.order_line_id) || {};
      const cutting_status = cuttingStatusOf({
        board_drawn: false,
        has_card: d.jc_id != null,
        stage_status: d.stage_status,
        started_at: d.stage_started_at,
        planned_date: d.planned_date,
      });
      return {
        ...cl,
        order_qty: d.order_qty ?? null,
        planned_qty: d.order_qty != null ? Math.max(0, num(d.order_qty) - num(d.fg_consumed_qty)) : null,
        sheets_required: d.sheets_required ?? null,
        line_status: d.line_status || cl.status,
        line_notes: d.line_notes || null,
        po_date: d.po_date || null,
        delivery_date: d.delivery_date || null,
        planned_date: d.planned_date || null,
        order_created_at: d.order_created_at || null,
        party_artwork_code: d.party_artwork_code || null,
        internal_carton_code: d.internal_carton_code || null,
        party_item_code: d.party_item_code || null,
        jc_number: d.jc_number || null,
        jc_created_at: d.jc_created_at || null,
        cutting_status,
        cutting_status_label: CUTTING_LABEL[cutting_status],
        pr_covered: openPr.has(cl.order_line_id),
      };
    })
    .filter(j => j.cutting_status !== 'started');
}

// GET /board-verification/report — the whole report in one payload: every
// board with jobs awaiting cutting, its pool position, incoming paper, and
// the latest physical-verification event.
r.get('/board-verification/report', async (_req, res, next) => {
  try {
    const lines = await boardClaimLines();
    const allocations = await q(
      `SELECT order_line_id, material_id, qty, source, status
         FROM board_allocations WHERE status='active'`);
    const claims = claimsByBoard({ lines, allocations });
    if (!claims.size) return res.json({ boards: [], generated_at: new Date().toISOString() });

    const materialIds = [...claims.keys()];
    const lineIds = [...claims.values()].flatMap(c => c.claimants.map(cl => cl.order_line_id));

    const [detailBy, openPr, prDocs, poDocs, stock, mats, verifs] = await Promise.all([
      lineDetails(lineIds),
      openPrLineIds(lineIds),
      q(`SELECT material_id, pr_number, qty, status, created_at
           FROM requisitions
          WHERE material_id = ANY($1) AND status IN ('pending','approved')
          ORDER BY id`, [materialIds]),
      q(`SELECT pl.material_id, po.po_number, po.status, po.expected_date,
                GREATEST(0, pl.qty - COALESCE(pl.received_qty, 0)) AS pending_qty
           FROM po_lines pl
           JOIN purchase_orders po ON po.id = pl.purchase_order_id
          WHERE pl.material_id = ANY($1) AND po.status IN ('open','partially_received')
            AND NOT pl.closed_short
            AND pl.qty > COALESCE(pl.received_qty, 0)
          ORDER BY po.id`, [materialIds]),
      q(`SELECT material_id, COALESCE(SUM(qty),0) AS available
           FROM stock_batches
          WHERE material_id = ANY($1) AND status='available'
          GROUP BY material_id`, [materialIds]),
      // A leftover strip inherits grade/GSM/packet size from its mother board
      // but keeps its own sheet size — the inventory.js COALESCE trio.
      q(`SELECT m.id, m.name, m.code, m.sheet_l, m.sheet_w, m.leftover,
                COALESCE(m.grade, src.grade) AS grade,
                COALESCE(m.gsm, src.gsm) AS gsm,
                COALESCE(m.sheets_per_packet, src.sheets_per_packet) AS sheets_per_packet
           FROM materials m
           LEFT JOIN materials src ON src.id = m.source_material_id
          WHERE m.id = ANY($1)`, [materialIds]),
      q(`SELECT DISTINCT ON (material_id) *
           FROM board_verifications
          WHERE material_id = ANY($1)
          ORDER BY material_id, id DESC`, [materialIds]),
    ]);

    const matBy = new Map(mats.map(m => [m.id, m]));
    const stockBy = new Map(stock.map(s => [s.material_id, num(s.available)]));
    const verifBy = new Map(verifs.map(v => [v.material_id, v]));
    const group = (rows, key) => {
      const out = new Map();
      for (const row of rows) {
        if (!out.has(row[key])) out.set(row[key], []);
        out.get(row[key]).push(row);
      }
      return out;
    };
    const prBy = group(prDocs, 'material_id');
    const poBy = group(poDocs, 'material_id');

    const boards = [];
    for (const [mid, entry] of claims) {
      const m = matBy.get(mid);
      if (!m) continue;
      const jobs = enrichJobs(entry.claimants, detailBy, openPr);
      // Every job on this board has started cutting — the board has left the
      // verification report, exactly as the floor expects.
      if (!jobs.length) continue;

      const available = stockBy.get(mid) || 0;
      const prs = prBy.get(mid) || [];
      const pos = poBy.get(mid) || [];
      const pr_pending_qty = prs.reduce((s, x) => s + num(x.qty), 0);
      const po_pending_qty = pos.reduce((s, x) => s + num(x.pending_qty), 0);
      const incoming = pr_pending_qty + po_pending_qty;
      // The pool verdict is measured against COMMITTED — every live, un-drawn
      // claim on this board — so it can never read better than the register.
      const verdict = poolVerdict({ available, required: entry.committed, incoming });

      const verification = verifBy.get(mid) || null;
      const required = jobs.reduce((s, j) => s + num(j.need), 0);
      const dates = k => jobs.map(j => j[k]).filter(Boolean).sort();

      boards.push({
        material_id: mid,
        board_name: m.name,
        board_code: m.code,
        grade: m.grade,
        gsm: m.gsm,
        sheet_l: m.sheet_l,
        sheet_w: m.sheet_w,
        sheets_per_packet: m.sheets_per_packet,
        leftover: !!m.leftover,
        available,
        committed: entry.committed,
        free: available - entry.committed,
        on_order: entry.on_order,
        required,
        jobs,
        job_count: jobs.length,
        earliest_planned_date: dates('planned_date')[0] || null,
        earliest_delivery_date: dates('delivery_date')[0] || null,
        stock_state: verdict.state,
        shortage: verdict.shortage,
        uncovered: verdict.uncovered,
        pr_pending_qty,
        po_pending_qty,
        prs,
        pos,
        verification_status: verification?.status || 'pending',
        verification,
        verification_stale: verificationStale(verification, required),
      });
    }

    boards.sort((a, b) =>
      b.uncovered - a.uncovered || b.shortage - a.shortage
      || String(a.earliest_planned_date || '9999').localeCompare(String(b.earliest_planned_date || '9999'))
      || String(a.board_name).localeCompare(String(b.board_name)));

    res.json({ boards, generated_at: new Date().toISOString() });
  } catch (e) { next(e); }
});

// POST /board-verification/:materialId/verify — record one physical
// verification event. Snapshots the live requirement and book stock so the
// event stays honest after the job set moves on. Never touches stock.
r.post('/board-verification/:materialId/verify', canVerify, async (req, res, next) => {
  try {
    const mid = +req.params.materialId;
    const { status, physical_qty = null, remarks = null } = req.body || {};
    if (!VERIFICATION_STATUSES.includes(status)) {
      throw Object.assign(new Error('Unknown verification status'), { status: 400 });
    }
    const physical = physical_qty === null || physical_qty === '' ? null : +physical_qty;
    if (physical != null && !(Number.isFinite(physical) && physical >= 0)) {
      throw Object.assign(new Error('Physical quantity must be zero or more sheets'), { status: 400 });
    }
    if (COUNTED_STATUSES.includes(status) && physical == null) {
      throw Object.assign(new Error(`${VERIFICATION_LABEL[status]} needs the physically counted quantity`), { status: 400 });
    }
    const m = await one('SELECT id, name FROM materials WHERE id=$1', [mid]);
    if (!m) throw Object.assign(new Error('Board not found'), { status: 404 });

    // Live figures at the moment of the count — the snapshot the row keeps.
    const lines = await boardClaimLines([mid]);
    const allocations = await q(
      `SELECT order_line_id, material_id, qty, source, status
         FROM board_allocations WHERE material_id=$1 AND status='active'`, [mid]);
    const entry = claimsByBoard({ lines, allocations }).get(mid);
    const detailBy = await lineDetails((entry?.claimants || []).map(c => c.order_line_id));
    const jobs = enrichJobs(entry?.claimants || [], detailBy, new Set());
    const required = jobs.reduce((s, j) => s + num(j.need), 0);
    const available = num((await one(
      `SELECT COALESCE(SUM(qty),0) AS a FROM stock_batches
        WHERE material_id=$1 AND status='available'`, [mid]))?.a);

    // 'Material Not Found' with no count IS a count of zero on the shelf.
    const counted = physical == null && status === 'not_found' ? 0 : physical;
    const comp = verificationComputed({ physical_qty: counted, required_qty: required, available_qty: available });
    const prev = await one(
      'SELECT status FROM board_verifications WHERE material_id=$1 ORDER BY id DESC LIMIT 1', [mid]);
    const prevLabel = VERIFICATION_LABEL[prev?.status || 'pending'];

    const row = await tx(async (qc) => {
      const [v] = await qc(
        `INSERT INTO board_verifications
           (material_id, status, physical_qty, required_qty, available_qty,
            shortage_qty, excess_qty, remarks, verified_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [mid, status, counted, required, available,
         comp.shortage_qty, comp.excess_qty, remarks || null, req.user.name]);
      await audit('materials', mid, 'board_verification',
        (`${VERIFICATION_LABEL[status]}`
          + (counted != null ? ` — counted ${Math.round(counted)} against book ${Math.round(available)}, jobs need ${Math.round(required)}` : '')
          + (comp.shortage_qty > 0 ? ` · short ${Math.round(comp.shortage_qty)}` : '')
          + (comp.excess_qty > 0 ? ` · excess ${Math.round(comp.excess_qty)}` : '')
          + ` (was ${prevLabel})`
          + (remarks ? ` — ${remarks}` : '')).slice(0, 500),
        qc, req.user.name);
      return v;
    });

    res.json({ ...row, prev_status: prev?.status || 'pending', variance_vs_book: comp.variance_vs_book });
  } catch (e) { next(e); }
});

// GET /board-verification/records — the verification history (audit trail +
// the Excel "Physical Verification Records" sheet). Newest first.
r.get('/board-verification/records', async (req, res, next) => {
  try {
    const mid = req.query.material_id ? +req.query.material_id : null;
    const params = [];
    let where = '';
    if (mid) { params.push(mid); where = 'WHERE v.material_id=$1'; }
    const rows = await q(
      `SELECT v.*, m.name AS board_name, m.code AS board_code
         FROM board_verifications v
         JOIN materials m ON m.id = v.material_id
         ${where}
        ORDER BY v.id DESC
        LIMIT 500`, params);
    res.json(rows.map(v => ({ ...v, status_label: VERIFICATION_LABEL[v.status] || v.status })));
  } catch (e) { next(e); }
});

export default r;
