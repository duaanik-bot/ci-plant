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
  if (name.includes('·')) return name.split('·')[0].trim().toLowerCase();
  // No separator — a hand-typed name like "FBB Board 300 GSM". Returning the
  // WHOLE string as the family would make every weight its own grade, and now
  // that a foreign family is dropped outright (rankBoardMatches) that would
  // hide a board's own siblings from it rather than merely relabel them. Strip
  // what is not the grade — the weight and the sheet size — and keep the rest.
  // All 331 boards on the live plant carry the separator, so this path exists
  // for names typed outside the convention, not for the plant's own catalogue.
  const stripped = name
    .replace(/\d+(\.\d+)?\s*(x|×)\s*\d+(\.\d+)?/gi, ' ')  // 25 x 36
    .replace(/\d{2,4}\s*gsm/gi, ' ')                        // 300 GSM
    .replace(/\bboard\b/gi, ' ')
    .replace(/[^a-z ]/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return (stripped || name).toLowerCase();
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

    // GRADE DISCIPLINE — Saffire for Saffire, FBB for FBB, never across the two.
    //
    // Cross-family stock used to be offered as an 'alternate' whenever the cut
    // was clean and the GSM close. It is not an alternate. A board's family is
    // its bulk, stiffness and shade; two 300 GSM sheets from different families
    // are different materials that happen to weigh the same, and swapping one
    // for the other silently rewrites the product's board grade.
    //
    // The two screens also disagreed about it. The board-mix path already
    // refuses a foreign family outright ("the grade must match" —
    // substitutionFlags, orders.js), so Smart Match was recommending stock that
    // "Cover with another board" would then reject on save. Same rule in both
    // places now: this panel only ever offers board the plan can actually use.
    if (!familyOk) continue;

    const parentNeeded = parentSheetsRequired(need, fit.count);
    const available = Math.max(0, +c.available || 0);
    const committed = Math.max(0, +c.committed || 0);
    const free = Math.max(0, available - committed);
    const sufficient = free >= parentNeeded;

    // Every row is now the same grade, so the three buckets are purely about
    // WEIGHT — how far the candidate's GSM is from the board being planned.
    // The thresholds are untouched; only their meaning narrowed, because the
    // family question is already settled by the time we get here. 'alternate'
    // used to mean "a different family worth a look" and now means "the right
    // grade, a weight further out than a planner would call near" — the client
    // labels it accordingly.
    const category = gsmDelta != null && gsmDelta <= GSM_EXACT ? 'exact'
      : gsmDelta == null || gsmDelta <= GSM_NEAR ? 'near'
      : 'alternate';

    // Composite score mirrors CI-Production's ranking priorities:
    // utilization 40 · GSM proximity 20 · family 25 · stock sufficiency 15.
    // The family term is now a constant (everything here is same-family) and is
    // kept so scores stay on the same 0-100 scale the client colours against.
    const utilPts = 40 * (fit.utilization / 100);
    const gsmPts = gsmDelta == null ? 8 : Math.max(0, 20 - gsmDelta * 0.8);
    const familyPts = 25;
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
