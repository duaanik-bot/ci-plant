import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// SQL-only invariants, asserted on the source.
//
// These rules live inside route handlers and helper functions as literal SQL.
// This suite has no database harness, so there is nothing to execute against
// and a pure-function test cannot reach them. Reading the source is a weaker
// guarantee than an integration test and is chosen deliberately: a silent
// regression in any of these three predicates corrupts board holds in a way
// that only shows up on the plant floor days later.
//
// Comments are stripped before matching — a guard must read the CODE, never
// the prose that explains it.
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const code = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const squash = s => s.replace(/\s+/g, ' ');

test('replaceMixPlan does not absorb an engine-placed freeze', () => {
  const helpers = squash(code(src('./helpers.js')));

  // The ABSORB releases this line's HAND-PLACED holds on the boards the new
  // mix names. A plan-lock freeze carries the same source and the same NULL
  // job_board_mix_id, so without an origin predicate every mix save would
  // release the board the engine just froze — the exact bug 9757c5f fixed,
  // reintroduced from the other direction.
  const absorb = helpers.match(
    /UPDATE board_allocations[^`]*absorbed into the board mix for this job[^`]*/);
  assert.ok(absorb, 'the ABSORB statement is gone — find where it moved before deleting this test');
  assert.match(absorb[0], /origin IS NULL/,
    'the ABSORB must exclude origin=\'plan_lock\' rows, or a mix save eats the engine freeze');
});

