import {
  artworkVersionOf,
  hasDripOffCoating,
  isBareArtworkRevision,
  isDripOff,
  nextPlateRequestStatus,
  PLATE_HELD_COMPONENT_STATUSES,
  PLATE_RETURN_QUEUE,
  plateArtworkKey,
  plateArtworkMatchSql,
  plateComponentKey,
  plateComponentSize,
  plateComponentsFromSpec,
  plateComponentStatus,
  plateReadinessSummary,
  plateSizeOf,
  validatePlateDispositions,
} from './plates.js';

// ONE spelling of "that rack plate is already spoken for", aliased `pa`.
//
// `status='available'` is not the whole answer. A plate matched to a requirement
// through the verification path stayed 'available' on the asset — nothing in the
// module ever wrote 'reserved', although the release path had always looked for
// it — so the same plate could be proposed to a second requirement, verified
// twice, and issued to whichever job reached the press first. Both the picker and
// the availability count ask this, so a plate can never be offered while another
// line is holding it.
export const PLATE_ALREADY_CLAIMED_SQL = `EXISTS (
  SELECT 1 FROM plate_request_components claimed
  WHERE claimed.matched_asset_id=pa.id
    AND claimed.status IN (${PLATE_HELD_COMPONENT_STATUSES.map(status => `'${status}'`).join(',')}))`;

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
    // The coating travels with the spec so the component derivation can add
    // the DRIP OFF mask — a drip-off carton needs a plate for it, always.
    coating: target.coating || null,
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
  // One shared sheet coats once: any drip-off member puts ONE drip mask on the
  // gang, and the gang spec carries that member's coating so re-deriving from
  // the spec reproduces it. The mask is not a colour — see `colors` below.
  const dripCoating = memberSpecs.map(({ spec }) => spec.coating)
    .find(coating => hasDripOffCoating({ coating })) || null;
  const outputNumber = gang.output_number || null;
  const gangNumber = gang.gang_number || `Gang ${gang.id || ''}`.trim();
  const base = memberSpecs[0]?.spec || {};
  return {
    ...base,
    product_name: gangNumber,
    product_code: gangNumber,
    output_number: outputNumber,
    artwork_version: outputNumber || gangNumber,
    coating: dripCoating ?? base.coating ?? null,
    colors: rows.filter(row => !isDripOff(row)).length,
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

// Every plate the rack can offer this component, best first.
//
// ONE spelling of the candidate set. bestPlateCandidate is its head, the picker
// lists it, and rackReusePlan counts against the same rules — so the column can
// never promise a plate the button refuses, nor the picker offer one it cannot
// take. Same law as plateArtworkMatchSql, one level up.
export async function plateCandidates(rows, request, component, plateMasterId, excludedAssetIds = [], limit = null) {
  const spec = request.specification || {};
  const version = artworkVersionOf(spec);
  const values = [request.product_id, plateArtworkKey(version), component.component_type,
    component.pantone_code || null, isBareArtworkRevision(version)];
  const masterSql = plateMasterId ? (values.push(plateMasterId), `AND pa.plate_master_id=$${values.length}`) : '';
  const excludedSql = excludedAssetIds.length
    ? (values.push(excludedAssetIds), `AND NOT (pa.id=ANY($${values.length}::int[]))`)
    : '';
  const limitSql = limit ? (values.push(limit), `LIMIT $${values.length}`) : '';
  return rows(`SELECT pa.*, pm.plate_size,
      (CURRENT_DATE-pa.plate_created_on)::int AS age_days
    FROM plate_assets pa JOIN plate_masters pm ON pm.id=pa.plate_master_id
    WHERE pa.product_id=$1 AND ${plateArtworkMatchSql('pa.artwork_version', '$2', '$5')}
      AND pa.component_type=$3
      AND lower(COALESCE(pa.pantone_code,''))=lower(COALESCE($4,''))
      ${masterSql}
      ${excludedSql}
      AND pa.status='available' AND pa.active=1 AND pa.condition IN ('Good','Fair')
      AND NOT ${PLATE_ALREADY_CLAIMED_SQL}
    -- Condition first, wear second. A Good plate ALWAYS beats a Fair one, however
    -- many runs each has had: a worn-but-sound plate is a better bet on press than a
    -- fresh plate somebody has already graded down. Within a condition the least-worn
    -- plate is proposed; then the one idle longest, so the rack rotates instead of
    -- favouring one corner of it; id last, purely so the choice is deterministic.
    --
    -- This used to lead with verified_at DESC, which proposed whichever plate had
    -- most recently been LOOKED AT — unrelated to either condition or life left, and
    -- on a rack of identical plates it kept handing back the same one.
    ORDER BY CASE pa.condition WHEN 'Good' THEN 0 ELSE 1 END,
             pa.use_count ASC,
             pa.last_used_at ASC NULLS FIRST,
             pa.id ${limitSql}`, values);
}

// Takes a ROWS helper, not the one-row `oc` this used to be called with — see
// the call-site change below.
export async function bestPlateCandidate(rows, request, component, plateMasterId, excludedAssetIds = []) {
  const [first] = await plateCandidates(rows, request, component, plateMasterId, excludedAssetIds, 1);
  return first || null;
}

export async function createPlateComponents(qc, oc, request, options = {}) {
  const spec = request.specification || {};
  const components = options.components || plateComponentsFromSpec(spec);
  const master = options.plateMasterId
    ? await oc('SELECT * FROM plate_masters WHERE id=$1 AND active=1', [options.plateMasterId])
    : await plateMasterForSize(oc, spec.plate_size || spec.sheet_size);
  // The DRIP OFF mask sizes ITSELF: 560 x 670 by default, or the size its own
  // row named — never the ink set's master, which can be 600 x 730 while the
  // mask stays 560 x 670. An explicit plate_master_id on a component (the PUT
  // route resolves one) always wins. Resolved once per distinct size.
  const dripMasters = new Map();
  const masterOf = async component => {
    if (component.plate_master_id) return { id: component.plate_master_id };
    if (!isDripOff(component)) return master;
    const size = plateComponentSize(component);
    if (!dripMasters.has(size)) dripMasters.set(size, await plateMasterForSize(oc, size));
    return dripMasters.get(size);
  };
  const created = [];
  const proposedAssetIds = [];
  for (const component of components) {
    const componentMaster = await masterOf(component);
    const candidate = await bestPlateCandidate(qc, request, component, componentMaster?.id, proposedAssetIds);
    if (candidate) proposedAssetIds.push(candidate.id);
    const [row] = await qc(`INSERT INTO plate_request_components
      (tooling_request_id,sequence_no,component_type,component_label,pantone_code,
       plate_master_id,status,proposed_asset_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [request.id, component.sequence_no, component.component_type, component.component_label,
     component.pantone_code, componentMaster?.id || null,
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
  const nextStatus = nextPlateRequestStatus({ current: current.status, rows, summary });
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
  // The DRIP OFF mask is carved out: it is the coating line's plate, issued by
  // issueDripOffPlatesForJob when COATING starts. Carrying it to the press
  // would spend its single use on a machine that has no way to run it.
  const rows = await qc(`SELECT prc.*, pa.status AS asset_status, pa.rack_location,
      tr.request_number, tr.id AS tooling_request_id
    FROM tooling_requests tr
    JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
    JOIN plate_assets pa ON pa.id=prc.matched_asset_id
    WHERE tr.job_card_id=$1 AND tr.family='plate'
      AND prc.component_type<>'dripoff'
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

// COATING START SHOPS THE RACK — for the DRIP OFF mask alone.
//
// A drip-off carton cannot coat without its mask, so the moment coating starts
// the mask leaves the rack by itself: a component already holding a plate is
// issued directly, and one holding nothing is auto-matched to the best rack
// plate (the same bestPlateCandidate the PR form spends). Where the rack has
// nothing, the start goes ahead and the shortage is RETURNED for the caller to
// audit — never a refusal, and never a purchase request: raising plates stays
// a human decision, and a start is never held over paperwork
// (plates-never-block).
//
// Everything is named as coating work: status 'issued_to_coating', location
// 'Coating'. 'issued_to_printing' would put the coating line's plate on the
// press in every register that reads the words.
export async function issueDripOffPlatesForJob(qc, oc, jobCard, machineId, userName) {
  const rows = await qc(`SELECT prc.*, tr.request_number, tr.id AS tooling_request_id,
      tr.specification, tr.product_id
    FROM tooling_requests tr
    JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
    WHERE tr.job_card_id=$1 AND tr.family='plate' AND prc.component_type='dripoff'
      AND prc.status NOT IN ('issued','cancelled','scrapped','not_found')
    ORDER BY tr.id,prc.sequence_no FOR UPDATE OF prc`, [jobCard.id]);
  const issued = [];
  const missing = [];
  const taken = [];
  for (const row of rows) {
    const request = {
      id: row.tooling_request_id, product_id: row.product_id, request_number: row.request_number,
      specification: row.specification, job_card_id: jobCard.id,
    };
    // The plate this line already holds, if it still stands where the paperwork
    // left it; otherwise the best the rack can offer right now.
    let asset = row.matched_asset_id
      ? await oc(`SELECT * FROM plate_assets WHERE id=$1
          AND status IN ('reserved','available') AND active=1 FOR UPDATE`, [row.matched_asset_id])
      : null;
    let autoPicked = false;
    if (!asset) {
      const candidate = await bestPlateCandidate(qc, request, row, row.plate_master_id, taken);
      asset = candidate
        ? await oc(`SELECT * FROM plate_assets WHERE id=$1 AND status='available' AND active=1 FOR UPDATE`,
          [candidate.id])
        : null;
      autoPicked = Boolean(asset);
    }
    if (!asset) {
      missing.push({ component_label: row.component_label, request_number: row.request_number, status: row.status });
      continue;
    }
    taken.push(asset.id);
    await qc(`UPDATE plate_assets SET status='issued_to_coating',current_job_card_id=$1,
      last_used_at=now(),use_count=use_count+1,rack_location='Coating',updated_at=now() WHERE id=$2`,
    [jobCard.id, asset.id]);
    await qc(`UPDATE plate_request_components SET status='issued',matched_asset_id=$1,
      proposed_asset_id=COALESCE(proposed_asset_id,$1),updated_at=now() WHERE id=$2`, [asset.id, row.id]);
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
       action,from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,$5,'issued',$6,'issued_to_coating',$7,'Coating',NULL,$8,$9)`,
    [asset.id, row.id, row.tooling_request_id, jobCard.id, machineId || null,
     asset.status, asset.rack_location,
     `DRIP OFF issued for ${row.request_number} at coating start`
       + (autoPicked ? ` — auto-picked from ${asset.rack_location || 'the rack'}, physical verification pending` : ''),
     userName]);
    issued.push({
      asset_id: asset.id, asset_number: asset.asset_number,
      tooling_request_id: row.tooling_request_id, request_number: row.request_number,
      auto_picked: autoPicked,
    });
  }
  for (const requestId of [...new Set(issued.map(row => row.tooling_request_id))]) {
    await qc(`UPDATE tooling_requests SET status='issued_to_floor',updated_at=now() WHERE id=$1`, [requestId]);
  }
  return { issued, missing };
}

// COATING COMPLETION CONSUMES THE DRIP PLATE.
//
// There is no reuse of a drip-off mask and therefore no return: it has run its
// one job, so it leaves the active pool as scrapped — never the Plate Return
// Queue, which exists to grade plates that might print again. Nothing asks the
// operator, because there is no decision to make; and nothing throws, because
// a completion is never refused over plates.
//
// LEFT JOIN on the component: a mask issued by hand from the warehouse has no
// requirement line, and it is consumed all the same.
export async function consumeDripOffPlatesForStage(qc, oc, stageId, userName) {
  const assets = await qc(`SELECT pa.*, prc.id AS request_component_id,
      prc.tooling_request_id, jc.id AS held_job_card_id, js.machine_id AS stage_machine_id
    FROM job_stages js
    JOIN job_cards jc ON jc.id=js.job_card_id
    JOIN plate_assets pa ON pa.current_job_card_id=jc.id AND pa.status='issued_to_coating'
    LEFT JOIN plate_request_components prc ON prc.matched_asset_id=pa.id AND prc.status='issued'
    WHERE js.id=$1 AND js.stage='coating'
    ORDER BY pa.id FOR UPDATE OF pa`, [stageId]);
  for (const asset of assets) {
    await qc(`UPDATE plate_assets SET status='scrapped',condition='Scrapped',active=0,
      current_job_card_id=NULL,rack_location='Scrap',updated_at=now() WHERE id=$1`, [asset.id]);
    if (asset.request_component_id) {
      await qc(`UPDATE plate_request_components SET status='scrapped',updated_at=now() WHERE id=$1`,
        [asset.request_component_id]);
    }
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
       action,from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,$5,'scrapped','issued_to_coating','scrapped','Coating','Scrap','Scrapped',$6,$7)`,
    [asset.id, asset.request_component_id || null, asset.tooling_request_id || null,
     asset.held_job_card_id, asset.stage_machine_id || null,
     'DRIP OFF is single use — consumed at coating completion, no return to rack', userName]);
  }
  // Same close applyPlateDispositions writes: the request's own question is
  // "is this requirement still open work?", and coating completion is the last
  // plate event a job has — the ink plates went back when printing completed.
  for (const requestId of [...new Set(assets.map(row => row.tooling_request_id).filter(Boolean))]) {
    await qc(`UPDATE tooling_requests SET status='returned_to_rack',updated_at=now() WHERE id=$1`, [requestId]);
  }
  return assets.length;
}

// What the press should be TOLD about its plates. Board stock is physics —
// issue it twice and the sheets are gone — but a plate's rack paperwork is not:
// the plates can be in the operator's hand while this table still says
// 'po_created', and refusing the start does not make a plate. It only stops the
// press while somebody chases the record.
//
// So this never throws. Plates were reconnected to the plant flow on the
// explicit condition that they can never refuse a start; naming the shortage is
// the whole point of the message. "Magenta, Black" tells an operator which plate
// to go and look for; "0 of 4 available" tells him nothing. The caller audits it.
export async function plateReadinessForPrinting(qc, jobCardId) {
  // The DRIP OFF mask has nothing to do with printing — counting it here would
  // report a press short over a plate only the coating line will ever hold.
  const rows = await qc(`SELECT prc.status, prc.component_label, tr.request_number
    FROM tooling_requests tr JOIN plate_request_components prc ON prc.tooling_request_id=tr.id
    WHERE tr.job_card_id=$1 AND tr.family='plate' AND prc.status<>'cancelled'
      AND prc.component_type<>'dripoff'
    ORDER BY tr.id, prc.sequence_no`, [jobCardId]);
  if (!rows.length) return { required: 0, ready: 0, pending: 0, is_ready: true, missing: [], request_numbers: [] };
  const summary = plateReadinessSummary(rows);
  const missing = rows
    .filter(row => plateComponentStatus(row.status) !== 'ready')
    .map(row => ({ component_label: row.component_label, status: row.status }));
  return {
    ...summary,
    missing,
    request_numbers: [...new Set(rows.map(row => row.request_number).filter(Boolean))],
  };
}

export async function applyPlateDispositions(qc, oc, stageId, dispositions, userName) {
  const assets = await issuedPlatesForStage(qc, oc, stageId, true);
  const decisions = validatePlateDispositions(assets, dispositions || []);
  for (const decision of decisions) {
    const { asset } = decision;
    // A plate nobody handed back has nothing to verify and no rack to sit in, so it
    // leaves the active pool entirely rather than joining the return queue. The
    // component reads 'not_found' — its own vocabulary's word for the same fact.
    const lost = decision.action === 'lost';
    const scrapped = decision.action === 'scrap';
    // Only a plate that came back joins the queue. One the press finished, or one
    // nobody can find, leaves the active pool here — there is nothing to inspect.
    const next = scrapped ? 'scrapped' : lost ? 'lost' : 'returned_pending_verification';
    const componentStatus = scrapped ? 'scrapped' : lost ? 'not_found' : next;
    const location = scrapped ? 'Scrap' : lost ? null : PLATE_RETURN_QUEUE;
    // The press has just handled this plate, so its word on the condition replaces
    // whatever the asset carried when it left the rack.
    const condition = decision.condition;
    await qc(`UPDATE plate_assets SET status=$1,condition=$2,current_job_card_id=NULL,
      rack_location=$3,active=CASE WHEN $1 IN ('lost','scrapped') THEN 0 ELSE active END,
      remarks=COALESCE($4,remarks),updated_at=now() WHERE id=$5`,
    [next, condition, location, decision.note || null, asset.id]);
    await qc(`UPDATE plate_request_components SET status=$1,updated_at=now() WHERE id=$2`,
      [componentStatus, asset.request_component_id]);
    await qc(`INSERT INTO plate_asset_movements
      (plate_asset_id,request_component_id,tooling_request_id,job_card_id,machine_id,
       action,from_status,to_status,from_location,to_location,condition,note,user_name)
      VALUES ($1,$2,$3,$4,$5,$6,'issued_to_printing',$7,'Printing',$8,$9,$10,$11)`,
    [asset.id, asset.request_component_id, asset.tooling_request_id, asset.current_job_card_id,
     asset.issued_machine_id || null, scrapped ? 'scrapped' : lost ? 'not_found' : 'returned',
     next, location, condition, decision.note || null, userName]);
  }
  // 'returned_pending_verification' describes a PLATE, and is a legal state for
  // plate_assets and plate_request_components — but tooling_requests has its own
  // vocabulary (TOOLING_REQUEST_STATUSES) with no such member, so writing it here
  // failed the CHECK constraint and took down every completion carrying plates.
  // The request's own question is "is this requirement still open work?", and once
  // the plates are off the press the answer is no; where each plate actually sits
  // stays on the asset and its component, which do model the return queue.
  for (const requestId of [...new Set(decisions.map(decision => decision.asset.tooling_request_id))]) {
    await qc('UPDATE tooling_requests SET status=$1,updated_at=now() WHERE id=$2', ['returned_to_rack', requestId]);
  }
  return decisions.length;
}
