// Gang printing — several order lines that share a press run.
// Distilled from CI-Production's mix-set/gang engine into one simple rule set:
// Compatibility is advisory. The planner can bind any number of jobs; the
// resulting gang travels as one physical parent card until die cutting and
// splits back into product-specific child cards for sorting → pasting → QC.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import {
  audit, nextNumber, sheetsRequired, netProduceQty, availableQty,
  effectiveProduct, effectiveParent, childFit, parentSheetsRequired, setLineStatus, forceLineStatus,
} from '../helpers.js';
import { rankBoardMatches } from '../smartmatch.js';
import { requireRole } from '../auth.js';

const r = Router();
const canPlan = requireRole('planner');

// Effective spec — job-only overrides win over the product master (same
// expression the planning views use).
const EFF_BOARD_ID = `COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)`;
const MEMBER_VIEW = `
  SELECT ol.id, ol.order_id, ol.qty, ol.status, ol.gang_run_id,
         ol.sheets_required, ol.parent_sheets_required, ol.fg_consumed_qty,
         ol.wastage_sheets, ol.spec_override,
         o.po_number, o.delivery_date, c.name AS customer_name,
         p.id AS product_id, p.name AS product_name, p.code AS product_code, p.gsm,
         p.ups AS master_ups, p.wastage_pct,
         COALESCE(ol.spec_override->>'coating', p.coating) AS coating,
         COALESCE(ol.spec_override->>'special', p.special) AS special,
         COALESCE((ol.spec_override->>'colors')::int, p.colors) AS colors,
         COALESCE((ol.spec_override->>'ups')::int, p.ups) AS ups,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         COALESCE((ol.spec_override->>'emboss')::int, p.emboss) AS emboss,
         COALESCE((ol.spec_override->>'leafing')::int, p.leafing) AS leafing,
         COALESCE(ol.spec_override->>'leafing_colour', p.leafing_colour) AS leafing_colour,
         COALESCE(ol.spec_override->>'party_artwork_code', p.party_artwork_code) AS party_artwork_code,
         COALESCE(ol.spec_override->>'output_number', p.output_number) AS output_number,
         COALESCE(ol.spec_override->>'shade_card_number', p.shade_card_number) AS shade_card_number,
         COALESCE(ol.spec_override->>'shade_card_date', p.shade_card_date) AS shade_card_date,
         COALESCE(ol.spec_override->>'colour_type', p.colour_type) AS colour_type,
         COALESCE(ol.spec_override->>'pasting_type', p.pasting_type) AS pasting_type,
         p.gsm AS master_gsm, p.size AS carton_size, p.internal_carton_code,
         dtool.code AS die_number,
         ${EFF_BOARD_ID} AS board_material_id,
         bm.name AS board_name, bm.sheet_l, bm.sheet_w,
         mbm.name AS master_board_name,
         COALESCE(NULLIF(p.board_grade,''), NULLIF(split_part(p.board_name,' ',1),''), split_part(bm.name,' ',1)) AS board_grade,
         jc.id AS job_card_id, jc.jc_number
  FROM order_lines ol
  JOIN orders o ON o.id = ol.order_id
  JOIN customers c ON c.id = o.customer_id
  JOIN products p ON p.id = ol.product_id
  JOIN materials bm ON bm.id = ${EFF_BOARD_ID}
  LEFT JOIN materials mbm ON mbm.id = p.board_material_id
  LEFT JOIN tools dtool ON dtool.id = p.tool_id
  LEFT JOIN job_cards jc ON jc.order_line_id = ol.id`;

// Parent sheets a member still needs — the locked plan figure when present,
// otherwise a live estimate from the master spec (1 child : 1 parent fallback).
function memberParentSheets(m) {
  if (m.parent_sheets_required != null) return m.parent_sheets_required;
  if (m.sheets_required != null) return m.sheets_required;
  return sheetsRequired({ ups: m.ups, wastage_pct: m.wastage_pct }, netProduceQty(m), m.wastage_sheets);
}

