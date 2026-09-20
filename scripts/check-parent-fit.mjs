// Parent-unit invariant checker. Exits non-zero when a LOCKED plan is priced in
// the wrong sheet, so it can gate a deploy or be run on demand against prod.
//
//   node scripts/check-parent-fit.mjs                  # $DATABASE_URL
//   node scripts/check-parent-fit.mjs --url <conn>     # an explicit database
//   node scripts/check-parent-fit.mjs --strict         # also fail on CHECK 2
//
//   CHECK 3 (a parent on file that costs cuts) is informational only — it
//   never affects the exit code, --strict included. So is the list printed
//   with it: active masters whose own parent their own board cannot yield.
//
// THE INVARIANT
//
//   order_lines.sheets_required is a CHILD print-sheet count.
//   order_lines.parent_sheets_required is the PARENT (mother) sheet count —
//   the unit the warehouse stocks, board_allocations freeze, and requisitions
//   buy. The two are related by the number of children the board yields per
//   parent, and on a 2-up board storing the child count as the parent figure
//   buys, freezes and issues exactly twice the board the job needs.
//
// WHY THIS SCRIPT EXISTS
//
//   CI-JC-0335 / CI-MRG-0022-25, 14 Sep 2026. Product SW-097 carried a master
//   parent of 25×36 against its 26.7×28 board — a 36" edge no guillotine takes
//   off a 28" sheet. orders.js's single-line lock refuses that shape and always
//   has; the gang/merge lock never asked, measured 14×25.6 children against the
//   impossible sheet, got ONE up where the board gives TWO, and wrote
//   1,205 child → 1,205 parent on four runs inside six minutes. 8,443 parent
//   sheets of Duplex WB froze for a true need of 4,225.
//
//   It was the SECOND time: CI-JC-0050 (Aug 2026) was the same unit confusion
//   through readiness(), fixed there with cuttingParent while the gang/run path
//   was named in a comment and left open.
//
//   planLockParent() now refuses it at both locks and every re-derive site
//   measures on cuttingParent. This script is the belt to that braces, for the
//   same reason check-board-holds.mjs exists: prevention lives in code a future
//   change can still get wrong, and the failure is SILENT — nothing errors, a
//   figure is just quietly double, and it reaches the floor on a printed card.
//
// WHAT IT DOES NOT FLAG
//
//   A stored parent figure is allowed to differ from the naive recomputation:
//   a gang splits one run's parents across members proportionally, a shared
//   layout re-splits the whole run, a planner types an issue override. Those
//   are decisions, not defects, and there are ~28 of them live. CHECK 1 is
//   therefore narrowed to the one shape that is never a decision — the parent
//   figure equal to the CHILD count on a board that yields two or more.
//
//   With ONE exclusion, learned the hard way while writing this: a run carrying
//   an issue override stores the planner's typed number, distributed across its
//   members — and that number can land exactly on a member's child count by
//   coincidence. CI-GANG-0013 (2,600 → 5,200 over four members = 1,300 each,
//   its members' child count to the sheet) and CI-GANG-0051 (400 → 1,200 =
//   960 + 240) both read as this bug and are neither. On an overridden run the
//   stored figure is not the geometry's at all, so the unit confusion cannot
//   express itself there — `gang_runs.issue_parent_sheets` records the decision
//   and is the discriminator, no audit text parsing required.
import pg from 'pg';
import { childFit, cuttingParent, parentSheetsRequired, parentLosesCuts } from '../server/src/helpers.js';

const arg = f => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null);
const strict = process.argv.includes('--strict');
// A prod .env value can end in a LITERAL backslash-n; trim that as well as real
// whitespace, or the connection string is silently malformed.
const raw = arg('--url') || process.env.DATABASE_URL || '';
const url = raw.replace(/\\n/g, '').trim();
if (!url) {
  console.error('No database. Pass --url <conn> or set DATABASE_URL.');
  process.exit(2);
}
const isRemote = u => !/@(localhost|127\.0\.0\.1)[:/]/.test(u);

