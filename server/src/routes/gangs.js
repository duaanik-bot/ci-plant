// Gang printing — several order lines that share a press run.
// Distilled from CI-Production's mix-set/gang engine into one simple rule set:
// Compatibility is advisory. The planner can bind any number of jobs; the
// resulting gang travels as one physical parent card until die cutting and
// splits back into product-specific child cards for sorting → pasting → QC.
import { Router } from 'express';
import { q, one, tx } from '../db.js';
import {
  audit, clearMixPlan, mixFor, replaceMixPlan, nextNumber, sheetsRequired, netProduceQty,
  availableQty, memberParentSheets,
  effectiveProduct, effectiveParent, childFit, parentSheetsRequired, setLineStatus, forceLineStatus,
  EFF_BOARD_ID, boardClaimLines, reverseChainPreview, unwindJobCardOffFloor,
  readiness, chosenCutsValid, chosenStrips, bankRunLeftover, unbankRunLeftover,
} from '../helpers.js';
import { mixBalance, rowCovers, substitutionFlags, DEFAULT_MIX_REASON } from '../board-mix.js';
import { splitMixAcrossMembers, splitScaledMixAcrossMembers, runMixFromMembers, pressingOnPlanned } from '../gang-mix.js';
import { rankBoardMatches } from '../smartmatch.js';
import { gangSuggestions } from '../gang-suggest.js';
import { gangPosition, claimsByBoard } from '../board-allocation.js';
import { mergeCompat, mergeShares, membersAtRisk } from '../merge-rules.js';
import { sharedLayoutRun, splitProportional, agreedChildSize } from '../shared-layout.js';
import { syncPrAllocation } from './procurement.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';

const r = Router();
const canPlan = requireRole(...PLANNING_ROLES);

// Effective spec — job-only overrides win over the product master (same
// expression the planning views use).
const MEMBER_VIEW = `
  SELECT ol.id, ol.order_id, ol.qty, ol.status, ol.gang_run_id,
         ol.sheets_required, ol.parent_sheets_required, ol.fg_consumed_qty,
         ol.wastage_sheets, ol.spec_override, ol.stock_booking,
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
         COALESCE(ol.spec_override->>'print_process', p.print_process) AS print_process,
         COALESCE((ol.spec_override->>'cmyk_colours')::int, p.cmyk_colours) AS cmyk_colours,
         COALESCE((ol.spec_override->>'pantone_colours')::int, p.pantone_colours) AS pantone_colours,
         COALESCE(ol.spec_override->>'pantone_codes', p.pantone_codes) AS pantone_codes,
         COALESCE((ol.spec_override->>'metallic_colours')::int, p.metallic_colours) AS metallic_colours,
         COALESCE(ol.spec_override->>'metallic_details', p.metallic_details) AS metallic_details,
         COALESCE(ol.spec_override->>'pasting_type', p.pasting_type) AS pasting_type,
         p.gsm AS master_gsm, p.size AS carton_size, p.internal_carton_code,
         COALESCE(ol.spec_override->>'die_number', NULLIF(p.die_number,''), dtool.code) AS die_number,
         COALESCE(ol.spec_override->>'block_number', NULLIF(p.block_number,''),
                  (SELECT t.code FROM tools t WHERE t.product_id=p.id AND t.family='block' AND t.active=1 ORDER BY t.id LIMIT 1)) AS block_number,
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

// Parent sheets a member still needs — helpers.js owns the rule, because the
// unlocked-plan fallbacks have to convert child sheets to parent ones and
// getting that wrong buys the board in the wrong unit.

// Run numbers, minted PER PREFIX. gang_runs now carries two series in one
// UNIQUE column (CI-GANG- and CI-MRG-), and the generic nextNumber reads the
// newest ROW's suffix regardless of prefix — so once the series interleave it
// re-mints a number the other prefix already holds (converting a second gang
// read "…GANG-0012" off the newest row and minted CI-MRG-0013, which existed).
// Scanning the prefix's own MAX is immune to interleaving and to renumbering.
async function nextRunNumber(prefix, oc) {
  const row = await oc(
    `SELECT COALESCE(MAX((substring(gang_number FROM '\\d+$'))::int), 0) AS n
     FROM gang_runs WHERE gang_number LIKE $1`, [`${prefix}%`]);
  return `${prefix}${String((+row?.n || 0) + 1).padStart(4, '0')}`;
}

// THE DIE MEMORY. A fixed die is a PRODUCT COMBINATION the plant has run
// before: the recognition key is the sorted product-id set. When a planner
// gangs a known combination the remembered layout (child size + per-product
// ups) is applied automatically; when a NEW combination's layout is locked at
// plan, it is remembered for next time. No buttons, no modes to choose — the
// system learns case by case, and everything stays editable.
const dieFingerprint = productIds => [...new Set(productIds.map(Number))].sort((a, b) => a - b).join('-');

// Find the remembered die for a product set — by fingerprint, or by slot-set
// for templates created before fingerprints existed (adopting them in place so
// the next lookup is direct).
async function findDieTemplate(productIds, qc, oc) {
  const fp = dieFingerprint(productIds);
  let tpl = await oc(`SELECT * FROM gang_templates WHERE active=1 AND fingerprint=$1`, [fp]);
  if (!tpl) {
    const candidates = await qc(`
      SELECT t.id FROM gang_templates t
      WHERE t.active=1 AND t.fingerprint IS NULL
        AND NOT EXISTS (SELECT 1 FROM gang_template_slots s WHERE s.template_id=t.id AND NOT (s.product_id = ANY($1)))
        AND (SELECT COUNT(*) FROM gang_template_slots s WHERE s.template_id=t.id) = $2`,
      [productIds.map(Number), new Set(productIds.map(Number)).size]);
    if (candidates.length === 1) {
      await qc(`UPDATE gang_templates SET fingerprint=$1 WHERE id=$2`, [fp, candidates[0].id]);
      tpl = await oc(`SELECT * FROM gang_templates WHERE id=$1`, [candidates[0].id]);
    }
  }
  if (!tpl) return null;
  const slots = await qc(`
    SELECT s.product_id, s.ups, p.code AS product_code FROM gang_template_slots s
    JOIN products p ON p.id = s.product_id WHERE s.template_id=$1`, [tpl.id]);
  return { ...tpl, slots };
}

// Remember (or refresh) a die once its layout is LOCKED at plan — the moment
// the plant has actually decided it. Manual names survive; auto names are the
// product codes. Case-to-case flexibility: the LATEST locked layout wins.
async function rememberDie(gang, lines, effs, child, qc, oc, user) {
  const fp = dieFingerprint(lines.map(l => l.product_id));
  const existing = await findDieTemplate(lines.map(l => l.product_id), qc, oc);
  if (existing) {
    await qc(`UPDATE gang_templates SET child_l=$1, child_w=$2, last_gang_number=$3, updated_at=now() WHERE id=$4`,
      [child.l, child.w, gang.gang_number, existing.id]);
    await qc(`DELETE FROM gang_template_slots WHERE template_id=$1`, [existing.id]);
    for (let i = 0; i < lines.length; i++) {
      await qc(`INSERT INTO gang_template_slots (template_id, product_id, ups) VALUES ($1,$2,$3)`,
        [existing.id, lines[i].product_id, effs[i].ups]);
    }
    await audit('gang_template', existing.id, 'die_refreshed',
      `${existing.name}: ${child.l}×${child.w}" · ups ${effs.map(e2 => e2.ups).join('+')} — from ${gang.gang_number}`, qc, user);
    return existing.id;
  }
  const codes = await qc(`SELECT code FROM products WHERE id = ANY($1) ORDER BY code`, [lines.map(l => l.product_id)]);
  const name = codes.map(c2 => c2.code).join(' + ');
  const [row] = await qc(`
    INSERT INTO gang_templates (name, child_l, child_w, fingerprint, last_gang_number, updated_at, created_by, notes)
    VALUES ($1,$2,$3,$4,$5,now(),$6,'learned from planning') RETURNING id`,
    [name, child.l, child.w, fp, gang.gang_number, user]);
  for (let i = 0; i < lines.length; i++) {
    await qc(`INSERT INTO gang_template_slots (template_id, product_id, ups) VALUES ($1,$2,$3)`,
      [row.id, lines[i].product_id, effs[i].ups]);
  }
  await audit('gang_template', row.id, 'die_learned',
    `${name}: ${child.l}×${child.w}" · ups ${effs.map(e2 => e2.ups).join('+')} — first locked on ${gang.gang_number}`, qc, user);
  return row.id;
}

