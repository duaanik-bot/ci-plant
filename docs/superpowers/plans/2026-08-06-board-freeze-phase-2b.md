# Board freeze — Phase 2b (drafts, gangs, back-fill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **SESSION RULE.** This directory forbids `git commit`, `git push` and any deploy unless sanctioned out loud in the current session. Each task ends with a commit step because a complete plan needs one. **If commits are not sanctioned, skip every commit step and say so — do not do it quietly.**

**Goal:** Finish the freeze — saved drafts and ganged runs reserve board too — then migrate the existing pipeline onto it with a back-fill the owner reads before it writes anything.

**Architecture:** Four tasks. Drafts and gangs are turned on *first* so that when the back-fill runs, one pass covers the whole pipeline instead of leaving ganged jobs to a second sweep later. The back-fill is split in two: a report that writes nothing, and an apply that runs only after the owner has read the report.

**Tech Stack:** Node 20+ ESM, Express, PostgreSQL. `node:test` + `node:assert/strict`. `pg` directly in the back-fill script.

---

## Why this order differs from the original scope

The adjudicated Phase 2 put the back-fill before gangs. This plan reverses that.

The owner's words were *"all those entries to be migrated into a different column for the stocks which we have overcommitted"* — **one** migration of the current state. Back-filling before gangs freeze would cover single jobs only, and every ganged job in the pipeline would need a second back-fill later, with a second approval and a second chance to get it wrong.

Freezing gangs first costs nothing in risk: gangs freezing is a no-op on existing data (nothing is frozen until the back-fill runs) and lets one report show him the whole picture.

## What Phase 2b inherits

Phases 1 and 2a are in the worktree, uncommitted. Locking a single, non-ganged, non-mixed job already freezes its board, capped at what is free, and every un-plan path releases it. Cutting consumes it.

**Two things landed upstream mid-flight that this plan depends on:**

- `POST /gang-runs/:id/plan/discard` (`gangs.js`) — the run-level Save/Discard pair, shipped in `198edd3`. This is what makes the draft freeze safe to turn on: it is the door out that decision 3 was conditional on.
- `POST /gang-runs/:id/plan` now takes `draft: true`, and its own comment says *"The one thing a draft DOES commit is board — replaceMixPlan mirrors every mix row into board_allocations"*.

The freeze release has already been wired into the new gang discard route. That was done as part of closing out 2a and is **not** a task here.

---

## Before you start

**Re-pin the ref.** `origin/main` moved 18 commits in one afternoon during Phase 2 and went stale underneath this work twice.

```bash
cd ~/Documents/CI\ ERP\ FInal/ci-erp && git fetch && git log --oneline -3 origin/main
```

The worktree was at `4210f9c` when this was written. If `origin/main` has moved, update the worktree before starting — back up first, since there is uncommitted work in it:

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && git diff > /tmp/board-freeze-backup.patch && git stash push -u && git merge --ff-only origin/main && git stash pop
```

Resolve any conflict by keeping **both** sides — every conflict so far has been two people adding to the same import list.

**Work from:** `~/.config/superpowers/worktrees/ci-erp/board-freeze`. `node_modules` is a symlink — never `npm install`.

**Baseline:** 1385 tests, 1385 pass, 0 fail.

**Do NOT run `npm run verify`** — `build-baseline.mjs --check` *writes* the baseline here. Use `npm test -w server`.

**Never connect to any database, never read credential files.** The back-fill script is written to disk and never run against anything in this plan.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/routes/orders.js` | drop the `!draft` exclusion from the freeze | modify |
| `server/src/routes/gangs.js` | freeze each member of a locked or saved run | modify |
| `scripts/backfill-board-freeze.mjs` | the report, then the apply | create |
| `server/src/board-hold-origin.test.js` | guards for both | modify |
| `.gitignore` | keep the report CSV out of git | modify |

---

## Task 1: A saved draft freezes its board

Phase 2a excluded drafts for one reason, recorded in its own comment: a draft that freezes before Discard is reachable creates board with no door out. `198edd3` built that door. The exclusion can go.

This also fixes a defect 2a shipped knowingly: a `draft: true` save against an already-locked line currently **releases** the freeze and does not replace it, because the release is unconditional but the re-commit sits behind `!draft`.

