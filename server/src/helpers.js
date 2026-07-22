// ─── Shared business logic: state machine, stock ledger, routing ────────────
import { q, one } from './db.js';
import { toolingDetail, toolingGateOk } from './tooling-gate.js';
import { rollupRuns, availableCeiling } from './stage-runs.js';

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

// Sheets needed for an order line (qty cartons → child print sheets incl. wastage).
// Wastage is planned in absolute CHILD SHEETS (plant default 150); the legacy
// percentage on the product master is only the fallback when no sheet figure
// was captured on the line.
export const DEFAULT_WASTAGE_SHEETS = 150;

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

export async function availableQty(materialId, oc = one) {
  const r = await oc(
    `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`,
    [materialId]);
  return r.q;
}

// Consume material FIFO across available batches. Ledger rows in same tx.
export async function consumeFifo(materialId, qty, refType, refId, note, qc, oc) {
  let remaining = qty;
  const batches = await qc(
    `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
    [materialId]);
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty, remaining);
    const newQty = b.qty - take;
    await qc('UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3',
      [newQty, newQty === 0 ? 'exhausted' : 'available', b.id]);
    await qc(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
       VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
      [materialId, b.id, -take, refType, refId, note]);
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

export async function fgReceipt(productId, qty, refType, refId, qc) {
  await qc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
            ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + EXCLUDED.qty`, [productId, qty]);
  await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
            VALUES ($1,'fg_receipt',$2,$3,$4)`, [productId, qty, refType, refId]);
}

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

export async function readiness(line, oc = one) {
  const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
  const product = effectiveProduct(master, line);
  const board = await oc('SELECT * FROM materials WHERE id=$1', [product.board_material_id]);
  const parent = effectiveParent(product, board);
  const needed = line.sheets_required ?? sheetsRequired(product, netProduceQty(line), line.wastage_sheets);
  const fit = childFit(parent, product);
  const parentNeeded = line.parent_sheets_required ?? parentSheetsRequired(needed, fit.count);
  const available = await availableQty(product.board_material_id, oc);
  // Tooling: every physical tool linked to this product (the die also links
  // via products.tool_id). Hard/soft semantics live in tooling-gate.js.
  const toolsRow = await oc(`
    SELECT COALESCE(json_agg(t ORDER BY t.id), '[]'::json) AS list
    FROM tools t WHERE t.product_id = $1 OR t.id = $2`,
    [line.product_id, product.tool_id ?? -1]);
  const detail = toolingDetail(product, toolsRow.list);
  // Shade card: lives in the Shade Card Management module now, not the Tooling
  // Hub. Folded into the detail with the same soft semantics so the Tooling
  // chip keeps showing it: registered but rejected/expired blocks softly;
  // untracked informs; approved (or in-flight) reads ready enough for the
  // job-card gate — the real production stop happens at printing start.
  const shade = await oc(`
    SELECT sc_number, status, revision_no, creation_date FROM shade_cards
    WHERE product_id=$1 AND active=1 AND status NOT IN ('superseded','archived')
    ORDER BY id DESC LIMIT 1`, [line.product_id]);
  const shadeBad = shade && (['rejected', 'revision_requested', 'expired'].includes(shade.status)
    || (Date.parse(shade.creation_date) && (Date.now() - Date.parse(shade.creation_date)) / 86400000 >= SHADE_CARD_LIFE_DAYS));
  detail.push({
    family: 'shade_card', label: 'Shade Card', hard: false,
    status: !shade ? 'missing' : shadeBad ? 'not_ready' : 'ready',
    tool_id: null, code: shade?.sc_number ?? null, zone: shade?.status ?? null,
    condition: shade ? `Rev ${shade.revision_no}` : null,
  });
  const dieDetail = detail.find(x => x.family === 'die');
  // Incoming supply for this board: open PRs plus undelivered PO balance.
  const incoming = await oc(`
    SELECT COALESCE((SELECT SUM(qty) FROM requisitions
                     WHERE material_id=$1 AND status IN ('pending','approved')),0)::int
         + COALESCE((SELECT SUM(GREATEST(0, pl.qty - COALESCE(pl.received_qty,0)))
                     FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
                     WHERE pl.material_id=$1 AND po.status IN ('open','partially_received')),0)::int AS qty`,
    [product.board_material_id]);
  const materialOk = available >= parentNeeded;
  return {
    artwork: !!line.artwork_locked,
    tooling: toolingGateOk(detail, line.tooling_ok),
    tooling_detail: detail,
    die_number: dieDetail?.code || null,
    die_condition: dieDetail?.condition || null,
    material: materialOk,
    material_pending: !materialOk && incoming.qty > 0,
    incoming_sheets: incoming.qty,
    needed_sheets: needed,                 // child print sheets
    parent_needed: parentNeeded,           // parent sheets to issue
    children_per_parent: fit.count,
    parent_size: fit.sized ? `${parent.sheet_l}×${parent.sheet_w}"` : null,
    child_size: fit.sized ? `${product.child_l}×${product.child_w}"` : null,
    cut_waste_pct: fit.waste_pct,
    available_sheets: available,           // parent sheets in stock
    board_material_id: product.board_material_id,
  };
}