// Effective spec, the same COALESCE order every planning view uses: a job-only
// override wins over the master. The board is the override's when it names one.
const LOCKED_LINES = `
  SELECT ol.id, ol.status, ol.sheets_required, ol.parent_sheets_required,
         p.code, p.name AS product,
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         (ol.spec_override->>'child_l')::float AS override_child_l,
         (ol.spec_override->>'child_w')::float AS override_child_w,
         m.sheet_l AS board_l, m.sheet_w AS board_w, m.name AS board,
         gr.gang_number, gr.kind AS run_kind, gr.layout_mode, gr.issue_parent_sheets, o.po_number,
         jc.jc_number, jc.status AS jc_status, jc.children_per_parent,
         EXISTS (SELECT 1 FROM stock_movements sm
                 WHERE sm.ref_type='job_card' AND sm.type='consumption'
                   AND sm.ref_id = jc.id) AS board_drawn
  FROM order_lines ol
  JOIN orders   o ON o.id = ol.order_id
  JOIN products p ON p.id = ol.product_id
  JOIN materials m ON m.id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN gang_runs gr ON gr.id = ol.gang_run_id
  LEFT JOIN job_cards jc ON jc.id = COALESCE(
        (SELECT j2.id FROM job_cards j2 WHERE j2.order_line_id = ol.id LIMIT 1),
        (SELECT j3.id FROM job_cards j3 WHERE j3.gang_run_id = ol.gang_run_id
                                          AND j3.order_line_id IS NULL LIMIT 1))
  WHERE ol.status IN ('planned','ready','in_production')
    AND ol.parent_sheets_required IS NOT NULL
    AND ol.sheets_required IS NOT NULL
    AND m.sheet_l > 0 AND m.sheet_w > 0
  ORDER BY ol.id`;

// The trigger condition, straight from the geometry: a declared parent the
// board cannot yield. Orientation-free and equal-is-fine, exactly as
// parentFitsBoard judges it — expressed in SQL so the scan stays one query.
//
// SCANNED ON THE EFFECTIVE PAIR, NOT THE MASTER. The first cut of this script
// compared each master's parent against its OWN board and reported clean the
// same afternoon 47 products were sitting on an impossible pair — because the
// master is innocent in every one of them. `spec_override.board_material_id`
// moves a JOB to a different board (the whole FP-* metallic family was moved
// from Met Saffire 340 20x38 to the 20x36 sheet) and nothing moves the parent
// with it, so the impossible pair exists only at the effective spec — which is
// exactly what planLockParent judges. A checker narrower than the guard it
// backs reports silence the guard would refuse.
//
// `reachable` is the column that matters operationally: a line still short of
// in_production can reach a plan lock, so the guard WILL refuse it. Everything
// already in production is locked and correct — it is listed so the exposure
// is legible, not because anything is wrong with it today.
const ARMED_PAIRS = `
  WITH e AS (
    SELECT ol.id, ol.status, ol.product_id, ol.gang_run_id,
           COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
           COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
           ((ol.spec_override->>'parent_l') IS NOT NULL OR (ol.spec_override->>'parent_w') IS NOT NULL) AS parent_is_job_override,
           (ol.spec_override->>'board_material_id') IS NOT NULL AS board_is_job_override,
           COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_id
    FROM order_lines ol JOIN products p ON p.id = ol.product_id
    WHERE ol.status IN ('pending','planned','ready','in_production'))
  SELECT p.id, p.code, p.name, e.parent_l, e.parent_w,
         b.name AS board, b.sheet_l AS board_l, b.sheet_w AS board_w,
         e.board_is_job_override, e.parent_is_job_override,
         bool_or(gr.layout_mode = 'shared' AND gr.kind <> 'merge') AS shared_layout,
         count(*)::int AS lines,
         count(*) FILTER (WHERE e.status IN ('pending','planned','ready'))::int AS reachable,
         string_agg(DISTINCT COALESCE(gr.gang_number, '(single)'), ' ') AS runs
  FROM e
  JOIN products p ON p.id = e.product_id
  JOIN materials b ON b.id = e.board_id
  LEFT JOIN gang_runs gr ON gr.id = e.gang_run_id
  WHERE e.parent_l IS NOT NULL AND e.parent_w IS NOT NULL
    AND b.sheet_l > 0 AND b.sheet_w > 0
    AND ( GREATEST(e.parent_l, e.parent_w) > GREATEST(b.sheet_l, b.sheet_w) + 1e-6
       OR LEAST(e.parent_l, e.parent_w)    > LEAST(b.sheet_l, b.sheet_w)    + 1e-6 )
  GROUP BY p.id, p.code, p.name, e.parent_l, e.parent_w,
           b.name, b.sheet_l, b.sheet_w, e.board_is_job_override, e.parent_is_job_override
  ORDER BY reachable DESC, p.code`;

