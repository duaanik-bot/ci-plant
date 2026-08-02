// One-off cleanup for the duplicate gang requisitions of 1 Aug 2026.
//
// CI-GANG-0007 collected FOUR identical 7,525-sheet PRs (CI-PR-0006..0009)
// because a raised PR left no trace that moved the gang's "Short" figure.
// Keep the FIRST — the shortage is real and the plant still needs the board —
// drop the three duplicates, and REPAIR the survivors so they behave like a PR
// raised by the fixed code: a purchasable line, an anchor to the run, and the
// allocation mirror that makes the gang read "on order" instead of "short".
//
//   node scripts/cleanup-gang-duplicate-prs.mjs            # dry run, prints the plan
//   node scripts/cleanup-gang-duplicate-prs.mjs --apply    # writes
import fs from 'node:fs';
import { q, connect, tx } from '../server/src/db.js';
import { audit } from '../server/src/helpers.js';
import { splitGangQty } from '../server/src/board-allocation.js';

// connect() only — never init(). No DDL is ever sent to the plant database.
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
if (/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)) console.log('(local database)');
await connect();

const APPLY = process.argv.includes('--apply');
const USER = 'cleanup (gang PR de-duplication)';

// Every requisition raised from a gang, oldest first.
const gangPrs = await q(`
  SELECT r.*, g.id AS gang_id, g.gang_number
  FROM requisitions r
  -- the trailing space matters: without it CI-GANG-0001 would also swallow
  -- CI-GANG-00010 the day the series passes four digits
  JOIN gang_runs g ON r.reason LIKE 'Combined shortage for gang ' || g.gang_number || ' %'
  WHERE r.status IN ('pending','approved')
  ORDER BY r.id`);

const byGang = {};
for (const pr of gangPrs) (byGang[pr.gang_id] ||= []).push(pr);

const plan = { keep: [], drop: [], repair: [] };
for (const [gangId, prs] of Object.entries(byGang)) {
  const [keep, ...dupes] = prs;
  plan.keep.push(keep);
  for (const d of dupes) {
    // Refuse to touch anything that has grown a life of its own.
    const [{ n }] = await q(`SELECT (
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.requisition_id=$1) +
      (SELECT COUNT(*) FROM requisitions x WHERE x.reraise_of=$1) +
      (SELECT COUNT(*) FROM requisition_lines rl WHERE rl.requisition_id=$1) +
      (SELECT COUNT(*) FROM board_allocations ba WHERE ba.requisition_id=$1)
    )::int AS n`, [d.id]);
    if (n > 0 || d.purchase_order_id) plan.keep.push({ ...d, note: 'HAS DEPENDENTS — left alone' });
    else plan.drop.push(d);
  }
}