// The compatibility check — pure, tiny, and the single source of truth.
export function gangCompat(members) {
  const conflicts = [];
  const warnings = [];
  const uniq = pick => [...new Set(members.map(pick).filter(v => v != null && v !== ''))];

  const boards = uniq(m => m.board_name);
  if (uniq(m => m.board_material_id).length > 1) warnings.push({ field: 'board', values: boards });
  const coatings = uniq(m => m.coating);
  if (coatings.length > 1) warnings.push({ field: 'coating', values: coatings });

  const colors = uniq(m => m.colors);
  if (colors.length > 1) warnings.push({ field: 'colours', values: colors.map(String) });
  const specials = uniq(m => m.special).filter(s => s !== 'none');
  if (uniq(m => m.special).length > 1) warnings.push({ field: 'special finish', values: uniq(m => m.special) });
  const gsms = members.map(m => m.gsm).filter(g => g != null);
  if (gsms.length > 1 && Math.max(...gsms) - Math.min(...gsms) > 10) {
    warnings.push({ field: 'gsm', values: [...new Set(gsms.map(String))] });
  }
  const days = members.map(m => Date.parse(m.delivery_date)).filter(Number.isFinite);
  if (days.length > 1 && (Math.max(...days) - Math.min(...days)) / 86400000 > 7) {
    warnings.push({ field: 'delivery dates', values: uniq(m => m.delivery_date) });
  }
  return { ok: conflicts.length === 0, conflicts, warnings, specials };
}

