// Procurement — PR → PO → GRN → QC → stock. Every hand-off is real.
import { Router } from 'express';
import { PLANT_TODAY_SQL } from '../plant-calendar.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, grnLooseSheets, EFF_BOARD_ID, BOARD_DEMAND_SQL, BOARD_DEMAND_STATUSES, BOARD_DRAWN_EXISTS, boardClaimLines } from '../helpers.js';
import { planProcurementDelete } from '../procurement-delete.js';
import { requireRole } from '../auth.js';
import { resolveRatePerKg, ratePerSheet, totalWeight } from '../board-math.js';
import { normalisePurpose } from '../replenishment.js';
import { mirrorTargets, gangPrShares, stockSurplus, lineNeed, heldFor, incomingFor, coverSuggestions, claimsByBoard } from '../board-allocation.js';
import { packetsOf, eligibilityOf, trimOf, planSubstitution } from '../grn-substitution.js';
import { consolidate, consolidateEdit } from '../po-consolidate.js';
import { planPrQtyChange } from '../pr-qty-cascade.js';
import { grnEditPlan } from '../grn-edit.js';

// An open PR that names an order line ALWAYS has a matching requisition-source
// allocation of the same quantity. This is what lets the planning engine see an
// incoming PR as coverage — without it, a job whose PR was just raised would
// still read "short", which is the single most confusing outcome this feature
// could produce. Called on every transition that changes a PR's life or size.
//
// When the line named prints in a GANG the board is bought for the whole run,
// so the mirror lands on every member in proportion to what each needs. The
// scope is re-derived on every call, so approve / edit-qty / convert / delete
// all keep it true without knowing about gangs at all. Exported because
// gangs.js raises the gang's combined PR.
//
// mirrorTargets() then drops any line that is no longer ON this board. A PR's
// material_id is a snapshot of what was short when it was raised: re-anchor the
// job afterwards and mirroring it blind books incoming stock against work that
// has left. CI-PR-0006 bought 300 GSM for a gang that moved to 296 GSM and ran
// from stock — approving it would otherwise have re-created that phantom.
export async function syncPrAllocation(qc, pr, { close = false } = {}) {
  if (!pr?.order_line_id) return;
  const mat = await qc(`SELECT category FROM materials WHERE id=$1`, [pr.material_id]);
  if (mat[0]?.category !== 'board') return;

  await qc(`UPDATE board_allocations SET status='released', released_at=now()
            WHERE requisition_id=$1 AND status='active'`, [pr.id]);
  const open = !close && ['pending', 'approved', 'converted'].includes(pr.status) && Number(pr.qty) > 0;
  if (!open) return;

  const scope = await qc(`
    SELECT ol.id, ol.parent_sheets_required, ol.sheets_required,
           ${EFF_BOARD_ID} AS eff_board
    FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.id = $1
       OR (ol.gang_run_id IS NOT NULL
           AND ol.gang_run_id = (SELECT gang_run_id FROM order_lines WHERE id=$1))
    ORDER BY ol.id`, [pr.order_line_id]);
  const rows = mirrorTargets({ materialId: pr.material_id, qty: pr.qty }, scope);

  for (const row of rows) {
    if (!(Number(row.qty) > 0)) continue;
    await qc(`INSERT INTO board_allocations
                (material_id, order_line_id, qty, source, requisition_id, reason, created_by)
              VALUES ($1,$2,$3,'requisition',$4,$5,$6)`,
      [pr.material_id, row.order_line_id, row.qty, pr.id,
       `Incoming on ${pr.pr_number}`, pr.requested_by || null]);
  }
}

const r = Router();
const canBuy = requireRole('planner');
// Raising a requisition is an ASK, not a commitment — the storekeeper who can
// see a board is short should be able to say so without a planner relaying it.
// Approval, edit, convert-to-PO and delete all stay on canBuy, so widening who
// can ask does not widen who can commit spend. `viewer` stays out: it is the
// read-only role by definition. `admin` passes every requireRole already.
const canRaisePr = requireRole('planner', 'production', 'qc');
const canQc = requireRole('qc');

// A board's PO rate is derived: the grade's ₹/kg (vendor row beating the base
// row) × that board's kg/sheet. Non-board materials keep the manual std_rate,
// then last_rate. A board with no rate on file returns null so the buyer sees
// "no rate" rather than a silently stale historical price. Pure — no awaiting.
export function resolvePoRate(material, vendorId, rates) {
  if (material?.category !== 'board') {
    return { rate: +material?.std_rate || +material?.last_rate || 0, source: material?.std_rate ? 'std' : 'last' };
  }
  const rk = resolveRatePerKg(rates, material.grade, vendorId);
  if (!rk) return { rate: null, source: 'none' };
  const rs = ratePerSheet(material, rk.rate_per_kg);
  return rs == null
    ? { rate: null, source: 'none' }
    : { rate: rs, rate_per_kg: rk.rate_per_kg, source: rk.source };
}

// The buyer's keyed rate wins when present — including a deliberate 0 (a free
// line) — otherwise fall to the resolved master rate, then 0. Presence, not
// truthiness, so 0 is honoured and blank ('' / null / undefined) defers. An
// unrated board resolves to null → the line falls to 0 ("no rate on file").
export function pickPoRate(buyerRate, resolved) {
  return buyerRate != null && buyerRate !== '' ? +buyerRate : (resolved?.rate ?? 0);
}

// Normalise an incoming requisition body to a clean list of lines. Back-compat:
// a legacy { material_id, qty } body (Planning engine, older callers) collapses
// to a single line, so multi-line and single-material callers share one path.
function reqLinesFrom(body) {
  const raw = Array.isArray(body.lines) && body.lines.length
    ? body.lines
    : (body.material_id ? [{ material_id: body.material_id, qty: body.qty,
        est_rate: body.est_rate, needed_by: body.needed_by, remarks: body.remarks }] : []);
  return raw.map(l => ({
    material_id: +l.material_id,
    qty: +l.qty,
    est_rate: l.est_rate != null && l.est_rate !== '' ? +l.est_rate : null,
    needed_by: l.needed_by || null,
    remarks: l.remarks || null,
  })).filter(l => l.material_id && l.qty > 0);
}

async function insertReqLines(qc, requisitionId, lines) {
  for (const l of lines)
    await qc(`INSERT INTO requisition_lines (requisition_id, material_id, qty, est_rate, needed_by, remarks)
              VALUES ($1,$2,$3,$4,$5,$6)`,
      [requisitionId, l.material_id, l.qty, l.est_rate, l.needed_by, l.remarks]);
}

// Reject leftover offcuts on any requisition/PO line — they are not purchasable.
async function assertPurchasable(oc, lines) {
  for (const l of lines) {
    const mat = await oc('SELECT leftover, name FROM materials WHERE id=$1', [l.material_id]);
    if (!mat) throw Object.assign(new Error(`Material ${l.material_id} not found`), { status: 404 });
    if (mat.leftover) throw Object.assign(new Error(`${mat.name} is a leftover offcut — it cannot be purchased. Pick a fresh board.`), { status: 409 });
  }
}

// Attach the full line list (+ item_count and estimated value) to header rows.
async function attachReqLines(prs) {
  if (!prs.length) return prs;
  const lines = await q(`
    SELECT rl.*, m.name AS material_name, m.category AS material_category, m.unit
    FROM requisition_lines rl JOIN materials m ON m.id=rl.material_id
    WHERE rl.requisition_id = ANY($1::int[]) ORDER BY rl.id`, [prs.map(p => p.id)]);
  const byReq = {};
  for (const l of lines) (byReq[l.requisition_id] ||= []).push(l);
  return prs.map(p => {
    const ls = byReq[p.id] || [];
    return { ...p, lines: ls, item_count: ls.length,
      est_value: ls.reduce((s, l) => s + (+l.qty) * (+l.est_rate || 0), 0) };
  });
}

// Insert PO lines with full GST detail and remember each material's last rate.
// A requisition that has already become a purchase order stays editable, but
// only its quantities, and the change is carried through to the order. Leaving
// the PO behind would let the two drift — and since the PO's traceability is
// derived from these very rows, the order would start reporting quantities
// nobody asked for.
//
// Applied as a DELTA: consolidation merges several requisitions onto one PO
// line, so setting that line would erase what the others contributed.
export async function cascadePrQtyToPo(qc, oc, pr, newLines, user = null) {
  const oldLines = await qc('SELECT material_id, qty FROM requisition_lines WHERE requisition_id=$1', [pr.id]);
  const { deltas, error } = planPrQtyChange(oldLines, newLines);
  if (error) throw Object.assign(new Error(error), { status: 409 });
  if (!deltas.length) return;

  const po = pr.purchase_order_id
    ? await oc('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [pr.purchase_order_id])
    : null;
  // Converted with nothing to point at: the order was deleted out from under
  // it. Editing quantities here would change nothing anybody can see.
  if (!po) throw Object.assign(new Error('This requisition is marked converted but its purchase order is gone — reopen it from the PO register first'), { status: 409 });
  if (po.status === 'closed') throw Object.assign(new Error(`${po.po_number} is closed — no further change to what was ordered`), { status: 409 });

  for (const d of deltas) {
    const pl = await oc('SELECT * FROM po_lines WHERE purchase_order_id=$1 AND material_id=$2 ORDER BY id LIMIT 1',
      [po.id, d.material_id]);
    const mat = await oc('SELECT name FROM materials WHERE id=$1', [d.material_id]);
    if (!pl) throw Object.assign(new Error(`${mat?.name || 'That board'} is no longer on ${po.po_number} — edit the order directly`), { status: 409 });

    const nextQty = +pl.qty + d.delta;
    // Nothing-left comes FIRST. A delta can outrun the line when the order was
    // edited down on its own afterwards, and blaming receipts for a negative
    // result names a number ("below the 0 already received") that explains
    // nothing to the person reading it.
    if (nextQty <= 0)
      throw Object.assign(new Error(`${mat?.name || 'That board'} would leave nothing on ${po.po_number} — it now carries ${+pl.qty}, so edit the order directly`), { status: 409 });
    // Then the same rule the PO editor enforces: never below what has already
    // arrived, counting quarantined receipts as arrived.
    const grn = await oc('SELECT COALESCE(SUM(qty),0)::float AS q FROM grns WHERE po_line_id=$1', [pl.id]);
    const committed = Math.max(+pl.received_qty, +grn?.q || 0);
    if (nextQty < committed)
      throw Object.assign(new Error(`${mat?.name || 'That board'} would drop ${po.po_number} to ${nextQty}, below the ${committed} already received/in-QC`), { status: 409 });

    await qc('UPDATE po_lines SET qty=$1 WHERE id=$2', [nextQty, pl.id]);
  }

  // The order may have been fully received and is now short again, or the other
  // way round. Same derivation the PO editor uses.
  const fresh = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [po.id]);
  const full = fresh.length > 0 && fresh.every(l => l.received_qty >= l.qty);
  const some = fresh.some(l => l.received_qty > 0);
  await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
    [full ? 'received' : some ? 'partially_received' : 'open', po.id]);
  await audit('purchase_order', po.id, 'update',
    `quantities followed ${pr.pr_number}: ${deltas.map(d => `${d.from}→${d.to}`).join(', ')}`, qc, user);
}

