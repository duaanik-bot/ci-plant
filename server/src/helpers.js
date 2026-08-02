// ─── Shared business logic: state machine, stock ledger, routing ────────────
import { q, one } from './db.js';
import { toolingDetail, toolingGateOk } from './tooling-gate.js';
import { rollupRuns, receiptFor } from './stage-runs.js';
import { mixBalance } from './board-mix.js';
// nextNumber aliased: helpers.js has its own nextNumber (document numbers,
// CI-JC-…); the series one counts numeric suffixes inside a code prefix.
import { dominantPrefix, nextNumber as nextSeriesNumber, formatCode } from '../../client/src/lib/productCode.js';
import { customerInitials } from '../../client/src/lib/customerCode.js';

// The next Internal Code in a customer's series, read off the data
// (SW-001..767 style dense series; see productCode.js). Number is derived over
// EVERY code in the prefix — products.code is globally unique, so this cannot
// collide with an inactive or foreign row. Two simultaneous creates could
// still race to the same number; the unique index rejects the loser, and at
// one-planner scale that is a retry, not a design problem. Shared by the
// Masters create/migrate routes and the PO-import quick-create.
export async function nextProductCode(customerId) {
  const cust = await one('SELECT name FROM customers WHERE id=$1', [customerId]);
  const customerCodes = (await q('SELECT code FROM products WHERE customer_id=$1 AND code IS NOT NULL', [customerId])).map(x => x.code);
  const prefix = dominantPrefix(customerCodes) || customerInitials(cust?.name || '');
  const allCodesInPrefix = (await q("SELECT code FROM products WHERE code LIKE $1 || '-%'", [prefix])).map(x => x.code);
  return formatCode(prefix, nextSeriesNumber(allCodesInPrefix, prefix));
}

// Central order-line state machine — every status change goes through this.
const LINE_TRANSITIONS = {
  pending:       ['planned', 'cancelled'],
  planned:       ['ready', 'pending', 'cancelled'],
  ready:         ['in_production', 'planned'],
  in_production: ['produced'],
  produced:      ['dispatched'],
  dispatched:    [],
  cancelled:     [],
};

export function assertTransition(from, to) {
  if (!LINE_TRANSITIONS[from]?.includes(to)) {
    const e = new Error(`Invalid status change: ${from} → ${to}`);
    e.status = 409;
    throw e;
  }
}

// qc/oc: pass the transaction-bound query fns when inside tx(); defaults to pool.
export async function setLineStatus(lineId, to, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }
  assertTransition(line.status, to);
  await qc('UPDATE order_lines SET status=$1 WHERE id=$2', [to, lineId]);
  await audit('order_line', lineId, `status:${line.status}→${to}`, null, qc, user);
  return { ...line, status: to };
}

export async function forceLineStatus(lineId, to, reason, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }
  await qc('UPDATE order_lines SET status=$1 WHERE id=$2', [to, lineId]);
  await audit('order_line', lineId, `status:${line.status}→${to}:manual`, reason || null, qc, user);
  return { ...line, status: to };
}

export async function audit(entity, entityId, action, detail = null, qc = q, user = null) {
  await qc('INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ($1,$2,$3,$4,$5)',
    [entity, entityId, action, detail, user]);
}

// In-app notification fan-out — one row per recipient, surfaced by the bell in
// the app shell. userIds may contain duplicates or nulls; both are dropped so
// callers can pass "everyone who should hear this" without pre-cleaning.
export async function notify(userIds, { kind, title, body = null, link = null, refTable = null, refId = null }, qc = q) {
  const ids = [...new Set(userIds)].filter(id => Number.isInteger(+id) && +id > 0);
  for (const id of ids) {
    await qc(
      'INSERT INTO notifications (user_id, kind, title, body, link, ref_table, ref_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, kind, title, body, link, refTable, refId]);
  }
}

// Sheets needed for an order line (qty cartons → child print sheets incl. wastage).
// Wastage is planned in absolute CHILD SHEETS (plant default 200); the legacy
// percentage on the product master is only the fallback when no sheet figure
// was captured on the line.
export const DEFAULT_WASTAGE_SHEETS = 200;

export function sheetsRequired(product, qty, wastageSheets = null) {
  const base = Math.ceil(qty / Math.max(1, product.ups));
  if (wastageSheets != null && Number.isFinite(+wastageSheets)) {
    return base + Math.max(0, Math.round(+wastageSheets));
  }
  return Math.ceil((qty / Math.max(1, product.ups)) * (1 + product.wastage_pct / 100));
}

// Quantity the plant still has to produce for a line — ordered minus the
// verified FG stock already consumed against it by the planning engine.
export function netProduceQty(line) {
  return Math.max(0, line.qty - (line.fg_consumed_qty || 0));
}

// The parent (mill) sheet a product is actually cut on. The finalised master
// carries an explicit parent size per product (parent_l/parent_w, populated
// from the plant's product-master sheet); when set it is authoritative, else
// we fall back to the linked board material's own sheet size. Returns a
// board-shaped object so childFit / leftoverStrips can consume it directly.
export function effectiveParent(product, board) {
  if (product?.parent_l != null && product?.parent_w != null)
    return { ...(board || {}), sheet_l: +product.parent_l, sheet_w: +product.parent_w };
  return board || {};
}

// Parent → child sheet fit, ported from CI-Production's smart-match engine.
// Board is bought as parent sheets (e.g. 25×36"); the press runs child print
// sheets (e.g. 18×23"). Grid-fit both orientations, best layout wins.
export function childFit(parent, child) {
  const PL = +parent?.sheet_l, PW = +parent?.sheet_w;
  const cl = +child?.child_l, cw = +child?.child_w;
  if (!(PL > 0 && PW > 0 && cl > 0 && cw > 0)) {
    return { count: 1, orientation: null, utilization: null, waste_pct: null, sized: false };
  }
  const EPS = 1e-6;
  const normal = Math.floor(PL / cl + EPS) * Math.floor(PW / cw + EPS);
  const rotated = Math.floor(PL / cw + EPS) * Math.floor(PW / cl + EPS);
  const count = Math.max(normal, rotated);
  if (count <= 0) return { count: 0, orientation: 'none', utilization: 0, waste_pct: 100, sized: true };
  const utilization = Math.min(100, (count * cl * cw) / (PL * PW) * 100);
  return {
    count,
    orientation: rotated > normal ? 'rotated' : 'normal',
    utilization: +utilization.toFixed(1),
    waste_pct: +Math.max(0, 100 - utilization).toFixed(1),
    sized: true,
  };
}

// The plant's own name for childFit's count is "cuts" — the floor never says
// "ups" for this (that word is reserved for products.ups, the PRINTED images
// per print sheet, a wholly different number). cutLayout hangs the printable
// arrangement off childFit's own winning orientation rather than
// re-comparing normal vs rotated itself, so the two functions can never
// disagree about which layout won or by how much: across/down are always
// derived from `fit.orientation`, using childFit's own EPS and tie rule
// (normal wins a tie, since orientation only flips to 'rotated' when it is
// STRICTLY bigger — see childFit above).
//
// Unsized (no dimensions on one side) and zero-fit (count 0) both fall
// through to a real return rather than throwing — a caller enriching a whole
// board mix must not have one unsized row blank the rest of the print.
export function cutLayout(parent, child) {
  const fit = childFit(parent, child);
  if (!fit.sized) return { count: fit.count, across: null, down: null, rotated: false };
  const EPS = 1e-6;
  const PL = +parent.sheet_l, PW = +parent.sheet_w;
  const rotated = fit.orientation === 'rotated';
  const cl = rotated ? +child.child_w : +child.child_l;
  const cw = rotated ? +child.child_l : +child.child_w;
  return {
    count: fit.count,
    across: Math.floor(PL / cl + EPS),
    down: Math.floor(PW / cw + EPS),
    rotated,
  };
}

// Guillotine remainder of the winning childFit layout. Cutting nL×nW children
// out of a parent leaves two rectangular offcut strips: one down the length,
// one under the grid. Dims are normalized l ≥ w; strips under 3" on the short
// side are real cuts but not bankable stock (usable=false).
export function leftoverStrips(parent, child) {
  const fit = childFit(parent, child);
  if (!fit.sized || fit.count <= 0) return [];
  const PL = +parent.sheet_l, PW = +parent.sheet_w;
  const [cl, cw] = fit.orientation === 'rotated'
    ? [+child.child_w, +child.child_l] : [+child.child_l, +child.child_w];
  const EPS = 1e-6;
  const nL = Math.floor(PL / cl + EPS), nW = Math.floor(PW / cw + EPS);
  const raw = [
    { l: +(PL - nL * cl).toFixed(2), w: PW },        // strip along the length
    { l: +(nL * cl).toFixed(2), w: +(PW - nW * cw).toFixed(2) }, // strip under the grid
  ];
  return raw
    .map(s => ({ l: Math.max(s.l, s.w), w: Math.min(s.l, s.w) }))
    .filter(s => s.w > 0.05)
    .map(s => ({ ...s, usable: s.w >= 3, strips_per_parent: 1 }));
}

// One leftover master per (source board, strip size), orientation-agnostic.
// Code LO-<sourceId>-<L>X<W> (decimal point → P, so 7.5 → 7P5). qc/oc are the
// transaction's query/one — always called inside a tx.
export async function findOrCreateLeftoverMaster(sourceBoard, strip, qc, oc) {
  const L = Math.max(+strip.l, +strip.w), W = Math.min(+strip.l, +strip.w);
  const existing = await oc(`
    SELECT * FROM materials
    WHERE leftover=1 AND source_material_id=$1
      AND ABS(GREATEST(sheet_l, sheet_w) - $2) < 0.01
      AND ABS(LEAST(sheet_l, sheet_w) - $3) < 0.01`,
    [sourceBoard.id, L, W]);
  if (existing) return existing;
  const dim = n => String(+(+n).toFixed(2)).replace('.', 'P');
  const code = `LO-${sourceBoard.id}-${dim(L)}X${dim(W)}`;
  const [m] = await qc(`
    INSERT INTO materials (name, category, spec, unit, sheet_l, sheet_w, reorder_level,
                           code, leftover, source_material_id)
    VALUES ($1,'board',$2,'sheets',$3,$4,0,$5,1,$6)
    ON CONFLICT (code) WHERE code IS NOT NULL DO NOTHING RETURNING *`,
    [`Leftover — ${sourceBoard.name} · ${L}×${W}"`, sourceBoard.spec, L, W, code, sourceBoard.id]);
  // Concurrent insert raced us: the row exists now, fetch it.
  return m || await oc('SELECT * FROM materials WHERE code=$1', [code]);
}

// ── Planning-time leftover banking ──────────────────────────────────────────
// The board offcut is banked into the warehouse the MOMENT the cut is locked in
// the Planning engine (not at cutting-complete). The batch is keyed per line
// (LO-PLAN-<lineId>) and holds the PLANNED quantity; cutting-complete later
// trues it up to the actual parents cut and renames it to LO-<jc_number>
// ("confirmed"). A batch_no prefix of LO-PLAN- therefore means "planned, cut not
// yet run". Always called inside a tx.
export async function bankPlanningLeftover(line, srcBoard, strip, stripsPerParent, plannedQty, qc, oc, user) {
  const batchNo = `LO-PLAN-${line.id}`;
  const master = await findOrCreateLeftoverMaster(srcBoard, strip, qc, oc);
  const qty = Math.max(0, Math.round(+plannedQty || 0));
  const existing = await oc('SELECT * FROM stock_batches WHERE batch_no=$1', [batchNo]);
  if (existing) {
    // Re-plan: strip/board may have moved. If the master changed, fully reverse
    // the old master's ledger and re-book on the new one; else book the delta.
    if (existing.material_id !== master.id) {
      if (+existing.qty !== 0)
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'leftover_in',$3,'order_line',$4,$5)`,
          [existing.material_id, existing.id, -existing.qty, line.id, `Leftover re-planned — strip/board changed`]);
      await qc(`UPDATE stock_batches SET material_id=$1, qty=$2, initial_qty=$2, status=$3 WHERE id=$4`,
        [master.id, qty, qty > 0 ? 'available' : 'exhausted', existing.id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'leftover_in',$3,'order_line',$4,$5)`,
        [master.id, existing.id, qty, line.id, `Leftover re-planned ${strip.l}×${strip.w}"`]);
    } else {
      const delta = qty - +existing.qty;
      if (delta !== 0) {
        await qc(`UPDATE stock_batches SET qty=$1, initial_qty=$1, status=$2 WHERE id=$3`,
          [qty, qty > 0 ? 'available' : 'exhausted', existing.id]);
        await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,$2,'leftover_in',$3,'order_line',$4,$5)`,
          [master.id, existing.id, delta, line.id, `Leftover re-planned qty ${existing.qty}→${qty}`]);
      }
    }
  } else {
    const [b] = await qc(`INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
                          VALUES ($1,$2,$3,$3,'sheets',$4) RETURNING id`,
      [master.id, batchNo, qty, qty > 0 ? 'available' : 'exhausted']);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'leftover_in',$3,'order_line',$4,$5)`,
      [master.id, b.id, qty, line.id, `Leftover ${strip.l}×${strip.w}" planned (line ${line.id})`]);
  }
  await audit('order_line', line.id, 'leftover_planned',
    `${qty} sheets ${strip.l}×${strip.w}" banked on lock (planned)`, qc, user);
}

// Reverse a planning-time leftover bank that has NOT yet been confirmed at
// cutting (still LO-PLAN-<lineId>). Confirmed leftovers (LO-<jc>) are reversed
// by the job-stage reversal paths instead. Safe no-op when nothing was banked.
export async function unbankPlanningLeftover(lineId, qc, oc, user, why = '') {
  const b = await oc('SELECT * FROM stock_batches WHERE batch_no=$1', [`LO-PLAN-${lineId}`]);
  if (!b) return;
  if (+b.qty > 0) {
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'leftover_in',$3,'order_line',$4,$5)`,
      [b.material_id, b.id, -b.qty, lineId, `Leftover un-planned${why ? ` — ${why}` : ''}`]);
    await qc(`UPDATE stock_batches SET qty=0, status='exhausted' WHERE id=$1`, [b.id]);
  }
  await audit('order_line', lineId, 'leftover_unplanned', why || 'plan cleared', qc, user);
}

export function parentSheetsRequired(childSheets, childrenPerParent) {
  const cpp = Math.max(1, childrenPerParent || 1);
  return Math.ceil(childSheets / cpp);
}

// How many PARENT (mother) sheets a job still needs — the unit the warehouse
// stocks, allocations hold, and requisitions BUY.
//
// The locked plan figure is the answer whenever it exists. Before the plan is
// locked there is no parent figure, and the two things that are available —
// order_lines.sheets_required and a live estimate from the master spec — are
// both CHILD print-sheet counts. Handing either back unconverted prices the job
// in the wrong unit, and on a 3-up board that is a 3x purchase order, not a
// rounding error: CI-GANG-0007 needed 2,575 parent sheets and CI-PR-0006 was
// raised for 7,525, its child total.
//
// childFit returns 1 when the child is unsized, so an incomplete master
// degrades to the old 1:1 behaviour rather than dividing by a guess.
export function memberParentSheets(m) {
  if (m?.parent_sheets_required != null) return m.parent_sheets_required;
  const child = m?.sheets_required != null
    ? m.sheets_required
    : sheetsRequired({ ups: m?.ups, wastage_pct: m?.wastage_pct }, netProduceQty(m), m?.wastage_sheets);
  const fit = childFit({ sheet_l: m?.sheet_l, sheet_w: m?.sheet_w },
                       { child_l: m?.child_l, child_w: m?.child_w });
  return parentSheetsRequired(child, fit.count);
}

export async function availableQty(materialId, oc = one) {
  const r = await oc(
    `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`,
    [materialId]);
  return r.q;
}

// Consume material FIFO across available batches. Ledger rows in same tx.
//
// preferBatchId (optional, defaults to null): draw from this one lot FIRST,
// up to whatever it holds, before falling through to the ordinary FIFO loop
// for any remainder — the mechanism behind a planner naming a lot to
// deliberately clear ageing stock (Task 8b). Every existing caller omits it
// and runs exactly the FIFO loop this function has always run; nothing below
// the `if (preferBatchId)` block changes shape for them.
//
// Scoped to the batch AND its material, not just the batch id: if
// preferBatchId names a lot that is empty, exhausted, or — should the data
// ever be wrong, since nothing upstream cross-checks it — belongs to a
// DIFFERENT material than materialId, the lookup simply finds no row and
// this falls through to FIFO exactly as if no preference had been given. No
// error is raised for a stale or mismatched lot: the override/confirm step
// this feeds exists precisely so the floor can correct a plan that no longer
// matches the warehouse, and by the time this runs the operator has already
// confirmed the issue. Refusing the stage start over a lot that quietly
// disappeared between planning and cutting would be a worse outcome than
// silently substituting FIFO stock of the same, correct material.
export async function consumeFifo(materialId, qty, refType, refId, note, qc, oc, preferBatchId = null) {
  let remaining = qty;
  const draw = async (b, take) => {
    const newQty = b.qty - take;
    await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
      [newQty, newQty === 0 ? 'exhausted' : 'available', b.id]);
    await qc(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
       VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
      [materialId, b.id, -take, refType, refId, note]);
  };
  if (preferBatchId) {
    const [b] = await qc(
      `SELECT * FROM stock_batches WHERE id=$1 AND material_id=$2 AND status='available' AND qty>0`,
      [preferBatchId, materialId]);
    if (b) {
      const take = Math.min(b.qty, remaining);
      await draw(b, take);
      remaining -= take;
    }
  }
  const batches = await qc(
    `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
    [materialId]);
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty, remaining);
    await draw(b, take);
    remaining -= take;
  }
  if (remaining > 0) {
    const e = new Error(`Insufficient stock: short by ${remaining}`);
    e.status = 409;
    throw e;
  }
}

