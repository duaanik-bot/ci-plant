# Daily Production Runs, Order Fulfilment & Warehouse Manual Stock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any station record output day-by-day instead of in one shot, prompt the operator at pasting to confirm order fulfilment, attribute wastage to upstream operators, and give the warehouse a manual add-stock path for FG and leftover.

**Architecture:** One new child table `stage_runs` becomes the authoritative record of production for *every* stage — a single-shot completion simply writes one run. `job_stages.qty_out` / `qty_scrap` survive as a cached rollup, so every downstream reader is untouched. All decision logic lands in one new pure module, `server/src/stage-runs.js`, tested with `node --test`; the routes stay thin.

**Tech Stack:** Node 20 ESM, Express 4, node-postgres (`tx(qc, oc)` helper), `node:test` + `node:assert/strict`, React 18 + Vite + Tailwind, shared UI kit `client/src/components/ui.jsx`.

**Repo root:** `/Users/anikdua/Documents/Projects/Colour Imp Production/Colour Imp Production/ci-erp`

---

## Project conventions that override the generic skill defaults

- **No git commits.** Anik's standing rule for ci-erp: all work stays local, nothing is committed. Every task therefore ends with a **verification** step, not a commit.
- **Server may not hot-reload.** The running instance can be plain `node`. Verify server changes by booting a temp server on a spare port reusing live PG `:5439` — do not assume `--watch` picked the change up.
- **`psql` is NOT installed** and embedded-postgres ships no client binary. Every step below that shows a `psql …` command must instead be run with the dev helper `server/dev-q.mjs`:

  ```bash
  cd server && node dev-q.mjs "SELECT 1"
  ```

  Ignore the `psql 'postgres://cierp:cierp@…'` connection strings written in the tasks below — those credentials are wrong. The real embedded DB is `postgresql://postgres:postgres@localhost:5439/cierp`, which `dev-q.mjs` already defaults to. To boot a temp server against it:

  ```bash
  cd server && DATABASE_URL='postgresql://postgres:postgres@localhost:5439/cierp' PORT=4111 node src/index.js
  ```

- **Baseline before any change:** `cd server && npm test` → **99 passing, 0 failing**. Any task that ends with fewer than 99 pre-existing tests passing has caused a regression.
- **The DB is nearly empty** (post pre-delivery wipe): 18 `job_stages`, 9 completed with `qty_out`, 5 `order_lines`. The Task 2 backfill should therefore create **exactly 9** runs. End-to-end tasks need to seed their own `UAT-*` data rather than assuming a rich dataset exists.
- **UI verified in the real app.** Log in at the desktop breakpoint against the running app. Never a mock, never a static screenshot of hand-written HTML.
- **Cleanup is scoped.** Test data uses `UAT-*` markers and is deleted by that marker only. Never an unscoped `DELETE` on the shared `:5439` database.

## File structure

| File | Responsibility |
|---|---|
| `server/src/stage-runs.js` | **Create.** Pure decision logic: rollup, capacity ceiling, fulfilment suggestion. No DB, no Express. |
| `server/src/stage-runs.test.js` | **Create.** `node --test` coverage of the above. |
| `server/src/db.js` | **Modify.** Append a dated migration block: `stage_runs` table, widened status CHECK, `order_lines` columns, idempotent backfill. |
| `server/src/helpers.js` | **Modify.** Add `recalcStageFromRuns()` and `upstreamAvailable()` — the two DB-touching helpers. |
| `server/src/routes/production.js` | **Modify.** Run CRUD routes; rewire `complete`; cumulative sort-paste reconciliation; fulfilment 409. |
| `server/src/routes/floor.js` | **Modify.** `STAGE_VIEW` gains `printing_operator` / `die_operator`. |
| `server/src/routes/fg.js` | **Modify.** `POST /fg-lots/manual`. |
| `server/src/routes/inventory.js` | **Modify.** `POST /inventory/leftovers/add`. |
| `client/src/components/RunLog.jsx` | **Create.** Shared run-log table + "Record today's output" form. Used by both stations. |
| `client/src/components/FulfilmentDialog.jsx` | **Create.** The `ORDER_QTY_REACHED` modal. |
| `client/src/pages/Section.jsx` | **Modify.** Mount `RunLog`; reveal upstream operators on wastage. |
| `client/src/pages/SortPaste.jsx` | **Modify.** Same, plus the fulfilment dialog. |
| `client/src/pages/Inventory.jsx` | **Modify.** Add-stock button on the Leftover sub-tab. |
| `client/src/pages/FinishedGoods.jsx` | **Modify.** Add-stock button on the Lots tab. |

`RunLog.jsx` and `FulfilmentDialog.jsx` are separate files deliberately: both stations need them, and `Section.jsx` (68 KB) and `SortPaste.jsx` (45 KB) are already at the size where adding another inline panel hurts.

---

# Phase 1 — `stage_runs` core

The load-bearing phase. Nothing else works without it.

### Task 1: Pure rollup and capacity logic

**Files:**
- Create: `server/src/stage-runs.js`
- Test: `server/src/stage-runs.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/src/stage-runs.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollupRuns, runCapacity } from './stage-runs.js';

test('rollupRuns sums good and scrap across days', () => {
  const r = rollupRuns([
    { qty_good: 100000, qty_scrap: 500, run_date: '2026-07-14' },
    { qty_good: 100000, qty_scrap: 300, run_date: '2026-07-15' },
  ]);
  assert.equal(r.qty_good, 200000);
  assert.equal(r.qty_scrap, 800);
  assert.equal(r.run_count, 2);
  assert.equal(r.last_run_date, '2026-07-15');
});

test('rollupRuns on an empty log is all zeroes, not NaN', () => {
  const r = rollupRuns([]);
  assert.equal(r.qty_good, 0);
  assert.equal(r.qty_scrap, 0);
  assert.equal(r.run_count, 0);
  assert.equal(r.last_run_date, null);
});

test('rollupRuns ignores null/undefined quantities', () => {
  const r = rollupRuns([{ qty_good: null, qty_scrap: undefined, run_date: '2026-07-14' }]);
  assert.equal(r.qty_good, 0);
  assert.equal(r.qty_scrap, 0);
});

test('rollupRuns picks the latest date even when runs arrive out of order', () => {
  const r = rollupRuns([
    { qty_good: 10, qty_scrap: 0, run_date: '2026-07-16' },
    { qty_good: 10, qty_scrap: 0, run_date: '2026-07-14' },
  ]);
  assert.equal(r.last_run_date, '2026-07-16');
});

test('runCapacity allows a run that fits under the upstream ceiling', () => {
  const c = runCapacity({ upstreamAvailable: 500000, priorGood: 200000, priorScrap: 800, thisGood: 100000, thisScrap: 200 });
  assert.equal(c.consumed, 301000);
  assert.equal(c.ceiling, 500000);
  assert.equal(c.ok, true);
  assert.equal(c.overBy, 0);
});

test('runCapacity rejects a run that exceeds what upstream has produced', () => {
  const c = runCapacity({ upstreamAvailable: 250000, priorGood: 200000, priorScrap: 0, thisGood: 100000, thisScrap: 0 });
  assert.equal(c.ok, false);
  assert.equal(c.overBy, 50000);
});

test('runCapacity treats a null ceiling as uncapped (cutting)', () => {
  const c = runCapacity({ upstreamAvailable: null, priorGood: 0, priorScrap: 0, thisGood: 999999, thisScrap: 0 });
  assert.equal(c.ok, true);
  assert.equal(c.ceiling, Infinity);
});

test('runCapacity counts scrap against the ceiling, not just good output', () => {
  const c = runCapacity({ upstreamAvailable: 1000, priorGood: 0, priorScrap: 0, thisGood: 900, thisScrap: 200 });
  assert.equal(c.consumed, 1100);
  assert.equal(c.ok, false);
  assert.equal(c.overBy, 100);
});

test('runCapacity exactly at the ceiling is allowed', () => {
  const c = runCapacity({ upstreamAvailable: 1000, priorGood: 800, priorScrap: 100, thisGood: 100, thisScrap: 0 });
  assert.equal(c.ok, true);
  assert.equal(c.overBy, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && node --test src/stage-runs.test.js`
