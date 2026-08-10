# Board freeze — Phase 1 (foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SESSION RULE — READ BEFORE THE FIRST COMMIT STEP.** The working agreement for this
> directory forbids `git commit`, `git push`, and any deploy unless sanctioned out loud in
> the current session. Every task below ends with a commit step because that is what a
> complete plan looks like for whoever eventually runs it. **If the current session has not
> sanctioned commits, skip every commit step and say so — do not do it quietly.** Run the
> tests, leave the work on disk.

**Goal:** Lay the foundations that let a plan-lock place a real board freeze in Phase 2, without changing a single thing the plant sees today.

**Architecture:** Add a nullable `origin` marker to `board_allocations` so a machine-placed freeze is distinguishable from a planner's hand-placed hold, then re-scope the one piece of code that would eat it (`replaceMixPlan`'s ABSORB). Extract `/board/commit`'s inline arithmetic into a transaction-callable function so `/plan` can reuse it, closing a live over-commit race on the way. Finally fix three pre-existing allocation bugs that are harmless today only because holds are rare, and become data corruption the moment every locked line carries one.

**Tech Stack:** Node 20+ ESM, Express, PostgreSQL (Supabase), `node:test` + `node:assert/strict`. No test framework beyond the Node built-in. Tests are pure-function or source-assertion — there is no DB harness in this suite.

---

## Before you start

Read the design spec: `docs/superpowers/specs/2026-08-06-board-freeze-on-lock-design.md`. Sections 4.3 (hold taxonomy) and 7 (blast-radius bugs) are the ones this plan implements.

**Re-pin the ref first.** This plan was written against `origin/main` @ `cb76028`. That branch moves fast and `cb76028` itself edited `COMMITTED_DEMAND_SQL` one day before this plan was written. Run:

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && git fetch && git log --oneline -3 origin/main
```

If `origin/main` has moved, re-read every file this plan touches before trusting a line number. Line numbers in this plan are anchors for finding code, not for editing blind — always match on the quoted text.

**Test commands:**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-allocation.test.js
```

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server
```

**Do NOT run `npm run verify`.** It calls `node scripts/build-baseline.mjs --check`, and in this repo `--check` **writes** the baseline rather than only checking it. Use `npm test -w server` instead.

**Working tree warning.** The canonical tree is often checked out on a feature branch carrying another session's uncommitted edits. Run `git status --short` before you start. If files unrelated to this plan are modified, leave them alone — never `git checkout --` anything you did not write.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/20260810060358_board_allocation_origin.sql` | the `origin` marker, for existing databases | create |
| `server/src/db.js` | the same DDL for a freshly-initialised database | modify |
| `server/src/helpers.js` | `replaceMixPlan` ABSORB scope; `rollbackLine` PR-mirror release | modify |
| `server/src/routes/board.js` | extract `commitBoardForLine`; close the `commitInputs` race; apply the new `release` effect | modify |
| `server/src/board-allocation.js` | `planMove` emits the missing `release` effect | modify |
| `server/src/routes/procurement.js` | scope `alloc_repoint` to `source='requisition'` | modify |
| `server/src/board-allocation.test.js` | `planMove` release-effect tests | modify |
| `server/src/board-hold-origin.test.js` | source assertions for the SQL-only invariants | create |

Two changes are pure SQL inside route handlers (`ABSORB`, `alloc_repoint`) and one is inside `rollbackLine`. This suite has no database harness, so those are covered by **source-assertion tests** — the established idiom in this repo (`board-state-one-name.test.js`, `gang-anchor-one-spelling.test.js`). They read the source file and assert on the code with comments stripped. That is a weaker guarantee than a real integration test and the plan says so plainly; it is what this codebase supports today.

---

## Task 1: The `origin` marker

`board_allocations` currently tells hold kinds apart with `source` and `job_board_mix_id`. A Phase 2 plan-lock hold is a fourth kind that carries the same shape as a hand-placed one (`source='stock'`, `job_board_mix_id IS NULL`), which is exactly the shape `replaceMixPlan` releases. Without a marker, every mix save silently eats the freeze.

`source` cannot carry it: twelve filters including the cutting gate test `source='stock'`, and a new value would make frozen sheets read as free at the gate. `reason` cannot carry it: it is user-typed on both `/board/move` and `/board/commit`.