export async function createJobCardForLine(lineId, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }

  if (line.gang_run_id) return createJobCardForGang(line.gang_run_id, qc, oc, user);

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
  const short = Math.max(0, gate.parent_needed - gate.available_sheets);
  const blocked = [];
  if (!gate.artwork) blocked.push('artwork not locked');
  // Tooling is a soft signal, not a hard gate: a job card can be pushed with a
  // die / plate / block / shade card still not ready. The Tooling chip keeps it
  // visible and line clearance still gates the actual stage start on the floor.
  // Shortage with a PR/PO already raised passes softly — the card carries a
  // board-pending alarm and cutting cannot start until the board arrives.
  if (!gate.material && !gate.material_pending)
    blocked.push(`board short by ${short} parent sheets — raise a PR to proceed`);
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
  if (!gate.material) pending.push(`board pending (short ${short} parent sheets, supply on order)`);
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
    const short = Math.max(0, gate.parent_needed - gate.available_sheets);
    if (!gate.artwork) blocked.push(`line ${line.id}: artwork not locked`);
    // Tooling is a soft signal (see createJobCardForLine) — never blocks the push.
    if (!gate.material && !gate.material_pending)
      blocked.push(`line ${line.id}: board short by ${short} parent sheets`);
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
    out.push(`${cap((s.stage || 'A').replace(/_/g, ' '))} stage is ${(s.status || '').replace(/_/g, ' ')} — reverse it first`);
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

// The running-balance ceiling: what the previous stage has cumulatively
// produced, plus anything CI-XS has issued straight to this stage (extra
// sheets never pass through the previous stage's own qty_out, so they'd
// otherwise be invisible here and CI-XS top-ups would get wrongly rejected
// as "exceeds available input"). All the decision logic lives in the pure
// availableCeiling() in stage-runs.js — this is just the DB gather.
export async function upstreamAvailable(oc, stageId) {
  const st = await oc('SELECT id, job_card_id, seq, stage, qty_in FROM job_stages WHERE id=$1', [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
  if (st.stage === 'cutting') return availableCeiling({ isCutting: true });

  const prev = await oc(
    `SELECT qty_out FROM job_stages
      WHERE job_card_id=$1 AND seq < $2 AND stage <> 'qc'
      ORDER BY seq DESC LIMIT 1`,
    [st.job_card_id, st.seq]
  );

  const jc = await oc('SELECT children_per_parent FROM job_cards WHERE id=$1', [st.job_card_id]);
  const issued = await oc(
    `SELECT COALESCE(SUM(qty),0)::int AS qty FROM extra_sheet_requests WHERE job_stage_id=$1 AND status='issued'`,
    [stageId]
  );
  // Same unit conversion the issue endpoint applies (extrasheets.js): cutting
  // counts parent sheets as-is, every later sheet stage counts child sheets.
  // Cutting is already handled above, so this is always the child-sheet leg.
  const extraIssued = issued.qty * Math.max(1, jc.children_per_parent || 1);

  return availableCeiling({
    isCutting: false,
    prevExists: !!prev,
    prevQtyOut: prev ? prev.qty_out : null,
    ownQtyIn: st.qty_in,
    extraIssued,
  });
}