// LAYOUT PENDING — derived, never stored. A SHARED-layout gang plans on ONE
// child sheet that the designer settles; until the planner enters it (the Run
// Sheet lock writes child_l/child_w into every member's spec_override), the
// gang reads Layout Pending. The rule reads the OVERRIDES, not the effective
// values: a master's child size is some other product's own sheet, never this
// layout's — only an explicit entry counts.
//
// Pending is a REFUSAL only when there is nothing true to plan on. When every
// member already agrees on one child size through its effective spec, the plan
// lock adopts that agreement as the layout (agreedChildSize) and stamps it —
// "save and lock" in one click, the hard block Anik asked off (2026-08-04).
function sharedLayoutState(gang, members) {
  if (gang.layout_mode !== 'shared') return { pending: false, child: null };
  const overrides = members.map(m => {
    const o = m.spec_override
      ? (typeof m.spec_override === 'string' ? JSON.parse(m.spec_override) : m.spec_override)
      : {};
    return { l: +o.child_l || 0, w: +o.child_w || 0 };
  });
  if (overrides.some(o => !(o.l > 0) || !(o.w > 0))) {
    return { pending: true, reason: 'Final child sheet size not entered yet — the layout decides it', child: null };
  }
  const uniq = [...new Set(overrides.map(o => `${o.l}x${o.w}`))];
  if (uniq.length > 1) {
    return { pending: true, reason: `Members carry different child sizes (${uniq.join(' vs ')}) — a shared layout is ONE sheet`, child: null };
  }
  return { pending: false, child: { l: overrides[0].l, w: overrides[0].w } };
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
// The run's board mix context — the same shape orders.js builds for a single
// line, asked of the RUN. Everything the planner's Board Mix panel needs:
// which board the run is planned on, how many cuts it yields, every same-grade
// board that could join it, the lots behind them, and the mix already saved.
//
// A candidate must be a valid substitute for EVERY member, not just the lead.
// The run is one press run drawing off one pile, so a board that cuts the right
// number for two members and the wrong number for the third is not a substitute
// for this run at all — offering it would only produce a save the plan route
// then refuses, member by member, in an order the planner cannot see.
//
// Per-member ups are computed exactly as the /plan route computes them
// (effectiveProduct → effectiveParent → childFit, off the product MASTER, not
// the member view) so the panel and the gate can never quote a different cut for
// the same run.
async function gangMixContext(gang, members, boardId, oc, qc) {
  if (!boardId || !members.length) return null;
  const board = await oc('SELECT * FROM materials WHERE id=$1', [boardId]);
  if (!board) return null;
  const isMerge = gang?.kind === 'merge';

  const effs = [];
  for (const m of members) {
    const master = await oc('SELECT * FROM products WHERE id=$1', [m.product_id]);
    const eff = effectiveProduct(master, m);
    const plannedFit = childFit(effectiveParent(eff, board), eff);
    effs.push({ member: m, eff, plannedFit, plannedUps: plannedFit.count });
  }
  // The panel quotes ONE cuts figure, and a 'separate'-layout gang can hold
  // members whose own child sheets cut differently off the same parent. The
  // lead member's is the run's — the same member the run's wastage and its
  // audit line already speak for — and every candidate below is still checked
  // against each member's own, so a difference narrows the list rather than
  // going unnoticed.
  const plannedUps = effs[0].plannedUps;

  const candidateRows = await qc(`
    SELECT m.*, COALESCE(av.q,0) AS available
    FROM materials m
    LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
               WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
    WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
      AND COALESCE(av.q,0) > 0 AND m.id != $1`, [boardId]);
  const candidates = candidateRows.map(c => {
    // Judged against every member, and the WORST answer wins. Own native sheet
    // size, never effectiveParent — same reasoning as orders.js's mix block.
    // The LEAD member's whole fit rides along (waste_pct / utilization): the
    // panel quotes one cuts figure — the lead's — so the waste in its label
    // and the least-trim ordering below speak for that same member.
    const per = effs.map(e => ({
      fit: childFit(c, e.eff), plannedUps: e.plannedUps }));
    const flags = per.map(p => substitutionFlags({
      plannedBoard: { id: boardId, name: board.name },
      candidateBoard: c, plannedUps: p.plannedUps, candidateUps: p.fit.count }));
    const ok = flags.every(f => f.ok);
    // ONE member cutting a different number is enough to disqualify the board
    // for the whole run — the run draws every member's sheets off one pile.
    const upsDiffer = flags.some(f => f.ups_differ);
    const worst = flags.find(f => !f.ok) ?? flags.find(f => f.severity === 'heavy') ?? flags[0];
    // max_cuts is the board's own natural ceiling off the LEAD member — the
    // same fit.count `ups` quotes — named separately (mirroring orders.js's
    // mixCandidates) so the client's editable Cuts input keeps its cap once
    // `ups` becomes the chosen value. Only a merge run edits cuts, but the
    // field is harmless data for a gang, whose panel renders cuts read-only.
    return { ...c, ups: per[0].fit.count, max_cuts: per[0].fit.count,
      waste_pct: per[0].fit.waste_pct,
      utilization: per[0].fit.utilization, ...worst, ok, ups_differ: upsDiffer };
  // A MERGE run offers differing-cuts boards exactly as a single line does
  // (the ups_differ 409 is repealed for it in the /plan mix block below —
  // covers convert by the cuts ratio). A GANG keeps the exclusion: its cuts
  // are per member and derived, so a board that cuts any member differently
  // still cannot join, byte-identical to before.
  }).filter(c => c.ok && (isMerge || !c.ups_differ))
    .sort((a, b) => {
      // LEAST TRIM FIRST, GSM closeness as the tie-break — the same ordering
      // orders.js gives a single line (see its mixCandidates sort), so the
      // run's "+ Add board" suggests by the same rule a solo job would get.
      const wa = a.waste_pct ?? Infinity;
      const wb = b.waste_pct ?? Infinity;
      if (wa !== wb) return wa - wb;
      return Math.abs(a.gsm_delta) - Math.abs(b.gsm_delta);
    });

  const lots = await qc(`
    SELECT id, material_id, batch_no, qty FROM stock_batches
    WHERE material_id = ANY($1) AND status='available' AND qty > 0
    ORDER BY created_at, id`, [[boardId, ...candidates.map(c => c.id)]]);

  // The saved mix, re-added out of the members it was split across so the
  // planner reopens the two rows they typed, not one per member per board.
  const memberRows = [];
  for (const m of members) memberRows.push(...await mixFor(m.id, 'plan', qc));
  const rows = runMixFromMembers(memberRows);
  // What the run's mix actually covers, summed off the members' own stored
  // `covers` rather than re-derived from sheets — those are the numbers the
  // release gate reads line by line, so Board Position cannot disagree with it.
  const covered = memberRows.reduce((s, r) => s + Number(r.covers || 0), 0);
  const heldOnPlanned = memberRows
    .filter(r => r.material_id === boardId)
    .reduce((s, r) => s + Number(r.sheets || 0), 0);
  if (rows.length) {
    const avail = await qc(`
      SELECT m.id, COALESCE(av.q, 0)::float AS available
        FROM materials m
        LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                   WHERE status='available' GROUP BY material_id) av ON av.material_id = m.id
       WHERE m.id = ANY($1)`, [[...new Set(rows.map(r => r.material_id))]]);
    const byId = new Map(avail.map(a => [a.id, Number(a.available)]));
    for (const r of rows) r.available = byId.get(r.material_id) ?? 0;
  }

  // Live run-level leftover batches — the RECORD of what the last merge lock
  // banked (there is deliberately no JSON column on gang_runs for this; the
  // batches themselves are the truth, exactly as the warehouse reads them).
  // The client seeds its per-row bank toggles from this list. material_id here
  // is the SOURCE board's — parsed back out of the batch key, because the
  // batch row itself carries the minted leftover MASTER's id, which is not
  // the id the mix rows (or the toggles) are keyed on.
  let leftoverBatches = [];
  if (isMerge) {
    const prefix = `LO-PLAN-RUN-${gang.id}-`;
    // initial_qty > 0 OR qty > 0 keeps a bank alive while another job draws
    // it down, yet drops a SWEPT row (unbankRunLeftover zeroes both) — a
    // strip the planner sent to waste must not seed its toggle back ON.
    leftoverBatches = (await qc(
      `SELECT batch_no, qty FROM stock_batches
        WHERE batch_no LIKE $1 AND (initial_qty > 0 OR qty > 0) ORDER BY id`,
      [`${prefix}%`]))
      .map(b => ({ material_id: Number(String(b.batch_no).slice(prefix.length)), qty: Number(b.qty) }))
      .filter(b => Number.isFinite(b.material_id));
  }

  return {
    planned_board_id: boardId,
    planned_board_name: board.name,
    planned_ups: plannedUps,
    // The planned board's own trim, in the same units the substitutes quote —
    // the list is ordered by waste and an option with no figure reads as
    // missing data rather than as the plan. Lead member's, like planned_ups.
    planned_waste_pct: effs[0].plannedFit.waste_pct,
    // The exact parent the planned fit above was measured on — effectiveParent
    // folds a finalised parent_l/parent_w trim over the board's mother sheet
    // (the same asymmetry orders.js's planning context documents), and the
    // client's strip preview for the PLANNED row must run this geometry, not
    // the raw sheet, or the chip promises a strip the lock would bank
    // differently. Lead member's, like everything above.
    planned_parent_l: effectiveParent(effs[0].eff, board).sheet_l ?? null,
    planned_parent_w: effectiveParent(effs[0].eff, board).sheet_w ?? null,
    candidates,
    lots,
    rows,
    active: rows.length > 0,
    covered,
    held_on_planned: heldOnPlanned,
    leftover_batches: leftoverBatches,
  };
}

// A line can arrive carrying a board mix from being planned SOLO: plan-save
// refuses a NEW mix on a ganged line, and the run's own plan lock clears and
// rewrites every member, but between joining and that first lock the stale
// rows sit keyed to a line whose board is no longer its own affair. That
// window is real — a solo-planned line joins as 'planned', and a card can be
// pushed from 'planned' without the run ever re-locking. The floor draws a
// run's board as ONE pile, so a leftover private mix would never be consumed
// nor released and its mirrored hold would overstate that board's committed
// stock indefinitely. Clear it at the door, with the run's name on the
// timeline; clearMixPlan is a cheap no-op for the ordinary unmixed line.
// (Once inside, member mixes are written only by the run's plan lock — the
// waterfall split of the RUN's own mix, gang-mix.js — which is why the merge
// card creation no longer clears them.)
async function clearJoinersMix(lineIds, runNumber, qc, user) {
  for (const id of lineIds) {
    await clearMixPlan(id, qc, user, `joined ${runNumber} — the run plans its board as one pile`);
  }
}

export async function gangDetail(gangId, oc = one, qc = q) {
  const gang = await oc('SELECT * FROM gang_runs WHERE id=$1', [gangId]);
  if (!gang) { const e = new Error('Gang run not found'); e.status = 404; throw e; }
  const members = await qc(`${MEMBER_VIEW} WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [gangId]);
  const withSheets = members.map(m => ({ ...m, parent_sheets: memberParentSheets(m) }));
  const boardId = withSheets[0]?.board_material_id ?? null;
  const totalParent = withSheets.reduce((s, m) => s + m.parent_sheets, 0);
  const mix = await gangMixContext(gang, withSheets, boardId, oc, qc);

  let position = null;
  let openPrs = [];
  let otherPrs = [];
  if (boardId) {
    const available = await availableQty(boardId, oc);
    const memberIds = withSheets.map(m => m.id);
    // Committed-other comes off the SAME arithmetic as the planning engine,
    // Smart Match and the Board panel — claimsByBoard over boardClaimLines —
    // not a hand-rolled SUM. That nets drawn lines (their sheets already left
    // the shelf) and fences rival fresh_pr plans to their own incoming PRs.
    // Board already ON ORDER for any member is coverage for the run. Without
    // this the gang's "Short" is identical before and after a successful raise,
    // which is exactly how CI-GANG-0007 collected four full-size PRs.
    const [allocations, otherLines] = await Promise.all([
      qc(`SELECT * FROM board_allocations WHERE material_id=$1 AND status='active'`, [boardId]),
      boardClaimLines([boardId], memberIds, qc),
    ]);
    const committedOther = claimsByBoard({ lines: otherLines, allocations }).get(boardId)?.committed || 0;
    // What the run actually presses on its PLANNED board. Without a mix that
    // is the whole requirement, and this reads exactly as it always did.
    //
    // With a mix it is the sheets written against the planned board plus
    // whatever the mix has NOT covered — the same rule board-mix.js's
    // mixPosition applies line by line: a substitute board is never "needed"
    // beyond what is explicitly written against it, and only the planned board
    // carries the unmet remainder. Without this a run covered off a second
    // board still reads "Short — cutting waits for stock" and offers a PR for
    // board the planner has just finished sourcing, which is the whole reason
    // they opened the mix.
    const neededOnPlanned = pressingOnPlanned({
      required: totalParent, active: !!mix?.active,
      covered: mix?.covered, heldOnPlanned: mix?.held_on_planned });
    position = gangPosition({
      needed: neededOnPlanned, committedOther, available,
      allocations, memberIds, materialId: boardId,
      stockBooking: gang.stock_booking || 'book',
    });
    openPrs = memberIds.length ? await qc(`
      SELECT DISTINCT r.id, r.pr_number, r.qty, r.status, r.needed_by, r.created_at
      FROM requisitions r JOIN board_allocations ba ON ba.requisition_id=r.id
      WHERE r.material_id=$1 AND r.status IN ('pending','approved')
        AND ba.status='active' AND ba.order_line_id = ANY($2::int[])
      ORDER BY r.id`, [boardId, memberIds]) : [];
    // Other jobs' open PRs on this board — never a blocker (the run's own
    // guard reads open_prs above), purely the "already under PR · N incoming"
    // information the planner sees beside the run's position.
    const ownPrIds = new Set(openPrs.map(p => p.id));
    otherPrs = (await qc(`
      SELECT pr.id, pr.pr_number, pr.qty, pr.status, pr.needed_by,
             pp.name AS product_name, pp.code AS product_code, gr.gang_number
      FROM requisitions pr
      LEFT JOIN order_lines olr ON olr.id = pr.order_line_id
      LEFT JOIN products pp ON pp.id = olr.product_id
      LEFT JOIN gang_runs gr ON gr.id = olr.gang_run_id
      WHERE pr.material_id=$1 AND pr.status IN ('pending','approved')
      ORDER BY pr.id`, [boardId])).filter(p => !ownPrIds.has(p.id));
  }
  // A COMBINED RUN judges itself by merge rules (real conflicts — one product,
  // one board, one layout) and carries the dispatch forecast: how the pile
  // will divide across its sales orders, earliest delivery first, and who
  // cannot be filled from what has been produced so far.
  if (gang.kind === 'merge') {
    const producedRow = await oc(`
      SELECT jc.id, jc.jc_number, COALESCE(jc.qty_produced, 0)::int AS produced
      FROM job_cards jc
      WHERE jc.gang_run_id=$1 AND jc.parent_job_card_id IS NULL
      ORDER BY jc.id DESC LIMIT 1`, [gangId]);
    const produced = producedRow?.produced || 0;
    // Judge the members as the run's OWN: membership of this very run is not
    // "already in a run", and a member past planning is the run working, not a
    // conflict. What must keep holding for an existing run is the physical
    // identity — one product, one board, one layout.
    const compat = mergeCompat(withSheets.map(m => ({
      ...m,
      gang_run_id: m.gang_run_id === gang.id ? null : m.gang_run_id,
      status: ['pending', 'planned'].includes(m.status) ? m.status : 'planned',
    })));
    return {
      ...gang, members: withSheets, board_material_id: boardId,
      total_parent_sheets: totalParent, position, open_prs: openPrs, mix,
      compat,
      shares: mergeShares(withSheets, produced),
      // Before anything is produced, "everyone is short" is noise, not news —
      // the at-risk list only speaks once QC has accepted a real quantity.
      at_risk: produced > 0 ? membersAtRisk(withSheets, produced) : [],
      produced,
      // A combined run's card hangs off the RUN, not a line (order_line_id is
      // NULL), so no member carries its number — the run has to name it, or
      // the sheet-lock dialog cannot say whose card it is about to re-stamp.
      job_card: producedRow ? { id: producedRow.id, jc_number: producedRow.jc_number } : null,
    };
  }
  // A SHARED-layout gang carries its layout picture: pending state, total ups
  // and (once the size is in) the run preview — MAX sheets, per-member overs —
  // so the engine can show the planner exactly what the co-printed run does.
  if (gang.layout_mode === 'shared') {
    const layout = sharedLayoutState(gang, withSheets);
    const die = await findDieTemplate(withSheets.map(m => m.product_id), q, oc).catch(() => null);
    let layoutRun = null;
    if (!layout.pending) {
      try {
        layoutRun = sharedLayoutRun(
          withSheets.map(m => ({ id: m.id, net: netProduceQty(m), ups: m.ups })),
          { wastage: withSheets[0]?.wastage_sheets ?? 0 });
      } catch { layoutRun = null; }
    }
    return {
      ...gang, members: withSheets, board_material_id: boardId,
      total_parent_sheets: totalParent, position, open_prs: openPrs, other_prs: otherPrs, mix,
      compat: gangCompat(withSheets),
      layout_pending: layout.pending, layout_reason: layout.reason || null,
      // While pending, the size the plan lock would adopt (members' effective
      // specs all agreeing) — null when nothing agrees, which keeps the lock
      // button dead and the banner hard. The engine speaks from this.
      layout_fallback_child: layout.pending
        ? agreedChildSize(withSheets.map(m => ({ l: m.child_l, w: m.child_w })))
        : null,
      layout_child: layout.child, layout_run: layoutRun,
      total_ups: withSheets.reduce((s2, m) => s2 + (+m.ups || 0), 0),
      die_memory: die ? {
        name: die.name, child_l: die.child_l, child_w: die.child_w,
        last_gang_number: die.last_gang_number, updated_at: die.updated_at,
        ups: die.slots.map(sl => ({ product_id: sl.product_id, product_code: sl.product_code, ups: sl.ups })),
      } : null,
    };
  }
  return { ...gang, members: withSheets, board_material_id: boardId, total_parent_sheets: totalParent, position, open_prs: openPrs, other_prs: otherPrs, mix, compat: gangCompat(withSheets) };
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

// LOCKING A SHEET IS NOT BREAKING A RUN. assertPlanningOnlyGangEdit guards the
// edits that move membership or quantity, and it was guarding the shared-sheet
// lock too — so a COMBINED RUN whose card had been minted on the wrong board,
// child size or coating could not be corrected at all: the only way out was to
// reverse a whole job card off the floor to change a varnish. That is the
// blocker talking about the wrong thing ("Gang cannot be broken" over a dialog
// that breaks nothing, on a CI-MRG- that is not a gang).
//
// A combined run is the safe case, and the reason is structural: one product,
// one pile, no split at die cutting. Nothing about WHO is in the run or HOW
// MANY moves — only the sheet it prints on, which is exactly what the planner
// came here to fix. So the sheet stays correctable for as long as it is still
// only paperwork.
//
// What still refuses is PHYSICS, in the vocabulary /convert-to-merge already
// uses: a stage that has started, or board already drawn. Those are facts on
// the floor, and the sheet under a running press is not a form field. A GANG
// (CI-GANG-) is untouched — it splits into child cards, so its sheet is load-
// bearing for a route this function cannot see, and it keeps the old rule.
//
// Returns the live card when one exists and the edit may proceed against it —
// the caller needs it to keep the card's own sheet figures in step.
export async function assertSheetEditable(gang, oc = one) {
  if (gang.kind !== 'merge') return null;
  const card = await oc(
    'SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL', [gang.id]);
  if (!card) return null;                       // still planning — the ordinary rule applies
  const started = await oc(
    `SELECT stage FROM job_stages WHERE job_card_id=$1 AND status <> 'pending' LIMIT 1`, [card.id]);
  if (started) {
    throw Object.assign(new Error(
      `${card.jc_number} has already started ${started.stage.replace('_', ' ')} — the sheet cannot change under a run in motion. Reverse the job card back to Planning first.`),
    { status: 409 });
  }
  const consumed = await oc(
    `SELECT 1 AS x FROM stock_movements WHERE ref_type='job_card' AND ref_id=$1 AND type='consumption' LIMIT 1`,
    [card.id]);
  if (consumed) {
    throw Object.assign(new Error(
      `Board has already been issued to ${card.jc_number} — the sheet cannot change under issued board. Reverse the job card back to Planning first.`),
    { status: 409 });
  }
  return card;
}

// ── Suggestions — ready-to-gang jobs, on two axes ───────────────────────────
// The whole legacy scoring engine boiled down to the two questions a planner
// actually asks: "which of my open jobs run on the same board and coating?"
// (one press run) and "which of my open jobs are the same carton?" (one die
// layout, whatever the board). gang-suggest.js holds both rules.
r.get('/gang-suggestions', async (_req, res, next) => {
  try {
    const lines = await q(`${MEMBER_VIEW}
      WHERE ol.status IN ('pending','planned') AND ol.gang_run_id IS NULL AND jc.id IS NULL
      ORDER BY o.delivery_date NULLS LAST, ol.id`);
    res.json(gangSuggestions(lines, { parentSheets: memberParentSheets }));
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

      // ONE CARTON IS NEVER A GANG. Repeat orders of the same product are a
      // COMBINED RUN — one pile, no split — and a gang of them would run
      // sorting, pasting and QC once per sales order over an identical stack.
      // The client already routes the selection, but the rule belongs HERE:
      // any caller (an older client, a script, a direct POST) that asks to gang
      // one carton gets the right thing instead of a run that has to be
      // converted later. This is why legacy same-product gangs existed at all.
      if (new Set(members.map(m => m.product_id)).size === 1) {
        const verdict = mergeCompat(members);
        if (verdict.ok) {
          const run_number = await nextRunNumber('CI-MRG-', oc);
          const [run] = await qc(
            `INSERT INTO gang_runs (gang_number, kind, product_id, notes, created_by)
             VALUES ($1,'merge',$2,$3,$4) RETURNING id`,
            [run_number, members[0].product_id, req.body.notes || null, req.user.name]);
          await qc(`UPDATE order_lines SET gang_run_id=$1,
             stock_booking=COALESCE((SELECT g2.stock_booking FROM gang_runs g2 WHERE g2.id=$1), 'book')
           WHERE id = ANY($2)`, [run.id, lineIds]);
          await clearJoinersMix(lineIds, run_number, qc, req.user.name);
          await audit('gang_run', run.id, 'create_merge',
            `${run_number}: ${members[0].product_name} × ${members.length} sales orders — asked as a gang, created as a combined run (one carton is never a gang)`,
            qc, req.user.name);
          return run.id;
        }
      }

      const gang_number = await nextRunNumber('CI-GANG-', oc);
      // NO mode popup — the system understands the case. Every new gang is a
      // co-printed layout ('shared'): if the DIE MEMORY knows this product
      // combination, its layout is applied on the spot; if not, the gang
      // starts Layout Pending and the layout locked at plan is remembered for
      // next time. An explicit body value still wins, and the engine carries a
      // quiet setting to flip modes either way.
      const layoutMode = ['shared', 'separate'].includes(req.body.layout_mode) ? req.body.layout_mode : 'shared';
      const [gang] = await qc(
        'INSERT INTO gang_runs (gang_number, notes, created_by, layout_mode) VALUES ($1,$2,$3,$4) RETURNING id',
        [gang_number, req.body.notes || null, req.user.name, layoutMode]);
      await qc(`UPDATE order_lines SET gang_run_id=$1,
         stock_booking=COALESCE((SELECT g2.stock_booking FROM gang_runs g2 WHERE g2.id=$1), 'book')
       WHERE id = ANY($2)`, [gang.id, lineIds]);
      await clearJoinersMix(lineIds, gang_number, qc, req.user.name);

      let recognised = null;
      if (layoutMode === 'shared') {
        const die = await findDieTemplate(members.map(m => m.product_id), qc, oc);
        if (die) {
          for (const m of members) {
            const slot = die.slots.find(sl => sl.product_id === m.product_id);
            if (!slot) continue;
            const line = await oc('SELECT spec_override FROM order_lines WHERE id=$1', [m.id]);
            const prev = line.spec_override
              ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
              : {};
            // Stamped EXPLICITLY (no clear-if-equal) — the die's own facts,
            // frozen for this run even if a master changes later.
            await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
              [JSON.stringify({ ...prev, ups: slot.ups, child_l: die.child_l, child_w: die.child_w }), m.id]);
          }
          recognised = die;
          await audit('gang_run', gang.id, 'die_recognised',
            `${gang_number}: known die "${die.name}" applied — ${die.child_l}×${die.child_w}", ups ${die.slots.map(sl => sl.ups).join('+')} (last ${die.last_gang_number || '—'})`,
            qc, req.user.name);
        }
      }
      await audit('gang_run', gang.id, 'create',
        `${gang_number}: ${members.map(m => m.product_name).join(' + ')}${recognised ? ` · die "${recognised.name}" recognised` : ' · new combination — layout to be decided'}`,
        qc, req.user.name);
      return gang.id;
    });
    res.json(await gangDetail(gangId));
  } catch (e) { next(e); }
});

