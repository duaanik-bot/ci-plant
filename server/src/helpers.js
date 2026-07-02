// ─── Shared business logic: state machine, stock ledger, routing ────────────
import db from './db.js';

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

export function setLineStatus(lineId, to) {
  const line = db.prepare('SELECT * FROM order_lines WHERE id=?').get(lineId);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }
  assertTransition(line.status, to);
  db.prepare('UPDATE order_lines SET status=? WHERE id=?').run(to, lineId);
  audit('order_line', lineId, `status:${line.status}→${to}`);
  return { ...line, status: to };
}

export function audit(entity, entityId, action, detail = null) {
  db.prepare('INSERT INTO audit_log (entity, entity_id, action, detail) VALUES (?,?,?,?)')
    .run(entity, entityId, action, detail);
}

// Sheets needed for an order line (qty cartons → sheets incl. wastage)
export function sheetsRequired(product, qty) {
  return Math.ceil((qty / product.ups) * (1 + product.wastage_pct / 100));
}

// Available (QC-released, unconsumed) stock of a material
export function availableQty(materialId) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=? AND status='available'`
  ).get(materialId);
  return r.q;
}

// Consume material FIFO across available batches. Writes ledger rows.
// Throws 409 if not enough stock. Call inside a transaction.
export function consumeFifo(materialId, qty, refType, refId, note) {
  let remaining = qty;
  const batches = db.prepare(
    `SELECT * FROM stock_batches WHERE material_id=? AND status='available' AND qty>0 ORDER BY created_at, id`
  ).all(materialId);
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty, remaining);
    const newQty = b.qty - take;
    db.prepare('UPDATE stock_batches SET qty=?, status=? WHERE id=?')
      .run(newQty, newQty === 0 ? 'exhausted' : 'available', b.id);
    db.prepare(
      `INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
       VALUES (?,?,?,?,?,?,?)`
    ).run(materialId, b.id, 'consumption', -take, refType, refId, note);
    remaining -= take;
  }
  if (remaining > 0) {
    const e = new Error(`Insufficient stock: short by ${remaining}`);
    e.status = 409;
    throw e;
  }
}

// Finished-goods receipt (job close) — ledger + fg_stock in one place.
export function fgReceipt(productId, qty, refType, refId) {
  db.prepare(`INSERT INTO fg_stock (product_id, qty) VALUES (?,?)
              ON CONFLICT(product_id) DO UPDATE SET qty = qty + excluded.qty`).run(productId, qty);
  db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
              VALUES (?,?,?,?,?)`).run(productId, 'fg_receipt', qty, refType, refId);
}

export function fgIssue(productId, qty, refType, refId) {
  const row = db.prepare('SELECT qty FROM fg_stock WHERE product_id=?').get(productId);
  if (!row || row.qty < qty) {
    const e = new Error('Insufficient finished-goods stock');
    e.status = 409;
    throw e;
  }
  db.prepare('UPDATE fg_stock SET qty = qty - ? WHERE product_id=?').run(qty, productId);
  db.prepare(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id)
              VALUES (?,?,?,?,?)`).run(productId, 'dispatch', -qty, refType, refId);
}

// Production routing derived from product spec — no JSON blobs.
export function routingFor(product) {
  const stages = [{ stage: 'printing', unit: 'sheets' }];
  if (product.coating !== 'none') stages.push({ stage: 'coating', unit: 'sheets' });
  if (product.special === 'foil' || product.special === 'foil_emboss') stages.push({ stage: 'foiling', unit: 'sheets' });
  if (product.special === 'emboss' || product.special === 'foil_emboss') stages.push({ stage: 'embossing', unit: 'sheets' });
  stages.push({ stage: 'die_cutting', unit: 'sheets' });
  stages.push({ stage: 'pasting', unit: 'cartons' });
  stages.push({ stage: 'qc', unit: 'cartons' });
  return stages;
}

// Simple sequential document numbers: CI-JC-0001 etc.
export function nextNumber(prefix, table, column) {
  const row = db.prepare(`SELECT ${column} AS n FROM ${table} ORDER BY id DESC LIMIT 1`).get();
  let seq = 1;
  if (row?.n) {
    const m = String(row.n).match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// The 3-point readiness gate for job card creation. ONE place, no bypasses.
export function readiness(line) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(line.product_id);
  const needed = line.sheets_required ?? sheetsRequired(product, line.qty);
  const available = availableQty(product.board_material_id);
  return {
    artwork: !!line.artwork_locked,
    tooling: !!line.tooling_ok,
    material: available >= needed,
    needed_sheets: needed,
    available_sheets: available,
    board_material_id: product.board_material_id,
  };
}