// A consolidated PO line has to be able to name what fed it. Derived, never
// stored: both conversion paths stamp requisitions.purchase_order_id, so the
// answer comes from rows the PR module already owns — nothing to migrate,
// nothing to drift, and orders raised before consolidation answer too. A direct
// PO has no requisitions behind it and honestly returns nothing.
// Keyed "<po id>:<material id>" → [{ pr_number, qty }].
async function poLineSourcePrs(poId = null) {
  const rows = await q(`
    SELECT pr.purchase_order_id, rl.material_id, pr.pr_number, SUM(rl.qty)::float AS qty
    FROM requisitions pr JOIN requisition_lines rl ON rl.requisition_id=pr.id
    WHERE pr.purchase_order_id IS NOT NULL
      AND ($1::int IS NULL OR pr.purchase_order_id=$1::int)
    GROUP BY pr.purchase_order_id, rl.material_id, pr.pr_number
    ORDER BY pr.pr_number`, [poId]);
  const by = new Map();
  for (const r of rows) {
    const k = `${r.purchase_order_id}:${r.material_id}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ pr_number: r.pr_number, qty: +r.qty });
  }
  return by;
}

// What a purchase is COMMITTED to — the jobs whose shortage put each board on
// the order, per (purchase order, material). A buy reaches a job through the
// requisition that named it: `requisitions.purchase_order_id` says which order
// swallowed the ask, `requisition_lines.material_id` says which line of that
// order it fed, and `requisitions.order_line_id` is the job it was raised for.
//
// A line no requisition anchors to a job is an OPEN ORDER — board bought to the
// shelf, not against anybody's commitment. That is a real and ordinary thing to
// do, so it gets a plain word rather than an empty cell; the caller renders it.
//
// The anchor is deliberately the requisition, NOT `board_allocations`: a
// requisition-source allocation is RELEASED the moment its PR closes, so a
// received PO would forget every job it was bought for exactly when the buyer
// looks back at it. The PR anchor outlives the receipt.
//
// `on_board` is the one caveat this can carry honestly. A PR's material is a
// snapshot of what was short the day it was raised — re-anchor the job to a
// different board afterwards and the buy is no longer against THIS board. The
// job is still named (the order was genuinely raised for it) but flagged, the
// same fact mirrorTargets() acts on when it books the allocation.
//
// Batched: two queries for the whole register, never one per row.
export async function poLineCommitments(poId = null) {
  const srcs = await q(`
    SELECT DISTINCT r.purchase_order_id, rl.material_id, r.id AS requisition_id, r.pr_number
    FROM requisitions r JOIN requisition_lines rl ON rl.requisition_id = r.id
    WHERE r.purchase_order_id IS NOT NULL
      AND ($1::int IS NULL OR r.purchase_order_id = $1::int)
    ORDER BY r.pr_number`, [poId]);
  const by = new Map();
  if (!srcs.length) return by;

  const jobRows = await requisitionJobRows(srcs.map(s => s.requisition_id));
  const byReq = new Map();
  for (const j of jobRows) {
    if (!byReq.has(j.requisition_id)) byReq.set(j.requisition_id, []);
    byReq.get(j.requisition_id).push(j);
  }

  for (const s of srcs) {
    const k = `${s.purchase_order_id}:${s.material_id}`;
    if (!by.has(k)) by.set(k, []);
    const seen = new Set(by.get(k).map(j => j.order_line_id));
    for (const j of byReq.get(s.requisition_id) || []) {
      // Two requisitions on one order can name the same job — a gang whose
      // members were topped up separately. It is one commitment, listed once.
      if (seen.has(j.id)) continue;
      seen.add(j.id);
      by.get(k).push({
        order_line_id: j.id,
        product_id: j.product_id,
        product_code: j.product_code,
        product_name: j.product_name,
        customer_name: j.customer_name,
        sales_po: j.po_number,
        delivery_date: j.delivery_date,
        status: j.status,
        sheets: j.parent_sheets_required == null ? null : +j.parent_sheets_required,
        order_qty: j.qty == null ? null : +j.qty,
        gang_number: j.gang_number || null,
        pr_number: s.pr_number,
        on_board: Number(j.eff_board) === Number(s.material_id),
      });
    }
  }
  return by;
}

// One PO line per material, quantities summed — see po-consolidate.js. A line
// that actually merged is repriced off the rate master for this vendor, because
// two requisition estimates that disagree cannot both be right and the master is
// the tie-break the plant already trusts. A material named once is left exactly
// as the caller resolved it: nothing reprices just by passing through here.
async function consolidateForPo(oc, lines, vendorId, boardRates) {
  const seen = new Set(), repeated = new Set();
  for (const l of lines || []) {
    if (!l.material_id) continue;
    const k = String(l.material_id);
    if (seen.has(k)) repeated.add(k); else seen.add(k);
  }
  // No duplicates is the ordinary case, and it costs no extra query.
  if (!repeated.size) return consolidate(lines);
  const resolved = new Map();
  for (const k of repeated) {
    const m = await oc(`SELECT category, grade, gsm, sheet_l, sheet_w, sheets_per_packet,
                               unit, hsn_code, gst_rate, std_rate, last_rate
                        FROM materials WHERE id=$1`, [+k]);
    resolved.set(k, resolvePoRate(m, vendorId, boardRates)?.rate ?? null);
  }
  return consolidate(lines, {
    mergedRate: sources => resolved.get(String(sources[0].material_id)) ?? null,
  });
}

// Write an edited PO's lines: collapse duplicate materials among the lines with
// nothing received, drop what the user removed and what a merge folded away,
// then update the survivors and insert anything new.
//
// Exported and given its `qc` so the guarantee that matters can be tested
// without a database: a line with goods against it is NEVER deleted, because
// every GRN row points at that po_line id and deleting it strands the receipt.
// See po-edit-lines.test.js.
export async function applyPoLineEdit(qc, poId, lines, existing, committedQty) {
  const byId = Object.fromEntries(existing.map(l => [l.id, l]));
  const keptIds = new Set(lines.filter(l => l.id).map(l => +l.id));
  for (const l of lines) {
    if (!l.material_id || !(+l.qty > 0))
      throw Object.assign(new Error('Each line needs a material and a positive quantity'), { status: 400 });
  }
  // Duplicate materials collapse to one line here too — but ONLY among lines
  // with nothing received. See consolidateEdit: a settled line keeps its own row
  // and id because a GRN points at that id.
  const { rows: finalLines, mergedAway: mergedAwayIds } =
    consolidateEdit(lines, l => (l.id && byId[l.id] ? committedQty(byId[l.id]) > 0 : false));
  const mergedAway = new Set(mergedAwayIds);

  // Remove lines the user dropped, and the ones a merge folded away — but never
  // one with any receipt (accepted or quarantined), which would also strand its
  // GRN records. Merged-away lines are zero-receipt by construction, so the
  // guard below only ever fires on a genuine drop.
  for (const l of existing) {
    if (!keptIds.has(l.id) || mergedAway.has(l.id)) {
      if (committedQty(l) > 0) throw Object.assign(new Error('A line that has goods received against it cannot be removed — short-close the PO instead'), { status: 409 });
      await qc('DELETE FROM po_lines WHERE id=$1', [l.id]);
    }
  }
  // Update kept lines and insert new ones.
  for (const l of finalLines) {
    if (l.id && byId[l.id]) {
      const prev = byId[l.id];
      const committed = committedQty(prev);
      if (committed > 0) {
        if (+l.material_id !== prev.material_id) throw Object.assign(new Error('Cannot change the material on a line that has goods received against it'), { status: 409 });
        if (+l.qty < committed) throw Object.assign(new Error(`Ordered qty cannot be below the ${committed} already received/in-QC`), { status: 409 });
      }
      await qc(`UPDATE po_lines SET material_id=$1, qty=$2, rate=$3,
                       hsn_code=$4, unit=$5, discount_pct=$6, gst_rate=$7 WHERE id=$8`,
        [+l.material_id, +l.qty, +l.rate || 0, l.hsn_code || null, l.unit || null,
         +l.discount_pct || 0, +l.gst_rate || 0, l.id]);
    } else {
      await qc(`INSERT INTO po_lines (purchase_order_id, material_id, qty, rate, hsn_code, unit, discount_pct, gst_rate)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [poId, +l.material_id, +l.qty, +l.rate || 0, l.hsn_code || null, l.unit || null,
         +l.discount_pct || 0, +l.gst_rate || 0]);
    }
    if (+l.rate > 0) await qc('UPDATE materials SET last_rate=$1 WHERE id=$2', [+l.rate, +l.material_id]);
  }
}

async function insertPoLines(qc, poId, lines) {
  for (const l of lines) {
    if (!l.material_id || !(+l.qty > 0))
      throw Object.assign(new Error('Each PO line needs a material and a positive quantity'), { status: 400 });
    await qc(`INSERT INTO po_lines (purchase_order_id, material_id, qty, rate, hsn_code, unit, discount_pct, gst_rate)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [poId, +l.material_id, +l.qty, +l.rate || 0, l.hsn_code || null, l.unit || null,
       +l.discount_pct || 0, +l.gst_rate || 0]);
    if (+l.rate > 0) await qc('UPDATE materials SET last_rate=$1 WHERE id=$2', [+l.rate, +l.material_id]);
  }
}

// ── Requisitions ────────────────────────────────────────────────────────────
r.get('/requisitions', async (_req, res, next) => {
  try {
    const prs = await q(`
      SELECT pr.*, m.name AS material_name, m.category AS material_category, m.unit,
             -- Board is bought by weight and handled in packets; sheets alone are
             -- the one unit nobody on the floor or in a vendor call works in.
             m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet,
             COALESCE(po2.po_number, po.po_number) AS po_number,
             src.pr_number AS reraise_of_number
      FROM requisitions pr JOIN materials m ON m.id=pr.material_id
      LEFT JOIN requisitions src ON src.id=pr.reraise_of
      LEFT JOIN purchase_orders po ON po.requisition_id=pr.id
      LEFT JOIN purchase_orders po2 ON po2.id=pr.purchase_order_id
      ORDER BY pr.id DESC`);
    let rows = await attachReqLines(prs);

    // Live warehouse position for single-material board PRs, so the register
    // shows what is already on hand next to what is being bought.
    const boardIds = [...new Set(rows
      .filter(p => (p.lines || []).length <= 1 && p.material_category === 'board')
      .map(p => p.material_id).filter(Boolean))];
    const stk = {};
    if (boardIds.length) {
      const avail = await q(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM stock_batches
                             WHERE status='available' AND material_id=ANY($1::int[]) GROUP BY 1`, [boardIds]);
      // COMMITTED is claimsByBoard() — the same function the planning engine's
      // Board Position and Smart Match use, so the buyer and the planner cannot
      // read two different numbers off one board.
      //
      // This register previously counted only board HELD from stock, which is a
      // different question and answered 0 on a board whose jobs were owed
      // thousands of sheets: Saffire 340 20x38 showed "Free 4,850" while two
      // OMEZYME jobs were waiting on 3,650 of it. claimsByBoard's actual
      // contract (its own header): committed is the FULL requirement of every
      // live, undrawn claim, DELIBERATELY not netted by what is held or on
      // order — held board is still spoken for, and on-order board has not
      // arrived. Only a fresh_pr claim is fenced to its own incoming PR, and
      // on_order rides alongside as the reason a shortfall is already handled,
      // never netted in. An earlier version of this comment described it as
      // "open needs, net of held" — the exact netting the Saffire case removed
      // — and a comment teaching the wrong contract is how the next hand-
      // rolled copy is born.
      const [claimLines, allocations] = await Promise.all([
        boardClaimLines(boardIds),
        q(`SELECT material_id, order_line_id, qty, source, status FROM board_allocations
           WHERE status='active' AND material_id=ANY($1::int[])`, [boardIds]),
      ]);
      const claims = claimsByBoard({ lines: claimLines, allocations });
      const a = Object.fromEntries(avail.map(x => [x.material_id, Number(x.q)]));
      for (const id of boardIds) {
        const available = a[id] || 0;
        const c = claims.get(id);
        const committed = c?.committed || 0;
        stk[id] = {
          available, committed, free: available - committed,
          // Why a shortfall is already handled. Never netted INTO committed —
          // these sheets are not on the shelf yet.
          on_order: c?.on_order || 0,
          jobs: c?.claimants.length || 0,
        };
      }
    }
    // A gang's reason says "2 jobs on Duplex WB" and stops there, while a
    // single job's reason names its product outright. Carry the jobs so the
    // register can close that gap in the row itself.
    const jobs = await jobsForPrs(rows);
    rows = rows.map(p => ({ ...p, board_stock: stk[p.material_id] || null, jobs: jobs.get(p.id) || null }));

    res.json(rows);
  } catch (e) { next(e); }
});