Expected: FAIL — `Cannot find module './stage-runs.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/stage-runs.js`:

```js
// Pure decision logic for the day-wise production run log. No DB, no Express —
// mirrors production-variance.js / tolerance-cascade.js so it stays unit-testable.

const n = v => Math.max(0, Math.round(+v || 0));

// Sum a stage's run log into the cached rollup that lives on job_stages.
export function rollupRuns(runs = []) {
  let qty_good = 0, qty_scrap = 0, last_run_date = null;
  for (const r of runs) {
    qty_good += n(r.qty_good);
    qty_scrap += n(r.qty_scrap);
    const d = r.run_date ? String(r.run_date).slice(0, 10) : null;
    if (d && (!last_run_date || d > last_run_date)) last_run_date = d;
  }
  return { qty_good, qty_scrap, run_count: runs.length, last_run_date };
}

// Once every stage produces daily, a stage's input is no longer fixed at start —
// it is whatever the previous stage has cumulatively produced so far. A null
// ceiling means uncapped (cutting, which has its own variance flow).
export function runCapacity({ upstreamAvailable, priorGood, priorScrap, thisGood, thisScrap }) {
  const ceiling = upstreamAvailable === null || upstreamAvailable === undefined
    ? Infinity : n(upstreamAvailable);
  const consumed = n(priorGood) + n(priorScrap) + n(thisGood) + n(thisScrap);
  return { consumed, ceiling, ok: consumed <= ceiling, overBy: Math.max(0, consumed - ceiling) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && node --test src/stage-runs.test.js`
Expected: PASS — 9 tests, 0 failures

- [ ] **Step 5: Verify the whole suite still passes**

Run: `cd server && npm test`
Expected: all existing test files still pass; no regressions.

---

### Task 2: Schema migration

**Files:**
- Modify: `server/src/db.js` (append to the end of the migration SQL, before the closing `` `); `` at the file's last line)

- [ ] **Step 1: Append the migration block**

Follow the existing dated-section style. Append immediately after the Phase 2 FG-lots block at the end of `db.js`:

```sql
-- ── 2026-07-20: day-wise production runs ──────────────────────────────────
-- Every stage becomes a run log. A single-shot completion writes exactly one
-- run; a five-day pasting job writes five. job_stages.qty_out / qty_scrap stay
-- put as a cached rollup so every downstream reader is unaffected.
CREATE TABLE IF NOT EXISTS stage_runs (
  id            SERIAL PRIMARY KEY,
  job_stage_id  INTEGER NOT NULL REFERENCES job_stages(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  run_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  shift         TEXT,
  qty_good      INTEGER NOT NULL DEFAULT 0,
  qty_scrap     INTEGER NOT NULL DEFAULT 0,
  scrap_reason  TEXT,
  machine_id    INTEGER REFERENCES machines(id),
  operator      TEXT,
  up_printing_operator TEXT,
  up_die_operator      TEXT,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_runs_stage ON stage_runs(job_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_runs_date  ON stage_runs(run_date);

-- A stage that has output but is not finished sits between in_progress and
-- completed. Downstream stages read qty_out, which is already correct for it.
ALTER TABLE job_stages DROP CONSTRAINT IF EXISTS job_stages_status_check;
ALTER TABLE job_stages ADD CONSTRAINT job_stages_status_check
  CHECK (status IN ('pending','in_progress','partially_completed','hold','completed'));

-- Operator's fulfilment decision at the last carton stage.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS production_fulfilled_at TIMESTAMPTZ;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS production_fulfilled_by TEXT;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS short_close_reason TEXT;

-- Backfill: every already-completed stage becomes a one-run log, so the rollup
-- is consistent from day one and history is queryable in the same shape.
INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                        scrap_reason, machine_id, operator, note, created_by)
SELECT js.id, 1, COALESCE(js.completed_at::date, CURRENT_DATE),
       COALESCE(js.qty_out, 0), COALESCE(js.qty_scrap, 0),
       js.scrap_reason, js.machine_id, js.operator, 'backfill', 'migration'
FROM job_stages js
WHERE js.status = 'completed' AND js.qty_out IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM stage_runs sr WHERE sr.job_stage_id = js.id);
```

- [ ] **Step 2: Boot a temp server to run the migration**

Run from the repo root:

```bash
cd server && DATABASE_URL='postgres://cierp:cierp@localhost:5439/cierp' PORT=4111 node src/index.js
```

Expected: server starts clean, no SQL error. Kill it once it reports listening.

- [ ] **Step 3: Verify the table and backfill**

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c "\d stage_runs" \
  -c "SELECT count(*) AS backfilled FROM stage_runs WHERE note='backfill';" \
  -c "SELECT count(*) AS completed_stages FROM job_stages WHERE status='completed' AND qty_out IS NOT NULL;"
```

Expected: the table exists with all 14 columns, and `backfilled` equals `completed_stages` exactly.

- [ ] **Step 4: Verify idempotency**

Boot the temp server a second time with the same command, then re-run the count query.
Expected: `backfilled` is unchanged — the `NOT EXISTS` guard held, no duplicate runs.

---

### Task 3: DB helpers

**Files:**
- Modify: `server/src/helpers.js` (append near the other stage helpers)

- [ ] **Step 1: Add both helpers**

```js
import { rollupRuns } from './stage-runs.js';

// Re-derive job_stages.qty_out / qty_scrap from the run log. Called after every
// run insert, edit or delete. A stage with no runs is left alone — that is a
// stage that has not produced yet, not a stage that produced zero.
export async function recalcStageFromRuns(qc, oc, stageId) {
  const runs = await qc(
    'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1 ORDER BY run_date, seq',
    [stageId]
  );
  if (!runs.length) return null;
  const roll = rollupRuns(runs);
  await oc('UPDATE job_stages SET qty_out=$1, qty_scrap=$2 WHERE id=$3',
    [roll.qty_good, roll.qty_scrap, stageId]);
  return roll;
}

// The running-balance ceiling: what the previous stage has cumulatively produced.
// First stage of a job card falls back to its own qty_in; cutting is uncapped
// (null) because it keeps its existing over/under-cut variance flow.
export async function upstreamAvailable(oc, stageId) {
  const st = await oc('SELECT id, job_card_id, seq, stage, qty_in FROM job_stages WHERE id=$1', [stageId]);
  if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
  if (st.stage === 'cutting') return null;
  const prev = await oc(
    `SELECT qty_out FROM job_stages
      WHERE job_card_id=$1 AND seq < $2 AND stage <> 'qc'
      ORDER BY seq DESC LIMIT 1`,
    [st.job_card_id, st.seq]
  );
  if (!prev) return st.qty_in === null || st.qty_in === undefined ? null : +st.qty_in;
  return prev.qty_out === null || prev.qty_out === undefined ? 0 : +prev.qty_out;
}
```

- [ ] **Step 2: Verify it imports cleanly**

Run: `cd server && node -e "import('./src/helpers.js').then(m => console.log(typeof m.recalcStageFromRuns, typeof m.upstreamAvailable))"`
Expected: `function function`

---

### Task 4: Run CRUD routes

**Files:**
- Modify: `server/src/routes/production.js`

- [ ] **Step 1: Add the four routes**

Import at the top of the file alongside the existing imports:

```js
import { rollupRuns, runCapacity } from '../stage-runs.js';
import { recalcStageFromRuns, upstreamAvailable } from '../helpers.js';
```

Add the routes near the other `/job-stages/:id/*` handlers, matching the house `tx(qc, oc)` + `next(e)` style:

```js
// ── Day-wise production runs ───────────────────────────────────────────────
r.get('/job-stages/:id/runs', async (req, res, next) => {
  try {
    const runs = await q(
      `SELECT sr.*, m.name AS machine_name
         FROM stage_runs sr LEFT JOIN machines m ON m.id = sr.machine_id
        WHERE sr.job_stage_id = $1 ORDER BY sr.run_date, sr.seq`, [req.params.id]);
    res.json({ runs, rollup: rollupRuns(runs) });
  } catch (e) { next(e); }
});

r.post('/job-stages/:id/runs', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('This stage is already completed — reverse it to record more output'), { status: 409 });
      if (st.status === 'pending')
        throw Object.assign(new Error('Start the stage before recording output'), { status: 409 });

      const qty_good = Math.max(0, Math.round(+req.body.qty_good || 0));
      const qty_scrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
      if (qty_good + qty_scrap <= 0)
        throw Object.assign(new Error('A run must record some output or scrap'), { status: 400 });
      if (qty_scrap > 0 && !(req.body.scrap_reason || '').trim())
        throw Object.assign(new Error('A reason is required when scrap is recorded'), { status: 400 });

      const prior = rollupRuns(await qc(
        'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [st.id]));
      const cap = runCapacity({
        upstreamAvailable: await upstreamAvailable(oc, st.id),
        priorGood: prior.qty_good, priorScrap: prior.qty_scrap,
        thisGood: qty_good, thisScrap: qty_scrap,
      });
      if (!cap.ok)
        throw Object.assign(
          new Error(`Output + scrap (${cap.consumed}) exceeds what the previous stage has produced (${cap.ceiling}) by ${cap.overBy}`),
          { status: 409 });

      const seq = (prior.run_count || 0) + 1;
      const run = await oc(
        `INSERT INTO stage_runs (job_stage_id, seq, run_date, shift, qty_good, qty_scrap,
                                 scrap_reason, machine_id, operator, note, created_by)
         VALUES ($1,$2,COALESCE($3::date, CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [st.id, seq, req.body.run_date || null, req.body.shift || null, qty_good, qty_scrap,
         qty_scrap > 0 ? req.body.scrap_reason : null,
         req.body.machine_id ? +req.body.machine_id : st.machine_id,
         req.body.operator || st.operator || req.user?.name || null,
         req.body.note || null, req.user?.name || null]);

      const rollup = await recalcStageFromRuns(qc, oc, st.id);
      if (st.status === 'in_progress')
        await oc(`UPDATE job_stages SET status='partially_completed' WHERE id=$1`, [st.id]);
      return { run, rollup };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.put('/job-stages/:id/runs/:runId', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('Reverse the stage before editing its runs'), { status: 409 });
      const qty_good = Math.max(0, Math.round(+req.body.qty_good || 0));
      const qty_scrap = Math.max(0, Math.round(+req.body.qty_scrap || 0));
      if (qty_scrap > 0 && !(req.body.scrap_reason || '').trim())
        throw Object.assign(new Error('A reason is required when scrap is recorded'), { status: 400 });
      await oc(
        `UPDATE stage_runs SET qty_good=$1, qty_scrap=$2, scrap_reason=$3, run_date=COALESCE($4::date, run_date),
                shift=$5, machine_id=$6, operator=$7, note=$8
          WHERE id=$9 AND job_stage_id=$10`,
        [qty_good, qty_scrap, qty_scrap > 0 ? req.body.scrap_reason : null,
         req.body.run_date || null, req.body.shift || null,
         req.body.machine_id ? +req.body.machine_id : null,
         req.body.operator || null, req.body.note || null,
         req.params.runId, st.id]);
      return { rollup: await recalcStageFromRuns(qc, oc, st.id) };
    });
    res.json(out);
  } catch (e) { next(e); }
});

