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
  readiness, chosenCutsValid, chosenStrips, leftoverStrips, bankRunLeftover, unbankRunLeftover,
  bankPlanningLeftover, unbankPlanningLeftover, boardHoldCaps, releasePlanLockHolds,
} from '../helpers.js';
import { mixBalance, rowCovers, substitutionFlags, DEFAULT_MIX_REASON } from '../board-mix.js';
import { splitMixAcrossMembers, splitScaledMixAcrossMembers, runMixFromMembers, pressingOnPlanned } from '../gang-mix.js';
import { rankBoardMatches } from '../smartmatch.js';
import { gangSuggestions } from '../gang-suggest.js';
import { gangPosition, claimsByBoard, boardPosition, heldFor, stockHoldBudget } from '../board-allocation.js';
import { mergeCompat, mergeShares, membersAtRisk } from '../merge-rules.js';
import { sharedLayoutRun, splitProportional, agreedChildSize } from '../shared-layout.js';
import { syncPrAllocation } from './procurement.js';
import { commitBoardForLine, commitInputs } from './board.js';
import { requireRole, PLANNING_ROLES } from '../auth.js';

const r = Router();
const canPlan = requireRole(...PLANNING_ROLES);

// Effective spec — job-only overrides win over the product master (same
// expression the planning views use).
const MEMBER_VIEW = `
  SELECT ol.id, ol.order_id, ol.qty, ol.status, ol.gang_run_id,
         ol.sheets_required, ol.parent_sheets_required, ol.fg_consumed_qty,
         ol.dispatched_qty,
         ol.wastage_sheets, ol.spec_override, ol.stock_booking,
         o.po_number, o.delivery_date, c.name AS customer_name,
         p.id AS product_id, p.name AS product_name, p.code AS product_code, p.party_item_code, p.gsm,
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


// ── Which runs may bank their offcut as leftover stock ──────────────────────
//
// THE ONE SPELLING. Five call sites read this — the plan route's two bank arms,
// gangDetail's toggle seed, reDeriveMemberSheets' unbank, and production.js's
// cutting confirm — because an inline sixth copy is exactly how the gang anchor
// drifted before (see the anchor-one-spelling wave: a name-grep is blind to
// hand-written duplicates).
//
// A COMBINED run is one product on one pile, so its offcut has full product
// identity — it always could bank, and did, but only through a board mix.
//
// A SHARED-LAYOUT gang qualifies for the same reason: sharedLayoutState already
// refuses members carrying different child sizes, so the run has one child, one
// childFit and therefore one strip. The guillotine trims that strip off each
// parent as it cuts, so it reaches the leftover rack exactly when a single
// job's does — it does not wait for the die-cut split.
//
// A SEPARATE-LAYOUT gang does not. Every member cuts its own imposition off the
// shared pile, so one parent card stands for N different offcuts and no single
// strip describes it. That is the original exclusion, kept.
//
// kind==='merge' short-circuits DELIBERATELY. A merge converted before
// convert-to-merge began stamping layout_mode='separate' still carries a stale
// 'shared' — the plan route says it plainly: the kind is the truth, the
// layout_mode is a leftover. Reading layout first changes nothing today and is
// wrong the moment that stale value matters.
export function runBanksLeftover(gang) {
  return gang?.kind === 'merge'
      || (gang?.kind === 'gang' && gang?.layout_mode === 'shared');
}

// The sheet a run's offcut is measured on, and the child cut out of it.
//
// Must be the SAME pair the run's own fit was computed from, or the planner's
// card promises a strip the lock then refuses with a 409 they cannot explain —
// the exact failure the leftover-strip-parent wave paid for on single lines.
//
//   • merge → the lead member's effectiveParent: its declared parent trim
//     folded over the board, because a combined run is one product cut on its
//     own parent (the same runParent the mix arm's chosen-cuts check uses).
//   • shared gang → the shared board's OWN mother sheet. NEVER a member's solo
//     parent trim. That trim describes how the product cuts when planned
//     ALONE; a co-printed layout is its own geometry. CI-GANG-0010 paid for
//     this: a lead's 23×36 solo trim priced the run at 1,200 parent sheets
//     where the shared 25×36 board cuts 600.
//
// Pure — the caller resolves the board and the child. Null whenever the run
// cannot bank or is not measurable yet (no board, unsized child, pending
// layout), which every caller treats as "no card, nothing to bank".
export function runLeftoverBasis(gang, board, { mergeChild = null, sharedChild = null } = {}) {
  if (!runBanksLeftover(gang) || !board) return null;
  if (gang.kind === 'merge') {
    if (!mergeChild) return null;
    // Narrowed to the two dimensions on purpose. effectiveParent SPREADS the
    // board row to keep the rest of a material's fields for its other callers,
    // and this value is serialised to the browser — it would ship the board's
    // rates and reorder levels to a screen that reads only the sheet. Every
    // consumer of a basis (leftoverStrips, childFit, the client's clientStrips)
    // reads sheet_l/sheet_w and nothing else.
    const parent = effectiveParent(mergeChild, board);
    if (!(+parent.sheet_l > 0) || !(+parent.sheet_w > 0)) return null;
    if (!(+mergeChild.child_l > 0) || !(+mergeChild.child_w > 0)) return null;
    return {
      parent: { sheet_l: +parent.sheet_l, sheet_w: +parent.sheet_w },
      child: { child_l: +mergeChild.child_l, child_w: +mergeChild.child_w },
    };
  }
  if (!(+sharedChild?.l > 0) || !(+sharedChild?.w > 0)) return null;
  if (!(+board.sheet_l > 0) || !(+board.sheet_w > 0)) return null;
  return {
    parent: { sheet_l: +board.sheet_l, sheet_w: +board.sheet_w },
    child: { child_l: +sharedChild.l, child_w: +sharedChild.w },
  };
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

  // What each candidate is actually FREE to give this run.
  //
  // `available` above is the shelf — the gross sum of every available batch.
  // The Board Mix dropdown renders `c.free ?? c.available` and labels whichever
  // it gets "free" (BoardMix.jsx), so a candidate with no `free` set advertises
  // board that other jobs have already committed. That is not a cosmetic label:
  // Smart Match seeds its proposed sheets off the same figure, so an uncosted
  // run proposes to take stock that is not there and only discovers it at the
  // release gate — the identical fault fixed for single lines in orders.js's
  // mixCandidates block, which this mirrors call for call.
  //
  // The run's OWN members are excluded, exactly as the run's smart-match route
  // excludes them. Leave them in and the run's own saved mix reads as competing
  // demand: free would collapse toward zero on every save and the planner would
  // be told their own plan had taken the board. Excluding them from `lines` is
  // the whole exclusion — claimsByBoard sums `committed` off the LINES alone and
  // reads the allocation list only per line (heldFor/incomingFor filter it by
  // order_line_id), so an excluded member's holds can never reach the total.
  const candIds = candidates.map(c => c.id);
  if (candIds.length) {
    const [candLines, candAllocs] = await Promise.all([
      boardClaimLines(candIds, members.map(m => m.id), qc),
      qc(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [candIds]),
    ]);
    const candClaims = claimsByBoard({ lines: candLines, allocations: candAllocs });
    for (const c of candidates) {
      const claim = candClaims.get(c.id);
      c.committed = Math.round(claim?.committed || 0);
      // The save path measures its budget with stockHoldBudget, which also
      // reserves holds owned by lines OUTSIDE the claim set (a pending
      // draft's freeze). Quote the same figure here or the row offers more
      // than the lock will hold.
      const budget = stockHoldBudget({
        materialId: c.id, available: Number(c.available || 0),
        allocations: candAllocs, claimLines: candLines,
        ownerLineIds: members.map(m => m.id),
      });
      c.held = Math.round(budget.held);
      c.free = Math.round(budget.free);
      c.claimants = claim?.claimants || [];
    }
  }

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
    const rowIds = [...new Set(rows.map(r => r.material_id))];
    const avail = await qc(`
      SELECT m.id, COALESCE(av.q, 0)::float AS available
        FROM materials m
        LEFT JOIN (SELECT material_id, SUM(qty) AS q FROM stock_batches
                   WHERE status='available' GROUP BY material_id) av ON av.material_id = m.id
       WHERE m.id = ANY($1)`, [rowIds]);
    const byId = new Map(avail.map(a => [a.id, Number(a.available)]));
    // The SAVED rows get costed on the same rule as the candidates above — a
    // reopened mix must not read its board as freer than the "+ Add board" list
    // says it is, or the same board tells two different stories on one screen.
    // Own members excluded for the same reason: these rows ARE this run's holds.
    const [rowLines, rowAllocs] = await Promise.all([
      boardClaimLines(rowIds, members.map(m => m.id), qc),
      qc(`SELECT * FROM board_allocations WHERE status='active' AND material_id = ANY($1::int[])`, [rowIds]),
    ]);
    const rowClaims = claimsByBoard({ lines: rowLines, allocations: rowAllocs });
    for (const r of rows) {
      r.available = byId.get(r.material_id) ?? 0;
      const claim = rowClaims.get(r.material_id);
      r.committed = Math.round(claim?.committed || 0);
      // Same budget as the candidates above and the save itself — outsiders'
      // holds reserve too.
      const budget = stockHoldBudget({
        materialId: r.material_id, available: Number(r.available || 0),
        allocations: rowAllocs, claimLines: rowLines,
        ownerLineIds: members.map(m => m.id),
      });
      r.held = Math.round(budget.held);
      r.free = Math.round(budget.free);
      r.claimants = claim?.claimants || [];
    }
  }

  // Live run-level leftover batches — the RECORD of what the last lock banked
  // (there is deliberately no JSON column on gang_runs for this; the batches
  // themselves are the truth, exactly as the warehouse reads them).
  // The client seeds its per-row bank toggles from this list. material_id here
  // is the SOURCE board's — parsed back out of the batch key, because the
  // batch row itself carries the minted leftover MASTER's id, which is not
  // the id the mix rows (or the toggles) are keyed on.
  let leftoverBatches = [];
  if (runBanksLeftover(gang)) {
    const prefix = `LO-PLAN-RUN-${gang.id}-`;
    // initial_qty > 0 OR qty > 0 keeps a bank alive while another job draws
    // it down, yet drops a SWEPT row (unbankRunLeftover zeroes both) — a
    // strip the planner sent to waste must not seed its toggle back ON.
    // The minted master's own sheet dims ARE the strip that was banked, so the
    // no-mix card can reopen on the exact rectangle the planner picked instead
    // of defaulting to the largest and quietly re-banking a different one.
    leftoverBatches = (await qc(
      `SELECT sb.batch_no, sb.qty, m.sheet_l, m.sheet_w
         FROM stock_batches sb JOIN materials m ON m.id = sb.material_id
        WHERE sb.batch_no LIKE $1 AND (sb.initial_qty > 0 OR sb.qty > 0) ORDER BY sb.id`,
      [`${prefix}%`]))
      .map(b => ({
        material_id: Number(String(b.batch_no).slice(prefix.length)), qty: Number(b.qty),
        strip: { l: Number(b.sheet_l), w: Number(b.sheet_w) },
      }))
      .filter(b => Number.isFinite(b.material_id));
  }

  // ── A SEPARATE-layout gang's per-member offcuts ─────────────────────────
  //
  // It has no ONE strip — each member cuts its own imposition off the shared
  // pile — so instead of a single basis it gets one entry per member: the
  // geometry that member's own cut leaves, measured on the sheet its own fit
  // was struck on (its OWN board, not the lead's: a plain gang only WARNS when
  // members resolve to different boards). Same contract as leftover_basis —
  // the server measures, the client draws — so a per-member chip cannot promise
  // a strip the lock refuses. Empty for every other run.
  //
  // `banked` seeds the toggles from what the last lock actually wrote: a member
  // banks through the LINE's own v2 plan, so leftover_plan on its row IS the
  // record (MEMBER_VIEW does not carry that column — one small read here rather
  // than widening a view eleven other callers share).
  let memberLeftovers = [];
  if (gang?.kind === 'gang' && gang?.layout_mode !== 'shared') {
    const plans = new Map((await qc(
      'SELECT id, leftover_plan FROM order_lines WHERE id = ANY($1)',
      [members.map(m => m.id)])).map(r => [r.id, typeof r.leftover_plan === 'string'
        ? JSON.parse(r.leftover_plan) : r.leftover_plan]));
    memberLeftovers = effs.map((e, i) => {
      const own = { sheet_l: e.member.sheet_l, sheet_w: e.member.sheet_w };
      const p = effectiveParent(e.eff, own);
      const lp = plans.get(e.member.id);
      // Its own parents, by the LOCK's arithmetic — not memberParentSheets.
      // The run prints once, so the wastage allowance is booked to the LEAD
      // member alone and every other member carries zero; memberParentSheets
      // reads each member's own stored wastage and so quotes a non-lead member
      // ~100 parents too many. The card would then promise a strip count the
      // lock immediately contradicts (measured: card 5,100, banked 5,000).
      const w = i === 0 ? (Number(e.member.wastage_sheets) || 0) : 0;
      const fit = childFit(p, e.eff);
      const estParents = fit.count > 0
        ? parentSheetsRequired(sheetsRequired(e.eff, netProduceQty(e.member), w), fit.count)
        : 0;
      // The PLANNED board's row is the one the card shows and the planner
      // picked; a substitute's strip is derived at lock and never chosen here.
      const own_row = lp?.version === 2 && Array.isArray(lp.rows)
        ? lp.rows.find(r => +r.material_id === +e.member.board_material_id) : null;
      return {
        line_id: e.member.id,
        product_name: e.member.product_name,
        board_material_id: e.member.board_material_id,
        board_name: e.member.board_name,
        parent_l: +p.sheet_l || null, parent_w: +p.sheet_w || null,
        child_l: +e.eff.child_l || null, child_w: +e.eff.child_w || null,
        // Its own share of the run's issue — one strip per parent it cuts.
        est_parents: estParents,
        banked: !!(lp?.version === 2 && lp.rows?.length),
        strip: own_row?.strip ?? null,
      };
    });
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
    // The geometry the LOCK will measure this run's offcut on, handed to the
    // client rather than re-derived there. planned_parent_* above is the LEAD
    // MEMBER's effectiveParent, which is right for a merge and wrong for a
    // shared gang (whose cut runs on the board's own mother sheet) — so a
    // client that reached for it would draw a strip the lock refuses. Null
    // when the run does not bank or is not measurable yet; the card then does
    // not render at all.
    //
    // The shared child mirrors the plan route's own soft gate: the stamped
    // override if there is one, else the size the members' effective specs
    // already agree on — MEMBER_VIEW's child_l/child_w are COALESCE(override,
    // master), the same effective pair the route feeds agreedChildSize.
    leftover_basis: runLeftoverBasis(gang, board, {
      mergeChild: effs[0].eff,
      sharedChild: sharedLayoutState(gang, members).child
        || agreedChildSize(members.map(m => ({ l: m.child_l, w: m.child_w }))),
    }),
    // A SEPARATE-layout gang has no ONE strip, so it gets one entry per member
    // instead: the geometry that member's own cut leaves, on the sheet its own
    // fit was struck on. Same contract as leftover_basis — the server measures,
    // the client draws — so the per-member chips cannot promise a strip the
    // lock refuses. Empty for every other run (which uses leftover_basis).
    leftover_members: memberLeftovers,
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

  // CO-PRINTED run figures, computed up front because Board Position must
  // quote them: one sheet prints every member, so the run needs the MAX any
  // member requires — parent-converted with the SAME childFit chain the plan
  // lock uses. The members' stored figures may still be a pre-lock sum (or a
  // stale save from before a ups edit), and charging that sum against the
  // shelf demands roughly double the board the run actually cuts.
  // Null whenever the run is not computable (pending layout, missing ups) —
  // every reader then falls back to the classic per-member sum, unchanged.
  const sharedLayout = gang.kind !== 'merge' && gang.layout_mode === 'shared'
    ? sharedLayoutState(gang, withSheets) : null;
  let sharedRun = null;
  if (sharedLayout && !sharedLayout.pending) {
    try {
      const layoutRun = sharedLayoutRun(
        withSheets.map(m => ({ id: m.id, net: netProduceQty(m), ups: m.ups })),
        { wastage: withSheets[0]?.wastage_sheets ?? 0 });
      // Shared board's own sheet, not the lead's solo parent trim — the same
      // geometry rule as the plan lock (see its comment).
      const m0 = withSheets[0];
      const fit = childFit(
        { sheet_l: m0.sheet_l, sheet_w: m0.sheet_w },
        { child_l: sharedLayout.child.l, child_w: sharedLayout.child.w });
      sharedRun = {
        ...layoutRun,
        cpp: fit.count,
        run_parent: parentSheetsRequired(layoutRun.run_child, fit.count),
        need_parent: parentSheetsRequired(layoutRun.need_child, fit.count),
      };
    } catch { sharedRun = null; }
  }

  let position = null;
  let otherBoardPositions = [];
  let openPrs = [];
  let otherPrs = [];
  if (boardId) {
    const memberIds = withSheets.map(m => m.id);
    // Members grouped by their OWN effective board. A plain gang normally
    // shares one board, but a member carrying a spec_override to a different
    // board is a legal pre-lock state — and charging the WHOLE run's parent
    // sheets to member[0]'s board while the other board went unexamined
    // overstated the lead board's demand by exactly the other members' share
    // and never asked whether the other board was there at all. The plan lock
    // has always grouped per board (its byBoard loop); the detail's position
    // simply never did.
    const boardsOf = new Map();
    for (const m of withSheets) {
      if (!m.board_material_id) continue;
      if (!boardsOf.has(m.board_material_id)) boardsOf.set(m.board_material_id, []);
      boardsOf.get(m.board_material_id).push(m);
    }
    const allBoardIds = [...boardsOf.keys()];
    // Committed-other comes off the SAME arithmetic as the planning engine,
    // Smart Match and the Board panel — claimsByBoard over boardClaimLines —
    // not a hand-rolled SUM. That nets drawn lines (their sheets already left
    // the shelf) and fences rival fresh_pr plans to their own incoming PRs.
    // Board already ON ORDER for any member is coverage for the run. Without
    // this the gang's "Short" is identical before and after a successful raise,
    // which is exactly how CI-GANG-0007 collected four full-size PRs.
    const [allocations, otherLines, avRows] = await Promise.all([
      qc(`SELECT * FROM board_allocations WHERE material_id = ANY($1::int[]) AND status='active'`, [allBoardIds]),
      boardClaimLines(allBoardIds, memberIds, qc),
      qc(`SELECT material_id, SUM(qty)::float AS q FROM stock_batches
          WHERE material_id = ANY($1::int[]) AND status='available' GROUP BY material_id`, [allBoardIds]),
    ]);
    const availById = new Map(avRows.map(r => [Number(r.material_id), Number(r.q) || 0]));
    const claims = claimsByBoard({ lines: otherLines, allocations });
    const claimLineIds = new Set(otherLines.map(l => Number(l.id)));
    const memberIdSet = new Set(memberIds.map(Number));
    // One position per board, all off the same books. heldOthers is stock
    // frozen by lines OUTSIDE the members and OUTSIDE the claim set — a
    // pending line's draft freeze, an orphan. Claim lines' holds already sit
    // inside committedOther (their FULL requirement is counted), so adding
    // them here would bill the same sheets twice; only the outsiders are new
    // information. Without this the run read "Stock OK" against board a saved
    // draft had already frozen.
    const positionFor = (mid, needed, neededGross = needed) => {
      const heldOthers = allocations
        .filter(a => a.status === 'active' && a.source === 'stock'
          && Number(a.material_id) === Number(mid)
          && !memberIdSet.has(Number(a.order_line_id))
          && !claimLineIds.has(Number(a.order_line_id)))
        .reduce((s, a) => s + Number(a.qty || 0), 0);
      return {
        ...gangPosition({
          needed,
          committedOther: claims.get(mid)?.committed || 0,
          heldOthers,
          available: availById.get(Number(mid)) || 0,
          allocations, memberIds, materialId: mid,
          stockBooking: gang.stock_booking || 'book',
        }),
        // The SAME requirement before any mix credit is taken off it.
        //
        // `needed` answers "what does this board owe, given the mix we have
        // SAVED" — right for every reader here, and wrong for the one reader
        // that is looking at a mix still being TYPED. The engine re-applies
        // pressingOnPlanned to the live rows (client/src/lib/gangShort.js) and
        // needs the figure the credit comes off, or it would either credit the
        // draft twice or not at all. Subtracting the saved mix back out of
        // `needed` cannot recover it — the max() in the rule has already
        // clamped it. New field; existing readers of `position` are untouched.
        needed_gross: Number(neededGross) || 0,
      };
    };
    // The LEAD board answers for its own members' sheets, not the whole
    // run's. A shared (co-printed) layout is the exception by construction:
    // one sheet prints every member, the lock enforces one board, so the run
    // figure stays lead-board-scoped.
    const leadParent = sharedRun
      ? totalParent
      : (boardsOf.get(boardId) || []).reduce((s, m) => s + m.parent_sheets, 0);
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
    // A co-printed run demands what the floor will actually DRAW: the
    // planner's stored issue override when one is set (the lock distributes
    // it across members and the job card issues that sum), else the computed
    // run parent. Quoting the computed figure past a live override would say
    // "Stock OK" on a run about to draw more (override up) or buy board the
    // floor never takes (override down). The engine shows the override chip
    // beside the computed figure, so a stale override is loud, not silent.
    const requiredOnPlanned = sharedRun ? (gang.issue_parent_sheets ?? sharedRun.run_parent) : leadParent;
    const neededOnPlanned = pressingOnPlanned({
      required: requiredOnPlanned,
      active: !!mix?.active,
      covered: mix?.covered, heldOnPlanned: mix?.held_on_planned });
    position = positionFor(boardId, neededOnPlanned, requiredOnPlanned);
    // Any member running on a DIFFERENT board gets that board its own
    // position — same books, its own members' demand — so a two-board gang
    // stops hiding the second board's shortage inside the first's surplus.
    // New field; existing readers of `position` are untouched.
    otherBoardPositions = [...boardsOf.entries()]
      .filter(([mid]) => Number(mid) !== Number(boardId))
      .map(([mid, ms]) => ({
        board_material_id: mid,
        board_name: ms[0]?.board_name ?? null,
        member_line_ids: ms.map(m => m.id),
        needed: ms.reduce((s, m) => s + m.parent_sheets, 0),
        position: positionFor(mid, ms.reduce((s, m) => s + m.parent_sheets, 0)),
      }));
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
      total_parent_sheets: totalParent, position, other_board_positions: otherBoardPositions, open_prs: openPrs, mix,
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
    const layout = sharedLayout;
    // qc, never the module-level q: raise-pr calls gangDetail inside its
    // transaction, and on a one-client serverless pool a pool read from in
    // there deadlocks. The .catch would swallow it, so the only symptom would
    // be the die panel silently emptying after a ten-second stall.
    const die = await findDieTemplate(withSheets.map(m => m.product_id), qc, oc).catch(() => null);
    // The hoisted run above — now carrying cpp / run_parent / need_parent so
    // the engine's client twin and this payload can never disagree on the
    // parent conversion.
    const layoutRun = sharedRun;
    return {
      ...gang, members: withSheets, board_material_id: boardId,
      total_parent_sheets: totalParent, position, other_board_positions: otherBoardPositions, open_prs: openPrs, other_prs: otherPrs, mix,
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
  return { ...gang, members: withSheets, board_material_id: boardId, total_parent_sheets: totalParent, position, other_board_positions: otherBoardPositions, open_prs: openPrs, other_prs: otherPrs, mix, compat: gangCompat(withSheets) };
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
      // layout_mode drops to 'separate': a combined run is one product, so
      // "co-printed" is meaningless for it, and a leftover 'shared' would
      // otherwise steer the plan lock into MAX maths on a run whose truth is
      // the SUM of its sales orders. (The lock and reDeriveMemberSheets also
      // guard on kind, for merges converted before this stamp existed.)
      await qc(`UPDATE gang_runs SET kind='merge', layout_mode='separate', gang_number=$1, product_id=$2 WHERE id=$3`,
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
        // The layout decides whether this run may bank an offcut at all — a
        // co-printed gang has one child and one strip, a separate one has as
        // many as it has members. So flipping to 'separate' strands whatever a
        // shared lock banked: live stock on a run that is no longer allowed to
        // hold any, with no screen left that could give it back. Sweep it here.
        // The other direction is a clean no-op (nothing was banked), and this
        // route already refuses a merge above, so one unconditional call is the
        // whole rule. The re-lock the planner must now do re-banks if they
        // still want it.
        await unbankRunLeftover(gang.id, qc, oc, req.user.name,
          `layout ${gang.layout_mode} → ${mode}`);
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
    // A DRAFT save is the run's "save my work", the same offer a single line has
    // (orders.js's plan route): every figure on the screen is written exactly as
    // a lock writes it — member sheets, the split mix and its holds, the merge
    // leftover bank — but no member leaves the To Plan list. It is not a weaker
    // save; it is the same save without the status flip, so reopening the run
    // engine finds the work where the planner left it.
    //
    // Safe for the same reason it is safe on a line: BOARD_DEMAND_STATUSES
    // starts at 'planned', so members still sitting at 'pending' raise no
    // derived demand and reach no station. The one thing a draft DOES commit is
    // board — replaceMixPlan mirrors every mix row into board_allocations — and
    // that is precisely what this route's discard twin exists to give back.
    const draft = !!req.body.draft;
    // Boards the run's mix planned but the shelf could not cover. Collected
    // inside the transaction, spoken after it commits — the plan is saved.
    const boardShortfalls = [];
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
      // The parent + child this run's offcut is measured on, captured by
      // whichever branch below computes the run's fit so the two can never
      // drift apart. Null for a run that does not bank (a separate-layout
      // gang) or cannot be measured yet. See runLeftoverBasis.
      let loBasis = null;
      // kind guard: a COMBINED RUN is one product across N sales orders — its
      // run is the SUM of every order, so it must never take the co-printed
      // MAX. Convert-to-merge now stamps layout_mode='separate', but a merge
      // converted before that stamp existed still carries 'shared'; the kind
      // is the truth, the layout_mode is a leftover.
      if (gang.kind !== 'merge' && gang.layout_mode === 'shared') {
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
        // The parent conversion runs on the SHARED BOARD's own sheet — never
        // a member's solo parent trim (effectiveParent). A trim describes how
        // that product cuts when planned ALONE on its own parent; the
        // co-printed layout is its own geometry: the locked child on the sheet
        // the gang actually buys. CI-GANG-0010's lead carried a 23×36 solo
        // trim that fits the 18×25 child once, and the lock priced the run at
        // 1,200 parent when the shared 25×36 board cuts it twice — 600.
        const fit = childFit(board, { child_l: child.l, child_w: child.w });
        // Same (board, child) pair, so the strip the planner ticked is cut out
        // of the very sheet this fit was struck on.
        loBasis = runLeftoverBasis(gang, board, { sharedChild: child });
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
        //
        // A DRAFT is not that decision, so it remembers nothing. The die memory
        // is shared state: it seeds every FUTURE gang of this product
        // combination, and a half-finished layout the planner is still moving
        // around would propagate out of this run into the next one and outlive
        // the discard that threw it away. The spec_override stamp above is a
        // different thing and still happens on a draft — it is local to these
        // members and is exactly what makes the saved figures re-derivable.
        if (!draft) await rememberDie(gang, lines, effs, child, qc, oc, req.user.name);
        if (childAdopted) adoptedChildNote = ` · layout ${child.l}×${child.w}" adopted from the members' spec and saved`;
      } else {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const master = await oc('SELECT * FROM products WHERE id=$1', [line.product_id]);
        const eff = effectiveProduct(master, line);
        const board = await oc('SELECT * FROM materials WHERE id=$1', [eff.board_material_id]);
        const parent = effectiveParent(eff, board);
        const fit = childFit(parent, eff);
        // A COMBINED run is one product, so the lead member's parent IS the
        // run's — the same effectiveParent the mix arm's runParent uses. A
        // separate-layout gang leaves this null: N members, N impositions, so
        // there is no ONE strip. Its members bank individually instead, off the
        // per-member geometry carried on each plan entry below.
        if (i === 0) loBasis = runLeftoverBasis(gang, board, { mergeChild: eff });
        const w_i = i === 0 ? (wastage ?? line.wastage_sheets ?? 0) : 0;
        const sheets = sheetsRequired(eff, netProduceQty(line), w_i);
        const parentSheets = parentSheetsRequired(sheets, fit.count);
        // `board` and `parent` ride along so the per-member leftover arm can
        // measure each member's offcut on the very sheet its own fit was struck
        // on, without re-selecting a board it would then have to keep in step.
        plan.push({ line, eff, fit, sheets, parentSheets, wastage: w_i, board, parent });
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
        if (line.status === 'pending' && !draft) {
          await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
          // Twin of the single-line lock in orders.js, and the case it exists
          // for is the one Anik described: a gang whose setup is settled and
          // designed long before its board is covered. Every member can arrive
          // at this lock with its artwork already done, and no promotion to
          // 'ready' fires on a line that was 'pending' when artwork/lock ran.
          // Per member, because artwork is approved and locked per member.
          const fresh = await oc('SELECT * FROM order_lines WHERE id=$1', [line.id]);
          const gate = await readiness(fresh, oc);
          if (gate.artwork && gate.tooling && (gate.material || gate.material_pending)) {
            await setLineStatus(fresh.id, 'ready', qc, oc, req.user.name);
          }
        }
        // A member can carry a mix from being individually planned BEFORE it
        // joined the gang — Planning refuses to SAVE a new mix on a ganged
        // line (see orders.js's plan-save gang guard) but never clears one
        // already there when the line is added to a gang (POST /gang-runs and
        // /add-lines only set gang_run_id). This UPDATE just replaced the cut
        // plan that mix's ups/covers were frozen against, exactly the case
        // clearMixPlan exists for.
        //
        // EXCEPT for a draft that said nothing about the mix. A save with a
        // half-built mix omits the key precisely so the stored rows survive —
        // and clearing them here deleted the very thing that omission was
        // protecting, so "save my work" cost the planner their mix. (Measured:
        // 417 sheets stored, Save with the mix withheld, 0 rows left.) This is
        // the same condition orders.js already applies for a line —
        // `!draft || Array.isArray(req.body.mix)` — so the two engines agree
        // about what saying nothing means. An EMPTIED mix still arrives as `[]`,
        // which is a real instruction to clear and passes this guard.
        if (!draft || Array.isArray(req.body.mix)) {
          await clearMixPlan(line.id, qc, req.user.name,
            `gang ${gang.gang_number} planned — cut plan changed`);
        }
        await audit('order_line', line.id, draft ? 'plan_draft' : 'planned',
          `${sheets} child → ${parentSheets} parent (${fit.count}/parent, ${eff.ups} ups) — gang plan ${gang.gang_number}`
          + (draft ? ' (saved, lock pending)' : ''),
          qc, req.user.name);
      }
      // Does this save carry a board mix? Asked ONCE, here, because two things
      // below turn on the same answer: the freeze must stand down for a mixed
      // save, and section 4 stores the mix. Two spellings of one predicate is
      // how a freeze and a mix end up both believing they own the sheets.
      const wantsMix = Array.isArray(req.body.mix) && req.body.mix.length > 0;

      // ── FREEZE THE RUN'S BOARD, ONE HOLD PER MEMBER ─────────────────────
      //
      // A run draws from ONE pile, so the cap is struck ONCE and split across
      // the members drawing on it. Freezing member by member without a shared
      // cap would let the first members take everything free and starve the
      // last — and because commitBoardForLine refuses past `free`, the last
      // member's 409 would roll back this entire lock, every member's figures
      // with it.
      //
      // The rows go on MEMBERS, never on the run. board_allocations.order_line_id
      // is NOT NULL and carries no gang column, and every gang reader
      // (gangIncoming, gangPosition, claimsByBoard) sums rows keyed on member
      // lines — a parent-level row would be invisible to the run's own shortage
      // figure, which is the number this exists to make honest.
      //
      // No branch on gang vs merge. The kind decides how each member's parent
      // sheets were DERIVED — the child for a gang, the master for a combined
      // run — and the persist loop above has just written that figure. `issued`
      // IS that figure, still in hand: reading it back out of order_lines would
      // be N round trips for a number this scope already holds.
      //
      // ONE CAP PER BOARD, which is what "one pile" actually means. A shared
      // layout is forced onto a single board (the `boards.length !== 1` refusal
      // above) and so is a merge, but a plain gang only WARNS when its members
      // resolve to different boards. Grouping by each member's own effective
      // board is identical to a run-level cap whenever they agree, and stops a
      // mixed gang from freezing member 0's board against a member that never
      // touches it — a wrong hold where before there was none.
      //
      // RELEASE FIRST, ALWAYS — unconditional, and outside the commit gate
      // below. The same four hazards orders.js records: a re-plan that CHANGES
      // the board (commitBoardForLine is per-material and would strand the old
      // board's row), one that SHRINKS the requirement (it returns early on
      // `want - alreadyHeld <= 0` and never releases the surplus), one that
      // ADOPTS a mix, and plain idempotence.
      for (const line of lines) {
        await releasePlanLockHolds(line.id, qc, req.user.name, 'run re-planned');
      }
      // wantsMix — replaceMixPlan in section 4 writes one hold per mix row per
      // member, and Phase 1 deliberately stopped its ABSORB from touching an
      // origin='plan_lock' row. So a freeze written here would not be absorbed
      // by the mix: the two would STACK, and the run would hold its board twice
      // over on every single save. orders.js excludes a mixed save for exactly
      // this reason and says so at its own freeze site. The release above still
      // runs, so a run that GAINS a mix hands its old freeze back first rather
      // than leaving it stranded underneath.
      if (!wantsMix) {
        // Members grouped by the board each one actually draws — from the
        // effective spec already resolved for the cut plan (effectiveProduct
        // spreads spec_override over the master, which is EFF_BOARD_ID's rule),
        // not re-derived in SQL.
        const byBoard = new Map();
        for (let idx = 0; idx < plan.length; idx++) {
          const boardId = +plan[idx].eff.board_material_id;
          const need = Number(issued[idx] || 0);
          if (!(boardId > 0) || !(need > 0)) continue;
          if (!byBoard.has(boardId)) byBoard.set(boardId, []);
          byBoard.get(boardId).push({ id: plan[idx].line.id, need });
        }
        // Board ids sorted, so two concurrent saves of two mixed-board runs
        // that share boards cannot take the per-board advisory locks in
        // opposite order and deadlock. Map insertion order here is member
        // order, which is arbitrary.
        for (const boardId of [...byBoard.keys()].sort((a, b) => a - b)) {
          const members = byBoard.get(boardId);
          const [avail, allLines, allocs] = await commitInputs(boardId, qc);
          const { free } = boardPosition({
            available: avail, allocations: allocs, lines: allLines, materialId: boardId,
          });
          // The budget is the board's FREE sheets and nothing else.
          //
          // Seeding it with the sum of what members already hold looks like it
          // makes a re-save idempotent, but it pools ONE member's hold into a
          // budget ANOTHER member can spend — and commitBoardForLine re-reads
          // the position itself and refuses when the delta exceeds free.
          // Member A's hold is not free for member B, so B's commit throws
          // COMMIT_EXCEEDS_FREE and rolls back this entire lock: every member's
          // sheets, the status flips, the die memory, the mix. That is exactly
          // the failure the shared cap exists to prevent.
          //
          // Each member may draw on its OWN hold plus the shared free pool, and
          // only the NEW consumption is charged against the pool — the same
          // shape the single-line freeze uses in orders.js. Reachable whenever
          // a member carries a hand-placed commit: releasePlanLockHolds above
          // is scoped origin='plan_lock' and deliberately leaves those alone.
          let budget = Math.max(0, free);
          for (const m of members) {
            const own = heldFor(allocs, m.id, boardId);
            const want = Math.min(m.need, own + budget);
            if (want <= 0) continue;
            await commitBoardForLine({
              materialId: boardId,
              lineId: m.id,
              want,
              reason: `Frozen by the planning engine for ${gang.gang_number}`,
              origin: 'plan_lock',
              user: req.user.name,
            }, qc);
            budget -= Math.max(0, want - own);
          }
        }
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
      if (wantsMix) {
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
        // A SHARED-LAYOUT gang has a planned parent too — the board's own
        // mother sheet, which is what its fit was struck on — and its leftover
        // arm below needs it. The merge expression is left spelled out rather
        // than folded into loBasis so this line stays byte-identical for the
        // path that already shipped: loBasis is null for a merge whose child is
        // unsized, and chosenCutsValid must not start seeing null there.
        const runParent = isMerge ? effectiveParent(plan[0].eff, board) : (loBasis?.parent ?? null);
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
        // CAPPED, NEVER REFUSED — same rule as a single line's lock. Measured
        // ONCE at run level; the map is then drawn down by each member's
        // replaceMixPlan so the run's members share one ceiling.
        const { caps: mixCaps, shortfalls } = await boardHoldCaps(runRows, lines.map(l => l.id), qc);
        boardShortfalls.push(...shortfalls);

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
          await replaceMixPlan(share.member_id, rows, qc, req.user.name, mixCaps);
        }
        await audit('gang_run', gang.id, 'board_mix',
          runRows.map(r => `${r.sheets} of material ${r.material_id}`).join('; ').slice(0, 500),
          qc, req.user.name);

        // ── Run-level leftover banking ───────────────────────────────────
        // Mirrors orders.js's v2 per-row bank, at run level: banking is
        // opt-in per mix row (req.body.mix_leftovers), the strip is derived
        // HERE from the row's own geometry — planned row off the run's
        // planned parent, substitute off its own mother sheet, the same
        // runRowParentFor the chosen-cuts validation used, so cuts and
        // strips can never disagree about the sheet. Batch qty is Task 4's
        // unit: strips = strips_per_parent × that board's RUN-level parent
        // sheets; cutting-complete trues it to spp × actual parents. The
        // keep-list makes the sweep reconcile: dropped rows and toggled-off
        // boards zero, survivors delta through bankRunLeftover itself.
        //
        // Gated on the KIND predicate, so a SHARED-LAYOUT gang banks here too.
        // Without this arm it could bank on its plain board and then silently
        // could not the moment the planner covered a shortage with a second
        // one — the same hole this wave closes for a combined run. A
        // SEPARATE-layout gang still banks nothing: one parent card stands for
        // N impositions and no single strip describes it.
        //
        // The predicate and not loBasis, because the SWEEP has to run for an
        // eligible run whether or not its cut is measurable — a run that loses
        // its child size must not keep stock banked against a cut nobody can
        // still quote. An unmeasurable run that is ASKED to bank refuses.
        if (runBanksLeftover(gang)) {
          const bankWanted = new Map(
            (Array.isArray(req.body.mix_leftovers) ? req.body.mix_leftovers : [])
              .map(x => [+x.material_id, !!x.bank]));
          const banked = [];
          for (const r of runRows) {
            if (!bankWanted.get(r.material_id)) continue;
            const mat = matById.get(r.material_id);
            if (!loBasis) throw Object.assign(new Error(
              `${gang.gang_number} has no settled cut to measure an offcut on — set the run's board and child sheet size first`),
              { status: 409 });
            const rowParent = runRowParentFor(r.role, mat);
            // A merge row carries its cuts (chosen or natural); a gang row
            // carries none — the differing-cuts 409 still stands for a gang,
            // so its cuts ARE the board's natural fit for the run's one
            // child, and chosenStrips collapses to leftoverStrips there.
            const rowUps = r.ups ?? childFit(rowParent, loBasis.child).count;
            const strips = chosenStrips(rowParent, loBasis.child, rowUps);
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
      } else if (runBanksLeftover(gang) && (!draft || Array.isArray(req.body.mix))) {
        // ── The run's offcut with NO mix ─────────────────────────────────
        //
        // The ordinary case, and until now the one with no way to bank at all:
        // one run, one board, no substitute. The option existed only as a side
        // effect of opening a Board Mix, and re-locking without one took back
        // whatever a mixed lock had banked.
        //
        // The payload is the SINGLE LINE's own shape — `leftover: {push,
        // strip}` — because this is the same decision a solo job makes, and
        // giving the run a different spelling would be one more thing to keep
        // in step. The strip is validated against the run's real cut and
        // refused with the same sentence orders.js uses, so a card quoting a
        // stale geometry cannot write stock measured on a sheet nobody cuts.
        //
        // Qty is strips_per_parent × the run's ISSUED parent sheets — the same
        // total the mix arm balances against, so an issue override is priced
        // in. Cutting-complete then trues it to the actual parents cut.
        //
        // The draft exemption above is unchanged and load-bearing for both
        // arms: a draft that withheld its mix left the members' rows in place,
        // and the bank mirrors those rows — sweeping here would leave the
        // preserved mix with its planned offcut taken back off the shelf.
        const wantsBank = req.body.leftover?.push && req.body.leftover?.strip;
        let banked = null;
        if (wantsBank) {
          if (!loBasis) throw Object.assign(new Error(
            `${gang.gang_number} has no settled cut to measure an offcut on — set the run's board and child sheet size first`),
            { status: 409 });
          const want = req.body.leftover.strip;
          const pick = leftoverStrips(loBasis.parent, loBasis.child).find(s =>
            s.usable
            && Math.abs(s.l - +want.l) < 0.01 && Math.abs(s.w - +want.w) < 0.01);
          if (!pick) throw Object.assign(
            new Error('Leftover strip does not match this run\'s cut plan'), { status: 409 });
          const srcBoard = await oc('SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE id=$1',
            [plan[0].eff.board_material_id]);
          if (!srcBoard) throw Object.assign(
            new Error('The run has no board to bank an offcut from'), { status: 409 });
          banked = { srcBoard, strip: pick, spp: pick.strips_per_parent || 1 };
        }
        // Sweep first, keeping only what this save is about to re-bank —
        // bankRunLeftover's own delta logic reconciles the survivor. Same
        // keep-list contract as the mix arm.
        await unbankRunLeftover(gang.id, qc, oc, req.user.name,
          banked ? 'run leftover re-planned' : 'plan re-locked without a leftover',
          banked ? [`LO-PLAN-RUN-${gang.id}-${banked.srcBoard.id}`] : []);
        if (banked) {
          await bankRunLeftover(gang.id, banked.srcBoard, banked.strip, banked.spp,
            banked.spp * issuedTotal, qc, oc, req.user.name);
        }
      }

      // ── A SEPARATE-LAYOUT gang banks PER MEMBER ─────────────────────────
      //
      // The run-level arms above cannot speak for it: each member cuts its own
      // imposition off the shared pile, so one parent card stands for N
      // different offcuts. But each of those offcuts is perfectly well defined
      // — it is exactly the strip that member would leave planned alone — so
      // the decision is per member, and the bank is the LINE's own v2 bank
      // (batch LO-PLAN-<lineId>-<materialId>, leftover_plan on the member's
      // row). No new storage: a separate gang's member IS a line being cut on
      // its own terms, and reusing the line machinery means the sweep
      // (unbankPlanningLeftover), the reverse path and the warehouse's own
      // reading of a line bank all work here unchanged.
      //
      // Payload: `leftovers: [{ line_id, push, strip }]` — one decision per
      // member. Absent entirely means "no opinion", which on a lock is the same
      // as none, and the sweep below is what makes that true.
      //
      // Runs on the SAME draft rule as the arms above, and for the same reason:
      // a draft withholding its mix must not sweep a bank that mirrors it.
      if (gang.kind === 'gang' && gang.layout_mode !== 'shared'
          && (!draft || Array.isArray(req.body.mix))) {
        const wanted = new Map(
          (Array.isArray(req.body.leftovers) ? req.body.leftovers : [])
            .map(x => [+x.line_id, x]));
        for (let idx = 0; idx < plan.length; idx++) {
          const { line, eff, board, parent } = plan[idx];
          const want = wanted.get(line.id);
          // Which boards this member actually draws, and how many parents off
          // each. With a mix that is its split share, already written above by
          // replaceMixPlan; without one it is the whole of its issue off its
          // own planned board. Reading the stored rows rather than re-deriving
          // means the bank can never disagree with what the floor will cut.
          const rows = wantsMix ? await mixFor(line.id, 'plan', qc) : [];
          const draws = rows.length
            ? rows.map(r => ({ material_id: +r.material_id, sheets: Number(r.sheets) || 0,
                               role: r.role }))
            : [{ material_id: +eff.board_material_id, sheets: Number(issued[idx]) || 0,
                 role: 'planned' }];

          const v2Rows = [];
          const keep = [];
          if (want?.push && want?.strip) {
            for (const d of draws) {
              if (!(d.material_id > 0) || !(d.sheets > 0)) continue;
              const mat = d.material_id === +eff.board_material_id
                ? board
                : await oc('SELECT id, name, spec, sheet_l, sheet_w FROM materials WHERE id=$1', [d.material_id]);
              if (!mat) continue;
              // The same rowParentFor asymmetry every other arm uses: this
              // member's planned board cuts from its trimmed parent, a
              // substitute from its own mother sheet.
              const rowParent = d.role === 'planned' && d.material_id === +eff.board_material_id
                ? parent : { sheet_l: mat.sheet_l, sheet_w: mat.sheet_w };
              const usable = leftoverStrips(rowParent, eff).filter(s => s.usable);
              if (!usable.length) continue;   // this board leaves nothing — skip it, not the member
              // The PLANNED board must yield the strip the planner ticked; a
              // substitute has its own geometry the planner never saw, so it
              // banks whatever it actually leaves (largest by area, the same
              // pick every other arm takes).
              const isPlanned = d.material_id === +eff.board_material_id;
              const pick = isPlanned
                ? usable.find(s => Math.abs(s.l - +want.strip.l) < 0.01
                                && Math.abs(s.w - +want.strip.w) < 0.01)
                : [...usable].sort((a, b) => (b.l * b.w) - (a.l * a.w))[0];
              if (isPlanned && !pick) throw Object.assign(new Error(
                `Leftover strip does not match the cut plan for ${eff.name || `line ${line.id}`}`),
                { status: 409 });
              if (!pick) continue;
              v2Rows.push({
                material_id: mat.id, cuts: childFit(rowParent, eff).count,
                strip: { l: pick.l, w: pick.w },
                strips_per_parent: pick.strips_per_parent || 1,
                est_sheets: d.sheets,
                _mat: mat, _qty: (pick.strips_per_parent || 1) * d.sheets,
              });
              keep.push(`LO-PLAN-${line.id}-${mat.id}`);
            }
            if (!v2Rows.length) throw Object.assign(new Error(
              `Nothing bankable on ${eff.name || `line ${line.id}`} — this cut leaves under 3" on the short side`),
              { status: 409 });
          }
          // Sweep this member's own family, keeping what it is about to
          // re-bank; bankPlanningLeftover's delta logic reconciles those.
          await unbankPlanningLeftover(line.id, qc, oc, req.user.name,
            v2Rows.length ? 'member leftover re-planned' : 'plan re-locked without a leftover', keep);
          for (const r of v2Rows) {
            await bankPlanningLeftover(line, r._mat, r.strip, r.strips_per_parent, r._qty,
              qc, oc, req.user.name, `LO-PLAN-${line.id}-${r._mat.id}`);
          }
          // The RECORD the cutting confirm reads. Same v2 shape orders.js
          // writes for a mixed line, so one confirm can serve both.
          await qc('UPDATE order_lines SET leftover_plan=$1 WHERE id=$2',
            [v2Rows.length
              ? JSON.stringify({ version: 2, decided_by: req.user.name,
                  decided_at: new Date().toISOString(),
                  rows: v2Rows.map(({ _mat, _qty, ...keepRow }) => keepRow) })
              : null,
             line.id]);
        }
      }
      await qc('UPDATE gang_runs SET issue_parent_sheets=$1 WHERE id=$2', [issueOverride, gang.id]);
      await audit('gang_run', gang.id, draft ? 'plan_draft' : 'plan',
        `${gang.gang_number} ${draft ? 'plan saved — lock pending' : 'planned as one job'} (${lines.length} members${wastage != null ? `, ${wastage} wastage sheets each` : ''})`
        + (issueOverride != null && issueOverride !== natural ? ` · issue overridden ${natural} → ${issuedTotal}` : '')
        + adoptedChildNote,
        qc, req.user.name);
    });
    res.json({ ...await gangDetail(+req.params.id), board_shortfalls: boardShortfalls });
  } catch (e) { next(e); }
});

