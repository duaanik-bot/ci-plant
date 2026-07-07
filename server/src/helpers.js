// ─── Shared business logic: state machine, stock ledger, routing ────────────
import { q, one } from './db.js';
import { toolingDetail, toolingGateOk } from './tooling-gate.js';

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
  const needed = line.sheets_required ?? sheetsRequired(product, netProduceQty(line), line.wastage_sheets);
  const fit = childFit(board, product);
  const parentNeeded = line.parent_sheets_required ?? parentSheetsRequired(needed, fit.count);
  const available = await availableQty(product.board_material_id, oc);
  // Tooling: every physical tool linked to this product (the die also links
  // via products.tool_id). Hard/soft semantics live in tooling-gate.js.
  const toolsRow = await oc(`
    SELECT COALESCE(json_agg(t ORDER BY t.id), '[]'::json) AS list
    FROM tools t WHERE t.product_id = $1 OR t.id = $2`,
    [line.product_id, product.tool_id ?? -1]);
  const detail = toolingDetail(product, toolsRow.list);
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
    parent_size: fit.sized ? `${board.sheet_l}×${board.sheet_w}"` : null,
    child_size: fit.sized ? `${product.child_l}×${product.child_w}"` : null,
    cut_waste_pct: fit.waste_pct,
    available_sheets: available,           // parent sheets in stock
    board_material_id: product.board_material_id,
  };
}

export async function createJobCardForLine(lineId, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }

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
  if (!gate.tooling) blocked.push('tooling not ready');
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
  await audit('job_card', jc.id, 'create',
    gate.material ? jc_number : `${jc_number} — board pending (short ${short} parent sheets, supply on order)`,
    qc, user);
  return jc.id;
}