**Files:**
- Create: `supabase/migrations/20260810060358_board_allocation_origin.sql`
- Modify: `server/src/db.js` (the board_allocations block, near `ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS job_board_mix_id INTEGER;`)

- [ ] **Step 1: Confirm the timestamped migration name is unique**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && git ls-tree -r --name-only origin/main -- supabase/migrations | tail -3 && ls supabase/migrations | tail -3
```

Execution note: numbered migrations through `0038` landed while this work was open, so the final file was generated with the Supabase CLI as `20260810060358_board_allocation_origin.sql`. Do not recreate the earlier `0034` draft.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/20260810060358_board_allocation_origin.sql`:

```sql
-- Telling a machine-placed freeze from a planner's hand-placed hold.
--
-- A board_allocations row with source='stock' and job_board_mix_id NULL means
-- "a planner pressed Commit on this board while deciding". Locking a plan is
-- about to write a row of exactly that shape for a different reason — the
-- engine reserving what the shelf can cover — and the two must not be confused.
--
-- They must not be confused because replaceMixPlan ABSORBS the first kind: it
-- releases this line's hand-placed holds on any board the new mix names, so
-- committing 500 by hand and then locking a 2,000-sheet mix row leaves 2,000
-- held rather than 2,500. That absorb is correct and stays. But it matches on
-- `source='stock' AND job_board_mix_id IS NULL`, so without a marker here it
-- would swallow an engine freeze on every mix save.
--
-- Why not a new `source` value: source is CHECK-constrained to ('stock',
-- 'requisition') and twelve filters test source='stock' — including
-- issuableFor(), the gate that stops one job drawing another job's board. A
-- new value would make frozen sheets read as FREE on the cutting floor.
--
-- Why not a `reason` tag: reason is free text typed by the user on both
-- /board/move and /board/commit. It is forgeable and it is not a key.
--
-- NULL means every row written before this migration, and every hand-placed or
-- mix-mirrored row written after it. Deliberately no DEFAULT: a defaulted ADD
-- COLUMN rewrites every existing row, and there is nothing to say about holds
-- already on file.
ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS origin TEXT;

ALTER TABLE board_allocations DROP CONSTRAINT IF EXISTS board_allocations_origin_check;
ALTER TABLE board_allocations ADD CONSTRAINT board_allocations_origin_check
  CHECK (origin IS NULL OR origin IN ('plan_lock'));

-- Phase 2 reads "this line's engine freeze on this board" on every lock,
-- re-lock and release. Partial: plan_lock rows are the minority and the index
-- stays small.
CREATE INDEX IF NOT EXISTS idx_alloc_origin_active
  ON board_allocations (order_line_id, material_id)
  WHERE status = 'active' AND origin = 'plan_lock';
```

- [ ] **Step 3: Mirror the DDL in `db.js`**

The migration only reaches databases that already exist. `db.js` builds a fresh one, and if the two drift a new environment is missing the column with no error until something writes to it.

In `server/src/db.js`, find this existing block:

```javascript
ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS job_board_mix_id INTEGER;
```

Immediately ABOVE that line, insert:

```javascript
-- Distinguishes an engine freeze (origin='plan_lock') from a planner's
-- hand-placed Commit (origin NULL). See the board_allocation_origin migration for the full reasoning:
-- replaceMixPlan's ABSORB matches source='stock' AND job_board_mix_id IS NULL,
-- which is the hand-placed shape, and would otherwise swallow the freeze.
ALTER TABLE board_allocations ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE board_allocations DROP CONSTRAINT IF EXISTS board_allocations_origin_check;
ALTER TABLE board_allocations ADD CONSTRAINT board_allocations_origin_check
  CHECK (origin IS NULL OR origin IN ('plan_lock'));
CREATE INDEX IF NOT EXISTS idx_alloc_origin_active
  ON board_allocations (order_line_id, material_id)
  WHERE status = 'active' AND origin = 'plan_lock';
```