r.get('/gang-runs/:id', async (req, res, next) => {
  try { res.json(await gangDetail(+req.params.id)); } catch (e) { next(e); }
});

// ── Create a COMBINED RUN — the same product on several sales orders ────────
// Where a gang is advisory ("bind anything, we warn"), a merge asserts a
// physical identity — one carton, one board, one cut layout — so mergeCompat's
// conflicts are hard 409s here, never warnings. The run reuses gang_runs and
// gang_run_id wholesale: every lateral that resolves "which card is this line
// riding?" already keys on that column, so a merge inherits the floor, the
// planning views and procurement without a single new join.
r.post('/merge-runs', canPlan, async (req, res, next) => {
  try {
    const lineIds = [...new Set((req.body.line_ids || []).map(Number).filter(Boolean))];
    if (lineIds.length < 2) return res.status(400).json({ error: 'Pick at least two sales orders to combine' });

    const runId = await tx(async (qc, oc) => {
      const members = await qc(`${MEMBER_VIEW} WHERE ol.id = ANY($1) FOR UPDATE OF ol`, [lineIds]);
      if (members.length !== lineIds.length) throw Object.assign(new Error('One or more lines not found'), { status: 404 });

      const verdict = mergeCompat(members);
      if (!verdict.ok) throw Object.assign(
        new Error(verdict.conflicts[0].message || 'These orders cannot combine'),
        { status: 409, body: { code: 'merge_conflicts', conflicts: verdict.conflicts } });

      const run_number = await nextRunNumber('CI-MRG-', oc);
      const [run] = await qc(
        `INSERT INTO gang_runs (gang_number, kind, product_id, notes, created_by)
         VALUES ($1,'merge',$2,$3,$4) RETURNING id`,
        [run_number, members[0].product_id, req.body.notes || null, req.user.name]);
      await qc(`UPDATE order_lines SET gang_run_id=$1,
         stock_booking=COALESCE((SELECT g2.stock_booking FROM gang_runs g2 WHERE g2.id=$1), 'book')
       WHERE id = ANY($2)`, [run.id, lineIds]);
      await clearJoinersMix(lineIds, run_number, qc, req.user.name);
      await audit('gang_run', run.id, 'create_merge',
        `${run_number}: ${members[0].product_name} × ${members.length} sales orders (${members.map(m => m.po_number).join(', ')}) as one run`,
        qc, req.user.name);
      return run.id;
    });
    res.json(await gangDetail(runId));
  } catch (e) { next(e); }
});

