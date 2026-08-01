// Job cards + production stages.
// - readiness gate has NO bypass (a board shortage with a PR/PO on order is a
//   soft pass — the card carries a board_pending alarm until stock arrives)
// - first stage start consumes board stock (ledger row, FIFO)
// - strictly sequential stages, one in_progress at a time
// - final stage completion closes the job, credits FG, feeds dispatch
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import { audit, notify, setLineStatus, consumeFifo, mixFor, consumeMixHolds, clearMixPlan, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster, finaliseBlock, reopenBlock, printReverseBlockers, printQueueEditBlock, adjustBoardStock, recalcStageFromRuns, upstreamAvailable, stageReceipt, previousStage, pressOverride, sheetsRequired, netProduceQty, effectiveParent, childFit, cutLayout, parentSheetsRequired, readiness, readinessBatch, stageReversePlan, sendStageBack, reverseNeedsApprover, pullBackToJobCard } from '../helpers.js';
import { rowCovers } from '../board-mix.js';
import { rollupRuns, runCapacity, receiptFor, previousOf } from '../stage-runs.js';
import { cuttingVariance } from '../production-variance.js';
import { findClashes, familyKey } from '../product-family.js';
import { toolingDetail, toolingGateOk } from '../tooling-gate.js';
import { readinessLight, lightForJobCards } from '../readiness-light.js';
import { printingEligibility, codeMatch } from '../shade-flow.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');
const canRun = requireRole('production');

// board_pending: the job card exists but its board hasn't arrived yet — no
// sheets consumed for this card and available stock is below sheets_issued.
// Computed live so the alarm clears itself the moment a GRN lands.
const JC_VIEW = `
  SELECT jc.*, p.name AS product_name, p.code AS product_code, p.size,
         p.gsm, p.special,
         -- Effective spec: the job override wins over the product master for a
         -- plain card (ol) and a gang parent (gol = lead member) alike — a
         -- "this job only" change made in Planning/Artwork shows on the card.
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'ups')::int, p.ups) AS ups,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'colors')::int, p.colors) AS colors,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'child_w')::float, p.child_w) AS child_w,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'coating', p.coating) AS coating,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'emboss')::int, p.emboss) AS emboss,
         COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'leafing')::int, p.leafing) AS leafing,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'leafing_colour', p.leafing_colour) AS leafing_colour,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'pasting_type', p.pasting_type) AS pasting_type,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'shade_card_number', p.shade_card_number) AS shade_card_number,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'shade_card_date', p.shade_card_date) AS shade_card_date,
         -- Output number = the product master's print-set number (job override
         -- wins) — the same value Planning and Artwork edit. The plate tool's
         -- own output_no stays separate (attachTools → "Plate/Positive No").
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'output_number', p.output_number) AS output_number,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'block_number', NULLIF(p.block_number,''),
                  (SELECT t.code FROM tools t WHERE t.product_id=p.id AND t.family='block' AND t.active=1 ORDER BY t.id LIMIT 1)) AS block_number,
         ol.sheets_required, ol.parent_sheets_required, ol.planned_date,
         -- Approvals: a plain line uses its own; a gang parent (no order line)
         -- is approved/locked only when EVERY member carton is (MIN over members).
         COALESCE(ol.artwork_customer_ok, gagg.all_customer) AS artwork_customer_ok,
         COALESCE(ol.artwork_qa_ok, gagg.all_qa) AS artwork_qa_ok,
         COALESCE(ol.artwork_locked, gagg.all_locked) AS artwork_locked,
         -- The board being USED. A planner's warehouse pick (spec_override) beats
         -- the product master, exactly as Planning (orders.js) and the Live Floor
         -- (floor.js STAGE_VIEW) already resolve it. Until this view did the same,
         -- the card — and the paper walking the floor — named the master's board
         -- while the stk lateral below counted the override's stock, so "Board
         -- pending, short N sheets of X" could name a board nobody was cutting.
         -- COALESCE(ol, gol) not the bare EFF_BOARD_ID helper: a gang parent has
         -- no order line of its own and reads its spec off the anchor member.
         COALESCE(ebm.id, bm.id) AS board_material_id,
         COALESCE(ebm.name, bm.name) AS board_name,
         COALESCE(ebm.sheet_l, bm.sheet_l) AS sheet_l,
         COALESCE(ebm.sheet_w, bm.sheet_w) AS sheet_w,
         -- The plant counts and stores board in PACKETS, so every sheet figure
         -- on a card carries its packet equivalent beside it.
         COALESCE(ebm.sheets_per_packet, bm.sheets_per_packet) AS sheets_per_packet,
         -- …and the master it was moved off, so the card can show the difference.
         p.board_material_id AS master_board_material_id,
         bm.name AS master_board_name,
         (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id') IS NOT NULL AS board_overridden,
         -- Grade of the board IN USE. p.board_grade and p.board_name are the
         -- product master's own copies — correct for the master's board and
         -- actively wrong once a planner moves the job elsewhere, which would
         -- print "SAFFIRE" beside an FBB board. So a job board takes its grade
         -- from the material it actually is; only a card still on its master
         -- board reads the master's copies.
         CASE WHEN (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id') IS NOT NULL
              THEN COALESCE(NULLIF(ebm.grade,''), NULLIF(split_part(ebm.name,' ',1),''))
              ELSE COALESCE(NULLIF(p.board_grade,''), NULLIF(split_part(p.board_name,' ',1),''),
                            NULLIF(bm.grade,''), split_part(bm.name,' ',1))
         END AS board_grade,
         -- Die number: an explicit job/master die text wins over the Tooling
         -- Hub die's auto code (which stays the fallback and the hub link).
         COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'die_number', NULLIF(p.die_number,''), dd.code) AS die_number,
         dd.condition AS die_condition, dd.location AS die_location,
         ol.qty AS line_qty, ol.order_id, COALESCE(ol.gang_run_id, jc.gang_run_id) AS line_gang_run_id, gg.gang_number,
         (jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL) AS gang_parent,
         gmm.members AS gang_members,
         o.po_number, o.delivery_date,
         c.name AS customer_name, m.name AS machine_name,
         -- Multi-board: a job with a job_board_mix plan carries its OWN
         -- shortfall, one row per board, instead of the single planned board's
         -- gap. bmp (below) folds both derived columns into one LATERAL so the
         -- mix is only read once per job card. The ELSE arm of each CASE is
         -- character-identical to the pre-mix expression, so a job with no mix
         -- rows (bmp.n = 0, including every gang card — see bmp's own comment)
         -- computes exactly what it always did.
         (jc.status IN ('open','in_progress')
          AND NOT EXISTS (SELECT 1 FROM stock_movements sm
                          WHERE sm.ref_type='job_card' AND sm.ref_id=jc.id AND sm.type='consumption')
          AND CASE WHEN bmp.n > 0 THEN bmp.short > 0 ELSE stk.avail < jc.sheets_issued END) AS board_pending,
         CASE WHEN bmp.n > 0 THEN bmp.short::int ELSE GREATEST(0, jc.sheets_issued - stk.avail)::int END AS board_short_sheets
  FROM job_cards jc
  JOIN products p ON p.id = jc.product_id
  JOIN materials bm ON bm.id = p.board_material_id
  LEFT JOIN tools dd ON dd.id = p.tool_id
  LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
  -- (ebm is joined after ol/gol below — it depends on both spec_overrides)
  LEFT JOIN LATERAL (
    SELECT ol2.* FROM order_lines ol2
    WHERE ol2.gang_run_id=jc.gang_run_id
    ORDER BY ol2.id LIMIT 1
  ) gol ON jc.order_line_id IS NULL
  -- LEFT, deliberately: the master join above is the one that must never drop a
  -- row. If a spec_override ever pointed at a material that no longer exists the
  -- card falls back to the master rather than vanishing from the register.
  LEFT JOIN materials ebm ON ebm.id = COALESCE(
    (COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN machines m ON m.id = jc.machine_id
  LEFT JOIN LATERAL (
    SELECT MIN(ga.artwork_customer_ok) AS all_customer,
           MIN(ga.artwork_qa_ok) AS all_qa,
           MIN(ga.artwork_locked) AS all_locked
    FROM order_lines ga WHERE ga.gang_run_id = jc.gang_run_id
  ) gagg ON jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL
  LEFT JOIN gang_runs gg ON gg.id = COALESCE(ol.gang_run_id, jc.gang_run_id)
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'line_id', ol3.id, 'product_id', p3.id,
             'product_name', p3.name, 'product_code', p3.code,
             'qty', ol3.qty, 'po_number', o3.po_number, 'customer_name', c3.name,
             'sheets_required', ol3.sheets_required,
             'parent_sheets_required', ol3.parent_sheets_required,
             -- Per-carton artwork detail: each product on the gang sheet keeps
             -- its own colours, shade card, finishes and approvals (effective =
             -- job override wins over the product master).
             'colors', COALESCE((ol3.spec_override->>'colors')::int, p3.colors),
             'colour_type', COALESCE(ol3.spec_override->>'colour_type', p3.colour_type),
             'emboss', COALESCE((ol3.spec_override->>'emboss')::int, p3.emboss),
             'leafing', COALESCE((ol3.spec_override->>'leafing')::int, p3.leafing),
             'leafing_colour', COALESCE(ol3.spec_override->>'leafing_colour', p3.leafing_colour),
             'special', p3.special, 'size', p3.size,
             'ups', COALESCE((ol3.spec_override->>'ups')::int, p3.ups),
             'pasting_type', COALESCE(ol3.spec_override->>'pasting_type', p3.pasting_type),
             'child_l', COALESCE((ol3.spec_override->>'child_l')::float, p3.child_l),
             'child_w', COALESCE((ol3.spec_override->>'child_w')::float, p3.child_w),
             'output_number', COALESCE(ol3.spec_override->>'output_number', p3.output_number),
             'party_artwork_code', COALESCE(ol3.spec_override->>'party_artwork_code', p3.party_artwork_code),
             'shade_card_number', COALESCE(ol3.spec_override->>'shade_card_number', p3.shade_card_number),
             'shade_card_date', COALESCE(ol3.spec_override->>'shade_card_date', p3.shade_card_date),
             'artwork_customer_ok', ol3.artwork_customer_ok,
             'artwork_qa_ok', ol3.artwork_qa_ok,
             'artwork_locked', ol3.artwork_locked,
             -- Live shade card from the Shade Card module (drives no. + age + status).
             'sc_number', sc3.sc_number, 'sc_date', sc3.creation_date,
             'sc_status', sc3.status, 'sc_rev', sc3.revision_no,
             'die_number', COALESCE(ol3.spec_override->>'die_number', NULLIF(p3.die_number,''), dd3.code),
             'block_number', COALESCE(ol3.spec_override->>'block_number', NULLIF(p3.block_number,''),
               (SELECT t.code FROM tools t WHERE t.product_id=p3.id AND t.family='block' AND t.active=1 ORDER BY t.id LIMIT 1))
           ) ORDER BY ol3.id) AS members
    FROM order_lines ol3
    JOIN orders o3 ON o3.id = ol3.order_id
    JOIN customers c3 ON c3.id = o3.customer_id
    JOIN products p3 ON p3.id = ol3.product_id
    LEFT JOIN tools dd3 ON dd3.id = p3.tool_id
    LEFT JOIN LATERAL (
      SELECT sc.sc_number, sc.creation_date, sc.status, sc.revision_no
      FROM shade_cards sc
      WHERE sc.product_id = p3.id AND sc.active=1 AND sc.status NOT IN ('superseded','archived')
      ORDER BY sc.id DESC LIMIT 1
    ) sc3 ON true
    WHERE ol3.gang_run_id = jc.gang_run_id
  ) gmm ON jc.order_line_id IS NULL AND jc.gang_run_id IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sb.qty),0) AS avail FROM stock_batches sb
    WHERE sb.material_id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
      AND sb.status='available'
  ) stk ON true
  -- bmp = board-mix position: this job's OWN job_board_mix plan rows, each
  -- checked against its own material's stock. jc.order_line_id is NULL for a
  -- gang parent/child, and SQL NULL is never "=" to anything (not even NULL),
  -- so x.order_line_id=jc.order_line_id matches zero rows there — bmp.n stays
  -- 0 and board_pending/board_short_sheets fall through to the single-board
  -- expression untouched. Gangs are excluded from this feature by design.
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(GREATEST(0, x.sheets - COALESCE(sa.q,0))), 0) AS short
    FROM job_board_mix x
    LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
               WHERE status='available' GROUP BY material_id) sa ON sa.material_id = x.material_id
    WHERE x.order_line_id = jc.order_line_id AND x.phase='plan'
  ) bmp ON true`;

// Artwork source: every active Tooling Hub record linked to the job's product,
// grouped by family (die / plate / block). The Job Card reads these live —
// filling/linking tooling in the hub populates the card automatically.
// The shade card comes LIVE from the Shade Card Management module the same way:
// number, revision, approval status/date and colour details auto-populate; the
// Job Card never stores its own copy.
async function attachTools(jc) {
  jc.tools = await q(`
    SELECT family, code, title, shade_ref, output_no, cylinder_no, emboss_type, colors, zone, condition, location, creation_date
    FROM tools WHERE product_id=$1 AND active=1 ORDER BY family, id`, [jc.product_id]);
  jc.shade_card = await one(`
    SELECT sc.id, sc.sc_number, sc.title, sc.status, sc.revision_no, sc.colour_system,
           sc.num_colours, sc.colour_details, sc.print_reference, sc.artwork_no, sc.artwork_rev,
           sc.approval_received_date, sc.internal_approval_date, sc.approval_method,
           sc.creation_date, sc.approval_requirement, sc.dock_zone
    FROM shade_cards sc
    WHERE sc.product_id=$1 AND sc.active=1 AND sc.status NOT IN ('superseded','archived')
    ORDER BY sc.id DESC LIMIT 1`, [jc.product_id]);
  return jc;
}

// Board Mix for the printed traveler and the cutting-completion panel — both
// need the full board breakup AND its cut geometry, not just the sheet count.
//
// Reads 'issued' first (what the warehouse actually confirmed/consumed) and
// falls back to 'plan' when that is empty — a job whose Planning mix hasn't
// reached Cutting Start yet still has a real plan to print/check against, and
// an empty table would tell the floor nothing rather than the best answer
// available. board_mix_phase says honestly which one the client is looking
// at, so the title never claims "As Issued" for a plan nobody has confirmed.
//
// Every row's cut geometry is derived fresh from cutLayout() at read time
// (this job's live effective child size against THAT row's own board), never
// re-read off a stored `ups` — the source of truth is the same one Planning
// and the release gate use, so a print or panel can never show an arrangement
// that disagrees with the count job_board_mix itself was saved with. In
// practice they always agree: re-planning a line clears its mix entirely
// (helpers.js clearMixPlan) the moment the effective child size changes, so a
// stored row's `ups` and a freshly computed cutLayout().count can never
// diverge on a live job.
//
// jc.cut_layout is the single-board convenience the client asked for: even a
// job with NO mix at all gets one geometry object, off the job card's own
// effective board/child (already on `jc` — see JC_VIEW), so the client's
// cutting-plan table never needs a second request just to draw one row.
async function attachBoardMix(jc) {
  let rows = jc.order_line_id ? await mixFor(jc.order_line_id, 'issued', q) : [];
  let phase = rows.length ? 'issued' : null;
  if (jc.order_line_id && !rows.length) {
    rows = await mixFor(jc.order_line_id, 'plan', q);
    phase = rows.length ? 'plan' : null;
  }
  const childSpec = { child_l: jc.child_l, child_w: jc.child_w };
  jc.board_mix_phase = phase;
  jc.board_mix = rows.map(row => ({
    ...row,
    cut: cutLayout({ sheet_l: row.sheet_l, sheet_w: row.sheet_w }, childSpec),
  }));
  jc.cut_layout = cutLayout({ sheet_l: jc.sheet_l, sheet_w: jc.sheet_w }, childSpec);
  return jc;
}