// CHECK 3's rows: every non-closed line and every active master that carries a
// parent on file. parentLosesCuts (the server rule the planning screens' twin
// is pinned to) decides which of them cost cuts.
const OPEN_WITH_PARENT = `
  SELECT ol.id, ol.status, ol.sheets_required, ol.parent_sheets_required,
         p.code,
         COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) AS parent_l,
         COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) AS parent_w,
         ((ol.spec_override->>'parent_l') IS NOT NULL OR (ol.spec_override->>'parent_w') IS NOT NULL) AS parent_is_job_override,
         (ol.spec_override->>'board_material_id') IS NOT NULL AS board_is_job_override,
         COALESCE((ol.spec_override->>'child_l')::float, p.child_l) AS child_l,
         COALESCE((ol.spec_override->>'child_w')::float, p.child_w) AS child_w,
         m.name AS board, m.sheet_l AS board_l, m.sheet_w AS board_w,
         gr.gang_number, COALESCE(gr.layout_mode = 'shared' AND gr.kind <> 'merge', false) AS co_printed
  FROM order_lines ol
  JOIN products p ON p.id = ol.product_id
  JOIN materials m ON m.id = COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
  LEFT JOIN gang_runs gr ON gr.id = ol.gang_run_id
  WHERE ol.status IN ('pending','planned','ready','in_production')
    AND COALESCE((ol.spec_override->>'parent_l')::float, p.parent_l) IS NOT NULL
    AND COALESCE((ol.spec_override->>'parent_w')::float, p.parent_w) IS NOT NULL
  ORDER BY ol.id`;
const MASTERS_WITH_PARENT = `
  SELECT p.code, p.parent_l, p.parent_w, p.child_l, p.child_w,
         m.name AS board, m.sheet_l AS board_l, m.sheet_w AS board_w
  FROM products p JOIN materials m ON m.id = p.board_material_id
  WHERE p.active = 1 AND p.parent_l IS NOT NULL AND p.parent_w IS NOT NULL
  ORDER BY p.code`;

// Informational, printed with CHECK 3: active masters whose OWN parent their
// OWN board cannot yield — ARMED_PAIRS' rule, on the master's pair and board
// instead of an open line's effective ones. The plan lock (planLockParent)
// refuses the next order of each until the parent or the board changes, and
// ARMED_PAIRS cannot see a master that has no open line. Two master writes
// made exactly this shape (final whole-branch review, 19 Sep 2026): "Update
// Product Master" after "Use the board's full sheet" on a JOB-ONLY board wrote
// the parent (keepParentOffImpossibleMaster now keeps such a parent on the
// job), and a Lock sheet that moved a master's board left its old parent
// behind (masterParentCannotStay now clears it). Run this on prod after that
// deploy to find any the old code left behind.
const IMPOSSIBLE_MASTERS = `
  SELECT p.code, p.parent_l, p.parent_w,
         b.name AS board, b.sheet_l AS board_l, b.sheet_w AS board_w
  FROM products p JOIN materials b ON b.id = p.board_material_id
  WHERE p.active = 1 AND p.parent_l IS NOT NULL AND p.parent_w IS NOT NULL
    AND b.sheet_l > 0 AND b.sheet_w > 0
    AND ( GREATEST(p.parent_l, p.parent_w) > GREATEST(b.sheet_l, b.sheet_w) + 1e-6
       OR LEAST(p.parent_l, p.parent_w)    > LEAST(b.sheet_l, b.sheet_w)    + 1e-6 )
  ORDER BY p.code`;

