import {
  artworkVersionOf,
  PLATE_RETURN_QUEUE,
  plateComponentKey,
  plateComponentsFromSpec,
  plateComponentStatus,
  plateReadinessSummary,
  plateSizeOf,
  validatePlateDispositions,
} from './plates.js';

export function plateSpecification(target = {}) {
  const spec = {
    product_name: target.name,
    product_code: target.code,
    party_artwork_code: target.party_artwork_code || null,
    party_item_code: target.party_item_code || null,
    output_number: target.output_number || null,
    colors: target.colors ?? null,
    colour_type: target.colour_type || null,
    print_process: target.print_process || null,
    cmyk_colours: target.cmyk_colours ?? null,
    pantone_colours: target.pantone_colours ?? null,
    pantone_codes: target.pantone_codes || null,
    metallic_colours: target.metallic_colours ?? null,
    metallic_details: target.metallic_details || null,
    plate_size: target.plate_size || null,
  };
  return { ...spec, artwork_version: artworkVersionOf(spec) };
}

// A gang has one shared printing layout and therefore one shared Plate Set.
// Member products remain embedded for artwork traceability, but their colour
// demands are folded into one de-duplicated component list for the gang output.
export function gangPlateSpecification(gang = {}, targets = []) {
  const memberSpecs = targets.map(target => ({ target, spec: plateSpecification(target) }));
  const components = new Map();
  for (const { spec } of memberSpecs) {
    for (const component of plateComponentsFromSpec(spec)) {
      if (!components.has(plateComponentKey(component))) components.set(plateComponentKey(component), component);
    }
  }
  const rows = [...components.values()];
  const processCount = rows.filter(row => ['cyan','magenta','yellow','black'].includes(row.component_type)).length;
  const pantones = rows.filter(row => row.component_type === 'pantone' && !/^Metallic\s*-/i.test(row.component_label));
  const metallic = rows.filter(row => row.component_type === 'pantone' && /^Metallic\s*-/i.test(row.component_label));
  const outputNumber = gang.output_number || null;
  const gangNumber = gang.gang_number || `Gang ${gang.id || ''}`.trim();
  const base = memberSpecs[0]?.spec || {};
  return {
    ...base,
    product_name: gangNumber,
    product_code: gangNumber,
    output_number: outputNumber,
    artwork_version: outputNumber || gangNumber,
    colors: rows.length,
    colour_type: processCount === 4
      ? (pantones.length || metallic.length ? 'CMYK + Spot' : 'CMYK')
      : (pantones.length || metallic.length ? 'Pantone' : base.colour_type),
    cmyk_colours: processCount,
    pantone_colours: pantones.length,
    pantone_codes: pantones.map(row => row.pantone_code).filter(Boolean).join(', ') || null,
    metallic_colours: metallic.length,
    metallic_details: metallic.map(row => row.pantone_code).filter(Boolean).join(', ') || null,
    is_gang: true,
    gang_run_id: gang.id || null,
    gang_number: gangNumber,
    gang_members: memberSpecs.map(({ target, spec }) => ({
      order_line_id: target.order_line_id || null,
      product_id: target.product_id || target.id || null,
      product_name: target.name || spec.product_name || null,
      product_code: target.code || spec.product_code || null,
      customer_name: target.customer_name || null,
      output_number: target.output_number || null,
      artwork_version: spec.artwork_version,
      party_artwork_code: target.party_artwork_code || null,
      party_item_code: target.party_item_code || null,
    })),
  };
}

export async function plateMasterForSize(oc, size) {
  const normalized = plateSizeOf({ plate_size: size });
  if (!normalized) return null;
  return oc('SELECT * FROM plate_masters WHERE lower(plate_size)=lower($1) AND active=1', [normalized]);
}

async function bestPlateCandidate(oc, request, component, plateMasterId, excludedAssetIds = []) {
  const spec = request.specification || {};
  const values = [request.product_id, artworkVersionOf(spec), component.component_type, component.pantone_code || null];
  const masterSql = plateMasterId ? (values.push(plateMasterId), `AND pa.plate_master_id=$${values.length}`) : '';
  const excludedSql = excludedAssetIds.length
    ? (values.push(excludedAssetIds), `AND NOT (pa.id=ANY($${values.length}::int[]))`)
    : '';
  return oc(`SELECT pa.*, pm.plate_size
    FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
    WHERE pa.product_id=$1 AND lower(pa.artwork_version)=lower($2)
      AND pa.component_type=$3
      AND lower(COALESCE(pa.pantone_code,''))=lower(COALESCE($4,''))
      ${masterSql}
      ${excludedSql}
      AND pa.status='available' AND pa.active=1 AND pa.condition IN ('Good','Fair')
    ORDER BY pa.verified_at DESC NULLS LAST, pa.last_used_at DESC NULLS LAST, pa.id DESC LIMIT 1`, values);
}