// Edit a requisition — header + line list, allowed while still actionable
// (pending/approved). Lines are replaced wholesale; the header mirrors line 1.
r.put('/requisitions/:id', canBuy, async (req, res, next) => {
  try {
    const { needed_by, reason, requested_by, department, priority, remarks } = req.body;
    const result = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      // A converted requisition stays editable, but only its quantities — and
      // the change is carried through to the order it produced. See
      // cascadePrQtyToPo. Anything past converted is done with.
      if (!['pending', 'approved', 'converted'].includes(pr.status))
        throw Object.assign(new Error(`A ${pr.status} requisition can no longer be edited`), { status: 409 });
      const lines = reqLinesFrom(req.body);
      if (!lines.length) throw Object.assign(new Error('A requisition needs at least one line with a material and quantity'), { status: 400 });
      await assertPurchasable(oc, lines);
      if (pr.status === 'converted') await cascadePrQtyToPo(qc, oc, pr, lines, req.user.name);
      const first = lines[0];
      await qc('DELETE FROM requisition_lines WHERE requisition_id=$1', [pr.id]);
      await insertReqLines(qc, pr.id, lines);
      const [row] = await qc(
        `UPDATE requisitions SET material_id=$1, qty=$2, needed_by=$3, reason=$4,
                requested_by=$5, department=$6, priority=$7, remarks=$8 WHERE id=$9 RETURNING *`,
        [first.material_id, first.qty, needed_by ?? pr.needed_by, reason ?? pr.reason,
         requested_by ?? pr.requested_by, department ?? pr.department,
         priority ?? pr.priority ?? 'normal', remarks ?? pr.remarks, pr.id]);
      await syncPrAllocation(qc, row);
      await audit('requisition', pr.id, 'update', `${lines.length} line(s)`, qc, req.user.name);
      return row;
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Close / cancel a requisition with a mandatory reason.
r.post('/requisitions/:id/close', canBuy, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to close a requisition' });
    const result = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      if (!['pending', 'approved'].includes(pr.status))
        throw Object.assign(new Error(`Cannot close a ${pr.status} requisition`), { status: 409 });
      await qc(`UPDATE requisitions SET status='closed', status_reason=$1 WHERE id=$2`, [reason, pr.id]);
      await syncPrAllocation(qc, { ...pr, status: 'closed' }, { close: true });
      await audit('requisition', pr.id, 'close', reason, qc, req.user.name);
      return { ...pr, status: 'closed', status_reason: reason };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Hard-delete a requisition — removes the PR row entirely, wherever it was
// raised from (manual or planning shortfall). Blocked once it is on a PO: send
// that PO back to requisition first, which returns this PR to the approved queue.
r.delete('/requisitions/:id', canBuy, async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    if (force) {
      const ctx = await deleteContext('requisition', req.params.id);
      if (!ctx) return res.status(404).json({ error: 'Not found' });
      const plan = planProcurementDelete(ctx);
      if (plan.hard_blockers.length)
        return res.status(409).json({ error: plan.hard_blockers[0], blockers: plan.hard_blockers });
      await writeProcurementDeleteBackup({ ...ctx, ...plan });
      // Take the PO standing over this PR out of the way first. That reverses
      // its receipts and hands this PR — and any co-raised sibling — back to
      // the approved queue, leaving a plain unconverted row to remove.
      const own = await one('SELECT purchase_order_id FROM requisitions WHERE id=$1', [req.params.id]);
      const via = await one('SELECT id FROM purchase_orders WHERE requisition_id=$1', [req.params.id]);
      const poId = own?.purchase_order_id || via?.id;
      if (poId) await unwindPo(poId, req.user.name, { force: true });
    }
    await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      const po = await oc(
        `SELECT po_number FROM purchase_orders WHERE id=$1
         OR id=(SELECT purchase_order_id FROM requisitions WHERE id=$2)`, [pr.purchase_order_id, pr.id]);
      if (!force && (pr.status === 'converted' || pr.purchase_order_id || po))
        throw Object.assign(new Error(`${pr.pr_number} is on ${po?.po_number || 'a purchase order'} — send that PO back to requisition first`), { status: 409 });
      await syncPrAllocation(qc, pr, { close: true });
      // A later PR raised over this one points back at it; keep that row alive.
      await qc('UPDATE requisitions SET reraise_of=NULL WHERE reraise_of=$1', [pr.id]);
      await qc('DELETE FROM requisitions WHERE id=$1', [pr.id]);
      await audit('requisition', pr.id, force ? 'force_delete' : 'delete', pr.pr_number, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

r.post('/requisitions', canRaisePr, async (req, res, next) => {
  try {
    const { needed_by, reason, department, priority, remarks, reraise_of, reraise_reason } = req.body;
    const purpose = normalisePurpose(req.body.purpose);
    const lines = reqLinesFrom(req.body);
    if (!lines.length) return res.status(400).json({ error: 'Add at least one material line with a quantity' });
    // A deliberate re-raise (duplicate-PR confirmation) must carry its reason.
    if (reraise_of && !String(reraise_reason || '').trim())
      return res.status(400).json({ error: 'A reason is required when re-raising a requisition for the same material' });
    const result = await tx(async (qc, oc) => {
      await assertPurchasable(oc, lines);
      const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number', oc);
      const first = lines[0];
      const [pr] = await qc(
        `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                   requested_by, department, priority, remarks, reraise_of, reraise_reason, order_line_id,
                                   purpose)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [pr_number, first.material_id, first.qty, needed_by || first.needed_by || null, reason || null,
         req.body.requested_by || req.user.name, department || null, priority || 'normal',
         remarks || null, reraise_of || null, reraise_of ? String(reraise_reason).trim() : null,
         req.body.order_line_id || null,
         purpose]);
      await insertReqLines(qc, pr.id, lines);
      await syncPrAllocation(qc, pr);
      const purposeNote = purpose === 'production' ? '' : ` · ${purpose.replace(/_/g, ' ')}`;
      await audit('requisition', pr.id, reraise_of ? 'create_reraise' : 'create',
        reraise_of ? `${pr_number} re-raised over PR #${reraise_of}: ${String(reraise_reason).trim()}`
                   : `${pr_number} · ${lines.length} line(s)${purposeNote}`, qc, req.user.name);
      return pr;
    });
    res.json(result);
  } catch (e) { next(e); }
});

// The jobs a combined gang requisition is actually buying for.
//
// The jobs a requisition is buying for.
//
// A buyer looking at CI-PR-0006 is committing 7,525 sheets on the strength of
// "2 jobs on Duplex WB" — without being told which two, for whom, or by when.
// A single-job PR is no better: "Shortfall for BRUTAFLAM-CGII… (PO PMP/00319)"
// buries the product in a sentence and states neither the customer nor the due
// date. Either way the buyer is approving a quantity whose justification is
// off-screen.
//
// One shape covers both: the jobs, each with its share of this requisition.
// A gang splits by need; a lone job carries the whole thing.
//
// The gang comes off the anchor line every fixed-code requisition now carries.
// Rows raised before that anchor existed (CI-PR-0010 on live) fall back to the
// gang number in the reason — the trailing space matters, or CI-GANG-0001 would
// swallow CI-GANG-00010 the day the series passes four digits.
// Batched, because the register renders this for every row at once: three
// queries regardless of how many requisitions are on screen, never one per row.
// The order lines a requisition was raised FOR — its anchor line, and every
// member of the gang when that line prints in one. ONE spelling, shared by the
// PR register (jobsForPrs) and by the commitment column on the PO queue and the
// pendency register, because those three must never disagree about which jobs a
// purchase is committed to. `product_id` and `eff_board` ride along for the
// callers that need to link the job or check it is still on this board.
async function requisitionJobRows(reqIds = []) {
  const ids = [...new Set(reqIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  return q(`
    WITH scope AS (
      SELECT r.id, r.order_line_id,
             COALESCE(
               (SELECT ol.gang_run_id FROM order_lines ol WHERE ol.id = r.order_line_id),
               (SELECT g.id FROM gang_runs g
                 WHERE r.reason LIKE 'Combined shortage for gang ' || g.gang_number || ' %'
                 LIMIT 1)
             ) AS gang_run_id
      FROM requisitions r WHERE r.id = ANY($1::int[])
    )
    SELECT s.id AS requisition_id, g.gang_number,
           ol.id, ol.qty, ol.status,
           COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
           ${EFF_BOARD_ID} AS eff_board,
           p.id AS product_id, p.name AS product_name, p.code AS product_code,
           c.name AS customer_name, o.po_number, o.delivery_date
    FROM scope s
    LEFT JOIN gang_runs g ON g.id = s.gang_run_id
    JOIN order_lines ol
      ON (s.gang_run_id IS NOT NULL AND ol.gang_run_id = s.gang_run_id)
      OR (s.gang_run_id IS NULL AND ol.id = s.order_line_id)
    JOIN products p ON p.id = ol.product_id
    JOIN orders o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
    ORDER BY s.id, ol.id`, [ids]);
}

async function jobsForPrs(prs = []) {
  const out = new Map();
  const ids = prs.map(p => p.id).filter(Boolean);
  if (!ids.length) return out;

  const rows = await requisitionJobRows(ids);

  const byPr = {};
  for (const r of rows) (byPr[r.requisition_id] ||= []).push(r);
  for (const pr of prs) {
    const jobs = byPr[pr.id];
    // A requisition naming no job at all — a plain stock top-up, or a legacy
    // row raised before the anchor — has nothing to show, and says so with null.
    if (!jobs?.length) { out.set(pr.id, null); continue; }
    // A buyer may order more than the jobs need — a minimum order quantity, a
    // better rate, a deliberate top-up. The members carry only what they asked
    // for, so state the rest plainly instead of leaving the member lines failing
    // to add up to the quantity being approved.
    const members = gangPrShares(pr.qty, jobs);
    out.set(pr.id, {
      gang_number: jobs[0].gang_number || null,
      members,
      demand: members.reduce((s, m) => s + Number(m.sheets || 0), 0),
      for_stock: stockSurplus(pr.qty, jobs),
    });
  }
  return out;
}

async function jobsForPr(pr) {
  if (!pr) return null;
  return (await jobsForPrs([pr])).get(pr.id) || null;
}

// Single requisition with its full context — powers the Planning Engine's
// inline PR tracker (view a PR without leaving the engine).
r.get('/requisitions/:id', async (req, res, next) => {
  try {
    const pr = await one(`
      SELECT pr.*, m.name AS material_name, m.category AS material_category, m.unit,
             src.pr_number AS reraise_of_number,
             COALESCE(po2.po_number, po.po_number) AS po_number,
             COALESCE(po2.status, po.status) AS po_status,
             COALESCE(po2.expected_date, po.expected_date) AS po_expected_date,
             COALESCE(v2.name, v.name) AS vendor_name
      FROM requisitions pr JOIN materials m ON m.id=pr.material_id
      LEFT JOIN requisitions src ON src.id=pr.reraise_of
      LEFT JOIN purchase_orders po ON po.requisition_id=pr.id
      LEFT JOIN purchase_orders po2 ON po2.id=pr.purchase_order_id
      LEFT JOIN vendors v ON v.id=po.vendor_id
      LEFT JOIN vendors v2 ON v2.id=po2.vendor_id
      WHERE pr.id=$1`, [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    res.json({ ...(await attachReqLines([pr]))[0], gang: await jobsForPr(pr) });
  } catch (e) { next(e); }
});

// Approve does not change PR coverage (pending and approved are both "open" for
// syncPrAllocation), so it stays a plain single-statement update.
r.post('/requisitions/:id/approve', canBuy, async (req, res, next) => {
  try {
    const pr = await one('SELECT * FROM requisitions WHERE id=$1', [req.params.id]);
    if (!pr) return res.status(404).json({ error: 'Not found' });
    if (pr.status !== 'pending') return res.status(409).json({ error: `Cannot approve a ${pr.status} requisition` });
    await q('UPDATE requisitions SET status=$1 WHERE id=$2', ['approved', pr.id]);
    await audit('requisition', pr.id, 'approve', null, q, req.user.name);
    res.json({ ...pr, status: 'approved' });
  } catch (e) { next(e); }
});

// Approve is one click on a register row, so it gets mis-clicked. Undo it while
// the requisition is still only approved — nothing has been committed to a
// vendor yet, so this is a genuine undo rather than a reversal.
//
// Once a purchase order exists the PO owns the decision: send that back to
// requisition first, which is the path that already reverses receipts properly.
// Coverage does not move — pending and approved are both "open" to
// syncPrAllocation — so, exactly like approve, this stays a status change.
r.post('/requisitions/:id/unapprove', canBuy, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      if (pr.status !== 'approved')
        throw Object.assign(new Error(`Only an approved requisition can be un-approved — this one is ${pr.status}`), { status: 409 });
      const po = await oc(
        `SELECT po_number FROM purchase_orders WHERE id=$1 OR requisition_id=$2`, [pr.purchase_order_id, pr.id]);
      if (po)
        throw Object.assign(new Error(`${pr.pr_number} is already on ${po.po_number} — send that purchase order back to requisition instead`), { status: 409 });
      await qc('UPDATE requisitions SET status=$1 WHERE id=$2', ['pending', pr.id]);
      await audit('requisition', pr.id, 'unapprove', `${pr.pr_number} back to pending`, qc, req.user.name);
      return { ...pr, status: 'pending' };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Reject retires the PR's requisition-source allocation, so the status change
// and the allocation release must land together.
r.post('/requisitions/:id/reject', canBuy, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      if (pr.status !== 'pending') throw Object.assign(new Error(`Cannot reject a ${pr.status} requisition`), { status: 409 });
      await qc('UPDATE requisitions SET status=$1 WHERE id=$2', ['rejected', pr.id]);
      await syncPrAllocation(qc, { ...pr, status: 'rejected' }, { close: true });
      await audit('requisition', pr.id, 'reject', null, qc, req.user.name);
      return { ...pr, status: 'rejected' };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Send an unconverted PR's incoming material to a different job. Once the PR is
// on a PO the GRN owns the material and re-pointing is a different problem.
r.post('/requisitions/:id/reassign', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    const orderLineId = +req.body.order_line_id;
    if (!reason) return res.status(400).json({ error: 'A reason is required to re-point a requisition' });
    if (!orderLineId) return res.status(400).json({ error: 'Pick the job this requisition is for' });

    const out = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Not found'), { status: 404 });
      if (!['pending', 'approved'].includes(pr.status))
        throw Object.assign(new Error(`A ${pr.status} requisition can no longer be re-pointed`), { status: 409 });

      const line = await oc(`
        SELECT ol.id, p.name AS product_name FROM order_lines ol
        JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [orderLineId]);
      if (!line) throw Object.assign(new Error('That job is no longer planned'), { status: 409 });

      const before = pr.order_line_id;
      const [row] = await qc('UPDATE requisitions SET order_line_id=$1 WHERE id=$2 RETURNING *',
        [orderLineId, pr.id]);
      await syncPrAllocation(qc, row);
      await audit('requisition', pr.id, 'reassign',
        `${pr.pr_number} re-pointed${before ? ` from order line #${before}` : ''} to ${line.product_name} — ${reason}`,
        qc, req.user.name);
      await audit('order_line', orderLineId, 'pr_reassigned_in',
        `${pr.pr_number} (${pr.qty} sheets) now buys for this job — ${reason}`, qc, req.user.name);
      if (before)
        await audit('order_line', before, 'pr_reassigned_out',
          `${pr.pr_number} no longer buys for this job — ${reason}`, qc, req.user.name);
      return row;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Convert PR → PO. Guarded: PR must be approved. Every requisition line becomes
// a PO line. The client sends `lines` (pre-filled from the PR, with rate/HSN/GST
// per line); if omitted, lines are derived from the requisition with each
// material's saved HSN/GST/last-rate as defaults.
r.post('/requisitions/:id/convert', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, expected_date, vendor_notes, payment_terms, delivery_terms, reference,
            tax_kind, freight, round_off, lines: bodyLines } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
    const poId = await tx(async (qc, oc) => {
      const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!pr) throw Object.assign(new Error('Requisition not found'), { status: 404 });
      if (pr.status !== 'approved')
        throw Object.assign(new Error('Requisition must be approved before conversion'), { status: 409 });
      let lines = bodyLines;
      const boardRates = await qc('SELECT * FROM board_rates WHERE active=1');
      if (!Array.isArray(lines) || !lines.length) {
        const rls = await qc(`SELECT rl.*, m.category, m.grade, m.gsm, m.sheet_l, m.sheet_w,
                                     m.sheets_per_packet, m.unit, m.hsn_code, m.gst_rate, m.std_rate, m.last_rate
                              FROM requisition_lines rl JOIN materials m ON m.id=rl.material_id
                              WHERE rl.requisition_id=$1 ORDER BY rl.id`, [pr.id]);
        lines = rls.map(l => {
          // The requisition's estimated rate still wins — the buyer put it there
          // on purpose; otherwise derive the board's ₹/sheet from the rate master.
          // The requisition's estimated rate still wins (incl. a deliberate 0);
          // otherwise derive the board's ₹/sheet from the rate master.
          const resolved = resolvePoRate(l, vendor_id, boardRates);
          return { material_id: l.material_id, qty: l.qty, unit: l.unit,
            rate: pickPoRate(l.est_rate, resolved), hsn_code: l.hsn_code, gst_rate: l.gst_rate, discount_pct: 0 };
        });
      }
      if (!lines.length) throw Object.assign(new Error('This requisition has no lines to convert'), { status: 400 });
      // A requisition can name the same board on two lines. The vendor is asked
      // for it once, with the quantities added up.
      lines = await consolidateForPo(oc, lines, vendor_id, boardRates);
      const po_number = await nextNumber('CI-VPO-', 'purchase_orders', 'po_number', oc);
      const [po] = await qc(
        `INSERT INTO purchase_orders (po_number, vendor_id, requisition_id, expected_date,
                                      vendor_notes, payment_terms, delivery_terms, reference,
                                      tax_kind, freight, round_off, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [po_number, vendor_id, pr.id, expected_date || pr.needed_by || null,
         vendor_notes || null, payment_terms || null, delivery_terms || null, reference || null,
         tax_kind || 'intra', +freight || 0, +round_off || 0, req.user.name]);
      await insertPoLines(qc, po.id, lines);
      await qc(`UPDATE requisitions SET status='converted', purchase_order_id=$1 WHERE id=$2`, [po.id, pr.id]);
      await audit('purchase_order', po.id, 'create_from_pr', po_number, qc, req.user.name);
      return po.id;
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]));
  } catch (e) { next(e); }
});

// Multi-select PRs → ONE purchase order. All must be approved; lines for the
// same material merge (quantities sum, one rate). Invalid mixes are rejected
// with a clear message — nothing is silently merged.
r.post('/purchase-orders/from-requisitions', canBuy, async (req, res, next) => {
  try {
    const { requisition_ids, vendor_id, expected_date, rates = {},
            vendor_notes, payment_terms, delivery_terms, reference,
            tax_kind, freight, round_off } = req.body;
    if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
    if (!requisition_ids?.length) return res.status(400).json({ error: 'Select at least one requisition' });
    const poId = await tx(async (qc, oc) => {
      const vendor = await oc('SELECT * FROM vendors WHERE id=$1', [vendor_id]);
      if (!vendor) throw Object.assign(new Error('Vendor not found'), { status: 404 });
      const prs = [];
      for (const id of requisition_ids) {
        const pr = await oc('SELECT * FROM requisitions WHERE id=$1 FOR UPDATE', [id]);
        if (!pr) throw Object.assign(new Error(`Requisition ${id} not found`), { status: 404 });
        if (pr.status !== 'approved')
          throw Object.assign(new Error(`${pr.pr_number} is ${pr.status} — only approved requisitions can go on a PO`), { status: 409 });
        prs.push(pr);
      }
      const po_number = await nextNumber('CI-VPO-', 'purchase_orders', 'po_number', oc);
      const earliest = prs.map(p => p.needed_by).filter(Boolean).sort()[0] || null;
      const [po] = await qc(
        `INSERT INTO purchase_orders (po_number, vendor_id, expected_date,
                                      vendor_notes, payment_terms, delivery_terms, reference,
                                      tax_kind, freight, round_off, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [po_number, vendor_id, expected_date || earliest,
         vendor_notes || null, payment_terms || null, delivery_terms || null, reference || null,
         tax_kind || 'intra', +freight || 0, +round_off || 0, req.user.name]);
      // Every requisition line across the selection, grouped by material — one PO
      // line per material, quantities summed by the same rule the convert and
      // direct-PO forms use, HSN/GST from the material master.
      const prLines = [];
      for (const pr of prs) {
        const rls = await qc('SELECT * FROM requisition_lines WHERE requisition_id=$1 ORDER BY id', [pr.id]);
        for (const l of rls) prLines.push({ material_id: l.material_id, qty: +l.qty });
      }
      const boardRates = await qc('SELECT * FROM board_rates WHERE active=1');
      for (const row of consolidate(prLines)) {
        const m = await oc('SELECT category, grade, gsm, sheet_l, sheet_w, sheets_per_packet, unit, hsn_code, gst_rate, std_rate, last_rate FROM materials WHERE id=$1', [row.material_id]);
        // Client-supplied per-line rate wins (incl. a deliberate 0 = free line);
        // else derive from the rate master.
        const resolved = resolvePoRate(m, vendor_id, boardRates);
        await insertPoLines(qc, po.id, [{ material_id: +row.material_id, qty: row.qty,
          rate: pickPoRate(rates[row.material_id], resolved),
          unit: m?.unit, hsn_code: m?.hsn_code, gst_rate: m?.gst_rate, discount_pct: 0 }]);
      }
      for (const pr of prs) {
        await qc(`UPDATE requisitions SET status='converted', purchase_order_id=$1 WHERE id=$2`, [po.id, pr.id]);
        await audit('requisition', pr.id, 'convert', `into ${po_number}`, qc, req.user.name);
      }
      await audit('purchase_order', po.id, 'create_from_prs',
        `${po_number} from ${prs.map(p => p.pr_number).join(', ')}`, qc, req.user.name);
      return po.id;
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]));
  } catch (e) { next(e); }
});

// ── Purchase Orders ─────────────────────────────────────────────────────────
r.get('/purchase-orders', async (_req, res, next) => {
  try {
    const pos = await q(`
      SELECT po.*, v.name AS vendor_name, pr.pr_number,
             (SELECT COUNT(*)::int FROM requisitions rq WHERE rq.purchase_order_id=po.id) AS source_pr_count,
             (SELECT COUNT(*)::int FROM grns g WHERE g.purchase_order_id=po.id) AS grn_count
      FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id
      LEFT JOIN requisitions pr ON pr.id=po.requisition_id
      ORDER BY po.id DESC`);
    const lines = await q(`
      SELECT pl.*, m.name AS material_name, COALESCE(pl.unit, m.unit) AS unit,
             COALESCE(pl.hsn_code, m.hsn_code) AS hsn_code,
             COALESCE((SELECT SUM(g.qty) FROM grns g WHERE g.po_line_id=pl.id),0)::float AS grn_qty
      FROM po_lines pl JOIN materials m ON m.id=pl.material_id`);
    const byPo = {};
    for (const l of lines) (byPo[l.purchase_order_id] ||= []).push(l);
    const sourcePrs = await poLineSourcePrs();
    const commitments = await poLineCommitments();
    for (const l of lines) {
      l.source_prs = sourcePrs.get(`${l.purchase_order_id}:${l.material_id}`) || [];
      l.commitments = commitments.get(`${l.purchase_order_id}:${l.material_id}`) || [];
    }
    res.json(pos.map(po => ({ ...po, lines: byPo[po.id] || [] })));
  } catch (e) { next(e); }
});

r.get('/purchase-orders/:id', async (req, res, next) => {
  try {
    const po = await one(`
      SELECT po.*, v.name AS vendor_name, v.city AS vendor_city, v.contact AS vendor_contact,
             v.phone AS vendor_phone, v.gstin AS vendor_gstin, v.address AS vendor_address,
             v.state AS vendor_state, v.state_code AS vendor_state_code, v.email AS vendor_email,
             pr.pr_number
      FROM purchase_orders po JOIN vendors v ON v.id=po.vendor_id
      LEFT JOIN requisitions pr ON pr.id=po.requisition_id
      WHERE po.id=$1`, [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    po.lines = await q(`
      SELECT pl.*, m.name AS material_name, m.spec, COALESCE(pl.unit, m.unit) AS unit,
             COALESCE(pl.hsn_code, m.hsn_code) AS hsn_code,
             m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet
      FROM po_lines pl JOIN materials m ON m.id=pl.material_id WHERE pl.purchase_order_id=$1 ORDER BY pl.id`, [po.id]);
    const sourcePrs = await poLineSourcePrs(po.id);
    const commitments = await poLineCommitments(po.id);
    for (const l of po.lines) {
      l.source_prs = sourcePrs.get(`${po.id}:${l.material_id}`) || [];
      l.commitments = commitments.get(`${po.id}:${l.material_id}`) || [];
    }
    po.company = await one('SELECT * FROM company_profile ORDER BY id LIMIT 1') || {};
    res.json(po);
  } catch (e) { next(e); }
});

r.post('/purchase-orders', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, lines, expected_date, vendor_notes, payment_terms, delivery_terms, reference,
            tax_kind, freight, round_off } = req.body;
    if (!vendor_id || !lines?.length) return res.status(400).json({ error: 'Vendor and at least one line are required' });
    const poId = await tx(async (qc, oc) => {
      const po_number = await nextNumber('CI-VPO-', 'purchase_orders', 'po_number', oc);
      const [po] = await qc(
        `INSERT INTO purchase_orders (po_number, vendor_id, expected_date,
                                      vendor_notes, payment_terms, delivery_terms, reference,
                                      tax_kind, freight, round_off, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [po_number, vendor_id, expected_date || null,
         vendor_notes || null, payment_terms || null, delivery_terms || null, reference || null,
         tax_kind || 'intra', +freight || 0, +round_off || 0, req.user.name]);
      // The buyer can type the same board on two rows, and other callers reach
      // this route directly. The order carries each material once, at the rate of
      // its top-most row — exactly what the form confirmed before sending.
      await insertPoLines(qc, po.id, consolidate(lines));
      await audit('purchase_order', po.id, 'create', po_number, qc, req.user.name);
      return po.id;
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]));
  } catch (e) { next(e); }
});

// Close a PO — no further receipts expected (short-close allowed with note).
r.post('/purchase-orders/:id/close', canBuy, async (req, res, next) => {
  try {
    const po = await one('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'closed') return res.status(409).json({ error: 'PO is already closed' });
    const openGrns = await one(
      `SELECT COUNT(*)::int AS n FROM grns WHERE purchase_order_id=$1 AND status='quarantine'`, [po.id]);
    if (openGrns.n > 0) return res.status(409).json({ error: 'Decide pending GRN QC before closing this PO' });
    await q(`UPDATE purchase_orders SET status='closed' WHERE id=$1`, [po.id]);
    await audit('purchase_order', po.id, 'close', req.body.note || null, q, req.user.name);
    res.json({ ...po, status: 'closed' });
  } catch (e) { next(e); }
});

// Edit a PO — vendor, expected date, and lines. Lines already (partly) received
// are locked: their material can't change and quantity can't drop below what has
// arrived. Omitted existing lines are removed (only if nothing was received).
// Duplicate materials collapse to one line, but only among lines with nothing
// received — a settled line keeps its own row and id, since a GRN points at it.
r.put('/purchase-orders/:id', canBuy, async (req, res, next) => {
  try {
    const { vendor_id, expected_date, lines, vendor_notes, payment_terms, delivery_terms, reference,
            tax_kind, freight, round_off } = req.body;
    if (!lines?.length) return res.status(400).json({ error: 'A PO needs at least one line' });
    await tx(async (qc, oc) => {
      const po = await oc('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!po) throw Object.assign(new Error('Not found'), { status: 404 });
      if (po.status === 'closed') throw Object.assign(new Error('A closed PO can no longer be edited'), { status: 409 });
      if (vendor_id && +vendor_id !== po.vendor_id) {
        if (!(await oc('SELECT id FROM vendors WHERE id=$1', [+vendor_id])))
          throw Object.assign(new Error('Vendor not found'), { status: 404 });
      }
      const existing = await qc('SELECT * FROM po_lines WHERE purchase_order_id=$1', [po.id]);
      const byId = Object.fromEntries(existing.map(l => [l.id, l]));
      const keptIds = new Set(lines.filter(l => l.id).map(l => +l.id));
      // A line is "committed" once anything has been received against it — either
      // accepted into stock (received_qty) or still sitting in a quarantine GRN.
      // received_qty alone misses quarantined receipts, so fold in GRN totals.
      const grnRows = await qc('SELECT po_line_id, COALESCE(SUM(qty),0)::float AS grn_qty FROM grns WHERE purchase_order_id=$1 GROUP BY po_line_id', [po.id]);
      const grnByLine = Object.fromEntries(grnRows.map(g => [g.po_line_id, +g.grn_qty]));
      const committedQty = l => Math.max(+l.received_qty, grnByLine[l.id] || 0);

      await applyPoLineEdit(qc, po.id, lines, existing, committedQty);
      // Re-derive status from the (possibly changed) lines.
      const fresh = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [po.id]);
      const full = fresh.length > 0 && fresh.every(l => l.received_qty >= l.qty);
      const some = fresh.some(l => l.received_qty > 0);
      await qc(`UPDATE purchase_orders SET vendor_id=$1, expected_date=$2, status=$3,
                       vendor_notes=$4, payment_terms=$5, delivery_terms=$6, reference=$7,
                       tax_kind=$8, freight=$9, round_off=$10 WHERE id=$11`,
        [vendor_id ? +vendor_id : po.vendor_id, expected_date ?? po.expected_date,
         full ? 'received' : some ? 'partially_received' : 'open',
         vendor_notes ?? po.vendor_notes, payment_terms ?? po.payment_terms,
         delivery_terms ?? po.delivery_terms, reference ?? po.reference,
         tax_kind ?? po.tax_kind, freight != null ? +freight : po.freight,
         round_off != null ? +round_off : po.round_off, po.id]);
      await audit('purchase_order', po.id, 'edit', po.po_number, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// Shared teardown for delete / send-back: verify the PO has no receipts, drop it
// and its lines, and hand any source requisitions back to the approved queue.
async function unwindPo(id, user, { requirePr = false, force = false } = {}) {
  return tx(async (qc, oc) => {
    const po = await oc('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!po) throw Object.assign(new Error('Not found'), { status: 404 });

    // Receipts stand between a PO and its deletion. Normally the user is sent
    // to reverse them by hand; a forced delete reverses them here, in the same
    // transaction, and stops dead on any whose stock a job has already drawn.
    if (force) {
      const receipts = await qc('SELECT * FROM grns WHERE purchase_order_id=$1 ORDER BY id DESC', [po.id]);
      for (const g of receipts) await reverseGrnRow(g, qc, oc, user, { action: 'delete' });
    } else {
      const grn = await oc('SELECT COUNT(*)::int AS n FROM grns WHERE purchase_order_id=$1', [po.id]);
      if (grn.n > 0) throw Object.assign(new Error('This PO already has goods receipts — reverse those before deleting'), { status: 409 });
    }

    const lines = await qc('SELECT * FROM po_lines WHERE purchase_order_id=$1', [po.id]);
    if (!force && lines.some(l => +l.received_qty > 0)) throw Object.assign(new Error('This PO has received stock and cannot be deleted'), { status: 409 });

    // Source requisitions: single-PR (po.requisition_id) or multi-PR (rq.purchase_order_id).
    const prs = await qc(
      `SELECT * FROM requisitions WHERE purchase_order_id=$1 OR id=$2`, [po.id, po.requisition_id]);
    if (requirePr && prs.length === 0)
      throw Object.assign(new Error('This PO was not created from a requisition, so there is nothing to send back'), { status: 409 });
    for (const pr of prs) {
      await qc(`UPDATE requisitions SET status='approved', purchase_order_id=NULL WHERE id=$1`, [pr.id]);
      await audit('requisition', pr.id, 'reopened', `${po.po_number} removed — back to approved`, qc, user);
    }
    await qc('DELETE FROM po_lines WHERE purchase_order_id=$1', [po.id]);
    await qc('DELETE FROM purchase_orders WHERE id=$1', [po.id]);
    await audit('purchase_order', po.id, requirePr ? 'revert_to_requisition' : 'delete',
      `${po.po_number}${prs.length ? ` — ${prs.length} requisition${prs.length > 1 ? 's' : ''} returned` : ''}`, qc, user);
    return { po_number: po.po_number, reverted: prs.map(p => p.pr_number) };
  });
}

// Delete a PO outright. Any source requisitions return to the approved queue so
// the demand is never silently lost.
r.delete('/purchase-orders/:id', canBuy, async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    if (force) {
      const ctx = await deleteContext('purchase_order', req.params.id);
      if (!ctx) return res.status(404).json({ error: 'Not found' });
      const plan = planProcurementDelete(ctx);
      if (plan.hard_blockers.length)
        return res.status(409).json({ error: plan.hard_blockers[0], blockers: plan.hard_blockers });
      await writeProcurementDeleteBackup({ ...ctx, ...plan });
    }
    res.json({ ok: true, ...(await unwindPo(req.params.id, req.user.name, { force })) });
  } catch (e) { next(e); }
});

// Send a PO back to requisition — same teardown, but only for POs that actually
// came from a PR, framed as returning the demand rather than discarding it.
r.post('/purchase-orders/:id/revert-to-requisition', canBuy, async (req, res, next) => {
  try { res.json({ ok: true, ...(await unwindPo(req.params.id, req.user.name, { requirePr: true })) }); }
  catch (e) { next(e); }
});

// ── GRN + QC ────────────────────────────────────────────────────────────────
r.get('/grns', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT g.*, m.name AS material_name, m.unit, po.po_number,
             sm.name AS substituted_for_name,
             COALESCE(pv.name, dv.name) AS vendor_name,
             b.qty AS batch_qty, b.initial_qty AS batch_initial_qty,
             (SELECT COUNT(*)::int FROM stock_movements mv
               WHERE mv.batch_id = b.id
                 AND mv.type IN ('consumption','dispatch','wastage','fg_receipt')) AS batch_drawn
      FROM grns g JOIN materials m ON m.id=g.material_id
      LEFT JOIN stock_batches b ON b.grn_id = g.id
      LEFT JOIN materials sm ON sm.id=g.substituted_for_material_id
      LEFT JOIN purchase_orders po ON po.id=g.purchase_order_id
      LEFT JOIN vendors pv ON pv.id=po.vendor_id
      LEFT JOIN vendors dv ON dv.id=g.vendor_id
      ORDER BY g.id DESC`);
    // Whether the received quantity may still be corrected is decided HERE, by
    // the same function the PUT enforces. The register only reads the verdict,
    // so the form can never offer a box whose save would come back 409 — and
    // when it is locked it can say why, in the words the server would use.
    res.json(rows.map(g => {
      const batch = g.batch_initial_qty == null ? null
        : { qty: g.batch_qty, initial_qty: g.batch_initial_qty };
      const { qty } = grnEditPlan(g, batch, g.batch_drawn || 0, {});
      return { ...g, qty_editable: qty.editable, qty_lock_reason: qty.reason };
    }));
  } catch (e) { next(e); }
});

// ── Board substitution ──────────────────────────────────────────────────────
// The mill sent 290 GSM against a PO for 300 GSM. Same grade, same sheet, one
// step down the ladder. The receipt books the board that actually arrived, and
// the jobs the ordered board was covering move onto it with it.
//
// Everything the dialog needs, gathered once so the preview and the commit read
// the SAME facts. `claims` is every live claim on the ORDERED board, each marked
// `bought` if this PO was buying for it — the bought test is a transcription of
// the burn-down in /grns/:id/qc, so the two can never disagree about which
// allocations this receipt is answering for.
// These three reads go through `qc` like every other statement here. The commit
// path (POST /grns/:id/substitute) calls this INSIDE its transaction, and on a
// serverless pool — one client, held by tx() — a pool read queues for a client
// only the blocked transaction can release. It does not fail as a stale read;
// it fails as "timeout exceeded when trying to connect" ten seconds later, with
// the whole substitution rolled back. Same defect that killed the planning
// engine's board freeze in commitBoardForLine.
async function substitutionContext(poLineId, receivedMaterialId, qc = q) {
  const [pl] = await qc('SELECT * FROM po_lines WHERE id=$1', [poLineId]);
  if (!pl) throw Object.assign(new Error('PO line not found'), { status: 404 });

  const cols = `id, code, name, category, grade, gsm, sheet_l, sheet_w,
                sheets_per_packet, unit, leftover, std_rate, last_rate`;
  const [ordered] = await qc(`SELECT ${cols} FROM materials WHERE id=$1`, [pl.material_id]);
  const [received = null] = receivedMaterialId
    ? await qc(`SELECT ${cols} FROM materials WHERE id=$1`, [+receivedMaterialId])
    : [];
  if (receivedMaterialId && !received)
    throw Object.assign(new Error('That board is not in the master — add it in Masters → Boards first'), { status: 404 });

  const bought = await qc(`
    SELECT DISTINCT a.order_line_id, a.requisition_id
    FROM board_allocations a
    JOIN requisitions rq ON rq.id = a.requisition_id
    WHERE a.status='active' AND a.source='requisition'
      AND a.material_id=$1 AND rq.purchase_order_id=$2`,
    [pl.material_id, pl.purchase_order_id]);
  const boughtBy = new Map(bought.map(b => [b.order_line_id, b.requisition_id]));

  // The one query entitled to say who is claiming a board — it already carries
  // board_drawn, half of the eligibility rule.
  const lines = await boardClaimLines([pl.material_id], [], qc);

  // The other half is the size axis, which needs each job's EFFECTIVE parent
  // sheet. spec_override beats the product master here exactly as it does for
  // the board itself — a job re-parented in Planning must be judged on the
  // parent it actually runs, not the one its master was filed with.
  const parents = lines.length ? await qc(`
    SELECT ol.id,
           COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
           COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w
    FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.id = ANY($1::int[])`, [lines.map(l => l.id)]) : [];
  const parentOf = new Map(parents.map(p => [p.id, p]));

  const claims = lines.map(l => {
    const withParent = { ...l, ...(parentOf.get(l.id) || { parent_l: null, parent_w: null }) };
    return {
      ...withParent,
      bought: boughtBy.has(l.id),
      requisition_id: boughtBy.get(l.id) ?? null,
      trim: trimOf({ sheet_l: withParent.parent_l, sheet_w: withParent.parent_w }, received),
      ...eligibilityOf(withParent, { ordered, received }),
    };
  });

  return { poLine: pl, ordered, received, claims };
}

// The boards that could legitimately have arrived instead: every stock-keeping
// board of the SAME GRADE, at any GSM and any sheet size. Grade is the one axis
// that never varies — a different grade is a different material with different
// strength and print behaviour, and no arithmetic makes it the same board.
//
// Size is offered here but decided per JOB: a sheet may be perfectly receivable
// and still be one that a given job's parent cannot be trimmed out of. That is
// eligibilityOf's call, made against each claim in the preview.
r.get('/grns/substitution-candidates', async (req, res, next) => {
  try {
    const pl = await one('SELECT * FROM po_lines WHERE id=$1', [+req.query.po_line_id]);
    if (!pl) return res.status(404).json({ error: 'PO line not found' });
    const ordered = await one(
      `SELECT id, code, name, grade, gsm, sheet_l, sheet_w, sheets_per_packet FROM materials WHERE id=$1`,
      [pl.material_id]);
    if (!ordered?.grade || ordered.sheet_l == null)
      return res.json({ ordered, candidates: [] });
    // Same size first (the plain GSM swap, much the commoner case), then the
    // rest of the grade by sheet — so the ladder a storekeeper expects is at the
    // top of the list rather than buried among other sizes.
    const candidates = await q(`
      SELECT id, code, name, grade, gsm, sheet_l, sheet_w, sheets_per_packet,
             (sheet_l=$2 AND sheet_w=$3) AS same_size
      FROM materials
      WHERE category='board' AND active=1 AND COALESCE(leftover,0)=0
        AND lower(btrim(grade))=lower(btrim($1))
        AND sheet_l IS NOT NULL AND sheet_w IS NOT NULL
        AND id<>$4
      ORDER BY (sheet_l=$2 AND sheet_w=$3) DESC, sheet_l, sheet_w, gsm`,
      [ordered.grade, ordered.sheet_l, ordered.sheet_w, ordered.id]);
    res.json({ ordered, candidates });
  } catch (e) { next(e); }
});

// Everything the approval dialog renders: both boards in sheets and packets, the
// rate consequence, and the jobs that would move. `effects` is the same list the
// commit executes.
r.get('/grns/substitution-preview', async (req, res, next) => {
  try {
    const { po_line_id, material_id, qty } = req.query;
    const ctx = await substitutionContext(+po_line_id, +material_id);
    const picks = String(req.query.picks || '')
      .split(',').map(s => +s).filter(Boolean);

    const plan = planSubstitution({
      ordered: ctx.ordered, received: ctx.received, receivedSheets: +qty,
      poLine: ctx.poLine, claims: ctx.claims, picks,
    });

    // A lighter sheet is genuinely worth less. Shown so the buyer settles it on
    // the invoice — po_lines.rate is never rewritten, the vendor holds that
    // document and it is not this screen's to change.
    const boardRates = await q('SELECT * FROM board_rates WHERE active=1');
    const po = await one('SELECT vendor_id FROM purchase_orders WHERE id=$1', [ctx.poLine.purchase_order_id]);
    const orderedRate = resolvePoRate(ctx.ordered, po?.vendor_id, boardRates);
    const receivedRate = ctx.received ? resolvePoRate(ctx.received, po?.vendor_id, boardRates) : null;

    res.json({
      ...plan,
      ordered: { ...ctx.ordered, packets: packetsOf(ctx.ordered, ctx.poLine.qty), rate: orderedRate.rate },
      received: ctx.received && { ...ctx.received, packets: packetsOf(ctx.received, +qty), rate: receivedRate?.rate ?? null },
      po_line: ctx.poLine,
      claims: ctx.claims,
    });
  } catch (e) { next(e); }
});

// Commit. Books the board that actually landed, moves the ticked jobs onto it,
// and releases the jobs it can no longer cover.
r.post('/grns/substitute', canBuy, async (req, res, next) => {
  try {
    const { po_line_id, material_id, qty, picks = [], batch_no, vehicle_no,
            supplier_invoice_no, supplier_invoice_date, received_by, remarks } = req.body;
    if (!po_line_id || !material_id || !(+qty > 0))
      return res.status(400).json({ error: 'PO line, the board received and a quantity above zero are required' });

    const out = await tx(async (qc, oc) => {
      const ctx = await substitutionContext(+po_line_id, +material_id, qc);
      // Re-planned INSIDE the transaction against freshly-read rows: the list
      // approved a minute ago must not be what executes if a job has since been
      // issued its board.
      const plan = planSubstitution({
        ordered: ctx.ordered, received: ctx.received, receivedSheets: +qty,
        poLine: ctx.poLine, claims: ctx.claims, picks: picks.map(Number),
      });
      if (!plan.ok) throw Object.assign(new Error(plan.blockers[0]), { status: 409, body: { blockers: plan.blockers } });

      await oc('SELECT id FROM po_lines WHERE id=$1 FOR UPDATE', [ctx.poLine.id]);
      const grn_number = await nextNumber('CI-GRN-', 'grns', 'grn_number', oc);
      const bno = batch_no || `${grn_number}-B1`;

      // material_id is what LANDED — it owns the batch, the ledger and every
      // Available column. substituted_for_material_id remembers what was asked
      // for. The GRN then reads correctly from either side.
      const [g] = await qc(
        `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id,
                           substituted_for_material_id, qty, batch_no, vehicle_no,
                           supplier_invoice_no, supplier_invoice_date, received_by, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [grn_number, ctx.poLine.purchase_order_id, ctx.poLine.id, ctx.received.id,
         ctx.ordered.id, +qty, bno, vehicle_no || null, supplier_invoice_no || null,
         supplier_invoice_date || null, received_by || req.user.name, remarks || null]);
      const [b] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, loose_sheets)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5,$6) RETURNING id`,
        [ctx.received.id, bno, +qty, ctx.received.unit, g.id, await grnLooseSheets(ctx.received.id, +qty, oc)]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
        [ctx.received.id, b.id, +qty, g.id,
         `GRN ${grn_number} (quarantine) — received in place of ${ctx.ordered.name}`]);

      for (const e of plan.effects) {
        if (e.kind === 'reboard') {
          // spec_override may be NULL; jsonb_set cannot write into NULL, so seed
          // an empty object first. The line's EFFECTIVE board is read from here
          // by every readiness, shortage and floor query.
          await qc(
            `UPDATE order_lines
                SET spec_override = jsonb_set(COALESCE(spec_override,'{}'::jsonb),
                                              '{board_material_id}', to_jsonb($1::int), true)
              WHERE id=$2`, [e.to, e.order_line_id]);
          await audit('order_line', e.order_line_id, 'board_substituted',
            `${ctx.ordered.name} → ${ctx.received.name} on ${grn_number} — received in place of the board ordered`,
            qc, req.user.name);
        }
        if (e.kind === 'alloc_repoint') {
          // Without this the burn-down in /grns/:id/qc matches on the OLD board,
          // finds nothing, and the job is credited twice — once as stock on the
          // shelf, once as still incoming. This is why QC needs no change.
          //
          // Scoped to the PR mirror, exactly as alloc_release below is.
          //
          // What changed is what is COMING: the mill sent a different board, so
          // the incoming-board row must follow it or QC burns down against a
          // material nothing arrived for. What did NOT change is what is on the
          // shelf. A source='stock' hold is frozen sheets of the ORIGINAL board,
          // sitting where they always were, and dragging it here would claim
          // board that is still in quarantine while freeing board the job is
          // genuinely still holding.
          //
          // Harmless before the planning engine froze board on lock, because a
          // locked line almost never carried a stock hold. Not harmless now.
          await qc(`UPDATE board_allocations SET material_id=$1
                     WHERE order_line_id=$2 AND material_id=$3 AND status='active'
                       AND source='requisition'`,
            [e.to, e.order_line_id, e.from]);
        }
        if (e.kind === 'alloc_release') {
          await qc(`UPDATE board_allocations
                       SET status='released', released_at=now(), released_by=$1,
                           release_reason=$2
                     WHERE order_line_id=$3 AND material_id=$4
                       AND status='active' AND source='requisition'`,
            [req.user.name, `${grn_number} arrived as ${ctx.received.name} instead`,
             e.order_line_id, ctx.ordered.id]);
          await audit('order_line', e.order_line_id, 'board_incoming_released',
            `${ctx.ordered.name} is no longer coming — ${grn_number} arrived as ${ctx.received.name}. This job reads short again.`,
            qc, req.user.name);
        }
      }

      await audit('grn', g.id, 'receive_substitute',
        `${grn_number} — ${qty} sheets of ${ctx.received.name} received against a line ordering ${ctx.ordered.name}`,
        qc, req.user.name);
      return { grn_id: g.id, effects: plan.effects, balance: plan.balance };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Receive material against a PO line → quarantine batch + ledger row.
r.post('/grns', canBuy, async (req, res, next) => {
  try {
    const { po_line_id, qty, batch_no, vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks } = req.body;
    // `!qty` alone let a NEGATIVE through — -50 is truthy — and booked a
    // negative quarantine batch, the one hole left in "no board reads below
    // nil". Matches its siblings /grns/direct and /grns/bulk, which already
    // test `> 0`.
    if (!po_line_id || !(+qty > 0)) return res.status(400).json({ error: 'PO line and a quantity above zero are required' });
    const grnId = await tx(async (qc, oc) => {
      const pl = await oc('SELECT * FROM po_lines WHERE id=$1', [po_line_id]);
      if (!pl) throw Object.assign(new Error('PO line not found'), { status: 404 });
      const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [pl.material_id])).unit;
      const grn_number = await nextNumber('CI-GRN-', 'grns', 'grn_number', oc);
      const bno = batch_no || `${grn_number}-B1`;
      const [g] = await qc(
        `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no,
                           vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [grn_number, pl.purchase_order_id, pl.id, pl.material_id, qty, bno,
         vehicle_no || null, supplier_invoice_no || null, supplier_invoice_date || null,
         received_by || req.user.name, remarks || null]);
      const [b] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, loose_sheets)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5,$6) RETURNING id`,
        [pl.material_id, bno, qty, unit, g.id, await grnLooseSheets(pl.material_id, qty, oc)]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
        [pl.material_id, b.id, qty, g.id, `GRN ${grn_number} (quarantine)`]);
      await audit('grn', g.id, 'receive', grn_number, qc, req.user.name);
      return g.id;
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [grnId]));
  } catch (e) { next(e); }
});

// Direct receipt — material that arrived WITHOUT a purchase order (samples,
// urgent buys, stock corrections). No PO/line link; an optional vendor records
// the supplier. Lands in quarantine exactly like a PO receipt, so the same QC
// step releases it to stock. QC on a direct GRN touches no PO.
r.post('/grns/direct', canBuy, async (req, res, next) => {
  try {
    const { material_id, qty, batch_no, vendor_id, vehicle_no, supplier_invoice_no,
            supplier_invoice_date, received_by, remarks } = req.body;
    if (!material_id || !(+qty > 0)) return res.status(400).json({ error: 'Material and a positive quantity are required' });
    const grnId = await tx(async (qc, oc) => {
      const mat = await oc('SELECT unit, leftover, name FROM materials WHERE id=$1', [material_id]);
      if (!mat) throw Object.assign(new Error('Material not found'), { status: 404 });
      if (mat.leftover) throw Object.assign(new Error(`${mat.name} is a leftover offcut — receive a fresh material`), { status: 409 });
      const grn_number = await nextNumber('CI-GRN-', 'grns', 'grn_number', oc);
      const bno = batch_no || `${grn_number}-B1`;
      const [g] = await qc(
        `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no,
                           vendor_id, source, vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks)
         VALUES ($1,NULL,NULL,$2,$3,$4,$5,'direct',$6,$7,$8,$9,$10) RETURNING id`,
        [grn_number, +material_id, +qty, bno, vendor_id || null, vehicle_no || null,
         supplier_invoice_no || null, supplier_invoice_date || null, received_by || req.user.name, remarks || null]);
      const [b] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, loose_sheets)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5,$6) RETURNING id`,
        [+material_id, bno, +qty, mat.unit, g.id, await grnLooseSheets(+material_id, +qty, oc)]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
        [+material_id, b.id, +qty, g.id, `GRN ${grn_number} (direct, quarantine)`]);
      await audit('grn', g.id, 'receive_direct', `${grn_number} — ${qty} received without a PO`, qc, req.user.name);
      return g.id;
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [grnId]));
  } catch (e) { next(e); }
});

// Receive several PO lines in one go (partial or full receipt per line).
// One GRN per line — each gets its own quarantine batch for QC.
r.post('/grns/bulk', canBuy, async (req, res, next) => {
  try {
    const { purchase_order_id, lines, vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks } = req.body;
    const receipts = (lines || []).filter(l => +l.qty > 0);
    if (!purchase_order_id || !receipts.length)
      return res.status(400).json({ error: 'PO and at least one received quantity are required' });
    const ids = await tx(async (qc, oc) => {
      const po = await oc('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [purchase_order_id]);
      if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });
      if (po.status === 'closed') throw Object.assign(new Error('PO is closed'), { status: 409 });
      const out = [];
      for (const l of receipts) {
        const pl = await oc('SELECT * FROM po_lines WHERE id=$1 AND purchase_order_id=$2', [l.po_line_id, po.id]);
        if (!pl) throw Object.assign(new Error('PO line not found on this PO'), { status: 404 });
        const unit = (await oc('SELECT unit FROM materials WHERE id=$1', [pl.material_id])).unit;
        const grn_number = await nextNumber('CI-GRN-', 'grns', 'grn_number', oc);
        const bno = l.batch_no || `${grn_number}-B1`;
        const [g] = await qc(
          `INSERT INTO grns (grn_number, purchase_order_id, po_line_id, material_id, qty, batch_no,
                             vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [grn_number, po.id, pl.id, pl.material_id, +l.qty, bno,
           vehicle_no || null, supplier_invoice_no || null, supplier_invoice_date || null,
           received_by || req.user.name, remarks || null]);
        const [b] = await qc(
          `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id, loose_sheets)
           VALUES ($1,$2,$3,$3,$4,'quarantine',$5,$6) RETURNING id`,
          [pl.material_id, bno, +l.qty, unit, g.id, await grnLooseSheets(pl.material_id, +l.qty, oc)]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'grn',$3,'grn',$4,$5)`,
          [pl.material_id, b.id, +l.qty, g.id, `GRN ${grn_number} (quarantine)`]);
        await audit('grn', g.id, 'receive', `${grn_number} — ${l.qty} against ${po.po_number}`, qc, req.user.name);
        out.push(g.id);
      }
      return out;
    });
    res.json({ ok: true, grn_ids: ids });
  } catch (e) { next(e); }
});

