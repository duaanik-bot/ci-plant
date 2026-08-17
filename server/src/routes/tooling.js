// ─── Tooling Hub API ─────────────────────────────────────────────────────────
// One board call (tools + needed-for-jobs rail), CRUD, zone moves with an
// append-only event log, undo, and the auto-flip: a tool arriving in the rack
// re-checks waiting order lines and promotes planned → ready (same pattern as
// the artwork endpoint).
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { plantDateStr } from '../plant-calendar.js';
import { readiness, setLineStatus, nextNumber, nextNumberFrom } from '../helpers.js';
import { requireRole } from '../auth.js';
import { TOOL_FAMILIES, TOOL_ZONES, pushTargets, toolingDetail, toolingGateOk } from '../tooling-gate.js';
import {
  defaultToolingFamilies,
  statusForSource,
  TOOLING_REQUEST_FAMILIES,
  TOOLING_REQUEST_STATUSES,
  TOOLING_SOURCES,
} from '../tooling-requirements.js';
import {
  PHYSICAL_TOOLING_FAMILIES,
  TOOLING_FAMILY_CODE,
  toolingMasterShape,
  toolingRequirementQty,
} from '../tooling-procurement.js';
import { createPlateComponents, gangPlateSpecification, plateMasterForSize } from '../plate-lifecycle.js';
import { artworkVersionOf } from '../plates.js';

const r = Router();
const canManage = requireRole('planner');
const canMove = requireRole('planner', 'production');

const EDIT_COLS = ['title', 'product_id', 'maker', 'condition', 'location', 'notes',
  'ups', 'sheet_size', 'carton_size', 'colors', 'emboss_type', 'shade_ref', 'output_no', 'cylinder_no',
  'creation_date', 'approval_date', 'active'];

const TOOL_VIEW = `
  SELECT t.*, p.name AS product_name, p.code AS product_code, c.name AS customer_name,
         EXTRACT(EPOCH FROM (now() - t.zone_since))::bigint AS zone_seconds,
         im.name AS issued_machine_name, ijc.jc_number AS issued_jc_number,
         le.action AS last_action, le.user_name AS last_user, le.at AS last_at
  FROM tools t
  LEFT JOIN products p ON p.id = t.product_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN machines im ON im.id = t.issued_machine_id
  LEFT JOIN job_cards ijc ON ijc.id = t.issued_job_card_id
  LEFT JOIN LATERAL (SELECT action, user_name, at FROM tool_events
                     WHERE tool_id = t.id ORDER BY id DESC LIMIT 1) le ON true`;

// Per-family sequential codes (DIE-0001 …). Migrated dies keep their real
// numbers, so we scan only rows that match our own prefix — and take the
// HIGHEST of them, never the newest. Reading the newest row meant one migrated
// code with no trailing digits restarted the family at 0001 and collided from
// then on; POST /tools also accepts a typed code, so junk in the column is not
// hypothetical. Same rule as helpers.js nextNumber(), plus the family filter.
async function nextToolCode(family, oc = one) {
  const prefix = TOOL_FAMILIES[family].prefix;
  const row = await oc(
    `SELECT code FROM tools
      WHERE family = $1 AND left(code, length($2)) = $2
        AND substr(code, length($2) + 1) ~ '^[0-9]+$'
      ORDER BY length(code) DESC, code DESC LIMIT 1`,
    [family, prefix]);
  return nextNumberFrom(prefix, row ? [row.code] : []);
}

const FAMILY_LABEL = {
  plate: 'Plates', die: 'Dies', block: 'Blocks', shade_card: 'Shade Cards',
};