export async function createPlateComponents(qc, oc, request, options = {}) {
  const spec = request.specification || {};
  const components = options.components || plateComponentsFromSpec(spec);
  const master = options.plateMasterId
    ? await oc('SELECT * FROM plate_masters WHERE id=$1 AND active=1', [options.plateMasterId])
    : await plateMasterForSize(oc, spec.plate_size || spec.sheet_size);
  const created = [];
  const proposedAssetIds = [];
  for (const component of components) {
    const candidate = await bestPlateCandidate(oc, request, component, master?.id, proposedAssetIds);
    if (candidate) proposedAssetIds.push(candidate.id);
    const [row] = await qc(`INSERT INTO plate_request_components
      (tooling_request_id,sequence_no,component_type,component_label,pantone_code,
       plate_master_id,status,proposed_asset_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [request.id, component.sequence_no, component.component_type, component.component_label,
     component.pantone_code, master?.id || null,
     candidate ? 'verification_required' : 'pr_required', candidate?.id || null]);
    if (candidate) {
      await qc(`INSERT INTO plate_asset_movements
        (plate_asset_id,request_component_id,tooling_request_id,job_card_id,action,
         from_status,to_status,from_location,to_location,condition,note,user_name)
        VALUES ($1,$2,$3,$4,'verification_requested',$5,$5,$6,$6,$7,$8,$9)`,
      [candidate.id, row.id, request.id, request.job_card_id, candidate.status,
       candidate.rack_location, candidate.condition,
       `Proposed for ${request.request_number}; physical verification required`, request.created_by || 'System']);
    }
    created.push({ ...row, proposed_asset: candidate || null });
  }
  return created;
}

export async function syncPlateRequest(qc, oc, requestId, userName = 'System') {
  const rows = await qc('SELECT * FROM plate_request_components WHERE tooling_request_id=$1 ORDER BY sequence_no', [requestId]);
  const summary = plateReadinessSummary(rows);
  const current = await oc('SELECT * FROM tooling_requests WHERE id=$1 FOR UPDATE', [requestId]);
  if (!current) return summary;
  let nextStatus = current.status;
  if (summary.is_ready) nextStatus = 'ready';
  else if (rows.some(row => ['approved','po_created','ordered','grn_received'].includes(row.status))) nextStatus = 'procurement';
  else if (rows.some(row => row.status === 'verified_existing')) nextStatus = 'rack_reserved';
  else if (nextStatus === 'ready') nextStatus = 'pending';
  if (nextStatus !== current.status) {
    await qc(`UPDATE tooling_requests SET status=$1,
      ready_at=CASE WHEN $1='ready' THEN now() ELSE NULL END,
      ready_by=CASE WHEN $1='ready' THEN $2 ELSE NULL END, updated_at=now() WHERE id=$3`,
    [nextStatus, userName, requestId]);
    await qc(`INSERT INTO tooling_request_events
      (tooling_request_id,action,from_status,to_status,note,user_name)
      VALUES ($1,'plate_readiness_sync',$2,$3,$4,$5)`,
    [requestId, current.status, nextStatus, `${summary.ready}/${summary.required} plates ready`, userName]);
  }
  return { ...summary, status: nextStatus };
}

export async function issuedPlatesForStage(qc, _oc, stageId, lock = false) {
  const suffix = lock ? ' FOR UPDATE OF pa' : '';
  // This query can return zero, one, or many assets. It must always use the
  // rows helper, including from the completion transaction where `oc` returns
  // a single row (or null).
  return qc(`SELECT pa.*, pm.plate_size, prc.id AS request_component_id,
      prc.component_label AS required_component_label, tr.id AS tooling_request_id,
      tr.request_number, jc.jc_number, jc.machine_id AS issued_machine_id,
      COALESCE(NULLIF(tr.specification->>'product_name',''),p.name) AS product_name,
      COALESCE(NULLIF(tr.specification->>'product_code',''),p.code) AS product_code,
      COALESCE(NULLIF(tr.specification->>'output_number',''),pa.output_number,p.output_number) AS output_number,
      COALESCE((tr.specification->>'is_gang')::boolean,false) AS is_gang,
      tr.specification->'gang_members' AS gang_members
    FROM job_stages js
    JOIN job_cards jc ON jc.id=js.job_card_id
    JOIN plate_assets pa ON pa.current_job_card_id=jc.id AND pa.status='issued_to_printing'
    JOIN plate_request_components prc ON prc.matched_asset_id=pa.id
    JOIN tooling_requests tr ON tr.id=prc.tooling_request_id AND tr.job_card_id=jc.id
    JOIN plate_masters pm ON pm.id=pa.plate_master_id
    JOIN products p ON p.id=pa.product_id
    WHERE js.id=$1 AND js.stage='printing'
    ORDER BY prc.sequence_no${suffix}`, [stageId]);
}

export async function issuePlateAssetsForJob(qc, oc, jobCard, machineId, userName) {
  const rows = await qc(`SELECT prc.*, pa.status AS asset_status, pa.rack_location,
      tr.request_number, tr.id AS tooling_request_id
    FROM tooling_requests tr
    JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
    JOIN plate_assets pa ON pa.id=prc.matched_asset_id
    WHERE tr.job_card_id=$1 AND tr.family='plate'
      AND prc.status IN ('verified_existing','available','reserved')
      AND pa.status IN ('reserved','available')
    ORDER BY tr.id,prc.sequence_no FOR UPDATE OF pa,prc`, [jobCard.id]);
  for (const row of rows) {
    await qc(`UPDATE plate_assets SET status='issued_to_printing',current_job_card_id=$1,
      last_used_at=now(),use_count=use_count+1,updated_at=now() WHERE id=$2`, [jobCard.id, row.matched_asset_id]);
    await qc(`UPDATE plate_request_components SET status='issued',updated_at=now() WHERE id=$1`, [row.id]);
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
       action,from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,$5,'issued',$6,'issued_to_printing',$7,'Printing',NULL,$8,$9)`,
    [row.matched_asset_id, row.id, row.tooling_request_id, jobCard.id, machineId || null,
     row.asset_status, row.rack_location, `Issued for ${row.request_number}`, userName]);
  }
  const requestIds = [...new Set(rows.map(row => row.tooling_request_id))];
  for (const requestId of requestIds) {
    await qc(`UPDATE tooling_requests SET status='issued_to_floor',updated_at=now() WHERE id=$1`, [requestId]);
  }
  return rows.length;
}