// Warehouse true-up for a cutting variance. `deltaParents` > 0 consumes extra
// board (packet was intact — cut the full bundle); < 0 refunds board (short
// packet). Cutting is NEVER blocked: if stock runs out, the shortfall lands on
// a negative "CUT-SHORT" batch that surfaces in the warehouse for reconcile.
// Uses only existing stock_movements types ('consumption' / 'adjustment').
export async function adjustBoardStock(materialId, deltaParents, refType, refId, note, qc, oc) {
  if (!materialId || !deltaParents) return;
  if (deltaParents > 0) {
    let remaining = deltaParents;
    const batches = await qc(
      `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
      [materialId]);
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.qty, remaining);
      const newQty = b.qty - take;
      await qc(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
        [newQty, newQty === 0 ? 'exhausted' : 'available', b.id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
        [materialId, b.id, -take, refType, refId, note]);
      remaining -= take;
    }
    if (remaining > 0) {
      const [short] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,0,'sheets','available') RETURNING id`,
        [materialId, `CUT-SHORT-${refId}`, -remaining]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
        [materialId, short.id, -remaining, refType, refId, `${note} (unbacked over-issue)`]);
    }
  } else {
    const refund = -deltaParents;
    const newest = await qc(
      `SELECT id FROM stock_batches WHERE material_id=$1 AND status IN ('available','exhausted')
       ORDER BY created_at DESC, id DESC LIMIT 1`, [materialId]);
    let batchId;
    if (newest[0]) {
      batchId = newest[0].id;
      await qc(`UPDATE stock_batches SET qty=qty+$1, status='available' WHERE id=$2`, [refund, batchId]);
    } else {
      const [rb] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`,
        [materialId, `CUT-RETURN-${refId}`, refund]);
      batchId = rb.id;
    }
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
      [materialId, batchId, refund, refType, refId, note]);
  }
}

// ── Multi-board consumption ─────────────────────────────────────────────────
// The mix rows for one line, planned board first so the panel and every print
// read in the same order. Order on the predicate explicitly — 'planned' sorting
// before 'substitute' alphabetically is an accident, not a guarantee.
//
// qc has NO default, unlike most read helpers in this file (shadeCardsFor,
// availableQty, readiness). Those return a number or a status that is merely
// stale if read from the wrong snapshot; mixFor's result gates a structural
// branch — Task 8 falls through to the single-board consumeFifo path when it
// reads no rows, Task 9 refuses to issue a job it thinks has no mix — so a read
// against the pool instead of the live transaction can make a job LOOK
// mix-free when it is not. A caller inside tx() must pass its tx-bound qc; a
// plain GET with no transaction (the planning-context read, the job-card print
// read) passes q explicitly. Costs those two read-only call sites one token
// each; the alternative is a silent wrong-branch bug in a stock ledger.
export async function mixFor(orderLineId, phase = 'plan', qc) {
  return qc(
    // m.sheet_l/sheet_w ride along so a caller enriching rows with cutLayout
    // (production.js's job-card GET) never needs a second query per row — every
    // other caller of mixFor just ignores the extra columns. sheets_per_packet
    // rides along for the same reason: the plant counts and stores board in
    // PACKETS, so every screen that names a sheet figure shows its packet
    // equivalent beside it.
    `SELECT jbm.*, m.name AS board_name, m.sheet_l, m.sheet_w, m.sheets_per_packet
       FROM job_board_mix jbm
       JOIN materials m ON m.id = jbm.material_id
      WHERE jbm.order_line_id=$1 AND jbm.phase=$2
      ORDER BY (jbm.role='planned') DESC, jbm.id`,
    [orderLineId, phase]);
}

// Every phase='plan' row also writes an ordinary stock hold, so the warehouse's
// free/held view is correct for the substitute board without board-allocation.js
// being touched — the same mirror idiom the ERP already runs between purchase
// requisitions and allocations (routes/board.js's syncMovedPrAllocation). Holds
// carry `reason` so BoardCommitments explains itself, and job_board_mix_id so
// releaseMixHolds/consumeMixHolds can find exactly the rows this mirror wrote,
// never a hand-placed hold that happens to share a material and order line —
// see that column's own comment in db.js for the collision it closes.
//
// No balance check in this function, on purpose: rows arrive already validated
// (the planning route calls board-mix.js's mixBalance/rowCovers before this
// ever runs, exactly as routes/board.js trusts planMove's precomputed effects
// rather than re-deriving them at the point of writing). replaceMixPlan only
// has orderLineId and rows, not the line's requirement, so it cannot re-check
// balance without a redundant query the caller already did — and it would not
// even cover the board-issue endpoint at Cutting Start, which writes
// phase='issued' rows through its own INSERT and never calls this function.
// That endpoint needs its own mixBalance call if its override path is to be
// validated; nothing here can do it for them.
//
// No audit() call here either — the plan-save route logs its own 'board_mix'
// entry immediately after calling this. Logging here too would double the
// timeline entry for every mix save. (clearMixPlan below DOES audit itself —
// it is the only place that clears a mix, so there is no caller to double up.)
export async function replaceMixPlan(orderLineId, rows, qc, user) {
  // Release BEFORE delete — see releaseMixHolds's comment. Deleting the old
  // job_board_mix rows first would null the job_board_mix_id link on their
  // holds (ON DELETE SET NULL) before this UPDATE ever runs, and those holds
  // would sail past every future release/consume call as if hand-placed.
  await releaseMixHolds(orderLineId, qc, user, 'mix replaced');
  await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='plan'`, [orderLineId]);
  for (const r of rows) {
    const [mix] = await qc(
      `INSERT INTO job_board_mix
         (order_line_id, material_id, stock_batch_id, sheets, ups, covers, role, phase, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'plan',$8,$9) RETURNING id`,
      [orderLineId, r.material_id, r.stock_batch_id ?? null, r.sheets, r.ups, r.covers,
       r.role, r.reason ?? null, user]);
    await qc(
      `INSERT INTO board_allocations
         (material_id, order_line_id, qty, source, status, reason, created_by, job_board_mix_id)
       VALUES ($1,$2,$3,'stock','active',$4,$5,$6)`,
      [r.material_id, orderLineId, r.sheets, r.reason || 'board mix', user, mix.id]);
  }
}

// Has board already left the warehouse for this line's (currently existing)
// job card? Same idiom production.js's JC_VIEW already runs for board_pending
// (NOT EXISTS on stock_movements), just inverted and scoped via the order
// line's job card rather than a job_card id already in hand — job_cards.
// order_line_id is UNIQUE, so at most one row can ever match.
//
// If the job card itself has already been deleted (rollbackLine, workflow.js's
// reverse_plan — both only after confirming no stage ever started, so
// consumption never happened) this necessarily reads false, which is the
// correct answer for those callers. The one path where a job card carrying
// real consumption gets deleted (forceUnwindJobCard, force-deleting a
// mid-production line) is only ever reached with mode='delete', which cascades
// job_board_mix off the order_line's own deletion moments later regardless of
// what this function decides — so there is no path where this blind spot lets
// a live consumption's issued rows go missing.
async function orderLineBoardConsumed(orderLineId, qc) {
  const hit = await qc(
    `SELECT 1 AS x FROM job_cards jc
       JOIN stock_movements sm
         ON sm.ref_type='job_card' AND sm.ref_id=jc.id AND sm.type='consumption'
      WHERE jc.order_line_id=$1 LIMIT 1`,
    [orderLineId]);
  return hit.length > 0;
}

// Re-planning a line invalidates its mix: `ups` and `covers` are frozen per row,
// so a changed child size, quantity, wastage or planned board leaves a balance
// that silently no longer sums. Clear rather than recompute — the planner is
// told to rebuild instead of being released on stale arithmetic.
//
// phase='issued' rows are cleared alongside phase='plan' ones UNLESS board has
// already left the warehouse for this line. Before this guard, 'issued' rows
// were said to be "history and never cleared" — true only once the board is
// actually gone. Cutting Start's board-issue confirm/override step can write
// 'issued' rows well before the corresponding stage ever starts (a two-request
// design — see production.js's own comment on that gap), so a job card that
// confirmed its board issue and then had its plan amended, reversed, or
// re-locked before ever starting left those 'issued' rows stranded: the next
// cutting start would read them as the truth and silently consume stale
// boards/quantities against a plan that no longer asked for them. Once
// consumption has actually been posted, though, 'issued' rows ARE the
// permanent historical record of physical stock movement and must never be
// deleted — orderLineBoardConsumed is the line between those two cases.
export async function clearMixPlan(orderLineId, qc, user, why) {
  const consumed = await orderLineBoardConsumed(orderLineId, qc);
  const phases = consumed ? ['plan'] : ['plan', 'issued'];
  const [{ n }] = await qc(
    `SELECT COUNT(*)::int AS n FROM job_board_mix WHERE order_line_id=$1 AND phase = ANY($2)`,
    [orderLineId, phases]);
  if (!n) return 0;
  // Release BEFORE delete — same reason as replaceMixPlan above. Only 'plan'
  // rows ever carry a mirrored hold (job_board_mix_id), so this is unaffected
  // by whether 'issued' rows are also being cleared this time.
  await releaseMixHolds(orderLineId, qc, user, why);
  await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase = ANY($2)`, [orderLineId, phases]);
  await audit('order_line', orderLineId, 'mix_cleared',
    `board mix cleared (${n} row${n === 1 ? '' : 's'}) — ${why}`, qc, user);
  return n;
}

// A hold released here is a planning decision being undone. Distinct from
// consumeMixHolds below, which is the board physically leaving the warehouse —
// releasing there instead of consuming would return sheets to `free` that have
// already left the building, and every later job on that board would read
// short forever. (The board-allocation wave's own Task 14 — floor warning at
// Cutting Start, not yet built — hits the identical distinction for a
// single-board job; this is its multi-board counterpart.)
//
// Scoped by job_board_mix_id IS NOT NULL, not by order_line_id/material_id: the
// board hold/move panel (routes/board.js's POST /board/move) lets a planner
// hand-hold ANY board for this same order line with no mix involved at all, in
// the exact same row shape (material_id/order_line_id/qty/source='stock'/
// status='active'). Its job_board_mix_id is NULL — only replaceMixPlan ever
// sets it — so it is invisible to this UPDATE regardless of which material it
// names. This FK replaced an earlier version of this function that scoped by
// `EXISTS (SELECT 1 FROM job_board_mix WHERE …material_id=ba.material_id)`,
// which protected a hand-placed hold on a DIFFERENT board but not on the SAME
// board as the mix — the collision this column exists to close.
//
// MUST run before the caller deletes the job_board_mix rows it points at (see
// replaceMixPlan and clearMixPlan above, both release-then-delete): this
// UPDATE identifies our holds BY that link. Delete the mix rows first and
// ON DELETE SET NULL erases the link before this query can read it — every
// hold this mix owns would silently look hand-placed, forever, to every
// release/consume call from then on.
export async function releaseMixHolds(orderLineId, qc, user, why) {
  await qc(
    `UPDATE board_allocations
        SET status='released', released_by=$2, released_at=now(), release_reason=$3
      WHERE order_line_id=$1 AND status='active' AND job_board_mix_id IS NOT NULL`,
    [orderLineId, user, why]);
}

// Scoped the same way releasing is, for the same reason — see the comment
// above. Must also run before any caller deletes the job_board_mix rows a
// job's holds point at, though today nothing does: phase='issued' rows (the
// ones consumeMixHolds's caller has necessarily just written) are history and
// are never cleared.
export async function consumeMixHolds(orderLineId, qc) {
  await qc(
    `UPDATE board_allocations SET status='consumed'
      WHERE order_line_id=$1 AND status='active' AND job_board_mix_id IS NOT NULL`,
    [orderLineId]);
}

// The Cutting-Start counterpart for COVER holds — the earmark a "Cover board"
// action writes when a receipt lands (routes/procurement.js POST
// /grns/:id/cover). Once cutting draws the board the hold's reservation job
// is done; left active it would subtract the departed sheets from `free` a
// second time, and every later cover on that board would read less free
// stock than the warehouse holds. Scoped to the cover tag — hand-placed
// holds from the board panel keep their manual-release-only semantics
// exactly as before (see the scoping essay above releaseMixHolds).
export async function consumeCoverHolds(orderLineIds, materialId, qc) {
  if (!orderLineIds?.length || !materialId) return;
  await qc(
    `UPDATE board_allocations SET status='consumed'
      WHERE order_line_id = ANY($1) AND material_id=$2 AND status='active'
        AND source='stock' AND reason LIKE 'Covered from CI-GRN-%'`,
    [orderLineIds, materialId]);
}

export async function fgReceipt(productId, qty, refType, refId, qc) {
  await qc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
            ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + EXCLUDED.qty`, [productId, qty]);
  await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
            VALUES ($1,'fg_receipt',$2,$3,$4)`, [productId, qty, refType, refId]);
}

// A line's EFFECTIVE board: a warehouse pick made in the planning engine
// (spec_override) always beats the product master. Every query that resolves a
// line to a board MUST use this, or a "stolen" board reads as free. Expects the
// query to alias order_lines as `ol` and products as `p`.
export const EFF_BOARD_ID =
  `COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)`;

// The order line a JOB CARD reads its spec from. A plain card has its own
// (jc.order_line_id); a gang parent or combined-run card has NONE and reads
// the ANCHOR member — the lowest-id line on the run. Any query joining a card
// to a line MUST LEFT JOIN this and COALESCE(ol.x, gol.x), or every run card
// silently vanishes from the result (a plain `JOIN order_lines ol ON ol.id =
// jc.order_line_id` is an INNER join on NULL).
//
// The anchor is correct for facts the run SHARES — board, coating, parent
// sheet, the order/customer link — and WRONG for per-member facts (customer
// name, PO number, carton spec presented as "the" value). A run's members
// come from GANG_MEMBERS_LATERAL / the run detail, never from gol alone.
// Expects the query to alias job_cards as `jc`; produces the alias `gol`.
export const GANG_ANCHOR_LINE = `
  LEFT JOIN LATERAL (
    SELECT ol2.* FROM order_lines ol2
    WHERE ol2.gang_run_id = jc.gang_run_id
    ORDER BY ol2.id LIMIT 1
  ) gol ON jc.order_line_id IS NULL`;

