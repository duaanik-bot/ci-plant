# Cutting Variance & Warehouse True-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the cutting station record the true number of sheets cut (even when it exceeds the job card because a packet was intact), with an alarming-but-non-blocking popup + reason, a real-time warehouse true-up of the derived parent-sheet delta, and a reviewable variance register.

**Architecture:** The operator types child print-sheets at cutting-Complete (existing `qty_out`/`qty_scrap`). A pure function derives the parent-sheet count actually consumed and its delta vs the job card. When non-zero, a reason is required, the warehouse board is consumed/refunded by the delta (never blocking — stock may go negative), `sheets_issued`/`qty_in` are rewritten to the true figure, and a `cutting_discrepancies` row is written. The old hard cap is kept for every stage **except** cutting.

**Tech Stack:** Node.js (ESM) + Express + embedded Postgres (`:5439/cierp`); `node --test` unit tests; React (Vite) client with the shared `components/ui.jsx` kit.

> **PROJECT RULE — NO GIT COMMITS.** This repo's standing rule is that all work stays local and uncommitted. Every "Commit" step in the standard plan format is therefore replaced by a **Checkpoint** (verify + stop for review). Do **not** run `git commit`.

> **DEV GOTCHA — server may not hot-reload.** The running server instance can be a plain `node` process. After server-side edits, verify with a **temporary server on a spare port reusing live PG `:5439`** (see Task 9), not by assuming `--watch` picked it up. UI is verified in the real running app at desktop breakpoint, and any test data must be scoped to `UAT-*` markers — never an unscoped mutation on shared data.

---

## File Structure

**New files**
- `server/src/production-variance.js` — pure cutting-variance math (no DB). One responsibility: given the operator's numbers + job-card figures, return the derived parents/children and delta.
- `server/src/production-variance.test.js` — unit tests for the above (mirrors `production.finalise.test.js`).
- `client/src/pages/CuttingVariances.jsx` — read-only "Cutting Variances" register (KPIs + table + export), modelled on `ExtraSheets.jsx`.

**Modified files**
- `server/src/db.js` — `cutting_discrepancies` table DDL.
- `server/src/helpers.js` — `adjustBoardStock(...)` board consume/refund helper (allows negative stock, never throws).
- `server/src/routes/production.js` — cutting-Complete variance wire-up (remove cutting hard cap, derive, true-up, rewrite, record); relax + record on the cutting adjust path; new `GET /cutting-variances` register endpoint.
- `client/src/sections.js` — `CUTTING_VARIANCE_REASONS` preset list.
- `client/src/pages/Section.jsx` — cutting variance alarm panel + reason capture in the Complete modal; pass `variance_reason`/`variance_note`.
- `client/src/App.jsx` — `/cutting-variances` route.
- `client/src/modules.js` — nav entry for the register.

---

## Task 1: Pure cutting-variance calculation

**Files:**
- Create: `server/src/production-variance.js`
- Test: `server/src/production-variance.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/production-variance.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuttingVariance } from './production-variance.js';

test('over-cut: 1400 planned, cpp 2, 3000 children out → 1500 parents, +100', () => {
  const v = cuttingVariance({ qty_out: 3000, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
  assert.equal(v.isVariance, true);
});

test('on-plan: 2800 children out at cpp 2 → 1400 parents, no variance', () => {
  const v = cuttingVariance({ qty_out: 2800, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1400);
  assert.equal(v.parentDelta, 0);
  assert.equal(v.isVariance, false);
});

test('under-cut: 2600 children out at cpp 2 → 1300 parents, -100', () => {
  const v = cuttingVariance({ qty_out: 2600, qty_scrap: 0, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1300);
  assert.equal(v.parentDelta, -100);
  assert.equal(v.isVariance, true);
});

test('scrap counts toward parents consumed: 2950 good + 50 scrap at cpp 2 → 1500', () => {
  const v = cuttingVariance({ qty_out: 2950, qty_scrap: 50, children_per_parent: 2, sheets_issued: 1400 });
  assert.equal(v.actualChildren, 3000);
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
});

test('cpp defaults to 1: 1500 children out → 1500 parents, +100 over 1400', () => {
  const v = cuttingVariance({ qty_out: 1500, qty_scrap: 0, children_per_parent: 1, sheets_issued: 1400 });
  assert.equal(v.actualParents, 1500);
  assert.equal(v.parentDelta, 100);
});

test('null/undefined inputs do not throw and report no variance', () => {
  const v = cuttingVariance({ qty_out: 0, qty_scrap: 0, children_per_parent: undefined, sheets_issued: undefined });
  assert.equal(v.cpp, 1);
  assert.equal(v.plannedParents, 0);
  assert.equal(v.actualParents, 0);
  assert.equal(v.isVariance, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `server/`): `node --test src/production-variance.test.js`
Expected: FAIL — `Cannot find module './production-variance.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/production-variance.js`:

```js
// Pure cutting-variance math — no DB. Warehouse stock is held in parent
// (mother) sheets; cutting converts each parent into `children_per_parent`
// child print-sheets. The operator types the child sheets he produced; we
// derive how many parents were actually cut and how that differs from the
// job card, so the warehouse and the record can be trued-up.
//
// A cut parent yields `cpp` children whether or not all are kept, so the
// parents consumed are derived from (good + scrap) children.
export function cuttingVariance({ qty_out = 0, qty_scrap = 0, children_per_parent = 1, sheets_issued = 0 } = {}) {
  const cpp = Math.max(1, +children_per_parent || 1);
  const plannedParents = Math.max(0, Math.round(+sheets_issued || 0));
  const actualChildren = Math.max(0, (+qty_out || 0) + (+qty_scrap || 0));
  const plannedChildren = plannedParents * cpp;
  const actualParents = Math.round(actualChildren / cpp);
  const parentDelta = actualParents - plannedParents;
  return { cpp, plannedParents, actualParents, parentDelta, plannedChildren, actualChildren, isVariance: parentDelta !== 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `server/`): `node --test src/production-variance.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Checkpoint** — stop for review (no commit per project rule).

---

## Task 2: `cutting_discrepancies` table

**Files:**
- Modify: `server/src/db.js` (append near the other `CREATE TABLE IF NOT EXISTS` blocks, e.g. right after the `stock_movements`/`fg_stock` group around `server/src/db.js:250-268`)

- [ ] **Step 1: Add the DDL**

Add this block to `server/src/db.js` in the schema string (it is executed idempotently on boot):