// Combined board position for a gang: one board, everyone's parent sheets.
// Exported so the planning engine context can embed the same picture.
export async function gangDetail(gangId, oc = one, qc = q) {
  const gang = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangId]);
  if (!gang) { const e = new Error('Gang run not found'); e.status = 404; throw e; }
  const members = await qc(`${MEMBER_VIEW} WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [gangId]);
  const withSheets = members.map(m => ({ ...m, parent_sheets: memberParentSheets(m) }));
  const boardId = withSheets[0]?.board_material_id ?? null;
  const totalParent = withSheets.reduce((s, m) => s + m.parent_sheets, 0);

  let position = null;
  if (boardId) {
    const available = await availableQty(boardId, oc);
    const committed = await oc(`
      SELECT COALESCE(SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)),0)::int AS sheets
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE ${EFF_BOARD_ID}=$1 AND ol.status IN ('planned','ready')
        AND (ol.gang_run_id IS DISTINCT FROM $2)`, [boardId, gangId]);
    const short = Math.max(0, totalParent + committed.sheets - available);
    position = { available, committed_other: committed.sheets, needed: totalParent, short };
  }
  return { ...gang, members: withSheets, board_material_id: boardId, total_parent_sheets: totalParent, position, compat: gangCompat(withSheets) };
}

async function assertPlanningOnlyGangEdit(gangId, oc = one) {
  const job = await oc('SELECT jc_number, status FROM job_cards WHERE gang_run_id=$1 LIMIT 1', [gangId]);
  if (job) {
    throw Object.assign(
      new Error(`Gang cannot be broken after job card ${job.jc_number} is created. Reverse the job card back to Planning first.`),
      { status: 409 });
  }
  const locked = await oc(`
    SELECT p.name AS product_name, ol.status
    FROM order_lines ol JOIN products p ON p.id=ol.product_id
    WHERE ol.gang_run_id=$1 AND ol.status NOT IN ('pending','planned','ready')
    ORDER BY ol.id LIMIT 1`, [gangId]);
  if (locked) {
    throw Object.assign(
      new Error(`${locked.product_name} is already ${locked.status.replace('_', ' ')}. Gangs can be broken only in Planning.`),
      { status: 409 });
  }
}

// ── Suggestions — same board + same coating, ready to gang ─────────────────
// The whole legacy scoring engine boiled down to what a planner actually asks:
// "which of my open jobs run on the same board and coating?"
r.get('/gang-suggestions', async (_req, res, next) => {
  try {
    const lines = await q(`${MEMBER_VIEW}
      WHERE ol.status IN ('pending','planned') AND ol.gang_run_id IS NULL AND jc.id IS NULL
      ORDER BY o.delivery_date NULLS LAST, ol.id`);
    const groups = {};
    for (const l of lines) {
      const key = `${l.board_material_id}|${l.coating}`;
      (groups[key] ||= []).push(l);
    }
    res.json(Object.values(groups)
      .filter(g => g.length >= 2)
      .map(g => ({
        board_material_id: g[0].board_material_id,
        board_name: g[0].board_name,
        coating: g[0].coating,
        line_ids: g.map(m => m.id),
        lines: g.map(m => ({ id: m.id, product_name: m.product_name, po_number: m.po_number, qty: m.qty, delivery_date: m.delivery_date })),
        total_parent_sheets: g.reduce((s, m) => s + memberParentSheets(m), 0),
      }))
      .sort((a, b) => b.lines.length - a.lines.length));
  } catch (e) { next(e); }
});

// ── Create ──────────────────────────────────────────────────────────────────
r.post('/gang-runs', canPlan, async (req, res, next) => {
  try {
    const lineIds = [...new Set((req.body.line_ids || []).map(Number).filter(Boolean))];
    if (lineIds.length < 2) return res.status(400).json({ error: 'Pick at least two lines to gang together' });

    const gangId = await tx(async (qc, oc) => {
      const members = await qc(
        `${MEMBER_VIEW} WHERE ol.id = ANY($1) FOR UPDATE OF ol`, [lineIds]);
      if (members.length !== lineIds.length) throw Object.assign(new Error('One or more lines not found'), { status: 404 });

      const bad = members.find(m => !['pending', 'planned'].includes(m.status));
      if (bad) throw Object.assign(new Error(`${bad.product_name} is already ${bad.status.replace('_', ' ')} — only lines still in planning can be ganged`), { status: 409 });
      const ganged = members.find(m => m.gang_run_id);
      if (ganged) throw Object.assign(new Error(`${ganged.product_name} is already in a gang`), { status: 409 });
      const withJc = members.find(m => m.job_card_id);
      if (withJc) throw Object.assign(new Error(`${withJc.product_name} already has job card ${withJc.jc_number}`), { status: 409 });

      const gang_number = await nextNumber('CI-GANG-', 'gang_runs', 'gang_number', oc);
      const [gang] = await qc(
        'INSERT INTO gang_runs (gang_number, notes, created_by) VALUES ($1,$2,$3) RETURNING id',
        [gang_number, req.body.notes || null, req.user.name]);
      await qc('UPDATE order_lines SET gang_run_id=$1 WHERE id = ANY($2)', [gang.id, lineIds]);
      await audit('gang_run', gang.id, 'create',
        `${gang_number}: ${members.map(m => m.product_name).join(' + ')} on ${members[0].board_name}`, qc, req.user.name);
      return gang.id;
    });
    res.json(await gangDetail(gangId));
  } catch (e) { next(e); }
});

r.get('/gang-runs/:id', async (req, res, next) => {
  try { res.json(await gangDetail(+req.params.id)); } catch (e) { next(e); }
});

// ── Plan the gang as ONE job ────────────────────────────────────────────────
// The unified "Plan Gang" button: one click locks the cut plan for every
// member in a single transaction — same math as the per-line plan lock
// (effective spec, child fit, parent sheets), one shared wastage figure
// applied to each job. Spec-level tweaks still happen per line in the engine.
r.post('/gang-runs/:id/plan', canPlan, async (req, res, next) => {
  try {
    const wastage = req.body.wastage_sheets === '' || req.body.wastage_sheets == null
      ? null : Math.max(0, Math.round(+req.body.wastage_sheets));
    // Planner's manual "sheets to issue" for the whole gang. NULL → the plan
    // issues exactly what the cut math computes.
    const issueOverride = req.body.issue_parent_sheets === '' || req.body.issue_parent_sheets == null
      ? null : Math.max(0, Math.round(+req.body.issue_parent_sheets));
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      const lines = await qc(
        'SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines',
        [gang.id]);
      const locked = lines.find(l => !['pending', 'planned'].includes(l.status));
      if (locked) {
        throw Object.assign(
          new Error(`A member is already ${locked.status.replace('_', ' ')} — plan the gang while every job is still in planning`),
          { status: 409 });
      }
      // 1) Compute each member's natural cut plan (child + parent sheets).
      // The gang prints as ONE product on one press run, so the wastage is a
      // SINGLE allowance — booked to the lead member; every other member carries
      // zero so it is never multiplied by the number of products.
      const plan = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
        const eff = effectiveProduct(master, line);
        const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id]);
        const parent = effectiveParent(eff, board);
        const fit = childFit(parent, eff);
        const w_i = i === 0 ? (wastage ?? line.wastage_sheets ?? 0) : 0;
        const sheets = sheetsRequired(eff, netProduceQty(line), w_i);
        const parentSheets = parentSheetsRequired(sheets, fit.count);
        plan.push({ line, eff, fit, sheets, parentSheets, wastage: w_i });
      }
      // 2) If the planner overrode the total, distribute it across members in
      // proportion to their natural parent need (largest-remainder rounding so
      // the members' stored parent sheets sum to EXACTLY the chosen issue).
      const natural = plan.reduce((s, p) => s + p.parentSheets, 0);
      let issued = plan.map(p => p.parentSheets);
      if (issueOverride != null && natural > 0 && issueOverride !== natural) {
        const raw = plan.map(p => issueOverride * p.parentSheets / natural);
        issued = raw.map(x => Math.floor(x));
        let rem = issueOverride - issued.reduce((s, x) => s + x, 0);
        const byFrac = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
        for (let k = 0; k < byFrac.length && rem > 0; k++) { issued[byFrac[k].i]++; rem--; }
      }
      // 3) Persist.
      for (let idx = 0; idx < plan.length; idx++) {
        const { line, eff, fit, sheets, wastage: w } = plan[idx];
        const parentSheets = issued[idx];
        await qc(`UPDATE order_lines SET planned_date=COALESCE(planned_date, CURRENT_DATE::text),
                    sheets_required=$1, parent_sheets_required=$2, wastage_sheets=$3
                  WHERE id=$4`,
          [sheets, parentSheets, w, line.id]);
        if (line.status === 'pending') await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
        await audit('order_line', line.id, 'planned',
          `${sheets} child → ${parentSheets} parent (${fit.count}/parent, ${eff.ups} ups) — gang plan ${gang.gang_number}`,
          qc, req.user.name);
      }
      await qc('UPDATE gang_runs SET issue_parent_sheets=$1 WHERE id=$2', [issueOverride, gang.id]);
      const issuedTotal = issued.reduce((s, x) => s + x, 0);
      await audit('gang_run', gang.id, 'plan',
        `${gang.gang_number} planned as one job (${lines.length} members${wastage != null ? `, ${wastage} wastage sheets each` : ''})`
        + (issueOverride != null && issueOverride !== natural ? ` · issue overridden ${natural} → ${issuedTotal}` : ''),
        qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// Recompute a member's sheet requirement after its qty / ups changed — but only
// once its plan is locked (planned / ready). A still-pending line has no cut plan
// figures yet, so there is nothing to keep in sync.
async function reDeriveMemberSheets(lineId, qc, oc) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  if (!['planned', 'ready'].includes(line.status)) return;
  const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
  const eff = effectiveProduct(master, line);
  const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id]);
  const parent = effectiveParent(eff, board);
  const fit = childFit(parent, eff);
  // Gang wastage is a single allowance booked to the lead member; a non-lead
  // member never re-adds wastage of its own (keeps it counted once on edits).
  let w = line.wastage_sheets;
  if (line.gang_run_id) {
    const lead = await oc('SELECT MIN(id) AS id FROM order_lines WHERE gang_run_id=$1', [line.gang_run_id]);
    w = lead && +lead.id === +line.id ? line.wastage_sheets : 0;
  }
  const sheets = sheetsRequired(eff, netProduceQty(line), w);
  const parentSheets = parentSheetsRequired(sheets, fit.count);
  await qc('UPDATE order_lines SET sheets_required=$1, parent_sheets_required=$2 WHERE id=$3',
    [sheets, parentSheets, lineId]);
}

// ── Edit one member — total qty and/or ups, in place ────────────────────────
// The gang view's inline controls. Qty is the order quantity (guarded by what's
// already dispatched); ups is a per-job spec override. Both re-derive the cut
// plan when the member is already planned. Only while the gang is still in
// planning (no job card, nothing on the floor).
r.patch('/gang-runs/:id/lines/:lineId', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 AND gang_run_id=$2 FOR UPDATE',
        [req.params.lineId, gang.id]);
      if (!line) throw Object.assign(new Error('Line is not part of this gang'), { status: 404 });

      if (req.body.qty !== undefined && req.body.qty !== '' && req.body.qty !== null) {
        const qty = Math.round(+req.body.qty);
        if (!Number.isFinite(qty) || qty <= 0)
          throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
        if (qty < line.dispatched_qty)
          throw Object.assign(new Error(`Quantity cannot go below the ${line.dispatched_qty} already dispatched`), { status: 400 });
        if (qty !== line.qty) {
          await qc('UPDATE order_lines SET qty=$1 WHERE id=$2', [qty, line.id]);
          await audit('order_line', line.id, 'qty_edit', `${line.qty} → ${qty} (gang ${gang.gang_number})`, qc, req.user.name);
        }
      }

      // Per-product spec — the full carton spec editable from the gang engine:
      // ups + the child sheet builder (child_l/child_w) + colours/coating/finish.
      // Everything lands as a job-only spec_override, cleared when it equals the
      // master so a value pushed back to master doesn't linger as an override.
      const spec = { ...(req.body.spec || {}) };
      if (req.body.ups !== undefined) spec.ups = req.body.ups;           // legacy top-level ups
      const GANG_SPEC = { ups: 'int', child_l: 'float', child_w: 'float', colors: 'int',
        coating: 'text', emboss: 'int', leafing: 'int', leafing_colour: 'text',
        party_artwork_code: 'text', output_number: 'text', shade_card_number: 'text', shade_card_date: 'text',
        colour_type: 'text', pasting_type: 'text' };
      const provided = Object.keys(GANG_SPEC).filter(f => spec[f] !== undefined && spec[f] !== null && spec[f] !== '');
      if (provided.length) {
        const master = await oc(`SELECT ups, child_l, child_w, colors, coating, emboss, leafing, leafing_colour,
          party_artwork_code, output_number, shade_card_number, shade_card_date, colour_type, pasting_type
          FROM products WHERE id=$1`, [line.product_id]);
        const prev = line.spec_override
          ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
          : {};
        const next = { ...prev };
        const cast = (f, v) => GANG_SPEC[f] === 'int' ? Math.round(+v) : GANG_SPEC[f] === 'float' ? +v : String(v);
        for (const f of provided) {
          const v = cast(f, spec[f]);
          if ((f === 'ups' && v < 1) || ((f === 'child_l' || f === 'child_w') && v <= 0))
            throw Object.assign(new Error(`${f} must be greater than zero`), { status: 400 });
          if (String(v) === String(master[f])) delete next[f]; else next[f] = v;   // back-to-master clears
        }
        await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
          [Object.keys(next).length ? JSON.stringify(next) : null, line.id]);
        await audit('order_line', line.id, 'spec_override', `${provided.join(', ')} (gang ${gang.gang_number})`, qc, req.user.name);
      }

      await reDeriveMemberSheets(line.id, qc, oc);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── Which jobs can still join this gang ─────────────────────────────────────
// Any line still in planning, not already ganged, without a job card. The ones
// that share the gang's board + coating are flagged compatible (rendered first);
// the rest are allowed too (the planner may deliberately mix — see gangCompat).
r.get('/gang-runs/:id/addable', async (req, res, next) => {
  try {
    const gang = await one('SELECT * FROM gang_runs WHERE id=$1', [req.params.id]);
    if (!gang) return res.status(404).json({ error: 'Gang run not found' });
    const members = await q(`${MEMBER_VIEW} WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [gang.id]);
    const board = members[0]?.board_material_id ?? null;
    const coating = members[0]?.coating ?? null;
    const rows = await q(`${MEMBER_VIEW}
      WHERE ol.status IN ('pending','planned') AND ol.gang_run_id IS NULL AND jc.id IS NULL
      ORDER BY o.delivery_date NULLS LAST, ol.id`);
    res.json(rows
      .map(l => ({
        id: l.id, product_name: l.product_name, product_code: l.product_code,
        po_number: l.po_number, customer_name: l.customer_name, qty: l.qty,
        board_name: l.board_name, coating: l.coating, delivery_date: l.delivery_date,
        status: l.status,
        compatible: l.board_material_id === board && l.coating === coating,
      }))
      .sort((a, b) => (b.compatible - a.compatible)
        || String(a.delivery_date ?? '9999').localeCompare(String(b.delivery_date ?? '9999'))));
  } catch (e) { next(e); }
});