async function ensureInventoryItem(qc, oc, family, target, specification) {
  if (!PHYSICAL_TOOLING_FAMILIES.includes(family)) return null;
  // Plates use two controlled size masters. Colour belongs to the individual
  // requirement/asset row, never to a product-specific aggregate SKU.
  if (family === 'plate') {
    const master = await plateMasterForSize(oc, specification.plate_size || specification.sheet_size);
    return master ? oc('SELECT * FROM tooling_inventory_items WHERE id=$1', [master.inventory_item_id]) : null;
  }
  const shape = toolingMasterShape(family, {
    productId: target.product_id,
    productName: target.name,
    productCode: target.code,
    specification,
  });
  const existing = await oc('SELECT * FROM tooling_inventory_items WHERE master_key=$1', [shape.masterKey]);
  if (existing) return existing;
  const prefix = `CI-${TOOLING_FAMILY_CODE[family]}-M-`;
  const code = await nextNumber(prefix, 'tooling_inventory_items', 'code', oc);
  const [created] = await qc(`INSERT INTO tooling_inventory_items
    (family, master_key, code, name, product_id, specification, size, tool_type, unit)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [family, shape.masterKey, code, shape.name, target.product_id, shape.specification || null,
   shape.size, shape.toolType, shape.unit]);
  return created;
}

const REQUEST_VIEW = `
  SELECT tr.*, jc.jc_number, jc.queue_pos, jc.machine_id,
         p.name AS product_name, p.code AS product_code,
         p.party_artwork_code, p.party_item_code, p.die_number,
         p.tool_id AS product_tool_id,
         c.name AS customer_name, o.po_number AS sales_po_number,
         o.delivery_date, m.name AS machine_name,
         t.code AS tool_code, t.title AS tool_title, t.location AS tool_location,
         t.condition AS tool_condition, t.zone AS tool_zone,
         sc.sc_number, sc.status AS shade_status,
         v.name AS vendor_name,
         ti.code AS inventory_code, ti.name AS inventory_name,
         ti.specification AS inventory_specification, ti.size AS inventory_size,
         ti.tool_type AS inventory_type, ti.unit AS inventory_unit,
         COALESCE(ws.available, 0) AS stock_available,
         COALESCE(ws.reserved, 0) AS stock_reserved,
         COALESCE(ws.available, 0) - COALESCE(ws.reserved, 0) AS stock_free,
         COALESCE(oo.ordered, 0) AS stock_ordered,
         GREATEST(COALESCE(ws.available, 0) - COALESCE(ws.reserved, 0), COALESCE(av.available_count, 0)) AS available_rack_count,
         le.action AS last_action, le.note AS last_note,
         le.user_name AS last_user, le.at AS last_at
  FROM tooling_requests tr
  JOIN job_cards jc ON jc.id = tr.job_card_id
  JOIN products p ON p.id = tr.product_id
  LEFT JOIN order_lines ol ON ol.id = tr.order_line_id
  LEFT JOIN orders o ON o.id = ol.order_id
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN machines m ON m.id = jc.machine_id
  LEFT JOIN tools t ON t.id = tr.tool_id
  LEFT JOIN shade_cards sc ON sc.id = tr.shade_card_id
  LEFT JOIN vendors v ON v.id = tr.vendor_id
  LEFT JOIN tooling_inventory_items ti ON ti.id = tr.inventory_item_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(tsb.qty),0) AS available,
           COALESCE((SELECT SUM(tsa.qty) FROM tooling_stock_allocations tsa
                     JOIN tooling_stock_batches ab ON ab.id=tsa.stock_batch_id
                     WHERE ab.inventory_item_id=tr.inventory_item_id AND tsa.status='active'),0) AS reserved
    FROM tooling_stock_batches tsb
    WHERE tsb.inventory_item_id=tr.inventory_item_id AND tsb.status='available'
  ) ws ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(GREATEST(tpl.qty-tpl.received_qty,0)),0) AS ordered
    FROM tooling_po_lines tpl
    JOIN tooling_purchase_orders tpo ON tpo.id=tpl.purchase_order_id
    WHERE tpl.inventory_item_id=tr.inventory_item_id AND tpo.status IN ('open','partially_received')
  ) oo ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS available_count FROM tools at
    WHERE at.active=1 AND at.family=tr.family
      AND (at.product_id=tr.product_id OR (at.family='die' AND at.id=p.tool_id))
      AND at.zone='in_rack' AND at.condition IN ('Good','Fair')
  ) av ON true
  LEFT JOIN LATERAL (
    SELECT action, note, user_name, at FROM tooling_request_events tre
    WHERE tre.tooling_request_id=tr.id ORDER BY tre.id DESC LIMIT 1
  ) le ON true`;

async function requestTargets(jobCardId, qc = q, oc = one) {
  const jc = await oc(`SELECT id, jc_number, order_line_id, gang_run_id, finalised_at, status
                       FROM job_cards WHERE id=$1`, [jobCardId]);
  if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
  const params = [jc.order_line_id, jc.gang_run_id];
  const rows = await qc(`
    SELECT ol.id AS order_line_id, ol.order_id, ol.product_id, ol.spec_override,
           o.po_number, o.delivery_date, p.*, c.name AS customer_name
    FROM order_lines ol
    JOIN orders o ON o.id=ol.order_id
    JOIN products p ON p.id=ol.product_id
    LEFT JOIN customers c ON c.id=p.customer_id
    WHERE ($1::int IS NOT NULL AND ol.id=$1)
       OR ($1::int IS NULL AND $2::int IS NOT NULL AND ol.gang_run_id=$2)
    ORDER BY ol.id`, params);
  const seen = new Set();
  const targets = rows.flatMap(row => {
    if (seen.has(row.product_id)) return [];
    seen.add(row.product_id);
    const override = row.spec_override && typeof row.spec_override === 'object' ? row.spec_override : {};
    return [{ ...row, ...override, order_line_id: row.order_line_id, product_id: row.product_id }];
  });
  const stages = await qc('SELECT stage FROM job_stages WHERE job_card_id=$1 ORDER BY seq', [jc.id]);
  const gang = jc.gang_run_id
    ? await oc('SELECT id,gang_number,output_number,kind FROM gang_runs WHERE id=$1', [jc.gang_run_id])
    : null;
  return { jc, gang, targets, stages: stages.map(s => s.stage) };
}

function requestSpec(target) {
  const spec = {
    product_name: target.name,
    product_code: target.code,
    party_artwork_code: target.party_artwork_code || null,
    party_item_code: target.party_item_code || null,
    output_number: target.output_number || null,
    die_number: target.die_number || null,
    block_number: target.block_number || null,
    colors: target.colors ?? null,
    colour_type: target.colour_type || null,
    print_process: target.print_process || null,
    cmyk_colours: target.cmyk_colours ?? null,
    pantone_colours: target.pantone_colours ?? null,
    pantone_codes: target.pantone_codes || null,
    metallic_colours: target.metallic_colours ?? null,
    metallic_details: target.metallic_details || null,
    plate_size: target.plate_size || null,
    ups: target.ups ?? null,
    size: target.size || null,
    child_l: target.child_l ?? null,
    child_w: target.child_w ?? null,
    special: target.special || 'none',
    emboss: !!+target.emboss,
    leafing: !!+target.leafing,
    leafing_colour: target.leafing_colour || null,
    shade_card_number: target.shade_card_number || null,
  };
  return { ...spec, artwork_version: artworkVersionOf(spec) };
}

async function logRequestEvent(qc, request, action, toStatus, req, note = null) {
  await qc(`INSERT INTO tooling_request_events
    (tooling_request_id, action, from_status, to_status, source, tool_id, vendor_id, note, user_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [request.id, action, request.status || null, toStatus || request.status || null,
   request.source || null, request.tool_id || null, request.vendor_id || null,
   note || null, req.user.name]);
}