const c = new pg.Client({
  connectionString: url,
  ssl: isRemote(url) ? { rejectUnauthorized: false } : undefined,
});
// A dropped connection also emits 'error' on the Client itself (pg client.js ~410-417) — unlistened, that crashes the process outside every try/catch below, so swallow it here and let the in-flight query's own rejection carry the failure instead.
c.on('error', () => {});
await c.connect();
const locked = (await c.query(LOCKED_LINES)).rows;
const armed = (await c.query(ARMED_PAIRS)).rows;

// CHECK 3 is informational and must never keep CHECK 1/2 from reporting: its
// own queries and evaluation run in their own try/catch, after the two checks
// that gate the exit code already have their data, and c.end() below always
// runs — whether CHECK 3 succeeded, found nothing, or failed.
let lossyLines = [], coPrintedLossy = [], lossyMasters = [], impossibleMasters = [], check3Error = null;
try {
  const openWithParent = (await c.query(OPEN_WITH_PARENT)).rows;
  const mastersWithParent = (await c.query(MASTERS_WITH_PARENT)).rows;
  impossibleMasters = (await c.query(IMPOSSIBLE_MASTERS)).rows;
  const losesOn = r => parentLosesCuts(
    { parent_l: r.parent_l, parent_w: r.parent_w, child_l: r.child_l, child_w: r.child_w },
    { sheet_l: r.board_l, sheet_w: r.board_w });
  // A co-printed line's lock never reads the parent on file (CHECK 1's own
  // coPrinted branch below), so it is split out of the headline group and
  // reported separately — see the CHECK 3 print block.
  const lossyOpen = openWithParent.map(r => ({ r, v: losesOn(r) })).filter(x => x.v);
  lossyLines = lossyOpen.filter(x => !x.r.co_printed);
  coPrintedLossy = lossyOpen.filter(x => x.r.co_printed);
  lossyMasters = mastersWithParent.map(r => ({ r, v: losesOn(r) })).filter(x => x.v);
} catch (e) {
  check3Error = e.message;
}
await c.end();

const n = x => Number(x).toLocaleString('en-IN');
const check3HasFindings = lossyMasters.length > 0 || lossyLines.length > 0 || coPrintedLossy.length > 0;
const check3Printed = !!check3Error || check3HasFindings || impossibleMasters.length > 0;

// ── CHECK 1 — a locked plan priced in child sheets ──────────────────────────
const wrong = [];
for (const r of locked) {
  // The parent its lock used: a co-printed run's lock cuts on the board's own
  // sheet and never reads the parent on file (gangs.js shared arm).
  const coPrinted = r.layout_mode === 'shared' && r.run_kind !== 'merge';
  // The co-printed lock reads the child from the layout OVERRIDE only
  // (server/src/routes/gangs.js sharedLayoutState) — never the master. No
  // override means the layout hasn't locked yet, so a stored figure here is a
  // stale plan, not a unit error: skip it rather than measure against a child
  // it never used.
  const childL = coPrinted ? r.override_child_l : r.child_l;
  const childW = coPrinted ? r.override_child_w : r.child_w;
  if (!(childL > 0 && childW > 0)) continue;
  const product = { parent_l: coPrinted ? null : r.parent_l, parent_w: coPrinted ? null : r.parent_w,
                    child_l: childL, child_w: childW };
  const board = { sheet_l: r.board_l, sheet_w: r.board_w };
  const cuts = childFit(cuttingParent(product, board), product).count;
  if (!(cuts >= 2)) continue;
  // "Parent equals child" says nothing at 0 or 1 sheet — both units agree by
  // construction there, so it is not a signal either way.
  if (!(r.sheets_required >= 2)) continue;
  if (r.parent_sheets_required !== r.sheets_required) continue;   // see "WHAT IT DOES NOT FLAG"
  if (r.issue_parent_sheets != null) continue;                    // a typed decision, not a unit error
  wrong.push({ ...r, cuts, truth: parentSheetsRequired(r.sheets_required, cuts) });
}

