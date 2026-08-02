// Procurement — PR → PO → GRN → QC → stock. Every hand-off is real.
import { Router } from 'express';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, EFF_BOARD_ID } from '../helpers.js';
import { planProcurementDelete } from '../procurement-delete.js';
import { requireRole } from '../auth.js';
import { resolveRatePerKg, ratePerSheet, totalWeight } from '../board-math.js';
import { normalisePurpose } from '../replenishment.js';
import { mirrorTargets, gangPrShares } from '../board-allocation.js';

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
      const held = await q(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM board_allocations
                            WHERE status='active' AND source='stock' AND material_id=ANY($1::int[]) GROUP BY 1`, [boardIds]);
      const jobs = await q(`SELECT ${EFF_BOARD_ID} AS material_id, COUNT(*)::int AS n
                            FROM order_lines ol JOIN products p ON p.id=ol.product_id
                            WHERE ol.status IN ('planned','ready') AND ${EFF_BOARD_ID}=ANY($1::int[])
                            GROUP BY 1`, [boardIds]);
      const m = (arr, k) => Object.fromEntries(arr.map(x => [x.material_id, Number(x[k])]));
      const a = m(avail, 'q'), h = m(held, 'q'), j = m(jobs, 'n');
      for (const id of boardIds)
        stk[id] = { available: a[id] || 0, held: h[id] || 0, free: (a[id] || 0) - (h[id] || 0), jobs: j[id] || 0 };
    }
    rows = rows.map(p => ({ ...p, board_stock: stk[p.material_id] || null }));

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
      if (!['pending', 'approved'].includes(pr.status))
        throw Object.assign(new Error(`A ${pr.status} requisition can no longer be edited`), { status: 409 });
      const lines = reqLinesFrom(req.body);
      if (!lines.length) throw Object.assign(new Error('A requisition needs at least one line with a material and quantity'), { status: 400 });
      await assertPurchasable(oc, lines);
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
const JOB_VIEW = `
  SELECT ol.id, ol.qty, ol.status,
         COALESCE(ol.parent_sheets_required, ol.sheets_required) AS parent_sheets_required,
         p.name AS product_name, p.code AS product_code,
         c.name AS customer_name, o.po_number, o.delivery_date
  FROM order_lines ol
  JOIN products p ON p.id = ol.product_id
  JOIN orders o ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id`;

async function jobsForPr(pr) {
  if (!pr) return null;
  const gang = await one(`
    SELECT g.id, g.gang_number FROM gang_runs g
    WHERE g.id = (SELECT gang_run_id FROM order_lines WHERE id=$1)
       OR ($1::int IS NULL AND $2 LIKE 'Combined shortage for gang ' || g.gang_number || ' %')
    LIMIT 1`, [pr.order_line_id, pr.reason || '']);

  const jobs = gang
    ? await q(`${JOB_VIEW} WHERE ol.gang_run_id = $1 ORDER BY ol.id`, [gang.id])
    : (pr.order_line_id ? await q(`${JOB_VIEW} WHERE ol.id = $1`, [pr.order_line_id]) : []);
  if (!jobs.length) return null;

  // A requisition naming no job at all — a plain stock top-up, or a legacy row
  // raised before the anchor — has nothing to show, and says so by returning null.
  return { gang_number: gang?.gang_number || null, members: gangPrShares(pr.qty, jobs) };
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
      if (!Array.isArray(lines) || !lines.length) {
        const rls = await qc(`SELECT rl.*, m.category, m.grade, m.gsm, m.sheet_l, m.sheet_w,
                                     m.sheets_per_packet, m.unit, m.hsn_code, m.gst_rate, m.std_rate, m.last_rate
                              FROM requisition_lines rl JOIN materials m ON m.id=rl.material_id
                              WHERE rl.requisition_id=$1 ORDER BY rl.id`, [pr.id]);
        const boardRates = await qc('SELECT * FROM board_rates WHERE active=1');
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
      // line per material, quantities summed, HSN/GST from the material master.
      const byMaterial = {};
      for (const pr of prs) {
        const rls = await qc('SELECT * FROM requisition_lines WHERE requisition_id=$1', [pr.id]);
        for (const l of rls) (byMaterial[l.material_id] ||= { qty: 0 }).qty += +l.qty;
      }
      const boardRates = await qc('SELECT * FROM board_rates WHERE active=1');
      for (const [materialId, agg] of Object.entries(byMaterial)) {
        const m = await oc('SELECT category, grade, gsm, sheet_l, sheet_w, sheets_per_packet, unit, hsn_code, gst_rate, std_rate, last_rate FROM materials WHERE id=$1', [materialId]);
        // Client-supplied per-line rate wins (incl. a deliberate 0 = free line);
        // else derive from the rate master.
        const resolved = resolvePoRate(m, vendor_id, boardRates);
        await insertPoLines(qc, po.id, [{ material_id: +materialId, qty: agg.qty,
          rate: pickPoRate(rates[materialId], resolved),
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
      await insertPoLines(qc, po.id, lines);
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

      // Remove lines the user dropped — but never one with any receipt (accepted
      // or quarantined), which would also strand its GRN records.
      for (const l of existing) {
        if (!keptIds.has(l.id)) {
          if (committedQty(l) > 0) throw Object.assign(new Error('A line that has goods received against it cannot be removed — short-close the PO instead'), { status: 409 });
          await qc('DELETE FROM po_lines WHERE id=$1', [l.id]);
        }
      }
      // Update kept lines and insert new ones.
      for (const l of lines) {
        if (!l.material_id || !(+l.qty > 0)) throw Object.assign(new Error('Each line needs a material and a positive quantity'), { status: 400 });
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
            [po.id, +l.material_id, +l.qty, +l.rate || 0, l.hsn_code || null, l.unit || null,
             +l.discount_pct || 0, +l.gst_rate || 0]);
        }
        if (+l.rate > 0) await qc('UPDATE materials SET last_rate=$1 WHERE id=$2', [+l.rate, +l.material_id]);
      }
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
    res.json(await q(`
      SELECT g.*, m.name AS material_name, m.unit, po.po_number,
             COALESCE(pv.name, dv.name) AS vendor_name
      FROM grns g JOIN materials m ON m.id=g.material_id
      LEFT JOIN purchase_orders po ON po.id=g.purchase_order_id
      LEFT JOIN vendors pv ON pv.id=po.vendor_id
      LEFT JOIN vendors dv ON dv.id=g.vendor_id
      ORDER BY g.id DESC`));
  } catch (e) { next(e); }
});

// Receive material against a PO line → quarantine batch + ledger row.
r.post('/grns', canBuy, async (req, res, next) => {
  try {
    const { po_line_id, qty, batch_no, vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks } = req.body;
    if (!po_line_id || !qty) return res.status(400).json({ error: 'PO line and quantity are required' });
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
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5) RETURNING id`,
        [pl.material_id, bno, qty, unit, g.id]);
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
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
         VALUES ($1,$2,$3,$3,$4,'quarantine',$5) RETURNING id`,
        [+material_id, bno, +qty, mat.unit, g.id]);
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
          `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status, grn_id)
           VALUES ($1,$2,$3,$3,$4,'quarantine',$5) RETURNING id`,
          [pl.material_id, bno, +l.qty, unit, g.id]);
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

// Edit a GRN — only while it is still in quarantine (before QC). Corrects the
// received quantity / supplier batch number and keeps the quarantine stock
// batch and its ledger row in step.
r.put('/grns/:id', canBuy, async (req, res, next) => {
  try {
    const { qty, batch_no, vehicle_no, supplier_invoice_no, supplier_invoice_date, received_by, remarks } = req.body;
    await tx(async (qc, oc) => {
      const g = await oc('SELECT * FROM grns WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!g) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (g.status !== 'quarantine') throw Object.assign(new Error('Only a GRN awaiting QC can be edited'), { status: 409 });
      const newQty = qty != null && qty !== '' ? +qty : +g.qty;
      if (!(newQty > 0)) throw Object.assign(new Error('Received quantity must be positive'), { status: 400 });
      const newBatch = (batch_no ?? g.batch_no) || g.batch_no;
      await qc(`UPDATE grns SET qty=$1, batch_no=$2, vehicle_no=$3, supplier_invoice_no=$4,
                       supplier_invoice_date=$5, received_by=$6, remarks=$7 WHERE id=$8`,
        [newQty, newBatch, vehicle_no ?? g.vehicle_no, supplier_invoice_no ?? g.supplier_invoice_no,
         supplier_invoice_date ?? g.supplier_invoice_date, received_by ?? g.received_by,
         remarks ?? g.remarks, g.id]);
      await qc('UPDATE stock_batches SET qty=$1, initial_qty=$1, batch_no=$2 WHERE grn_id=$3', [newQty, newBatch, g.id]);
      await qc(`UPDATE stock_movements SET qty=$1 WHERE ref_type='grn' AND ref_id=$2 AND type='grn'`, [newQty, g.id]);
      await audit('grn', g.id, 'edit', `${g.grn_number}: qty ${g.qty} → ${newQty}`, qc, req.user.name);
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
             GREATEST(0, (now()::date - po.created_at::date))::int AS age_days,
             CASE
               WHEN GREATEST(0, (now()::date - po.created_at::date)) <= 7  THEN '0-7'
               WHEN GREATEST(0, (now()::date - po.created_at::date)) <= 15 THEN '8-15'
               WHEN GREATEST(0, (now()::date - po.created_at::date)) <= 30 THEN '16-30'
               ELSE '30+' END AS age_bucket,
             (SELECT MAX(g.received_at) FROM grns g WHERE g.po_line_id = pl.id) AS last_grn_at,
             CASE WHEN po.expected_date IS NOT NULL AND po.expected_date::date < now()::date
                  THEN (now()::date - po.expected_date::date)::int ELSE 0 END AS overdue_days
      FROM po_lines pl
      JOIN purchase_orders po ON po.id=pl.purchase_order_id
      JOIN vendors v ON v.id=po.vendor_id
      JOIN materials m ON m.id=pl.material_id
      WHERE po.status IN ('open','partially_received') AND pl.qty > pl.received_qty
      ORDER BY overdue_days DESC, age_days DESC`);

    // Board is bought by weight — surface how many kg are still due per line so
    // the buyer sees tonnage pressure, not just sheet counts. Non-board lines
    // (or boards with an incomplete master) stay null → the UI shows "—".
    for (const r0 of rows) {
      r0.pending_weight = r0.category === 'board' ? totalWeight(r0, r0.pending_qty) : null;
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
          await qc('UPDATE po_lines SET received_qty = received_qty + $1 WHERE id=$2', [g.qty, g.po_line_id]);
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