**Files:**
- Modify: `server/src/routes/orders.js`
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript

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
  const at = orders.indexOf('commitBoardForLine');
  assert.ok(at > -1, 'the plan route no longer freezes board');
  const region = orders.slice(Math.max(0, at - 1200), at + 400);

  assert.ok(!/!draft\s*&&/.test(region),
    'the freeze is still excluded on a draft — a draft save would release the hold and not '
    + 'replace it, leaving an already-locked line unfrozen');
  assert.match(region, /!stillGang/,
    'the gang exclusion must stay in this block — a run freezes through gangs.js, per member');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `the freeze is still excluded on a draft`.

- [ ] **Step 3: Drop the exclusion**

In `server/src/routes/orders.js`, find the freeze condition:

```javascript
      if (!draft && !stillGang && !wantsMix && eff.board_material_id && parentSheets > 0) {
```

Replace with:

```javascript
      if (!stillGang && !wantsMix && eff.board_material_id && parentSheets > 0) {
```

- [ ] **Step 4: Correct the comment above it**

The block's comment still lists `draft` as an exclusion. Find:

```javascript
      //   draft    — a saved draft freezes in Phase 2b, gated on Discard being
      //              reachable everywhere first. Freezing before that door
      //              exists creates board with no way out.
```

Replace with:

```javascript
      //   (draft is NOT excluded.) A saved draft freezes exactly as a lock
      //   does. It was excluded in Phase 2a only until Discard existed on every
      //   screen that can create one — POST /gang-runs/:id/plan/discard closed
      //   that, so a draft's board can always be handed back. The route's own
      //   header has said the same thing for longer: "the one thing a draft
      //   DOES commit is board". This makes the engine agree with it.
```

- [ ] **Step 5: Run the tests**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: PASS, 14 tests.

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --test server/src/app-imports.test.js && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1386 pass, 0 fail**.