if (wrong.length) {
  const excess = wrong.reduce((s, r) => s + (r.parent_sheets_required - r.truth), 0);
  console.error(`✗ ${wrong.length} locked line(s) priced in CHILD sheets — ${n(excess)} parent sheets over`);
  console.error('  Each of these froze, and will issue, about twice the board its job needs.');
  console.error('  A card in this state also prints a self-contradiction: N parents × 2 cuts');
  console.error('  for a job that needs N child sheets.\n');
  for (const r of wrong) {
    console.error(`  line ${r.id} (${r.status})  ${r.code} — ${r.product}`);
    console.error(`        ${r.gang_number ? `${r.gang_number} · ` : ''}${r.jc_number ?? 'no card'}`
      + `${r.jc_status ? ` (${r.jc_status})` : ''} · PO ${r.po_number}`);
    console.error(`        ${n(r.sheets_required)} child → stored ${n(r.parent_sheets_required)} parent, `
      + `but ${r.board} yields ${r.cuts} → ${n(r.truth)}`);
    console.error(`        declared parent ${r.parent_l ?? '—'}×${r.parent_w ?? '—'}", `
      + `board ${r.board_l}×${r.board_w}", card cpp ${r.children_per_parent ?? '—'}`
      + `${r.board_drawn ? '   ⚠ BOARD ALREADY DRAWN — do not silently correct' : ''}`);
  }
  console.error('\n  Correct the plan figure, the freeze and the card together, or they disagree:');
  console.error('    order_lines.parent_sheets_required · board_allocations.qty · job_cards.sheets_issued');
}

// ── CHECK 2 — masters that can arm it again ─────────────────────────────────
if (armed.length) {
  const reach = armed.filter(r => r.reachable > 0);
  const lines = armed.reduce((s, r) => s + r.lines, 0);
  console.error(`\n${strict ? '✗' : '!'} ${armed.length} product(s) on ${lines} open line(s) plan on a board their parent cannot yield`);
  if (reach.length) {
    const runLock = reach.filter(r => !r.shared_layout);
    console.error(`  ${reach.length} can still reach a plan lock. ${runLock.length} of those would be REFUSED`);
    console.error('  outright by planLockParent, naming the member. The planner clears it by setting the');
    console.error('  parent in the cut plan (parent_l/parent_w are job-overridable) or on the Product Master.');
    if (reach.length - runLock.length) {
      console.error(`  The other ${reach.length - runLock.length} sit on a SHARED layout, whose lock measures`);
      console.error('  childFit(board, child) and never reads the parent (gangs.js) — so the run itself plans');
      console.error('  fine and only a member planned as a SINGLE is refused. Latent, not blocking.');
    }
  } else {
    console.error('  All of them are already in production: their plans are locked and correct, and');
    console.error('  nothing can re-plan them. Listed so the exposure is legible, not as a defect.');
  }
  console.error('');
  for (const r of armed) {
    console.error(`  ${r.reachable > 0 ? '→' : ' '} ${r.code.padEnd(9)} parent ${r.parent_l}×${r.parent_w}"`
      + ` vs ${r.board_l}×${r.board_w}"  ${r.board}`);
    console.error(`      ${r.lines} line(s)${r.reachable ? `, ${r.reachable} still plannable` : ''}`
      + `${r.board_is_job_override ? ' · board is a JOB OVERRIDE, the master itself is fine' : ' · the MASTER declares this pair'}`
      + `   ${r.runs}`);
  }
}