// ── FG stock-reference matching (Internal Carton Code → Party Artwork Code →
// Product Code) ─────────────────────────────────────────────────────────────
// A SQL predicate that, given an aliased product `p` on the order-line side and
// an aliased product `fp` on the FG-lot side, decides whether the two are the
// same finished good. Priority: if the line's product carries an Internal
// Carton Code, match on that; else on the Party Artwork Code; else on the
// Product Code (always at least the product itself, since code is unique).
// Codes are NULL until populated, so today this reduces to same Product Code.
export function fgMatchPredicate(p = 'p', fp = 'fp') {
  return `(
    (${p}.internal_carton_code IS NOT NULL AND ${fp}.internal_carton_code = ${p}.internal_carton_code)
    OR (${p}.internal_carton_code IS NULL AND ${p}.party_artwork_code IS NOT NULL
        AND ${fp}.party_artwork_code = ${p}.party_artwork_code)
    OR (${p}.internal_carton_code IS NULL AND ${p}.party_artwork_code IS NULL
        AND ${fp}.code = ${p}.code)
  )`;
}

// Which key actually matched two products — for the popup's "matched by" hint.
export function fgMatchedBy(lineProduct, lotProduct) {
  if (lineProduct.internal_carton_code && lotProduct.internal_carton_code === lineProduct.internal_carton_code)
    return 'internal_carton_code';
  if (lineProduct.party_artwork_code && lotProduct.party_artwork_code === lineProduct.party_artwork_code)
    return 'party_artwork_code';
  return 'product_code';
}

// Verified FG remaining that matches an order line by the code hierarchy.
export async function fgAvailableForLine(line, oc = one) {
  const row = await oc(`
    SELECT COALESCE(SUM(fl.qty - fl.consumed_qty),0)::int AS qty
    FROM fg_lots fl
    JOIN products fp ON fp.id = fl.product_id
    JOIN products p  ON p.id = $1
    WHERE fl.status='verified' AND (fl.qty - fl.consumed_qty) > 0 AND ${fgMatchPredicate()}`,
    [line.product_id]);
  return row.qty;
}

// Append one movement to the FG Warehouse ledger, computing the running balance
// of the given stock reference. Always called inside a tx. No FG lot balance
// should ever change without a matching call here.
export async function fgMove(m, qc, oc) {
  const prev = await oc(
    `SELECT balance FROM fg_movements WHERE ref_number=$1 ORDER BY id DESC LIMIT 1`, [m.ref_number]);
  const balance = (prev?.balance ?? 0) + (+m.qty_in || 0) - (+m.qty_out || 0);
  await qc(`
    INSERT INTO fg_movements (ref_number, parent_ref, fg_lot_id, product_id, order_line_id,
                              order_id, customer_id, qty_in, qty_out, balance,
                              movement_type, source_module, created_by, remarks)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [m.ref_number, m.parent_ref || null, m.fg_lot_id || null, m.product_id,
     m.order_line_id || null, m.order_id || null, m.customer_id || null,
     +m.qty_in || 0, +m.qty_out || 0, balance,
     m.movement_type, m.source_module || 'warehouse', m.created_by || null, m.remarks || null]);
  return balance;
}

export async function fgIssue(productId, qty, refType, refId, qc, oc) {
  const row = await oc('SELECT qty FROM fg_stock WHERE product_id=$1 FOR UPDATE', [productId]);
  if (!row || row.qty < qty) {
    const e = new Error('Insufficient finished-goods stock');
    e.status = 409;
    throw e;
  }
  await qc('UPDATE fg_stock SET qty = qty - $1 WHERE product_id=$2', [qty, productId]);
  await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
            VALUES ($1,'dispatch',$2,$3,$4)`, [productId, -qty, refType, refId]);
}