r.delete('/job-stages/:id/runs/:runId', canRun, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const st = await oc('SELECT * FROM job_stages WHERE id=$1', [req.params.id]);
      if (!st) throw Object.assign(new Error('Stage not found'), { status: 404 });
      if (st.status === 'completed')
        throw Object.assign(new Error('Reverse the stage before deleting its runs'), { status: 409 });
      await oc('DELETE FROM stage_runs WHERE id=$1 AND job_stage_id=$2', [req.params.runId, st.id]);
      const rollup = await recalcStageFromRuns(qc, oc, st.id);
      if (!rollup) await oc(`UPDATE job_stages SET status='in_progress', qty_out=NULL, qty_scrap=0 WHERE id=$1`, [st.id]);
      return { rollup };
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

Note: `q`, `tx` and `canRun` are already imported at the top of `production.js` — do not re-import them.

- [ ] **Step 2: Verify against a real job card**

Boot the temp server on `:4111` as in Task 2. Pick a started, incomplete stage:

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT id, job_card_id, stage, status, qty_in FROM job_stages WHERE status='in_progress' LIMIT 3;"
```

POST two runs against it with `curl` (auth token from a login call), then:

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT sr.seq, sr.run_date, sr.qty_good, sr.qty_scrap, js.qty_out, js.qty_scrap, js.status
     FROM stage_runs sr JOIN job_stages js ON js.id=sr.job_stage_id WHERE sr.job_stage_id=<ID> ORDER BY sr.seq;"
```

Expected: two run rows; `js.qty_out` equals the sum of `qty_good`; `js.status` is `partially_completed`.

- [ ] **Step 3: Verify the ceiling actually bites**

POST a third run whose qty exceeds the previous stage's `qty_out`.
Expected: HTTP 409, message naming the overage amount. No run row inserted.

- [ ] **Step 4: Clean up**

Delete only the runs created above, by id. Reset the stage: `UPDATE job_stages SET status='in_progress', qty_out=NULL, qty_scrap=0 WHERE id=<ID>;`

---

### Task 5: Rewire `complete` onto the run log

**Files:**
- Modify: `server/src/routes/production.js:716-965` (`POST /job-stages/:id/complete`)

- [ ] **Step 1: Replace the fixed-cap guard**

At `production.js:775-782`, the `else` branch currently reads:

```js
      } else {
        const cap = stQtyIn;
        const consumed = isQC ? (qty_accepted + qty_rejected + qty_rework) : (qty_out + qty_scrap);
        if (consumed > cap)
          throw Object.assign(new Error(`${isQC ? 'Accepted + rejected + rework' : 'Output + scrap'} (${consumed}) exceeds input (${cap})`), { status: 409 });
      }
```

Replace with:

```js
      } else if (isQC) {
        const consumed = qty_accepted + qty_rejected + qty_rework;
        if (consumed > stQtyIn)
          throw Object.assign(new Error(`Accepted + rejected + rework (${consumed}) exceeds input (${stQtyIn})`), { status: 409 });
      } else {
        // Running balance: a stage can only consume what the previous stage has
        // cumulatively produced. Runs already booked are excluded — the caller is
        // closing out, so qty_out/qty_scrap here are the FINAL totals, not a delta.
        const cap = runCapacity({
          upstreamAvailable: await upstreamAvailable(oc, st.id),
          priorGood: 0, priorScrap: 0, thisGood: qty_out, thisScrap: qty_scrap,
        });
        if (!cap.ok)
          throw Object.assign(new Error(`Output + scrap (${cap.consumed}) exceeds available input (${cap.ceiling})`), { status: 409 });
      }
```

- [ ] **Step 2: Write the closing run**

Immediately before the statement that sets the stage to `completed`, reconcile the run log so a stage closed in one shot still has exactly one run, and a stage closed after partial runs gets a balancing final run:

```js
      // Keep stage_runs authoritative. A one-shot completion writes one run; a
      // stage that already has partial runs gets a balancing run for the remainder.
      if (!isQC) {
        const prior = rollupRuns(await qc(
          'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [st.id]));
        const deltaGood = qty_out - prior.qty_good;
        const deltaScrap = qty_scrap - prior.qty_scrap;
        if (deltaGood !== 0 || deltaScrap !== 0) {
          if (deltaGood < 0 || deltaScrap < 0)
            throw Object.assign(new Error(
              `Closing totals (${qty_out} good / ${qty_scrap} scrap) are below what the run log already records (${prior.qty_good} / ${prior.qty_scrap}). Edit or delete a run instead.`
            ), { status: 409 });
          await oc(
            `INSERT INTO stage_runs (job_stage_id, seq, run_date, qty_good, qty_scrap,
                                     scrap_reason, machine_id, operator, note, created_by)
             VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9)`,
            [st.id, (prior.run_count || 0) + 1, deltaGood, deltaScrap,
             deltaScrap > 0 ? scrap_reason : null, st.machine_id,
             req.body.operator || st.operator || req.user?.name || null,
             prior.run_count ? 'closing balance' : null, req.user?.name || null]);
        }
      }
```