// ── Convert a same-product gang into a COMBINED RUN ─────────────────────────
// For the gangs created before Combined Runs existed: nine of the twelve on
// the live plant are the same carton on different POs, which a gang would
// pointlessly split after die cutting. Guarded by REAL progress, not status:
// createJobCardForGang flips members to in_production the moment the card is
// minted, so status alone would refuse a run whose card sits entirely pending
// with no board drawn (CI-GANG-0007's exact state). An unstarted card is
// deleted here and the members return to planning; the planner re-locks and
// pushes the run's own CI-JC- card.
r.post('/gang-runs/:id/convert-to-merge', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const run = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!run) throw Object.assign(new Error('Run not found'), { status: 404 });
      if (run.kind === 'merge') return; // already converted — idempotent

      const card = await oc(
        `SELECT * FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL`, [run.id]);
      if (card) {
        const started = await oc(
          `SELECT stage FROM job_stages WHERE job_card_id=$1 AND status <> 'pending' LIMIT 1`, [card.id]);
        if (started) throw Object.assign(new Error(
          `${card.jc_number} has already started ${started.stage.replace('_', ' ')} — a run in motion stays a gang`), { status: 409 });
        const consumed = await oc(
          `SELECT 1 AS x FROM stock_movements WHERE ref_type='job_card' AND ref_id=$1 AND type='consumption' LIMIT 1`, [card.id]);
        if (consumed) throw Object.assign(new Error(
          `Board has already been issued to ${card.jc_number} — a run in motion stays a gang`), { status: 409 });
        const children = await oc('SELECT id FROM job_cards WHERE parent_job_card_id=$1 LIMIT 1', [card.id]);
        if (children) throw Object.assign(new Error(
          `${card.jc_number} has already split — nothing left to combine`), { status: 409 });
      }

      const members = await qc(`${MEMBER_VIEW} WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [run.id]);
      // Judge the members as a merge, ignoring the two facts the conversion
      // itself resolves: they are in THIS run, and the card being deleted.
      const verdict = mergeCompat(members.map(m => ({
        ...m, gang_run_id: null,
        job_card_id: null, jc_number: null,
        status: ['in_production', 'ready'].includes(m.status) && card ? 'planned' : m.status,
      })));
      if (!verdict.ok) throw Object.assign(
        new Error(verdict.conflicts[0].message || 'This gang cannot convert'),
        { status: 409, body: { code: 'merge_conflicts', conflicts: verdict.conflicts } });

      if (card) {
        // The unstarted card dissolves and its members return to planning —
        // their in_production was a book entry, not the floor.
        await qc('DELETE FROM job_stages WHERE job_card_id=$1', [card.id]);
        await qc('DELETE FROM job_cards WHERE id=$1', [card.id]);
        for (const m of members) {
          if (['ready', 'in_production'].includes(m.status)) {
            await forceLineStatus(m.id, 'planned',
              `${run.gang_number} converted to a combined run — unstarted ${card.jc_number} dissolved`, qc, oc, req.user.name);
          }
        }
        await audit('job_card', card.id, 'dissolve_on_convert',
          `${card.jc_number} deleted (never started) — ${run.gang_number} became a combined run`, qc, req.user.name);
      }

      const run_number = await nextRunNumber('CI-MRG-', oc);
      await qc(`UPDATE gang_runs SET kind='merge', gang_number=$1, product_id=$2 WHERE id=$3`,
        [run_number, members[0].product_id, run.id]);
      for (const m of members) {
        await clearMixPlan(m.id, qc, req.user.name, `${run.gang_number} → ${run_number}: one board for the combined pile`);
      }
      await audit('gang_run', run.id, 'convert_to_merge',
        `${run.gang_number} → ${run_number}: ${members.length} sales orders of ${members[0].product_name} become one run — no split`,
        qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── The quiet die setting — flip co-printed ⇄ separate, planning-only ──────
// No popup at create; the engine carries this for the rare case the inference
// is wrong. Flipping never deletes entered values — only how the plan sums.
r.patch('/gang-runs/:id/layout', canPlan, async (req, res, next) => {
  try {
    const mode = req.body.layout_mode;
    if (!['shared', 'separate'].includes(mode)) return res.status(400).json({ error: 'layout_mode must be shared or separate' });
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      if (gang.kind === 'merge') throw Object.assign(new Error('A combined run has no die modes'), { status: 409 });
      await assertPlanningOnlyGangEdit(gang.id, oc);
      if (gang.layout_mode !== mode) {
        await qc('UPDATE gang_runs SET layout_mode=$1 WHERE id=$2', [mode, gang.id]);
        await audit('gang_run', gang.id, 'layout_mode',
          `${gang.gang_number}: ${gang.layout_mode} → ${mode}`, qc, req.user.name);
      }
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// ── The run's own output & die number ───────────────────────────────────────
// A gang of mixed products is a NEW layout every time: its plate set and its
// die are cut for this run and no other, so neither number can be fetched
// from a product master — the planner types them here and they travel with
// the gang number and the product names to every station the run passes.
//
// Deliberately NOT gated by assertPlanningOnlyGangEdit: unlike breaking a
// gang apart, naming its plate changes no quantity and no membership, and the
// number is most often needed for a run already ON the floor — a job that was
// planned before this field existed must be nameable exactly where it stands.
// Editable from the Planning engine, Artwork and the job card; all three post
// here, so there is one writer and one audit trail.
//
// Combined runs are refused: one product printed from its own master plate
// and die has nothing new to name (mirrors the /layout refusal above).
r.patch('/gang-runs/:id/numbers', canPlan, async (req, res, next) => {
  try {
    // Blank clears — the planner can take a number back off a run.
    const clean = v => (v == null || String(v).trim() === '' ? null : String(v).trim());
    const out = clean(req.body.output_number);
    const die = clean(req.body.die_number);
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      if (gang.kind === 'merge') throw Object.assign(new Error(
        'A combined run prints one product from its own plate and die — it has no run numbers of its own'), { status: 409 });
      if ((gang.output_number ?? null) === out && (gang.die_number ?? null) === die) return;
      await qc('UPDATE gang_runs SET output_number=$1, die_number=$2 WHERE id=$3', [out, die, gang.id]);
      const said = [
        (gang.output_number ?? null) !== out ? `output ${gang.output_number || '—'} → ${out || '—'}` : null,
        (gang.die_number ?? null) !== die ? `die ${gang.die_number || '—'} → ${die || '—'}` : null,
      ].filter(Boolean).join(', ');
      await audit('gang_run', gang.id, 'run_numbers', `${gang.gang_number}: ${said}`, qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
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
      let adoptedChildNote = '';
      if (gang.layout_mode === 'shared') {
        // CO-PRINTED layout: every member nests on ONE child sheet, so the run
        // is the MAX any member needs (sharedLayoutRun) and each member's
        // stored figures are its proportional share of that one count. The
        // parent conversion is the SAME childFit/parentSheetsRequired as every
        // plan — computed once, because the sheet is one.
        const effs = [];
        for (const line of lines) {
          const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
          effs.push(effectiveProduct(master, line));
        }
        const layout = sharedLayoutState(gang, lines);
        let child = layout.child;
        let childAdopted = false;
        if (layout.pending) {
          // Soft gate: the members' effective specs (override, else master)
          // may already agree on one sheet — then the lock IS the save. Only
          // no-size-anywhere or disagreeing sizes still refuse: the press has
          // no single sheet to run, which is physics, not paperwork.
          child = agreedChildSize(effs.map(e2 => ({ l: e2.child_l, w: e2.child_w })));
          if (!child) throw Object.assign(new Error(
            `Layout pending — ${layout.reason}. Enter the final child sheet size (Run Sheet) before planning.`), { status: 409 });
          // Stamp the adopted size into every member's spec_override —
          // explicitly, even where it equals the master (the same keep-explicit
          // rule the Run Sheet lock applies), so smart match, the job card and
          // the floor gate all read a settled layout from here on.
          for (const line of lines) {
            const prev = line.spec_override
              ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
              : {};
            await qc('UPDATE order_lines SET spec_override=$1 WHERE id=$2',
              [JSON.stringify({ ...prev, child_l: child.l, child_w: child.w }), line.id]);
          }
          childAdopted = true;
        }
        const boards = [...new Set(effs.map(e2 => e2.board_material_id).filter(Boolean))];
        if (boards.length !== 1) throw Object.assign(new Error(
          'A shared layout cuts from ONE board — set one board for the whole run first'), { status: 409 });
        const badUps = lines.find((l2, i) => !(+effs[i].ups > 0));
        if (badUps) throw Object.assign(new Error(
          'Every job on a shared layout needs its ups — enter them in the members table'), { status: 409 });

        const w = wastage ?? lines[0].wastage_sheets ?? 0;
        const run = sharedLayoutRun(
          lines.map((l2, i) => ({ id: l2.id, net: netProduceQty(l2), ups: effs[i].ups })),
          { wastage: w });
        const board = await oc('SELECT * FROM materials WHERE id=$1', [boards[0]]);
        const parent = effectiveParent(effs[0], board);
        const fit = childFit(parent, effs[0]);
        const runParent = parentSheetsRequired(run.run_child, fit.count);
        const childShares = splitProportional(run.run_child, lines.map((l2, i) => ({ id: l2.id, ups: effs[i].ups })));
        const parentShares = splitProportional(runParent, lines.map((l2, i) => ({ id: l2.id, ups: effs[i].ups })));
        for (let i = 0; i < lines.length; i++) {
          plan.push({
            line: lines[i], eff: effs[i], fit,
            sheets: childShares[i].share, parentSheets: parentShares[i].share,
            wastage: i === 0 ? w : 0,
          });
        }
        // The plan lock is the plant DECIDING this layout — remember the die
        // (child size + ups per product) so the next gang of this combination
        // arrives ready. Latest locked layout wins; manual names survive. An
        // adopted (master-agreed) size is a decision too: it is the sheet the
        // planner just chose to lock.
        await rememberDie(gang, lines, effs, child, qc, oc, req.user.name);
        if (childAdopted) adoptedChildNote = ` · layout ${child.l}×${child.w}" adopted from the members' spec and saved`;
      } else {
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
        // A member can carry a mix from being individually planned BEFORE it
        // joined the gang — Planning refuses to SAVE a new mix on a ganged
        // line (see orders.js's plan-save gang guard) but never clears one
        // already there when the line is added to a gang (POST /gang-runs and
        // /add-lines only set gang_run_id). This UPDATE just replaced the cut
        // plan that mix's ups/covers were frozen against, exactly the case
        // clearMixPlan exists for.
        await clearMixPlan(line.id, qc, req.user.name,
          `gang ${gang.gang_number} planned — cut plan changed`);
        await audit('order_line', line.id, 'planned',
          `${sheets} child → ${parentSheets} parent (${fit.count}/parent, ${eff.ups} ups) — gang plan ${gang.gang_number}`,
          qc, req.user.name);
      }
      // 4) The run's board mix, if the planner built one.
      //
      // A run is planned as ONE pile, so the mix is entered once against the
      // run's whole issue — but job_board_mix is keyed on order_line_id and
      // every reader downstream (the release gate, mixPosition, consumeFifo,
      // the job card) asks one LINE at a time. So it is stored the way the
      // issue itself already is: split across the members, summing to exactly
      // what was typed. See gang-mix.js for why the split is a waterfall and
      // not the proportional rounding used for `issued` above.
      //
      // The mix balances against the ISSUED total, never the natural one — an
      // issue override has just rewritten every member's parent_sheets_required
      // and that is what each member's own balance will be judged against.
      const issuedTotal = issued.reduce((s, x) => s + x, 0);
      if (Array.isArray(req.body.mix) && req.body.mix.length) {
        const board = await oc('SELECT * FROM materials WHERE id=$1', [plan[0].eff.board_material_id]);
        // Per-member cut for a candidate board. Mirrors the /plan maths above
        // and gangMixContext's, off the same effective product.
        const upsFor = (idx, mat) => childFit(mat, plan[idx].eff).count;
        // ── MERGE runs only: chosen cuts ────────────────────────────────
        // A combined run is ONE product, so it has one child, one planned
        // fit, one plannedUps — which is what lets the planner CHOOSE a
        // row's cuts exactly as a single line does (orders.js's mix block).
        // That premise is asserted, not trusted: kind='merge' is stamped
        // with product_id at creation and add-lines refuses a different
        // carton, so a violation here is corrupted data, and pricing a
        // chosen cut against the wrong member's child would write covers
        // the release gate then judges every member by. Gang-kind runs
        // take none of these branches — their cuts stay derived per member,
        // byte-identical to before.
        const isMerge = gang.kind === 'merge';
        if (isMerge) {
          if (!plan.length || plan.some(p => p.line.product_id !== plan[0].line.product_id)) {
            throw new Error(`${gang.gang_number} is a combined run but its members are not one product — refusing to price a cut against the wrong child`);
          }
        }
        const runPlannedUps = plan[0].fit.count;
        // The parent the run's own planned fit was measured on (plan loop
        // above: effectiveParent(eff, board) → childFit) — a chosen cut on
        // the PLANNED row validates and banks against this same trimmed
        // sheet, while a substitute uses its own mother sheet: the exact
        // rowParentFor asymmetry orders.js documents at length.
        const runParent = isMerge ? effectiveParent(plan[0].eff, board) : null;
        const runRowParentFor = (role, mat) =>
          role === 'planned' ? runParent : { sheet_l: mat.sheet_l, sheet_w: mat.sheet_w };
        const runRows = [];
        // The boards, ONCE, with their dimensions — the split loop below reuses
        // these very rows. Re-selecting by id alone there handed childFit a
        // dimensionless board, which priced every row at a wrong cut and wrote
        // covers the release gate then judged the run short by. `spec` rides
        // along solely for the merge leftover bank — findOrCreateLeftoverMaster
        // stamps the source board's spec onto the leftover master it mints.
        const matById = new Map();
        for (const raw of req.body.mix) {
          const mat = await oc('SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE id=$1', [+raw.material_id]);
          if (!mat) throw Object.assign(new Error('Unknown board in the mix'), { status: 400 });
          matById.set(mat.id, mat);
          // Judged against EVERY member: the run draws all of them off one
          // pile, so a board that cuts wrong for any one member cannot join.
          for (let idx = 0; idx < plan.length; idx++) {
            const ups = upsFor(idx, mat);
            const flags = substitutionFlags({
              plannedBoard: { id: plan[0].eff.board_material_id, name: board?.name },
              candidateBoard: mat, plannedUps: plan[idx].fit.count, candidateUps: ups });
            if (!flags.ok) throw Object.assign(
              new Error(`${mat.name} cannot substitute for ${board?.name} — the grade must match`),
              { status: 409 });
            // REPEALED for MERGE runs 2026-08-05, mirroring orders.js's own
            // repeal for single lines and for the same reason: differing
            // cuts are planner intent now — the plate never changes, only
            // how many of the one child each board yields, and covers
            // convert by the cuts ratio (rowCovers below). The refusal's
            // real basis was the split's arithmetic (sheets === covers),
            // which the covers-space split now handles. A GANG keeps the
            // 409 verbatim: its cuts are per member and derived, so a
            // differing board still cannot join.
            if (flags.ups_differ && !isMerge) throw Object.assign(
              new Error(`${mat.name} cuts ${ups} up against ${plan[idx].fit.count} on ${plan[idx].eff.name} — a different imposition needs its own plate, not a substitution`),
              { status: 409 });
          }
          // Coerce numerically before the DB sees it — Postgres orders NaN
          // above every double, so 'NaN' would sail past CHECK (sheets > 0).
          const sheets = Number(raw.sheets);
          if (!Number.isFinite(sheets) || !(sheets > 0)) throw Object.assign(
            new Error(`Enter a sheet count for ${mat.name}`), { status: 400 });
          const role = mat.id === +plan[0].eff.board_material_id ? 'planned' : 'substitute';
          // A merge run's row cuts: the planner's CHOSEN value when sent,
          // else the board's natural ceiling — the planned row's being
          // runPlannedUps itself (the unit the requirement is priced in),
          // a substitute's its own native fit. Same coerce-then-validate
          // guard as orders.js: chosenCutsValid's internal rounding must
          // never reinterpret garbage into a different stored integer.
          let rowUps = null;
          if (isMerge) {
            rowUps = role === 'planned' ? runPlannedUps : upsFor(0, mat);
            if (raw.ups !== undefined && raw.ups !== null && raw.ups !== '') {
              const rawUps = Number(raw.ups);
              if (!Number.isFinite(rawUps) || !Number.isInteger(rawUps)) throw Object.assign(
                new Error(`Enter a whole number of cuts for ${mat.name}`), { status: 400 });
              const cutsCheck = chosenCutsValid(runRowParentFor(role, mat), plan[0].eff, rawUps);
              if (!cutsCheck.ok) throw Object.assign(
                new Error(`${mat.name}: ${cutsCheck.why}`), { status: 409 });
              rowUps = rawUps;
            }
          }
          const reason = String(raw.reason || '').trim()
            || (role === 'substitute' ? DEFAULT_MIX_REASON : null);
          let batchId = null;
          if (raw.stock_batch_id) {
            batchId = +raw.stock_batch_id;
            const b = await oc('SELECT id FROM stock_batches WHERE id=$1 AND material_id=$2', [batchId, mat.id]);
            if (!b) throw Object.assign(
              new Error(`That lot does not belong to ${mat.name} — pick a lot of this board, or leave it blank for FIFO`),
              { status: 409 });
          }
          runRows.push({
            material_id: mat.id, stock_batch_id: batchId, sheets, role, reason,
            // Merge rows price themselves so the run balance below and the
            // split both read real coverage; gang rows carry neither (their
            // covers === sheets by the 409 above, restored per member below).
            ...(isMerge ? { ups: rowUps, covers: rowCovers({ sheets, ups: rowUps, plannedUps: runPlannedUps }) } : {}),
          });
        }
        // Balance the RUN first, in the planner's own terms, so the sentence
        // they read names the run's total and not some member's share of it.
        // On a GANG every row's ups equals its member's planned ups (refused
        // above), so covers === sheets and the balance is a plain sum. On a
        // MERGE the rows carry real covers — a chosen or differing cut makes
        // a sheet of that board worth more or fewer planned-board parents,
        // and the balance must be struck in that one unit.
        const runBal = mixBalance({ required: issuedTotal,
          rows: isMerge ? runRows : runRows.map(r => ({ covers: r.sheets })) });
        // Under-coverage only, same rule as a line's own lock — over-coverage
        // is the planner's call once cuts differ (mixBalance's `sufficient`).
        if (!runBal.sufficient) throw Object.assign(
          new Error(`The board mix covers ${Math.round(runBal.covered)} of ${Math.round(runBal.required)} parent sheets for ${gang.gang_number} — allocate ${Math.ceil(runBal.balance)} more`),
          { status: 409 });

        // The waterfall walks COVERS whenever some merge row's cuts differ
        // from the planned ups (splitScaledMixAcrossMembers's own comment
        // says why sheets-space cannot). With every row at the planned cuts
        // — every gang, and the ordinary merge mix — covers === sheets and
        // the integer waterfall runs exactly as it always has.
        const scaled = isMerge && runRows.some(r => Number(r.ups) !== Number(runPlannedUps));
        const split = (scaled ? splitScaledMixAcrossMembers : splitMixAcrossMembers)({
          members: plan.map((p, idx) => ({ id: p.line.id, required: issued[idx] })),
          rows: runRows,
        });
        for (const share of split) {
          const idx = plan.findIndex(p => p.line.id === share.member_id);
          const plannedUps = plan[idx].fit.count;
          const rows = [];
          for (const r of share.rows) {
            // A merge member inherits the run row's (possibly chosen) cuts;
            // a gang member prices the board off its OWN child, as ever. The
            // scaled split already carries each take's exact covers — the
            // run-level figure it walked by — and recomputing here from the
            // fractional sheets would only re-introduce the float dust its
            // tail rule exists to avoid.
            const ups = isMerge ? r.ups : upsFor(idx, matById.get(r.material_id));
            rows.push({ ...r, ups,
              covers: scaled ? r.covers : rowCovers({ sheets: r.sheets, ups, plannedUps }) });
          }
          if (!rows.length) continue;   // a member needing nothing carries none
          await replaceMixPlan(share.member_id, rows, qc, req.user.name);
        }
        await audit('gang_run', gang.id, 'board_mix',
          runRows.map(r => `${r.sheets} of material ${r.material_id}`).join('; ').slice(0, 500),
          qc, req.user.name);

        // ── Run-level leftover banking (merge only) ──────────────────────
        // Mirrors orders.js's v2 per-row bank, at run level: banking is
        // opt-in per mix row (req.body.mix_leftovers), the strip is derived
        // HERE from the row's own geometry — planned row off the run's
        // trimmed parent, substitute off its own mother sheet, the same
        // runRowParentFor the chosen-cuts validation used, so cuts and
        // strips can never disagree about the sheet. Batch qty is Task 4's
        // unit: strips = strips_per_parent × that board's RUN-level parent
        // sheets; cutting-complete trues it to spp × actual parents. The
        // keep-list makes the sweep reconcile: dropped rows and toggled-off
        // boards zero, survivors delta through bankRunLeftover itself.
        // A gang-kind run banks nothing here, explicitly — its parent card
        // can carry mixed child layouts, so its offcut has no product
        // identity until the die-cut split (the same reasoning as
        // production.js's gang-parent skip).
        if (isMerge) {
          const bankWanted = new Map(
            (Array.isArray(req.body.mix_leftovers) ? req.body.mix_leftovers : [])
              .map(x => [+x.material_id, !!x.bank]));
          const banked = [];
          for (const r of runRows) {
            if (!bankWanted.get(r.material_id)) continue;
            const mat = matById.get(r.material_id);
            const strips = chosenStrips(runRowParentFor(r.role, mat), plan[0].eff, r.ups);
            if (!strips.length) throw Object.assign(
              new Error(`No strip left to bank on ${mat.name}`), { status: 409 });
            const usable = strips.filter(s => s.usable);
            if (!usable.length) {
              const best = [...strips].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
              throw Object.assign(
                new Error(`Strip ${best.l}×${best.w}" is under 3" — waste, not stock`), { status: 409 });
            }
            // Two clean rectangles can both be bankable; the payload carries
            // no strip choice, so the largest (most board saved) wins — the
            // same pick orders.js and the client's chip both take.
            const pick = [...usable].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
            banked.push({ mat, strip: pick, spp: pick.strips_per_parent || 1, sheets: r.sheets });
          }
          const keep = banked.map(b => `LO-PLAN-RUN-${gang.id}-${b.mat.id}`);
          await unbankRunLeftover(gang.id, qc, oc, req.user.name,
            banked.length ? 'run mix leftover rows changed' : 'plan changed', keep);
          for (const b of banked) {
            await bankRunLeftover(gang.id, b.mat, b.strip, b.spp, b.spp * b.sheets, qc, oc, req.user.name);
          }
        }
      } else if (gang.kind === 'merge') {
        // A merge run re-locked WITHOUT a mix: the members' rows were already
        // cleared in the plan loop above, so any run-level batches an earlier
        // lock banked now mirror nothing — sweep them to zero. No-op when
        // nothing was banked; gang-kind runs never bank, so they skip even
        // the lookup and this branch changes nothing for them.
        await unbankRunLeftover(gang.id, qc, oc, req.user.name, 'plan re-locked without a mix');
      }
      await qc('UPDATE gang_runs SET issue_parent_sheets=$1 WHERE id=$2', [issueOverride, gang.id]);
      await audit('gang_run', gang.id, 'plan',
        `${gang.gang_number} planned as one job (${lines.length} members${wastage != null ? `, ${wastage} wastage sheets each` : ''})`
        + (issueOverride != null && issueOverride !== natural ? ` · issue overridden ${natural} → ${issuedTotal}` : '')
        + adoptedChildNote,
        qc, req.user.name);
    });
    res.json(await gangDetail(+req.params.id));
  } catch (e) { next(e); }
});