// Box loose finished goods into a numbered Leftover box. This is a PHYSICAL
// move: the qty is carved OUT of the loose fg_stock balance (In Stock drops, the
// box holds it) so nothing is double-counted. Pass reduceFg=false when the goods
// arrive from elsewhere (e.g. an un-shipped dispatch) and were never in loose
// stock. Returns { id, lot_number, box_number, qty }.
export async function boxLeftoverFromFg({ product_id, qty, source = 'fg_leftover', created_by, reduceFg = true, remarks }, qc, oc) {
  const n = Math.floor(+qty);
  if (!(n > 0)) return null;
  const lot_number = await nextNumber('CI-FG-', 'fg_lots', 'lot_number', oc);
  const box_number = await nextNumber('CI-BOX-', 'fg_lots', 'box_number', oc);
  const [lot] = await qc(`
    INSERT INTO fg_lots (lot_number, box_number, kind, product_id, qty, source, status, location, created_by, verified_by, verified_at)
    VALUES ($1,$2,'leftover',$3,$4,$5,'verified','FG-STORE',$6,$6,now()) RETURNING id`,
    [lot_number, box_number, product_id, n, source, created_by]);
  if (reduceFg) {
    await qc('UPDATE fg_stock SET qty = qty - $1 WHERE product_id=$2', [n, product_id]);
    await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,'adjustment',$2,'fg_lot',$3,$4)`,
      [product_id, -n, lot.id, `Moved to leftover box ${box_number}`]);
  }
  const cust = await oc('SELECT customer_id FROM products WHERE id=$1', [product_id]);
  await fgMove({
    ref_number: lot_number, fg_lot_id: lot.id, product_id, customer_id: cust?.customer_id,
    qty_in: n, movement_type: 'excess_stock', source_module: 'warehouse',
    created_by, remarks: remarks || `Boxed as leftover ${box_number}`,
  }, qc, oc);
  await audit('fg_lot', lot.id, 'create', `${lot_number} · box ${box_number} — ${n} pcs leftover`, qc, created_by);
  return { id: lot.id, lot_number, box_number, qty: n };
}

// Move a leftover box's remaining qty back into loose FG stock. The box empties
// (its remaining goes to zero) and disappears from the Leftover view.
export async function moveLeftoverBoxToFg(lotId, qc, oc, user) {
  const lot = await oc('SELECT * FROM fg_lots WHERE id=$1 FOR UPDATE', [lotId]);
  if (!lot) throw Object.assign(new Error('Box not found'), { status: 404 });
  if (lot.kind !== 'leftover') throw Object.assign(new Error('Only a leftover box can be moved to FG'), { status: 409 });
  const remaining = Math.max(0, +lot.qty - +lot.consumed_qty);
  if (remaining <= 0) throw Object.assign(new Error('This box is already empty'), { status: 409 });
  await qc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
            ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + EXCLUDED.qty`, [lot.product_id, remaining]);
  await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
            VALUES ($1,'adjustment',$2,'fg_lot',$3,$4)`,
    [lot.product_id, remaining, lot.id, `Leftover box ${lot.box_number} returned to FG`]);
  await qc(`UPDATE fg_lots SET consumed_qty=qty, status='consumed' WHERE id=$1`, [lot.id]);
  const cust = await oc('SELECT customer_id FROM products WHERE id=$1', [lot.product_id]);
  await fgMove({
    ref_number: lot.lot_number, fg_lot_id: lot.id, product_id: lot.product_id, customer_id: cust?.customer_id,
    qty_out: remaining, movement_type: 'manual_adjustment', source_module: 'warehouse',
    created_by: user, remarks: `Box ${lot.box_number} moved back to FG stock`,
  }, qc, oc);
  await audit('fg_lot', lot.id, 'to_fg', `${lot.lot_number} · box ${lot.box_number} — ${remaining} pcs returned to FG`, qc, user);
  return { remaining };
}

// Classify a coating/finish into the production stage it needs. Handles both
// the legacy enum (aqueous/uv/matt_lam/gloss_lam) and the real finish labels
// from the plant master (e.g. "Aqueous Varnish (Gloss)", "Full UV Coating",
// "Thermal Lamination (Matte)", "Soft Touch", "Drip-Off Coating"). Returns
// 'lamination', 'coating', or null (no extra stage — "None"/blank).
export function coatingStage(coating) {
  const c = String(coating || '').trim().toLowerCase();
  if (!c || c === 'none') return null;
  if (c === 'matt_lam' || c === 'gloss_lam' || c.includes('lamination') || c.includes('soft touch'))
    return 'lamination';
  if (c === 'aqueous' || c === 'uv' || c.includes('varnish') || c.includes('uv')
      || c.includes('coating') || c.includes('drip') || c.includes('gloss') || c.includes('spot'))
    return 'coating';
  return 'coating'; // any other named finish still runs the coating line
}

// A finishing flag counts as "set" when the master field is populated. Handles
// the INTEGER toggles (0/1), booleans and strings that a job spec_override may
// carry, plus the legacy 'special' enum values.
function flagSet(v) {
  if (v === 1 || v === true) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

// Production routing derived DYNAMICALLY from the Product Master spec — no JSON
// blobs, no manual routing. Mandatory stages are ALWAYS present:
//   Cutting → Printing → Die Cutting → Sorting → Pasting → QC.
// Pasting is also the PACKING station — every job passes through it so the
// packing manifest is recorded, even a die-cut-only box with no gluing; the
// pasting_type field just names the gluing style (blank = pack only, no glue).
// The three optional finishing stages are added only when their Product Master
// field is populated; a blank field auto-skips the workstation and the job
// flows straight to the next stage:
//   • Coating  → 'coating'/'lamination' when products.coating names a finish
//   • Leafing  → 'foiling'   when products.leafing is set (hot-foil stamping)
//   • Embossing→ 'embossing' when products.emboss  is set
// Sheets convert to cartons at Sorting (blanks counted).
export function routingFor(product) {
  const stages = [{ stage: 'cutting', unit: 'sheets' }];
  stages.push({ stage: 'printing', unit: 'sheets' });

  // Coating / Lamination — by the named finish label (null/'none' = skip).
  const finish = coatingStage(product.coating);
  if (finish) stages.push({ stage: finish, unit: 'sheets' });

  // Leafing (hot-foil stamping) runs on the foil press → 'foiling' stage.
  if (flagSet(product.leafing) || product.special === 'foil' || product.special === 'foil_emboss')
    stages.push({ stage: 'foiling', unit: 'sheets' });

  // Embossing.
  if (flagSet(product.emboss) || product.special === 'emboss' || product.special === 'foil_emboss')
    stages.push({ stage: 'embossing', unit: 'sheets' });

  stages.push({ stage: 'die_cutting', unit: 'sheets' });
  stages.push({ stage: 'sorting', unit: 'cartons' });
  stages.push({ stage: 'pasting', unit: 'cartons' }); // pasting + packing — always
  stages.push({ stage: 'qc', unit: 'cartons' });
  return stages;
}

// Sorting rejection reasons (NCR) — lifted verbatim from CI-Production.
export const SORTING_REJECTION_REASONS = [
  'Misprint', 'Die-cut error', 'Lamination defect', 'Foil misregister',
  'Crease break', 'Surface damage', 'Other',
];

// Sequential document numbers: CI-JC-0001 …
export async function nextNumber(prefix, table, column, oc = one) {
  const row = await oc(`SELECT ${column} AS n FROM ${table} ORDER BY id DESC LIMIT 1`);
  let seq = 1;
  if (row?.n) {
    const m = String(row.n).match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ── Shade-card expiry engine ─────────────────────────────────────────────────
// A shade card is obsolete 365 days after its creation date: colour standards
// fade and drift, so Planning and Invoicing must warn before it is used again.
// Returns { [product_id]: { code, title, creation_date, approval_date,
//                           age_days, expired } } for every product that has an
// active shade card with a creation date on record.
export const SHADE_CARD_LIFE_DAYS = 365;
export async function shadeCardsFor(productIds, qf = q) {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return {};
  // Source of truth: the Shade Card Management module. The newest live card per
  // product wins; status/revision ride along so Planning and Invoicing can show
  // the live approval state, not just the age.
  const rows = await qf(`
    SELECT DISTINCT ON (product_id) product_id, sc_number AS code, title,
           creation_date, approval_received_date AS approval_date,
           status, revision_no, approval_method, id AS shade_card_id
    FROM shade_cards
    WHERE active=1 AND product_id = ANY($1)
      AND status NOT IN ('superseded','archived')
    ORDER BY product_id, id DESC`, [ids]);
  // Fallback: the Shade Card Number + Date captured on the Carton Product
  // Master itself. A managed card (above) wins, so the two sources never
  // fight — master rows are folded in first and a shade_cards row for the
  // same product overwrites it.
  const masters = await qf(`
    SELECT id AS product_id, shade_card_number AS code, shade_card_date AS creation_date
    FROM products
    WHERE id = ANY($1) AND shade_card_date IS NOT NULL AND shade_card_date <> ''`, [ids]);
  const out = {};
  for (const t of [...masters.map(m => ({ ...m, source: 'master' })), ...rows]) {
    const created = Date.parse(t.creation_date);
    const age_days = Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : null;
    if (t.source === 'master' && age_days == null) continue;
    out[t.product_id] = { ...t, age_days, expired: age_days != null && age_days >= SHADE_CARD_LIFE_DAYS };
  }
  return out;
}

// The 3-point readiness gate for job card creation. ONE place, no bypasses.
// Material is checked in PARENT sheets — board stock is bought and stored as
// parent sheets; the child requirement converts through the cut fit.
// A shortage with a PR/PO already raised is a SOFT gate (material_pending):
// the job may proceed with a board-pending alarm; the physical stop stays at
// cutting start, where consumeFifo refuses to issue sheets that don't exist.
// A line's effective product spec = master product merged with its job-only
// override (the "save for this job" branch of the master-update philosophy).
export function effectiveProduct(product, line) {
  const ov = line?.spec_override;
  if (!ov) return product;
  const o = typeof ov === 'string' ? JSON.parse(ov) : ov;
  return { ...product, ...o };
}

// Batch loader for readiness() over many lines. readiness() needs six lookups
// per line; done one line at a time that is 6N queries, which on a remote DB
// makes the planning queue's latency grow linearly with the queue. This resolves
// the same data for every line in a fixed 7 queries and hands readiness() a
// cache. Single-line callers pass no context and keep the simple path.
export async function readinessBatch(lines, oc = one, qc = q) {
  const ctx = {
    products: new Map(), materials: new Map(), available: new Map(),
    tools: new Map(), shade: new Map(), incoming: new Map(), fg: new Map(),
    mix: new Map(), holds: new Map(),
  };
  const productIds = [...new Set(lines.map(l => l.product_id).filter(x => x != null))];
  if (!productIds.length) return ctx;

  // Wave 1: masters, so spec overrides can resolve the effective board and tool.
  for (const p of await qc('SELECT * FROM products WHERE id = ANY($1)', [productIds])) {
    ctx.products.set(p.id, p);
  }
  const effective = lines.map(l => effectiveProduct(ctx.products.get(l.product_id), l));
  const materialIds = [...new Set(effective.map(p => p?.board_material_id).filter(x => x != null))];
  const toolIds = [...new Set(effective.map(p => p?.tool_id).filter(x => x != null))];

  // Wave 1.5: the mix, before wave 2 — a substitute board's stock is never
  // fetched unless its material id joins materialIds here.
  const lineIds = lines.map(l => l.id).filter(x => x != null);
  const mixAll = lineIds.length
    ? await qc(`SELECT * FROM job_board_mix WHERE order_line_id = ANY($1) AND phase='plan'
                ORDER BY (role='planned') DESC, id`, [lineIds])
    : [];
  for (const r of mixAll) {
    if (!ctx.mix.has(r.order_line_id)) ctx.mix.set(r.order_line_id, []);
    ctx.mix.get(r.order_line_id).push(r);
  }
  for (const r of mixAll) if (!materialIds.includes(r.material_id)) materialIds.push(r.material_id);

  // Wave 2: everything keyed off those ids, in parallel.
  const [materials, batches, tools, shades, incoming, fg] = await Promise.all([
    qc('SELECT * FROM materials WHERE id = ANY($1)', [materialIds]),
    qc(`SELECT material_id, COALESCE(SUM(qty),0) AS q FROM stock_batches
        WHERE material_id = ANY($1) AND status='available' GROUP BY material_id`, [materialIds]),
    qc(`SELECT * FROM tools WHERE product_id = ANY($1) OR id = ANY($2) ORDER BY id`,
      [productIds, toolIds]),
    // One row per product: the same "latest active card" the per-line query took.
    qc(`SELECT DISTINCT ON (product_id) product_id, sc_number, status, revision_no, creation_date
        FROM shade_cards
        WHERE product_id = ANY($1) AND active=1 AND status NOT IN ('superseded','archived')
        ORDER BY product_id, id DESC`, [productIds]),
    qc(`SELECT m.id AS material_id,
               COALESCE(r.qty,0)::int + COALESCE(po.qty,0)::int AS qty
        FROM unnest($1::int[]) AS m(id)
        LEFT JOIN (SELECT material_id, SUM(qty) AS qty FROM requisitions
                   WHERE material_id = ANY($1) AND status IN ('pending','approved')
                   GROUP BY material_id) r ON r.material_id = m.id
        LEFT JOIN (SELECT pl.material_id, SUM(GREATEST(0, pl.qty - COALESCE(pl.received_qty,0))) AS qty
                   FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
                   WHERE pl.material_id = ANY($1) AND po.status IN ('open','partially_received')
                   GROUP BY pl.material_id) po ON po.material_id = m.id`, [materialIds]),
    qc(`SELECT p.id AS product_id,
               COALESCE(SUM(fl.qty - fl.consumed_qty),0)::int AS qty
        FROM products p
        LEFT JOIN products fp ON ${fgMatchPredicate()}
        LEFT JOIN fg_lots fl ON fl.product_id = fp.id
             AND fl.status='verified' AND (fl.qty - fl.consumed_qty) > 0
        WHERE p.id = ANY($1)
        GROUP BY p.id`, [productIds]),
  ]);
  // Board already EARMARKED for a named job — every active stock hold on these
  // boards, with the job that holds it. Stock a planner tied to another job (or
  // that procurement's Cover action tied to the job that bought it) is not
  // available to this one; counting it would tell every job on the board that
  // one delivery covered them all. Only the LIST views resolve holds this way
  // (they alone pass a ctx) — the job-card release gate keeps reading raw
  // stock, so no card that releases today starts refusing.
  const holdRows = materialIds.length
    ? await qc(`SELECT a.material_id, a.order_line_id, a.qty, ol.gang_run_id
                FROM board_allocations a
                LEFT JOIN order_lines ol ON ol.id = a.order_line_id
                WHERE a.material_id = ANY($1) AND a.status='active' AND a.source='stock'`, [materialIds])
    : [];
  for (const h of holdRows) {
    if (!ctx.holds.has(h.material_id)) ctx.holds.set(h.material_id, []);
    ctx.holds.get(h.material_id).push(h);
  }
  for (const m of materials) ctx.materials.set(m.id, m);
  for (const b of batches) ctx.available.set(b.material_id, b.q);
  for (const t of tools) {
    if (t.product_id != null) {
      if (!ctx.tools.has(t.product_id)) ctx.tools.set(t.product_id, []);
      ctx.tools.get(t.product_id).push(t);
    }
    ctx.tools.set(`id:${t.id}`, t);
  }
  for (const s of shades) ctx.shade.set(s.product_id, s);
  for (const i of incoming) ctx.incoming.set(i.material_id, i.qty);
  for (const f of fg) ctx.fg.set(f.product_id, f.qty);
  return ctx;
}

// FG available for a line, served from a readinessBatch context.
export function fgAvailableFromCtx(line, ctx) {
  return ctx.fg.get(line.product_id) ?? 0;
}

// What of a board's stock this job may actually claim: everything on the shelf
// except what is earmarked for OTHER jobs. A hold belonging to this line — or
// to a sibling of its gang, since a run buys and cuts as one — is its own and
// never subtracts. Pure, and the reason one delivery can no longer mark every
// job on that board as covered.
export function claimableQty({ available, holds = [], line }) {
  const mine = h => h.order_line_id === line?.id
    || (line?.gang_run_id != null && h.gang_run_id === line.gang_run_id);
  const others = holds.filter(h => !mine(h)).reduce((s, h) => s + Number(h.qty || 0), 0);
  return Math.max(0, Number(available || 0) - others);
}

export async function readiness(line, oc = one, ctx = null) {
  const master = ctx
    ? ctx.products.get(line.product_id)
    : await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
  const product = effectiveProduct(master, line);
  const board = ctx
    ? (ctx.materials.get(product.board_material_id) ?? null)
    : await oc('SELECT * FROM materials WHERE id=$1', [product.board_material_id]);
  const parent = effectiveParent(product, board);
  const needed = line.sheets_required ?? sheetsRequired(product, netProduceQty(line), line.wastage_sheets);
  const fit = childFit(parent, product);
  const parentNeeded = line.parent_sheets_required ?? parentSheetsRequired(needed, fit.count);
  // In a list view (ctx) this is what the job can CLAIM — shelf stock less
  // what is held for other jobs. Single-line callers (the release gate, the
  // engine's own context) keep reading raw shelf stock, unchanged.
  const availableOf = mid => (ctx
    ? claimableQty({ available: ctx.available.get(mid) ?? 0, holds: ctx.holds.get(mid) ?? [], line })
    : null);
  const available = ctx
    ? availableOf(product.board_material_id)
    : await availableQty(product.board_material_id, oc);
  // Tooling: every physical tool linked to this product (the die also links
  // via products.tool_id). Hard/soft semantics live in tooling-gate.js.
  let toolList;
  if (ctx) {
    const byProduct = ctx.tools.get(line.product_id) ?? [];
    const byId = product.tool_id != null ? ctx.tools.get(`id:${product.tool_id}`) : null;
    // Same set the OR-predicate returned, deduped and in id order.
    const merged = byId && !byProduct.some(t => t.id === byId.id) ? [...byProduct, byId] : byProduct;
    toolList = [...merged].sort((a, b) => a.id - b.id);
  } else {
    const toolsRow = await oc(`
      SELECT COALESCE(json_agg(t ORDER BY t.id), '[]'::json) AS list
      FROM tools t WHERE t.product_id = $1 OR t.id = $2`,
      [line.product_id, product.tool_id ?? -1]);
    toolList = toolsRow.list;
  }
  const detail = toolingDetail(product, toolList);
  // Shade card: lives in the Shade Card Management module now, not the Tooling
  // Hub. Folded into the detail with the same soft semantics so the Tooling
  // chip keeps showing it: registered but rejected/expired blocks softly;
  // untracked informs; approved (or in-flight) reads ready enough for the
  // job-card gate — the real production stop happens at printing start.
  const shade = ctx
    ? (ctx.shade.get(line.product_id) ?? null)
    : await oc(`
    SELECT sc_number, status, revision_no, creation_date FROM shade_cards
    WHERE product_id=$1 AND active=1 AND status NOT IN ('superseded','archived')
    ORDER BY id DESC LIMIT 1`, [line.product_id]);
  // One rule: approved and in date. The old list named statuses that no longer
  // exist, so under the four-status vocabulary a draft or sent card matched
  // nothing and read as READY — a card the customer has never approved,
  // reported as good to go.
  const shadeBad = shade && (shade.status !== 'approved'
    || (Date.parse(shade.creation_date) && (Date.now() - Date.parse(shade.creation_date)) / 86400000 >= SHADE_CARD_LIFE_DAYS));
  detail.push({
    family: 'shade_card', label: 'Shade Card', hard: false,
    status: !shade ? 'missing' : shadeBad ? 'not_ready' : 'ready',
    tool_id: null, code: shade?.sc_number ?? null, zone: shade?.status ?? null,
    condition: shade ? `Rev ${shade.revision_no}` : null,
  });
  const dieDetail = detail.find(x => x.family === 'die');
  // Incoming supply for this board: open PRs plus undelivered PO balance.
  const incoming = ctx
    ? { qty: ctx.incoming.get(product.board_material_id) ?? 0 }
    : await oc(`
    SELECT COALESCE((SELECT SUM(qty) FROM requisitions
                     WHERE material_id=$1 AND status IN ('pending','approved')),0)::int
         + COALESCE((SELECT SUM(GREATEST(0, pl.qty - COALESCE(pl.received_qty,0)))
                     FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
                     WHERE pl.material_id=$1 AND po.status IN ('open','partially_received')),0)::int AS qty`,
    [product.board_material_id]);
  // Multi-board: when the line carries a mix, its requirement is met by the mix
  // rows rather than by this one board. Balanced is not enough — every row's own
  // board must still hold the sheets, or the gate would open on a plan whose
  // substitute stock has since been eaten by another job.
  const mix = ctx
    ? (ctx.mix.get(line.id) ?? [])
    : await oc(`SELECT COALESCE(json_agg(x ORDER BY x.id), '[]'::json) AS list
                FROM job_board_mix x WHERE x.order_line_id=$1 AND x.phase='plan'`,
        [line.id]).then(r => r.list);
  const bal = mixBalance({ required: parentNeeded, rows: mix });
  let mixStocked = true;
  // Also tracks whether a board OTHER than the planned one is the short one.
  // Deliberately does NOT `break` on the first short row: mixFor/this query both
  // sort the planned-board row first (role='planned' DESC), so breaking early
  // would blind `substituteShort` to a later substitute's shortfall every time
  // the planned board's own row happens to be short too.
  let substituteShort = false;
  if (bal.active) {
    for (const r of mix) {
      const have = ctx
        ? availableOf(r.material_id)
        : await availableQty(r.material_id, oc);
      if (have < r.sheets) {
        mixStocked = false;
        if (r.material_id !== product.board_material_id) substituteShort = true;
      }
    }
  }
  const materialOk = bal.active ? (bal.balanced && mixStocked) : available >= parentNeeded;
  // `incoming` above is scoped to the PLANNED board only (see its own comment).
  // Two mix states make reusing it blindly misleading: an UNBALANCED mix is a
  // planning gap — the rows do not sum to the requirement — and no incoming
  // board closes that by itself; it needs a planner to allocate the rest (see
  // createJobCardForLine's "allocate the remaining N" message). A BALANCED mix
  // short on a SUBSTITUTE board is not fixed by the planned board's PR either —
  // crediting it would tell the planner supply is coming when nothing addresses
  // the board actually missing. Only a shortfall confined to the planned
  // board's own row inherits the pre-mix meaning of "pending".
  const materialPending = bal.active
    ? (!materialOk && bal.balanced && !substituteShort && incoming.qty > 0)
    : (!materialOk && incoming.qty > 0);
  return {
    artwork: !!line.artwork_locked,
    tooling: toolingGateOk(detail, line.tooling_ok),
    tooling_detail: detail,
    die_number: dieDetail?.code || null,
    die_condition: dieDetail?.condition || null,
    material: materialOk,
    material_pending: materialPending,
    incoming_sheets: incoming.qty,
    needed_sheets: needed,                 // child print sheets
    parent_needed: parentNeeded,           // parent sheets to issue
    children_per_parent: fit.count,
    parent_size: fit.sized ? `${parent.sheet_l}×${parent.sheet_w}"` : null,
    child_size: fit.sized ? `${product.child_l}×${product.child_w}"` : null,
    cut_waste_pct: fit.waste_pct,
    available_sheets: available,           // parent sheets in stock
    board_material_id: product.board_material_id,
    mix_active: bal.active,
    mix_balance: bal.balance,
    mix_rows: mix.length,
  };
}

// ── Board coverage, one vocabulary ───────────────────────────────────────────
// Planning, Print Planning and the floor all answer the same question about a
// planned job — "is its board sorted?" — so they answer it with ONE three-state
// verdict instead of each page keeping its own pair of booleans:
//
//   covered   the board is HERE and the plan can consume it: warehouse stock,
//             an alternate/mixed board the engine planned onto, or board moved
//             to this job from another. This is readiness()'s material gate,
//             deliberately the same fact the job-card release gate uses — the
//             chip must never disagree with what the ERP will actually allow.
//   on_order  not here yet, but bought: a requisition naming THIS job (or its
//             gang) is open, or converted to a PO that still owes delivery.
//             Planning is done; the board is the only thing missing.
//   short     neither. Nobody has covered it and nobody has ordered it.
//
// Mutually exclusive and ORDERED: covered beats on_order beats short, so a job
// reads covered the moment its stock is real. That ordering is what lets a GRN
// in procurement silently flip a job's chip on the Print Planning triage
// without anyone re-planning anything.
export function boardStateOf({ material, prRaised }) {
  return material ? 'covered' : prRaised ? 'on_order' : 'short';
}

// The worst state in a set — a gang goes on press as ONE job, so its weakest
// member decides for the whole run.
export function worstBoardState(states = []) {
  return states.includes('short') ? 'short'
    : states.includes('on_order') ? 'on_order'
    : 'covered';
}

// Which of these order lines have board ON ORDER for them — batched, one query
// for a whole queue. Line-scoped on purpose: readiness()'s `incoming` counts
// any PR on the board, so a PR raised for a DIFFERENT job would otherwise make
// this job read "on order" when nothing was bought for it.
//
// Three rules earn their keep here:
//  - a PR's material_id is a SNAPSHOT (the CI-PR-0006 rule), so it counts only
//    while it names a board this line still plans on — its effective board or
//    one of its mix rows.
//  - a gang buys as ONE combined PR anchored to a single member, so any
//    sibling's PR covers every member of the run.
//  - 'converted' counts only while its PO still owes delivery; once received,
//    the board is stock and the covered state takes over on its own.
export async function openPrLineIds(lineIds = [], qc = q) {
  if (!lineIds.length) return new Set();
  const rows = await qc(`
    SELECT DISTINCT ol.id
    FROM order_lines ol
    JOIN products p ON p.id = ol.product_id
    WHERE ol.id = ANY($1)
      AND (
        EXISTS (
          SELECT 1 FROM requisitions r
          WHERE (r.material_id = ${EFF_BOARD_ID}
                 OR r.material_id IN (SELECT x.material_id FROM job_board_mix x
                                      WHERE x.order_line_id = ol.id AND x.phase='plan'))
            AND (r.order_line_id = ol.id
                 OR (ol.gang_run_id IS NOT NULL AND r.order_line_id IN
                     (SELECT s.id FROM order_lines s WHERE s.gang_run_id = ol.gang_run_id)))
            AND (r.status IN ('pending','approved')
                 OR (r.status = 'converted' AND EXISTS (
                       SELECT 1 FROM po_lines pl
                       JOIN purchase_orders po ON po.id = pl.purchase_order_id
                       WHERE pl.purchase_order_id = r.purchase_order_id
                         AND po.status IN ('open','partially_received')
                         AND pl.qty > COALESCE(pl.received_qty, 0))))
        )
        OR EXISTS (
          SELECT 1 FROM board_allocations a
          WHERE a.order_line_id = ol.id AND a.status='active' AND a.source='requisition'
            AND (a.material_id = ${EFF_BOARD_ID}
                 OR a.material_id IN (SELECT x.material_id FROM job_board_mix x
                                      WHERE x.order_line_id = ol.id AND x.phase='plan'))
        )
      )`, [lineIds]);
  return new Set(rows.map(r => r.id));
}