- [ ] **Step 6: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/orders.js server/src/board-hold-origin.test.js && git commit -m "feat(planning): a saved draft freezes its board too"
```

---

## Task 2: A run freezes board, one hold per member

Decision 8, in the owner's words: *"we will consider the child for that particular run, not what its master says. However, do not conflict with the combined orders which we have merged for one product … for that, we will fetch the data from the master itself."*

That is the existing `gang_runs.kind` column, and the resolution rule is **by run KIND**:

| `kind` | What it is | Sized from |
|---|---|---|
| `gang` | different products on one shared sheet, splits into child cards after die cutting | **the child** — each member's own `parent_sheets_required` |
| `merge` | a COMBINED RUN: the same product across several sales orders, never splits | **the master** — one product, so every member's figure derives from it |

In both cases the **hold rows go on member lines.** `board_allocations.order_line_id` is `NOT NULL` and there is no gang column, and every gang reader (`gangIncoming`, `gangPosition`, `claimsByBoard`) sums rows keyed on members. A parent-level row would have nothing to hang on.

The difference between the kinds is what each member's figure is derived from — and the route has already written that figure to `parent_sheets_required` by the time the freeze runs, using the kind-appropriate rule. **So the freeze reads `parent_sheets_required` per member and is correct for both kinds without branching on kind itself.** That is the point of writing it into the schema rather than re-deriving it.

**The cap must be struck once at run level and prorated.** A run draws from ONE pile. If each member calls the freeze independently, the first members take everything free and the last one gets nothing — or worse, refuses and rolls back the whole lock.

**Files:**
- Modify: `server/src/routes/gangs.js`
- Modify: `server/src/board-hold-origin.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/src/board-hold-origin.test.js`:

```javascript

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

  const at = gangs.indexOf('commitBoardForLine');
  const region = gangs.slice(Math.max(0, at - 2000), at + 600);

  assert.match(region, /boardPosition\(/,
    'the run cap must come from boardPosition().free, struck once before the member loop');
  assert.match(region, /Math\.min\(/,
    'each member share must be CAPPED — an uncapped share lets COMMIT_EXCEEDS_FREE roll back the whole lock');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js
```

Expected: FAIL — `the gang plan route never freezes board`.

- [ ] **Step 3: Add the freeze to the run plan route**

In `server/src/routes/gangs.js`, inside `POST /gang-runs/:id/plan`, find the end of the per-member loop that writes `sheets_required` / `parent_sheets_required` and flips status. The freeze goes **after** that loop has finished, so every member's `parent_sheets_required` is already written.

Insert immediately after that loop closes:

```javascript
      // ── FREEZE THE RUN'S BOARD, ONE HOLD PER MEMBER ─────────────────────
      //
      // A run draws from ONE pile, so the cap is struck ONCE here and split
      // across members. Freezing member by member without a shared cap would
      // let the first members take everything free and starve the last — and
      // because commitBoardForLine refuses past `free`, the last member's 409
      // would roll back this entire lock, every member's figures with it.
      //
      // The rows go on MEMBERS, never on the run. board_allocations.order_line_id
      // is NOT NULL and carries no gang column, and every gang reader
      // (gangIncoming, gangPosition, claimsByBoard) sums rows keyed on member
      // lines — a parent-level row would be invisible to the run's own shortage
      // figure, which is the number this exists to make honest.
      //
      // No branch on gang vs merge. The kind decides how each member's
      // parent_sheets_required was DERIVED — the child for a gang, the master
      // for a combined run — and the loop above has already written it. Reading
      // it back here is correct for both kinds by construction. Re-deriving it
      // would be a second implementation of a rule the schema already holds.
      const freezeBoard = lines[0] ? await oc(
        `SELECT ${EFF_BOARD_ID} AS id FROM order_lines ol WHERE ol.id=$1`, [lines[0].id]) : null;
      if (freezeBoard?.id) {
        for (const line of lines) {
          await releasePlanLockHolds(line.id, qc, req.user.name, 'run re-planned');
        }
        const [avail, allLines, allocs] = await commitInputs(freezeBoard.id, qc);
        const { free } = boardPosition({
          available: avail, allocations: allocs, lines: allLines, materialId: freezeBoard.id,
        });
        let budget = Math.max(0, free)
          + lines.reduce((s, l) => s + heldFor(allocs, l.id, freezeBoard.id), 0);
        for (const line of lines) {
          if (budget <= 0) break;
          const need = Number((await oc(
            'SELECT parent_sheets_required FROM order_lines WHERE id=$1', [line.id]
          ))?.parent_sheets_required || 0);
          const want = Math.min(need, budget);
          if (want <= 0) continue;
          await commitBoardForLine({
            materialId: freezeBoard.id,
            lineId: line.id,
            want,
            reason: `Frozen by the planning engine for ${gang.gang_number}`,
            origin: 'plan_lock',
            user: req.user.name,
          }, qc);
          budget -= want;
        }
      }
```

- [ ] **Step 4: Add the imports**

`gangs.js` already imports `releasePlanLockHolds` and `EFF_BOARD_ID` from `'../helpers.js'`. Add the rest near the other route imports:

```javascript
import { commitBoardForLine, commitInputs } from './board.js';
```

And extend the existing `'../board-allocation.js'` import to include `boardPosition` and `heldFor` if they are not already there. Do not duplicate an import that exists — merge into the existing statement.

- [ ] **Step 5: Verify imports resolve**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --test server/src/app-imports.test.js
```

Expected: PASS. A circular import between `gangs.js` and `board.js` would surface here. If it does, report BLOCKED — the fix is to move `commitBoardForLine` into `board-allocation.js`, which is a plan change, not something to work around.

- [ ] **Step 6: Run the tests**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze/server && node --test src/board-hold-origin.test.js && node --test src/run-save-discard.test.js
```

Expected: `board-hold-origin` PASS 15; `run-save-discard` PASS 16 (upstream's own tests must not regress).

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1387 pass, 0 fail**.

- [ ] **Step 7: Commit** *(skip if this session forbids commits)*

```bash
git add server/src/routes/gangs.js server/src/board-hold-origin.test.js && git commit -m "feat(planning): a run freezes its board, one hold per member"
```

---

## Task 3: The back-fill, report only

Every promise made to the owner about this script:

1. **It runs as a report first and writes nothing** until he has read the list.
2. **It only ever ADDS rows to `board_allocations`** — never stock, never issued quantities, never order quantities.
3. **One statement reverses it.**

This task builds the report. Task 4 adds the apply.

**Files:**
- Create: `scripts/backfill-board-freeze.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write the script**

Create `scripts/backfill-board-freeze.mjs`:

```javascript
// One-off migration: freeze the board that jobs already in the pipeline are
// holding, so the warehouse stops over-showing them.
//
//   DATABASE_URL=… node scripts/backfill-board-freeze.mjs                        # report
//   DATABASE_URL=… node scripts/backfill-board-freeze.mjs --apply --prod-i-mean-it
//
// WHY THIS EXISTS. Until the plan-lock freeze, locking a plan reserved nothing:
// "committed" on the warehouse screen was derived demand, not a claim. Every job
// locked before that change therefore holds no board at all. Switching the
// screen over without this would read tens of thousands of sheets as FREE that
// live jobs are already eating, and planners would promise them.
//
// WHAT IT WILL AND WILL NOT TOUCH. It writes board_allocations rows and nothing
// else — no stock_batches, no stock_movements, no order_lines. The shelf count,
// the sheets already issued to the floor and what each job needs are all
// somebody else's job to change. That is the plant owner's own condition on this
// work, and board-hold-origin.test.js enforces it in the application code.
//
// THE PREDICATE THAT MUST NOT BE OMITTED is the drawn-board exclusion.
// 'in_production' is a live status, so a naive query picks up jobs whose board
// has ALREADY left the warehouse. Freezing those double-counts them: `available`
// was reduced by the past draw, and a fresh active hold subtracts the same
// sheets again. That is the single biggest way this could disturb something
// already issued, which is the one thing the owner asked never to happen.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const MEANT = process.argv.includes('--prod-i-mean-it');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL. This script never guesses a database — a confident report\n'
    + 'about the wrong one is worse than no report.');
  process.exit(2);
}
const isRemote = !/@(localhost|127\.0\.0\.1)[:/]/.test(url);
if (APPLY && isRemote && !MEANT) {
  console.error('REFUSING: --apply against a REMOTE database also needs --prod-i-mean-it.');
  process.exit(2);
}

// ONE predicate, shared by the count, the listing and the write, so the report
// and the apply can never describe different sets of rows.
const CANDIDATES = `
  SELECT ol.id,
         ol.status,
         COALESCE(ol.parent_sheets_required, ol.sheets_required) AS need,
         COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS material_id,
         p.name AS product_name,
         o.po_number,
         c.name AS customer_name
    FROM order_lines ol
    JOIN products  p ON p.id = ol.product_id
    JOIN orders    o ON o.id = ol.order_id
    JOIN customers c ON c.id = o.customer_id
   WHERE ol.status IN ('planned','ready','in_production')
     AND COALESCE(ol.parent_sheets_required, ol.sheets_required) > 0
     AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) IS NOT NULL
     -- The parking board is a real row named 'Unspecified board', NOT the
     -- lowest-id board. Resolving it by id clears exactly the rows to keep.
     AND COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id)
         NOT IN (SELECT id FROM materials WHERE name ILIKE '%unspecified%')
     -- Already drawn: the sheets are on the floor and out of `available`.
     -- Freezing them would bill the same board twice.
     AND NOT EXISTS (
       SELECT 1 FROM stock_movements sm
        JOIN job_cards jc ON jc.id = sm.ref_id
       WHERE sm.ref_type = 'job_card' AND sm.type = 'consumption'
         AND jc.order_line_id = ol.id)
     -- Anything already holding board is either a mix, a hand commit or an
     -- organic freeze. All three are current; leave them alone.
     AND NOT EXISTS (
       SELECT 1 FROM board_allocations ba
        WHERE ba.order_line_id = ol.id AND ba.status = 'active' AND ba.source = 'stock')
   ORDER BY ol.planned_date NULLS LAST, o.delivery_date, ol.id`;

const c = new pg.Client({ connectionString: url, ssl: isRemote ? { rejectUnauthorized: false } : undefined });
await c.connect();
try {
  await c.query('BEGIN');

  console.log(isRemote ? '*** REMOTE DATABASE ***' : 'local database');
  console.log(APPLY ? 'mode: APPLY (will write)' : 'mode: REPORT (writes nothing)\n');

  const { rows: candidates } = await c.query(CANDIDATES);

  // Free stock per board, read once. available − active holds, the same
  // arithmetic boardPosition() runs in the app.
  const ids = [...new Set(candidates.map(r => r.material_id))];
  const { rows: boards } = await c.query(
    `SELECT m.id, m.name,
            COALESCE((SELECT SUM(qty) FROM stock_batches sb
                       WHERE sb.material_id=m.id AND sb.status='available'), 0) AS available,
            COALESCE((SELECT SUM(qty) FROM board_allocations ba
                       WHERE ba.material_id=m.id AND ba.status='active' AND ba.source='stock'), 0) AS held
       FROM materials m WHERE m.id = ANY($1)`, [ids]);
  const free = new Map(boards.map(b => [b.id, Math.max(0, Number(b.available) - Number(b.held))]));
  const name = new Map(boards.map(b => [b.id, b.name]));

  // Walk in the same order the board panel lists claimants — planned date, then
  // delivery date, then id — so the jobs the plant would serve first are the
  // jobs that get the board. Cap per board as we go.
  const plan = [];
  let shortfall = 0;
  for (const r of candidates) {
    const budget = free.get(r.material_id) ?? 0;
    const want = Math.min(Number(r.need), budget);
    if (want > 0) {
      plan.push({ ...r, want });
      free.set(r.material_id, budget - want);
    }
    const missed = Number(r.need) - want;
    if (missed > 0) shortfall += missed;
  }

  console.log(`candidate jobs      : ${candidates.length}`);
  console.log(`would freeze        : ${plan.length} jobs`);
  console.log(`sheets frozen       : ${plan.reduce((s, x) => s + x.want, 0)}`);
  console.log(`sheets SHORT        : ${shortfall}  <- these need a PR or an alternate board\n`);

  const byBoard = new Map();
  for (const p of plan) {
    if (!byBoard.has(p.material_id)) byBoard.set(p.material_id, []);
    byBoard.get(p.material_id).push(p);
  }
  for (const [mid, rows] of byBoard) {
    console.log(`${name.get(mid)} — ${rows.length} job(s), ${rows.reduce((s, x) => s + x.want, 0)} sheets`);
    for (const x of rows) {
      console.log(`   ${String(x.po_number || '').padEnd(14)} ${String(x.customer_name || '').slice(0, 20).padEnd(22)}`
        + `${String(x.product_name).slice(0, 30).padEnd(32)} ${String(x.want).padStart(7)}`
        + (x.want < Number(x.need) ? `  (short ${Number(x.need) - x.want})` : ''));
    }
  }

  // Refuse a runaway. This is meant to cover a pipeline of order tens to low
  // hundreds. If it ever matches thousands, the candidate query has stopped
  // discriminating and a human must look before anything is written.
  if (plan.length > 1000) {
    console.error(`\nREFUSING: ${plan.length} jobs is far more than this plant's pipeline. Check the query.`);
    await c.query('ROLLBACK');
    process.exit(1);
  }

  await c.query('ROLLBACK');
  console.log('\nreport only — nothing written.');
} catch (e) {
  console.error('FAILED:', e.message);
  try { await c.query('ROLLBACK'); } catch {}
  process.exitCode = 1;
} finally {
  await c.end();
}
```

- [ ] **Step 2: Keep the report out of git**

The listing carries customer names and PO numbers. Add to `.gitignore`:

```
board-freeze-backfill-*.txt
```

- [ ] **Step 3: Check it parses**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --check scripts/backfill-board-freeze.mjs && echo "parses OK"
```

