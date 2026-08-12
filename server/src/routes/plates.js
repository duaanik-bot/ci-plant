import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, nextNumber, notify, outputNumberSql } from '../helpers.js';
import { plateReplacementRecipients } from '../approvals.js';
import { requireRole } from '../auth.js';
import {
  APPROVABLE_COMPONENT_STATUSES, artworkVersionOf, canUnapprovePlateRequest,
  defaultPlateSize, expandPlateQuantities, FRESH_PLATES_RACK, isBareArtworkRevision,
  plateArtworkIsRevisionSql, plateArtworkKey, plateArtworkKeySql, plateArtworkMatchSql,
  plateComponentKey, plateComponentsFromSpec,
  issuedPlateSummary, latestTimestamp, plateQuantityBreakdown, plateReadinessSummary, plateReturnSetKey, plateSizeOf,
  RACK_CLAIMABLE_COMPONENT_STATUSES, rackReusePlan, resolvePlateRate,
  USED_PLATES_RACK, pickAvailableRackPlates, validatePlateReplacementRequest, validateReturnVerification,
} from '../plates.js';
import {
  bestPlateCandidate, createPlateComponents, issuedPlatesForStage,
  PLATE_ALREADY_CLAIMED_SQL, syncPlateRequest,
} from '../plate-lifecycle.js';
import { toolingPoStatus } from '../tooling-procurement.js';

const r = Router();
const canBuy = requireRole('planner');
const canVerify = requireRole('planner', 'qc');

function componentsByRequest(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.tooling_request_id) || [];
    list.push(row);
    grouped.set(row.tooling_request_id, list);
  }
  return grouped;
}

const plateBreakdownText = rows => plateQuantityBreakdown(rows)
  .map(row => `${row.component_label} x${row.qty}`).join(', ');

function summarizePlateSet(rows = []) {
  const sorted = [...rows].sort((a, b) => Number(a.sequence_no || a.id) - Number(b.sequence_no || b.id));
  const first = sorted[0] || {};
  const statuses = sorted.map(row => row.status);
  const locations = [...new Set(sorted.map(row => row.rack_location).filter(Boolean))];
  const conditions = [...new Set(sorted.map(row => row.condition).filter(Boolean))];
  const components = sorted.map(row => ({
    id: row.id,
    asset_id: row.id,
    asset_number: row.asset_number,
    component_type: row.component_type,
    component_label: row.component_label,
    pantone_code: row.pantone_code || null,
    status: row.status,
    condition: row.condition,
    // Age travels with the individual plate, never the set: the whole point of one
    // row per physical plate is that three of a set may be fresh and the fourth
    // nearly finished. The card's own use_count is the set's WORST case.
    use_count: Number(row.use_count) || 0,
    last_used_at: row.last_used_at || null,
    plate_created_on: row.plate_created_on || null,
  }));
  return {
    ...first,
    id: first.id,
    asset_ids: sorted.map(row => row.id),
    asset_numbers: sorted.map(row => row.asset_number).filter(Boolean),
    asset_number: sorted.length > 1 ? `${sorted.length} plate set` : first.asset_number,
    component_label: sorted.map(row => row.component_label).filter(Boolean).join(', '),
    contains: sorted.map(row => row.component_label).filter(Boolean).join(', '),
    components,
    qty: sorted.length,
    status: statuses.every(status => status === statuses[0]) ? statuses[0] : 'mixed',
    rack_location: locations.length === 1 ? locations[0] : locations.length ? 'Mixed locations' : null,
    condition: conditions.length === 1 ? conditions[0] : conditions.length ? 'Mixed' : null,
    use_count: Math.max(0, ...sorted.map(row => Number(row.use_count) || 0)),
    last_used_at: latestTimestamp(sorted.map(row => row.last_used_at)),
    age_days: Math.max(0, ...sorted.map(row => Number(row.age_days) || 0)),
  };
}

function groupPlateSets(rows = [], keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()].map(summarizePlateSet);
}

async function addRequestEvent(qc, requestId, action, fromStatus, toStatus, note, userName, source = null, vendorId = null) {
  await qc(`INSERT INTO tooling_request_events
    (tooling_request_id,action,from_status,to_status,source,vendor_id,note,user_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [requestId, action, fromStatus || null, toStatus || null, source, vendorId, note || null, userName]);
}

async function releaseDraftPlateAssets(qc, request, components, userName, note) {
  const reserved = components.filter(row => row.matched_asset_id);
  for (const component of reserved) {
    const [asset] = await qc(`UPDATE plate_assets SET status='available',current_job_card_id=NULL,updated_at=now()
      WHERE id=$1 AND status='reserved' AND current_job_card_id=$2 RETURNING *`,
    [component.matched_asset_id, request.job_card_id]);
    if (!asset) continue;
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,
       from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,'adjustment','reserved','available',$5,$5,$6,$7,$8)`,
    [asset.id, component.id, request.id, request.job_card_id, asset.rack_location,
     asset.condition, note, userName]);
  }
}

async function deletePlateRequirements(qc, oc, requestIds, reason, userName) {
  const requests = await qc(`SELECT * FROM tooling_requests
    WHERE id=ANY($1::int[]) AND family='plate' ORDER BY id FOR UPDATE`, [requestIds]);
  if (requests.length !== requestIds.length) {
    throw Object.assign(new Error('One or more selected Plate PRs no longer exist'), { status: 404 });
  }
  const locked = requests.find(row => !['draft','saved','pending'].includes(row.approval_status));
  if (locked) {
    throw Object.assign(new Error(`Unapprove ${locked.request_number} before deleting it`), { status: 409 });
  }
  const components = await qc(`SELECT * FROM plate_request_components
    WHERE tooling_request_id=ANY($1::int[]) ORDER BY tooling_request_id,sequence_no FOR UPDATE`, [requestIds]);
  const downstream = components.find(row => row.po_line_id || row.grn_id
    || ['po_created','ordered','grn_received','issued','returned_pending_verification'].includes(row.status));
  const activePo = await oc(`SELECT tr.id AS request_id,tr.request_number,po.po_number
    FROM tooling_po_lines pl
    JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
    JOIN tooling_requests tr ON tr.id=pl.tooling_request_id
    WHERE pl.tooling_request_id=ANY($1::int[]) AND po.status<>'reversed' LIMIT 1`, [requestIds]);
  const issued = requests.find(row => row.status === 'issued_to_floor');
  if (downstream || activePo || issued) {
    const blocked = requests.find(row => row.id === Number(activePo?.request_id || downstream?.tooling_request_id || issued?.id));
    const requestNumber = blocked?.request_number || activePo?.request_number || 'A selected Plate PR';
    throw Object.assign(new Error(`${requestNumber} has downstream activity${activePo ? ` on ${activePo.po_number}` : ''}. Reverse GRN, PO and approval before deleting it.`), { status: 409 });
  }
  for (const request of requests) {
    await releaseDraftPlateAssets(qc, request,
      components.filter(row => row.tooling_request_id === request.id), userName,
      `Released before deleting ${request.request_number}`);
  }
  const deleted = await qc(`DELETE FROM tooling_requests
    WHERE id=ANY($1::int[]) AND family='plate' RETURNING id,request_number`, [requestIds]);
  for (const request of requests) {
    const requestComponents = components.filter(row => row.tooling_request_id === request.id);
    const detail = `${request.request_number} · ${plateBreakdownText(requestComponents)} · ${reason}`;
    await audit('tooling_requirement', request.id, 'delete', detail, qc, userName);
  }
  return { ok: true, deleted: deleted.length, request_numbers: deleted.map(row => row.request_number) };
}

// artworkVersionOf (plates.js) as SQL, for the one query that has to resolve a
// requirement's artwork version inside the database rather than in JS. NULLIF +
// btrim because the JS side runs each candidate through clean(): without them a
// specification carrying an empty-string artwork_version would beat a real
// party_artwork_code here and nowhere else.
const ARTWORK_VERSION_SQL = `COALESCE(
  NULLIF(btrim(tr.specification->>'artwork_version'),''),
  NULLIF(btrim(tr.specification->>'party_artwork_code'),''),
  NULLIF(btrim(tr.specification->>'output_number'),''),'Unversioned')`;

async function componentRows(where = '', values = []) {
  return q(`SELECT prc.*, pm.plate_size,pm.hsn_code AS plate_hsn_code,pm.gst_rate AS plate_gst_rate,
      pa.asset_number AS proposed_asset_number, pa.rack_location AS proposed_rack_location,
      pa.condition AS proposed_condition, pa.last_used_at AS proposed_last_used_at,
      pa.use_count AS proposed_use_count, pa.artwork_version AS proposed_artwork_version,
      ma.asset_number AS matched_asset_number, ma.rack_location AS matched_rack_location,
      (SELECT COUNT(*)::int FROM plate_assets old
       WHERE old.product_id=tr.product_id AND old.component_type=prc.component_type
         AND lower(COALESCE(old.pantone_code,''))=lower(COALESCE(prc.pantone_code,''))
         -- The exact COMPLEMENT of the reuse match, built from the same helper.
         -- Spelled as its own inequality it called plates "superseded artwork"
         -- while the Use-from-Rack button was offering to spend them, because the
         -- two comparisons disagreed about "PCS-W026/R1" versus "R1".
         AND NOT ${plateArtworkMatchSql('old.artwork_version',
    plateArtworkKeySql(ARTWORK_VERSION_SQL), plateArtworkIsRevisionSql(ARTWORK_VERSION_SQL))}
         AND old.status='available' AND old.active=1) AS older_artwork_count
    FROM plate_request_components prc
    JOIN tooling_requests tr ON tr.id=prc.tooling_request_id
    LEFT JOIN plate_masters pm ON pm.id=prc.plate_master_id
    LEFT JOIN plate_assets pa ON pa.id=prc.proposed_asset_id
    LEFT JOIN plate_assets ma ON ma.id=prc.matched_asset_id
    ${where} ORDER BY prc.tooling_request_id,prc.sequence_no`, values);
}

// The size a Plate PR is actually working to. The components carry it once the PR
// has been saved; a draft carries nothing, and `suggested_plate_master_id` is
// deliberately NOT used as a stand-in — it is the form's default, not a fact about
// the PR, and filtering the rack by a size nobody has chosen yet would hide plates
// that ARE on the rack. No size means no size filter, which is exactly what
// bestPlateCandidate does with the same value.
const requestPlateMasterId = (components = []) =>
  components.find(row => row.plate_master_id)?.plate_master_id || null;