test('GRN substitution repoints only incoming PR board, never a stock freeze', () => {
  const proc = squash(code(src('./routes/procurement.js')));

  // alloc_repoint moves a line's allocation onto the board that actually
  // arrived so /grns/:id/qc burns down against the right material. That is
  // right for a REQUISITION mirror — the incoming board genuinely changed.
  // It is wrong for a stock hold: the frozen sheets are on the old board's
  // shelf and did not move, and the substituted board's sheets are still in
  // quarantine awaiting QC.
  const repoint = proc.match(/UPDATE board_allocations SET material_id=\$1[^`]*/);
  assert.ok(repoint, 'alloc_repoint is gone — find where it moved before deleting this test');
  assert.match(repoint[0], /source='requisition'/,
    'alloc_repoint must be scoped to requisition mirrors, or it drags a stock freeze onto a board still in quarantine');
});

test('rolling a line back releases every hold it owns, not just the mix mirror', () => {
  const helpers = squash(code(src('./helpers.js')));

  // rollbackLine voids the cut plan. clearMixPlan releases the MIX-mirrored
  // hold, but releaseMixHolds is scoped `job_board_mix_id IS NOT NULL` — so a
  // requisition mirror, a hand-placed hold and an engine freeze all survive a
  // rollback as active rows against a line that no longer has a plan.
  //
  // In mode='delete' the line's own ON DELETE CASCADE eventually clears them.
  // In mode='rollback' the line lives on and the board stays fenced forever.
  const fn = helpers.slice(helpers.indexOf('export async function rollbackLine'));
  const body = fn.slice(0, fn.indexOf('export async function', 10));

  // Matched together with the argument list, not the SQL alone: the reason
  // here depends on `mode`, so it is a BOUND PARAM and the literal lives
  // outside the template. Asserting on the literal on its own would be
  // vacuous — clearMixPlan is already handed the same string one screen down.
  const release = body.match(/UPDATE board_allocations[^`]*`,\s*\[[^\]]*\]/);
  assert.ok(release, 'rollbackLine releases no board holds of its own — the stranded mirror is back');
  assert.match(release[0], /release_reason=\$\d[\s\S]*'line rolled back[^']*'/,
    'rollbackLine must release the line\'s remaining active holds with a reason on record');
  assert.match(release[0], /job_board_mix_id IS NULL/,
    'the release must target the holds clearMixPlan does NOT cover (job_board_mix_id IS NULL)');
});

// THE PLANT OWNER'S RULE, MADE UNBREAKABLE.
//
// Anik's instruction, verbatim: "there should not be any disturbance in the
// numbers, in the arithmetics, in the quantities, which we have already issued,
// or what we have in the stock. This is only to ensure that future entries
// should be taken care of."
//
// Freezing board is BOOKKEEPING — it records who has claimed which sheets. It
// must never move a physical quantity. The shelf count, the sheets already
// issued to the floor, and the sheets a job needs are all somebody else's job
// to change, and a freeze that edits one of them would silently rewrite history
// for the jobs already running.
//
// commitBoardForLine is the function Phase 2 calls on EVERY plan lock, so it is
// the one place where a stray write would reach every job in the plant at once.
// It may touch board_allocations and nothing else.
test('placing a board freeze can never move a physical quantity', () => {
  const board = code(src('./routes/board.js'));

  const start = board.indexOf('async function commitBoardForLine');
  assert.ok(start > -1, 'commitBoardForLine is gone — find where it moved before deleting this test');
  // Function body runs to the next top-level declaration in this file.
  const rest = board.slice(start + 1);
  const end = rest.search(/\n(async function|function|const |r\.(get|post|put|patch|delete)\()/);
  const body = rest.slice(0, end > -1 ? end : rest.length);

  const writes = [...body.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/gi)]
    .map(m => m[1].toLowerCase());

  assert.deepEqual([...new Set(writes)], ['board_allocations'],
    `commitBoardForLine must write to board_allocations and nothing else — found writes to: ${[...new Set(writes)].join(', ')}. `
    + 'A board freeze records a claim; it must never change stock, issued quantities, or what a job needs.');

  for (const forbidden of ['stock_batches', 'stock_movements', 'order_lines', 'materials', 'job_board_mix']) {
    assert.ok(!writes.includes(forbidden),
      `commitBoardForLine writes to ${forbidden} — a freeze must not disturb quantities already on the books`);
  }
});

// THE FREEZE MUST SERIALISE PER BOARD.
//
// commitBoardForLine's gate is a check-then-act over two aggregates: SUM of
// available stock_batches, minus SUM of active holds. No row lock can pin an
// aggregate. A `FOR UPDATE` on the order line is useless here — a lock on line A
// never conflicts with a lock on line B, so two planners committing two
// different jobs against the SAME board would each read the same `free`, each
// pass, and each write a hold. The board ends up holding more than exists, which
// is precisely the over-commitment this whole project removes.
//
// procurement.js's GRN cover path hit this first and fixed it with a
// transaction-scoped advisory lock keyed on material_id. The freeze reuses the
// SAME class id on purpose: a cover and a freeze both consume free stock, so
// they must serialise against each other rather than race.
test('placing a board freeze serialises on the board', () => {
  const board = code(src('./routes/board.js'));

  const start = board.indexOf('async function commitBoardForLine');
  assert.ok(start > -1, 'commitBoardForLine is gone — find where it moved before deleting this test');
  const rest = board.slice(start + 1);
  const end = rest.search(/\n(async function|function|const |r\.(get|post|put|patch|delete)\()/);
  const body = rest.slice(0, end > -1 ? end : rest.length);

  assert.match(body, /pg_advisory_xact_lock\(\s*764001\s*,/,
    'commitBoardForLine must take the per-board advisory lock (class 764001) — without it two '
    + 'planners on different jobs can both pass the free-stock gate for the same board');

  const lockAt = body.search(/pg_advisory_xact_lock/);
  const readAt = body.search(/commitInputs\(/);
  assert.ok(lockAt > -1 && readAt > -1 && lockAt < readAt,
    'the advisory lock must be taken BEFORE the position is read, or the read it protects has already happened');
});

// EVERY WAY A PLAN ENDS MUST HAND THE BOARD BACK.
//
// A plan_lock hold carries job_board_mix_id NULL and source='stock', so all
// three existing helpers are blind to it: releaseMixHolds and consumeMixHolds
// are scoped `job_board_mix_id IS NOT NULL`, consumeCoverHolds matches the GRN
// cover reason tag. Without its own release, board frozen by locking a plan
// stays frozen after that plan is gone — which is the phantom this whole
// project exists to remove, recreated by the fix for it.
//
// The scope is deliberately order_line_id only, with NO material predicate:
// four separate paths move a planned line's effective board out from under its
// freeze (a re-lock, a gang board change, a master board edit, GRN
// substitution), so a material-scoped release would miss the row on the board
// the line has just left.
test('releasePlanLockHolds exists and is scoped to the line, not the board', () => {
  const helpers = squash(code(src('./helpers.js')));

  assert.match(helpers, /export async function releasePlanLockHolds\(/,
    'releasePlanLockHolds is missing — a plan_lock hold would have no release path at all');

  const fn = helpers.slice(helpers.indexOf('export async function releasePlanLockHolds'));
  const body = fn.slice(0, fn.indexOf('export ', 10));

  assert.match(body, /origin='plan_lock'/, 'must target plan_lock rows specifically');
  assert.match(body, /status='active'/, 'must not re-release an already-released or consumed row');
  assert.ok(!/material_id/.test(body),
    'must NOT be scoped by material_id — a re-lock that changes the board would strand the old board\'s hold');
});

test('every path that ends a plan releases its plan_lock hold', () => {
  // These three contain the name ONLY if someone imports and calls it, so a
  // whole-file match is a real assertion here.
  const paths = [
    ['./routes/workflow.js', 'reverse_plan'],
    ['./routes/orders.js', '/plan/discard'],
    ['./routes/gangs.js', 'gang reverse'],
  ];
  for (const [file, what] of paths) {
    assert.match(code(src(file)), /releasePlanLockHolds\(/,
      `${file} never calls releasePlanLockHolds — ${what} would leave board frozen on a plan that no longer exists`);
  }

  // helpers.js is the exception and must be SLICED. It DECLARES the function,
  // so a whole-file match passes whether or not setLineStatus ever calls it —
  // and cancellation is the newest and least obvious of the four paths, i.e.
  // exactly the one that must not be guarded by a test that cannot fail.
  const helpers = squash(code(src('./helpers.js')));
  const at = helpers.indexOf('export async function setLineStatus');
  assert.ok(at > -1, 'setLineStatus is gone — find where it moved before deleting this test');
  const body = helpers.slice(at, helpers.indexOf('export ', at + 10));

  assert.match(body, /releasePlanLockHolds\(/,
    'setLineStatus does not release the freeze — a cancelled line would hold board forever');
  assert.match(body, /to === 'cancelled'/,
    "the release must be gated on the 'cancelled' transition, not run on every status change");
});

// A cancelled line is TERMINAL — LINE_TRANSITIONS.cancelled is empty, so no
// route will ever run a release for it again. The status flip and the release
// must land together or not at all. On the pool they are two independent
// autocommit statements, and a crash between them fences the board off for good.
test('cancelling a single line is transactional', () => {
  const orders = code(src('./routes/orders.js'));
  const at = orders.indexOf("'/order-lines/:id/cancel'");
  assert.ok(at > -1, 'the single-line cancel route is gone — find where it moved');
  const handler = orders.slice(at, at + 400);

  assert.match(handler, /tx\(/,
    'the cancel route must run inside tx() — setLineStatus now releases board alongside the '
    + 'status flip, and a cancelled line is terminal, so a partial failure strands the hold forever');
  assert.ok(!/setLineStatus\([^)]*\bq\b\s*,\s*one\b/.test(handler),
    'the cancel route still passes the pool (q, one) to setLineStatus instead of the transaction');
});

// rollbackLine is deliberately NOT in the list above: Phase 1 gave it a sweep
// matching `job_board_mix_id IS NULL` with no origin predicate, which already
// catches a plan_lock row. Pinned here so a later tightening of that scope
// cannot silently un-fix it.
test('rollbackLine still catches a plan_lock hold without naming it', () => {
  const helpers = squash(code(src('./helpers.js')));
  const fn = helpers.slice(helpers.indexOf('export async function rollbackLine'));
  const body = fn.slice(0, fn.indexOf('export async function', 10));

  const sweep = body.match(/UPDATE board_allocations[^`]*job_board_mix_id IS NULL[^`]*/);
  assert.ok(sweep, 'rollbackLine no longer sweeps holds with job_board_mix_id IS NULL');
  assert.ok(!/origin/.test(sweep[0]),
    'rollbackLine\'s sweep gained an origin predicate — it must stay origin-agnostic to keep catching plan_lock rows');
});

// BOARD THAT HAS LEFT THE BUILDING IS CONSUMED, NEVER RELEASED — AND EVERY
// HOLD ON IT GOES, WHATEVER WROTE THE ROW.
//
// board-allocation.js's isActive tests only `status === 'active'`, so
// 'consumed' and 'released' produce IDENTICAL numbers on every screen and in
// every unit test. The difference is the audit trail: 'released' says a
// planning decision was undone, 'consumed' says the sheets went to the floor.
// Getting it wrong here is invisible and permanent, so it is asserted.
//
// The SECOND half of this test is the harder-won one. Cutting start used to
// retire holds by TAG, three allow-lists side by side: consumeMixHolds took the
// mix's (job_board_mix_id IS NOT NULL), consumeCoverHolds took procurement's
// (reason LIKE 'Covered from CI-GRN-%'), and this function took the engine's
// freeze (origin='plan_lock'). A hold matching none of the three survived its
// own draw for ever, and nothing anywhere could ever retire it.
//
// Live case, board FBB · 280 GSM · 25x36, 8 Aug 2026. FOLEE-1 (line 118) held
// 4,008 sheets on a row written by the OLDER engine-commit path — reason
// "Committed from the planning engine", origin NULL, no mix id, not a GRN
// cover. It drew 6,500 parent sheets that morning: the shelf fell 5,500 → 4,400
// and its GRN-cover holds were correctly consumed, but its 4,008 matched no tag
// and stayed 'active'. GLYKIND (line 229) then read
//     free = 4,400 − 4,008 = 392   against   1,492 needed   →   Stock Short 1,100
// for board standing in the racks. The same 4,008 sheets were counted out
// twice: once because they physically left, once because they were still
// reserved. Inside the Planning Engine the panel read "stock OK" (its COMMITTED
// figure nets drawn jobs off) while the queue row outside read "Stock Short" —
// one board, one minute, opposite verdicts.
//
// So the tag test is gone and the rule is physical: board that has LEFT THE
// WAREHOUSE for a job spends every stock hold that job has on it. A predicate
// naming a hold FLAVOUR here is the allow-list growing back.
test('a draw consumes every stock hold on the drawn board, whatever wrote it', () => {
  const helpers = squash(code(src('./helpers.js')));

  assert.match(helpers, /export async function consumeDrawnHolds\(/,
    'consumeDrawnHolds is missing — a hold would stay active after its board was drawn');

  const fn = helpers.slice(helpers.indexOf('export async function consumeDrawnHolds'));
  const body = fn.slice(0, fn.indexOf('export ', 10));

  assert.match(body, /SET status='consumed'/,
    "must set status='consumed' — 'released' would return sheets to free that are already on the floor");
  assert.ok(!/released_by|released_at|release_reason/.test(body),
    'a consumed hold leaves the release columns unset, byte-for-byte matching consumeMixHolds');
  assert.match(body, /material_id = ANY/,
    'must be scoped to the board actually drawn — a line can hold more than one board, and a board '
    + 'it froze but never touched goes back to the shelf via releaseUndrawnPlanLockHolds instead');
  assert.match(body, /source='stock'/,
    'requisition mirrors are incoming board, not shelf board — the GRN path retires those');
  assert.ok(!/origin|job_board_mix_id|reason LIKE/.test(body),
    'the predicate names a hold FLAVOUR again. That is the allow-list this function exists to delete: '
    + 'the next hold written by a path nobody thought of will outlive its board exactly as the '
    + '4,008-sheet engine commit on FBB 280 25x36 did, and no code will be able to retire it.');
});

test('both cutting-start branches consume the holds their draw spends', () => {
  const prod = code(src('./routes/production.js'));
  const calls = [...prod.matchAll(/consumeDrawnHolds\(/g)].length;
  assert.ok(calls >= 2,
    `consumeDrawnHolds is called ${calls} time(s) in production.js — it must run in BOTH `
    + 'branches of the cutting-start block. The else branch (no board mix) is the one MOST lines '
    + 'take, so covering only the mix branch would miss most of the pipeline.');
});

// EVERY DRAW, NOT JUST CUTTING START.
//
// The rule is about board leaving the WAREHOUSE, so it belongs at every place
// board leaves the warehouse for a job — otherwise "a hold cannot outlive its
// board" is true of one route and false of the next, which is how the tag
// allow-list above rotted in the first place.
//
// Extra sheets are the second such place: issueWithWriteOn(..., 'job_card', …)
// posts a job_card consumption exactly as cutting start does, so
// BOARD_DRAWN_EXISTS already counts the line as drawn. It matters most because
// an XS issue may name a DIFFERENT board than cutting drew — cutting start's
// consume is material-scoped, so a hold on the XS board was never in its reach.
//
// Auditing the other three issueWithWriteOn callers: inventory.js (stocktake,
// ref_type 'inventory'), writeons.js (ref_type 'stock_writeon') and
// adjustBoardStock are BOOK CORRECTIONS, not a job drawing board. They must not
// retire anyone's hold, and they do not.
test('an extra-sheets issue retires the holds its draw spends, like any other draw', () => {
  const xs = code(src('./routes/extrasheets.js'));

  assert.match(xs, /consumeDrawnHolds\(/,
    'extrasheets.js draws board against a job card and retires no hold. A job holding board on the '
    + 'XS material keeps that hold after the sheets have physically gone — the same double-count '
    + 'that read "Stock Short 1,100" on FBB 280 25x36 with the board sitting in the racks.');

  const issueAt = xs.indexOf('issueWithWriteOn(');
  const consumeAt = xs.indexOf('consumeDrawnHolds(');
  assert.ok(issueAt >= 0 && consumeAt > issueAt,
    'consumeDrawnHolds must run AFTER the draw it retires — a hold released before its own '
    + 'consumeFifo would hand the sheets to whoever asks next, mid-transaction');
});

// THE FREEZE MUST NOT BE ABLE TO KILL A PLAN SAVE.
//
// The whole /plan handler is ONE transaction. A COMMIT_EXCEEDS_FREE thrown at
// the freeze site would roll back the planner's qty edit, the product master
// update, the spec override, the board mix and the leftover banking — so a
// short shelf would start failing locks that used to work, across the entire
// live pipeline. The plant's own rule is physics hard, paperwork soft: a
// missing sheet is a shortage to show, not a reason to refuse a decision the
// planner already made.
//
// So the caller caps `want` at what is free and never lets the gate fire.
test('the plan freeze is capped at free stock, never refused', () => {
  const orders = code(src('./routes/orders.js'));

  // The trailing '(' is load-bearing: it anchors on the CALL. orders.js also
  // names commitBoardForLine in its import list, and a bare name match finds
  // that first — putting the window over the file's import block, where none of
  // the three markers below can ever appear.
  const at = orders.indexOf('commitBoardForLine(');
  assert.ok(at > -1, 'the plan route never freezes board — Task 3 is not implemented');

  // Scope the cap assertion to the freeze site itself. Matching `Math.min`
  // anywhere in a 2,500-line file would pass on an unrelated line and quietly
  // stop guarding the thing that matters.
  const region = orders.slice(Math.max(0, at - 1200), at + 400);

  assert.match(region, /origin:\s*'plan_lock'/,
    "the freeze must be marked origin:'plan_lock' or the next mix save will absorb it");
  assert.match(region, /Math\.min\(/,
    'the freeze must be CAPPED at free stock in the caller — an uncapped want lets '
    + 'COMMIT_EXCEEDS_FREE roll back the entire plan save');
  assert.match(region, /boardPosition\(/,
    'the cap must come from boardPosition().free, not from a re-derived figure');
});

// Release-then-commit, unconditionally. Four hazards collapse into one rule:
// a re-lock that CHANGES the board (commitBoardForLine is per-material and
// would strand the old board's row), a re-lock that SHRINKS the requirement
// (it returns early on want - alreadyHeld <= 0 and never releases), a save
// that ADOPTS a mix (Phase 1's ABSORB exclusion means the mix's own holds
// would stack on top of a surviving freeze), and plain idempotence.
test('the plan freeze releases before it commits', () => {
  const orders = code(src('./routes/orders.js'));
  // Both anchored on '(' for the same reason as the test above: the two names
  // also appear in orders.js's import lists, and comparing the position of one
  // import against the other would assert nothing about the order the plan
  // route actually runs them in.
  const releaseAt = orders.indexOf('releasePlanLockHolds(');
  const commitAt = orders.indexOf('commitBoardForLine(');
  assert.ok(releaseAt > -1 && commitAt > -1, 'both calls must be present in the plan route');
  assert.ok(releaseAt < commitAt,
    'the release must come BEFORE the commit — otherwise a re-lock that changes board, '
    + 'shrinks the requirement, or adopts a mix leaves a stale freeze behind');
});

// A SAVED DRAFT FREEZES TOO.
//
// Phase 2a excluded drafts deliberately, and said why: a draft that freezes
// before Discard is reachable creates board with no door out. That door now
// exists — POST /gang-runs/:id/plan/discard for a run, POST
// /order-lines/:id/plan/discard for a single line — so the exclusion is spent.
//
// Leaving it in place is not neutral. The release in the freeze block is
// unconditional while the re-commit sits behind !draft, so a draft save against
// an already-locked line STRIPS the freeze and does not replace it. Removing
// the exclusion fixes that in the same move.
test('a draft save freezes board, and does not strip an existing freeze', () => {
  const orders = code(src('./routes/orders.js'));
  // Anchored on '(' for the reason the two tests above already record: the
  // name also appears in this file's import list, and without the paren the
  // FIRST hit is that import — the region would be the import block, where
  // both assertions are vacuous and this guard would watch nothing.
  const at = orders.indexOf('commitBoardForLine(');
  assert.ok(at > -1, 'the plan route no longer freezes board');
  const region = orders.slice(Math.max(0, at - 1200), at + 400);

  assert.ok(!/!draft\s*&&/.test(region),
    'the freeze is still excluded on a draft — a draft save would release the hold and not '
    + 'replace it, leaving an already-locked line unfrozen');
  assert.match(region, /!stillGang/,
    'the gang exclusion must stay in this block — a run freezes through gangs.js, per member');
});

// A RUN FREEZES BOARD, ONE HOLD PER MEMBER, CAPPED ONCE.
//
// A run draws from ONE pile. If each member froze independently, the first
// members would take everything free and the last would get nothing — and if
// the freeze could refuse, the last member's 409 would roll back the entire
// lock. So the cap is struck ONCE at run level and prorated across members.
//
// The holds go on MEMBER lines, never a parent: board_allocations.order_line_id
// is NOT NULL with no gang column, and every gang reader sums rows keyed on
// members, so a parent-level row would be invisible to the run's own figures.
test('a run freezes per member, capped once at run level', () => {
  const gangs = code(src('./routes/gangs.js'));

  assert.match(gangs, /commitBoardForLine\(/,
    'the gang plan route never freezes board — Task 2 is not implemented');
  assert.match(gangs, /origin:\s*'plan_lock'/,
    "a run's freeze must carry origin:'plan_lock' like every other");

  // The trailing '(' is load-bearing, for the reason the three tests above
  // already record: gangs.js now names commitBoardForLine in its import list
  // too, and a bare name match finds THAT first — putting the window over the
  // file's import block, where neither marker below can ever appear and this
  // guard would watch nothing.
  const at = gangs.indexOf('commitBoardForLine(');
  const region = gangs.slice(Math.max(0, at - 2000), at + 600);

  assert.match(region, /boardPosition\(/,
    'the run cap must come from boardPosition().free, struck once before the member loop');
  assert.match(region, /Math\.min\(/,
    'each member share must be CAPPED — an uncapped share lets COMMIT_EXCEEDS_FREE roll back the whole lock');

  // A MIXED SAVE FREEZES NOTHING HERE — replaceMixPlan already did it.
  //
  // The mix writes one hold per row per member, and Phase 1 deliberately
  // stopped its ABSORB from touching an origin='plan_lock' row. So a freeze
  // running alongside a mix is not absorbed by it: the two STACK, and the run
  // holds its board twice on every save — over-commitment, the one thing this
  // whole phase exists to remove. It does not self-correct on re-save either:
  // the persist loop clears the previous mix first, so the freeze re-reads full
  // free stock each time. orders.js carries this same exclusion at its own
  // freeze site, and says why there.
  assert.match(region, /!wantsMix/,
    'the run freeze must stand down when the save carries a board mix — replaceMixPlan '
    + "writes its own holds and ABSORB spares origin='plan_lock', so the two would stack");

  // The release is OUTSIDE that gate and runs first, so a run that GAINS a mix
  // hands its old freeze back instead of leaving it stranded under the mix's
  // holds. Anchored on '(' for the same reason as every other anchor here.
  const releaseAt = gangs.indexOf('releasePlanLockHolds(');
  assert.ok(releaseAt > -1 && releaseAt < at,
    'the run freeze must release every member BEFORE it commits — and unconditionally, '
    + 'or a save that adopts a mix leaves a stale plan_lock hold behind it');

  // Ordering alone is not the property. Moving the release INSIDE the
  // !wantsMix gate would still put it before the commit and still pass the
  // check above, while quietly breaking the thing it protects: a run that
  // GAINS a mix would skip the release entirely and strand its old freeze
  // under the mix's own holds. Pin the gate as sitting BETWEEN them.
  assert.ok(gangs.indexOf('!wantsMix', releaseAt) > releaseAt
    && gangs.indexOf('!wantsMix', releaseAt) < at,
    'the !wantsMix gate must sit between the release and the commit — with the release '
    + 'outside it, or a save that adopts a mix never hands its old freeze back');
});

// ── A2: the approver gate, and the doors it must cover ─────────────────────
//
// The gate lives in planMove (see board-allocation.test.js). These are the
// wiring assertions a pure test cannot make.
//
// It is keyed on users.is_management read FRESH FROM THE TABLE. The JWT carries
// only {id, name, role} — `req.user.is_management` is undefined for every user
// including the MD — so a gate reading req.user would not be strict, it would be
// a total lockout, and no unit test passing a fake user object would catch it.
test('A2: the gate reads is_management from the users table, never from the JWT', () => {
  const board = code(src('./routes/board.js'));

  assert.match(board, /SELECT is_management FROM users WHERE id=\$1/,
    'the management flag must be read from the users table. The JWT does not carry it '
    + '(auth.js signs only id/name/role), so a gate on req.user.is_management refuses EVERYONE.');
  assert.ok(!/req\.user\.is_management/.test(board),
    'req.user.is_management is always undefined — reading it locks out the MD as well as the planner');
});

test('A2: preview and move ask the SAME question', () => {
  const board = code(src('./routes/board.js'));
  const calls = [...board.matchAll(/actorIsManagement:/g)].length;
  assert.ok(calls >= 2,
    `actorIsManagement is passed ${calls} time(s) — both /board/move and /board/move/preview must `
    + 'pass it. A preview that skips the gate tells the planner the move is fine and the button '
    + 'then refuses it, which is worse than showing no preview at all.');
});

// THE TWO-CLICK BYPASS.
//
// /board/uncommit releases a job's hold outright, and it takes any line id — so
// without a gate the whole of A2 is theatre: uncommit job A's frozen sheets,
// watch them fall into `free`, then commit them to job B. Two ordinary clicks,
// no approver, and the board_allocations trail says a release and a commit
// rather than a raid.
//
// A3 already fixed the list of things allowed to release a freeze: reversing the
// plan, or a job taking board from another job. Uncommit is neither, so it is
// the same act the gate governs and takes the same flag.
test('A2: uncommit is gated too, or the gate is a two-click bypass', () => {
  const board = code(src('./routes/board.js'));
  const at = board.indexOf("r.post('/board/uncommit'");
  assert.ok(at >= 0, '/board/uncommit moved — find it before deleting this test');
  const body = board.slice(at, at + 2600);

  assert.match(body, /isManagement\(/,
    'POST /board/uncommit releases a freeze without asking who is asking. Uncommit-then-commit '
    + 'moves frozen board between jobs in two clicks and never touches planMove, so the approver '
    + 'gate never runs.');
});

// ── A4: the PR door exists, and it goes through the GATED engine ───────────
//
// A4 asked for a "take board from another job" door in the PR/procurement
// module. It is BUILT — and it was recorded as missing for a while because the
// check grepped routes/procurement.js for move references and found none.
// That was the wrong file, and the absence is the CORRECT design:
//
//   Procurement PR register
//     -> the "N in warehouse" chip on a PR row  (Procurement.jsx)
//     -> <BoardCommitments prContext={pr}>      (targetLineId = pr.order_line_id)
//     -> "Move to this PR"                      (BoardCommitments.jsx)
//     -> POST /board/move                       -> planMove -> the A2 gate
//     -> planMove's pr_down effects reduce or close the PR itself
//
// A2's whole premise is that Planning and the PR module are two doors onto ONE
// act. Reusing /board/move is what makes the approver gate cover both. A second
// board-move route inside procurement.js would be a door that does not go
// through planMove — ungated on the day it is written, and the exact failure A2
// exists to prevent. So the assertion below is deliberately a NEGATIVE one:
// "A4 is missing" must never again be fixed by building a parallel route.
const readAt = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('A4: procurement opens the board panel against the PR it is buying for', () => {
  const proc = code(readAt('../../client/src/pages/Procurement.jsx'));
  assert.match(proc, /<BoardCommitments/, 'Procurement no longer opens the board panel — the PR door is gone');
  assert.match(proc, /prContext=\{/,
    'the panel must be opened WITH the PR, or it has no target line and the "Move to this PR" '
    + 'button never renders — the door silently disappears while the panel still opens');
});

test('A4: the PR door moves board through the shared, gated route', () => {
  const panel = code(readAt('../../client/src/components/BoardCommitments.jsx'));
  assert.match(panel, /Move to this PR/, 'the PR-side move button is gone');
  assert.match(panel, /api\.post\(\s*'\/board\/move'/,
    'the PR door must POST /board/move — that route is where planMove, and therefore the A2 '
    + 'approver gate, actually runs');
});

test('A4: procurement must NOT grow its own board-move route around the gate', () => {
  const proc = code(src('./routes/procurement.js'));
  assert.ok(!/planMove\(/.test(proc),
    'routes/procurement.js calls planMove directly. If that is a new board-move door it must go '
    + 'through POST /board/move like the PR panel does, so it inherits the approver gate and the '
    + 'hold-release accounting rather than re-implementing either.');
  assert.ok(!/r\.post\('\/(requisitions\/:id\/)?board-move/.test(proc),
    'a second board-move route inside procurement is a door that bypasses planMove — A2 names '
    + 'exactly this as the way the gate gets lost');
});