// Correct a goods receipt. Paperwork — batch, lorry, supplier invoice, who
// received it, remarks — at ANY status: none of it moves a sheet, and sealing
// it at QC left 55 completed receipts carrying invoice numbers nobody could
// fix. The received QUANTITY is the half with a stock consequence, and where
// it may move (and how) is grn-edit.js's call, not this route's.
r.put('/grns/:id', canBuy, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      // The unit is carried so a refusal here is worded exactly as the register
      // words it — "3,600 of 11,500 sheets", never a bare "units". Two spellings
      // of one refusal read as two different rules.
      g.unit = (await oc('SELECT unit FROM materials WHERE id=$1', [g.material_id]))?.unit;
      const batch = await oc('SELECT * FROM stock_batches WHERE grn_id=$1', [g.id]);
      const drawn = batch && await batchConsumed(oc, batch.id) ? 1 : 0;
      const plan = grnEditPlan(g, batch, drawn, req.body);
      // 400 when the number itself is wrong, 409 when the receipt's STATE
      // refuses it — the form tells those two apart, and only the second one
      // is worth showing as a locked field with a reason.
      if (plan.error) throw Object.assign(new Error(plan.error),
        { status: plan.qty.editable ? 400 : 409 });

      const keep = k => (plan.fields[k] !== undefined ? plan.fields[k] : g[k]);
      // The batch number NAMES the stock batch. It is the one field that may be
      // corrected but never blanked.
      const batch_no = keep('batch_no') || g.batch_no;
      await qc(`UPDATE grns SET qty=$1, batch_no=$2, vehicle_no=$3, supplier_invoice_no=$4,
                       supplier_invoice_date=$5, received_by=$6, remarks=$7 WHERE id=$8`,
        [plan.qty.to, batch_no, keep('vehicle_no'), keep('supplier_invoice_no'),
         keep('supplier_invoice_date'), keep('received_by'), keep('remarks'), g.id]);
      if (batch) await qc('UPDATE stock_batches SET batch_no=$1 WHERE id=$2', [batch_no, batch.id]);

      if (plan.stock !== 'none') {
        // `set` re-states a receipt nothing downstream has been told about;
        // `delta` moves one QC already pushed into stock. Both land the batch
        // on the same figure — the delta path is only ever reached on an INTACT
        // batch, where qty and initial_qty are still equal by definition. The
        // pile being at birth is also why loose re-seeds from the corrected
        // quantity: it holds no opened bundle and has absorbed no return, so
        // this is exactly what the receipt would have seeded if keyed right.
        const loose = await grnLooseSheets(g.material_id, plan.qty.to, oc);
        await qc('UPDATE stock_batches SET qty=$1, initial_qty=$1, loose_sheets=$2 WHERE id=$3',
          [plan.qty.to, loose, batch.id]);
        await qc(`UPDATE stock_movements SET qty=$1 WHERE ref_type='grn' AND ref_id=$2 AND type='grn'`,
          [plan.qty.to, g.id]);
      }

      if (plan.creditsPoLine) {
        // Acceptance credited received_qty by what landed, so a correction owes
        // it the difference. Status is then re-derived from the lines the way
        // QC and reverseGrnRow both do — one spelling of "is this PO received".
        await qc('UPDATE po_lines SET received_qty = GREATEST(0, received_qty + $1) WHERE id=$2',
          [plan.qty.delta, g.po_line_id]);
        const po = await oc('SELECT status FROM purchase_orders WHERE id=$1', [g.purchase_order_id]);
        if (po && po.status !== 'closed') {
          const lines = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1',
            [g.purchase_order_id]);
          const full = lines.length > 0 && lines.every(l => l.received_qty >= l.qty);
          const some = lines.some(l => l.received_qty > 0);
          await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
            [full ? 'received' : some ? 'partially_received' : 'open', g.purchase_order_id]);
        }
      }

      // QC retired the job's INCOMING coverage by exactly what landed. Correct
      // that by the same difference or the board is counted twice — once as
      // stock on hand, once as still on order. Walks the same set the accept
      // burn-down walked: requisition-source holds on this board, this PO.
      if (plan.stock === 'delta' && plan.qty.delta !== 0 && g.purchase_order_id) {
        const alloc = await qc(
          `SELECT a.id, a.qty, a.status FROM board_allocations a
           JOIN requisitions rq ON rq.id = a.requisition_id
           WHERE a.source='requisition' AND a.material_id=$1 AND rq.purchase_order_id=$2
           ORDER BY a.id`, [g.material_id, g.purchase_order_id]);
        if (plan.qty.delta > 0) {
          let landed = plan.qty.delta;                       // more arrived — retire more
          for (const a of alloc.filter(x => x.status === 'active')) {
            if (landed <= 0) break;
            const cut = Math.min(Number(a.qty), landed);
            const left = Number(a.qty) - cut;
            if (left > 0) await qc('UPDATE board_allocations SET qty=$1 WHERE id=$2', [left, a.id]);
            else await qc(`UPDATE board_allocations SET status='consumed', released_at=now() WHERE id=$1`, [a.id]);
            landed -= cut;
          }
        } else {
          // Less arrived — hand the shortfall back, never more than it. A live
          // hold simply grows. With none left, the newest RETIRED hold comes
          // back at exactly what is owed: its original size was answered by the
          // board that did land, and only the shortfall is still needed.
          const back = -plan.qty.delta;
          const live = alloc.find(a => a.status === 'active');
          if (live) await qc('UPDATE board_allocations SET qty = qty + $1 WHERE id=$2', [back, live.id]);
          else {
            const newest = [...alloc].reverse().find(a => a.status === 'consumed');
            if (newest) await qc(
              `UPDATE board_allocations SET status='active', released_at=NULL, qty=$1 WHERE id=$2`,
              [back, newest.id]);
          }
        }
      }

      await audit('grn', g.id, 'edit', plan.qty.changed
        ? `${g.grn_number}: qty ${g.qty} → ${plan.qty.to}`
          + (plan.stock === 'delta' ? ' — after QC; stock, PO line and coverage moved with it' : '')
        : `${g.grn_number}: receipt details corrected`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// Guard: has any of this batch's stock already been used (issued/consumed)?
async function batchConsumed(oc, batchId) {
  const row = await oc(
    `SELECT COUNT(*)::int AS n FROM stock_movements
     WHERE batch_id=$1 AND type IN ('consumption','dispatch','wastage','fg_receipt')`, [batchId]);
  return row.n > 0;
}

// ── Row-level delete ────────────────────────────────────────────────────────
// Every procurement row carries a Delete. What stands behind one is a chain —
// a PR under a PO, a PO under its GRNs, a GRN under a stock batch — and the
// server unwinds that chain itself rather than making the user walk it tab by
// tab. Only one thing is ever refused: a receipt whose stock a job has already
// drawn on. Reversing that would take board out of the warehouse while the job
// built from it stays on the floor, and the two would never agree again.

// Reverse one GRN outright: drop its batch and ledger rows, hand the quantity
// back to the PO line, and re-derive the PO status. The single implementation
// behind the rollback action, GRN delete, and any PO/PR delete that has to
// clear receipts out of the way first.
async function reverseGrnRow(g, qc, oc, user, { action = 'delete' } = {}) {
  const batch = await oc('SELECT * FROM stock_batches WHERE grn_id=$1', [g.id]);
  if (batch) {
    // Intact means both signals agree: the balance never moved off what was
    // received, and no consuming movement was ever written against it.
    if (+batch.qty !== +batch.initial_qty || await batchConsumed(oc, batch.id))
      throw Object.assign(
        new Error(`Stock from ${g.grn_number} has already been used — it cannot be reversed`), { status: 409 });
    await qc('DELETE FROM stock_movements WHERE batch_id=$1', [batch.id]);
    await qc('DELETE FROM stock_batches WHERE id=$1', [batch.id]);
  }
  await qc(`DELETE FROM stock_movements WHERE ref_type='grn' AND ref_id=$1`, [g.id]);
  // A direct (no-PO) receipt has no line balance or PO status to restore.
  if (g.po_line_id) {
    await qc('UPDATE po_lines SET received_qty = GREATEST(0, received_qty - $1) WHERE id=$2', [g.qty, g.po_line_id]);
    const po = await oc('SELECT status FROM purchase_orders WHERE id=$1', [g.purchase_order_id]);
    if (po && po.status !== 'closed') {
      const lines = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [g.purchase_order_id]);
      const full = lines.length > 0 && lines.every(l => l.received_qty >= l.qty);
      const some = lines.some(l => l.received_qty > 0);
      await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
        [full ? 'received' : some ? 'partially_received' : 'open', g.purchase_order_id]);
    }
  }
  // A "Cover board" hold earmarks THIS receipt's sheets for a job. When the
  // receipt itself is reversed those sheets are gone, so the hold must not
  // survive to squat on stock that no longer exists. Tagged by reason — cover
  // writes exactly `Covered from <grn_number>` and nothing else does.
  await qc(`UPDATE board_allocations
            SET status='released', released_at=now(), released_by=$1, release_reason='Receipt reversed'
            WHERE source='stock' AND status='active' AND reason=$2`,
    [user || null, `Covered from ${g.grn_number}`]);
  // A PR the cover CLOSED comes back with the receipt's reversal — otherwise
  // the board vanishes and procurement never re-buys it. The closure stamped
  // its reopen amount in status_reason. PRs merely REDUCED (not closed) stay
  // reduced — the same lossy-by-design stance this function already takes on
  // consumed requisition allocations.
  const coverClosed = await qc(
    `SELECT * FROM requisitions WHERE status='closed' AND status_reason LIKE $1`,
    [`Covered from ${g.grn_number} · reopen %`]);
  for (const pr of coverClosed) {
    const back = Number((pr.status_reason.match(/· reopen (\d+(?:\.\d+)?)$/) || [])[1]) || 0;
    if (!(back > 0)) continue;
    await qc(`UPDATE requisitions SET status='approved', qty = qty + $1, status_reason=$2 WHERE id=$3`,
      [back, `Reopened — ${g.grn_number} reversed`, pr.id]);
    await qc(`UPDATE requisition_lines SET qty = qty + $1 WHERE requisition_id=$2 AND material_id=$3`,
      [back, pr.id, g.material_id]);
    await syncPrAllocation(qc, { ...pr, status: 'approved', qty: Number(pr.qty) + back });
    await audit('requisition', pr.id, 'reopen', `${pr.pr_number} — reopened, ${g.grn_number} reversed`, qc, user);
  }
  await qc('DELETE FROM grns WHERE id=$1', [g.id]);
  await audit('grn', g.id, action, `${g.grn_number} — ${g.qty} returned to balance`, qc, user);
}