Expected: `parses OK`. **Do not run the script** — it needs a database and this plan never connects to one.

- [ ] **Step 4: Confirm the suite is unaffected**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1387 pass, 0 fail** — a script in `scripts/` is not picked up by `node --test src/*.test.js`.

- [ ] **Step 5: Commit** *(skip if this session forbids commits)*

```bash
git add scripts/backfill-board-freeze.mjs .gitignore && git commit -m "feat(scripts): report what the board-freeze back-fill would do"
```

---

## Task 4: The back-fill, apply

Only after the owner has read Task 3's report.

**Files:**
- Modify: `scripts/backfill-board-freeze.mjs`

- [ ] **Step 1: Add the write path**

In `scripts/backfill-board-freeze.mjs`, find:

```javascript
  await c.query('ROLLBACK');
  console.log('\nreport only — nothing written.');
```

Replace with:

```javascript
  if (!APPLY) {
    await c.query('ROLLBACK');
    console.log('\nreport only — nothing written. Re-run with --apply --prod-i-mean-it.');
  } else {
    // The reversal key is created_by, NOT origin.
    //
    // origin='plan_lock' is byte-identical on a back-fill row and on every
    // organic freeze the engine writes afterwards. A reversal keyed on origin
    // alone, run a week later, would dismantle the entire reservation system
    // instead of this migration. The stamp is what makes "one statement
    // reverses it" true rather than merely short.
    const stamp = `board-freeze back-fill ${new Date().toISOString().slice(0, 10)}`;

    const ids = [];
    for (const p of plan) {
      const { rows: [row] } = await c.query(
        `INSERT INTO board_allocations
           (material_id, order_line_id, qty, source, status, reason, created_by, origin)
         VALUES ($1,$2,$3,'stock','active',$4,$5,'plan_lock') RETURNING id`,
        [p.material_id, p.id, p.want,
         `Back-filled: board this job was already planned against`, stamp]);
      ids.push(row.id);
    }

    if (ids.length !== plan.length) {
      console.error(`\nREFUSING: wrote ${ids.length} rows but planned ${plan.length}.`);
      await c.query('ROLLBACK');
      process.exit(1);
    }

    await c.query('COMMIT');
    console.log(`\napplied: ${ids.length} holds written, stamped "${stamp}".`);
    console.log(`manifest: ${ids.join(',')}`);
    console.log('\nTO REVERSE THE WHOLE BACK-FILL, and nothing else:\n');
    console.log(`  UPDATE board_allocations`);
    console.log(`     SET status='released', released_at=now(), released_by='back-fill reversal',`);
    console.log(`         release_reason='board-freeze back-fill reversed'`);
    console.log(`   WHERE origin='plan_lock' AND created_by='${stamp}' AND status='active';`);
    console.log('\nThe status=\'active\' clause is NOT optional: without it the reversal');
    console.log('un-consumes board that has already physically left the building.');
  }
```