- [ ] **Step 3: Cascade-delete check on reverse**

`stage_runs` has `ON DELETE CASCADE` on `job_stage_id`, but `reverse` resets a stage rather than deleting it. In `POST /job-stages/:id/reverse` (`production.js:1300`) and `POST /sort-paste/:jobCardId/reverse` (`production.js:1132-1200`), add alongside the existing child-row cleanup:

```js
      await oc('DELETE FROM stage_runs WHERE job_stage_id = $1', [stageId]);
```

In the sort-paste reverse, do this for **both** the sorting and pasting stage ids, next to the existing `pasting_rows` / `packing_lines` deletes.

- [ ] **Step 4: Verify one-shot completion still writes exactly one run**

On the temp server, complete a fresh stage the normal way (no partial runs).

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT count(*) AS runs, sum(qty_good) AS good FROM stage_runs WHERE job_stage_id=<ID>;"
```

Expected: `runs = 1`, `good` equals the `qty_out` submitted.

- [ ] **Step 5: Verify partial-then-close**

On another stage: POST two runs of 100 each, then `complete` with `qty_out = 250`.
Expected: three runs (100, 100, 50), the third noted `closing balance`; `js.qty_out = 250`.

- [ ] **Step 6: Verify the downward guard**

On another stage: POST a run of 100, then `complete` with `qty_out = 60`.
Expected: HTTP 409 naming the run-log totals. Stage stays `partially_completed`.

- [ ] **Step 7: Verify reverse clears the log**

Reverse a completed stage, then `SELECT count(*) FROM stage_runs WHERE job_stage_id=<ID>;`
Expected: `0`.

- [ ] **Step 8: Regression check**

Run: `cd server && npm test`
Expected: all existing tests pass — in particular `production-variance.test.js` and `production.finalise.test.js`.

---

### Task 6: Cumulative sort-paste reconciliation

**Files:**
- Modify: `server/src/routes/production.js:1001-1128` (`POST /sort-paste/:jobCardId/complete`)

- [ ] **Step 1: Relax the exact-match check**

At `production.js:1054-1056` the check currently demands the pasting rows cover the sorted-good pool exactly:

```js
      if (totalInput !== sortedGood)
        throw Object.assign(new Error(`Pasting rows cover ${totalInput} pieces — must equal the ${sortedGood} sorted-good pieces`), { status: 409 });
```

Replace with a cumulative ceiling, so a partial day is legal but over-pasting is still blocked:

```js
      // Pasting may run over several days against the same sorted pool. Rows must
      // fit inside what sorting has produced, counting anything already pasted.
      const pastedAlready = rollupRuns(await qc(
        'SELECT qty_good, qty_scrap, run_date FROM stage_runs WHERE job_stage_id=$1', [pasteStage.id]));
      const pastedCum = pastedAlready.qty_good + pastedAlready.qty_scrap;
      if (totalInput + pastedCum > sortedGood)
        throw Object.assign(new Error(
          `Pasting rows cover ${totalInput} pieces; with ${pastedCum} already pasted that exceeds the ${sortedGood} sorted-good pieces`
        ), { status: 409 });
      const isFinalPaste = totalInput + pastedCum === sortedGood;
```

- [ ] **Step 2: Only complete the stage when the pool is exhausted**

Where the handler currently sets the pasting stage to `completed`, gate it on `isFinalPaste`:

```js
      await oc(`UPDATE job_stages SET status=$1, qty_out=$2, qty_scrap=$3,
                       completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END
                 WHERE id=$4`,
        [isFinalPaste ? 'completed' : 'partially_completed',
         pastedAlready.qty_good + pastedGood, pastedAlready.qty_scrap + pasteWaste, pasteStage.id]);
```

Leave the **sorting** stage completing unconditionally as it does today — sorting still gates the batch up front, which is the invariant this design deliberately preserves.

- [ ] **Step 3: Verify a two-day paste**

Seed a `UAT-PASTE2` order, carry it to pasting with 1000 sorted-good. Submit pasting rows totalling 400.
Expected: HTTP 200; pasting stage `partially_completed`, `qty_out = 400`.

Submit a second batch of 600.
Expected: HTTP 200; stage `completed`, `qty_out = 1000`, `completed_at` set.

- [ ] **Step 4: Verify over-paste is still blocked**

On a fresh `UAT-PASTE3` job with 1000 sorted-good, submit 400 then 700.
Expected: second call 409 naming 400 already pasted. `qty_out` stays 400.

- [ ] **Step 5: Clean up**

Delete the `UAT-PASTE2` and `UAT-PASTE3` orders by their `UAT-*` marker only.

---

### Task 7: Client run-log panel

**Files:**
- Create: `client/src/components/RunLog.jsx`
- Modify: `client/src/pages/Section.jsx`, `client/src/pages/SortPaste.jsx`

- [ ] **Step 1: Build the shared component**

Create `client/src/components/RunLog.jsx`, using the existing kit (`Modal`, `Field`, `Input`, `Select`, `Button`, `useToast` from `./ui.jsx`; `api` from `../api.js`):

```jsx
import { useEffect, useState } from 'react';
import { Button, Field, Input, Select, Textarea, useToast } from './ui.jsx';
import { api } from '../api.js';

