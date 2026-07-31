// Master 360 — the drill-down behind every Product / Machine / Material row in
// Masters. One endpoint returns, for a chosen date window:
//   summary   KPI strip for the window (produced/dispatched/invoiced, stock…)
//   ledger    ERP-style movement register with a running balance
//   invoices  (products) invoice control — every invoice line + its COA state
//   coas      (products) COA control — every certificate for this product
//   purchases (materials) PO lines + GRNs for this material
//   register  (machines) the logbook register (auto runs + manual entries)
//   logs      operational audit events touching this record anywhere in the ERP
//   audit     master-record audit trail (create/update/delete on the row itself)
import { Router } from 'express';
import { q, one } from '../db.js';
import { LOOKUPS } from './timeline.js';

const r = Router();

// Window boundaries on the plant clock (IST), same convention as /timeline.
const FROM = `(($2)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const TO = `((($3)::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const IN_WINDOW = col => `${col} >= ${FROM} AND ${col} < ${TO}`;

// Which audit_log entity names ARE this master record itself.
const SELF_ENTITIES = {
  products: ['product', 'products'],
  materials: ['materials', 'inventory'],
  machines: ['machine', 'machines'],
};

// Enrich audit events with display labels, one batch query per entity type.
async function enrich(events) {
  const byEntity = {};
  for (const e of events) {
    if (e.entity_id != null && LOOKUPS[e.entity]) (byEntity[e.entity] ??= new Set()).add(e.entity_id);
  }
  const labels = {};
  await Promise.all(Object.entries(byEntity).map(async ([entity, ids]) => {
    const found = await q(LOOKUPS[entity], [[...ids]]);
    labels[entity] = Object.fromEntries(found.map(f => [f.id, f.label]));
  }));
  for (const e of events) e.label = labels[e.entity]?.[e.entity_id] ?? null;
  return events;
}

// Where did the change happen? For shop-floor events (job_stage) that is the
// production stage + the machine it ran on — the actual station. For everything
// else it is the module/register the record lives in. Stamped on every log and
// audit row so the drawer can show "in which station the update was done".
const STATION_MODULE = {
  product: 'Product Master', products: 'Product Master',
  order_line: 'Sales Order', order: 'Sales Order',
  job_card: 'Job Card',
  fg_lot: 'Finished Goods',
  dispatch: 'Dispatch', invoice: 'Billing',
  materials: 'Material Master', inventory: 'Inventory',
  grn: 'Goods Receipt', purchase_order: 'Procurement', requisition: 'Requisition',
  machine: 'Machine', machines: 'Machine',
};

// Batch-resolve the station (stage + machine) for any job_stage events, then
// stamp `station` on every event: { stage, machine } for a floor stage, else
// { label } for the owning module.
async function enrichStations(events) {
  const stageIds = [...new Set(events.filter(e => e.entity === 'job_stage' && e.entity_id != null).map(e => e.entity_id))];
  let stageMap = {};
  if (stageIds.length) {
    const rows = await q(`
      SELECT js.id, js.stage, m.name AS machine
      FROM job_stages js
      JOIN job_cards jc ON jc.id = js.job_card_id
      LEFT JOIN machines m ON m.id = COALESCE(js.machine_id, CASE WHEN js.stage='printing' THEN jc.machine_id END)
      WHERE js.id = ANY($1)`, [stageIds]);
    stageMap = Object.fromEntries(rows.map(x => [x.id, x]));
  }
  for (const e of events) {
    if (e.entity === 'job_stage' && stageMap[e.entity_id]) {
      const s = stageMap[e.entity_id];
      e.station = { stage: s.stage, machine: s.machine };
    } else {
      e.station = { label: STATION_MODULE[e.entity] || null };
    }
  }
  return events;
}

// The record's own audit trail — every create/update/delete on the master row.
const selfAudit = async (kind, params) => enrich(await q(`
  SELECT id, entity, entity_id, action, detail, user_name, created_at AS ts
  FROM audit_log
  WHERE entity = ANY($4) AND entity_id = $1 AND ${IN_WINDOW('created_at')}
  ORDER BY created_at DESC, id DESC LIMIT 300`,
  [...params, SELF_ENTITIES[kind]]));

// ── Products ────────────────────────────────────────────────────────────────
async function productHistory(id, params) {
  const record = await one(`
    SELECT p.*, c.name AS customer_name, m.name AS board_material_name
    FROM products p JOIN customers c ON c.id=p.customer_id
    LEFT JOIN materials m ON m.id=p.board_material_id WHERE p.id=$1`, [id]);
  if (!record) return null;

  // Movement ledger — stock_movements carries every FG event for the product,
  // signed (+fg_receipt / −dispatch / ±adjustment) plus process scrap
  // (wastage / wastage_reversal). The running balance accumulates only the
  // stock-affecting types; scrap rows repeat the previous balance, exactly the
  // way a manual stock register carries the balance past a remark line.
  const STOCK_TYPES = `('fg_receipt','dispatch','adjustment')`;
  const [{ opening }] = await q(`
    SELECT COALESCE(SUM(qty),0)::bigint AS opening FROM stock_movements
    WHERE product_id=$1 AND type IN ${STOCK_TYPES} AND created_at < ${FROM}`, params.slice(0, 2));
  const moves = await q(`
    SELECT sm.id, sm.type, sm.qty, sm.ref_type, sm.ref_id, sm.note, sm.created_at AS ts
    FROM stock_movements sm
    WHERE sm.product_id=$1 AND ${IN_WINDOW('sm.created_at')}
    ORDER BY sm.created_at, sm.id`, params);
  let bal = +opening;
  const stockTypes = new Set(['fg_receipt', 'dispatch', 'adjustment']);
  const ledger = moves.map(m0 => {
    const stock = stockTypes.has(m0.type);
    if (stock) bal += +m0.qty;
    return {
      id: m0.id, ts: m0.ts, type: m0.type,
      in: +m0.qty > 0 ? +m0.qty : null,
      out: +m0.qty < 0 ? -m0.qty : null,
      balance: bal, counts: stock,
      ref_type: m0.ref_type, ref_id: m0.ref_id, note: m0.note,
    };
  }).reverse(); // newest first for the drawer

  // Ref labels (JC number, challan…) batched via the timeline lookups.
  await enrich(ledger.filter(l => l.ref_type && LOOKUPS[l.ref_type])
    .map(l => Object.assign(l, { entity: l.ref_type, entity_id: l.ref_id })));

  // Invoice control — every invoice line of this product, with the COA that
  // covers the same dispatch line (the "movement against invoice" view).
  const invoices = await q(`
    SELECT il.id, il.qty, il.rate, il.amount,
           i.id AS invoice_id, i.invoice_number, i.invoice_date, i.status, i.total AS invoice_total,
           c.name AS customer_name, d.challan_number, d.dispatched_at,
           co.id AS coa_id, co.coa_number, co.status AS coa_status
    FROM invoice_lines il
    JOIN invoices i ON i.id=il.invoice_id
    JOIN customers c ON c.id=i.customer_id
    JOIN dispatch_lines dl ON dl.id=il.dispatch_line_id
    JOIN dispatches d ON d.id=dl.dispatch_id
    LEFT JOIN coas co ON co.dispatch_line_id=dl.id
    WHERE il.product_id=$1 AND i.invoice_date >= $2 AND i.invoice_date <= $3
    ORDER BY i.invoice_date DESC, i.id DESC, il.id`, params);

  // COA control — every certificate for this product in the window.
  const coas = await q(`
    SELECT co.id, co.coa_number, co.status, co.qty, co.batch_no, co.mfg_date,
           co.inspected_by, co.approved_by, co.issued_at, co.created_at AS ts,
           d.challan_number, i.invoice_number, cu.name AS customer_name, jc.jc_number
    FROM coas co
    JOIN dispatches d ON d.id=co.dispatch_id
    JOIN customers cu ON cu.id=co.customer_id
    LEFT JOIN invoices i ON i.id=co.invoice_id
    LEFT JOIN job_cards jc ON jc.id=co.job_card_id
    WHERE co.product_id=$1 AND ${IN_WINDOW('co.created_at')}
    ORDER BY co.id DESC`, params);

  // Order book — every sales-order line for this product in the window, with how
  // much of each is still pending (ordered − dispatched). Windowed by PO date,
  // the same way the invoice tab is windowed by invoice date.
  const orders = await q(`
    SELECT ol.id, ol.qty, ol.dispatched_qty, ol.status,
           GREATEST(0, ol.qty - ol.dispatched_qty) AS pending_qty,
           o.po_number, o.po_date, o.delivery_date, o.status AS order_status
    FROM order_lines ol
    JOIN orders o ON o.id=ol.order_id
    WHERE ol.product_id=$1 AND o.po_date >= $2 AND o.po_date <= $3
    ORDER BY o.po_date DESC, o.id DESC, ol.id`, params);

  // Order position is a lifetime figure, not a window slice — pending stays
  // pending regardless of which week you are looking at.
  const [ordersPos] = await q(`
    SELECT COALESCE(SUM(ol.qty),0)::bigint AS ordered_total,
           COALESCE(SUM(ol.dispatched_qty),0)::bigint AS ordered_dispatched,
           COALESCE(SUM(GREATEST(0, ol.qty - ol.dispatched_qty)),0)::bigint AS orders_pending,
           COUNT(*) FILTER (WHERE GREATEST(0, ol.qty - ol.dispatched_qty) > 0)::int AS open_lines
    FROM order_lines ol
    WHERE ol.product_id=$1 AND ol.status <> 'cancelled'`, [id]);

  // Control gaps are lifetime positions, not window slices — a challan missing
  // its invoice stays a gap no matter which week you are looking at.
  const [{ pending_invoice_qty }] = await q(`
    SELECT COALESCE(SUM(dl.qty),0)::bigint AS pending_invoice_qty
    FROM dispatch_lines dl
    LEFT JOIN invoice_lines il ON il.dispatch_line_id=dl.id
    WHERE dl.product_id=$1 AND il.id IS NULL`, [id]);
  const [{ lines_without_coa }] = await q(`
    SELECT COUNT(*)::int AS lines_without_coa
    FROM invoice_lines il
    LEFT JOIN coas co ON co.dispatch_line_id=il.dispatch_line_id
    WHERE il.product_id=$1 AND co.id IS NULL`, [id]);

  const [sums] = await q(`
    SELECT COALESCE(SUM(qty) FILTER (WHERE type='fg_receipt'),0)::bigint AS produced,
           COALESCE(SUM(-qty) FILTER (WHERE type='dispatch'),0)::bigint AS dispatched,
           COALESCE(SUM(-qty) FILTER (WHERE type='wastage'),0)::bigint
             - COALESCE(SUM(qty) FILTER (WHERE type='wastage_reversal'),0)::bigint AS scrap
    FROM stock_movements WHERE product_id=$1 AND ${IN_WINDOW('created_at')}`, params);
  const fg = await one('SELECT qty FROM fg_stock WHERE product_id=$1', [id]);
  const [{ lot_qty }] = await q(`
    SELECT COALESCE(SUM(qty - consumed_qty),0)::bigint AS lot_qty
    FROM fg_lots WHERE product_id=$1 AND status='verified'`, [id]);
  const invoiced_qty = invoices.reduce((s, x) => s + +x.qty, 0);
  const invoiced_value = invoices.reduce((s, x) => s + +x.amount, 0);

  // Operational log — every audit event that touched this product anywhere:
  // its order lines, job cards, stages, FG lots, dispatches and invoices.
  const logs = await enrich(await q(`
    SELECT a.id, a.entity, a.entity_id, a.action, a.detail, a.user_name, a.created_at AS ts
    FROM audit_log a
    WHERE ${IN_WINDOW('a.created_at')} AND (
      (a.entity IN ('product','products') AND a.entity_id=$1)
      OR (a.entity='order_line' AND a.entity_id IN (SELECT id FROM order_lines WHERE product_id=$1))
      OR (a.entity='job_card' AND a.entity_id IN (SELECT id FROM job_cards WHERE product_id=$1))
      OR (a.entity='job_stage' AND a.entity_id IN (
            SELECT js.id FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id WHERE jc.product_id=$1))
      OR (a.entity='fg_lot' AND a.entity_id IN (SELECT id FROM fg_lots WHERE product_id=$1))
      OR (a.entity='dispatch' AND a.entity_id IN (SELECT DISTINCT dispatch_id FROM dispatch_lines WHERE product_id=$1))
      OR (a.entity='invoice' AND a.entity_id IN (SELECT DISTINCT invoice_id FROM invoice_lines WHERE product_id=$1))
    )
    ORDER BY a.created_at DESC, a.id DESC LIMIT 300`, params));

  const audit = await selfAudit('products', params);
  await enrichStations(logs);
  await enrichStations(audit);

  return {
    record: { id: record.id, name: record.name, code: record.code, customer_name: record.customer_name },
    summary: {
      orders_pending: +ordersPos.orders_pending, ordered_total: +ordersPos.ordered_total,
      ordered_dispatched: +ordersPos.ordered_dispatched, open_order_lines: ordersPos.open_lines,
      produced: +sums.produced, dispatched: +sums.dispatched, scrap: +sums.scrap,
      invoiced_qty, invoiced_value, coas_issued: coas.filter(c => c.status === 'issued').length,
      fg_on_hand: (fg?.qty || 0) + +lot_qty, opening: +opening,
      pending_invoice_qty: +pending_invoice_qty, lines_without_coa,
    },
    ledger, orders, invoices, coas, logs, audit,
  };
}

// ── Materials ───────────────────────────────────────────────────────────────
async function materialHistory(id, params) {
  const record = await one('SELECT * FROM materials WHERE id=$1', [id]);
  if (!record) return null;

  // Stock register — stock_movements is already signed for materials
  // (grn +, consumption −, qc_reject −, adjustment ±, qc_release 0), so the
  // running balance is on-hand including quarantine.
  const [{ opening }] = await q(`
    SELECT COALESCE(SUM(qty),0)::double precision AS opening FROM stock_movements
    WHERE material_id=$1 AND created_at < ${FROM}`, params.slice(0, 2));
  const moves = await q(`
    SELECT sm.id, sm.type, sm.qty, sm.ref_type, sm.ref_id, sm.note, sm.created_at AS ts,
           b.batch_no
    FROM stock_movements sm
    LEFT JOIN stock_batches b ON b.id=sm.batch_id
    WHERE sm.material_id=$1 AND ${IN_WINDOW('sm.created_at')}
    ORDER BY sm.created_at, sm.id`, params);
  let bal = +opening;
  const ledger = moves.map(m0 => {
    bal += +m0.qty;
    return {
      id: m0.id, ts: m0.ts, type: m0.type,
      in: +m0.qty > 0 ? +m0.qty : null,
      out: +m0.qty < 0 ? -m0.qty : null,
      balance: bal, counts: true,
      ref_type: m0.ref_type, ref_id: m0.ref_id, note: m0.note, batch_no: m0.batch_no,
    };
  }).reverse();
  await enrich(ledger.filter(l => l.ref_type && LOOKUPS[l.ref_type])
    .map(l => Object.assign(l, { entity: l.ref_type, entity_id: l.ref_id })));

  // Purchase control — PO lines and GRNs for this material.
  const purchases = await q(`
    SELECT pl.id, pl.qty, pl.rate, pl.received_qty, po.po_number, po.status,
           po.created_at AS ts, v.name AS vendor_name
    FROM po_lines pl
    JOIN purchase_orders po ON po.id=pl.purchase_order_id
    JOIN vendors v ON v.id=po.vendor_id
    WHERE pl.material_id=$1 AND ${IN_WINDOW('po.created_at')}
    ORDER BY po.id DESC, pl.id`, params);
  // One row per LINE of this material — a receipt covering four boards belongs
  // on four different materials' registers, each showing only its own quantity,
  // batch and QC decision. `id` stays the HEADER id so the drawer's link still
  // opens the receipt and its thread/audit rows keep resolving.
  //
  // `line_id` therefore carries the row's own identity, exactly as the /grns
  // register names it. Without it two lines of ONE receipt against the SAME
  // material (a split lot: -B1 and -B2) share the header id, and the drawer —
  // a financial history — keys both rows the same and may drop one.
  const grns = await q(`
    SELECT h.id, gl.id AS line_id,
           h.grn_number, gl.qty, gl.batch_no, gl.status, h.received_at AS ts,
           gl.qc_at, gl.qc_note, gl.rate,
           po.po_number, COALESCE(v.name, dv.name) AS vendor_name
    FROM grn_lines gl
    JOIN grn_headers h ON h.id=gl.grn_header_id
    LEFT JOIN purchase_orders po ON po.id=h.purchase_order_id
    LEFT JOIN vendors v ON v.id=po.vendor_id
    LEFT JOIN vendors dv ON dv.id=h.vendor_id
    WHERE gl.material_id=$1 AND ${IN_WINDOW('h.received_at')}
    ORDER BY h.id DESC, gl.id`, params);

  const stock = await one(`
    SELECT COALESCE(SUM(qty) FILTER (WHERE status='available'),0)::double precision AS available,
           COALESCE(SUM(qty) FILTER (WHERE status='quarantine'),0)::double precision AS quarantine
    FROM stock_batches WHERE material_id=$1`, [id]);
  const [{ on_order }] = await q(`
    SELECT COALESCE(SUM(GREATEST(0, pl.qty - pl.received_qty)),0)::double precision AS on_order
    FROM po_lines pl JOIN purchase_orders po ON po.id=pl.purchase_order_id
    WHERE pl.material_id=$1 AND po.status IN ('open','partially_received')`, [id]);
  const [sums] = await q(`
    SELECT COALESCE(SUM(qty) FILTER (WHERE type='grn'),0)::double precision AS received,
           COALESCE(SUM(-qty) FILTER (WHERE type='consumption'),0)::double precision AS consumed
    FROM stock_movements WHERE material_id=$1 AND ${IN_WINDOW('created_at')}`, params);

  const logs = await enrich(await q(`
    SELECT a.id, a.entity, a.entity_id, a.action, a.detail, a.user_name, a.created_at AS ts
    FROM audit_log a
    WHERE ${IN_WINDOW('a.created_at')} AND (
      (a.entity IN ('materials','inventory') AND a.entity_id=$1)
      OR (a.entity='grn' AND a.entity_id IN (
            SELECT gl.grn_header_id FROM grn_lines gl WHERE gl.material_id=$1))
      OR (a.entity='requisition' AND a.entity_id IN (
            SELECT id FROM requisitions WHERE material_id=$1
            UNION SELECT requisition_id FROM requisition_lines WHERE material_id=$1))
      OR (a.entity='purchase_order' AND a.entity_id IN (
            SELECT DISTINCT purchase_order_id FROM po_lines WHERE material_id=$1))
    )
    ORDER BY a.created_at DESC, a.id DESC LIMIT 300`, params));

  const audit = await selfAudit('materials', params);
  await enrichStations(logs);
  await enrichStations(audit);

  return {
    record: { id: record.id, name: record.name, code: record.spec, customer_name: record.category, unit: record.unit },
    summary: {
      received: +sums.received, consumed: +sums.consumed,
      available: +stock.available, quarantine: +stock.quarantine,
      on_order: +on_order, opening: +opening,
    },
    ledger, purchases, grns, logs, audit,
  };
}

// ── Machines ────────────────────────────────────────────────────────────────
// Register mirrors the Logbook: auto rows live from job_stages, manual rows
// from machine_log_entries — never re-entered, never drifting.
const EFFECTIVE_MACHINE =
  `COALESCE(js.machine_id, CASE WHEN js.stage='printing' THEN jc.machine_id END)`;

async function machineHistory(id, params) {
  const record = await one('SELECT * FROM machines WHERE id=$1', [id]);
  if (!record) return null;
  const [, from, to] = params;

  const runs = await q(`
    SELECT js.id, js.stage, js.status, js.unit, js.qty_in, js.qty_out, js.qty_scrap,
           js.operator, js.remarks, js.started_at, js.completed_at,
           jc.jc_number, p.name AS product_name, c.name AS customer_name
    FROM job_stages js
    JOIN job_cards jc ON jc.id=js.job_card_id
    JOIN products p ON p.id=jc.product_id
    JOIN order_lines ol ON ol.id=jc.order_line_id
    JOIN orders o ON o.id=ol.order_id
    JOIN customers c ON c.id=o.customer_id
    WHERE ${EFFECTIVE_MACHINE} = $1 AND js.started_at IS NOT NULL
      AND js.started_at::date BETWEEN $2::date AND $3::date
    ORDER BY js.started_at DESC`, [id, from, to]);
  const manual = await q(`
    SELECT * FROM machine_log_entries
    WHERE machine_id=$1 AND log_date BETWEEN $2 AND $3
    ORDER BY log_date DESC, time_from DESC NULLS LAST, id DESC`, [id, from, to]);

  const register = [
    ...runs.map(s => ({
      kind: 'auto', id: `run-${s.id}`, ts: s.started_at, entry_type: 'production',
      stage: s.stage, status: s.status,
      description: `${s.product_name} — ${s.customer_name}`,
      ref: s.jc_number, in: s.qty_in, out: s.qty_out, scrap: s.qty_scrap,
      unit: s.unit, operator: s.operator, remarks: s.remarks,
    })),
    ...manual.map(e => ({
      kind: 'manual', id: `man-${e.id}`,
      ts: `${e.log_date}T${e.time_from || '00:00'}:00+05:30`,
      entry_type: e.entry_type, stage: null, status: 'logged',
      description: e.description, ref: null,
      in: null, out: e.qty, scrap: null, unit: null,
      operator: e.operator, remarks: e.remarks,
    })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const downtime = manual.filter(e => e.entry_type === 'breakdown' || e.entry_type === 'maintenance').length;

  const logs = await enrich(await q(`
    SELECT a.id, a.entity, a.entity_id, a.action, a.detail, a.user_name, a.created_at AS ts
    FROM audit_log a
    WHERE ${IN_WINDOW('a.created_at')} AND (
      (a.entity IN ('machine','machines') AND a.entity_id=$1)
      OR (a.entity='job_stage' AND a.entity_id IN (
            SELECT js.id FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
            WHERE ${EFFECTIVE_MACHINE} = $1))
    )
    ORDER BY a.created_at DESC, a.id DESC LIMIT 300`, params));

  const audit = await selfAudit('machines', params);
  await enrichStations(logs);
  await enrichStations(audit);

  return {
    record: { id: record.id, name: record.name, code: record.code, customer_name: record.model, type: record.type, status: record.status },
    summary: {
      runs: runs.length,
      output: runs.reduce((s, x) => s + (+x.qty_out || 0), 0),
      scrap: runs.reduce((s, x) => s + (+x.qty_scrap || 0), 0),
      manual_entries: manual.length, downtime_entries: downtime,
    },
    register, logs, audit,
  };
}

// GET /master-history/:kind/:id?from=YYYY-MM-DD&to=YYYY-MM-DD
r.get('/master-history/:kind/:id', async (req, res, next) => {
  try {
    const { kind } = req.params;
    const id = +req.params.id;
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';
    const params = [id, from, to];
    const fn = { products: productHistory, materials: materialHistory, machines: machineHistory }[kind];
    if (!fn || !id) return res.status(400).json({ error: 'Unknown master kind' });
    const out = await fn(id, params);
    if (!out) return res.status(404).json({ error: 'Record not found' });
    res.json({ kind, from, to, ...out });
  } catch (e) { next(e); }
});

export default r;