// Every GRN in a set, carried with the batch state the blocker rules need.
async function grnRowsWithStock(where, params) {
  return q(`
    SELECT g.id, g.grn_number, g.qty, g.status, g.po_line_id, g.purchase_order_id,
           m.unit, sb.qty AS batch_qty, sb.initial_qty AS batch_initial,
           COALESCE((SELECT COUNT(*) FROM stock_movements sm
                     WHERE sm.batch_id = sb.id
                       AND sm.type IN ('consumption','dispatch','wastage','fg_receipt')), 0)::int
             AS consuming_movements
    FROM grns g
    JOIN materials m ON m.id = g.material_id
    LEFT JOIN stock_batches sb ON sb.grn_id = g.id
    WHERE ${where} ORDER BY g.id`, params);
}

const shapeGrn = g => ({
  id: g.id, grn_number: g.grn_number, qty: g.qty, unit: g.unit, po_line_id: g.po_line_id,
  batch: g.batch_initial == null ? null : { qty: g.batch_qty, initial_qty: g.batch_initial },
  consuming_movements: g.consuming_movements,
});

// Resolve the whole chain behind one row, then let the pure planner describe it.
async function deleteContext(entity, id) {
  if (entity === 'grn') {
    const g = await one('SELECT * FROM grns WHERE id=$1', [id]);
    if (!g) return null;
    const po = g.purchase_order_id
      ? await one('SELECT id, po_number FROM purchase_orders WHERE id=$1', [g.purchase_order_id]) : null;
    const grns = (await grnRowsWithStock('g.id = $1', [id])).map(shapeGrn);
    return { entity, number: g.grn_number, po, poLines: [], grns, sourcePrs: [] };
  }

  let pr = null, po = null;
  if (entity === 'requisition') {
    pr = await one('SELECT * FROM requisitions WHERE id=$1', [id]);
    if (!pr) return null;
    // A PR and its PO can be linked from either end: the PR carries
    // purchase_order_id on a multi-PR order, the PO carries requisition_id on a
    // single-PR one. Miss either direction and the preview under-reports.
    po = await one(
      `SELECT id, po_number, requisition_id FROM purchase_orders
       WHERE id=$1 OR requisition_id=$2`, [pr.purchase_order_id, pr.id]);
  } else {
    po = await one('SELECT id, po_number, requisition_id FROM purchase_orders WHERE id=$1', [id]);
    if (!po) return null;
  }

  const poLines = po ? await q('SELECT id, qty FROM po_lines WHERE purchase_order_id=$1', [po.id]) : [];
  const grns = po ? (await grnRowsWithStock('g.purchase_order_id = $1', [po.id])).map(shapeGrn) : [];
  const sourcePrs = po
    ? await q('SELECT pr_number FROM requisitions WHERE purchase_order_id=$1 OR id=$2',
        [po.id, po.requisition_id ?? null])
    : [];

  return {
    entity, number: entity === 'requisition' ? pr.pr_number : po.po_number,
    pr: pr ? { pr_number: pr.pr_number } : null,
    po: po ? { po_number: po.po_number } : null,
    poLines, grns, sourcePrs,
  };
}

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BACKUP_ROOT = process.env.VERCEL ? tmpdir() : APP_ROOT;