// What the rack can give each open Plate PR, asked live on every read.
//
// The artwork version is resolved here in JS by artworkVersionOf — the very
// function bestPlateCandidate uses — and carried into the query, rather than
// re-spelled as a COALESCE over the specification. Two spellings of an artwork
// version would be two definitions of "the same plate", and only one of them
// would be the one the reuse button acts on.
async function rackAvailabilityByRequest(requests = []) {
  const wanted = requests.filter(row => row.product_id);
  if (!wanted.length) return new Map();
  const versions = wanted.map(row => artworkVersionOf(row.specification || {}));
  const rows = await q(`SELECT want.request_id, pa.component_type,
      COALESCE(pa.pantone_code,'') AS pantone_code, COUNT(*)::int AS available
    FROM unnest($1::int[],$2::int[],$3::text[],$4::bool[],$5::int[])
      AS want(request_id,product_id,artwork_key,artwork_is_revision,plate_master_id)
    JOIN plate_assets pa ON pa.product_id=want.product_id
      AND ${plateArtworkMatchSql('pa.artwork_version', 'want.artwork_key', 'want.artwork_is_revision')}
      AND (want.plate_master_id IS NULL OR pa.plate_master_id=want.plate_master_id)
      AND pa.status='available' AND pa.active=1 AND pa.condition IN ('Good','Fair')
      AND NOT ${PLATE_ALREADY_CLAIMED_SQL}
    GROUP BY 1,2,3`,
  [wanted.map(row => Number(row.id)), wanted.map(row => Number(row.product_id)),
   versions.map(plateArtworkKey), versions.map(isBareArtworkRevision),
   wanted.map(row => requestPlateMasterId(row.components) || null)]);
  const byRequest = new Map();
  for (const row of rows) {
    const list = byRequest.get(row.request_id) || [];
    list.push({ component_type: row.component_type, pantone_code: row.pantone_code || null, available: row.available });
    byRequest.set(row.request_id, list);
  }
  return byRequest;
}

// What number to print on a PLATE — a physical object, not a job.
//
// The job-side rule (helpers.js outputNumberSql) resolves live, because a job's
// number can still be edited. A plate cannot: `plate_assets.output_number` is
// stamped at GRN from the requirement that bought it, and that is what is
// physically associated with the aluminium on the rack. So the asset's own
// number always wins, and the requirement it came from is the fallback for
// legacy rows stamped before that column was filled.
//
// The master is the LAST resort and is refused to a gang, for the same reason
// the job-side rule refuses it: several different cartons share one gang plate,
// so one member's master number on it is a lie. An unnamed gang shows blank.
// One spelling — every asset query below uses this const.
const ASSET_OUTPUT_NUMBER = spec => `COALESCE(
  NULLIF(pa.output_number,''),
  NULLIF(${spec}.specification->>'output_number',''),
  CASE WHEN COALESCE((${spec}.specification->>'is_gang')::boolean,false)
       THEN NULL ELSE NULLIF(p.output_number,'') END)`;

async function requirementRows(id = null) {
  const values = [];
  const idWhere = id ? (values.push(id), `AND tr.id=$${values.length}`) : '';
  const rows = await q(`SELECT tr.*,jc.jc_number,jc.machine_id,m.name AS machine_name,
      p.name AS product_name,p.code AS product_code,p.party_item_code,p.party_artwork_code,
      p.output_number AS product_output_number,
      -- The plant's one output-number rule (helpers.js). It used to be spelled by
      -- hand here as spec -> gang -> master, which put a MEMBER's master number on
      -- an unnamed gang's Plate PR — a sheet carrying several cartons named after
      -- one of them. The rule keys on the run KIND and lets a gang resolve to
      -- nothing instead.
      ${outputNumberSql({ override: `ol.spec_override->>'output_number'`, run: 'gr', product: 'p' })} AS output_number,
      gr.id AS gang_run_id,gr.gang_number,gr.output_number AS gang_output_number,gr.kind AS gang_kind,
      p.colors AS master_colors,p.colour_type AS master_colour_type,
      p.cmyk_colours AS master_cmyk_colours,p.pantone_colours AS master_pantone_colours,
      p.pantone_codes AS master_pantone_codes,p.print_process AS master_print_process,
      p.metallic_colours AS master_metallic_colours,p.metallic_details AS master_metallic_details,
      c.name AS customer_name,o.po_number AS sales_po_number,o.delivery_date
    FROM tooling_requests tr
    JOIN job_cards jc ON jc.id=tr.job_card_id
    JOIN products p ON p.id=tr.product_id
    JOIN customers c ON c.id=p.customer_id
    LEFT JOIN machines m ON m.id=jc.machine_id
    LEFT JOIN gang_runs gr ON gr.id=jc.gang_run_id
    LEFT JOIN order_lines ol ON ol.id=tr.order_line_id
    LEFT JOIN orders o ON o.id=ol.order_id
    WHERE tr.family='plate' ${idWhere}
    ORDER BY CASE tr.status WHEN 'pending' THEN 0 WHEN 'rack_reserved' THEN 1
      WHEN 'procurement' THEN 2 WHEN 'ready' THEN 4 ELSE 3 END,
      o.delivery_date NULLS LAST,tr.id DESC`, values);
  if (!rows.length) return rows;
  let components = await componentRows('WHERE prc.tooling_request_id=ANY($1::int[])', [rows.map(row => row.id)]);
  const have = new Set(components.map(row => row.tooling_request_id));
  const missing = rows.filter(row => !have.has(row.id));
  // Requirements created by the earlier Tooling Hub acquire the new child
  // records lazily and idempotently; no historical parent is deleted.
  for (const request of missing) {
    await tx(async (qc, oc) => {
      const locked = await oc(`SELECT * FROM tooling_requests WHERE id=$1 AND family='plate' FOR UPDATE`, [request.id]);
      const exists = await oc('SELECT 1 FROM plate_request_components WHERE tooling_request_id=$1 LIMIT 1', [request.id]);
      if (locked && !exists) await createPlateComponents(qc, oc, locked);
    });
  }
  if (missing.length) components = await componentRows('WHERE prc.tooling_request_id=ANY($1::int[])', [rows.map(row => row.id)]);
  const grouped = componentsByRequest(components);
  const rackFree = await rackAvailabilityByRequest(
    rows.map(row => ({ ...row, components: grouped.get(row.id) || [] })));
  const defaults = await one(`SELECT
    (SELECT id FROM plate_masters WHERE active=1 AND lower(plate_size)='560 x 670' ORDER BY id LIMIT 1) AS metallic_master_id,
    (SELECT id FROM plate_masters WHERE active=1 AND lower(plate_size)='600 x 730' ORDER BY id LIMIT 1) AS offset_master_id,
    (SELECT id FROM vendors WHERE active=1 AND lower(trim(name))='kansal graphics' ORDER BY id LIMIT 1) AS vendor_id`);
  const shaped = rows.map(row => {
    const requestComponents = grouped.get(row.id) || [];
    const suggestedSize = defaultPlateSize(row.specification || {}, requestComponents);
    const productMasterComponents = plateComponentsFromSpec({
      colors: row.master_colors,
      colour_type: row.master_colour_type,
      cmyk_colours: row.master_cmyk_colours,
      pantone_colours: row.master_pantone_colours,
      pantone_codes: row.master_pantone_codes,
      print_process: row.master_print_process,
      metallic_colours: row.master_metallic_colours,
      metallic_details: row.master_metallic_details,
    });
    const isGang = row.specification?.is_gang === true || !!row.gang_run_id;
    const gangMembers = Array.isArray(row.specification?.gang_members) ? row.specification.gang_members : [];
    return {
      ...row,
      is_gang: isGang,
      lead_product_name: isGang ? row.product_name : null,
      lead_product_code: isGang ? row.product_code : null,
      product_name: isGang ? (row.gang_number || row.specification?.gang_number || 'Gang Plate') : row.product_name,
      product_code: isGang ? (row.gang_number || row.specification?.gang_number || row.product_code) : row.product_code,
      customer_name: isGang ? `${gangMembers.length || 1} gang products` : row.customer_name,
      gang_members: gangMembers,
      components: requestComponents,
      component_breakdown: plateQuantityBreakdown(requestComponents),
      plate_summary: plateReadinessSummary(requestComponents),
      // The live warehouse answer, per colour and as one headline. The screen
      // prints it and the Use-from-Rack button spends exactly it.
      rack_reuse: rackReusePlan({
        components: requestComponents, available: rackFree.get(row.id) || [],
      }),
      product_master_components: productMasterComponents,
      product_master_colour_count: productMasterComponents.length,
      suggested_plate_size: suggestedSize,
      suggested_plate_master_id: suggestedSize === '560 x 670'
        ? defaults?.metallic_master_id || null : defaults?.offset_master_id || null,
      suggested_vendor_id: defaults?.vendor_id || null,
    };
  });
  if (id && shaped[0]) {
    shaped[0].events = await q(`SELECT * FROM tooling_request_events
      WHERE tooling_request_id=$1 ORDER BY id DESC`, [shaped[0].id]);
  }
  return shaped;
}

async function platePoRows() {
  const orders = await q(`SELECT po.*,v.name AS vendor_name,v.address AS vendor_address,
      v.city AS vendor_city,v.state AS vendor_state,v.gstin AS vendor_gstin
    FROM tooling_purchase_orders po JOIN vendors v ON v.id=po.vendor_id
    WHERE po.family='plate' ORDER BY po.id DESC`);
  if (!orders.length) return [];
  const lines = await q(`SELECT pl.*,tr.request_number,jc.jc_number,
      COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
      COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
      ${outputNumberSql({ run: 'gr', product: 'p' })} AS output_number,
      COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
      tr.specification->'gang_members' AS gang_members,
      pm.plate_size,COALESCE(json_agg(json_build_object(
        'id',prc.id,'component_label',prc.component_label,'status',prc.status,'pantone_code',prc.pantone_code
      ) ORDER BY prc.sequence_no) FILTER (WHERE prc.id IS NOT NULL),'[]'::json) AS components
    FROM tooling_po_lines pl
    LEFT JOIN tooling_requests tr ON tr.id=pl.tooling_request_id
    LEFT JOIN job_cards jc ON jc.id=tr.job_card_id
    LEFT JOIN gang_runs gr ON gr.id=jc.gang_run_id
    LEFT JOIN products p ON p.id=tr.product_id
    LEFT JOIN plate_request_components prc ON prc.po_line_id=pl.id
    LEFT JOIN plate_masters pm ON pm.id=prc.plate_master_id
    WHERE pl.purchase_order_id=ANY($1::int[])
    GROUP BY pl.id,tr.request_number,jc.jc_number,tr.specification,p.name,p.code,p.output_number,
      gr.output_number,gr.kind,pm.plate_size
    ORDER BY pl.id`, [orders.map(row => row.id)]);
  const byOrder = new Map();
  for (const line of lines) {
    const list = byOrder.get(line.purchase_order_id) || [];
    list.push(line); byOrder.set(line.purchase_order_id, list);
  }
  return orders.map(order => ({ ...order, lines: byOrder.get(order.id) || [] }));
}

// Controlled masters: initially two sizes; additional sizes may be added later.
r.get('/plate-masters', async (_req, res, next) => {
  try {
    res.json(await q(`SELECT pm.*,v.name AS preferred_vendor_name,
        ph.last_purchase_rate,ph.last_purchase_date,COALESCE(ph.purchase_count,0) AS purchase_count,
        COALESCE(st.available,0) AS stock_available,COALESCE(st.reserved,0) AS stock_reserved
      FROM plate_masters pm
      LEFT JOIN vendors v ON v.id=pm.preferred_vendor_id
      LEFT JOIN LATERAL (
        SELECT pa.purchase_rate AS last_purchase_rate,pa.plate_created_on AS last_purchase_date,
          COUNT(*) OVER ()::int AS purchase_count
        FROM plate_assets pa WHERE pa.plate_master_id=pm.id AND pa.source_grn_id IS NOT NULL
        ORDER BY pa.id DESC LIMIT 1) ph ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE status='available')::int AS available,
          COUNT(*) FILTER (WHERE status='reserved')::int AS reserved
        FROM plate_assets pa WHERE pa.plate_master_id=pm.id AND pa.active=1) st ON true
      ORDER BY pm.active DESC,pm.plate_size`));
  } catch (error) { next(error); }
});

