// ─── Shared business logic: state machine, stock ledger, routing ────────────
import { q, one } from './db.js';

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

export async function audit(entity, entityId, action, detail = null, qc = q, user = null) {
  await qc('INSERT INTO audit_log (entity, entity_id, action, detail, user_name) VALUES ($1,$2,$3,$4,$5)',
    [entity, entityId, action, detail, user]);
}

// Sheets needed for an order line (qty cartons → child print sheets incl. wastage)
export function sheetsRequired(product, qty) {
  return Math.ceil((qty / product.ups) * (1 + product.wastage_pct / 100));
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

export async function fgReceipt(productId, qty, refType, refId, qc) {
  await qc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
            ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + EXCLUDED.qty`, [productId, qty]);
  await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
            VALUES ($1,'fg_receipt',$2,$3,$4)`, [productId, qty, refType, refId]);
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

// Production routing derived from product spec — no JSON blobs.
// Mirrors the CI-Production 10-stage flow: Cutting → Printing → Coating /
// Lamination (by finish) → Foiling → Embossing → Die Cutting → Sorting →
// Pasting → QC. Sheets convert to cartons at Sorting (blanks counted).
export function routingFor(product) {
  const stages = [{ stage: 'cutting', unit: 'sheets' }];
  stages.push({ stage: 'printing', unit: 'sheets' });
  if (product.coating === 'aqueous' || product.coating === 'uv') stages.push({ stage: 'coating', unit: 'sheets' });
  if (product.coating === 'matt_lam' || product.coating === 'gloss_lam') stages.push({ stage: 'lamination', unit: 'sheets' });
  if (product.special === 'foil' || product.special === 'foil_emboss') stages.push({ stage: 'foiling', unit: 'sheets' });
  if (product.special === 'emboss' || product.special === 'foil_emboss') stages.push({ stage: 'embossing', unit: 'sheets' });
  stages.push({ stage: 'die_cutting', unit: 'sheets' });
  stages.push({ stage: 'sorting', unit: 'cartons' });
  stages.push({ stage: 'pasting', unit: 'cartons' });
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

// The 3-point readiness gate for job card creation. ONE place, no bypasses.
// Material is checked in PARENT sheets — board stock is bought and stored as
// parent sheets; the child requirement converts through the cut fit.
export async function readiness(line, oc = one) {
  const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
  const board = await oc('SELECT * FROM materials WHERE id=$1', [product.board_material_id]);
  const needed = line.sheets_required ?? sheetsRequired(product, line.qty);
  const fit = childFit(board, product);
  const parentNeeded = line.parent_sheets_required ?? parentSheetsRequired(needed, fit.count);
  const available = await availableQty(product.board_material_id, oc);
  return {
    artwork: !!line.artwork_locked,
    tooling: !!line.tooling_ok,
    material: available >= parentNeeded,
    needed_sheets: needed,                 // child print sheets
    parent_needed: parentNeeded,           // parent sheets to issue
    children_per_parent: fit.count,
    parent_size: fit.sized ? `${board.sheet_l}×${board.sheet_w}"` : null,
    child_size: fit.sized ? `${product.child_l}×${product.child_w}"` : null,
    cut_waste_pct: fit.waste_pct,
    available_sheets: available,           // parent sheets in stock
    board_material_id: product.board_material_id,
  };
}