// ── Add jobs to an existing gang ────────────────────────────────────────────
r.post('/gang-runs/:id/add-lines', canPlan, async (req, res, next) => {
  try {
    const lineIds = [...new Set((req.body.line_ids || []).map(Number).filter(Boolean))];
    if (!lineIds.length) return res.status(400).json({ error: 'Pick at least one job to add' });
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      const members = await qc(`${MEMBER_VIEW} WHERE ol.id = ANY($1) FOR UPDATE OF ol`, [lineIds]);
      if (members.length !== lineIds.length) throw Object.assign(new Error('One or more lines not found'), { status: 404 });
      for (const m of members) {
        if (!['pending', 'planned'].includes(m.status))
          throw Object.assign(new Error(`${m.product_name} is already ${m.status.replace('_', ' ')} — only lines still in planning can be ganged`), { status: 409 });
        if (m.gang_run_id) throw Object.assign(new Error(`${m.product_name} is already in a gang`), { status: 409 });
        if (m.job_card_id) throw Object.assign(new Error(`${m.product_name} already has job card ${m.jc_number}`), { status: 409 });
      }
      await qc('UPDATE order_lines SET gang_run_id=$1 WHERE id = ANY($2)', [gang.id, lineIds]);
      await audit('gang_run', gang.id, 'add_lines',
        `${members.map(m => m.product_name).join(' + ')} joined ${gang.gang_number}`, qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── Finalise ONE board for the whole gang ───────────────────────────────────
// The mother board is the one thing a gang physically shares — the planner sets
// it once for the unified gang and every member is re-planned onto it (each
// product keeps its own child size / ups; only the parent board is shared). Set
// as a job-only override, cleared when it equals a member's master board.
r.post('/gang-runs/:id/board', canPlan, async (req, res, next) => {
  try {
    const boardId = Math.round(+req.body.board_material_id);
    if (!Number.isFinite(boardId) || boardId <= 0)
      return res.status(400).json({ error: 'A board is required' });
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      const board = await oc('SELECT id, name FROM materials WHERE id=$1', [boardId]);
      if (!board) throw Object.assign(new Error('Board not found'), { status: 404 });
      const lines = await qc(
        'SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines', [gang.id]);
      for (const line of lines) {
        const master = await oc('SELECT board_material_id FROM products WHERE id=$1', [line.product_id]);
        const prev = line.spec_override
          ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
          : {};
        const next = { ...prev };
        if (boardId === master.board_material_id) delete next.board_material_id; else next.board_material_id = boardId;
        await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
          [Object.keys(next).length ? JSON.stringify(next) : null, line.id]);
        await reDeriveMemberSheets(line.id, qc, oc);
      }
      await audit('gang_run', gang.id, 'set_board',
        `${gang.gang_number} — board set to ${board.name} for all ${lines.length} jobs`, qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── Lock the SHARED sheet for the gang: parent + child + coating ─────────────
// The gang all prints on one physical sheet, so the mother board (parent), the
// press/cut child size and the coating are shared — set once here they become
// the single source of truth for every member. (Pasting, embossing and other
// finishing stay per-product from each master — those happen after the gang
// splits into individual cartons at die cutting.) Any provided field is applied
// to every member's spec_override, cleared when it equals that member's master.
r.post('/gang-runs/:id/shared', canPlan, async (req, res, next) => {
  try {
    const patch = {};
    if (req.body.board_material_id != null && req.body.board_material_id !== '') patch.board_material_id = Math.round(+req.body.board_material_id);
    if (req.body.child_l != null && req.body.child_l !== '') patch.child_l = +req.body.child_l;
    if (req.body.child_w != null && req.body.child_w !== '') patch.child_w = +req.body.child_w;
    if (req.body.coating != null && req.body.coating !== '') patch.coating = String(req.body.coating);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to lock' });
    if ((patch.child_l != null && !(patch.child_l > 0)) || (patch.child_w != null && !(patch.child_w > 0)))
      return res.status(400).json({ error: 'Child size must be greater than zero' });

    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      if (patch.board_material_id) {
        const b = await oc('SELECT id FROM materials WHERE id=$1', [patch.board_material_id]);
        if (!b) throw Object.assign(new Error('Board not found'), { status: 404 });
      }
      // Master-update philosophy (same as the single planning engine): when the
      // planner chooses "update master", the shared sheet values are written to
      // each member's PRODUCT MASTER (and removed from the override) so every
      // future job inherits them; otherwise they stay a job-only spec_override.
      const updateMaster = !!req.body.update_master;
      const lines = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines', [gang.id]);
      for (const line of lines) {
        const master = await oc('SELECT board_material_id, child_l, child_w, coating FROM products WHERE id=$1', [line.product_id]);
        const prev = line.spec_override
          ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
          : {};
        const next = { ...prev };
        const masterSets = {};
        for (const [f, v] of Object.entries(patch)) {
          if (String(v) === String(master[f])) { delete next[f]; continue; }   // already the master value
          if (updateMaster) { masterSets[f] = v; delete next[f]; }             // push to master, drop override
          else next[f] = v;                                                    // job-only override
        }
        if (updateMaster && Object.keys(masterSets).length) {
          // When the board changes, keep the derived board name + grade in step.
          if (masterSets.board_material_id) {
            const nb = await oc('SELECT name FROM materials WHERE id=$1', [masterSets.board_material_id]);
            masterSets.board_name = nb?.name || null;
            masterSets.board_grade = nb?.name ? nb.name.split(' ')[0] : null;
          }
          const cols = Object.keys(masterSets);
          const sets = cols.map((cc, i) => `${cc}=$${i + 1}`).join(', ');
          await qc(`UPDATE products SET ${sets} WHERE id=$${cols.length + 1}`, [...cols.map(cc => masterSets[cc]), line.product_id]);
          await audit('product', line.product_id, 'master_update',
            `from gang ${gang.gang_number}: ${cols.join(', ')}`, qc, req.user.name);
        }
        await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
          [Object.keys(next).length ? JSON.stringify(next) : null, line.id]);
        await reDeriveMemberSheets(line.id, qc, oc);
      }
      await audit('gang_run', gang.id, updateMaster ? 'lock_sheet_master' : 'lock_sheet',
        `${gang.gang_number} shared sheet ${updateMaster ? 'saved to product masters' : 'locked'} (${Object.keys(patch).join(', ')}) for all ${lines.length} jobs`, qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── Smart Match a shared board for the gang ─────────────────────────────────
// Ranks boards that suit the gang: anchored on the first product's child size,
// sized against the gang's COMBINED child-sheet demand — so the picks that come
// back are the ones most likely to cover the whole run with least waste.
r.get('/gang-runs/:id/smart-match', async (req, res, next) => {
  try {
    const gang = await one('SELECT * FROM gang_runs WHERE id=$1', [req.params.id]);
    if (!gang) return res.status(404).json({ error: 'Gang run not found' });
    const members = await q(`${MEMBER_VIEW} WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [gang.id]);
    if (!members.length) return res.json({ matches: [], child_sheets: 0 });
    const anchor = members[0];
    const anchorId = anchor.board_material_id;
    // Combined child sheets across every member (locked figure, else a live estimate).
    const childSheets = members.reduce((s, m) =>
      s + (m.sheets_required ?? sheetsRequired({ ups: m.ups, wastage_pct: m.wastage_pct }, netProduceQty(m), m.wastage_sheets)), 0);

    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available, COALESCE(cm.q,0) AS committed,
             COALESCE(src.name, m.name) AS match_name, COALESCE(src.spec, m.spec) AS match_spec
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      LEFT JOIN (SELECT ${EFF_BOARD_ID} AS mid,
                        SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)) AS q
                 FROM order_lines ol JOIN products p ON p.id=ol.product_id
                 WHERE ol.status IN ('planned','ready') AND ol.gang_run_id IS DISTINCT FROM $1 GROUP BY 1) cm ON cm.mid=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND (COALESCE(av.q,0) > 0 OR m.id = $2)`,
      [gang.id, anchorId]);
    const currentBoard = candidates.find(c => c.id === anchorId) || await one('SELECT * FROM materials WHERE id=$1', [anchorId]);
    const matches = rankBoardMatches({
      product: { child_l: anchor.child_l, child_w: anchor.child_w, gsm: anchor.gsm },
      childSheets, currentBoard, candidates,
    });
    res.json({ child_sheets: childSheets, anchor_board_id: anchorId, matches: matches.slice(0, 8) });
  } catch (e) { next(e); }
});

// ── Reverse the whole gang's plan back to "To Plan" ─────────────────────────
// Un-locks every member (clears the cut-plan figures, artwork locks and any
// unstarted job card) but KEEPS the gang together — the planner reopens the
// engine and re-plans. Blocked once anything has started on the floor.
r.post('/gang-runs/:id/reverse', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      // Gang-level job card? Block if any stage has started.
      const parentJc = await oc('SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL', [gang.id]);
      if (parentJc) {
        const started = await oc(`SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND status != 'pending'`, [parentJc.id]);
        if (started.n > 0) throw Object.assign(new Error(`Cannot reverse — ${parentJc.jc_number} has already started on the floor`), { status: 409 });
        await qc('DELETE FROM job_stages WHERE job_card_id=$1', [parentJc.id]);
        await qc('DELETE FROM job_cards WHERE id=$1', [parentJc.id]);
        await audit('job_card', parentJc.id, 'reversed_before_start', `Removed while reversing gang ${gang.gang_number}`, qc, req.user.name);
      }
      const lines = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines', [gang.id]);
      let n = 0;
      for (const line of lines) {
        if (!['planned', 'ready'].includes(line.status)) continue;
        await qc(`UPDATE order_lines
                    SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL,
                        artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0
                  WHERE id=$1`, [line.id]);
        await forceLineStatus(line.id, 'pending', `Gang ${gang.gang_number} plan reversed`, qc, oc, req.user.name);
        n++;
      }
      await audit('gang_run', gang.id, 'reverse', `${gang.gang_number} plan reversed — ${n} jobs back to To Plan (gang kept)`, qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── Remove one line / dissolve ──────────────────────────────────────────────
// A gang needs two jobs — removing the second-last member dissolves it.
r.post('/gang-runs/:id/remove-line', canPlan, async (req, res, next) => {
  try {
    const result = await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      const line = await oc('SELECT * FROM order_lines WHERE id=$1 AND gang_run_id=$2', [req.body.line_id, gang.id]);
      if (!line) throw Object.assign(new Error('Line is not part of this gang'), { status: 404 });
      await qc('UPDATE order_lines SET gang_run_id=NULL WHERE id=$1', [line.id]);
      await audit('gang_run', gang.id, 'remove_line', `line ${line.id}`, qc, req.user.name);
      const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [gang.id]);
      if (left.n < 2) {
        await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [gang.id]);
        await qc('DELETE FROM gang_runs WHERE id=$1', [gang.id]);
        await audit('gang_run', gang.id, 'dissolve', `${gang.gang_number} — fewer than 2 jobs left`, qc, req.user.name);
        return { dissolved: true };
      }
      return { dissolved: false };
    });
    if (result.dissolved) return res.json({ ok: true, dissolved: true });
    res.json({ ...(await gangDetail(+req.params.id)), dissolved: false });
  } catch (e) { next(e); }
});

r.delete('/gang-runs/:id', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      await qc('UPDATE order_lines SET gang_run_id=NULL WHERE gang_run_id=$1', [gang.id]);
      await qc('DELETE FROM gang_runs WHERE id=$1', [gang.id]);
      await audit('gang_run', gang.id, 'dissolve', gang.gang_number, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Procurement patch — ONE requisition for the whole gang's shortage ──────
// Instead of each job raising its own PR for the same board, the gang buys
// its combined shortfall in a single line to the vendor.
r.post('/gang-runs/:id/raise-pr', canPlan, async (req, res, next) => {
  try {
    const detail = await gangDetail(+req.params.id);
    if (!detail.position || detail.position.short <= 0) {
      return res.status(400).json({ error: 'No board shortage for this gang' });
    }
    const boardRow = await one('SELECT leftover, name FROM materials WHERE id=$1', [detail.board_material_id]);
    if (boardRow?.leftover)
      return res.status(409).json({ error: `${boardRow.name} is a leftover offcut — a gang cannot raise a PR against it. Re-anchor the gang on a fresh board.` });
    const neededBy = detail.members.map(m => m.delivery_date).filter(Boolean).sort()[0] || null;
    const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number');
    const [pr] = await q(
      `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [pr_number, detail.board_material_id, detail.position.short, neededBy,
       `Combined shortage for gang ${detail.gang_number} (${detail.members.length} jobs on ${detail.members[0].board_name})`]);
    await audit('requisition', pr.id, 'create_from_gang', `${pr_number} for ${detail.gang_number}`, q, req.user.name);
    res.json(pr);
  } catch (e) { next(e); }
});

export default r;