// Everything about to disappear, on disk before a single row is touched.
async function writeProcurementDeleteBackup(ctx) {
  const grnIds = ctx.grns.map(g => g.id);
  const backup = {
    reason: 'procurement row delete backup', at: new Date().toISOString(),
    entity: ctx.entity, number: ctx.number, cascade: ctx.cascade,
    requisition: ctx.pr, purchase_order: ctx.po, po_lines: ctx.poLines,
    source_requisitions: ctx.sourcePrs,
    grns: grnIds.length ? await q('SELECT * FROM grns WHERE id=ANY($1::int[])', [grnIds]) : [],
    stock_batches: grnIds.length ? await q('SELECT * FROM stock_batches WHERE grn_id=ANY($1::int[])', [grnIds]) : [],
    stock_movements: grnIds.length ? await q(
      `SELECT * FROM stock_movements
       WHERE (ref_type='grn' AND ref_id=ANY($1::int[]))
          OR batch_id IN (SELECT id FROM stock_batches WHERE grn_id=ANY($1::int[]))`, [grnIds]) : [],
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(BACKUP_ROOT, 'backups',
    `PROCUREMENT-DELETE-${String(ctx.number).replace(/[^\w-]+/g, '_')}-${stamp}.json`);
  try { writeFileSync(file, JSON.stringify(backup, null, 2)); return file; }
  catch { return null; }                     // a missing backups/ never blocks the delete
}

// What Delete on this row would do, asked before the confirm dialog opens.
r.get('/procurement/delete-preview/:entity/:id', canBuy, async (req, res, next) => {
  try {
    const { entity, id } = req.params;
    if (!['requisition', 'purchase_order', 'grn'].includes(entity))
      return res.status(400).json({ error: 'Unknown procurement entity' });
    const ctx = await deleteContext(entity, id);
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const plan = planProcurementDelete(ctx);
    res.json({ entity, number: ctx.number, ...plan });
  } catch (e) { next(e); }
});

// Delete a GRN. Without `force` this is the original rule — only a receipt that
// never reached usable stock. With it, an accepted receipt is reversed first,
// which is exactly what the rollback action does.
r.delete('/grns/:id', canBuy, async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    if (force) {
      const ctx = await deleteContext('grn', req.params.id);
      if (!ctx) return res.status(404).json({ error: 'GRN not found' });
      const plan = planProcurementDelete(ctx);
      if (plan.hard_blockers.length)
        return res.status(409).json({ error: plan.hard_blockers[0], blockers: plan.hard_blockers });
      await writeProcurementDeleteBackup({ ...ctx, ...plan });
    }
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (!force && g.status === 'accepted')
        throw Object.assign(new Error('This GRN is accepted into stock — roll it back to the PO instead of deleting'), { status: 409 });
      await reverseGrnRow(g, qc, oc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Roll an ACCEPTED GRN back to the PO — undo the receipt so the line balance
// reopens. Reverses received_qty, removes the (untouched) released batch, and
// re-derives the PO status. Blocked if any of that stock was already consumed.
r.post('/grns/:id/rollback', canBuy, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'accepted') throw Object.assign(new Error('Only an accepted GRN can be rolled back to the PO'), { status: 409 });
      await reverseGrnRow(g, qc, oc, req.user.name, { action: 'rollback' });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Pendency ────────────────────────────────────────────────────────────────
// What is still due to arrive: PO-wise detail plus vendor / category /
// material roll-ups, with expected dates and ageing.
r.get('/procurement/pendency', async (_req, res, next) => {
  try {
    const rows = await q(`
      SELECT po.id AS po_id, po.po_number, po.status, po.expected_date, po.created_at,
             v.id AS vendor_id, v.name AS vendor_name,
             m.id AS material_id, m.name AS material_name, m.category, m.unit,
             m.grade, m.gsm, m.sheet_l, m.sheet_w, m.sheets_per_packet,
             pl.id AS po_line_id, pl.rate,
             pl.qty, pl.received_qty, (pl.qty - pl.received_qty) AS pending_qty,
             ((pl.qty - pl.received_qty) * pl.rate) AS pending_value,
             GREATEST(0, (${PLANT_TODAY_SQL} - po.created_at::date))::int AS age_days,
             CASE
               WHEN GREATEST(0, (${PLANT_TODAY_SQL} - po.created_at::date)) <= 7  THEN '0-7'
               WHEN GREATEST(0, (${PLANT_TODAY_SQL} - po.created_at::date)) <= 15 THEN '8-15'
               WHEN GREATEST(0, (${PLANT_TODAY_SQL} - po.created_at::date)) <= 30 THEN '16-30'
               ELSE '30+' END AS age_bucket,
             (SELECT MAX(g.received_at) FROM grns g WHERE g.po_line_id = pl.id) AS last_grn_at,
             CASE WHEN po.expected_date IS NOT NULL AND po.expected_date::date < ${PLANT_TODAY_SQL}
                  THEN (${PLANT_TODAY_SQL} - po.expected_date::date)::int ELSE 0 END AS overdue_days
      FROM po_lines pl
      JOIN purchase_orders po ON po.id=pl.purchase_order_id
      JOIN vendors v ON v.id=po.vendor_id
      JOIN materials m ON m.id=pl.material_id
      WHERE po.status IN ('open','partially_received') AND pl.qty > pl.received_qty
      ORDER BY overdue_days DESC, age_days DESC`);

    // Board is bought by weight — surface how many kg are still due per line so
    // the buyer sees tonnage pressure, not just sheet counts. Non-board lines
    // (or boards with an incomplete master) stay null → the UI shows "—".
    // The jobs each pending line is owed TO — same anchor as the PO queue, so a
    // line reads the same on both screens. An unanchored line is an open order.
    const commitments = await poLineCommitments();
    for (const r0 of rows) {
      r0.pending_weight = r0.category === 'board' ? totalWeight(r0, r0.pending_qty) : null;
      r0.commitments = commitments.get(`${r0.po_id}:${r0.material_id}`) || [];
    }

    const rollup = (key, label) => {
      const map = {};
      for (const r0 of rows) {
        const k = r0[key];
        (map[k] ||= { key: k, label: r0[label], pending_qty: 0, pending_value: 0, pending_weight: 0, po_count: new Set(), lines: 0, max_age: 0, overdue: 0 });
        map[k].pending_qty += +r0.pending_qty;
        map[k].pending_value += +r0.pending_value;
        map[k].pending_weight += +r0.pending_weight || 0;
        map[k].po_count.add(r0.po_id);
        map[k].lines += 1;
        map[k].max_age = Math.max(map[k].max_age, r0.age_days);
        map[k].overdue = Math.max(map[k].overdue, r0.overdue_days);
      }
      return Object.values(map)
        .map(v0 => ({ ...v0, po_count: v0.po_count.size, pending_weight: v0.pending_weight || null }))
        .sort((a, b) => b.pending_value - a.pending_value || b.pending_qty - a.pending_qty);
    };

    res.json({
      lines: rows,
      totals: {
        lines: rows.length,
        items: new Set(rows.map(r0 => r0.material_id)).size,
        parties: new Set(rows.map(r0 => r0.vendor_id)).size,
        pending_qty: rows.reduce((s, r0) => s + +r0.pending_qty, 0),
        pending_value: rows.reduce((s, r0) => s + +r0.pending_value, 0),
        pending_weight: rows.reduce((s, r0) => s + (+r0.pending_weight || 0), 0) || null,
      },
      by_vendor: rollup('vendor_id', 'vendor_name'),
      by_category: rollup('category', 'category'),
      by_material: rollup('material_id', 'material_name'),
      by_grade: rollup('grade', 'grade').filter(g => g.key), // only graded (board) lines
    });
  } catch (e) { next(e); }
});

// QC decision — acceptance releases the batch to stock and updates the PO.
r.post('/grns/:id/qc', canQc, async (req, res, next) => {
  try {
    const { accept, note } = req.body;
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'quarantine') throw Object.assign(new Error('GRN already QC-decided'), { status: 409 });

      const batch = await oc('SELECT * FROM stock_batches WHERE grn_id=$1', [g.id]);
      if (accept) {
        await qc(`UPDATE stock_batches SET status='available' WHERE id=$1`, [batch.id]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'qc_release',0,'grn',$3,$4)`,
          [g.material_id, batch.id, g.id, note || 'QC accepted — released to stock']);
        // A direct (no-PO) receipt has no line to credit or PO status to move.
        if (g.po_line_id) {
          // Board that ARRIVED is board on the shelf — receipt is physics and
          // is never refused for exceeding the order (paperwork soft). But an
          // over-receipt is said out loud instead of landing silently: nine
          // po_lines are over-received on the live plant, one of them by 3,600
          // sheets against a 50-sheet line, booked 13 ms after the previous
          // GRN on the same line — the shape of a double submit nobody was
          // told about. The audit row is the telling.
          const pol = await oc('SELECT qty, received_qty FROM po_lines WHERE id=$1', [g.po_line_id]);
          const remaining = Math.max(0, Number(pol?.qty || 0) - Number(pol?.received_qty || 0));
          const over = Math.max(0, Number(g.qty) - remaining);
          await qc('UPDATE po_lines SET received_qty = received_qty + $1 WHERE id=$2', [g.qty, g.po_line_id]);
          if (over > 0) {
            await audit('purchase_order', g.purchase_order_id, 'over_receipt',
              `${g.grn_number || `GRN #${g.id}`} accepted ${Math.round(Number(g.qty))} against `
              + `${Math.round(remaining)} still due on this line — ${Math.round(over)} over. `
              + `Stock is booked as received; check this is a real delivery and not a repeated GRN.`,
              qc, req.user.name);
          }
          const lines = await qc('SELECT qty, received_qty FROM po_lines WHERE purchase_order_id=$1', [g.purchase_order_id]);
          const full = lines.every(l => l.received_qty >= l.qty);
          const some = lines.some(l => l.received_qty > 0);
          await qc('UPDATE purchase_orders SET status=$1 WHERE id=$2',
            [full ? 'received' : some ? 'partially_received' : 'open', g.purchase_order_id]);
        }
        // The board is now real stock counted in `available`. Its requisition
        // allocation must shrink by the same amount or the job is credited
        // twice — once as stock on hand, once as still incoming.
        if (g.purchase_order_id) {
          const alloc = await qc(
            `SELECT a.id, a.qty FROM board_allocations a
             JOIN requisitions rq ON rq.id = a.requisition_id
             WHERE a.status='active' AND a.source='requisition'
               AND a.material_id=$1 AND rq.purchase_order_id=$2
             ORDER BY a.id`, [g.material_id, g.purchase_order_id]);
          let landed = Number(g.qty);
          for (const a of alloc) {
            if (landed <= 0) break;
            const cut = Math.min(Number(a.qty), landed);
            const left = Number(a.qty) - cut;
            if (left > 0) await qc('UPDATE board_allocations SET qty=$1 WHERE id=$2', [left, a.id]);
            else await qc(`UPDATE board_allocations SET status='consumed', released_at=now() WHERE id=$1`, [a.id]);
            landed -= cut;
          }
        }
        await qc(`UPDATE grns SET status='accepted', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, g.id]);
      } else {
        await qc(`UPDATE stock_batches SET status='rejected' WHERE id=$1`, [batch.id]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'qc_reject',$3,'grn',$4,$5)`,
          [g.material_id, batch.id, -g.qty, g.id, note || 'QC rejected']);
        await qc(`UPDATE grns SET status='rejected', qc_at=now(), qc_note=$1 WHERE id=$2`, [note || null, g.id]);
      }
      await audit('grn', g.id, accept ? 'qc_accept' : 'qc_reject', note, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM grns WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Cover the board from procurement ────────────────────────────────────────
// The missing half of the engine→PR→PO→GRN loop. QC acceptance releases the
// sheets to stock and retires the job's "incoming" coverage — but nothing
// earmarked the landed board for the job that ordered it, so it sat as free
// stock any other job could grab. Cover writes that earmark: a source='stock'
// hold on the job(s) the receipt was bought for, planner-confirmed, never
// automatic. A direct receipt (no PO) covers any open job-linked PR on the
// same board — the engine's ask arriving sideways through a direct purchase.

const fmtN = n => Math.round(Number(n) || 0).toLocaleString('en-IN');
const COVER_STATUSES = BOARD_DEMAND_STATUSES;

// Board this line has already drawn through its job card — a job mid-
// production only needs a hold for the sheets it has NOT cut yet.
//
// Gang and combined-run consumption posts against the run's PARENT card,
// whose order_line_id is NULL (the GANG_ANCHOR_LINE trap in helpers.js) — a
// plain join on ol.id would read 0 for every member forever and re-hold
// sheets the run already cut. The run's draw is prorated back to members by
// their locked parent-sheet shares, which sum to the run total post plan-lock
// (shared-layout members store proportional shares of the MAX-based run).
const CONSUMED_SQL = `(
  COALESCE((SELECT SUM(-sm.qty) FROM stock_movements sm
    JOIN job_cards jc ON jc.id = sm.ref_id AND sm.ref_type='job_card'
    WHERE sm.type='consumption' AND sm.material_id=$2
      AND jc.order_line_id = ol.id), 0)
  + CASE WHEN ol.gang_run_id IS NULL THEN 0 ELSE COALESCE(
      (SELECT SUM(-sm.qty) FROM stock_movements sm
        JOIN job_cards jc ON jc.id = sm.ref_id AND sm.ref_type='job_card'
        WHERE sm.type='consumption' AND sm.material_id=$2
          AND jc.order_line_id IS NULL AND jc.parent_job_card_id IS NULL
          AND jc.gang_run_id = ol.gang_run_id)
      * COALESCE(ol.parent_sheets_required, 0)
      / NULLIF((SELECT SUM(COALESCE(ol2.parent_sheets_required, 0))
                FROM order_lines ol2 WHERE ol2.gang_run_id = ol.gang_run_id), 0)
    , 0) END
)`;

// Which jobs was this receipt bought for? PO-backed → the PRs that built the
// PO; direct → open job-linked PRs on the same board ('converted' excluded —
// that board arrives through its own PO's GRNs). Each PR fans out to its gang
// siblings, then mirrorTargets drops any line re-anchored off this board
// (the CI-PR-0006 rule: a PR's material is a snapshot, not a live pointer).
async function coverTargets(qc, g) {
  const prs = g.purchase_order_id
    ? await qc(`SELECT * FROM requisitions
                WHERE purchase_order_id=$1 AND order_line_id IS NOT NULL ORDER BY id`, [g.purchase_order_id])
    : await qc(`SELECT * FROM requisitions
                WHERE material_id=$1 AND order_line_id IS NOT NULL
                  AND status IN ('pending','approved') ORDER BY id`, [g.material_id]);
  const byLine = new Map(); // order_line_id → { pr_id, pr_number } (earliest PR wins)
  for (const pr of prs) {
    const scope = await qc(`
      SELECT ol.id, ol.gang_run_id, ${EFF_BOARD_ID} AS eff_board
      FROM order_lines ol JOIN products p ON p.id = ol.product_id
      WHERE ol.id = $1
         OR (ol.gang_run_id IS NOT NULL
             AND ol.gang_run_id = (SELECT gang_run_id FROM order_lines WHERE id=$1))
      ORDER BY ol.id`, [pr.order_line_id]);
    for (const l of scope) {
      if (l.eff_board !== g.material_id) continue;
      if (!byLine.has(l.id)) byLine.set(l.id, { pr_id: pr.id, pr_number: pr.pr_number });
    }
  }
  return byLine;
}

// Preview — everything the confirm dialog renders, so it cannot drift from
// the commit. Suggested quantities walk the jobs in PR order against the
// smaller of free stock and what this receipt landed.
r.get('/grns/:id/cover-preview', canBuy, async (req, res, next) => {
  try {
    const g = await one('SELECT * FROM grns WHERE id=$1', [req.params.id]);
    if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
    if (g.status !== 'accepted')
      throw Object.assign(new Error('Only an accepted GRN can cover jobs — QC first'), { status: 409 });
    const mat = await one('SELECT * FROM materials WHERE id=$1', [g.material_id]);
    if (mat?.category !== 'board')
      throw Object.assign(new Error('Cover is for board receipts'), { status: 409 });

    const byLine = await coverTargets(q, g);
    const ids = [...byLine.keys()];
    const detail = ids.length ? await q(`
      SELECT ol.id, ol.status, ol.parent_sheets_required, ol.sheets_required, ol.gang_run_id,
             ${EFF_BOARD_ID} AS eff_board, ${CONSUMED_SQL} AS consumed,
             p.name AS product_name, p.code AS product_code,
             o.po_number, o.delivery_date, c.name AS customer_name,
             gg.gang_number
      FROM order_lines ol
      JOIN products p ON p.id = ol.product_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs gg ON gg.id = ol.gang_run_id
      WHERE ol.id = ANY($1) ORDER BY ol.id`, [ids, g.material_id]) : [];

    const avail = (await one(`SELECT COALESCE(SUM(qty),0) AS n FROM stock_batches
                              WHERE material_id=$1 AND status='available'`, [g.material_id])).n;
    const allocs = await q(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active'`, [g.material_id]);
    const heldStock = allocs.filter(a => a.source === 'stock').reduce((s, a) => s + Number(a.qty), 0);
    const free = Number(avail) - heldStock;

    const candidates = [];
    const skipped = [];
    for (const l of detail) {
      const pr = byLine.get(l.id);
      if (!COVER_STATUSES.includes(l.status)) {
        skipped.push({ order_line_id: l.id, product_name: l.product_name, status: l.status,
          reason: l.status === 'pending' ? 'plan not locked — cover it from the Planning engine' : `line is ${l.status}` });
        continue;
      }
      const held = heldFor(allocs, l.id);
      const coverable = Math.max(0, lineNeed(l) - Number(l.consumed) - held);
      candidates.push({
        order_line_id: l.id, pr_id: pr.pr_id, pr_number: pr.pr_number,
        product_name: l.product_name, product_code: l.product_code,
        po_number: l.po_number, customer_name: l.customer_name,
        delivery_date: l.delivery_date, gang_number: l.gang_number, status: l.status,
        need: lineNeed(l), consumed: Number(l.consumed), held,
        incoming: incomingFor(allocs, l.id), coverable,
      });
    }
    candidates.sort((a, b) => a.pr_id - b.pr_id || a.order_line_id - b.order_line_id);
    res.json({
      grn: { id: g.id, grn_number: g.grn_number, qty: Number(g.qty), source: g.source },
      material: { id: mat.id, name: mat.name, grade: mat.grade },
      stock: { available: Number(avail), held: heldStock, free },
      candidates: coverSuggestions(candidates, free, g.qty), skipped,
    });
  } catch (e) { next(e); }
});

