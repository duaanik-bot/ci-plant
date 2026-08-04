// ─── Smart Match — warehouse-driven board matcher for the Planning Engine ───
// Ported from CI-Production's smart-match-parent-sheets intelligence, distilled
// for ci-erp's schema: boards are `materials` rows (category 'board') whose
// names follow "Family · NNN GSM · L x W" and whose parent size lives in
// sheet_l / sheet_w. Given the child print sheet and the required child-sheet
// count, it ranks every stocked board that can physically produce the child
// and buckets the results the way a planner thinks:
//   exact     — same board family, same (±2) GSM
//   near      — same family, GSM within ±25
//   alternate — different family but a practical fit worth a human look
// Leftover offcuts inherit their parent board's identity: the route joins
// source_material_id and passes match_name/match_spec, which family/GSM
// parsing prefers over the leftover's own "Leftover — …" name. Fitting
// leftovers rank ahead of fresh boards so offcuts get used up first.
// Pure functions, no I/O — the route feeds it stock-aggregated candidates.
import { childFit, parentSheetsRequired } from './helpers.js';

export function boardGsm(material) {
  const nm = material?.match_name ?? material?.name;
  const sp = material?.match_spec ?? material?.spec;
  const m = String(nm || '').match(/(\d{2,4})\s*gsm/i)
    || String(sp || '').match(/[A-Za-z](\d{3})(?:-|$)/);
  return m ? +m[1] : null;
}

export function boardFamily(material) {
  // "Duplex GB · 296 GSM · 20 x 38" → "duplex gb"
  // Leftovers inherit the parent's identity via match_name (see routes/orders.js).
  const name = String(material?.match_name ?? material?.name ?? '');
  const head = name.split('·')[0].trim();
  return (head || name).toLowerCase();
}

const GSM_EXACT = 2;   // ±2 GSM is the same board for all practical purposes
const GSM_NEAR = 25;   // within one supply grade — planner judgement call

// Rank candidate boards for a child sheet. `product` needs child_l/child_w;
// `childSheets` is the total child print sheets the plan must yield.
export function rankBoardMatches({ product, childSheets, currentBoard, candidates }) {
  const targetFamily = currentBoard ? boardFamily(currentBoard) : null;
  const targetGsm = boardGsm(currentBoard) ?? product?.gsm ?? null;
  const need = Math.max(1, Math.ceil(+childSheets || 1));

  const out = [];
  for (const c of candidates) {
    const fit = childFit(c, product);
    if (!fit.sized || fit.count <= 0) continue;

    const family = boardFamily(c);
    const gsm = boardGsm(c);
    const gsmDelta = targetGsm != null && gsm != null ? Math.abs(gsm - targetGsm) : null;
    const familyOk = targetFamily ? family === targetFamily : true;

    // Cross-family stock is only "practically usable" when the fit is clean.
    if (!familyOk && fit.utilization < 60) continue;
    // Unknown or wildly different GSM on a foreign family isn't a real option.
    if (!familyOk && (gsmDelta == null || gsmDelta > GSM_NEAR)) continue;

    const parentNeeded = parentSheetsRequired(need, fit.count);
    const available = Math.max(0, +c.available || 0);
    const committed = Math.max(0, +c.committed || 0);
    const free = Math.max(0, available - committed);
    const sufficient = free >= parentNeeded;

    const category = familyOk && gsmDelta != null && gsmDelta <= GSM_EXACT ? 'exact'
      : familyOk && (gsmDelta == null || gsmDelta <= GSM_NEAR) ? 'near'
      : 'alternate';

    // Composite score mirrors CI-Production's ranking priorities:
    // utilization 40 · GSM proximity 20 · family 25 · stock sufficiency 15.
    const utilPts = 40 * (fit.utilization / 100);
    const gsmPts = gsmDelta == null ? 8 : Math.max(0, 20 - gsmDelta * 0.8);
    const familyPts = familyOk ? 25 : 0;
    const stockPts = sufficient ? 15 : parentNeeded > 0 ? Math.min(15, 15 * (free / parentNeeded)) : 0;
    const score = Math.round(Math.min(100, utilPts + gsmPts + familyPts + stockPts));

    out.push({
      material_id: c.id,
      name: c.name,
      spec: c.spec,
      gsm,
      gsm_delta: gsmDelta,
      sheet_l: c.sheet_l,
      sheet_w: c.sheet_w,
      parent_size: `${c.sheet_l}×${c.sheet_w}"`,
      children_per_parent: fit.count,
      orientation: fit.orientation,
      utilization: fit.utilization,
      cut_waste_pct: fit.waste_pct,
      parent_needed: parentNeeded,
      available,
      committed,
      free,
      // The jobs whose open need makes up `committed`, largest first. A row
      // reporting free stock without naming who is holding the rest reads as
      // "this board is unspoken for", which is how a board 3,650 sheets short
      // came to be offered as covering a plan. The planner decides whether to
      // take it from them; the engine's job is to say who "them" is.
      claimants: c.claimants || [],
      short: Math.max(0, parentNeeded - free),
      sufficient,
      category,
      score,
      is_current: currentBoard ? c.id === currentBoard.id : false,
      leftover: !!c.leftover,
      code: c.code || null,
    });
  }

  // Score first (same ranking priority as the CI-Production engine), then
  // stock sufficiency and category as tie-breaks. Leftovers (offcuts already
  // in the warehouse) always win first — use them before buying/cutting fresh.
  const rank = { exact: 0, near: 1, alternate: 2 };
  out.sort((a, b) => {
    if (!!a.leftover !== !!b.leftover) return a.leftover ? -1 : 1; // use offcuts first
    if (b.score !== a.score) return b.score - a.score;
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    if (a.category !== b.category) return rank[a.category] - rank[b.category];
    return b.free - a.free;
  });
  return out;
}