- [ ] **Step 4: Verify the two definitions agree**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && diff <(grep -A3 "ADD COLUMN IF NOT EXISTS origin" supabase/migrations/20260810060358_board_allocation_origin.sql | grep -E "ALTER|CHECK") <(grep -A3 "ADD COLUMN IF NOT EXISTS origin" server/src/db.js | grep -E "ALTER|CHECK") && echo "MATCH"
```

Expected: `MATCH`.

- [ ] **Step 5: Confirm the server still boots its schema**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server 2>&1 | tail -5
```

Expected: the same pass/fail counts as before your change. This step is a regression check, not a proof the DDL is right — no test in this suite touches a database.

- [ ] **Step 6: Commit** *(skip if this session forbids commits — see the header)*

```bash
git add supabase/migrations/20260810060358_board_allocation_origin.sql server/src/db.js && git commit -m "feat(board): mark an engine-placed board freeze apart from a hand-placed hold"
```

---

## Task 2: Stop the mix save eating an engine freeze

`replaceMixPlan` releases this line's hand-placed holds on boards the new mix names. That is correct and must survive. It must simply stop matching `origin='plan_lock'` rows.

**Files:**
- Modify: `server/src/helpers.js` (inside `replaceMixPlan`, the `UPDATE board_allocations` with `release_reason='absorbed into the board mix for this job'`)
- Create: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/board-hold-origin.test.js`:

```javascript
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
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `the ABSORB must exclude origin='plan_lock' rows`. The statement is found; the predicate is missing.

- [ ] **Step 3: Add the predicate**

In `server/src/helpers.js`, inside `replaceMixPlan`, find:

```javascript
        WHERE order_line_id=$1 AND status='active' AND source='stock'
          AND job_board_mix_id IS NULL AND material_id = ANY($3::int[])
```

Replace with:

```javascript
        WHERE order_line_id=$1 AND status='active' AND source='stock'
          AND job_board_mix_id IS NULL AND origin IS NULL
          AND material_id = ANY($3::int[])
```

- [ ] **Step 4: Extend the ABSORB comment**

The existing comment says the scoping is deliberate and lists what it excludes. It must now name the third exclusion, or the next reader will "simplify" the predicate back. Find:

```javascript
  // a board the mix does NOT cover is still a live decision the planner made
  // and is left alone, and `requisition`-sourced rows are incoming PR board,
  // a different thing entirely. The mix row's own hold, written below, then
  // states this line's whole intent for that board — one number, not two.
```

Replace with:

```javascript
  // a board the mix does NOT cover is still a live decision the planner made
  // and is left alone, and `requisition`-sourced rows are incoming PR board,
  // a different thing entirely. The mix row's own hold, written below, then
  // states this line's whole intent for that board — one number, not two.
  //
  // `origin IS NULL` is the third exclusion and the newest. An engine freeze
  // placed by locking the plan (origin='plan_lock') carries the same source and
  // the same NULL job_board_mix_id as a hand-placed hold, because it IS a stock
  // hold on a board nothing else has mixed. Absorbing it would release the
  // board the engine just reserved every time the planner touched the mix —
  // the same double-hold bug this block fixes, running the other way.
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 6: Run the full suite**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server 2>&1 | tail -5
```

Expected: no new failures.