// Lines whose board has already been DRAWN — cutting issued it and the sheets
// are on the floor. Their board question is closed however little is left on
// the shelf, so they read covered: a job mid-production is not a job to chase
// board for, and telling the press "board short" about work already printing
// is the fastest way to make the whole chip strip ignorable. Batched.
//
// A gang's board is consumed against the RUN's parent card, which carries no
// order line of its own (the GANG_ANCHOR_LINE trap), so members are matched
// through the run as well as directly.
export async function boardDrawnLineIds(lineIds = [], qc = q) {
  if (!lineIds.length) return new Set();
  const rows = await qc(`
    SELECT DISTINCT ol.id
    FROM order_lines ol
    WHERE ol.id = ANY($1)
      AND EXISTS (
        SELECT 1 FROM stock_movements sm
        JOIN job_cards jc ON jc.id = sm.ref_id AND sm.ref_type='job_card'
        WHERE sm.type='consumption'
          AND (jc.order_line_id = ol.id
               OR (ol.gang_run_id IS NOT NULL AND jc.order_line_id IS NULL
                   AND jc.gang_run_id = ol.gang_run_id))
      )`, [lineIds]);
  return new Set(rows.map(r => r.id));
}

// Does completing this stage split the card into per-product children?
// Only a GANG parent splits — several different products that must become
// separate carton jobs after die cutting. A COMBINED RUN (kind='merge') is one
// product on one pile: it runs the whole route as one card and is closed by QC
// like any other job. Pure, so "a combined run never splits" is a unit test,
// not a comment — the caller supplies the run's kind.
export function shouldSplitAtDieCut({ isLastStage, stage, gangRunId, orderLineId, runKind }) {
  return !!(isLastStage && stage === 'die_cutting' && gangRunId && !orderLineId && runKind !== 'merge');
}