// Recompute a member's sheet requirement after its qty / ups changed — but only
// once its plan is locked (planned / ready). A still-pending line has no cut plan
// figures yet, so there is nothing to keep in sync.
//
// live: a COMBINED RUN whose card is minted but unstarted has flipped every
// member to in_production, and its sheet is still correctable (see
// assertSheetEditable). Without this the spec would change while the cut plan
// kept the old board's figures — the silent half-update that makes a "fixed"
// job draw the wrong quantity of the right board.
async function reDeriveMemberSheets(lineId, qc, oc, user, why, { live = false } = {}) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  const editable = live ? ['planned', 'ready', 'in_production'] : ['planned', 'ready'];
  if (!editable.includes(line.status)) return;
  // A SHARED layout has no per-member cut plan — one member's qty/ups edit
  // moves the WHOLE run (the MAX can shift), so the recompute covers every
  // member together and re-splits the shares. Layout still pending → nothing
  // derivable yet; the figures land at plan time.
  if (line.gang_run_id) {
    const gang = await oc('SELECT * FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    if (gang?.layout_mode === 'shared') {
      const lines = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [gang.id]);
      const layout = sharedLayoutState(gang, lines);
      if (layout.pending) return;
      const effs = [];
      for (const l2 of lines) {
        const m2 = await oc('SELECT * FROM products WHERE id=$1', [l2.product_id]);
        effs.push(effectiveProduct(m2, l2));
      }
      if ([...new Set(effs.map(e2 => e2.board_material_id).filter(Boolean))].length !== 1) return;
      if (effs.some(e2 => !(+e2.ups > 0))) return;
      const run = sharedLayoutRun(
        lines.map((l2, i) => ({ id: l2.id, net: netProduceQty(l2), ups: effs[i].ups })),
        { wastage: lines[0].wastage_sheets ?? 0 });
      const board = await oc('SELECT * FROM materials WHERE id=$1', [effs[0].board_material_id]);
      const fit = childFit(effectiveParent(effs[0], board), effs[0]);
      const runParent = parentSheetsRequired(run.run_child, fit.count);
      const childShares = splitProportional(run.run_child, lines.map((l2, i) => ({ id: l2.id, ups: effs[i].ups })));
      const parentShares = splitProportional(runParent, lines.map((l2, i) => ({ id: l2.id, ups: effs[i].ups })));
      for (let i = 0; i < lines.length; i++) {
        if (!['planned', 'ready'].includes(lines[i].status)) continue;
        await qc('UPDATE order_lines SET sheets_required=$1, parent_sheets_required=$2 WHERE id=$3',
          [childShares[i].share, parentShares[i].share, lines[i].id]);
        await clearMixPlan(lines[i].id, qc, user, why);
      }
      return;
    }
  }
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
  // Same invariant as plan-save: a mix's ups/covers are frozen against the cut
  // plan that produced them, and this UPDATE just replaced it. A member can
  // carry a mix in from before it joined the gang (see the /plan endpoint
  // above), and each of this function's three callers — qty/ups edit, per-
  // member board reassignment, shared-sheet lock — changes an input the cut
  // math depends on. clearMixPlan is a cheap no-op when there is nothing to
  // clear, so calling it unconditionally here (rather than diffing old vs new
  // sheets) matches how plan-save itself doesn't diff either.
  await clearMixPlan(lineId, qc, user, why || 'gang member re-derived — cut plan changed');
  // On a MERGE run the member rows just cleared were the run's own split mix,
  // and the run-level leftover bank mirrors that mix — so it goes with it,
  // exactly as re-locking without a mix sweeps it. The re-lock that follows a
  // spec change re-banks whatever the planner keeps. Gang-kind runs never
  // bank, so the kind read is the whole cost for them.
  if (line.gang_run_id) {
    const kindRow = await oc('SELECT kind FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    if (kindRow?.kind === 'merge') {
      await unbankRunLeftover(line.gang_run_id, qc, oc, user,
        why || 'gang member re-derived — cut plan changed');
    }
  }
}