- [ ] **Step 7: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/helpers.js server/src/board-hold-origin.test.js && git commit -m "fix(board): a mix save must not absorb an engine-placed freeze"
```

---

## Task 3: Make the commit arithmetic callable inside a transaction

Two problems in one place. `/board/commit` holds all its arithmetic inline in the route handler, so `/plan` — which already runs inside a `tx` — cannot reuse it. And `commitInputs` reads availability and allocations on the **pool** rather than the transaction, so two planners committing different lines on the same board can both pass the free-stock gate and both write a hold. That is a live over-commit race today, independent of everything else in this plan.

The three loaders already accept a `qc` parameter and default to the pool. `commitInputs` simply never passes one.

**Files:**
- Modify: `server/src/routes/board.js` (`commitInputs` at ~line 425, the `/board/commit` handler at ~line 433)

- [ ] **Step 1: Thread the transaction through `commitInputs`**

Find:

```javascript
function commitInputs(materialId) {
  return Promise.all([availableFor(materialId), linesFor(materialId), allocationsFor(materialId)]);
}
```

Replace with:

```javascript
// `qc` is not optional in practice. Every caller runs inside a transaction that
// has already taken `SELECT ... FOR UPDATE` on the order line, and reading these
// three on the POOL instead would defeat that lock entirely: two planners
// committing different lines on the same board would each read the same free
// figure, each pass the gate, and each write a hold — the board over-committed
// by exactly the amount the gate exists to refuse. Defaulted to `q` only so a
// read-only caller outside a transaction still works.
function commitInputs(materialId, qc = q) {
  return Promise.all([availableFor(materialId, qc), linesFor(materialId, qc), allocationsFor(materialId, qc)]);
}
```

- [ ] **Step 2: Extract the arithmetic into a reusable function**

Immediately ABOVE the `r.post('/board/commit', ...)` handler, insert:

```javascript
// Hold board for one job, inside a caller's transaction.
//
// Extracted from the /board/commit handler so the planning engine can place the
// same hold when a plan is locked, rather than a second implementation drifting
// away from this one. The route below is now a thin wrapper: parse, validate the
// material, open a transaction, call this.
//
// `want` is the TOTAL this line should end up holding on this board, not an
// increment — the same contract the button has always had, so calling twice
// leaves one hold rather than two.
//
// `origin` is NULL for a hand-placed commit and 'plan_lock' for an engine
// freeze. It changes nothing about the arithmetic; it only marks the row so
// replaceMixPlan's ABSORB can leave an engine freeze alone.
//
// The caller MUST have taken `SELECT id FROM order_lines WHERE id=$1 FOR UPDATE`
// before calling, and MUST pass its own `qc`. Both are load-bearing: the gate
// reads free stock, and a stale read is an over-commit.
async function commitBoardForLine(
  { materialId, lineId, want, reason, origin = null, user }, qc) {
  const [available, lines, allocations] = await commitInputs(materialId, qc);
  const line = lines.find(l => l.id === lineId)
    || await one('SELECT id, status FROM order_lines WHERE id=$1', [lineId]);
  if (!line) throw Object.assign(new Error('Order line not found'), { status: 404 });

  const alreadyHeld = heldFor(allocations, lineId, materialId);
  const qty = want - alreadyHeld;
  if (qty <= 0) return { committed: 0, held_for_line: alreadyHeld, already: true };

  const { free } = boardPosition({ available, allocations, lines, materialId });
  if (qty > free) {
    const mat = await one('SELECT name FROM materials WHERE id=$1', [materialId]);
    const name = mat?.name || `board #${materialId}`;
    throw Object.assign(
      new Error(free > 0
        ? `Only ${Math.round(free)} more sheets of ${name} are free — take the rest off another job to go further`
        : `No free ${name} left to commit — every sheet is already held`),
      { status: 409, body: { code: 'COMMIT_EXCEEDS_FREE', free: Math.round(free) } });
  }

  await qc(`INSERT INTO board_allocations
              (material_id, order_line_id, qty, source, reason, created_by, origin)
            VALUES ($1,$2,$3,'stock',$4,$5,$6)`,
    [materialId, lineId, qty, reason, user, origin]);

  return { committed: qty, held_for_line: alreadyHeld + qty };
}
```

- [ ] **Step 3: Rewrite the handler to call it**

In the `/board/commit` handler, find the body of the `tx` callback — from `await qc('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);` down to and including the two `audit(...)` calls and the `return { committed: qty, held_for_line: alreadyHeld + qty };`. Replace that whole callback body with:

```javascript
      await qc('SELECT id FROM order_lines WHERE id=$1 FOR UPDATE', [lineId]);
      const reason = String(req.body.reason || '').trim() || 'Committed from the planning engine';
      const res_ = await commitBoardForLine(
        { materialId, lineId, want, reason, origin: null, user: req.user.name }, qc);
      if (res_.already) return res_;

      await audit('materials', materialId, 'board_committed',
        `${res_.committed} sheets committed to order line #${lineId} — ${reason}`, qc, req.user.name);
      await audit('order_line', lineId, 'board_committed',
        `${res_.committed} sheets of ${mat.name} committed — ${reason}`, qc, req.user.name);
      return res_;
```

The `already: true` early return preserves the existing behaviour exactly: a repeat press writes no row and no audit entry.

- [ ] **Step 4: Add it to the named-export block**

`board.js` exports its shared loaders from one block at the bottom rather than inline, and Phase 2's `/order-lines/:id/plan` will import this function the same way `orders.js` already imports `syncPrAllocation` from `procurement.js`. Find:

```javascript
export { linesFor, allocationsFor, openPrsFor, availableFor };
```

Replace with:

```javascript
export { linesFor, allocationsFor, openPrsFor, availableFor, commitBoardForLine };
```

- [ ] **Step 5: Verify the route still compiles and imports resolve**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/app-imports.test.js
```

Expected: PASS. This guard exists because a broken import in a route file has taken production down before — `node --test` never imports the routes otherwise.

- [ ] **Step 6: Run the full suite**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server 2>&1 | tail -5
```

Expected: no new failures.

- [ ] **Step 7: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/board.js && git commit -m "refactor(board): make the commit arithmetic callable in a caller's transaction"
```

---

## Task 4: `planMove` must release the giving line's hold

`movableFrom` returns `min(held + free, claim)` — a line may give board out of its own hold. But `planMove` emits only three effect kinds: `hold` for the receiver, `pr_down`, `pr_new`. Nothing reduces the giver's hold. Today that is nearly harmless because holds are rare. Once Phase 2 gives every locked line a hold, every move double-counts: the receiver gains one and the giver keeps one.

**Files:**
- Modify: `server/src/board-allocation.js` (`planMove`)
- Modify: `server/src/board-allocation.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-allocation.test.js`:

```javascript
test('planMove releases the giving line hold it actually spends', () => {
  // Line 1 holds 800 of board 9 and needs 1,000. Line 2 needs 500 and holds
  // nothing. Moving 300 from line 1 to line 2 must TAKE 300 off line 1's hold,
  // not merely add 300 to line 2's — otherwise the board is held twice.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [
      { id: 1, order_line_id: 1, material_id: 9, qty: 800, source: 'stock', status: 'active' },
    ],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));

  const release = plan.effects.find(e => e.kind === 'release');
  assert.ok(release, 'no release effect — the giving line keeps a hold it just gave away');
  assert.equal(release.order_line_id, 1);
  assert.equal(release.qty, 300);
});

test('planMove releases nothing when the giver holds nothing', () => {
  // The giving line has no hold — its board is coming out of free stock, so
  // there is nothing to release and the effect must be absent entirely.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.equal(plan.effects.some(e => e.kind === 'release'), false,
    'a release effect was emitted for a line holding nothing');
});

test('planMove releases only what the giver holds, never more', () => {
  // Giver holds 100 but is giving 300 — the other 200 comes from free stock.
  // Releasing 300 would drive the hold negative.
  const plan = planMove({
    materialId: 9,
    fromLineId: 1,
    toLineId: 2,
    qty: 300,
    available: 800,
    lines: [
      { id: 1, status: 'planned', product_name: 'A', parent_sheets_required: 1000 },
      { id: 2, status: 'planned', product_name: 'B', parent_sheets_required: 500 },
    ],
    allocations: [
      { id: 1, order_line_id: 1, material_id: 9, qty: 100, source: 'stock', status: 'active' },
    ],
    openPrs: [],
  });

  assert.equal(plan.ok, true, plan.blockers.join(' | '));
  assert.equal(plan.effects.find(e => e.kind === 'release').qty, 100);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-allocation.test.js
```

Expected: FAIL on the first and third new tests — `no release effect — the giving line keeps a hold it just gave away`. The second should already pass.

- [ ] **Step 3: Emit the effect**

In `server/src/board-allocation.js`, inside `planMove`, find:

```javascript
  const effects = [{
    kind: 'hold',
    order_line_id: to.id,
    qty: q,
    text: `${to.product_name} takes ${fmt(q)} sheets from the warehouse`,
  }];
```

Replace with:

```javascript
  const effects = [{
    kind: 'hold',
    order_line_id: to.id,
    qty: q,
    text: `${to.product_name} takes ${fmt(q)} sheets from the warehouse`,
  }];

  // Give back what the giver actually spends out of its OWN hold.
  //
  // movableFrom() is min(held + free, claim): a line may hand over board it is
  // holding, board that is merely free, or a mix of the two. Only the held part
  // is a row that has to be released — the free part was never anyone's. Without
  // this the receiver gains a hold and the giver keeps one, and the same sheets
  // are held twice.
  //
  // Nearly invisible until now because a locked line rarely carried a hold at
  // all. Once the planning engine freezes board on lock, every line does, and
  // every move would over-commit by the amount moved.
  const givenFromHold = Math.min(q, heldFor(allocations, from.id, materialId));
  if (givenFromHold > 0) {
    effects.push({
      kind: 'release',
      order_line_id: from.id,
      qty: givenFromHold,
      text: `${from.product_name} gives up ${fmt(givenFromHold)} held sheets`,
    });
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-allocation.test.js
```

Expected: PASS, all tests including the pre-existing PROPERTY test.

- [ ] **Step 5: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/board-allocation.js server/src/board-allocation.test.js && git commit -m "fix(board): a move must release the hold the giving job spends"
```

---

## Task 5: Apply the release effect in `/board/move`

`planMove` now emits `release`, and the route ignores unknown effect kinds silently — so until this task the new effect does nothing at all.

**Files:**
- Modify: `server/src/routes/board.js` (the `for (const e of plan.effects)` loop in `/board/move`)

- [ ] **Step 1: Handle the effect**

In the `/board/move` handler, find:

```javascript
        if (e.kind === 'hold') {
          await qc(`INSERT INTO board_allocations
                      (material_id, order_line_id, qty, source, reason, created_by)
                    VALUES ($1,$2,$3,'stock',$4,$5)`,
            [+material_id, e.order_line_id, e.qty, reason, req.user.name]);
        }
```

Immediately AFTER that block, insert:

```javascript
        // Take back what the giving line spent out of its own hold. Rows are an
        // immutable ledger, so a partial give releases every active stock row on
        // the board and re-takes the remainder as one fresh row — the same shape
        // /board/uncommit uses, and for the same reason: editing a row in place
        // would lose what was originally taken and when.
        //
        // `origin` is carried onto the kept row. A line that had its board frozen
        // by the engine and then gave some away is still engine-frozen for the
        // rest; dropping the marker here would expose the remainder to being
        // absorbed by the next mix save.
        if (e.kind === 'release') {
          const held = await qc(
            `SELECT id, qty, origin FROM board_allocations
              WHERE material_id=$1 AND order_line_id=$2 AND source='stock' AND status='active'
              ORDER BY id`, [+material_id, e.order_line_id]);
          const total = held.reduce((s, a) => s + Number(a.qty), 0);
          const keep = total - e.qty;
          await qc(`UPDATE board_allocations SET status='released', released_at=now(),
                      released_by=$1, release_reason=$2
                    WHERE id = ANY($3::int[])`,
            [req.user.name, `Board moved to ${to.product_name} — ${reason}`, held.map(a => a.id)]);
          if (keep > 0) {
            await qc(`INSERT INTO board_allocations
                        (material_id, order_line_id, qty, source, reason, created_by, origin)
                      VALUES ($1,$2,$3,'stock',$4,$5,$6)`,
              [+material_id, e.order_line_id, keep,
               `Kept after moving ${e.qty} to ${to.product_name} — ${reason}`,
               req.user.name, held.find(a => a.origin)?.origin ?? null]);
          }
        }
```

- [ ] **Step 2: Verify imports still resolve**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/app-imports.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the full suite**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server 2>&1 | tail -5
```

Expected: no new failures.

- [ ] **Step 4: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/board.js && git commit -m "fix(board): apply the move's release effect against the giving job's hold"
```

---

## Task 6: `alloc_repoint` must not drag a stock freeze onto a substituted board

When a GRN arrives as a different board than ordered, `alloc_repoint` moves the line's allocations onto what actually landed, so the QC burn-down matches. That behaviour is correct and must survive. But the statement carries **no `source` predicate**, while its sibling `alloc_release` eleven lines below explicitly scopes `AND source='requisition'`.

Today it only ever moves PR mirrors, because a locked line rarely holds stock. Once Phase 2 lands, it would drag a shelf freeze onto a board whose sheets are still in quarantine — manufacturing over-commitment on the new board and freeing the old one the job no longer claims.

**Files:**
- Modify: `server/src/routes/procurement.js` (the `alloc_repoint` branch)
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `alloc_repoint must be scoped to requisition mirrors`.

- [ ] **Step 3: Scope the statement**

In `server/src/routes/procurement.js`, find:

```javascript
          await qc(`UPDATE board_allocations SET material_id=$1
                     WHERE order_line_id=$2 AND material_id=$3 AND status='active'`,
            [e.to, e.order_line_id, e.from]);
```

Replace with:

```javascript
          // Scoped to the PR mirror, exactly as alloc_release below is.
          //
          // What changed is what is COMING: the mill sent a different board, so
          // the incoming-board row must follow it or QC burns down against a
          // material nothing arrived for. What did NOT change is what is on the
          // shelf. A source='stock' hold is frozen sheets of the ORIGINAL board,
          // sitting where they always were, and dragging it here would claim
          // board that is still in quarantine while freeing board the job is
          // genuinely still holding.
          //
          // Harmless before the planning engine froze board on lock, because a
          // locked line almost never carried a stock hold. Not harmless now.
          await qc(`UPDATE board_allocations SET material_id=$1
                     WHERE order_line_id=$2 AND material_id=$3 AND status='active'
                       AND source='requisition'`,
            [e.to, e.order_line_id, e.from]);
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Confirm the substitution planner tests still pass**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/grn-substitution.test.js
```

Expected: PASS. The planner emits the effect; only its SQL application changed, so these should be untouched. If one fails, the planner is asserting on application behaviour and needs reading before you proceed.

- [ ] **Step 6: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/procurement.js server/src/board-hold-origin.test.js && git commit -m "fix(grn): substitution repoints incoming board only, never a stock freeze"
```

---

## Task 7: `rollbackLine` must release the PR mirror it strands

`rollbackLine` calls `clearMixPlan`, which releases the **mix-mirrored** hold with a reason on record. But `releaseMixHolds` is scoped `job_board_mix_id IS NOT NULL`, so it covers mix mirrors only. Meanwhile `DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL` nulls `requisition_id` on the PR mirror via `ON DELETE SET NULL` and leaves the row `active`.

In `mode='delete'` the line's own cascade cleans it up. In `mode='rollback'` the line survives and the mirror is stranded — an active hold pointing at no requisition, that no screen can release.

The same scoping gap means a hand-placed hold and a Phase 2 `plan_lock` freeze also survive a rollback. Both are fixed here.

**Files:**
- Modify: `server/src/helpers.js` (`rollbackLine`, around the `DELETE FROM requisitions` at step 3)
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript
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

  assert.match(body, /release_reason='line rolled back[^']*'/,
    'rollbackLine must release the line\'s remaining active holds with a reason on record');
  assert.match(body, /job_board_mix_id IS NULL/,
    'the release must target the holds clearMixPlan does NOT cover (job_board_mix_id IS NULL)');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `rollbackLine must release the line's remaining active holds with a reason on record`.