// The order lines a finished job card produced for. A plain or split-child
// card produced for exactly one; a COMBINED RUN card produced one pile of
// identical cartons for every member of its run, so every member becomes
// 'produced' the moment QC accepts — the cartons are physically
// indistinguishable, and which sales order each one ends up on is decided at
// dispatch (POST /fg/move fills earliest delivery first), not here.
export async function closeRunLines(jc, qc = q, oc = one, user = null) {
  if (jc.order_line_id) return [await setLineStatus(jc.order_line_id, 'produced', qc, oc, user)];
  if (!jc.gang_run_id) return [];
  const lines = await qc('SELECT id FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [jc.gang_run_id]);
  const out = [];
  for (const l of lines) out.push(await setLineStatus(l.id, 'produced', qc, oc, user));
  return out;
}

export async function createJobCardForLine(lineId, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }

  if (line.gang_run_id) {
    const run = await oc('SELECT kind FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    return run?.kind === 'merge'
      ? createJobCardForMergeRun(line.gang_run_id, qc, oc, user)
      : createJobCardForGang(line.gang_run_id, qc, oc, user);
  }

  const existing = await oc('SELECT id, jc_number FROM job_cards WHERE order_line_id=$1', [line.id]);
  if (existing) {
    const e = new Error(`Job card already exists for this line — ${existing.jc_number}`);
    e.status = 409;
    throw e;
  }
  if (!['planned', 'ready'].includes(line.status)) {
    const e = new Error('Lock planning and artwork before creating a job card');
    e.status = 409;
    throw e;
  }

  const gate = await readiness(line, oc);
  // With a mix in play the shortfall is what the mix has not covered, not what
  // one board is missing — a fully covered job must never read as short.
  const short = gate.mix_active
    ? Math.max(0, gate.mix_balance)
    : Math.max(0, gate.parent_needed - gate.available_sheets);
  const blocked = [];
  if (!gate.artwork) blocked.push('artwork not locked');
  // Tooling is a soft signal, not a hard gate: a job card can be pushed with a
  // die / plate / block / shade card still not ready. The Tooling chip keeps it
  // visible and line clearance still gates the actual stage start on the floor.
  // Shortage with a PR/PO already raised passes softly — the card carries a
  // board-pending alarm and cutting cannot start until the board arrives.
  if (!gate.material && !gate.material_pending) {
    blocked.push(gate.mix_active
      ? (short > 0
          ? `board mix covers ${gate.parent_needed - short} of ${gate.parent_needed} parent sheets — allocate the remaining ${short}`
          : 'a board in the mix no longer has the stock allocated to it — re-check the mix')
      : `board short by ${short} parent sheets — raise a PR to proceed`);
  }
  if (blocked.length) {
    const e = new Error(`Cannot create job card: ${blocked.join(', ')}`);
    e.status = 409;
    throw e;
  }

  if (line.status === 'planned') await setLineStatus(line.id, 'ready', qc, oc, user);
  if (line.status === 'ready' || line.status === 'planned') await setLineStatus(line.id, 'in_production', qc, oc, user);

  const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
  const product = effectiveProduct(master, line);
  const jc_number = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
  const [jc] = await qc(
    `INSERT INTO job_cards (jc_number, order_line_id, product_id, machine_id, qty_planned, sheets_issued, children_per_parent)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [jc_number, line.id, line.product_id, line.machine_id, netProduceQty(line), gate.parent_needed, gate.children_per_parent]);

  const stages = routingFor(product);
  for (let i = 0; i < stages.length; i++) {
    await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
      [jc.id, i + 1, stages[i].stage, stages[i].unit]);
  }
  const pending = [];
  // Same root fact readiness-light.js now names correctly: material_pending
  // can only be true for a mix when it is BALANCED (an unbalanced mix always
  // hard-blocks above, never reaches here), so `short` is ~0 here whenever
  // gate.mix_active — "short 0 parent sheets" would be nonsense next to an
  // audit line that is, itself, announcing a shortage. Name the mix instead
  // of a manufactured zero.
  if (!gate.material) {
    pending.push(gate.mix_active
      ? 'board mix pending (a board in the mix is short, supply already requested)'
      : `board pending (short ${short} parent sheets, supply on order)`);
  }
  if (!gate.tooling) pending.push('tooling not ready');
  await audit('job_card', jc.id, 'create',
    pending.length ? `${jc_number} — ${pending.join('; ')}` : jc_number, qc, user);
  return jc.id;
}

export async function createJobCardForGang(gangRunId, qc = q, oc = one, user = null) {
  const existing = await oc(
    'SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL',
    [gangRunId]);
  if (existing) return existing.id;

  const lines = await qc(`
    SELECT ol.* FROM order_lines ol
    WHERE ol.gang_run_id=$1
    ORDER BY ol.id
    FOR UPDATE OF ol`, [gangRunId]);
  if (lines.length < 2) {
    const e = new Error('A gang job needs at least two bound order lines');
    e.status = 409;
    throw e;
  }

  // A SHARED-layout gang cannot reach the floor before its layout exists: the
  // final child sheet size is entered by the planner once the designer settles
  // the nesting, and until then there is nothing true to cut. Checked on the
  // OVERRIDES directly (helpers cannot import the route module) — the same
  // rule sharedLayoutState() enforces upstream.
  const gangRow = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangRunId]);
  if (gangRow?.layout_mode === 'shared') {
    const ov = lines.map(l => {
      const o = l.spec_override
        ? (typeof l.spec_override === 'string' ? JSON.parse(l.spec_override) : l.spec_override)
        : {};
      return { l: +o.child_l || 0, w: +o.child_w || 0 };
    });
    if (ov.some(o => !(o.l > 0) || !(o.w > 0)) || new Set(ov.map(o => `${o.l}x${o.w}`)).size > 1) {
      const e = new Error(`${gangRow.gang_number} is Layout Pending — enter the final child sheet size before pushing the job card`);
      e.status = 409;
      throw e;
    }
  }

  const gates = [];
  const products = [];
  const blocked = [];
  let totalParent = 0;
  let totalChild = 0;
  for (const line of lines) {
    if (!['planned', 'ready'].includes(line.status)) {
      blocked.push(`line ${line.id} is ${line.status.replace('_', ' ')}`);
      continue;
    }
    const gate = await readiness(line, oc);
    // Same mix-aware shortfall as createJobCardForLine — a gang line covered
    // by a mix must not read as short just because this loop keeps its own
    // copy of the single-board difference for the other lines' sake.
    const short = gate.mix_active
      ? Math.max(0, gate.mix_balance)
      : Math.max(0, gate.parent_needed - gate.available_sheets);
    if (!gate.artwork) blocked.push(`line ${line.id}: artwork not locked`);
    // Tooling is a soft signal (see createJobCardForLine) — never blocks the push.
    if (!gate.material && !gate.material_pending) {
      blocked.push(gate.mix_active
        ? (short > 0
            ? `line ${line.id}: board mix covers ${gate.parent_needed - short} of ${gate.parent_needed} parent sheets — allocate the remaining ${short}`
            : `line ${line.id}: a board in the mix no longer has the stock allocated to it — re-check the mix`)
        : `line ${line.id}: board short by ${short} parent sheets`);
    }
    const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
    const product = effectiveProduct(master, line);
    products.push(product);
    gates.push(gate);
    totalParent += gate.parent_needed;
    totalChild += gate.needed_sheets;
  }
  if (blocked.length) {
    const e = new Error(`Cannot create gang job card: ${blocked.join(', ')}`);
    e.status = 409;
    throw e;
  }

  for (const line of lines) {
    if (line.status === 'planned') await setLineStatus(line.id, 'ready', qc, oc, user);
    await setLineStatus(line.id, 'in_production', qc, oc, user);
  }

  const gang = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangRunId]);
  const anchor = lines[0];
  const anchorProduct = products[0];
  const jc_number = await nextNumber('CI-GANG-JC-', 'job_cards', 'jc_number', oc);
  const [jc] = await qc(`
    INSERT INTO job_cards (jc_number, order_line_id, gang_run_id, product_id, machine_id,
                           qty_planned, sheets_issued, children_per_parent, child_sheets_planned)
    VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [jc_number, gangRunId, anchor.product_id, anchor.machine_id, totalChild, totalParent,
     Math.max(1, gates[0]?.children_per_parent || 1), totalChild]);

  const wanted = new Set(['cutting', 'printing', 'die_cutting']);
  for (const p of products) {
    for (const s of routingFor(p)) {
      if (s.unit === 'sheets' && s.stage !== 'sorting') wanted.add(s.stage);
      if (s.stage === 'die_cutting') break;
    }
  }
  const canonical = routingFor(anchorProduct)
    .filter(s => s.unit === 'sheets' && wanted.has(s.stage) && ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'].includes(s.stage));
  for (const stage of ['coating', 'lamination', 'foiling', 'embossing']) {
    if (wanted.has(stage) && !canonical.some(s => s.stage === stage)) canonical.splice(Math.max(canonical.length - 1, 2), 0, { stage, unit: 'sheets' });
  }
  canonical.sort((a, b) => ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'].indexOf(a.stage) - ['cutting', 'printing', 'coating', 'lamination', 'foiling', 'embossing', 'die_cutting'].indexOf(b.stage));
  for (let i = 0; i < canonical.length; i++) {
    await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
      [jc.id, i + 1, canonical[i].stage, canonical[i].unit]);
  }
  await audit('job_card', jc.id, 'create_gang_parent',
    `${jc_number}${gang?.gang_number ? ` for ${gang.gang_number}` : ''}: ${lines.length} jobs bound until die cutting`,
    qc, user);
  return jc.id;
}

// One job card for a COMBINED RUN — the same product on several sales orders,
// printed as ONE pile. Unlike a gang parent this card runs the FULL route
// (cutting → … → sorting → pasting → qc) and never splits: the members' routes
// are byte-identical because they are the same product, so there is nothing to
// re-derive per member and nothing to hand over at die cutting.
//
// The card is a normal job in every physical respect, so it takes a normal
// CI-JC- number — CI-GANG-JC- announces "this card will split", which is
// precisely the thing a combined run must never do. The combined identity
// lives on the run (CI-MRG-….), shown as a chip beside the card number.
//
// qty_planned is in CARTONS (Σ netProduceQty), exactly like a plain card and
// unlike a gang parent's child-sheet total — every downstream reader
// (dispatch, FG, reports) then treats this card as the normal job it is.
export async function createJobCardForMergeRun(runId, qc = q, oc = one, user = null) {
  const existing = await oc(
    'SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL',
    [runId]);
  if (existing) return existing.id;

  const lines = await qc(`
    SELECT ol.* FROM order_lines ol
    WHERE ol.gang_run_id=$1
    ORDER BY ol.id
    FOR UPDATE OF ol`, [runId]);
  if (lines.length < 2) {
    const e = new Error('A combined run needs at least two bound sales orders');
    e.status = 409;
    throw e;
  }
  // Belt and braces on the run's own invariant. mergeCompat blocks this at
  // creation; a run that somehow drifted must fail here rather than mint a
  // card whose "one pile" premise is false.
  if (new Set(lines.map(l => l.product_id)).size > 1) {
    const e = new Error('A combined run must be ONE product — these lines have drifted apart. Dissolve and re-combine.');
    e.status = 409;
    throw e;
  }

  const blocked = [];
  let totalParent = 0;
  let totalCartons = 0;
  const gates = [];
  for (const line of lines) {
    if (!['planned', 'ready'].includes(line.status)) {
      blocked.push(`line ${line.id} is ${line.status.replace('_', ' ')}`);
      continue;
    }
    const gate = await readiness(line, oc);
    const short = gate.mix_active
      ? Math.max(0, gate.mix_balance)
      : Math.max(0, gate.parent_needed - gate.available_sheets);
    if (!gate.artwork) blocked.push(`line ${line.id}: artwork not locked`);
    // Tooling stays a soft signal, same as every other card-creation path.
    if (!gate.material && !gate.material_pending) {
      blocked.push(`line ${line.id}: board short by ${short} parent sheets`);
    }
    gates.push(gate);
    totalParent += gate.parent_needed;
    totalCartons += netProduceQty(line);
  }
  if (blocked.length) {
    const e = new Error(`Cannot create the combined run's job card: ${blocked.join(', ')}`);
    e.status = 409;
    throw e;
  }

  for (const line of lines) {
    // A member's private board mix is meaningless once the pile is one: the
    // run issues ONE board, and stage-start reads mixes by order_line_id —
    // NULL on this card — so an uncleared mix would never be consumed OR
    // released and its mirrored hold would overstate that board's committed
    // stock forever. Release before the statuses flip.
    await clearMixPlan(line.id, qc, user, `combined into one run — one board for the pile`);
    if (line.status === 'planned') await setLineStatus(line.id, 'ready', qc, oc, user);
    await setLineStatus(line.id, 'in_production', qc, oc, user);
  }

  const run = await oc('SELECT * FROM gang_runs WHERE id=$1', [runId]);
  const anchor = lines[0];
  const master = await oc('SELECT * FROM products WHERE id=$1', [anchor.product_id]);
  const product = effectiveProduct(master, anchor);
  const jc_number = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
  const [jc] = await qc(`
    INSERT INTO job_cards (jc_number, order_line_id, gang_run_id, product_id, machine_id,
                           qty_planned, sheets_issued, children_per_parent)
    VALUES ($1,NULL,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [jc_number, runId, anchor.product_id, anchor.machine_id, totalCartons, totalParent,
     Math.max(1, gates[0]?.children_per_parent || 1)]);

  const stages = routingFor(product);
  for (let i = 0; i < stages.length; i++) {
    await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
      [jc.id, i + 1, stages[i].stage, stages[i].unit]);
  }
  await audit('job_card', jc.id, 'create_merge_run',
    `${jc_number} for ${run?.gang_number || 'combined run'}: ${lines.length} sales orders as one run — no split`,
    qc, user);
  return jc.id;
}

export async function splitGangParentJob(parentJobCardId, qc = q, oc = one, user = null) {
  const parent = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [parentJobCardId]);
  if (!parent?.gang_run_id || parent.order_line_id) return [];
  const existing = await qc('SELECT id FROM job_cards WHERE parent_job_card_id=$1 ORDER BY id', [parent.id]);
  if (existing.length) return existing.map(x => x.id);

  const lines = await qc(`
    SELECT ol.* FROM order_lines ol
    WHERE ol.gang_run_id=$1
    ORDER BY ol.id
    FOR UPDATE OF ol`, [parent.gang_run_id]);
  const childIds = [];
  for (const line of lines) {
    const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
    const product = effectiveProduct(master, line);
    const jcNumber = await nextNumber('CI-JC-', 'job_cards', 'jc_number', oc);
    const [child] = await qc(`
      INSERT INTO job_cards (jc_number, order_line_id, gang_run_id, parent_job_card_id, product_id,
                             machine_id, qty_planned, sheets_issued, children_per_parent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [jcNumber, line.id, parent.gang_run_id, parent.id, line.product_id, parent.machine_id,
       netProduceQty(line), netProduceQty(line), 1]);
    const stages = routingFor(product).filter(s => ['sorting', 'pasting', 'qc'].includes(s.stage));
    for (let i = 0; i < stages.length; i++) {
      await qc('INSERT INTO job_stages (job_card_id, seq, stage, unit) VALUES ($1,$2,$3,$4)',
        [child.id, i + 1, stages[i].stage, stages[i].unit]);
    }
    await audit('job_card', child.id, 'create_gang_child',
      `${jcNumber} split from ${parent.jc_number} after die cutting`, qc, user);
    childIds.push(child.id);
  }
  await qc(`UPDATE job_cards SET status='split', closed_at=now() WHERE id=$1`, [parent.id]);
  await audit('job_card', parent.id, 'split_after_die_cutting',
    `${childIds.length} child job cards created`, qc, user);
  return childIds;
}

// Job Card finalisation guards — pure so they are unit-testable and reused by
// the finalise/reopen endpoints. `artwork_locked` and `started` are computed
// from joins/queries by the caller.
export function finaliseBlock({ status, finalised_at, artwork_locked }) {
  if (status === 'closed') return 'Closed job cards cannot be finalised';
  if (finalised_at) return 'Job card is already finalised';
  if (!artwork_locked) return 'Artwork must be locked before the job card can be finalised';
  return null;
}

export function reopenBlock({ status, finalised_at, started }) {
  if (!finalised_at) return 'Job card is not finalised';
  if (status === 'closed') return 'Closed job cards cannot be reopened';
  if (started) return 'A stage has already started — reverse the stage instead of reopening the card';
  return null;
}

// ── Sales-order lifecycle guard (pure) ────────────────────────────────
// Close ≠ Cancel. Both are terminal; only an admin may reopen a terminal
// order back to pending. Returns an error message, or null when allowed.
const ORDER_NEXT = {
  pending:   ['hold', 'completed', 'closed', 'cancelled'],
  hold:      ['pending', 'closed', 'cancelled'],
  completed: ['closed', 'pending'],   // pending = reopen (admin only, see below)
  closed:    ['pending'],             // reopen (admin only)
  cancelled: ['pending'],             // reopen (admin only)
};
const ORDER_ADMIN_ONLY = new Set(['completed→pending', 'closed→pending', 'cancelled→pending']);

export function orderTransitionError(from, to, isAdmin = false) {
  if (from === to) return `Order is already ${to}`;
  if (!ORDER_NEXT[from]?.includes(to)) return `Cannot move an order from ${from} to ${to}`;
  if (ORDER_ADMIN_ONLY.has(`${from}→${to}`) && !isAdmin) return 'Only an admin can reopen this order';
  return null;
}

// ── Rollback / delete guard (pure) ────────────────────────────────────
// Given the gathered downstream state of an order line, list every reason it
// cannot be rolled back or deleted. Empty array = safe to proceed.
export function rollbackBlockers({ stages = [], prLinkedToPo = false, fgProduced = false, dispatchedQty = 0 } = {}) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const out = [];
  for (const s of stages.filter(x => x.status !== 'pending')) {
    // Name the STATION, not just the problem. "reverse it first" with no hint of
    // where is the dead end this whole send-back feature existed to remove, and
    // this path kept the old wording after workflow.js was fixed — so rolling a
    // line back to the sales order still told the planner to do something the
    // screen gave them no way to do.
    const st = (s.stage || '').replace(/_/g, ' ');
    // 'hold' reads as "is hold" if it is just de-underscored, so the statuses
    // that need a preposition get one.
    const SAYS = { hold: 'is on hold', in_progress: 'is in progress',
      partially_completed: 'is partly done', completed: 'is completed' };
    const says = SAYS[s.status] || `is ${(s.status || '').replace(/_/g, ' ')}`;
    out.push(`${cap(st)} ${says} — send it back from the ${st} station first`);
  }
  if (prLinkedToPo) out.push('Board already ordered against this line’s requisition — cancel the purchase order first');
  if (fgProduced) out.push('Finished goods already produced for this job — reverse production first');
  if (dispatchedQty > 0) out.push(`${dispatchedQty} pcs already dispatched — cannot roll back or delete`);
  return out;
}

// Force-delete guard (pure). Force skips the "reverse it first" discipline —
// stages, FG produced and un-ordered PRs are all unwound automatically — so
// only what has left the order's own world still blocks: goods that shipped,
// FG reserved by a DIFFERENT order, and a gang shared with lines that are not
// part of the same delete.
export function forceDeleteBlockers({ dispatchedQty = 0, fgReservedElsewhere = false, gangOutsideScope = false } = {}) {
  const out = [];
  if (dispatchedQty > 0) out.push(`${dispatchedQty} pcs already dispatched — cannot delete`);
  if (fgReservedElsewhere) out.push('Finished goods from this job are reserved by another order — release that reservation first');
  if (gangOutsideScope) out.push('This item is ganged with another order’s job — remove it from the gang first');
  return out;
}

// Guard for reversing a printed (completed) printing run back to Triage. Pure —
// mirrors rollbackBlockers so it is unit-testable without a DB. Returns a list
// of human blocker strings; an empty list means the reverse is safe.
export function printReverseBlockers({ printingStatus, jcStatus, downstreamStages = [] } = {}) {
  const cap = s => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
  const out = [];
  if (printingStatus !== 'completed') out.push('Only a printed (completed) run can be reversed');
  if (['closed', 'split'].includes(jcStatus))
    out.push('This job is already closed/split — correct it via FG/job correction instead');
  for (const s of downstreamStages.filter(x => x.status && x.status !== 'pending')) {
    out.push(`Cannot reverse: ${cap((s.stage || '').replace(/_/g, ' '))} is already ${(s.status || '').replace(/_/g, ' ')}`);
  }
  return out;
}

// ── Stage reverse: the ONE hop back (pure) ────────────────────────────
// One hop = one STATION boundary, not one status step. Leaving a station is a
// single move even from 'completed' — the un-complete and the un-start happen
// in the same transaction — because "send printing back to cutting" is one
// intent on the floor, and splitting it into two clicks buys no safety when
// the guard below is what actually protects the chain. Staying AT the station
// to correct its output is the separate 'reopen' move that
// POST /job-stages/:id/reverse already makes.
//
// The guard is the whole point: a station may only be left while everything
// downstream of it is still untouched. That is what makes a job walk back the
// way it came, one station at a time, instead of a mid-chain reverse orphaning
// work that was built on this stage's output. When something downstream has
// started, the blocker NAMES it — the operator's next act is to reverse that,
// not to give up, which is exactly what the old blanket refusal never said.
export function stageReverseMoves({
  stage, status, jcStatus = null, downstreamStages = [], prevStage = null,
  planningTarget = 'print_planning',
} = {}) {
  const label = s => (s || '').replace(/_/g, ' ');
  const blockers = [];

  if (['closed', 'split'].includes(jcStatus))
    blockers.push('This job is already closed/split — correct it via FG/job correction instead');

  // The NEAREST started stage downstream is the one to name: reversing walks
  // back one station at a time, so that stage is the operator's actual next act.
  const built = downstreamStages.filter(s => s.status && s.status !== 'pending');
  if (built.length)
    blockers.push(`${label(built[0].stage)} is already ${label(built[0].status)} — reverse it first`);

  // A pending stage holds nothing. The hop that would move work off it belongs
  // to the station BEFORE it (or, for a first stage, to Print Planning).
  if (status === 'pending')
    blockers.push(`${label(stage)} has not started — there is nothing to send back`);

  if (blockers.length) return { moves: [], blockers };

  // No previous stage means this is where production begins, so "back" leaves
  // the floor entirely and lands in Print Planning.
  const target = prevStage?.stage || planningTarget;
  const moves = [];
  if (status === 'completed')
    moves.push({ hop: 'reopen', target: stage, label: `Reopen ${label(stage)} to correct its output` });
  moves.push({ hop: 'send_back', target, label: `Send back to ${label(target)}` });
  // Off the floor entirely, in one act. Walking a job back one station at a
  // time is the safe MECHANISM; it is not what somebody wants when they have
  // decided the job is wrong. Same guard as send_back — nothing downstream may
  // have started — so this can never orphan work built on this stage's output;
  // it just does every remaining hop in one transaction instead of four clicks.
  moves.push({ hop: 'pull_back', target: 'job_card', label: 'Pull out to the Job Card' });
  return { moves, blockers: [] };
}

// Does this reverse need the plant head's sign-off? (pure)
// A station supervisor handing work back to the station before them is ordinary
// floor traffic and must stay friction-free — the whole point of this feature
// was that reversing was impossible, and a approval prompt on every hop would
// rebuild that wall. Two things are NOT ordinary: moving stock back into the
// warehouse, and taking a job off the floor entirely (back to Print Planning),
// because both change what the rest of the plant is planning against.
export const REVERSE_STOCK_KINDS = new Set(['board_return', 'leftover_unbank', 'extra_sheets_return']);
export function reverseNeedsApprover({ target, items = [] } = {}) {
  // Both of these take the job OFF the floor, which changes what the rest of
  // the plant is planning against — the same reason, so the same gate.
  if (target === 'print_planning' || target === 'job_card') return true;
  return items.some(i => REVERSE_STOCK_KINDS.has(i.kind));
}

// Merge the per-member verdicts of a gang run (pure). A gang is ONE physical
// run spread across several job cards, so a stage may only leave a station if
// EVERY member can leave it — sending one card's printing back while its
// gang-mates stay printed desyncs the run on the floor, which is exactly the
// failure print-planning's reverse already avoids by moving the gang together.
// Blockers are prefixed with the job card that owns them: "reverse it first"
// is useless if the operator cannot tell WHICH card to go to.
export function gangReverseMerge(results = []) {
  const blockers = results
    .filter(r => r.blockers?.length)
    .map(r => `${r.jc_number}: ${r.blockers[0]}`);
  if (blockers.length) return { moves: [], blockers };
  return { moves: results[0]?.moves ?? [], blockers: [] };
}

// What a send_back will undo, itemised (pure). This is BOTH the confirm dialog
// the operator signs off and the audit line written afterwards, so it must
// never claim an effect the reverse does not actually make — an operator who
// reads "1200 sheets returned" and finds 900 stops trusting the whole feature.
// Every quantity here is DOUBLE PRECISION in the DB, so each test is against
// EPS rather than 0: a float hair must not become a phantom sheet to return.
export function reverseManifest({
  isFirstStage = false, boardNet = 0, leftoverBanked = 0, leftoverAvailable = 0,
  qtyScrap = 0, extraIssued = 0, runCount = 0,
} = {}) {
  const EPS = 1e-6;
  const items = [];
  const warnings = [];

  // Only a FIRST stage ever took board from the warehouse (consumeFifo at
  // start). Every later stage receives sheets from the stage before it, so
  // "returning board" there would invent stock that was never issued.
  if (isFirstStage && boardNet > EPS)
    items.push({ kind: 'board_return', qty: boardNet, text: `Return ${boardNet} sheets of board to the warehouse` });

  // An offcut this stage banked may already have been cut into another job.
  // Only what still physically exists can come back; the rest stays consumed
  // and is STATED rather than silently dropped.
  const take = Math.min(leftoverBanked, leftoverAvailable);
  if (take > EPS)
    items.push({ kind: 'leftover_unbank', qty: take, text: `Take back ${take} banked offcut sheets` });
  const gone = leftoverBanked - take;
  if (gone > EPS)
    warnings.push(`${gone} banked offcut sheets were already used by another job and stay consumed`);

  if (qtyScrap > EPS)
    items.push({ kind: 'wastage_reversal', qty: qtyScrap, text: `Reverse ${qtyScrap} sheets of recorded wastage` });

  if (extraIssued > EPS)
    items.push({ kind: 'extra_sheets_return', qty: extraIssued, text: `Return ${extraIssued} extra (XS) sheets` });

  if (runCount > 0)
    items.push({ kind: 'runs_deleted', qty: runCount, text: `Delete ${runCount} day-wise production run(s)` });

  return { items, warnings };
}

// Read-only half of the send_back: resolve the hop, gather every ledger fact
// and build the manifest — WITHOUT touching anything. The confirm dialog runs
// exactly this, so what an operator signs off is computed by the same code
// that then applies it and can never drift from it.
// Compensation inputs for ONE member stage. Split out because a gang run has
// several of them and each card carries its own board, offcut and XS history.
async function stageFacts(st, isFirstStage, qc, oc) {
  // Sheets this CARD took from the warehouse. Extra sheets are issued against
  // the card too (extrasheets.js), so the initial cutting issue is only what
  // remains once every issued XS is set aside — netting the card blindly would
  // hand back the same XS sheets twice.
  const cardRows = await qc(`
    SELECT material_id, batch_id, SUM(qty) AS net, MAX(id) AS last_id FROM stock_movements
    WHERE material_id IS NOT NULL AND batch_id IS NOT NULL
      AND type IN ('consumption','adjustment') AND ref_type='job_card' AND ref_id=$1
    GROUP BY material_id, batch_id HAVING SUM(qty) <> 0
    ORDER BY MAX(id) DESC`, [st.job_card_id]);
  const cardNet = cardRows.reduce((n, r) => n - Number(r.net), 0);
  const xsCard = await oc(
    `SELECT COALESCE(SUM(qty),0)::float AS n FROM extra_sheet_requests
     WHERE job_card_id=$1 AND status='issued'`, [st.job_card_id]);
  const xsStage = await qc(
    `SELECT id, xs_number, qty FROM extra_sheet_requests WHERE job_stage_id=$1 AND status='issued'`, [st.id]);
  const extraIssued = xsStage.reduce((n, x) => n + Number(x.qty), 0);
  const boardNet = isFirstStage ? Math.max(0, cardNet - Number(xsCard.n)) : 0;

  // Banked offcut, and how much of each bank still physically exists.
  const banked = await qc(`
    SELECT sm.material_id, sm.batch_id, sm.qty, sb.qty AS batch_qty
    FROM stock_movements sm JOIN stock_batches sb ON sb.id=sm.batch_id
    WHERE sm.type='leftover_in' AND sm.qty>0 AND sm.ref_type='job_stage' AND sm.ref_id=$1`, [st.id]);
  const leftoverBanked = banked.reduce((n, b) => n + Number(b.qty), 0);
  const leftoverAvailable = banked.reduce((n, b) => n + Math.min(Number(b.qty), Number(b.batch_qty || 0)), 0);

  const runs = await oc('SELECT COUNT(*)::int AS n FROM stage_runs WHERE job_stage_id=$1', [st.id]);
  return {
    st, cardRows, banked, xsStage, boardNet, extraIssued,
    leftoverBanked, leftoverAvailable, runCount: runs.n, qtyScrap: Number(st.qty_scrap || 0),
  };
}

export async function stageReversePlan(stageId, qc = q, oc = one) {
  const st = await oc(`
    SELECT js.*, jc.status AS jc_status, jc.jc_number, jc.product_id, jc.gang_run_id
    FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
    WHERE js.id=$1 FOR UPDATE OF js`, [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });

  // A gang moves as ONE run: the same stage on every card sharing the gang,
  // exactly the member resolution print-planning's reverse uses.
  const memberStages = st.gang_run_id
    ? await qc(`
        SELECT js.*, jc.status AS jc_status, jc.jc_number, jc.product_id, jc.gang_run_id
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE jc.gang_run_id=$1 AND js.stage=$2
        ORDER BY jc.id FOR UPDATE OF js`, [st.gang_run_id, st.stage])
    : [st];

  const results = [];
  for (const m of memberStages) {
    const prev = await previousStage(oc, m);
    const downstream = await qc(
      'SELECT stage, status FROM job_stages WHERE job_card_id=$1 AND seq>$2 ORDER BY seq',
      [m.job_card_id, m.seq]);
    const verdict = stageReverseMoves({
      stage: m.stage, status: m.status, jcStatus: m.jc_status,
      downstreamStages: downstream, prevStage: prev,
    });
    results.push({ jc_number: m.jc_number, ...verdict, prev, m });
  }

  const { moves, blockers } = gangReverseMerge(results);
  if (blockers.length) { const e = new Error(blockers[0]); e.status = 409; e.blockers = blockers; throw e; }
  const move = moves.find(x => x.hop === 'send_back');
  if (!move) throw Object.assign(new Error('This stage cannot be sent back'), { status: 409 });

  const isFirstStage = !results[0].prev;
  const members = [];
  for (const r of results) members.push(await stageFacts(r.m, isFirstStage, qc, oc));

  // ONE manifest for the whole run — a gang is one physical run, so the
  // operator confirms the total effect rather than N partial ones.
  const sum = k => members.reduce((n, x) => n + Number(x[k] || 0), 0);
  const manifest = reverseManifest({
    isFirstStage, boardNet: sum('boardNet'), leftoverBanked: sum('leftoverBanked'),
    leftoverAvailable: sum('leftoverAvailable'), qtyScrap: sum('qtyScrap'),
    extraIssued: sum('extraIssued'), runCount: sum('runCount'),
  });

  return { st, move, manifest, members, gang: !!st.gang_run_id };
}

// Apply a plan: cross ONE station boundary, compensating every ledger effect
// the stage had. Mirrors forceUnwindJobCard's patterns scoped to a single
// stage — the original consumption rows always STAY and a return is a new
// 'adjustment' row, so batch history still adds up afterwards.
export async function sendStageBack(stageId, reason, qc = q, oc = one, user = null) {
  const plan = await stageReversePlan(stageId, qc, oc);
  const { move, manifest, members } = plan;

  // Every member of a gang leaves the station together, each compensating its
  // own card's ledger — one physical run cannot be half-reversed.
  for (const mem of members) {
    const { st, cardRows, banked, xsStage, boardNet, extraIssued } = mem;

    // 1. Board + this stage's XS back to the batches they came from, newest
    //    consumption first (the mirror of the FIFO that issued them).
    let owed = boardNet + extraIssued;
    for (const rr of cardRows) {
      if (owed <= 1e-6) break;
      const taken = -Number(rr.net);
      if (taken <= 0) continue;
      const back = Math.min(taken, owed);
      const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [rr.batch_id]);
      const newQty = Number(b?.qty || 0) + back;
      await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
        [newQty, newQty <= 0 ? 'exhausted' : 'available', rr.batch_id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'adjustment',$3,'job_card',$4,$5)`,
        [rr.material_id, rr.batch_id, back, st.job_card_id,
          `Returned — ${st.jc_number} ${st.stage} sent back to ${move.target} — ${reason}`]);
      owed -= back;
    }
    for (const x of xsStage) {
      await qc('UPDATE extra_sheet_requests SET status=\'cancelled\', reject_reason=$1 WHERE id=$2',
        [`Stage sent back to ${move.target} — ${reason}`, x.id]);
      await audit('extra_sheet_request', x.id, 'cancelled_by_reverse',
        `${x.xs_number} — ${x.qty} sheets returned`, qc, user);
    }

    // 2. Cutting-variance true-ups booked against THIS stage: post the inverse,
    //    whichever way they went (an over-cut took sheets, an under-cut gave some back).
    const stageRows = await qc(`
      SELECT material_id, batch_id, SUM(qty) AS net FROM stock_movements
      WHERE material_id IS NOT NULL AND batch_id IS NOT NULL
        AND type IN ('consumption','adjustment') AND ref_type='job_stage' AND ref_id=$1
      GROUP BY material_id, batch_id HAVING SUM(qty) <> 0`, [st.id]);
    for (const rr of stageRows) {
      const back = -Number(rr.net);
      const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [rr.batch_id]);
      const newQty = Number(b?.qty || 0) + back;
      await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
        [newQty, newQty <= 0 ? 'exhausted' : 'available', rr.batch_id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'adjustment',$3,'job_stage',$4,$5)`,
        [rr.material_id, rr.batch_id, back, st.id, `Variance reversed — ${st.jc_number} — ${reason}`]);
    }

    // 3. Take back the offcut this stage banked, as far as it still exists —
    //    strips already cut into another job stay consumed (the manifest warns).
    for (const lo of banked) {
      const take = Math.min(Number(lo.batch_qty || 0), Number(lo.qty));
      if (take <= 1e-6) continue;
      const newQty = Number(lo.batch_qty) - take;
      await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
        [newQty, newQty <= 0 ? 'exhausted' : 'available', lo.batch_id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'adjustment',$3,'job_stage',$4,$5)`,
        [lo.material_id, lo.batch_id, -take, st.id, `Leftover unbanked — ${st.jc_number} — ${reason}`]);
    }

    // 4. Wastage the stage recorded comes back out of the wastage ledger.
    if (Number(st.qty_scrap || 0) > 0) {
      await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,'wastage_reversal',$2,'job_stage',$3,$4)`,
        [st.product_id, st.qty_scrap, st.id, `${st.stage} sent back — ${reason}`]);
    }

    // 5. Registers belonging to the run itself. Runs would otherwise survive
    //    (only a stage DELETE cascades) and corrupt the running-balance ceiling.
    await qc('DELETE FROM stage_runs WHERE job_stage_id=$1', [st.id]);
    await qc('DELETE FROM packing_lines WHERE job_stage_id=$1', [st.id]);
    await qc('DELETE FROM pasting_rows WHERE job_stage_id=$1', [st.id]);
    await qc('DELETE FROM cutting_discrepancies WHERE job_stage_id=$1', [st.id]);

    // 6. The stage itself, back to untouched. floor_pos goes with it: it is a
    //    manual override of floor order, and a stage that is no longer on the
    //    floor must rank naturally again when it returns.
    await qc(`
      UPDATE job_stages SET status='pending',
        qty_in=NULL, qty_out=NULL, qty_scrap=0, scrap_reason=NULL, hold_reason=NULL,
        qty_accepted=NULL, qty_rejected=NULL, qty_rework=NULL, inspector=NULL, remarks=NULL,
        pack_boxes=NULL, pack_qty_per_box=NULL,
        operator=NULL, machine_id=NULL, line_clearance=NULL, floor_pos=NULL,
        started_at=NULL, completed_at=NULL
      WHERE id=$1`, [st.id]);

    // 7. A card with nothing running anywhere is 'open' again, and the tools it
    //    holds go back to the rack — the same move the printing auto-return makes.
    const active = await oc(
      'SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND status <> \'pending\'', [st.job_card_id]);
    if (active.n === 0) {
      await qc('UPDATE job_cards SET status=\'open\' WHERE id=$1 AND status=\'in_progress\'', [st.job_card_id]);
      const returned = await qc(`
        UPDATE tools SET zone='in_rack', zone_since=now(),
          issued_at=NULL, issued_machine_id=NULL, issued_operator=NULL, issued_job_card_id=NULL
        WHERE issued_job_card_id=$1 RETURNING id`, [st.job_card_id]);
      for (const t of returned) {
        await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                  VALUES ($1,'returned','on_floor','in_rack',$2,$3)`,
          [t.id, `${st.jc_number} sent back to ${move.target} — ${reason}`, user]);
      }
    }

    await audit('job_stage', st.id, 'sent_back',
      `${st.stage} → ${move.target} (was ${st.status}) — ${reason}`, qc, user);
  }

  // One card-level line carrying the TOTAL effect, so the timeline reads as the
  // single act it was rather than N unrelated stage entries.
  const lead = plan.st;
  const summary = manifest.items.map(i => i.text).join(' · ') || 'nothing to compensate';

  // Tell the station that just inherited the work. Nobody watches a queue for
  // a job to reappear in it, so without this the handover is silent and the
  // sheets sit there. Print Planning is not a section, so it routes to planners.
  const crew = move.target === 'print_planning'
    ? await qc("SELECT id FROM users WHERE active=1 AND role IN ('planner','admin')")
    : await qc('SELECT id FROM users WHERE active=1 AND sections @> $1::jsonb',
      [JSON.stringify([move.target])]);
  await notify(crew.map(u => u.id), {
    kind: 'stage_sent_back',
    title: `${lead.jc_number} is back at ${move.target.replace(/_/g, ' ')}`,
    body: `Sent back from ${lead.stage.replace(/_/g, ' ')} by ${user || 'the floor'} — ${reason}`,
    link: move.target === 'print_planning' ? '/print-planning' : `/section/${move.target}`,
    refTable: 'job_cards', refId: lead.job_card_id,
  }, qc);

  // Leave the note on the record's own thread if one exists. Deliberately does
  // NOT create a thread: creating one has membership consequences, and a
  // reverse is not a reason to start a conversation nobody asked for.
  const conv = await oc(
    `SELECT id FROM conversations
     WHERE job_card_id=$1 OR (entity='job_cards' AND entity_id=$1) LIMIT 1`, [lead.job_card_id]);
  if (conv) {
    await qc(`INSERT INTO messages (conversation_id, sender_id, sender_name, kind, body)
              VALUES ($1, NULL, $2, 'system', $3)`,
      [conv.id, user || 'System',
        `${lead.stage.replace(/_/g, ' ')} sent back to ${move.target.replace(/_/g, ' ')} — ${reason}`]);
  }

  await audit('job_card', lead.job_card_id, 'sent_back',
    `${lead.stage} → ${move.target}${plan.gang ? ` · whole gang (${members.length} cards)` : ''} — ${summary} — ${reason}`,
    qc, user);
  return {
    ok: true, from: lead.stage, target: move.target, wasStatus: lead.status,
    jc_number: lead.jc_number, cards: members.length, gang: plan.gang, ...manifest,
  };
}

// Guard for editing a print-planning queue entry in place. Pure. Returns an
// error string when editing is not allowed, else null. Editing is only safe
// while the printing stage has not started and the card is open + not finalised
// — the same rule PUT /job-cards enforces.
export function printQueueEditBlock({ printingStatus, jcStatus, finalised = false } = {}) {
  if (jcStatus === 'closed') return 'Closed job cards cannot be edited';
  if (finalised) return 'This job card is finalised. Reopen it before editing.';
  if (['in_progress', 'hold', 'completed'].includes(printingStatus))
    return 'Reverse this run to edit — printing has already started.';
  return null;
}

// Undo a planning-time FG reservation on a line: restore each lot's consumed
// qty, post a compensating warehouse ledger entry, drop the consumption rows,
// and zero the line's reserved figure. Safe to call when there is none.
export async function releaseFgReservation(lineId, qc = q, oc = one, user = null) {
  const cons = await qc(
    `SELECT fc.id, fc.qty, fc.fg_lot_id, fl.lot_number, fl.product_id
     FROM fg_consumptions fc JOIN fg_lots fl ON fl.id = fc.fg_lot_id
     WHERE fc.order_line_id = $1`, [lineId]);
  if (!cons.length) return;
  const line = await oc('SELECT order_id FROM order_lines WHERE id=$1', [lineId]);
  const ord = line ? await oc('SELECT customer_id FROM orders WHERE id=$1', [line.order_id]) : null;
  for (const c of cons) {
    await qc(`UPDATE fg_lots
              SET consumed_qty = GREATEST(0, consumed_qty - $1),
                  status = CASE WHEN status='consumed' THEN 'verified' ELSE status END
              WHERE id=$2`, [c.qty, c.fg_lot_id]);
    await fgMove({
      ref_number: c.lot_number, fg_lot_id: c.fg_lot_id, product_id: c.product_id,
      order_line_id: lineId, order_id: line?.order_id, customer_id: ord?.customer_id,
      qty_in: c.qty, movement_type: 'manual_adjustment', source_module: 'planning',
      created_by: user, remarks: 'FG reservation released on rollback/delete',
    }, qc, oc);
  }
  await qc('DELETE FROM fg_consumptions WHERE order_line_id=$1', [lineId]);
  await qc('UPDATE order_lines SET fg_consumed_qty=0 WHERE id=$1', [lineId]);
  await audit('order_line', lineId, 'fg_reservation_released', `${cons.length} lot reservation(s)`, qc, user);
}

// Force-unwind one job card, whatever state it is in: every ledger effect the
// job had on the plant is compensated, then the card and its stages are
// removed. Used only by the force-delete path — the caller has already shown
// the operator what will be reversed and taken an explicit confirmation.
//   • board/material the job consumed (issue, extra sheets, cut variance)
//     returns to the warehouse batches it came from, as 'adjustment' rows —
//     the original consumption rows stay, so batch history still adds up
//   • banked leftover offcuts are taken back (as far as they still exist)
//   • production wastage rows are removed with the stages they belonged to
//   • FG receipts are reversed out of fg_stock; FG lots born from this job
//     are zeroed in the FG ledger and deleted
//   • issued tools (shade cards, dies) return to the vault
//   • cutting variances, extra-sheet requests, pasting/packing rows go with
//     the stages
export async function forceUnwindJobCard(jcId, reason, qc = q, oc = one, user = null) {
  const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [jcId]);
  if (!jc) return null;
  const stages = await qc('SELECT id, stage, status FROM job_stages WHERE job_card_id=$1', [jc.id]);
  const stageIds = stages.map(s => s.id);
  const active = stages.filter(s => s.status !== 'pending').map(s => s.stage);
  const why = reason || 'order force-deleted';

  // Tools still out against this job return to the rack (same move the
  // printing auto-return makes), with a tool event for the register.
  const returnedTools = await qc(`
    UPDATE tools SET zone='in_rack', zone_since=now(),
      issued_at=NULL, issued_machine_id=NULL, issued_operator=NULL, issued_job_card_id=NULL
    WHERE issued_job_card_id=$1 RETURNING id`, [jc.id]);
  for (const t of returnedTools) {
    await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
              VALUES ($1,'returned','on_floor','in_rack',$2,$3)`,
      [t.id, `Job ${jc.jc_number} force-deleted — ${why}`, user]);
  }

  // Net material take per batch (issue + extra sheets + cut-variance true-ups)
  // and hand it back where it came from.
  const nets = await qc(`
    SELECT material_id, batch_id, SUM(qty) AS net FROM stock_movements
    WHERE material_id IS NOT NULL AND batch_id IS NOT NULL
      AND type IN ('consumption','adjustment')
      AND ((ref_type='job_card' AND ref_id=$1) OR (ref_type='job_stage' AND ref_id=ANY($2::int[])))
    GROUP BY material_id, batch_id HAVING SUM(qty) <> 0`, [jc.id, stageIds]);
  let sheetsReturned = 0;
  for (const n of nets) {
    const back = -Number(n.net);                       // consumed nets are negative
    const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [n.batch_id]);
    const newQty = Number(b?.qty || 0) + back;
    await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
      [newQty, newQty === 0 ? 'exhausted' : 'available', n.batch_id]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,'job_card',$4,$5)`,
      [n.material_id, n.batch_id, back, jc.id, `Returned — ${jc.jc_number} ${why}`]);
    if (back > 0) sheetsReturned += back;
  }

  // Take back leftover offcuts this job banked, as far as they still exist —
  // strips already consumed by another job stay consumed. Covers both the
  // cutting-time bank (ref_type='job_stage') and the plan-lock bank / true-up
  // (ref_type='order_line', keyed to this card's line).
  const banked = await qc(`
    SELECT material_id, batch_id, qty FROM stock_movements
    WHERE type='leftover_in' AND qty > 0
      AND ((ref_type='job_stage' AND ref_id=ANY($1::int[]))
           OR (ref_type='order_line' AND ref_id=$2))`, [stageIds, jc.order_line_id || 0]);
  for (const lo of banked) {
    const b = await oc('SELECT qty FROM stock_batches WHERE id=$1 FOR UPDATE', [lo.batch_id]);
    const take = Math.min(Number(b?.qty || 0), Number(lo.qty));
    if (take <= 0) continue;
    const newQty = Number(b.qty) - take;
    await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
      [newQty, newQty === 0 ? 'exhausted' : 'available', lo.batch_id]);
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,'job_card',$4,$5)`,
      [lo.material_id, lo.batch_id, -take, jc.id, `Leftover unbanked — ${jc.jc_number} ${why}`]);
  }

  // Reverse the FG receipt out of product stock, then drop the receipt rows —
  // both sides of that entry vanish with the job.
  const fgIn = await oc(`
    SELECT COALESCE(SUM(qty),0)::int AS n FROM stock_movements
    WHERE type='fg_receipt' AND ref_type='job_card' AND ref_id=$1`, [jc.id]);
  if (fgIn.n !== 0) {
    await qc(`UPDATE fg_stock SET qty = qty - $1 WHERE product_id=$2`, [fgIn.n, jc.product_id]);
    await qc(`DELETE FROM stock_movements WHERE type='fg_receipt' AND ref_type='job_card' AND ref_id=$1`, [jc.id]);
  }

  // FG lots born from this batch: zero them in the FG ledger and remove them.
  // The caller has already blocked when another order holds a reservation.
  const lots = await qc('SELECT * FROM fg_lots WHERE job_card_id=$1', [jc.id]);
  for (const lot of lots) {
    const remaining = Math.max(0, Number(lot.qty) - Number(lot.consumed_qty || 0));
    if (remaining > 0) {
      await fgMove({
        ref_number: lot.lot_number, fg_lot_id: lot.id, product_id: lot.product_id,
        qty_out: remaining, movement_type: 'manual_adjustment', source_module: 'warehouse',
        created_by: user, remarks: `Lot removed — ${jc.jc_number} ${why}`,
      }, qc, oc);
    }
    await qc('UPDATE fg_movements SET fg_lot_id=NULL WHERE fg_lot_id=$1', [lot.id]);
    await qc('DELETE FROM fg_consumptions WHERE fg_lot_id=$1', [lot.id]);
    await qc('DELETE FROM fg_lots WHERE id=$1', [lot.id]);
  }

  // Registers that hang off the stages/card, then the stages and the card.
  // (pasting_rows / packing_lines cascade with their job_stage.)
  await qc(`DELETE FROM stock_movements WHERE type IN ('wastage','wastage_reversal')
            AND ref_type='job_stage' AND ref_id=ANY($1::int[])`, [stageIds]);
  await qc('DELETE FROM cutting_discrepancies WHERE job_card_id=$1', [jc.id]);
  await qc('DELETE FROM extra_sheet_requests WHERE job_card_id=$1', [jc.id]);
  await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
  await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
  await audit('job_card', jc.id, 'force_deleted',
    `${jc.jc_number} — ${active.length ? `reversed ${active.join(', ')}` : 'no stage had started'}${sheetsReturned ? ` · ${sheetsReturned} sheets returned` : ''} — ${why}`,
    qc, user);
  return { jc_number: jc.jc_number, reversedStages: active, sheetsReturned, lotsRemoved: lots.length };
}