// Day-wise output for one stage. Mounted by both Section and SortPaste so the
// two 45-68 KB station pages don't each grow another panel.
export default function RunLog({ stageId, machines = [], operators = [], scrapReasons = [], onChanged }) {
  const [runs, setRuns] = useState([]);
  const [rollup, setRollup] = useState({ qty_good: 0, qty_scrap: 0, run_count: 0 });
  const [form, setForm] = useState({ run_date: new Date().toISOString().slice(0, 10), qty_good: '', qty_scrap: '0', scrap_reason: '', operator: '', note: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    const d = await api.get(`/job-stages/${stageId}/runs`);
    setRuns(d.runs || []); setRollup(d.rollup || { qty_good: 0, qty_scrap: 0, run_count: 0 });
  };
  useEffect(() => { if (stageId) load(); }, [stageId]);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/job-stages/${stageId}/runs`, {
        ...form,
        qty_good: +form.qty_good || 0,
        qty_scrap: +form.qty_scrap || 0,
      });
      setForm(f => ({ ...f, qty_good: '', qty_scrap: '0', scrap_reason: '', note: '' }));
      await load(); onChanged?.();
      toast('Run recorded');
    } finally { setBusy(false); }
  };

  const remove = async (id) => {
    await api.del(`/job-stages/${stageId}/runs/${id}`);
    await load(); onChanged?.();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="font-semibold">Recorded so far</span>
        <span className="tabular-nums">{rollup.qty_good.toLocaleString('en-IN')} good</span>
        <span className="tabular-nums text-amber-600">{rollup.qty_scrap.toLocaleString('en-IN')} waste</span>
        <span className="text-slate-500">{rollup.run_count} run{rollup.run_count === 1 ? '' : 's'}</span>
      </div>

      {runs.length > 0 && (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500">
            <th>Date</th><th>Good</th><th>Waste</th><th>Reason</th><th>Operator</th><th></th>
          </tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id} className="border-t border-slate-200/60">
                <td>{String(r.run_date).slice(0, 10)}</td>
                <td className="tabular-nums">{r.qty_good.toLocaleString('en-IN')}</td>
                <td className="tabular-nums">{r.qty_scrap ? r.qty_scrap.toLocaleString('en-IN') : '—'}</td>
                <td>{r.scrap_reason || '—'}</td>
                <td>{r.operator || '—'}</td>
                <td><button className="text-rose-600" onClick={() => remove(r.id)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" value={form.run_date} onChange={e => setForm({ ...form, run_date: e.target.value })} /></Field>
        <Field label="Operator">
          <Select value={form.operator} onChange={e => setForm({ ...form, operator: e.target.value })}>
            <option value="">—</option>
            {operators.map(o => <option key={o.id ?? o.name} value={o.name}>{o.name}</option>)}
          </Select>
        </Field>
        <Field label="Good produced" required><Input type="number" min="0" value={form.qty_good} onChange={e => setForm({ ...form, qty_good: e.target.value })} /></Field>
        <Field label="Waste"><Input type="number" min="0" value={form.qty_scrap} onChange={e => setForm({ ...form, qty_scrap: e.target.value })} /></Field>
        {+form.qty_scrap > 0 && (
          <Field label="Waste reason" required>
            <Select value={form.scrap_reason} onChange={e => setForm({ ...form, scrap_reason: e.target.value })}>
              <option value="">Select a reason…</option>
              {scrapReasons.map(x => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Note"><Textarea rows={1} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
      </div>

      <Button onClick={save} disabled={busy || !form.qty_good || (+form.qty_scrap > 0 && !form.scrap_reason)}>
        Record today's output
      </Button>
    </div>
  );
}
```

Confirm `api.del` exists in `client/src/api.js`; if the helper is named differently (e.g. `api.delete`), use that name instead.

- [ ] **Step 2: Mount it in `Section.jsx`**

Import `RunLog` and render it inside the process modal, above the existing completion form, whenever the stage status is `in_progress` or `partially_completed`. Pass `scrapReasons={GENERAL_WASTAGE_REASONS}` (already imported from `../sections.js`) and the machine-driven operator list already computed at `Section.jsx:295-298`. Pass `onChanged={refresh}` so the queue KPIs update.

- [ ] **Step 3: Mount it in `SortPaste.jsx`**

Same, on the pasting stage only, with `scrapReasons={SORTING_REJECTION_REASONS}`.

- [ ] **Step 4: Show partial state in both queues**

Wherever the status badge is rendered, add the `partially_completed` case — label "Partial", amber. In `Section.jsx` the badge map is near the queue table; in `SortPaste.jsx` near `SortPaste.jsx:360`.

- [ ] **Step 5: Verify in the real app**

Start the app (`npm run dev` from the repo root), log in, open a station with an in-progress job at the desktop breakpoint. Record two runs on different dates.
Expected: both rows appear in the table, the rollup line sums them, the queue badge reads "Partial", and the recorded totals survive a page refresh.

- [ ] **Step 6: Verify the ceiling error surfaces**

Record a run larger than the upstream stage produced.
Expected: the 409 message appears as a toast naming the overage. No row added.

---

# Phase 2 — Fulfilment popup

Depends on Phase 1.

### Task 8: Fulfilment decision logic

**Files:**
- Modify: `server/src/stage-runs.js`, `server/src/stage-runs.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/src/stage-runs.test.js`:

```js
import { fulfilmentCheck } from './stage-runs.js';

test('fulfilmentCheck suggests fulfilled once cumulative good reaches the order', () => {
  const f = fulfilmentCheck({ orderedQty: 500000, tolerancePct: 5, producedGoodCum: 500000, unit: 'cartons', isLastProductionStage: true });
  assert.equal(f.applicable, true);
  assert.equal(f.reached, true);
  assert.equal(f.suggestion, 'fulfilled');
  assert.equal(f.balance, 0);
  assert.equal(f.allowedMax, 525000);
});

test('fulfilmentCheck suggests pending while short, and reports the balance', () => {
  const f = fulfilmentCheck({ orderedQty: 500000, tolerancePct: 5, producedGoodCum: 100000, unit: 'cartons', isLastProductionStage: true });
  assert.equal(f.reached, false);
  assert.equal(f.suggestion, 'pending');
  assert.equal(f.balance, 400000);
});

test('fulfilmentCheck does not apply to sheet-unit stages', () => {
  // Printing produces sheets; comparing sheets to an order in pieces is meaningless.
  const f = fulfilmentCheck({ orderedQty: 500000, tolerancePct: 5, producedGoodCum: 900000, unit: 'sheets', isLastProductionStage: true });
  assert.equal(f.applicable, false);
});

test('fulfilmentCheck does not apply to a mid-route stage', () => {
  const f = fulfilmentCheck({ orderedQty: 500000, tolerancePct: 0, producedGoodCum: 500000, unit: 'cartons', isLastProductionStage: false });
  assert.equal(f.applicable, false);
});

test('fulfilmentCheck does not apply when the order qty is unknown', () => {
  const f = fulfilmentCheck({ orderedQty: 0, tolerancePct: 0, producedGoodCum: 100, unit: 'cartons', isLastProductionStage: true });
  assert.equal(f.applicable, false);
});

test('fulfilmentCheck with zero tolerance caps allowedMax at the ordered qty', () => {
  const f = fulfilmentCheck({ orderedQty: 1000, tolerancePct: 0, producedGoodCum: 1000, unit: 'cartons', isLastProductionStage: true });
  assert.equal(f.allowedMax, 1000);
});

test('fulfilmentCheck floors a fractional tolerance ceiling', () => {
  const f = fulfilmentCheck({ orderedQty: 1005, tolerancePct: 3, producedGoodCum: 0, unit: 'cartons', isLastProductionStage: true });
  assert.equal(f.allowedMax, 1035); // floor(1005 * 1.03) = floor(1035.15)
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && node --test src/stage-runs.test.js`
Expected: FAIL — `fulfilmentCheck is not a function`

- [ ] **Step 3: Implement**

Append to `server/src/stage-runs.js`:

```js
// Does this run close the order? Only meaningful at the last carton-unit stage —
// a printing run is counted in sheets and cannot be compared to an order in pieces.
export function fulfilmentCheck({ orderedQty, tolerancePct, producedGoodCum, unit, isLastProductionStage }) {
  const ordered = n(orderedQty);
  const applicable = unit === 'cartons' && !!isLastProductionStage && ordered > 0;
  const good = n(producedGoodCum);
  const reached = applicable && good >= ordered;
  return {
    applicable,
    reached,
    suggestion: reached ? 'fulfilled' : 'pending',
    allowedMax: Math.floor(ordered * (1 + n(tolerancePct) / 100)),
    balance: Math.max(0, ordered - good),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && node --test src/stage-runs.test.js`
Expected: PASS — 16 tests total, 0 failures

---

### Task 9: Raise `ORDER_QTY_REACHED` and resolve the decision

**Files:**
- Modify: `server/src/routes/production.js` (`POST /job-stages/:id/runs` from Task 4)

- [ ] **Step 1: Add the fulfilment branch**

Inside `POST /job-stages/:id/runs`, after `recalcStageFromRuns` and before returning, add:

```js
      // Is this the last non-QC stage, and does it count in cartons?
      const lastProd = await oc(
        `SELECT id FROM job_stages WHERE job_card_id=$1 AND stage <> 'qc' ORDER BY seq DESC LIMIT 1`,
        [st.job_card_id]);
      const line = await oc(
        `SELECT ol.id, ol.qty, ol.tolerance_pct, o.order_no, c.name AS customer, c.tolerance_pct AS cust_tol,
                p.name AS product, p.artwork_code
           FROM job_cards jc
           JOIN order_lines ol ON ol.id = jc.order_line_id
           JOIN orders o ON o.id = ol.order_id
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN products p ON p.id = ol.product_id
          WHERE jc.id = $1`, [st.job_card_id]);

      const fc = fulfilmentCheck({
        orderedQty: line?.qty,
        tolerancePct: line?.tolerance_pct ?? line?.cust_tol ?? 0,
        producedGoodCum: rollup.qty_good,
        unit: st.unit,
        isLastProductionStage: lastProd?.id === st.id,
      });

      const decision = req.body.fulfilment;
      if (fc.applicable && fc.reached && !decision) {
        const waste = await qc(
          `SELECT js.stage, SUM(sr.qty_scrap)::int AS qty_scrap,
                  MIN(sr.scrap_reason) AS reason, MIN(sr.operator) AS operator
             FROM job_stages js JOIN stage_runs sr ON sr.job_stage_id = js.id
            WHERE js.job_card_id = $1 AND sr.qty_scrap > 0
            GROUP BY js.stage, js.seq ORDER BY js.seq`, [st.job_card_id]);
        throw Object.assign(new Error('Production has reached the ordered quantity'), {
          status: 409,
          body: {
            code: 'ORDER_QTY_REACHED',
            line: {
              order_no: line.order_no, customer: line.customer, product: line.product,
              artwork: line.artwork_code, ordered_qty: line.qty,
              tolerance_pct: line.tolerance_pct ?? line.cust_tol ?? 0,
              allowed_max: fc.allowedMax, produced_good_cum: rollup.qty_good,
              produced_scrap_cum: rollup.qty_scrap, this_run: qty_good,
              balance: fc.balance, suggestion: fc.suggestion,
            },
            wastage: { total: waste.reduce((s, w) => s + w.qty_scrap, 0), by_stage: waste },
          },
        });
      }

      if (decision === 'fulfilled') {
        if (!fc.reached && !(req.body.short_close_reason || '').trim())
          throw Object.assign(new Error('Closing below the ordered quantity needs a reason'), { status: 400 });
        await oc(`UPDATE order_lines SET production_fulfilled_at=now(), production_fulfilled_by=$1,
                         short_close_reason=$2 WHERE id=$3`,
          [req.user?.name || null, req.body.short_close_reason || null, line.id]);
        await oc(`UPDATE job_stages SET status='completed', completed_at=now() WHERE id=$1`, [st.id]);
      }
```

Add `fulfilmentCheck` to the `stage-runs.js` import added in Task 4.

Note: the run is inserted **before** this throw, but `tx()` rolls the whole transaction back on the throw — so the operator's re-submit with `fulfilment` set inserts the run exactly once. Verify this in Step 3; if `tx()` does not roll back on a thrown error with a `.body`, move the fulfilment check to run *before* the insert instead.

- [ ] **Step 2: Add the wastage summary endpoint**

```js
r.get('/job-cards/:id/wastage-summary', async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT js.stage, js.seq, sr.run_date, sr.qty_scrap, sr.scrap_reason,
              sr.operator, sr.up_printing_operator, sr.up_die_operator
         FROM job_stages js JOIN stage_runs sr ON sr.job_stage_id = js.id
        WHERE js.job_card_id = $1 AND sr.qty_scrap > 0
        ORDER BY js.seq, sr.run_date`, [req.params.id]);
    res.json({ rows, total: rows.reduce((s, x) => s + (x.qty_scrap || 0), 0) });
  } catch (e) { next(e); }
});
```

- [ ] **Step 3: Verify the 409 fires exactly once and rolls back**

On the temp server, drive a `UAT-FULFIL` job to its last carton stage with an order qty of 1000. POST a run of 1000 with no `fulfilment` field.
Expected: HTTP 409, `code: 'ORDER_QTY_REACHED'`, `suggestion: 'fulfilled'`.

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT count(*) FROM stage_runs WHERE job_stage_id=<ID>;"
```