- [ ] **Step 3: Release the remaining holds**

In `server/src/helpers.js`, inside `rollbackLine`, find:

```javascript
  await qc('DELETE FROM requisitions WHERE order_line_id=$1 AND purchase_order_id IS NULL', [lineId]);
```

Immediately BEFORE that line, insert:

```javascript
  // Release every hold this line still owns that clearMixPlan below cannot see.
  //
  // clearMixPlan → releaseMixHolds is scoped `job_board_mix_id IS NOT NULL`, so
  // it covers the mix's own mirrors and nothing else. Three kinds survive it:
  // the PR mirror (source='requisition'), a hand-placed Commit, and an engine
  // freeze placed by locking the plan. All three are claims on board made for a
  // cut plan that is being erased on the next line.
  //
  // The PR mirror is the sharpest case. The DELETE below removes the
  // requisition, and board_allocations.requisition_id is ON DELETE SET NULL —
  // so without this the mirror is left ACTIVE pointing at nothing, holding board
  // for a purchase that no longer exists, with no screen anywhere able to give
  // it back. Under mode='delete' the line's own cascade eventually collects it;
  // under mode='rollback' the line lives on and the board is fenced forever.
  //
  // Runs BEFORE the DELETE so requisition_id is still readable for the audit.
  const stranded = await qc(
    `UPDATE board_allocations
        SET status='released', released_by=$2, released_at=now(),
            release_reason=$3
      WHERE order_line_id=$1 AND status='active' AND job_board_mix_id IS NULL
      RETURNING material_id, qty, source`,
    [lineId, user, mode === 'delete' ? 'line deleted' : 'line rolled back — cut plan voided']);
  for (const a of stranded) {
    await audit('materials', a.material_id, 'board_hold_released',
      `${a.qty} sheets released from order line #${lineId} — `
      + `${a.source === 'requisition' ? 'incoming board' : 'held board'} freed when the plan was voided`,
      qc, user);
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite**

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && npm test -w server 2>&1 | tail -5
```

Expected: no new failures. Pay particular attention to `order-lifecycle.test.js` — it is the closest thing to a rollback test in this suite.

- [ ] **Step 6: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/helpers.js server/src/board-hold-origin.test.js && git commit -m "fix(board): rolling a line back releases the holds its plan was claiming"
```

