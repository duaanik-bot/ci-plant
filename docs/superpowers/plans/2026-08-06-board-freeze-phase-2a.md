# Board freeze — Phase 2a (the freeze, single jobs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SESSION RULE.** This directory forbids `git commit`, `git push` and any deploy unless sanctioned out loud in the current session. Each task ends with a commit step because a complete plan needs one. **If the current session has not sanctioned commits, skip every commit step and say so — do not do it quietly.**

**Goal:** Make locking a plan actually reserve the board it needs, for single (non-ganged) jobs, capped at what the shelf can cover and without ever refusing the lock.

**Architecture:** Three tasks in a deliberate order. The release path and the consume path ship **first**, while both are provable no-ops — no row anywhere carries `origin='plan_lock'` until task 3. Only then does the freeze itself go in. At no point can board be frozen with no way to hand it back.

**Tech Stack:** Node 20+ ESM, Express, PostgreSQL. `node:test` + `node:assert/strict`. No DB harness in this suite — SQL-level rules are covered by source assertions, the established idiom here.

---

## Scope: why this is 2a and not all of Phase 2

The adjudicated Phase 2 is eight tasks. Split at the natural seam:

**Phase 2a (this plan)** — release, consume, freeze. After it, a single job's lock reserves board end to end.

**Phase 2b (next plan)** — Discard reachable everywhere, the back-fill report, the back-fill apply, and ganged runs.

The seam is not arbitrary. It is a condition the owner attached to his own decision 3: *"a saved draft freezes stock — **conditional on Discard becoming reachable everywhere first**."* A draft that freezes before Discard is reachable creates board with no door out, which is exactly the hazard this project removes. So:

- **2a freezes on LOCK only.** `draft` saves place no `plan_lock` hold.
- **2b makes Discard reachable, then turns on the draft freeze.**

Ganged runs are also 2b: decision 8 requires one hold per member with the cap struck once at run level and prorated, which is a second feature with its own arithmetic, not a variation of this one.

**Honest consequence, to state plainly when 2a ships:** until 2b lands, the warehouse still over-shows on ganged jobs and on saved drafts. Only locked single jobs are truthful.

---

## Before you start

**Ref.** Written against `origin/main` @ `b3845a9`, plus the uncommitted Phase 1 work in the worktree at `~/.config/superpowers/worktrees/ci-erp/board-freeze`. This branch moves several times a day and has already gone stale twice during this project. Run:

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && git fetch && git log --oneline -3 origin/main
```

If it has moved, re-read every file this plan touches. **Line numbers are anchors for finding code, never for editing blind — always match on the quoted text.**

**Work from the worktree**, which already contains Phase 1:

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && git status --short && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Baseline is **1353 tests, 1353 pass, 0 fail**. Any other number before you start means something changed underneath this plan.

**Do NOT run `npm run verify`** — `build-baseline.mjs --check` *writes* the baseline in this repo. Use `npm test -w server`.

**What Phase 1 already gave you:**

- `board_allocations.origin`, nullable, `CHECK (origin IS NULL OR origin IN ('plan_lock'))` — `board_allocation_origin` migration, mirrored in `db.js`. Nothing writes `'plan_lock'` yet.
- `commitBoardForLine({materialId, lineId, want, reason, origin, user}, qc)` in `server/src/routes/board.js`, exported. Takes `pg_advisory_xact_lock(764001, materialId)` before reading the position, so it is safe against two planners on one board. `want` is a **TOTAL**, not an increment. Throws 409 `COMMIT_EXCEEDS_FREE` when the delta exceeds free stock.
- `replaceMixPlan`'s ABSORB excludes `origin IS NULL`, so a mix save cannot eat a freeze.
- `rollbackLine` releases holds with `job_board_mix_id IS NULL` — which already covers a `plan_lock` row.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/helpers.js` | `releasePlanLockHolds` + `consumePlanLockHolds`; release on cancellation | modify |
| `server/src/routes/workflow.js` | release on `reverse_plan` | modify |
| `server/src/routes/orders.js` | release on `/plan/discard`; **the freeze itself** | modify |
| `server/src/routes/gangs.js` | release in the gang-reverse member loop | modify |
| `server/src/routes/production.js` | consume at cutting start, both branches | modify |
| `server/src/board-hold-origin.test.js` | source assertions for the new SQL rules | modify |