// Commit — holds in, open PRs down, exactly like moving stock to a job from
// the warehouse panel (board.js planMove), because that is what covering IS.
r.post('/grns/:id/cover', canBuy, async (req, res, next) => {
  try {
    const merged = new Map();
    for (const c of Array.isArray(req.body.covers) ? req.body.covers : []) {
      const id = +c.order_line_id, qty = +c.qty;
      if (id && qty > 0) merged.set(id, (merged.get(id) || 0) + qty);
    }
    const covers = [...merged].map(([order_line_id, qty]) => ({ order_line_id, qty }));
    if (!covers.length)
      throw Object.assign(new Error('Nothing to cover — give at least one job a quantity'), { status: 400 });

    const out = await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'accepted')
        throw Object.assign(new Error('Only an accepted GRN can cover jobs — QC first'), { status: 409 });
      const mat = await oc('SELECT * FROM materials WHERE id=$1', [g.material_id]);
      if (mat?.category !== 'board')
        throw Object.assign(new Error('Cover is for board receipts'), { status: 409 });
      // One cover at a time per board: the free-stock guard below is a
      // check-then-act over aggregates no FOR UPDATE can pin, so two covers
      // landing together could jointly hold more than is free. Transaction-
      // scoped, releases itself on commit or error.
      await qc('SELECT pg_advisory_xact_lock(764001, $1)', [g.material_id]);
      // Only jobs this receipt was actually bought for — the same scope the
      // preview showed. Anything else has the warehouse hold panel.
      const scope = await coverTargets(qc, g);

      const lines = await qc(`
        SELECT ol.id, ol.status, ol.parent_sheets_required, ol.sheets_required, ol.gang_run_id,
               ${EFF_BOARD_ID} AS eff_board, ${CONSUMED_SQL} AS consumed, p.name AS product_name
        FROM order_lines ol JOIN products p ON p.id = ol.product_id
        WHERE ol.id = ANY($1)`, [covers.map(c => c.order_line_id), g.material_id]);
      const allocs = await qc(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active'`, [g.material_id]);

      const avail = (await oc(`SELECT COALESCE(SUM(qty),0) AS n FROM stock_batches
                               WHERE material_id=$1 AND status='available'`, [g.material_id])).n;
      const heldStock = allocs.filter(a => a.source === 'stock').reduce((s, a) => s + Number(a.qty), 0);
      const free = Number(avail) - heldStock;
      const totalAsk = covers.reduce((s, c) => s + c.qty, 0);
      if (totalAsk > free + 1e-6)
        throw Object.assign(new Error(
          `Only ${fmtN(free)} sheets of ${mat.name} are free — asked to cover ${fmtN(totalAsk)}`), { status: 409 });

      const covered = [];
      const prCuts = new Map();  // requisition id → sheets cut by THIS call
      for (const c of covers) {
        const line = lines.find(l => l.id === c.order_line_id);
        if (!line)
          throw Object.assign(new Error(`Job ${c.order_line_id} no longer exists`), { status: 409 });
        if (!scope.has(line.id))
          throw Object.assign(new Error(
            `${line.product_name} was not raised against this receipt's board — hold it from the warehouse panel instead`), { status: 409 });
        if (!COVER_STATUSES.includes(line.status))
          throw Object.assign(new Error(
            `${line.product_name} is ${line.status} — only planned jobs can hold board`), { status: 409 });
        // Re-derived at commit time, the CI-PR-0006 rule: a job re-anchored to
        // another board must never be handed this one.
        if (line.eff_board !== g.material_id)
          throw Object.assign(new Error(
            `${line.product_name} no longer runs on ${mat.name} — re-check its plan`), { status: 409 });
        const heldBefore = heldFor(allocs, line.id);
        const coverable = Math.max(0, lineNeed(line) - Number(line.consumed) - heldBefore);
        if (c.qty > coverable + 1e-6)
          throw Object.assign(new Error(
            `${line.product_name} can only hold ${fmtN(coverable)} more sheets`), { status: 409 });

        await qc(`INSERT INTO board_allocations
                    (material_id, order_line_id, qty, source, reason, created_by)
                  VALUES ($1,$2,$3,'stock',$4,$5)`,
          [g.material_id, line.id, c.qty, `Covered from ${g.grn_number}`, req.user.name]);
        covered.push({ order_line_id: line.id, product_name: line.product_name, qty: c.qty });

        // The held sheets must stop counting as incoming — but open PRs only
        // come down by the line's EXCESS (incoming beyond its remaining open
        // need). Cutting them by the covered quantity itself would kill a
        // second PR the job still genuinely needs: need 5,000, this receipt
        // covers 3,000, another PR brings the last 2,000 — that PR survives.
        // 'converted' PRs stay out: QC-accept already retired their mirror.
        //
        // The cut is SURGICAL: this line's own mirror rows and the PR's
        // header/line quantities come down by the same amount, so the
        // Σ(mirror) = pr.qty invariant holds with NO re-mirror. A re-mirror
        // (syncPrAllocation) would re-split the remainder by gross need and
        // hand the covered member a phantom share of a gang's combined PR
        // while starving the members still waiting.
        const remaining = Math.max(0, lineNeed(line) - Number(line.consumed) - heldBefore - c.qty);
        const myOpen = await qc(`
          SELECT a.id, a.qty, a.requisition_id FROM board_allocations a
          JOIN requisitions r2 ON r2.id = a.requisition_id
          WHERE a.order_line_id=$1 AND a.material_id=$2 AND a.status='active'
            AND a.source='requisition' AND r2.status IN ('pending','approved')
          ORDER BY a.id`, [line.id, g.material_id]);
        let excess = Math.max(0, myOpen.reduce((s, a) => s + Number(a.qty), 0) - remaining);
        for (const a of myOpen) {
          if (excess <= 0) break;
          const cut = Math.min(Number(a.qty), excess);
          const left = Number(a.qty) - cut;
          if (left > 0) await qc('UPDATE board_allocations SET qty=$1 WHERE id=$2', [left, a.id]);
          else await qc(`UPDATE board_allocations SET status='consumed', released_at=now() WHERE id=$1`, [a.id]);
          await qc('UPDATE requisitions SET qty = GREATEST(0, qty - $1) WHERE id=$2', [cut, a.requisition_id]);
          await qc(`UPDATE requisition_lines SET qty = GREATEST(0, qty - $1)
                    WHERE requisition_id=$2 AND material_id=$3`, [cut, a.requisition_id, g.material_id]);
          prCuts.set(a.requisition_id, (prCuts.get(a.requisition_id) || 0) + cut);
          excess -= cut;
        }
      }

      // Closure pass, once per touched PR. A PR closes only when NOTHING is
      // left anywhere on it — a multi-line PR whose other materials are still
      // wanted keeps living. `· reopen N` stamps how much THIS receipt's
      // cover took, so rolling the receipt back can bring the PR back.
      const prsReduced = [];
      for (const [prId, cutTotal] of prCuts) {
        const pr = await oc('SELECT * FROM requisitions WHERE id=$1', [prId]);
        const remLines = await oc(
          `SELECT COALESCE(SUM(qty),0) AS n FROM requisition_lines WHERE requisition_id=$1`, [prId]);
        const closed = Number(pr.qty) === 0 && Number(remLines.n) === 0
          && ['pending', 'approved'].includes(pr.status);
        if (closed) {
          await qc(`UPDATE requisitions SET status='closed', status_reason=$1 WHERE id=$2`,
            [`Covered from ${g.grn_number} · reopen ${Math.round(cutTotal)}`, prId]);
        }
        await audit('requisition', prId, closed ? 'close' : 'edit',
          `${pr.pr_number} — ${closed ? 'fully covered' : `down ${fmtN(cutTotal)}`} from ${g.grn_number}`,
          qc, req.user.name);
        prsReduced.push({ pr_number: pr.pr_number, new_qty: Number(pr.qty), closed });
      }
      await audit('grn', g.id, 'cover_board',
        `${g.grn_number} — ${fmtN(totalAsk)} sheets held for ${covered.length} job${covered.length === 1 ? '' : 's'}`,
        qc, req.user.name);
      return { covered, prs_reduced: prsReduced, free_after: free - totalAsk };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Resolved ₹/sheet for every board, for the vendor the PO is being raised on.
// The PO form calls this so it never re-implements the rate lookup client-side.
r.get('/board-po-rates', async (req, res, next) => {
  try {
    const vendorId = req.query.vendor_id || null;
    const boardRates = await q('SELECT * FROM board_rates WHERE active=1');
    const mats = await q("SELECT * FROM materials WHERE category='board' AND active=1");
    res.json(mats.map(m => {
      const rk = resolveRatePerKg(boardRates, m.grade, vendorId);
      return {
        material_id: m.id,
        rate_per_kg: rk?.rate_per_kg ?? null,
        source: rk?.source ?? 'none',
        rate_per_sheet: rk ? ratePerSheet(m, rk.rate_per_kg) : null,
      };
    }));
  } catch (e) { next(e); }
});

export default r;