---

## Known gaps — read before signing this off

**The spec's Phase 1 asks for tests on `/board/commit` and `/board/uncommit`. This plan does not deliver them, and does not pretend to.**

Both routes are pure database I/O: load three row sets, do arithmetic, insert or update. This repo's server suite is `node --test src/*.test.js` over **pure functions and source assertions** — there is no database harness, no fixtures, no transaction rollback wrapper. Nothing here can execute a route.

Three options, none of which belong inside Phase 1 without a decision:

1. **Build a minimal DB test harness** — a throwaway schema per run, seeded, wrapped in a rolled-back transaction. This is the real answer and it would pay for itself across the whole board-allocation surface, which currently has zero coverage of its SQL. It is also a project of its own, comparable in size to this entire phase.
2. **Extract the decision logic from the I/O.** `commitBoardForLine`'s gate — "given available, allocations, lines, want, what qty do I write or what do I refuse with" — is pure. Pulling that into `board-allocation.js` beside `boardPosition` would make it unit-testable with the fixtures that already exist in `board-allocation.test.js`. Cheaper than option 1, and it only covers the arithmetic, not the write.
3. **Accept source assertions**, as Tasks 2, 6 and 7 do.

The plan ships option 3 for the three SQL fixes because they are one-line predicates where the whole risk *is* the predicate. It ships nothing for `/board/commit` because the risk there is the arithmetic and the transaction boundary, which a source assertion cannot express.