// Unwind every artifact derived from an order line, guarded. mode 'rollback'
// keeps the line and resets it to 'pending'; mode 'delete' also removes the
// line from the sales order. Throws {status:409, blockers:[...]} if unsafe.
// `force` (delete mode only) skips the started-production guards: stages are
// reversed and every derived record removed via forceUnwindJobCard. Dispatched
// quantity and FG reserved by ANOTHER order still block — those have left the
// order's own world. `scopeLineIds`, when given, is the set of line ids being
// deleted in the same operation; a ganged line whose gang-mates fall outside
// that set blocks, so a shared gang run is never half-destroyed.
export async function rollbackLine({ lineId, mode = 'rollback', note = null, force = false, scopeLineIds = null }, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }

  const jc = await oc('SELECT * FROM job_cards WHERE order_line_id=$1', [lineId]);
  const stages = jc ? await qc('SELECT stage, status FROM job_stages WHERE job_card_id=$1', [jc.id]) : [];
  const prPo = await oc(
    `SELECT COUNT(*)::int AS n FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NOT NULL`, [lineId]);
  const fgProd = jc ? await oc('SELECT COUNT(*)::int AS n FROM fg_lots WHERE job_card_id=$1', [jc.id]) : { n: 0 };

  const forcing = force && mode === 'delete';
  const blockers = forcing
    ? forceDeleteBlockers({
        dispatchedQty: +line.dispatched_qty || 0,
        fgReservedElsewhere: jc ? (await oc(
          `SELECT COUNT(*)::int AS n FROM fg_consumptions fc
           JOIN fg_lots fl ON fl.id = fc.fg_lot_id
           WHERE fl.job_card_id=$1 AND fc.order_line_id <> $2`, [jc.id, lineId])).n > 0 : false,
        gangOutsideScope: !!(line.gang_run_id && scopeLineIds
          && (await qc('SELECT id FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]))
             .some(m => !scopeLineIds.has(m.id))),
      })
    : rollbackBlockers({
        stages, prLinkedToPo: prPo.n > 0, fgProduced: fgProd.n > 0, dispatchedQty: +line.dispatched_qty || 0,
      });
  if (blockers.length) { const e = new Error(blockers[0]); e.status = 409; e.blockers = blockers; throw e; }

  // 1. Release any planning-time FG reservation.
  await releaseFgReservation(lineId, qc, oc, user);

  // 2. Remove the job card and its stages — force-unwound (ledgers
  //    compensated) under force; straight delete for the all-pending card.
  if (jc && forcing) {
    await forceUnwindJobCard(jc.id, note || 'order force-deleted', qc, oc, user);
  } else if (jc) {
    await qc('DELETE FROM job_stages WHERE job_card_id=$1', [jc.id]);
    await qc('DELETE FROM job_cards WHERE id=$1', [jc.id]);
    await audit('job_card', jc.id, 'deleted_by_rollback', jc.jc_number, qc, user);
  }

  // 3. Delete a line-raised PR that never became a PO. Under force, a PR that
  //    already became a PO is detached instead — the procurement paper trail
  //    (PO, GRN, stock) survives the order.
  await qc('DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL', [lineId]);
  if (forcing && prPo.n > 0) {
    await qc('UPDATE requisitions SET order_line_id=NULL WHERE order_line_id=$1', [lineId]);
    await audit('order_line', lineId, 'pr_detached',
      `${prPo.n} requisition(s) detached from deleted line — purchase order kept`, qc, user);
  }

  // 4. Leave any gang: clear the link and dissolve a gang left with <2 members.
  //    Under force, any gang job cards still bound to the run (the parent, or
  //    children of lines not yet processed in this same delete) are unwound
  //    before the run row goes.
  if (line.gang_run_id) {
    await qc('UPDATE order_lines SET gang_run_id=NULL WHERE id=$1', [lineId]);
    const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
    if (left.n < 2) {
      await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [line.gang_run_id]);
      if (forcing) {
        const bound = await qc('SELECT id FROM job_cards WHERE gang_run_id=$1 ORDER BY parent_job_card_id NULLS LAST', [line.gang_run_id]);
        for (const b of bound) await forceUnwindJobCard(b.id, note || 'order force-deleted', qc, oc, user);
      }
      await qc('DELETE FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    }
  }

  // 5. Reset all planning/artwork/tooling locks on the line, and take back any
  //    still-planned (LO-PLAN-) board offcut this line banked at plan-lock.
  await unbankPlanningLeftover(lineId, qc, oc, user, mode === 'delete' ? 'line deleted' : 'line rolled back');
  // The mix's ups/covers are frozen against the exact cut plan step 5 is
  // erasing (sheets_required/parent_sheets_required go back to NULL right
  // below), so it cannot survive either mode. For 'rollback' this is the
  // whole fix — the line lives on with a stale mix and an active hold nobody
  // can reach otherwise. For 'delete' the row (and job_board_mix with it) is
  // gone a few lines down regardless via ON DELETE CASCADE, but clearing here
  // first still matters: it releases the mirrored board_allocations hold with
  // a proper reason on record, rather than letting the row vanish silently
  // with the cascade as the only trace.
  await clearMixPlan(lineId, qc, user, mode === 'delete' ? 'line deleted' : 'line rolled back — cut plan voided');
  await qc(`UPDATE order_lines SET
              machine_id=NULL, planned_date=NULL, sheets_required=NULL, parent_sheets_required=NULL,
              wastage_sheets=NULL, spec_override=NULL, leftover_plan=NULL,
              tooling_ok=0, artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0
            WHERE id=$1`, [lineId]);

  if (mode === 'delete') {
    // Null out nullable FK references so the line row can be removed.
    await qc('UPDATE fg_movements SET order_line_id=NULL WHERE order_line_id=$1', [lineId]);
    await qc('UPDATE fg_lots SET order_line_id=NULL WHERE order_line_id=$1', [lineId]);
    await audit('order_line', lineId, 'deleted_entirely', note || `Removed from sales order (was ${line.status})`, qc, user);
    await qc('DELETE FROM order_lines WHERE id=$1', [lineId]);
    return { ok: true, mode, deleted: true, message: 'Item deleted from all stations' };
  }

  await forceLineStatus(lineId, 'pending', note || 'Rolled back to sales order', qc, oc, user);
  await audit('order_line', lineId, 'rolled_back_to_sales_order', note || `was ${line.status}`, qc, user);
  return { ok: true, mode, deleted: false, message: 'Item rolled back to the sales order' };
}

// Pull a job OFF the floor in one act and hand it back to the Job Card station,
// editable. Every ledger effect is compensated by sendStageBack — this only adds
// the un-planning on top, so there is exactly one place that knows how to give
// board back and it is not duplicated here.
//
// "At the Job Card station" is a real state, not a label: PUT /job-cards/:id
// refuses while finalised_at is set, so clearing it IS what makes the card
// editable again. reopenBlock allows that only once no stage has started, which
// is precisely what sendStageBack has just arranged.
export async function pullBackToJobCard(stageId, reason, qc = q, oc = one, user = null) {
  const out = await sendStageBack(stageId, reason, qc, oc, user);
  const jc = await oc('SELECT id, jc_number, order_line_id, gang_run_id, machine_id FROM job_cards WHERE id=(SELECT job_card_id FROM job_stages WHERE id=$1)', [stageId]);
  if (!jc) return out;

  // The whole gang comes off together — it is one physical run, and a card left
  // finalised on the board while its mates are being edited is the desync
  // sendStageBack already refuses to create.
  const cards = jc.gang_run_id
    ? await qc('SELECT id, order_line_id FROM job_cards WHERE gang_run_id=$1', [jc.gang_run_id])
    : [{ id: jc.id, order_line_id: jc.order_line_id }];

  for (const c of cards) {
    await qc(`UPDATE job_cards SET finalised_at=NULL, machine_id=NULL, queue_pos=NULL,
              status=CASE WHEN status='in_progress' THEN 'open' ELSE status END
              WHERE id=$1`, [c.id]);
    // The planning board reads the press off the LINE too; leaving it set shows
    // a job still assigned to a press it is no longer on.
    if (c.order_line_id) await qc('UPDATE order_lines SET machine_id=NULL WHERE id=$1', [c.order_line_id]);
    await audit('job_card', c.id, 'pulled_to_job_card',
      `Pulled off the floor from ${out.from} — reopened for editing — ${reason}`, qc, user);
  }

  // Whoever owns the Job Card station is the one who has to act on it now.
  const planners = await qc("SELECT id FROM users WHERE active=1 AND role IN ('planner','admin')");
  await notify(planners.map(u => u.id), {
    kind: 'stage_sent_back',
    title: `${jc.jc_number} pulled back to the Job Card`,
    body: `Off the floor from ${out.from} by ${user || 'the plant'} — ${reason}`,
    link: '/job-cards', refTable: 'job_cards', refId: jc.id,
  }, qc);

  return { ...out, target: 'job_card', cards: cards.length, reopened: true };
}

// ─── Day-wise production run log ─────────────────────────────────────────

// Re-derive job_stages.qty_out / qty_scrap from the run log. Called after every
// run insert, edit or delete. A stage with no runs is left alone — that is a
// stage that has not produced yet, not a stage that produced zero.
export async function recalcStageFromRuns(qc, oc, stageId) {
  const runs = await qc(
    'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1 ORDER BY run_date, seq',
    [stageId]
  );
  if (!runs.length) return null;
  const roll = rollupRuns(runs);
  await qc('UPDATE job_stages SET qty_out=$1, qty_scrap=$2 WHERE id=$3',
    [roll.qty_good, roll.qty_scrap, stageId]);
  return roll;
}

// The ONE previous-stage lookup. Nearest earlier stage on the same job card,
// skipping QC — QC inspects, it does not hand material on. Every caller uses
// this rather than reaching for seq−1 directly: a routing is built contiguously
// today, but "the stage before this one" is the actual intent, and a single
// definition is what keeps the floor board, the cap and the completion gate
// from drifting apart.
export async function previousStage(oc, stage) {
  return oc(
    `SELECT * FROM job_stages
      WHERE job_card_id=$1 AND seq < $2 AND stage <> 'qc'
      ORDER BY seq DESC LIMIT 1`,
    [stage.job_card_id, stage.seq]
  );
}

// Everything about what a stage has received, gathered once: the previous
// stage, the extra sheets issued to it, the received quantity in ITS unit, and
// the running-balance ceiling. The decision logic is the pure stageReceived() /
// availableCeiling() pair in stage-runs.js — this is just the DB gather, and it
// is the only place the two are computed, so the figure a station is SHOWN and
// the figure it is ALLOWED to record can never come apart again.
//
// While a stage is open its receipt is live: the previous stage keeps counting
// day by day and this figure follows it. Completing the stage stamps that same
// live figure onto qty_in, and from then on the stamp is the record — a closed
// run keeps the input it actually closed against.
export async function stageReceipt(oc, stageId) {
  const st = await oc('SELECT * FROM job_stages WHERE id=$1', [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });

  const prev = await previousStage(oc, st);
  const jc = await oc(
    `SELECT jc.children_per_parent, p.ups FROM job_cards jc
     JOIN products p ON p.id = jc.product_id WHERE jc.id=$1`, [st.job_card_id]);
  const issued = await oc(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM extra_sheet_requests WHERE job_stage_id=$1 AND status='issued'`,
    [stageId]
  );

  const r = receiptFor({
    stage: st, prev, ups: jc.ups,
    childrenPerParent: jc.children_per_parent,
    extraParents: issued.qty,
  });
  return { stage: st, prev, extraIssued: r.extra_issued, ...r };
}

// The running-balance ceiling on its own — what a stage may still consume.
// Null means uncapped (cutting's own over/under-cut variance flow, and a first
// stage whose input is still deferred).
export async function upstreamAvailable(oc, stageId) {
  return (await stageReceipt(oc, stageId)).ceiling;
}

// A printing run started on a press other than the one Print Planning assigned.
// Legitimate — a press breaks down, the load gets rebalanced — but never silent:
// the planning board still shows the old press, so the switch is audited.
// Only printing has a planned press (job_cards.machine_id).
export const pressOverride = (stage, plannedId, startedId) =>
  stage === 'printing' && plannedId != null && startedId != null
  && Number(plannedId) !== Number(startedId);