// A survivor still missing its line / anchor / mirror needs repairing.
//
// But ONLY if the PR still buys the board the gang actually runs on. A planner
// who re-anchors a gang after raising its PR leaves the PR pointing at the old
// board — mirroring it onto the members then books incoming stock against a
// board those jobs no longer use, which is the phantom-shortage bug in reverse.
// Live example: CI-PR-0006 bought board 329 for CI-GANG-0007, which had since
// moved to 363 and run from stock. Never assume pr.material_id is current.
plan.stale = [];
for (const pr of plan.keep) {
  if (pr.note) continue;
  const members = await q(`
    SELECT ol.id, ol.parent_sheets_required, ol.sheets_required, ol.status,
           COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS eff_board
    FROM order_lines ol JOIN products p ON p.id=ol.product_id
    WHERE ol.gang_run_id=$1 ORDER BY ol.id`, [pr.gang_id]);
  if (!members.length) continue;

  const boards = [...new Set(members.map(m => m.eff_board))];
  if (boards.length !== 1 || boards[0] !== pr.material_id) {
    const openDemand = await q(`
      SELECT COALESCE(SUM(COALESCE(ol.parent_sheets_required, ol.sheets_required)),0)::int AS sheets
      FROM order_lines ol JOIN products p ON p.id=ol.product_id
      WHERE COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)=$1
        AND ol.status IN ('pending','planned','ready','in_production')`, [pr.material_id]);
    plan.stale.push({ pr, prBoard: pr.material_id, gangBoards: boards, openDemand: openDemand[0].sheets });
    continue;
  }

  const lines = await q('SELECT COUNT(*)::int AS n FROM requisition_lines WHERE requisition_id=$1', [pr.id]);
  const allocs = await q(`SELECT COUNT(*)::int AS n FROM board_allocations
    WHERE requisition_id=$1 AND status='active'`, [pr.id]);
  if (lines[0].n === 0 || allocs[0].n === 0 || !pr.order_line_id) {
    plan.repair.push({ pr, members, split: splitGangQty(pr.qty, members),
      needsLine: lines[0].n === 0, needsAlloc: allocs[0].n === 0, needsAnchor: !pr.order_line_id });
  }
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — gang requisition cleanup\n`);
console.log('KEEP:');
for (const p of plan.keep) console.log(`   ${p.pr_number}  ${p.gang_number}  ${p.qty} sheets${p.note ? `  [${p.note}]` : ''}`);
console.log('\nDELETE (duplicates of the PR above, no PO / no lines / no allocations):');
for (const p of plan.drop) console.log(`   ${p.pr_number}  ${p.gang_number}  ${p.qty} sheets  (created ${p.created_at.toISOString()})`);
console.log('\nREPAIR (make the survivor a complete, gang-aware requisition):');
for (const r of plan.repair) {
  const bits = [r.needsAnchor && 'anchor', r.needsLine && 'line', r.needsAlloc && 'allocation mirror'].filter(Boolean);
  console.log(`   ${r.pr.pr_number}  ${r.pr.gang_number}  +${bits.join(', +')}`);
  console.log(`      split ${r.split.map(s => `line ${s.order_line_id}: ${s.qty}`).join('  ·  ')}  = ${r.split.reduce((s, x) => s + x.qty, 0)}`);
}
if (plan.stale.length) {
  console.log('\nSTALE — the gang moved to another board after this PR was raised.');
  console.log('NOT repaired and NOT deleted: mirroring it would book stock against a board');
  console.log('these jobs no longer use. Decide each one by hand (close, re-point, or keep):');
  for (const s of plan.stale)
    console.log(`   ${s.pr.pr_number}  ${s.pr.gang_number}  buys board ${s.prBoard}, gang now runs on ${s.gangBoards.join('/')}`
      + `  ·  open demand for board ${s.prBoard} plant-wide: ${s.openDemand} sheets`);
}
console.log('');

if (!APPLY) { console.log('Nothing written. Re-run with --apply.\n'); process.exit(0); }

// ── Backup FIRST, outside the transaction, so it survives any failure ──────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = {
  taken_at: new Date().toISOString(),
  why: 'De-duplicating gang requisitions (CI-PR-0006..0009 on CI-GANG-0007)',
  deleted: plan.drop,
  repaired_before: plan.repair.map(r => ({ pr: r.pr, members: r.members, split: r.split })),
};
const file = `./backups/GANG-PR-DEDUPE-${stamp}.json`;
fs.writeFileSync(file, JSON.stringify(backup, null, 2));
console.log(`backup → ${file}`);

await tx(async (qc) => {
  for (const p of plan.drop) {
    await qc('DELETE FROM requisitions WHERE id=$1', [p.id]);
    await audit('requisition', p.id, 'delete_duplicate',
      `${p.pr_number} removed — duplicate of the gang requisition already open for ${p.gang_number}`, qc, USER);
  }
  for (const r of plan.repair) {
    const { pr, split } = r;
    if (r.needsAnchor)
      await qc('UPDATE requisitions SET order_line_id=$1 WHERE id=$2', [split[0].order_line_id, pr.id]);
    if (r.needsLine)
      await qc(`INSERT INTO requisition_lines (requisition_id, material_id, qty, needed_by)
                VALUES ($1,$2,$3,$4)`, [pr.id, pr.material_id, pr.qty, pr.needed_by]);
    if (r.needsAlloc)
      for (const s of split) {
        if (!(s.qty > 0)) continue;
        await qc(`INSERT INTO board_allocations
                    (material_id, order_line_id, qty, source, requisition_id, reason, created_by)
                  VALUES ($1,$2,$3,'requisition',$4,$5,$6)`,
          [pr.material_id, s.order_line_id, s.qty, pr.id, `Incoming on ${pr.pr_number}`, USER]);
      }
    await audit('requisition', pr.id, 'repair_gang_pr',
      `${pr.pr_number} completed for ${pr.gang_number} — purchasable line + board booked across ${split.length} jobs`, qc, USER);
  }
});

console.log('\ndone.\n');
process.exit(0);