// The plate gate. Board stock is physics — issue it twice and the sheets are
// gone — but a plate's rack paperwork is not: the plates can be in the
// operator's hand while this table still says 'po_created', and refusing the
// start does not make a plate. It only stops the press while someone chases
// the record. So this reports rather than refuses, in the same shape as the
// shade-card alarm it sits beside in the printing start: name what is missing,
// let the supervisor overrule it, and record who did. `ack` is that decision
// arriving back from the operator; the caller audits it.
export async function assertPlateReadyForPrinting(qc, jobCardId, ack = false) {
  const rows = await qc(`SELECT prc.status, prc.component_label, tr.request_number
    FROM tooling_requests tr JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
    WHERE tr.job_card_id=$1 AND tr.family='plate' AND prc.status<>'cancelled'
    ORDER BY tr.id, prc.sequence_no`, [jobCardId]);
  if (!rows.length) return { required: 0, ready: 0, is_ready: true };
  const summary = plateReadinessSummary(rows);
  if (summary.is_ready) return { ...summary, overridden: false };
  // Naming the components is the whole point of the message. "0 of 4 available"
  // tells a press operator nothing he can act on; "Magenta, Black" tells him
  // exactly which plate to go and look for.
  const missing = rows
    .filter(row => plateComponentStatus(row.status) !== 'ready')
    .map(row => ({ component_label: row.component_label, status: row.status }));
  const detail = {
    ...summary,
    missing,
    request_numbers: [...new Set(rows.map(row => row.request_number).filter(Boolean))],
  };
  if (ack) return { ...detail, overridden: true };
  throw Object.assign(
    new Error(`Plates are not ready — ${summary.ready} of ${summary.required} available (${
      missing.map(row => row.component_label || row.status).join(', ')})`),
    { status: 409, body: { code: 'PLATES_NOT_READY', plates: detail } },
  );
}

export async function applyPlateDispositions(qc, oc, stageId, dispositions, userName) {
  const assets = await issuedPlatesForStage(qc, oc, stageId, true);
  const decisions = validatePlateDispositions(assets, dispositions || []);
  for (const decision of decisions) {
    const { asset, action } = decision;
    const next = 'returned_pending_verification';
    const condition = asset.condition || 'Good';
    await qc(`UPDATE plate_assets SET status=$1,condition=$2,current_job_card_id=NULL,
      rack_location=$3,remarks=COALESCE($4,remarks),updated_at=now() WHERE id=$5`,
    [next, condition, PLATE_RETURN_QUEUE, decision.note || null, asset.id]);
    await qc(`UPDATE plate_request_components SET status=$1,updated_at=now() WHERE id=$2`,
      [next, asset.request_component_id]);
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
       action,from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,$5,'returned','issued_to_printing',$6,'Printing',$7,$8,$9,$10)`,
    [asset.id, asset.request_component_id, asset.tooling_request_id, asset.current_job_card_id,
     asset.issued_machine_id || null, next, PLATE_RETURN_QUEUE, condition, decision.note || null, userName]);
  }
  for (const requestId of [...new Set(decisions.map(decision => decision.asset.tooling_request_id))]) {
    await qc('UPDATE tooling_requests SET status=$1,updated_at=now() WHERE id=$2', ['returned_pending_verification', requestId]);
  }
  return decisions.length;
}