---

## Task 1: `releasePlanLockHolds`, wired into every path that ends a plan

A `plan_lock` hold has `job_board_mix_id` NULL and `source='stock'`, so it is invisible to all three existing helpers: `releaseMixHolds` and `consumeMixHolds` are scoped `job_board_mix_id IS NOT NULL`, and `consumeCoverHolds` matches `reason LIKE 'Covered from CI-GRN-%'`. Nothing today can give a `plan_lock` hold back.

This ships **first** because it is a provable no-op — no row carries `origin='plan_lock'` until Task 3 — so it lands with zero behaviour change, and after Task 3 there is never a window where the engine can freeze board no screen can release.

**Files:**
- Modify: `server/src/helpers.js`
- Modify: `server/src/routes/workflow.js`, `server/src/routes/orders.js`, `server/src/routes/gangs.js`
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript

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
  const paths = [
    ['./routes/workflow.js', 'reverse_plan'],
    ['./routes/orders.js', '/plan/discard'],
    ['./routes/gangs.js', 'gang reverse'],
    ['./helpers.js', 'cancellation via setLineStatus'],
  ];
  for (const [file, what] of paths) {
    assert.match(code(src(file)), /releasePlanLockHolds\(/,
      `${file} never calls releasePlanLockHolds — ${what} would leave board frozen on a plan that no longer exists`);
  }
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `releasePlanLockHolds is missing`. The third test should already pass.

- [ ] **Step 3: Add the helper**

In `server/src/helpers.js`, find the end of `consumeCoverHolds` (it closes with the `reason LIKE 'Covered from CI-GRN-%'` predicate). Append immediately **after** that function:

```javascript

// The plan-lock counterpart of releaseMixHolds — undoing a PLANNING decision.
//
// The engine freezes board when a plan is locked, so that a job the plant has
// committed to cannot have its board eaten by whoever reaches cutting first.
// When that plan stops existing — reversed, discarded, rolled back, cancelled —
// the freeze must go with it, or the warehouse fences off sheets for a job that
// is not going to run.
//
// Scoped by origin, and by order_line_id with NO material predicate. That
// omission is deliberate and load-bearing: four separate paths move a planned
// line's EFFECTIVE board out from under its freeze — a re-lock that picks a
// different board, a gang board change, a master board edit, and GRN
// substitution. A material-scoped release would miss the row sitting on the
// board the line has just left, and that row is precisely the orphan.
//
// Distinct from consumePlanLockHolds below, which is the board physically
// leaving the warehouse. Releasing there instead would return sheets to `free`
// that are already on the floor — the same distinction releaseMixHolds and
// consumeMixHolds draw, for the same reason.
export async function releasePlanLockHolds(orderLineId, qc, user, why) {
  await qc(
    `UPDATE board_allocations
        SET status='released', released_by=$2, released_at=now(), release_reason=$3
      WHERE order_line_id=$1 AND status='active' AND origin='plan_lock'`,
    [orderLineId, user, why]);
}
```

- [ ] **Step 4: Release on cancellation**

A cancelled line falls out of `BOARD_DEMAND_STATUSES`, so `boardPosition` counts its hold at face value forever with no route able to release it. `LINE_TRANSITIONS` permits `cancelled` from `pending` and `planned` — exactly the states that carry a fresh freeze.

Put it inside `setLineStatus` rather than at its call sites: `orders.js` cancels a line from three places today and that will not stay three.

In `server/src/helpers.js`, find:

```javascript
export async function setLineStatus(lineId, to, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }
  assertTransition(line.status, to);
  await qc('UPDATE order_lines SET status=$1 WHERE id=$2', [to, lineId]);
  await audit('order_line', lineId, `status:${line.status}→${to}`, null, qc, user);
  return { ...line, status: to };
}
```

Replace with:

```javascript
export async function setLineStatus(lineId, to, qc = q, oc = one, user = null) {
  const line = await oc('SELECT * FROM order_lines WHERE id=$1', [lineId]);
  if (!line) { const e = new Error('Order line not found'); e.status = 404; throw e; }
  assertTransition(line.status, to);
  await qc('UPDATE order_lines SET status=$1 WHERE id=$2', [to, lineId]);
  // A cancelled line stops being demand but does NOT stop being a holder: it
  // falls out of BOARD_DEMAND_STATUSES, so boardPosition counts its hold at
  // face value forever and no un-plan route will ever run for it again.
  // LINE_TRANSITIONS allows 'cancelled' from 'pending' and 'planned' —
  // precisely the states that carry a fresh freeze. Released here rather than
  // at the call sites because there are three today and that will not hold.
  if (to === 'cancelled') {
    await releasePlanLockHolds(lineId, qc, user, 'order line cancelled');
  }
  await audit('order_line', lineId, `status:${line.status}→${to}`, null, qc, user);
  return { ...line, status: to };
}
```

- [ ] **Step 5: Release on `reverse_plan`**

In `server/src/routes/workflow.js`, find the `reverse_plan` branch's `clearMixPlan` call. Immediately **after** it, add:

```javascript
      await releasePlanLockHolds(line.id, qc, req.user.name, 'plan reversed');
```

Add `releasePlanLockHolds` to the import list from `'../helpers.js'` at the top of the file.

- [ ] **Step 6: Release on `/plan/discard`**

In `server/src/routes/orders.js`, find the `clearMixPlan` call inside the `/plan/discard` handler. Immediately **after** it, add:

```javascript
      await releasePlanLockHolds(line.id, qc, req.user.name, 'draft plan discarded');
```

Add `releasePlanLockHolds` to the `'../helpers.js'` import list.

- [ ] **Step 7: Release on gang reverse**

In `server/src/routes/gangs.js`, find the gang-reverse per-member loop containing `clearMixPlan`. Immediately **after** that call, **inside the loop**, add:

```javascript
        await releasePlanLockHolds(m.id, qc, req.user.name, 'gang plan reversed');
```

Match the loop's own member variable — if it is not `m`, use whatever it binds. Add `releasePlanLockHolds` to the `'../helpers.js'` import list.

**Do NOT add a release to** `reverse_to_planning`, `reverse_job_card`, gang remove-line, gang delete, or convert-to-merge. Those keep the plan, so the freeze must survive them.

- [ ] **Step 8: Run the tests**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 8 tests.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --test server/src/app-imports.test.js && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: `app-imports` passes (it catches a broken route import, which has taken production down here before), and the suite is 1353 + 3 new = **1356 pass, 0 fail**.

- [ ] **Step 9: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/helpers.js server/src/routes/workflow.js server/src/routes/orders.js server/src/routes/gangs.js server/src/board-hold-origin.test.js && git commit -m "feat(board): give a plan-lock freeze a release path on every way a plan ends"
```

---

## Task 2: `consumePlanLockHolds` at cutting start

When cutting draws the board, the sheets physically leave. The hold must become `consumed`, not `released` — releasing would return sheets to `free` that are already on the floor.

If this is missing, two things break, and the second is worse. `boardPosition` subtracts the same sheets twice (once gone from `available`, once still held). And `assertFreeToIssue`'s `issuableFor` counts the stale hold as `heldByOthers`, so **every other job on that board is refused, permanently** — with no un-plan path left to run for a job that has already cut.

Ships second, still a no-op, and must precede the freeze absolutely.

**Files:**
- Modify: `server/src/helpers.js`, `server/src/routes/production.js`
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript

// BOARD THAT HAS LEFT THE BUILDING IS CONSUMED, NEVER RELEASED.
//
// board-allocation.js's isActive tests only `status === 'active'`, so
// 'consumed' and 'released' produce IDENTICAL numbers on every screen and in
// every unit test. The difference is the audit trail: 'released' says a
// planning decision was undone, 'consumed' says the sheets went to the floor.
// Getting it wrong here is invisible and permanent, so it is asserted.
test('cutting start consumes a plan_lock hold rather than releasing it', () => {
  const helpers = squash(code(src('./helpers.js')));

  assert.match(helpers, /export async function consumePlanLockHolds\(/,
    'consumePlanLockHolds is missing — a hold would stay active after its board was drawn');

  const fn = helpers.slice(helpers.indexOf('export async function consumePlanLockHolds'));
  const body = fn.slice(0, fn.indexOf('export ', 10));

  assert.match(body, /SET status='consumed'/,
    "must set status='consumed' — 'released' would return sheets to free that are already on the floor");
  assert.ok(!/released_by|released_at|release_reason/.test(body),
    'a consumed hold leaves the release columns unset, byte-for-byte matching consumeMixHolds');
  assert.match(body, /origin='plan_lock'/, 'must target plan_lock rows specifically');
  assert.match(body, /material_id/,
    'must be scoped to the board actually drawn — a line can hold more than one board');
});

test('both cutting-start branches consume plan_lock holds', () => {
  const prod = code(src('./routes/production.js'));
  const calls = [...prod.matchAll(/consumePlanLockHolds\(/g)].length;
  assert.ok(calls >= 2,
    `consumePlanLockHolds is called ${calls} time(s) in production.js — it must run in BOTH `
    + 'branches of the cutting-start block. The else branch (no board mix) is the one MOST lines '
    + 'take, so covering only the mix branch would miss most of the pipeline.');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `consumePlanLockHolds is missing`.

- [ ] **Step 3: Add the helper**

In `server/src/helpers.js`, immediately **after** `releasePlanLockHolds` from Task 1, append:

```javascript

// The Cutting-Start counterpart of releasePlanLockHolds. The board has
// physically left the warehouse, so the freeze has done its job and must be
// retired as CONSUMED, never released — releasing would hand the sheets back to
// `free` when they are already on the machine, and every later job on that
// board would read stock that does not exist.
//
// The distinction is invisible to every screen: board-allocation.js's isActive
// tests only `status === 'active'`, so consumed and released produce identical
// numbers. What differs is the audit trail, permanently.
//
// Scoped by material because a line can hold more than one board — its own
// planned board plus whatever a board-issue override substituted. Only the
// boards actually drawn are consumed here; the caller releases the rest.
export async function consumePlanLockHolds(orderLineIds, materialIds, qc) {
  if (!orderLineIds?.length || !materialIds?.length) return;
  await qc(
    `UPDATE board_allocations SET status='consumed'
      WHERE order_line_id = ANY($1) AND material_id = ANY($2)
        AND status='active' AND source='stock' AND origin='plan_lock'`,
    [orderLineIds, materialIds]);
}

// A job that drew DIFFERENT board than it froze — a board-issue override, a
// substitution — still holds the board it never touched. Released, not
// consumed: those sheets are on the shelf and belong to whoever needs them.
export async function releaseUndrawnPlanLockHolds(orderLineIds, materialIds, qc, user) {
  if (!orderLineIds?.length || !materialIds?.length) return;
  await qc(
    `UPDATE board_allocations
        SET status='released', released_by=$3, released_at=now(),
            release_reason='job cut on a different board'
      WHERE order_line_id = ANY($1) AND material_id <> ALL($2)
        AND status='active' AND source='stock' AND origin='plan_lock'`,
    [orderLineIds, materialIds, user]);
}
```

- [ ] **Step 4: Wire the mix branch**

In `server/src/routes/production.js`, find:

```javascript
          const holdOwners = runLineIds ?? [jc.order_line_id];
          for (const id of holdOwners) await consumeMixHolds(id, qc);
          for (const mid of [...new Set(issued.map(x => x.material_id))])
            await consumeCoverHolds(holdOwners, mid, qc);
```

Replace with:

```javascript
          const holdOwners = runLineIds ?? [jc.order_line_id];
          for (const id of holdOwners) await consumeMixHolds(id, qc);
          const drawnMaterials = [...new Set(issued.map(x => x.material_id))];
          for (const mid of drawnMaterials)
            await consumeCoverHolds(holdOwners, mid, qc);
          // The engine's own freeze retires with the draw, exactly as the mix's
          // holds do above. Boards this job froze but did NOT draw go back to
          // the shelf — a board-issue override can substitute one mid-start.
          await consumePlanLockHolds(holdOwners, drawnMaterials, qc);
          await releaseUndrawnPlanLockHolds(holdOwners, drawnMaterials, qc, req.user.name);
```

- [ ] **Step 5: Wire the else branch**

This is the branch **most lines take** — a `plan_lock` freeze exists on lines with no mix at all, so covering only the mix branch would miss most of the pipeline.

In the same file, find:

```javascript
          const holdLines = jc.order_line_id
            ? [jc.order_line_id]
            : jc.gang_run_id
              ? (await qc('SELECT id FROM order_lines WHERE gang_run_id=$1', [jc.gang_run_id])).map(x => x.id)
              : [];
          await consumeCoverHolds(holdLines, eff.board_material_id, qc);
```

Replace with:

```javascript
          const holdLines = jc.order_line_id
            ? [jc.order_line_id]
            : jc.gang_run_id
              ? (await qc('SELECT id FROM order_lines WHERE gang_run_id=$1', [jc.gang_run_id])).map(x => x.id)
              : [];
          await consumeCoverHolds(holdLines, eff.board_material_id, qc);
          // Same retirement as the mix branch above, and this is the path most
          // jobs take: a plan-lock freeze exists on lines with NO mix at all.
          await consumePlanLockHolds(holdLines, [eff.board_material_id], qc);
          await releaseUndrawnPlanLockHolds(holdLines, [eff.board_material_id], qc, req.user.name);
```

Add `consumePlanLockHolds` and `releaseUndrawnPlanLockHolds` to the `'../helpers.js'` import list at the top of `production.js`.

- [ ] **Step 6: Run the tests**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 10 tests.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --test server/src/app-imports.test.js && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1358 pass, 0 fail**.

- [ ] **Step 7: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/helpers.js server/src/routes/production.js server/src/board-hold-origin.test.js && git commit -m "feat(board): retire a plan-lock freeze when cutting draws the board"
```

---

## Task 3: The freeze itself

Every way of giving a freeze back (Task 1), spending one (Task 2) and reading free stock honestly (Phase 1's advisory lock) now exists. This writes the first `plan_lock` row.

**Files:**
- Modify: `server/src/routes/orders.js`
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript

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

  const at = orders.indexOf('commitBoardForLine');
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
  const releaseAt = orders.indexOf('releasePlanLockHolds');
  const commitAt = orders.indexOf('commitBoardForLine');
  assert.ok(releaseAt > -1 && commitAt > -1, 'both calls must be present in the plan route');
  assert.ok(releaseAt < commitAt,
    'the release must come BEFORE the commit — otherwise a re-lock that changes board, '
    + 'shrinks the requirement, or adopts a mix leaves a stale freeze behind');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `the plan route never freezes board`.

- [ ] **Step 3: Add the freeze**

In `server/src/routes/orders.js`, find the status flip near the end of the `/plan` handler:

```javascript
      if (line.status === 'pending' && !draft) await setLineStatus(line.id, 'planned', qc, oc, req.user.name);
```

Insert immediately **above** it:

```javascript
      // ── FREEZE THE BOARD THIS PLAN NEEDS ────────────────────────────────
      //
      // Until now, locking a plan reserved nothing. "Committed" on the
      // warehouse screen was derived demand, not a claim, so whichever job
      // reached cutting first ate the pile and the job that was planned first
      // failed later, far from the cause. This is the claim.
      //
      // RELEASE FIRST, ALWAYS — unconditional and unbranched. Four hazards
      // collapse into that one rule: a re-lock that CHANGES the board
      // (commitBoardForLine is per-material and would strand the old board's
      // row forever), a re-lock that SHRINKS the requirement (it returns early
      // on `want - alreadyHeld <= 0` and never releases the surplus), a save
      // that ADOPTS a mix (the mix writes its own per-row holds and Phase 1
      // deliberately stopped ABSORB from touching a freeze, so the two would
      // stack), and plain idempotence. The released sheets return to `free`
      // inside this same transaction, so the re-commit below is not starving
      // itself.
      await releasePlanLockHolds(line.id, qc, req.user.name, 'plan re-locked');

      // Three exclusions, each for its own reason:
      //   draft    — a saved draft freezes in Phase 2b, gated on Discard being
      //              reachable everywhere first. Freezing before that door
      //              exists creates board with no way out.
      //   stillGang— a run plans its board as one pile; per-member freezing is
      //              Phase 2b and needs the cap struck at run level. Use
      //              `stillGang`, NOT line.gang_run_id: the gang guard above
      //              can null it mid-handler.
      //   wantsMix — replaceMixPlan already wrote one hold per mix row. A
      //              second claim here would double-hold the same sheets.
      if (!draft && !stillGang && !wantsMix && eff.board_material_id && parentSheets > 0) {
        // CAPPED, NEVER REFUSED. This whole handler is one transaction: a
        // COMMIT_EXCEEDS_FREE thrown here would roll back the qty edit, the
        // master update, the spec override, the mix and the banking — a short
        // shelf would start killing plans the planner already decided on.
        // Physics hard, paperwork soft. The uncovered remainder is not lost:
        // it is exactly what the warehouse's Shortfall column reports.
        const [avail, allLines, allocs] = await commitInputs(eff.board_material_id, qc);
        const { free } = boardPosition({
          available: avail, allocations: allocs, lines: allLines,
          materialId: eff.board_material_id,
        });
        const held = heldFor(allocs, line.id, eff.board_material_id);
        const want = Math.min(parentSheets, held + Math.max(0, free));
        if (want > 0) {
          await commitBoardForLine({
            materialId: eff.board_material_id,
            lineId: line.id,
            want,
            reason: `Frozen by the planning engine for ${eff.name || `line #${line.id}`}`,
            origin: 'plan_lock',
            user: req.user.name,
          }, qc);
        }
      }
```

- [ ] **Step 4: Add the imports**

`orders.js` already imports from `'../helpers.js'`. Add `releasePlanLockHolds` to that list.

The other four come from `board.js`, which `orders.js` does not yet import from — but cross-route imports are the established convention here (`orders.js` already imports `syncPrAllocation` from `'./procurement.js'`). Add near the other route imports:

```javascript
import { commitBoardForLine, commitInputs } from './board.js';
import { boardPosition, heldFor } from '../board-allocation.js';
```

Then in `server/src/routes/board.js`, find:

```javascript
export { linesFor, allocationsFor, openPrsFor, availableFor, commitBoardForLine };
```

Replace with:

```javascript
export { linesFor, allocationsFor, openPrsFor, availableFor, commitBoardForLine, commitInputs };
```

If `orders.js` already imports `boardPosition` or `heldFor`, merge rather than duplicating the import.

- [ ] **Step 5: Verify imports resolve**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --test server/src/app-imports.test.js
```

Expected: PASS. A circular import between `orders.js` and `board.js` would surface here — if it does, report BLOCKED rather than working around it; the fix is to move `commitBoardForLine` into `board-allocation.js`, which is a plan change.

- [ ] **Step 6: Run everything**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 12 tests.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1360 pass, 0 fail**.

- [ ] **Step 7: Check the client shows a failure if one happens**

The freeze cannot throw `COMMIT_EXCEEDS_FREE` by construction, but the route can still fail for other reasons. A To-JC button in this codebase once 409'd invisibly on every click because its handler had no `catch`.

```bash
cd ~/.config/superpowers/worktrees/ci-erp && grep -n "order-lines/\${.*}/plan'" client/src/pages/Planning.jsx | head -3
```

Read the surrounding function and confirm it has a `catch` that surfaces the error to the planner. If it does not, report it as a concern — do not fix it in this task.

- [ ] **Step 8: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/orders.js server/src/routes/board.js server/src/board-hold-origin.test.js && git commit -m "feat(planning): locking a plan freezes the board it needs"
```

---

## Done criteria

- [ ] `npm test -w server` → **1360 pass, 0 fail**
- [ ] `board-hold-origin.test.js` has 12 passing tests
- [ ] Locking a single, non-ganged, non-mixed job writes one `board_allocations` row with `origin='plan_lock'`, capped at free stock
- [ ] Reversing, discarding, rolling back or cancelling that job releases it
- [ ] Cutting it consumes it
- [ ] No path writes to `stock_batches`, `stock_movements` or `order_lines` quantities — the guard test from Phase 1 still passes

## What Phase 2a deliberately does not do

Drafts do not freeze. Ganged runs do not freeze. There is no back-fill, so jobs already in the pipeline carry no freeze until Phase 2b runs one.

**Say this plainly when 2a ships:** until 2b, the warehouse is truthful only for single jobs locked after this change. Everything else still reads the old way.

## Verification that cannot be done here

No test in this suite touches a database. The three new SQL statements are covered by source assertions only — they assert the predicate exists, not that it behaves. Before 2b's back-fill runs against real data, exercise a full lock → cut → reverse cycle against a restored copy of production and confirm the hold's `status` moves `active → consumed` on the cut path and `active → released` on each un-plan path.