**Recommendation: do option 2 as a Phase 1 addendum before Phase 2 starts.** Phase 2 makes `commitBoardForLine` run on every plan lock in the plant — that is the wrong moment for its gate to be untested. It is not in this plan because it changes the shape of `board-allocation.js`, and that is a call to make deliberately rather than fold in.

**Also deliberately out of scope:** `/board/uncommit` selects every active `source='stock'` row for the line, without excluding mix mirrors — so it can release a locked mix's board and orphan the `job_board_mix_id` link. The spec records this under open risks. It is a real defect, it is adjacent to this work, and it is *not* fixed here because it is not on the spec's Phase 1 list and quietly widening scope is how a foundations phase stops being reviewable. Fix it as its own task, before or after this one.

## Done criteria

- [ ] `npm test -w server` passes with no new failures
- [ ] `server/src/board-hold-origin.test.js` has 3 passing tests
- [ ] `server/src/board-allocation.test.js` has 3 new passing `planMove` tests
- [ ] `supabase/migrations/20260810060358_board_allocation_origin.sql` exists and its DDL matches `server/src/db.js`
- [ ] Nothing the plant sees has changed — no screen, no label, no figure

**Execution note (2026-08-10):** this plan itself did not apply remote DDL, but a later sanctioned step applied and verified the migration on `colour-impressions-prod` before deployment. The application remains undeployed.

## What Phase 1 deliberately does not do

`/order-lines/:id/plan` still places no hold. `origin='plan_lock'` is a column nothing writes yet. That is the whole point: every foundation is in place and reviewable before any behaviour changes.

Phase 2 writes the first `plan_lock` row. It must not start until Task 2 is merged, or the first mix save after the first freeze will release it.