Expected: the run was **not** persisted — the transaction rolled back. If it was persisted, apply the fallback noted in Step 1.

- [ ] **Step 4: Verify each decision**

Re-POST with `fulfilment: 'pending'` → 200, stage `partially_completed`, one run stored.
Reverse and re-POST with `fulfilment: 'fulfilled'` → 200, stage `completed`, `order_lines.production_fulfilled_at` set.

- [ ] **Step 5: Verify short-close**

On a fresh `UAT-SHORT` job, POST `fulfilment: 'fulfilled'` while cumulative good is below ordered, with no reason.
Expected: HTTP 400. Re-POST with `short_close_reason` → 200, reason persisted.

- [ ] **Step 6: Verify printing raises nothing**

Record a run at printing (unit `sheets`) exceeding the order qty.
Expected: HTTP 200, no 409 — D5 holding.

- [ ] **Step 7: Clean up** — delete `UAT-FULFIL`, `UAT-SHORT` by marker.

---

### Task 10: The fulfilment dialog

**Files:**
- Create: `client/src/components/FulfilmentDialog.jsx`
- Modify: `client/src/pages/SortPaste.jsx`

- [ ] **Step 1: Build the dialog**

Create `client/src/components/FulfilmentDialog.jsx`. It receives the `e.data` payload and calls back with the decision:

```jsx
import { useState } from 'react';
import { Modal, Button, Field, Textarea } from './ui.jsx';

export default function FulfilmentDialog({ data, onDecide, onClose }) {
  const { line, wastage } = data;
  const [reason, setReason] = useState('');
  const short = line.produced_good_cum < line.ordered_qty;
  const fmt = v => (v ?? 0).toLocaleString('en-IN');

  return (
    <Modal open onClose={onClose} title="Is this order fulfilled?" wide footer={
      <>
        <Button variant="ghost" onClick={() => onDecide('pending')}>Not yet — keep producing</Button>
        <Button onClick={() => onDecide('fulfilled', reason)} disabled={short && !reason.trim()}>
          Mark fulfilled
        </Button>
      </>
    }>
      <div className="space-y-4">
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="font-semibold">{line.order_no} · {line.customer}</div>
          <div className="text-slate-600">{line.product}{line.artwork ? ` · ${line.artwork}` : ''}</div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-slate-500">Ordered</span><div className="text-lg tabular-nums">{fmt(line.ordered_qty)}</div></div>
          <div><span className="text-slate-500">Produced (good)</span><div className="text-lg tabular-nums">{fmt(line.produced_good_cum)}</div></div>
          <div><span className="text-slate-500">This run</span><div className="tabular-nums">{fmt(line.this_run)}</div></div>
          <div><span className="text-slate-500">Balance</span><div className="tabular-nums">{fmt(line.balance)}</div></div>
          <div><span className="text-slate-500">Tolerance ceiling</span><div className="tabular-nums">{fmt(line.allowed_max)} ({line.tolerance_pct}%)</div></div>
          <div><span className="text-slate-500">Total waste</span><div className="tabular-nums text-amber-600">{fmt(wastage.total)}</div></div>
        </div>

        <div className={`rounded-lg p-3 text-sm ${line.suggestion === 'fulfilled' ? 'bg-emerald-50 text-emerald-900' : 'bg-amber-50 text-amber-900'}`}>
          System suggests: <strong>{line.suggestion === 'fulfilled' ? 'Order fulfilled' : 'Still pending'}</strong>
          {line.suggestion === 'pending' && ` — ${fmt(line.balance)} short of the ordered quantity.`}
        </div>

        {wastage.by_stage?.length > 0 && (
          <div>
            <div className="mb-1 text-sm font-semibold">Wastage by stage</div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500"><th>Stage</th><th>Waste</th><th>Reason</th><th>Operator</th></tr></thead>
              <tbody>
                {wastage.by_stage.map((w, i) => (
                  <tr key={i} className="border-t border-slate-200/60">
                    <td className="capitalize">{w.stage.replace('_', ' ')}</td>
                    <td className="tabular-nums">{fmt(w.qty_scrap)}</td>
                    <td>{w.reason || '—'}</td>
                    <td>{w.operator || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {short && (
          <Field label="Reason for closing below the ordered quantity" required>
            <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Wire it into the run save**

In `SortPaste.jsx`, catch the structured 409 exactly as `Section.jsx:305-321` catches `SHADE_CARD_NOT_ELIGIBLE`. The `RunLog` component's `save()` must surface the error rather than swallow it — pass an `onStructuredError` prop through, or lift the catch into the page. Then:

```jsx
const [fulfilAlarm, setFulfilAlarm] = useState(null);   // { data, payload }