r.post('/plate-masters', canBuy, async (req, res, next) => {
  try {
    const plateSize = plateSizeOf({ plate_size: req.body.plate_size });
    if (!plateSize) return res.status(400).json({ error: 'Enter a plate size as width x height' });
    const result = await tx(async (qc, oc) => {
      const code = String(req.body.code || '').trim() || await nextNumber('CI-PL-M-', 'plate_masters', 'code', oc);
      const key = `plate-size|${plateSize.replace(/\s*x\s*/i, 'x').toLowerCase()}`;
      let item = await oc('SELECT * FROM tooling_inventory_items WHERE master_key=$1', [key]);
      if (!item) {
        [item] = await qc(`INSERT INTO tooling_inventory_items
          (family,master_key,code,name,specification,size,tool_type,unit,hsn_code,gst_rate,preferred_vendor_id)
          VALUES ('plate',$1,$2,$3,$4,$5,'Offset plate','nos',$6,$7,$8) RETURNING *`,
        [key, code, `Printing Plate ${plateSize}`, 'Controlled plate size; colour is an asset attribute',
         plateSize, req.body.hsn_code || null, Number(req.body.gst_rate) || 0, req.body.preferred_vendor_id || null]);
      }
      const [master] = await qc(`INSERT INTO plate_masters
        (code,plate_size,allowed_components,inventory_item_id,preferred_vendor_id,hsn_code,gst_rate,
         standard_lead_time_days,remarks,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [code, plateSize, req.body.allowed_components || ['cyan','magenta','yellow','black','pantone'],
       item.id, req.body.preferred_vendor_id || null, req.body.hsn_code || null,
       Number(req.body.gst_rate) || 0, Number(req.body.standard_lead_time_days) || 0,
       req.body.remarks || null, req.body.active === 0 ? 0 : 1]);
      await audit('plate_master', master.id, 'create', plateSize, qc, req.user.name);
      return master;
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

r.put('/plate-masters/:id', canBuy, async (req, res, next) => {
  try {
    const allowed = ['preferred_vendor_id','hsn_code','gst_rate','standard_lead_time_days','remarks','active','allowed_components'];
    const columns = allowed.filter(key => req.body[key] !== undefined);
    if (!columns.length) return res.status(400).json({ error: 'Nothing to update' });
    const values = columns.map(key => req.body[key] === '' ? null : req.body[key]);
    values.push(req.params.id);
    const [row] = await q(`UPDATE plate_masters SET ${columns.map((key,index) => `${key}=$${index + 1}`).join(',')},
      updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
    if (!row) return res.status(404).json({ error: 'Plate Master not found' });
    await audit('plate_master', row.id, 'update', null, q, req.user.name);
    res.json(row);
  } catch (error) { next(error); }
});

r.delete('/plate-masters/:id', canBuy, async (req, res, next) => {
  try {
    const used = await one('SELECT 1 FROM plate_assets WHERE plate_master_id=$1 LIMIT 1', [req.params.id]);
    if (used) return res.status(409).json({ error: 'This size has plate history. Mark it inactive instead.' });
    const [row] = await q('DELETE FROM plate_masters WHERE id=$1 RETURNING *', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Plate Master not found' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

r.get('/plates/requirements', async (_req, res, next) => {
  try { res.json(await requirementRows()); } catch (error) { next(error); }
});

r.get('/plates/requirements/:id', async (req, res, next) => {
  try {
    const [row] = await requirementRows(Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Plate requirement not found' });
    res.json(row);
  } catch (error) { next(error); }
});

// Save is deliberately separate from approval. Each requested quantity is
// expanded to one component row per physical plate so later GRN, issue and
// return movements stay individually traceable.
r.put('/plates/requirements/:id', canBuy, async (req, res, next) => {
  try {
    const plateMasterId = Number(req.body.plate_master_id);
    if (!plateMasterId) return res.status(400).json({ error: 'Choose a Plate Master size' });
    const expanded = expandPlateQuantities(Array.isArray(req.body.components) ? req.body.components : []);
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      if (!['draft','saved','pending'].includes(request.approval_status)) {
        throw Object.assign(new Error('Unapprove this Plate PR before editing it'), { status: 409 });
      }
      const master = await oc('SELECT * FROM plate_masters WHERE id=$1 AND active=1', [plateMasterId]);
      if (!master) throw Object.assign(new Error('Choose an active Plate Master size'), { status: 400 });
      const invalid = expanded.find(row => !master.allowed_components.includes(row.component_type));
      if (invalid) throw Object.assign(new Error(`${invalid.component_label} is not enabled for ${master.plate_size}`), { status: 409 });

      const current = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 ORDER BY sequence_no FOR UPDATE`, [request.id]);
      const downstream = current.find(row => row.po_line_id || row.grn_id
        || ['po_created','ordered','grn_received','issued','returned_pending_verification'].includes(row.status));
      if (downstream || request.po_number) {
        throw Object.assign(new Error('This Plate PR has downstream purchasing or floor activity. Reverse it one stage at a time before editing.'), { status: 409 });
      }
      const before = plateBreakdownText(current) || 'No plates';
      const currentKeys = current.map(plateComponentKey).sort();
      const nextKeys = expanded.map(plateComponentKey).sort();
      const sameStructure = current.length === expanded.length
        && current.every(row => Number(row.plate_master_id) === master.id)
        && currentKeys.every((key, index) => key === nextKeys[index]);
      if (!sameStructure) {
        await releaseDraftPlateAssets(qc, request, current, req.user.name, `Released while editing ${request.request_number}`);
        await qc('DELETE FROM plate_request_components WHERE tooling_request_id=$1', [request.id]);
      }
      const [saved] = await qc(`UPDATE tooling_requests SET
        qty=$1,inventory_item_id=$2,vendor_id=$3,notes=$4,
        specification=jsonb_set(COALESCE(specification,'{}'::jsonb),'{plate_size}',to_jsonb($5::text),true),
        approval_status='saved',saved_by=$6,saved_at=now(),approved_by=NULL,approved_at=NULL,
        status='pending',source=NULL,ready_at=NULL,ready_by=NULL,updated_at=now()
        WHERE id=$7 RETURNING *`,
      [expanded.length, master.inventory_item_id, req.body.vendor_id || null,
       String(req.body.notes || '').trim() || null, master.plate_size, req.user.name, request.id]);
      const created = sameStructure ? current : await createPlateComponents(qc, oc, saved, {
        components: expanded, plateMasterId: master.id,
      });
      const after = plateBreakdownText(created);
      await syncPlateRequest(qc, oc, request.id, req.user.name);
      await addRequestEvent(qc, request.id,
        request.approval_status === 'draft' ? 'requirement_saved' : 'requirement_edited',
        request.approval_status, 'saved', `${before} -> ${after}${saved.notes ? ` · ${saved.notes}` : ''}`,
        req.user.name, 'procurement', saved.vendor_id);
      await audit('tooling_requirement', request.id, 'save', after, qc, req.user.name);
      return { request_id: request.id, saved: created.length, plate_size: master.plate_size };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.post('/plates/requirements/:id/unapprove', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Record why this Plate PR is being unapproved' });
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      if (request.approval_status !== 'approved') {
        throw Object.assign(new Error('Only an approved Plate PR can be unapproved'), { status: 409 });
      }
      const components = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 ORDER BY sequence_no FOR UPDATE`, [request.id]);
      // Same predicate the row button asks before it offers Unapprove at all.
      if (!canUnapprovePlateRequest({ ...request, components })) {
        throw Object.assign(new Error('Reverse the Plate PO before unapproving this PR'), { status: 409 });
      }
      await qc(`UPDATE plate_request_components SET
        status=CASE WHEN status='approved' THEN COALESCE(approval_from_status,'pr_required') ELSE status END,
        approved_by=NULL,approved_at=NULL,approval_from_status=NULL,updated_at=now()
        WHERE tooling_request_id=$1`, [request.id]);
      await qc(`UPDATE tooling_requests SET approval_status='saved',approved_by=NULL,approved_at=NULL,
        saved_by=$1,saved_at=now(),status='pending',source=NULL,updated_at=now() WHERE id=$2`,
      [req.user.name, request.id]);
      await syncPlateRequest(qc, oc, request.id, req.user.name);
      await addRequestEvent(qc, request.id, 'unapprove', 'approved', 'saved', reason, req.user.name);
      await audit('tooling_requirement', request.id, 'unapprove', reason, qc, req.user.name);
      return { request_id: request.id, approval_status: 'saved' };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Matches Procurement's delete right: authorised buyers may remove an
// unconverted PR. Active PO/GRN/floor work must be reversed first.
r.delete('/plates/requirements/bulk', canBuy, async (req, res, next) => {
  try {
    const requestIds = [...new Set((req.body.request_ids || []).map(Number).filter(Boolean))];
    const reason = String(req.body.reason || '').trim();
    if (!requestIds.length) return res.status(400).json({ error: 'Choose at least one Plate PR to delete' });
    if (!reason) return res.status(400).json({ error: 'Record why these Plate PRs are being deleted' });
    const result = await tx((qc, oc) => deletePlateRequirements(qc, oc, requestIds, reason, req.user.name));
    res.json(result);
  } catch (error) { next(error); }
});

r.delete('/plates/requirements/:id', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Record why this Plate PR is being deleted' });
    const result = await tx((qc, oc) => deletePlateRequirements(qc, oc, [Number(req.params.id)], reason, req.user.name));
    res.json({ ...result, request_number: result.request_numbers[0] });
  } catch (error) { next(error); }
});

r.post('/plates/components/:id/verify-existing', canVerify, async (req, res, next) => {
  try {
    const outcome = String(req.body.outcome || '');
    if (!['usable','not_found','damaged','scrap','replacement'].includes(outcome)) {
      return res.status(400).json({ error: 'Choose a physical verification outcome' });
    }
    const result = await tx(async (qc, oc) => {
      const component = await oc(`SELECT prc.*,tr.job_card_id,tr.request_number,tr.specification
        FROM plate_request_components prc JOIN tooling_requests tr ON tr.id=prc.tooling_request_id
        WHERE prc.id=$1 FOR UPDATE OF prc`, [req.params.id]);
      if (!component) throw Object.assign(new Error('Plate component not found'), { status: 404 });
      if (!component.proposed_asset_id) throw Object.assign(new Error('No existing plate is proposed for this component'), { status: 409 });
      const asset = await oc('SELECT * FROM plate_assets WHERE id=$1 FOR UPDATE', [component.proposed_asset_id]);
      if (!asset) throw Object.assign(new Error('The proposed plate no longer exists'), { status: 409 });
      Object.assign(component, {
        asset_status: asset.status, asset_condition: asset.condition,
        rack_location: asset.rack_location, artwork_version: asset.artwork_version,
      });
      if (outcome === 'usable') {
        const checks = ['found','condition_ok','artwork_ok','colour_ok','size_ok'];
        if (checks.some(key => !req.body[key])) {
          throw Object.assign(new Error('Confirm found, condition, artwork, colour and size before reuse'), { status: 400 });
        }
        if (component.asset_status !== 'available') throw Object.assign(new Error('This plate is no longer available in the rack'), { status: 409 });
        await qc(`UPDATE plate_assets SET status='available',current_job_card_id=NULL,verified_by=$1,
          verified_at=now(),updated_at=now() WHERE id=$2`, [req.user.name, component.proposed_asset_id]);
        await qc(`UPDATE plate_request_components SET status='verified_existing',matched_asset_id=proposed_asset_id,
          verified_found=1,verified_condition_ok=1,verified_artwork_ok=1,verified_colour_ok=1,verified_size_ok=1,
          verified_by=$1,verified_at=now(),updated_at=now() WHERE id=$2`, [req.user.name, component.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,'verified','available','available',$5,$5,$6,$7,$8)`,
        [component.proposed_asset_id, component.id, component.tooling_request_id, component.job_card_id,
         component.rack_location, component.asset_condition, `Verified for ${component.request_number}`, req.user.name]);
      } else {
        const assetStatus = outcome === 'not_found' ? 'lost' : outcome === 'scrap' ? 'scrapped'
          : outcome === 'damaged' ? 'damaged' : component.asset_status;
        const condition = outcome === 'not_found' ? 'Lost' : outcome === 'scrap' ? 'Scrapped'
          : outcome === 'damaged' ? 'Damaged' : component.asset_condition;
        if (outcome !== 'replacement') {
          await qc(`UPDATE plate_assets SET status=$1,condition=$2,active=CASE WHEN $1 IN ('lost','scrapped') THEN 0 ELSE active END,
            remarks=COALESCE($3,remarks),updated_at=now() WHERE id=$4`,
          [assetStatus, condition, req.body.note || null, component.proposed_asset_id]);
        }
        await qc(`UPDATE plate_request_components SET status='replacement_required',proposed_asset_id=NULL,
          verified_found=$1,verified_condition_ok=0,verified_by=$2,verified_at=now(),updated_at=now() WHERE id=$3`,
        [outcome === 'not_found' ? 0 : 1, req.user.name, component.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,
        [component.proposed_asset_id, component.id, component.tooling_request_id, component.job_card_id,
         outcome === 'replacement' ? 'replacement_required' : outcome, component.asset_status, assetStatus,
         component.rack_location, condition, req.body.note || null, req.user.name]);
      }
      return syncPlateRequest(qc, oc, component.tooling_request_id, req.user.name);
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Take what the plant already owns — one click, from the row or from the form.
//
// The careful door is still there and is still right for a plate somebody has
// physical doubts about: VerificationModal ticks found / condition / artwork /
// colour / size one at a time, and its other outcomes — not found, damaged,
// scrap — remain the ONLY way to say a rack plate is unusable. This is the yes.
// Whoever clicks it can see, on the same screen, which rack the plate sits on,
// its condition grade, how many runs it has had and how long it has been there;
// the click is that decision, it is signed, and it leaves a movement row, so an
// empty rack slot is answerable to a name afterwards.
//
// The plate is RESERVED, not merely matched. Nothing in this module had ever
// written 'reserved' although releaseDraftPlateAssets had always looked for it,
// so a reused plate stayed 'available' and could be handed to a second job.
// Reserving is what makes the availability figure on the list true a second
// later, and editing or deleting the PR releases it again.
r.post('/plates/requirements/:id/use-from-rack', canVerify, async (req, res, next) => {
  try {
    const wanted = [...new Set((req.body.component_ids || []).map(Number).filter(Boolean))];
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      const idFilter = wanted.length ? 'AND id=ANY($2::int[])' : '';
      const components = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 ${idFilter} AND status=ANY($${wanted.length ? 3 : 2}::text[])
        ORDER BY sequence_no FOR UPDATE`,
      wanted.length ? [request.id, wanted, RACK_CLAIMABLE_COMPONENT_STATUSES]
        : [request.id, RACK_CLAIMABLE_COMPONENT_STATUSES]);
      if (!components.length) {
        throw Object.assign(new Error('No plate on this requirement is waiting for a rack plate'), { status: 409 });
      }
      // Picked one at a time, each pick excluding the ones already taken in this
      // same click — two Cyan lines on one PR must draw two different plates.
      const taken = [];
      const claimed = [];
      for (const component of components) {
        const asset = await bestPlateCandidate(oc, request, component, component.plate_master_id, taken);
        // A colour the rack cannot cover is SKIPPED, never fatal: three of four is
        // three plates the plant no longer has to buy, and the fourth stays on the
        // PR exactly as it was, still approvable onto a PO.
        if (!asset) continue;
        taken.push(asset.id);
        claimed.push(component);
        await qc(`UPDATE plate_assets SET status='reserved',current_job_card_id=$1,
          verified_by=$2,verified_at=now(),updated_at=now() WHERE id=$3`,
        [request.job_card_id, req.user.name, asset.id]);
        await qc(`UPDATE plate_request_components SET status='verified_existing',
          proposed_asset_id=$1,matched_asset_id=$1,
          verified_found=1,verified_condition_ok=1,verified_artwork_ok=1,verified_colour_ok=1,verified_size_ok=1,
          verified_by=$2,verified_at=now(),updated_at=now() WHERE id=$3`,
        [asset.id, req.user.name, component.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,'reserved','available','reserved',$5,$5,$6,$7,$8)`,
        [asset.id, component.id, request.id, request.job_card_id, asset.rack_location, asset.condition,
         `Reused from rack for ${request.request_number}`, req.user.name]);
      }
      if (!taken.length) {
        throw Object.assign(new Error('No matching plate is free on the rack any more'), { status: 409 });
      }
      const breakdown = plateBreakdownText(claimed);
      await syncPlateRequest(qc, oc, request.id, req.user.name);
      await addRequestEvent(qc, request.id, 'rack_reuse', request.status, 'rack_reserved',
        `${taken.length} plate${taken.length === 1 ? '' : 's'} taken from the rack · ${breakdown}`,
        req.user.name, 'warehouse');
      await audit('tooling_requirement', request.id, 'use_from_rack',
        `${taken.length} of ${components.length} · ${breakdown}`, qc, req.user.name);
      return { request_id: request.id, reused: taken.length, short: components.length - taken.length };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.post('/plates/requirements/:id/approve', canBuy, async (req, res, next) => {
  try {
    const componentIds = [...new Set((req.body.component_ids || []).map(Number).filter(Boolean))];
    const plateMasterId = Number(req.body.plate_master_id);
    if (!componentIds.length || !plateMasterId) return res.status(400).json({ error: 'Choose a plate size and at least one missing plate' });
    const result = await tx(async (qc, oc) => {
      const request = await oc(`SELECT * FROM tooling_requests WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
      if (!['saved','approved'].includes(request.approval_status)) {
        throw Object.assign(new Error('Save this Plate PR before approving it'), { status: 409 });
      }
      const master = await oc('SELECT * FROM plate_masters WHERE id=$1 AND active=1', [plateMasterId]);
      if (!master) throw Object.assign(new Error('Choose an active Plate Master size'), { status: 400 });
      const components = await qc(`SELECT * FROM plate_request_components
        WHERE tooling_request_id=$1 AND id=ANY($2::int[]) FOR UPDATE`, [request.id, componentIds]);
      if (components.length !== componentIds.length) throw Object.assign(new Error('One or more plate components no longer exist'), { status: 409 });
      const blocked = components.find(component => !APPROVABLE_COMPONENT_STATUSES.includes(component.status));
      if (blocked) throw Object.assign(new Error(`${blocked.component_label} cannot be approved from ${blocked.status}`), { status: 409 });
      for (const component of components) {
        if (!master.allowed_components.includes(component.component_type)) {
          throw Object.assign(new Error(`${component.component_label} is not enabled for ${master.plate_size}`), { status: 409 });
        }
      }
      await qc(`UPDATE plate_request_components SET approval_from_status=status,status='approved',plate_master_id=$1,
        approved_by=$2,approved_at=now(),updated_at=now() WHERE id=ANY($3::int[])`,
      [master.id, req.user.name, componentIds]);
      await qc(`UPDATE tooling_requests SET inventory_item_id=$1,approval_status='approved',approved_by=$2,
        approved_at=now(),source='procurement',status='procurement',updated_at=now() WHERE id=$3`,
      [master.inventory_item_id, req.user.name, request.id]);
      const breakdown = plateBreakdownText(components);
      await addRequestEvent(qc, request.id, 'approve_components', request.approval_status, 'approved',
        `${breakdown} · ${master.plate_size} · ${components.length} total`, req.user.name, 'procurement');
      await audit('tooling_requirement', request.id, 'approve_components', breakdown, qc, req.user.name);
      return { request_id: request.id, approved: components.length, plate_size: master.plate_size };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.get('/plates/purchase-orders', async (_req, res, next) => {
  try { res.json(await platePoRows()); } catch (error) { next(error); }
});

r.post('/plates/purchase-orders', canBuy, async (req, res, next) => {
  try {
    const vendorId = Number(req.body.vendor_id);
    const groups = Array.isArray(req.body.groups) ? req.body.groups : [];
    if (!vendorId || !groups.length) return res.status(400).json({ error: 'Choose a vendor and approved plate requirements' });
    const result = await tx(async (qc, oc) => {
      const poNumber = await nextNumber('CI-PL-PO-', 'tooling_purchase_orders', 'po_number', oc);
      const [po] = await qc(`INSERT INTO tooling_purchase_orders
        (po_number,family,vendor_id,expected_date,vendor_notes,payment_terms,delivery_terms,reference,tax_kind,freight,round_off,created_by)
        VALUES ($1,'plate',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [poNumber, vendorId, req.body.expected_date || null, req.body.vendor_notes || null,
       req.body.payment_terms || null, req.body.delivery_terms || null, req.body.reference || null,
       req.body.tax_kind === 'inter' ? 'inter' : 'intra', Number(req.body.freight) || 0,
       Number(req.body.round_off) || 0, req.user.name]);
      for (const group of groups) {
        const componentIds = [...new Set((group.component_ids || []).map(Number).filter(Boolean))];
        const request = await oc(`SELECT * FROM tooling_requests WHERE id=$1 AND family='plate' FOR UPDATE`, [group.request_id]);
        if (!request) throw Object.assign(new Error('Plate requirement not found'), { status: 404 });
        const components = await qc(`SELECT prc.*,pm.inventory_item_id,pm.hsn_code,pm.gst_rate
          FROM plate_request_components prc JOIN plate_masters pm ON pm.id=prc.plate_master_id
          WHERE prc.tooling_request_id=$1 AND prc.id=ANY($2::int[]) AND prc.status='approved' FOR UPDATE OF prc`,
        [request.id, componentIds]);
        if (!components.length || components.length !== componentIds.length) {
          throw Object.assign(new Error(`${request.request_number} has changed; reselect its approved plates`), { status: 409 });
        }
        const itemIds = new Set(components.map(row => row.inventory_item_id));
        if (itemIds.size !== 1) throw Object.assign(new Error('One grouped PO line must use one plate size'), { status: 400 });
        const rates = await qc(`SELECT * FROM plate_rates
          WHERE plate_master_id=$1 AND active=1 AND effective_from<=CURRENT_DATE
            AND (vendor_id=$2 OR vendor_id IS NULL)`, [components[0].plate_master_id, vendorId]);
        const masterRate = resolvePlateRate(rates, components[0].plate_master_id, vendorId);
        const requestedRate = group.rate == null || group.rate === '' ? null : Number(group.rate);
        const lineRate = requestedRate ?? Number(masterRate?.rate_per_plate);
        if (!(lineRate > 0)) {
          throw Object.assign(new Error('No active Plate Rate is available for this Plate Size and vendor. Set it in Masters -> Plates -> Plate Rates.'), { status: 409 });
        }
        const [line] = await qc(`INSERT INTO tooling_po_lines
          (purchase_order_id,tooling_request_id,inventory_item_id,qty,rate,hsn_code,unit,discount_pct,gst_rate)
          VALUES ($1,$2,$3,$4,$5,$6,'nos',$7,$8) RETURNING *`,
        [po.id, request.id, components[0].inventory_item_id, components.length,
         lineRate, group.hsn_code || components[0].hsn_code || null,
         Number(group.discount_pct) || 0, group.gst_rate == null ? Number(components[0].gst_rate) || 0 : Number(group.gst_rate) || 0]);
        await qc(`UPDATE plate_request_components SET status='po_created',po_line_id=$1,updated_at=now()
          WHERE id=ANY($2::int[])`, [line.id, componentIds]);
        await qc(`UPDATE tooling_requests SET approval_status='converted',status='procurement',source='procurement',
          vendor_id=$1,po_number=$2,updated_at=now() WHERE id=$3`, [vendorId, poNumber, request.id]);
        await qc(`INSERT INTO tooling_request_events
          (tooling_request_id,action,from_status,to_status,source,vendor_id,note,user_name)
          VALUES ($1,'create_po',$2,'procurement','procurement',$3,$4,$5)`,
        [request.id, request.status, vendorId, `${poNumber} · ${components.length} plates`, req.user.name]);
      }
      await audit('tooling_purchase_order', po.id, 'create', `${poNumber} · grouped plate sets`, qc, req.user.name);
      return po;
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

// Correct a Plate PO in place. Before this the only way to fix a wrong vendor,
// date or rate was to reverse the whole document and retype it, which burns a
// PO number on a typo and leaves a permanent 'reversed' row explaining nothing.
//
// The HEADER is always editable while the PO is alive. The LINES are not: once
// any plate has been received, a line's qty/rate sits underneath a GRN, and
// editing it would leave the received quantity describing something nobody
// ordered — fulfilment would read wrong for ever and no screen would say why.
// So the line edit is refused the moment received_qty moves, and the header
// stays open so the ordinary corrections (expected date, terms, freight) keep
// working on a part-received PO.
r.put('/plates/purchase-orders/:id', canBuy, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const po = await oc(`SELECT * FROM tooling_purchase_orders
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!po) throw Object.assign(new Error('Plate PO not found'), { status: 404 });
      if (po.status === 'reversed') {
        throw Object.assign(new Error(`${po.po_number} is reversed — a cancelled document cannot be edited`),
          { status: 409 });
      }
      const lines = await qc('SELECT * FROM tooling_po_lines WHERE purchase_order_id=$1 FOR UPDATE', [po.id]);
      const received = lines.some(row => Number(row.received_qty) > 0);

      const has = key => Object.prototype.hasOwnProperty.call(req.body, key);
      // Vendor is part of the commercial agreement, not a detail: once plates
      // have arrived against this PO the vendor on it is a fact, not a field.
      if (has('vendor_id') && received && Number(req.body.vendor_id) !== Number(po.vendor_id)) {
        throw Object.assign(new Error('Plates have already been received on this PO — its vendor cannot change'),
          { status: 409 });
      }
      const [updated] = await qc(`UPDATE tooling_purchase_orders SET
          vendor_id      = COALESCE($1, vendor_id),
          expected_date  = $2,
          vendor_notes   = $3,
          payment_terms  = $4,
          delivery_terms = $5,
          reference      = $6,
          tax_kind       = COALESCE($7, tax_kind),
          freight        = COALESCE($8, freight),
          round_off      = COALESCE($9, round_off),
          updated_at     = now()
        WHERE id=$10 RETURNING *`,
      [has('vendor_id') ? Number(req.body.vendor_id) || null : null,
       has('expected_date') ? (req.body.expected_date || null) : po.expected_date,
       has('vendor_notes') ? (req.body.vendor_notes || null) : po.vendor_notes,
       has('payment_terms') ? (req.body.payment_terms || null) : po.payment_terms,
       has('delivery_terms') ? (req.body.delivery_terms || null) : po.delivery_terms,
       has('reference') ? (req.body.reference || null) : po.reference,
       has('tax_kind') ? (req.body.tax_kind === 'inter' ? 'inter' : 'intra') : null,
       has('freight') ? Number(req.body.freight) || 0 : null,
       has('round_off') ? Number(req.body.round_off) || 0 : null,
       po.id]);

      const wanted = Array.isArray(req.body.lines) ? req.body.lines : [];
      if (wanted.length) {
        if (received) {
          throw Object.assign(new Error('Plates have already been received on this PO — its lines cannot be edited. Reverse the GRN first.'),
            { status: 409 });
        }
        for (const edit of wanted) {
          const line = lines.find(row => row.id === Number(edit.id));
          if (!line) throw Object.assign(new Error('That PO line is not on this PO'), { status: 400 });
          // qty is NOT editable: a plate line's quantity is exactly the number
          // of approved components pointing at it, and changing it here would
          // leave the two disagreeing with nothing to reconcile them. Add or
          // remove plates on the requirement instead.
          const rate = edit.rate == null || edit.rate === '' ? Number(line.rate) : Number(edit.rate);
          if (!(rate > 0)) throw Object.assign(new Error('A plate rate must be greater than zero'), { status: 400 });
          await qc(`UPDATE tooling_po_lines SET rate=$1, discount_pct=$2, gst_rate=$3, hsn_code=$4
            WHERE id=$5 AND purchase_order_id=$6`,
          [rate, Number(edit.discount_pct) || 0,
           edit.gst_rate == null ? Number(line.gst_rate) || 0 : Number(edit.gst_rate) || 0,
           edit.hsn_code || line.hsn_code || null, line.id, po.id]);
        }
      }
      await audit('tooling_purchase_order', po.id, 'edit',
        `${po.po_number} edited${wanted.length ? ` · ${wanted.length} line(s)` : ''}`, qc, req.user.name);
      return updated;
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Delete a Plate PO that never should have existed.
//
// NOT the same door as reverse, and the guards below are the difference.
// Reverse is the auditable undo for a PO that has LIVED — the vendor has seen
// it, or plates have arrived. It keeps the row, stamps it 'reversed' with a
// reason, and hands the components back. This is for the other case: raised by
// mistake, caught immediately, never sent, nothing received. Reversing one of
// those leaves a permanent cancelled document explaining a typo.
//
// Every guard here answers "has this PO been seen by anyone outside this
// screen?" — because once it has, the number must survive.
r.delete('/plates/purchase-orders/:id', canBuy, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const po = await oc(`SELECT * FROM tooling_purchase_orders
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!po) throw Object.assign(new Error('Plate PO not found'), { status: 404 });

      if (po.status !== 'open') {
        throw Object.assign(new Error(
          `${po.po_number} is ${po.status} — only an untouched PO can be deleted. Reverse it instead.`),
        { status: 409, body: { code: 'PO_NOT_DELETABLE', po_status: po.status } });
      }
      if (po.sent_at) {
        throw Object.assign(new Error(
          `${po.po_number} has already been sent to the vendor — reverse it instead, so the cancellation is on record.`),
        { status: 409, body: { code: 'PO_NOT_DELETABLE', sent_at: po.sent_at } });
      }
      // ANY grn, including a reversed one: a reversed GRN still names this PO,
      // and deleting the PO would leave that history pointing at nothing.
      const grn = await oc('SELECT grn_number FROM tooling_grns WHERE purchase_order_id=$1 LIMIT 1', [po.id]);
      if (grn) {
        throw Object.assign(new Error(
          `${grn.grn_number} was received against ${po.po_number} — reverse the PO instead of deleting it.`),
        { status: 409, body: { code: 'PO_NOT_DELETABLE', grn_number: grn.grn_number } });
      }

      const lines = await qc('SELECT * FROM tooling_po_lines WHERE purchase_order_id=$1 FOR UPDATE', [po.id]);
      const lineIds = lines.map(row => row.id);
      const components = lineIds.length ? await qc(`SELECT * FROM plate_request_components
        WHERE po_line_id=ANY($1::int[]) FOR UPDATE`, [lineIds]) : [];
      if (components.some(row => row.grn_id || ['issued','returned_pending_verification'].includes(row.status))) {
        throw Object.assign(new Error('This Plate PO still has downstream plate activity'), { status: 409 });
      }

      // Hand the plates back BEFORE the lines vanish — a component still
      // pointing at a deleted po_line_id is stranded in 'po_created', invisible
      // to the requirements screen and impossible to buy again.
      if (lineIds.length) {
        await qc(`UPDATE plate_request_components SET status='approved',po_line_id=NULL,updated_at=now()
          WHERE po_line_id=ANY($1::int[])`, [lineIds]);
      }
      const requestIds = [...new Set(lines.map(row => row.tooling_request_id).filter(Boolean))];
      for (const requestId of requestIds) {
        const otherPo = await oc(`SELECT po.po_number,po.vendor_id FROM tooling_po_lines pl
          JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
          WHERE pl.tooling_request_id=$1 AND po.id<>$2 AND po.status<>'reversed'
          ORDER BY po.id DESC LIMIT 1`, [requestId, po.id]);
        await qc(`UPDATE tooling_requests SET approval_status=$1,status='procurement',
          po_number=$2,vendor_id=$3,updated_at=now() WHERE id=$4`,
        [otherPo ? 'converted' : 'approved', otherPo?.po_number || null, otherPo?.vendor_id || null, requestId]);
        await addRequestEvent(qc, requestId, 'delete_po', 'converted', otherPo ? 'converted' : 'approved',
          `${po.po_number} deleted`, req.user.name, 'procurement', po.vendor_id);
      }

      // The audit row is written BEFORE the delete and is the only thing that
      // survives it: with the PO row gone, this is the sole record that the
      // number was ever issued. Without it the series just skips a number and
      // nobody can say why.
      await audit('tooling_purchase_order', po.id, 'delete',
        `${po.po_number} deleted · ${lines.length} line(s) · plates returned to Approved`, qc, req.user.name);
      await qc('DELETE FROM tooling_po_lines WHERE purchase_order_id=$1', [po.id]);
      await qc('DELETE FROM tooling_purchase_orders WHERE id=$1', [po.id]);
      return { deleted: true, po_number: po.po_number, plates_returned: components.length };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.post('/plates/purchase-orders/:id/send', canBuy, async (req, res, next) => {
  try {
    const [po] = await q(`UPDATE tooling_purchase_orders SET sent_at=COALESCE(sent_at,now()),updated_at=now()
      WHERE id=$1 AND family='plate' AND status IN ('open','partially_received') RETURNING *`, [req.params.id]);
    if (!po) return res.status(409).json({ error: 'Only an active Plate PO can be marked sent' });
    await audit('tooling_purchase_order', po.id, 'sent', po.po_number, q, req.user.name);
    res.json(po);
  } catch (error) { next(error); }
});

r.post('/plates/purchase-orders/:id/reverse', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter the PO reversal reason' });
    const result = await tx(async (qc, oc) => {
      const po = await oc(`SELECT * FROM tooling_purchase_orders
        WHERE id=$1 AND family='plate' FOR UPDATE`, [req.params.id]);
      if (!po) throw Object.assign(new Error('Plate PO not found'), { status: 404 });
      if (po.status === 'reversed') throw Object.assign(new Error('This Plate PO is already reversed'), { status: 409 });
      const activeGrn = await oc(`SELECT grn_number FROM tooling_grns
        WHERE purchase_order_id=$1 AND status<>'reversed' LIMIT 1`, [po.id]);
      if (activeGrn) {
        throw Object.assign(new Error(`${activeGrn.grn_number} must be reversed before reversing ${po.po_number}`), { status: 409 });
      }
      const lines = await qc('SELECT * FROM tooling_po_lines WHERE purchase_order_id=$1 FOR UPDATE', [po.id]);
      const lineIds = lines.map(row => row.id);
      const components = lineIds.length ? await qc(`SELECT * FROM plate_request_components
        WHERE po_line_id=ANY($1::int[]) FOR UPDATE`, [lineIds]) : [];
      if (components.some(row => row.grn_id || ['issued','returned_pending_verification'].includes(row.status))) {
        throw Object.assign(new Error('This Plate PO still has downstream plate activity'), { status: 409 });
      }
      if (lineIds.length) await qc(`UPDATE plate_request_components SET status='approved',po_line_id=NULL,
        updated_at=now() WHERE po_line_id=ANY($1::int[])`, [lineIds]);
      const requestIds = [...new Set(lines.map(row => row.tooling_request_id).filter(Boolean))];
      await qc(`UPDATE tooling_purchase_orders SET status='reversed',reversed_at=now(),reversed_by=$1,
        reversal_reason=$2,updated_at=now() WHERE id=$3`, [req.user.name, reason, po.id]);
      for (const requestId of requestIds) {
        const otherPo = await oc(`SELECT po.po_number,po.vendor_id FROM tooling_po_lines pl
          JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
          WHERE pl.tooling_request_id=$1 AND po.status<>'reversed' ORDER BY po.id DESC LIMIT 1`, [requestId]);
        await qc(`UPDATE tooling_requests SET approval_status=$1,status='procurement',
          po_number=$2,vendor_id=$3,updated_at=now() WHERE id=$4`,
        [otherPo ? 'converted' : 'approved', otherPo?.po_number || null, otherPo?.vendor_id || null, requestId]);
        await addRequestEvent(qc, requestId, 'reverse_po', 'converted', otherPo ? 'converted' : 'approved',
          `${po.po_number} reversed · ${reason}`, req.user.name, 'procurement', po.vendor_id);
      }
      await audit('tooling_purchase_order', po.id, 'reverse', `${po.po_number} · ${reason}`, qc, req.user.name);
      return { ...po, status: 'reversed', reversal_reason: reason };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.get('/plates/grns', async (_req, res, next) => {
  try {
    res.json(await q(`SELECT g.*,po.po_number,v.name AS vendor_name,tr.request_number,jc.jc_number,
        COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
        COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
        ${outputNumberSql({ run: 'gr', product: 'p' })} AS output_number,
        COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
        tr.specification->'gang_members' AS gang_members,pm.plate_size,
        COALESCE(json_agg(json_build_object('asset_number',pa.asset_number,'component_label',pa.component_label,
          'condition',pa.condition,'rack_location',pa.rack_location) ORDER BY pa.id)
          FILTER (WHERE pa.id IS NOT NULL),'[]'::json) AS plates
      FROM tooling_grns g
      LEFT JOIN tooling_purchase_orders po ON po.id=g.purchase_order_id
      LEFT JOIN vendors v ON v.id=g.vendor_id
      LEFT JOIN tooling_requests tr ON tr.id=g.tooling_request_id
      LEFT JOIN job_cards jc ON jc.id=tr.job_card_id
      LEFT JOIN gang_runs gr ON gr.id=jc.gang_run_id
      LEFT JOIN products p ON p.id=tr.product_id
      LEFT JOIN plate_assets pa ON pa.source_grn_id=g.id
      LEFT JOIN plate_masters pm ON pm.id=pa.plate_master_id
      WHERE g.family='plate'
      GROUP BY g.id,po.po_number,v.name,tr.request_number,jc.jc_number,tr.specification,
        p.name,p.code,p.output_number,gr.output_number,gr.kind,pm.plate_size
      ORDER BY g.id DESC`));
  } catch (error) { next(error); }
});

r.post('/plates/grns', canBuy, async (req, res, next) => {
  try {
    const poLineId = Number(req.body.po_line_id);
    if (!poLineId) return res.status(400).json({ error: 'Choose a Plate PO line' });
    const result = await tx(async (qc, oc) => {
      const poLine = await oc(`SELECT pl.*,po.vendor_id,po.po_number,po.status AS po_status,
          tr.job_card_id,tr.product_id,tr.request_number,tr.specification
        FROM tooling_po_lines pl
        JOIN tooling_purchase_orders po ON po.id=pl.purchase_order_id
        JOIN tooling_requests tr ON tr.id=pl.tooling_request_id
        WHERE pl.id=$1 AND po.family='plate' FOR UPDATE OF pl,po,tr`, [poLineId]);
      if (!poLine) throw Object.assign(new Error('Plate PO line not found'), { status: 404 });
      const requested = [...new Set((req.body.component_ids || []).map(Number).filter(Boolean))];
      const values = [poLine.id];
      const chosen = requested.length ? (values.push(requested), 'AND prc.id=ANY($2::int[])') : '';
      const components = await qc(`SELECT prc.*,pm.inventory_item_id,pm.plate_size
        FROM plate_request_components prc JOIN plate_masters pm ON pm.id=prc.plate_master_id
        WHERE prc.po_line_id=$1 AND prc.status IN ('po_created','ordered') ${chosen}
        ORDER BY prc.sequence_no FOR UPDATE OF prc`, values);
      if (!components.length) throw Object.assign(new Error('No outstanding plates remain on this PO line'), { status: 409 });
      const pending = Number(poLine.qty) - Number(poLine.received_qty);
      if (components.length > pending) throw Object.assign(new Error(`Receipt exceeds ${poLine.po_number}'s pending quantity`), { status: 409 });
      const grnNumber = await nextNumber('CI-PL-GRN-', 'tooling_grns', 'grn_number', oc);
      const [grn] = await qc(`INSERT INTO tooling_grns
        (grn_number,family,purchase_order_id,po_line_id,tooling_request_id,inventory_item_id,vendor_id,
         qty,accepted_qty,status,batch_no,vehicle_no,supplier_invoice_no,supplier_invoice_date,
         received_by,remarks,qc_by,qc_at,created_by)
        VALUES ($1,'plate',$2,$3,$4,$5,$6,$7,$7,'accepted',$8,$9,$10,$11,$12,$13,$12,now(),$14) RETURNING *`,
      [grnNumber, poLine.purchase_order_id, poLine.id, poLine.tooling_request_id,
       poLine.inventory_item_id, poLine.vendor_id, components.length, req.body.batch_no || null,
       req.body.vehicle_no || null, req.body.supplier_invoice_no || null, req.body.supplier_invoice_date || null,
       req.body.received_by || req.user.name, req.body.remarks || null, req.user.name]);
      for (const component of components) {
        const assetNumber = await nextNumber('CI-PL-A-', 'plate_assets', 'asset_number', oc);
        const spec = poLine.specification || {};
        const receivedCondition = req.body.condition || 'Good';
        const assetStatus = 'available';
        const componentStatus = 'available';
        const [asset] = await qc(`INSERT INTO plate_assets
          (asset_number,plate_master_id,product_id,output_number,artwork_reference,artwork_version,
           component_type,component_label,pantone_code,source_grn_id,vendor_id,purchase_rate,
           rack_location,status,condition,current_job_card_id,verified_by,verified_at,remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18) RETURNING *`,
        [assetNumber, component.plate_master_id, poLine.product_id, spec.output_number || null,
         spec.party_artwork_code || null, spec.artwork_version || spec.party_artwork_code || spec.output_number || 'Unversioned',
         component.component_type, component.component_label, component.pantone_code || null,
         grn.id, poLine.vendor_id, Number(req.body.rate ?? poLine.rate) || 0,
         FRESH_PLATES_RACK, assetStatus, receivedCondition, null,
         req.user.name, req.body.remarks || null]);
        await qc(`UPDATE plate_request_components SET status=$1,matched_asset_id=$2,grn_id=$3,
          updated_at=now() WHERE id=$4`, [componentStatus, asset.id, grn.id, component.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,'received',NULL,$5,$6,$7,$8,$9)`,
        [asset.id, component.id, poLine.tooling_request_id, poLine.job_card_id,
         assetStatus, asset.rack_location, asset.condition, grnNumber, req.user.name]);
      }
      await qc('UPDATE tooling_po_lines SET received_qty=received_qty+$1 WHERE id=$2', [components.length, poLine.id]);
      const poLines = await qc('SELECT qty,received_qty FROM tooling_po_lines WHERE purchase_order_id=$1', [poLine.purchase_order_id]);
      await qc('UPDATE tooling_purchase_orders SET status=$1,updated_at=now() WHERE id=$2',
        [toolingPoStatus(poLines), poLine.purchase_order_id]);
      await qc(`UPDATE tooling_requests SET received_at=now(),grn_number=$1,updated_at=now() WHERE id=$2`,
        [grnNumber, poLine.tooling_request_id]);
      await syncPlateRequest(qc, oc, poLine.tooling_request_id, req.user.name);
      await audit('tooling_grn', grn.id, 'create', `${grnNumber} · ${components.length} plates`, qc, req.user.name);
      return grn;
    });
    res.status(201).json(result);
  } catch (error) { next(error); }
});

r.post('/plates/grns/:id/reverse', canBuy, async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Enter the GRN reversal reason' });
    const result = await tx(async (qc, oc) => {
      const grn = await oc(`SELECT g.*,po.po_number FROM tooling_grns g
        LEFT JOIN tooling_purchase_orders po ON po.id=g.purchase_order_id
        WHERE g.id=$1 AND g.family='plate' FOR UPDATE OF g`, [req.params.id]);
      if (!grn) throw Object.assign(new Error('Plate GRN not found'), { status: 404 });
      if (grn.status === 'reversed') throw Object.assign(new Error('This Plate GRN is already reversed'), { status: 409 });
      const assets = await qc('SELECT * FROM plate_assets WHERE source_grn_id=$1 ORDER BY id FOR UPDATE', [grn.id]);
      const used = assets.find(asset => Number(asset.use_count) > 0
        || ['issued_to_printing','returned_pending_verification'].includes(asset.status));
      if (used) {
        throw Object.assign(new Error(`${used.asset_number} has entered production and prevents GRN reversal`), { status: 409 });
      }
      const components = await qc(`SELECT * FROM plate_request_components
        WHERE grn_id=$1 ORDER BY sequence_no FOR UPDATE`, [grn.id]);
      for (const asset of assets) {
        const component = components.find(row => Number(row.matched_asset_id) === Number(asset.id));
        await qc(`UPDATE plate_assets SET status='reversed',active=0,current_job_card_id=NULL,
          remarks=$1,updated_at=now() WHERE id=$2`, [`${grn.grn_number} reversed: ${reason}`, asset.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,
           from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,'reversed',$5,'reversed',$6,$6,$7,$8,$9)`,
        [asset.id, component?.id || null, component?.tooling_request_id || grn.tooling_request_id,
         asset.current_job_card_id, asset.status, asset.rack_location, asset.condition,
         `${grn.grn_number}: ${reason}`, req.user.name]);
      }
      await qc(`UPDATE plate_request_components SET status='po_created',matched_asset_id=NULL,grn_id=NULL,
        updated_at=now() WHERE grn_id=$1`, [grn.id]);
      if (grn.po_line_id) {
        await qc(`UPDATE tooling_po_lines SET received_qty=GREATEST(0,received_qty-$1) WHERE id=$2`,
        [Number(grn.qty) || assets.length, grn.po_line_id]);
      }
      await qc(`UPDATE tooling_grns SET status='reversed',reversed_at=now(),reversed_by=$1,
        reversal_reason=$2 WHERE id=$3`, [req.user.name, reason, grn.id]);
      if (grn.purchase_order_id) {
        const lines = await qc('SELECT qty,received_qty FROM tooling_po_lines WHERE purchase_order_id=$1', [grn.purchase_order_id]);
        await qc('UPDATE tooling_purchase_orders SET status=$1,updated_at=now() WHERE id=$2',
          [toolingPoStatus(lines), grn.purchase_order_id]);
      }
      if (grn.tooling_request_id) {
        const latest = await oc(`SELECT grn_number,created_at FROM tooling_grns
          WHERE tooling_request_id=$1 AND status<>'reversed' ORDER BY id DESC LIMIT 1`, [grn.tooling_request_id]);
        await qc(`UPDATE tooling_requests SET grn_number=$1,received_at=$2,updated_at=now() WHERE id=$3`,
        [latest?.grn_number || null, latest?.created_at || null, grn.tooling_request_id]);
        await syncPlateRequest(qc, oc, grn.tooling_request_id, req.user.name);
        await addRequestEvent(qc, grn.tooling_request_id, 'reverse_grn', 'grn_received', 'po_created',
          `${grn.grn_number} reversed · ${reason}`, req.user.name, 'procurement', grn.vendor_id);
      }
      await audit('tooling_grn', grn.id, 'reverse', `${grn.grn_number} · ${reason}`, qc, req.user.name);
      return { ...grn, status: 'reversed', reversal_reason: reason };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.get('/plates/warehouse', async (_req, res, next) => {
  try {
    const rows = await q(`SELECT pa.*,pm.plate_size,
        str.id AS tooling_request_id,str.request_number,str.job_card_id,
        COALESCE(NULLIF(str.specification->>'product_name',''),p.name) AS product_name,
        COALESCE(NULLIF(str.specification->>'product_code',''),p.code) AS product_code,
        ${ASSET_OUTPUT_NUMBER('str')} AS output_number,
        COALESCE((str.specification->>'is_gang')::boolean,false) AS is_gang,
        str.specification->'gang_members' AS gang_members,
        p.party_item_code,p.party_artwork_code,c.name AS customer_name,v.name AS vendor_name,
        jc.jc_number AS current_job_card,
        (CURRENT_DATE-pa.plate_created_on)::int AS age_days,
        COALESCE(hist.linked_job_cards,'[]'::json) AS linked_job_cards
      FROM plate_assets pa
      JOIN plate_masters pm ON pm.id=pa.plate_master_id
      JOIN products p ON p.id=pa.product_id JOIN customers c ON c.id=p.customer_id
      LEFT JOIN tooling_grns sgrn ON sgrn.id=pa.source_grn_id
      LEFT JOIN tooling_requests str ON str.id=sgrn.tooling_request_id
      LEFT JOIN vendors v ON v.id=pa.vendor_id
      LEFT JOIN job_cards jc ON jc.id=pa.current_job_card_id
      LEFT JOIN LATERAL (
        SELECT json_agg(DISTINCT jsonb_build_object('id',mjc.id,'jc_number',mjc.jc_number)) AS linked_job_cards
        FROM plate_asset_movements pam JOIN job_cards mjc ON mjc.id=pam.job_card_id
        WHERE pam.plate_asset_id=pa.id) hist ON true
      ORDER BY CASE pa.status WHEN 'available' THEN 0 WHEN 'reserved' THEN 1
        WHEN 'issued_to_printing' THEN 2 WHEN 'returned_pending_verification' THEN 3 ELSE 4 END,
        pa.id DESC`);
    res.json(groupPlateSets(rows, row => [
      row.status,
      row.rack_location || '',
      row.source_grn_id || '',
      row.product_id,
      row.output_number || '',
      row.artwork_version || '',
      row.plate_master_id,
    ].join('|')));
  } catch (error) { next(error); }
});

r.get('/plates/returns', async (_req, res, next) => {
  try {
    // age_days is computed here as well as in the warehouse query — without it
    // summarizePlateSet folds Math.max over a column that does not exist and every
    // returned set reports an age of 0.
    const rows = await q(`SELECT pa.*,pm.plate_size,
        (CURRENT_DATE-pa.plate_created_on)::int AS age_days,
        COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
        COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
        ${ASSET_OUTPUT_NUMBER('tr')} AS output_number,
        COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
        tr.specification->'gang_members' AS gang_members,
        c.name AS customer_name,m.user_name AS returned_by,m.at AS return_date,
        m.tooling_request_id,m.job_card_id,jc.jc_number,m.from_location AS previous_location,
        m.to_location AS return_location,m.note AS operator_note
      FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
      JOIN products p ON p.id=pa.product_id JOIN customers c ON c.id=p.customer_id
      LEFT JOIN LATERAL (SELECT * FROM plate_asset_movements x
        WHERE x.plate_asset_id=pa.id AND x.action='returned' ORDER BY x.id DESC LIMIT 1) m ON true
      LEFT JOIN tooling_requests tr ON tr.id=m.tooling_request_id
      LEFT JOIN job_cards jc ON jc.id=m.job_card_id
      WHERE pa.status='returned_pending_verification' ORDER BY m.at,pa.id`);
    // Grouped by the same key verify-return locks on, so a job that comes back
    // 5 Good + 1 Damaged is two cards the warehouse can decide independently.
    res.json(groupPlateSets(rows, plateReturnSetKey));
  } catch (error) { next(error); }
});

r.get('/plates/history', async (_req, res, next) => {
  try {
    res.json(await q(`SELECT pam.*,pa.asset_number,pa.component_label,pa.artwork_version,
        pm.plate_size,
        COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
        COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
        ${ASSET_OUTPUT_NUMBER('tr')} AS output_number,
        COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
        tr.specification->'gang_members' AS gang_members,
        jc.jc_number,m.name AS machine_name
      FROM plate_asset_movements pam JOIN plate_assets pa ON pa.id=pam.plate_asset_id
      JOIN plate_masters pm ON pm.id=pa.plate_master_id JOIN products p ON p.id=pa.product_id
      LEFT JOIN tooling_requests tr ON tr.id=pam.tooling_request_id
      LEFT JOIN job_cards jc ON jc.id=pam.job_card_id LEFT JOIN machines m ON m.id=pam.machine_id
      ORDER BY pam.id DESC LIMIT 2000`));
  } catch (error) { next(error); }
});

r.post('/plates/assets/:id/verify-return', canVerify, async (req, res, next) => {
  try {
    const action = String(req.body.action || '');
    const perPlate = Array.isArray(req.body.decisions) && req.body.decisions.length > 0;
    // A per-plate body carries its verdicts inside `decisions`; only the legacy
    // whole-set call has to name one action up front.
    if (!perPlate && !['verified_ok', 'scrap'].includes(action)) {
      return res.status(400).json({ error: 'Choose Move to Used Plates Rack or Move to Scrap' });
    }
    const result = await tx(async (qc, oc) => {
      const asset = await oc(`SELECT pa.*,m.request_component_id AS component_id,
          m.tooling_request_id,m.job_card_id,m.from_location AS previous_location
        FROM plate_assets pa LEFT JOIN LATERAL (SELECT * FROM plate_asset_movements x
          WHERE x.plate_asset_id=pa.id AND x.action='returned' ORDER BY x.id DESC LIMIT 1) m ON true
        WHERE pa.id=$1 FOR UPDATE OF pa`, [req.params.id]);
      if (!asset) throw Object.assign(new Error('Plate asset not found'), { status: 404 });
      if (asset.status !== 'returned_pending_verification') throw Object.assign(new Error('This plate is not awaiting return verification'), { status: 409 });
      const peers = await qc(`SELECT pa.*,m.request_component_id AS component_id,
          (CURRENT_DATE-pa.plate_created_on)::int AS age_days,
          m.tooling_request_id,m.job_card_id,m.from_location AS previous_location
        -- LEFT, matching the /plates/returns listing and the single-asset fetch above.
        -- A plain JOIN drops any returned plate with no 'returned' movement row, so it
        -- shows on the card the warehouse is looking at but is never part of the peer
        -- group the decision acts on — it stays in the queue with no sign why.
        FROM plate_assets pa LEFT JOIN LATERAL (SELECT * FROM plate_asset_movements x
          WHERE x.plate_asset_id=pa.id AND x.action='returned' ORDER BY x.id DESC LIMIT 1) m ON true
        WHERE pa.status='returned_pending_verification'
          AND COALESCE(m.tooling_request_id,0)=COALESCE($1,0)
          AND COALESCE(m.job_card_id,0)=COALESCE($2,0)
          AND pa.product_id=$3
          AND COALESCE(pa.output_number,'')=COALESCE($4,'')
          AND COALESCE(pa.artwork_version,'')=COALESCE($5,'')
          AND pa.plate_master_id=$6
        ORDER BY pa.id FOR UPDATE OF pa`,
      [asset.tooling_request_id || null, asset.job_card_id || null, asset.product_id,
       asset.output_number || null, asset.artwork_version || null, asset.plate_master_id]);
      // The SQL above locks every plate that could belong to this set; the shared key
      // is what decides which of them actually do. Narrowing here rather than in a
      // second WHERE clause keeps this in lockstep with the /plates/returns grouping.
      const key = plateReturnSetKey(asset);
      const matched = peers.filter(row => plateReturnSetKey(row) === key);
      const setRows = matched.length ? matched : [asset];
      // Per-plate decisions are the real shape of this job — three of a set can be fit
      // to run again while the fourth is finished. A body carrying only `action` is
      // still honoured and applies that one decision to the whole set, so older
      // callers keep working.
      const decided = validateReturnVerification({
        components: setRows.map(row => ({ ...row, asset_id: row.id })),
        decisions: Array.isArray(req.body.decisions) && req.body.decisions.length
          ? req.body.decisions
          : setRows.map(row => ({ asset_id: row.id, action })),
      });

      const updated = [];
      for (const { asset_id, action: rowAction } of decided) {
        const row = setRows.find(candidate => Number(candidate.id) === Number(asset_id));
        const ok = rowAction === 'verified_ok';
        const next = ok ? 'available' : 'scrapped';
        // Accepting a return confirms the plate is where the press said it was — it
        // does not upgrade it. A Fair plate stays Fair; a Damaged one stays Damaged and
        // is therefore never proposed for reuse (bestPlateCandidate wants Good or Fair).
        const condition = ok ? (row.condition || 'Good') : 'Scrapped';
        const location = ok ? USED_PLATES_RACK : 'Scrap';
        await qc(`UPDATE plate_assets SET status=$1,condition=$2,rack_location=$3,
          verified_by=$4,verified_at=now(),remarks=COALESCE($5,remarks),
          active=CASE WHEN $1='scrapped' THEN 0 ELSE active END,updated_at=now() WHERE id=$6`,
        [next, condition, location, req.user.name, req.body.note || null, row.id]);
        if (row.component_id) await qc(`UPDATE plate_request_components SET status=$1,updated_at=now() WHERE id=$2`,
          [ok ? 'available' : 'scrapped', row.component_id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,from_status,to_status,
           from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,$5,'returned_pending_verification',$6,$7,$8,$9,$10,$11)`,
        [row.id, row.component_id || null, row.tooling_request_id || null, row.job_card_id || null,
         ok ? 'verified' : 'scrapped',
         next, row.rack_location, location, condition, req.body.note || null, req.user.name]);
        updated.push({ ...row, status: next, condition, rack_location: location });
      }
      for (const requestId of [...new Set(setRows.map(row => row.tooling_request_id).filter(Boolean))]) {
        await syncPlateRequest(qc, oc, requestId, req.user.name);
      }
      return summarizePlateSet(updated);
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Issue rack plates straight to a job card, bypassing the PR → approval → PO → GRN
// chain. The plant does this when plates already exist for a job nobody raised a
// requirement for. The plate still lands on a JOB, so it returns through the normal
// completion flow and its history stays unbroken — the only thing skipped is the
// paperwork that would have bought a plate the rack already has.
r.post('/plates/assets/issue', canBuy, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const ids = [...new Set((req.body.asset_ids || []).map(Number))].filter(Boolean);
      if (!ids.length) throw Object.assign(new Error('Tick at least one plate to issue'), { status: 400 });
      const jobCard = await oc(`SELECT jc.*, ol.id AS line_id FROM job_cards jc
        LEFT JOIN order_lines ol ON ol.id=jc.order_line_id WHERE jc.id=$1`, [Number(req.body.job_card_id)]);
      if (!jobCard) throw Object.assign(new Error('Choose a job card to issue these plates to'), { status: 400 });
      if (jobCard.status === 'closed') throw Object.assign(new Error(`${jobCard.jc_number} is already closed`), { status: 409 });

      const rackAssets = await qc(
        `SELECT * FROM plate_assets WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
      // Only rack stock may be handed out, and the message names the plate rather
      // than making somebody guess which one is busy.
      const picked = pickAvailableRackPlates({ rackAssets, assetIds: ids });

      for (const asset of picked) {
        await qc(`UPDATE plate_assets SET status='issued_to_printing',current_job_card_id=$1,
          last_used_at=now(),use_count=use_count+1,rack_location='Printing',updated_at=now() WHERE id=$2`,
        [jobCard.id, asset.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,job_card_id,action,from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,'issued',$3,'issued_to_printing',$4,'Printing',$5,$6,$7)`,
        [asset.id, jobCard.id, asset.status, asset.rack_location, asset.condition,
         `Issued from rack to ${jobCard.jc_number}${req.body.note ? ` — ${req.body.note}` : ''}`, req.user.name]);
      }

      // The job has its plates in hand, so the readiness light must stop asking for
      // them. tooling_ok is the existing override the gate already reads.
      if (jobCard.line_id) {
        await qc('UPDATE order_lines SET tooling_ok=1 WHERE id=$1', [jobCard.line_id]);
      }
      await audit('job_card', jobCard.id, 'plates_issued',
        `${picked.length} plate(s) issued from rack — ${picked.map(row => row.asset_number).join(', ')}`,
        qc, req.user.name);
      return {
        issued: picked.length,
        jc_number: jobCard.jc_number,
        tooling_marked: !!jobCard.line_id,
        plates: picked.map(row => row.asset_number),
      };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Retire rack plates. The warehouse decides a plate has done enough runs; nothing
// automatic ever reaches this — there is no use-count threshold anywhere in the
// module, by design. Only 'available' stock qualifies.
r.post('/plates/assets/retire', canVerify, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const ids = [...new Set((req.body.asset_ids || []).map(Number))].filter(Boolean);
      if (!ids.length) throw Object.assign(new Error('Tick at least one plate to retire'), { status: 400 });
      const rackAssets = await qc(
        `SELECT * FROM plate_assets WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]);
      const picked = pickAvailableRackPlates({ rackAssets, assetIds: ids });
      const reason = String(req.body.reason).trim();
      for (const asset of picked) {
        await qc(`UPDATE plate_assets SET status='scrapped',condition='Scrapped',
          rack_location='Scrap',active=0,remarks=COALESCE($1,remarks),updated_at=now() WHERE id=$2`,
        [reason, asset.id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,action,from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,'scrapped',$2,'scrapped',$3,'Scrap','Scrapped',$4,$5)`,
        [asset.id, asset.status, asset.rack_location,
         `Retired after ${asset.use_count || 0} run(s) — ${reason}`, req.user.name]);
        await audit('plate_asset', asset.id, 'retire',
          `${asset.asset_number} retired after ${asset.use_count || 0} run(s) — ${reason}`, qc, req.user.name);
      }
      return { retired: picked.length, plates: picked.map(row => row.asset_number) };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Every movement for every plate in a set. The set card the warehouse clicks carries
// `asset_ids`; asking for one plate's history under a title that says "4 plate set"
// showed one plate's life and looked like the other three had none.
r.get('/plates/sets/history', async (req, res, next) => {
  try {
    const ids = [...new Set(String(req.query.asset_ids || '').split(',').map(Number))].filter(Boolean);
    if (!ids.length) return res.json({ plates: [], movements: [] });
    const plates = await q(`SELECT pa.*, pm.plate_size,
        (CURRENT_DATE-pa.plate_created_on)::int AS age_days
      FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
      WHERE pa.id = ANY($1::int[]) ORDER BY pa.id`, [ids]);
    const movements = await q(`SELECT pam.*, pa.asset_number, pa.component_label,
        jc.jc_number, m.name AS machine_name
      FROM plate_asset_movements pam
      JOIN plate_assets pa ON pa.id=pam.plate_asset_id
      LEFT JOIN job_cards jc ON jc.id=pam.job_card_id
      LEFT JOIN machines m ON m.id=pam.machine_id
      WHERE pam.plate_asset_id = ANY($1::int[]) ORDER BY pam.id DESC`, [ids]);
    res.json({ plates, movements });
  } catch (error) { next(error); }
});

r.get('/plates/assets/:id/history', async (req, res, next) => {
  try {
    const asset = await one(`SELECT pa.*,pm.plate_size,
      COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
      COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
      ${ASSET_OUTPUT_NUMBER('tr')} AS output_number,
      COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
      tr.specification->'gang_members' AS gang_members,
      c.name AS customer_name,v.name AS vendor_name
      FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
      JOIN products p ON p.id=pa.product_id JOIN customers c ON c.id=p.customer_id
      LEFT JOIN tooling_grns sgrn ON sgrn.id=pa.source_grn_id
      LEFT JOIN tooling_requests tr ON tr.id=sgrn.tooling_request_id
      LEFT JOIN vendors v ON v.id=pa.vendor_id WHERE pa.id=$1`, [req.params.id]);
    if (!asset) return res.status(404).json({ error: 'Plate asset not found' });
    const movements = await q(`SELECT pam.*,jc.jc_number,m.name AS machine_name
      FROM plate_asset_movements pam LEFT JOIN job_cards jc ON jc.id=pam.job_card_id
      LEFT JOIN machines m ON m.id=pam.machine_id
      WHERE pam.plate_asset_id=$1 ORDER BY pam.id DESC`, [asset.id]);
    res.json({ ...asset, movements });
  } catch (error) { next(error); }
});

// A plate died on the press. The operator says which and why; the plate leaves the
// run immediately (so completion stops asking him to hand back something that is in
// the bin), its requirement component reopens as a replacement so the existing PR
// machinery picks it up, and management, planning, the press and CTP all hear.
r.post('/job-stages/:id/plate-replacement', requireRole('production', 'planner'), async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const stage = await oc(`SELECT js.*, jc.jc_number, jc.status AS jc_status
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE js.id=$1 FOR UPDATE OF js`, [req.params.id]);
      if (!stage) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (stage.stage !== 'printing')
        throw Object.assign(new Error('Plates are replaced at printing, not at ' + stage.stage.replace('_', ' ')), { status: 409 });
      if (stage.jc_status === 'closed')
        throw Object.assign(new Error('Job is already closed'), { status: 409 });
      if (!['in_progress', 'hold', 'partially_completed'].includes(stage.status))
        throw Object.assign(new Error('A plate can only be replaced while the press is running or on hold'), { status: 409 });

      const issuedAssets = await issuedPlatesForStage(qc, oc, stage.id, true);
      const picked = validatePlateReplacementRequest({
        issuedAssets,
        assetIds: req.body.asset_ids,
        reason: req.body.reason,
        note: req.body.note,
      });
      const reason = String(req.body.reason).trim();
      const note = (req.body.note || '').trim() || null;

      for (const asset of picked) {
        await qc(`UPDATE plate_assets SET status='damaged',condition='Damaged',
          current_job_card_id=NULL,rack_location=NULL,
          remarks=COALESCE($1,remarks),updated_at=now() WHERE id=$2`,
        [note || reason, asset.id]);
        // The component reopens rather than a new one being invented: approve/PO/GRN
        // already treat 'replacement_required' as work to be bought.
        await qc(`UPDATE plate_request_components
          SET status='replacement_required',matched_asset_id=NULL,proposed_asset_id=NULL,updated_at=now()
          WHERE id=$1`, [asset.request_component_id]);
        await qc(`INSERT INTO plate_asset_movements
          (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
           action,from_status,to_status,from_location,to_location,condition,note,user_name)
          VALUES ($1,$2,$3,$4,$5,'damaged','issued_to_printing','damaged','Printing',NULL,'Damaged',$6,$7)`,
        [asset.id, asset.request_component_id, asset.tooling_request_id, stage.job_card_id,
         stage.machine_id || null, note ? `${reason} — ${note}` : reason, req.user.name]);
      }

      const requestIds = [...new Set(picked.map(asset => asset.tooling_request_id).filter(Boolean))];
      for (const requestId of requestIds) {
        await qc(`UPDATE tooling_requests SET status='pending',approval_status='pending',updated_at=now()
          WHERE id=$1`, [requestId]);
        await qc(`INSERT INTO tooling_request_events
          (tooling_request_id,action,from_status,to_status,note,user_name)
          VALUES ($1,'plate_replacement_requested','issued_to_floor','pending',$2,$3)`,
        [requestId, `${picked.length} plate(s) replaced from the press — ${reason}`, req.user.name]);
      }

      const names = picked.map(asset => asset.component_label).join(', ');
      await audit('job_card', stage.job_card_id, 'plate_replacement',
        `${picked.length} plate(s) replaced at printing — ${names} (${reason})`, qc, req.user.name);

      const users = await qc('SELECT id, active, role, sections, is_management FROM users');
      await notify(plateReplacementRecipients(users, req.user.id), {
        kind: 'plate_replacement',
        title: `Plate replacement needed — ${stage.jc_number}`,
        body: `${names} — ${reason}${note ? ` (${note})` : ''}, raised by ${req.user.name}`,
        link: '/tooling/plates',
        refTable: 'job_cards', refId: stage.job_card_id,
      }, qc);

      return { replaced: picked.length, components: names, requests: requestIds.length };
    });
    res.json(result);
  } catch (error) { next(error); }
});

r.get('/job-stages/:id/plate-disposition', async (req, res, next) => {
  try {
    // `assets` stays one row per physical plate — the completion form declares a
    // condition against each. `breakup`/`total` are the same set counted the way an
    // operator reads it ("Cyan × 2"), derived here so there is one definition of it.
    const assets = await issuedPlatesForStage(q, q, Number(req.params.id));
    res.json({ assets, ...issuedPlateSummary(assets) });
  } catch (error) { next(error); }
});

export default r;
