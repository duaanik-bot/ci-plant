// Procurement + Warehouse for physical Tooling Hub families. Job Card demand
// replaces the raw-material PR; approval, vendor PO, GRN/QC and stock release
// follow the same guarded hand-offs as Procurement without sharing board stock.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, outputNumberSql } from '../helpers.js';
import { requireRole } from '../auth.js';
import {
  PHYSICAL_TOOLING_FAMILIES,
  TOOLING_FAMILY_CODE,
  toolingPoStatus,
  toolingRequirementReady,
} from '../tooling-procurement.js';

const r = Router();
const canBuy = requireRole('planner');
const canQc = requireRole('qc');

function familyOf(req) {
  const family = String(req.params.family || '');
  if (!PHYSICAL_TOOLING_FAMILIES.includes(family)) {
    throw Object.assign(new Error('Unknown physical tooling family'), { status: 400 });
  }
  return family;
}

async function requestForUpdate(oc, id, family) {
  const row = await oc('SELECT * FROM tooling_requests WHERE id=$1 AND family=$2 FOR UPDATE', [id, family]);
  if (!row) throw Object.assign(new Error('Tooling requirement not found'), { status: 404 });
  return row;
}

async function requestEvent(qc, request, action, toStatus, user, note = null) {
  await qc(`INSERT INTO tooling_request_events
    (tooling_request_id, action, from_status, to_status, source, tool_id, vendor_id, note, user_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [request.id, action, request.status || null, toStatus || request.status || null,
   request.source || null, request.tool_id || null, request.vendor_id || null, note, user]);
}

async function activeAllocated(oc, requestId) {
  const row = await oc(`SELECT COALESCE(SUM(qty),0) AS qty FROM tooling_stock_allocations
                        WHERE tooling_request_id=$1 AND status='active'`, [requestId]);
  return Number(row?.qty) || 0;
}

async function refreshRequirementReadiness(qc, oc, requestId, user, { source = null, grnNumber = null } = {}) {
  const request = await oc('SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE', [requestId]);
  if (!request) return null;
  const allocated = await activeAllocated(oc, request.id);
  const ready = toolingRequirementReady(request.qty, allocated);
  const nextStatus = ready ? 'ready' : (grnNumber ? 'grn_completed' : request.status);
  const [updated] = await qc(`UPDATE tooling_requests SET
      status=$1,
      source=COALESCE($2,source),
      approval_status=CASE WHEN $3 THEN 'closed' ELSE approval_status END,
      grn_number=COALESCE($4,grn_number),
      ready_at=CASE WHEN $3 THEN now() ELSE ready_at END,
      ready_by=CASE WHEN $3 THEN $5 ELSE ready_by END,
      closed_at=CASE WHEN $3 THEN now() ELSE closed_at END,
      updated_at=now()
    WHERE id=$6 RETURNING *`,
  [nextStatus, source, ready, grnNumber, user, request.id]);
  if (ready && request.status !== 'ready') {
    await requestEvent(qc, request, 'stock_fulfilled', 'ready', user,
      `${allocated} of ${request.qty} ${request.family === 'plate' ? 'plates' : 'tool'} reserved`);
  }
  return { ...updated, allocated_qty: allocated };
}

async function poRows(family, id = null) {
  const params = [family];
  const where = id ? (params.push(id), 'AND po.id=$2') : '';
  const rows = await q(`SELECT po.*, v.name AS vendor_name, v.address AS vendor_address,
      v.city AS vendor_city, v.state AS vendor_state, v.gstin AS vendor_gstin,
      v.state_code AS vendor_state_code, v.contact AS vendor_contact, v.phone AS vendor_phone
    FROM tooling_purchase_orders po
    JOIN vendors v ON v.id=po.vendor_id
    WHERE po.family=$1 ${where}
    ORDER BY po.id DESC`, params);
  if (!rows.length) return rows;
  // A plate line carries its own identity — the product it is for, the output
  // number the plant calls it by, its size, and the inks actually on the
  // plates. Without them the printed PO tells the vendor only "Plate 1030x800",
  // which is the inventory item, not the job. The lateral is LEFT and yields an
  // empty list, so a die or block line is untouched by it.
  const lines = await q(`SELECT pl.*, pl.inventory_item_id AS material_id,
      ti.code AS material_code, ti.name AS material_name,
      ti.specification AS spec, ti.size, ti.tool_type, ti.product_id,
      tr.request_number, jc.jc_number,
      COALESCE(NULLIF(tr.specification->>'product_name',''), p.name) AS product_name,
      ${outputNumberSql({ run: 'gr', product: 'p' })} AS output_number,
      COALESCE((tr.specification->>'is_gang')::boolean, false) AS is_gang,
      tr.specification->'gang_members' AS gang_members,
      plate.plate_size, COALESCE(plate.components, '[]'::json) AS components
    FROM tooling_po_lines pl
    JOIN tooling_inventory_items ti ON ti.id=pl.inventory_item_id
    LEFT JOIN tooling_requests tr ON tr.id=pl.tooling_request_id
    LEFT JOIN job_cards jc ON jc.id=tr.job_card_id
    LEFT JOIN gang_runs gr ON gr.id=jc.gang_run_id
    LEFT JOIN products p ON p.id=tr.product_id
    LEFT JOIN LATERAL (
      SELECT MIN(pm.plate_size) AS plate_size,
        json_agg(json_build_object(
          'id',prc.id,'component_label',prc.component_label,'status',prc.status,
          'component_type',prc.component_type,'pantone_code',prc.pantone_code
        ) ORDER BY prc.sequence_no) AS components
      FROM plate_request_components prc
      LEFT JOIN plate_masters pm ON pm.id=prc.plate_master_id
      WHERE prc.po_line_id=pl.id
    ) plate ON true
    WHERE pl.purchase_order_id=ANY($1::int[]) ORDER BY pl.id`, [rows.map(row => row.id)]);
  const byPo = {};
  for (const line of lines) (byPo[line.purchase_order_id] ||= []).push(line);
  return rows.map(row => ({ ...row, lines: byPo[row.id] || [] }));
}

async function grnRows(family) {
  return q(`SELECT g.*, ti.code AS item_code, ti.name AS item_name,
      ti.specification, ti.size, ti.tool_type, ti.unit,
      po.po_number, v.name AS vendor_name, tr.request_number,
      jc.jc_number, p.name AS product_name
    FROM tooling_grns g
    JOIN tooling_inventory_items ti ON ti.id=g.inventory_item_id
    LEFT JOIN tooling_purchase_orders po ON po.id=g.purchase_order_id
    LEFT JOIN vendors v ON v.id=g.vendor_id
    LEFT JOIN tooling_requests tr ON tr.id=g.tooling_request_id
    LEFT JOIN job_cards jc ON jc.id=tr.job_card_id
    LEFT JOIN products p ON p.id=tr.product_id
    WHERE g.family=$1 ORDER BY g.id DESC`, [family]);
}

// ── Requirement approval: identical spend gate as Procurement ──────────────
// Bulk deletion is intentionally limited to untouched pending PRs. The full
// selection is validated before any row is removed so the action is atomic.
r.delete('/tooling/procurement/:family/requirements/bulk', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const requestIds = [...new Set((req.body.request_ids || []).map(Number).filter(Boolean))];
    const reason = String(req.body.reason || '').trim();
    if (!requestIds.length) return res.status(400).json({ error: 'Choose at least one PR to delete' });
    if (!reason) return res.status(400).json({ error: 'Record why these PRs are being deleted' });
    const result = await tx(async (qc, oc) => {
      const requests = await qc(`SELECT * FROM tooling_requests
        WHERE id=ANY($1::int[]) AND family=$2 ORDER BY id FOR UPDATE`, [requestIds, family]);
      if (requests.length !== requestIds.length) {
        throw Object.assign(new Error('One or more selected tooling PRs no longer exist'), { status: 404 });
      }
      const locked = requests.find(row => row.approval_status !== 'pending');
      if (locked) {
        throw Object.assign(new Error(`Unapprove ${locked.request_number} before deleting it`), { status: 409 });
      }
      const downstream = await oc(`SELECT tr.request_number
        FROM tooling_requests tr
        WHERE tr.id=ANY($1::int[]) AND (
          EXISTS(SELECT 1 FROM tooling_po_lines pl WHERE pl.tooling_request_id=tr.id)
          OR EXISTS(SELECT 1 FROM tooling_grns g WHERE g.tooling_request_id=tr.id)
          OR EXISTS(SELECT 1 FROM tooling_stock_allocations a WHERE a.tooling_request_id=tr.id)
        ) LIMIT 1`, [requestIds]);
      if (downstream) {
        throw Object.assign(new Error(`${downstream.request_number} has downstream warehouse or purchasing activity and cannot be deleted`), { status: 409 });
      }
      const deleted = await qc(`DELETE FROM tooling_requests
        WHERE id=ANY($1::int[]) AND family=$2 RETURNING id,request_number`, [requestIds, family]);
      for (const row of requests) {
        await audit('tooling_requirement', row.id, 'delete', `${row.request_number} · ${reason}`, qc, req.user.name);
      }
      return { ok: true, deleted: deleted.length, request_numbers: deleted.map(row => row.request_number) };
    });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/requirements/:id/approve', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const result = await tx(async (qc, oc) => {
      const row = await requestForUpdate(oc, req.params.id, family);
      if (row.approval_status !== 'pending') throw Object.assign(new Error(`Cannot approve a ${row.approval_status} requirement`), { status: 409 });
      const [updated] = await qc(`UPDATE tooling_requests SET approval_status='approved', approved_by=$1,
        approved_at=now(), rejected_by=NULL, rejected_at=NULL, updated_at=now() WHERE id=$2 RETURNING *`,
      [req.user.name, row.id]);
      await requestEvent(qc, row, 'approve', row.status, req.user.name);
      await audit('tooling_requirement', row.id, 'approve', null, qc, req.user.name);
      return updated;
    });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/requirements/:id/unapprove', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const result = await tx(async (qc, oc) => {
      const row = await requestForUpdate(oc, req.params.id, family);
      if (row.approval_status !== 'approved') throw Object.assign(new Error('Only an approved requirement can be un-approved'), { status: 409 });
      const po = await oc(`SELECT po.po_number FROM tooling_po_lines pl JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
                           WHERE pl.tooling_request_id=$1 AND po.status<>'closed' LIMIT 1`, [row.id]);
      if (po) throw Object.assign(new Error(`${row.request_number} is already on ${po.po_number}`), { status: 409 });
      const [updated] = await qc(`UPDATE tooling_requests SET approval_status='pending', approved_by=NULL,
        approved_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [row.id]);
      await requestEvent(qc, row, 'unapprove', row.status, req.user.name);
      await audit('tooling_requirement', row.id, 'unapprove', null, qc, req.user.name);
      return updated;
    });
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/requirements/:id/reject', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const result = await tx(async (qc, oc) => {
      const row = await requestForUpdate(oc, req.params.id, family);
      if (row.approval_status !== 'pending') throw Object.assign(new Error(`Cannot reject a ${row.approval_status} requirement`), { status: 409 });
      const [updated] = await qc(`UPDATE tooling_requests SET approval_status='rejected', rejected_by=$1,
        rejected_at=now(), status='cancelled', updated_at=now() WHERE id=$2 RETURNING *`, [req.user.name, row.id]);
      await requestEvent(qc, row, 'reject', 'cancelled', req.user.name, req.body.reason || null);
      await audit('tooling_requirement', row.id, 'reject', req.body.reason || null, qc, req.user.name);
      return updated;
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Reserve an approved requirement from its own family warehouse, oldest batch
// first. The reserve and readiness change land in one transaction.
r.post('/tooling/procurement/:family/requirements/:id/reserve', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const result = await tx(async (qc, oc) => {
      const request = await requestForUpdate(oc, req.params.id, family);
      if (!['approved','converted'].includes(request.approval_status)) {
        throw Object.assign(new Error('Approve the requirement before reserving warehouse stock'), { status: 409 });
      }
      if (!request.inventory_item_id) throw Object.assign(new Error('This requirement has no inventory master'), { status: 409 });
      const already = await activeAllocated(oc, request.id);
      let need = Math.max(0, Number(request.qty) - already);
      if (need <= 0) return refreshRequirementReadiness(qc, oc, request.id, req.user.name, { source: 'rack' });
      const batches = await qc(`SELECT b.*,
          b.qty-COALESCE((SELECT SUM(a.qty) FROM tooling_stock_allocations a
                          WHERE a.stock_batch_id=b.id AND a.status='active'),0) AS free
        FROM tooling_stock_batches b
        WHERE b.inventory_item_id=$1 AND b.status='available'
        ORDER BY b.received_at, b.id FOR UPDATE`, [request.inventory_item_id]);
      let reserved = 0;
      for (const batch of batches) {
        const take = Math.min(need, Math.max(0, Number(batch.free) || 0));
        if (!(take > 0)) continue;
        await qc(`INSERT INTO tooling_stock_allocations
          (tooling_request_id, stock_batch_id, qty, created_by) VALUES ($1,$2,$3,$4)`,
        [request.id, batch.id, take, req.user.name]);
        await qc(`INSERT INTO tooling_stock_movements
          (inventory_item_id,stock_batch_id,tooling_request_id,movement_type,qty,reference,note,user_name)
          VALUES ($1,$2,$3,'reserve',$4,$5,$6,$7)`,
        [request.inventory_item_id, batch.id, request.id, take, request.request_number,
         req.body.note || null, req.user.name]);
        need -= take; reserved += take;
        if (need <= 0) break;
      }
      if (!(reserved > 0)) throw Object.assign(new Error('No free stock is available in this warehouse'), { status: 409 });
      const updated = await refreshRequirementReadiness(qc, oc, request.id, req.user.name, { source: 'rack' });
      await audit('tooling_requirement', request.id, 'reserve_stock', `${reserved} reserved`, qc, req.user.name);
      return { ...updated, reserved_now: reserved, shortage: Math.max(0, need) };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// ── Inventory master and warehouse views ───────────────────────────────────
r.get('/tooling/procurement/:family/inventory', async (req, res, next) => {
  try {
    const family = familyOf(req);
    // Operational Tooling pages only need active masters; Masters asks for the
    // complete register so an inactive Plate or Block can be restored there.
    const activeClause = req.query.all === '1' ? '' : 'AND ti.active=1';
    res.json(await q(`SELECT ti.*, p.name AS product_name, p.code AS product_code,
        pv.name AS preferred_vendor_name,
        COALESCE(st.available,0) AS stock_available,
        COALESCE(st.reserved,0) AS stock_reserved,
        COALESCE(st.available,0)-COALESCE(st.reserved,0) AS stock_free,
        COALESCE(oo.ordered,0) AS stock_ordered,
        ph.last_rate, ph.last_purchase_at, ph.last_vendor_name, COALESCE(ph.purchase_count,0) AS purchase_count
      FROM tooling_inventory_items ti
      LEFT JOIN products p ON p.id=ti.product_id
      LEFT JOIN vendors pv ON pv.id=ti.preferred_vendor_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(b.qty),0) AS available,
          COALESCE((SELECT SUM(a.qty) FROM tooling_stock_allocations a
                    JOIN tooling_stock_batches ab ON ab.id=a.stock_batch_id
                    WHERE ab.inventory_item_id=ti.id AND a.status='active'),0) AS reserved
        FROM tooling_stock_batches b WHERE b.inventory_item_id=ti.id AND b.status='available'
      ) st ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(GREATEST(pl.qty-pl.received_qty,0)),0) AS ordered
        FROM tooling_po_lines pl JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
        WHERE pl.inventory_item_id=ti.id AND po.status IN ('open','partially_received')
      ) oo ON true
      LEFT JOIN LATERAL (
        SELECT pl.rate AS last_rate, g.created_at AS last_purchase_at, v.name AS last_vendor_name,
          (SELECT COUNT(*) FROM tooling_grns cg WHERE cg.inventory_item_id=ti.id AND cg.status='accepted')::int AS purchase_count
        FROM tooling_grns g
        LEFT JOIN tooling_po_lines pl ON pl.id=g.po_line_id
        LEFT JOIN vendors v ON v.id=g.vendor_id
        WHERE g.inventory_item_id=ti.id AND g.status='accepted' ORDER BY g.id DESC LIMIT 1
      ) ph ON true
      WHERE ti.family=$1 ${activeClause} ORDER BY ti.active DESC, ti.name`, [family]));
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/inventory', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Inventory master name is required' });
    const result = await tx(async (qc, oc) => {
      const prefix = `CI-${TOOLING_FAMILY_CODE[family]}-M-`;
      const code = String(req.body.code || '').trim() || await nextNumber(prefix, 'tooling_inventory_items', 'code', oc);
      const key = `${family}|manual|${code}`.toLowerCase();
      const [row] = await qc(`INSERT INTO tooling_inventory_items
        (family,master_key,code,name,product_id,specification,size,tool_type,unit,hsn_code,gst_rate,std_rate,min_stock,preferred_vendor_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [family, key, code, name, req.body.product_id || null, req.body.specification || null,
       req.body.size || null, req.body.tool_type || null, req.body.unit || 'nos', req.body.hsn_code || null,
       Number(req.body.gst_rate) || 0, Number(req.body.std_rate) || 0, Number(req.body.min_stock) || 0,
       req.body.preferred_vendor_id || null]);
      await audit('tooling_inventory_item', row.id, 'create', null, qc, req.user.name);
      return row;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

r.put('/tooling/procurement/:family/inventory/:id', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const allowed = ['name','product_id','specification','size','tool_type','unit','hsn_code','gst_rate','std_rate','min_stock','preferred_vendor_id','active'];
    const cols = allowed.filter(key => req.body[key] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
    const values = cols.map(key => req.body[key] === '' ? null : req.body[key]);
    values.push(req.params.id, family);
    const rows = await q(`UPDATE tooling_inventory_items SET ${cols.map((key, index) => `${key}=$${index + 1}`).join(',')},
      updated_at=now() WHERE id=$${values.length - 1} AND family=$${values.length} RETURNING *`, values);
    if (!rows.length) return res.status(404).json({ error: 'Inventory master not found' });
    await audit('tooling_inventory_item', rows[0].id, 'update', null, q, req.user.name);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

r.get('/tooling/procurement/:family/batches', async (req, res, next) => {
  try {
    const family = familyOf(req);
    res.json(await q(`SELECT b.*, ti.code AS item_code, ti.name AS item_name, ti.unit,
        g.grn_number, v.name AS vendor_name,
        COALESCE((SELECT SUM(a.qty) FROM tooling_stock_allocations a WHERE a.stock_batch_id=b.id AND a.status='active'),0) AS reserved_qty
      FROM tooling_stock_batches b
      JOIN tooling_inventory_items ti ON ti.id=b.inventory_item_id
      LEFT JOIN tooling_grns g ON g.id=b.grn_id
      LEFT JOIN vendors v ON v.id=g.vendor_id
      WHERE ti.family=$1 ORDER BY b.received_at DESC, b.id DESC`, [family]));
  } catch (e) { next(e); }
});

r.get('/tooling/procurement/:family/movements', async (req, res, next) => {
  try {
    const family = familyOf(req);
    res.json(await q(`SELECT m.*, ti.code AS item_code, ti.name AS item_name,
        tr.request_number, g.grn_number
      FROM tooling_stock_movements m
      JOIN tooling_inventory_items ti ON ti.id=m.inventory_item_id
      LEFT JOIN tooling_requests tr ON tr.id=m.tooling_request_id
      LEFT JOIN tooling_grns g ON g.id=m.grn_id
      WHERE ti.family=$1 ORDER BY m.id DESC LIMIT 1000`, [family]));
  } catch (e) { next(e); }
});

r.get('/tooling/procurement/:family/purchase-history', async (req, res, next) => {
  try {
    const family = familyOf(req);
    res.json(await q(`SELECT g.id, g.grn_number, g.created_at, g.accepted_qty AS qty,
        ti.code AS item_code, ti.name AS item_name, ti.unit,
        po.po_number, v.name AS vendor_name, pl.rate
      FROM tooling_grns g
      JOIN tooling_inventory_items ti ON ti.id=g.inventory_item_id
      LEFT JOIN tooling_purchase_orders po ON po.id=g.purchase_order_id
      LEFT JOIN tooling_po_lines pl ON pl.id=g.po_line_id
      LEFT JOIN vendors v ON v.id=g.vendor_id
      WHERE g.family=$1 AND g.status='accepted' ORDER BY g.id DESC`, [family]));
  } catch (e) { next(e); }
});

// ── Purchase Orders ─────────────────────────────────────────────────────────
r.get('/tooling/procurement/:family/purchase-orders', async (req, res, next) => {
  try { res.json(await poRows(familyOf(req))); } catch (e) { next(e); }
});

r.get('/tooling/procurement/:family/purchase-orders/:id', async (req, res, next) => {
  try {
    const rows = await poRows(familyOf(req), Number(req.params.id));
    if (!rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    const company = await one('SELECT * FROM company_profile ORDER BY id LIMIT 1');
    res.json({ ...rows[0], company });
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/purchase-orders', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const vendorId = Number(req.body.vendor_id);
    if (!vendorId) return res.status(400).json({ error: 'Vendor is required' });
    const bodyLines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const requestIds = [...new Set((req.body.request_ids || bodyLines.map(line => line.tooling_request_id)).map(Number).filter(Boolean))];
    if (!requestIds.length && !bodyLines.length) return res.status(400).json({ error: 'Select at least one requirement or inventory item' });
    const result = await tx(async (qc, oc) => {
      const requests = requestIds.length
        ? await qc('SELECT * FROM tooling_requests WHERE id=ANY($1::int[]) AND family=$2 FOR UPDATE', [requestIds, family])
        : [];
      if (requests.length !== requestIds.length) throw Object.assign(new Error('One or more requirements no longer exist'), { status: 409 });
      for (const request of requests) {
        if (request.approval_status !== 'approved') throw Object.assign(new Error(`${request.request_number} must be approved before creating a PO`), { status: 409 });
        if (!request.inventory_item_id) throw Object.assign(new Error(`${request.request_number} has no inventory master`), { status: 409 });
      }
      const prefix = `CI-${TOOLING_FAMILY_CODE[family]}-PO-`;
      const poNumber = await nextNumber(prefix, 'tooling_purchase_orders', 'po_number', oc);
      const [po] = await qc(`INSERT INTO tooling_purchase_orders
        (po_number,family,vendor_id,expected_date,vendor_notes,payment_terms,delivery_terms,reference,tax_kind,freight,round_off,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [poNumber, family, vendorId, req.body.expected_date || null, req.body.vendor_notes || null,
       req.body.payment_terms || null, req.body.delivery_terms || null, req.body.reference || null,
       req.body.tax_kind === 'inter' ? 'inter' : 'intra', Number(req.body.freight) || 0,
       Number(req.body.round_off) || 0, req.user.name]);

      const lineForRequest = new Map(bodyLines.filter(line => line.tooling_request_id).map(line => [Number(line.tooling_request_id), line]));
      const lines = requests.length ? requests.map(request => ({
        ...lineForRequest.get(request.id), tooling_request_id: request.id,
        inventory_item_id: request.inventory_item_id,
        qty: lineForRequest.get(request.id)?.qty || request.qty,
      })) : bodyLines;
      for (const line of lines) {
        const item = await oc('SELECT * FROM tooling_inventory_items WHERE id=$1 AND family=$2', [line.inventory_item_id, family]);
        if (!item) throw Object.assign(new Error('Pick a valid inventory master'), { status: 400 });
        if (!(Number(line.qty) > 0)) throw Object.assign(new Error('Each PO line needs a positive quantity'), { status: 400 });
        await qc(`INSERT INTO tooling_po_lines
          (purchase_order_id,tooling_request_id,inventory_item_id,qty,rate,hsn_code,unit,discount_pct,gst_rate)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [po.id, line.tooling_request_id || null, item.id, Number(line.qty),
         line.rate === '' || line.rate == null ? Number(item.std_rate) || 0 : Number(line.rate) || 0,
         line.hsn_code || item.hsn_code || null, line.unit || item.unit || 'nos',
         Number(line.discount_pct) || 0, line.gst_rate === '' || line.gst_rate == null ? Number(item.gst_rate) || 0 : Number(line.gst_rate) || 0]);
      }
      for (const request of requests) {
        await qc(`UPDATE tooling_requests SET approval_status='converted', status='procurement', source='procurement',
          vendor_id=$1, po_number=$2, updated_at=now() WHERE id=$3`, [vendorId, poNumber, request.id]);
        await requestEvent(qc, request, 'create_po', 'procurement', req.user.name, poNumber);
      }
      await audit('tooling_purchase_order', po.id, 'create', `${poNumber} · ${family}`, qc, req.user.name);
      return po;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/purchase-orders/:id/send', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const rows = await q(`UPDATE tooling_purchase_orders SET sent_at=now(), updated_at=now()
      WHERE id=$1 AND family=$2 RETURNING *`, [req.params.id, family]);
    if (!rows.length) return res.status(404).json({ error: 'Purchase order not found' });
    await audit('tooling_purchase_order', rows[0].id, 'send_vendor', null, q, req.user.name);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/purchase-orders/:id/close', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const rows = await q(`UPDATE tooling_purchase_orders SET status='closed', updated_at=now()
      WHERE id=$1 AND family=$2 AND status<>'received' RETURNING *`, [req.params.id, family]);
    if (!rows.length) return res.status(409).json({ error: 'Only an open purchase order can be closed' });
    await audit('tooling_purchase_order', rows[0].id, 'close', req.body.reason || null, q, req.user.name);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ── GRN / QC ────────────────────────────────────────────────────────────────
r.get('/tooling/procurement/:family/grns', async (req, res, next) => {
  try { res.json(await grnRows(familyOf(req))); } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/grns', canBuy, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const lines = Array.isArray(req.body.lines) ? req.body.lines.filter(line => Number(line.qty) > 0) : [];
    if (!lines.length && !(Number(req.body.inventory_item_id) && Number(req.body.qty) > 0)) {
      return res.status(400).json({ error: 'Enter at least one received quantity' });
    }
    const result = await tx(async (qc, oc) => {
      const created = [];
      const poId = Number(req.body.purchase_order_id) || null;
      const receiveLines = lines.length ? lines : [{ inventory_item_id: req.body.inventory_item_id, qty: req.body.qty, batch_no: req.body.batch_no }];
      for (const input of receiveLines) {
        let poLine = null;
        if (input.po_line_id) {
          poLine = await oc(`SELECT pl.*, po.vendor_id, po.po_number FROM tooling_po_lines pl
            JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
            WHERE pl.id=$1 AND po.family=$2 FOR UPDATE`, [input.po_line_id, family]);
          if (!poLine) throw Object.assign(new Error('Purchase order line not found'), { status: 404 });
          const pending = Number(poLine.qty) - Number(poLine.received_qty);
          if (Number(input.qty) > pending) throw Object.assign(new Error(`Receipt exceeds ${poLine.po_number}'s pending quantity`), { status: 409 });
        }
        const itemId = Number(poLine?.inventory_item_id || input.inventory_item_id);
        const item = await oc('SELECT * FROM tooling_inventory_items WHERE id=$1 AND family=$2', [itemId, family]);
        if (!item) throw Object.assign(new Error('Inventory master not found'), { status: 404 });
        const prefix = `CI-${TOOLING_FAMILY_CODE[family]}-GRN-`;
        const grnNumber = await nextNumber(prefix, 'tooling_grns', 'grn_number', oc);
        const [grn] = await qc(`INSERT INTO tooling_grns
          (grn_number,family,purchase_order_id,po_line_id,tooling_request_id,inventory_item_id,vendor_id,qty,batch_no,
           vehicle_no,supplier_invoice_no,supplier_invoice_date,received_by,remarks,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [grnNumber, family, poLine?.purchase_order_id || poId, poLine?.id || null,
         poLine?.tooling_request_id || input.tooling_request_id || null, item.id,
         poLine?.vendor_id || req.body.vendor_id || null, Number(input.qty), input.batch_no || req.body.batch_no || null,
         req.body.vehicle_no || null, req.body.supplier_invoice_no || null, req.body.supplier_invoice_date || null,
         req.body.received_by || req.user.name, req.body.remarks || null, req.user.name]);
        if (poLine) {
          await qc('UPDATE tooling_po_lines SET received_qty=received_qty+$1 WHERE id=$2', [Number(input.qty), poLine.id]);
          if (poLine.tooling_request_id) {
            const request = await oc('SELECT * FROM tooling_requests WHERE id=$1', [poLine.tooling_request_id]);
            await qc(`UPDATE tooling_requests SET status='received_from_vendor', received_at=now(), grn_number=$1, updated_at=now() WHERE id=$2`, [grnNumber, request.id]);
            await requestEvent(qc, request, 'receive_vendor', 'received_from_vendor', req.user.name, grnNumber);
          }
        }
        created.push(grn);
      }
      if (poId) {
        const poLines = await qc('SELECT qty,received_qty FROM tooling_po_lines WHERE purchase_order_id=$1', [poId]);
        await qc('UPDATE tooling_purchase_orders SET status=$1, updated_at=now() WHERE id=$2', [toolingPoStatus(poLines), poId]);
      }
      for (const grn of created) await audit('tooling_grn', grn.id, 'create', grn.grn_number, qc, req.user.name);
      return created;
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

r.post('/tooling/procurement/:family/grns/:id/qc', canQc, async (req, res, next) => {
  try {
    const family = familyOf(req);
    const result = await tx(async (qc, oc) => {
      const grn = await oc('SELECT * FROM tooling_grns WHERE id=$1 AND family=$2 FOR UPDATE', [req.params.id, family]);
      if (!grn) throw Object.assign(new Error('GRN not found'), { status: 404 });
      if (grn.status !== 'quarantine') throw Object.assign(new Error('QC is already complete for this GRN'), { status: 409 });
      const accepted = req.body.accepted_qty == null ? Number(grn.qty) : Math.max(0, Number(req.body.accepted_qty) || 0);
      const rejected = req.body.rejected_qty == null ? Math.max(0, Number(grn.qty) - accepted) : Math.max(0, Number(req.body.rejected_qty) || 0);
      if (Math.abs(accepted + rejected - Number(grn.qty)) > 0.0001) {
        throw Object.assign(new Error('Accepted and rejected quantities must equal the received quantity'), { status: 400 });
      }
      const status = accepted > 0 ? 'accepted' : 'rejected';
      await qc(`UPDATE tooling_grns SET status=$1, accepted_qty=$2, rejected_qty=$3, qc_by=$4,
        qc_at=now(), rejection_reason=$5 WHERE id=$6`,
      [status, accepted, rejected, req.user.name, req.body.rejection_reason || null, grn.id]);
      let batch = null;
      if (accepted > 0) {
        [batch] = await qc(`INSERT INTO tooling_stock_batches (inventory_item_id,grn_id,batch_no,qty)
                           VALUES ($1,$2,$3,$4) RETURNING *`,
        [grn.inventory_item_id, grn.id, grn.batch_no || grn.grn_number, accepted]);
        await qc(`INSERT INTO tooling_stock_movements
          (inventory_item_id,stock_batch_id,tooling_request_id,grn_id,movement_type,qty,reference,note,user_name)
          VALUES ($1,$2,$3,$4,'receipt',$5,$6,$7,$8)`,
        [grn.inventory_item_id, batch.id, grn.tooling_request_id, grn.id, accepted,
         grn.grn_number, req.body.note || null, req.user.name]);
        if (grn.tooling_request_id) {
          const request = await oc('SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE', [grn.tooling_request_id]);
          const allocated = await activeAllocated(oc, request.id);
          const take = Math.min(accepted, Math.max(0, Number(request.qty) - allocated));
          if (take > 0) {
            await qc(`INSERT INTO tooling_stock_allocations
              (tooling_request_id,stock_batch_id,qty,created_by) VALUES ($1,$2,$3,$4)`,
            [request.id, batch.id, take, req.user.name]);
            await qc(`INSERT INTO tooling_stock_movements
              (inventory_item_id,stock_batch_id,tooling_request_id,grn_id,movement_type,qty,reference,user_name)
              VALUES ($1,$2,$3,$4,'reserve',$5,$6,$7)`,
            [grn.inventory_item_id, batch.id, request.id, grn.id, take, request.request_number, req.user.name]);
          }
          await refreshRequirementReadiness(qc, oc, request.id, req.user.name, { source: 'procurement', grnNumber: grn.grn_number });
        }
      }
      if (rejected > 0) {
        await qc(`INSERT INTO tooling_stock_movements
          (inventory_item_id,tooling_request_id,grn_id,movement_type,qty,reference,note,user_name)
          VALUES ($1,$2,$3,'rejection',$4,$5,$6,$7)`,
        [grn.inventory_item_id, grn.tooling_request_id, grn.id, -rejected, grn.grn_number,
         req.body.rejection_reason || null, req.user.name]);
      }
      await audit('tooling_grn', grn.id, 'qc', `${accepted} accepted · ${rejected} rejected`, qc, req.user.name);
      return { ...grn, status, accepted_qty: accepted, rejected_qty: rejected, batch_id: batch?.id || null };
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Outstanding PO quantities, grouped in the same useful cuts as Procurement.
r.get('/tooling/procurement/:family/pendency', async (req, res, next) => {
  try {
    const family = familyOf(req);
    const lines = await q(`SELECT pl.id, po.po_number, po.created_at, po.expected_date,
        v.id AS vendor_id, v.name AS vendor_name, ti.id AS inventory_item_id,
        ti.code AS item_code, ti.name AS item_name, ti.unit,
        pl.qty, pl.received_qty, GREATEST(pl.qty-pl.received_qty,0) AS pending_qty,
        CASE WHEN now()-po.created_at < interval '8 days' THEN '0-7'
             WHEN now()-po.created_at < interval '16 days' THEN '8-15'
             WHEN now()-po.created_at < interval '31 days' THEN '16-30' ELSE '30+' END AS age_bucket
      FROM tooling_po_lines pl
      JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
      JOIN tooling_inventory_items ti ON ti.id=pl.inventory_item_id
      JOIN vendors v ON v.id=po.vendor_id
      WHERE po.family=$1 AND po.status IN ('open','partially_received') AND pl.received_qty<pl.qty
      ORDER BY po.created_at, pl.id`, [family]);
    const group = key => Object.values(lines.reduce((out, line) => {
      const id = line[key];
      const row = out[id] ||= { id, pending_qty: 0, lines: 0 };
      row.pending_qty += Number(line.pending_qty) || 0;
      row.lines++;
      if (key === 'inventory_item_id') Object.assign(row, { item_code: line.item_code, item_name: line.item_name, unit: line.unit });
      if (key === 'vendor_id') Object.assign(row, { vendor_name: line.vendor_name });
      return out;
    }, {}));
    res.json({ lines, items: group('inventory_item_id'), parties: group('vendor_id') });
  } catch (e) { next(e); }
});

export default r;