// ── CHECK 3 — a parent on file that costs cuts (informational) ─────────────
// CI-MRG-0028, 19 Sep 2026: SW-544 kept its old board's 22×28 after moving to
// the 23×38 board — 1 cut where the board gives 3. Not an error: a deliberate
// trim is the planner's call, and the planning screens already warn with a
// "Use the board's full sheet" button. Listed so a left-over size is seen
// before it is planned. Never affects the exit code.
//
// A CO-PRINTED line is split out of the headline group: its lock never reads
// the parent on file (it cuts the board's own sheet — CHECK 1's coPrinted
// branch above), so a lossy parent there costs nothing today. Planning.jsx
// hides the field and the warning for the same reason (`flagged = coPrinted
// ? [] : …`). It still matters the day the job is ever planned alone, so it
// is listed — just separately, with its own note.
if (check3Error) {
  console.log(`\ni CHECK 3 skipped — ${check3Error}`);
} else if (check3HasFindings) {
  const printLine = ({ r, v }) => {
    const replannable = ['pending', 'planned', 'ready'].includes(r.status);
    const status = replannable ? `(${r.status})` : '(in production — locked; listed for the record)';
    console.log(`    ${replannable ? '→' : ' '} line ${r.id} ${status} ${r.code} ${r.gang_number ?? '(single)'}`);
    console.log(`        ${r.board} ${r.board_l}×${r.board_w}"${r.board_is_job_override ? ' (job-override board)' : ''}`
      + ` · parent ${v.declared.l}×${v.declared.w}" (${r.parent_is_job_override ? 'job' : 'master'}) cuts ${v.cuts_declared} vs board cuts ${v.cuts_board}`
      + (r.parent_sheets_required != null
          ? ` · stored ${n(r.parent_sheets_required)} parent / ${n(r.sheets_required)} child`
            + ` · the board's own sheet needs ${n(parentSheetsRequired(r.sheets_required, v.cuts_board))}`
          : ''));
  };
  if (lossyMasters.length || lossyLines.length) {
    console.log(`\ni ${lossyMasters.length} master(s) and ${lossyLines.length} open line(s) carry a parent that yields fewer cuts than their board`);
    console.log('  Usually a size left over from an earlier board. Not an error — the planner may keep a');
    console.log('  deliberate trim; the single-line and combined/separate-run screens show the same warning with a one-click fix.\n');
    for (const { r, v } of lossyMasters)
      console.log(`    ${r.code.padEnd(9)} master parent ${v.declared.l}×${v.declared.w}" cuts ${v.cuts_declared}`
        + ` — ${r.board} (${v.board.l}×${v.board.w}") cuts ${v.cuts_board}`);
    lossyLines.forEach(printLine);
  }
  if (coPrintedLossy.length) {
    if (lossyMasters.length || lossyLines.length) {
      console.log(`\ni ${coPrintedLossy.length} more, on a co-printed run — costs nothing on this run (a co-printed lock`);
      console.log('  cuts the board\'s full sheet); it matters only if the job is planned alone, and the single-line');
      console.log('  screen warns then.\n');
    } else {
      console.log(`\ni ${coPrintedLossy.length} open line(s) on a co-printed run carry a parent that yields fewer cuts than their board`);
      console.log('  — costs nothing on this run (a co-printed lock cuts the board\'s full sheet); it matters only if');
      console.log('  the job is planned alone, and the single-line screen warns then.\n');
    }
    coPrintedLossy.forEach(printLine);
  }
}
// Masters whose own parent their own board cannot yield (IMPOSSIBLE_MASTERS):
// informational like the rest of CHECK 3 — never the exit code, --strict
// included. Each one's NEXT order is refused at the plan lock until the parent
// or the board on the Product Master changes.
if (!check3Error && impossibleMasters.length) {
  console.log(`\ni ${impossibleMasters.length} active master(s) declare a parent their own board cannot yield — the plan lock refuses their next order`);
  console.log('  Correct the parent (or the board) on the Product Master before the product is planned again.');
  console.log('  Open lines already planning on such a pair are CHECK 2 above.\n');
  for (const r of impossibleMasters)
    console.log(`    ${r.code.padEnd(9)} master parent ${r.parent_l}×${r.parent_w}" — ${r.board} (${r.board_l}×${r.board_w}")`);
}

if (!wrong.length && !armed.length) {
  if (check3Printed) console.log('');
  console.log('✓ parent units clean — every locked plan is priced in parent sheets,');
  // ARMED_PAIRS judges open lines; the masters it cannot see are listed above.
  console.log(impossibleMasters.length
    ? '  and no open line plans on a parent its board cannot yield (the masters listed above are informational)'
    : '  and no active master declares a parent its board cannot yield');
  process.exit(0);
}
process.exit(wrong.length || (strict && armed.length) ? 1 : 0);