// in the catch:
if (e.data?.code === 'ORDER_QTY_REACHED') { setFulfilAlarm({ data: e.data, payload: body }); return; }
throw e;

// decision handler:
const decide = async (fulfilment, short_close_reason) => {
  await api.post(`/job-stages/${stageId}/runs`, { ...fulfilAlarm.payload, fulfilment, short_close_reason });
  setFulfilAlarm(null);
  refresh();
};

// render:
{fulfilAlarm && <FulfilmentDialog data={fulfilAlarm.data} onDecide={decide} onClose={() => setFulfilAlarm(null)} />}
```

- [ ] **Step 3: Verify in the real app**

Drive a `UAT-DLG` order to pasting, record a run that reaches the order qty.
Expected: the dialog opens with the correct order header, ordered vs produced figures, the green "Order fulfilled" suggestion, and the wastage table. No red error toast — `api.js:31` suppresses it because the response carries `code`.

- [ ] **Step 4: Verify both paths**

"Not yet" → dialog closes, run appears in the log, badge stays "Partial".
"Mark fulfilled" → run appears, stage shows completed, downstream QC unlocks.

- [ ] **Step 5: Verify short-close in the UI**

On a job below its order qty, force the dialog by completing; confirm the reason textarea appears and "Mark fulfilled" is disabled until it is filled.

- [ ] **Step 6: Clean up** — delete `UAT-DLG` by marker.

---

# Phase 3 — Upstream operator attribution

Depends on Phase 1.

### Task 11: Expose upstream operators

**Files:**
- Modify: `server/src/routes/floor.js:71-113` (`STAGE_VIEW`)
- Modify: `server/src/routes/production.js` (`POST /job-stages/:id/runs`)

- [ ] **Step 1: Add the lateral joins to `STAGE_VIEW`**

Inside the `STAGE_VIEW` select list, alongside the existing `COALESCE(js.operator, mcrew.name) AS operator`:

```sql
  (SELECT ps.operator FROM job_stages ps
    WHERE ps.job_card_id = js.job_card_id AND ps.stage = 'printing'
    ORDER BY ps.seq LIMIT 1) AS printing_operator,
  (SELECT ds.operator FROM job_stages ds
    WHERE ds.job_card_id = js.job_card_id AND ds.stage = 'die_cutting'
    ORDER BY ds.seq LIMIT 1) AS die_operator,
```

- [ ] **Step 2: Snapshot them onto the run**

In `POST /job-stages/:id/runs`, when `qty_scrap > 0`, resolve and store both names so the record survives a later upstream adjustment. Before the `INSERT`:

```js
      let upPrint = null, upDie = null;
      if (qty_scrap > 0) {
        const up = await oc(
          `SELECT MAX(CASE WHEN stage='printing' THEN operator END) AS printing_operator,
                  MAX(CASE WHEN stage='die_cutting' THEN operator END) AS die_operator
             FROM job_stages WHERE job_card_id=$1`, [st.job_card_id]);
        upPrint = up?.printing_operator || null;
        upDie = up?.die_operator || null;
      }
```

Extend the `INSERT` column list with `up_printing_operator, up_die_operator` and the values with `upPrint, upDie`.

- [ ] **Step 3: Verify**

Record a run with scrap on a job whose printing and die-cutting stages have operators.

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT qty_scrap, up_printing_operator, up_die_operator FROM stage_runs WHERE job_stage_id=<ID>;"
```

Expected: both names populated. Record a run with zero scrap → both `NULL`.

---

### Task 12: Reveal the names on wastage entry

**Files:**
- Modify: `client/src/components/RunLog.jsx`, `client/src/pages/Section.jsx`, `client/src/pages/SortPaste.jsx`

- [ ] **Step 1: Accept and render the names**

Add an `upstream` prop to `RunLog` (`{ printing_operator, die_operator }`) and render read-only chips directly under the waste-reason field, shown only when `+form.qty_scrap > 0`:

```jsx
{+form.qty_scrap > 0 && (
  <div className="col-span-2 flex flex-wrap gap-2 text-sm">
    <span className="rounded-full bg-slate-100 px-3 py-1">
      Printing operator: <strong>{upstream?.printing_operator || '—'}</strong>
    </span>
    <span className="rounded-full bg-slate-100 px-3 py-1">
      Dies operator: <strong>{upstream?.die_operator || '—'}</strong>
    </span>
  </div>
)}
```

These are display-only — no input, no state, nothing submitted. The server re-derives and snapshots them.

- [ ] **Step 2: Pass the prop from both pages**

`STAGE_VIEW` now returns `printing_operator` and `die_operator` on every queue row, so both pages already have the values on the selected job object. Pass `upstream={{ printing_operator: job.printing_operator, die_operator: job.die_operator }}`.

- [ ] **Step 3: Verify in the real app**

Open pasting on a job that has been printed and die-cut. Type `0` in Waste → no chips. Type any positive number → both chips appear with the real operator names, not editable.

- [ ] **Step 4: Verify in sorting too**

Repeat on the sorting waste panel in `SortPaste.jsx`. Same behaviour.

---

# Phase 4 — Warehouse manual add-stock

Independent of Phases 1-3; can be built at any point.

### Task 13: Manual FG lot endpoint

**Files:**
- Modify: `server/src/routes/fg.js`

- [ ] **Step 1: Add the route**

```js
// Manual FG entry. fg_lots.source='manual' and fg_movements.movement_type=
// 'manual_adjustment' already exist in the schema but no route ever wrote them.
// Lands as pending_verification so a second person must confirm — an unverified
// add button on FG is a phantom-stock generator.
r.post('/fg-lots/manual', canAdjust, async (req, res, next) => {
  try {
    const lot = await tx(async (qc, oc) => {
      const product_id = +req.body.product_id || 0;
      const qty = Math.max(0, Math.round(+req.body.qty || 0));
      if (!product_id) throw Object.assign(new Error('Product is required'), { status: 400 });
      if (qty <= 0) throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
      if (!(req.body.reason || '').trim())
        throw Object.assign(new Error('A reason is required for a manual stock entry'), { status: 400 });

      const seq = await oc(`SELECT COALESCE(MAX(SUBSTRING(lot_number FROM 7)::int),0)+1 AS n
                              FROM fg_lots WHERE lot_number LIKE 'CI-FG-%'`);
      const lot_number = `CI-FG-${String(seq.n).padStart(4, '0')}`;

      const row = await oc(
        `INSERT INTO fg_lots (lot_number, kind, product_id, qty, box_count, qty_per_box,
                              loose_qty, source, status, location, note, created_by)
         VALUES ($1,'fg_excess',$2,$3,$4,$5,$6,'manual','pending_verification',$7,$8,$9)
         RETURNING *`,
        [lot_number, product_id, qty,
         +req.body.box_count || 0, +req.body.qty_per_box || 0, +req.body.loose_qty || 0,
         req.body.location || 'FG-STORE',
         `${req.body.reason}${req.body.note ? ' — ' + req.body.note : ''}`,
         req.user?.name || null]);

      await oc(`INSERT INTO fg_stock (product_id, qty) VALUES ($1,$2)
                ON CONFLICT (product_id) DO UPDATE SET qty = fg_stock.qty + $2`, [product_id, qty]);

      await fgMove(qc, oc, {
        ref_number: lot_number, fg_lot_id: row.id, product_id,
        qty_in: qty, movement_type: 'manual_adjustment', source_module: 'warehouse',
        created_by: req.user?.name || null, remarks: req.body.reason,
      });
      return row;
    });
    res.json(lot);
  } catch (e) { next(e); }
});
```

