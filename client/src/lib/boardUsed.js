// Which board is this job actually on — and where does that disagree with the
// record? One reader, used by the Job Card form and the printed traveler so the
// screen and the paper in the operator's hand can never name two different
// boards.
//
// Three boards can be in play on one job and they are not the same thing:
//
//   master   products.board_material_id — what the carton is specced on.
//   used     the planner's warehouse pick (order_lines.spec_override
//            ->>'board_material_id') when there is one, else the master. This is
//            what the job is planned to be cut from, and what the server counts
//            stock against. JC_VIEW resolves it as `board_name`/`sheet_l`.
//   issued   what the warehouse ACTUALLY consumed (stock_movements). Empty until
//            cutting starts, and it is allowed to differ — a store-keeper can
//            put a different reel through when the planned one runs short. That
//            is precisely the divergence worth printing.
//
// Comparison is on material_id, never on the name: `products.board_name` is a
// denormalised copy that is stale on ~980 rows, and two spellings of the same
// board ("FBB 300 GSM 31.5x41.5" vs "FBB · 300 GSM · 31.5x41.5") mean one board.
// A cutting over-issue lands on a CUT-SHORT-<id> batch of the SAME material, so
// it correctly does not read as a different board.

const idOf = v => (v === null || v === undefined || v === '' ? null : +v);

export function boardUsed(jc) {
  if (!jc) return null;
  const usedId = idOf(jc.board_material_id);
  const masterId = idOf(jc.master_board_material_id);

  // Trust the ids when both are present; fall back to the server's flag for a
  // payload that predates them (the finished-goods endpoint shares JC_VIEW, but
  // a cached page may still hold an older shape).
  const differsFromMaster = usedId != null && masterId != null
    ? usedId !== masterId
    : !!jc.board_overridden;

  // Every board this job was PLANNED to draw. A multi-board job (job_board_mix,
  // phase='issued') deliberately finishes on several boards of a grade and
  // records its own reason per board — the printed card has a Board Mix table
  // for exactly that. Those boards are the plan, so they must never be reported
  // here as an unplanned substitution, or every deliberate mix prints a false
  // alarm. Only a material in neither the plan nor the mix is a deviation.
  const planned = new Set([usedId, ...(jc.board_mix || []).map(m => idOf(m.material_id))]);

  // Every consumption row whose material is NOT one this job planned to draw,
  // folded to one line per material with the total actually issued.
  const byMaterial = new Map();
  for (const i of jc.issues || []) {
    const mid = idOf(i.material_id);
    if (mid == null || usedId == null || planned.has(mid)) continue;
    const row = byMaterial.get(mid)
      || { material_id: mid, name: i.material_name || 'Unknown material', unit: i.unit || 'sheets', qty: 0 };
    row.qty += Math.abs(+i.qty || 0);
    byMaterial.set(mid, row);
  }

  // The grade chip is a SEPARATE fact from the board name — a carton specced
  // "Saffire" can be linked to a "Duplex GB · 330 GSM" material, and showing
  // both is the point. But most board names already OPEN with their grade, and
  // "Saffire · Saffire · 320 GSM · 31.5x41.5" is the exact reading Anik called
  // confusing once already. So the chip is dropped when it only repeats the
  // first word of the name, and kept whenever it actually adds something.
  // Prefix, not first-word: real grades run to two words ("Duplex GB"), and a
  // first-word test would keep the chip on "Duplex GB" + "Duplex GB · 330 GSM".
  const name = jc.board_name || null;
  const grade = jc.board_grade || null;
  const norm = s => (s || '').trim().toLowerCase();
  const gradeAdds = !!grade && !norm(name).startsWith(norm(grade));

  return {
    name,
    grade: gradeAdds ? grade : null,
    sheet: jc.sheet_l ? `${jc.sheet_l}×${jc.sheet_w}"` : null,
    masterName: jc.master_board_name || null,
    differsFromMaster,
    // The chip's two words. Planning says "master" / "job board" for the same
    // two states — the Job Card says it the same way on purpose.
    label: differsFromMaster ? 'Job Board' : 'Master',
    issuedElsewhere: [...byMaterial.values()],
  };
}
