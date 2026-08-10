// ─── Tooling gate: pure functions, no DB ─────────────────────────────────────
// Shared by readiness() (job-card gate), routes/tooling.js (needed-for-jobs
// rail + auto-flip) and the /artwork enrichment. Callers fetch the tool rows.
//
// Requirement semantics — chosen so real plant data (dies only, no plates
// registered yet) keeps flowing unchanged:
//   HARD (die)                : must exist AND be ready, exactly like the old
//                               dies gate.
//   SOFT (plate/block)        : block only when a tool is REGISTERED but not
//                               ready (e.g. plate set at the maker). Untracked
//                               soft tools inform (status 'missing') but never
//                               block. line.tooling_ok stays the absolute
//                               manual override.
// Shade cards moved OUT of the Tooling Hub into the Shade Card Management
// module (2026-07-15): they are quality/approval documents, not tooling.
// readiness() folds a shade entry into the detail from shade_cards itself.

export const TOOL_FAMILIES = {
  die:        { label: 'Die',        prefix: 'DIE-', hard: true  },
  plate:      { label: 'Plate Set',  prefix: 'PLT-', hard: false },
  block:      { label: 'Block',      prefix: 'BLK-', hard: false },
};

export const TOOL_ZONES = ['incoming', 'making', 'in_rack', 'on_floor'];
const READY_ZONES = ['in_rack', 'on_floor'];
const BAD_CONDITION = ['Poor', 'Scrapped'];

// Which families this product needs. `special` is the EFFECTIVE value
// (spec_override already merged by the caller where relevant).
export function requiredFamilies(product) {
  const fams = ['die', 'plate'];
  if (['foil', 'emboss', 'foil_emboss'].includes(product?.special)) fams.push('block');
  return fams;
}

export function toolReady(tool) {
  return !!tool
    && tool.active === 1
    && !BAD_CONDITION.includes(tool.condition)
    && READY_ZONES.includes(tool.zone);
}

// Per-family status for one product. `tools` = every tool row linked to the
// product (product_id match) plus the die the product points at (tool_id).
export function toolingDetail(product, tools) {
  return requiredFamilies(product).map(family => {
    const cands = (tools || []).filter(t => t.family === family);
    // Prefer the explicitly linked die, else any ready tool, else the newest.
    const linked = family === 'die' && product.tool_id
      ? cands.find(t => t.id === product.tool_id) : null;
    const tool = linked ?? cands.find(toolReady) ?? cands[cands.length - 1] ?? null;
    const status = !tool ? 'missing' : toolReady(tool) ? 'ready' : 'not_ready';
    return {
      family,
      label: TOOL_FAMILIES[family].label,
      hard: TOOL_FAMILIES[family].hard,
      status,
      tool_id: tool?.id ?? null,
      code: tool?.code ?? null,
      zone: tool?.zone ?? null,
      condition: tool?.condition ?? null,
    };
  });
}

// Plates NEVER block, at any status. Everything else keeps the rule it has run
// on: a hard family must be ready, a soft one blocks only once it is REGISTERED
// but not ready.
//
// Plates are singled out on Anik's explicit instruction — nothing about a plate
// may stand between a press and its run. It is also the defect that forced the
// whole module to be detached (9aedf20): `hard: false` read as "cannot block",
// but an unready plate set turned gate.tooling false, and orders.js only lets a
// line go planned → ready when that passes. So plates were holding lines back
// with nothing on screen explaining it. Blocks are left exactly as they were —
// an emboss block missing from the rack is still a real reason to hold a line,
// and loosening that was not asked for.
const NEVER_BLOCKS = new Set(['plate']);

export function toolingGateOk(detail, toolingOkFlag) {
  if (toolingOkFlag) return true;
  return detail.every(d => {
    if (NEVER_BLOCKS.has(d.family)) return true;
    return d.hard ? d.status === 'ready' : d.status !== 'not_ready';
  });
}