// Extra sheets issued straight to a stage, in the PARENT sheets CI-XS requests
// in. withReceipts() converts to each stage's own counting unit.
const STAGE_XS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(qty),0)::int AS qty
    FROM extra_sheet_requests WHERE job_stage_id = js.id AND status='issued') xsq ON true`;

// Hang a live receipt on each stage of a job card, so the card reads the same
// quantity the station does. qty_in stays on the row untouched — it is the
// stamped close-out value and reports still want it — but `received` is what a
// screen should show, because an open stage's input follows upstream and a
// stage started ahead of its upstream has no qty_in at all yet.
const withReceipts = (jc, stages) => stages.map(s => ({
  ...s,
  ...receiptFor({
    stage: s, prev: previousOf(stages, s), ups: jc.ups,
    childrenPerParent: jc.children_per_parent,
    extraParents: s.extra_issued_parents,
  }),
}));

// One job card's stages, each carrying its live receipt.
const loadStages = async jc => withReceipts(jc, await q(`
  SELECT js.*, m.name AS stage_machine_name, COALESCE(xsq.qty, 0) AS extra_issued_parents
  FROM job_stages js
  LEFT JOIN machines m ON m.id = js.machine_id
  ${STAGE_XS_LATERAL}
  WHERE js.job_card_id=$1 ORDER BY js.seq`, [jc.id]));

r.get('/job-cards', async (_req, res, next) => {
  try {
    const rows = await q(`${JC_VIEW} ORDER BY (jc.status='closed'), jc.id DESC`);
    const stages = await q(`SELECT js.*, COALESCE(xsq.qty, 0) AS extra_issued_parents
                            FROM job_stages js ${STAGE_XS_LATERAL} ORDER BY js.job_card_id, js.seq`);
    const byJc = {};
    for (const s of stages) (byJc[s.job_card_id] ||= []).push(s);
    res.json(rows.map(jc => ({ ...jc, stages: withReceipts(jc, byJc[jc.id] || []) })));
  } catch (e) { next(e); }
});

r.get('/job-cards/:id', async (req, res, next) => {
  try {
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    jc.stages = await loadStages(jc);
    jc.issues = await q(`
      SELECT sm.qty, sm.created_at, sm.note, sm.material_id, b.batch_no, mt.name AS material_name, mt.unit
      FROM stock_movements sm
      LEFT JOIN stock_batches b ON b.id = sm.batch_id
      LEFT JOIN materials mt ON mt.id = sm.material_id
      WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption'
      ORDER BY sm.id`, [jc.id]);
    // Multi-board: board_mix/board_mix_phase/cut_layout — see attachBoardMix's
    // own comment for the issued→plan fallback and the cut-geometry contract.
    await attachBoardMix(jc);
    await attachTools(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

r.put('/job-cards/:id', canPlan, async (req, res, next) => {
  try {
    const { qty_planned, sheets_issued, machine_id } = req.body;
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed') throw Object.assign(new Error('Closed job cards cannot be edited'), { status: 409 });
      if (jc.finalised_at) throw Object.assign(new Error('This job card is finalised. Reopen it before editing the fields.'), { status: 409 });
      const started = await oc(`
        SELECT 1 FROM job_stages
        WHERE job_card_id=$1 AND status IN ('in_progress','partially_completed','hold','completed')
        LIMIT 1`, [jc.id]);
      if (started) throw Object.assign(new Error('This job card has started. Reverse/correct stages instead of editing the card.'), { status: 409 });

      const sets = [];
      const vals = [];
      const add = (sql, value) => { vals.push(value); sets.push(`${sql}=$${vals.length}`); };
      if (qty_planned !== undefined) {
        const n = Number(qty_planned);
        if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Planned quantity must be greater than zero'), { status: 400 });
        add('qty_planned', Math.round(n));
      }
      if (sheets_issued !== undefined) {
        const n = Number(sheets_issued);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Issued sheets cannot be negative'), { status: 400 });
        add('sheets_issued', Math.round(n));
      }
      if (machine_id !== undefined) add('machine_id', machine_id || null);
      if (!sets.length) return;

      vals.push(jc.id);
      await qc(`UPDATE job_cards SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
      const detail = [
        qty_planned !== undefined && Math.round(+qty_planned) !== jc.qty_planned ? `qty_planned: ${jc.qty_planned} → ${Math.round(+qty_planned)}` : null,
        sheets_issued !== undefined && Math.round(+sheets_issued) !== jc.sheets_issued ? `sheets_issued: ${jc.sheets_issued} → ${Math.round(+sheets_issued)}` : null,
        machine_id !== undefined && (machine_id || null) !== jc.machine_id ? `machine: ${jc.machine_id ?? '—'} → ${machine_id || '—'}` : null,
      ].filter(Boolean).join('; ');
      await audit('job_card', jc.id, 'detail_form_saved', detail || 'Job card detail form saved', qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await loadStages(jc);
    jc.issues = await q(`
      SELECT sm.qty, sm.created_at, sm.note, sm.material_id, b.batch_no, mt.name AS material_name, mt.unit
      FROM stock_movements sm
      LEFT JOIN stock_batches b ON b.id = sm.batch_id
      LEFT JOIN materials mt ON mt.id = sm.material_id
      WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption'
      ORDER BY sm.id`, [jc.id]);
    // Same shape as the detail GET above. Without it the re-rendered card would
    // read board_mix as empty after a save and call a deliberately planned
    // second board an unplanned substitution.
    await attachBoardMix(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

// Finalise — the operator confirms the inherited data is correct and commits the
// editable fields. Requires artwork locked; the card becomes a read-only
// document and can be routed onward. Live join means specs still reflect masters.
r.post('/job-cards/:id/finalise', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      // A gang parent card has no single order line — its artwork is locked when
      // EVERY member carton is locked (MIN over the members = 1 only if all 1).
      const jc = await oc(`
        SELECT jc.status, jc.finalised_at,
               COALESCE(ol.artwork_locked,
                 (SELECT MIN(g.artwork_locked) FROM order_lines g WHERE g.gang_run_id = jc.gang_run_id)
               ) AS artwork_locked
        FROM job_cards jc LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
        WHERE jc.id=$1 FOR UPDATE OF jc`, [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const block = finaliseBlock(jc);
      if (block) throw Object.assign(new Error(block), { status: 409 });
      await qc('UPDATE job_cards SET finalised_at=now() WHERE id=$1', [req.params.id]);
      await audit('job_card', +req.params.id, 'finalised', 'Job card finalised', qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await loadStages(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

// Reopen — reverts finalisation so the editable fields can be corrected. Only
// while no stage has started and the card is not closed.
r.post('/job-cards/:id/reopen', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT status, finalised_at FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const started = await oc(`
        SELECT 1 FROM job_stages WHERE job_card_id=$1 AND status IN ('in_progress','partially_completed','hold','completed') LIMIT 1`, [req.params.id]);
      const block = reopenBlock({ ...jc, started: !!started });
      if (block) throw Object.assign(new Error(block), { status: 409 });
      await qc('UPDATE job_cards SET finalised_at=NULL WHERE id=$1', [req.params.id]);
      await audit('job_card', +req.params.id, 'reopened', 'Job card reopened for editing', qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await loadStages(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

// "Ready to Run" — a supervisor's manual green. It writes NO gate: the
// checklist behind the dot keeps reporting the truth underneath, so a hard
// blocker stays listed and the flip is only ever the statement "this press run
// may start". It lives on the CARD because an operator runs a card — for a gang
// that is the parent serving several lines, and Planning's per-line light stays
// computed so a member's own readiness is never silently rewritten.
const canOverrideReady = requireRole('planner', 'production');
r.post('/job-cards/:id/ready-override', canOverrideReady, async (req, res, next) => {
  try {
    const on = !!req.body.on;
    const reason = String(req.body.reason || '').trim();
    // Turning it ON is the whole point of the audit trail — a green nobody can
    // explain is worse than an amber.
    if (on && !reason) return res.status(400).json({ error: 'A reason is required to mark a job ready to run' });
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT id, jc_number, machine_id FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      await qc(`UPDATE job_cards
                   SET ready_override=$1, ready_override_by=$2,
                       ready_override_at=CASE WHEN $1=1 THEN now() END,
                       ready_override_reason=$3
                 WHERE id=$4`,
        [on ? 1 : 0, on ? req.user.name : null, on ? reason : null, jc.id]);
      await audit('job_card', jc.id, 'ready_override',
        on ? `Marked ready to run — ${reason}` : 'Ready-to-run override lifted', qc, req.user.name);
      // The press only learns it may start if its own login is told. A press's
      // crew comes through machine_operators, but those are employees and an
      // employee name has no bell — users.machine_ids is the mapping that says
      // which LOGIN sits at which press, the same one floorScope filters the
      // printing queue with. NULL there means "every press" (a planner, not an
      // operator), so containment deliberately leaves those users out.
      if (on && jc.machine_id) {
        const crew = await qc('SELECT id FROM users WHERE active=1 AND machine_ids @> $1::jsonb',
          [JSON.stringify([jc.machine_id])]);
        await notify(crew.map(u => u.id), {
          kind: 'ready_override',
          title: `${jc.jc_number} is marked ready to run`,
          body: `${req.user.name}: ${reason}`,
          link: '/print-planning',
          refTable: 'job_cards', refId: jc.id,
        }, qc);
      }
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await loadStages(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

// ── Amend — change job qty / sheets AFTER finalise (even mid-production), with
// a mandatory reason and a before→after audit trail. Order qty flows back to
// the sales line and the plan figures (sheets_required / parent_sheets_required)
// are re-derived with the same math the plan lock used, so Planning, Pendency,
// board demand and the stations all pick the new numbers up live.
// Rules:
//   • order_qty: plain/child cards only (a gang parent has no single line);
//     floor = qty already dispatched.
//   • sheets_issued: only while the CUTTING stage is still pending — board is
//     consumed at cutting start, so later corrections belong to the cutting
//     Adjust flow (which trues the board ledger up).
//   • qty_planned: any time before the job closes.
//   • When order_qty changes, qty_planned and (pre-cutting) sheets_issued
//     auto-follow the re-derived plan unless explicitly provided.
r.post('/job-cards/:id/amend', canPlan, async (req, res, next) => {
  try {
    const { order_qty, qty_planned, sheets_issued, reason } = req.body;
    if (!String(reason || '').trim()) {
      throw Object.assign(new Error('An amendment needs a reason — it goes on the audit trail'), { status: 400 });
    }
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed' || jc.status === 'split') {
        throw Object.assign(new Error('This job card is closed — amend the figures on the follow-up card instead'), { status: 409 });
      }
      const cutting = await oc(
        `SELECT status FROM job_stages WHERE job_card_id=$1 AND stage='cutting' ORDER BY seq LIMIT 1`, [jc.id]);
      const cuttingPending = !cutting || cutting.status === 'pending';
      const changes = [];

      // 1) Order quantity → sales line + re-derived plan figures.
      let derived = null;
      if (order_qty !== undefined && order_qty !== null && order_qty !== '') {
        if (!jc.order_line_id) {
          throw Object.assign(new Error('A gang parent has no single order line — amend each carton from Planning'), { status: 409 });
        }
        const nq = Math.round(+order_qty);
        if (!Number.isFinite(nq) || nq <= 0) throw Object.assign(new Error('Order quantity must be greater than zero'), { status: 400 });
        const line = await oc('SELECT * FROM order_lines WHERE id=$1 FOR UPDATE', [jc.order_line_id]);
        if (nq < line.dispatched_qty) {
          throw Object.assign(new Error(`Quantity cannot go below the ${line.dispatched_qty} already dispatched`), { status: 400 });
        }
        if (nq !== line.qty) {
          await qc('UPDATE order_lines SET qty=$1 WHERE id=$2', [nq, line.id]);
          changes.push(`order qty: ${line.qty} → ${nq}`);
          line.qty = nq;
          // Re-derive the locked plan with the same math the plan lock used —
          // effective spec (override wins), saved wastage, effective board.
          if (line.sheets_required != null) {
            const product = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
            const override = line.spec_override
              ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
              : {};
            const eff = { ...product, ...override };
            const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id || product.board_material_id]);
            const sheets = sheetsRequired(eff, netProduceQty(line), line.wastage_sheets);
            const fit = childFit(effectiveParent(eff, board), eff);
            const parentSheets = parentSheetsRequired(sheets, fit.count);
            await qc('UPDATE order_lines SET sheets_required=$1, parent_sheets_required=$2 WHERE id=$3',
              [sheets, parentSheets, line.id]);
            changes.push(`plan re-derived: ${sheets} child / ${parentSheets} parent sheets`);
            derived = { sheets, parentSheets, net: netProduceQty(line) };
            // Same invariant as plan-save: a mix row's ups/covers are frozen
            // against the cut plan that produced them, and this UPDATE just
            // replaced it. An amendment can land at ANY stage short of closed
            // — even mid-production — but clearMixPlan only ever touches
            // phase='plan' rows, so a job already past Cutting Start (whose
            // phase='issued' rows are the real record of board that left the
            // warehouse) is untouched; only a stale planning-time mix clears.
            await clearMixPlan(line.id, qc, req.user.name,
              `job card amended (order qty → ${nq}) — ${String(reason).trim()}`);
          }
          await audit('order_line', line.id, 'qty_amended',
            `${changes.join('; ')} — ${String(reason).trim()}`.slice(0, 500), qc, req.user.name);
        }
      }

      // 2) Job card figures — explicit values win over the auto-follow.
      const nextQtyPlanned = qty_planned !== undefined && qty_planned !== null && qty_planned !== ''
        ? Math.round(+qty_planned)
        : (derived && !jc.gang_run_id ? derived.net : undefined);
      const nextSheets = sheets_issued !== undefined && sheets_issued !== null && sheets_issued !== ''
        ? Math.round(+sheets_issued)
        : (derived && cuttingPending && !jc.gang_run_id ? derived.parentSheets : undefined);
      const jcChanges = [];
      if (nextQtyPlanned !== undefined) {
        if (!Number.isFinite(nextQtyPlanned) || nextQtyPlanned <= 0) throw Object.assign(new Error('Planned quantity must be greater than zero'), { status: 400 });
        if (nextQtyPlanned !== jc.qty_planned) jcChanges.push(['qty_planned', jc.qty_planned, nextQtyPlanned]);
      }
      if (nextSheets !== undefined) {
        if (!Number.isFinite(nextSheets) || nextSheets < 0) throw Object.assign(new Error('Issued sheets cannot be negative'), { status: 400 });
        if (nextSheets !== jc.sheets_issued) {
          if (!cuttingPending) {
            throw Object.assign(new Error('Cutting has already started/completed — the board is consumed. Use Adjust on the cutting stage instead.'), { status: 409 });
          }
          jcChanges.push(['sheets_issued', jc.sheets_issued, nextSheets]);
        }
      }
      if (jcChanges.length) {
        const sets = jcChanges.map(([f], i) => `${f}=$${i + 1}`).join(', ');
        await qc(`UPDATE job_cards SET ${sets} WHERE id=$${jcChanges.length + 1}`,
          [...jcChanges.map(([, , v]) => v), jc.id]);
        changes.push(...jcChanges.map(([f, a, b]) => `${f}: ${a} → ${b}`));
      }

      if (!changes.length) {
        throw Object.assign(new Error('Nothing changed — the amendment matches the current figures'), { status: 400 });
      }
      await audit('job_card', jc.id, 'amended',
        `${changes.join('; ')} — ${String(reason).trim()}`.slice(0, 500), qc, req.user.name);
    });
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.id]);
    jc.stages = await loadStages(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

// Create a job card from a ready order line. The gate runs for EVERY call.
r.post('/order-lines/:id/job-card', canPlan, async (req, res, next) => {
  try {
    const jcId = await tx(async (qc, oc) => {
      return createJobCardForLine(req.params.id, qc, oc, req.user.name);
    });
    res.json(await one(`${JC_VIEW} WHERE jc.id=$1`, [jcId]));
  } catch (e) { next(e); }
});

// Board issue — confirm the planned mix, or override it because the pile does
// not match the paper. Writes the phase='issued' rows that stage start consumes.
// Confirming with no edits copies the plan across verbatim; any change requires
// a reason and lands on the timeline as a deviation.
r.post('/job-cards/:id/board-issue', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      // FOR UPDATE, matching /job-stages/:id/start one route below: without it,
      // two concurrent POSTs for the same job card (a double-click, two open
      // tabs) can each pass the "not started" check, each DELETE-then-INSERT
      // job_board_mix, and land duplicate issued rows — which stage start
      // would then consume twice over. job_cards.order_line_id is UNIQUE, so
      // locking this one row serialises both requests onto the same mix.
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (!jc.order_line_id) throw Object.assign(
        new Error('A gang shares one board — issue it from the gang, not a member job'), { status: 409 });

      // Guard what this route actually protects: board leaving the warehouse,
      // not "some stage is in progress". Inline production is first-class here
      // — any station may be started at any time (see the same rule enforced
      // the other way at /job-stages/:id/start, below) — so a mixed job with
      // printing already running ahead of cutting is completely ordinary, and
      // board is consumed only once, at the first (cutting) stage. The old
      // `status <> 'pending'` check matched ANY stage, so that ordinary case
      // made this route permanently refuse "already started" while stage
      // start permanently refused "board mix never confirmed" — a dead end
      // with no way out. Same NOT EXISTS on stock_movements that JC_VIEW's
      // board_pending already runs, so a re-issue is refused only once board
      // has actually gone out, which is the one thing the "use the cutting
      // variance path instead" message is actually true of.
      const consumed = await oc(
        `SELECT 1 AS x FROM stock_movements sm
          WHERE sm.ref_type='job_card' AND sm.ref_id=$1 AND sm.type='consumption' LIMIT 1`,
        [jc.id]);
      if (consumed) throw Object.assign(
        new Error('Board has already been issued and consumed for this job — use the cutting variance path'), { status: 409 });

      const plan = await mixFor(jc.order_line_id, 'plan', qc);
      if (!plan.length) throw Object.assign(
        new Error('This job has no board mix — it issues its planned board'), { status: 409 });

      // BoardIssue.jsx only ever edits two fields of a row Planning already
      // produced — `sheets` and `stock_batch_id` — at the plan's own length and
      // order (client/src/components/BoardIssue.jsx: issueRows is seeded as a
      // 1:1 map of the plan, never reordered or given new rows). Trust nothing
      // else the client sends: material_id, ups, role (and covers, derived
      // below) always come from the matching PLAN row by position, never the
      // request body. Without this, a client bug or a crafted request could
      // name any material at all — including one never in this line's mix —
      // or ship a non-numeric sheets count that sails straight past
      // `CHECK (sheets > 0)`: Postgres orders NaN above every other double, so
      // 'NaN'::double precision > 0 is TRUE. consumeFifo(materialId, NaN, …)
      // then never satisfies `remaining <= 0`, and the loop walks every
      // available batch of that material setting qty = NaN before exiting with
      // no error — silent, total corruption of that material's stock ledger.
      // Same Number.isFinite guard orders.js's plan-save already runs, named
      // there by exactly this trap.
      const sent = Array.isArray(req.body.rows) ? req.body.rows : null;
      if (sent && sent.length !== plan.length) throw Object.assign(
        new Error('The issued boards no longer match the plan — reopen the start dialog'), { status: 409 });

      // plannedUps recovered algebraically from any plan row (covers = sheets
      // × ups ÷ plannedUps for every row, planned or substitute alike) rather
      // than assumed to be the role='planned' row's own ups — a mix the
      // planner built entirely from substitutes, with the planned-board row
      // itself removed, would otherwise leave no row to read it from.
      const anchor = plan[0];
      const plannedUps = anchor.ups * Number(anchor.sheets) / Number(anchor.covers);

      const rows = [];
      for (let i = 0; i < plan.length; i++) {
        const planRow = plan[i];
        const s = sent?.[i];
        const sheets = Number(sent ? s?.sheets : planRow.sheets);
        if (!Number.isFinite(sheets) || !(sheets > 0)) throw Object.assign(
          new Error(`Enter a sheet count for ${planRow.board_name}`), { status: 400 });

        // A named lot must belong to the board it is named against — same
        // guard orders.js's plan-save runs at plan-save time. material_id is
        // the server-trusted value from the plan row, never the client's.
        const rawBatch = sent ? s?.stock_batch_id : planRow.stock_batch_id;
        let stockBatchId = null;
        if (rawBatch) {
          stockBatchId = +rawBatch;
          const b = await oc('SELECT id FROM stock_batches WHERE id=$1 AND material_id=$2',
            [stockBatchId, planRow.material_id]);
          if (!b) throw Object.assign(
            new Error(`That lot does not belong to ${planRow.board_name} — pick a lot of this board, or leave it blank for FIFO`),
            { status: 409 });
        }

        rows.push({
          material_id: planRow.material_id,
          stock_batch_id: stockBatchId,
          sheets,
          ups: planRow.ups,
          covers: rowCovers({ sheets, ups: planRow.ups, plannedUps }),
          role: planRow.role,
          reason: planRow.reason,
        });
      }

      const changed = !sent ? false : rows.some((r, i) =>
        Number(r.sheets) !== Number(plan[i].sheets) || (r.stock_batch_id ?? null) !== (plan[i].stock_batch_id ?? null));
      const reason = String(req.body.reason || '').trim();
      if (changed && !reason) throw Object.assign(
        new Error('Say why the issued board differs from the plan'), { status: 400 });

      await qc(`DELETE FROM job_board_mix WHERE order_line_id=$1 AND phase='issued'`,
        [jc.order_line_id]);
      for (const r of rows) {
        await qc(
          `INSERT INTO job_board_mix
             (order_line_id, material_id, stock_batch_id, sheets, ups, covers, role, phase, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)`,
          [jc.order_line_id, r.material_id, r.stock_batch_id ?? null, r.sheets, r.ups, r.covers,
           r.role, changed ? reason : (r.reason ?? null), req.user.name]);
      }
      // Make the shortfall legible. An override need not balance — reality is
      // not obliged to match the plan — but "2 boards issued" hides the fact
      // that the job went out 300 sheets light. Say the number.
      const covered = rows.reduce((s, r) => s + Number(r.covers || 0), 0);
      const planned = plan.reduce((s, r) => s + Number(r.covers || 0), 0);
      const gap = Math.round(planned - covered);
      await audit('job_card', jc.id, changed ? 'board_issue_override' : 'board_issue_confirm',
        changed
          ? `issued differs from plan — ${reason}`
            + (gap ? ` (${gap > 0 ? `${gap} short of` : `${-gap} over`} the planned coverage)` : ' (coverage unchanged)')
          : `issued as planned (${rows.length} board${rows.length === 1 ? '' : 's'})`,
        qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Start a stage. First stage consumes board stock in the same transaction.
r.post('/job-stages/:id/start', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'pending') throw Object.assign(new Error('Stage already started'), { status: 409 });

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [st.job_card_id]);

      // Stations run inline: a job is often printed, coated and finished in one
      // pass, so ANY station may be started at any time — the Start button no
      // longer waits for the previous stage to finish, and several stages may run
      // at once. Upstream ordering is enforced at completion instead: a stage
      // cannot be completed until the stage before it is completed (see below).
      const prev = await previousStage(oc, st);

      // Two-parallel-workflow rule: printing can only begin once the job has
      // been assigned a press in Print Planning (Cutting done + Print Planning done).
      if (st.stage === 'printing' && !jc.machine_id)
        throw Object.assign(new Error('Assign this job to a press in Print Planning before printing can start'), { status: 409 });

      // Shade-card printing gate — ONE rule, the same one the readiness light
      // and the shade module use: the customer has approved and the approval is
      // still in date. The old product -> customer -> card requirement ladder is
      // gone with the twelve-status model, so every approval block here is hard.
      // A product with no card registered is not gated at all.
      //
      // The one soft path that remains is an artwork/output code MISMATCH, which
      // a supervisor acknowledges rather than being blocked by. Only 5 of 1594
      // products carry an output code, so a hard gate on it would refuse nearly
      // every job in the plant; what it catches is a master edited after the
      // customer signed.
      if (st.stage === 'printing') {
        const card = await oc(`
          SELECT sc.*, p.party_artwork_code AS product_artwork_code,
                 p.output_number AS product_output_number
          FROM shade_cards sc
          JOIN products p ON p.id = sc.product_id
          WHERE sc.product_id=$1 AND sc.active=1
          ORDER BY sc.id DESC LIMIT 1`, [jc.product_id]);
        if (card) {
          const gate = printingEligibility(card);
          if (!gate.eligible) throw Object.assign(new Error(gate.reason), { status: 409 });
          const match = codeMatch(card, {
            party_artwork_code: card.product_artwork_code,
            output_number: card.product_output_number,
          });
          if (!match.ok) {
            if (!req.body.ack_shade) {
              const detail = match.mismatches
                .map(m => `${m.field}: card ${m.card} vs master ${m.order}`).join('; ');
              const e = new Error(`Shade card ${card.sc_number} does not match the product master — ${detail}`);
              e.status = 409;
              e.body = {
                code: 'SHADE_CARD_NOT_ELIGIBLE',
                shade: { id: card.id, sc_number: card.sc_number, status: card.status,
                         mismatches: match.mismatches, reason: e.message },
              };
              throw e;
            }
            await audit('shade_card', card.id, 'ack_code_mismatch',
              `${card.sc_number}: printing started on ${jc.jc_number} with a code mismatch — acknowledged`,
              qc, req.user.name);
          }
        }
      }

      // Line clearance — every working station (cutting → pasting) must confirm
      // the checklist before the run starts. Accepts ["item", …] or
      // [{label, ok}, …]; every item must be ticked. QC is exempt.
      let clearance = null;
      if (st.stage !== 'qc') {
        const raw = Array.isArray(req.body.line_clearance) ? req.body.line_clearance : [];
        const items = raw.map(it => (typeof it === 'string' ? { label: it, ok: true } : { label: String(it?.label || ''), ok: !!it?.ok }))
          .filter(it => it.label);
        if (!items.length || items.some(it => !it.ok))
          throw Object.assign(new Error('Line clearance incomplete — confirm every checklist point before starting'), { status: 409 });
        clearance = JSON.stringify({ items: items.map(it => it.label), by: req.body.operator || req.user.name, at: new Date().toISOString() });
      }

      let qtyIn;
      if (!prev && jc.parent_job_card_id) {
        // Split gang child (post die-cut): the board was already issued to and
        // consumed by the gang PARENT at cutting. This card's first stage
        // (sorting) receives the die-cut CARTONS — it must NOT re-consume board.
        // Input = its planned carton count; any shortfall against what actually
        // arrives is flagged at completion via the Sort & Paste waste gate, never
        // hard-blocking the start.
        qtyIn = jc.qty_planned ?? jc.sheets_issued;
      } else if (!prev) {
        qtyIn = jc.sheets_issued;
        // Issue the line's EFFECTIVE board — a warehouse pick made in the
        // planning engine (spec_override) must be what cutting consumes.
        const eff = jc.order_line_id
          ? await oc(`
              SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
              FROM order_lines ol JOIN products p ON p.id=ol.product_id WHERE ol.id=$1`, [jc.order_line_id])
          : await oc(`
              SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
              FROM order_lines ol JOIN products p ON p.id=ol.product_id
              WHERE ol.gang_run_id=$1 ORDER BY ol.id LIMIT 1`, [jc.gang_run_id]);
        // Multi-board: a job may be fed by several boards of the same grade. The
        // ISSUED rows are the truth — Planning writes 'plan' rows, this stage's
        // confirm/override step writes 'issued' ones. With no rows at all this
        // is the single call it always was, unchanged.
        const issued = jc.order_line_id ? await mixFor(jc.order_line_id, 'issued', qc) : [];
        if (issued.length) {
          for (const r of issued) {
            // A named lot (Task 8b) actually draws from that lot first — not
            // just a note about it — so a planner can deliberately clear
            // ageing stock. consumeFifo re-checks the batch against THIS
            // material itself and falls through to FIFO on its own if the lot
            // is gone, empty, or names a different material — nothing here
            // (or upstream in orders.js's plan-save) cross-validates that a
            // row's stock_batch_id actually belongs to its own material_id,
            // so this is trusted at the point of consumption, not assumed.
            await consumeFifo(r.material_id, r.sheets, 'job_card', jc.id,
              `Issue to ${jc.jc_number} — ${r.board_name}${r.stock_batch_id ? ` (lot ${r.stock_batch_id})` : ''}`,
              qc, oc, r.stock_batch_id);
          }
          // The board has physically left the warehouse. Releasing instead of
          // consuming here would return the sheets to `free` and every later job
          // would read stock that no longer exists.
          await consumeMixHolds(jc.order_line_id, qc);
          // qty_in is the PARENT sheets that actually went on the machine, which
          // is the sum of the mix, not the planned-board figure on the card.
          qtyIn = issued.reduce((s, r) => s + Number(r.sheets || 0), 0);
          await audit('job_card', jc.id, 'board_mix_issued',
            issued.map(r => `${Math.round(r.sheets)} × ${r.board_name}`).join('; ').slice(0, 500),
            qc, req.user.name);
        } else {
          // A line planned across several boards must NEVER quietly draw its
          // whole requirement from the single planned board — that is the
          // exact physical misconsumption this feature exists to prevent,
          // and doing it silently would be worse than not having the
          // feature at all. The only way `issued` is empty here for a line
          // that DOES carry a phase='plan' mix is that board-issue was never
          // (successfully) confirmed before Start — an abandoned dialog, a
          // failed retry, or a client that skipped it. Refuse rather than
          // guess; there is no legitimate path where this should proceed.
          //
          // Folding board-issue into this same request would close the gap
          // structurally and remove the two-request window entirely — but
          // this route is what the whole plant uses to start every stage of
          // every job, and reshaping its transaction boundary to serve one
          // feature is a bigger blast radius than the bug warrants. A loud
          // refusal buys the same safety without that risk. This two-request
          // shape is a considered trade-off, not an oversight.
          const plan = jc.order_line_id ? await mixFor(jc.order_line_id, 'plan', qc) : [];
          if (plan.length) throw Object.assign(
            new Error('This job has a board mix that was never confirmed — reopen the start dialog to confirm the board issue'),
            { status: 409 });
          await consumeFifo(eff.board_material_id, jc.sheets_issued, 'job_card', jc.id, `Issue to ${jc.jc_number}`, qc, oc);
        }
      } else if (prev.status === 'completed') {
        const ups = (await oc('SELECT ups FROM products WHERE id=$1', [jc.product_id])).ups;
        qtyIn = prev.unit === 'sheets' && st.unit === 'cartons' ? prev.qty_out * ups : prev.qty_out;
      } else {
        // Started ahead of an unfinished upstream stage (inline production). The
        // received quantity is unknown until that stage finishes, so it is left
        // blank now and resolved from the previous stage's output at completion.
        qtyIn = null;
      }

      let machineId = req.body.machine_id ?? null;
      if (machineId) {
        const m = await oc('SELECT * FROM machines WHERE id=$1', [machineId]);
        if (!m || m.type !== st.stage) machineId = null; // only accept a machine of this section
      }
      // Printing inherits the press assigned in Print Planning by default, so
      // machine utilisation is attributed even without re-picking the machine.
      if (!machineId && st.stage === 'printing' && jc.machine_id) machineId = jc.machine_id;
      // Starting on another press is allowed — a press breaks down, the load
      // shifts — but Print Planning still shows the old one, so say so on the
      // timeline rather than letting the board and the floor drift apart.
      if (pressOverride(st.stage, jc.machine_id, machineId)) {
        const planned = await oc('SELECT name FROM machines WHERE id=$1', [jc.machine_id]);
        const actual = await oc('SELECT name FROM machines WHERE id=$1', [machineId]);
        await audit('job_stage', st.id, 'press_override',
          `Started on ${actual?.name || machineId} — Print Planning assigned ${planned?.name || jc.machine_id}`,
          qc, req.user.name);
      }
      // Operator preference: explicit pick → the press operator already on the
      // stage (set by Print Planning) → the signed-in user.
      await qc(`UPDATE job_stages SET status='in_progress', qty_in=$1, operator=$2, machine_id=$3, line_clearance=$4, started_at=now() WHERE id=$5`,
        [qtyIn, req.body.operator || st.operator || req.user.name, machineId, clearance, st.id]);
      if (jc.status === 'open') await qc(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [jc.id]);
      if (clearance) {
        const c = JSON.parse(clearance);
        await audit('job_stage', st.id, 'line_clearance', `${st.stage} — ${c.items.length} points confirmed by ${c.by}`, qc, req.user.name);
      }
      await audit('job_stage', st.id, 'start', `${st.stage} qty_in=${qtyIn}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Print planning (kanban) ────────────────────────────────────────────────
// Soft strength mix-up alarm. Scans the WHOLE active print plan (triage + every
// press, any date — per the owner's choice) for a same-customer / same-brand /
// different-strength sibling of the card being planned. The moving card's own
// gang is excluded — it is one physical run, planned as a unit. Returns the
// collision payload for a structured 409, or null when the board is clean.
async function strengthClash(qc, jc) {
  const rows = await qc(`
    SELECT jc.id, jc.jc_number, jc.machine_id,
           COALESCE(ol.gang_run_id, jc.gang_run_id) AS gang_run_id,
           p.id AS product_id, p.name AS name, p.customer_id,
           ol.planned_date, m.name AS machine_name
    FROM job_cards jc
    JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing' AND js.status != 'completed'
    JOIN products p ON p.id = jc.product_id
    LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
    LEFT JOIN machines m ON m.id = jc.machine_id
    WHERE jc.status IN ('open','in_progress')`);
  const target = rows.find((r) => r.id === jc.id);
  if (!target) return null;
  const gang = jc.gang_run_id || target.gang_run_id;
  const pool = rows.filter((r) => r.id !== jc.id && !(gang && r.gang_run_id === gang));
  const hits = findClashes(target, pool);
  if (!hits.length) return null;
  return {
    this: { product_name: target.name, strength: familyKey(target.name).strength, jc_number: target.jc_number },
    others: hits.map((h) => ({
      product_name: h.name,
      strength: familyKey(h.name).strength,
      jc_number: h.jc_number,
      location: h.machine_name || 'Triage',
      planned_date: h.planned_date,
    })),
  };
}

// Core of a print-planning move — shared by the drag-assign route and the
// consolidated queue-edit route. Carries a whole gang to the press (or back to
// triage), hands the run to that press's crew (its first active operator), and
// re-sequences the destination lane top-to-bottom. Runs inside a caller tx.
async function assignPressTx(qc, oc, { job_card_id, machine_id, ordered_ids, user, confirm_collision }) {
  const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [job_card_id]);
  if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
  const printing = await oc(`SELECT status FROM job_stages WHERE job_card_id=$1 AND stage='printing'`, [job_card_id]);
  if (printing?.status === 'completed')
    throw Object.assign(new Error('Printing already completed for this job'), { status: 409 });
  let collision = null;
  if (machine_id) {
    const m = await oc('SELECT * FROM machines WHERE id=$1', [machine_id]);
    if (!m || m.type !== 'printing') throw Object.assign(new Error('Not a printing machine'), { status: 400 });
    // Soft mix-up alarm — surfaces the clash, never blocks. Ask ONCE, then stay
    // quiet: skip on a same-press reorder (the press isn't changing), and skip
    // if this card's clash was already acknowledged (a prior ack in the audit
    // trail). "Yes" re-submits with confirm_collision; the ack is audited below.
    if (machine_id !== jc.machine_id) {
      collision = await strengthClash(qc, jc);
      if (collision && !confirm_collision) {
        const acked = await oc(`SELECT 1 FROM audit_log
          WHERE entity='job_card' AND entity_id=$1 AND action='strength_collision_ack' LIMIT 1`, [job_card_id]);
        if (!acked) {
          const e = new Error('Strength mix-up check');
          e.status = 409;
          e.body = { code: 'PRODUCT_STRENGTH_COLLISION', collision };
          throw e;
        }
      }
    }
  }
  const gangJcIds = jc.gang_run_id
    ? (await qc(`
        SELECT jc2.id, jc2.order_line_id FROM job_cards jc2
        JOIN job_stages js2 ON js2.job_card_id = jc2.id AND js2.stage='printing'
        WHERE jc2.gang_run_id=$1 AND jc2.status IN ('open','in_progress') AND js2.status != 'completed'`,
        [jc.gang_run_id]))
    : [{ id: jc.id, order_line_id: jc.order_line_id }];
  const crew = machine_id
    ? await oc(`
        SELECT e.name FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=$1 AND e.active=1 ORDER BY e.name LIMIT 1`, [machine_id])
    : null;
  for (const g of gangJcIds) {
    await qc('UPDATE job_cards SET machine_id=$1 WHERE id=$2', [machine_id || null, g.id]);
    if (g.order_line_id) await qc('UPDATE order_lines SET machine_id=$1 WHERE id=$2', [machine_id || null, g.order_line_id]);
    else await qc('UPDATE order_lines SET machine_id=$1 WHERE gang_run_id=$2', [machine_id || null, jc.gang_run_id]);
    await qc(`UPDATE job_stages SET machine_id=$1, operator=$2
              WHERE job_card_id=$3 AND stage='printing' AND status != 'completed'`,
      [machine_id || null, crew?.name || null, g.id]);
  }
  // Re-sequence the DESTINATION lane only. ordered_ids can go stale between
  // being computed and arriving here (bulk sends share one list, the undo bar
  // replays a 10-second-old snapshot, a clash confirm re-posts a pre-move
  // order) — so a position is written only if the card actually sits in the
  // target lane right now. A stale id belonging to another lane keeps that
  // lane's ordering untouched instead of inheriting a foreign position.
  for (let i = 0; i < (ordered_ids || []).length; i++) {
    await qc('UPDATE job_cards SET queue_pos=$1 WHERE id=$2 AND machine_id IS NOT DISTINCT FROM $3',
      [i + 1, ordered_ids[i], machine_id || null]);
  }
  if (!ordered_ids?.length) await qc('UPDATE job_cards SET queue_pos=NULL WHERE id=$1', [job_card_id]);
  await audit('job_card', job_card_id, 'print_plan',
    machine_id ? `assigned press ${machine_id}` : 'moved to triage', qc, user);
  if (collision && confirm_collision) {
    const names = collision.others.map((o) => `${o.product_name} (${o.strength})`).join(', ');
    await audit('job_card', job_card_id, 'strength_collision_ack',
      `Planned ${collision.this.product_name} (${collision.this.strength}) despite strength clash with ${names}`, qc, user);
  }
  return jc;
}

// Job cards whose printing stage is still open, grouped by press.
r.get('/print-planning', async (_req, res, next) => {
  try {
    const cards = await q(`
      SELECT jc.id, jc.jc_number,
             -- The plant's output number (a.k.a. plate / positive no.) lives on
             -- the PRODUCT MASTER — Planning, Artwork and the master form edit
             -- it. The board only ever displays it; blank stays blank.
             NULLIF(p.output_number, '') AS output_no,
             jc.machine_id, jc.queue_pos, jc.sheets_issued, jc.qty_planned,
             jc.children_per_parent, jc.finalised_at,
             jc.ready_override, jc.ready_override_by, jc.ready_override_at, jc.ready_override_reason,
             js.status AS printing_status, js.operator AS printing_operator,
             js.id AS printing_stage_id, js.qty_out AS printed_so_far,
             js.qty_scrap AS print_waste_so_far, js.qty_in AS print_qty_in,
             js.started_at AS printing_started_at, js.hold_reason,
             p.id AS product_id, p.special, p.tool_id,
             -- Anchor line: the card's own order line, or the gang's lead
             -- member for a parent card — the row readiness() takes.
             COALESCE(ol.id, gol.id) AS anchor_line_id,
             COALESCE(ol.tooling_ok, gol.tooling_ok) AS tooling_ok_override,
             p.name AS product_name, p.code AS product_code, p.colors, p.coating,
             -- Override-first, the same rule the job-card query above uses, so
             -- the board never shows a stale master code for a line that
             -- overrode its artwork.
             COALESCE(COALESCE(ol.spec_override, gol.spec_override)->>'party_artwork_code',
                      p.party_artwork_code) AS party_artwork_code,
             -- Board on the card face: the product's explicit board name, or the
             -- effective board material's name (spec_override wins, same rule as
             -- the stock lateral below and the job-card traveler).
             COALESCE(NULLIF(p.board_name, ''), bm.name) AS board_display, p.gsm,
             c.name AS customer_name, o.po_number, o.po_date, o.delivery_date,
             COALESCE(ol.planned_date, gol.planned_date) AS planned_date,
             COALESCE(ol.gang_run_id, jc.gang_run_id) AS gang_run_id, gg.gang_number,
             (NOT EXISTS (SELECT 1 FROM stock_movements sm
                          WHERE sm.ref_type='job_card' AND sm.ref_id=jc.id AND sm.type='consumption')
              AND stk.avail < jc.sheets_issued) AS board_pending
      FROM job_cards jc
      JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id=jc.gang_run_id
        ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs gg ON gg.id = COALESCE(ol.gang_run_id, jc.gang_run_id)
      LEFT JOIN materials bm
        ON bm.id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sb.qty),0) AS avail FROM stock_batches sb
        WHERE sb.material_id = COALESCE((COALESCE(ol.spec_override, gol.spec_override)->>'board_material_id')::int, p.board_material_id)
          AND sb.status='available'
      ) stk ON true
      WHERE jc.status IN ('open','in_progress') AND js.status != 'completed'
      ORDER BY jc.queue_pos NULLS LAST, o.delivery_date NULLS LAST, jc.id`);

    // The traffic light every card wears. It runs over readiness()'s gates —
    // the SAME facts the job-card release gate uses — so the dot can never
    // disagree with what the ERP will actually allow. readinessBatch resolves
    // the six lookups for the whole board in a fixed set of queries and
    // lightForJobCards the two facts a card never carries (its cutting stage
    // and its shade verdict); a press day is a hundred cards, and a query per
    // card would put the board's latency on a remote DB in the seconds.
    const anchorIds = [...new Set(cards.map(c => c.anchor_line_id).filter(x => x != null))];
    const anchors = anchorIds.length
      ? await q('SELECT * FROM order_lines WHERE id = ANY($1)', [anchorIds])
      : [];
    const anchorById = new Map(anchors.map(l => [l.id, l]));
    const rctx = await readinessBatch(anchors);
    const lightExtras = await lightForJobCards(cards, one);
    for (const cRow of cards) {
      const line = anchorById.get(cRow.anchor_line_id);
      if (!line) continue;
      cRow.light = readinessLight({
        // Served entirely from rctx — no round trip per card.
        gates: await readiness(line, one, rctx),
        ...lightExtras.get(cRow.id),
        machineId: cRow.machine_id,
        finalisedAt: cRow.finalised_at,
        toolingOk: cRow.tooling_ok_override,
        override: {
          on: !!cRow.ready_override, by: cRow.ready_override_by,
          at: cRow.ready_override_at, reason: cRow.ready_override_reason,
        },
      });
    }

    // Tooling readiness per card — same gate the job-card release uses
    // (tooling-gate.js): hard die + soft plate/block, with the planner's manual
    // tooling_ok override absolute. One tools query covers every card.
    const prodIds = [...new Set(cards.map(c => c.product_id))];
    const allTools = prodIds.length
      ? await q(`SELECT * FROM tools WHERE product_id = ANY($1)
                  OR id IN (SELECT tool_id FROM products WHERE id = ANY($1) AND tool_id IS NOT NULL)`, [prodIds])
      : [];
    for (const cRow of cards) {
      const mine = allTools.filter(t => t.product_id === cRow.product_id || t.id === cRow.tool_id);
      const detail = toolingDetail({ id: cRow.product_id, special: cRow.special, tool_id: cRow.tool_id }, mine);
      cRow.tooling_ready = toolingGateOk(detail, cRow.tooling_ok_override);
      delete cRow.tooling_ok_override;
    }

    // Active presses only, each carrying its assigned crew — the lane header
    // shows "CI-1 · Komori Lithrone 5-Colour · Shiv Kumar".
    const presses = await q(`
      SELECT m.*, COALESCE(ops.operators, '[]'::json) AS operators
      FROM machines m
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name) AS operators
        FROM machine_operators mo JOIN employees e ON e.id=mo.employee_id
        WHERE mo.machine_id=m.id AND e.active=1) ops ON true
      WHERE m.type='printing' AND COALESCE(m.active,1)=1 ORDER BY m.name`);
    // Printed runs — printing stage completed within the last 60 days. Grouped
    // per press on the client (by the press it actually printed on). Feeds both
    // the board's end-of-day green cards and the Completed tab.
    const completed = await q(`
      SELECT jc.id, jc.jc_number, NULLIF(p.output_number, '') AS output_no,
             jc.order_line_id, jc.sheets_issued, jc.qty_planned,
             jc.children_per_parent,
             COALESCE(js.machine_id, jc.machine_id) AS machine_id,
             js.status AS printing_status, js.operator AS printing_operator,
             js.id AS printing_stage_id, js.qty_scrap AS print_waste_so_far,
             js.qty_in AS print_qty_in, js.started_at AS printing_started_at,
             js.qty_out AS printed_sheets, js.completed_at,
             p.name AS product_name, p.code AS product_code, p.colors, p.coating,
             c.name AS customer_name, o.po_number, o.delivery_date,
             COALESCE(ol.gang_run_id, jc.gang_run_id) AS gang_run_id, gg.gang_number
      FROM job_cards jc
      JOIN job_stages js ON js.job_card_id = jc.id AND js.stage='printing'
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN LATERAL (
        SELECT ol2.* FROM order_lines ol2
        WHERE ol2.gang_run_id=jc.gang_run_id ORDER BY ol2.id LIMIT 1
      ) gol ON jc.order_line_id IS NULL
      LEFT JOIN orders o ON o.id = COALESCE(ol.order_id, gol.order_id)
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN gang_runs gg ON gg.id = COALESCE(ol.gang_run_id, jc.gang_run_id)
      WHERE js.status='completed' AND js.completed_at > now() - interval '60 days'
      ORDER BY COALESCE(js.machine_id, jc.machine_id) NULLS LAST, js.completed_at DESC, jc.id`);
    res.json({ cards, presses, completed });
  } catch (e) { next(e); }
});

// Persist a drag: which press lane, and the full order of that lane.
r.post('/print-planning/assign', canPlan, async (req, res, next) => {
  try {
    const { job_card_id, machine_id, ordered_ids, confirm_collision } = req.body;
    await tx(async (qc, oc) => {
      await assignPressTx(qc, oc, { job_card_id, machine_id, ordered_ids, user: req.user.name, confirm_collision });
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Reverse a printed run: un-complete the printing stage and send the card back
// to Triage, ready to edit. Gang-aware — the whole gang reverses together.
// Guarded by printReverseBlockers (downstream stages must be untouched).
r.post('/print-planning/reverse', canPlan, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reverse a printed run' });
    await tx(async (qc, oc) => {
      const st = await oc(`
        SELECT js.*, jc.status AS jc_status, jc.gang_run_id, jc.product_id, jc.jc_number
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE js.job_card_id=$1 AND js.stage='printing' FOR UPDATE OF js`, [req.body.job_card_id]);
      if (!st) throw Object.assign(new Error('Printing stage not found'), { status: 404 });

      const downstream = await qc(`
        SELECT stage, status FROM job_stages
        WHERE job_card_id=$1 AND seq>$2 AND status != 'pending'`, [st.job_card_id, st.seq]);
      const blockers = printReverseBlockers({
        printingStatus: st.status, jcStatus: st.jc_status, downstreamStages: downstream,
      });
      if (blockers.length) { const e = new Error(blockers[0]); e.status = 409; e.blockers = blockers; throw e; }

      // Whole gang reverses together — same member resolution as assign.
      const members = st.gang_run_id
        ? (await qc(`
            SELECT jc2.id, jc2.order_line_id, jc2.product_id, js2.id AS stage_id, js2.qty_scrap
            FROM job_cards jc2
            JOIN job_stages js2 ON js2.job_card_id=jc2.id AND js2.stage='printing'
            WHERE jc2.gang_run_id=$1 AND js2.status='completed'`, [st.gang_run_id]))
        : [{ id: st.job_card_id, order_line_id: null, product_id: st.product_id, stage_id: st.id, qty_scrap: st.qty_scrap }];

      for (const m of members) {
        // Mirror the generic stage-reverse stock hygiene: return spoiled sheets.
        if ((m.qty_scrap || 0) > 0) {
          await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                    VALUES ($1,'wastage_reversal',$2,'job_stage',$3,$4)`,
            [m.product_id, m.qty_scrap, m.stage_id, `printing reversed — ${reason}`]);
        }
        await qc(`UPDATE job_stages SET status='pending', qty_out=NULL, qty_scrap=0,
                  scrap_reason=NULL, completed_at=NULL, operator=NULL, machine_id=NULL
                  WHERE job_card_id=$1 AND stage='printing'`, [m.id]);
        await qc('UPDATE job_cards SET machine_id=NULL, queue_pos=NULL WHERE id=$1', [m.id]);
        const olId = m.order_line_id ?? (await oc('SELECT order_line_id FROM job_cards WHERE id=$1', [m.id]))?.order_line_id;
        if (olId) await qc('UPDATE order_lines SET machine_id=NULL WHERE id=$1', [olId]);
        await audit('job_card', m.id, 'print_reverse', `Printed run reversed to Triage — ${reason}`, qc, req.user.name);
      }
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Consolidated queue-entry edit — quantity/sheets (job_cards), operator
// (printing stage), planned_date (order line), delivery_date (whole order), and
// press + queue order (via assignPressTx). Only while printing has not started.
// Pass machine_id + ordered_ids together when changing the press so the new
// lane order is set; omit both to leave placement untouched.
r.put('/print-planning/:jobCardId', canPlan, async (req, res, next) => {
  try {
    const id = +req.params.jobCardId;
    const { qty_planned, sheets_issued, operator, planned_date, delivery_date, machine_id, ordered_ids, confirm_collision } = req.body;
    await tx(async (qc, oc) => {
      const jc = await oc(`
        SELECT jc.*, js.status AS printing_status
        FROM job_cards jc
        LEFT JOIN job_stages js ON js.job_card_id=jc.id AND js.stage='printing'
        WHERE jc.id=$1 FOR UPDATE OF jc`, [id]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const block = printQueueEditBlock({
        printingStatus: jc.printing_status, jcStatus: jc.status, finalised: !!jc.finalised_at,
      });
      if (block) throw Object.assign(new Error(block), { status: 409 });

      if (qty_planned !== undefined) {
        const n = Number(qty_planned);
        if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error('Planned quantity must be greater than zero'), { status: 400 });
        await qc('UPDATE job_cards SET qty_planned=$1 WHERE id=$2', [Math.round(n), id]);
      }
      if (sheets_issued !== undefined) {
        const n = Number(sheets_issued);
        if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Issued sheets cannot be negative'), { status: 400 });
        await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [Math.round(n), id]);
      }
      if (operator !== undefined)
        await qc(`UPDATE job_stages SET operator=$1 WHERE job_card_id=$2 AND stage='printing'`, [operator || null, id]);
      if (planned_date !== undefined && jc.order_line_id)
        await qc('UPDATE order_lines SET planned_date=$1 WHERE id=$2', [planned_date || null, jc.order_line_id]);
      if (delivery_date !== undefined && jc.order_line_id) {
        const ol = await oc('SELECT order_id FROM order_lines WHERE id=$1', [jc.order_line_id]);
        if (ol?.order_id) await qc('UPDATE orders SET delivery_date=$1 WHERE id=$2', [delivery_date || null, ol.order_id]);
      }
      if (machine_id !== undefined || ordered_ids !== undefined)
        await assignPressTx(qc, oc, {
          job_card_id: id, machine_id: machine_id === undefined ? jc.machine_id : machine_id,
          ordered_ids: ordered_ids || [], user: req.user.name, confirm_collision,
        });
      await audit('job_card', id, 'print_queue_edited', 'Print queue entry edited', qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Day-wise production runs ────────────────────────────────────────────────
// A station records output over several days instead of one shot (e.g. 1 lakh
// pasted per day on a 5-lakh order). Each run is capped by what the previous
// stage has cumulatively produced so far (see upstreamAvailable / runCapacity).
r.get('/job-stages/:id/runs', canRun, async (req, res, next) => {
  try {
    const runs = await q(
      `SELECT sr.*, m.name AS machine_name
         FROM stage_runs sr LEFT JOIN machines m ON m.id = sr.machine_id
        WHERE sr.job_stage_id = $1 ORDER BY sr.run_date, sr.seq`, [req.params.id]);
    res.json({ runs, rollup: rollupRuns(runs) });
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/runs', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('This stage is already completed — reverse it to record more output'), { status: 409 });
      if (st.status === 'pending')
        throw Object.assign(new Error('Start the stage before recording output'), { status: 409 });

      const qty_good = Math.max(0, Math.round(+req.body.qty_good || 0));
      const qty_scrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
      if (qty_good + qty_scrap <= 0)
        throw Object.assign(new Error('A run must record some output or scrap'), { status: 400 });
      if (qty_scrap > 0 && !(req.body.scrap_reason || '').trim())
        throw Object.assign(new Error('A reason is required when scrap is recorded'), { status: 400 });

      const prior = rollupRuns(await qc(
        'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [st.id]));
      const cap = runCapacity({
        upstreamAvailable: await upstreamAvailable(oc, st.id),
        priorGood: prior.qty_good, priorScrap: prior.qty_scrap,
        thisGood: qty_good, thisScrap: qty_scrap,
      });
      if (!cap.ok)
        throw Object.assign(
          new Error(`Output + scrap (${cap.consumed}) exceeds what the previous stage has produced (${cap.ceiling}) by ${cap.overBy}`),
          { status: 409 });

      const seq = (prior.run_count || 0) + 1;
      const rows = await qc(
        `INSERT INTO stage_runs (job_stage_id, seq, run_date, shift, qty_good, qty_scrap,
                                 scrap_reason, machine_id, operator, note, created_by)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [st.id, seq, req.body.run_date || null, req.body.shift || null, qty_good, qty_scrap,
         qty_scrap > 0 ? req.body.scrap_reason : null,
         req.body.machine_id ? +req.body.machine_id : st.machine_id,
         req.body.operator || st.operator || req.user?.name || null,
         req.body.note || null, req.user?.name || null]);

      const rollup = await recalcStageFromRuns(qc, oc, st.id);
      if (st.status === 'in_progress')
        await qc(`UPDATE job_stages SET status='partially_completed' WHERE id=$1`, [st.id]);
      await audit('job_stage', st.id, 'run_add',
        `${st.stage}: +${qty_good} good${qty_scrap ? ` / +${qty_scrap} scrap` : ''} (run #${seq})`, qc, req.user.name);
      return { run: rows[0], rollup };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.put('/job-stages/:id/runs/:runId', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('Reverse the stage before editing its runs'), { status: 409 });
      const qty_good = Math.max(0, Math.round(+req.body.qty_good || 0));
      const qty_scrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
      if (qty_scrap > 0 && !(req.body.scrap_reason || '').trim())
        throw Object.assign(new Error('A reason is required when scrap is recorded'), { status: 400 });
      await qc(
        `UPDATE stage_runs SET qty_good=$1, qty_scrap=$2, scrap_reason=$3, run_date=COALESCE($4::date, run_date),
                shift=$5, machine_id=$6, operator=$7, note=$8
          WHERE id=$9 AND job_stage_id=$10`,
        [qty_good, qty_scrap, qty_scrap > 0 ? req.body.scrap_reason : null,
         req.body.run_date || null, req.body.shift || null,
         req.body.machine_id ? +req.body.machine_id : null,
         req.body.operator || null, req.body.note || null,
         req.params.runId, st.id]);
      const rollup = await recalcStageFromRuns(qc, oc, st.id);
      await audit('job_stage', st.id, 'run_edit', `${st.stage}: run #${req.params.runId} edited`, qc, req.user.name);
      return { rollup };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.delete('/job-stages/:id/runs/:runId', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('Reverse the stage before deleting its runs'), { status: 409 });
      await qc('DELETE FROM stage_runs WHERE id=$1 AND job_stage_id=$2', [req.params.runId, st.id]);
      const rollup = await recalcStageFromRuns(qc, oc, st.id);
      if (!rollup) await qc(`UPDATE job_stages SET status='in_progress', qty_out=NULL, qty_scrap=0 WHERE id=$1`, [st.id]);
      await audit('job_stage', st.id, 'run_delete', `${st.stage}: run #${req.params.runId} deleted`, qc, req.user.name);
      return { rollup };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Hold / resume a running stage — machine breakdown, shade issue, etc.
// Hold/resume accept planners too — the Print Planning board offers Hold on a
// running press card, and pausing a queue is planning work as much as floor work.
const canHold = requireRole('production', 'planner');
r.post('/job-stages/:id/hold', canHold, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (!['in_progress', 'partially_completed'].includes(st.status))
        throw Object.assign(new Error('Only a running stage can be put on hold'), { status: 409 });
      await qc(`UPDATE job_stages SET status='hold', hold_reason=$1 WHERE id=$2`, [req.body.reason || null, st.id]);
      // `operator` is who was AT the machine — on a shared floor device that is
      // the man named in the station's operator picker, which is not the same
      // fact as req.user.name (the login the whole shift shares). Both are
      // recorded: the detail says who stopped the press, the audit row's
      // user_name still says which account was signed in.
      const heldBy = (req.body.operator || '').trim();
      await audit('job_stage', st.id, 'hold',
        `${st.stage}${req.body.reason ? ` — ${req.body.reason}` : ''}${heldBy ? ` (by ${heldBy})` : ''}`,
        qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/resume', canHold, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'hold') throw Object.assign(new Error('Stage is not on hold'), { status: 409 });
      // Resume to the state the stage was actually in: a stage with day-wise
      // runs recorded goes back to partially_completed, not in_progress.
      await qc(`UPDATE job_stages SET status = CASE
                  WHEN EXISTS (SELECT 1 FROM stage_runs WHERE job_stage_id=$1)
                  THEN 'partially_completed' ELSE 'in_progress' END,
                hold_reason=NULL WHERE id=$1`, [st.id]);
      await audit('job_stage', st.id, 'resume', st.stage, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// Complete a stage. Final stage closes the job card + FG receipt + line status.
r.post('/job-stages/:id/complete', canRun, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      // 'partially_completed' is a stage with day-wise runs already recorded —
      // completing it writes the balancing final run (see below) and is just as
      // valid a close as a one-shot 'in_progress' completion.
      if (!['in_progress', 'partially_completed'].includes(st.status))
        throw Object.assign(new Error('Stage is not running'), { status: 409 });

      // Stations are independent: a stage may close against whatever the
      // previous stage has COUNTED so far — final or partial. The running-
      // balance cap below is the real control (output + scrap can never exceed
      // what upstream has produced). The only hard block left is an upstream
      // that has counted nothing at all, because then there is nothing to
      // receive and no basis for this stage's quantity.
      const receipt = await stageReceipt(oc, st.id);
      const prev = receipt.prev;
      if (prev && prev.status !== 'completed' && (prev.qty_out == null || prev.qty_out <= 0))
        throw Object.assign(new Error(
          `"${prev.stage.replace('_', ' ')}" hasn't recorded any output yet — record a count there first`), { status: 409 });

      // Stamp the receipt onto the row. Until now it was live — the previous
      // stage kept counting and this stage's received quantity followed it.
      // Closing freezes that same figure (upstream's counted-so-far, converted
      // into this stage's unit, plus any CI-XS extras issued here) so the
      // completed run keeps the input it actually closed against.
      let stQtyIn = st.qty_in;
      if (prev || stQtyIn == null) {
        stQtyIn = receipt.live;
        await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [stQtyIn, st.id]);
      }

      const isQC = st.stage === 'qc';
      // QC captures Accepted / Rejected / Rework; other stages capture Good / Wastage.
      // For QC, good output = accepted (only accepted moves to Finished Goods).
      const qty_accepted = isQC ? +(req.body.qty_accepted ?? req.body.qty_out) : null;
      const qty_rejected = isQC ? +(req.body.qty_rejected || 0) : null;
      const qty_rework = isQC ? +(req.body.qty_rework || 0) : null;
      const qty_out = isQC ? qty_accepted : +req.body.qty_out;
      const qty_scrap = isQC ? qty_rejected : +(req.body.qty_scrap || 0);
      if (!qty_out && qty_out !== 0) throw Object.assign(new Error(isQC ? 'Accepted quantity is required' : 'Output quantity is required'), { status: 400 });

      // Inspector checkpoint (Phase 2): passing QC requires a named inspector and
      // a remark, stamped and audited — the one-step approval gate. Any accepted
      // quantity credits Finished Goods immediately once these are provided.
      if (isQC) {
        if (!(req.body.inspector || '').trim())
          throw Object.assign(new Error('Inspector name is required to pass QC'), { status: 400 });
        if (!(req.body.remarks || '').trim())
          throw Object.assign(new Error('An inspection remark is required to pass QC'), { status: 400 });
      }

      // Cutting has NO hard cap — a sealed packet may be intact and the operator
      // is bound to cut the full bundle. He types child print-sheets; we derive
      // the parents actually cut and true-up the warehouse (below). Every other
      // stage keeps the cap and routes overages through the extra-sheet flow.
      let cutVariance = null;
      if (st.stage === 'cutting') {
        const jcRow0 = await oc('SELECT children_per_parent, sheets_issued FROM job_cards WHERE id=$1', [st.job_card_id]);
        cutVariance = cuttingVariance({
          qty_out, qty_scrap,
          children_per_parent: jcRow0?.children_per_parent,
          sheets_issued: jcRow0?.sheets_issued,
        });
        if (cutVariance.isVariance && !(req.body.variance_reason || '').trim())
          throw Object.assign(new Error('A reason is required when cutting differs from the job card'), { status: 400 });
      } else if (isQC) {
        const consumed = qty_accepted + qty_rejected + qty_rework;
        if (consumed > stQtyIn)
          throw Object.assign(new Error(`Accepted + rejected + rework (${consumed}) exceeds input (${stQtyIn})`), { status: 409 });
      } else {
        // Running balance: a stage can only consume what the previous stage has
        // cumulatively produced. qty_out/qty_scrap here are the FINAL totals for
        // the stage, not a delta, so prior runs are not added again.
        const cap = runCapacity({
          upstreamAvailable: await upstreamAvailable(oc, st.id),
          priorGood: 0, priorScrap: 0, thisGood: qty_out, thisScrap: qty_scrap,
        });
        if (!cap.ok)
          throw Object.assign(new Error(`Output + scrap (${cap.consumed}) exceeds available input (${cap.ceiling})`), { status: 409 });
      }

      const scrap_reason = qty_scrap > 0 ? (req.body.scrap_reason || null) : null;

      // Packing manifest — multi-line factory packing on the pasting station:
      // N full boxes of X each, part boxes, loose pieces. Every job passes
      // through pasting (it is also the packing station), so packing is always
      // recorded here. Each line is stored; the summary lands on the stage for
      // quick reads (back-compatible).
      let pack_boxes = st.stage === 'pasting' && req.body.pack_boxes ? +req.body.pack_boxes : null;
      let pack_qty_per_box = st.stage === 'pasting' && req.body.pack_qty_per_box ? +req.body.pack_qty_per_box : null;
      const packingLines = st.stage === 'pasting' && Array.isArray(req.body.packing_lines)
        ? req.body.packing_lines
            .map(pl => ({
              boxes: Math.max(0, Math.round(+pl.boxes || 0)),
              qty_per_box: Math.max(0, Math.round(+pl.qty_per_box || 0)),
              loose_qty: Math.max(0, Math.round(+pl.loose_qty || 0)),
            }))
            .map(pl => ({ ...pl, total: pl.boxes * pl.qty_per_box + pl.loose_qty }))
            .filter(pl => pl.total > 0)
        : null;
      if (packingLines?.length) {
        for (const pl of packingLines) {
          await qc(`INSERT INTO packing_lines (job_stage_id, boxes, qty_per_box, loose_qty, total)
                    VALUES ($1,$2,$3,$4,$5)`, [st.id, pl.boxes, pl.qty_per_box, pl.loose_qty, pl.total]);
        }
        pack_boxes = packingLines.reduce((s, pl) => s + pl.boxes + (pl.loose_qty > 0 ? 1 : 0), 0);
        const boxLines = packingLines.filter(pl => pl.boxes > 0);
        pack_qty_per_box = boxLines.length === 1 ? boxLines[0].qty_per_box : null;
        const packedTotal = packingLines.reduce((s, pl) => s + pl.total, 0);
        await audit('job_stage', st.id, 'packing_manifest',
          `${packingLines.length} lines — ${packedTotal} pcs in ${pack_boxes} boxes`, qc, req.user.name);
      }
      // Keep stage_runs authoritative. A one-shot completion writes one run; a
      // stage that already has partial runs gets a balancing run for the
      // remainder. QC included: its runs record accepted (good) / rejected
      // (scrap) day by day, and the final inspection reconciles the same way.
      {
        const prior = rollupRuns(await qc(
          'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [st.id]));
        const deltaGood = qty_out - prior.qty_good;
        const deltaScrap = qty_scrap - prior.qty_scrap;
        if (deltaGood !== 0 || deltaScrap !== 0) {
          if (deltaGood < 0 || deltaScrap < 0)
            throw Object.assign(new Error(
              `Closing totals (${qty_out} good / ${qty_scrap} scrap) are below what the run log already records (${prior.qty_good} / ${prior.qty_scrap}). Edit or delete a run instead.`
            ), { status: 409 });
          await qc(
            `INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                                     scrap_reason, machine_id, operator, note, created_by)
             VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9)`,
            [st.id, (prior.run_count || 0) + 1, deltaGood, deltaScrap,
             deltaScrap > 0 ? scrap_reason : null, st.machine_id,
             req.body.operator || st.operator || req.user?.name || null,
             prior.run_count ? 'closing balance' : null, req.user?.name || null]);
        }
      }
      await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, scrap_reason=$3,
                qty_accepted=$4, qty_rejected=$5, qty_rework=$6, inspector=$7, remarks=$8,
                inspected_at=$9, pack_boxes=$10, pack_qty_per_box=$11, completed_at=now() WHERE id=$12`,
        [qty_out, qty_scrap, scrap_reason, qty_accepted, qty_rejected, qty_rework,
         isQC ? req.body.inspector.trim() : null, req.body.remarks || null,
         isQC ? new Date().toISOString() : null, pack_boxes, pack_qty_per_box, st.id]);
      await audit('job_stage', st.id, isQC ? 'qc' : 'complete',
        isQC ? `QC by ${req.body.inspector.trim()} — accepted=${qty_accepted} rejected=${qty_rejected} rework=${qty_rework}${req.body.remarks ? ` · ${req.body.remarks.trim()}` : ''}${scrap_reason ? ` (${scrap_reason})` : ''}`
             : `${st.stage} out=${qty_out} scrap=${qty_scrap}${scrap_reason ? ` (${scrap_reason})` : ''}`, qc, req.user.name);

      // Auto-return: any shade card issued against THIS job card and still on
      // the press returns to the Vault, Verified, when the printing stage ends.
      // (Shade Card Management module — the dock loop lives on shade_cards now.)
      if (st.stage === 'printing') {
        // Custody lives in shade_card_issues now — the open row IS the holder.
        // This used to write dock_zone, which still exists as a column but is
        // deprecated and read by nothing, so the auto-return silently stopped
        // working: a card issued to printing was never handed back.
        const returned = await qc(`
          UPDATE shade_card_issues SET returned_at=now(), returned_by=$2,
                 received_by=$2, condition='good',
                 remarks=COALESCE(remarks, 'Auto-returned when printing completed')
          WHERE job_card_id=$1 AND returned_at IS NULL
          RETURNING id, shade_card_id, issued_to`, [st.job_card_id, req.user.name]);
        for (const row of returned) {
          await qc(`INSERT INTO shade_card_events (shade_card_id, action, note, user_name)
                    VALUES ($1,'returned',$2,$3)`,
            [row.shade_card_id, `auto-returned from ${row.issued_to} — printing complete`, req.user.name]);
          await qc('UPDATE shade_cards SET updated_at=now() WHERE id=$1', [row.shade_card_id]);
          await audit('shade_card', row.shade_card_id, 'returned',
            'Auto-returned when printing completed', qc, req.user.name);
        }
      }

      // ── Cutting variance: real-time warehouse true-up + register row ────────
      // Board was consumed at START for the planned sheets_issued. Here we
      // consume/refund the delta between planned and the parents actually cut,
      // rewrite sheets_issued / qty_in to the truth, and record the variance.
      if (cutVariance && cutVariance.isVariance) {
        const jcNo = (await oc('SELECT jc_number FROM job_cards WHERE id=$1', [st.job_card_id]))?.jc_number || `JC#${st.job_card_id}`;
        const eff = await oc(`
          SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM job_cards jc
          JOIN order_lines ol ON ol.id = COALESCE(jc.order_line_id,
                (SELECT id FROM order_lines WHERE gang_run_id = jc.gang_run_id ORDER BY id LIMIT 1))
          JOIN products p ON p.id = ol.product_id
          WHERE jc.id=$1`, [st.job_card_id]);
        const avail = await oc(`
          SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches
          WHERE material_id=$1 AND status='available'`, [eff?.board_material_id]);
        const note = `Cutting ${cutVariance.parentDelta > 0 ? 'over' : 'under'}-cut on ${jcNo} — ${cutVariance.actualParents} vs ${cutVariance.plannedParents} parents (${req.body.variance_reason})`;
        await adjustBoardStock(eff?.board_material_id, cutVariance.parentDelta, 'job_stage', st.id, note, qc, oc);
        await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [cutVariance.actualParents, st.job_card_id]);
        await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [cutVariance.actualParents, st.id]);
        stQtyIn = cutVariance.actualParents; // leftover booking below books from the TRUE parents cut
        await qc(`INSERT INTO cutting_discrepancies
                  (job_card_id, job_stage_id, cpp, planned_parents, actual_parents, parent_delta,
                   planned_children, actual_children, board_material_id, board_available_before,
                   reason_code, note, created_by)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [st.job_card_id, st.id, cutVariance.cpp, cutVariance.plannedParents, cutVariance.actualParents,
           cutVariance.parentDelta, cutVariance.plannedChildren, cutVariance.actualChildren,
           eff?.board_material_id, Number(avail?.q || 0),
           (req.body.variance_reason || '').trim(), (req.body.variance_note || '').trim() || null, req.user.name]);
        await audit('job_stage', st.id, 'cutting_variance',
          `${cutVariance.parentDelta > 0 ? '+' : ''}${cutVariance.parentDelta} parents vs card (${cutVariance.plannedParents}→${cutVariance.actualParents}) — ${req.body.variance_reason}`, qc, req.user.name);
        await audit('job_card', st.job_card_id, 'cutting_variance',
          `cutting ${cutVariance.parentDelta > 0 ? 'over' : 'under'} by ${Math.abs(cutVariance.parentDelta)} parents — ${req.body.variance_reason}`, qc, req.user.name);
        if (eff?.board_material_id)
          await audit('materials', eff.board_material_id, 'cutting_variance',
            `${cutVariance.parentDelta > 0 ? 'consumed' : 'refunded'} ${Math.abs(cutVariance.parentDelta)} parent sheets (cutting ${jcNo})`, qc, req.user.name);
      }

      // Bank the planned leftover offcut — booked once per job card, from the
      // ACTUAL parents cut (qty_in), not the planned figure. Idempotent via
      // the LO-<jc_number> batch_no, so retries and stage adjustments can't
      // double-book. Declined/absent plan = no-op.
      if (st.stage === 'cutting' && st.job_card_id) {
        const jcForLeftover = await oc('SELECT order_line_id FROM job_cards WHERE id=$1', [st.job_card_id]);
        if (!jcForLeftover?.order_line_id) {
          // Gang parent leftovers are not booked automatically because the
          // parent card may represent mixed child layouts; split children carry
          // the product-specific traceability after die cutting.
        } else {
        const lp = await oc(`
          SELECT ol.leftover_plan, jc.jc_number,
                 COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM job_cards jc JOIN order_lines ol ON ol.id=jc.order_line_id
          JOIN products p ON p.id=ol.product_id WHERE jc.id=$1`, [st.job_card_id]);
        const plan = typeof lp?.leftover_plan === 'string' ? JSON.parse(lp.leftover_plan) : lp?.leftover_plan;
        if (plan?.push && plan.strip) {
          const confirmedNo = `LO-${lp.jc_number}`;
          const planNo = `LO-PLAN-${jcForLeftover.order_line_id}`;
          const actualQty = (plan.strips_per_parent || 1) * stQtyIn;
          const already = await oc('SELECT id FROM stock_batches WHERE batch_no=$1', [confirmedNo]);
          const planBatch = await oc('SELECT * FROM stock_batches WHERE batch_no=$1', [planNo]);
          if (already) {
            // Confirmed on a prior complete/retry — idempotent no-op.
          } else if (planBatch) {
            // Planned at plan-lock → true it up to the ACTUAL parents cut and
            // flip it from "planned" to "confirmed" (rename to LO-<jc>). The
            // delta preserves any qty already consumed off the batch.
            const delta = actualQty - Number(planBatch.initial_qty);
            const newQty = Math.max(0, Number(planBatch.qty) + delta);
            await qc(`UPDATE stock_batches SET qty=$1, initial_qty=$2, batch_no=$3, status=$4 WHERE id=$5`,
              [newQty, actualQty, confirmedNo, newQty > 0 ? 'available' : 'exhausted', planBatch.id]);
            if (delta !== 0)
              await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                        VALUES ($1,$2,'leftover_in',$3,'job_stage',$4,$5)`,
                [planBatch.material_id, planBatch.id, delta, st.id,
                 `Leftover trued up ${planBatch.initial_qty}→${actualQty} (actual cut) — ${lp.jc_number}`]);
            await audit('materials', planBatch.material_id, 'leftover_in',
              `confirmed ${actualQty} sheets (planned ${planBatch.initial_qty}) — ${lp.jc_number}`, qc, req.user.name);
          } else {
            // Legacy: opted in without a plan-lock bank — book fresh at complete.
            const srcBoard = await oc('SELECT * FROM materials WHERE id=$1', [lp.board_material_id]);
            const master = await findOrCreateLeftoverMaster(srcBoard, plan.strip, qc, oc);
            const [loBatch] = await qc(`
              INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
              VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`, [master.id, confirmedNo, actualQty]);
            await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                      VALUES ($1,$2,'leftover_in',$3,'job_stage',$4,$5)`,
              [master.id, loBatch.id, actualQty, st.id,
               `Leftover ${plan.strip.l}×${plan.strip.w}" banked from ${lp.jc_number}`]);
            await audit('materials', master.id, 'leftover_in',
              `${actualQty} sheets ${plan.strip.l}×${plan.strip.w}" from ${lp.jc_number}`, qc, req.user.name);
          }
        }
        }
      }

      // Wastage hits the movement ledger — production scrap is visible in the warehouse.
      if (qty_scrap > 0) {
        const jcRow = await oc('SELECT product_id FROM job_cards WHERE id=$1', [st.job_card_id]);
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
          [jcRow.product_id, -qty_scrap, st.id,
           `${st.stage.replace('_', ' ')} wastage (${st.unit})${scrap_reason ? ` — ${scrap_reason}` : ''}`]);
      }

      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [st.job_card_id]);
      const last = await oc('SELECT MAX(seq) AS mx FROM job_stages WHERE job_card_id=$1', [jc.id]);
      if (st.seq === last.mx && jc.gang_run_id && !jc.order_line_id && st.stage === 'die_cutting') {
        await splitGangParentJob(jc.id, qc, oc, req.user.name);
      } else if (st.seq === last.mx) {
        const tot = await oc(`SELECT COALESCE(SUM(qty_scrap),0)::int AS s FROM job_stages WHERE job_card_id=$1`, [jc.id]);
        // Only QC-accepted quantity becomes Finished Goods.
        await qc(`UPDATE job_cards SET status='closed', qty_produced=$1, qty_scrap=$2,
                  fg_location=COALESCE(fg_location,'FG-STORE'), closed_at=now() WHERE id=$3`,
          [qty_out, tot.s, jc.id]);
        await fgReceipt(jc.product_id, qty_out, 'job_card', jc.id, qc);
        await setLineStatus(jc.order_line_id, 'produced', qc, oc, req.user.name);
        await audit('job_card', jc.id, 'closed', `FG ${qty_out} accepted (batch ${jc.jc_number})`, qc, req.user.name);
      }
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// ── Unified Sort & Paste completion ─────────────────────────────────────────
// One atomic action that finishes BOTH the sorting and pasting stages of a job:
//   1. Sorting waste gate — sorted waste is captured and the sorted-good pool
//      (received − waste) is what pasting must consume.
//   2. Hybrid pasting — one or more rows, each pasted by machine, by hand, by
//      both on the same pieces (sequential side-paste → hand-lock), or split
//      across the two. Every row obeys  input = good + waste; the rows together
//      must cover exactly the sorted-good pool.
// The two job_stages stay separate in the ledger (FG / QC / timeline / adjust
// are unchanged) — the merge is on the operator's screen and in this one tx.

// Reconcile one grid row → good_qty, enforcing the per-method equation.
function reconcilePastingRow(row, i) {
  const method = row.method;
  const input = Math.max(0, Math.round(+row.input_qty || 0));
  const auto = Math.max(0, Math.round(+row.auto_qty || 0));
  const manual = Math.max(0, Math.round(+row.manual_qty || 0));
  const waste = Math.max(0, Math.round(+row.waste_qty || 0));
  const bad = msg => { throw Object.assign(new Error(`Pasting row ${i + 1}: ${msg}`), { status: 400 }); };
  let good;
  if (method === 'machine') { if (manual) bad('a machine-only row cannot carry a hand quantity'); good = auto; }
  else if (method === 'manual') { if (auto) bad('a hand-only row cannot carry a machine quantity'); good = manual; }
  else if (method === 'machine_manual') { if (auto !== manual) bad('machine + hand on the same pieces needs equal machine and hand counts'); good = auto; }
  else if (method === 'split') { good = auto + manual; }
  else bad('unknown pasting method');
  if (input <= 0) bad('input must be greater than zero');
  if (input !== good + waste) bad(`input ${input} must equal good ${good} + waste ${waste}`);
  return {
    input_qty: input, method, auto_qty: auto, manual_qty: manual, waste_qty: waste,
    waste_reason: waste > 0 ? (row.waste_reason || null) : null,
    auto_machine_id: row.auto_machine_id ? +row.auto_machine_id : null, good_qty: good,
  };
}

r.post('/sort-paste/:jobCardId/complete', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const user = req.user.name;
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.jobCardId]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      const sortSt = await oc(`SELECT * FROM job_stages WHERE job_card_id=$1 AND stage='sorting' FOR UPDATE`, [jc.id]);
      const pasteSt = await oc(`SELECT * FROM job_stages WHERE job_card_id=$1 AND stage='pasting' FOR UPDATE`, [jc.id]);
      if (!sortSt || !pasteSt) throw Object.assign(new Error('This job has no Sort & Paste stages'), { status: 409 });
      if (pasteSt.status === 'completed') throw Object.assign(new Error('Pasting is already completed for this job'), { status: 409 });

      // ── Phase 1: Sorting + mandatory waste gate ──────────────────────────────
      let sortedGood;
      if (sortSt.status === 'completed') {
        sortedGood = sortSt.qty_out;                       // already sorted — go straight to pasting
      } else {
        if (!['in_progress', 'partially_completed'].includes(sortSt.status))
          throw Object.assign(new Error('Start the Sort & Paste run before completing it'), { status: 409 });
        const sortReceipt = await stageReceipt(oc, sortSt.id);
        const prev = sortReceipt.prev;
        // Same rule as /complete: a partially-counted upstream feeds Sort &
        // Paste at its counted-so-far figure; only a silent upstream blocks.
        if (prev && prev.status !== 'completed' && (prev.qty_out == null || prev.qty_out <= 0))
          throw Object.assign(new Error(
            `"${prev.stage.replace('_', ' ')}" hasn't recorded any output yet — record a count there first`), { status: 409 });
        let sortIn = sortSt.qty_in;
        if (prev || sortIn == null) {
          sortIn = sortReceipt.live;                        // stamp the live receipt, as /complete does
          await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [sortIn, sortSt.id]);
        }
        if (sortIn == null) throw Object.assign(new Error('Cannot determine the quantity entering sorting'), { status: 409 });
        const sortedWaste = Math.max(0, Math.round(+req.body.sorted_waste || 0));
        if (sortedWaste > sortIn) throw Object.assign(new Error(`Sorted waste (${sortedWaste}) exceeds the ${sortIn} received`), { status: 409 });
        if (sortedWaste > 0 && !(req.body.sorted_waste_reason || '').trim())
          throw Object.assign(new Error('A rejection reason is required for the sorted waste'), { status: 400 });
        sortedGood = sortIn - sortedWaste;
        const sortReason = sortedWaste > 0 ? req.body.sorted_waste_reason : null;
        // Balancing run — same contract as /complete: the run log stays the
        // authoritative day-wise record, and closing totals may never fall
        // below what the log already says.
        {
          const prior = rollupRuns(await qc(
            'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [sortSt.id]));
          const dGood = sortedGood - prior.qty_good, dScrap = sortedWaste - prior.qty_scrap;
          if (dGood < 0 || dScrap < 0)
            throw Object.assign(new Error(
              `Sorting totals (${sortedGood} good / ${sortedWaste} waste) are below what the day log already records (${prior.qty_good} / ${prior.qty_scrap}). Edit or delete a day count instead.`
            ), { status: 409 });
          if (dGood !== 0 || dScrap !== 0)
            await qc(`INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                        scrap_reason, machine_id, operator, note, created_by)
                      VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9)`,
              [sortSt.id, (prior.run_count || 0) + 1, dGood, dScrap,
               dScrap > 0 ? sortReason : null, sortSt.machine_id,
               sortSt.operator || user, prior.run_count ? 'closing balance' : null, user]);
        }
        await qc(`UPDATE job_stages SET status='completed', qty_out=$1, qty_scrap=$2, scrap_reason=$3,
                  completed_at=now() WHERE id=$4`, [sortedGood, sortedWaste, sortReason, sortSt.id]);
        if (sortedWaste > 0) {
          await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                    VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
            [jc.product_id, -sortedWaste, sortSt.id, `sorting wastage (${sortSt.unit})${sortReason ? ` — ${sortReason}` : ''}`]);
        }
        await audit('job_stage', sortSt.id, 'complete',
          `sorting out=${sortedGood} scrap=${sortedWaste}${sortReason ? ` (${sortReason})` : ''}`, qc, user);
      }

      // ── Phase 2: Hybrid pasting ──────────────────────────────────────────────
      const rawRows = Array.isArray(req.body.rows) ? req.body.rows : [];
      if (!rawRows.length) throw Object.assign(new Error('At least one pasting row is required'), { status: 400 });
      const rows = rawRows.map(reconcilePastingRow);
      const totalInput = rows.reduce((s, r) => s + r.input_qty, 0);
      if (totalInput !== sortedGood)
        throw Object.assign(new Error(`Pasting rows cover ${totalInput} pieces — must equal the ${sortedGood} sorted-good pieces`), { status: 409 });
      const pasteGood = rows.reduce((s, r) => s + r.good_qty, 0);
      const pasteWaste = rows.reduce((s, r) => s + r.waste_qty, 0);
      const pasteReason = rows.find(r => r.waste_reason)?.waste_reason || (pasteWaste > 0 ? 'Pasting wastage' : null);

      // Any referenced auto machine must be a pasting workstation.
      for (const rr of rows) {
        if (rr.auto_machine_id) {
          const m = await oc('SELECT type FROM machines WHERE id=$1', [rr.auto_machine_id]);
          if (!m || m.type !== 'pasting') rr.auto_machine_id = null;
        }
      }
      let pasteMachine = req.body.paste_machine_id ? +req.body.paste_machine_id
        : (rows.find(r => r.auto_machine_id)?.auto_machine_id ?? null);
      if (pasteMachine) {
        const m = await oc('SELECT type FROM machines WHERE id=$1', [pasteMachine]);
        if (!m || m.type !== 'pasting') pasteMachine = null;
      }
      const pasteOperator = req.body.paste_operator || pasteSt.operator || sortSt.operator || user;

      // Pasting balancing run — day counts logged while pasting was under way
      // reconcile against the final row grid exactly like /complete does.
      {
        const prior = rollupRuns(await qc(
          'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [pasteSt.id]));
        const dGood = pasteGood - prior.qty_good, dScrap = pasteWaste - prior.qty_scrap;
        if (dGood < 0 || dScrap < 0)
          throw Object.assign(new Error(
            `Pasting totals (${pasteGood} good / ${pasteWaste} waste) are below what the day log already records (${prior.qty_good} / ${prior.qty_scrap}). Edit or delete a day count instead.`
          ), { status: 409 });
        if (dGood !== 0 || dScrap !== 0)
          await qc(`INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                      scrap_reason, machine_id, operator, note, created_by)
                    VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9)`,
            [pasteSt.id, (prior.run_count || 0) + 1, dGood, dScrap,
             dScrap > 0 ? pasteReason : null, pasteMachine, pasteOperator,
             prior.run_count ? 'closing balance' : null, user]);
      }

      // Packing manifest — same normalisation as the standalone pasting station.
      const packingLines = (Array.isArray(req.body.packing_lines) ? req.body.packing_lines : [])
        .map(pl => ({
          boxes: Math.max(0, Math.round(+pl.boxes || 0)),
          qty_per_box: Math.max(0, Math.round(+pl.qty_per_box || 0)),
          loose_qty: Math.max(0, Math.round(+pl.loose_qty || 0)),
        }))
        .map(pl => ({ ...pl, total: pl.boxes * pl.qty_per_box + pl.loose_qty }))
        .filter(pl => pl.total > 0);
      let pack_boxes = null, pack_qty_per_box = null;
      if (packingLines.length) {
        pack_boxes = packingLines.reduce((s, pl) => s + pl.boxes + (pl.loose_qty > 0 ? 1 : 0), 0);
        const boxLines = packingLines.filter(pl => pl.boxes > 0);
        pack_qty_per_box = boxLines.length === 1 ? boxLines[0].qty_per_box : null;
      }

      await qc(`UPDATE job_stages SET status='completed', qty_in=$1, qty_out=$2, qty_scrap=$3,
                scrap_reason=$4, machine_id=$5, operator=$6, pack_boxes=$7, pack_qty_per_box=$8,
                line_clearance=COALESCE(line_clearance, $9),
                started_at=COALESCE(started_at, now()), completed_at=now() WHERE id=$10`,
        [sortedGood, pasteGood, pasteWaste, pasteReason, pasteMachine, pasteOperator,
         pack_boxes, pack_qty_per_box, sortSt.line_clearance, pasteSt.id]);

      let seq = 1;
      for (const rr of rows) {
        await qc(`INSERT INTO pasting_rows (job_stage_id, seq, input_qty, method, auto_qty, manual_qty,
                  auto_machine_id, waste_qty, waste_reason, good_qty)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [pasteSt.id, seq++, rr.input_qty, rr.method, rr.auto_qty, rr.manual_qty,
           rr.auto_machine_id, rr.waste_qty, rr.waste_reason, rr.good_qty]);
      }
      for (const pl of packingLines) {
        await qc(`INSERT INTO packing_lines (job_stage_id, boxes, qty_per_box, loose_qty, total)
                  VALUES ($1,$2,$3,$4,$5)`, [pasteSt.id, pl.boxes, pl.qty_per_box, pl.loose_qty, pl.total]);
      }
      if (pasteWaste > 0) {
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
          [jc.product_id, -pasteWaste, pasteSt.id, `pasting wastage (${pasteSt.unit})${pasteReason ? ` — ${pasteReason}` : ''}`]);
      }
      const autoTotal = rows.reduce((s, r) => s + r.auto_qty, 0);
      const manualTotal = rows.reduce((s, r) => s + r.manual_qty, 0);
      await audit('job_stage', pasteSt.id, 'complete',
        `pasting out=${pasteGood} scrap=${pasteWaste} · auto ${autoTotal} / manual ${manualTotal} across ${rows.length} row${rows.length > 1 ? 's' : ''}`, qc, user);
      if (packingLines.length) {
        const packedTotal = packingLines.reduce((s, pl) => s + pl.total, 0);
        await audit('job_stage', pasteSt.id, 'packing_manifest',
          `${packingLines.length} lines — ${packedTotal} pcs in ${pack_boxes} boxes`, qc, user);
      }
      if (jc.status === 'open') await qc(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [jc.id]);

      return { job_card_id: jc.id, sorted_good: sortedGood, pasted_good: pasteGood, paste_waste: pasteWaste };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Redo a completed Sort & Paste run: un-complete BOTH stages in one tx so the
// operator can run it again from the waste gate. Blocked once QC has started —
// its received quantity would otherwise become inconsistent.
r.post('/sort-paste/:jobCardId/reverse', canRun, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) throw Object.assign(new Error('A reason is required to reverse a Sort & Paste run'), { status: 400 });
    await tx(async (qc, oc) => {
      const jc = await oc('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [req.params.jobCardId]);
      if (!jc) throw Object.assign(new Error('Job card not found'), { status: 404 });
      if (jc.status === 'closed') throw Object.assign(new Error('Job is closed — cannot reverse'), { status: 409 });
      const sortSt = await oc(`SELECT * FROM job_stages WHERE job_card_id=$1 AND stage='sorting' FOR UPDATE`, [jc.id]);
      const pasteSt = await oc(`SELECT * FROM job_stages WHERE job_card_id=$1 AND stage='pasting' FOR UPDATE`, [jc.id]);
      if (!pasteSt || pasteSt.status !== 'completed')
        throw Object.assign(new Error('Nothing to reverse — this run is not completed'), { status: 409 });
      const next = await oc('SELECT * FROM job_stages WHERE job_card_id=$1 AND seq=$2', [jc.id, pasteSt.seq + 1]);
      if (next && next.status !== 'pending')
        throw Object.assign(new Error(`${next.stage.replace('_', ' ')} has already started — reverse it first`), { status: 409 });

      // Unwind pasting: drop the hybrid rows, packing manifest and its wastage
      // ledger entry, then reset the stage to pending.
      await qc('DELETE FROM pasting_rows WHERE job_stage_id=$1', [pasteSt.id]);
      await qc('DELETE FROM packing_lines WHERE job_stage_id=$1', [pasteSt.id]);
      await qc(`DELETE FROM stock_movements WHERE ref_type='job_stage' AND ref_id=$1 AND type='wastage'`, [pasteSt.id]);
      // Runs would otherwise survive a reverse (only a stage DELETE cascades) and
      // corrupt the running-balance ceiling on the next completion attempt.
      await qc('DELETE FROM stage_runs WHERE job_stage_id = $1', [pasteSt.id]);
      await qc(`UPDATE job_stages SET status='pending', qty_in=NULL, qty_out=NULL, qty_scrap=0,
                scrap_reason=NULL, machine_id=NULL, pack_boxes=NULL, pack_qty_per_box=NULL,
                started_at=NULL, completed_at=NULL WHERE id=$1`, [pasteSt.id]);
      await audit('job_stage', pasteSt.id, 'reverse', `pasting reversed — ${reason}`, qc, req.user.name);

      // Reopen sorting so the waste gate runs again (keep its received qty).
      if (sortSt && sortSt.status === 'completed') {
        await qc(`DELETE FROM stock_movements WHERE ref_type='job_stage' AND ref_id=$1 AND type='wastage'`, [sortSt.id]);
        await qc('DELETE FROM stage_runs WHERE job_stage_id = $1', [sortSt.id]);
        await qc(`UPDATE job_stages SET status='in_progress', qty_out=NULL, qty_scrap=0,
                  scrap_reason=NULL, completed_at=NULL WHERE id=$1`, [sortSt.id]);
        await audit('job_stage', sortSt.id, 'reverse', `sorting reversed — ${reason}`, qc, req.user.name);
      }
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Row-level stage adjustment ──────────────────────────────────────────────
// A permitted correction to a COMPLETED stage's quantities cascades forward:
// the next stage's received quantity updates in real time. Guard rails:
// nothing downstream may already be completed, the job must still be open,
// and every change is audited old → new with a reason.
async function stageImpact(stageId, newOut, newScrap, oc) {
  const st = await oc(`
    SELECT js.*, jc.status AS jc_status, jc.children_per_parent, jc.jc_number, jc.product_id
    FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id WHERE js.id=$1`, [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });

  const out = { stage: st, old: { qty_out: st.qty_out, qty_scrap: st.qty_scrap }, new: { qty_out: newOut, qty_scrap: newScrap }, downstream: [], blocked: null };
  if (st.status !== 'completed') { out.blocked = 'Only a completed stage can be adjusted'; return out; }
  if (st.jc_status === 'closed') { out.blocked = 'Job is closed — finished goods and dispatch already exist. Use a controlled FG adjustment instead of editing history.'; return out; }

  const later = await oc(`SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND seq>$2 AND status='completed'`, [st.job_card_id, st.seq]);
  if (later.n > 0) { out.blocked = 'A later stage is already completed — its recorded output would become inconsistent. Adjust the latest completed stage instead.'; return out; }

  if (st.stage !== 'cutting') {
    const cap = (await stageReceipt(oc, st.id)).received;
    if (newOut + newScrap > cap) { out.blocked = `Output + wastage (${newOut + newScrap}) exceeds received (${cap})`; return out; }
  }

  const next = await oc('SELECT * FROM job_stages WHERE job_card_id=$1 AND seq=$2', [st.job_card_id, st.seq + 1]);
  if (next && next.status !== 'pending') {
    const ups = (await oc('SELECT ups FROM products WHERE id=$1', [st.product_id])).ups;
    // The downstream stage's receipt is this stage's revised output PLUS the
    // extra sheets issued straight to it — cascading the bare output would
    // silently strike a CI-XS top-up off the row it was issued to.
    const nextExtras = (await stageReceipt(oc, next.id)).extraIssued;
    const newIn = (st.unit === 'sheets' && next.unit === 'cartons' ? newOut * ups : newOut) + nextExtras;
    out.downstream.push({ id: next.id, stage: next.stage, status: next.status, old_qty_in: next.qty_in, new_qty_in: newIn });
  } else if (next) {
    out.downstream.push({ id: next.id, stage: next.stage, status: next.status, old_qty_in: null, new_qty_in: null, note: 'not started — will receive the new quantity automatically' });
  }
  return out;
}

r.get('/job-stages/:id/impact', canRun, async (req, res, next) => {
  try {
    const newOut = Math.max(0, Math.round(+req.query.qty_out || 0));
    const newScrap = Math.max(0, Math.round(+req.query.qty_scrap || 0));
    const impact = await stageImpact(req.params.id, newOut, newScrap, one);
    res.json({
      stage: { id: impact.stage.id, stage: impact.stage.stage, jc_number: impact.stage.jc_number, qty_in: impact.stage.qty_in, unit: impact.stage.unit },
      old: impact.old, new: impact.new, downstream: impact.downstream, blocked: impact.blocked,
    });
  } catch (e) { next(e); }
});

// Cutting Variances register — every recorded over/under-cut, newest first,
// enriched for the warehouse review page and export.
r.get('/cutting-variances', canRun, async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT cd.*, jc.jc_number, p.name AS product_name, p.code AS product_code,
             m.name AS board_name,
             o.po_number, c.name AS customer_name
      FROM cutting_discrepancies cd
      JOIN job_cards jc ON jc.id = cd.job_card_id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN materials m ON m.id = cd.board_material_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN orders o ON o.id = ol.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      ORDER BY cd.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/adjust', canRun, async (req, res, next) => {
  try {
    const newOut = Math.max(0, Math.round(+req.body.qty_out || 0));
    const newScrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required for adjusting a completed stage' });
    await tx(async (qc, oc) => {
      const impact = await stageImpact(req.params.id, newOut, newScrap, oc);
      if (impact.blocked) throw Object.assign(new Error(impact.blocked), { status: 409 });
      const st = impact.stage;

      await qc(`UPDATE job_stages SET qty_out=$1, qty_scrap=$2 WHERE id=$3`, [newOut, newScrap, st.id]);
      // Cutting adjust re-derives the parents actually cut and trues-up the
      // board by the delta vs what the stage currently reflects (st.qty_in was
      // set to the last actual parents at completion / prior adjust).
      if (st.stage === 'cutting') {
        const jcv = await oc('SELECT children_per_parent, sheets_issued FROM job_cards WHERE id=$1', [st.job_card_id]);
        const v = cuttingVariance({ qty_out: newOut, qty_scrap: newScrap, children_per_parent: jcv.children_per_parent, sheets_issued: jcv.sheets_issued });
        const boardDelta = v.actualParents - (st.qty_in || 0);
        if (boardDelta !== 0) {
          const eff = await oc(`
            SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
            FROM job_cards jc
            JOIN order_lines ol ON ol.id = COALESCE(jc.order_line_id,
                  (SELECT id FROM order_lines WHERE gang_run_id = jc.gang_run_id ORDER BY id LIMIT 1))
            JOIN products p ON p.id = ol.product_id WHERE jc.id=$1`, [st.job_card_id]);
          const avail = await oc(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`, [eff?.board_material_id]);
          await adjustBoardStock(eff?.board_material_id, boardDelta, 'job_stage', st.id, `Cutting adjust on ${st.jc_number} — ${reason}`, qc, oc);
          await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [v.actualParents, st.id]);
          await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [v.actualParents, st.job_card_id]);
          await qc(`INSERT INTO cutting_discrepancies
                    (job_card_id, job_stage_id, cpp, planned_parents, actual_parents, parent_delta,
                     planned_children, actual_children, board_material_id, board_available_before,
                     reason_code, note, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [st.job_card_id, st.id, v.cpp, v.plannedParents, v.actualParents, v.parentDelta,
             v.plannedChildren, v.actualChildren, eff?.board_material_id, Number(avail?.q || 0),
             'Adjust', reason, req.user.name]);
        }
      }
      // Wastage delta hits the movement ledger so warehouse figures stay true.
      const scrapDelta = newScrap - (st.qty_scrap || 0);
      if (scrapDelta !== 0) {
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage',$2,'job_stage',$3,$4)`,
          [st.product_id, -scrapDelta, st.id, `${st.stage.replace('_', ' ')} wastage adjusted — ${reason}`]);
      }
      for (const d of impact.downstream) {
        if (d.new_qty_in == null) continue;
        await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [d.new_qty_in, d.id]);
        await audit('job_stage', d.id, 'cascade_update',
          `qty_in ${d.old_qty_in} → ${d.new_qty_in} (upstream ${st.stage} adjusted)`, qc, req.user.name);
      }
      await audit('job_stage', st.id, 'adjust',
        `out ${st.qty_out} → ${newOut}, scrap ${st.qty_scrap} → ${newScrap} — ${reason}`, qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// Reverse the latest completed stage back to in-progress so the section can
// correct it at row level. Guard rails are strict: no downstream activity, job
// not closed/split, and a reason is mandatory. Quantity ledgers are balanced
// for wastage; FG/dispatch reversals are deliberately not allowed here.
r.post('/job-stages/:id/reverse', canRun, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required for reversing a completed stage' });
    await tx(async (qc, oc) => {
      const st = await oc(`
        SELECT js.*, jc.status AS jc_status, jc.product_id, jc.jc_number
        FROM job_stages js JOIN job_cards jc ON jc.id=js.job_card_id
        WHERE js.id=$1 FOR UPDATE OF js`, [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status !== 'completed')
        throw Object.assign(new Error('Only a completed stage can be reversed'), { status: 409 });
      if (['closed', 'split'].includes(st.jc_status))
        throw Object.assign(new Error('This job is already closed/split. Reverse via controlled FG/job correction instead.'), { status: 409 });

      const downstream = await oc(`
        SELECT stage, status FROM job_stages
        WHERE job_card_id=$1 AND seq>$2 AND status != 'pending'
        ORDER BY seq LIMIT 1`, [st.job_card_id, st.seq]);
      if (downstream)
        throw Object.assign(new Error(`Cannot reverse: ${downstream.stage.replace('_', ' ')} is already ${downstream.status.replace('_', ' ')}`), { status: 409 });

      const laterCompleted = await oc(`
        SELECT COUNT(*)::int AS n FROM job_stages
        WHERE job_card_id=$1 AND seq>$2 AND status='completed'`, [st.job_card_id, st.seq]);
      if (laterCompleted.n > 0)
        throw Object.assign(new Error('Reverse the latest completed downstream stage first'), { status: 409 });

      if ((st.qty_scrap || 0) > 0) {
        await qc(`INSERT INTO stock_movements (product_id, type, qty, ref_type, ref_id, note)
                  VALUES ($1,'wastage_reversal',$2,'job_stage',$3,$4)`,
          [st.product_id, st.qty_scrap, st.id, `${st.stage.replace('_', ' ')} reversed — ${reason}`]);
      }

      await qc(`
        UPDATE job_stages SET status='in_progress',
          qty_out=NULL, qty_scrap=0, scrap_reason=NULL,
          qty_accepted=NULL, qty_rejected=NULL, qty_rework=NULL,
          inspector=NULL, remarks=NULL, pack_boxes=NULL, pack_qty_per_box=NULL,
          completed_at=NULL
        WHERE id=$1`, [st.id]);
      await qc('DELETE FROM packing_lines WHERE job_stage_id=$1', [st.id]);
      // Runs would otherwise survive a reverse (only a stage DELETE cascades) and
      // corrupt the running-balance ceiling on the next completion attempt.
      await qc('DELETE FROM stage_runs WHERE job_stage_id = $1', [st.id]);
      await audit('job_stage', st.id, 'reverse',
        `${st.stage} reversed to in progress from out=${st.qty_out}, scrap=${st.qty_scrap || 0} — ${reason}`,
        qc, req.user.name);
    });
    res.json(await one('SELECT * FROM job_stages WHERE id=$1', [req.params.id]));
  } catch (e) { next(e); }
});

// What a send-back would undo, without doing any of it — the confirm dialog.
// A 409 here is not an error to swallow: its `blockers` name the stage that
// must be reversed first, which is the operator's actual next act.
r.get('/job-stages/:id/reverse-plan', canRun, async (req, res, next) => {
  try {
    const plan = await tx(async (qc, oc) => stageReversePlan(+req.params.id, qc, oc));
    res.json({
      stage: plan.st.stage, status: plan.st.status, jc_number: plan.st.jc_number,
      target: plan.move.target, label: plan.move.label,
      items: plan.manifest.items, warnings: plan.manifest.warnings,
      gang: plan.gang, cards: plan.members.length,
    });
  } catch (e) { next(e); }
});

// Send a stage back ONE station — the un-start that was missing. Reversing a
// completed stage in place (to correct its output) is still /reverse above;
// this is the move that actually hands the work to the station before it, and
// once every stage is pending again the Print Planning and Job Card reverses
// in workflow.js open up on their own.
r.post('/job-stages/:id/send-back', canRun, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to send a stage back' });
    const out = await tx(async (qc, oc) => {
      // The gate is decided from the PLAN, not the request: only the plan knows
      // whether this hop moves stock. A flag lookup, not a role guard — many
      // plant logins carry role=admin and must not inherit the decision.
      const plan = await stageReversePlan(+req.params.id, qc, oc);
      if (reverseNeedsApprover({ target: plan.move.target, items: plan.manifest.items })) {
        const u = await oc('SELECT reverse_approver FROM users WHERE id=$1', [req.user.id]);
        if (!u?.reverse_approver) {
          throw Object.assign(new Error(
            plan.move.target === 'print_planning'
              ? 'Taking a job off the floor needs the plant head — ask them to send it back to Print Planning'
              : 'This reverse returns stock to the warehouse — only the plant head can approve it'),
          { status: 403 });
        }
      }
      return sendStageBack(+req.params.id, reason, qc, oc, req.user.name);
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Pull a job off the floor in one act, back to the Job Card station where it can
// be edited and re-pushed. Same guard as send-back — nothing downstream may have
// started — so the reverse-plan endpoint above already tells the UI whether to
// offer it, and the manifest it returns is the same one this will act on.
r.post('/job-stages/:id/pull-back', canRun, async (req, res, next) => {
  try {
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to pull a job off the floor' });
    const out = await tx(async (qc, oc) => {
      const plan = await stageReversePlan(+req.params.id, qc, oc);
      if (!plan.move) throw Object.assign(new Error('This stage cannot be pulled back'), { status: 409 });
      if (reverseNeedsApprover({ target: 'job_card', items: plan.manifest.items })) {
        const u = await oc('SELECT reverse_approver FROM users WHERE id=$1', [req.user.id]);
        if (!u?.reverse_approver) {
          throw Object.assign(new Error(
            'Taking a job off the floor needs the plant head — ask them to pull it back to the Job Card'),
          { status: 403 });
        }
      }
      return pullBackToJobCard(+req.params.id, reason, qc, oc, req.user.name);
    });
    res.json(out);
  } catch (e) { next(e); }
});

// ── Finished Goods ──────────────────────────────────────────────────────────
// Every closed job card is an FG batch: QC-accepted qty in, dispatched out,
// with ordered vs produced (excess / short) and dispatch readiness.
// Pending QC inspection — the unified module's first tab. A batch is ready to
// inspect once its QC stage exists and every stage before it is completed. The
// stage may still be 'pending' (not yet started on the floor) or 'in_progress';
// the module's inspect action starts it if needed, then completes it with the
// inspector's accepted/rejected/rework counts.
r.get('/qc/pending', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT s.id AS stage_id, s.status AS stage_status, s.qty_in, s.seq,
             jc.id AS job_card_id, jc.jc_number AS batch,
             p.id AS product_id, p.name AS product_name, p.code AS product_code,
             c.name AS customer_name, o.po_number,
             ol.qty AS ordered_qty,
             prev.status AS prev_status,
             prev.qty_out AS prev_out,
             -- What QC has to inspect. Live off pasting rather than off the QC
             -- row's own qty_in, which is only a snapshot until QC closes.
             COALESCE(prev.qty_out, s.qty_in) AS received
      FROM job_stages s
      JOIN job_cards jc ON jc.id=s.job_card_id
      JOIN products p ON p.id=jc.product_id
      LEFT JOIN order_lines ol ON ol.id=jc.order_line_id
      LEFT JOIN orders o ON o.id=ol.order_id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN job_stages prev ON prev.job_card_id=jc.id AND prev.seq=s.seq-1
      WHERE s.stage='qc' AND s.status IN ('pending','in_progress','partially_completed','hold')
        AND jc.status NOT IN ('closed','split')
        AND (prev.id IS NULL OR prev.status='completed')
      ORDER BY jc.id`));
  } catch (e) { next(e); }
});

r.get('/finished-goods', async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT jc.id AS job_card_id, jc.jc_number AS batch, jc.qty_produced, jc.qty_scrap,
             jc.fg_location, jc.closed_at,
             p.id AS product_id, p.name AS product_name, p.code AS product_code, p.rate,
             c.name AS customer_name, o.po_number,
             ol.qty AS ordered_qty, ol.dispatched_qty, ol.status AS line_status,
             (jc.qty_produced - ol.dispatched_qty) AS available,
             GREATEST(0, jc.qty_produced - ol.qty) AS excess,
             GREATEST(0, ol.qty - jc.qty_produced) AS shortfall,
             COALESCE(lot.lotted, 0) AS lotted_qty
      FROM job_cards jc
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(qty),0)::int AS lotted FROM fg_lots
        WHERE job_card_id=jc.id AND status != 'rejected') lot ON true
      JOIN products p ON p.id = jc.product_id
      JOIN order_lines ol ON ol.id = jc.order_line_id
      JOIN orders o ON o.id = ol.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE jc.status='closed'
      ORDER BY (jc.qty_produced - ol.dispatched_qty) > 0 DESC, jc.closed_at DESC NULLS LAST`));
  } catch (e) { next(e); }
});

// One batch's full production history (stage by stage) for FG traceability.
r.get('/finished-goods/:jobCardId', async (req, res, next) => {
  try {
    const jc = await one(`${JC_VIEW} WHERE jc.id=$1`, [req.params.jobCardId]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    jc.stages = await loadStages(jc);
    jc.dispatches = await q(`
      SELECT d.challan_number, d.dispatched_at, dl.qty FROM dispatch_lines dl
      JOIN dispatches d ON d.id=dl.dispatch_id WHERE dl.order_line_id=$1 ORDER BY d.id`, [jc.order_line_id]);
    jc.packing = await q(`
      SELECT pl.* FROM packing_lines pl
      JOIN job_stages js ON js.id=pl.job_stage_id
      WHERE js.job_card_id=$1 ORDER BY pl.id`, [jc.id]);
    jc.lots = await q(`
      SELECT fl.*, (fl.qty - fl.consumed_qty) AS remaining FROM fg_lots fl
      WHERE fl.job_card_id=$1 ORDER BY fl.id`, [jc.id]);
    await attachTools(jc);
    res.json(jc);
  } catch (e) { next(e); }
});

export default r;