// NAMING A MEMBER IS NOT EDITING THE RUN. The four fields the per-member
// identity panel writes each NAME the job — the customer's artwork code, the
// output / set number, the die and the block. Not one of them is an input to
// the cut math (ups, child_l/child_w) or to the process (colours, coating,
// emboss, leafing, pasting), so not one of them can change what is already
// running: no quantity moves, no membership moves, no sheet moves.
//
// This is the same argument /numbers already makes for a run's own plate — a
// number is most often needed for a job already ON the floor, and a job that
// was planned before somebody had the die number must be nameable exactly
// where it stands. Sending a rename through assertPlanningOnlyGangEdit — a
// guard written for BREAKING a run — answered "BRUTAFLAM-CGII is already in
// production. Gangs can be broken only in Planning" to a dialog that breaks
// nothing. The UI never believed it either: the identity inputs are the one
// set on this panel that is NOT disabled once a member leaves planning.
//
// Physics stays hard. Anything else in the body — a qty, an ups, a child size,
// a colour, a coating — falls straight back to the planning-only rule below.
export const IDENTITY_SPEC = ['party_artwork_code', 'output_number', 'die_number', 'block_number'];

// True when the request carries names and nothing else. A body that provides
// no writable value at all is identity-only by the same token: it writes
// nothing, so there is nothing for the guard to protect.
export function isIdentityOnlyEdit(body = {}) {
  if (body.qty !== undefined && body.qty !== '' && body.qty !== null) return false;
  if (body.ups !== undefined) return false;
  const spec = body.spec || {};
  return Object.keys(spec)
    .filter(f => spec[f] !== undefined && spec[f] !== null && spec[f] !== '')
    .every(f => IDENTITY_SPEC.includes(f));
}