- [ ] **Step 2: Check it parses**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && node --check scripts/backfill-board-freeze.mjs && echo "parses OK"
```

- [ ] **Step 3: Confirm the suite is unaffected**

```bash
cd ~/.config/superpowers/worktrees/ci-erp/board-freeze && npm test -w server 2>&1 | grep -E "^# (tests|pass|fail)"
```

Expected: **1387 pass, 0 fail**.

- [ ] **Step 4: Commit** *(skip if this session forbids commits)*

```bash
git add scripts/backfill-board-freeze.mjs && git commit -m "feat(scripts): apply the board-freeze back-fill, reversible by one statement"
```

---

## Done criteria

- [ ] `npm test -w server` → **1387 pass, 0 fail**
- [ ] A saved draft freezes board; a draft save on a locked line re-freezes rather than stripping
- [ ] Locking or saving a run freezes one hold per member, capped once at run level
- [ ] `scripts/backfill-board-freeze.mjs` parses, reports by default, and needs two flags to write
- [ ] The reversal statement is keyed on `created_by` **and** `status='active'`
- [ ] The Phase 1 guard test still passes — nothing writes to a quantity table

## Before the back-fill runs against real data

**None of this has been exercised against a database.** No test in this suite touches one, and this plan deliberately never connects to one. Before the apply runs anywhere real:

1. Restore a copy of production and run a full **lock → cut → reverse** cycle. Confirm the hold moves `active → consumed` on the cut path, and `active → released` on each un-plan path.
2. Run the report against that copy and read it end to end.
3. Diff the warehouse figures for the pipeline products before and after the apply. `On shelf` must not move by a single sheet — only `Frozen`, `Free to promise` and `Shortfall` may change.
4. Only then run it live, and keep the printed reversal statement.

## Still out of scope after 2b

The RM warehouse column rebuild — On Shelf / Frozen / Free to Promise / Shortfall, the Health redefinition, the KPI strip, `suggestedQty` re-sourcing, the Material 360 relabel, the Leftover list. That is Phase 3, and it is the phase the owner actually sees. Everything before it makes the numbers true; Phase 3 makes them legible.