Check `fgMove`'s actual signature in `helpers.js` before writing this and match it exactly — the argument shape above assumes `(qc, oc, fields)`.

- [ ] **Step 2: Verify**

POST a manual lot for a known `product_id`, qty 500.

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT lot_number, source, status, qty FROM fg_lots WHERE source='manual' ORDER BY id DESC LIMIT 1;" \
  -c "SELECT movement_type, source_module, qty_in FROM fg_movements ORDER BY id DESC LIMIT 1;" \
  -c "SELECT qty FROM fg_stock WHERE product_id=<PID>;"
```

Expected: lot `pending_verification` with `source='manual'`; one `manual_adjustment` / `warehouse` movement of +500; `fg_stock.qty` up by 500.

- [ ] **Step 3: Verify the guards** — POST with qty 0 → 400; with no reason → 400; as a user without `canAdjust` → 403.

- [ ] **Step 4: Verify it can be verified** — `POST /fg-lots/:id/verify` on the new lot moves it to `verified`.

- [ ] **Step 5: Clean up** — delete the test lot, its movement row, and decrement `fg_stock` by the same amount.

---

### Task 14: Manual leftover entry endpoint

**Files:**
- Modify: `server/src/routes/inventory.js`

- [ ] **Step 1: Add the route**

```js
// Manual RM board leftover. Reuses findOrCreateLeftoverMaster so a hand-entered
// offcut lands on the same master as an auto-banked one — one master per
// (source board, strip size), orientation-agnostic.
r.post('/inventory/leftovers/add', canAdjust, async (req, res, next) => {
  try {
    const out = await tx(async (qc, oc) => {
      const source_material_id = +req.body.source_material_id || 0;
      const qty = Math.max(0, Math.round(+req.body.qty || 0));
      const width = +req.body.width || 0, length = +req.body.length || 0;
      if (!source_material_id) throw Object.assign(new Error('Source board is required'), { status: 400 });
      if (qty <= 0) throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
      if (width <= 0 || length <= 0) throw Object.assign(new Error('Strip size is required'), { status: 400 });

      const master = await findOrCreateLeftoverMaster(qc, oc, { source_material_id, width, length });
      const seq = await oc(`SELECT COALESCE(MAX(SUBSTRING(batch_no FROM 11)::int),0)+1 AS n
                              FROM stock_batches WHERE batch_no LIKE 'LO-MANUAL-%'`);
      const batch_no = `LO-MANUAL-${String(seq.n).padStart(6, '0')}`;

      await oc(`INSERT INTO stock_batches (material_id, batch_no, qty) VALUES ($1,$2,$3)`,
        [master.id, batch_no, qty]);
      await oc(`INSERT INTO stock_movements (material_id, qty, type, ref_type, note, user_name)
                VALUES ($1,$2,'leftover_in','manual',$3,$4)`,
        [master.id, qty, req.body.note || 'Manual leftover entry', req.user?.name || null]);
      return { material_id: master.id, batch_no, qty };
    });
    res.json(out);
  } catch (e) { next(e); }
});
```

Import `findOrCreateLeftoverMaster` from `../helpers.js`, and confirm its real signature (`helpers.js:124`) before writing — match it exactly. Confirm the `stock_movements` column list against the table definition; adjust if `ref_type`/`note`/`user_name` differ.

- [ ] **Step 2: Verify**

POST an entry for a known board, 600×400, qty 200.

```bash
psql 'postgres://cierp:cierp@localhost:5439/cierp' -c \
  "SELECT m.id, m.name, m.leftover, m.source_material_id FROM materials m WHERE m.leftover=1 ORDER BY m.id DESC LIMIT 1;" \
  -c "SELECT batch_no, qty FROM stock_batches WHERE batch_no LIKE 'LO-MANUAL-%' ORDER BY id DESC LIMIT 1;"
```

Expected: a leftover master exists (new or reused) and one `LO-MANUAL-000001` batch of 200.

- [ ] **Step 3: Verify master reuse** — POST an identical entry again. Expected: **no** new master; a second batch on the same `material_id`.

- [ ] **Step 4: Clean up** — delete the `LO-MANUAL-*` batches, their movements, and any master created purely by this test.

---

### Task 15: Add-stock UI

**Files:**
- Modify: `client/src/pages/FinishedGoods.jsx`, `client/src/pages/Inventory.jsx`

- [ ] **Step 1: FG add-stock modal**

On the Lots tab, add an "+ Add Stock" `<Button>` in the tab header opening a `<Modal>` with: Product (searchable `<Select>` from the existing product list), Quantity, Boxes, Qty per box, Loose, Location (default `FG-STORE`), Reason (required), Note. Submit to `POST /fg-lots/manual`, then refresh the lots list.

Show an inline amber note in the modal: *"Manually added stock lands as pending verification and must be verified before it can be dispatched."*

- [ ] **Step 2: Leftover add-stock modal**

On Inventory → RM Stock → Leftover (`Inventory.jsx:162`), add "+ Add Stock" opening a `<Modal>` with: Source board (`<Select>` of non-leftover materials), Width (mm), Length (mm), Quantity, Note. Submit to `POST /inventory/leftovers/add`, then refresh.

- [ ] **Step 3: Gate both buttons on role**

Render each button only when the signed-in user passes the same role check the existing `POST /inventory/adjust` UI uses at `Inventory.jsx:137`.

- [ ] **Step 4: Verify in the real app**

Log in as a user with adjust rights. Add FG stock → the lot appears in the Lots tab as pending verification, and the Movements tab shows one `manual_adjustment` row. Add a leftover → the strip appears under the Leftover sub-tab with the correct size and qty.

- [ ] **Step 5: Verify the gate** — log in as a station operator without adjust rights. Expected: neither button renders.

- [ ] **Step 6: Clean up** — remove the test lot and leftover batch as in Tasks 13 and 14.

---

## Final verification

- [ ] `cd server && npm test` — full suite green, 16 tests in `stage-runs.test.js`.
- [ ] Drive one `UAT-E2E` order end to end: cutting → printing (2 runs) → coating → die cutting (2 runs) → sorting → pasting (3 runs, last one triggering the fulfilment dialog) → QC → FG.
- [ ] Confirm the Status Sheet, Pendency tab and Reports `fulfilment_pct` all read correctly for that order — they consume `job_stages.qty_out`, which must be unchanged in meaning.
- [ ] Confirm the timeline drawer shows the run history.
- [ ] Delete `UAT-E2E` by marker.

## Open risk to watch during execution

Task 5 Step 1 changes a guard every station relies on. If any station legitimately depends on `qty_in` as a hard cap independent of upstream output — the extra-sheets (CI-XS) flow is the likeliest candidate, since it deliberately injects sheets outside the normal chain — the running-balance ceiling will reject work that used to be valid. Test a CI-XS job explicitly before considering Phase 1 done.