// ── Edit one member — total qty and/or ups, in place ────────────────────────
// The gang view's inline controls. Qty is the order quantity (guarded by what's
// already dispatched); ups is a per-job spec override. Both re-derive the cut
// plan when the member is already planned, and both are refused once the gang
// has left planning. An identity-only save is exempt — see above.
r.patch('/gang-runs/:id/lines/:lineId', canPlan, async (req, res, next) => {
  try {
    const identityOnly = isIdentityOnlyEdit(req.body);
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      if (!identityOnly) await assertPlanningOnlyGangEdit(gang.id, oc);
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
        colour_type: 'text', pasting_type: 'text', die_number: 'text', block_number: 'text' };
      const provided = Object.keys(GANG_SPEC).filter(f => spec[f] !== undefined && spec[f] !== null && spec[f] !== '');
      if (provided.length) {
        const master = await oc(`SELECT ups, child_l, child_w, colors, coating, emboss, leafing, leafing_colour,
          party_artwork_code, output_number, shade_card_number, shade_card_date, colour_type, pasting_type,
          die_number, block_number
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

      // A rename is not a re-plan. Re-deriving here would be a no-op on the
      // figures (identity feeds neither the fit nor the sheet count) but NOT on
      // its side effects — it clears the member's board mix plan and, on a
      // combined run, unbanks the run's leftover. Typing a die number must not
      // cost the planner a mix he already balanced.
      if (!identityOnly) {
        await reDeriveMemberSheets(line.id, qc, oc, req.user.name,
          `qty/spec changed on ${gang.gang_number} — cut plan re-derived`);
      }
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
      // A combined run admits ONLY its own product — the whole premise is one
      // indistinguishable pile. A gang keeps the open-door policy.
      .filter(l => gang.kind !== 'merge' || l.product_id === gang.product_id)
      .map(l => ({
        id: l.id, product_name: l.product_name, product_code: l.product_code,
        po_number: l.po_number, customer_name: l.customer_name, qty: l.qty,
        board_name: l.board_name, coating: l.coating, delivery_date: l.delivery_date,
        status: l.status,
        compatible: gang.kind === 'merge'
          ? l.board_material_id === board
          : (l.board_material_id === board && l.coating === coating),
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
        // A combined run is ONE product by definition — a different carton
        // belongs in a gang, and the message says so rather than just "no".
        if (gang.kind === 'merge' && m.product_id !== gang.product_id) {
          throw Object.assign(new Error(
            `${gang.gang_number} is a combined run of one product — ${m.product_name} is a different carton. Gang them instead.`), { status: 409 });
        }
      }
      await qc(`UPDATE order_lines SET gang_run_id=$1,
         stock_booking=COALESCE((SELECT g2.stock_booking FROM gang_runs g2 WHERE g2.id=$1), 'book')
       WHERE id = ANY($2)`, [gang.id, lineIds]);
      await clearJoinersMix(lineIds, gang.gang_number, qc, req.user.name);
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
        await reDeriveMemberSheets(line.id, qc, oc, req.user.name,
          `board changed to ${board.name} on ${gang.gang_number} — cut plan re-derived`);
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
      // A combined run's card, minted but not yet on the floor, does not stop
      // the sheet being corrected — it just has to travel with it. Everything
      // else (a gang, or a run still in planning) keeps the ordinary rule.
      const card = await assertSheetEditable(gang, oc);
      if (!card) await assertPlanningOnlyGangEdit(gang.id, oc);
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
          // On a SHARED layout the entered child size is the layout's own fact
          // — never dropped just because it coincides with a master's size,
          // or the gang would read Layout Pending again for that member.
          const keepExplicit = gang.layout_mode === 'shared' && !updateMaster && (f === 'child_l' || f === 'child_w');
          if (String(v) === String(master[f]) && !keepExplicit) { delete next[f]; continue; }   // already the master value
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
        await reDeriveMemberSheets(line.id, qc, oc, req.user.name,
          `${gang.gang_number} shared sheet ${updateMaster ? 'saved to product masters' : 'locked'} — cut plan re-derived`,
          { live: !!card });
      }
      // The card carries its OWN copy of what to draw — sheets_issued is what
      // the floor consumes at cutting (production.js issues exactly that many)
      // and what the board-pending chip measures stock against. A new sheet
      // that left it alone would hand the cutter the old board's count of the
      // new board: right correction, wrong quantity. Re-read the members so
      // readiness() sees the figures reDeriveMemberSheets just wrote — it
      // prefers the stored ones — and restamp the card from them, exactly as
      // createJobCardForMergeRun first built it.
      if (card) {
        const fresh = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id', [gang.id]);
        let totalParent = 0;
        let perParent = 0;
        for (const line of fresh) {
          const gate = await readiness(line, oc);
          totalParent += gate.parent_needed;
          perParent = perParent || gate.children_per_parent;
        }
        await qc('UPDATE job_cards SET sheets_issued=$1, children_per_parent=$2 WHERE id=$3',
          [totalParent, Math.max(1, perParent || 1), card.id]);
        await audit('job_card', card.id, 'sheet_relocked',
          `${card.jc_number} follows ${gang.gang_number}'s new sheet (${Object.keys(patch).join(', ')}) — issue ${totalParent} parent sheets`,
          qc, req.user.name);
      }
      await audit('gang_run', gang.id, updateMaster ? 'lock_sheet_master' : 'lock_sheet',
        `${gang.gang_number} shared sheet ${updateMaster ? 'saved to product masters' : 'locked'} (${Object.keys(patch).join(', ')}) for all ${lines.length} jobs${card ? ` — ${card.jc_number} re-stamped` : ''}`, qc, req.user.name);
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
    // A shared layout without an entered child size ranks on the members'
    // agreed effective sheet when one exists — the size the plan lock will
    // adopt, so the picks match what the run will actually cut. Smart Match
    // waits only when nothing agrees: ranking against disagreeing MASTER
    // sizes would recommend parents for a sheet this run will never cut.
    const pendingState = sharedLayoutState(gang, members);
    if (pendingState.pending
        && !agreedChildSize(members.map(m => ({ l: m.child_l, w: m.child_w })))) {
      return res.json({ layout_pending: true, layout_reason: pendingState.reason, matches: [], child_sheets: 0 });
    }
    const anchor = members[0];
    const anchorId = anchor.board_material_id;
    // Combined child sheets across every member (locked figure, else a live estimate).
    const childSheets = members.reduce((s, m) =>
      s + (m.sheets_required ?? sheetsRequired({ ups: m.ups, wastage_pct: m.wastage_pct }, netProduceQty(m), m.wastage_sheets)), 0);

    const candidates = await q(`
      SELECT m.*, COALESCE(av.q,0) AS available,
             COALESCE(src.name, m.name) AS match_name, COALESCE(src.spec, m.spec) AS match_spec
      FROM materials m
      LEFT JOIN materials src ON src.id = m.source_material_id
      LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                 WHERE status='available' GROUP BY material_id) av ON av.material_id=m.id
      WHERE m.category='board' AND m.sheet_l > 0 AND m.sheet_w > 0
        AND (COALESCE(av.q,0) > 0 OR m.id = $1)`,
      [anchorId]);
    // The run's own members never count against it — everyone else does,
    // whatever stage they are at. Same rule, same helper, same claimant list as
    // the single-job engine: a gang buys board on one combined PR, so a board
    // that reads free here and is not commits the plant to the biggest single
    // over-buy it can make.
    const boardIds = candidates.map(c => c.id);
    const [claimLines, allocations] = await Promise.all([
      boardClaimLines(boardIds, members.map(m => m.id)),
      boardIds.length
        ? q(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [boardIds])
        : [],
    ]);
    const claims = claimsByBoard({ lines: claimLines, allocations });
    for (const c of candidates) {
      const claim = claims.get(c.id);
      c.committed = claim?.committed || 0;
      c.claimants = claim?.claimants || [];
    }
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
// What reversing this gang would have to walk back — asked before committing.
r.get('/gang-runs/:id/reverse-preview', async (req, res, next) => {
  try {
    const jc = await one(
      'SELECT id FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL', [+req.params.id]);
    if (!jc) return res.json({ jc_number: null, at: null, chain: [], hops: 0, gang: true, jobs: 0 });
    res.json(await reverseChainPreview(jc.id));
  } catch (e) { next(e); }
});

r.post('/gang-runs/:id/reverse', canPlan, async (req, res, next) => {
  try {
    const { force = false } = req.body || {};
    await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      // Gang-level job card? Block if any stage has started.
      const parentJc = await oc('SELECT id, jc_number FROM job_cards WHERE gang_run_id=$1 AND parent_job_card_id IS NULL', [gang.id]);
      let hops = [];
      if (parentJc) {
        const started = await oc(`SELECT COUNT(*)::int AS n FROM job_stages WHERE job_card_id=$1 AND status != 'pending'`, [parentJc.id]);
        // A gang that has started used to be a dead end here — the run could
        // never come back, however wrong it was. `force` is the planner having
        // been told where it is and answering yes: the whole run walks back off
        // the floor the way it came (sendStageBack already moves every member of
        // a gang together), then the card goes as it always did.
        if (started.n > 0 && !force) {
          const at = await oc(`SELECT stage, status FROM job_stages
                               WHERE job_card_id=$1 AND status <> 'pending'
                               ORDER BY seq DESC LIMIT 1`, [parentJc.id]);
          throw Object.assign(
            new Error(`${parentJc.jc_number} is at ${(at?.stage || 'the floor').replace(/_/g, ' ')} `
              + `(${(at?.status || '').replace(/_/g, ' ')}) — confirm to bring the whole run back to Planning`),
            { status: 409, body: { code: 'STAGES_ON_FLOOR', at: at ? { stage: at.stage, status: at.status } : null } });
        }
        if (started.n > 0) {
          hops = await unwindJobCardOffFloor(parentJc.id,
            req.body?.note || `gang ${gang.gang_number} reversed`, qc, oc, req.user.name);
        }
        await qc('DELETE FROM job_stages WHERE job_card_id=$1', [parentJc.id]);
        await qc('DELETE FROM job_cards WHERE id=$1', [parentJc.id]);
        await audit('job_card', parentJc.id,
          hops.length ? 'unwound_off_floor' : 'reversed_before_start',
          hops.length
            ? `Walked back through ${hops.map(h => h.from.replace(/_/g, ' ')).join(' → ')} while reversing gang ${gang.gang_number}`
            : `Removed while reversing gang ${gang.gang_number}`,
          qc, req.user.name);
      }
      const lines = await qc('SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines', [gang.id]);
      let n = 0;
      for (const line of lines) {
        // Once the run has been walked off the floor its members are coming back
        // whatever they read a moment ago — skipping them here is what would
        // strand an in_production line with no card under it.
        if (!force && !['planned', 'ready'].includes(line.status)) continue;
        // A gang member never SAVES a mix while it belongs to the gang —
        // plan-save 409s that outright — but a line CAN join a gang after
        // being individually planned with one (POST /gang-runs admits
        // 'planned' members). That mix is frozen against the cut plan this
        // reversal is erasing, exactly like a solo line's, so it cannot
        // survive here either — same reasoning as reverse_plan and
        // rollbackLine, per member instead of per line.
        await clearMixPlan(line.id, qc, req.user.name, `gang ${gang.gang_number} plan reversed — cut plan voided`);
        await qc(`UPDATE order_lines
                    SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL,
                        artwork_customer_ok=0, artwork_qa_ok=0, artwork_locked=0
                  WHERE id=$1`, [line.id]);
        await forceLineStatus(line.id, 'pending', `Gang ${gang.gang_number} plan reversed`, qc, oc, req.user.name);
        n++;
      }
      // The members' cleared mixes take the RUN-level leftover bank with them:
      // a merge run's LO-PLAN-RUN batches mirror the very mix this reversal
      // just voided, and leaving them would hold phantom planned stock against
      // a plan that no longer exists. No-op for a gang-kind run (never banks)
      // and for a merge that banked nothing.
      await unbankRunLeftover(gang.id, qc, oc, req.user.name,
        `${gang.gang_number} plan reversed — cut plan voided`);
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
      await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE id=$1", [line.id]);
      await audit('gang_run', gang.id, 'remove_line', `line ${line.id}`, qc, req.user.name);
      const left = await oc('SELECT COUNT(*)::int AS n FROM order_lines WHERE gang_run_id=$1', [gang.id]);
      if (left.n < 2) {
        await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE gang_run_id=$1", [gang.id]);
        // Last exit for the run row — with it gone no re-lock can ever
        // reconcile a merge run's LO-PLAN-RUN batches, so they zero here.
        // No-op for gang-kind runs and unbanked merges.
        await unbankRunLeftover(gang.id, qc, oc, req.user.name,
          `${gang.gang_number} dissolved — fewer than 2 jobs left`);
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
      await qc("UPDATE order_lines SET gang_run_id=NULL, stock_booking='book' WHERE gang_run_id=$1", [gang.id]);
      // Same last-exit sweep as remove-line's dissolve: a deleted run leaves
      // no re-lock to reconcile a merge's LO-PLAN-RUN batches.
      await unbankRunLeftover(gang.id, qc, oc, req.user.name, `${gang.gang_number} dissolved`);
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
    const out = await tx(async (qc, oc) => {
      // Read the gang INSIDE the transaction and lock it: two impatient clicks
      // must not both pass the "already covered?" check and both insert.
      await oc('SELECT id FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      const detail = await gangDetail(+req.params.id, oc, qc);
      if (!detail.position) throw Object.assign(new Error('This gang has no board yet'), { status: 400 });

      // ONE gang, ONE requisition. Board already on order for this run IS the
      // cover, so a second raise is refused and names the PR that already has
      // it, instead of silently minting a duplicate. A deliberate top-up
      // carries a reason — the same guard the single-line engine already uses.
      const already = detail.open_prs || [];
      if (already.length && !req.body.reraise_of) {
        throw Object.assign(
          new Error(`${detail.gang_number} is already covered by ${already.map(p => p.pr_number).join(', ')} — ${Math.round(detail.position.incoming).toLocaleString('en-IN')} sheets on order.`),
          { status: 409, body: { code: 'gang_pr_exists', existing: already, incoming: detail.position.incoming } });
      }
      if (req.body.reraise_of && !String(req.body.reraise_reason || '').trim())
        throw Object.assign(new Error('A reason is required to raise a second requisition for this gang'), { status: 400 });
      if (detail.position.short <= 0)
        throw Object.assign(new Error('No board shortage for this gang'), { status: 400 });

      const boardRow = await oc('SELECT leftover, name FROM materials WHERE id=$1', [detail.board_material_id]);
      if (boardRow?.leftover)
        throw Object.assign(new Error(`${boardRow.name} is a leftover offcut — a gang cannot raise a PR against it. Re-anchor the gang on a fresh board.`), { status: 409 });

      const neededBy = detail.members.map(m => m.delivery_date).filter(Boolean).sort()[0] || null;
      const pr_number = await nextNumber('CI-PR-', 'requisitions', 'pr_number', oc);
      // order_line_id anchors the PR to the run, so every later re-sync
      // (approve, edit qty, convert, delete) re-derives the same gang-wide
      // split without needing to know a gang was involved.
      const [pr] = await qc(
        `INSERT INTO requisitions (pr_number, material_id, qty, needed_by, reason,
                                   requested_by, priority, order_line_id, reraise_of, reraise_reason)
         VALUES ($1,$2,$3,$4,$5,$6,'normal',$7,$8,$9) RETURNING *`,
        [pr_number, detail.board_material_id, detail.position.short, neededBy,
         `Combined shortage for gang ${detail.gang_number} (${detail.members.length} jobs on ${detail.members[0].board_name})`,
         req.user.name, detail.members[0].id,
         req.body.reraise_of || null,
         req.body.reraise_of ? String(req.body.reraise_reason).trim() : null]);
      // A header with no line is not a purchasable requisition: it reports zero
      // items in procurement and converts to an empty PO. Every other PR path
      // writes one, and the gang's must too.
      await qc(`INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
                VALUES ($1,$2,$3,$4)`, [pr.id, detail.board_material_id, detail.position.short, neededBy]);
      await syncPrAllocation(qc, pr);
      await audit('requisition', pr.id, 'create_from_gang',
        `${pr_number} for ${detail.gang_number} — ${detail.members.length} jobs, one combined requisition`, qc, req.user.name);
      return pr;
    });
    res.json(out);
  } catch (e) { next(e); }
});

// Whose stock the RUN runs on — 'book' (free shelf stock counts toward the
// run, PR only the balance) or 'fresh_pr' (buy the FULL requirement; the shelf
// stays free for other jobs). ONE choice for the whole run — the pile is
// shared — stamped onto every member line because the committed-demand engine
// only ever reads order_lines. Persisted the moment the planner flips the
// toggle: a raised full-quantity PR with a stale 'book' flag would double-cover
// the run (full claim on the shelf AND full incoming).
r.post('/gang-runs/:id/stock-booking', canPlan, async (req, res, next) => {
  try {
    const mode = req.body.stock_booking;
    if (!['book', 'fresh_pr'].includes(mode))
      return res.status(400).json({ error: "stock_booking must be 'book' or 'fresh_pr'" });
    const out = await tx(async (qc, oc) => {
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      // Same edit window as the plan itself: once the card is minted the run's
      // board story is history, not a preference.
      const card = await oc('SELECT jc_number FROM job_cards WHERE gang_run_id=$1 LIMIT 1', [gang.id]);
      if (card)
        throw Object.assign(
          new Error(`Job card ${card.jc_number} is already minted — reverse it back to Planning before changing the run's stock booking.`),
          { status: 409 });
      // A run covering itself from a board MIX is booking the shelf by
      // definition — the same exclusivity plan-save enforces per line.
      if (mode === 'fresh_pr') {
        const mixed = await oc(`SELECT jbm.id FROM job_board_mix jbm
          JOIN order_lines ol ON ol.id = jbm.order_line_id
          WHERE ol.gang_run_id=$1 AND jbm.phase='plan' LIMIT 1`, [gang.id]);
        if (mixed)
          throw Object.assign(
            new Error(`${gang.gang_number} covers its board with a mix — a mix books the shelf. Clear the mix before buying fresh.`),
            { status: 409 });
      }
      await qc('UPDATE gang_runs SET stock_booking=$1 WHERE id=$2', [mode, gang.id]);
      await qc('UPDATE order_lines SET stock_booking=$1 WHERE gang_run_id=$2', [mode, gang.id]);
      await audit('gang_run', gang.id, 'stock_booking', `${gang.gang_number} → ${mode}`, qc, req.user.name);
      return { ok: true, stock_booking: mode };
    });
    res.json(out);
  } catch (e) { next(e); }
});


// ═══ Fixed Gang Templates — the plant's PERMANENT co-printed layouts ════════
// "Niko Standard": one 19x20 sheet, 12 ups, Niko 1 taking 8 and Niko 2 taking
// 4 — the die never changes, only order quantities do. A template is its OWN
// master: editing its ups edits the TEMPLATE, never the Product Master, and
// never reaches back into runs already created from it (they carry their own
// spec_override copies). The only way a product master changes is the planner
// changing it in the Product Master itself.

const TEMPLATE_VIEW = `
  SELECT t.*, COALESCE(sl.slots, '[]'::json) AS slots
  FROM gang_templates t
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'id', s.id, 'product_id', s.product_id, 'ups', s.ups,
             'product_name', p.name, 'product_code', p.code
           ) ORDER BY s.id) AS slots
    FROM gang_template_slots s JOIN products p ON p.id = s.product_id
    WHERE s.template_id = t.id
  ) sl ON true`;

function validateTemplateBody(body) {
  const name = String(body.name || '').trim();
  const child_l = +body.child_l, child_w = +body.child_w;
  const slots = (body.slots || [])
    .map(x => ({ product_id: Math.round(+x.product_id), ups: Math.round(+x.ups) }))
    .filter(x => x.product_id > 0);
  if (!name) throw Object.assign(new Error('A template needs a name'), { status: 400 });
  if (!(child_l > 0) || !(child_w > 0)) throw Object.assign(new Error('The fixed child sheet size is required — that is what makes the template fixed'), { status: 400 });
  if (slots.length < 2) throw Object.assign(new Error('A gang template needs at least two products'), { status: 400 });
  if (slots.some(x => !(x.ups > 0))) throw Object.assign(new Error('Every product on the template needs its ups'), { status: 400 });
  if (new Set(slots.map(x => x.product_id)).size !== slots.length)
    throw Object.assign(new Error('A product appears twice — give it the combined ups on one slot instead'), { status: 400 });
  return { name, child_l, child_w, notes: body.notes || null, slots };
}

r.get('/gang-templates', async (_req, res, next) => {
  try { res.json(await q(`${TEMPLATE_VIEW} WHERE t.active=1 ORDER BY t.name`)); } catch (e) { next(e); }
});

r.post('/gang-templates', canPlan, async (req, res, next) => {
  try {
    const t = validateTemplateBody(req.body);
    const id = await tx(async (qc, oc) => {
      const [row] = await qc(
        `INSERT INTO gang_templates (name, child_l, child_w, notes, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [t.name, t.child_l, t.child_w, t.notes, req.user.name]);
      for (const sl of t.slots) {
        await qc(`INSERT INTO gang_template_slots (template_id, product_id, ups) VALUES ($1,$2,$3)`,
          [row.id, sl.product_id, sl.ups]);
      }
      await audit('gang_template', row.id, 'create',
        `${t.name}: ${t.child_l}×${t.child_w}" · ${t.slots.length} products · ${t.slots.reduce((a, x) => a + x.ups, 0)} ups`, qc, req.user.name);
      return row.id;
    });
    res.json(await one(`${TEMPLATE_VIEW} WHERE t.id=$1`, [id]));
  } catch (e) { next(e); }
});

r.put('/gang-templates/:id', canPlan, async (req, res, next) => {
  try {
    const t = validateTemplateBody(req.body);
    await tx(async (qc, oc) => {
      const row = await oc('SELECT * FROM gang_templates WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!row) throw Object.assign(new Error('Template not found'), { status: 404 });
      await qc(`UPDATE gang_templates SET name=$1, child_l=$2, child_w=$3, notes=$4 WHERE id=$5`,
        [t.name, t.child_l, t.child_w, t.notes, row.id]);
      await qc(`DELETE FROM gang_template_slots WHERE template_id=$1`, [row.id]);
      for (const sl of t.slots) {
        await qc(`INSERT INTO gang_template_slots (template_id, product_id, ups) VALUES ($1,$2,$3)`,
          [row.id, sl.product_id, sl.ups]);
      }
      // The paper trail for "this changed the TEMPLATE, not the masters, and
      // not any run already created from it".
      await audit('gang_template', row.id, 'update',
        `${t.name}: ${t.child_l}×${t.child_w}" · ups now ${t.slots.map(x => x.ups).join('+')} — applies to runs created from here on; product masters and existing runs untouched`,
        qc, req.user.name);
    });
    res.json(await one(`${TEMPLATE_VIEW} WHERE t.id=$1`, [req.params.id]));
  } catch (e) { next(e); }
});

r.delete('/gang-templates/:id', canPlan, async (req, res, next) => {
  try {
    await tx(async (qc, oc) => {
      const row = await oc('SELECT * FROM gang_templates WHERE id=$1', [req.params.id]);
      if (!row) throw Object.assign(new Error('Template not found'), { status: 404 });
      await qc('UPDATE gang_templates SET active=0 WHERE id=$1', [row.id]);
      await audit('gang_template', row.id, 'retire', row.name, qc, req.user.name);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Which open lines can fill each slot — feeds the create-from-template picker.
r.get('/gang-templates/:id/candidates', async (req, res, next) => {
  try {
    const tpl = await one(`${TEMPLATE_VIEW} WHERE t.id=$1`, [req.params.id]);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const slots = typeof tpl.slots === 'string' ? JSON.parse(tpl.slots) : tpl.slots;
    const out = [];
    for (const sl of slots) {
      const lines = await q(`${MEMBER_VIEW}
        WHERE ol.status IN ('pending','planned') AND ol.gang_run_id IS NULL AND jc.id IS NULL
          AND p.id = $1
        ORDER BY o.delivery_date NULLS LAST, ol.id`, [sl.product_id]);
      out.push({
        ...sl,
        lines: lines.map(l => ({
          id: l.id, po_number: l.po_number, customer_name: l.customer_name,
          qty: l.qty, fg_consumed_qty: l.fg_consumed_qty, delivery_date: l.delivery_date, status: l.status,
        })),
      });
    }
    res.json({ template: tpl, slots: out });
  } catch (e) { next(e); }
});

// ── Create a run FROM a template ────────────────────────────────────────────
// The template STAMPS a shared-layout gang: each picked line gets the slot's
// ups and the template's child size as a spec_override — planning-record data
// only. Written EXPLICITLY (never cleared for coinciding with a master value),
// so a later master edit can never silently re-shape a template run.
r.post('/gang-templates/:id/create-run', canPlan, async (req, res, next) => {
  try {
    const picks = (req.body.picks || [])
      .map(x => ({ product_id: Math.round(+x.product_id), order_line_id: Math.round(+x.order_line_id) }))
      .filter(x => x.product_id > 0 && x.order_line_id > 0);
    const gangId = await tx(async (qc, oc) => {
      const tpl = await oc(`${TEMPLATE_VIEW} WHERE t.id=$1`, [req.params.id]);
      if (!tpl || !tpl.active) throw Object.assign(new Error('Template not found'), { status: 404 });
      const slots = typeof tpl.slots === 'string' ? JSON.parse(tpl.slots) : tpl.slots;

      // Every slot filled by exactly one line of ITS product.
      const byProduct = Object.fromEntries(picks.map(x => [x.product_id, x.order_line_id]));
      const missing = slots.filter(sl => !byProduct[sl.product_id]);
      if (missing.length) throw Object.assign(new Error(
        `Pick a sales order for ${missing.map(m => m.product_name).join(', ')} — the layout prints every product on the sheet`), { status: 400 });

      const lineIds = slots.map(sl => byProduct[sl.product_id]);
      const members = await qc(`${MEMBER_VIEW} WHERE ol.id = ANY($1) FOR UPDATE OF ol`, [lineIds]);
      if (members.length !== lineIds.length) throw Object.assign(new Error('One or more lines not found'), { status: 404 });
      for (const m of members) {
        const slot = slots.find(sl => sl.product_id === m.product_id);
        if (!slot) throw Object.assign(new Error(`${m.product_name} is not on this template`), { status: 409 });
        if (!['pending', 'planned'].includes(m.status))
          throw Object.assign(new Error(`${m.product_name} (${m.po_number}) is already ${m.status.replace('_', ' ')}`), { status: 409 });
        if (m.gang_run_id) throw Object.assign(new Error(`${m.product_name} (${m.po_number}) is already in a run`), { status: 409 });
        if (m.job_card_id) throw Object.assign(new Error(`${m.product_name} already has job card ${m.jc_number}`), { status: 409 });
      }

      const gang_number = await nextRunNumber('CI-GANG-', oc);
      const [gang] = await qc(
        `INSERT INTO gang_runs (gang_number, notes, created_by, layout_mode)
         VALUES ($1,$2,$3,'shared') RETURNING id`,
        [gang_number, `From template ${tpl.name}`, req.user.name]);

      for (const m of members) {
        const slot = slots.find(sl => sl.product_id === m.product_id);
        const line = await oc('SELECT spec_override FROM order_lines WHERE id=$1', [m.id]);
        const prev = line.spec_override
          ? (typeof line.spec_override === 'string' ? JSON.parse(line.spec_override) : line.spec_override)
          : {};
        // Template values are stamped EXPLICITLY — the run's own facts.
        const next2 = { ...prev, ups: slot.ups, child_l: tpl.child_l, child_w: tpl.child_w };
        await qc(`UPDATE order_lines SET gang_run_id=$1, spec_override=$2,
                    stock_booking=COALESCE((SELECT g2.stock_booking FROM gang_runs g2 WHERE g2.id=$1), 'book')
                  WHERE id=$3`,
          [gang.id, JSON.stringify(next2), m.id]);
      }
      await clearJoinersMix(members.map(m => m.id), gang_number, qc, req.user.name);
      await audit('gang_run', gang.id, 'create_from_template',
        `${gang_number} from ${tpl.name}: ${slots.map(sl => `${sl.product_code} ${sl.ups}up`).join(' + ')} on ${tpl.child_l}×${tpl.child_w}" — masters untouched`,
        qc, req.user.name);
      return gang.id;
    });
    res.json(await gangDetail(gangId));
  } catch (e) { next(e); }
});

export default r;