```sql
CREATE TABLE IF NOT EXISTS cutting_discrepancies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
  job_stage_id INTEGER NOT NULL REFERENCES job_stages(id),
  cpp INTEGER NOT NULL,
  planned_parents INTEGER NOT NULL,
  actual_parents INTEGER NOT NULL,
  parent_delta INTEGER NOT NULL,
  planned_children INTEGER NOT NULL,
  actual_children INTEGER NOT NULL,
  board_material_id INTEGER REFERENCES materials(id),
  board_available_before DOUBLE PRECISION,
  reason_code TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Verify the schema applies**

Restart the dev server (or run the temp server from Task 9). Confirm no boot error and the table exists:

Run: `PGPASSWORD=... psql -h localhost -p 5439 -d cierp -c "\d cutting_discrepancies"`
(or via the app's DB console) — Expected: the table with the columns above.

If `psql` credentials aren't handy, instead confirm the server booted cleanly (Task 9's temp-server start prints no error) — the `CREATE TABLE IF NOT EXISTS` runs during boot.

- [ ] **Step 3: Checkpoint** — stop for review.

---

## Task 3: `adjustBoardStock` helper (consume/refund, never blocks)

**Files:**
- Modify: `server/src/helpers.js` (add after `consumeFifo`, around `server/src/helpers.js:183`)

- [ ] **Step 1: Add the helper**

Add to `server/src/helpers.js`:

```js
// Warehouse true-up for a cutting variance. `deltaParents` > 0 consumes extra
// board (packet was intact — cut the full bundle); < 0 refunds board (short
// packet). Cutting is NEVER blocked: if stock runs out, the shortfall lands on
// a negative "CUT-SHORT" batch that surfaces in the warehouse for reconcile.
// Uses only existing stock_movements types ('consumption' / 'adjustment').
export async function adjustBoardStock(materialId, deltaParents, refType, refId, note, qc, oc) {
  if (!materialId || !deltaParents) return;
  if (deltaParents > 0) {
    let remaining = deltaParents;
    const batches = await qc(
      `SELECT * FROM stock_batches WHERE material_id=$1 AND status='available' AND qty>0 ORDER BY created_at, id`,
      [materialId]);
    for (const b of batches) {
      if (remaining <= 0) break;
      const take = Math.min(b.qty, remaining);
      const newQty = b.qty - take;
      await qc(`UPDATE stock_batches SET qty=$1, status=$2 WHERE id=$3`,
        [newQty, newQty === 0 ? 'exhausted' : 'available', b.id]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
        [materialId, b.id, -take, refType, refId, note]);
      remaining -= take;
    }
    if (remaining > 0) {
      const [short] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,0,'sheets','available') RETURNING id`,
        [materialId, `CUT-SHORT-${refId}`, -remaining]);
      await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
                VALUES ($1,$2,'consumption',$3,$4,$5,$6)`,
        [materialId, short.id, -remaining, refType, refId, `${note} (unbacked over-issue)`]);
    }
  } else {
    const refund = -deltaParents;
    const newest = await qc(
      `SELECT id FROM stock_batches WHERE material_id=$1 AND status IN ('available','exhausted')
       ORDER BY created_at DESC, id DESC LIMIT 1`, [materialId]);
    let batchId;
    if (newest[0]) {
      batchId = newest[0].id;
      await qc(`UPDATE stock_batches SET qty=qty+$1, status='available' WHERE id=$2`, [refund, batchId]);
    } else {
      const [rb] = await qc(
        `INSERT INTO stock_batches (material_id, batch_no, qty, initial_qty, unit, status)
         VALUES ($1,$2,$3,$3,'sheets','available') RETURNING id`,
        [materialId, `CUT-RETURN-${refId}`, refund]);
      batchId = rb.id;
    }
    await qc(`INSERT INTO stock_movements (material_id, batch_id, type, qty, ref_type, ref_id, note)
              VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
      [materialId, batchId, refund, refType, refId, note]);
  }
}
```

Note: `qc` (from `tx`) returns an array of rows; `RETURNING id` is destructured as `const [row] = await qc(...)`, matching existing code (e.g. `server/src/routes/production.js:646`). `oc` is unused here but kept in the signature for call-site symmetry.

- [ ] **Step 2: Checkpoint** — no unit test (DB-bound); it is exercised end-to-end in Task 9. Stop for review.

---

## Task 4: Wire variance into the cutting-Complete handler

**Files:**
- Modify: `server/src/routes/production.js`
  - imports (`server/src/routes/production.js:9`)
  - cap check (`server/src/routes/production.js:570-579`)
  - insert true-up before leftover booking (`server/src/routes/production.js:620-626`)

- [ ] **Step 1: Import the new helpers**

At `server/src/routes/production.js:9`, add `adjustBoardStock` to the existing `helpers.js` import, and add a new import line for the pure function:

```js
import { audit, setLineStatus, consumeFifo, fgReceipt, createJobCardForLine, splitGangParentJob, findOrCreateLeftoverMaster, finaliseBlock, reopenBlock, printReverseBlockers, printQueueEditBlock, adjustBoardStock } from '../helpers.js';
import { cuttingVariance } from '../production-variance.js';
```

- [ ] **Step 2: Make the hard cap skip cutting**

Replace the cap guard at `server/src/routes/production.js:572-579`:

```js
      // Cutting converts parent sheets → child print sheets, so its output cap
      // is qty_in × children_per_parent (CI-Production exempts cutting too).
      let cap = stQtyIn;
      if (st.stage === 'cutting') {
        const jcRow0 = await oc('SELECT children_per_parent FROM job_cards WHERE id=$1', [st.job_card_id]);
        cap = stQtyIn * Math.max(1, jcRow0?.children_per_parent || 1);
      }
      const consumed = isQC ? (qty_accepted + qty_rejected + qty_rework) : (qty_out + qty_scrap);
      if (consumed > cap)
        throw Object.assign(new Error(`${isQC ? 'Accepted + rejected + rework' : 'Output + scrap'} (${consumed}) exceeds input (${cap})`), { status: 409 });
```

with (cutting no longer hard-blocks; it derives a variance and requires a reason instead):

```js
      // Cutting has NO hard cap — a sealed packet may be intact and the operator
      // is bound to cut the full bundle. He types child print-sheets; we derive
      // the parents actually cut and true-up the warehouse (Step 4 below). Every
      // other stage keeps the cap and routes overages through the extra-sheet flow.
      let cutVariance = null;
      if (st.stage === 'cutting') {
        const jcRow0 = await oc('SELECT children_per_parent, sheets_issued FROM job_cards WHERE id=$1', [st.job_card_id]);
        cutVariance = cuttingVariance({
          qty_out, qty_scrap,
          children_per_parent: jcRow0?.children_per_parent,
          sheets_issued: jcRow0?.sheets_issued,
        });
        if (cutVariance.isVariance && !(req.body.variance_reason || '').trim())
          throw Object.assign(new Error('A reason is required when cutting differs from the job card'), { status: 400 });
      } else {
        const cap = stQtyIn;
        const consumed = isQC ? (qty_accepted + qty_rejected + qty_rework) : (qty_out + qty_scrap);
        if (consumed > cap)
          throw Object.assign(new Error(`${isQC ? 'Accepted + rejected + rework' : 'Output + scrap'} (${consumed}) exceeds input (${cap})`), { status: 409 });
      }
```

- [ ] **Step 3: Add the warehouse true-up + record before leftover booking**

Insert this block **immediately before** the leftover-offcut comment at `server/src/routes/production.js:622` (i.e. after the `audit(... 'complete' ...)` call at line 618-620, before `// Bank the planned leftover offcut`). It rewrites `stQtyIn` so the existing leftover booking below uses the true parent count:

```js
      // ── Cutting variance: real-time warehouse true-up + register row ────────
      // Board was consumed at START for the planned sheets_issued. Here we
      // consume/refund the delta between planned and the parents actually cut,
      // rewrite sheets_issued / qty_in to the truth, and record the variance.
      if (cutVariance && cutVariance.isVariance) {
        const eff = await oc(`
          SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
          FROM job_cards jc
          JOIN order_lines ol ON ol.id = COALESCE(jc.order_line_id,
                (SELECT id FROM order_lines WHERE gang_run_id = jc.gang_run_id ORDER BY id LIMIT 1))
          JOIN products p ON p.id = ol.product_id
          WHERE jc.id=$1`, [st.job_card_id]);
        const avail = await oc(`
          SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches
          WHERE material_id=$1 AND status='available'`, [eff?.board_material_id]);
        const note = `Cutting ${cutVariance.parentDelta > 0 ? 'over' : 'under'}-cut on ${jcNumberFor(st)} — ${cutVariance.actualParents} vs ${cutVariance.plannedParents} parents (${req.body.variance_reason})`;
        await adjustBoardStock(eff?.board_material_id, cutVariance.parentDelta, 'job_stage', st.id, note, qc, oc);
        await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [cutVariance.actualParents, st.job_card_id]);
        await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [cutVariance.actualParents, st.id]);
        stQtyIn = cutVariance.actualParents; // leftover booking below books from the TRUE parents cut
        await qc(`INSERT INTO cutting_discrepancies
                  (job_card_id, job_stage_id, cpp, planned_parents, actual_parents, parent_delta,
                   planned_children, actual_children, board_material_id, board_available_before,
                   reason_code, note, created_by)
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [st.job_card_id, st.id, cutVariance.cpp, cutVariance.plannedParents, cutVariance.actualParents,
           cutVariance.parentDelta, cutVariance.plannedChildren, cutVariance.actualChildren,
           eff?.board_material_id, Number(avail?.q || 0),
           (req.body.variance_reason || '').trim(), (req.body.variance_note || '').trim() || null, req.user.name]);
        await audit('job_stage', st.id, 'cutting_variance',
          `${cutVariance.parentDelta > 0 ? '+' : ''}${cutVariance.parentDelta} parents vs card (${cutVariance.plannedParents}→${cutVariance.actualParents}) — ${req.body.variance_reason}`, qc, req.user.name);
        await audit('job_card', st.job_card_id, 'cutting_variance',
          `cutting ${cutVariance.parentDelta > 0 ? 'over' : 'under'} by ${Math.abs(cutVariance.parentDelta)} parents — ${req.body.variance_reason}`, qc, req.user.name);
        if (eff?.board_material_id)
          await audit('materials', eff.board_material_id, 'cutting_variance',
            `${cutVariance.parentDelta > 0 ? 'consumed' : 'refunded'} ${Math.abs(cutVariance.parentDelta)} parent sheets (cutting ${jcNumberFor(st)})`, qc, req.user.name);
      }