// ── Discard a run's SAVED-but-unlocked plan ─────────────────────────────────
// The exact inverse of the Save above (`draft: true`), and the run-level twin of
// orders.js's /order-lines/:id/plan/discard. Its whole reason for existing is the
// same: a saved draft commits BOARD — replaceMixPlan mirrors every member's mix
// rows into board_allocations, and it absorbs any hand-placed hold those members
// already carried — while leaving every member at 'pending'. So the run sits on
// real committed stock with no screen that can give it back: the mix panel lives
// inside the run engine, and workflow.js's reverse_plan refuses a member that
// never reached 'planned'. That stranded hold is what this releases.
//
// It is NOT Reverse Plan, and not Dissolve. Reverse Plan walks a LOCKED run back
// off 'planned' — deleting job cards, resetting artwork approvals; Dissolve
// breaks the run up. A draft has no cards or approvals to undo, and discarding
// its board is not a reason to stop the jobs printing together, so the run stays
// intact. Three actions, three guards, so each refusal can name the right button.
r.post('/gang-runs/:id/plan/discard', canPlan, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      // FOR UPDATE before the guard reads, not after: the guard's claim is "every
      // member is still an unlocked draft", and a Lock landing on this run
      // concurrently would otherwise be read here as pending and then commit
      // 'planned' underneath us — releasing board a live plan had just claimed.
      const gang = await oc('SELECT * FROM gang_runs WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!gang) throw Object.assign(new Error('Gang run not found'), { status: 404 });
      const lines = await qc(
        'SELECT * FROM order_lines WHERE gang_run_id=$1 ORDER BY id FOR UPDATE OF order_lines',
        [gang.id]);
      if (!lines.length) throw Object.assign(
        new Error('This run has no members — nothing to discard'), { status: 409 });

      // The saved-draft test is the SAME pair LINE_VIEW's `plan_draft` computes
      // (status='pending' AND parent_sheets_required IS NOT NULL), applied across
      // the members — so the badge the planner clicked and the route answering it
      // can never disagree about what a saved run plan is. `some` on the status
      // and not `every`: ONE locked member means the run's board is live, and a
      // partial release would strand it half-held. Each half refuses in its own
      // words because they are different mistakes with different next actions.
      const locked = lines.find(l => l.status !== 'pending');
      if (locked) {
        throw Object.assign(
          new Error(`${gang.gang_number} is locked — a member is already ${locked.status.replace(/_/g, ' ')}, `
            + 'so there is no saved draft to discard. Use Reverse Plan to un-lock the run back to To Plan instead.'),
          { status: 409, body: { code: 'RUN_NOT_DRAFT', at: { stage: null, status: locked.status } } });
      }
      if (lines.every(l => l.parent_sheets_required == null)) {
        throw Object.assign(
          new Error(`Nothing has been saved on ${gang.gang_number} yet — there is no plan to discard.`),
          { status: 409, body: { code: 'RUN_NEVER_SAVED' } });
      }

      // Read what is about to go BEFORE it goes, so the response and the audit
      // trail can name the board that came back rather than reporting a count.
      // "Released 2,400 sheets of Saffire 340" is checkable against the
      // warehouse; "plan discarded" is not. Summed across the members because
      // the planner typed ONE run-level row per board and the split is an
      // implementation detail they never saw — reporting it per member would
      // hand back a list they cannot reconcile with what they entered.
      const byBoard = new Map();
      for (const line of lines) {
        for (const m of await mixFor(line.id, 'plan', qc)) {
          const prev = byBoard.get(m.material_id)
            || { material_id: m.material_id, board_name: m.board_name, sheets: 0 };
          prev.sheets += Number(m.sheets) || 0;
          byBoard.set(m.material_id, prev);
        }
      }
      const released = [...byBoard.values()].map(m => ({ ...m, sheets: Math.round(m.sheets) }));
      const totalSheets = released.reduce((s, m) => s + m.sheets, 0);

      // Was there actually a planned offcut on the shelf? Both sweeps below are
      // silent no-ops when there is not, and the response has to tell the planner
      // which of the two happened. qty > 0 (not initial_qty) is the live test: a
      // bank another job has already drawn to nothing, or one a previous sweep
      // zeroed, is not stock this discard is handing back. Both key shapes are
      // checked — the RUN-level bank a merge lock writes, and the per-member
      // LO-PLAN batches a member can still carry from a solo save before it
      // joined (see the member loop below).
      const banked = await oc(
        `SELECT COUNT(*)::int AS n FROM stock_batches
          WHERE qty > 0 AND (batch_no LIKE $1 OR batch_no = ANY($2) OR batch_no LIKE ANY($3))`,
        [`LO-PLAN-RUN-${gang.id}-%`,
          lines.map(l => `LO-PLAN-${l.id}`),
          lines.map(l => `LO-PLAN-${l.id}-%`)]);
      const leftoverUnbanked = banked.n > 0;

      const why = `${gang.gang_number} saved plan discarded — board released`;
      // The run-level bank goes first and unconditionally: a merge lock writes it
      // against the run, a gang never banks at all, and unbankRunLeftover is a
      // no-op for the latter. Then each member: clearMixPlan releases the
      // mirrored board_allocations holds and deletes the phase='plan' rows.
      await unbankRunLeftover(gang.id, qc, oc, req.user.name, why);
      for (const line of lines) {
        await clearMixPlan(line.id, qc, req.user.name, why);
        // THE DOOR OUT for the board this route's own Save just froze.
        //
        // Saving or locking a run now writes one plan_lock hold per member, so
        // this is the primary way a run's board comes back — not an edge case.
        // clearMixPlan above cannot do it: releaseMixHolds is scoped
        // job_board_mix_id IS NOT NULL and a plan_lock row has neither.
        //
        // It also covers the older case, the same one the LO-PLAN sweep below
        // exists for: a member planned SOLO before it joined the run carries a
        // freeze from that solo lock. Either way, without this the member holds
        // board for a plan that no longer exists — and a line back at 'pending'
        // has no un-plan route left to run.
        await releasePlanLockHolds(line.id, qc, req.user.name, why);
        // A member can hold per-line LO-PLAN batches from having been planned
        // SOLO before it joined the run. The run's own Save cleared that mix
        // (clearMixPlan in the plan loop) but never swept its bank, so those
        // batches now mirror a mix that no longer exists — orphaned by the save,
        // and this is the moment they are provably dead: the member is pending,
        // its mix is gone and its cut plan is being nulled below.
        await unbankPlanningLeftover(line.id, qc, oc, req.user.name, why);
        // sheets_required goes with parent_sheets_required, never without it.
        // board-allocation.js reads a line's requirement as
        // `parent_sheets_required ?? sheets_required` — nulling only the parent
        // would leave every board-position reader quoting the CHILD print count
        // as a parent-sheet demand, strictly larger than the plan just deleted.
        //
        // What deliberately SURVIVES, exactly as on a single line: spec_override
        // (including a child size this run's save adopted and stamped),
        // wastage_sheets, notes, machine_id and planned_date. Those are not
        // commitments — they are the spec the planner decided and the remarks and
        // scheduling they typed. "Unsave" reverses what the save COMMITTED
        // (board); a planner who discards a cut plan to redo it wants the engine
        // to reopen pre-filled with the spec work, not blank.
        await qc(
          `UPDATE order_lines
              SET sheets_required=NULL, parent_sheets_required=NULL, leftover_plan=NULL
            WHERE id=$1`, [line.id]);
      }
      // gang_runs.issue_parent_sheets SURVIVES for the same reason wastage does:
      // it is the planner's manual "issue this many for the whole run", an
      // intent they typed, not board this route is handing back. Reopening the
      // engine finds their figure still in the box.

      // Nulling parent_sheets_required is what flips LINE_VIEW's plan_draft
      // false on every member, so the blue "Saved · lock pending" badge and its
      // filter chip clear themselves off the ONE rule — nothing else to keep in
      // step (the run row's badge ORs across members, so it clears with the last).
      await audit('gang_run', gang.id, 'plan_discarded',
        (released.length
          ? `Saved plan discarded — released ${totalSheets} sheets across ${lines.length} members: `
            + released.map(m => `${m.sheets} of ${m.board_name || `material ${m.material_id}`}`).join('; ')
          : 'Saved plan discarded — no board was held')
          + (leftoverUnbanked ? ' · planned leftover taken back off the shelf' : '')
          + ' · spec, remarks and press kept · run left intact',
        qc, req.user.name);
      for (const line of lines) {
        await audit('order_line', line.id, 'plan_discarded',
          `Saved plan discarded with ${gang.gang_number} — cut plan cleared, spec and remarks kept`,
          qc, req.user.name);
      }
      // Per-board line so the material's own timeline shows the release, in the
      // same shape board.js's hold audits use — the warehouse reads that trail
      // by board, not by order line.
      for (const m of released) {
        await audit('materials', m.material_id, 'board_hold_released',
          `${m.sheets} sheets released from ${gang.gang_number} — ${why}`, qc, req.user.name);
      }

      return { released, total_sheets: totalSheets, leftover_unbanked: leftoverUnbanked };
    });
    res.json({ ...out, run: await gangDetail(+req.params.id) });
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
    // Same kind guard as the plan lock: a merge's run is a SUM, never the MAX.
    if (gang?.kind !== 'merge' && gang?.layout_mode === 'shared') {
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
      // Shared board's own sheet, not the lead's solo parent trim — the same
      // geometry rule as the plan lock (see its comment).
      const fit = childFit(board, { child_l: layout.child.l, child_w: layout.child.w });
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
  // The member rows just cleared were the run's own split mix, and the
  // run-level leftover bank mirrors that mix — so it goes with it, exactly as
  // re-locking without a mix sweeps it. The re-lock that follows a spec change
  // re-banks whatever the planner keeps.
  //
  // THIS IS THE GUARD RAIL FOR THE WHOLE FEATURE, and it is why it lives here
  // rather than in three routes. All three callers change an input the strip is
  // measured on — a per-member board reassignment (/board), the shared child
  // size (/shared), a qty or ups edit (/lines/:lineId) — and a banked strip is
  // live warehouse stock the moment the lock writes it. Leaving it behind would
  // stock the rack with a size the run no longer cuts.
  //
  // A run that cannot bank reads its kind and stops there, as before.
  if (line.gang_run_id) {
    const run = await oc('SELECT kind, layout_mode FROM gang_runs WHERE id=$1', [line.gang_run_id]);
    if (runBanksLeftover(run)) {
      await unbankRunLeftover(line.gang_run_id, qc, oc, user,
        why || 'gang member re-derived — cut plan changed');
    } else {
      // A SEPARATE-layout gang banks on the MEMBER, so the strip that goes with
      // this member's cut plan is its own line bank — swept here for the same
      // reason and by the same rule. Also catches a bank the line carried in
      // from being planned solo before it joined: clearMixPlan above has just
      // dropped the rows that bank mirrored.
      await unbankPlanningLeftover(line.id, qc, oc, user,
        why || 'gang member re-derived — cut plan changed');
      await qc('UPDATE order_lines SET leftover_plan=NULL WHERE id=$1', [line.id]);
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
        party_artwork_code: l.party_artwork_code, party_item_code: l.party_item_code,
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
      // Holds owned by lines outside the claim set — the same third term the
      // single-job endpoint supplies. rankBoardMatches subtracts `held` from
      // free; leaving it unset made that term silently zero on the run path
      // alone, so the two Smart Match panels quoted different free stock for
      // the same board, and the run's is the one that buys on ONE combined PR.
      c.held = stockHoldBudget({
        materialId: c.id, available: Number(c.available || 0),
        allocations, claimLines, ownerLineIds: members.map(m => m.id),
      }).held;
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
        await releasePlanLockHolds(line.id, qc, req.user.name, 'gang plan reversed');
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
             'product_name', p.name, 'product_code', p.code,
             'party_item_code', p.party_item_code
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