// A tool reached the rack: promote every planned, artwork-locked line of the
// linked product whose full gate now passes. Returns how many flipped.
async function autoFlip(tool, qc, oc, user) {
  const lines = await qc(`
    SELECT ol.* FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.status = 'planned' AND ol.artwork_locked = 1
      AND (p.id = $1 OR p.tool_id = $2)`,
    [tool.product_id ?? -1, tool.id]);
  let flipped = 0;
  for (const line of lines) {
    const gate = await readiness(line, oc);
    if (gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
      await setLineStatus(line.id, 'ready', qc, oc, user);
      flipped++;
    }
  }
  return flipped;
}

// ── Requirement queues ─────────────────────────────────────────────────────
r.get('/tooling/requirements', async (req, res, next) => {
  try {
    const wh = [];
    const params = [];
    if (req.query.family) {
      if (!TOOLING_REQUEST_FAMILIES.includes(req.query.family)) {
        return res.status(400).json({ error: 'Unknown tooling family' });
      }
      params.push(req.query.family); wh.push(`tr.family=$${params.length}`);
    }
    if (req.query.status) {
      if (!TOOLING_REQUEST_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ error: 'Unknown tooling status' });
      }
      params.push(req.query.status); wh.push(`tr.status=$${params.length}`);
    }
    const rows = await q(`${REQUEST_VIEW}
      ${wh.length ? `WHERE ${wh.join(' AND ')}` : ''}
      ORDER BY CASE tr.status
        WHEN 'pending' THEN 0 WHEN 'lost_damaged' THEN 1 WHEN 'procurement' THEN 2
        WHEN 'vendor_assigned' THEN 3 WHEN 'sent_to_vendor' THEN 4 WHEN 'in_house' THEN 5 ELSE 6 END,
        o.delivery_date NULLS LAST, tr.id DESC`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

r.get('/tooling/requirements/summary', async (_req, res, next) => {
  try {
    const rows = await q(`SELECT family, status, COUNT(*)::int AS count
                          FROM tooling_requests GROUP BY family, status`);
    const out = Object.fromEntries(TOOLING_REQUEST_FAMILIES.map(f => [f, {
      total: 0, open: 0, pending: 0, ready: 0,
    }]));
    for (const row of rows) {
      const bucket = out[row.family];
      if (!bucket) continue;
      bucket.total += row.count;
      bucket[row.status] = row.count;
      if (!['ready','issued_to_floor','returned_to_rack','cancelled','replaced'].includes(row.status)) {
        bucket.open += row.count;
      }
    }
    res.json(out);
  } catch (e) { next(e); }
});

r.get('/tooling/requirements/events', async (req, res, next) => {
  try {
    const params = [];
    const where = req.query.family
      ? (params.push(req.query.family), `WHERE tr.family=$${params.length}`) : '';
    res.json(await q(`SELECT tre.*, tr.request_number, tr.family,
        jc.jc_number, p.name AS product_name, p.code AS product_code,
        t.code AS tool_code, v.name AS vendor_name
      FROM tooling_request_events tre
      JOIN tooling_requests tr ON tr.id=tre.tooling_request_id
      JOIN job_cards jc ON jc.id=tr.job_card_id
      JOIN products p ON p.id=tr.product_id
      LEFT JOIN tools t ON t.id=tre.tool_id
      LEFT JOIN vendors v ON v.id=tre.vendor_id
      ${where} ORDER BY tre.id DESC LIMIT 500`, params));
  } catch (e) { next(e); }
});

r.get('/tooling/requirements/:id/events', async (req, res, next) => {
  try {
    res.json(await q(`SELECT tre.*, t.code AS tool_code, v.name AS vendor_name
      FROM tooling_request_events tre
      LEFT JOIN tools t ON t.id=tre.tool_id
      LEFT JOIN vendors v ON v.id=tre.vendor_id
      WHERE tre.tooling_request_id=$1 ORDER BY tre.id DESC`, [req.params.id]));
  } catch (e) { next(e); }
});

r.get('/job-cards/:id/tooling-preview', async (req, res, next) => {
  try {
    const { jc, targets, stages } = await requestTargets(req.params.id);
    const defaults = defaultToolingFamilies({ stages, products: targets });
    const existing = await q(`SELECT family, product_id, status, id
                              FROM tooling_requests WHERE job_card_id=$1`, [jc.id]);
    const reasons = {
      plate: stages.includes('printing') ? 'Printing route requires a plate set' : 'Available by manual selection',
      die: stages.includes('die_cutting') ? 'Die-cutting route requires a die' : 'Available by manual selection',
      block: defaults.includes('block') ? 'Embossing or foil work requires a block' : 'No embossing or foil in the current route',
      shade_card: stages.includes('printing') ? 'Printing requires a released shade standard' : 'Available by manual selection',
    };
    res.json({
      job_card: { id: jc.id, jc_number: jc.jc_number, finalised_at: jc.finalised_at, status: jc.status },
      defaults,
      targets: targets.map(t => ({
        order_line_id: t.order_line_id, product_id: t.product_id,
        product_name: t.name, product_code: t.code,
        po_number: t.po_number, customer_name: t.customer_name,
      })),
      options: TOOLING_REQUEST_FAMILIES.map(family => ({
        family, label: FAMILY_LABEL[family], selected: defaults.includes(family),
        reason: reasons[family], existing: existing.filter(x => x.family === family).length,
      })),
    });
  } catch (e) { next(e); }
});

// Idempotent fan-out: one request per job, member product and family. Reopening
// the same dialog later reports existing work instead of duplicating it.
r.post('/job-cards/:id/tooling-requirements', canManage, async (req, res, next) => {
  try {
    const wanted = [...new Set((req.body.families || []).filter(f => TOOLING_REQUEST_FAMILIES.includes(f)))];
    if (!wanted.length) return res.status(400).json({ error: 'Select at least one Tooling Hub module' });
    const out = await tx(async (qc, oc) => {
      const { jc, gang, targets } = await requestTargets(req.params.id, qc, oc);
      if (!jc.finalised_at) throw Object.assign(new Error('Finalise the Job Card before forwarding tooling'), { status: 409 });
      if (jc.status === 'closed') throw Object.assign(new Error('A closed Job Card cannot create tooling work'), { status: 409 });
      const created = [], existing = [];
      for (const family of wanted) {
        const familyTargets = family === 'plate' && gang && targets.length
          ? [{
              ...targets[0],
              order_line_id: null,
              specification: gangPlateSpecification(gang, targets),
              delivery_date: targets.map(row => row.delivery_date).filter(Boolean).sort()[0] || null,
              gang_plate: true,
            }]
          : targets;
        for (const target of familyTargets) {
          const have = await oc(`SELECT * FROM tooling_requests
                                 WHERE job_card_id=$1 AND family=$3
                                   AND ($4::boolean OR product_id=$2)`,
          [jc.id, target.product_id, family, !!target.gang_plate]);
          if (have) { existing.push(have); continue; }
          const requestNumber = await nextNumber('CI-TR-', 'tooling_requests', 'request_number', oc);
          const specification = target.specification || requestSpec(target);
          const inventoryItem = await ensureInventoryItem(qc, oc, family, target, specification);
          const requiredQty = toolingRequirementQty(family, specification);
          let shadeCard = null;
          if (family === 'shade_card') {
            shadeCard = await oc(`SELECT id, status FROM shade_cards
              WHERE active=1 AND product_id=$1
              ORDER BY (order_line_id=$2) DESC, (status='approved') DESC, id DESC LIMIT 1`,
            [target.product_id, target.order_line_id]);
          }
          const [row] = await qc(`INSERT INTO tooling_requests
            (request_number, job_card_id, order_line_id, product_id, family,
             shade_card_id, inventory_item_id, qty, needed_by, specification, created_by, approval_status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [requestNumber, jc.id, target.order_line_id, target.product_id, family,
           shadeCard?.id || null, inventoryItem?.id || null, requiredQty,
           target.delivery_date || null, specification, req.user.name, family === 'plate' ? 'draft' : 'pending']);
          await logRequestEvent(qc, row, 'forwarded_from_job_card', family === 'plate' ? 'draft' : 'pending', req,
            `${jc.jc_number} forwarded to ${FAMILY_LABEL[family]}${target.gang_plate ? ` as ${gang.gang_number}` : ''}`);
          if (family === 'plate') await createPlateComponents(qc, oc, row);
          created.push(row);
        }
      }
      return { created, existing, modules: wanted, target_count: targets.length };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.put('/tooling/requirements/:id', canManage, async (req, res, next) => {
  try {
    const allowed = ['needed_by','rack_location','vendor_id','vendor_reference','pr_number',
      'po_number','grn_number','notes','qty','tool_id','shade_card_id'];
    const out = await tx(async (qc, oc) => {
      const current = await oc('SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!current) throw Object.assign(new Error('Tooling request not found'), { status: 404 });
      const cols = allowed.filter(c => req.body[c] !== undefined);
      if (!cols.length) return current;
      const values = cols.map(c => req.body[c] === '' ? null : req.body[c]);
      const sets = cols.map((c, i) => `${c}=$${i + 1}`);
      values.push(current.id);
      const [updated] = await qc(`UPDATE tooling_requests SET ${sets.join(', ')}, updated_at=now()
                                  WHERE id=$${values.length} RETURNING *`, values);
      await logRequestEvent(qc, updated, 'details_updated', updated.status, req, req.body.note || null);
      return updated;
    });
    res.json(out);
  } catch (e) { next(e); }
});

const ACTIONS = new Set([
  'choose_source','create_pr','create_po','send_vendor','receive_vendor','record_grn',
  'create_shade_card','mark_ready','issue_floor','return_rack','cancel','replace','lost_damaged',
]);

r.post('/tooling/requirements/:id/actions', canMove, async (req, res, next) => {
  try {
    const action = req.body.action;
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown tooling action' });
    const out = await tx(async (qc, oc) => {
      let current = await oc('SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!current) throw Object.assign(new Error('Tooling request not found'), { status: 404 });
      const note = String(req.body.note || '').trim() || null;
      const update = async (status, fields = {}) => {
        const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
        const values = [status, ...entries.map(([, value]) => value === '' ? null : value), current.id];
        const sets = entries.map(([key], i) => `${key}=$${i + 2}`);
        const [fresh] = await qc(`UPDATE tooling_requests SET status=$1,
          ${sets.length ? `${sets.join(', ')},` : ''} updated_at=now()
          WHERE id=$${values.length} RETURNING *`, values);
        await logRequestEvent(qc, { ...fresh, status: current.status }, action, status, req, note);
        current = fresh;
        return fresh;
      };

      if (action === 'choose_source') {
        const source = req.body.source;
        if (!TOOLING_SOURCES.includes(source)) throw Object.assign(new Error('Choose a valid fulfilment source'), { status: 400 });
        if (source === 'rack' && current.family !== 'shade_card' && !req.body.tool_id) {
          throw Object.assign(new Error('Choose the rack tool to reserve'), { status: 400 });
        }
        if (source === 'rack' && current.family === 'shade_card' && !current.shade_card_id) {
          throw Object.assign(new Error('Create or link a Shade Card before reserving it from storage'), { status: 400 });
        }
        if (source === 'vendor' && !req.body.vendor_id) {
          throw Object.assign(new Error('Choose the vendor to assign'), { status: 400 });
        }
        return update(statusForSource(source), {
          source, tool_id: req.body.tool_id || null, vendor_id: req.body.vendor_id || null,
          rack_location: req.body.rack_location, notes: note || current.notes,
        });
      }
      if (action === 'create_pr') {
        const pr = req.body.pr_number?.trim() || await nextNumber('CI-TPR-', 'tooling_requests', 'pr_number', oc);
        return update('procurement', { source: 'procurement', pr_number: pr, notes: note || current.notes });
      }
      if (action === 'create_po') {
        const po = req.body.po_number?.trim() || await nextNumber('CI-TPO-', 'tooling_requests', 'po_number', oc);
        return update('procurement', { source: 'procurement', po_number: po,
          vendor_id: req.body.vendor_id || current.vendor_id, notes: note || current.notes });
      }
      if (action === 'send_vendor') {
        const vendorId = req.body.vendor_id || current.vendor_id;
        if (!vendorId) throw Object.assign(new Error('Choose a vendor before sending the tooling'), { status: 400 });
        return update('sent_to_vendor', {
          source: 'vendor', vendor_id: vendorId,
          vendor_reference: req.body.vendor_reference || current.vendor_reference,
          sent_at: new Date(), notes: note || current.notes,
        });
      }
      if (action === 'receive_vendor') return update('received_from_vendor', {
        received_at: new Date(), notes: note || current.notes,
      });
      if (action === 'record_grn') {
        const grn = req.body.grn_number?.trim() || await nextNumber('CI-TGRN-', 'tooling_requests', 'grn_number', oc);
        return update('grn_completed', { grn_number: grn, received_at: current.received_at || new Date(), notes: note || current.notes });
      }
      if (action === 'create_shade_card') {
        if (current.family !== 'shade_card') throw Object.assign(new Error('This action is only for Shade Cards'), { status: 400 });
        if (current.shade_card_id) return current;
        const line = await oc(`SELECT ol.*, o.id AS order_id, o.customer_id FROM order_lines ol
                               JOIN orders o ON o.id=ol.order_id WHERE ol.id=$1`, [current.order_line_id]);
        if (!line) throw Object.assign(new Error('This request has no Sales Order line for the Shade Card'), { status: 409 });
        const product = await oc('SELECT * FROM products WHERE id=$1', [current.product_id]);
        const spec = current.specification || {};
        const number = await nextNumber('CI-SC-', 'shade_cards', 'sc_number', oc);
        const [card] = await qc(`INSERT INTO shade_cards
          (sc_number,title,product_id,customer_id,order_line_id,print_process,colour_system,
           num_colours,artwork_no,output_no,creation_date,remarks,created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [number, `${product.name} shade card`, product.id, line.customer_id, line.id,
         product.print_process || null, spec.colour_type || product.colour_type || null,
         spec.colors || product.colors || null, spec.party_artwork_code || product.party_artwork_code || null,
         spec.output_number || product.output_number || null, plantDateStr(),
         `Created from ${current.request_number}${note ? ` · ${note}` : ''}`, req.user.name]);
        await qc(`INSERT INTO shade_card_events (shade_card_id,action,to_status,note,user_name)
                  VALUES ($1,'created','draft',$2,$3)`, [card.id, `from ${current.request_number}`, req.user.name]);
        await qc(`INSERT INTO shade_card_orders (shade_card_id,order_id) VALUES ($1,$2)
                  ON CONFLICT DO NOTHING`, [card.id, line.order_id]);
        return update('pending', { shade_card_id: card.id, notes: note || current.notes });
      }
      if (action === 'mark_ready') {
        let tool = null;
        if (current.family === 'shade_card') {
          let card = current.shade_card_id
            ? await oc('SELECT * FROM shade_cards WHERE id=$1 AND active=1', [current.shade_card_id]) : null;
          card ||= await oc(`SELECT * FROM shade_cards WHERE product_id=$1 AND active=1
                             ORDER BY (status='approved') DESC, id DESC LIMIT 1`, [current.product_id]);
          if (!card || card.status !== 'approved') {
            throw Object.assign(new Error('Approve the linked Shade Card before marking this requirement ready'), { status: 409 });
          }
          current.shade_card_id = card.id;
        } else {
          if (!current.source) {
            throw Object.assign(new Error('Choose rack, in-house, vendor or procurement before marking this requirement ready'), { status: 409 });
          }
          if (current.source === 'vendor' && !['received_from_vendor','grn_completed'].includes(current.status)) {
            throw Object.assign(new Error('Receive the tooling from the vendor before marking it ready'), { status: 409 });
          }
          if (current.source === 'procurement' && current.status !== 'grn_completed') {
            throw Object.assign(new Error('Complete the vendor receipt and GRN before marking procured tooling ready'), { status: 409 });
          }
          tool = current.tool_id ? await oc('SELECT * FROM tools WHERE id=$1', [current.tool_id]) : null;
          if (!tool) {
            const spec = current.specification || {};
            const code = await nextToolCode(current.family, oc);
            [tool] = await qc(`INSERT INTO tools
              (family,code,title,product_id,zone,maker,condition,location,ups,carton_size,colors,emboss_type,output_no,notes)
              VALUES ($1,$2,$3,$4,'in_rack',$5,'Good',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [current.family, code, `${spec.product_name || 'Product'} — ${FAMILY_LABEL[current.family]}`,
             current.product_id, current.source === 'in_house' ? 'In-house' : null,
             current.rack_location || null, spec.ups || null, spec.size || null,
             spec.colors || null, spec.special || null, spec.output_number || null,
             `Created from ${current.request_number}`]);
            await qc(`INSERT INTO tool_events (tool_id,action,to_zone,note,user_name)
                      VALUES ($1,'created','in_rack',$2,$3)`, [tool.id, `from ${current.request_number}`, req.user.name]);
          } else {
            if (!tool.active || ['Poor','Scrapped'].includes(tool.condition)) {
              throw Object.assign(new Error(`${tool.code} is not healthy enough to release`), { status: 409 });
            }
            if (tool.zone !== 'in_rack' && tool.zone !== 'on_floor') {
              await qc(`UPDATE tools SET zone='in_rack', zone_since=now() WHERE id=$1`, [tool.id]);
              await qc(`INSERT INTO tool_events (tool_id,action,from_zone,to_zone,note,user_name)
                        VALUES ($1,'moved',$2,'in_rack',$3,$4)`,
              [tool.id, tool.zone, `Ready for ${current.request_number}`, req.user.name]);
              tool = { ...tool, zone: 'in_rack' };
            }
          }
        }
        const ready = await update('ready', {
          tool_id: tool?.id || current.tool_id || null,
          shade_card_id: current.shade_card_id || null,
          rack_location: tool?.location || current.rack_location,
          ready_at: new Date(), ready_by: req.user.name, notes: note || current.notes,
        });
        const linesReady = tool ? await autoFlip(tool, qc, oc, req.user.name) : 0;
        return { ...ready, lines_ready: linesReady };
      }
      if (action === 'issue_floor') {
        if (!current.tool_id) throw Object.assign(new Error('Link a ready rack tool before issuing it'), { status: 409 });
        const tool = await oc('SELECT * FROM tools WHERE id=$1', [current.tool_id]);
        await qc(`UPDATE tools SET zone='on_floor',zone_since=now(),issued_job_card_id=$1,
                  issued_at=now(),issued_operator=$2 WHERE id=$3`,
        [current.job_card_id, req.body.operator || req.user.name, tool.id]);
        await qc(`INSERT INTO tool_events (tool_id,action,from_zone,to_zone,note,user_name)
                  VALUES ($1,'issued',$2,'on_floor',$3,$4)`, [tool.id, tool.zone, note, req.user.name]);
        return update('issued_to_floor', { notes: note || current.notes });
      }
      if (action === 'return_rack') {
        if (!current.tool_id) throw Object.assign(new Error('No physical tool is linked'), { status: 409 });
        const tool = await oc('SELECT * FROM tools WHERE id=$1', [current.tool_id]);
        await qc(`UPDATE tools SET zone='in_rack',zone_since=now(),issued_job_card_id=NULL,
                  issued_at=NULL,issued_operator=NULL WHERE id=$1`, [tool.id]);
        await qc(`INSERT INTO tool_events (tool_id,action,from_zone,to_zone,note,user_name)
                  VALUES ($1,'returned',$2,'in_rack',$3,$4)`, [tool.id, tool.zone, note, req.user.name]);
        return update('returned_to_rack', { rack_location: tool.location || current.rack_location, notes: note || current.notes });
      }
      if (action === 'cancel') return update('cancelled', { notes: note || current.notes });
      if (action === 'replace') return update('replaced', { notes: note || current.notes });
      if (action === 'lost_damaged') {
        if (current.tool_id) await qc(`UPDATE tools SET condition='Poor' WHERE id=$1`, [current.tool_id]);
        return update('lost_damaged', { notes: note || current.notes });
      }
      return current;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Board: tools + needed-for-jobs, one call ────────────────────────────────
r.get('/tooling/board', async (_req, res, next) => {
  try {
    const tools = await q(`${TOOL_VIEW} WHERE t.active = 1 ORDER BY t.zone_since DESC`);

    const lines = await q(`
      SELECT ol.id, ol.product_id, ol.tooling_ok, ol.spec_override,
             o.po_number, o.delivery_date, c.name AS customer_name,
             p.name AS product_name, p.code AS product_code, p.special, p.tool_id
      FROM order_lines ol
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN products p ON p.id = ol.product_id
      WHERE ol.status IN ('planned','ready') AND ol.artwork_locked = 1
      ORDER BY o.delivery_date NULLS LAST, ol.id`);

    const every = await q('SELECT * FROM tools WHERE active = 1');
    const needed = [];
    for (const l of lines) {
      const ov = typeof l.spec_override === 'string' ? JSON.parse(l.spec_override) : l.spec_override;
      const product = { id: l.product_id, special: ov?.special ?? l.special, tool_id: l.tool_id };
      const mine = every.filter(t => t.product_id === l.product_id || t.id === l.tool_id);
      const detail = toolingDetail(product, mine);
      if (toolingGateOk(detail, l.tooling_ok)) continue;
      needed.push({
        line_id: l.id, po_number: l.po_number, customer_name: l.customer_name,
        product_id: l.product_id, product_name: l.product_name,
        product_code: l.product_code, delivery_date: l.delivery_date,
        gaps: detail.filter(d => (d.hard ? d.status !== 'ready' : d.status === 'not_ready')),
      });
    }
    res.json({ tools, needed });
  } catch (e) { next(e); }
});

// ── Flat list (ledger, pickers) ─────────────────────────────────────────────
r.get('/tools', async (req, res, next) => {
  try {
    const wh = ['t.active = 1'];
    const params = [];
    if (req.query.family) { params.push(req.query.family); wh.push(`t.family = $${params.length}`); }
    if (req.query.product_id) { params.push(+req.query.product_id); wh.push(`t.product_id = $${params.length}`); }
    res.json(await q(`${TOOL_VIEW} WHERE ${wh.join(' AND ')} ORDER BY t.code`, params));
  } catch (e) { next(e); }
});

r.get('/tools/:id/events', async (req, res, next) => {
  try {
    res.json(await q('SELECT * FROM tool_events WHERE tool_id=$1 ORDER BY id DESC', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Create ──────────────────────────────────────────────────────────────────
r.post('/tools', canManage, async (req, res, next) => {
  try {
    const { family, code, title } = req.body;
    if (!TOOL_FAMILIES[family]) return res.status(400).json({ error: 'Unknown tool family' });
    if (!title?.trim()) return res.status(400).json({ error: 'Tool needs a name' });
    const out = await tx(async (qc, oc) => {
      const finalCode = code?.trim() || await nextToolCode(family, oc);
      const dup = await oc('SELECT id FROM tools WHERE code=$1', [finalCode]);
      if (dup) throw Object.assign(new Error(`Code ${finalCode} already exists`), { status: 409 });
      const [t] = await qc(`
        INSERT INTO tools (family, code, title, product_id, maker, condition, location, notes,
                           ups, sheet_size, carton_size, colors, emboss_type, shade_ref, output_no, cylinder_no,
                           creation_date, approval_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [family, finalCode, title.trim(), req.body.product_id || null, req.body.maker || null,
         req.body.condition || 'Good', req.body.location || null, req.body.notes || null,
         req.body.ups || null, req.body.sheet_size || null, req.body.carton_size || null,
         req.body.colors || null, req.body.emboss_type || null, req.body.shade_ref || null,
         req.body.output_no || null, req.body.cylinder_no || null,
         req.body.creation_date || null, req.body.approval_date || null]);
      await qc(`INSERT INTO tool_events (tool_id, action, to_zone, user_name)
                VALUES ($1,'created','incoming',$2)`, [t.id, req.user.name]);
      return t;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Push from the Artwork Queue ─────────────────────────────────────────────
// Fan one product out into several sections' triage (the Incoming zone) at
// once. The send-decision then happens inside each section.
//
// The send is NEVER refused. This door used to skip any family that already had
// an active tool row and reply "Already in hub" — which read a plate sitting in
// Incoming as a plate the plant holds, then used that to block asking for it
// again. A row in the pipeline is paperwork, not a plate: pushTargets() draws
// that line with toolReady(), the gate's own rule.
//
// Each send writes its OWN row, so a re-send stands as a separate line beside
// the pending one. Nothing is folded into an existing row — the pipeline is a
// list of things asked for, and two asks are two lines.
r.post('/tools/push', canManage, async (req, res, next) => {
  try {
    const { product_id, families } = req.body;
    const pid = +product_id;
    if (!pid) return res.status(400).json({ error: 'A product is required' });
    const want = [...new Set((families || []).filter(f => TOOL_FAMILIES[f]))];
    if (!want.length) return res.status(400).json({ error: 'Pick at least one section to push' });
    const out = await tx(async (qc, oc) => {
      const prod = await oc('SELECT id, name, code, ups, colors FROM products WHERE id=$1', [pid]);
      if (!prod) throw Object.assign(new Error('Product not found'), { status: 404 });
      const held = await qc('SELECT * FROM tools WHERE product_id=$1 AND active=1', [pid]);
      const created = [], present = [], pending = [];
      for (const target of pushTargets(want, held)) {
        const { family, label } = target;
        const code = await nextToolCode(family, oc);
        const [t] = await qc(`
          INSERT INTO tools (family, code, title, product_id, ups, colors)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [family, code, `${prod.name} — ${label}`, pid,
           family === 'die' ? (prod.ups || null) : null,
           family === 'plate' ? (prod.colors || null) : null]);
        await qc(`INSERT INTO tool_events (tool_id, action, to_zone, user_name)
                  VALUES ($1,'created','incoming',$2)`, [t.id, req.user.name]);
        created.push({ family, code, label });
        // Reported, never enforced — the modal shows both before the button is
        // pressed, which is where the judgement belongs.
        for (const o of target.present) present.push({ family, label, code: o.code, zone: o.zone });
        for (const o of target.pending) pending.push({ family, label, code: o.code, zone: o.zone });
      }
      return { created, present, pending };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Edit spec / condition / link ────────────────────────────────────────────
r.put('/tools/:id', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const cols = EDIT_COLS.filter(c => req.body[c] !== undefined);
      if (!cols.length) return t;
      const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
      const vals = cols.map(c => (req.body[c] === '' ? null : req.body[c]));
      const [fresh] = await qc(`UPDATE tools SET ${sets} WHERE id=$${cols.length + 1} RETURNING *`,
        [...vals, t.id]);
      if (req.body.condition && req.body.condition !== t.condition) {
        await qc(`INSERT INTO tool_events (tool_id, action, note, user_name)
                  VALUES ($1,'condition',$2,$3)`,
          [t.id, `${t.condition} → ${req.body.condition}`, req.user.name]);
      }
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Zone move (the lifecycle) ───────────────────────────────────────────────
r.post('/tools/:id/move', canMove, async (req, res, next) => {
  try {
    const { zone, note } = req.body;
    if (!TOOL_ZONES.includes(zone)) return res.status(400).json({ error: 'Unknown zone' });
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      if (t.zone === zone) throw Object.assign(new Error(`Already in ${zone}`), { status: 409 });
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'moved',$2,$3,$4,$5)`,
        [t.id, t.zone, zone, note || null, req.user.name]);
      const lines_ready = zone === 'in_rack' ? await autoFlip(fresh, qc, oc, req.user.name) : 0;
      return { ...fresh, lines_ready };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Undo the last move ──────────────────────────────────────────────────────
r.post('/tools/:id/undo', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      const ev = await oc(`SELECT * FROM tool_events WHERE tool_id=$1 AND action='moved'
                           ORDER BY id DESC LIMIT 1`, [t.id]);
      if (!ev || t.zone !== ev.to_zone) {
        throw Object.assign(new Error('Nothing to undo'), { status: 409 });
      }
      const [fresh] = await qc(
        'UPDATE tools SET zone=$1, zone_since=now() WHERE id=$2 RETURNING *', [ev.from_zone, t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, to_zone, note, user_name)
                VALUES ($1,'undo',$2,$3,'Reversed last move',$4)`,
        [t.id, ev.to_zone, ev.from_zone, req.user.name]);
      return fresh;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Delete (soft — keeps the event log & product link, so gate history and
// any accidental removal stay recoverable; the board simply hides active=0) ──
r.delete('/tools/:id', canManage, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const t = await oc('SELECT * FROM tools WHERE id=$1', [req.params.id]);
      if (!t) throw Object.assign(new Error('Tool not found'), { status: 404 });
      if (!t.active) return t; // already gone — idempotent
      const [fresh] = await qc('UPDATE tools SET active=0 WHERE id=$1 RETURNING *', [t.id]);
      await qc(`INSERT INTO tool_events (tool_id, action, from_zone, note, user_name)
                VALUES ($1,'deleted',$2,'Removed from board',$3)`,
        [t.id, t.zone, req.user.name]);
      return fresh;
    });
    res.json({ ok: true, id: out.id });
  } catch (e) { next(e); }
});

// Shade cards moved to the Shade Card Management module (2026-07-15) — the
// Direct-Issue-to-Print / Return-to-Vault dock and its print-stations feed now
// live in routes/shadecards.js against the shade_cards table.

export default r;