```

- [ ] **Step 4: Add the tiny `jcNumberFor` helper used in the note**

The `st` row in the complete handler does not carry `jc_number`. Add a one-liner fetch just above the variance block, and reference it (`jcNumberFor(st)` in the code above is illustrative — replace with the fetched value). Concretely, replace the two `jcNumberFor(st)` occurrences by first adding:

```js
        const jcNo = (await oc('SELECT jc_number FROM job_cards WHERE id=$1', [st.job_card_id]))?.jc_number || `JC#${st.job_card_id}`;
```

as the first line inside the `if (cutVariance && cutVariance.isVariance) {` block, and use `${jcNo}` in the `note` and in the `materials` audit instead of `jcNumberFor(st)`.

- [ ] **Step 5: Verify nothing else references the removed `cap`/`consumed` names**

Run: `grep -n "consumed\|\\bcap\\b" server/src/routes/production.js`
Expected: the only remaining references are inside the new `else` branch (non-cutting) and the separate `stageImpact` function (Task 5) — none dangling in the cutting path.

- [ ] **Step 6: Checkpoint** — full behaviour verified in Task 9. Stop for review.

---

## Task 5: Relax + record on the cutting **adjust** path

**Files:**
- Modify: `server/src/routes/production.js`
  - `stageImpact` cap (`server/src/routes/production.js:721-723`)
  - adjust apply handler (`server/src/routes/production.js:748-778`)

- [ ] **Step 1: Let the impact preview not block cutting**

Replace `server/src/routes/production.js:721-723`:

```js
  let cap = st.qty_in;
  if (st.stage === 'cutting') cap = st.qty_in * Math.max(1, st.children_per_parent || 1);
  if (newOut + newScrap > cap) { out.blocked = `Output + wastage (${newOut + newScrap}) exceeds received (${cap})`; return out; }
```

with (cutting is never blocked here — the adjust records a variance instead):

```js
  if (st.stage !== 'cutting') {
    const cap = st.qty_in;
    if (newOut + newScrap > cap) { out.blocked = `Output + wastage (${newOut + newScrap}) exceeds received (${cap})`; return out; }
  }
```

- [ ] **Step 2: True-up + record when a completed cutting stage is adjusted**

In the adjust handler, inside the `tx(...)` at `server/src/routes/production.js:754`, after the `UPDATE job_stages SET qty_out=$1, qty_scrap=$2` at line 759 and before the wastage-delta block at line 761, insert:

```js
      // Cutting adjust re-derives the parents actually cut and trues-up the
      // board by the delta vs what the stage currently reflects (st.qty_in was
      // set to the last actual parents at completion / prior adjust).
      if (st.stage === 'cutting') {
        const jcv = await oc('SELECT children_per_parent, sheets_issued FROM job_cards WHERE id=$1', [st.job_card_id]);
        const v = cuttingVariance({ qty_out: newOut, qty_scrap: newScrap, children_per_parent: jcv.children_per_parent, sheets_issued: jcv.sheets_issued });
        const boardDelta = v.actualParents - (st.qty_in || 0);
        if (boardDelta !== 0) {
          const eff = await oc(`
            SELECT COALESCE((ol.spec_override->>'board_material_id')::int, p.board_material_id) AS board_material_id
            FROM job_cards jc
            JOIN order_lines ol ON ol.id = COALESCE(jc.order_line_id,
                  (SELECT id FROM order_lines WHERE gang_run_id = jc.gang_run_id ORDER BY id LIMIT 1))
            JOIN products p ON p.id = ol.product_id WHERE jc.id=$1`, [st.job_card_id]);
          const avail = await oc(`SELECT COALESCE(SUM(qty),0) AS q FROM stock_batches WHERE material_id=$1 AND status='available'`, [eff?.board_material_id]);
          await adjustBoardStock(eff?.board_material_id, boardDelta, 'job_stage', st.id, `Cutting adjust on ${st.jc_number} — ${reason}`, qc, oc);
          await qc('UPDATE job_stages SET qty_in=$1 WHERE id=$2', [v.actualParents, st.id]);
          await qc('UPDATE job_cards SET sheets_issued=$1 WHERE id=$2', [v.actualParents, st.job_card_id]);
          await qc(`INSERT INTO cutting_discrepancies
                    (job_card_id, job_stage_id, cpp, planned_parents, actual_parents, parent_delta,
                     planned_children, actual_children, board_material_id, board_available_before,
                     reason_code, note, created_by)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [st.job_card_id, st.id, v.cpp, v.plannedParents, v.actualParents, v.parentDelta,
             v.plannedChildren, v.actualChildren, eff?.board_material_id, Number(avail?.q || 0),
             'Adjust', reason, req.user.name]);
        }
      }
```

Note: `stageImpact` already selects `jc.children_per_parent` and `jc.jc_number` into `st` (`server/src/routes/production.js:695`), so `st.qty_in`, `st.children_per_parent`, `st.jc_number`, `st.job_card_id`, `st.product_id` are all available here.

- [ ] **Step 3: Verify**

Run: `grep -n "cuttingVariance\|adjustBoardStock" server/src/routes/production.js`
Expected: both used in the complete handler (Task 4) and in this adjust handler.

- [ ] **Step 4: Checkpoint** — stop for review.

---

## Task 6: `GET /cutting-variances` register endpoint

**Files:**
- Modify: `server/src/routes/production.js` (add a route near the other `r.get(...)`; the `r`, `one`/`q`, and `canRun` are already in scope)

- [ ] **Step 1: Add the endpoint**

Add to `server/src/routes/production.js` (place it beside the other job-stage GETs, e.g. after the `/job-stages/:id/impact` route at `server/src/routes/production.js:746`):

```js
// Cutting Variances register — every recorded over/under-cut, newest first,
// enriched for the warehouse review page and export.
r.get('/cutting-variances', canRun, async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT cd.*, jc.jc_number, p.name AS product_name, p.code AS product_code,
             m.name AS board_name,
             o.po_number, c.name AS customer_name
      FROM cutting_discrepancies cd
      JOIN job_cards jc ON jc.id = cd.job_card_id
      JOIN products p ON p.id = jc.product_id
      LEFT JOIN materials m ON m.id = cd.board_material_id
      LEFT JOIN order_lines ol ON ol.id = jc.order_line_id
      LEFT JOIN orders o ON o.id = ol.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      ORDER BY cd.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});
```

Confirm `q` is imported at the top of the file (it is used elsewhere via `one`; if only `one` is imported, add `q` to the `../db.js` import). Check with: `grep -n "from '../db.js'" server/src/routes/production.js`.

- [ ] **Step 2: Verify the route responds**

After starting the temp server (Task 9): `curl -s -H "Authorization: Bearer <token>" localhost:<port>/api/cutting-variances`
Expected: `[]` initially, then rows after a variance is recorded.

- [ ] **Step 3: Checkpoint** — stop for review.

---

## Task 7: Reason presets + station Complete popup

**Files:**
- Modify: `client/src/sections.js` (after `HOLD_REASONS`, `client/src/sections.js:32-34`)
- Modify: `client/src/pages/Section.jsx` (import; `complete()` at `client/src/pages/Section.jsx:263`; Complete-modal cutting UI at `client/src/pages/Section.jsx:831-867`; Complete button `disabled` at `client/src/pages/Section.jsx:772-773`)

- [ ] **Step 1: Add the reason presets**

Add to `client/src/sections.js` after line 34:

```js
export const CUTTING_VARIANCE_REASONS = [
  'Packet intact – full bundle cut', 'Board damaged', 'Extra for wastage buffer',
  'Short board / packet short', 'Miscount / recount', 'Other',
];
```

- [ ] **Step 2: Import presets + add variance state in Section.jsx**

At the top of `client/src/pages/Section.jsx`, add `CUTTING_VARIANCE_REASONS` to the existing `../sections.js` import. Then, next to the other Complete-form state (near `const [form, setForm] = useState({ qty_out: '', qty_scrap: '0', scrap_reason: '' });` at `client/src/pages/Section.jsx:183`), add:

```js
  const [variance, setVariance] = useState({ reason: '', note: '' });
```

Reset it whenever the Complete modal opens for a cutting row — in the row action that sets `completing` and `form` (around `client/src/pages/Section.jsx:538`), add `setVariance({ reason: '', note: '' });` alongside the existing `setForm({...})`.

- [ ] **Step 3: Derive the live variance in the modal and show the alarm**

Inside the `completing && !isQC` block, immediately after the summary panel (after `client/src/pages/Section.jsx:845`, before `<section className="ci-form-panel">` at line 846), add a cutting-only derived alarm. Uses the same math as the server (children ÷ cpp), inline:

```jsx
            {section === 'cutting' && completing.children_per_parent >= 1 && (() => {
              const cpp = Math.max(1, completing.children_per_parent || 1);
              const plannedParents = Math.round(completing.sheets_issued || completing.qty_in || 0);
              const actualParents = Math.round(((+form.qty_out || 0) + (+form.qty_scrap || 0)) / cpp);
              const delta = actualParents - plannedParents;
              if (form.qty_out === '' || delta === 0) return null;
              const over = delta > 0;
              return (
                <section className="ci-form-panel" style={{ borderColor: '#f59e0b' }}>
                  <div className="ci-form-panel-title">
                    <span className="text-amber-700">⚠ Cutting {over ? 'more' : 'fewer'} than the job card</span>
                    <span>Reason required</span>
                  </div>
                  <p className="px-1 pb-2 text-xs text-slate-600">
                    Job card: <b>{fmt.num(plannedParents)}</b> parents · You're cutting{' '}
                    <b>{fmt.num(actualParents)}</b> ({over ? '+' : ''}{fmt.num(delta)}).{' '}
                    {over
                      ? <>Warehouse will consume <b>{fmt.num(delta)}</b> more parent sheets.</>
                      : <>Warehouse will refund <b>{fmt.num(-delta)}</b> parent sheets.</>}
                  </p>
                  <div className="ci-form-grid">
                    <Field label="Reason" required>
                      <Select value={variance.reason} onChange={e => setVariance({ ...variance, reason: e.target.value })}>
                        <option value="">Select reason…</option>
                        {CUTTING_VARIANCE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </Select>
                    </Field>
                    <Field label="Note" hint="Optional">
                      <Input value={variance.note} onChange={e => setVariance({ ...variance, note: e.target.value })} placeholder="e.g. sealed 500-pack, cut all" />
                    </Field>
                  </div>
                </section>
              );
            })()}
```

- [ ] **Step 4: Send the variance fields from `complete()`**

In `complete()` at `client/src/pages/Section.jsx:263-267`, extend the non-QC POST body to include the variance fields (harmless for non-cutting stages — the server only reads them for cutting):

```js
      await api.post(`/job-stages/${completing.id}/complete`, {
        qty_out: +form.qty_out, qty_scrap: +form.qty_scrap,
        scrap_reason: +form.qty_scrap > 0 ? form.scrap_reason || undefined : undefined,
        variance_reason: variance.reason || undefined,
        variance_note: variance.note || undefined,
        packing_lines: packLines?.length ? packLines : undefined,
      });
```

- [ ] **Step 5: Gate the Complete button on the reason (never blocks the quantity)**

Replace the non-QC Complete button `disabled` at `client/src/pages/Section.jsx:772-773`:

```jsx
            <Button variant="success" onClick={complete}
              disabled={form.qty_out === '' || (+form.qty_scrap > 0 && !form.scrap_reason)}>Complete Stage</Button>
```

with a version that also requires a variance reason when cutting differs from the card:

```jsx
            <Button variant="success" onClick={complete}
              disabled={
                form.qty_out === '' ||
                (+form.qty_scrap > 0 && !form.scrap_reason) ||
                (section === 'cutting' &&
                  Math.round(((+form.qty_out || 0) + (+form.qty_scrap || 0)) / Math.max(1, completing?.children_per_parent || 1))
                    !== Math.round(completing?.sheets_issued || completing?.qty_in || 0) &&
                  !variance.reason)
              }>Complete Stage</Button>
```

- [ ] **Step 6: Confirm `sheets_issued` is present on the station row**

The alarm and gate read `completing.sheets_issued`. The cutting row already renders `r.sheets_issued` (`client/src/pages/Section.jsx:85`), so it is present on the row objects. Verify with: `grep -n "sheets_issued" client/src/pages/Section.jsx` — expected: existing references at ~line 85, plus the new ones. If the row lacked it, the code falls back to `qty_in`.

- [ ] **Step 7: Checkpoint** — visual verification in Task 9. Stop for review.

---

## Task 8: Cutting Variances register page + nav

**Files:**
- Create: `client/src/pages/CuttingVariances.jsx`
- Modify: `client/src/App.jsx` (import + route)
- Modify: `client/src/modules.js` (nav entry)

- [ ] **Step 1: Create the page**

Create `client/src/pages/CuttingVariances.jsx`:

```jsx
// Cutting Variances — the warehouse-facing register of every over/under-cut
// recorded at the cutting station. Read-only: the record is captured inline at
// the station; this is where it is reviewed, filtered and exported.
import { useEffect, useMemo, useState } from 'react';
import { api, fmt } from '../api.js';
import { DataTable, KpiCard, PageHeader, rowMatches, SearchInput } from '../components/ui.jsx';
import { Scissors, AlertTriangle } from 'lucide-react';

export default function CuttingVariances() {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    const load = () => api.get('/cutting-variances').then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const kpis = useMemo(() => ({
    count: rows.length,
    over: rows.filter(r => r.parent_delta > 0).length,
    under: rows.filter(r => r.parent_delta < 0).length,
    net: rows.reduce((s, r) => s + (r.parent_delta || 0), 0),
  }), [rows]);

  const filtered = useMemo(() => (q ? rows.filter(r => rowMatches(r, q)) : rows), [rows, q]);

  return (
    <div>
      <PageHeader title="Cutting Variances"
        subtitle="Every time cutting recorded more or fewer sheets than the job card — with reason and warehouse impact" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard icon={<Scissors size={16} />} label="Variances" value={fmt.num(kpis.count)} />
        <KpiCard icon={<AlertTriangle size={16} />} label="Over-cut" value={fmt.num(kpis.over)} />
        <KpiCard icon={<AlertTriangle size={16} />} label="Under-cut" value={fmt.num(kpis.under)} />
        <KpiCard label="Net parent sheets" value={`${kpis.net > 0 ? '+' : ''}${fmt.num(kpis.net)}`} />
      </div>
      <div className="my-3 flex justify-end">
        <SearchInput value={q} onChange={setQ} placeholder="Search JC, product, reason…" />
      </div>
      <DataTable
        exportName="cutting-variances"
        rows={filtered}
        columns={[
          { key: 'created_at', label: 'When', export: r => fmt.date(r.created_at), render: r => fmt.date(r.created_at) },
          { key: 'jc_number', label: 'Job Card' },
          { key: 'product_name', label: 'Product', render: r => <span>{r.product_name} <span className="text-slate-400">{r.product_code}</span></span> },
          { key: 'planned_parents', label: 'Card parents', align: 'right', export: r => fmt.num(r.planned_parents), render: r => fmt.num(r.planned_parents) },
          { key: 'actual_parents', label: 'Cut parents', align: 'right', export: r => fmt.num(r.actual_parents), render: r => fmt.num(r.actual_parents) },
          { key: 'parent_delta', label: 'Δ', align: 'right',
            export: r => `${r.parent_delta > 0 ? '+' : ''}${r.parent_delta}`,
            render: r => <span className={r.parent_delta > 0 ? 'font-semibold text-red-600' : 'font-semibold text-emerald-600'}>{r.parent_delta > 0 ? '+' : ''}{fmt.num(r.parent_delta)}</span> },
          { key: 'board_name', label: 'Board' },
          { key: 'reason_code', label: 'Reason' },
          { key: 'note', label: 'Note', render: r => r.note || '—' },
          { key: 'created_by', label: 'By' },
        ]}
      />
    </div>
  );
}
```

Note: `DataTable`, `KpiCard`, `PageHeader`, `SearchInput`, `rowMatches` are all exported from `components/ui.jsx` (see `client/src/pages/ExtraSheets.jsx:8`). Confirm `fmt.date` exists — check with `grep -n "date" client/src/api.js`; if the helper has a different name (e.g. `fmt.datetime`), use that instead.

- [ ] **Step 2: Add the route**

In `client/src/App.jsx`, add the import next to the other page imports (after `client/src/App.jsx:28`):

```jsx
import CuttingVariances from './pages/CuttingVariances.jsx';
```

and the route next to `/extra-sheets` (after `client/src/App.jsx:68`):

```jsx
                <Route path="/cutting-variances" element={<CuttingVariances />} />
```

- [ ] **Step 3: Add the nav entry**

In `client/src/modules.js`, add after the `extra_sheets` entry (`client/src/modules.js:17`):

```js
  { key: 'cutting_variances', label: 'Cutting Variances', path: '/cutting-variances' },
```

- [ ] **Step 4: Verify the page loads**

In the running client, sign in as admin and open `/cutting-variances`. Expected: the page renders with empty KPIs and table (no console errors). Full data check happens in Task 9.

- [ ] **Step 5: Checkpoint** — stop for review.

---

## Task 9: End-to-end verification (temp server + real app, UAT-scoped)

**Files:** none (verification only)

- [ ] **Step 1: Run the unit tests**

Run (from `server/`): `node --test src/*.test.js`
Expected: all tests pass, including the 6 new `production-variance` tests.

- [ ] **Step 2: Start a temp server on a spare port reusing live PG :5439**

The running instance may not hot-reload server code. Start a throwaway instance on a spare port against the same DB (do not disturb the live one):

Run (from `server/`): `PORT=4999 node src/index.js`
Expected: boots cleanly (schema applied, `cutting_discrepancies` created), no errors. Leave it running in a second shell for the API checks below. Stop it when done.

- [ ] **Step 3: Prove the over-cut path on a UAT job (scoped — never touch real orders)**

Seed or pick a **UAT-*** cutting stage that is `in_progress`. Record: board on-hand for its material, `sheets_issued`, `children_per_parent`. Then POST a complete with child sheets that imply more parents:

```bash
# token = login as admin@ci.local / admin123 first
curl -s -X POST localhost:4999/api/job-stages/<UAT_cutting_stage_id>/complete \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"qty_out": 3000, "qty_scrap": 0, "variance_reason": "Packet intact – full bundle cut", "variance_note": "UAT sealed pack"}'
```

Expected:
- 200 (no 409 block).
- `GET /api/cutting-variances` shows a row: planned 1400, actual 1500, delta +100, reason set.
- Board stock for that material dropped by the extra 100 parents (`stock_movements` has a `consumption` of −100 tagged to the job_stage); if stock was insufficient, a `CUT-SHORT-<stageId>` negative batch exists.
- The job card's `sheets_issued` now reads 1500.

- [ ] **Step 4: Prove the missing-reason guard and the under-cut refund**

Missing reason blocks the *record* (not the cut count):

```bash
curl -s -X POST localhost:4999/api/job-stages/<UAT_stage_id2>/complete \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"qty_out": 3000, "qty_scrap": 0}'
```
Expected: 400 "A reason is required when cutting differs from the job card".

Under-cut refunds:
```bash
curl -s -X POST localhost:4999/api/job-stages/<UAT_stage_id3>/complete \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"qty_out": 2600, "qty_scrap": 0, "variance_reason": "Short board / packet short"}'
```
Expected: 200; a `stock_movements` `adjustment` of +100 for the board; variance row with delta −100.

- [ ] **Step 5: Prove the on-plan path is unchanged (no popup, no record)**

Complete a UAT cutting stage with exactly the planned children (e.g. `qty_out` = `sheets_issued × cpp`). Expected: 200, **no** new `cutting_discrepancies` row, no board delta beyond the normal flow.

- [ ] **Step 6: Verify the UI in the real running app (desktop breakpoint)**

Sign in to the real app, open **Live Floor → Cutting**, complete a UAT cutting job entering an over-cut counter. Expected: the amber "⚠ Cutting more than the job card" panel appears with the derived parent numbers, the reason dropdown gates the **Complete Stage** button, and on submit the toast shows completion. Open **Cutting Variances** (nav) and confirm the row, then open **Warehouse** and confirm the stock moved. Confirm the variance also appears in the job card's **universal timeline** drawer.

- [ ] **Step 7: Stop the temp server** and **Checkpoint** — stop for final review.

---

## Self-Review notes (author)

- **Spec coverage:** no hard blocker (Task 4 removes cutting's 409; missing-reason 400 gates only the *record*) ✓; alarming popup + reason (Task 7) ✓; real-time warehouse true-up incl. negative stock (Task 3 + Task 4 Step 3) ✓; issue true count to next station (existing completion propagates `qty_out`; `qty_in`/`sheets_issued` rewritten to actual) ✓; symmetric under-cut refund (Task 3 else-branch + verified Task 9 Step 4) ✓; preset reasons + note (Task 7 Step 1) ✓; reviewable register (Task 2 + 6 + 8) ✓; timeline visibility (audit on `job_stage`/`job_card`/`materials`, already in-scope in `routes/timeline.js`) ✓; adjust path relaxed + records (Task 5) ✓; leftover-offcut booking now reads true parents (Task 4 Step 3 rewrites `stQtyIn` before the existing booking) ✓.
- **Type/name consistency:** `cuttingVariance` fields (`cpp, plannedParents, actualParents, parentDelta, plannedChildren, actualChildren, isVariance`) are produced in Task 1 and consumed identically in Tasks 4 & 5. `adjustBoardStock(materialId, deltaParents, refType, refId, note, qc, oc)` signature matches all call sites. Client variance state `{ reason, note }` maps to server `variance_reason` / `variance_note`.
- **Open verification-time confirmations (flagged inline, not blockers):** `q` import presence in `production.js` (Task 6 Step 1), `fmt.date` name in `api.js` (Task 8 Step 1). Both have explicit grep checks.
